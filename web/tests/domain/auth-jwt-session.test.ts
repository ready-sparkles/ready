import assert from "node:assert/strict";
import test from "node:test";

import { oauthExchangeEmail, shouldReuseCachedApiSession } from "../../domain/auth-jwt-session";

function unsignedToken(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

void test("cached Ready session is reused when no new OAuth account is present", () => {
  assert.equal(
    shouldReuseCachedApiSession({
      apiToken: unsignedToken({ sub: "ready-user-old" }),
      existingUserId: "ready-user-old",
      existingWorkspaceId: "workspace-old",
      hasFreshOAuthAccount: false,
      shouldRefreshApiToken: false,
    }),
    true,
  );
});

void test("switching Google accounts replaces an existing cached Ready session", () => {
  const cachedApiToken = unsignedToken({ sub: "ready-user-old" });

  assert.equal(
    shouldReuseCachedApiSession({
      apiToken: cachedApiToken,
      existingUserId: "ready-user-old",
      existingWorkspaceId: "workspace-old",
      hasFreshOAuthAccount: true,
      shouldRefreshApiToken: false,
    }),
    false,
  );
  assert.equal(
    oauthExchangeEmail({
      hasFreshOAuthAccount: true,
      tokenEmail: "old-google-account@example.com",
      userEmail: "new-google-account@example.com",
    }),
    "new-google-account@example.com",
  );
});
