import { RequestExecutionExpiredError } from "@readymeet/db/domain/request-execution";
import type { RepositoryPort } from "@readymeet/db/ports/repository";

import { shouldReplaceMeetingTitleWithSnapshot } from "../domain/meeting-title";
import {
  evaluatePostMeetingPipelineEligibility,
  type PipelineEligibilityInput,
  type PostMeetingPipelineSkipReason,
} from "../domain/post-meeting-pipeline-eligibility";
import type { AppLogger } from "../ports/app-logger";
import {
  startMeetingAssistant,
  stopLiveMeetingTranscription,
  stopMeetingAssistant,
} from "../ports/gate-assistant-client";
import { deleteLiveKitRoom } from "../ports/gate-livekit";
import { listConnectedMeetingUserIds } from "../ports/gate-livekit-participant-presence";
import { repositories } from "../ports/repository-runtime";

import { keepMeetingFinalizationClaimAlive } from "./finalization-claim-heartbeat";
import { deactivateMeetingCallInForEndedMeeting } from "./meeting-call-in";
import { buildFallbackMeetingTitle } from "./meeting-title-fallback";
import { recordFinalizedMeetingUsage } from "./usage-metering";

type LoggerLike = Pick<AppLogger, "warn">;

const assistantCoverageRecheckTimers = new Map<string, NodeJS.Timeout>();
const DEFAULT_ASSISTANT_RECHECK_DELAY_MS = 1_500;
const SHORT_MEETING_SUMMARY = "This meeting was too short to generate a reliable summary or next steps.";

type PostMeetingDisposition = {
  status: "skipped";
  reason: PostMeetingPipelineSkipReason;
  redirectTo: "/workspace?view=upcoming";
  message: string;
};

export function buildPostMeetingSkippedDisposition(reason: PostMeetingPipelineSkipReason): PostMeetingDisposition {
  return {
    status: "skipped",
    reason,
    redirectTo: "/workspace?view=upcoming",
    message:
      reason === "too_short_duration"
        ? "Meeting was too short to process, so we skipped notes and tasks."
        : "There wasn’t enough transcript to create notes or tasks.",
  };
}

export function hasFinalizedTranscript(
  transcriptData: Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>> | null,
): boolean {
  if (!transcriptData) {
    return false;
  }

  return (
    transcriptData.transcript.source === "livekit-python-postcall" ||
    transcriptData.transcript.source === "livekit-postcall" ||
    transcriptData.transcript.metadata.mode === "postcall-refined" ||
    transcriptData.transcript.metadata.mode === "agent-live-finalized" ||
    typeof transcriptData.transcript.metadata.finalizedAt === "string" ||
    typeof transcriptData.transcript.metadata.refinedAt === "string"
  );
}

async function getPostMeetingPipelineSkipDispositionNamed(input: {
  meetingId: string;
  partialInput: Partial<PipelineEligibilityInput>;
}): Promise<PostMeetingDisposition | null> {
  const meeting = input.partialInput.meeting ?? (await repositories().getMeetingById(input.meetingId));
  const transcriptData =
    input.partialInput.transcriptData ?? (await repositories().getTranscriptForMeeting(input.meetingId));
  const eligibility = evaluatePostMeetingPipelineEligibility({ meeting, transcriptData });

  if (eligibility.eligible) {
    return null;
  }

  await repositories().markMeetingHiddenFromHistory({
    meetingId: input.meetingId,
    reason: eligibility.reason,
  });

  return buildPostMeetingSkippedDisposition(eligibility.reason);
}

export async function getPostMeetingPipelineSkipDisposition(
  ...args: [meetingId: string, input?: Partial<PipelineEligibilityInput>]
): Promise<PostMeetingDisposition | null> {
  return getPostMeetingPipelineSkipDispositionNamed({ meetingId: args[0], partialInput: args[1] ?? {} });
}

async function ensureFinalTranscriptMarker(input: { meetingId: string; logger: LoggerLike }) {
  try {
    await repositories().updateTranscriptForMeeting({
      meetingId: input.meetingId,
      source: "livekit-python-live",
      metadata: {
        mode: "agent-live-finalized",
        finalizedAt: new Date().toISOString(),
        /** @external transcript finalized via lifecycle fallback */
        fallbackFinalized: true,
      },
    });
  } catch (error) {
    input.logger.warn(
      { error, meetingId: input.meetingId },
      "Failed to mark transcript finalized during lifecycle finalization",
    );
  }
}

