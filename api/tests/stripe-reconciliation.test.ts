import {
  closeDbPool,
  db,
  getBillingCheckoutAttemptStatus,
  getLatestBillingSubscriptionForUser,
  getLatestBillingSubscriptionForWorkspace,
  getOrCreatePendingBillingCheckoutAttempt,
  getUserPlan,
  getWorkspacePlan,
  markBillingCheckoutAttemptBySession,
  saveBillingCheckoutSession,
  upsertUser,
} from "@readymeet/db";
import type { FastifyBaseLogger } from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import type Stripe from "stripe";
import { z } from "zod";

import {
  confirmWorkspaceBillingCheckout,
  createSubscriptionCheckoutSession,
  handleCheckoutSessionCompleted,
} from "../adapters/secondary/stripe/stripe-billing";
import { getStripeClient } from "../adapters/secondary/stripe/stripe-client";
import { createWorkspaceSubscriptionCheckoutSession } from "../adapters/secondary/stripe/workspace-stripe-billing";
import { apiEnv } from "../composition/env";

const TOPUP_CREDITS_AMOUNT = 100;
const UNEXPECTED_SUBSCRIPTION_LOOKUP_MESSAGE = "Unexpected subscription lookup";
const UNEXPECTED_SUBSCRIPTION_CANCELLATION_MESSAGE = "Unexpected subscription cancellation";
const STRIPE_UNAVAILABLE_MESSAGE = "Stripe unavailable";
const STRIPE_PAYMENT_FAILED_CODE = "payment_failed";

const fastifyBaseLoggerSchema = z.custom<FastifyBaseLogger>(
  (value) => typeof value === "object" && value !== null && "info" in value && "warn" in value && "error" in value,
);
const checkoutSessionFixtureSchema = z.custom<Stripe.Checkout.Session>(
  (value) => typeof value === "object" && value !== null && "id" in value && "status" in value,
);
const subscriptionFixtureSchema = z.custom<Stripe.Subscription>(
  (value) => typeof value === "object" && value !== null && "id" in value && "status" in value,
);

after(closeDbPool);
const log = fastifyBaseLoggerSchema.parse({ info() {}, warn() {}, error() {} });

async function fixture(input: { t: TestContext; mode: "payment" | "subscription" }) {
  const { t, mode } = input;
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(apiEnv.DATABASE_URL).hostname));
  const owner = await upsertUser({ email: `${randomUUID()}@reconciliation.test`, displayName: "Billing fixture" });
  const subjectId = owner.workspaceId;
  t.after(async () => {
    await db.billingCheckoutAttempts.deleteMany({ where: { subjectId } });
  });
  const previousKey = apiEnv.STRIPE_SECRET_KEY;
  apiEnv.STRIPE_SECRET_KEY = "sk_test_mock_only";
  t.after(() => {
    apiEnv.STRIPE_SECRET_KEY = previousKey;
  });
  const stripe = getStripeClient();
  const session = checkoutSessionFixtureSchema.parse({
    id: `cs_test_${randomUUID()}`,
    status: "complete",
    payment_status: "unpaid",
    mode,
    payment_intent: mode === "payment" ? "pi_test" : null,
    invoice: mode === "subscription" ? "in_test_initial" : null,
    subscription: mode === "subscription" ? "sub_test" : null,
    metadata: { readymeetWorkspaceId: subjectId },
  });
  const attemptInput = {
    subjectType: "workspace" as const,
    subjectId,
    checkoutKind: mode === "payment" ? ("topup" as const) : ("subscription" as const),
    requestParams: mode === "payment" ? { credits: TOPUP_CREDITS_AMOUNT } : { interval: "month" },
  };
  const attempt = await getOrCreatePendingBillingCheckoutAttempt(attemptInput);
  await saveBillingCheckoutSession({
    attemptId: attempt.id,
    stripeCheckoutSessionId: session.id,
    checkoutUrl: "https://checkout.stripe.com/old",
    expiresAt: null,
  });
  await markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: session.id, status: "processing" });
  t.mock.method(stripe.checkout.sessions, "retrieve", async () => session);
  t.mock.method(stripe.invoices, "retrieve", async () => ({
    id: "in_test_initial",
    status: "open",
    billing_reason: "subscription_create",
    payments: { has_more: false, data: [{ payment: { payment_intent: "pi_test" } }] },
  }));
  t.mock.method(stripe.subscriptions, "retrieve", async () => {
    throw new Error(UNEXPECTED_SUBSCRIPTION_LOOKUP_MESSAGE);
  });
  t.mock.method(stripe.subscriptions, "cancel", async () => {
    throw new Error(UNEXPECTED_SUBSCRIPTION_CANCELLATION_MESSAGE);
  });

  return {
    stripe,
    session,
    input: attemptInput,
    attempt,
  };
}

