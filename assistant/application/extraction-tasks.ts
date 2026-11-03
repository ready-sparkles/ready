import {
  buildMeetingTaskLanguageContext,
  type DismissedMeetingTaskTombstone,
  dismissedMeetingTaskTombstoneSchema,
  estimateMeetingTaskInputTokens,
  MEETING_TASK_IDENTIFICATION_RULES,
  MEETING_TASKS_PROMPT_VERSION,
  type MeetingTaskCandidate,
  meetingTaskCandidateSchema,
  type MeetingTaskGeneration,
  meetingTaskGenerationSchema,
  meetingTaskLimitForParticipantCount,
  type MeetingTaskSourceQuote,
  openAIPromptCacheOptions,
  type VoiceSearchIdentityEvidence,
} from "@readymeet/shared";
import { z } from "zod";

import { formatLiveSummary, LIVE_SUMMARY_HANDOFF_RULES } from "../domain/extraction/live-summary";
import { VOICE_IDENTITY_INSTRUCTIONS, voiceIdentityMetadata } from "../domain/extraction/voice-search-identity";
import { assistantEnv } from "../ports/assistant-env";
import { openAIClientApiKey } from "../ports/openai-client";
import { createOpenAIClient, type OpenAIClient } from "../ports/openai-client";
import { withOpenAIRetry } from "../ports/openai-retry";

import { parsePossiblyMalformedJsonObject } from "./extraction-content";
import type { RunExtractionInput } from "./extraction-orchestrator";
import { participantOrganizationDomains } from "./extraction-snapshot";
import { parseResponseText } from "./openai-response-text";
import { executeMeteredOpenAIResponse } from "./usage-metering";

const SHORT_TASK_TRANSCRIPT_CHARS = 22_000;
const TASK_CHUNK_TARGET_CHARS = 12_000;
const TASK_CHUNK_OVERLAP_SEGMENTS = 2;
const PROCESS_ALL_CHUNKS_LIMIT = 32;
const MAX_SELECTED_LONG_CHUNKS = 32;
const TASK_LONG_MEETING_MIDDLE_SAMPLE_CHUNKS = 10;
const TASK_CHUNK_CONCURRENCY = 2;
const GENERAL_TASK_EXTRACTION_MAX_OUTPUT_TOKENS = 3200;
const PERSONAL_LIST_TASK_EXTRACTION_MAX_OUTPUT_TOKENS = 4000;
const TASK_RECONCILIATION_MAX_OUTPUT_TOKENS = 8000;
// The global pass returns every task for the whole meeting, and reasoning
// shares this budget. The cap only limits output; it costs nothing unless
// used, so leave room for busy meetings instead of truncating them.
const GLOBAL_TASK_VERIFICATION_MAX_OUTPUT_TOKENS = 32_000;
// A truncated response retries with a doubled budget, a bounded number of times.
const TASK_OUTPUT_TOKEN_RETRIES = 2;
const TASK_MAX_RETRY_OUTPUT_TOKENS = 64_000;
// The global verification pass reads the entire transcript in one call, so
// its timeout must scale with input size the way the snapshot's does. Stay
// under the API service's HTTP timeout for /tasks (default 260s).
const TASK_GLOBAL_VERIFICATION_TIMEOUT_MS_PER_50K_TOKENS = 15_000;
const TASK_GLOBAL_VERIFICATION_TIMEOUT_MAX_MS = 240_000;
const TASK_ESTIMATED_INPUT_TOKENS_PER_50K_CHUNK = 50_000;
const TASK_SOURCE_QUOTES_MAX_COUNT = 5;
const TASK_OUTPUT_RETRY_TOKEN_MULTIPLIER = 2;
const TASK_JSON_STRINGIFY_INDENT = 2;
const TASK_HINT_SCORE_MULTIPLIER = 3;
const TASK_PERSONAL_LIST_MAX_BLOCK_SEGMENTS = 9;
const TASK_PERSONAL_LIST_MAX_GAP_MS = 75_000;
const TASK_QUOTE_CONTEXT_SEGMENTS_BEFORE = 1;
const TASK_QUOTE_CONTEXT_SEGMENTS_AFTER = 2;
const TASK_QUOTE_CONTEXT_MAX_CHARS = 600;
const TASK_CHUNK_INDEX_OFFSET_FIRST = 1;
const TASK_CHUNK_INDEX_OFFSET_LAST = 2;

const TASK_MESSAGES = {
  incompleteResponse: (reason: string) => `Meeting tasks response was incomplete (${reason})`,
  parseFailed: "Meeting task output could not be parsed into supported task candidates.",
  openAiKeyRequired: "Configured AI provider key is required for meeting tasks",
  defaultSourceReason: "The transcript includes task or follow-up language.",
  normalizedModelOutput: "Normalized task model output",
  untitledMeeting: "Untitled meeting",
  noLanguageContext: "No whole-transcript language context was supplied. Default output language: English.",
  timedOut: (input: { label: string; timeoutMs: number }) => `${input.label} timed out after ${input.timeoutMs}ms`,
  droppedUnusableChunk: "Dropped unusable task chunk output",
  chunkParseFailed: "Task chunk output could not be parsed",
} as const;

const openAiResponseOutputSchema = z.object({
  output: z.array(z.unknown()).optional(),
  // OpenAI sends null for absent details; rejecting it would accept partial output.
  incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
  status: z.string().optional(),
});

export function globalTaskVerificationTimeoutMs(params: { estimatedInputTokens: number }): number {
  const scaled =
    assistantEnv().OPENAI_MEETING_TASKS_TIMEOUT_MS +
    Math.ceil(params.estimatedInputTokens / TASK_ESTIMATED_INPUT_TOKENS_PER_50K_CHUNK) *
      TASK_GLOBAL_VERIFICATION_TIMEOUT_MS_PER_50K_TOKENS;

  return Math.min(TASK_GLOBAL_VERIFICATION_TIMEOUT_MAX_MS, scaled);
}

const taskOutputSchema = z.object({
  items: z.array(z.unknown()).default([]),
});

type TaskParseRepairStats = {
  normalizedQuoteStrings: number;
  droppedCandidates: number;
  rawCandidateCount: number;
};

const ACTION_COMMITMENT_TERMS =
  /\b(i'?ll|i will|we'?ll|we will|can you|could you|please|you'?re on|own(?:ing)?|owner|take that on|start on|send|ship|fix|draft|prepare|schedule|assign|add it|follow up|follow-up|ping|sync with|review|deploy|create|build|investigate|look into|circle back|write|update|finish|complete|file|ticket)\b/gi;
const FINNISH_ACTION_COMMITMENT_TERMS =
  /\b(?:mä|minä|me)\s+(?:aion|aiomme|voin|voimme|laitan|laitamme|lähetän|lähetämme|teen|teemme|hoidan|hoidamme|selvitän|selvitämme|järjestän|järjestämme|varmistan|varmistamme|otan|otamme|aloitan|aloitamme|päivitän|päivitämme|kirjoitan|kirjoitamme|toimitan|toimitamme|korjaan|korjaamme|rakennan|rakennamme|valmistelen|valmistelemme)\b/giu;
const ISSUE_WORK_TERMS =
  /\b(bug|defect|regression|crash|error|exception|failure|failing|broken|incorrect|wrong|overflow|layout|spacing|timeout|race condition|sso|auth|api|database|frontend|backend|ci|deploy)\b/gi;

type TaskSegment = RunExtractionInput["transcript"][number];

type TaskChunk = {
  index: number;
  segments: TaskSegment[];
  text: string;
  taskHintScore: number;
};

export type MeetingTaskChunkExtractionInput = {
  voiceSearchIdentityEvidence?: VoiceSearchIdentityEvidence[];
  meetingId: string;
  metering?: {
    jobId?: string | null;
    workflowRunId?: string | null;
  } | null;
  title: string | null;
  participants: { userId?: string | null; name: string; email?: string | null; roleHint?: string | null }[];
  chunkIndex: number;
  totalChunks: number;
  taskHintScore: number;
  transcriptText: string;
  languageContext?: string;
  extractionMode?: "general" | "personal_list";
};

export type MeetingTaskReconciliationInput = {
  voiceSearchIdentityEvidence?: VoiceSearchIdentityEvidence[];
  meetingId: string;
  metering?: {
    jobId?: string | null;
    workflowRunId?: string | null;
  } | null;
  evidencePacket: unknown;
};

const TASK_CANDIDATE_OUTPUT_JSON_SCHEMA = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field. */
  additionalProperties: false,
  required: [
    "title",
    "description",
    "type",
    "workKind",
    "owner",
    "dueDate",
    "confidence",
    "completion",
    "sourceQuotes",
    "sourceReason",
  ],
  properties: {
    title: { type: "string" },
    description: { type: ["string", "null"] },
    type: { enum: ["action_item", "follow_up", "task", "decision_follow_up", "open_question"] },
    workKind: {
      enum: [
        "bug_or_issue",
        "implementation",
        "design",
        "research",
        "customer_follow_up",
        "sales_or_crm",
        "scheduling",
        "documentation",
        "general",
      ],
    },
    owner: {
      type: "object",
      /** @external OpenAI structured-output JSON schema wire field. */
      additionalProperties: false,
      required: ["name", "email", "confidence"],
      properties: {
        name: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        confidence: { enum: ["low", "medium", "high", null] },
      },
    },
    dueDate: {
      type: "object",
      /** @external OpenAI structured-output JSON schema wire field. */
      additionalProperties: false,
      required: ["value", "confidence"],
      properties: {
        value: { type: ["string", "null"] },
        confidence: { enum: ["low", "medium", "high", null] },
      },
    },
    confidence: { enum: ["low", "medium", "high"] },
    completion: {
      type: "object",
      /** @external OpenAI structured-output JSON schema wire field. */
      additionalProperties: false,
      required: ["completedDuringMeeting", "quote", "confidence"],
      properties: {
        /** @external OpenAI structured-output JSON schema wire field. */
        completedDuringMeeting: { type: "boolean" },
        quote: { type: ["string", "null"] },
        confidence: { enum: ["low", "medium", "high", null] },
      },
    },
    sourceQuotes: {
      type: "array",
      minItems: 1,
      maxItems: TASK_SOURCE_QUOTES_MAX_COUNT,
      items: {
        type: "object",
        /** @external OpenAI structured-output JSON schema wire field. */
        additionalProperties: false,
        required: ["quote", "speaker", "timestamp", "segmentId"],
        properties: {
          quote: { type: "string" },
          speaker: { type: ["string", "null"] },
          timestamp: { type: ["string", "null"] },
          segmentId: { type: ["string", "null"] },
        },
      },
    },
    sourceReason: { type: "string" },
  },
} as const;

