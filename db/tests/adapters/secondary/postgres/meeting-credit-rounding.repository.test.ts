import { calculatePlanCredits, PLAN_CREDITS } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import {
  releasePlanCredits,
  reservePlanCredits,
  settlePlanCredits,
} from "../../../../adapters/secondary/postgres/plan-credit-reservations";
import { ensureWorkspaceMembership, upsertUser } from "../../../../adapters/secondary/postgres/repositories";
import {
  createWorkspaceCreditGrant,
  getWorkspaceCreditBalanceData,
  getWorkspaceMemberCreditAccess,
  updateWorkspacePlan,
  upsertWorkspaceBillingSubscription,
} from "../../../../adapters/secondary/postgres/workspace-billing";

const CONCURRENT_CALLS = 3;
const POOL_CREDITS = 3;
const REMAINING_POOL_CREDITS = 2;
const DAY_MS = 86_400_000;
const PERIOD_DAYS = 28;
const TINY_CALL_COST = 1_500;
const LIVE_CALLS = 206;
const SNAPSHOT_MAX_COST = 700_000;
const SNAPSHOT_COST = 275_660;
const INITIAL_COST = 300_000;
const USAGE = { provider: "openai", model: "fixture", feature: "live_summary", inputTokens: 1, outputTokens: 1 };
const creditPrice = (cost: number) =>
  calculatePlanCredits({ providerCostMicroUsd: cost, plan: "pro", isIncluded: false });

after(closeDbPool);

async function fixture() {
  const user = await upsertUser({ email: `${randomUUID()}@rounding.test`, displayName: "Credit rounding" });
  const subject = { userId: user.id, workspaceId: user.workspaceId };
  await updateWorkspacePlan({ workspaceId: user.workspaceId, plan: "pro" });
  await upsertWorkspaceBillingSubscription({
    ...subject,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripePriceId: "price_pro",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: PLAN_CREDITS.pro.monthlyAllowance,
    seatQuantity: 1,
    currentPeriodStart: new Date(Date.now() - DAY_MS),
    currentPeriodEnd: new Date(Date.now() + DAY_MS * PERIOD_DAYS),
  });
  const meeting = await db.meetings.create({
    data: { workspaceId: user.workspaceId, createdByUserId: user.id, title: "Synthetic", roomName: randomUUID() },
  });

  return { ...subject, meetingId: meeting.id };
}

type Subject = Awaited<ReturnType<typeof fixture>>;

async function reserve(input: Subject & { cost?: number }) {
  const { cost = TINY_CALL_COST, ...subject } = input;

  return reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: cost,
    isIncluded: false,
    metadata: { meetingId: subject.meetingId },
  });
}

async function settle(input: Subject & { reservationId: string; cost?: number }) {
  const { reservationId, cost = TINY_CALL_COST, ...subject } = input;

  return settlePlanCredits({ ...subject, ...USAGE, reservationId, providerCostMicroUsd: cost });
}

void test("tiny live calls leave room for final notes instead of exhausting Pro through rounding", async () => {
  const subject = await fixture();
  const initial = await reservePlanCredits({ ...subject, maximumCostMicroUsd: INITIAL_COST, isIncluded: false });
  await settle({ ...subject, reservationId: initial.id, cost: INITIAL_COST });
  await Array.from({ length: LIVE_CALLS }).reduce(async (previous) => {
    await previous;
    const reservation = await reserve(subject);
    await settle({ ...subject, reservationId: reservation.id });
  }, Promise.resolve());
  assert.equal(
    (await getWorkspaceMemberCreditAccess(subject)).allowanceUsed,
    creditPrice(INITIAL_COST) + creditPrice(LIVE_CALLS * TINY_CALL_COST),
  );
  const snapshot = await reserve({ ...subject, cost: SNAPSHOT_MAX_COST });
  await settle({ ...subject, reservationId: snapshot.id, cost: SNAPSHOT_COST });
  const events = await db.aiCreditUsageEvents.findMany({ where: { workspaceId: subject.workspaceId } });
  assert.equal(
    events.reduce((total, event) => total + event.creditsCharged, 0),
    creditPrice(INITIAL_COST) + creditPrice(LIVE_CALLS * TINY_CALL_COST + SNAPSHOT_COST),
  );
  assert.equal(
    events.reduce((total, event) => total + event.actualCostMicroUsd, 0),
    INITIAL_COST + LIVE_CALLS * TINY_CALL_COST + SNAPSHOT_COST,
  );
});

void test("concurrent mixed-provider settlements share rounding once and replays are idempotent", async () => {
  const subject = await fixture();
  const reservations = await Promise.all(Array.from({ length: CONCURRENT_CALLS }, () => reserve(subject)));
  const events = await Promise.all(
    reservations.map((reservation, index) =>
      settlePlanCredits({
        ...subject,
        ...USAGE,
        provider: index === 0 ? "typesafe" : "openai",
        reservationId: reservation.id,
        providerCostMicroUsd: TINY_CALL_COST,
      }),
    ),
  );
  assert.equal(
    events.reduce((total, event) => total + event.creditsCharged, 0),
    1,
  );
  const first = reservations[0];
  assert.ok(first);
  const replay = await Promise.all([
    settle({ ...subject, reservationId: first.id }),
    settle({ ...subject, reservationId: first.id }),
  ]);
  assert.equal(replay[0].id, events[0]?.id);
  assert.equal(replay[1].id, events[0]?.id);
  assert.equal((await getWorkspaceMemberCreditAccess(subject)).allowanceUsed, 1);
});

