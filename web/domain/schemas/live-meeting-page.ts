import { z } from "zod";

export const assistantPresencePayloadSchema = z.object({
  assistantIdentity: z.string(),
  assistantDisplayName: z.string(),
  active: z.boolean().optional(),
  phase: z.string().optional(),
  assistantOwnerUserId: z.string().optional(),
  assistantOwnerParticipantIdentity: z.string().optional(),
  conversationModeActive: z.boolean().optional(),
});

export const assistantTurnConflictPayloadSchema = z.object({
  type: z.literal("assistant_turn_conflict"),
  reason: z.literal("another_participant_active"),
  speakerDisplayName: z.string().optional(),
});

export const agentHelpCreditsRequiredPayloadSchema = z.object({
  type: z.literal("agent_help_credits_required"),
  reason: z.string().optional(),
  assistantOwnerParticipantIdentity: z.string().optional(),
});

/** Only the meeting a panel RPC names, so a payload for another meeting can be ignored. */
export const assistantRpcPayloadMeetingSchema = z.object({
  meetingId: z.string().nullish(),
});

export const linearActionPanelPayloadSchema = z
  .object({
    type: z.literal("linear_action"),
    pendingInvocationId: z.string(),
    status: z.enum(["completed", "cancelled", "error", "pending"]).optional(),
    meetingId: z.string().nullable().optional(),
    actionName: z.string().optional(),
    actionLabel: z.string().optional(),
    description: z.string().nullable().optional(),
    preview: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    summaries: z.array(z.string()).optional(),
    copy: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])).optional(),
    result: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]))
      .optional(),
    requestingUserId: z.string().nullable().optional(),
  })
  .passthrough();

export const realtimeMeetingDataPayloadSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
);

export type LinearActionPanelPayloadSchemaValue = z.infer<typeof linearActionPanelPayloadSchema>;
export type RealtimeMeetingDataPayloadSchemaValue = z.infer<typeof realtimeMeetingDataPayloadSchema>;