const MEETING_TASKS_OUTPUT_JSON_SCHEMA = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field. */
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: { type: "array", items: TASK_CANDIDATE_OUTPUT_JSON_SCHEMA },
  },
} as const;

export interface MeetingTasksRunner {
  createTasks(input: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    maxOutputTokens?: number;
    signal?: AbortSignal;
    /** Called before a truncated response is retried with a larger budget. */
    onOutputBudgetRetry?: () => void;
    meetingId?: string | null;
    jobId?: string | null;
    workflowRunId?: string | null;
    operation?: string | null;
    responseSchema?: Record<string, unknown>;
    responseSchemaName?: string;
  }): Promise<string>;
}

class OpenAIMeetingTasksRunner implements MeetingTasksRunner {
  private readonly client: OpenAIClient;

  constructor(apiKey: string) {
    this.client = createOpenAIClient({ apiKey });
  }

  async createTasks(input: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    maxOutputTokens?: number;
    signal?: AbortSignal;
    /** Called before a truncated response is retried with a larger budget. */
    onOutputBudgetRetry?: () => void;
    meetingId?: string | null;
    jobId?: string | null;
    workflowRunId?: string | null;
    operation?: string | null;
    responseSchema?: Record<string, unknown>;
    responseSchemaName?: string;
  }) {
    const attemptCreate = async (params: { attempt: number; maxOutputTokens: number }): Promise<string> => {
      const { attempt, maxOutputTokens } = params;
      const response = await withOpenAIRetry({
        operation: () => {
          input.signal?.throwIfAborted();

          return executeMeteredOpenAIResponse({
            client: this.client,
            body: {
              model: input.model,
              ...openAIPromptCacheOptions(input.model),
              max_output_tokens: maxOutputTokens,
              ...(supportsReasoningEffort(input.model) ? { reasoning: { effort: "low" as const } } : {}),
              text: {
                format: {
                  type: "json_schema",
                  name: input.responseSchemaName ?? "meeting_tasks",
                  /** @external OpenAI structured-output JSON schema wire field */
                  strict: true,
                  schema: input.responseSchema ?? MEETING_TASKS_OUTPUT_JSON_SCHEMA,
                },
              },
              input: [
                {
                  role: "system",
                  content: input.systemPrompt,
                },
                {
                  role: "user",
                  content: input.userMessage,
                },
              ],
            },
            options: { signal: input.signal },
            meetingId: input.meetingId,
            jobId: input.jobId,
            workflowRunId: input.workflowRunId,
            source: "meeting_tasks",
            operation: input.operation ?? "generate_tasks",
          });
        },
      });

      const parsedResponse = openAiResponseOutputSchema.safeParse(response);
      if (parsedResponse.success && parsedResponse.data.status === "incomplete") {
        const reason = parsedResponse.data.incomplete_details?.reason ?? "unknown";
        if (
          reason === "max_output_tokens" &&
          attempt < TASK_OUTPUT_TOKEN_RETRIES &&
          maxOutputTokens < TASK_MAX_RETRY_OUTPUT_TOKENS
        ) {
          input.onOutputBudgetRetry?.();

          return attemptCreate({
            attempt: attempt + 1,
            maxOutputTokens: Math.min(
              maxOutputTokens * TASK_OUTPUT_RETRY_TOKEN_MULTIPLIER,
              TASK_MAX_RETRY_OUTPUT_TOKENS,
            ),
          });
        }
        throw new Error(TASK_MESSAGES.incompleteResponse(reason));
      }

      return parseResponseText(response);
    };

    return attemptCreate({
      attempt: 0,
      maxOutputTokens: input.maxOutputTokens ?? GENERAL_TASK_EXTRACTION_MAX_OUTPUT_TOKENS,
    });
  }
}

function supportsReasoningEffort(model: string) {
  return /^(gpt-5|o\d)/i.test(model);
}

function isAssistantLikeName(value: string) {
  return /\b(?:assistant|ready\s*agent|readymeet\s*assistant)\b/i.test(value);
}

function isHumanParticipant(participant: NonNullable<RunExtractionInput["metadata"]["participants"]>[number]) {
  const roleHint = participant.roleHint?.trim().toLowerCase();

  return roleHint !== "assistant" && roleHint !== "system" && !isAssistantLikeName(participant.name);
}

function isHumanTaskSegment(params: { input: RunExtractionInput; segment: TaskSegment }) {
  const { input, segment } = params;
  if (segment.speakerRole !== undefined) {
    return segment.speakerRole === "human";
  }

  const participant = (input.metadata.participants ?? []).find(
    (item) => normalizeForMatch(item.name) === normalizeForMatch(segment.speakerName),
  );

  if (participant !== undefined) {
    return isHumanParticipant(participant);
  }

  return !isAssistantLikeName(segment.speakerName);
}

function sortedTranscript(input: RunExtractionInput) {
  return input.transcript
    .filter((segment) => isHumanTaskSegment({ input, segment }))
    .sort((left, right) => {
      const startedAtDelta = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
      if (startedAtDelta !== 0) {
        return startedAtDelta;
      }

      return left.id.localeCompare(right.id);
    });
}

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

function countMatches(params: { text: string; regex: RegExp }) {
  const regex = new RegExp(params.regex.source, params.regex.flags);
  regex.lastIndex = 0;

  return Array.from(params.text.matchAll(regex)).length;
}

function scoreTaskHints(text: string) {
  return (
    (countMatches({ text, regex: ACTION_COMMITMENT_TERMS }) +
      countMatches({ text, regex: FINNISH_ACTION_COMMITMENT_TERMS })) *
      TASK_HINT_SCORE_MULTIPLIER +
    countMatches({ text, regex: ISSUE_WORK_TERMS })
  );
}

function formatSegment(segment: TaskSegment) {
  const timestamp = new Date(segment.startedAt).toISOString();

  return `[${timestamp}] (${segment.id}) ${segment.speakerName}: ${segment.content.replace(/\s+/g, " ").trim()}`;
}

function formatParticipants(input: RunExtractionInput) {
  const participants = (input.metadata.participants ?? []).filter(isHumanParticipant);

  return participants.length !== 0
    ? participants
        .map((participant) => {
          const email = participant.email?.trim() ?? "";

          return email !== "" ? `- ${participant.name} <${email}>` : `- ${participant.name}`;
        })
        .join("\n")
    : "- Unknown";
}

function isPersonalListIntroduction(value: string) {
  return (
    /\b(?:one of the (?:things|items) on )?my (?:task |to[- ]do |priority )?list\b/i.test(value) ||
    /\bmy (?:tasks?|to[- ]dos?|priorities)\b/i.test(value)
  );
}

function isBriefListAcknowledgement(value: string) {
  return /^(?:ok(?:ay)?|yeah|yep|yes|right|sure|got it|sounds good|mm[- ]?hmm|uh[- ]?huh)[.!?,\s]*$/i.test(
    value.trim(),
  );
}

function formatPersonalListEvidenceBlocks(segments: TaskSegment[]) {
  const blockState = segments.reduce<{ claimedSegmentIds: Set<string>; blocks: TaskSegment[][] }>(
    (accumulator, _segment, introIndex) => {
      const intro = segments.at(introIndex);
      if (
        intro === undefined ||
        accumulator.claimedSegmentIds.has(intro.id) ||
        !isPersonalListIntroduction(intro.content)
      ) {
        return accumulator;
      }

      const tailSegments = segments.slice(introIndex + 1);
      const blockResult = tailSegments.reduce<{
        block: TaskSegment[];
        claimed: Set<string>;
        shouldStop: boolean;
      }>(
        (inner, segment) => {
          if (inner.shouldStop || inner.block.length >= TASK_PERSONAL_LIST_MAX_BLOCK_SEGMENTS) {
            return inner;
          }
          if (
            new Date(segment.startedAt).getTime() - new Date(intro.startedAt).getTime() >
            TASK_PERSONAL_LIST_MAX_GAP_MS
          ) {
            return { ...inner, shouldStop: true };
          }
          if (
            normalizeForMatch(segment.speakerName) !== normalizeForMatch(intro.speakerName) &&
            !isBriefListAcknowledgement(segment.content)
          ) {
            return { ...inner, shouldStop: true };
          }

          const claimed = new Set(inner.claimed);
          claimed.add(segment.id);

          return {
            block: [...inner.block, segment],
            claimed,
            shouldStop: false,
          };
        },
        {
          block: [intro],
          claimed: new Set([...accumulator.claimedSegmentIds, intro.id]),
          shouldStop: false,
        },
      );

      return {
        claimedSegmentIds: blockResult.claimed,
        blocks: [...accumulator.blocks, blockResult.block],
      };
    },
    { claimedSegmentIds: new Set<string>(), blocks: [] },
  );

  return blockState.blocks.length !== 0
    ? blockState.blocks.map((block) => block.map(formatSegment).join("\n")).join("\n---\n")
    : null;
}

function humanParticipantCount(input: RunExtractionInput) {
  return (input.metadata.participants ?? []).filter(isHumanParticipant).length;
}

