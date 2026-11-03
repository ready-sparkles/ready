/* eslint-disable @typescript-eslint/no-magic-numbers -- Literal token/tariff examples make money assertions independently checkable. */
import { InsufficientAiCreditsError } from "@readymeet/db/domain/persistence-errors";
import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  calculatePlanCredits,
  maximumOpenAITextInputTokens,
  MIN_CREDIT_FITTED_OUTPUT_TOKENS,
  MIN_NOTES_RUN_OUTPUT_TOKENS,
  minimumNotesRunCredits,
} from "@readymeet/shared";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createOpenAIClient as createRealOpenAIClient } from "../../adapters/secondary/openai/client";
import { withOpenAIRetry } from "../../adapters/secondary/openai/openai-retry";
import { creditFittedMaxOutputTokens, executeMeteredOpenAIResponse } from "../../application/usage-metering";
import { assistantEnv, assistantEnvSchema, configureAssistantEnv } from "../../ports/assistant-env";
import type { OpenAIClient } from "../../ports/openai-client";
import { configureRepositoryPort } from "../../ports/repository-runtime";
import { gatewayTextResponse, mockAssistantUsageMetering } from "../usage-metering-fixture";

const TEST_MESSAGES = {
  unused: "Unused",
  insufficient: "Insufficient AI credits.",
  network: "network socket hang up",
  invalidLease: "Invalid memory lease",
  rejected: "Rejected",
  gatewayError: "gateway_error",
  rejectedWithUsage: "Rejected after usage",
  invalidKey: "invalid_api_key",
  connectionReset: "ECONNRESET",
};

configureAssistantEnv(
  assistantEnvSchema.parse({
    DATABASE_URL: "postgres://localhost/not-used",
    ASSISTANT_SERVICE_SECRET: "test",
    AI_GATEWAY_API_KEY: "test",
  }),
);
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Every method used is supplied by the isolated billing fixture.
configureRepositoryPort({} as RepositoryPort);

const response = {
  id: "response",
  totalUsage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cacheWriteInputTokens: 10 },
};
const body = { model: "gpt-5.4-mini", input: [{ role: "user", content: "Hello" }] };
const context = { meetingId: "meeting", source: "meeting_summary" };

void test("zero balance prevents provider fetch", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.admission.mock.mockImplementation(async () => {
    throw new Error(TEST_MESSAGES.insufficient);
  });
  const fetch = t.mock.fn(async () => response);
  await assert.rejects(
    executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create: fetch } } }),
    /Insufficient/,
  );
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(fixture.credits.mock.callCount(), 0);
});

void test("workflow requester and attendee workspace reach Gateway; settles total usage once before parsing", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.workflow.meetingId = context.meetingId;
  fixture.workflow.context = { requester: { userId: "requester" } };
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => ({ ...response, output_text: "not JSON" }));
  await executeMeteredOpenAIResponse({
    ...context,
    source: "capability_workflow",
    workflowRunId: "workflow",
    body,
    client: { responses: { create } },
  });
  const sentBody = create.mock.calls[0]?.arguments[0] ?? {};
  assert.deepEqual(create.mock.calls[0]?.arguments[1]?.billing, {
    userId: "requester",
    workspaceId: "attendee-workspace",
    feature: "capability_workflow",
    gatewayApiKey: "test",
    maxInputTokens: maximumOpenAITextInputTokens(sentBody),
  });
  const firstCall = create.mock.calls[0];
  assert.notEqual(firstCall, undefined);
  assert.equal(firstCall.arguments[0].max_output_tokens, 16_384);
  assert.equal(fixture.admission.mock.calls[0]?.arguments[0].maximumCostMicroUsd, 517_858);
  assert.equal(fixture.credits.mock.callCount(), 1);
  assert.equal(fixture.credits.mock.calls[0]?.arguments[0].providerCostMicroUsd, 933);
  assert.equal(fixture.usage.mock.calls[0]?.arguments[0].userId, "requester");
});

