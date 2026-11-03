import {
  closeDbPool,
  connectAshbyMember,
  createWorkspaceForUser,
  deleteWorkspaceAshbyIntegration,
  ensureWorkspaceMembership,
  saveWorkspaceAshbyIntegration,
  upsertUser,
} from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import type { AshbyCandidate, AshbyClient } from "../../adapters/secondary/ashby/ashby-client";
import { AshbyApiError } from "../../adapters/secondary/ashby/ashby-client";
import { ashbyProfileLinksForPerson, safeAshbyProfileUrl } from "../../adapters/secondary/ashby/ashby-profile-links";
import { encryptJsonSecret } from "../../adapters/secondary/node/secret-crypto";

const MAX_WORKSPACES_PER_USER_FOR_TEST = 20;
const HTTP_STATUS_BAD_GATEWAY = 502;
const ASHBY_BAD_GATEWAY_MESSAGE = "Bad gateway";
const ASHBY_API_ERROR_KIND = "server";
const ASHBY_CANDIDATE_SEARCH_ENDPOINT = "candidate.search";
const EXPECTED_SINGLE_ASHBY_SEARCH = 1;
const NOT_IMPLEMENTED_MESSAGE = "not implemented";

// Remove this file's Ashby rows so a running local API never picks them up.
const createdWorkspaceState = { workspaceIds: [] as string[] };
after(async () => {
  await Promise.all(
    createdWorkspaceState.workspaceIds.map((workspaceId) => deleteWorkspaceAshbyIntegration(workspaceId)),
  );
  await closeDbPool();
});

async function setup() {
  const owner = await upsertUser({ email: `${randomUUID()}@ashby-links.test`, displayName: "Owner" });
  const member = await upsertUser({ email: `${randomUUID()}@ashby-links.test`, displayName: "Member" });
  const workspace = await createWorkspaceForUser({
    userId: owner.id,
    name: "Ashby links",
    maxWorkspacesPerUser: MAX_WORKSPACES_PER_USER_FOR_TEST,
  });
  createdWorkspaceState.workspaceIds = [...createdWorkspaceState.workspaceIds, workspace.id];
  await ensureWorkspaceMembership({ workspaceId: workspace.id, userId: member.id, role: "member" });
  await saveWorkspaceAshbyIntegration({
    workspaceId: workspace.id,
    secretRef: encryptJsonSecret({ apiKey: "workspace-key" }),
    configuredByUserId: owner.id,
  });

  return { workspaceId: workspace.id, member };
}

