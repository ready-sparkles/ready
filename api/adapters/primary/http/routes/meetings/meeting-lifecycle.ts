import { MeetingContentCryptoError, SKIPPED_PROTECTED_ROW_MESSAGE } from "@readymeet/db/domain/content-key-errors";
import { MeetingConfidentialityRequiredError } from "@readymeet/db/domain/persistence-errors";
import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  appendTranscriptSegmentRequestSchema,
  buildMeetingNotesPreview,
  createInstantMeetingRequestSchema,
  createInstantMeetingResponseSchema,
  createMeetingRequestSchema,
  createMeetingResponseSchema,
  endMeetingRequestSchema,
  guestMeetingNotesResponseSchema,
  mediaQualityReportSchema,
  meetingDetailResponseSchema,
  meetingListResponseSchema,
  meetingLiveResponseSchema,
  meetingLookupResponseSchema,
  meetingNotesViewResponseSchema,
  stripSummaryTaskSection,
  updateMeetingConfidentialityRequestSchema,
  updateMeetingConfidentialityResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { voiceWebResearchRunToPanelPayload } from "../../../../../application/agent-tool-broker";
import {
  ensureAlwaysAvailableCapabilityRecommendationsForMeeting,
  filterVisibleCapabilityRecommendations,
} from "../../../../../application/always-available-capabilities";
import { regenerateCreditBlockedNotesOnOpen } from "../../../../../application/fallback-notes-regeneration";
import { getLinearTaskReviewIfEnabled } from "../../../../../application/linear-task-review-service";
import type { MeetingViewerRole } from "../../../../../application/meeting-dto";
import {
  getSyncedCallInForMeeting,
  syncMeetingCallInInBackground,
  toMeetingDTO,
  toMeetingDTOForViewer,
  toMeetingLinkDTO,
  waitForSyncedCallInForMeeting,
} from "../../../../../application/meeting-dto";
import {
  ensureMeetingAssistantCoverage,
  scheduleAssistantCoverageRecheck,
  scheduleMeetingFinalizationIfIdle,
} from "../../../../../application/meeting-lifecycle";
import {
  resolveGuestMeetingNotesAccess,
  resolveMeetingNotesAccess,
} from "../../../../../application/meeting-notes-access";
import { isPostgresUniqueConstraintError } from "../../../../../application/postgres-constraint";
import { ensureGuestMeetingPreviewInRequest } from "../../../../../application/run-ai-work";
import { toGuestVisibleSummary } from "../../../../../application/snapshot-artifacts";
import { apiEnv } from "../../../../../composition/env";
import { generateUniqueMeetingLinkCode } from "../../../../../composition/meeting-link-codes";
import { getGuestMeetingConclusions, getGuestMeetingPreviewTitle } from "../../../../../domain/guest-meeting-preview";
import { projectGuestMeetingTasksStatus } from "../../../../../domain/guest-meeting-tasks";
import { buildMeetingPreparationPreview } from "../../../../../domain/meeting-preparation-preview";
import { repositories } from "../../../../../ports/repository-runtime";
import { createLiveKitToken, deleteLiveKitRoom } from "../../../../secondary/livekit/livekit";
import { markParticipantLeftIfDisconnected } from "../../../../secondary/livekit/livekit-participant-presence";
import {
  startLiveMeetingTranscription,
  stopLiveMeetingTranscription,
} from "../../../../secondary/undici/assistant-client";
import { requireAuth } from "../../plugins/auth";
import {
  getMeetingAccess,
  getMeetingHostingAccessForUser,
  isAuthorizedMeetingHost,
  isTrustedMeetingUser,
  requireMeetingAccess,
} from "../../support/meeting-access";
import { canChangeMeetingConfidentiality } from "../../support/workspace-access";

import { calendarAddonRoutes } from "./calendar-addon";
import { getHiddenPostMeetingDisposition, getMeetingTasksStatusPayload, toMeetingRuntimeDTO } from "./shared";

type ActiveCapability = Awaited<ReturnType<RepositoryPort["listActiveCapabilities"]>>[number];
type AuthenticatedUserRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getUserById"]>>>;
const AGENT_INTRO_CREATOR_UNIQUE_CONSTRAINT = "meetings_agent_intro_creator_uidx";
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_TOO_MANY_REQUESTS = 429;
const JOIN_BOOKKEEPING_ATTEMPT_MAX = 10;
const CLIENT_REMOTE_IDENTITY_MAX_LENGTH = 255;
const GUEST_HUMAN_SEGMENT_MIN_CONTENT_LENGTH = 40;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_MEETING_NOT_FOUND = "Meeting not found";
const MESSAGE_MEETING_PARTICIPANTS_ONLY = "This meeting is available only to participants.";
const MESSAGE_GUEST_MEETING_SESSION_REQUIRED = "Guest meeting session required.";
const MESSAGE_MEETING_ENDED_CANNOT_JOIN = "This meeting has ended and can no longer be joined.";
const MESSAGE_MEETING_ENDED_CANNOT_TRANSCRIBE = "This meeting has ended and can no longer start transcription.";
const MESSAGE_FAILED_START_LIVE_TRANSCRIPTION = "Failed to start live transcription in assistant service";
const MESSAGE_FAILED_STOP_LIVE_TRANSCRIPTION = "Failed to stop live transcription in assistant service";
const MESSAGE_MEETING_ENDED_CANNOT_APPEND_TRANSCRIPT =
  "This meeting has ended and can no longer accept transcript updates.";
const MESSAGE_ONLY_PARTICIPANTS_CAN_LEAVE = "Only meeting participants can leave this meeting.";
const MESSAGE_ONLY_ORGANIZER_END_FOR_ALL = "Only the meeting organizer can end the meeting for everyone";
const MESSAGE_ONLY_ENDED_MEETINGS_DELETABLE = "Only ended meetings can be deleted";
const MESSAGE_NOT_A_PARTICIPANT = "You are not a participant of this meeting";
const MESSAGE_CONFIDENTIALITY_BOOLEAN_REQUIRED = "isConfidential must be a boolean.";
const MESSAGE_CONFIDENTIALITY_ENDED_ORGANIZER_ONLY =
  "After a meeting ends, only the organizer can change confidentiality.";
const MESSAGE_CONFIDENTIALITY_ORGANIZER_OR_ADMIN_ONLY =
  "Only the organizer or a participating workspace admin can change confidentiality.";
const MESSAGE_INTERNAL_MEETINGS_ALWAYS_CONFIDENTIAL =
  "Internal one-to-one meetings are always confidential and cannot be unlocked.";
const meetingRoomNameParamsSchema = z.object({ roomName: z.string() });
const transcriptSpeakerRoleSchema = z.enum(["human", "assistant", "system"]);
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_CLIENT_DIAGNOSTIC_DURATION_CAP = 30;
const CLIENT_DIAGNOSTIC_MAX_DURATION_MS =
  MINUTES_PER_CLIENT_DIAGNOSTIC_DURATION_CAP * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const DIAGNOSTIC_ERROR_NAME_MAX_LENGTH = 120;
const DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH = 500;
const MEETING_DETAIL_WEB_RESEARCH_LIMIT = 20;
const MEETING_DETAIL_RESEARCH_RUN_LIMIT = 50;
const MEETING_PLAN_REQUIRED_CODE = "meeting_plan_required";
const AGENT_INTRO_NOT_AVAILABLE_CODE = "agent_intro_not_available";
const MESSAGE_MISSING_AUTH_USER = "Missing auth user";
const MESSAGE_MEETING_ACCESS_REQUIRED = "Meeting access is required to create more meeting rooms.";
const MESSAGE_TOO_MANY_MEETING_DIAGNOSTIC_REPORTS = "Too many meeting diagnostic reports";
const MESSAGE_AGENT_INTRO_NOT_AVAILABLE = "The agent intro is no longer available.";
const DIAGNOSTIC_IP_RATE_LIMIT_MAX = 120;
const AUTHENTICATED_DIAGNOSTIC_RATE_LIMIT_MAX = 60;
// Periodic media-quality telemetry has its own buckets so it can never starve
// join/disconnect diagnostics. Clients flush at most every 30s plus adjustments.
const MEDIA_QUALITY_IP_RATE_LIMIT_MAX = 300;
const AUTHENTICATED_MEDIA_QUALITY_RATE_LIMIT_MAX = 20;
const meetingMediaDiagnosticSchema = z
  .object({
    kind: z.enum(["camera", "microphone", "unknown"]),
    phase: z.enum(["join-acquire", "join-publish", "room-enable", "room-device-event"]),
    failure: z.enum(["permission-denied", "not-found", "device-in-use", "other"]),
    errorName: z.string().trim().max(DIAGNOSTIC_ERROR_NAME_MAX_LENGTH).optional(),
    errorMessage: z.string().trim().max(DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH).optional(),
    fallbackErrorName: z.string().trim().max(DIAGNOSTIC_ERROR_NAME_MAX_LENGTH).optional(),
    fallbackErrorMessage: z.string().trim().max(DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH).optional(),
    /** @external client media diagnostic wire field */
    selectedDevice: z.boolean(),
    /** @external client media diagnostic wire field */
    fallbackAttempted: z.boolean(),
    /** @external client media diagnostic wire field */
    recovered: z.boolean(),
  })
  .strict();

