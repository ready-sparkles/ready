import { z } from "zod";

export const meetingTaskListStatusSchema = z.enum(["pending", "generating", "completed", "failed"]);
export const meetingTaskTypeSchema = z.enum([
  "action_item",
  "follow_up",
  "task",
  "decision_follow_up",
  "open_question",
]);
export const meetingTaskWorkKindSchema = z.enum([
  "bug_or_issue",
  "implementation",
  "design",
  "research",
  "customer_follow_up",
  "sales_or_crm",
  "scheduling",
  "documentation",
  "general",
]);
export const meetingTaskStatusSchema = z.enum(["open", "completed", "dismissed"]);
export const meetingTaskConfidenceSchema = z.enum(["low", "medium", "high"]);
export const meetingTaskOriginSchema = z.enum(["meeting_transcript"]);
export const meetingTaskDetectionOriginSchema = z.enum(["live", "final"]);
export const meetingTaskStatusSourceSchema = z.enum(["model", "user"]);
export const assignedTaskSourceTypeSchema = z.enum(["meeting", "workspace"]);

export const MEETING_TASKS_PROMPT_VERSION = "4.3.0";
// Retained for validation of historical live-task records.
export const LIVE_MEETING_TASK_MAX_PACKET_SEGMENTS = 12;
const TRANSCRIPT_SIMILARITY_INDEX_OUT_OF_RANGE_MESSAGE = "Transcript similarity index is out of range.";
const SEMANTIC_SIMILARITY_MIN_TOKEN_LENGTH = 2;
const SMALL_MEETING_PARTICIPANT_THRESHOLD = 4;
const SMALL_MEETING_TASK_LIMIT = 7;
const LARGE_MEETING_TASK_LIMIT_CAP = 15;
const LARGE_MEETING_TASK_LIMIT_MULTIPLIER = 2;
const MEETING_TASK_ACTIVITY_HINT_NAME_LIMIT = 6;
const MEETING_TASK_TITLE_MAX_LENGTH = 160;
const MEETING_TASK_DESCRIPTION_MAX_LENGTH = 1_000;
const MEETING_TASK_SOURCE_QUOTES_MAX_COUNT = 5;
const MEETING_TASK_SOURCE_REASON_MAX_LENGTH = 500;
const LIVE_MEETING_TASK_UNRESOLVED_QUESTIONS_MAX = 8;
const LIVE_MEETING_TASK_PARTICIPANTS_MAX = 100;
const LIVE_MEETING_TASK_CANDIDATES_MAX = 50;
const LIVE_MEETING_TASK_CONFIRMED_TASKS_MAX = 100;
const LIVE_MEETING_TASK_OPERATION_EVIDENCE_MAX = 12;
const LIVE_MEETING_TASK_OPERATIONS_MAX = 20;
const WORKSPACE_TASK_SECTION_TITLE_MAX_LENGTH = 120;

function normalizeTranscriptSimilarityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function transcriptSimilarityCell(input: { values: readonly number[]; index: number }): number {
  const value = input.values[input.index];
  if (value === undefined) {
    throw new Error(TRANSCRIPT_SIMILARITY_INDEX_OUT_OF_RANGE_MESSAGE);
  }

  return value;
}

function nextTranscriptSimilarityRow(input: {
  previous: readonly number[];
  leftChar: string;
  right: string;
}): number[] {
  const rightChars = Array.from(input.right);

  return rightChars.reduce<number[]>(
    (row, rightChar, index) => {
      const substitutionCost = input.leftChar === rightChar ? 0 : 1;

      return [
        ...row,
        Math.min(
          transcriptSimilarityCell({ values: row, index }) + 1,
          transcriptSimilarityCell({ values: input.previous, index: index + 1 }) + 1,
          transcriptSimilarityCell({ values: input.previous, index }) + substitutionCost,
        ),
      ];
    },
    [transcriptSimilarityCell({ values: input.previous, index: 0 }) + 1],
  );
}

