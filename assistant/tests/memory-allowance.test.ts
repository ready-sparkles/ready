import "../composition/wire";

import { closeDbPool, db } from "@readymeet/db";
import { memoryFixture } from "@readymeet/db/testing/memory";
import Fastify, { type FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { internalRoutes } from "../adapters/primary/http/routes";
import { assistantEnv } from "../ports/assistant-env";
import { repositories } from "../ports/repository-runtime";

const MEMORY_ALLOWANCE_TEST_MESSAGES = {
  simulatedProviderFailure: "Simulated ambiguous provider failure",
  connectionLostAfterCommit: "Connection lost after commit",
  oldClientsNoAuthorization: "old clients have no authorization",
  ambiguousNetworkFailure: "ambiguous network failure cannot cause another paid attempt",
  liveKitStatusOk: "ok",
} as const;

const MEMORY_ALLOWANCE_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const MEMORY_ALLOWANCE_TEST_HTTP_STATUS_BAD_REQUEST = 400;
const MEMORY_ALLOWANCE_TEST_HTTP_STATUS_NOT_FOUND = 404;
const MEMORY_ALLOWANCE_TEST_EXPECTED_PROVIDER_CALLS = 0;
const MEMORY_ALLOWANCE_TEST_EXPECTED_SINGLE_PROVIDER_CALL = 1;
const MEMORY_ALLOWANCE_TEST_ACTIVE_MEETINGS = 0;

const MEMORY_ALLOWANCE_TEST_ASSERT_MESSAGES = {
  expectedClaimedJob: "Expected claimed memory job",
  expectedEnqueuedInput: "Expected enqueued memory input",
} as const;

const MEMORY_ALLOWANCE_TEST_LEGACY_PATHS = ["extract", "project"] as const;

function createCallCounter() {
  return { count: 0 };
}

async function readLedgerStartedAt(jobId: string): Promise<Date | null | undefined> {
  const rows = await db.memoryGenerationLedger.findMany({
    where: { jobId },
  });

  return rows[0]?.modelStartedAt;
}

function requireEnqueuedInput<Input extends object>(enqueued: { input?: Input | null }): Input {
  const { input } = enqueued;
  assert.ok(input !== undefined && input !== null, MEMORY_ALLOWANCE_TEST_ASSERT_MESSAGES.expectedEnqueuedInput);

  return input;
}

async function injectMemoryRoute(input: { app: FastifyInstance; body: Record<string, unknown>; path?: string }) {
  return input.app.inject({
    method: "POST",
    url: `/internal/memory/${input.path ?? "generate"}`,
    headers: { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET },
    payload: input.body,
  });
}

const FIXTURE_CACHE_WRITE_RATE = 1.25;
const FIXTURE_TIER_THRESHOLD_TOKENS = 272_000;
const FIXTURE_CONTEXT_TOKENS = 1_050_000;
after(closeDbPool);
beforeEach((t) => {
  if (!("mock" in t)) {
    return;
  }
  const prices = assistantEnv().OPENAI_MODEL_PRICES_JSON;
  const memoryModel = assistantEnv().OPENAI_MEMORY_MODEL?.trim() ?? "";
  const model = memoryModel !== "" ? memoryModel : assistantEnv().OPENAI_MEETING_SNAPSHOT_MODEL;
  assistantEnv().OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    [model]: {
      inputPerMillion: 1,
      outputPerMillion: 1,
      cacheWritePerMillion: FIXTURE_CACHE_WRITE_RATE,
      maxContextTokens: FIXTURE_CONTEXT_TOKENS,
      longContext: { thresholdTokens: FIXTURE_TIER_THRESHOLD_TOKENS, inputMultiplier: 1, outputMultiplier: 1 },
    },
  });
  t.after(() => {
    assistantEnv().OPENAI_MODEL_PRICES_JSON = prices;
  });
});
void test(
  "real assistant endpoint rejects duplicates and legacy endpoints before provider dispatch",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async (t) => {
    const assistantEnvRestore = { openAiApiKey: assistantEnv().AI_GATEWAY_API_KEY };
    assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
    t.after(() => {
      assistantEnv().AI_GATEWAY_API_KEY = assistantEnvRestore.openAiApiKey;
    });
    const f = await memoryFixture();
    const app = Fastify();
    try {
      const enqueued = await f.enqueue();
      const input = requireEnqueuedInput(enqueued);
      const job = enqueued.job;
      assert.ok(job);
      const calls = createCallCounter();
      t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (!String(url).includes("/v4/ai/language-model")) {
          return new Response(
            JSON.stringify({
              status: MEMORY_ALLOWANCE_TEST_MESSAGES.liveKitStatusOk,
              activeMeetings: MEMORY_ALLOWANCE_TEST_ACTIVE_MEETINGS,
            }),
          );
        }
        calls.count += 1;
        throw new Error(MEMORY_ALLOWANCE_TEST_MESSAGES.simulatedProviderFailure);
      });
      await app.register(internalRoutes);
      const payload = { ...input, history: [], jobId: job.id, leaseToken: job.leaseToken };
      assert.equal(
        (await injectMemoryRoute({ app, body: { ...payload, leaseToken: randomUUID() } })).statusCode,
        MEMORY_ALLOWANCE_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE,
      );
      assert.equal(calls.count, MEMORY_ALLOWANCE_TEST_EXPECTED_PROVIDER_CALLS);
      const results = await Promise.all([
        injectMemoryRoute({ app, body: payload }),
        injectMemoryRoute({ app, body: payload }),
        injectMemoryRoute({ app, body: payload }),
      ]);
      assert.ok(results.every((r) => r.statusCode === MEMORY_ALLOWANCE_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE));
      assert.equal(
        calls.count,
        MEMORY_ALLOWANCE_TEST_EXPECTED_SINGLE_PROVIDER_CALL,
        MEMORY_ALLOWANCE_TEST_MESSAGES.ambiguousNetworkFailure,
      );
      assert.equal(
        (await injectMemoryRoute({ app, body: payload })).statusCode,
        MEMORY_ALLOWANCE_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE,
      );
      assert.equal(calls.count, MEMORY_ALLOWANCE_TEST_EXPECTED_SINGLE_PROVIDER_CALL);
      assert.equal(
        (await injectMemoryRoute({ app, body: { ...input, history: [] } })).statusCode,
        MEMORY_ALLOWANCE_TEST_HTTP_STATUS_BAD_REQUEST,
        MEMORY_ALLOWANCE_TEST_MESSAGES.oldClientsNoAuthorization,
      );
      await Promise.all(
        MEMORY_ALLOWANCE_TEST_LEGACY_PATHS.map(async (path) => {
          const response = await injectMemoryRoute({ app, body: payload, path });
          assert.equal(response.statusCode, MEMORY_ALLOWANCE_TEST_HTTP_STATUS_NOT_FOUND);
        }),
      );
      assert.ok((await readLedgerStartedAt(job.id)) !== null);
    } finally {
      await app.close();
      await f.cleanup();
    }
  },
);

