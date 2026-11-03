import {
  closeDbPool,
  createCreditGrant,
  createMeeting,
  db,
  getWorkspaceMemberCreditAccess,
  updateUserPlan,
  updateWorkspacePlan,
  upsertUser,
  upsertWorkspaceBillingSubscription,
} from "@readymeet/db";
import * as openaiResponses from "@readymeet/openai-responses";
import { maximumOpenAITextInputTokens } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { z } from "zod";

import {
  executeMeetingDecision,
  executeMeetingResponse,
  InsufficientProviderCreditsError,
  loadProviderAuthorization,
  ProviderAdmissionError,
  ProviderSettlementError,
  reserveProviderUsage,
  settleProviderUsage,
} from "../../application/metered-provider";
import { apiEnv } from "../../composition/env";
import { configureLlmResponses } from "../../ports/llm-responses";
import { repositories } from "../../ports/repository-runtime";

const SMALL_REQUEST_INPUT = "Hello";
const CACHED_RATE = 0.1;
const CONTEXT_TOKENS = 64_000;
const INPUT_TOKENS = 1000;
const OUTPUT_TOKENS = 20;
const DECISION_SCORE = 0.7;
const HTTP_OK = 200;
const JEV_COST = 42;
const HTTP_RATE_LIMIT = 429;
const OPENAI_COST = 1040;
const LARGE_CONTEXT = 400_000;
const WRITE_RATE = 1.25;
const LONG_CONTEXT_THRESHOLD = 272_000;
const OUTPUT_MULTIPLIER = 1.5;
const MAXIMUM_TIER_COST = 1_000_300;
const TWO = 2;
const THREE = 3;
const UNEXPECTED_FETCH_MESSAGE = "Unexpected provider fetch";
const CHANGED_PROMPT = "Changed?";
const DB_UNAVAILABLE_MESSAGE = "DB unavailable";

const MODEL = "test-priced-model";
const FEATURE = "metered_provider_test";
const DAY_MS = 86_400_000;
const ALLOWANCE = 250;
const UNUSED_PERSONAL_GRANT_CREDITS = 20;
const OUTPUT_CAP = 100;
const PRICES = {
  inputPerMillion: 1,
  cachedInputPerMillion: CACHED_RATE,
  outputPerMillion: TWO,
  maxContextTokens: CONTEXT_TOKENS,
};
const USAGE = { inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS, cachedInputTokens: 0 };
after(closeDbPool);

async function fixture(isFunded = true) {
  apiEnv.AI_GATEWAY_API_KEY = "mock-gateway";
  apiEnv.OPENAI_MODEL_PRICES_JSON = JSON.stringify({ [MODEL]: PRICES });
  const user = await upsertUser({ email: `${randomUUID()}@provider.test`, displayName: "Provider member" });
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "pro" });
  if (isFunded) {
    await upsertWorkspaceBillingSubscription({
      workspaceId: user.workspaceId,
      userId: user.id,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripePriceId: "price_test",
      status: "active",
      planInterval: "month",
      includedCreditsPerPeriod: ALLOWANCE,
      seatQuantity: 1,
      currentPeriodStart: new Date(Date.now() - DAY_MS),
      currentPeriodEnd: new Date(Date.now() + DAY_MS),
    });
  }
  const meeting = await createMeeting({
    title: "Billing fixture",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });

  return { user, meeting, scope: { meetingId: meeting.id, source: FEATURE, actionType: "agent_workflow" } };
}

void test("empty member allowance and pool never reach provider fetch", async () => {
  const { scope } = await fixture(false);
  const calls = { fetch: 0 };
  await assert.rejects(
    executeMeetingResponse({
      ...scope,
      request: {
        apiKey: "mock",
        body: { model: MODEL, max_output_tokens: OUTPUT_CAP, input: "Hello" },
        fetch: async () => {
          calls.fetch += 1;
          throw new Error(UNEXPECTED_FETCH_MESSAGE);
        },
      },
    }),
    (error: unknown) => error instanceof InsufficientProviderCreditsError,
  );
  assert.equal(calls.fetch, 0);
  await assert.rejects(
    executeMeetingDecision({
      ...scope,
      request: {
        apiKey: "mock",
        body: { model: "jev-1.13.0", state: "Hello", questions: {} },
        fetch: async () => {
          calls.fetch += 1;
          throw new Error(UNEXPECTED_FETCH_MESSAGE);
        },
      },
    }),
    (error: unknown) => error instanceof InsufficientProviderCreditsError,
  );
  assert.equal(calls.fetch, 0);
});

