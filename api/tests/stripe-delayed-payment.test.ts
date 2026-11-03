import {
  closeDbPool,
  db,
  getBillingCheckoutAttemptStatus,
  getOrCreatePendingBillingCheckoutAttempt,
  getWorkspaceCheckoutProgress,
  markBillingCheckoutAttemptBySession,
  saveBillingCheckoutSession,
  upsertUser,
} from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import pino from "pino";
import type Stripe from "stripe";

import {
  BillingError,
  confirmWorkspaceBillingCheckout,
  createSubscriptionCheckoutSession,
  createTopupCheckoutSession,
  processStripeWebhookEvent,
} from "../adapters/secondary/stripe/stripe-billing";
import { getStripeClient } from "../adapters/secondary/stripe/stripe-client";
import { apiEnv } from "../composition/env";

const HTTP_CONFLICT_STATUS = 409;
const STRIPE_TEST_MESSAGES = {
  unexpectedCustomerCreation: "Unexpected Stripe customer creation",
  unexpectedCheckoutCreation: "Unexpected Stripe checkout creation",
} as const;
const CHECKOUT_KINDS = ["subscription", "topup"] as const;
const LOCAL_DATABASE_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;
const TEST_CHECKOUT_URL = "https://checkout.stripe.com/test";

const log = pino({ level: "silent" });

after(closeDbPool);

function isLocalDatabaseUrl(databaseUrl: string): boolean {
  const hostname = new URL(databaseUrl).hostname;

  return LOCAL_DATABASE_HOSTS.some((allowedHost) => allowedHost === hostname);
}

function stripeCheckoutSessionFixture(input: { workspaceId: string; sessionId: string }) {
  return {
    id: input.sessionId,
    mode: "subscription" as const,
    status: "complete" as const,
    payment_status: "unpaid" as const,
    metadata: { readymeetWorkspaceId: input.workspaceId },
    payment_intent: null,
  };
}

function stripeWebhookEventFixture(input: {
  type: Stripe.Event.Type;
  session: ReturnType<typeof stripeCheckoutSessionFixture>;
}): Stripe.Event {
  const event = { type: input.type, data: { object: input.session } };
  assert.ok(isStripeEventFixture(event));

  return event;
}

function isStripeEventFixture(value: object): value is Stripe.Event {
  return "type" in value && "data" in value;
}

CHECKOUT_KINDS.forEach((checkoutKind) => {
  void test(`legacy user ${checkoutKind} checkout reuses open sessions but rejects processing payments`, async (t) => {
    assert.ok(isLocalDatabaseUrl(apiEnv.DATABASE_URL));
    const userId = randomUUID();
    await db.users.create({
      data: {
        id: userId,
        email: `${userId}@checkout.test`,
        displayName: "Checkout fixture",
      },
    });
    t.after(async () => {
      await db.billingCheckoutAttempts.deleteMany({ where: { subjectId: userId } });
      await db.users.deleteMany({ where: { id: userId } });
    });
    const previousKey = apiEnv.STRIPE_SECRET_KEY;
    const previousPrice = apiEnv.STRIPE_PRICE_CREDIT_TOPUP;
    const previousProPrice = apiEnv.STRIPE_PRICE_PRO_MONTHLY;
    apiEnv.STRIPE_SECRET_KEY = "sk_test_mock_only";
    apiEnv.STRIPE_PRICE_CREDIT_TOPUP = "price_test_mock_only";
    // Subscription checkout checks the selected plan's price before reusing or creating an attempt.
    apiEnv.STRIPE_PRICE_PRO_MONTHLY = "price_pro_month_mock_only";
    t.after(() => {
      apiEnv.STRIPE_SECRET_KEY = previousKey;
      apiEnv.STRIPE_PRICE_CREDIT_TOPUP = previousPrice;
      apiEnv.STRIPE_PRICE_PRO_MONTHLY = previousProPrice;
    });
    const createCustomer = t.mock.method(getStripeClient().customers, "create", async () => {
      throw new Error(STRIPE_TEST_MESSAGES.unexpectedCustomerCreation);
    });
    const createCheckout = t.mock.method(getStripeClient().checkout.sessions, "create", async () => {
      throw new Error(STRIPE_TEST_MESSAGES.unexpectedCheckoutCreation);
    });
    const credits = apiEnv.BILLING_TOPUP_MIN_CREDITS;
    const attempt = await getOrCreatePendingBillingCheckoutAttempt({
      subjectType: "user",
      subjectId: userId,
      checkoutKind,
      requestParams: checkoutKind === "subscription" ? { interval: "month" } : { credits },
    });
    const sessionId = `cs_test_${randomUUID()}`;
    await saveBillingCheckoutSession({
      attemptId: attempt.id,
      stripeCheckoutSessionId: sessionId,
      checkoutUrl: TEST_CHECKOUT_URL,
      expiresAt: null,
    });
    const checkout = () =>
      checkoutKind === "subscription"
        ? createSubscriptionCheckoutSession({ userId, interval: "month" })
        : createTopupCheckoutSession({ userId, credits });
    assert.equal(await checkout(), TEST_CHECKOUT_URL, "an open checkout is still reusable");
    await markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: sessionId, status: "processing" });
    await assert.rejects(checkout(), (error: unknown) => {
      assert.ok(error instanceof BillingError);
      assert.equal(error.statusCode, HTTP_CONFLICT_STATUS);
      assert.match(error.message, /payment is processing/);

      return true;
    });
    assert.equal(await getBillingCheckoutAttemptStatus(sessionId), "processing");
    assert.equal(createCustomer.mock.callCount(), 0);
    assert.equal(createCheckout.mock.callCount(), 0);
  });
});