void test("settlement network failure never retries provider or releases incurred cost", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.credits.mock.mockImplementation(async () => {
    throw new Error(TEST_MESSAGES.network);
  });
  const create = t.mock.fn(async () => response);
  await assert.rejects(
    withOpenAIRetry({
      baseDelayMs: 0,
      operation: () => executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }),
    }),
    /settlement failed/,
  );
  assert.equal(create.mock.callCount(), 1);
  assert.equal(fixture.admission.mock.callCount(), 1);
  assert.equal(fixture.release.mock.callCount(), 0);
});

void test("each outer provider retry reserves anew and retains unknown-outcome hold", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const calls = { count: 0 };
  const create = async () => {
    if (++calls.count === 1) {
      throw new Error(TEST_MESSAGES.network);
    }

    return response;
  };
  await withOpenAIRetry({
    baseDelayMs: 0,
    operation: () => executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }),
  });
  assert.equal(fixture.admission.mock.callCount(), 2);
  assert.equal(fixture.credits.mock.callCount(), 1);
  assert.equal(fixture.release.mock.callCount(), 0);
});

void test("missing context, tariff and unsupported modality fail before provider", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const create = t.mock.fn(async () => response);
  await Promise.all(
    [
      { ...body, model: "unknown" },
      { ...body, tools: [{ type: "web_search" }] },
      { ...body, service_tier: "priority" },
      { ...body, input: [{ role: "user", content: [{ type: "input_image", image_url: "data:" }] }] },
    ].map((badBody) =>
      assert.rejects(executeMeteredOpenAIResponse({ ...context, body: badBody, client: { responses: { create } } })),
    ),
  );
  assistantEnv().OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    "gpt-5.4-mini": { inputPerMillion: 1, outputPerMillion: 1 },
  });
  await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }));
  assert.equal(create.mock.callCount(), 0);
  assert.equal(fixture.admission.mock.callCount(), 0);
});

void test("models with automatic cache writes require their tariff before provider execution", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  assistantEnv().OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    "gpt-5.6-sol": { inputPerMillion: 4, outputPerMillion: 20, maxContextTokens: 128000 },
  });
  const create = t.mock.fn(async () => response);
  await assert.rejects(
    executeMeteredOpenAIResponse({
      ...context,
      body: { ...body, model: "gpt-5.6-sol" },
      client: { responses: { create } },
    }),
    /cache write tariff/,
  );
  assert.equal(create.mock.callCount(), 0);
  assert.equal(fixture.admission.mock.callCount(), 0);
});

void test("free hosted meetings and private beta are included; exhausted free and retired plans are refused", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const create = t.mock.fn(async () => response);
  const run = () => executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } });
  fixture.port.getWorkspaceById = async () => ({ plan: "free" });
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    /** @external member credit access contract */ subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  fixture.port.countOtherHostedTrialMeetings = async () => 2;
  await run();
  assert.equal(fixture.admission.mock.calls[0]?.arguments[0].isIncluded, true);
  fixture.port.countOtherHostedTrialMeetings = async () => 3;
  await assert.rejects(run(), InsufficientAiCreditsError);
  fixture.port.getWorkspaceById = async () => ({ plan: "pro" });
  fixture.port.hasPrivateBetaProCreditEntitlement = async () => true;
  await run();
  assert.equal(fixture.admission.mock.calls[1]?.arguments[0].isIncluded, true);
  fixture.port.getWorkspaceById = async () => ({ plan: "max" });
  fixture.port.hasPrivateBetaProCreditEntitlement = async () => false;
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    /** @external member credit access contract */ subscriptionActive: true,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  await run();
  assert.equal(fixture.admission.mock.calls[2]?.arguments[0].isIncluded, false);
  fixture.port.getWorkspaceById = async () => ({ plan: "business" });
  await assert.rejects(run(), InsufficientAiCreditsError);
  assert.equal(fixture.admission.mock.callCount(), 3);
  assert.equal(fixture.usage.mock.callCount(), 3);
});

