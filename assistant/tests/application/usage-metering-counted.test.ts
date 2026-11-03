/* eslint-disable @typescript-eslint/no-magic-numbers -- Literal token/tariff examples make money assertions independently checkable. */
/* eslint-disable policy/named-parameters -- Mock create callbacks match the OpenAI responses API. */
import type { RepositoryPort } from "@readymeet/db/ports/repository";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";

import { createOpenAIClient } from "../../adapters/secondary/openai/client";
import { withOpenAIRetry } from "../../adapters/secondary/openai/openai-retry";
import { executeMeteredOpenAIResponse } from "../../application/usage-metering";
import { assistantEnv, assistantEnvSchema, configureAssistantEnv } from "../../ports/assistant-env";
import type { OpenAIClient } from "../../ports/openai-client";
import { configureRepositoryPort } from "../../ports/repository-runtime";
import { mockAssistantUsageMetering } from "../usage-metering-fixture";

const MESSAGES = {
  unused: "Unused",
  insufficient: "Insufficient AI credits.",
  network: "network socket hang up",
  lease: "Invalid memory lease",
  rejected: "Rejected",
  invalidRequestCode: "invalid_request",
  invalidRequestType: "invalid_request_error",
  output: "OK",
};
const MODEL = "gpt-5.4-mini";
const body = { model: MODEL, input: [{ role: "user", content: "Hello" }], max_output_tokens: 32_000 };
const context = { meetingId: "meeting", source: "meeting_summary" };
const memoryAuthorization = { meetingId: "meeting", ownerUserId: "owner", jobId: "job", leaseToken: "lease" };
const countUrl = "https://api.openai.com/v1/responses/input_tokens";
const generationUrl = "https://api.openai.com/v1/responses";

configureAssistantEnv(
  assistantEnvSchema.parse({ DATABASE_URL: "postgres://localhost/not-used", ASSISTANT_SERVICE_SECRET: "test" }),
);
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Every method used is supplied by the isolated billing fixture.
configureRepositoryPort({} as RepositoryPort);

function countedFixture(t: TestContext) {
  const ledger = mockAssistantUsageMetering(t);
  assistantEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING = "free";
  const state = {
    count: 1000,
    inputUsage: 1000,
    outputUsage: 20,
    countStatus: 200,
    generationStatus: 200,
    shouldFailGenerationOnce: false,
    afterCount: async () => {},
  };
  const captured: { requests: { url: string; body: Record<string, unknown> }[] } = { requests: [] };
  const fetch = t.mock.fn<typeof globalThis.fetch>(async (url, init) => {
    const address = url instanceof Request ? url.url : url.toString();
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer configured-openai-key");
    assert.ok(typeof init?.body === "string");
    const request = z.record(z.unknown()).parse(JSON.parse(init.body));
    captured.requests = [...captured.requests, { url: address, body: request }];
    if (address === countUrl) {
      assert.equal(
        ledger.admission.mock.callCount(),
        captured.requests.filter((entry) => entry.url === generationUrl).length,
      );
      await state.afterCount();

      return Response.json(
        { object: "response.input_tokens", input_tokens: state.count },
        { status: state.countStatus },
      );
    }
    assert.equal(address, generationUrl);
    assert.ok(ledger.admission.mock.callCount() > 0);
    assert.equal(request.max_output_tokens, 32_000);
    if (state.shouldFailGenerationOnce) {
      state.shouldFailGenerationOnce = false;
      throw new Error(MESSAGES.network);
    }
    if (state.generationStatus !== 200) {
      return Response.json(
        { error: { code: MESSAGES.invalidRequestCode, type: MESSAGES.invalidRequestType, message: MESSAGES.rejected } },
        { status: state.generationStatus },
      );
    }

    return Response.json({
      id: `response-${captured.requests.length}`,
      status: "completed",
      output: [
        {
          type: "message",
          id: "message",
          role: "assistant",
          content: [{ type: "output_text", text: MESSAGES.output, annotations: [] }],
        },
      ],
      usage: { input_tokens: state.inputUsage, output_tokens: state.outputUsage },
    });
  });
  const client = createOpenAIClient({ apiKey: "configured-openai-key", fetch });
  const run = () => executeMeteredOpenAIResponse({ ...context, body, client });

  return {
    ...ledger,
    state,
    get requests() {
      return captured.requests;
    },
    fetch,
    client,
    run,
  };
}

