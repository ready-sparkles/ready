import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import {
  hasStripeWebhookReceipt,
  recordStripeWebhookReceipt,
} from "../../../../adapters/secondary/postgres/billing-reliability";
import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import {
  createCreditGrant,
  ensureWorkspaceMembership,
  getLatestBillingSubscriptionForUser,
  getRunningBillingSubscriptions,
  getUserCreditBalanceData,
  hasPrivateBetaProCreditEntitlement,
  recordAiCreditUsageEvent,
  updateUserPlan,
  upsertBillingSubscription,
  upsertUser,
} from "../../../../adapters/secondary/postgres/repositories";
import {
  createWorkspaceForUser,
  removeWorkspaceMember,
  restoreWorkspaceMember,
  suspendWorkspaceMember,
} from "../../../../adapters/secondary/postgres/workspace-admin";
import {
  createWorkspaceCreditGrant,
  getWorkspaceCreditBalanceData,
  getWorkspaceFreeTrialCreditSummary,
  getWorkspaceMemberCreditAccess,
  upsertWorkspaceBillingSubscription,
} from "../../../../adapters/secondary/postgres/workspace-billing";

const EXPECTED_TEST_COUNT_3 = 3;
const RETIRED_CHARGER_PROVIDER_COST = 1_000_000;

const MESSAGE_EXPECTED_PREVIOUS_PERSONAL_SUBSCRIPTION = "Expected the previous personal subscription.";
const MESSAGE_EXPECTED_CURRENT_PERSONAL_SUBSCRIPTION = "Expected the current personal subscription.";
const MESSAGE_EXPECTED_FOURTH_WORKSPACE = "Expected a fourth workspace.";
const MESSAGE_EXPECTED_THIRD_WORKSPACE = "Expected a third workspace.";
const MESSAGE_EXPECTED_JOINED_WORKSPACE = "Expected a joined workspace.";

function required<T>(input: { value: T | null | undefined; message: string }): T {
  if (input.value === null || input.value === undefined) {
    throw new Error(input.message);
  }

  return input.value;
}

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MILLISECONDS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

const ONE_DAY_AGO = -1;
const SUBSCRIPTION_PERIOD_LENGTH_DAYS = 27;
const REPLACEMENT_PERIOD_LENGTH_DAYS = 29;
const EXPIRED_PERIOD_START_DAYS_AGO = 31;

const DEFAULT_INCLUDED_CREDITS_PER_PERIOD = 10;
const DEFAULT_SEAT_QUANTITY = 1;

const DRAW_POOL_TOPUP_CREDITS = 20;
const DRAW_FIRST_CHARGE_CREDITS = 6;
const DRAW_SECOND_CHARGE_CREDITS = 6;
const DRAW_EXPECTED_POOL_AFTER_FIRST_CHARGE = 20;
const DRAW_EXPECTED_POOL_AFTER_SECOND_CHARGE = 18;
const DRAW_EXPECTED_ALLOWANCE_USED = DEFAULT_INCLUDED_CREDITS_PER_PERIOD;
const DRAW_EXPECTED_ALLOWANCE_REMAINING = 0;

const CONCURRENT_DRAW_INCLUDED_CREDITS = 5;
const CONCURRENT_DRAW_POOL_TOPUP = 50;
const CONCURRENT_CHARGE_PARALLEL_COUNT = 8;
const CONCURRENT_CHARGE_CREDITS_EACH = 3;
const CONCURRENT_EXPECTED_TOTAL_ALLOWANCE_USED = CONCURRENT_DRAW_INCLUDED_CREDITS;
const CONCURRENT_EXPECTED_POOL_BALANCE = 31;

const REPLAY_ZERO_ALLOWANCE = 0;
const REPLAY_POOL_TOPUP = 20;
const REPLAY_CHARGE_CREDITS = 5;
const REPLAY_EXPECTED_POOL_BALANCE = 15;

const SUSPENDED_TEST_INCLUDED_CREDITS = 100;
const SUSPENDED_TEST_POOL_TOPUP = 20;
const SUSPENDED_MEMBER_CHARGE_CREDITS = 4;
const SUSPENDED_EXPECTED_POOL_BALANCE = 16;
const SUSPENDED_RESTORED_TRIAL_CREDITS_USED = 4;

