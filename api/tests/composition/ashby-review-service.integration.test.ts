import {
  appendTranscriptSegment,
  claimAshbyAction,
  closeDbPool,
  connectAshbyMember,
  createMeeting,
  db,
  disconnectAshbyMember,
  finishAshbyAction,
  getAshbyReviewById,
  getTranscriptForMeeting,
  saveWorkspaceAshbyIntegration,
  updateUserPlan,
  upsertUser,
} from "@readymeet/db";
import { type AiWorkflowJobView, aiWorkflowJobViewSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { z } from "zod";

import {
  actOnAshbyReview,
  getPrivateAshbyReview,
  processAshbyReviewJob,
} from "../../adapters/secondary/ashby/ashby-review-service";
import { encryptJsonSecret } from "../../adapters/secondary/node/secret-crypto";
import { apiEnv } from "../../composition/env";

const EXPECTED_VALUE_MESSAGE = "Expected a value";
const EXPECTED_APPLICATION_ID_MESSAGE = "Expected an application id";
const RESPONSE_LOST_AFTER_COMMIT_MESSAGE = "Response lost after commit";
const UNEXPECTED_MOCK_ENDPOINT_MESSAGE = "Unexpected mock endpoint";
const DRAFT_DURABLE_WHILE_DISCONNECTED_MESSAGE = "draft remains durable while connection is disabled";
const HTTP_SERVICE_UNAVAILABLE = 503;
const PRIYA_SHAH_NAME = "Personqj Personqm";
const STAGE_PRIOR_VALUES = ["none", "completed", "unknown", "completed_same"] as const;
const MOCK_INPUT_TOKENS = 1000;
const MOCK_OUTPUT_TOKENS = 20;
const OPENAI_REQUEST_MIN_INPUT_MESSAGES = 2;
const AI_WORKFLOW_JOB_MAX_ATTEMPTS = 10;
const CACHED_SCREENING_DOES_NOT_REPEAT_MESSAGE = "cached screening does not repeat";
const ONSITE_STAGE_NAME = "Onsite";
const UNEXPECTED_MOCK_ENDPOINT_SEPARATOR = " ";

const ashbyRpcRequestBodySchema = z
  .object({
    name: z.string().optional(),
    candidateId: z.string().optional(),
    applicationId: z.string().optional(),
    interviewStageId: z.string().optional(),
  })
  .passthrough();

const openAiInputContentSchema = z.union([z.string(), z.array(z.object({ text: z.string() }))]);

function openAiInputText(content: z.infer<typeof openAiInputContentSchema> | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined) {
    return "";
  }

  return content.map((part) => part.text).join("");
}

const openAiRequestBodySchema = z.object({
  input: z.array(z.object({ content: openAiInputContentSchema })).min(OPENAI_REQUEST_MIN_INPUT_MESSAGES),
});

const ashbyReviseExtractionInputSchema = z.object({
  // The revision instruction text, or null on the first extraction.
  correction: z.string().nullable().optional(),
  availableTargets: z.array(z.object({ stageNames: z.array(z.string()) })).optional(),
});

function readRequestInitBody(init: RequestInit): string {
  if (typeof init.body === "string") {
    return init.body;
  }
  if (init.body === undefined || init.body === null) {
    return "";
  }

  return JSON.stringify(init.body);
}

function parseAshbyRpcRequestBody(init: RequestInit) {
  return ashbyRpcRequestBodySchema.parse(JSON.parse(readRequestInitBody(init)));
}

function parseOpenAiRequestBody(init: RequestInit) {
  const body = z.object({ prompt: z.unknown() }).parse(JSON.parse(readRequestInitBody(init)));

  return openAiRequestBodySchema.parse({ input: body.prompt });
}

function parseAshbyReviseExtractionInput(content: string) {
  return ashbyReviseExtractionInputSchema.parse(JSON.parse(content));
}

function gatewayResponse(input: { output_text: string }): Response {
  return Response.json({
    content: [{ type: "text", text: input.output_text }],
    usage: { inputTokens: { total: MOCK_INPUT_TOKENS }, outputTokens: { total: MOCK_OUTPUT_TOKENS } },
    finishReason: { unified: "stop", raw: "stop" },
    warnings: [],
  });
}

function readMockEndpoint(url: unknown): string {
  const segment = String(url).split("/").at(-1);
  if (segment === undefined) {
    throw new Error(UNEXPECTED_MOCK_ENDPOINT_MESSAGE);
  }

  return segment;
}

