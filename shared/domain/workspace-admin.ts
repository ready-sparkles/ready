import { z } from "zod";

const MAX_WORKSPACE_NAME_LENGTH = 255;
const MIN_INVITATION_EMAIL_LENGTH = 3;
const MAX_INVITATION_EMAIL_LENGTH = 255;
const MAX_INVITATIONS_PER_REQUEST = 25;
const ONE_TO_ONE_PARTICIPANT_COUNT = 2;

export const workspaceMemberRoleSchema = z.enum(["owner", "admin", "member"]);
export const workspaceAssignableRoleSchema = z.enum(["admin", "member"]);
export const workspaceMemberStatusSchema = z.enum(["active", "suspended"]);
export const workspaceInvitationStateSchema = z.enum(["pending", "expired"]);

export const workspaceSettingsSchema = z.object({
  isLiveSummaryEnabled: z.boolean().default(true),
  isAmbientContextEnabled: z.boolean().default(true),
  id: z.string().uuid(),
  name: z.string().min(1),
  logoUrl: z.string().nullable(),
  viewerRole: workspaceMemberRoleSchema,
  createdAt: z.string(),
});

export const workspaceSettingsResponseSchema = z.object({
  workspace: workspaceSettingsSchema,
});

export const updateWorkspaceSettingsRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_WORKSPACE_NAME_LENGTH).optional(),
    isLiveSummaryEnabled: z.boolean().optional(),
    isAmbientContextEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length !== 0, "At least one workspace setting is required.");

export const deleteWorkspaceRequestSchema = z.object({
  confirmationName: z.string().trim().min(1).max(MAX_WORKSPACE_NAME_LENGTH),
});

export const deleteWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  deletionId: z.string().uuid().optional(),
  activeWorkspaceId: z.string().uuid(),
});

// Logos travel as data URLs so the upload works in every environment without
// object-storage configuration; the server re-validates type and size.
export const workspaceLogoUploadRequestSchema = z.object({
  dataUrl: z.string().min(1),
});

export const adminWorkspaceMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable(),
  role: workspaceMemberRoleSchema,
  status: workspaceMemberStatusSchema,
  joinedAt: z.string(),
  lastSeenAt: z.string().nullable(),
  isSelf: z.boolean(),
});

export const workspaceInvitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: workspaceAssignableRoleSchema,
  state: workspaceInvitationStateSchema,
  invitedByName: z.string().nullable(),
  invitedAt: z.string(),
  expiresAt: z.string(),
});

export const workspaceMembersResponseSchemaV2 = z.object({
  viewerRole: workspaceMemberRoleSchema,
  capabilities: z.object({
    canManageMembers: z.boolean(),
    canInviteMembers: z.boolean(),
    canTransferOwnership: z.boolean(),
    canManageBilling: z.boolean(),
    canDeleteWorkspace: z.boolean(),
  }),
  members: adminWorkspaceMemberSchema.array(),
  invitations: workspaceInvitationSchema.array(),
});

export const inviteWorkspaceMembersRequestSchema = z.object({
  emails: z
    .string()
    .trim()
    .min(MIN_INVITATION_EMAIL_LENGTH)
    .max(MAX_INVITATION_EMAIL_LENGTH)
    .array()
    .min(1)
    .max(MAX_INVITATIONS_PER_REQUEST),
  role: workspaceAssignableRoleSchema,
});

export const inviteWorkspaceMembersResponseSchema = z.object({
  invitations: workspaceInvitationSchema.array(),
  failures: z
    .object({
      email: z.string(),
      reason: z.enum(["invalid_email", "already_member", "already_invited", "send_failed"]),
    })
    .array(),
});

export const updateWorkspaceMemberRequestSchema = z.object({
  role: workspaceAssignableRoleSchema,
});

export const restoreWorkspaceMemberRequestSchema = z.object({
  role: workspaceAssignableRoleSchema,
});

export const transferWorkspaceOwnershipRequestSchema = z.object({
  targetUserId: z.string().uuid(),
});

export const workspaceMemberActionResponseSchema = z.object({
  member: adminWorkspaceMemberSchema,
});

export const removeWorkspaceMemberResponseSchema = z.object({
  removed: z.literal(true),
});

export const workspaceInvitationActionResponseSchema = z.object({
  invitation: workspaceInvitationSchema,
});

export const revokeWorkspaceInvitationResponseSchema = z.object({
  revoked: z.literal(true),
});

/** Public (pre-auth) view of an invitation for the accept page. */
export const workspaceInvitationPublicInfoSchema = z.object({
  workspaceName: z.string(),
  workspaceLogoUrl: z.string().nullable(),
  inviterName: z.string().nullable(),
  email: z.string().email(),
  role: workspaceAssignableRoleSchema,
  state: z.enum(["pending", "expired", "accepted", "revoked"]),
  expiresAt: z.string(),
});

