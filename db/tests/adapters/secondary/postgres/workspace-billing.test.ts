import assert from "node:assert/strict";
import test from "node:test";

import {
  getCurrentMonthlyWindow,
  planWorkspaceCreditDraw,
} from "../../../../adapters/secondary/postgres/workspace-billing";

// --- getCurrentMonthlyWindow ---------------------------------------------------

const ANCHOR = new Date("2026-01-20T10:00:00.000Z");
const WINDOW_INDEX_FIRST = 0;
const WINDOW_INDEX_THIRD_MONTH = 2;
const WINDOW_INDEX_THIRTEENTH_MONTH = 12;

const POOL_GRANT_A_REMAINING = 5;
const POOL_GRANT_B_REMAINING = 10;
const DRAW_WITHIN_ALLOWANCE_CREDITS = 6;
const MONTHLY_ALLOWANCE_CREDITS = 10;
const ALLOWANCE_USED_BEFORE_PARTIAL = 2;
const DRAW_OVERFLOW_CREDITS = 10;
const ALLOWANCE_USED_BEFORE_NEAR_LIMIT = 7;
const ALLOWANCE_DRAW_FROM_REMAINDER = 3;
const POOL_CONSUME_FROM_GRANT_A = 5;
const POOL_CONSUME_FROM_GRANT_B = 2;
const SUSPENDED_MEMBER_DRAW_CREDITS = 4;
const POOL_ONLY_CONSUME = 4;
const EXHAUSTED_DRAW_CREDITS = 25;
const FULLY_USED_ALLOWANCE = 10;
const UNCOVERED_CREDITS_REMAINDER = 10;
const ZERO_CREDIT_CHARGE = 0;
const ZERO_ALLOWANCE_USED = 0;

void test("now inside the first month maps to window 0 starting at the anchor", () => {
  const window = getCurrentMonthlyWindow({
    anchor: ANCHOR,
    now: new Date("2026-02-10T00:00:00.000Z"),
  });
  assert.ok(window);
  assert.equal(window.windowIndex, WINDOW_INDEX_FIRST);
  assert.equal(window.windowStart.toISOString(), ANCHOR.toISOString());
  assert.equal(window.windowEnd.toISOString(), "2026-02-20T10:00:00.000Z");
});

void test("later months advance the window, anchored on the period start day", () => {
  const window = getCurrentMonthlyWindow({
    anchor: ANCHOR,
    now: new Date("2026-03-25T00:00:00.000Z"),
  });
  assert.ok(window);
  assert.equal(window.windowIndex, WINDOW_INDEX_THIRD_MONTH);
  assert.equal(window.windowStart.toISOString(), "2026-03-20T10:00:00.000Z");
  assert.equal(window.windowEnd.toISOString(), "2026-04-20T10:00:00.000Z");
});

void test("a month-end anchor clamps to shorter months instead of drifting", () => {
  const window = getCurrentMonthlyWindow({
    anchor: new Date("2026-01-31T00:00:00.000Z"),
    now: new Date("2026-02-10T00:00:00.000Z"),
  });
  assert.ok(window);
  assert.equal(window.windowIndex, WINDOW_INDEX_FIRST);
  // February 2026 has 28 days; the window must not spill into March 3rd.
  assert.equal(window.windowEnd.toISOString(), "2026-02-28T00:00:00.000Z");
});

void test("no window before the anchor or after the period end", () => {
  assert.equal(getCurrentMonthlyWindow({ anchor: ANCHOR, now: new Date("2026-01-19T00:00:00.000Z") }), null);
  assert.equal(
    getCurrentMonthlyWindow({
      anchor: ANCHOR,
      now: new Date("2026-02-21T00:00:00.000Z"),
      periodEnd: new Date("2026-02-20T10:00:00.000Z"),
    }),
    null,
  );
});

void test("the thirteenth month still resolves (index 12) while it contains now", () => {
  const window = getCurrentMonthlyWindow({
    anchor: ANCHOR,
    now: new Date("2027-02-01T00:00:00.000Z"),
  });
  assert.ok(window);
  assert.equal(window.windowIndex, WINDOW_INDEX_THIRTEENTH_MONTH);
  assert.equal(window.windowStart.toISOString(), "2027-01-20T10:00:00.000Z");
});

