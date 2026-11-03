import "../composition/env";

import { closeDbPool, upsertBillingCustomer, upsertUser, upsertWorkspaceBillingCustomer } from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type Stripe from "stripe";

import { resolveSubscriptionSubject } from "../adapters/secondary/stripe/stripe-billing";

const MESSAGE_INVALID_SUBSCRIPTION_FIXTURE = "Invalid subscription fixture.";

after(async () => {
  await closeDbPool();
});

type SubscriptionSubjectFixture = Pick<Stripe.Subscription, "id" | "metadata" | "customer">;

function isSubscriptionSubjectFixture(value: SubscriptionSubjectFixture): value is Stripe.Subscription {
  return typeof value.id === "string" && typeof value.customer === "string";
}

function fakeSubscription(input: { metadata?: Record<string, string>; customer: string }): Stripe.Subscription {
  const fixture: SubscriptionSubjectFixture = {
    id: `sub_test_${randomUUID()}`,
    metadata: input.metadata ?? {},
    customer: input.customer,
  };
  if (!isSubscriptionSubjectFixture(fixture)) {
    throw new Error(MESSAGE_INVALID_SUBSCRIPTION_FIXTURE);
  }

  return fixture;
}

async function makeUser(label: string) {
  return upsertUser({
    email: `${randomUUID()}@${label}.readymeet.test`,
    displayName: `${label} user`,
  });
}

void test("workspace metadata wins over everything else", async () => {
  const workspaceId = randomUUID();
  const subject = await resolveSubscriptionSubject(
    fakeSubscription({
      metadata: { readymeetWorkspaceId: workspaceId, readymeetUserId: randomUUID() },
      customer: `cus_test_${randomUUID()}`,
    }),
  );
  assert.deepEqual(subject, { type: "workspace", workspaceId });
});

void test("a registered workspace customer resolves as a workspace subject", async () => {
  const user = await makeUser("subjws");
  const stripeCustomerId = `cus_test_${randomUUID()}`;
  await upsertWorkspaceBillingCustomer({ workspaceId: user.workspaceId, stripeCustomerId });

  const subject = await resolveSubscriptionSubject(fakeSubscription({ customer: stripeCustomerId }));
  assert.deepEqual(subject, { type: "workspace", workspaceId: user.workspaceId });
});

void test("legacy subscriptions resolve to the user via metadata, then the customer registry", async () => {
  const metadataUserId = randomUUID();
  const fromMetadata = await resolveSubscriptionSubject(
    fakeSubscription({
      metadata: { readymeetUserId: metadataUserId },
      customer: `cus_test_${randomUUID()}`,
    }),
  );
  assert.deepEqual(fromMetadata, { type: "user", userId: metadataUserId });

  const user = await makeUser("subjuser");
  const stripeCustomerId = `cus_test_${randomUUID()}`;
  await upsertBillingCustomer({ userId: user.id, stripeCustomerId });
  const fromCustomer = await resolveSubscriptionSubject(fakeSubscription({ customer: stripeCustomerId }));
  assert.deepEqual(fromCustomer, { type: "user", userId: user.id });
});

void test("unknown subscriptions resolve to null (warn-and-skip in the webhook)", async () => {
  const subject = await resolveSubscriptionSubject(fakeSubscription({ customer: `cus_test_${randomUUID()}` }));
  assert.equal(subject, null);
});
