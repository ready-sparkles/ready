const WORKSPACE_FALLBACK_LOCATION = "/workspace";

function isValidLocation(location: string | null): location is string {
  if (location === null || location === "" || !/^\/workspace(?:[/?#]|$)/.test(location) || /[\\\r\n]/.test(location)) {
    return false;
  }
  const path = new URL(location, "https://ready.app").pathname;

  return (
    (path === "/workspace" || path.startsWith("/workspace/")) &&
    path !== "/workspace/settings" &&
    !path.startsWith("/workspace/settings/")
  );
}

function buildStorageKey(input: { userId: string; workspaceId: string }): string {
  return `readymeet-workspace-return:${input.userId}:${input.workspaceId}`;
}

export function rememberWorkspaceLocation(input: {
  storage: Pick<Storage, "getItem" | "setItem">;
  userId: string;
  workspaceId: string;
  location: string;
}): void {
  if (!isValidLocation(input.location)) {
    return;
  }
  try {
    input.storage.setItem(buildStorageKey({ userId: input.userId, workspaceId: input.workspaceId }), input.location);
  } catch (error) {
    if (error instanceof Error) {
      // Navigation remains available when browser storage is blocked.
    }
  }
}

export function readWorkspaceReturnLocation(input: {
  storage: Pick<Storage, "getItem" | "setItem">;
  userId: string;
  workspaceId: string;
}): string {
  try {
    const location = input.storage.getItem(buildStorageKey({ userId: input.userId, workspaceId: input.workspaceId }));

    return isValidLocation(location) ? location : WORKSPACE_FALLBACK_LOCATION;
  } catch (error) {
    if (error instanceof Error) {
      return WORKSPACE_FALLBACK_LOCATION;
    }

    throw error;
  }
}
