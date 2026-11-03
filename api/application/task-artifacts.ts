import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  buildMeetingTaskLanguageContext,
  estimateMeetingTaskInputTokens,
  MEETING_TASK_GLOBAL_VERIFICATION_INPUT_TOKEN_BUDGET,
  MEETING_TASKS_PROMPT_VERSION,
  type MeetingTaskActivityHints,
  type MeetingTaskCandidate,
  type MeetingTaskCompletion,
  type MeetingTaskDiagnostics,
  type MeetingTaskGeneration,
  meetingTaskGenerationSchema,
  meetingTaskLimitForParticipantCount,
  type MeetingTaskList,
  type MeetingTaskProgress,
  type MeetingTaskSourceQuote,
  OPEN_MEETING_TASK_COMPLETION,
} from "@readymeet/shared";
import { groundedVoiceSearchIdentityEvidence } from "@readymeet/shared/server/voice-research-evidence";
import { createHash } from "node:crypto";

import {
  triggerMeetingTaskChunk,
  triggerMeetingTaskReconciliation,
  triggerMeetingTasks,
} from "../ports/gate-assistant-client";
import { repositories } from "../ports/repository-runtime";

import { recordArtifactRequest } from "./artifact-request";

type LoggerLike = {
  info?(...args: [bindings: Record<string, unknown>, message: string]): void;
  warn?(...args: [bindings: Record<string, unknown>, message: string]): void;
};

/** @external ai workflow progress callback */
interface GenerateMeetingTasksPhaseListener {
  (phase: TaskGenerationPhase, progress?: MeetingTaskProgress | null): Promise<void>;
}

type GenerateMeetingTasksPublicOptions = {
  jobId?: string | null;
  initialCandidates?: MeetingTaskCandidate[];
  onPhaseChange?: GenerateMeetingTasksPhaseListener;
};

type GenerateMeetingTasksInternalOptions = {
  jobId?: string | null;
  initialCandidates?: MeetingTaskCandidate[];
  onPhaseChange?: (input: { phase: TaskGenerationPhase; progress?: MeetingTaskProgress | null }) => Promise<void>;
};

type MeetingTaskPipelineInput = {
  meetingId: string;
  logger: LoggerLike;
  options: GenerateMeetingTasksInternalOptions;
};

type MeetingTaskGenerationResult = {
  taskList: Awaited<ReturnType<RepositoryPort["replaceAndCompleteMeetingTasksForList"]>>["taskList"];
  tasks: Awaited<ReturnType<RepositoryPort["replaceAndCompleteMeetingTasksForList"]>>["tasks"];
  progress: MeetingTaskProgress;
};

type TaskGenerationPhase =
  | "reviewing_transcript"
  | "finding_followups"
  | "validating_tasks"
  | "preparing_tasks"
  | "complete";

type TranscriptData = NonNullable<Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>>>;
type TranscriptSegment = TranscriptData["segments"][number];
type MeetingParticipant = Awaited<ReturnType<RepositoryPort["listParticipantsForMeeting"]>>[number];
type CalendarCounterpart = Awaited<ReturnType<RepositoryPort["getDeterministicCalendarCounterpartForMeeting"]>>;

const SHORT_TASK_TRANSCRIPT_CHARS = 22_000;
const TASK_CHUNK_TARGET_CHARS = 12_000;
const TASK_CHUNK_OVERLAP_SEGMENTS = 2;
const PROCESS_ALL_CHUNKS_LIMIT = 32;
const MAX_SELECTED_LONG_CHUNKS = 32;
const TASK_LONG_MEETING_MIDDLE_SAMPLE_CHUNKS = 10;
const TASK_CHUNK_CONCURRENCY = 2;
const MAX_ACTIVITY_HINT_NAMES = 6;
const TASK_HINT_ACTION_WEIGHT = 3;
const TASK_TITLE_MIN_TOKEN_LENGTH = 3;
const CONTEXT_WINDOW_SEGMENTS_BEFORE = 1;
const CONTEXT_WINDOW_SEGMENTS_AFTER = 2;
const QUOTE_CONTEXT_MAX_CHARS = 600;
const PERSONAL_LIST_MAX_ITEMS = 8;
const PERSONAL_LIST_TAIL_MAX_MS = 75_000;
const ACCEPTANCE_NEARBY_SEGMENT_COUNT = 4;
const ACCEPTANCE_NEARBY_MAX_MS = 45_000;
const PERSONAL_LIST_INTRO_MAX_HUMAN_SEGMENTS = 7;
const PERSONAL_LIST_INTRO_MAX_MS = 60_000;
const LIVE_CANDIDATE_EVIDENCE_LIMIT = 5;
const TASK_PROGRESS_HEARTBEAT_MS = 10_000;
const MS_PER_SECOND = 1000;
const TASK_MERGE_HIGH_SIMILARITY = 0.85;
const TASK_MERGE_MEDIUM_SIMILARITY = 0.72;
const TASK_MERGE_TOKEN_CONTAINMENT = 0.8;
const TASK_MERGE_LOW_SIMILARITY = 0.45;
const TASK_MERGE_MIN_TOKEN_COUNT = 2;
const CONFIDENCE_RANK_HIGH = 3;
const CONFIDENCE_RANK_MEDIUM = 2;
const CONFIDENCE_RANK_LOW = 1;
const JSON_PRETTY_PRINT_INDENT = 2;
const MEETING_HUMAN_PAIR_SIZE = 2;
const MEETING_SOLE_GUEST_COUNT = 1;
const MEETING_TASKS_PREPARE_FAILED_MESSAGE = "Tasks could not be prepared.";
const MEETING_TASK_TRANSCRIPT_NOT_FOUND_MESSAGE = "Transcript for meeting not found";
const TASK_PROGRESS_HEARTBEAT_FAILED_MESSAGE = "Task progress heartbeat failed";
const TASK_GLOBAL_VERIFICATION_BUDGET_EXCEEDED_MESSAGE =
  "Transcript exceeds the global task verification budget; using the chunked pipeline";
const TASK_GLOBAL_VERIFICATION_COMPLETE_MESSAGE = "Generated durable meeting tasks with one global verification pass";
const TASK_VOICE_IDENTITY_UNAVAILABLE_MESSAGE =
  "Optional voice identity evidence unavailable; continuing task generation";
const TASK_PERSONAL_LIST_EXTRACTION_FAILED_MESSAGE =
  "Personal-list task extraction failed; using general task extraction";
const TASK_GENERATION_COMPLETE_MESSAGE = "Generated durable meeting tasks";
const TASK_CHUNK_FAILED_MESSAGE = "Task chunk extraction failed and was skipped";
const TASK_RECONCILIATION_FAILED_MESSAGE = "Task reconciliation failed; using validated preliminary tasks";
const TASK_PERSONAL_LIST_EXTRACTION_ERROR_DETAIL = "Personal-list extraction failed";
const TASK_CHUNK_FAILED_ERROR_DETAIL = "Task chunk failed";
const TASK_RECONCILIATION_FAILED_ERROR_DETAIL = "Task reconciliation failed";

