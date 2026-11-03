import type { RepositoryPort, StoredMeetingAmbientContextItem } from "@readymeet/db/ports/repository";
import {
  type AiWorkflowJobView,
  AMBIENT_CONTEXT_SETTLE_MS,
  AMBIENT_IDENTITY_UNVERIFIED,
  AMBIENT_VOICE_SEARCH_HANDLED,
  type AmbientContextCitation,
  ambientContextCitationSchema,
  ambientContextEntityKindSchema,
  type MeetingAmbientContextItem,
  openAIPromptCacheOptions,
} from "@readymeet/shared";
import {
  explicitCompanyDomain,
  matchVoiceSearchMentions,
  sourceMatchesCompanyDomain,
  VOICE_SEARCH_MATCH_WINDOW_MS,
  voiceSearchOwnedSegmentIds,
  voiceSearchRequestCandidates,
} from "@readymeet/shared/server/voice-research-evidence";
import { z } from "zod";

import { AMBIENT_RESEARCH_SYSTEM_PROMPT } from "../domain/ambient-context-research-prompt";
import { apiEnv } from "../ports/api-env";
import {
  ambientContextCanonicalKey,
  type AmbientDetection,
  passesAmbientDetectionGuards,
} from "../ports/gate-ambient-context-detection";
import { executeMeetingResponse } from "../ports/gate-metered-provider";
import { repositories } from "../ports/repository-runtime";

import { enrichAmbientContextImage } from "./ambient-context-image";
import { parallelClientFromEnv, type ParallelSearchResponse } from "./calendar-meeting-prep";
import { registerRequestWorkflowHandler, runAiWorkflowInRequest } from "./request-ai-workflow";

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const VOICE_FALLBACK_BASE_MINUTES = 2;
const VOICE_FALLBACK_BUFFER_SECONDS = 2;
const VOICE_FALLBACK_BUFFER_MS = VOICE_FALLBACK_BUFFER_SECONDS * MS_PER_SECOND;
const VOICE_FALLBACK_RECHECK_SECONDS = 5;
const VOICE_EVIDENCE_LOOKBACK_MS = MS_PER_SECOND;
const VOICE_OWNERSHIP_RECHECK_LIMIT = 2;
// Main uses a 60-second search deadline (not minutes).
const PARALLEL_SEARCH_TIMEOUT_SECONDS = 60;
const PARALLEL_SEARCH_TIMEOUT_MS = PARALLEL_SEARCH_TIMEOUT_SECONDS * MS_PER_SECOND;
const AMBIENT_WORKFLOW_MAX_ATTEMPTS = 2;
const MIN_PERSON_NAME_WORDS = 2;

const DISPLAY_NAME_MAX_LENGTH = 255;
const QUALIFIER_MAX_LENGTH = 320;
const FACET_LABEL_MAX_LENGTH = 80;
const MAX_ENTITY_FACETS = 8;
const MAX_MENTION_COUNT = 50;
const MAX_DETECTED_ENTITIES = 20;
const MAX_SYNTHESIS_SOURCE_IDS = 10;
const PROFESSIONAL_TITLE_MAX_LENGTH = 255;
const COMPANY_NAME_MAX_LENGTH = 255;
const HEADQUARTERS_MAX_LENGTH = 255;
const SUMMARY_MAX_LENGTH = 1000;
const MAX_SYNTHESIS_FACTS = 6;
const FACT_MAX_LENGTH = 400;
const DETECTION_MAX_OUTPUT_TOKENS = 1000;
const RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS = 900;
const CITATION_TITLE_MAX_LENGTH = 220;
const CITATION_EXCERPT_MAX_LENGTH = 1200;
const MAX_CITATIONS = 10;
const PARALLEL_SEARCH_MAX_CHARS = 18_000;
const PARALLEL_FETCH_MAX_AGE_SECONDS = 3600;
const VOICE_RESEARCH_DEFER_BUFFER_MS = 100;

// Voice runs expire after two minutes; allow the routing correlation window
// as well. The deadline is tied to speech, so retries cannot extend it.
const VOICE_FALLBACK_WAIT_MS =
  VOICE_FALLBACK_BASE_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND +
  VOICE_SEARCH_MATCH_WINDOW_MS +
  VOICE_FALLBACK_BUFFER_MS;
const VOICE_FALLBACK_RECHECK_MS = VOICE_FALLBACK_RECHECK_SECONDS * MS_PER_SECOND;

type LoggerLike = {
  info(...args: [bindings: Record<string, unknown>, message: string]): void;
  warn(...args: [bindings: Record<string, unknown>, message: string]): void;
  error(...args: [bindings: Record<string, unknown>, message: string]): void;
};

const detectedEntitySchema = z.object({
  kind: ambientContextEntityKindSchema,
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH),
  qualifier: z.string().trim().min(1).max(QUALIFIER_MAX_LENGTH).nullable().default(null),
  facets: z.preprocess(
    (value) => (value === null ? [] : value),
    z.array(z.string().trim().min(1).max(FACET_LABEL_MAX_LENGTH)).max(MAX_ENTITY_FACETS).default([]),
  ),
  segmentIds: z.array(z.string().uuid()).min(1),
  mentionCount: z.number().int().positive().max(MAX_MENTION_COUNT).default(1),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  intent: z.enum(["explicit", "contextual", "incidental"]).default("contextual"),
});

const detectionOutputSchema = z.object({ entities: z.array(detectedEntitySchema).max(MAX_DETECTED_ENTITIES) });

function parseAmbientContextDetections(raw: unknown): z.infer<typeof detectionOutputSchema> {
  // Validate the entire batch before any mention, job, or cursor writes. A
  // malformed candidate must not advance the cursor or persist partial results.
  return detectionOutputSchema.parse(raw);
}

const synthesisOutputSchema = z.object({
  identityVerified: z.preprocess(
    (value) =>
      value === undefined
        ? undefined
        : value === true || (typeof value === "string" && value.trim().toLowerCase() === "true"),
    z.boolean().optional(),
  ),
  // Selection metadata must never turn a completed search into another paid retry.
  // Malformed explicit selections fail closed; omitted metadata uses the legacy identity filter.
  sourceIds: z.preprocess(
    (value) =>
      value === null || value === undefined
        ? undefined
        : Array.isArray(value)
          ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^s[1-9][0-9]*$/.test(id)))].slice(
              0,
              MAX_SYNTHESIS_SOURCE_IDS,
            )
          : [],
    z.array(z.string()).optional(),
  ),
  articleSourceIds: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^s[1-9][0-9]*$/.test(id)))].slice(
            0,
            MAX_SYNTHESIS_SOURCE_IDS,
          )
        : [],
    z.array(z.string()),
  ),
  professionalTitle: z.string().trim().min(1).max(PROFESSIONAL_TITLE_MAX_LENGTH).nullable().default(null),
  companyName: z.string().trim().min(1).max(COMPANY_NAME_MAX_LENGTH).nullable().default(null),
  headquarters: z.string().trim().min(1).max(HEADQUARTERS_MAX_LENGTH).nullable().default(null),
  officialWebsite: z.string().url().nullable().default(null),
  profileUrl: z.string().url().nullable().default(null),
  summary: z.string().trim().min(1).max(SUMMARY_MAX_LENGTH),
  facts: z.preprocess(
    (value) => (Array.isArray(value) ? value.slice(0, MAX_SYNTHESIS_FACTS) : value),
    z.array(z.string().trim().min(1).max(FACT_MAX_LENGTH)).max(MAX_SYNTHESIS_FACTS),
  ),
});

const AMBIENT_CONTEXT_BEFORE_SEGMENTS = 8;
const AMBIENT_CONTEXT_AFTER_SEGMENTS = 3;

function ambientContextSettledSegmentCountNamed(input: {
  segments: { startedAt: Date; endedAt: Date | null }[];
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  const settledCutoff = now - AMBIENT_CONTEXT_SETTLE_MS;
  const segments = input.segments;
  const firstUnsettledIndex = segments.findIndex(
    (segment) => (segment.endedAt ?? segment.startedAt).getTime() > settledCutoff,
  );

  return firstUnsettledIndex === -1 ? segments.length : firstUnsettledIndex;
}

function ambientContextSettledSegmentCount(
  ...args: [segments: { startedAt: Date; endedAt: Date | null }[], now?: number]
): number {
  return ambientContextSettledSegmentCountNamed({ segments: args[0], now: args[1] });
}

type AmbientContextTimedSegment = {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
};

type AmbientContextCursor = {
  lastProcessedSegmentId: string | null;
  processedThrough: Date | null;
};

function ambientContextCursorIndexNamed(input: {
  segments: AmbientContextTimedSegment[];
  cursor: AmbientContextCursor | null;
}): number {
  const { segments, cursor } = input;
  if (cursor === null) {
    return -1;
  }
  if (cursor.lastProcessedSegmentId !== null && cursor.lastProcessedSegmentId.length > 0) {
    const exactIndex = segments.findIndex((segment) => segment.id === cursor.lastProcessedSegmentId);
    if (exactIndex >= 0) {
      return exactIndex;
    }
  }
  if (cursor.processedThrough === null) {
    return -1;
  }

  const processedThroughMs = cursor.processedThrough.getTime();
  const lastProcessedIndex = segments.reduce<number>((index, segment, candidateIndex) => {
    if ((segment.endedAt ?? segment.startedAt).getTime() > processedThroughMs) {
      return index;
    }

    return candidateIndex;
  }, -1);

  return lastProcessedIndex;
}

function ambientContextCursorIndex(
  ...args: [segments: AmbientContextTimedSegment[], cursor: AmbientContextCursor | null]
): number {
  return ambientContextCursorIndexNamed({ segments: args[0], cursor: args[1] });
}

const ambientContextModelJsonEnvelopeSchema = z.record(z.string(), z.unknown());
const openAiResponsesPayloadSchema = z.record(z.string(), z.unknown());
const openAiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.unknown().optional(),
        type: z.unknown().optional(),
      })
      .optional(),
  })
  .nullable();

