import { hasPrivateBetaUnlimitedCredits } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import {
  evaluateMeetingNotesAccess,
  FREE_PLAN_INCLUDED_NOTES_MEETINGS,
  type MeetingNotesAccess,
  resolveMeetingNotesAccess,
} from "../../application/meeting-notes-access";
import { repositories } from "../../ports/repository-runtime";

const PRIOR_HOSTED_MEETINGS_DURING_WELCOME_TRIAL = 2;
const PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP = 100;

void test("notes access starts independent reads together and waits for credit maintenance", async (t) => {
  const port = repositories();
  const calls: { values: string[] } = { values: [] };
  const gate = { release: () => {} };
  const pending = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const maintenance = { release: () => {} };
  const maintenancePending = new Promise<void>((resolve) => {
    maintenance.release = resolve;
  });
  t.mock.method(port, "getMeetingAttendeeWorkspace", async () => {
    calls.values = [...calls.values, "workspace"];
    await pending;

    return "workspace";
  });
  t.mock.method(port, "getLatestBillingSubscriptionForUser", async () => {
    calls.values = [...calls.values, "subscription"];
    await pending;

    return null;
  });
  t.mock.method(port, "getSummaryForMeeting", async () => {
    calls.values = [...calls.values, "summary"];
    await pending;

    return null;
  });
  t.mock.method(port, "releaseStalePlanCreditReservations", async () => {
    await maintenancePending;
    calls.values = [...calls.values, "released"];
  });
  t.mock.method(port, "getWorkspaceMemberCreditAccess", async () => {
    assert.ok(calls.values.includes("released"));

    return {
      /** @external workspace subscription status */
      subscriptionActive: false,
      hasTrialCredits: false,
      allowanceRemaining: 1,
      poolBalance: 0,
    };
  });
  t.mock.method(port, "sumHeldPlanCredits", async () => {
    assert.ok(calls.values.includes("released"));

    return 0;
  });
  t.mock.method(port, "getUserPlan", async () => "free");
  t.mock.method(port, "hasPrivateBetaProCreditEntitlement", async () => false);
  t.mock.method(port, "getWorkspacePlan", async () => "free");
  const result = resolveMeetingNotesAccess({
    meeting: {
      id: "meeting",
      workspaceId: "workspace",
      createdByUserId: "owner",
      status: "ended",
      kind: "standard",
      createdAt: new Date(),
    },
    viewerRole: "host",
    userId: "owner",
  });
  await setImmediate();
  const started = [...calls.values];
  gate.release();
  await setImmediate();
  assert.equal(calls.values.includes("released"), false);
  maintenance.release();
  assert.deepEqual(await result, buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }));
  assert.deepEqual([...started].sort(), ["subscription", "summary", "workspace"]);
  t.mock.method(port, "getSummaryForMeeting", async () => assert.fail("Reuse the response's summary"));
  assert.deepEqual(
    await resolveMeetingNotesAccess({
      meeting: {
        id: "meeting",
        workspaceId: "workspace",
        createdByUserId: "owner",
        status: "ended",
        kind: "standard",
        createdAt: new Date(),
      },
      viewerRole: "host",
      userId: "owner",
      summary: { model: "saved-notes" },
    }),
    buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }),
  );
});

function buildExpectedMeetingNotesAccess(input: {
  isLocked: boolean;
  reason: MeetingNotesAccess["reason"];
}): MeetingNotesAccess {
  return {
    /** @external meeting notes access payload */
    locked: input.isLocked,
    reason: input.reason,
  };
}

const baseInput = {
  meetingStatus: "ended",
  viewerRole: "participant",
  userPlan: "free",
  hasActiveSubscription: false,
  hasGrantCredits: false,
  hasAdminPlanIncludedCredits: false,
  hasTrialCredits: true,
  isTrialCappedMeeting: true,
  priorHostedStandardMeetings: 0,
} satisfies Parameters<typeof evaluateMeetingNotesAccess>[0];

void test("free hosted meetings are visible during the welcome trial allowance", () => {
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_DURING_WELCOME_TRIAL,
  });

  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }));
});

void test("free hosted meetings lock after the welcome trial allowance", () => {
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    priorHostedStandardMeetings: FREE_PLAN_INCLUDED_NOTES_MEETINGS,
  });

  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: true, reason: "upgrade_required" }));
});

