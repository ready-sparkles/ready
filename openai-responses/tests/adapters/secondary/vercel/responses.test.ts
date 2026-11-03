import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { executeOpenAIResponses } from "../../../../adapters/secondary/vercel/responses";

const REASONING_SUMMARY_TEXT = "Checked the inputs";
const PARTIAL_OUTPUT_TEXT = "partial";
const EMPTY_REASONING_TEXT = "";
const CACHE_WRITE_INPUT_TOKENS = 5;
const INPUT_TOKENS = 100;
const UNCACHED_INPUT_TOKENS = 70;
const CACHED_INPUT_TOKENS = 30;
const OUTPUT_TOKENS = 10;
const TEXT_TOKENS = 8;
const REASONING_TOKENS = 2;
const FORBIDDEN_STATUS = 403;
const CREDIT_BALANCE_EXHAUSTED_CODE = "credit_balance_exhausted";
const GATEWAY_DENIED_MESSAGE = "Gateway denied";
const GATEWAY_INVALID_KEY_MESSAGE = "\u001b[31mInvalid API key\u001b[0m";
const GATEWAY_REJECTED_MESSAGE = "AI Gateway rejected the request.";
const GATEWAY_UPSTREAM_FAILURE_MESSAGE = "upstream exploded";
const billing = { userId: "member-1", workspaceId: "workspace-1", feature: "summary", gatewayApiKey: "gateway-key" };
const requestBody = { model: "gpt-5.4-mini", input: [{ role: "user", content: "Summarize" }] };
const sdkUsage = {
  inputTokens: {
    total: INPUT_TOKENS,
    noCache: UNCACHED_INPUT_TOKENS,
    cacheRead: CACHED_INPUT_TOKENS,
    cacheWrite: CACHE_WRITE_INPUT_TOKENS,
  },
  outputTokens: { total: OUTPUT_TOKENS, text: TEXT_TOKENS, reasoning: REASONING_TOKENS },
};
const gatewayRequestSchema = z.object({
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())),
  prompt: z.array(z.record(z.string(), z.unknown())),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  responseFormat: z.record(z.string(), z.unknown()).optional(),
});

