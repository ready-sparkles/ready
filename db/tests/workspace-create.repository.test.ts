import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  createGuestUser,
  ensureDefaultWorkspaceForUser,
  ensureWorkspaceMembership,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";
import {
  createWorkspaceForUser,
  getWorkspaceMembership,
  listMyWorkspacesDetailed,
  suspendWorkspaceMember,
  transferWorkspaceOwnership,
  WorkspaceAdminError,
} from "../adapters/secondary/postgres/workspace-admin";

const MAX_WORKSPACES_PER_USER_DEFAULT = 20;
const MAX_WORKSPACE_NAME_LENGTH = 256;
const MAX_WORKSPACES_PER_USER_SMALL = 2;

after(async () => {
  await closeDbPool();
});

async function makeUser(label: string) {
  return upsertUser({
    email: `${randomUUID()}@${label}.readymeet.test`,
    displayName: `${label} user`,
  });
}

async function activeWorkspaceIdOf(userId: string) {
  const result = await db.users.findMany({
    where: { id: userId },
    select: { /** @external Prisma field */ activeWorkspaceId: true },
  });

  return result[0]?.activeWorkspaceId ?? null;
}

void test("createWorkspaceForUser creates the workspace, owner membership, and switches the active workspace", async () => {
  const user = await makeUser("wscreate");

  const workspace = await createWorkspaceForUser({
    userId: user.id,
    name: "  Acme Skunkworks  ",
    maxWorkspacesPerUser: MAX_WORKSPACES_PER_USER_DEFAULT,
  });

  assert.equal(workspace.name, "Acme Skunkworks");
  assert.equal(workspace.createdByUserId, user.id);

  const membership = await getWorkspaceMembership({ workspaceId: workspace.id, userId: user.id });
  assert.equal(membership?.role, "owner");
  assert.equal(membership.status, "active");

  assert.equal(await activeWorkspaceIdOf(user.id), workspace.id);

  const workspaces = await listMyWorkspacesDetailed(user.id);
  assert.ok(workspaces.some((row) => row.id === workspace.id));
});

void test("createWorkspaceForUser rejects empty and oversized names without touching the active workspace", async () => {
  const user = await makeUser("wsname");
  const activeBefore = await activeWorkspaceIdOf(user.id);

  await Promise.all(
    ["", "   ", "x".repeat(MAX_WORKSPACE_NAME_LENGTH)].map(async (name) => {
      await assert.rejects(
        createWorkspaceForUser({ userId: user.id, name, maxWorkspacesPerUser: MAX_WORKSPACES_PER_USER_DEFAULT }),
        (error: unknown) => error instanceof WorkspaceAdminError && error.code === "invalid_workspace_name",
      );
    }),
  );

  assert.equal(await activeWorkspaceIdOf(user.id), activeBefore);
});

