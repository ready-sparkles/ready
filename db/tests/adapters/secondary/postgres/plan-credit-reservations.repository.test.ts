import { CREDIT_PRICE_MICRO_USD, PLAN_CREDITS } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { QueryConfig } from "pg";

import { closeDbPool, db, pool } from "../../../../adapters/secondary/postgres/client";
import {
  getPlanCreditReservation,
  releasePlanCredits,
  releaseStalePlanCreditReservations,
  reservePlanCredits,
  settlePlanCredits,
  STALE_PLAN_CREDIT_RESERVATION_MS,
  sumHeldPlanCredits,
} from "../../../../adapters/secondary/postgres/plan-credit-reservations";
import { ensureWorkspaceMembership, upsertUser } from "../../../../adapters/secondary/postgres/repositories";
import {
  createWorkspaceCreditGrant,
  getWorkspaceCreditBalanceData,
  getWorkspaceMemberCreditAccess,
  updateWorkspacePlan,
  upsertWorkspaceBillingSubscription,
} from "../../../../adapters/secondary/postgres/workspace-billing";
import { InsufficientAiCreditsError, PaidPlanRequiredForCreditsError } from "../../../../domain/persistence-errors";

const ALLOWANCE = PLAN_CREDITS.pro.monthlyAllowance;
const DAY_MS = 86_400_000;
const PERIOD_DAYS = 28;
const CONCURRENT_ATTEMPTS = 3;
const SUCCESSFUL_ATTEMPTS = 2;
const POOL = 100;
const MEETING_HOLD_CREDITS = 10;
const HELD_POOL_BALANCE = 50;
const SETTLED_POOL_BALANCE = 80;
const SETTLED_CREDITS = 270;
const HUNDRED_CREDIT_COST = 700_000;
const ALLOWANCE_COST = 1_750_000;
const RESERVATION_COST = 2_100_000;
const SETTLEMENT_COST = 1_890_000;
const OVER_BOUNDARY_COST = HUNDRED_CREDIT_COST + 1;
const FRACTIONAL_COST = 0.5;
const LEDGER_OVERFLOW = 2_147_483_648;
const LOW_COST = 1;
const HIGHER_COST_SAME_CREDITS = 2;
const PRO_COST_PER_CREDIT = 7_000;
const PLAN_PRICE_RATIO = 10;
const POOL_COST = POOL * PRO_COST_PER_CREDIT;
const USAGE = { provider: "openai", model: "test", feature: "test", inputTokens: 1, outputTokens: 1 };