const ACTION_COMMITMENT_TERMS =
  /\b(i'?ll|i will|we'?ll|we will|can you|could you|please|you'?re on|own(?:ing)?|owner|take that on|start on|send|ship|fix|draft|prepare|schedule|assign|add it|follow up|follow-up|ping|sync with|review|deploy|create|build|investigate|look into|circle back|write|update|finish|complete|file|ticket)\b/gi;
const FINNISH_ACTION_COMMITMENT_TERMS =
  /\b(?:mä|minä|me)\s+(?:aion|aiomme|voin|voimme|laitan|laitamme|lähetän|lähetämme|teen|teemme|hoidan|hoidamme|selvitän|selvitämme|järjestän|järjestämme|varmistan|varmistamme|otan|otamme|aloitan|aloitamme|päivitän|päivitämme|kirjoitan|kirjoitamme|toimitan|toimitamme|korjaan|korjaamme|rakennan|rakennamme|valmistelen|valmistelemme)\b/giu;
const ISSUE_WORK_TERMS =
  /\b(bug|defect|regression|crash|error|exception|failure|failing|broken|incorrect|wrong|overflow|layout|spacing|timeout|race condition|sso|auth|api|database|frontend|backend|ci|deploy)\b/gi;
const REQUEST_SPEAKER_TERMS =
  /\b(can you|could you|would you|please|you'?re on|you are on|you own|take that on|start on|assign|send|ship|fix|draft|prepare|schedule|follow up|ping|sync with|review|deploy|create|build|investigate|look into|write|update)\b/i;
const FINNISH_REQUEST_SPEAKER_TERMS =
  /\b(?:voitko|voisitko|teetkö|lähetätkö|hoidatko|varmistatko|selvitätkö|järjestätkö|päivitätkö|kirjoitatko|toimitatko|korjaatko|rakennatko|valmisteletko)\b/iu;
const SOLE_COUNTERPART_ASSIGNMENT_TERMS =
  /\bi\s+(?:(?:would|(?:['’]d))\s+)?(?:really\s+)?(?:like|need|want)\s+you\s+to\s+(?:handle|take|do|finish|complete|send|schedule|book|call|contact|follow\s+up|respond|open|create|get|make|pay|visit|go|bring|prepare|review|fix|write|update)\b/i;
const TASK_TITLE_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "into", "of", "on", "or", "the", "to", "with"]);
const MISSING_TASK_CHUNK = "Task chunk index is missing.";

function only<T>(items: readonly T[]): T | null {
  const item = items[0];

  return items.length === 1 && item !== undefined ? item : null;
}

function isNonEmptyString(value: string | null): value is string {
  return value !== null && value.length > 0;
}

function hasSegmentSpeakerUserId(segment: TranscriptSegment): boolean {
  return segment.speakerUserId !== null && segment.speakerUserId.length > 0;
}

function chunkAt(input: { chunks: readonly TaskChunk[]; index: number }) {
  const chunk = input.chunks[input.index];
  if (chunk === undefined) {
    throw new Error(MISSING_TASK_CHUNK);
  }

  return chunk;
}

type TaskChunk = {
  index: number;
  segments: TranscriptSegment[];
  text: string;
  taskHintScore: number;
};

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

function textIncludesEvidence(input: { source: string; evidence: string }) {
  const sourceText = normalizeForMatch(input.source);
  const evidenceText = normalizeForMatch(input.evidence);
  if (evidenceText.length === 0) {
    return false;
  }

  return sourceText.includes(evidenceText) || evidenceText.includes(sourceText);
}

function sourceQuoteTimestampMatches(input: { timestamp: string; segmentTimestamp: Date }) {
  const quoteTime = Date.parse(input.timestamp);
  if (Number.isFinite(quoteTime)) {
    return quoteTime === input.segmentTimestamp.getTime();
  }

  return normalizeForMatch(input.timestamp) === normalizeForMatch(input.segmentTimestamp.toISOString());
}

function findSourceQuoteSegment(input: {
  quote: MeetingTaskSourceQuote;
  segments: TranscriptSegment[];
}): TranscriptSegment | null {
  const { quote, segments } = input;
  if (quote.segmentId !== null && quote.segmentId !== undefined && quote.segmentId.length > 0) {
    const segment = segments.find((candidate) => candidate.id === quote.segmentId);

    return segment !== undefined && textIncludesEvidence({ source: segment.content, evidence: quote.quote })
      ? segment
      : null;
  }

  const quoteMatches = segments.filter((segment) =>
    textIncludesEvidence({ source: segment.content, evidence: quote.quote }),
  );
  const quoteTimestamp = quote.timestamp;
  const timestampMatches =
    quoteTimestamp !== null && quoteTimestamp.length > 0
      ? quoteMatches.filter((segment) =>
          sourceQuoteTimestampMatches({ timestamp: quoteTimestamp, segmentTimestamp: segment.startedAt }),
        )
      : quoteMatches;
  const quoteSpeaker = quote.speaker;
  const matches =
    quoteSpeaker !== null && quoteSpeaker.length > 0
      ? timestampMatches.filter((segment) => normalizeForMatch(segment.speakerName) === normalizeForMatch(quoteSpeaker))
      : timestampMatches;

  return only(matches);
}

function countMatches(input: { text: string; regex: RegExp }) {
  const matcher = new RegExp(input.regex.source, input.regex.flags);

  return Array.from(input.text.matchAll(matcher)).length;
}

function scoreTaskHints(text: string) {
  return (
    (countMatches({ text, regex: ACTION_COMMITMENT_TERMS }) +
      countMatches({ text, regex: FINNISH_ACTION_COMMITMENT_TERMS })) *
      TASK_HINT_ACTION_WEIGHT +
    countMatches({ text, regex: ISSUE_WORK_TERMS })
  );
}

function selectHumanTaskSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter((segment) => segment.speakerRole === "human");
}

function formatSegment(segment: TranscriptSegment) {
  return `[${segment.startedAt.toISOString()}] (${segment.id}) ${segment.speakerName}: ${segment.content.replace(/\s+/g, " ").trim()}`;
}

function transcriptTextLength(segments: TranscriptSegment[]) {
  return segments.reduce((total, segment) => total + formatSegment(segment).length + 1, 0);
}

function taskChunk(input: { index: number; segments: TranscriptSegment[] }): TaskChunk {
  const { index, segments } = input;
  const text = segments.map(formatSegment).join("\n");

  return { index, segments, text, taskHintScore: scoreTaskHints(text) };
}

function buildTranscriptChunks(segments: TranscriptSegment[]): TaskChunk[] {
  const folded = segments.reduce<{ chunks: TaskChunk[]; current: TranscriptSegment[]; currentLength: number }>(
    (state, segment) => {
      const lineLength = formatSegment(segment).length + 1;
      const shouldFlush = state.current.length !== 0 && state.currentLength + lineLength > TASK_CHUNK_TARGET_CHARS;
      const overlap = shouldFlush ? state.current.slice(-TASK_CHUNK_OVERLAP_SEGMENTS) : state.current;
      const chunks = shouldFlush
        ? [...state.chunks, taskChunk({ index: state.chunks.length, segments: state.current })]
        : state.chunks;
      const baseLength = shouldFlush ? transcriptTextLength(overlap) : state.currentLength;

      return {
        chunks,
        current: [...overlap, segment],
        currentLength: baseLength + lineLength,
      };
    },
    { chunks: [], current: [], currentLength: 0 },
  );

  return folded.current.length === 0
    ? folded.chunks
    : [...folded.chunks, taskChunk({ index: folded.chunks.length, segments: folded.current })];
}

function buildFullTranscriptChunk(segments: TranscriptSegment[]): TaskChunk {
  const text = segments.map(formatSegment).join("\n");

  return {
    index: 0,
    segments,
    text,
    taskHintScore: scoreTaskHints(text),
  };
}

function selectTaskChunks(chunks: TaskChunk[]) {
  if (chunks.length <= PROCESS_ALL_CHUNKS_LIMIT) {
    return chunks;
  }

  const required = new Map<number, TaskChunk>([
    [chunkAt({ chunks, index: 0 }).index, chunkAt({ chunks, index: 0 })],
    [chunkAt({ chunks, index: chunks.length - 1 }).index, chunkAt({ chunks, index: chunks.length - 1 })],
  ]);
  const middle = evenlySpacedChunkIndexes({
    startIndex: 1,
    endIndex: chunks.length - CONTEXT_WINDOW_SEGMENTS_AFTER,
    count: TASK_LONG_MEETING_MIDDLE_SAMPLE_CHUNKS,
  }).map((index) => chunkAt({ chunks, index }));
  const hinted = [...chunks]
    .filter((chunk) => chunk.taskHintScore !== 0)
    .sort((left, right) => {
      const scoreDelta = right.taskHintScore - left.taskHintScore;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return left.index - right.index;
    });
  const selected = [...middle, ...hinted].reduce((map, chunk) => {
    if (map.size >= MAX_SELECTED_LONG_CHUNKS || map.has(chunk.index)) {
      return map;
    }

    return new Map([...map, [chunk.index, chunk]]);
  }, required);

  return [...selected.values()].sort((left, right) => left.index - right.index);
}

function evenlySpacedChunkIndexes(input: { startIndex: number; endIndex: number; count: number }) {
  const { startIndex, endIndex, count } = input;
  if (endIndex < startIndex || count <= 0) {
    return [];
  }

  const availableCount = endIndex - startIndex + 1;
  if (availableCount <= count) {
    return Array.from({ length: availableCount }, (_, offset) => startIndex + offset);
  }

  const indexes = Array.from(
    { length: count },
    (_, step) => startIndex + Math.round((step * (availableCount - 1)) / (count - 1)),
  );

  return [...new Set(indexes)].sort((left, right) => left - right);
}

function sourceQuoteKey(quote: Pick<MeetingTaskSourceQuote, "quote">) {
  return normalizeForMatch(quote.quote);
}

function taskTitleTokens(title: string) {
  return normalizeForMatch(title)
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(
      (word) => (word.length >= TASK_TITLE_MIN_TOKEN_LENGTH || /\d/.test(word)) && !TASK_TITLE_STOP_WORDS.has(word),
    );
}

function tokenSimilarity(input: { left: string[]; right: string[] }) {
  const { left, right } = input;
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersectionSize = [...leftSet].filter((token) => rightSet.has(token)).length;
  const unionSize = new Set([...leftSet, ...rightSet]).size;

  return unionSize > 0 ? intersectionSize / unionSize : 0;
}

function contextWindowForQuote(input: { quote: MeetingTaskSourceQuote; segments: TranscriptSegment[] }) {
  const { quote, segments } = input;
  const matchedSegment = findSourceQuoteSegment({ quote, segments });
  const index = matchedSegment !== null ? segments.findIndex((segment) => segment.id === matchedSegment.id) : -1;
  if (index < 0) {
    return [];
  }

  return segments
    .slice(
      Math.max(0, index - CONTEXT_WINDOW_SEGMENTS_BEFORE),
      Math.min(segments.length, index + CONTEXT_WINDOW_SEGMENTS_AFTER),
    )
    .map((segment) => ({
      segmentId: segment.id,
      speaker: segment.speakerName,
      timestamp: segment.startedAt.toISOString(),
      text: segment.content.replace(/\s+/g, " ").trim().slice(0, QUOTE_CONTEXT_MAX_CHARS),
    }));
}

function buildEvidencePacket(input: {
  meetingId: string;
  title: string | null;
  participants: { userId: string; name: string; email: string; roleHint?: string | null }[];
  segments: TranscriptSegment[];
  candidates: MeetingTaskCandidate[];
  languageContext: string;
}) {
  return {
    meeting: {
      id: input.meetingId,
      title: input.title !== null && input.title.trim().length > 0 ? input.title.trim() : "Untitled meeting",
      participants: input.participants,
    },
    fullTranscriptLanguageContext: input.languageContext,
    candidates: input.candidates.map((candidate, index) => ({
      id: `candidate_${index + 1}`,
      title: candidate.title,
      description: candidate.description,
      type: candidate.type,
      workKind: candidate.workKind,
      owner: candidate.owner,
      dueDate: candidate.dueDate,
      confidence: candidate.confidence,
      completion: candidate.completion,
      sourceReason: candidate.sourceReason,
      sourceQuotes: candidate.sourceQuotes.map((quote, quoteIndex) => ({
        id: `evidence_${index + 1}_${quoteIndex + 1}`,
        quote: quote.quote,
        speaker: quote.speaker,
        timestamp: quote.timestamp,
        segmentId: quote.segmentId ?? null,
        context: contextWindowForQuote({ quote, segments: input.segments }),
      })),
    })),
  };
}

function computeMeetingTranscriptHash(transcriptData: TranscriptData): string {
  const hash = createHash("sha256");
  transcriptData.segments.forEach((segment) => {
    hash.update(segment.id);
    hash.update(segment.speakerName);
    hash.update(segment.startedAt.toISOString());
    hash.update(segment.content);
  });

  return hash.digest("hex");
}

function isMeetingTaskListCurrentNamed(input: {
  taskList: MeetingTaskList | null;
  transcriptData: TranscriptData | null;
}): boolean {
  const { taskList, transcriptData } = input;
  if (!taskList || !transcriptData || taskList.status !== "completed") {
    return false;
  }

  return (
    taskList.promptVersion === MEETING_TASKS_PROMPT_VERSION &&
    taskList.transcriptHash === computeMeetingTranscriptHash(transcriptData)
  );
}

export function isMeetingTaskListCurrent(
  ...args: [taskList: MeetingTaskList | null, transcriptData: TranscriptData | null]
): boolean {
  return isMeetingTaskListCurrentNamed({ taskList: args[0], transcriptData: args[1] });
}

function findSourceQuoteMatch(input: {
  quote: MeetingTaskSourceQuote;
  segments: TranscriptSegment[];
}): MeetingTaskSourceQuote | null {
  const { quote, segments } = input;
  const matchedSegment = findSourceQuoteSegment({ quote, segments });
  if (!matchedSegment) {
    return null;
  }

  return {
    quote: quote.quote.trim(),
    speaker: matchedSegment.speakerName.length > 0 ? matchedSegment.speakerName : null,
    timestamp: matchedSegment.startedAt.toISOString(),
    segmentId: matchedSegment.id,
  };
}

function validateTaskCompletion(input: {
  completion: MeetingTaskCompletion;
  segments: TranscriptSegment[];
}): MeetingTaskCompletion {
  const { completion, segments } = input;
  const completionQuote = completion.quote;
  if (!completion.completedDuringMeeting || completionQuote === null || completionQuote.length === 0) {
    return { ...OPEN_MEETING_TASK_COMPLETION };
  }

  // Unlike display-only source quotes, completion flips task state, so the
  // match is one-directional: the transcript segment must contain the quote,
  // never the reverse, or a short segment could ground a fabricated quote.
  const normalizedQuote = normalizeForMatch(completionQuote);
  const isQuoteSupportedByTranscript =
    normalizedQuote.length > 0 &&
    segments.some((segment) => normalizeForMatch(segment.content).includes(normalizedQuote));
  if (!isQuoteSupportedByTranscript) {
    return { ...OPEN_MEETING_TASK_COMPLETION };
  }

  return {
    completedDuringMeeting: true,
    quote: completionQuote.trim(),
    confidence: completion.confidence ?? "medium",
  };
}

function valueSupportedByQuotes(input: { value: string | null; quotes: MeetingTaskSourceQuote[] }) {
  const { value, quotes } = input;
  if (value === null || value.length === 0) {
    return false;
  }
  const normalizedValue = normalizeForMatch(value);

  return quotes.some((quote) => normalizeForMatch(quote.quote).includes(normalizedValue));
}

function normalizeEmail(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase();

  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

function firstName(value: string) {
  return value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findUniqueParticipantByName(input: {
  ownerName: string;
  participants: MeetingParticipant[];
  supportKind: "exact" | "first_name";
}) {
  const { ownerName, participants, supportKind } = input;
  const normalizedOwnerName = normalizeForMatch(ownerName);
  if (supportKind === "exact") {
    const exactMatches = participants.filter(
      (participant) => normalizeForMatch(participant.displayName) === normalizedOwnerName,
    );
    const exactMatch = only(exactMatches);
    if (exactMatch) {
      return exactMatch;
    }
  }

  const supportedFirstName = firstName(ownerName);
  const firstNameMatches = participants.filter(
    (participant) => firstName(participant.displayName) === supportedFirstName,
  );

  return only(firstNameMatches);
}

function isFirstPersonCommitment(value: string) {
  return (
    /\b(i['’]?ll|i will|i can|i['’]?m going to|let me|i['’]?ll take|i will take|i['’]?ll handle|i will handle|i['’]?ll own|i will own)\b/i.test(
      value,
    ) ||
    /\b(?:mä|minä)\s+(?:aion|voin|pystyn|lupaan|laitan|lähetän|teen|hoidan|selvitän|järjestän|varmistan|otan|aloitan|päivitän|kirjoitan|toimitan|korjaan|rakennan|valmistelen|juttelen|keskustelen|annan|autan|käyn|sovin)\b/iu.test(
      value,
    )
  );
}

function isClearlySeparateDownstreamFirstPersonAction(input: { candidate: MeetingTaskCandidate; value: string }) {
  const { candidate, value } = input;
  const normalizedValue = normalizeForMatch(value);
  const match =
    /\bi(?:\s+can|\s+will|'ll)\s+(?:start|begin|continue|resume|proceed|test|try|use|work|play|pull)\b/i.exec(
      normalizedValue,
    );
  if (match?.index === undefined || match.index === 0) {
    return false;
  }

  const precedingClause = normalizedValue.slice(0, match.index);
  if (isFirstPersonCommitment(precedingClause)) {
    return false;
  }
  if (!/\b(?:and|so|then)\s*$|[,;]\s*$/i.test(precedingClause)) {
    return false;
  }

  const taskTokens = new Set(taskTitleTokens(candidate.title));
  if (taskTokens.size === 0) {
    return false;
  }

  const precedingTokens = new Set(taskTitleTokens(precedingClause));
  const firstPersonClauseTokens = new Set(taskTitleTokens(normalizedValue.slice(match.index)));
  const isPrecedingClauseNamedInTask = [...taskTokens].some((token) => precedingTokens.has(token));
  const isFirstPersonClauseNamedInTask = [...taskTokens].some((token) => firstPersonClauseTokens.has(token));

  // This is deliberately narrow. We suppress deterministic speaker ownership
  // only when the quote first names the task, then describes a distinct action
  // the speaker can perform after that prerequisite is satisfied.
  return isPrecedingClauseNamedInTask && !isFirstPersonClauseNamedInTask;
}

function isPersonalTaskListCommitment(value: string) {
  return (
    /\b(?:one of the (?:things|items) on )?my (?:task |to[- ]do |priority )?list\b/i.test(value) ||
    /\bmy (?:tasks?|to[- ]dos?|priorities)\b/i.test(value)
  );
}

function isLikelySpokenListItem(value: string) {
  return /^(?:um[,\s]+)?(?:add|apply|arrange|book|bring|build|buy|call|cancel|change|check|clean|close|complete|contact|create|donate|draft|email|file|finalize|find|finish|fix|follow\s+up|frame|get|give|go|handle|investigate|mail|make|open|order|organize|pay|plan|prepare|register|renew|replace|respond|review|schedule|secure|send|set\s+up|ship|submit|take|update|visit|write)\b/i.test(
    value.trim(),
  );
}

function isBriefListAcknowledgement(value: string) {
  return /^(?:ok(?:ay)?|yeah|yep|yes|right|sure|got it|sounds good|mm[- ]?hmm|uh[- ]?huh)[.!?,\s]*$/i.test(
    value.trim(),
  );
}

function personalListTail(input: { segments: TranscriptSegment[]; intro: TranscriptSegment; introIndex: number }) {
  const { segments, intro, introIndex } = input;

  return segments
    .slice(introIndex + 1)
    .reduce<{ items: TranscriptSegment[]; /** @external reducer halt flag */ isStopped: boolean }>(
      (state, segment) => {
        if (state.isStopped || state.items.length >= PERSONAL_LIST_MAX_ITEMS) {
          return { ...state, isStopped: true };
        }
        if (segment.startedAt.getTime() - intro.startedAt.getTime() > PERSONAL_LIST_TAIL_MAX_MS) {
          return { ...state, isStopped: true };
        }
        const isSameSpeaker =
          hasSegmentSpeakerUserId(segment) && hasSegmentSpeakerUserId(intro)
            ? segment.speakerUserId === intro.speakerUserId
            : normalizeForMatch(segment.speakerName) === normalizeForMatch(intro.speakerName);
        if (!isSameSpeaker && !isBriefListAcknowledgement(segment.content)) {
          return { ...state, isStopped: true };
        }

        return { items: [...state.items, segment], isStopped: false };
      },
      { items: [], isStopped: false },
    ).items;
}

function buildPersonalListTaskChunk(segments: TranscriptSegment[]): TaskChunk | null {
  const blocks = segments.reduce<{ claimed: Set<string>; blocks: TranscriptSegment[][] }>(
    (state, intro, introIndex) => {
      if (state.claimed.has(intro.id) || !isPersonalTaskListCommitment(intro.content)) {
        return state;
      }
      const block = [intro, ...personalListTail({ segments, intro, introIndex })];

      return {
        claimed: new Set([...state.claimed, ...block.map((segment) => segment.id)]),
        blocks: [...state.blocks, block],
      };
    },
    { claimed: new Set<string>(), blocks: [] },
  ).blocks;

  if (blocks.length === 0) {
    return null;
  }

  const text = blocks.map((block) => block.map(formatSegment).join("\n")).join("\n---\n");

  return {
    index: 0,
    segments: blocks.flat(),
    text,
    taskHintScore: scoreTaskHints(text),
  };
}

function isAcceptanceReply(value: string) {
  const normalized = normalizeForMatch(value);

  return (
    /^(yeah|yep|ok|okay|sure),?\s+on it\b/i.test(normalized) ||
    /\bi['’]?m on it\b/i.test(normalized) ||
    /\b(got it|will do|i can take|i['’]?ll take|i will take|i can handle|i['’]?ll handle|i will handle|i can own|i['’]?ll own|i will own)\b/i.test(
      normalized,
    ) ||
    /^(?:joo|selvä|sopii|kyllä),?\s+(?:mä|minä)?\s*(?:hoidan|teen|laitan|lähetän|varmistan|selvitän|järjestän|otan|korjaan)\b/iu.test(
      normalized,
    )
  );
}

function isAssignmentRequest(value: string) {
  return REQUEST_SPEAKER_TERMS.test(value) || FINNISH_REQUEST_SPEAKER_TERMS.test(value);
}

function findSegmentByTaskQuote(input: { quote: MeetingTaskSourceQuote; segments: TranscriptSegment[] }) {
  return findSourceQuoteSegment(input);
}

function uniqueNames(names: (string | null | undefined)[]) {
  return names.reduce<string[]>((result, name) => {
    if (result.length >= MAX_ACTIVITY_HINT_NAMES) {
      return result;
    }
    const cleaned = name?.replace(/\s+/g, " ").trim();
    if (cleaned === undefined || cleaned.length === 0) {
      return result;
    }
    const key = normalizeForMatch(cleaned);
    if (result.some((existing) => normalizeForMatch(existing) === key)) {
      return result;
    }

    return [...result, cleaned];
  }, []);
}

function participantForSegment(input: { segment: TranscriptSegment; participants: MeetingParticipant[] }) {
  const { segment, participants } = input;
  if (hasSegmentSpeakerUserId(segment)) {
    const byUserId = participants.find((participant) => participant.userId === segment.speakerUserId);
    if (byUserId) {
      return byUserId;
    }
  }

  const normalizedSpeakerName = normalizeForMatch(segment.speakerName);

  return (
    participants.find((participant) => normalizeForMatch(participant.displayName) === normalizedSpeakerName) ?? null
  );
}

function activityNameForSegment(input: { segment: TranscriptSegment; participants: MeetingParticipant[] }) {
  return participantForSegment(input)?.displayName ?? input.segment.speakerName;
}

function buildTranscriptActivityHints(input: { segments: TranscriptSegment[]; participants: MeetingParticipant[] }) {
  const { segments, participants } = input;

  return {
    participantNames: uniqueNames(participants.map((participant) => participant.displayName)),
    requestSpeakerNames: uniqueNames(
      segments
        .filter((segment) => isAssignmentRequest(segment.content))
        .map((segment) => activityNameForSegment({ segment, participants })),
    ),
    commitmentSpeakerNames: uniqueNames(
      segments
        .filter(
          (segment) =>
            isFirstPersonCommitment(segment.content) ||
            isPersonalTaskListCommitment(segment.content) ||
            isAcceptanceReply(segment.content),
        )
        .map((segment) => activityNameForSegment({ segment, participants })),
    ),
  };
}

function ownerNameFromCandidate(input: { candidate: MeetingTaskCandidate; participants: MeetingParticipant[] }) {
  const { candidate, participants } = input;
  const email = normalizeEmail(candidate.owner.email);
  if (email !== null) {
    const emailMatch = participants.find((participant) => normalizeEmail(participant.email) === email);
    if (emailMatch) {
      return emailMatch.displayName;
    }
  }

  const ownerName = candidate.owner.name;
  if (!isNonEmptyString(ownerName)) {
    return null;
  }

  const exactMatch = findUniqueParticipantByName({ ownerName, participants, supportKind: "exact" });
  if (exactMatch) {
    return exactMatch.displayName;
  }

  const firstNameMatch = findUniqueParticipantByName({ ownerName, participants, supportKind: "first_name" });

  return firstNameMatch?.displayName ?? null;
}

function ownerNamesFromCandidates(input: { candidates: MeetingTaskCandidate[]; participants: MeetingParticipant[] }) {
  return uniqueNames(
    input.candidates.map((candidate) => ownerNameFromCandidate({ candidate, participants: input.participants })),
  );
}

function ownerNamesFromValidatedTasks(candidates: MeetingTaskCandidate[]) {
  return uniqueNames(candidates.map((candidate) => candidate.owner.name));
}

function participantMatchesOwnerHint(input: { participant: MeetingParticipant; ownerName: string | null }) {
  const { participant, ownerName } = input;
  if (!isNonEmptyString(ownerName)) {
    return false;
  }

  const normalizedParticipantName = normalizeForMatch(participant.displayName);
  const normalizedOwnerName = normalizeForMatch(ownerName);

  return (
    normalizedParticipantName === normalizedOwnerName || firstName(participant.displayName) === firstName(ownerName)
  );
}

function isAmbiguousSingleFirstName(input: { ownerName: string | null; participants: MeetingParticipant[] }): boolean {
  const { ownerName, participants } = input;
  if (ownerName === null || ownerName.length === 0 || ownerName.trim().split(/\s+/).length !== 1) {
    return false;
  }

  const ownerFirstName = firstName(ownerName);

  return participants.filter((participant) => firstName(participant.displayName) === ownerFirstName).length > 1;
}

function findSoleHumanParticipant(participants: MeetingParticipant[]): MeetingParticipant | null {
  const humanParticipants = participants.filter(
    (participant) => participant.role === "host" || participant.role === "guest",
  );

  return only(humanParticipants);
}

function isGuestIdentityParticipant(participant: MeetingParticipant): boolean {
  return participant.source === "guest" || participant.email.endsWith("@guest.readymeet.local");
}

function withDeterministicCalendarCounterpart(input: {
  participants: MeetingParticipant[];
  counterpart: CalendarCounterpart;
}): MeetingParticipant[] {
  const { participants, counterpart } = input;
  if (counterpart === null) {
    return participants;
  }
  const counterpartEmailRaw = counterpart.email;
  if (counterpartEmailRaw.length === 0) {
    return participants;
  }

  const humanParticipants = participants.filter(
    (participant) => participant.role === "host" || participant.role === "guest",
  );
  const guestParticipants = humanParticipants.filter(isGuestIdentityParticipant);
  if (humanParticipants.length !== MEETING_HUMAN_PAIR_SIZE || guestParticipants.length !== MEETING_SOLE_GUEST_COUNT) {
    return participants;
  }

  const counterpartEmail = normalizeEmail(counterpartEmailRaw);
  if (
    counterpartEmail === null ||
    humanParticipants.some((participant) => normalizeEmail(participant.email) === counterpartEmail)
  ) {
    return participants;
  }

  const guestParticipant = guestParticipants[0];
  if (guestParticipant === undefined) {
    return participants;
  }

  return participants.map((participant) =>
    participant.userId === guestParticipant.userId
      ? {
          ...participant,
          displayName: counterpart.displayName ?? participant.displayName,
          email: counterpart.email,
        }
      : participant,
  );
}

function findDirectAddressedOwner(input: {
  ownerName: string | null;
  sourceQuotes: MeetingTaskSourceQuote[];
  segments: TranscriptSegment[];
  participants: MeetingParticipant[];
}): MeetingParticipant | null {
  const { ownerName, sourceQuotes, segments, participants } = input;

  return sourceQuotes.reduce<MeetingParticipant | null>((found, quote) => {
    if (found) {
      return found;
    }
    const segment = findSegmentByTaskQuote({ quote, segments });
    if (segment === null || !hasSegmentSpeakerUserId(segment)) {
      return null;
    }

    return participants.reduce<MeetingParticipant | null>((addressed, participant) => {
      if (addressed) {
        return addressed;
      }
      if (isNonEmptyString(ownerName) && !participantMatchesOwnerHint({ participant, ownerName })) {
        return null;
      }
      const first = firstName(participant.displayName);
      if (first.length === 0) {
        return null;
      }
      const directAddressPattern = new RegExp(
        `\\b${escapeRegExp(first)}\\s*,\\s+(?:can\\s+you|could\\s+you|would\\s+you|will\\s+you|please|you(?:'re| are)?\\s+(?:on|own|owning|handling|taking)|you\\s+own|voitko|voisitko|teetkö|lähetätkö|hoidatko|varmistatko|selvitätkö|järjestätkö|päivitätkö|toimitatko|korjaatko)\\b`,
        "i",
      );
      if (!directAddressPattern.test(quote.quote)) {
        return null;
      }
      const candidates = participants.filter(
        (item) => firstName(item.displayName) === first && item.userId !== segment.speakerUserId,
      );

      return only(candidates);
    }, null);
  }, null);
}

function findSoleCounterpartAssignmentOwner(input: {
  sourceQuotes: MeetingTaskSourceQuote[];
  segments: TranscriptSegment[];
  participants: MeetingParticipant[];
}): MeetingParticipant | null {
  const { sourceQuotes, segments, participants } = input;
  const humanParticipants = participants.filter(
    (participant) => participant.role === "host" || participant.role === "guest",
  );
  if (humanParticipants.length !== MEETING_HUMAN_PAIR_SIZE) {
    return null;
  }

  return sourceQuotes.reduce<MeetingParticipant | null>((found, quote) => {
    if (found) {
      return found;
    }
    const segment = findSegmentByTaskQuote({ quote, segments });
    if (
      segment === null ||
      !hasSegmentSpeakerUserId(segment) ||
      !SOLE_COUNTERPART_ASSIGNMENT_TERMS.test(segment.content)
    ) {
      return null;
    }
    const counterpart = humanParticipants.find((participant) => participant.userId !== segment.speakerUserId);
    if (counterpart && humanParticipants.some((participant) => participant.userId === segment.speakerUserId)) {
      return counterpart;
    }

    return null;
  }, null);
}

function findAcceptanceReplyOwner(input: {
  ownerName: string | null;
  sourceQuotes: MeetingTaskSourceQuote[];
  segments: TranscriptSegment[];
  participants: MeetingParticipant[];
}): MeetingParticipant | null {
  const { ownerName, sourceQuotes, segments, participants } = input;
  if (!isNonEmptyString(ownerName)) {
    return null;
  }

  const directOwner = sourceQuotes.reduce<MeetingParticipant | null>((found, quote) => {
    if (found || !isAcceptanceReply(quote.quote)) {
      return found;
    }
    const segment = findSegmentByTaskQuote({ quote, segments });
    if (segment === null || !hasSegmentSpeakerUserId(segment)) {
      return null;
    }
    const speaker = participants.find((participant) => participant.userId === segment.speakerUserId);
    if (speaker !== undefined && participantMatchesOwnerHint({ participant: speaker, ownerName })) {
      return speaker;
    }

    return null;
  }, null);
  if (directOwner) {
    return directOwner;
  }

  return sourceQuotes.reduce<MeetingParticipant | null>((found, quote) => {
    if (found || !isAssignmentRequest(quote.quote)) {
      return found;
    }
    const requestSegment = findSegmentByTaskQuote({ quote, segments });
    if (requestSegment === null || !hasSegmentSpeakerUserId(requestSegment)) {
      return null;
    }
    const requestIndex = segments.findIndex((segment) => segment.id === requestSegment.id);
    if (requestIndex < 0) {
      return null;
    }
    const nearbyOwner = segments.slice(requestIndex + 1, requestIndex + ACCEPTANCE_NEARBY_SEGMENT_COUNT).reduce<{
      /** @external reducer halt flag */ isStopped: boolean;
      owner: MeetingParticipant | null;
    }>(
      (state, segment) => {
        if (state.isStopped || state.owner !== null) {
          return { ...state, isStopped: true };
        }
        if (!hasSegmentSpeakerUserId(segment) || segment.speakerUserId === requestSegment.speakerUserId) {
          return state;
        }
        if (segment.startedAt.getTime() - requestSegment.startedAt.getTime() > ACCEPTANCE_NEARBY_MAX_MS) {
          return { ...state, isStopped: true };
        }
        if (!isAcceptanceReply(segment.content)) {
          return state;
        }
        const speaker = participants.find((participant) => participant.userId === segment.speakerUserId);
        if (speaker !== undefined && participantMatchesOwnerHint({ participant: speaker, ownerName })) {
          return { isStopped: true, owner: speaker };
        }

        return state;
      },
      { isStopped: false, owner: null },
    );

    return nearbyOwner.owner;
  }, null);
}

function participantFromOwnerHint(input: {
  ownerName: string | null;
  ownerEmail: string | null;
  participants: MeetingParticipant[];
}): MeetingParticipant | null {
  const { ownerName, ownerEmail, participants } = input;
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const emailMatch =
    normalizedOwnerEmail !== null
      ? (participants.find((participant) => normalizeEmail(participant.email) === normalizedOwnerEmail) ?? null)
      : null;
  if (ownerName === null || ownerName.length === 0) {
    return emailMatch;
  }

  const supportKind = ownerName.trim().split(/\s+/).length > 1 ? "exact" : "first_name";
  const nameMatch = isAmbiguousSingleFirstName({ ownerName, participants })
    ? null
    : findUniqueParticipantByName({ ownerName, participants, supportKind });
  if (emailMatch && nameMatch && emailMatch.userId !== nameMatch.userId) {
    return null;
  }

  return emailMatch ?? nameMatch;
}

function enrichStructuredPersonalListEvidence(input: {
  candidate: MeetingTaskCandidate;
  sourceQuotes: MeetingTaskSourceQuote[];
  segments: TranscriptSegment[];
  participants: MeetingParticipant[];
}): MeetingTaskSourceQuote[] {
  const { candidate, sourceQuotes, segments, participants } = input;
  if (sourceQuotes.some((quote) => isPersonalTaskListCommitment(quote.quote))) {
    return sourceQuotes;
  }

  const ownerHint = participantFromOwnerHint({
    ownerName: candidate.owner.name,
    ownerEmail: candidate.owner.email,
    participants,
  });
  if (!ownerHint) {
    return sourceQuotes;
  }

  const enriched: { quotes: MeetingTaskSourceQuote[] | null } = { quotes: null };
  sourceQuotes.forEach((quote) => {
    if (enriched.quotes) {
      return;
    }
    const itemSegment = findSegmentByTaskQuote({ quote, segments });
    if (
      !itemSegment ||
      itemSegment.speakerUserId !== ownerHint.userId ||
      !isLikelySpokenListItem(itemSegment.content)
    ) {
      return;
    }
    const itemIndex = segments.findIndex((segment) => segment.id === itemSegment.id);
    if (itemIndex < 0) {
      return;
    }

    const intro = Array.from({ length: itemIndex }, (_, offset) => itemIndex - 1 - offset).reduce<{
      seen: number;
      /** @external reducer halt flag */ isStopped: boolean;
      segment: TranscriptSegment | null;
    }>(
      (state, index) => {
        if (state.isStopped || state.segment !== null) {
          return state;
        }
        const segment = segments[index];
        if (segment === undefined || segment.speakerRole !== "human") {
          return state;
        }
        const seen = state.seen + 1;
        if (
          seen > PERSONAL_LIST_INTRO_MAX_HUMAN_SEGMENTS ||
          itemSegment.startedAt.getTime() - segment.startedAt.getTime() > PERSONAL_LIST_INTRO_MAX_MS
        ) {
          return { ...state, seen, isStopped: true };
        }
        if (segment.speakerUserId !== ownerHint.userId) {
          if (!isBriefListAcknowledgement(segment.content)) {
            return { ...state, seen, isStopped: true };
          }

          return { ...state, seen };
        }
        if (!isPersonalTaskListCommitment(segment.content)) {
          return { ...state, seen };
        }

        return { seen, isStopped: true, segment };
      },
      { seen: 0, isStopped: false, segment: null },
    ).segment;
    if (intro !== null) {
      enriched.quotes = uniqueSourceQuotes([
        {
          quote: intro.content.trim(),
          speaker: intro.speakerName.length > 0 ? intro.speakerName : ownerHint.displayName,
          timestamp: intro.startedAt.toISOString(),
          segmentId: intro.id,
        },
        ...sourceQuotes,
      ]);
    }
  });

  return enriched.quotes ?? sourceQuotes;
}

function findFirstPersonCommitmentOwner(input: {
  candidate: MeetingTaskCandidate;
  sourceQuotes: MeetingTaskSourceQuote[];
  segments: TranscriptSegment[];
  participants: MeetingParticipant[];
}) {
  const { candidate, sourceQuotes, segments, participants } = input;
  const matchingSpeakers = sourceQuotes.reduce((speakers, quote) => {
    if (!isFirstPersonCommitment(quote.quote) && !isPersonalTaskListCommitment(quote.quote)) {
      return speakers;
    }
    if (
      isFirstPersonCommitment(quote.quote) &&
      !isPersonalTaskListCommitment(quote.quote) &&
      isClearlySeparateDownstreamFirstPersonAction({ candidate, value: quote.quote })
    ) {
      return speakers;
    }
    const segment = findSegmentByTaskQuote({ quote, segments });
    if (segment === null || !hasSegmentSpeakerUserId(segment)) {
      return speakers;
    }
    const speaker = participants.find((participant) => participant.userId === segment.speakerUserId) ?? null;
    if (!speaker) {
      return speakers;
    }

    return new Map([...speakers, [speaker.userId, speaker]]);
  }, new Map<string, MeetingParticipant>());

  return only([...matchingSpeakers.values()]);
}

function findNamedCommitmentOwner(input: {
  sourceQuotes: MeetingTaskSourceQuote[];
  participants: MeetingParticipant[];
}) {
  const { sourceQuotes, participants } = input;
  const possibleOwners = participants.filter(
    (participant) => participant.role === "host" || participant.role === "guest",
  );
  const commitmentVerbs = [
    "will",
    "owns?",
    "takes?",
    "handles?",
    "sends?",
    "ships?",
    "fixes?",
    "drafts?",
    "prepares?",
    "schedules?",
    "reviews?",
    "investigates?",
    "writes?",
    "updates?",
    "finishes?",
    "completes?",
    "hoitaa",
    "tekee",
    "lähettää",
    "korjaa",
    "valmistelee",
    "järjestää",
    "selvittää",
    "toimittaa",
    "juttelee",
    "keskustelee",
    "antaa",
    "auttaa",
    "sopii",
  ].join("|");

  const matchingOwners = sourceQuotes.reduce(
    (owners, quote) =>
      possibleOwners.reduce((next, participant) => {
        const names = uniqueNames([participant.displayName, firstName(participant.displayName)]);
        const hasNamedCommitment = names.some((name) => {
          const namePattern = escapeRegExp(name);

          return new RegExp(
            `\\b${namePattern}\\b\\s*(?::|,)?\\s+(?:is\\s+going\\s+to|${commitmentVerbs})\\b`,
            "iu",
          ).test(quote.quote);
        });
        if (!hasNamedCommitment) {
          return next;
        }

        return new Map([...next, [participant.userId, participant]]);
      }, owners),
    new Map<string, MeetingParticipant>(),
  );

  return only([...matchingOwners.values()]);
}

function resolvedTaskOwnerFromParticipant(input: {
  participant: MeetingParticipant;
  confidence: MeetingTaskCandidate["owner"]["confidence"];
}): MeetingTaskCandidate["owner"] {
  return {
    userId: input.participant.userId,
    name: input.participant.displayName,
    email: input.participant.email,
    confidence: input.confidence ?? "high",
  };
}

function resolveTaskOwner(input: {
  candidate: MeetingTaskCandidate;
  sourceQuotes: MeetingTaskSourceQuote[];
  segments: TranscriptSegment[];
  participants: MeetingParticipant[];
}): MeetingTaskCandidate["owner"] {
  const { candidate, sourceQuotes, segments, participants } = input;
  const ownerName = candidate.owner.name;
  const ownerHint = participantFromOwnerHint({
    ownerName,
    ownerEmail: candidate.owner.email,
    participants,
  });
  const ownerHintName = ownerHint?.displayName ?? ownerName;
  const modelConfidence = candidate.owner.confidence ?? "high";

  const directAddressedOwner = findDirectAddressedOwner({
    ownerName: null,
    sourceQuotes,
    segments,
    participants,
  });
  if (directAddressedOwner !== null) {
    return resolvedTaskOwnerFromParticipant({ participant: directAddressedOwner, confidence: modelConfidence });
  }

  const soleCounterpartAssignmentOwner = findSoleCounterpartAssignmentOwner({
    sourceQuotes,
    segments,
    participants,
  });
  if (soleCounterpartAssignmentOwner !== null) {
    return resolvedTaskOwnerFromParticipant({
      participant: soleCounterpartAssignmentOwner,
      confidence: modelConfidence,
    });
  }

  const acceptanceReplyOwner = findAcceptanceReplyOwner({
    ownerName: ownerHintName,
    sourceQuotes,
    segments,
    participants,
  });
  if (acceptanceReplyOwner !== null) {
    return resolvedTaskOwnerFromParticipant({ participant: acceptanceReplyOwner, confidence: modelConfidence });
  }

  const firstPersonOwner = findFirstPersonCommitmentOwner({
    candidate,
    sourceQuotes,
    segments,
    participants,
  });
  if (firstPersonOwner !== null) {
    return resolvedTaskOwnerFromParticipant({ participant: firstPersonOwner, confidence: "high" });
  }

  const namedCommitmentOwner = findNamedCommitmentOwner({
    sourceQuotes,
    participants,
  });
  if (namedCommitmentOwner !== null) {
    return resolvedTaskOwnerFromParticipant({ participant: namedCommitmentOwner, confidence: modelConfidence });
  }

  const ownerFromHint = resolveTaskOwnerFromLowConfidenceHint({ candidate, ownerHint });
  if (ownerFromHint !== null) {
    return ownerFromHint;
  }

  const soleHumanParticipant = findSoleHumanParticipant(participants);
  if (soleHumanParticipant !== null) {
    return resolvedTaskOwnerFromParticipant({ participant: soleHumanParticipant, confidence: "medium" });
  }

  return {
    userId: null,
    name: null,
    email: null,
    confidence: null,
  };
}

function resolveTaskOwnerFromLowConfidenceHint(input: {
  candidate: MeetingTaskCandidate;
  ownerHint: MeetingParticipant | null;
}): MeetingTaskCandidate["owner"] | null {
  const { candidate, ownerHint } = input;
  if (
    ownerHint !== null &&
    (candidate.owner.confidence === "medium" ||
      candidate.owner.confidence === "low" ||
      candidate.owner.confidence === null)
  ) {
    return resolvedTaskOwnerFromParticipant({
      participant: ownerHint,
      confidence: candidate.owner.confidence ?? "low",
    });
  }

  return null;
}

function validateTaskCandidate(input: {
  candidate: MeetingTaskCandidate;
  segments: TranscriptSegment[];
  participants: MeetingParticipant[];
}): MeetingTaskCandidate | null {
  const { candidate, segments, participants } = input;
  const sourceQuotes = candidate.sourceQuotes
    .map((quote) => findSourceQuoteMatch({ quote, segments }))
    .filter((quote): quote is MeetingTaskSourceQuote => quote !== null);

  if (sourceQuotes.length === 0) {
    return null;
  }

  const groundedSourceQuotes = enrichStructuredPersonalListEvidence({
    candidate,
    sourceQuotes,
    segments,
    participants,
  });
  const dueDateValue = valueSupportedByQuotes({ value: candidate.dueDate.value, quotes: groundedSourceQuotes })
    ? candidate.dueDate.value
    : null;
  const owner = resolveTaskOwner({
    candidate,
    sourceQuotes: groundedSourceQuotes,
    segments,
    participants,
  });

  return {
    ...candidate,
    title: candidate.title.replace(/\s+/g, " ").trim(),
    description: (() => {
      const trimmed = candidate.description?.replace(/\s+/g, " ").trim();

      return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
    })(),
    owner,
    dueDate: {
      value: dueDateValue,
      confidence: dueDateValue !== null && dueDateValue.length > 0 ? (candidate.dueDate.confidence ?? "medium") : null,
    },
    completion: validateTaskCompletion({ completion: candidate.completion, segments }),
    sourceQuotes: groundedSourceQuotes,
    sourceReason: candidate.sourceReason.replace(/\s+/g, " ").trim(),
  };
}

function confidenceRank(value: MeetingTaskCandidate["confidence"] | MeetingTaskCandidate["owner"]["confidence"]) {
  if (value === "high") {
    return CONFIDENCE_RANK_HIGH;
  }
  if (value === "medium") {
    return CONFIDENCE_RANK_MEDIUM;
  }
  if (value === "low") {
    return CONFIDENCE_RANK_LOW;
  }

  return 0;
}

function strongestConfidence<T extends "low" | "medium" | "high" | null>(input: { left: T; right: T }) {
  return confidenceRank(input.right) > confidenceRank(input.left) ? input.right : input.left;
}

function strongerConfidenceValue<T extends { confidence: "low" | "medium" | "high" | null }>(input: {
  left: T;
  right: T;
}) {
  return confidenceRank(input.right.confidence) > confidenceRank(input.left.confidence) ? input.right : input.left;
}

function hasSameTaskTitle(input: { left: MeetingTaskCandidate; right: MeetingTaskCandidate }) {
  return normalizeForMatch(input.left.title) === normalizeForMatch(input.right.title);
}

function hasConflictingTaskOwners(input: { left: MeetingTaskCandidate; right: MeetingTaskCandidate }) {
  const leftOwner =
    input.left.owner.name !== null && input.left.owner.name.length > 0
      ? normalizeForMatch(input.left.owner.name)
      : null;
  const rightOwner =
    input.right.owner.name !== null && input.right.owner.name.length > 0
      ? normalizeForMatch(input.right.owner.name)
      : null;

  return (
    leftOwner !== null &&
    rightOwner !== null &&
    leftOwner.length > 0 &&
    rightOwner.length > 0 &&
    leftOwner !== rightOwner
  );
}

function tokenContainment(input: { left: string[]; right: string[] }) {
  const { left, right } = input;
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersectionSize = [...leftSet].filter((token) => rightSet.has(token)).length;
  const smallerSize = Math.min(leftSet.size, rightSet.size);

  return smallerSize > 0 ? intersectionSize / smallerSize : 0;
}

function shouldMergeTaskCandidates(input: { left: MeetingTaskCandidate; right: MeetingTaskCandidate }) {
  const { left, right } = input;
  // Two named owners that differ means two real assignments, never a duplicate.
  // A named owner next to an unassigned copy of the same work is a duplicate.
  if (hasConflictingTaskOwners({ left, right })) {
    return false;
  }

  if (hasSameTaskTitle({ left, right })) {
    return true;
  }

  const leftTokens = taskTitleTokens(left.title);
  const rightTokens = taskTitleTokens(right.title);
  const similarity = tokenSimilarity({ left: leftTokens, right: rightTokens });
  if (similarity >= TASK_MERGE_HIGH_SIMILARITY) {
    return true;
  }

  if (left.workKind !== right.workKind) {
    return false;
  }

  if (similarity >= TASK_MERGE_MEDIUM_SIMILARITY) {
    return true;
  }

  // One title is a qualified rewording of the other, e.g. "Prototype filter
  // panel" against "Prototype new filter panel layout".
  return (
    Math.min(leftTokens.length, rightTokens.length) >= TASK_MERGE_MIN_TOKEN_COUNT &&
    tokenContainment({ left: leftTokens, right: rightTokens }) >= TASK_MERGE_TOKEN_CONTAINMENT &&
    similarity >= TASK_MERGE_LOW_SIMILARITY
  );
}

function uniqueSourceQuotes(items: MeetingTaskSourceQuote[]) {
  return items.reduce<MeetingTaskSourceQuote[]>((unique, item) => {
    const key = sourceQuoteKey(item);
    if (unique.some((existing) => sourceQuoteKey(existing) === key)) {
      return unique;
    }

    return [...unique, item];
  }, []);
}

function mergeTaskCandidate(input: { left: MeetingTaskCandidate; right: MeetingTaskCandidate }): MeetingTaskCandidate {
  const { left, right } = input;
  const owner = strongerConfidenceValue({ left: left.owner, right: right.owner });
  const dueDate = strongerConfidenceValue({ left: left.dueDate, right: right.dueDate });
  const completion =
    right.completion.completedDuringMeeting && !left.completion.completedDuringMeeting
      ? right.completion
      : left.completion;

  return {
    ...left,
    description: left.description ?? right.description,
    owner,
    dueDate,
    confidence: strongestConfidence({ left: left.confidence, right: right.confidence }),
    completion,
    sourceQuotes: uniqueSourceQuotes([...left.sourceQuotes, ...right.sourceQuotes]),
    sourceReason: left.sourceReason.length > 0 ? left.sourceReason : right.sourceReason,
  };
}

function dedupeTasks(items: MeetingTaskCandidate[]): MeetingTaskCandidate[] {
  return items.reduce<MeetingTaskCandidate[]>((deduped, item) => {
    const existingIndex = deduped.findIndex((existing) => shouldMergeTaskCandidates({ left: existing, right: item }));
    if (existingIndex < 0) {
      return [...deduped, item];
    }

    return deduped.map((existing, index) =>
      index === existingIndex ? mergeTaskCandidate({ left: existing, right: item }) : existing,
    );
  }, []);
}

function limitGeneralTasks(input: {
  items: MeetingTaskCandidate[];
  participants: MeetingParticipant[];
}): MeetingTaskCandidate[] {
  const { items, participants } = input;
  const humanParticipantCount = participants.filter(
    (participant) => participant.role === "host" || participant.role === "guest",
  ).length;

  return items.slice(0, meetingTaskLimitForParticipantCount(humanParticipantCount));
}

function hasAssignedTaskOwner(item: MeetingTaskCandidate) {
  return (
    (item.owner.userId !== null && item.owner.userId.length > 0) ||
    (item.owner.name !== null && item.owner.name.length > 0) ||
    (item.owner.email !== null && item.owner.email.length > 0)
  );
}

function mergePersonalListTaskOverGeneralTask(input: {
  generalItem: MeetingTaskCandidate;
  personalListItem: MeetingTaskCandidate;
}) {
  const { generalItem, personalListItem } = input;
  const dueDate = strongerConfidenceValue({ left: generalItem.dueDate, right: personalListItem.dueDate });
  const completion = personalListItem.completion.completedDuringMeeting
    ? personalListItem.completion
    : generalItem.completion;

  return {
    ...personalListItem,
    description: personalListItem.description ?? generalItem.description,
    dueDate,
    confidence: strongestConfidence({ left: generalItem.confidence, right: personalListItem.confidence }),
    completion,
    sourceQuotes: uniqueSourceQuotes([...generalItem.sourceQuotes, ...personalListItem.sourceQuotes]),
    sourceReason: personalListItem.sourceReason.length > 0 ? personalListItem.sourceReason : generalItem.sourceReason,
  };
}

function mergeGeneralAndPersonalListTasks(input: {
  generalItems: MeetingTaskCandidate[];
  personalListItems: MeetingTaskCandidate[];
  participants: MeetingParticipant[];
}): {
  items: MeetingTaskCandidate[];
  generalDroppedCount: number;
  personalEvidenceDroppedCount: number;
  dedupedCandidateCount: number;
} {
  const limitedGeneralItems = limitGeneralTasks({ items: input.generalItems, participants: input.participants });
  const groundedPersonalListItems = input.personalListItems.filter((item) =>
    item.sourceQuotes.some((quote) => isPersonalTaskListCommitment(quote.quote)),
  );
  const items = groundedPersonalListItems.reduce((current, personalListItem) => {
    const unassignedGeneralIndex = current.findIndex(
      (generalItem) =>
        hasSameTaskTitle({ left: generalItem, right: personalListItem }) &&
        !hasAssignedTaskOwner(generalItem) &&
        hasAssignedTaskOwner(personalListItem),
    );
    if (unassignedGeneralIndex >= 0) {
      return current.map((generalItem, index) =>
        index === unassignedGeneralIndex
          ? mergePersonalListTaskOverGeneralTask({ generalItem, personalListItem })
          : generalItem,
      );
    }

    return dedupeTasks([...current, personalListItem]);
  }, dedupeTasks(limitedGeneralItems));

  return {
    items,
    generalDroppedCount: input.generalItems.length - limitedGeneralItems.length,
    personalEvidenceDroppedCount: input.personalListItems.length - groundedPersonalListItems.length,
    dedupedCandidateCount: limitedGeneralItems.length + groundedPersonalListItems.length - items.length,
  };
}

function validateTaskCandidatesWithDiagnostics(input: {
  items: MeetingTaskCandidate[];
  segments: TranscriptSegment[];
  participants: MeetingParticipant[];
}) {
  const { items, segments, participants } = input;
  const validatedItems = items.map((item) => validateTaskCandidate({ candidate: item, segments, participants }));
  const valid = validatedItems.filter((item): item is MeetingTaskCandidate => item !== null);
  const evidenceDroppedCandidateCount = validatedItems.length - valid.length;

  const deduped = dedupeTasks(valid);

  return {
    items: deduped,
    evidenceDroppedCandidateCount,
    dedupedCandidateCount: valid.length - deduped.length,
  };
}

function filterTasksToKnownEvidence(input: { items: MeetingTaskCandidate[]; knownQuotes: MeetingTaskSourceQuote[] }) {
  const { items, knownQuotes } = input;
  const known = new Set(knownQuotes.map(sourceQuoteKey));

  return items
    .map((item) => ({
      ...item,
      sourceQuotes: item.sourceQuotes.filter((quote) => known.has(sourceQuoteKey(quote))),
    }))
    .filter((item) => item.sourceQuotes.length !== 0);
}

async function markMeetingTasksFailed(input: {
  jobId: string;
  meetingId: string;
  phase?: string;
  error: string;
}): Promise<Awaited<ReturnType<RepositoryPort["upsertMeetingTaskList"]>>> {
  return repositories().upsertMeetingTaskList({
    jobId: input.jobId,
    meetingId: input.meetingId,
    status: "failed",
    phase: input.phase ?? "failed",
    error: {
      message: MEETING_TASKS_PREPARE_FAILED_MESSAGE,
      detail: input.error,
    },
    completedAt: new Date(),
  });
}

type MeetingTaskGenerationBootstrap = {
  meeting: Awaited<ReturnType<RepositoryPort["getMeetingById"]>>;
  transcriptData: TranscriptData;
  participants: MeetingParticipant[];
  meetingTitle: string | null;
  participantViews: { userId: string; name: string; email: string; roleHint?: string | null }[];
  transcriptHash: string;
  initialCandidates: MeetingTaskCandidate[] | undefined;
  dismissedTombstones: {
    id: string;
    title: string;
    description: string | null;
    sourceQuotes: MeetingTaskSourceQuote[];
  }[];
  segments: TranscriptSegment[];
  transcriptChars: number;
  languageContext: string;
  chunks: TaskChunk[];
  selectedChunks: TaskChunk[];
  isShortTranscript: boolean;
  transcriptActivityHints: ReturnType<typeof buildTranscriptActivityHints>;
};

function buildMeetingTaskLiveArtifactSeed(input: {
  existingTaskList: Awaited<ReturnType<RepositoryPort["getMeetingTaskListForMeeting"]>>;
  unresolvedLiveCandidates: Awaited<ReturnType<RepositoryPort["listMeetingLiveTaskCandidates"]>>;
  providedInitialCandidates: MeetingTaskCandidate[] | undefined;
}): Pick<MeetingTaskGenerationBootstrap, "initialCandidates" | "dismissedTombstones"> {
  const liveTaskCandidates: MeetingTaskCandidate[] = (input.existingTaskList?.items ?? [])
    .filter((task) => task.origin === "live" && task.status !== "dismissed")
    .map((task) => ({
      title: task.title,
      description: task.description,
      type: task.type,
      workKind: task.workKind,
      owner: task.owner,
      dueDate: task.dueDate,
      confidence: task.confidence,
      completion:
        task.status === "completed"
          ? {
              completedDuringMeeting: true,
              quote: task.sourceQuotes.at(-1)?.quote ?? task.sourceQuotes[0]?.quote ?? null,
              confidence: "high",
            }
          : OPEN_MEETING_TASK_COMPLETION,
      sourceQuotes: task.sourceQuotes,
      sourceReason: task.sourceReason,
    }));
  const dismissedTombstones = (input.existingTaskList?.items ?? [])
    .filter((task) => task.origin === "live" && task.status === "dismissed" && task.statusSource === "user")
    .map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      sourceQuotes: task.sourceQuotes,
    }));
  const deferredCandidates = input.unresolvedLiveCandidates
    .filter((candidate) => candidate.state === "deferred" || candidate.linkedTaskId === null)
    .map((candidate) => ({
      ...candidate.proposal,
      sourceQuotes:
        candidate.evidence.length !== 0
          ? candidate.evidence.slice(0, LIVE_CANDIDATE_EVIDENCE_LIMIT).map((evidence) => ({
              quote: evidence.quote,
              speaker: evidence.speakerName,
              timestamp: evidence.startedAt,
              segmentId: evidence.transcriptSegmentId,
              sourceSegmentId: evidence.sourceSegmentId,
              speakerIdentity: evidence.speakerIdentity,
              startedAt: evidence.startedAt,
              endedAt: evidence.endedAt,
            }))
          : candidate.proposal.sourceQuotes,
    }));
  const initialCandidates =
    input.providedInitialCandidates === undefined &&
    liveTaskCandidates.length === 0 &&
    deferredCandidates.length === 0 &&
    dismissedTombstones.length === 0
      ? undefined
      : [...(input.providedInitialCandidates ?? []), ...liveTaskCandidates, ...deferredCandidates];

  return { initialCandidates, dismissedTombstones };
}

async function bootstrapMeetingTaskGenerationContext(
  input: MeetingTaskPipelineInput,
): Promise<MeetingTaskGenerationBootstrap> {
  const { meetingId, options } = input;
  await repositories().reanchorMeetingLiveTaskEvidence(meetingId);
  const [meeting, transcriptData, rawParticipants, calendarCounterpart, existingTaskList, unresolvedLiveCandidates] =
    await Promise.all([
      repositories().getMeetingById(meetingId),
      repositories().getTranscriptForMeeting(meetingId),
      repositories().listParticipantsForMeeting(meetingId),
      repositories().getDeterministicCalendarCounterpartForMeeting(meetingId),
      repositories().getMeetingTaskListForMeeting(meetingId),
      repositories().listMeetingLiveTaskCandidates({ meetingId, states: ["deferred", "confirmed"] }),
    ]);
  if (!transcriptData) {
    throw new Error(MEETING_TASK_TRANSCRIPT_NOT_FOUND_MESSAGE);
  }

  const participants = withDeterministicCalendarCounterpart({
    participants: rawParticipants,
    counterpart: calendarCounterpart,
  });
  const meetingTitle = meeting?.title ?? null;
  const participantViews = participants.map((participant) => ({
    userId: participant.userId,
    name: participant.displayName,
    email: participant.email,
    roleHint: participant.role,
  }));
  const transcriptHash = computeMeetingTranscriptHash(transcriptData);
  const { initialCandidates, dismissedTombstones } = buildMeetingTaskLiveArtifactSeed({
    existingTaskList,
    unresolvedLiveCandidates,
    providedInitialCandidates: options.initialCandidates,
  });

  const segments = [...selectHumanTaskSegments(transcriptData.segments)].sort((left, right) => {
    const startedAtDelta = left.startedAt.getTime() - right.startedAt.getTime();
    if (startedAtDelta !== 0) {
      return startedAtDelta;
    }

    return left.id.localeCompare(right.id);
  });

  const transcriptChars = transcriptTextLength(segments);
  const languageContext = buildMeetingTaskLanguageContext(segments.map((segment) => segment.content));
  const chunks = buildTranscriptChunks(segments);
  const selectedChunks = selectTaskChunks(chunks);
  const isShortTranscript = transcriptChars <= SHORT_TASK_TRANSCRIPT_CHARS;
  const transcriptActivityHints = buildTranscriptActivityHints({ segments, participants });

  return {
    meeting,
    transcriptData,
    participants,
    meetingTitle,
    participantViews,
    transcriptHash,
    initialCandidates,
    dismissedTombstones,
    segments,
    transcriptChars,
    languageContext,
    chunks,
    selectedChunks,
    isShortTranscript,
    transcriptActivityHints,
  };
}

type MeetingTaskProgressToolkit = {
  progressState: {
    candidateOwnerNames: string[];
    validatedOwnerNames: string[];
    activePhase: TaskGenerationPhase | null;
    activePhaseStartedAt: number;
  };
  diagnostics: MeetingTaskDiagnostics;
  buildProgress: (overrides?: Partial<MeetingTaskProgress>) => MeetingTaskProgress;
  updatePhase: (input: { phase: TaskGenerationPhase; progress?: MeetingTaskProgress | null }) => Promise<void>;
  applyGenerationDiagnostics: (input: {
    generation: {
      taskModel: string;
      taskPromptVersion: string;
      items: MeetingTaskCandidate[];
      diagnostics?: { modelCallDurationMs?: number; schemaDroppedCandidateCount?: number; rawCandidateCount?: number };
    };
    fallbackDurationMs: number;
  }) => void;
  startProgressHeartbeat: (input: {
    phase: TaskGenerationPhase;
    modelCallStartedAt: string;
    buildHeartbeatProgress: (idleSeconds: number) => MeetingTaskProgress;
  }) => () => void;
};

type MeetingTaskProgressToolkitState = {
  progressState: MeetingTaskProgressToolkit["progressState"];
  diagnostics: MeetingTaskDiagnostics;
  isShortTranscript: boolean;
  selectedChunks: TaskChunk[];
  transcriptActivityHints: ReturnType<typeof buildTranscriptActivityHints>;
  participants: MeetingParticipant[];
};

function recordMeetingTaskPhaseDuration(input: {
  state: MeetingTaskProgressToolkitState;
  nextPhase: TaskGenerationPhase;
}) {
  const { state, nextPhase } = input;
  const { progressState, diagnostics } = state;
  const now = Date.now();
  const activePhase = progressState.activePhase;
  if (activePhase !== null && activePhase !== nextPhase) {
    diagnostics.phaseDurationsMs[activePhase] =
      (diagnostics.phaseDurationsMs[activePhase] ?? 0) + Math.max(0, now - progressState.activePhaseStartedAt);
    progressState.activePhaseStartedAt = now;
  }
  if (activePhase === null || activePhase !== nextPhase) {
    progressState.activePhase = nextPhase;
    progressState.activePhaseStartedAt = now;
  }
}

function buildMeetingTaskProgressFromState(input: {
  state: MeetingTaskProgressToolkitState;
  overrides?: Partial<MeetingTaskProgress>;
}): MeetingTaskProgress {
  const { state, overrides = {} } = input;
  const activityHints: MeetingTaskActivityHints = {
    ...state.transcriptActivityHints,
    candidateOwnerNames: state.progressState.candidateOwnerNames,
    validatedOwnerNames: state.progressState.validatedOwnerNames,
  };

  return {
    mode: state.isShortTranscript ? "short" : "long",
    processedChunks: 0,
    totalChunks: state.selectedChunks.length,
    candidateCount: state.diagnostics.generatedCandidateCount,
    persistedTaskCount: state.diagnostics.finalPersistedTaskCount,
    isPreliminary: false,
    activityHints,
    diagnostics: { ...state.diagnostics, phaseDurationsMs: { ...state.diagnostics.phaseDurationsMs } },
    ...overrides,
  };
}

async function notifyMeetingTaskPhaseChange(input: {
  state: MeetingTaskProgressToolkitState;
  options: GenerateMeetingTasksInternalOptions;
  phase: TaskGenerationPhase;
  progress?: MeetingTaskProgress | null;
}) {
  const { state, options, phase, progress } = input;
  recordMeetingTaskPhaseDuration({ state, nextPhase: phase });
  const nextProgress = progress?.diagnostics
    ? {
        ...progress,
        diagnostics: {
          ...progress.diagnostics,
          phaseDurationsMs: { ...state.diagnostics.phaseDurationsMs },
        },
      }
    : progress;
  await options.onPhaseChange?.({ phase, progress: nextProgress ?? null });
}

function applyMeetingTaskModelGenerationDiagnostics(input: {
  state: MeetingTaskProgressToolkitState;
  generation: {
    taskModel: string;
    taskPromptVersion: string;
    items: MeetingTaskCandidate[];
    diagnostics?: { modelCallDurationMs?: number; schemaDroppedCandidateCount?: number; rawCandidateCount?: number };
  };
  fallbackDurationMs: number;
}) {
  const { state, generation, fallbackDurationMs } = input;
  const { diagnostics, progressState, participants } = state;
  diagnostics.model = generation.taskModel;
  diagnostics.promptVersion = generation.taskPromptVersion;
  diagnostics.modelCallCount += 1;
  diagnostics.modelCallDurationMs += generation.diagnostics?.modelCallDurationMs ?? fallbackDurationMs;
  diagnostics.generatedCandidateCount += generation.items.length;
  diagnostics.schemaDroppedCandidateCount += generation.diagnostics?.schemaDroppedCandidateCount ?? 0;
  progressState.candidateOwnerNames = uniqueNames([
    ...progressState.candidateOwnerNames,
    ...ownerNamesFromCandidates({ candidates: generation.items, participants }),
  ]);
}

function startMeetingTaskModelProgressHeartbeat(input: {
  meetingId: string;
  logger: LoggerLike;
  state: MeetingTaskProgressToolkitState;
  options: GenerateMeetingTasksInternalOptions;
  phase: TaskGenerationPhase;
  modelCallStartedAt: string;
  buildHeartbeatProgress: (idleSeconds: number) => MeetingTaskProgress;
}): () => void {
  const { meetingId, logger, state, options, phase, modelCallStartedAt, buildHeartbeatProgress } = input;
  const startedAtMs = Date.parse(modelCallStartedAt);
  const intervalId = setInterval(() => {
    const idleSeconds = Number.isFinite(startedAtMs)
      ? Math.max(0, Math.floor((Date.now() - startedAtMs) / MS_PER_SECOND))
      : 0;
    void (async () => {
      try {
        await notifyMeetingTaskPhaseChange({
          state,
          options,
          phase,
          progress: buildHeartbeatProgress(idleSeconds),
        });
      } catch (error) {
        logger.warn?.(
          {
            meetingId,
            phase,
            error: error instanceof Error ? error.message : TASK_PROGRESS_HEARTBEAT_FAILED_MESSAGE,
          },
          TASK_PROGRESS_HEARTBEAT_FAILED_MESSAGE,
        );
      }
    })();
  }, TASK_PROGRESS_HEARTBEAT_MS);

  return () => clearInterval(intervalId);
}

function createMeetingTaskProgressToolkit(input: {
  meetingId: string;
  logger: LoggerLike;
  options: GenerateMeetingTasksInternalOptions;
  participants: MeetingParticipant[];
  bootstrap: MeetingTaskGenerationBootstrap;
}): MeetingTaskProgressToolkit {
  const { meetingId, logger, options, participants, bootstrap } = input;
  const { isShortTranscript, selectedChunks, transcriptActivityHints, segments, transcriptChars, chunks } = bootstrap;
  const progressState: {
    candidateOwnerNames: string[];
    validatedOwnerNames: string[];
    activePhase: TaskGenerationPhase | null;
    activePhaseStartedAt: number;
  } = {
    candidateOwnerNames: [],
    validatedOwnerNames: [],
    activePhase: null,
    activePhaseStartedAt: Date.now(),
  };
  const diagnostics: MeetingTaskDiagnostics = {
    segmentCount: segments.length,
    transcriptChars,
    chunkCount: chunks.length,
    selectedChunkCount: selectedChunks.length,
    model: null,
    promptVersion: null,
    modelCallCount: 0,
    modelCallDurationMs: 0,
    generatedCandidateCount: 0,
    schemaDroppedCandidateCount: 0,
    evidenceDroppedCandidateCount: 0,
    dedupedCandidateCount: 0,
    qualityDroppedCandidateCount: 0,
    finalPersistedTaskCount: 0,
    phaseDurationsMs: {},
  };
  const toolkitState: MeetingTaskProgressToolkitState = {
    progressState,
    diagnostics,
    isShortTranscript,
    selectedChunks,
    transcriptActivityHints,
    participants,
  };

  return {
    progressState,
    diagnostics,
    buildProgress: (overrides) => buildMeetingTaskProgressFromState({ state: toolkitState, overrides }),
    updatePhase: (phaseInput) => notifyMeetingTaskPhaseChange({ state: toolkitState, options, ...phaseInput }),
    applyGenerationDiagnostics: (generationInput) =>
      applyMeetingTaskModelGenerationDiagnostics({ state: toolkitState, ...generationInput }),
    startProgressHeartbeat: (heartbeatInput) =>
      startMeetingTaskModelProgressHeartbeat({
        meetingId,
        logger,
        state: toolkitState,
        options,
        ...heartbeatInput,
      }),
  };
}

type MeetingTaskGenerationContinueInput = {
  meetingId: string;
  logger: LoggerLike;
  options: GenerateMeetingTasksInternalOptions;
  bootstrap: MeetingTaskGenerationBootstrap;
  toolkit: MeetingTaskProgressToolkit;
  taskListId: string;
};

type MeetingTaskGenerationContinueScope = {
  meetingId: string;
  logger: LoggerLike;
  options: GenerateMeetingTasksInternalOptions;
  list: { id: string };
  meetingTitle: string | null;
  participantViews: MeetingTaskGenerationBootstrap["participantViews"];
  transcriptHash: string;
  initialCandidates: MeetingTaskCandidate[] | undefined;
  dismissedTombstones: MeetingTaskGenerationBootstrap["dismissedTombstones"];
  segments: TranscriptSegment[];
  transcriptChars: number;
  languageContext: string;
  chunks: TaskChunk[];
  selectedChunks: TaskChunk[];
  isShortTranscript: boolean;
  participants: MeetingParticipant[];
  transcriptData: TranscriptData;
  progressState: MeetingTaskProgressToolkit["progressState"];
  diagnostics: MeetingTaskDiagnostics;
  buildProgress: MeetingTaskProgressToolkit["buildProgress"];
  updatePhase: MeetingTaskProgressToolkit["updatePhase"];
  applyGenerationDiagnostics: MeetingTaskProgressToolkit["applyGenerationDiagnostics"];
  startProgressHeartbeat: MeetingTaskProgressToolkit["startProgressHeartbeat"];
};

function buildMeetingTaskGenerationContinueScope(
  input: MeetingTaskGenerationContinueInput,
): MeetingTaskGenerationContinueScope {
  const { meetingId, logger, options, bootstrap, toolkit, taskListId } = input;
  const {
    meetingTitle,
    participantViews,
    transcriptHash,
    initialCandidates,
    dismissedTombstones,
    segments,
    transcriptChars,
    languageContext,
    chunks,
    selectedChunks,
    isShortTranscript,
  } = bootstrap;
  const { progressState, diagnostics, buildProgress, updatePhase, applyGenerationDiagnostics, startProgressHeartbeat } =
    toolkit;

  return {
    meetingId,
    logger,
    options,
    list: { id: taskListId },
    meetingTitle,
    participantViews,
    transcriptHash,
    initialCandidates,
    dismissedTombstones,
    segments,
    transcriptChars,
    languageContext,
    chunks,
    selectedChunks,
    isShortTranscript,
    participants: bootstrap.participants,
    transcriptData: bootstrap.transcriptData,
    progressState,
    diagnostics,
    buildProgress,
    updatePhase,
    applyGenerationDiagnostics,
    startProgressHeartbeat,
  };
}

function estimateMeetingTaskGlobalVerificationInputTokens(scope: MeetingTaskGenerationContinueScope): number | null {
  const { initialCandidates, dismissedTombstones, segments } = scope;
  if (initialCandidates === undefined) {
    return null;
  }

  return (
    estimateMeetingTaskInputTokens(
      segments
        .map(
          (segment) =>
            `[${segment.startedAt.toISOString()}] (${segment.id}) ${segment.speakerName}: ${segment.content}`,
        )
        .join("\n"),
    ) +
    estimateMeetingTaskInputTokens(JSON.stringify(initialCandidates, null, JSON_PRETTY_PRINT_INDENT)) +
    estimateMeetingTaskInputTokens(JSON.stringify(dismissedTombstones, null, JSON_PRETTY_PRINT_INDENT))
  );
}

async function completePersistedMeetingTaskGeneration(input: {
  scope: MeetingTaskGenerationContinueScope;
  listId: string;
  generation: MeetingTaskGeneration;
  persistedItems: MeetingTaskCandidate[];
  progress: { processedChunks: number; totalChunks: number; candidateCount: number };
  log: { message: string; bindings: Record<string, unknown> };
}): Promise<MeetingTaskGenerationResult> {
  const { scope, listId, generation, persistedItems, progress, log } = input;
  const { meetingId, logger, transcriptHash, diagnostics, buildProgress, updatePhase } = scope;

  await updatePhase({
    phase: "preparing_tasks",
    progress: buildProgress({
      processedChunks: progress.processedChunks,
      totalChunks: progress.totalChunks,
      candidateCount: progress.candidateCount,
      persistedTaskCount: persistedItems.length,
      currentOperation: "persisting_tasks",
    }),
  });
  await repositories().upsertMeetingTaskList({
    jobId: scope.options.jobId,
    meetingId,
    status: "generating",
    phase: "preparing_tasks",
    error: null,
    model: generation.taskModel,
    promptVersion: generation.taskPromptVersion,
    transcriptHash,
    completedAt: null,
  });

  const completedAt = new Date();
  const { taskList: completed, tasks } = await repositories().replaceAndCompleteMeetingTasksForList({
    jobId: scope.options.jobId,
    meetingId,
    taskListId: listId,
    items: persistedItems,
    model: generation.taskModel,
    promptVersion: generation.taskPromptVersion,
    transcriptHash,
    completedAt,
  });
  Object.assign(diagnostics, { finalPersistedTaskCount: tasks.length });
  const completedProgress = buildProgress({
    processedChunks: progress.processedChunks,
    totalChunks: progress.totalChunks,
    candidateCount: progress.candidateCount,
    persistedTaskCount: tasks.length,
    isPreliminary: false,
    currentOperation: "complete",
  });
  await updatePhase({ phase: "complete", progress: completedProgress });

  logger.info?.(
    {
      ...log.bindings,
      persistedTaskCount: tasks.length,
      taskModel: generation.taskModel,
      taskDiagnostics: completedProgress.diagnostics,
    },
    log.message,
  );

  return { taskList: completed, tasks, progress: completedProgress };
}

async function announceMeetingTaskValidatingPhase(input: {
  scope: MeetingTaskGenerationContinueScope;
  generation: MeetingTaskGeneration;
  progress: { processedChunks: number; totalChunks: number };
}): Promise<void> {
  const { scope, generation, progress } = input;
  const { meetingId, transcriptHash, buildProgress, updatePhase } = scope;
  await updatePhase({
    phase: "validating_tasks",
    progress: buildProgress({
      processedChunks: progress.processedChunks,
      totalChunks: progress.totalChunks,
      candidateCount: generation.items.length,
      currentOperation: "validating_candidates",
    }),
  });
  await repositories().upsertMeetingTaskList({
    jobId: scope.options.jobId,
    meetingId,
    status: "generating",
    phase: "validating_tasks",
    error: null,
    model: generation.taskModel,
    promptVersion: generation.taskPromptVersion,
    transcriptHash,
    completedAt: null,
  });
}

async function runMeetingTaskGlobalVerificationPass(
  scope: MeetingTaskGenerationContinueScope & { initialCandidates: MeetingTaskCandidate[] },
): Promise<MeetingTaskGenerationResult> {
  const {
    meetingId,
    options,
    list,
    initialCandidates,
    dismissedTombstones,
    segments,
    participants,
    progressState,
    diagnostics,
    buildProgress,
    updatePhase,
    applyGenerationDiagnostics,
    startProgressHeartbeat,
  } = scope;
  diagnostics.selectedChunkCount = 1;
  const modelCallStartedAt = new Date().toISOString();
  await updatePhase({
    phase: "finding_followups",
    progress: buildProgress({
      totalChunks: 1,
      candidateCount: initialCandidates.length,
      currentOperation: "extracting_candidates",
      modelCallStartedAt,
    }),
  });
  const requestStartedAt = Date.now();
  const stopHeartbeat = startProgressHeartbeat({
    phase: "finding_followups",
    modelCallStartedAt,
    buildHeartbeatProgress: (idleSeconds) =>
      buildProgress({
        totalChunks: 1,
        candidateCount: initialCandidates.length,
        currentOperation: "extracting_candidates",
        modelCallStartedAt,
        idleSeconds,
      }),
  });
  const response = await (async () => {
    try {
      return await triggerMeetingTasks(meetingId, {
        initialCandidates,
        dismissedTombstones,
        metering: { jobId: options.jobId ?? null },
      });
    } finally {
      stopHeartbeat();
    }
  })();

  const generation = meetingTaskGenerationSchema.parse(response.tasks);
  applyGenerationDiagnostics({ generation, fallbackDurationMs: Date.now() - requestStartedAt });
  const validation = validateTaskCandidatesWithDiagnostics({ items: generation.items, segments, participants });
  diagnostics.evidenceDroppedCandidateCount += validation.evidenceDroppedCandidateCount;
  diagnostics.dedupedCandidateCount += validation.dedupedCandidateCount;
  Object.assign(diagnostics, { finalPersistedTaskCount: validation.items.length });
  progressState.validatedOwnerNames = ownerNamesFromValidatedTasks(validation.items);

  await announceMeetingTaskValidatingPhase({
    scope,
    generation,
    progress: { processedChunks: 1, totalChunks: 1 },
  });

  return completePersistedMeetingTaskGeneration({
    scope,
    listId: list.id,
    generation,
    persistedItems: validation.items,
    progress: { processedChunks: 1, totalChunks: 1, candidateCount: generation.items.length },
    log: {
      message: TASK_GLOBAL_VERIFICATION_COMPLETE_MESSAGE,
      bindings: {
        meetingId,
        initialCandidateCount: initialCandidates.length,
        generatedTaskCount: generation.items.length,
        evidenceDroppedCandidateCount: diagnostics.evidenceDroppedCandidateCount,
        dedupedCandidateCount: diagnostics.dedupedCandidateCount,
      },
    },
  });
}

async function loadMeetingTaskVoiceSearchIdentityEvidence(scope: MeetingTaskGenerationContinueScope) {
  const { meetingId, logger, transcriptData } = scope;

  // One optional lookup for the entire chunk/reconciliation pipeline, not one
  // transcript read per chunk. Failures must not block ordinary task generation.
  return groundedVoiceSearchIdentityEvidence({
    meetingId,
    segments: transcriptData.segments,
    runs: await (async () => {
      try {
        return await repositories().listVoiceSearchEvidenceForMeeting({
          meetingId,
          includeResults: true,
          completedOnly: true,
        });
      } catch (error) {
        if (error instanceof Error || error !== undefined) {
          logger.warn?.({ meetingId }, TASK_VOICE_IDENTITY_UNAVAILABLE_MESSAGE);
        }

        return [];
      }
    })(),
  });
}

function createMeetingTaskPersonalListItemsAccessor(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
}) {
  const { scope, voiceSearchIdentityEvidence } = input;
  const {
    meetingId,
    logger,
    options,
    meetingTitle,
    participantViews,
    segments,
    languageContext,
    participants,
    diagnostics,
    applyGenerationDiagnostics,
  } = scope;
  const personalListChunk = buildPersonalListTaskChunk(segments);
  const personalListGenerationPromise = personalListChunk
    ? (async () => {
        const requestStartedAt = Date.now();
        try {
          const response = await triggerMeetingTaskChunk({
            meetingId,
            metering: { jobId: options.jobId ?? null },
            title: meetingTitle,
            participants: participantViews,
            chunkIndex: 0,
            totalChunks: 1,
            taskHintScore: personalListChunk.taskHintScore,
            transcriptText: personalListChunk.text,
            voiceSearchIdentityEvidence,
            languageContext,
            extractionMode: "personal_list",
          });

          return {
            generation: meetingTaskGenerationSchema.parse(response.tasks),
            durationMs: Date.now() - requestStartedAt,
            error: null,
          };
        } catch (error) {
          return {
            generation: null,
            durationMs: Date.now() - requestStartedAt,
            error,
          };
        }
      })()
    : Promise.resolve(null);
  const personalListItemsState: { promise: Promise<MeetingTaskCandidate[]> | null } = { promise: null };

  async function getValidatedPersonalListItems() {
    personalListItemsState.promise ??= (async () => {
      const result = await personalListGenerationPromise;
      if (!result) {
        return [];
      }
      if (!result.generation) {
        diagnostics.modelCallCount += 1;
        diagnostics.modelCallDurationMs += result.durationMs;
        logger.warn?.(
          {
            meetingId,
            error: result.error instanceof Error ? result.error.message : TASK_PERSONAL_LIST_EXTRACTION_ERROR_DETAIL,
          },
          TASK_PERSONAL_LIST_EXTRACTION_FAILED_MESSAGE,
        );

        return [];
      }

      applyGenerationDiagnostics({ generation: result.generation, fallbackDurationMs: result.durationMs });
      const validation = validateTaskCandidatesWithDiagnostics({
        items: result.generation.items,
        segments,
        participants,
      });
      diagnostics.evidenceDroppedCandidateCount += validation.evidenceDroppedCandidateCount;
      diagnostics.dedupedCandidateCount += validation.dedupedCandidateCount;

      return validation.items;
    })();

    return personalListItemsState.promise;
  }

  return getValidatedPersonalListItems;
}

async function fetchShortMeetingTaskChunkGeneration(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
}): Promise<MeetingTaskGeneration> {
  const { scope, voiceSearchIdentityEvidence } = input;
  const {
    meetingId,
    options,
    meetingTitle,
    participantViews,
    segments,
    languageContext,
    chunks,
    buildProgress,
    updatePhase,
    applyGenerationDiagnostics,
    startProgressHeartbeat,
  } = scope;
  const chunk = buildFullTranscriptChunk(segments);
  const modelCallStartedAt = new Date().toISOString();
  await updatePhase({
    phase: "finding_followups",
    progress: buildProgress({
      currentOperation: "extracting_candidates",
      modelCallStartedAt,
    }),
  });
  const requestStartedAt = Date.now();
  const stopHeartbeat = startProgressHeartbeat({
    phase: "finding_followups",
    modelCallStartedAt,
    buildHeartbeatProgress: (idleSeconds) =>
      buildProgress({
        currentOperation: "extracting_candidates",
        modelCallStartedAt,
        idleSeconds,
      }),
  });
  const response = await (async () => {
    try {
      return await triggerMeetingTaskChunk({
        meetingId,
        metering: { jobId: options.jobId ?? null },
        title: meetingTitle,
        participants: participantViews,
        chunkIndex: chunk.index,
        totalChunks: chunks.length === 0 ? 1 : chunks.length,
        taskHintScore: chunk.taskHintScore,
        transcriptText: chunk.text,
        voiceSearchIdentityEvidence,
        languageContext,
        extractionMode: "general",
      });
    } finally {
      stopHeartbeat();
    }
  })();
  const generation = meetingTaskGenerationSchema.parse(response.tasks);
  applyGenerationDiagnostics({ generation, fallbackDurationMs: Date.now() - requestStartedAt });

  return generation;
}

async function runMeetingTaskShortTranscriptGeneration(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
  getValidatedPersonalListItems: () => Promise<MeetingTaskCandidate[]>;
}): Promise<MeetingTaskGenerationResult> {
  const { scope, voiceSearchIdentityEvidence, getValidatedPersonalListItems } = input;
  const { meetingId, list, segments, participants, progressState, diagnostics } = scope;
  const generation = await fetchShortMeetingTaskChunkGeneration({ scope, voiceSearchIdentityEvidence });

  await announceMeetingTaskValidatingPhase({
    scope,
    generation,
    progress: { processedChunks: 1, totalChunks: 1 },
  });

  const [validation, personalListItems] = await Promise.all([
    Promise.resolve(validateTaskCandidatesWithDiagnostics({ items: generation.items, segments, participants })),
    getValidatedPersonalListItems(),
  ]);
  diagnostics.evidenceDroppedCandidateCount += validation.evidenceDroppedCandidateCount;
  diagnostics.dedupedCandidateCount += validation.dedupedCandidateCount;
  const merged = mergeGeneralAndPersonalListTasks({
    generalItems: validation.items,
    personalListItems,
    participants,
  });
  diagnostics.qualityDroppedCandidateCount += merged.generalDroppedCount;
  diagnostics.evidenceDroppedCandidateCount += merged.personalEvidenceDroppedCount;
  diagnostics.dedupedCandidateCount += merged.dedupedCandidateCount;
  const finalItems = merged.items;
  Object.assign(diagnostics, { finalPersistedTaskCount: finalItems.length });
  progressState.validatedOwnerNames = ownerNamesFromValidatedTasks(finalItems);

  return completePersistedMeetingTaskGeneration({
    scope,
    listId: list.id,
    generation,
    persistedItems: finalItems,
    progress: { processedChunks: 1, totalChunks: 1, candidateCount: generation.items.length },
    log: {
      message: TASK_GENERATION_COMPLETE_MESSAGE,
      bindings: {
        meetingId,
        generatedTaskCount: diagnostics.generatedCandidateCount,
        schemaDroppedCandidateCount: diagnostics.schemaDroppedCandidateCount,
        evidenceDroppedCandidateCount: diagnostics.evidenceDroppedCandidateCount,
        dedupedCandidateCount: diagnostics.dedupedCandidateCount,
      },
    },
  });
}

type MeetingTaskLongChunkRunState = {
  candidates: MeetingTaskCandidate[];
  taskModel: string | null;
  taskPromptVersion: string | null;
  processedChunks: number;
  finalItems: MeetingTaskCandidate[];
};

async function requestGeneralLongMeetingTaskChunk(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
  chunk: TaskChunk;
}): Promise<{ chunk: TaskChunk; generation: MeetingTaskGeneration | null; durationMs: number }> {
  const { scope, voiceSearchIdentityEvidence, chunk } = input;
  const { meetingId, logger, options, meetingTitle, participantViews, languageContext, chunks } = scope;
  const requestStartedAt = Date.now();
  try {
    const response = await triggerMeetingTaskChunk({
      meetingId,
      metering: { jobId: options.jobId ?? null },
      title: meetingTitle,
      participants: participantViews,
      chunkIndex: chunk.index,
      totalChunks: chunks.length,
      taskHintScore: chunk.taskHintScore,
      transcriptText: chunk.text,
      voiceSearchIdentityEvidence,
      languageContext,
      extractionMode: "general",
    });
    const generation = meetingTaskGenerationSchema.parse(response.tasks);

    return { chunk, generation, durationMs: Date.now() - requestStartedAt };
  } catch (error) {
    logger.warn?.(
      {
        meetingId,
        chunkIndex: chunk.index,
        error: error instanceof Error ? error.message : TASK_CHUNK_FAILED_ERROR_DETAIL,
      },
      TASK_CHUNK_FAILED_MESSAGE,
    );

    return { chunk, generation: null, durationMs: Date.now() - requestStartedAt };
  }
}

async function processLongMeetingTaskChunkBatch(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
  runState: MeetingTaskLongChunkRunState;
  totalChunks: number;
  batch: TaskChunk[];
}): Promise<void> {
  const { scope, voiceSearchIdentityEvidence, runState, totalChunks, batch } = input;
  const {
    meetingId,
    list,
    transcriptHash,
    segments,
    participants,
    progressState,
    diagnostics,
    buildProgress,
    updatePhase,
    applyGenerationDiagnostics,
    startProgressHeartbeat,
  } = scope;
  const modelCallStartedAt = new Date().toISOString();
  await updatePhase({
    phase: "finding_followups",
    progress: buildProgress({
      processedChunks: runState.processedChunks,
      totalChunks,
      isPreliminary: true,
      currentOperation: "extracting_candidates",
      modelCallStartedAt,
    }),
  });
  const stopHeartbeat = startProgressHeartbeat({
    phase: "finding_followups",
    modelCallStartedAt,
    buildHeartbeatProgress: (idleSeconds) =>
      buildProgress({
        processedChunks: runState.processedChunks,
        totalChunks,
        isPreliminary: true,
        currentOperation: "extracting_candidates",
        modelCallStartedAt,
        idleSeconds,
      }),
  });
  const batchResults = await (async () => {
    try {
      return await Promise.all(
        batch.map((chunk) => requestGeneralLongMeetingTaskChunk({ scope, voiceSearchIdentityEvidence, chunk })),
      );
    } finally {
      stopHeartbeat();
    }
  })();

  batchResults.forEach((result) => {
    if (!result.generation) {
      diagnostics.modelCallCount += 1;
      diagnostics.modelCallDurationMs += result.durationMs;

      return;
    }
    applyGenerationDiagnostics({ generation: result.generation, fallbackDurationMs: result.durationMs });
    runState.taskModel = result.generation.taskModel;
    runState.taskPromptVersion = result.generation.taskPromptVersion;
    runState.candidates = [...runState.candidates, ...result.generation.items];
  });

  runState.processedChunks += batch.length;
  const preliminaryValidation = validateTaskCandidatesWithDiagnostics({
    items: runState.candidates,
    segments,
    participants,
  });
  progressState.validatedOwnerNames = ownerNamesFromValidatedTasks(preliminaryValidation.items);
  const progress = buildProgress({
    processedChunks: runState.processedChunks,
    totalChunks,
    candidateCount: runState.candidates.length,
    persistedTaskCount: preliminaryValidation.items.length,
    isPreliminary: true,
    currentOperation: "extracting_candidates",
  });
  await updatePhase({ phase: "finding_followups", progress });
  await repositories().replaceMeetingTasksForList({
    jobId: scope.options.jobId,
    meetingId,
    taskListId: list.id,
    items: preliminaryValidation.items,
  });
  await repositories().upsertMeetingTaskList({
    jobId: scope.options.jobId,
    meetingId,
    status: "generating",
    phase: "finding_followups",
    error: null,
    model: runState.taskModel,
    promptVersion: runState.taskPromptVersion,
    transcriptHash,
    completedAt: null,
  });
}

