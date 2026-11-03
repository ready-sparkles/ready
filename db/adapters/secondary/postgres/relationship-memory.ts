import {
  BILLING_PAST_DUE_GRACE_DAYS,
  FREE_PLAN_INCLUDED_NOTES_MEETINGS,
  MEMORY_PROMPT_VERSION,
  type MemoryCandidate,
  memoryCategories,
  memoryCategoryFilterValues,
  type MemoryExtractionInput,
  type MemoryFactIdentity,
  memoryFactIdentitySchema,
  memoryFailureDiagnostic,
  type MemoryGeneration,
  type MemoryGenerationInput,
  type MemoryPerson,
  type MemoryPreferences,
  memoryPreferencesSchema,
  type MemoryProjection,
  memoryProjectionSchema,
  normalizeMemoryCategory,
  type RelationshipMemory,
} from "@readymeet/shared";
import { createHash, randomUUID } from "node:crypto";

import { resolveMemoryCompany } from "../../../domain/memory-company";
import { MemoryBusyError, MemoryNotFoundError } from "../../../domain/persistence-errors";

import { db, type DbTransaction, Prisma } from "./client";
import { decodeContentRow } from "./content-storage";
import { isPrismaTransactionTimeout, LOCK_NOT_AVAILABLE_SQLSTATE, postgresSqlState } from "./database-errors";
import { normalizeGuestName } from "./guest-recognition";
import { revisionsByMeeting } from "./memory-transcript-revision";
import { getCurrentMonthlyWindow, TRIAL_WORKSPACE_SLOTS } from "./workspace-billing";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type MemoryScope = { userId: string; workspaceId: string };

export type MemorySource = {
  id: string;
  meetingId: string;
  title: string;
  occurredAt: string;
  /** @external memory source sensitivity flag from SQL column include_sensitive */
  includeSensitive?: boolean;
  revision: string;
  status: string;
  kind: string;
  workspaceId: string;
  meetingWorkspaceId?: string;
  createdByUserId: string;
  createdAt: Date;
};

export type MemoryJob = MemoryScope & {
  id: string;
  sourceId: string | null;
  kind: "extract" | "project";
  sourceRevision: string | null;
  preferencesRevision: number;
  leaseToken: string;
  attempts: number;
  extractedAt: string | null;
};

const DEFAULT_MEMORY_PAGE_SIZE = 100;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MESSAGE_MEMORY_ROW_NOT_FOUND = "Memory row was not found";

const MESSAGE_LEGACY_FORGOTTEN_FACTS_BLOCKED =
  "Legacy forgotten facts cannot be identified safely; source regeneration is blocked";
const MESSAGE_MEMORY_SOURCE_OUT_OF_SCOPE = "Memory source belongs to another scope or no longer exists";
const MESSAGE_MEMORY_JOB_OR_PREFERENCES_CHANGED = "Memory job or preferences changed";
const MESSAGE_UNSUPPORTED_MEMORY_ACTION = "Unsupported memory action";
const MESSAGE_TRANSCRIPT_CHANGED_DURING_EXTRACTION = "Transcript changed during extraction";
const MESSAGE_UNKNOWN_MEMORY_FACT = "Unknown memory fact";
const MESSAGE_MEMORY_FACT_IDENTITY_MISMATCH = "Memory fact identity does not match its key";
const FINAL_TRANSCRIPT_SOURCES = new Set(["livekit-python-postcall", "livekit-postcall"]);
const FINAL_TRANSCRIPT_MODES = new Set(["postcall-refined", "agent-live-finalized"]);
const ACCOUNT_SOURCES = new Set(["auth", "dev_login"]);

type MemoryJobProgressCounts = {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  projectionQueued: number;
  projectionRunning: number;
  projectionFailed: number;
};

type MemoryPosition = { occurredAt: Date; importance: number; id: string };

type MeetingRow = Prisma.meetingsModel;
type UserRow = Prisma.usersModel;
type IdentityRow = Prisma.memoryPersonIdentitiesModel;

type EligibleMeeting = { meeting: MeetingRow; revision: string };

type PersistMemoryExtractionGeneration = {
  value: MemoryGeneration;
  history: MemoryGenerationInput["history"];
  sourceIds: string[];
  inputSources: Pick<MemorySource, "id" | "revision">[];
  language: string;
};

type MemoryKnownFact = NonNullable<MemoryExtractionInput["knownFacts"]>[number];

type RelationshipMemoryListFilters = {
  personId?: string;
  categoryOperator?: string;
  personOperator?: string;
  dateOperator?: string;
  category?: string;
  q?: string;
  before?: string;
  from?: string;
  to?: string;
  limit?: number;
  ids?: string[];
  beforePosition?: { occurredAt: string; importance: number; id: string };
  throughPosition?: { occurredAt: string; importance: number; id: string };
  /** @external existing wire contract */ newer?: boolean;
};

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const compareText = (input: { left: string; right: string }): number =>
  input.left < input.right ? -1 : input.left > input.right ? 1 : 0;

const firstDifference = (comparisons: number[]): number =>
  comparisons.find((value) => value !== 0 && !Number.isNaN(value)) ?? comparisons.at(-1) ?? 0;

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

const uuidTexts = (values: string[]): string[] => values.filter((value) => UUID_PATTERN.test(value));

const isoTimestamp = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const parseOptionalDate = (value: string | undefined): Date | null => {
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const comparePosition = (input: { left: MemoryPosition; right: MemoryPosition }): number => {
  const time = input.left.occurredAt.getTime() - input.right.occurredAt.getTime();
  if (time !== 0) {
    return time;
  }
  if (input.left.importance !== input.right.importance) {
    return input.left.importance - input.right.importance;
  }

  return compareText({ left: input.left.id, right: input.right.id });
};

const isRelationshipMemoryCategory = (value: string): value is RelationshipMemory["category"] =>
  memoryCategories.some((category) => category === value);

const relationshipMemoryCategory = (category: string): RelationshipMemory["category"] => {
  const normalized = normalizeMemoryCategory(category);

  return isRelationshipMemoryCategory(normalized) ? normalized : "General";
};

const memoryPeopleCategoryLabels = (): Record<string, string> =>
  Object.fromEntries(
    memoryCategories.flatMap((category) => memoryCategoryFilterValues(category).map((value) => [value, category])),
  );

const searchTokens = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token !== "");

const matchesSimpleSearch = (input: { content: string; query: string }): boolean => {
  const tokens = searchTokens(input.query);
  if (tokens.length === 0) {
    return false;
  }
  const words = new Set(searchTokens(input.content));

  return tokens.every((token) => words.has(token));
};

const matchesPeopleSearch = (input: { haystack: string; query: string }): boolean => {
  const terms = input.query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);

  return terms.every((term) => input.haystack.includes(term));
};

const xorKeep = (input: { isMatched: boolean; operator: string }): boolean =>
  input.isMatched !== (input.operator === "is_not");

const isJsonInput = (value: unknown): value is Prisma.InputJsonValue => {
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => entry === null || isJsonInput(entry));
  }

  return isRecord(value) && Object.values(value).every((entry) => entry === null || isJsonInput(entry));
};

const jsonInput = (value: unknown): Prisma.InputJsonValue => {
  if (!isJsonInput(value)) {
    throw new Error(MESSAGE_MEMORY_ROW_NOT_FOUND);
  }

  return value;
};

const transcriptMetadataReady = (row: { source: string; metadata: unknown }): boolean => {
  if (FINAL_TRANSCRIPT_SOURCES.has(row.source)) {
    return true;
  }
  if (!isRecord(row.metadata)) {
    return false;
  }
  if (row.metadata.refinedAt !== undefined && row.metadata.refinedAt !== null) {
    return true;
  }
  if (row.metadata.finalizedAt !== undefined && row.metadata.finalizedAt !== null) {
    return true;
  }

  return typeof row.metadata.mode === "string" && FINAL_TRANSCRIPT_MODES.has(row.metadata.mode);
};

const jsonbText = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
};

const completedCompany = (result: unknown): { name: string | null; website: string | null } | null => {
  if (!isRecord(result) || !isRecord(result.company)) {
    return null;
  }
  if (result.company.status !== "completed") {
    return null;
  }

  return { name: jsonbText(result.company.companyName), website: jsonbText(result.company.website) };
};

const snapshotEmails = (snapshot: unknown): string[] => {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.participants)) {
    return [];
  }

  return snapshot.participants.flatMap((participant) => {
    if (!isRecord(participant)) {
      return [];
    }
    const email = jsonbText(participant.email);
    if (email === null) {
      return [];
    }

    return [email.trim().toLowerCase()];
  });
};

const asFactIdentity = (value: unknown): MemoryFactIdentity => {
  if (typeof value !== "string") {
    return memoryFactIdentitySchema.parse(value);
  }

  return memoryFactIdentitySchema.parse(JSON.parse(value) as unknown);
};

function requiredMemoryRow<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error(MESSAGE_MEMORY_ROW_NOT_FOUND);
  }

  return value;
}

const intervalsOverlap = (input: {
  left: { joinedAt: Date; leftAt: Date | null };
  right: { joinedAt: Date; leftAt: Date | null };
  endedAt: Date;
}): boolean => {
  if (!(input.left.joinedAt < input.endedAt) || !(input.right.joinedAt < input.endedAt)) {
    return false;
  }
  const start = Math.max(input.left.joinedAt.getTime(), input.right.joinedAt.getTime());
  const end = Math.min((input.left.leftAt ?? input.endedAt).getTime(), (input.right.leftAt ?? input.endedAt).getTime());

  return start < end;
};

type MemoryProjectionEntry = { text: string; memoryIds: string[] };

type ConsolidatedMemoryProjection = {
  content: { summary: MemoryProjectionEntry[]; standing: MemoryProjectionEntry[] };
  promptVersion: string;
  sourceRevisions: Record<string, string>;
};

const PROJECTION_SECTION_NAMES = ["summary", "standing"] as const;

function readProjectionEntries(input: {
  content: unknown;
  section: (typeof PROJECTION_SECTION_NAMES)[number];
}): MemoryProjectionEntry[] {
  if (!isRecord(input.content)) {
    return [];
  }
  const value = input.content[input.section];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== "string" || !Array.isArray(item.memoryIds)) {
      return [];
    }
    const memoryIds = item.memoryIds.flatMap((id) => (typeof id === "string" ? [id] : []));
    if (memoryIds.length === 0 || memoryIds.length !== item.memoryIds.length) {
      return [];
    }

    return [{ text: item.text, memoryIds }];
  });
}

function readStringRevisions(value: unknown): Record<string, string> | null {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.some(([, revision]) => typeof revision !== "string")) {
    return null;
  }

  return Object.fromEntries(
    entries.flatMap(([id, revision]) => (typeof revision === "string" ? [[id, revision] as const] : [])),
  );
}

function sourceRevisionMatchesWinner(input: {
  source: Prisma.memorySourcesModel | undefined;
  revision: string;
  winnerUserId: string;
  winnerWorkspaceId: string;
  meetingRevisions: Map<string, string>;
}): boolean {
  const { source } = input;
  if (
    source === undefined ||
    !source.isCurrent ||
    source.revision !== input.revision ||
    source.meetingId === null ||
    source.userId !== input.winnerUserId ||
    source.workspaceId !== input.winnerWorkspaceId
  ) {
    return false;
  }

  return input.meetingRevisions.get(source.meetingId) === input.revision;
}

function projectionRowIsCurrent(input: {
  revisions: Record<string, string>;
  sourcesById: Map<string, Prisma.memorySourcesModel>;
  winnerUserId: string;
  winnerWorkspaceId: string;
  meetingRevisions: Map<string, string>;
}): boolean {
  return Object.entries(input.revisions).every(([id, revision]) =>
    sourceRevisionMatchesWinner({
      source: input.sourcesById.get(id),
      revision,
      winnerUserId: input.winnerUserId,
      winnerWorkspaceId: input.winnerWorkspaceId,
      meetingRevisions: input.meetingRevisions,
    }),
  );
}

function projectionEntryKey(entry: MemoryProjectionEntry): string {
  return `${entry.text}\n${entry.memoryIds.join("\n")}`;
}

function uniqueProjectionEntries(entries: MemoryProjectionEntry[]): MemoryProjectionEntry[] {
  const byKey = new Map(entries.map((entry) => [projectionEntryKey(entry), entry]));

  return [...byKey.values()].toSorted((left, right) =>
    compareText({ left: projectionEntryKey(left), right: projectionEntryKey(right) }),
  );
}

function projectionEntryIsEvidenced(input: {
  entry: MemoryProjectionEntry;
  revisions: Record<string, string>;
  winnerId: string;
  memoriesById: Map<string, { sourceId: string; personIds: string[] }>;
}): boolean {
  return input.entry.memoryIds.every((memoryId) => {
    const memory = input.memoriesById.get(memoryId);

    return (
      memory !== undefined &&
      memory.personIds.includes(input.winnerId) &&
      Object.hasOwn(input.revisions, memory.sourceId)
    );
  });
}

function mergeCurrentSourceRevisions(valid: { revisions: Record<string, string> }[]): Record<string, string> {
  return valid.reduce<Record<string, string>>((collected, candidate) => {
    const incoming = Object.fromEntries(
      Object.entries(candidate.revisions).filter(([id]) => collected[id] === undefined),
    );

    return { ...collected, ...incoming };
  }, {});
}

async function currentProjectionCandidates(input: {
  winnerUserId: string;
  winnerWorkspaceId: string;
  rows: Prisma.memoryPersonProjectionsModel[];
}) {
  const candidates = input.rows.flatMap((row) => {
    const revisions = readStringRevisions(row.sourceRevisions);
    if (revisions === null) {
      return [];
    }

    return [{ row, revisions }];
  });
  const sourceIds = [...new Set(candidates.flatMap((candidate) => Object.keys(candidate.revisions)))];
  const sources = sourceIds.length === 0 ? [] : await db.memorySources.findMany({ where: { id: { in: sourceIds } } });
  const meetingRevisions = await revisionsByMeeting({
    meetingIds: sources.flatMap((source) => (source.meetingId === null ? [] : [source.meetingId])),
    sources,
  });
  const sourcesById = new Map(sources.map((source) => [source.id, source]));

  return candidates.filter((candidate) =>
    projectionRowIsCurrent({
      revisions: candidate.revisions,
      sourcesById,
      winnerUserId: input.winnerUserId,
      winnerWorkspaceId: input.winnerWorkspaceId,
      meetingRevisions,
    }),
  );
}

