import "../composition/env";

import { closeDbPool, db, hasMemoryNotesEntitlement } from "@readymeet/db";
import { memoryFixture } from "@readymeet/db/testing/memory";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { resolveMeetingNotesAccess } from "../application/meeting-notes-access";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const PROMOTIONAL_GRANT_CREDITS = 5;
const TRIAL_USAGE_CREDITS = 750;
const SUBSCRIPTION_INCLUDED_CREDITS = 1000;
const EXHAUSTED_INCLUDED_CREDITS = 700;
const SUBSCRIPTION_LOOKBACK_DAYS = 2;
const PAST_DUE_WITHIN_GRACE_DAYS = 1;
const PAST_DUE_BEYOND_GRACE_DAYS = 8;
const STALE_ANCHOR_MONTHS = 14;
const SUBSCRIPTION_PERIOD_YEARS = 1;
const MONTH_START_DAY = 1;
const MISSING_MEETING_MESSAGE = "Expected the meeting row.";

const EXTERNAL_MEETING_SCENARIOS = [false, true];

type NotesMeeting = {
  id: string;
  status: string;
  kind: string;
  workspaceId: string;
  createdByUserId: string;
  createdAt: Date;
};

after(closeDbPool);

function addUtcYears(input: { from: Date; years: number }): Date {
  const next = new Date(input.from);
  next.setUTCFullYear(next.getUTCFullYear() + input.years);

  return next;
}

function subtractUtcMonths(input: { from: Date; months: number }): Date {
  const next = new Date(input.from);
  next.setUTCMonth(next.getUTCMonth() - input.months);

  return next;
}

function utcMonthStartMinusOneDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), MONTH_START_DAY) - MS_PER_DAY);
}

async function loadNotesMeeting(meetingId: string): Promise<NotesMeeting> {
  const rows = await db.meetings.findMany({
    where: { id: meetingId },
  });
  const meeting = rows[0];
  if (meeting === undefined) {
    throw new Error(MISSING_MEETING_MESSAGE);
  }

  return meeting;
}

async function assertNotesAccess(input: {
  meeting: NotesMeeting;
  userId: string;
  isExpected: boolean;
  label: string;
}): Promise<void> {
  const access = await resolveMeetingNotesAccess({
    meeting: input.meeting,
    viewerRole: "participant",
    userId: input.userId,
  });
  const isAllowed = await hasMemoryNotesEntitlement({ userId: input.userId, meetingId: input.meeting.id });
  assert.equal(!access.locked, input.isExpected, `${input.label}: public policy`);
  assert.equal(isAllowed, input.isExpected, `${input.label}: repository policy`);
}

async function applyGrantSteps(input: { meeting: NotesMeeting; userId: string; workspaceId: string; grantId: string }) {
  const { meeting, userId, workspaceId, grantId } = input;
  await db.creditGrants.create({
    data: {
      id: grantId,
      userId,
      source: "promotional",
      credits: PROMOTIONAL_GRANT_CREDITS,
      creditsRemaining: PROMOTIONAL_GRANT_CREDITS,
    },
  });
  await assertNotesAccess({ meeting, userId, isExpected: true, label: "personal grant" });
  await db.creditGrants.updateMany({
    where: { id: grantId },
    data: { expiresAt: new Date(Date.now() - MS_PER_SECOND) },
  });
  await assertNotesAccess({ meeting, userId, isExpected: true, label: "expired grant" });
  await db.creditGrants.updateMany({
    where: { id: grantId },
    data: { userId: null, workspaceId, expiresAt: null },
  });
  await assertNotesAccess({ meeting, userId, isExpected: true, label: "host workspace pool" });
  await db.creditGrants.updateMany({ where: { id: grantId }, data: { creditsRemaining: 0 } });
  await db.aiCreditUsageEvents.create({
    data: {
      userId,
      workspaceId,
      actionType: "fixture",
      actionLabel: "Fixture",
      creditsCharged: TRIAL_USAGE_CREDITS,
    },
  });
  await assertNotesAccess({
    meeting,
    userId,
    isExpected: true,
    label: "retired trial credits do not exhaust free meetings",
  });
}