function mergeTaskExtractionLanes(params: {
  input: RunExtractionInput;
  generalItems: MeetingTaskCandidate[];
  personalListItems: MeetingTaskCandidate[];
}) {
  const { input, generalItems, personalListItems } = params;
  const limitedGeneralItems = generalItems.slice(0, meetingTaskLimitForParticipantCount(humanParticipantCount(input)));

  return personalListItems.reduce<MeetingTaskCandidate[]>(
    (merged, personalListItem) => {
      const title = normalizeForMatch(personalListItem.title);
      const personalOwner = normalizeForMatch(personalListItem.owner.name ?? "");
      const existingIndex = merged.findIndex((item) => {
        if (normalizeForMatch(item.title) !== title) {
          return false;
        }
        const existingOwner = normalizeForMatch(item.owner.name ?? "");

        return existingOwner === "" || existingOwner === personalOwner;
      });
      if (existingIndex < 0) {
        return [...merged, personalListItem];
      }

      const generalItem = merged.at(existingIndex);
      if (generalItem === undefined) {
        return [...merged, personalListItem];
      }

      const seenQuotes = new Set<string>();
      const sourceQuotes = [...generalItem.sourceQuotes, ...personalListItem.sourceQuotes].filter((quote) => {
        const key = normalizeForMatch(quote.quote);
        if (seenQuotes.has(key)) {
          return false;
        }
        seenQuotes.add(key);

        return true;
      });

      return merged.map((item, index) =>
        index === existingIndex
          ? {
              ...personalListItem,
              description: personalListItem.description ?? generalItem.description,
              sourceQuotes,
            }
          : item,
      );
    },
    [...limitedGeneralItems],
  );
}

function formatOrganizationDomainLines(participants: RunExtractionInput["metadata"]["participants"]) {
  const domains = participantOrganizationDomains(participants);

  return domains.length !== 0
    ? [`Participant organization domains (authoritative spelling for company and product names): ${domains.join(", ")}`]
    : [];
}

function formatTaskTranscript(params: { input: RunExtractionInput; segments?: TaskSegment[] }) {
  const segments = params.segments ?? sortedTranscript(params.input);
  const languageContext = buildMeetingTaskLanguageContext(segments.map((segment) => segment.content));
  const titleTrimmed = params.input.metadata.title?.trim() ?? "";

  return [
    `Meeting ID: ${params.input.meetingId}`,
    `Meeting title: ${titleTrimmed !== "" ? titleTrimmed : TASK_MESSAGES.untitledMeeting}`,
    `Known participants:\n${formatParticipants(params.input)}`,
    ...formatOrganizationDomainLines(params.input.metadata.participants),
    "Full-meeting language context (language selection only; never task evidence):",
    languageContext,
    "Transcript:",
    segments.map(formatSegment).join("\n"),
  ].join("\n");
}

function formatGlobalTaskVerificationInput(params: {
  input: RunExtractionInput;
  initialCandidates: MeetingTaskCandidate[];
  dismissedTombstones: DismissedMeetingTaskTombstone[];
  segments?: TaskSegment[];
}) {
  const segments = params.segments ?? sortedTranscript(params.input);
  const titleTrimmed = params.input.metadata.title?.trim() ?? "";

  return [
    `Meeting ID: ${params.input.meetingId}`,
    `Meeting title: ${titleTrimmed !== "" ? titleTrimmed : TASK_MESSAGES.untitledMeeting}`,
    `Known participants:\n${formatParticipants(params.input)}`,
    ...formatOrganizationDomainLines(params.input.metadata.participants),
    "Full-meeting language context (authoritative for language selection only; never task evidence):",
    buildMeetingTaskLanguageContext(segments.map((segment) => segment.content)),
    ...formatLiveSummary(params.input.liveSummary),
    "Preliminary candidates from the notes pass (hints only; verify, improve, remove, merge, split, or supplement them as the full transcript requires):",
    JSON.stringify(params.initialCandidates, null, TASK_JSON_STRINGIFY_INDENT),
    "User-dismissed live task tombstones (never return or recreate a semantic match, even if the transcript supports it):",
    JSON.stringify(params.dismissedTombstones, null, TASK_JSON_STRINGIFY_INDENT),
    "Entire human transcript (authoritative task evidence):",
    segments.map(formatSegment).join("\n"),
  ].join("\n");
}

function transcriptTextLength(segments: TaskSegment[]) {
  return segments.reduce((total, segment) => total + formatSegment(segment).length + 1, 0);
}

function buildTranscriptChunks(segments: TaskSegment[]) {
  const chunkState = segments.reduce<{ chunks: TaskChunk[]; current: TaskSegment[]; currentLength: number }>(
    (state, segment) => {
      const lineLength = formatSegment(segment).length + 1;
      if (state.current.length !== 0 && state.currentLength + lineLength > TASK_CHUNK_TARGET_CHARS) {
        const text = state.current.map(formatSegment).join("\n");
        const nextCurrent = state.current.slice(-TASK_CHUNK_OVERLAP_SEGMENTS);
        const flushed = {
          chunks: [
            ...state.chunks,
            {
              index: state.chunks.length,
              segments: state.current,
              text,
              taskHintScore: scoreTaskHints(text),
            },
          ],
          current: nextCurrent,
          currentLength: transcriptTextLength(nextCurrent),
        };

        return {
          chunks: flushed.chunks,
          current: [...flushed.current, segment],
          currentLength: flushed.currentLength + lineLength,
        };
      }

      return {
        ...state,
        current: [...state.current, segment],
        currentLength: state.currentLength + lineLength,
      };
    },
    { chunks: [], current: [], currentLength: 0 },
  );

  if (chunkState.current.length === 0) {
    return chunkState.chunks;
  }

  const text = chunkState.current.map(formatSegment).join("\n");

  return [
    ...chunkState.chunks,
    {
      index: chunkState.chunks.length,
      segments: chunkState.current,
      text,
      taskHintScore: scoreTaskHints(text),
    },
  ];
}

function selectTaskChunks(chunks: TaskChunk[]) {
  if (chunks.length <= PROCESS_ALL_CHUNKS_LIMIT) {
    return chunks;
  }

  const firstChunk = chunks.at(0);
  const lastChunk = chunks.at(-1);
  const selected = new Map<number, TaskChunk>();
  if (firstChunk !== undefined) {
    selected.set(firstChunk.index, firstChunk);
  }
  if (lastChunk !== undefined) {
    selected.set(lastChunk.index, lastChunk);
  }

  const middleIndexes = evenlySpacedChunkIndexes({
    startIndex: TASK_CHUNK_INDEX_OFFSET_FIRST,
    endIndex: chunks.length - TASK_CHUNK_INDEX_OFFSET_LAST,
    count: TASK_LONG_MEETING_MIDDLE_SAMPLE_CHUNKS,
  });
  const withMiddle = middleIndexes.reduce((map, index) => {
    if (map.size >= MAX_SELECTED_LONG_CHUNKS) {
      return map;
    }
    const chunk = chunks.at(index);
    if (chunk === undefined) {
      return map;
    }

    return new Map(map).set(chunk.index, chunk);
  }, selected);

  const hinted = [...chunks]
    .filter((chunk) => chunk.taskHintScore > 0)
    .sort((left, right) => {
      const scoreDelta = right.taskHintScore - left.taskHintScore;

      return scoreDelta !== 0 ? scoreDelta : left.index - right.index;
    });

  const withHints = hinted.reduce((map, chunk) => {
    if (map.size >= MAX_SELECTED_LONG_CHUNKS) {
      return map;
    }

    return new Map(map).set(chunk.index, chunk);
  }, withMiddle);

  return [...withHints.values()].sort((left, right) => left.index - right.index);
}

function evenlySpacedChunkIndexes(params: { startIndex: number; endIndex: number; count: number }) {
  const { startIndex, endIndex, count } = params;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();

  return trimmed !== "" ? trimmed : null;
}

function normalizeTaskQuote(params: { value: unknown; stats: TaskParseRepairStats }) {
  const { value, stats } = params;
  if (typeof value === "string") {
    stats.normalizedQuoteStrings += 1;

    return {
      quote: value,
      speaker: null,
      timestamp: null,
    };
  }

  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    quote: value.quote ?? value.excerpt ?? value.text,
    speaker: value.speaker ?? value.speakerName ?? null,
    timestamp: value.timestamp ?? value.startedAt ?? null,
  };
}

function normalizeTaskOwnerRecord(value: Record<string, unknown>): Record<string, unknown> {
  const ownerInput = value.owner;
  const owner: Record<string, unknown> = isRecord(ownerInput)
    ? ownerInput
    : typeof ownerInput === "string"
      ? {
          name: ownerInput,
          email: null,
          confidence: "medium",
        }
      : {
          name: value.ownerName ?? value.owner_name ?? null,
          email: value.ownerEmail ?? value.owner_email ?? null,
          confidence: value.ownerConfidence ?? value.owner_confidence ?? null,
        };

  return {
    ...owner,
    name: stringOrNull(owner.name),
    email: stringOrNull(owner.email),
    confidence: owner.confidence ?? null,
  };
}

function normalizeTaskDueDateRecord(value: Record<string, unknown>): Record<string, unknown> {
  const dueDateInput = value.dueDate ?? value.due_date;
  const dueDate: Record<string, unknown> = isRecord(dueDateInput)
    ? dueDateInput
    : typeof dueDateInput === "string"
      ? {
          value: dueDateInput,
          confidence: "medium",
        }
      : {
          value: value.dueDateValue ?? value.due_date_value ?? null,
          confidence: value.dueDateConfidence ?? value.due_date_confidence ?? null,
        };

  return {
    ...dueDate,
    value: stringOrNull(dueDate.value),
    confidence: dueDate.confidence ?? null,
  };
}

