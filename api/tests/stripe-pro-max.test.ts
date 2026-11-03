import {
  closeDbPool,
  createCreditGrant,
  db,
  ensureWorkspaceMembership,
  getLatestBillingSubscriptionForUser,
  getLatestBillingSubscriptionForWorkspace,
  getUserCreditBalanceData,
  getUserPlan,
  getWorkspaceCreditBalanceData,
  getWorkspaceMemberCreditAccess,
  getWorkspacePlan,
  upsertBillingSubscription,
  upsertUser,
  upsertWorkspaceBillingSubscription,
} from "@readymeet/db";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import https from "node:https";
import { after, mock, test } from "node:test";
import pino from "pino";
import type Stripe from "stripe";
import { z } from "zod";

import { billingRoutes } from "../adapters/primary/http/routes/billing";
import { signAuthToken } from "../adapters/primary/http/support/auth";
import { grantCurrentMonthCredits, processStripeWebhookEvent } from "../adapters/secondary/stripe/stripe-billing";
import {
  BillingError,
  getStripeClient,
  isStripeConfigured,
  subscriptionPlanForPrice,
  subscriptionPriceIdForInterval,
} from "../adapters/secondary/stripe/stripe-client";
import {
  createWorkspaceSubscriptionCheckoutSession,
  createWorkspaceTopupCheckoutSession,
  getWorkspaceBillingSummary,
  syncWorkspaceSeatQuantity,
  syncWorkspaceSubscriptionFromStripe,
} from "../adapters/secondary/stripe/workspace-stripe-billing";
import { apiEnv } from "../composition/env";

const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const TOPUP_CREDITS = 100;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const MS_PER_DAY = 86400000;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;
const LATER_MONTH_DAYS = 45;
const INCLUDED_CREDITS = 250;
const SEAT_COUNT = 2;
const LEGACY_CREDITS = 170;
const PROMOTIONAL_CREDITS = 17;
const UNEXPECTED_NETWORK_MESSAGE = "Unexpected external HTTP request in Stripe test";
const networkGuard = mock.method(https, "request", () => {
  throw new Error(UNEXPECTED_NETWORK_MESSAGE);
});
after(() => networkGuard.mock.restore());
const log = pino({ level: "silent" });
after(closeDbPool);
const prices = {
  pro: { month: "price_pro_month", year: "price_pro_year" },
  max: { month: "price_max_month", year: "price_max_year" },
} as const;
Object.assign(apiEnv, {
  STRIPE_SECRET_KEY: "sk_test_mock_only",
  STRIPE_PRICE_PRO_MONTHLY: prices.pro.month,
  STRIPE_PRICE_PRO_YEARLY: prices.pro.year,
  STRIPE_PRICE_MAX_MONTHLY: prices.max.month,
  STRIPE_PRICE_MAX_YEARLY: prices.max.year,
});

