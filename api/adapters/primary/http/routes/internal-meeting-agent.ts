import { INSUFFICIENT_CREDITS_CODE } from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  isInsufficientCreditsError,
  loadProviderAuthorization,
  ProviderAdmissionError,
  reserveProviderUsage,
  settleProviderUsage,
  UnboundedProviderUsageError,
} from "../../../../application/metered-provider";
import { apiEnv } from "../../../../composition/env";
import { repositories } from "../../../../ports/repository-runtime";
import { matchesInternalSecret } from "../support/internal-secret";

const UNBOUNDED_USAGE_CODE = "unbounded_usage_not_supported";
const MAX_FEATURE_LENGTH = 100;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_CONFLICT = 409;

const MESSAGE_UNAUTHORIZED_INTERNAL_REQUEST = "Unauthorized internal request";
const MESSAGE_INVALID_MEETING_AGENT_REQUEST = "Invalid meeting agent request.";
const ACTIVE_MEETING_TURN_NAME = "ActiveMeetingTurnConflictError";
const MEETING_ASK_ACTION_TYPE = "meeting_ask";
const ACTIVE_TURN_CODE = "active_turn";
const UNKNOWN_TRANSCRIPT_SEGMENT_SOURCE_MESSAGE = "Unknown transcript segment source.";

const meetingIdSchema = z.string().uuid();
const userIdSchema = z.string().uuid();

const reservationIdentity = {
  reservationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: userIdSchema,
};
const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("reserveCreditUsage"),
      meetingId: meetingIdSchema,
      userId: userIdSchema,
      provider: z.enum(["openai", "typesafe"]),
      model: z.string().min(1),
      feature: z.string().min(1).max(MAX_FEATURE_LENGTH),
      maxOutputTokens: z.number().int().positive().safe().optional(),
      isUnbounded: z.boolean().optional(),
      requestBody: z.record(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("settleCreditUsage"),
      ...reservationIdentity,
      usage: z.object({
        input_tokens: z.number().int().nonnegative().safe(),
        output_tokens: z.number().int().nonnegative().safe(),
        input_tokens_details: z
          .object({
            cached_tokens: z.number().int().nonnegative().safe().optional(),
            cache_write_tokens: z.number().int().nonnegative().safe().optional(),
          })
          .optional(),
      }),
    })
    .strict(),
  z.object({ action: z.literal("releaseCreditUsage"), ...reservationIdentity }).strict(),
  z.object({ action: z.literal("getMeeting"), meetingId: meetingIdSchema }),
  z.object({ action: z.literal("listParticipants"), meetingId: meetingIdSchema }),
  z.object({ action: z.literal("getSummary"), meetingId: meetingIdSchema }),
  z.object({ action: z.literal("listActionItems"), meetingId: meetingIdSchema }),
  z.object({
    action: z.literal("createActionItem"),
    meetingId: meetingIdSchema,
    text: z.string().min(1),
    assignee: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal("ensureDefaultAgentProfile"),
    userId: userIdSchema,
    displayName: z.string().min(1),
    voiceId: z.string().nullable().optional(),
    llmModel: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal("createMeetingTurnLease"),
    meetingId: meetingIdSchema,
    ownerUserId: userIdSchema,
    ownerParticipantIdentity: z.string().min(1),
    agentProfileId: z.string().uuid(),
    assistantDisplayName: z.string().min(1),
    voiceId: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal("updateMeetingTurnLease"),
    meetingTurnId: z.string().uuid(),
    ownerUserId: userIdSchema,
    ownerParticipantIdentity: z.string().min(1),
    status: z.enum(["committed", "cancelled", "expired"]),
  }),
  z.object({
    action: z.literal("recordCreditUsage"),
    userId: userIdSchema,
    meetingId: meetingIdSchema,
    meetingTurnId: z.string().uuid(),
    actionLabel: z.string().min(1),
    trigger: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().nullable().optional(),
    participantIdentity: z.string().min(1),
    assistantDisplayName: z.string().min(1),
  }),
  z.object({
    action: z.literal("listAgentMemories"),
    userId: userIdSchema,
    agentProfileId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("listAgentConnectors"),
    userId: userIdSchema,
    agentProfileId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("listAgentToolPolicies"),
    agentProfileId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("appendTranscriptSegment"),
    meetingId: meetingIdSchema,
    speakerIdentity: z.string().min(1),
    speakerName: z.string().min(1),
    speakerUserId: z.string().uuid().optional(),
    speakerRole: z.enum(["human", "assistant", "system"]),
    source: z.string().min(1).optional(),
    sourceSegmentId: z.string().optional(),
    meetingTurnId: z.string().uuid().optional(),
    agentProfileId: z.string().uuid().optional(),
    agentOwnerUserId: z.string().uuid().optional(),
    voiceId: z.string().optional(),
    content: z.string(),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1).optional(),
  }),
  z.object({ action: z.literal("getTranscript"), meetingId: meetingIdSchema }),
  z.object({
    action: z.literal("listTranscriptSegmentsAfter"),
    meetingId: meetingIdSchema,
    createdAt: z.string().min(1),
    segmentId: z.string().uuid(),
    limit: z.number().int().positive().optional(),
  }),
]);

