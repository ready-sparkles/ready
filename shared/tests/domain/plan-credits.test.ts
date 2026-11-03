import assert from "node:assert/strict";
import test from "node:test";

import { calculatePlanCredits, PLAN_CREDITS } from "../../domain/plan-credits";

const EXACT_COST = 700_000;
const DOLLAR_MICRO_USD = 1_000_000;
const EXACT_PRO_CREDITS = 100;
const EXACT_MAX_CREDITS = 10;
const DOLLAR_PRO_CREDITS = 143;
const DOLLAR_MAX_CREDITS = 15;
const MONTHLY_ALLOWANCE = 250;
const PRO_COST_PER_CREDIT = 7_000;
const MAX_COST_PER_CREDIT = 70_000;
const NEXT_CREDIT = 2;
const ONE_BIGINT = 1n;
const FRACTIONAL_COST = 0.5;

void test("fixed provider cost has a tenfold price ratio before independent ceiling", () => {
  assert.equal(
    calculatePlanCredits({ providerCostMicroUsd: EXACT_COST, plan: "pro", isIncluded: false }),
    EXACT_PRO_CREDITS,
  );
  assert.equal(
    calculatePlanCredits({ providerCostMicroUsd: EXACT_COST, plan: "max", isIncluded: false }),
    EXACT_MAX_CREDITS,
  );
  assert.equal(
    calculatePlanCredits({ providerCostMicroUsd: DOLLAR_MICRO_USD, plan: "pro", isIncluded: false }),
    DOLLAR_PRO_CREDITS,
  );
  assert.equal(
    calculatePlanCredits({ providerCostMicroUsd: DOLLAR_MICRO_USD, plan: "max", isIncluded: false }),
    DOLLAR_MAX_CREDITS,
  );
});
void test("both plans receive 250 monthly credits", () => {
  assert.equal(PLAN_CREDITS.pro.monthlyAllowance, MONTHLY_ALLOWANCE);
  assert.equal(PLAN_CREDITS.max.monthlyAllowance, MONTHLY_ALLOWANCE);
});
void test("zero and included calls charge zero; positive calls round up", () => {
  (["pro", "max"] as const).forEach((plan) => {
    assert.equal(calculatePlanCredits({ providerCostMicroUsd: 0, plan, isIncluded: false }), 0);
    assert.equal(calculatePlanCredits({ providerCostMicroUsd: DOLLAR_MICRO_USD, plan, isIncluded: true }), 0);
    assert.equal(calculatePlanCredits({ providerCostMicroUsd: 1, plan, isIncluded: false }), 1);
  });
});
void test("whole-credit boundaries do not gain an extra credit from floating-point margin math", () => {
  (["pro", "max"] as const).forEach((plan) => {
    const boundary = plan === "pro" ? PRO_COST_PER_CREDIT : MAX_COST_PER_CREDIT;
    assert.equal(calculatePlanCredits({ providerCostMicroUsd: boundary - 1, plan, isIncluded: false }), 1);
    assert.equal(calculatePlanCredits({ providerCostMicroUsd: boundary, plan, isIncluded: false }), 1);
    assert.equal(calculatePlanCredits({ providerCostMicroUsd: boundary + 1, plan, isIncluded: false }), NEXT_CREDIT);
    const largestCost = Number.MAX_SAFE_INTEGER;
    const exactCeiling = (BigInt(largestCost) + BigInt(boundary) - ONE_BIGINT) / BigInt(boundary);
    assert.equal(
      calculatePlanCredits({ providerCostMicroUsd: largestCost, plan, isIncluded: false }),
      Number(exactCeiling),
    );
  });
});
void test("invalid provider costs are rejected even for included calls", () => {
  [-1, NaN, Infinity, FRACTIONAL_COST, Number.MAX_SAFE_INTEGER + 1].forEach((providerCostMicroUsd) => {
    [false, true].forEach((isIncluded) => {
      assert.throws(() => calculatePlanCredits({ providerCostMicroUsd, plan: "pro", isIncluded }), RangeError);
    });
  });
});
