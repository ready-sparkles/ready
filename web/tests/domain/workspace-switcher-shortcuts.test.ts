import assert from "node:assert/strict";
import test from "node:test";

import {
  canShowWorkspaceSwitcherMenu,
  canUseWorkspaceSwitchHotkeyOnPath,
  resolveWorkspaceShortcut,
  resolveWorkspaceSwitchHotkey,
  WORKSPACE_SEQUENCE_SHORTCUT_TIMEOUT_MS,
  type WorkspaceShortcutPrefix,
} from "../../domain/workspace-switcher-shortcuts";

const NOW = 1_000_000;

const CODE_DIGIT_0 = "Digit0";
const CODE_DIGIT_1 = "Digit1";
const CODE_DIGIT_9 = "Digit9";
const CODE_KEY_A = "KeyA";

function prefix(input: { key: "g" | "o"; expiresInMs?: number }): WorkspaceShortcutPrefix {
  return {
    key: input.key,
    expiresAt: NOW + (input.expiresInMs ?? WORKSPACE_SEQUENCE_SHORTCUT_TIMEOUT_MS),
  };
}

function keyboardModifiers(input: {
  isShiftKey?: boolean;
  isMetaKey?: boolean;
  isCtrlKey?: boolean;
  isAltKey?: boolean;
}) {
  return {
    /** @external KeyboardEvent modifier wire field */
    shiftKey: input.isShiftKey ?? false,
    /** @external KeyboardEvent modifier wire field */
    metaKey: input.isMetaKey ?? false,
    /** @external KeyboardEvent modifier wire field */
    ctrlKey: input.isCtrlKey ?? false,
    /** @external KeyboardEvent modifier wire field */
    altKey: input.isAltKey ?? false,
  };
}

const TEST_VALUE_100 = 100;
const TEST_VALUE_2 = 2;
const TEST_VALUE_8 = 8;
void test("g then s opens settings", () => {
  const first = resolveWorkspaceShortcut({ key: "g", now: NOW, prefix: null, isSwitcherOpen: false });
  assert.deepEqual(first.action, { type: "none" });
  assert.deepEqual(first.prefix, { key: "g", expiresAt: NOW + WORKSPACE_SEQUENCE_SHORTCUT_TIMEOUT_MS });

  const second = resolveWorkspaceShortcut({
    key: "s",
    now: NOW + TEST_VALUE_100,
    prefix: first.prefix,
    isSwitcherOpen: false,
  });
  assert.deepEqual(second.action, { type: "open-settings" });
  assert.equal(second.prefix, null);
});

void test("o then w opens the workspace switcher", () => {
  const first = resolveWorkspaceShortcut({ key: "o", now: NOW, prefix: null, isSwitcherOpen: false });
  assert.deepEqual(first.action, { type: "none" });
  assert.deepEqual(first.prefix, { key: "o", expiresAt: NOW + WORKSPACE_SEQUENCE_SHORTCUT_TIMEOUT_MS });

  const second = resolveWorkspaceShortcut({
    key: "w",
    now: NOW + TEST_VALUE_100,
    prefix: first.prefix,
    isSwitcherOpen: false,
  });
  assert.deepEqual(second.action, { type: "open-workspace-switcher" });
  assert.equal(second.prefix, null);
});

void test("workspace switcher menu stays visible for signed-in users with one workspace", () => {
  assert.equal(
    canShowWorkspaceSwitcherMenu({
      isSignedIn: true,
      userSource: "user",
      workspaceCount: 1,
    }),
    true,
  );
  assert.equal(
    canShowWorkspaceSwitcherMenu({
      isSignedIn: true,
      userSource: "user",
      workspaceCount: 0,
    }),
    true,
  );
  assert.equal(
    canShowWorkspaceSwitcherMenu({
      isSignedIn: false,
      userSource: null,
      workspaceCount: 1,
    }),
    false,
  );
  assert.equal(
    canShowWorkspaceSwitcherMenu({
      isSignedIn: true,
      userSource: "guest",
      workspaceCount: 1,
    }),
    false,
  );
});

void test("chord matching is case-insensitive", () => {
  const first = resolveWorkspaceShortcut({ key: "O", now: NOW, prefix: null, isSwitcherOpen: false });
  const second = resolveWorkspaceShortcut({
    key: "W",
    now: NOW + TEST_VALUE_100,
    prefix: first.prefix,
    isSwitcherOpen: false,
  });
  assert.deepEqual(second.action, { type: "open-workspace-switcher" });
});