function isAuthorized(request: FastifyRequest): boolean {
  return matchesInternalSecret({
    header: request.headers["x-assistant-service-secret"],
    expected: apiEnv.ASSISTANT_SERVICE_SECRET,
  });
}

function activeTurnFromError(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "activeTurn" in error) {
    return error.activeTurn;
  }

  return null;
}

function transcriptSegmentSource(
  source: string | undefined,
):
  | "legacy-transcript"
  | "livekit-python-live"
  | "livekit-python-postcall"
  | "meeting-agent-assistant"
  | "meeting-agent-user"
  | "manual-note"
  | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (
    source === "legacy-transcript" ||
    source === "livekit-python-live" ||
    source === "livekit-python-postcall" ||
    source === "meeting-agent-assistant" ||
    source === "meeting-agent-user" ||
    source === "manual-note"
  ) {
    return source;
  }

  throw new Error(UNKNOWN_TRANSCRIPT_SEGMENT_SOURCE_MESSAGE);
}

async function appendMeetingAgentTranscriptSegment(
  input: Extract<z.infer<typeof requestSchema>, { action: "appendTranscriptSegment" }>,
): Promise<unknown> {
  return repositories().appendTranscriptSegment({
    meetingId: input.meetingId,
    speakerIdentity: input.speakerIdentity,
    speakerName: input.speakerName,
    speakerUserId: input.speakerUserId,
    speakerRole: input.speakerRole,
    source: transcriptSegmentSource(input.source),
    sourceSegmentId: input.sourceSegmentId,
    meetingTurnId: input.meetingTurnId,
    agentProfileId: input.agentProfileId,
    agentOwnerUserId: input.agentOwnerUserId,
    voiceId: input.voiceId,
    content: input.content,
    startedAt: new Date(input.startedAt),
    endedAt: input.endedAt === undefined ? undefined : new Date(input.endedAt),
  });
}

/**
 * Meeting-ask credits come from the workspace the asker filed this meeting
 * under, or their active workspace when no filing exists. Without a workspace
 * the charge can only use legacy per-user grants, so members of a paying
 * workspace were refused the assistant.
 */
async function meetingAskCreditWorkspaceId(input: { meetingId: string; userId: string }): Promise<string | null> {
  const repository = repositories();
  const user = await repository.getUserById(input.userId);
  if (user === null) {
    return null;
  }

  return repository.getMeetingAttendeeWorkspace({
    meetingId: input.meetingId,
    userId: input.userId,
    hostWorkspaceId: user.workspaceId,
  });
}

async function recordMeetingAskCredit(
  input: Extract<z.infer<typeof requestSchema>, { action: "recordCreditUsage" }>,
): Promise<unknown> {
  return repositories().recordAiCreditUsageEvent({
    userId: input.userId,
    workspaceId: await meetingAskCreditWorkspaceId(input),
    meetingId: input.meetingId,
    actionType: MEETING_ASK_ACTION_TYPE,
    actionLabel: input.actionLabel,
    provider: input.provider,
    model: input.model,
    idempotencyKey: `credit:meeting-agent:${input.meetingTurnId}:${MEETING_ASK_ACTION_TYPE}`,
    requireAvailableCredits: true,
    metadata: {
      meetingTurnId: input.meetingTurnId,
      trigger: input.trigger,
      participantIdentity: input.participantIdentity,
      assistantDisplayName: input.assistantDisplayName,
    },
  });
}

type MeetingAgentRequest = z.infer<typeof requestSchema>;
type CreditUsageRequest = Extract<
  MeetingAgentRequest,
  { action: "reserveCreditUsage" | "settleCreditUsage" | "releaseCreditUsage" }