void test("memory authorization validates owner after reservation and before dispatch", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const consume = t.mock.fn(async () => undefined);
  fixture.port.consumeMemoryGeneration = consume;
  const create = t.mock.fn(async () => response);
  await executeMeteredOpenAIResponse({
    ...context,
    source: "relationship_memory",
    memoryAuthorization: {
      meetingId: "meeting",
      ownerUserId: "memory-owner",
      jobId: "memory-job",
      leaseToken: "lease",
    },
    body,
    client: { responses: { create } },
  });
  assert.equal(consume.mock.callCount(), 1);
  assert.equal(fixture.admission.mock.calls[0]?.arguments[0].userId, "memory-owner");
});

void test("long-context reserves worst tier and settles actual tier with cache writes", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  assistantEnv().OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    "gpt-5.4-mini": {
      maxContextTokens: 400_000,
      inputPerMillion: 2,
      cachedInputPerMillion: 0.2,
      cacheWritePerMillion: 2.5,
      outputPerMillion: 10,
      longContext: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    },
  });
  assistantEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING = "free";
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async (_body, options) => {
    await options?.beforeProviderCall?.({ model: "gpt-5.4-mini", inputTokens: 300_000, maxOutputTokens: 32_000 });

    return {
      totalUsage: { inputTokens: 300_000, outputTokens: 100, cachedInputTokens: 10_000, cacheWriteInputTokens: 10_000 },
    };
  });
  await executeMeteredOpenAIResponse({
    ...context,
    body: { ...body, max_output_tokens: 32_000 },
    client: { responses: { create } },
  });
  assert.equal(fixture.admission.mock.calls[0]?.arguments[0].maximumCostMicroUsd, 1_980_000);
  assert.equal(fixture.credits.mock.calls[0]?.arguments[0].providerCostMicroUsd, 1_175_500);
});

void test("cross-meeting workflow and invalid memory authorization never reach provider", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const create = t.mock.fn(async () => response);
  await assert.rejects(
    executeMeteredOpenAIResponse({
      ...context,
      source: "capability_workflow",
      workflowRunId: "workflow",
      body,
      client: { responses: { create } },
    }),
    /Workflow/,
  );
  fixture.port.consumeMemoryGeneration = async () => {
    throw new Error(TEST_MESSAGES.invalidLease);
  };
  await assert.rejects(
    executeMeteredOpenAIResponse({
      ...context,
      source: "relationship_memory",
      memoryAuthorization: {
        meetingId: "meeting",
        ownerUserId: "other",
        jobId: "job",
        leaseToken: "invalid",
      },
      body,
      client: { responses: { create } },
    }),
    /Invalid memory lease/,
  );
  assert.equal(create.mock.callCount(), 0);
  assert.equal(fixture.admission.mock.callCount(), 1);
  assert.equal(fixture.release.mock.callCount(), 1);
});

void test("missing total usage retains hold and does not retry successful provider call", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const create = t.mock.fn(async () => ({ output_text: "unmeterable", usage: { input_tokens: 100 } }));
  await assert.rejects(
    withOpenAIRetry({
      baseDelayMs: 0,
      operation: () => executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }),
    }),
    /settlement failed/,
  );
  assert.equal(create.mock.callCount(), 1);
  assert.equal(fixture.credits.mock.callCount(), 0);
  assert.equal(fixture.release.mock.callCount(), 0);
});

void test("cancellation after reservation but before dispatch releases only that hold", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const controller = new AbortController();
  fixture.admission.mock.mockImplementation(async () => {
    controller.abort();

    return { id: "reservation" };
  });
  const create = t.mock.fn(async () => response);
  await assert.rejects(
    executeMeteredOpenAIResponse({
      ...context,
      body,
      options: { signal: controller.signal },
      client: { responses: { create } },
    }),
    { name: "AbortError" },
  );
  assert.equal(create.mock.callCount(), 0);
  assert.equal(fixture.release.mock.callCount(), 1);
});

