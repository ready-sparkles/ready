import assert from "node:assert/strict";
import test from "node:test";

import { calculateOpenAIUsageCostMicroUsd, extractOpenAIResponseUsage } from "../domain/openai-usage";

const INPUT_TOKENS_SAMPLE = 1200;
const OUTPUT_TOKENS_SAMPLE = 80;
const CACHED_INPUT_TOKENS_SAMPLE = 300;
const TOTAL_TOKENS_SAMPLE = 1280;
const INPUT_TOKENS_PRICING = 1000;
const OUTPUT_TOKENS_PRICING = 200;
const TOTAL_TOKENS_PRICING = 1200;
const EXPECTED_COST_MICRO_USD = 450;
const TEST_MODEL_INPUT_PRICE_PER_MILLION = 0.2;
const TEST_MODEL_OUTPUT_PRICE_PER_MILLION = 1.25;

void test("extractOpenAIResponseUsage reads Responses API token usage", () => {
  const usage = extractOpenAIResponseUsage({
    usage: {
      input_tokens: INPUT_TOKENS_SAMPLE,
      output_tokens: OUTPUT_TOKENS_SAMPLE,
      total_tokens: TOTAL_TOKENS_SAMPLE,
      input_tokens_details: {
        cached_tokens: CACHED_INPUT_TOKENS_SAMPLE,
      },
    },
  });

  assert.deepEqual(usage, {
    inputTokens: INPUT_TOKENS_SAMPLE,
    outputTokens: OUTPUT_TOKENS_SAMPLE,
    cachedInputTokens: CACHED_INPUT_TOKENS_SAMPLE,
    totalTokens: TOTAL_TOKENS_SAMPLE,
  });
});

void test("usage costs retain configured input and output pricing", () => {
  const cost = calculateOpenAIUsageCostMicroUsd({
    price: {
      inputPerMillion: TEST_MODEL_INPUT_PRICE_PER_MILLION,
      outputPerMillion: TEST_MODEL_OUTPUT_PRICE_PER_MILLION,
    },
    usage: {
      inputTokens: INPUT_TOKENS_PRICING,
      outputTokens: OUTPUT_TOKENS_PRICING,
      cachedInputTokens: 0,
      totalTokens: TOTAL_TOKENS_PRICING,
    },
  });
  assert.equal(cost.rateConfigured, true);
  assert.equal(cost.costMicroUsd, EXPECTED_COST_MICRO_USD);
});