void test("executeOpenAIResponses routes billed calls through Gateway with identity, tools, reasoning and usage", async () => {
  const requests: { items: { url: string; headers: Headers; body: z.infer<typeof gatewayRequestSchema> }[] } = {
    items: [],
  };
  const result = await executeOpenAIResponses({
    apiKey: "legacy-key",
    billing,
    maxRetries: 0,
    body: {
      ...requestBody,
      tools: [{ type: "function", name: "classify", parameters: { type: "object", properties: {} } }],
      input: [...requestBody.input, { type: "reasoning", id: "rs-old", encrypted_content: "encrypted-old" }],
    },
    fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
      const body = gatewayRequestSchema.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      requests.items = [
        ...requests.items,
        { url: url instanceof Request ? url.url : url.toString(), headers: new Headers(init?.headers), body },
      ];

      return Response.json({
        content: [
          {
            type: "reasoning",
            text: EMPTY_REASONING_TEXT,
            providerMetadata: { openai: { itemId: "rs-new", reasoningEncryptedContent: "encrypted-new" } },
          },
          {
            type: "reasoning",
            text: REASONING_SUMMARY_TEXT,
            providerMetadata: { openai: { itemId: "rs-new", reasoningEncryptedContent: "encrypted-new" } },
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "classify",
            input: "{}",
            providerMetadata: { openai: { itemId: "fc-1" } },
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: sdkUsage,
        warnings: [],
      });
    },
  });
  assert.equal(requests.items.length, 1);
  const request = requests.items[0];
  assert.ok(request);
  assert.equal(request.url, "https://ai-gateway.vercel.sh/v4/ai/language-model");
  assert.equal(request.headers.get("authorization"), "Bearer gateway-key");
  assert.equal(request.headers.get("ai-language-model-id"), "openai/gpt-5.4-mini");
  assert.deepEqual(request.body.providerOptions.gateway, {
    user: "member-1",
    tags: ["workspace:workspace-1", "feature:summary"],
  });
  assert.equal(request.body.providerOptions.openai?.store, false);
  assert.deepEqual(request.body.providerOptions.openai.include, ["reasoning.encrypted_content"]);
  assert.match(JSON.stringify(request.body.prompt), /encrypted-old/);
  assert.equal(request.body.tools?.[0]?.name, "classify");
  assert.equal(result.isOk, true);
  assert.deepEqual(result.totalUsage, {
    inputTokens: INPUT_TOKENS,
    outputTokens: OUTPUT_TOKENS,
    cachedInputTokens: CACHED_INPUT_TOKENS,
    cacheWriteInputTokens: CACHE_WRITE_INPUT_TOKENS,
  });
  assert.deepEqual(result.payload.output, [
    {
      type: "reasoning",
      id: "rs-new",
      encrypted_content: "encrypted-new",
      summary: [{ type: "summary_text", text: REASONING_SUMMARY_TEXT }],
    },
    { type: "function_call", id: "fc-1", call_id: "call-1", name: "classify", arguments: "{}" },
  ]);
});

void test("Gateway structured output retains responses payload and usage even when object validation fails", async () => {
  await Promise.all(
    ['{"isOk":true}', "not-json"].map(async (text) => {
      const result = await executeOpenAIResponses({
        apiKey: "unused",
        billing,
        maxRetries: 0,
        body: {
          ...requestBody,
          text: {
            format: {
              type: "json_schema",
              name: "answer",
              schema: {
                type: "object",
                properties: { isOk: { type: "boolean" } },
                required: ["isOk"],
                /** @external JSON Schema additionalProperties wire field */
                additionalProperties: false,
              },
            },
          },
        },
        fetch: async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
          const request = gatewayRequestSchema.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
          assert.equal(request.responseFormat?.type, "json");

          return Response.json({
            content: [{ type: "text", text }],
            usage: sdkUsage,
            finishReason: { unified: "stop", raw: "stop" },
            warnings: [],
          });
        },
      });
      assert.equal(result.isOk, true);
      assert.equal(result.payload.output_text, text);
      assert.equal(result.payload.status, "completed");
      assert.deepEqual(result.totalUsage, {
        inputTokens: INPUT_TOKENS,
        outputTokens: OUTPUT_TOKENS,
        cachedInputTokens: CACHED_INPUT_TOKENS,
        cacheWriteInputTokens: CACHE_WRITE_INPUT_TOKENS,
      });
      assert.deepEqual(result.payload.output, [
        { type: "message", role: "assistant", id: "msg_0", content: [{ type: "output_text", text, annotations: [] }] },
      ]);
    }),
  );
});

void test("Gateway failures never fall back to direct OpenAI", async () => {
  const urls: { items: string[] } = { items: [] };
  const result = await executeOpenAIResponses({
    apiKey: "legacy-key",
    billing,
    maxRetries: 0,
    body: requestBody,
    fetch: async (url) => {
      urls.items = [...urls.items, url instanceof Request ? url.url : url.toString()];

      return Response.json({ error: { message: GATEWAY_DENIED_MESSAGE } }, { status: FORBIDDEN_STATUS });
    },
  });
  assert.equal(result.isOk, false);
  assert.equal(result.status, FORBIDDEN_STATUS);
  assert.deepEqual(result.payload, { error: { message: GATEWAY_DENIED_MESSAGE } });
  assert.equal(urls.items.length, 1);
  assert.match(urls.items[0] ?? "", /ai-gateway.vercel.sh/);
});

