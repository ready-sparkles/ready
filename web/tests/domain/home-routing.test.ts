import assert from "node:assert/strict";
import test from "node:test";

import { shouldRedirectHomeToWorkspace } from "../../domain/home-routing";

void test("root redirects when the server session has a valid Ready app session", () => {
  assert.equal(
    shouldRedirectHomeToWorkspace({
      session: { apiToken: "ready-token", appUser: { id: "user-1" } },
    }),
    true,
  );
});

void test("root stays public for missing or incomplete sessions", () => {
  assert.equal(shouldRedirectHomeToWorkspace({ session: null }), false);
  assert.equal(shouldRedirectHomeToWorkspace({ session: { apiToken: "", appUser: { id: "user-1" } } }), false);
  assert.equal(shouldRedirectHomeToWorkspace({ session: { apiToken: "ready-token" } }), false);
});

void test("root stays public when the auth cookie exists but app auth failed", () => {
  assert.equal(
    shouldRedirectHomeToWorkspace({
      session: { apiToken: "ready-token", appUser: { id: "user-1" }, authError: "missing_app_auth" },
    }),
    false,
  );
});

void test("an explicit homepage visit stays public even when signed in", () => {
  assert.equal(
    shouldRedirectHomeToWorkspace({
      session: { apiToken: "ready-token", appUser: { id: "user-1" } },
      showPublicHome: true,
    }),
    false,
  );
});