void test("TypeSafe generateText settles once against the requesting attendee's own workspace", async (t) => {
  const host = await fixture();
  const attendee = await fixture();
  t.mock.method(
    repositories(),
    "isMeetingParticipant",
    async ({ userId }: { userId: string }) => userId === attendee.user.id,
  );
  t.mock.method(repositories(), "getMeetingAttendeeWorkspace", async ({ userId }: { userId: string }) => {
    assert.equal(userId, attendee.user.id);

    return attendee.user.workspaceId;
  });
  const calls = { count: 0 };
  const response = await executeMeetingDecision({
    ...host.scope,
    userId: attendee.user.id,
    request: {
      apiKey: "mock",
      body: {
        model: "jev-1.13.0",
        state: "Evidence",
        questions: { changed: { type: "noul", instructions: CHANGED_PROMPT } },
      },
      fetch: async () => {
        calls.count += 1;

        return Response.json({
          model: "jev-1.13.0",
          answers: { changed: { type: "noul", noul: DECISION_SCORE } },
          usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
        });
      },
    },
  });
  assert.equal(response.status, HTTP_OK);
  assert.equal(calls.count, 1);
  const [event] = await db.aiCreditUsageEvents.findMany({ where: { userId: attendee.user.id } });
  assert.ok(event);
  assert.equal(event.workspaceId, attendee.user.workspaceId);
  assert.equal(event.actualCostMicroUsd, JEV_COST);
  assert.equal(event.creditsCharged, 1);
  assert.equal(event.meetingId, host.meeting.id);
  assert.equal(
    (await getWorkspaceMemberCreditAccess({ userId: attendee.user.id, workspaceId: attendee.user.workspaceId }))
      .allowanceRemaining,
    ALLOWANCE - 1,
  );
  assert.equal(
    (await getWorkspaceMemberCreditAccess({ userId: host.user.id, workspaceId: host.user.workspaceId }))
      .allowanceRemaining,
    ALLOWANCE,
  );
});

void test("successful malformed TypeSafe answers are charged before domain parsing", async () => {
  const { scope, user } = await fixture();
  await executeMeetingDecision({
    ...scope,
    request: {
      apiKey: "mock",
      body: { model: "jev-latest" },
      fetch: async () =>
        Response.json({ answers: "invalid", usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS } }),
    },
  });
  const [event] = await db.aiCreditUsageEvents.findMany({ where: { userId: user.id } });
  assert.equal(event?.creditsCharged, 1);
});

void test("confirmed rejection releases; successful missing usage retains hold without retry", async () => {
  const { scope, user } = await fixture();
  const calls = { count: 0 };
  await executeMeetingDecision({
    ...scope,
    request: {
      apiKey: "mock",
      body: { model: "jev-1.13.0" },
      fetch: async () => new Response("rate limited", { status: HTTP_RATE_LIMIT }),
    },
  });
  await assert.rejects(
    executeMeetingDecision({
      ...scope,
      request: {
        apiKey: "mock",
        body: { model: "jev-1.13.0" },
        fetch: async () => {
          calls.count += 1;

          return Response.json({ answers: {} });
        },
      },
    }),
    ProviderSettlementError,
  );
  assert.equal(calls.count, 1);
  const holds = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.deepEqual(holds.map((hold) => hold.status).sort(), ["released", "reserved"]);
});

void test("settlement failure never retries provider or releases consumed reservation", async (t) => {
  const { scope, user } = await fixture();
  t.mock.method(repositories(), "settlePlanCredits", async () => {
    throw new Error(DB_UNAVAILABLE_MESSAGE);
  });
  const calls = { count: 0 };
  await assert.rejects(
    executeMeetingDecision({
      ...scope,
      request: {
        apiKey: "mock",
        body: { model: "jev-1.13.0" },
        fetch: async () => {
          calls.count += 1;

          return Response.json({ usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS } });
        },
      },
    }),
    ProviderSettlementError,
  );
  assert.equal(calls.count, 1);
  const [hold] = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.equal(hold?.status, "reserved");
});

