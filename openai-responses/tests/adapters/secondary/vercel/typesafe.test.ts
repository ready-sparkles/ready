import { generateText } from "ai";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { createTypeSafeModel, executeTypeSafeDecision } from "../../../../adapters/secondary/vercel/typesafe";

const URGENT_PROBABILITY = 0.9;
const INPUT_TOKENS = 296;
const OUTPUT_TOKENS = 20;
const OK_STATUS = 200;
const CREATED_STATUS = 201;
const BAD_REQUEST_STATUS = 400;
const RATE_LIMIT_STATUS = 429;
const UNAVAILABLE_STATUS = 503;
const MALFORMED_INPUT_TOKENS = 99;
const MALFORMED_OUTPUT_TOKENS = 3;
const INVALID_USAGE_OUTPUT_TOKENS = 4;
const EVALUATION_PROMPT = "Evaluate";
const body = {
  state: { arbitrary: ["meeting", { isNested: true }] },
  questions: { urgent: { type: "noul", instructions: { custom: ["Is this urgent?"] } } },
  extra: "preserved",
};
const payload = {
  model: "jev-1.13.0",
  answers: { urgent: { type: "noul", noul: URGENT_PROBABILITY } },
  usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
};
const billing = { userId: "member-1", workspaceId: "workspace-1", feature: "tracker" };
const requestSchema = z.object({
  model: z.string(),
  state: z.record(z.string(), z.unknown()),
  questions: z.record(z.string(), z.unknown()),
  extra: z.string(),
});

void test("TypeSafe v4 model runs through generateText with usage and local member audit metadata", async () => {
  const result = await generateText({
    model: createTypeSafeModel({
      apiKey: "typesafe-key",
      body,
      fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
        assert.equal(url instanceof Request ? url.url : url.toString(), "https://api.typesafe.ai/v1/systemone");
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer typesafe-key");
        const request = requestSchema.parse(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
        assert.deepEqual(request, { ...body, model: "jev-latest" });

        return Response.json(payload);
      },
    }),
    prompt: EVALUATION_PROMPT,
    providerOptions: {
      gateway: { user: billing.userId, tags: [`workspace:${billing.workspaceId}`, `feature:${billing.feature}`] },
    },
  });
  assert.equal(result.text, JSON.stringify(payload));
  assert.equal(result.usage.inputTokens, INPUT_TOKENS);
  assert.equal(result.usage.outputTokens, OUTPUT_TOKENS);
  assert.deepEqual(result.finalStep.providerMetadata?.typesafe, {
    status: OK_STATUS,
    user: billing.userId,
    tags: ["workspace:workspace-1", "feature:tracker"],
  });
});

void test("executeTypeSafeDecision preserves body, explicit model, status, raw response and usage", async () => {
  const rawBody = ` ${JSON.stringify(payload)}\n`;
  const result = await executeTypeSafeDecision({
    apiKey: "typesafe-key",
    body: { ...body, model: "jev-1.13.0" },
    billing,
    fetch: async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
      const request = requestSchema.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      assert.equal(request.model, "jev-1.13.0");

      return new Response(rawBody, { status: CREATED_STATUS });
    },
  });
  assert.equal(result.isOk, true);
  assert.equal(result.status, CREATED_STATUS);
  assert.equal(result.rawBody, rawBody);
  assert.deepEqual(result.payload, payload);
  assert.deepEqual(result.totalUsage, {
    inputTokens: INPUT_TOKENS,
    outputTokens: OUTPUT_TOKENS,
    cachedInputTokens: undefined,
    cacheWriteInputTokens: undefined,
  });
});

void test("TypeSafe HTTP failures retain upstream status and body without retrying", async () => {
  await Promise.all(
    [BAD_REQUEST_STATUS, RATE_LIMIT_STATUS, UNAVAILABLE_STATUS].map(async (status) => {
      const calls = { count: 0 };
      const result = await executeTypeSafeDecision({
        apiKey: "typesafe-key",
        body,
        fetch: async () => {
          calls.count += 1;

          return new Response("upstream failure", { status });
        },
      });
      assert.equal(calls.count, 1);
      assert.equal(result.isOk, false);
      assert.equal(result.status, status);
      assert.equal(result.payload, "upstream failure");
      assert.equal(result.rawBody, "upstream failure");
      assert.equal(result.totalUsage, undefined);
    }),
  );
});

void test("malformed TypeSafe success keeps billable usage evidence for caller validation", async () => {
  const malformed = {
    answers: "invalid",
    usage: { input_tokens: MALFORMED_INPUT_TOKENS, output_tokens: MALFORMED_OUTPUT_TOKENS },
  };
  const result = await executeTypeSafeDecision({ apiKey: "key", body, fetch: async () => Response.json(malformed) });
  assert.equal(result.isOk, true);
  assert.equal(result.status, OK_STATUS);
  assert.deepEqual(result.payload, malformed);
  assert.deepEqual(result.totalUsage, {
    inputTokens: MALFORMED_INPUT_TOKENS,
    outputTokens: MALFORMED_OUTPUT_TOKENS,
    cachedInputTokens: undefined,
    cacheWriteInputTokens: undefined,
  });
});

void test("missing or invalid TypeSafe usage never becomes a zero-cost success", async () => {
  await Promise.all(
    [
      "not-json",
      JSON.stringify({ answers: {} }),
      JSON.stringify({ usage: {} }),
      JSON.stringify({ usage: { input_tokens_details: {} } }),
      JSON.stringify({ usage: { input_tokens: -1, output_tokens: INVALID_USAGE_OUTPUT_TOKENS } }),
    ].map(async (responseBody) => {
      const result = await executeTypeSafeDecision({
        apiKey: "key",
        body,
        fetch: async () => new Response(responseBody),
      });
      assert.equal(result.isOk, true);
      assert.equal(result.rawBody, responseBody);
      assert.equal(result.totalUsage, undefined);
    }),
  );
});

void test("TypeSafe honors abort signals and propagates network errors", async () => {
  const controller = new AbortController();
  await assert.rejects(
    executeTypeSafeDecision({
      apiKey: "key",
      body,
      signal: controller.signal,
      fetch: async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
        assert.ok(init?.signal);
        controller.abort();
        assert.equal(init.signal.aborted, true);
        throw new DOMException("Aborted", "AbortError");
      },
    }),
    { name: "AbortError" },
  );
});

void test("TypeSafe preserves upstream retry headers for caller retry policy", async () => {
  const result = await executeTypeSafeDecision({
    apiKey: "typesafe-key",
    body,
    fetch: async () => new Response("rate limited", { status: RATE_LIMIT_STATUS, headers: { "retry-after": "2" } }),
  });
  assert.equal(result.status, RATE_LIMIT_STATUS);
  assert.equal(result.headers["retry-after"], "2");
});