(["payment", "subscription"] as const).forEach((mode) => {
  (["requires_payment_method", "canceled", "processing", "requires_action", "succeeded"] as const).forEach((status) => {
    void test(`checkout handling recovers ${mode} Checkout with PaymentIntent ${status} and no failure webhook`, async (t) => {
      const { stripe, session, input, attempt } = await fixture({ t, mode });
      t.mock.method(stripe.paymentIntents, "retrieve", async () => ({
        id: "pi_test",
        status,
        last_payment_error: { code: STRIPE_PAYMENT_FAILED_CODE },
      }));
      await handleCheckoutSessionCompleted(session, log);
      const hasFailed = status === "requires_payment_method" || status === "canceled";
      assert.equal(await getBillingCheckoutAttemptStatus(session.id), hasFailed ? "failed" : "processing");
      const confirmation = await confirmWorkspaceBillingCheckout({
        workspaceId: input.subjectId,
        sessionId: session.id,
        log,
      });
      assert.ok("status" in confirmation);
      assert.equal(confirmation.status, hasFailed ? "failed" : "processing");
      const next = await getOrCreatePendingBillingCheckoutAttempt(input);
      if (hasFailed) {
        assert.notEqual(next.id, attempt.id, "a failed payment releases the checkout lock");
      } else {
        assert.equal(next.id, attempt.id, "an unsettled payment still blocks duplicate checkout");
      }
    });
  });
});

void test("confirmation detects a missed payment failure without a webhook", async (t) => {
  const { stripe, session, input } = await fixture({ t, mode: "payment" });
  t.mock.method(stripe.paymentIntents, "retrieve", async () => ({ id: "pi_test", status: "canceled" }));
  assert.deepEqual(
    await confirmWorkspaceBillingCheckout({ workspaceId: input.subjectId, sessionId: session.id, log }),
    { /** @external stripe reconciliation fixture */ confirmed: false, status: "failed" },
  );
});

void test("Stripe lookup errors preserve processing instead of allowing another charge", async (t) => {
  const { stripe, session } = await fixture({ t, mode: "payment" });
  t.mock.method(stripe.paymentIntents, "retrieve", async () => {
    throw new Error(STRIPE_UNAVAILABLE_MESSAGE);
  });
  await assert.rejects(handleCheckoutSessionCompleted(session, log), new RegExp(STRIPE_UNAVAILABLE_MESSAGE));
  assert.equal(await getBillingCheckoutAttemptStatus(session.id), "processing");
});

