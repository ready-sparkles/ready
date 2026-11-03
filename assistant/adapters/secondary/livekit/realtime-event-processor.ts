import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  buildLiveKitTranscriptSourceSegmentId,
  type LiveKitRealtimeEvent,
  liveKitRealtimeEventSchema,
} from "@readymeet/shared";

import { assistantEnv } from "../../../ports/assistant-env";
import { repositories } from "../../../ports/repository-runtime";

type FinalTranscriptEvent = Extract<LiveKitRealtimeEvent, { type: "final_transcript" }>;
type FinalTranscriptSegment = FinalTranscriptEvent["segments"][number];

type LiveTranscriptDependencies = {
  appendSegment: (input: Parameters<RepositoryPort["appendTranscriptSegment"]>[0]) => Promise<{ id: string }>;
  enqueueJob: (input: Parameters<RepositoryPort["enqueueAiWorkflowJob"]>[0]) => Promise<unknown>;
};

const AI_WORK_FAILED_MESSAGE = "AI work request failed.";
const AI_WORK_AFTER_SAVED_SEGMENT_FAILED_LOG = "Live transcript segment saved, but starting AI work failed";
const LIVE_AI_WORK_TYPES = ["detect_ambient_context", "track_meeting"] as const;

async function requestAiWork(input: Parameters<RepositoryPort["enqueueAiWorkflowJob"]>[0]): Promise<void> {
  const baseUrl = assistantEnv().API_BASE_URL.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/v1/internal/ai-work`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET,
    },
    body: JSON.stringify({
      meetingId: input.meetingId,
      type: input.type,
      scopeKey: input.scopeKey,
      phase: input.phase,
      payload: input.payload ?? {},
      maxAttempts: input.maxAttempts,
    }),
  });
  if (!response.ok) {
    throw new Error(AI_WORK_FAILED_MESSAGE);
  }
}

const liveTranscriptDependencies: LiveTranscriptDependencies = {
  appendSegment: (input) => repositories().appendTranscriptSegment(input),
  enqueueJob: requestAiWork,
};

const INVALID_ISO_TIMESTAMP_PREFIX = "Invalid ISO timestamp: ";

function toOptionalString(value: string | null | undefined) {
  return value ?? undefined;
}

function toDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(INVALID_ISO_TIMESTAMP_PREFIX + value);
  }

  return parsed;
}

function resolveTranscriptLanguage(language: string | null | undefined): string {
  return language !== undefined && language !== null && language !== "" ? language : "";
}

function transcriptSettleMetadata(event: FinalTranscriptEvent) {
  return {
    transcriptSettleWaitSeconds: event.metadata.transcriptSettleWaitSeconds,
    transcriptSettleIdleSeconds: event.metadata.transcriptSettleIdleSeconds,
    transcriptSettleMaxSeconds: event.metadata.transcriptSettleMaxSeconds,
    // @external transcriptSettleComplete
    transcriptSettleComplete: event.metadata.transcriptSettleComplete,
    segmentCountBeforeSettle: event.metadata.segmentCountBeforeSettle,
    segmentCountAfterSettle: event.metadata.segmentCountAfterSettle,
  };
}

async function handleLiveTranscriptSegmentEvent(params: {
  event: Extract<LiveKitRealtimeEvent, { type: "live_transcript_segment" }>;
  dependencies: LiveTranscriptDependencies;
}): Promise<void> {
  const { event, dependencies } = params;
  const segment = await dependencies.appendSegment({
    meetingId: event.meetingId,
    speakerIdentity: event.segment.speakerIdentity,
    speakerName: event.segment.speakerName,
    speakerUserId: toOptionalString(event.segment.speakerUserId),
    speakerRole: "human",
    source: "livekit-python-live",
    sourceSegmentId: buildLiveKitTranscriptSourceSegmentId({
      participantIdentity: event.segment.speakerIdentity,
      trackSid: event.segment.trackSid,
      segmentId: event.segment.segmentId,
    }),
    content: event.segment.content,
    startedAt: toDate(event.segment.startedAt),
    endedAt: toDate(event.segment.endedAt),
  });
  const results = await Promise.allSettled(
    LIVE_AI_WORK_TYPES.map(async (type) =>
      dependencies.enqueueJob({
        meetingId: event.meetingId,
        type,
        scopeKey: type === "track_meeting" ? "default" : `ambient-window:${segment.id}`,
        phase: "queued",
        payload: { latestSegmentId: segment.id },
        maxAttempts: 1,
      }),
    ),
  );
  // Both calls acknowledge recorded work, without waiting for model execution.
  // The segment is already saved, so a failed request must not fail this
  // event: the caller would retry or give up on a line that is safely stored.
  // Later segments start the same work again.
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const error: unknown = result.reason;
      console.error(AI_WORK_AFTER_SAVED_SEGMENT_FAILED_LOG, {
        meetingId: event.meetingId,
        segmentId: segment.id,
        type: LIVE_AI_WORK_TYPES[index],
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  });
}

async function enqueueFinalAmbientContextDetection(event: FinalTranscriptEvent) {
  await requestAiWork({
    meetingId: event.meetingId,
    type: "detect_ambient_context",
    scopeKey: `ambient-final:${event.metadata.refinedAt}`,
    phase: "queued",
    payload: { finalizedAt: event.metadata.refinedAt },
    maxAttempts: 1,
  });
}

async function handleFinalTranscriptEvent(event: FinalTranscriptEvent) {
  if (event.metadata.mode === "agent-live-finalized") {
    await repositories().updateTranscriptForMeeting({
      meetingId: event.meetingId,
      source: "livekit-python-live",
      metadata: {
        mode: "agent-live-finalized",
        finalizedAt: event.metadata.refinedAt,
        recordingDir: event.metadata.recordingDir,
        segmentCount: event.metadata.segmentCount,
        transcriptionModel: event.metadata.transcriptionModel,
        language: resolveTranscriptLanguage(event.metadata.language),
        ...transcriptSettleMetadata(event),
      },
    });

    await enqueueFinalAmbientContextDetection(event);

    return;
  }

  await repositories().replaceTranscriptSegmentsForMeetingBySources({
    meetingId: event.meetingId,
    source: "livekit-python-postcall",
    metadata: {
      mode: event.metadata.mode,
      refinedAt: event.metadata.refinedAt,
      recordingDir: event.metadata.recordingDir,
      segmentCount: event.metadata.segmentCount,
      transcriptionModel: event.metadata.transcriptionModel,
      language: resolveTranscriptLanguage(event.metadata.language),
    },
    deleteSources: ["livekit-python-live", "livekit-python-postcall"],
    segments: event.segments.map((segment: FinalTranscriptSegment) => ({
      speakerIdentity: segment.speakerIdentity,
      speakerName: segment.speakerName,
      speakerUserId: toOptionalString(segment.speakerUserId),
      speakerRole: "human",
      source: "livekit-python-postcall",
      content: segment.content,
      startedAt: toDate(segment.startedAt),
      endedAt: toDate(segment.endedAt),
    })),
  });

  await repositories().updateTranscriptForMeeting({
    meetingId: event.meetingId,
    source: "livekit-python-postcall",
    metadata: {
      mode: "postcall-refined",
      finalizedAt: event.metadata.refinedAt,
      recordingDir: event.metadata.recordingDir,
      segmentCount: event.metadata.segmentCount,
      transcriptionModel: event.metadata.transcriptionModel,
      language: resolveTranscriptLanguage(event.metadata.language),
    },
  });

  await enqueueFinalAmbientContextDetection(event);
}

export async function processLiveKitRealtimeEvent(params: {
  payload: unknown;
  dependencies?: LiveTranscriptDependencies;
}): Promise<{
  // @external accepted
  accepted: boolean;
  type?: LiveKitRealtimeEvent["type"];
}> {
  const { payload, dependencies = liveTranscriptDependencies } = params;
  const event = liveKitRealtimeEventSchema.parse(payload);

  switch (event.type) {
    case "live_transcript_segment":
      await handleLiveTranscriptSegmentEvent({ event, dependencies });

      return {
        // @external accepted
        accepted: true,
        type: event.type,
      };
    case "final_transcript":
      await handleFinalTranscriptEvent(event);

      return {
        // @external accepted
        accepted: true,
        type: event.type,
      };
    default:
      return {
        // @external accepted
        accepted: false,
      };
  }
}
