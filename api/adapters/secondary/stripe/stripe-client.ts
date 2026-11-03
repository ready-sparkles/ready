import {
  BILLING_PAST_DUE_GRACE_DAYS,
  type BillingPlanInterval,
  type BillingSummary,
  type SubscriptionCheckoutOption,
} from "@readymeet/shared";

import { apiEnv } from "../../../ports/api-env";
import { repositories } from "../../../ports/repository-runtime";

import Stripe from "./sdk";

/**
 * Stripe primitives shared by the legacy user billing module
 * (stripe-billing.ts) and the workspace billing module
 * (workspace-stripe-billing.ts). Living here keeps the import graph one-way:
 * both billing modules depend on this file, and stripe-billing's webhook
 * dispatcher may depend on the workspace module without a cycle.
 */

const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_CONFLICT = 409;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const HTTP_STATUS_BAD_GATEWAY = 502;
const PAYMENT_PROVIDER_FAILED_MESSAGE = "The payment provider could not complete this request. Try again later.";
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const MICRO_USD_PER_CENT = 10_000;
const EPOCH_SECONDS_TO_MS = MS_PER_SECOND;
const PLAN_MONTHLY_INCLUDED_CREDITS = 250;
const LEGACY_MONTHLY_INCLUDED_CREDITS = 200;
const LEGACY_YEARLY_INCLUDED_CREDITS = 170;

const BILLING_ACCOUNT_UNAVAILABLE_MESSAGE = "Your account is no longer available for billing.";
const BILLING_NOT_CONFIGURED_MESSAGE = "Billing is not configured on this server.";
const CHECKOUT_RETRY_ORIGINAL_MESSAGE = "Retry your original checkout before changing its options.";
const CHECKOUT_RECONCILE_MESSAGE =
  "Your previous checkout may have completed. Wait for payment reconciliation before starting another.";

// Must match the unit amount of the Stripe top-up price (the setup script
// creates it at $0.10/credit) and the ai_credit_pricing_config default.
export const TOPUP_PRICE_PER_CREDIT_MICRO_USD = 100_000;