void test("reservation denial prevents real transport fetch; admitted request settles real totalUsage", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const fetch = t.mock.fn<typeof globalThis.fetch>(async () =>
    Response.json(gatewayTextResponse("invalid domain JSON")),
  );
  const client = createRealOpenAIClient({ apiKey: "unused", fetch });
  fixture.admission.mock.mockImplementationOnce(async () => {
    throw new Error(TEST_MESSAGES.insufficient);
  });
  await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }), /Insufficient/);
  assert.equal(fetch.mock.callCount(), 0);
  const result = await executeMeteredOpenAIResponse({ ...context, body, client });
  assert.equal(result.output_text, "invalid domain JSON");
  assert.equal(fetch.mock.callCount(), 1);
  const url = fetch.mock.calls[0]?.arguments[0];
  assert.ok(url !== undefined);
  assert.match(url instanceof Request ? url.url : url.toString(), /ai-gateway.vercel.sh/);
  assert.equal(assistantEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING, "unverified");
  assert.equal(fixture.credits.mock.callCount(), 1);
  assert.equal(fixture.credits.mock.calls[0]?.arguments[0].providerCostMicroUsd, 1100);
});

void test("missing long-context tier refuses before reservation or fetch", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  assistantEnv().OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    "gpt-5.4-mini": {
      maxContextTokens: 400_000,
      inputPerMillion: 1,
      outputPerMillion: 1,
    },
  });
  const create = t.mock.fn(async () => response);
  await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }), /rate/);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(fixture.admission.mock.callCount(), 0);
});

void test("documented mixed text/transcription tariffs admit the selected paid text model", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  const prices = example.split("\n").find((line) => line.startsWith("OPENAI_MODEL_PRICES_JSON="));
  assert.ok(prices !== undefined);
  assistantEnv().OPENAI_MODEL_PRICES_JSON = prices.slice("OPENAI_MODEL_PRICES_JSON=".length);
  const fetch = t.mock.fn(async () => Response.json(gatewayTextResponse("OK")));
  const client = createRealOpenAIClient({ apiKey: "unused", fetch });
  await executeMeteredOpenAIResponse({ ...context, body, client });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fixture.admission.mock.callCount(), 1);
  assert.equal(fixture.credits.mock.calls[0]?.arguments[0].providerCostMicroUsd, 165);
});

["free", "beta"].forEach((entitlement) => {
  void test(`${entitlement} preserves unpriced access with default empty pricing and no customer settlement`, async (t) => {
    const fixture = mockAssistantUsageMetering(t);
    assistantEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING = "free";
    assistantEnv().OPENAI_MODEL_PRICES_JSON = assistantEnvSchema.parse({
      DATABASE_URL: "postgres://localhost/not-used",
      ASSISTANT_SERVICE_SECRET: "test",
    }).OPENAI_MODEL_PRICES_JSON;
    assistantEnv().OPENAI_MODEL_PRICES_JSON = "{}";
    fixture.port.getWorkspaceById = async () => ({ plan: "free" });
    fixture.port.getWorkspaceMemberCreditAccess = async () => ({
      subscriptionActive: false,
      allowanceRemaining: 0,
      poolBalance: 0,
    });
    fixture.port.getUserById = async () => ({ deletedAt: null, plan: "free" });
    fixture.port.countOtherHostedTrialMeetings = async () => (entitlement === "free" ? 2 : 3);
    fixture.port.hasPrivateBetaProCreditEntitlement = async () => entitlement === "beta";
    const fetch = t.mock.fn(async () => Response.json(gatewayTextResponse("OK")));
    const client = createRealOpenAIClient({ apiKey: "unused", fetch });
    await executeMeteredOpenAIResponse({ ...context, body, client });
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fixture.admission.mock.callCount(), 1);
    assert.equal(fixture.admission.mock.calls[0]?.arguments[0].isIncluded, true);
    assert.equal(fixture.admission.mock.calls[0].arguments[0].maximumCostMicroUsd, 0);
    assert.equal(fixture.credits.mock.callCount(), 0);
    assert.equal(fixture.release.mock.callCount(), 1);
    assert.equal(fixture.usage.mock.callCount(), 1);
    assert.equal(fixture.usage.mock.calls[0]?.arguments[0].costMicroUsd, 0);
    assert.equal(fixture.usage.mock.calls[0].arguments[0].unitCount, 120);
    assert.deepEqual(fixture.usage.mock.calls[0].arguments[0].metadata, {
      reservationId: "reservation",
      operation: "meeting_summary",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 120,
      /** @external rateConfigured */
      rateConfigured: false,
      price: null,
    });
  });
});

