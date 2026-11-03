import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { BillingPlanInterval, WorkspaceBillingSummary } from "@readymeet/shared";
import { getTrialOfferMeetingsRemaining } from "@readymeet/shared";

import { apiEnv } from "../../../ports/api-env";
import type { AppLogger } from "../../../ports/app-logger";
import { repositories } from "../../../ports/repository-runtime";

import type Stripe from "./sdk";
import {
  assertSubscriptionCheckoutConfigured,
  availableSubscriptionCheckoutOptions,
  BillingError,
  expirePreviousCheckoutSession,
  getInvoicesForCustomer,
  getPaymentMethodForCustomer,
  getStripeClient,
  getSubscriptionPeriod,
  isStripeConfigured,
  isSubscriptionEntitled,
  requireBillingActor,
  resolveSyncedSubscriptionPlan,
  settingsUrl,
  SUBSCRIPTION_PLAN_METADATA_KEY,
  subscriptionIncludedMonthlyCredits,
  subscriptionPlanForPrice,
  subscriptionPriceIdForInterval,
  TOPUP_PRICE_PER_CREDIT_MICRO_USD,
} from "./stripe-client";

const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_CONFLICT = 409;
const HTTP_STATUS_BAD_GATEWAY = 502;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const MS_PER_SECOND = 1_000;

const WORKSPACE_NOT_FOUND_MESSAGE = "Workspace not found.";
const WORKSPACE_ACTIVE_SUBSCRIPTION_MESSAGE =
  'This workspace already has an active subscription. Use "Manage billing" to change plans.';
const PAYMENT_PROCESSING_PRO_MESSAGE = "Your payment is processing. Pro will activate automatically.";
const PAYMENT_PROCESSING_CREDITS_MESSAGE = "Your payment is processing. Credits will arrive automatically.";
const STRIPE_NO_CHECKOUT_URL_MESSAGE = "Stripe did not return a checkout URL.";
const BILLING_NOT_CONFIGURED_MESSAGE = "Billing is not configured on this server.";
const NO_BILLING_ACCOUNT_MESSAGE = "No billing account yet. Subscribe or buy credits first.";

function formatTopupCreditsRangeMessage(input: { minCredits: number; maxCredits: number }): string {
  return `Top-ups must be between ${input.minCredits} and ${input.maxCredits} credits.`;
}

