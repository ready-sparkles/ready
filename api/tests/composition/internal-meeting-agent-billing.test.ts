import {
  closeDbPool,
  createMeeting,
  db,
  reservePlanCredits,
  updateWorkspacePlan,
  upsertUser,
  upsertWorkspaceBillingSubscription,
} from "@readymeet/db";
import * as openaiResponses from "@readymeet/openai-responses";
import { INSUFFICIENT_CREDITS_CODE } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { z } from "zod";

import { apiErrorResponse } from "../../adapters/primary/http/error-handler";
import { internalMeetingAgentRoutes } from "../../adapters/primary/http/routes/internal-meeting-agent";
import { apiEnv } from "../../composition/env";
import { configureLlmResponses } from "../../ports/llm-responses";

const MODEL = "bridge-test-model";
const DAY_MS = 86_400_000;
const ALLOWANCE = 250;
const CONTEXT_TOKENS = 64_000;
const INPUT_TOKENS = 1000;
const OUTPUT_TOKENS = 20;
const OUTPUT_CAP = 100;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYMENT_REQUIRED = 402;
const TWO = 2;
const EXPECTED_COST = 1040;
// One Pro credit covers 7,000 micro-USD of provider cost (93% gross margin on $0.10).
const PRO_PROVIDER_MICRO_USD_PER_CREDIT = 7000;
const reservationSchema = z.object({
  result: z.object({
    reservationId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    included: z.boolean(),
    maxInputTokens: z.number().nullable(),
    maxOutputTokens: z.number().nullable(),
  }),
});
after(closeDbPool);

async function fixture() {
  const user = await upsertUser({ email: `${randomUUID()}@bridge.test`, displayName: "Bridge member" });
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "pro" });
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
  const meeting = await createMeeting({
    title: "Bridge",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  apiEnv.OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    [MODEL]: { inputPerMillion: 1, outputPerMillion: TWO, maxContextTokens: CONTEXT_TOKENS },
  });
  const app = Fastify();
  await app.register(internalMeetingAgentRoutes);
  const reserve = {
    action: "reserveCreditUsage",
    meetingId: meeting.id,
    userId: user.id,
    provider: "openai",
    model: MODEL,
    feature: "meeting_agent_answer",
    maxOutputTokens: OUTPUT_CAP,
  };
  const headers = { "x-assistant-service-secret": apiEnv.ASSISTANT_SERVICE_SECRET };

  return { app, user, meeting, reserve, headers };
}

void test("meeting-agent bridge authenticates and binds authorization, usage-only settlement, retries and release", async () => {
  const { app, user, reserve, headers } = await fixture();
  try {
    assert.equal(
      (await app.inject({ method: "POST", url: "/internal/meeting-agent", payload: reserve })).statusCode,
      HTTP_UNAUTHORIZED,
    );
    const reservationResponse = await app.inject({
      method: "POST",
      url: "/internal/meeting-agent",
      headers,
      payload: reserve,
    });
    assert.equal(reservationResponse.statusCode, HTTP_OK);
    const reservation = reservationSchema.parse(reservationResponse.json()).result;
    assert.equal(reservation.maxInputTokens, CONTEXT_TOKENS);
    assert.equal(reservation.maxOutputTokens, OUTPUT_CAP);
    assert.equal(reservation.included, false);
    const identity = {
      reservationId: reservation.reservationId,
      workspaceId: reservation.workspaceId,
      userId: user.id,
    };
    const settlement = {
      action: "settleCreditUsage",
      ...identity,
      usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/meeting-agent",
          headers,
          payload: { ...settlement, model: "forged", providerCostMicroUsd: 0 },
        })
      ).statusCode,
      HTTP_BAD_REQUEST,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/meeting-agent",
          headers,
          payload: { ...settlement, userId: randomUUID() },
        })
      ).statusCode,
      HTTP_BAD_REQUEST,
    );
    apiEnv.OPENAI_MODEL_PRICES_JSON = "{}";
    assert.equal(
      (await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload: settlement })).statusCode,
      HTTP_OK,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload: settlement })).statusCode,
      HTTP_OK,
    );
    const events = await db.aiCreditUsageEvents.findMany({ where: { reservationId: identity.reservationId } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actualCostMicroUsd, EXPECTED_COST);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/meeting-agent",
          headers,
          payload: { ...reserve, isUnbounded: true },
        })
      ).statusCode,
      HTTP_PAYMENT_REQUIRED,
    );
  } finally {
    await app.close();
  }
});