async function processLongMeetingTaskChunkBatches(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
  runState: MeetingTaskLongChunkRunState;
  totalChunks: number;
}): Promise<void> {
  const { scope, voiceSearchIdentityEvidence, runState, totalChunks } = input;
  const { selectedChunks } = scope;
  const batchStarts = Array.from(
    { length: Math.ceil(selectedChunks.length / TASK_CHUNK_CONCURRENCY) },
    (_, batchIndex) => batchIndex * TASK_CHUNK_CONCURRENCY,
  );
  await batchStarts.reduce(async (previous, startIndex) => {
    await previous;
    const batch = selectedChunks.slice(startIndex, startIndex + TASK_CHUNK_CONCURRENCY);
    await processLongMeetingTaskChunkBatch({
      scope,
      voiceSearchIdentityEvidence,
      runState,
      totalChunks,
      batch,
    });
  }, Promise.resolve());
}

async function extractLongMeetingTaskCandidatesInBatches(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
}): Promise<{ runState: MeetingTaskLongChunkRunState; totalChunks: number }> {
  const { scope, voiceSearchIdentityEvidence } = input;
  const totalChunks = scope.selectedChunks.length;
  const runState: MeetingTaskLongChunkRunState = {
    candidates: [],
    taskModel: null,
    taskPromptVersion: null,
    processedChunks: 0,
    finalItems: [],
  };
  await processLongMeetingTaskChunkBatches({
    scope,
    voiceSearchIdentityEvidence,
    runState,
    totalChunks,
  });

  return { runState, totalChunks };
}