(["pro", "max"] as const).forEach((plan) => {
  (["month", "year"] as const).forEach((interval) => {
    void test(`${plan} ${interval} checkout sells active seats and syncs 250 monthly credits per member`, async (t) => {
      assert.equal(subscriptionPriceIdForInterval({ interval, plan }), prices[plan][interval]);
      assert.equal(subscriptionPlanForPrice({ priceId: prices[plan][interval] }), plan);
      const owner = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Owner" });
      const member = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Member" });
      await ensureWorkspaceMembership({ workspaceId: owner.workspaceId, userId: member.id, role: "member" });
      t.mock.method(getStripeClient().customers, "create", async () => ({ id: `cus_${randomUUID()}` }));
      const checkout = t.mock.method(getStripeClient().checkout.sessions, "create", async () => ({
        id: `cs_${randomUUID()}`,
        url: "https://checkout.stripe.com/mock",
        expires_at: Math.floor(Date.now() / MS_PER_SECOND) + SECONDS_PER_HOUR,
      }));
      await createWorkspaceSubscriptionCheckoutSession({
        workspaceId: owner.workspaceId,
        actorUserId: owner.id,
        interval,
        plan,
      });
      const request = checkout.mock.calls[0]?.arguments[0];
      assert.deepEqual(request?.line_items, [{ price: prices[plan][interval], quantity: SEAT_COUNT }]);
      assert.equal(request.subscription_data?.metadata?.readymeetPlan, plan);
      const subscription = z.custom<Stripe.Subscription>().parse({
        id: `sub_${randomUUID()}`,
        status: "active",
        metadata: { readymeetUserId: owner.id, readymeetWorkspaceId: owner.workspaceId },
        /** @external Stripe subscription field */
        cancel_at_period_end: false,
        cancel_at: null,
        items: {
          data: [
            {
              price: { id: prices[plan][interval], recurring: { interval } },
              quantity: SEAT_COUNT,
              current_period_start: Math.floor(Date.now() / MS_PER_SECOND) - SECONDS_PER_MINUTE,
              current_period_end:
                Math.floor(Date.now() / MS_PER_SECOND) +
                ((interval === "year" ? DAYS_PER_YEAR : DAYS_PER_MONTH) * MS_PER_DAY) / MS_PER_SECOND,
            },
          ],
        },
      });
      await syncWorkspaceSubscriptionFromStripe({ workspaceId: owner.workspaceId, subscription, log });
      assert.equal(await getWorkspacePlan(owner.workspaceId), plan);
      const stored = await getLatestBillingSubscriptionForWorkspace(owner.workspaceId);
      assert.equal(stored?.includedCreditsPerPeriod, INCLUDED_CREDITS);
      assert.equal(stored.seatQuantity, SEAT_COUNT);
      assert.equal(
        (await getWorkspaceMemberCreditAccess({ userId: member.id, workspaceId: owner.workspaceId }))
          .allowanceRemaining,
        INCLUDED_CREDITS,
      );
      if (interval === "year") {
        await db.aiCreditUsageEvents.create({
          data: {
            userId: member.id,
            workspaceId: owner.workspaceId,
            actionType: "meeting_prep",
            actionLabel: "First month exhausted",
            creditsCharged: INCLUDED_CREDITS,
          },
        });
        assert.equal(
          (await getWorkspaceMemberCreditAccess({ userId: member.id, workspaceId: owner.workspaceId }))
            .allowanceRemaining,
          0,
        );
        const later = await getWorkspaceMemberCreditAccess({
          userId: member.id,
          workspaceId: owner.workspaceId,
          now: new Date(Date.now() + LATER_MONTH_DAYS * MS_PER_DAY),
        });
        assert.equal(later.allowanceRemaining, INCLUDED_CREDITS);
      }
    });
  });
});

void test("legacy subscribers keep their existing allowance and personal grants on webhook sync", async () => {
  const owner = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Legacy" });
  const id = `sub_${randomUUID()}`;
  const start = new Date(Date.now() - SECONDS_PER_MINUTE * MS_PER_SECOND),
    end = new Date(Date.now() + MS_PER_DAY);
  await upsertWorkspaceBillingSubscription({
    workspaceId: owner.workspaceId,
    userId: owner.id,
    stripeSubscriptionId: id,
    stripePriceId: "price_legacy",
    status: "active",
    planInterval: "year",
    includedCreditsPerPeriod: LEGACY_CREDITS,
    seatQuantity: 1,
    currentPeriodStart: start,
    currentPeriodEnd: end,
  });
  await createCreditGrant({ userId: owner.id, source: "promotional", credits: PROMOTIONAL_CREDITS });
  const subscription = z.custom<Stripe.Subscription>().parse({
    id,
    status: "active",
    metadata: { readymeetUserId: owner.id },
    /** @external Stripe subscription field */
    cancel_at_period_end: false,
    cancel_at: null,
    items: {
      data: [
        {
          price: { id: "price_legacy", recurring: { interval: "year" } },
          quantity: 1,
          current_period_start: Math.floor(start.getTime() / MS_PER_SECOND),
          current_period_end: Math.floor(end.getTime() / MS_PER_SECOND),
        },
      ],
    },
  });
  await syncWorkspaceSubscriptionFromStripe({ workspaceId: owner.workspaceId, subscription, log });
  assert.equal(
    (await getLatestBillingSubscriptionForWorkspace(owner.workspaceId))?.includedCreditsPerPeriod,
    LEGACY_CREDITS,
  );
  assert.equal((await getUserCreditBalanceData(owner.id)).balance, PROMOTIONAL_CREDITS);
  assert.equal((await getLatestBillingSubscriptionForWorkspace(owner.workspaceId))?.stripePriceId, "price_legacy");
});