void test("meeting-agent bridge rejects nonparticipants and paid unbounded requests with distinct 402 reason", async () => {
  const { app, reserve, headers } = await fixture();
  const outsider = await upsertUser({ email: `${randomUUID()}@outsider.test`, displayName: "Outsider" });
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/meeting-agent",
          headers,
          payload: { ...reserve, userId: outsider.id },
        })
      ).statusCode,
      HTTP_BAD_REQUEST,
    );
    const unbounded = await app.inject({
      method: "POST",
      url: "/internal/meeting-agent",
      headers,
      payload: { ...reserve, isUnbounded: true },
    });
    assert.equal(unbounded.statusCode, HTTP_PAYMENT_REQUIRED);
    assert.equal(z.object({ code: z.string() }).parse(unbounded.json()).code, "unbounded_usage_not_supported");
    const denied = await app.inject({
      method: "POST",
      url: "/internal/meeting-agent",
      headers,
      payload: { ...reserve, /** @external forged Python field */ included: true, workspaceId: outsider.workspaceId },
    });
    assert.equal(denied.statusCode, HTTP_BAD_REQUEST);
  } finally {
    await app.close();
  }
});

void test("included unpriced finite bridge usage records explicit unpriced raw usage and releases without customer charge", async () => {
  const { app, user, reserve, headers } = await fixture();
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "free" });
  await db.billingSubscriptions.deleteMany({ where: { workspaceId: user.workspaceId } });
  apiEnv.OPENAI_MODEL_PRICES_JSON = "{}";
  try {
    const response = await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload: reserve });
    assert.equal(response.statusCode, HTTP_OK);
    const reservation = reservationSchema.parse(response.json()).result;
    assert.equal(reservation.included, true);
    assert.equal(reservation.maxInputTokens, null);
    const settlement = {
      action: "settleCreditUsage",
      reservationId: reservation.reservationId,
      workspaceId: reservation.workspaceId,
      userId: user.id,
      usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
    };
    assert.equal(
      (await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload: settlement })).statusCode,
      HTTP_OK,
    );
    const [hold] = await db.aiCreditReservations.findMany({ where: { id: reservation.reservationId } });
    assert.equal(hold?.status, "released");
    assert.equal(
      (await db.aiCreditUsageEvents.findMany({ where: { reservationId: reservation.reservationId } })).length,
      0,
    );
  } finally {
    await app.close();
  }
});

