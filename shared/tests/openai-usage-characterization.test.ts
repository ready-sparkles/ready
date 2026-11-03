import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateOpenAIUsageCostMicroUsd,
  extractOpenAIResponseUsage,
  parseOpenAIModelPrices,
} from "../domain/openai-usage";

const INPUT_TOKENS = 100;
const OUTPUT_TOKENS = 20;
const CACHED_TOKENS = 40;
const TOTAL_TOKENS_SAMPLE = 120;
const INPUT_RATE = 2;
const CACHED_RATE = 0.5;
const OUTPUT_RATE = 4;
const DISCOUNTED_COST = 220;
const UNDISCOUNTED_COST = 280;
const OUTPUT_ONLY_COST = 80;
const TOTAL_RATE = 3;
const TOTAL_RATE_COST = 360;
const FRACTIONAL_RATE = 0.125;
const FRACTIONAL_COST = 15;
const FRACTIONAL_INPUT_TOKENS = 1.6;
const FRACTIONAL_OUTPUT_TOKENS = 2.2;
const ROUNDED_TOKEN_COUNT = 2;
const ROUNDED_TOKEN_TOTAL = 4;

const USAGE = {
  inputTokens: INPUT_TOKENS,
  outputTokens: OUTPUT_TOKENS,
  cachedInputTokens: CACHED_TOKENS,
  totalTokens: TOTAL_TOKENS_SAMPLE,
};
const PRICING_CASES = [
  {
    price: { inputPerMillion: INPUT_RATE, cachedInputPerMillion: CACHED_RATE, outputPerMillion: OUTPUT_RATE },
    expected: DISCOUNTED_COST,
    unitPrice: null,
  },
  {
    price: { inputPerMillion: INPUT_RATE, outputPerMillion: OUTPUT_RATE },
    expected: UNDISCOUNTED_COST,
    unitPrice: null,
  },
  { price: { outputPerMillion: OUTPUT_RATE }, expected: OUTPUT_ONLY_COST, unitPrice: null },
  {
    price: { inputPerMillion: INPUT_RATE, outputPerMillion: OUTPUT_RATE, totalPerMillion: TOTAL_RATE },
    expected: TOTAL_RATE_COST,
    unitPrice: TOTAL_RATE,
  },
  { price: { totalPerMillion: FRACTIONAL_RATE }, expected: FRACTIONAL_COST, unitPrice: 0 },
];

void test("usage parsing retains aliases, normalization and missing-usage behavior", () => {
  [null, [], {}, { usage: [] }, { usage: {} }, { usage: { input_tokens: -1, output_tokens: Infinity } }].forEach(
    (response) => {
      assert.equal(extractOpenAIResponseUsage(response), null);
    },
  );
  const response = {
    usage: {
      prompt_tokens: FRACTIONAL_INPUT_TOKENS,
      completion_tokens: FRACTIONAL_OUTPUT_TOKENS,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 1 },
    },
  };
  assert.deepEqual(extractOpenAIResponseUsage(response), {
    inputTokens: ROUNDED_TOKEN_COUNT,
    outputTokens: ROUNDED_TOKEN_COUNT,
    totalTokens: ROUNDED_TOKEN_TOTAL,
    cachedInputTokens: 1,
  });
  assert.deepEqual(extractOpenAIResponseUsage({ usage: { input_tokens: NaN, output_tokens: "2", total_tokens: 1 } }), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 1,
  });
});

void test("pricing preserves cached discounts, fallbacks, precedence and rounding", () => {
  PRICING_CASES.forEach(({ price, expected, unitPrice }) => {
    assert.deepEqual(calculateOpenAIUsageCostMicroUsd({ usage: USAGE, price }), {
      costMicroUsd: expected,
      /** @external rateConfigured */ rateConfigured: true,
      unitPriceMicroUsd: unitPrice,
      price,
    });
  });
  const price = { inputPerMillion: INPUT_RATE, cachedInputPerMillion: CACHED_RATE };
  const expectedCappedCost = 50;
  assert.equal(
    calculateOpenAIUsageCostMicroUsd({ usage: { ...USAGE, cachedInputTokens: USAGE.totalTokens }, price }).costMicroUsd,
    expectedCappedCost,
  );
  ["broken", "{}"].forEach((prices) => {
    assert.deepEqual(
      calculateOpenAIUsageCostMicroUsd({ usage: USAGE, price: parseOpenAIModelPrices(prices).fixture }),
      {
        costMicroUsd: 0,
        /** @external rateConfigured */ rateConfigured: false,
        unitPriceMicroUsd: null,
        price: undefined,
      },
    );
  });
});
