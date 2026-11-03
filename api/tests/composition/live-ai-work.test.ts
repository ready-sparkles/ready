import { aiWorkflowJobViewSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { createLiveAiWorkRunner } from "../../application/live-ai-work";

const FAILURE_MESSAGE = "test failure";
const HTTP_OK = 200;
const now = new Date().toISOString();
const job = aiWorkflowJobViewSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  meetingId: "22222222-2222-4222-8222-222222222222",
  type: "track_meeting",
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

void test("acknowledges recorded live work while models are blocked and drains on service close", async () => {
  const state = { release: () => {}, hasRecorded: false, hasFinished: false, hasDrained: false };
  const markFinished = () => {
    state.hasFinished = true;
  };
  const blocked = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const runner = createLiveAiWorkRunner({
    create: async () => {
      state.hasRecorded = true;

      return job;
    },
    run: async (input) => {
      assert.equal(state.hasRecorded, true);
      assert.equal(input.job, job);
      await blocked;
      markFinished();

      return job;
    },
  });
  await runner.start({ meetingId: job.meetingId, type: job.type, logger: { info() {}, warn() {} } });
  assert.equal(state.hasFinished, false);
  const draining = (async () => {
    await runner.drain();
    state.hasDrained = true;
  })();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(state.hasDrained, false);
  state.release();
  await draining;
  assert.equal(state.hasFinished, true);
});

void test("failed recording rejects acknowledgement without starting models", async () => {
  const runner = createLiveAiWorkRunner({
    create: async () => {
      throw new Error(FAILURE_MESSAGE);
    },
    run: async () => {
      assert.fail("must record before starting");
    },
  });
  await assert.rejects(
    runner.start({ meetingId: job.meetingId, type: job.type, logger: { info() {}, warn() {} } }),
    /test failure/,
  );
});

void test("model failure is reported without failing an acknowledged transcript callback", async () => {
  const messages = { values: [] as string[] };
  const runner = createLiveAiWorkRunner({
    create: async () => job,
    run: async () => {
      throw new Error(FAILURE_MESSAGE);
    },
  });
  await runner.start({
    meetingId: job.meetingId,
    type: job.type,
    logger: {
      info() {},
      warn: (...args: [Record<string, unknown>, string]) => {
        messages.values = [...messages.values, args[1]];
      },
    },
  });
  await runner.drain();
  assert.equal(messages.values.length, 1);
  assert.doesNotMatch(messages.values[0] ?? "", /test failure/);
});

void test("internal live-work route acknowledges before model completion", async (t) => {
  const { default: Fastify } = await import("fastify");
  const { internalAiWorkRoutes } = await import("../../adapters/primary/http/routes/internal-ai-work");
  const { repositories } = await import("../../ports/repository-runtime");
  const { registerRequestWorkflowHandler } = await import("../../application/request-ai-workflow");
  const { apiEnv } = await import("../../composition/env");
  const state = { release: () => {}, hasFinished: false };
  const blocked = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const markFinished = () => {
    state.hasFinished = true;
  };
  const liveJob = { ...job, type: "detect_ambient_context" as const };
  t.mock.method(repositories(), "startAiWorkflowExecution", async () => liveJob);
  t.mock.method(repositories(), "completeAiWorkflowJob", async () => liveJob);
  registerRequestWorkflowHandler({
    type: "detect_ambient_context",
    handler: async () => {
      await blocked;
      markFinished();

      return {};
    },
  });
  const app = Fastify();
  await app.register(internalAiWorkRoutes);
  try {
    const result = await app.inject({
      method: "POST",
      url: "/internal/ai-work",
      headers: { "x-assistant-service-secret": apiEnv.ASSISTANT_SERVICE_SECRET },
      payload: { meetingId: job.meetingId, type: "detect_ambient_context" },
    });
    assert.equal(result.statusCode, HTTP_OK);
    assert.equal(state.hasFinished, false);
  } finally {
    state.release();
    await app.close();
  }
  assert.equal(state.hasFinished, true);
});
