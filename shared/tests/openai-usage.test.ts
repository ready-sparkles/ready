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

const USAGE = {
  inputTokens: INPUT_TOKENS,
  outputTokens: OUTPUT_TOKENS,
  cachedInputTokens: CACHED_TOKENS,
  totalTokens: TOTAL_TOKENS_SAMPLE,
};
const PRICE_CASES = [
  {
    price: { inputPerMillion: INPUT_RATE, cachedInputPerMillion: CACHED_RATE, outputPerMillion: OUTPUT_RATE },
    expected: DISCOUNTED_COST,
  },
  { price: { inputPerMillion: INPUT_RATE, outputPerMillion: OUTPUT_RATE }, expected: UNDISCOUNTED_COST },
  { price: { outputPerMillion: OUTPUT_RATE }, expected: OUTPUT_ONLY_COST },
  { price: { totalPerMillion: TOTAL_RATE, outputPerMillion: OUTPUT_RATE }, expected: TOTAL_RATE_COST },
  { price: { totalPerMillion: -1 }, expected: 0 },
];

void test("shared price arithmetic retains rates and exact result metadata", () => {
  PRICE_CASES.forEach(({ price, expected }) => {
    const result = calculateOpenAIUsageCostMicroUsd({ usage: USAGE, price });
    assert.equal(result.costMicroUsd, expected);
    assert.equal(result.rateConfigured, true);
    assert.equal(result.price, price);
  });
  [undefined, {}, { cachedInputPerMillion: 1 }].forEach((price) => {
    assert.deepEqual(calculateOpenAIUsageCostMicroUsd({ usage: USAGE, price }), {
      costMicroUsd: 0,
      /** @external rateConfigured */ rateConfigured: false,
      unitPriceMicroUsd: null,
      price,
    });
  });
});

void test("shared extraction preserves the response usage fields", () => {
  assert.deepEqual(
    extractOpenAIResponseUsage({
      usage: {
        input_tokens: USAGE.inputTokens,
        output_tokens: USAGE.outputTokens,
        input_tokens_details: { cached_tokens: USAGE.cachedInputTokens },
      },
    }),
    USAGE,
  );
  assert.equal(extractOpenAIResponseUsage({ usage: { total_tokens: 0 } }), null);
});

void test("model price parsing ignores invalid JSON and invalid shapes", () => {
  const price = { inputPerMillion: INPUT_RATE, outputPerMillion: OUTPUT_RATE };
  assert.deepEqual(parseOpenAIModelPrices(JSON.stringify({ fixture: price })), { fixture: price });
  ["broken", "[]", JSON.stringify({ fixture: { inputPerMillion: "2" } })].forEach((json) => {
    assert.deepEqual(parseOpenAIModelPrices(json), {});
  });
});
