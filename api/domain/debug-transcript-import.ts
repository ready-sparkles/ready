import { z } from "zod";

type ParsedDebugTranscriptSegment = {
  speakerIdentity: string;
  speakerName: string;
  speakerRole: "human";
  source: "manual-note";
  content: string;
  startedAt: Date;
  endedAt: Date;
};

const SPEAKER_LINE_PATTERN = /^([^:\n]{1,120}):\s*(.*)$/;
const DEFAULT_SEGMENT_DURATION_MS = 22_000;
const DEFAULT_SEGMENT_GAP_MS = 8_000;
const CLOCK_TIME_PART_COUNT_MIN = 2;
const CLOCK_TIME_PART_COUNT_MAX = 3;
const CLOCK_TIME_FULL_PART_COUNT = 3;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;

const DEBUG_TRANSCRIPT_MESSAGES = {
  timestampEmpty: "Timestamp is empty",
  invalidTimestamp: (value: string) => `Invalid timestamp "${value}"`,
  transcriptFormat: 'Transcript format must use "Speaker: content" lines',
  transcriptEmpty: "Transcript is empty",
  noSegmentsParsed: "No transcript segments could be parsed",
  jsonInvalid: "Transcript JSON is invalid",
  jsonMustBeNonEmptyArray: "Transcript JSON must be a non-empty array",
  missingSpeakerName: (index: number) => `Transcript JSON entry ${index + 1} is missing speaker_name`,
  missingSentence: (index: number) => `Transcript JSON entry ${index + 1} is missing sentence`,
};

const debugTranscriptJsonEntrySchema = z.preprocess(
  (entry) => entry ?? {},
  z.object({
    sentence: z.unknown().optional(),
    startTime: z.unknown().optional(),
    endTime: z.unknown().optional(),
    speaker_name: z.unknown().optional(),
    speaker_id: z.unknown().optional(),
  }),
);

const debugTranscriptJsonArraySchema = z.array(debugTranscriptJsonEntrySchema).min(1);

