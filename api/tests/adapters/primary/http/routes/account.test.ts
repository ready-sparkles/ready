import {
  anonymizeUserAccount,
  closeDbPool,
  db,
  ensureWorkspaceMembership,
  transferWorkspaceOwnership,
  upsertUser,
  WorkspaceAdminError,
} from "@readymeet/db";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { z } from "zod";

import { accountRoutes } from "../../../../../adapters/primary/http/routes/account";
import { signAuthToken } from "../../../../../adapters/primary/http/support/auth";
import {
  createSubscriptionCheckoutSession,
  createTopupCheckoutSession,
} from "../../../../../adapters/secondary/stripe/stripe-billing";
import { getStripeClient } from "../../../../../adapters/secondary/stripe/stripe-client";
import {
  createWorkspaceSubscriptionCheckoutSession,
  createWorkspaceTopupCheckoutSession,
} from "../../../../../adapters/secondary/stripe/workspace-stripe-billing";
import { apiEnv } from "../../../../../composition/env";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_CONFLICT = 409;
const HTTP_REMOVE_METHOD = "DELETE" as const;
const CHECKOUT_EXPIRY_OFFSET_MS = 60_000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const SUBSCRIPTION_LOOKBACK_DAYS = 30;
const STRIPE_SESSION_EXPIRES_SECONDS = 3600;

const MESSAGE_BILLING_GATE_NOT_REGISTERED = "Expected the billing gate to be registered";
const MESSAGE_DATABASE_URL_REQUIRED = "DATABASE_URL is required";
const MESSAGE_UNEXPECTED_STRIPE_CUSTOMER_CREATION = "Unexpected Stripe customer creation";
const MESSAGE_UNEXPECTED_STRIPE_CHECKOUT_CREATION = "Unexpected Stripe checkout creation";
const MESSAGE_CHECKOUT_DID_NOT_START = "Checkout did not start";

const accountErrorResponseSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
});
const accountDeleteOkResponseSchema = z.object({
  ok: z.boolean(),
});
const isIsolatedDb = process.env.ACCOUNT_DELETION_ISOLATED_DB === "1" || process.env.CI === "true";
after(closeDbPool);

function openWhenReady() {
  const gate: { resolve: () => void } = {
    resolve: () => {
      throw new Error(MESSAGE_BILLING_GATE_NOT_REGISTERED);
    },
  };
  const promise = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });

  return {
    promise,
    open: () => {
      gate.resolve();
    },
  };
}

async function ownerUserIds(workspaceId: string): Promise<string[]> {
  const rows = await db.workspaceMemberships.findMany({
    where: { workspaceId, role: "owner" },
  });

  return rows.map((row) => row.userId);
}

async function fixture(t: TestContext) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error(MESSAGE_DATABASE_URL_REQUIRED);
  }
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname));
  const user = await upsertUser({ email: `${randomUUID()}@account-deletion.test`, displayName: "Deletion fixture" });
  const app = Fastify();
  await app.register(accountRoutes);
  const token = signAuthToken({
    sub: user.id,
    email: user.email,
    displayName: user.displayName,
    workspaceId: user.workspaceId,
    sessionVersion: user.sessionVersion,
  });
  t.after(async () => {
    await app.close();
    await db.billingCheckoutAttempts.deleteMany({
      where: { subjectId: { in: [user.id, user.workspaceId] } },
    });
    await db.workspaces.deleteMany({ where: { id: user.workspaceId } });
    await db.users.deleteMany({ where: { id: user.id } });
  });

  return {
    user,
    delete: () =>
      app.inject({
        method: HTTP_REMOVE_METHOD,
        url: "/me/account",
        headers: { authorization: `Bearer ${token}` },
        payload: { confirmationEmail: user.email },
      }),
    async subscription(input: { scope: "user" | "workspace"; status: string; isCancelAtPeriodEnd?: boolean }) {
      const isCancelAtPeriodEnd = input.isCancelAtPeriodEnd ?? false;
      const periodPoint = new Date(Date.now() - SUBSCRIPTION_LOOKBACK_DAYS * MS_PER_DAY);
      await db.billingSubscriptions.create({
        data: {
          userId: user.id,
          workspaceId: input.scope === "workspace" ? user.workspaceId : null,
          stripeSubscriptionId: `sub_${randomUUID()}`,
          stripePriceId: "price_fixture",
          status: input.status,
          planInterval: "month",
          currentPeriodEnd: periodPoint,
          statusChangedAt: periodPoint,
          /** @external persisted billing subscription cancelAtPeriodEnd */
          cancelAtPeriodEnd: isCancelAtPeriodEnd,
        },
      });
    },
    async unchanged() {
      const rows = await db.users.findMany({
        where: { id: user.id },
      });
      const row = rows[0];
      assert.ok(row);
      assert.equal(row.deletedAt, null);
      assert.equal(row.sessionVersion, user.sessionVersion);
      const requests = await db.dataDeletionRequests.findMany({
        where: { userId: user.id },
      });
      assert.equal(requests.length, 0);
    },
  };
}

