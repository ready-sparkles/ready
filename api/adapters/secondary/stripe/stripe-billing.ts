import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { BillingPlanInterval, BillingSummary } from "@readymeet/shared";

import { apiEnv } from "../../../ports/api-env";
import type { AppLogger } from "../../../ports/app-logger";
import { repositories } from "../../../ports/repository-runtime";

import type Stripe from "./sdk";
import {
  assertSubscriptionCheckoutConfigured,
  BillingError,
  expirePreviousCheckoutSession,
  getInvoicesForCustomer,
  getInvoiceSubscriptionId,
  getPaymentMethodForCustomer,
  getStripeClient,
  getSubscriptionPeriod,
  isStripeConfigured,
  isSubscriptionEntitled,
  legacyIncludedMonthlyCredits,
  requireBillingActor,
  resolveSyncedSubscriptionPlan,
  settingsUrl,
  SUBSCRIPTION_PLAN_METADATA_KEY,
  subscriptionIncludedMonthlyCredits,
  subscriptionPlanForPrice,
  subscriptionPriceIdForInterval,
  TOPUP_PRICE_PER_CREDIT_MICRO_USD,
} from "./stripe-client";
import { handleWorkspaceTopupCheckoutCompleted, syncWorkspaceSubscriptionFromStripe } from "./workspace-stripe-billing";

// Re-exported so existing routes keep their import site.
export { BillingError, isStripeConfigured, mapSubscriptionStatusToPlan, toBillingError } from "./stripe-client";

const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_CONFLICT = 409;
const HTTP_STATUS_BAD_GATEWAY = 502;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const MS_PER_SECOND = 1_000;
const ISO_DATE_PREFIX_LENGTH = 10;

const USER_NOT_FOUND_MESSAGE = "User not found.";
const USER_ACTIVE_SUBSCRIPTION_MESSAGE =
  'You already have an active subscription. Use "Manage billing" to change plans.';
const PAYMENT_PROCESSING_PRO_MESSAGE = "Your payment is processing. Pro will activate automatically.";
const PAYMENT_PROCESSING_CREDITS_MESSAGE = "Your payment is processing. Credits will arrive automatically.";
const STRIPE_NO_CHECKOUT_URL_MESSAGE = "Stripe did not return a checkout URL.";
const BILLING_NOT_CONFIGURED_MESSAGE = "Billing is not configured on this server.";
const NO_BILLING_ACCOUNT_MESSAGE = "No billing account yet. Subscribe or buy credits first.";
const CHECKOUT_WORKSPACE_MISMATCH_MESSAGE = "Checkout session does not belong to this workspace.";
const STRIPE_WEBHOOKS_NOT_CONFIGURED_MESSAGE = "Stripe webhooks are not configured on this server.";
const MISSING_STRIPE_SIGNATURE_MESSAGE = "Missing Stripe signature.";
const EXPECTED_STRIPE_SUBSCRIPTION_PAYLOAD_MESSAGE = "Expected Stripe subscription payload";

function formatTopupCreditsRangeMessage(input: { minCredits: number; maxCredits: number }): string {
  return `Top-ups must be between ${input.minCredits} and ${input.maxCredits} credits.`;
}

