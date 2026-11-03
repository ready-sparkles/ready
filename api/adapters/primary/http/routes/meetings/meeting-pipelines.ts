import {
  aiWorkflowJobsResponseSchema,
  capabilitySelectionResponseSchema,
  meetingExtractionLookupResponseSchema,
  meetingExtractionResponseSchema,
  meetingNotesRegenerationProgressResponseSchema,
  meetingPreparationPreviewResponseSchema,
  meetingSnapshotRunResponseSchema,
  regenerateMeetingNotesResponseSchema,
  runCapabilitySelectionRequestSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  fallbackNotesRegenerationProgress,
  regenerateFallbackMeetingNotes,
} from "../../../../../application/fallback-notes-regeneration";
import { hasFinalizedTranscript, isMeetingFinalizationInFlight } from "../../../../../application/meeting-lifecycle";
import { resolveMeetingNotesAccess } from "../../../../../application/meeting-notes-access";
import { ensureGuestMeetingPreviewInRequest } from "../../../../../application/run-ai-work";
import { getSuggestedActionsStatus, startSuggestedActionsRun } from "../../../../../application/suggested-actions";
import { getGuestMeetingConclusions } from "../../../../../domain/guest-meeting-preview";
import { buildMeetingPreparationPreview } from "../../../../../domain/meeting-preparation-preview";
import { repositories } from "../../../../../ports/repository-runtime";
import {
  triggerCapabilitySelection,
  triggerMeetingExtraction,
  triggerMeetingSignalExtraction,
} from "../../../../secondary/undici/assistant-client";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";
import { requireMeetingNotesAccess } from "../../support/meeting-notes-guard";

import { sendPostMeetingPipelineSkippedIfNeeded } from "./shared";

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const GUEST_HUMAN_SEGMENT_MIN_CONTENT_LENGTH = 40;

const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_MEETING_STILL_ACTIVE_SUMMARY =
  "Meeting is still active. Summary is only available after everyone leaves.";
const MESSAGE_MEETING_STILL_ACTIVE_SUGGESTED_ACTIONS =
  "Meeting is still active. Suggested actions are only available after everyone leaves.";
const MESSAGE_TRANSCRIPT_STILL_FINALIZING = "Transcript is still being finalized. Try again in a moment.";
const MESSAGE_NOTES_COULD_NOT_BE_PREPARED = "Notes could not be prepared. Retry from the meeting workspace.";
const MESSAGE_EXTRACTION_MUST_COMPLETE_BEFORE_SIGNALS = "Human-readable extraction must complete before signals";
const MESSAGE_MEETING_EXTRACTION_NOT_FOUND = "Meeting extraction not found";
const MESSAGE_EXTRACTION_WRONG_MEETING = "Extraction does not belong to this meeting";

const requireJoinedGuestOrWorkspaceViewer = requireMeetingAccess("joined-guest", {
  /** @external meeting access allow workspace viewer wire field */
  allowWorkspaceViewer: true,
});
const requireParticipantNotesAccess = requireMeetingNotesAccess({ level: "participant" });
const requireHostNotesAccess = requireMeetingNotesAccess({ level: "host" });
const requireParticipantNotesAccessWithWorkspaceViewer = requireMeetingNotesAccess({
  level: "participant",
  options: {
    /** @external meeting notes access allow workspace viewer wire field */
    allowWorkspaceViewer: true,
  },
});

const runCapabilitySelectionBodySchema = z.object({
  extractionId: runCapabilitySelectionRequestSchema.shape.extractionId,
  forceRefresh: runCapabilitySelectionRequestSchema.shape.forceRefresh,
});

function requireRequestUser(input: { user: { id: string } | undefined }) {
  const { user } = input;
  if (user === undefined) {
    throw new Error(MESSAGE_UNAUTHORIZED);
  }

  return user;
}

