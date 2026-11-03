import { DEFAULT_OPENAI_MODEL_PRICES_JSON } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { assistantEnvSchema } from "../../ports/assistant-env";

const BASE_ENV = { DATABASE_URL: "postgres://localhost/not-used", ASSISTANT_SERVICE_SECRET: "test" };
const SNAPSHOT_MODEL = "gpt-5.6-sol";
const SNAPSHOT_CONTEXT_TOKENS = 1_050_000;
const STALE_INPUT_PRICE = 5;
const STALE_OUTPUT_PRICE = 30;
const PRICES_ONLY_OVERRIDE = JSON.stringify({
  [SNAPSHOT_MODEL]: { inputPerMillion: STALE_INPUT_PRICE, outputPerMillion: STALE_OUTPUT_PRICE },
});
const UNKNOWN_MODEL_WITHOUT_CONTEXT = JSON.stringify({
  "gpt-9-custom": { inputPerMillion: STALE_INPUT_PRICE, outputPerMillion: STALE_OUTPUT_PRICE },
});

void test("assistant pricing falls back to built-in tariffs and context limits", () => {
  assert.equal(assistantEnvSchema.parse(BASE_ENV).OPENAI_MODEL_PRICES_JSON, DEFAULT_OPENAI_MODEL_PRICES_JSON);
  const resolved = z
    .object({ [SNAPSHOT_MODEL]: z.object({ maxContextTokens: z.number(), outputPerMillion: z.number() }) })
    .parse(
      JSON.parse(
        assistantEnvSchema.parse({ ...BASE_ENV, OPENAI_MODEL_PRICES_JSON: PRICES_ONLY_OVERRIDE })
          .OPENAI_MODEL_PRICES_JSON,
      ),
    );
  assert.equal(resolved[SNAPSHOT_MODEL].maxContextTokens, SNAPSHOT_CONTEXT_TOKENS);
});

void test("assistant refuses to start with prices that would fail every request", () => {
  const result = assistantEnvSchema.safeParse({ ...BASE_ENV, OPENAI_MODEL_PRICES_JSON: UNKNOWN_MODEL_WITHOUT_CONTEXT });
  assert.ok(!result.success);
  assert.match(result.error.message, /gpt-9-custom needs maxContextTokens/);
});
