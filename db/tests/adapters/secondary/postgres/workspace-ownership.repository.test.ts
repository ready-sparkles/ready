import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db, type DbTransaction, pool } from "../../../../adapters/secondary/postgres/client";
import { ensureWorkspaceMembership, upsertUser } from "../../../../adapters/secondary/postgres/repositories";
import {
  getWorkspaceMembership,
  listWorkspaceAuditEvents,
  listWorkspaceMembersAdmin,
  removeWorkspaceMember,
  restoreWorkspaceMember,
  suspendWorkspaceMember,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
  WorkspaceAdminError,
} from "../../../../adapters/secondary/postgres/workspace-admin";
import { countActiveWorkspaceMembers } from "../../../../adapters/secondary/postgres/workspace-billing";

after(closeDbPool);

const LOCK_WAIT_TIMEOUT_MS = 5_000;
const TWO_BLOCKED_OPERATIONS = 2;
const MESSAGE_INJECTED_FAILURE = "Injected ownership transfer failure";

async function makeWorkspace() {
  const owner = await upsertUser({ email: `${randomUUID()}@owner.readymeet.test`, displayName: "Owner" });
  const target = await upsertUser({ email: `${randomUUID()}@target.readymeet.test`, displayName: "Target" });
  const workspaceId = owner.workspaceId;
  await ensureWorkspaceMembership({ workspaceId, userId: target.id, role: "member" });

  return { workspaceId, actorUserId: owner.id, targetUserId: target.id };
}

async function assertOwner(input: { workspaceId: string; userId: string }) {
  const members = await listWorkspaceMembersAdmin(input.workspaceId);
  assert.deepEqual(
    members.filter((member) => member.role === "owner" && member.status === "active").map((member) => member.userId),
    [input.userId],
  );
}

async function waitForBlockedOperations(input: { blockerPid: number; count: number; deadline: number }): Promise<void> {
  const result = await pool.query<{ count: number }>(
    `WITH RECURSIVE blocked AS (
      SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
      UNION
      SELECT activity.pid FROM pg_stat_activity activity
      JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
    ) SELECT count(*)::int AS count FROM blocked`,
    [input.blockerPid],
  );
  if ((result.rows[0]?.count ?? 0) >= input.count) {
    return;
  }
  assert.ok(Date.now() < input.deadline, `Expected ${String(input.count)} operations waiting on the membership lock`);
  await waitForBlockedOperations(input);
}

// Observe real PostgreSQL lock waits before releasing either operation; no timing-based ordering.
async function runInLockOrder(input: {
  workspaceId: string;
  first: () => Promise<unknown>;
  second: () => Promise<unknown>;
}) {
  const blocker = await pool.connect();
  const state: { pending: Promise<PromiseSettledResult<unknown>[]>[] } = { pending: [] };
  try {
    await blocker.query("BEGIN");
    const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const blockerPid = pid.rows[0]?.pid;
    assert.ok(blockerPid !== undefined);
    await blocker.query(
      "SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 ORDER BY user_id FOR UPDATE",
      [input.workspaceId],
    );
    state.pending = [Promise.allSettled([input.first()])];
    await waitForBlockedOperations({ blockerPid, count: 1, deadline: Date.now() + LOCK_WAIT_TIMEOUT_MS });
    state.pending = [...state.pending, Promise.allSettled([input.second()])];
    await waitForBlockedOperations({
      blockerPid,
      count: TWO_BLOCKED_OPERATIONS,
      deadline: Date.now() + LOCK_WAIT_TIMEOUT_MS,
    });
    await blocker.query("COMMIT");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.all(state.pending);
  }

  return (await Promise.all(state.pending)).flat();
}