void test("OpenAI transport receives server identity and normalized usage settles before returning", async () => {
  const { scope, user } = await fixture();
  const smallRequestBody = { model: MODEL, max_output_tokens: OUTPUT_CAP, input: SMALL_REQUEST_INPUT };
  configureLlmResponses({
    createLlmResponse: async (request) => {
      assert.deepEqual(request.billing, {
        userId: user.id,
        workspaceId: user.workspaceId,
        feature: FEATURE,
        gatewayApiKey: "mock-gateway",
        maxInputTokens: maximumOpenAITextInputTokens(smallRequestBody),
      });

      return { isOk: true, status: HTTP_OK, payload: { output: "malformed domain payload" }, totalUsage: USAGE };
    },
  });
  await executeMeetingResponse({
    ...scope,
    request: { apiKey: "mock", body: smallRequestBody },
  });
  const [event] = await db.aiCreditUsageEvents.findMany({ where: { userId: user.id } });
  assert.equal(event?.actualCostMicroUsd, OPENAI_COST);
});

void test("bridge authorization binds identity and prices and rejects cross-owner settlement", async () => {
  const { scope } = await fixture();
  const other = await fixture();
  const authorization = await reserveProviderUsage({
    ...scope,
    provider: "openai",
    model: MODEL,
    maxOutputTokens: OUTPUT_CAP,
  });
  await assert.rejects(loadProviderAuthorization({ ...authorization, userId: other.user.id }), ProviderAdmissionError);
  apiEnv.OPENAI_MODEL_PRICES_JSON = "{}";
  await settleProviderUsage({ authorization: await loadProviderAuthorization(authorization), totalUsage: USAGE });
  await settleProviderUsage({ authorization: await loadProviderAuthorization(authorization), totalUsage: USAGE });
  const events = await db.aiCreditUsageEvents.findMany({ where: { reservationId: authorization.reservationId } });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actualCostMicroUsd, OPENAI_COST);
});

void test("paid unknown, missing cap, unbounded and multimodal calls fail before reservation", async () => {
  const { scope, user } = await fixture();
  await Promise.all(
    [
      { provider: "openai" as const, model: "unknown", maxOutputTokens: OUTPUT_CAP },
      { provider: "openai" as const, model: MODEL },
      { provider: "openai" as const, model: MODEL, isUnbounded: true },
    ].map((request) => assert.rejects(reserveProviderUsage({ ...scope, ...request }), ProviderAdmissionError)),
  );
  await assert.rejects(
    executeMeetingResponse({
      ...scope,
      request: {
        apiKey: "mock",
        body: {
          model: MODEL,
          max_output_tokens: OUTPUT_CAP,
          input: [{ type: "input_image", image_url: "data:image/png,xxx" }],
        },
      },
    }),
    ProviderAdmissionError,
  );
  assert.equal((await db.aiCreditReservations.findMany({ where: { userId: user.id } })).length, 0);
});

void test("free hosted inclusion ends at meeting four and paid workspaces cannot use client inclusion", async (t) => {
  const { scope, user } = await fixture(false);
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "free" });
  t.mock.method(repositories(), "countOtherHostedTrialMeetings", async () => TWO);
  const included = await reserveProviderUsage({ ...scope, provider: "openai", model: MODEL, isUnbounded: true });
  assert.equal(included.metadata.included, true);
  assert.equal(included.metadata.maxInputTokens, null);
  t.mock.method(repositories(), "countOtherHostedTrialMeetings", async () => THREE);
  await assert.rejects(
    reserveProviderUsage({ ...scope, provider: "openai", model: MODEL, isUnbounded: true }),
    ProviderAdmissionError,
  );
});

void test("long-context maximum holds worst tariff but short usage settles at base rate", async () => {
  const { scope, user } = await fixture();
  apiEnv.OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    [MODEL]: {
      ...PRICES,
      maxContextTokens: LARGE_CONTEXT,
      cacheWritePerMillion: WRITE_RATE,
      longContext: {
        thresholdTokens: LONG_CONTEXT_THRESHOLD,
        inputMultiplier: TWO,
        outputMultiplier: OUTPUT_MULTIPLIER,
      },
    },
  });
  const authorization = await reserveProviderUsage({
    ...scope,
    provider: "openai",
    model: MODEL,
    maxOutputTokens: OUTPUT_CAP,
  });
  const [hold] = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.equal(hold?.maximumCostMicroUsd, MAXIMUM_TIER_COST);
  await settleProviderUsage({ authorization, totalUsage: USAGE });
  const [event] = await db.aiCreditUsageEvents.findMany({ where: { userId: user.id } });
  assert.equal(event?.actualCostMicroUsd, OPENAI_COST);
});