const clientFailureSchema = z.enum(["permission-denied", "not-found", "device-in-use", "other"]);
const clientPermissionSchema = z.enum(["granted", "denied", "prompt", "unknown", "unsupported"]);
const clientConnectionStateSchema = z.enum([
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
  "signalReconnecting",
]);
const clientDisconnectReasonSchema = z.enum([
  "unknown",
  "client-initiated",
  "duplicate-identity",
  "server-shutdown",
  "participant-removed",
  "room-deleted",
  "state-mismatch",
  "join-failure",
  "migration",
  "signal-close",
  "room-closed",
  "user-unavailable",
  "user-rejected",
  "sip-trunk-failure",
  "connection-timeout",
  "media-failure",
  "agent-error",
]);
const clientTrackKindSchema = z.enum(["camera", "microphone", "screen-share", "screen-share-audio", "unknown"]);
const clientErrorShape = {
  failure: clientFailureSchema,
  errorName: z.string().trim().min(1).max(DIAGNOSTIC_ERROR_NAME_MAX_LENGTH),
  errorMessage: z.string().trim().min(1).max(DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH),
};
const optionalClientErrorShape = {
  failure: clientFailureSchema.optional(),
  errorName: z.string().trim().min(1).max(DIAGNOSTIC_ERROR_NAME_MAX_LENGTH).optional(),
  errorMessage: z.string().trim().min(1).max(DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH).optional(),
};
const clientDurationSchema = z.number().int().min(0).max(CLIENT_DIAGNOSTIC_MAX_DURATION_MS);

const meetingClientDiagnosticSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("join-started"),
      phase: z.literal("token"),
      outcome: z.literal("started"),
      microphoneRequested: z.boolean(),
      cameraRequested: z.boolean(),
      microphonePermission: clientPermissionSchema,
      cameraPermission: clientPermissionSchema,
      selectedDevice: z.boolean(),
    })
    .strict(),
  z
    .object({
      event: z.literal("join-media-result"),
      phase: z.literal("publish"),
      outcome: z.enum(["succeeded", "degraded"]),
      microphoneRequested: z.boolean(),
      cameraRequested: z.boolean(),
      microphoneAcquired: z.boolean(),
      cameraAcquired: z.boolean(),
      microphonePublished: z.boolean(),
      cameraPublished: z.boolean(),
      microphoneEnabled: z.boolean(),
      cameraEnabled: z.boolean(),
      microphonePermission: clientPermissionSchema,
      cameraPermission: clientPermissionSchema,
      durationMs: clientDurationSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("join-succeeded"),
      phase: z.literal("bookkeeping"),
      outcome: z.enum(["succeeded", "degraded"]),
      microphoneRequested: z.boolean(),
      cameraRequested: z.boolean(),
      microphoneEnabled: z.boolean(),
      cameraEnabled: z.boolean(),
      connectionState: clientConnectionStateSchema,
      durationMs: clientDurationSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("join-failed"),
      phase: z.enum(["token", "acquire", "connect", "publish", "bookkeeping"]),
      outcome: z.literal("failed"),
      microphoneRequested: z.boolean(),
      cameraRequested: z.boolean(),
      microphonePermission: clientPermissionSchema,
      cameraPermission: clientPermissionSchema,
      durationMs: clientDurationSchema,
      ...clientErrorShape,
    })
    .strict(),
  z
    .object({
      event: z.literal("join-bookkeeping-failed"),
      phase: z.literal("bookkeeping"),
      outcome: z.literal("failed"),
      attempt: z.number().int().min(1).max(JOIN_BOOKKEEPING_ATTEMPT_MAX),
      durationMs: clientDurationSchema,
      ...clientErrorShape,
    })
    .strict(),
  z
    .object({
      event: z.literal("media-control"),
      phase: z.literal("in-room"),
      outcome: z.enum(["enabled", "disabled", "failed"]),
      kind: z.enum(["camera", "microphone"]),
      microphoneEnabled: z.boolean().optional(),
      cameraEnabled: z.boolean().optional(),
      selectedDevice: z.boolean(),
      ...optionalClientErrorShape,
    })
    .strict(),
  z
    .object({
      event: z.literal("media-device-change"),
      phase: z.literal("in-room"),
      outcome: z.enum(["succeeded", "failed"]),
      kind: z.enum(["camera", "microphone", "audio-output"]),
      microphoneEnabled: z.boolean().optional(),
      cameraEnabled: z.boolean().optional(),
      selectedDevice: z.boolean(),
      ...optionalClientErrorShape,
    })
    .strict(),
  z
    .object({
      event: z.literal("connection-state"),
      phase: z.enum(["connect", "in-room"]),
      outcome: z.literal("changed"),
      connectionState: clientConnectionStateSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("connection-quality"),
      phase: z.literal("in-room"),
      outcome: z.literal("degraded"),
      connectionQuality: z.enum(["poor", "lost"]),
      remoteParticipantIdentity: z.string().trim().min(1).max(CLIENT_REMOTE_IDENTITY_MAX_LENGTH).optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal("track-subscription-failed"),
      phase: z.literal("in-room"),
      outcome: z.literal("failed"),
      kind: clientTrackKindSchema,
      remoteParticipantIdentity: z.string().trim().min(1).max(CLIENT_REMOTE_IDENTITY_MAX_LENGTH),
      trackSid: z.string().trim().min(1).max(CLIENT_REMOTE_IDENTITY_MAX_LENGTH),
      ...clientErrorShape,
    })
    .strict(),
  z
    .object({
      event: z.literal("track-stream-state"),
      phase: z.literal("in-room"),
      outcome: z.literal("degraded"),
      kind: clientTrackKindSchema,
      remoteParticipantIdentity: z.string().trim().min(1).max(CLIENT_REMOTE_IDENTITY_MAX_LENGTH),
      trackSid: z.string().trim().min(1).max(CLIENT_REMOTE_IDENTITY_MAX_LENGTH),
      trackState: z.literal("paused"),
    })
    .strict(),
  z
    .object({
      event: z.literal("audio-playback"),
      phase: z.literal("in-room"),
      outcome: z.enum(["succeeded", "failed"]),
    })
    .strict(),
  z
    .object({
      event: z.literal("video-playback"),
      phase: z.literal("in-room"),
      outcome: z.enum(["succeeded", "failed"]),
    })
    .strict(),
  z
    .object({
      event: z.literal("room-disconnected"),
      phase: z.enum(["connect", "in-room"]),
      outcome: z.literal("changed"),
      connectionState: z.literal("disconnected"),
      disconnectReason: clientDisconnectReasonSchema,
    })
    .strict(),
]);

const LOG_IDENTIFIER_HASH_LENGTH = 16;

const CLIENT_ERROR_NAME_ALLOWLIST = new Set([
  "AbortError",
  "ApiError",
  "ConstraintNotSatisfiedError",
  "DOMException",
  "DevicesNotFoundError",
  "Error",
  "LiveKitSubscriptionError",
  "MediaDeviceError",
  "MeetingCameraFallbackError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "OverconstrainedError",
  "SecurityError",
  "TrackStartError",
  "TypeError",
]);

function normalizeClientErrorName(value: string | undefined) {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return CLIENT_ERROR_NAME_ALLOWLIST.has(value) ? value : "OtherError";
}

function normalizeClientEnvironment(userAgent: string | undefined) {
  if (userAgent === undefined || userAgent.length === 0) {
    return { browser: "unknown", platform: "unknown", isMobile: false };
  }
  const browser = /Edg\//.test(userAgent)
    ? "edge"
    : /(?:Chrome|CriOS)\//.test(userAgent)
      ? "chrome"
      : /(?:Firefox|FxiOS)\//.test(userAgent)
        ? "firefox"
        : /Safari\//.test(userAgent)
          ? "safari"
          : "other";
  const platform = /iPhone|iPad|iPod/.test(userAgent)
    ? "ios"
    : /Android/.test(userAgent)
      ? "android"
      : /Windows/.test(userAgent)
        ? "windows"
        : /Macintosh|Mac OS X/.test(userAgent)
          ? "macos"
          : /Linux/.test(userAgent)
            ? "linux"
            : "other";

  return {
    browser,
    platform,
    isMobile: /Mobile|Android|iPhone|iPad|iPod/.test(userAgent),
  };
}