const USER_GRANT_SUBSCRIBED_INCLUDED_CREDITS = 100;
const USER_GRANT_PROMOTIONAL_CREDITS = 9;
const USER_GRANT_WORKSPACE_CHARGE_CREDITS = 5;
const USER_GRANT_EXPECTED_LEGACY_BALANCE = 4;

const STANDALONE_TOPUP_CREDITS = 12;
const STANDALONE_CHARGE_CREDITS = 5;
const STANDALONE_EXPECTED_POOL_BALANCE = 7;

const PERSONAL_SUB_INCLUDED_CREDITS = 200;
const REPLACEMENT_SUBSCRIPTION_INCLUDED_CREDITS = 100;

const TRIAL_CHARGE_CREDITS = 750;
const TRIAL_MAX_WORKSPACES_PER_USER = 20;
const TRIAL_SUMMARY_OWNER_CHARGE_CREDITS = 100;
const TRIAL_SUMMARY_MEMBER_CHARGE_CREDITS = 200;
const TRIAL_SUMMARY_ACTIVE_MEMBER_COUNT = 2;
const TRIAL_SUMMARY_REMAINING_CREDITS_TWO_MEMBERS = 0;
const TRIAL_SUMMARY_ACTIVE_MEMBER_COUNT_AFTER_SUSPEND = 1;
const TRIAL_SUMMARY_REMAINING_CREDITS_ONE_MEMBER = 0;
const TRIAL_SLOT_USAGE_CHARGE_CREDITS = 1;
const TRIAL_SLOTS_WITH_USAGE = 3;
const FOURTH_WORKSPACE_INDEX = 3;
const THIRD_WORKSPACE_INDEX = 2;

after(async () => {
  await closeDbPool();
});

async function makeUser(label: string) {
  return upsertUser({
    email: `${randomUUID()}@${label}.readymeet.test`,
    displayName: `${label} user`,
  });
}

function daysFromNow(days: number) {
  return new Date(Date.now() + days * MILLISECONDS_PER_DAY);
}

async function seedRunningWorkspaceSubscription(input: {
  workspaceId: string;
  userId: string;
  includedCreditsPerPeriod?: number;
}) {
  return upsertWorkspaceBillingSubscription({
    workspaceId: input.workspaceId,
    userId: input.userId,
    stripeSubscriptionId: `sub_test_${randomUUID()}`,
    stripePriceId: "price_test_seat",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: input.includedCreditsPerPeriod ?? DEFAULT_INCLUDED_CREDITS_PER_PERIOD,
    seatQuantity: DEFAULT_SEAT_QUANTITY,
    currentPeriodStart: daysFromNow(ONE_DAY_AGO),
    currentPeriodEnd: daysFromNow(SUBSCRIPTION_PERIOD_LENGTH_DAYS),
  });
}