>;
function isCreditUsageRequest(input: MeetingAgentRequest): input is CreditUsageRequest {
  return (
    input.action === "reserveCreditUsage" ||
    input.action === "settleCreditUsage" ||
    input.action === "releaseCreditUsage"
  );
}
async function runCreditUsageAction(input: CreditUsageRequest): Promise<unknown> {
  if (input.action === "reserveCreditUsage") {
    const authorization = await reserveProviderUsage({
      ...input,
      source: input.feature,
      actionType: MEETING_ASK_ACTION_TYPE,
    });

    return {
      reservationId: authorization.reservationId,
      workspaceId: authorization.workspaceId,
      /** @external Python reservation protocol */
      included: authorization.metadata.included,
      maxInputTokens: authorization.metadata.maxInputTokens,
      maxOutputTokens: authorization.metadata.maxOutputTokens,
    };
  }
  if (input.action === "settleCreditUsage") {
    const authorization = await loadProviderAuthorization(input);
    await settleProviderUsage({
      authorization,
      totalUsage: {
        inputTokens: input.usage.input_tokens,
        outputTokens: input.usage.output_tokens,
        cachedInputTokens: input.usage.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteInputTokens: input.usage.input_tokens_details?.cache_write_tokens ?? 0,
      },
    });

    return { isSettled: true };
  }
  await loadProviderAuthorization(input);
  await repositories().releasePlanCredits(input);

  return { isReleased: true };
}

async function runMeetingAgentAction(input: Exclude<MeetingAgentRequest, CreditUsageRequest>): Promise<unknown> {
  const repository = repositories();
  if (input.action === "getMeeting") {
    return repository.getMeetingById(input.meetingId);
  }
  if (input.action === "listParticipants") {
    return repository.listParticipantsForMeeting(input.meetingId);
  }
  if (input.action === "getSummary") {
    return repository.getSummaryForMeeting(input.meetingId);
  }
  if (input.action === "listActionItems") {
    return repository.listActionItemsForMeeting(input.meetingId);
  }
  if (input.action === "createActionItem") {
    return repository.createActionItemForMeeting({
      meetingId: input.meetingId,
      text: input.text,
      assignee: input.assignee,
    });
  }
  if (input.action === "ensureDefaultAgentProfile") {
    return repository.ensureDefaultAgentProfileForUser({
      userId: input.userId,
      displayName: input.displayName,
      voiceId: input.voiceId,
      llmModel: input.llmModel,
    });
  }
  if (input.action === "createMeetingTurnLease") {
    return repository.createMeetingTurnLease({
      meetingId: input.meetingId,
      ownerUserId: input.ownerUserId,
      ownerParticipantIdentity: input.ownerParticipantIdentity,
      agentProfileId: input.agentProfileId,
      assistantDisplayName: input.assistantDisplayName,
      voiceId: input.voiceId,
    });
  }
  if (input.action === "updateMeetingTurnLease") {
    return repository.updateMeetingTurnLease(input.meetingTurnId, {
      status: input.status,
      ownerUserId: input.ownerUserId,
      ownerParticipantIdentity: input.ownerParticipantIdentity,
    });
  }
  if (input.action === "recordCreditUsage") {
    return recordMeetingAskCredit(input);
  }
  if (input.action === "listAgentMemories") {
    return repository.listAgentMemoriesForUser(input.userId, input.agentProfileId);
  }
  if (input.action === "listAgentConnectors") {
    return repository.listAgentConnectorsForUser(input.userId, input.agentProfileId);
  }
  if (input.action === "listAgentToolPolicies") {
    return repository.listAgentToolPolicies(input.agentProfileId);
  }
  if (input.action === "appendTranscriptSegment") {
    return appendMeetingAgentTranscriptSegment(input);
  }
  if (input.action === "getTranscript") {
    return repository.getTranscriptForMeeting(input.meetingId);
  }

  return repository.listTranscriptSegmentsAfter({
    meetingId: input.meetingId,
    createdAt: new Date(input.createdAt),
    segmentId: input.segmentId,
    limit: input.limit,
  });
}

async function handleMeetingAgentRequest(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (!isAuthorized(request)) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED_INTERNAL_REQUEST });
  }
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_MEETING_AGENT_REQUEST });
  }
  try {
    const result = await (isCreditUsageRequest(parsed.data)
      ? runCreditUsageAction(parsed.data)
      : runMeetingAgentAction(parsed.data));

    return { result };
  } catch (error) {
    if (error instanceof Error && error.name === ACTIVE_MEETING_TURN_NAME) {
      return reply.code(HTTP_CONFLICT).send({
        code: ACTIVE_TURN_CODE,
        activeTurn: activeTurnFromError(error),
      });
    }
    if (isInsufficientCreditsError(error)) {
      return reply.code(HTTP_PAYMENT_REQUIRED).send({ code: INSUFFICIENT_CREDITS_CODE });
    }
    if (error instanceof UnboundedProviderUsageError) {
      return reply.code(HTTP_PAYMENT_REQUIRED).send({ code: UNBOUNDED_USAGE_CODE, message: error.message });
    }
    if (error instanceof ProviderAdmissionError) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: error.message });
    }
    throw error;
  }
}

export async function internalMeetingAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/meeting-agent", handleMeetingAgentRequest);
}