function logIdentifier(value: string | undefined) {
  return value !== undefined && value.length !== 0
    ? createHash("sha256").update(value).digest("hex").slice(0, LOG_IDENTIFIER_HASH_LENGTH)
    : undefined;
}

function sanitizeMediaDiagnosticForLog(data: z.infer<typeof meetingMediaDiagnosticSchema>) {
  const { errorName, errorMessage, fallbackErrorName, fallbackErrorMessage, ...diagnostic } = data;

  return {
    ...diagnostic,
    errorName: normalizeClientErrorName(errorName),
    fallbackErrorName: normalizeClientErrorName(fallbackErrorName),
    hasErrorMessage: Boolean(errorMessage),
    hasFallbackErrorMessage: Boolean(fallbackErrorMessage),
  };
}

function sanitizeClientDiagnosticForLog(data: z.infer<typeof meetingClientDiagnosticSchema>) {
  const diagnostic: Record<string, unknown> = { ...data };
  const errorName = typeof diagnostic.errorName === "string" ? diagnostic.errorName : undefined;
  const errorMessage = typeof diagnostic.errorMessage === "string" ? diagnostic.errorMessage : undefined;
  const remoteParticipantIdentity =
    typeof diagnostic.remoteParticipantIdentity === "string" ? diagnostic.remoteParticipantIdentity : undefined;
  const trackSid = typeof diagnostic.trackSid === "string" ? diagnostic.trackSid : undefined;
  delete diagnostic.errorName;
  delete diagnostic.errorMessage;
  delete diagnostic.remoteParticipantIdentity;
  delete diagnostic.trackSid;

  return {
    ...diagnostic,
    errorName: normalizeClientErrorName(errorName),
    hasErrorMessage: Boolean(errorMessage),
    remoteParticipantKey: logIdentifier(remoteParticipantIdentity),
    trackKey: logIdentifier(trackSid),
  };
}

function authenticatedMeetingDiagnosticRateLimitKey(request: FastifyRequest) {
  const user = request.user;
  if (!user) {
    return `ip:${request.ip}`;
  }

  return user.tokenKind === "guest" ? `guest-session:${user.guestSessionId ?? user.id}` : `user:${user.id}`;
}

const meetingDiagnosticIpRateLimit = {
  max: DIAGNOSTIC_IP_RATE_LIMIT_MAX,
  timeWindow: "1 minute",
  groupId: "meeting-diagnostics-ip",
};

const meetingMediaQualityIpRateLimit = {
  max: MEDIA_QUALITY_IP_RATE_LIMIT_MAX,
  timeWindow: "1 minute",
  groupId: "meeting-media-quality-ip",
};

function toAuthenticatedUserDTO(user: AuthenticatedUserRecord) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    source: user.source,
    authProvider: null,
    plan: user.plan,
    hasCompletedFirstMeeting: user.hasCompletedFirstMeeting,
    hasCompletedAgentIntro: Boolean(user.agentIntroCompletedAt),
    /** @external auth user memory availability wire field */
    memoryAvailable: apiEnv.MEMORY_ENABLED,
    workspaceId: user.workspaceId,
    sessionVersion: user.sessionVersion,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

function toCapabilitySelectionCapability(capability: ActiveCapability) {
  return {
    key: capability.key,
    name: capability.name,
    description: capability.description,
    category: capability.category,
    applicableMeetingTypes: capability.applicableMeetingTypes,
    requiredSignals: capability.requiredSignals,
    exclusionSignals: capability.exclusionSignals,
    defaultPriority: capability.defaultPriority,
  };
}

function cleanSummaryBulletLine(line: string) {
  return line
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\s*\((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[-–]\s*(?:\d{1,2}:)?\d{1,2}:\d{2})?\)/g, "")
    .trim();
}

function getFirstSummaryBulletPreview(content: string | null | undefined) {
  if (content === null || content === undefined || content.length === 0) {
    return null;
  }

  const notesContent = stripSummaryTaskSection(content);
  const preview = notesContent
    .split("\n")
    .filter((line) => /^[-*•]\s+/.test(line.trim()) || /^\d+\.\s+/.test(line.trim()))
    .map((line) => cleanSummaryBulletLine(line))
    .find((line) => line.length !== 0);

  return preview ?? null;
}

function readAuthenticatedUser(request: FastifyRequest) {
  const user = request.user;
  if (!user) {
    throw new Error(MESSAGE_MISSING_AUTH_USER);
  }

  return user;
}

type MeetingLifecycleRateLimitHandler = (input: { request: FastifyRequest; reply: FastifyReply }) => Promise<void>;

type MeetingLifecycleRateLimitHandlers = {
  enforceAuthenticatedMeetingDiagnosticRateLimit: MeetingLifecycleRateLimitHandler;
  enforceAuthenticatedMediaQualityRateLimit: MeetingLifecycleRateLimitHandler;
};

async function tryReuseExistingInstantMeeting(input: {
  intent: "standard" | "agent_intro";
  existingMeetingId: string | null | undefined;
  userId: string;
}) {
  if (input.intent !== "standard" || input.existingMeetingId === null || input.existingMeetingId === undefined) {
    return null;
  }
  const existingMeeting = await repositories().getMeetingById(input.existingMeetingId);
  if (!existingMeeting || existingMeeting.status === "ended") {
    return null;
  }
  if (!(await isTrustedMeetingUser({ meeting: existingMeeting, userId: input.userId }))) {
    return null;
  }
  const existingLink = await repositories().getMeetingLinkForMeeting(existingMeeting.id);
  if (!existingLink || existingLink.status !== "active") {
    return null;
  }

  return { meeting: existingMeeting, meetingLink: existingLink };
}

async function resolveAgentIntroUserForInstantMeeting(input: { intent: "standard" | "agent_intro"; userId: string }) {
  if (input.intent !== "agent_intro") {
    return null;
  }
  const [freshUser, hasCreatedStandardMeeting] = await Promise.all([
    repositories().getUserById(input.userId),
    repositories().hasUserCreatedStandardMeeting(input.userId),
  ]);
  if (
    !freshUser ||
    freshUser.agentIntroCompletedAt ||
    freshUser.hasCompletedFirstMeeting ||
    hasCreatedStandardMeeting
  ) {
    return null;
  }

  return freshUser;
}

type InstantMeetingLinkPair = Awaited<ReturnType<RepositoryPort["createMeetingLinkWithInitialMeeting"]>>;

async function createOrReuseInstantMeetingPair(input: {
  intent: "standard" | "agent_intro";
  reusedPair: InstantMeetingLinkPair | null;
  title: string | undefined;
  createdByUserId: string;
  workspaceId: string;
}) {
  try {
    return (
      input.reusedPair ??
      (await repositories().createMeetingLinkWithInitialMeeting({
        title: input.intent === "agent_intro" ? "Meet your agent" : (input.title ?? "Instant Meeting"),
        code: await generateUniqueMeetingLinkCode(),
        createdByUserId: input.createdByUserId,
        workspaceId: input.workspaceId,
        kind: input.intent,
      }))
    );
  } catch (error) {
    if (
      input.intent === "agent_intro" &&
      isPostgresUniqueConstraintError({ error, constraint: AGENT_INTRO_CREATOR_UNIQUE_CONSTRAINT })
    ) {
      return null;
    }
    throw error;
  }
}

async function buildInstantMeetingSuccessPayload(input: {
  request: FastifyRequest;
  user: NonNullable<FastifyRequest["user"]>;
  intent: "standard" | "agent_intro";
  meeting: InstantMeetingLinkPair["meeting"];
  meetingLink: InstantMeetingLinkPair["meetingLink"];
  reusedPair: InstantMeetingLinkPair | null;
  introUser: AuthenticatedUserRecord | null;
}) {
  const { request, user, intent, meeting, meetingLink, reusedPair, introUser } = input;
  if (intent === "standard") {
    syncMeetingCallInInBackground({
      meeting,
      meetingLink,
      logger: request.log,
    });
  }
  const callIn = intent === "standard" && reusedPair ? await getSyncedCallInForMeeting({ meeting, meetingLink }) : null;
  const meetingLinkWithCallIn = {
    ...meetingLink,
    callIn,
  };

  await repositories().recordMeetingAttendeeWorkspace({
    meetingId: meeting.id,
    userId: user.id,
    workspaceId: user.workspaceId,
  });
  const livekitToken = await createLiveKitToken({
    roomName: meeting.roomName,
    participantName: user.displayName,
    participantIdentity: `${user.id}:${randomUUID()}`,
    participantUserId: user.id,
    participantAvatarUrl: user.avatarUrl,
    participantMetadata: {
      kind: "authenticated",
      meetingId: meeting.id,
    },
    canPublishData: true,
  });

  const updatedIntroUser =
    intent === "agent_intro" && introUser ? await repositories().markUserAgentIntroCompleted(introUser.id) : null;
  const userForResponse = updatedIntroUser ? toAuthenticatedUserDTO(updatedIntroUser) : undefined;

  return createInstantMeetingResponseSchema.parse({
    meeting: toMeetingDTO({
      ...meeting,
      meetingLink: meetingLinkWithCallIn,
    }),
    meetingLink: toMeetingLinkDTO(meetingLinkWithCallIn),
    /** @external instant meeting reused wire field */
    reused: reusedPair !== null,
    livekit: {
      token: livekitToken,
      wsUrl: apiEnv.LIVEKIT_URL,
      roomName: meeting.roomName,
    },
    user: userForResponse,
  });
}

