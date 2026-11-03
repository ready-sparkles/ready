import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { withAccountDeletionBillingGuard } from "../adapters/secondary/postgres/account-deletion";
import { getOrCreatePendingBillingCheckoutAttempt } from "../adapters/secondary/postgres/billing-reliability";
import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import { anonymizeUserAccount, upsertUser } from "../adapters/secondary/postgres/repositories";
import { AccountDeletionBillingError, BillingReservationError } from "../domain/persistence-errors";

const FAILURE_MESSAGE = "Injected cleanup failure";
after(closeDbPool);
const makeUser = () => upsertUser({ email: `${randomUUID()}@deletion.test`, displayName: "Deletion fixture" });
const checkout = (userId: string) =>
  getOrCreatePendingBillingCheckoutAttempt({
    subjectType: "user",
    subjectId: userId,
    checkoutKind: "subscription",
    requestParams: {},
  });

void test("checkout reservation wins: deletion cannot enter external cleanup", async () => {
  const user = await makeUser();
  await checkout(user.id);
  await assert.rejects(
    withAccountDeletionBillingGuard({
      userId: user.id,
      run: async () => {
        assert.fail("Deletion must not begin cleanup with an open checkout");
      },
    }),
    AccountDeletionBillingError,
  );
});

void test("deletion reservation wins: checkout and failed-cleanup retry remain safe", async () => {
  const user = await makeUser();
  await assert.rejects(
    withAccountDeletionBillingGuard({
      userId: user.id,
      run: async () => {
        await assert.rejects(checkout(user.id), BillingReservationError);
        throw new Error(FAILURE_MESSAGE);
      },
    }),
    { message: FAILURE_MESSAGE },
  );
  await assert.rejects(checkout(user.id), BillingReservationError);
  await withAccountDeletionBillingGuard({ userId: user.id, run: async () => anonymizeUserAccount(user.id) });
  const [deleted] = await db.users.findMany({ where: { id: user.id } });
  assert.ok(deleted?.deletedAt);
  await assert.rejects(checkout(user.id), BillingReservationError);
});

void test("overlapping deletion and checkout cannot both succeed", async () => {
  const user = await makeUser();
  const results = await Promise.allSettled([
    checkout(user.id),
    withAccountDeletionBillingGuard({ userId: user.id, run: async () => anonymizeUserAccount(user.id) }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
});

void test("concurrent identical checkout requests reuse one reservation", async () => {
  const user = await makeUser();
  const attempts = await Promise.all([checkout(user.id), checkout(user.id)]);
  assert.equal(attempts[0].id, attempts[1].id);
});
