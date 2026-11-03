import rateLimit from "@fastify/rate-limit";
import * as repo from "@readymeet/db";
import {
  CREDIT_PRICE_MICRO_USD,
  DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL,
  DEFAULT_OPENAI_MODEL_PRICES_JSON,
  meetingNotesViewResponseSchema,
  minimumNotesRunCredits,
  parseOpenAIModelPrices,
  PLAN_CREDITS,
} from "@readymeet/shared";
import Fastify, { type FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";

import { authRoutes } from "../../../adapters/primary/http/routes/auth";
import { capabilityWorkflowRoutes } from "../../../adapters/primary/http/routes/capability-workflows";
import { internalAgentToolRoutes } from "../../../adapters/primary/http/routes/internal-agent-tools";
import { meetingAmbientContextRoutes } from "../../../adapters/primary/http/routes/meetings/ambient-context";
import { meetingLifecycleRoutes } from "../../../adapters/primary/http/routes/meetings/meeting-lifecycle";
import { meetingPipelineRoutes } from "../../../adapters/primary/http/routes/meetings/meeting-pipelines";
import { meetingTaskRoutes } from "../../../adapters/primary/http/routes/meetings/meeting-tasks";
import { meetingTrackerRoutes } from "../../../adapters/primary/http/routes/meetings/meeting-tracker";
import { signAuthToken } from "../../../adapters/primary/http/support/auth";
import { resolveMeetingNotesAccess } from "../../../application/meeting-notes-access";
import { apiEnv } from "../../../composition/env";
import { repositories } from "../../../ports/repository-runtime";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const SECONDARY_CONTENT_READ_FAILURE = "Notes must not wait for secondary content";
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const FIXTURE_TRANSCRIPT_OFFSET_MS = 120_000;
const GUEST_SESSION_TTL_MS = 3_600_000;
const UNEXPECTED_PROVIDER_CALL_MESSAGE = "Unexpected provider call during regression test";
const MESSAGE_REQUIRED_VALUE_SUFFIX = "is missing";
const WORKSPACE_TRIAL_MEETING_LIMIT = 3;
const HISTORICAL_MEETING_FIXTURE_COUNT = 4;
const UNLOCKED_NOTES_ACCESS_COUNT = 3;
const UNLOCKED_NOTES_ACCESS_COUNT_AFTER_CONSUMPTION = 2;
const POST_CONSUMPTION_TRIAL_MEETING_COUNT = 5;
const TRIAL_WARMUP_MEETING_COUNT = 3;
const TRIAL_WARMUP_MEETING_INDICES = [...Array.from({ length: TRIAL_WARMUP_MEETING_COUNT }).keys()];
const SINGLE_CONSUMED_TRIAL_SLOT_COUNT = 1;
const FIXTURE_ACTIVE_LEAD_MS = 300_000;
const PROMOTIONAL_CREDIT_GRANT = 5;
const JOINED_WORKSPACE_ASSIGNMENT = "joined_workspace";

const endMeetingResponseSchema = z.object({
  /** @external meeting end finalized wire field */
  finalized: z.boolean(),
});
const lockedNotesResponseSchema = z.object({ code: z.string() });
const summaryResponseSchema = z.object({ summary: z.object({ content: z.string() }) });
const GENERATED_SUMMARY = "Generated notes";
const snapshotRunResponseSchema = z.object({
  job: z.object({ status: z.string() }),
  snapshot: z.object({ id: z.string() }).nullable(),
});
const SNAPSHOT_TEST_CLAIM_LEASE_MS = 900_000;
const CREDIT_BLOCKED_FIXTURE_SUMMARY =
  "Meeting notes weren't generated because there weren't enough AI credits. Add credits, then choose Generate notes. The transcript is available for review.";
const FALLBACK_FIXTURE_MODEL = "fallback-summary-v1";
const SNAPSHOT_FAILURE_MESSAGE = "snapshot failed";
const REGENERATION_POLL_MS = 50;
const REGENERATION_POLL_ATTEMPTS = 100;
const regenerateNotesResponseSchema = z.object({ status: z.string() });
const guestNotesResponseSchema = z.object({
  summary: z.object({ content: z.string() }).nullable(),
  notesAccess: z.object({ locked: z.boolean(), reason: z.string().nullable() }),
});

function snapshotProviderResponse(meetingId: string): Response {
  return new Response(
    JSON.stringify({
      snapshot: {
        id: randomUUID(),
        meetingId,
        title: "Fixture",
        summary: GENERATED_SUMMARY,
        actionItems: [],
        proposedTitle: null,
        meetingType: null,
        meetingTypeConfidence: null,
        gist: "Notes",
        topicChips: [],
        highlights: [],
        snapshotModel: "fixture",
        snapshotPromptVersion: "fixture",
        createdAt: new Date().toISOString(),
      },
    }),
  );
}

function missingRequiredValueMessage(input: { label: string }): string {
  return `${input.label} ${MESSAGE_REQUIRED_VALUE_SUFFIX}`;
}

function required<T>(input: { value: T | null | undefined; label: string }): T {
  if (input.value === null || input.value === undefined) {
    throw new Error(missingRequiredValueMessage({ label: input.label }));
  }

  return input.value;
}

function parseInjectBody<T>(input: { body: string; schema: z.ZodType<T> }): T {
  return input.schema.parse(JSON.parse(input.body));
}

async function eachSequential<T>(input: {
  items: readonly T[];
  visit: (context: { item: T; index: number }) => Promise<void>;
}) {
  await input.items.reduce(async (previous, item, index) => {
    await previous;
    await input.visit({ item, index });
  }, Promise.resolve());
}

type CriticalRegressionUser = Awaited<ReturnType<typeof repo.upsertUser>>;
type CriticalRegressionMeetingFixture = Awaited<ReturnType<typeof repo.createMeetingLinkWithInitialMeeting>>;

async function assignJoinedWorkspace(input: { meetingId: string; userId: string; workspaceId: string }) {
  await repo.db.meetingAttendeeWorkspaces.upsert({
    where: {
      meetingId_userId: {
        meetingId: input.meetingId,
        userId: input.userId,
      },
    },
    create: {
      meetingId: input.meetingId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      assignment: JOINED_WORKSPACE_ASSIGNMENT,
    },
    update: { workspaceId: input.workspaceId },
  });
}

async function exhaustFixtureNotesEntitlement(userId: string) {
  // A stale paid plan without grants is locked; free meetings no longer use credit exhaustion.
  await repo.updateUserPlan({ userId, plan: "business" });
}

async function removeFixtureRows(userIds: readonly string[]) {
  if (userIds.length === 0) {
    return;
  }
  await repo.db.meetings.deleteMany({ where: { createdByUserId: { in: [...userIds] } } });
  await repo.db.meetingLinks.deleteMany({ where: { createdByUserId: { in: [...userIds] } } });
  await repo.db.workspaces.deleteMany({ where: { createdByUserId: { in: [...userIds] } } });
  await repo.db.users.deleteMany({ where: { id: { in: [...userIds] } } });
}

type CriticalRegressionHarness = {
  app: FastifyInstance;
  providerCalls: { count: number };
  user: () => Promise<CriticalRegressionUser>;
  meeting: (input: { user: CriticalRegressionUser }) => Promise<CriticalRegressionMeetingFixture>;
  headers: (input: { user: CriticalRegressionUser }) => { authorization: string };
  finish: (input: { id: string; user: CriticalRegressionUser; shouldWriteSummary?: boolean }) => Promise<void>;
  access: (input: {
    id: string;
    user: CriticalRegressionUser;
  }) => Promise<Awaited<ReturnType<typeof resolveMeetingNotesAccess>>>;
  guestFixture: (input: {
    host: CriticalRegressionUser;
    fixture: CriticalRegressionMeetingFixture;
    isAdmitted: boolean;
  }) => Promise<{
    guest: Awaited<ReturnType<typeof repo.createGuestUser>>;
    session: Awaited<ReturnType<typeof repo.createGuestAuthSession>>;
    guestToken: string;
    headers: { authorization: string };
  }>;
};

async function registerCriticalRegressionFastifyApp(input: { t: TestContext }) {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  await app.register(meetingLifecycleRoutes);
  await app.register(meetingPipelineRoutes);
  await app.register(meetingTaskRoutes);
  await app.register(authRoutes);
  await app.register(capabilityWorkflowRoutes);
  await app.register(meetingAmbientContextRoutes);
  await app.register(meetingTrackerRoutes);
  await app.register(internalAgentToolRoutes);
  const originalFetch = globalThis.fetch;
  const fixtureUserIdsState = { ids: [] as string[] };
  const trackFixtureUser = (userId: string) => {
    fixtureUserIdsState.ids = [...fixtureUserIdsState.ids, userId];
  };
  const providerCalls = { count: 0 };
  globalThis.fetch = async (fetchInput) => {
    const requestUrl =
      typeof fetchInput === "string" ? fetchInput : fetchInput instanceof URL ? fetchInput.href : fetchInput.url;
    const path = new URL(requestUrl).pathname;
    if (path.endsWith("/ListParticipants")) {
      return new Response('{"participants":[]}');
    }
    if (path.endsWith("/DeleteRoom")) {
      return new Response("{}");
    }
    if (path.endsWith("/room-assistant/stop") || path.endsWith("/live-transcription/stop") || path.endsWith("/title")) {
      return new Response("{}");
    }
    const snapshotMeetingId = path.match(/\/meetings\/([^/]+)\/snapshot$/)?.[1];
    if (snapshotMeetingId !== undefined) {
      providerCalls.count += 1;

      return snapshotProviderResponse(snapshotMeetingId);
    }
    providerCalls.count += 1;
    throw new Error(UNEXPECTED_PROVIDER_CALL_MESSAGE);
  };
  input.t.after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    try {
      await removeFixtureRows(fixtureUserIdsState.ids);
    } finally {
      await repo.closeDbPool();
    }
  });

  return { app, providerCalls, trackFixtureUser };
}