void test("explicit TypeSafe 5xx retains its hold and a later attempt gets a new reservation", async () => {
  const { scope, user } = await fixture();
  const unavailable = 503;
  const failed = await executeMeetingDecision({
    ...scope,
    request: {
      apiKey: "mock",
      body: { model: "jev-1.13.0" },
      fetch: async () => new Response("unavailable", { status: unavailable }),
    },
  });
  assert.equal(failed.status, unavailable);
  await executeMeetingDecision({
    ...scope,
    request: {
      apiKey: "mock",
      body: { model: "jev-1.13.0" },
      fetch: async () => Response.json({ usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS } }),
    },
  });
  const holds = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.deepEqual(holds.map((hold) => hold.status).sort(), ["reserved", "settled"]);
});

void test("private beta is server included only without an active paid workspace subscription", async (t) => {
  const { scope, user } = await fixture(false);
  t.mock.method(repositories(), "hasPrivateBetaProCreditEntitlement", async () => true);
  const getUser = repositories().getUserById;
  t.mock.method(repositories(), "getUserById", async (id: string) => {
    const record = await getUser(id);

    return record === null ? null : { ...record, plan: "pro" as const };
  });
  const beta = await reserveProviderUsage({ ...scope, provider: "openai", model: MODEL, isUnbounded: true });
  assert.equal(beta.metadata.included, true);
  await upsertWorkspaceBillingSubscription({
    workspaceId: user.workspaceId,
    userId: user.id,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripePriceId: "price_test",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: ALLOWANCE,
    seatQuantity: 1,
    currentPeriodStart: new Date(Date.now() - DAY_MS),
    currentPeriodEnd: new Date(Date.now() + DAY_MS),
  });
  const paid = await reserveProviderUsage({ ...scope, provider: "openai", model: MODEL, maxOutputTokens: OUTPUT_CAP });
  assert.equal(paid.metadata.included, false);
});

void test("retired business plans and personal grants do not authorize paid provider work", async (t) => {
  t.mock.method(repositories(), "countOtherHostedTrialMeetings", async () => THREE);
  const { scope, user } = await fixture(false);
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "free" });
  await updateUserPlan({ userId: user.id, plan: "business" });
  await createCreditGrant({ userId: user.id, source: "subscription_period", credits: ALLOWANCE });
  await assert.rejects(
    reserveProviderUsage({ ...scope, provider: "openai", model: MODEL, maxOutputTokens: OUTPUT_CAP }),
    ProviderAdmissionError,
  );
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "business" });
  await assert.rejects(
    reserveProviderUsage({ ...scope, provider: "openai", model: MODEL, maxOutputTokens: OUTPUT_CAP }),
    ProviderAdmissionError,
  );
  assert.equal((await db.aiCreditReservations.findMany({ where: { userId: user.id } })).length, 0);
});

const DEFAULT_OUTPUT_CAP = 32_000;
const COUNTED_CONTEXT = 1_050_000;
const COUNTED_INPUT_RATE = 5;
const COUNTED_OUTPUT_RATE = 30;
const COUNTED_WRITE_RATE = 6;
const COUNT_URL = "https://api.openai.com/v1/responses/input_tokens";
const GENERATE_URL = "https://api.openai.com/v1/responses";
const MOCK_OPENAI_KEY = "server-openai-test-key";
const COUNTED_INPUT_TEXT = "Hello";
const NETWORK_FAILURE_MESSAGE = "Count unavailable";
const CANCELLED_MESSAGE = "Cancelled before dispatch";
const UNKNOWN_OUTCOME_MESSAGE = "Unknown outcome";
const FRACTIONAL_COUNT = 1.5;
const HTTP_UNAVAILABLE = 503;
function requestUrl(url: Parameters<typeof globalThis.fetch>[0]): string {
  return url instanceof Request ? url.url : url.toString();
}
const COUNTED_BODY = {
  model: MODEL,
  max_output_tokens: DEFAULT_OUTPUT_CAP,
  input: [{ role: "user", content: COUNTED_INPUT_TEXT }],
};