/** Character-level similarity used only to re-anchor immutable live evidence after STT refinement. */
export function normalizedTranscriptSimilarity(input: { left: string; right: string }): number {
  const a = normalizeTranscriptSimilarityText(input.left);
  const b = normalizeTranscriptSimilarityText(input.right);
  if (a === b) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const finalRow = Array.from(a).reduce(
    (previous, leftChar) => nextTranscriptSimilarityRow({ previous, leftChar, right: b }),
    Array.from({ length: b.length + 1 }, (_, index) => index),
  );

  return 1 - transcriptSimilarityCell({ values: finalRow, index: b.length }) / Math.max(a.length, b.length);
}

export function meetingTaskSemanticSimilarity(input: {
  left: { title: string; sourceQuotes: { quote: string }[] };
  right: { title: string; sourceQuotes: { quote: string }[] };
}): number {
  const leftQuotes = new Set(input.left.sourceQuotes.map((quote) => normalizeTranscriptSimilarityText(quote.quote)));
  if (input.right.sourceQuotes.some((quote) => leftQuotes.has(normalizeTranscriptSimilarityText(quote.quote)))) {
    return 1;
  }
  const leftTokens = new Set(
    normalizeTranscriptSimilarityText(input.left.title)
      .split(" ")
      .filter((token) => token.length > SEMANTIC_SIMILARITY_MIN_TOKEN_LENGTH),
  );
  const rightTokens = new Set(
    normalizeTranscriptSimilarityText(input.right.title)
      .split(" ")
      .filter((token) => token.length > SEMANTIC_SIMILARITY_MIN_TOKEN_LENGTH),
  );
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;

  return shared / Math.max(leftTokens.size, rightTokens.size, 1);
}

const MEETING_TASK_LANGUAGE_SAMPLE_WINDOWS = 24;
const MEETING_TASK_LANGUAGE_SAMPLE_WINDOW_CHARS = 120;

const MEETING_TASK_CHARS_PER_TOKEN_ESTIMATE = 3;
const MEETING_TASK_CJK_CHARS_PER_TOKEN_ESTIMATE = 1.25;
// gpt-5.6-sol bills input above 272K tokens at a higher tier. Keep the single
// global verification call inside the standard tier, with headroom for the
// system prompt, participant metadata, and language context around the
// transcript and candidate JSON that callers measure.
const MEETING_TASK_GLOBAL_VERIFICATION_STANDARD_TIER_TOKENS = 272_000;
const MEETING_TASK_GLOBAL_VERIFICATION_RESERVED_TOKENS = 16_000;
export const MEETING_TASK_GLOBAL_VERIFICATION_INPUT_TOKEN_BUDGET =
  MEETING_TASK_GLOBAL_VERIFICATION_STANDARD_TIER_TOKENS - MEETING_TASK_GLOBAL_VERIFICATION_RESERVED_TOKENS;

/**
 * CJK-aware token estimate shared by the API-side routing decision (global
 * verification vs chunked fallback) and the assistant-side timeout scaling,
 * so the two services can never disagree about whether a transcript fits.
 */
export function estimateMeetingTaskInputTokens(text: string): number {
  const cjkChars = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu)?.length ?? 0;
  const otherChars = Math.max(0, text.length - cjkChars);

  return Math.ceil(
    cjkChars / MEETING_TASK_CJK_CHARS_PER_TOKEN_ESTIMATE + otherChars / MEETING_TASK_CHARS_PER_TOKEN_ESTIMATE,
  );
}