async function buildCriticalRegressionGuestFixture(input: {
  host: CriticalRegressionUser;
  fixture: CriticalRegressionMeetingFixture;
  isAdmitted: boolean;
  trackFixtureUser: (userId: string) => void;
}) {
  const guest = await repo.createGuestUser({ displayName: "Guest" });
  input.trackFixtureUser(guest.id);
  const request = await repo.createOrReuseMeetingJoinRequest({
    meetingLinkId: input.fixture.meetingLink.id,
    meetingId: input.fixture.meeting.id,
    userId: guest.id,
    displayName: "Guest",
  });
  if (input.isAdmitted) {
    await repo.decideMeetingJoinRequest({
      requestId: request.id,
      meetingId: input.fixture.meeting.id,
      decidedByUserId: input.host.id,
      status: "admitted",
    });
    await repo.upsertParticipantPresence({
      meetingId: input.fixture.meeting.id,
      userId: guest.id,
      role: "guest",
    });
  }
  const secret = randomUUID();
  const session = await repo.createGuestAuthSession({
    userId: guest.id,
    meetingLinkId: input.fixture.meetingLink.id,
    meetingId: input.fixture.meeting.id,
    joinRequestId: request.id,
    secretHash: createHash("sha256").update(secret).digest("hex"),
    expiresAt: new Date(Date.now() + GUEST_SESSION_TTL_MS),
  });
  const guestToken = signAuthToken({
    sub: guest.id,
    email: guest.email,
    displayName: guest.displayName,
    workspaceId: input.host.workspaceId,
    tokenKind: "guest",
    source: "guest",
    meetingId: input.fixture.meeting.id,
    meetingLinkId: input.fixture.meetingLink.id,
    joinRequestId: request.id,
    guestSessionId: session.id,
    guestSessionSecret: secret,
  });

  return { guest, session, guestToken, headers: { authorization: `Bearer ${guestToken}` } };
}