const MESSAGE_AMBIENT_CONTEXT_MODEL_INVALID_JSON = "Ambient context model returned invalid JSON";
const MESSAGE_OPENAI_API_KEY_NOT_CONFIGURED = "OPENAI_API_KEY is not configured";
const MESSAGE_AMBIENT_CONTEXT_MODEL_NO_OUTPUT = "Ambient context model returned no output";
const MESSAGE_AMBIENT_CONTEXT_MODEL_FAILED_PREFIX = "Ambient context model failed (HTTP ";
const MESSAGE_PARALLEL_API_KEY_NOT_CONFIGURED = "PARALLEL_API_KEY is not configured";
const MESSAGE_PARALLEL_SEARCH_NO_SOURCES = "Parallel Search returned no usable public sources";
const MESSAGE_AMBIENT_RESEARCH_JOB_MISSING_ITEM_ID = "Ambient research job is missing itemId";
const MESSAGE_AMBIENT_IMAGE_JOB_MISSING_ITEM_ID = "Ambient image enrichment job is missing itemId";
const MESSAGE_AMBIENT_DETECTION_BATCH_EMPTY = "Ambient detection batch is empty";
const MESSAGE_AMBIENT_MENTION_MISSING_FIRST_SEGMENT = "Ambient mention is missing its first segment";
const MESSAGE_AMBIENT_VOICE_OWNERSHIP_CHANGING = "Ambient mention evidence kept changing during voice ownership check";

class AmbientVoiceOwnershipChangingError extends Error {
  override name = "AmbientVoiceOwnershipChangingError";

  constructor() {
    super(MESSAGE_AMBIENT_VOICE_OWNERSHIP_CHANGING);
  }
}
const MESSAGE_AMBIENT_ITEM_DISAPPEARED_COMMIT = "Ambient context item disappeared while committing research";
const MESSAGE_AMBIENT_ITEM_DISAPPEARED_RESTORE = "Ambient context item disappeared while restoring committed research";
const MESSAGE_AMBIENT_ITEM_DISAPPEARED_FOLLOW_UP =
  "Ambient context item disappeared while scheduling follow-up research";
const MESSAGE_AMBIENT_RESEARCH_FAILED = "Ambient research failed";
const LOG_MESSAGE_AMBIENT_RESEARCH_IDENTITY_REJECTED = "Ambient research identity verification rejected";
const LOG_MESSAGE_AMBIENT_RESEARCH_COMPLETED = "Ambient context research completed";
const LOG_MESSAGE_AMBIENT_HANDOFF_FAILED = "Ambient context handoff failed after research was settled";
const LOG_MESSAGE_AMBIENT_IMAGE_COMPLETED = "Ambient identity image enrichment completed";
const LOG_MESSAGE_AMBIENT_IMAGE_FAILED = "Ambient identity image enrichment failed";
const LOG_MESSAGE_OPTIONAL_VOICE_EVIDENCE_UNAVAILABLE =
  "Optional voice evidence unavailable; deferring ownership check to research";
const LOG_MESSAGE_DISCARDED_AMBIENT_REFERENCES = "Discarded ambient references outside the submitted new-segment set";
const LOG_MESSAGE_TRANSCRIPT_TAIL_DEFERRED = "Ambient context transcript tail deferred";
const LOG_MESSAGE_TRANSCRIPT_WINDOW_PROCESSED = "Ambient context transcript window processed";
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.length > 0;
}

const mentionSegmentIdsSchema = z.array(z.string());

function ambientMentionSegmentIds(item: StoredMeetingAmbientContextItem): string[] {
  const parsed = mentionSegmentIdsSchema.safeParse(item.mentionSegmentIds);

  return parsed.success ? parsed.data : [];
}

function ambientImageStorageKey(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function ambientContextModelFailedMessage(input: { status: number; codeSuffix: string }): string {
  return [MESSAGE_AMBIENT_CONTEXT_MODEL_FAILED_PREFIX, String(input.status), input.codeSuffix, ")"].join("");
}

function parseAmbientContextModelJson(text: string): unknown {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(MESSAGE_AMBIENT_CONTEXT_MODEL_INVALID_JSON);
  }
  try {
    return ambientContextModelJsonEnvelopeSchema.parse(JSON.parse(clean.slice(start, end + 1)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : MESSAGE_AMBIENT_CONTEXT_MODEL_INVALID_JSON;
    throw new Error(
      reason.length === 0 ? MESSAGE_AMBIENT_CONTEXT_MODEL_INVALID_JSON : MESSAGE_AMBIENT_CONTEXT_MODEL_INVALID_JSON,
    );
  }
}

function extractResponseText(payload: unknown) {
  if (!isRecord(payload)) {
    return "";
  }
  const direct = payload.output_text;
  if (typeof direct === "string") {
    return direct;
  }
  const output = payload.output;
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const content = item.content;
      if (!Array.isArray(content)) {
        return [];
      }

      return content.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []));
    })
    .join("\n");
}

async function runJsonModel(input: {
  meetingId: string;
  system: string;
  user: unknown;
  maxOutputTokens: number;
  model?: string;
}) {
  if (apiEnv().OPENAI_API_KEY === "") {
    throw new Error(MESSAGE_OPENAI_API_KEY_NOT_CONFIGURED);
  }
  const model = input.model ?? apiEnv().OPENAI_AMBIENT_CONTEXT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiEnv().OPENAI_AMBIENT_CONTEXT_TIMEOUT_MS);
  timeout.unref();
  try {
    const result = await executeMeetingResponse({
      meetingId: input.meetingId,
      source: "ambient_context",
      actionType: "agent_workflow",
      request: {
        apiKey: apiEnv().OPENAI_API_KEY,
        signal: controller.signal,
        timeoutMs: apiEnv().OPENAI_AMBIENT_CONTEXT_TIMEOUT_MS,
        body: {
          model,
          ...openAIPromptCacheOptions(model),
          max_output_tokens: input.maxOutputTokens,
          input: [
            { role: "system", content: input.system },
            { role: "user", content: JSON.stringify(input.user) },
          ],
        },
      },
    });
    if (!result.isOk) {
      const errorPayload = openAiErrorResponseSchema.safeParse(result.payload);
      // Codes/types are useful operationally; provider messages can quote input.
      const errorBody = errorPayload.success ? errorPayload.data : null;
      const value = errorBody?.error?.code ?? errorBody?.error?.type;
      const code = typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? `, ${value}` : "";
      throw new Error(ambientContextModelFailedMessage({ status: result.status, codeSuffix: code }));
    }
    const payload = openAiResponsesPayloadSchema.parse(result.payload);
    const text = extractResponseText(payload);
    if (text.length === 0) {
      throw new Error(MESSAGE_AMBIENT_CONTEXT_MODEL_NO_OUTPUT);
    }

    return parseAmbientContextModelJson(text);
  } finally {
    clearTimeout(timeout);
  }
}

const AMBIENT_CONTEXT_DETECTION_SYSTEM_PROMPT = [
  "Detect clear, research-worthy references to real people and companies in final human meeting transcript segments.",
  'Return JSON only: {"entities":[{"kind":"person|company","displayName":"...","qualifier":"... or null","facets":["funding|role|outreach|product|leadership|news"],"segmentIds":["uuid"],"mentionCount":1,"confidence":"high|medium|low","intent":"explicit|contextual|incidental"}]}.',
  "segmentIds must contain only IDs from segments marked isNew=true, even when grouping repeat mentions across surrounding context.",
  "Only include entities mentioned in segments marked isNew=true. Segments marked before_context and after_context are only for resolving meaning, identity, and intent.",
  "Read the whole local conversation around a proposed name before classifying it. The transcript may be multilingual and speech-to-text capitalization is not evidence of a proper noun.",
  "Words that are grammatical in the language being spoken are not entities. An ambiguous word can be a company only when nearby words make that company meaning unmistakable.",
  "Exclude first-name-only people, generic categories, speaker labels, Ready, ReadyMeet, low-confidence guesses, and anything inferred only from participant metadata.",
  "Set intent=explicit for a direct who/what/research question, contextual when the surrounding discussion makes public background useful, and incidental for a passing mention. Prefer omitting incidental references unless they recur or become relevant.",
  "For people, qualifier should usually be their company or another professional discriminator.",
  "A direct question or request about a full-named person, such as “who is Firstname Lastname?”, is public professional research intent even when no company or role is stated.",
  "Do not suppress an explicitly mentioned full name because it is unfamiliar or shares a surname with a speaker; the research stage will determine whether usable public professional information exists.",
  "Group repeated mentions of the same identity and count them. Do not invent identity details.",
].join(" ");