void test("unmetered legacy path keeps OpenAI wire payload and reports available usage", async () => {
  const payload = {
    id: "resp-1",
    status: "completed",
    output_text: "summary",
    usage: {
      input_tokens: INPUT_TOKENS,
      output_tokens: OUTPUT_TOKENS,
      input_tokens_details: { cached_tokens: CACHED_INPUT_TOKENS },
    },
  };
  const result = await executeOpenAIResponses({
    apiKey: "legacy-key",
    maxRetries: 0,
    body: requestBody,
    fetch: async (url) => {
      assert.equal(url instanceof Request ? url.url : url.toString(), "https://api.openai.com/v1/responses");

      return Response.json(payload);
    },
  });
  assert.equal(result.isOk, true);
  assert.equal(result.payload.output_text, payload.output_text);
  assert.deepEqual(result.payload.usage, payload.usage);
  assert.deepEqual(result.totalUsage, {
    inputTokens: INPUT_TOKENS,
    outputTokens: OUTPUT_TOKENS,
    cachedInputTokens: CACHED_INPUT_TOKENS,
    cacheWriteInputTokens: undefined,
  });
});

void test("Gateway incomplete responses retain status and missing usage never becomes zero", async () => {
  const result = await executeOpenAIResponses({
    apiKey: "unused",
    billing,
    maxRetries: 0,
    body: { ...requestBody, model: "openai/gpt-5.4-mini" },
    fetch: async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
      assert.equal(new Headers(init?.headers).get("ai-language-model-id"), "openai/gpt-5.4-mini");

      return Response.json({
        content: [{ type: "text", text: PARTIAL_OUTPUT_TEXT }],
        usage: { inputTokens: {}, outputTokens: {} },
        finishReason: { unified: "length", raw: "max_output_tokens" },
        warnings: [],
      });
    },
  });
  assert.equal(result.isOk, true);
  assert.equal(result.payload.status, "incomplete");
  assert.deepEqual(result.payload.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(result.totalUsage, undefined);
});

void test("Gateway quota failures preserve diagnostics without retrying a billed request", async () => {
  const status = 429;
  const retryCount = 1;
  const expectedAttempts = 1;
  const payload = {
    error: { code: CREDIT_BALANCE_EXHAUSTED_CODE, type: "insufficient_quota", message: GATEWAY_DENIED_MESSAGE },
  };
  const calls = { count: 0 };
  const result = await executeOpenAIResponses({
    apiKey: "legacy-key",
    billing,
    body: requestBody,
    maxRetries: retryCount,
    fetch: async (url) => {
      calls.count += 1;
      assert.match(url instanceof Request ? url.url : url.toString(), /ai-gateway.vercel.sh/);

      return Response.json(payload, { status, headers: { "retry-after-ms": "0" } });
    },
  });
  assert.equal(calls.count, expectedAttempts);
  assert.equal(result.isOk, false);
  assert.equal(result.status, status);
  assert.deepEqual(result.payload, payload);
});

void test("Gateway authentication failures become failed results instead of raw Gateway errors", async () => {
  const unauthorizedStatus = 401;
  const result = await executeOpenAIResponses({
    apiKey: "legacy-key",
    billing: { ...billing, gatewayApiKey: "invalid-gateway-key" },
    body: requestBody,
    maxRetries: 0,
    fetch: async () =>
      Response.json(
        { error: { message: GATEWAY_INVALID_KEY_MESSAGE, type: "authentication_error" } },
        { status: unauthorizedStatus },
      ),
  });
  assert.equal(result.isOk, false);
  assert.equal(result.status, unauthorizedStatus);
  assert.deepEqual(result.payload, {
    error: { message: GATEWAY_REJECTED_MESSAGE, type: "authentication_error" },
  });
});

void test("Gateway server failures keep their status so billing treats the outcome as unknown", async () => {
  const internalErrorStatus = 500;
  const result = await executeOpenAIResponses({
    apiKey: "legacy-key",
    billing,
    body: requestBody,
    maxRetries: 0,
    fetch: async () =>
      Response.json(
        { error: { message: GATEWAY_UPSTREAM_FAILURE_MESSAGE, type: "internal_server_error" } },
        { status: internalErrorStatus },
      ),
  });
  assert.equal(result.isOk, false);
  assert.equal(result.status, internalErrorStatus);
});