void test("an expired prefix does not complete a chord", () => {
  const result = resolveWorkspaceShortcut({
    key: "w",
    now: NOW + WORKSPACE_SEQUENCE_SHORTCUT_TIMEOUT_MS + 1,
    prefix: prefix({ key: "o" }),
    isSwitcherOpen: false,
  });
  assert.deepEqual(result.action, { type: "none" });
  assert.equal(result.prefix, null);
});

void test("mismatched chord second keys reset the prefix", () => {
  const result = resolveWorkspaceShortcut({ key: "s", now: NOW, prefix: prefix({ key: "o" }), isSwitcherOpen: false });
  assert.deepEqual(result.action, { type: "none" });
  assert.equal(result.prefix, null);
});

void test("starting a new chord replaces the previous prefix", () => {
  const result = resolveWorkspaceShortcut({ key: "o", now: NOW, prefix: prefix({ key: "g" }), isSwitcherOpen: false });
  assert.deepEqual(result.action, { type: "none" });
  assert.deepEqual(result.prefix, { key: "o", expiresAt: NOW + WORKSPACE_SEQUENCE_SHORTCUT_TIMEOUT_MS });
});

void test("digits 1-9 pick a workspace only while the switcher is open", () => {
  const open = resolveWorkspaceShortcut({ key: "3", now: NOW, prefix: null, isSwitcherOpen: true });
  assert.deepEqual(open.action, { type: "switch-workspace", index: TEST_VALUE_2 });
  assert.equal(open.prefix, null);

  const closed = resolveWorkspaceShortcut({ key: "3", now: NOW, prefix: null, isSwitcherOpen: false });
  assert.deepEqual(closed.action, { type: "none" });
});

void test("zero and non-digit keys never switch workspaces", () => {
  ["0", "10", "Enter", "ArrowDown"].forEach((key) => {
    const result = resolveWorkspaceShortcut({ key, now: NOW, prefix: null, isSwitcherOpen: true });
    assert.deepEqual(result.action, { type: "none" });
  });
});

void test("digits win over a pending chord while the switcher is open", () => {
  const result = resolveWorkspaceShortcut({ key: "1", now: NOW, prefix: prefix({ key: "o" }), isSwitcherOpen: true });
  assert.deepEqual(result.action, { type: "switch-workspace", index: 0 });
  assert.equal(result.prefix, null);
});

void test("shift+digit resolves the workspace index from event.code", () => {
  const base = keyboardModifiers({ isShiftKey: true });
  assert.equal(resolveWorkspaceSwitchHotkey({ ...base, code: CODE_DIGIT_1 }), 0);
  assert.equal(resolveWorkspaceSwitchHotkey({ ...base, code: CODE_DIGIT_9 }), TEST_VALUE_8);
  assert.equal(resolveWorkspaceSwitchHotkey({ ...base, code: CODE_DIGIT_0 }), null);
  assert.equal(resolveWorkspaceSwitchHotkey({ ...base, code: CODE_KEY_A }), null);
});

void test("the switch hotkey requires shift alone with no other modifiers and no bare digits", () => {
  const base = { code: CODE_DIGIT_1, ...keyboardModifiers({ isShiftKey: true }) };
  assert.equal(resolveWorkspaceSwitchHotkey({ ...base, ...keyboardModifiers({ isShiftKey: false }) }), null);
  assert.equal(
    resolveWorkspaceSwitchHotkey({ ...base, ...keyboardModifiers({ isShiftKey: true, isMetaKey: true }) }),
    null,
  );
  assert.equal(
    resolveWorkspaceSwitchHotkey({ ...base, ...keyboardModifiers({ isShiftKey: true, isCtrlKey: true }) }),
    null,
  );
  assert.equal(
    resolveWorkspaceSwitchHotkey({ ...base, ...keyboardModifiers({ isShiftKey: true, isAltKey: true }) }),
    null,
  );
});

void test("global switch hotkeys are disabled on authenticated live meeting routes only", () => {
  assert.equal(canUseWorkspaceSwitchHotkeyOnPath("/workspace"), true);
  assert.equal(canUseWorkspaceSwitchHotkeyOnPath("/workspace/settings"), true);
  assert.equal(canUseWorkspaceSwitchHotkeyOnPath("/admin"), true);
  assert.equal(canUseWorkspaceSwitchHotkeyOnPath("/meetings/abc/live"), false);
  assert.equal(canUseWorkspaceSwitchHotkeyOnPath("/meetings/abc"), true);
  assert.equal(canUseWorkspaceSwitchHotkeyOnPath(null), false);
});
