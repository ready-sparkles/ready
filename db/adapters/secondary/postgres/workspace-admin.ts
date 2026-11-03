import type { WorkspaceAssignableRole, WorkspaceMemberRole } from "@readymeet/shared";

import { WORKSPACE_ADMIN_ERROR_CODES, WorkspaceAdminError } from "../../../domain/persistence-errors";

import { type AccountTransaction, lockAccountWorkspace, withAccountMutation } from "./account-coordination";
import { db, Prisma } from "./client";
import { workspaceNameForUser } from "./repositories";
import { getRunningBillingSubscriptionForWorkspace } from "./workspace-billing";

export { MeetingConfidentialityRequiredError } from "../../../domain/persistence-errors";
export { WORKSPACE_ADMIN_ERROR_CODES, WorkspaceAdminError };
export type { WorkspaceAdminErrorCode } from "../../../domain/persistence-errors";
export {
  isMeetingConfidentialityRequired,
  maybeAutoMarkMeetingConfidential,
  setMeetingConfidentiality,
} from "./meeting-confidentiality";
export { recordWorkspaceAuditEvent } from "./workspace-audit";

const MAX_WORKSPACE_NAME_LENGTH = 255;
const DEFAULT_WORKSPACE_AUDIT_LIMIT = 100;

const MESSAGE_FAILED_TO_RESOLVE_REPLACEMENT_WORKSPACE = "Failed to resolve replacement workspace";
const MESSAGE_INVALID_WORKSPACE_NAME_LENGTH = "Workspace name must be between 1 and 255 characters.";
const MESSAGE_USER_NOT_FOUND = "User not found.";
const MESSAGE_GUEST_CANNOT_CREATE_WORKSPACE = "Guest users cannot create workspaces.";
const MESSAGE_NOT_ACTIVE_MEMBER_OF_WORKSPACE = "You are not an active member of that workspace.";
const MESSAGE_WORKSPACE_MANAGER_ACCESS_REQUIRED = "Workspace manager access required.";
const MESSAGE_MEMBER_NOT_FOUND_IN_WORKSPACE = "Member not found in this workspace.";
const MESSAGE_TRANSFER_OWNERSHIP_BEFORE_OWNER_CHANGE =
  "Transfer ownership before changing, suspending, or removing the owner.";
const MESSAGE_USE_SEPARATE_FLOW_FOR_OWN_ACCESS =
  "Use the separate account or workspace-leaving flow to change your own access.";
const MESSAGE_SUSPENDED_MEMBER_NOT_FOUND = "Suspended member not found in this workspace.";
const MESSAGE_ONLY_ACTIVE_OWNER_CAN_TRANSFER = "Only an active workspace owner can transfer ownership.";
const MESSAGE_NEW_OWNER_NEEDS_ACTIVE_ACCOUNT = "The new owner must have an active Ready account.";
const MESSAGE_ONLY_OWNER_CAN_TRANSFER = "Only the workspace owner can transfer ownership.";
const MESSAGE_CHOOSE_ANOTHER_MEMBER_AS_OWNER = "Choose another active member as the new owner.";
const MESSAGE_NEW_OWNER_MUST_BE_ACTIVE_MEMBER = "The new owner must be an active workspace member.";
const MESSAGE_INVITATION_NO_LONGER_OPEN = "Invitation is no longer open.";
const MESSAGE_INVITATION_LINK_NOT_VALID = "This invitation link is not valid.";
const MESSAGE_INVITATION_REVOKED = "This invitation has been revoked.";
const MESSAGE_INVITATION_ALREADY_USED = "This invitation has already been used.";
const MESSAGE_INVITATION_EXPIRED = "This invitation has expired.";
const MESSAGE_FAILED_TO_ACCEPT_WORKSPACE_INVITATION = "Failed to accept workspace invitation";
const MESSAGE_ONLY_WORKSPACE_OWNER_CAN_DELETE = "Only the workspace owner can delete this workspace.";
const MESSAGE_WORKSPACE_NOT_FOUND = "Workspace not found.";
const MESSAGE_CANCEL_PLAN_BEFORE_DELETE_WORKSPACE =
  "Cancel this workspace's plan in Billing before deleting the workspace.";
const MESSAGE_METADATA_MUST_BE_JSON_OBJECT = "Workspace metadata must be a JSON object.";
const MESSAGE_UNEXPECTED_WORKSPACE_MEMBER_ROLE = "Unexpected workspace member role.";
const MESSAGE_UNEXPECTED_WORKSPACE_PLAN = "Unexpected workspace plan.";
const MESSAGE_UNEXPECTED_WORKSPACE_MEMBER_STATUS = "Unexpected workspace member status.";
const MESSAGE_UNEXPECTED_MEETING_KIND = "Unexpected meeting kind.";
const MESSAGE_UNEXPECTED_MEETING_STATUS = "Unexpected meeting status.";
const MESSAGE_UNEXPECTED_CONFIDENTIALITY_SOURCE = "Unexpected meeting confidentiality source.";

function workspaceLimitReachedMessage(maxWorkspacesPerUser: number): string {
  return `You have reached the limit of ${String(maxWorkspacesPerUser)} created workspaces.`;
}

function workspaceMemberAlreadyMessage(email: string): string {
  return `${email} is already a member of this workspace.`;
}

function workspaceInvitationAlreadyPendingMessage(email: string): string {
  return `${email} already has a pending invitation.`;
}

function workspaceInvitationEmailMismatchMessage(invitedEmail: string): string {
  return `This invitation was sent to ${invitedEmail}. Sign in with that email to accept it.`;
}

type WorkspacePlan = "pro" | "max" | "free" | "business" | "business_multilingual" | "enterprise";
type WorkspaceRecord = Awaited<ReturnType<typeof db.workspaces.findUniqueOrThrow>>;
type WorkspaceRow = Omit<WorkspaceRecord, "plan"> & { plan: WorkspacePlan };
type MembershipRecord = Awaited<ReturnType<typeof db.workspaceMemberships.findUniqueOrThrow>>;
type WorkspaceMembershipRow = Omit<MembershipRecord, "role" | "status"> & {
  role: WorkspaceMemberRole;
  status: "active" | "suspended";
};
type InvitationRecord = Awaited<ReturnType<typeof db.workspaceInvitations.findUniqueOrThrow>>;
type InvitationRole = "owner" | "admin" | "member";
type WorkspaceInvitationRow = Omit<InvitationRecord, "role"> & { role: InvitationRole };
type AuditRecord = Awaited<ReturnType<typeof db.workspaceAuditEvents.findUniqueOrThrow>>;
type WorkspaceAuditEventRow = Omit<AuditRecord, "metadata"> & { metadata: Record<string, unknown> };
type MeetingRecord = Awaited<ReturnType<typeof db.meetings.findUniqueOrThrow>>;
type MeetingKind = "standard" | "agent_intro";
type MeetingStatus = "scheduled" | "active" | "ended";
type MeetingRow = {
  kind: MeetingKind;
  status: MeetingStatus;
  confidentialitySource: "auto" | "manual" | null;
};
type UserRecord = Awaited<ReturnType<typeof db.users.findUniqueOrThrow>>;