function registerPreparationPreviewRoute(app: FastifyInstance): void {
  app.get(
    "/meetings/:meetingId/preparation-preview",
    {
      preHandler: requireJoinedGuestOrWorkspaceViewer,
    },
    async (request) => {
      const { meeting, viewerRole } = getMeetingAccess(request);
      if (meeting.status !== "ended") {
        // Reuse the durable guest preview job for joined account holders too.
        // Workspace-only viewers may read meetings but must not start AI jobs.
        const transcript = viewerRole !== "workspace" ? await repositories().getTranscriptForMeeting(meeting.id) : null;
        const job =
          transcript?.segments.some(
            (segment) =>
              segment.speakerRole === "human" &&
              segment.content.trim().length >= GUEST_HUMAN_SEGMENT_MIN_CONTENT_LENGTH,
          ) === true
            ? await ensureGuestMeetingPreviewInRequest({ meetingId: meeting.id, logger: request.log })
            : null;
        const lines = getGuestMeetingConclusions(job);

        return meetingPreparationPreviewResponseSchema.parse({
          status: lines.length !== 0 ? "ready" : "pending",
          lines,
          source: lines.length !== 0 ? "model" : null,
        });
      }
      const user = requireRequestUser({ user: request.user });
      const [job, notesAccess] = await Promise.all([
        repositories().getLatestAiWorkflowJobForMeeting({
          meetingId: meeting.id,
          type: "resolve_meeting_title",
          scopeKey: "default",
        }),
        resolveMeetingNotesAccess({
          meeting,
          viewerRole,
          userId: user.id,
        }),
      ]);

      return meetingPreparationPreviewResponseSchema.parse(
        buildMeetingPreparationPreview({
          job,
          locked: notesAccess.locked,
          // Free-plan previews use the same existing conclusions as paid notes.
          allowUpgradePreview: notesAccess.reason === "upgrade_required",
          endedAt: meeting.endedAt,
        }),
      );
    },
  );
}

function registerExtractionLookupRoute(app: FastifyInstance): void {
  app.get(
    "/meetings/:meetingId/extraction",
    {
      preHandler: requireParticipantNotesAccess,
    },
    async (request) => {
      const { meeting } = getMeetingAccess(request);

      const extraction = await repositories().getExtractionByMeetingId(meeting.id);

      return meetingExtractionLookupResponseSchema.parse({
        extraction,
      });
    },
  );
}

async function handleRunSummaryRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting } = getMeetingAccess(input.request);
  const meetingId = meeting.id;

  const runtimeState = await repositories().getMeetingRuntimeState(meetingId);
  if (meeting.status !== "ended" || runtimeState.activeHumanParticipantCount > 0) {
    return input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_STILL_ACTIVE_SUMMARY });
  }

  const transcriptData = await repositories().getTranscriptForMeeting(meetingId);
  if (!hasFinalizedTranscript(transcriptData)) {
    return input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_TRANSCRIPT_STILL_FINALIZING });
  }

  if (await sendPostMeetingPipelineSkippedIfNeeded({ reply: input.reply, meeting, meetingId, transcriptData })) {
    return;
  }

  const summary = await repositories().getSummaryForMeeting(meetingId);
  if (!summary) {
    const { generateAndPersistMeetingSnapshot } = await import("../../../../../application/snapshot-artifacts");
    await generateAndPersistMeetingSnapshot({ meetingId, logger: input.request.log });
  }
  const savedSummary = await repositories().getSummaryForMeeting(meetingId);
  if (!savedSummary) {
    return input.reply.code(HTTP_SERVICE_UNAVAILABLE).send({ message: MESSAGE_NOTES_COULD_NOT_BE_PREPARED });
  }

  return {
    summary: { ...savedSummary, generatedAt: savedSummary.generatedAt.toISOString() },
    actionItems: (await repositories().listActionItemsForMeeting(meetingId)).map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
  };
}

function registerRunSummaryRoute(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/run-summary",
    {
      preHandler: requireParticipantNotesAccess,
    },
    async (request, reply) => handleRunSummaryRequest({ request, reply }),
  );
}

async function handleRunExtractionRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting } = getMeetingAccess(input.request);
  const meetingId = meeting.id;

  const transcriptData = await repositories().getTranscriptForMeeting(meetingId);
  if (!hasFinalizedTranscript(transcriptData)) {
    return input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_TRANSCRIPT_STILL_FINALIZING });
  }

  if (await sendPostMeetingPipelineSkippedIfNeeded({ reply: input.reply, meeting, meetingId, transcriptData })) {
    return;
  }

  const response = await triggerMeetingExtraction(meetingId);

  return meetingExtractionResponseSchema.parse(response);
}