const MEETING_TASK_LANGUAGE_SCRIPTS = [
  ["Latin", /\p{Script=Latin}/gu],
  ["Cyrillic", /\p{Script=Cyrillic}/gu],
  ["Arabic", /\p{Script=Arabic}/gu],
  ["Han", /\p{Script=Han}/gu],
  ["Hiragana", /\p{Script=Hiragana}/gu],
  ["Katakana", /\p{Script=Katakana}/gu],
  ["Hangul", /\p{Script=Hangul}/gu],
  ["Devanagari", /\p{Script=Devanagari}/gu],
  ["Hebrew", /\p{Script=Hebrew}/gu],
] as const;

/**
 * Builds a bounded, uniformly distributed view of the whole human transcript
 * for output-language selection. It deliberately contains no speaker or time
 * metadata so downstream models cannot treat it as task evidence.
 */
export function buildMeetingTaskLanguageContext(utterances: string[]): string {
  const transcript = utterances
    .map((utterance) => utterance.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  if (transcript.length === 0) {
    return "No meaningful human speech was available. Default output language: English.";
  }

  const scriptCounts = MEETING_TASK_LANGUAGE_SCRIPTS.map(
    ([name, pattern]) => [name, transcript.match(pattern)?.length ?? 0] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");

  const fullSampleCharacters = MEETING_TASK_LANGUAGE_SAMPLE_WINDOWS * MEETING_TASK_LANGUAGE_SAMPLE_WINDOW_CHARS;
  const coverage =
    transcript.length <= fullSampleCharacters
      ? `Full human transcript:\n${transcript}`
      : [
          `Uniform samples across the entire human transcript (${transcript.length} characters total):`,
          ...Array.from({ length: MEETING_TASK_LANGUAGE_SAMPLE_WINDOWS }, (_, index) => {
            const maxStart = transcript.length - MEETING_TASK_LANGUAGE_SAMPLE_WINDOW_CHARS;
            const start = Math.round((index * maxStart) / Math.max(1, MEETING_TASK_LANGUAGE_SAMPLE_WINDOWS - 1));

            return `[${index + 1}/${MEETING_TASK_LANGUAGE_SAMPLE_WINDOWS}] ${transcript
              .slice(start, start + MEETING_TASK_LANGUAGE_SAMPLE_WINDOW_CHARS)
              .trim()}`;
          }),
        ].join("\n");

  return [
    "Use this whole-meeting context only to select the output language. Never use it as task evidence.",
    `Whole-transcript script-letter counts: ${scriptCounts.length > 0 ? scriptCounts : "none"}.`,
    coverage,
  ].join("\n");
}

export function meetingTaskLimitForParticipantCount(participantCount: number): number {
  const normalizedCount = Number.isFinite(participantCount) ? Math.max(0, Math.floor(participantCount)) : 0;

  return normalizedCount <= SMALL_MEETING_PARTICIPANT_THRESHOLD
    ? SMALL_MEETING_TASK_LIMIT
    : Math.min(LARGE_MEETING_TASK_LIMIT_CAP, normalizedCount * LARGE_MEETING_TASK_LIMIT_MULTIPLIER);
}

export const meetingTaskProgressOperationSchema = z.enum([
  "planning",
  "extracting_candidates",
  "validating_candidates",
  "reconciling_tasks",
  "persisting_tasks",
  "complete",
]);

export const meetingTaskDiagnosticsSchema = z.object({
  segmentCount: z.number().int().nonnegative().default(0),
  transcriptChars: z.number().int().nonnegative().default(0),
  chunkCount: z.number().int().nonnegative().default(0),
  selectedChunkCount: z.number().int().nonnegative().default(0),
  model: z.string().trim().min(1).nullable().default(null),
  promptVersion: z.string().trim().min(1).nullable().default(null),
  modelCallCount: z.number().int().nonnegative().default(0),
  modelCallDurationMs: z.number().int().nonnegative().default(0),
  generatedCandidateCount: z.number().int().nonnegative().default(0),
  schemaDroppedCandidateCount: z.number().int().nonnegative().default(0),
  evidenceDroppedCandidateCount: z.number().int().nonnegative().default(0),
  dedupedCandidateCount: z.number().int().nonnegative().default(0),
  qualityDroppedCandidateCount: z.number().int().nonnegative().default(0),
  finalPersistedTaskCount: z.number().int().nonnegative().default(0),
  phaseDurationsMs: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

export const meetingTaskActivityHintsSchema = z.object({
  participantNames: z.array(z.string().trim().min(1)).max(MEETING_TASK_ACTIVITY_HINT_NAME_LIMIT).default([]),
  requestSpeakerNames: z.array(z.string().trim().min(1)).max(MEETING_TASK_ACTIVITY_HINT_NAME_LIMIT).default([]),
  commitmentSpeakerNames: z.array(z.string().trim().min(1)).max(MEETING_TASK_ACTIVITY_HINT_NAME_LIMIT).default([]),
  candidateOwnerNames: z.array(z.string().trim().min(1)).max(MEETING_TASK_ACTIVITY_HINT_NAME_LIMIT).default([]),
  validatedOwnerNames: z.array(z.string().trim().min(1)).max(MEETING_TASK_ACTIVITY_HINT_NAME_LIMIT).default([]),
});

export const meetingTaskProgressSchema = z.object({
  mode: z.enum(["short", "long"]).default("short"),
  processedChunks: z.number().int().nonnegative().default(0),
  totalChunks: z.number().int().nonnegative().default(0),
  candidateCount: z.number().int().nonnegative().default(0),
  persistedTaskCount: z.number().int().nonnegative().default(0),
  isPreliminary: z.boolean().default(false),
  currentOperation: meetingTaskProgressOperationSchema.optional(),
  modelCallStartedAt: z.string().datetime().nullable().optional(),
  idleSeconds: z.number().int().nonnegative().optional(),
  activityHints: meetingTaskActivityHintsSchema.optional(),
  diagnostics: meetingTaskDiagnosticsSchema.optional(),
});

export const meetingTaskOwnerSchema = z.object({
  userId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).nullable(),
  email: z.string().email().nullable(),
  confidence: meetingTaskConfidenceSchema.nullable(),
});

export const meetingTaskDueDateSchema = z.object({
  value: z.string().trim().min(1).nullable(),
  confidence: meetingTaskConfidenceSchema.nullable(),
});

export const meetingTaskSourceQuoteSchema = z.object({
  quote: z.string().trim().min(1),
  speaker: z.string().trim().min(1).nullable(),
  timestamp: z.string().trim().min(1).nullable(),
  segmentId: z.string().uuid().nullable().optional(),
  sourceSegmentId: z.string().trim().min(1).nullable().optional(),
  speakerIdentity: z.string().trim().min(1).nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
});

export const dismissedMeetingTaskTombstoneSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable(),
  sourceQuotes: z.array(meetingTaskSourceQuoteSchema).min(1),
});

export const meetingTaskCompletionSchema = z.object({
  /** @external persisted meeting task contract */
  completedDuringMeeting: z.boolean().default(false),
  quote: z.string().trim().min(1).nullable().default(null),
  confidence: meetingTaskConfidenceSchema.nullable().default(null),
});

export const OPEN_MEETING_TASK_COMPLETION = {
  /** @external persisted meeting task contract */
  completedDuringMeeting: false,
  quote: null,
  confidence: null,
} as const;

export const meetingTaskCandidateSchema = z.object({
  title: z.string().trim().min(1).max(MEETING_TASK_TITLE_MAX_LENGTH),
  description: z.string().trim().min(1).max(MEETING_TASK_DESCRIPTION_MAX_LENGTH).nullable(),
  type: meetingTaskTypeSchema,
  workKind: meetingTaskWorkKindSchema.default("general"),
  owner: meetingTaskOwnerSchema,
  dueDate: meetingTaskDueDateSchema,
  confidence: meetingTaskConfidenceSchema,
  completion: meetingTaskCompletionSchema.default(OPEN_MEETING_TASK_COMPLETION),
  sourceQuotes: z.array(meetingTaskSourceQuoteSchema).min(1).max(MEETING_TASK_SOURCE_QUOTES_MAX_COUNT),
  sourceReason: z.string().trim().min(1).max(MEETING_TASK_SOURCE_REASON_MAX_LENGTH),
});

export const meetingTaskGenerationSchema = z.object({
  taskModel: z.string().trim().min(1),
  taskPromptVersion: z.string().trim().min(1),
  items: z.array(meetingTaskCandidateSchema).default([]),
  diagnostics: z
    .object({
      modelCallDurationMs: z.number().int().nonnegative().optional(),
      schemaDroppedCandidateCount: z.number().int().nonnegative().optional(),
      normalizedQuoteStringCount: z.number().int().nonnegative().optional(),
      rawCandidateCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

// Persisted tasks omit completion: it is a generation-time signal, and
// status/completedAt are the durable truth once a task is stored.
const isMeetingTaskPreprocessRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const meetingTaskSchema = z.preprocess(
  (value) => {
    if (isMeetingTaskPreprocessRecord(value)) {
      const hasAssignee = value["assignee"] !== undefined && value["assignee"] !== null;
      const owner = value["owner"];
      const hasOwner = owner !== undefined && owner !== null;
      if (!hasAssignee && hasOwner) {
        return {
          ...value,
          assignee: owner,
        };
      }
    }

    return value;
  },
  meetingTaskCandidateSchema.omit({ /** @external zod omit field key */ completion: true }).extend({
    id: z.string().uuid(),
    meetingId: z.string().uuid(),
    taskListId: z.string().uuid(),
    position: z.number().int().nonnegative(),
    assignee: meetingTaskOwnerSchema,
    owner: meetingTaskOwnerSchema,
    status: meetingTaskStatusSchema,
    revision: z.number().int().positive().default(1),
    createdFrom: meetingTaskOriginSchema,
    origin: meetingTaskDetectionOriginSchema.default("final"),
    statusSource: meetingTaskStatusSourceSchema.default("model"),
    statusActorUserId: z.string().uuid().nullable().default(null),
    statusChangedAt: z.string().datetime().nullable().default(null),
    actionConfirmableAt: z.string().datetime().nullable().default(null),
    detectedAt: z.string().datetime().nullable().default(null),
    firstRenderedAt: z.string().datetime().nullable().default(null),
    assetIds: z.array(z.string().uuid()).default([]),
    externalLinks: z.array(z.record(z.string(), z.unknown())).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
  }),
);

export const liveMeetingTaskCandidateStateSchema = z.enum(["deferred", "confirmed", "rejected", "retracted"]);
export const liveMeetingTaskEvidenceRoleSchema = z.enum([
  "action",
  "scope",
  "owner",
  "due_date",
  "completion",
  "cancellation",
  "context",
]);
export const liveMeetingTaskEvidenceSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  roles: z.array(liveMeetingTaskEvidenceRoleSchema).min(1),
  transcriptSegmentId: z.string().uuid().nullable(),
  sourceSegmentId: z.string().trim().min(1).nullable(),
  fullSegmentText: z.string().min(1),
  quote: z.string().min(1),
  quoteStart: z.number().int().nonnegative(),
  quoteEnd: z.number().int().positive(),
  contentHash: z.string().min(1),
  speakerIdentity: z.string().trim().min(1).nullable(),
  speakerUserId: z.string().uuid().nullable(),
  speakerName: z.string().trim().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
});
export const liveMeetingTaskCandidateSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  linkedTaskId: z.string().uuid().nullable(),
  state: liveMeetingTaskCandidateStateSchema,
  proposal: meetingTaskCandidateSchema,
  unresolvedQuestions: z.array(z.string().trim().min(1)).max(LIVE_MEETING_TASK_UNRESOLVED_QUESTIONS_MAX),
  firstEvidenceAt: z.string().datetime(),
  actionConfirmableAt: z.string().datetime().nullable(),
  lastEvidenceAt: z.string().datetime(),
  model: z.string().trim().min(1).nullable(),
  promptVersion: z.string().trim().min(1).nullable(),
  revision: z.number().int().positive(),
  evidence: z.array(liveMeetingTaskEvidenceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const liveMeetingTaskInputSegmentSchema = z.object({
  id: z.string().uuid(),
  sourceSegmentId: z.string().trim().min(1).nullable().default(null),
  speakerIdentity: z.string().trim().min(1).nullable().default(null),
  speakerUserId: z.string().uuid().nullable().default(null),
  speakerName: z.string().trim().min(1),
  content: z.string().trim().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
});
export const liveMeetingTaskConfirmedTaskSchema = meetingTaskCandidateSchema.extend({
  id: z.string().uuid(),
  status: meetingTaskStatusSchema,
});
export const liveMeetingTaskDetectionInputSchema = z.object({
  meetingId: z.string().uuid(),
  title: z.string().trim().min(1).nullable(),
  participants: z
    .array(
      z.object({
        userId: z.string().uuid().nullable().default(null),
        name: z.string().trim().min(1),
        email: z.string().email().nullable().default(null),
        roleHint: z.string().trim().min(1).nullable().default(null),
      }),
    )
    .max(LIVE_MEETING_TASK_PARTICIPANTS_MAX),
  segments: z.array(liveMeetingTaskInputSegmentSchema).max(LIVE_MEETING_TASK_MAX_PACKET_SEGMENTS),
  candidates: z.array(liveMeetingTaskCandidateSchema).max(LIVE_MEETING_TASK_CANDIDATES_MAX),
  confirmedTasks: z.array(liveMeetingTaskConfirmedTaskSchema).max(LIVE_MEETING_TASK_CONFIRMED_TASKS_MAX),
});
export const liveMeetingTaskOperationEvidenceSchema = z.object({
  segmentId: z.string().uuid(),
  quote: z.string().min(1),
  roles: z.array(liveMeetingTaskEvidenceRoleSchema).min(1),
});
export const liveMeetingTaskOperationSchema = z.object({
  operation: z.enum(["confirm", "update", "complete", "retract", "defer", "ignore"]),
  candidateId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  task: meetingTaskCandidateSchema.nullable(),
  evidence: z.array(liveMeetingTaskOperationEvidenceSchema).max(LIVE_MEETING_TASK_OPERATION_EVIDENCE_MAX),
  unresolvedQuestions: z.array(z.string().trim().min(1)).max(LIVE_MEETING_TASK_UNRESOLVED_QUESTIONS_MAX),
});
export const liveMeetingTaskDetectionSchema = z.object({
  taskModel: z.string().trim().min(1),
  taskPromptVersion: z.string().trim().min(1),
  operations: z.array(liveMeetingTaskOperationSchema).max(LIVE_MEETING_TASK_OPERATIONS_MAX),
  modelCallDurationMs: z.number().int().nonnegative().default(0),
});

export const meetingTaskListSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  status: meetingTaskListStatusSchema,
  phase: z.string().nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  transcriptHash: z.string().nullable(),
  taskListVersion: z.number().int().positive().default(1),
  items: z.array(meetingTaskSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

export const taskRealtimeEventNameSchema = z.enum([
  "task.generation.started",
  "task.generation.updated",
  "task.generation.completed",
  "task.generation.failed",
  "task.linear_review.started",
  "task.linear_review.updated",
  "task.created",
  "task.updated",
  "task.assigned",
  "task.unassigned",
  "task.dismissed",
  "task.deleted",
  "task.list.updated",
  "workspace.task.created",
  "workspace.task.updated",
  "workspace.task.deleted",
  "workspace.task.placement.updated",
  "workspace.task.section.created",
  "workspace.task.section.updated",
]);

export const taskRealtimeEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().uuid(),
  eventName: taskRealtimeEventNameSchema,
  workspaceId: z.string().uuid(),
  meetingId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable().optional(),
  sourceType: assignedTaskSourceTypeSchema.optional(),
  sourceTaskId: z.string().uuid().nullable().optional(),
  sectionId: z.string().uuid().nullable().optional(),
  revision: z.number().int().positive().nullable().optional(),
  placementRevision: z.number().int().positive().nullable().optional(),
  taskListVersion: z.number().int().positive().nullable().optional(),
  occurredAt: z.string().datetime(),
  actorUserId: z.string().uuid().nullable(),
});

export const assignedTaskSummarySchema = z.object({
  task: meetingTaskSchema,
  meeting: z.object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    title: z.string().min(1),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  }),
});

export const workspaceTaskSectionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string().trim().min(1).max(WORKSPACE_TASK_SECTION_TITLE_MAX_LENGTH),
  position: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  createdByUserId: z.string().uuid().nullable(),
  updatedByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

export const workspaceTaskSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  createdByUserId: z.string().uuid().nullable(),
  updatedByUserId: z.string().uuid().nullable(),
  assigneeUserId: z.string().uuid().nullable(),
  title: z.string().trim().min(1).max(MEETING_TASK_TITLE_MAX_LENGTH),
  description: z.string().trim().min(1).max(MEETING_TASK_DESCRIPTION_MAX_LENGTH).nullable(),
  dueDate: meetingTaskDueDateSchema,
  status: meetingTaskStatusSchema,
  revision: z.number().int().positive().default(1),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const assignedTaskPlacementSchema = z.object({
  sourceType: assignedTaskSourceTypeSchema,
  sourceTaskId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  assigneeUserId: z.string().uuid(),
  sectionId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  revision: z.number().int().positive().default(1),
  updatedByUserId: z.string().uuid().nullable(),
  updatedAt: z.string(),
});

/**
 * Pseudo-section id for tasks that live outside the viewer's personal board
 * placements (other people's tasks in the Others view). Matches the web
 * client's single personal pseudo-section.
 */
export const UNPLACED_ASSIGNED_TASK_SECTION_ID = "00000000-0000-4000-8000-000000000000";

export const unifiedAssignedTaskOwnerSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable(),
});