function isStripeSubscriptionEventObject(object: Stripe.Event.Data.Object): object is Stripe.Subscription {
  return "object" in object && object.object === "subscription" && "id" in object && typeof object.id === "string";
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

function checkoutSessionExpiresAt(session: Stripe.Checkout.Session): Date | null {
  return Number.isFinite(session.expires_at) ? new Date(session.expires_at * MS_PER_SECOND) : null;
}

type CreditGrantResult = Awaited<ReturnType<RepositoryPort["createCreditGrant"]>>;

type StripeWebhookHandleResult = {
  /** @external stripe webhook HTTP response received flag */
  received: true;
  /** @external stripe webhook HTTP response duplicate flag */
  duplicate: boolean;
};

/**
 * Grants the credit allowance for the monthly window containing `now`,
 * anchored on the subscription period start. Idempotent per window via the
 * grant's stripe reference, so webhook retries and billing/access requests can
 * both call it safely. Legacy user subscriptions only — workspace allowances
 * are derived at charge time and never minted as grants.
 */
export async function grantCurrentMonthCredits(input: {
  userId: string;
  stripeSubscriptionId: string;
  planInterval: BillingPlanInterval;
  periodStart: Date | null;
  periodEnd: Date | null;
  now?: Date;
}): Promise<CreditGrantResult> {
  // Without a period anchor the month-window reference would change every
  // day and grant a fresh allowance daily; skip until the period syncs.
  if (!input.periodStart) {
    return null;
  }
  const window = repositories().getCurrentMonthlyWindow({
    anchor: input.periodStart,
    now: input.now,
    periodEnd: input.periodEnd,
  });
  if (!window) {
    return null;
  }

  const expiresAt = input.periodEnd && window.windowEnd > input.periodEnd ? input.periodEnd : window.windowEnd;

  const subscription = await repositories().getLatestBillingSubscriptionForUser(input.userId);
  const includedCredits =
    subscription?.stripeSubscriptionId === input.stripeSubscriptionId
      ? subscription.includedCreditsPerPeriod
      : legacyIncludedMonthlyCredits(input.planInterval);

  return repositories().createCreditGrant({
    userId: input.userId,
    source: "subscription_period",
    credits: includedCredits,
    expiresAt,
    stripeReference: `${input.stripeSubscriptionId}:month:${window.windowIndex}:${window.windowStart.toISOString().slice(0, ISO_DATE_PREFIX_LENGTH)}`,
    metadata: {
      stripeSubscriptionId: input.stripeSubscriptionId,
      monthWindowIndex: window.windowIndex,
      monthWindowStart: window.windowStart.toISOString(),
    },
  });
}

/** Whether the user has a subscription whose paid period is still running. */
export async function hasActiveSubscription(...args: [userId: string]): Promise<boolean> {
  return hasActiveSubscriptionNamed({ userId: args[0] });
}

async function hasActiveSubscriptionNamed(input: { userId: string }): Promise<boolean> {
  const subscription = await repositories().getLatestBillingSubscriptionForUser(input.userId);

  if (subscription === null || !isSubscriptionEntitled(subscription)) {
    return false;
  }
  await grantCurrentMonthCredits({
    userId: input.userId,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    planInterval: subscription.planInterval === "year" ? "year" : "month",
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
  });

  return true;
}

async function ensureStripeCustomerForUser(userId: string) {
  const existing = await repositories().getBillingCustomerForUser(userId);
  if (existing !== null) {
    return existing.stripeCustomerId;
  }

  const user = await repositories().getUserById(userId);
  if (user === null) {
    throw new BillingError({ message: USER_NOT_FOUND_MESSAGE, statusCode: HTTP_STATUS_NOT_FOUND });
  }

  const customer = await getStripeClient().customers.create(
    {
      email: user.email,
      name: user.displayName,
      metadata: { readymeetUserId: userId },
    },
    { idempotencyKey: `readymeet:user-customer:${userId}` },
  );
  await repositories().upsertBillingCustomer({ userId, stripeCustomerId: customer.id });

  return customer.id;
}

export async function createSubscriptionCheckoutSession(input: {
  userId: string;
  interval: BillingPlanInterval;
  plan?: "pro" | "max";
}): Promise<string> {
  await requireBillingActor(input.userId);
  if (await hasActiveSubscriptionNamed({ userId: input.userId })) {
    throw new BillingError({
      message: USER_ACTIVE_SUBSCRIPTION_MESSAGE,
      statusCode: HTTP_STATUS_CONFLICT,
    });
  }
  assertSubscriptionCheckoutConfigured({ interval: input.interval, plan: input.plan });
  const attempt = await repositories().getOrCreatePendingBillingCheckoutAttempt({
    subjectType: "user",
    subjectId: input.userId,
    checkoutKind: "subscription",
    requestParams: { interval: input.interval, ...(input.plan !== undefined ? { plan: input.plan } : {}) },
    expirePreviousSession: expirePreviousCheckoutSession,
  });
  if (attempt.processing === true) {
    throw new BillingError({
      message: PAYMENT_PROCESSING_PRO_MESSAGE,
      statusCode: HTTP_STATUS_CONFLICT,
    });
  }
  if (isNonEmptyString(attempt.checkoutUrl)) {
    return attempt.checkoutUrl;
  }
  try {
    const customerId = await ensureStripeCustomerForUser(input.userId);
    const session = await getStripeClient().checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        line_items: [
          { price: subscriptionPriceIdForInterval({ interval: input.interval, plan: input.plan }), quantity: 1 },
        ],
        subscription_data: {
          metadata: { readymeetUserId: input.userId, [SUBSCRIPTION_PLAN_METADATA_KEY]: input.plan ?? "pro" },
        },
        metadata: { readymeetUserId: input.userId },
        allow_promotion_codes: true,
        success_url: `${settingsUrl("subscribed")}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${settingsUrl("cancelled")}&upgrade=${input.interval}`,
      },
      { idempotencyKey: attempt.requestKey },
    );
    if (!isNonEmptyString(session.url)) {
      throw new BillingError({ message: STRIPE_NO_CHECKOUT_URL_MESSAGE, statusCode: HTTP_STATUS_BAD_GATEWAY });
    }
    await repositories().saveBillingCheckoutSession({
      attemptId: attempt.id,
      stripeCheckoutSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: checkoutSessionExpiresAt(session),
    });

    return session.url;
  } catch (error) {
    try {
      await repositories().recordBillingCheckoutAttemptError({ attemptId: attempt.id, error });
    } catch (recordError) {
      if (!(recordError instanceof Error)) {
        throw error;
      }
    }
    throw error;
  }
}