function registerRunExtractionRoute(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/run-extraction",
    {
      preHandler: requireParticipantNotesAccess,
    },
    async (request, reply) => handleRunExtractionRequest({ request, reply }),
  );
}

async function handleRunSnapshotRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting } = getMeetingAccess(input.request);
  const meetingId = meeting.id;

  const transcriptData = await repositories().getTranscriptForMeeting(meetingId);
  if (!hasFinalizedTranscript(transcriptData)) {
    return input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_TRANSCRIPT_STILL_FINALIZING });
  }

  if (await sendPostMeetingPipelineSkippedIfNeeded({ reply: input.reply, meeting, meetingId, transcriptData })) {
    return;
  }

  if (await isMeetingFinalizationInFlight(meetingId)) {
    return meetingSnapshotRunResponseSchema.parse({
      job: buildSnapshotRunJob({ meetingId, snapshotId: null }),
      snapshot: null,
    });
  }

  const { generateAndPersistMeetingSnapshot } = await import("../../../../../application/snapshot-artifacts");
  const { snapshot } = await generateAndPersistMeetingSnapshot({ meetingId, logger: input.request.log });

  return meetingSnapshotRunResponseSchema.parse({
    job: buildSnapshotRunJob({ meetingId, snapshotId: snapshot.id }),
    snapshot,
  });
}

/** Describes this request's snapshot run; a null snapshot means the meeting's finalization is still writing it. */
function buildSnapshotRunJob(input: { meetingId: string; snapshotId: string | null }) {
  const now = new Date().toISOString();
  const isRunning = input.snapshotId === null;

  return {
    id: randomUUID(),
    meetingId: input.meetingId,
    extractionId: null,
    type: "generate_meeting_snapshot" as const,
    scopeKey: "default",
    status: isRunning ? ("running" as const) : ("completed" as const),
    phase: isRunning ? "awaiting_finalization" : "complete",
    payload: { trigger: "run_snapshot" },
    result: isRunning ? {} : { snapshotId: input.snapshotId },
    error: null,
    attemptCount: 1,
    maxAttempts: 1,
    runAfter: now,
    lockedBy: null,
    lockedAt: null,
    startedAt: now,
    completedAt: isRunning ? null : now,
    createdAt: now,
    updatedAt: now,
  };
}

function registerRunSnapshotRoute(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/run-snapshot",
    {
      preHandler: requireParticipantNotesAccess,
    },
    async (request, reply) => handleRunSnapshotRequest({ request, reply }),
  );
}

async function handleRegenerateNotesRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting } = getMeetingAccess(input.request);
  const runtimeState = await repositories().getMeetingRuntimeState(meeting.id);
  if (meeting.status !== "ended" || runtimeState.activeHumanParticipantCount > 0) {
    return input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_STILL_ACTIVE_SUMMARY });
  }
  const status = await regenerateFallbackMeetingNotes({
    meetingId: meeting.id,
    logger: input.request.log,
    trigger: "manual",
  });

  return regenerateMeetingNotesResponseSchema.parse({ status });
}

/** Hosts replace fallback notes once they can afford real ones; repeat calls never start a second run. GET reports the run's progress. */
function registerRegenerateNotesRoute(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/regenerate-notes",
    {
      preHandler: requireHostNotesAccess,
    },
    async (request, reply) => handleRegenerateNotesRequest({ request, reply }),
  );
  app.get(
    "/meetings/:meetingId/regenerate-notes",
    {
      preHandler: requireHostNotesAccess,
    },
    async (request) => {
      const { meeting } = getMeetingAccess(request);

      return meetingNotesRegenerationProgressResponseSchema.parse({
        status: await fallbackNotesRegenerationProgress(meeting.id),
      });
    },
  );
}

async function handleRunExtractionSignalsRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting } = getMeetingAccess(input.request);
  const meetingId = meeting.id;

  if (await sendPostMeetingPipelineSkippedIfNeeded({ reply: input.reply, meeting, meetingId })) {
    return;
  }

  const extraction = await repositories().getExtractionByMeetingId(meetingId);
  if (!extraction || (extraction.contentStatus !== "completed" && extraction.contentStatus !== "partial")) {
    return input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_EXTRACTION_MUST_COMPLETE_BEFORE_SIGNALS });
  }

  const response = await triggerMeetingSignalExtraction(meetingId);

  return meetingExtractionResponseSchema.parse(response);
}