export const unifiedAssignedTaskSchema = z.object({
  sourceType: assignedTaskSourceTypeSchema,
  sourceId: z.string().uuid(),
  taskId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  /** The viewer's filing workspace; workspaceId remains the source's owning workspace. */
  viewerWorkspaceId: z.string().uuid().optional(),
  editable: z.boolean(),
  /** Whether the viewer may change this task's assignee. */
  reassignable: z.boolean().optional().default(false),
  deletable: z.boolean(),
  reorderable: z.boolean(),
  /** False for other people's tasks surfaced in the Others view. */
  isMine: z.boolean().optional().default(true),
  /** Populated for tasks assigned to someone else; null = mine or unassigned. */
  owner: unifiedAssignedTaskOwnerSchema.nullable().optional().default(null),
  title: z.string().trim().min(1).max(MEETING_TASK_TITLE_MAX_LENGTH),
  description: z.string().trim().min(1).max(MEETING_TASK_DESCRIPTION_MAX_LENGTH).nullable(),
  status: meetingTaskStatusSchema,
  dueDate: meetingTaskDueDateSchema,
  sectionId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  placementRevision: z.number().int().positive(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  sourceMeeting: z
    .object({
      id: z.string().uuid(),
      title: z.string().min(1),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
    })
    .nullable(),
});

export const assignedTaskContextSchema = assignedTaskSummarySchema.extend({
  summary: z
    .object({
      content: z.string().min(1),
      generatedAt: z.string(),
    })
    .nullable(),
  relatedDecisions: z.array(
    z.object({
      id: z.string().uuid(),
      text: z.string().min(1),
      finality: z.enum(["final", "tentative", "provisional"]),
    }),
  ),
  relatedActionItems: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string().min(1),
      description: z.string().min(1).nullable(),
    }),
  ),
});

