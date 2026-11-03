/* eslint-disable @typescript-eslint/no-magic-numbers -- Fixed provider token counts and caps. */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { createOpenAIClient } from "../../../../adapters/secondary/openai/client";
import { gatewayTextResponse } from "../../../usage-metering-fixture";

const billing = { userId: "member", workspaceId: "workspace", feature: "summary", gatewayApiKey: "gateway-key" };
const body = { model: "gpt-5.4-mini", input: [{ role: "user", content: "Hi" }], max_output_tokens: 1024 };
const REQUEST_SCHEMA = z.object({
  providerOptions: z.object({ gateway: z.object({ user: z.string(), tags: z.array(z.string()) }) }),
});
const PROVIDER_ERROR_CODE = "credit_balance_exhausted";
const PRIVATE_KEY_MESSAGE = "Incorrect key sk-proj-abc123SECRETxyz";
const NETWORK_ERROR = "network socket hang up";
const ABORT_ERROR = "Request was aborted.";
const ERROR_STATUS = 429;

void test("assistant client requires billing identity before fetch", async (t) => {
  const fetch = t.mock.fn(async () => Response.json(gatewayTextResponse("Hello")));
  await assert.rejects(createOpenAIClient({ apiKey: "unused", fetch }).responses.create(body), /billing identity/);
  assert.equal(fetch.mock.callCount(), 0);
});

void test("assistant client uses Gateway member tags and exposes normalized totalUsage", async (t) => {
  const fetch = t.mock.fn<typeof globalThis.fetch>(async (url, init) => {
    assert.match(url instanceof Request ? url.url : url.toString(), /ai-gateway.vercel.sh/);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gateway-key");
    const request = REQUEST_SCHEMA.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    assert.deepEqual(request.providerOptions.gateway, {
      user: "member",
      tags: ["workspace:workspace", "feature:summary"],
    });

    return Response.json(gatewayTextResponse("Hello"));
  });
  const response = await createOpenAIClient({ apiKey: "unused", fetch }).responses.create(body, { billing });
  assert.equal(response.output_text, "Hello");
  assert.deepEqual(response.totalUsage, {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  });
  assert.equal(fetch.mock.callCount(), 1);
});

void test("assistant never enables hidden SDK retries even when caller requests them", async (t) => {
  const fetch = t.mock.fn(async () => {
    throw new Error(NETWORK_ERROR);
  });
  await assert.rejects(
    createOpenAIClient({ apiKey: "unused", maxRetries: 2, fetch }).responses.create(body, { billing }),
  );
  assert.equal(fetch.mock.callCount(), 1);
});

void test("assistant preserves cancellation without retrying", async (t) => {
  const controller = new AbortController();
  const fetch = t.mock.fn(async () => {
    controller.abort();
    throw new Error(ABORT_ERROR);
  });
  await assert.rejects(
    createOpenAIClient({ apiKey: "unused", fetch }).responses.create(body, { billing, signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(fetch.mock.callCount(), 1);
});

void test("assistant Gateway errors retain provider status/code and redact secrets without retry", async (t) => {
  const fetch = t.mock.fn(async () =>
    Response.json(
      {
        error: {
          code: PROVIDER_ERROR_CODE,
          type: "insufficient_quota",
          message: PRIVATE_KEY_MESSAGE,
        },
      },
      { status: ERROR_STATUS },
    ),
  );
  const pending = createOpenAIClient({ apiKey: "unused", fetch }).responses.create(body, { billing });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /429/);
    assert.match(error.message, /credit_balance_exhausted/);
    assert.equal(error.message.includes("abc123SECRETxyz"), false);

    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});