type DetectionSegment = NonNullable<Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>>>["segments"][number];
async function detectAmbientBatch({
  meetingId,
  batch,
  before,
  after,
}: {
  meetingId: string;
  batch: DetectionSegment[];
  before: DetectionSegment[];
  after: DetectionSegment[];
}): Promise<{ entities: AmbientDetection[] }> {
  const current = new Set(batch.map((segment) => segment.id));
  const preceding = new Set(before.map((segment) => segment.id));
  const analyzed = [...before, ...batch, ...after];
  const parsed = parseAmbientContextDetections(
    await runJsonModel({
      meetingId,
      system: AMBIENT_CONTEXT_DETECTION_SYSTEM_PROMPT,
      user: {
        segments: analyzed.map((segment) => ({
          id: segment.id,
          speakerLabel: segment.speakerName,
          isNew: current.has(segment.id),
          contextRole: current.has(segment.id)
            ? "candidate"
            : preceding.has(segment.id)
              ? "before_context"
              : "after_context",
          text: segment.content,
        })),
      },
      maxOutputTokens: DETECTION_MAX_OUTPUT_TOKENS,
    }),
  );

  return {
    entities: parsed.entities.map(({ confidence, intent, ...entity }) => ({
      ...entity,
      legacyPolicy: { confidence, intent },
    })),
  };
}

type AmbientDetectionJobResult = {
  detected: number;
  /** @external workflow job result */
  disabled?: boolean;
  /** @external workflow job result */
  missingMeeting?: boolean;
  /** @external workflow job result */
  deferred?: number;
  processed?: number;
};

function ambientMentionSurroundingContent(input: {
  mentionedSegments: DetectionSegment[];
  human: DetectionSegment[];
}): string[] {
  return [
    ...new Set(
      input.mentionedSegments.flatMap((segment) => {
        const segmentIndex = input.human.findIndex((candidate) => candidate.id === segment.id);
        if (segmentIndex < 0) {
          return [segment.content];
        }

        return input.human
          .slice(
            Math.max(0, segmentIndex - AMBIENT_CONTEXT_BEFORE_SEGMENTS),
            Math.min(input.human.length, segmentIndex + 1 + AMBIENT_CONTEXT_AFTER_SEGMENTS),
          )
          .map((candidate) => candidate.content);
      }),
    ),
  ];
}

function ambientVoiceResearchRunAfter(
  pendingRequests: ReturnType<typeof voiceSearchRequestCandidates>,
): Date | undefined {
  if (pendingRequests.length === 0) {
    return undefined;
  }

  return new Date(
    Math.max(...pendingRequests.map(({ segment }) => (segment.endedAt ?? segment.startedAt).getTime())) +
      VOICE_SEARCH_MATCH_WINDOW_MS +
      VOICE_RESEARCH_DEFER_BUFFER_MS,
  );
}

async function writePersistedAmbientDetection(input: {
  entity: AmbientDetection;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  matchingIds: string[];
  lastSegment: DetectionSegment;
  firstMentionedSegment: DetectionSegment;
  pendingRequests: ReturnType<typeof voiceSearchRequestCandidates>;
}) {
  const canonicalKey = input.entity.canonicalKey ?? ambientContextCanonicalKey(input.entity);

  return input.entity.referenceOnly === true
    ? repositories().recordMeetingAmbientContextReference({
        meetingId: input.meeting.id,
        canonicalKey,
        mentionedAt: input.lastSegment.startedAt,
        mentionSegmentIds: input.matchingIds,
      })
    : repositories().upsertMeetingAmbientContextMentionAndEnqueueResearch({
        meetingId: input.meeting.id,
        entityKind: input.entity.kind,
        canonicalKey,
        displayName: input.entity.displayName,
        qualifier: input.entity.qualifier,
        facets: input.entity.facets,
        mentionCount: Math.max(input.entity.mentionCount, input.matchingIds.length),
        mentionedAt: input.lastSegment.startedAt,
        firstMentionedAt: input.firstMentionedSegment.startedAt,
        mentionSegmentIds: input.matchingIds,
        voiceSearchRequestedAt: input.pendingRequests[0]?.segment.startedAt,
        researchRunAfter: ambientVoiceResearchRunAfter(input.pendingRequests),
      });
}

async function persistAmbientDetectedEntity(input: {
  entity: AmbientDetection;
  batch: DetectionSegment[];
  human: DetectionSegment[];
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  validNewIds: Set<string>;
  searchWindow: DetectionSegment[];
  searchRequests: ReturnType<typeof voiceSearchRequestCandidates>;
  voiceMentions: ReturnType<typeof matchVoiceSearchMentions>;
  logger: LoggerLike;
}): Promise<number> {
  const ownedIds = voiceSearchOwnedSegmentIds({
    segments: input.searchWindow,
    mentions: input.voiceMentions,
    displayName: input.entity.displayName,
  });
  const matchingIds = [
    ...new Set(input.entity.segmentIds.filter((id) => input.validNewIds.has(id) && !ownedIds.has(id))),
  ];
  const rejectedCount = input.entity.segmentIds.filter((id) => !input.validNewIds.has(id)).length;
  if (rejectedCount > 0) {
    input.logger.warn(
      {
        meetingId: input.meeting.id,
        rejectedSegmentCount: rejectedCount,
        isSkippedEntity: matchingIds.length === 0,
      },
      LOG_MESSAGE_DISCARDED_AMBIENT_REFERENCES,
    );
  }
  if (matchingIds.length === 0) {
    return 0;
  }
  const mentionedSegments = input.batch.filter((segment) => matchingIds.includes(segment.id));
  const surroundingContent = ambientMentionSurroundingContent({
    mentionedSegments,
    human: input.human,
  });
  if (
    !passesAmbientDetectionGuards(
      input.entity,
      mentionedSegments.map((segment) => segment.content),
      surroundingContent,
    )
  ) {
    return 0;
  }
  const lastSegment = mentionedSegments.at(-1) ?? input.batch.at(-1);
  if (!lastSegment) {
    return 0;
  }
  const firstMentionedSegment = mentionedSegments[0];
  if (!firstMentionedSegment) {
    throw new Error(MESSAGE_AMBIENT_MENTION_MISSING_FIRST_SEGMENT);
  }
  const pendingRequests = input.searchRequests.filter(({ segment, target }) => {
    const related = voiceSearchOwnedSegmentIds({
      segments: input.searchWindow,
      displayName: input.entity.displayName,
      mentions: [{ runId: "pending", segmentId: segment.id, transcriptTarget: target, query: target }],
    });

    return matchingIds.some((id) => related.has(id));
  });
  const persisted = await writePersistedAmbientDetection({
    entity: input.entity,
    meeting: input.meeting,
    matchingIds,
    lastSegment,
    firstMentionedSegment,
    pendingRequests,
  });
  if (!persisted) {
    return 0;
  }
  if ("researchJob" in persisted && persisted.researchJob !== null) {
    await runAiWorkflowInRequest({
      meetingId: input.meeting.id,
      type: "research_ambient_entity",
      job: persisted.researchJob,
      logger: input.logger,
    });

    return 1;
  }
  await repositories().publishAmbientContextRealtimeUpdate({
    workspaceId: input.meeting.workspaceId,
    meetingId: input.meeting.id,
    itemId: persisted.item.id,
    status: persisted.item.status,
  });

  return 1;
}

