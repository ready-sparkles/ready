import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  type DismissedMeetingTaskTombstone,
  type MeetingExtraction,
  type MeetingSnapshot,
  type MeetingTaskCandidate,
  type MeetingTaskGeneration,
  type MeetingTrackerState,
} from "@readymeet/shared";
import { groundedVoiceSearchIdentityEvidence } from "@readymeet/shared/server/voice-research-evidence";

import { repositories } from "../ports/repository-runtime";

import { runContentExtraction, type RunExtractionInput, runSignalExtraction } from "./extraction-orchestrator";
import { runMeetingSnapshot } from "./extraction-snapshot";
import {
  type MeetingTaskChunkExtractionInput,
  type MeetingTaskReconciliationInput,
  runMeetingTaskChunkExtraction,
  runMeetingTaskReconciliation,
  runMeetingTasks,
} from "./extraction-tasks";
import { type MeetingTitleResult, runMeetingTitle } from "./extraction-title";

const MEETING_EXTRACTION_MESSAGES = {
  meetingNotFound: (meetingId: string) => `Meeting "${meetingId}" not found`,
  transcriptNotFound: (meetingId: string) => `Transcript for meeting "${meetingId}" not found`,
  voiceEvidenceUnavailable: "Optional voice identity evidence unavailable; continuing with transcript",
  liveSummaryUnavailable: "Optional live summary unavailable; continuing with transcript",
} as const;

type VoiceSearchEvidenceLoadResult = Awaited<ReturnType<RepositoryPort["listVoiceSearchEvidenceForMeeting"]>>;

