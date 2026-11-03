import { closeDbPool, upsertUser } from "@readymeet/db";
import Fastify from "fastify";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { z } from "zod";

import { apiErrorResponse } from "../../../../../adapters/primary/http/error-handler";
import { adminRoutes } from "../../../../../adapters/primary/http/routes/admin";
import { signAuthToken } from "../../../../../adapters/primary/http/support/auth";
import { apiEnv } from "../../../../../composition/env";
import { apiEnvSchema } from "../../../../../ports/env-schema";

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const ADMIN_EMAIL = "admin@example.com";
const AI_USAGE_PATHS = ["/v1/admin/ai-usage/summary", "/v1/admin/ai-usage/events"];
const messageSchema = z.object({ message: z.string() });

after(closeDbPool);

void test("admin AI usage enforces configured access and validates date filters", async (t) => {
  const originalAdminEmail = apiEnv.ADMIN_EMAIL;
  t.after(() => {
    apiEnv.ADMIN_EMAIL = originalAdminEmail;
  });
  apiEnv.ADMIN_EMAIL = apiEnvSchema.shape.ADMIN_EMAIL.parse("ops@example.com, Admin@Example.Com ");
  const admin = await upsertUser({ email: ADMIN_EMAIL, displayName: "Admin", source: "auth" });
  const token = signAuthToken({
    sub: admin.id,
    email: admin.email,
    displayName: admin.displayName,
    workspaceId: admin.workspaceId,
  });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => apiErrorResponse({ error, request, reply }));
  await app.register(adminRoutes, { prefix: "/v1" });
  const get = async (url: string) => app.inject({ url, headers: { authorization: `Bearer ${token}` } });
  try {
    assert.equal((await app.inject({ url: AI_USAGE_PATHS[0] })).statusCode, HTTP_UNAUTHORIZED);
    const results = await Promise.all(
      AI_USAGE_PATHS.map(async (path) => ({
        badDate: await get(`${path}?startDate=yesterday`),
        badLimit: await get(`${path}?limit=-3`),
        good: await get(`${path}?startDate=2026-01-01T00:00:00.000Z&endDate=2026-12-31T00:00:00.000Z`),
      })),
    );
    results.forEach(({ badDate, badLimit, good }) => {
      assert.equal(badDate.statusCode, HTTP_BAD_REQUEST, badDate.body);
      assert.match(messageSchema.parse(badDate.json()).message, /Invalid AI usage filters/);
      assert.equal(badLimit.statusCode, HTTP_BAD_REQUEST);
      assert.equal(good.statusCode, HTTP_OK, good.body);
    });
    Object.assign(apiEnv, { ADMIN_EMAIL: apiEnvSchema.shape.ADMIN_EMAIL.parse("other@example.com") });
    const nonAdminResults = await Promise.all(AI_USAGE_PATHS.map(get));
    nonAdminResults.forEach((result) => {
      assert.equal(result.statusCode, HTTP_FORBIDDEN);
    });

    // Unset falls back to the default admin only, so this caller is still refused.
    Object.assign(apiEnv, { ADMIN_EMAIL: apiEnvSchema.shape.ADMIN_EMAIL.parse(undefined) });
    const defaultAdminResults = await Promise.all(AI_USAGE_PATHS.map(get));
    defaultAdminResults.forEach((result) => {
      assert.equal(result.statusCode, HTTP_FORBIDDEN);
    });
  } finally {
    await app.close();
  }
});
