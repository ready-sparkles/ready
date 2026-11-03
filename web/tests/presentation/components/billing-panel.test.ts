import type { WorkspaceBillingSummary } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  hasPrivateBetaWorkspaceAccess,
  isCheckoutOutcomeConfirmed,
} from "../../../presentation/components/billing-panel";

const INCLUDED_CREDITS_PER_SEAT = 200;
const TEST_MINIMUM_TOPUP_CREDITS = 100;
const TEST_MAXIMUM_TOPUP_CREDITS = 1_000;
const TEST_PRICE_PER_CREDIT_MICRO_USD = 100_000;

const entitledBilling: WorkspaceBillingSummary = {
  plan: "business",
  activeSeatCount: 1,
  /** @external existing wire contract */
  privateBetaPro: false,
  subscription: {
    status: "active",
    planInterval: "month",
    includedCreditsPerSeat: INCLUDED_CREDITS_PER_SEAT,
    seatQuantity: 1,
    currentPeriodEnd: null,
    /** @external existing wire contract */
    cancelAtPeriodEnd: false,
  },
  pool: {
    balance: 0,
    topupCredits: 0,
    promotionalCredits: 0,
    nextExpiry: null,
  },
  freeTrial: {
    memberCount: 1,
    remainingCredits: 0,
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

void test("private beta workspace access suppresses upgrade only without a subscription", () => {
  assert.equal(
    hasPrivateBetaWorkspaceAccess({
      /** @external existing wire contract */
      privateBetaPro: true,
      subscription: null,
    }),
    true,
  );
  assert.equal(
    hasPrivateBetaWorkspaceAccess({
      /** @external existing wire contract */
      privateBetaPro: false,
      subscription: null,
    }),
    false,
  );
  assert.equal(
    hasPrivateBetaWorkspaceAccess({
      /** @external existing wire contract */
      privateBetaPro: true,
      subscription: {
        status: "active",
        planInterval: "month",
        includedCreditsPerSeat: INCLUDED_CREDITS_PER_SEAT,
        seatQuantity: 1,
        currentPeriodEnd: null,
        /** @external existing wire contract */
        cancelAtPeriodEnd: false,
      },
    }),
    false,
  );
});

void test("subscription Checkout is shown as active only after refreshed billing exposes entitlement", () => {
  assert.equal(
    isCheckoutOutcomeConfirmed({
      outcome: "subscribed",
      /** @external existing wire contract */
      checkoutConfirmed: true,
      billing: null,
    }),
    false,
  );
  assert.equal(
    isCheckoutOutcomeConfirmed({
      outcome: "subscribed",
      /** @external existing wire contract */
      checkoutConfirmed: true,
      billing: { ...entitledBilling, subscription: null },
    }),
    false,
  );
  assert.equal(
    isCheckoutOutcomeConfirmed({
      outcome: "subscribed",
      /** @external existing wire contract */
      checkoutConfirmed: true,
      billing: entitledBilling,
    }),
    true,
  );
});

void test("top-up Checkout confirmation does not require a subscription", () => {
  assert.equal(
    isCheckoutOutcomeConfirmed({
      outcome: "topup-complete",
      /** @external existing wire contract */
      checkoutConfirmed: true,
      billing: null,
    }),
    true,
  );
});