type WorkspaceMemberAdminRow = {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: WorkspaceMemberRole;
  status: "active" | "suspended";
  joinedAt: Date;
  suspendedAt: Date | null;
  lastSeenAt: Date | null;
};

type MyWorkspaceDetailedRow = {
  id: string;
  name: string;
  logoUrl: string | null;
  role: WorkspaceMemberRole;
};

type OpenWorkspaceInvitationRow = {
  id: string;
  email: string;
  role: InvitationRole;
  expiresAt: Date;
  lastSentAt: Date | null;
  createdAt: Date;
  invitedByName: string | null;
};

type WorkspaceVisibleMeetingRow = {
  isParticipant: boolean;
  id: string;
  workspaceId: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  createdByUserId: string;
  kind: MeetingRow["kind"];
  status: MeetingRow["status"];
  isConfidential: boolean;
  confidentialitySource: MeetingRow["confidentialitySource"];
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
};

type LockedMembership = {
  userId: string;
  role: WorkspaceMemberRole;
  status: "active" | "suspended";
};

function isWorkspaceMemberRole(role: string): role is WorkspaceMemberRole {
  return role === "owner" || role === "admin" || role === "member";
}

function workspaceMemberRole(role: string): WorkspaceMemberRole {
  if (isWorkspaceMemberRole(role)) {
    return role;
  }

  throw new Error(MESSAGE_UNEXPECTED_WORKSPACE_MEMBER_ROLE);
}

function invitationRole(role: string): InvitationRole {
  return workspaceMemberRole(role);
}

function isWorkspaceMemberStatus(status: string): status is "active" | "suspended" {
  return status === "active" || status === "suspended";
}

function workspaceMemberStatus(status: string): "active" | "suspended" {
  if (isWorkspaceMemberStatus(status)) {
    return status;
  }

  throw new Error(MESSAGE_UNEXPECTED_WORKSPACE_MEMBER_STATUS);
}

function isWorkspacePlan(plan: string): plan is WorkspacePlan {
  return (
    plan === "pro" ||
    plan === "max" ||
    plan === "free" ||
    plan === "business" ||
    plan === "business_multilingual" ||
    plan === "enterprise"
  );
}

function workspacePlan(plan: string): WorkspacePlan {
  if (isWorkspacePlan(plan)) {
    return plan;
  }

  throw new Error(MESSAGE_UNEXPECTED_WORKSPACE_PLAN);
}

function meetingKind(kind: string): MeetingKind {
  if (kind === "standard" || kind === "agent_intro") {
    return kind;
  }

  throw new Error(MESSAGE_UNEXPECTED_MEETING_KIND);
}

function meetingStatus(status: string): MeetingStatus {
  if (status === "scheduled" || status === "active" || status === "ended") {
    return status;
  }

  throw new Error(MESSAGE_UNEXPECTED_MEETING_STATUS);
}

function confidentialitySource(source: string | null): "auto" | "manual" | null {
  if (source === null || source === "auto" || source === "manual") {
    return source;
  }

  throw new Error(MESSAGE_UNEXPECTED_CONFIDENTIALITY_SOURCE);
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(MESSAGE_METADATA_MUST_BE_JSON_OBJECT);
  }

  return Object.entries(value).reduce<Record<string, unknown>>((record, [key, item]) => {
    return { ...record, [key]: item };
  }, {});
}

function toWorkspace(row: WorkspaceRecord): WorkspaceRow {
  return { ...row, plan: workspacePlan(row.plan) };
}

function toMembership(row: MembershipRecord): WorkspaceMembershipRow {
  return { ...row, role: workspaceMemberRole(row.role), status: workspaceMemberStatus(row.status) };
}

function toInvitation(row: InvitationRecord): WorkspaceInvitationRow {
  return { ...row, role: invitationRole(row.role) };
}

function toAuditEvent(row: AuditRecord): WorkspaceAuditEventRow {
  return { ...row, metadata: jsonRecord(row.metadata) };
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

function hasPostgresUniqueCode(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return true;
  }
  if (hasPostgresUniqueCode(error)) {
    return true;
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    return isUniqueViolation(error.cause);
  }

  return false;
}

async function usersById(ids: string[]): Promise<Map<string, UserRecord>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db.users.findMany({ where: { id: { in: ids } } });

  return new Map(rows.map((row) => [row.id, row]));
}

async function workspacesById(ids: string[]): Promise<Map<string, WorkspaceRecord>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db.workspaces.findMany({ where: { id: { in: ids } } });

  return new Map(rows.map((row) => [row.id, row]));
}

async function createReplacementWorkspace(user: { id: string; email: string; displayName: string }): Promise<string> {
  const workspace = await db.workspaces.create({
    data: { name: workspaceNameForUser(user), createdByUserId: user.id, createdVia: "system_replacement" },
  });
  await db.workspaceMemberships.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "owner", status: "active" },
  });

  return workspace.id;
}

export async function getWorkspaceById(workspaceId: string): Promise<WorkspaceRow | null> {
  const row = await db.workspaces.findUnique({ where: { id: workspaceId } });

  return row === null ? null : toWorkspace(row);
}

async function assertActorCanDeleteWorkspaceForAdmin(input: {
  workspaceId: string;
  actorUserId: string;
}): Promise<void> {
  const actorMembership = await db.workspaceMemberships.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorUserId } },
  });
  if (actorMembership === null || actorMembership.status !== "active" || actorMembership.role !== "owner") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.workspace_owner_required,
      message: MESSAGE_ONLY_WORKSPACE_OWNER_CAN_DELETE,
    });
  }
}

async function requireWorkspaceForAdminDeletion(workspaceId: string): Promise<{ id: string; name: string }> {
  const workspace = await db.workspaces.findUnique({ where: { id: workspaceId } });
  if (workspace === null) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.membership_not_found,
      message: MESSAGE_WORKSPACE_NOT_FOUND,
    });
  }

  return { id: workspace.id, name: workspace.name };
}

async function migrateActiveUsersOffWorkspaceForAdmin(input: {
  workspaceId: string;
  actorUserId: string;
}): Promise<string | null> {
  const activeUsers = await db.users.findMany({
    where: { activeWorkspaceId: input.workspaceId, deletedAt: null },
  });

  return activeUsers.reduce<Promise<string | null>>(async (previous, user) => {
    const actorActiveWorkspaceId = await previous;
    const replacement = await db.workspaceMemberships.findFirst({
      where: { userId: user.id, status: "active", workspaceId: { not: input.workspaceId } },
      orderBy: { createdAt: "asc" },
    });
    const replacementWorkspaceId = replacement?.workspaceId ?? null;
    const nextWorkspaceId = replacementWorkspaceId ?? (await createReplacementWorkspace(user));
    await db.users.updateMany({ where: { id: user.id }, data: { activeWorkspaceId: nextWorkspaceId } });

    return user.id === input.actorUserId ? nextWorkspaceId : actorActiveWorkspaceId;
  }, Promise.resolve(null));
}

