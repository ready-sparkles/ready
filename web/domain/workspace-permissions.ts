import type { WorkspaceMemberRole, WorkspaceMemberStatus } from "@readymeet/shared";

export function workspaceSettingsPermissions(input: { role: WorkspaceMemberRole; status: WorkspaceMemberStatus }): {
  canViewMembers: boolean;
  canManageWorkspace: boolean;
  canManageBilling: boolean;
  canDeleteWorkspace: boolean;
} {
  const isActive = input.status === "active";
  const isOwner = isActive && input.role === "owner";
  const isManager = isActive && (input.role === "owner" || input.role === "admin");

  return {
    canViewMembers: isActive,
    canManageWorkspace: isManager,
    canManageBilling: isOwner,
    canDeleteWorkspace: isOwner,
  };
}
