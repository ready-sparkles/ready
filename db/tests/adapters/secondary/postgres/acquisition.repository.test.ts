import { acquisitionFromLanding } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import {
  getAdminAcquisition,
  recordAcquisitionPayment,
  updateAnalyticsConsent,
} from "../../../../adapters/secondary/postgres/acquisition";
import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import { upsertUserFromAuthentication } from "../../../../adapters/secondary/postgres/repositories";

const ACQUISITION_PAYMENT_AMOUNT_MINOR = 2900;

after(closeDbPool);

void test("payments remain deduplicated without queuing analytics for previously opted-in users", async () => {
  const id = randomUUID();
  const acquisition = {
    ...acquisitionFromLanding(
      "https://ready.app/?utm_source=google&utm_medium=cpc&utm_campaign=search&utm_term=zoom+alternative",
      "",
    ),
    clientId: "123456.789012",
    sessionId: "789012",
    sessionCapturedAt: new Date().toISOString(),
  };
  const input = {
    provider: "google" as const,
    providerAccountId: id,
    email: `${id}@attribution.test`,
    displayName: "Attribution fixture",
    acquisition,
  };
  const created = await upsertUserFromAuthentication(input);
  const returned = await upsertUserFromAuthentication({
    ...input,
    acquisition: acquisitionFromLanding("https://ready.app/?utm_source=other", ""),
  });
  assert.equal(created.accountCreated, true);
  assert.equal(returned.accountCreated, false);
  assert.equal(created.user.id, returned.user.id);
  assert.equal((await getAdminAcquisition([created.user.id])).get(created.user.id)?.attribution.last.source, "google");
  await updateAnalyticsConsent({
    userId: created.user.id,
    enabled: true,
    identity: {
      clientId: "999.888",
      sessionId: "888",
      sessionCapturedAt: new Date().toISOString(),
    },
  });
  assert.equal(
    (await getAdminAcquisition([created.user.id])).get(created.user.id)?.attribution.clientId,
    acquisition.clientId,
  );
  assert.equal(
    (await getAdminAcquisition([created.user.id])).get(created.user.id)?.attribution.sessionId,
    acquisition.sessionId,
  );
  await db.users.updateMany({ where: { id: created.user.id }, data: { hasCompletedFirstMeeting: true } });
  const [activated] = await db.users.findMany({
    where: { id: created.user.id },
    select: { hasCompletedFirstMeeting: true },
  });
  assert.equal(activated?.hasCompletedFirstMeeting, true);
  const payment = {
    transactionId: `in_${id}`,
    userId: created.user.id,
    workspaceId: created.user.workspaceId,
    amountMinor: ACQUISITION_PAYMENT_AMOUNT_MINOR,
    currency: "usd",
    paidAt: new Date(),
  };
  await Promise.all([recordAcquisitionPayment(payment), recordAcquisitionPayment(payment)]);
  const summary = (await getAdminAcquisition([created.user.id])).get(created.user.id);
  assert.ok(summary);
  assert.deepEqual(summary.payments, [{ currency: "USD", amountMinor: ACQUISITION_PAYMENT_AMOUNT_MINOR, count: 1 }]);
  assert.notEqual(summary.firstPaidAt, null);
  await updateAnalyticsConsent({ userId: created.user.id, enabled: false });
  await updateAnalyticsConsent({ userId: created.user.id, enabled: true });
  await recordAcquisitionPayment({ ...payment, transactionId: `zero_${id}`, amountMinor: 0 });
  const afterZero = (await getAdminAcquisition([created.user.id])).get(created.user.id);
  assert.deepEqual(afterZero?.payments, [{ currency: "USD", amountMinor: ACQUISITION_PAYMENT_AMOUNT_MINOR, count: 1 }]);
});

void test("existing account is never relabeled as an acquired signup", async () => {
  const id = randomUUID();
  const input = {
    provider: "google" as const,
    providerAccountId: id,
    email: `${id}@returning.test`,
    displayName: "Existing",
  };
  const first = await upsertUserFromAuthentication(input);
  await upsertUserFromAuthentication({
    ...input,
    acquisition: acquisitionFromLanding("https://ready.app/?utm_source=google", ""),
  });
  assert.equal((await getAdminAcquisition([first.user.id])).size, 0);
});