function unexpectedMockEndpointFailure(endpoint: string): Error {
  return new Error(UNEXPECTED_MOCK_ENDPOINT_MESSAGE + UNEXPECTED_MOCK_ENDPOINT_SEPARATOR + endpoint);
}

function requiredValue<T>(input: { value: T | null | undefined }) {
  if (input.value === null || input.value === undefined) {
    throw new Error(EXPECTED_VALUE_MESSAGE);
  }

  return input.value;
}

after(closeDbPool);
async function fixture() {
  apiEnv.ASHBY_POST_MEETING_REVIEW_ENABLED = true;
  apiEnv.OPENAI_API_KEY = "mock-only";
  apiEnv.AI_GATEWAY_API_KEY = "mock-only";
  apiEnv.TYPESAFE_API_KEY = "mock-only";
  const user = await upsertUser({
    email: `${randomUUID()}@ashby-flow.test`,
    displayName: "Reviewer",
  });
  await updateUserPlan({ userId: user.id, plan: "business", privateBetaProEnabled: true });
  const meeting = await createMeeting({
    title: "Recruiting",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  await appendTranscriptSegment({
    meetingId: meeting.id,
    speakerIdentity: user.id,
    speakerName: "Personqc",
    speakerRole: "human",
    content: "Personqj Personqm can start in June. Move Personqj to the technical interview.",
    startedAt: new Date(),
  });
  await db.meetings.updateMany({ where: { id: meeting.id }, data: { status: "ended" } });
  await saveWorkspaceAshbyIntegration({
    workspaceId: user.workspaceId,
    configuredByUserId: user.id,
    secretRef: encryptJsonSecret({ apiKey: "mock" }),
  });
  await connectAshbyMember({ workspaceId: user.workspaceId, userId: user.id });
  const transcript = requiredValue({ value: await getTranscriptForMeeting(meeting.id) });
  const segment = requiredValue({ value: transcript.segments[0] });

  return { user, meeting, segment };
}
function job(input: { meetingId: string; payload: Record<string, unknown> }): AiWorkflowJobView {
  const now = new Date().toISOString();

  return aiWorkflowJobViewSchema.parse({
    id: randomUUID(),
    meetingId: input.meetingId,
    extractionId: null,
    type: "review_ashby_actions",
    scopeKey: "default",
    status: "queued",
    phase: "queued",
    payload: input.payload,
    result: {},
    error: null,
    attemptCount: 0,
    maxAttempts: AI_WORKFLOW_JOB_MAX_ATTEMPTS,
    runAfter: now,
    lockedBy: null,
    lockedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

type E2eFlowState = { writes: number; modelCalls: number; stageId: string };
type TranscriptSegmentRef = { id: string; content: string };

function createEndToEndAshbyFetchHandler(input: { flow: E2eFlowState; segment: TranscriptSegmentRef }) {
  const { flow, segment } = input;

  return async (request: { url: unknown; init: RequestInit }) => {
    const { url, init } = request;
    const body = parseAshbyRpcRequestBody(init);
    if (String(url).includes("typesafe")) {
      return Response.json({
        usage: { input_tokens: MOCK_INPUT_TOKENS, output_tokens: MOCK_OUTPUT_TOKENS },
        answers: {
          stage: { type: "choice", choice: "yes", probabilities: { yes: 1, no: 0, uncertain: 0 } },
        },
      });
    }
    if (String(url).includes("ai-gateway.vercel.sh")) {
      flow.modelCalls += 1;

      return gatewayResponse({
        output_text: JSON.stringify({
          proposals: [
            {
              kind: "stage",
              candidateName: flow.modelCalls === 1 ? PRIYA_SHAH_NAME : "Personqp Personqq",
              candidateEmail: null,
              jobTitle: null,

              stageName: "Technical Interview",
              evidence: [{ segmentId: segment.id, quote: segment.content }],
            },
          ],
          clarification: null,
        }),
      });
    }
    const endpoint = readMockEndpoint(url);
    if (endpoint === "candidate.search") {
      const candidateName = body.name ?? "";

      return Response.json({
        /** @external Ashby API success flag */
        success: true,
        results: [
          {
            id: candidateName === PRIYA_SHAH_NAME ? "personqj" : "personqp",
            name: candidateName,
            applicationIds: [candidateName === PRIYA_SHAH_NAME ? "personqj-app" : "personqp-app"],
          },
        ],
      });
    }
    if (endpoint === "candidate.info") {
      const candidateId = requiredValue({ value: body.candidateId });

      return Response.json({
        /** @external Ashby API success flag */
        success: true,
        results: {
          id: candidateId,
          name: "Personqp Personqq",
          applicationIds: [`${candidateId}-app`],
        },
      });
    }
    if (endpoint === "application.info") {
      const applicationId = requiredValue({ value: body.applicationId });
      const candidateIdFromApplication = applicationId.split("-")[0] ?? "";

      return Response.json({
        /** @external Ashby API success flag */
        success: true,
        results: {
          id: applicationId,
          candidate: { id: candidateIdFromApplication },
          status: "Active",
          job: { title: "Designer" },
          currentInterviewStage: { id: flow.stageId, title: "Screen", interviewPlanId: "plan" },
        },
      });
    }
    if (endpoint === "interviewStage.list") {
      return Response.json({
        /** @external Ashby API success flag */
        success: true,
        results: [
          {
            id: "technical",
            title: "Technical Interview",
            type: "Active",
            interviewPlanId: "plan",
          },
        ],
      });
    }
    if (endpoint === "application.changeStage") {
      flow.writes += 1;
      const applicationId = requiredValue({ value: body.applicationId });
      const interviewStageId = requiredValue({ value: body.interviewStageId });
      assert.equal(applicationId, "personqp-app");
      flow.stageId = interviewStageId;
      throw new Error(RESPONSE_LOST_AFTER_COMMIT_MESSAGE);
    }
    throw unexpectedMockEndpointFailure(endpoint);
  };
}

void test("end-to-end private review, user correction, confirmation, lost response reconciliation and stale revision", async (t) => {
  const { user, meeting, segment } = await fixture();
  const flow = { writes: 0, modelCalls: 0, stageId: "screen" };
  const ashbyFetch = createEndToEndAshbyFetchHandler({ flow, segment });
  t.mock.method(globalThis, "fetch", (url: unknown, init: RequestInit) => ashbyFetch({ url, init }));
  await processAshbyReviewJob(job({ meetingId: meeting.id, payload: {} }));
  const loaded = { review: requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) }) };
  assert.equal(loaded.review.status, "awaiting_user");
  assert.equal(flow.writes, 0);
  const unrelated = await upsertUser({
    email: `${randomUUID()}@ashby-flow.test`,
    displayName: "Other",
  });
  assert.equal(await getPrivateAshbyReview(meeting.id, unrelated.id), null);
  await actOnAshbyReview(meeting.id, user.id, {
    action: "revise",
    revision: loaded.review.revision,
    instruction: "This is for Personqp Personqq, not Personqj.",
  });
  loaded.review = requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) });
  await processAshbyReviewJob(
    job({ meetingId: meeting.id, payload: { runId: loaded.review.id, revision: loaded.review.revision } }),
  );
  loaded.review = requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) });
  assert.equal(requiredValue({ value: loaded.review.items[0] }).candidateId, "personqp");
  assert.equal(flow.writes, 0);
  assert.equal(requiredValue({ value: loaded.review.items[0] }).userEdited, true);
  await assert.rejects(
    actOnAshbyReview(meeting.id, user.id, {
      action: "confirm",
      revision: 0,
      itemIds: [requiredValue({ value: loaded.review.items[0] }).id],
    }),
    /changed/,
  );
  loaded.review = await actOnAshbyReview(meeting.id, user.id, {
    action: "confirm",
    revision: loaded.review.revision,
    itemIds: [requiredValue({ value: loaded.review.items[0] }).id],
  });
  await processAshbyReviewJob(
    job({ meetingId: meeting.id, payload: { runId: loaded.review.id, revision: loaded.review.revision } }),
  );
  loaded.review = requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) });
  assert.equal(requiredValue({ value: loaded.review.items[0] }).status, "unknown");
  assert.equal(flow.writes, 1);
  await assert.rejects(
    actOnAshbyReview(meeting.id, user.id, { action: "retry", revision: loaded.review.revision }),
    /pending/,
  );
  loaded.review = await actOnAshbyReview(meeting.id, user.id, {
    action: "confirm",
    revision: loaded.review.revision,
    itemIds: [requiredValue({ value: loaded.review.items[0] }).id],
  });
  await processAshbyReviewJob(
    job({ meetingId: meeting.id, payload: { runId: loaded.review.id, revision: loaded.review.revision } }),
  );
  loaded.review = requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) });
  assert.equal(loaded.review.status, "completed");
  assert.equal(flow.writes, 1);
  await disconnectAshbyMember({ workspaceId: user.workspaceId, userId: user.id });
  assert.equal(await getPrivateAshbyReview(meeting.id, user.id), null);
  assert.ok(await getAshbyReviewById({ id: loaded.review.id }), DRAFT_DURABLE_WHILE_DISCONNECTED_MESSAGE);
});
void test("confident negative meetings bypass the stronger model and show no menu", async (t) => {
  const { user, meeting } = await fixture();
  const screening = { calls: 0 };
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.ok(String(url).includes("typesafe"));
    screening.calls += 1;
    const no = { type: "choice", choice: "no", probabilities: { yes: 0, uncertain: 0, no: 1 } };

    return Response.json({
      answers: { stage: no },
      usage: { input_tokens: MOCK_INPUT_TOKENS, output_tokens: MOCK_OUTPUT_TOKENS },
    });
  });
  await processAshbyReviewJob(job({ meetingId: meeting.id, payload: {} }));
  assert.equal((await getPrivateAshbyReview(meeting.id, user.id))?.status, "no_matches");
  assert.equal(screening.calls, 1);
  await processAshbyReviewJob(job({ meetingId: meeting.id, payload: {} }));
  assert.equal(screening.calls, 1, CACHED_SCREENING_DOES_NOT_REPEAT_MESSAGE);
});