after(closeDbPool);
async function fixture() {
  const user = await upsertUser({ email: `${randomUUID()}@credits.test`, displayName: "Credit test" });
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "pro" });
  await upsertWorkspaceBillingSubscription({
    workspaceId: user.workspaceId,
    userId: user.id,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripePriceId: "price_pro",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: ALLOWANCE,
    seatQuantity: 1,
    currentPeriodStart: new Date(Date.now() - DAY_MS),
    currentPeriodEnd: new Date(Date.now() + DAY_MS * PERIOD_DAYS),
  });

  return { workspaceId: user.workspaceId, userId: user.id };
}
void test("concurrent reservations cannot spend a member allowance twice", async () => {
  const subject = await fixture();
  const attempts = await Promise.allSettled(
    Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
      reservePlanCredits({ ...subject, maximumCostMicroUsd: HUNDRED_CREDIT_COST, isIncluded: false }),
    ),
  );
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, SUCCESSFUL_ATTEMPTS);
  assert.equal(attempts.filter((a) => a.status === "rejected").length, 1);
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, HELD_POOL_BALANCE);
});
void test("settlement spends allowance first, refunds unused pool, and is idempotent", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: RESERVATION_COST,
    isIncluded: false,
  });
  assert.equal(reservation.allowanceCredits, ALLOWANCE);
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, HELD_POOL_BALANCE);
  const input = {
    ...subject,
    reservationId: reservation.id,
    providerCostMicroUsd: SETTLEMENT_COST,
    provider: "openai",
    model: "test",
    feature: "test",
    inputTokens: 1,
    outputTokens: 1,
  };
  const event = await settlePlanCredits(input);
  assert.equal(event.creditsCharged, SETTLED_CREDITS);
  assert.equal(event.metadata.allowanceCredits, ALLOWANCE);
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, SETTLED_POOL_BALANCE);
  assert.equal((await settlePlanCredits(input)).id, event.id);
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, SETTLED_POOL_BALANCE);
});
void test("held credits count back what a live hold set aside until it settles", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: RESERVATION_COST,
    isIncluded: false,
  });
  const access = await getWorkspaceMemberCreditAccess(subject);
  const held = await sumHeldPlanCredits(subject);
  assert.equal(access.allowanceRemaining + access.poolBalance + held, ALLOWANCE + POOL);
  await releasePlanCredits({ ...subject, reservationId: reservation.id });
  assert.equal(await sumHeldPlanCredits(subject), 0);
});
void test("held credits for a meeting count only that meeting's holds", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const meetingId = randomUUID();
  const hold = { ...subject, maximumCostMicroUsd: MEETING_HOLD_CREDITS * PRO_COST_PER_CREDIT, isIncluded: false };
  await reservePlanCredits({ ...hold, metadata: { meetingId: randomUUID() } });
  assert.equal(await sumHeldPlanCredits({ ...subject, meetingId }), 0);
  await reservePlanCredits({ ...hold, metadata: { meetingId } });
  assert.equal(await sumHeldPlanCredits({ ...subject, meetingId }), MEETING_HOLD_CREDITS);
  assert.equal(await sumHeldPlanCredits(subject), MEETING_HOLD_CREDITS + MEETING_HOLD_CREDITS);
});
void test("release refunds held pool once", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: RESERVATION_COST,
    isIncluded: false,
  });
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, HELD_POOL_BALANCE);
  await releasePlanCredits({ ...subject, reservationId: reservation.id });
  await releasePlanCredits({ ...subject, reservationId: reservation.id });
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, POOL);
});
void test("unknown reservation ownership and over-budget settlement are rejected", async () => {
  const subject = await fixture();
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: HUNDRED_CREDIT_COST,
    isIncluded: false,
  });
  const input = {
    ...subject,
    reservationId: reservation.id,
    providerCostMicroUsd: OVER_BOUNDARY_COST,
    provider: "openai",
    model: "test",
    feature: "test",
    inputTokens: 1,
    outputTokens: 1,
  };
  await assert.rejects(settlePlanCredits(input), /exceeds reserved/);
  await assert.rejects(settlePlanCredits({ ...input, userId: randomUUID() }), /Invalid AI credit reservation/);
});

void test("out-of-order settlement and release do not double-count pool spend as allowance", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const first = await reservePlanCredits({ ...subject, maximumCostMicroUsd: ALLOWANCE_COST, isIncluded: false });
  const second = await reservePlanCredits({ ...subject, maximumCostMicroUsd: HUNDRED_CREDIT_COST, isIncluded: false });
  await settlePlanCredits({
    ...subject,
    reservationId: second.id,
    providerCostMicroUsd: HUNDRED_CREDIT_COST,
    provider: "openai",
    model: "test",
    feature: "test",
    inputTokens: 1,
    outputTokens: 1,
  });
  await releasePlanCredits({ ...subject, reservationId: first.id });
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE);
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, 0);
});

void test("concurrent members cannot spend the shared pool twice", async () => {
  const subject = await fixture();
  const other = await upsertUser({ email: `${randomUUID()}@credits.test`, displayName: "Other member" });
  await ensureWorkspaceMembership({ workspaceId: subject.workspaceId, userId: other.id });
  await Promise.all(
    [subject.userId, other.id].map((userId) =>
      reservePlanCredits({
        ...subject,
        userId,
        maximumCostMicroUsd: ALLOWANCE_COST,
        isIncluded: false,
      }),
    ),
  );
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const attempts = await Promise.allSettled(
    [subject.userId, other.id].map((userId) =>
      reservePlanCredits({
        ...subject,
        userId,
        maximumCostMicroUsd: POOL_COST,
        isIncluded: false,
      }),
    ),
  );
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, 0);
});

void test("concurrent settlement writes one usage event and release cannot refund settled spend", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: RESERVATION_COST,
    isIncluded: false,
  });
  const input = { ...subject, ...USAGE, reservationId: reservation.id, providerCostMicroUsd: SETTLEMENT_COST };
  const events = await Promise.all(Array.from({ length: CONCURRENT_ATTEMPTS }, () => settlePlanCredits(input)));
  assert.equal(new Set(events.map((event) => event.id)).size, 1);
  await releasePlanCredits({ ...subject, reservationId: reservation.id });
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, SETTLED_POOL_BALANCE);
  const rows = await db.aiCreditUsageEvents.findMany({ where: { reservationId: reservation.id } });
  assert.equal(rows.length, 1);
  assert.equal(events[0]?.revenueMicroUsd, SETTLED_CREDITS * CREDIT_PRICE_MICRO_USD);
  assert.equal(events[0].actualCostMicroUsd, SETTLEMENT_COST);
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, 0);
});