async function persistTerminalFallbackArtifacts(input: { meetingId: string; content: string; model: string }) {
  return repositories().upsertSummaryForMeeting({ ...input, shouldPreserveExisting: true });
}

async function generatePostCallSnapshot(input: { meetingId: string; logger: LoggerLike }) {
  const { generateAndPersistMeetingSnapshot, persistSnapshotFallbackIfMissing } = await import("./snapshot-artifacts");
  try {
    return await generateAndPersistMeetingSnapshot(input);
  } catch (error) {
    input.logger.warn({ error, meetingId: input.meetingId }, "Failed to save post-call notes.");
    if (!(error instanceof RequestExecutionExpiredError)) {
      await persistSnapshotFallbackIfMissing({ ...input, error });
    }

    return null;
  }
}

async function enqueueLightweightPostCallArtifacts(input: { meetingId: string; logger: LoggerLike }) {
  const result = await generatePostCallSnapshot(input);
  if (result === null) {
    return;
  }
  const { generateAndPersistMeetingTasks } = await import("./task-artifacts");
  try {
    await generateAndPersistMeetingTasks(input.meetingId, input.logger, {
      initialCandidates: result.snapshot.taskCandidates,
    });
  } catch (error) {
    input.logger.warn(
      { error, meetingId: input.meetingId },
      "Failed to save post-call tasks; saved notes are unchanged.",
    );
  }
}

async function ensureTerminalPostCallArtifacts(input: {
  meetingId: string;
  logger: LoggerLike;
  transcriptData: Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>> | null;
}): Promise<PostMeetingDisposition | null> {
  const meeting = await repositories().getMeetingById(input.meetingId);
  if (meeting?.kind === "agent_intro") {
    await enqueueLightweightPostCallArtifacts({ meetingId: input.meetingId, logger: input.logger });

    return null;
  }

  const skippedDisposition = await getPostMeetingPipelineSkipDisposition(input.meetingId, {
    meeting,
    transcriptData: input.transcriptData,
  });

  if (skippedDisposition !== null) {
    await persistTerminalFallbackArtifacts({
      meetingId: input.meetingId,
      content: SHORT_MEETING_SUMMARY,
      model: "short-meeting-v1",
    });

    return skippedDisposition;
  }

  await enqueueLightweightPostCallArtifacts({ meetingId: input.meetingId, logger: input.logger });

  return null;
}

async function recordFinalizedUsageSafely(input: { meetingId: string; hasTranscript: boolean; logger: LoggerLike }) {
  try {
    await recordFinalizedMeetingUsage({
      meetingId: input.meetingId,
      hasTranscript: input.hasTranscript,
    });
  } catch (error) {
    input.logger.warn({ error, meetingId: input.meetingId }, "Failed to record finalized meeting usage");
  }
}

async function hasTerminalPostCallArtifactsOrPendingSnapshot(meetingId: string) {
  const [summary, latestSnapshotJob] = await Promise.all([
    repositories().getSummaryForMeeting(meetingId),
    repositories().getLatestAiWorkflowJobForMeeting({
      meetingId,
      type: "generate_meeting_snapshot",
    }),
  ]);

  return summary !== null || latestSnapshotJob?.status === "queued" || latestSnapshotJob?.status === "running";
}

async function cleanupEndedMeetingRuntime(input: {
  meeting: Awaited<ReturnType<RepositoryPort["getMeetingById"]>>;
  logger: LoggerLike;
}) {
  if (input.meeting === null) {
    return;
  }
  const meeting = input.meeting;
  const logger = input.logger;

  try {
    await deleteLiveKitRoom(meeting.roomName);
  } catch (error) {
    logger.warn(
      { error, meetingId: meeting.id, roomName: meeting.roomName },
      "Failed to delete LiveKit room during lifecycle finalization",
    );
  }

  // Phone-provider latency must not delay notes. Failed or late cleanup keeps
  // the persisted rule ID for an explicit retry; no background sweep runs.
  void (async () => {
    try {
      await deactivateMeetingCallInForEndedMeeting({ meeting, logger });
    } catch (error) {
      logger.warn({ err: error, meetingId: meeting.id }, "Deferred call-in cleanup failed");
    }
  })();

  try {
    await stopMeetingAssistant(meeting.id);
  } catch (error) {
    logger.warn({ error, meetingId: meeting.id }, "Failed to stop room assistant during lifecycle finalization");
  }
}