async function recordWorkspaceCharge(input: {
  userId: string;
  workspaceId: string;
  credits: number;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey ?? `test:workspace-billing:${randomUUID()}`;
  // Exercise the ledger's debit trigger independently of the retired charger.
  await db.aiCreditUsageEvents.createMany({
    data: {
      userId: input.userId,
      workspaceId: input.workspaceId,
      actionType: "meeting_prep",
      actionLabel: "Workspace billing test charge",
      creditsCharged: input.credits,
      idempotencyKey,
    },
    skipDuplicates: true,
  });
  const [event] = await db.aiCreditUsageEvents.findMany({ where: { idempotencyKey } });

  return event;
}

// --- Allowance-then-pool draw ----------------------------------------------------

void test("workspace charges draw the member allowance first, then the shared pool", async () => {
  const user = await makeUser("wsdraw");
  const workspaceId = user.workspaceId;
  await seedRunningWorkspaceSubscription({
    workspaceId,
    userId: user.id,
    includedCreditsPerPeriod: DEFAULT_INCLUDED_CREDITS_PER_PERIOD,
  });
  await createWorkspaceCreditGrant({ workspaceId, source: "credit_topup", credits: DRAW_POOL_TOPUP_CREDITS });

  // 6 fits inside the 10-credit allowance: the pool must stay untouched.
  await recordWorkspaceCharge({ userId: user.id, workspaceId, credits: DRAW_FIRST_CHARGE_CREDITS });
  assert.equal((await getWorkspaceCreditBalanceData(workspaceId)).balance, DRAW_EXPECTED_POOL_AFTER_FIRST_CHARGE);

  // Another 6 exceeds the remaining 4: the 2-credit overflow drains the pool.
  await recordWorkspaceCharge({ userId: user.id, workspaceId, credits: DRAW_SECOND_CHARGE_CREDITS });
  assert.equal((await getWorkspaceCreditBalanceData(workspaceId)).balance, DRAW_EXPECTED_POOL_AFTER_SECOND_CHARGE);

  const access = await getWorkspaceMemberCreditAccess({ userId: user.id, workspaceId });
  assert.equal(access.subscriptionActive, true);
  assert.equal(access.allowanceCredits, DEFAULT_INCLUDED_CREDITS_PER_PERIOD);
  assert.equal(access.allowanceUsed, DRAW_EXPECTED_ALLOWANCE_USED);
  assert.equal(access.allowanceRemaining, DRAW_EXPECTED_ALLOWANCE_REMAINING);
  assert.equal(access.poolBalance, DRAW_EXPECTED_POOL_AFTER_SECOND_CHARGE);
});

void test("concurrent workspace charges cannot spend the same member allowance twice", async () => {
  const user = await makeUser("wsconcurrentdraw");
  const workspaceId = user.workspaceId;
  await seedRunningWorkspaceSubscription({
    workspaceId,
    userId: user.id,
    includedCreditsPerPeriod: CONCURRENT_DRAW_INCLUDED_CREDITS,
  });
  await createWorkspaceCreditGrant({ workspaceId, source: "credit_topup", credits: CONCURRENT_DRAW_POOL_TOPUP });

  await Promise.all(
    Array.from({ length: CONCURRENT_CHARGE_PARALLEL_COUNT }, () =>
      recordWorkspaceCharge({ userId: user.id, workspaceId, credits: CONCURRENT_CHARGE_CREDITS_EACH }),
    ),
  );

  // 24 total credits consume the 5-credit allowance exactly once, with the
  // remaining 19 serialized through the shared pool.
  assert.equal((await getWorkspaceCreditBalanceData(workspaceId)).balance, CONCURRENT_EXPECTED_POOL_BALANCE);
  const access = await getWorkspaceMemberCreditAccess({ userId: user.id, workspaceId });
  assert.equal(access.allowanceUsed, CONCURRENT_EXPECTED_TOTAL_ALLOWANCE_USED);
  assert.equal(access.allowanceRemaining, DRAW_EXPECTED_ALLOWANCE_REMAINING);
});

void test("idempotent replays never double-drain the pool", async () => {
  const user = await makeUser("wsreplay");
  const workspaceId = user.workspaceId;
  await seedRunningWorkspaceSubscription({
    workspaceId,
    userId: user.id,
    includedCreditsPerPeriod: REPLAY_ZERO_ALLOWANCE,
  });
  await createWorkspaceCreditGrant({ workspaceId, source: "credit_topup", credits: REPLAY_POOL_TOPUP });

  const idempotencyKey = `test:workspace-billing:replay:${randomUUID()}`;
  const first = await recordWorkspaceCharge({
    userId: user.id,
    workspaceId,
    credits: REPLAY_CHARGE_CREDITS,
    idempotencyKey,
  });
  const replay = await recordWorkspaceCharge({
    userId: user.id,
    workspaceId,
    credits: REPLAY_CHARGE_CREDITS,
    idempotencyKey,
  });

  assert.equal(first?.id, replay?.id);
  assert.equal((await getWorkspaceCreditBalanceData(workspaceId)).balance, REPLAY_EXPECTED_POOL_BALANCE);
});

void test("suspended members get no allowance and draw pool-only", async () => {
  const admin = await makeUser("wssuspadmin");
  const member = await makeUser("wssuspmember");
  const workspaceId = admin.workspaceId;
  await ensureWorkspaceMembership({ workspaceId, userId: member.id, role: "member" });
  await seedRunningWorkspaceSubscription({
    workspaceId,
    userId: admin.id,
    includedCreditsPerPeriod: SUSPENDED_TEST_INCLUDED_CREDITS,
  });
  await createWorkspaceCreditGrant({ workspaceId, source: "credit_topup", credits: SUSPENDED_TEST_POOL_TOPUP });

  await suspendWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id });

  // An in-flight job finishing for the suspended member bypasses the
  // allowance entirely and lands on the pool.
  await recordWorkspaceCharge({ userId: member.id, workspaceId, credits: SUSPENDED_MEMBER_CHARGE_CREDITS });
  assert.equal((await getWorkspaceCreditBalanceData(workspaceId)).balance, SUSPENDED_EXPECTED_POOL_BALANCE);

  const access = await getWorkspaceMemberCreditAccess({ userId: member.id, workspaceId });
  assert.equal(access.allowanceCredits, 0);
  assert.equal(access.subscriptionActive, false);
  assert.equal(access.poolBalance, 0);

  // Suspension closes the trial too — a suspended member must not look
  // entitled to start new workspace-billed work…
  assert.equal(access.trialEligible, false);
  assert.equal(access.hasTrialCredits, false);

  // …but restoring brings it back with the usage history intact.
  await restoreWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id, role: "member" });
  const restored = await getWorkspaceMemberCreditAccess({ userId: member.id, workspaceId });
  assert.equal(restored.trialEligible, true);
  assert.equal(restored.trialCreditsUsed, SUSPENDED_RESTORED_TRIAL_CREDITS_USED);
});