function fakeAshby(respond: (email: string) => AshbyCandidate[] | Error) {
  const state = { searches: [] as string[], keys: [] as string[] };
  const createClient = (input: { apiKey: string; signal: AbortSignal }): AshbyClient => ({
    call: async () => {
      throw new Error(NOT_IMPLEMENTED_MESSAGE);
    },
    write: async () => {
      throw new Error(NOT_IMPLEMENTED_MESSAGE);
    },
    searchCandidates: async (query: { email: string } | { name: string }) => {
      const email = "email" in query ? query.email : "";
      state.searches = [...state.searches, email];
      state.keys = [...state.keys, input.apiKey];
      const result = respond(email);
      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
    application: async () => null,
  });

  return {
    createClient,
    get searches() {
      return state.searches;
    },
    get keys() {
      return state.keys;
    },
  };
}

const personqj: AshbyCandidate = {
  id: "cand-personqj",
  name: "Personqj Personqu",
  primaryEmailAddress: { value: "Personqj@Northstar.test" },
  profileUrl: "https://app.ashbyhq.com/candidates/cand-personqj",
};

void test("members who have not turned Ashby on get no pill and no Ashby call", async () => {
  const { workspaceId, member } = await setup();
  const ashby = fakeAshby(() => [personqj]);
  const links = await ashbyProfileLinksForPerson({
    workspaceId,
    userId: member.id,
    email: "personqj@northstar.test",
    dependencies: ashby,
  });
  assert.deepEqual(links, []);
  assert.deepEqual(ashby.searches, []);
});

void test("a connected member gets the Ashby pill for a matching email, then from cache", async () => {
  const { workspaceId, member } = await setup();
  await connectAshbyMember({ workspaceId, userId: member.id });
  const ashby = fakeAshby(() => [personqj]);

  const first = await ashbyProfileLinksForPerson({
    workspaceId,
    userId: member.id,
    email: "PERSONQJ@northstar.test",
    dependencies: ashby,
  });
  assert.deepEqual(first, [{ label: "Ashby", url: "https://app.ashbyhq.com/candidates/cand-personqj" }]);
  assert.deepEqual(ashby.keys, ["workspace-key"], "the stored workspace key is used");

  const second = await ashbyProfileLinksForPerson({
    workspaceId,
    userId: member.id,
    email: "personqj@northstar.test",
    dependencies: ashby,
  });
  assert.deepEqual(second, first);
  assert.equal(ashby.searches.length, EXPECTED_SINGLE_ASHBY_SEARCH, "the second view is served from cache");
});

void test("no pill when no candidate or several candidates use the email", async () => {
  const { workspaceId, member } = await setup();
  await connectAshbyMember({ workspaceId, userId: member.id });
  const twin = { ...personqj, id: "cand-twin", profileUrl: null };
  const ashby = fakeAshby((email) =>
    email.startsWith("twins")
      ? [
          { ...personqj, primaryEmailAddress: { value: email } },
          { ...twin, primaryEmailAddress: { value: email } },
        ]
      : [{ ...personqj, primaryEmailAddress: { value: "someone-else@northstar.test" } }],
  );

  assert.deepEqual(
    await ashbyProfileLinksForPerson({
      workspaceId,
      userId: member.id,
      email: "nobody@northstar.test",
      dependencies: ashby,
    }),
    [],
  );
  assert.deepEqual(
    await ashbyProfileLinksForPerson({
      workspaceId,
      userId: member.id,
      email: "twins@northstar.test",
      dependencies: ashby,
    }),
    [],
  );
  assert.deepEqual(
    await ashbyProfileLinksForPerson({ workspaceId, userId: member.id, email: null, dependencies: ashby }),
    [],
  );
});

void test("an Ashby outage omits the pill without caching the miss", async () => {
  const { workspaceId, member } = await setup();
  await connectAshbyMember({ workspaceId, userId: member.id });
  const outageState = { isAshbyDown: true };
  const ashby = fakeAshby(() =>
    outageState.isAshbyDown
      ? new AshbyApiError(
          ASHBY_API_ERROR_KIND,
          ASHBY_CANDIDATE_SEARCH_ENDPOINT,
          ASHBY_BAD_GATEWAY_MESSAGE,
          HTTP_STATUS_BAD_GATEWAY,
        )
      : [personqj],
  );

  assert.deepEqual(
    await ashbyProfileLinksForPerson({
      workspaceId,
      userId: member.id,
      email: "personqj@northstar.test",
      dependencies: ashby,
    }),
    [],
  );
  outageState.isAshbyDown = false;
  const recovered = await ashbyProfileLinksForPerson({
    workspaceId,
    userId: member.id,
    email: "personqj@northstar.test",
    dependencies: ashby,
  });
  assert.equal(recovered[0]?.url, "https://app.ashbyhq.com/candidates/cand-personqj");
});

void test("only Ashby URLs become links", () => {
  assert.equal(
    safeAshbyProfileUrl({ id: "c1", name: "A", profileUrl: "https://app.ashbyhq.com/candidates/c1" }),
    "https://app.ashbyhq.com/candidates/c1",
  );
  assert.equal(
    safeAshbyProfileUrl({ id: "c1", name: "A", profileUrl: "https://evil.example/ashbyhq.com" }),
    "https://app.ashbyhq.com/candidates/c1",
  );
  assert.equal(
    safeAshbyProfileUrl({ id: "c1", name: "A", profileUrl: "javascript:alert(1)" }),
    "https://app.ashbyhq.com/candidates/c1",
  );
  assert.equal(safeAshbyProfileUrl({ id: "c 1", name: "A" }), "https://app.ashbyhq.com/candidates/c%201");
});