async function applySubscriptionSteps(input: {
  meeting: NotesMeeting;
  userId: string;
  subscriptionUserId: string;
  workspaceId: string;
  subscriptionId: string;
}) {
  const { meeting, userId, subscriptionUserId, workspaceId, subscriptionId } = input;
  const now = new Date();
  await db.users.updateMany({ where: { id: userId }, data: { plan: "business" } });
  await db.billingSubscriptions.create({
    data: {
      id: subscriptionId,
      userId: subscriptionUserId,
      workspaceId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: "fixture",
      status: "active",
      planInterval: "year",
      includedCreditsPerPeriod: SUBSCRIPTION_INCLUDED_CREDITS,
      currentPeriodStart: new Date(now.getTime() - SUBSCRIPTION_LOOKBACK_DAYS * MS_PER_DAY),
      currentPeriodEnd: addUtcYears({ from: now, years: SUBSCRIPTION_PERIOD_YEARS }),
    },
  });
  await db.aiCreditUsageEvents.updateMany({
    where: { userId },
    data: { metadata: { allowanceCredits: TRIAL_USAGE_CREDITS } },
  });
  await assertNotesAccess({ meeting, userId, isExpected: true, label: "monthly member allowance" });
  await db.billingSubscriptions.updateMany({
    where: { id: subscriptionId },
    data: { includedCreditsPerPeriod: EXHAUSTED_INCLUDED_CREDITS },
  });
  await assertNotesAccess({ meeting, userId, isExpected: false, label: "exhausted allowance" });
  await db.billingSubscriptions.updateMany({
    where: { id: subscriptionId },
    data: {
      includedCreditsPerPeriod: SUBSCRIPTION_INCLUDED_CREDITS,
      status: "past_due",
      statusChangedAt: new Date(Date.now() - PAST_DUE_WITHIN_GRACE_DAYS * MS_PER_DAY),
    },
  });
  await assertNotesAccess({ meeting, userId, isExpected: true, label: "past-due grace" });
  await db.billingSubscriptions.updateMany({
    where: { id: subscriptionId },
    data: { statusChangedAt: new Date(Date.now() - PAST_DUE_BEYOND_GRACE_DAYS * MS_PER_DAY) },
  });
  await assertNotesAccess({ meeting, userId, isExpected: false, label: "expired grace" });
  await db.billingSubscriptions.updateMany({
    where: { id: subscriptionId },
    data: { status: "active", currentPeriodEnd: new Date(Date.now() - MS_PER_SECOND) },
  });
  await assertNotesAccess({ meeting, userId, isExpected: false, label: "expired period" });
  await db.billingSubscriptions.updateMany({
    where: { id: subscriptionId },
    data: {
      currentPeriodEnd: null,
      currentPeriodStart: subtractUtcMonths({ from: new Date(), months: STALE_ANCHOR_MONTHS }),
    },
  });
  await assertNotesAccess({ meeting, userId, isExpected: false, label: "stale anchor" });
  await db.billingSubscriptions.updateMany({
    where: { id: subscriptionId },
    data: {
      currentPeriodStart: utcMonthStartMinusOneDay(new Date()),
      includedCreditsPerPeriod: SUBSCRIPTION_INCLUDED_CREDITS,
    },
  });
  await assertNotesAccess({ meeting, userId, isExpected: true, label: "month-end anchored window" });
}

EXTERNAL_MEETING_SCENARIOS.forEach((isExternalMeeting) => {
  void test(
    `dispatch entitlement matches notes policy for ${isExternalMeeting ? "external" : "native"} meetings`,
    { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
    async () => {
      const f = await memoryFixture(
        isExternalMeeting ? { /** @external memory fixture external meeting */ external: true } : {},
      );
      const subscriptionId = randomUUID();
      const grantId = randomUUID();
      try {
        const meeting = await loadNotesMeeting(f.meetingId);
        await assertNotesAccess({ meeting, userId: f.userId, isExpected: true, label: "private beta" });
        await db.users.updateMany({ where: { id: f.userId }, data: { privateBetaProEnabledAt: null } });
        await assertNotesAccess({ meeting, userId: f.userId, isExpected: false, label: "revoked private beta" });
        await db.users.updateMany({ where: { id: f.userId }, data: { plan: "free" } });
        await assertNotesAccess({
          meeting,
          userId: f.userId,
          isExpected: true,
          label: "attendee-workspace trial membership",
        });
        await applyGrantSteps({ meeting, userId: f.userId, workspaceId: f.workspaceId, grantId });
        await applySubscriptionSteps({
          meeting,
          userId: f.userId,
          subscriptionUserId: isExternalMeeting ? f.userId : f.peer,
          workspaceId: f.workspaceId,
          subscriptionId,
        });
      } finally {
        await f.cleanup();
      }
    },
  );
});