async function deleteWorkspaceLegacyMeetingArtifacts(workspaceId: string): Promise<void> {
  await db.calendarReadyLinks.deleteMany({ where: { meetingLinks: { workspaceId } } });
  await db.meetings.deleteMany({ where: { workspaceId } });
  await db.meetingLinks.deleteMany({ where: { workspaceId } });
}

async function resolveActorActiveWorkspaceAfterAdminDelete(input: {
  actorUserId: string;
  actorFromActiveUsers: string | null;
}): Promise<string> {
  if (input.actorFromActiveUsers !== null) {
    return input.actorFromActiveUsers;
  }

  const actorUser = await db.users.findUnique({ where: { id: input.actorUserId } });
  const currentWorkspaceId = actorUser?.activeWorkspaceId ?? null;
  if (actorUser === null || currentWorkspaceId !== null) {
    if (currentWorkspaceId === null) {
      throw new Error(MESSAGE_FAILED_TO_RESOLVE_REPLACEMENT_WORKSPACE);
    }

    return currentWorkspaceId;
  }

  const replacement = await db.workspaceMemberships.findFirst({
    where: { userId: actorUser.id, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  const replacementWorkspaceId = replacement?.workspaceId ?? null;
  const nextWorkspaceId = replacementWorkspaceId ?? (await createReplacementWorkspace(actorUser));
  await db.users.updateMany({ where: { id: actorUser.id }, data: { activeWorkspaceId: nextWorkspaceId } });

  return nextWorkspaceId;
}

async function deleteWorkspaceRow(workspaceId: string): Promise<{ id: string; name: string }> {
  try {
    const deleted = await db.workspaces.delete({ where: { id: workspaceId } });

    return { id: deleted.id, name: deleted.name };
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new WorkspaceAdminError({
        code: WORKSPACE_ADMIN_ERROR_CODES.membership_not_found,
        message: MESSAGE_WORKSPACE_NOT_FOUND,
      });
    }

    throw error;
  }
}

export async function deleteWorkspaceForAdmin(input: {
  workspaceId: string;
  actorUserId: string;
}): Promise<{ workspace: { id: string; name: string }; activeWorkspaceId: string }> {
  await assertActorCanDeleteWorkspaceForAdmin(input);
  await requireWorkspaceForAdminDeletion(input.workspaceId);
  const runningSubscription = await getRunningBillingSubscriptionForWorkspace({ workspaceId: input.workspaceId });
  if (runningSubscription !== null) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.workspace_subscription_active,
      message: MESSAGE_CANCEL_PLAN_BEFORE_DELETE_WORKSPACE,
    });
  }

  const actorFromActiveUsers = await migrateActiveUsersOffWorkspaceForAdmin(input);
  await deleteWorkspaceLegacyMeetingArtifacts(input.workspaceId);
  const deletedWorkspace = await deleteWorkspaceRow(input.workspaceId);
  const activeWorkspaceId = await resolveActorActiveWorkspaceAfterAdminDelete({
    actorUserId: input.actorUserId,
    actorFromActiveUsers,
  });

  return { workspace: deletedWorkspace, activeWorkspaceId };
}

/**
 * Creates a user-initiated workspace and makes it the user's active one. The
 * cap counts workspaces the user has created (not memberships), so joining
 * many workspaces by invitation never blocks creating one. Duplicated names
 * are allowed, matching workspace rename semantics.
 */
export async function createWorkspaceForUser(input: {
  userId: string;
  name: string;
  maxWorkspacesPerUser: number;
}): Promise<WorkspaceRow> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.invalid_workspace_name,
      message: MESSAGE_INVALID_WORKSPACE_NAME_LENGTH,
    });
  }

  // Mirrors the ensureDefaultWorkspaceForUser guard: guest accounts never
  // own workspaces. Routes also reject guest tokens; this catches upgraded
  // or internal callers.
  const userRow = await db.users.findUnique({ where: { id: input.userId } });
  if (userRow === null) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.membership_not_found,
      message: MESSAGE_USER_NOT_FOUND,
    });
  }
  if (userRow.source === "guest") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.guest_cannot_create_workspace,
      message: MESSAGE_GUEST_CANNOT_CREATE_WORKSPACE,
    });
  }

  const createdCount = await db.workspaces.count({ where: { createdByUserId: input.userId } });
  if (createdCount >= input.maxWorkspacesPerUser) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.workspace_limit_reached,
      message: workspaceLimitReachedMessage(input.maxWorkspacesPerUser),
    });
  }

  const workspace = await db.workspaces.create({
    data: { name, createdByUserId: input.userId, createdVia: "user" },
  });
  await db.workspaceMemberships.create({
    data: { workspaceId: workspace.id, userId: input.userId, role: "owner", status: "active" },
  });
  await db.users.updateMany({ where: { id: input.userId }, data: { activeWorkspaceId: workspace.id } });

  return toWorkspace(workspace);
}

export async function updateWorkspaceName(input: { workspaceId: string; name: string }): Promise<WorkspaceRow | null> {
  return updateWorkspaceSettings(input);
}

export async function updateWorkspaceSettings(input: {
  workspaceId: string;
  name?: string;
  isLiveSummaryEnabled?: boolean;
  isAmbientContextEnabled?: boolean;
}): Promise<WorkspaceRow | null> {
  const updated = await db.workspaces.updateManyAndReturn({
    where: { id: input.workspaceId },
    data: {
      name: input.name,
      isLiveSummaryEnabled: input.isLiveSummaryEnabled,
      isAmbientContextEnabled: input.isAmbientContextEnabled,
      updatedAt: new Date(),
    },
  });
  const row = updated[0];

  return row === undefined ? null : toWorkspace(row);
}

export async function setWorkspaceLogo(input: {
  workspaceId: string;
  logoUrl: string | null;
}): Promise<WorkspaceRow | null> {
  const updated = await db.workspaces.updateManyAndReturn({
    where: { id: input.workspaceId },
    data: { logoUrl: input.logoUrl, updatedAt: new Date() },
  });
  const row = updated[0];

  return row === undefined ? null : toWorkspace(row);
}

export async function getWorkspaceMembership(input: {
  workspaceId: string;
  userId: string;
}): Promise<WorkspaceMembershipRow | null> {
  const row = await db.workspaceMemberships.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
  });

  return row === null ? null : toMembership(row);
}

export async function isActiveWorkspaceMember(input: { workspaceId: string; userId: string }): Promise<boolean> {
  const membership = await getWorkspaceMembership(input);

  return membership !== null && membership.status === "active";
}

export async function isActiveWorkspaceAdmin(input: { workspaceId: string; userId: string }): Promise<boolean> {
  const membership = await getWorkspaceMembership(input);

  return (
    membership !== null &&
    membership.status === "active" &&
    (membership.role === "owner" || membership.role === "admin")
  );
}