async function attemptLongMeetingTaskReconciliation(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
  runState: MeetingTaskLongChunkRunState;
  totalChunks: number;
  validatedPreliminaryItems: MeetingTaskCandidate[];
  knownQuotes: MeetingTaskSourceQuote[];
  modelCallStartedAt: string;
}): Promise<void> {
  const {
    scope,
    voiceSearchIdentityEvidence,
    runState,
    totalChunks,
    validatedPreliminaryItems,
    knownQuotes,
    modelCallStartedAt,
  } = input;
  const {
    meetingId,
    options,
    meetingTitle,
    participantViews,
    segments,
    languageContext,
    participants,
    progressState,
    diagnostics,
    buildProgress,
    applyGenerationDiagnostics,
    startProgressHeartbeat,
  } = scope;
  const requestStartedAt = Date.now();
  const stopHeartbeat = startProgressHeartbeat({
    phase: "preparing_tasks",
    modelCallStartedAt,
    buildHeartbeatProgress: (idleSeconds) =>
      buildProgress({
        processedChunks: totalChunks,
        totalChunks,
        candidateCount: runState.candidates.length,
        persistedTaskCount: validatedPreliminaryItems.length,
        isPreliminary: true,
        currentOperation: "reconciling_tasks",
        modelCallStartedAt,
        idleSeconds,
      }),
  });
  const response = await (async () => {
    try {
      return await triggerMeetingTaskReconciliation({
        meetingId,
        voiceSearchIdentityEvidence,
        metering: { jobId: options.jobId ?? null },
        evidencePacket: buildEvidencePacket({
          meetingId,
          title: meetingTitle,
          participants: participantViews,
          segments,
          candidates: validatedPreliminaryItems,
          languageContext,
        }),
      });
    } finally {
      stopHeartbeat();
    }
  })();
  const generation = meetingTaskGenerationSchema.parse(response.tasks);
  applyGenerationDiagnostics({ generation, fallbackDurationMs: Date.now() - requestStartedAt });
  Object.assign(runState, {
    taskModel: generation.taskModel,
    taskPromptVersion: generation.taskPromptVersion,
  });
  const knownEvidenceItems = filterTasksToKnownEvidence({ items: generation.items, knownQuotes });
  diagnostics.evidenceDroppedCandidateCount += generation.items.length - knownEvidenceItems.length;
  const reconciliationValidation = validateTaskCandidatesWithDiagnostics({
    items: knownEvidenceItems,
    segments,
    participants,
  });
  diagnostics.evidenceDroppedCandidateCount += reconciliationValidation.evidenceDroppedCandidateCount;
  diagnostics.dedupedCandidateCount += reconciliationValidation.dedupedCandidateCount;
  const reconciledItems = reconciliationValidation.items;
  if (reconciledItems.length !== 0) {
    Object.assign(runState, { finalItems: reconciledItems });
    Object.assign(diagnostics, { finalPersistedTaskCount: runState.finalItems.length });
    progressState.validatedOwnerNames = ownerNamesFromValidatedTasks(runState.finalItems);
  }
}