["pro", "max"].forEach((plan) => {
  void test(`a business user plan cannot bypass ${plan} workspace pricing or credit admission`, async (t) => {
    const fixture = mockAssistantUsageMetering(t);
    fixture.port.getUserById = async () => ({ deletedAt: null, plan: "business" });
    fixture.port.getWorkspaceById = async () => ({ plan });
    const fetch = t.mock.fn(async () => Response.json(gatewayTextResponse("OK")));
    const client = createRealOpenAIClient({ apiKey: "unused", fetch });
    const configuredPrices = assistantEnv().OPENAI_MODEL_PRICES_JSON;
    assistantEnv().OPENAI_MODEL_PRICES_JSON = "{}";
    await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }), /rate/);
    fixture.port.getWorkspaceMemberCreditAccess = async () => ({
      subscriptionActive: false,
      allowanceRemaining: 0,
      poolBalance: 0,
    });
    await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }), /rate/);
    assistantEnv().OPENAI_MODEL_PRICES_JSON = configuredPrices;
    fixture.admission.mock.mockImplementationOnce(async () => {
      throw new Error(TEST_MESSAGES.insufficient);
    });
    await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }), /Insufficient/);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(fixture.admission.mock.callCount(), 1);
  });
});

void test("unpriced included requests still require finite positive output caps and supported text modality", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  assistantEnv().OPENAI_MODEL_PRICES_JSON = "{}";
  fixture.port.hasPrivateBetaProCreditEntitlement = async () => true;
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => response);
  await Promise.all(
    [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100"].map((maxOutputTokens) =>
      assert.rejects(
        executeMeteredOpenAIResponse({
          ...context,
          body: { ...body, max_output_tokens: maxOutputTokens },
          client: { responses: { create } },
        }),
      ),
    ),
  );
  await Promise.all(
    [
      { ...body, service_tier: "priority" },
      { ...body, tools: [{ type: "web_search" }] },
      { ...body, input: [{ role: "user", content: [{ type: "input_image", image_url: "data:" }] }] },
    ].map((invalidBody) =>
      assert.rejects(
        executeMeteredOpenAIResponse({ ...context, body: invalidBody, client: { responses: { create } } }),
      ),
    ),
  );
  assert.equal(create.mock.callCount(), 0);
  assert.equal(fixture.admission.mock.callCount(), 0);
  await executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } });
  assert.equal(create.mock.calls[0]?.arguments[0].max_output_tokens, 16_384);
});

void test("unpriced included missing usage retains authorization without retrying provider", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  assistantEnv().OPENAI_MODEL_PRICES_JSON = "{}";
  fixture.port.hasPrivateBetaProCreditEntitlement = async () => true;
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  const create = t.mock.fn(async () => ({ output_text: "missing usage" }));
  await assert.rejects(
    withOpenAIRetry({
      baseDelayMs: 0,
      operation: () => executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }),
    }),
    /settlement failed/,
  );
  assert.equal(create.mock.callCount(), 1);
  assert.equal(fixture.admission.mock.callCount(), 1);
  assert.equal(fixture.usage.mock.callCount(), 0);
  assert.equal(fixture.credits.mock.callCount(), 0);
  assert.equal(fixture.release.mock.callCount(), 0);
});