void test("included image authorization settles unpriced tokens and releases, live authorization cleanly releases", async () => {
  const { app, user, reserve, headers } = await fixture();
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "free" });
  await db.billingSubscriptions.deleteMany({ where: { workspaceId: user.workspaceId } });
  try {
    const image = await app.inject({
      method: "POST",
      url: "/internal/meeting-agent",
      headers,
      payload: { ...reserve, isUnbounded: true },
    });
    const reservation = reservationSchema.parse(image.json()).result;
    assert.equal(reservation.maxOutputTokens, OUTPUT_CAP);
    const identity = {
      reservationId: reservation.reservationId,
      workspaceId: reservation.workspaceId,
      userId: user.id,
    };
    const settled = await app.inject({
      method: "POST",
      url: "/internal/meeting-agent",
      headers,
      payload: {
        action: "settleCreditUsage",
        ...identity,
        usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
      },
    });
    assert.equal(settled.statusCode, HTTP_OK);
    const [hold] = await db.aiCreditReservations.findMany({ where: { id: reservation.reservationId } });
    assert.equal(hold?.status, "released");
    const { maxOutputTokens: _cap, ...liveRequest } = reserve;
    const live = await app.inject({
      method: "POST",
      url: "/internal/meeting-agent",
      headers,
      payload: { ...liveRequest, isUnbounded: true },
    });
    const liveAuthorization = reservationSchema.parse(live.json()).result;
    assert.equal(liveAuthorization.maxOutputTokens, null);
    const release = await app.inject({
      method: "POST",
      url: "/internal/meeting-agent",
      headers,
      payload: {
        action: "releaseCreditUsage",
        reservationId: liveAuthorization.reservationId,
        workspaceId: liveAuthorization.workspaceId,
        userId: user.id,
      },
    });
    assert.equal(release.statusCode, HTTP_OK);
  } finally {
    await app.close();
  }
});

const BRIDGE_OUTPUT_CAP = 32_000;
const BRIDGE_API_KEY = "server-bridge-key";
const bridgeBody = {
  model: MODEL,
  input: [
    { role: "system", content: "Help this meeting." },
    { role: "user", content: [{ type: "input_text", text: "Summarize." }] },
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "Evidence" },
    { type: "reasoning", id: "rs-1", encrypted_content: "encrypted", summary: [] },
  ],
  tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
  max_output_tokens: BRIDGE_OUTPUT_CAP,
  /** @external OpenAI wire field */
  store: false,
  reasoning: { effort: "low" },
  include: ["reasoning.encrypted_content"],
};

async function countedBridgeFixture(t: TestContext) {
  const subject = await fixture();
  const previousKey = apiEnv.OPENAI_API_KEY;
  apiEnv.OPENAI_API_KEY = BRIDGE_API_KEY;
  apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "free";
  const calls: { bodies: unknown[] } = { bodies: [] };
  configureLlmResponses({
    ...openaiResponses,
    countOpenAIResponseInput: async (input) => {
      assert.equal(input.apiKey, BRIDGE_API_KEY);

      return openaiResponses.countOpenAIResponseInput({
        ...input,
        fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
          assert.equal(url, "https://api.openai.com/v1/responses/input_tokens");
          assert.ok(typeof init?.body === "string");
          calls.bodies = [
            ...calls.bodies,
            z
              .object({ model: z.string(), input: z.array(z.record(z.unknown())) })
              .passthrough()
              .parse(JSON.parse(init.body)),
          ];

          return Response.json({ object: "response.input_tokens", input_tokens: INPUT_TOKENS });
        },
      });
    },
  });
  t.after(async () => {
    apiEnv.OPENAI_API_KEY = previousKey;
    apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "unverified";
    configureLlmResponses(openaiResponses);
    await subject.app.close();
  });

  return {
    ...subject,
    calls,
    reserve: { ...subject.reserve, maxOutputTokens: BRIDGE_OUTPUT_CAP, requestBody: bridgeBody },
  };
}

void test("bridge counts real Python wire history with server credentials and reserves counted bounds", async (t) => {
  const { app, reserve, headers, calls } = await countedBridgeFixture(t);
  const response = await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload: reserve });
  assert.equal(response.statusCode, HTTP_OK);
  const reservation = reservationSchema.parse(response.json()).result;
  assert.equal(reservation.maxInputTokens, INPUT_TOKENS);
  assert.equal(reservation.maxOutputTokens, BRIDGE_OUTPUT_CAP);
  assert.equal(calls.bodies.length, 1);
  assert.deepEqual(z.object({ input: z.unknown() }).parse(calls.bodies[0]).input, bridgeBody.input);
});