(["user", "workspace"] as const).forEach((subjectType) => {
  void test(`an initial void invoice closes only the failed ${subjectType} subscription and allows a fresh Pro checkout`, async (t) => {
    const { stripe, session, input } = await fixture({ t, mode: "subscription" });
    const user = await upsertUser({
      email: `${randomUUID()}@reconciliation.readymeet.test`,
      displayName: "Payment test",
    });
    assert.ok(user.workspaceId !== "");
    const subjectId = subjectType === "user" ? user.id : user.workspaceId;
    t.after(async () => {
      await db.billingCheckoutAttempts.deleteMany({ where: { subjectId } });
      await db.workspaces.deleteMany({ where: { id: user.workspaceId } });
      await db.users.deleteMany({ where: { id: user.id } });
    });
    await db.billingCheckoutAttempts.updateMany({
      where: { subjectId: input.subjectId },
      data: { subjectType, subjectId },
    });
    const subscription = subscriptionFixtureSchema.parse({
      id: "sub_test",
      customer: "cus_test",
      status: "active",
      latest_invoice: "in_test_initial",
      metadata: subjectType === "user" ? { readymeetUserId: user.id } : { readymeetWorkspaceId: user.workspaceId },
      /** @external stripe reconciliation fixture */
      cancel_at_period_end: false,
      cancel_at: null,
      items: { data: [{ price: { id: "price_test", recurring: { interval: "month" } } }] },
    });
    t.mock.method(stripe.subscriptions, "retrieve", async () => subscription);
    t.mock.method(stripe.invoices, "retrieve", async () => ({
      id: "in_test_initial",
      status: "void",
      billing_reason: "subscription_create",
      amount_paid: 0,
    }));
    const cancel = t.mock.method(stripe.subscriptions, "cancel", async () => ({ ...subscription, status: "canceled" }));
    await handleCheckoutSessionCompleted(session, log);
    assert.equal(cancel.mock.callCount(), 1);
    assert.deepEqual(cancel.mock.calls[0]?.arguments, [
      "sub_test",
      {
        /** @external stripe reconciliation fixture */
        invoice_now: false,
        /** @external stripe reconciliation fixture */
        prorate: false,
      },
    ]);
    assert.equal(await getBillingCheckoutAttemptStatus(session.id), "failed");
    const persisted =
      subjectType === "user"
        ? await getLatestBillingSubscriptionForUser(user.id)
        : await getLatestBillingSubscriptionForWorkspace(user.workspaceId);
    assert.equal(persisted?.status, "canceled");
    assert.equal(await (subjectType === "user" ? getUserPlan(user.id) : getWorkspacePlan(user.workspaceId)), "free");
    const previousPrice = apiEnv.STRIPE_PRICE_PRO_MONTHLY;
    apiEnv.STRIPE_PRICE_PRO_MONTHLY = "price_test";
    t.after(() => {
      apiEnv.STRIPE_PRICE_PRO_MONTHLY = previousPrice;
    });
    t.mock.method(stripe.customers, "create", async () => ({ id: `cus_test_${randomUUID()}` }));
    const create = t.mock.method(stripe.checkout.sessions, "create", async () => ({
      id: `cs_test_${randomUUID()}`,
      url: "https://checkout.stripe.com/new",
    }));
    const url =
      subjectType === "user"
        ? await createSubscriptionCheckoutSession({ userId: user.id, interval: "month" })
        : await createWorkspaceSubscriptionCheckoutSession({
            workspaceId: user.workspaceId,
            actorUserId: user.id,
            interval: "month",
          });
    assert.equal(url, "https://checkout.stripe.com/new");
    assert.equal(create.mock.callCount(), 1);
  });
});

(["missing-intent", "no-failure", "partial-payments", "active-retry"] as const).forEach((state) => {
  void test(`inconclusive ${state} does not release processing protection`, async (t) => {
    const { stripe, session } = await fixture({ t, mode: "subscription" });
    t.mock.method(stripe.paymentIntents, "retrieve", async () => ({
      id: "pi_test",
      status: "requires_payment_method",
      last_payment_error: state === "no-failure" ? null : { code: STRIPE_PAYMENT_FAILED_CODE },
    }));
    t.mock.method(stripe.invoices, "retrieve", async () => ({
      id: "in_test_initial",
      status: "open",
      payments: {
        has_more: state === "partial-payments",
        data:
          state === "missing-intent"
            ? []
            : [
                { payment: { payment_intent: "pi_test" } },
                ...(state === "active-retry"
                  ? [{ payment: { payment_intent: { id: "pi_retry", status: "processing" } } }]
                  : []),
              ],
      },
    }));
    await handleCheckoutSessionCompleted(session, log);
    assert.equal(await getBillingCheckoutAttemptStatus(session.id), "processing");
  });
});

void test("an old failed invoice never cancels a subscription that has a newer invoice", async (t) => {
  const { stripe, session } = await fixture({ t, mode: "subscription" });
  t.mock.method(stripe.invoices, "retrieve", async () => ({
    id: "in_test_initial",
    status: "void",
    billing_reason: "subscription_create",
    amount_paid: 0,
  }));
  t.mock.method(stripe.subscriptions, "retrieve", async () => ({
    id: "sub_test",
    status: "active",
    latest_invoice: "in_newer",
  }));
  await handleCheckoutSessionCompleted(session, log);
  assert.equal(await getBillingCheckoutAttemptStatus(session.id), "failed");
});
