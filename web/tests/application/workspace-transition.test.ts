import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import test from "node:test";

import {
  clearWorkspaceNotesRevealPending,
  getWorkspaceSwitchNavigationTarget,
  hasWorkspaceNotesRevealPending,
  markWorkspaceNotesRevealPending,
  WORKSPACE_END_MEETING_TRANSITION_KEY,
} from "../../application/workspace-transition";

GlobalRegistrator.register();

void test("workspace-scoped routes switch in place to preserve the navigation rail", () => {
  [
    "/workspace",
    "/workspace/",
    "/workspace/settings",
    "/workspace/tasks/mine",
    "/workspace/tasks/others",
    "/workspace/tasks/done",
  ].forEach((pathname) => {
    assert.equal(getWorkspaceSwitchNavigationTarget(pathname), null, pathname);
  });
});

void test("resource and non-workspace routes return to the workspace root", () => {
  [null, "/workspace/new", "/workspace/meeting-id", "/admin"].forEach((pathname) => {
    assert.equal(getWorkspaceSwitchNavigationTarget(pathname), "/workspace", pathname ?? "null");
  });
});

void test("notes reveal handoff survives shell transition cleanup and stays meeting scoped", () => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem(WORKSPACE_END_MEETING_TRANSITION_KEY, "1");
  markWorkspaceNotesRevealPending("meeting-one");

  window.sessionStorage.removeItem(WORKSPACE_END_MEETING_TRANSITION_KEY);

  assert.equal(hasWorkspaceNotesRevealPending("meeting-one"), true);
  assert.equal(hasWorkspaceNotesRevealPending("meeting-two"), false);

  clearWorkspaceNotesRevealPending("meeting-two");
  assert.equal(hasWorkspaceNotesRevealPending("meeting-one"), true);

  clearWorkspaceNotesRevealPending("meeting-one");
  assert.equal(hasWorkspaceNotesRevealPending("meeting-one"), false);
  window.sessionStorage.clear();
});