void test("bridge rejects forged counts, mismatched envelope and unsafe paid wire fields before count", async (t) => {
  const { app, reserve, headers, calls } = await countedBridgeFixture(t);
  const invalidRequests = [
    { ...reserve, inputTokens: 1 },
    { ...reserve, requestBody: { ...bridgeBody, input_tokens: 1 } },
    { ...reserve, requestBody: { ...bridgeBody, model: "forged" } },
    { ...reserve, requestBody: { ...bridgeBody, max_output_tokens: OUTPUT_CAP } },
    {
      ...reserve,
      requestBody: { ...bridgeBody, input: [{ type: "input_image", image_url: "https://example.test/image" }] },
    },
    { ...reserve, requestBody: { ...bridgeBody, tools: [{ type: "web_search" }] } },
    { ...reserve, requestBody: { ...bridgeBody, previous_response_id: "resp-other" } },
    { ...reserve, requestBody: { ...bridgeBody, service_tier: "priority" } },
    { ...reserve, requestBody: { ...bridgeBody, context_management: [] } },
  ];
  await Promise.all(
    invalidRequests.map(async (payload) => {
      assert.equal(
        (await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload })).statusCode,
        HTTP_BAD_REQUEST,
      );
    }),
  );
  assert.equal(calls.bodies.length, 0);
  assert.equal(
    (await app.inject({ method: "POST", url: "/internal/meeting-agent", payload: reserve })).statusCode,
    HTTP_UNAUTHORIZED,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/internal/meeting-agent",
        headers,
        payload: { ...reserve, userId: randomUUID() },
      })
    ).statusCode,
    HTTP_BAD_REQUEST,
  );
  assert.equal(calls.bodies.length, 0);
});

void test("bridge unverified gate and missing request body keep full-context bound but cannot override model, cap or paid tools", async (t) => {
  const { app, reserve, headers, calls } = await countedBridgeFixture(t);
  apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "unverified";
  await Promise.all(
    [
      { ...bridgeBody, model: "forged" },
      { ...bridgeBody, max_output_tokens: OUTPUT_CAP },
      { ...bridgeBody, tools: [{ type: "file_search" }] },
    ].map(async (requestBody) => {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/internal/meeting-agent",
            headers,
            payload: { ...reserve, requestBody },
          })
        ).statusCode,
        HTTP_BAD_REQUEST,
      );
    }),
  );
  const conservative = await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload: reserve });
  assert.equal(conservative.statusCode, HTTP_OK);
  assert.equal(reservationSchema.parse(conservative.json()).result.maxInputTokens, CONTEXT_TOKENS);
  apiEnv.OPENAI_INPUT_TOKEN_COUNT_BILLING = "free";
  const { requestBody: _body, ...oldRequest } = reserve;
  const legacy = await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload: oldRequest });
  assert.equal(legacy.statusCode, HTTP_OK);
  assert.equal(reservationSchema.parse(legacy.json()).result.maxInputTokens, CONTEXT_TOKENS);
  assert.equal(calls.bodies.length, 0);
});

void test("a bridge reservation the member cannot cover is a 402 insufficient_credits, never a 500", async () => {
  const { app, user, reserve, headers } = await fixture();
  app.setErrorHandler((error, request, reply) => apiErrorResponse({ error, request, reply }));
  // Another pending call already holds the whole monthly allowance; the pool is empty.
  await reservePlanCredits({
    workspaceId: user.workspaceId,
    userId: user.id,
    maximumCostMicroUsd: ALLOWANCE * PRO_PROVIDER_MICRO_USD_PER_CREDIT,
    isIncluded: false,
  });
  try {
    const response = await app.inject({ method: "POST", url: "/internal/meeting-agent", headers, payload: reserve });

    assert.equal(response.statusCode, HTTP_PAYMENT_REQUIRED);
    assert.deepEqual(z.object({ code: z.string() }).strict().parse(response.json()), {
      code: INSUFFICIENT_CREDITS_CODE,
    });
  } finally {
    await app.close();
  }
});
