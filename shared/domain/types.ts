import { z } from "zod";

import { workspaceMemberRoleSchema } from "./workspace-admin";

export const meetingStatusSchema = z.enum(["scheduled", "active", "ended"]);
export const meetingKindSchema = z.enum(["standard", "agent_intro"]);
/** New meetings start participant-only; eligible meetings can later be unlocked. */
export const isMeetingConfidentialByDefault = true;

export const userSourceSchema = z.enum(["auth", "dev_login", "debug_import", "guest"]);
export const userPlanValues = ["free", "pro", "max", "business", "business_multilingual", "enterprise"] as const;
export const userPlanSchema = z.enum(userPlanValues);
export const meetingJoinRequestStatusSchema = z.enum(["waiting", "admitted", "denied", "expired", "revoked"]);

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable(),
  source: userSourceSchema.default("auth"),
  authProvider: z.enum(["google", "microsoft-entra-id", "dev-login"]).nullable().optional(),
  plan: userPlanSchema.default("free"),
  hasCompletedFirstMeeting: z.boolean().default(false),
  hasCompletedAgentIntro: z.boolean().default(false),
  // Optional for sessions issued before this capability was included.
  memoryAvailable: z.boolean().optional(),
  workspaceId: z.string().uuid(),
  sessionVersion: z.number().int().positive().default(1),
  deletedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string(),
});

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workspaceMemberSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable(),
  role: workspaceMemberRoleSchema,
});

export const meetingLinkSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  code: z.string().min(1),
  createdByUserId: z.string().uuid(),
  title: z.string().min(1),
  status: z.enum(["active", "disabled"]),
  callIn: z
    .object({
      phoneNumber: z.string().min(1),
      pin: z.string().min(1),
    })
    .nullable()
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const meetingSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string().min(1),
  roomName: z.string().min(1),
  meetingLinkId: z.string().uuid().nullable().optional(),
  instanceNumber: z.number().int().positive().optional(),
  meetingLink: meetingLinkSchema.nullable().optional(),
  createdByUserId: z.string().uuid(),
  kind: meetingKindSchema.default("standard"),
  status: meetingStatusSchema,
  isConfidential: z.boolean().default(isMeetingConfidentialByDefault),
  confidentialitySource: z.enum(["auto", "manual"]).nullable().optional(),
  /** True when an internal one-to-one must remain participant-only. */
  confidentialityIsRequired: z.boolean().optional(),
  viewerCanChangeConfidentiality: z.boolean().optional(),
  /** How the requesting viewer relates to this meeting; 'workspace' viewers are read-only. */
  viewerRole: z.enum(["host", "participant", "workspace", "guest", "untrusted"]).optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  notePreview: z.string().nullable().optional(),
  participantNames: z.string().array().optional(),
  participants: z
    .object({
      userId: z.string().uuid(),
      displayName: z.string().min(1),
      avatarUrl: z.string().nullable(),
    })
    .array()
    .optional(),
});

export const meetingRuntimeParticipantSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(1),
  email: z.string().email().nullable().optional(),
  avatarUrl: z.string().nullable(),
  role: z.enum(["host", "guest"]),
});

export const meetingRuntimeStateSchema = z.object({
  activeHumanParticipantCount: z.number().int().nonnegative(),
  activeHumanParticipants: meetingRuntimeParticipantSchema.array(),
  allHumanParticipants: meetingRuntimeParticipantSchema.array(),
  isAwaitingMeetingEnd: z.boolean(),
});

export const meetingJoinRequestSchema = z.object({
  id: z.string().uuid(),
  meetingLinkId: z.string().uuid(),
  meetingId: z.string().uuid().nullable(),
  userId: z.string().uuid(),
  displayName: z.string().min(1),
  status: meetingJoinRequestStatusSchema,
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const transcriptSegmentSchema = z.object({
  id: z.string().uuid(),
  transcriptId: z.string().uuid(),
  speakerIdentity: z.string(),
  speakerUserId: z.string().uuid().nullable(),
  speakerRole: z.enum(["human", "assistant", "system"]),
  speakerName: z.string(),
  source: z.string(),
  sourceSegmentId: z.string().nullable(),
  meetingTurnId: z.string().uuid().nullable().optional(),
  agentProfileId: z.string().uuid().nullable().optional(),
  agentOwnerUserId: z.string().uuid().nullable().optional(),
  voiceId: z.string().nullable().optional(),
  content: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

export const agentProfileSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string().min(1),
  displayName: z.string().min(1),
  systemPrompt: z.string().nullable().optional(),
  voiceProvider: z.string().min(1),
  voiceId: z.string().nullable().optional(),
  llmModel: z.string().nullable().optional(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const agentMemorySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  agentProfileId: z.string().uuid(),
  memoryType: z.string().min(1),
  content: z.string().min(1),
  source: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const agentConnectorSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  agentProfileId: z.string().uuid(),
  provider: z.string().min(1),
  status: z.enum(["connected", "disconnected", "error"]),
  scope: z.enum(["private", "public", "shared"]),
  providerAccountId: z.string().nullable().optional(),
  providerEmail: z.string().nullable().optional(),
  providerTenantId: z.string().nullable().optional(),
  externalAccountEmail: z.string().nullable().optional(),
  scopes: z.array(z.string()).default([]),
  syncStatus: z.string().default("idle"),
  accountKind: z.enum(["personal", "work"]).nullable().optional(),
  lastSyncedAt: z.string().datetime().nullable().optional(),
  connectedAt: z.string().datetime().nullable().optional(),
  disconnectedAt: z.string().datetime().nullable().optional(),
  deletedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const agentToolPolicySchema = z.object({
  id: z.string().uuid(),
  agentProfileId: z.string().uuid(),
  toolName: z.string().min(1),
  mode: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const agentSettingsSchema = z.object({
  profile: agentProfileSchema,
  memories: agentMemorySchema.array(),
  connectors: agentConnectorSchema.array(),
  toolPolicies: agentToolPolicySchema.array(),
});

export const transcriptInfoSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  source: z.string(),
  mode: z.string(),
  isFinal: z.boolean(),
  refinedAt: z.string().nullable(),
});

export const actionItemSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  text: z.string(),
  assignee: z.string().nullable(),
  status: z.enum(["open", "done"]),
  createdAt: z.string(),
});

export const summarySchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  content: z.string(),
  model: z.string(),
  generatedAt: z.string(),
});

export type User = z.infer<typeof userSchema>;
export type UserSource = z.infer<typeof userSourceSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type UserPlan = z.infer<typeof userPlanSchema>;
export type MeetingLink = z.infer<typeof meetingLinkSchema>;
export type Meeting = z.infer<typeof meetingSchema>;
export type MeetingRuntimeParticipant = z.infer<typeof meetingRuntimeParticipantSchema>;
export type MeetingRuntimeState = z.infer<typeof meetingRuntimeStateSchema>;
export type MeetingJoinRequestStatus = z.infer<typeof meetingJoinRequestStatusSchema>;
export type MeetingJoinRequest = z.infer<typeof meetingJoinRequestSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type TranscriptInfo = z.infer<typeof transcriptInfoSchema>;
export type ActionItem = z.infer<typeof actionItemSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentMemory = z.infer<typeof agentMemorySchema>;
export type AgentConnector = z.infer<typeof agentConnectorSchema>;
export type AgentToolPolicy = z.infer<typeof agentToolPolicySchema>;
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