void test("memory billing denial does not consume authorization", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const consume = t.mock.fn(async () => undefined);
  fixture.port.consumeMemoryGeneration = consume;
  const create = t.mock.fn(async () => response);
  const input = {
    ...context,
    source: "relationship_memory",
    memoryAuthorization: { meetingId: "meeting", ownerUserId: "owner", jobId: "job", leaseToken: "lease" },
    body,
    client: { responses: { create } },
  };
  const configuredPrices = assistantEnv().OPENAI_MODEL_PRICES_JSON;
  assistantEnv().OPENAI_MODEL_PRICES_JSON = "{}";
  await assert.rejects(executeMeteredOpenAIResponse(input), /rate/);
  assistantEnv().OPENAI_MODEL_PRICES_JSON = configuredPrices;
  fixture.admission.mock.mockImplementationOnce(async () => {
    throw new Error(TEST_MESSAGES.insufficient);
  });
  await assert.rejects(executeMeteredOpenAIResponse(input), /Insufficient/);
  assert.equal(consume.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 0);
});

void test("a business user plan on a free workspace does not authorize provider work", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.port.getUserById = async () => ({ deletedAt: null, plan: "business" });
  fixture.port.getWorkspaceById = async () => ({ plan: "free" });
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  fixture.port.countOtherHostedTrialMeetings = async () => 3;
  fixture.port.getUserCreditBalanceData = async () => ({ balance: 0 });
  const create = t.mock.fn(async () => response);
  await assert.rejects(
    executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }),
    InsufficientAiCreditsError,
  );
  assert.equal(create.mock.callCount(), 0);
});

void test("introductory and attendee work stays included after hosted standard allowance is exhausted", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.port.getWorkspaceById = async () => ({ plan: "free" });
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  fixture.port.countOtherHostedTrialMeetings = async () => 3;
  const create = t.mock.fn(async () => response);
  fixture.meeting.kind = "agent_intro";
  await executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } });
  assert.equal(fixture.admission.mock.calls[0]?.arguments[0].isIncluded, true);
  fixture.meeting.kind = "standard";
  fixture.workflow.meetingId = context.meetingId;
  fixture.workflow.context = { requester: { userId: "attendee" } };
  await executeMeteredOpenAIResponse({
    ...context,
    workflowRunId: "workflow",
    body,
    client: { responses: { create } },
  });
  assert.equal(fixture.admission.mock.calls[1]?.arguments[0].isIncluded, true);
  assert.equal(create.mock.callCount(), 2);
});

void test("definite Gateway rejection restores reservation but usage evidence keeps the hold", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const fetch = t.mock.fn(async () =>
    Response.json(
      { error: { code: TEST_MESSAGES.invalidKey, type: "auth", message: TEST_MESSAGES.rejected } },
      { status: 401 },
    ),
  );
  const client = createRealOpenAIClient({ apiKey: "unused", fetch });
  await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }), /401/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fixture.release.mock.callCount(), 1);
  const create = t.mock.fn(async () => {
    const error = new Error(TEST_MESSAGES.rejectedWithUsage);
    Object.assign(error, { name: "OpenAIResponsesRequestFailed", status: 400, hasProviderUsage: true });
    throw error;
  });
  await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }));
  assert.equal(fixture.release.mock.callCount(), 1);
});

void test("refund database failure never retries a rejected provider request", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.release.mock.mockImplementation(async () => {
    throw new Error(TEST_MESSAGES.connectionReset);
  });
  const fetch = t.mock.fn(async () =>
    Response.json(
      { error: { code: TEST_MESSAGES.invalidKey, type: "auth", message: TEST_MESSAGES.rejected } },
      { status: 401 },
    ),
  );
  const client = createRealOpenAIClient({ apiKey: "unused", fetch });
  await assert.rejects(
    withOpenAIRetry({ baseDelayMs: 0, operation: () => executeMeteredOpenAIResponse({ ...context, body, client }) }),
    /settlement failed/,
  );
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fixture.admission.mock.callCount(), 1);
  assert.equal(fixture.release.mock.callCount(), 1);
});

