import "../../../../../composition/env";

import {
  closeDbPool,
  createWorkspaceForUser,
  deleteWorkspaceAshbyIntegration,
  ensureWorkspaceMembership,
  isAshbyMemberConnected,
  upsertUser,
} from "@readymeet/db";
import { ashbyErrorCodeSchema, ashbyIntegrationStatusResponseSchema } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { z } from "zod";

import { ashbyIntegrationRoutes } from "../../../../../adapters/primary/http/routes/integrations-ashby";
import { signAuthToken } from "../../../../../adapters/primary/http/support/auth";
import { AshbyApiError, type AshbyClient } from "../../../../../adapters/secondary/ashby/ashby-client";

const MAX_WORKSPACES_PER_USER_FOR_TEST = 20;
const HTTP_REMOVE_METHOD = "DELETE" as const;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_CONFLICT = 409;

const ASHBY_MISSING_CANDIDATES_READ_MESSAGE = "Missing candidatesRead";
const ASHBY_INVALID_API_KEY_MESSAGE = "Invalid API key";
const ASHBY_ERROR_KIND_MISSING_PERMISSION = "missing_permission";
const ASHBY_ERROR_KIND_INVALID_KEY = "invalid_key";
const ASHBY_CANDIDATE_LIST_ENDPOINT = "candidate.list";
const MOCK_ASHBY_CLIENT_NOT_IMPLEMENTED_MESSAGE = "not implemented";

const ashbyErrorResponseSchema = z.object({
  code: ashbyErrorCodeSchema,
  message: z.string().optional(),
});

// Remove this file's Ashby rows so a running local API never picks them up.
const createdWorkspaceState = { workspaceIds: [] as string[] };
after(async () => {
  await createdWorkspaceState.workspaceIds.reduce(async (previous, workspaceId) => {
    await previous;
    await deleteWorkspaceAshbyIntegration(workspaceId);
  }, Promise.resolve());
  await closeDbPool();
});

const GOOD_KEY = "ashby-good-key-1234";

async function setup() {
  const suffix = randomUUID();
  const admin = await upsertUser({ email: `admin-${suffix}@ashby-routes.test`, displayName: "Admin" });
  const member = await upsertUser({ email: `member-${suffix}@ashby-routes.test`, displayName: "Member" });
  const workspace = await createWorkspaceForUser({
    userId: admin.id,
    name: "Ashby routes",
    maxWorkspacesPerUser: MAX_WORKSPACES_PER_USER_FOR_TEST,
  });
  createdWorkspaceState.workspaceIds = [...createdWorkspaceState.workspaceIds, workspace.id];
  await ensureWorkspaceMembership({ workspaceId: workspace.id, userId: member.id, role: "member" });

  const createClient = (apiKey: string): AshbyClient =>
    fakeAshbyClient({
      call: async () => {
        if (apiKey === "no-candidates-key") {
          throw new AshbyApiError(
            ASHBY_ERROR_KIND_MISSING_PERMISSION,
            ASHBY_CANDIDATE_LIST_ENDPOINT,
            ASHBY_MISSING_CANDIDATES_READ_MESSAGE,
            HTTP_STATUS_FORBIDDEN,
          );
        }
        if (apiKey !== GOOD_KEY) {
          throw new AshbyApiError(
            ASHBY_ERROR_KIND_INVALID_KEY,
            ASHBY_CANDIDATE_LIST_ENDPOINT,
            ASHBY_INVALID_API_KEY_MESSAGE,
            HTTP_STATUS_UNAUTHORIZED,
          );
        }

        return { /** @external ashby envelope success wire field */ success: true, results: [] };
      },
      write: async () => {
        throw new Error(MOCK_ASHBY_CLIENT_NOT_IMPLEMENTED_MESSAGE);
      },
      searchCandidates: async () => [],
      application: async () => null,
    });

  const app = Fastify();
  await app.register(ashbyIntegrationRoutes, { prefix: "/v1", dependencies: { createClient } });
  const auth = (user: { id: string; email: string; displayName: string }) => ({
    authorization: `Bearer ${signAuthToken({ sub: user.id, email: user.email, displayName: user.displayName, workspaceId: workspace.id, sessionVersion: 1 })}`,
  });

  return {
    app,
    admin,
    member,
    workspaceId: workspace.id,
    base: `/v1/workspaces/${workspace.id}/integrations/ashby`,
    auth,
  };
}

function isFakeAshbyClient(value: object): value is AshbyClient {
  return "call" in value && "write" in value;
}

function fakeAshbyClient(value: object): AshbyClient {
  assert.ok(isFakeAshbyClient(value));

  return value;
}