(["month", "year"] as const).forEach((interval) => {
  void test(`personal Max ${interval} checkout requires workspace billing without creating a charge`, async (t) => {
    const user = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Max buyer" });
    t.mock.method(getStripeClient().customers, "create", async () => ({ id: `cus_${randomUUID()}` }));
    const checkout = t.mock.method(getStripeClient().checkout.sessions, "create", async () => ({
      id: `cs_${randomUUID()}`,
      url: "https://checkout.stripe.com/mock",
      expires_at: Math.floor(Date.now() / MS_PER_SECOND) + SECONDS_PER_HOUR,
    }));
    const app = Fastify();
    t.after(() => app.close());
    await app.register(billingRoutes);
    const token = signAuthToken({ sub: user.id, email: user.email, displayName: user.displayName });
    const response = await app.inject({
      method: "POST",
      url: "/me/billing/checkout",
      headers: { authorization: `Bearer ${token}` },
      payload: { plan: "max", interval },
    });
    assert.equal(response.statusCode, HTTP_CONFLICT, response.body);
    assert.equal(z.object({ code: z.string() }).parse(response.json()).code, "workspace_checkout_required");
    assert.equal(checkout.mock.callCount(), 0);
  });
});

void test("legacy personal renewal preserves its Stripe price, allowance, and monthly grants", async (t) => {
  const user = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Legacy personal" });
  const id = `sub_${randomUUID()}`;
  const start = new Date(Date.now() - SECONDS_PER_MINUTE * MS_PER_SECOND);
  const end = new Date(Date.now() + DAYS_PER_YEAR * MS_PER_DAY);
  await upsertBillingSubscription({
    userId: user.id,
    stripeSubscriptionId: id,
    stripePriceId: "price_legacy_personal",
    status: "active",
    planInterval: "year",
    includedCreditsPerPeriod: LEGACY_CREDITS,
    currentPeriodStart: start,
    currentPeriodEnd: end,
  });
  const subscription = z.custom<Stripe.Subscription>().parse({
    id,
    customer: "cus_legacy_personal",
    status: "active",
    metadata: { readymeetUserId: user.id },
    /** @external Stripe subscription field */
    cancel_at_period_end: false,
    cancel_at: null,
    items: {
      data: [
        {
          price: { id: "price_legacy_personal", recurring: { interval: "year" } },
          current_period_start: Math.floor(start.getTime() / MS_PER_SECOND),
          current_period_end: Math.floor(end.getTime() / MS_PER_SECOND),
        },
      ],
    },
  });
  t.mock.method(getStripeClient().subscriptions, "retrieve", async () => subscription);
  const renewal = z.custom<Stripe.Event>().parse({
    type: "invoice.paid",
    data: {
      object: { id: `in_${randomUUID()}`, subscription: id, /** @external Stripe invoice field */ livemode: false },
    },
  });
  await processStripeWebhookEvent(renewal, log);
  await processStripeWebhookEvent(renewal, log);
  const stored = await getLatestBillingSubscriptionForUser(user.id);
  assert.equal(stored?.stripePriceId, "price_legacy_personal");
  assert.equal(stored.includedCreditsPerPeriod, LEGACY_CREDITS);
  assert.equal(await getUserPlan(user.id), "business");
  const grantInput = {
    userId: user.id,
    stripeSubscriptionId: id,
    planInterval: "year" as const,
    periodStart: start,
    periodEnd: end,
  };

  assert.equal(
    (await getUserCreditBalanceData(user.id)).subscriptionCredits,
    LEGACY_CREDITS,
    "retries do not duplicate grants",
  );
  const later = await grantCurrentMonthCredits({
    ...grantInput,
    now: new Date(Date.now() + LATER_MONTH_DAYS * MS_PER_DAY),
  });
  assert.equal(later?.credits, LEGACY_CREDITS);
});