["business", "enterprise"].forEach((plan) => {
  void test(`${plan} workspaces are not admitted to paid provider work`, async (t) => {
    const fixture = mockAssistantUsageMetering(t);
    fixture.port.getWorkspaceById = async () => ({ plan });
    fixture.port.getUserById = async () => ({ deletedAt: null, plan });
    fixture.port.getWorkspaceMemberCreditAccess = async () => ({
      subscriptionActive: false,
      allowanceRemaining: 0,
      poolBalance: 0,
    });
    fixture.port.countOtherHostedTrialMeetings = async () => 3;
    const create = t.mock.fn(async () => response);
    await assert.rejects(
      executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } }),
      InsufficientAiCreditsError,
    );
    assert.equal(create.mock.callCount(), 0);
    assert.equal(fixture.admission.mock.callCount(), 0);
  });
});

[402, 413, 429].forEach((status) => {
  void test(`definitive Gateway rejection ${status} releases credits without usage`, async (t) => {
    const fixture = mockAssistantUsageMetering(t);
    const client = createRealOpenAIClient({
      apiKey: "unused",
      fetch: async () =>
        Response.json(
          { error: { code: TEST_MESSAGES.rejected, type: TEST_MESSAGES.invalidKey, message: TEST_MESSAGES.rejected } },
          { status },
        ),
    });
    await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }));
    assert.equal(fixture.release.mock.callCount(), 1);
  });
});

void test("provider rejection with usable usage settles the hold instead of refunding incurred cost", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const client = createRealOpenAIClient({
    apiKey: "unused",
    fetch: async () =>
      Response.json(
        {
          error: {
            code: TEST_MESSAGES.invalidKey,
            type: "invalid_request_error",
            message: TEST_MESSAGES.rejectedWithUsage,
          },
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } },
        },
        { status: 400 },
      ),
  });
  await assert.rejects(executeMeteredOpenAIResponse({ ...context, body, client }));
  assert.equal(fixture.credits.mock.callCount(), 1);
  assert.equal(fixture.release.mock.callCount(), 0);
});

const FITTED_PRICE = {
  maxContextTokens: 1_050_000,
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  outputPerMillion: 30,
};

function heldCredits(maximumCostMicroUsd: unknown): number {
  assert.equal(typeof maximumCostMicroUsd, "number");

  return calculatePlanCredits({ providerCostMicroUsd: Number(maximumCostMicroUsd), plan: "pro", isIncluded: false });
}

void test("a small balance shrinks the output budget so the worst-case hold fits instead of 402", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 40,
  });
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => response);
  await executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } });
  const sentMaxOutput = Number(create.mock.calls[0]?.arguments[0].max_output_tokens);
  assert.ok(sentMaxOutput >= MIN_CREDIT_FITTED_OUTPUT_TOKENS && sentMaxOutput < 16_384);
  assert.ok(heldCredits(fixture.admission.mock.calls[0]?.arguments[0].maximumCostMicroUsd) <= 40);
  assert.equal(fixture.admission.mock.calls[0]?.arguments[0].isIncluded, false);
});

void test("a balance that already covers the request leaves its output budget alone", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 50,
    poolBalance: 50,
  });
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => response);
  await executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } });
  assert.equal(create.mock.calls[0]?.arguments[0].max_output_tokens, 16_384);
});