void test("only admins add the workspace key; it is checked and never sent back", async () => {
  const { app, admin, member, base, auth } = await setup();
  try {
    assert.equal(
      (await app.inject({ method: "PUT", url: base, headers: auth(member), payload: { apiKey: GOOD_KEY } })).statusCode,
      HTTP_STATUS_FORBIDDEN,
    );

    const badKey = await app.inject({
      method: "PUT",
      url: base,
      headers: auth(admin),
      payload: { apiKey: "wrong-key-123" },
    });
    assert.equal(badKey.statusCode, HTTP_STATUS_BAD_REQUEST);
    const badKeyBody = ashbyErrorResponseSchema.parse(badKey.json());
    assert.equal(badKeyBody.code, "ashby_invalid_key");

    const noPermission = await app.inject({
      method: "PUT",
      url: base,
      headers: auth(admin),
      payload: { apiKey: "no-candidates-key" },
    });
    const noPermissionBody = ashbyErrorResponseSchema.parse(noPermission.json());
    assert.equal(noPermissionBody.code, "ashby_missing_permission");

    const saved = await app.inject({ method: "PUT", url: base, headers: auth(admin), payload: { apiKey: GOOD_KEY } });
    assert.equal(saved.statusCode, HTTP_STATUS_OK);
    const savedBody = ashbyIntegrationStatusResponseSchema.parse(saved.json());
    assert.equal(savedBody.configured, true);
    assert.equal(savedBody.connected, true, "the admin who set it up is connected");

    const memberView = await app.inject({ method: "GET", url: base, headers: auth(member) });
    const memberViewBody = ashbyIntegrationStatusResponseSchema.parse(memberView.json());
    assert.equal(memberViewBody.configured, true);
    assert.equal(memberViewBody.canManage, false);
    assert.equal(memberViewBody.connected, false, "members opt in themselves");
    [saved, memberView].forEach((response) => {
      assert.ok(!response.body.includes(GOOD_KEY));
    });
  } finally {
    await app.close();
  }
});

void test("members connect and disconnect for themselves once Ashby is set up", async () => {
  const { app, admin, member, workspaceId, base, auth } = await setup();
  try {
    const early = await app.inject({ method: "POST", url: `${base}/connect`, headers: auth(member) });
    assert.equal(early.statusCode, HTTP_STATUS_CONFLICT);
    const earlyBody = ashbyErrorResponseSchema.parse(early.json());
    assert.equal(earlyBody.code, "ashby_not_configured");
    const memberStatusBeforeSetup = ashbyIntegrationStatusResponseSchema.parse(
      (await app.inject({ method: "GET", url: base, headers: auth(member) })).json(),
    );
    assert.deepEqual(memberStatusBeforeSetup.admins, [{ displayName: "Admin" }]);

    await app.inject({ method: "PUT", url: base, headers: auth(admin), payload: { apiKey: GOOD_KEY } });
    const connected = await app.inject({ method: "POST", url: `${base}/connect`, headers: auth(member) });
    const connectedBody = ashbyIntegrationStatusResponseSchema.parse(connected.json());
    assert.equal(connectedBody.connected, true);

    const disconnected = await app.inject({ method: "POST", url: `${base}/disconnect`, headers: auth(member) });
    const disconnectedBody = ashbyIntegrationStatusResponseSchema.parse(disconnected.json());
    assert.equal(disconnectedBody.connected, false);
    assert.equal(
      await isAshbyMemberConnected({ workspaceId, userId: admin.id }),
      true,
      "disconnecting only affects yourself",
    );
  } finally {
    await app.close();
  }
});

void test("removing the key turns Ashby off for everyone", async () => {
  const { app, admin, member, workspaceId, base, auth } = await setup();
  try {
    await app.inject({ method: "PUT", url: base, headers: auth(admin), payload: { apiKey: GOOD_KEY } });
    await app.inject({ method: "POST", url: `${base}/connect`, headers: auth(member) });
    assert.equal(
      (await app.inject({ method: HTTP_REMOVE_METHOD, url: base, headers: auth(member) })).statusCode,
      HTTP_STATUS_FORBIDDEN,
    );

    const removed = await app.inject({ method: HTTP_REMOVE_METHOD, url: base, headers: auth(admin) });
    const removedBody = ashbyIntegrationStatusResponseSchema.parse(removed.json());
    assert.equal(removedBody.configured, false);
    assert.equal(await isAshbyMemberConnected({ workspaceId, userId: member.id }), false);
    const memberStatusAfterRemoval = ashbyIntegrationStatusResponseSchema.parse(
      (await app.inject({ method: "GET", url: base, headers: auth(member) })).json(),
    );
    assert.equal(memberStatusAfterRemoval.connected, false);
  } finally {
    await app.close();
  }
});