void test("workspace draws never touch user grants; workspaces without a subscription fall back to them", async () => {
  const subscribed = await makeUser("wsusergrant");
  await seedRunningWorkspaceSubscription({
    workspaceId: subscribed.workspaceId,
    userId: subscribed.id,
    includedCreditsPerPeriod: USER_GRANT_SUBSCRIBED_INCLUDED_CREDITS,
  });
  await createCreditGrant({ userId: subscribed.id, source: "promotional", credits: USER_GRANT_PROMOTIONAL_CREDITS });
  await recordWorkspaceCharge({
    userId: subscribed.id,
    workspaceId: subscribed.workspaceId,
    credits: USER_GRANT_WORKSPACE_CHARGE_CREDITS,
  });
  assert.equal((await getUserCreditBalanceData(subscribed.id)).balance, USER_GRANT_PROMOTIONAL_CREDITS);

  const legacy = await makeUser("wslegacy");
  await createCreditGrant({ userId: legacy.id, source: "promotional", credits: USER_GRANT_PROMOTIONAL_CREDITS });
  await recordWorkspaceCharge({
    userId: legacy.id,
    workspaceId: legacy.workspaceId,
    credits: USER_GRANT_WORKSPACE_CHARGE_CREDITS,
  });
  assert.equal((await getUserCreditBalanceData(legacy.id)).balance, USER_GRANT_EXPECTED_LEGACY_BALANCE);
});

void test("workspace top-ups remain spendable without a subscription", async () => {
  const user = await makeUser("wsstandalonetopup");
  await createWorkspaceCreditGrant({
    workspaceId: user.workspaceId,
    source: "credit_topup",
    credits: STANDALONE_TOPUP_CREDITS,
  });

  await recordWorkspaceCharge({
    userId: user.id,
    workspaceId: user.workspaceId,
    credits: STANDALONE_CHARGE_CREDITS,
  });
  assert.equal((await getWorkspaceCreditBalanceData(user.workspaceId)).balance, STANDALONE_EXPECTED_POOL_BALANCE);
});

void test("workspace subscriptions never masquerade as the billing owner’s personal subscription", async () => {
  const admin = await makeUser("wsownerisolation");
  await updateUserPlan({ userId: admin.id, plan: "business", privateBetaProEnabled: true });
  const workspaceSub = await seedRunningWorkspaceSubscription({
    workspaceId: admin.workspaceId,
    userId: admin.id,
  });

  // Personal reads must not see the workspace-keyed row: it would block the
  // admin's own checkout, flip user-level gates, and let the subscription
  // credit worker mint them free personal monthly grants.
  assert.equal(await getLatestBillingSubscriptionForUser(admin.id), null);
  const running = await getRunningBillingSubscriptions();
  assert.ok(!running.some((row) => row.stripeSubscriptionId === workspaceSub.stripeSubscriptionId));

  // The private-beta entitlement is revoked only by a PERSONAL subscription.
  assert.equal(await hasPrivateBetaProCreditEntitlement(admin.id), true);

  // A real personal subscription still resolves normally alongside it.
  await upsertBillingSubscription({
    userId: admin.id,
    stripeSubscriptionId: `sub_test_${randomUUID()}`,
    stripePriceId: "price_test_personal",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: PERSONAL_SUB_INCLUDED_CREDITS,
    currentPeriodStart: daysFromNow(ONE_DAY_AGO),
    currentPeriodEnd: daysFromNow(SUBSCRIPTION_PERIOD_LENGTH_DAYS),
  });
  assert.equal((await getLatestBillingSubscriptionForUser(admin.id))?.stripePriceId, "price_test_personal");
  assert.equal(await hasPrivateBetaProCreditEntitlement(admin.id), false);
});