void test("Pro checkout fails closed without Pro prices while legacy BUSINESS subscriptions stay recognized", (t) => {
  const previous = { ...apiEnv };
  Object.assign(apiEnv, {
    STRIPE_PRICE_PRO_MONTHLY: "",
    STRIPE_PRICE_PRO_YEARLY: "",
    STRIPE_PRICE_MAX_MONTHLY: "",
    STRIPE_PRICE_MAX_YEARLY: "",
    STRIPE_PRICE_BUSINESS_MONTHLY: "price_legacy",
    STRIPE_PRICE_BUSINESS_YEARLY: "price_legacy_year",
  });
  t.after(() => Object.assign(apiEnv, previous));
  assert.equal(subscriptionPlanForPrice({ priceId: "price_legacy" }), null);
  assert.equal(subscriptionPlanForPrice({ priceId: "price_legacy", metadata: { readymeetPlan: "pro" } }), "pro");
  assert.equal(subscriptionPlanForPrice({ priceId: "price_legacy_year", metadata: { readymeetPlan: "pro" } }), "pro");
  assert.equal(subscriptionPlanForPrice({ priceId: "price_other", metadata: { readymeetPlan: "pro" } }), null);
  (["pro", "max"] as const).forEach((plan) => {
    (["month", "year"] as const).forEach((interval) => {
      assert.throws(
        () => subscriptionPriceIdForInterval({ plan, interval }),
        (error: unknown) => {
          assert.ok(error instanceof BillingError);
          assert.equal(error.statusCode, HTTP_UNAVAILABLE);

          return true;
        },
        `${plan}/${interval}`,
      );
    });
  });
});

void test("BUSINESS-only webhook sync keeps legacy allowances and gives fallback Pro purchases Pro credits", async (t) => {
  const previous = { ...apiEnv };
  Object.assign(apiEnv, {
    STRIPE_PRICE_PRO_MONTHLY: "",
    STRIPE_PRICE_PRO_YEARLY: "",
    STRIPE_PRICE_MAX_MONTHLY: "",
    STRIPE_PRICE_MAX_YEARLY: "",
    STRIPE_PRICE_BUSINESS_MONTHLY: "price_legacy",
    STRIPE_PRICE_BUSINESS_YEARLY: "price_legacy_year",
  });
  t.after(() => Object.assign(apiEnv, previous));
  const start = new Date(Date.now() - SECONDS_PER_MINUTE * MS_PER_SECOND),
    end = new Date(Date.now() + MS_PER_DAY);
  const stripeSubscription = (input: { id: string; metadata: Record<string, string> }) =>
    z.custom<Stripe.Subscription>().parse({
      id: input.id,
      status: "active",
      metadata: input.metadata,
      /** @external Stripe subscription field */
      cancel_at_period_end: false,
      cancel_at: null,
      items: {
        data: [
          {
            price: { id: "price_legacy", recurring: { interval: "month" } },
            quantity: 1,
            current_period_start: Math.floor(start.getTime() / MS_PER_SECOND),
            current_period_end: Math.floor(end.getTime() / MS_PER_SECOND),
          },
        ],
      },
    });

  const legacyOwner = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Legacy BUSINESS" });
  const legacyId = `sub_${randomUUID()}`;
  await upsertWorkspaceBillingSubscription({
    workspaceId: legacyOwner.workspaceId,
    userId: legacyOwner.id,
    stripeSubscriptionId: legacyId,
    stripePriceId: "price_legacy",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: LEGACY_CREDITS,
    seatQuantity: 1,
    currentPeriodStart: start,
    currentPeriodEnd: end,
  });
  await syncWorkspaceSubscriptionFromStripe({
    workspaceId: legacyOwner.workspaceId,
    subscription: stripeSubscription({
      id: legacyId,
      metadata: { readymeetUserId: legacyOwner.id, readymeetWorkspaceId: legacyOwner.workspaceId },
    }),
    log,
  });
  assert.equal(
    (await getLatestBillingSubscriptionForWorkspace(legacyOwner.workspaceId))?.includedCreditsPerPeriod,
    LEGACY_CREDITS,
  );
  assert.notEqual(await getWorkspacePlan(legacyOwner.workspaceId), "pro");

  const proOwner = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Fallback Pro" });
  await syncWorkspaceSubscriptionFromStripe({
    workspaceId: proOwner.workspaceId,
    subscription: stripeSubscription({
      id: `sub_${randomUUID()}`,
      metadata: {
        readymeetUserId: proOwner.id,
        readymeetWorkspaceId: proOwner.workspaceId,
        readymeetPlan: "pro",
      },
    }),
    log,
  });
  assert.equal(
    (await getLatestBillingSubscriptionForWorkspace(proOwner.workspaceId))?.includedCreditsPerPeriod,
    INCLUDED_CREDITS,
  );
  assert.equal(await getWorkspacePlan(proOwner.workspaceId), "pro");
});