function createCriticalRegressionHarness(input: {
  app: FastifyInstance;
  providerCalls: { count: number };
  trackFixtureUser: (userId: string) => void;
}): CriticalRegressionHarness {
  const user = async () => {
    const fixture = await repo.upsertUser({
      email: `${randomUUID()}@critical-regression.test`,
      displayName: "Fixture",
      source: "auth",
    });
    input.trackFixtureUser(fixture.id);

    return fixture;
  };
  const token = (tokenInput: { user: CriticalRegressionUser }) =>
    signAuthToken({
      sub: tokenInput.user.id,
      email: tokenInput.user.email,
      displayName: tokenInput.user.displayName,
      workspaceId: tokenInput.user.workspaceId,
      sessionVersion: tokenInput.user.sessionVersion,
      tokenKind: "full",
      source: tokenInput.user.source,
    });
  const headers = (headerInput: { user: CriticalRegressionUser }) => ({
    authorization: `Bearer ${token({ user: headerInput.user })}`,
  });
  const meeting = (meetingInput: { user: CriticalRegressionUser }) =>
    repo.createMeetingLinkWithInitialMeeting({
      title: "Fixture",
      code: randomUUID(),
      createdByUserId: meetingInput.user.id,
      workspaceId: meetingInput.user.workspaceId,
    });
  const finish = async (finishInput: { id: string; user: CriticalRegressionUser; shouldWriteSummary?: boolean }) => {
    const shouldWriteSummary = finishInput.shouldWriteSummary ?? true;
    await repo.db.meetings.updateMany({
      where: { id: finishInput.id },
      data: { status: "active", startedAt: new Date(Date.now() - FIXTURE_ACTIVE_LEAD_MS) },
    });
    await repo.appendTranscriptSegment({
      meetingId: finishInput.id,
      speakerIdentity: finishInput.user.id,
      speakerUserId: finishInput.user.id,
      speakerRole: "human",
      speakerName: "Fixture",
      content: "We will finish the proposal tomorrow and send the final document to the entire team.",
      startedAt: new Date(Date.now() - FIXTURE_TRANSCRIPT_OFFSET_MS),
    });
    await repo.updateTranscriptForMeeting({
      meetingId: finishInput.id,
      metadata: { finalizedAt: new Date().toISOString() },
    });
    await repo.markAllHumanParticipantsLeft(finishInput.id);
    await repo.db.meetings.updateMany({
      where: { id: finishInput.id },
      data: { status: "ended", endedAt: new Date() },
    });
    if (shouldWriteSummary) {
      await repo.upsertSummaryForMeeting({
        meetingId: finishInput.id,
        content: "Saved notes",
        model: "fixture",
      });
    }
  };
  const access = async (accessInput: { id: string; user: CriticalRegressionUser }) =>
    resolveMeetingNotesAccess({
      meeting: required({ value: await repo.getMeetingById(accessInput.id), label: "meeting" }),
      userId: accessInput.user.id,
      viewerRole: "participant",
    });
  const guestFixture = (guestInput: {
    host: CriticalRegressionUser;
    fixture: CriticalRegressionMeetingFixture;
    isAdmitted: boolean;
  }) =>
    buildCriticalRegressionGuestFixture({
      ...guestInput,
      trackFixtureUser: input.trackFixtureUser,
    });

  return {
    app: input.app,
    providerCalls: input.providerCalls,
    user,
    meeting,
    headers,
    finish,
    access,
    guestFixture,
  };
}

// These fixtures write only to an explicitly selected disposable database.
async function runCriticalRegressionMeetingEndTests(input: { t: TestContext; harness: CriticalRegressionHarness }) {
  const { t, harness } = input;
  const { app, user, meeting, headers, guestFixture } = harness;

  await t.test(
    "outsiders and waiting guests cannot finalize an unused meeting; host force-end still works",
    async () => {
      const host = await user(),
        outsider = await user(),
        f = await meeting({ user: host });
      const response = await app.inject({
        method: "POST",
        url: `/meetings/${f.meeting.id}/end`,
        headers: headers({ user: outsider }),
        payload: { action: "leave" },
      });
      assert.equal(response.statusCode, HTTP_FORBIDDEN);
      const g = await guestFixture({ host, fixture: f, isAdmitted: false });
      const left = await app.inject({
        method: "POST",
        url: `/meetings/${f.meeting.id}/end`,
        headers: g.headers,
        payload: { action: "leave" },
      });
      assert.equal(left.statusCode, HTTP_OK);
      assert.equal(parseInjectBody({ body: left.body, schema: endMeetingResponseSchema }).finalized, false);
      const hostLeft = await app.inject({
        method: "POST",
        url: `/meetings/${f.meeting.id}/end`,
        headers: headers({ user: host }),
        payload: { action: "leave" },
      });
      assert.equal(parseInjectBody({ body: hostLeft.body, schema: endMeetingResponseSchema }).finalized, false);
      assert.equal(required({ value: await repo.getMeetingById(f.meeting.id), label: "meeting" }).status, "scheduled");
      assert.equal(await repo.markMeetingEndedAndEnqueueFinalizationJob(f.meeting.id), null);
      const ended = await app.inject({
        method: "POST",
        url: `/meetings/${f.meeting.id}/end`,
        headers: headers({ user: host }),
        payload: { action: "end_for_all" },
      });
      assert.equal(ended.statusCode, HTTP_OK);
      assert.equal(required({ value: await repo.getMeetingById(f.meeting.id), label: "meeting" }).status, "ended");
    },
  );

  await t.test("the final actual participant can leave an active meeting", async () => {
    const host = await user(),
      f = await meeting({ user: host });
    await repo.markMeetingActive(f.meeting.id);
    await repo.upsertParticipantPresence({ meetingId: f.meeting.id, userId: host.id, role: "host" });
    assert.equal(
      await repo.markMeetingEndedAndEnqueueFinalizationJob(f.meeting.id),
      null,
      "do not end with active database presence",
    );
    const response = await app.inject({
      method: "POST",
      url: `/meetings/${f.meeting.id}/end`,
      headers: headers({ user: host }),
      payload: { action: "leave" },
    });
    assert.equal(response.statusCode, HTTP_OK);
    assert.equal(parseInjectBody({ body: response.body, schema: endMeetingResponseSchema }).finalized, true);
  });
}

async function runCriticalRegressionAgentToolTests(input: { t: TestContext; harness: CriticalRegressionHarness }) {
  const { t, harness } = input;
  const { app, user, meeting, providerCalls } = harness;

  await t.test("the tool API rejects forged persisted owners and stale turns", async () => {
    const owner = await user(),
      attacker = await user(),
      f = await meeting({ user: owner });
    await repo.markMeetingActive(f.meeting.id);
    await repo.upsertParticipantPresence({ meetingId: f.meeting.id, userId: owner.id, role: "host" });
    const profile = await repo.ensureDefaultAgentProfileForUser({ userId: owner.id, displayName: owner.displayName });
    const turn = await repo.createMeetingTurnLease({
      meetingId: f.meeting.id,
      ownerUserId: owner.id,
      ownerParticipantIdentity: `${attacker.id}:browser`,
      agentProfileId: profile.id,
      assistantDisplayName: "Fixture",
    });
    const payload = {
      context: {
        meetingId: f.meeting.id,
        requestingUserId: owner.id,
        activeSpeakerUserId: owner.id,
        agentProfileId: profile.id,
        meetingTurnId: turn.id,
        participantIdentity: `${owner.id}:browser`,
        utteranceId: "fixture",
        allowedToolScope: "private",
        createdAt: new Date().toISOString(),
      },
    };
    const request = () =>
      app.inject({
        method: "POST",
        url: "/internal/agent-tools/list",
        headers: { "x-assistant-service-secret": apiEnv.ASSISTANT_SERVICE_SECRET },
        payload,
      });
    assert.equal((await request()).statusCode, HTTP_FORBIDDEN);
    await repo.db.meetingTurns.updateMany({
      where: { id: turn.id },
      data: { ownerParticipantIdentity: `${owner.id}:browser` },
    });
    assert.equal((await request()).statusCode, HTTP_OK);
    await repo.db.meetingTurns.updateMany({ where: { id: turn.id }, data: { status: "expired" } });
    assert.equal((await request()).statusCode, HTTP_FORBIDDEN);
    const nextTurn = await repo.createMeetingTurnLease({
      meetingId: f.meeting.id,
      ownerUserId: owner.id,
      ownerParticipantIdentity: `${owner.id}:new-browser`,
      agentProfileId: profile.id,
      assistantDisplayName: "Fixture",
    });
    assert.equal((await request()).statusCode, HTTP_FORBIDDEN, "a newer active turn cannot authorize the old context");
    const catalogRequest = () =>
      app.inject({
        method: "POST",
        url: "/internal/agent-tools/linear-mcp-catalog",
        headers: { "x-assistant-service-secret": apiEnv.ASSISTANT_SERVICE_SECRET },
        payload,
      });
    assert.equal((await catalogRequest()).statusCode, HTTP_FORBIDDEN, "catalog requests also require the exact turn");
    payload.context.meetingTurnId = nextTurn.id;
    assert.equal((await request()).statusCode, HTTP_FORBIDDEN, "the turn must match the exact connection");
    payload.context.participantIdentity = `${owner.id}:new-browser`;
    assert.equal((await request()).statusCode, HTTP_OK);
    assert.equal((await catalogRequest()).statusCode, HTTP_OK);
    assert.equal(providerCalls.count, 0);
  });
}

