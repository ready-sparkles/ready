import { z } from "zod";

import { MemoryGenerationRejected } from "./memory-diagnostics";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const MEMORY_MODEL_TIMEOUT_MINUTES = 10;
const MEMORY_EXTRACTION_API_BUFFER_MS = MINUTE_MS;

const MEMORY_LANGUAGE_MIN_LENGTH = 2;
const MEMORY_LANGUAGE_MAX_LENGTH = 40;
const MEMORY_IMPORTANCE_MAX = 4;
const MEMORY_FACT_SUBJECT_MAX_LENGTH = 500;
const MEMORY_FACT_PREDICATE_MAX_LENGTH = 200;
const MEMORY_FACT_OBJECT_MAX_LENGTH = 1800;
const MEMORY_FACT_CONTEXT_MAX_LENGTH = 500;
const MEMORY_FACT_KEY_MAX_LENGTH = 160;
const MEMORY_CANDIDATE_TITLE_MAX_LENGTH = 160;
const MEMORY_CANDIDATE_DESCRIPTION_MAX_LENGTH = 1800;
const MEMORY_PROJECTION_TEXT_MAX_LENGTH = 1200;
const MEMORY_PROJECTION_STANDING_TEXT_MAX_LENGTH = 500;
const MEMORY_PROJECTION_STANDING_MAX_ITEMS = 5;
const MEMORY_GENERATION_SUMMARY_MAX_ITEMS = 3;
const MEMORY_ACTION_IDS_MAX = 100;
const DEFAULT_MEMORY_CHUNK_MAX_CHARS = 48_000;
const MICROSECOND_PAD_LENGTH = 6;
const MICROSECOND_SLICE_START = 3;
const MICROSECOND_SLICE_END = 6;
const DEFAULT_MEMORY_IMPORTANCE = 1;
const COMPARE_EQUAL = 0;
const COMPARE_LEFT_GREATER = 1;
const COMPARE_LEFT_LESSER = -1;

const MSG_DUPLICATE_MEMORY_REFERENCE = "Duplicate new memory reference";
const MSG_UNKNOWN_PROJECTION_PERSON = "Unknown projection person";
const MSG_DUPLICATE_PROJECTION_PERSON = "Duplicate projection person";
const MSG_UNGROUNDED_CROSS_PERSON_SUMMARY = "Ungrounded or cross-person summary";
const MSG_INCOMPLETE_PERSON_SUMMARY = "Incomplete person summary sentence";
const MSG_MISSING_PERSON_SUMMARY = "Missing person summary";
const MSG_UNKNOWN_MEMORY_PERSON = "Unknown memory person";
const MSG_UNKNOWN_MEMORY_FACT = "Unknown memory fact";
const MSG_UNGROUNDED_MEMORY_EVIDENCE = "Ungrounded memory evidence";
const MSG_UNGROUNDED_PERSON_SUMMARY = "Ungrounded person summary";

const CODE_DUPLICATE_MEMORY_REFERENCE = "duplicate_memory_reference";
const CODE_UNKNOWN_PERSON = "unknown_person";
const CODE_DUPLICATE_PERSON = "duplicate_person";
const CODE_CROSS_PERSON_REFERENCE = "cross_person_reference";
const CODE_UNKNOWN_MEMORY_REFERENCE = "unknown_memory_reference";
const CODE_INCOMPLETE_SUMMARY = "incomplete_summary";
const CODE_MISSING_PERSON_SUMMARY = "missing_person_summary";
const CODE_UNKNOWN_FACT = "unknown_fact";
const CODE_UNGROUNDED_EVIDENCE = "ungrounded_evidence";

export const MEMORY_PROMPT_VERSION = "1.2.0";

// Per model call, not per meeting. Keep the API deadline outside this budget.
export const MEMORY_MODEL_TIMEOUT_MS = MEMORY_MODEL_TIMEOUT_MINUTES * MINUTE_MS;
export const MEMORY_EXTRACTION_REQUEST_TIMEOUT_MS = MEMORY_MODEL_TIMEOUT_MS + MEMORY_EXTRACTION_API_BUFFER_MS;
// A crashed worker's lease expires into terminal failure, never another attempt.

