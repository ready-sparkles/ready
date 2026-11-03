import { userSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { canShowMemoryNavigation } from "../../domain/memory-navigation";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "memory@example.com",
  displayName: "Memory Test",
  avatarUrl: null,
  source: "auth" as const,
  workspaceId: "00000000-0000-4000-8000-000000000002",
  createdAt: "2026-10-01T00:00:00.000Z",
};

void test("session capability survives parsing and shows navigation before status loads", () => {
  const sessionUser = userSchema.parse({ ...user, /** @external user session wire field */ memoryAvailable: true });
  assert.equal(canShowMemoryNavigation({ user: sessionUser }), true);
  assert.equal(
    canShowMemoryNavigation({
      user: userSchema.parse({ ...user, /** @external user session wire field */ memoryAvailable: false }),
    }),
    false,
  );
});

void test("older sessions remain valid and fall back to the status response", () => {
  const sessionUser = userSchema.parse(user);
  assert.equal(sessionUser.memoryAvailable, undefined);
  assert.equal(canShowMemoryNavigation({ user: sessionUser }), false);
  assert.equal(canShowMemoryNavigation({ user: sessionUser, isStatusAvailable: true }), true);
});

void test("current status overrides the session capability in either direction", () => {
  assert.equal(
    canShowMemoryNavigation({
      user: { ...user, /** @external user session wire field */ memoryAvailable: true },
      isStatusAvailable: false,
    }),
    false,
  );
  assert.equal(
    canShowMemoryNavigation({
      user: { ...user, /** @external user session wire field */ memoryAvailable: false },
      isStatusAvailable: true,
    }),
    true,
  );
});

void test("guests, missing sessions, and missing workspaces never show Memory navigation", () => {
  assert.equal(
    canShowMemoryNavigation({
      user: { ...user, source: "guest", /** @external user session wire field */ memoryAvailable: true },
      isStatusAvailable: true,
    }),
    false,
  );
  assert.equal(canShowMemoryNavigation({ user: null, isStatusAvailable: true }), false);
  assert.equal(
    canShowMemoryNavigation({
      user: { ...user, workspaceId: "", /** @external user session wire field */ memoryAvailable: true },
      isStatusAvailable: true,
    }),
    false,
  );
});