void test("counted paid Pro fits 250 credits, preserves 32k output and persists exact bounds without Gateway key", async (t) => {
  const f = countedFixture(t);
  f.admission.mock.mockImplementation(async (input) => {
    // One credit is $0.01 of retail usage at 2x provider cost.
    assert.ok((z.number().parse(input.maximumCostMicroUsd) * 2) / 10_000 < 250);

    return { id: "reservation" };
  });
  const result = await f.run();
  assert.equal(result.output_text, "OK");
  assert.deepEqual(
    f.requests.map((entry) => entry.url),
    [countUrl, generationUrl],
  );
  const admission = f.admission.mock.calls[0];
  assert.ok(admission);
  assert.equal(admission.arguments[0].maximumCostMicroUsd, 966_250);
  const metadata = z.record(z.unknown()).parse(admission.arguments[0].metadata);
  assert.equal(metadata.inputTokens, 1000);
  assert.equal(metadata.maxOutputTokens, 32_000);
  assert.equal(f.usage.mock.calls[0]?.arguments[0].unitCount, 1020);
  assert.equal(f.credits.mock.calls[0]?.arguments[0].inputTokens, 1000);
  assert.equal(f.credits.mock.calls[0].arguments[0].providerCostMicroUsd, 5600);
});

void test("counted input over balance is denied after count but before generation", async (t) => {
  const f = countedFixture(t);
  f.state.count = 100_000;
  f.admission.mock.mockImplementation(async (input) => {
    assert.ok(z.number().parse(input.maximumCostMicroUsd) > 1_250_000);
    throw new Error(MESSAGES.insufficient);
  });
  await assert.rejects(f.run(), /Insufficient/);
  assert.deepEqual(
    f.requests.map((entry) => entry.url),
    [countUrl],
  );
  assert.equal(f.credits.mock.callCount(), 0);
});

void test("counted long-context admission uses highest cache rate and actual input tier", async (t) => {
  const f = countedFixture(t);
  assistantEnv().OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    [MODEL]: {
      maxContextTokens: 400_000,
      inputPerMillion: 2,
      cachedInputPerMillion: 3,
      cacheWritePerMillion: 2.5,
      outputPerMillion: 10,
      longContext: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    },
  });
  await f.run();
  assert.equal(f.admission.mock.calls[0]?.arguments[0].maximumCostMicroUsd, 323_000);
  f.state.count = 300_000;
  f.state.inputUsage = 300_000;
  await f.run();
  assert.equal(f.admission.mock.calls[1]?.arguments[0].maximumCostMicroUsd, 2_280_000);
});

void test("counted request snapshots body and billing identity before async lookup and reservation", async (t) => {
  const f = countedFixture(t);
  const mutable = { ...body, input: [{ role: "user", content: "Original" }] };
  const authorization = { ...memoryAuthorization };
  const consume = t.mock.fn(async () => undefined);
  f.port.consumeMemoryGeneration = consume;
  f.state.afterCount = async () => {
    mutable.input = [{ role: "user", content: "Mutated" }];
    mutable.max_output_tokens = 1;
    authorization.ownerUserId = "attacker";
    authorization.leaseToken = "changed";
  };
  await executeMeteredOpenAIResponse({
    ...context,
    memoryAuthorization: authorization,
    body: mutable,
    client: f.client,
  });
  assert.equal(f.admission.mock.calls[0]?.arguments[0].userId, "creator");
  assert.equal(consume.mock.callCount(), 0);
  const generation = f.requests[1]?.body;
  assert.match(JSON.stringify(generation?.input), /Original/);
  assert.doesNotMatch(JSON.stringify(generation?.input), /Mutated/);
  assert.equal(generation?.max_output_tokens, 32_000);
});

void test("abort after counted reservation releases hold and preserves no-dispatch marker through adapter", async (t) => {
  const f = countedFixture(t);
  const controller = new AbortController();
  f.admission.mock.mockImplementation(async () => {
    controller.abort();

    return { id: "reservation" };
  });
  await assert.rejects(
    executeMeteredOpenAIResponse({ ...context, body, client: f.client, options: { signal: controller.signal } }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(z.object({ isProviderRequestDispatched: z.literal(false) }).safeParse(error).success, true);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.name, "AbortError");

      return true;
    },
  );
  assert.equal(f.fetch.mock.callCount(), 1);
  assert.equal(f.release.mock.callCount(), 1);
});

void test("memory lease refusal blocks counting and generation", async (t) => {
  const f = countedFixture(t);
  assistantEnv().AI_GATEWAY_API_KEY = "mock-gateway";
  f.port.consumeMemoryGeneration = async () => {
    assert.equal(f.admission.mock.callCount(), 1);
    throw new Error(MESSAGES.lease);
  };
  await assert.rejects(
    executeMeteredOpenAIResponse({
      ...context,
      body,
      client: f.client,
      source: "relationship_memory",
      memoryAuthorization,
    }),
    /Invalid memory lease/,
  );
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.release.mock.callCount(), 1);
});

