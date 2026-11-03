import { userSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { authConfig } from "../auth";

const HTTP_STATUS_UNAUTHORIZED = 401;

const user = userSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  email: "test@example.com",
  displayName: "Test",
  avatarUrl: null,
  workspaceId: "22222222-2222-4222-8222-222222222222",
  createdAt: "2026-01-01T00:00:00Z",
});
const apiToken = `header.${Buffer.from(JSON.stringify({ sub: user.id })).toString("base64url")}.signature`;

const registerAuthProviderRevocationTests = (provider: "google" | "microsoft-entra-id" | "dev-login") => {
  void test(`cached ${provider} sessions refresh only through validated API auth`, async (t) => {
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      assert.ok(String(url).endsWith("/v1/auth/me"));
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${apiToken}`);

      return Response.json({ token: apiToken, user });
    });
    const token = {
      apiToken,
      appUser: user,
      email: user.email,
      apiAuthProvider: provider,
      oauthProvider: provider === "dev-login" ? undefined : provider,
    };
    await authConfig.callbacks.jwt({
      token,
      user: { id: user.id },
      account: null,
      trigger: "update",
      session: {
        /** @external NextAuth session update contract */
        refreshApiToken: true,
      },
    });
  });

  void test(`revoked ${provider} sessions cannot re-exchange saved identity`, async (t) => {
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
      assert.ok(String(url).endsWith("/v1/auth/me"));

      return new Response("Invalid token", { status: HTTP_STATUS_UNAUTHORIZED });
    });
    const token = {
      apiToken,
      appUser: user,
      email: user.email,
      apiAuthProvider: provider,
      oauthProvider: provider === "dev-login" ? undefined : provider,
    };
    await assert.rejects(
      authConfig.callbacks.jwt({
        token,
        user: { id: user.id },
        account: null,
        trigger: "update",
        session: {
          /** @external NextAuth session update contract */
          refreshApiToken: true,
        },
      }),
      /Session refresh failed/,
    );
  });
};

registerAuthProviderRevocationTests("google");
registerAuthProviderRevocationTests("microsoft-entra-id");
registerAuthProviderRevocationTests("dev-login");
