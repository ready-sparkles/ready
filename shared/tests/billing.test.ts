import assert from "node:assert/strict";
import test from "node:test";

import {
  FREE_PLAN_INCLUDED_NOTES_MEETINGS,
  getTrialOfferMeetingsRemaining,
  type WorkspaceBillingSummary,
  workspaceBillingSummarySchema,
} from "../domain/billing";

const TEST_SEAT_COUNT = 2;
const TEST_REMAINING_TRIAL_CREDITS = 1_250;
const TEST_MINIMUM_TOPUP_CREDITS = 100;
const TEST_MAXIMUM_TOPUP_CREDITS = 1_000;
const TEST_PRICE_PER_CREDIT_MICRO_USD = 100_000;
const HOSTED_MEETINGS_BEYOND_TRIAL_LIMIT = 7;

void test("workspace billing summary carries the viewing owners private beta entitlement", () => {
  const summaryInput: WorkspaceBillingSummary = {
    plan: "business",
    activeSeatCount: TEST_SEAT_COUNT,
    /** @external existing wire contract */
    privateBetaPro: true,
    subscription: null,
    pool: {
      balance: 0,
      topupCredits: 0,
      promotionalCredits: 0,
      nextExpiry: null,
    },
    freeTrial: {
      memberCount: TEST_SEAT_COUNT,
      remainingCredits: TEST_REMAINING_TRIAL_CREDITS,
    },
    topup: {
      minCredits: TEST_MINIMUM_TOPUP_CREDITS,
      maxCredits: TEST_MAXIMUM_TOPUP_CREDITS,
      pricePerCreditMicroUsd: TEST_PRICE_PER_CREDIT_MICRO_USD,
    },
    /** @external existing wire contract */
    checkoutAvailable: true,
    subscriptionCheckoutOptions: [
      { plan: "pro", interval: "month" },
      { plan: "pro", interval: "year" },
      { plan: "max", interval: "month" },
      { plan: "max", interval: "year" },
    ],
    paymentMethod: null,
    invoices: [],
  };
  const summary = workspaceBillingSummarySchema.parse(summaryInput);

  assert.equal(summary.privateBetaPro, true);
  assert.equal(summary.activeSeatCount, TEST_SEAT_COUNT);
  assert.equal(summary.freeTrial.remainingCredits, TEST_REMAINING_TRIAL_CREDITS);
});

void test("trial offer stops at three hosted meetings even with credits remaining", () => {
  const input = {
    isTrialEligible: true,
    hasTrialCredits: true,
    hasPaidAccess: false,
    hasGrantCredits: false,
    allowanceRemaining: 0,
    poolBalance: 0,
    hostedMeetings: 0,
  };
  assert.equal(getTrialOfferMeetingsRemaining(input), FREE_PLAN_INCLUDED_NOTES_MEETINGS);
  assert.equal(getTrialOfferMeetingsRemaining({ ...input, hostedMeetings: TEST_SEAT_COUNT }), 1);
  assert.equal(getTrialOfferMeetingsRemaining({ ...input, hostedMeetings: FREE_PLAN_INCLUDED_NOTES_MEETINGS }), 0);
  assert.equal(getTrialOfferMeetingsRemaining({ ...input, hostedMeetings: HOSTED_MEETINGS_BEYOND_TRIAL_LIMIT }), 0);
  assert.equal(getTrialOfferMeetingsRemaining({ ...input, hasTrialCredits: false }), FREE_PLAN_INCLUDED_NOTES_MEETINGS);
  assert.equal(getTrialOfferMeetingsRemaining({ ...input, isTrialEligible: false }), 0);
  assert.equal(getTrialOfferMeetingsRemaining({ ...input, hasPaidAccess: true }), 0);
});

(
  [
    ["personal grant credits", { hasGrantCredits: true }],
    ["workspace allowance", { allowanceRemaining: 1 }],
    ["purchased or promotional workspace pool credits", { poolBalance: 1 }],
  ] as const
).forEach(([label, creditAccess]) => {
  void test(`trial offer is hidden with usable ${label} on a free plan`, () => {
    const input = {
      isTrialEligible: true,
      hasTrialCredits: true,
      hasPaidAccess: false,
      hasGrantCredits: false,
      allowanceRemaining: 0,
      poolBalance: 0,
      hostedMeetings: 1,
    };
    assert.equal(getTrialOfferMeetingsRemaining({ ...input, ...creditAccess }), 0);
    // Once usable credits are exhausted, only the unconsumed trial meetings are offered.
    assert.equal(getTrialOfferMeetingsRemaining(input), FREE_PLAN_INCLUDED_NOTES_MEETINGS - 1);
    assert.equal(getTrialOfferMeetingsRemaining({ ...input, hostedMeetings: FREE_PLAN_INCLUDED_NOTES_MEETINGS }), 0);
  });
});