void test("abort during memory lease consumption prevents all provider requests", async (t) => {
  const f = countedFixture(t);
  assistantEnv().AI_GATEWAY_API_KEY = "mock-gateway";
  const controller = new AbortController();
  f.port.consumeMemoryGeneration = async () => {
    controller.abort();
  };
  await assert.rejects(
    executeMeteredOpenAIResponse({
      ...context,
      body,
      client: f.client,
      source: "relationship_memory",
      memoryAuthorization,
      options: { signal: controller.signal },
    }),
  );
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.release.mock.callCount(), 1);
});

void test("failed no-dispatch cleanup never retries provider or count", async (t) => {
  const f = countedFixture(t);
  assistantEnv().AI_GATEWAY_API_KEY = "mock-gateway";
  f.port.consumeMemoryGeneration = async () => {
    throw new Error(MESSAGES.lease);
  };
  f.release.mock.mockImplementation(async () => {
    throw new Error(MESSAGES.network);
  });
  await assert.rejects(
    withOpenAIRetry({
      baseDelayMs: 0,
      operation: () =>
        executeMeteredOpenAIResponse({
          ...context,
          body,
          client: f.client,
          source: "relationship_memory",
          memoryAuthorization,
        }),
    }),
    /settlement failed/,
  );
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.admission.mock.callCount(), 1);
  assert.equal(f.release.mock.callCount(), 1);
});

void test("each counted retry obtains fresh count and reservation; unknown generation retains hold", async (t) => {
  const f = countedFixture(t);
  f.state.shouldFailGenerationOnce = true;
  await withOpenAIRetry({ baseDelayMs: 0, operation: f.run });
  assert.deepEqual(
    f.requests.map((entry) => entry.url),
    [countUrl, generationUrl, countUrl, generationUrl],
  );
  assert.equal(f.admission.mock.callCount(), 2);
  const metadata = f.admission.mock.calls.map((call) => z.record(z.unknown()).parse(call.arguments[0].metadata));
  assert.notEqual(metadata[0]?.executionId, metadata[1]?.executionId);
  assert.equal(f.release.mock.callCount(), 0);
  assert.equal(f.credits.mock.callCount(), 1);
});

void test("counted settlement failure never retries count or provider", async (t) => {
  const f = countedFixture(t);
  f.credits.mock.mockImplementation(async () => {
    throw new Error(MESSAGES.network);
  });
  await assert.rejects(withOpenAIRetry({ baseDelayMs: 0, operation: f.run }), /settlement failed/);
  assert.equal(f.fetch.mock.callCount(), 2);
  assert.equal(f.admission.mock.callCount(), 1);
  assert.equal(f.release.mock.callCount(), 0);
});

(["inputUsage", "outputUsage"] as const).forEach((field) => {
  void test(`counted ${field} above bounds retains hold before raw usage or settlement`, async (t) => {
    const f = countedFixture(t);
    f.state[field] = field === "inputUsage" ? 1001 : 32_001;
    await assert.rejects(withOpenAIRetry({ baseDelayMs: 0, operation: f.run }), /settlement failed/);
    assert.equal(f.fetch.mock.callCount(), 2);
    assert.equal(f.usage.mock.callCount(), 0);
    assert.equal(f.credits.mock.callCount(), 0);
    assert.equal(f.release.mock.callCount(), 0);
  });
});

void test("malformed or failed counts and excessive context never reserve or generate", async (t) => {
  const f = countedFixture(t);
  f.state.count = 1.5;
  await assert.rejects(f.run());
  f.state.count = 1000;
  f.state.countStatus = 400;
  await assert.rejects(f.run());
  f.state.countStatus = 200;
  f.state.count = 1_050_001;
  await assert.rejects(f.run(), /bounds/);
  assert.ok(f.requests.every((entry) => entry.url === countUrl));
  assert.equal(f.admission.mock.callCount(), 0);
});

void test("counted invalid identity, rate, caps and modality refuse before count", async (t) => {
  const f = countedFixture(t);
  await Promise.all(
    [
      { ...body, model: "unknown" },
      { ...body, max_output_tokens: 0 },
      { ...body, tools: [{ type: "web_search" }] },
    ].map((invalidBody) =>
      assert.rejects(executeMeteredOpenAIResponse({ ...context, body: invalidBody, client: f.client })),
    ),
  );
  f.port.getWorkspaceMembership = async () => ({ status: "inactive" });
  await assert.rejects(f.run(), /Active workspace member/);
  assert.equal(f.fetch.mock.callCount(), 0);
});