void test("replacement subscriptions supersede expired active rows before upsert", async () => {
  const user = await makeUser("wsexpiredreplacement");
  const oldWorkspaceSubscription = await upsertWorkspaceBillingSubscription({
    workspaceId: user.workspaceId,
    userId: user.id,
    stripeSubscriptionId: `sub_test_${randomUUID()}`,
    stripePriceId: "price_test_workspace_old",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: REPLACEMENT_SUBSCRIPTION_INCLUDED_CREDITS,
    seatQuantity: DEFAULT_SEAT_QUANTITY,
    currentPeriodStart: daysFromNow(EXPIRED_PERIOD_START_DAYS_AGO),
    currentPeriodEnd: daysFromNow(ONE_DAY_AGO),
  });
  const newWorkspaceSubscription = await upsertWorkspaceBillingSubscription({
    workspaceId: user.workspaceId,
    userId: user.id,
    stripeSubscriptionId: `sub_test_${randomUUID()}`,
    stripePriceId: "price_test_workspace_new",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: REPLACEMENT_SUBSCRIPTION_INCLUDED_CREDITS,
    seatQuantity: DEFAULT_SEAT_QUANTITY,
    currentPeriodStart: daysFromNow(ONE_DAY_AGO),
    currentPeriodEnd: daysFromNow(REPLACEMENT_PERIOD_LENGTH_DAYS),
  });

  const oldPersonalSubscription = required({
    value: await upsertBillingSubscription({
      userId: user.id,
      stripeSubscriptionId: `sub_test_${randomUUID()}`,
      stripePriceId: "price_test_personal_old",
      status: "trialing",
      planInterval: "month",
      includedCreditsPerPeriod: REPLACEMENT_SUBSCRIPTION_INCLUDED_CREDITS,
      currentPeriodStart: daysFromNow(EXPIRED_PERIOD_START_DAYS_AGO),
      currentPeriodEnd: daysFromNow(ONE_DAY_AGO),
    }),
    message: MESSAGE_EXPECTED_PREVIOUS_PERSONAL_SUBSCRIPTION,
  });
  const newPersonalSubscription = required({
    value: await upsertBillingSubscription({
      userId: user.id,
      stripeSubscriptionId: `sub_test_${randomUUID()}`,
      stripePriceId: "price_test_personal_new",
      status: "active",
      planInterval: "month",
      includedCreditsPerPeriod: REPLACEMENT_SUBSCRIPTION_INCLUDED_CREDITS,
      currentPeriodStart: daysFromNow(ONE_DAY_AGO),
      currentPeriodEnd: daysFromNow(REPLACEMENT_PERIOD_LENGTH_DAYS),
    }),
    message: MESSAGE_EXPECTED_CURRENT_PERSONAL_SUBSCRIPTION,
  });

  const result = await db.billingSubscriptions.findMany({
    where: {
      id: {
        in: [
          oldWorkspaceSubscription.id,
          newWorkspaceSubscription.id,
          oldPersonalSubscription.id,
          newPersonalSubscription.id,
        ],
      },
    },
    select: { /** @external Prisma field */ stripeSubscriptionId: true, /** @external Prisma field */ status: true },
  });
  const statuses = new Map(result.map((row) => [row.stripeSubscriptionId, row.status]));
  assert.equal(statuses.get(oldWorkspaceSubscription.stripeSubscriptionId), "superseded");
  assert.equal(statuses.get(newWorkspaceSubscription.stripeSubscriptionId), "active");
  assert.equal(statuses.get(oldPersonalSubscription.stripeSubscriptionId), "superseded");
  assert.equal(statuses.get(newPersonalSubscription.stripeSubscriptionId), "active");
});

void test("Stripe receipts are unique and appear only after request completion", async () => {
  const stripeEventId = `evt_test_${randomUUID()}`;
  assert.equal(await hasStripeWebhookReceipt(stripeEventId), false);
  await Promise.all(
    Array.from({ length: EXPECTED_TEST_COUNT_3 }, () =>
      recordStripeWebhookReceipt({ stripeEventId, eventType: "customer.subscription.updated" }),
    ),
  );
  assert.equal(await hasStripeWebhookReceipt(stripeEventId), true);
});