export async function buildConsolidatedMemoryProjection(input: {
  winnerId: string;
  rows: Prisma.memoryPersonProjectionsModel[];
}): Promise<ConsolidatedMemoryProjection | null> {
  const winner = await db.memoryPeople.findUnique({ where: { id: input.winnerId } });
  if (winner === null) {
    return null;
  }
  const valid = await currentProjectionCandidates({
    winnerUserId: winner.userId,
    winnerWorkspaceId: winner.workspaceId,
    rows: input.rows,
  });
  const latest = [...valid].toSorted((left, right) => right.row.updatedAt.getTime() - left.row.updatedAt.getTime())[0];
  if (latest === undefined) {
    return null;
  }
  const tagged = valid.flatMap((candidate) =>
    PROJECTION_SECTION_NAMES.flatMap((section) =>
      readProjectionEntries({ content: candidate.row.content, section }).map((entry) => ({
        section,
        entry,
        revisions: candidate.revisions,
      })),
    ),
  );
  const memoryIds = [...new Set(tagged.flatMap((item) => item.entry.memoryIds))];
  const memories =
    memoryIds.length === 0
      ? []
      : await db.relationshipMemories.findMany({
          where: { id: { in: memoryIds } },
        });
  const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
  const evidenced = tagged.filter((item) =>
    projectionEntryIsEvidenced({
      entry: item.entry,
      revisions: item.revisions,
      winnerId: input.winnerId,
      memoriesById,
    }),
  );

  return {
    content: {
      summary: uniqueProjectionEntries(evidenced.flatMap((item) => (item.section === "summary" ? [item.entry] : []))),
      standing: uniqueProjectionEntries(evidenced.flatMap((item) => (item.section === "standing" ? [item.entry] : []))),
    },
    promptVersion: latest.row.promptVersion,
    sourceRevisions: mergeCurrentSourceRevisions(valid),
  };
}

export async function meetingIdsWithReadyTranscript(input: {
  meetingIds: string[];
  shouldRequireHumanSegment: boolean;
}): Promise<string[]> {
  const uniqueIds = [...new Set(input.meetingIds)];
  if (uniqueIds.length === 0) {
    return [];
  }
  const transcriptRows = await db.transcripts.findMany({ where: { meetingId: { in: uniqueIds } } });
  const readyTranscripts = transcriptRows.filter((row) => transcriptMetadataReady(row));
  if (!input.shouldRequireHumanSegment) {
    return readyTranscripts.map((row) => row.meetingId);
  }
  const transcriptIds = readyTranscripts.map((row) => row.id);
  if (transcriptIds.length === 0) {
    return [];
  }
  const segments = await db.transcriptSegments.findMany({
    where: { transcriptId: { in: transcriptIds } },
  });
  const humanTranscripts = new Set(
    segments
      .filter((segment) => segment.speakerRole === "human" && segment.content.trim().length > 0)
      .map((segment) => segment.transcriptId),
  );

  return readyTranscripts.filter((row) => humanTranscripts.has(row.id)).map((row) => row.meetingId);
}

type AttendanceInterval = Prisma.meetingAttendanceIntervalsModel;

const isEligibleMemoryMeeting = (input: {
  meeting: MeetingRow;
  scope: MemoryScope;
  suspendedHosts: Set<string>;
  participantMeetings: Set<string>;
  ready: Set<string>;
  bindingByMeeting: Map<string, string>;
  intervals: AttendanceInterval[];
  counterparts: Map<string, UserRow>;
}): boolean => {
  const { meeting, scope } = input;
  if (
    meeting.endedAt === null ||
    input.suspendedHosts.has(meeting.workspaceId) ||
    !input.participantMeetings.has(meeting.id)
  ) {
    return false;
  }
  if (!input.ready.has(meeting.id)) {
    return false;
  }
  const attendeeWorkspace = input.bindingByMeeting.get(meeting.id) ?? meeting.workspaceId;
  if (attendeeWorkspace !== scope.workspaceId) {
    return false;
  }
  const endedAt = meeting.endedAt;
  const viewer = input.intervals.filter(
    (interval) => interval.meetingId === meeting.id && interval.userId === scope.userId,
  );
  const others = input.intervals.filter((interval) => {
    if (interval.meetingId !== meeting.id || interval.userId === scope.userId) {
      return false;
    }
    const counterpart = input.counterparts.get(interval.userId);

    return counterpart !== undefined && counterpart.deletedAt === null && counterpart.source !== "debug_import";
  });

  return viewer.some((left) => others.some((right) => intervalsOverlap({ left, right, endedAt })));
};

async function loadEligibleMeetingRecords(input: { scope: MemoryScope; meetingIds: string[] }): Promise<{
  meetingRows: MeetingRow[];
  scope: MemoryScope;
  suspendedHosts: Set<string>;
  participantMeetings: Set<string>;
  ready: Set<string>;
  bindingByMeeting: Map<string, string>;
  intervals: AttendanceInterval[];
  counterparts: Map<string, UserRow>;
} | null> {
  const uniqueIds = [...new Set(input.meetingIds)];
  if (uniqueIds.length === 0) {
    return null;
  }
  const user = await db.users.findUnique({ where: { id: input.scope.userId } });
  if (user === null || user.deletedAt !== null || !ACCOUNT_SOURCES.has(user.source)) {
    return null;
  }
  const membership = await db.workspaceMemberships.findFirst({
    where: {
      userId: input.scope.userId,
      workspaceId: input.scope.workspaceId,
      status: "active",
    },
  });
  if (membership === null) {
    return null;
  }
  const meetingRows = await db.meetings.findMany({
    where: {
      id: { in: uniqueIds },
      status: "ended",
      kind: "standard",
      hiddenFromHistoryAt: null,
    },
  });
  if (meetingRows.length === 0) {
    return null;
  }
  const candidateIds = meetingRows.map((meeting) => meeting.id);
  const hostWorkspaceIds = [...new Set(meetingRows.map((meeting) => meeting.workspaceId))];
  const [bindings, suspendedMemberships, participantRows, intervals, readyMeetings] = await Promise.all([
    db.meetingAttendeeWorkspaces.findMany({
      where: { userId: input.scope.userId, meetingId: { in: candidateIds } },
    }),
    db.workspaceMemberships.findMany({
      where: {
        userId: input.scope.userId,
        status: "suspended",
        workspaceId: { in: hostWorkspaceIds },
      },
    }),
    db.meetingParticipants.findMany({
      where: { userId: input.scope.userId, meetingId: { in: candidateIds } },
    }),
    db.meetingAttendanceIntervals.findMany({ where: { meetingId: { in: candidateIds } } }),
    meetingIdsWithReadyTranscript({ meetingIds: candidateIds, shouldRequireHumanSegment: true }),
  ]);
  const counterpartIds = [
    ...new Set(intervals.map((interval) => interval.userId).filter((userId) => userId !== input.scope.userId)),
  ];
  const counterpartRows =
    counterpartIds.length === 0 ? [] : await db.users.findMany({ where: { id: { in: counterpartIds } } });

  return {
    meetingRows,
    scope: input.scope,
    suspendedHosts: new Set(suspendedMemberships.map((row) => row.workspaceId)),
    participantMeetings: new Set(participantRows.map((row) => row.meetingId)),
    ready: new Set(readyMeetings),
    bindingByMeeting: new Map(bindings.map((binding) => [binding.meetingId, binding.workspaceId])),
    intervals,
    counterparts: new Map(counterpartRows.map((row) => [row.id, row])),
  };
}

async function loadEligibleMeetings(input: { scope: MemoryScope; meetingIds: string[] }): Promise<EligibleMeeting[]> {
  const loaded = await loadEligibleMeetingRecords(input);
  if (loaded === null) {
    return [];
  }
  const eligible = loaded.meetingRows.filter((meeting) => isEligibleMemoryMeeting({ meeting, ...loaded }));
  const meetingIds = eligible.map((meeting) => meeting.id);
  const sources =
    meetingIds.length === 0
      ? []
      : await db.memorySources.findMany({
          where: {
            userId: input.scope.userId,
            workspaceId: input.scope.workspaceId,
            meetingId: { in: meetingIds },
          },
        });
  const revisions = await revisionsByMeeting({ meetingIds, sources });
  const ranked = eligible.flatMap((meeting) => {
    const revision = revisions.get(meeting.id);
    if (revision === undefined) {
      return [];
    }

    return [{ meeting, revision }];
  });

  return ranked.toSorted((left, right) => {
    const leftTime = left.meeting.startedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const rightTime = right.meeting.startedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return compareText({ left: left.meeting.id, right: right.meeting.id });
  });
}

const eligibleSource = (input: { item: EligibleMeeting; scope: MemoryScope }): MemorySource => ({
  id: input.item.meeting.id,
  meetingId: input.item.meeting.id,
  title: input.item.meeting.title,
  occurredAt: input.item.meeting.startedAt?.toISOString() ?? "",
  revision: input.item.revision,
  status: input.item.meeting.status,
  kind: input.item.meeting.kind,
  workspaceId: input.scope.workspaceId,
  meetingWorkspaceId: input.item.meeting.workspaceId,
  createdByUserId: input.item.meeting.createdByUserId,
  createdAt: input.item.meeting.createdAt,
});

type BillingSubscriptionRow = Prisma.billingSubscriptionsModel;

type NotesEntitlementContext = {
  now: Date;
  user: UserRow;
  meeting: MeetingRow;
  notesWorkspaceId: string;
  isActiveMember: boolean;
  entitled: BillingSubscriptionRow[];
  isPersonalLatestEntitled: boolean;
  workspaceSubscription: BillingSubscriptionRow | undefined;
};

const isSubscriptionEntitled = (input: {
  row: BillingSubscriptionRow;
  userId: string;
  notesWorkspaceId: string;
  isActiveMember: boolean;
  graceStart: Date;
  now: Date;
}): boolean => {
  const isStatusOk =
    input.row.status === "active" ||
    input.row.status === "trialing" ||
    (input.row.status === "past_due" && input.row.statusChangedAt > input.graceStart);
  const isPeriodOk = input.row.currentPeriodEnd === null || input.row.currentPeriodEnd > input.now;
  const isSubjectOk =
    (input.row.userId === input.userId && input.row.workspaceId === null) ||
    (input.row.workspaceId === input.notesWorkspaceId && input.isActiveMember);

  return isStatusOk && isPeriodOk && isSubjectOk;
};