function normalizeTaskCompletionRecord(value: Record<string, unknown>) {
  const completionInput = value.completion;
  const completedDuringMeeting = isRecord(completionInput)
    ? (completionInput.completedDuringMeeting ?? completionInput.completed_during_meeting)
    : (value.completedDuringMeeting ?? value.completed_during_meeting);
  const completionQuote = isRecord(completionInput)
    ? stringOrNull(completionInput.quote ?? completionInput.evidence)
    : null;
  const completionConfidence = isRecord(completionInput) ? completionInput.confidence : null;
  const isCompletedDuringMeeting = completedDuringMeeting === true || completedDuringMeeting === "true";

  return {
    /** @external Meeting task JSON schema wire field. */
    completedDuringMeeting: isCompletedDuringMeeting,
    quote: completionQuote,
    // Coerce off-enum confidence to null so a quirk in this field never
    // drops an otherwise-valid candidate; validation downgrades weak
    // completions anyway.
    confidence:
      completionConfidence === "low" || completionConfidence === "medium" || completionConfidence === "high"
        ? completionConfidence
        : null,
  };
}

function normalizeTaskSourceQuotes(params: { value: Record<string, unknown>; stats: TaskParseRepairStats }) {
  const sourceQuotes = params.value.sourceQuotes ?? params.value.source_quotes ?? params.value.evidence ?? [];

  return Array.isArray(sourceQuotes)
    ? sourceQuotes
        .slice(0, TASK_SOURCE_QUOTES_MAX_COUNT)
        .map((quote) => normalizeTaskQuote({ value: quote, stats: params.stats }))
    : [];
}

function normalizeTaskCandidate(params: { value: unknown; stats: TaskParseRepairStats }) {
  const { value, stats } = params;
  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    title: value.title ?? value.taskTitle ?? value.task_title,
    description: value.description ?? null,
    type: value.type ?? "task",
    workKind: value.workKind ?? value.work_kind ?? "general",
    owner: normalizeTaskOwnerRecord(value),
    dueDate: normalizeTaskDueDateRecord(value),
    confidence: value.confidence ?? "medium",
    completion: normalizeTaskCompletionRecord(value),
    sourceQuotes: normalizeTaskSourceQuotes({ value, stats }),
    sourceReason: value.sourceReason ?? value.source_reason ?? value.reason ?? TASK_MESSAGES.defaultSourceReason,
  };
}

function parseTaskCandidatesWithDiagnostics(params: { raw: string; context: { meetingId: string; phase: string } }) {
  const { raw, context } = params;
  const parsedRoot = (() => {
    try {
      return parsePossiblyMalformedJsonObject(raw);
    } catch (error) {
      void error;
      throw new Error(TASK_MESSAGES.parseFailed);
    }
  })();

  const parsedResult = taskOutputSchema.safeParse(parsedRoot);
  if (!parsedResult.success) {
    throw new Error(TASK_MESSAGES.parseFailed);
  }

  const parsed = parsedResult.data;
  const stats: TaskParseRepairStats = {
    normalizedQuoteStrings: 0,
    droppedCandidates: 0,
    rawCandidateCount: parsed.items.length,
  };
  const items = parsed.items.reduce<MeetingTaskCandidate[]>((accepted, candidate) => {
    const normalized = normalizeTaskCandidate({ value: candidate, stats });
    const result = meetingTaskCandidateSchema.safeParse(normalized);
    if (result.success) {
      return [...accepted, result.data];
    }
    stats.droppedCandidates += 1;

    return accepted;
  }, []);

  if (stats.normalizedQuoteStrings > 0 || stats.droppedCandidates > 0) {
    console.error(
      JSON.stringify({
        level: "info",
        component: "meeting-tasks",
        message: TASK_MESSAGES.normalizedModelOutput,
        meetingId: context.meetingId,
        phase: context.phase,
        taskPromptVersion: MEETING_TASKS_PROMPT_VERSION,
        normalizedQuoteStrings: stats.normalizedQuoteStrings,
        droppedCandidates: stats.droppedCandidates,
        acceptedCandidates: items.length,
      }),
    );
  }

  if (parsed.items.length !== 0 && items.length === 0) {
    throw new Error(TASK_MESSAGES.parseFailed);
  }

  return {
    items,
    diagnostics: {
      schemaDroppedCandidateCount: stats.droppedCandidates,
      normalizedQuoteStringCount: stats.normalizedQuoteStrings,
      rawCandidateCount: stats.rawCandidateCount,
    },
  };
}

function parseTaskCandidates(params: { raw: string; context: { meetingId: string; phase: string } }) {
  return parseTaskCandidatesWithDiagnostics(params).items;
}

function asGeneration(params: {
  items: MeetingTaskCandidate[];
  taskModel: string;
  diagnostics?: MeetingTaskGeneration["diagnostics"];
}): MeetingTaskGeneration {
  const { items, taskModel, diagnostics } = params;

  return meetingTaskGenerationSchema.parse({
    taskModel,
    taskPromptVersion: MEETING_TASKS_PROMPT_VERSION,
    items,
    diagnostics,
  });
}

async function runTimedTaskModel(params: {
  runner: MeetingTasksRunner;
  input: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    maxOutputTokens?: number;
    label: string;
    meetingId?: string | null;
    jobId?: string | null;
    workflowRunId?: string | null;
    operation?: string | null;
    timeoutMs?: number;
    /** Total deadline, measured from the start, once a truncated response is retried. */
    outputRetryTimeoutMs?: number;
    responseSchema?: Record<string, unknown>;
    responseSchemaName?: string;
  };
}) {
  const { runner, input } = params;
  const startedAt = Date.now();
  const deadlineState = {
    timeoutMs: input.timeoutMs ?? assistantEnv().OPENAI_MEETING_TASKS_TIMEOUT_MS,
    timeoutId: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  const controller = new AbortController();
  const rejectState: { reject: ((error: Error) => void) | undefined } = { reject: undefined };
  const timeout = new Promise<never>((_, reject) => {
    rejectState.reject = reject;
  });
  const armDeadline = () => {
    clearTimeout(deadlineState.timeoutId);
    deadlineState.timeoutId = setTimeout(
      () => {
        const error = new Error(TASK_MESSAGES.timedOut({ label: input.label, timeoutMs: deadlineState.timeoutMs }));
        rejectState.reject?.(error);
        controller.abort(error);
      },
      Math.max(0, deadlineState.timeoutMs - (Date.now() - startedAt)),
    );
    deadlineState.timeoutId.unref();
  };
  armDeadline();
  // A larger-budget retry has to generate more than the attempt that was cut
  // off, so it needs more time than the first attempt's deadline leaves.
  const onOutputBudgetRetry =
    input.outputRetryTimeoutMs !== undefined && input.outputRetryTimeoutMs > deadlineState.timeoutMs
      ? () => {
          deadlineState.timeoutMs = input.outputRetryTimeoutMs ?? deadlineState.timeoutMs;
          armDeadline();
        }
      : undefined;
  try {
    const raw = await Promise.race([
      runner.createTasks({
        model: input.model,
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        maxOutputTokens: input.maxOutputTokens,
        signal: controller.signal,
        onOutputBudgetRetry,
        meetingId: input.meetingId,
        jobId: input.jobId,
        workflowRunId: input.workflowRunId,
        operation: input.operation,
        responseSchema: input.responseSchema,
        responseSchemaName: input.responseSchemaName,
      }),
      timeout,
    ]);

    return { raw, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(deadlineState.timeoutId);
  }
}

async function runTaskModel(params: {
  runner: MeetingTasksRunner;
  input: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    maxOutputTokens?: number;
    label: string;
    meetingId?: string | null;
    jobId?: string | null;
    workflowRunId?: string | null;
    operation?: string | null;
  };
}) {
  return (await runTimedTaskModel(params)).raw;
}

async function mapWithConcurrency<T, R>(params: {
  items: T[];
  concurrency: number;
  mapper: (input: { item: T; index: number }) => Promise<R>;
}) {
  const { items, concurrency, mapper } = params;
  const batchStarts = Array.from(
    { length: Math.ceil(items.length / concurrency) },
    (_, batchIndex) => batchIndex * concurrency,
  );
  const batched = await Promise.all(
    batchStarts.map(async (startIndex) =>
      Promise.all(
        items
          .slice(startIndex, startIndex + concurrency)
          .map((item, offset) => mapper({ item, index: startIndex + offset })),
      ),
    ),
  );

  return batched.flat();
}

function sourceQuoteKey(quote: Pick<MeetingTaskSourceQuote, "quote">) {
  return normalizeForMatch(quote.quote);
}

function sourceQuoteMatchesText(params: { source: string; evidence: string }) {
  const sourceText = normalizeForMatch(params.source);
  const evidenceText = normalizeForMatch(params.evidence);

  return evidenceText !== "" && (sourceText.includes(evidenceText) || evidenceText.includes(sourceText));
}

function sourceQuoteTimestampMatches(params: { timestamp: string; segmentTimestamp: string }) {
  const { timestamp, segmentTimestamp } = params;
  const quoteTime = Date.parse(timestamp);
  const segmentTime = Date.parse(segmentTimestamp);
  if (Number.isFinite(quoteTime) && Number.isFinite(segmentTime)) {
    return quoteTime === segmentTime;
  }

  return normalizeForMatch(timestamp) === normalizeForMatch(segmentTimestamp);
}

function findSegmentForQuote(params: { quote: MeetingTaskSourceQuote; segments: TaskSegment[] }) {
  const { quote, segments } = params;
  if (quote.segmentId !== null && quote.segmentId !== undefined && quote.segmentId !== "") {
    const segment = segments.find((candidate) => candidate.id === quote.segmentId);

    return segment !== undefined && sourceQuoteMatchesText({ source: segment.content, evidence: quote.quote })
      ? segment
      : null;
  }

  const quoteTimestamp = quote.timestamp;
  const quoteSpeaker = quote.speaker;
  const matches = segments
    .filter((segment) => sourceQuoteMatchesText({ source: segment.content, evidence: quote.quote }))
    .filter((segment) => {
      if (quoteTimestamp === null || quoteTimestamp === "") {
        return true;
      }

      return sourceQuoteTimestampMatches({ timestamp: quoteTimestamp, segmentTimestamp: segment.startedAt });
    })
    .filter((segment) => {
      if (quoteSpeaker === null || quoteSpeaker === "") {
        return true;
      }

      return normalizeForMatch(segment.speakerName) === normalizeForMatch(quoteSpeaker);
    });

  return matches.length === 1 ? (matches.at(0) ?? null) : null;
}

function contextWindowForQuote(params: { quote: MeetingTaskSourceQuote; segments: TaskSegment[] }) {
  const { quote, segments } = params;
  const matchedSegment = findSegmentForQuote({ quote, segments });
  const index = matchedSegment !== null ? segments.findIndex((segment) => segment.id === matchedSegment.id) : -1;
  if (index < 0) {
    return [];
  }

  return segments
    .slice(
      Math.max(0, index - TASK_QUOTE_CONTEXT_SEGMENTS_BEFORE),
      Math.min(segments.length, index + TASK_QUOTE_CONTEXT_SEGMENTS_AFTER),
    )
    .map((segment) => ({
      segmentId: segment.id,
      speaker: segment.speakerName,
      timestamp: segment.startedAt,
      text: segment.content.replace(/\s+/g, " ").trim().slice(0, TASK_QUOTE_CONTEXT_MAX_CHARS),
    }));
}

function enrichCandidateQuotes(params: {
  candidate: MeetingTaskCandidate;
  segments: TaskSegment[];
}): MeetingTaskCandidate {
  const { candidate, segments } = params;

  return {
    ...candidate,
    sourceQuotes: candidate.sourceQuotes.map((quote) => {
      const matchedSegment = findSegmentForQuote({ quote, segments });

      return {
        quote: quote.quote,
        speaker: matchedSegment?.speakerName ?? quote.speaker ?? null,
        timestamp: matchedSegment?.startedAt ?? quote.timestamp ?? null,
        segmentId: matchedSegment?.id ?? null,
      };
    }),
  };
}

function filterTasksToKnownEvidence(params: { items: MeetingTaskCandidate[]; knownQuotes: MeetingTaskSourceQuote[] }) {
  const { items, knownQuotes } = params;
  const known = new Set(knownQuotes.map(sourceQuoteKey));

  return items
    .map((item) => ({
      ...item,
      sourceQuotes: item.sourceQuotes.filter((quote) => known.has(sourceQuoteKey(quote))),
    }))
    .filter((item) => item.sourceQuotes.length !== 0);
}

function buildEvidencePacket(params: { input: RunExtractionInput; candidates: MeetingTaskCandidate[] }) {
  const { input, candidates } = params;
  const segments = sortedTranscript(input);

  return {
    meeting: {
      id: input.meetingId,
      title: (() => {
        const titleTrimmed = input.metadata.title?.trim() ?? "";

        return titleTrimmed !== "" ? titleTrimmed : TASK_MESSAGES.untitledMeeting;
      })(),
      participants: input.metadata.participants ?? [],
    },
    fullTranscriptLanguageContext: buildMeetingTaskLanguageContext(segments.map((segment) => segment.content)),
    candidates: candidates.map((candidate, index) => ({
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
        context: contextWindowForQuote({ quote, segments }),
      })),
    })),
  };
}

