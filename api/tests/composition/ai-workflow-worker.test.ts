import { aiWorkflowJobViewSchema, INSUFFICIENT_CREDITS_CODE } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import * as assistantClient from "../../adapters/secondary/undici/assistant-client";
import { ensureGuestMeetingPreviewInRequest, runAiWorkflowInRequest } from "../../application/run-ai-work";
import { configureAssistantClient } from "../../ports/gate-assistant-client";
import { repositories } from "../../ports/repository-runtime";

const DATABASE_UNAVAILABLE_MESSAGE = "database unavailable";
const WORKFLOW_REQUEST_FAILED_MESSAGE = "Workflow request failed";

const logger = { info() {}, warn() {} };
function execution(type: "track_meeting" | "resolve_meeting_title" | "generate_meeting_snapshot" = "track_meeting") {
  const now = new Date().toISOString();

  return aiWorkflowJobViewSchema.parse({
    id: randomUUID(),
    meetingId: randomUUID(),
    type,
    status: "running",
    phase: "running",
    payload: {},
    result: {},
    error: null,
    extractionId: null,
    attemptCount: 1,
    maxAttempts: 1,
    runAfter: now,
    lockedBy: null,
    lockedAt: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}
void test("request creates real history and awaits completion", async (t) => {
  const job = execution();
  const events: { values: string[] } = { values: [] };
  t.mock.method(repositories(), "startAiWorkflowExecution", async () => {
    events.values = [...events.values, "start"];

    return job;
  });
  t.mock.method(repositories(), "completeAiWorkflowJob", async () => {
    events.values = [...events.values, "complete"];

    return { ...job, status: "completed" };
  });
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("retired task detector must not call a provider");
  });
  const result = await runAiWorkflowInRequest({ meetingId: job.meetingId, type: job.type, logger });
  assert.equal(result.status, "completed");
  assert.deepEqual(events.values, ["start", "complete"]);
});
void test("provider failure is recorded and returned to the caller without scheduling a retry", async (t) => {
  const job = execution("resolve_meeting_title");
  const error = new Error(DATABASE_UNAVAILABLE_MESSAGE);
  t.mock.method(repositories(), "getMeetingById", async () => {
    throw error;
  });
  const failed = t.mock.method(repositories(), "failAiWorkflowJob", async () => ({ ...job, status: "failed" }));
  const complete = t.mock.method(repositories(), "completeAiWorkflowJob", async () => {
    assert.fail("must not complete");
  });
  await assert.rejects(runAiWorkflowInRequest({ meetingId: job.meetingId, type: job.type, job, logger }), error);
  assert.equal(failed.mock.callCount(), 1);
  assert.equal(complete.mock.callCount(), 0);
  assert.deepEqual(failed.mock.calls[0]?.arguments, [{ jobId: job.id, error: WORKFLOW_REQUEST_FAILED_MESSAGE }]);
});

void test("a preview already owned by another request never calls the provider", async (t) => {
  const job = execution("resolve_meeting_title");
  t.mock.method(repositories(), "ensureGuestMeetingPreviewJob", async () => job);
  const generation = t.mock.method(repositories(), "getMeetingById", async () => {
    assert.fail("Only the request that created the preview claim may generate it");
  });
  assert.equal(await ensureGuestMeetingPreviewInRequest({ meetingId: job.meetingId, logger }), job);
  assert.equal(generation.mock.callCount(), 0);
});

void test("workspace switches suppress live summary and ambient work before any provider request", async (t) => {
  const { upsertUser, createMeeting, updateWorkspaceSettings } = await import("@readymeet/db");
  const user = await upsertUser({ email: `${randomUUID()}@disabled-intelligence.test`, displayName: "Disabled" });
  const meeting = await createMeeting({
    title: "Disabled",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  await updateWorkspaceSettings({
    workspaceId: user.workspaceId,
    isLiveSummaryEnabled: false,
    isAmbientContextEnabled: false,
  });
  t.mock.method(globalThis, "fetch", async () => assert.fail("Disabled features must not call providers"));
  await Promise.all(
    (["track_meeting", "detect_ambient_context", "research_ambient_entity"] as const).map(async (type) => {
      const result = await runAiWorkflowInRequest({ meetingId: meeting.id, type, logger });
      assert.equal(result.status, "completed");
      assert.deepEqual(result.result, { isDisabled: true });
    }),
  );
});

void test("snapshot workflow preserves the credit-denial reason while keeping private failure history redacted", async (t) => {
  const job = execution("generate_meeting_snapshot");
  const HTTP_PAYMENT_REQUIRED = 402;
  const PRIVATE_FAILURE = "private provider details";
  const error = Object.assign(new Error(PRIVATE_FAILURE), {
    statusCode: HTTP_PAYMENT_REQUIRED,
    code: INSUFFICIENT_CREDITS_CODE,
  });
  configureAssistantClient({
    ...assistantClient,
    triggerMeetingSnapshot: async () => {
      throw error;
    },
  });
  t.after(() => configureAssistantClient(assistantClient));
  const failed = t.mock.method(repositories(), "failAiWorkflowJob", async () => ({ ...job, status: "failed" }));
  t.mock.method(repositories(), "getSummaryForMeeting", async () => null);
  const saved = t.mock.method(repositories(), "upsertSummaryForMeeting", async () => ({}));
  await assert.rejects(runAiWorkflowInRequest({ meetingId: job.meetingId, type: job.type, job, logger }), error);
  assert.deepEqual(failed.mock.calls[0]?.arguments, [{ jobId: job.id, error: WORKFLOW_REQUEST_FAILED_MESSAGE }]);
  assert.match(saved.mock.calls[0]?.arguments[0]?.content ?? "", /AI credits/);
});