async function runCriticalRegressionLockedNotesTests(input: { t: TestContext; harness: CriticalRegressionHarness }) {
  const { t, harness } = input;
  const { app, user, meeting, headers, finish, access, providerCalls } = harness;

  await t.test("locked notes cannot be read or regenerated through alternate endpoints", async () => {
    const owner = await user(),
      f = await meeting({ user: owner });
    await finish({ id: f.meeting.id, user: owner });
    const list = await repo.upsertMeetingTaskList({
      meetingId: f.meeting.id,
      status: "completed",
      phase: "complete",
    });
    const [task] = await repo.replaceMeetingTasksForList({
      meetingId: f.meeting.id,
      taskListId: list.id,
      items: [
        {
          title: "Send proposal",
          description: "Send the final proposal.",
          type: "task",
          workKind: "customer_follow_up",
          owner: { userId: owner.id, name: owner.displayName, email: owner.email, confidence: "high" },
          dueDate: { value: null, confidence: null },
          confidence: "high",
          completion: { completedDuringMeeting: false, quote: null, confidence: null },
          sourceQuotes: [
            {
              quote: "We will finish the proposal tomorrow.",
              speaker: owner.displayName,
              timestamp: new Date().toISOString(),
              segmentId: randomUUID(),
            },
          ],
          sourceReason: "Meeting commitment",
        },
      ],
    });
    assert.ok(task);
    assert.equal(
      (await repo.listAssignedTasksForUser({ userId: owner.id, workspaceIds: [owner.workspaceId] })).length,
      1,
    );
    await exhaustFixtureNotesEntitlement(owner.id);
    assert.equal((await access({ id: f.meeting.id, user: owner })).locked, true);
    assert.deepEqual(await repo.listAssignedTasksForUser({ userId: owner.id, workspaceIds: [owner.workspaceId] }), []);
    assert.deepEqual((await repo.listPersonalAssignedTasksForUser({ userId: owner.id })).tasks, []);
    assert.deepEqual(
      (await repo.listWorkspaceAssignedTasksForUser({ userId: owner.id, workspaceId: owner.workspaceId })).tasks,
      [],
    );
    assert.equal(await repo.getAssignedTaskContext({ userId: owner.id, taskId: task.id }), null);
    await eachSequential({
      items: [
        ["POST", "run-summary"],
        ["POST", "run-snapshot"],
        ["POST", "run-tasks"],
        ["POST", "run-extraction"],
        ["POST", "run-suggested-actions"],
        ["GET", "tasks/status"],
        ["GET", "extraction"],
        ["GET", "ai-jobs"],
        ["GET", "capability-workflows"],
        ["GET", "ambient-context"],
        ["GET", "tracker"],
      ] as const,
      visit: async ({ item: [method, path] }) => {
        const response = await app.inject({
          method,
          url: `/meetings/${f.meeting.id}/${path}`,
          headers: headers({ user: owner }),
        });
        assert.equal(response.statusCode, HTTP_FORBIDDEN, path);
        assert.equal(
          parseInjectBody({ body: response.body, schema: lockedNotesResponseSchema }).code,
          "meeting_notes_locked",
          path,
        );
      },
    });
    assert.equal(providerCalls.count, 0);
  });
}

async function runCriticalRegressionWorkspaceViewerTests(input: {
  t: TestContext;
  harness: CriticalRegressionHarness;
}) {
  const { t, harness } = input;
  const { app, user, meeting, headers, finish, access } = harness;

  await t.test(
    "workspace viewers retain their own notes entitlement rather than inheriting the host plan",
    async () => {
      const owner = await user(),
        viewer = await user(),
        f = await meeting({ user: owner });
      await repo.setMeetingConfidentiality({
        meetingId: f.meeting.id,
        actorUserId: owner.id,
        isConfidential: false,
        source: "manual",
      });
      await repo.ensureWorkspaceMembership({ workspaceId: owner.workspaceId, userId: viewer.id, role: "admin" });
      await finish({ id: f.meeting.id, user: owner });
      await repo.createCreditGrant({
        userId: owner.id,
        source: "promotional",
        credits: PROMOTIONAL_CREDIT_GRANT,
      });
      await exhaustFixtureNotesEntitlement(viewer.id);
      assert.equal((await access({ id: f.meeting.id, user: owner })).locked, false);
      const notesResponse = await app.inject({
        url: `/meetings/${f.meeting.id}/notes-view`,
        headers: headers({ user: viewer }),
      });
      assert.equal(notesResponse.statusCode, HTTP_OK);
      const notes = meetingNotesViewResponseSchema.parse(notesResponse.json());
      assert.equal(notes.meeting.viewerRole, "workspace");
      assert.equal(notes.notesAccess.locked, true);
      assert.equal(notes.summary, null);
      await eachSequential({
        items: ["tasks/status", "suggested-actions-status"],
        visit: async ({ item: path }) => {
          const response = await app.inject({
            url: `/meetings/${f.meeting.id}/${path}`,
            headers: headers({ user: viewer }),
          });
          assert.equal(response.statusCode, HTTP_FORBIDDEN);
          assert.equal(
            parseInjectBody({ body: response.body, schema: lockedNotesResponseSchema }).code,
            "meeting_notes_locked",
          );
        },
      });
      assert.equal(
        (await app.inject({ url: `/meetings/${f.meeting.id}/tasks/status`, headers: headers({ user: owner }) }))
          .statusCode,
        HTTP_OK,
      );
    },
  );
}