export const memoryCategories = [
  "Sales",
  "Customers",
  "Recruiting",
  "Team",
  "Projects",
  "Partnerships",
  "Investors",
  "Vendors",
  "Mentoring",
  "Networking",
  "Personal",
  "General",
] as const;
export const memoryCategorySchema = z.enum(memoryCategories);
const legacyMemoryCategories: Record<string, (typeof memoryCategories)[number]> = {
  "Customer Success": "Customers",
  "Team & Leadership": "Team",
  "Fundraising & Investors": "Investors",
  "Vendors & Services": "Vendors",
};
// Rename existing labels on reads without rewriting memories or triggering extraction.
export function normalizeMemoryCategory(category: string): string {
  return Object.hasOwn(legacyMemoryCategories, category) ? (legacyMemoryCategories[category] ?? category) : category;
}
export function memoryCategoryFilterValues(category: string): string[] {
  const canonical = normalizeMemoryCategory(category);

  return [canonical, ...Object.keys(legacyMemoryCategories).filter((key) => legacyMemoryCategories[key] === canonical)];
}
export const memoryPreferencesSchema = z.object({
  includeSensitive: z.boolean().default(false),
  language: z.string().trim().min(MEMORY_LANGUAGE_MIN_LENGTH).max(MEMORY_LANGUAGE_MAX_LENGTH).default("English"),
});
export type MemoryPreferences = z.infer<typeof memoryPreferencesSchema>;
export const memorySegmentSchema = z.object({
  id: z.string().uuid(),
  speakerUserId: z.string().uuid().nullable(),
  speakerName: z.string(),
  content: z.string(),
  startedAt: z.string(),
});
export const memoryEvidenceSchema = z.object({
  segmentId: z.string().uuid(),
  quote: z.string().min(1),
});
export const memoryImportanceSchema = z.number().int().min(1).max(MEMORY_IMPORTANCE_MAX);
// Canonical semantics, not display text, category, or evidence references.
export const memoryFactIdentitySchema = z.object({
  subject: z.string().trim().min(1).max(MEMORY_FACT_SUBJECT_MAX_LENGTH),
  predicate: z.string().trim().min(1).max(MEMORY_FACT_PREDICATE_MAX_LENGTH),
  object: z.string().trim().min(1).max(MEMORY_FACT_OBJECT_MAX_LENGTH),
  context: z.string().trim().max(MEMORY_FACT_CONTEXT_MAX_LENGTH),
});
export type MemoryFactIdentity = z.infer<typeof memoryFactIdentitySchema>;
export const memoryKnownFactSchema = z.object({
  key: z.string().min(1).max(MEMORY_FACT_KEY_MAX_LENGTH),
  identity: memoryFactIdentitySchema,
  suppressed: z.boolean(),
});
export const memoryCandidateSchema = z.object({
  // Optional on historical/UI records; required for newly generated candidates.
  factIdentity: memoryFactIdentitySchema.optional(),
  existingFactKey: z.string().min(1).max(MEMORY_FACT_KEY_MAX_LENGTH).nullable().optional(),
  // Optional only for compatibility with previously saved candidates; new model output requires it.
  importance: memoryImportanceSchema.optional(),
  title: z.string().trim().min(1).max(MEMORY_CANDIDATE_TITLE_MAX_LENGTH),
  description: z.string().trim().min(1).max(MEMORY_CANDIDATE_DESCRIPTION_MAX_LENGTH),
  category: memoryCategorySchema,
  personIds: z.array(z.string().uuid()).min(1),
  candidateSubjectId: z.string().uuid().nullable(),
  candidateSubjectKey: z.string().max(MEMORY_FACT_KEY_MAX_LENGTH).nullable(),
  sensitive: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(memoryEvidenceSchema).min(1),
});

