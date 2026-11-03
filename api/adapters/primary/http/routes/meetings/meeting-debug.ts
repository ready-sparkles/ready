import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  debugFinalizedMeetingImportRequestSchema,
  debugFinalizedMeetingImportResponseSchema,
  debugFinalizedMeetingJsonSchema,
  debugOnboardingResetResponseSchema,
  debugTranscriptImportRequestSchema,
  debugTranscriptImportResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import { toMeetingDTO } from "../../../../../application/meeting-dto";
import { apiEnv } from "../../../../../composition/env";
import { generateUniqueMeetingLinkCode } from "../../../../../composition/meeting-link-codes";
import {
  parseDebugTranscriptInput,
  parseDebugTranscriptJsonInput,
} from "../../../../../domain/debug-transcript-import";
import { repositories } from "../../../../../ports/repository-runtime";
import { requireAuth } from "../../plugins/auth";

const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;

const MESSAGE_NOT_FOUND = "Not found";
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_MISSING_AUTH_USER = "Missing auth user";
const MESSAGE_FINALIZED_MEETING_JSON_INVALID = "Finalized meeting JSON is invalid";
const MESSAGE_AUTHENTICATED_USER_MUST_BE_HOST = "The authenticated user must be included as a host participant.";
const MESSAGE_UNABLE_TO_PARSE_TRANSCRIPT = "Unable to parse transcript";
const DEFAULT_INSTANT_MEETING_TITLE = "Instant meeting";

const DEBUG_PARTICIPANT_IDENTITY_SUFFIX_MAX_LENGTH = 80;

type DebugFinalizedMeetingJson = z.infer<typeof debugFinalizedMeetingJsonSchema>;

type FinalizedMeetingJsonParseResult = z.SafeParseReturnType<DebugFinalizedMeetingJson, DebugFinalizedMeetingJson>;

function duplicateParticipantEmailMessage(email: string) {
  return `Duplicate participant email "${email}"`;
}

function speakerNotImportedParticipantMessage(speakerEmail: string) {
  return `Speaker "${speakerEmail}" was not imported as a participant`;
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function parseDebugImportSegments(input: {
  transcriptJson?: string;
  transcript?: string;
}): { isOk: true; segments: ReturnType<typeof parseDebugTranscriptInput> } | { isOk: false; message: string } {
  const isJsonImport = Boolean(input.transcriptJson?.trim());
  try {
    if (isJsonImport) {
      return { isOk: true, segments: parseDebugTranscriptJsonInput(input.transcriptJson ?? "") };
    }

    return { isOk: true, segments: parseDebugTranscriptInput(input.transcript ?? "") };
  } catch (error) {
    return {
      isOk: false,
      message: error instanceof Error ? error.message : MESSAGE_UNABLE_TO_PARSE_TRANSCRIPT,
    };
  }
}

function parseFinalizedMeetingJson(value: string): FinalizedMeetingJsonParseResult | null {
  try {
    const jsonInput: unknown = JSON.parse(value);

    return debugFinalizedMeetingJsonSchema.safeParse(jsonInput);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error instanceof Error ? error : new Error(MESSAGE_FINALIZED_MEETING_JSON_INVALID);
    }

    return null;
  }
}

function toDebugParticipantIdentity(params: { userId: string; sourceSegmentId: string | undefined; index: number }) {
  const trimmedSourceSegmentId = params.sourceSegmentId?.trim();
  const suffixSeed =
    trimmedSourceSegmentId !== undefined && trimmedSourceSegmentId.length > 0
      ? trimmedSourceSegmentId
      : String(params.index + 1);
  const normalizedSuffix = suffixSeed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DEBUG_PARTICIPANT_IDENTITY_SUFFIX_MAX_LENGTH);
  const suffix = normalizedSuffix.length > 0 ? normalizedSuffix : String(params.index + 1);

  return `${params.userId}:debug-${suffix}`;
}

function resolveInstantMeetingTitle(title: string | undefined) {
  const trimmedTitle = title?.trim();
  if (trimmedTitle !== undefined && trimmedTitle.length > 0) {
    return trimmedTitle;
  }

  return DEFAULT_INSTANT_MEETING_TITLE;
}

