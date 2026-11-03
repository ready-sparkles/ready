import assert from "node:assert/strict";
import test from "node:test";

import { workspaceSettingsPermissions } from "../../domain/workspace-permissions";

void test("Settings capabilities follow Owner, Admin, and Member boundaries", () => {
  assert.deepEqual(workspaceSettingsPermissions({ role: "owner", status: "active" }), {
    canViewMembers: true,
    canManageWorkspace: true,
    canManageBilling: true,
    canDeleteWorkspace: true,
  });
  assert.deepEqual(workspaceSettingsPermissions({ role: "admin", status: "active" }), {
    canViewMembers: true,
    canManageWorkspace: true,
    canManageBilling: false,
    canDeleteWorkspace: false,
  });
  assert.deepEqual(workspaceSettingsPermissions({ role: "member", status: "active" }), {
    canViewMembers: true,
    canManageWorkspace: false,
    canManageBilling: false,
    canDeleteWorkspace: false,
  });
  assert.deepEqual(workspaceSettingsPermissions({ role: "owner", status: "suspended" }), {
    canViewMembers: false,
    canManageWorkspace: false,
    canManageBilling: false,
    canDeleteWorkspace: false,
  });
});