function normalizeSpeakerName(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSegmentContent(value: string) {
  return value
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toSpeakerIdentity(input: { speakerName: string; index: number; speakerId?: string | number | null }) {
  const normalizedSpeakerId =
    typeof input.speakerId === "number" || (typeof input.speakerId === "string" && input.speakerId.trim() !== "")
      ? String(input.speakerId)
      : null;

  if (normalizedSpeakerId !== null && normalizedSpeakerId !== "") {
    return `debug-speaker:${normalizedSpeakerId}`;
  }

  const normalizedName = input.speakerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const speakerSlug = normalizedName !== "" ? normalizedName : `speaker-${input.index + 1}`;

  return `debug:${speakerSlug}`;
}

function parseClockTimeToMs(value: string) {
  const normalized = value.trim();
  if (normalized === "") {
    throw new Error(DEBUG_TRANSCRIPT_MESSAGES.timestampEmpty);
  }

  const parts = normalized.split(":").map((part) => part.trim());
  if (
    parts.length < CLOCK_TIME_PART_COUNT_MIN ||
    parts.length > CLOCK_TIME_PART_COUNT_MAX ||
    parts.some((part) => !/^\d+$/.test(part))
  ) {
    throw new Error(DEBUG_TRANSCRIPT_MESSAGES.invalidTimestamp(value));
  }

  const numericParts = parts.map((part) => Number(part));
  const [hours, minutes, seconds] =
    numericParts.length === CLOCK_TIME_FULL_PART_COUNT ? numericParts : [0, numericParts[0] ?? 0, numericParts[1] ?? 0];

  return (
    ((hours ?? 0) * SECONDS_PER_HOUR + (minutes ?? 0) * SECONDS_PER_MINUTE + (seconds ?? 0)) * MILLISECONDS_PER_SECOND
  );
}

function mapSegmentsToTimeline(
  segments: {
    speakerName: string;
    content: string;
    speakerId?: string | number | null;
    startedAtMs?: number;
    endedAtMs?: number;
  }[],
) {
  const baseStartedAt = Date.now();

  return segments.map<ParsedDebugTranscriptSegment>((segment, index) => {
    const fallbackStartedAtMs = index * (DEFAULT_SEGMENT_DURATION_MS + DEFAULT_SEGMENT_GAP_MS);
    const startedAtMs = segment.startedAtMs ?? fallbackStartedAtMs;
    const endedAtMs =
      segment.endedAtMs !== undefined && segment.endedAtMs >= startedAtMs
        ? segment.endedAtMs
        : startedAtMs + DEFAULT_SEGMENT_DURATION_MS;
    const startedAt = new Date(baseStartedAt + startedAtMs);
    const endedAt = new Date(baseStartedAt + endedAtMs);
    const speakerName = segment.speakerName;

    return {
      speakerIdentity: toSpeakerIdentity({ speakerName, index, speakerId: segment.speakerId }),
      speakerName,
      speakerRole: "human",
      source: "manual-note",
      content: segment.content,
      startedAt,
      endedAt,
    };
  });
}

type DebugTranscriptDraft = {
  speakerName: string | null;
  content: string;
  segments: { speakerName: string; content: string }[];
};

function commitDebugTranscriptSegment(draft: DebugTranscriptDraft) {
  if (draft.speakerName === null) {
    return draft.segments;
  }

  const normalizedContent = normalizeSegmentContent(draft.content);
  if (normalizedContent === "") {
    return draft.segments;
  }

  return [...draft.segments, { speakerName: draft.speakerName, content: normalizedContent }];
}

function readDebugTranscriptLine(draft: DebugTranscriptDraft, rawLine: string): DebugTranscriptDraft {
  const trimmedLine = rawLine.trim();
  if (trimmedLine === "") {
    return draft.content === "" ? draft : { ...draft, content: `${draft.content}\n` };
  }

  const speakerMatch = trimmedLine.match(SPEAKER_LINE_PATTERN);
  if (speakerMatch) {
    const nextSpeakerName = normalizeSpeakerName(speakerMatch[1] ?? "");
    const firstContentChunk = (speakerMatch[2] ?? "").trim();
    if (nextSpeakerName !== "") {
      return {
        speakerName: nextSpeakerName,
        content: firstContentChunk,
        segments: commitDebugTranscriptSegment(draft),
      };
    }
  }

  if (draft.speakerName === null) {
    throw new Error(DEBUG_TRANSCRIPT_MESSAGES.transcriptFormat);
  }

  return {
    ...draft,
    content: draft.content === "" ? trimmedLine : `${draft.content}\n${trimmedLine}`,
  };
}

export function parseDebugTranscriptInput(input: string): ParsedDebugTranscriptSegment[] {
  const normalizedInput = input.replace(/\r\n/g, "\n").trim();
  if (normalizedInput === "") {
    throw new Error(DEBUG_TRANSCRIPT_MESSAGES.transcriptEmpty);
  }

  const draft = normalizedInput.split("\n").reduce<DebugTranscriptDraft>(readDebugTranscriptLine, {
    speakerName: null,
    content: "",
    segments: [],
  });
  const segments = commitDebugTranscriptSegment(draft);

  if (segments.length === 0) {
    throw new Error(DEBUG_TRANSCRIPT_MESSAGES.noSegmentsParsed);
  }

  return mapSegmentsToTimeline(segments);
}

function parseDebugTranscriptJsonArray(input: string) {
  try {
    const parsed = debugTranscriptJsonArraySchema.safeParse(JSON.parse(input));
    if (!parsed.success) {
      throw new Error(DEBUG_TRANSCRIPT_MESSAGES.jsonMustBeNonEmptyArray);
    }

    return parsed.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    throw new Error(DEBUG_TRANSCRIPT_MESSAGES.jsonInvalid);
  }
}

export function parseDebugTranscriptJsonInput(input: string): ParsedDebugTranscriptSegment[] {
  const parsed = parseDebugTranscriptJsonArray(input);

  const segments = parsed.map((record, index) => {
    const speakerName = normalizeSpeakerName(typeof record.speaker_name === "string" ? record.speaker_name : "");
    const content = normalizeSegmentContent(typeof record.sentence === "string" ? record.sentence : "");

    if (speakerName === "") {
      throw new Error(DEBUG_TRANSCRIPT_MESSAGES.missingSpeakerName(index));
    }

    if (content === "") {
      throw new Error(DEBUG_TRANSCRIPT_MESSAGES.missingSentence(index));
    }

    const startedAtMs =
      typeof record.startTime === "string" && record.startTime.trim() !== ""
        ? parseClockTimeToMs(record.startTime)
        : undefined;
    const endedAtMs =
      typeof record.endTime === "string" && record.endTime.trim() !== ""
        ? parseClockTimeToMs(record.endTime)
        : undefined;

    return {
      speakerName,
      content,
      speakerId:
        typeof record.speaker_id === "number" || typeof record.speaker_id === "string" ? record.speaker_id : null,
      startedAtMs,
      endedAtMs,
    };
  });

  return mapSegmentsToTimeline(segments);
}
