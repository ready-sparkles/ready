import { DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL, DEFAULT_OPENAI_MODEL_PRICES_JSON } from "@readymeet/shared";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { apiEnvSchema, DEFAULT_ADMIN_EMAILS } from "../../ports/env-schema";

const SNAPSHOT_MODEL = "gpt-5.6-sol";
const SNAPSHOT_CONTEXT_TOKENS = 1_050_000;
const STALE_INPUT_PRICE = 5;
const STALE_CACHED_INPUT_PRICE = 0.5;
const STALE_OUTPUT_PRICE = 30;
// The shape of the old assistant/.env.example value: prices only, no context limits.
const STALE_PRICE_OVERRIDE = JSON.stringify({
  [SNAPSHOT_MODEL]: {
    inputPerMillion: STALE_INPUT_PRICE,
    cachedInputPerMillion: STALE_CACHED_INPUT_PRICE,
    outputPerMillion: STALE_OUTPUT_PRICE,
  },
});
const NOT_JSON = "{gpt-5.6-sol:";
const UNKNOWN_MODEL_WITHOUT_CONTEXT = JSON.stringify({
  "gpt-9-custom": { inputPerMillion: STALE_INPUT_PRICE, outputPerMillion: STALE_OUTPUT_PRICE },
});
const CUSTOM_CONTEXT_TOKENS = 64_000;
// Accepted by the assistant's cost formula but not by the API's metered pricing.
const TOTAL_RATE_ONLY = JSON.stringify({
  "gpt-9-custom": { totalPerMillion: STALE_OUTPUT_PRICE, maxContextTokens: CUSTOM_CONTEXT_TOKENS },
});
const NEGATIVE_PRICE = JSON.stringify({ [SNAPSHOT_MODEL]: { outputPerMillion: -1 } });

void test("admin emails default to the original admin, normalize, and accept a comma-separated list", () => {
  const schema = apiEnvSchema.shape.ADMIN_EMAIL;
  assert.deepEqual(schema.parse(undefined), [...DEFAULT_ADMIN_EMAILS]);
  assert.deepEqual(schema.parse(""), [...DEFAULT_ADMIN_EMAILS]);
  assert.deepEqual(schema.parse(" , "), [...DEFAULT_ADMIN_EMAILS]);
  assert.deepEqual(schema.parse(" Admin@Example.Com "), ["admin@example.com"]);
  assert.deepEqual(schema.parse("admin@example.com, Other@Example.com,admin@example.com"), [
    "admin@example.com",
    "other@example.com",
  ]);
  ["not-an-email", "admin@example.com,not-an-email", "*"].forEach((value) => {
    assert.equal(schema.safeParse(value).success, false, value);
  });
});

void test("OpenAI count billing requires literal free attestation and defaults to unverified", () => {
  const schema = apiEnvSchema.shape.OPENAI_INPUT_TOKEN_COUNT_BILLING;
  assert.equal(schema.parse(undefined), "unverified");
  assert.equal(schema.parse("unverified"), "unverified");
  assert.equal(schema.parse("free"), "free");
  [true, false, "true", "false", "1", "", "FREE"].forEach((value) => {
    assert.equal(schema.safeParse(value).success, false);
  });
});

void test("the API prices the notes gate with the assistant's default notes model", () => {
  assert.equal(
    apiEnvSchema.shape.OPENAI_MEETING_SNAPSHOT_MODEL.parse(undefined),
    DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL,
  );
});

void test("default API model pricing does not require deployment-time JSON", () => {
  const schema = apiEnvSchema.shape.OPENAI_MODEL_PRICES_JSON;
  assert.equal(schema.parse(undefined), DEFAULT_OPENAI_MODEL_PRICES_JSON);
  assert.equal(schema.parse(""), DEFAULT_OPENAI_MODEL_PRICES_JSON);
  assert.equal(schema.parse("{}"), DEFAULT_OPENAI_MODEL_PRICES_JSON);
});

void test("API model price overrides keep built-in limits and bad prices fail at startup", () => {
  const schema = apiEnvSchema.shape.OPENAI_MODEL_PRICES_JSON;
  const resolved = z
    .object({ [SNAPSHOT_MODEL]: z.object({ maxContextTokens: z.number(), outputPerMillion: z.number() }) })
    .parse(JSON.parse(schema.parse(STALE_PRICE_OVERRIDE)));
  assert.equal(resolved[SNAPSHOT_MODEL].outputPerMillion, STALE_OUTPUT_PRICE);
  assert.equal(resolved[SNAPSHOT_MODEL].maxContextTokens, SNAPSHOT_CONTEXT_TOKENS);
  [NOT_JSON, UNKNOWN_MODEL_WITHOUT_CONTEXT, TOTAL_RATE_ONLY, NEGATIVE_PRICE].forEach((value) => {
    assert.equal(schema.safeParse(value).success, false, value);
  });
});
