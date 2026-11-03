import "../composition/env";

import assert from "node:assert/strict";
import test from "node:test";

import {
  signAuthToken,
  signGoogleAddonWebHandoff,
  signOAuthState,
  verifyAuthToken,
  verifyOAuthState,
} from "../adapters/primary/http/support/auth";

const STATE = {
  sub: "94e9d223-9361-49e4-925e-8756e2116084",
  email: "reviewer@example.com",
  displayName: "Reviewer",
  returnTo: "/settings",
};

void test("OAuth state tokens round-trip for their own provider", () => {
  const token = signOAuthState({ provider: "slack", state: STATE });
  const verified = verifyOAuthState({ provider: "slack", token });

  assert.ok(typeof verified === "object" && verified !== null);
  assert.equal("sub" in verified ? verified.sub : undefined, STATE.sub);
  assert.equal("returnTo" in verified ? verified.returnTo : undefined, STATE.returnTo);
  assert.equal("aud" in verified ? verified.aud : undefined, "ready-oauth-state:slack");
});

void test("OAuth state tokens are rejected as session bearer tokens", () => {
  (["slack", "linear", "calendar"] as const).forEach((provider) => {
    const token = signOAuthState({ provider, state: STATE });
    assert.throws(() => verifyAuthToken(token));
  });
});

void test("OAuth state tokens cannot be replayed against another provider", () => {
  const token = signOAuthState({ provider: "slack", state: STATE });

  assert.throws(() => verifyOAuthState({ provider: "linear", token }));
  assert.throws(() => verifyOAuthState({ provider: "calendar", token }));
});

void test("Session tokens are not accepted as OAuth state", () => {
  const session = signAuthToken({ sub: STATE.sub, email: STATE.email, displayName: STATE.displayName });

  assert.equal(verifyAuthToken(session).sub, STATE.sub);
  assert.throws(() => verifyOAuthState({ provider: "calendar", token: session }));
});

void test("Google add-on handoff tokens are rejected as session bearer tokens", () => {
  const handoff = signGoogleAddonWebHandoff({
    handoffId: "86f3cce4-556d-4a8c-9897-d3f806eac0ac",
    readyUserId: STATE.sub,
    googleSubject: "google-subject-123",
    email: STATE.email,
  });

  assert.throws(() => verifyAuthToken(handoff));
});
