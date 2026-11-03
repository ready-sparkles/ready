import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import { listMemoryPeople, memoryPeopleForMeetingUsers } from "../adapters/secondary/postgres/relationship-memory";
import { upsertUser } from "../adapters/secondary/postgres/repositories";
import { createWorkspaceForUser } from "../adapters/secondary/postgres/workspace-admin";

const TEST_WORKSPACE_LIMIT = 5;
const EXPECTED_LINKED_TARGET_COUNT = 2;

const testState = {
  userIds: [] as string[],
  workspaceIds: [] as string[],
};

after(async () => {
  if (testState.workspaceIds.length !== 0) {
    await db.workspaces.deleteMany({ where: { id: { in: testState.workspaceIds } } });
  }
  if (testState.userIds.length !== 0) {
    await db.users.deleteMany({ where: { id: { in: testState.userIds } } });
  }
  await closeDbPool();
});

async function readMemoryPersonPhoto(input: {
  scope: { userId: string; workspaceId: string };
  sourceId: string;
}): Promise<string | null | undefined> {
  return (await listMemoryPeople({ scope: input.scope, sourceIds: [input.sourceId] }))[0]?.imageUrl;
}

async function makeUser(source: "auth" | "debug_import" = "auth") {
  const user = await upsertUser({
    email: `memory-identity-${randomUUID()}@example.test`,
    displayName: "Same Name",
    source,
  });
  testState.userIds = [...testState.userIds, user.id];

  return user;
}

void test("participant memory identity resolution is viewer and workspace scoped, never name-based", async () => {
  await assertParticipantMemoryIdentityResolution();
});

async function assertVerifiedEmailSuppliesAccountPhoto(input: {
  scope: { userId: string; workspaceId: string };
  personId: string;
  viewerId: string;
  workspaceId: string;
  sourceId: string;
  otherViewerId: string;
  targets: string[];
  target: { id: string; email: string };
  unverified: { email: string };
  readPhoto: () => Promise<string | null | undefined>;
}): Promise<void> {
  await db.memoryPersonIdentities.createMany({
    data: [input.target.email, input.unverified.email].map((email) => ({
      personId: input.personId,
      userId: input.viewerId,
      workspaceId: input.workspaceId,
      kind: "verified_email",
      identity: email,
    })),
  });
  assert.deepEqual(
    await memoryPeopleForMeetingUsers({ scope: input.scope, userIds: input.targets }),
    [{ userId: input.target.id, personId: input.personId }],
    "only authenticated emails match",
  );
  assert.equal(
    await input.readPhoto(),
    "https://example.test/account-photo.jpg",
    "verified email links supply the account photo",
  );
  assert.deepEqual(
    await listMemoryPeople({ scope: { ...input.scope, userId: input.otherViewerId }, sourceIds: [input.sourceId] }),
    [],
  );
  assert.deepEqual(
    await memoryPeopleForMeetingUsers({
      scope: { ...input.scope, userId: input.otherViewerId },
      userIds: input.targets,
    }),
    [],
  );
  assert.deepEqual(
    await memoryPeopleForMeetingUsers({ scope: { ...input.scope, workspaceId: randomUUID() }, userIds: input.targets }),
    [],
  );
}