async function runCriticalRegressionSummaryReuseTests(input: { t: TestContext; harness: CriticalRegressionHarness }) {
  const { t, harness } = input;
  const { app, user, meeting, headers, finish, providerCalls } = harness;

  await t.test("summary requests reuse one durable job and never overwrite saved notes", async () => {
    const owner = await user(),
      f = await meeting({ user: owner });
    await finish({ id: f.meeting.id, user: owner, shouldWriteSummary: false });
    const request = () =>
      app.inject({ method: "POST", url: `/meetings/${f.meeting.id}/run-summary`, headers: headers({ user: owner }) });
    const responses = await Promise.all([request(), request()]);
    responses.forEach((response) => {
      assert.equal(response.statusCode, HTTP_OK);
      assert.equal(
        parseInjectBody({ body: response.body, schema: summaryResponseSchema }).summary.content,
        GENERATED_SUMMARY,
      );
    });
    await repo.upsertSummaryForMeeting({ meetingId: f.meeting.id, content: "Keep this summary", model: "fixture" });
    const callsAfterSave = providerCalls.count;
    assert.equal(
      parseInjectBody({ body: (await request()).body, schema: summaryResponseSchema }).summary.content,
      "Keep this summary",
    );
    assert.equal(
      parseInjectBody({ body: (await request()).body, schema: summaryResponseSchema }).summary.content,
      "Keep this summary",
    );
    assert.equal(providerCalls.count, callsAfterSave);
  });

  await t.test("run-snapshot waits for an in-flight finalization instead of generating the notes again", async () => {
    const owner = await user(),
      f = await meeting({ user: owner });
    await finish({ id: f.meeting.id, user: owner, shouldWriteSummary: false });
    const claimId = required({
      value: await repo.claimMeetingFinalization({ meetingId: f.meeting.id, leaseMs: SNAPSHOT_TEST_CLAIM_LEASE_MS }),
      label: "finalization claim",
    });
    const request = async () =>
      parseInjectBody({
        body: (
          await app.inject({
            method: "POST",
            url: `/meetings/${f.meeting.id}/run-snapshot`,
            headers: headers({ user: owner }),
          })
        ).body,
        schema: snapshotRunResponseSchema,
      });
    const callsBefore = providerCalls.count;
    const deferred = await request();
    assert.equal(deferred.job.status, "running");
    assert.equal(deferred.snapshot, null);
    assert.equal(providerCalls.count, callsBefore);
    await repo.releaseMeetingFinalization({ meetingId: f.meeting.id, claimId });
    const generated = await request();
    assert.equal(generated.job.status, "completed");
    assert.notEqual(generated.snapshot, null);
    assert.equal(providerCalls.count, callsBefore + 1);
  });
}

async function runCriticalRegressionGuestConversionTests(input: {
  t: TestContext;
  harness: CriticalRegressionHarness;
}) {
  const { t, harness } = input;
  const { app, user, meeting, headers, finish, access, guestFixture } = harness;

  await t.test("guest conversion keeps notes and uses the recorded attendee workspace", async () => {
    const host = await user(),
      converted = await user(),
      f = await meeting({ user: host });
    await repo.markMeetingActive(f.meeting.id);
    const g = await guestFixture({ host, fixture: f, isAdmitted: true });
    await finish({ id: f.meeting.id, user: host });
    const before = await app.inject({
      method: "GET",
      url: `/meetings/${f.meeting.id}/guest-notes`,
      headers: g.headers,
    });
    assert.equal(before.statusCode, HTTP_OK);
    assert.equal(parseInjectBody({ body: before.body, schema: summaryResponseSchema }).summary.content, "Saved notes");
    const linked = await app.inject({
      method: "POST",
      url: "/auth/link-guest-session",
      headers: headers({ user: converted }),
      payload: { guestToken: g.guestToken },
    });
    assert.equal(linked.statusCode, HTTP_OK);
    assert.equal((await access({ id: f.meeting.id, user: converted })).locked, false);
    assert.equal(await repo.hasMemoryNotesEntitlement({ userId: converted.id, meetingId: f.meeting.id }), true);
    assert.ok(
      required({ value: await repo.getGuestAuthSessionById(g.session.id), label: "guest session" }).session.revokedAt,
    );
    assert.equal(
      (await repo.getWorkspaceMemberCreditAccess({ userId: converted.id, workspaceId: host.workspaceId }))
        .hasTrialCredits,
      false,
    );
  });
}

async function runCriticalRegressionTrialAllocationTests(input: {
  t: TestContext;
  harness: CriticalRegressionHarness;
}) {
  const { t, harness } = input;
  const { user, meeting, finish, access } = harness;

  await t.test("trial allocation and entitlement share the recorded attendee workspace", async () => {
    const owner = await user(),
      other = await user();
    await repo.ensureWorkspaceMembership({ workspaceId: other.workspaceId, userId: owner.id, role: "member" });
    await eachSequential({
      items: TRIAL_WARMUP_MEETING_INDICES,
      visit: async () => {
        await finish({ id: (await meeting({ user: owner })).meeting.id, user: owner });
      },
    });
    const fixtures: CriticalRegressionMeetingFixture[] = await Promise.all(
      Array.from({ length: HISTORICAL_MEETING_FIXTURE_COUNT }, () => meeting({ user: owner })),
    );
    await eachSequential({
      items: fixtures,
      visit: async ({ item: f }) => {
        await assignJoinedWorkspace({
          meetingId: f.meeting.id,
          userId: owner.id,
          workspaceId: other.workspaceId,
        });
      },
    });
    await Promise.all(fixtures.map((f) => finish({ id: f.meeting.id, user: owner })));
    assert.equal(
      await repo.countWorkspaceMemberTrialMeetings({ userId: owner.id, workspaceId: owner.workspaceId }),
      WORKSPACE_TRIAL_MEETING_LIMIT,
    );
    assert.equal(
      await repo.countWorkspaceMemberTrialMeetings({ userId: owner.id, workspaceId: other.workspaceId }),
      WORKSPACE_TRIAL_MEETING_LIMIT,
    );
    const accesses = await Promise.all(fixtures.map((f) => access({ id: f.meeting.id, user: owner })));
    assert.equal(accesses.filter((a) => !a.locked).length, UNLOCKED_NOTES_ACCESS_COUNT);
    await eachSequential({
      items: fixtures,
      visit: async ({ item: f, index: i }) => {
        const accessRow = required({ value: accesses[i], label: "access" });
        assert.equal(
          await repo.hasMemoryNotesEntitlement({ userId: owner.id, meetingId: f.meeting.id }),
          !accessRow.locked,
        );
      },
    });
  });
}

