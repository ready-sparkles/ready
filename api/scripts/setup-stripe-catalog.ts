/**
 * One-time setup for the Stripe billing catalog. Creates the Pro and Max
 * subscription prices (monthly/yearly) and the per-credit top-up price in the
 * account behind STRIPE_SECRET_KEY, then prints the env lines to copy into
 * .env. Safe to re-run: prices are found again via their lookup keys.
 *
 * Usage: npm run setup:stripe-catalog
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

import { apiEnv } from "../composition/env";

const MONTHLY_LOOKUP_KEY = "readymeet_pro_monthly";
const YEARLY_LOOKUP_KEY = "readymeet_pro_yearly";
const TOPUP_LOOKUP_KEY = "readymeet_credit_topup";

// The business prices are per-seat licensed prices: legacy user checkouts use
// quantity 1, workspace checkouts set quantity to the active member count and
// the seat-sync worker keeps the quantity in step with membership changes.
const MONTHLY_USD_CENTS = 25_00;
const YEARLY_USD_CENTS = 204_00;
const MAX_MONTHLY_USD_CENTS = 120_00;
const MAX_YEARLY_USD_CENTS = 1200_00;
// $0.10/credit; must stay in step with TOPUP_PRICE_PER_CREDIT_MICRO_USD in
// lib/stripe-billing.ts and the ai_credit_pricing_config default.
const TOPUP_USD_CENTS_PER_CREDIT = 10;
const STRIPE_SECRET_KEY_MISSING_MESSAGE = "Set STRIPE_SECRET_KEY in .env first (sandbox sk_test_... key).";
const ENV_HEADER_MESSAGE = "\nAdd these to your .env:\n";
const WEBHOOK_FORWARDING_MESSAGE =
  "\nThen forward webhooks locally with:\n" +
  "  stripe listen --forward-to localhost:4000/v1/webhooks/stripe\n" +
  "and copy the printed whsec_... value into STRIPE_WEBHOOK_SECRET.\n\n" +
  "Production webhook endpoints must enable:\n" +
  "  checkout.session.completed\n" +
  "  checkout.session.async_payment_succeeded\n" +
  "  checkout.session.async_payment_failed\n" +
  "  checkout.session.expired\n" +
  "  customer.subscription.created\n" +
  "  customer.subscription.updated\n" +
  "  customer.subscription.deleted\n" +
  "  invoice.paid";

function logCatalogMessage(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function findPriceByLookupKey(input: { stripe: Stripe; lookupKey: string }): Promise<Stripe.Price | null> {
  const prices = await input.stripe.prices.list({ lookup_keys: [input.lookupKey], limit: 1 });

  return prices.data[0] ?? null;
}

async function ensurePrice(input: {
  stripe: Stripe;
  lookupKey: string;
  productName: string;
  unitAmount: number;
  recurringInterval?: "month" | "year";
  productId?: string;
}): Promise<Stripe.Price> {
  const existing = await findPriceByLookupKey({ stripe: input.stripe, lookupKey: input.lookupKey });
  if (existing !== null && existing.unit_amount === input.unitAmount) {
    logCatalogMessage(`Found existing price for ${input.lookupKey}: ${existing.id}.`);

    return existing;
  }

  // Stripe prices are immutable, so an amount change means a replacement
  // price that takes over the lookup key. Existing subscriptions keep the
  // old price; only new checkouts use the new one.
  const price = await input.stripe.prices.create({
    lookup_key: input.lookupKey,
    ...(existing !== null ? { transfer_lookup_key: true } : {}),
    currency: "usd",
    unit_amount: input.unitAmount,
    ...(input.recurringInterval !== undefined ? { recurring: { interval: input.recurringInterval } } : {}),
    ...(existing !== null && typeof existing.product === "string"
      ? { product: existing.product }
      : input.productId !== undefined
        ? { product: input.productId }
        : { product_data: { name: input.productName } }),
  });
  logCatalogMessage(
    existing !== null
      ? `Replaced price for ${input.lookupKey} (${existing.id} -> ${price.id})`
      : `Created price for ${input.lookupKey}: ${price.id}`,
  );

  return price;
}

export async function setupStripeCatalog(stripe: Stripe): Promise<void> {
  const monthly = await ensurePrice({
    stripe,
    lookupKey: MONTHLY_LOOKUP_KEY,
    productName: "Ready Pro",
    unitAmount: MONTHLY_USD_CENTS,
    recurringInterval: "month",
  });
  const yearly = await ensurePrice({
    stripe,
    lookupKey: YEARLY_LOOKUP_KEY,
    productId: typeof monthly.product === "string" ? monthly.product : monthly.product.id,
    productName: "Ready Pro",
    unitAmount: YEARLY_USD_CENTS,
    recurringInterval: "year",
  });
  const maxMonthly = await ensurePrice({
    stripe,
    lookupKey: "readymeet_max_monthly",
    productName: "Ready Max",
    unitAmount: MAX_MONTHLY_USD_CENTS,
    recurringInterval: "month",
  });
  const maxYearly = await ensurePrice({
    stripe,
    lookupKey: "readymeet_max_yearly",
    productId: typeof maxMonthly.product === "string" ? maxMonthly.product : maxMonthly.product.id,
    productName: "Ready Max",
    unitAmount: MAX_YEARLY_USD_CENTS,
    recurringInterval: "year",
  });
  const topup = await ensurePrice({
    stripe,
    lookupKey: TOPUP_LOOKUP_KEY,
    productName: "ReadyMeet credits",
    unitAmount: TOPUP_USD_CENTS_PER_CREDIT,
  });

  logCatalogMessage(ENV_HEADER_MESSAGE);
  logCatalogMessage(`STRIPE_PRICE_PRO_MONTHLY=${monthly.id}`);
  logCatalogMessage(`STRIPE_PRICE_PRO_YEARLY=${yearly.id}`);
  logCatalogMessage(`STRIPE_PRICE_MAX_MONTHLY=${maxMonthly.id}`);
  logCatalogMessage(`STRIPE_PRICE_MAX_YEARLY=${maxYearly.id}`);
  logCatalogMessage(`STRIPE_PRICE_CREDIT_TOPUP=${topup.id}`);
  logCatalogMessage(WEBHOOK_FORWARDING_MESSAGE);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (apiEnv.STRIPE_SECRET_KEY.length === 0) {
    throw new Error(STRIPE_SECRET_KEY_MISSING_MESSAGE);
  }
  await setupStripeCatalog(new Stripe(apiEnv.STRIPE_SECRET_KEY));
}