void test("legacy Stripe operations and shared pool top-ups work before the Pro/Max catalog is configured", async (t) => {
  const previous = { ...apiEnv };
  Object.assign(apiEnv, {
    STRIPE_PRICE_PRO_MONTHLY: "",
    STRIPE_PRICE_PRO_YEARLY: "",
    STRIPE_PRICE_MAX_MONTHLY: "",
    STRIPE_PRICE_MAX_YEARLY: "",
    STRIPE_PRICE_BUSINESS_MONTHLY: "price_legacy",
    STRIPE_PRICE_BUSINESS_YEARLY: "price_legacy_year",
    STRIPE_PRICE_CREDIT_TOPUP: "price_topup",
    STRIPE_WEBHOOK_SECRET: "whsec_mock_only",
  });
  t.after(() => Object.assign(apiEnv, previous));
  assert.equal(isStripeConfigured(), true);
  const owner = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Legacy operations" });
  const member = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Pool member" });
  await ensureWorkspaceMembership({ workspaceId: owner.workspaceId, userId: member.id, role: "member" });
  t.mock.method(getStripeClient().customers, "create", async () => ({ id: `cus_${randomUUID()}` }));
  const sessionId = `cs_${randomUUID()}`;
  const checkout = t.mock.method(getStripeClient().checkout.sessions, "create", async () => ({
    id: sessionId,
    url: "https://checkout.stripe.com/mock",
    expires_at: Math.floor(Date.now() / MS_PER_SECOND) + SECONDS_PER_HOUR,
  }));
  await createWorkspaceTopupCheckoutSession({
    workspaceId: owner.workspaceId,
    actorUserId: owner.id,
    credits: TOPUP_CREDITS,
  });
  assert.deepEqual(checkout.mock.calls[0]?.arguments[0]?.line_items, [
    { price: "price_topup", quantity: TOPUP_CREDITS },
  ]);
  const event = z.custom<Stripe.Event>().parse({
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        metadata: {
          readymeetWorkspaceId: owner.workspaceId,
          readymeetUserId: owner.id,
          credits: String(TOPUP_CREDITS),
        },
      },
    },
  });
  await processStripeWebhookEvent(event, log);
  await processStripeWebhookEvent(event, log);
  assert.equal((await getWorkspaceCreditBalanceData(owner.workspaceId)).topupCredits, TOPUP_CREDITS);
  assert.equal(
    (await getWorkspaceMemberCreditAccess({ userId: member.id, workspaceId: owner.workspaceId })).poolBalance,
    TOPUP_CREDITS,
  );
  assert.equal((await getUserCreditBalanceData(owner.id)).topupCredits, 0);

  const paymentMethod = { id: "pm_mock", type: "card", card: { brand: "visa", last4: "4242" } };
  t.mock.method(getStripeClient().customers, "retrieve", async () => ({
    invoice_settings: { default_payment_method: paymentMethod },
  }));
  const invoices = t.mock.method(getStripeClient().invoices, "list", async () => ({ data: [] }));
  const summary = await getWorkspaceBillingSummary({ workspaceId: owner.workspaceId, viewerUserId: owner.id });
  assert.deepEqual(summary.subscriptionCheckoutOptions, []);
  assert.equal(summary.paymentMethod?.last4, "4242");
  assert.equal(invoices.mock.callCount(), 1);
  const id = `sub_${randomUUID()}`;
  await upsertWorkspaceBillingSubscription({
    workspaceId: owner.workspaceId,
    userId: owner.id,
    stripeSubscriptionId: id,
    stripePriceId: "price_legacy",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: LEGACY_CREDITS,
    seatQuantity: 1,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + MS_PER_DAY),
  });
  t.mock.method(getStripeClient().subscriptions, "retrieve", async () => ({
    items: { data: [{ id: "si_legacy", quantity: 1, price: { id: "price_legacy" } }] },
  }));
  const update = t.mock.method(getStripeClient().subscriptionItems, "update", async () => ({}));
  assert.equal((await syncWorkspaceSeatQuantity({ workspaceId: owner.workspaceId, log })).outcome, "updated");
  assert.equal(update.mock.calls[0]?.arguments[0], "si_legacy");
  assert.deepEqual(update.mock.calls[0].arguments[1], {
    quantity: SEAT_COUNT,
    proration_behavior: "create_prorations",
  });
});