async function runCriticalRegressionTrialConsumptionTests(input: {
  t: TestContext;
  harness: CriticalRegressionHarness;
}) {
  const { t, harness } = input;
  const { user, meeting, finish, access } = harness;

  await t.test("only delivered notes consume trial slots, concurrency and deletion cannot replenish them", async () => {
    const owner = await user();
    await Promise.all([meeting({ user: owner }), meeting({ user: owner }), meeting({ user: owner })]);
    const scope = { userId: owner.id, workspaceId: owner.workspaceId };
    assert.equal(await repo.countWorkspaceMemberTrialMeetings(scope), 0);
    await eachSequential({
      items: ["short-meeting-v1", "fallback-summary-v1"],
      visit: async ({ item: model }) => {
        const noWork = await meeting({ user: owner });
        await finish({ id: noWork.meeting.id, user: owner, shouldWriteSummary: false });
        await repo.upsertSummaryForMeeting({ meetingId: noWork.meeting.id, content: "No generated notes", model });
        assert.equal(await repo.countWorkspaceMemberTrialMeetings(scope), 0, model);
      },
    });
    const first = await meeting({ user: owner });
    await finish({ id: first.meeting.id, user: owner });
    assert.equal((await access({ id: first.meeting.id, user: owner })).locked, false);
    assert.equal(await repo.countWorkspaceMemberTrialMeetings(scope), SINGLE_CONSUMED_TRIAL_SLOT_COUNT);
    await repo.upsertSummaryForMeeting({ meetingId: first.meeting.id, content: "Revised notes", model: "fixture" });
    assert.equal(await repo.countWorkspaceMemberTrialMeetings(scope), SINGLE_CONSUMED_TRIAL_SLOT_COUNT);
    await repo.db.meetings.deleteMany({ where: { id: first.meeting.id } });
    assert.equal(await repo.countWorkspaceMemberTrialMeetings(scope), SINGLE_CONSUMED_TRIAL_SLOT_COUNT);
    const next: CriticalRegressionMeetingFixture[] = await Promise.all(
      Array.from({ length: POST_CONSUMPTION_TRIAL_MEETING_COUNT }, () => meeting({ user: owner })),
    );
    await Promise.all(next.map((f) => finish({ id: f.meeting.id, user: owner })));
    assert.equal(await repo.countWorkspaceMemberTrialMeetings(scope), WORKSPACE_TRIAL_MEETING_LIMIT);
    const accesses = await Promise.all(next.map((f) => access({ id: f.meeting.id, user: owner })));
    assert.equal(accesses.filter((a) => !a.locked).length, UNLOCKED_NOTES_ACCESS_COUNT_AFTER_CONSUMPTION);
    await eachSequential({
      items: next,
      visit: async ({ item: f }) => {
        const notesAccess = await access({ id: f.meeting.id, user: owner });
        assert.equal(
          await repo.hasMemoryNotesEntitlement({ userId: owner.id, meetingId: f.meeting.id }),
          !notesAccess.locked,
        );
      },
    });
  });
}

async function runCriticalRegressionSuggestedActionsActiveMeetingTests(input: {
  t: TestContext;
  harness: CriticalRegressionHarness;
}) {
  const { t, harness } = input;
  const { app, user, meeting, headers } = harness;

  await t.test("run-suggested-actions rejects live meetings with 409 instead of 500", async () => {
    const owner = await user();
    const f = await meeting({ user: owner });
    const response = await app.inject({
      method: "POST",
      url: `/meetings/${f.meeting.id}/run-suggested-actions`,
      headers: headers({ user: owner }),
    });
    assert.equal(response.statusCode, HTTP_CONFLICT, response.body);
    assert.match(response.body, /still active/i);
  });
}

async function waitForSummaryModelChange(input: { meetingId: string; from: string }): Promise<string | null> {
  const attempts = Array.from({ length: REGENERATION_POLL_ATTEMPTS });

  return attempts.reduce<Promise<string | null>>(async (previous) => {
    const settled = await previous;
    if (settled !== null) {
      return settled;
    }
    const summary = await repo.getSummaryForMeeting(input.meetingId);
    if (summary !== null && summary.model !== input.from) {
      return summary.model;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, REGENERATION_POLL_MS);
    });

    return null;
  }, Promise.resolve(null));
}