void test(
  "account deletion blocks every nonterminal personal and owned-workspace subscription before side effects",
  { skip: !isIsolatedDb },
  async (t) => {
    await (["user", "workspace"] as const).reduce(async (scopeStep, scope) => {
      await scopeStep;
      await (["active", "trialing", "past_due", "unpaid", "paused", "incomplete"] as const).reduce(
        async (statusStep, status) => {
          await statusStep;
          await t.test(`${scope}: ${status}, even outside the paid period/grace window`, async (t) => {
            const f = await fixture(t);
            await f.subscription({ scope, status });
            const response = await f.delete();
            assert.equal(response.statusCode, HTTP_STATUS_CONFLICT, response.body);
            const body = accountErrorResponseSchema.parse(response.json());
            assert.equal(body.code, "account_subscription_active");
            await f.unchanged();
          });
        },
        Promise.resolve(),
      );
    }, Promise.resolve());
  },
);

void test(
  "scheduled cancellation still blocks deletion until the subscription ends",
  { skip: !isIsolatedDb },
  async (t) => {
    const f = await fixture(t);
    await f.subscription({ scope: "workspace", status: "active", isCancelAtPeriodEnd: true });
    const response = await f.delete();
    assert.equal(response.statusCode, HTTP_STATUS_CONFLICT);
    const body = accountErrorResponseSchema.parse(response.json());
    assert.match(body.message ?? "", /wait for it to end/);
    await f.unchanged();
  },
);

void test(
  "a newer canceled subscription does not hide another running subscription",
  { skip: !isIsolatedDb },
  async (t) => {
    const f = await fixture(t);
    await f.subscription({ scope: "user", status: "active" });
    await f.subscription({ scope: "user", status: "canceled" });
    const response = await f.delete();
    assert.equal(response.statusCode, HTTP_STATUS_CONFLICT, response.body);
    await f.unchanged();
  },
);

void test(
  "billing in another owned workspace blocks deletion regardless of the active workspace",
  { skip: !isIsolatedDb },
  async (t) => {
    const f = await fixture(t);
    const workspaceId = randomUUID();
    t.after(async () => {
      await db.workspaces.deleteMany({ where: { id: workspaceId } });
    });
    await db.workspaces.create({
      data: { id: workspaceId, name: "Other paid workspace", createdByUserId: f.user.id },
    });
    await db.workspaceMemberships.create({ data: { workspaceId, userId: f.user.id, role: "owner" } });
    await f.subscription({ scope: "workspace", status: "active" });
    await db.billingSubscriptions.updateMany({
      where: { workspaceId: f.user.workspaceId },
      data: { workspaceId },
    });
    const response = await f.delete();
    assert.equal(response.statusCode, HTTP_STATUS_CONFLICT, response.body);
    const body = accountErrorResponseSchema.parse(response.json());
    assert.match(body.message ?? "", /Other paid workspace/);
    await f.unchanged();
  },
);

void test(
  "free accounts and accounts with only terminal or superseded billing records can be deleted",
  { skip: !isIsolatedDb },
  async (t) => {
    await ([null, "canceled", "incomplete_expired", "superseded"] as const).reduce(async (previous, status) => {
      await previous;
      await t.test(status ?? "free", async (t) => {
        const f = await fixture(t);
        if (status !== null) {
          await f.subscription({ scope: "user", status });
          await f.subscription({ scope: "workspace", status });
        }
        const response = await f.delete();
        assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);
        const okBody = accountDeleteOkResponseSchema.parse(response.json());
        assert.equal(okBody.ok, true);
        const deletedRows = await db.users.findMany({
          where: { id: f.user.id },
        });
        const deletedAt = deletedRows[0]?.deletedAt;
        assert.ok(deletedAt !== undefined && deletedAt !== null);
      });
    }, Promise.resolve());
  },
);

void test(
  "ownership transfer permits deletion even when the subscription still names the former owner",
  { skip: !isIsolatedDb },
  async (t) => {
    const former = await fixture(t),
      next = await fixture(t);
    await former.subscription({ scope: "workspace", status: "active" });
    await ensureWorkspaceMembership({ workspaceId: former.user.workspaceId, userId: next.user.id, role: "member" });
    await transferWorkspaceOwnership({
      workspaceId: former.user.workspaceId,
      actorUserId: former.user.id,
      targetUserId: next.user.id,
    });
    assert.equal((await former.delete()).statusCode, HTTP_STATUS_OK);
    const subscriptionRows = await db.billingSubscriptions.findMany({
      where: { workspaceId: former.user.workspaceId },
    });
    assert.equal(subscriptionRows[0]?.status, "active");
  },
);

