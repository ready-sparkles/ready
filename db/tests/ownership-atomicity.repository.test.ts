import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { withAccountDeletionBillingGuard } from "../adapters/secondary/postgres/account-deletion";
import type { Prisma } from "../adapters/secondary/postgres/client";
import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import { ensureWorkspaceMembership, upsertUser } from "../adapters/secondary/postgres/repositories";
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
} from "../adapters/secondary/postgres/workspace-admin";

const INVITATION_LIFETIME_MS = 60_000;
const AUDIT_FAILURE_MESSAGE = "Injected audit failure";
after(closeDbPool);
const fixture = async () => {
  const create = () => upsertUser({ email: `${randomUUID()}@ownership.test`, displayName: "Owner fixture" });
  const owner = await create();
  const target = await create();
  await ensureWorkspaceMembership({ workspaceId: owner.workspaceId, userId: target.id, role: "member" });

  return { owner, target, input: { workspaceId: owner.workspaceId, actorUserId: owner.id, targetUserId: target.id } };
};

function pinDelegate(input: { owner: object; key: string; delegate: object }): void {
  const owner = input.owner;
  Reflect.set(owner, input.key, input.delegate);
}

function runInTransaction(decorate: (tx: Prisma.TransactionClient) => void): () => void {
  const original = db.$transaction.bind(db);
  const client = db;
  const install = (transaction: object): void => {
    Reflect.set(client, "$transaction", transaction);
  };
  install(async (input: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
    original(async (tx) => {
      decorate(tx);

      return input(tx);
    }, options),
  );

  return () => {
    Reflect.deleteProperty(client, "$transaction");
  };
}

void test("failed transfer audit rolls back both membership writes", async (t) => {
  const { input, owner, target } = await fixture();
  const restore = runInTransaction((tx) => {
    const audit = tx.workspaceAuditEvents;
    audit.create = () => {
      throw new Error(AUDIT_FAILURE_MESSAGE);
    };
    pinDelegate({ owner: tx, key: "workspaceAuditEvents", delegate: audit });
  });
  t.after(restore);
  await assert.rejects(transferWorkspaceOwnership(input), { message: AUDIT_FAILURE_MESSAGE });
  const rows = await db.workspaceMemberships.findMany({ where: { workspaceId: input.workspaceId } });
  assert.equal(rows.find((row) => row.userId === owner.id)?.role, "owner");
  assert.equal(rows.find((row) => row.userId === target.id)?.role, "member");
});

void test("concurrent ownership transfers leave exactly one owner", async () => {
  const { input, owner } = await fixture();
  const third = await upsertUser({ email: `${randomUUID()}@ownership.test`, displayName: "Third" });
  await ensureWorkspaceMembership({ workspaceId: owner.workspaceId, userId: third.id, role: "member" });
  const results = await Promise.allSettled([
    transferWorkspaceOwnership(input),
    transferWorkspaceOwnership({ ...input, targetUserId: third.id }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rows = await db.workspaceMemberships.findMany({ where: { workspaceId: input.workspaceId } });
  assert.equal(rows.filter((row) => row.role === "owner").length, 1);
});

void test("a stale member edit cannot demote a newly promoted owner", async () => {
  const { input } = await fixture();
  await Promise.allSettled([transferWorkspaceOwnership(input), updateWorkspaceMemberRole({ ...input, role: "admin" })]);
  const rows = await db.workspaceMemberships.findMany({ where: { workspaceId: input.workspaceId } });
  assert.equal(rows.filter((row) => row.role === "owner").length, 1);
});

void test("ownership cannot be transferred to an account reserved for deletion", async () => {
  const { input, target } = await fixture();
  await db.users.updateMany({ where: { id: target.id }, data: { deletionRequestedAt: new Date() } });
  await assert.rejects(transferWorkspaceOwnership(input), /active Ready account/);
});

void test("failure of the promotion write rolls back the old owner demotion", async (t) => {
  const { input, owner } = await fixture();
  const restore = runInTransaction((tx) => {
    const memberships = tx.workspaceMemberships;
    const updateMany = memberships.updateMany.bind(memberships);
    const updateManyAndReturn = memberships.updateManyAndReturn.bind(memberships);
    const state = { writes: 0 };
    const guardWrite = <Result>(write: () => Result): Result => {
      state.writes += 1;
      if (state.writes > 1) {
        throw new Error(AUDIT_FAILURE_MESSAGE);
      }

      return write();
    };
    memberships.updateMany = (args) => guardWrite(() => updateMany(args));
    memberships.updateManyAndReturn = (args) => guardWrite(() => updateManyAndReturn(args));
    pinDelegate({ owner: tx, key: "workspaceMemberships", delegate: memberships });
  });
  t.after(restore);
  await assert.rejects(transferWorkspaceOwnership(input), { message: AUDIT_FAILURE_MESSAGE });
  const rows = await db.workspaceMemberships.findMany({ where: { workspaceId: input.workspaceId } });
  assert.deepEqual(
    rows.filter((row) => row.role === "owner").map((row) => row.userId),
    [owner.id],
  );
});

void test("a deletion-reserved owner can transfer out after a pending invitation is accepted", async () => {
  const owner = await upsertUser({ email: `${randomUUID()}@deletion-recovery.test`, displayName: "Deleting owner" });
  const target = await upsertUser({ email: `${randomUUID()}@deletion-recovery.test`, displayName: "Recovery owner" });
  const tokenHash = randomUUID();
  await createWorkspaceInvitation({
    workspaceId: owner.workspaceId,
    email: target.email,
    role: "member",
    invitedByUserId: owner.id,
    tokenHash,
    expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
  });
  await assert.rejects(
    withAccountDeletionBillingGuard({
      userId: owner.id,
      run: async () => {
        throw new Error(AUDIT_FAILURE_MESSAGE);
      },
    }),
    { message: AUDIT_FAILURE_MESSAGE },
  );
  await acceptWorkspaceInvitation({ tokenHash, userId: target.id, userEmail: target.email });
  await assert.rejects(
    withAccountDeletionBillingGuard({ userId: owner.id, run: async () => undefined }),
    /Transfer ownership/,
  );
  await transferWorkspaceOwnership({ workspaceId: owner.workspaceId, actorUserId: owner.id, targetUserId: target.id });
  await withAccountDeletionBillingGuard({ userId: owner.id, run: async () => undefined });
  const rows = await db.workspaceMemberships.findMany({ where: { workspaceId: owner.workspaceId } });
  assert.equal(rows.find((row) => row.role === "owner")?.userId, target.id);
});
