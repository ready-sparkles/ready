import assert from "node:assert/strict";
import test from "node:test";

import { getMyWorkspace, onSuspendedWorkspace } from "../application/api";

const HTTP_FORBIDDEN = 403;
const SESSION_TOKEN = "session-token";
const WORKSPACE_SUSPENDED_CODE = "workspace_suspended";
const SUSPENDED_MESSAGE = "Your access to this workspace is suspended. Contact a workspace admin.";
const MANAGER_REQUIRED_MESSAGE = "Workspace manager access required";

function recordSuspendedWorkspaceTokens(t: test.TestContext): { tokens: string[] } {
  const notified: { tokens: string[] } = { tokens: [] };
  const unsubscribe = onSuspendedWorkspace((token) => {
    notified.tokens = [...notified.tokens, token];
  });
  t.after(unsubscribe);

  return notified;
}

void test("a workspace_suspended 403 notifies listeners with the rejected token and still rejects", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: WORKSPACE_SUSPENDED_CODE, message: SUSPENDED_MESSAGE }, { status: HTTP_FORBIDDEN }),
  );
  const notified = recordSuspendedWorkspaceTokens(t);

  await assert.rejects(() => getMyWorkspace(SESSION_TOKEN), /suspended/);
  assert.deepEqual(notified.tokens, [SESSION_TOKEN]);
});

void test("other 403 responses do not trigger workspace re-resolution", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: MANAGER_REQUIRED_MESSAGE }, { status: HTTP_FORBIDDEN }),
  );
  const notified = recordSuspendedWorkspaceTokens(t);

  await assert.rejects(() => getMyWorkspace(SESSION_TOKEN));
  assert.deepEqual(notified.tokens, []);
});
