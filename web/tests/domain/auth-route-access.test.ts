import { userSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { canAccessAuthenticatedRoute } from "../../domain/auth-route-access";
import type { AuthSession } from "../../domain/types";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const AUTH_USER_ID = "00000000-0000-4000-8000-000000000002";
const GUEST_USER_ID = "00000000-0000-4000-8000-000000000003";

function makeSession(source: AuthSession["user"]["source"]): AuthSession {
  return {
    token: `${source}-token`,
    user: userSchema.parse({
      id: source === "guest" ? GUEST_USER_ID : AUTH_USER_ID,
      email: `${source}@example.com`,
      displayName: source,
      avatarUrl: null,
      source,
      workspaceId: WORKSPACE_ID,
      createdAt: "2026-01-01T00:00:00Z",
    }),
  };
}

void test("protected account routes reject missing and guest sessions", () => {
  assert.equal(canAccessAuthenticatedRoute({ session: null }), false);
  assert.equal(canAccessAuthenticatedRoute({ session: makeSession("guest") }), false);
  assert.equal(canAccessAuthenticatedRoute({ session: makeSession("auth") }), true);
});

void test("meeting routes can explicitly allow guest sessions", () => {
  assert.equal(canAccessAuthenticatedRoute({ session: makeSession("guest"), shouldAllowGuest: true }), true);
});
