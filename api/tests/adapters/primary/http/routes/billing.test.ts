import { closeDbPool, upsertBillingCustomer, upsertUser } from "@readymeet/db";
import Fastify, { type FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { z } from "zod";

import { billingRoutes } from "../../../../../adapters/primary/http/routes/billing";
import { signAuthToken } from "../../../../../adapters/primary/http/support/auth";
import Stripe from "../../../../../adapters/secondary/stripe/sdk";
import { getStripeClient } from "../../../../../adapters/secondary/stripe/stripe-client";
import { apiEnv } from "../../../../../composition/env";

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;
const STRIPE_KEY_MESSAGE = "Invalid API Key provided: sk_test_****_key";
const messageSchema = z.object({ message: z.string() });

after(closeDbPool);

async function portalRequest(input: { app: FastifyInstance; userId: string; email: string }) {
  const token = signAuthToken({ sub: input.userId, email: input.email, displayName: "Billing route" });

  return input.app.inject({
    method: "POST",
    url: "/v1/me/billing/portal",
    headers: { authorization: `Bearer ${token}` },
  });
}

void test("workspace Checkout confirmation route is registered under the API prefix", async () => {
  const app = Fastify();
  try {
    await app.register(billingRoutes, { prefix: "/v1" });
    await app.ready();

    assert.equal(
      app.hasRoute({
        method: "POST",
        url: "/v1/workspaces/:workspaceId/billing/checkout/confirm",
      }),
      true,
    );
  } finally {
    await app.close();
  }
});

void test("billing routes map BillingErrors and Stripe SDK failures through one error handler", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(billingRoutes, { prefix: "/v1" });
  const user = await upsertUser({ email: `${randomUUID()}@billing.test`, displayName: "Billing route" });

  const noCustomer = await portalRequest({ app, userId: user.id, email: user.email });
  assert.equal(noCustomer.statusCode, HTTP_NOT_FOUND, noCustomer.body);

  await upsertBillingCustomer({ userId: user.id, stripeCustomerId: `cus_${randomUUID()}` });
  const previousKey = apiEnv.STRIPE_SECRET_KEY;
  apiEnv.STRIPE_SECRET_KEY = "sk_test_mock_only";
  t.after(() => {
    apiEnv.STRIPE_SECRET_KEY = previousKey;
  });
  t.mock.method(getStripeClient().billingPortal.sessions, "create", async () => {
    throw new Stripe.errors.StripeAuthenticationError({ message: STRIPE_KEY_MESSAGE });
  });
  const stripeFailure = await portalRequest({ app, userId: user.id, email: user.email });
  assert.equal(stripeFailure.statusCode, HTTP_BAD_GATEWAY, stripeFailure.body);
  assert.doesNotMatch(messageSchema.parse(stripeFailure.json()).message, /sk_test/);
});
