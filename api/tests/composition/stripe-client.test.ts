import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { z } from "zod";

import {
  isCheckoutSessionSettled,
  isCheckoutSubscriptionEntitled,
} from "../../adapters/secondary/stripe/stripe-billing";
import { isSubscriptionEntitled, resolveSyncedSubscriptionPlan } from "../../adapters/secondary/stripe/stripe-client";

const now = new Date("2026-08-21T12:00:00.000Z");
const future = new Date("2026-09-21T12:00:00.000Z");

void test("active and trialing subscriptions are entitled inside their period", () => {
  assert.equal(isSubscriptionEntitled({ status: "active", currentPeriodEnd: future, now }), true);
  assert.equal(isSubscriptionEntitled({ status: "trialing", currentPeriodEnd: future, now }), true);
});

void test("past-due access is bounded to seven days", () => {
  assert.equal(
    isSubscriptionEntitled({
      status: "past_due",
      currentPeriodEnd: future,
      statusChangedAt: new Date("2026-08-15T12:00:00.000Z"),
      now,
    }),
    true,
  );
  assert.equal(
    isSubscriptionEntitled({
      status: "past_due",
      currentPeriodEnd: future,
      statusChangedAt: new Date("2026-08-14T11:59:59.000Z"),
      now,
    }),
    false,
  );
});

void test("an ended period never remains entitled", () => {
  assert.equal(
    isSubscriptionEntitled({
      status: "active",
      currentPeriodEnd: new Date("2026-08-20T12:00:00.000Z"),
      now,
    }),
    false,
  );
});

void test("Checkout confirmation requires both completion and settled payment", () => {
  const session = ({
    status,
    paymentStatus,
  }: {
    status: Stripe.Checkout.Session.Status | null;
    paymentStatus: Stripe.Checkout.Session.PaymentStatus;
  }) =>
    z
      .custom<Stripe.Checkout.Session>((value): value is Stripe.Checkout.Session => (void value, true))
      .parse({
        status,
        payment_status: paymentStatus,
      });

  assert.equal(isCheckoutSessionSettled(session({ status: "complete", paymentStatus: "paid" })), true);
  assert.equal(isCheckoutSessionSettled(session({ status: "complete", paymentStatus: "no_payment_required" })), true);
  assert.equal(isCheckoutSessionSettled(session({ status: "complete", paymentStatus: "unpaid" })), false);
  assert.equal(isCheckoutSessionSettled(session({ status: "open", paymentStatus: "paid" })), false);
});

void test("subscription Checkout confirmation requires the exact synced entitled subscription", () => {
  const session = z
    .custom<Stripe.Checkout.Session>((value): value is Stripe.Checkout.Session => (void value, true))
    .parse({
      status: "complete",
      payment_status: "paid",
      mode: "subscription",
      subscription: "sub_checkout",
    });

  assert.equal(isCheckoutSubscriptionEntitled(session, null), false);
  assert.equal(isCheckoutSubscriptionEntitled(session, "sub_other"), false);
  assert.equal(isCheckoutSubscriptionEntitled(session, "sub_checkout"), true);
  assert.equal(isCheckoutSubscriptionEntitled({ ...session, payment_status: "unpaid" }, "sub_checkout"), false);
});

void test("subscription plan synchronization preserves legacy and manual plans while mapping Pro and Max", () => {
  const active = { status: "active", currentPeriodEnd: null };
  const canceled = { status: "canceled", currentPeriodEnd: null };
  (["pro", "max"] as const).forEach((plan) => {
    assert.equal(
      resolveSyncedSubscriptionPlan({
        plan,
        currentPlan: "free",
        subscriptionStatus: "active",
        persistedSubscription: active,
      }),
      plan,
    );
    assert.equal(
      resolveSyncedSubscriptionPlan({
        plan,
        currentPlan: "enterprise",
        subscriptionStatus: "active",
        persistedSubscription: active,
      }),
      null,
    );
    assert.equal(
      resolveSyncedSubscriptionPlan({
        plan,
        currentPlan: plan,
        subscriptionStatus: "canceled",
        persistedSubscription: canceled,
      }),
      "free",
    );
  });
  assert.equal(
    resolveSyncedSubscriptionPlan({
      plan: null,
      currentPlan: "free",
      subscriptionStatus: "active",
      persistedSubscription: active,
    }),
    "business",
  );
  assert.equal(
    resolveSyncedSubscriptionPlan({
      plan: null,
      currentPlan: "business_multilingual",
      subscriptionStatus: "active",
      persistedSubscription: active,
    }),
    null,
  );
  assert.equal(
    resolveSyncedSubscriptionPlan({
      plan: null,
      currentPlan: "business",
      subscriptionStatus: "past_due",
      persistedSubscription: { status: "past_due", currentPeriodEnd: null, statusChangedAt: new Date(0) },
    }),
    "free",
  );
});
