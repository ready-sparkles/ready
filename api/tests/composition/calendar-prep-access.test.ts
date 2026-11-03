import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCalendarPrepAccess,
  FREE_PLAN_INCLUDED_CALENDAR_PREPS,
  shouldRequireCalendarPrepGrantCredits,
} from "../../application/calendar-prep-access";

const PRIVATE_BETA_PREP_COUNT = 4;
const WORKSPACE_SUBSCRIPTION_PREP_COUNT = 10;

void test("calendar prep access allows one free prep", () => {
  const access = evaluateCalendarPrepAccess({
    userPlan: "free",
    hasActiveSubscription: false,
    hasPrivateBetaProEntitlement: false,
    calendarPrepCount: 0,
  });

  assert.equal(access.freeCalendarPrepLimit, FREE_PLAN_INCLUDED_CALENDAR_PREPS);
  assert.equal(access.hasPrepPlan, false);
  assert.equal(access.canStartCalendarPrep, true);
  assert.equal(shouldRequireCalendarPrepGrantCredits(access), false);
  assert.equal(access.requiresGrantCredits, false);
});

void test("calendar prep access requires Pro after the free prep is consumed", () => {
  const access = evaluateCalendarPrepAccess({
    userPlan: "free",
    hasActiveSubscription: false,
    hasPrivateBetaProEntitlement: false,
    calendarPrepCount: 1,
  });

  assert.equal(access.hasPrepPlan, false);
  assert.equal(access.canStartCalendarPrep, false);
  assert.equal(shouldRequireCalendarPrepGrantCredits(access), true);
  assert.equal(access.requiresGrantCredits, true);
});

void test("calendar prep access unlocks private-beta Pro without requiring grant credits", () => {
  const paidPlanAccess = evaluateCalendarPrepAccess({
    userPlan: "business",
    hasActiveSubscription: false,
    hasPrivateBetaProEntitlement: true,
    calendarPrepCount: PRIVATE_BETA_PREP_COUNT,
  });
  assert.equal(paidPlanAccess.canStartCalendarPrep, true);
  assert.equal(shouldRequireCalendarPrepGrantCredits(paidPlanAccess), false);
  assert.equal(paidPlanAccess.requiresGrantCredits, false);
});

void test("calendar prep access does not treat stale paid plans as private-beta Pro", () => {
  const stalePaidPlanAccess = evaluateCalendarPrepAccess({
    userPlan: "business",
    hasActiveSubscription: false,
    hasPrivateBetaProEntitlement: false,
    calendarPrepCount: PRIVATE_BETA_PREP_COUNT,
  });

  assert.equal(stalePaidPlanAccess.canStartCalendarPrep, false);
  assert.equal(shouldRequireCalendarPrepGrantCredits(stalePaidPlanAccess), true);
  assert.equal(stalePaidPlanAccess.requiresGrantCredits, true);
});

void test("calendar prep access unlocks active subscriptions and requires grant credits", () => {
  const subscribedAccess = evaluateCalendarPrepAccess({
    userPlan: "free",
    hasActiveSubscription: true,
    hasPrivateBetaProEntitlement: false,
    calendarPrepCount: PRIVATE_BETA_PREP_COUNT,
  });
  assert.equal(subscribedAccess.canStartCalendarPrep, true);
  assert.equal(shouldRequireCalendarPrepGrantCredits(subscribedAccess), true);
  assert.equal(subscribedAccess.requiresGrantCredits, true);
});

void test("workspace subscriptions use the same paid prep semantics", () => {
  const workspacePaidAccess = evaluateCalendarPrepAccess({
    userPlan: "free",
    hasActiveSubscription: true,
    hasPrivateBetaProEntitlement: false,
    calendarPrepCount: WORKSPACE_SUBSCRIPTION_PREP_COUNT,
  });
  assert.equal(workspacePaidAccess.hasPrepPlan, true);
  assert.equal(workspacePaidAccess.canStartCalendarPrep, true);
  assert.equal(workspacePaidAccess.requiresGrantCredits, true);
});