// --- Trial gate --------------------------------------------------------------------

void test("free meeting eligibility does not depend on lifetime credits", async () => {
  const user = await makeUser("wstrial");
  const workspaceId = user.workspaceId;

  const before = await getWorkspaceMemberCreditAccess({ userId: user.id, workspaceId });
  assert.equal(before.trialEligible, true);
  assert.equal(before.hasTrialCredits, true);

  await recordWorkspaceCharge({ userId: user.id, workspaceId, credits: TRIAL_CHARGE_CREDITS });
  const after750 = await getWorkspaceMemberCreditAccess({ userId: user.id, workspaceId });
  assert.equal(after750.trialCreditsUsed, TRIAL_CHARGE_CREDITS);
  assert.equal(after750.hasTrialCredits, true);

  // A fresh second workspace starts its own trial.
  const second = await createWorkspaceForUser({
    userId: user.id,
    name: "Second trial workspace",
    maxWorkspacesPerUser: TRIAL_MAX_WORKSPACES_PER_USER,
  });
  const fresh = await getWorkspaceMemberCreditAccess({ userId: user.id, workspaceId: second.id });
  assert.equal(fresh.hasTrialCredits, true);
});

void test("workspace trial summary aggregates every active members eligible remainder", async () => {
  const owner = await makeUser("wstrialsummaryowner");
  const member = await makeUser("wstrialsummarymember");
  const workspaceId = owner.workspaceId;
  await ensureWorkspaceMembership({ workspaceId, userId: member.id, role: "member" });

  await recordWorkspaceCharge({ userId: owner.id, workspaceId, credits: TRIAL_SUMMARY_OWNER_CHARGE_CREDITS });
  await recordWorkspaceCharge({ userId: member.id, workspaceId, credits: TRIAL_SUMMARY_MEMBER_CHARGE_CREDITS });

  assert.deepEqual(await getWorkspaceFreeTrialCreditSummary(workspaceId), {
    memberCount: TRIAL_SUMMARY_ACTIVE_MEMBER_COUNT,
    remainingCredits: TRIAL_SUMMARY_REMAINING_CREDITS_TWO_MEMBERS,
  });

  await suspendWorkspaceMember({
    workspaceId,
    actorUserId: owner.id,
    targetUserId: member.id,
  });
  assert.deepEqual(await getWorkspaceFreeTrialCreditSummary(workspaceId), {
    memberCount: TRIAL_SUMMARY_ACTIVE_MEMBER_COUNT_AFTER_SUSPEND,
    remainingCredits: TRIAL_SUMMARY_REMAINING_CREDITS_ONE_MEMBER,
  });
});

void test("trial eligibility stops after the third workspace with recorded usage", async () => {
  const user = await makeUser("wstrialcap");
  const workspaceIds = [
    user.workspaceId,
    ...(await ["Two", "Three", "Four"].reduce<Promise<string[]>>(async (previous, name) => {
      const ids = await previous;
      const workspace = await createWorkspaceForUser({
        userId: user.id,
        name: `Trial cap ${name}`,
        maxWorkspacesPerUser: TRIAL_MAX_WORKSPACES_PER_USER,
      });

      return [...ids, workspace.id];
    }, Promise.resolve([]))),
  ];

  // Membership alone never burns a slot: with zero usage anywhere, even the
  // fourth workspace still offers the trial.
  const fourthWorkspaceId = required({
    value: workspaceIds[FOURTH_WORKSPACE_INDEX],
    message: MESSAGE_EXPECTED_FOURTH_WORKSPACE,
  });
  const untouched = await getWorkspaceMemberCreditAccess({ userId: user.id, workspaceId: fourthWorkspaceId });
  assert.equal(untouched.trialEligible, true);

  // Actually consuming credits in three workspaces burns the three slots.
  await workspaceIds.slice(0, TRIAL_SLOTS_WITH_USAGE).reduce(async (previous, workspaceId) => {
    await previous;
    await recordWorkspaceCharge({ userId: user.id, workspaceId, credits: TRIAL_SLOT_USAGE_CHARGE_CREDITS });
  }, Promise.resolve());
  const thirdWorkspaceId = required({
    value: workspaceIds[THIRD_WORKSPACE_INDEX],
    message: MESSAGE_EXPECTED_THIRD_WORKSPACE,
  });
  assert.equal(
    (await getWorkspaceMemberCreditAccess({ userId: user.id, workspaceId: thirdWorkspaceId })).trialEligible,
    true,
  );
  const fourthAccess = await getWorkspaceMemberCreditAccess({ userId: user.id, workspaceId: fourthWorkspaceId });
  assert.equal(fourthAccess.trialEligible, false);
  assert.equal(fourthAccess.hasTrialCredits, false);
});