function toWorkspaceMemberAdmin(input: { membership: MembershipRecord; user: UserRecord }): WorkspaceMemberAdminRow {
  return {
    userId: input.user.id,
    email: input.user.email,
    displayName: input.user.displayName,
    avatarUrl: input.user.avatarUrl,
    role: workspaceMemberRole(input.membership.role),
    status: workspaceMemberStatus(input.membership.status),
    joinedAt: input.membership.createdAt,
    suspendedAt: input.membership.suspendedAt,
    lastSeenAt: input.user.lastSeenAt,
  };
}

export async function listWorkspaceMembersAdmin(workspaceId: string): Promise<WorkspaceMemberAdminRow[]> {
  const memberships = await db.workspaceMemberships.findMany({
    where: { workspaceId, users: { deletedAt: null } },
    orderBy: [{ users: { displayName: "asc" } }, { users: { email: "asc" } }],
  });
  const users = await usersById(memberships.map((membership) => membership.userId));

  return memberships.flatMap((membership) => {
    const user = users.get(membership.userId);
    if (user === undefined || user.deletedAt !== null) {
      return [];
    }

    return [toWorkspaceMemberAdmin({ membership, user })];
  });
}

export type AccountDeletionAdminBlock = {
  workspaceId: string;
  workspaceName: string;
};

export async function listAccountDeletionAdminBlocks(userId: string): Promise<AccountDeletionAdminBlock[]> {
  const owned = await db.workspaceMemberships.findMany({
    where: { userId, role: "owner", status: "active" },
    orderBy: { workspaces: { name: "asc" } },
  });
  if (owned.length === 0) {
    return [];
  }

  const [workspaceRows, shared] = await Promise.all([
    workspacesById(owned.map((membership) => membership.workspaceId)),
    db.workspaceMemberships.findMany({
      where: {
        workspaceId: { in: owned.map((membership) => membership.workspaceId) },
        userId: { not: userId },
        status: "active",
        users: { deletedAt: null },
      },
    }),
  ]);
  const sharedWorkspaceIds = new Set(shared.map((row) => row.workspaceId));
  const ownedWorkspaces = owned.flatMap((membership) => {
    const workspace = workspaceRows.get(membership.workspaceId);
    if (workspace === undefined) {
      return [];
    }

    return [{ workspaceId: workspace.id, workspaceName: workspace.name }];
  });

  return ownedWorkspaces.filter((workspace) => sharedWorkspaceIds.has(workspace.workspaceId));
}

/** Active memberships with workspace identity, for the workspace switcher. */
export async function listMyWorkspacesDetailed(userId: string): Promise<MyWorkspaceDetailedRow[]> {
  const memberships = await db.workspaceMemberships.findMany({
    where: { userId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  const workspaceRows = await workspacesById(memberships.map((membership) => membership.workspaceId));

  return memberships.flatMap((membership) => {
    const workspace = workspaceRows.get(membership.workspaceId);
    if (workspace === undefined) {
      return [];
    }

    return [
      {
        id: workspace.id,
        name: workspace.name,
        logoUrl: workspace.logoUrl,
        role: workspaceMemberRole(membership.role),
      },
    ];
  });
}

/**
 * Points the user at a different workspace. Only active memberships qualify;
 * downstream request resolution re-validates on every request, so a later
 * suspension or removal silently falls back to the default workspace.
 */
export async function setActiveWorkspaceForUser(input: { userId: string; workspaceId: string }): Promise<void> {
  const membership = await getWorkspaceMembership(input);
  if (membership === null || membership.status !== "active") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.membership_not_found,
      message: MESSAGE_NOT_ACTIVE_MEMBER_OF_WORKSPACE,
    });
  }
  await db.users.updateMany({ where: { id: input.userId }, data: { activeWorkspaceId: input.workspaceId } });
}

/** Single-member variant for routes that mutate one membership and return it. */
export async function getWorkspaceMemberAdmin(input: {
  workspaceId: string;
  userId: string;
}): Promise<WorkspaceMemberAdminRow | null> {
  const membership = await db.workspaceMemberships.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
  });
  if (membership === null) {
    return null;
  }
  const user = await db.users.findUnique({ where: { id: input.userId } });
  if (user === null || user.deletedAt !== null) {
    return null;
  }

  return toWorkspaceMemberAdmin({ membership, user });
}

function requireManagerActor(input: { rows: LockedMembership[]; actorUserId: string }): LockedMembership {
  const actor = input.rows.find((row) => row.userId === input.actorUserId);
  if (actor === undefined || actor.status !== "active" || (actor.role !== "owner" && actor.role !== "admin")) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.workspace_manager_required,
      message: MESSAGE_WORKSPACE_MANAGER_ACCESS_REQUIRED,
    });
  }

  return actor;
}

function requireManageableTarget(input: {
  rows: LockedMembership[];
  actorUserId: string;
  targetUserId: string;
  isSelfAllowed?: boolean;
}): LockedMembership {
  const target = input.rows.find((row) => row.userId === input.targetUserId);
  if (target === undefined) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.membership_not_found,
      message: MESSAGE_MEMBER_NOT_FOUND_IN_WORKSPACE,
    });
  }
  if (target.role === "owner") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.owner_protected,
      message: MESSAGE_TRANSFER_OWNERSHIP_BEFORE_OWNER_CHANGE,
    });
  }
  if (!(input.isSelfAllowed ?? false) && input.actorUserId === input.targetUserId) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.self_action_not_allowed,
      message: MESSAGE_USE_SEPARATE_FLOW_FOR_OWN_ACCESS,
    });
  }

  return target;
}

async function lockWorkspaceMemberships(input: {
  tx: AccountTransaction;
  workspaceId: string;
}): Promise<LockedMembership[]> {
  const rows = await input.tx.$queryRaw<{ userId: string; role: string; status: string }[]>`
    SELECT user_id AS "userId", role, status
    FROM workspace_memberships
    WHERE workspace_id = ${input.workspaceId}::uuid
    FOR UPDATE
  `;

  return rows.map((row) => ({
    userId: row.userId,
    role: workspaceMemberRole(row.role),
    status: workspaceMemberStatus(row.status),
  }));
}

async function updatedMembership(input: {
  tx: AccountTransaction;
  where: Prisma.workspaceMembershipsWhereInput;
  data: Prisma.workspaceMembershipsUpdateManyMutationInput;
}): Promise<WorkspaceMembershipRow | null> {
  const updated = await input.tx.workspaceMemberships.updateManyAndReturn({ where: input.where, data: input.data });
  const row = updated[0];
  if (row === undefined) {
    return null;
  }

  return toMembership(row);
}

export async function updateWorkspaceMemberRole(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: WorkspaceAssignableRole;
}): Promise<WorkspaceMembershipRow> {
  return withAccountMutation({
    userIds: [input.actorUserId, input.targetUserId],
    run: async (tx) => {
      await lockAccountWorkspace({ tx, workspaceId: input.workspaceId });
      const rows = await lockWorkspaceMemberships({ tx, workspaceId: input.workspaceId });
      requireManagerActor({ rows, actorUserId: input.actorUserId });
      requireManageableTarget({ rows, ...input });
      const updated = await updatedMembership({
        tx,
        where: { workspaceId: input.workspaceId, userId: input.targetUserId },
        data: { role: input.role, updatedAt: new Date() },
      });
      if (updated === null) {
        throw new WorkspaceAdminError({
          code: WORKSPACE_ADMIN_ERROR_CODES.membership_not_found,
          message: MESSAGE_MEMBER_NOT_FOUND_IN_WORKSPACE,
        });
      }

      return updated;
    },
  });
}