(["promotion", "audit"] as const).forEach((failurePoint) => {
  void test(`ownership transfer rolls back demotion and audit on ${failurePoint} failure`, async (context) => {
    const input = await makeWorkspace();
    const seatsBefore = await countActiveWorkspaceMembers(input.workspaceId);
    const failure = new Error(MESSAGE_INJECTED_FAILURE);
    const transaction = db.$transaction.bind(db);
    const injectFailure = (connection: DbTransaction) => {
      if (failurePoint === "promotion") {
        const memberships = connection.workspaceMemberships;
        Reflect.set(memberships, "updateManyAndReturn", () => {
          throw failure;
        });

        return;
      }
      const audits = connection.workspaceAuditEvents;
      Reflect.set(audits, "create", () => {
        throw failure;
      });
    };
    const client = db;
    Reflect.set(client, "$transaction", (operation: (tx: DbTransaction) => Promise<unknown>) =>
      transaction(async (tx) => {
        injectFailure(tx);

        return operation(tx);
      }),
    );
    context.after(() => {
      Reflect.deleteProperty(client, "$transaction");
    });

    await assert.rejects(transferWorkspaceOwnership(input), (error: unknown) => error === failure);
    await assertOwner({ workspaceId: input.workspaceId, userId: input.actorUserId });
    assert.equal(
      (await getWorkspaceMembership({ workspaceId: input.workspaceId, userId: input.targetUserId }))?.role,
      "member",
    );
    assert.equal(await countActiveWorkspaceMembers(input.workspaceId), seatsBefore);
    assert.deepEqual(await listWorkspaceAuditEvents({ workspaceId: input.workspaceId }), []);
  });
});

const membershipChanges = {
  demotion: (input: Awaited<ReturnType<typeof makeWorkspace>>) =>
    updateWorkspaceMemberRole({ ...input, role: "member" }),
  suspension: suspendWorkspaceMember,
  removal: removeWorkspaceMember,
  restoration: (input: Awaited<ReturnType<typeof makeWorkspace>>) =>
    restoreWorkspaceMember({ ...input, role: "member" }),
};

Object.entries(membershipChanges).forEach(([name, mutate]) => {
  void test(`ownership transfer protects the new owner from a queued ${name}`, async () => {
    const input = await makeWorkspace();
    const seatsBefore = await countActiveWorkspaceMembers(input.workspaceId);
    const [transfer, mutation] = await runInLockOrder({
      workspaceId: input.workspaceId,
      first: () => transferWorkspaceOwnership(input),
      second: () => mutate(input),
    });

    assert.equal(transfer?.status, "fulfilled");
    assert.equal(mutation?.status, "rejected");
    assert.ok(mutation.reason instanceof WorkspaceAdminError);
    assert.equal(mutation.reason.code, "owner_protected");
    await assertOwner({ workspaceId: input.workspaceId, userId: input.targetUserId });
    assert.equal(await countActiveWorkspaceMembers(input.workspaceId), seatsBefore);
    assert.equal((await listWorkspaceAuditEvents({ workspaceId: input.workspaceId })).length, 1);
  });
});

(["suspension", "removal"] as const).forEach((name) => {
  void test(`ownership transfer rechecks its target after a queued ${name} wins`, async () => {
    const input = await makeWorkspace();
    const [mutation, transfer] = await runInLockOrder({
      workspaceId: input.workspaceId,
      first: () => membershipChanges[name](input),
      second: () => transferWorkspaceOwnership(input),
    });

    assert.equal(mutation?.status, "fulfilled");
    assert.equal(transfer?.status, "rejected");
    assert.ok(transfer.reason instanceof WorkspaceAdminError);
    assert.equal(transfer.reason.code, "ownership_target_invalid");
    await assertOwner({ workspaceId: input.workspaceId, userId: input.actorUserId });
    assert.deepEqual(await listWorkspaceAuditEvents({ workspaceId: input.workspaceId }), []);
  });
});

void test("queued ownership transfers recheck the old owner and commit only one audit event", async () => {
  const input = await makeWorkspace();
  const other = await upsertUser({ email: `${randomUUID()}@other.readymeet.test`, displayName: "Other" });
  await ensureWorkspaceMembership({ workspaceId: input.workspaceId, userId: other.id });
  const seatsBefore = await countActiveWorkspaceMembers(input.workspaceId);
  const [first, second] = await runInLockOrder({
    workspaceId: input.workspaceId,
    first: () => transferWorkspaceOwnership(input),
    second: () => transferWorkspaceOwnership({ ...input, targetUserId: other.id }),
  });

  assert.equal(first?.status, "fulfilled");
  assert.equal(second?.status, "rejected");
  assert.ok(second.reason instanceof WorkspaceAdminError);
  assert.equal(second.reason.code, "workspace_owner_required");
  await assertOwner({ workspaceId: input.workspaceId, userId: input.targetUserId });
  assert.equal(await countActiveWorkspaceMembers(input.workspaceId), seatsBefore);
  assert.equal((await listWorkspaceAuditEvents({ workspaceId: input.workspaceId })).length, 1);
});