// A crashed run keeps its claim this long before a later request may take finalization over.
const FINALIZATION_CLAIM_LEASE_MINUTES = 15;
const MILLISECONDS_PER_MINUTE = 60_000;
const FINALIZATION_CLAIM_LEASE_MS = FINALIZATION_CLAIM_LEASE_MINUTES * MILLISECONDS_PER_MINUTE;
// A live run renews its claim this often, well inside the lease, so a slow run is never taken over.
const FINALIZATION_CLAIM_HEARTBEAT_MS = MILLISECONDS_PER_MINUTE;

// A finalization this young is treated as still writing the snapshot. Older claims may belong to a
// crashed run, so on-demand snapshot requests stop deferring and generate the notes themselves.
const SNAPSHOT_DEFERS_TO_FINALIZATION_MINUTES = 3;
const SNAPSHOT_DEFERS_TO_FINALIZATION_MS = SNAPSHOT_DEFERS_TO_FINALIZATION_MINUTES * MILLISECONDS_PER_MINUTE;

/** True when another request is finalizing the meeting and will write its snapshot. */
export async function isMeetingFinalizationInFlight(meetingId: string): Promise<boolean> {
  return repositories().hasFreshMeetingFinalizationClaim({
    meetingId,
    freshMs: SNAPSHOT_DEFERS_TO_FINALIZATION_MS,
  });
}

/** Runs `run` only while this request holds the meeting's durable finalization claim. */
async function withMeetingFinalizationClaim(input: {
  meetingId: string;
  logger: LoggerLike;
  run: () => Promise<PostMeetingDisposition | null>;
}): Promise<PostMeetingDisposition | null> {
  const claimId = await repositories().claimMeetingFinalization({
    meetingId: input.meetingId,
    leaseMs: FINALIZATION_CLAIM_LEASE_MS,
  });
  if (claimId === null) {
    return null;
  }
  const stopHeartbeat = keepMeetingFinalizationClaimAlive({
    meetingId: input.meetingId,
    claimId,
    intervalMs: FINALIZATION_CLAIM_HEARTBEAT_MS,
    logger: input.logger,
  });
  try {
    return await input.run();
  } finally {
    stopHeartbeat();
    await repositories().releaseMeetingFinalization({ meetingId: input.meetingId, claimId });
  }
}

async function finalizeTranscriptAndPostCallArtifacts(input: {
  meetingId: string;
  logger: LoggerLike;
}): Promise<PostMeetingDisposition | null> {
  const disposition = await finalizeTranscriptAndArtifacts(input);
  // Memory is a side artifact of notes that are already saved. Its failure must not turn the
  // end request or webhook into a 5xx, which would tell the host the meeting did not end.
  try {
    const { generateFinalizedMeetingMemories } = await import("./relationship-memory");
    await generateFinalizedMeetingMemories(input.meetingId);
  } catch (error) {
    input.logger.warn({ err: error, meetingId: input.meetingId }, "Post-call memory generation failed");
  }

  return disposition;
}