async function runCriticalRegressionFallbackNotesTests(input: { t: TestContext; harness: CriticalRegressionHarness }) {
  const { t, harness } = input;
  const { app, user, meeting, headers, finish, providerCalls } = harness;

  await t.test("generate notes replaces a credit-blocked fallback once, however many times it is clicked", async () => {
    const owner = await user(),
      f = await meeting({ user: owner });
    await finish({ id: f.meeting.id, user: owner, shouldWriteSummary: false });
    await repo.upsertSummaryForMeeting({
      meetingId: f.meeting.id,
      content: CREDIT_BLOCKED_FIXTURE_SUMMARY,
      model: FALLBACK_FIXTURE_MODEL,
    });
    await repo.createCreditGrant({ userId: owner.id, source: "promotional", credits: PROMOTIONAL_CREDIT_GRANT });
    const click = async () =>
      parseInjectBody({
        body: (
          await app.inject({
            method: "POST",
            url: `/meetings/${f.meeting.id}/regenerate-notes`,
            headers: headers({ user: owner }),
          })
        ).body,
        schema: regenerateNotesResponseSchema,
      }).status;
    const callsBefore = providerCalls.count;
    const statuses = await Promise.all([click(), click()]);
    // The second click lands while the first run is in flight or after it already replaced the notes.
    assert.equal(statuses.filter((status) => status === "started").length, 1, statuses.join(","));
    assert.ok(
      statuses.every((status) => ["started", "in_progress", "not_needed"].includes(status)),
      statuses.join(","),
    );
    assert.notEqual(
      await waitForSummaryModelChange({ meetingId: f.meeting.id, from: FALLBACK_FIXTURE_MODEL }),
      null,
      "fallback notes were not replaced",
    );
    assert.equal((await repo.getSummaryForMeeting(f.meeting.id))?.content, GENERATED_SUMMARY);
    const snapshotCalls = providerCalls.count - callsBefore;
    assert.equal(await click(), "not_needed");
    assert.equal(providerCalls.count - callsBefore, snapshotCalls);
  });

  await t.test("the host can see a fallback-notes run fail without waiting out the poll window", async () => {
    const owner = await user(),
      other = await user(),
      f = await meeting({ user: owner });
    await finish({ id: f.meeting.id, user: owner, shouldWriteSummary: false });
    await repo.upsertSummaryForMeeting({
      meetingId: f.meeting.id,
      content: CREDIT_BLOCKED_FIXTURE_SUMMARY,
      model: FALLBACK_FIXTURE_MODEL,
    });
    const progress = async (viewer: typeof owner) =>
      app.inject({ url: `/meetings/${f.meeting.id}/regenerate-notes`, headers: headers({ user: viewer }) });
    const progressStatus = async () =>
      parseInjectBody({ body: (await progress(owner)).body, schema: regenerateNotesResponseSchema }).status;
    const claim = await repo.claimMeetingNotesRegeneration({
      meetingId: f.meeting.id,
      regenerableSummaryModel: FALLBACK_FIXTURE_MODEL,
    });
    assert.equal(claim.status, "claimed");
    assert.equal(await progressStatus(), "in_progress");
    assert.notEqual((await progress(other)).statusCode, HTTP_OK);
    await repo.failAiWorkflowJob({ jobId: claim.job.id, error: SNAPSHOT_FAILURE_MESSAGE });
    assert.equal(await progressStatus(), "failed");
    await repo.upsertSummaryForMeeting({ meetingId: f.meeting.id, content: GENERATED_SUMMARY, model: "gpt-5" });
    assert.equal(await progressStatus(), "done");
  });

  await t.test("an entitled host opening a credit-blocked meeting regenerates its notes on their own", async () => {
    const owner = await user(),
      f = await meeting({ user: owner });
    await finish({ id: f.meeting.id, user: owner, shouldWriteSummary: false });
    await repo.upsertSummaryForMeeting({
      meetingId: f.meeting.id,
      content: CREDIT_BLOCKED_FIXTURE_SUMMARY,
      model: FALLBACK_FIXTURE_MODEL,
    });
    await repo.createCreditGrant({ userId: owner.id, source: "promotional", credits: PROMOTIONAL_CREDIT_GRANT });
    const opened = await app.inject({ url: `/meetings/${f.meeting.id}/notes-view`, headers: headers({ user: owner }) });
    assert.equal(opened.statusCode, HTTP_OK, opened.body);
    assert.notEqual(await waitForSummaryModelChange({ meetingId: f.meeting.id, from: FALLBACK_FIXTURE_MODEL }), null);
    assert.equal((await repo.getSummaryForMeeting(f.meeting.id))?.content, GENERATED_SUMMARY);
  });
}

/** Prices notes runs like production, so a run needs more than one credit; returns that minimum. */
function useDefaultNotesRunPricing(tt: TestContext): number {
  const previousPrices = apiEnv.OPENAI_MODEL_PRICES_JSON;
  const previousModel = apiEnv.OPENAI_MEETING_SNAPSHOT_MODEL;
  tt.after(() => {
    apiEnv.OPENAI_MODEL_PRICES_JSON = previousPrices;
    apiEnv.OPENAI_MEETING_SNAPSHOT_MODEL = previousModel;
  });
  apiEnv.OPENAI_MODEL_PRICES_JSON = DEFAULT_OPENAI_MODEL_PRICES_JSON;
  apiEnv.OPENAI_MEETING_SNAPSHOT_MODEL = DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL;

  return minimumNotesRunCredits({
    outputPerMillion: parseOpenAIModelPrices(DEFAULT_OPENAI_MODEL_PRICES_JSON)[DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL]
      ?.outputPerMillion,
    plan: "pro",
  });
}

async function runCriticalRegressionUnrelatedHoldTests(input: { t: TestContext; harness: CriticalRegressionHarness }) {
  const { t, harness } = input;
  const { user, meeting, finish, access } = harness;

  await t.test("another meeting's run in flight does not unlock a credit-blocked meeting's notes", async (tt) => {
    const minimum = useDefaultNotesRunPricing(tt);
    const owner = await user(),
      blocked = await meeting({ user: owner }),
      other = await meeting({ user: owner });
    await finish({ id: blocked.meeting.id, user: owner, shouldWriteSummary: false });
    await repo.upsertSummaryForMeeting({
      meetingId: blocked.meeting.id,
      content: CREDIT_BLOCKED_FIXTURE_SUMMARY,
      model: FALLBACK_FIXTURE_MODEL,
    });
    await repo.updateUserPlan({ userId: owner.id, plan: "pro" });
    await repo.updateWorkspacePlan({ workspaceId: owner.workspaceId, plan: "pro" });
    await repo.createWorkspaceCreditGrant({ workspaceId: owner.workspaceId, source: "credit_topup", credits: minimum });
    const holdEverything = {
      userId: owner.id,
      workspaceId: owner.workspaceId,
      maximumCostMicroUsd: Math.round(minimum * CREDIT_PRICE_MICRO_USD * (1 - PLAN_CREDITS.pro.grossMargin)),
      isIncluded: false,
    };
    const otherRun = await repo.reservePlanCredits({ ...holdEverything, metadata: { meetingId: other.meeting.id } });
    assert.equal(otherRun.reservedCredits, minimum);
    assert.deepEqual(await access({ id: blocked.meeting.id, user: owner }), {
      /** @external meeting notes access payload */
      locked: true,
      reason: "credits_required",
    });
    await repo.releasePlanCredits({ userId: owner.id, workspaceId: owner.workspaceId, reservationId: otherRun.id });
    await repo.reservePlanCredits({ ...holdEverything, metadata: { meetingId: blocked.meeting.id } });
    assert.equal((await access({ id: blocked.meeting.id, user: owner })).locked, false);
  });
}

