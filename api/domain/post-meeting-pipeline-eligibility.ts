const MIN_POST_MEETING_DURATION_MS = 10_000;
const MIN_HUMAN_TRANSCRIPT_WORDS = 10;
const MIN_SEGMENT_TIMES_FOR_DURATION = 2;

export type PostMeetingPipelineSkipReason = "too_short_duration" | "too_short_transcript";

export type PipelineEligibilityInput = {
  meeting: { startedAt: Date | null; endedAt: Date | null } | null;
  transcriptData: {
    segments: readonly {
      speakerRole: string;
      content: string;
      startedAt: Date | null;
      endedAt: Date | null;
    }[];
  } | null;
};

function getMeetingDurationMs(input: PipelineEligibilityInput) {
  const { meeting, transcriptData } = input;
  if (meeting?.startedAt && meeting.endedAt) {
    return Math.max(0, meeting.endedAt.getTime() - meeting.startedAt.getTime());
  }

  const segmentTimes = (transcriptData?.segments ?? [])
    .flatMap((segment) => [segment.startedAt, segment.endedAt])
    .filter((value): value is Date => value instanceof Date);

  if (segmentTimes.length < MIN_SEGMENT_TIMES_FOR_DURATION) {
    return 0;
  }

  const starts = segmentTimes.map((value) => value.getTime());

  return Math.max(0, Math.max(...starts) - Math.min(...starts));
}

function countHumanTranscriptWords(transcriptData: PipelineEligibilityInput["transcriptData"]) {
  const text = (transcriptData?.segments ?? [])
    .filter((segment) => segment.speakerRole === "human")
    .map((segment) => segment.content)
    .join(" ");

  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function evaluatePostMeetingPipelineEligibility(input: PipelineEligibilityInput):
  | {
      /** @external post-meeting pipeline eligible flag */
      eligible: true;
      durationMs: number;
      humanTranscriptWordCount: number;
    }
  | {
      /** @external post-meeting pipeline eligible flag */
      eligible: false;
      reason: PostMeetingPipelineSkipReason;
      durationMs: number;
      humanTranscriptWordCount: number;
    } {
  const durationMs = getMeetingDurationMs({ meeting: input.meeting, transcriptData: input.transcriptData });
  const humanTranscriptWordCount = countHumanTranscriptWords(input.transcriptData);

  if (durationMs < MIN_POST_MEETING_DURATION_MS) {
    return {
      /** @external post-meeting pipeline eligible flag */
      eligible: false as const,
      reason: "too_short_duration" as const,
      durationMs,
      humanTranscriptWordCount,
    };
  }

  if (humanTranscriptWordCount < MIN_HUMAN_TRANSCRIPT_WORDS) {
    return {
      /** @external post-meeting pipeline eligible flag */
      eligible: false as const,
      reason: "too_short_transcript" as const,
      durationMs,
      humanTranscriptWordCount,
    };
  }

  return {
    /** @external post-meeting pipeline eligible flag */
    eligible: true as const,
    durationMs,
    humanTranscriptWordCount,
  };
}