export async function suspendWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<WorkspaceMembershipRow> {
  return withAccountMutation({
    userIds: [input.actorUserId, input.targetUserId],
    run: async (tx) => {
      await lockAccountWorkspace({ tx, workspaceId: input.workspaceId });
      const rows = await lockWorkspaceMemberships({ tx, workspaceId: input.workspaceId });
      requireManagerActor({ rows, actorUserId: input.actorUserId });
      requireManageableTarget({ rows, ...input });
      const updated = await updatedMembership({
        tx,
        where: { workspaceId: input.workspaceId, userId: input.targetUserId },
        data: { status: "suspended", suspendedAt: new Date(), updatedAt: new Date() },
      });
      if (updated === null) {
        throw new WorkspaceAdminError({
          code: WORKSPACE_ADMIN_ERROR_CODES.membership_not_found,
          message: MESSAGE_MEMBER_NOT_FOUND_IN_WORKSPACE,
        });
      }

      return updated;
    },
  });
}

export async function restoreWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: WorkspaceAssignableRole;
}): Promise<WorkspaceMembershipRow> {
  return withAccountMutation({
    userIds: [input.actorUserId, input.targetUserId],
    run: async (tx) => {
      await lockAccountWorkspace({ tx, workspaceId: input.workspaceId });
      const rows = await lockWorkspaceMemberships({ tx, workspaceId: input.workspaceId });
      requireManagerActor({ rows, actorUserId: input.actorUserId });
      requireManageableTarget({ rows, ...input });
      const updated = await updatedMembership({
        tx,
        where: { workspaceId: input.workspaceId, userId: input.targetUserId, status: "suspended" },
        data: { status: "active", suspendedAt: null, role: input.role, updatedAt: new Date() },
      });
      if (updated === null) {
        throw new WorkspaceAdminError({
          code: WORKSPACE_ADMIN_ERROR_CODES.membership_not_found,
          message: MESSAGE_SUSPENDED_MEMBER_NOT_FOUND,
        });
      }

      return updated;
    },
  });
}

function emailsMatch(input: { left: string; right: string }): boolean {
  return input.left.toLowerCase() === input.right.toLowerCase();
}

async function revokeOpenInvitationsForEmail(input: {
  executor?: AccountTransaction;
  workspaceId: string;
  email: string;
  now: Date;
  expiresAtOrBefore?: Date;
}): Promise<void> {
  const executor = input.executor ?? db;
  const openInvitations = await executor.workspaceInvitations.findMany({
    where: {
      workspaceId: input.workspaceId,
      acceptedAt: null,
      revokedAt: null,
      ...(input.expiresAtOrBefore === undefined ? {} : { expiresAt: { lte: input.expiresAtOrBefore } }),
    },
  });
  const ids = openInvitations
    .filter((invitation) => emailsMatch({ left: invitation.email, right: input.email }))
    .map((invitation) => invitation.id);
  if (ids.length === 0) {
    return;
  }

  await executor.workspaceInvitations.updateMany({
    where: {
      id: { in: ids },
      acceptedAt: null,
      revokedAt: null,
      ...(input.expiresAtOrBefore === undefined ? {} : { expiresAt: { lte: input.expiresAtOrBefore } }),
    },
    data: { revokedAt: input.now, updatedAt: input.now },
  });
}

/**
 * Removes the membership row only. Historical meetings, participant rows,
 * tasks, notes, and audit entries all reference the user directly and stay
 * intact; the user simply loses workspace access.
 */
export async function removeWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  return withAccountMutation({
    userIds: [input.actorUserId, input.targetUserId],
    run: async (tx) => {
      await lockAccountWorkspace({ tx, workspaceId: input.workspaceId });
      const rows = await lockWorkspaceMemberships({ tx, workspaceId: input.workspaceId });
      requireManagerActor({ rows, actorUserId: input.actorUserId });
      requireManageableTarget({ rows, ...input });
      const targetUser = await tx.users.findUnique({ where: { id: input.targetUserId } });
      const removed = await tx.workspaceMemberships.deleteMany({
        where: { workspaceId: input.workspaceId, userId: input.targetUserId },
      });
      if (removed.count !== 0 && targetUser !== null) {
        // A pending invitation can coexist with a membership in legacy or
        // manually repaired data. Retire it with the membership so it cannot
        // block a fresh invitation if the person is invited back later.
        await revokeOpenInvitationsForEmail({
          executor: tx,
          workspaceId: input.workspaceId,
          email: targetUser.email,
          now: new Date(),
        });
      }
    },
  });
}

async function assertOwnershipTransferAccounts(input: {
  tx: AccountTransaction;
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  const userIds = [...new Set([input.actorUserId, input.targetUserId])].sort();
  const activeUsers = await input.tx.users.findMany({ where: { id: { in: userIds }, deletedAt: null } });
  if (!activeUsers.some((user) => user.id === input.actorUserId)) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.workspace_owner_required,
      message: MESSAGE_ONLY_ACTIVE_OWNER_CAN_TRANSFER,
    });
  }
  if (!activeUsers.some((user) => user.id === input.targetUserId && user.deletionRequestedAt === null)) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.ownership_target_invalid,
      message: MESSAGE_NEW_OWNER_NEEDS_ACTIVE_ACCOUNT,
    });
  }
}

function assertOwnershipTransferMemberships(input: {
  rows: LockedMembership[];
  actorUserId: string;
  targetUserId: string;
}): void {
  const actor = input.rows.find((row) => row.userId === input.actorUserId);
  if (actor === undefined || actor.status !== "active" || actor.role !== "owner") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.workspace_owner_required,
      message: MESSAGE_ONLY_OWNER_CAN_TRANSFER,
    });
  }
  if (input.actorUserId === input.targetUserId) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.ownership_target_invalid,
      message: MESSAGE_CHOOSE_ANOTHER_MEMBER_AS_OWNER,
    });
  }
  const target = input.rows.find((row) => row.userId === input.targetUserId);
  if (target === undefined || target.status !== "active" || target.role === "owner") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.ownership_target_invalid,
      message: MESSAGE_NEW_OWNER_MUST_BE_ACTIVE_MEMBER,
    });
  }
}