export const workspaceInvitationPublicInfoResponseSchema = z.object({
  invitation: workspaceInvitationPublicInfoSchema,
});

export const acceptWorkspaceInvitationResponseSchema = z.object({
  workspaceId: z.string().uuid(),
  role: workspaceAssignableRoleSchema,
});

export const myWorkspaceSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  logoUrl: z.string().nullable(),
  role: workspaceMemberRoleSchema,
  isActive: z.boolean(),
});

export const myWorkspaceResponseSchema = z.object({
  workspace: z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    logoUrl: z.string().nullable(),
    role: workspaceMemberRoleSchema,
    status: workspaceMemberStatusSchema,
  }),
  /** Every workspace the user can switch to (active memberships only). */
  workspaces: myWorkspaceSummarySchema.array(),
});

export const setActiveWorkspaceRequestSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(MAX_WORKSPACE_NAME_LENGTH),
});

/** The created workspace is also made the caller's active workspace. */
export const createWorkspaceResponseSchema = z.object({
  workspace: z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    role: workspaceMemberRoleSchema,
  }),
});

export const updateMeetingConfidentialityRequestSchema = z.object({
  isConfidential: z.boolean(),
});

export const updateMeetingConfidentialityResponseSchema = z.object({
  meetingId: z.string().uuid(),
  isConfidential: z.boolean(),
  confidentialitySource: z.enum(["auto", "manual"]).nullable(),
});

export const meetingConfidentialityRealtimeEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().uuid(),
  eventName: z.literal("meeting.confidentiality.changed"),
  workspaceId: z.string().uuid(),
  meetingId: z.string().uuid(),
  isConfidential: z.boolean(),
  confidentialitySource: z.enum(["auto", "manual"]).nullable(),
  occurredAt: z.string().datetime(),
  actorUserId: z.string().uuid().nullable(),
});

/**
 * Consumer mail domains that must never be treated as evidence of a shared
 * company. Domain matching is only a pre-membership fallback and requires the
 * domain to be explicitly verified; membership is the primary signal.
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
]);

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");

  return at > 0
    ? email
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : null;
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}

export type AutoConfidentialityParticipant = {
  userId: string;
  email: string;
  /** Active member of the meeting's workspace. */
  isWorkspaceMember: boolean;
};

/**
 * A meeting qualifies for automatic confidentiality when it is an internal
 * one-to-one: exactly two human participants who both belong to the meeting's
 * workspace. Email-domain matching is only consulted while membership is
 * unknown, restricted to explicitly verified company domains, and never for
 * public mail providers.
 */
export function shouldAutoMarkMeetingConfidential(input: {
  humanParticipants: AutoConfidentialityParticipant[];
  verifiedCompanyDomains?: ReadonlySet<string>;
}): boolean {
  const participants = Array.from(
    new Map(input.humanParticipants.map((participant) => [participant.userId, participant])).values(),
  );
  const [first, second] = participants;
  if (participants.length !== ONE_TO_ONE_PARTICIPANT_COUNT || !first || !second) {
    return false;
  }

  if (first.isWorkspaceMember && second.isWorkspaceMember) {
    return true;
  }

  const verified = input.verifiedCompanyDomains;
  if (!verified || verified.size === 0) {
    return false;
  }
  const firstDomain = emailDomain(first.email);
  const secondDomain = emailDomain(second.email);

  return (
    firstDomain !== null &&
    firstDomain !== "" &&
    secondDomain !== null &&
    secondDomain !== "" &&
    firstDomain === secondDomain &&
    !isPublicEmailDomain(firstDomain) &&
    verified.has(firstDomain)
  );
}

export type WorkspaceMemberRole = z.infer<typeof workspaceMemberRoleSchema>;
export type WorkspaceAssignableRole = z.infer<typeof workspaceAssignableRoleSchema>;
export type WorkspaceMemberStatus = z.infer<typeof workspaceMemberStatusSchema>;
export type AdminWorkspaceMember = z.infer<typeof adminWorkspaceMemberSchema>;
export type WorkspaceInvitation = z.infer<typeof workspaceInvitationSchema>;
export type WorkspaceMembersResponse = z.infer<typeof workspaceMembersResponseSchemaV2>;
export type WorkspaceInvitationPublicInfo = z.infer<typeof workspaceInvitationPublicInfoSchema>;
export type MeetingConfidentialityRealtimeEvent = z.infer<typeof meetingConfidentialityRealtimeEventSchema>;