async function handlePostInstantMeetingRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { request, reply } = input;
  const parsed = createInstantMeetingRequestSchema.safeParse(request.body);
  if (!parsed.success || request.user === undefined) {
    return reply.code(HTTP_BAD_REQUEST).send({
      message: parsed.success ? MESSAGE_MISSING_AUTH_USER : parsed.error.message,
    });
  }

  const authenticatedUser = request.user;
  const intent = parsed.data.intent;

  const introUser = await resolveAgentIntroUserForInstantMeeting({ intent, userId: request.user.id });
  if (intent === "agent_intro" && !introUser) {
    return reply.code(HTTP_CONFLICT).send({
      code: AGENT_INTRO_NOT_AVAILABLE_CODE,
      message: MESSAGE_AGENT_INTRO_NOT_AVAILABLE,
    });
  }

  const reusedPair = await tryReuseExistingInstantMeeting({
    intent,
    existingMeetingId: parsed.data.existingMeetingId,
    userId: authenticatedUser.id,
  });
  if (intent === "standard" && !reusedPair) {
    const meetingAccess = await getMeetingHostingAccessForUser(request.user.id);
    if (!meetingAccess.canCreateStandardMeeting) {
      return reply.code(HTTP_FORBIDDEN).send({
        code: MEETING_PLAN_REQUIRED_CODE,
        message: MESSAGE_MEETING_ACCESS_REQUIRED,
      });
    }
  }
  const createdPair = await createOrReuseInstantMeetingPair({
    intent,
    reusedPair,
    title: parsed.data.title,
    createdByUserId: request.user.id,
    workspaceId: request.user.workspaceId,
  });
  if (!createdPair) {
    return reply.code(HTTP_CONFLICT).send({
      code: AGENT_INTRO_NOT_AVAILABLE_CODE,
      message: MESSAGE_AGENT_INTRO_NOT_AVAILABLE,
    });
  }
  const { meeting, meetingLink } = createdPair;

  return buildInstantMeetingSuccessPayload({
    request,
    user: authenticatedUser,
    intent,
    meeting,
    meetingLink,
    reusedPair,
    introUser,
  });
}

async function registerMeetingLifecycleCreateRoutes(app: FastifyInstance): Promise<void> {
  app.post("/meetings", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createMeetingRequestSchema.safeParse(request.body);
    if (!parsed.success || request.user === undefined) {
      return reply.code(HTTP_BAD_REQUEST).send({
        message: parsed.success ? MESSAGE_MISSING_AUTH_USER : parsed.error.message,
      });
    }

    const meetingAccess = await getMeetingHostingAccessForUser(request.user.id);
    if (!meetingAccess.canCreateStandardMeeting) {
      return reply.code(HTTP_FORBIDDEN).send({
        code: MEETING_PLAN_REQUIRED_CODE,
        message: MESSAGE_MEETING_ACCESS_REQUIRED,
      });
    }

    const meetingCode = await generateUniqueMeetingLinkCode();

    const { meeting, meetingLink } = await repositories().createMeetingLinkWithInitialMeeting({
      title: parsed.data.title,
      code: meetingCode,
      createdByUserId: request.user.id,
      workspaceId: request.user.workspaceId,
    });
    if (parsed.data.waitForCallIn !== true) {
      syncMeetingCallInInBackground({ meeting, meetingLink, logger: request.log });
    }
    const callIn =
      parsed.data.waitForCallIn === true
        ? await waitForSyncedCallInForMeeting({ input: { meeting, meetingLink, logger: request.log } })
        : await getSyncedCallInForMeeting({ meeting, meetingLink });
    const meetingLinkWithCallIn = {
      ...meetingLink,
      callIn,
    };

    return createMeetingResponseSchema.parse({
      meeting: toMeetingDTO({
        ...meeting,
        meetingLink: meetingLinkWithCallIn,
      }),
      meetingLink: toMeetingLinkDTO(meetingLinkWithCallIn),
    });
  });

  app.post("/meetings/instant", { preHandler: requireAuth }, async (request, reply) =>
    handlePostInstantMeetingRequest({ request, reply }),
  );
}

type MeetingAccessContext = ReturnType<typeof getMeetingAccess>;
type MeetingTranscriptBundle = NonNullable<Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>>>;

function toMeetingDetailTranscriptWire(transcriptData: Pick<MeetingTranscriptBundle, "transcript"> | null) {
  if (!transcriptData) {
    return null;
  }

  const metadata = transcriptData.transcript.metadata;
  const refinedAtFromMetadata =
    typeof metadata.refinedAt === "string"
      ? metadata.refinedAt
      : typeof metadata.finalizedAt === "string"
        ? metadata.finalizedAt
        : null;

  return {
    id: transcriptData.transcript.id,
    meetingId: transcriptData.transcript.meetingId,
    source: transcriptData.transcript.source,
    mode: typeof metadata.mode === "string" ? metadata.mode : "unknown",
    isFinal:
      transcriptData.transcript.source === "livekit-postcall" ||
      metadata.mode === "postcall-refined" ||
      metadata.mode === "agent-live-finalized" ||
      typeof metadata.finalizedAt === "string",
    refinedAt: refinedAtFromMetadata,
  };
}

function toMeetingDetailTranscriptSegments(transcriptData: MeetingTranscriptBundle | null) {
  return (
    transcriptData?.segments.map((segment) => ({
      id: segment.id,
      transcriptId: segment.transcriptId,
      speakerIdentity: segment.speakerIdentity,
      speakerUserId: segment.speakerUserId,
      speakerRole: transcriptSpeakerRoleSchema.parse(segment.speakerRole),
      speakerName: segment.speakerName,
      source: segment.source,
      sourceSegmentId: segment.sourceSegmentId,
      meetingTurnId: "meetingTurnId" in segment ? (segment.meetingTurnId ?? null) : null,
      agentProfileId: "agentProfileId" in segment ? (segment.agentProfileId ?? null) : null,
      agentOwnerUserId: "agentOwnerUserId" in segment ? (segment.agentOwnerUserId ?? null) : null,
      voiceId: "voiceId" in segment ? (segment.voiceId ?? null) : null,
      content: segment.content,
      startedAt: segment.startedAt.toISOString(),
      endedAt: segment.endedAt ? segment.endedAt.toISOString() : null,
    })) ?? []
  );
}

async function loadMeetingDetailParallelData(input: {
  meetingId: string;
  meeting: MeetingAccessContext["meeting"];
  request: FastifyRequest;
  isGuestMeetingSession: boolean;
  postMeetingDisposition: ReturnType<typeof getHiddenPostMeetingDisposition>;
}) {
  const { meetingId, meeting, request, isGuestMeetingSession, postMeetingDisposition } = input;
  const authenticatedUserId = readAuthenticatedUser(request).id;

  return Promise.all([
    repositories().getTranscriptForMeeting(meetingId),
    repositories().getMeetingRuntimeState(meetingId),
    repositories().getSummaryForMeeting(meetingId),
    isGuestMeetingSession ? Promise.resolve([]) : repositories().listActionItemsForMeeting(meetingId),
    isGuestMeetingSession ? Promise.resolve(null) : repositories().getMeetingTaskListForMeeting(meetingId),
    isGuestMeetingSession || authenticatedUserId !== meeting.createdByUserId
      ? Promise.resolve(null)
      : getLinearTaskReviewIfEnabled(meetingId, meeting.createdByUserId),
    postMeetingDisposition || isGuestMeetingSession
      ? Promise.resolve([])
      : ensureAlwaysAvailableCapabilityRecommendationsForMeeting(meetingId),
    postMeetingDisposition || isGuestMeetingSession ? Promise.resolve([]) : repositories().listActiveCapabilities(),
    isGuestMeetingSession
      ? Promise.resolve([])
      : repositories().listVoiceWebResearchRunsForMeeting({ meetingId, limit: MEETING_DETAIL_WEB_RESEARCH_LIMIT }),
    isGuestMeetingSession
      ? Promise.resolve([])
      : repositories().listMeetingResearchRunsForMeeting({ meetingId, limit: MEETING_DETAIL_RESEARCH_RUN_LIMIT }),
  ]);
}

