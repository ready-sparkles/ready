import "../../composition/wire";
import "../../adapters/secondary/node/env";

import { closeDbPool } from "@readymeet/db";
import { MEMORY_MODEL_TIMEOUT_MS } from "@readymeet/shared";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, beforeEach } from "node:test";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";

import { openAIMemoryFetch } from "../../adapters/secondary/undici/memory-fetch";
import { createMemoryModelRunner } from "../../application/relationship-memory";
import { assistantEnv } from "../../ports/assistant-env";
import { configureMemoryFetch } from "../../ports/memory-fetch";
import { repositories } from "../../ports/repository-runtime";
import { gatewayTextResponse, mockAssistantUsageMetering } from "../usage-metering-fixture";

after(closeDbPool);

const authorization = {
  jobId: "job",
  leaseToken: "lease",
  ownerUserId: "owner",
  meetingId: "fixture",
};
const RELATIONSHIP_MEMORY_TEST_MESSAGES = {
  fixtureInstructions: "fixture instructions",
  fixtureTranscript: "fixture",
  fixturePrompt: "fixture",
  fixtureMeetingId: "fixture",
  fixtureUtf8Transcript: "Päivä, Personqa Personrf 👋",
  mustNotContactProvider: "Must not contact provider",
  memoryWorkerDisconnected: "Memory worker disconnected",
  privateDatabaseError: "private database error must not appear in logs",
  fixtureModelOutputJson: '{"isSuccessful":true}',
  previousTwoMinuteLimitGone: "the previous two-minute limit is gone",
  failedRequestNeverRetried: "a failed request is never retried",
  expectedRecordedContentLength: "Expected recorded content length",
} as const;

const RELATIONSHIP_MEMORY_TEST_TIMER_ELAPSED_MS = 300_000;

const memoryFixtureSuccessSchema = z.object({ isSuccessful: z.boolean() });

function createCallCounter() {
  return { count: 0 };
}

function requiredAbortSignal(signal: AbortSignal | null | undefined) {
  assert.ok(signal !== undefined && signal !== null, "Expected fetch abort signal");

  return signal;
}

function requiredAt<T>(input: { items: readonly T[]; index: number; message: string }): T {
  const value = input.items.at(input.index);
  assert.ok(value !== undefined, input.message);

  return value;
}

const openAiMemoryRequestBodySchema = z.object({
  promptCacheOptions: z.object({ mode: z.literal("explicit") }).optional(),
  promptCacheRetention: z.literal("in_memory").optional(),
  previous_response_id: z.undefined().optional(),
  store: z.boolean(),
});

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

const openAiMemoryUserRequestBodySchema = openAiMemoryRequestBodySchema.extend({
  input: z.array(
    z.object({
      role: z.string(),
      content: openAiInputContentSchema,
    }),
  ),
});

const openAiParsedUserContentSchema = z.object({
  input: z.array(
    z.object({
      content: openAiInputContentSchema,
    }),
  ),
});

beforeEach((t) => {
  if (!("mock" in t)) {
    return;
  }
  mockAssistantUsageMetering(t);
  t.mock.method(repositories(), "consumeMemoryGeneration", async () => undefined);
});

(
  [
    ["gpt-5.6-sol", true],
    ["gpt-5.6", true],
    ["gpt-5.6-sol-2026-09-01", true],
    ["gpt-6-astra", true],
    ["gpt-5.5", false],
    ["gpt-5.4-mini", false],
  ] as const
).forEach(([model, shouldUseExplicitCachePolicy]) => {
  void test(`memory requests serialize the supported cache policy for ${model}`, async (t) => {
    const previousKey = assistantEnv().AI_GATEWAY_API_KEY;
    const previousModel = assistantEnv().OPENAI_MEMORY_MODEL;
    assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
    assistantEnv().OPENAI_MEMORY_MODEL = model;
    t.after(() => {
      assistantEnv().AI_GATEWAY_API_KEY = previousKey;
      assistantEnv().OPENAI_MEMORY_MODEL = previousModel;
    });
    const requestState = { items: [] as Record<string, unknown>[] };
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      const rawBody = options.body;
      const bodyText = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
      const requestBody = z
        .object({ providerOptions: z.object({ openai: openAiMemoryRequestBodySchema }) })
        .parse(JSON.parse(bodyText));
      const body = openAiMemoryRequestBodySchema.parse(requestBody.providerOptions.openai);
      requestState.items = [...requestState.items, body];
      assert.equal(new Headers(options.headers).get("ai-language-model-id"), `openai/${model}`);
      assert.deepEqual(body.promptCacheOptions, shouldUseExplicitCachePolicy ? { mode: "explicit" } : undefined);
      assert.equal(body.promptCacheRetention, model === "gpt-5.4-mini" ? "in_memory" : undefined);
      assert.equal(JSON.stringify(body).includes("prompt_cache_breakpoint"), false);
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.store, false);

      return new Response(
        JSON.stringify(gatewayTextResponse(RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureModelOutputJson)),
        { headers: { "content-type": "application/json" } },
      );
    });
    const runner = createMemoryModelRunner({
      authorization,
    });
    const operation = "relationship_meeting";
    const result = await runner.run({
      prompt: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureInstructions,
      payload: { transcript: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureTranscript },
      schema: memoryFixtureSuccessSchema,
      name: operation,
      meetingId: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureMeetingId,
    });
    assert.deepEqual(result.value, { isSuccessful: true });
    assert.equal(requestState.items.length, 1, "memories and summaries share one request");
  });
});