(["subscription", "topup"] as const).forEach((checkoutKind) => {
  void test(
    `unresolved ${checkoutKind} checkouts block deletion until expiry or failure is confirmed`,
    { skip: !isIsolatedDb },
    async (t) => {
      await (["user", "workspace"] as const).reduce(async (scopeStep, scope) => {
        await scopeStep;
        await (
          [
            ["pending", null, true],
            ["pending", new Date(Date.now() + CHECKOUT_EXPIRY_OFFSET_MS), true],
            ["processing", new Date(Date.now() - CHECKOUT_EXPIRY_OFFSET_MS), true],
            ["pending", new Date(Date.now() - CHECKOUT_EXPIRY_OFFSET_MS), true],
            ["expired", null, false],
            ["failed", null, false],
          ] as const
        ).reduce(async (statusStep, [status, expiresAt, isBlocked]) => {
          await statusStep;
          await t.test(`${scope}: ${status}, expiry ${expiresAt?.toISOString() ?? "unknown"}`, async (t) => {
            const f = await fixture(t);
            await db.billingCheckoutAttempts.create({
              data: {
                subjectType: scope,
                subjectId: scope === "user" ? f.user.id : f.user.workspaceId,
                checkoutKind,
                requestKey: randomUUID(),
                status,
                expiresAt,
              },
            });
            const response = await f.delete();
            assert.equal(response.statusCode, isBlocked ? HTTP_STATUS_CONFLICT : HTTP_STATUS_OK, response.body);
            if (isBlocked) {
              const body = accountErrorResponseSchema.parse(response.json());
              assert.equal(body.code, "account_checkout_pending");
              await f.unchanged();
            }
          });
        }, Promise.resolve());
      }, Promise.resolve());
    },
  );
});

(["subscription", "topup"] as const).forEach((checkoutKind) => {
  void test(
    `${checkoutKind} Checkout for a removed account creates no payment session`,
    { skip: !isIsolatedDb },
    async (t) => {
      await (["user", "workspace"] as const).reduce(async (scopeStep, scope) => {
        await scopeStep;
        await t.test(scope, async (t) => {
          const f = await fixture(t);
          const previousKey = apiEnv.STRIPE_SECRET_KEY;
          const previousPrice = apiEnv.STRIPE_PRICE_CREDIT_TOPUP;
          apiEnv.STRIPE_SECRET_KEY = "sk_test_mock_only";
          apiEnv.STRIPE_PRICE_CREDIT_TOPUP = "price_test_mock_only";
          t.after(() => {
            apiEnv.STRIPE_SECRET_KEY = previousKey;
            apiEnv.STRIPE_PRICE_CREDIT_TOPUP = previousPrice;
          });
          t.mock.method(getStripeClient().customers, "create", async () => {
            throw new Error(MESSAGE_UNEXPECTED_STRIPE_CUSTOMER_CREATION);
          });
          t.mock.method(getStripeClient().checkout.sessions, "create", async () => {
            throw new Error(MESSAGE_UNEXPECTED_STRIPE_CHECKOUT_CREATION);
          });
          await db.users.updateMany({ where: { id: f.user.id }, data: { deletedAt: new Date() } });
          const checkout =
            checkoutKind === "subscription"
              ? scope === "user"
                ? createSubscriptionCheckoutSession({ userId: f.user.id, interval: "month" })
                : createWorkspaceSubscriptionCheckoutSession({
                    workspaceId: f.user.workspaceId,
                    actorUserId: f.user.id,
                    interval: "month",
                  })
              : scope === "user"
                ? createTopupCheckoutSession({ userId: f.user.id, credits: apiEnv.BILLING_TOPUP_MIN_CREDITS })
                : createWorkspaceTopupCheckoutSession({
                    workspaceId: f.user.workspaceId,
                    actorUserId: f.user.id,
                    credits: apiEnv.BILLING_TOPUP_MIN_CREDITS,
                  });
          await assert.rejects(checkout, /account is no longer available for billing/);
          const attempts = await db.billingCheckoutAttempts.findMany({
            where: { subjectId: { in: [f.user.id, f.user.workspaceId] } },
          });
          assert.equal(attempts.length, 0);
        });
      }, Promise.resolve());
    },
  );
});