const latestSubscription = (rows: BillingSubscriptionRow[]): BillingSubscriptionRow | undefined =>
  rows.toSorted((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];

async function readNotesEntitlementContext(input: {
  userId: string;
  meetingId: string;
}): Promise<NotesEntitlementContext | null> {
  const now = new Date();
  const user = await db.users.findUnique({ where: { id: input.userId } });
  if (user === null || user.deletedAt !== null || !ACCOUNT_SOURCES.has(user.source)) {
    return null;
  }
  const meeting = await db.meetings.findUnique({ where: { id: input.meetingId } });
  if (meeting === null) {
    return null;
  }
  const binding = await db.meetingAttendeeWorkspaces.findUnique({
    where: { meetingId_userId: { meetingId: meeting.id, userId: user.id } },
  });
  const notesWorkspaceId = binding?.workspaceId ?? meeting.workspaceId;
  const membership = await db.workspaceMemberships.findUnique({
    where: { workspaceId_userId: { workspaceId: notesWorkspaceId, userId: user.id } },
  });
  const isActiveMember = membership?.status === "active";
  const graceStart = new Date(now.getTime() - BILLING_PAST_DUE_GRACE_DAYS * DAY_MS);
  const subscriptions = await db.billingSubscriptions.findMany({
    where: {
      OR: [{ userId: user.id, workspaceId: null }, { workspaceId: notesWorkspaceId }],
    },
  });
  const entitled = subscriptions.filter((row) =>
    isSubscriptionEntitled({ row, userId: user.id, notesWorkspaceId, isActiveMember, graceStart, now }),
  );
  const personalLatest = latestSubscription(
    subscriptions.filter((row) => row.userId === user.id && row.workspaceId === null),
  );
  const isPersonalLatestEntitled = personalLatest !== undefined && entitled.some((row) => row.id === personalLatest.id);

  return {
    now,
    user,
    meeting,
    notesWorkspaceId,
    isActiveMember,
    entitled,
    isPersonalLatestEntitled,
    workspaceSubscription: latestSubscription(entitled.filter((row) => row.workspaceId === notesWorkspaceId)),
  };
}

const hasOpenMemoryCredit = async (input: NotesEntitlementContext): Promise<boolean> => {
  const grants = await db.creditGrants.findMany({
    where: { OR: [{ userId: input.user.id }, { workspaceId: input.notesWorkspaceId }] },
  });

  return grants.some((grant) => {
    if (grant.creditsRemaining <= 0 || (grant.expiresAt !== null && !(grant.expiresAt > input.now))) {
      return false;
    }
    if (grant.userId === input.user.id) {
      return true;
    }

    return grant.workspaceId === input.notesWorkspaceId && input.isActiveMember;
  });
};

const hasPrivateBetaNotesAccess = (input: NotesEntitlementContext): boolean =>
  input.user.plan !== "free" &&
  input.user.privateBetaProEnabledAt !== null &&
  !input.entitled.some((row) => row.workspaceId === null);

const hasIncludedWorkspaceCredits = async (input: NotesEntitlementContext): Promise<boolean> => {
  const subscription = input.workspaceSubscription;
  if (
    subscription?.currentPeriodStart === undefined ||
    subscription.currentPeriodStart === null ||
    !input.isActiveMember
  ) {
    return false;
  }
  const window = getCurrentMonthlyWindow({
    anchor: subscription.currentPeriodStart,
    now: input.now,
    periodEnd: subscription.currentPeriodEnd,
  });
  if (window === null) {
    return false;
  }
  const usage = await db.aiCreditUsageEvents.aggregate({
    where: {
      userId: input.user.id,
      workspaceId: input.notesWorkspaceId,
      createdAt: { gte: window.windowStart, lt: window.windowEnd },
    },
    _sum: {
      /** @external Prisma sum of credits_charged */
      creditsCharged: true,
    },
  });

  return subscription.includedCreditsPerPeriod > (usage._sum.creditsCharged ?? 0);
};

const isFreePlanNotesCandidate = (input: NotesEntitlementContext): boolean =>
  input.user.plan === "free" &&
  !input.isPersonalLatestEntitled &&
  input.workspaceSubscription === undefined &&
  input.isActiveMember;

const hasFreePlanNotesAllowance = async (input: NotesEntitlementContext): Promise<boolean> => {
  const events = await db.aiCreditUsageEvents.findMany({
    where: { userId: input.user.id, workspaceId: { not: null } },
  });
  const grouped = new Map<string, { firstUsedAt: Date }>();
  events.forEach((event) => {
    if (event.workspaceId === null) {
      return;
    }
    const current = grouped.get(event.workspaceId);
    if (current === undefined) {
      grouped.set(event.workspaceId, { firstUsedAt: event.createdAt });

      return;
    }
    if (event.createdAt < current.firstUsedAt) {
      current.firstUsedAt = event.createdAt;
    }
  });
  const ranked = [...grouped.entries()].toSorted((left, right) => {
    const time = left[1].firstUsedAt.getTime() - right[1].firstUsedAt.getTime();
    if (time !== 0) {
      return time;
    }

    return compareText({ left: left[0], right: right[0] });
  });
  const currentIndex = ranked.findIndex(([workspaceId]) => workspaceId === input.notesWorkspaceId);
  const isSlotAvailable =
    currentIndex === -1 ? ranked.length < TRIAL_WORKSPACE_SLOTS : currentIndex + 1 <= TRIAL_WORKSPACE_SLOTS;
  if (!isSlotAvailable) {
    return false;
  }
  if (input.meeting.kind !== "standard" || input.meeting.createdByUserId !== input.user.id) {
    return true;
  }
  const slots = await db.meetingTrialSlots.findMany({
    where: { userId: input.user.id, workspaceId: input.notesWorkspaceId },
  });

  return slots.filter((slot) => slot.meetingId !== input.meeting.id).length < FREE_PLAN_INCLUDED_NOTES_MEETINGS;
};

export async function hasMemoryNotesEntitlement(input: { userId: string; meetingId: string }): Promise<boolean> {
  const context = await readNotesEntitlementContext(input);
  if (context === null) {
    return false;
  }
  if (await hasOpenMemoryCredit(context)) {
    return true;
  }
  if (hasPrivateBetaNotesAccess(context)) {
    return true;
  }
  if (await hasIncludedWorkspaceCredits(context)) {
    return true;
  }
  if (!isFreePlanNotesCandidate(context)) {
    return false;
  }

  return hasFreePlanNotesAllowance(context);
}

async function meetingCanEnqueue(input: { scope: MemoryScope; meeting: MemorySource }): Promise<boolean> {
  const eligible = await loadEligibleMeetings({ scope: input.scope, meetingIds: [input.meeting.meetingId] });
  const match = eligible.find((item) => item.revision === input.meeting.revision);
  const policy = await db.memoryRuntimePolicy.findFirst();

  return (
    policy !== null &&
    match !== undefined &&
    match.meeting.endedAt !== null &&
    match.meeting.endedAt > policy.futureOnlySince
  );
}

async function ensureMemoryPreferences(scope: MemoryScope): Promise<void> {
  await db.$executeRaw`
    INSERT INTO memory_preferences (user_id, workspace_id)
    VALUES (CAST(${scope.userId} AS uuid), CAST(${scope.workspaceId} AS uuid))
    ON CONFLICT (user_id, workspace_id) DO NOTHING
  `;
}

const meetingUserIdentityLists = (input: {
  userRows: UserRow[];
  browserByGuest: Map<string, string>;
  browserById: Map<string, Prisma.guestBrowserIdentitiesModel>;
  accountByGuest: Map<string, string>;
}): { userIdentityList: string[]; browserIdentityList: string[] } => {
  const userIdentityValues = new Set<string>();
  const browserIdentityValues = new Set<string>();
  input.userRows.forEach((user) => {
    userIdentityValues.add(user.id);
    if (user.source !== "guest") {
      return;
    }
    const browserId = input.browserByGuest.get(user.id);
    if (browserId !== undefined) {
      browserIdentityValues.add(browserId);
    }
    const linked =
      input.accountByGuest.get(user.id) ?? input.browserById.get(browserId ?? "")?.linkedAccountUserId ?? null;
    if (linked !== null) {
      userIdentityValues.add(linked);
    }
  });

  return { userIdentityList: [...userIdentityValues], browserIdentityList: [...browserIdentityValues] };
};

const pairMeetingUsersWithMemoryPeople = async (input: {
  scope: MemoryScope;
  userRows: UserRow[];
  browserByGuest: Map<string, string>;
  browserById: Map<string, Prisma.guestBrowserIdentitiesModel>;
  accountByGuest: Map<string, string>;
}): Promise<{ userId: string; personId: string }[]> => {
  const { scope, userRows, browserByGuest, browserById, accountByGuest } = input;
  const { userIdentityList, browserIdentityList } = meetingUserIdentityLists({
    userRows,
    browserByGuest,
    browserById,
    accountByGuest,
  });
  const [userIdentities, browserIdentities, verifiedIdentities] = await Promise.all([
    userIdentityList.length === 0
      ? Promise.resolve([])
      : db.memoryPersonIdentities.findMany({
          where: {
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            kind: "user_id",
            identity: { in: userIdentityList },
          },
        }),
    browserIdentityList.length === 0
      ? Promise.resolve([])
      : db.memoryPersonIdentities.findMany({
          where: {
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            kind: "guest_browser",
            identity: { in: browserIdentityList },
          },
        }),
    db.memoryPersonIdentities.findMany({
      where: { userId: scope.userId, workspaceId: scope.workspaceId, kind: "verified_email" },
    }),
  ]);
  const pairs = new Map<string, { userId: string; personId: string }>();
  const addPair = (pair: { userId: string; personId: string }): void => {
    pairs.set(`${pair.userId}:${pair.personId}`, pair);
  };
  userRows.forEach((user) => {
    const browserId = user.source === "guest" ? browserByGuest.get(user.id) : undefined;
    const linked =
      user.source === "guest"
        ? (accountByGuest.get(user.id) ?? browserById.get(browserId ?? "")?.linkedAccountUserId ?? null)
        : null;
    const accepted = new Set([user.id, ...(linked === null ? [] : [linked])]);
    userIdentities.forEach((identity) => {
      if (accepted.has(identity.identity)) {
        addPair({ userId: user.id, personId: identity.personId });
      }
    });
    if (browserId !== undefined) {
      browserIdentities.forEach((identity) => {
        if (identity.identity === browserId) {
          addPair({ userId: user.id, personId: identity.personId });
        }
      });
    }
    if (user.source === "auth") {
      const email = user.email.trim().toLowerCase();
      verifiedIdentities.forEach((identity) => {
        if (identity.identity.trim().toLowerCase() === email) {
          addPair({ userId: user.id, personId: identity.personId });
        }
      });
    }
  });

  return [...pairs.values()].toSorted((left, right) =>
    firstDifference([
      compareText({ left: left.userId, right: right.userId }),
      compareText({ left: left.personId, right: right.personId }),
    ]),
  );
};

export async function memoryPeopleForMeetingUsers(input: {
  scope: MemoryScope;
  userIds: string[];
}): Promise<{ userId: string; personId: string }[]> {
  const { scope, userIds } = input;
  if (userIds.length === 0) {
    return [];
  }
  const userRows = await db.users.findMany({ where: { id: { in: userIds }, deletedAt: null } });
  if (userRows.length === 0) {
    return [];
  }
  const ids = userRows.map((user) => user.id);
  const guestBrowsers = await db.guestBrowserUsers.findMany({ where: { guestUserId: { in: ids } } });
  const browserIds = guestBrowsers.map((row) => row.browserId);
  const browsers =
    browserIds.length === 0 ? [] : await db.guestBrowserIdentities.findMany({ where: { id: { in: browserIds } } });
  const links = await db.guestMemoryAccountLinks.findMany({ where: { guestUserId: { in: ids } } });
  const browserByGuest = new Map(
    guestBrowsers
      .filter((row) => userRows.some((user) => user.id === row.guestUserId && user.source === "guest"))
      .map((row) => [row.guestUserId, row.browserId]),
  );
  const browserById = new Map(browsers.map((row) => [row.id, row]));
  const accountByGuest = new Map(
    links
      .filter((row) => userRows.some((user) => user.id === row.guestUserId && user.source === "guest"))
      .map((row) => [row.guestUserId, row.accountUserId]),
  );

  return pairMeetingUsersWithMemoryPeople({ scope, userRows, browserByGuest, browserById, accountByGuest });
}

export async function getMemoryPreferences(scope: MemoryScope): Promise<MemoryPreferences & { revision: number }> {
  await ensureMemoryPreferences(scope);
  const row = await db.memoryPreferences.findUnique({
    where: { userId_workspaceId: { userId: scope.userId, workspaceId: scope.workspaceId } },
  });

  return {
    ...memoryPreferencesSchema.parse(row ?? {}),
    revision: row?.revision ?? 0,
  };
}

export async function saveMemoryPreferences(input: {
  scope: MemoryScope;
  preferences: MemoryPreferences;
}): Promise<MemoryPreferences & { revision: number }> {
  const { scope, preferences } = input;
  await ensureMemoryPreferences(scope);
  await db.memoryPreferences.updateMany({
    where: { userId: scope.userId, workspaceId: scope.workspaceId },
    data: {
      /** @external persisted include_sensitive column */
      includeSensitive: preferences.includeSensitive,
      language: preferences.language,
    },
  });

  return getMemoryPreferences(scope);
}

export async function listEligibleMemoryMeetings(input: {
  scope: MemoryScope;
  meetingId: string | string[];
}): Promise<MemorySource[]> {
  const meetingIds = Array.isArray(input.meetingId) ? input.meetingId : [input.meetingId];
  const eligible = await loadEligibleMeetings({ scope: input.scope, meetingIds });

  return eligible.map((item) => eligibleSource({ item, scope: input.scope }));
}

export async function listAccessibleMemorySources(scope: MemoryScope): Promise<MemorySource[]> {
  const storedSources = await db.memorySources.findMany({
    where: { userId: scope.userId, workspaceId: scope.workspaceId, meetingId: { not: null } },
    include: { meetings: {} },
  });
  const rows = storedSources.flatMap((source) =>
    source.meetings === null ? [] : [{ source, meeting: source.meetings }],
  );
  const meetingIds = rows.flatMap((row) => (row.source.meetingId === null ? [] : [row.source.meetingId]));
  const eligible = new Set((await loadEligibleMeetings({ scope, meetingIds })).map((item) => item.meeting.id));

  return rows.flatMap((row) => {
    if (row.source.meetingId === null || !eligible.has(row.source.meetingId)) {
      return [];
    }

    return [
      {
        id: row.source.id,
        meetingId: row.source.meetingId,
        title: row.meeting.title,
        occurredAt: row.source.occurredAt.toISOString(),
        /** @external persisted include_sensitive column */
        includeSensitive: row.source.includeSensitive,
        revision: row.source.revision,
        status: row.meeting.status,
        kind: row.meeting.kind,
        workspaceId: scope.workspaceId,
        meetingWorkspaceId: row.meeting.workspaceId,
        createdByUserId: row.meeting.createdByUserId,
        createdAt: row.meeting.createdAt,
      },
    ];
  });
}

async function compensateEnqueuedSource(input: {
  jobId: string;
  previous: { id: string; revision: string } | null;
  sourceId: string | null;
}): Promise<void> {
  try {
    if (input.sourceId !== null && input.previous === null) {
      await db.memorySources.deleteMany({ where: { id: input.sourceId } });
    }
    if (input.previous !== null) {
      await db.memorySources.updateMany({
        where: { id: input.previous.id },
        data: { revision: input.previous.revision },
      });
    }
  } catch (error) {
    const failure = error instanceof Error ? error.message : "";
    void failure;
    // Keep the original failure. Compensation is best-effort.
  }
  try {
    await db.memoryGenerationLedger.deleteMany({ where: { jobId: input.jobId } });
  } catch (error) {
    const failure = error instanceof Error ? error.message : "";
    void failure;
    // Keep the original failure. Compensation is best-effort.
  }
}

const claimMemoryGenerationLedger = async (input: {
  scope: MemoryScope;
  meetingId: string;
  jobId: string;
}): Promise<boolean> => {
  const ledger = await db.$queryRaw<{ jobId: string }[]>`
    INSERT INTO memory_generation_ledger (user_id, meeting_id, workspace_id, job_id)
    VALUES (
      CAST(${input.scope.userId} AS uuid),
      CAST(${input.meetingId} AS uuid),
      CAST(${input.scope.workspaceId} AS uuid),
      CAST(${input.jobId} AS uuid)
    )
    ON CONFLICT (user_id, meeting_id) DO NOTHING
    RETURNING job_id AS "jobId"
  `;

  return ledger.length !== 0;
};

export async function enqueueMemorySource(input: {
  scope: MemoryScope;
  meeting: MemorySource;
  preferencesRevision: number;
}): Promise<MemoryJob | null> {
  const { scope, meeting, preferencesRevision } = input;
  if (!(await meetingCanEnqueue({ scope, meeting }))) {
    return null;
  }
  const jobId = randomUUID();
  const leaseToken = randomUUID();
  if (!(await claimMemoryGenerationLedger({ scope, meetingId: meeting.meetingId, jobId }))) {
    return null;
  }
  const enqueuedSource: { previous: { id: string; revision: string } | null; sourceId: string | null } = {
    previous: null,
    sourceId: null,
  };
  try {
    const occurredAt = new Date(meeting.occurredAt);
    const existing = await db.memorySources.findUnique({
      where: {
        userId_workspaceId_kind_externalId: {
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          kind: "meeting_transcript",
          externalId: meeting.meetingId,
        },
      },
    });
    enqueuedSource.previous = existing ?? null;
    const history = await db.memorySensitivityHistory.findFirst({
      where: {
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        effectiveAt: { lte: occurredAt },
      },
      orderBy: { effectiveAt: "desc" },
    });
    const saved = await db.memorySources.upsert({
      where: {
        userId_workspaceId_kind_externalId: {
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          kind: "meeting_transcript",
          externalId: meeting.meetingId,
        },
      },
      create: {
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        kind: "meeting_transcript",
        externalId: meeting.meetingId,
        meetingId: meeting.meetingId,
        occurredAt,
        revision: meeting.revision,
        /** @external persisted include_sensitive column */
        includeSensitive: history?.includeSensitive ?? false,
      },
      update: { revision: meeting.revision },
    });
    enqueuedSource.sourceId = saved.id;
    await db.memoryGenerationLedger.updateMany({
      where: { jobId },
      data: {
        sourceId: enqueuedSource.sourceId,
        sourceRevision: meeting.revision,
        preferencesRevision,
        requestToken: leaseToken,
      },
    });

    return {
      ...scope,
      id: jobId,
      sourceId: enqueuedSource.sourceId,
      kind: "extract",
      sourceRevision: meeting.revision,
      preferencesRevision,
      leaseToken,
      attempts: 0,
      extractedAt: null,
    };
  } catch (error) {
    await compensateEnqueuedSource({
      jobId,
      previous: enqueuedSource.previous,
      sourceId: enqueuedSource.sourceId,
    });
    throw error;
  }
}

export async function memoryJobProgress(scope: MemoryScope): Promise<MemoryJobProgressCounts> {
  const rows = await db.memoryGenerationLedger.findMany({
    where: { userId: scope.userId, workspaceId: scope.workspaceId },
  });

  return {
    queued: 0,
    running: rows.filter((r) => r.completedAt === null).length,
    completed: rows.filter((r) => r.completedAt !== null && r.error === null).length,
    failed: rows.filter((r) => r.error !== null).length,
    projectionQueued: 0,
    projectionRunning: 0,
    projectionFailed: 0,
  };
}

export async function latestProcessingMemoryMeeting(input: {
  scope: MemoryScope;
  sourceIds: string[];
}): Promise<{ meetingId: string; endedAt: string } | null> {
  if (input.sourceIds.length === 0) {
    return null;
  }
  const row = await db.memoryGenerationLedger.findFirst({
    where: {
      userId: input.scope.userId,
      workspaceId: input.scope.workspaceId,
      sourceId: { in: input.sourceIds },
      completedAt: null,
    },
    orderBy: { meetings: { endedAt: { sort: "desc", nulls: "first" } } },
    include: { meetings: {} },
  });

  return row?.meetings.endedAt ? { meetingId: row.meetings.id, endedAt: row.meetings.endedAt.toISOString() } : null;
}

export async function heartbeatMemoryJob(job: MemoryJob): Promise<void> {
  await assertCurrentMemoryJob(job);
}

export async function finishMemoryJob(input: { job: MemoryJob; error?: unknown }): Promise<void> {
  await db.memoryGenerationLedger.updateMany({
    where: { jobId: input.job.id, requestToken: input.job.leaseToken },
    data: {
      completedAt: new Date(),
      error:
        input.error === undefined ? null : `Memory generation failed (${memoryFailureDiagnostic(input.error).code}).`,
    },
  });
}

export function memoryFactFingerprint(identity: MemoryFactIdentity): string {
  const parsed = memoryFactIdentitySchema.parse(identity);
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

  return hash([
    "fact-v1",
    normalize(parsed.subject),
    normalize(parsed.predicate),
    normalize(parsed.object),
    normalize(parsed.context),
  ]);
}

async function assertNoLegacyMemorySuppression(input: { sourceId: string; client?: DbTransaction }): Promise<void> {
  void input.client;
  const rows = await db.memoryLegacySuppressions.findMany({
    where: { sourceId: input.sourceId },
    take: 1,
  });
  if (rows.length !== 0) {
    throw new Error(MESSAGE_LEGACY_FORGOTTEN_FACTS_BLOCKED);
  }
}

async function memoryKnownFacts(input: {
  sourceId: string;
  client?: DbTransaction;
}): Promise<NonNullable<MemoryExtractionInput["knownFacts"]>> {
  void input.client;
  const [memories, suppressions] = await Promise.all([
    db.relationshipMemories.findMany({
      where: { sourceId: input.sourceId },
    }),
    db.memorySuppressions.findMany({
      where: { sourceId: input.sourceId },
    }),
  ]);
  const facts = new Map<string, MemoryKnownFact>();
  memories.forEach((row) => {
    facts.set(row.factFingerprint, {
      key: row.factFingerprint,
      identity: asFactIdentity(row.factIdentity),
      /** @external existing known-fact wire field */
      suppressed: false,
    });
  });
  suppressions.forEach((row) => {
    facts.set(row.factFingerprint, {
      key: row.factFingerprint,
      identity: asFactIdentity(row.factIdentity),
      /** @external existing known-fact wire field */
      suppressed: true,
    });
  });

  return [...facts.values()].toSorted((left, right) => compareText({ left: left.key, right: right.key }));
}

async function preferredGuestObservationName(personId: string): Promise<string | null> {
  const names = await db.memoryPersonNames.findMany({
    where: { personId, wordCount: { gt: 0 } },
  });
  if (names.length === 0) {
    return null;
  }
  const groups = new Map<string, typeof names>();
  names.forEach((name) => {
    const key = `${name.wordCount}:${name.normalizedName}`;
    const list = groups.get(key) ?? [];
    groups.set(key, [...list, name]);
  });
  const [winner] = [...groups.values()].toSorted((left, right) => {
    const wordCount = (right[0]?.wordCount ?? 0) - (left[0]?.wordCount ?? 0);
    if (wordCount !== 0) {
      return wordCount;
    }
    if (left.length !== right.length) {
      return right.length - left.length;
    }
    const observed =
      Math.min(...left.map((name) => name.observedAt.getTime())) -
      Math.min(...right.map((name) => name.observedAt.getTime()));
    if (observed !== 0) {
      return observed;
    }

    return compareText({ left: left[0]?.normalizedName ?? "", right: right[0]?.normalizedName ?? "" });
  });
  const earliest = [...(winner ?? [])].toSorted((left, right) => {
    const time = left.observedAt.getTime() - right.observedAt.getTime();
    if (time !== 0) {
      return time;
    }

    return firstDifference([
      compareText({ left: left.sourceId, right: right.sourceId }),
      compareText({ left: left.participantUserId, right: right.participantUserId }),
    ]);
  })[0];

  return earliest?.name ?? null;
}

async function linkedAccountDisplayName(personId: string): Promise<string | null> {
  const identities = await db.memoryPersonIdentities.findMany({
    where: { personId, kind: "user_id" },
  });
  const userIds = uuidTexts(identities.map((identity) => identity.identity));
  if (userIds.length === 0) {
    return null;
  }
  const userRows = await db.users.findMany({ where: { id: { in: userIds } } });
  const [match] = userRows
    .filter((user) => user.deletedAt === null && ACCOUNT_SOURCES.has(user.source))
    .toSorted((left, right) => compareText({ left: left.id, right: right.id }));

  return match?.displayName ?? null;
}

async function insertParticipantIdentityRows(input: {
  personId: string;
  scope: MemoryScope;
  source: MemorySource;
  participant: { userId: string; name: string; browserId: string | null };
  identityValues: string[];
}): Promise<void> {
  const { personId, scope, source, participant: person, identityValues } = input;
  const userIdentities = identityValues
    .filter((identity) => identity !== "")
    .map((identity) => ({
      personId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      kind: "user_id",
      identity,
    }));
  if (userIdentities.length !== 0) {
    const identityRows = Prisma.join(
      userIdentities.map(
        (identity) =>
          Prisma.sql`(CAST(${identity.personId} AS uuid), CAST(${identity.userId} AS uuid), CAST(${identity.workspaceId} AS uuid), ${identity.kind}, ${identity.identity})`,
      ),
    );
    await db.$executeRaw`
      INSERT INTO memory_person_identities (person_id, user_id, workspace_id, kind, identity)
      VALUES ${identityRows}
      ON CONFLICT DO NOTHING
    `;
  }
  if (person.browserId === null || person.browserId === "") {
    return;
  }
  await db.$executeRaw`
    INSERT INTO memory_person_identities (person_id, user_id, workspace_id, kind, identity)
    VALUES (
      CAST(${personId} AS uuid),
      CAST(${scope.userId} AS uuid),
      CAST(${scope.workspaceId} AS uuid),
      ${"guest_browser"},
      ${person.browserId}
    )
    ON CONFLICT DO NOTHING
  `;
  const name = normalizeGuestName(person.name);
  await db.$executeRaw`
    INSERT INTO memory_person_names (
      person_id,
      source_id,
      participant_user_id,
      name,
      normalized_name,
      word_count,
      observed_at
    )
    VALUES (
      CAST(${personId} AS uuid),
      CAST(${source.id} AS uuid),
      CAST(${person.userId} AS uuid),
      ${name.display},
      ${name.normalized},
      ${name.wordCount},
      ${new Date(source.occurredAt)}
    )
    ON CONFLICT DO NOTHING
  `;
}

async function rememberSingleMemoryExtractionParticipant(input: {
  scope: MemoryScope;
  source: MemorySource;
  participant: { userId: string; name: string; browserId: string | null; accountId: string | null };
}): Promise<MemoryExtractionInput["people"][number]> {
  const { scope, source, participant: person } = input;
  const identityValues = [person.userId, ...(person.accountId === null ? [] : [person.accountId])];
  const identityMatch = [
    { kind: "user_id", identity: { in: identityValues } },
    ...(person.browserId === null || person.browserId === ""
      ? []
      : [{ kind: "guest_browser", identity: person.browserId }]),
  ];
  const existing = await db.memoryPersonIdentities.findMany({
    where: {
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      OR: identityMatch,
    },
  });
  const [matched] = existing.toSorted((left, right) =>
    firstDifference([
      Number(left.kind !== "user_id") - Number(right.kind !== "user_id"),
      compareText({ left: left.identity, right: right.identity }),
      compareText({ left: left.personId, right: right.personId }),
    ]),
  );
  const id = matched?.personId ?? randomUUID();
  if (matched === undefined) {
    await db.memoryPeople.create({
      data: { id, userId: scope.userId, workspaceId: scope.workspaceId, name: person.name },
    });
  }
  await insertParticipantIdentityRows({ personId: id, scope, source, participant: person, identityValues });
  if (person.browserId !== null && person.browserId !== "") {
    const observedName = await preferredGuestObservationName(id);
    if (observedName !== null) {
      await db.memoryPeople.updateMany({ where: { id }, data: { name: observedName } });
    }
  } else {
    await db.memoryPeople.updateMany({ where: { id }, data: { name: person.name } });
  }
  const accountName = await linkedAccountDisplayName(id);
  if (accountName !== null) {
    await db.memoryPeople.updateMany({ where: { id }, data: { name: accountName } });
  }
  const occurredAt = new Date(source.occurredAt);
  await db.memoryInteractions.upsert({
    where: { sourceId_personId: { sourceId: source.id, personId: id } },
    create: { sourceId: source.id, personId: id, occurredAt },
    update: { occurredAt },
  });

  return { id, userId: person.userId, name: person.name };
}

async function rememberMemoryExtractionPeople(input: {
  scope: MemoryScope;
  source: MemorySource;
}): Promise<MemoryExtractionInput["people"]> {
  const { scope, source } = input;
  const eligible = await loadEligibleMeetings({ scope, meetingIds: [source.meetingId] });
  const meeting = eligible[0]?.meeting;
  if (meeting?.endedAt === undefined || meeting.endedAt === null) {
    return [];
  }
  const endedAt = meeting.endedAt;
  const intervals = await db.meetingAttendanceIntervals.findMany({ where: { meetingId: source.meetingId } });
  const participants = await db.meetingParticipants.findMany({
    where: { meetingId: source.meetingId },
  });
  const participantIds = new Set(participants.map((participant) => participant.userId));
  const otherIds = [
    ...new Set(
      intervals
        .map((interval) => interval.userId)
        .filter((userId) => userId !== scope.userId && participantIds.has(userId)),
    ),
  ];
  if (otherIds.length === 0) {
    return [];
  }
  const userRows = await db.users.findMany({ where: { id: { in: otherIds } } });
  const usersById = new Map(userRows.map((user) => [user.id, user]));
  const matchedUsers = otherIds.flatMap((userId) => {
    const user = usersById.get(userId);
    if (user === undefined || user.deletedAt !== null || user.source === "debug_import") {
      return [];
    }
    const viewer = intervals.filter((interval) => interval.userId === scope.userId);
    const theirs = intervals.filter((interval) => interval.userId === userId);
    if (!viewer.some((left) => theirs.some((right) => intervalsOverlap({ left, right, endedAt })))) {
      return [];
    }

    return [user];
  });
  const guestIds = matchedUsers.filter((user) => user.source === "guest").map((user) => user.id);
  const allIds = matchedUsers.map((user) => user.id);
  const [guestBrowsers, links] = await Promise.all([
    guestIds.length === 0
      ? Promise.resolve([])
      : db.guestBrowserUsers.findMany({ where: { guestUserId: { in: guestIds } } }),
    allIds.length === 0
      ? Promise.resolve([])
      : db.guestMemoryAccountLinks.findMany({ where: { guestUserId: { in: allIds } } }),
  ]);
  const browserIds = guestBrowsers.map((row) => row.browserId);
  const browsers =
    browserIds.length === 0 ? [] : await db.guestBrowserIdentities.findMany({ where: { id: { in: browserIds } } });
  const browserByGuest = new Map(guestBrowsers.map((row) => [row.guestUserId, row.browserId]));
  const browserById = new Map(browsers.map((row) => [row.id, row]));
  const accountByGuest = new Map(links.map((row) => [row.guestUserId, row.accountUserId]));
  const people = await matchedUsers.reduce<Promise<MemoryExtractionInput["people"]>>(async (previous, user) => {
    const collected = await previous;
    const browserId = user.source === "guest" ? (browserByGuest.get(user.id) ?? null) : null;
    const accountId = accountByGuest.get(user.id) ?? browserById.get(browserId ?? "")?.linkedAccountUserId ?? null;
    const remembered = await rememberSingleMemoryExtractionParticipant({
      scope,
      source,
      participant: { userId: user.id, name: user.displayName, browserId, accountId },
    });

    return [...collected, remembered];
  }, Promise.resolve([]));
  const personIds = people.map((person) => person.id);
  if (personIds.length === 0) {
    return [];
  }
  const stored = await db.memoryPeople.findMany({
    where: { id: { in: personIds } },
  });
  const names = new Map(stored.map((person) => [person.id, person.name]));

  return people.map((person) => {
    const canonicalName = names.get(person.id);

    return canonicalName === undefined ? person : { ...person, name: canonicalName };
  });
}

export async function prepareMemoryInput(input: {
  scope: MemoryScope;
  source: MemorySource;
  preferences: MemoryPreferences;
}): Promise<MemoryExtractionInput> {
  const { scope, source, preferences } = input;
  const authorizedSource = await db.memorySources.findFirst({
    where: {
      id: source.id,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      meetingId: source.meetingId,
    },
    include: { meetings: {} },
  });
  const authorized =
    authorizedSource?.meetings === null || authorizedSource?.meetings === undefined
      ? null
      : { meetingWorkspaceId: authorizedSource.meetings.workspaceId };
  if (authorized === null) {
    throw new Error(MESSAGE_MEMORY_SOURCE_OUT_OF_SCOPE);
  }
  const binding = await db.meetingAttendeeWorkspaces.findUnique({
    where: { meetingId_userId: { meetingId: source.meetingId, userId: scope.userId } },
  });
  if ((binding?.workspaceId ?? authorized.meetingWorkspaceId) !== scope.workspaceId) {
    throw new Error(MESSAGE_MEMORY_SOURCE_OUT_OF_SCOPE);
  }
  await assertNoLegacyMemorySuppression({ sourceId: source.id });
  const knownFacts = await memoryKnownFacts({ sourceId: source.id });
  const people = await rememberMemoryExtractionPeople({ scope, source });
  const segments = await db.transcriptSegments.findMany({
    where: { speakerRole: "human", transcripts: { meetingId: source.meetingId } },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
  });

  return {
    meetingId: source.meetingId,
    knownFacts,
    ownerUserId: scope.userId,
    title: source.title,
    occurredAt: source.occurredAt,
    preferences: {
      ...preferences,
      /** @external existing wire contract */ includeSensitive: source.includeSensitive ?? false,
    },
    people,
    segments: segments.map((segment) => ({
      id: segment.id,
      speakerUserId: segment.speakerUserId,
      speakerName: segment.speakerName,
      content: segment.content,
      startedAt: segment.startedAt.toISOString(),
    })),
  };
}

async function assertCurrentMemoryJob(job: MemoryJob): Promise<void> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT ledger.job_id AS id
    FROM memory_generation_ledger AS ledger
    INNER JOIN memory_preferences AS preferences
      ON preferences.user_id = ledger.user_id
      AND preferences.workspace_id = ledger.workspace_id
    WHERE ledger.job_id = CAST(${job.id} AS uuid)
      AND ledger.request_token = CAST(${job.leaseToken} AS uuid)
      AND ledger.completed_at IS NULL
      AND preferences.revision = ${job.preferencesRevision}
  `;
  if (rows.length === 0) {
    throw new Error(MESSAGE_MEMORY_JOB_OR_PREFERENCES_CHANGED);
  }
}

function relationshipMemoryKnownFact(input: {
  memory: MemoryCandidate;
  facts: Map<string, MemoryKnownFact>;
  identityHash: string;
}): MemoryKnownFact | undefined {
  if (typeof input.memory.existingFactKey === "string" && input.memory.existingFactKey !== "") {
    return input.facts.get(input.memory.existingFactKey);
  }

  return [...input.facts.values()].find((fact) => memoryFactFingerprint(fact.identity) === input.identityHash);
}

function resolveRelationshipMemoryCandidatePersist(input: {
  memory: MemoryCandidate;
  facts: Map<string, MemoryKnownFact>;
  priorMemoryRows: { fingerprint: string; fact_fingerprint: string }[];
  usedFingerprints: Set<string>;
}): { factIdentity: MemoryFactIdentity; factFingerprint: string; fingerprint: string } | null {
  const identity = memoryFactIdentitySchema.parse(input.memory.factIdentity);
  const identityHash = memoryFactFingerprint(identity);
  const knownFact = relationshipMemoryKnownFact({ memory: input.memory, facts: input.facts, identityHash });
  const hasExistingFactKey = typeof input.memory.existingFactKey === "string" && input.memory.existingFactKey !== "";
  if (hasExistingFactKey && knownFact === undefined) {
    throw new Error(MESSAGE_UNKNOWN_MEMORY_FACT);
  }
  if (knownFact && memoryFactFingerprint(knownFact.identity) !== identityHash) {
    throw new Error(MESSAGE_MEMORY_FACT_IDENTITY_MISMATCH);
  }
  const factIdentity = knownFact?.identity ?? identity;
  const factFingerprint = knownFact?.key ?? memoryFactFingerprint(factIdentity);
  const isSuppressed = input.facts.get(factFingerprint)?.suppressed === true;
  if (isSuppressed) {
    return null;
  }
  const prior = input.priorMemoryRows.find((row) => row.fact_fingerprint === factFingerprint);
  const fingerprint = prior?.fingerprint ?? factFingerprint;
  if (input.usedFingerprints.has(fingerprint)) {
    return null;
  }

  return { factIdentity, factFingerprint, fingerprint };
}

async function evidenceOccurredAt(input: { segmentIds: string[]; meetingId: string }): Promise<Date | null> {
  if (input.segmentIds.length === 0) {
    return null;
  }
  const segments = await db.transcriptSegments.findMany({
    where: { id: { in: input.segmentIds }, transcripts: { meetingId: input.meetingId } },
  });

  return segments.reduce<Date | null>((latest, segment) => {
    if (latest === null || segment.startedAt > latest) {
      return segment.startedAt;
    }

    return latest;
  }, null);
}

async function insertRelationshipMemoryCandidateRow(input: {
  source: MemorySource;
  memory: MemoryCandidate;
  factIdentity: MemoryFactIdentity;
  factFingerprint: string;
  fingerprint: string;
}): Promise<string> {
  const evidenceAt = await evidenceOccurredAt({
    segmentIds: input.memory.evidence.map((evidence) => evidence.segmentId),
    meetingId: input.source.meetingId,
  });
  const savedMemory = await db.relationshipMemories.upsert({
    where: { sourceId_fingerprint: { sourceId: input.source.id, fingerprint: input.fingerprint } },
    create: {
      sourceId: input.source.id,
      fingerprint: input.fingerprint,
      title: input.memory.title,
      description: input.memory.description,
      category: input.memory.category,
      personIds: input.memory.personIds,
      candidateSubjectId: input.memory.candidateSubjectId,
      candidateSubjectKey: input.memory.candidateSubjectKey,
      /** @external persisted sensitive column */
      sensitive: input.memory.sensitive,
      confidence: input.memory.confidence,
      occurredAt: new Date(input.source.occurredAt),
      importance: input.memory.importance ?? 1,
      factFingerprint: input.factFingerprint,
      factIdentity: jsonInput(input.factIdentity),
      evidenceOccurredAt: evidenceAt,
    },
    update: {
      title: input.memory.title,
      description: input.memory.description,
      category: input.memory.category,
      personIds: input.memory.personIds,
      candidateSubjectId: input.memory.candidateSubjectId,
      candidateSubjectKey: input.memory.candidateSubjectKey,
      /** @external persisted sensitive column */
      sensitive: input.memory.sensitive,
      confidence: input.memory.confidence,
      importance: input.memory.importance ?? 1,
      factFingerprint: input.factFingerprint,
      factIdentity: jsonInput(input.factIdentity),
      evidenceOccurredAt: evidenceAt,
    },
  });
  await db.memoryEvidence.deleteMany({ where: { memoryId: savedMemory.id } });
  await input.memory.evidence.reduce(async (evidenceStep, evidence) => {
    await evidenceStep;
    await db.memoryEvidence.createMany({
      data: [{ memoryId: savedMemory.id, segmentId: evidence.segmentId, quote: evidence.quote }],
      skipDuplicates: true,
    });
  }, Promise.resolve());

  return savedMemory.id;
}

async function persistRelationshipMemoryCandidates(input: {
  source: MemorySource;
  candidates: MemoryCandidate[];
  facts: Map<string, MemoryKnownFact>;
  priorMemoryRows: { fingerprint: string; fact_fingerprint: string }[];
  generation?: PersistMemoryExtractionGeneration;
}): Promise<{ keep: string[]; newIds: Map<string, string> }> {
  const result = await input.candidates.reduce(
    async (accumulator, memory, index) => {
      const state = await accumulator;
      const resolved = resolveRelationshipMemoryCandidatePersist({
        memory,
        facts: input.facts,
        priorMemoryRows: input.priorMemoryRows,
        usedFingerprints: state.usedFingerprints,
      });
      if (resolved === null) {
        return state;
      }
      const memoryId = await insertRelationshipMemoryCandidateRow({
        source: input.source,
        memory,
        factIdentity: resolved.factIdentity,
        factFingerprint: resolved.factFingerprint,
        fingerprint: resolved.fingerprint,
      });
      const nextIds = new Map(state.newIds);
      const ref = input.generation?.value.memories[index]?.ref;
      if (ref !== undefined && ref !== "") {
        nextIds.set(ref, memoryId);
      }

      return {
        keep: [...state.keep, memoryId],
        newIds: nextIds,
        usedFingerprints: new Set([...state.usedFingerprints, resolved.fingerprint]),
      };
    },
    Promise.resolve({
      keep: [] as string[],
      newIds: new Map<string, string>(),
      usedFingerprints: new Set<string>(),
    }),
  );

  return { keep: result.keep, newIds: result.newIds };
}

async function sourceRevisionsAreCurrent(input: {
  sourceRevisions: unknown;
  sourceIds: string[];
  scope?: MemoryScope;
}): Promise<boolean> {
  if (
    typeof input.sourceRevisions !== "object" ||
    input.sourceRevisions === null ||
    Array.isArray(input.sourceRevisions)
  ) {
    return false;
  }
  const entries = Object.entries(input.sourceRevisions).flatMap(([id, revision]) =>
    typeof revision === "string" ? [[id, revision] as const] : [],
  );
  if (entries.length !== Object.keys(input.sourceRevisions).length) {
    return false;
  }
  if (entries.length === 0) {
    return true;
  }
  const sources = await db.memorySources.findMany({
    where: { id: { in: entries.map(([id]) => id) } },
  });
  const byId = new Map(sources.map((source) => [source.id, source]));
  const allowed = new Set(input.sourceIds);
  const revisions = await revisionsByMeeting({
    meetingIds: sources.flatMap((source) => (source.meetingId === null ? [] : [source.meetingId])),
    sources,
  });

  return entries.every(([id, revision]) => {
    const source = byId.get(id);
    if (
      source === undefined ||
      !allowed.has(source.id) ||
      !source.isCurrent ||
      source.revision !== revision ||
      source.meetingId === null
    ) {
      return false;
    }
    if (
      input.scope !== undefined &&
      (source.userId !== input.scope.userId || source.workspaceId !== input.scope.workspaceId)
    ) {
      return false;
    }

    return revisions.get(source.meetingId) === revision;
  });
}

export function memoryProjectionHash(input: {
  memories: Pick<RelationshipMemory, "id" | "title" | "description" | "occurredAt">[];
  language: string;
}): string {
  return hash([
    MEMORY_PROMPT_VERSION,
    input.language,
    input.memories.map((memory) => [memory.id, memory.title, memory.description, memory.occurredAt]).sort(),
  ]);
}

export async function readMemoryProjection(input: {
  personId: string;
  sourceIds: string[];
  db?: DbTransaction;
}): Promise<MemoryProjection | null> {
  void input.db;
  const row = await db.memoryPersonProjections.findUnique({ where: { personId: input.personId } });
  if (row === null || row.sourceRevisions === null) {
    return null;
  }
  if (!(await sourceRevisionsAreCurrent({ sourceRevisions: row.sourceRevisions, sourceIds: input.sourceIds }))) {
    return null;
  }
  const projection = memoryProjectionSchema.parse(row.content);
  const citedIds = [...new Set(projectionMemoryIds(projection))];
  const available =
    citedIds.length === 0 || input.sourceIds.length === 0
      ? []
      : await db.relationshipMemories.findMany({
          where: { id: { in: citedIds }, sourceId: { in: input.sourceIds } },
        });
  const availableIds = new Set(available.map((memory) => memory.id));
  // A summary line is only as visible as every memory it cites: Forget and access changes hide it immediately.
  const visible = projectionCitingOnly({ projection, isAllowed: (id) => availableIds.has(id) });

  return visible.summary.length === 0 && visible.standing.length === 0 ? null : visible;
}

function projectionMemoryIds(projection: MemoryProjection): string[] {
  return [...projection.summary, ...projection.standing].flatMap((entry) => entry.memoryIds);
}

function projectionCitingOnly(input: {
  projection: MemoryProjection;
  isAllowed: (memoryId: string) => boolean;
}): MemoryProjection {
  const keep = <T extends { memoryIds: string[] }>(entries: T[]): T[] =>
    entries.filter((entry) => entry.memoryIds.every((id) => input.isAllowed(id)));

  return { summary: keep(input.projection.summary), standing: keep(input.projection.standing) };
}

type MemoryTransaction = DbTransaction;

/** Drops stored summary lines that cite forgotten memories, so the saved summary never outlives a Forget. */
async function pruneForgottenFromProjections(input: {
  tx: MemoryTransaction;
  personIds: string[];
  forgottenIds: Set<string>;
}): Promise<void> {
  if (input.personIds.length === 0) {
    return;
  }
  const redirects = await input.tx.memoryPersonRedirects.findMany({
    where: { personId: { in: input.personIds } },
  });
  const personIds = [...new Set([...input.personIds, ...redirects.map((row) => row.targetPersonId)])];
  const lockedPersonIds = Prisma.join(personIds.map((personId) => Prisma.sql`CAST(${personId} AS uuid)`));
  // Lock the rows so a summary saved by a concurrent meeting is never overwritten with this older copy.
  const rows = await input.tx.$queryRaw<
    {
      personId: string;
      content: Prisma.JsonValue;
    }[]
  >`
    SELECT person_id AS "personId", content
    FROM memory_person_projections
    WHERE person_id IN (${lockedPersonIds})
    FOR UPDATE
  `;
  const decoded = await decodeContentRow({ model: "memoryPersonProjections", value: rows });
  await decoded.reduce(async (previous, row) => {
    await previous;
    const parsed = memoryProjectionSchema.safeParse(row.content);
    const content = parsed.success
      ? projectionCitingOnly({ projection: parsed.data, isAllowed: (id) => !input.forgottenIds.has(id) })
      : {
          summary: readProjectionEntries({ content: row.content, section: "summary" }).filter((entry) =>
            entry.memoryIds.every((id) => !input.forgottenIds.has(id)),
          ),
          standing: readProjectionEntries({ content: row.content, section: "standing" }).filter((entry) =>
            entry.memoryIds.every((id) => !input.forgottenIds.has(id)),
          ),
        };
    if (JSON.stringify(content) === JSON.stringify(row.content)) {
      return;
    }
    await input.tx.memoryPersonProjections.updateMany({
      where: { personId: row.personId },
      data: { content: jsonInput(content), updatedAt: new Date() },
    });
  }, Promise.resolve());
}

export async function saveMemoryProjection(input: {
  personId: string;
  inputHash: string;
  projection: MemoryProjection;
  sourceRevisions: Record<string, string>;
  db?: DbTransaction;
}): Promise<void> {
  void input.db;
  const now = new Date();
  await db.memoryPersonProjections.upsert({
    where: { personId: input.personId },
    create: {
      personId: input.personId,
      inputHash: input.inputHash,
      content: jsonInput(input.projection),
      promptVersion: MEMORY_PROMPT_VERSION,
      sourceRevisions: jsonInput(input.sourceRevisions),
      updatedAt: now,
    },
    update: {
      inputHash: input.inputHash,
      content: jsonInput(input.projection),
      promptVersion: MEMORY_PROMPT_VERSION,
      sourceRevisions: jsonInput(input.sourceRevisions),
      updatedAt: now,
    },
  });
}

export async function listMemoryProjectionEvidence(input: {
  sourceIds: string[];
  personIds: string[];
  db?: DbTransaction;
}): Promise<Pick<RelationshipMemory, "id" | "sourceId" | "title" | "description" | "occurredAt" | "personIds">[]> {
  void input.db;
  if (input.sourceIds.length === 0 || input.personIds.length === 0) {
    return [];
  }
  const stored = await db.relationshipMemories.findMany({
    where: { memorySources: { id: { in: input.sourceIds }, isCurrent: true } },
    include: { memorySources: {} },
  });
  const rows = stored.map((memory) => ({
    id: memory.id,
    sourceId: memory.sourceId,
    title: memory.title,
    description: memory.description,
    occurredAt: memory.occurredAt,
    importance: memory.importance,
    personIds: memory.personIds,
    /** @external persisted sensitive column */
    sensitive: memory.sensitive,
    /** @external persisted include_sensitive column */
    includeSensitive: memory.memorySources.includeSensitive,
  }));
  const memoryIds = rows.map((row) => row.id);
  const evidence =
    memoryIds.length === 0
      ? []
      : await db.memoryEvidence.findMany({
          where: { memoryId: { in: memoryIds } },
        });
  const evidenced = new Set(evidence.map((row) => row.memoryId));
  const wanted = new Set(input.personIds);

  return rows
    .filter(
      (row) =>
        evidenced.has(row.id) &&
        (!row.sensitive || row.includeSensitive) &&
        row.personIds.some((personId) => wanted.has(personId)),
    )
    .sort(
      (left, right) =>
        -comparePosition({
          left: { occurredAt: left.occurredAt, importance: left.importance, id: left.id },
          right: { occurredAt: right.occurredAt, importance: right.importance, id: right.id },
        }),
    )
    .map((row) => ({
      id: row.id,
      sourceId: row.sourceId,
      title: row.title,
      description: row.description,
      occurredAt: row.occurredAt.toISOString(),
      personIds: row.personIds,
    }));
}

async function canonicalPeople(personIds: string[]): Promise<Map<string, { canonical: string; isMerged: boolean }>> {
  if (personIds.length === 0) {
    return new Map();
  }
  const redirects = await db.memoryPersonRedirects.findMany({ where: { personId: { in: personIds } } });
  const redirectByPerson = new Map(redirects.map((row) => [row.personId, row.targetPersonId]));
  const canonicalIds = [...new Set(personIds.map((personId) => redirectByPerson.get(personId) ?? personId))];
  const incoming =
    canonicalIds.length === 0
      ? []
      : await db.memoryPersonRedirects.findMany({
          where: { targetPersonId: { in: canonicalIds } },
        });
  const mergedTargets = new Set(incoming.map((row) => row.targetPersonId));

  return new Map(
    personIds.map((personId) => {
      const canonical = redirectByPerson.get(personId) ?? personId;

      return [personId, { canonical, isMerged: mergedTargets.has(canonical) }];
    }),
  );
}

async function publishMemoryGenerationForPerson(input: {
  source: MemorySource;
  generation: PersistMemoryExtractionGeneration;
  newIds: Map<string, string>;
  personId: string;
  group: { isMerged: boolean; people: MemoryGeneration["people"] };
  current: Pick<RelationshipMemory, "id" | "sourceId" | "title" | "description" | "occurredAt" | "personIds">[];
  sourceRevisions: Record<string, string>;
  isProvenanceValid: boolean;
}): Promise<void> {
  if (!input.isProvenanceValid || input.sourceRevisions[input.source.id] !== input.source.revision) {
    return;
  }
  const own = input.current.filter((memory) => memory.personIds.includes(input.personId));
  const originalIds = new Set(input.group.people.map((person) => person.personId));
  const history = [
    ...new Map(
      input.generation.history
        .filter((person) => originalIds.has(person.personId))
        .flatMap((person) => person.memories)
        .map((memory) => [memory.id, memory]),
    ).values(),
  ];
  const historical = own.filter((memory) => memory.sourceId !== input.source.id);
  const historyIds = new Set(history.map((memory) => memory.id));
  const isConsolidated =
    input.group.people.some((person) => person.personId !== input.personId) ||
    input.group.people.length > 1 ||
    (input.group.isMerged && historical.length > history.length);
  if (
    memoryProjectionHash({
      memories: isConsolidated ? historical.filter((memory) => historyIds.has(memory.id)) : historical,
      language: input.generation.language,
    }) !== memoryProjectionHash({ memories: history, language: input.generation.language })
  ) {
    return;
  }
  const person = {
    summary: input.group.people.flatMap((item) => item.summary),
    standing: input.group.people.flatMap((item) => item.standing),
  };
  const allowed = new Set(own.map((memory) => memory.id));
  const resolve = (items: typeof person.summary) =>
    items.flatMap((item) => {
      const ids = item.memoryRefs.map((ref) => input.newIds.get(ref) ?? ref);

      return ids.every((id) => allowed.has(id)) ? [{ text: item.text, memoryIds: ids }] : [];
    });
  if (
    [...person.summary, ...person.standing].some((item) =>
      item.memoryRefs.some((ref) => !allowed.has(input.newIds.get(ref) ?? ref)),
    )
  ) {
    return;
  }
  const projection = { summary: resolve(person.summary), standing: resolve(person.standing) };
  const previousProjection = isConsolidated
    ? await readMemoryProjection({ personId: input.personId, sourceIds: input.generation.sourceIds })
    : null;
  const revisions = await (async () => {
    if (previousProjection === null) {
      return input.sourceRevisions;
    }
    const saved = await db.memoryPersonProjections.findUnique({
      where: { personId: input.personId },
    });
    const savedRevision = requiredMemoryRow(saved);
    (["summary", "standing"] as const).forEach((section) => {
      const entries = [...projection[section], ...previousProjection[section]].filter((item) =>
        item.memoryIds.every((id) => allowed.has(id)),
      );
      projection[section] = [
        ...new Map(entries.map((item) => [JSON.stringify([item.text, [...item.memoryIds].sort()]), item])).values(),
      ];
    });
    if (!isStringRecord(savedRevision.sourceRevisions)) {
      throw new Error(MESSAGE_MEMORY_ROW_NOT_FOUND);
    }

    return { ...savedRevision.sourceRevisions, ...input.sourceRevisions };
  })();
  await saveMemoryProjection({
    personId: input.personId,
    inputHash: memoryProjectionHash({ memories: own, language: input.generation.language }),
    projection,
    sourceRevisions: revisions,
  });
}

async function publishMemoryGenerationProjections(input: {
  job: MemoryJob;
  source: MemorySource;
  generation: PersistMemoryExtractionGeneration;
  newIds: Map<string, string>;
}): Promise<void> {
  const { job, source, generation, newIds } = input;
  const requestedIds = generation.value.people.map((person) => person.personId);
  const owned =
    requestedIds.length === 0
      ? []
      : await db.memoryPeople.findMany({
          where: { id: { in: requestedIds }, userId: job.userId, workspaceId: job.workspaceId },
        });
  const identities = await canonicalPeople(owned.map((person) => person.id));
  const groups = generation.value.people.reduce((grouped, person) => {
    const identity = identities.get(person.personId);
    if (identity === undefined) {
      return grouped;
    }
    const group = grouped.get(identity.canonical) ?? { isMerged: identity.isMerged, people: [] };
    const next = new Map(grouped);
    next.set(identity.canonical, { ...group, people: [...group.people, person] });

    return next;
  }, new Map<string, { isMerged: boolean; people: typeof generation.value.people }>());
  const current = await listMemoryProjectionEvidence({
    sourceIds: generation.sourceIds,
    personIds: [...groups.keys()],
  });
  const sourceRevisions = Object.fromEntries(generation.inputSources.map((item) => [item.id, item.revision]));
  const isProvenanceValid = await sourceRevisionsAreCurrent({
    sourceRevisions,
    sourceIds: generation.sourceIds,
    scope: { userId: job.userId, workspaceId: job.workspaceId },
  });
  await [...groups].reduce(async (groupStep, [personId, group]) => {
    await groupStep;
    await publishMemoryGenerationForPerson({
      source,
      generation,
      newIds,
      personId,
      group,
      current,
      sourceRevisions,
      isProvenanceValid,
    });
  }, Promise.resolve());
}

export async function persistMemoryExtraction(input: {
  job: MemoryJob;
  source: MemorySource;
  candidates: MemoryCandidate[];
  model: string;
  generation?: PersistMemoryExtractionGeneration;
}): Promise<void> {
  const { job, source, candidates, generation } = input;
  await assertCurrentMemoryJob(job);
  const current = await db.memorySources.findFirst({
    where: {
      id: source.id,
      revision: source.revision,
      userId: job.userId,
      workspaceId: job.workspaceId,
    },
  });
  const eligible =
    current?.meetingId === undefined || current.meetingId === null
      ? []
      : await loadEligibleMeetings({
          scope: { userId: job.userId, workspaceId: job.workspaceId },
          meetingIds: [current.meetingId],
        });
  if (current === null || eligible[0]?.revision !== source.revision) {
    throw new Error(MESSAGE_TRANSCRIPT_CHANGED_DURING_EXTRACTION);
  }
  await assertNoLegacyMemorySuppression({ sourceId: source.id });
  const facts = new Map((await memoryKnownFacts({ sourceId: source.id })).map((fact) => [fact.key, fact]));
  const priorMemoryRows = (
    await db.relationshipMemories.findMany({
      where: { sourceId: source.id },
    })
  ).map((row) => ({ fingerprint: row.fingerprint, fact_fingerprint: row.factFingerprint }));
  const { keep, newIds } = await persistRelationshipMemoryCandidates({
    source,
    candidates,
    facts,
    priorMemoryRows,
    generation,
  });
  if (keep.length === 0) {
    await db.relationshipMemories.deleteMany({ where: { sourceId: source.id } });
  } else {
    await db.relationshipMemories.deleteMany({
      where: { sourceId: source.id, id: { notIn: keep } },
    });
  }
  await db.memorySources.updateMany({ where: { id: source.id }, data: { isCurrent: true } });
  const now = new Date();
  await db.memoryGenerationLedger.updateMany({ where: { jobId: job.id }, data: { completedAt: now } });
  if (generation) {
    await publishMemoryGenerationProjections({ job, source, generation, newIds });
  }
}

const confidenceValue = (value: string): RelationshipMemory["confidence"] =>
  value === "high" || value === "medium" || value === "low" ? value : "low";

type MemoryEvidenceQuote = { segmentId: string; quote: string };

type RelationshipMemoryListRow = {
  memory: Prisma.relationshipMemoriesModel;
  /** @external persisted include_sensitive column */
  includeSensitive: boolean;
  meetingId: string | null;
  userId: string;
  workspaceId: string;
};

type RelationshipMemoryFilterState = {
  personId: string | null;
  categories: string[] | null;
  query: string | null;
  from: Date | null;
  to: Date | null;
  personOperator: string;
  categoryOperator: string;
  dateOperator: string;
  idFilter: string[] | null;
  isNewer: boolean;
  beforePosition: NonNullable<RelationshipMemoryListFilters["beforePosition"]> | null;
  throughPosition: NonNullable<RelationshipMemoryListFilters["throughPosition"]> | null;
  cursor: MemoryPosition | null;
  scope: MemoryScope | undefined;
  accessibleMeetings: Set<string>;
  entitledMeetings: Set<string>;
};

const memoryPosition = (
  memory: Pick<RelationshipMemoryListRow["memory"], "occurredAt" | "importance" | "id">,
): MemoryPosition => ({
  occurredAt: memory.occurredAt,
  importance: memory.importance,
  id: memory.id,
});

const readRelationshipMemoryCursor = async (input: {
  beforeId: string | null;
  sourceIds: string[];
}): Promise<MemoryPosition | null> => {
  if (input.beforeId === null) {
    return null;
  }
  const cursor = await db.relationshipMemories.findFirst({
    where: { id: input.beforeId, sourceId: { in: input.sourceIds } },
  });

  return cursor;
};

const loadRelationshipMemoryEvidence = async (
  rows: RelationshipMemoryListRow[],
): Promise<Map<string, MemoryEvidenceQuote[]>> => {
  const memoryIds = rows.map((row) => row.memory.id);
  const evidenceRows =
    memoryIds.length === 0 ? [] : await db.memoryEvidence.findMany({ where: { memoryId: { in: memoryIds } } });

  const grouped = new Map<string, MemoryEvidenceQuote[]>();
  evidenceRows.forEach((row) => {
    const list = grouped.get(row.memoryId) ?? [];
    grouped.set(row.memoryId, [...list, { segmentId: row.segmentId, quote: row.quote }]);
  });

  return grouped;
};

const loadRelationshipMemoryAccess = async (input: {
  scope: MemoryScope | undefined;
  rows: RelationshipMemoryListRow[];
}): Promise<{ accessibleMeetings: Set<string>; entitledMeetings: Set<string> }> => {
  const { scope } = input;
  if (scope === undefined) {
    return { accessibleMeetings: new Set<string>(), entitledMeetings: new Set<string>() };
  }
  const meetingIds = [...new Set(input.rows.flatMap((row) => (row.meetingId === null ? [] : [row.meetingId])))];
  const accessibleMeetings = new Set(
    (await loadEligibleMeetings({ scope, meetingIds })).map((item) => item.meeting.id),
  );
  const flags = await Promise.all(
    meetingIds.map(async (meetingId) => ({
      meetingId,
      isEntitled: await hasMemoryNotesEntitlement({ userId: scope.userId, meetingId }),
    })),
  );

  return {
    accessibleMeetings,
    entitledMeetings: new Set(flags.filter((flag) => flag.isEntitled).map((flag) => flag.meetingId)),
  };
};

const relationshipMemoryFilterState = (input: {
  filters: RelationshipMemoryListFilters;
  scope: MemoryScope | undefined;
  cursor: MemoryPosition | null;
  accessibleMeetings: Set<string>;
  entitledMeetings: Set<string>;
}): RelationshipMemoryFilterState => {
  const { filters } = input;

  return {
    personId: filters.personId ?? null,
    categories:
      filters.category !== undefined && filters.category !== "" ? memoryCategoryFilterValues(filters.category) : null,
    query: filters.q !== undefined && filters.q !== "" ? filters.q : null,
    from: parseOptionalDate(filters.from),
    to: parseOptionalDate(filters.to),
    personOperator: filters.personOperator ?? "is",
    categoryOperator: filters.categoryOperator ?? "is",
    dateOperator: filters.dateOperator ?? "is",
    idFilter: filters.ids ?? null,
    isNewer: filters.newer === true,
    beforePosition: filters.beforePosition ?? null,
    throughPosition: filters.throughPosition ?? null,
    cursor: input.cursor,
    scope: input.scope,
    accessibleMeetings: input.accessibleMeetings,
    entitledMeetings: input.entitledMeetings,
  };
};

const matchesRelationshipMemoryFacts = (input: {
  memory: RelationshipMemoryListRow["memory"];
  evidence: MemoryEvidenceQuote[];
  isSensitiveIncluded: boolean;
  state: RelationshipMemoryFilterState;
}): boolean => {
  if (input.evidence.length === 0 || (input.memory.sensitive && !input.isSensitiveIncluded)) {
    return false;
  }
  if (
    input.state.personId !== null &&
    !xorKeep({ isMatched: input.memory.personIds.includes(input.state.personId), operator: input.state.personOperator })
  ) {
    return false;
  }
  if (
    input.state.categories !== null &&
    !xorKeep({
      isMatched: input.state.categories.includes(input.memory.category),
      operator: input.state.categoryOperator,
    })
  ) {
    return false;
  }
  if (
    input.state.query !== null &&
    !matchesSimpleSearch({
      content: `${input.memory.title} ${input.memory.description}`,
      query: input.state.query,
    })
  ) {
    return false;
  }
  if (input.state.idFilter !== null && !input.state.idFilter.includes(input.memory.id)) {
    return false;
  }

  return true;
};

const matchesRelationshipMemoryWindow = (input: {
  memory: RelationshipMemoryListRow["memory"];
  state: RelationshipMemoryFilterState;
}): boolean => {
  const position = memoryPosition(input.memory);
  if (input.state.cursor !== null && comparePosition({ left: position, right: input.state.cursor }) >= 0) {
    return false;
  }
  if (input.state.from !== null || input.state.to !== null) {
    const isInside =
      (input.state.from === null || input.memory.occurredAt >= input.state.from) &&
      (input.state.to === null || input.memory.occurredAt < input.state.to);
    if (!xorKeep({ isMatched: isInside, operator: input.state.dateOperator })) {
      return false;
    }
  }

  return true;
};

const boundaryPosition = (position: { occurredAt: string; importance: number; id: string }): MemoryPosition => ({
  occurredAt: new Date(position.occurredAt),
  importance: position.importance,
  id: position.id,
});

const matchesRelationshipMemoryPositions = (input: {
  memory: RelationshipMemoryListRow["memory"];
  state: RelationshipMemoryFilterState;
}): boolean => {
  const position = memoryPosition(input.memory);
  if (input.state.beforePosition !== null) {
    const order = comparePosition({ left: position, right: boundaryPosition(input.state.beforePosition) });
    if (input.state.isNewer ? order <= 0 : order >= 0) {
      return false;
    }
  }
  if (
    input.state.throughPosition !== null &&
    comparePosition({ left: position, right: boundaryPosition(input.state.throughPosition) }) < 0
  ) {
    return false;
  }

  return true;
};

const matchesRelationshipMemoryScope = (input: {
  row: RelationshipMemoryListRow;
  state: RelationshipMemoryFilterState;
}): boolean => {
  const { scope } = input.state;
  if (scope === undefined) {
    return true;
  }
  if (input.row.userId !== scope.userId || input.row.workspaceId !== scope.workspaceId) {
    return false;
  }

  return (
    input.row.meetingId !== null &&
    input.state.accessibleMeetings.has(input.row.meetingId) &&
    input.state.entitledMeetings.has(input.row.meetingId)
  );
};

const relationshipMemoryRowMatches = (input: {
  row: RelationshipMemoryListRow;
  evidence: MemoryEvidenceQuote[];
  state: RelationshipMemoryFilterState;
}): boolean =>
  matchesRelationshipMemoryFacts({
    memory: input.row.memory,
    evidence: input.evidence,
    isSensitiveIncluded: input.row.includeSensitive,
    state: input.state,
  }) &&
  matchesRelationshipMemoryWindow({ memory: input.row.memory, state: input.state }) &&
  matchesRelationshipMemoryPositions({ memory: input.row.memory, state: input.state }) &&
  matchesRelationshipMemoryScope({ row: input.row, state: input.state });

const toListedRelationshipMemory = (input: {
  row: RelationshipMemoryListRow;
  evidence: MemoryEvidenceQuote[];
}): RelationshipMemory => ({
  id: input.row.memory.id,
  sourceId: input.row.memory.sourceId,
  meetingId: input.row.meetingId ?? "",
  title: input.row.memory.title,
  description: input.row.memory.description,
  category: relationshipMemoryCategory(input.row.memory.category),
  personIds: input.row.memory.personIds,
  candidateSubjectId: input.row.memory.candidateSubjectId,
  candidateSubjectKey: input.row.memory.candidateSubjectKey,
  /** @external existing memory wire field */
  sensitive: input.row.memory.sensitive,
  confidence: confidenceValue(input.row.memory.confidence),
  importance: input.row.memory.importance,
  occurredAt: input.row.memory.occurredAt.toISOString(),
  evidenceOccurredAt: isoTimestamp(input.row.memory.evidenceOccurredAt),
  evidence: input.evidence.toSorted((left, right) => compareText({ left: left.segmentId, right: right.segmentId })),
});

export async function listRelationshipMemories(input: {
  sourceIds: string[];
  filters?: RelationshipMemoryListFilters;
  scope?: MemoryScope;
}): Promise<RelationshipMemory[]> {
  const filters = input.filters ?? {};
  const { sourceIds, scope } = input;
  if (sourceIds.length === 0 || (filters.ids !== undefined && filters.ids.length === 0)) {
    return [];
  }
  const beforeId = filters.before === undefined || filters.before === "" ? null : filters.before;
  const cursor = await readRelationshipMemoryCursor({ beforeId, sourceIds });
  if (beforeId !== null && cursor === null) {
    return [];
  }
  const storedMemories = await db.relationshipMemories.findMany({
    where: { memorySources: { id: { in: sourceIds }, isCurrent: true } },
    include: { memorySources: {} },
  });
  const rows = storedMemories.map((memory) => ({
    memory,
    /** @external persisted include_sensitive column */
    includeSensitive: memory.memorySources.includeSensitive,
    meetingId: memory.memorySources.meetingId,
    userId: memory.memorySources.userId,
    workspaceId: memory.memorySources.workspaceId,
  }));
  const evidenceByMemory = await loadRelationshipMemoryEvidence(rows);
  const access = await loadRelationshipMemoryAccess({ scope, rows });
  const state = relationshipMemoryFilterState({
    filters,
    scope,
    cursor,
    accessibleMeetings: access.accessibleMeetings,
    entitledMeetings: access.entitledMeetings,
  });
  const filtered = rows.filter((row) =>
    relationshipMemoryRowMatches({ row, evidence: evidenceByMemory.get(row.memory.id) ?? [], state }),
  );
  const direction = state.isNewer ? 1 : -1;
  const ordered = filtered.toSorted(
    (left, right) =>
      direction * comparePosition({ left: memoryPosition(left.memory), right: memoryPosition(right.memory) }),
  );

  return ordered
    .slice(0, filters.limit ?? DEFAULT_MEMORY_PAGE_SIZE)
    .map((row) => toListedRelationshipMemory({ row, evidence: evidenceByMemory.get(row.memory.id) ?? [] }));
}

const memoryPersonImageUrl = (input: { identities: IdentityRow[]; knownUsers: UserRow[] }): string | null => {
  const { identities, knownUsers } = input;
  const matched = new Map<string, UserRow>();
  identities.forEach((identity) => {
    if (identity.kind === "user_id") {
      const user = knownUsers.find((candidate) => candidate.id === identity.identity && candidate.deletedAt === null);
      if (user !== undefined) {
        matched.set(user.id, user);
      }

      return;
    }
    if (identity.kind !== "verified_email") {
      return;
    }
    const email = identity.identity.trim().toLowerCase();
    knownUsers.forEach((user) => {
      if (user.source === "auth" && user.deletedAt === null && user.email.trim().toLowerCase() === email) {
        matched.set(user.id, user);
      }
    });
  });
  const people = [...matched.values()];
  const authUsers = people.filter((user) => user.source === "auth");
  const chosen =
    authUsers.length === 1
      ? authUsers[0]
      : authUsers.length > 1
        ? undefined
        : people.length === 1
          ? people[0]
          : undefined;
  const avatar = chosen?.avatarUrl?.trim() ?? "";

  return chosen === undefined || avatar === "" ? null : avatar;
};

const memoryPersonDisplayName = (input: {
  personName: string;
  identities: IdentityRow[];
  knownUsers: UserRow[];
}): string => {
  const { personName, identities, knownUsers } = input;
  const accounts = new Map<string, UserRow>();
  identities.forEach((identity) => {
    if (identity.kind !== "user_id") {
      return;
    }
    const user = knownUsers.find(
      (candidate) =>
        candidate.id === identity.identity && candidate.deletedAt === null && ACCOUNT_SOURCES.has(candidate.source),
    );
    if (user !== undefined) {
      accounts.set(user.id, user);
    }
  });
  if (accounts.size !== 1) {
    return personName;
  }

  return [...accounts.values()][0]?.displayName ?? personName;
};

const memoryPersonEmail = (input: { identities: IdentityRow[]; knownUsers: UserRow[] }): string | null => {
  const { identities, knownUsers } = input;
  const [candidate] = identities
    .flatMap((identity) => {
      if (identity.kind === "user_id") {
        const user = knownUsers.find(
          (item) => item.id === identity.identity && item.deletedAt === null && item.source === "auth",
        );
        const email = user?.email.trim().toLowerCase() ?? "";
        if (user === undefined || email === "") {
          return [];
        }

        return [{ rank: 0, identity: identity.identity, email }];
      }
      if (identity.kind !== "verified_email") {
        return [];
      }
      const email = identity.identity.trim().toLowerCase();
      if (email === "") {
        return [];
      }

      return [{ rank: 1, identity: identity.identity, email }];
    })
    .toSorted((left, right) =>
      firstDifference([left.rank - right.rank, compareText({ left: left.identity, right: right.identity })]),
    );

  return candidate?.email ?? null;
};

const memoryPersonEmails = (input: { identities: IdentityRow[]; knownUsers: UserRow[] }): string[] => {
  const { identities, knownUsers } = input;
  const emails = new Set<string>();
  identities.forEach((identity) => {
    if (identity.kind === "verified_email") {
      const email = identity.identity.trim().toLowerCase();
      if (email !== "") {
        emails.add(email);
      }

      return;
    }
    if (identity.kind !== "user_id") {
      return;
    }
    const user = knownUsers.find((candidate) => candidate.id === identity.identity && candidate.deletedAt === null);
    const email = user?.email.trim().toLowerCase() ?? "";
    if (email !== "") {
      emails.add(email);
    }
  });

  return [...emails];
};

async function loadAuthUsersByEmail(emails: string[]): Promise<UserRow[]> {
  const unique = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter((email) => email !== ""))];
  if (unique.length === 0) {
    return [];
  }

  return db.users.findMany({
    where: {
      source: "auth",
      deletedAt: null,
      OR: unique.map((email) => ({ email: { equals: email, mode: "insensitive" } })),
    },
  });
}

async function loadPersonCompanies(input: {
  userId: string;
  sourceIds: string[];
  people: { id: string; emails: string[] }[];
}): Promise<Map<string, { name: string | null; website: string | null }[]>> {
  const result = new Map<string, { name: string | null; website: string | null; updatedAt: Date }[]>();
  const personIds = input.people.map((person) => person.id);
  if (personIds.length === 0 || input.sourceIds.length === 0) {
    return new Map();
  }
  const emailsByPerson = new Map(input.people.map((person) => [person.id, new Set(person.emails)]));
  const interactionRows = await db.memoryInteractions.findMany({
    where: {
      personId: { in: personIds },
      sourceId: { in: input.sourceIds },
      memorySources: { meetings: { is: { meetingLinkId: { not: null } } } },
    },
    include: {
      memorySources: { include: { meetings: {} } },
    },
  });
  const interactions = interactionRows.flatMap((row) => {
    const meetingLinkId = row.memorySources.meetings?.meetingLinkId ?? null;
    if (meetingLinkId === null) {
      return [];
    }

    return [{ personId: row.personId, meetingLinkId }];
  });
  const meetingLinkIds = [...new Set(interactions.map((row) => row.meetingLinkId))];
  if (meetingLinkIds.length === 0) {
    return new Map();
  }
  const readyLinks = await db.calendarReadyLinks.findMany({
    where: { userId: input.userId, meetingLinkId: { in: meetingLinkIds } },
  });
  const eventIds = [
    ...new Set(readyLinks.map((link) => `${link.provider}:${link.calendarId}:${link.providerEventId}`)),
  ];
  if (eventIds.length === 0) {
    return new Map();
  }
  const preps = await db.calendarEventPreps.findMany({
    where: { userId: input.userId, calendarEventId: { in: eventIds } },
  });
  interactions.forEach((interaction) => {
    const personEmails = emailsByPerson.get(interaction.personId);
    if (personEmails === undefined || personEmails.size === 0) {
      return;
    }
    readyLinks
      .filter((link) => link.meetingLinkId === interaction.meetingLinkId)
      .forEach((link) => {
        const eventId = `${link.provider}:${link.calendarId}:${link.providerEventId}`;
        preps.forEach((prep) => {
          if (
            prep.calendarAccountId === null ||
            prep.calendarAccountId !== link.calendarAccountId ||
            prep.calendarEventId !== eventId
          ) {
            return;
          }
          const company = completedCompany(prep.result);
          if (company === null || !snapshotEmails(prep.eventSnapshot).some((email) => personEmails.has(email))) {
            return;
          }
          const list = result.get(interaction.personId) ?? [];
          result.set(interaction.personId, [...list, { ...company, updatedAt: prep.updatedAt }]);
        });
      });
  });
  result.forEach((list, personId) => {
    result.set(
      personId,
      list.toSorted((left, right) =>
        firstDifference([
          right.updatedAt.getTime() - left.updatedAt.getTime(),
          compareText({ left: right.name ?? "", right: left.name ?? "" }),
        ]),
      ),
    );
  });

  return new Map(
    [...result.entries()].map(([personId, companies]) => [
      personId,
      companies.map(({ name, website }) => ({ name, website })),
    ]),
  );
}

const mapMemoryPeopleListRows = (
  rows: (MemoryPerson & { emails: string[]; companies: { name: string | null; website: string | null }[] })[],
): MemoryPerson[] =>
  rows.map(({ emails, companies, ...person }) => ({
    ...person,
    categories: [
      ...new Set(person.categories.map((category) => relationshipMemoryCategory(category))),
    ] satisfies MemoryPerson["categories"],
    ...resolveMemoryCompany({ emails, companies }),
  }));

type MemoryPeopleListPage = {
  before?: { lastContact: string; id: string };
  /** @external existing wire contract */ newer?: boolean;
  limit?: number;
  personId?: string;
  personIds?: string[];
  filters?: Record<string, string | undefined>;
};

type GroupedMemoryPerson = { name: string; lastContact: Date };

type ListedMemoryPerson = {
  id: string;
  name: string;
  email: string | null;
  lastContact: Date;
  categories: string[];
  imageUrl: string | null;
  emails: string[];
};

type ListedMemoryPersonFilter = {
  person: ListedMemoryPerson;
  companies: Map<string, { name: string | null; website: string | null }[]>;
  labels: Record<string, string>;
  categoryFilter: string[] | null;
  categoryOperator: string;
  dateOperator: string;
  from: Date | null;
  to: Date | null;
  query: string | null;
  isNewer: boolean;
  before: { lastContact: string; id: string } | null;
  personId: string | undefined;
  personIds: string[] | undefined;
};

const loadGroupedMemoryPeople = async (input: {
  scope: MemoryScope;
  sourceIds: string[];
}): Promise<Map<string, GroupedMemoryPerson>> => {
  const people = await db.memoryPeople.findMany({
    where: {
      userId: input.scope.userId,
      workspaceId: input.scope.workspaceId,
      memoryInteractions: { some: { sourceId: { in: input.sourceIds } } },
    },
    include: {
      memoryInteractions: {
        where: { sourceId: { in: input.sourceIds } },
      },
    },
  });
  const interactions = people.flatMap((person) =>
    person.memoryInteractions.map((interaction) => ({
      personId: person.id,
      name: person.name,
      occurredAt: interaction.occurredAt,
    })),
  );
  const grouped = new Map<string, GroupedMemoryPerson>();
  interactions.forEach((row) => {
    const current = grouped.get(row.personId);
    if (current === undefined || row.occurredAt > current.lastContact) {
      grouped.set(row.personId, { name: row.name, lastContact: row.occurredAt });
    }
  });

  return grouped;
};

const assembleListedMemoryPeople = async (input: {
  scope: MemoryScope;
  sourceIds: string[];
  grouped: Map<string, GroupedMemoryPerson>;
}): Promise<ListedMemoryPerson[]> => {
  const personIds = [...input.grouped.keys()];
  const [identities, storedMemoryRows] = await Promise.all([
    db.memoryPersonIdentities.findMany({
      where: {
        personId: { in: personIds },
        userId: input.scope.userId,
        workspaceId: input.scope.workspaceId,
      },
    }),
    db.relationshipMemories.findMany({
      where: { memorySources: { id: { in: input.sourceIds }, isCurrent: true } },
      include: { memorySources: {} },
    }),
  ]);
  const memoryRows = storedMemoryRows.map((memory) => ({
    category: memory.category,
    personIds: memory.personIds,
    /** @external persisted sensitive column */
    sensitive: memory.sensitive,
    /** @external persisted include_sensitive column */
    includeSensitive: memory.memorySources.includeSensitive,
  }));
  const identitiesByPerson = new Map<string, IdentityRow[]>();
  identities.forEach((identity) => {
    const list = identitiesByPerson.get(identity.personId) ?? [];
    identitiesByPerson.set(identity.personId, [...list, identity]);
  });
  const linkedUserIds = uuidTexts(
    identities.filter((identity) => identity.kind === "user_id").map((identity) => identity.identity),
  );
  const verifiedEmails = identities
    .filter((identity) => identity.kind === "verified_email")
    .map((identity) => identity.identity);
  const [linkedUsers, emailUsers] = await Promise.all([
    linkedUserIds.length === 0 ? Promise.resolve([]) : db.users.findMany({ where: { id: { in: linkedUserIds } } }),
    loadAuthUsersByEmail(verifiedEmails),
  ]);
  const knownUsers = [...new Map([...linkedUsers, ...emailUsers].map((user) => [user.id, user])).values()];
  const categoriesByPerson = new Map<string, Set<string>>();
  memoryRows.forEach((memory) => {
    if (memory.sensitive && !memory.includeSensitive) {
      return;
    }
    memory.personIds.forEach((personId) => {
      if (!input.grouped.has(personId)) {
        return;
      }
      const categories = categoriesByPerson.get(personId) ?? new Set<string>();
      categories.add(memory.category);
      categoriesByPerson.set(personId, categories);
    });
  });

  return personIds.map((personId) => {
    const person = requiredMemoryRow(input.grouped.get(personId));
    const personIdentities = identitiesByPerson.get(personId) ?? [];

    return {
      id: personId,
      name: memoryPersonDisplayName({ personName: person.name, identities: personIdentities, knownUsers }),
      email: memoryPersonEmail({ identities: personIdentities, knownUsers }),
      lastContact: person.lastContact,
      categories: [...(categoriesByPerson.get(personId) ?? [])],
      imageUrl: memoryPersonImageUrl({ identities: personIdentities, knownUsers }),
      emails: memoryPersonEmails({ identities: personIdentities, knownUsers }),
    };
  });
};

const matchesListedPersonPage = (input: ListedMemoryPersonFilter): boolean => {
  if (input.before !== null) {
    const order = comparePosition({
      left: { occurredAt: input.person.lastContact, importance: 0, id: input.person.id },
      right: { occurredAt: new Date(input.before.lastContact), importance: 0, id: input.before.id },
    });
    if (input.isNewer ? order <= 0 : order >= 0) {
      return false;
    }
  }
  if (input.personId !== undefined && input.personId !== "" && input.person.id !== input.personId) {
    return false;
  }
  if (input.personIds !== undefined && !input.personIds.includes(input.person.id)) {
    return false;
  }

  return true;
};

const matchesListedPersonSearch = (input: ListedMemoryPersonFilter): boolean => {
  if (input.query === null) {
    return true;
  }
  const personCompanies = input.companies.get(input.person.id) ?? [];
  const categoryText = input.person.categories.map((category) => input.labels[category] ?? category).join(" ");
  const emailText = input.person.emails.join(" ");
  const haystack = [
    input.person.name,
    categoryText,
    JSON.stringify(personCompanies),
    emailText,
    emailText.replaceAll("-", " "),
  ]
    .join(" ")
    .toLowerCase();

  return matchesPeopleSearch({ haystack, query: input.query });
};

const matchesListedPersonCategoryAndDate = (input: ListedMemoryPersonFilter): boolean => {
  const categoryFilter = input.categoryFilter;
  if (
    categoryFilter !== null &&
    !xorKeep({
      isMatched: input.person.categories.some((category) => categoryFilter.includes(category)),
      operator: input.categoryOperator,
    })
  ) {
    return false;
  }
  if (input.from === null && input.to === null) {
    return true;
  }
  const isInside =
    (input.from === null || input.person.lastContact >= input.from) &&
    (input.to === null || input.person.lastContact < input.to);

  return xorKeep({ isMatched: isInside, operator: input.dateOperator });
};

const listedMemoryPersonMatches = (input: ListedMemoryPersonFilter): boolean =>
  matchesListedPersonPage(input) && matchesListedPersonSearch(input) && matchesListedPersonCategoryAndDate(input);

const filterListedMemoryPeople = (input: {
  people: ListedMemoryPerson[];
  companies: Map<string, { name: string | null; website: string | null }[]>;
  page: MemoryPeopleListPage;
}): ListedMemoryPerson[] => {
  const filters = input.page.filters ?? {};
  const labels = memoryPeopleCategoryLabels();
  const state = {
    companies: input.companies,
    labels,
    categoryFilter:
      filters.category !== undefined && filters.category !== "" ? memoryCategoryFilterValues(filters.category) : null,
    categoryOperator: filters.categoryOperator ?? "is",
    dateOperator: filters.dateOperator ?? "is",
    from: parseOptionalDate(filters.from),
    to: parseOptionalDate(filters.to),
    query: filters.q !== undefined && filters.q !== "" ? filters.q : null,
    isNewer: input.page.newer === true,
    before: input.page.before ?? null,
    personId: input.page.personId,
    personIds: input.page.personIds,
  };
  const filtered = input.people.filter((person) => listedMemoryPersonMatches({ ...state, person }));
  const direction = state.isNewer ? 1 : -1;

  return filtered.toSorted(
    (left, right) =>
      direction *
      comparePosition({
        left: { occurredAt: left.lastContact, importance: 0, id: left.id },
        right: { occurredAt: right.lastContact, importance: 0, id: right.id },
      }),
  );
};

export async function listMemoryPeople(input: {
  scope: MemoryScope;
  sourceIds: string[];
  page?: MemoryPeopleListPage;
}): Promise<MemoryPerson[]> {
  const page = input.page ?? {};
  if (input.sourceIds.length === 0 || (page.personIds !== undefined && page.personIds.length === 0)) {
    return [];
  }
  const grouped = await loadGroupedMemoryPeople({ scope: input.scope, sourceIds: input.sourceIds });
  if (grouped.size === 0) {
    return [];
  }
  const people = await assembleListedMemoryPeople({ scope: input.scope, sourceIds: input.sourceIds, grouped });
  const companies = await loadPersonCompanies({
    userId: input.scope.userId,
    sourceIds: input.sourceIds,
    people: people.map((person) => ({ id: person.id, emails: person.emails })),
  });
  const filtered = filterListedMemoryPeople({ people, companies, page });
  const limited = page.limit === undefined ? filtered : filtered.slice(0, page.limit);

  return mapMemoryPeopleListRows(
    limited.map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      lastContact: person.lastContact.toISOString(),
      categories: person.categories,
      imageUrl: person.imageUrl,
      emails: person.emails,
      companies: companies.get(person.id) ?? [],
    })),
  );
}

export async function actOnMemories(input: { sourceIds: string[]; ids: string[]; action: unknown }): Promise<void> {
  const { sourceIds, ids, action } = input;
  if (ids.length === 0) {
    if (action !== "forget") {
      throw new Error(MESSAGE_UNSUPPORTED_MEMORY_ACTION);
    }

    return;
  }
  if (sourceIds.length === 0) {
    throw new MemoryNotFoundError();
  }
  const rows = await db.relationshipMemories.findMany({
    where: { sourceId: { in: sourceIds }, id: { in: ids } },
  });
  if (rows.length !== new Set(ids).size) {
    throw new MemoryNotFoundError();
  }
  if (action !== "forget") {
    throw new Error(MESSAGE_UNSUPPORTED_MEMORY_ACTION);
  }
  try {
    await forgetMemoryRows({ rows, ids });
  } catch (error) {
    // A concurrent meeting can hold the person summary row; that is not a missing memory.
    if (postgresSqlState(error) === LOCK_NOT_AVAILABLE_SQLSTATE || isPrismaTransactionTimeout(error)) {
      throw new MemoryBusyError({ cause: error });
    }
    throw error;
  }
}

// Fail fast, well inside the interactive transaction timeout, when another writer holds a row.
const FORGET_LOCK_TIMEOUT = "5s";

async function forgetMemoryRows(input: {
  rows: Awaited<ReturnType<typeof db.relationshipMemories.findMany>>;
  ids: string[];
}): Promise<void> {
  const { rows, ids } = input;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${FORGET_LOCK_TIMEOUT}, true)`;
    await rows.reduce(async (previous, row) => {
      await previous;
      await tx.memorySuppressions.createMany({
        data: [
          { sourceId: row.sourceId, factFingerprint: row.factFingerprint, factIdentity: jsonInput(row.factIdentity) },
        ],
        skipDuplicates: true,
      });
    }, Promise.resolve());
    await tx.relationshipMemories.deleteMany({ where: { id: { in: ids } } });
    await pruneForgottenFromProjections({
      tx,
      personIds: [...new Set(rows.flatMap((row) => row.personIds))],
      forgottenIds: new Set(ids),
    });
  });
}

export async function getMemoryEvidenceDetails(input: { sourceIds: string[]; memoryId: string }): Promise<
  {
    segmentId: string;
    quote: string;
    speakerName: string | null;
    startedAt: Date;
    meetingId: string;
  }[]
> {
  if (input.sourceIds.length === 0) {
    return [];
  }
  const evidenceRows = await db.memoryEvidence.findMany({
    where: {
      memoryId: input.memoryId,
      relationshipMemories: {
        id: input.memoryId,
        memorySources: { id: { in: input.sourceIds }, isCurrent: true },
      },
    },
    include: {
      transcriptSegments: {},
      relationshipMemories: { include: { memorySources: {} } },
    },
    orderBy: [{ transcriptSegments: { startedAt: "asc" } }, { transcriptSegments: { id: "asc" } }],
  });
  const rows = evidenceRows.map((row) => ({
    segmentId: row.segmentId,
    quote: row.quote,
    speakerName: row.transcriptSegments.speakerName,
    startedAt: row.transcriptSegments.startedAt,
    meetingId: row.relationshipMemories.memorySources.meetingId,
  }));

  return rows.flatMap((row) => (row.meetingId === null ? [] : [{ ...row, meetingId: row.meetingId }]));
}