async function finalizeTranscriptAndArtifacts(input: {
  meetingId: string;
  logger: LoggerLike;
}): Promise<PostMeetingDisposition | null> {
  try {
    const result = await stopLiveMeetingTranscription(input.meetingId);
    const transcriptData = await repositories().getTranscriptForMeeting(input.meetingId);
    const meeting = await repositories().getMeetingById(input.meetingId);

    if (meeting !== null && shouldReplaceMeetingTitleWithSnapshot(meeting.title)) {
      const generatedTitle = await buildFallbackMeetingTitle(input.meetingId, transcriptData);
      if (generatedTitle !== null && generatedTitle !== "") {
        await repositories().updateMeetingTitle({
          meetingId: input.meetingId,
          title: generatedTitle,
        });
      }
    }

    const isTranscriptFinalized = result.finalized ?? false;
    if (!isTranscriptFinalized && !hasFinalizedTranscript(transcriptData)) {
      await ensureFinalTranscriptMarker({ meetingId: input.meetingId, logger: input.logger });
    }

    const finalTranscriptData = await repositories().getTranscriptForMeeting(input.meetingId);
    await recordFinalizedUsageSafely({
      meetingId: input.meetingId,
      hasTranscript: hasFinalizedTranscript(finalTranscriptData),
      logger: input.logger,
    });

    return await ensureTerminalPostCallArtifacts({
      meetingId: input.meetingId,
      logger: input.logger,
      transcriptData: finalTranscriptData,
    });
  } catch (error) {
    input.logger.warn(
      { error, meetingId: input.meetingId },
      "Failed to finalize backend transcription during lifecycle finalization",
    );
    await ensureFinalTranscriptMarker({ meetingId: input.meetingId, logger: input.logger });
    const finalTranscriptData = await repositories().getTranscriptForMeeting(input.meetingId);
    await recordFinalizedUsageSafely({
      meetingId: input.meetingId,
      hasTranscript: hasFinalizedTranscript(finalTranscriptData),
      logger: input.logger,
    });

    return ensureTerminalPostCallArtifacts({
      meetingId: input.meetingId,
      logger: input.logger,
      transcriptData: finalTranscriptData,
    });
  }
}

async function recoverEndedMeetingFinalization(input: {
  meeting: Awaited<ReturnType<RepositoryPort["getMeetingById"]>>;
  logger: LoggerLike;
}): Promise<PostMeetingDisposition | null> {
  const meeting = input.meeting;
  if (meeting === null) {
    return null;
  }

  return withMeetingFinalizationClaim({
    meetingId: meeting.id,
    logger: input.logger,
    run: async () => {
      // Checked under the claim: a run that finished first has already stored or queued the notes.
      if (await hasTerminalPostCallArtifactsOrPendingSnapshot(meeting.id)) {
        return null;
      }
      await cleanupEndedMeetingRuntime({ meeting, logger: input.logger });

      return finalizeTranscriptAndPostCallArtifacts({ meetingId: meeting.id, logger: input.logger });
    },
  });
}

async function finalizeAlreadyEndedMeeting(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  meetingId: string;
  logger: LoggerLike;
  runtimeState: Awaited<ReturnType<RepositoryPort["getMeetingRuntimeState"]>>;
}) {
  if (input.runtimeState.activeHumanParticipantCount > 0) {
    await repositories().markAllHumanParticipantsLeft(input.meetingId);
  }
  const postMeetingDisposition = await recoverEndedMeetingFinalization({
    meeting: input.meeting,
    logger: input.logger,
  });

  return {
    /** @external meeting finalization completed flag */
    finalized: true,
    postMeetingDisposition,
    runtimeState: {
      ...input.runtimeState,
      activeHumanParticipantCount: 0,
      activeHumanParticipants: [],
    },
  };
}

async function finalizeActiveMeeting(input: {
  meetingId: string;
  logger: LoggerLike;
  runtimeState: Awaited<ReturnType<RepositoryPort["getMeetingRuntimeState"]>>;
  meetingBeforeEnd: Awaited<ReturnType<RepositoryPort["getMeetingById"]>>;
  isForced: boolean;
}) {
  const hasEndedMeeting = await repositories().markMeetingEnded(input.meetingId);
  if (input.isForced) {
    await repositories().markAllHumanParticipantsLeft(input.meetingId);
  }
  // Only the request that ended the meeting finalizes it directly; an overlapping request recovers.
  const postMeetingDisposition = hasEndedMeeting
    ? await withMeetingFinalizationClaim({
        meetingId: input.meetingId,
        logger: input.logger,
        run: async () => {
          await cleanupEndedMeetingRuntime({ meeting: input.meetingBeforeEnd, logger: input.logger });

          return finalizeTranscriptAndPostCallArtifacts({ meetingId: input.meetingId, logger: input.logger });
        },
      })
    : await recoverEndedMeetingFinalization({ meeting: input.meetingBeforeEnd, logger: input.logger });

  return {
    /** @external meeting finalization completed flag */
    finalized: true,
    postMeetingDisposition,
    runtimeState: {
      ...input.runtimeState,
      activeHumanParticipantCount: 0,
      activeHumanParticipants: [],
    },
  };
}