void test(
  "uncertain allowance commit makes zero provider calls and never restores the allowance",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async (t) => {
    const assistantEnvRestore = { openAiApiKey: assistantEnv().AI_GATEWAY_API_KEY };
    assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
    t.after(() => {
      assistantEnv().AI_GATEWAY_API_KEY = assistantEnvRestore.openAiApiKey;
    });
    const f = await memoryFixture(),
      app = Fastify();
    try {
      const enqueued = await f.enqueue();
      const input = requireEnqueuedInput(enqueued);
      const job = enqueued.job;
      assert.ok(job);
      const calls = createCallCounter();
      t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("/responses")) {
          calls.count += 1;
        }

        return new Response(
          JSON.stringify({
            status: MEMORY_ALLOWANCE_TEST_MESSAGES.liveKitStatusOk,
            activeMeetings: MEMORY_ALLOWANCE_TEST_ACTIVE_MEETINGS,
          }),
        );
      });
      const consume = repositories().consumeMemoryGeneration;
      const guard = t.mock.method(
        repositories(),
        "consumeMemoryGeneration",
        async (authorization: Parameters<typeof consume>[0]) => {
          await consume(authorization);
          throw new Error(MEMORY_ALLOWANCE_TEST_MESSAGES.connectionLostAfterCommit);
        },
      );
      await app.register(internalRoutes);
      const request = {
        method: "POST" as const,
        url: "/internal/memory/generate",
        headers: { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET },
        payload: { ...input, history: [], jobId: job.id, leaseToken: job.leaseToken },
      };
      assert.equal((await app.inject(request)).statusCode, MEMORY_ALLOWANCE_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE);
      guard.mock.restore();
      assert.equal((await app.inject(request)).statusCode, MEMORY_ALLOWANCE_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE);
      assert.equal(calls.count, MEMORY_ALLOWANCE_TEST_EXPECTED_PROVIDER_CALLS);
      assert.ok((await readLedgerStartedAt(job.id)) !== null);
    } finally {
      await app.close();
      await f.cleanup();
    }
  },
);

void test(
  "notes revoked after enqueue prevent provider dispatch and allowance consumption",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async (t) => {
    const assistantEnvRestore = { openAiApiKey: assistantEnv().AI_GATEWAY_API_KEY };
    assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
    t.after(() => {
      assistantEnv().AI_GATEWAY_API_KEY = assistantEnvRestore.openAiApiKey;
    });
    const f = await memoryFixture(),
      app = Fastify();
    try {
      const enqueued = await f.enqueue();
      const input = requireEnqueuedInput(enqueued);
      const job = enqueued.job;
      assert.ok(job);
      const calls = createCallCounter();
      await db.users.updateMany({ where: { id: f.userId }, data: { privateBetaProEnabledAt: null } });
      t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("/responses")) {
          calls.count += 1;
        }

        return new Response(
          JSON.stringify({
            status: MEMORY_ALLOWANCE_TEST_MESSAGES.liveKitStatusOk,
            activeMeetings: MEMORY_ALLOWANCE_TEST_ACTIVE_MEETINGS,
          }),
        );
      });
      await app.register(internalRoutes);
      const response = await app.inject({
        method: "POST",
        url: "/internal/memory/generate",
        headers: { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET },
        payload: { ...input, history: [], jobId: job.id, leaseToken: job.leaseToken },
      });
      assert.equal(response.statusCode, MEMORY_ALLOWANCE_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE);
      assert.equal(calls.count, MEMORY_ALLOWANCE_TEST_EXPECTED_PROVIDER_CALLS);
      assert.equal(await readLedgerStartedAt(job.id), null);
    } finally {
      await app.close();
      await f.cleanup();
    }
  },
);