function validateDebugFinalizedMeetingParticipants(params: {
  participants: DebugFinalizedMeetingJson["participants"];
  currentUserEmail: string;
}): { isOk: true } | { isOk: false; message: string } {
  const currentUserParticipant = params.participants.find(
    (participant) => normalizeEmail(participant.email) === params.currentUserEmail,
  );
  if (currentUserParticipant === undefined || currentUserParticipant.role !== "host") {
    return { isOk: false, message: MESSAGE_AUTHENTICATED_USER_MUST_BE_HOST };
  }

  const duplicateParticipant = params.participants.find((participant, index, participants) =>
    participants.slice(0, index).some((earlier) => normalizeEmail(earlier.email) === normalizeEmail(participant.email)),
  );
  if (duplicateParticipant !== undefined) {
    return { isOk: false, message: duplicateParticipantEmailMessage(duplicateParticipant.email) };
  }

  return { isOk: true };
}

async function buildDebugImportParticipantsByEmail(params: {
  meetingId: string;
  participants: DebugFinalizedMeetingJson["participants"];
}) {
  return params.participants.reduce(async (pendingParticipants, participant) => {
    const importedParticipants = await pendingParticipants;
    const email = normalizeEmail(participant.email);
    const user = await repositories().upsertUser({
      email,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl ?? null,
      source: "debug_import",
    });
    await repositories().upsertParticipantPresence({
      meetingId: params.meetingId,
      userId: user.id,
      role: participant.role,
    });

    return new Map(importedParticipants).set(email, user);
  }, Promise.resolve(new Map<string, Awaited<ReturnType<RepositoryPort["upsertUser"]>>>()));
}

async function importDebugFinalizedMeetingTranscript(params: {
  meetingId: string;
  input: DebugFinalizedMeetingJson;
  participantsByEmail: Map<string, Awaited<ReturnType<RepositoryPort["upsertUser"]>>>;
}) {
  await repositories().replaceTranscriptSegmentsForMeeting({
    meetingId: params.meetingId,
    source: "livekit-python-live",
    metadata: {
      mode: "agent-live-finalized",
      finalizedAt: params.input.meeting.endedAt,
      importedFrom: "debug-finalized-meeting",
    },
    segments: params.input.transcript.segments.map((segment, index) => {
      const speaker = params.participantsByEmail.get(normalizeEmail(segment.speakerEmail));
      if (speaker === undefined) {
        throw new Error(speakerNotImportedParticipantMessage(segment.speakerEmail));
      }

      return {
        speakerIdentity: toDebugParticipantIdentity({
          userId: speaker.id,
          sourceSegmentId: segment.sourceSegmentId,
          index,
        }),
        speakerUserId: speaker.id,
        speakerName: speaker.displayName,
        speakerRole: "human" as const,
        source: "livekit-python-live" as const,
        sourceSegmentId: segment.sourceSegmentId,
        content: segment.content,
        startedAt: new Date(segment.startedAt),
        endedAt: new Date(segment.endedAt),
      };
    }),
  });

  await repositories().updateTranscriptForMeeting({
    meetingId: params.meetingId,
    source: "livekit-python-live",
    metadata: {
      mode: "agent-live-finalized",
      finalizedAt: params.input.meeting.endedAt,
      importedFrom: "debug-finalized-meeting",
    },
  });
}

async function handleDebugResetOnboarding(request: FastifyRequest, reply: FastifyReply) {
  if (apiEnv.NODE_ENV === "production") {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_NOT_FOUND });
  }
  if (request.user === undefined) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
  }

  const result = await repositories().resetUserOnboardingDebugState(request.user.id);

  return debugOnboardingResetResponseSchema.parse({
    /** @external debug onboarding reset ok wire field */
    ok: true,
    hiddenEndedMeetingCount: result.hiddenEndedMeetingCount,
  });
}