async function listAmbientDetectionVoiceRuns(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  searchRequests: ReturnType<typeof voiceSearchRequestCandidates>;
  logger: LoggerLike;
}) {
  const firstRequest = input.searchRequests[0];
  if (input.searchRequests.length === 0 || firstRequest === undefined) {
    return [];
  }

  try {
    return await repositories().listVoiceSearchEvidenceForMeeting({
      meetingId: input.meeting.id,
      since: new Date(firstRequest.segment.startedAt.getTime() - VOICE_EVIDENCE_LOOKBACK_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unavailable";
    input.logger.warn({ meetingId: input.meeting.id, reason }, LOG_MESSAGE_OPTIONAL_VOICE_EVIDENCE_UNAVAILABLE);

    return [];
  }
}

async function processAmbientDetectionBatch(input: {
  batch: DetectionSegment[];
  human: DetectionSegment[];
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  logger: LoggerLike;
}): Promise<number> {
  const firstSegment = input.batch[0];
  if (!firstSegment) {
    throw new Error(MESSAGE_AMBIENT_DETECTION_BATCH_EMPTY);
  }
  const firstNewIndex = input.human.findIndex((segment) => segment.id === firstSegment.id);
  const lastNewIndex = firstNewIndex + input.batch.length - 1;
  const contextStart = Math.max(0, firstNewIndex - AMBIENT_CONTEXT_BEFORE_SEGMENTS);
  const contextEnd = Math.min(input.human.length, lastNewIndex + 1 + AMBIENT_CONTEXT_AFTER_SEGMENTS);
  const validNewIds = new Set(input.batch.map((segment) => segment.id));

  const parsed = await detectAmbientBatch({
    meetingId: input.meeting.id,
    batch: input.batch,
    before: input.human.slice(contextStart, firstNewIndex),
    after: input.human.slice(lastNewIndex + 1, contextEnd),
  });
  const earliestRequestEnd = firstSegment.startedAt.getTime() - VOICE_SEARCH_MATCH_WINDOW_MS;
  const blockingOffset =
    firstNewIndex > 0
      ? [...input.human.slice(0, firstNewIndex)]
          .reverse()
          .findIndex((segment) => (segment.endedAt ?? segment.startedAt).getTime() < earliestRequestEnd)
      : -1;
  const searchStart = firstNewIndex <= 0 ? firstNewIndex : blockingOffset < 0 ? 0 : firstNewIndex - blockingOffset;
  const searchWindow = input.human.slice(Math.max(0, searchStart - 1), lastNewIndex + 1);
  const searchRequests = voiceSearchRequestCandidates(searchWindow).filter(
    ({ segment }) =>
      validNewIds.has(segment.id) || (segment.endedAt ?? segment.startedAt).getTime() >= earliestRequestEnd,
  );
  const voiceRuns = await listAmbientDetectionVoiceRuns({
    meeting: input.meeting,
    searchRequests,
    logger: input.logger,
  });
  const voiceMentions =
    searchRequests.length !== 0
      ? matchVoiceSearchMentions({
          meetingId: input.meeting.id,
          segments: searchWindow,
          runs: voiceRuns,
        })
      : [];

  const persistedCount = await parsed.entities.reduce<Promise<number>>(async (countPromise, entity) => {
    const count = await countPromise;
    const added = await persistAmbientDetectedEntity({
      entity,
      batch: input.batch,
      human: input.human,
      meeting: input.meeting,
      validNewIds,
      searchWindow,
      searchRequests,
      voiceMentions,
      logger: input.logger,
    });

    return count + added;
  }, Promise.resolve(0));

  const lastProcessedSegment = input.batch.at(-1) ?? firstSegment;
  await repositories().updateMeetingAmbientContextCursor({
    meetingId: input.meeting.id,
    lastProcessedSegmentId: lastProcessedSegment.id,
    processedThrough: lastProcessedSegment.endedAt ?? lastProcessedSegment.startedAt,
  });

  return persistedCount;
}

async function runAmbientContextDetectionJobUnlocked(input: {
  job: AiWorkflowJobView;
  logger: LoggerLike;
}): Promise<AmbientDetectionJobResult> {
  const startedAt = Date.now();
  if (!apiEnv().AMBIENT_CONTEXT_ENABLED) {
    return { detected: 0, disabled: true };
  }
  const [meeting, transcript, cursor] = await Promise.all([
    repositories().getMeetingById(input.job.meetingId),
    repositories().getTranscriptForMeeting(input.job.meetingId),
    repositories().getMeetingAmbientContextCursor(input.job.meetingId),
  ]);
  if (meeting === null || transcript === null) {
    return { detected: 0, missingMeeting: meeting === null };
  }
  const activeMeeting = meeting;
  const human = transcript.segments.filter((segment) => segment.speakerRole === "human");
  if (human.length === 0) {
    return { detected: 0 };
  }
  const cursorIndex = ambientContextCursorIndex(human, cursor);
  const pendingSegments = human.slice(cursorIndex + 1);
  if (pendingSegments.length === 0) {
    return { detected: 0 };
  }
  const settledCount = ambientContextSettledSegmentCount(pendingSegments);
  const newSegments = pendingSegments.slice(0, settledCount);
  const deferredSegments = pendingSegments.slice(settledCount);
  if (newSegments.length === 0) {
    input.logger.info(
      {
        meetingId: activeMeeting.id,
        deferredSegments: deferredSegments.length,
        durationMs: Date.now() - startedAt,
      },
      LOG_MESSAGE_TRANSCRIPT_TAIL_DEFERRED,
    );

    return { detected: 0, deferred: pendingSegments.length };
  }
  const detected = await processAmbientDetectionBatch({
    batch: newSegments,
    human,
    meeting: activeMeeting,
    logger: input.logger,
  });
  input.logger.info(
    {
      meetingId: activeMeeting.id,
      detected,
      detector: "openai",
      processedSegments: newSegments.length,
      deferredSegments: deferredSegments.length,
      durationMs: Date.now() - startedAt,
    },
    LOG_MESSAGE_TRANSCRIPT_WINDOW_PROCESSED,
  );

  return { detected, processed: newSegments.length, deferred: deferredSegments.length };
}

type AmbientDetectionJobLockResult = AmbientDetectionJobResult & {
  /** @external workflow job result */
  automaticDetectionStopped?: boolean;
};

export async function runAmbientContextDetectionJob(input: {
  job: AiWorkflowJobView;
  logger: LoggerLike;
}): Promise<AmbientDetectionJobLockResult> {
  const result = await repositories().withMeetingAmbientContextDetectionLock(input.job.meetingId, () =>
    runAmbientContextDetectionJobUnlocked(input),
  );
  if (result !== null) {
    return result;
  }
  if ((await repositories().getMeetingById(input.job.meetingId)) === null) {
    return { detected: 0, missingMeeting: true };
  }

  return { detected: 0, automaticDetectionStopped: true };
}

function citationsFromSearch(response: ParallelSearchResponse): AmbientContextCitation[] {
  return (response.results ?? [])
    .flatMap((result) => {
      if (!isNonEmptyString(result.url) || !isNonEmptyString(result.title)) {
        return [];
      }
      try {
        const url = new URL(result.url);

        return [
          ambientContextCitationSchema.parse({
            title: result.title.slice(0, CITATION_TITLE_MAX_LENGTH),
            url: url.toString(),
            domain: url.hostname.replace(/^www\./, ""),
            excerpt:
              result.excerpts?.find((excerpt) => isNonEmptyString(excerpt))?.slice(0, CITATION_EXCERPT_MAX_LENGTH) ??
              null,
          }),
        ];
      } catch (error) {
        if (error instanceof TypeError) {
          return [];
        }
        throw error;
      }
    })
    .slice(0, MAX_CITATIONS);
}

function searchBody(item: MeetingAmbientContextItem) {
  const identity = [item.displayName, item.qualifier].filter((part) => isNonEmptyString(part)).join(" at ");
  const privacy =
    item.entityKind === "person"
      ? "Use only public professional information. Exclude private contact details, home or family information, sensitive traits, and speculation."
      : "Prefer the official company website and reputable business or technology reporting.";

  return {
    objective: `Research public context about ${identity}. Verify identity, current professional or company basics, and recent developments relevant to these facets: ${item.facets.length !== 0 ? item.facets.join(", ") : "general professional context"}. ${privacy}`,
    search_queries:
      item.entityKind === "person"
        ? [`${identity} professional role`, `${identity} recent professional news`]
        : [
            `${item.displayName} official headquarters`,
            `${item.displayName} latest company news ${item.facets.join(" ")}`,
          ],
    mode: "turbo",
    max_chars_total: PARALLEL_SEARCH_MAX_CHARS,
    advanced_settings: { fetch_policy: { max_age_seconds: PARALLEL_FETCH_MAX_AGE_SECONDS } },
  };
}

function verifiedAmbientCompanyWebsiteNamed(input: { value: string | null; sourceUrls: string[] }): string | null {
  if (!isNonEmptyString(input.value)) {
    return null;
  }
  try {
    const website = new URL(input.value);
    if (website.protocol !== "https:" || website.username.length > 0 || website.password.length > 0) {
      return null;
    }
    const isHomepage = website.pathname === "/" && website.search.length === 0 && website.hash.length === 0;
    const isSupported = input.sourceUrls.some((source) => {
      try {
        const url = new URL(source);

        return url.toString() === website.toString() || (isHomepage && url.origin === website.origin);
      } catch (error) {
        if (error instanceof TypeError) {
          return false;
        }
        throw error;
      }
    });

    return isSupported ? website.toString() : null;
  } catch (error) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function hasCompanyIdentitySourceNamed(input: { citations: AmbientContextCitation[]; domain: string }): boolean {
  const { citations, domain } = input;
  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = new RegExp(`(^|[^a-z0-9._-])(?:www\\.)?${escapedDomain}(?![a-z0-9_-]|\\.[a-z0-9-])`, "i");

  return citations.some(
    (citation) =>
      sourceMatchesCompanyDomain({ url: citation.url, domain }) ||
      reference.test(`${citation.title}\n${citation.excerpt ?? ""}`),
  );
}

function normalizedResearchWords(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function researchTextContainsWords(input: { text: string; value: string }) {
  const words = normalizedResearchWords(input.value);

  return words.length !== 0 && ` ${normalizedResearchWords(input.text).join(" ")} `.includes(` ${words.join(" ")} `);
}

function researchTextContainsName(input: { text: string; name: string }) {
  const escaped = input.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(input.text);
}

function selectAmbientResearchSourcesNamed(input: {
  item: Pick<MeetingAmbientContextItem, "entityKind" | "displayName" | "qualifier">;
  synthesis: ReturnType<typeof parseAmbientResearchSynthesis>;
  citations: AmbientContextCitation[];
}): AmbientContextCitation[] {
  const { item, synthesis, citations } = input;
  if (synthesis.sourceIds) {
    const selected = new Set(synthesis.sourceIds);

    return citations.flatMap((citation, index) => {
      const id = `s${index + 1}`;
      if (!selected.has(id)) {
        return [];
      }

      return [
        {
          ...citation,
          ...(synthesis.identityVerified === true && synthesis.articleSourceIds.includes(id)
            ? { isArticle: true }
            : {}),
        },
      ];
    });
  }

  return selectAmbientResearchSourcesWithoutIds({ item, synthesis, citations });
}

function selectAmbientResearchSourcesWithoutIds(input: {
  item: Pick<MeetingAmbientContextItem, "entityKind" | "displayName" | "qualifier">;
  synthesis: ReturnType<typeof parseAmbientResearchSynthesis>;
  citations: AmbientContextCitation[];
}): AmbientContextCitation[] {
  const { item, synthesis, citations } = input;
  const domain = item.entityKind === "company" ? explicitCompanyDomain(item.displayName) : null;
  const officialWebsite =
    item.entityKind === "company"
      ? verifiedAmbientCompanyWebsiteNamed({
          value: synthesis.officialWebsite,
          sourceUrls: citations.map((citation) => citation.url),
        })
      : null;
  const qualifierWords = normalizedResearchWords(item.qualifier ?? "").filter(
    (word) => !["at", "of", "the", "inc", "ltd", "llc", "corp", "corporation"].includes(word),
  );
  const professionalIdentity = normalizedResearchWords(
    `${synthesis.companyName ?? ""} ${synthesis.professionalTitle ?? ""}`,
  );
  const isCorroboratedPerson =
    item.entityKind === "person" &&
    synthesis.identityVerified === true &&
    normalizedResearchWords(item.displayName).length >= MIN_PERSON_NAME_WORDS &&
    qualifierWords.length !== 0 &&
    qualifierWords.every((word) => professionalIdentity.includes(word));
  const personContextHosts = isCorroboratedPerson
    ? citations
        .filter((citation) =>
          qualifierWords.every((word) =>
            normalizedResearchWords(`${citation.title} ${citation.excerpt ?? ""}`).includes(word),
          ),
        )
        .map((citation) => new URL(citation.url).hostname.replace(/^www\./, ""))
    : [];

  return citations.filter((citation) =>
    ambientCitationMatchesLegacyResearch({
      item,
      synthesis,
      citation,
      domain,
      officialWebsite,
      personContextHosts,
    }),
  );
}

function ambientCitationMatchesLegacyResearch(input: {
  item: Pick<MeetingAmbientContextItem, "entityKind" | "displayName" | "qualifier">;
  synthesis: ReturnType<typeof parseAmbientResearchSynthesis>;
  citation: AmbientContextCitation;
  domain: string | null;
  officialWebsite: string | null;
  personContextHosts: string[];
}): boolean {
  if (input.domain !== null) {
    return hasCompanyIdentitySourceNamed({ citations: [input.citation], domain: input.domain });
  }
  const citationText = `${input.citation.title}\n${input.citation.excerpt ?? ""}`;
  if (
    input.personContextHosts.some((host) => sourceMatchesCompanyDomain({ url: input.citation.url, domain: host })) &&
    researchTextContainsWords({ text: citationText, value: input.item.displayName })
  ) {
    return true;
  }
  if (input.synthesis.identityVerified === true) {
    if (
      isNonEmptyString(input.officialWebsite) &&
      sourceMatchesCompanyDomain({ url: input.citation.url, domain: new URL(input.officialWebsite).hostname })
    ) {
      return true;
    }
    if (
      input.item.entityKind === "person" &&
      isNonEmptyString(input.synthesis.profileUrl) &&
      new URL(input.citation.url).toString() === new URL(input.synthesis.profileUrl).toString()
    ) {
      return true;
    }
  }

  return (
    researchTextContainsName({ text: citationText, name: input.item.displayName }) &&
    (!isNonEmptyString(input.item.qualifier) ||
      researchTextContainsName({ text: citationText, name: input.item.qualifier }))
  );
}

async function synthesizeAmbientResearchNamed(input: {
  meetingId: string;
  item: Pick<MeetingAmbientContextItem, "entityKind" | "displayName" | "qualifier" | "facets">;
  citations: AmbientContextCitation[];
}) {
  const raw = await runJsonModel({
    meetingId: input.meetingId,
    system: AMBIENT_RESEARCH_SYSTEM_PROMPT,
    model: apiEnv().OPENAI_AMBIENT_RESEARCH_MODEL,
    user: {
      entity: {
        kind: input.item.entityKind,
        name: input.item.displayName,
        qualifier: input.item.qualifier,
        facets: input.item.facets,
      },
      searchResults: input.citations.map((citation, index) => ({ id: `s${index + 1}`, ...citation })),
    },
    maxOutputTokens: RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS,
  });
  const parsed = parseAmbientResearchSynthesis(raw);
  const selectedCitations = selectAmbientResearchSourcesNamed({
    item: input.item,
    synthesis: parsed,
    citations: input.citations,
  });
  const allowedUrls = new Set(selectedCitations.map((citation) => new URL(citation.url).toString()));
  const domain = input.item.entityKind === "company" ? explicitCompanyDomain(input.item.displayName) : null;
  const referencedHomepage =
    isNonEmptyString(parsed.officialWebsite) &&
    domain !== null &&
    explicitCompanyDomain(parsed.officialWebsite) === domain &&
    parsed.officialWebsite.startsWith("https://") &&
    hasCompanyIdentitySourceNamed({ citations: selectedCitations, domain })
      ? parsed.officialWebsite
      : null;

  return {
    ...parsed,
    citations: selectedCitations,
    officialWebsite:
      verifiedAmbientCompanyWebsiteNamed({ value: parsed.officialWebsite, sourceUrls: [...allowedUrls] }) ??
      referencedHomepage,
    profileUrl:
      isNonEmptyString(parsed.profileUrl) && allowedUrls.has(new URL(parsed.profileUrl).toString())
        ? new URL(parsed.profileUrl).toString()
        : null,
  };
}

function parseAmbientResearchSynthesis(value: unknown): z.infer<typeof synthesisOutputSchema> {
  // A negative identity verdict is settled research, even if the model omits
  // fields that will never be published. Do not retry paid search for a null
  // summary or malformed identity fields on an explicitly rejected identity.
  if (isRecord(value) && "identityVerified" in value) {
    const verdict = value.identityVerified;
    if (
      verdict !== undefined &&
      verdict !== true &&
      !(typeof verdict === "string" && verdict.trim().toLowerCase() === "true")
    ) {
      return synthesisOutputSchema.parse({
        /** @external model synthesis field */
        identityVerified: false,
        sourceIds: [],
        summary: AMBIENT_IDENTITY_UNVERIFIED,
        facts: [],
      });
    }
  }

  return synthesisOutputSchema.parse(value);
}

function ambientResearchIdentityVerifiedNamed(input: {
  item: Pick<MeetingAmbientContextItem, "entityKind" | "displayName">;
  synthesis: ReturnType<typeof parseAmbientResearchSynthesis>;
}): boolean {
  // An explicit negative applies to every entity. Absence remains compatible
  // with valid older non-domain synthesis responses.
  if (input.synthesis.identityVerified === false) {
    return false;
  }
  const domain = input.item.entityKind === "company" ? explicitCompanyDomain(input.item.displayName) : null;

  return (
    domain === null ||
    (input.synthesis.identityVerified === true &&
      isNonEmptyString(input.synthesis.officialWebsite) &&
      sourceMatchesCompanyDomain({ url: input.synthesis.officialWebsite, domain }))
  );
}

function ambientContextResearchWasCommittedForJobNamed(input: {
  item: Pick<MeetingAmbientContextItem, "researchCompletedAt" | "summary">;
  job: Pick<AiWorkflowJobView, "createdAt">;
}): boolean {
  if (!isNonEmptyString(input.item.summary) || !isNonEmptyString(input.item.researchCompletedAt)) {
    return false;
  }
  const completedAt = Date.parse(input.item.researchCompletedAt);
  const createdAt = Date.parse(input.job.createdAt);

  return Number.isFinite(completedAt) && Number.isFinite(createdAt) && completedAt >= createdAt;
}

function ambientContextResearchJobCoversFacetsNamed(input: {
  item: Pick<MeetingAmbientContextItem, "id" | "facets">;
  job: Pick<AiWorkflowJobView, "scopeKey">;
}): boolean {
  const expectedScope = repositories().ambientContextResearchJobScope(input.item);

  return input.job.scopeKey === expectedScope || input.job.scopeKey === `${expectedScope}:manual`;
}

type AmbientEntityResearchState = {
  item: StoredMeetingAmbientContextItem;
  startingFacets: string;
  isCommitted: boolean;
  published: StoredMeetingAmbientContextItem | null;
  searchMs: number;
  synthesisMs: number;
  sources: number;
  isQueuedImage: boolean;
  isStopped: boolean;
};

type AmbientEntityResearchJobWireResult = {
  itemId: string;
  /** @external workflow job result */
  missing?: boolean;
  status?: string;
  reason?: string;
  deferUntil?: string;
  /** @external workflow job result */
  skipped?: boolean;
};

function createAmbientEntityResearchState(input: {
  storedItem: StoredMeetingAmbientContextItem;
  job: Pick<AiWorkflowJobView, "createdAt">;
}): AmbientEntityResearchState {
  const isCommitted = ambientContextResearchWasCommittedForJobNamed({ item: input.storedItem, job: input.job });

  return {
    item: input.storedItem,
    startingFacets: [...input.storedItem.facets].sort().join("|"),
    isCommitted,
    published: isCommitted ? input.storedItem : null,
    searchMs: 0,
    synthesisMs: 0,
    sources: input.storedItem.citations.length,
    isQueuedImage: false,
    isStopped: false,
  };
}

async function stopUnverifiedAmbientEntityResearch(input: {
  research: AmbientEntityResearchState;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  error: string;
  rejection: "company_domain" | "identity_verdict" | "no_selected_sources";
  logger: LoggerLike;
}): Promise<{ research: AmbientEntityResearchState; result: AmbientEntityResearchJobWireResult }> {
  input.logger.warn(
    {
      meetingId: input.meeting.id,
      itemId: input.itemId,
      entityKind: input.research.item.entityKind,
      rejection: input.rejection,
      sourceCount: input.research.sources,
      searchDurationMs: input.research.searchMs,
      synthesisDurationMs: input.research.synthesisMs,
      synthesisModel: apiEnv().OPENAI_AMBIENT_RESEARCH_MODEL,
    },
    LOG_MESSAGE_AMBIENT_RESEARCH_IDENTITY_REJECTED,
  );
  const hasPublishedSummary =
    isNonEmptyString(input.research.item.summary) && input.research.item.citations.length !== 0;
  const status = hasPublishedSummary ? ("ready" as const) : ("failed" as const);
  await repositories().updateMeetingAmbientContextItem({
    meetingId: input.meeting.id,
    itemId: input.itemId,
    status,
    error: input.error,
    ...(hasPublishedSummary
      ? {
          researchCompletedAt: isNonEmptyString(input.research.item.researchCompletedAt)
            ? new Date(input.research.item.researchCompletedAt)
            : null,
        }
      : {
          summary: null,
          facts: [],
          citations: [],
          officialWebsite: null,
          professionalTitle: null,
          companyName: null,
          headquarters: null,
          profileUrl: null,
          imageStatus: "unavailable" as const,
          imageStorageKey: null,
          imageMimeType: null,
          researchCompletedAt: null,
        }),
  });
  await repositories().publishAmbientContextRealtimeUpdate({
    workspaceId: input.meeting.workspaceId,
    meetingId: input.meeting.id,
    itemId: input.itemId,
    status,
  });

  return {
    research: { ...input.research, isStopped: true },
    result: { itemId: input.itemId, status, reason: input.error },
  };
}

type AmbientVoiceOwnershipRecheckResult =
  | { itemId: string; status: "pending"; deferUntil: string }
  | { itemId: string; status: "suppressed"; reason: string }
  | {
      itemId: string;
      status: string | undefined;
      /** @external workflow job result */
      skipped: true;
    };

function shouldSkipAmbientVoiceOwnershipRecheck(input: {
  job: AiWorkflowJobView;
  research: AmbientEntityResearchState;
  mentionSegmentIds: string[];
}): boolean {
  return (
    input.job.payload.voiceSearchCheck !== true ||
    input.job.scopeKey.endsWith(":manual") ||
    isNonEmptyString(input.research.item.summary) ||
    input.mentionSegmentIds.length === 0 ||
    input.research.item.mentionCount !== input.mentionSegmentIds.length
  );
}

async function loadAmbientVoiceOwnershipEvidence(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  research: AmbientEntityResearchState;
  firstMention: number;
  mentionSegmentIds: string[];
}) {
  const segments = await repositories().listTranscriptSegmentsInWindow({
    meetingId: input.meeting.id,
    since: new Date(input.firstMention),
    until: new Date(input.firstMention),
    includePrevious: true,
    segmentIds: input.mentionSegmentIds,
  });
  const requests = voiceSearchRequestCandidates(segments).filter(
    ({ segment }) =>
      segment.startedAt.getTime() === input.firstMention &&
      Date.parse(input.research.item.lastMentionedAt) <=
        (segment.endedAt ?? segment.startedAt).getTime() + VOICE_SEARCH_MATCH_WINDOW_MS,
  );
  const runs =
    requests.length !== 0
      ? await repositories().listVoiceSearchEvidenceForMeeting({
          meetingId: input.meeting.id,
          since: new Date(input.firstMention - VOICE_EVIDENCE_LOOKBACK_MS),
          until: new Date(
            Math.max(...requests.map(({ segment }) => (segment.endedAt ?? segment.startedAt).getTime())) +
              VOICE_SEARCH_MATCH_WINDOW_MS,
          ),
        })
      : [];
  const mentions = matchVoiceSearchMentions({ meetingId: input.meeting.id, segments, runs });
  const ownedIds = voiceSearchOwnedSegmentIds({
    segments,
    mentions,
    displayName: input.research.item.displayName,
  });

  return { segments, runs, ownedIds, deadline: input.firstMention + VOICE_FALLBACK_WAIT_MS };
}

function pendingAmbientVoiceOwnershipDefer(input: {
  itemId: string;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  research: AmbientEntityResearchState;
  mentionSegmentIds: string[];
  segments: Awaited<ReturnType<RepositoryPort["listTranscriptSegmentsInWindow"]>>;
  runs: Awaited<ReturnType<RepositoryPort["listVoiceSearchEvidenceForMeeting"]>>;
  ownedIds: Set<string>;
  deadline: number;
}): AmbientVoiceOwnershipRecheckResult | undefined {
  if (input.mentionSegmentIds.every((id) => input.ownedIds.has(id)) || Date.now() >= input.deadline) {
    return undefined;
  }
  const activeMentions = matchVoiceSearchMentions({
    meetingId: input.meeting.id,
    segments: input.segments,
    runs: input.runs,
    includeActive: true,
  });
  const pendingIds = voiceSearchOwnedSegmentIds({
    segments: input.segments,
    mentions: activeMentions,
    displayName: input.research.item.displayName,
  });
  if (!input.mentionSegmentIds.every((id) => pendingIds.has(id))) {
    return undefined;
  }

  return {
    itemId: input.itemId,
    status: "pending" as const,
    deferUntil: new Date(Math.min(Date.now() + VOICE_FALLBACK_RECHECK_MS, input.deadline)).toISOString(),
  };
}

async function resolveOwnedAmbientVoiceMention(input: {
  check: number;
  job: AiWorkflowJobView;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
  firstMention: number;
  mentionSegmentIds: string[];
}): Promise<{ ownership: AmbientVoiceOwnershipRecheckResult | undefined; research: AmbientEntityResearchState }> {
  if (
    await repositories().deleteUnchangedAmbientVoiceDuplicate({
      meetingId: input.meeting.id,
      itemId: input.itemId,
      canonicalKey: input.research.item.canonicalKey,
      mentionCount: input.research.item.mentionCount,
    })
  ) {
    await repositories().publishAmbientContextRealtimeUpdate({
      workspaceId: input.meeting.workspaceId,
      meetingId: input.meeting.id,
      itemId: input.itemId,
      status: "failed",
    });

    return {
      ownership: { itemId: input.itemId, status: "suppressed" as const, reason: AMBIENT_VOICE_SEARCH_HANDLED },
      research: { ...input.research, isStopped: true },
    };
  }
  const current = await repositories().getMeetingAmbientContextItem({
    meetingId: input.meeting.id,
    itemId: input.itemId,
  });
  if (current === null || isNonEmptyString(current.summary) || current.status !== "pending") {
    return {
      ownership: { itemId: input.itemId, status: current?.status, skipped: true },
      research: input.research,
    };
  }
  if (input.check >= VOICE_OWNERSHIP_RECHECK_LIMIT) {
    throw new AmbientVoiceOwnershipChangingError();
  }

  // Re-evaluate all evidence on the refreshed item (as main does), including its new mention segments.
  return recheckAmbientVoiceOwnershipAtResearch({
    ...input,
    check: input.check + 1,
    research: { ...input.research, item: current, startingFacets: [...current.facets].sort().join("|") },
    mentionSegmentIds: ambientMentionSegmentIds(current),
  });
}

async function recheckAmbientVoiceOwnershipAtResearch(input: {
  check: number;
  job: AiWorkflowJobView;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
  firstMention: number;
  mentionSegmentIds: string[];
}): Promise<{ ownership: AmbientVoiceOwnershipRecheckResult | undefined; research: AmbientEntityResearchState }> {
  if (shouldSkipAmbientVoiceOwnershipRecheck(input)) {
    return { ownership: undefined, research: input.research };
  }
  const evidence = await loadAmbientVoiceOwnershipEvidence(input);
  const deferred = pendingAmbientVoiceOwnershipDefer({
    itemId: input.itemId,
    meeting: input.meeting,
    research: input.research,
    mentionSegmentIds: input.mentionSegmentIds,
    segments: evidence.segments,
    runs: evidence.runs,
    ownedIds: evidence.ownedIds,
    deadline: evidence.deadline,
  });
  if (deferred !== undefined) {
    return { ownership: deferred, research: input.research };
  }
  if (!input.mentionSegmentIds.every((id) => evidence.ownedIds.has(id))) {
    return { ownership: undefined, research: input.research };
  }

  return resolveOwnedAmbientVoiceMention(input);
}

async function beginAmbientResearchProgress(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
}) {
  await repositories().updateMeetingAmbientContextItem({
    meetingId: input.meeting.id,
    itemId: input.itemId,
    status: "researching",
    error: null,
    researchStartedAt: new Date(),
  });
  await repositories().publishAmbientContextRealtimeUpdate({
    workspaceId: input.meeting.workspaceId,
    meetingId: input.meeting.id,
    itemId: input.itemId,
    status: "researching",
  });

  return input.research;
}

async function runParallelAmbientSearch(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
}) {
  const client = parallelClientFromEnv();
  if (client === null) {
    throw new Error(MESSAGE_PARALLEL_API_KEY_NOT_CONFIGURED);
  }
  const searchStartedAt = Date.now();
  const response = await client.searchCompanyLatestSignals(
    searchBody(input.research.item),
    AbortSignal.timeout(PARALLEL_SEARCH_TIMEOUT_MS),
  );

  const citations = citationsFromSearch(response);

  return {
    research: {
      ...input.research,
      searchMs: Date.now() - searchStartedAt,
      sources: citations.length,
    },
    citations,
  };
}

async function publishSynthesizedAmbientResearch(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
  citations: AmbientContextCitation[];
  logger: LoggerLike;
}): Promise<
  | { research: AmbientEntityResearchState; stopResult: AmbientEntityResearchJobWireResult }
  | { research: AmbientEntityResearchState; stopResult?: undefined }
> {
  const synthesisStartedAt = Date.now();
  const synthesis = await synthesizeAmbientResearchNamed({
    meetingId: input.meeting.id,
    item: input.research.item,
    citations: input.citations,
  });
  const researched = { ...input.research, synthesisMs: Date.now() - synthesisStartedAt };
  if (!ambientResearchIdentityVerifiedNamed({ item: researched.item, synthesis })) {
    const stopped = await stopUnverifiedAmbientEntityResearch({
      research: researched,
      meeting: input.meeting,
      itemId: input.itemId,
      error: AMBIENT_IDENTITY_UNVERIFIED,
      rejection: "identity_verdict",
      logger: input.logger,
    });

    return { research: stopped.research, stopResult: stopped.result };
  }
  if (synthesis.citations.length === 0) {
    const stopped = await stopUnverifiedAmbientEntityResearch({
      research: researched,
      meeting: input.meeting,
      itemId: input.itemId,
      error: AMBIENT_IDENTITY_UNVERIFIED,
      rejection: "no_selected_sources",
      logger: input.logger,
    });

    return { research: stopped.research, stopResult: stopped.result };
  }
  const published = await repositories().updateMeetingAmbientContextItem({
    meetingId: input.meeting.id,
    itemId: input.itemId,
    status: "ready",
    professionalTitle: researched.item.entityKind === "person" ? synthesis.professionalTitle : null,
    companyName: researched.item.entityKind === "person" ? synthesis.companyName : null,
    headquarters: researched.item.entityKind === "company" ? synthesis.headquarters : null,
    officialWebsite: researched.item.entityKind === "company" ? synthesis.officialWebsite : null,
    profileUrl: researched.item.entityKind === "person" ? synthesis.profileUrl : null,
    summary: synthesis.summary,
    facts: synthesis.facts,
    citations: synthesis.citations,
    error: null,
    researchCompletedAt: new Date(),
  });
  if (published === null) {
    throw new Error(MESSAGE_AMBIENT_ITEM_DISAPPEARED_COMMIT);
  }

  return {
    research: {
      ...researched,
      sources: synthesis.citations.length,
      published,
      isCommitted: true,
    },
  };
}

async function executeParallelAmbientEntityResearch(input: {
  job: AiWorkflowJobView;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
  logger: LoggerLike;
}): Promise<
  | { research: AmbientEntityResearchState; stopResult: AmbientEntityResearchJobWireResult }
  | { research: AmbientEntityResearchState; stopResult?: undefined }
> {
  const requestedAt = input.job.payload.voiceSearchRequestedAt;
  const firstMention =
    typeof requestedAt === "string" && Number.isFinite(Date.parse(requestedAt))
      ? Date.parse(requestedAt)
      : Date.parse(input.research.item.firstMentionedAt);
  const voiceCheck = await recheckAmbientVoiceOwnershipAtResearch({
    check: 0,
    job: input.job,
    meeting: input.meeting,
    itemId: input.itemId,
    research: input.research,
    firstMention,
    mentionSegmentIds: ambientMentionSegmentIds(input.research.item),
  });
  if (voiceCheck.ownership !== undefined) {
    return { research: voiceCheck.research, stopResult: voiceCheck.ownership };
  }
  const inProgress = await beginAmbientResearchProgress({
    meeting: input.meeting,
    itemId: input.itemId,
    research: voiceCheck.research,
  });
  const searched = await runParallelAmbientSearch({
    meeting: input.meeting,
    itemId: input.itemId,
    research: inProgress,
  });
  const requestedDomain =
    searched.research.item.entityKind === "company" ? explicitCompanyDomain(searched.research.item.displayName) : null;
  if (
    requestedDomain !== null &&
    !hasCompanyIdentitySourceNamed({ citations: searched.citations, domain: requestedDomain })
  ) {
    const stopped = await stopUnverifiedAmbientEntityResearch({
      research: searched.research,
      meeting: input.meeting,
      itemId: input.itemId,
      error: AMBIENT_IDENTITY_UNVERIFIED,
      rejection: "company_domain",
      logger: input.logger,
    });

    return { research: stopped.research, stopResult: stopped.result };
  }
  if (searched.citations.length === 0) {
    throw new Error(MESSAGE_PARALLEL_SEARCH_NO_SOURCES);
  }

  return publishSynthesizedAmbientResearch({
    meeting: input.meeting,
    itemId: input.itemId,
    research: searched.research,
    citations: searched.citations,
    logger: input.logger,
  });
}

async function restoreAmbientResearchPublishedReady(input: {
  job: AiWorkflowJobView;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
}) {
  if (
    input.research.published === null ||
    input.research.published.status === "ready" ||
    !ambientContextResearchJobCoversFacetsNamed({ item: input.research.published, job: input.job })
  ) {
    return input.research;
  }
  const restored = await repositories().updateMeetingAmbientContextItem({
    meetingId: input.meeting.id,
    itemId: input.itemId,
    status: "ready",
    error: null,
  });
  if (restored === null) {
    throw new Error(MESSAGE_AMBIENT_ITEM_DISAPPEARED_RESTORE);
  }

  return { ...input.research, published: restored };
}

async function scheduleAmbientResearchFollowUpOrImage(input: {
  job: AiWorkflowJobView;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
  logger: LoggerLike;
}) {
  const latest = await repositories().getMeetingAmbientContextItem({
    meetingId: input.meeting.id,
    itemId: input.itemId,
  });
  const isFacetsChanged =
    latest !== null &&
    (input.research.isCommitted && input.research.published === input.research.item
      ? !ambientContextResearchJobCoversFacetsNamed({ item: latest, job: input.job })
      : [...latest.facets].sort().join("|") !== input.research.startingFacets);
  if (latest !== null && isFacetsChanged) {
    const inlineAttempt = typeof input.job.payload.inlineAttempt === "number" ? input.job.payload.inlineAttempt : 1;
    if (inlineAttempt < AMBIENT_WORKFLOW_MAX_ATTEMPTS) {
      await runAiWorkflowInRequest({
        meetingId: input.meeting.id,
        type: "research_ambient_entity",
        scopeKey: repositories().ambientContextResearchJobScope(latest),
        payload: { itemId: input.itemId, inlineAttempt: inlineAttempt + 1 },
        maxAttempts: AMBIENT_WORKFLOW_MAX_ATTEMPTS,
        logger: input.logger,
      });
    } else {
      throw new Error(MESSAGE_AMBIENT_ITEM_DISAPPEARED_FOLLOW_UP);
    }

    return input.research;
  }
  const imageSource = latest ?? input.research.published;
  const publishedImageStorageKey = imageSource === null ? null : ambientImageStorageKey(imageSource.imageStorageKey);
  if (imageSource !== null && imageSource.imageStatus === "pending" && !isNonEmptyString(publishedImageStorageKey)) {
    await runAiWorkflowInRequest({
      meetingId: input.meeting.id,
      type: "enrich_ambient_context_image",
      scopeKey: `ambient-image:${input.itemId}`,
      payload: { itemId: input.itemId },
      maxAttempts: AMBIENT_WORKFLOW_MAX_ATTEMPTS,
      logger: input.logger,
    });

    return { ...input.research, isQueuedImage: true };
  }

  return input.research;
}

async function finalizeAmbientEntityResearchJob(input: {
  job: AiWorkflowJobView;
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  research: AmbientEntityResearchState;
  startedAt: number;
  logger: LoggerLike;
}): Promise<AmbientEntityResearchState> {
  const restored = await restoreAmbientResearchPublishedReady(input);
  if (restored.published?.status === "ready") {
    await repositories().publishAmbientContextRealtimeUpdate({
      workspaceId: input.meeting.workspaceId,
      meetingId: input.meeting.id,
      itemId: input.itemId,
      status: "ready",
    });
  }
  const scheduled = await scheduleAmbientResearchFollowUpOrImage({ ...input, research: restored });
  input.logger.info(
    {
      meetingId: input.meeting.id,
      itemId: input.itemId,
      entityKind: scheduled.item.entityKind,
      backend: "parallel_search",
      researchMode: "turbo_search",
      sourceCount: scheduled.sources,
      durationMs: Date.now() - input.startedAt,
      searchDurationMs: scheduled.searchMs,
      synthesisDurationMs: scheduled.synthesisMs,
      readyPublishedMs: Date.now() - input.startedAt,
      isResearchReused: scheduled.published === scheduled.item,
      isImageQueued: scheduled.isQueuedImage,
      imageStatus: scheduled.published?.imageStatus ?? scheduled.item.imageStatus,
    },
    LOG_MESSAGE_AMBIENT_RESEARCH_COMPLETED,
  );

  return scheduled;
}

async function recordTerminalAmbientResearchFailure(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  itemId: string;
  job: AiWorkflowJobView;
  error: unknown;
}): Promise<Awaited<ReturnType<RepositoryPort["recordAmbientContextResearchFailure"]>>> {
  const failureMessage = input.error instanceof Error ? input.error.message : MESSAGE_AMBIENT_RESEARCH_FAILED;
  const recordedFailure = await repositories().recordAmbientContextResearchFailure({
    meetingId: input.meeting.id,
    itemId: input.itemId,
    jobId: input.job.id,
    error: failureMessage,
  });
  const isFinalChangingEvidence =
    input.job.attemptCount >= input.job.maxAttempts && input.error instanceof AmbientVoiceOwnershipChangingError;
  if (recordedFailure !== null || !isFinalChangingEvidence) {
    return recordedFailure;
  }

  return repositories().updateMeetingAmbientContextItem({
    meetingId: input.meeting.id,
    itemId: input.itemId,
    status: "failed",
    error: failureMessage,
  });
}