export async function transferWorkspaceOwnership(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<WorkspaceMembershipRow> {
  return withAccountMutation({
    userIds: [input.actorUserId, input.targetUserId],
    run: async (tx) => {
      await assertOwnershipTransferAccounts({ tx, actorUserId: input.actorUserId, targetUserId: input.targetUserId });
      await lockAccountWorkspace({ tx, workspaceId: input.workspaceId });
      const rows = await lockWorkspaceMemberships({ tx, workspaceId: input.workspaceId });
      assertOwnershipTransferMemberships({ rows, actorUserId: input.actorUserId, targetUserId: input.targetUserId });
      const now = new Date();
      await tx.workspaceMemberships.updateMany({
        where: {
          workspaceId: input.workspaceId,
          userId: input.actorUserId,
          role: "owner",
          status: "active",
        },
        data: { role: "admin", updatedAt: now },
      });
      const newOwner = await updatedMembership({
        tx,
        where: { workspaceId: input.workspaceId, userId: input.targetUserId, status: "active" },
        data: { role: "owner", updatedAt: now },
      });
      if (newOwner === null) {
        throw new WorkspaceAdminError({
          code: WORKSPACE_ADMIN_ERROR_CODES.ownership_target_invalid,
          message: MESSAGE_NEW_OWNER_MUST_BE_ACTIVE_MEMBER,
        });
      }
      await tx.workspaceAuditEvents.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          eventType: "workspace.ownership.transferred",
          subjectType: "user",
          subjectId: input.targetUserId,
          metadata: { previousOwnerUserId: input.actorUserId, newOwnerUserId: input.targetUserId },
        },
      });

      return newOwner;
    },
  });
}

export async function listWorkspaceAuditEvents(input: {
  workspaceId: string;
  subjectType?: string;
  subjectId?: string;
  limit?: number;
}): Promise<WorkspaceAuditEventRow[]> {
  const events = await db.workspaceAuditEvents.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.subjectType !== undefined && input.subjectType !== "" ? { subjectType: input.subjectType } : {}),
      ...(input.subjectId !== undefined && input.subjectId !== "" ? { subjectId: input.subjectId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: input.limit ?? DEFAULT_WORKSPACE_AUDIT_LIMIT,
  });

  return events.map((event) => toAuditEvent(event));
}

const LAST_SEEN_THROTTLE_SECONDS = 60;
const MS_PER_SECOND = 1000;

/**
 * Marks authenticated product activity. Throttled so hot request paths
 * don't rewrite the row on every call. Never call this from background jobs,
 * webhooks, or other passive events.
 */
export async function touchUserLastSeen(userId: string): Promise<void> {
  const user = await db.users.findUnique({ where: { id: userId } });
  if (user === null) {
    return;
  }

  const staleBefore = new Date(Date.now() - LAST_SEEN_THROTTLE_SECONDS * MS_PER_SECOND);
  if (user.lastSeenAt !== null && user.lastSeenAt.getTime() >= staleBefore.getTime()) {
    return;
  }

  await db.users.updateMany({ where: { id: userId }, data: { lastSeenAt: new Date() } });
}

// --- Invitations ---

async function activeMemberEmails(workspaceId: string): Promise<string[]> {
  const memberships = await db.workspaceMemberships.findMany({
    where: { workspaceId, users: { deletedAt: null } },
  });
  const users = await usersById(memberships.map((membership) => membership.userId));

  return memberships.flatMap((membership) => {
    const user = users.get(membership.userId);
    if (user === undefined || user.deletedAt !== null) {
      return [];
    }

    return [user.email];
  });
}

export async function createWorkspaceInvitation(input: {
  workspaceId: string;
  email: string;
  role: "admin" | "member";
  invitedByUserId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<WorkspaceInvitationRow> {
  const email = input.email.trim().toLowerCase();
  const members = await activeMemberEmails(input.workspaceId);
  if (members.some((memberEmail) => emailsMatch({ left: memberEmail, right: email }))) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.already_member,
      message: workspaceMemberAlreadyMessage(email),
    });
  }

  // Expiry makes a link unusable but does not satisfy the partial unique
  // index's accepted/revoked predicate. Close expired rows before inserting
  // so entering the address in Invite creates a genuinely fresh invitation.
  const now = new Date();
  await revokeOpenInvitationsForEmail({ workspaceId: input.workspaceId, email, now, expiresAtOrBefore: now });

  try {
    const invitation = await db.workspaceInvitations.create({
      data: {
        workspaceId: input.workspaceId,
        email,
        role: input.role,
        tokenHash: input.tokenHash,
        invitedByUserId: input.invitedByUserId,
        expiresAt: input.expiresAt,
      },
    });

    return toInvitation(invitation);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkspaceAdminError({
        code: WORKSPACE_ADMIN_ERROR_CODES.already_invited,
        message: workspaceInvitationAlreadyPendingMessage(email),
      });
    }

    throw error;
  }
}

export async function listOpenWorkspaceInvitations(workspaceId: string): Promise<OpenWorkspaceInvitationRow[]> {
  const invitations = await db.workspaceInvitations.findMany({
    where: { workspaceId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  const inviterIds = [
    ...new Set(
      invitations.flatMap((invitation) => (invitation.invitedByUserId === null ? [] : [invitation.invitedByUserId])),
    ),
  ];
  const inviters = await usersById(inviterIds);

  return invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitationRole(invitation.role),
    expiresAt: invitation.expiresAt,
    lastSentAt: invitation.lastSentAt,
    createdAt: invitation.createdAt,
    invitedByName:
      invitation.invitedByUserId === null ? null : (inviters.get(invitation.invitedByUserId)?.displayName ?? null),
  }));
}

export async function getWorkspaceInvitationById(input: {
  workspaceId: string;
  invitationId: string;
}): Promise<WorkspaceInvitationRow | null> {
  const row = await db.workspaceInvitations.findUnique({
    where: { id: input.invitationId, workspaceId: input.workspaceId },
  });

  return row === null ? null : toInvitation(row);
}

/** Rotates the token on resend so previously emailed links stop working. */
export async function markWorkspaceInvitationResent(input: {
  workspaceId: string;
  invitationId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<WorkspaceInvitationRow> {
  const openInvitation = {
    id: input.invitationId,
    workspaceId: input.workspaceId,
    acceptedAt: null,
    revokedAt: null,
  };
  const current = await db.workspaceInvitations.findFirst({ where: openInvitation });
  if (current === null) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.invitation_not_found,
      message: MESSAGE_INVITATION_NO_LONGER_OPEN,
    });
  }

  const now = new Date();
  const updated = await db.workspaceInvitations.updateManyAndReturn({
    where: openInvitation,
    data: {
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      lastSentAt: now,
      sendCount: current.sendCount + 1,
      updatedAt: now,
    },
  });
  const row = updated[0];
  if (row === undefined) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.invitation_not_found,
      message: MESSAGE_INVITATION_NO_LONGER_OPEN,
    });
  }

  return toInvitation(row);
}

export async function revokeWorkspaceInvitation(input: {
  workspaceId: string;
  invitationId: string;
}): Promise<WorkspaceInvitationRow> {
  const updated = await db.workspaceInvitations.updateManyAndReturn({
    where: {
      id: input.invitationId,
      workspaceId: input.workspaceId,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date(), updatedAt: new Date() },
  });
  const row = updated[0];
  if (row === undefined) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.invitation_not_found,
      message: MESSAGE_INVITATION_NO_LONGER_OPEN,
    });
  }

  return toInvitation(row);
}