void test("released reservations cannot settle and concurrent releases refund once", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: RESERVATION_COST,
    isIncluded: false,
  });
  await Promise.all(
    Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
      releasePlanCredits({ ...subject, reservationId: reservation.id }),
    ),
  );
  await assert.rejects(
    settlePlanCredits({ ...subject, ...USAGE, reservationId: reservation.id, providerCostMicroUsd: LOW_COST }),
    /Invalid AI credit reservation/,
  );
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, POOL);
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE);
});

void test("ownership checks protect both settlement and release without changing balances", async () => {
  const subject = await fixture();
  const other = await fixture();
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: HUNDRED_CREDIT_COST,
    isIncluded: false,
  });
  await assert.rejects(
    releasePlanCredits({ ...subject, userId: other.userId, reservationId: reservation.id }),
    /Invalid AI credit reservation/,
  );
  await assert.rejects(
    releasePlanCredits({ ...other, reservationId: reservation.id }),
    /Invalid AI credit reservation/,
  );
  await assert.rejects(
    settlePlanCredits({ ...other, ...USAGE, reservationId: reservation.id, providerCostMicroUsd: LOW_COST }),
    /Invalid AI credit reservation/,
  );
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE - POOL);
});

void test("a cost above the authorized maximum is rejected even within the same rounded credit", async () => {
  const subject = await fixture();
  const reservation = await reservePlanCredits({ ...subject, maximumCostMicroUsd: LOW_COST, isIncluded: false });
  await assert.rejects(
    settlePlanCredits({
      ...subject,
      ...USAGE,
      reservationId: reservation.id,
      providerCostMicroUsd: HIGHER_COST_SAME_CREDITS,
    }),
    /exceeds reserved/,
  );
  const event = await settlePlanCredits({
    ...subject,
    ...USAGE,
    reservationId: reservation.id,
    providerCostMicroUsd: LOW_COST,
  });
  assert.equal(event.creditsCharged, 1);
});

void test("invalid costs and token counts never reserve or settle funds", async () => {
  const subject = await fixture();
  await Promise.all(
    [-1, NaN, Infinity, FRACTIONAL_COST, LEDGER_OVERFLOW].map(async (maximumCostMicroUsd) => {
      await assert.rejects(reservePlanCredits({ ...subject, maximumCostMicroUsd, isIncluded: false }), RangeError);
      await assert.rejects(reservePlanCredits({ ...subject, maximumCostMicroUsd, isIncluded: true }), RangeError);
    }),
  );
  // The cost itself fits an integer, but its marked-up credit revenue does not.
  await assert.rejects(
    reservePlanCredits({ ...subject, maximumCostMicroUsd: LEDGER_OVERFLOW - 1, isIncluded: false }),
    RangeError,
  );
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE);
  const reservation = await reservePlanCredits({ ...subject, maximumCostMicroUsd: LOW_COST, isIncluded: false });
  const input = { ...subject, ...USAGE, reservationId: reservation.id, providerCostMicroUsd: LOW_COST };
  await Promise.all(
    [-1, NaN, Infinity, FRACTIONAL_COST, LEDGER_OVERFLOW].map(async (providerCostMicroUsd) => {
      await assert.rejects(settlePlanCredits({ ...input, providerCostMicroUsd }), RangeError);
      await assert.rejects(settlePlanCredits({ ...input, inputTokens: providerCostMicroUsd }), RangeError);
      await assert.rejects(settlePlanCredits({ ...input, outputTokens: providerCostMicroUsd }), RangeError);
    }),
  );
  assert.equal((await settlePlanCredits(input)).creditsCharged, 1);
});