async function resolveMeetingDetailConfidentialityForViewer(input: {
  meeting: MeetingAccessContext["meeting"];
  request: FastifyRequest;
  viewerRole: MeetingViewerRole;
  isGuestMeetingSession: boolean;
}) {
  const userId = readAuthenticatedUser(input.request).id;
  const isConfidentialityRequired = await repositories().isMeetingConfidentialityRequired(input.meeting.id);
  if (isConfidentialityRequired || input.isGuestMeetingSession) {
    return { isConfidentialityRequired, canViewerChangeConfidentiality: false };
  }

  const canViewerChangeConfidentiality = canChangeMeetingConfidentiality({
    meeting: input.meeting,
    userId,
    isParticipant: input.viewerRole === "participant" || input.viewerRole === "host",
    isWorkspaceAdmin: await repositories().isActiveWorkspaceAdmin({
      workspaceId: input.meeting.workspaceId,
      userId,
    }),
  });

  return { isConfidentialityRequired, canViewerChangeConfidentiality };
}

/** Opening the meeting must never fail because a background notes retry could not be claimed. */
async function regenerateCreditBlockedNotesSafely(input: {
  meetingId: string;
  summary: { model: string; content: string } | null;
  logger: FastifyRequest["log"];
}): Promise<void> {
  try {
    await regenerateCreditBlockedNotesOnOpen(input);
  } catch (error) {
    input.logger.warn({ error, meetingId: input.meetingId }, "Could not start credit-blocked notes regeneration");
  }
}

/** An entitled host opening an ended meeting retries notes that were only blocked by credits. */
async function resolveNotesAccessAndRetryCreditBlockedNotes(input: {
  request: FastifyRequest;
  meeting: MeetingAccessContext["meeting"];
  viewerRole: MeetingViewerRole;
  summary: { model: string; content: string } | null;
}) {
  const userId = readAuthenticatedUser(input.request).id;
  const notesAccess = await resolveMeetingNotesAccess({
    meeting: input.meeting,
    viewerRole: input.viewerRole,
    userId,
    summary: input.summary,
  });
  // The detail route grants participant access, so the host is recognised from the meeting itself.
  if (
    input.meeting.status === "ended" &&
    !notesAccess.locked &&
    (await isAuthorizedMeetingHost({ meeting: input.meeting, userId }))
  ) {
    await regenerateCreditBlockedNotesSafely({
      meetingId: input.meeting.id,
      summary: input.summary,
      logger: input.request.log,
    });
  }

  return notesAccess;
}

function toMeetingSummaryWire(
  summary: { id: string; meetingId: string; content: string; model: string; generatedAt: Date } | null,
) {
  return summary
    ? {
        id: summary.id,
        meetingId: summary.meetingId,
        content: summary.content,
        model: summary.model,
        generatedAt: summary.generatedAt.toISOString(),
      }
    : null;
}

type MeetingSummaryRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getSummaryForMeeting"]>>>;

/** Fields shared by the full detail and the notes-first view, so both apply the same notes-access rules. */
async function buildMeetingNotesWire(input: {
  request: FastifyRequest;
  meeting: MeetingAccessContext["meeting"];
  viewerRole: MeetingViewerRole;
  runtimeState: Awaited<ReturnType<RepositoryPort["getMeetingRuntimeState"]>>;
  transcriptData: Pick<MeetingTranscriptBundle, "transcript"> | null;
  summary: MeetingSummaryRecord | null;
  actionItems: Awaited<ReturnType<RepositoryPort["listActionItemsForMeeting"]>>;
  tasks: Awaited<ReturnType<RepositoryPort["getMeetingTaskListForMeeting"]>> | null;
}) {
  const { request, meeting, viewerRole, summary } = input;
  const visibleSummary = meeting.kind === "agent_intro" && summary?.model === "agent-intro-summary-v1" ? null : summary;
  const notesAccess = await resolveNotesAccessAndRetryCreditBlockedNotes({
    request,
    meeting,
    viewerRole,
    summary,
  });

  const { isConfidentialityRequired, canViewerChangeConfidentiality } =
    await resolveMeetingDetailConfidentialityForViewer({
      meeting,
      request,
      viewerRole,
      isGuestMeetingSession: viewerRole === "guest",
    });

  return {
    meeting: await toMeetingDTOForViewer({
      input: {
        ...meeting,
        /** @external meeting confidentiality required wire field */
        confidentialityIsRequired: isConfidentialityRequired,
        /** @external viewer can change confidentiality wire field */
        viewerCanChangeConfidentiality: canViewerChangeConfidentiality,
      },
      viewerRole,
    }),
    meetingRuntime: toMeetingRuntimeDTO({ meeting, runtimeState: input.runtimeState }),
    transcript: toMeetingDetailTranscriptWire(input.transcriptData),
    summary: notesAccess.locked ? null : toMeetingSummaryWire(visibleSummary),
    notesPreview:
      notesAccess.reason === "upgrade_required"
        ? {
            status: visibleSummary ? "ready" : "pending",
            content: visibleSummary ? buildMeetingNotesPreview(visibleSummary.content) : "",
          }
        : null,
    actionItems: notesAccess.locked
      ? []
      : input.actionItems.map((item) => ({
          id: item.id,
          meetingId: item.meetingId,
          text: item.text,
          assignee: item.assignee,
          status: item.status,
          createdAt: item.createdAt.toISOString(),
        })),
    tasks: notesAccess.locked ? null : input.tasks,
    notesAccess,
    postMeetingDisposition: getHiddenPostMeetingDisposition(meeting),
  };
}

async function buildMeetingDetailHttpResponse(input: {
  request: FastifyRequest;
  meeting: MeetingAccessContext["meeting"];
  viewerRole: MeetingViewerRole;
}) {
  const { request, meeting, viewerRole } = input;
  const [
    transcriptData,
    runtimeState,
    summary,
    actionItems,
    tasks,
    linearTaskReview,
    recommendations,
    activeCapabilities,
    webResearchRuns,
    researchRuns,
  ] = await loadMeetingDetailParallelData({
    meetingId: meeting.id,
    meeting,
    request,
    isGuestMeetingSession: viewerRole === "guest",
    postMeetingDisposition: getHiddenPostMeetingDisposition(meeting),
  });
  const capabilitiesByKey = new Map(
    activeCapabilities.map((capability) => [capability.key, toCapabilitySelectionCapability(capability)]),
  );
  const notes = await buildMeetingNotesWire({
    request,
    meeting,
    viewerRole,
    runtimeState,
    transcriptData,
    summary,
    actionItems,
    tasks,
  });
  const isNotesLocked = notes.notesAccess.locked;

  return meetingDetailResponseSchema.parse({
    ...notes,
    transcriptSegments: toMeetingDetailTranscriptSegments(transcriptData),
    linearTaskReview: isNotesLocked ? null : linearTaskReview,
    capabilityRecommendations: filterVisibleCapabilityRecommendations(isNotesLocked ? [] : recommendations).map(
      (recommendation) => ({
        ...recommendation,
        capability: capabilitiesByKey.get(recommendation.capabilityKey),
      }),
    ),
    webResearchRuns: isNotesLocked
      ? []
      : webResearchRuns
          .filter((run) => (run.result as Record<string, unknown> | null)?.presentationSuperseded !== true)
          .map((run) => voiceWebResearchRunToPanelPayload(run)),
    researchRuns: isNotesLocked ? [] : researchRuns,
  });
}

async function buildMeetingNotesViewHttpResponse(input: {
  request: FastifyRequest;
  meeting: MeetingAccessContext["meeting"];
  viewerRole: MeetingViewerRole;
}) {
  const { meeting, viewerRole } = input;
  const isGuestMeetingSession = viewerRole === "guest";
  const [overview, runtimeState, summary, actionItems, tasks] = await Promise.all([
    repositories().getMeetingTranscriptOverview(meeting.id),
    repositories().getMeetingRuntimeState(meeting.id),
    repositories().getSummaryForMeeting(meeting.id),
    isGuestMeetingSession ? [] : repositories().listActionItemsForMeeting(meeting.id),
    isGuestMeetingSession ? null : repositories().getMeetingTaskListForMeeting(meeting.id),
  ]);

  return meetingNotesViewResponseSchema.parse({
    ...(await buildMeetingNotesWire({
      ...input,
      runtimeState,
      transcriptData: overview,
      summary,
      actionItems,
      tasks,
    })),
    hasTranscriptSegments: overview?.hasTranscriptSegments ?? false,
  });
}