type MeetingFinalizationIdleResult = {
  /** @external meeting finalization completed flag */
  finalized: boolean;
  runtimeState: Awaited<ReturnType<RepositoryPort["getMeetingRuntimeState"]>>;
  postMeetingDisposition?: PostMeetingDisposition | null;
};

async function finalizeMeetingIfIdleNamed(input: {
  meetingId: string;
  logger: LoggerLike;
  options: { /** @external force finalization despite idle checks */ force?: boolean };
}): Promise<MeetingFinalizationIdleResult> {
  const runtimeState = await repositories().getMeetingRuntimeState(input.meetingId);
  const meetingBeforeEnd = await repositories().getMeetingById(input.meetingId);
  const isForced = input.options.force ?? false;
  if (!isForced && meetingBeforeEnd?.status === "scheduled") {
    return { /** @external meeting finalization completed flag */ finalized: false, runtimeState };
  }
  if (meetingBeforeEnd?.status === "ended") {
    return finalizeAlreadyEndedMeeting({
      meeting: meetingBeforeEnd,
      meetingId: input.meetingId,
      logger: input.logger,
      runtimeState,
    });
  }

  if (!isForced && runtimeState.activeHumanParticipantCount > 0) {
    return {
      /** @external meeting finalization completed flag */
      finalized: false,
      runtimeState,
    };
  }

  if (
    !isForced &&
    meetingBeforeEnd !== null &&
    (await listConnectedMeetingUserIds({ meetingId: input.meetingId, roomName: meetingBeforeEnd.roomName })).size > 0
  ) {
    return { /** @external meeting finalization completed flag */ finalized: false, runtimeState };
  }

  return finalizeActiveMeeting({
    meetingId: input.meetingId,
    logger: input.logger,
    runtimeState,
    meetingBeforeEnd,
    isForced,
  });
}

export async function finalizeMeetingIfIdle(
  ...args: [
    meetingId: string,
    logger: LoggerLike,
    options?: { /** @external force finalization despite idle checks */ force?: boolean },
  ]
): Promise<MeetingFinalizationIdleResult> {
  return finalizeMeetingIfIdleNamed({ meetingId: args[0], logger: args[1], options: args[2] ?? {} });
}

async function enqueueMeetingPreparationPreview(input: {
  meeting: Awaited<ReturnType<RepositoryPort["getMeetingById"]>>;
  logger: LoggerLike;
}) {
  if (input.meeting === null) {
    return;
  }
  const meeting = input.meeting;

  const latestTitleJob = await repositories().getLatestAiWorkflowJobForMeeting({
    meetingId: meeting.id,
    type: "resolve_meeting_title",
    scopeKey: "default",
  });
  if (
    latestTitleJob?.status === "queued" ||
    latestTitleJob?.status === "running" ||
    latestTitleJob?.status === "completed"
  ) {
    return;
  }

  try {
    const { resolveAndPersistMeetingTitle } = await import("./meeting-title-resolution");
    await resolveAndPersistMeetingTitle({ meetingId: meeting.id });
  } catch (error) {
    input.logger.warn({ error, meetingId: meeting.id }, "Failed to save the meeting title.");
  }
}

async function scheduleFinalizationDeferral(input: {
  meetingId: string;
  meetingBeforeEnd: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  runtimeState: Awaited<ReturnType<RepositoryPort["getMeetingRuntimeState"]>>;
  isForced: boolean;
}): Promise<MeetingFinalizationIdleResult | null> {
  if (!input.isForced && input.meetingBeforeEnd.status === "scheduled") {
    return { /** @external meeting finalization completed flag */ finalized: false, runtimeState: input.runtimeState };
  }

  if (
    !input.isForced &&
    input.meetingBeforeEnd.status !== "ended" &&
    input.runtimeState.activeHumanParticipantCount > 0
  ) {
    return { /** @external meeting finalization completed flag */ finalized: false, runtimeState: input.runtimeState };
  }

  if (
    !input.isForced &&
    input.meetingBeforeEnd.status !== "ended" &&
    (await listConnectedMeetingUserIds({ meetingId: input.meetingId, roomName: input.meetingBeforeEnd.roomName }))
      .size > 0
  ) {
    return { /** @external meeting finalization completed flag */ finalized: false, runtimeState: input.runtimeState };
  }

  return null;
}