async function runCriticalRegressionCreditBlockedAccessTests(input: {
  t: TestContext;
  harness: CriticalRegressionHarness;
}) {
  const { t, harness } = input;
  const { app, user, meeting, finish, access, guestFixture } = harness;

  await t.test("a credit-blocked paid meeting stays locked until the host can afford a notes run", async (tt) => {
    const minimum = useDefaultNotesRunPricing(tt);
    assert.ok(minimum > 1, "the default notes model should need more than one credit per run");
    const owner = await user(),
      f = await meeting({ user: owner });
    await finish({ id: f.meeting.id, user: owner, shouldWriteSummary: false });
    await repo.upsertSummaryForMeeting({
      meetingId: f.meeting.id,
      content: CREDIT_BLOCKED_FIXTURE_SUMMARY,
      model: FALLBACK_FIXTURE_MODEL,
    });
    await repo.updateUserPlan({ userId: owner.id, plan: "pro" });
    await repo.updateWorkspacePlan({ workspaceId: owner.workspaceId, plan: "pro" });
    await repo.createWorkspaceCreditGrant({
      workspaceId: owner.workspaceId,
      source: "credit_topup",
      credits: minimum - 1,
    });
    assert.deepEqual(await access({ id: f.meeting.id, user: owner }), {
      /** @external meeting notes access payload */
      locked: true,
      reason: "credits_required",
    });
    await repo.createWorkspaceCreditGrant({ workspaceId: owner.workspaceId, source: "credit_topup", credits: 1 });
    assert.equal((await access({ id: f.meeting.id, user: owner })).locked, false);
  });

  await t.test("guests of a credit-blocked meeting get a neutral status, not the host's billing prompt", async () => {
    const host = await user(),
      f = await meeting({ user: host });
    await repo.markMeetingActive(f.meeting.id);
    const g = await guestFixture({ host, fixture: f, isAdmitted: true });
    await finish({ id: f.meeting.id, user: host, shouldWriteSummary: false });
    await repo.upsertSummaryForMeeting({
      meetingId: f.meeting.id,
      content: CREDIT_BLOCKED_FIXTURE_SUMMARY,
      model: FALLBACK_FIXTURE_MODEL,
    });
    const response = await app.inject({ url: `/meetings/${f.meeting.id}/guest-notes`, headers: g.headers });
    assert.equal(response.statusCode, HTTP_OK, response.body);
    const body = parseInjectBody({ body: response.body, schema: guestNotesResponseSchema });
    assert.equal(body.notesAccess.locked, false);
    const content = body.summary?.content ?? "";
    assert.match(content, /aren't available yet/);
    assert.doesNotMatch(content, /Add credits|Generate notes/);
  });

  await t.test("guests see notes only when the host can, and never the host's billing prompt", async () => {
    const host = await user(),
      f = await meeting({ user: host });
    await repo.markMeetingActive(f.meeting.id);
    const g = await guestFixture({ host, fixture: f, isAdmitted: true });
    await finish({ id: f.meeting.id, user: host });
    await exhaustFixtureNotesEntitlement(host.id);
    const response = await app.inject({ url: `/meetings/${f.meeting.id}/guest-notes`, headers: g.headers });
    assert.equal(response.statusCode, HTTP_OK);
    const body = parseInjectBody({ body: response.body, schema: guestNotesResponseSchema });
    assert.equal(body.notesAccess.locked, true);
    assert.equal(body.summary, null);
  });
}

async function runNotesViewTests(input: { t: TestContext; harness: CriticalRegressionHarness }) {
  const { t, harness } = input;
  await t.test("notes view preserves access and never reads transcript content or secondary documents", async (t) => {
    const owner = await harness.user();
    const outsider = await harness.user();
    const fixture = await harness.meeting({ user: owner });
    const guest = await harness.guestFixture({ host: owner, fixture, isAdmitted: true });
    await harness.finish({ id: fixture.meeting.id, user: owner });
    const port = repositories();
    const forbiddenReads = [
      "getTranscriptForMeeting",
      "listVoiceWebResearchRunsForMeeting",
      "listMeetingResearchRunsForMeeting",
      "getLatestLinearTaskReviewForMeeting",
    ] as const;
    forbiddenReads.forEach((method) => {
      t.mock.method(port, method, async () => {
        throw new Error(SECONDARY_CONTENT_READ_FAILURE);
      });
    });
    const path = `/meetings/${fixture.meeting.id}/notes-view`;
    const summaryRead = t.mock.method(port, "getSummaryForMeeting");
    const response = await harness.app.inject({ url: path, headers: harness.headers({ user: owner }) });
    assert.equal(response.statusCode, HTTP_OK, response.body);
    assert.equal(summaryRead.mock.callCount(), 1);
    const notes = meetingNotesViewResponseSchema.parse(response.json());
    assert.equal(notes.summary?.content, "Saved notes");
    assert.equal(notes.hasTranscriptSegments, true);
    assert.equal(notes.transcript?.isFinal, true);
    z.object({ transcriptSegments: z.never().optional(), researchRuns: z.never().optional() }).parse(response.json());
    const guestResponse = await harness.app.inject({ url: path, headers: guest.headers });
    assert.equal(guestResponse.statusCode, HTTP_OK, guestResponse.body);
    const guestNotes = meetingNotesViewResponseSchema.parse(guestResponse.json());
    assert.equal(guestNotes.summary, null);
    assert.equal(guestNotes.tasks, null);
    assert.equal(guestNotes.notesAccess.reason, "signup_required");
    assert.equal((await harness.app.inject({ url: path })).statusCode, HTTP_UNAUTHORIZED);
    assert.equal(
      (await harness.app.inject({ url: path, headers: harness.headers({ user: outsider }) })).statusCode,
      HTTP_FORBIDDEN,
    );
    assert.equal(
      (
        await harness.app.inject({
          url: `/meetings/${randomUUID()}/notes-view`,
          headers: harness.headers({ user: owner }),
        })
      ).statusCode,
      HTTP_NOT_FOUND,
    );
    await exhaustFixtureNotesEntitlement(owner.id);
    const lockedResponse = await harness.app.inject({ url: path, headers: harness.headers({ user: owner }) });
    const locked = meetingNotesViewResponseSchema.parse(lockedResponse.json());
    assert.equal(locked.notesAccess.locked, true);
    assert.equal(locked.summary, null);
    assert.equal(locked.tasks, null);
  });
}

async function runCriticalAuthorizationAndTrialRegressions(t: TestContext) {
  const { app, providerCalls, trackFixtureUser } = await registerCriticalRegressionFastifyApp({ t });
  const harness = createCriticalRegressionHarness({ app, providerCalls, trackFixtureUser });
  await runNotesViewTests({ t, harness });
  await runCriticalRegressionMeetingEndTests({ t, harness });
  await runCriticalRegressionAgentToolTests({ t, harness });
  await runCriticalRegressionLockedNotesTests({ t, harness });
  await runCriticalRegressionWorkspaceViewerTests({ t, harness });
  await runCriticalRegressionSummaryReuseTests({ t, harness });
  await runCriticalRegressionSuggestedActionsActiveMeetingTests({ t, harness });
  await runCriticalRegressionGuestConversionTests({ t, harness });
  await runCriticalRegressionTrialAllocationTests({ t, harness });
  await runCriticalRegressionTrialConsumptionTests({ t, harness });
  await runCriticalRegressionFallbackNotesTests({ t, harness });
  await runCriticalRegressionCreditBlockedAccessTests({ t, harness });
  await runCriticalRegressionUnrelatedHoldTests({ t, harness });
}

void test(
  "critical authorization and trial regressions",
  { skip: process.env.READYMEET_ISOLATED_DB !== "1" },
  async (t) => {
    await runCriticalAuthorizationAndTrialRegressions(t);
  },
);