void test("meeting, user, workspace, reserved plan and allowance window keep separate rounding totals", async () => {
  const subject = await fixture();
  const first = await reserve(subject);
  assert.equal((await settle({ ...subject, reservationId: first.id })).creditsCharged, 1);
  const next = await reserve(subject);
  assert.equal((await settle({ ...subject, reservationId: next.id })).creditsCharged, 0);
  const otherMeeting = await db.meetings.create({
    data: { workspaceId: subject.workspaceId, createdByUserId: subject.userId, title: "Other", roomName: randomUUID() },
  });
  const otherSubject = { ...subject, meetingId: otherMeeting.id };
  assert.equal((await settle({ ...otherSubject, reservationId: (await reserve(otherSubject)).id })).creditsCharged, 1);
  const otherUser = await fixture();
  await ensureWorkspaceMembership({ workspaceId: subject.workspaceId, userId: otherUser.userId });
  const member = { ...subject, userId: otherUser.userId };
  assert.equal((await settle({ ...member, reservationId: (await reserve(member)).id })).creditsCharged, 1);
  assert.equal((await settle({ ...otherUser, reservationId: (await reserve(otherUser)).id })).creditsCharged, 1);

  await updateWorkspacePlan({ workspaceId: subject.workspaceId, plan: "max" });
  const max = await reserve(subject);
  await updateWorkspacePlan({ workspaceId: subject.workspaceId, plan: "pro" });
  assert.equal((await settle({ ...subject, reservationId: max.id })).creditsCharged, 1);
  const priorWindow = await reserve(subject);
  await db.aiCreditReservations.update({
    where: { id: priorWindow.id },
    data: { allowanceWindowStart: new Date("2020-01-01T00:00:00Z"), createdAt: new Date("2020-01-01T00:00:00Z") },
  });
  assert.equal((await settle({ ...subject, reservationId: priorWindow.id })).creditsCharged, 1);
  assert.equal((await settle({ ...subject, reservationId: (await reserve(subject)).id })).creditsCharged, 0);
});

void test("pool-only calls refund rounding remainder and never settle released or over-budget work", async () => {
  const subject = await fixture();
  await db.billingSubscriptions.deleteMany({ where: { workspaceId: subject.workspaceId } });
  await createWorkspaceCreditGrant({ workspaceId: subject.workspaceId, credits: POOL_CREDITS, source: "credit_topup" });
  const first = await reserve(subject);
  const second = await reserve(subject);
  await settle({ ...subject, reservationId: first.id });
  const event = await settle({ ...subject, reservationId: second.id });
  assert.equal(event.creditsCharged, 0);
  assert.equal(event.profitMicroUsd, -TINY_CALL_COST);
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, REMAINING_POOL_CREDITS);
  const released = await reserve(subject);
  await releasePlanCredits({ ...subject, reservationId: released.id });
  await assert.rejects(settle({ ...subject, reservationId: released.id }), /Invalid AI credit reservation/);
  const bounded = await reserve(subject);
  await assert.rejects(settle({ ...subject, reservationId: bounded.id, cost: TINY_CALL_COST + 1 }), /exceeds reserved/);
  await releasePlanCredits({ ...subject, reservationId: bounded.id });
  assert.equal((await getWorkspaceCreditBalanceData(subject.workspaceId)).balance, REMAINING_POOL_CREDITS);
});

void test("legacy reservations and included or zero-cost usage cannot contribute rounding headroom", async () => {
  const subject = await fixture();
  const legacy = await reserve(subject);
  await db.aiCreditReservations.update({
    where: { id: legacy.id },
    data: { metadata: { meetingId: subject.meetingId } },
  });
  assert.equal((await settle({ ...subject, reservationId: legacy.id })).creditsCharged, 1);
  const included = await reservePlanCredits({
    ...subject,
    maximumCostMicroUsd: SNAPSHOT_MAX_COST,
    isIncluded: true,
    metadata: { meetingId: subject.meetingId },
  });
  assert.equal((await settle({ ...subject, reservationId: included.id, cost: SNAPSHOT_COST })).creditsCharged, 0);
  const zero = await reserve(subject);
  assert.equal((await settle({ ...subject, reservationId: zero.id, cost: 0 })).creditsCharged, 0);
  const current = await reserve(subject);
  assert.equal((await settle({ ...subject, reservationId: current.id })).creditsCharged, 1);
  assert.equal((await settle({ ...subject, reservationId: legacy.id })).creditsCharged, 1);
});

void test("settlement uses the reserved meeting and rejects a conflicting meeting identity", async () => {
  const subject = await fixture();
  const reservation = await reserve(subject);
  await assert.rejects(
    settle({ ...subject, meetingId: randomUUID(), reservationId: reservation.id }),
    /Invalid AI credit reservation/,
  );
  const event = await settlePlanCredits({
    workspaceId: subject.workspaceId,
    userId: subject.userId,
    ...USAGE,
    reservationId: reservation.id,
    providerCostMicroUsd: TINY_CALL_COST,
  });
  assert.equal(event.meetingId, subject.meetingId);
});