async function reconcileLongMeetingTaskCandidates(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
  runState: MeetingTaskLongChunkRunState;
  totalChunks: number;
  validatedPreliminaryItems: MeetingTaskCandidate[];
}): Promise<void> {
  const { scope, voiceSearchIdentityEvidence, runState, totalChunks, validatedPreliminaryItems } = input;
  const { meetingId, logger, transcriptHash, buildProgress, updatePhase } = scope;
  if (validatedPreliminaryItems.length > 1) {
    const knownQuotes = validatedPreliminaryItems.flatMap((item) => item.sourceQuotes);
    const modelCallStartedAt = new Date().toISOString();
    await updatePhase({
      phase: "preparing_tasks",
      progress: buildProgress({
        processedChunks: totalChunks,
        totalChunks,
        candidateCount: runState.candidates.length,
        persistedTaskCount: validatedPreliminaryItems.length,
        isPreliminary: true,
        currentOperation: "reconciling_tasks",
        modelCallStartedAt,
      }),
    });
    await repositories().upsertMeetingTaskList({
      jobId: scope.options.jobId,
      meetingId,
      status: "generating",
      phase: "preparing_tasks",
      error: null,
      model: runState.taskModel,
      promptVersion: runState.taskPromptVersion,
      transcriptHash,
      completedAt: null,
    });
    try {
      await attemptLongMeetingTaskReconciliation({
        scope,
        voiceSearchIdentityEvidence,
        runState,
        totalChunks,
        validatedPreliminaryItems,
        knownQuotes,
        modelCallStartedAt,
      });
    } catch (error) {
      logger.warn?.(
        {
          meetingId,
          error: error instanceof Error ? error.message : TASK_RECONCILIATION_FAILED_ERROR_DETAIL,
        },
        TASK_RECONCILIATION_FAILED_MESSAGE,
      );
    }
  } else {
    await updatePhase({
      phase: "preparing_tasks",
      progress: buildProgress({
        processedChunks: totalChunks,
        totalChunks,
        candidateCount: runState.candidates.length,
        persistedTaskCount: validatedPreliminaryItems.length,
        isPreliminary: true,
        currentOperation: "persisting_tasks",
      }),
    });
  }
}

