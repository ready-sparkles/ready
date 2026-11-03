import "../composition/wire";

import { InsufficientAiCreditsError } from "@readymeet/db/domain/persistence-errors";
import {
  INSUFFICIENT_CREDITS_CODE,
  MEETING_TASKS_PROMPT_VERSION,
  meetingTaskGenerationSchema,
} from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { internalRoutes } from "../adapters/primary/http/routes";
import { assistantEnv, configureAssistantEnv } from "../ports/assistant-env";
import { repositories } from "../ports/repository-runtime";

import { gatewayTextResponse, mockAssistantUsageMetering } from "./usage-metering-fixture";

const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const HTTP_PAYMENT_REQUIRED = 402;
const MEETING_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_MEETING_ID = "550e8400-e29b-41d4-a716-446655440001";
const UNEXPECTED_NETWORK_CALL_MESSAGE = "Unexpected network call";

const tasksResponseSchema = z.object({ tasks: meetingTaskGenerationSchema });
const currentTaskRequests = [
  { suffix: "", payload: {} },
  {
    suffix: "/chunk",
    payload: {
      title: "Weekly sync",
      chunkIndex: 0,
      totalChunks: 1,
      taskHintScore: 0,
      transcriptText: "No follow-up work today.",
    },
  },
  { suffix: "/reconcile", payload: { evidencePacket: {} } },
];

void test("retired live-task route is absent with or without the internal secret", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error(UNEXPECTED_NETWORK_CALL_MESSAGE);
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(internalRoutes);
  const url = `/internal/meetings/${MEETING_ID}/tasks/live`;
  assert.equal(app.hasRoute({ method: "POST", url }), false);
  await Promise.all(
    [{}, { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET }].map(async (headers) => {
      const response = await app.inject({ method: "POST", url, payload: {}, headers });
      assert.equal(response.statusCode, HTTP_NOT_FOUND);
    }),
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

void test("current task routes require the internal secret and validate requests before model calls", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error(UNEXPECTED_NETWORK_CALL_MESSAGE);
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(internalRoutes);
  await Promise.all(
    currentTaskRequests.map(async ({ suffix, payload }) => {
      const url = `/internal/meetings/${MEETING_ID}/tasks${suffix}`;
      await Promise.all(
        [{}, { "x-assistant-service-secret": "wrong-secret" }].map(async (headers) => {
          const response = await app.inject({ method: "POST", url, payload, headers });
          assert.equal(response.statusCode, HTTP_UNAUTHORIZED);
        }),
      );
      const headers = { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET };
      const invalidParams = await app.inject({
        method: "POST",
        url: `/internal/meetings/not-a-uuid/tasks${suffix}`,
        payload,
        headers,
      });
      assert.equal(invalidParams.statusCode, HTTP_BAD_REQUEST);
      const invalidBody = await app.inject({ method: "POST", url, payload: { metering: "invalid" }, headers });
      assert.equal(invalidBody.statusCode, HTTP_BAD_REQUEST);
    }),
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

void test("current task routes generate valid results for authorized requests", async (t) => {
  const env = assistantEnv();
  mockAssistantUsageMetering(t);
  configureAssistantEnv({ ...assistantEnv(), AI_GATEWAY_API_KEY: "test-key" });
  t.after(() => configureAssistantEnv(env));
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json(gatewayTextResponse(JSON.stringify({ items: [] }))),
  );
  const meetingLookup = t.mock.method(repositories(), "getMeetingById", async () => ({
    id: MEETING_ID,
    kind: "standard",
    createdByUserId: "creator",
    workspaceId: "host-workspace",
    title: "Weekly sync",
    startedAt: null,
    endedAt: null,
  }));
  t.mock.method(repositories(), "getTranscriptForMeeting", async () => ({ segments: [] }));
  t.mock.method(repositories(), "listParticipantsForMeeting", async () => []);
  t.mock.method(repositories(), "listVoiceSearchEvidenceForMeeting", async () => []);
  t.mock.method(repositories(), "readMeetingTracker", async () => ({
    revision: 0,
    items: [],
    updatedAt: null,
    status: "idle",
  }));
  const app = Fastify();
  t.after(() => app.close());
  await app.register(internalRoutes);
  await Promise.all(
    currentTaskRequests.map(async ({ suffix, payload }) => {
      const response = await app.inject({
        method: "POST",
        url: `/internal/meetings/${MEETING_ID}/tasks${suffix}`,
        payload: { ...payload, meetingId: OTHER_MEETING_ID },
        headers: { "x-assistant-service-secret": env.ASSISTANT_SERVICE_SECRET },
      });
      assert.equal(response.statusCode, HTTP_OK);
      const { tasks } = tasksResponseSchema.parse(response.json());
      assert.equal(tasks.taskModel, env.OPENAI_MEETING_TASKS_MODEL);
      assert.equal(tasks.taskPromptVersion, MEETING_TASKS_PROMPT_VERSION);
      assert.deepEqual(tasks.items, []);
    }),
  );
  assert.deepEqual(
    meetingLookup.mock.calls.map((call) => call.arguments),
    [[MEETING_ID], [MEETING_ID], [MEETING_ID], [MEETING_ID]],
  );
  assert.equal(fetchMock.mock.callCount(), currentTaskRequests.length);
});

["snapshot", "summarize"].forEach((suffix) => {
  void test(`${suffix} returns 402 for insufficient credits rather than 500`, async (t) => {
    const fixture = mockAssistantUsageMetering(t);
    const previousKey = assistantEnv().OPENAI_API_KEY;
    assistantEnv().OPENAI_API_KEY = "fixture";
    t.after(() => {
      assistantEnv().OPENAI_API_KEY = previousKey;
    });
    fixture.admission.mock.mockImplementation(async () => {
      throw new InsufficientAiCreditsError();
    });
    t.mock.method(repositories(), "getTranscriptForMeeting", async () => ({
      transcript: { id: "transcript", meetingId: MEETING_ID, source: "live", metadata: {}, createdAt: new Date(0) },
      segments: [],
    }));
    t.mock.method(repositories(), "readMeetingTracker", async () => ({
      revision: 0,
      items: [],
      updatedAt: null,
      status: "idle",
    }));
    t.mock.method(repositories(), "listParticipantsForMeeting", async () => []);
    t.mock.method(repositories(), "listVoiceSearchEvidenceForMeeting", async () => []);
    const app = Fastify();
    t.after(() => app.close());
    await app.register(internalRoutes);
    const response = await app.inject({
      method: "POST",
      url: `/internal/meetings/${MEETING_ID}/${suffix}`,
      headers: { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET },
      payload: {},
    });
    assert.equal(response.statusCode, HTTP_PAYMENT_REQUIRED, response.body);
    assert.equal(z.object({ code: z.string() }).parse(response.json()).code, INSUFFICIENT_CREDITS_CODE);
    assert.equal(fixture.admission.mock.callCount(), 1);
  });
});