export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export const memoryExtractionInputSchema = z.object({
  meetingId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  title: z.string(),
  occurredAt: z.string(),
  preferences: memoryPreferencesSchema,
  people: z.array(z.object({ id: z.string().uuid(), userId: z.string().uuid(), name: z.string() })),
  segments: z.array(memorySegmentSchema),
  segmentOrder: z.array(z.string().uuid()).optional(),
  knownFacts: z.array(memoryKnownFactSchema).optional(),
});
export type MemoryExtractionInput = z.infer<typeof memoryExtractionInputSchema>;
export const memoryProjectionSchema = z.object({
  summary: z.array(
    z.object({
      text: z.string().min(1).max(MEMORY_PROJECTION_TEXT_MAX_LENGTH),
      memoryIds: z.array(z.string().uuid()).min(1),
    }),
  ),
  standing: z
    .array(
      z.object({
        text: z.string().min(1).max(MEMORY_PROJECTION_STANDING_TEXT_MAX_LENGTH),
        memoryIds: z.array(z.string().uuid()).min(1),
      }),
    )
    .max(MEMORY_PROJECTION_STANDING_MAX_ITEMS),
});
export type MemoryProjection = z.infer<typeof memoryProjectionSchema>;
export const memoryProjectionInputSchema = z.object({
  meetingId: z.string().uuid().nullable(),
  personId: z.string().uuid(),
  name: z.string(),
  language: z.string(),
  memories: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      description: z.string(),
      occurredAt: z.string(),
    }),
  ),
});
export type MemoryProjectionInput = z.infer<typeof memoryProjectionInputSchema>;
export const memoryGenerationInputSchema = memoryExtractionInputSchema.extend({
  history: z.array(memoryProjectionInputSchema),
});
export type MemoryGenerationInput = z.infer<typeof memoryGenerationInputSchema>;
const memoryGenerationSentenceSchema = z.object({
  text: z.string().min(1).max(MEMORY_PROJECTION_TEXT_MAX_LENGTH),
  // Existing UUIDs or response-local N1, N2... references, resolved at publication.
  memoryRefs: z.array(z.string().min(1)).min(1),
});
export const memoryNewReferenceSchema = z.string().regex(/^N[1-9]\d*$/);
export const memoryGenerationSchema = z.object({
  memories: z.array(memoryCandidateSchema.extend({ ref: memoryNewReferenceSchema })),
  people: z.array(
    z.object({
      personId: z.string().uuid(),
      summary: z.array(memoryGenerationSentenceSchema).max(MEMORY_GENERATION_SUMMARY_MAX_ITEMS),
      standing: z
        .array(
          memoryGenerationSentenceSchema.extend({
            text: z.string().min(1).max(MEMORY_PROJECTION_STANDING_TEXT_MAX_LENGTH),
          }),
        )
        .max(MEMORY_PROJECTION_STANDING_MAX_ITEMS),
    }),
  ),
});
export type MemoryGeneration = z.infer<typeof memoryGenerationSchema>;
const COMPLETE_SENTENCE_PATTERN = /[.!?…。！？]["'’”)]*$/;

function projectionSummaryCode(input: {
  history: MemoryGenerationInput["history"];
  memories: MemoryGeneration["memories"];
  invalidRef: string;
}): typeof CODE_CROSS_PERSON_REFERENCE | typeof CODE_UNKNOWN_MEMORY_REFERENCE {
  const isKnownHistoryRef = input.history.some((person) =>
    person.memories.some((memory) => memory.id === input.invalidRef),
  );
  const isKnownMemoryRef = input.memories.some((memory) => memory.ref === input.invalidRef);

  return isKnownHistoryRef || isKnownMemoryRef ? CODE_CROSS_PERSON_REFERENCE : CODE_UNKNOWN_MEMORY_REFERENCE;
}

function validateProjectionSentences(input: {
  projection: MemoryGeneration["people"][number];
  historyMemories: MemoryProjectionInput["memories"];
  memories: MemoryGeneration["memories"];
  history: MemoryGenerationInput["history"];
}): void {
  const sentences = [...input.projection.summary, ...input.projection.standing];
  sentences.forEach((sentence) => {
    const invalidRef = sentence.memoryRefs.find(
      (ref) =>
        !input.historyMemories.some((memory) => memory.id === ref) &&
        !input.memories.some((memory) => memory.ref === ref && memory.personIds.includes(input.projection.personId)),
    );
    if (invalidRef !== undefined && invalidRef.length > 0) {
      throw new MemoryGenerationRejected(MSG_UNGROUNDED_CROSS_PERSON_SUMMARY, {
        code: projectionSummaryCode({ history: input.history, memories: input.memories, invalidRef }),
        stage: "projection",
      });
    }
  });
  if (input.projection.summary.some((sentence) => !COMPLETE_SENTENCE_PATTERN.test(sentence.text.trim()))) {
    throw new MemoryGenerationRejected(MSG_INCOMPLETE_PERSON_SUMMARY, {
      code: CODE_INCOMPLETE_SUMMARY,
      stage: "projection",
    });
  }
}

export function validateMemoryGeneration({
  input,
  value,
}: {
  input: MemoryGenerationInput;
  value: MemoryGeneration;
}): MemoryGeneration {
  const allRefs = new Set(value.memories.map((memory) => memory.ref));
  if (allRefs.size !== value.memories.length) {
    throw new MemoryGenerationRejected(MSG_DUPLICATE_MEMORY_REFERENCE, {
      code: CODE_DUPLICATE_MEMORY_REFERENCE,
      stage: "evidence",
    });
  }
  const memories = validateMemoryCandidates({ input, candidates: value.memories });
  const people = new Set<string>();
  value.people.forEach((projection) => {
    if (!input.people.some((person) => person.id === projection.personId)) {
      throw new MemoryGenerationRejected(MSG_UNKNOWN_PROJECTION_PERSON, {
        code: CODE_UNKNOWN_PERSON,
        stage: "projection",
      });
    }
    if (people.has(projection.personId)) {
      throw new MemoryGenerationRejected(MSG_DUPLICATE_PROJECTION_PERSON, {
        code: CODE_DUPLICATE_PERSON,
        stage: "projection",
      });
    }
    people.add(projection.personId);
    const historyMemories = input.history.find((person) => person.personId === projection.personId)?.memories ?? [];
    validateProjectionSentences({
      projection,
      historyMemories,
      memories: value.memories,
      history: input.history,
    });
  });
  if (input.people.some((person) => !people.has(person.id))) {
    throw new MemoryGenerationRejected(MSG_MISSING_PERSON_SUMMARY, {
      code: CODE_MISSING_PERSON_SUMMARY,
      stage: "projection",
    });
  }
  const eligible = (refs: string[]) =>
    refs.every((ref) => !allRefs.has(ref) || memories.some((memory) => memory.ref === ref));

  return {
    memories,
    people: value.people.map((person) => ({
      ...person,
      summary: person.summary.filter((sentence) => eligible(sentence.memoryRefs)),
      standing: person.standing.filter((sentence) => eligible(sentence.memoryRefs)),
    })),
  };
}
export type RelationshipMemory = MemoryCandidate & {
  id: string;
  sourceId: string;
  meetingId: string;
  /** Meeting time retained for ordering, date groups, filters, and pagination. */
  occurredAt: string;
  /** Latest cited transcript passage; display only, never an ordering key. */
  evidenceOccurredAt?: string | null;
};
// PostgreSQL cursors retain microseconds; Date.parse alone truncates them.
const subMillisecond = (time: string): number =>
  Number(
    (time.match(/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1] ?? "")
      .padEnd(MICROSECOND_PAD_LENGTH, "0")
      .slice(MICROSECOND_SLICE_START, MICROSECOND_SLICE_END),
  );

/** Newest event first; importance breaks timestamp ties, then ID makes pagination deterministic. */
export function compareRelationshipMemories(
  ...pair: [
    Pick<RelationshipMemory, "id" | "occurredAt" | "importance">,
    Pick<RelationshipMemory, "id" | "occurredAt" | "importance">,
  ]
): number {
  const [left, right] = pair;
  const occurredAtDelta = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
  if (occurredAtDelta !== COMPARE_EQUAL) {
    return occurredAtDelta;
  }
  const subMillisecondDelta = subMillisecond(right.occurredAt) - subMillisecond(left.occurredAt);
  if (subMillisecondDelta !== COMPARE_EQUAL) {
    return subMillisecondDelta;
  }
  const importanceDelta =
    (right.importance ?? DEFAULT_MEMORY_IMPORTANCE) - (left.importance ?? DEFAULT_MEMORY_IMPORTANCE);
  if (importanceDelta !== COMPARE_EQUAL) {
    return importanceDelta;
  }

  return left.id < right.id ? COMPARE_LEFT_GREATER : left.id > right.id ? COMPARE_LEFT_LESSER : COMPARE_EQUAL;
}
export type MemoryPerson = {
  id: string;
  name: string;
  email?: string | null;
  lastContact: string;
  categories: string[];
  companyName?: string | null;
  companyDomain?: string | null;
  /** Contact photo when one is known; otherwise the UI shows initials. */
  imageUrl?: string | null;
  /** Profiles shown as pills beside the email, such as Ashby or LinkedIn. */
  profileLinks?: { label: string; url: string }[];
};
export type MemoryStatus = {
  /** @external memory availability wire field */
  available: boolean;
  preferences: MemoryPreferences;
  processingMeeting?: { meetingId: string; endedAt: string } | null;
  progress: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    projectionQueued?: number;
    projectionRunning?: number;
    projectionFailed?: number;
  };
};
export const memoryActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MEMORY_ACTION_IDS_MAX),
  action: z.literal("forget"),
});