type StageCorrectionFlowState = { stageId: string; writes: number };

function createStageCorrectionAshbyFetchHandler(input: {
  flow: StageCorrectionFlowState;
  segment: TranscriptSegmentRef;
}) {
  const { flow, segment } = input;

  return async (request: { url: unknown; init: RequestInit }) => {
    const { url, init } = request;
    const body = parseAshbyRpcRequestBody(init);
    if (String(url).includes("typesafe")) {
      return new Response(null, { status: HTTP_SERVICE_UNAVAILABLE });
    }
    if (String(url).includes("ai-gateway.vercel.sh")) {
      const openAiBody = parseOpenAiRequestBody(init);
      const revisionMessage = openAiBody.input.at(1);
      assert.ok(revisionMessage !== undefined);
      const extractionInput = parseAshbyReviseExtractionInput(openAiInputText(revisionMessage.content));
      const hasCorrection = typeof extractionInput.correction === "string" && extractionInput.correction !== "";
      if (hasCorrection) {
        const firstTarget = extractionInput.availableTargets?.[0];
        if (firstTarget !== undefined) {
          assert.ok(firstTarget.stageNames.includes(ONSITE_STAGE_NAME));
        }
      }

      return gatewayResponse({
        output_text: JSON.stringify({
          proposals: [
            {
              kind: "stage",
              candidateName: PRIYA_SHAH_NAME,
              candidateEmail: null,
              jobTitle: "Designer",

              stageName: hasCorrection ? ONSITE_STAGE_NAME : "Technical Interview",
              evidence: [{ segmentId: segment.id, quote: segment.content }],
            },
          ],
          clarification: null,
        }),
      });
    }
    const endpoint = readMockEndpoint(url);
    const candidate = { id: "personqj", name: PRIYA_SHAH_NAME, applicationIds: ["app"] };
    if (endpoint === "candidate.search") {
      return Response.json({ /** @external Ashby API success flag */ success: true, results: [candidate] });
    }
    if (endpoint === "candidate.info") {
      return Response.json({ /** @external Ashby API success flag */ success: true, results: candidate });
    }
    if (endpoint === "application.info") {
      return Response.json({
        /** @external Ashby API success flag */
        success: true,
        results: {
          id: "app",
          candidate: { id: "personqj" },
          status: "Active",
          job: { title: "Designer" },
          currentInterviewStage: { id: flow.stageId, title: "Screen", interviewPlanId: "plan" },
        },
      });
    }
    if (endpoint === "interviewStage.list") {
      return Response.json({
        /** @external Ashby API success flag */
        success: true,
        results: [
          {
            id: "technical",
            title: "Technical Interview",
            type: "Active",
            interviewPlanId: "plan",
          },
          { id: "onsite", title: "Onsite", type: "Active", interviewPlanId: "plan" },
          { id: "hired", title: "Hired", type: "Hired", interviewPlanId: "plan" },
        ],
      });
    }
    if (endpoint === "application.changeStage") {
      flow.writes += 1;
      assert.deepEqual(body, { applicationId: "app", interviewStageId: "onsite" });
      const interviewStageId = requiredValue({ value: body.interviewStageId });
      flow.stageId = interviewStageId;

      return Response.json({ /** @external Ashby API success flag */ success: true, results: {} });
    }
    throw unexpectedMockEndpointFailure(endpoint);
  };
}

