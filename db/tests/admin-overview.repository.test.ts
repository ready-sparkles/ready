import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  anonymizeUserAccount,
  createMeeting,
  ensureWorkspaceMembership,
  getAdminAiUsageEventsData,
  getAdminOverviewData,
  getMeetingById,
  getMeetingRuntimeState,
  markMeetingActive,
  markMeetingEnded,
  markParticipantLeft,
  recordAiCreditUsageEvent,
  updateUserPlan,
  updateUserPlanByAdmin,
  upsertParticipantPresence,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";
import { upsertWorkspaceBillingSubscription } from "../adapters/secondary/postgres/workspace-billing";

after(async () => {
  await closeDbPool();
});

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const ADMIN_TEST_INCLUDED_CREDITS_PER_PERIOD = 200;
const ADMIN_TEST_SEAT_QUANTITY = 2;
const ADMIN_TEST_PERIOD_ELAPSED_DAYS = 1;
const ADMIN_TEST_PERIOD_REMAINING_DAYS = 28;
const ADMIN_USAGE_EVENTS_QUERY_LIMIT = 250;

void test("admin overview distinguishes manual, Stripe owner, and Stripe-covered member access", async () => {
  const actor = await upsertUser({
    email: `${randomUUID()}@billing-admin.readymeet.test`,
    displayName: "Billing Admin",
  });
  const manual = await upsertUser({
    email: `${randomUUID()}@manual-billing.readymeet.test`,
    displayName: "Manual Billing User",
  });
  await updateUserPlanByAdmin({ actorUserId: actor.id, targetUserId: manual.id, plan: "business" });

  const owner = await upsertUser({
    email: `${randomUUID()}@stripe-owner.readymeet.test`,
    displayName: "Stripe Billing Owner",
  });
  const member = await upsertUser({
    email: `${randomUUID()}@stripe-member.readymeet.test`,
    displayName: "Stripe Covered Member",
  });
  await ensureWorkspaceMembership({ workspaceId: owner.workspaceId, userId: member.id, role: "member" });
  await upsertWorkspaceBillingSubscription({
    workspaceId: owner.workspaceId,
    userId: owner.id,
    stripeSubscriptionId: `sub_admin_${randomUUID()}`,
    stripePriceId: "price_admin_test",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: ADMIN_TEST_INCLUDED_CREDITS_PER_PERIOD,
    seatQuantity: ADMIN_TEST_SEAT_QUANTITY,
    currentPeriodStart: new Date(
      Date.now() -
        ADMIN_TEST_PERIOD_ELAPSED_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
    ),
    currentPeriodEnd: new Date(
      Date.now() +
        ADMIN_TEST_PERIOD_REMAINING_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
    ),
  });

  const overview = await getAdminOverviewData({
    fixedInfraMonthlyCostMicroUsd: 0,
    liveKitIncludedParticipantMinutes: 0,
    liveKitParticipantMinuteCostMicroUsd: 0,
  });
  assert.equal(
    readOverviewBillingSource({ user: findOverviewUser({ users: overview.users, userId: manual.id }) }),
    "manual",
  );
  const ownerBilling = readOverviewBilling({
    user: findOverviewUser({ users: overview.users, userId: owner.id }),
  });
  assert.equal(readStringField({ record: ownerBilling, key: "source" }), "stripe_workspace");
  assert.equal(readBillingWorkspaceSubscriptionOwnerFlag({ billing: ownerBilling, index: 0 }), true);
  const memberBilling = readOverviewBilling({
    user: findOverviewUser({ users: overview.users, userId: member.id }),
  });
  assert.equal(readStringField({ record: memberBilling, key: "source" }), "stripe_workspace");
  assert.equal(readBillingWorkspaceSubscriptionOwnerFlag({ billing: memberBilling, index: 0 }), false);

  const audit = await db.adminUserPlanChanges.findMany({
    where: { targetUserId: manual.id },
    select: {
      /** @external Prisma field */ actorUserId: true,
      /** @external Prisma field */ previousPlan: true,
      /** @external Prisma field */ nextPlan: true,
      /** @external Prisma field */ source: true,
    },
  });
  assert.deepEqual(audit[0], {
    actorUserId: actor.id,
    previousPlan: "free",
    nextPlan: "business",
    source: "admin_manual",
  });
});