async function finalizeLongMeetingTaskGeneration(input: {
  scope: MeetingTaskGenerationContinueScope;
  runState: MeetingTaskLongChunkRunState;
  totalChunks: number;
  validatedPreliminaryItems: MeetingTaskCandidate[];
  getValidatedPersonalListItems: () => Promise<MeetingTaskCandidate[]>;
}): Promise<MeetingTaskGenerationResult> {
  const { scope, runState, totalChunks, validatedPreliminaryItems, getValidatedPersonalListItems } = input;
  const {
    meetingId,
    logger,
    list,
    transcriptHash,
    participants,
    progressState,
    diagnostics,
    buildProgress,
    updatePhase,
  } = scope;
  const personalListItems = await getValidatedPersonalListItems();
  const merged = mergeGeneralAndPersonalListTasks({
    generalItems: runState.finalItems,
    personalListItems,
    participants,
  });
  diagnostics.qualityDroppedCandidateCount += merged.generalDroppedCount;
  diagnostics.evidenceDroppedCandidateCount += merged.personalEvidenceDroppedCount;
  diagnostics.dedupedCandidateCount += merged.dedupedCandidateCount;
  runState.finalItems = merged.items;
  Object.assign(diagnostics, { finalPersistedTaskCount: runState.finalItems.length });
  progressState.validatedOwnerNames = ownerNamesFromValidatedTasks(runState.finalItems);

  const completedAt = new Date();
  const { taskList: completed, tasks } = await repositories().replaceAndCompleteMeetingTasksForList({
    jobId: scope.options.jobId,
    meetingId,
    taskListId: list.id,
    items: runState.finalItems,
    model: runState.taskModel,
    promptVersion: runState.taskPromptVersion ?? MEETING_TASKS_PROMPT_VERSION,
    transcriptHash,
    completedAt,
  });
  Object.assign(diagnostics, { finalPersistedTaskCount: tasks.length });
  const finalProgress = buildProgress({
    processedChunks: totalChunks,
    totalChunks,
    candidateCount: runState.candidates.length,
    persistedTaskCount: tasks.length,
    isPreliminary: false,
  });
  await updatePhase({
    phase: "complete",
    progress: {
      ...finalProgress,
      currentOperation: "complete",
    },
  });
  const completedProgress = buildProgress({
    processedChunks: totalChunks,
    totalChunks,
    candidateCount: runState.candidates.length,
    persistedTaskCount: tasks.length,
    isPreliminary: false,
    currentOperation: "complete",
  });

  logger.info?.(
    {
      meetingId,
      selectedChunkCount: totalChunks,
      generatedTaskCount: runState.candidates.length,
      schemaDroppedCandidateCount: diagnostics.schemaDroppedCandidateCount,
      evidenceDroppedCandidateCount: diagnostics.evidenceDroppedCandidateCount,
      dedupedCandidateCount: diagnostics.dedupedCandidateCount,
      preliminaryTaskCount: validatedPreliminaryItems.length,
      persistedTaskCount: tasks.length,
      taskModel: runState.taskModel,
      taskDiagnostics: completedProgress.diagnostics,
    },
    TASK_GENERATION_COMPLETE_MESSAGE,
  );

  return { taskList: completed, tasks, progress: completedProgress };
}