function registerRunExtractionSignalsRoute(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/run-extraction-signals",
    {
      preHandler: requireParticipantNotesAccess,
    },
    async (request, reply) => handleRunExtractionSignalsRequest({ request, reply }),
  );
}

async function handleRunSelectionRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting } = getMeetingAccess(input.request);
  const meetingId = meeting.id;

  const requestBody = input.request.body;
  const bodyParsed = runCapabilitySelectionBodySchema.safeParse(requestBody);
  if (!bodyParsed.success) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
  }
  const parsed = runCapabilitySelectionRequestSchema.safeParse({
    meetingId,
    ...bodyParsed.data,
  });
  if (!parsed.success) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }

  if (await sendPostMeetingPipelineSkippedIfNeeded({ reply: input.reply, meeting, meetingId })) {
    return;
  }

  const extractionId = parsed.data.extractionId;
  const extraction =
    extractionId !== undefined
      ? await repositories().getExtractionById(extractionId)
      : await repositories().getExtractionByMeetingId(meetingId);

  if (!extraction) {
    return input.reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_EXTRACTION_NOT_FOUND });
  }

  if (extraction.meetingId !== meetingId) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_EXTRACTION_WRONG_MEETING });
  }

  const tasks = await repositories().getMeetingTaskListForMeeting(meetingId);
  const response = await triggerCapabilitySelection(extraction.id, {
    forceRefresh: parsed.data.forceRefresh,
    tasks: tasks?.status === "completed" ? tasks : null,
  });

  return capabilitySelectionResponseSchema.parse(response);
}

function registerRunSelectionRoute(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/run-selection",
    {
      preHandler: requireParticipantNotesAccess,
    },
    async (request, reply) => handleRunSelectionRequest({ request, reply }),
  );
}

function registerSuggestedActionsStatusRoute(app: FastifyInstance): void {
  app.get(
    "/meetings/:meetingId/suggested-actions-status",
    {
      preHandler: requireParticipantNotesAccessWithWorkspaceViewer,
    },
    async (request) => {
      const { meeting } = getMeetingAccess(request);

      return getSuggestedActionsStatus(meeting.id);
    },
  );
}

async function handleRunSuggestedActionsRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting } = getMeetingAccess(input.request);
  const meetingId = meeting.id;

  const runtimeState = await repositories().getMeetingRuntimeState(meetingId);
  if (meeting.status !== "ended" || runtimeState.activeHumanParticipantCount > 0) {
    return input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_STILL_ACTIVE_SUGGESTED_ACTIONS });
  }

  if (await sendPostMeetingPipelineSkippedIfNeeded({ reply: input.reply, meeting, meetingId })) {
    return;
  }

  return startSuggestedActionsRun(meetingId, input.request.log);
}

function registerRunSuggestedActionsRoute(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/run-suggested-actions",
    {
      preHandler: requireParticipantNotesAccess,
    },
    async (request, reply) => handleRunSuggestedActionsRequest({ request, reply }),
  );
}

function registerAiJobsRoute(app: FastifyInstance): void {
  app.get(
    "/meetings/:meetingId/ai-jobs",
    {
      preHandler: requireParticipantNotesAccess,
    },
    async (request) => {
      const { meeting } = getMeetingAccess(request);

      const jobs = await repositories().listAiWorkflowJobsForMeeting(meeting.id);

      return aiWorkflowJobsResponseSchema.parse({ jobs });
    },
  );
}

export async function meetingPipelineRoutes(app: FastifyInstance): Promise<void> {
  registerPreparationPreviewRoute(app);
  registerExtractionLookupRoute(app);
  registerRunSummaryRoute(app);
  registerRunExtractionRoute(app);
  registerRunSnapshotRoute(app);
  registerRegenerateNotesRoute(app);
  registerRunExtractionSignalsRoute(app);
  registerRunSelectionRoute(app);
  registerSuggestedActionsStatusRoute(app);
  registerRunSuggestedActionsRoute(app);
  registerAiJobsRoute(app);
}