void test("admin overview excludes deleted accounts", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@deleted-admin-overview.readymeet.test`,
    displayName: "Deleted Admin Overview User",
  });
  const usageEvent = await recordAiCreditUsageEvent({
    userId: user.id,
    actionType: "meeting_prep",
    actionLabel: "Deleted account usage",
    actualCostMicroUsd: 0,
    minimumCredits: 0,
    idempotencyKey: `test:deleted-admin-overview:${randomUUID()}`,
  });

  await anonymizeUserAccount(user.id);

  const overview = await getAdminOverviewData({
    fixedInfraMonthlyCostMicroUsd: 0,
    liveKitIncludedParticipantMinutes: 0,
    liveKitParticipantMinuteCostMicroUsd: 0,
  });

  assert.equal(
    overview.users.some((candidate) => candidate.id === user.id),
    false,
  );

  const usageEvents = await getAdminAiUsageEventsData({
    actionType: "meeting_prep",
    limit: ADMIN_USAGE_EVENTS_QUERY_LIMIT,
  });
  assert.equal(
    usageEvents.events.some((event) => event.id === usageEvent?.id),
    false,
  );
});

void test("admin overview open rooms ignores ended meetings with stale participant presence", async () => {
  const host = await upsertUser({
    email: `${randomUUID()}@admin-overview.readymeet.test`,
    displayName: "Admin Overview Host",
  });
  const activeMeeting = await createMeeting({
    title: "Active admin overview meeting",
    roomName: `active-${randomUUID()}`,
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
  });
  const staleEndedMeeting = await createMeeting({
    title: "Ended admin overview meeting",
    roomName: `ended-${randomUUID()}`,
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
  });

  await upsertParticipantPresence({
    meetingId: activeMeeting.id,
    userId: host.id,
    role: "host",
  });
  await markMeetingActive(activeMeeting.id);

  await upsertParticipantPresence({
    meetingId: staleEndedMeeting.id,
    userId: host.id,
    role: "host",
  });
  await markMeetingActive(staleEndedMeeting.id);
  await markMeetingEnded(staleEndedMeeting.id);

  const overview = await getAdminOverviewData({
    fixedInfraMonthlyCostMicroUsd: 0,
    liveKitIncludedParticipantMinutes: 0,
    liveKitParticipantMinuteCostMicroUsd: 0,
  });
  const roomNames = readOpenRoomNames({ openRooms: overview.openRooms });

  assert.ok(roomNames.has(activeMeeting.roomName));
  assert.equal(roomNames.has(staleEndedMeeting.roomName), false);
});

void test("late presence updates cannot reactivate ended meetings", async () => {
  const host = await upsertUser({
    email: `${randomUUID()}@ended-presence.readymeet.test`,
    displayName: "Ended Presence Host",
  });
  const meeting = await createMeeting({
    title: "Ended presence meeting",
    roomName: `ended-presence-${randomUUID()}`,
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
  });

  await upsertParticipantPresence({
    meetingId: meeting.id,
    userId: host.id,
    role: "host",
  });
  await markMeetingActive(meeting.id);
  await markParticipantLeft({ meetingId: meeting.id, userId: host.id });
  await markMeetingEnded(meeting.id);

  const beforeLateWebhook = await getMeetingRuntimeState(meeting.id);
  assert.equal(beforeLateWebhook.activeHumanParticipantCount, 0);

  const latePresence = await upsertParticipantPresence({
    meetingId: meeting.id,
    userId: host.id,
    role: "host",
  });
  await markMeetingActive(meeting.id);

  const afterLateWebhook = await getMeetingRuntimeState(meeting.id);
  const refreshedMeeting = await getMeetingById(meeting.id);

  assert.equal(refreshedMeeting?.status, "ended");
  assert.equal(afterLateWebhook.activeHumanParticipantCount, 0);
  assert.ok(latePresence.leftAt);

  const staleMeeting = await createMeeting({
    title: "Stale active ended presence meeting",
    roomName: `stale-ended-presence-${randomUUID()}`,
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
  });
  await upsertParticipantPresence({
    meetingId: staleMeeting.id,
    userId: host.id,
    role: "host",
  });
  await markMeetingActive(staleMeeting.id);
  await markMeetingEnded(staleMeeting.id);

  const beforeClosingStalePresence = await getMeetingRuntimeState(staleMeeting.id);
  assert.equal(beforeClosingStalePresence.activeHumanParticipantCount, 1);

  const closedStalePresence = await upsertParticipantPresence({
    meetingId: staleMeeting.id,
    userId: host.id,
    role: "host",
  });
  await markMeetingActive(staleMeeting.id);

  const afterClosingStalePresence = await getMeetingRuntimeState(staleMeeting.id);
  const refreshedStaleMeeting = await getMeetingById(staleMeeting.id);

  assert.equal(refreshedStaleMeeting?.status, "ended");
  assert.equal(afterClosingStalePresence.activeHumanParticipantCount, 0);
  assert.ok(closedStalePresence.leftAt);
});

const MESSAGE_ADMIN_OVERVIEW_USER_NOT_FOUND = "Admin overview user not found";
const MESSAGE_ADMIN_OVERVIEW_BILLING_NOT_FOUND = "Admin overview billing not found";
const MESSAGE_ADMIN_OVERVIEW_FIELD_INVALID = "Admin overview field invalid";

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(input: { record: Record<string, unknown>; key: string }): string {
  const value = input.record[input.key];
  if (typeof value !== "string") {
    assert.fail(MESSAGE_ADMIN_OVERVIEW_FIELD_INVALID);
  }

  return value;
}

function findOverviewUser(input: { users: unknown[]; userId: string }): Record<string, unknown> {
  const user = input.users.find((candidate) => isJsonRecord(candidate) && candidate.id === input.userId);
  if (!isJsonRecord(user)) {
    assert.fail(MESSAGE_ADMIN_OVERVIEW_USER_NOT_FOUND);
  }

  return user;
}

function readOverviewBilling(input: { user: Record<string, unknown> }): Record<string, unknown> {
  const billing = input.user.billing;
  if (!isJsonRecord(billing)) {
    assert.fail(MESSAGE_ADMIN_OVERVIEW_BILLING_NOT_FOUND);
  }

  return billing;
}

function readOverviewBillingSource(input: { user: Record<string, unknown> }): string {
  return readStringField({ record: readOverviewBilling({ user: input.user }), key: "source" });
}

function readBillingWorkspaceSubscriptionOwnerFlag(input: {
  billing: Record<string, unknown>;
  index: number;
}): boolean {
  const subscriptions = input.billing.workspaceSubscriptions;
  if (!Array.isArray(subscriptions)) {
    assert.fail(MESSAGE_ADMIN_OVERVIEW_FIELD_INVALID);
  }
  const entry: unknown = subscriptions[input.index];
  if (!isJsonRecord(entry)) {
    assert.fail(MESSAGE_ADMIN_OVERVIEW_FIELD_INVALID);
  }
  const flag = entry.isBillingOwner;
  if (typeof flag !== "boolean") {
    assert.fail(MESSAGE_ADMIN_OVERVIEW_FIELD_INVALID);
  }

  return flag;
}

function readOpenRoomNames(input: { openRooms: unknown[] }): Set<string> {
  return new Set(
    input.openRooms.map((room) => {
      if (!isJsonRecord(room)) {
        assert.fail(MESSAGE_ADMIN_OVERVIEW_FIELD_INVALID);
      }

      return readStringField({ record: room, key: "roomName" });
    }),
  );
}

(["pro", "max"] as const).forEach((plan) => {
  void test(`admin overview retains the personal ${plan} plan`, async () => {
    const user = await upsertUser({ email: `${randomUUID()}@admin-plan.test`, displayName: "Paid personal user" });
    await updateUserPlan({ userId: user.id, plan });
    const overview = await getAdminOverviewData({
      fixedInfraMonthlyCostMicroUsd: 0,
      liveKitIncludedParticipantMinutes: 0,
      liveKitParticipantMinuteCostMicroUsd: 0,
    });
    assert.equal(overview.users.find((candidate) => candidate.id === user.id)?.plan, plan);
  });
});