export async function loadOptionalVoiceSearchEvidence(params: {
  meetingId: string;
  load?: RepositoryPort["listVoiceSearchEvidenceForMeeting"];
}): Promise<VoiceSearchEvidenceLoadResult> {
  const load =
    params.load ??
    ((input: Parameters<RepositoryPort["listVoiceSearchEvidenceForMeeting"]>[0]) =>
      repositories().listVoiceSearchEvidenceForMeeting(input));

  try {
    return await load({ meetingId: params.meetingId, includeResults: true, completedOnly: true });
  } catch (error) {
    console.error(
      JSON.stringify({
        component: "meeting-extraction",
        meetingId: params.meetingId,
        message: MEETING_EXTRACTION_MESSAGES.voiceEvidenceUnavailable,
        // Only the error class: messages can carry private connection details.
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );

    return [];
  }
}

export async function loadOptionalLiveSummary(params: {
  meetingId: string;
  load?: (meetingId: string) => Promise<MeetingTrackerState>;
}): Promise<MeetingTrackerState | undefined> {
  const load = params.load ?? ((meetingId: string) => repositories().readMeetingTracker(meetingId));
  try {
    return await load(params.meetingId);
  } catch (error) {
    console.error(
      JSON.stringify({
        component: "meeting-extraction",
        meetingId: params.meetingId,
        message: MEETING_EXTRACTION_MESSAGES.liveSummaryUnavailable,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );

    return undefined;
  }
}

async function buildExtractionInput(params: {
  meetingId: string;
  shouldIncludeVoiceSearchEvidence?: boolean;
  shouldIncludeLiveSummary?: boolean;
  /**
   * Treat a meeting with no transcript row yet as an empty transcript instead
   * of an error. Titling uses this: no transcript means no human speech, the
   * same expected outcome as an empty transcript.
   */
  shouldTreatMissingTranscriptAsEmpty?: boolean;
}): Promise<RunExtractionInput> {
  const shouldIncludeVoiceSearchEvidence = params.shouldIncludeVoiceSearchEvidence === true;
  const [meeting, transcriptData, participants, research, liveSummary] = await Promise.all([
    repositories().getMeetingById(params.meetingId),
    repositories().getTranscriptForMeeting(params.meetingId),
    repositories().listParticipantsForMeeting(params.meetingId),
    shouldIncludeVoiceSearchEvidence
      ? loadOptionalVoiceSearchEvidence({ meetingId: params.meetingId })
      : Promise.resolve([]),
    params.shouldIncludeLiveSummary === true
      ? loadOptionalLiveSummary({ meetingId: params.meetingId })
      : Promise.resolve(undefined),
  ]);

  if (meeting === null) {
    throw new Error(MEETING_EXTRACTION_MESSAGES.meetingNotFound(params.meetingId));
  }

  if (transcriptData === null && params.shouldTreatMissingTranscriptAsEmpty !== true) {
    throw new Error(MEETING_EXTRACTION_MESSAGES.transcriptNotFound(params.meetingId));
  }
  const transcriptSegments = transcriptData?.segments ?? [];

  const durationMs =
    meeting.startedAt !== null && meeting.endedAt !== null
      ? meeting.endedAt.getTime() - meeting.startedAt.getTime()
      : null;

  return {
    meetingId: params.meetingId,
    ...(liveSummary ? { liveSummary } : {}),
    ...(shouldIncludeVoiceSearchEvidence
      ? {
          voiceSearchIdentityEvidence: groundedVoiceSearchIdentityEvidence({
            meetingId: params.meetingId,
            segments: transcriptSegments,
            runs: research,
          }),
        }
      : {}),
    transcript: transcriptSegments.map((segment) => ({
      id: segment.id,
      speakerIdentity: segment.speakerIdentity,
      speakerName: segment.speakerName,
      speakerRole:
        segment.speakerRole === "assistant" || segment.speakerRole === "system" ? segment.speakerRole : "human",
      content: segment.content,
      startedAt: segment.startedAt.toISOString(),
      endedAt: segment.endedAt !== null ? segment.endedAt.toISOString() : null,
    })),
    metadata: {
      title: meeting.title,
      participants: participants.map((participant) => ({
        userId: participant.userId,
        name: participant.displayName,
        email: participant.email,
        roleHint: participant.role,
      })),
      startedAt: meeting.startedAt !== null ? meeting.startedAt.toISOString() : null,
      durationMs,
    },
  };
}

export async function generateMeetingExtraction(meetingId: string): Promise<MeetingExtraction> {
  return runContentExtraction({ input: await buildExtractionInput({ meetingId }) });
}

export async function generateMeetingSnapshot(params: {
  meetingId: string;
  metering?: { jobId?: string | null; workflowRunId?: string | null } | null;
}): Promise<MeetingSnapshot> {
  return runMeetingSnapshot({
    input: await buildExtractionInput({
      meetingId: params.meetingId,
      shouldIncludeVoiceSearchEvidence: true,
      shouldIncludeLiveSummary: true,
    }),
    jobId: params.metering?.jobId ?? null,
    workflowRunId: params.metering?.workflowRunId ?? null,
  });
}

export async function generateMeetingTitle(params: {
  meetingId: string;
  metering?: { jobId?: string | null } | null;
  /** @external meetingInProgress */
  meetingInProgress?: boolean;
}): Promise<MeetingTitleResult> {
  return runMeetingTitle({
    input: await buildExtractionInput({
      meetingId: params.meetingId,
      shouldIncludeVoiceSearchEvidence: true,
      shouldTreatMissingTranscriptAsEmpty: true,
    }),
    jobId: params.metering?.jobId ?? null,
    meetingInProgress: params.meetingInProgress,
  });
}

export async function generateMeetingTasks(params: {
  meetingId: string;
  initialCandidates: MeetingTaskCandidate[];
  dismissedTombstones: DismissedMeetingTaskTombstone[];
  metering?: { jobId?: string | null; workflowRunId?: string | null } | null;
}): Promise<MeetingTaskGeneration> {
  return runMeetingTasks({
    input: await buildExtractionInput({
      meetingId: params.meetingId,
      shouldIncludeVoiceSearchEvidence: true,
      shouldIncludeLiveSummary: true,
    }),
    initialCandidates: params.initialCandidates,
    dismissedTombstones: params.dismissedTombstones,
    jobId: params.metering?.jobId ?? null,
    workflowRunId: params.metering?.workflowRunId ?? null,
  });
}

export async function generateMeetingTaskChunk(input: MeetingTaskChunkExtractionInput): Promise<MeetingTaskGeneration> {
  return runMeetingTaskChunkExtraction({ input });
}

export async function reconcileMeetingTasks(input: MeetingTaskReconciliationInput): Promise<MeetingTaskGeneration> {
  return runMeetingTaskReconciliation({ input });
}

export async function generateMeetingSignals(meetingId: string): Promise<MeetingExtraction> {
  return runSignalExtraction({ input: await buildExtractionInput({ meetingId }) });
}