function formatStripeSubscriptionNoItemsMessage(stripeSubscriptionId: string): string {
  return `Stripe subscription ${stripeSubscriptionId} has no items to size.`;
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

function checkoutSessionExpiresAt(session: Stripe.Checkout.Session): Date | null {
  return Number.isFinite(session.expires_at) ? new Date(session.expires_at * MS_PER_SECOND) : null;
}

async function workspaceExistsForStripeSubscriptionSync(input: {
  workspaceId: string;
  subscriptionId: string;
  log: AppLogger;
}): Promise<boolean> {
  const workspace = await repositories().getWorkspaceById(input.workspaceId);
  if (workspace === null) {
    input.log.warn(
      { subscriptionId: input.subscriptionId, workspaceId: input.workspaceId },
      "Stripe subscription references a deleted workspace; skipping sync",
    );

    return false;
  }

  return true;
}

async function resolveWorkspaceSubscriptionOwnerUserId(input: {
  subscription: Stripe.Subscription;
  workspaceId: string;
  log: AppLogger;
}): Promise<string | null> {
  const ownerUserId =
    input.subscription.metadata.readymeetUserId ??
    (await repositories().getOldestActiveWorkspaceAdminUserId(input.workspaceId));
  if (ownerUserId === null || ownerUserId === "") {
    input.log.warn(
      { subscriptionId: input.subscription.id, workspaceId: input.workspaceId },
      "Workspace subscription has no resolvable billing owner; skipping sync",
    );

    return null;
  }

  return ownerUserId;
}

/** Whether the workspace has a subscription whose paid period is still running. */
export async function hasActiveWorkspaceSubscription(workspaceId: string): Promise<boolean> {
  return Boolean(await repositories().getRunningBillingSubscriptionForWorkspace({ workspaceId }));
}

/**
 * The Stripe customer represents the workspace; the acting admin only lends
 * their email as the billing contact when the customer is first created.
 */
export async function ensureStripeCustomerForWorkspace(input: {
  workspaceId: string;
  actorUserId: string;
}): Promise<string> {
  const existing = await repositories().getWorkspaceBillingCustomer(input.workspaceId);
  if (existing !== null) {
    return existing.stripeCustomerId;
  }

  const [workspace, actor] = await Promise.all([
    repositories().getWorkspaceById(input.workspaceId),
    repositories().getUserById(input.actorUserId),
  ]);
  if (workspace === null) {
    throw new BillingError({ message: WORKSPACE_NOT_FOUND_MESSAGE, statusCode: HTTP_STATUS_NOT_FOUND });
  }

  const customer = await getStripeClient().customers.create(
    {
      name: workspace.name,
      email: actor?.email,
      metadata: { readymeetWorkspaceId: input.workspaceId },
    },
    { idempotencyKey: `readymeet:workspace-customer:${input.workspaceId}` },
  );
  await repositories().upsertWorkspaceBillingCustomer({
    workspaceId: input.workspaceId,
    stripeCustomerId: customer.id,
  });

  return customer.id;
}

export async function createWorkspaceSubscriptionCheckoutSession(input: {
  workspaceId: string;
  actorUserId: string;
  interval: BillingPlanInterval;
  plan?: "pro" | "max";
}): Promise<string> {
  await requireBillingActor(input.actorUserId);
  if (await hasActiveWorkspaceSubscription(input.workspaceId)) {
    throw new BillingError({
      message: WORKSPACE_ACTIVE_SUBSCRIPTION_MESSAGE,
      statusCode: HTTP_STATUS_CONFLICT,
    });
  }
  assertSubscriptionCheckoutConfigured({ interval: input.interval, plan: input.plan });
  const seatQuantity = Math.max(1, await repositories().countActiveWorkspaceMembers(input.workspaceId));
  const attempt = await repositories().getOrCreatePendingBillingCheckoutAttempt({
    subjectType: "workspace",
    subjectId: input.workspaceId,
    actorUserId: input.actorUserId,
    checkoutKind: "subscription",
    requestParams: { interval: input.interval, plan: input.plan ?? "pro" },
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
    const customerId = await ensureStripeCustomerForWorkspace(input);
    const session = await getStripeClient().checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        line_items: [
          {
            price: subscriptionPriceIdForInterval({ interval: input.interval, plan: input.plan }),
            quantity: seatQuantity,
          },
        ],
        subscription_data: {
          metadata: {
            readymeetWorkspaceId: input.workspaceId,
            readymeetUserId: input.actorUserId,
            [SUBSCRIPTION_PLAN_METADATA_KEY]: input.plan ?? "pro",
          },
        },
        metadata: { readymeetWorkspaceId: input.workspaceId },
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

export async function createWorkspaceTopupCheckoutSession(input: {
  workspaceId: string;
  actorUserId: string;
  credits: number;
}): Promise<string> {
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
    throw new BillingError({
      message: BILLING_NOT_CONFIGURED_MESSAGE,
      statusCode: HTTP_STATUS_SERVICE_UNAVAILABLE,
    });
  }

  await requireBillingActor(input.actorUserId);
  const attempt = await repositories().getOrCreatePendingBillingCheckoutAttempt({
    subjectType: "workspace",
    subjectId: input.workspaceId,
    actorUserId: input.actorUserId,
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
    const customerId = await ensureStripeCustomerForWorkspace(input);
    const session = await getStripeClient().checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId,
        line_items: [{ price: apiEnv().STRIPE_PRICE_CREDIT_TOPUP, quantity: credits }],
        metadata: {
          readymeetWorkspaceId: input.workspaceId,
          readymeetUserId: input.actorUserId,
          credits: String(credits),
        },
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

export async function createWorkspaceBillingPortalSession(workspaceId: string): Promise<string> {
  const existing = await repositories().getWorkspaceBillingCustomer(workspaceId);
  if (existing === null) {
    throw new BillingError({ message: NO_BILLING_ACCOUNT_MESSAGE, statusCode: HTTP_STATUS_NOT_FOUND });
  }

  const session = await getStripeClient().billingPortal.sessions.create({
    customer: existing.stripeCustomerId,
    return_url: settingsUrl("portal-return"),
  });

  return session.url;
}

export async function getWorkspaceBillingSummary(input: {
  workspaceId: string;
  viewerUserId: string;
}): Promise<WorkspaceBillingSummary> {
  // The owner's pool balance should not count holds whose work ended without settling.
  await repositories().releaseStalePlanCreditReservations({ workspaceId: input.workspaceId });
  const [plan, subscription, poolCredits, freeTrial, billingCustomer, hasPrivateBetaProCredit, activeSeatCount] =
    await Promise.all([
      repositories().getWorkspacePlan(input.workspaceId),
      repositories().getLatestBillingSubscriptionForWorkspace(input.workspaceId),
      repositories().getWorkspaceCreditBalanceData(input.workspaceId),
      repositories().getWorkspaceFreeTrialCreditSummary(input.workspaceId),
      repositories().getWorkspaceBillingCustomer(input.workspaceId),
      repositories().hasPrivateBetaProCreditEntitlement(input.viewerUserId),
      repositories().countActiveWorkspaceMembers(input.workspaceId),
    ]);

  const subscriptionSummary =
    subscription !== null && isSubscriptionEntitled(subscription)
      ? {
          status: subscription.status,
          planInterval: subscription.planInterval === "year" ? ("year" as const) : ("month" as const),
          includedCreditsPerSeat: subscription.includedCreditsPerPeriod,
          seatQuantity: subscription.seatQuantity,
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          /** @external WorkspaceBillingSummary.subscription.cancelAtPeriodEnd */
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null;

  const [paymentMethod, invoices] =
    billingCustomer !== null && isStripeConfigured()
      ? await Promise.all([
          (async () => {
            try {
              return await getPaymentMethodForCustomer(billingCustomer.stripeCustomerId);
            } catch (error) {
              if (!(error instanceof Error)) {
                throw error;
              }

              return null;
            }
          })(),
          (async () => {
            try {
              return await getInvoicesForCustomer(billingCustomer.stripeCustomerId);
            } catch (error) {
              if (!(error instanceof Error)) {
                throw error;
              }

              return [];
            }
          })(),
        ])
      : [null, []];

  return {
    plan: plan ?? "free",
    activeSeatCount: Math.max(1, activeSeatCount),
    /** @external WorkspaceBillingSummary.privateBetaPro */
    privateBetaPro: hasPrivateBetaProCredit,
    subscription: subscriptionSummary,
    pool: {
      balance: poolCredits.balance,
      topupCredits: poolCredits.topupCredits,
      promotionalCredits: poolCredits.promotionalCredits,
      nextExpiry: poolCredits.nextExpiry?.toISOString() ?? null,
    },
    freeTrial,
    topup: {
      minCredits: apiEnv().BILLING_TOPUP_MIN_CREDITS,
      maxCredits: apiEnv().BILLING_TOPUP_MAX_CREDITS,
      pricePerCreditMicroUsd: TOPUP_PRICE_PER_CREDIT_MICRO_USD,
    },
    /** @external WorkspaceBillingSummary.checkoutAvailable */
    checkoutAvailable: isStripeConfigured(),
    subscriptionCheckoutOptions: availableSubscriptionCheckoutOptions(),
    paymentMethod,
    invoices,
  };
}

/** The signed-in member's own spending view inside the workspace. */
export async function getWorkspaceMemberBillingView(input: { workspaceId: string; userId: string }): Promise<{
  plan: string;
  checkout: Awaited<ReturnType<RepositoryPort["getWorkspaceCheckoutProgress"]>>;
  /** @external workspace member billing view payload */
  subscriptionActive: boolean;
  allowanceCredits: number;
  allowanceUsed: number;
  allowanceRemaining: number;
  allowanceWindowEnd: string | null;
  poolBalance: number;
  /** @external workspace member billing view payload */
  trialEligible: boolean;
  trialCreditsUsed: number;
  /** @external workspace member billing view payload */
  hasTrialCredits: boolean;
  trialMeetingsRemaining: number;
}> {
  // The balance shown should not count holds whose work ended without settling.
  await repositories().releaseStalePlanCreditReservations({ workspaceId: input.workspaceId });
  const [access, hostedMeetings, userPlan, hasPrivateBetaProCredit, credits, checkout] = await Promise.all([
    repositories().getWorkspaceMemberCreditAccess(input),
    repositories().countWorkspaceMemberTrialMeetings(input),
    repositories().getUserPlan(input.userId),
    repositories().hasPrivateBetaProCreditEntitlement(input.userId),
    repositories().getUserCreditAccess(input.userId),
    repositories().getWorkspaceCheckoutProgress(input.workspaceId),
  ]);

  const hasPaidUserPlan = userPlan !== null && userPlan !== "free";
  const hasPaidAccess = access.subscriptionActive || hasPaidUserPlan || hasPrivateBetaProCredit;

  return {
    plan: userPlan ?? "free",
    checkout,
    /** @external workspace member billing view payload */
    subscriptionActive: access.subscriptionActive,
    allowanceCredits: access.allowanceCredits,
    allowanceUsed: access.allowanceUsed,
    allowanceRemaining: access.allowanceRemaining,
    allowanceWindowEnd: access.allowanceWindowEnd?.toISOString() ?? null,
    poolBalance: access.poolBalance,
    /** @external workspace member billing view payload */
    trialEligible: access.trialEligible,
    trialCreditsUsed: access.trialCreditsUsed,
    /** @external workspace member billing view payload */
    hasTrialCredits: access.hasTrialCredits,
    trialMeetingsRemaining: getTrialOfferMeetingsRemaining({
      isTrialEligible: access.trialEligible,
      hasTrialCredits: access.hasTrialCredits,
      hasGrantCredits: credits.hasGrantCredits,
      allowanceRemaining: access.allowanceRemaining,
      poolBalance: access.poolBalance,
      hasPaidAccess,
      hostedMeetings,
    }),
  };
}

export async function syncWorkspaceSubscriptionFromStripe(input: {
  workspaceId: string;
  subscription: Stripe.Subscription;
  log: AppLogger;
}): Promise<{
  workspaceId: string;
  interval: BillingPlanInterval;
  periodStart: Date | null;
  periodEnd: Date | null;
} | null> {
  const { subscription, workspaceId } = input;
  if (
    !(await workspaceExistsForStripeSubscriptionSync({
      workspaceId,
      subscriptionId: subscription.id,
      log: input.log,
    }))
  ) {
    return null;
  }

  const ownerUserId = await resolveWorkspaceSubscriptionOwnerUserId({
    subscription,
    workspaceId,
    log: input.log,
  });
  if (ownerUserId === null) {
    return null;
  }

  const item = subscription.items.data[0];
  const interval: BillingPlanInterval = item?.price.recurring?.interval === "year" ? "year" : "month";
  const period = getSubscriptionPeriod(subscription);

  const plan = subscriptionPlanForPrice({ priceId: item?.price.id ?? "", metadata: subscription.metadata });
  const existing = await repositories().getLatestBillingSubscriptionForWorkspace(workspaceId);
  const includedCredits = subscriptionIncludedMonthlyCredits({
    plan,
    interval,
    existing,
    stripeSubscriptionId: subscription.id,
  });
  const persistedSubscription = await repositories().upsertWorkspaceBillingSubscription({
    workspaceId,
    userId: ownerUserId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: item?.price.id ?? "unknown",
    status: subscription.status,
    planInterval: interval,
    // Per seat: each paid seat includes this many credits per month, derived
    // at charge time (no grant rows are minted for the allowance).
    includedCreditsPerPeriod: includedCredits,
    seatQuantity: item?.quantity ?? 1,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    /** @external persisted billing subscription cancelAtPeriodEnd */
    cancelAtPeriodEnd: subscription.cancel_at_period_end || subscription.cancel_at !== null,
  });

  const currentPlan = await repositories().getWorkspacePlan(workspaceId);
  const nextPlan = resolveSyncedSubscriptionPlan({
    plan,
    currentPlan,
    persistedSubscription,
    subscriptionStatus: subscription.status,
  });
  if (nextPlan !== null) {
    await repositories().updateWorkspacePlan({ workspaceId, plan: nextPlan });
  }

  return { workspaceId, interval, periodStart: period.start, periodEnd: period.end };
}

/** Workspace-mode payment checkout completed: mint a shared pool grant. */
export async function handleWorkspaceTopupCheckoutCompleted(input: {
  workspaceId: string;
  session: Stripe.Checkout.Session;
  log: AppLogger;
}): Promise<void> {
  const credits = Number(input.session.metadata?.credits ?? 0);
  if (!Number.isInteger(credits) || credits <= 0) {
    input.log.warn({ sessionId: input.session.id }, "Workspace payment session missing top-up metadata");

    return;
  }

  const grant = await repositories().createWorkspaceCreditGrant({
    workspaceId: input.workspaceId,
    source: "credit_topup",
    credits,
    stripeReference: input.session.id,
    metadata: { stripeCheckoutSessionId: input.session.id },
  });
  if (grant !== null) {
    input.log.info(
      { workspaceId: input.workspaceId, credits, sessionId: input.session.id },
      "Granted workspace top-up credits",
    );
  }
}

/**
 * Brings the Stripe subscription item quantity in line with the workspace's
 * active member count (prorated). Returns what happened so the seat-sync
 * worker can log/resolve accordingly.
 */
export async function syncWorkspaceSeatQuantity(input: {
  workspaceId: string;
  log: Pick<AppLogger, "info">;
}): Promise<
  | { outcome: "no_subscription" }
  | { outcome: "in_sync"; seatQuantity: number }
  | { outcome: "updated"; seatQuantity: number; previousQuantity: number }
> {
  const subscription = await repositories().getRunningBillingSubscriptionForWorkspace({
    workspaceId: input.workspaceId,
  });
  if (subscription === null) {
    return { outcome: "no_subscription" };
  }

  const desiredSeats = Math.max(1, await repositories().countActiveWorkspaceMembers(input.workspaceId));
  const stripe = getStripeClient();
  const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
  const item = stripeSubscription.items.data[0];
  if (item === undefined) {
    throw new BillingError({
      message: formatStripeSubscriptionNoItemsMessage(subscription.stripeSubscriptionId),
      statusCode: HTTP_STATUS_BAD_GATEWAY,
    });
  }

  const currentQuantity = item.quantity ?? 1;
  if (currentQuantity !== desiredSeats) {
    await stripe.subscriptionItems.update(item.id, {
      quantity: desiredSeats,
      proration_behavior: "create_prorations",
    });
  }
  if (currentQuantity !== desiredSeats || subscription.seatQuantity !== desiredSeats) {
    await repositories().updateBillingSubscriptionSeatQuantity({
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      seatQuantity: desiredSeats,
    });
  }

  if (currentQuantity === desiredSeats) {
    return { outcome: "in_sync", seatQuantity: desiredSeats };
  }
  input.log.info(
    { workspaceId: input.workspaceId, previousQuantity: currentQuantity, seatQuantity: desiredSeats },
    "Synced workspace seat quantity to Stripe",
  );

  return { outcome: "updated", seatQuantity: desiredSeats, previousQuantity: currentQuantity };
}