void test("counted definite rejection releases but unknown outcomes keep hold", async (t) => {
  const f = countedFixture(t);
  f.state.generationStatus = 400;
  await assert.rejects(f.run(), /400/);
  assert.equal(f.release.mock.callCount(), 1);
  f.state.generationStatus = 503;
  await assert.rejects(f.run(), /503/);
  assert.equal(f.release.mock.callCount(), 1);
});

void test("missing callback execution cannot return success or charge", async (t) => {
  const f = countedFixture(t);
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => ({
    totalUsage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
  }));
  await assert.rejects(
    withOpenAIRetry({
      baseDelayMs: 0,
      operation: () => executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }),
    }),
    /settlement failed/,
  );
  assert.equal(create.mock.callCount(), 1);
  assert.equal(f.admission.mock.callCount(), 0);
  assert.equal(f.usage.mock.callCount(), 0);
  assert.equal(f.credits.mock.callCount(), 0);
});

void test("callback validates model and output before reservation and runs once", async (t) => {
  const f = countedFixture(t);
  await Promise.all(
    [
      { model: "other", inputTokens: 1000, maxOutputTokens: 32_000 },
      { model: MODEL, inputTokens: 1000, maxOutputTokens: 1 },
    ].map(async (bounds) => {
      const client: OpenAIClient = {
        responses: {
          create: async (_body, options) => {
            await options?.beforeProviderCall?.(bounds);

            return {};
          },
        },
      };
      await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }), /bounds/);
    }),
  );
  assert.equal(f.admission.mock.callCount(), 0);
  const client: OpenAIClient = {
    responses: {
      create: async (_body, options) => {
        const bounds = { model: MODEL, inputTokens: 1000, maxOutputTokens: 32_000 };
        await options?.beforeProviderCall?.(bounds);
        await options?.beforeProviderCall?.(bounds);

        return {};
      },
    },
  };
  await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }), /bounds/);
  assert.equal(f.admission.mock.callCount(), 1);
});

void test("count gate accepts only literal attestation and defaults unverified", () => {
  const env = { DATABASE_URL: "postgres://localhost/not-used", ASSISTANT_SERVICE_SECRET: "test" };
  assert.equal(assistantEnvSchema.parse(env).OPENAI_INPUT_TOKEN_COUNT_BILLING, "unverified");
  [true, false, "true", "false", "", "FREE"].forEach((value) => {
    assert.equal(assistantEnvSchema.safeParse({ ...env, OPENAI_INPUT_TOKEN_COUNT_BILLING: value }).success, false);
  });
});

void test("counted general requests retain default 16384 output cap and admission bounds", async (t) => {
  const f = countedFixture(t);
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async (requestBody, options) => {
    assert.equal(requestBody.max_output_tokens, 16_384);
    assert.equal(options?.inputTokenCountBilling, "free");
    assert.ok(options.beforeProviderCall);
    await options.beforeProviderCall({ model: MODEL, inputTokens: 1000, maxOutputTokens: 16_384 });

    return { totalUsage: { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 0 } };
  });
  await executeMeteredOpenAIResponse({
    ...context,
    body: { model: MODEL, input: body.input },
    client: { responses: { create } },
  });
  const admission = f.admission.mock.calls[0];
  assert.ok(admission);
  assert.equal(admission.arguments[0].maximumCostMicroUsd, 497_770);
  const metadata = z.record(z.unknown()).parse(admission.arguments[0].metadata);
  assert.equal(metadata.maxOutputTokens, 16_384);
  assert.equal(f.credits.mock.callCount(), 1);
});

void test("cancellation before count or during count never reserves or consumes memory lease", async (t) => {
  const f = countedFixture(t);
  const consume = t.mock.fn(async () => undefined);
  f.port.consumeMemoryGeneration = consume;
  const alreadyAborted = AbortSignal.abort();
  await assert.rejects(
    executeMeteredOpenAIResponse({ ...context, body, client: f.client, options: { signal: alreadyAborted } }),
  );
  assert.equal(f.fetch.mock.callCount(), 0);
  const controller = new AbortController();
  f.state.afterCount = async () => {
    controller.abort();
  };
  await assert.rejects(
    executeMeteredOpenAIResponse({
      ...context,
      body,
      client: f.client,
      memoryAuthorization,
      options: { signal: controller.signal },
    }),
  );
  assert.equal(f.fetch.mock.callCount(), 1);
  assert.equal(f.admission.mock.callCount(), 0);
  assert.equal(consume.mock.callCount(), 0);
  assert.equal(f.release.mock.callCount(), 0);
});
