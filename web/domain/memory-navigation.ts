import type { User } from "@readymeet/shared";

export function canShowMemoryNavigation({
  user,
  isStatusAvailable,
}: {
  user: Pick<User, "source" | "workspaceId" | "memoryAvailable"> | null | undefined;
  isStatusAvailable?: boolean;
}): boolean {
  const workspaceId = user?.workspaceId;
  const hasWorkspaceId = workspaceId !== undefined && workspaceId !== "";
  if (!hasWorkspaceId || user?.source === "guest") {
    return false;
  }

  // The session supplies the initial flag without another request. A fresh
  // status response takes precedence if the server configuration has changed.
  return isStatusAvailable ?? user?.memoryAvailable ?? false;
}