void test("actual SDK requests reach a local server with correct UTF-8 content length", async (t) => {
  const assistantEnvRestore = {
    openAiApiKey: assistantEnv().AI_GATEWAY_API_KEY,
    openAiMemoryModel: assistantEnv().OPENAI_MEMORY_MODEL,
  };
  t.after(() => {
    assistantEnv().AI_GATEWAY_API_KEY = assistantEnvRestore.openAiApiKey;
    assistantEnv().OPENAI_MEMORY_MODEL = assistantEnvRestore.openAiMemoryModel;
    configureMemoryFetch(openAIMemoryFetch);
  });
  assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
  assistantEnv().OPENAI_MEMORY_MODEL = "gpt-5.6-sol";
  const bodyState = { items: [] as Buffer<ArrayBufferLike>[], lengths: [] as string[] };
  const server = createServer((request, response) => {
    const partState = { items: [] as Buffer<ArrayBufferLike>[] };
    request.on("data", (part: Buffer | string) => {
      const chunk = typeof part === "string" ? Buffer.from(part, "utf8") : part;
      partState.items = [...partState.items, chunk];
    });
    request.on("end", () => {
      bodyState.items = [...bodyState.items, Buffer.concat(partState.items)];
      bodyState.lengths = [...bodyState.lengths, String(request.headers["content-length"])];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(gatewayTextResponse(RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureModelOutputJson)));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        assert.ok(address !== null && typeof address !== "string");
        configureMemoryFetch((_url, init) =>
          openAIMemoryFetch(`http://127.0.0.1:${address.port}/v4/ai/language-model`, init),
        );
        resolve();
      });
    });
    const runner = createMemoryModelRunner({
      authorization,
    });
    const operation = "relationship_meeting";
    assert.deepEqual(
      (
        await runner.run({
          prompt: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixturePrompt,
          payload: { transcript: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureUtf8Transcript },
          schema: memoryFixtureSuccessSchema,
          name: operation,
          meetingId: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureMeetingId,
        })
      ).value,
      { isSuccessful: true },
    );
    assert.equal(bodyState.items.length, 1);
    bodyState.items.forEach((body, index) => {
      const length = requiredAt({
        items: bodyState.lengths,
        index,
        message: RELATIONSHIP_MEMORY_TEST_MESSAGES.expectedRecordedContentLength,
      });
      assert.equal(Number(length), body.byteLength);
      const gateway = z
        .object({
          providerOptions: z.object({ openai: openAiMemoryRequestBodySchema }),
          prompt: openAiMemoryUserRequestBodySchema.shape.input,
        })
        .parse(JSON.parse(body.toString("utf8")));
      const parsed = openAiMemoryUserRequestBodySchema.parse({
        ...gateway.providerOptions.openai,
        input: gateway.prompt,
      });
      const userContent = openAiInputText(openAiParsedUserContentSchema.parse(parsed).input[1]?.content);
      assert.match(userContent, /Päivä, Personqa Personrf 👋/u);
      assert.deepEqual(parsed.promptCacheOptions, { mode: "explicit" });
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

void test("disconnected memory worker cancels the model and cannot start another paid call", async (t) => {
  const previousKey = assistantEnv().AI_GATEWAY_API_KEY;
  assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
  t.after(() => {
    assistantEnv().AI_GATEWAY_API_KEY = previousKey;
  });
  const controller = new AbortController();
  const calls = createCallCounter();
  const modelSignalState: { value: AbortSignal | null } = { value: null };
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls.count += 1;
    modelSignalState.value = requiredAbortSignal(options.signal);
    const modelSignal = modelSignalState.value;

    return new Promise<Response>((_resolve, reject) => {
      modelSignal.addEventListener("abort", () => reject(modelSignal.reason), { once: true });
    });
  });
  const runner = createMemoryModelRunner({
    authorization,
    signal: controller.signal,
  });
  const pending = assert.rejects(
    runner.run({
      prompt: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixturePrompt,
      payload: {},
      schema: z.object({}),
      name: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixturePrompt,
      meetingId: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureMeetingId,
    }),
    /disconnected/,
  );
  await setImmediate();
  controller.abort(new Error(RELATIONSHIP_MEMORY_TEST_MESSAGES.memoryWorkerDisconnected));
  await pending;
  assert.equal(modelSignalState.value?.aborted, true);
  await assert.rejects(
    runner.run({
      prompt: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixturePrompt,
      payload: {},
      schema: z.object({}),
      name: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixturePrompt,
      meetingId: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureMeetingId,
    }),
    /disconnected/,
  );
  assert.equal(calls.count, 1);
});

(["headers", "body"] as const).forEach((phase) => {
  void test(`memory model waits ten minutes and aborts stalled ${phase} without hidden retries`, async (t) => {
    const previousKey = assistantEnv().AI_GATEWAY_API_KEY;
    assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
    t.after(() => {
      assistantEnv().AI_GATEWAY_API_KEY = previousKey;
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = createCallCounter();
    const signalState: { value: AbortSignal | null } = { value: null };
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit & { dispatcher?: unknown }) => {
      calls.count += 1;
      assert.ok(options.dispatcher !== undefined);
      signalState.value = requiredAbortSignal(options.signal);
      const signal = signalState.value;
      if (phase === "headers") {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const rejected = assert.rejects(
      createMemoryModelRunner({
        authorization,
      }).run({
        prompt: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixturePrompt,
        payload: {},
        schema: memoryFixtureSuccessSchema,
        name: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixturePrompt,
        meetingId: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureMeetingId,
      }),
      /abort|timeout/i,
    );
    await setImmediate();
    t.mock.timers.tick(RELATIONSHIP_MEMORY_TEST_TIMER_ELAPSED_MS);
    const activeSignal = signalState.value;
    assert.ok(activeSignal);
    assert.equal(activeSignal.aborted, false, RELATIONSHIP_MEMORY_TEST_MESSAGES.previousTwoMinuteLimitGone);
    t.mock.timers.tick(MEMORY_MODEL_TIMEOUT_MS - RELATIONSHIP_MEMORY_TEST_TIMER_ELAPSED_MS - 1);
    assert.equal(activeSignal.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(calls.count, 1, RELATIONSHIP_MEMORY_TEST_MESSAGES.failedRequestNeverRetried);
  });
});

void test("model result waits for settlement and fails closed without a second provider call", async (t) => {
  const oldKey = assistantEnv().AI_GATEWAY_API_KEY;
  assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
  t.after(() => {
    assistantEnv().AI_GATEWAY_API_KEY = oldKey;
  });
  const calls = createCallCounter();
  const meterCalls = createCallCounter();
  const failMeterState: { finish: ((error: Error) => void) | null } = { finish: null };
  t.mock.method(repositories(), "consumeMemoryGeneration", async () => undefined);
  t.mock.method(repositories(), "getMeetingById", async () => ({
    id: authorization.meetingId,
    title: "Fixture",
    roomName: "fixture-room",
    meetingLinkId: null,
    instanceNumber: 1,
    workspaceId: "workspace",
    createdByUserId: authorization.ownerUserId,
    kind: "standard",
    status: "ended",
    isConfidential: false,
    confidentialitySource: null,
    confidentialityUpdatedByUserId: null,
    confidentialityUpdatedAt: null,
    createdAt: new Date(0),
    startedAt: null,
    endedAt: null,
    hiddenFromHistoryAt: null,
    hiddenFromHistoryReason: null,
  }));
  t.mock.method(repositories(), "recordUsageEvent", async () => {
    meterCalls.count += 1;

    return new Promise((_resolve, reject) => {
      failMeterState.finish = reject;
    });
  });
  const warningState = { items: [] as unknown[][] };
  t.mock.method(console, "error", (...args: unknown[]) => {
    warningState.items = [...warningState.items, args];
  });
  t.mock.method(globalThis, "fetch", async () => {
    calls.count += 1;

    return new Response(JSON.stringify(gatewayTextResponse(RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureModelOutputJson)), {
      headers: { "content-type": "application/json" },
    });
  });
  const result = createMemoryModelRunner({ authorization }).run({
    prompt: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixturePrompt,
    payload: {},
    schema: memoryFixtureSuccessSchema,
    name: "relationship_meeting",
    meetingId: RELATIONSHIP_MEMORY_TEST_MESSAGES.fixtureMeetingId,
  });
  const resultState = { isFinished: false };
  const rejected = assert.rejects(
    (async () => {
      try {
        await result;
      } finally {
        resultState.isFinished = true;
      }
    })(),
    /usage settlement failed/,
  );
  await setImmediate();
  assert.equal(resultState.isFinished, false);
  assert.equal(calls.count, 1);
  assert.equal(meterCalls.count, 1);
  assert.ok(failMeterState.finish !== null);
  failMeterState.finish(new Error(RELATIONSHIP_MEMORY_TEST_MESSAGES.privateDatabaseError));
  await rejected;
  assert.equal(warningState.items.length, 0);
  assert.equal(calls.count, 1);
});