void test("included and zero-cost calls do not consume allowance or pool", async () => {
  const subject = await fixture();
  await Promise.all(
    [false, true].map(async (isIncluded) => {
      const providerCostMicroUsd = isIncluded ? HUNDRED_CREDIT_COST : 0;
      const reservation = await reservePlanCredits({
        ...subject,
        maximumCostMicroUsd: providerCostMicroUsd,
        isIncluded,
      });
      assert.equal(reservation.reservedCredits, 0);
      assert.equal(reservation.poolDebits.length, 0);
      assert.equal(
        (await settlePlanCredits({ ...subject, ...USAGE, reservationId: reservation.id, providerCostMicroUsd }))
          .creditsCharged,
        0,
      );
    }),
  );
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE);
});

void test("settlement uses the reserved plan even if the workspace plan changes", async () => {
  const subject = await fixture();
  await updateWorkspacePlan({ workspaceId: subject.workspaceId, plan: "max" });
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: HUNDRED_CREDIT_COST,
    isIncluded: false,
  });
  await updateWorkspacePlan({ workspaceId: subject.workspaceId, plan: "pro" });
  const event = await settlePlanCredits({
    ...subject,
    ...USAGE,
    reservationId: reservation.id,
    providerCostMicroUsd: HUNDRED_CREDIT_COST,
  });
  assert.equal(event.creditsCharged, POOL / PLAN_PRICE_RATIO);
  assert.equal(event.metadata.plan, "max");
});

void test("inactive and nonmember users cannot reserve workspace funds", async () => {
  const subject = await fixture();
  const other = await fixture();
  await assert.rejects(
    reservePlanCredits({ ...subject, userId: other.userId, maximumCostMicroUsd: LOW_COST, isIncluded: false }),
    (error: unknown) => error instanceof InsufficientAiCreditsError,
  );
  await ensureWorkspaceMembership({ workspaceId: subject.workspaceId, userId: other.userId });
  await db.workspaceMemberships.updateMany({
    where: { userId: other.userId, workspaceId: subject.workspaceId },
    data: { status: "suspended" },
  });
  await assert.rejects(
    reservePlanCredits({ ...subject, userId: other.userId, maximumCostMicroUsd: LOW_COST, isIncluded: false }),
    (error: unknown) => error instanceof InsufficientAiCreditsError,
  );
});

void test("unsubscribed members can spend top-ups, but cannot create an allowance", async () => {
  const user = await upsertUser({ email: `${randomUUID()}@credits.test`, displayName: "Pool only" });
  const subject = { userId: user.id, workspaceId: user.workspaceId };
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "pro" });
  await assert.rejects(
    reservePlanCredits({ ...subject, maximumCostMicroUsd: LOW_COST, isIncluded: false }),
    (error: unknown) => error instanceof InsufficientAiCreditsError,
  );
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: HUNDRED_CREDIT_COST,
    isIncluded: false,
  });
  assert.equal(reservation.allowanceCredits, 0);
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, 0);
});

void test("legacy usage cannot spend allowance held by a reservation", async () => {
  const subject = await fixture();
  const reservation = await reservePlanCredits({ ...subject, maximumCostMicroUsd: ALLOWANCE_COST, isIncluded: false });
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  await db.aiCreditUsageEvents.create({
    data: {
      ...subject,
      actionType: "legacy",
      actionLabel: "legacy",
      creditsCharged: POOL,
      metadata: { allowanceCredits: POOL, source: "legacy" },
      /** @external ai_credit_usage_events column */
      requireAvailableCredits: true,
    },
  });
  const [legacy] = await db.aiCreditUsageEvents.findMany({ where: { workspaceId: subject.workspaceId } });
  assert.deepEqual(legacy?.metadata, { allowanceCredits: 0, source: "legacy" });
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, 0);
  await releasePlanCredits({ ...subject, reservationId: reservation.id });
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE);
  const next = await reservePlanCredits({ ...subject, maximumCostMicroUsd: ALLOWANCE_COST, isIncluded: false });
  assert.equal(next.allowanceCredits, ALLOWANCE);
  await releasePlanCredits({ ...subject, reservationId: next.id });
  // The legacy trigger's SQL sum must also ignore the earlier pool-only charge.
  await db.aiCreditUsageEvents.create({
    data: {
      ...subject,
      actionType: "legacy",
      actionLabel: "legacy",
      creditsCharged: ALLOWANCE,
      /** @external ai_credit_usage_events column */
      requireAvailableCredits: true,
    },
  });
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, 0);
});