async function handleDebugImportTranscript(request: FastifyRequest, reply: FastifyReply) {
  if (apiEnv.NODE_ENV === "production") {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_NOT_FOUND });
  }
  const parsed = debugTranscriptImportRequestSchema.safeParse(request.body);
  if (!parsed.success || request.user === undefined) {
    return reply.code(HTTP_BAD_REQUEST).send({
      message: parsed.success ? MESSAGE_MISSING_AUTH_USER : parsed.error.message,
    });
  }

  const isJsonImport = Boolean(parsed.data.transcriptJson?.trim());
  const parsedTranscript = parseDebugImportSegments(parsed.data);
  if (!parsedTranscript.isOk) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsedTranscript.message });
  }
  const parsedSegments = parsedTranscript.segments;

  const roomName = await generateUniqueMeetingLinkCode();
  const meeting = await repositories().createMeeting({
    title: resolveInstantMeetingTitle(parsed.data.title),
    roomName,
    createdByUserId: request.user.id,
    workspaceId: request.user.workspaceId,
  });

  await repositories().replaceTranscriptSegmentsForMeeting({
    meetingId: meeting.id,
    source: "manual-debug-import",
    metadata: {
      mode: "manual-debug-finalized",
      finalizedAt: new Date().toISOString(),
      importedFrom: isJsonImport ? "debug-transcript-json" : "debug-transcript",
    },
    segments: parsedSegments,
  });

  await repositories().updateTranscriptForMeeting({
    meetingId: meeting.id,
    source: "manual-debug-import",
    metadata: {
      mode: "manual-debug-finalized",
      finalizedAt: new Date().toISOString(),
      importedFrom: isJsonImport ? "debug-transcript-json" : "debug-transcript",
    },
  });

  await repositories().markMeetingEnded(meeting.id);

  const finalizedMeeting = (await repositories().getMeetingById(meeting.id)) ?? meeting;

  return debugTranscriptImportResponseSchema.parse({
    meeting: toMeetingDTO(finalizedMeeting),
  });
}

async function handleDebugImportFinalizedMeeting(request: FastifyRequest, reply: FastifyReply) {
  if (apiEnv.NODE_ENV === "production") {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_NOT_FOUND });
  }
  const parsed = debugFinalizedMeetingImportRequestSchema.safeParse(request.body);
  if (!parsed.success || request.user === undefined) {
    return reply.code(HTTP_BAD_REQUEST).send({
      message: parsed.success ? MESSAGE_MISSING_AUTH_USER : parsed.error.message,
    });
  }

  const finalizedJson = parseFinalizedMeetingJson(parsed.data.finalizedMeetingJson);
  if (finalizedJson === null) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_FINALIZED_MEETING_JSON_INVALID });
  }
  if (!finalizedJson.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: finalizedJson.error.message });
  }

  const input = finalizedJson.data;
  const participantValidation = validateDebugFinalizedMeetingParticipants({
    participants: input.participants,
    currentUserEmail: normalizeEmail(request.user.email),
  });
  if (!participantValidation.isOk) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: participantValidation.message });
  }

  const roomName = await generateUniqueMeetingLinkCode();
  const meeting = await repositories().createMeeting({
    title: input.meeting.title,
    roomName,
    createdByUserId: request.user.id,
    workspaceId: request.user.workspaceId,
  });

  const participantsByEmail = await buildDebugImportParticipantsByEmail({
    meetingId: meeting.id,
    participants: input.participants,
  });

  await importDebugFinalizedMeetingTranscript({
    meetingId: meeting.id,
    input,
    participantsByEmail,
  });

  await repositories().updateMeetingTimeline({
    meetingId: meeting.id,
    startedAt: new Date(input.meeting.startedAt),
    endedAt: new Date(input.meeting.endedAt),
    status: "ended",
  });
  await repositories().markAllHumanParticipantsLeft(meeting.id);

  const finalizedMeeting = (await repositories().getMeetingById(meeting.id)) ?? meeting;

  return debugFinalizedMeetingImportResponseSchema.parse({
    meeting: toMeetingDTO(finalizedMeeting),
  });
}

export async function meetingDebugRoutes(app: FastifyInstance): Promise<void> {
  app.post("/meetings/debug/reset-onboarding", { preHandler: requireAuth }, handleDebugResetOnboarding);

  app.post("/meetings/debug/import-transcript", { preHandler: requireAuth }, handleDebugImportTranscript);

  app.post("/meetings/debug/import-finalized-meeting", { preHandler: requireAuth }, handleDebugImportFinalizedMeeting);
}