export async function getWorkspaceInvitationByTokenHash(tokenHash: string): Promise<{
  invitation: WorkspaceInvitationRow;
  workspaceName: string;
  workspaceLogoUrl: string | null;
  inviterName: string | null;
} | null> {
  const invitation = await db.workspaceInvitations.findUnique({ where: { tokenHash } });
  if (invitation === null) {
    return null;
  }
  const workspace = await db.workspaces.findUnique({ where: { id: invitation.workspaceId } });
  if (workspace === null) {
    return null;
  }
  const inviter =
    invitation.invitedByUserId === null
      ? null
      : await db.users.findUnique({ where: { id: invitation.invitedByUserId } });

  return {
    invitation: toInvitation(invitation),
    workspaceName: workspace.name,
    workspaceLogoUrl: workspace.logoUrl,
    inviterName: inviter?.displayName ?? null,
  };
}

export function workspaceInvitationState(invitation: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): "pending" | "expired" | "accepted" | "revoked" {
  if (invitation.acceptedAt) {
    return "accepted";
  }
  if (invitation.revokedAt) {
    return "revoked";
  }

  return invitation.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
}

/**
 * Accepts an open invitation for the signed-in user. Acceptance requires the
 * account email to match the invited email; the membership is created (or an
 * existing row left untouched) and the invitation is closed.
 */
/**
 * Deletes the invitee's auto-created signup workspace after an invitation
 * acceptance, so a user who signed up just to join a workspace ends up in
 * only the workspace they joined.
 *
 * Deliberately conservative: only SYSTEM-created workspaces (created_via
 * 'system_default'/'system_replacement' — never one the user created
 * deliberately) that the user owns, with no other member (any status) and
 * zero usage — no hosted or privately filed meetings, meeting links, tasks,
 * sent invitations, credit grants, Stripe customer, subscription (any
 * status), or checkout attempt — are treated as signup artifacts. Any trace
 * of real use keeps the workspace, so an established account keeps its
 * existing workspace and simply gains the joined one. Paid top-up credits
 * and the Stripe customer mapping would cascade away with the workspace, so
 * any billing trace counts as use.
 */
async function workspaceHasRecordedUse(input: { tx: AccountTransaction; workspaceId: string }): Promise<boolean> {
  const { tx, workspaceId } = input;
  const usageMarks = await Promise.all([
    tx.meetings.findFirst({ where: { workspaceId }, select: { id: true } }),
    tx.meetingLinks.findFirst({ where: { workspaceId }, select: { id: true } }),
    tx.workspaceTasks.findFirst({ where: { workspaceId }, select: { id: true } }),
    tx.workspaceInvitations.findFirst({ where: { workspaceId }, select: { id: true } }),
    // External meetings belong to the host workspace, but their attendee
    // mappings and private memories would cascade if this workspace vanished.
    tx.meetingAttendeeWorkspaces.findFirst({ where: { workspaceId }, select: { meetingId: true } }),
    tx.creditGrants.findFirst({ where: { workspaceId }, select: { id: true } }),
    tx.workspaceBillingCustomers.findFirst({ where: { workspaceId }, select: { workspaceId: true } }),
    tx.billingSubscriptions.findFirst({ where: { workspaceId }, select: { id: true } }),
    tx.billingCheckoutAttempts.findFirst({
      where: { subjectType: "workspace", subjectId: workspaceId },
      select: { id: true },
    }),
  ]);

  return usageMarks.some((mark) => mark !== null);
}

async function deletePristineSignupWorkspaces(input: {
  tx: AccountTransaction;
  userId: string;
  joinedWorkspaceId: string;
}): Promise<void> {
  const { tx, userId, joinedWorkspaceId } = input;
  const candidates = await tx.workspaces.findMany({
    where: {
      createdByUserId: userId,
      createdVia: { not: "user" },
      id: { not: joinedWorkspaceId },
      workspaceMemberships: { some: { userId, role: "owner", status: "active" } },
    },
  });

  await candidates.reduce<Promise<void>>(async (previous, candidate) => {
    await previous;
    const workspaceId = candidate.id;
    // The row lock holds off new grants, members, and meetings (their foreign
    // keys need a share lock on this row) until the checks below are done.
    await lockAccountWorkspace({ tx, workspaceId });
    const otherMember = await tx.workspaceMemberships.findFirst({
      where: { workspaceId, userId: { not: userId } },
    });
    if (otherMember !== null) {
      return;
    }
    if (await workspaceHasRecordedUse({ tx, workspaceId })) {
      return;
    }

    // Pristine: the workspace row cascades memberships, sections, and other
    // workspace-owned tables; the usage checks above proved the non-cascading
    // meeting references are vacuous.
    await tx.workspaces.deleteMany({ where: { id: workspaceId } });
  }, Promise.resolve());
}

function requireOpenInvitationForEmail(input: { invitation: WorkspaceInvitationRow; userEmail: string }): void {
  const { invitation } = input;
  const state = workspaceInvitationState(invitation);
  if (state === "revoked") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.invitation_revoked,
      message: MESSAGE_INVITATION_REVOKED,
    });
  }
  if (state === "accepted") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.invitation_accepted,
      message: MESSAGE_INVITATION_ALREADY_USED,
    });
  }
  if (state === "expired") {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.invitation_expired,
      message: MESSAGE_INVITATION_EXPIRED,
    });
  }
  if (invitation.email.toLowerCase() !== input.userEmail.trim().toLowerCase()) {
    throw new WorkspaceAdminError({
      code: WORKSPACE_ADMIN_ERROR_CODES.invitation_email_mismatch,
      message: workspaceInvitationEmailMismatchMessage(invitation.email),
    });
  }
}

/**
 * Accepts an open invitation for the signed-in user. Acceptance requires the
 * account email to match the invited email; the membership is created (or an
 * existing row left untouched) and the invitation is closed. Everything,
 * including removal of an unused signup workspace, happens in one
 * transaction, so a failure part-way leaves nothing half done.
 */