export type MeetingTaskListStatus = z.infer<typeof meetingTaskListStatusSchema>;
export type MeetingTaskType = z.infer<typeof meetingTaskTypeSchema>;
export type MeetingTaskWorkKind = z.infer<typeof meetingTaskWorkKindSchema>;
export type MeetingTaskStatus = z.infer<typeof meetingTaskStatusSchema>;
export type MeetingTaskDetectionOrigin = z.infer<typeof meetingTaskDetectionOriginSchema>;
export type MeetingTaskStatusSource = z.infer<typeof meetingTaskStatusSourceSchema>;
export type MeetingTaskConfidence = z.infer<typeof meetingTaskConfidenceSchema>;
export type MeetingTaskActivityHints = z.infer<typeof meetingTaskActivityHintsSchema>;
export type MeetingTaskDiagnostics = z.infer<typeof meetingTaskDiagnosticsSchema>;
export type MeetingTaskProgress = z.infer<typeof meetingTaskProgressSchema>;
export type MeetingTaskSourceQuote = z.infer<typeof meetingTaskSourceQuoteSchema>;
export type DismissedMeetingTaskTombstone = z.infer<typeof dismissedMeetingTaskTombstoneSchema>;
export type MeetingTaskCompletion = z.infer<typeof meetingTaskCompletionSchema>;
export type MeetingTaskCandidate = z.infer<typeof meetingTaskCandidateSchema>;
export type MeetingTaskGeneration = z.infer<typeof meetingTaskGenerationSchema>;
export type MeetingTask = z.infer<typeof meetingTaskSchema>;
export type MeetingTaskList = z.infer<typeof meetingTaskListSchema>;
export type LiveMeetingTaskCandidateState = z.infer<typeof liveMeetingTaskCandidateStateSchema>;
export type LiveMeetingTaskEvidenceRole = z.infer<typeof liveMeetingTaskEvidenceRoleSchema>;
export type LiveMeetingTaskEvidence = z.infer<typeof liveMeetingTaskEvidenceSchema>;
export type LiveMeetingTaskCandidate = z.infer<typeof liveMeetingTaskCandidateSchema>;
export type LiveMeetingTaskInputSegment = z.infer<typeof liveMeetingTaskInputSegmentSchema>;
export type LiveMeetingTaskConfirmedTask = z.infer<typeof liveMeetingTaskConfirmedTaskSchema>;
export type LiveMeetingTaskDetectionInput = z.infer<typeof liveMeetingTaskDetectionInputSchema>;
export type LiveMeetingTaskOperation = z.infer<typeof liveMeetingTaskOperationSchema>;
export type LiveMeetingTaskDetection = z.infer<typeof liveMeetingTaskDetectionSchema>;
export type TaskRealtimeEvent = z.infer<typeof taskRealtimeEventSchema>;
export type TaskRealtimeEventName = z.infer<typeof taskRealtimeEventNameSchema>;
export type AssignedTaskSummary = z.infer<typeof assignedTaskSummarySchema>;
export type AssignedTaskContext = z.infer<typeof assignedTaskContextSchema>;
export type AssignedTaskSourceType = z.infer<typeof assignedTaskSourceTypeSchema>;
export type WorkspaceTaskSection = z.infer<typeof workspaceTaskSectionSchema>;
export type WorkspaceTask = z.infer<typeof workspaceTaskSchema>;
export type AssignedTaskPlacement = z.infer<typeof assignedTaskPlacementSchema>;
export type UnifiedAssignedTask = z.infer<typeof unifiedAssignedTaskSchema>;
