import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import {
  getOrCreatePendingBillingCheckoutAttempt,
  getWorkspaceCheckoutProgress,
  markBillingCheckoutAttemptBySession,
  saveBillingCheckoutSession,
} from "../adapters/secondary/postgres/billing-reliability";
import { db, pool } from "../adapters/secondary/postgres/client";
import { dbEnv } from "../adapters/secondary/postgres/env";
import { upsertUser } from "../adapters/secondary/postgres/repositories";

const UNKNOWN_NETWORK_OUTCOME = "Unknown network outcome";
const HTTP_BAD_REQUEST = 400;
const CHECKOUT_EXPIRY_OFFSET_MS = 1000;

after(() => pool.end());
void test("processing survives checkout expiry, blocks another interval, and settles without regressing", async (t) => {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(dbEnv.DATABASE_URL).hostname),
    "This test requires a local database",
  );
  const user = await upsertUser({ email: `${randomUUID()}@processing.test`, displayName: "Processing fixture" });
  const workspaceId = user.workspaceId;
  t.after(async () => {
    await db.billingCheckoutAttempts.deleteMany({ where: { subjectId: workspaceId } });
  });
  const input = {
    subjectType: "workspace" as const,
    subjectId: workspaceId,
    checkoutKind: "subscription" as const,
    requestParams: { interval: "month" },
  };
  const attempt = await getOrCreatePendingBillingCheckoutAttempt(input);
  const sessionId = `cs_test_${randomUUID()}`;
  await saveBillingCheckoutSession({
    attemptId: attempt.id,
    stripeCheckoutSessionId: sessionId,
    checkoutUrl: "https://checkout.stripe.com/test",
    expiresAt: new Date(Date.now() - CHECKOUT_EXPIRY_OFFSET_MS),
  });
  assert.equal(await getWorkspaceCheckoutProgress(workspaceId), null, "open checkouts are not processing payments");
  await markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: sessionId, status: "processing" });
  assert.equal((await getWorkspaceCheckoutProgress(workspaceId))?.status, "processing");
  const repeated = await getOrCreatePendingBillingCheckoutAttempt({ ...input, requestParams: { interval: "year" } });
  assert.equal(repeated.id, attempt.id);
  assert.equal(repeated.processing, true);
  await markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: sessionId, status: "completed" });
  await markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: sessionId, status: "processing" });
  assert.equal(await getWorkspaceCheckoutProgress(workspaceId), null);
});

void test("failed payment persists and a new checkout supersedes its recovery notice", async (t) => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(dbEnv.DATABASE_URL).hostname));
  const user = await upsertUser({ email: `${randomUUID()}@processing.test`, displayName: "Processing fixture" });
  const workspaceId = user.workspaceId;
  t.after(async () => {
    await db.billingCheckoutAttempts.deleteMany({ where: { subjectId: workspaceId } });
  });
  const input = {
    subjectType: "workspace" as const,
    subjectId: workspaceId,
    checkoutKind: "subscription" as const,
    requestParams: { interval: "month" },
  };
  const attempt = await getOrCreatePendingBillingCheckoutAttempt(input);
  const sessionId = `cs_test_${randomUUID()}`;
  await saveBillingCheckoutSession({
    attemptId: attempt.id,
    stripeCheckoutSessionId: sessionId,
    checkoutUrl: "https://checkout.stripe.com/test",
    expiresAt: null,
  });
  await markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: sessionId, status: "processing" });
  await markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: sessionId, status: "failed" });
  await markBillingCheckoutAttemptBySession({ stripeCheckoutSessionId: sessionId, status: "processing" });
  assert.equal((await getWorkspaceCheckoutProgress(workspaceId))?.status, "failed");
  const next = await getOrCreatePendingBillingCheckoutAttempt(input);
  assert.notEqual(next.id, attempt.id);
  assert.equal(await getWorkspaceCheckoutProgress(workspaceId), null);
});

void test("definitive checkout creation rejection permits another plan, but unknown outcomes stay pending", async () => {
  const { recordBillingCheckoutAttemptError } = await import("../adapters/secondary/postgres/billing-reliability");
  const user = await upsertUser({ email: `${randomUUID()}@checkout-rejected.test`, displayName: "Rejected fixture" });
  const input = {
    subjectType: "workspace" as const,
    subjectId: user.workspaceId,
    checkoutKind: "subscription" as const,
    requestParams: { plan: "pro", interval: "month" },
  };
  const first = await getOrCreatePendingBillingCheckoutAttempt(input);
  const unknown = new Error(UNKNOWN_NETWORK_OUTCOME);
  await recordBillingCheckoutAttemptError({ attemptId: first.id, error: unknown });
  assert.equal((await db.billingCheckoutAttempts.findUniqueOrThrow({ where: { id: first.id } })).status, "pending");
  await recordBillingCheckoutAttemptError({
    attemptId: first.id,
    error: { type: "StripeInvalidRequestError", statusCode: HTTP_BAD_REQUEST },
  });
  const second = await getOrCreatePendingBillingCheckoutAttempt({
    ...input,
    requestParams: { plan: "max", interval: "year" },
  });
  assert.notEqual(second.id, first.id);
  assert.equal((await db.billingCheckoutAttempts.findUniqueOrThrow({ where: { id: first.id } })).status, "failed");
});
