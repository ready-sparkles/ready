import type { Meeting } from "@readymeet/shared";

// Keyed by user AND workspace so switching the active workspace never bleeds
// another workspace's meeting list into the first paint.
const workspaceMeetingsCache = new Map<string, Meeting[]>();

function cacheKey(input: { userId: string; workspaceId: string }) {
  return `${input.userId}:${input.workspaceId}`;
}

export function getCachedWorkspaceMeetings(
  ...args: [userId?: string | null, workspaceId?: string | null]
): Meeting[] | null {
  const [userId, workspaceId] = args;
  if (userId === null || userId === undefined || userId === "") {
    return null;
  }
  if (workspaceId === null || workspaceId === undefined || workspaceId === "") {
    return null;
  }

  return workspaceMeetingsCache.get(cacheKey({ userId, workspaceId })) ?? null;
}

export function setCachedWorkspaceMeetings(
  ...args: [userId: string | null | undefined, workspaceId: string | null | undefined, meetings: Meeting[]]
): void {
  const [userId, workspaceId, meetings] = args;
  if (userId === null || userId === undefined || userId === "") {
    return;
  }
  if (workspaceId === null || workspaceId === undefined || workspaceId === "") {
    return;
  }

  workspaceMeetingsCache.set(cacheKey({ userId, workspaceId }), meetings);
}