// Stripe statuses that may keep paid features unlocked. `past_due` is further
// bounded by isSubscriptionEntitled's grace window.
const UNLOCKED_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isSubscriptionEntitled(input: {
  status: string;
  currentPeriodEnd: Date | null;
  statusChangedAt?: Date | null;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  if (input.currentPeriodEnd !== null && input.currentPeriodEnd <= now) {
    return false;
  }
  if (input.status === "active" || input.status === "trialing") {
    return true;
  }
  if (input.status !== "past_due" || input.statusChangedAt === null || input.statusChangedAt === undefined) {
    return false;
  }

  return input.statusChangedAt.getTime() > now.getTime() - BILLING_PAST_DUE_GRACE_DAYS * MS_PER_DAY;
}

export class BillingError extends Error {
  readonly statusCode: number;

  constructor(params: { message: string; statusCode: number }) {
    super(params.message);
    this.statusCode = params.statusCode;
  }
}

/**
 * Billing errors keep their own status. A Stripe SDK error carries Stripe's HTTP status and text
 * (for example 401 "Invalid API Key provided" or 400 "No such price"), which describe our
 * server's request to Stripe, not the caller's. It becomes a 502 with a generic message.
 */
export function toBillingError(error: unknown): BillingError | undefined {
  if (error instanceof BillingError) {
    return error;
  }
  if (error instanceof Stripe.errors.StripeError) {
    return new BillingError({ message: PAYMENT_PROVIDER_FAILED_MESSAGE, statusCode: HTTP_STATUS_BAD_GATEWAY });
  }

  return undefined;
}

/** Recheck after acquiring the Checkout lock: deletion may have won the race. */
export async function requireBillingActor(userId: string): Promise<void> {
  const user = await repositories().getUserAuthState(userId);
  if (user === null || user.deletedAt !== null) {
    throw new BillingError({ message: BILLING_ACCOUNT_UNAVAILABLE_MESSAGE, statusCode: HTTP_STATUS_FORBIDDEN });
  }
}

const stripeClientHolder: { client: Stripe | null } = { client: null };

function hasConfiguredStripeEnvValue(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

// Existing billing operations do not depend on the new subscription catalog; checkout validates its selected price.
export function isStripeConfigured(): boolean {
  return (
    hasConfiguredStripeEnvValue(apiEnv().STRIPE_SECRET_KEY) &&
    hasConfiguredStripeEnvValue(apiEnv().STRIPE_PRICE_CREDIT_TOPUP) &&
    hasConfiguredStripeEnvValue(apiEnv().STRIPE_WEBHOOK_SECRET)
  );
}

export function getStripeClient(): Stripe {
  const secretKey = apiEnv().STRIPE_SECRET_KEY;
  if (secretKey === "") {
    throw new BillingError({ message: BILLING_NOT_CONFIGURED_MESSAGE, statusCode: HTTP_STATUS_SERVICE_UNAVAILABLE });
  }
  stripeClientHolder.client ??= new Stripe(secretKey);

  return stripeClientHolder.client;
}

async function resolveExpiredCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient();
  const initialSession = await stripe.checkout.sessions.retrieve(sessionId);
  if (initialSession.status !== "open") {
    return initialSession;
  }

  try {
    return await stripe.checkout.sessions.expire(sessionId);
  } catch (error) {
    if (error instanceof Error) {
      return stripe.checkout.sessions.retrieve(sessionId);
    }
    throw error;
  }
}

/** Local expiry is not proof that payment cannot complete at Stripe. */
export async function expirePreviousCheckoutSession(sessionId: string | null): Promise<void> {
  if (sessionId === null || sessionId === "") {
    throw new BillingError({ message: CHECKOUT_RETRY_ORIGINAL_MESSAGE, statusCode: HTTP_STATUS_CONFLICT });
  }
  const session = await resolveExpiredCheckoutSession(sessionId);
  if (session.status !== "expired") {
    throw new BillingError({ message: CHECKOUT_RECONCILE_MESSAGE, statusCode: HTTP_STATUS_CONFLICT });
  }
}

function configuredSubscriptionPriceId(input: { interval: BillingPlanInterval; plan: "pro" | "max" }): string {
  if (input.plan === "max") {
    return input.interval === "year" ? apiEnv().STRIPE_PRICE_MAX_YEARLY : apiEnv().STRIPE_PRICE_MAX_MONTHLY;
  }

  // Fail closed: new Pro checkouts never reuse legacy BUSINESS prices. Existing BUSINESS
  // subscriptions are still recognized by subscriptionPlanForPrice.
  return input.interval === "year" ? apiEnv().STRIPE_PRICE_PRO_YEARLY : apiEnv().STRIPE_PRICE_PRO_MONTHLY;
}

export function subscriptionPriceIdForInterval(input: { interval: BillingPlanInterval; plan?: "pro" | "max" }): string {
  const priceId = configuredSubscriptionPriceId({ interval: input.interval, plan: input.plan ?? "pro" });
  if (priceId === "") {
    throw new BillingError({ message: BILLING_NOT_CONFIGURED_MESSAGE, statusCode: HTTP_STATUS_SERVICE_UNAVAILABLE });
  }

  return priceId;
}

/** Checkout needs Stripe itself plus the selected plan's price for that interval. */
function isSubscriptionCheckoutAvailable(input: { interval: BillingPlanInterval; plan: "pro" | "max" }): boolean {
  return isStripeConfigured() && hasConfiguredStripeEnvValue(configuredSubscriptionPriceId(input));
}

const SUBSCRIPTION_CHECKOUT_OPTIONS: SubscriptionCheckoutOption[] = [
  { plan: "pro", interval: "month" },
  { plan: "pro", interval: "year" },
  { plan: "max", interval: "month" },
  { plan: "max", interval: "year" },
];

export function availableSubscriptionCheckoutOptions(): SubscriptionCheckoutOption[] {
  return SUBSCRIPTION_CHECKOUT_OPTIONS.filter((option) => isSubscriptionCheckoutAvailable(option));
}

/**
 * Fails before a checkout attempt is recorded, so a missing configuration cannot leave a
 * session-less pending attempt that later blocks the other plan with "Retry your original checkout".
 */
export function assertSubscriptionCheckoutConfigured(input: {
  interval: BillingPlanInterval;
  plan?: "pro" | "max";
}): void {
  getStripeClient();
  subscriptionPriceIdForInterval(input);
}

export function settingsUrl(outcome: string): string {
  return `${apiEnv().NEXT_PUBLIC_WEB_URL}/workspace/settings?tab=billing&billing=${outcome}`;
}

export function mapSubscriptionStatusToPlan(input: {
  subscriptionStatus: string;
  currentPlan: string | null;
}): "free" | "business" | null {
  if (UNLOCKED_SUBSCRIPTION_STATUSES.has(input.subscriptionStatus)) {
    // Never downgrade manually assigned plans (enterprise etc.).
    return input.currentPlan === "free" || input.currentPlan === null ? "business" : null;
  }
  if (["canceled", "unpaid", "incomplete_expired"].includes(input.subscriptionStatus)) {
    return input.currentPlan === "business" ? "free" : null;
  }

  return null;
}

function toDate(epochSeconds: number | null | undefined): Date | null {
  return typeof epochSeconds === "number" ? new Date(epochSeconds * EPOCH_SECONDS_TO_MS) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumberField(input: { record: Record<string, unknown>; key: string }): number | undefined {
  const value = input.record[input.key];

  return typeof value === "number" ? value : undefined;
}

function readLegacySubscriptionPeriod(subscription: Stripe.Subscription): {
  current_period_start?: number;
  current_period_end?: number;
} {
  const record: unknown = subscription;
  if (!isPlainObject(record)) {
    return {};
  }

  return {
    current_period_start: readNumberField({ record, key: "current_period_start" }),
    current_period_end: readNumberField({ record, key: "current_period_end" }),
  };
}

/**
 * Current period bounds. Newer Stripe API versions moved these from the
 * subscription onto its items, so read the item first and fall back to the
 * legacy top-level fields.
 */
export function getSubscriptionPeriod(subscription: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const item = subscription.items.data[0];
  const legacy = readLegacySubscriptionPeriod(subscription);

  return {
    start: toDate(item?.current_period_start ?? legacy.current_period_start),
    end: toDate(item?.current_period_end ?? legacy.current_period_end),
  };
}

function readSubscriptionReference(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") {
    return value.id;
  }

  return null;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

export function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const record = readOptionalRecord(invoice);
  if (record === null) {
    return null;
  }
  const parentRecord = readOptionalRecord(record.parent);
  const subscriptionDetailsRaw = parentRecord?.subscription_details;
  const subscriptionDetails =
    subscriptionDetailsRaw !== undefined && isPlainObject(subscriptionDetailsRaw) ? subscriptionDetailsRaw : null;
  const modernSubscription = subscriptionDetails?.subscription;
  const legacySubscription = record.subscription;

  return readSubscriptionReference(modernSubscription ?? legacySubscription);
}

const MAX_INVOICES_LISTED = 10;

// Friendly names for non-card payment method types Stripe checkout can save.
const PAYMENT_METHOD_TYPE_LABELS: Record<string, string> = {
  cashapp: "Cash App Pay",
  us_bank_account: "US bank account",
  klarna: "Klarna",
  amazon_pay: "Amazon Pay",
  paypal: "PayPal",
  sepa_debit: "SEPA direct debit",
  revolut_pay: "Revolut Pay",
};

function readLast4(details: unknown): string | null {
  if (typeof details === "object" && details !== null && "last4" in details && typeof details.last4 === "string") {
    return details.last4;
  }

  return null;
}

function summarizePaymentMethod(paymentMethod: Stripe.PaymentMethod): BillingSummary["paymentMethod"] {
  if (paymentMethod.card !== undefined) {
    return { type: "card", brand: paymentMethod.card.brand, last4: paymentMethod.card.last4 };
  }
  if (paymentMethod.link !== undefined) {
    return { type: "link", brand: null, last4: null };
  }

  const label =
    PAYMENT_METHOD_TYPE_LABELS[paymentMethod.type] ??
    paymentMethod.type.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
  const details = paymentMethod[paymentMethod.type as keyof Stripe.PaymentMethod];

  return { type: "other", brand: label, last4: readLast4(details) };
}

export async function getPaymentMethodForCustomer(customerId: string): Promise<BillingSummary["paymentMethod"]> {
  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(customerId, {
    expand: ["invoice_settings.default_payment_method"],
  });
  if (customer.deleted) {
    return null;
  }

  const defaultMethod = customer.invoice_settings.default_payment_method;
  if (defaultMethod !== null && typeof defaultMethod !== "string") {
    return summarizePaymentMethod(defaultMethod);
  }

  // Subscription checkout attaches the payment method to the customer without
  // making it the customer-level invoice default, so fall back to the first
  // attached method.
  const attached = await stripe.customers.listPaymentMethods(customerId, { limit: 1 });
  const first = attached.data[0];

  return first !== undefined ? summarizePaymentMethod(first) : null;
}

export async function getInvoicesForCustomer(customerId: string): Promise<BillingSummary["invoices"]> {
  const invoices = await getStripeClient().invoices.list({ customer: customerId, limit: MAX_INVOICES_LISTED });

  return invoices.data
    .filter((invoice) => invoice.status !== "draft")
    .map((invoice) => ({
      id: invoice.id,
      createdAt: new Date(invoice.created * EPOCH_SECONDS_TO_MS).toISOString(),
      totalMicroUsd: invoice.total * MICRO_USD_PER_CENT,
      status: invoice.status ?? "unknown",
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    }));
}

/** Subscription metadata key recording which plan ReadyMeet Checkout sold. */
export const SUBSCRIPTION_PLAN_METADATA_KEY = "readymeetPlan";

/**
 * Maps a synced subscription to Pro/Max. BUSINESS prices only count as Pro when
 * ReadyMeet Checkout sold them as the Pro fallback (tagged in subscription
 * metadata); untagged BUSINESS subscriptions are legacy and keep their plan and
 * saved allowance.
 */
export function subscriptionPlanForPrice(input: {
  priceId: string;
  metadata?: Record<string, string> | null;
}): "pro" | "max" | null {
  const { priceId } = input;
  if (priceId === "") {
    return null;
  }
  if ([apiEnv().STRIPE_PRICE_PRO_MONTHLY, apiEnv().STRIPE_PRICE_PRO_YEARLY].includes(priceId)) {
    return "pro";
  }
  if ([apiEnv().STRIPE_PRICE_MAX_MONTHLY, apiEnv().STRIPE_PRICE_MAX_YEARLY].includes(priceId)) {
    return "max";
  }
  const isProFallbackPurchase = input.metadata?.[SUBSCRIPTION_PLAN_METADATA_KEY] === "pro";
  if (
    isProFallbackPurchase &&
    [apiEnv().STRIPE_PRICE_BUSINESS_MONTHLY, apiEnv().STRIPE_PRICE_BUSINESS_YEARLY].includes(priceId)
  ) {
    return "pro";
  }

  return null;
}

export function legacyIncludedMonthlyCredits(interval: BillingPlanInterval): number {
  return interval === "year" ? LEGACY_YEARLY_INCLUDED_CREDITS : LEGACY_MONTHLY_INCLUDED_CREDITS;
}

export function subscriptionIncludedMonthlyCredits(input: {
  plan: "pro" | "max" | null;
  interval: BillingPlanInterval;
  stripeSubscriptionId: string;
  existing: { stripeSubscriptionId: string; includedCreditsPerPeriod: number } | null;
}): number {
  if (input.plan !== null) {
    return PLAN_MONTHLY_INCLUDED_CREDITS;
  }

  return input.existing?.stripeSubscriptionId === input.stripeSubscriptionId
    ? input.existing.includedCreditsPerPeriod
    : legacyIncludedMonthlyCredits(input.interval);
}

export function resolveSyncedSubscriptionPlan(input: {
  plan: "pro" | "max" | null;
  currentPlan: string | null;
  subscriptionStatus: string;
  persistedSubscription:
    | { status: string; currentPeriodEnd: Date | null; statusChangedAt?: Date | null }
    | null
    | undefined;
}): "pro" | "max" | "business" | "free" | null {
  if (input.persistedSubscription !== null && input.persistedSubscription !== undefined) {
    const isEntitled = isSubscriptionEntitled(input.persistedSubscription);
    if (input.plan !== null && isEntitled) {
      return input.currentPlan === "enterprise" ? null : input.plan;
    }
    if (
      !isEntitled &&
      (input.currentPlan === "pro" ||
        input.currentPlan === "max" ||
        (input.subscriptionStatus === "past_due" && input.currentPlan === "business"))
    ) {
      return "free";
    }
  }

  return mapSubscriptionStatusToPlan(input);
}