void test("admin-assigned Pro users bypass the three-meeting cap with unlimited private-beta credits", () => {
  const hasAdminPlanIncludedCredits = hasPrivateBetaUnlimitedCredits({
    hasPrivateBetaProEntitlement: true,
    isWorkspaceSubscriptionActive: false,
  });
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    userPlan: "business",
    hasAdminPlanIncludedCredits,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }));
});

void test("admin-assigned Pro private-beta credits stay unlimited without a workspace subscription", () => {
  const hasAdminPlanIncludedCredits = hasPrivateBetaUnlimitedCredits({
    hasPrivateBetaProEntitlement: true,
    isWorkspaceSubscriptionActive: false,
  });

  assert.equal(hasAdminPlanIncludedCredits, true);
});

void test("stale paid plans without private-beta entitlement do not get unlimited notes credits", () => {
  const hasAdminPlanIncludedCredits = hasPrivateBetaUnlimitedCredits({
    hasPrivateBetaProEntitlement: false,
    isWorkspaceSubscriptionActive: false,
  });
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    userPlan: "business",
    hasGrantCredits: false,
    hasAdminPlanIncludedCredits,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.equal(hasAdminPlanIncludedCredits, false);
  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: true, reason: "credits_required" }));
});

void test("Stripe subscriptions do not get a second calendar-month allowance after grants are drained", () => {
  const hasAdminPlanIncludedCredits = hasPrivateBetaUnlimitedCredits({
    hasPrivateBetaProEntitlement: false,
    isWorkspaceSubscriptionActive: true,
  });
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    userPlan: "business",
    hasActiveSubscription: true,
    hasGrantCredits: false,
    hasAdminPlanIncludedCredits,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.equal(hasAdminPlanIncludedCredits, false);
  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: true, reason: "credits_required" }));
});

void test("admin-assigned Pro users bypass the three-meeting cap when purchased credits are available", () => {
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    userPlan: "business",
    hasGrantCredits: true,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }));
});

void test("admin-assigned Pro users with no grant credits still get private-beta access", () => {
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    userPlan: "business",
    hasGrantCredits: false,
    hasAdminPlanIncludedCredits: true,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }));
});

void test("active Stripe subscriptions bypass the three-meeting cap when grant credits are available", () => {
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    hasActiveSubscription: true,
    hasGrantCredits: true,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }));
});

void test("workspace subscription allowance is treated as paid notes credit", () => {
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    hasActiveSubscription: true,
    hasGrantCredits: true,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }));
});

void test("active Stripe subscriptions with no credits get a credits-required gate, not the free cap", () => {
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    hasActiveSubscription: true,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: true, reason: "credits_required" }));
});

void test("free notes depend on hosted meetings, not the removed credit trial", () => {
  assert.deepEqual(
    evaluateMeetingNotesAccess({ ...baseInput, hasTrialCredits: false }),
    buildExpectedMeetingNotesAccess({ isLocked: false, reason: null }),
  );
  assert.deepEqual(
    evaluateMeetingNotesAccess({
      ...baseInput,
      hasTrialCredits: false,
      priorHostedStandardMeetings: FREE_PLAN_INCLUDED_NOTES_MEETINGS,
    }),
    buildExpectedMeetingNotesAccess({ isLocked: true, reason: "upgrade_required" }),
  );
});

void test("private-beta unlimited credits end once the billing workspace subscribes, matching charging", () => {
  const hasAdminPlanIncludedCredits = hasPrivateBetaUnlimitedCredits({
    hasPrivateBetaProEntitlement: true,
    isWorkspaceSubscriptionActive: true,
  });
  const access = evaluateMeetingNotesAccess({
    ...baseInput,
    userPlan: "pro",
    hasActiveSubscription: true,
    hasAdminPlanIncludedCredits,
    priorHostedStandardMeetings: PRIOR_HOSTED_MEETINGS_ABOVE_FREE_TRIAL_CAP,
  });

  assert.equal(hasAdminPlanIncludedCredits, false);
  assert.deepEqual(access, buildExpectedMeetingNotesAccess({ isLocked: true, reason: "credits_required" }));
});