/** Complete, ordered coverage; even a single unusually large segment is never truncated. */
export function chunkMemorySegments({
  segments,
  maxChars = DEFAULT_MEMORY_CHUNK_MAX_CHARS,
}: {
  segments: MemoryExtractionInput["segments"];
  maxChars?: number;
}): MemoryExtractionInput["segments"][] {
  const folded = segments.reduce<{
    chunks: MemoryExtractionInput["segments"][];
    currentChunk: MemoryExtractionInput["segments"];
    currentSize: number;
  }>(
    (state, segment) => {
      const segmentLength = JSON.stringify(segment).length;
      const shouldStartNewChunk = state.currentChunk.length !== 0 && state.currentSize + segmentLength > maxChars;
      const nextChunks = shouldStartNewChunk ? [...state.chunks, state.currentChunk] : state.chunks;
      const nextChunk = shouldStartNewChunk ? [segment] : [...state.currentChunk, segment];
      const nextSize = shouldStartNewChunk ? segmentLength : state.currentSize + segmentLength;

      return { chunks: nextChunks, currentChunk: nextChunk, currentSize: nextSize };
    },
    { chunks: [], currentChunk: [], currentSize: 0 },
  );

  return folded.currentChunk.length === 0 ? folded.chunks : [...folded.chunks, folded.currentChunk];
}

