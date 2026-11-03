import assert from "node:assert/strict";
import test from "node:test";

import { getOAuthSignInHref } from "../../application/auth-client";

void test("Google Workspace add-on sign-in forces account selection and carries the account hint", () => {
  const href = getOAuthSignInHref(
    "google",
    "/login?source=google-workspace-addon&complete=1&accountId=account-1&callbackUrl=%2Fworkspace",
    {
      /** @external OAuth sign-in option field */
      forceAccountSelection: true,
      googleAddonHandoffToken: "header.payload.signature",
      loginHint: "reviewer+ready@example.com",
    },
  );
  const url = new URL(href, "https://ready.app");

  assert.equal(url.pathname, "/api/auth/start/google");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("loginHint"), "reviewer+ready@example.com");
  assert.equal(url.searchParams.get("googleAddonHandoffToken"), "header.payload.signature");
  assert.equal(
    url.searchParams.get("callbackUrl"),
    "/login?source=google-workspace-addon&complete=1&accountId=account-1&callbackUrl=%2Fworkspace",
  );
});

void test("regular and Microsoft sign-in links do not receive Google authorization parameters", () => {
  assert.equal(getOAuthSignInHref("google", "/workspace"), "/api/auth/start/google?callbackUrl=%2Fworkspace");
  assert.equal(
    getOAuthSignInHref("microsoft-entra-id", "/workspace", {
      /** @external OAuth sign-in option field */
      forceAccountSelection: true,
      googleAddonHandoffToken: "header.payload.signature",
      loginHint: "person@example.com",
    }),
    "/api/auth/start/microsoft-entra-id?callbackUrl=%2Fworkspace",
  );
});