async function listedMeetingNotePreview(meetingId: string): Promise<string | null> {
  try {
    const summary = await repositories().getSummaryForMeeting(meetingId);

    return getFirstSummaryBulletPreview(summary?.content);
  } catch (error: unknown) {
    if (!(error instanceof MeetingContentCryptoError)) {
      throw error;
    }
    console.error(JSON.stringify({ msg: SKIPPED_PROTECTED_ROW_MESSAGE, model: "summaries", meetingId }));

    return null;
  }
}

/**
 * Note previews for many meetings in one batched read. If any protected row
 * cannot be decrypted, fall back to per-meeting reads so only that meeting's
 * preview is skipped instead of failing the whole list.
 */
async function listedMeetingNotePreviews(meetingIds: string[]): Promise<Map<string, string | null>> {
  try {
    const summaries = await repositories().getSummariesForMeetings(meetingIds);

    return new Map(
      meetingIds.map((meetingId) => [meetingId, getFirstSummaryBulletPreview(summaries.get(meetingId)?.content)]),
    );
  } catch (error: unknown) {
    if (!(error instanceof MeetingContentCryptoError)) {
      throw error;
    }
    const previews = await Promise.all(
      meetingIds.map(async (meetingId) => [meetingId, await listedMeetingNotePreview(meetingId)] as const),
    );

    return new Map(previews);
  }
}

async function handleGetMeetingsListRequest(request: FastifyRequest) {
  const user = request.user;
  if (!user) {
    return { meetings: [] };
  }

  // Workspace-wide visibility scoped to the workspace the user is looking
  // at (their active selection): colleagues' non-confidential meetings
  // appear alongside every meeting the user attended themselves;
  // confidential meetings stay participant-only (enforced in the query,
  // not the client).
  const meetings = await repositories().listWorkspaceVisibleMeetingsForUser({
    userId: user.id,
    workspaceIds: [user.workspaceId],
  });
  // Two batched reads for the whole list instead of two queries per meeting.
  const [participantsByMeeting, notePreviewsByMeeting] = await Promise.all([
    repositories().listHumanParticipantsForMeetings(meetings.map((meeting) => meeting.id)),
    listedMeetingNotePreviews(meetings.filter((meeting) => meeting.status === "ended").map((meeting) => meeting.id)),
  ]);
  const meetingsWithParticipants = meetings.map((meeting) => {
    const participants = participantsByMeeting.get(meeting.id) ?? [];
    const notePreview = notePreviewsByMeeting.get(meeting.id) ?? null;
    const participantNames = Array.from(
      new Set(participants.map((participant) => participant.displayName.trim()).filter(Boolean)),
    );
    // Colleague meetings the user did not attend are read-only.
    const viewerRole: MeetingViewerRole =
      meeting.isParticipant || meeting.createdByUserId === user.id ? "participant" : "workspace";

    return {
      ...meeting,
      viewerRole,
      notePreview,
      participantNames,
      participants: participants.map((participant) => ({
        userId: participant.userId,
        displayName: participant.displayName,
        avatarUrl: participant.avatarUrl,
      })),
    };
  });

  return meetingListResponseSchema.parse({
    meetings: await Promise.all(
      meetingsWithParticipants.map((meeting) =>
        toMeetingDTOForViewer({
          input: meeting,
          viewerRole: meeting.viewerRole,
        }),
      ),
    ),
  });
}

async function registerMeetingLifecycleListRoutes(app: FastifyInstance): Promise<void> {
  app.get("/meetings", { preHandler: requireAuth }, async (request) => handleGetMeetingsListRequest(request));

  app.get("/meetings/room/:roomName", { preHandler: requireAuth }, async (request, reply) => {
    const { roomName } = meetingRoomNameParamsSchema.parse(request.params);
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const meeting = await repositories().getMeetingByRoomName(roomName);
    if (!meeting) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_NOT_FOUND });
    }
    if (!(await isTrustedMeetingUser({ meeting, userId: user.id }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_MEETING_PARTICIPANTS_ONLY });
    }

    return meetingLookupResponseSchema.parse({
      meeting: await toMeetingDTOForViewer({ input: meeting, viewerRole: "participant" }),
    });
  });

  app.get(
    "/meetings/:meetingId/live",
    {
      preHandler: requireMeetingAccess("admitted-guest"),
    },
    async (request) => {
      const { meeting, viewerRole } = getMeetingAccess(request);

      syncMeetingCallInInBackground({
        meeting,
        logger: request.log,
      });

      const runtimeState = await repositories().getMeetingRuntimeState(meeting.id);
      const isConfidentialityRequired = await repositories().isMeetingConfidentialityRequired(meeting.id);
      const canViewerChangeConfidentiality =
        isConfidentialityRequired || viewerRole === "guest" || !request.user
          ? false
          : canChangeMeetingConfidentiality({
              meeting,
              userId: request.user.id,
              isParticipant: viewerRole === "participant" || viewerRole === "host",
              isWorkspaceAdmin: await repositories().isActiveWorkspaceAdmin({
                workspaceId: meeting.workspaceId,
                userId: request.user.id,
              }),
            });

      return meetingLiveResponseSchema.parse({
        meeting: await toMeetingDTOForViewer({
          input: {
            ...meeting,
            /** @external meeting confidentiality required wire field */
            confidentialityIsRequired: isConfidentialityRequired,
            /** @external viewer can change confidentiality wire field */
            viewerCanChangeConfidentiality: canViewerChangeConfidentiality,
          },
          viewerRole,
        }),
        meetingRuntime: toMeetingRuntimeDTO({ meeting, runtimeState }),
        postMeetingDisposition: getHiddenPostMeetingDisposition(meeting),
      });
    },
  );
}

async function registerMeetingLifecycleDetailRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/meetings/:meetingId/notes-view",
    { preHandler: requireMeetingAccess("joined-guest", { allowWorkspaceViewer: true }) },
    async (request) => {
      const { meeting, viewerRole } = getMeetingAccess(request);

      return buildMeetingNotesViewHttpResponse({ request, meeting, viewerRole });
    },
  );

  app.get(
    "/meetings/:meetingId",
    {
      preHandler: requireMeetingAccess("joined-guest", { allowWorkspaceViewer: true }),
    },
    async (request) => {
      const { meeting, viewerRole } = getMeetingAccess(request);

      return buildMeetingDetailHttpResponse({ request, meeting, viewerRole });
    },
  );

  app.get(
    "/meetings/:meetingId/guest-notes",
    {
      preHandler: requireMeetingAccess("joined-guest"),
    },
    async (request, reply) => {
      const { meeting, viewerRole } = getMeetingAccess(request);
      if (viewerRole !== "guest") {
        return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_GUEST_MEETING_SESSION_REQUIRED });
      }

      const [transcriptData, runtimeState, storedSummary, tasksStatus, preparationJob, notesAccess] = await Promise.all(
        [
          repositories().getTranscriptForMeeting(meeting.id),
          repositories().getMeetingRuntimeState(meeting.id),
          repositories().getSummaryForMeeting(meeting.id),
          getMeetingTasksStatusPayload(meeting.id),
          repositories().getLatestAiWorkflowJobForMeeting({
            meetingId: meeting.id,
            type: "resolve_meeting_title",
            scopeKey: "default",
          }),
          // Account creation saves the output; it does not gate the reveal. The
          // host's own notes gate does, so a guest never sees more than the host.
          resolveGuestMeetingNotesAccess({ meeting }),
        ],
      );
      const summary = notesAccess.locked ? null : toGuestVisibleSummary(storedSummary);

      const meetingDto = await toMeetingDTOForViewer({ input: meeting, viewerRole });
      const segments = transcriptData?.segments ?? [];
      const previewJob =
        meeting.status !== "ended" &&
        segments.some(
          (segment) =>
            segment.speakerRole === "human" && segment.content.trim().length >= GUEST_HUMAN_SEGMENT_MIN_CONTENT_LENGTH,
        )
          ? await ensureGuestMeetingPreviewInRequest({ meetingId: meeting.id, logger: request.log })
          : null;
      const inProgressConclusions = getGuestMeetingConclusions(previewJob);

      return guestMeetingNotesResponseSchema.parse({
        meeting: { ...meetingDto, title: getGuestMeetingPreviewTitle({ title: meetingDto.title, segments }) },
        inProgressConclusions,
        preparationPreview: buildMeetingPreparationPreview({
          job: preparationJob,
          locked: notesAccess.locked,
          endedAt: meeting.endedAt,
        }),
        meetingRuntime: toMeetingRuntimeDTO({ meeting, runtimeState }),
        transcript: transcriptData
          ? {
              id: transcriptData.transcript.id,
              meetingId: transcriptData.transcript.meetingId,
              source: transcriptData.transcript.source,
              mode:
                typeof transcriptData.transcript.metadata.mode === "string"
                  ? transcriptData.transcript.metadata.mode
                  : "unknown",
              isFinal:
                transcriptData.transcript.source === "livekit-postcall" ||
                transcriptData.transcript.metadata.mode === "postcall-refined" ||
                transcriptData.transcript.metadata.mode === "agent-live-finalized" ||
                typeof transcriptData.transcript.metadata.finalizedAt === "string",
              refinedAt:
                typeof transcriptData.transcript.metadata.refinedAt === "string"
                  ? transcriptData.transcript.metadata.refinedAt
                  : typeof transcriptData.transcript.metadata.finalizedAt === "string"
                    ? transcriptData.transcript.metadata.finalizedAt
                    : null,
            }
          : null,
        summary: toMeetingSummaryWire(summary),
        tasksStatus: notesAccess.locked ? null : projectGuestMeetingTasksStatus({ summary, status: tasksStatus }),
        notesAccess,
        postMeetingDisposition: getHiddenPostMeetingDisposition(meeting),
      });
    },
  );
}

async function registerMeetingLifecycleJoinRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/meetings/:meetingId/join",
    {
      preHandler: requireMeetingAccess("admitted-guest"),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const user = readAuthenticatedUser(request);
      const meetingId = meeting.id;

      if (meeting.status === "ended") {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_ENDED_CANNOT_JOIN });
      }

      if (getMeetingAccess(request).viewerRole !== "guest") {
        await repositories().recordMeetingAttendeeWorkspace({
          meetingId,
          userId: user.id,
          workspaceId: user.workspaceId,
        });
      }
      await repositories().upsertParticipantPresence({
        meetingId,
        userId: user.id,
        role: "guest",
      });
      await repositories().markMeetingActive(meetingId);
      await repositories().maybeAutoMarkMeetingConfidential(meetingId);

      const activeWorkspaceId =
        getMeetingAccess(request).viewerRole !== "guest"
          ? await repositories().activateMeetingAttendeeWorkspace({ meetingId, userId: user.id })
          : null;

      await ensureMeetingAssistantCoverage(meetingId, request.log);

      const participants = await repositories().listParticipantsForMeeting(meetingId);

      return {
        activeWorkspaceId,
        participants: participants.map((participant) => ({
          userId: participant.userId,
          displayName: participant.displayName,
          role: participant.role,
          joinedAt: participant.joinedAt.toISOString(),
          leftAt: participant.leftAt ? participant.leftAt.toISOString() : null,
        })),
      };
    },
  );
}

function registerMeetingLifecycleMediaQualityRoute(input: {
  app: FastifyInstance;
  enforceAuthenticatedMediaQualityRateLimit: MeetingLifecycleRateLimitHandler;
}) {
  const { app, enforceAuthenticatedMediaQualityRateLimit } = input;
  app.post(
    "/meetings/:meetingId/media-quality",
    {
      config: { rateLimit: meetingMediaQualityIpRateLimit },
      preHandler: [
        ...requireMeetingAccess("admitted-guest"),
        async (request, reply) => {
          await enforceAuthenticatedMediaQualityRateLimit({ request, reply });
        },
      ],
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const parsed = mediaQualityReportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      const client = normalizeClientEnvironment(request.headers["user-agent"]);
      // One log line per report keeps diagnostic.trackKey queries unchanged.
      parsed.data.reports.forEach(({ trackSid, ...report }) => {
        request.log[report.outcome === "failed" ? "warn" : "info"](
          {
            meetingId: meeting.id,
            userId: request.user?.id,
            tokenKind: request.user?.tokenKind,
            client,
            diagnostic: { ...report, trackKey: logIdentifier(trackSid) },
          },
          "Meeting client diagnostic",
        );
      });

      return { /** @external meeting media quality ok wire field */ ok: true as const };
    },
  );
}

async function registerMeetingLifecycleDiagnosticRoutes(input: {
  app: FastifyInstance;
  rateLimitHandlers: MeetingLifecycleRateLimitHandlers;
}): Promise<void> {
  const { app, rateLimitHandlers } = input;
  const { enforceAuthenticatedMeetingDiagnosticRateLimit, enforceAuthenticatedMediaQualityRateLimit } =
    rateLimitHandlers;

  app.post(
    "/meetings/:meetingId/media-diagnostics",
    {
      config: { rateLimit: meetingDiagnosticIpRateLimit },
      preHandler: [
        ...requireMeetingAccess("admitted-guest"),
        async (request, reply) => {
          await enforceAuthenticatedMeetingDiagnosticRateLimit({ request, reply });
        },
      ],
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const parsed = meetingMediaDiagnosticSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      request.log.warn(
        {
          meetingId: meeting.id,
          userId: request.user?.id,
          tokenKind: request.user?.tokenKind,
          client: normalizeClientEnvironment(request.headers["user-agent"]),
          media: sanitizeMediaDiagnosticForLog(parsed.data),
        },
        "Meeting media device diagnostic",
      );

      return { /** @external meeting client diagnostic ok wire field */ ok: true as const };
    },
  );

  app.post(
    "/meetings/:meetingId/client-diagnostics",
    {
      config: { rateLimit: meetingDiagnosticIpRateLimit },
      preHandler: [
        ...requireMeetingAccess("admitted-guest"),
        async (request, reply) => {
          await enforceAuthenticatedMeetingDiagnosticRateLimit({ request, reply });
        },
      ],
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const parsed = meetingClientDiagnosticSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      const level = parsed.data.outcome === "failed" || parsed.data.outcome === "degraded" ? "warn" : "info";
      request.log[level](
        {
          meetingId: meeting.id,
          userId: request.user?.id,
          tokenKind: request.user?.tokenKind,
          client: normalizeClientEnvironment(request.headers["user-agent"]),
          diagnostic: sanitizeClientDiagnosticForLog(parsed.data),
        },
        "Meeting client diagnostic",
      );

      return { /** @external meeting client diagnostic ok wire field */ ok: true as const };
    },
  );

  registerMeetingLifecycleMediaQualityRoute({ app, enforceAuthenticatedMediaQualityRateLimit });
}

async function registerMeetingLifecycleTranscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/meetings/:meetingId/live-transcription/start",
    {
      preHandler: requireMeetingAccess("participant"),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      if (meeting.status === "ended") {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_ENDED_CANNOT_TRANSCRIBE });
      }

      try {
        const result = await startLiveMeetingTranscription(meeting.id);

        return {
          /** @external live transcription ok wire field */
          ok: true,
          /** @external live transcription started wire field */
          started: result.started,
        };
      } catch (error) {
        request.log.error({ error, meetingId: meeting.id }, "Failed to start backend live transcription");

        return reply.code(HTTP_BAD_GATEWAY).send({
          message: error instanceof Error ? error.message : MESSAGE_FAILED_START_LIVE_TRANSCRIPTION,
        });
      }
    },
  );

  app.post(
    "/meetings/:meetingId/live-transcription/stop",
    {
      preHandler: requireMeetingAccess("participant"),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);

      try {
        const result = await stopLiveMeetingTranscription(meeting.id);

        return {
          /** @external live transcription ok wire field */
          ok: true,
          /** @external live transcription stopped wire field */
          stopped: result.stopped,
          /** @external live transcription finalized wire field */
          finalized: result.finalized,
        };
      } catch (error) {
        request.log.error({ error, meetingId: meeting.id }, "Failed to stop backend live transcription");

        return reply.code(HTTP_BAD_GATEWAY).send({
          message: error instanceof Error ? error.message : MESSAGE_FAILED_STOP_LIVE_TRANSCRIPTION,
        });
      }
    },
  );

  app.post(
    "/meetings/:meetingId/transcript-segments",
    {
      preHandler: requireMeetingAccess("participant"),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const user = readAuthenticatedUser(request);
      const parsed = appendTranscriptSegmentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      if (meeting.status === "ended") {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_ENDED_CANNOT_APPEND_TRANSCRIPT });
      }

      const segment = await repositories().appendTranscriptSegment({
        meetingId: meeting.id,
        speakerIdentity: user.id,
        speakerName: parsed.data.speakerName,
        speakerUserId: user.id,
        speakerRole: "human",
        source: "manual-note",
        content: parsed.data.content,
        startedAt: new Date(parsed.data.startedAt),
        endedAt:
          parsed.data.endedAt !== null && parsed.data.endedAt !== undefined ? new Date(parsed.data.endedAt) : undefined,
      });

      return {
        id: segment.id,
        transcriptId: segment.transcriptId,
      };
    },
  );
}

