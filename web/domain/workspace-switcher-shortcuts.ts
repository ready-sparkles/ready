export const WORKSPACE_SEQUENCE_SHORTCUT_TIMEOUT_MS = 1200;

export type WorkspaceShortcutPrefix = { key: "g" | "o"; expiresAt: number } | null;

type WorkspaceShortcutAction =
  | { type: "open-settings" }
  | { type: "open-workspace-switcher" }
  | { type: "switch-workspace"; index: number }
  | { type: "none" };

export function canShowWorkspaceSwitcherMenu(input: {
  isSignedIn: boolean;
  userSource: string | null | undefined;
  workspaceCount: number | null | undefined;
}): boolean {
  if (!input.isSignedIn || input.userSource === "guest") {
    return false;
  }

  // Keep the menu visible even with zero or one loaded workspace so the
  // create/join workspace action stays discoverable.
  return true;
}

/**
 * Pure chord/digit resolution for the workspace shell shortcuts:
 * G-then-S opens settings, O-then-W opens the workspace switcher, and digits
 * 1–9 pick a workspace by position while the switcher is open. The caller is
 * responsible for filtering modifier keys and editable targets first.
 */
export function resolveWorkspaceShortcut(input: {
  /** The pressed key (event.key); matching is case-insensitive. */
  key: string;
  now: number;
  prefix: WorkspaceShortcutPrefix;
  isSwitcherOpen: boolean;
  timeoutMs?: number;
}): { action: WorkspaceShortcutAction; prefix: WorkspaceShortcutPrefix } {
  const key = input.key.toLowerCase();
  const timeoutMs = input.timeoutMs ?? WORKSPACE_SEQUENCE_SHORTCUT_TIMEOUT_MS;

  if (input.isSwitcherOpen && /^[1-9]$/.test(key)) {
    return {
      action: { type: "switch-workspace", index: Number(key) - 1 },
      prefix: null,
    };
  }

  const activePrefix = input.prefix && input.prefix.expiresAt > input.now ? input.prefix : null;
  if (activePrefix?.key === "g" && key === "s") {
    return { action: { type: "open-settings" }, prefix: null };
  }
  if (activePrefix?.key === "o" && key === "w") {
    return { action: { type: "open-workspace-switcher" }, prefix: null };
  }

  if (key === "g" || key === "o") {
    return {
      action: { type: "none" },
      prefix: { key, expiresAt: input.now + timeoutMs },
    };
  }

  return { action: { type: "none" }, prefix: null };
}

/**
 * Global Shift+1 through Shift+9 workspace switching. Matches on event.code because
 * Shift+digit produces punctuation in event.key ('!', '@', etc.) that varies by
 * keyboard layout. Returns the zero-based workspace index, or null when the
 * event is not this hotkey. The caller is responsible for skipping editable
 * targets and meeting-room surfaces.
 */
export function resolveWorkspaceSwitchHotkey(
  input: Pick<KeyboardEvent, "code" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
): number | null {
  if (!input.shiftKey || input.metaKey || input.ctrlKey || input.altKey) {
    return null;
  }
  const match = /^Digit([1-9])$/.exec(input.code);

  return match ? Number(match[1]) - 1 : null;
}

export function canUseWorkspaceSwitchHotkeyOnPath(pathname: string | null): boolean {
  if (pathname === null || pathname === "") {
    return false;
  }

  return !/^\/meetings\/[^/]+\/live\/?$/.test(pathname);
}