function registerStageCorrectionTest(input: { prior: (typeof STAGE_PRIOR_VALUES)[number] }) {
  const { prior } = input;
  void test(`stage corrections and conflicting ${prior} claims`, async (t) => {
    const { user, meeting, segment } = await fixture();
    const flow = { stageId: "screen", writes: 0 };
    const ashbyFetch = createStageCorrectionAshbyFetchHandler({ flow, segment });
    t.mock.method(globalThis, "fetch", (url: unknown, init: RequestInit) => ashbyFetch({ url, init }));
    await processAshbyReviewJob(job({ meetingId: meeting.id, payload: {} }));
    const loaded = { review: requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) }) };
    assert.equal(requiredValue({ value: loaded.review.items[0] }).stageId, "technical");
    loaded.review = await actOnAshbyReview(meeting.id, user.id, {
      action: "revise",
      revision: loaded.review.revision,
      instruction: "Use the onsite stage instead.",
    });
    await processAshbyReviewJob(
      job({ meetingId: meeting.id, payload: { runId: loaded.review.id, revision: loaded.review.revision } }),
    );
    loaded.review = requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) });
    assert.equal(requiredValue({ value: loaded.review.items[0] }).stageId, "onsite");
    assert.equal(flow.writes, 0);
    if (prior !== "none") {
      const sourceItem = requiredValue({ value: loaded.review.items[0] });
      const item = {
        ...sourceItem,
        stageId: prior === "completed_same" ? "onsite" : "technical",
      };
      const applicationId = item.applicationId;
      if (applicationId === null) {
        throw new Error(EXPECTED_APPLICATION_ID_MESSAGE);
      }
      flow.stageId = item.stageId;
      const claim = await claimAshbyAction({
        workspaceId: loaded.review.workspaceId,
        meetingId: meeting.id,
        kind: "stage",
        targetId: applicationId,
        intent: { item, connectionVersion: loaded.review.connectionVersion },
      });
      if (prior === "completed" || prior === "completed_same") {
        await finishAshbyAction({
          id: claim.id,
          status: "completed",
          result: {
            item,
            connectionVersion: loaded.review.connectionVersion,
            stageId: flow.stageId,
          },
        });
      }
    }
    loaded.review = await actOnAshbyReview(meeting.id, user.id, {
      action: "confirm",
      revision: loaded.review.revision,
      itemIds: [requiredValue({ value: loaded.review.items[0] }).id],
    });
    await processAshbyReviewJob(
      job({ meetingId: meeting.id, payload: { runId: loaded.review.id, revision: loaded.review.revision } }),
    );
    const finalReview = requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) });
    assert.equal(finalReview.status, prior === "none" || prior === "completed_same" ? "completed" : "awaiting_user");
    assert.equal(flow.writes, prior === "none" ? 1 : 0);
    if (prior !== "none" && prior !== "completed_same") {
      const failedItem = requiredValue({ value: finalReview.items[0] });
      assert.equal(failedItem.status, "failed");
      assert.match(requiredValue({ value: failedItem.error }), /not sent/);
    }
  });
}

