import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import {
  countOpenAIResponseInput,
  executeOpenAIResponses,
  OpenAIRequestNotDispatchedError,
} from "../../../../adapters/secondary/vercel/responses";

const API_KEY = "mock-openai-key";
const INPUT_TOKENS = 12;
const TIMEOUT_MS = 1;
const RESERVATION_DELAY_MS = 20;
const MAX_OUTPUT_TOKENS = 32_000;
const COUNT_URL = "https://api.openai.com/v1/responses/input_tokens";
const body = {
  model: "gpt-5.4-mini",
  input: [{ role: "user", content: "Summarize" }],
  max_output_tokens: MAX_OUTPUT_TOKENS,
};

void test("countOpenAIResponseInput snapshots nested input before awaiting fetch", async () => {
  const mutableBody = structuredClone(body);
  const result = countOpenAIResponseInput({
    apiKey: API_KEY,
    body: mutableBody,
    inputTokenCountBilling: "free",
    fetch: async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
      await Promise.resolve();
      assert.equal(typeof init?.body, "string");
      assert.equal(init?.body, JSON.stringify({ model: body.model, input: body.input }));

      return Response.json({ object: "response.input_tokens", input_tokens: INPUT_TOKENS });
    },
  });
  mutableBody.input = [{ role: "user", content: "Changed" }];
  assert.equal(await result, INPUT_TOKENS);
});

void test("counted Responses timeout during reservation blocks generation after reservation returns", async () => {
  const calls: { items: string[] } = { items: [] };
  const admission = { isReserved: false };
  await assert.rejects(
    executeOpenAIResponses({
      apiKey: API_KEY,
      body,
      maxRetries: 0,
      timeoutMs: TIMEOUT_MS,
      inputTokenCountBilling: "free",
      beforeProviderCall: async () => {
        admission.isReserved = true;
        await setTimeout(RESERVATION_DELAY_MS);
      },
      fetch: async (url) => {
        calls.items = [...calls.items, url instanceof Request ? url.url : url.toString()];

        return Response.json({ object: "response.input_tokens", input_tokens: INPUT_TOKENS });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAIRequestNotDispatchedError);
      assert.equal(error.isProviderRequestDispatched, false);

      return true;
    },
  );
  assert.equal(admission.isReserved, true);
  assert.deepEqual(calls.items, [COUNT_URL]);
});

void test("countOpenAIResponseInput honors cancellation and passes a bounded count signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    countOpenAIResponseInput({
      apiKey: API_KEY,
      body,
      inputTokenCountBilling: "free",
      signal: controller.signal,
      fetch: async () => assert.fail("Aborted count must not fetch"),
    }),
  );
  await assert.rejects(
    countOpenAIResponseInput({
      apiKey: API_KEY,
      body,
      inputTokenCountBilling: "free",
      timeoutMs: TIMEOUT_MS,
      fetch: async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
        assert.ok(init?.signal);
        await setTimeout(RESERVATION_DELAY_MS);
        init.signal.throwIfAborted();

        return Response.json({ object: "response.input_tokens", input_tokens: INPUT_TOKENS });
      },
    }),
  );
});

const LOCAL_INPUT_BOUND = 20_000;
const LOCAL_RESPONSE_OUTPUT_TOKENS = 2;
const LOCAL_OUTPUT_CAP = 128;
const localBilling = {
  userId: "user",
  workspaceId: "workspace",
  feature: "notes",
  gatewayApiKey: "",
  maxInputTokens: LOCAL_INPUT_BOUND,
};
const directResult = {
  id: "response",
  status: "completed",
  output: [
    {
      type: "message",
      id: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    },
  ],
  usage: { input_tokens: INPUT_TOKENS, output_tokens: LOCAL_RESPONSE_OUTPUT_TOKENS },
};
void test("local admission covers Unicode, schemas, and tools without a counting request", async () => {
  const calls: { urls: string[] } = { urls: [] };
  const result = await executeOpenAIResponses({
    apiKey: API_KEY,
    billing: localBilling,
    maxRetries: 0,
    body: {
      ...body,
      max_output_tokens: LOCAL_OUTPUT_CAP,
      input: [{ role: "user", content: "日本語 🦉" }],
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object", properties: { term: { type: "string" } } } },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
            /** @external JSON schema field */
            additionalProperties: false,
            required: ["text"],
          },
          /** @external JSON schema field */
          strict: true,
        },
      },
    },
    fetch: async (url) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      calls.urls = [...calls.urls, url];

      return Response.json(directResult);
    },
  });
  assert.equal(result.isOk, true);
  assert.equal(calls.urls.length, 1);
});
void test("SDK serialization exceeding the reserved bound never dispatches", async () => {
  await assert.rejects(
    executeOpenAIResponses({
      apiKey: API_KEY,
      billing: { ...localBilling, maxInputTokens: 1 },
      maxRetries: 0,
      body,
      fetch: async () => assert.fail("oversized serialized input must not dispatch"),
    }),
    OpenAIRequestNotDispatchedError,
  );
});
void test("local bounds reject encrypted history and hosted tools before provider dispatch", async () => {
  await Promise.all(
    [
      { ...body, input: [{ type: "reasoning", id: "remote", encrypted_content: "opaque" }] },
      { ...body, tools: [{ type: "web_search" }] },
      { ...body, previous_response_id: "remote" },
    ].map(async (unsupported) => {
      await assert.rejects(
        executeOpenAIResponses({
          apiKey: API_KEY,
          billing: localBilling,
          maxRetries: 0,
          body: unsupported,
          fetch: async () => assert.fail("unbounded request must not dispatch"),
        }),
        OpenAIRequestNotDispatchedError,
      );
    }),
  );
});
