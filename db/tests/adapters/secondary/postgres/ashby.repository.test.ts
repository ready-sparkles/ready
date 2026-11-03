import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import {
  connectAshbyMember,
  deleteWorkspaceAshbyIntegration,
  disconnectAshbyMember,
  getCachedAshbyCandidateLookup,
  getWorkspaceAshbyIntegration,
  isAshbyMemberConnected,
  listWorkspaceAdminNames,
  saveAshbyCandidateLookup,
  saveWorkspaceAshbyIntegration,
} from "../../../../adapters/secondary/postgres/ashby";
import { closeDbPool } from "../../../../adapters/secondary/postgres/client";
import { ensureWorkspaceMembership, upsertUser } from "../../../../adapters/secondary/postgres/repositories";
import { createWorkspaceForUser } from "../../../../adapters/secondary/postgres/workspace-admin";

// Remove this file's Ashby rows so a running local API never picks them up.
const MAX_WORKSPACES_PER_USER = 20;
const createdWorkspaceIds = new Set<string>();
after(async () => {
  await deleteRows();
  await closeDbPool();
});
async function deleteRows() {
  await Promise.all([...createdWorkspaceIds].map((workspaceId) => deleteWorkspaceAshbyIntegration(workspaceId)));
}

async function makeUser(label: string) {
  return upsertUser({ email: `${randomUUID()}@${label}.readymeet.test`, displayName: `${label} user` });
}

async function makeWorkspace() {
  const owner = await makeUser("ashbyowner");
  const workspace = await createWorkspaceForUser({
    userId: owner.id,
    name: "Ashby test",
    maxWorkspacesPerUser: MAX_WORKSPACES_PER_USER,
  });
  createdWorkspaceIds.add(workspace.id);
  const member = await makeUser("ashbymember");
  await ensureWorkspaceMembership({ workspaceId: workspace.id, userId: member.id, role: "member" });

  return { workspaceId: workspace.id, owner, member };
}

const HOUR = 3_600_000;

void test("members can only turn Ashby on once the workspace has a key", async () => {
  const { workspaceId, owner, member } = await makeWorkspace();
  assert.deepEqual(await listWorkspaceAdminNames(workspaceId), [owner.displayName]);
  assert.equal(await connectAshbyMember({ workspaceId, userId: member.id }), false);

  await saveWorkspaceAshbyIntegration({ workspaceId, secretRef: "encrypted", configuredByUserId: owner.id });
  assert.equal((await getWorkspaceAshbyIntegration(workspaceId))?.configuredByName, owner.displayName);
  assert.equal(await connectAshbyMember({ workspaceId, userId: member.id }), true);
  assert.equal(await connectAshbyMember({ workspaceId, userId: member.id }), true, "connecting twice is harmless");
  assert.equal(
    await isAshbyMemberConnected({ workspaceId, userId: owner.id }),
    false,
    "each member opts in separately",
  );

  await disconnectAshbyMember({ workspaceId, userId: member.id });
  assert.equal(await isAshbyMemberConnected({ workspaceId, userId: member.id }), false);
});

void test("candidate lookups are cached per workspace until they expire", async () => {
  const { workspaceId, owner } = await makeWorkspace();
  const other = await makeWorkspace();
  await saveWorkspaceAshbyIntegration({ workspaceId, secretRef: "encrypted", configuredByUserId: owner.id });
  await saveWorkspaceAshbyIntegration({
    workspaceId: other.workspaceId,
    secretRef: "encrypted",
    configuredByUserId: other.owner.id,
  });

  await saveAshbyCandidateLookup({
    workspaceId,
    email: " Personqj@Northstar.test ",
    candidateId: "cand-1",
    profileUrl: "https://app.ashbyhq.com/candidates/cand-1",
  });
  await saveAshbyCandidateLookup({ workspaceId, email: "nobody@northstar.test", candidateId: null, profileUrl: null });

  assert.equal(
    (await getCachedAshbyCandidateLookup({ workspaceId, email: "personqj@northstar.test", maxAgeMs: HOUR }))
      ?.candidateId,
    "cand-1",
  );
  assert.deepEqual(
    {
      ...(await getCachedAshbyCandidateLookup({ workspaceId, email: "nobody@northstar.test", maxAgeMs: HOUR })),
      checkedAt: null,
    },
    { candidateId: null, profileUrl: null, checkedAt: null },
    "a miss is cached too",
  );
  assert.equal(
    await getCachedAshbyCandidateLookup({
      workspaceId: other.workspaceId,
      email: "personqj@northstar.test",
      maxAgeMs: HOUR,
    }),
    null,
    "lookups never cross workspaces",
  );

  assert.equal(
    await getCachedAshbyCandidateLookup({ workspaceId, email: "personqj@northstar.test", maxAgeMs: 0 }),
    null,
    "expired lookups are asked again",
  );
});

void test("a new key drops cached lookups, and removing the key clears everything", async () => {
  const { workspaceId, owner, member } = await makeWorkspace();
  await saveWorkspaceAshbyIntegration({ workspaceId, secretRef: "encrypted", configuredByUserId: owner.id });
  await connectAshbyMember({ workspaceId, userId: member.id });
  await saveAshbyCandidateLookup({
    workspaceId,
    email: "personqj@northstar.test",
    candidateId: "cand-1",
    profileUrl: "https://app.ashbyhq.com/candidates/cand-1",
  });

  await saveWorkspaceAshbyIntegration({ workspaceId, secretRef: "encrypted-new", configuredByUserId: owner.id });
  assert.equal(
    await getCachedAshbyCandidateLookup({ workspaceId, email: "personqj@northstar.test", maxAgeMs: HOUR }),
    null,
  );
  assert.equal(
    await isAshbyMemberConnected({ workspaceId, userId: member.id }),
    true,
    "replacing the key keeps members connected",
  );

  await deleteWorkspaceAshbyIntegration(workspaceId);
  assert.equal(await getWorkspaceAshbyIntegration(workspaceId), null);
  assert.equal(await isAshbyMemberConnected({ workspaceId, userId: member.id }), false);
  await saveAshbyCandidateLookup({
    workspaceId,
    email: "late@northstar.test",
    candidateId: "cand-2",
    profileUrl: null,
  });
  assert.equal(
    await getCachedAshbyCandidateLookup({ workspaceId, email: "late@northstar.test", maxAgeMs: HOUR }),
    null,
    "nothing is cached without a key",
  );
});