/** Finalize the transcript and artifacts within the owning request. */
async function scheduleMeetingFinalizationIfIdleNamed(input: {
  meetingId: string;
  logger: LoggerLike;
  options: { /** @external force finalization despite idle checks */ force?: boolean };
}): Promise<MeetingFinalizationIdleResult> {
  const runtimeState = await repositories().getMeetingRuntimeState(input.meetingId);
  const meetingBeforeEnd = await repositories().getMeetingById(input.meetingId);
  const isForced = input.options.force ?? false;

  if (meetingBeforeEnd === null) {
    return { /** @external meeting finalization completed flag */ finalized: false, runtimeState };
  }
  const deferral = await scheduleFinalizationDeferral({
    meetingId: input.meetingId,
    meetingBeforeEnd,
    runtimeState,
    isForced,
  });
  if (deferral !== null) {
    return deferral;
  }

  if (isForced || meetingBeforeEnd.status === "ended") {
    await repositories().markAllHumanParticipantsLeft(input.meetingId);
  }

  const finalization = await finalizeMeetingIfIdle(input.meetingId, input.logger, {
    force: isForced || meetingBeforeEnd.status === "ended",
  });
  if (!finalization.finalized) {
    return finalization;
  }

  const endedMeeting = (await repositories().getMeetingById(input.meetingId)) ?? meetingBeforeEnd;
  await enqueueMeetingPreparationPreview({ meeting: endedMeeting, logger: input.logger });

  return {
    /** @external meeting finalization completed flag */
    finalized: true,
    postMeetingDisposition: null,
    runtimeState: {
      ...runtimeState,
      activeHumanParticipantCount: 0,
      activeHumanParticipants: [],
    },
  };
}

export async function scheduleMeetingFinalizationIfIdle(
  ...args: [
    meetingId: string,
    logger: LoggerLike,
    options?: { /** @external force finalization despite idle checks */ force?: boolean },
  ]
): Promise<MeetingFinalizationIdleResult> {
  return scheduleMeetingFinalizationIfIdleNamed({ meetingId: args[0], logger: args[1], options: args[2] ?? {} });
}

async function ensureMeetingAssistantCoverageNamed(input: { meetingId: string; logger: LoggerLike }): Promise<boolean> {
  const meeting = await repositories().getMeetingById(input.meetingId);
  if (meeting === null || meeting.status === "ended") {
    return false;
  }

  const runtimeState = await repositories().getMeetingRuntimeState(input.meetingId);
  if (runtimeState.activeHumanParticipantCount === 0) {
    return false;
  }

  try {
    const result = await startMeetingAssistant(input.meetingId);

    return result.started;
  } catch (error) {
    input.logger.warn({ error, meetingId: input.meetingId }, "Failed to ensure room assistant coverage");

    return false;
  }
}

export async function ensureMeetingAssistantCoverage(
  ...args: [meetingId: string, logger: LoggerLike]
): Promise<boolean> {
  return ensureMeetingAssistantCoverageNamed({ meetingId: args[0], logger: args[1] });
}

function scheduleAssistantCoverageRecheckNamed(input: {
  meetingId: string;
  logger: LoggerLike;
  delayMs: number;
}): void {
  const existingTimeout = assistantCoverageRecheckTimers.get(input.meetingId);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  const timeoutId = setTimeout(() => {
    assistantCoverageRecheckTimers.delete(input.meetingId);
    void ensureMeetingAssistantCoverage(input.meetingId, input.logger);
  }, input.delayMs);

  timeoutId.unref();
  assistantCoverageRecheckTimers.set(input.meetingId, timeoutId);
}

export function scheduleAssistantCoverageRecheck(
  ...args: [meetingId: string, logger: LoggerLike, delayMs?: number]
): void {
  scheduleAssistantCoverageRecheckNamed({
    meetingId: args[0],
    logger: args[1],
    delayMs: args[2] ?? DEFAULT_ASSISTANT_RECHECK_DELAY_MS,
  });
}