void test("submitted async payment persists, confirms as processing, and stops on failure without late-event regression", async (t) => {
  assert.ok(isLocalDatabaseUrl(apiEnv.DATABASE_URL));
  const owner = await upsertUser({ email: `${randomUUID()}@delayed.test`, displayName: "Billing fixture" });
  const workspaceId = owner.workspaceId;
  t.after(async () => {
    await db.billingCheckoutAttempts.deleteMany({ where: { subjectId: workspaceId } });
  });
  const attempt = await getOrCreatePendingBillingCheckoutAttempt({
    subjectType: "workspace",
    subjectId: workspaceId,
    checkoutKind: "subscription",
    requestParams: { interval: "month" },
  });
  const sessionId = `cs_test_${randomUUID()}`;
  const session = stripeCheckoutSessionFixture({ workspaceId, sessionId });
  await saveBillingCheckoutSession({
    attemptId: attempt.id,
    stripeCheckoutSessionId: session.id,
    checkoutUrl: TEST_CHECKOUT_URL,
    expiresAt: null,
  });
  const previousKey = apiEnv.STRIPE_SECRET_KEY;
  apiEnv.STRIPE_SECRET_KEY = "sk_test_mock_only";
  t.after(() => {
    apiEnv.STRIPE_SECRET_KEY = previousKey;
  });
  // Every Stripe request is intercepted; no payment or external request is made.
  t.mock.method(getStripeClient().checkout.sessions, "retrieve", async () => session);
  const event = (type: Stripe.Event.Type) => stripeWebhookEventFixture({ type, session });
  await processStripeWebhookEvent(event("checkout.session.completed"), log);
  assert.equal((await getWorkspaceCheckoutProgress(workspaceId))?.status, "processing");
  assert.deepEqual(await confirmWorkspaceBillingCheckout({ workspaceId, sessionId: session.id, log }), {
    /** @external billing checkout confirmation wire field */
    confirmed: false,
    status: "processing",
  });
  await assert.rejects(
    confirmWorkspaceBillingCheckout({ workspaceId: randomUUID(), sessionId: session.id, log }),
    /does not belong/,
  );
  await processStripeWebhookEvent(event("checkout.session.async_payment_failed"), log);
  await processStripeWebhookEvent(event("checkout.session.completed"), log);
  assert.equal((await getWorkspaceCheckoutProgress(workspaceId))?.status, "failed");
  assert.deepEqual(await confirmWorkspaceBillingCheckout({ workspaceId, sessionId: session.id, log }), {
    /** @external billing checkout confirmation wire field */
    confirmed: false,
    status: "failed",
  });
});
