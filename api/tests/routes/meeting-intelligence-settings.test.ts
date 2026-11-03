import "../../composition/env";

import { closeDbPool, db, ensureWorkspaceMembership, upsertUser } from "@readymeet/db";
import { workspaceSettingsResponseSchema } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { workspaceAdminRoutes } from "../../adapters/primary/http/routes/workspaces";
import { signAuthToken } from "../../adapters/primary/http/support/auth";

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
after(closeDbPool);
void test("workspace intelligence settings persist, are isolated, and only managers can change them", async (t) => {
  const owner = await upsertUser({ email: `${randomUUID()}@intelligence.test`, displayName: "Owner" });
  const member = await upsertUser({ email: `${randomUUID()}@intelligence.test`, displayName: "Member" });
  await ensureWorkspaceMembership({ workspaceId: owner.workspaceId, userId: member.id, role: "member" });
  await db.workspaces.update({ where: { id: owner.workspaceId }, data: { plan: "max" } });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(workspaceAdminRoutes);
  const headers = (user: typeof owner) => ({
    authorization: `Bearer ${signAuthToken({ sub: user.id, email: user.email, displayName: user.displayName, workspaceId: user.workspaceId, sessionVersion: 1 })}`,
  });
  const url = `/workspaces/${owner.workspaceId}/settings`;
  const update = await app.inject({
    method: "PATCH",
    url,
    headers: headers(owner),
    payload: { isLiveSummaryEnabled: false, isAmbientContextEnabled: false },
  });
  assert.equal(update.statusCode, HTTP_OK, update.body);
  const reload = await app.inject({ method: "GET", url, headers: headers(owner) });
  const settings = workspaceSettingsResponseSchema.parse(reload.json()).workspace;
  assert.equal(settings.isLiveSummaryEnabled, false);
  assert.equal(settings.isAmbientContextEnabled, false);
  assert.equal(
    (await db.workspaces.findUniqueOrThrow({ where: { id: member.workspaceId } })).isLiveSummaryEnabled,
    true,
  );
  const denied = await app.inject({
    method: "PATCH",
    url,
    headers: headers(member),
    payload: { isLiveSummaryEnabled: true },
  });
  assert.equal(denied.statusCode, HTTP_FORBIDDEN);
  assert.equal(
    (await db.workspaces.findUniqueOrThrow({ where: { id: owner.workspaceId } })).isLiveSummaryEnabled,
    false,
  );
});