const MEETING_TASKS_PROMPT_PREFIX = `You generate native Ready Tasks from a meeting transcript.

${LIVE_SUMMARY_HANDOFF_RULES}

Return JSON only. Do not include markdown, commentary, or explanations outside JSON.

Shape:
{
  "items": [
    {
      "title": string,
      "description": string | null,
      "type": "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question",
      "workKind": "bug_or_issue" | "implementation" | "design" | "research" | "customer_follow_up" | "sales_or_crm" | "scheduling" | "documentation" | "general",
      "owner": { "name": string | null, "email": string | null, "confidence": "low" | "medium" | "high" | null },
      "dueDate": { "value": string | null, "confidence": "low" | "medium" | "high" | null },
      "confidence": "low" | "medium" | "high",
      "completion": { "completedDuringMeeting": boolean, "quote": string | null, "confidence": "low" | "medium" | "high" | null },
      "sourceQuotes": [{ "quote": string, "speaker": string | null, "timestamp": string | null, "segmentId": string | null }],
      "sourceReason": string
    }
  ]
}
`;

const MEETING_TASKS_PROMPT_TASK_RULES = `Task rules:
${MEETING_TASK_IDENTIFICATION_RULES}
- Infer the majority language from the entire human transcript. Judge the full body of meaningful human speech, not the opening lines or the first coherent utterances.
- Use a non-English language only when it has a clear majority across the meaningful human transcript. A few isolated lines, a front-loaded cluster, greetings, background speech, or transcription artifacts do not establish a majority.
- If there is no clear majority language, write every user-facing field in English: title, description, and sourceReason.
- If there is a clear majority language, write all user-facing fields in that language. Do not translate the tasks into another language. If the human transcript is predominantly English, every title, description, and sourceReason must be English.
- For a mixed-language transcript, compare all substantive human speech across the full transcript. Never let a short cluster at the beginning outweigh the language used by most of the conversation.
- When a Full-meeting language context is supplied, use it as the authoritative whole-transcript view for language selection. It is not task evidence and must never change which tasks you extract.
- Keep every user-facing field consistently in that language. Never insert words from unrelated languages or scripts.
- Preserve sourceQuotes exactly as written in the transcript, even when they are in a different language from the task title.
- Preserve proper nouns, product names, company names, and common domain terms such as "seed", "SAFE", "letter of intent", "Outlook", or "MCP" as they naturally appeared.
- Participant organization domains, when provided, are the authoritative spelling for the company and product names of the people in the meeting. Use those spellings in title, description, and sourceReason. Never change sourceQuotes.
- Bugs, product issues, regressions, and implementation issues can be Ready Tasks when the transcript contains an explicit assignment, commitment, agreed near-term follow-up, or explicit request to fix or change the concrete observed problem. Set workKind to "bug_or_issue" or "implementation" as appropriate.
- For a small or medium meeting, aim for a compact list of the most important follow-through, usually 3 to 7 tasks.
- A long meeting with four or fewer human participants is still a small meeting: return no more than 7 tasks.
- For larger meetings with five or more human participants, allow more tasks only when there are clearly separate owners or outcomes. Do not compress away a real commitment just to stay under a small fixed count.
- Use exact quote text from the transcript. Do not paraphrase sourceQuotes.
- Every sourceQuotes object must include the exact segmentId printed beside that quote in the transcript. Copy it exactly; never invent an ID or attach a quote to a different occurrence of repeated text.
- sourceQuotes must always be an array of objects, never strings.
- If there are no real tasks or follow-ups, return { "items": [] }.`;

const MEETING_TASKS_PROMPT_FIELD_AND_COMPLETION_RULES = `Field rules:
- title should be concise and action-oriented.
- description should add useful context, or null if the title is enough.
- Prefer the best-supported likely owner over null. Determine ownership from the entire transcript and compare all known participants before deciding.
- When assigning an owner, copy that person's exact name and email from Known participants. Never invent a participant.
- Use owner confidence high only for an explicit assignment, accepted request, named commitment, or first-person commitment whose action and object match the task.
- Use owner confidence medium when one participant is the strong contextual owner: they control the required system or account, own the relevant workstream, are directly addressed about the work and continue that topic, or explicitly own closely related setup.
- Use owner confidence low when one participant remains more plausible than every alternative based on established role, responsibility, or conversational context. Use null only for a real tie or no participant-specific direction.
- Distinguish the performer from the requester, recipient, beneficiary, and downstream actor. “I need GitHub access, then I can start” makes the speaker the recipient of access, not the owner of granting it.
- In a compound segment, an “I can” or “I will” clause proves ownership only for the action in that clause. Do not transfer it to a different action elsewhere in the segment.
- For collective “we” commitments, infer the most likely individual when the transcript establishes one participant's relevant responsibility; otherwise leave the owner null.
- A participant name, speaker label, or the fact that a participant spoke the task quote is not enough by itself. Contextual inference requires comparative evidence that makes that person more plausible than the alternatives.
- Include every exact quote needed to support the ownership judgment, even when an ownership-context quote does not independently qualify the task.
- sourceReason must state whether ownership is explicit or inferred and briefly explain the basis. Never claim ownership is unknown or unaccepted while returning a named owner.
- dueDate.value must be null unless the date phrase directly modifies the task itself. A nearby launch, meeting, customer-arrival, or other event date is context, not the task's due date, unless the transcript explicitly links them. Use the meeting phrase, such as "Friday" or "next week", instead of resolving to a calendar date.
- confidence should reflect how clearly the transcript supports the task.
- sourceReason should briefly and accurately name the assignment, commitment, agreement, or concrete fix/change request that qualifies the task and the explicit or inferred owner basis; never claim evidence that sourceQuotes do not show.
- Never create external tasks.
- Never mention Linear unless Linear is explicitly discussed in the meeting.

Completion rules:
- Set completion.completedDuringMeeting to true only when the transcript clearly shows the task was finished during the meeting itself, such as "done, just sent it", "I fixed it while we were talking", or a later confirmation that the deliverable now exists.
- completion.quote must be the exact transcript quote that shows the completion. If there is no such quote, completedDuringMeeting must be false and quote must be null.
- A promise to do the work, starting the work, or partial progress does not count as completion.
- Still include the task when it was completed during the meeting; the completion flag records that it is already done rather than omitting it.`;

export function buildMeetingTasksPrompt(): string {
  return [
    MEETING_TASKS_PROMPT_PREFIX,
    MEETING_TASKS_PROMPT_TASK_RULES,
    MEETING_TASKS_PROMPT_FIELD_AND_COMPLETION_RULES,
  ].join("\n\n");
}