async function assertParticipantMemoryIdentityResolution(): Promise<void> {
  const viewer = await makeUser();
  const otherViewer = await makeUser();
  const target = await makeUser();
  const unverified = await makeUser("debug_import");
  const workspace = await createWorkspaceForUser({
    userId: viewer.id,
    name: "Private identity test",
    maxWorkspacesPerUser: TEST_WORKSPACE_LIMIT,
  });
  testState.workspaceIds = [...testState.workspaceIds, workspace.id];
  const scope = { userId: viewer.id, workspaceId: workspace.id };
  const personId = randomUUID();
  await db.memoryPeople.create({
    data: {
      id: personId,
      userId: viewer.id,
      workspaceId: workspace.id,
      name: "Same Name",
    },
  });
  const sourceId = randomUUID();
  await db.memorySources.create({
    data: {
      id: sourceId,
      userId: viewer.id,
      workspaceId: workspace.id,
      kind: "meeting",
      externalId: sourceId,
      occurredAt: new Date(),
      revision: "test",
      isCurrent: true,
    },
  });
  await db.memoryInteractions.create({
    data: {
      sourceId,
      personId,
      occurredAt: new Date(),
    },
  });
  await db.users.updateMany({
    where: { id: target.id },
    data: { avatarUrl: "https://example.test/account-photo.jpg" },
  });
  const readPhoto = () => readMemoryPersonPhoto({ scope, sourceId });
  assert.equal(await readPhoto(), null, "matching names cannot supply someone else’s photo");
  const targets = [target.id, unverified.id];
  assert.deepEqual(await memoryPeopleForMeetingUsers({ scope, userIds: targets }), [], "same names alone do not match");
  await assertVerifiedEmailSuppliesAccountPhoto({
    scope,
    personId,
    viewerId: viewer.id,
    workspaceId: workspace.id,
    sourceId,
    otherViewerId: otherViewer.id,
    targets,
    target,
    unverified,
    readPhoto,
  });
  await db.memoryPersonIdentities.create({
    data: {
      personId,
      userId: viewer.id,
      workspaceId: workspace.id,
      kind: "user_id",
      identity: unverified.id,
    },
  });
  assert.equal(
    (await memoryPeopleForMeetingUsers({ scope, userIds: targets })).length,
    EXPECTED_LINKED_TARGET_COUNT,
    "exact linked account IDs also match",
  );
  await db.users.updateMany({
    where: { id: unverified.id },
    data: { avatarUrl: "https://example.test/imported-photo.jpg" },
  });
  assert.equal(
    await readPhoto(),
    "https://example.test/account-photo.jpg",
    "a verified account photo wins over guest or imported links",
  );
  const conflictingAccount = await makeUser();
  await db.users.updateMany({
    where: { id: conflictingAccount.id },
    data: { avatarUrl: "https://example.test/conflicting-photo.jpg" },
  });
  await assertConflictingAndDeletedMemoryPhotoBehavior({
    scope,
    personId,
    viewerWorkspaceId: workspace.id,
    targets,
    target,
    unverified,
    conflictingAccount,
    readPhoto,
  });
}

async function assertConflictingAndDeletedMemoryPhotoBehavior(input: {
  scope: { userId: string; workspaceId: string };
  personId: string;
  viewerWorkspaceId: string;
  targets: string[];
  target: { id: string };
  unverified: { id: string };
  conflictingAccount: { id: string };
  readPhoto: () => Promise<string | null | undefined>;
}): Promise<void> {
  await db.memoryPersonIdentities.create({
    data: {
      personId: input.personId,
      userId: input.scope.userId,
      workspaceId: input.viewerWorkspaceId,
      kind: "user_id",
      identity: input.conflictingAccount.id,
    },
  });
  assert.equal(await input.readPhoto(), null, "two different verified accounts still require identity resolution");
  await db.users.updateMany({ where: { id: input.conflictingAccount.id }, data: { deletedAt: new Date() } });
  assert.equal(await input.readPhoto(), "https://example.test/account-photo.jpg");
  await db.users.updateMany({ where: { id: input.unverified.id }, data: { avatarUrl: null } });
  await db.users.updateMany({ where: { id: input.target.id }, data: { deletedAt: new Date() } });
  assert.deepEqual(await memoryPeopleForMeetingUsers({ scope: input.scope, userIds: input.targets }), [
    { userId: input.unverified.id, personId: input.personId },
  ]);
  assert.equal(await input.readPhoto(), null, "deleted users do not supply photos");
  await db.users.updateMany({
    where: { id: input.unverified.id },
    data: { avatarUrl: "https://example.test/linked-account.jpg" },
  });
  assert.equal(
    await input.readPhoto(),
    "https://example.test/linked-account.jpg",
    "an exact linked account also supplies its photo",
  );
}