async function runMeetingTaskLongTranscriptGeneration(input: {
  scope: MeetingTaskGenerationContinueScope;
  voiceSearchIdentityEvidence: ReturnType<typeof groundedVoiceSearchIdentityEvidence>;
  getValidatedPersonalListItems: () => Promise<MeetingTaskCandidate[]>;
}): Promise<MeetingTaskGenerationResult> {
  const { scope, voiceSearchIdentityEvidence, getValidatedPersonalListItems } = input;
  const { segments, participants, diagnostics, progressState } = scope;
  const { runState, totalChunks } = await extractLongMeetingTaskCandidatesInBatches({
    scope,
    voiceSearchIdentityEvidence,
  });
  const finalPreliminaryValidation = validateTaskCandidatesWithDiagnostics({
    items: runState.candidates,
    segments,
    participants,
  });
  diagnostics.evidenceDroppedCandidateCount += finalPreliminaryValidation.evidenceDroppedCandidateCount;
  diagnostics.dedupedCandidateCount += finalPreliminaryValidation.dedupedCandidateCount;
  Object.assign(diagnostics, { finalPersistedTaskCount: finalPreliminaryValidation.items.length });
  const validatedPreliminaryItems = finalPreliminaryValidation.items;
  progressState.validatedOwnerNames = ownerNamesFromValidatedTasks(validatedPreliminaryItems);
  const validationProgress = scope.buildProgress({
    processedChunks: totalChunks,
    totalChunks,
    candidateCount: runState.candidates.length,
    persistedTaskCount: validatedPreliminaryItems.length,
    isPreliminary: true,
    currentOperation: "validating_candidates",
  });
  await scope.updatePhase({ phase: "validating_tasks", progress: validationProgress });
  await repositories().upsertMeetingTaskList({
    jobId: scope.options.jobId,
    meetingId: scope.meetingId,
    status: "generating",
    phase: "validating_tasks",
    error: null,
    model: runState.taskModel,
    promptVersion: runState.taskPromptVersion,
    transcriptHash: scope.transcriptHash,
    completedAt: null,
  });
  Object.assign(runState, { finalItems: validatedPreliminaryItems });
  await reconcileLongMeetingTaskCandidates({
    scope,
    voiceSearchIdentityEvidence,
    runState,
    totalChunks,
    validatedPreliminaryItems,
  });

  return finalizeLongMeetingTaskGeneration({
    scope,
    runState,
    totalChunks,
    validatedPreliminaryItems,
    getValidatedPersonalListItems,
  });
}

