import assert from "node:assert/strict";
import test from "node:test";

import { calculateCreditsForAiUsage } from "../adapters/secondary/postgres/repositories";

const HIGH_ACTUAL_COST_MICRO_USD = 1_000_000;
const MEDIUM_ACTUAL_COST_MICRO_USD = 250_000;
const LOW_ACTUAL_COST_MICRO_USD = 10_000;
const PRICE_PER_CREDIT_MICRO_USD = 100_000;
const MARKUP_MULTIPLIER = 5;
const MINIMUM_CREDIT_CHARGE = 1;
const ZERO_MINIMUM_CREDITS = 0;
const EXPECTED_SCALED_CREDITS = 13;
const INVALID_MINIMUM_CREDITS = -5;

void test("included AI actions charge zero credits", () => {
  assert.equal(
    calculateCreditsForAiUsage({
      actualCostMicroUsd: HIGH_ACTUAL_COST_MICRO_USD,
      pricePerCreditMicroUsd: PRICE_PER_CREDIT_MICRO_USD,
      markupMultiplier: MARKUP_MULTIPLIER,
      minimumCredits: MINIMUM_CREDIT_CHARGE,
      isIncluded: true,
    }),
    0,
  );
});

void test("tiny AI costs still charge the configured minimum", () => {
  assert.equal(
    calculateCreditsForAiUsage({
      actualCostMicroUsd: LOW_ACTUAL_COST_MICRO_USD,
      pricePerCreditMicroUsd: PRICE_PER_CREDIT_MICRO_USD,
      markupMultiplier: MARKUP_MULTIPLIER,
      minimumCredits: MINIMUM_CREDIT_CHARGE,
    }),
    MINIMUM_CREDIT_CHARGE,
  );
});

void test("zero-cost AI usage can opt out of the minimum charge", () => {
  assert.equal(
    calculateCreditsForAiUsage({
      actualCostMicroUsd: 0,
      pricePerCreditMicroUsd: PRICE_PER_CREDIT_MICRO_USD,
      markupMultiplier: MARKUP_MULTIPLIER,
      minimumCredits: ZERO_MINIMUM_CREDITS,
    }),
    0,
  );
});

void test("AI credits scale with markup and price per credit", () => {
  assert.equal(
    calculateCreditsForAiUsage({
      actualCostMicroUsd: MEDIUM_ACTUAL_COST_MICRO_USD,
      pricePerCreditMicroUsd: PRICE_PER_CREDIT_MICRO_USD,
      markupMultiplier: MARKUP_MULTIPLIER,
      minimumCredits: MINIMUM_CREDIT_CHARGE,
    }),
    EXPECTED_SCALED_CREDITS,
  );
});

void test("invalid credit inputs fall back to safe defaults", () => {
  assert.equal(
    calculateCreditsForAiUsage({
      actualCostMicroUsd: -1,
      pricePerCreditMicroUsd: 0,
      markupMultiplier: Number.NaN,
      minimumCredits: INVALID_MINIMUM_CREDITS,
    }),
    MINIMUM_CREDIT_CHARGE,
  );
});