void test("leaving a used workspace cannot free up a trial slot", async () => {
  const owner = await makeUser("wstrialfarmowner");
  const farmer = await makeUser("wstrialfarmer");

  // The farmer consumes the trial in three workspaces: their own default one
  // plus two they were invited into.
  await recordWorkspaceCharge({
    userId: farmer.id,
    workspaceId: farmer.workspaceId,
    credits: TRIAL_SLOT_USAGE_CHARGE_CREDITS,
  });
  const joined = await ["A", "B"].reduce<Promise<string[]>>(async (previous, name) => {
    const ids = await previous;
    const workspace = await createWorkspaceForUser({
      userId: owner.id,
      name: `Trial farm ${name}`,
      maxWorkspacesPerUser: TRIAL_MAX_WORKSPACES_PER_USER,
    });
    await ensureWorkspaceMembership({ workspaceId: workspace.id, userId: farmer.id, role: "member" });
    await recordWorkspaceCharge({
      userId: farmer.id,
      workspaceId: workspace.id,
      credits: TRIAL_SLOT_USAGE_CHARGE_CREDITS,
    });

    return [...ids, workspace.id];
  }, Promise.resolve([]));

  const fourth = await createWorkspaceForUser({
    userId: farmer.id,
    name: "Trial farm target",
    maxWorkspacesPerUser: TRIAL_MAX_WORKSPACES_PER_USER,
  });
  assert.equal(
    (await getWorkspaceMemberCreditAccess({ userId: farmer.id, workspaceId: fourth.id })).trialEligible,
    false,
  );

  // Being removed from a used workspace deletes the membership row, but the
  // usage history keeps the slot burned: the fourth workspace stays locked.
  await removeWorkspaceMember({
    workspaceId: required({ value: joined[0], message: MESSAGE_EXPECTED_JOINED_WORKSPACE }),
    actorUserId: owner.id,
    targetUserId: farmer.id,
  });
  const afterLeaving = await getWorkspaceMemberCreditAccess({ userId: farmer.id, workspaceId: fourth.id });
  assert.equal(afterLeaving.trialEligible, false);
  assert.equal(afterLeaving.hasTrialCredits, false);
});

const membershipStatus = async (input: { workspaceId: string; userId: string }) => {
  const [row] = await db.workspaceMemberships.findMany({
    where: { workspaceId: input.workspaceId, userId: input.userId },
    select: { /** @external Prisma field */ status: true },
  });

  return row?.status ?? null;
};

// --- Seat sync outbox ----------------------------------------------------------------

void test("membership changes persist without queue records", async () => {
  const admin = await makeUser("wshooks");
  const member = await makeUser("wshooksmember");
  const workspaceId = admin.workspaceId;
  await ensureWorkspaceMembership({ workspaceId, userId: member.id, role: "member" });

  await suspendWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id });
  assert.equal(await membershipStatus({ workspaceId, userId: member.id }), "suspended");

  await restoreWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id, role: "member" });
  assert.equal(await membershipStatus({ workspaceId, userId: member.id }), "active");

  await removeWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id });
  assert.equal(await membershipStatus({ workspaceId, userId: member.id }), null);
});

void test("the retired charger records provider cost without debiting grants", async () => {
  const user = await makeUser("retiredcharger");
  await createCreditGrant({ userId: user.id, source: "promotional", credits: DEFAULT_INCLUDED_CREDITS_PER_PERIOD });
  const event = await recordAiCreditUsageEvent({
    userId: user.id,
    workspaceId: user.workspaceId,
    actionType: "meeting_prep",
    actionLabel: "Provider cost report",
    actualCostMicroUsd: RETIRED_CHARGER_PROVIDER_COST,
  });
  assert.equal(event?.creditsCharged, 0);
  assert.equal(event.actualCostMicroUsd, RETIRED_CHARGER_PROVIDER_COST);
  assert.equal((await getUserCreditBalanceData(user.id)).balance, DEFAULT_INCLUDED_CREDITS_PER_PERIOD);
});
