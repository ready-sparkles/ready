import {
  closeDbPool,
  db,
  getOrCreatePendingBillingCheckoutAttempt,
  saveBillingCheckoutSession,
  upsertUser,
} from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { expirePreviousCheckoutSession, getStripeClient } from "../adapters/secondary/stripe/stripe-client";
import { apiEnv } from "../composition/env";

const CHECKOUT_REPLACEMENT_OUTCOMES = ["expired", "complete", "outage", "race", "unknown"] as const;
const CHECKOUT_SESSION_EXPIRED_OFFSET_MS = 1000;
const EXPECTED_CHECKOUT_ATTEMPT_COUNT = 1;
const STRIPE_PROVIDER_UNAVAILABLE_MESSAGE = "provider unavailable";
const STRIPE_PAYMENT_COMPLETED_MESSAGE = "payment completed concurrently";
const MISSING_CHECKOUT_ATTEMPT_MESSAGE = "Expected a checkout attempt.";

after(closeDbPool);

async function readCheckoutAttemptStatus(input: { attemptId: string }): Promise<string> {
  const rows = await db.billingCheckoutAttempts.findMany({
    where: { id: input.attemptId },
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error(MISSING_CHECKOUT_ATTEMPT_MESSAGE);
  }

  return row.status;
}

CHECKOUT_REPLACEMENT_OUTCOMES.forEach((outcome) => {
  void test(`checkout replacement requires provider-confirmed expiry: ${outcome}`, async (t) => {
    const owner = await upsertUser({ email: `${randomUUID()}@checkout.test`, displayName: "Billing fixture" });
    const subjectId = owner.workspaceId;
    t.after(async () => {
      await db.billingCheckoutAttempts.deleteMany({ where: { subjectId } });
    });
    const previousKey = apiEnv.STRIPE_SECRET_KEY;
    apiEnv.STRIPE_SECRET_KEY = "sk_test_mock";
    t.after(() => {
      apiEnv.STRIPE_SECRET_KEY = previousKey;
    });
    const input = {
      subjectType: "workspace" as const,
      subjectId,
      checkoutKind: "subscription" as const,
      requestParams: { interval: "month" },
    };
    const first = await getOrCreatePendingBillingCheckoutAttempt(input);
    const id = `cs_${randomUUID()}`;
    if (outcome !== "unknown") {
      await saveBillingCheckoutSession({
        attemptId: first.id,
        stripeCheckoutSessionId: id,
        checkoutUrl: "https://checkout.stripe.com/test",
        expiresAt: new Date(Date.now() - CHECKOUT_SESSION_EXPIRED_OFFSET_MS),
      });
    }
    const readState = { count: 0 };
    t.mock.method(getStripeClient().checkout.sessions, "retrieve", async () => {
      readState.count += 1;
      if (outcome === "outage") {
        throw new Error(STRIPE_PROVIDER_UNAVAILABLE_MESSAGE);
      }

      return {
        id,
        status: outcome === "complete" || (outcome === "race" && readState.count > 1) ? "complete" : "open",
      };
    });
    t.mock.method(getStripeClient().checkout.sessions, "expire", async () => {
      if (outcome === "race") {
        throw new Error(STRIPE_PAYMENT_COMPLETED_MESSAGE);
      }

      return { id, status: "expired" };
    });
    const replace = () =>
      getOrCreatePendingBillingCheckoutAttempt({
        ...input,
        requestParams: { interval: "year" },
        expirePreviousSession: expirePreviousCheckoutSession,
      });
    if (outcome === "expired") {
      assert.notEqual((await replace()).id, first.id);
      assert.equal(await readCheckoutAttemptStatus({ attemptId: first.id }), "expired");
    } else {
      await assert.rejects(replace());
      assert.equal(await readCheckoutAttemptStatus({ attemptId: first.id }), "pending");
      const rows = await db.billingCheckoutAttempts.findMany({
        where: { subjectId },
      });
      assert.equal(rows.length, EXPECTED_CHECKOUT_ATTEMPT_COUNT);
    }
  });
});