export async function runAmbientEntityResearchJob(input: {
  job: AiWorkflowJobView;
  logger: LoggerLike;
}): Promise<AmbientEntityResearchJobWireResult> {
  const startedAt = Date.now();
  const itemId = typeof input.job.payload.itemId === "string" ? input.job.payload.itemId : "";
  if (itemId.length === 0) {
    throw new Error(MESSAGE_AMBIENT_RESEARCH_JOB_MISSING_ITEM_ID);
  }
  const [meeting, storedItem] = await Promise.all([
    repositories().getMeetingById(input.job.meetingId),
    repositories().getMeetingAmbientContextItem({ meetingId: input.job.meetingId, itemId }),
  ]);
  if (meeting === null || storedItem === null) {
    return { itemId, missing: true };
  }
  const initialResearch = createAmbientEntityResearchState({ storedItem, job: input.job });
  if (
    initialResearch.item.error === AMBIENT_IDENTITY_UNVERIFIED ||
    initialResearch.item.error === AMBIENT_VOICE_SEARCH_HANDLED
  ) {
    await repositories().publishAmbientContextRealtimeUpdate({
      workspaceId: meeting.workspaceId,
      meetingId: meeting.id,
      itemId,
      status: initialResearch.item.status,
    });

    return { itemId, status: initialResearch.item.status, reason: initialResearch.item.error };
  }
  const executionSnapshot = { research: initialResearch };
  try {
    const executedResearch = initialResearch.isCommitted
      ? { research: initialResearch, stopResult: undefined }
      : await executeParallelAmbientEntityResearch({
          job: input.job,
          meeting,
          itemId,
          research: initialResearch,
          logger: input.logger,
        });
    executionSnapshot.research = executedResearch.research;
    if (executedResearch.stopResult !== undefined) {
      return executedResearch.stopResult;
    }
    await finalizeAmbientEntityResearchJob({
      job: input.job,
      meeting,
      itemId,
      research: executedResearch.research,
      startedAt,
      logger: input.logger,
    });

    return { itemId, status: "ready" as const };
  } catch (error) {
    if (executionSnapshot.research.isCommitted || executionSnapshot.research.isStopped) {
      input.logger.warn(
        {
          meetingId: meeting.id,
          itemId,
          error: error instanceof Error ? error.message : String(error),
        },
        LOG_MESSAGE_AMBIENT_HANDOFF_FAILED,
      );
      throw error;
    }
    const failedItem = await recordTerminalAmbientResearchFailure({
      meeting,
      itemId,
      job: input.job,
      error,
    });
    if (failedItem !== null) {
      await repositories().publishAmbientContextRealtimeUpdate({
        workspaceId: meeting.workspaceId,
        meetingId: meeting.id,
        itemId,
        status: failedItem.status,
      });
    }
    throw error;
  }
}