/** Revisit earlier passages with the final topic context, so distant requests and
 * answers can share a memory even when the early passage alone was not memorable. */
export function memoryExtractionPasses({
  segments,
  maxChars = DEFAULT_MEMORY_CHUNK_MAX_CHARS,
}: {
  segments: MemoryExtractionInput["segments"];
  maxChars?: number;
}): MemoryExtractionInput["segments"][] {
  const chunks = chunkMemorySegments({ segments, maxChars });

  return [...chunks, ...chunks.slice(0, -1)];
}

function evidenceIsUngrounded(input: {
  evidence: MemoryCandidate["evidence"];
  segments: Map<string, MemoryExtractionInput["segments"][number]>;
  normalize: (value: string) => string;
}): boolean {
  return input.evidence.some((item) => {
    const segment = input.segments.get(item.segmentId);
    const normalizedQuote = input.normalize(item.quote);
    if (!input.segments.has(item.segmentId) || normalizedQuote.length === 0 || segment === undefined) {
      return true;
    }

    return !input.normalize(segment.content).includes(normalizedQuote);
  });
}

function assertCandidatePeople(input: { candidate: MemoryCandidate; people: Set<string> }): void {
  const candidateSubjectId = input.candidate.candidateSubjectId;
  const hasUnknownPerson =
    input.candidate.personIds.some((id) => !input.people.has(id)) ||
    (candidateSubjectId !== null && candidateSubjectId !== "" && !input.people.has(candidateSubjectId));
  if (hasUnknownPerson) {
    throw new MemoryGenerationRejected(MSG_UNKNOWN_MEMORY_PERSON, {
      code: CODE_UNKNOWN_PERSON,
      stage: "evidence",
    });
  }
}

function assertCandidateFact(input: {
  candidate: MemoryCandidate;
  knownFacts: MemoryExtractionInput["knownFacts"];
}): void {
  const existingFactKey = input.candidate.existingFactKey;
  const hasUnknownFact =
    existingFactKey !== null &&
    existingFactKey !== undefined &&
    existingFactKey.length > 0 &&
    !(input.knownFacts?.some((fact) => fact.key === existingFactKey) ?? false);
  if (hasUnknownFact) {
    throw new MemoryGenerationRejected(MSG_UNKNOWN_MEMORY_FACT, {
      code: CODE_UNKNOWN_FACT,
      stage: "evidence",
    });
  }
}