void test("createWorkspaceForUser enforces the created-workspace cap", async () => {
  const user = await makeUser("wscap");

  // The signup flow already auto-created one workspace for this user, so a
  // cap of 2 leaves room for exactly one more.
  const workspace = await createWorkspaceForUser({
    userId: user.id,
    name: "Second workspace",
    maxWorkspacesPerUser: MAX_WORKSPACES_PER_USER_SMALL,
  });
  assert.notEqual(workspace.id, "");

  await assert.rejects(
    createWorkspaceForUser({
      userId: user.id,
      name: "Third workspace",
      maxWorkspacesPerUser: MAX_WORKSPACES_PER_USER_SMALL,
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "workspace_limit_reached",
  );

  // Joining other workspaces does not count against the creation cap, so the
  // active workspace stays on the last successful creation.
  assert.equal(await activeWorkspaceIdOf(user.id), workspace.id);
});

void test("a user suspended from every workspace gets a fresh default context, not a suspended one", async () => {
  const owner = await makeUser("wssuspfallback");
  const otherAdmin = await makeUser("wssuspfallbackadmin");
  await ensureWorkspaceMembership({
    workspaceId: owner.workspaceId,
    userId: otherAdmin.id,
    role: "admin",
  });
  await transferWorkspaceOwnership({
    workspaceId: owner.workspaceId,
    actorUserId: owner.id,
    targetUserId: otherAdmin.id,
  });
  await suspendWorkspaceMember({
    workspaceId: owner.workspaceId,
    actorUserId: otherAdmin.id,
    targetUserId: owner.id,
  });

  const resolved = await ensureDefaultWorkspaceForUser({
    userId: owner.id,
    email: owner.email,
    displayName: owner.displayName,
  });
  assert.notEqual(resolved, owner.workspaceId, "a suspended membership must not become the default context");

  const membership = await getWorkspaceMembership({ workspaceId: resolved, userId: owner.id });
  assert.equal(membership?.role, "owner");
  assert.equal(membership.status, "active");

  // Stable afterwards: the fresh workspace is now the oldest active
  // membership, so no second workspace gets created.
  const again = await ensureDefaultWorkspaceForUser({
    userId: owner.id,
    email: owner.email,
    displayName: owner.displayName,
  });
  assert.equal(again, resolved);
});

void test("createWorkspaceForUser rejects guest users", async () => {
  const guest = await createGuestUser({ displayName: "Drop-in guest" });

  await assert.rejects(
    createWorkspaceForUser({
      userId: guest.id,
      name: "Guest workspace",
      maxWorkspacesPerUser: MAX_WORKSPACES_PER_USER_DEFAULT,
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "guest_cannot_create_workspace",
  );
});

const CONCURRENT_DEFAULT_WORKSPACE_CALLS = 10;

async function insertUserWithoutWorkspace(label: string) {
  const user = await db.users.create({
    data: { email: `${randomUUID()}@${label}.readymeet.test`, displayName: `${label} user`, source: "auth" },
  });
  assert.equal(user.source, "auth");

  return user;
}

async function ownedSystemWorkspaceIds(userId: string) {
  const rows = await db.workspaces.findMany({
    where: { createdByUserId: userId },
    select: { /** @external Prisma field */ id: true, /** @external Prisma field */ createdVia: true },
  });

  return rows.filter((row) => row.createdVia !== "user");
}

void test("concurrent first sign-in creates exactly one default workspace", async () => {
  const user = await insertUserWithoutWorkspace("wsconcurrentdefault");

  const resolved = await Promise.all(
    Array.from({ length: CONCURRENT_DEFAULT_WORKSPACE_CALLS }, () =>
      ensureDefaultWorkspaceForUser({ userId: user.id, email: user.email, displayName: user.displayName }),
    ),
  );

  assert.equal(new Set(resolved).size, 1);
  const owned = await ownedSystemWorkspaceIds(user.id);
  assert.equal(owned.length, 1);
  assert.equal(owned[0]?.createdVia, "system_default");
  const memberships = await db.workspaceMemberships.findMany({
    where: { userId: user.id, workspaceId: resolved[0] ?? "" },
    select: { /** @external Prisma field */ role: true, /** @external Prisma field */ status: true },
  });
  assert.deepEqual(memberships, [{ role: "owner", status: "active" }]);
  assert.equal(await activeWorkspaceIdOf(user.id), resolved[0]);
});

void test("concurrent calls for a user suspended everywhere converge on one fresh active workspace", async () => {
  const owner = await makeUser("wssuspconcurrent");
  const otherAdmin = await makeUser("wssuspconcurrentadmin");
  await ensureWorkspaceMembership({ workspaceId: owner.workspaceId, userId: otherAdmin.id, role: "admin" });
  await transferWorkspaceOwnership({
    workspaceId: owner.workspaceId,
    actorUserId: owner.id,
    targetUserId: otherAdmin.id,
  });
  await suspendWorkspaceMember({ workspaceId: owner.workspaceId, actorUserId: otherAdmin.id, targetUserId: owner.id });

  const resolved = await Promise.all(
    Array.from({ length: CONCURRENT_DEFAULT_WORKSPACE_CALLS }, () =>
      ensureDefaultWorkspaceForUser({ userId: owner.id, email: owner.email, displayName: owner.displayName }),
    ),
  );

  assert.equal(new Set(resolved).size, 1);
  assert.notEqual(resolved[0], owner.workspaceId);
  const membership = await getWorkspaceMembership({ workspaceId: resolved[0] ?? "", userId: owner.id });
  assert.equal(membership?.role, "owner");
  assert.equal(membership.status, "active");
  const owned = await ownedSystemWorkspaceIds(owner.id);
  assert.equal(owned.filter((row) => row.createdVia === "system_default").length, 1);
  assert.equal(owned.filter((row) => row.createdVia === "system_replacement").length, 1);
});