void test("a plan without a configured price is unavailable and its failed checkout does not block the other plan", async (t) => {
  const previous = { ...apiEnv };
  Object.assign(apiEnv, {
    STRIPE_PRICE_MAX_MONTHLY: "",
    STRIPE_PRICE_MAX_YEARLY: "",
    STRIPE_PRICE_CREDIT_TOPUP: "price_topup",
    STRIPE_WEBHOOK_SECRET: "whsec_mock_only",
  });
  t.after(() => Object.assign(apiEnv, previous));
  const owner = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Max unpriced" });
  t.mock.method(getStripeClient().customers, "create", async () => ({ id: `cus_${randomUUID()}` }));
  t.mock.method(getStripeClient().paymentMethods, "list", async () => ({ data: [] }));
  t.mock.method(getStripeClient().invoices, "list", async () => ({ data: [] }));
  const summary = await getWorkspaceBillingSummary({ workspaceId: owner.workspaceId, viewerUserId: owner.id });
  assert.equal(summary.checkoutAvailable, true);
  assert.deepEqual(summary.subscriptionCheckoutOptions, [
    { plan: "pro", interval: "month" },
    { plan: "pro", interval: "year" },
  ]);
  await assert.rejects(
    createWorkspaceSubscriptionCheckoutSession({
      workspaceId: owner.workspaceId,
      actorUserId: owner.id,
      interval: "month",
      plan: "max",
    }),
    (error: unknown) => error instanceof BillingError && error.statusCode === HTTP_UNAVAILABLE,
  );
  const checkout = t.mock.method(getStripeClient().checkout.sessions, "create", async () => ({
    id: `cs_${randomUUID()}`,
    url: "https://checkout.stripe.com/mock",
    expires_at: Math.floor(Date.now() / MS_PER_SECOND) + SECONDS_PER_HOUR,
  }));
  const url = await createWorkspaceSubscriptionCheckoutSession({
    workspaceId: owner.workspaceId,
    actorUserId: owner.id,
    interval: "month",
    plan: "pro",
  });
  assert.equal(url, "https://checkout.stripe.com/mock");
  assert.deepEqual(checkout.mock.calls[0]?.arguments[0]?.line_items, [{ price: prices.pro.month, quantity: 1 }]);
});