export function buildGlobalMeetingTaskVerificationPrompt(): string {
  return `${buildMeetingTasksPrompt()}

Global verification mode:
- This is the single final task pass for the meeting. You receive the entire human transcript and the preliminary candidates produced with the notes.
- Treat preliminary candidates as useful hints, never as truth or as a closed list. Verify every field against the transcript, remove unsupported candidates, repair scope/owner/due-date/completion mistakes, merge duplicates, split mixed-owner work, and recover any important explicit commitment the first pass missed.
- Read the full transcript before finalizing. Connect evidence across distant parts of the meeting, including an issue described early and an owner or completion confirmed later.
- For each final item, independently verify: (1) promotion into real post-meeting work, (2) exact scope, (3) owner, (4) due date, and (5) whether it was already completed.
- Re-evaluate ownership from the entire transcript. Prefer the best-supported explicit or inferred owner over null, calibrate owner confidence, and add the exact contextual quotes that support the decision.
- When a participant explicitly introduces "my list", "my tasks", "my to-dos", or "my priorities", audit the complete bounded list and preserve every distinct actionable item owned by that participant. The general compact-list target must not silently drop explicit personal-list commitments.
- Every final task must include exact supporting sourceQuotes from the entire human transcript. Candidate evidence that is absent from the transcript is invalid.
- For every final source quote, copy the exact segmentId printed beside that occurrence in the transcript. Repeated text from different segments is not interchangeable.
- Return the best compact final task list for the meeting, ordered by post-meeting importance. If no candidate survives and the transcript contains no other qualifying work, return { "items": [] }.
- User-dismissed live task tombstones are authoritative negative constraints. Never return or recreate a semantic match for one.
- Do not mention this verification process in any user-facing field.`;
}

function buildChunkTaskPrompt() {
  return `${buildMeetingTasksPrompt()}

Chunk mode:
- Extract candidates only from this transcript chunk.
- Select the output language from the Full-meeting language context, not from the local transcript chunk. That context is language evidence only and must not be used to infer a task, owner, scope, deadline, or surrounding conversation.
- It is acceptable for a candidate to be incomplete when the chunk only contains part of the evidence, such as a bug description without the later owner assignment.
- Use the exact quote that supports the candidate so a later reconciliation step can merge related evidence across chunks.
- Do not infer context from outside this chunk.`;
}

export function buildPersonalListTaskPrompt(): string {
  return `${buildMeetingTasksPrompt()}

Personal-list mode:
- The input contains only bounded transcript blocks introduced by an explicit phrase such as "my list", "my tasks", "my to-dos", or "my priorities".
- In this scoped mode, that introduction is commitment evidence. Audit each complete block and return every distinct actionable list item; do not sample or rank. The general 3-to-7 target and seven-task maximum do not apply within these bounded blocks.
- Assign each item to the participant who identifies the list as their own.
- REQUIRED: include the exact list-introduction quote and the exact item quote in sourceQuotes when they are separate transcript segments.
- Do not create tasks from content outside these bounded blocks, and do not add wishes or goals unless the speaker presents them as items on the list.
- Merge only duplicate phrasings of the same owner and outcome. Do not merge separate list items merely to shorten the result.`;
}

export function buildMeetingTaskReconciliationPrompt(): string {
  return `You reconcile native Ready Task candidates from a long meeting.

Return JSON only. Do not include markdown, commentary, or explanations outside JSON.

Use this output shape:
{
  "items": [
    {
      "title": string,
      "description": string | null,
      "type": "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question",
      "workKind": "bug_or_issue" | "implementation" | "design" | "research" | "customer_follow_up" | "sales_or_crm" | "scheduling" | "documentation" | "general",
      "owner": { "name": string | null, "email": string | null, "confidence": "low" | "medium" | "high" | null },
      "dueDate": { "value": string | null, "confidence": "low" | "medium" | "high" | null },
      "confidence": "low" | "medium" | "high",
      "completion": { "completedDuringMeeting": boolean, "quote": string | null, "confidence": "low" | "medium" | "high" | null },
      "sourceQuotes": [{ "quote": string, "speaker": string | null, "timestamp": string | null, "segmentId": string | null }],
      "sourceReason": string
    }
  ]
}

Rules:
- You receive a compact evidence packet, not the full transcript.
- Produce the final clean task list by deduping repeated candidates, merging related fragments, and reordering by post-meeting importance.
- Connect long-range context when evidence supports it, such as an issue described early and an owner assigned later.
- Audit every candidate in two passes: first identify the exact promotion evidence that makes it post-meeting work, then validate owner, scope, and due date against that evidence. Omit the candidate if the first pass finds no promotion evidence.
- Do not create a task unless it cites one or more exact sourceQuotes from the evidence packet.
- Copy quote, speaker, timestamp, and segmentId from the selected evidence object exactly. Never move repeated quote text to a different segment or invent a segmentId.
- sourceQuotes must always be an array of objects, never strings.
- Infer owners only from comparative evidence in the packet; do not invent due dates, accounts, systems, or root causes.
- Keep every user-facing field in one consistent language; never insert words from unrelated languages or scripts.
- Select the output language from fullTranscriptLanguageContext, which represents the entire human transcript. Do not infer it from the candidate evidence, an individual source quote, or the order of candidates.
- Use a non-English language only when fullTranscriptLanguageContext shows a clear majority for it. If there is no clear majority, write title, description, and sourceReason in English.
- Otherwise write those fields in the clear majority language. Do not translate the tasks into another language.
- fullTranscriptLanguageContext is language evidence only. Never use its sampled text to create, merge, expand, prioritize, or otherwise alter a task.
- Preserve sourceQuotes exactly as provided in the evidence packet.
- Preserve proper nouns, product names, company names, and common domain terms such as "seed", "SAFE", "letter of intent", "Outlook", or "MCP" as they naturally appeared.
- Participant email domains in the evidence packet are the authoritative spelling for the company and product names of the people in the meeting. Use those spellings in title, description, and sourceReason. Never change sourceQuotes.
- If several candidates are actually one piece of work or one outcome, merge them into one task with the combined evidence.
- Merge by outcome rather than by title wording.
- A product, roadmap, planning, or sprint meeting does not turn every product idea into a task. Keep a feature, desired capability, known bug, user need, or workstream only when its evidence explicitly promotes it into current work through an assignment, accepted commitment, agreed near-term action, an explicit request to fix or change a concrete observed problem, or an agreement to add or prioritize it in a named sprint, backlog, or plan.
- Wording such as "this needs to be fixed", "that's another thing to fix here", or "we should fix/change this" is valid promotion evidence when it clearly refers to a concrete observed problem. Infer its owner only from separate explicit or contextual responsibility evidence.
- An exploratory question such as "can we make this faster?" is not promotion evidence by itself. If it accompanies an explicit fix/change statement, the statement—not the question—must qualify the task.
- A plain observation that a bug exists remains insufficient when the evidence never asks to fix, change, investigate, or otherwise act on it.
- Priority and context are not promotion evidence. Statements such as "we need this soon", "the third workstream is X", "there is a bug list", or "users arrive next week" remain discussion unless the evidence also shows an agreement to act.
- Never invent an "add to backlog" task when the evidence does not identify a real backlog or planning artifact.
- Omit candidates that are only requests to the in-meeting AI assistant for immediate help when the assistant attempts or completes the request during the meeting.
- Omit candidates sourced from assistant-authored transcript segments.
- Omit candidates that are generic topics, advice, solution descriptions, existing behavior, weak speculation, roadmap possibilities, or work explicitly deferred to a later phase.
- Keep a qualifying task that was completed during the meeting and mark completion.completedDuringMeeting true when an exact completion quote proves the whole task was finished.
- A source quote that merely describes a feature or problem does not prove a task. Keep a candidate only when its evidence shows an explicit human commitment, assignment, agreed near-term follow-up, or explicit request to fix or change the concrete observed problem.
- Do not inflate scope. Evidence that someone will review an existing bug list does not prove a commitment to create the list or fix every bug.
- Prefer fewer high-quality tasks over noisy completeness. A strong final list is usually 3 to 7 tasks for small or medium meetings.
- Meeting duration does not determine meeting size. When the evidence packet has four or fewer human participants, return no more than 7 tasks.
- For meetings with five or more human participants, it is okay to return 8 to 15 tasks when each task has a distinct owner, outcome, or follow-up thread.
- Do not merge unrelated commitments from different owners just to keep the list short.
- Do not merge different outcomes owned by different people. Ownership evidence must cover the whole merged outcome; otherwise split the work.
- Prefer the best-supported likely owner over null. Use high confidence for explicit ownership, medium for strong contextual responsibility, and low when one participant is still more plausible than every alternative. Use null only for a real tie or no participant-specific direction.
- Distinguish the performer from the requester, recipient, beneficiary, or downstream actor. A participant who needs access is not thereby responsible for granting it.
- A participant name, speaker label, or the fact that a participant spoke a quote is not enough by itself. Offering contact details or another input does not make that speaker the owner of the broader follow-up.
- A vague or pronoun-only offer proves ownership only for the specific outcome named in that quote. In compound segments, never transfer an “I can” clause to a different action.
- Keep dueDate.value null when a date belongs to a nearby meeting, launch, customer arrival, or other event rather than directly modifying the task.
- sourceReason must identify whether the owner is explicit or inferred and why. Never let it contradict the returned owner or claim evidence absent from sourceQuotes.
- Put the primary follow-through first: the task that most directly advances the relationship, deal, proposal, decision, or project after the meeting.
- Prioritize explicit commitments made during the wrap-up or final quarter of the meeting over earlier exploratory possibilities.
- Preserve completion.completedDuringMeeting from a candidate only when its evidence contains an exact quote showing the task was finished during the meeting, and carry that quote in completion.quote. When merging candidates, the merged task is completed only if the completion evidence covers the whole piece of work.`;
}

function buildChunkUserMessage(params: {
  input: RunExtractionInput;
  chunk: TaskChunk;
  totalChunks: number;
  languageContext: string;
}) {
  const { input, chunk, totalChunks, languageContext } = params;
  const titleTrimmed = input.metadata.title?.trim() ?? "";

  return [
    `Meeting ID: ${input.meetingId}`,
    `Meeting title: ${titleTrimmed !== "" ? titleTrimmed : TASK_MESSAGES.untitledMeeting}`,
    `Known participants:\n${formatParticipants(input)}`,
    ...formatOrganizationDomainLines(input.metadata.participants),
    "Full-meeting language context (language selection only; never task evidence):",
    languageContext,
    `Transcript chunk: ${chunk.index + 1} of ${totalChunks}`,
    `Deterministic task hint score: ${chunk.taskHintScore}`,
    "Transcript:",
    chunk.text,
  ].join("\n");
}