export async function acceptWorkspaceInvitation(input: {
  tokenHash: string;
  userId: string;
  userEmail: string;
}): Promise<{ invitation: WorkspaceInvitationRow; role: WorkspaceMemberRole | WorkspaceAssignableRole }> {
  return withAccountMutation({
    userIds: [input.userId],
    run: async (tx) => {
      const [lockedInvitation] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM workspace_invitations WHERE token_hash = ${input.tokenHash} LIMIT 1 FOR UPDATE
      `;
      const invitationRecord =
        lockedInvitation === undefined
          ? null
          : await tx.workspaceInvitations.findUnique({ where: { id: lockedInvitation.id } });
      if (invitationRecord === null) {
        throw new WorkspaceAdminError({
          code: WORKSPACE_ADMIN_ERROR_CODES.invitation_not_found,
          message: MESSAGE_INVITATION_LINK_NOT_VALID,
        });
      }
      const invitation = toInvitation(invitationRecord);
      requireOpenInvitationForEmail({ invitation, userEmail: input.userEmail });

      const existingMembership = await tx.workspaceMemberships.findUnique({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: input.userId } },
      });
      const role =
        existingMembership === null ? invitationRole(invitation.role) : workspaceMemberRole(existingMembership.role);
      if (existingMembership === null) {
        await tx.workspaceMemberships.create({
          data: { workspaceId: invitation.workspaceId, userId: input.userId, role, status: "active" },
        });
        // Only a genuinely new membership changes the seat count.
      }

      await tx.users.updateMany({ where: { id: input.userId }, data: { activeWorkspaceId: invitation.workspaceId } });
      const updated = await tx.workspaceInvitations.updateManyAndReturn({
        where: { id: invitation.id },
        data: { acceptedAt: new Date(), acceptedByUserId: input.userId, updatedAt: new Date() },
      });
      const accepted = updated[0];
      if (accepted === undefined) {
        throw new Error(MESSAGE_FAILED_TO_ACCEPT_WORKSPACE_INVITATION);
      }

      await deletePristineSignupWorkspaces({
        tx,
        userId: input.userId,
        joinedWorkspaceId: invitation.workspaceId,
      });

      return { invitation: toInvitation(accepted), role };
    },
  });
}

// --- Workspace-visible meetings ---

/**
 * Attended meetings use the attendee's recorded workspace, independently of
 * the host. Colleagues only see non-confidential meetings their workspace hosts;
 * a visitor's private filing association never shares an external meeting.
 */
function visibleMeetingHistoryWhere(): Prisma.meetingsWhereInput {
  return { hiddenFromHistoryAt: null, OR: [{ kind: { not: "agent_intro" } }, { status: "ended" }] };
}

function outsideSuspendedHostWorkspaces(suspendedWorkspaceIds: string[]): Prisma.meetingsWhereInput {
  if (suspendedWorkspaceIds.length === 0) {
    return {};
  }

  return { workspaceId: { notIn: suspendedWorkspaceIds } };
}

function toVisibleMeeting(input: { meeting: MeetingRecord; isParticipant: boolean }): WorkspaceVisibleMeetingRow {
  return {
    isParticipant: input.isParticipant,
    id: input.meeting.id,
    workspaceId: input.meeting.workspaceId,
    title: input.meeting.title,
    roomName: input.meeting.roomName,
    meetingLinkId: input.meeting.meetingLinkId,
    instanceNumber: input.meeting.instanceNumber,
    createdByUserId: input.meeting.createdByUserId,
    kind: meetingKind(input.meeting.kind),
    status: meetingStatus(input.meeting.status),
    isConfidential: input.meeting.isConfidential,
    confidentialitySource: confidentialitySource(input.meeting.confidentialitySource),
    createdAt: input.meeting.createdAt,
    startedAt: input.meeting.startedAt,
    endedAt: input.meeting.endedAt,
  };
}

async function suspendedWorkspaceIdsFor(userId: string): Promise<string[]> {
  const suspendedRows = await db.workspaceMemberships.findMany({
    where: { userId, status: "suspended" },
  });

  return suspendedRows.map((row) => row.workspaceId);
}

async function hostedVisibleMeetings(input: {
  workspaceIds: string[];
  suspendedWorkspaceIds: string[];
}): Promise<MeetingRecord[]> {
  return db.meetings.findMany({
    where: {
      ...visibleMeetingHistoryWhere(),
      workspaceId: {
        in: input.workspaceIds,
        ...(input.suspendedWorkspaceIds.length === 0 ? {} : { notIn: input.suspendedWorkspaceIds }),
      },
      isConfidential: false,
      kind: "standard",
    },
  });
}

async function attendedVisibleMeetings(input: {
  userId: string;
  suspendedWorkspaceIds: string[];
}): Promise<MeetingRecord[]> {
  const attendedRows = await db.meetings.findMany({
    where: {
      ...visibleMeetingHistoryWhere(),
      ...outsideSuspendedHostWorkspaces(input.suspendedWorkspaceIds),
      meetingParticipants: { some: { userId: input.userId } },
    },
  });

  return [...new Map(attendedRows.map((meeting) => [meeting.id, meeting])).values()];
}

function mergeVisibleMeetings(input: {
  hostedMeetings: MeetingRecord[];
  attendedMeetings: MeetingRecord[];
  filingWorkspaceByMeeting: Map<string, string>;
  workspaceIds: string[];
}): WorkspaceVisibleMeetingRow[] {
  const selectedWorkspaceIds = new Set(input.workspaceIds);
  const participantMeetingIds = new Set(input.attendedMeetings.map((meeting) => meeting.id));
  const visibleAttended = input.attendedMeetings.filter((meeting) => {
    const filedWorkspaceId = input.filingWorkspaceByMeeting.get(meeting.id) ?? meeting.workspaceId;

    return selectedWorkspaceIds.has(filedWorkspaceId);
  });
  const byId = new Map<string, WorkspaceVisibleMeetingRow>(
    [
      ...input.hostedMeetings.map((meeting) =>
        toVisibleMeeting({ meeting, isParticipant: participantMeetingIds.has(meeting.id) }),
      ),
      ...visibleAttended.map((meeting) => toVisibleMeeting({ meeting, isParticipant: true })),
    ].map((meeting) => [meeting.id, meeting]),
  );

  return [...byId.values()].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

export async function listWorkspaceVisibleMeetingsForUser(input: {
  userId: string;
  workspaceIds: string[];
}): Promise<WorkspaceVisibleMeetingRow[]> {
  if (input.workspaceIds.length === 0) {
    return [];
  }

  const suspendedWorkspaceIds = await suspendedWorkspaceIdsFor(input.userId);
  const [hostedMeetings, attendedMeetings] = await Promise.all([
    hostedVisibleMeetings({ workspaceIds: input.workspaceIds, suspendedWorkspaceIds }),
    attendedVisibleMeetings({ userId: input.userId, suspendedWorkspaceIds }),
  ]);
  const filingRows =
    attendedMeetings.length === 0
      ? []
      : await db.meetingAttendeeWorkspaces.findMany({ where: { userId: input.userId } });

  return mergeVisibleMeetings({
    hostedMeetings,
    attendedMeetings,
    filingWorkspaceByMeeting: new Map(filingRows.map((row) => [row.meetingId, row.workspaceId])),
    workspaceIds: input.workspaceIds,
  });
}

/**
 * Whether the user may view a task originating from the given meeting:
 * participants always may; workspace members only while the meeting is not
 * confidential.
 */
export async function canUserViewMeetingScopedData(input: {
  userId: string;
  meeting: { id: string; workspaceId: string; createdByUserId: string; isConfidential: boolean };
}): Promise<boolean> {
  const { meeting, userId } = input;
  if (meeting.createdByUserId === userId) {
    return true;
  }
  const participant = await db.meetingParticipants.findFirst({
    where: { meetingId: meeting.id, userId },
  });
  if (participant !== null) {
    return true;
  }
  if (meeting.isConfidential) {
    return false;
  }

  return isActiveWorkspaceMember({ workspaceId: meeting.workspaceId, userId });
}