void test("a pathologically stale anchor yields no window instead of a dead one", () => {
  // Past the 12-window loop cap the capped window no longer contains `now`;
  // returning it would compute allowance usage against long-dead dates.
  assert.equal(getCurrentMonthlyWindow({ anchor: ANCHOR, now: new Date("2029-06-01T00:00:00.000Z") }), null);
});

// --- planWorkspaceCreditDraw ------------------------------------------------------

const POOL = [
  { id: "grant-a", creditsRemaining: POOL_GRANT_A_REMAINING },
  { id: "grant-b", creditsRemaining: POOL_GRANT_B_REMAINING },
];

void test("the member allowance absorbs the whole charge when it can", () => {
  const draw = planWorkspaceCreditDraw({
    credits: DRAW_WITHIN_ALLOWANCE_CREDITS,
    allowanceCredits: MONTHLY_ALLOWANCE_CREDITS,
    allowanceUsedBefore: ALLOWANCE_USED_BEFORE_PARTIAL,
    poolGrants: POOL,
  });
  assert.equal(draw.fromAllowance, DRAW_WITHIN_ALLOWANCE_CREDITS);
  assert.deepEqual(draw.poolConsumed, []);
  assert.equal(draw.uncoveredCredits, ZERO_CREDIT_CHARGE);
});

void test("overflow past the allowance drains pool grants in order", () => {
  const draw = planWorkspaceCreditDraw({
    credits: DRAW_OVERFLOW_CREDITS,
    allowanceCredits: MONTHLY_ALLOWANCE_CREDITS,
    allowanceUsedBefore: ALLOWANCE_USED_BEFORE_NEAR_LIMIT,
    poolGrants: POOL,
  });
  assert.equal(draw.fromAllowance, ALLOWANCE_DRAW_FROM_REMAINDER);
  assert.deepEqual(draw.poolConsumed, [
    { id: "grant-a", consume: POOL_CONSUME_FROM_GRANT_A },
    { id: "grant-b", consume: POOL_CONSUME_FROM_GRANT_B },
  ]);
  assert.equal(draw.uncoveredCredits, ZERO_CREDIT_CHARGE);
});

void test("a zero allowance (suspended member) is pool-only", () => {
  const draw = planWorkspaceCreditDraw({
    credits: SUSPENDED_MEMBER_DRAW_CREDITS,
    allowanceCredits: ZERO_CREDIT_CHARGE,
    allowanceUsedBefore: ZERO_ALLOWANCE_USED,
    poolGrants: POOL,
  });
  assert.equal(draw.fromAllowance, ZERO_CREDIT_CHARGE);
  assert.deepEqual(draw.poolConsumed, [{ id: "grant-a", consume: POOL_ONLY_CONSUME }]);
});

void test("an exhausted allowance and pool reports the uncovered remainder", () => {
  const draw = planWorkspaceCreditDraw({
    credits: EXHAUSTED_DRAW_CREDITS,
    allowanceCredits: MONTHLY_ALLOWANCE_CREDITS,
    allowanceUsedBefore: FULLY_USED_ALLOWANCE,
    poolGrants: POOL,
  });
  assert.equal(draw.fromAllowance, ZERO_CREDIT_CHARGE);
  assert.equal(draw.uncoveredCredits, UNCOVERED_CREDITS_REMAINDER);
});

void test("zero-credit charges never draw from anything", () => {
  const draw = planWorkspaceCreditDraw({
    credits: ZERO_CREDIT_CHARGE,
    allowanceCredits: MONTHLY_ALLOWANCE_CREDITS,
    allowanceUsedBefore: ZERO_ALLOWANCE_USED,
    poolGrants: POOL,
  });
  assert.equal(draw.fromAllowance, ZERO_CREDIT_CHARGE);
  assert.deepEqual(draw.poolConsumed, []);
  assert.equal(draw.uncoveredCredits, ZERO_CREDIT_CHARGE);
});