void test("historical legacy events without allocation still consume allowance in TS and SQL sums", async () => {
  const subject = await fixture();
  const historical = await db.aiCreditUsageEvents.create({
    data: {
      ...subject,
      actionType: "legacy",
      actionLabel: "historical",
      creditsCharged: POOL,
    },
  });
  // Simulate an event written before allocation metadata existed.
  await db.aiCreditUsageEvents.updateMany({ data: { metadata: {} }, where: { id: historical.id } });
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceUsed, POOL);
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: ALLOWANCE_COST - HUNDRED_CREDIT_COST,
    isIncluded: false,
  });
  assert.equal(reservation.allowanceCredits, ALLOWANCE - POOL);
  await releasePlanCredits({ ...subject, reservationId: reservation.id });
  await db.aiCreditUsageEvents.create({
    data: {
      ...subject,
      actionType: "legacy",
      actionLabel: "legacy",
      creditsCharged: ALLOWANCE - POOL,
      /** @external ai_credit_usage_events column */
      requireAvailableCredits: true,
    },
  });
  await assert.rejects(
    db.aiCreditUsageEvents.create({
      data: {
        ...subject,
        actionType: "legacy",
        actionLabel: "over allowance",
        creditsCharged: 1,
        /** @external ai_credit_usage_events column */
        requireAvailableCredits: true,
      },
    }),
  );
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceUsed, ALLOWANCE);
});

void test("allowance reads keep the hold when settlement commits after the usage snapshot", async (t) => {
  const subject = await fixture();
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: HUNDRED_CREDIT_COST,
    isIncluded: false,
  });
  const query = pool.query.bind(pool);
  const state = { hasInterleaved: false };
  t.mock.method(pool, "query", async (config: QueryConfig, values?: unknown[]) => {
    const result = await query(config, values);
    if (!state.hasInterleaved && config.text.includes("sum(") && config.text.includes('"ai_credit_usage_events"')) {
      state.hasInterleaved = true;
      await settlePlanCredits({
        ...subject,
        ...USAGE,
        reservationId: reservation.id,
        providerCostMicroUsd: HUNDRED_CREDIT_COST,
      });
    }

    return result;
  });
  const access = await getWorkspaceMemberCreditAccess(subject);
  assert.equal(state.hasInterleaved, true);
  assert.equal(access.allowanceUsed, 0);
  assert.equal(access.allowanceRemaining, ALLOWANCE - POOL);
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE - POOL);
});

void test("settlement failure rolls back refunds and reservation status", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: RESERVATION_COST,
    isIncluded: false,
  });
  const idempotencyKey = `reservation:${reservation.id}`;
  await db.aiCreditUsageEvents.create({
    data: { ...subject, actionType: "test", actionLabel: "test", idempotencyKey },
  });
  const input = { ...subject, ...USAGE, reservationId: reservation.id, providerCostMicroUsd: SETTLEMENT_COST };
  await assert.rejects(settlePlanCredits(input));
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, HELD_POOL_BALANCE);
  const [held] = await db.aiCreditReservations.findMany({ where: { id: reservation.id } });
  assert.equal(held?.status, "reserved");
  await db.aiCreditUsageEvents.deleteMany({ where: { idempotencyKey } });
  assert.equal((await settlePlanCredits(input)).creditsCharged, SETTLED_CREDITS);
});

void test("workspace deletion is not blocked by its settled reservation history", async () => {
  const subject = await fixture();
  const reservation = await reservePlanCredits({ ...subject, maximumCostMicroUsd: LOW_COST, isIncluded: false });
  const event = await settlePlanCredits({
    ...subject,
    ...USAGE,
    reservationId: reservation.id,
    providerCostMicroUsd: LOW_COST,
  });
  await db.workspaces.deleteMany({ where: { id: subject.workspaceId } });
  const [retained] = await db.aiCreditUsageEvents.findMany({ where: { id: event.id } });
  assert.equal(retained?.reservationId, null);
});

void test("reservation lookup returns server metadata only for its owner and workspace", async () => {
  const subject = await fixture();
  const other = await fixture();
  const metadata = { provider: "openai", model: "test", feature: "test", maxInputTokens: POOL };
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: LOW_COST,
    isIncluded: false,
    metadata,
  });
  assert.deepEqual((await getPlanCreditReservation({ ...subject, reservationId: reservation.id }))?.metadata, metadata);
  assert.equal(await getPlanCreditReservation({ ...other, reservationId: reservation.id }), null);
  assert.equal(
    await getPlanCreditReservation({ ...subject, userId: other.userId, reservationId: reservation.id }),
    null,
  );
});