void test("a top-up that has saved its checkout attempt blocks account removal", { skip: !isIsolatedDb }, async (t) => {
  await (["user", "workspace"] as const).reduce(async (scopeStep, scope) => {
    await scopeStep;
    await t.test(scope, async (t) => {
      const f = await fixture(t);
      const previousKey = apiEnv.STRIPE_SECRET_KEY,
        previousPrice = apiEnv.STRIPE_PRICE_CREDIT_TOPUP;
      apiEnv.STRIPE_SECRET_KEY = "sk_test_mock_only";
      apiEnv.STRIPE_PRICE_CREDIT_TOPUP = "price_test_mock_only";
      t.after(() => {
        apiEnv.STRIPE_SECRET_KEY = previousKey;
        apiEnv.STRIPE_PRICE_CREDIT_TOPUP = previousPrice;
      });
      const started = openWhenReady();
      const finish = openWhenReady();
      t.mock.method(getStripeClient().customers, "create", async () => ({ id: `cus_${randomUUID()}` }));
      const createSession = t.mock.method(getStripeClient().checkout.sessions, "create", async () => {
        started.open();
        await finish.promise;

        return {
          id: `cs_${randomUUID()}`,
          url: "https://checkout.stripe.com/test",
          expires_at: Math.floor(Date.now() / MS_PER_SECOND) + STRIPE_SESSION_EXPIRES_SECONDS,
        };
      });
      const checkout =
        scope === "user"
          ? createTopupCheckoutSession({ userId: f.user.id, credits: apiEnv.BILLING_TOPUP_MIN_CREDITS })
          : createWorkspaceTopupCheckoutSession({
              workspaceId: f.user.workspaceId,
              actorUserId: f.user.id,
              credits: apiEnv.BILLING_TOPUP_MIN_CREDITS,
            });
      await Promise.race([
        started.promise,
        (async () => {
          await checkout;
          assert.fail(MESSAGE_CHECKOUT_DID_NOT_START);
        })(),
      ]);
      const response = await f.delete();
      finish.open();
      await checkout;
      assert.equal(response.statusCode, HTTP_STATUS_CONFLICT, response.body);
      const pendingBody = accountErrorResponseSchema.parse(response.json());
      assert.equal(pendingBody.code, "account_checkout_pending");
      assert.equal(createSession.mock.callCount(), 1);
      await f.unchanged();
    });
  }, Promise.resolve());
});

void test("a removed recipient cannot receive workspace ownership", { skip: !isIsolatedDb }, async (t) => {
  const owner = await fixture(t),
    recipient = await fixture(t);
  await owner.subscription({ scope: "workspace", status: "active" });
  await ensureWorkspaceMembership({ workspaceId: owner.user.workspaceId, userId: recipient.user.id, role: "member" });
  await anonymizeUserAccount(recipient.user.id);
  await assert.rejects(
    transferWorkspaceOwnership({
      workspaceId: owner.user.workspaceId,
      actorUserId: owner.user.id,
      targetUserId: recipient.user.id,
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "ownership_target_invalid",
  );
  assert.deepEqual(await ownerUserIds(owner.user.workspaceId), [owner.user.id]);
});

void test(
  "account removal after an ownership transfer keeps the saved owner and billing block",
  { skip: !isIsolatedDb },
  async (t) => {
    await [true, false].reduce(async (previous, isSubscribed) => {
      await previous;
      await t.test(isSubscribed ? "subscribed workspace" : "free shared workspace", async (t) => {
        const owner = await fixture(t),
          recipient = await fixture(t);
        if (isSubscribed) {
          await owner.subscription({ scope: "workspace", status: "active" });
        }
        await ensureWorkspaceMembership({
          workspaceId: owner.user.workspaceId,
          userId: recipient.user.id,
          role: "member",
        });
        await transferWorkspaceOwnership({
          workspaceId: owner.user.workspaceId,
          actorUserId: owner.user.id,
          targetUserId: recipient.user.id,
        });
        const response = await recipient.delete();
        assert.equal(response.statusCode, HTTP_STATUS_CONFLICT, response.body);
        const errorBody = accountErrorResponseSchema.parse(response.json());
        assert.equal(
          errorBody.code,
          isSubscribed ? "account_subscription_active" : "workspace_owner_transfer_required",
        );
        await recipient.unchanged();
        assert.deepEqual(await ownerUserIds(owner.user.workspaceId), [recipient.user.id]);
      });
    }, Promise.resolve());
  },
);

void test(
  "deleted owners cannot transfer ownership even when their membership row remains active",
  { skip: !isIsolatedDb },
  async (t) => {
    const owner = await fixture(t),
      recipient = await fixture(t);
    await ensureWorkspaceMembership({ workspaceId: owner.user.workspaceId, userId: recipient.user.id, role: "member" });
    await anonymizeUserAccount(owner.user.id);
    await assert.rejects(
      transferWorkspaceOwnership({
        workspaceId: owner.user.workspaceId,
        actorUserId: owner.user.id,
        targetUserId: recipient.user.id,
      }),
      (error: unknown) => error instanceof WorkspaceAdminError && error.code === "workspace_owner_required",
    );
  },
);
