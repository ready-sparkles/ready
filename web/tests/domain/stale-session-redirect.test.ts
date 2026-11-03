import assert from "node:assert/strict";
import test from "node:test";

import { isCurrentSessionToken, staleSessionLoginUrl } from "../../domain/stale-session-redirect";

void test("stale session returns to the current page after login", () => {
  assert.equal(
    staleSessionLoginUrl({ pathname: "/workspace/tasks/mine", search: "?q=a" }),
    "/login?callbackUrl=%2Fworkspace%2Ftasks%2Fmine%3Fq%3Da",
  );
});

void test("stale session on root or login goes to plain login", () => {
  assert.equal(staleSessionLoginUrl({ pathname: "/", search: "" }), "/login");
  assert.equal(staleSessionLoginUrl({ pathname: "/login", search: "?callbackUrl=%2Fx" }), "/login");
});

void test("only the tab's current token counts as stale", () => {
  assert.equal(isCurrentSessionToken({ rejectedToken: "a", sessionToken: "a" }), true);
  assert.equal(isCurrentSessionToken({ rejectedToken: "old", sessionToken: "new" }), false);
  assert.equal(isCurrentSessionToken({ rejectedToken: "a", sessionToken: null }), false);
});
