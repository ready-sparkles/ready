import "../../composition/env";

import { closeDbPool, db } from "@readymeet/db";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { z } from "zod";

import { workspaceAdminRoutes } from "../../adapters/primary/http/routes/workspaces";
import { signAuthToken } from "../../adapters/primary/http/support/auth";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const WORKSPACE_SUSPENDED_CODE = "workspace_suspended";

const myWorkspaceSchema = z.object({
  workspace: z.object({ id: z.string(), role: z.string(), status: z.string() }),
});
const errorCodeSchema = z.object({ code: z.string() });

after(closeDbPool);

void test(
  "a signed-in user suspended from their only workspace is re-resolved to an owned replacement",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const email = `${userId}@suspended-active-workspace.test`;
    const app = Fastify();
    await app.register(workspaceAdminRoutes);
    try {
      await db.users.create({ data: { id: userId, email, displayName: "Fixture" } });
      await db.workspaces.create({
        data: { id: workspaceId, name: "Fixture", createdByUserId: userId, createdVia: "system_default" },
      });
      await db.workspaceMemberships.create({ data: { userId, workspaceId, role: "owner" } });
      await db.users.updateMany({ where: { id: userId }, data: { activeWorkspaceId: workspaceId } });
      const headers = {
        authorization: `Bearer ${signAuthToken({ sub: userId, email, displayName: "Fixture", workspaceId, sessionVersion: 1 })}`,
      };

      // Warm the short-lived active-workspace resolution while the membership is active.
      const before = await app.inject({ method: "GET", url: "/me/workspace", headers });
      assert.equal(before.statusCode, HTTP_STATUS_OK);
      assert.equal(myWorkspaceSchema.parse(before.json()).workspace.id, workspaceId);

      await db.workspaceMemberships.updateMany({
        where: { workspaceId, userId },
        data: { role: "member", status: "suspended", suspendedAt: new Date() },
      });

      const denied = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/settings`, headers });
      assert.equal(denied.statusCode, HTTP_STATUS_FORBIDDEN);
      assert.equal(errorCodeSchema.parse(denied.json()).code, WORKSPACE_SUSPENDED_CODE);

      // The next request with the same token must not reuse the suspended workspace.
      const afterSuspension = await app.inject({ method: "GET", url: "/me/workspace", headers });
      assert.equal(afterSuspension.statusCode, HTTP_STATUS_OK);
      const resolved = myWorkspaceSchema.parse(afterSuspension.json()).workspace;
      assert.notEqual(resolved.id, workspaceId);
      assert.equal(resolved.role, "owner");
      assert.equal(resolved.status, "active");
    } finally {
      await app.close();
      await db.users.updateMany({ where: { id: userId }, data: { activeWorkspaceId: null } });
      await db.workspaceMemberships.deleteMany({ where: { userId } });
      await db.workspaces.deleteMany({ where: { createdByUserId: userId } });
      await db.users.deleteMany({ where: { id: userId } });
    }
  },
);