async function countedFixture(t: TestContext) {
  const subject = await fixture();
  const previousKey = apiEnv.OPENAI_API_KEY;
  apiEnv.OPENAI_API_KEY = MOCK_OPENAI_KEY;
  apiEnv.AI_GATEWAY_API_KEY = "";
  apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "free";
  apiEnv.OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    [MODEL]: {
      inputPerMillion: COUNTED_INPUT_RATE,
      cacheWritePerMillion: COUNTED_WRITE_RATE,
      outputPerMillion: COUNTED_OUTPUT_RATE,
      maxContextTokens: COUNTED_CONTEXT,
      longContext: {
        thresholdTokens: LONG_CONTEXT_THRESHOLD,
        inputMultiplier: TWO,
        outputMultiplier: OUTPUT_MULTIPLIER,
      },
    },
  });
  configureLlmResponses(openaiResponses);
  t.after(() => {
    apiEnv.OPENAI_API_KEY = previousKey;
    apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "unverified";
    configureLlmResponses(openaiResponses);
  });

  return subject;
}

function generatedResponse(): Response {
  return Response.json({
    id: "resp_counted",
    status: "completed",
    output_text: COUNTED_INPUT_TEXT,
    usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
  });
}

void test("counted tiny request fits actual 250-credit allowance with unchanged 32k output cap and no Gateway key", async (t) => {
  const { scope, user } = await countedFixture(t);
  const calls: { urls: string[] } = { urls: [] };
  await executeMeetingResponse({
    ...scope,
    request: {
      apiKey: "untrusted-key",
      billing: { userId: "forged", workspaceId: "forged", feature: "forged", gatewayApiKey: "forged" },
      body: COUNTED_BODY,
      fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
        calls.urls = [...calls.urls, requestUrl(url)];
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${MOCK_OPENAI_KEY}`);
        const holds = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
        if (requestUrl(url) === COUNT_URL) {
          assert.equal(holds.length, 0);

          return Response.json({ object: "response.input_tokens", input_tokens: INPUT_TOKENS });
        }
        assert.equal(holds.length, 1);
        assert.ok(holds[0]);
        assert.equal(holds[0].userId, user.id);
        assert.equal(holds[0].workspaceId, user.workspaceId);
        assert.equal(
          holds[0].maximumCostMicroUsd,
          INPUT_TOKENS * COUNTED_WRITE_RATE + DEFAULT_OUTPUT_CAP * COUNTED_OUTPUT_RATE,
        );
        assert.ok(typeof init?.body === "string");
        assert.equal(
          z.object({ max_output_tokens: z.number() }).parse(JSON.parse(init.body)).max_output_tokens,
          DEFAULT_OUTPUT_CAP,
        );

        return generatedResponse();
      },
    },
  });
  assert.deepEqual(calls.urls, [COUNT_URL, GENERATE_URL]);
  const [hold] = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.equal(z.object({ maxInputTokens: z.number() }).parse(hold?.metadata).maxInputTokens, INPUT_TOKENS);
  assert.ok(hold && hold.reservedCredits < ALLOWANCE);
  assert.equal(hold.status, "settled");
});

void test("counted excessive input, invalid counts, count errors and context overflow never generate", async (t) => {
  const { scope, user } = await countedFixture(t);
  const invalidCounts = [-1, FRACTIONAL_COUNT, "1000", null, LARGE_CONTEXT, COUNTED_CONTEXT];
  const calls = { generation: 0 };
  await Promise.all(
    invalidCounts.map(async (count) => {
      await assert.rejects(
        executeMeetingResponse({
          ...scope,
          request: {
            apiKey: "mock",
            body: COUNTED_BODY,
            fetch: async (url) => {
              if (requestUrl(url) === COUNT_URL) {
                return Response.json({ object: "response.input_tokens", input_tokens: count });
              }
              calls.generation += 1;

              return generatedResponse();
            },
          },
        }),
      );
    }),
  );
  await Promise.all(
    [
      async () => new Response("unavailable", { status: HTTP_UNAVAILABLE }),
      async () => {
        throw new Error(NETWORK_FAILURE_MESSAGE);
      },
    ].map(async (countResponse) => {
      await assert.rejects(
        executeMeetingResponse({ ...scope, request: { apiKey: "mock", body: COUNTED_BODY, fetch: countResponse } }),
      );
    }),
  );
  assert.equal(calls.generation, 0);
  assert.equal((await db.aiCreditReservations.findMany({ where: { userId: user.id } })).length, 0);
});

void test("unauthorized owner and unpriced model fail before counting", async (t) => {
  const { scope } = await countedFixture(t);
  const calls = { count: 0 };
  const request = {
    apiKey: "mock",
    body: COUNTED_BODY,
    fetch: async () => {
      calls.count += 1;

      return generatedResponse();
    },
  };
  await assert.rejects(executeMeetingResponse({ ...scope, userId: randomUUID(), request }), ProviderAdmissionError);
  apiEnv.OPENAI_MODEL_PRICES_JSON = "{}";
  await assert.rejects(executeMeetingResponse({ ...scope, request }), ProviderAdmissionError);
  assert.equal(calls.count, 0);
});

void test("unverified count billing admits a small Pro request without remote counting", async (t) => {
  const { scope, user } = await countedFixture(t);
  apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "unverified";
  apiEnv.AI_GATEWAY_API_KEY = "";
  const calls = { count: 0 };
  await executeMeetingResponse({
    ...scope,
    request: {
      apiKey: "mock",
      body: { ...COUNTED_BODY, input: [{ role: "user", content: "Hello" }] },
      fetch: async (url) => {
        assert.equal(requestUrl(url), GENERATE_URL);
        calls.count += 1;

        return generatedResponse();
      },
    },
  });
  assert.equal(calls.count, 1);
  const [hold] = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.equal(hold?.status, "settled");
  assert.ok(hold.reservedCredits <= ALLOWANCE);
});

void test("counted transport must obtain exactly one matching callback reservation", async (t) => {
  const { scope, user } = await countedFixture(t);
  configureLlmResponses({
    createLlmResponse: async () => ({ isOk: true, status: HTTP_OK, payload: {}, totalUsage: USAGE }),
  });
  await assert.rejects(
    executeMeetingResponse({ ...scope, request: { apiKey: "mock", body: COUNTED_BODY } }),
    /did not obtain a reservation/,
  );
  await [
    { model: "forged", maxOutputTokens: DEFAULT_OUTPUT_CAP },
    { model: MODEL, maxOutputTokens: OUTPUT_CAP },
  ].reduce(async (previous, mismatch) => {
    await previous;
    configureLlmResponses({
      createLlmResponse: async (request) => {
        assert.ok(request.beforeProviderCall);
        try {
          await request.beforeProviderCall({ ...mismatch, inputTokens: INPUT_TOKENS });
        } catch (cause) {
          throw new openaiResponses.OpenAIRequestNotDispatchedError(cause);
        }

        return { isOk: true, status: HTTP_OK, payload: {}, totalUsage: USAGE };
      },
    });
    await assert.rejects(
      executeMeetingResponse({ ...scope, request: { apiKey: "mock", body: COUNTED_BODY } }),
      ProviderAdmissionError,
    );
  }, Promise.resolve());
  assert.equal((await db.aiCreditReservations.findMany({ where: { userId: user.id } })).length, 0);
});

void test("proven no-dispatch releases counted hold; unknown dispatch and settlement errors retain it without retries", async (t) => {
  const { scope, user } = await countedFixture(t);
  const admissionFailure = new ProviderAdmissionError(CANCELLED_MESSAGE);
  const calls = { generation: 0 };
  await [
    new openaiResponses.OpenAIRequestNotDispatchedError(admissionFailure),
    new Error(UNKNOWN_OUTCOME_MESSAGE),
    null,
  ].reduce(async (previous, failure) => {
    await previous;
    configureLlmResponses({
      createLlmResponse: async (request) => {
        calls.generation += 1;
        assert.ok(request.beforeProviderCall);
        await request.beforeProviderCall({
          model: MODEL,
          maxOutputTokens: OUTPUT_CAP,
          inputTokens: INPUT_TOKENS,
        });
        if (failure !== null) {
          throw failure;
        }

        return { isOk: true, status: HTTP_OK, payload: {}, totalUsage: { ...USAGE, inputTokens: INPUT_TOKENS + 1 } };
      },
    });
    await assert.rejects(
      executeMeetingResponse({
        ...scope,
        request: { apiKey: "mock", body: { ...COUNTED_BODY, max_output_tokens: OUTPUT_CAP } },
      }),
      failure === null
        ? ProviderSettlementError
        : (error: unknown) => {
            assert.ok(
              failure instanceof openaiResponses.OpenAIRequestNotDispatchedError
                ? error === admissionFailure
                : error instanceof ProviderSettlementError,
            );

            return true;
          },
    );
  }, Promise.resolve());
  assert.equal(calls.generation, THREE);
  const holds = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.deepEqual(holds.map((hold) => hold.status).sort(), ["released", "reserved", "reserved"]);
});

void test("zero count remains a finite reservation and cannot settle positive input", async (t) => {
  const { scope, user } = await countedFixture(t);
  await assert.rejects(
    executeMeetingResponse({
      ...scope,
      request: {
        apiKey: "mock",
        body: COUNTED_BODY,
        fetch: async (url) =>
          requestUrl(url) === COUNT_URL
            ? Response.json({ object: "response.input_tokens", input_tokens: 0 })
            : generatedResponse(),
      },
    }),
    ProviderSettlementError,
  );
  const [hold] = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.equal(z.object({ maxInputTokens: z.number() }).parse(hold?.metadata).maxInputTokens, 0);
  assert.equal(hold?.status, "reserved");
});

void test("paid request snapshot survives external mutation while resolving identity", async (t) => {
  const { scope } = await countedFixture(t);
  const body = structuredClone(COUNTED_BODY);
  const getUser = repositories().getUserById;
  t.mock.method(repositories(), "getUserById", async (id: string) => {
    body.model = "forged";
    body.max_output_tokens = OUTPUT_CAP;
    body.input = [{ role: "user", content: "Changed" }];

    return getUser(id);
  });
  await executeMeetingResponse({
    ...scope,
    request: {
      apiKey: "mock",
      body,
      fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
        assert.ok(typeof init?.body === "string");
        const wire = z
          .object({
            model: z.string(),
            input: z.array(z.record(z.unknown())),
            max_output_tokens: z.number().optional(),
          })
          .parse(JSON.parse(init.body));
        assert.equal(wire.model, MODEL);
        assert.deepEqual(wire.input, [{ role: "user", content: [{ type: "input_text", text: COUNTED_INPUT_TEXT }] }]);
        if (requestUrl(url) === COUNT_URL) {
          return Response.json({ object: "response.input_tokens", input_tokens: INPUT_TOKENS });
        }
        assert.equal(wire.max_output_tokens, DEFAULT_OUTPUT_CAP);

        return generatedResponse();
      },
    },
  });
});

void test("included free meetings skip counting callbacks", async (t) => {
  const { scope, user } = await countedFixture(t);
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "free" });
  t.mock.method(repositories(), "countOtherHostedTrialMeetings", async () => 0);
  t.mock.method(repositories(), "getWorkspaceMemberCreditAccess", async () => ({
    /** @external member credit access contract */
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  }));
  apiEnv.AI_GATEWAY_API_KEY = "mock-gateway";
  configureLlmResponses({
    createLlmResponse: async (request) => {
      assert.equal(request.beforeProviderCall, undefined);
      assert.equal(request.inputTokenCountBilling, undefined);
      assert.equal(request.billing?.userId, user.id);

      return { isOk: true, status: HTTP_OK, payload: {}, totalUsage: USAGE };
    },
  });
  await executeMeetingResponse({
    ...scope,
    request: {
      apiKey: "mock",
      body: COUNTED_BODY,
      inputTokenCountBilling: "free",
      beforeProviderCall: async () => {
        throw new Error(UNEXPECTED_FETCH_MESSAGE);
      },
    },
  });
  const [hold] = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.equal(z.object({ included: z.boolean() }).parse(hold?.metadata).included, true);
  assert.equal(hold?.reservedCredits, 0);
});

const REJECTED_AFTER_USAGE_MESSAGE = "Rejected after usage";
const HTTP_BAD_REQUEST = 400;

void test("usage-bearing provider rejections settle valid consumption and retain malformed holds", async (t) => {
  await ["counted", "fallback"].reduce(async (previousMode, mode) => {
    await previousMode;
    await [
      { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
      { input_tokens: "invalid", output_tokens: OUTPUT_TOKENS },
    ].reduce(async (previousUsage, usage) => {
      await previousUsage;
      await t.test(`${mode} ${typeof usage.input_tokens}`, async (inner) => {
        const { scope, user } = await fixture();
        const previous = apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING;
        apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = mode === "counted" ? "free" : "unverified";
        inner.after(() => {
          apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = previous;
        });
        apiEnv.OPENAI_API_KEY = MOCK_OPENAI_KEY;
        configureLlmResponses(openaiResponses);
        const operation = executeMeetingResponse({
          ...scope,
          request: {
            apiKey: MOCK_OPENAI_KEY,
            body: { model: MODEL, max_output_tokens: OUTPUT_CAP, input: [{ role: "user", content: "Hello" }] },
            fetch: async (url) =>
              requestUrl(url) === COUNT_URL
                ? Response.json({ object: "response.input_tokens", input_tokens: INPUT_TOKENS })
                : Response.json(
                    { error: { message: REJECTED_AFTER_USAGE_MESSAGE }, usage },
                    { status: HTTP_BAD_REQUEST },
                  ),
          },
        });
        if (typeof usage.input_tokens === "number") {
          assert.equal((await operation).isOk, false);
        } else {
          await assert.rejects(operation, ProviderSettlementError);
        }
        const [hold] = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
        assert.equal(hold?.status, typeof usage.input_tokens === "number" ? "settled" : "reserved");
      });
    }, Promise.resolve());
  }, Promise.resolve());
});

void test("default transport releases local validation failures and admits no already-cancelled work", async (t) => {
  const { scope, user } = await fixture();
  apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "unverified";
  configureLlmResponses(openaiResponses);
  const fetch = t.mock.fn<typeof globalThis.fetch>(async () => {
    throw new Error(UNEXPECTED_FETCH_MESSAGE);
  });
  await assert.rejects(
    executeMeetingResponse({
      ...scope,
      request: { apiKey: "mock", signal: AbortSignal.abort(), body: COUNTED_BODY, fetch },
    }),
  );
  assert.equal((await db.aiCreditReservations.findMany({ where: { userId: user.id } })).length, 0);
  await assert.rejects(
    executeMeetingResponse({
      ...scope,
      request: { apiKey: "mock", body: { model: MODEL, max_output_tokens: OUTPUT_CAP, input: "Hello" }, fetch },
    }),
  );
  const [hold] = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.equal(hold?.status, "released");
  assert.equal(fetch.mock.callCount(), 0);
});

void test("cancelled TypeSafe decisions release a hold created during admission", async (t) => {
  const { scope, user } = await fixture();
  const fetch = t.mock.fn<typeof globalThis.fetch>(async () => {
    throw new Error(UNEXPECTED_FETCH_MESSAGE);
  });
  await assert.rejects(
    executeMeetingDecision({
      ...scope,
      request: { apiKey: "mock", signal: AbortSignal.abort(), body: { model: "jev-1.13.0" }, fetch },
    }),
  );
  assert.equal((await db.aiCreditReservations.findMany({ where: { userId: user.id } })).length, 0);
  const controller = new AbortController();
  const reserve = repositories().reservePlanCredits.bind(repositories());
  t.mock.method(repositories(), "reservePlanCredits", async (input: Parameters<typeof reserve>[0]) => {
    const reservation = await reserve(input);
    controller.abort();

    return reservation;
  });
  await assert.rejects(
    executeMeetingDecision({
      ...scope,
      request: { apiKey: "mock", signal: controller.signal, body: { model: "jev-1.13.0" }, fetch },
    }),
  );
  const holds = await db.aiCreditReservations.findMany({ where: { userId: user.id } });
  assert.deepEqual(
    holds.map((hold) => hold.status),
    ["released"],
  );
  assert.equal(fetch.mock.callCount(), 0);
});

void test("retired plans do not spend personal grants on repeated provider calls", async (t) => {
  const { scope, user } = await fixture(false);
  t.mock.method(repositories(), "countOtherHostedTrialMeetings", async () => THREE);
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "free" });
  await updateUserPlan({ userId: user.id, plan: "business" });
  apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "unverified";
  await createCreditGrant({
    userId: user.id,
    source: "subscription_period",
    credits: UNUSED_PERSONAL_GRANT_CREDITS,
  });
  const create = t.mock.fn(async () => ({ isOk: true, status: HTTP_OK, payload: {}, totalUsage: USAGE }));
  configureLlmResponses({ createLlmResponse: create });
  await assert.rejects(
    executeMeetingResponse({ ...scope, request: { apiKey: "mock", body: COUNTED_BODY } }),
    ProviderAdmissionError,
  );
  assert.equal(create.mock.callCount(), 0);
  assert.equal((await repositories().getUserCreditBalanceData(user.id)).balance, UNUSED_PERSONAL_GRANT_CREDITS);
});
