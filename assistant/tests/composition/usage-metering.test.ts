import "../../composition/wire";

import { extractOpenAIResponseUsage } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { executeMeteredOpenAIResponse } from "../../application/usage-metering";
import { assistantEnv } from "../../ports/assistant-env";
import { mockAssistantUsageMetering } from "../usage-metering-fixture";

const INPUT_TOKENS = 100;
const OUTPUT_TOKENS = 20;
const CACHED_TOKENS = 40;
const INPUT_RATE = 2;
const CACHED_RATE = 0.5;
const OUTPUT_RATE = 4;
const MAX_CONTEXT_TOKENS = 1000;
const EXPECTED_COST = 220;
const TOTAL_TOKENS = 120;

void test("assistant metering preserves owner, metadata, retry key and cost before returning", async (t) => {
  const fixture = mockAssistantUsageMetering(t);
  const previousGatewayKey = assistantEnv().AI_GATEWAY_API_KEY;
  assistantEnv().AI_GATEWAY_API_KEY = "fixture";
  t.after(() => {
    assistantEnv().AI_GATEWAY_API_KEY = previousGatewayKey;
  });
  assistantEnv().OPENAI_MODEL_PRICES_JSON = JSON.stringify({
    fixture: {
      inputPerMillion: INPUT_RATE,
      cachedInputPerMillion: CACHED_RATE,
      outputPerMillion: OUTPUT_RATE,
      maxContextTokens: MAX_CONTEXT_TOKENS,
    },
  });
  const response = {
    id: "response",
    totalUsage: {
      inputTokens: INPUT_TOKENS,
      outputTokens: OUTPUT_TOKENS,
      cachedInputTokens: CACHED_TOKENS,
    },
  };
  const result = await executeMeteredOpenAIResponse({
    meetingId: "meeting",
    source: "meeting_summary",
    body: { model: "fixture", max_output_tokens: OUTPUT_TOKENS, input: "Hello" },
    client: { responses: { create: async () => response } },
  });
  assert.equal(result, response);
  const record = fixture.usage.mock.calls[0]?.arguments[0];
  assert.ok(record);
  assert.equal(record.userId, "creator");
  assert.equal(record.meetingId, "meeting");
  assert.equal(record.provider, "openai");
  assert.equal(record.model, "fixture");
  assert.equal(record.unitCount, TOTAL_TOKENS);
  assert.equal(record.costMicroUsd, EXPECTED_COST);
  assert.equal(record.idempotencyKey, "openai:response:meeting_summary");
  assert.equal(fixture.admission.mock.callCount(), 1);
  assert.equal(fixture.credits.mock.callCount(), 1);
  assert.equal(fixture.credits.mock.calls[0]?.arguments[0].providerCostMicroUsd, EXPECTED_COST);
  assert.equal(extractOpenAIResponseUsage({ usage: { input_tokens: -1, output_tokens: Infinity } }), null);
});