function acceptMemoryCandidate<T extends MemoryCandidate>(input: {
  candidate: T;
  extractionInput: MemoryExtractionInput;
  segments: Map<string, MemoryExtractionInput["segments"][number]>;
  people: Set<string>;
  normalize: (value: string) => string;
  seen: Set<string>;
  accepted: T[];
}): { accepted: T[]; seen: Set<string> } {
  const { candidate } = input;
  if (candidate.confidence === "low" || (candidate.sensitive && !input.extractionInput.preferences.includeSensitive)) {
    return { accepted: input.accepted, seen: input.seen };
  }
  assertCandidatePeople({ candidate, people: input.people });
  assertCandidateFact({ candidate, knownFacts: input.extractionInput.knownFacts });
  if (evidenceIsUngrounded({ evidence: candidate.evidence, segments: input.segments, normalize: input.normalize })) {
    throw new MemoryGenerationRejected(MSG_UNGROUNDED_MEMORY_EVIDENCE, {
      code: CODE_UNGROUNDED_EVIDENCE,
      stage: "evidence",
    });
  }
  const dedupeKey = `${input.normalize(candidate.title).toLowerCase()}:${candidate.evidence
    .map((item) => item.segmentId)
    .sort()
    .join(",")}`;
  if (input.seen.has(dedupeKey)) {
    return { accepted: input.accepted, seen: input.seen };
  }
  const nextSeen = new Set([...input.seen, dedupeKey]);

  return {
    seen: nextSeen,
    accepted: [
      ...input.accepted,
      {
        ...candidate,
        evidence: Array.from(new Map(candidate.evidence.map((item) => [item.segmentId, item])).values()),
      },
    ],
  };
}

export function validateMemoryCandidates<T extends MemoryCandidate>({
  input,
  candidates,
}: {
  input: MemoryExtractionInput;
  candidates: T[];
}): T[] {
  const segments = new Map(input.segments.map((segment) => [segment.id, segment]));
  const people = new Set(input.people.map((person) => person.id));
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

  return candidates.reduce<{ accepted: T[]; seen: Set<string> }>(
    (state, candidate) => {
      const next = acceptMemoryCandidate({
        candidate,
        extractionInput: input,
        segments,
        people,
        normalize,
        seen: state.seen,
        accepted: state.accepted,
      });

      return { accepted: next.accepted, seen: next.seen };
    },
    { accepted: [], seen: new Set<string>() },
  ).accepted;
}

export function validateMemoryProjection({
  input,
  projection,
}: {
  input: MemoryProjectionInput;
  projection: MemoryProjection;
}): MemoryProjection {
  const ids = new Set(input.memories.map((memory) => memory.id));
  if ([...projection.summary, ...projection.standing].some((item) => item.memoryIds.some((id) => !ids.has(id)))) {
    throw new Error(MSG_UNGROUNDED_PERSON_SUMMARY);
  }
  if (projection.summary.some((sentence) => !COMPLETE_SENTENCE_PATTERN.test(sentence.text.trim()))) {
    throw new Error(MSG_INCOMPLETE_PERSON_SUMMARY);
  }

  return projection;
}

export type MemoryListPage = {
  memories: RelationshipMemory[];
  nextCursor: string | null;
  syncCursor?: string;
  previousCursor?: string | null;
};
export type MemoryListChanges = {
  memories: RelationshipMemory[];
  removedIds: string[];
  syncCursor: string;
  hasMore: boolean;
  /** @external memory list sync reset wire field */
  reset?: boolean;
};

export type MemoryPeoplePage = {
  people: MemoryPerson[];
  nextCursor?: string | null;
  previousCursor?: string | null;
};
export function memoryPersonMatchesFilters({
  person,
  filters,
}: {
  person: MemoryPerson;
  filters: Record<string, string | undefined>;
}): boolean {
  const { category, from, to, q } = filters;
  const categoryValue = category ?? "";
  const fromValue = from ?? "";
  const toValue = to ?? "";
  const queryValue = (q ?? "").toLowerCase();
  const isCategoryMatched =
    categoryValue.length === 0 || person.categories.includes(categoryValue) !== (filters.categoryOperator === "is_not");
  const hasDateFilter = fromValue.length > 0 || toValue.length > 0;
  const isFromMatched = fromValue.length === 0 || Date.parse(person.lastContact) >= Date.parse(fromValue);
  const isToMatched = toValue.length === 0 || Date.parse(person.lastContact) < Date.parse(toValue);
  const isDateMatched = !hasDateFilter || (isFromMatched && isToMatched) !== (filters.dateOperator === "is_not");
  const searchHaystack =
    `${person.name} ${person.companyName ?? ""} ${person.categories.join(" ")} ${person.companyDomain ?? ""}`.toLowerCase();

  return isCategoryMatched && isDateMatched && searchHaystack.includes(queryValue);
}