void test("paid reservations reject free and legacy workspace plans instead of pricing them as Pro", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  await updateWorkspacePlan({ workspaceId: subject.workspaceId, plan: "business" });
  await assert.rejects(
    reservePlanCredits({ ...subject, maximumCostMicroUsd: LOW_COST, isIncluded: false }),
    (error: unknown) => error instanceof PaidPlanRequiredForCreditsError,
  );
  await updateWorkspacePlan({ workspaceId: subject.workspaceId, plan: "free" });
  await assert.rejects(
    reservePlanCredits({ ...subject, maximumCostMicroUsd: LOW_COST, isIncluded: false }),
    (error: unknown) => error instanceof PaidPlanRequiredForCreditsError,
  );
  assert.equal(
    (await reservePlanCredits({ ...subject, maximumCostMicroUsd: LOW_COST, isIncluded: true })).reservedCredits,
    0,
  );
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, POOL);
});

void test("late settlement retains its authorization timestamp and records reporting fields", async () => {
  const subject = await fixture();
  const reservation = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: HUNDRED_CREDIT_COST,
    isIncluded: false,
  });
  const authorizedAt = new Date("2020-01-01T00:00:00.000Z");
  await db.aiCreditReservations.updateMany({
    data: { createdAt: authorizedAt, allowanceWindowStart: authorizedAt },
    where: { id: reservation.id },
  });
  const event = await settlePlanCredits({
    ...subject,
    ...USAGE,
    reservationId: reservation.id,
    providerCostMicroUsd: HUNDRED_CREDIT_COST,
    cachedInputTokens: 1,
    actionType: "meeting_summary",
  });
  assert.equal(event.createdAt.toISOString(), authorizedAt.toISOString());
  assert.equal(event.cachedInputTokens, 1);
  assert.equal(event.actionType, "meeting_summary");
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE);
});

async function ageReservation(input: { reservationId: string; ageMs: number }): Promise<void> {
  await db.aiCreditReservations.update({
    where: { id: input.reservationId },
    data: { createdAt: new Date(Date.now() - input.ageMs) },
  });
}

void test("stale orphaned holds are released once and refund their pool debit", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const orphan = await reservePlanCredits({ ...subject, maximumCostMicroUsd: RESERVATION_COST, isIncluded: false });
  const fresh = await reservePlanCredits({ ...subject, maximumCostMicroUsd: LOW_COST, isIncluded: true });
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, HELD_POOL_BALANCE);
  await ageReservation({ reservationId: orphan.id, ageMs: STALE_PLAN_CREDIT_RESERVATION_MS + DAY_MS });

  assert.equal(await releaseStalePlanCreditReservations({ workspaceId: subject.workspaceId }), 1);
  assert.equal(await releaseStalePlanCreditReservations({ workspaceId: subject.workspaceId }), 0);
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, POOL);
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceRemaining, ALLOWANCE);
  assert.equal((await getPlanCreditReservation({ ...subject, reservationId: orphan.id }))?.status, "released");
  assert.equal((await getPlanCreditReservation({ ...subject, reservationId: fresh.id }))?.status, "reserved");
  await assert.rejects(
    settlePlanCredits({ ...subject, ...USAGE, reservationId: orphan.id, providerCostMicroUsd: LOW_COST }),
  );
});

void test("a new reservation reclaims credits held by a stale orphan instead of refusing", async () => {
  const subject = await fixture();
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, source: "credit_topup", credits: POOL });
  const orphan = await reservePlanCredits({ ...subject, maximumCostMicroUsd: RESERVATION_COST, isIncluded: false });
  await assert.rejects(
    reservePlanCredits({ ...subject, maximumCostMicroUsd: RESERVATION_COST, isIncluded: false }),
    InsufficientAiCreditsError,
  );
  await ageReservation({ reservationId: orphan.id, ageMs: STALE_PLAN_CREDIT_RESERVATION_MS + DAY_MS });
  const next = await reservePlanCredits({ ...subject, maximumCostMicroUsd: RESERVATION_COST, isIncluded: false });

  assert.equal(next.allowanceCredits, ALLOWANCE);
  assert.equal((await getPlanCreditReservation({ ...subject, reservationId: orphan.id }))?.status, "released");
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, HELD_POOL_BALANCE);
});