function buildExternalChunkUserMessage(input: MeetingTaskChunkExtractionInput) {
  const participants =
    input.participants.length !== 0
      ? input.participants
          .map((participant) => {
            const email = participant.email?.trim() ?? "";

            return email !== "" ? `- ${participant.name} <${email}>` : `- ${participant.name}`;
          })
          .join("\n")
      : "- Unknown";

  const titleTrimmed = input.title?.trim() ?? "";
  const languageContextTrimmed = input.languageContext?.trim() ?? "";

  return [
    `Meeting ID: ${input.meetingId}`,
    `Meeting title: ${titleTrimmed !== "" ? titleTrimmed : TASK_MESSAGES.untitledMeeting}`,
    `Known participants:\n${participants}`,
    ...formatOrganizationDomainLines(input.participants),
    "Full-meeting language context (language selection only; never task evidence):",
    languageContextTrimmed !== "" ? languageContextTrimmed : TASK_MESSAGES.noLanguageContext,
    `Transcript chunk: ${input.chunkIndex + 1} of ${input.totalChunks}`,
    `Deterministic task hint score: ${input.taskHintScore}`,
    "Transcript:",
    input.transcriptText,
  ].join("\n");
}

function buildReconciliationUserMessage(params: { input: RunExtractionInput; candidates: MeetingTaskCandidate[] }) {
  return JSON.stringify(
    buildEvidencePacket({ input: params.input, candidates: params.candidates }),
    null,
    TASK_JSON_STRINGIFY_INDENT,
  );
}

function buildExternalReconciliationUserMessage(input: MeetingTaskReconciliationInput) {
  return JSON.stringify(input.evidencePacket, null, TASK_JSON_STRINGIFY_INDENT);
}

function createTaskRunner(options?: {
  voiceSearchIdentityEvidence?: VoiceSearchIdentityEvidence[];
  model?: string;
  runner?: MeetingTasksRunner;
}) {
  const apiKey = openAIClientApiKey();
  if ((apiKey === undefined || apiKey === "") && options?.runner === undefined) {
    throw new Error(TASK_MESSAGES.openAiKeyRequired);
  }

  const taskModel = options?.model ?? assistantEnv().OPENAI_MEETING_TASKS_MODEL;
  const resolvedApiKey = apiKey !== undefined && apiKey !== "" ? apiKey : "";
  const baseRunner = options?.runner ?? new OpenAIMeetingTasksRunner(resolvedApiKey);
  const runner: MeetingTasksRunner = {
    async createTasks(request) {
      const metadata = voiceIdentityMetadata({
        evidence: options?.voiceSearchIdentityEvidence,
        text: request.userMessage,
      });

      return baseRunner.createTasks(
        metadata !== ""
          ? {
              ...request,
              systemPrompt: `${request.systemPrompt}\n${VOICE_IDENTITY_INSTRUCTIONS}`,
              userMessage: `${metadata}\n${request.userMessage}`,
            }
          : request,
      );
    },
  };

  return { taskModel, runner };
}

export async function runMeetingTaskChunkExtraction(params: {
  input: MeetingTaskChunkExtractionInput;
  model?: string;
  runner?: MeetingTasksRunner;
}): Promise<MeetingTaskGeneration> {
  const { input, model, runner: runnerOption } = params;
  const { taskModel, runner } = createTaskRunner({
    model,
    runner: runnerOption,
    voiceSearchIdentityEvidence: input.voiceSearchIdentityEvidence,
  });
  const isPersonalListMode = input.extractionMode === "personal_list";
  const { raw, durationMs } = await runTimedTaskModel({
    runner,
    input: {
      model: taskModel,
      systemPrompt: isPersonalListMode ? buildPersonalListTaskPrompt() : buildChunkTaskPrompt(),
      userMessage: buildExternalChunkUserMessage(input),
      maxOutputTokens: isPersonalListMode
        ? PERSONAL_LIST_TASK_EXTRACTION_MAX_OUTPUT_TOKENS
        : GENERAL_TASK_EXTRACTION_MAX_OUTPUT_TOKENS,
      label: `Meeting tasks chunk ${input.chunkIndex + 1}`,
      meetingId: input.meetingId,
      jobId: input.metering?.jobId ?? null,
      workflowRunId: input.metering?.workflowRunId ?? null,
      operation: isPersonalListMode ? "extract_personal_list_tasks" : "extract_task_chunk",
    },
  });
  const parsed = parseTaskCandidatesWithDiagnostics({
    raw,
    context: {
      meetingId: input.meetingId,
      phase: `chunk_${input.chunkIndex + 1}`,
    },
  });

  return asGeneration({
    items: parsed.items,
    taskModel,
    diagnostics: {
      ...parsed.diagnostics,
      modelCallDurationMs: durationMs,
    },
  });
}

export async function runMeetingTaskReconciliation(params: {
  input: MeetingTaskReconciliationInput;
  model?: string;
  runner?: MeetingTasksRunner;
}): Promise<MeetingTaskGeneration> {
  const { input, model, runner: runnerOption } = params;
  const { taskModel, runner } = createTaskRunner({
    model,
    runner: runnerOption,
    voiceSearchIdentityEvidence: input.voiceSearchIdentityEvidence,
  });
  const { raw, durationMs } = await runTimedTaskModel({
    runner,
    input: {
      model: taskModel,
      systemPrompt: buildMeetingTaskReconciliationPrompt(),
      userMessage: buildExternalReconciliationUserMessage(input),
      maxOutputTokens: TASK_RECONCILIATION_MAX_OUTPUT_TOKENS,
      label: "Meeting task reconciliation",
      meetingId: input.meetingId,
      jobId: input.metering?.jobId ?? null,
      workflowRunId: input.metering?.workflowRunId ?? null,
      operation: "reconcile_tasks",
    },
  });
  const parsed = parseTaskCandidatesWithDiagnostics({
    raw,
    context: {
      meetingId: input.meetingId,
      phase: "reconciliation",
    },
  });

  return asGeneration({
    items: parsed.items,
    taskModel,
    diagnostics: {
      ...parsed.diagnostics,
      modelCallDurationMs: durationMs,
    },
  });
}

type PersonalListLaneGeneration = {
  items: MeetingTaskCandidate[];
  durationMs: number;
  diagnostics: NonNullable<MeetingTaskGeneration["diagnostics"]>;
};

function sumDiagnosticCounts(params: { left: number | undefined; right: number | undefined }): number {
  return (params.left ?? 0) + (params.right ?? 0);
}

function mergeMeetingTaskLaneDiagnostics(params: {
  generalDiagnostics?: MeetingTaskGeneration["diagnostics"];
  generalItems: MeetingTaskCandidate[];
  personalListGeneration: PersonalListLaneGeneration | null;
}): MeetingTaskGeneration["diagnostics"] {
  const { generalDiagnostics, generalItems, personalListGeneration } = params;
  const personalDiagnostics = personalListGeneration?.diagnostics;

  return {
    ...generalDiagnostics,
    modelCallDurationMs: sumDiagnosticCounts({
      left: generalDiagnostics?.modelCallDurationMs,
      right: personalListGeneration?.durationMs,
    }),
    schemaDroppedCandidateCount: sumDiagnosticCounts({
      left: generalDiagnostics?.schemaDroppedCandidateCount,
      right: personalDiagnostics?.schemaDroppedCandidateCount,
    }),
    normalizedQuoteStringCount: sumDiagnosticCounts({
      left: generalDiagnostics?.normalizedQuoteStringCount,
      right: personalDiagnostics?.normalizedQuoteStringCount,
    }),
    rawCandidateCount: sumDiagnosticCounts({
      left: generalDiagnostics?.rawCandidateCount ?? generalItems.length,
      right: personalDiagnostics?.rawCandidateCount,
    }),
  };
}

async function finalizeMeetingTaskLanes(params: {
  input: RunExtractionInput;
  taskModel: string;
  personalListGenerationPromise: Promise<PersonalListLaneGeneration | null>;
  generalItems: MeetingTaskCandidate[];
  diagnostics?: MeetingTaskGeneration["diagnostics"];
}): Promise<MeetingTaskGeneration> {
  const personalListGeneration = await params.personalListGenerationPromise;
  const items = mergeTaskExtractionLanes({
    input: params.input,
    generalItems: params.generalItems,
    personalListItems: personalListGeneration?.items ?? [],
  });

  return asGeneration({
    items,
    taskModel: params.taskModel,
    diagnostics: mergeMeetingTaskLaneDiagnostics({
      generalDiagnostics: params.diagnostics,
      generalItems: params.generalItems,
      personalListGeneration,
    }),
  });
}

async function runGlobalMeetingTaskVerification(params: {
  input: RunExtractionInput;
  taskModel: string;
  runner: MeetingTasksRunner;
  initialCandidates: MeetingTaskCandidate[];
  dismissedTombstones?: DismissedMeetingTaskTombstone[];
  segments: TaskSegment[];
  jobId?: string | null;
  workflowRunId?: string | null;
}): Promise<MeetingTaskGeneration> {
  const parsedDismissedTombstones = dismissedMeetingTaskTombstoneSchema.array().parse(params.dismissedTombstones ?? []);
  const userMessage = formatGlobalTaskVerificationInput({
    input: params.input,
    initialCandidates: params.initialCandidates,
    dismissedTombstones: parsedDismissedTombstones,
    segments: params.segments,
  });
  const { raw, durationMs } = await runTimedTaskModel({
    runner: params.runner,
    input: {
      model: params.taskModel,
      systemPrompt: buildGlobalMeetingTaskVerificationPrompt(),
      userMessage,
      maxOutputTokens: GLOBAL_TASK_VERIFICATION_MAX_OUTPUT_TOKENS,
      timeoutMs: globalTaskVerificationTimeoutMs({
        estimatedInputTokens: estimateMeetingTaskInputTokens(userMessage),
      }),
      outputRetryTimeoutMs: TASK_GLOBAL_VERIFICATION_TIMEOUT_MAX_MS,
      label: "Meeting task global verification",
      meetingId: params.input.meetingId,
      jobId: params.jobId ?? null,
      workflowRunId: params.workflowRunId ?? null,
      operation: "verify_tasks_global",
    },
  });
  const parsed = parseTaskCandidatesWithDiagnostics({
    raw,
    context: {
      meetingId: params.input.meetingId,
      phase: "global_verification",
    },
  });

  return asGeneration({
    items: parsed.items.map((candidate) => enrichCandidateQuotes({ candidate, segments: params.segments })),
    taskModel: params.taskModel,
    diagnostics: {
      ...parsed.diagnostics,
      modelCallDurationMs: durationMs,
    },
  });
}

