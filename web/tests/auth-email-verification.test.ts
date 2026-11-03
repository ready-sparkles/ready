import assert from "node:assert/strict";
import test from "node:test";

import { authConfig } from "../auth";

void test("Google sign-in requires a verified provider email claim", async () => {
  const input = {
    user: { id: "subject", email: "person@example.test" },
    account: { provider: "google", providerAccountId: "subject", type: "oidc" as const },
  };
  assert.equal(await authConfig.callbacks.signIn(input), false);
  assert.equal(await authConfig.callbacks.signIn({ ...input, profile: { email_verified: false } }), false);
  assert.equal(await authConfig.callbacks.signIn({ ...input, profile: { email_verified: true } }), true);
});