async function continueMeetingTaskGeneration(
  input: MeetingTaskGenerationContinueInput,
): Promise<MeetingTaskGenerationResult> {
  const scope = buildMeetingTaskGenerationContinueScope(input);
  const globalVerificationEstimatedTokens = estimateMeetingTaskGlobalVerificationInputTokens(scope);
  const isWithinGlobalVerificationBudget =
    globalVerificationEstimatedTokens !== null &&
    globalVerificationEstimatedTokens <= MEETING_TASK_GLOBAL_VERIFICATION_INPUT_TOKEN_BUDGET;
  if (globalVerificationEstimatedTokens !== null && !isWithinGlobalVerificationBudget) {
    scope.logger.info?.(
      {
        meetingId: scope.meetingId,
        transcriptChars: scope.transcriptChars,
        globalVerificationEstimatedTokens,
        budgetTokens: MEETING_TASK_GLOBAL_VERIFICATION_INPUT_TOKEN_BUDGET,
      },
      TASK_GLOBAL_VERIFICATION_BUDGET_EXCEEDED_MESSAGE,
    );
  }

  const { initialCandidates } = scope;
  if (initialCandidates !== undefined && isWithinGlobalVerificationBudget) {
    return runMeetingTaskGlobalVerificationPass({ ...scope, initialCandidates });
  }

  const voiceSearchIdentityEvidence = await loadMeetingTaskVoiceSearchIdentityEvidence(scope);
  const getValidatedPersonalListItems = createMeetingTaskPersonalListItemsAccessor({
    scope,
    voiceSearchIdentityEvidence,
  });

  if (scope.isShortTranscript) {
    return runMeetingTaskShortTranscriptGeneration({
      scope,
      voiceSearchIdentityEvidence,
      getValidatedPersonalListItems,
    });
  }

  return runMeetingTaskLongTranscriptGeneration({
    scope,
    voiceSearchIdentityEvidence,
    getValidatedPersonalListItems,
  });
}

async function generateAndPersistMeetingTasksUnlocked(
  input: MeetingTaskPipelineInput,
): Promise<MeetingTaskGenerationResult> {
  const bootstrap = await bootstrapMeetingTaskGenerationContext(input);
  const toolkit = createMeetingTaskProgressToolkit({
    meetingId: input.meetingId,
    logger: input.logger,
    options: input.options,
    participants: bootstrap.participants,
    bootstrap,
  });
  const baseProgress = toolkit.buildProgress({
    currentOperation: "planning",
    candidateCount: 0,
    persistedTaskCount: 0,
  });
  await toolkit.updatePhase({ phase: "reviewing_transcript", progress: baseProgress });
  const list = await repositories().upsertMeetingTaskList({
    jobId: input.options.jobId,
    meetingId: input.meetingId,
    status: "generating",
    phase: "reviewing_transcript",
    error: null,
    transcriptHash: bootstrap.transcriptHash,
    completedAt: null,
  });
  await toolkit.updatePhase({ phase: "finding_followups", progress: baseProgress });
  await repositories().upsertMeetingTaskList({
    jobId: input.options.jobId,
    meetingId: input.meetingId,
    status: "generating",
    phase: "finding_followups",
    error: null,
    transcriptHash: bootstrap.transcriptHash,
    completedAt: null,
  });

  return continueMeetingTaskGeneration({
    meetingId: input.meetingId,
    logger: input.logger,
    options: input.options,
    bootstrap,
    toolkit,
    taskListId: list.id,
  });
}

export async function generateAndPersistMeetingTasks(
  ...args: [meetingId: string, logger: LoggerLike, options?: GenerateMeetingTasksPublicOptions]
): Promise<MeetingTaskGenerationResult> {
  if (args[2]?.jobId === undefined || args[2].jobId === null) {
    return recordArtifactRequest({
      meetingId: args[0],
      type: "generate_meeting_tasks",
      run: (jobId) => generateAndPersistMeetingTasks(args[0], args[1], { ...args[2], jobId }),
    });
  }

  try {
    return await repositories().withMeetingLiveTaskDetectionLock(args[0], () =>
      generateAndPersistMeetingTasksUnlocked({
        meetingId: args[0],
        logger: args[1],
        options: {
          jobId: args[2]?.jobId ?? null,
          initialCandidates: args[2]?.initialCandidates,
          onPhaseChange: args[2]?.onPhaseChange
            ? async (change) => args[2]?.onPhaseChange?.(change.phase, change.progress ?? null)
            : undefined,
        },
      }),
    );
  } catch (error) {
    await markMeetingTasksFailed({ meetingId: args[0], jobId: args[2].jobId, error: String(error) });
    throw error;
  }
}
