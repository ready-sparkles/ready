import assert from "node:assert/strict";
import test from "node:test";

import { planCreditGrantConsumption } from "../adapters/secondary/postgres/workspace-billing";

const GRANT_EXPIRING_SOON_CREDITS = 30;
const GRANT_EXPIRING_LATER_CREDITS = 100;
const GRANT_NEVER_EXPIRES_CREDITS = 500;
const CHARGE_NINETY_CREDITS = 90;
const CONSUME_FROM_LATER_CREDITS = 60;
const GRANT_ONLY_TEN_CREDITS = 10;
const CHARGE_TWENTY_FIVE_CREDITS = 25;
const UNCOVERED_FIFTEEN_CREDITS = 15;
const GRANT_FUNDED_FIVE_CREDITS = 5;
const CHARGE_THREE_CREDITS = 3;

void test("consumption drains grants in order until the charge is covered", () => {
  const plan = planCreditGrantConsumption({
    grants: [
      { id: "expiring-soon", creditsRemaining: GRANT_EXPIRING_SOON_CREDITS },
      { id: "expiring-later", creditsRemaining: GRANT_EXPIRING_LATER_CREDITS },
      { id: "never-expires", creditsRemaining: GRANT_NEVER_EXPIRES_CREDITS },
    ],
    credits: CHARGE_NINETY_CREDITS,
  });

  assert.deepEqual(plan.consumed, [
    { id: "expiring-soon", consume: GRANT_EXPIRING_SOON_CREDITS },
    { id: "expiring-later", consume: CONSUME_FROM_LATER_CREDITS },
  ]);
  assert.equal(plan.uncoveredCredits, 0);
});

void test("consumption reports credits that no grant can cover", () => {
  const plan = planCreditGrantConsumption({
    grants: [{ id: "only-grant", creditsRemaining: GRANT_ONLY_TEN_CREDITS }],
    credits: CHARGE_TWENTY_FIVE_CREDITS,
  });

  assert.deepEqual(plan.consumed, [{ id: "only-grant", consume: GRANT_ONLY_TEN_CREDITS }]);
  assert.equal(plan.uncoveredCredits, UNCOVERED_FIFTEEN_CREDITS);
});

void test("consumption skips empty grants and ignores non-positive charges", () => {
  const emptyGrantPlan = planCreditGrantConsumption({
    grants: [
      { id: "empty", creditsRemaining: 0 },
      { id: "funded", creditsRemaining: GRANT_FUNDED_FIVE_CREDITS },
    ],
    credits: CHARGE_THREE_CREDITS,
  });
  assert.deepEqual(emptyGrantPlan.consumed, [{ id: "funded", consume: CHARGE_THREE_CREDITS }]);

  const zeroChargePlan = planCreditGrantConsumption({
    grants: [{ id: "funded", creditsRemaining: GRANT_FUNDED_FIVE_CREDITS }],
    credits: 0,
  });
  assert.deepEqual(zeroChargePlan.consumed, []);
  assert.equal(zeroChargePlan.uncoveredCredits, 0);
});