void test("fitted budget is the largest one whose hold fits, and too little balance keeps the refusal", () => {
  const fitted = creditFittedMaxOutputTokens({
    price: FITTED_PRICE,
    plan: "pro",
    inputTokens: 20_000,
    requestedMaxOutputTokens: 32_000,
    availableCredits: 100,
  });
  const creditsFor = (maxOutputTokens: number) =>
    calculatePlanCredits({
      providerCostMicroUsd: Math.ceil(20_000 * 5 + maxOutputTokens * 30),
      plan: "pro",
      isIncluded: false,
    });
  assert.ok(creditsFor(fitted) <= 100);
  assert.ok(creditsFor(fitted + 1) > 100);
  assert.equal(
    creditFittedMaxOutputTokens({
      price: FITTED_PRICE,
      plan: "pro",
      inputTokens: 20_000,
      requestedMaxOutputTokens: 32_000,
      availableCredits: 1,
    }),
    32_000,
  );
});

void test("the notes lock minimum is exactly the balance at which the notes-run floor starts to fit", () => {
  const minimum = minimumNotesRunCredits({ outputPerMillion: FITTED_PRICE.outputPerMillion, plan: "pro" });
  const fitFor = (availableCredits: number) =>
    creditFittedMaxOutputTokens({
      price: FITTED_PRICE,
      plan: "pro",
      inputTokens: 0,
      requestedMaxOutputTokens: 32_000,
      availableCredits,
      minimumOutputTokens: MIN_NOTES_RUN_OUTPUT_TOKENS,
    });
  assert.ok(fitFor(minimum) >= MIN_NOTES_RUN_OUTPUT_TOKENS && fitFor(minimum) < 32_000);
  assert.equal(fitFor(minimum - 1), 32_000);
});

void test("a balance below the notes floor is refused instead of shrunk into a truncated run", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 40,
  });
  fixture.admission.mock.mockImplementation(async (input) => {
    // Enforce the balance the way the real reservation does.
    if (heldCredits(input.maximumCostMicroUsd) > 40) {
      throw new InsufficientAiCreditsError();
    }

    return { id: "reservation" };
  });
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => response);
  await assert.rejects(
    executeMeteredOpenAIResponse({
      ...context,
      body: { ...body, max_output_tokens: 32_000 },
      client: { responses: { create } },
      minimumOutputTokens: MIN_NOTES_RUN_OUTPUT_TOKENS,
    }),
    InsufficientAiCreditsError,
  );
  assert.equal(fixture.admission.mock.callCount(), 1);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(fixture.credits.mock.callCount(), 0);
});

void test("a discarded response records usage but releases the hold instead of charging", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => response);
  await executeMeteredOpenAIResponse({
    ...context,
    body,
    client: { responses: { create } },
    isBillableResponse: () => false,
  });
  assert.equal(fixture.credits.mock.callCount(), 0);
  assert.equal(fixture.release.mock.callCount(), 1);
  assert.equal(fixture.usage.mock.callCount(), 1);
  const metadata: unknown = fixture.usage.mock.calls[0]?.arguments[0].metadata;
  assert.ok(typeof metadata === "object" && metadata !== null && "isCharged" in metadata);
  assert.equal(metadata.isCharged, false);
});

void test("a billable response still settles the hold", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => response);
  await executeMeteredOpenAIResponse({
    ...context,
    body,
    client: { responses: { create } },
    isBillableResponse: () => true,
  });
  assert.equal(fixture.credits.mock.callCount(), 1);
  assert.equal(fixture.release.mock.callCount(), 0);
});

void test("private-beta users are never charged until their billing workspace subscribes", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  fixture.port.hasPrivateBetaProCreditEntitlement = async () => true;
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  const create = t.mock.fn<OpenAIClient["responses"]["create"]>(async () => response);
  await executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } });
  assert.equal(fixture.admission.mock.calls[0]?.arguments[0].isIncluded, true);
  assert.equal(create.mock.calls[0]?.arguments[0].max_output_tokens, 16_384);
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: true,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  await executeMeteredOpenAIResponse({ ...context, body, client: { responses: { create } } });
  assert.equal(fixture.admission.mock.calls[1]?.arguments[0].isIncluded, false);
});