async function startPersonalListGenerationPromise(params: {
  input: RunExtractionInput;
  taskModel: string;
  runner: MeetingTasksRunner;
  segments: TaskSegment[];
  languageContext: string;
  personalListEvidence: string | null;
}): Promise<PersonalListLaneGeneration | null> {
  if (params.personalListEvidence === null || params.personalListEvidence === "") {
    return null;
  }

  try {
    const titleTrimmed = params.input.metadata.title?.trim() ?? "";
    const { raw, durationMs } = await runTimedTaskModel({
      runner: params.runner,
      input: {
        model: params.taskModel,
        systemPrompt: buildPersonalListTaskPrompt(),
        userMessage: [
          `Meeting ID: ${params.input.meetingId}`,
          `Meeting title: ${titleTrimmed !== "" ? titleTrimmed : TASK_MESSAGES.untitledMeeting}`,
          `Known participants:\n${formatParticipants(params.input)}`,
          ...formatOrganizationDomainLines(params.input.metadata.participants),
          "Full-meeting language context (language selection only; never task evidence):",
          params.languageContext,
          "Personal-list evidence blocks:",
          params.personalListEvidence,
        ].join("\n"),
        maxOutputTokens: PERSONAL_LIST_TASK_EXTRACTION_MAX_OUTPUT_TOKENS,
        label: "Meeting personal-list tasks",
        meetingId: params.input.meetingId,
        operation: "extract_personal_list_tasks",
      },
    });
    const parsed = parseTaskCandidatesWithDiagnostics({
      raw,
      context: {
        meetingId: params.input.meetingId,
        phase: "personal_list",
      },
    });

    return { ...parsed, durationMs };
  } catch (error) {
    void error;

    return null;
  }
}

async function runShortTranscriptMeetingTasks(params: {
  input: RunExtractionInput;
  taskModel: string;
  runner: MeetingTasksRunner;
  segments: TaskSegment[];
  personalListGenerationPromise: Promise<PersonalListLaneGeneration | null>;
}): Promise<MeetingTaskGeneration> {
  const { raw, durationMs } = await runTimedTaskModel({
    runner: params.runner,
    input: {
      model: params.taskModel,
      systemPrompt: buildMeetingTasksPrompt(),
      userMessage: formatTaskTranscript({ input: params.input, segments: params.segments }),
      maxOutputTokens: GENERAL_TASK_EXTRACTION_MAX_OUTPUT_TOKENS,
      label: "Meeting tasks",
      meetingId: params.input.meetingId,
      operation: "extract_tasks_full_transcript",
    },
  });
  const parsed = parseTaskCandidatesWithDiagnostics({
    raw,
    context: {
      meetingId: params.input.meetingId,
      phase: "full_transcript",
    },
  });

  return finalizeMeetingTaskLanes({
    input: params.input,
    taskModel: params.taskModel,
    personalListGenerationPromise: params.personalListGenerationPromise,
    generalItems: parsed.items,
    diagnostics: {
      ...parsed.diagnostics,
      modelCallDurationMs: durationMs,
    },
  });
}

async function extractTaskCandidatesFromChunk(params: {
  input: RunExtractionInput;
  taskModel: string;
  runner: MeetingTasksRunner;
  chunk: TaskChunk;
  totalChunks: number;
  languageContext: string;
}): Promise<{ candidates: MeetingTaskCandidate[]; isUnusable: boolean }> {
  const raw = await runTaskModel({
    runner: params.runner,
    input: {
      model: params.taskModel,
      systemPrompt: buildChunkTaskPrompt(),
      userMessage: buildChunkUserMessage({
        input: params.input,
        chunk: params.chunk,
        totalChunks: params.totalChunks,
        languageContext: params.languageContext,
      }),
      maxOutputTokens: GENERAL_TASK_EXTRACTION_MAX_OUTPUT_TOKENS,
      label: `Meeting tasks chunk ${params.chunk.index + 1}`,
      meetingId: params.input.meetingId,
      operation: "extract_task_chunk",
    },
  });
  try {
    return {
      candidates: parseTaskCandidates({
        raw,
        context: {
          meetingId: params.input.meetingId,
          phase: `chunk_${params.chunk.index + 1}`,
        },
      }).map((candidate) => enrichCandidateQuotes({ candidate, segments: params.chunk.segments })),
      isUnusable: false,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        component: "meeting-tasks",
        message: TASK_MESSAGES.droppedUnusableChunk,
        meetingId: params.input.meetingId,
        phase: `chunk_${params.chunk.index + 1}`,
        taskPromptVersion: MEETING_TASKS_PROMPT_VERSION,
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );

    return {
      candidates: [],
      isUnusable: true,
    };
  }
}

async function runChunkedMeetingTasks(params: {
  input: RunExtractionInput;
  taskModel: string;
  runner: MeetingTasksRunner;
  segments: TaskSegment[];
  languageContext: string;
  personalListGenerationPromise: Promise<PersonalListLaneGeneration | null>;
}): Promise<MeetingTaskGeneration> {
  const chunks = buildTranscriptChunks(params.segments);
  const selectedChunks = selectTaskChunks(chunks);
  if (selectedChunks.length === 0) {
    return finalizeMeetingTaskLanes({
      input: params.input,
      taskModel: params.taskModel,
      personalListGenerationPromise: params.personalListGenerationPromise,
      generalItems: [],
    });
  }

  const chunkResults = await mapWithConcurrency({
    items: selectedChunks,
    concurrency: TASK_CHUNK_CONCURRENCY,
    mapper: async ({ item: chunk }) =>
      extractTaskCandidatesFromChunk({
        input: params.input,
        taskModel: params.taskModel,
        runner: params.runner,
        chunk,
        totalChunks: chunks.length,
        languageContext: params.languageContext,
      }),
  });

  const candidates = chunkResults.flatMap((result) => result.candidates);
  if (candidates.length === 0 && chunkResults.every((result) => result.isUnusable)) {
    throw new Error(TASK_MESSAGES.parseFailed);
  }
  if (candidates.length <= 1) {
    return finalizeMeetingTaskLanes({
      input: params.input,
      taskModel: params.taskModel,
      personalListGenerationPromise: params.personalListGenerationPromise,
      generalItems: candidates,
    });
  }

  const knownQuotes = candidates.flatMap((candidate) => candidate.sourceQuotes);
  try {
    const rawReconciled = await runTaskModel({
      runner: params.runner,
      input: {
        model: params.taskModel,
        systemPrompt: buildMeetingTaskReconciliationPrompt(),
        userMessage: buildReconciliationUserMessage({ input: params.input, candidates }),
        maxOutputTokens: TASK_RECONCILIATION_MAX_OUTPUT_TOKENS,
        label: "Meeting task reconciliation",
        meetingId: params.input.meetingId,
        operation: "reconcile_tasks",
      },
    });
    const reconciled = filterTasksToKnownEvidence({
      items: parseTaskCandidates({
        raw: rawReconciled,
        context: {
          meetingId: params.input.meetingId,
          phase: "reconciliation",
        },
      }),
      knownQuotes,
    });

    return await finalizeMeetingTaskLanes({
      input: params.input,
      taskModel: params.taskModel,
      personalListGenerationPromise: params.personalListGenerationPromise,
      generalItems: reconciled.length !== 0 ? reconciled : candidates,
    });
  } catch (error) {
    void error;

    return finalizeMeetingTaskLanes({
      input: params.input,
      taskModel: params.taskModel,
      personalListGenerationPromise: params.personalListGenerationPromise,
      generalItems: candidates,
    });
  }
}

export async function runMeetingTasks(params: {
  input: RunExtractionInput;
  model?: string;
  runner?: MeetingTasksRunner;
  initialCandidates?: MeetingTaskCandidate[];
  dismissedTombstones?: DismissedMeetingTaskTombstone[];
  jobId?: string | null;
  workflowRunId?: string | null;
}): Promise<MeetingTaskGeneration> {
  const { input, model, runner: runnerOption, initialCandidates, dismissedTombstones, jobId, workflowRunId } = params;
  const { taskModel, runner } = createTaskRunner({
    model,
    runner: runnerOption,
    voiceSearchIdentityEvidence: input.voiceSearchIdentityEvidence,
  });
  const segments = sortedTranscript(input);
  const languageContext = buildMeetingTaskLanguageContext(segments.map((segment) => segment.content));

  if (initialCandidates !== undefined) {
    return runGlobalMeetingTaskVerification({
      input,
      taskModel,
      runner,
      initialCandidates,
      dismissedTombstones,
      segments,
      jobId,
      workflowRunId,
    });
  }

  const personalListGenerationPromise = startPersonalListGenerationPromise({
    input,
    taskModel,
    runner,
    segments,
    languageContext,
    personalListEvidence: formatPersonalListEvidenceBlocks(segments),
  });

  if (transcriptTextLength(segments) <= SHORT_TASK_TRANSCRIPT_CHARS) {
    return runShortTranscriptMeetingTasks({
      input,
      taskModel,
      runner,
      segments,
      personalListGenerationPromise,
    });
  }

  return runChunkedMeetingTasks({
    input,
    taskModel,
    runner,
    segments,
    languageContext,
    personalListGenerationPromise,
  });
}