type AmbientImageEnrichmentJobWireResult = {
  itemId: string;
  /** @external workflow job result */
  missing?: boolean;
  status?: string;
  /** @external workflow job result */
  skipped?: boolean;
  /** @external workflow job result */
  deferred?: boolean;
};

async function enrichAmbientContextImageForItem(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  item: MeetingAmbientContextItem;
  itemId: string;
  startedAt: number;
  logger: LoggerLike;
}): Promise<AmbientImageEnrichmentJobWireResult> {
  const media = await enrichAmbientContextImage({
    kind: input.item.entityKind,
    verifiedPageUrl: input.item.entityKind === "person" ? input.item.profileUrl : input.item.officialWebsite,
    fallbackPageUrls: input.item.citations.map((citation) => citation.url),
    meetingId: input.meeting.id,
    itemId: input.itemId,
    displayName: input.item.displayName,
  });
  const updated = await repositories().updateMeetingAmbientContextItem({
    meetingId: input.meeting.id,
    itemId: input.itemId,
    imageStatus: media !== null ? "ready" : "unavailable",
    ...(media !== null ? { imageStorageKey: media.storageKey, imageMimeType: media.mimeType } : {}),
  });
  await repositories().publishAmbientContextRealtimeUpdate({
    workspaceId: input.meeting.workspaceId,
    meetingId: input.meeting.id,
    itemId: input.itemId,
    status: "ready",
  });
  input.logger.info(
    {
      meetingId: input.meeting.id,
      itemId: input.itemId,
      durationMs: Date.now() - input.startedAt,
      imageStatus: updated?.imageStatus ?? "unavailable",
    },
    LOG_MESSAGE_AMBIENT_IMAGE_COMPLETED,
  );

  return { itemId: input.itemId, status: updated?.imageStatus ?? "unavailable" };
}

