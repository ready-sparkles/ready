import assert from "node:assert/strict";
import { test } from "node:test";

import Stripe from "../../../../adapters/secondary/stripe/sdk";
import { BillingError, toBillingError } from "../../../../adapters/secondary/stripe/stripe-client";

const HTTP_BAD_GATEWAY = 502;
const HTTP_CONFLICT = 409;
const STRIPE_KEY_MESSAGE = "Invalid API Key provided: sk_test_****_key";
const STRIPE_PRICE_MESSAGE = "No such price: 'price_qa_missing'";
const STRIPE_CONNECTION_MESSAGE = "connect ECONNREFUSED";
const BILLING_CONFLICT_MESSAGE = "Retry your original checkout.";
const DATABASE_DOWN_MESSAGE = "database down";

void test("Stripe SDK errors become a generic 502 instead of Stripe's status and text", () => {
  const errors = [
    new Stripe.errors.StripeAuthenticationError({ message: STRIPE_KEY_MESSAGE }),
    new Stripe.errors.StripeInvalidRequestError({ message: STRIPE_PRICE_MESSAGE }),
    new Stripe.errors.StripeConnectionError({ message: STRIPE_CONNECTION_MESSAGE }),
  ];
  errors.forEach((error) => {
    const billingError = toBillingError(error);
    assert.ok(billingError instanceof BillingError);
    assert.equal(billingError.statusCode, HTTP_BAD_GATEWAY);
    assert.doesNotMatch(billingError.message, /sk_test|price_qa|ECONNREFUSED/);
  });
});

void test("billing errors keep their status and other errors stay unhandled", () => {
  const conflict = new BillingError({ message: BILLING_CONFLICT_MESSAGE, statusCode: HTTP_CONFLICT });
  assert.equal(toBillingError(conflict), conflict);
  assert.equal(toBillingError(new Error(DATABASE_DOWN_MESSAGE)), undefined);
  assert.equal(toBillingError("not an error"), undefined);
});