STAGE_PRIOR_VALUES.forEach((prior) => {
  registerStageCorrectionTest({ prior });
});

void test("clarification-only extraction and revision remain actionable", async (t) => {
  const { user, meeting } = await fixture();
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    if (String(url).includes("typesafe")) {
      return new Response(null, { status: HTTP_SERVICE_UNAVAILABLE });
    }
    assert.ok(String(url).includes("ai-gateway.vercel.sh"));

    return gatewayResponse({
      output_text: JSON.stringify({ proposals: [], clarification: "Which applicant?" }),
    });
  });
  await processAshbyReviewJob(job({ meetingId: meeting.id, payload: {} }));
  const loaded = { review: requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) }) };
  assert.equal(loaded.review.status, "awaiting_user");
  assert.equal(loaded.review.clarification, "Which applicant?");
  loaded.review = await actOnAshbyReview(meeting.id, user.id, {
    action: "revise",
    revision: loaded.review.revision,
    instruction: "Personqj",
  });
  await processAshbyReviewJob(
    job({ meetingId: meeting.id, payload: { runId: loaded.review.id, revision: loaded.review.revision } }),
  );
  loaded.review = requiredValue({ value: await getPrivateAshbyReview(meeting.id, user.id) });
  assert.equal(loaded.review.status, "awaiting_user");
  assert.equal(loaded.review.clarification, "Which applicant?");
});