export async function runAmbientContextImageEnrichmentJob(input: {
  job: AiWorkflowJobView;
  logger: LoggerLike;
}): Promise<AmbientImageEnrichmentJobWireResult> {
  const startedAt = Date.now();
  const itemId = typeof input.job.payload.itemId === "string" ? input.job.payload.itemId : "";
  if (itemId.length === 0) {
    throw new Error(MESSAGE_AMBIENT_IMAGE_JOB_MISSING_ITEM_ID);
  }
  const [meeting, item] = await Promise.all([
    repositories().getMeetingById(input.job.meetingId),
    repositories().getMeetingAmbientContextItem({ meetingId: input.job.meetingId, itemId }),
  ]);
  if (meeting === null || item === null) {
    return { itemId, missing: true };
  }
  if (isNonEmptyString(item.imageStorageKey)) {
    return { itemId, status: "ready" as const, skipped: true };
  }
  if (item.status !== "ready") {
    return { itemId, status: item.status, deferred: true };
  }

  try {
    return await enrichAmbientContextImageForItem({ meeting, item, itemId, startedAt, logger: input.logger });
  } catch (error) {
    if (input.job.attemptCount >= input.job.maxAttempts) {
      await repositories().updateMeetingAmbientContextItem({
        meetingId: meeting.id,
        itemId,
        imageStatus: "unavailable",
      });
    }
    input.logger.warn(
      {
        error,
        meetingId: meeting.id,
        itemId,
        durationMs: Date.now() - startedAt,
      },
      LOG_MESSAGE_AMBIENT_IMAGE_FAILED,
    );
    throw error;
  }
}

registerRequestWorkflowHandler({
  type: "detect_ambient_context",
  handler: ({ job, logger }) => runAmbientContextDetectionJob({ job, logger }),
});
registerRequestWorkflowHandler({
  type: "research_ambient_entity",
  handler: ({ job, logger }) => runAmbientEntityResearchJob({ job, logger }),
});
registerRequestWorkflowHandler({
  type: "enrich_ambient_context_image",
  handler: ({ job, logger }) => runAmbientContextImageEnrichmentJob({ job, logger }),
});