async function registerMeetingLifecycleEndRoutes(app: FastifyInstance): Promise<void> {
  // 'any-authenticated' so a still-waiting guest can leave; the end_for_all
  // branch gates on host status itself.
  app.post(
    "/meetings/:meetingId/end",
    {
      preHandler: requireMeetingAccess("any-authenticated"),
    },
    async (request, reply) => {
      const { meeting, viewerRole } = getMeetingAccess(request);
      const user = readAuthenticatedUser(request);
      const meetingId = meeting.id;

      const parsed = endMeetingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      if (parsed.data.action === "leave" && !(await isTrustedMeetingUser({ meeting, userId: user.id }))) {
        if (user.tokenKind !== "guest") {
          return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_PARTICIPANTS_CAN_LEAVE });
        }

        // Leaving the waiting room must never end the host's meeting instance.
        return {
          /** @external meeting end ok wire field */
          ok: true,
          meeting: await toMeetingDTOForViewer({ input: meeting, viewerRole }),
          meetingRuntime: toMeetingRuntimeDTO({
            meeting,
            runtimeState: await repositories().getMeetingRuntimeState(meetingId),
          }),
          /** @external meeting end finalized wire field */
          finalized: false,
          postMeetingDisposition: null,
        };
      }

      if (parsed.data.action === "end_for_all") {
        if (user.tokenKind === "guest") {
          return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_ORGANIZER_END_FOR_ALL });
        }
        if (!(await isAuthorizedMeetingHost({ meeting, userId: user.id }))) {
          return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_ORGANIZER_END_FOR_ALL });
        }

        await repositories().markAllHumanParticipantsLeft(meetingId);
        // Preserve immediate "end for everyone" semantics without putting a
        // network round trip back on the user's three-second handoff. Request-owned
        // finalization repeats cleanup; interrupted requests need an explicit retry.
        void (async () => {
          try {
            await deleteLiveKitRoom(meeting.roomName);
          } catch (error) {
            request.log.warn(
              { error, meetingId, roomName: meeting.roomName },
              "Failed to delete LiveKit room during end-for-all",
            );
            if (!(error instanceof Error)) {
              throw error;
            }
          }
        })();
      } else {
        await markParticipantLeftIfDisconnected({ meetingId, roomName: meeting.roomName, userId: user.id });
      }

      const finalization = await scheduleMeetingFinalizationIfIdle(meetingId, request.log, {
        force: parsed.data.action === "end_for_all",
      });
      if (!finalization.finalized) {
        await ensureMeetingAssistantCoverage(meetingId, request.log);
        scheduleAssistantCoverageRecheck(meetingId, request.log);
      }

      const refreshedMeeting = (await repositories().getMeetingById(meetingId)) ?? meeting;

      return {
        /** @external meeting end ok wire field */
        ok: true,
        meeting: await toMeetingDTOForViewer({ input: refreshedMeeting, viewerRole }),
        meetingRuntime: toMeetingRuntimeDTO({ meeting: refreshedMeeting, runtimeState: finalization.runtimeState }),
        /** @external meeting end finalized wire field */
        finalized: finalization.finalized,
        postMeetingDisposition: finalization.finalized ? getHiddenPostMeetingDisposition(refreshedMeeting) : null,
      };
    },
  );
}

async function registerMeetingLifecycleEndMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.delete(
    "/meetings/:meetingId",
    {
      preHandler: requireMeetingAccess("participant"),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const user = readAuthenticatedUser(request);
      const meetingId = meeting.id;

      if (meeting.status !== "ended") {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_ONLY_ENDED_MEETINGS_DELETABLE });
      }

      if (meeting.createdByUserId === user.id) {
        await repositories().markMeetingHiddenFromHistory({
          meetingId,
          reason: "user_removed",
          actorUserId: user.id,
        });

        return { /** @external meeting delete ok wire field */ ok: true, mode: "hidden-from-history" };
      }

      const isParticipantRemoved = await repositories().removeParticipantFromMeeting({ meetingId, userId: user.id });
      if (!isParticipantRemoved) {
        return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_NOT_A_PARTICIPANT });
      }

      return { /** @external meeting delete ok wire field */ ok: true, mode: "removed-from-list" };
    },
  );

  app.patch(
    "/meetings/:meetingId/confidentiality",
    {
      preHandler: requireMeetingAccess("participant", {
        forbiddenMessage: "Only meeting participants can change confidentiality.",
      }),
    },
    async (request, reply) => {
      const { meeting, viewerRole } = getMeetingAccess(request);
      const user = readAuthenticatedUser(request);

      const body = updateMeetingConfidentialityRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CONFIDENTIALITY_BOOLEAN_REQUIRED });
      }

      const canChangeConfidentiality = canChangeMeetingConfidentiality({
        meeting,
        userId: user.id,
        isParticipant: viewerRole === "participant" || viewerRole === "host",
        isWorkspaceAdmin: await repositories().isActiveWorkspaceAdmin({
          workspaceId: meeting.workspaceId,
          userId: user.id,
        }),
      });
      if (!canChangeConfidentiality) {
        const message =
          meeting.status === "ended"
            ? MESSAGE_CONFIDENTIALITY_ENDED_ORGANIZER_ONLY
            : MESSAGE_CONFIDENTIALITY_ORGANIZER_OR_ADMIN_ONLY;

        return reply.code(HTTP_FORBIDDEN).send({ message });
      }

      const confidentialityUpdate = await (async () => {
        try {
          return {
            meeting: await repositories().setMeetingConfidentiality({
              meetingId: meeting.id,
              isConfidential: body.data.isConfidential,
              source: "manual",
              actorUserId: user.id,
            }),
          };
        } catch (error) {
          if (error instanceof MeetingConfidentialityRequiredError) {
            return { blocked: error };
          }
          throw error;
        }
      })();
      if (confidentialityUpdate.blocked !== undefined) {
        return reply.code(HTTP_CONFLICT).send({
          code: confidentialityUpdate.blocked.code,
          message: MESSAGE_INTERNAL_MEETINGS_ALWAYS_CONFIDENTIAL,
        });
      }
      const updated = confidentialityUpdate.meeting;
      if (!updated) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_NOT_FOUND });
      }

      return updateMeetingConfidentialityResponseSchema.parse({
        meetingId: updated.id,
        isConfidential: updated.isConfidential,
        confidentialitySource: updated.confidentialitySource ?? null,
      });
    },
  );
}

export async function meetingLifecycleRoutes(app: FastifyInstance): Promise<void> {
  const checkAuthenticatedMeetingDiagnosticRateLimit = app.createRateLimit({
    max: AUTHENTICATED_DIAGNOSTIC_RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    keyGenerator: authenticatedMeetingDiagnosticRateLimitKey,
  });
  const checkAuthenticatedMediaQualityRateLimit = app.createRateLimit({
    max: AUTHENTICATED_MEDIA_QUALITY_RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    keyGenerator: authenticatedMeetingDiagnosticRateLimitKey,
  });
  const rateLimitHandlers: MeetingLifecycleRateLimitHandlers = {
    enforceAuthenticatedMeetingDiagnosticRateLimit: async (input) => {
      const result = await checkAuthenticatedMeetingDiagnosticRateLimit(input.request);
      if (result.isAllowed || !result.isExceeded) {
        return;
      }

      await input.reply
        .code(HTTP_TOO_MANY_REQUESTS)
        .header("retry-after", String(result.ttlInSeconds))
        .send({ message: MESSAGE_TOO_MANY_MEETING_DIAGNOSTIC_REPORTS });
    },
    enforceAuthenticatedMediaQualityRateLimit: async (input) => {
      const result = await checkAuthenticatedMediaQualityRateLimit(input.request);
      if (result.isAllowed || !result.isExceeded) {
        return;
      }

      await input.reply
        .code(HTTP_TOO_MANY_REQUESTS)
        .header("retry-after", String(result.ttlInSeconds))
        .send({ message: MESSAGE_TOO_MANY_MEETING_DIAGNOSTIC_REPORTS });
    },
  };

  await calendarAddonRoutes(app);
  await registerMeetingLifecycleCreateRoutes(app);
  await registerMeetingLifecycleListRoutes(app);
  await registerMeetingLifecycleDetailRoutes(app);
  await registerMeetingLifecycleJoinRoutes(app);
  await registerMeetingLifecycleTranscriptionRoutes(app);
  await registerMeetingLifecycleDiagnosticRoutes({ app, rateLimitHandlers });
  await registerMeetingLifecycleEndRoutes(app);
  await registerMeetingLifecycleEndMaintenanceRoutes(app);
}