export async function createTopupCheckoutSession(input: { userId: string; credits: number }): Promise<string> {
  const credits = Math.floor(input.credits);
  if (credits < apiEnv().BILLING_TOPUP_MIN_CREDITS || credits > apiEnv().BILLING_TOPUP_MAX_CREDITS) {
    throw new BillingError({
      message: formatTopupCreditsRangeMessage({
        minCredits: apiEnv().BILLING_TOPUP_MIN_CREDITS,
        maxCredits: apiEnv().BILLING_TOPUP_MAX_CREDITS,
      }),
      statusCode: HTTP_STATUS_BAD_REQUEST,
    });
  }
  if (apiEnv().STRIPE_PRICE_CREDIT_TOPUP.length === 0) {
    throw new BillingError({ message: BILLING_NOT_CONFIGURED_MESSAGE, statusCode: HTTP_STATUS_SERVICE_UNAVAILABLE });
  }

  await requireBillingActor(input.userId);
  const attempt = await repositories().getOrCreatePendingBillingCheckoutAttempt({
    subjectType: "user",
    subjectId: input.userId,
    checkoutKind: "topup",
    requestParams: { credits },
    expirePreviousSession: expirePreviousCheckoutSession,
  });
  if (attempt.processing === true) {
    throw new BillingError({
      message: PAYMENT_PROCESSING_CREDITS_MESSAGE,
      statusCode: HTTP_STATUS_CONFLICT,
    });
  }
  if (isNonEmptyString(attempt.checkoutUrl)) {
    return attempt.checkoutUrl;
  }
  try {
    const customerId = await ensureStripeCustomerForUser(input.userId);
    const session = await getStripeClient().checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId,
        line_items: [{ price: apiEnv().STRIPE_PRICE_CREDIT_TOPUP, quantity: credits }],
        metadata: { readymeetUserId: input.userId, credits: String(credits) },
        success_url: `${settingsUrl("topup-complete")}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: settingsUrl("cancelled"),
      },
      { idempotencyKey: attempt.requestKey },
    );
    if (!isNonEmptyString(session.url)) {
      throw new BillingError({ message: STRIPE_NO_CHECKOUT_URL_MESSAGE, statusCode: HTTP_STATUS_BAD_GATEWAY });
    }
    await repositories().saveBillingCheckoutSession({
      attemptId: attempt.id,
      stripeCheckoutSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: checkoutSessionExpiresAt(session),
    });

    return session.url;
  } catch (error) {
    try {
      await repositories().recordBillingCheckoutAttemptError({ attemptId: attempt.id, error });
    } catch (recordError) {
      if (!(recordError instanceof Error)) {
        throw error;
      }
    }
    throw error;
  }
}

export async function createBillingPortalSession(...args: [userId: string]): Promise<string | null> {
  return createBillingPortalSessionNamed({ userId: args[0] });
}

async function createBillingPortalSessionNamed(input: { userId: string }): Promise<string | null> {
  const existing = await repositories().getBillingCustomerForUser(input.userId);
  if (existing === null) {
    throw new BillingError({ message: NO_BILLING_ACCOUNT_MESSAGE, statusCode: HTTP_STATUS_NOT_FOUND });
  }

  const session = await getStripeClient().billingPortal.sessions.create({
    customer: existing.stripeCustomerId,
    return_url: settingsUrl("portal-return"),
  });

  return session.url;
}

export async function getBillingSummaryForUser(userId: string): Promise<BillingSummary> {
  await hasActiveSubscription(userId);
  const [plan, subscription, credits, billingCustomer, hasPrivateBetaProCredit] = await Promise.all([
    repositories().getUserPlan(userId),
    repositories().getLatestBillingSubscriptionForUser(userId),
    repositories().getUserCreditBalanceData(userId),
    repositories().getBillingCustomerForUser(userId),
    repositories().hasPrivateBetaProCreditEntitlement(userId),
  ]);

  // A cancelled subscription keeps its billing view until the paid period
  // ends; past that the user is back on the free pitch even if the webhook
  // that flips the status has not arrived yet.
  const subscriptionSummary =
    subscription !== null && isSubscriptionEntitled(subscription)
      ? {
          status: subscription.status,
          planInterval: subscription.planInterval === "year" ? ("year" as const) : ("month" as const),
          includedCreditsPerPeriod: subscription.includedCreditsPerPeriod,
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          /** @external BillingSummary.subscription.cancelAtPeriodEnd */
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null;

  // Only hit Stripe for payment method/invoices once a customer exists
  // (i.e. the user has checked out at least once); free users never have one.
  const [paymentMethod, invoices] =
    billingCustomer !== null && isStripeConfigured()
      ? await Promise.all([
          (async () => {
            try {
              return await getPaymentMethodForCustomer(billingCustomer.stripeCustomerId);
            } catch (error) {
              if (!(error instanceof Error)) {
                return null;
              }

              return null;
            }
          })(),
          (async () => {
            try {
              return await getInvoicesForCustomer(billingCustomer.stripeCustomerId);
            } catch (error) {
              if (!(error instanceof Error)) {
                return [];
              }

              return [];
            }
          })(),
        ])
      : [null, []];

  return {
    plan: plan ?? "free",
    /** @external BillingSummary.privateBetaPro */
    privateBetaPro: hasPrivateBetaProCredit,
    subscription: subscriptionSummary,
    credits: {
      balance: credits.balance,
      subscriptionCredits: credits.subscriptionCredits,
      topupCredits: credits.topupCredits,
      promotionalCredits: credits.promotionalCredits,
      nextExpiry: credits.nextExpiry?.toISOString() ?? null,
    },
    topup: {
      minCredits: apiEnv().BILLING_TOPUP_MIN_CREDITS,
      maxCredits: apiEnv().BILLING_TOPUP_MAX_CREDITS,
      pricePerCreditMicroUsd: TOPUP_PRICE_PER_CREDIT_MICRO_USD,
    },
    /** @external BillingSummary.checkoutAvailable */
    checkoutAvailable: isStripeConfigured(),
    paymentMethod,
    invoices,
  };
}

// --- Webhook handling -------------------------------------------------------

export type SubscriptionSubject = { type: "workspace"; workspaceId: string } | { type: "user"; userId: string };

/**
 * Who a Stripe subscription belongs to. Workspace signals win (metadata set
 * at checkout, then the workspace customer registry); legacy user
 * subscriptions resolve exactly as before the workspace-billing dark launch.
 */
export async function resolveSubscriptionSubject(
  subscription: Stripe.Subscription,
): Promise<SubscriptionSubject | null> {
  const workspaceFromMetadata = subscription.metadata.readymeetWorkspaceId;
  if (isNonEmptyString(workspaceFromMetadata)) {
    return { type: "workspace", workspaceId: workspaceFromMetadata };
  }

  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const workspaceId = await repositories().getWorkspaceIdForStripeCustomer(customerId);
  if (isNonEmptyString(workspaceId)) {
    return { type: "workspace", workspaceId };
  }

  const userFromMetadata = subscription.metadata.readymeetUserId;
  if (isNonEmptyString(userFromMetadata)) {
    return { type: "user", userId: userFromMetadata };
  }
  const userId = await repositories().getUserIdForStripeCustomer(customerId);

  return isNonEmptyString(userId) ? { type: "user", userId } : null;
}

async function syncUserSubscriptionFromStripe(input: { userId: string; subscription: Stripe.Subscription }) {
  const { userId, subscription } = input;
  const item = subscription.items.data[0];
  const interval: BillingPlanInterval = item?.price.recurring?.interval === "year" ? "year" : "month";
  const period = getSubscriptionPeriod(subscription);

  const plan = subscriptionPlanForPrice({ priceId: item?.price.id ?? "", metadata: subscription.metadata });
  const existing = await repositories().getLatestBillingSubscriptionForUser(userId);
  const includedCredits = subscriptionIncludedMonthlyCredits({
    plan,
    interval,
    existing,
    stripeSubscriptionId: subscription.id,
  });
  const persistedSubscription = await repositories().upsertBillingSubscription({
    userId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: item?.price.id ?? "unknown",
    status: subscription.status,
    planInterval: interval,
    includedCreditsPerPeriod: includedCredits,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    // The billing portal schedules cancellations via cancel_at rather than
    // the cancel_at_period_end flag, so honor either form.
    cancelAtPeriodEnd: subscription.cancel_at_period_end || subscription.cancel_at !== null,
  });

  const currentPlan = await repositories().getUserPlan(userId);
  const nextPlan = resolveSyncedSubscriptionPlan({
    plan,
    currentPlan,
    persistedSubscription,
    subscriptionStatus: subscription.status,
  });
  if (nextPlan !== null) {
    await repositories().updateUserPlan({ userId, plan: nextPlan, privateBetaProEnabled: false });
  }

  return { userId, interval, periodStart: period.start, periodEnd: period.end };
}

type SyncedSubscriptionFromStripe = {
  subject: SubscriptionSubject;
  userId?: string;
  workspaceId?: string;
  interval: BillingPlanInterval;
  periodStart: Date | null;
  periodEnd: Date | null;
};

async function syncSubscriptionFromStripeNamed(input: {
  subscription: Stripe.Subscription;
  log: AppLogger;
}): Promise<SyncedSubscriptionFromStripe | null> {
  const subject = await resolveSubscriptionSubject(input.subscription);
  if (subject === null) {
    input.log.warn({ subscriptionId: input.subscription.id }, "Stripe subscription has no matching subject");

    return null;
  }

  if (subject.type === "workspace") {
    const synced = await syncWorkspaceSubscriptionFromStripe({
      workspaceId: subject.workspaceId,
      subscription: input.subscription,
      log: input.log,
    });

    return synced !== null ? { subject, ...synced } : null;
  }

  const synced = await syncUserSubscriptionFromStripe({ userId: subject.userId, subscription: input.subscription });

  return { subject, ...synced };
}

async function handleInvoicePaid(input: { invoice: Stripe.Invoice; log: AppLogger }) {
  const subscriptionId = getInvoiceSubscriptionId(input.invoice);
  if (!isNonEmptyString(subscriptionId) || !isNonEmptyString(input.invoice.id)) {
    return;
  }

  const subscription = await getStripeClient().subscriptions.retrieve(subscriptionId);
  const synced = await syncSubscriptionFromStripeNamed({ subscription, log: input.log });
  if (synced === null) {
    return;
  }

  const invoice = input.invoice;
  if (invoice.livemode && invoice.amount_paid > 0) {
    await repositories().recordAcquisitionPayment({
      transactionId: invoice.id,
      userId: synced.subject.type === "user" ? synced.subject.userId : subscription.metadata.readymeetUserId,
      workspaceId: synced.subject.type === "workspace" ? synced.subject.workspaceId : undefined,
      amountMinor: invoice.amount_paid,
      currency: invoice.currency,
      paidAt: new Date((invoice.status_transitions.paid_at ?? invoice.created) * MS_PER_SECOND),
    });
  }

  // Workspace allowances are derived at charge time, so a paid invoice only
  // needs the re-sync above. Legacy user subscriptions still mint the current
  // monthly window; billing/access requests open later months.
  if (synced.subject.type === "user") {
    const grant = await grantCurrentMonthCredits({
      userId: synced.subject.userId,
      stripeSubscriptionId: subscriptionId,
      planInterval: synced.interval,
      periodStart: synced.periodStart,
      periodEnd: synced.periodEnd,
    });
    if (grant !== null) {
      input.log.info(
        { userId: synced.subject.userId, credits: grant.credits, invoiceId: invoice.id },
        "Granted monthly subscription credits",
      );
    }
  }
}

export function isCheckoutSessionPaid(session: Stripe.Checkout.Session): boolean {
  return session.payment_status === "paid" || session.payment_status === "no_payment_required";
}

export function isCheckoutSessionSettled(session: Stripe.Checkout.Session): boolean {
  return session.status === "complete" && isCheckoutSessionPaid(session);
}

function isCheckoutSubscriptionEntitledNamed(input: {
  session: Stripe.Checkout.Session;
  entitledStripeSubscriptionId: string | null;
}): boolean {
  if (!isCheckoutSessionSettled(input.session) || input.session.mode !== "subscription") {
    return false;
  }
  const checkoutSubscriptionId =
    typeof input.session.subscription === "string" ? input.session.subscription : input.session.subscription?.id;

  return isNonEmptyString(checkoutSubscriptionId) && checkoutSubscriptionId === input.entitledStripeSubscriptionId;
}

export function isCheckoutSubscriptionEntitled(
  ...args: [session: Stripe.Checkout.Session, entitledStripeSubscriptionId: string | null]
): boolean {
  return isCheckoutSubscriptionEntitledNamed({
    session: args[0],
    entitledStripeSubscriptionId: args[1],
  });
}

function isPaymentIntentTerminalFailure(paymentIntent: Stripe.PaymentIntent | null | undefined): boolean {
  return (
    paymentIntent?.status === "canceled" ||
    (paymentIntent?.status === "requires_payment_method" && paymentIntent.last_payment_error !== null)
  );
}

async function loadUnpaidCheckoutPaymentIntents(input: {
  session: Stripe.Checkout.Session;
  invoice: Stripe.Invoice | null;
}): Promise<Stripe.PaymentIntent[]> {
  const stripe = getStripeClient();
  const intent = input.session.payment_intent;
  if (intent !== null) {
    const intentId = typeof intent === "string" ? intent : intent.id;

    return [await stripe.paymentIntents.retrieve(intentId)];
  }

  const intents = await Promise.all(
    (input.invoice?.payments?.data ?? []).map(async (payment) => {
      const paymentIntent = payment.payment.payment_intent;

      return typeof paymentIntent === "string" ? stripe.paymentIntents.retrieve(paymentIntent) : paymentIntent;
    }),
  );

  return intents.filter((intent) => intent !== undefined);
}

async function inspectUnpaidCheckout(session: Stripe.Checkout.Session) {
  const stripe = getStripeClient();
  const invoiceId = typeof session.invoice === "string" ? session.invoice : session.invoice?.id;
  // Use the Checkout's original invoice, never a subscription's latest renewal.
  const invoice = isNonEmptyString(invoiceId)
    ? await stripe.invoices.retrieve(invoiceId, {
        expand: ["payments.data.payment.payment_intent"],
      })
    : null;
  if (invoice?.status === "paid") {
    return { isFailed: false, invoice };
  }
  if (invoice?.status === "void") {
    return { isFailed: true, invoice };
  }

  const intents = await loadUnpaidCheckoutPaymentIntents({ session, invoice });
  // Missing data, additional payments, active retries, and API errors are not failure.
  const isFailed =
    !(invoice?.payments?.has_more ?? false) &&
    intents.length !== 0 &&
    intents.every((paymentIntent) => isPaymentIntentTerminalFailure(paymentIntent));

  return { isFailed, invoice };
}

function shouldCloseFailedInitialSubscription(input: {
  session: Stripe.Checkout.Session;
  invoice: Stripe.Invoice | null;
}): boolean {
  const invoice = input.invoice;

  return (
    input.session.mode === "subscription" &&
    invoice !== null &&
    invoice.status === "void" &&
    invoice.billing_reason === "subscription_create" &&
    invoice.amount_paid === 0
  );
}

async function cancelSubscriptionUnlessAlreadyClosed(subscription: Stripe.Subscription): Promise<Stripe.Subscription> {
  if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
    return subscription;
  }

  return getStripeClient().subscriptions.cancel(subscription.id, {
    invoice_now: false,
    prorate: false,
  });
}

async function resyncSubscriptionAfterFailedCheckout(input: {
  subscription: Stripe.Subscription;
  log: AppLogger;
}): Promise<void> {
  const subject = await resolveSubscriptionSubject(input.subscription);
  if (subject === null) {
    return;
  }
  const current =
    subject.type === "workspace"
      ? await repositories().getLatestBillingSubscriptionForWorkspace(subject.workspaceId)
      : await repositories().getLatestBillingSubscriptionForUser(subject.userId);
  // An old failed checkout must never downgrade a newer paid subscription.
  if (current === null || current.stripeSubscriptionId === input.subscription.id) {
    await syncSubscriptionFromStripeNamed({ subscription: input.subscription, log: input.log });
  }
}

async function closeFailedInitialSubscription(input: {
  session: Stripe.Checkout.Session;
  invoice: Stripe.Invoice | null;
  log: AppLogger;
}) {
  // Async failures can leave an active subscription behind a void initial invoice.
  // Close only that never-paid subscription before allowing another checkout.
  if (!shouldCloseFailedInitialSubscription(input)) {
    return;
  }
  const invoice = input.invoice;
  if (invoice === null) {
    return;
  }
  const subscriptionId =
    typeof input.session.subscription === "string" ? input.session.subscription : input.session.subscription?.id;
  if (!isNonEmptyString(subscriptionId)) {
    return;
  }
  const retrievedSubscription = await getStripeClient().subscriptions.retrieve(subscriptionId);
  const latestInvoiceId =
    typeof retrievedSubscription.latest_invoice === "string"
      ? retrievedSubscription.latest_invoice
      : retrievedSubscription.latest_invoice?.id;
  if (latestInvoiceId !== invoice.id) {
    return;
  }
  const subscription = await cancelSubscriptionUnlessAlreadyClosed(retrievedSubscription);
  await resyncSubscriptionAfterFailedCheckout({ subscription, log: input.log });
}

type CheckoutCompletionStatus = "failed" | "processing";

async function markUnpaidCheckoutAttempt(input: {
  session: Stripe.Checkout.Session;
  log: AppLogger;
}): Promise<CheckoutCompletionStatus> {
  const { isFailed, invoice } = await inspectUnpaidCheckout(input.session);
  if (isFailed) {
    await closeFailedInitialSubscription({ session: input.session, invoice, log: input.log });
  }
  const status: CheckoutCompletionStatus = isFailed ? "failed" : "processing";
  await repositories().markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: input.session.id, status });

  return status;
}

async function completeSubscriptionCheckout(input: { session: Stripe.Checkout.Session; log: AppLogger }) {
  const subscriptionId =
    typeof input.session.subscription === "string" ? input.session.subscription : input.session.subscription?.id;
  if (!isNonEmptyString(subscriptionId)) {
    return;
  }
  const subscription = await getStripeClient().subscriptions.retrieve(subscriptionId);
  await syncSubscriptionFromStripeNamed({ subscription, log: input.log });
  await repositories().markBillingCheckoutAttemptBySession({
    stripeCheckoutSessionId: input.session.id,
    status: "completed",
  });
}

async function completeWorkspaceTopupCheckout(input: {
  session: Stripe.Checkout.Session;
  log: AppLogger;
  workspaceId: string;
}) {
  await handleWorkspaceTopupCheckoutCompleted({
    workspaceId: input.workspaceId,
    session: input.session,
    log: input.log,
  });
  if (input.session.livemode && input.session.payment_status === "paid") {
    await repositories().recordAcquisitionPayment({
      transactionId: input.session.id,
      workspaceId: input.workspaceId,
      userId: input.session.metadata?.readymeetUserId,
      amountMinor: input.session.amount_total ?? 0,
      currency: input.session.currency ?? "usd",
      paidAt: new Date(),
    });
  }
  await repositories().markBillingCheckoutAttemptBySession({
    stripeCheckoutSessionId: input.session.id,
    status: "completed",
  });
}

async function completeUserTopupCheckout(input: { session: Stripe.Checkout.Session; log: AppLogger }) {
  const userId = input.session.metadata?.readymeetUserId;
  const credits = Number(input.session.metadata?.credits ?? 0);
  if (!isNonEmptyString(userId) || !Number.isInteger(credits) || credits <= 0) {
    input.log.warn({ sessionId: input.session.id }, "Stripe payment session missing top-up metadata");

    return;
  }

  const grant = await repositories().createCreditGrant({
    userId,
    source: "credit_topup",
    credits,
    stripeReference: input.session.id,
    metadata: { stripeCheckoutSessionId: input.session.id },
  });
  if (grant !== null) {
    input.log.info({ userId, credits, sessionId: input.session.id }, "Granted top-up credits");
  }
  if (input.session.livemode && input.session.payment_status === "paid") {
    await repositories().recordAcquisitionPayment({
      transactionId: input.session.id,
      userId,
      amountMinor: input.session.amount_total ?? 0,
      currency: input.session.currency ?? "usd",
      paidAt: new Date(),
    });
  }
  await repositories().markBillingCheckoutAttemptBySession({
    stripeCheckoutSessionId: input.session.id,
    status: "completed",
  });
}

async function handleCheckoutSessionCompletedNamed(input: {
  session: Stripe.Checkout.Session;
  log: AppLogger;
}): Promise<CheckoutCompletionStatus | void> {
  if (input.session.status !== "complete") {
    return;
  }
  if (!isCheckoutSessionPaid(input.session)) {
    return markUnpaidCheckoutAttempt({ session: input.session, log: input.log });
  }
  if (input.session.mode === "subscription") {
    await completeSubscriptionCheckout({ session: input.session, log: input.log });

    return;
  }
  if (input.session.mode !== "payment" || !isCheckoutSessionPaid(input.session)) {
    input.log.info(
      { sessionId: input.session.id, paymentStatus: input.session.payment_status },
      "Waiting for asynchronous checkout payment confirmation",
    );

    return;
  }
  const workspaceId = input.session.metadata?.readymeetWorkspaceId;
  if (isNonEmptyString(workspaceId)) {
    await completeWorkspaceTopupCheckout({ session: input.session, log: input.log, workspaceId });

    return;
  }
  await completeUserTopupCheckout({ session: input.session, log: input.log });
}

export async function handleCheckoutSessionCompleted(
  ...args: [session: Stripe.Checkout.Session, log: AppLogger]
): Promise<CheckoutCompletionStatus | void> {
  return handleCheckoutSessionCompletedNamed({ session: args[0], log: args[1] });
}

async function retrieveCurrentSubscriptionForEvent(event: Stripe.Event): Promise<Stripe.Subscription> {
  const snapshot = event.data.object;
  if (!isStripeSubscriptionEventObject(snapshot)) {
    throw new Error(EXPECTED_STRIPE_SUBSCRIPTION_PAYLOAD_MESSAGE);
  }
  try {
    return await getStripeClient().subscriptions.retrieve(snapshot.id);
  } catch (error) {
    if (event.type === "customer.subscription.deleted") {
      return snapshot;
    }
    throw error;
  }
}

async function processStripeWebhookEventNamed(input: { event: Stripe.Event; log: AppLogger }): Promise<void> {
  const { event, log } = input;
  // Stripe emits many valid events that do not affect billing; ignore them here.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await handleCheckoutSessionCompletedNamed({ session: event.data.object, log });
      break;
    case "checkout.session.async_payment_failed":
      await handleCheckoutSessionCompletedNamed({
        session: await getStripeClient().checkout.sessions.retrieve(event.data.object.id),
        log,
      });
      await repositories().markBillingCheckoutAttemptBySession({
        stripeCheckoutSessionId: event.data.object.id,
        status: "failed",
      });
      break;
    case "checkout.session.expired":
      await repositories().markBillingCheckoutAttemptBySession({
        stripeCheckoutSessionId: event.data.object.id,
        status: "expired",
      });
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscriptionFromStripeNamed({ subscription: await retrieveCurrentSubscriptionForEvent(event), log });
      break;
    case "invoice.paid":
      await handleInvoicePaid({ invoice: event.data.object, log });
      break;
    default:
      break;
  }
}

export async function processStripeWebhookEvent(...args: [event: Stripe.Event, log: AppLogger]): Promise<void> {
  return processStripeWebhookEventNamed({ event: args[0], log: args[1] });
}

export async function confirmWorkspaceBillingCheckout(input: {
  workspaceId: string;
  sessionId: string;
  log: AppLogger;
}): Promise<
  | {
      /** @external billingCheckoutConfirmationResponseSchema */ confirmed: boolean;
      status?: "expired" | "failed" | "open" | "processing";
    }
  | { /** @external billingCheckoutConfirmationResponseSchema */ confirmed: boolean }
> {
  const session = await getStripeClient().checkout.sessions.retrieve(input.sessionId, {
    expand: ["subscription"],
  });
  if (session.metadata?.readymeetWorkspaceId !== input.workspaceId) {
    throw new BillingError({
      message: CHECKOUT_WORKSPACE_MISMATCH_MESSAGE,
      statusCode: HTTP_STATUS_FORBIDDEN,
    });
  }
  if (!isCheckoutSessionSettled(session)) {
    if (session.status === "expired") {
      await repositories().markBillingCheckoutAttemptBySession({
        stripeCheckoutSessionId: session.id,
        status: "expired",
      });

      return {
        /** @external billingCheckoutConfirmationResponseSchema */ confirmed: false,
        status: "expired" as const,
      };
    }
    const status = await handleCheckoutSessionCompletedNamed({ session, log: input.log });
    if (status === "failed" || (await repositories().getBillingCheckoutAttemptStatus(session.id)) === "failed") {
      return { /** @external billingCheckoutConfirmationResponseSchema */ confirmed: false, status: "failed" as const };
    }

    return {
      /** @external billingCheckoutConfirmationResponseSchema */
      confirmed: false,
      status: session.status === "complete" ? ("processing" as const) : ("open" as const),
    };
  }

  await handleCheckoutSessionCompletedNamed({ session, log: input.log });
  if (session.mode === "payment") {
    return { /** @external billingCheckoutConfirmationResponseSchema */ confirmed: true };
  }
  if (session.mode !== "subscription") {
    return { /** @external billingCheckoutConfirmationResponseSchema */ confirmed: false };
  }

  const entitledSubscription = await repositories().getRunningBillingSubscriptionForWorkspace({
    workspaceId: input.workspaceId,
  });
  const isConfirmed = isCheckoutSubscriptionEntitledNamed({
    session,
    entitledStripeSubscriptionId: entitledSubscription?.stripeSubscriptionId ?? null,
  });

  return {
    /** @external billingCheckoutConfirmationResponseSchema */
    confirmed: isConfirmed,
  };
}

export async function handleStripeWebhook(input: {
  rawBody: string;
  signature: string | undefined;
  log: AppLogger;
}): Promise<StripeWebhookHandleResult> {
  if (apiEnv().STRIPE_WEBHOOK_SECRET.length === 0) {
    throw new BillingError({
      message: STRIPE_WEBHOOKS_NOT_CONFIGURED_MESSAGE,
      statusCode: HTTP_STATUS_SERVICE_UNAVAILABLE,
    });
  }
  if (input.signature === undefined || input.signature.length === 0) {
    throw new BillingError({ message: MISSING_STRIPE_SIGNATURE_MESSAGE, statusCode: HTTP_STATUS_BAD_REQUEST });
  }

  const event = await getStripeClient().webhooks.constructEventAsync(
    input.rawBody,
    input.signature,
    apiEnv().STRIPE_WEBHOOK_SECRET,
  );

  const isDuplicateEvent = await repositories().hasStripeWebhookReceipt(event.id);
  if (!isDuplicateEvent) {
    await processStripeWebhookEvent(event, input.log);
    await repositories().recordStripeWebhookReceipt({ stripeEventId: event.id, eventType: event.type });
  }

  return {
    /** @external stripe webhook HTTP response received flag */
    received: true,
    /** @external stripe webhook HTTP response duplicate flag */
    duplicate: isDuplicateEvent,
  };
}
