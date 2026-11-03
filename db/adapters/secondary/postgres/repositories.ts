import {
  aiWorkflowJobStatusSchema,
  aiWorkflowJobTypeSchema,
  ambientContextCitationSchema,
  ambientContextEntityKindSchema,
  ambientContextImageStatusSchema,
  ambientContextResearchStatusSchema,
  assignedTaskSourceTypeSchema,
  capabilityWorkflowPhaseSchema,
  capabilityWorkflowStatusSchema,
  linearTaskReviewDuplicateIssueSchema,
  linearTaskReviewExternalIssueSchema,
  linearTaskReviewIssueDraftSchema,
  linearTaskReviewStatusSchema,
  linearTaskReviewSyncStatusSchema,
  linearTaskReviewTargetActionSchema,
  liveMeetingTaskCandidateStateSchema,
  liveMeetingTaskEvidenceRoleSchema,
  meetingAssetTriggerSchema,
  meetingKindSchema,
  meetingResearchRunStatusSchema,
  meetingTaskCompletionSchema,
  meetingTaskConfidenceSchema,
  meetingTaskDetectionOriginSchema,
  meetingTaskListStatusSchema,
  meetingTaskSourceQuoteSchema,
  meetingTaskStatusSchema,
  meetingTaskStatusSourceSchema,
  meetingTaskTypeSchema,
  meetingTaskWorkKindSchema,
  meetingTypeSchema,
  providerAccountKindSchema,
  recommendationExclusionSignalCheckSchema,
  recommendationMissingSignalSchema,
  recommendationSignalMatchSchema,
  signalPresenceSchema,
  signalReferenceSchema,
} from "@readymeet/shared";
import {
  type Acquisition,
  type AiCreditActionType,
  aiCreditActionTypeValues,
  type AiWorkflowJobStatus,
  type AiWorkflowJobType,
  type AiWorkflowJobView,
  aiWorkflowJobViewSchema,
  AMBIENT_CONTEXT_KNOWN_ENTITY_LIMIT,
  AMBIENT_IDENTITY_UNVERIFIED,
  AMBIENT_VOICE_SEARCH_HANDLED,
  type AmbientContextCitation,
  type AmbientContextEntityKind,
  type AmbientContextImageStatus,
  type AmbientContextResearchStatus,
  BILLING_PAST_DUE_GRACE_DAYS,
  type CalendarAccount,
  type CalendarProvider,
  type CalendarRealtimeEventName,
  type CapabilityCatalogInput,
  capabilityCatalogInputSchema,
  type CapabilityCatalogRow,
  capabilityCatalogRowSchema,
  type CapabilityRecommendationRow,
  capabilityRecommendationRowSchema,
  type CapabilityWorkflowMessage,
  capabilityWorkflowMessageSchema,
  type CapabilityWorkflowPhase,
  type CapabilityWorkflowRun,
  capabilityWorkflowRunSchema,
  type CapabilityWorkflowStatus,
  emailDomain,
  type ExtractionConfidence,
  type ExtractionStatus,
  extractionStatusSchema,
  GUEST_MEETING_PREVIEW_SCOPE,
  isMeetingConfidentialByDefault,
  isPublicEmailDomain,
  type LinearTaskReviewCandidate,
  type LinearTaskReviewRun,
  linearTaskReviewRunSchema,
  type LinearTaskReviewStatus,
  type LinearTaskReviewSyncStatus,
  type LiveMeetingTaskCandidate,
  liveMeetingTaskCandidateSchema,
  type LiveMeetingTaskCandidateState,
  type LiveMeetingTaskEvidenceRole,
  MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS,
  type MeetingAmbientContextItem,
  meetingAmbientContextItemSchema,
  meetingAmbientContextRealtimeChannel,
  type MeetingAsset,
  meetingAssetSchema,
  type MeetingAssetTrigger,
  type MeetingExtraction,
  meetingExtractionSchema,
  type MeetingResearchRunStatus,
  meetingResearchRunViewSchema,
  type MeetingTask,
  type MeetingTaskCandidate,
  type MeetingTaskDetectionOrigin,
  type MeetingTaskList,
  meetingTaskListSchema,
  type MeetingTaskListStatus,
  meetingTaskSchema,
  type MeetingTaskStatus,
  type MeetingTaskStatusSource,
  type MeetingTaskType,
  type MeetingTaskWorkKind,
  type MeetingType,
  normalizedTranscriptSimilarity,
  type ProviderAccountKind,
  type SignalKey,
  type SuggestedActionRunPhase,
  suggestedActionRunPhaseSchema,
  type SuggestedActionRunStatus,
  suggestedActionRunStatusSchema,
  type SuggestedActionStep,
  suggestedActionStepSchema,
  type TaskRealtimeEventName,
  type UnifiedAssignedTask,
  unifiedAssignedTaskSchema,
  UNPLACED_ASSIGNED_TASK_SECTION_ID,
  type UserPlan,
  userPlanSchema,
  type UserSource,
  type WorkspaceAssignableRole,
  type WorkspaceTask,
  workspaceTaskSchema,
  type WorkspaceTaskSection,
  workspaceTaskSectionSchema,
} from "@readymeet/shared";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  AuthenticationIdentityConflictError,
  GuestSessionLinkConflictError,
  InsufficientAiCreditsError,
  WorkspaceTaskSectionTitleConflictError,
} from "../../../domain/persistence-errors";
import {
  REQUEST_EXECUTION_EXPIRED_MESSAGE,
  REQUEST_EXECUTION_MAX_AGE_MS,
  RequestExecutionExpiredError,
} from "../../../domain/request-execution";
import { assetIdsForTaskCandidate } from "../../../domain/task-asset-linking";
import { isUniqueViolation } from "../../../domain/unique-violation";
import { publishRealtimeEvents } from "../../../ports/realtime";
import type { MeetingBriefPastMeetingContextCandidate } from "../../../ports/repository";

import { type AccountTransaction, withAccountMutation } from "./account-coordination";
import { getAdminAcquisition } from "./acquisition";
import { db, type DbConnection, Prisma } from "./client";
import { contentModels } from "./content-models";
import { contentProjection, decodeContentAliases, decodeContentRow, encodeContentRow } from "./content-storage";
import { INSUFFICIENT_AI_CREDITS_SQLSTATE, postgresSqlState } from "./database-errors";
import { publishMeetingJoinRequestEvents } from "./join-request-realtime";
import {
  autoMarkMeetingConfidentialInTransaction,
  notifyMeetingConfidentialityChanged,
} from "./meeting-confidentiality";
import { buildConsolidatedMemoryProjection, hasMemoryNotesEntitlement } from "./relationship-memory";
import { withRequestMutation, withRequestResult } from "./request-result";
import { type CreditGrantSource } from "./workspace-billing";

export type MeetingKind = "standard" | "agent_intro";

const CONTENT_ERROR_FIELD = "error";

const UNEXPECTED_STORED_VALUE_MESSAGE = "Stored value does not match the expected shape.";
const DECIMAL_SCALE = 4;
const whereAnd = <T extends object>(
  parts: readonly (T | undefined)[],
):
  | T
  | {
      AND: T[];
    }
  | undefined => {
  const present = parts.filter((part): part is T => part !== undefined);
  const [only, second] = present;
  if (only === undefined) {
    return undefined;
  }
  if (second === undefined) {
    return only;
  }

  return { AND: present };
};
const whereOr = <T extends object>(
  parts: readonly (T | undefined)[],
):
  | T
  | {
      OR: T[];
    }
  | undefined => {
  const present = parts.filter((part): part is T => part !== undefined);
  const [only, second] = present;
  if (only === undefined) {
    return undefined;
  }
  if (second === undefined) {
    return only;
  }

  return { OR: present };
};

const decimalToString = (input: { value: { toFixed: (digits: number) => string }; scale: number }): string =>
  input.value.toFixed(input.scale);

const jsonValueInput = (value: unknown): Prisma.InputJsonValue | null => {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValueInput(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => (entry === undefined ? [] : [[key, jsonValueInput(entry)]])),
    );
  }

  throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
};

function jsonInput(value: null): typeof Prisma.JsonNull;
function jsonInput(value: unknown): Prisma.InputJsonValue;
function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) {
    return Prisma.JsonNull;
  }
  const encoded = jsonValueInput(value);
  if (encoded === null) {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return encoded;
}

const mapRow = async <T, R>(input: { value: Promise<T>; map: (row: T) => R }): Promise<R> => {
  const row = await input.value;

  return input.map(row);
};

const readStringUnion = <const T extends readonly [string, ...string[]]>(input: {
  values: T;
  value: string;
}): T[number] => {
  const match = input.values.find((candidate) => candidate === input.value);
  if (match === undefined) {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return match;
};

const readNullableStringUnion = <const T extends readonly [string, ...string[]]>(input: {
  values: T;
  value: string | null;
}): T[number] | null => (input.value === null ? null : readStringUnion({ values: input.values, value: input.value }));

const parseNullable = <T>(input: { schema: z.ZodType<T>; value: unknown }): T | null =>
  input.value === null || input.value === undefined ? null : input.schema.parse(input.value);

const readJsonObject = (value: Prisma.JsonValue): Record<string, Prisma.JsonValue> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => (entry === undefined ? [] : [[key, entry]])),
  );
};

const readStringArray = (value: Prisma.JsonValue | readonly unknown[]): string[] => {
  if (!Array.isArray(value)) {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
    }

    return item;
  });
};

const readNullableStringArray = (value: Prisma.JsonValue | readonly unknown[] | null): string[] | null =>
  value === null ? null : readStringArray(value);

const readJsonObjectArray = (value: Prisma.JsonValue): Record<string, Prisma.JsonValue>[] => {
  if (!Array.isArray(value)) {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return value.map((item) => readJsonObject(item));
};

const readUnknownArray = (value: Prisma.JsonValue): Prisma.JsonArray => {
  if (!Array.isArray(value)) {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return value;
};

const readStoredString = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return value;
};

const readPresent = <T>(value: T | null): T => {
  if (value === null) {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return value;
};

const readStoredMeetingTask = <
  Row extends {
    type: string;
    ownerConfidence: string | null;
    dueDateConfidence: string | null;
    confidence: string;
    sourceQuotes: Prisma.JsonValue;
    status: string;
    createdFrom: string;
    externalLinks: Prisma.JsonValue;
    workKind: string;
    assetIds: Prisma.JsonValue;
    origin: string;
    statusSource: string;
  },
>(
  row: Row,
) => ({
  ...row,
  type: meetingTaskTypeSchema.parse(row.type),
  ownerConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.ownerConfidence }),
  dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
  confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
  sourceQuotes: z.array(meetingTaskSourceQuoteSchema).parse(row.sourceQuotes),
  status: meetingTaskStatusSchema.parse(row.status),
  createdFrom: readStringUnion({ values: ["meeting_transcript"], value: row.createdFrom }),
  externalLinks: readJsonObjectArray(row.externalLinks),
  workKind: meetingTaskWorkKindSchema.parse(row.workKind),
  assetIds: readStringArray(row.assetIds),
  origin: meetingTaskDetectionOriginSchema.parse(row.origin),
  statusSource: meetingTaskStatusSourceSchema.parse(row.statusSource),
});

const readStoredMeeting = <Row extends { status: string; kind: string; confidentialitySource: string | null }>(
  row: Row,
) => ({
  ...row,
  status: readStringUnion({ values: ["scheduled", "active", "ended"], value: row.status }),
  kind: meetingKindSchema.parse(row.kind),
  confidentialitySource: readNullableStringUnion({
    values: ["auto", "manual"],
    value: row.confidentialitySource,
  }),
});

const readDate = (value: unknown): Date => {
  if (!(value instanceof Date)) {
    throw new Error(UNEXPECTED_STORED_VALUE_MESSAGE);
  }

  return value;
};

const createIgnoringUniqueConflict = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return undefined;
    }
    throw error;
  }
};

type SqlCast = "uuid" | "timestamptz" | "int" | "numeric" | "jsonb" | "bigint" | "boolean" | null;

const comparedValue = (value: unknown): unknown => value;

const sqlCompare = (input: { columnSql: string; operator: string; value: unknown; cast: SqlCast }): Prisma.Sql => {
  const { columnSql, operator, value, cast } = input;
  const column = Prisma.raw(columnSql);
  const op = Prisma.raw(operator);
  if (value === null) {
    return Prisma.sql`${column} IS NULL`;
  }
  if (cast === "jsonb") {
    return Prisma.sql`${column} ${op} ${JSON.stringify(value)}::jsonb`;
  }
  if (cast === null) {
    return Prisma.sql`${column} ${op} ${value}`;
  }

  return Prisma.sql`${column} ${op} ${value}::${Prisma.raw(cast)}`;
};

const sqlColCompare = (input: { leftSql: string; operator: string; rightSql: string }): Prisma.Sql =>
  Prisma.sql`${Prisma.raw(input.leftSql)} ${Prisma.raw(input.operator)} ${Prisma.raw(input.rightSql)}`;

const sqlIsNull = (input: { columnSql: string; isNegated: boolean }): Prisma.Sql => {
  const column = Prisma.raw(input.columnSql);

  return input.isNegated ? Prisma.sql`${column} IS NOT NULL` : Prisma.sql`${column} IS NULL`;
};

const sqlInQuery = (input: { columnSql: string; query: Prisma.Sql; isNegated: boolean }): Prisma.Sql => {
  const column = Prisma.raw(input.columnSql);

  return input.isNegated ? Prisma.sql`${column} NOT IN (${input.query})` : Prisma.sql`${column} IN (${input.query})`;
};

const sqlIn = (input: {
  columnSql: string;
  values: readonly unknown[] | null | undefined;
  cast: SqlCast;
  isNegated: boolean;
}): Prisma.Sql => {
  const { columnSql, values, cast } = input;
  const column = Prisma.raw(columnSql);
  const list =
    cast === null || cast === "jsonb" || cast === "boolean"
      ? Prisma.sql`${values ?? []}::text[]`
      : Prisma.sql`${values ?? []}::${Prisma.raw(`${cast}[]`)}`;

  return input.isNegated
    ? Prisma.sql`(cardinality(${list}) = 0 OR ${column} <> ALL(${list}))`
    : Prisma.sql`(cardinality(${list}) > 0 AND ${column} = ANY(${list}))`;
};

const sqlAnd = (parts: readonly (Prisma.Sql | undefined)[]): Prisma.Sql => {
  const present = parts.filter((part): part is Prisma.Sql => part !== undefined && part !== Prisma.empty);
  const [only, second] = present;
  if (only === undefined) {
    return Prisma.empty;
  }
  if (second === undefined) {
    return only;
  }

  return Prisma.sql`(${Prisma.join(present, " AND ")})`;
};

const sqlOr = (parts: readonly (Prisma.Sql | undefined)[]): Prisma.Sql => {
  const present = parts.filter((part): part is Prisma.Sql => part !== undefined && part !== Prisma.empty);
  const [only, second] = present;
  if (only === undefined) {
    return Prisma.empty;
  }
  if (second === undefined) {
    return only;
  }

  return Prisma.sql`(${Prisma.join(present, " OR ")})`;
};

const sqlNot = (value: Prisma.Sql): Prisma.Sql => Prisma.sql`NOT (${value})`;

const sqlExists = (query: Prisma.Sql): Prisma.Sql => Prisma.sql`EXISTS (${query})`;

const sqlWhereClause = (where: Prisma.Sql | undefined): Prisma.Sql =>
  where === undefined || where === Prisma.empty ? Prisma.empty : Prisma.sql`WHERE ${where}`;

const sqlSort = (input: { columnSql: string; direction: "ASC" | "DESC" }): Prisma.Sql =>
  Prisma.sql`${Prisma.raw(input.columnSql)} ${Prisma.raw(input.direction)}`;

const sqlOrderBy = (parts: readonly Prisma.Sql[]): Prisma.Sql =>
  parts.length === 0 ? Prisma.empty : Prisma.sql`ORDER BY ${Prisma.join(parts, ", ")}`;

const sqlLimit = (count: unknown): Prisma.Sql => Prisma.sql`LIMIT ${count}`;

const sqlAssign = (input: { column: string; value: unknown; cast: SqlCast }): Prisma.Sql => {
  const { column, value, cast } = input;
  const target = Prisma.raw(`"${column}"`);
  if (value === null) {
    return Prisma.sql`${target} = NULL`;
  }
  if (cast === "jsonb") {
    return Prisma.sql`${target} = ${JSON.stringify(value)}::jsonb`;
  }
  if (cast === null) {
    return Prisma.sql`${target} = ${value}`;
  }

  return Prisma.sql`${target} = ${value}::${Prisma.raw(cast)}`;
};

const sqlConflictNothing = (input: { targetSql: string; where?: Prisma.Sql }): Prisma.Sql => {
  const { targetSql, where } = input;
  const target = Prisma.raw(targetSql);
  if (where !== undefined && where !== Prisma.empty) {
    return Prisma.sql`${target} WHERE ${where} DO NOTHING`;
  }

  return Prisma.sql`${target} DO NOTHING`;
};

const sqlConflictUpdate = (input: {
  targetSql: string;
  where: Prisma.Sql | undefined;
  assignments: readonly Prisma.Sql[];
}): Prisma.Sql => {
  const { targetSql, where, assignments } = input;
  const target = Prisma.raw(targetSql);
  const set = Prisma.join(assignments, ", ");
  if (where !== undefined && where !== Prisma.empty) {
    return Prisma.sql`${target} WHERE ${where} DO UPDATE SET ${set}`;
  }

  return Prisma.sql`${target} DO UPDATE SET ${set}`;
};

type RawInsertColumn = { key: string; column: string; cast: SqlCast };

const sqlLiteral = (input: { value: unknown; cast: SqlCast }): Prisma.Sql => {
  const { value, cast } = input;
  if (value === null) {
    return Prisma.raw("NULL");
  }
  if (cast === "jsonb") {
    return Prisma.sql`${JSON.stringify(value)}::jsonb`;
  }
  if (cast === null) {
    return Prisma.sql`${value}`;
  }

  return Prisma.sql`${value}::${Prisma.raw(cast)}`;
};

const insertRaw = async <Row>(input: {
  executor: Prisma.TransactionClient | typeof db;
  table: string;
  rows: readonly Record<string, unknown>[];
  columns: readonly RawInsertColumn[];
  conflict: Prisma.Sql;
  returning: Prisma.Sql;
}): Promise<Row[]> => {
  if (input.rows.length === 0) {
    return [];
  }
  const model = Object.entries(contentModels).find(([, descriptor]) => descriptor.table === input.table)?.[0];
  const rows =
    model !== undefined
      ? await Promise.all(input.rows.map((row) => encodeContentRow({ model, data: row, isCreating: true })))
      : input.rows;
  const included = input.columns.filter((column) =>
    rows.some((row) => Object.prototype.hasOwnProperty.call(row, column.key) && row[column.key] !== undefined),
  );
  const columnSql = Prisma.raw(included.map((column) => `"${column.column}"`).join(", "));
  const valuesSql = Prisma.join(
    rows.map(
      (row) =>
        Prisma.sql`(${Prisma.join(
          included.map((column) =>
            Object.prototype.hasOwnProperty.call(row, column.key) && row[column.key] !== undefined
              ? sqlLiteral({ value: row[column.key] === Prisma.DbNull ? null : row[column.key], cast: column.cast })
              : Prisma.raw("DEFAULT"),
          ),
        )})`,
    ),
  );
  const saved = await input.executor.$queryRaw<Row[]>`
    INSERT INTO ${Prisma.raw(`"${input.table}"`)} (${columnSql})
    VALUES ${valuesSql}
    ${input.conflict}
    RETURNING ${input.returning}
  `;

  return model !== undefined ? decodeContentRow({ model, value: saved }) : saved;
};

declare global {
  interface Array<T> {
    toSorted(compareFn?: Parameters<Array<T>["sort"]>[0]): T[];
  }
  interface ReadonlyArray<T> {
    toSorted(compareFn?: Parameters<Array<T>["sort"]>[0]): T[];
  }
}

const nextStoredUserSource = (input: { current: UserSource; incoming: UserSource }): UserSource => {
  if (input.current === "auth" || input.incoming === "auth") {
    return "auth";
  }
  if (input.current === "dev_login" && input.incoming === "debug_import") {
    return "dev_login";
  }
  if (input.incoming === "dev_login") {
    return "dev_login";
  }

  return input.incoming;
};

const saveUserAuthAccount = async (input: {
  executor?: AccountTransaction;
  userId: string;
  provider: "google" | "microsoft-entra-id";
  providerAccountId: string | null;
  metadata: Record<string, unknown>;
}) => {
  const hasProviderAccount = input.providerAccountId !== null && input.providerAccountId !== "";
  const executor = input.executor ?? db;
  const providerAccountId = hasProviderAccount ? input.providerAccountId : null;
  const rows = await insertRaw<Prisma.userAuthAccountsModel>({
    executor,
    table: "user_auth_accounts",
    rows: [
      {
        userId: input.userId,
        provider: input.provider,
        providerAccountId,
        metadata: input.metadata,
      },
    ],
    columns: [
      { key: "id", column: "id", cast: "uuid" },
      { key: "userId", column: "user_id", cast: "uuid" },
      { key: "provider", column: "provider", cast: null },
      { key: "providerAccountId", column: "provider_account_id", cast: null },
      { key: "firstAuthenticatedAt", column: "first_authenticated_at", cast: "timestamptz" },
      { key: "lastAuthenticatedAt", column: "last_authenticated_at", cast: "timestamptz" },
      { key: "authCount", column: "auth_count", cast: "int" },
      { key: "metadata", column: "metadata", cast: "jsonb" },
      { key: "createdAt", column: "created_at", cast: "timestamptz" },
      { key: "updatedAt", column: "updated_at", cast: "timestamptz" },
    ],
    conflict: hasProviderAccount
      ? sqlConflictNothing({
          targetSql: 'ON CONFLICT ("provider", "provider_account_id")',
          where: sqlIsNull({ columnSql: '"user_auth_accounts"."provider_account_id"', isNegated: true }),
        })
      : sqlConflictNothing({ targetSql: 'ON CONFLICT ("null_account_key")' }),
    returning: Prisma.raw(
      '"id" AS "id", "user_id" AS "userId", "provider" AS "provider", "provider_account_id" AS "providerAccountId", "first_authenticated_at" AS "firstAuthenticatedAt", "last_authenticated_at" AS "lastAuthenticatedAt", "auth_count" AS "authCount", "metadata" AS "metadata", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "null_account_key" AS "nullAccountKey"',
    ),
  });
  const inserted = rows[0];
  if (inserted !== undefined) {
    return { ...inserted, metadata: readJsonObject(inserted.metadata) };
  }
  const existing = await executor.userAuthAccounts.findFirst({
    where: hasProviderAccount
      ? { provider: input.provider, providerAccountId: input.providerAccountId ?? "" }
      : { userId: input.userId, provider: input.provider, providerAccountId: null },
  });
  if (existing === null) {
    return null;
  }
  if (existing.userId !== input.userId) {
    throw new AuthenticationIdentityConflictError();
  }
  const updated = await executor.userAuthAccounts.update({
    where: { id: existing.id },
    data: {
      userId: input.userId,
      lastAuthenticatedAt: new Date(),
      authCount: existing.authCount + 1,
      metadata: jsonInput(input.metadata),
      updatedAt: new Date(),
    },
  });

  return { ...updated, metadata: readJsonObject(updated.metadata) };
};

export { GuestSessionLinkConflictError };

export type TranscriptSpeakerRole = "human" | "assistant" | "system";
export type TranscriptSegmentSource =
  | "legacy-transcript"
  | "livekit-python-live"
  | "livekit-python-postcall"
  | "meeting-agent-assistant"
  | "meeting-agent-user"
  | "manual-note";

export type MeetingTurnStatus = "active" | "committed" | "cancelled" | "expired";
export type AgentConnectorStatus = "connected" | "disconnected" | "error";
export type AgentConnectorScope = "private" | "public" | "shared";
export type ProviderSyncStatus = string;

const WEB_SEARCH_CONNECTOR_PROVIDER = "web_search";
const WEB_SEARCH_TOOL_NAME = "web_search";
const MEETING_TURNS_ACTIVE_MEETING_CONSTRAINT = "meeting_turns_active_meeting_uidx";
const MEETINGS_ONE_CURRENT_PER_LINK_CONSTRAINT = "meetings_one_current_per_link_uidx";
const MEETING_RESEARCH_ACTIVE_RECOMMENDATION_CONSTRAINT = "meeting_research_runs_active_recommendation_uidx";

const USER_NOT_FOUND_MESSAGE = "User not found";
const GUEST_USERS_CANNOT_OWN_OR_CREATE_WORKSPACES_MESSAGE = "Guest users cannot own or create workspaces";
const FAILED_TO_CREATE_WORKSPACE_MESSAGE = "Failed to create workspace";
const GUEST_USERS_CANNOT_BE_ADDED_TO_WORKSPACES_MESSAGE = "Guest users cannot be added to workspaces";
const failedToCreateDefaultTaskSectionForWorkspaceMessage = (value: string): string =>
  `Failed to create default task section for workspace "${value}"`;
const failedToResolveDefaultTaskSectionForWorkspaceMessage = (value: string): string =>
  `Failed to resolve default task section for workspace "${value}"`;
const USE_CREATEGUESTUSER_FOR_GUEST_IDENTITIES_MESSAGE = "Use createGuestUser for guest identities";
const FAILED_TO_UPSERT_USER_MESSAGE = "Failed to upsert user";
const PROVIDER_ACCOUNT_ID_IS_REQUIRED_MESSAGE = "Provider account id is required";
const EMAIL_IS_REQUIRED_MESSAGE = "Email is required";
const FAILED_TO_UPSERT_AUTHENTICATED_USER_MESSAGE = "Failed to upsert authenticated user";

const workspaceForUserNotFoundMessage = (value: string): string => `Workspace for user "${value}" not found`;
const FAILED_TO_ACTIVATE_MEETING_LINK_CALL_IN_MESSAGE = "Failed to activate meeting link call-in";

const FAILED_TO_MARK_MEETING_LINK_CALL_IN_INACTIVE_MESSAGE = "Failed to mark meeting link call-in inactive";
const FAILED_TO_MARK_MEETING_LINK_CALL_IN_ERROR_MESSAGE = "Failed to mark meeting link call-in error";
const FAILED_TO_CREATE_CALENDAR_ADD_ON_MEETING_LINK_MESSAGE = "Failed to create calendar add-on meeting link";
const FAILED_TO_UPDATE_MEETING_JOIN_REQUEST_MESSAGE = "Failed to save meeting join request";
const FAILED_TO_CREATE_CALL_IN_MEETING_JOIN_REQUEST_MESSAGE = "Failed to create call-in meeting join request";
const GUEST_SESSION_IS_ALREADY_LINKED_TO_ANOTHER_ACCOUNT_MESSAGE =
  "Guest session is already linked to another account.";
const TARGET_USER_NOT_FOUND_MESSAGE = "Target user not found";
const GUEST_RECOGNITION_IS_ALREADY_LINKED_TO_ANOTHER_ACCOUNT_MESSAGE =
  "Guest recognition is already linked to another account.";
const MEETING_LINK_NOT_FOUND_FOR_JOIN_REQUEST_REALTIME_EVENT_MESSAGE =
  "Meeting link not found for join-request realtime event";
const FAILED_TO_CLOSE_ENDED_PARTICIPANT_PRESENCE_MESSAGE = "Failed to close ended participant presence";
const FAILED_TO_UPDATE_PARTICIPANT_PRESENCE_MESSAGE = "Failed to save participant presence";
const FAILED_TO_UPDATE_PARTICIPANT_RECORD_MESSAGE = "Failed to save participant record";
const FAILED_TO_CREATE_DEFAULT_AGENT_PROFILE_MESSAGE = "Failed to create default agent profile";
const FAILED_TO_UPSERT_AGENT_CONNECTOR_MESSAGE = "Failed to upsert agent connector";
const FAILED_TO_UPSERT_CALENDAR_SYNC_SUBSCRIPTION_MESSAGE = "Failed to upsert calendar sync subscription";
const FAILED_TO_UPDATE_CALENDAR_EVENT_PREP_MESSAGE = "Failed to save calendar event prep";
const FAILED_TO_UPDATE_AGENT_TOOL_POLICY_MESSAGE = "Failed to save agent tool policy";
const FAILED_TO_UPDATE_AGENT_TOOL_INVOCATION_MESSAGE = "Failed to save agent tool invocation";
const FAILED_TO_PERSIST_MEETING_ASSET_MESSAGE = "Failed to persist meeting asset";
const FAILED_TO_UPSERT_SUMMARY_MESSAGE = "Failed to upsert summary";
const failedToUpsertMeetingTaskListForMeetingMessage = (value: string): string =>
  `Failed to upsert meeting task list for meeting "${value}"`;
const meetingNotFoundMessage = (value: string): string => `Meeting "${value}" not found`;
const FAILED_TO_CREATE_LIVE_MEETING_TASK_LIST_MESSAGE = "Failed to create live meeting task list";
const FAILED_TO_PERSIST_LIVE_MEETING_TASK_MESSAGE = "Failed to persist live meeting task";
const meetingTaskListNotFoundMessage = (value: string): string => `Meeting task list "${value}" not found`;
const failedToUpdateMeetingTaskMessage = (value: string): string => `Failed to save meeting task "${value}"`;
const MEETING_TASKS_CHANGED_BEFORE_CONDITIONAL_DELETION_MESSAGE = "Meeting tasks changed before conditional deletion";
const ONLY_ONE_REORDER_ANCHOR_CAN_BE_PROVIDED_MESSAGE = "Only one reorder anchor can be provided.";
const TASK_SECTION_NOT_FOUND_MESSAGE = "Task section not found.";
const ANCHOR_TASK_NOT_FOUND_MESSAGE = "Anchor task not found.";
const workspaceTaskNotFoundMessage = (value: string): string => `Workspace task "${value}" not found`;
const taskSectionNotFoundMessage = (value: string): string => `Task section "${value}" not found`;
const DEFAULT_TASK_SECTION_CANNOT_BE_DELETED_MESSAGE = "Default task section cannot be deleted.";
const TARGET_SECTION_NOT_FOUND_MESSAGE = "Target section not found.";
const ONLY_REORDERABLE_ASSIGNED_TASKS_CAN_BE_MOVED_MESSAGE = "Only reorderable assigned tasks can be moved.";
const FAILED_TO_UPDATE_CAPABILITY_WORKFLOW_RUN_MESSAGE = "Failed to save capability workflow run";
const failedToCreateLinearTaskReviewForMeetingMessage = (value: string): string =>
  `Failed to create Linear task review for meeting "${value}"`;
const linearTaskReviewWasNotFoundMessage = (value: string): string => `Linear task review "${value}" was not found`;
const FAILED_TO_UPDATE_AMBIENT_CONTEXT_MENTION_MESSAGE = "Failed to save ambient context mention";
const INACTIVE_ATTENDEE_WORKSPACE_MESSAGE = "Inactive attendee workspace";
const INVALID_GUEST_ACCOUNT_LINK_MESSAGE = "Invalid guest account link";

const failedToCompleteAiWorkflowJobMessage = (value: string): string => `Failed to complete AI workflow job "${value}"`;
const failedToFailAiWorkflowJobMessage = (value: string): string => `Failed to fail AI workflow job "${value}"`;
const FAILED_TO_UPDATE_MEETING_TIMELINE_MESSAGE = "Failed to save meeting timeline";
const FAILED_TO_UPDATE_MEETING_TITLE_MESSAGE = "Failed to save meeting title";
const meetingAssetSegmentLimitMessage = (): string =>
  `Meeting assets support at most ${MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS} unique transcript segments`;
const SUPERSEDED_WEB_SEARCH_ERROR = {
  code: "superseded",
  message: "A newer web search request replaced this one.",
} as const;

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE;
const CONFIDENCE_PERCENT_SCALE = 100;
const GUEST_DISPLAY_NAME_MAX_LENGTH = 120;
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";
const POSTGRES_FOREIGN_KEY_VIOLATION_CODE = "23503";
const PARTICIPANT_PAIR_COUNT = 2;
const TOKEN_MIN_LENGTH = 2;
const EVIDENCE_TIME_WINDOW_MS = 10_000;
const EVIDENCE_TEXT_SIMILARITY_THRESHOLD = 0.8;
const CALENDAR_COUNTERPART_LOOKUP_LIMIT = 5;
const SMALL_ACTION_MINIMUM_CREDITS = 3;
const COACHING_FEEDBACK_MINIMUM_CREDITS = 5;
const LINEAR_ISSUE_DRAFTING_MINIMUM_CREDITS = 8;
const LARGE_ACTION_MINIMUM_CREDITS = 10;
const DEFAULT_RESEARCH_PAGE_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const RECENT_RESEARCH_QUERY_LIMIT = 8;
const RECENT_RESEARCH_UTTERANCE_LIMIT = 12;
const DEFAULT_INVOCATION_PAGE_LIMIT = 20;
const EXACT_TASK_TITLE_SCORE = 100;
const HIGH_TITLE_TOKEN_SIMILARITY = 0.75;
const HIGH_TITLE_CHARACTER_SIMILARITY = 0.8;
const SHARED_EVIDENCE_TITLE_SCORE = 85;
const SHARED_EVIDENCE_SCORE_STEP = 5;
const QUOTE_TOKEN_SIMILARITY = 0.3;
const QUOTE_CHARACTER_SIMILARITY = 0.55;
const QUOTE_MATCH_SCORE = 75;
const SEGMENT_TOKEN_SIMILARITY = 0.5;
const SEGMENT_CHARACTER_SIMILARITY = 0.65;
const SEGMENT_MATCH_SCORE = 65;

const DEFAULT_OUTBOX_CLAIM_LIMIT = 25;
const LINEAR_CANDIDATE_LIMIT = 10;

const AMBIENT_ERROR_MAX_LENGTH = 1000;

const DEFAULT_FINALIZATION_RECOVERY_AGE_MS = 600_000;
const ADMIN_USAGE_MAX_LIMIT = 250;
const ADMIN_USAGE_DEFAULT_LIMIT = 50;

const unknownArraySchema = z.array(z.unknown());

const hasText = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (value: unknown): string => (typeof value === "string" ? value : "");

const readNullableString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const readUserPlan = (value: unknown): UserPlan | null => {
  const result = userPlanSchema.safeParse(value);

  return result.success ? result.data : null;
};

const readStringProperty = (input: { record: Record<string, unknown>; key: string }): string | undefined => {
  const field = input.record[input.key];

  return typeof field === "string" ? field : undefined;
};

const earliestInstant = (input: { current: Date | null; incoming: Date }): Date =>
  input.current === null || input.incoming.getTime() < input.current.getTime() ? input.incoming : input.current;

const mapRowsSequentially = async <Row, Result>(input: {
  rows: readonly Row[];
  visit: (row: Row) => Promise<Result | undefined>;
}): Promise<Result[]> =>
  input.rows.reduce<Promise<Result[]>>(async (previous, row) => {
    const collected = await previous;
    const next = await input.visit(row);

    return next === undefined ? collected : [...collected, next];
  }, Promise.resolve([]));

const forEachSequential = async <Item>(input: {
  items: readonly Item[];
  visit: (item: Item) => Promise<void>;
}): Promise<void> => {
  await input.items.reduce(async (previous, item) => {
    await previous;
    await input.visit(item);
  }, Promise.resolve());
};

const transcriptSegmentMetadataColumns: { availability: Promise<boolean> | null } = { availability: null };

export class ActiveMeetingTurnConflictError extends Error {
  constructor(public readonly activeTurn: Awaited<ReturnType<typeof getActiveMeetingTurn>> = null) {
    super("Meeting already has an active assistant turn");
    this.name = "ActiveMeetingTurnConflictError";
  }
}

export function meetingTasksRealtimeChannel(input: { workspaceId: string; meetingId: string }): string {
  return `workspace:${input.workspaceId}:meeting:${input.meetingId}:tasks`;
}

export function userTasksRealtimeChannel(input: { workspaceId: string; userId: string }): string {
  return `workspace:${input.workspaceId}:user:${input.userId}:tasks`;
}

export function workspaceTasksRealtimeChannel(input: { workspaceId: string }): string {
  return `workspace:${input.workspaceId}:tasks`;
}

export function userCalendarRealtimeChannel(input: { workspaceId: string; userId: string }): string {
  return userTasksRealtimeChannel(input);
}

type RealtimeOutboxEventInput = {
  channel: string;
  eventName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
};

function buildTaskRealtimePayload(input: {
  eventName: TaskRealtimeEventName;
  workspaceId: string;
  meetingId?: string | null;
  taskId?: string | null;
  sourceType?: "meeting" | "workspace";
  sourceTaskId?: string | null;
  sectionId?: string | null;
  revision?: number | null;
  placementRevision?: number | null;
  taskListVersion?: number | null;
  actorUserId?: string | null;
}) {
  return {
    version: 1,
    eventId: randomUUID(),
    eventName: input.eventName,
    workspaceId: input.workspaceId,
    meetingId: input.meetingId ?? null,
    taskId: input.taskId ?? null,
    sourceType: input.sourceType,
    sourceTaskId: input.sourceTaskId ?? input.taskId ?? null,
    sectionId: input.sectionId ?? null,
    revision: input.revision ?? null,
    placementRevision: input.placementRevision ?? null,
    taskListVersion: input.taskListVersion ?? null,
    occurredAt: new Date().toISOString(),
    actorUserId: input.actorUserId ?? null,
  };
}

function buildCalendarRealtimePayload(input: {
  eventName: CalendarRealtimeEventName;
  userId: string;
  provider: CalendarProvider;
  connectorId?: string | null;
  calendarId?: string | null;
  resourceState?: string | null;
  messageNumber?: string | null;
}) {
  return {
    version: 1,
    eventId: randomUUID(),
    eventName: input.eventName,
    userId: input.userId,
    provider: input.provider,
    connectorId: input.connectorId ?? null,
    calendarId: input.calendarId ?? null,
    resourceState: input.resourceState ?? null,
    messageNumber: input.messageNumber ?? null,
    occurredAt: new Date().toISOString(),
  };
}

const participantIdsForMeeting = async (meetingId: string): Promise<Set<string>> => {
  const rows = await db.meetingParticipants.findMany({
    where: { meetingId },
    select: {
      userId: true,
    },
  });

  return new Set(rows.map((row) => row.userId));
};

/** Match the private feed's attendee filing without changing the source workspace in payloads. */
async function meetingTaskRecipientWorkspaces(input: { meetingId: string }) {
  const [filings, participantIds] = await Promise.all([
    db.meetingAttendeeWorkspaces.findMany({
      where: { meetingId: input.meetingId },
      select: {
        userId: true,
        workspaceId: true,
      },
    }),
    participantIdsForMeeting(input.meetingId),
  ]);

  return new Map(filings.filter((row) => participantIds.has(row.userId)).map((row) => [row.userId, row.workspaceId]));
}

const filingWorkspaceForRecipient = (input: {
  userId: string;
  isParticipant: boolean;
  hostWorkspaceId: string;
  filingByUser: ReadonlyMap<string, string>;
}): string =>
  input.isParticipant ? (input.filingByUser.get(input.userId) ?? input.hostWorkspaceId) : input.hostWorkspaceId;

/** Shared authorization for direct assignees and attendee observers. Missing entries must not fall back to the host. */
async function eligibleMeetingTaskRecipientWorkspaces(input: {
  meetingId: string;
  assigneeUserIds?: (string | null)[];
}) {
  const assignees = input.assigneeUserIds?.filter((id): id is string => id !== null && id !== "");
  if (assignees?.length === 0) {
    return new Map<string, string>();
  }
  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { id: input.meetingId },
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredMeeting(row)),
  });
  if (meeting === undefined || (assignees === undefined && meeting.kind === "agent_intro")) {
    return new Map<string, string>();
  }
  const participantIds = await participantIdsForMeeting(input.meetingId);
  const candidateIds = assignees === undefined ? [...participantIds] : [...new Set(assignees)];
  if (candidateIds.length === 0) {
    return new Map<string, string>();
  }
  const [filings, memberships] = await Promise.all([
    db.meetingAttendeeWorkspaces.findMany({
      where: { meetingId: input.meetingId },
      select: {
        userId: true,
        workspaceId: true,
      },
    }),
    mapRow({
      value: db.workspaceMemberships.findMany({
        where: { userId: { in: candidateIds } },
        select: {
          userId: true,
          workspaceId: true,
          status: true,
        },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          status: readStringUnion({ values: ["active", "suspended"], value: row.status }),
        })),
    }),
  ]);
  const filingByUser = new Map(filings.map((row) => [row.userId, row.workspaceId]));
  const suspendedOnHost = new Set(
    memberships
      .filter((row) => row.workspaceId === meeting.workspaceId && row.status === "suspended")
      .map((row) => row.userId),
  );
  const activeMembership = new Set(
    memberships.filter((row) => row.status === "active").map((row) => `${row.userId}:${row.workspaceId}`),
  );
  const entries = candidateIds.flatMap((userId) => {
    const isParticipant = participantIds.has(userId);
    const workspaceId = filingWorkspaceForRecipient({
      userId,
      isParticipant,
      hostWorkspaceId: meeting.workspaceId,
      filingByUser,
    });
    const isVisible = !meeting.isConfidential || meeting.createdByUserId === userId || isParticipant;
    if (suspendedOnHost.has(userId) || !isVisible || !activeMembership.has(`${userId}:${workspaceId}`)) {
      return [];
    }

    return [[userId, workspaceId] as const];
  });

  return new Map(entries);
}

function buildGeneratedTaskRealtimeEvents(input: {
  recipientWorkspaces: ReadonlyMap<string, string>;
  workspaceId: string;
  meetingId: string;
  taskListVersion: number;
  tasks: MeetingTask[];
}): RealtimeOutboxEventInput[] {
  const meetingChannel = meetingTasksRealtimeChannel({
    workspaceId: input.workspaceId,
    meetingId: input.meetingId,
  });
  const events: RealtimeOutboxEventInput[] = [
    {
      channel: meetingChannel,
      eventName: "task.list.updated",
      payload: buildTaskRealtimePayload({
        eventName: "task.list.updated",
        workspaceId: input.workspaceId,
        meetingId: input.meetingId,
        taskListVersion: input.taskListVersion,
        actorUserId: null,
      }),
      dedupeKey: `meeting:${input.meetingId}:task-list:${input.taskListVersion}:completed`,
    },
  ];
  const taskEvents = input.tasks
    .filter((task) => task.status !== "dismissed")
    .flatMap((task) => {
      const assigneeUserId = task.assignee.userId;
      const assignedEvents =
        assigneeUserId !== null && assigneeUserId !== ""
          ? meetingUserTaskRealtimeEvents({
              recipientWorkspaces: input.recipientWorkspaces,
              userId: assigneeUserId,
              eventName: "task.assigned",
              payload: buildTaskRealtimePayload({
                eventName: "task.assigned",
                workspaceId: input.workspaceId,
                meetingId: input.meetingId,
                taskId: task.id,
                revision: task.revision,
                taskListVersion: input.taskListVersion,
                actorUserId: null,
              }),
              dedupeKey: `task:${task.id}:revision:${task.revision}:generated-assigned:${assigneeUserId}`,
            })
          : [];

      return [
        {
          channel: meetingChannel,
          eventName: "task.created",
          payload: buildTaskRealtimePayload({
            eventName: "task.created",
            workspaceId: input.workspaceId,
            meetingId: input.meetingId,
            taskId: task.id,
            revision: task.revision,
            taskListVersion: input.taskListVersion,
            actorUserId: null,
          }),
          dedupeKey: `task:${task.id}:revision:${task.revision}:created`,
        },
        ...assignedEvents,
      ];
    });

  return [...events, ...taskEvents];
}

function meetingUserTaskRealtimeEvents(input: {
  recipientWorkspaces: ReadonlyMap<string, string>;
  userId: string;
  eventName: TaskRealtimeEventName;
  payload: Record<string, unknown>;
  dedupeKey: string;
}): RealtimeOutboxEventInput[] {
  const workspaceId = input.recipientWorkspaces.get(input.userId);
  if (workspaceId === undefined || workspaceId === "") {
    return [];
  }

  return [
    {
      channel: userTasksRealtimeChannel({
        workspaceId,
        userId: input.userId,
      }),
      eventName: input.eventName,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
    },
  ];
}

const taskIdFromPayload = (payload: Record<string, unknown>): string | null => {
  const taskId = payload.taskId;

  return typeof taskId === "string" && taskId !== "" ? taskId : null;
};

/** Others/Done also include fellow attendees' tasks. Notify each attendee privately. */
async function addMeetingTaskAttendeeRealtimeEvents(input: {
  meetingId: string;
  workspaceId: string;
  events: readonly RealtimeOutboxEventInput[];
}): Promise<RealtimeOutboxEventInput[]> {
  const meetingChannel = meetingTasksRealtimeChannel(input);
  const taskEvents = input.events.filter(
    (event) => event.channel === meetingChannel && taskIdFromPayload(event.payload) !== null,
  );
  if (taskEvents.length === 0) {
    return [...input.events];
  }
  const viewers = await eligibleMeetingTaskRecipientWorkspaces({ meetingId: input.meetingId });
  const delivered = new Set(
    input.events.flatMap((event) => {
      const taskId = taskIdFromPayload(event.payload);

      return taskId === null ? [] : [`${event.channel}:${taskId}`];
    }),
  );
  const additions = [...viewers.entries()].flatMap(([userId, workspaceId]) => {
    const channel = userTasksRealtimeChannel({ workspaceId, userId });

    return taskEvents.flatMap((event) => {
      const taskId = taskIdFromPayload(event.payload);
      if (taskId === null) {
        return [];
      }
      const key = `${channel}:${taskId}`;
      if (delivered.has(key)) {
        return [];
      }
      delivered.add(key);

      return [
        {
          ...event,
          channel,
          dedupeKey: `${event.dedupeKey}:attendee:${userId}:${workspaceId}`,
        },
      ];
    });
  });

  return [...input.events, ...additions];
}

function isMeetingTurnConflictError(error: unknown): boolean {
  return isUniqueConstraintError({ error, constraint: MEETING_TURNS_ACTIVE_MEETING_CONSTRAINT });
}

function isUniqueConstraintError(input: { error: unknown; constraint: string }): boolean {
  return (
    postgresErrorCode(input.error) === POSTGRES_UNIQUE_VIOLATION_CODE &&
    postgresConstraintName(input.error) === input.constraint
  );
}

const postgresErrorRecords = (error: unknown): Record<string, unknown>[] => {
  const visit = (input: { value: unknown; seen: ReadonlySet<unknown> }): Record<string, unknown>[] => {
    if (!isUnknownRecord(input.value) || input.seen.has(input.value)) {
      return [];
    }
    const nextSeen = new Set<unknown>([...input.seen, input.value]);

    return [input.value, ...Object.values(input.value).flatMap((nested) => visit({ value: nested, seen: nextSeen }))];
  };

  return visit({ value: error, seen: new Set() });
};

const postgresOriginalCode = (record: Record<string, unknown>): string | undefined => {
  const originalCode = readStringProperty({ record, key: "originalCode" });
  if (originalCode === POSTGRES_UNIQUE_VIOLATION_CODE || originalCode === POSTGRES_FOREIGN_KEY_VIOLATION_CODE) {
    return originalCode;
  }

  return undefined;
};

const postgresDriverCode = (record: Record<string, unknown>): string | undefined => {
  const code = readStringProperty({ record, key: "code" });
  if (code === POSTGRES_UNIQUE_VIOLATION_CODE || code === POSTGRES_FOREIGN_KEY_VIOLATION_CODE) {
    return code;
  }
  if (code === "P2002") {
    return POSTGRES_UNIQUE_VIOLATION_CODE;
  }
  if (code === "P2003") {
    return POSTGRES_FOREIGN_KEY_VIOLATION_CODE;
  }

  return undefined;
};

function postgresErrorCode(error: unknown): string | undefined {
  const records = postgresErrorRecords(error);

  return (
    records.map(postgresOriginalCode).find((code) => code !== undefined) ??
    records.map(postgresDriverCode).find((code) => code !== undefined)
  );
}

const constraintNameFrom = (record: Record<string, unknown>): string | undefined => {
  const constraint = record.constraint;
  if (typeof constraint === "string" && constraint !== "") {
    return constraint;
  }
  if (!isUnknownRecord(constraint)) {
    return undefined;
  }
  const index = readStringProperty({ record: constraint, key: "index" });

  return index === undefined || index === "" ? undefined : index;
};

function postgresConstraintName(error: unknown): string | undefined {
  return postgresErrorRecords(error)
    .map(constraintNameFrom)
    .find((constraint) => constraint !== undefined);
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION_CODE;
}

const UNIQUE_VIOLATION_RETRY_ATTEMPTS = 5;

async function withUniqueViolationRetry<Result>(input: {
  run: () => Promise<Result>;
  remainingAttempts?: number;
}): Promise<Result> {
  try {
    return await input.run();
  } catch (error) {
    const remainingAttempts = input.remainingAttempts ?? UNIQUE_VIOLATION_RETRY_ATTEMPTS;
    if (!isPostgresUniqueViolation(error) || remainingAttempts <= 0) {
      throw error;
    }

    return withUniqueViolationRetry({ run: input.run, remainingAttempts: remainingAttempts - 1 });
  }
}

function isMeetingResearchActiveRunConflictError(error: unknown): boolean {
  return isUniqueConstraintError({ error, constraint: MEETING_RESEARCH_ACTIVE_RECOMMENDATION_CONSTRAINT });
}

async function hasTranscriptSegmentMetadataColumns(): Promise<boolean> {
  transcriptSegmentMetadataColumns.availability = Promise.resolve(true);

  return true;
}

function parseCapabilityCatalogRow(row: Prisma.capabilityCatalogModel): CapabilityCatalogRow {
  return capabilityCatalogRowSchema.parse({
    ...row,
    applicableMeetingTypes: row.applicableMeetingTypes,
    requiredSignals: row.requiredSignals,
    exclusionSignals: row.exclusionSignals,
    exampleTriggers: row.exampleTriggers,
    metadata: row.metadata,
  });
}

const REMOVED_CAPABILITY_KEYS = [
  "create_task_list",
  "draft_decision_brief",
  "draft_spec_outline",
  "prepare_briefing_for_next_meeting",
] as const;

function activeCapabilityPredicate() {
  return whereAnd([{ isActive: true }, { key: { notIn: [...REMOVED_CAPABILITY_KEYS] } }]);
}

function parseMeetingExtractionRow(row: Prisma.meetingExtractionsModel): MeetingExtraction {
  return meetingExtractionSchema.parse({
    ...row,
    meetingId: row.meetingId,
    contentStatus: row.contentStatus,
    signalsStatus: row.signalsStatus,
    meetingType: row.meetingType ?? null,
    meetingTypeConfidence: row.meetingTypeConfidence ?? null,
    meetingTypeReasoning: row.meetingTypeReasoning ?? null,
    participants: row.participants,
    summaryShort: row.summaryShort ?? null,
    summaryBullets: row.summaryBullets,
    decisions: row.decisions,
    actionItems: row.actionItems,
    openQuestions: row.openQuestions,
    risks: row.risks,
    highlights: row.highlights,
    keyTopics: row.keyTopics,
    signals: row.signals,
    failedToolCalls: row.failedToolCalls,
    durationMs: row.durationMs ?? null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function parseCapabilityRecommendationRow(
  row: Prisma.meetingCapabilityRecommendationsModel,
): CapabilityRecommendationRow {
  return capabilityRecommendationRowSchema.parse({
    ...row,
    signalsMatched: row.signalsMatched,
    signalsMissing: row.signalsMissing,
    exclusionSignalsChecked: row.exclusionSignalsChecked,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  });
}

function parseSuggestedActionRunRow(row: Prisma.meetingSuggestedActionRunsModel) {
  return {
    ...row,
    status: suggestedActionRunStatusSchema.parse(row.status),
    phase: suggestedActionRunPhaseSchema.parse(row.phase),
    steps: suggestedActionStepSchema.array().parse(row.steps),
    selectedRecommendationIds: Array.isArray(row.selectedRecommendationIds)
      ? row.selectedRecommendationIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function readLinearIssueDraft(value: Prisma.JsonValue): {
  evidence: { quote: string; speaker: string | null; timestamp: string | null; segmentId: string | null }[];
  problem: string;
  observedBehavior: string | null;
  expectedBehavior: string | null;
  requestedChange: string | null;
  reproductionSteps: string[];
  impact: string | null;
} | null {
  const draft = parseNullable({ schema: linearTaskReviewIssueDraftSchema, value });
  if (draft === null) {
    return null;
  }

  return {
    problem: draft.problem,
    observedBehavior: draft.observedBehavior,
    expectedBehavior: draft.expectedBehavior,
    requestedChange: draft.requestedChange,
    reproductionSteps: draft.reproductionSteps ?? [],
    impact: draft.impact,
    evidence: draft.evidence,
  };
}

function externalLinearIssue(row: Prisma.linearTaskReviewItemsModel) {
  const id = row.externalIssueId;
  const identifier = row.externalIssueIdentifier;
  const title = row.externalIssueTitle;
  const url = row.externalIssueUrl;
  if (!hasText(id) || !hasText(identifier) || !hasText(title) || !hasText(url)) {
    return null;
  }

  return { id, identifier, title, url };
}

function parseLinearTaskReviewItemRow(row: Prisma.linearTaskReviewItemsModel) {
  return {
    id: row.id,
    runId: row.runId,
    position: row.position,
    sourceTaskIds: readStringArray(row.sourceTaskIds),
    decision: readStringUnion({ values: ["linear", "uncertain"], value: row.decision }),
    confidence: row.confidence / CONFIDENCE_PERCENT_SCALE,
    reasoning: row.reasoning,
    title: row.title,
    description: row.description,
    issueDraft: readLinearIssueDraft(row.issueDraft),
    teamId: row.teamId,
    teamName: row.teamName,
    /** @external existing wire contract */ included: row.included,
    syncStatus: linearTaskReviewSyncStatusSchema.parse(row.syncStatus),
    syncError: row.syncError,
    duplicateIssues: z.array(linearTaskReviewDuplicateIssueSchema).parse(row.duplicateIssues),
    targetAction: linearTaskReviewTargetActionSchema.parse(row.targetAction),
    targetIssue: parseNullable({ schema: linearTaskReviewExternalIssueSchema, value: row.targetIssue }),
    relationId: row.relationId,
    meetingContextSyncedAt: row.meetingContextSyncedAt?.toISOString() ?? null,
    externalIssue: externalLinearIssue(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseLinearTaskReviewRunRow(input: {
  row: Prisma.linearTaskReviewRunsModel;
  items: Prisma.linearTaskReviewItemsModel[];
}): LinearTaskReviewRun {
  return linearTaskReviewRunSchema.parse({
    ...input.row,
    startedAt: input.row.startedAt?.toISOString() ?? null,
    completedAt: input.row.completedAt?.toISOString() ?? null,
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
    items: input.items.map(parseLinearTaskReviewItemRow),
  });
}

function parseAiWorkflowJobRow(row: Prisma.aiWorkflowExecutionsModel): AiWorkflowJobView {
  // Keep the existing wire shape while exposing actual request execution history.
  return aiWorkflowJobViewSchema.parse({
    ...row,
    attemptCount: 1,
    maxAttempts: 1,
    runAfter: row.createdAt.toISOString(),
    lockedBy: null,
    lockedAt: null,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function parseCapabilityWorkflowRunRow(row: Prisma.capabilityWorkflowRunsModel): CapabilityWorkflowRun {
  return capabilityWorkflowRunSchema.parse({
    ...row,
    context: row.context,
    plan: row.plan,
    draft: row.draft,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

function parseCapabilityWorkflowMessageRow(row: Prisma.capabilityWorkflowMessagesModel): CapabilityWorkflowMessage {
  return capabilityWorkflowMessageSchema.parse({
    ...row,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  });
}

function meetingTaskAssigneeFromRow(row: Prisma.meetingTasksModel) {
  return {
    userId: row.ownerUserId ?? null,
    name: row.ownerName ?? null,
    email: row.ownerEmail ?? null,
    confidence: row.ownerConfidence ?? null,
  };
}

function parseMeetingTaskRow(row: Prisma.meetingTasksModel): MeetingTask {
  const assignee = meetingTaskAssigneeFromRow(row);

  return meetingTaskSchema.parse({
    id: row.id,
    meetingId: row.meetingId,
    taskListId: row.taskListId,
    position: row.position,
    title: row.title,
    description: row.description ?? null,
    type: row.type,
    workKind: row.workKind,
    assignee,
    owner: assignee,
    dueDate: {
      value: row.dueDateValue ?? null,
      confidence: row.dueDateConfidence ?? null,
    },
    confidence: row.confidence,
    sourceQuotes: row.sourceQuotes,
    sourceReason: row.sourceReason,
    status: row.status,
    revision: row.revision,
    createdFrom: row.createdFrom,
    origin: row.origin,
    statusSource: row.statusSource,
    statusActorUserId: row.statusActorUserId ?? null,
    statusChangedAt: row.statusChangedAt.toISOString(),
    actionConfirmableAt: row.actionConfirmableAt?.toISOString() ?? null,
    detectedAt: row.detectedAt?.toISOString() ?? null,
    firstRenderedAt: row.firstRenderedAt?.toISOString() ?? null,
    assetIds: row.assetIds,
    externalLinks: row.externalLinks,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

function parseMeetingAssetRow(row: Prisma.meetingAssetsModel): MeetingAsset {
  return meetingAssetSchema.parse({
    id: row.id,
    meetingId: row.meetingId,
    kind: row.kind,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    capturedAt: row.capturedAt.toISOString(),
    participantIdentity: row.participantIdentity,
    trackSid: row.trackSid,
    trigger: row.trigger,
    transcriptSegmentIds: row.transcriptSegmentIds,
    transcriptExcerpt: row.transcriptExcerpt,
    speakerName: row.speakerName,
    /** @external existing wire contract */ includeInLinear: row.includeInLinear,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function parseMeetingTaskListRow(input: {
  row: Prisma.meetingTaskListsModel;
  taskRows?: Prisma.meetingTasksModel[];
}): MeetingTaskList {
  const taskRows = input.taskRows ?? [];

  return meetingTaskListSchema.parse({
    id: input.row.id,
    meetingId: input.row.meetingId,
    status: input.row.status,
    phase: input.row.phase ?? null,
    error: input.row.error ?? null,
    model: input.row.model ?? null,
    promptVersion: input.row.promptVersion ?? null,
    transcriptHash: input.row.transcriptHash ?? null,
    taskListVersion: input.row.taskListVersion,
    items: taskRows.map(parseMeetingTaskRow),
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
    completedAt: input.row.completedAt?.toISOString() ?? null,
  });
}

type LiveTaskCandidateRow = Prisma.meetingLiveTaskCandidatesModel;
type LiveTaskEvidenceRow = Prisma.meetingLiveTaskCandidateEvidenceModel;

function parseLiveMeetingTaskCandidateRow(input: {
  row: LiveTaskCandidateRow;
  evidenceRows?: LiveTaskEvidenceRow[];
}): LiveMeetingTaskCandidate {
  const evidenceRows = input.evidenceRows ?? [];
  const row = input.row;

  return liveMeetingTaskCandidateSchema.parse({
    id: row.id,
    meetingId: row.meetingId,
    linkedTaskId: row.linkedTaskId ?? null,
    state: row.state,
    proposal: {
      title: row.title,
      description: row.description ?? null,
      type: row.type,
      workKind: row.workKind,
      owner: {
        userId: row.ownerUserId ?? null,
        name: row.ownerName ?? null,
        email: row.ownerEmail ?? null,
        confidence: row.ownerConfidence ?? null,
      },
      dueDate: {
        value: row.dueDateValue ?? null,
        confidence: row.dueDateConfidence ?? null,
      },
      confidence: row.confidence,
      completion: row.completion,
      sourceQuotes: row.sourceQuotes,
      sourceReason: row.sourceReason,
    },
    unresolvedQuestions: row.unresolvedQuestions,
    firstEvidenceAt: row.firstEvidenceAt.toISOString(),
    actionConfirmableAt: row.actionConfirmableAt?.toISOString() ?? null,
    lastEvidenceAt: row.lastEvidenceAt.toISOString(),
    model: row.model ?? null,
    promptVersion: row.promptVersion ?? null,
    revision: row.revision,
    evidence: evidenceRows.map((evidence) => ({
      id: evidence.id,
      candidateId: evidence.candidateId,
      roles: evidence.roles,
      transcriptSegmentId: evidence.transcriptSegmentId ?? null,
      sourceSegmentId: evidence.sourceSegmentId ?? null,
      fullSegmentText: evidence.fullSegmentText,
      quote: evidence.quote,
      quoteStart: evidence.quoteStart,
      quoteEnd: evidence.quoteEnd,
      contentHash: evidence.contentHash,
      speakerIdentity: evidence.speakerIdentity ?? null,
      speakerUserId: evidence.speakerUserId ?? null,
      speakerName: evidence.speakerName,
      startedAt: evidence.startedAt.toISOString(),
      endedAt: evidence.endedAt.toISOString(),
      sequence: evidence.sequence,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function parseWorkspaceTaskSectionRow(row: Prisma.workspaceTaskSectionsModel): WorkspaceTaskSection {
  return workspaceTaskSectionSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    position: row.position,
    isDefault: row.isDefault,
    createdByUserId: row.createdByUserId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  });
}

function parseWorkspaceTaskRow(row: Prisma.workspaceTasksModel): WorkspaceTask {
  return workspaceTaskSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    assigneeUserId: row.assigneeUserId ?? null,
    title: row.title,
    description: row.description ?? null,
    dueDate: {
      value: row.dueDateValue ?? null,
      confidence: row.dueDateConfidence ?? null,
    },
    status: row.status,
    revision: row.revision,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

const ACTIVE_MEETING_JOIN_REQUEST_STATUSES = ["waiting", "admitted"] as const;
export type MeetingJoinRequestStatus = "waiting" | "admitted" | "denied" | "expired" | "revoked";

function parseMeetingJoinRequestRow(row: Prisma.meetingJoinRequestsModel) {
  return {
    id: row.id,
    meetingLinkId: row.meetingLinkId,
    meetingId: row.meetingId ?? null,
    userId: row.userId,
    displayName: row.displayNameSnapshot,
    status: readStringUnion({ values: ["waiting", "admitted", "denied", "expired", "revoked"], value: row.status }),
    sipCallId: row.sipCallId ?? null,
    sipParticipantIdentity: row.sipParticipantIdentity ?? null,
    sipHoldingRoom: row.sipHoldingRoom ?? null,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Default name for a newly created workspace: the company domain without its
 * TLD, capitalized ("ready.app" → "Ready"). Public mail providers say nothing
 * about a company, so those accounts get "<first name>'s workspace" instead.
 * Names are display-only and need not be unique — identity is the id.
 */
export function workspaceNameForUser(input: { email: string; displayName: string }): string {
  const domain = emailDomain(input.email);
  if (domain !== null && domain !== "" && !isPublicEmailDomain(domain)) {
    const label = domain.split(".")[0]?.trim();
    if (label !== undefined && label !== "") {
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
  }
  const firstName = input.displayName.trim().split(/\s+/)[0] ?? "";

  return firstName !== "" ? `${firstName}'s workspace` : "My workspace";
}

function toUserWithWorkspace<T extends { id: string; email: string; displayName: string }>(input: {
  user: T;
  workspaceId: string;
}) {
  return {
    ...input.user,
    workspaceId: input.workspaceId,
  };
}

async function claimWorkspaceForOwner(input: { workspaceId: string; userId: string }): Promise<string> {
  await createIgnoringUniqueConflict(() =>
    db.workspaceMemberships.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: "owner",
      },
    }),
  );
  await db.users.updateMany({
    where: { id: input.userId },
    data: {
      activeWorkspaceId: input.workspaceId,
    },
  });

  return input.workspaceId;
}

/**
 * Whether the creator's existing system_default workspace may be reused as
 * their default context. It may when the creator is an active member, or when
 * it has no members yet (a concurrent first sign-in won the insert and has not
 * written its Owner membership). It may not when the creator was suspended
 * there or no longer belongs to it while others do: reusing it would hand back
 * a suspended context or silently re-grant ownership.
 */
async function canReuseSystemDefaultWorkspace(input: { workspaceId: string; userId: string }): Promise<boolean> {
  const memberships = await mapRow({
    value: db.workspaceMemberships.findMany({
      where: { workspaceId: input.workspaceId },
      select: {
        userId: true,
        status: true,
      },
    }),
    map: (rows) =>
      rows.map((row) => ({ ...row, status: readStringUnion({ values: ["active", "suspended"], value: row.status }) })),
  });
  if (memberships.length === 0) {
    return true;
  }
  const own = memberships.find((membership) => membership.userId === input.userId);

  return own?.status === "active";
}

async function isReusableReplacementWorkspace(input: { workspaceId: string; userId: string }): Promise<boolean> {
  const workspace = await mapRow({
    value: db.workspaces.findFirst({
      where: whereAnd([
        { id: input.workspaceId },
        { createdByUserId: input.userId },
        { createdVia: "system_replacement" },
      ]),
      take: 1,
      select: {
        id: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (!workspace) {
    return false;
  }

  return canReuseSystemDefaultWorkspace(input);
}

async function createSystemDefaultWorkspace(input: {
  userId: string;
  email: string;
  displayName: string;
}): Promise<string> {
  const inserted = await createIgnoringUniqueConflict(() =>
    db.workspaces.create({
      data: {
        name: workspaceNameForUser(input),
        createdByUserId: input.userId,
        createdVia: "system_default",
      },
      select: { id: true },
    }),
  );
  if (inserted) {
    return claimWorkspaceForOwner({ workspaceId: inserted.id, userId: input.userId });
  }

  const existing = await mapRow({
    value: db.workspaces.findFirst({
      where: whereAnd([{ createdByUserId: input.userId }, { createdVia: "system_default" }]),
      take: 1,
      select: {
        id: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  if (!existing) {
    throw new Error(FAILED_TO_CREATE_WORKSPACE_MESSAGE);
  }

  if (await canReuseSystemDefaultWorkspace({ workspaceId: existing.id, userId: input.userId })) {
    return claimWorkspaceForOwner({ workspaceId: existing.id, userId: input.userId });
  }

  // The signup workspace is someone else's context now (e.g. the user was
  // suspended from it), so never resolve it as the default: open a fresh
  // replacement workspace the user owns instead.
  return createSystemReplacementWorkspace(input);
}

/**
 * Opens one system_replacement workspace for a user with no usable default.
 * Concurrent callers race on a compare-and-set of users.active_workspace_id
 * from the stale value they all observed: exactly one wins and becomes the
 * owner; every loser deletes its unused workspace and returns the winner's.
 */
async function createSystemReplacementWorkspace(input: {
  userId: string;
  email: string;
  displayName: string;
}): Promise<string> {
  const userRow = await mapRow({
    value: db.users.findFirst({
      where: { id: input.userId },
      take: 1,
      select: {
        activeWorkspaceId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (!userRow) {
    throw new Error(USER_NOT_FOUND_MESSAGE);
  }
  const staleActiveWorkspaceId = userRow.activeWorkspaceId;
  if (
    staleActiveWorkspaceId !== null &&
    (await isReusableReplacementWorkspace({ workspaceId: staleActiveWorkspaceId, userId: input.userId }))
  ) {
    // A concurrent caller already opened a replacement (its Owner membership
    // may not be written yet): resolve to it instead of opening another.
    return claimWorkspaceForOwner({ workspaceId: staleActiveWorkspaceId, userId: input.userId });
  }

  const replacement = await db.workspaces.create({
    data: {
      name: workspaceNameForUser(input),
      createdByUserId: input.userId,
      createdVia: "system_replacement",
    },
    select: { id: true },
  });

  const [claimed] = await db.users.updateManyAndReturn({
    where: whereAnd([
      { id: input.userId },
      staleActiveWorkspaceId === null ? { activeWorkspaceId: null } : { activeWorkspaceId: staleActiveWorkspaceId },
    ]),
    data: {
      activeWorkspaceId: replacement.id,
    },
    select: { id: true },
  });

  if (claimed) {
    return claimWorkspaceForOwner({ workspaceId: replacement.id, userId: input.userId });
  }

  // A concurrent caller already switched the user to its replacement.
  await db.workspaces.deleteMany({
    where: { id: replacement.id },
  });
  const winner = await mapRow({
    value: db.users.findFirst({
      where: { id: input.userId },
      take: 1,
      select: {
        activeWorkspaceId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (winner?.activeWorkspaceId === undefined || winner.activeWorkspaceId === null) {
    throw new Error(FAILED_TO_CREATE_WORKSPACE_MESSAGE);
  }

  return winner.activeWorkspaceId;
}

async function ensureDefaultWorkspaceForUserInTransaction(input: {
  userId: string;
  email: string;
  displayName: string;
}) {
  // One system_default workspace per creator. A concurrent first sign-in
  // reuses the winner instead of opening a second workspace.
  const userSourceRow = await mapRow({
    value: db.users.findFirst({
      where: { id: input.userId },
      take: 1,
      select: {
        source: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
          },
  });
  if (!userSourceRow) {
    throw new Error(USER_NOT_FOUND_MESSAGE);
  }

  // A user-selected active workspace wins while its membership is active;
  // otherwise fall back to the oldest ACTIVE membership (or create one).
  const activeSelection = await mapRow({
    value: (async () => {
      const where0 = sqlCompare({ columnSql: '"users"."id"', operator: "=", value: input.userId, cast: "uuid" });
      const join00 = sqlAnd([
        sqlColCompare({
          leftSql: '"workspace_memberships"."workspace_id"',
          operator: "=",
          rightSql: '"users"."active_workspace_id"',
        }),
        sqlColCompare({ leftSql: '"workspace_memberships"."user_id"', operator: "=", rightSql: '"users"."id"' }),
        sqlCompare({ columnSql: '"workspace_memberships"."status"', operator: "=", value: "active", cast: null }),
      ]);
      const limit0 = 1;

      return db.$queryRaw<{ workspaceId: string }[]>`
                                  SELECT "workspace_memberships"."workspace_id" AS "workspaceId"
                                  FROM "users"
                                  INNER JOIN "workspace_memberships" ON ${join00}
                                  ${sqlWhereClause(where0)}


                                  ${sqlLimit(limit0)}


                                  `;
    })(),
    map: (rows) => rows[0],
  });

  if (activeSelection) {
    return activeSelection.workspaceId;
  }

  const existing = await mapRow({
    value: db.workspaceMemberships.findFirst({
      where: whereAnd([{ userId: input.userId }, { status: "active" }]),
      orderBy: [{ createdAt: "asc" }],
      take: 1,
      select: {
        workspaceId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  if (existing) {
    await db.users.updateMany({
      where: { id: input.userId },
      data: {
        activeWorkspaceId: existing.workspaceId,
      },
    });

    return existing.workspaceId;
  }

  if (userSourceRow.source === "guest") {
    throw new Error(GUEST_USERS_CANNOT_OWN_OR_CREATE_WORKSPACES_MESSAGE);
  }

  return createSystemDefaultWorkspace(input);
}

export async function ensureDefaultWorkspaceForUser(input: {
  userId: string;
  email: string;
  displayName: string;
}): Promise<string> {
  return (async () => {
    return ensureDefaultWorkspaceForUserInTransaction({ ...input });
  })();
}

export async function ensureWorkspaceMembership(input: {
  workspaceId: string;
  userId: string;
  role?: WorkspaceAssignableRole;
}): Promise<void> {
  const userSourceRow = await mapRow({
    value: db.users.findFirst({
      where: { id: input.userId },
      take: 1,
      select: {
        source: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
          },
  });
  if (userSourceRow?.source === "guest") {
    throw new Error(GUEST_USERS_CANNOT_BE_ADDED_TO_WORKSPACES_MESSAGE);
  }

  await createIgnoringUniqueConflict(() =>
    db.workspaceMemberships.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role ?? "member",
      },
    }),
  );
}

/** Active membership only: suspended members cannot access workspace data. */
export async function isWorkspaceMember(input: { workspaceId: string; userId: string }): Promise<boolean> {
  const row = await mapRow({
    value: db.workspaceMemberships.findFirst({
      where: whereAnd([{ workspaceId: input.workspaceId }, { userId: input.userId }, { status: "active" }]),
      take: 1,
      select: {
        id: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  return Boolean(row);
}

export async function listWorkspaceMembers(workspaceId: string): Promise<
  {
    workspaceId: string;
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    role: "owner" | "admin" | "member";
  }[]
> {
  return mapRow({
    value: db.workspaceMemberships.findMany({
      where: whereAnd([{ workspaceId }, { status: "active" }, { users: { deletedAt: null } }]),
      orderBy: [{ users: { displayName: "asc" } }, { users: { email: "asc" } }],
      select: {
        workspaceId: true,
        role: true,
        users: { select: { id: true, email: true, displayName: true, avatarUrl: true } },
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        workspaceId: row.workspaceId,
        userId: row.users.id,
        email: row.users.email,
        displayName: row.users.displayName,
        avatarUrl: row.users.avatarUrl,
        role: readStringUnion({ values: ["owner", "admin", "member"], value: row.role }),
      })),
  });
}

/** Active memberships only: suspended workspaces disappear from every view. */
export async function listWorkspaceIdsForUser(userId: string): Promise<string[]> {
  const rows = await db.workspaceMemberships.findMany({
    where: whereAnd([{ userId }, { status: "active" }]),
    orderBy: [{ createdAt: "asc" }],
    select: {
      workspaceId: true,
    },
  });

  return rows.map((row) => row.workspaceId);
}

async function listWorkspaceMemberUserIds(workspaceId: string) {
  const rows = await db.workspaceMemberships.findMany({
    where: { workspaceId },
    select: {
      userId: true,
    },
  });

  return rows.map((row) => row.userId);
}

type EnsureDefaultWorkspaceTaskSectionResult = Promise<{
  id: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  workspaceId: string;
  title: string;
  isDefault: boolean;
  position: number;
  updatedByUserId: string | null;
}>;

export async function ensureDefaultWorkspaceTaskSection(input: {
  workspaceId: string;
  actorUserId?: string | null;
}): EnsureDefaultWorkspaceTaskSectionResult {
  const section = await (async () => {
    const existing = await mapRow({
      value: db.workspaceTaskSections.findFirst({
        where: whereAnd([{ workspaceId: input.workspaceId }, { isDefault: true }, { deletedAt: null }]),
        take: 1,
      }),
      map: (row) => row ?? undefined,
    });

    if (existing) {
      return existing;
    }

    await createIgnoringUniqueConflict(() =>
      db.workspaceTaskSections.create({
        data: {
          workspaceId: input.workspaceId,
          title: "Inbox",
          position: 0,
          isDefault: true,
          createdByUserId: input.actorUserId ?? null,
          updatedByUserId: input.actorUserId ?? null,
        },
      }),
    );

    const created = await mapRow({
      value: db.workspaceTaskSections.findFirst({
        where: whereAnd([{ workspaceId: input.workspaceId }, { isDefault: true }, { deletedAt: null }]),
        take: 1,
      }),
      map: (row) => row ?? undefined,
    });

    if (!created) {
      throw new Error(failedToCreateDefaultTaskSectionForWorkspaceMessage(input.workspaceId));
    }

    return created;
  })();

  return parseWorkspaceTaskSectionRow(section);
}

type ListWorkspaceTaskSectionsResult = Promise<
  {
    id: string;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
    createdByUserId: string | null;
    workspaceId: string;
    title: string;
    isDefault: boolean;
    position: number;
    updatedByUserId: string | null;
  }[]
>;

export async function listWorkspaceTaskSections(input: {
  workspaceId: string;
  actorUserId?: string | null;
}): ListWorkspaceTaskSectionsResult {
  await ensureDefaultWorkspaceTaskSection(input);
  const rows = await db.workspaceTaskSections.findMany({
    where: whereAnd([{ workspaceId: input.workspaceId }, { deletedAt: null }]),
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });

  return rows.map(parseWorkspaceTaskSectionRow);
}

const resolveDefaultAssignedTaskSection = async (input: { workspaceId: string; actorUserId?: string | null }) => {
  const defaultSection = await mapRow({
    value: db.workspaceTaskSections.findFirst({
      where: whereAnd([{ workspaceId: input.workspaceId }, { isDefault: true }, { deletedAt: null }]),
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  const [createdSection] = defaultSection
    ? []
    : await mapRow({
        value: createIgnoringUniqueConflict(() =>
          db.workspaceTaskSections.create({
            data: {
              workspaceId: input.workspaceId,
              title: "Inbox",
              position: 0,
              isDefault: true,
              createdByUserId: input.actorUserId ?? null,
              updatedByUserId: input.actorUserId ?? null,
            },
          }),
        ),
        map: (row) => (row === undefined ? [] : [row]),
      });
  const [reloadedSection] =
    defaultSection || createdSection
      ? []
      : await db.workspaceTaskSections.findMany({
          where: whereAnd([{ workspaceId: input.workspaceId }, { isDefault: true }, { deletedAt: null }]),
          take: 1,
        });
  const section = defaultSection ?? createdSection ?? reloadedSection;

  if (!section) {
    throw new Error(failedToResolveDefaultTaskSectionForWorkspaceMessage(input.workspaceId));
  }

  return section;
};

const ensureAssignedTaskPlacementsWithin = async (args: {
  input: {
    workspaceId: string;
    assigneeUserId: string;
    actorUserId?: string | null;
    tasks: { sourceType: "meeting" | "workspace"; sourceTaskId: string }[];
  };
}) => {
  const { input } = args;

  const section = await resolveDefaultAssignedTaskSection({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
  });

  const sourceTaskIds = input.tasks.map((task) => task.sourceTaskId);
  const existingRows = await mapRow({
    value: db.assignedTaskPlacements.findMany({
      where: whereAnd([
        { workspaceId: input.workspaceId },
        { assigneeUserId: input.assigneeUserId },
        { sourceTaskId: { in: sourceTaskIds } },
      ]),
    }),
    map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
  });
  const existingKeys = new Set(existingRows.map((row) => `${row.sourceType}:${row.sourceTaskId}`));
  const missing = input.tasks.filter((task) => !existingKeys.has(`${task.sourceType}:${task.sourceTaskId}`));
  if (missing.length === 0) {
    return;
  }

  await mapRowsSequentially({
    rows: await mapRow({
      value: db.assignedTaskPlacements.findMany({
        where: whereAnd([
          { workspaceId: input.workspaceId },
          { assigneeUserId: input.assigneeUserId },
          { sectionId: section.id },
        ]),
      }),
      map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.assignedTaskPlacements.updateManyAndReturn({
          where: whereAnd([
            { sourceType: storedRow.sourceType },
            { sourceTaskId: storedRow.sourceTaskId },
            { workspaceId: storedRow.workspaceId },
            { assigneeUserId: storedRow.assigneeUserId },
          ]),
          data: {
            position: storedRow.position + missing.length,
            revision: storedRow.revision + 1,
            updatedByUserId: input.actorUserId ?? null,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
      });

      return updatedRows[0];
    },
  });

  await db.assignedTaskPlacements.createMany({
    data: missing.map((task, index) => ({
      sourceType: task.sourceType,
      sourceTaskId: task.sourceTaskId,
      workspaceId: input.workspaceId,
      assigneeUserId: input.assigneeUserId,
      sectionId: section.id,
      position: index,
      updatedByUserId: input.actorUserId ?? null,
    })),
    skipDuplicates: true,
  });
};

async function ensureAssignedTaskPlacements(input: {
  workspaceId: string;
  assigneeUserId: string;
  actorUserId?: string | null;
  tasks: { sourceType: "meeting" | "workspace"; sourceTaskId: string }[];
}) {
  if (input.tasks.length === 0) {
    return;
  }

  await ensureAssignedTaskPlacementsWithin({ input });
}

type UpsertUserResult = Promise<
  {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    source: "guest" | "auth" | "dev_login" | "debug_import";
    plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
    privateBetaProEnabledAt: Date | null;
    hasCompletedFirstMeeting: boolean;
    lastSeenAt: Date | null;
    activeWorkspaceId: string | null;
    agentIntroCompletedAt: Date | null;
    sessionVersion: number;
    deletedAt: Date | null;
    createdAt: Date;
  } & { workspaceId: string }
>;

export async function upsertUser(input: {
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  source?: UserSource;
}): UpsertUserResult {
  const trimmedAvatarUrl = input.avatarUrl?.trim() ?? "";
  const normalizedAvatarUrl = trimmedAvatarUrl !== "" ? trimmedAvatarUrl : null;
  const source = input.source ?? "auth";
  if (source === "guest") {
    throw new Error(USE_CREATEGUESTUSER_FOR_GUEST_IDENTITIES_MESSAGE);
  }
  const existingUser = await mapRow({
    value: db.users.findFirst({
      where: { email: input.email },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
            plan: readStringUnion({
              values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
              value: row.plan,
            }),
          },
  });
  const [user] =
    existingUser === undefined
      ? await mapRow({
          value: db.users.create({
            data: {
              email: input.email,
              displayName: input.displayName,
              avatarUrl: normalizedAvatarUrl,
              source,
            },
          }),
          map: (row) => [
            {
              ...row,
              source: readStringUnion({
                values: ["auth", "dev_login", "debug_import", "guest"],
                value: row.source,
              }),
              plan: readStringUnion({
                values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
                value: row.plan,
              }),
            },
          ],
        })
      : await mapRow({
          value: db.users.updateManyAndReturn({
            where: { id: existingUser.id },
            data: {
              displayName:
                source === "debug_import" && existingUser.source !== "debug_import"
                  ? existingUser.displayName
                  : input.displayName,
              avatarUrl:
                source === "debug_import"
                  ? normalizedAvatarUrl === null || existingUser.source !== "debug_import"
                    ? existingUser.avatarUrl
                    : normalizedAvatarUrl
                  : (normalizedAvatarUrl ?? existingUser.avatarUrl),
              source: nextStoredUserSource({ current: existingUser.source, incoming: source }),
            },
          }),
          map: (rows) =>
            rows.map((row) => ({
              ...row,
              source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
              plan: readStringUnion({
                values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
                value: row.plan,
              }),
            })),
        });

  if (!user) {
    throw new Error(FAILED_TO_UPSERT_USER_MESSAGE);
  }

  const workspaceId = await ensureDefaultWorkspaceForUser({
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  });

  return toUserWithWorkspace({ user, workspaceId });
}

/**
 * Creates or updates a full Ready account from a verified OAuth identity.
 *
 * Provider identity is authoritative: the stable provider account id is
 * resolved before email so a Workspace email rename cannot fork a second
 * Ready account. The email fallback links existing pre-provider accounts on
 * first sign-in. User, auth account, workspace ownership, and active workspace
 * selection are committed together.
 */
type UpsertUserFromAuthenticationResult = Promise<{
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    source: "guest" | "auth" | "dev_login" | "debug_import";
    plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
    privateBetaProEnabledAt: Date | null;
    hasCompletedFirstMeeting: boolean;
    lastSeenAt: Date | null;
    activeWorkspaceId: string | null;
    agentIntroCompletedAt: Date | null;
    sessionVersion: number;
    deletedAt: Date | null;
    createdAt: Date;
  } & { workspaceId: string };
  /** @external existing wire contract */ accountCreated: boolean;
}>;

const insertOrUpdateAuthenticatedUser = async (input: {
  executor: AccountTransaction;
  existingUser: Prisma.usersModel | null;
  normalizedEmail: string;
  displayName: string;
  avatarUrl: string | null;
}) => {
  const { existingUser, normalizedEmail, displayName, avatarUrl } = input;
  if (existingUser) {
    const [conflictingEmailUser] =
      existingUser.email.toLowerCase() === normalizedEmail
        ? []
        : await input.executor.users.findMany({
            where: whereAnd([{ email: normalizedEmail }, { id: { not: existingUser.id } }, { deletedAt: null }]),
            take: 1,
            select: {
              id: true,
            },
          });

    const [updatedUser] = await mapRow({
      value: input.executor.users.updateManyAndReturn({
        where: { id: existingUser.id },
        data: {
          email: conflictingEmailUser ? existingUser.email : normalizedEmail,
          displayName,
          avatarUrl: avatarUrl ?? existingUser.avatarUrl,
          source: "auth",
        },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
          plan: readStringUnion({
            values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
            value: row.plan,
          }),
        })),
    });

    return updatedUser;
  }

  const insertedUser = await mapRow({
    value: input.executor.users.create({
      data: {
        email: normalizedEmail,
        displayName,
        avatarUrl,
        source: "auth",
      },
    }),
    map: (row) => ({
      ...row,
      source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
      plan: readStringUnion({
        values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
        value: row.plan,
      }),
    }),
  });

  return insertedUser;
};
const rowsHoist280 = `
                                    SELECT "users"."id" AS "user__id",
                                    "users"."email" AS "user__email",
                                    "users"."display_name" AS "user__displayName",
                                    "users"."created_at" AS "user__createdAt",
                                    "users"."avatar_url" AS "user__avatarUrl",
                                    "users"."source" AS "user__source",
                                    "users"."plan" AS "user__plan",
                                    "users"."has_completed_first_meeting" AS "hasCompletedFirstMeeting",
                                    "users"."session_version" AS "user__sessionVersion",
                                    "users"."deleted_at" AS "user__deletedAt",
                                    "users"."agent_intro_completed_at" AS "user__agentIntroCompletedAt",
                                    "users"."last_seen_at" AS "user__lastSeenAt",
                                    "users"."active_workspace_id" AS "user__activeWorkspaceId",
                                    "users"."private_beta_pro_enabled_at" AS "user__privateBetaProEnabledAt",
                                    "users"."deletion_requested_at" AS "user__deletionRequestedAt",
                                    "user_auth_accounts"."metadata" AS "metadata"
                                    FROM "user_auth_accounts"
                                    INNER JOIN "users" ON `;

const loadLockedAuthProviderMatch = async (args: {
  tx: AccountTransaction;
  provider: "google" | "microsoft-entra-id";
  providerAccountId: string;
}) => {
  const { tx, provider, providerAccountId } = args;
  const where1 = sqlAnd([
    sqlCompare({ columnSql: '"user_auth_accounts"."provider"', operator: "=", value: provider, cast: null }),
    sqlCompare({
      columnSql: '"user_auth_accounts"."provider_account_id"',
      operator: "=",
      value: providerAccountId,
      cast: null,
    }),
    sqlIsNull({ columnSql: '"users"."deleted_at"', isNegated: false }),
  ]);
  const join10 = sqlColCompare({
    leftSql: '"users"."id"',
    operator: "=",
    rightSql: '"user_auth_accounts"."user_id"',
  });
  const rows = await tx.$queryRaw<
    {
      user__id: string;
      user__email: string;
      user__displayName: string;
      user__createdAt: Date;
      user__avatarUrl: string | null;
      user__source: "auth" | "dev_login" | "debug_import" | "guest";
      user__plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
      hasCompletedFirstMeeting: boolean;
      user__sessionVersion: number;
      user__deletedAt: Date | null;
      user__agentIntroCompletedAt: Date | null;
      user__lastSeenAt: Date | null;
      user__activeWorkspaceId: string | null;
      user__privateBetaProEnabledAt: Date | null;
      user__deletionRequestedAt: Date | null;
      metadata: Record<string, unknown>;
    }[]
  >`${Prisma.raw(rowsHoist280)}${join10}
                                    ${sqlWhereClause(where1)}


                                    ${sqlLimit(1)}

                                    FOR UPDATE
                                    `;

  return rows.map((row) => ({
    metadata: row.metadata,
    user: {
      id: row.user__id,
      email: row.user__email,
      displayName: row.user__displayName,
      createdAt: row.user__createdAt,
      avatarUrl: row.user__avatarUrl,
      source: row.user__source,
      plan: row.user__plan,
      hasCompletedFirstMeeting: row.hasCompletedFirstMeeting,
      sessionVersion: row.user__sessionVersion,
      deletedAt: row.user__deletedAt,
      agentIntroCompletedAt: row.user__agentIntroCompletedAt,
      lastSeenAt: row.user__lastSeenAt,
      activeWorkspaceId: row.user__activeWorkspaceId,
      privateBetaProEnabledAt: row.user__privateBetaProEnabledAt,
      deletionRequestedAt: row.user__deletionRequestedAt,
    },
  }));
};

/**
 * Finds the account already linked to this provider subject. Provider subjects
 * are authoritative: an email collision never authorizes linking, so an email
 * held by another account is a conflict.
 */
const findAuthenticatedProviderMatch = async (input: {
  tx: AccountTransaction;
  provider: "google" | "microsoft-entra-id";
  providerAccountId: string;
  normalizedEmail: string;
}) => {
  const { tx, providerAccountId, normalizedEmail } = input;
  const findProviderMatch = async () =>
    mapRow({
      value: loadLockedAuthProviderMatch({ tx, provider: input.provider, providerAccountId }),
      map: (rows) => rows[0],
    });

  const firstProviderMatch = await findProviderMatch();
  const [emailMatch] = firstProviderMatch
    ? []
    : await tx.users.findMany({
        where: whereAnd([{ email: normalizedEmail }, { deletedAt: null }]),
        select: { id: true },
        take: 1,
      });

  // A concurrent first sign-in with this same provider subject can commit
  // between the two reads above, so the email row may be that sign-in's
  // new account. Each read sees the latest commits, so look again before
  // calling it a conflict.
  const providerMatch = emailMatch === undefined ? firstProviderMatch : await findProviderMatch();
  if (emailMatch !== undefined && providerMatch?.user.id !== emailMatch.id) {
    throw new AuthenticationIdentityConflictError();
  }

  return providerMatch;
};

const resolveAuthenticatedUser = async (args: {
  input: {
    acquisition?: Acquisition;
    provider: "google" | "microsoft-entra-id";
    providerAccountId: string;
    email: string;
    displayName: string;
    avatarUrl?: string | null;
    metadata?: Record<string, unknown>;
  };
  providerAccountId: string;
  normalizedEmail: string;
  displayName: string;
  avatarUrl: string | null;
}) => {
  const { input, providerAccountId, normalizedEmail, displayName, avatarUrl } = args;

  return withAccountMutation({
    userIds: [],
    run: async (tx) => {
      const providerMatch = await findAuthenticatedProviderMatch({
        tx,
        provider: input.provider,
        providerAccountId,
        normalizedEmail,
      });
      const existingUser = providerMatch?.user ?? null;
      const isAccountCreated = !existingUser;
      const user = await insertOrUpdateAuthenticatedUser({
        executor: tx,
        existingUser,
        normalizedEmail,
        displayName,
        avatarUrl,
      });

      if (!user) {
        throw new Error(FAILED_TO_UPSERT_AUTHENTICATED_USER_MESSAGE);
      }

      const priorMetadata = providerMatch?.metadata ?? {};
      const authenticationMetadata = {
        ...priorMetadata,
        ...(input.metadata ?? {}),
        firstLinkedVia: priorMetadata.firstLinkedVia ?? input.metadata?.via ?? "oauth",
        accountCreatedOnFirstLink: priorMetadata.accountCreatedOnFirstLink ?? isAccountCreated,
      };

      await saveUserAuthAccount({
        executor: tx,
        userId: user.id,
        provider: input.provider,
        providerAccountId,
        metadata: authenticationMetadata,
      });

      return { user, isAccountCreated };
    },
  });
};

const upsertUserFromAuthenticationWithin = async (args: {
  input: {
    acquisition?: Acquisition;
    provider: "google" | "microsoft-entra-id";
    providerAccountId: string;
    email: string;
    displayName: string;
    avatarUrl?: string | null;
    metadata?: Record<string, unknown>;
  };
  providerAccountId: string;
  normalizedEmail: string;
  displayName: string;
  avatarUrl: string | null;
}) => {
  const { input } = args;

  const { user, isAccountCreated } = await resolveAuthenticatedUser(args);
  const workspaceId = await ensureDefaultWorkspaceForUserInTransaction({
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  });

  if (isAccountCreated && input.acquisition) {
    await createIgnoringUniqueConflict(() =>
      db.userAcquisition.create({
        data: {
          userId: user.id,
          workspaceId,
          attribution: jsonInput(input.acquisition),
        },
      }),
    );
  }

  return {
    user: toUserWithWorkspace({ user, workspaceId }),
    /** @external existing wire contract */ accountCreated: isAccountCreated,
  };
};

export async function upsertUserFromAuthentication(input: {
  acquisition?: Acquisition;
  provider: "google" | "microsoft-entra-id";
  providerAccountId: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown>;
}): UpsertUserFromAuthenticationResult {
  const providerAccountId = input.providerAccountId.trim();
  const normalizedEmail = input.email.trim().toLowerCase();
  const trimmedDisplayName = input.displayName.trim();
  const emailLocalPart = normalizedEmail.split("@")[0] ?? "";
  const displayName =
    trimmedDisplayName !== "" ? trimmedDisplayName : emailLocalPart !== "" ? emailLocalPart : normalizedEmail;
  const trimmedAvatarUrl = input.avatarUrl?.trim() ?? "";
  const avatarUrl = trimmedAvatarUrl !== "" ? trimmedAvatarUrl : null;
  if (providerAccountId === "") {
    throw new Error(PROVIDER_ACCOUNT_ID_IS_REQUIRED_MESSAGE);
  }
  if (normalizedEmail === "") {
    throw new Error(EMAIL_IS_REQUIRED_MESSAGE);
  }

  return withUniqueViolationRetry({
    run: () =>
      upsertUserFromAuthenticationWithin({ input, providerAccountId, normalizedEmail, displayName, avatarUrl }),
  });
}

type CreateGuestUserResult = Promise<{
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  source: "guest" | "auth" | "dev_login" | "debug_import";
  plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
  privateBetaProEnabledAt: Date | null;
  hasCompletedFirstMeeting: boolean;
  lastSeenAt: Date | null;
  activeWorkspaceId: string | null;
  agentIntroCompletedAt: Date | null;
  sessionVersion: number;
  deletedAt: Date | null;
  createdAt: Date;
}>;

export async function createGuestUser(input: { displayName: string }): CreateGuestUserResult {
  const trimmedGuestName = input.displayName.trim().slice(0, GUEST_DISPLAY_NAME_MAX_LENGTH);
  const displayName = trimmedGuestName !== "" ? trimmedGuestName : "Guest";
  const user = await mapRow({
    value: db.users.create({
      data: {
        email: `guest+${randomUUID()}@guest.readymeet.local`,
        displayName,
        avatarUrl: null,
        source: "guest",
        plan: "free",
      },
    }),
    map: (row) => ({
      ...row,
      source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
      plan: readStringUnion({
        values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
        value: row.plan,
      }),
    }),
  });

  return user;
}

export async function listUserProfilesByEmails(
  emails: string[],
): Promise<{ id: string; email: string; displayName: string; avatarUrl: string | null }[]> {
  const normalizedEmails = Array.from(new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  if (normalizedEmails.length === 0) {
    return [];
  }

  return db.users.findMany({
    where: { email: { in: normalizedEmails } },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
    },
  });
}

type GetUserByIdResult = Promise<
  | ({
      id: string;
      email: string;
      displayName: string;
      avatarUrl: string | null;
      source: "guest" | "auth" | "dev_login" | "debug_import";
      plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
      privateBetaProEnabledAt: Date | null;
      hasCompletedFirstMeeting: boolean;
      lastSeenAt: Date | null;
      activeWorkspaceId: string | null;
      agentIntroCompletedAt: Date | null;
      sessionVersion: number;
      deletedAt: Date | null;
      createdAt: Date;
    } & { workspaceId: string })
  | null
>;

export async function getUserById(userId: string): GetUserByIdResult {
  const user = await mapRow({
    value: db.users.findFirst({
      where: { id: userId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
            plan: readStringUnion({
              values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
              value: row.plan,
            }),
          },
  });
  if (!user) {
    return null;
  }
  const workspaceId = await ensureDefaultWorkspaceForUser({
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  });

  return toUserWithWorkspace({ user, workspaceId });
}

export async function getUserPlan(userId: string): Promise<UserPlan | null> {
  const user = await mapRow({
    value: db.users.findFirst({
      where: { id: userId },
      take: 1,
      select: {
        plan: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            plan: readStringUnion({
              values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
              value: row.plan,
            }),
          },
  });

  return user?.plan ?? null;
}

type GetUserAuthStateResult = Promise<{
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  source: "guest" | "auth" | "dev_login" | "debug_import";
  plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
  agentIntroCompletedAt: Date | null;
  sessionVersion: number;
  activeWorkspaceId: string | null;
  deletedAt: Date | null;
} | null>;

export async function getUserAuthState(userId: string): GetUserAuthStateResult {
  const user = await mapRow({
    value: db.users.findFirst({
      where: { id: userId },
      take: 1,
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        source: true,
        plan: true,
        agentIntroCompletedAt: true,
        sessionVersion: true,
        activeWorkspaceId: true,
        deletedAt: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
            plan: readStringUnion({
              values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
              value: row.plan,
            }),
          },
  });

  return user ?? null;
}

type UpdateUserProfileResult = Promise<
  | ({
      id: string;
      email: string;
      displayName: string;
      avatarUrl: string | null;
      source: "guest" | "auth" | "dev_login" | "debug_import";
      plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
      privateBetaProEnabledAt: Date | null;
      hasCompletedFirstMeeting: boolean;
      lastSeenAt: Date | null;
      activeWorkspaceId: string | null;
      agentIntroCompletedAt: Date | null;
      sessionVersion: number;
      deletedAt: Date | null;
      createdAt: Date;
    } & { workspaceId: string })
  | null
>;

export async function updateUserProfile(input: { userId: string; displayName: string }): UpdateUserProfileResult {
  const [updated] = await db.users.updateManyAndReturn({
    where: whereAnd([{ id: input.userId }, { deletedAt: null }]),
    data: {
      displayName: input.displayName.trim(),
    },
    select: { id: true },
  });

  if (!updated) {
    return null;
  }

  return getUserById(input.userId);
}

export async function incrementUserSessionVersion(
  userId: string,
): Promise<{ id: string; sessionVersion: number } | null> {
  const current = await mapRow({
    value: db.users.findFirst({
      where: { id: userId },
      take: 1,
      select: {
        id: true,
        sessionVersion: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (current === undefined) {
    return null;
  }
  const [user] = await db.users.updateManyAndReturn({
    where: { id: userId },
    data: {
      sessionVersion: current.sessionVersion + 1,
    },
    select: { id: true, sessionVersion: true },
  });

  return user ?? null;
}

export async function anonymizeUserAccount(
  userId: string,
): Promise<{ id: string; email: string; displayName: string; sessionVersion: number; deletedAt: Date | null } | null> {
  await db.userAuthAccounts.deleteMany({
    where: { userId },
  });
  const current = await mapRow({
    value: db.users.findFirst({
      where: { id: userId },
      take: 1,
      select: {
        sessionVersion: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (current === undefined) {
    return null;
  }

  const [user] = await db.users.updateManyAndReturn({
    where: { id: userId },
    data: {
      email: `deleted+${userId}@ready.local`,
      displayName: "Deleted Ready user",
      avatarUrl: null,
      sessionVersion: current.sessionVersion + 1,
      deletedAt: new Date(),
    },
    select: { id: true, email: true, displayName: true, sessionVersion: true, deletedAt: true },
  });

  return user ?? null;
}

export async function updateUserPlan(input: {
  userId: string;
  plan: UserPlan;
  /** @external existing wire contract */ privateBetaProEnabled?: boolean;
}): Promise<{ id: string; plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise" } | null> {
  const values: {
    plan: UserPlan;
    privateBetaProEnabledAt?: Date | null;
  } = { plan: input.plan };
  if (input.privateBetaProEnabled !== undefined) {
    values.privateBetaProEnabledAt = input.privateBetaProEnabled ? new Date() : null;
  }

  const [user] = await mapRow({
    value: db.users.updateManyAndReturn({
      where: { id: input.userId },
      data: values,
      select: { id: true, plan: true },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        plan: readStringUnion({
          values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
          value: row.plan,
        }),
      })),
  });

  return user ?? null;
}

export async function updateUserPlanByAdmin(input: {
  actorUserId: string;
  targetUserId: string;
  plan: UserPlan;
}): Promise<{ id: string; plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise" } | null> {
  return (async () => {
    const current = await mapRow({
      value: db.users.findFirst({
        where: { id: input.targetUserId },
        take: 1,
        select: {
          id: true,
          plan: true,
        },
      }),
      map: (row) =>
        row === null
          ? undefined
          : {
              ...row,
              plan: readStringUnion({
                values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
                value: row.plan,
              }),
            },
    });
    if (!current) {
      return null;
    }

    const [updated] = await mapRow({
      value: db.users.updateManyAndReturn({
        where: { id: input.targetUserId },
        data: {
          plan: input.plan,
          privateBetaProEnabledAt: input.plan === "free" ? null : new Date(),
        },
        select: { id: true, plan: true },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          plan: readStringUnion({
            values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
            value: row.plan,
          }),
        })),
    });
    await mapRow({
      value: db.adminUserPlanChanges.create({
        data: {
          actorUserId: input.actorUserId,
          targetUserId: input.targetUserId,
          previousPlan: current.plan,
          nextPlan: input.plan,
          source: "admin_manual",
        },
      }),
      map: (row) => ({
        ...row,
        previousPlan: readStringUnion({
          values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
          value: row.previousPlan,
        }),
        nextPlan: readStringUnion({
          values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
          value: row.nextPlan,
        }),
      }),
    });

    return updated ?? null;
  })();
}

export async function resetUserOnboardingDebugState(userId: string): Promise<{ hiddenEndedMeetingCount: number }> {
  const attended = await db.meetingParticipants.findMany({
    where: { userId },
    select: {
      meetingId: true,
    },
  });
  const meetingIds = [...new Set(attended.map((row) => row.meetingId))];
  const endedMeetings =
    meetingIds.length === 0
      ? []
      : await db.meetings.findMany({
          where: whereAnd([{ id: { in: meetingIds } }, { status: "ended" }, { hiddenFromHistoryAt: null }]),
          select: {
            id: true,
          },
        });
  if (endedMeetings.length !== 0) {
    await db.meetings.updateMany({
      where: { id: { in: endedMeetings.map((row) => row.id) } },
      data: {
        hiddenFromHistoryAt: new Date(),
        hiddenFromHistoryReason: "debug_onboarding_reset",
      },
    });
  }
  const hiddenRows = { rows: endedMeetings, rowCount: endedMeetings.length };

  await db.users.updateMany({
    where: { id: userId },
    data: {
      hasCompletedFirstMeeting: false,
      agentIntroCompletedAt: null,
    },
  });

  return {
    hiddenEndedMeetingCount: hiddenRows.rowCount,
  };
}

export async function upsertPrivateBetaWaitlistEntry(input: {
  userId: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; userId: string; metadata: Record<string, unknown>; updatedAt: Date; requestedAt: Date }> {
  const entry = await mapRow({
    value: (async () => {
      const data = {
        userId: input.userId,
        metadata: jsonInput(input.metadata ?? {}),
      };

      return db.privateBetaWaitlistEntries.upsert({
        where: { userId: data.userId },
        create: data,
        update: {
          updatedAt: new Date(),
          metadata: jsonInput(input.metadata ?? {}),
        },
      });
    })(),
    map: (row) => ({ ...row, metadata: readJsonObject(row.metadata) }),
  });

  return entry;
}

export async function getPrivateBetaWaitlistEntryForUser(userId: string): Promise<{
  id: string;
  userId: string;
  requestedAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
} | null> {
  const entry = await mapRow({
    value: db.privateBetaWaitlistEntries.findFirst({
      where: { userId },
      take: 1,
    }),
    map: (row) => (row === null ? undefined : { ...row, metadata: readJsonObject(row.metadata) }),
  });

  return entry ?? null;
}

type CreateDataDeletionRequestResult = Promise<{
  status: string;
  error: Record<string, unknown> | null;
  id: string;
  userId: string | null;
  updatedAt: Date;
  requestedAt: Date;
  targetKind: string;
  targetProvider: string | null;
  targetAccountId: string | null;
  providerRevocationStatus: Record<string, unknown>;
  calendarDeletedAt: Date | null;
  attachmentsDeletedAt: Date | null;
  completedAt: Date | null;
}>;

export async function createDataDeletionRequest(input: {
  userId: string;
  targetKind: string;
  targetProvider?: string | null;
  targetAccountId?: string | null;
}): CreateDataDeletionRequestResult {
  const row = await mapRow({
    value: db.dataDeletionRequests.create({
      data: {
        userId: input.userId,
        targetKind: input.targetKind,
        targetProvider: input.targetProvider ?? null,
        targetAccountId: input.targetAccountId ?? null,
        status: "running",
      },
    }),
    map: (row) => ({
      ...row,
      providerRevocationStatus: readJsonObject(row.providerRevocationStatus),
      error: row.error === null ? null : readJsonObject(row.error),
    }),
  });

  return row;
}

type UpdateDataDeletionRequestResult = Promise<{
  id: string;
  userId: string | null;
  targetKind: string;
  targetProvider: string | null;
  targetAccountId: string | null;
  status: string;
  providerRevocationStatus: Record<string, unknown>;
  error: Record<string, unknown> | null;
  requestedAt: Date;
  calendarDeletedAt: Date | null;
  attachmentsDeletedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
} | null>;

export async function updateDataDeletionRequest(input: {
  id: string;
  status?: "pending" | "running" | "completed" | "failed";
  providerRevocationStatus?: Record<string, unknown>;
  calendarDeletedAt?: Date | null;
  attachmentsDeletedAt?: Date | null;
  completedAt?: Date | null;
  error?: Record<string, unknown> | null;
}): UpdateDataDeletionRequestResult {
  const update: Partial<Prisma.dataDeletionRequestsUncheckedUpdateInput> = {
    updatedAt: new Date(),
  };
  if (input.status !== undefined) {
    update.status = input.status;
  }
  if (input.providerRevocationStatus !== undefined) {
    update.providerRevocationStatus = jsonInput(input.providerRevocationStatus);
  }
  if (input.calendarDeletedAt !== undefined) {
    update.calendarDeletedAt = input.calendarDeletedAt;
  }
  if (input.attachmentsDeletedAt !== undefined) {
    update.attachmentsDeletedAt = input.attachmentsDeletedAt;
  }
  if (input.completedAt !== undefined) {
    update.completedAt = input.completedAt;
  }
  if (input.error !== undefined) {
    update.error = input.error === null ? Prisma.DbNull : jsonInput(input.error);
  }

  const [row] = await mapRow({
    value: db.dataDeletionRequests.updateManyAndReturn({
      where: { id: input.id },
      data: update,
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        providerRevocationStatus: readJsonObject(row.providerRevocationStatus),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });

  return row ?? null;
}

type RecordUserAuthenticationResult = Promise<{
  id: string;
  createdAt: Date;
  userId: string;
  provider: string;
  providerAccountId: string | null;
  firstAuthenticatedAt: Date;
  lastAuthenticatedAt: Date;
  authCount: number;
  metadata: Record<string, unknown>;
  updatedAt: Date;
} | null>;

export async function recordUserAuthentication(input: {
  userId: string;
  provider: "google" | "microsoft-entra-id";
  providerAccountId?: string | null;
  metadata?: Record<string, unknown>;
}): RecordUserAuthenticationResult {
  const providerAccountId = trimmedOrNull(input.providerAccountId);
  const metadata = input.metadata ?? {};

  return (
    (await saveUserAuthAccount({
      userId: input.userId,
      provider: input.provider,
      providerAccountId,
      metadata,
    })) ?? null
  );
}

type RecordUsageEventResult = Promise<{
  id: string;
  source: string;
  createdAt: Date;
  userId: string;
  provider: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string | null;
  meetingId: string | null;
  model: string | null;
  category: string;
  occurredAt: Date;
  workflowRunId: string | null;
  jobId: string | null;
  sku: string | null;
  unitCount: number;
  unitType: string;
  unitPriceMicroUsd: number | null;
  costMicroUsd: number;
} | null>;

export async function recordUsageEvent(input: {
  userId: string;
  meetingId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  provider: string;
  category: string;
  model?: string | null;
  sku?: string | null;
  unitCount: number;
  unitType: string;
  unitPriceMicroUsd?: number | null;
  costMicroUsd: number;
  source: string;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date | null;
}): RecordUsageEventResult {
  const event = await mapRow({
    value: createIgnoringUniqueConflict(() =>
      db.usageEvents.create({
        data: {
          userId: input.userId,
          meetingId: input.meetingId ?? null,
          jobId: input.jobId ?? null,
          workflowRunId: input.workflowRunId ?? null,
          provider: input.provider,
          category: input.category,
          model: input.model ?? null,
          sku: input.sku ?? null,
          unitCount: Math.max(0, Math.round(input.unitCount)),
          unitType: input.unitType,
          unitPriceMicroUsd: input.unitPriceMicroUsd ?? null,
          costMicroUsd: Math.max(0, Math.round(input.costMicroUsd)),
          source: input.source,
          idempotencyKey: input.idempotencyKey ?? null,
          metadata: jsonInput(input.metadata ?? {}),
          occurredAt: input.occurredAt ?? new Date(),
        },
      }),
    ),
    map: (row) => (row === undefined ? undefined : { ...row, metadata: readJsonObject(row.metadata) }),
  });

  return event ?? null;
}

const DEFAULT_PRICE_PER_CREDIT_MICRO_USD = 100_000;
const DEFAULT_INCLUDED_CREDIT_ACTION_TYPES = ["meeting_snapshot"] satisfies AiCreditActionType[];
const DEFAULT_ACTION_MINIMUM_CREDITS: Partial<Record<AiCreditActionType, number>> = {
  meeting_summary: SMALL_ACTION_MINIMUM_CREDITS,
  meeting_action_items: SMALL_ACTION_MINIMUM_CREDITS,
  meeting_ask: 1,
  coaching_feedback: COACHING_FEEDBACK_MINIMUM_CREDITS,
  linear_issue_drafting: LINEAR_ISSUE_DRAFTING_MINIMUM_CREDITS,
  followup_email_draft: SMALL_ACTION_MINIMUM_CREDITS,
  deep_meeting_analysis: LARGE_ACTION_MINIMUM_CREDITS,
  mail_surface_classification: 0,
  mail_thread_summary: 0,
  meeting_prep: 1,
  meeting_brief: 0,
  slack_delivery: 1,
  agent_workflow: LARGE_ACTION_MINIMUM_CREDITS,
};

type AiCreditUsageAggregate = {
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCallCount: number;
  actualCostMicroUsd: number;
  metadata: Record<string, unknown>;
};

function coercePositiveInteger(input: { value: unknown; fallback: number }) {
  return typeof input.value === "number" && Number.isFinite(input.value) && input.value > 0
    ? Math.round(input.value)
    : input.fallback;
}

function coerceNonnegativeInteger(input: { value: unknown; fallback?: number }) {
  const fallback = input.fallback ?? 0;

  return typeof input.value === "number" && Number.isFinite(input.value) && input.value >= 0
    ? Math.round(input.value)
    : fallback;
}

function coerceNonnegativeNumber(input: { value: unknown; fallback: number }) {
  return typeof input.value === "number" && Number.isFinite(input.value) && input.value >= 0
    ? input.value
    : input.fallback;
}

function isKnownCreditActionType(value: string): value is AiCreditActionType {
  return readStringArray(aiCreditActionTypeValues).includes(value);
}

function normalizeCreditActionType(value: string): AiCreditActionType {
  return isKnownCreditActionType(value) ? value : "agent_workflow";
}

function grossMarginFromMicroUsd(input: { revenueMicroUsd: number; profitMicroUsd: number }) {
  return input.revenueMicroUsd > 0 ? input.profitMicroUsd / input.revenueMicroUsd : null;
}

export function calculateCreditsForAiUsage(input: {
  actualCostMicroUsd?: number | null;
  pricePerCreditMicroUsd?: number | null;
  markupMultiplier?: number | null;
  minimumCredits?: number | null;
  isIncluded?: boolean | null;
}): number {
  if (input.isIncluded === true) {
    return 0;
  }

  const pricePerCreditMicroUsd = coercePositiveInteger({
    value: input.pricePerCreditMicroUsd,
    fallback: DEFAULT_PRICE_PER_CREDIT_MICRO_USD,
  });
  const actualCostMicroUsd = coerceNonnegativeInteger({ value: input.actualCostMicroUsd });
  const markupMultiplier = coerceNonnegativeNumber({
    value: input.markupMultiplier,
    fallback: 0,
  });
  const minimumCredits = coerceNonnegativeInteger({ value: input.minimumCredits, fallback: 1 });
  const calculatedCredits = Math.ceil((actualCostMicroUsd * markupMultiplier) / pricePerCreditMicroUsd);

  return Math.max(minimumCredits, calculatedCredits);
}

async function getActiveAiCreditPricingConfig() {
  const config = await mapRow({
    value: db.aiCreditPricingConfig.findFirst({
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            targetMarkupMultiplier: decimalToString({ value: row.targetMarkupMultiplier, scale: DECIMAL_SCALE }),
            includedActionTypes: readStringArray(row.includedActionTypes),
            actionMinimumCredits: z.record(z.string(), z.number()).parse(row.actionMinimumCredits),
            metadata: readJsonObject(row.metadata),
          },
  });

  return {
    pricePerCreditMicroUsd: coercePositiveInteger({
      value: config?.pricePerCreditMicroUsd,
      fallback: DEFAULT_PRICE_PER_CREDIT_MICRO_USD,
    }),
    markupMultiplier: 0,
    includedActionTypes: Array.isArray(config?.includedActionTypes)
      ? config.includedActionTypes.filter(isKnownCreditActionType)
      : DEFAULT_INCLUDED_CREDIT_ACTION_TYPES,
    actionMinimumCredits:
      config?.actionMinimumCredits && typeof config.actionMinimumCredits === "object"
        ? config.actionMinimumCredits
        : DEFAULT_ACTION_MINIMUM_CREDITS,
  };
}

function getActionMinimumCredits(input: {
  actionType: AiCreditActionType;
  actionMinimumCredits: Record<string, number> | Partial<Record<AiCreditActionType, number>>;
}) {
  const configured = input.actionMinimumCredits[input.actionType];

  return coerceNonnegativeInteger({
    value: configured,
    fallback: DEFAULT_ACTION_MINIMUM_CREDITS[input.actionType] ?? 1,
  });
}

const metadataNumber = (input: { metadata: Record<string, unknown>; key: string }): number => {
  const value = input.metadata[input.key];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const metadataRateMissing = (metadata: Record<string, unknown>): boolean => {
  const value = metadata.rateConfigured;
  if (typeof value === "boolean") {
    return !value;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "false";
  }

  return false;
};

const uniqueText = (values: (string | null)[]): string[] => [
  ...new Set(values.filter((value): value is string => value !== null && value !== "")),
];

export async function summarizeUsageEventsForCredit(input: {
  userId: string;
  meetingId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  sources?: string[];
  occurredAfter?: Date | null;
}): Promise<AiCreditUsageAggregate> {
  const rows = await mapRow({
    value: db.usageEvents.findMany({
      where: whereAnd([
        { userId: input.userId },
        hasText(input.meetingId) ? { meetingId: input.meetingId } : undefined,
        hasText(input.jobId) ? { jobId: input.jobId } : undefined,
        hasText(input.workflowRunId) ? { workflowRunId: input.workflowRunId } : undefined,
        input.sources !== undefined && input.sources.length !== 0 ? { source: { in: input.sources } } : undefined,
        input.occurredAfter !== undefined && input.occurredAfter !== null
          ? { occurredAt: { gte: input.occurredAfter } }
          : undefined,
      ]),
      select: {
        provider: true,
        model: true,
        sku: true,
        source: true,
        metadata: true,
        costMicroUsd: true,
      },
    }),
    map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
  });
  const providers = uniqueText(rows.map((row) => row.provider));
  const models = uniqueText(rows.map((row) => row.model ?? row.sku));
  const sources = uniqueText(rows.map((row) => row.source));
  const total = (key: string) => rows.reduce((sum, row) => sum + metadataNumber({ metadata: row.metadata, key }), 0);

  return {
    provider: providers.length === 1 ? (providers[0] ?? null) : providers.length > 1 ? "mixed" : null,
    model: models.length === 1 ? (models[0] ?? null) : models.length > 1 ? "mixed" : null,
    inputTokens: coerceNonnegativeInteger({ value: total("inputTokens") }),
    outputTokens: coerceNonnegativeInteger({ value: total("outputTokens") }),
    cachedInputTokens: coerceNonnegativeInteger({ value: total("cachedInputTokens") }),
    toolCallCount: coerceNonnegativeInteger({ value: total("toolCallCount") }),
    actualCostMicroUsd: coerceNonnegativeInteger({
      value: rows.reduce((sum, row) => sum + row.costMicroUsd, 0),
    }),
    metadata: {
      rawUsageEventCount: rows.length,
      unpricedCallCount: rows.filter((row) => metadataRateMissing(row.metadata)).length,
      providers,
      models,
      sources,
    },
  };
}

type RecordAiCreditUsageEventResult = Promise<{
  id: string;
  createdAt: Date;
  userId: string;
  provider: string | null;
  metadata: Record<string, unknown>;
  workspaceId: string | null;
  idempotencyKey: string | null;
  meetingId: string | null;
  model: string | null;
  /** @external existing wire contract */ included: boolean;
  workflowRunId: string | null;
  jobId: string | null;
  pricePerCreditMicroUsd: number;
  actionType: string;
  actionLabel: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCallCount: number;
  actualCostMicroUsd: number;
  markupMultiplier: string;
  minimumCredits: number;
  creditsCharged: number;
  revenueMicroUsd: number;
  profitMicroUsd: number;
} | null>;

type RecordAiCreditUsageEventWithinArgs = {
  input: {
    userId: string;
    /**
     * The workspace the usage belongs to. Paid charges are settled by plan
     * reservations, not by this insert.
     */
    workspaceId?: string | null;
    meetingId?: string | null;
    jobId?: string | null;
    workflowRunId?: string | null;
    actionType: string;
    actionLabel: string;
    provider?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    toolCallCount?: number | null;
    actualCostMicroUsd?: number | null;
    minimumCredits?: number | null;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string | null;
    /** @external existing wire contract */ requireAvailableCredits?: boolean;
  };
  actionType:
    | "meeting_snapshot"
    | "meeting_summary"
    | "meeting_action_items"
    | "meeting_ask"
    | "coaching_feedback"
    | "linear_issue_drafting"
    | "followup_email_draft"
    | "deep_meeting_analysis"
    | "mail_surface_classification"
    | "mail_thread_summary"
    | "meeting_prep"
    | "meeting_brief"
    | "slack_delivery"
    | "agent_workflow";
  actualCostMicroUsd: number;
  pricing: {
    pricePerCreditMicroUsd: number;
    markupMultiplier: number;
    includedActionTypes: (
      | "meeting_snapshot"
      | "meeting_summary"
      | "meeting_action_items"
      | "meeting_ask"
      | "coaching_feedback"
      | "linear_issue_drafting"
      | "followup_email_draft"
      | "deep_meeting_analysis"
      | "mail_surface_classification"
      | "mail_thread_summary"
      | "meeting_prep"
      | "meeting_brief"
      | "slack_delivery"
      | "agent_workflow"
    )[];
    actionMinimumCredits:
      | Record<string, number>
      | Partial<
          Record<
            | "meeting_snapshot"
            | "meeting_summary"
            | "meeting_action_items"
            | "meeting_ask"
            | "coaching_feedback"
            | "linear_issue_drafting"
            | "followup_email_draft"
            | "deep_meeting_analysis"
            | "mail_surface_classification"
            | "mail_thread_summary"
            | "meeting_prep"
            | "meeting_brief"
            | "slack_delivery"
            | "agent_workflow",
            number
          >
        >;
  };
  minimumCredits: number;
  isIncluded: boolean;
  creditsCharged: number;
  revenueMicroUsd: number;
  profitMicroUsd: number;
  hasUnlimitedPrivateBetaCredits: boolean;
};

/** The debit trigger raises SQLSTATE RM402 when a usage row needs credits nobody has. */
async function createAiCreditUsageEventRow(input: { data: Prisma.aiCreditUsageEventsUncheckedCreateInput }) {
  try {
    return await db.aiCreditUsageEvents.create({ data: input.data });
  } catch (error) {
    if (postgresSqlState(error) === INSUFFICIENT_AI_CREDITS_SQLSTATE) {
      throw new InsufficientAiCreditsError({ cause: error });
    }
    throw error;
  }
}

async function insertAiCreditUsageEventWithin(args: RecordAiCreditUsageEventWithinArgs) {
  const {
    input,
    actionType,
    actualCostMicroUsd,
    pricing,
    minimumCredits,
    isIncluded,
    creditsCharged,
    revenueMicroUsd,
    profitMicroUsd,
  } = args;

  const inserted = await mapRow({
    value: createIgnoringUniqueConflict(() =>
      createAiCreditUsageEventRow({
        data: {
          userId: input.userId,
          workspaceId: input.workspaceId ?? null,
          meetingId: input.meetingId ?? null,
          jobId: input.jobId ?? null,
          workflowRunId: input.workflowRunId ?? null,
          actionType,
          actionLabel: input.actionLabel,
          provider: input.provider ?? null,
          model: input.model ?? null,
          inputTokens: coerceNonnegativeInteger({ value: input.inputTokens }),
          outputTokens: coerceNonnegativeInteger({ value: input.outputTokens }),
          cachedInputTokens: coerceNonnegativeInteger({ value: input.cachedInputTokens }),
          toolCallCount: coerceNonnegativeInteger({ value: input.toolCallCount }),
          actualCostMicroUsd,
          pricePerCreditMicroUsd: pricing.pricePerCreditMicroUsd,
          markupMultiplier: String(pricing.markupMultiplier),
          minimumCredits,
          included: isIncluded,
          creditsCharged,
          requireAvailableCredits: input.requireAvailableCredits ?? false,
          revenueMicroUsd,
          profitMicroUsd,
          metadata: jsonInput(input.metadata ?? {}),
          idempotencyKey: input.idempotencyKey ?? null,
        },
      }),
    ),
    map: (row) =>
      row === undefined
        ? undefined
        : {
            ...row,
            actionType: row.actionType,
            markupMultiplier: decimalToString({ value: row.markupMultiplier, scale: DECIMAL_SCALE }),
            metadata: readJsonObject(row.metadata),
          },
  });

  return inserted;
}

const recordAiCreditUsageEventWithin = insertAiCreditUsageEventWithin;
type recordAiCreditUsageEventRow1 = {
  userId: string;
  /**
   * The workspace the usage belongs to. Paid charges are settled by plan
   * reservations, not by this insert.
   */
  workspaceId?: string | null;
  meetingId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  actionType: string;
  actionLabel: string;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  toolCallCount?: number | null;
  actualCostMicroUsd?: number | null;
  minimumCredits?: number | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  /** @external existing wire contract */ requireAvailableCredits?: boolean;
};

export async function recordAiCreditUsageEvent(input: recordAiCreditUsageEventRow1): RecordAiCreditUsageEventResult {
  const actionType = normalizeCreditActionType(input.actionType);
  const pricing = await getActiveAiCreditPricingConfig();
  const isIncluded = pricing.includedActionTypes.includes(actionType);
  const minimumCredits =
    input.minimumCredits ??
    getActionMinimumCredits({
      actionType,
      actionMinimumCredits: pricing.actionMinimumCredits,
    });
  const actualCostMicroUsd = coerceNonnegativeInteger({ value: input.actualCostMicroUsd });
  // Reservations settle paid work. This recorder stores the row without a second debit.
  const creditsCharged = 0;
  const revenueMicroUsd = creditsCharged * pricing.pricePerCreditMicroUsd;
  const profitMicroUsd = revenueMicroUsd - actualCostMicroUsd;
  const hasUnlimitedPrivateBetaCredits = await hasPrivateBetaProCreditEntitlement(input.userId);

  // The INSERT trigger debits grants atomically; conflicts never debit twice.
  const event = await recordAiCreditUsageEventWithin({
    input,
    actionType,
    actualCostMicroUsd,
    pricing,
    minimumCredits,
    isIncluded,
    creditsCharged,
    revenueMicroUsd,
    profitMicroUsd,
    hasUnlimitedPrivateBetaCredits,
  });

  if (event || input.idempotencyKey === undefined || input.idempotencyKey === null || input.idempotencyKey === "") {
    return event ?? null;
  }

  const existing = await mapRow({
    value: db.aiCreditUsageEvents.findFirst({
      where: { idempotencyKey: input.idempotencyKey },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            actionType: row.actionType,
            markupMultiplier: decimalToString({ value: row.markupMultiplier, scale: DECIMAL_SCALE }),
            metadata: readJsonObject(row.metadata),
          },
  });

  return existing ?? null;
}

type EstimateAiCreditUsageEventResult = Promise<{
  actionType:
    | "meeting_snapshot"
    | "meeting_summary"
    | "meeting_action_items"
    | "meeting_ask"
    | "coaching_feedback"
    | "linear_issue_drafting"
    | "followup_email_draft"
    | "deep_meeting_analysis"
    | "mail_surface_classification"
    | "mail_thread_summary"
    | "meeting_prep"
    | "meeting_brief"
    | "slack_delivery"
    | "agent_workflow";
  actualCostMicroUsd: number;
  pricePerCreditMicroUsd: number;
  markupMultiplier: number;
  minimumCredits: number;
  /** @external existing wire contract */ included: boolean;
  creditsCharged: number;
  revenueMicroUsd: number;
}>;

export async function estimateAiCreditUsageEvent(input: {
  actionType: string;
  actualCostMicroUsd?: number | null;
  minimumCredits?: number | null;
}): EstimateAiCreditUsageEventResult {
  const actionType = normalizeCreditActionType(input.actionType);
  const pricing = await getActiveAiCreditPricingConfig();
  const isIncluded = pricing.includedActionTypes.includes(actionType);
  const minimumCredits =
    input.minimumCredits ??
    getActionMinimumCredits({
      actionType,
      actionMinimumCredits: pricing.actionMinimumCredits,
    });
  const actualCostMicroUsd = coerceNonnegativeInteger({ value: input.actualCostMicroUsd });
  // Reservations settle paid work. This recorder stores the row without a second debit.
  const creditsCharged = 0;

  return {
    actionType,
    actualCostMicroUsd,
    pricePerCreditMicroUsd: pricing.pricePerCreditMicroUsd,
    markupMultiplier: pricing.markupMultiplier,
    minimumCredits,
    /** @external existing wire contract */ included: isIncluded,
    creditsCharged,
    revenueMicroUsd: creditsCharged * pricing.pricePerCreditMicroUsd,
  };
}

type RecordAiCreditUsageForScopeResult = Promise<{
  id: string;
  createdAt: Date;
  userId: string;
  provider: string | null;
  metadata: Record<string, unknown>;
  workspaceId: string | null;
  idempotencyKey: string | null;
  meetingId: string | null;
  model: string | null;
  /** @external existing wire contract */ included: boolean;
  workflowRunId: string | null;
  jobId: string | null;
  pricePerCreditMicroUsd: number;
  actionType: string;
  actionLabel: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCallCount: number;
  actualCostMicroUsd: number;
  markupMultiplier: string;
  minimumCredits: number;
  creditsCharged: number;
  revenueMicroUsd: number;
  profitMicroUsd: number;
} | null>;

export async function recordAiCreditUsageForScope(input: {
  userId: string;
  workspaceId?: string | null;
  meetingId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  actionType: string;
  actionLabel: string;
  sources?: string[];
  occurredAfter?: Date | null;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
}): RecordAiCreditUsageForScopeResult {
  const usage = await summarizeUsageEventsForCredit({
    userId: input.userId,
    meetingId: input.meetingId,
    jobId: input.jobId,
    workflowRunId: input.workflowRunId,
    sources: input.sources,
    occurredAfter: input.occurredAfter,
  });

  return recordAiCreditUsageEvent({
    userId: input.userId,
    workspaceId: input.workspaceId,
    meetingId: input.meetingId,
    jobId: input.jobId,
    workflowRunId: input.workflowRunId,
    actionType: input.actionType,
    actionLabel: input.actionLabel,
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    toolCallCount: usage.toolCallCount,
    actualCostMicroUsd: usage.actualCostMicroUsd,
    metadata: {
      ...(input.metadata ?? {}),
      ...usage.metadata,
    },
    idempotencyKey: input.idempotencyKey,
  });
}

export async function hasPrivateBetaProCreditEntitlement(userId: string): Promise<boolean> {
  const user = await mapRow({
    value: db.users.findFirst({
      where: { id: userId },
      take: 1,
      select: {
        plan: true,
        privateBetaProEnabledAt: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            plan: readStringUnion({
              values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
              value: row.plan,
            }),
          },
  });
  if (!user || user.plan === "free" || !user.privateBetaProEnabledAt) {
    return false;
  }

  const subscription = await mapRow({
    value: db.billingSubscriptions.findFirst({
      where: whereAnd([
        { userId },
        // Workspace subscriptions carry their billing-owner admin's userId;
        // only the user's own personal subscription revokes the entitlement.
        { workspaceId: null },
        whereOr([
          { status: { in: ["active", "trialing"] } },
          whereAnd([
            { status: "past_due" },
            { statusChangedAt: { gt: new Date(Date.now() - BILLING_PAST_DUE_GRACE_DAYS * MILLISECONDS_PER_DAY) } },
          ]),
        ]),
        whereOr([{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }]),
      ]),
      take: 1,
      select: {
        id: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  return !subscription;
}

type CreateCreditGrantResult = Promise<{
  id: string;
  source: "subscription_period" | "credit_topup" | "promotional";
  createdAt: Date;
  userId: string | null;
  metadata: Record<string, unknown>;
  updatedAt: Date;
  workspaceId: string | null;
  expiresAt: Date | null;
  credits: number;
  creditsRemaining: number;
  stripeReference: string | null;
} | null>;

export async function createCreditGrant(input: {
  userId: string;
  source: CreditGrantSource;
  credits: number;
  expiresAt?: Date | null;
  stripeReference?: string | null;
  metadata?: Record<string, unknown>;
}): CreateCreditGrantResult {
  const credits = Math.max(0, Math.floor(input.credits));
  if (credits <= 0) {
    return null;
  }

  const grant = await mapRow({
    value: createIgnoringUniqueConflict(() =>
      db.creditGrants.create({
        data: {
          userId: input.userId,
          source: input.source,
          credits,
          creditsRemaining: credits,
          expiresAt: input.expiresAt ?? null,
          stripeReference: input.stripeReference ?? null,
          metadata: jsonInput(input.metadata ?? {}),
        },
      }),
    ),
    map: (row) =>
      row === undefined
        ? undefined
        : {
            ...row,
            source: readStringUnion({
              values: ["subscription_period", "credit_topup", "promotional"],
              value: row.source,
            }),
            metadata: readJsonObject(row.metadata),
          },
  });

  return grant ?? null;
}

export async function getUserCreditBalanceData(userId: string): Promise<{
  balance: number;
  subscriptionCredits: number;
  topupCredits: number;
  promotionalCredits: number;
  nextExpiry: Date | null;
}> {
  const now = new Date();
  const grants = await mapRow({
    value: db.creditGrants.findMany({
      where: whereAnd([
        { userId },
        { creditsRemaining: { gt: 0 } },
        whereOr([{ expiresAt: null }, { expiresAt: { gt: now } }]),
      ]),
      select: {
        source: true,
        creditsRemaining: true,
        expiresAt: true,
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        source: readStringUnion({ values: ["subscription_period", "credit_topup", "promotional"], value: row.source }),
      })),
  });
  const sumSource = (source: string) =>
    grants.filter((grant) => grant.source === source).reduce((sum, grant) => sum + grant.creditsRemaining, 0);
  const nextExpiry = grants
    .flatMap((grant) => (grant.expiresAt === null ? [] : [grant.expiresAt]))
    .toSorted((left, right) => left.getTime() - right.getTime())[0];

  return {
    balance: grants.reduce((sum, grant) => sum + grant.creditsRemaining, 0),
    subscriptionCredits: sumSource("subscription_period"),
    topupCredits: sumSource("credit_topup"),
    promotionalCredits: sumSource("promotional"),
    nextExpiry: nextExpiry ?? null,
  };
}

/**
 * What the viewer can pay for AI outputs with: paid grant credits
 * (subscription allowance or purchased top-ups), current-month plan usage,
 * and the welcome trial. The notes-visibility gate treats these differently:
 * grants and remaining paid-plan allowance unlock everything; the trial only
 * covers a free user's first few hosted meetings.
 */
export async function getUserCreditAccess(
  userId: string,
): Promise<{ hasGrantCredits: boolean; hasTrialCredits: boolean; monthCreditsUsed: number }> {
  const grants = await getUserCreditBalanceData(userId);
  const events = await db.aiCreditUsageEvents.findMany({
    where: { userId },
    select: {
      creditsCharged: true,
      createdAt: true,
    },
  });
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthCreditsUsed = events
    .filter((event) => event.createdAt >= monthStart)
    .reduce((sum, event) => sum + event.creditsCharged, 0);

  return {
    hasGrantCredits: grants.balance > 0,
    hasTrialCredits: true,
    monthCreditsUsed,
  };
}

/** Delivered hosted meetings consume slots permanently, even after deletion. */
export async function countWorkspaceMemberTrialMeetings(input: {
  userId: string;
  workspaceId: string;
}): Promise<number> {
  const rows = await db.meetingTrialSlots.findMany({
    where: whereAnd([{ userId: input.userId }, { workspaceId: input.workspaceId }]),
    select: {
      slot: true,
    },
  });

  return rows.length;
}

/** An allocated meeting remains within its own trial slot as later calls finish. */
export async function countOtherHostedTrialMeetings(input: {
  userId: string;
  meetingId: string;
  workspaceId: string;
}): Promise<number> {
  const rows = await db.meetingTrialSlots.findMany({
    where: whereAnd([{ userId: input.userId }, { workspaceId: input.workspaceId }]),
    select: {
      meetingId: true,
    },
  });

  return rows.filter((row) => row.meetingId !== input.meetingId).length;
}

export async function getBillingCustomerForUser(
  userId: string,
): Promise<{ userId: string; stripeCustomerId: string; createdAt: Date; updatedAt: Date } | null> {
  const customer = await mapRow({
    value: db.billingCustomers.findFirst({
      where: { userId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return customer ?? null;
}
export async function upsertBillingCustomer(input: { userId: string; stripeCustomerId: string }): Promise<
  | {
      createdAt: Date;
      userId: string;
      updatedAt: Date;
      stripeCustomerId: string;
    }
  | undefined
> {
  const customer = await (async () => {
    const data = {
      userId: input.userId,
      stripeCustomerId: input.stripeCustomerId,
    };

    return db.billingCustomers.upsert({
      where: { userId: data.userId },
      create: data,
      update: {
        stripeCustomerId: input.stripeCustomerId,
        updatedAt: new Date(),
      },
    });
  })();

  return customer;
}

export async function getUserIdForStripeCustomer(stripeCustomerId: string): Promise<string | null> {
  const customer = await mapRow({
    value: db.billingCustomers.findFirst({
      where: { stripeCustomerId },
      take: 1,
      select: {
        userId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  return customer?.userId ?? null;
}

type UpsertBillingSubscriptionResult = Promise<
  | {
      status: string;
      id: string;
      createdAt: Date;
      userId: string;
      metadata: Record<string, unknown>;
      updatedAt: Date;
      workspaceId: string | null;
      statusChangedAt: Date;
      stripeSubscriptionId: string;
      stripePriceId: string;
      planInterval: string;
      includedCreditsPerPeriod: number;
      seatQuantity: number;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
      /** @external existing wire contract */ cancelAtPeriodEnd: boolean;
    }
  | undefined
>;

export async function upsertBillingSubscription(input: {
  userId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: string;
  planInterval: string;
  includedCreditsPerPeriod: number;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  /** @external existing wire contract */ cancelAtPeriodEnd?: boolean;
  metadata?: Record<string, unknown>;
}): UpsertBillingSubscriptionResult {
  const values = {
    userId: input.userId,
    stripeSubscriptionId: input.stripeSubscriptionId,
    stripePriceId: input.stripePriceId,
    status: input.status,
    statusChangedAt: new Date(),
    planInterval: input.planInterval,
    includedCreditsPerPeriod: Math.max(0, Math.floor(input.includedCreditsPerPeriod)),
    currentPeriodStart: input.currentPeriodStart ?? null,
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    /** @external existing wire contract */ cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    metadata: jsonInput(input.metadata ?? {}),
  };

  return (async () => {
    if (input.status === "active" || input.status === "trialing") {
      const now = new Date();
      await db.billingSubscriptions.updateMany({
        where: whereAnd([
          { userId: input.userId },
          { workspaceId: null },
          { stripeSubscriptionId: { not: input.stripeSubscriptionId } },
          { status: { in: ["active", "trialing"] } },
          { currentPeriodEnd: { lte: now } },
        ]),
        data: {
          status: "superseded",
          statusChangedAt: now,
          updatedAt: now,
        },
      });
    }

    const existing = await mapRow({
      value: db.billingSubscriptions.findFirst({
        where: { stripeSubscriptionId: input.stripeSubscriptionId },
        take: 1,
        select: {
          status: true,
          statusChangedAt: true,
        },
      }),
      map: (row) => row ?? undefined,
    });
    const [subscription] =
      existing === undefined
        ? await mapRow({
            value: db.billingSubscriptions.create({ data: values }),
            map: (row) => [{ ...row, metadata: readJsonObject(row.metadata) }],
          })
        : await mapRow({
            value: db.billingSubscriptions.updateManyAndReturn({
              where: { stripeSubscriptionId: input.stripeSubscriptionId },
              data: {
                ...values,
                statusChangedAt: existing.status === input.status ? existing.statusChangedAt : new Date(),
                updatedAt: new Date(),
              },
            }),
            map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
          });

    return subscription;
  })();
}

/**
 * The user's own PERSONAL subscription. Workspace subscriptions share this
 * table and carry their billing-owner admin's userId, so every user-scoped
 * read filters them out — otherwise a workspace admin would look personally
 * subscribed (blocking their own checkout, flipping gates) the moment their
 * workspace subscribes.
 */
type GetLatestBillingSubscriptionForUserResult = Promise<{
  id: string;
  userId: string;
  workspaceId: string | null;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: string;
  statusChangedAt: Date;
  planInterval: string;
  includedCreditsPerPeriod: number;
  seatQuantity: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  /** @external existing wire contract */ cancelAtPeriodEnd: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getLatestBillingSubscriptionForUser(userId: string): GetLatestBillingSubscriptionForUserResult {
  const subscription = await mapRow({
    value: db.billingSubscriptions.findFirst({
      where: whereAnd([{ userId }, { workspaceId: null }]),
      orderBy: [{ updatedAt: "desc" }],
      take: 1,
    }),
    map: (row) => (row === null ? undefined : { ...row, metadata: readJsonObject(row.metadata) }),
  });

  return subscription ?? null;
}

/**
 * Personal subscriptions whose paid features are unlocked and whose period is
 * still running. Feeds the subscription credit worker's monthly user grants,
 * so workspace-keyed rows are excluded — their allowance is derived at charge
 * time and minting user grants for the billing-owner admin would hand them
 * free personal credits.
 */
type GetRunningBillingSubscriptionsResult = Promise<
  {
    id: string;
    userId: string;
    workspaceId: string | null;
    stripeSubscriptionId: string;
    stripePriceId: string;
    status: string;
    statusChangedAt: Date;
    planInterval: string;
    includedCreditsPerPeriod: number;
    seatQuantity: number;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    /** @external existing wire contract */ cancelAtPeriodEnd: boolean;
    metadata: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
  }[]
>;

export async function getRunningBillingSubscriptions(): GetRunningBillingSubscriptionsResult {
  return mapRow({
    value: db.billingSubscriptions.findMany({
      where: whereAnd([
        { workspaceId: null },
        whereOr([
          { status: { in: ["active", "trialing"] } },
          whereAnd([
            { status: "past_due" },
            { statusChangedAt: { gt: new Date(Date.now() - BILLING_PAST_DUE_GRACE_DAYS * MILLISECONDS_PER_DAY) } },
          ]),
        ]),
        { currentPeriodEnd: { gt: new Date() } },
      ]),
    }),
    map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
  });
}

export type SlackDeliveryRoutes = Record<string, { channelId: string; channelName: string } | null>;

export async function getSlackDeliveryConfigForUser(userId: string): Promise<{
  userId: string;
  routes: Record<string, { channelId: string; channelName: string } | null>;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const row = await mapRow({
    value: db.slackDeliveryConfigs.findFirst({
      where: { userId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            routes: z
              .record(z.string(), z.object({ channelId: z.string(), channelName: z.string() }).nullable())
              .parse(row.routes),
          },
  });

  return row ?? null;
}

export async function upsertSlackDeliveryConfig(input: { userId: string; routes: SlackDeliveryRoutes }): Promise<
  | {
      createdAt: Date;
      userId: string;
      updatedAt: Date;
      routes: Record<string, { channelId: string; channelName: string } | null>;
    }
  | undefined
> {
  const row = await mapRow({
    value: (async () => {
      const data = {
        userId: input.userId,
        routes: jsonInput(input.routes),
      };

      return db.slackDeliveryConfigs.upsert({
        where: { userId: data.userId },
        create: data,
        update: {
          routes: jsonInput(input.routes),
          updatedAt: new Date(),
        },
      });
    })(),
    map: (row) => ({
      ...row,
      routes: z
        .record(z.string(), z.object({ channelId: z.string(), channelName: z.string() }).nullable())
        .parse(row.routes),
    }),
  });

  return row;
}

type CreateMeetingResult = Promise<{
  status: "scheduled" | "active" | "ended";
  id: string;
  createdAt: Date;
  createdByUserId: string;
  workspaceId: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  kind: MeetingKind;
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
}>;

async function insertInitialMeetingHost(input: { meetingId: string; userId: string }) {
  const confidentialityChange = await db.$transaction(async (tx) => {
    await (async () => {
      const where2 = sqlCompare({ columnSql: '"meetings"."id"', operator: "=", value: input.meetingId, cast: "uuid" });

      return tx.$queryRaw<{ id: string }[]>`
          SELECT "meetings"."id" AS "id"
          FROM "meetings"

          ${sqlWhereClause(where2)}




          FOR UPDATE
          `;
    })();
    await mapRow({
      value: tx.meetingParticipants.create({
        data: {
          ...input,
          role: "host",
          leftAt: new Date(),
        },
      }),
      map: (row) => ({
        ...row,
        role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
      }),
    });

    return autoMarkMeetingConfidentialInTransaction({ meetingId: input.meetingId, connection: tx });
  });
  if (confidentialityChange) {
    await notifyMeetingConfidentialityChanged(confidentialityChange);
  }

  return confidentialityChange
    ? {
        ...confidentialityChange,
        status: readStringUnion({ values: ["scheduled", "active", "ended"], value: confidentialityChange.status }),
        kind: meetingKindSchema.parse(confidentialityChange.kind),
        confidentialitySource: readNullableStringUnion({
          values: ["auto", "manual"],
          value: confidentialityChange.confidentialitySource,
        }),
      }
    : null;
}

export async function createMeeting(input: {
  title: string;
  roomName: string;
  createdByUserId: string;
  workspaceId?: string | null;
  isConfidential?: boolean;
}): CreateMeetingResult {
  const hasWorkspaceId = input.workspaceId !== undefined && input.workspaceId !== null && input.workspaceId !== "";
  const creator = hasWorkspaceId ? null : await getUserById(input.createdByUserId);
  const workspaceId = hasWorkspaceId ? input.workspaceId : creator?.workspaceId;
  if (workspaceId === undefined || workspaceId === null || workspaceId === "") {
    throw new Error(workspaceForUserNotFoundMessage(input.createdByUserId));
  }
  await ensureWorkspaceMembership({
    workspaceId,
    userId: input.createdByUserId,
    role: "admin",
  });

  const meeting = await mapRow({
    value: db.meetings.create({
      data: {
        title: input.title,
        roomName: input.roomName,
        workspaceId,
        createdByUserId: input.createdByUserId,
        status: "scheduled",
        isConfidential: input.isConfidential ?? isMeetingConfidentialByDefault,
        confidentialitySource: input.isConfidential === undefined ? null : "manual",
        confidentialityUpdatedByUserId: input.isConfidential === undefined ? null : input.createdByUserId,
        confidentialityUpdatedAt: input.isConfidential === undefined ? null : new Date(),
      },
    }),
    map: (row) => readStoredMeeting(row),
  });

  const confidentialityChange = await insertInitialMeetingHost({
    meetingId: meeting.id,
    userId: input.createdByUserId,
  });

  return confidentialityChange ?? meeting;
}

function generateInternalLiveKitRoomName() {
  return `ready-${randomUUID()}`;
}

export async function getMeetingLinkByCode(code: string): Promise<{
  id: string;
  code: string;
  workspaceId: string;
  createdByUserId: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const meetingLink = await mapRow({
    value: db.meetingLinks.findFirst({
      where: { code },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return meetingLink ?? null;
}

export async function getMeetingLinkById(...args: [meetingLinkId: string, connection?: DbConnection]): Promise<{
  id: string;
  code: string;
  workspaceId: string;
  createdByUserId: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const [meetingLinkId, connection = db] = args;
  const meetingLink = await mapRow({
    value: connection.meetingLinks.findFirst({
      where: { id: meetingLinkId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return meetingLink ?? null;
}

export async function getMeetingLinkForMeeting(meetingId: string): Promise<{
  id: string;
  code: string;
  workspaceId: string;
  createdByUserId: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const row = await mapRow({
    value: db.meetings.findFirst({
      where: whereAnd([{ id: meetingId }, { meetingLinks: { isNot: null } }]),
      take: 1,
      select: {
        meetingLinks: true,
      },
    }),
    map: (row) => {
      const meetingLink = row?.meetingLinks;
      if (meetingLink === null || meetingLink === undefined) {
        return undefined;
      }

      return { meetingLink };
    },
  });

  return row?.meetingLink ?? null;
}

type GetMeetingLinkCallInResult = Promise<{
  id: string;
  meetingLinkId: string;
  phoneNumber: string;
  pin: string;
  sipDispatchRuleId: string | null;
  dispatchRuleKind: string;
  lastSyncedMeetingId: string | null;
  status: string;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getMeetingLinkCallIn(
  ...args: [meetingLinkId: string, connection?: DbConnection]
): GetMeetingLinkCallInResult {
  const [meetingLinkId, connection = db] = args;
  const callIn = await mapRow({
    value: connection.meetingLinkCallIns.findFirst({
      where: { meetingLinkId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return callIn ?? null;
}

type CreateMeetingLinkCallInResult = Promise<{
  status: string;
  id: string;
  createdAt: Date;
  updatedAt: Date;
  meetingLinkId: string;
  phoneNumber: string;
  pin: string;
  sipDispatchRuleId: string | null;
  dispatchRuleKind: string;
  lastSyncedMeetingId: string | null;
  lastSyncError: string | null;
}>;

export async function createMeetingLinkCallIn(
  ...args: [
    input: {
      meetingLinkId: string;
      phoneNumber: string;
      pin: string;
      sipDispatchRuleId: string;
      dispatchRuleKind: "direct" | "holding";
      lastSyncedMeetingId: string;
    },
    connection?: DbConnection,
  ]
): CreateMeetingLinkCallInResult {
  const [input, connection = db] = args;
  const callIn = await connection.meetingLinkCallIns.create({
    data: {
      meetingLinkId: input.meetingLinkId,
      phoneNumber: input.phoneNumber,
      pin: input.pin,
      sipDispatchRuleId: input.sipDispatchRuleId,
      dispatchRuleKind: input.dispatchRuleKind,
      lastSyncedMeetingId: input.lastSyncedMeetingId,
      status: "active",
      lastSyncError: null,
      updatedAt: new Date(),
    },
  });

  return callIn;
}

type ActivateMeetingLinkCallInResult = Promise<{
  id: string;
  meetingLinkId: string;
  phoneNumber: string;
  pin: string;
  sipDispatchRuleId: string | null;
  dispatchRuleKind: string;
  lastSyncedMeetingId: string | null;
  status: string;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export async function activateMeetingLinkCallIn(
  ...args: [
    input: {
      id: string;
      phoneNumber: string;
      sipDispatchRuleId: string;
      dispatchRuleKind: "direct" | "holding";
      lastSyncedMeetingId: string;
    },
    connection?: DbConnection,
  ]
): ActivateMeetingLinkCallInResult {
  const [input, connection = db] = args;
  const [callIn] = await connection.meetingLinkCallIns.updateManyAndReturn({
    where: { id: input.id },
    data: {
      phoneNumber: input.phoneNumber,
      sipDispatchRuleId: input.sipDispatchRuleId,
      dispatchRuleKind: input.dispatchRuleKind,
      lastSyncedMeetingId: input.lastSyncedMeetingId,
      status: "active",
      lastSyncError: null,
      updatedAt: new Date(),
    },
  });

  if (!callIn) {
    throw new Error(FAILED_TO_ACTIVATE_MEETING_LINK_CALL_IN_MESSAGE);
  }

  return callIn;
}

type MarkMeetingLinkCallInInactiveResult = Promise<{
  id: string;
  meetingLinkId: string;
  phoneNumber: string;
  pin: string;
  sipDispatchRuleId: string | null;
  dispatchRuleKind: string;
  lastSyncedMeetingId: string | null;
  status: string;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export async function markMeetingLinkCallInInactive(
  ...args: [input: { id: string }, connection?: DbConnection]
): MarkMeetingLinkCallInInactiveResult {
  const [input, connection = db] = args;
  const [callIn] = await connection.meetingLinkCallIns.updateManyAndReturn({
    where: { id: input.id },
    data: {
      sipDispatchRuleId: null,
      lastSyncedMeetingId: null,
      status: "inactive",
      lastSyncError: null,
      updatedAt: new Date(),
    },
  });

  if (!callIn) {
    throw new Error(FAILED_TO_MARK_MEETING_LINK_CALL_IN_INACTIVE_MESSAGE);
  }

  return callIn;
}

type MarkMeetingLinkCallInErrorResult = Promise<{
  id: string;
  meetingLinkId: string;
  phoneNumber: string;
  pin: string;
  sipDispatchRuleId: string | null;
  dispatchRuleKind: string;
  lastSyncedMeetingId: string | null;
  status: string;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export async function markMeetingLinkCallInError(
  ...args: [input: { id: string; lastSyncError: string }, connection?: DbConnection]
): MarkMeetingLinkCallInErrorResult {
  const [input, connection = db] = args;
  const [callIn] = await connection.meetingLinkCallIns.updateManyAndReturn({
    where: { id: input.id },
    data: {
      status: "error",
      lastSyncError: input.lastSyncError,
      updatedAt: new Date(),
    },
  });

  if (!callIn) {
    throw new Error(FAILED_TO_MARK_MEETING_LINK_CALL_IN_ERROR_MESSAGE);
  }

  return callIn;
}

type CreateMeetingLinkWithInitialMeetingResult = Promise<{
  meeting: {
    status: "scheduled" | "active" | "ended";
    id: string;
    createdAt: Date;
    createdByUserId: string;
    workspaceId: string;
    title: string;
    roomName: string;
    meetingLinkId: string | null;
    instanceNumber: number;
    kind: MeetingKind;
    isConfidential: boolean;
    confidentialitySource: "auto" | "manual" | null;
    confidentialityUpdatedByUserId: string | null;
    confidentialityUpdatedAt: Date | null;
    startedAt: Date | null;
    endedAt: Date | null;
    hiddenFromHistoryAt: Date | null;
    hiddenFromHistoryReason: string | null;
  };
  meetingLink: {
    code: string;
    status: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    createdByUserId: string;
    workspaceId: string;
    title: string;
  };
}>;

export async function createMeetingLinkWithInitialMeeting(input: {
  title: string;
  code: string;
  createdByUserId: string;
  workspaceId?: string | null;
  kind?: "standard" | "agent_intro";
}): CreateMeetingLinkWithInitialMeetingResult {
  const hasWorkspaceId = input.workspaceId !== undefined && input.workspaceId !== null && input.workspaceId !== "";
  const creator = hasWorkspaceId ? null : await getUserById(input.createdByUserId);
  const workspaceId = hasWorkspaceId ? input.workspaceId : creator?.workspaceId;
  if (workspaceId === undefined || workspaceId === null || workspaceId === "") {
    throw new Error(workspaceForUserNotFoundMessage(input.createdByUserId));
  }
  await ensureWorkspaceMembership({
    workspaceId,
    userId: input.createdByUserId,
    role: "admin",
  });

  return (async () => {
    const meetingLink = await db.meetingLinks.create({
      data: {
        title: input.title,
        code: input.code,
        workspaceId,
        createdByUserId: input.createdByUserId,
        status: "active",
      },
    });

    const meeting = await mapRow({
      value: db.meetings.create({
        data: {
          title: input.title,
          roomName: generateInternalLiveKitRoomName(),
          meetingLinkId: meetingLink.id,
          instanceNumber: 1,
          workspaceId,
          createdByUserId: input.createdByUserId,
          kind: input.kind ?? "standard",
          status: "scheduled",
          isConfidential: isMeetingConfidentialByDefault,
        },
      }),
      map: (row) => readStoredMeeting(row),
    });

    const confidentialityChange = await insertInitialMeetingHost({
      meetingId: meeting.id,
      userId: input.createdByUserId,
    });

    return { meeting: confidentialityChange ?? meeting, meetingLink };
  })();
}

// The historical table/lock names are retained so existing Google retries remain
// compatible. Callers namespace the hashed key by provider; rows are user-scoped.
type CreateOrReuseCalendarAddonConferenceResult = Promise<{
  meeting: {
    id: string;
    title: string;
    roomName: string;
    meetingLinkId: string | null;
    instanceNumber: number;
    workspaceId: string;
    createdByUserId: string;
    kind: MeetingKind;
    status: "scheduled" | "active" | "ended";
    isConfidential: boolean;
    confidentialitySource: "auto" | "manual" | null;
    confidentialityUpdatedByUserId: string | null;
    confidentialityUpdatedAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    endedAt: Date | null;
    hiddenFromHistoryAt: Date | null;
    hiddenFromHistoryReason: string | null;
  } | null;
  meetingLink: {
    id: string;
    code: string;
    workspaceId: string;
    createdByUserId: string;
    title: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  };
  /** @external existing wire contract */ reused: boolean;
}>;

export async function createOrReuseCalendarAddonConference(input: {
  title: string;
  code: string;
  createdByUserId: string;
  workspaceId: string;
  idempotencyKey: string;
  /** @external existing wire contract */ replaceInactive?: boolean;
}): CreateOrReuseCalendarAddonConferenceResult {
  await ensureWorkspaceMembership({
    workspaceId: input.workspaceId,
    userId: input.createdByUserId,
    role: "admin",
  });

  return withUniqueViolationRetry({
    run: () => createCalendarAddonConferenceAttempt(input),
  });
}

async function selectCurrentMeetingForLink(meetingLinkId: string) {
  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: whereAnd([{ meetingLinkId }, { status: { in: ["scheduled", "active"] } }]),
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredMeeting(row)),
  });

  return meeting ?? null;
}

async function loadReusableCalendarAddonConference(input: { userId: string; idempotencyKey: string }) {
  const existing = await mapRow({
    value: db.googleAddonConferences.findFirst({
      where: whereAnd([{ userId: input.userId }, { idempotencyKey: input.idempotencyKey }]),
      take: 1,
      select: {
        meetingLinks: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : ((row) => ({
            meetingLink: row.meetingLinks,
          }))(row),
  });
  if (existing === undefined) {
    return null;
  }
  const meeting = await selectCurrentMeetingForLink(existing.meetingLink.id);

  return {
    meeting,
    meetingLink: existing.meetingLink,
    /** @external existing wire contract */ reused: true as const,
  };
}

async function insertCalendarAddonMeeting(input: {
  title: string;
  code: string;
  workspaceId: string;
  createdByUserId: string;
}) {
  const meetingLink = await db.meetingLinks.create({
    data: {
      title: input.title,
      code: input.code,
      workspaceId: input.workspaceId,
      createdByUserId: input.createdByUserId,
      status: "active",
    },
  });

  const meeting = await mapRow({
    value: db.meetings.create({
      data: {
        title: input.title,
        roomName: generateInternalLiveKitRoomName(),
        meetingLinkId: meetingLink.id,
        instanceNumber: 1,
        workspaceId: input.workspaceId,
        createdByUserId: input.createdByUserId,
        kind: "standard",
        status: "scheduled",
        isConfidential: isMeetingConfidentialByDefault,
      },
    }),
    map: (row) => readStoredMeeting(row),
  });

  const confidentialityChange = await insertInitialMeetingHost({
    meetingId: meeting.id,
    userId: input.createdByUserId,
  });

  return { meeting: confidentialityChange ?? meeting, meetingLink };
}

async function claimCalendarAddonConference(input: {
  userId: string;
  idempotencyKey: string;
  meetingLinkId: string;
  previousMeetingLinkId: string | undefined;
}) {
  if (input.previousMeetingLinkId === undefined) {
    await db.googleAddonConferences.create({
      data: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        meetingLinkId: input.meetingLinkId,
      },
    });

    return true;
  }
  const [claimed] = await db.googleAddonConferences.updateManyAndReturn({
    where: whereAnd([
      { userId: input.userId },
      { idempotencyKey: input.idempotencyKey },
      { meetingLinkId: input.previousMeetingLinkId },
    ]),
    data: {
      meetingLinkId: input.meetingLinkId,
    },
    select: { meetingLinkId: true },
  });

  return claimed !== undefined;
}

async function createCalendarAddonConferenceAttempt(input: {
  title: string;
  code: string;
  createdByUserId: string;
  workspaceId: string;
  idempotencyKey: string;
  /** @external existing wire contract */ replaceInactive?: boolean;
}): CreateOrReuseCalendarAddonConferenceResult {
  const existing = await mapRow({
    value: db.googleAddonConferences.findFirst({
      where: whereAnd([{ userId: input.createdByUserId }, { idempotencyKey: input.idempotencyKey }]),
      take: 1,
      select: {
        meetingLinks: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : ((row) => ({
            meetingLink: row.meetingLinks,
          }))(row),
  });
  if (existing && !(input.replaceInactive === true && existing.meetingLink.status !== "active")) {
    const meeting = await selectCurrentMeetingForLink(existing.meetingLink.id);

    return { meeting, meetingLink: existing.meetingLink, /** @external existing wire contract */ reused: true };
  }
  const { meeting, meetingLink } = await insertCalendarAddonMeeting({
    title: input.title,
    code: input.code,
    workspaceId: input.workspaceId,
    createdByUserId: input.createdByUserId,
  });
  const isClaimed = await claimCalendarAddonConference({
    userId: input.createdByUserId,
    idempotencyKey: input.idempotencyKey,
    meetingLinkId: meetingLink.id,
    previousMeetingLinkId: existing?.meetingLink.id,
  });
  if (!isClaimed) {
    const winner = await loadReusableCalendarAddonConference({
      userId: input.createdByUserId,
      idempotencyKey: input.idempotencyKey,
    });
    if (winner === null) {
      throw new Error(FAILED_TO_CREATE_CALENDAR_ADD_ON_MEETING_LINK_MESSAGE);
    }

    return winner;
  }

  return { meeting, meetingLink, /** @external existing wire contract */ reused: false };
}

type ResolveMeetingLinkResult = Promise<{
  meeting: {
    id: string;
    title: string;
    roomName: string;
    meetingLinkId: string | null;
    instanceNumber: number;
    workspaceId: string;
    createdByUserId: string;
    kind: MeetingKind;
    status: "scheduled" | "active" | "ended";
    isConfidential: boolean;
    confidentialitySource: "auto" | "manual" | null;
    confidentialityUpdatedByUserId: string | null;
    confidentialityUpdatedAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    endedAt: Date | null;
    hiddenFromHistoryAt: Date | null;
    hiddenFromHistoryReason: string | null;
  };
  meetingLink: {
    id: string;
    code: string;
    workspaceId: string;
    createdByUserId: string;
    title: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  };
  /** @external existing wire contract */ created: boolean;
} | null>;

export async function resolveMeetingLink(input: { code: string }): ResolveMeetingLinkResult {
  try {
    return await (async () => {
      const meetingLink = await mapRow({
        value: db.meetingLinks.findFirst({
          where: { code: input.code },
          take: 1,
        }),
        map: (row) => row ?? undefined,
      });

      if (!meetingLink || meetingLink.status !== "active") {
        return null;
      }

      const currentMeeting = await mapRow({
        value: db.meetings.findFirst({
          where: whereAnd([{ meetingLinkId: meetingLink.id }, { status: { in: ["scheduled", "active"] } }]),
          orderBy: [{ createdAt: "desc" }],
          take: 1,
        }),
        map: (row) => (row === null ? undefined : readStoredMeeting(row)),
      });

      if (currentMeeting) {
        return { meeting: currentMeeting, meetingLink, /** @external existing wire contract */ created: false };
      }

      const latestInstance = await mapRow({
        value: db.meetings.findFirst({
          where: { meetingLinkId: meetingLink.id },
          orderBy: [{ instanceNumber: "desc" }],
          take: 1,
          select: {
            instanceNumber: true,
            kind: true,
          },
        }),
        map: (row) => (row === null ? undefined : { ...row, kind: meetingKindSchema.parse(row.kind) }),
      });

      if (latestInstance?.kind === "agent_intro") {
        return null;
      }

      const meeting = await mapRow({
        value: db.meetings.create({
          data: {
            title: meetingLink.title,
            roomName: generateInternalLiveKitRoomName(),
            meetingLinkId: meetingLink.id,
            instanceNumber: (latestInstance?.instanceNumber ?? 0) + 1,
            workspaceId: meetingLink.workspaceId,
            createdByUserId: meetingLink.createdByUserId,
            status: "scheduled",
            isConfidential: isMeetingConfidentialByDefault,
          },
        }),
        map: (row) => readStoredMeeting(row),
      });

      const confidentialityChange = await insertInitialMeetingHost({
        meetingId: meeting.id,
        userId: meetingLink.createdByUserId,
      });

      return {
        meeting: confidentialityChange ?? meeting,
        meetingLink,
        /** @external existing wire contract */ created: true,
      };
    })();
  } catch (error) {
    if (!isUniqueConstraintError({ error, constraint: MEETINGS_ONE_CURRENT_PER_LINK_CONSTRAINT })) {
      throw error;
    }

    const meetingLink = await getMeetingLinkByCode(input.code);
    if (!meetingLink || meetingLink.status !== "active") {
      return null;
    }

    const meeting = await selectCurrentMeetingForLink(meetingLink.id);
    if (!meeting) {
      throw error;
    }

    return { meeting, meetingLink, /** @external existing wire contract */ created: false };
  }
}

type GetCurrentMeetingForLinkResult = Promise<{
  id: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  workspaceId: string;
  createdByUserId: string;
  kind: MeetingKind;
  status: "scheduled" | "active" | "ended";
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
} | null>;

export async function getCurrentMeetingForLink(meetingLinkId: string): GetCurrentMeetingForLinkResult {
  return selectCurrentMeetingForLink(meetingLinkId);
}

type GetLatestMeetingForLinkResult = Promise<{
  id: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  workspaceId: string;
  createdByUserId: string;
  kind: MeetingKind;
  status: "scheduled" | "active" | "ended";
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
} | null>;

export async function getLatestMeetingForLink(meetingLinkId: string): GetLatestMeetingForLinkResult {
  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { meetingLinkId },
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredMeeting(row)),
  });

  return meeting ?? null;
}

type AttachWaitingJoinRequestsToMeetingResult = Promise<
  {
    id: string;
    meetingLinkId: string;
    meetingId: string | null;
    userId: string;
    displayName: string;
    status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
    sipCallId: string | null;
    sipParticipantIdentity: string | null;
    sipHoldingRoom: string | null;
    requestedAt: string;
    decidedAt: string | null;
    decidedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  }[]
>;

export async function attachWaitingJoinRequestsToMeeting(input: {
  meetingLinkId: string;
  meetingId: string;
}): AttachWaitingJoinRequestsToMeetingResult {
  return (async () => {
    const rows = await (async () => {
      const assignments4 = [
        sqlAssign({ column: "meeting_id", value: input.meetingId, cast: "uuid" }),
        sqlAssign({ column: "updated_at", value: new Date(), cast: "timestamptz" }),
      ];
      const where4 = sqlAnd([
        sqlCompare({
          columnSql: '"meeting_join_requests"."meeting_link_id"',
          operator: "=",
          value: input.meetingLinkId,
          cast: "uuid",
        }),
        sqlCompare({ columnSql: '"meeting_join_requests"."status"', operator: "=", value: "waiting", cast: null }),
        // Call-in requests are bound to a live SIP call in a holding room
        // scoped to one meeting instance; never carry them forward.
        sqlIsNull({ columnSql: '"meeting_join_requests"."sip_call_id"', isNegated: false }),
        sqlOr([
          sqlIsNull({ columnSql: '"meeting_join_requests"."meeting_id"', isNegated: false }),
          // Re-attach requests stranded on an earlier, already-ended instance
          // of this link so the new host still sees them in the admit list.
          sqlInQuery({
            columnSql: '"meeting_join_requests"."meeting_id"',
            query: (() => {
              const existsWhere3 = sqlAnd([
                sqlCompare({
                  columnSql: '"meetings"."meeting_link_id"',
                  operator: "=",
                  value: input.meetingLinkId,
                  cast: "uuid",
                }),
                sqlCompare({ columnSql: '"meetings"."status"', operator: "=", value: "ended", cast: null }),
              ]);

              return Prisma.sql`SELECT "meetings"."id" FROM "meetings"  ${sqlWhereClause(existsWhere3)}`;
            })(),
            isNegated: false,
          }),
        ]),
      ]);

      return db.$queryRaw<
        {
          id: string;
          meetingLinkId: string;
          meetingId: string | null;
          userId: string;
          displayNameSnapshot: string;
          status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
          requestedAt: Date;
          decidedAt: Date | null;
          decidedByUserId: string | null;
          createdAt: Date;
          updatedAt: Date;
          sipCallId: string | null;
          sipParticipantIdentity: string | null;
          sipHoldingRoom: string | null;
          activeJoinKey: string | null;
        }[]
      >`
                       UPDATE "meeting_join_requests"
                       SET ${Prisma.join(assignments4, ", ")}
                       ${sqlWhereClause(where4)}
                       RETURNING "id" AS "id", "meeting_link_id" AS "meetingLinkId", "meeting_id" AS "meetingId", "user_id" AS "userId", "display_name_snapshot" AS "displayNameSnapshot", "status" AS "status", "requested_at" AS "requestedAt", "decided_at" AS "decidedAt", "decided_by_user_id" AS "decidedByUserId", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "sip_call_id" AS "sipCallId", "sip_participant_identity" AS "sipParticipantIdentity", "sip_holding_room" AS "sipHoldingRoom", "active_join_key" AS "activeJoinKey"
                       `;
    })();

    if (rows.length !== 0) {
      await db.guestAuthSessions.updateMany({
        where: { joinRequestId: { in: rows.map((row) => row.id) } },
        data: {
          meetingId: input.meetingId,
          updatedAt: new Date(),
        },
      });
    }

    return rows.map(parseMeetingJoinRequestRow);
  })();
}

type CreateOrReuseMeetingJoinRequestResult = Promise<{
  id: string;
  meetingLinkId: string;
  meetingId: string | null;
  userId: string;
  displayName: string;
  status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
  sipCallId: string | null;
  sipParticipantIdentity: string | null;
  sipHoldingRoom: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

async function reuseExistingMeetingJoinRequestWithin(args: {
  input: {
    meetingId?: string | null;
    displayName: string;
  };
  existing: Prisma.meetingJoinRequestsModel;
}) {
  const { input, existing } = args;
  const shouldLoadExistingMeeting =
    existing.meetingId !== null && existing.meetingId !== "" && existing.meetingId !== (input.meetingId ?? null);
  const existingMeetingRows =
    shouldLoadExistingMeeting && existing.meetingId !== null
      ? await mapRow({
          value: db.meetings.findMany({
            where: { id: existing.meetingId },
            take: 1,
            select: {
              status: true,
            },
          }),
          map: (rows) =>
            rows.map((row) => ({
              ...row,
              status: readStringUnion({ values: ["scheduled", "active", "ended"], value: row.status }),
            })),
        })
      : [];
  const isExistingMeetingEnded = existingMeetingRows[0]?.status === "ended";

  const [updated] = await mapRow({
    value: db.meetingJoinRequests.updateManyAndReturn({
      where: { id: existing.id },
      data: isExistingMeetingEnded
        ? {
            meetingId: input.meetingId ?? null,
            status: "waiting",
            requestedAt: new Date(),
            decidedAt: null,
            decidedByUserId: null,
            displayNameSnapshot: input.displayName,
            updatedAt: new Date(),
          }
        : {
            meetingId: existing.meetingId ?? input.meetingId ?? null,
            displayNameSnapshot: input.displayName,
            updatedAt: new Date(),
          },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: readStringUnion({ values: ["waiting", "admitted", "denied", "expired", "revoked"], value: row.status }),
      })),
  });

  if (!updated) {
    throw new Error(FAILED_TO_UPDATE_MEETING_JOIN_REQUEST_MESSAGE);
  }

  if (isExistingMeetingEnded) {
    await db.guestAuthSessions.updateMany({
      where: { joinRequestId: existing.id },
      data: {
        meetingId: input.meetingId ?? null,
        updatedAt: new Date(),
      },
    });
  }

  return parseMeetingJoinRequestRow(updated);
}

const createOrReuseMeetingJoinRequestWithin = async (args: {
  input: {
    meetingLinkId: string;
    meetingId?: string | null;
    userId: string;
    displayName: string;
  };
}) => {
  const { input } = args;
  const existing = await mapRow({
    value: db.meetingJoinRequests.findFirst({
      where: whereAnd([
        { meetingLinkId: input.meetingLinkId },
        { userId: input.userId },
        { status: { in: [...ACTIVE_MEETING_JOIN_REQUEST_STATUSES] } },
      ]),
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: readStringUnion({
              values: ["waiting", "admitted", "denied", "expired", "revoked"],
              value: row.status,
            }),
          },
  });

  if (existing) {
    return reuseExistingMeetingJoinRequestWithin({ input, existing });
  }

  const created = await mapRow({
    value: db.meetingJoinRequests.create({
      data: {
        meetingLinkId: input.meetingLinkId,
        meetingId: input.meetingId ?? null,
        userId: input.userId,
        displayNameSnapshot: input.displayName,
        status: "waiting",
      },
    }),
    map: (row) => ({
      ...row,
      status: readStringUnion({
        values: ["waiting", "admitted", "denied", "expired", "revoked"],
        value: row.status,
      }),
    }),
  });

  return parseMeetingJoinRequestRow(created);
};

export async function createOrReuseMeetingJoinRequest(input: {
  meetingLinkId: string;
  meetingId?: string | null;
  userId: string;
  displayName: string;
}): CreateOrReuseMeetingJoinRequestResult {
  const trimmedGuestName = input.displayName.trim().slice(0, GUEST_DISPLAY_NAME_MAX_LENGTH);
  const displayName = trimmedGuestName !== "" ? trimmedGuestName : "Guest";

  return (() => createOrReuseMeetingJoinRequestWithin({ input: { ...input, displayName } }))();
}

type CreateCallInMeetingJoinRequestResult = Promise<
  | {
      request: {
        id: string;
        meetingLinkId: string;
        meetingId: string | null;
        userId: string;
        displayName: string;
        status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
        sipCallId: string | null;
        sipParticipantIdentity: string | null;
        sipHoldingRoom: string | null;
        requestedAt: string;
        decidedAt: string | null;
        decidedByUserId: string | null;
        createdAt: string;
        updatedAt: string;
      };
      /** @external existing wire contract */ created: true;
    }
  | {
      request: {
        id: string;
        meetingLinkId: string;
        meetingId: string | null;
        userId: string;
        displayName: string;
        status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
        sipCallId: string | null;
        sipParticipantIdentity: string | null;
        sipHoldingRoom: string | null;
        requestedAt: string;
        decidedAt: string | null;
        decidedByUserId: string | null;
        createdAt: string;
        updatedAt: string;
      };
      /** @external existing wire contract */ created: false;
    }
>;

export async function createCallInMeetingJoinRequest(input: {
  meetingLinkId: string;
  meetingId: string;
  userId: string;
  displayName: string;
  sipCallId: string;
  sipParticipantIdentity: string;
  sipHoldingRoom: string;
}): CreateCallInMeetingJoinRequestResult {
  const trimmedCallerName = input.displayName.trim().slice(0, GUEST_DISPLAY_NAME_MAX_LENGTH);
  const displayName = trimmedCallerName !== "" ? trimmedCallerName : "Phone caller";
  const created = await mapRow({
    value: createIgnoringUniqueConflict(() =>
      db.meetingJoinRequests.create({
        data: {
          meetingLinkId: input.meetingLinkId,
          meetingId: input.meetingId,
          userId: input.userId,
          displayNameSnapshot: displayName,
          status: "waiting",
          sipCallId: input.sipCallId,
          sipParticipantIdentity: input.sipParticipantIdentity,
          sipHoldingRoom: input.sipHoldingRoom,
        },
      }),
    ),
    map: (row) =>
      row === undefined
        ? undefined
        : {
            ...row,
            status: readStringUnion({
              values: ["waiting", "admitted", "denied", "expired", "revoked"],
              value: row.status,
            }),
          },
  });

  if (created) {
    return {
      request: parseMeetingJoinRequestRow(created),
      /** @external existing wire contract */ created: true as const,
    };
  }

  // Webhook deliveries can retry: reuse the request keyed to this SIP call.
  const existing = await getCallInMeetingJoinRequestBySipCallId(input.sipCallId);
  if (!existing) {
    throw new Error(FAILED_TO_CREATE_CALL_IN_MEETING_JOIN_REQUEST_MESSAGE);
  }

  return { request: existing, /** @external existing wire contract */ created: false as const };
}

type GetCallInMeetingJoinRequestBySipCallIdResult = Promise<{
  id: string;
  meetingLinkId: string;
  meetingId: string | null;
  userId: string;
  displayName: string;
  status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
  sipCallId: string | null;
  sipParticipantIdentity: string | null;
  sipHoldingRoom: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
} | null>;

export async function getCallInMeetingJoinRequestBySipCallId(
  sipCallId: string,
): GetCallInMeetingJoinRequestBySipCallIdResult {
  const row = await mapRow({
    value: db.meetingJoinRequests.findFirst({
      where: { sipCallId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: readStringUnion({
              values: ["waiting", "admitted", "denied", "expired", "revoked"],
              value: row.status,
            }),
          },
  });

  return row ? parseMeetingJoinRequestRow(row) : null;
}

type ExpireCallInMeetingJoinRequestResult = Promise<{
  id: string;
  meetingLinkId: string;
  meetingId: string | null;
  userId: string;
  displayName: string;
  status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
  sipCallId: string | null;
  sipParticipantIdentity: string | null;
  sipHoldingRoom: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
} | null>;

export async function expireCallInMeetingJoinRequest(input: {
  sipCallId: string;
}): ExpireCallInMeetingJoinRequestResult {
  const [updated] = await mapRow({
    value: db.meetingJoinRequests.updateManyAndReturn({
      where: whereAnd([{ sipCallId: input.sipCallId }, { status: "waiting" }]),
      data: {
        status: "expired",
        decidedAt: new Date(),
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: readStringUnion({ values: ["waiting", "admitted", "denied", "expired", "revoked"], value: row.status }),
      })),
  });

  return updated ? parseMeetingJoinRequestRow(updated) : null;
}

// Used when admitting a call-in request succeeds in the database but the
// LiveKit move into the meeting room fails: the caller is still on hold, so
// put the request back in the waiting list for the host to retry.
type RevertMeetingJoinRequestToWaitingResult = Promise<{
  id: string;
  meetingLinkId: string;
  meetingId: string | null;
  userId: string;
  displayName: string;
  status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
  sipCallId: string | null;
  sipParticipantIdentity: string | null;
  sipHoldingRoom: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
} | null>;

export async function revertMeetingJoinRequestToWaiting(requestId: string): RevertMeetingJoinRequestToWaitingResult {
  const [updated] = await mapRow({
    value: db.meetingJoinRequests.updateManyAndReturn({
      where: whereAnd([{ id: requestId }, { status: "admitted" }]),
      data: {
        status: "waiting",
        decidedAt: null,
        decidedByUserId: null,
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: readStringUnion({ values: ["waiting", "admitted", "denied", "expired", "revoked"], value: row.status }),
      })),
  });

  return updated ? parseMeetingJoinRequestRow(updated) : null;
}

type ExpireWaitingCallInJoinRequestsForMeetingResult = Promise<
  {
    id: string;
    meetingLinkId: string;
    meetingId: string | null;
    userId: string;
    displayName: string;
    status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
    sipCallId: string | null;
    sipParticipantIdentity: string | null;
    sipHoldingRoom: string | null;
    requestedAt: string;
    decidedAt: string | null;
    decidedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  }[]
>;

export async function expireWaitingCallInJoinRequestsForMeeting(
  meetingId: string,
): ExpireWaitingCallInJoinRequestsForMeetingResult {
  const rows = await mapRow({
    value: db.meetingJoinRequests.updateManyAndReturn({
      where: whereAnd([{ meetingId }, { status: "waiting" }, { sipCallId: { not: null } }]),
      data: {
        status: "expired",
        decidedAt: new Date(),
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: readStringUnion({ values: ["waiting", "admitted", "denied", "expired", "revoked"], value: row.status }),
      })),
  });

  return rows.map(parseMeetingJoinRequestRow);
}

type ListWaitingJoinRequestsForMeetingResult = Promise<
  {
    id: string;
    meetingLinkId: string;
    meetingId: string | null;
    userId: string;
    displayName: string;
    status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
    sipCallId: string | null;
    sipParticipantIdentity: string | null;
    sipHoldingRoom: string | null;
    requestedAt: string;
    decidedAt: string | null;
    decidedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  }[]
>;

export async function listWaitingJoinRequestsForMeeting(meetingId: string): ListWaitingJoinRequestsForMeetingResult {
  const rows = await mapRow({
    value: db.meetingJoinRequests.findMany({
      where: whereAnd([{ meetingId }, { status: "waiting" }]),
      orderBy: [{ requestedAt: "asc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: readStringUnion({ values: ["waiting", "admitted", "denied", "expired", "revoked"], value: row.status }),
      })),
  });

  return rows.map(parseMeetingJoinRequestRow);
}

export async function countWaitingJoinRequestsForLink(meetingLinkId: string): Promise<number> {
  const rows = await db.meetingJoinRequests.findMany({
    where: whereAnd([{ meetingLinkId }, { status: "waiting" }]),
    select: {
      id: true,
    },
  });

  return rows.length;
}

type GetMeetingJoinRequestByIdResult = Promise<{
  id: string;
  meetingLinkId: string;
  meetingId: string | null;
  userId: string;
  displayName: string;
  status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
  sipCallId: string | null;
  sipParticipantIdentity: string | null;
  sipHoldingRoom: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
} | null>;

export async function getMeetingJoinRequestById(requestId: string): GetMeetingJoinRequestByIdResult {
  const row = await mapRow({
    value: db.meetingJoinRequests.findFirst({
      where: { id: requestId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: readStringUnion({
              values: ["waiting", "admitted", "denied", "expired", "revoked"],
              value: row.status,
            }),
          },
  });

  return row ? parseMeetingJoinRequestRow(row) : null;
}

type GetActiveMeetingJoinRequestForUserResult = Promise<{
  id: string;
  meetingLinkId: string;
  meetingId: string | null;
  userId: string;
  displayName: string;
  status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
  sipCallId: string | null;
  sipParticipantIdentity: string | null;
  sipHoldingRoom: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
} | null>;

export async function getActiveMeetingJoinRequestForUser(
  ...args: [meetingLinkId: string, userId: string]
): GetActiveMeetingJoinRequestForUserResult {
  const [meetingLinkId, userId] = args;
  const row = await mapRow({
    value: db.meetingJoinRequests.findFirst({
      where: whereAnd([{ meetingLinkId }, { userId }, { status: { in: [...ACTIVE_MEETING_JOIN_REQUEST_STATUSES] } }]),
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: readStringUnion({
              values: ["waiting", "admitted", "denied", "expired", "revoked"],
              value: row.status,
            }),
          },
  });

  return row ? parseMeetingJoinRequestRow(row) : null;
}

type DecideMeetingJoinRequestResult = Promise<{
  id: string;
  meetingLinkId: string;
  meetingId: string | null;
  userId: string;
  displayName: string;
  status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
  sipCallId: string | null;
  sipParticipantIdentity: string | null;
  sipHoldingRoom: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
} | null>;

export async function decideMeetingJoinRequest(input: {
  requestId: string;
  meetingId: string;
  decidedByUserId: string;
  status: Extract<MeetingJoinRequestStatus, "admitted" | "denied" | "revoked" | "expired">;
}): DecideMeetingJoinRequestResult {
  return (async () => {
    const [updated] = await mapRow({
      value: db.meetingJoinRequests.updateManyAndReturn({
        where: whereAnd([
          { id: input.requestId },
          whereOr([{ meetingId: input.meetingId }, { meetingId: null }]),
          { status: { in: ["waiting", "admitted"] } },
        ]),
        data: {
          meetingId: input.meetingId,
          status: input.status,
          decidedAt: new Date(),
          decidedByUserId: input.decidedByUserId,
          updatedAt: new Date(),
        },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          status: readStringUnion({
            values: ["waiting", "admitted", "denied", "expired", "revoked"],
            value: row.status,
          }),
        })),
    });

    if (!updated) {
      return null;
    }

    await db.guestAuthSessions.updateMany({
      where: { joinRequestId: input.requestId },
      data: {
        meetingId: input.meetingId,
        updatedAt: new Date(),
      },
    });

    return parseMeetingJoinRequestRow(updated);
  })();
}

export async function hasAdmittedJoinRequestForMeeting(input: {
  meetingId: string;
  userId: string;
  joinRequestId?: string | null;
}): Promise<boolean> {
  const predicates = [{ meetingId: input.meetingId }, { userId: input.userId }, { status: "admitted" }];
  const predicatesWithJoinRequest =
    input.joinRequestId !== undefined && input.joinRequestId !== null && input.joinRequestId !== ""
      ? [...predicates, { id: input.joinRequestId }]
      : predicates;

  const row = await mapRow({
    value: db.meetingJoinRequests.findFirst({
      where: whereAnd(predicatesWithJoinRequest),
      take: 1,
      select: {
        id: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  return Boolean(row);
}

export async function hasJoinedAdmittedMeeting(input: {
  meetingId: string;
  userId: string;
  joinRequestId?: string | null;
}): Promise<boolean> {
  const row = await mapRow({
    value: (async () => {
      const where5 = sqlAnd([
        sqlCompare({
          columnSql: '"meeting_participants"."meeting_id"',
          operator: "=",
          value: input.meetingId,
          cast: "uuid",
        }),
        sqlCompare({ columnSql: '"meeting_participants"."user_id"', operator: "=", value: input.userId, cast: "uuid" }),
        sqlCompare({ columnSql: '"meeting_join_requests"."status"', operator: "=", value: "admitted", cast: null }),
        sqlColCompare({
          leftSql: '"meeting_participants"."joined_at"',
          operator: ">",
          rightSql: '"meeting_join_requests"."decided_at"',
        }),
        input.joinRequestId !== undefined && input.joinRequestId !== null && input.joinRequestId !== ""
          ? sqlCompare({
              columnSql: '"meeting_join_requests"."id"',
              operator: "=",
              value: input.joinRequestId,
              cast: "uuid",
            })
          : Prisma.empty,
      ]);
      const join50 = sqlAnd([
        sqlColCompare({
          leftSql: '"meeting_join_requests"."meeting_id"',
          operator: "=",
          rightSql: '"meeting_participants"."meeting_id"',
        }),
        sqlColCompare({
          leftSql: '"meeting_join_requests"."user_id"',
          operator: "=",
          rightSql: '"meeting_participants"."user_id"',
        }),
      ]);
      const limit5 = 1;

      return db.$queryRaw<{ participantId: string }[]>`
                      SELECT "meeting_participants"."id" AS "participantId"
                      FROM "meeting_participants"
                      INNER JOIN "meeting_join_requests" ON ${join50}
                      ${sqlWhereClause(where5)}


                      ${sqlLimit(limit5)}


                      `;
    })(),
    map: (rows) => rows[0],
  });

  return Boolean(row);
}

type CreateGuestAuthSessionResult = Promise<{
  id: string;
  createdAt: Date;
  userId: string;
  updatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  meetingLinkId: string;
  meetingId: string | null;
  joinRequestId: string;
  secretHash: string;
  linkedToUserId: string | null;
}>;

export async function createGuestAuthSession(input: {
  userId: string;
  meetingLinkId: string;
  meetingId?: string | null;
  joinRequestId: string;
  secretHash: string;
  expiresAt: Date;
}): CreateGuestAuthSessionResult {
  const session = await db.guestAuthSessions.create({
    data: {
      userId: input.userId,
      meetingLinkId: input.meetingLinkId,
      meetingId: input.meetingId ?? null,
      joinRequestId: input.joinRequestId,
      secretHash: input.secretHash,
      expiresAt: input.expiresAt,
    },
  });

  return session;
}

type GetGuestAuthSessionByIdResult = Promise<{
  session: {
    id: string;
    userId: string;
    meetingLinkId: string;
    meetingId: string | null;
    joinRequestId: string;
    secretHash: string;
    expiresAt: Date;
    linkedToUserId: string | null;
    revokedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  request: {
    id: string;
    meetingLinkId: string;
    meetingId: string | null;
    userId: string;
    displayNameSnapshot: string;
    status: "waiting" | "admitted" | "denied" | "expired" | "revoked";
    sipCallId: string | null;
    sipParticipantIdentity: string | null;
    sipHoldingRoom: string | null;
    requestedAt: Date;
    decidedAt: Date | null;
    decidedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    source: "guest" | "auth" | "dev_login" | "debug_import";
    plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
    privateBetaProEnabledAt: Date | null;
    hasCompletedFirstMeeting: boolean;
    lastSeenAt: Date | null;
    activeWorkspaceId: string | null;
    agentIntroCompletedAt: Date | null;
    sessionVersion: number;
    deletedAt: Date | null;
    createdAt: Date;
  };
} | null>;

export async function getGuestAuthSessionById(sessionId: string): GetGuestAuthSessionByIdResult {
  const row = await mapRow({
    value: db.guestAuthSessions.findFirst({
      where: { id: sessionId },
      take: 1,
      select: {
        id: true,
        userId: true,
        meetingLinkId: true,
        meetingId: true,
        joinRequestId: true,
        secretHash: true,
        expiresAt: true,
        linkedToUserId: true,
        revokedAt: true,
        createdAt: true,
        updatedAt: true,
        meetingJoinRequests: true,
        usersGuestAuthSessionsUserIdTousers: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : ((row) => ({
            session: row,
            request: {
              ...row.meetingJoinRequests,
              status: readStringUnion({
                values: ["waiting", "admitted", "denied", "expired", "revoked"],
                value: row.meetingJoinRequests.status,
              }),
            },
            user: {
              ...row.usersGuestAuthSessionsUserIdTousers,
              source: readStringUnion({
                values: ["auth", "dev_login", "debug_import", "guest"],
                value: row.usersGuestAuthSessionsUserIdTousers.source,
              }),
              plan: readStringUnion({
                values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
                value: row.usersGuestAuthSessionsUserIdTousers.plan,
              }),
            },
          }))(row),
  });

  return row ?? null;
}

async function transferGuestMeetingParticipantsToUser(args: { input: { guestUserId: string; targetUserId: string } }) {
  const { input } = args;
  const participantRows = await mapRow({
    value: db.meetingParticipants.findMany({
      where: { userId: input.guestUserId },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
      })),
  });

  const confidentialityChanges = await mapRowsSequentially({
    rows: participantRows,
    visit: async (participant) => {
      const confidentialityChange = await db.$transaction(async (tx) => {
        await (async () => {
          const where6 = sqlCompare({
            columnSql: '"meetings"."id"',
            operator: "=",
            value: participant.meetingId,
            cast: "uuid",
          });

          return tx.$queryRaw<{ id: string }[]>`
              SELECT "meetings"."id" AS "id"
              FROM "meetings"

              ${sqlWhereClause(where6)}




              FOR UPDATE
              `;
        })();
        const existingTarget = await mapRow({
          value: tx.meetingParticipants.findFirst({
            where: whereAnd([{ meetingId: participant.meetingId }, { userId: input.targetUserId }]),
            take: 1,
            select: {
              id: true,
            },
          }),
          map: (row) => row ?? undefined,
        });

        if (existingTarget) {
          await tx.meetingParticipants.deleteMany({
            where: { id: participant.id },
          });
        } else {
          await tx.meetingParticipants.updateMany({
            where: { id: participant.id },
            data: {
              userId: input.targetUserId,
            },
          });
        }

        return autoMarkMeetingConfidentialInTransaction({ meetingId: participant.meetingId, connection: tx });
      });

      return confidentialityChange ?? undefined;
    },
  });

  return { participantMeetingIds: participantRows.map((participant) => participant.meetingId), confidentialityChanges };
}

const compareTransferredMemberships = (input: {
  left: { workspaceId: string; createdAt: Date };
  right: { workspaceId: string; createdAt: Date };
  hostWorkspaceId: string;
  preferredWorkspaceId: string | null;
}): number => {
  const hostOrder =
    Number(input.left.workspaceId !== input.hostWorkspaceId) -
    Number(input.right.workspaceId !== input.hostWorkspaceId);
  if (hostOrder !== 0) {
    return hostOrder;
  }
  const preferred = input.preferredWorkspaceId;
  const preferredOrder =
    Number(preferred !== null && input.left.workspaceId !== preferred) -
    Number(preferred !== null && input.right.workspaceId !== preferred);
  if (preferredOrder !== 0) {
    return preferredOrder;
  }
  const createdOrder = input.left.createdAt.getTime() - input.right.createdAt.getTime();
  if (createdOrder !== 0) {
    return createdOrder;
  }
  if (input.left.workspaceId < input.right.workspaceId) {
    return -1;
  }
  if (input.left.workspaceId > input.right.workspaceId) {
    return 1;
  }

  return 0;
};

const fileTransferredAttendeeWorkspace = async (input: {
  meetingId: string;
  userId: string;
  selectedWorkspaceId: string | null;
}) => {
  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { id: input.meetingId },
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredMeeting(row)),
  });
  const user = await mapRow({
    value: db.users.findFirst({
      where: { id: input.userId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
            plan: readStringUnion({
              values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
              value: row.plan,
            }),
          },
  });
  if (
    meeting === undefined ||
    user === undefined ||
    user.deletedAt !== null ||
    (user.source !== "auth" && user.source !== "dev_login")
  ) {
    return;
  }
  const attendance = await db.meetingAttendanceIntervals.findMany({
    where: whereAnd([{ meetingId: input.meetingId }, { userId: input.userId }]),
    select: { joinedAt: true },
  });
  const endedAt = meeting.endedAt;
  const hasJoinedBeforeEnd =
    endedAt !== null && attendance.some((interval) => interval.joinedAt.getTime() < endedAt.getTime());
  if (meeting.status === "ended" && !hasJoinedBeforeEnd) {
    return;
  }
  const suspended = await mapRow({
    value: db.workspaceMemberships.findFirst({
      where: whereAnd([{ userId: input.userId }, { workspaceId: meeting.workspaceId }, { status: "suspended" }]),
      take: 1,
      select: { id: true },
    }),
    map: (row) => row ?? undefined,
  });
  if (suspended !== undefined) {
    return;
  }
  const memberships = await db.workspaceMemberships.findMany({
    where: whereAnd([{ userId: input.userId }, { status: "active" }]),
    select: { workspaceId: true, createdAt: true },
  });
  const destination = [...memberships].sort((left, right) =>
    compareTransferredMemberships({
      left,
      right,
      hostWorkspaceId: meeting.workspaceId,
      preferredWorkspaceId: input.selectedWorkspaceId ?? user.activeWorkspaceId,
    }),
  )[0];
  if (destination === undefined) {
    return;
  }
  await createIgnoringUniqueConflict(() =>
    db.meetingAttendeeWorkspaces.create({
      data: {
        meetingId: input.meetingId,
        userId: input.userId,
        workspaceId: destination.workspaceId,
        assignment: destination.workspaceId === meeting.workspaceId ? "host_workspace" : "joined_workspace",
      },
    }),
  );
};

const recordTransferredAttendeeWorkspace = async (input: {
  meetingId: string;
  userId: string;
  selectedWorkspaceId: string | null;
}) => {
  const existingFiling = await mapRow({
    value: db.meetingAttendeeWorkspaces.findFirst({
      where: whereAnd([{ meetingId: input.meetingId }, { userId: input.userId }]),
      take: 1,
      select: {
        meetingId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (existingFiling !== undefined) {
    return;
  }
  if (input.selectedWorkspaceId !== null) {
    const membership = await mapRow({
      value: db.workspaceMemberships.findFirst({
        where: whereAnd([{ userId: input.userId }, { workspaceId: input.selectedWorkspaceId }, { status: "active" }]),
        take: 1,
        select: {
          id: true,
        },
      }),
      map: (row) => row ?? undefined,
    });
    if (membership === undefined) {
      const error = new Error(INACTIVE_ATTENDEE_WORKSPACE_MESSAGE);
      Object.assign(error, { code: POSTGRES_FOREIGN_KEY_VIOLATION_CODE });
      throw error;
    }
  }
  await fileTransferredAttendeeWorkspace(input);
};

const copyGuestAttendanceIntervals = async (input: {
  meetingId: string;
  guestUserId: string;
  targetUserId: string;
}) => {
  const intervals = await db.meetingAttendanceIntervals.findMany({
    where: whereAnd([{ meetingId: input.meetingId }, { userId: input.guestUserId }]),
  });
  await forEachSequential({
    items: intervals,
    visit: async (interval) => {
      const existing = await mapRow({
        value: db.meetingAttendanceIntervals.findFirst({
          where: whereAnd([
            { meetingId: interval.meetingId },
            { userId: input.targetUserId },
            { joinedAt: interval.joinedAt },
          ]),
          take: 1,
          select: {
            id: true,
          },
        }),
        map: (row) => row ?? undefined,
      });
      if (existing !== undefined) {
        return;
      }
      await db.meetingAttendanceIntervals.create({
        data: {
          meetingId: interval.meetingId,
          userId: input.targetUserId,
          joinedAt: interval.joinedAt,
          leftAt: interval.leftAt,
        },
      });
    },
  });
};

async function fileGuestTransferredMeetingAttendance(args: {
  input: { guestUserId: string; targetUserId: string; targetWorkspaceId?: string };
  participantMeetingIds: string[];
}) {
  const { input, participantMeetingIds } = args;
  const selectedWorkspaceId =
    input.targetWorkspaceId !== undefined && input.targetWorkspaceId !== "" ? input.targetWorkspaceId : null;

  await forEachSequential({
    items: [...new Set(participantMeetingIds)],
    visit: async (meetingId) => {
      await recordTransferredAttendeeWorkspace({
        meetingId,
        userId: input.targetUserId,
        selectedWorkspaceId,
      });
      await copyGuestAttendanceIntervals({
        meetingId,
        guestUserId: input.guestUserId,
        targetUserId: input.targetUserId,
      });
      await recordTransferredAttendeeWorkspace({
        meetingId,
        userId: input.targetUserId,
        selectedWorkspaceId,
      });
    },
  });
}

async function reassignGuestMeetingJoinRequestsToUser(args: {
  input: { guestUserId: string; targetUserId: string };
  targetUser: { displayName: string };
}) {
  const { input, targetUser } = args;
  const requestRows = await mapRow({
    value: db.meetingJoinRequests.findMany({
      where: { userId: input.guestUserId },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: readStringUnion({ values: ["waiting", "admitted", "denied", "expired", "revoked"], value: row.status }),
      })),
  });

  await forEachSequential({
    items: requestRows,
    visit: async (request) => {
      const existingTarget = await mapRow({
        value: db.meetingJoinRequests.findFirst({
          where: whereAnd([
            { meetingLinkId: request.meetingLinkId },
            { userId: input.targetUserId },
            { status: { in: [...ACTIVE_MEETING_JOIN_REQUEST_STATUSES] } },
          ]),
          take: 1,
          select: {
            id: true,
          },
        }),
        map: (row) => row ?? undefined,
      });

      if (existingTarget) {
        await db.meetingJoinRequests.updateMany({
          where: { id: request.id },
          data: {
            status: "revoked",
            decidedAt: new Date(),
            decidedByUserId: input.targetUserId,
            updatedAt: new Date(),
          },
        });
      } else {
        await db.meetingJoinRequests.updateMany({
          where: { id: request.id },
          data: {
            userId: input.targetUserId,
            displayNameSnapshot: targetUser.displayName,
            updatedAt: new Date(),
          },
        });
      }
    },
  });
}

const GUEST_MEMORY_IDENTITY_FALLBACK_RANK = 2;

const guestMemoryIdentityRank = (input: {
  kind: string;
  identity: string;
  guestUserId: string;
  browserId: string | undefined;
}): number => {
  if (input.kind === "guest_browser" && input.browserId !== undefined && input.identity === input.browserId) {
    return 0;
  }
  if (input.kind === "user_id" && input.identity === input.guestUserId) {
    return 1;
  }

  return GUEST_MEMORY_IDENTITY_FALLBACK_RANK;
};

const loadGuestMemoryIdentities = async (input: {
  guestUserId: string;
  accountUserId: string;
  accountEmail: string;
  browserIds: string[];
}) => {
  const userIdentities = await db.memoryPersonIdentities.findMany({
    where: whereAnd([{ kind: "user_id" }, { identity: { in: [input.guestUserId, input.accountUserId] } }]),
  });
  const emailIdentities = await db.memoryPersonIdentities.findMany({
    where: { kind: "verified_email" },
  });
  const browserIdentities =
    input.browserIds.length === 0
      ? []
      : await db.memoryPersonIdentities.findMany({
          where: whereAnd([{ kind: "guest_browser" }, { identity: { in: input.browserIds } }]),
        });

  return [
    ...userIdentities,
    ...emailIdentities.filter((row) => row.identity.trim().toLowerCase() === input.accountEmail),
    ...browserIdentities,
  ];
};

const copyGuestObservedNames = async (input: {
  winnerId: string;
  guestUserId: string;
  guestPersonId: string;
  displayName: string;
}) => {
  const interactions = await db.memoryInteractions.findMany({
    where: { personId: input.guestPersonId },
  });
  const trimmed = input.displayName.trim();
  const normalizedName = trimmed.toLowerCase();
  const wordCount = normalizedName === "guest" ? 0 : trimmed.split(/\s+/).filter((word) => word !== "").length;
  await forEachSequential({
    items: interactions,
    visit: async (interaction) => {
      await createIgnoringUniqueConflict(() =>
        db.memoryPersonNames.create({
          data: {
            personId: input.winnerId,
            sourceId: interaction.sourceId,
            participantUserId: input.guestUserId,
            name: input.displayName,
            normalizedName,
            wordCount,
            observedAt: interaction.occurredAt,
          },
        }),
      );
    },
  });
};

const moveMemoryPersonRows = async (input: { winnerId: string; loserId: string }) => {
  const [interactions, names, identities] = await Promise.all([
    db.memoryInteractions.findMany({
      where: { personId: input.loserId },
    }),
    db.memoryPersonNames.findMany({
      where: { personId: input.loserId },
    }),
    db.memoryPersonIdentities.findMany({
      where: { personId: input.loserId },
    }),
  ]);
  await forEachSequential({
    items: interactions,
    visit: async (interaction) => {
      await createIgnoringUniqueConflict(() =>
        db.memoryInteractions.create({
          data: {
            sourceId: interaction.sourceId,
            personId: input.winnerId,
            occurredAt: interaction.occurredAt,
          },
        }),
      );
    },
  });
  await db.memoryInteractions.deleteMany({
    where: { personId: input.loserId },
  });
  await forEachSequential({
    items: names,
    visit: async (name) => {
      await createIgnoringUniqueConflict(() =>
        db.memoryPersonNames.create({
          data: {
            ...name,
            personId: input.winnerId,
          },
        }),
      );
    },
  });
  await db.memoryPersonNames.deleteMany({
    where: { personId: input.loserId },
  });
  await forEachSequential({
    items: identities,
    visit: async (identity) => {
      await db.memoryPersonIdentities.deleteMany({
        where: whereAnd([
          { userId: identity.userId },
          { workspaceId: identity.workspaceId },
          { kind: identity.kind },
          { identity: identity.identity },
        ]),
      });
      await createIgnoringUniqueConflict(() =>
        db.memoryPersonIdentities.create({
          data: {
            ...identity,
            personId: input.winnerId,
          },
        }),
      );
    },
  });
  await db.memoryPersonRedirects.updateMany({
    where: { targetPersonId: input.loserId },
    data: {
      targetPersonId: input.winnerId,
    },
  });
  await (async () => {
    const data = {
      personId: input.loserId,
      targetPersonId: input.winnerId,
    };

    return db.memoryPersonRedirects.upsert({
      where: { personId: data.personId },
      create: data,
      update: {
        targetPersonId: input.winnerId,
      },
    });
  })();
};

const replaceMemoryPersonReference = async (input: { winnerId: string; loserId: string }) => {
  const memories = await db.relationshipMemories.findMany({
    select: {
      id: true,
      personIds: true,
      candidateSubjectId: true,
    },
  });
  const matches = memories.filter(
    (memory) => memory.personIds.includes(input.loserId) || memory.candidateSubjectId === input.loserId,
  );
  await forEachSequential({
    items: matches,
    visit: async (memory) => {
      await db.relationshipMemories.updateMany({
        where: { id: memory.id },
        data: {
          personIds: memory.personIds.map((personId) => (personId === input.loserId ? input.winnerId : personId)),
          candidateSubjectId: memory.candidateSubjectId === input.loserId ? input.winnerId : memory.candidateSubjectId,
        },
      });
    },
  });
};

const consolidateTransferredProjections = async (input: { winnerId: string; loserId: string }) => {
  const rows = await db.memoryPersonProjections.findMany({
    where: { personId: { in: [input.winnerId, input.loserId] } },
  });
  const consolidated = await buildConsolidatedMemoryProjection({ winnerId: input.winnerId, rows });
  if (consolidated !== null) {
    const inputHash = `consolidated:${randomUUID()}`;
    await (async () => {
      const data = {
        personId: input.winnerId,
        inputHash,
        content: jsonInput(consolidated.content),
        promptVersion: consolidated.promptVersion,
        sourceRevisions: jsonInput(consolidated.sourceRevisions),
        updatedAt: new Date(),
      };

      return db.memoryPersonProjections.upsert({
        where: { personId: data.personId },
        create: data,
        update: {
          inputHash,
          content: jsonInput(consolidated.content),
          promptVersion: consolidated.promptVersion,
          sourceRevisions: jsonInput(consolidated.sourceRevisions),
          updatedAt: new Date(),
        },
      });
    })();
  }
  await db.memoryPersonProjections.deleteMany({
    where: { personId: input.loserId },
  });
};

const mergeGuestMemoryScope = async (input: {
  guestUserId: string;
  accountUserId: string;
  accountName: string;
  displayName: string;
  browserId: string | undefined;
  identities: Awaited<ReturnType<typeof loadGuestMemoryIdentities>>;
  scopeKey: string;
}) => {
  const separator = input.scopeKey.indexOf(":");
  const userId = input.scopeKey.slice(0, separator);
  const workspaceId = input.scopeKey.slice(separator + 1);
  const scoped = input.identities
    .filter((identity) => identity.userId === userId && identity.workspaceId === workspaceId)
    .sort((left, right) => {
      const rank =
        guestMemoryIdentityRank({ ...left, guestUserId: input.guestUserId, browserId: input.browserId }) -
        guestMemoryIdentityRank({ ...right, guestUserId: input.guestUserId, browserId: input.browserId });
      if (rank !== 0) {
        return rank;
      }
      if (left.personId < right.personId) {
        return -1;
      }

      return left.personId > right.personId ? 1 : 0;
    });
  const winner = scoped[0];
  if (winner === undefined) {
    return;
  }
  const guestIdentity = scoped.find(
    (identity) => identity.kind === "user_id" && identity.identity === input.guestUserId,
  );
  if (guestIdentity !== undefined) {
    await copyGuestObservedNames({
      winnerId: winner.personId,
      guestUserId: input.guestUserId,
      guestPersonId: guestIdentity.personId,
      displayName: input.displayName,
    });
  }
  const loserIds = [...new Set(scoped.map((identity) => identity.personId))].filter(
    (personId) => personId !== winner.personId,
  );
  await forEachSequential({
    items: loserIds,
    visit: async (loserId) => {
      await moveMemoryPersonRows({ winnerId: winner.personId, loserId });
      await replaceMemoryPersonReference({ winnerId: winner.personId, loserId });
      await consolidateTransferredProjections({ winnerId: winner.personId, loserId });
    },
  });
  await createIgnoringUniqueConflict(() =>
    db.memoryPersonIdentities.create({
      data: {
        personId: winner.personId,
        userId,
        workspaceId,
        kind: "user_id",
        identity: input.accountUserId,
      },
    }),
  );
  await db.memoryPeople.updateMany({
    where: { id: winner.personId },
    data: {
      name: input.accountName,
    },
  });
};

const assertLinkableGuestMemoryAccounts = (input: {
  account: Prisma.usersModel | undefined;
  guest: Prisma.usersModel | undefined;
}): { account: Prisma.usersModel; guest: Prisma.usersModel } => {
  if (
    input.account === undefined ||
    input.account.deletedAt !== null ||
    (input.account.source !== "auth" && input.account.source !== "dev_login") ||
    input.guest === undefined ||
    input.guest.source !== "guest"
  ) {
    throw new Error(INVALID_GUEST_ACCOUNT_LINK_MESSAGE);
  }

  return { account: input.account, guest: input.guest };
};

const readGuestLinkUser = (userId: string) =>
  mapRow({
    value: db.users.findFirst({
      where: { id: userId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
            plan: readStringUnion({
              values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
              value: row.plan,
            }),
          },
  });

const linkGuestMemoryAccount = async (input: { guestUserId: string; accountUserId: string }) => {
  const accountRow = await readGuestLinkUser(input.accountUserId);
  const guestRow = await readGuestLinkUser(input.guestUserId);
  const { account, guest } = assertLinkableGuestMemoryAccounts({ account: accountRow, guest: guestRow });
  const browserUser = await mapRow({
    value: db.guestBrowserUsers.findFirst({
      where: { guestUserId: input.guestUserId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });
  const existingLink = await mapRow({
    value: db.guestMemoryAccountLinks.findFirst({
      where: { guestUserId: input.guestUserId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });
  if (existingLink !== undefined && existingLink.accountUserId !== input.accountUserId) {
    throw new GuestSessionLinkConflictError(GUEST_RECOGNITION_IS_ALREADY_LINKED_TO_ANOTHER_ACCOUNT_MESSAGE);
  }
  const browserId = browserUser?.browserId;
  if (browserId !== undefined) {
    const browser = await mapRow({
      value: db.guestBrowserIdentities.findFirst({
        where: { id: browserId },
        take: 1,
      }),
      map: (row) => row ?? undefined,
    });
    if (
      browser?.linkedAccountUserId !== undefined &&
      browser.linkedAccountUserId !== null &&
      browser.linkedAccountUserId !== input.accountUserId
    ) {
      throw new GuestSessionLinkConflictError(GUEST_RECOGNITION_IS_ALREADY_LINKED_TO_ANOTHER_ACCOUNT_MESSAGE);
    }
  }
  await createIgnoringUniqueConflict(() =>
    db.guestMemoryAccountLinks.create({
      data: {
        guestUserId: input.guestUserId,
        accountUserId: input.accountUserId,
      },
    }),
  );
  if (browserId !== undefined) {
    await db.guestBrowserIdentities.updateMany({
      where: { id: browserId },
      data: {
        linkedAccountUserId: input.accountUserId,
      },
    });
  }
  const linkedBrowsers = await db.guestBrowserIdentities.findMany({
    where: { linkedAccountUserId: input.accountUserId },
    select: {
      id: true,
    },
  });
  const identities = await loadGuestMemoryIdentities({
    guestUserId: input.guestUserId,
    accountUserId: input.accountUserId,
    accountEmail: account.email.trim().toLowerCase(),
    browserIds: linkedBrowsers.map((browser) => browser.id),
  });
  const scopeKeys = [...new Set(identities.map((identity) => `${identity.userId}:${identity.workspaceId}`))].sort();
  await forEachSequential({
    items: scopeKeys,
    visit: async (scopeKey) => {
      await mergeGuestMemoryScope({
        guestUserId: input.guestUserId,
        accountUserId: input.accountUserId,
        accountName: account.displayName,
        displayName: guest.displayName,
        browserId,
        identities,
        scopeKey,
      });
    },
  });
};

const transferGuestMeetingAccessToUserWithin = async (args: {
  input: {
    guestUserId: string;
    targetUserId: string;
    targetWorkspaceId?: string;
  };
}) => {
  const { input } = args;

  // Match extraction: acquire the identity lock before any user row lock.
  // Its alias inserts need a foreign-key lock on this same guest row.
  // Serialize competing OAuth completions for the same guest identity.
  await db.users.findMany({
    where: { id: input.guestUserId },
    select: {
      id: true,
    },
  });
  const linkedSessions = await db.guestAuthSessions.findMany({
    where: whereAnd([{ userId: input.guestUserId }, { linkedToUserId: { not: null } }]),
    select: {
      linkedToUserId: true,
    },
  });
  if (linkedSessions.some((session) => session.linkedToUserId !== input.targetUserId)) {
    throw new GuestSessionLinkConflictError(GUEST_SESSION_IS_ALREADY_LINKED_TO_ANOTHER_ACCOUNT_MESSAGE);
  }
  const targetUser = await mapRow({
    value: db.users.findFirst({
      where: { id: input.targetUserId },
      take: 1,
      select: {
        id: true,
        email: true,
        displayName: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (!targetUser) {
    throw new Error(TARGET_USER_NOT_FOUND_MESSAGE);
  }

  await linkGuestMemoryAccount({ guestUserId: input.guestUserId, accountUserId: input.targetUserId });

  if (linkedSessions.length !== 0) {
    return [];
  }

  const { participantMeetingIds, confidentialityChanges } = await transferGuestMeetingParticipantsToUser({ input });
  await fileGuestTransferredMeetingAttendance({ input, participantMeetingIds });

  const reassignedTasks = await mapRowsSequentially({
    rows: await mapRow({
      value: db.meetingTasks.findMany({
        where: { ownerUserId: input.guestUserId },
      }),
      map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
    }),
    visit: async (storedRow) => {
      const updatedRows = await db.meetingTasks.updateManyAndReturn({
        where: { id: storedRow.id },
        data: {
          ownerUserId: targetUser.id,
          ownerName: targetUser.displayName,
          ownerEmail: targetUser.email,
          ownerConfidence: "high",
          revision: storedRow.revision + 1,
          updatedAt: new Date(),
        },
        select: { meetingId: true },
      });

      return updatedRows[0];
    },
  });

  await reassignGuestMeetingJoinRequestsToUser({ input, targetUser });

  await db.guestAuthSessions.updateMany({
    where: { userId: input.guestUserId },
    data: {
      linkedToUserId: input.targetUserId,
      revokedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await forEachSequential({ items: confidentialityChanges, visit: notifyMeetingConfidentialityChanged });

  return [...new Set([...participantMeetingIds, ...reassignedTasks.map((task) => task.meetingId)])];
};

export async function transferGuestMeetingAccessToUser(input: {
  guestUserId: string;
  targetUserId: string;
  targetWorkspaceId?: string;
}): Promise<string[]> {
  return (() => transferGuestMeetingAccessToUserWithin({ input }))();
}

const GUEST_ARCHIVE_AFTER_DAYS = 30;
const GUEST_ARCHIVE_AFTER_MS = GUEST_ARCHIVE_AFTER_DAYS * MILLISECONDS_PER_DAY;

export async function cleanupGuestMeetingSessions(
  input: {
    now?: Date;
  } = {},
): Promise<{ expiredSessionCount: number; expiredRequestCount: number; archivedGuestUserCount: number }> {
  const now = input.now ?? new Date();
  const waitingCutoff = new Date(now.getTime() - MILLISECONDS_PER_DAY);
  const archiveCutoff = new Date(now.getTime() - GUEST_ARCHIVE_AFTER_MS);
  const expiredSessions = await db.guestAuthSessions.updateManyAndReturn({
    where: whereAnd([{ expiresAt: { lte: now } }, { revokedAt: null }, { linkedToUserId: null }]),
    data: {
      revokedAt: now,
      updatedAt: now,
    },
    select: { joinRequestId: true },
  });
  const expiredRequestIds = new Set(expiredSessions.map((session) => session.joinRequestId));
  const waitingRequests = await mapRow({
    value: db.meetingJoinRequests.findMany({
      where: { status: "waiting" },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: readStringUnion({ values: ["waiting", "admitted", "denied", "expired", "revoked"], value: row.status }),
      })),
  });
  const requestsToExpire = waitingRequests.filter(
    (request) => request.requestedAt.getTime() <= waitingCutoff.getTime() || expiredRequestIds.has(request.id),
  );
  await forEachSequential({
    items: requestsToExpire,
    visit: async (request) => {
      await db.meetingJoinRequests.updateMany({
        where: { id: request.id },
        data: {
          status: "expired",
          decidedAt: request.decidedAt ?? now,
          updatedAt: now,
        },
      });
    },
  });
  const guestUsers = await db.users.findMany({
    where: whereAnd([{ source: "guest" }, { deletedAt: null }, { createdAt: { lt: archiveCutoff } }]),
    select: {
      id: true,
    },
  });
  const admittedRequests = await db.meetingJoinRequests.findMany({
    where: { status: "admitted" },
    select: {
      userId: true,
    },
  });
  const linkedSessions = await db.guestAuthSessions.findMany({
    where: { linkedToUserId: { not: null } },
    select: {
      userId: true,
    },
  });
  const blockedGuestIds = new Set([
    ...admittedRequests.map((request) => request.userId),
    ...linkedSessions.map((session) => session.userId),
  ]);
  const guestsToArchive = guestUsers.filter((guest) => !blockedGuestIds.has(guest.id));
  await forEachSequential({
    items: guestsToArchive,
    visit: async (guest) => {
      await db.users.updateMany({
        where: { id: guest.id },
        data: {
          deletedAt: now,
        },
      });
    },
  });

  return {
    expiredSessionCount: expiredSessions.length,
    expiredRequestCount: requestsToExpire.length,
    archivedGuestUserCount: guestsToArchive.length,
  };
}

/** Looks up the request's workspace, then publishes on its realtime channels. */
export async function publishMeetingJoinRequestRealtime(
  input: Omit<Parameters<typeof publishMeetingJoinRequestEvents>[0], "workspaceId">,
): Promise<void> {
  const meetingLink = await mapRow({
    value: db.meetingLinks.findFirst({
      where: { id: input.request.meetingLinkId },
      take: 1,
      select: {
        workspaceId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (!meetingLink) {
    throw new Error(MEETING_LINK_NOT_FOUND_FOR_JOIN_REQUEST_REALTIME_EVENT_MESSAGE);
  }

  await publishMeetingJoinRequestEvents({ ...input, workspaceId: meetingLink.workspaceId });
}

export async function getCalendarReadyLinkForProviderEvent(input: {
  userId: string;
  calendarAccountId: string;
  provider: string;
  calendarId: string;
  providerEventId: string;
}): Promise<{
  id: string;
  userId: string;
  calendarAccountId: string;
  provider: string;
  calendarId: string;
  providerEventId: string;
  meetingLinkId: string;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const row = await mapRow({
    value: db.calendarReadyLinks.findFirst({
      where: whereAnd([
        { userId: input.userId },
        { calendarAccountId: input.calendarAccountId },
        { provider: input.provider },
        { calendarId: input.calendarId },
        { providerEventId: input.providerEventId },
      ]),
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return row ?? null;
}

type ListCalendarReadyLinkMappingsForProviderEventsResult = Promise<
  {
    calendarReadyLink: {
      id: string;
      userId: string;
      calendarAccountId: string;
      provider: string;
      calendarId: string;
      providerEventId: string;
      meetingLinkId: string;
      createdAt: Date;
      updatedAt: Date;
    };
    meetingLink: {
      id: string;
      code: string;
      workspaceId: string;
      createdByUserId: string;
      title: string;
      status: string;
      createdAt: Date;
      updatedAt: Date;
    };
    callIn: {
      id: string;
      meetingLinkId: string;
      phoneNumber: string;
      pin: string;
      sipDispatchRuleId: string | null;
      dispatchRuleKind: string;
      lastSyncedMeetingId: string | null;
      status: string;
      lastSyncError: string | null;
      createdAt: Date;
      updatedAt: Date;
    } | null;
  }[]
>;
type rowsRow2 = {
  calendarReadyLink__id: string;
  calendarReadyLink__userId: string;
  calendarReadyLink__calendarAccountId: string;
  calendarReadyLink__provider: string;
  calendarReadyLink__calendarId: string;
  calendarReadyLink__providerEventId: string;
  calendarReadyLink__meetingLinkId: string;
  calendarReadyLink__createdAt: Date;
  calendarReadyLink__updatedAt: Date;
  meetingLink__id: string;
  meetingLink__code: string;
  meetingLink__workspaceId: string;
  meetingLink__createdByUserId: string;
  meetingLink__title: string;
  meetingLink__status: string;
  meetingLink__createdAt: Date;
  meetingLink__updatedAt: Date;
  callIn__id: string | null;
  callIn__meetingLinkId: string | null;
  callIn__phoneNumber: string | null;
  callIn__pin: string | null;
  callIn__sipDispatchRuleId: string | null;
  callIn__lastSyncedMeetingId: string | null;
  callIn__status: string | null;
  callIn__lastSyncError: string | null;
  callIn__createdAt: Date | null;
  callIn__updatedAt: Date | null;
  callIn__dispatchRuleKind: string | null;
};

const rowsSql1 = `
         SELECT "calendar_ready_links"."id" AS "calendarReadyLink__id",
         "calendar_ready_links"."user_id" AS "calendarReadyLink__userId",
         "calendar_ready_links"."calendar_account_id" AS "calendarReadyLink__calendarAccountId",
         "calendar_ready_links"."provider" AS "calendarReadyLink__provider",
         "calendar_ready_links"."calendar_id" AS "calendarReadyLink__calendarId",
         "calendar_ready_links"."provider_event_id" AS "calendarReadyLink__providerEventId",
         "calendar_ready_links"."meeting_link_id" AS "calendarReadyLink__meetingLinkId",
         "calendar_ready_links"."created_at" AS "calendarReadyLink__createdAt",
         "calendar_ready_links"."updated_at" AS "calendarReadyLink__updatedAt",
         "meeting_links"."id" AS "meetingLink__id",
         "meeting_links"."code" AS "meetingLink__code",
         "meeting_links"."workspace_id" AS "meetingLink__workspaceId",
         "meeting_links"."created_by_user_id" AS "meetingLink__createdByUserId",
         "meeting_links"."title" AS "meetingLink__title",
         "meeting_links"."status" AS "meetingLink__status",
         "meeting_links"."created_at" AS "meetingLink__createdAt",
         "meeting_links"."updated_at" AS "meetingLink__updatedAt",
         "meeting_link_call_ins"."id" AS "callIn__id",
         "meeting_link_call_ins"."meeting_link_id" AS "callIn__meetingLinkId",
         "meeting_link_call_ins"."phone_number" AS "callIn__phoneNumber",
         "meeting_link_call_ins"."pin" AS "callIn__pin",
         "meeting_link_call_ins"."sip_dispatch_rule_id" AS "callIn__sipDispatchRuleId",
         "meeting_link_call_ins"."last_synced_meeting_id" AS "callIn__lastSyncedMeetingId",
         "meeting_link_call_ins"."status" AS "callIn__status",
         "meeting_link_call_ins"."last_sync_error" AS "callIn__lastSyncError",
         "meeting_link_call_ins"."created_at" AS "callIn__createdAt",
         "meeting_link_call_ins"."updated_at" AS "callIn__updatedAt",
         "meeting_link_call_ins"."dispatch_rule_kind" AS "callIn__dispatchRuleKind"
         FROM "calendar_ready_links"
         INNER JOIN "meeting_links" ON `;

export async function listCalendarReadyLinkMappingsForProviderEvents(input: {
  userId: string;
  calendarAccountId: string;
  provider: string;
  calendarId: string;
  providerEventKeys: string[];
}): ListCalendarReadyLinkMappingsForProviderEventsResult {
  const providerEventKeys = Array.from(new Set(input.providerEventKeys.map((key) => key.trim()).filter(Boolean)));
  if (providerEventKeys.length === 0) {
    return [];
  }

  return (async () => {
    const where7 = sqlAnd([
      sqlCompare({ columnSql: '"calendar_ready_links"."user_id"', operator: "=", value: input.userId, cast: "uuid" }),
      sqlCompare({
        columnSql: '"calendar_ready_links"."calendar_account_id"',
        operator: "=",
        value: input.calendarAccountId,
        cast: "uuid",
      }),
      sqlCompare({ columnSql: '"calendar_ready_links"."provider"', operator: "=", value: input.provider, cast: null }),
      sqlCompare({
        columnSql: '"calendar_ready_links"."calendar_id"',
        operator: "=",
        value: input.calendarId,
        cast: null,
      }),
      sqlIn({
        columnSql: '"calendar_ready_links"."provider_event_id"',
        values: providerEventKeys,
        cast: null,
        isNegated: false,
      }),
    ]);
    const join70 = sqlColCompare({
      leftSql: '"meeting_links"."id"',
      operator: "=",
      rightSql: '"calendar_ready_links"."meeting_link_id"',
    });
    const join71 = sqlColCompare({
      leftSql: '"meeting_link_call_ins"."meeting_link_id"',
      operator: "=",
      rightSql: '"meeting_links"."id"',
    });
    const rows = await decodeContentAliases({
      rows: await db.$queryRaw<rowsRow2[]>`${Prisma.raw(rowsSql1)}${join70}
         LEFT JOIN "meeting_link_call_ins" ON ${join71}
         ${sqlWhereClause(where7)}





         `,
      projections: [contentProjection({ model: "meetingLinks", prefix: "meetingLink__" })],
    });

    return rows.map((row) => ({
      calendarReadyLink: {
        id: row.calendarReadyLink__id,
        userId: row.calendarReadyLink__userId,
        calendarAccountId: row.calendarReadyLink__calendarAccountId,
        provider: row.calendarReadyLink__provider,
        calendarId: row.calendarReadyLink__calendarId,
        providerEventId: row.calendarReadyLink__providerEventId,
        meetingLinkId: row.calendarReadyLink__meetingLinkId,
        createdAt: row.calendarReadyLink__createdAt,
        updatedAt: row.calendarReadyLink__updatedAt,
      },
      meetingLink: {
        id: row.meetingLink__id,
        code: row.meetingLink__code,
        workspaceId: row.meetingLink__workspaceId,
        createdByUserId: row.meetingLink__createdByUserId,
        title: row.meetingLink__title,
        status: row.meetingLink__status,
        createdAt: row.meetingLink__createdAt,
        updatedAt: row.meetingLink__updatedAt,
      },
      callIn:
        row.callIn__id === null
          ? null
          : {
              id: row.callIn__id,
              meetingLinkId: readStoredString(row.callIn__meetingLinkId),
              phoneNumber: readStoredString(row.callIn__phoneNumber),
              pin: readStoredString(row.callIn__pin),
              sipDispatchRuleId: row.callIn__sipDispatchRuleId,
              lastSyncedMeetingId: row.callIn__lastSyncedMeetingId,
              status: readStoredString(row.callIn__status),
              lastSyncError: row.callIn__lastSyncError,
              createdAt: readDate(row.callIn__createdAt),
              updatedAt: readDate(row.callIn__updatedAt),
              dispatchRuleKind: readStoredString(row.callIn__dispatchRuleKind),
            },
    }));
  })();
}

export async function createCalendarReadyLinkMapping(input: {
  userId: string;
  calendarAccountId: string;
  provider: string;
  calendarId: string;
  providerEventId: string;
  meetingLinkId: string;
}): Promise<{
  id: string;
  createdAt: Date;
  userId: string;
  provider: string;
  updatedAt: Date;
  meetingLinkId: string;
  calendarId: string;
  calendarAccountId: string;
  providerEventId: string;
}> {
  // providerEventId stores the semantic provider event key: recurring master id when present,
  // otherwise the literal provider event id for one-off events.
  const row = await db.calendarReadyLinks.create({ data: input });

  return row;
}
type resultRow3 = {
  id: string;
  title: string;
  roomName: string;
  createdByUserId: string;
  status: "scheduled" | "active" | "ended";
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
  workspaceId: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  kind: MeetingKind;
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual";
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  agentIntroKey: string | null;
  currentLinkKey: string | null;
};

const resultSql2 = `
                            SELECT "meetings"."id" AS "id",
                            "meetings"."title" AS "title",
                            "meetings"."room_name" AS "roomName",
                            "meetings"."created_by_user_id" AS "createdByUserId",
                            "meetings"."status" AS "status",
                            "meetings"."created_at" AS "createdAt",
                            "meetings"."started_at" AS "startedAt",
                            "meetings"."ended_at" AS "endedAt",
                            "meetings"."hidden_from_history_at" AS "hiddenFromHistoryAt",
                            "meetings"."hidden_from_history_reason" AS "hiddenFromHistoryReason",
                            "meetings"."workspace_id" AS "workspaceId",
                            "meetings"."meeting_link_id" AS "meetingLinkId",
                            "meetings"."instance_number" AS "instanceNumber",
                            "meetings"."kind" AS "kind",
                            "meetings"."is_confidential" AS "isConfidential",
                            "meetings"."confidentiality_source" AS "confidentialitySource",
                            "meetings"."confidentiality_updated_by_user_id" AS "confidentialityUpdatedByUserId",
                            "meetings"."confidentiality_updated_at" AS "confidentialityUpdatedAt",
                            "meetings"."agent_intro_key" AS "agentIntroKey",
                            "meetings"."current_link_key" AS "currentLinkKey"
                            FROM "meetings"

                            `;

const readParticipantRole = (row: { role: string }) =>
  readStringUnion({ values: ["host", "guest", "assistant"], value: row.role });

const closeEndedParticipantPresence = async (args: {
  tx: AccountTransaction;
  meetingId: string;
  userId: string;
  role: "host" | "guest" | "assistant";
  leftAt: Date;
  existing:
    | {
        id: string;
        leftAt: Date | null;
        role: "host" | "guest" | "assistant";
        userId: string;
        meetingId: string;
        joinedAt: Date;
      }
    | undefined;
}) => {
  const { tx, meetingId, userId, role, leftAt, existing } = args;
  if (existing) {
    if (existing.leftAt) {
      return existing;
    }
    const [updated] = await mapRow({
      value: tx.meetingParticipants.updateManyAndReturn({
        where: { id: existing.id },
        data: { leftAt },
      }),
      map: (rows) => rows.map((row) => ({ ...row, role: readParticipantRole(row) })),
    });
    if (!updated) {
      throw new Error(FAILED_TO_CLOSE_ENDED_PARTICIPANT_PRESENCE_MESSAGE);
    }

    return updated;
  }

  return mapRow({
    value: tx.meetingParticipants.create({
      data: { meetingId, userId, role, joinedAt: leftAt, leftAt },
    }),
    map: (row) => ({ ...row, role: readParticipantRole(row) }),
  });
};

const openParticipantPresence = async (args: {
  tx: AccountTransaction;
  meetingId: string;
  userId: string;
  role: "host" | "guest" | "assistant";
  existing:
    | {
        id: string;
        leftAt: Date | null;
        role: "host" | "guest" | "assistant";
        userId: string;
        meetingId: string;
        joinedAt: Date;
      }
    | undefined;
}) => {
  const { tx, meetingId, userId, role, existing } = args;
  if (existing) {
    const [updated] = await mapRow({
      value: tx.meetingParticipants.updateManyAndReturn({
        where: { id: existing.id },
        data: {
          role: existing.role === "host" ? existing.role : role,
          joinedAt: new Date(),
          leftAt: null,
        },
      }),
      map: (rows) => rows.map((row) => ({ ...row, role: readParticipantRole(row) })),
    });
    if (!updated) {
      throw new Error(FAILED_TO_UPDATE_PARTICIPANT_PRESENCE_MESSAGE);
    }

    return updated;
  }

  return mapRow({
    value: tx.meetingParticipants.create({
      data: { meetingId, userId, role, leftAt: null },
    }),
    map: (row) => ({ ...row, role: readParticipantRole(row) }),
  });
};

export async function upsertParticipantPresence(input: {
  meetingId: string;
  userId: string;
  role?: "host" | "guest" | "assistant";
}): Promise<{
  id: string;
  userId: string;
  role: "host" | "guest" | "assistant";
  meetingId: string;
  joinedAt: Date;
  leftAt: Date | null;
}> {
  const result = await db.$transaction(async (tx) => {
    const [meeting] = await (async () => {
      const where8 = sqlCompare({ columnSql: '"meetings"."id"', operator: "=", value: input.meetingId, cast: "uuid" });

      return decodeContentAliases({
        rows: await tx.$queryRaw<resultRow3[]>`${Prisma.raw(resultSql2)}${sqlWhereClause(where8)}




                            FOR UPDATE
                            `,
        projections: [contentProjection({ model: "meetings" })],
      });
    })();
    // Joining a meeting no longer enrolls the participant into the meeting's
    // workspace: membership is invitation-managed, and workspace membership now
    // grants visibility into every non-confidential workspace meeting.
    const role = input.role ?? "guest";
    const existing = await mapRow({
      value: tx.meetingParticipants.findFirst({
        where: whereAnd([{ meetingId: input.meetingId }, { userId: input.userId }]),
        take: 1,
      }),
      map: (row) => (row === null ? undefined : { ...row, role: readParticipantRole(row) }),
    });
    const participant =
      meeting?.status === "ended"
        ? await closeEndedParticipantPresence({
            tx,
            meetingId: input.meetingId,
            userId: input.userId,
            role,
            leftAt: meeting.endedAt ?? new Date(),
            existing,
          })
        : await openParticipantPresence({
            tx,
            meetingId: input.meetingId,
            userId: input.userId,
            role,
            existing,
          });
    const confidentialityChange = await autoMarkMeetingConfidentialInTransaction({
      meetingId: input.meetingId,
      connection: tx,
    });

    return { participant, confidentialityChange };
  });
  if (result.confidentialityChange) {
    await notifyMeetingConfidentialityChanged(result.confidentialityChange);
  }

  return result.participant;
}

export async function ensureMeetingParticipantRecord(input: {
  meetingId: string;
  userId: string;
  role?: "host" | "guest" | "assistant";
}): Promise<{
  id: string;
  userId: string;
  role: "host" | "guest" | "assistant";
  meetingId: string;
  joinedAt: Date;
  leftAt: Date | null;
}> {
  const result = await db.$transaction(async (tx) => {
    await (async () => {
      const where9 = sqlCompare({ columnSql: '"meetings"."id"', operator: "=", value: input.meetingId, cast: "uuid" });

      return tx.$queryRaw<{ id: string }[]>`
          SELECT "meetings"."id" AS "id"
          FROM "meetings"

          ${sqlWhereClause(where9)}




          FOR UPDATE
          `;
    })();
    const participant = await (async () => {
      const role = input.role ?? "guest";
      const existing = await mapRow({
        value: tx.meetingParticipants.findFirst({
          where: whereAnd([{ meetingId: input.meetingId }, { userId: input.userId }]),
          take: 1,
        }),
        map: (row) =>
          row === null
            ? undefined
            : { ...row, role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }) },
      });

      if (existing) {
        if (existing.role === "host" || existing.role === role) {
          return existing;
        }

        const [updated] = await mapRow({
          value: tx.meetingParticipants.updateManyAndReturn({
            where: { id: existing.id },
            data: {
              role,
            },
          }),
          map: (rows) =>
            rows.map((row) => ({
              ...row,
              role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
            })),
        });

        if (!updated) {
          throw new Error(FAILED_TO_UPDATE_PARTICIPANT_RECORD_MESSAGE);
        }

        return updated;
      }

      const placeholderTime = new Date(0);
      const participant = await mapRow({
        value: tx.meetingParticipants.create({
          data: {
            meetingId: input.meetingId,
            userId: input.userId,
            role,
            joinedAt: placeholderTime,
            leftAt: placeholderTime,
          },
        }),
        map: (row) => ({
          ...row,
          role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
        }),
      });

      return participant;
    })();
    const confidentialityChange = await autoMarkMeetingConfidentialInTransaction({
      meetingId: input.meetingId,
      connection: tx,
    });

    return { participant, confidentialityChange };
  });
  if (result.confidentialityChange) {
    await notifyMeetingConfidentialityChanged(result.confidentialityChange);
  }

  return result.participant;
}

export async function markParticipantLeft(input: { meetingId: string; userId: string }): Promise<{
  id: string;
  meetingId: string;
  userId: string;
  role: "host" | "guest" | "assistant";
  joinedAt: Date;
  leftAt: Date | null;
} | null> {
  const [updated] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.meetingParticipants.findMany({
        where: whereAnd([{ meetingId: input.meetingId }, { userId: input.userId }]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
        })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.meetingParticipants.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            leftAt: storedRow.leftAt ?? new Date(),
          },
        }),
        map: (rows) =>
          rows.map((row) => ({
            ...row,
            role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
          })),
      });

      return updatedRows[0];
    },
  });

  return updated ?? null;
}

export async function markAllHumanParticipantsLeft(meetingId: string): Promise<
  {
    id: string;
    meetingId: string;
    userId: string;
    role: "host" | "guest" | "assistant";
    joinedAt: Date;
    leftAt: Date | null;
  }[]
> {
  return mapRowsSequentially({
    rows: await mapRow({
      value: db.meetingParticipants.findMany({
        where: whereAnd([{ meetingId }, { role: { in: ["host", "guest"] } }]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
        })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.meetingParticipants.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            leftAt: storedRow.leftAt ?? new Date(),
          },
        }),
        map: (rows) =>
          rows.map((row) => ({
            ...row,
            role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
          })),
      });

      return updatedRows[0];
    },
  });
}

export async function removeParticipantFromMeeting(input: { meetingId: string; userId: string }): Promise<boolean> {
  const result = await db.$transaction(async (tx) => {
    await (async () => {
      const where10 = sqlCompare({ columnSql: '"meetings"."id"', operator: "=", value: input.meetingId, cast: "uuid" });

      return tx.$queryRaw<
        {
          id: string;
        }[]
      >`
          SELECT "meetings"."id" AS "id"
          FROM "meetings"

          ${sqlWhereClause(where10)}




          FOR UPDATE
          `;
    })();
    const removed = await (async () => {
      const where11 = sqlAnd([
        sqlCompare({
          columnSql: '"meeting_participants"."meeting_id"',
          operator: "=",
          value: input.meetingId,
          cast: "uuid",
        }),
        sqlCompare({ columnSql: '"meeting_participants"."user_id"', operator: "=", value: input.userId, cast: "uuid" }),
      ]);

      return tx.$queryRaw<
        {
          id: string;
        }[]
      >`
                          DELETE FROM "meeting_participants"
                          ${sqlWhereClause(where11)}
                          RETURNING "id" AS "id"
                          `;
    })();
    const confidentialityChange = await autoMarkMeetingConfidentialInTransaction({
      meetingId: input.meetingId,
      connection: tx,
    });

    return { isRemoved: removed.length !== 0, confidentialityChange };
  });
  if (result.confidentialityChange) {
    await notifyMeetingConfidentialityChanged(result.confidentialityChange);
  }

  return result.isRemoved;
}

export async function isMeetingParticipant(input: { meetingId: string; userId: string }): Promise<boolean> {
  const participant = await mapRow({
    value: db.meetingParticipants.findFirst({
      where: whereAnd([{ meetingId: input.meetingId }, { userId: input.userId }]),
      take: 1,
      select: {
        id: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  return Boolean(participant);
}
export async function listParticipantMeetingChannelsForUser(userId: string): Promise<
  {
    meetingId: string;
    workspaceId: string;
  }[]
> {
  return (async () => {
    const where12 = sqlAnd([
      sqlCompare({ columnSql: '"meeting_participants"."user_id"', operator: "=", value: userId, cast: "uuid" }),
      sqlNot(
        sqlExists(
          (() => {
            const existsWhere13 = sqlAnd([
              sqlColCompare({
                leftSql: '"workspace_memberships"."workspace_id"',
                operator: "=",
                rightSql: '"meetings"."workspace_id"',
              }),
              sqlCompare({
                columnSql: '"workspace_memberships"."user_id"',
                operator: "=",
                value: userId,
                cast: "uuid",
              }),
              sqlCompare({
                columnSql: '"workspace_memberships"."status"',
                operator: "=",
                value: "suspended",
                cast: null,
              }),
            ]);

            return Prisma.sql`SELECT 1 FROM "workspace_memberships"  ${sqlWhereClause(existsWhere13)}`;
          })(),
        ),
      ),
    ]);
    const join120 = sqlColCompare({
      leftSql: '"meetings"."id"',
      operator: "=",
      rightSql: '"meeting_participants"."meeting_id"',
    });
    const order12 = sqlOrderBy([sqlSort({ columnSql: '"meetings"."created_at"', direction: "DESC" })]);

    return db.$queryRaw<
      {
        meetingId: string;
        workspaceId: string;
      }[]
    >`
         SELECT "meeting_participants"."meeting_id" AS "meetingId",
         "meetings"."workspace_id" AS "workspaceId"
         FROM "meeting_participants"
         INNER JOIN "meetings" ON ${join120}
         ${sqlWhereClause(where12)}

         ${order12}



         `;
  })();
}
export async function listHostJoinRequestChannelsForUser(userId: string): Promise<
  {
    meetingId: string;
    workspaceId: string;
  }[]
> {
  const rows = await (async () => {
    const where14 = sqlAnd([
      sqlIn({ columnSql: '"meetings"."status"', values: ["scheduled", "active"], cast: null, isNegated: false }),
      sqlOr([
        sqlCompare({ columnSql: '"meetings"."created_by_user_id"', operator: "=", value: userId, cast: "uuid" }),
        sqlCompare({ columnSql: '"meeting_participants"."role"', operator: "=", value: "host", cast: null }),
      ]),
      sqlNot(
        sqlExists(
          (() => {
            const existsWhere15 = sqlAnd([
              sqlColCompare({
                leftSql: '"workspace_memberships"."workspace_id"',
                operator: "=",
                rightSql: '"meetings"."workspace_id"',
              }),
              sqlCompare({
                columnSql: '"workspace_memberships"."user_id"',
                operator: "=",
                value: userId,
                cast: "uuid",
              }),
              sqlCompare({
                columnSql: '"workspace_memberships"."status"',
                operator: "=",
                value: "suspended",
                cast: null,
              }),
            ]);

            return Prisma.sql`SELECT 1 FROM "workspace_memberships"  ${sqlWhereClause(existsWhere15)}`;
          })(),
        ),
      ),
    ]);
    const join140 = sqlAnd([
      sqlColCompare({ leftSql: '"meeting_participants"."meeting_id"', operator: "=", rightSql: '"meetings"."id"' }),
      sqlCompare({ columnSql: '"meeting_participants"."user_id"', operator: "=", value: userId, cast: "uuid" }),
    ]);
    const order14 = sqlOrderBy([sqlSort({ columnSql: '"meetings"."created_at"', direction: "DESC" })]);

    return db.$queryRaw<
      {
        meetingId: string;
        workspaceId: string;
      }[]
    >`
                     SELECT "meetings"."id" AS "meetingId",
                     "meetings"."workspace_id" AS "workspaceId"
                     FROM "meetings"
                     LEFT JOIN "meeting_participants" ON ${join140}
                     ${sqlWhereClause(where14)}

                     ${order14}



                     `;
  })();

  return [...new Map(rows.map((row) => [row.meetingId, row])).values()];
}
export async function listActiveJoinRequestChannelsForUser(userId: string): Promise<
  {
    requestId: string;
    workspaceId: string;
  }[]
> {
  return (async () => {
    const where16 = sqlAnd([
      sqlCompare({ columnSql: '"meeting_join_requests"."user_id"', operator: "=", value: userId, cast: "uuid" }),
      sqlIn({
        columnSql: '"meeting_join_requests"."status"',
        values: [...ACTIVE_MEETING_JOIN_REQUEST_STATUSES],
        cast: null,
        isNegated: false,
      }),
      sqlNot(
        sqlExists(
          (() => {
            const existsWhere17 = sqlAnd([
              sqlColCompare({
                leftSql: '"workspace_memberships"."workspace_id"',
                operator: "=",
                rightSql: '"meeting_links"."workspace_id"',
              }),
              sqlCompare({
                columnSql: '"workspace_memberships"."user_id"',
                operator: "=",
                value: userId,
                cast: "uuid",
              }),
              sqlCompare({
                columnSql: '"workspace_memberships"."status"',
                operator: "=",
                value: "suspended",
                cast: null,
              }),
            ]);

            return Prisma.sql`SELECT 1 FROM "workspace_memberships"  ${sqlWhereClause(existsWhere17)}`;
          })(),
        ),
      ),
    ]);
    const join160 = sqlColCompare({
      leftSql: '"meeting_links"."id"',
      operator: "=",
      rightSql: '"meeting_join_requests"."meeting_link_id"',
    });
    const order16 = sqlOrderBy([sqlSort({ columnSql: '"meeting_join_requests"."updated_at"', direction: "DESC" })]);

    return db.$queryRaw<
      {
        requestId: string;
        workspaceId: string;
      }[]
    >`
         SELECT "meeting_join_requests"."id" AS "requestId",
         "meeting_links"."workspace_id" AS "workspaceId"
         FROM "meeting_join_requests"
         INNER JOIN "meeting_links" ON ${join160}
         ${sqlWhereClause(where16)}

         ${order16}



         `;
  })();
}

type ListMeetingsForUserResult = Promise<
  {
    id: string;
    workspaceId: string;
    title: string;
    roomName: string;
    meetingLinkId: string | null;
    instanceNumber: number;
    createdByUserId: string;
    kind: MeetingKind;
    status: "scheduled" | "active" | "ended";
    createdAt: Date;
    startedAt: Date | null;
    endedAt: Date | null;
  }[]
>;

export async function listMeetingsForUser(userId: string): ListMeetingsForUserResult {
  return (async () => {
    const where18 = sqlAnd([
      sqlCompare({ columnSql: '"meeting_participants"."user_id"', operator: "=", value: userId, cast: "uuid" }),
      sqlOr([
        sqlCompare({ columnSql: '"meetings"."kind"', operator: "<>", value: "agent_intro", cast: null }),
        sqlCompare({ columnSql: '"meetings"."status"', operator: "=", value: "ended", cast: null }),
      ]),
      sqlIsNull({ columnSql: '"meetings"."hidden_from_history_at"', isNegated: false }),
    ]);
    const join180 = sqlColCompare({
      leftSql: '"meeting_participants"."meeting_id"',
      operator: "=",
      rightSql: '"meetings"."id"',
    });
    const order18 = sqlOrderBy([sqlSort({ columnSql: '"meetings"."created_at"', direction: "DESC" })]);

    return decodeContentAliases({
      rows: await db.$queryRaw<
        {
          id: string;
          workspaceId: string;
          title: string;
          roomName: string;
          meetingLinkId: string | null;
          instanceNumber: number;
          createdByUserId: string;
          kind: MeetingKind;
          status: "scheduled" | "active" | "ended";
          createdAt: Date;
          startedAt: Date | null;
          endedAt: Date | null;
        }[]
      >`
         SELECT "meetings"."id" AS "id",
         "meetings"."workspace_id" AS "workspaceId",
         "meetings"."title" AS "title",
         "meetings"."room_name" AS "roomName",
         "meetings"."meeting_link_id" AS "meetingLinkId",
         "meetings"."instance_number" AS "instanceNumber",
         "meetings"."created_by_user_id" AS "createdByUserId",
         "meetings"."kind" AS "kind",
         "meetings"."status" AS "status",
         "meetings"."created_at" AS "createdAt",
         "meetings"."started_at" AS "startedAt",
         "meetings"."ended_at" AS "endedAt"
         FROM "meetings"
         INNER JOIN "meeting_participants" ON ${join180}
         ${sqlWhereClause(where18)}

         ${order18}



         `,
      projections: [contentProjection({ model: "meetings" })],
    });
  })();
}

export async function hasUserCreatedStandardMeeting(userId: string): Promise<boolean> {
  const row = await mapRow({
    value: db.meetings.findFirst({
      where: whereAnd([
        { createdByUserId: userId },
        { kind: "standard" },
        whereOr([{ hiddenFromHistoryReason: null }, { hiddenFromHistoryReason: { not: "debug_onboarding_reset" } }]),
      ]),
      take: 1,
      select: {
        id: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  return Boolean(row);
}

export async function countUserCreatedStandardMeetings(userId: string): Promise<number> {
  const rows = await db.meetings.findMany({
    where: whereAnd([
      { createdByUserId: userId },
      { kind: "standard" },
      whereOr([{ hiddenFromHistoryReason: null }, { hiddenFromHistoryReason: { not: "debug_onboarding_reset" } }]),
    ]),
    select: {
      id: true,
    },
  });

  return rows.length;
}

type MarkUserAgentIntroCompletedResult = Promise<
  | ({
      id: string;
      email: string;
      displayName: string;
      avatarUrl: string | null;
      source: "guest" | "auth" | "dev_login" | "debug_import";
      plan: "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
      privateBetaProEnabledAt: Date | null;
      hasCompletedFirstMeeting: boolean;
      lastSeenAt: Date | null;
      activeWorkspaceId: string | null;
      agentIntroCompletedAt: Date | null;
      sessionVersion: number;
      deletedAt: Date | null;
      createdAt: Date;
    } & { workspaceId: string })
  | null
>;

export async function markUserAgentIntroCompleted(userId: string): MarkUserAgentIntroCompletedResult {
  const [user] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.users.findMany({
        where: { id: userId },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
          plan: readStringUnion({
            values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
            value: row.plan,
          }),
        })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.users.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            agentIntroCompletedAt: storedRow.agentIntroCompletedAt ?? new Date(),
          },
        }),
        map: (rows) =>
          rows.map((row) => ({
            ...row,
            source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
            plan: readStringUnion({
              values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
              value: row.plan,
            }),
          })),
      });

      return updatedRows[0];
    },
  });

  if (!user) {
    return null;
  }

  const workspaceId = await ensureDefaultWorkspaceForUser({
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  });

  return toUserWithWorkspace({ user, workspaceId });
}

type GetMeetingByIdResult = Promise<{
  id: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  workspaceId: string;
  createdByUserId: string;
  kind: MeetingKind;
  status: "scheduled" | "active" | "ended";
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
} | null>;

export async function getMeetingById(...args: [meetingId: string, connection?: DbConnection]): GetMeetingByIdResult {
  const [meetingId, connection = db] = args;
  const meeting = await mapRow({
    value: connection.meetings.findFirst({
      where: { id: meetingId },
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredMeeting(row)),
  });

  return meeting ?? null;
}

function formatPersonalAssistantDisplayName(displayName: string) {
  const normalized = displayName.trim().replace(/\s+/g, " ");
  const firstName = normalized.split(" ").find(Boolean) ?? "Participant";

  return `${firstName}'s Assistant`;
}

async function ensureDefaultWebSearchAccess(input: { userId: string; agentProfileId: string }) {
  const existingConnector = await mapRow({
    value: db.agentConnectors.findFirst({
      where: whereAnd([
        { userId: input.userId },
        { agentProfileId: input.agentProfileId },
        { provider: WEB_SEARCH_CONNECTOR_PROVIDER },
      ]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            scopes: readStringArray(row.scopes),
            accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
          },
  });

  if (!existingConnector) {
    await createIgnoringUniqueConflict(() =>
      db.agentConnectors.create({
        data: {
          userId: input.userId,
          agentProfileId: input.agentProfileId,
          provider: WEB_SEARCH_CONNECTOR_PROVIDER,
          status: "connected",
          scope: "private",
        },
      }),
    );
  }

  const existingPolicy = await mapRow({
    value: db.agentToolPolicies.findFirst({
      where: whereAnd([{ agentProfileId: input.agentProfileId }, { toolName: WEB_SEARCH_TOOL_NAME }]),
      take: 1,
    }),
    map: (row) => (row === null ? undefined : { ...row, config: readJsonObject(row.config) }),
  });

  if (!existingPolicy) {
    await createIgnoringUniqueConflict(() =>
      db.agentToolPolicies.create({
        data: {
          agentProfileId: input.agentProfileId,
          toolName: WEB_SEARCH_TOOL_NAME,
          mode: "private",
          config: jsonInput({
            /** @external existing wire contract */ enabled: true,
            provider: "parallel",
            connectorProvider: WEB_SEARCH_CONNECTOR_PROVIDER,
            searchContextSize: "medium",
          }),
        },
      }),
    );
  }
}

type EnsureDefaultAgentProfileForUserResult = Promise<{
  id: string;
  name: string;
  displayName: string;
  createdAt: Date;
  userId: string;
  updatedAt: Date;
  systemPrompt: string | null;
  voiceProvider: string;
  voiceId: string | null;
  llmModel: string | null;
  isDefault: boolean;
}>;

export async function ensureDefaultAgentProfileForUser(input: {
  userId: string;
  displayName: string;
  voiceId?: string | null;
  llmModel?: string | null;
}): EnsureDefaultAgentProfileForUserResult {
  return (async () => {
    // Concurrent callers share one default profile via the unique default_profile_key.
    const existing = await mapRow({
      value: db.agentProfiles.findFirst({
        where: whereAnd([{ userId: input.userId }, { isDefault: true }]),
        take: 1,
      }),
      map: (row) => row ?? undefined,
    });

    if (existing) {
      await ensureDefaultWebSearchAccess({ userId: input.userId, agentProfileId: existing.id });

      return existing;
    }

    await createIgnoringUniqueConflict(() =>
      db.agentProfiles.create({
        data: {
          userId: input.userId,
          name: "default",
          displayName: formatPersonalAssistantDisplayName(input.displayName),
          voiceProvider: "openai",
          voiceId: input.voiceId ?? null,
          llmModel: input.llmModel ?? null,
          isDefault: true,
        },
      }),
    );

    const created = await mapRow({
      value: db.agentProfiles.findFirst({
        where: whereAnd([{ userId: input.userId }, { isDefault: true }]),
        take: 1,
      }),
      map: (row) => row ?? undefined,
    });

    if (!created) {
      throw new Error(FAILED_TO_CREATE_DEFAULT_AGENT_PROFILE_MESSAGE);
    }

    await ensureDefaultWebSearchAccess({ userId: input.userId, agentProfileId: created.id });

    return created;
  })();
}

type GetActiveMeetingTurnResult = Promise<{
  id: string;
  meetingId: string;
  ownerUserId: string;
  ownerParticipantIdentity: string;
  agentProfileId: string;
  assistantDisplayName: string;
  voiceId: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getActiveMeetingTurn(meetingId: string): GetActiveMeetingTurnResult {
  const turn = await mapRow({
    value: db.meetingTurns.findFirst({
      where: whereAnd([{ meetingId }, { status: "active" }]),
      orderBy: [{ startedAt: "desc" }],
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return turn ?? null;
}

type CreateMeetingTurnLeaseResult = Promise<{
  status: string;
  id: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date;
  endedAt: Date | null;
  meetingId: string;
  voiceId: string | null;
  ownerUserId: string;
  ownerParticipantIdentity: string;
  agentProfileId: string;
  assistantDisplayName: string;
}>;

export async function createMeetingTurnLease(input: {
  meetingId: string;
  ownerUserId: string;
  ownerParticipantIdentity: string;
  agentProfileId: string;
  assistantDisplayName: string;
  voiceId?: string | null;
}): CreateMeetingTurnLeaseResult {
  try {
    const turn = await db.meetingTurns.create({
      data: {
        meetingId: input.meetingId,
        ownerUserId: input.ownerUserId,
        ownerParticipantIdentity: input.ownerParticipantIdentity,
        agentProfileId: input.agentProfileId,
        assistantDisplayName: input.assistantDisplayName,
        voiceId: input.voiceId ?? null,
        status: "active",
      },
    });

    return turn;
  } catch (error) {
    if (isMeetingTurnConflictError(error)) {
      const activeTurn = await getActiveMeetingTurn(input.meetingId);
      throw new ActiveMeetingTurnConflictError(activeTurn);
    }
    throw error;
  }
}

type UpdateMeetingTurnLeaseResult = Promise<{
  id: string;
  meetingId: string;
  ownerUserId: string;
  ownerParticipantIdentity: string;
  agentProfileId: string;
  assistantDisplayName: string;
  voiceId: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function updateMeetingTurnLease(
  ...args: [
    meetingTurnId: string,
    input: {
      status: Exclude<MeetingTurnStatus, "active">;
      ownerUserId: string;
      ownerParticipantIdentity: string;
    },
  ]
): UpdateMeetingTurnLeaseResult {
  const [meetingTurnId, input] = args;
  const [turn] = await db.meetingTurns.updateManyAndReturn({
    where: whereAnd([
      { id: meetingTurnId },
      { ownerUserId: input.ownerUserId },
      { ownerParticipantIdentity: input.ownerParticipantIdentity },
      { status: "active" },
    ]),
    data: {
      status: input.status,
      endedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  return turn ?? null;
}

type GetDefaultAgentProfileForUserResult = Promise<{
  id: string;
  userId: string;
  name: string;
  displayName: string;
  systemPrompt: string | null;
  voiceProvider: string;
  voiceId: string | null;
  llmModel: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getDefaultAgentProfileForUser(userId: string): GetDefaultAgentProfileForUserResult {
  return (async () => {
    const profile = await mapRow({
      value: db.agentProfiles.findFirst({
        where: whereAnd([{ userId }, { isDefault: true }]),
        take: 1,
      }),
      map: (row) => row ?? undefined,
    });

    if (profile) {
      await ensureDefaultWebSearchAccess({ userId, agentProfileId: profile.id });
    }

    return profile ?? null;
  })();
}

type UpdateDefaultAgentProfileForUserResult = Promise<{
  id: string;
  name: string;
  displayName: string;
  createdAt: Date;
  userId: string;
  updatedAt: Date;
  systemPrompt: string | null;
  voiceProvider: string;
  voiceId: string | null;
  llmModel: string | null;
  isDefault: boolean;
}>;

export async function updateDefaultAgentProfileForUser(input: {
  userId: string;
  displayName?: string;
  voiceId?: string | null;
  llmModel?: string | null;
  systemPrompt?: string | null;
}): UpdateDefaultAgentProfileForUserResult {
  const profile = await ensureDefaultAgentProfileForUser({
    userId: input.userId,
    displayName: input.displayName ?? "Participant",
    voiceId: input.voiceId ?? null,
    llmModel: input.llmModel ?? null,
  });

  const [updated] = await db.agentProfiles.updateManyAndReturn({
    where: { id: profile.id },
    data: {
      displayName:
        input.displayName !== undefined && input.displayName !== ""
          ? formatPersonalAssistantDisplayName(input.displayName)
          : profile.displayName,
      voiceId: input.voiceId === undefined ? profile.voiceId : input.voiceId,
      llmModel: input.llmModel === undefined ? profile.llmModel : input.llmModel,
      systemPrompt: input.systemPrompt === undefined ? profile.systemPrompt : input.systemPrompt,
      updatedAt: new Date(),
    },
  });

  return updated ?? profile;
}

type ListAgentMemoriesForUserResult = Promise<
  {
    id: string;
    userId: string;
    agentProfileId: string;
    memoryType: string;
    content: string;
    source: string;
    createdAt: Date;
    updatedAt: Date;
  }[]
>;

export async function listAgentMemoriesForUser(
  ...args: [userId: string, agentProfileId?: string]
): ListAgentMemoriesForUserResult {
  const [userId, agentProfileId] = args;

  return db.agentMemories.findMany({
    where:
      agentProfileId !== undefined && agentProfileId !== "" ? whereAnd([{ userId }, { agentProfileId }]) : { userId },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
}

export async function addAgentMemory(input: {
  userId: string;
  agentProfileId: string;
  memoryType: string;
  content: string;
  source?: string;
}): Promise<{
  id: string;
  source: string;
  createdAt: Date;
  userId: string;
  updatedAt: Date;
  agentProfileId: string;
  memoryType: string;
  content: string;
}> {
  const memory = await db.agentMemories.create({
    data: {
      userId: input.userId,
      agentProfileId: input.agentProfileId,
      memoryType: input.memoryType,
      content: input.content,
      source: input.source ?? "manual",
    },
  });

  return memory;
}

const AGENT_CONNECTOR_DISCONNECTED_RANK = 2;
const AGENT_CONNECTOR_UNKNOWN_RANK = 3;

const agentConnectorStatusRank = (status: string): number => {
  if (status === "connected") {
    return 0;
  }
  if (status === "error") {
    return 1;
  }
  if (status === "disconnected") {
    return AGENT_CONNECTOR_DISCONNECTED_RANK;
  }

  return AGENT_CONNECTOR_UNKNOWN_RANK;
};

const compareAgentConnectors = (
  left: { provider: string; status: string; updatedAt: Date },
  right: { provider: string; status: string; updatedAt: Date },
): number => {
  const providerOrder = left.provider.localeCompare(right.provider);
  if (providerOrder !== 0) {
    return providerOrder;
  }
  const statusOrder = agentConnectorStatusRank(left.status) - agentConnectorStatusRank(right.status);
  if (statusOrder !== 0) {
    return statusOrder;
  }

  return right.updatedAt.getTime() - left.updatedAt.getTime();
};

type ListAgentConnectorsForUserResult = Promise<
  {
    id: string;
    userId: string;
    agentProfileId: string;
    provider: string;
    providerAccountId: string | null;
    providerEmail: string | null;
    providerTenantId: string | null;
    status: string;
    scope: string;
    externalAccountEmail: string | null;
    scopes: string[];
    syncStatus: string;
    accountKind: "personal" | "work" | null;
    connectedAt: Date | null;
    lastSyncedAt: Date | null;
    disconnectedAt: Date | null;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }[]
>;

export async function listAgentConnectorsForUser(
  ...args: [userId: string, agentProfileId?: string]
): ListAgentConnectorsForUserResult {
  const [userId, agentProfileId] = args;

  const rows = await mapRow({
    value: db.agentConnectors.findMany({
      where:
        agentProfileId !== undefined && agentProfileId !== ""
          ? whereAnd([{ userId }, { agentProfileId }, { deletedAt: null }])
          : whereAnd([{ userId }, { deletedAt: null }]),
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        scopes: readStringArray(row.scopes),
        accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
      })),
  });

  return [...rows].sort(compareAgentConnectors);
}

type UpsertAgentConnectorResult = Promise<{
  status: string;
  id: string;
  deletedAt: Date | null;
  createdAt: Date;
  userId: string;
  provider: string;
  providerAccountId: string | null;
  updatedAt: Date;
  agentProfileId: string;
  providerEmail: string | null;
  providerTenantId: string | null;
  scope: string;
  externalAccountEmail: string | null;
  scopes: string[];
  syncStatus: string;
  accountKind: "personal" | "work" | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  disconnectedAt: Date | null;
}>;

function agentConnectorProviderAccountMatchCondition(args: { providerAccountId: string | null }) {
  const { providerAccountId } = args;

  return providerAccountId !== null && providerAccountId !== "" ? { providerAccountId } : { providerAccountId: null };
}

function agentConnectorConnectionTimestamps(args: {
  status: AgentConnectorStatus;
  existing: Prisma.agentConnectorsModel | undefined;
  now: Date;
}) {
  const { status, existing, now } = args;
  const connectedAt = status === "connected" ? (existing?.connectedAt ?? now) : (existing?.connectedAt ?? null);
  const disconnectedAt =
    status === "disconnected" ? now : status === "connected" ? null : (existing?.disconnectedAt ?? null);

  return { connectedAt, disconnectedAt };
}

async function updateAgentConnectorRowWithin(args: {
  input: {
    agentProfileId: string;
    providerEmail?: string | null;
    providerTenantId?: string | null;
    status: AgentConnectorStatus;
    scope?: AgentConnectorScope;
    externalAccountEmail?: string | null;
    scopes?: string[];
    syncStatus?: ProviderSyncStatus;
    accountKind?: ProviderAccountKind | null;
    lastSyncedAt?: Date | null;
  };
  existing: Prisma.agentConnectorsModel;
  providerAccountId: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  now: Date;
}) {
  const { input, existing, providerAccountId, connectedAt, disconnectedAt, now } = args;
  const [connector] = await mapRow({
    value: db.agentConnectors.updateManyAndReturn({
      where: { id: existing.id },
      data: {
        agentProfileId: input.agentProfileId,
        status: input.status,
        scope: input.scope ?? existing.scope,
        providerAccountId,
        providerEmail: input.providerEmail === undefined ? existing.providerEmail : input.providerEmail,
        providerTenantId: input.providerTenantId === undefined ? existing.providerTenantId : input.providerTenantId,
        externalAccountEmail:
          input.externalAccountEmail === undefined ? existing.externalAccountEmail : input.externalAccountEmail,
        scopes: jsonInput(input.scopes ?? existing.scopes),
        syncStatus: input.syncStatus ?? existing.syncStatus,
        accountKind: input.accountKind === undefined ? existing.accountKind : input.accountKind,
        connectedAt,
        disconnectedAt,
        lastSyncedAt: input.lastSyncedAt === undefined ? existing.lastSyncedAt : input.lastSyncedAt,
        updatedAt: now,
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        scopes: readStringArray(row.scopes),
        accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
      })),
  });

  return connector;
}

async function insertAgentConnectorRowWithin(args: {
  input: {
    userId: string;
    agentProfileId: string;
    provider: string;
    providerEmail?: string | null;
    providerTenantId?: string | null;
    status: AgentConnectorStatus;
    scope?: AgentConnectorScope;
    externalAccountEmail?: string | null;
    scopes?: string[];
    syncStatus?: ProviderSyncStatus;
    accountKind?: ProviderAccountKind | null;
    lastSyncedAt?: Date | null;
  };
  providerAccountId: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
}) {
  const { input, providerAccountId, connectedAt, disconnectedAt } = args;
  const connector = await mapRow({
    value: db.agentConnectors.create({
      data: {
        userId: input.userId,
        agentProfileId: input.agentProfileId,
        provider: input.provider,
        providerAccountId,
        providerEmail: input.providerEmail ?? input.externalAccountEmail ?? null,
        providerTenantId: input.providerTenantId ?? null,
        status: input.status,
        scope: input.scope ?? "private",
        externalAccountEmail: input.externalAccountEmail ?? input.providerEmail ?? null,
        scopes: jsonInput(input.scopes ?? []),
        syncStatus: input.syncStatus ?? "idle",
        accountKind: input.accountKind ?? null,
        connectedAt,
        disconnectedAt,
        lastSyncedAt: input.lastSyncedAt ?? null,
      },
    }),
    map: (row) => ({
      ...row,
      scopes: readStringArray(row.scopes),
      accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
    }),
  });

  return connector;
}
type writeAgentConnectorRowWithinRow4 = {
  input: {
    userId: string;
    agentProfileId: string;
    provider: string;
    providerEmail?: string | null;
    providerTenantId?: string | null;
    status: AgentConnectorStatus;
    scope?: AgentConnectorScope;
    externalAccountEmail?: string | null;
    scopes?: string[];
    syncStatus?: ProviderSyncStatus;
    accountKind?: ProviderAccountKind | null;
    lastSyncedAt?: Date | null;
  };
  existing: Prisma.agentConnectorsModel | undefined;
  providerAccountId: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  now: Date;
};

async function writeAgentConnectorRowWithin(args: writeAgentConnectorRowWithinRow4) {
  const { existing } = args;
  if (existing) {
    return updateAgentConnectorRowWithin({ ...args, existing });
  }

  return insertAgentConnectorRowWithin(args);
}

async function persistAgentConnectorSecretWithin(args: {
  connectorId: string;
  input: {
    status: AgentConnectorStatus;
    provider: string;
    secretRef?: string | null;
  };
}) {
  const { connectorId, input } = args;
  if (input.secretRef === undefined || input.secretRef === null || input.secretRef === "") {
    return;
  }
  await db.agentConnectorSecrets.create({
    data: {
      agentConnectorId: connectorId,
      secretRef: input.secretRef,
      createdAt: new Date(),
    },
  });
  if (input.status === "connected" && input.provider === "google_calendar") {
    await db.pendingGoogleAddonCalendarCredentials.deleteMany({
      where: { agentConnectorId: connectorId },
    });
  }
}

const upsertAgentConnectorWithin = async (args: {
  input: {
    userId: string;
    agentProfileId: string;
    provider: string;
    providerAccountId?: string | null;
    providerEmail?: string | null;
    providerTenantId?: string | null;
    status: AgentConnectorStatus;
    scope?: AgentConnectorScope;
    externalAccountEmail?: string | null;
    scopes?: string[];
    syncStatus?: ProviderSyncStatus;
    accountKind?: ProviderAccountKind | null;
    lastSyncedAt?: Date | null;
    secretRef?: string | null;
  };
}) => {
  const { input } = args;

  const providerAccountId = trimmedOrNull(input.providerAccountId);
  const existing = await mapRow({
    value: db.agentConnectors.findFirst({
      where: whereAnd([
        { userId: input.userId },
        { provider: input.provider },
        agentConnectorProviderAccountMatchCondition({ providerAccountId }),
        { deletedAt: null },
      ]),
      orderBy: [{ updatedAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            scopes: readStringArray(row.scopes),
            accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
          },
  });

  const now = new Date();
  const { connectedAt, disconnectedAt } = agentConnectorConnectionTimestamps({
    status: input.status,
    existing,
    now,
  });

  if (existing !== undefined) {
    await persistAgentConnectorSecretWithin({ connectorId: existing.id, input });
  }

  const connector = await writeAgentConnectorRowWithin({
    input,
    existing,
    providerAccountId,
    connectedAt,
    disconnectedAt,
    now,
  });

  if (!connector) {
    throw new Error(FAILED_TO_UPSERT_AGENT_CONNECTOR_MESSAGE);
  }

  if (existing === undefined) {
    await persistAgentConnectorSecretWithin({ connectorId: connector.id, input });
  }

  return connector;
};

export async function upsertAgentConnector(input: {
  userId: string;
  agentProfileId: string;
  provider: string;
  providerAccountId?: string | null;
  providerEmail?: string | null;
  providerTenantId?: string | null;
  status: AgentConnectorStatus;
  scope?: AgentConnectorScope;
  externalAccountEmail?: string | null;
  scopes?: string[];
  syncStatus?: ProviderSyncStatus;
  accountKind?: ProviderAccountKind | null;
  lastSyncedAt?: Date | null;
  secretRef?: string | null;
}): UpsertAgentConnectorResult {
  // Publishing connected status and its validated secret is one commit.
  return (() => upsertAgentConnectorWithin({ input }))();
}

// Staging never changes an active credential. A separate table also keeps
// pending grants invisible to older API instances during rolling deployments.
export async function stageGoogleAddonCalendarCredentials(input: {
  userId: string;
  agentProfileId: string;
  googleSubject: string;
  googleEmail: string;
  secretRef: string;
}): Promise<boolean> {
  return (async () => {
    await createIgnoringUniqueConflict(() =>
      db.agentConnectors.create({
        data: {
          userId: input.userId,
          agentProfileId: input.agentProfileId,
          provider: "google_calendar",
          providerAccountId: input.googleSubject,
          providerEmail: input.googleEmail,
          externalAccountEmail: input.googleEmail,
          status: "error",
          scope: "private",
          syncStatus: "error",
        },
      }),
    );
    const connector = await mapRow({
      value: db.agentConnectors.findFirst({
        where: whereAnd([
          { userId: input.userId },
          { provider: "google_calendar" },
          { providerAccountId: input.googleSubject },
          { deletedAt: null },
        ]),
        take: 1,
      }),
      map: (row) =>
        row === null
          ? undefined
          : {
              ...row,
              scopes: readStringArray(row.scopes),
              accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
            },
    });
    if (!connector) {
      return false;
    }
    if (connector.status !== "connected") {
      await db.agentConnectors.updateMany({
        where: { id: connector.id },
        data: {
          status: "error",
          syncStatus: "error",
          providerEmail: input.googleEmail,
          externalAccountEmail: input.googleEmail,
          updatedAt: new Date(),
        },
      });
    }
    await (async () => {
      const data = {
        agentConnectorId: connector.id,
        secretRef: input.secretRef,
      };

      return db.pendingGoogleAddonCalendarCredentials.upsert({
        where: { agentConnectorId: data.agentConnectorId },
        create: data,
        update: {
          secretRef: input.secretRef,
          updatedAt: new Date(),
        },
      });
    })();

    return true;
  })();
}

export async function getPendingAgentConnectorSecret(
  agentConnectorId: string,
): Promise<{ agentConnectorId: string; secretRef: string; createdAt: Date; updatedAt: Date } | null> {
  const row = await mapRow({
    value: db.pendingGoogleAddonCalendarCredentials.findFirst({
      where: { agentConnectorId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return row ?? null;
}

export async function getLatestAgentConnectorSecret(agentConnectorId: string): Promise<{
  id: string;
  agentConnectorId: string;
  secretRef: string;
  encryptionVersion: string;
  createdAt: Date;
  rotatedAt: Date | null;
} | null> {
  const row = await mapRow({
    value: db.agentConnectorSecrets.findFirst({
      where: { agentConnectorId },
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return row ?? null;
}

type GetAgentConnectorForUserResult = Promise<{
  id: string;
  userId: string;
  agentProfileId: string;
  provider: string;
  providerAccountId: string | null;
  providerEmail: string | null;
  providerTenantId: string | null;
  status: string;
  scope: string;
  externalAccountEmail: string | null;
  scopes: string[];
  syncStatus: string;
  accountKind: "personal" | "work" | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  disconnectedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getAgentConnectorForUser(input: {
  userId: string;
  provider: string;
  providerAccountId?: string | null;
}): GetAgentConnectorForUserResult {
  const providerAccountId = trimmedOrNull(input.providerAccountId);
  const whereParts = [
    { userId: input.userId },
    { provider: input.provider },
    { deletedAt: null },
    ...(providerAccountId !== null && providerAccountId !== "" ? [{ providerAccountId }] : []),
  ];
  const rows = await mapRow({
    value: db.agentConnectors.findMany({
      where: whereAnd(whereParts),
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        scopes: readStringArray(row.scopes),
        accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
      })),
  });
  const row = [...rows].sort((left, right) => {
    const statusOrder = agentConnectorStatusRank(left.status) - agentConnectorStatusRank(right.status);
    if (statusOrder !== 0) {
      return statusOrder;
    }

    return right.updatedAt.getTime() - left.updatedAt.getTime();
  })[0];

  return row ?? null;
}

const CALENDAR_PROVIDER_VALUES: CalendarProvider[] = ["google_calendar", "outlook_calendar"];
const isCalendarProvider = (value: string): value is CalendarProvider =>
  CALENDAR_PROVIDER_VALUES.some((provider) => provider === value);

const CALENDAR_ACCOUNT_STATUS_VALUES: CalendarAccount["status"][] = ["connected", "disconnected", "error"];
const isCalendarAccountStatus = (value: string): value is CalendarAccount["status"] =>
  CALENDAR_ACCOUNT_STATUS_VALUES.some((status) => status === value);

function formatCalendarAccount(row: Prisma.agentConnectorsModel): CalendarAccount {
  const provider = isCalendarProvider(row.provider) ? row.provider : "google_calendar";
  const status = isCalendarAccountStatus(row.status) ? row.status : "error";

  return {
    id: row.id,
    userId: row.userId,
    provider,
    providerAccountId: row.providerAccountId ?? null,
    providerEmail: row.providerEmail ?? row.externalAccountEmail ?? null,
    providerTenantId: row.providerTenantId ?? null,
    externalAccountEmail: row.externalAccountEmail ?? null,
    status,
    accountKind: row.accountKind === "personal" ? "personal" : "work",
    scopes: readStringArray(row.scopes),
    syncStatus: row.syncStatus,
    lastSyncedAt: toIsoString(row.lastSyncedAt),
    connectedAt: toIsoString(row.connectedAt),
    disconnectedAt: toIsoString(row.disconnectedAt),
    deletedAt: toIsoString(row.deletedAt),
    createdAt: toIsoString(row.createdAt) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updatedAt) ?? new Date().toISOString(),
  };
}

type ListCalendarAccountsForUserResult = Promise<
  {
    status: "connected" | "disconnected" | "error";
    id: string;
    deletedAt: string | null;
    createdAt: string;
    userId: string;
    provider: "google_calendar" | "outlook_calendar";
    providerAccountId: string | null;
    updatedAt: string;
    providerEmail: string | null;
    providerTenantId: string | null;
    scopes: string[];
    syncStatus: string;
    accountKind: "personal" | "work";
    connectedAt: string | null;
    lastSyncedAt: string | null;
    disconnectedAt: string | null;
    externalAccountEmail?: string | null | undefined;
  }[]
>;

export async function listCalendarAccountsForUser(userId: string): ListCalendarAccountsForUserResult {
  const rows = await mapRow({
    value: db.agentConnectors.findMany({
      where: whereAnd([{ userId }, { provider: { in: ["google_calendar", "outlook_calendar"] } }, { deletedAt: null }]),
      orderBy: [{ provider: "asc" }, { providerEmail: "asc" }, { updatedAt: "desc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        scopes: readStringArray(row.scopes),
        accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
      })),
  });

  return rows.map(formatCalendarAccount);
}

type GetCalendarAccountForUserResult = Promise<{
  status: "connected" | "disconnected" | "error";
  id: string;
  deletedAt: string | null;
  createdAt: string;
  userId: string;
  provider: "google_calendar" | "outlook_calendar";
  providerAccountId: string | null;
  updatedAt: string;
  providerEmail: string | null;
  providerTenantId: string | null;
  scopes: string[];
  syncStatus: string;
  accountKind: "personal" | "work";
  connectedAt: string | null;
  lastSyncedAt: string | null;
  disconnectedAt: string | null;
  externalAccountEmail?: string | null | undefined;
} | null>;

export async function getCalendarAccountForUser(input: {
  userId: string;
  accountId: string;
}): GetCalendarAccountForUserResult {
  const row = await mapRow({
    value: db.agentConnectors.findFirst({
      where: whereAnd([
        { userId: input.userId },
        { id: input.accountId },
        { provider: { in: ["google_calendar", "outlook_calendar"] } },
        { deletedAt: null },
      ]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            scopes: readStringArray(row.scopes),
            accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
          },
  });

  return row ? formatCalendarAccount(row) : null;
}

type UpdateCalendarAccountKindResult = Promise<{
  status: "connected" | "disconnected" | "error";
  id: string;
  deletedAt: string | null;
  createdAt: string;
  userId: string;
  provider: "google_calendar" | "outlook_calendar";
  providerAccountId: string | null;
  updatedAt: string;
  providerEmail: string | null;
  providerTenantId: string | null;
  scopes: string[];
  syncStatus: string;
  accountKind: "personal" | "work";
  connectedAt: string | null;
  lastSyncedAt: string | null;
  disconnectedAt: string | null;
  externalAccountEmail?: string | null | undefined;
} | null>;

export async function updateCalendarAccountKind(input: {
  userId: string;
  accountId: string;
  accountKind: ProviderAccountKind;
}): UpdateCalendarAccountKindResult {
  const [row] = await mapRow({
    value: db.agentConnectors.updateManyAndReturn({
      where: whereAnd([
        { userId: input.userId },
        { id: input.accountId },
        { provider: { in: ["google_calendar", "outlook_calendar"] } },
        { deletedAt: null },
      ]),
      data: {
        accountKind: input.accountKind,
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        scopes: readStringArray(row.scopes),
        accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
      })),
  });

  return row ? formatCalendarAccount(row) : null;
}

type DisconnectCalendarAccountResult = Promise<{
  status: "connected" | "disconnected" | "error";
  id: string;
  deletedAt: string | null;
  createdAt: string;
  userId: string;
  provider: "google_calendar" | "outlook_calendar";
  providerAccountId: string | null;
  updatedAt: string;
  providerEmail: string | null;
  providerTenantId: string | null;
  scopes: string[];
  syncStatus: string;
  accountKind: "personal" | "work";
  connectedAt: string | null;
  lastSyncedAt: string | null;
  disconnectedAt: string | null;
  externalAccountEmail?: string | null | undefined;
} | null>;

export async function disconnectCalendarAccount(input: {
  userId: string;
  accountId: string;
  /** @external existing wire contract */ preservePending?: boolean;
  expectedUpdatedAt?: Date;
}): DisconnectCalendarAccountResult {
  return (async () => {
    const current = await mapRow({
      value: db.agentConnectors.findFirst({
        where: whereAnd([
          { userId: input.userId },
          { id: input.accountId },
          { provider: { in: ["google_calendar", "outlook_calendar"] } },
          { deletedAt: null },
        ]),
        take: 1,
      }),
      map: (row) =>
        row === null
          ? undefined
          : {
              ...row,
              scopes: readStringArray(row.scopes),
              accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
            },
    });
    const expectedUpdatedAt = input.expectedUpdatedAt;
    if (
      current === undefined ||
      (expectedUpdatedAt !== undefined &&
        Math.trunc(current.updatedAt.getTime()) !== Math.trunc(expectedUpdatedAt.getTime()))
    ) {
      return null;
    }
    const [row] = await mapRow({
      value: db.agentConnectors.updateManyAndReturn({
        where: { id: current.id },
        data: {
          status: input.preservePending === true ? "error" : "disconnected",
          syncStatus: input.preservePending === true ? "error" : "idle",
          disconnectedAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          scopes: readStringArray(row.scopes),
          accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
        })),
    });

    if (!row) {
      return null;
    }
    await db.agentConnectorSecrets.deleteMany({
      where: { agentConnectorId: row.id },
    });
    if (!(input.preservePending ?? false)) {
      await db.pendingGoogleAddonCalendarCredentials.deleteMany({
        where: { agentConnectorId: row.id },
      });
    }

    return formatCalendarAccount(row);
  })();
}

type SoftDeleteCalendarAccountResult = Promise<{
  id: string;
  userId: string;
  agentProfileId: string;
  provider: string;
  providerAccountId: string | null;
  providerEmail: string | null;
  providerTenantId: string | null;
  status: string;
  scope: string;
  externalAccountEmail: string | null;
  scopes: string[];
  syncStatus: string;
  accountKind: "personal" | "work" | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  disconnectedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function softDeleteCalendarAccount(input: {
  userId: string;
  accountId: string;
}): SoftDeleteCalendarAccountResult {
  const now = new Date();
  const [row] = await mapRow({
    value: db.agentConnectors.updateManyAndReturn({
      where: whereAnd([
        { userId: input.userId },
        { id: input.accountId },
        { provider: { in: ["google_calendar", "outlook_calendar"] } },
        { deletedAt: null },
      ]),
      data: {
        providerAccountId: null,
        providerEmail: null,
        providerTenantId: null,
        externalAccountEmail: null,
        scopes: jsonInput([]),
        status: "disconnected",
        syncStatus: "deleted",
        disconnectedAt: now,
        deletedAt: now,
        updatedAt: now,
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        scopes: readStringArray(row.scopes),
        accountKind: parseNullable({ schema: providerAccountKindSchema, value: row.accountKind }),
      })),
  });

  if (!row) {
    return null;
  }
  await db.agentConnectorSecrets.deleteMany({
    where: { agentConnectorId: row.id },
  });
  await db.pendingGoogleAddonCalendarCredentials.deleteMany({
    where: { agentConnectorId: row.id },
  });

  return row;
}

export async function deleteCalendarPrepDataForAccount(input: { userId: string; accountId: string }): Promise<number> {
  const rows = await (async () => {
    const where19 = sqlAnd([
      sqlCompare({ columnSql: '"calendar_event_preps"."user_id"', operator: "=", value: input.userId, cast: "uuid" }),
      sqlCompare({
        columnSql: '"calendar_event_preps"."calendar_account_id"',
        operator: "=",
        value: input.accountId,
        cast: "uuid",
      }),
    ]);

    return db.$queryRaw<{ id: string }[]>`
                     DELETE FROM "calendar_event_preps"
                     ${sqlWhereClause(where19)}
                     RETURNING "id" AS "id"
                     `;
  })();

  return rows.length;
}

type UpsertCalendarSyncSubscriptionResult = Promise<{
  status: string;
  id: string;
  createdAt: Date;
  userId: string;
  provider: string;
  updatedAt: Date;
  agentConnectorId: string;
  calendarId: string;
  channelId: string;
  webhookAddress: string | null;
  resourceId: string | null;
  resourceUri: string | null;
  expirationAt: Date | null;
  lastMessageNumber: string | null;
}>;

export async function upsertCalendarSyncSubscription(input: {
  userId: string;
  agentConnectorId: string;
  provider: CalendarProvider;
  calendarId?: string;
  channelId: string;
  webhookAddress?: string | null;
  resourceId?: string | null;
  resourceUri?: string | null;
  expirationAt?: Date | null;
  status?: "active" | "inactive" | "error";
}): UpsertCalendarSyncSubscriptionResult {
  const row = await mapRow({
    value: insertRaw<Prisma.calendarSyncSubscriptionsModel>({
      executor: db,
      table: "calendar_sync_subscriptions",
      rows: [
        {
          userId: input.userId,
          agentConnectorId: input.agentConnectorId,
          provider: input.provider,
          calendarId: input.calendarId ?? "primary",
          channelId: input.channelId,
          webhookAddress: input.webhookAddress ?? null,
          resourceId: input.resourceId ?? null,
          resourceUri: input.resourceUri ?? null,
          expirationAt: input.expirationAt ?? null,
          status: input.status ?? "active",
          lastMessageNumber: null,
        },
      ],
      columns: [
        { key: "id", column: "id", cast: "uuid" },
        { key: "userId", column: "user_id", cast: "uuid" },
        { key: "agentConnectorId", column: "agent_connector_id", cast: "uuid" },
        { key: "provider", column: "provider", cast: null },
        { key: "calendarId", column: "calendar_id", cast: null },
        { key: "channelId", column: "channel_id", cast: null },
        { key: "resourceId", column: "resource_id", cast: null },
        { key: "resourceUri", column: "resource_uri", cast: null },
        { key: "expirationAt", column: "expiration_at", cast: "timestamptz" },
        { key: "status", column: "status", cast: null },
        { key: "lastMessageNumber", column: "last_message_number", cast: null },
        { key: "createdAt", column: "created_at", cast: "timestamptz" },
        { key: "updatedAt", column: "updated_at", cast: "timestamptz" },
        { key: "webhookAddress", column: "webhook_address", cast: null },
      ],
      conflict: sqlConflictUpdate({
        targetSql: 'ON CONFLICT ("active_calendar_key")',
        where: undefined,
        assignments: [
          sqlAssign({ column: "user_id", value: input.userId, cast: "uuid" }),
          sqlAssign({ column: "provider", value: input.provider, cast: null }),
          sqlAssign({ column: "channel_id", value: input.channelId, cast: null }),
          sqlAssign({ column: "webhook_address", value: input.webhookAddress ?? null, cast: null }),
          sqlAssign({ column: "resource_id", value: input.resourceId ?? null, cast: null }),
          sqlAssign({ column: "resource_uri", value: input.resourceUri ?? null, cast: null }),
          sqlAssign({ column: "expiration_at", value: input.expirationAt ?? null, cast: "timestamptz" }),
          sqlAssign({ column: "status", value: input.status ?? "active", cast: null }),
          sqlAssign({ column: "last_message_number", value: null, cast: null }),
          sqlAssign({ column: "updated_at", value: new Date(), cast: "timestamptz" }),
        ],
      }),
      returning: Prisma.raw(
        '"id" AS "id", "user_id" AS "userId", "agent_connector_id" AS "agentConnectorId", "provider" AS "provider", "calendar_id" AS "calendarId", "channel_id" AS "channelId", "resource_id" AS "resourceId", "resource_uri" AS "resourceUri", "expiration_at" AS "expirationAt", "status" AS "status", "last_message_number" AS "lastMessageNumber", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "webhook_address" AS "webhookAddress", "active_calendar_key" AS "activeCalendarKey"',
      ),
    }),
    map: (rows) => rows[0],
  });

  if (!row) {
    throw new Error(FAILED_TO_UPSERT_CALENDAR_SYNC_SUBSCRIPTION_MESSAGE);
  }

  return row;
}

export type CalendarEventPrepRow = Omit<
  Prisma.calendarEventPrepsModel,
  "runRefs" | "eventSnapshot" | "result" | "error"
> & {
  runRefs: Record<string, unknown>;
  eventSnapshot: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
};

export type VoiceWebResearchRunRow = Omit<
  Prisma.voiceWebResearchRunsModel,
  "queryKeyFingerprint" | "queryFingerprint" | "runRefs" | "progress" | "result" | "error"
> & {
  runRefs: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
};
export type MeetingResearchRunRow = Prisma.meetingResearchRunsModel;

function parseMeetingResearchRunRow(row: MeetingResearchRunRow) {
  return meetingResearchRunViewSchema.parse({
    ...row,
    runRefs: row.runRefs,
    result: row.result,
    error: row.error ?? null,
    progressLabel: row.progressLabel ?? null,
    progressDetail: row.progressDetail ?? null,
    progressUpdatedAt: row.progressUpdatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function getExistingMeetingResearchRun(input: { meetingId: string; recommendationId: string }) {
  const row = await mapRow({
    value: db.meetingResearchRuns.findFirst({
      where: whereAnd([
        { meetingId: input.meetingId },
        { recommendationId: input.recommendationId },
        { status: { not: "cancelled" } },
      ]),
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: meetingResearchRunStatusSchema.parse(row.status),
            runRefs: readJsonObject(row.runRefs),
            result: readJsonObject(row.result),
            error: row.error === null ? null : readJsonObject(row.error),
          },
  });

  return row ? parseMeetingResearchRunRow(row) : null;
}

type CreateOrGetMeetingResearchRunResult = Promise<{
  run: {
    status: "completed" | "failed" | "running" | "queued" | "cancelled";
    error: Record<string, unknown> | null;
    id: string;
    createdAt: string;
    userId: string;
    updatedAt: string;
    completedAt: string | null;
    meetingId: string;
    agentProfileId: string;
    runRefs: Record<string, unknown>;
    result: {
      researchPaper?:
        | { title: string; filename: string; generatedAt: string; description: string; markdown: string }
        | undefined;
    } & { [k: string]: unknown };
    query: string;
    cancelledAt: string | null;
    recommendationId: string;
    taskKind: string;
    progressLabel: string | null;
    progressDetail: string | null;
    progressUpdatedAt: string | null;
  };
  /** @external existing wire contract */ created: boolean;
}>;

export async function createOrGetMeetingResearchRun(input: {
  meetingId: string;
  recommendationId: string;
  userId: string;
  agentProfileId: string;
  query: string;
  taskKind?: string;
  runRefs?: Record<string, unknown>;
}): CreateOrGetMeetingResearchRunResult {
  const existing = await getExistingMeetingResearchRun({
    meetingId: input.meetingId,
    recommendationId: input.recommendationId,
  });
  if (existing) {
    return { run: existing, /** @external existing wire contract */ created: false };
  }

  try {
    const row = await mapRow({
      value: db.meetingResearchRuns.create({
        data: {
          meetingId: input.meetingId,
          recommendationId: input.recommendationId,
          userId: input.userId,
          agentProfileId: input.agentProfileId,
          query: input.query,
          taskKind: input.taskKind ?? "answer_question",
          status: "queued",
          progressLabel: "Queued",
          progressDetail: "Preparing research plan.",
          progressUpdatedAt: new Date(),
          runRefs: jsonInput(input.runRefs ?? {}),
        },
      }),
      map: (row) => ({
        ...row,
        status: meetingResearchRunStatusSchema.parse(row.status),
        runRefs: readJsonObject(row.runRefs),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      }),
    });

    return { run: parseMeetingResearchRunRow(row), /** @external existing wire contract */ created: true };
  } catch (error) {
    if (!isMeetingResearchActiveRunConflictError(error)) {
      throw error;
    }

    const active = await getExistingMeetingResearchRun({
      meetingId: input.meetingId,
      recommendationId: input.recommendationId,
    });
    if (!active) {
      throw error;
    }

    return { run: active, /** @external existing wire contract */ created: false };
  }
}

type GetMeetingResearchRunByIdResult = Promise<{
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: Record<string, unknown> | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  agentProfileId: string;
  runRefs: Record<string, unknown>;
  result: {
    researchPaper?:
      | { title: string; filename: string; generatedAt: string; description: string; markdown: string }
      | undefined;
  } & { [k: string]: unknown };
  query: string;
  cancelledAt: string | null;
  recommendationId: string;
  taskKind: string;
  progressLabel: string | null;
  progressDetail: string | null;
  progressUpdatedAt: string | null;
} | null>;

export async function getMeetingResearchRunById(input: {
  meetingId: string;
  runId: string;
}): GetMeetingResearchRunByIdResult {
  const row = await mapRow({
    value: db.meetingResearchRuns.findFirst({
      where: whereAnd([{ meetingId: input.meetingId }, { id: input.runId }]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: meetingResearchRunStatusSchema.parse(row.status),
            runRefs: readJsonObject(row.runRefs),
            result: readJsonObject(row.result),
            error: row.error === null ? null : readJsonObject(row.error),
          },
  });

  return row ? parseMeetingResearchRunRow(row) : null;
}

type ListMeetingResearchRunsForMeetingResult = Promise<
  {
    status: "completed" | "failed" | "running" | "queued" | "cancelled";
    error: Record<string, unknown> | null;
    id: string;
    createdAt: string;
    userId: string;
    updatedAt: string;
    completedAt: string | null;
    meetingId: string;
    agentProfileId: string;
    runRefs: Record<string, unknown>;
    result: {
      researchPaper?:
        | { title: string; filename: string; generatedAt: string; description: string; markdown: string }
        | undefined;
    } & { [k: string]: unknown };
    query: string;
    cancelledAt: string | null;
    recommendationId: string;
    taskKind: string;
    progressLabel: string | null;
    progressDetail: string | null;
    progressUpdatedAt: string | null;
  }[]
>;

export async function listMeetingResearchRunsForMeeting(input: {
  meetingId: string;
  limit?: number;
}): ListMeetingResearchRunsForMeetingResult {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_RESEARCH_PAGE_LIMIT, 1), MAX_LIST_LIMIT);
  const rows = await mapRow({
    value: db.meetingResearchRuns.findMany({
      where: { meetingId: input.meetingId },
      orderBy: [{ createdAt: "desc" }],
      take: limit,
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: meetingResearchRunStatusSchema.parse(row.status),
        runRefs: readJsonObject(row.runRefs),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });

  return rows.map(parseMeetingResearchRunRow);
}

type UpdateMeetingResearchRunResult = Promise<{
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: Record<string, unknown> | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  agentProfileId: string;
  runRefs: Record<string, unknown>;
  result: {
    researchPaper?:
      | { title: string; filename: string; generatedAt: string; description: string; markdown: string }
      | undefined;
  } & { [k: string]: unknown };
  query: string;
  cancelledAt: string | null;
  recommendationId: string;
  taskKind: string;
  progressLabel: string | null;
  progressDetail: string | null;
  progressUpdatedAt: string | null;
} | null>;

export async function updateMeetingResearchRun(input: {
  id: string;
  status?: MeetingResearchRunStatus;
  progressLabel?: string | null;
  progressDetail?: string | null;
  runRefs?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
}): UpdateMeetingResearchRunResult {
  const update: Partial<Prisma.meetingResearchRunsUncheckedUpdateInput> = {
    updatedAt: new Date(),
  };
  if (input.status !== undefined) {
    update.status = input.status;
  }
  if (input.progressLabel !== undefined) {
    update.progressLabel = input.progressLabel;
  }
  if (input.progressDetail !== undefined) {
    update.progressDetail = input.progressDetail;
  }
  if (input.progressLabel !== undefined || input.progressDetail !== undefined) {
    update.progressUpdatedAt = new Date();
  }
  if (input.runRefs !== undefined) {
    update.runRefs = jsonInput(input.runRefs);
  }
  if (input.result !== undefined) {
    update.result = jsonInput(input.result);
  }
  if (input.error !== undefined) {
    update.error = input.error === null ? Prisma.DbNull : jsonInput(input.error);
  }
  if (input.completedAt !== undefined) {
    update.completedAt = input.completedAt;
  }
  if (input.cancelledAt !== undefined) {
    update.cancelledAt = input.cancelledAt;
  }

  const [row] = await mapRow({
    value: db.meetingResearchRuns.updateManyAndReturn({
      where: { id: input.id },
      data: update,
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: meetingResearchRunStatusSchema.parse(row.status),
        runRefs: readJsonObject(row.runRefs),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });

  return row ? parseMeetingResearchRunRow(row) : null;
}

type CancelMeetingResearchRunResult = Promise<{
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: Record<string, unknown> | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  agentProfileId: string;
  runRefs: Record<string, unknown>;
  result: {
    researchPaper?:
      | { title: string; filename: string; generatedAt: string; description: string; markdown: string }
      | undefined;
  } & { [k: string]: unknown };
  query: string;
  cancelledAt: string | null;
  recommendationId: string;
  taskKind: string;
  progressLabel: string | null;
  progressDetail: string | null;
  progressUpdatedAt: string | null;
} | null>;

export async function cancelMeetingResearchRun(input: {
  meetingId: string;
  runId: string;
}): CancelMeetingResearchRunResult {
  const existing = await getMeetingResearchRunById(input);
  if (!existing) {
    return null;
  }
  if (!["queued", "running"].includes(existing.status)) {
    return existing;
  }

  const [row] = await mapRow({
    value: db.meetingResearchRuns.updateManyAndReturn({
      where: whereAnd([{ meetingId: input.meetingId }, { id: input.runId }]),
      data: {
        status: "cancelled",
        progressLabel: "Cancelled",
        progressDetail: "Research run was cancelled.",
        progressUpdatedAt: new Date(),
        cancelledAt: new Date(),
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: meetingResearchRunStatusSchema.parse(row.status),
        runRefs: readJsonObject(row.runRefs),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });

  return row ? parseMeetingResearchRunRow(row) : existing;
}

type GetRecentVoiceWebResearchRunByQueryResult = Promise<{
  id: string;
  meetingId: string;
  userId: string;
  agentProfileId: string;
  utteranceId: string;
  query: string;
  queryKey: string;
  status: string;
  researchMode: string;
  sessionId: string | null;
  searchId: string | null;
  findallId: string | null;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getRecentVoiceWebResearchRunByQuery(
  ...args: [
    input: {
      meetingId: string;
      userId: string;
      queryKey: string;
      queryText?: string;
      since: Date;
    },
    executor?: DbConnection,
  ]
): GetRecentVoiceWebResearchRunByQueryResult {
  const [input] = args;
  const runs = await mapRow({
    value: db.voiceWebResearchRuns.findMany({
      where: whereAnd([
        { meetingId: input.meetingId },
        { userId: input.userId },
        input.queryText !== undefined
          ? whereOr([{ queryKey: input.queryKey }, { query: input.queryText }])
          : { queryKey: input.queryKey },
        { createdAt: { gte: input.since } },
      ]),
      orderBy: [{ createdAt: "desc" }],
      take: RECENT_RESEARCH_QUERY_LIMIT,
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        runRefs: readJsonObject(row.runRefs),
        progress: readJsonObject(row.progress),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });

  if (runs.length === 0) {
    return null;
  }

  if (input.queryText !== undefined) {
    return runs[0] ?? null;
  }

  return (
    runs.find((run) => run.status === "completed" && Object.keys(run.result).length !== 0) ??
    runs.find((run) => !["failed", "cancelled", "expired"].includes(run.status)) ??
    runs[0] ??
    null
  );
}

type GetRecentVoiceWebResearchRunByUtteranceResult = Promise<{
  id: string;
  meetingId: string;
  userId: string;
  agentProfileId: string;
  utteranceId: string;
  query: string;
  queryKey: string;
  status: string;
  researchMode: string;
  sessionId: string | null;
  searchId: string | null;
  findallId: string | null;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getRecentVoiceWebResearchRunByUtterance(
  ...args: [
    input: {
      meetingId: string;
      userId: string;
      utteranceId: string;
      since: Date;
    },
    executor?: DbConnection,
  ]
): GetRecentVoiceWebResearchRunByUtteranceResult {
  const [input] = args;
  const runs = await mapRow({
    value: db.voiceWebResearchRuns.findMany({
      where: whereAnd([
        { meetingId: input.meetingId },
        { userId: input.userId },
        { utteranceId: input.utteranceId },
        { createdAt: { gte: input.since } },
      ]),
      orderBy: [{ createdAt: "desc" }],
      take: RECENT_RESEARCH_UTTERANCE_LIMIT,
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        runRefs: readJsonObject(row.runRefs),
        progress: readJsonObject(row.progress),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });

  if (runs.length === 0) {
    return null;
  }

  // A later research step in the same utterance supersedes the previous result.
  return runs[0] ?? null;
}

type GetVoiceWebResearchRunForMeetingResult = Promise<{
  id: string;
  meetingId: string;
  userId: string;
  agentProfileId: string;
  utteranceId: string;
  query: string;
  queryKey: string;
  status: string;
  researchMode: string;
  sessionId: string | null;
  searchId: string | null;
  findallId: string | null;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getVoiceWebResearchRunForMeeting(input: {
  id: string;
  meetingId: string;
}): GetVoiceWebResearchRunForMeetingResult {
  const run = await mapRow({
    value: db.voiceWebResearchRuns.findFirst({
      where: whereAnd([{ id: input.id }, { meetingId: input.meetingId }]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            runRefs: readJsonObject(row.runRefs),
            progress: readJsonObject(row.progress),
            result: readJsonObject(row.result),
            error: row.error === null ? null : readJsonObject(row.error),
          },
  });

  return run ?? null;
}

type ListVoiceWebResearchRunsForMeetingResult = Promise<
  {
    id: string;
    meetingId: string;
    userId: string;
    agentProfileId: string;
    utteranceId: string;
    query: string;
    queryKey: string;
    status: string;
    researchMode: string;
    sessionId: string | null;
    searchId: string | null;
    findallId: string | null;
    taskgroupId: string | null;
    runRefs: Record<string, unknown>;
    progress: Record<string, unknown>;
    result: Record<string, unknown>;
    error: Record<string, unknown> | null;
    cancelledAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }[]
>;

export async function listVoiceWebResearchRunsForMeeting(input: {
  meetingId: string;
  limit?: number;
}): ListVoiceWebResearchRunsForMeetingResult {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_INVOCATION_PAGE_LIMIT, 1), MAX_LIST_LIMIT);

  return mapRow({
    value: db.voiceWebResearchRuns.findMany({
      where: { meetingId: input.meetingId },
      orderBy: [{ createdAt: "desc" }],
      take: limit,
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        runRefs: readJsonObject(row.runRefs),
        progress: readJsonObject(row.progress),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });
}

// Internal correlation needs only request metadata during live detection, not
// the potentially large provider results returned to the research panel.
type ListVoiceSearchEvidenceForMeetingResult = Promise<
  {
    id: string;
    utteranceId: string;
    meetingId: string;
    userId: string;
    query: string;
    status: string;
    expiresAt: Date | null;
    createdAt: Date;
    result: Record<string, unknown>;
  }[]
>;

const researchRunIdFromSummary = (summary: Record<string, unknown>): string | null => {
  const researchRunId = summary.researchRunId;

  return typeof researchRunId === "string" && researchRunId !== "" ? researchRunId : null;
};

const voiceSearchCitationEvidence = (result: Record<string, unknown>): Record<string, unknown> => {
  const answer = isUnknownRecord(result.answer) ? result.answer : {};
  const citations = Array.isArray(answer.citations) ? answer.citations : [];

  return {
    answer: {
      confidence: answer.confidence,
      citations: citations.map((citation) => ({
        url: isUnknownRecord(citation) ? (citation.url ?? null) : null,
      })),
    },
  };
};

const voiceSearchEvidenceResult = (input: {
  shouldIncludeResults: boolean | undefined;
  result: Record<string, unknown>;
}): Record<string, unknown> => (input.shouldIncludeResults === true ? voiceSearchCitationEvidence(input.result) : {});

const linkedVoiceSearchEvidence = (input: {
  invocations: {
    createdAt: Date;
    id: string;
    utteranceId: string;
    meetingId: string;
    userId: string;
    redactedResultSummary: Record<string, Prisma.JsonValue>;
  }[];
  runsById: Map<
    string,
    {
      id: string;
      userId: string;
      status: string;
      query: string;
      expiresAt: Date | null;
      result: Record<string, Prisma.JsonValue>;
    }
  >;
  since?: Date;
  until?: Date;
  isCompletedOnly?: boolean;
  shouldIncludeResults?: boolean;
}) =>
  input.invocations.flatMap((invocation) => {
    const createdAt = invocation.createdAt;
    if (input.since !== undefined && createdAt < input.since) {
      return [];
    }
    if (input.until !== undefined && createdAt > input.until) {
      return [];
    }
    const researchRunId = researchRunIdFromSummary(invocation.redactedResultSummary);
    const run = researchRunId === null ? undefined : input.runsById.get(researchRunId);
    if (run === undefined || run.userId !== invocation.userId) {
      return [];
    }
    if (input.isCompletedOnly === true && run.status !== "completed") {
      return [];
    }

    return [
      {
        id: run.id,
        invocationId: invocation.id,
        utteranceId: invocation.utteranceId,
        meetingId: invocation.meetingId,
        userId: invocation.userId,
        query: run.query,
        status: run.status,
        expiresAt: run.expiresAt,
        createdAt,
        result: voiceSearchEvidenceResult({ shouldIncludeResults: input.shouldIncludeResults, result: run.result }),
      },
    ];
  });

export async function listVoiceSearchEvidenceForMeeting(input: {
  meetingId: string;
  since?: Date;
  until?: Date;
  /** @external existing wire contract */ includeResults?: boolean;
  /** @external existing wire contract */ completedOnly?: boolean;
}): ListVoiceSearchEvidenceForMeetingResult {
  const [invocations, runs] = await Promise.all([
    mapRow({
      value: db.agentToolInvocations.findMany({
        where: whereAnd([{ meetingId: input.meetingId }, { toolName: "web_search" }, { provider: "web_search" }]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          redactedArgs: readJsonObject(row.redactedArgs),
          redactedResultSummary: readJsonObject(row.redactedResultSummary),
        })),
    }),
    mapRow({
      value: db.voiceWebResearchRuns.findMany({
        where: { meetingId: input.meetingId },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          runRefs: readJsonObject(row.runRefs),
          progress: readJsonObject(row.progress),
          result: readJsonObject(row.result),
          error: row.error === null ? null : readJsonObject(row.error),
        })),
    }),
  ]);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const linkedKeys = new Set(
    invocations.flatMap((invocation) => {
      const researchRunId = researchRunIdFromSummary(invocation.redactedResultSummary);

      return researchRunId === null ? [] : [`${invocation.userId}:${invocation.utteranceId}:${researchRunId}`];
    }),
  );
  const linkedEvidence = linkedVoiceSearchEvidence({
    invocations,
    runsById,
    since: input.since,
    until: input.until,
    isCompletedOnly: input.completedOnly,
    shouldIncludeResults: input.includeResults,
  });
  const legacyEvidence = runs.flatMap((run) => {
    if (input.completedOnly === true && run.status !== "completed") {
      return [];
    }
    if (input.since !== undefined && run.createdAt < input.since) {
      return [];
    }
    if (input.until !== undefined && run.createdAt > input.until) {
      return [];
    }
    if (linkedKeys.has(`${run.userId}:${run.utteranceId}:${run.id}`)) {
      return [];
    }

    return [
      {
        id: run.id,
        utteranceId: run.utteranceId,
        meetingId: run.meetingId,
        userId: run.userId,
        query: run.query,
        status: run.status,
        expiresAt: run.expiresAt,
        createdAt: run.createdAt,
        result: voiceSearchEvidenceResult({ shouldIncludeResults: input.includeResults, result: run.result }),
      },
    ];
  });

  return [...linkedEvidence, ...legacyEvidence]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, MAX_LIST_LIMIT);
}

type CreateVoiceWebResearchRunResult = Promise<{
  status: string;
  error: Record<string, unknown> | null;
  id: string;
  createdAt: Date;
  userId: string;
  updatedAt: Date;
  expiresAt: Date | null;
  meetingId: string;
  agentProfileId: string;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  result: Record<string, unknown>;
  utteranceId: string;
  query: string;
  queryKey: string;
  researchMode: string;
  sessionId: string | null;
  searchId: string | null;
  findallId: string | null;
  progress: Record<string, unknown>;
  cancelledAt: Date | null;
}>;

export async function createVoiceWebResearchRun(
  ...args: [
    input: {
      meetingId: string;
      userId: string;
      agentProfileId: string;
      utteranceId: string;
      query: string;
      queryKey: string;
      status: string;
      researchMode: string;
      sessionId?: string | null;
      searchId?: string | null;
      runRefs?: Record<string, unknown>;
      progress?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: Record<string, unknown> | null;
      expiresAt?: Date | null;
    },
    executor?: DbConnection,
  ]
): CreateVoiceWebResearchRunResult {
  const [input] = args;
  const run = await mapRow({
    value: db.voiceWebResearchRuns.create({
      data: {
        meetingId: input.meetingId,
        userId: input.userId,
        agentProfileId: input.agentProfileId,
        utteranceId: input.utteranceId,
        query: input.query,
        queryKey: input.queryKey,
        status: input.status,
        researchMode: input.researchMode,
        sessionId: input.sessionId ?? null,
        searchId: input.searchId ?? null,
        runRefs: jsonInput(input.runRefs ?? {}),
        progress: jsonInput(input.progress ?? {}),
        result: jsonInput(input.result ?? {}),
        error: jsonInput(input.error ?? null),
        expiresAt: input.expiresAt ?? null,
      },
    }),
    map: (row) => ({
      ...row,
      runRefs: readJsonObject(row.runRefs),
      progress: readJsonObject(row.progress),
      result: readJsonObject(row.result),
      error: row.error === null ? null : readJsonObject(row.error),
    }),
  });

  return run;
}

/** Serialize admission across API replicas, using one connection only.
 * Provider work and invocation binding happen after this transaction commits.
 */
type ClaimVoiceWebResearchRunResult = Promise<{
  run: {
    id: string;
    meetingId: string;
    userId: string;
    agentProfileId: string;
    utteranceId: string;
    query: string;
    queryKey: string;
    status: string;
    researchMode: string;
    sessionId: string | null;
    searchId: string | null;
    findallId: string | null;
    taskgroupId: string | null;
    runRefs: Record<string, unknown>;
    progress: Record<string, unknown>;
    result: Record<string, unknown>;
    error: Record<string, unknown> | null;
    cancelledAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  /** @external existing wire contract */ reused: boolean;
}>;

export async function claimVoiceWebResearchRun(
  input: Parameters<typeof createVoiceWebResearchRun>[0] & { since: Date },
): ClaimVoiceWebResearchRunResult {
  return (async () => {
    const reusable = (run: { status: string; expiresAt: Date | null } | null) =>
      run &&
      !["failed", "cancelled", "expired"].includes(run.status) &&
      (run.status === "completed" || !run.expiresAt || run.expiresAt.getTime() > Date.now());
    const utterance = await getRecentVoiceWebResearchRunByUtterance(input);
    if (reusable(utterance) === true && utterance && utterance.queryKey === input.queryKey) {
      return { run: utterance, /** @external existing wire contract */ reused: true };
    }
    const query = await getRecentVoiceWebResearchRunByQuery(input);
    if (reusable(query) === true && query) {
      return { run: query, /** @external existing wire contract */ reused: true };
    }
    await cancelActiveVoiceWebResearchRuns({ ...input, exceptQueryKey: input.queryKey });

    try {
      return { run: await createVoiceWebResearchRun(input), /** @external existing wire contract */ reused: false };
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) {
        throw error;
      }
      const existing = await getRecentVoiceWebResearchRunByQuery(input);
      if (existing === null) {
        throw error;
      }

      return { run: existing, /** @external existing wire contract */ reused: true };
    }
  })();
}

type UpdateVoiceWebResearchRunResult = Promise<{
  id: string;
  meetingId: string;
  userId: string;
  agentProfileId: string;
  utteranceId: string;
  query: string;
  queryKey: string;
  status: string;
  researchMode: string;
  sessionId: string | null;
  searchId: string | null;
  findallId: string | null;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function updateVoiceWebResearchRun(input: {
  id: string;
  status?: string;
  researchMode?: string;
  sessionId?: string | null;
  searchId?: string | null;
  findallId?: string | null;
  taskgroupId?: string | null;
  runRefs?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  cancelledAt?: Date | null;
  expiresAt?: Date | null;
}): UpdateVoiceWebResearchRunResult {
  const update: Partial<Prisma.voiceWebResearchRunsUncheckedUpdateInput> = {
    updatedAt: new Date(),
  };
  if (input.status !== undefined) {
    update.status = input.status;
  }
  if (input.researchMode !== undefined) {
    update.researchMode = input.researchMode;
  }
  if (input.sessionId !== undefined) {
    update.sessionId = input.sessionId;
  }
  if (input.searchId !== undefined) {
    update.searchId = input.searchId;
  }
  if (input.findallId !== undefined) {
    update.findallId = input.findallId;
  }
  if (input.taskgroupId !== undefined) {
    update.taskgroupId = input.taskgroupId;
  }
  if (input.runRefs !== undefined) {
    update.runRefs = jsonInput(input.runRefs);
  }
  if (input.progress !== undefined) {
    update.progress = jsonInput(input.progress);
  }
  if (input.result !== undefined) {
    update.result = jsonInput(input.result);
  }
  if (input.error !== undefined) {
    update.error = input.error === null ? Prisma.DbNull : jsonInput(input.error);
  }
  if (input.cancelledAt !== undefined) {
    update.cancelledAt = input.cancelledAt;
  }
  if (input.expiresAt !== undefined) {
    update.expiresAt = input.expiresAt;
  }

  const [run] = await mapRow({
    value: db.voiceWebResearchRuns.updateManyAndReturn({
      where: { id: input.id },
      data: update,
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        runRefs: readJsonObject(row.runRefs),
        progress: readJsonObject(row.progress),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });

  return run ?? null;
}

export async function cancelActiveVoiceWebResearchRuns(
  ...args: [
    input: {
      meetingId: string;
      userId: string;
      exceptQueryKey?: string | null;
    },
    executor?: DbConnection,
  ]
): Promise<number> {
  const [input] = args;
  const terminalStatuses = ["completed", "failed", "cancelled", "expired"];
  const whereParts = [
    { meetingId: input.meetingId },
    { userId: input.userId },
    { status: { notIn: terminalStatuses } },
    ...(input.exceptQueryKey !== undefined && input.exceptQueryKey !== null && input.exceptQueryKey !== ""
      ? [{ queryKey: { not: input.exceptQueryKey } }]
      : []),
  ];

  const rows = await db.voiceWebResearchRuns.updateManyAndReturn({
    where: whereAnd(whereParts),
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      updatedAt: new Date(),
      error: jsonInput(SUPERSEDED_WEB_SEARCH_ERROR),
    },
    select: { id: true },
  });

  return rows.length;
}

type GetCalendarEventPrepByFingerprintResult = Promise<{
  id: string;
  userId: string;
  calendarAccountId: string | null;
  calendarEventId: string;
  eventFingerprint: string;
  status: string;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  eventSnapshot: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getCalendarEventPrepByFingerprint(input: {
  userId: string;
  calendarAccountId?: string | null;
  calendarEventId: string;
  eventFingerprint: string;
}): GetCalendarEventPrepByFingerprintResult {
  const whereParts = [
    { userId: input.userId },
    { calendarEventId: input.calendarEventId },
    { eventFingerprint: input.eventFingerprint },
  ];
  const calendarAccountPredicates =
    input.calendarAccountId !== undefined
      ? [
          input.calendarAccountId !== null && input.calendarAccountId !== ""
            ? { calendarAccountId: input.calendarAccountId }
            : { calendarAccountId: null },
        ]
      : [];

  const row = await mapRow({
    value: db.calendarEventPreps.findFirst({
      where: whereAnd([...whereParts, ...calendarAccountPredicates]),
      orderBy: [{ updatedAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            runRefs: readJsonObject(row.runRefs),
            eventSnapshot: readJsonObject(row.eventSnapshot),
            result: readJsonObject(row.result),
            error: row.error === null ? null : readJsonObject(row.error),
          },
  });

  return row ?? null;
}

type GetCalendarEventPrepByIdForUserResult = Promise<{
  id: string;
  userId: string;
  calendarAccountId: string | null;
  calendarEventId: string;
  eventFingerprint: string;
  status: string;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  eventSnapshot: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getCalendarEventPrepByIdForUser(input: {
  id: string;
  userId: string;
}): GetCalendarEventPrepByIdForUserResult {
  const row = await mapRow({
    value: db.calendarEventPreps.findFirst({
      where: whereAnd([{ id: input.id }, { userId: input.userId }]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            runRefs: readJsonObject(row.runRefs),
            eventSnapshot: readJsonObject(row.eventSnapshot),
            result: readJsonObject(row.result),
            error: row.error === null ? null : readJsonObject(row.error),
          },
  });

  return row ?? null;
}

export async function countUserMeteredCalendarEventPreps(userId: string): Promise<number> {
  const rows = await mapRow({
    value: db.aiCreditUsageEvents.findMany({
      where: whereAnd([{ userId }, { actionType: "meeting_prep" }, { creditsCharged: { gt: 0 } }]),
      select: {
        id: true,
        metadata: true,
      },
    }),
    map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
  });
  const keys = new Set(
    rows.map((row) => {
      const prepId = row.metadata.prepId;

      return typeof prepId === "string" && prepId !== "" ? prepId : row.id;
    }),
  );

  return keys.size;
}

type CreateCalendarEventPrepResult = Promise<{
  status: string;
  error: Record<string, unknown> | null;
  id: string;
  createdAt: Date;
  userId: string;
  updatedAt: Date;
  calendarAccountId: string | null;
  calendarEventId: string;
  eventFingerprint: string;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  eventSnapshot: Record<string, unknown>;
  result: Record<string, unknown>;
}>;

export async function createCalendarEventPrep(input: {
  userId: string;
  calendarAccountId?: string | null;
  calendarEventId: string;
  eventFingerprint: string;
  status: "pending" | "running" | "completed" | "failed";
  taskgroupId?: string | null;
  runRefs?: Record<string, unknown>;
  eventSnapshot: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
}): CreateCalendarEventPrepResult {
  const row = await mapRow({
    value: db.calendarEventPreps.create({
      data: {
        userId: input.userId,
        calendarAccountId: input.calendarAccountId ?? null,
        calendarEventId: input.calendarEventId,
        eventFingerprint: input.eventFingerprint,
        status: input.status,
        taskgroupId: input.taskgroupId ?? null,
        runRefs: jsonInput(input.runRefs ?? {}),
        eventSnapshot: jsonInput(input.eventSnapshot),
        result: jsonInput(input.result ?? {}),
        error: jsonInput(input.error ?? null),
      },
    }),
    map: (row) => ({
      ...row,
      runRefs: readJsonObject(row.runRefs),
      eventSnapshot: readJsonObject(row.eventSnapshot),
      result: readJsonObject(row.result),
      error: row.error === null ? null : readJsonObject(row.error),
    }),
  });

  return row;
}

type UpdateCalendarEventPrepResult = Promise<{
  id: string;
  userId: string;
  calendarAccountId: string | null;
  calendarEventId: string;
  eventFingerprint: string;
  status: string;
  taskgroupId: string | null;
  runRefs: Record<string, unknown>;
  eventSnapshot: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export async function updateCalendarEventPrep(input: {
  id: string;
  status?: "pending" | "running" | "completed" | "failed";
  taskgroupId?: string | null;
  runRefs?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
}): UpdateCalendarEventPrepResult {
  const [row] = await mapRow({
    value: db.calendarEventPreps.updateManyAndReturn({
      where: { id: input.id },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.taskgroupId !== undefined ? { taskgroupId: input.taskgroupId } : {}),
        ...(input.runRefs !== undefined ? { runRefs: jsonInput(input.runRefs) } : {}),
        ...(input.result !== undefined ? { result: jsonInput(input.result) } : {}),
        ...(input.error !== undefined ? { error: input.error === null ? Prisma.DbNull : jsonInput(input.error) } : {}),
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        runRefs: readJsonObject(row.runRefs),
        eventSnapshot: readJsonObject(row.eventSnapshot),
        result: readJsonObject(row.result),
        error: row.error === null ? null : readJsonObject(row.error),
      })),
  });

  if (!row) {
    throw new Error(FAILED_TO_UPDATE_CALENDAR_EVENT_PREP_MESSAGE);
  }

  return row;
}

function normalizeCalendarIdentityEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function calendarIdentityName(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

function calendarCounterpart(row: { owner_email: string | null; participants: unknown }) {
  const parsedParticipants = unknownArraySchema.safeParse(row.participants);
  if (!parsedParticipants.success || parsedParticipants.data.length !== PARTICIPANT_PAIR_COUNT) {
    return null;
  }
  const participants = parsedParticipants.data.flatMap((item) => (isUnknownRecord(item) ? [item] : []));
  if (participants.length !== PARTICIPANT_PAIR_COUNT) {
    return null;
  }
  const ownerEmail = normalizeCalendarIdentityEmail(row.owner_email);
  const organizer = participants.find(
    (participant) =>
      participant.role === "organizer" ||
      (ownerEmail !== "" && normalizeCalendarIdentityEmail(participant.email) === ownerEmail),
  );
  if (organizer === undefined) {
    return null;
  }
  const counterparts = participants.filter((participant) => {
    const email = normalizeCalendarIdentityEmail(participant.email);

    return email !== "" && email !== ownerEmail && participant !== organizer;
  });
  const counterpart = counterparts.length === 1 ? counterparts[0] : undefined;
  if (counterpart === undefined) {
    return null;
  }
  const email = normalizeCalendarIdentityEmail(counterpart.email);
  if (email === "") {
    return null;
  }

  return {
    email,
    displayName: calendarIdentityName(counterpart.name),
  };
}

export async function getDeterministicCalendarCounterpartForMeeting(
  meetingId: string,
): Promise<{ email: string; displayName: string | null } | null> {
  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { id: meetingId },
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredMeeting(row)),
  });
  if (meeting?.meetingLinkId === undefined || meeting.meetingLinkId === null) {
    return null;
  }
  const links = await db.calendarReadyLinks.findMany({
    where: { meetingLinkId: meeting.meetingLinkId },
  });
  if (links.length === 0) {
    return null;
  }
  const [owners, preps] = await Promise.all([
    mapRow({
      value: db.users.findMany({
        where: { id: { in: links.map((link) => link.userId) } },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
          plan: readStringUnion({
            values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
            value: row.plan,
          }),
        })),
    }),
    mapRow({
      value: db.calendarEventPreps.findMany({
        where: { userId: { in: links.map((link) => link.userId) } },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          runRefs: readJsonObject(row.runRefs),
          eventSnapshot: readJsonObject(row.eventSnapshot),
          result: readJsonObject(row.result),
          error: row.error === null ? null : readJsonObject(row.error),
        })),
    }),
  ]);
  const ownersById = new Map(owners.map((owner) => [owner.id, owner]));
  const rows = links
    .flatMap((link) =>
      preps
        .filter((prep) => {
          const exactId = `${link.provider}:${link.calendarId}:${link.providerEventId}`;

          return (
            prep.userId === link.userId &&
            prep.calendarAccountId === link.calendarAccountId &&
            (prep.calendarEventId === exactId || prep.calendarEventId.endsWith(link.providerEventId))
          );
        })
        .map((prep) => ({
          updatedAt: prep.updatedAt,
          owner_email: ownersById.get(link.userId)?.email ?? null,
          participants: isUnknownRecord(prep.eventSnapshot) ? prep.eventSnapshot.participants : undefined,
        })),
    )
    .toSorted((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .slice(0, CALENDAR_COUNTERPART_LOOKUP_LIMIT);

  return rows.map(calendarCounterpart).find((counterpart) => counterpart !== null) ?? null;
}

type GetActiveCalendarSyncSubscriptionForConnectorResult = Promise<{
  id: string;
  userId: string;
  agentConnectorId: string;
  provider: string;
  calendarId: string;
  channelId: string;
  webhookAddress: string | null;
  resourceId: string | null;
  resourceUri: string | null;
  expirationAt: Date | null;
  status: string;
  lastMessageNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getActiveCalendarSyncSubscriptionForConnector(input: {
  agentConnectorId: string;
  calendarId?: string;
  renewWithinMs?: number;
}): GetActiveCalendarSyncSubscriptionForConnectorResult {
  const renewWithinMs = input.renewWithinMs ?? 0;
  const row = await mapRow({
    value: db.calendarSyncSubscriptions.findFirst({
      where: whereAnd([
        { agentConnectorId: input.agentConnectorId },
        { calendarId: input.calendarId ?? "primary" },
        { status: "active" },
        whereOr([{ expirationAt: null }, { expirationAt: { gt: new Date(Date.now() + renewWithinMs) } }]),
      ]),
      orderBy: [{ updatedAt: "desc" }],
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return row ?? null;
}

type GetCalendarSyncSubscriptionByChannelResult = Promise<{
  id: string;
  userId: string;
  agentConnectorId: string;
  provider: string;
  calendarId: string;
  channelId: string;
  webhookAddress: string | null;
  resourceId: string | null;
  resourceUri: string | null;
  expirationAt: Date | null;
  status: string;
  lastMessageNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
} | null>;

export async function getCalendarSyncSubscriptionByChannel(input: {
  provider: CalendarProvider;
  channelId: string;
}): GetCalendarSyncSubscriptionByChannelResult {
  const row = await mapRow({
    value: db.calendarSyncSubscriptions.findFirst({
      where: whereAnd([{ provider: input.provider }, { channelId: input.channelId }, { status: "active" }]),
      orderBy: [{ updatedAt: "desc" }],
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return row ?? null;
}

export async function markCalendarSyncSubscriptionInactive(id: string): Promise<void> {
  await db.calendarSyncSubscriptions.updateMany({
    where: { id },
    data: {
      status: "inactive",
      updatedAt: new Date(),
    },
  });
}

export async function markCalendarSyncSubscriptionNotification(input: {
  id: string;
  messageNumber?: string | null;
  expirationAt?: Date | null;
}): Promise<void> {
  await db.calendarSyncSubscriptions.updateMany({
    where: { id: input.id },
    data: {
      lastMessageNumber: input.messageNumber ?? null,
      expirationAt: input.expirationAt ?? undefined,
      updatedAt: new Date(),
    },
  });
}

export async function markCalendarSyncSubscriptionsInactiveForConnector(agentConnectorId: string): Promise<void> {
  await db.calendarSyncSubscriptions.updateMany({
    where: { agentConnectorId },
    data: {
      status: "inactive",
      updatedAt: new Date(),
    },
  });
}

export async function listAgentToolPolicies(agentProfileId: string): Promise<
  {
    id: string;
    agentProfileId: string;
    toolName: string;
    mode: string;
    config: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
  }[]
> {
  return mapRow({
    value: db.agentToolPolicies.findMany({
      where: { agentProfileId },
      orderBy: [{ toolName: "asc" }],
    }),
    map: (rows) => rows.map((row) => ({ ...row, config: readJsonObject(row.config) })),
  });
}

export async function upsertAgentToolPolicy(input: {
  agentProfileId: string;
  toolName: string;
  mode: string;
  config?: Record<string, unknown>;
}): Promise<{
  id: string;
  mode: string;
  createdAt: Date;
  updatedAt: Date;
  agentProfileId: string;
  toolName: string;
  config: Record<string, unknown>;
}> {
  const existing = await mapRow({
    value: db.agentToolPolicies.findFirst({
      where: whereAnd([{ agentProfileId: input.agentProfileId }, { toolName: input.toolName }]),
      take: 1,
    }),
    map: (row) => (row === null ? undefined : { ...row, config: readJsonObject(row.config) }),
  });

  if (existing) {
    const [updated] = await mapRow({
      value: db.agentToolPolicies.updateManyAndReturn({
        where: { id: existing.id },
        data: {
          mode: input.mode,
          config: jsonInput(input.config ?? existing.config),
          updatedAt: new Date(),
        },
      }),
      map: (rows) => rows.map((row) => ({ ...row, config: readJsonObject(row.config) })),
    });

    if (!updated) {
      throw new Error(FAILED_TO_UPDATE_AGENT_TOOL_POLICY_MESSAGE);
    }

    return updated;
  }

  const created = await mapRow({
    value: db.agentToolPolicies.create({
      data: {
        agentProfileId: input.agentProfileId,
        toolName: input.toolName,
        mode: input.mode,
        config: jsonInput(input.config ?? {}),
      },
    }),
    map: (row) => ({ ...row, config: readJsonObject(row.config) }),
  });

  return created;
}

type CreateAgentToolInvocationResult = Promise<{
  status: string;
  id: string;
  createdAt: Date;
  userId: string;
  provider: string;
  idempotencyKey: string | null;
  meetingId: string;
  agentProfileId: string;
  utteranceId: string;
  toolName: string;
  connectorId: string | null;
  toolVersion: string;
  policyVersion: string;
  sideEffectClass: string;
  confirmationStatus: string;
  confirmationActorUserId: string | null;
  redactedArgs: Record<string, unknown>;
  redactedResultSummary: Record<string, unknown>;
  errorCode: string | null;
  durationMs: number | null;
  confirmedAt: Date | null;
  executedAt: Date | null;
}>;
type createAgentToolInvocationRow5 = {
  meetingId: string;
  utteranceId: string;
  userId: string;
  agentProfileId: string;
  connectorId?: string | null;
  provider: string;
  toolName: string;
  toolVersion: string;
  policyVersion: string;
  sideEffectClass: string;
  status: string;
  confirmationStatus?: string;
  confirmationActorUserId?: string | null;
  idempotencyKey?: string | null;
  redactedArgs?: Record<string, unknown>;
  redactedResultSummary?: Record<string, unknown>;
  errorCode?: string | null;
  durationMs?: number | null;
  confirmedAt?: Date | null;
  executedAt?: Date | null;
};

export async function createAgentToolInvocation(input: createAgentToolInvocationRow5): CreateAgentToolInvocationResult {
  const row = await mapRow({
    value: db.agentToolInvocations.create({
      data: {
        meetingId: input.meetingId,
        utteranceId: input.utteranceId,
        userId: input.userId,
        agentProfileId: input.agentProfileId,
        connectorId: input.connectorId ?? null,
        provider: input.provider,
        toolName: input.toolName,
        toolVersion: input.toolVersion,
        policyVersion: input.policyVersion,
        sideEffectClass: input.sideEffectClass,
        status: input.status,
        confirmationStatus: input.confirmationStatus ?? "not_required",
        confirmationActorUserId: input.confirmationActorUserId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        redactedArgs: jsonInput(input.redactedArgs ?? {}),
        redactedResultSummary: jsonInput(input.redactedResultSummary ?? {}),
        errorCode: input.errorCode ?? null,
        durationMs: input.durationMs ?? null,
        confirmedAt: input.confirmedAt ?? null,
        executedAt: input.executedAt ?? null,
      },
    }),
    map: (row) => ({
      ...row,
      redactedArgs: readJsonObject(row.redactedArgs),
      redactedResultSummary: readJsonObject(row.redactedResultSummary),
    }),
  });

  return row;
}

type GetAgentToolInvocationByIdResult = Promise<{
  id: string;
  meetingId: string;
  utteranceId: string;
  userId: string;
  agentProfileId: string;
  connectorId: string | null;
  provider: string;
  toolName: string;
  toolVersion: string;
  policyVersion: string;
  sideEffectClass: string;
  status: string;
  confirmationStatus: string;
  confirmationActorUserId: string | null;
  idempotencyKey: string | null;
  redactedArgs: Record<string, unknown>;
  redactedResultSummary: Record<string, unknown>;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: Date;
  confirmedAt: Date | null;
  executedAt: Date | null;
} | null>;

export async function getAgentToolInvocationById(invocationId: string): GetAgentToolInvocationByIdResult {
  const row = await mapRow({
    value: db.agentToolInvocations.findFirst({
      where: { id: invocationId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            redactedArgs: readJsonObject(row.redactedArgs),
            redactedResultSummary: readJsonObject(row.redactedResultSummary),
          },
  });

  return row ?? null;
}

type GetAgentToolInvocationByIdempotencyKeyResult = Promise<{
  id: string;
  meetingId: string;
  utteranceId: string;
  userId: string;
  agentProfileId: string;
  connectorId: string | null;
  provider: string;
  toolName: string;
  toolVersion: string;
  policyVersion: string;
  sideEffectClass: string;
  status: string;
  confirmationStatus: string;
  confirmationActorUserId: string | null;
  idempotencyKey: string | null;
  redactedArgs: Record<string, unknown>;
  redactedResultSummary: Record<string, unknown>;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: Date;
  confirmedAt: Date | null;
  executedAt: Date | null;
} | null>;

export async function getAgentToolInvocationByIdempotencyKey(
  idempotencyKey: string,
): GetAgentToolInvocationByIdempotencyKeyResult {
  const row = await mapRow({
    value: db.agentToolInvocations.findFirst({
      where: { idempotencyKey },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            redactedArgs: readJsonObject(row.redactedArgs),
            redactedResultSummary: readJsonObject(row.redactedResultSummary),
          },
  });

  return row ?? null;
}

type AgentToolInvocationDetailChanges = {
  confirmationActorUserId?: string | null;
  redactedResultSummary?: Record<string, unknown>;
  errorCode?: string | null;
  durationMs?: number | null;
  confirmedAt?: Date | null;
  executedAt?: Date | null;
};

/** The only way to change an invocation's status: the write applies only if the row still matches `expected`. */
export async function transitionAgentToolInvocation(input: {
  expected: Pick<
    NonNullable<Awaited<GetAgentToolInvocationByIdResult>>,
    "id" | "userId" | "meetingId" | "agentProfileId" | "status" | "confirmationStatus" | "confirmedAt"
  >;
  changes: AgentToolInvocationDetailChanges & {
    status?: string;
    confirmationStatus?: string;
  };
}): GetAgentToolInvocationByIdResult {
  const { expected } = input;
  const changes = (await encodeContentRow({
    model: "agentToolInvocations",
    data: input.changes,
    isCreating: false,
    identity: {
      id: expected.id,
    },
  })) as typeof input.changes;
  const [row] = await (async () => {
    const optionalColumns: {
      column: string;
      value: unknown;
      cast: SqlCast;
    }[] = [
      { column: "confirmation_actor_user_id", value: changes.confirmationActorUserId, cast: "uuid" },
      { column: "redacted_result_summary", value: changes.redactedResultSummary, cast: "jsonb" },
      { column: "error_code", value: changes.errorCode, cast: null },
      { column: "duration_ms", value: changes.durationMs, cast: "int" },
      { column: "executed_at", value: changes.executedAt, cast: "timestamptz" },
      { column: "status", value: changes.status, cast: null },
      { column: "confirmation_status", value: changes.confirmationStatus, cast: null },
      {
        column: "confirmed_at",
        value: changes.status === "running" ? undefined : changes.confirmedAt,
        cast: "timestamptz",
      },
    ];
    const optionalAssignments = optionalColumns.flatMap((column) =>
      column.value === undefined ? [] : [sqlAssign(column)],
    );
    // Keep attempt times increasing even when a retry happens within the same millisecond.
    const assignments =
      changes.status === "running"
        ? [
            ...optionalAssignments,
            Prisma.sql`${Prisma.raw('"confirmed_at"')} = greatest(date_trunc('milliseconds', clock_timestamp()), "confirmed_at" + interval '1 millisecond')`,
          ]
        : optionalAssignments;
    if (assignments.length === 0) {
      return [];
    }
    const where = sqlAnd([
      sqlCompare({ columnSql: '"agent_tool_invocations"."id"', operator: "=", value: expected.id, cast: "uuid" }),
      sqlCompare({
        columnSql: '"agent_tool_invocations"."user_id"',
        operator: "=",
        value: expected.userId,
        cast: "uuid",
      }),
      sqlCompare({
        columnSql: '"agent_tool_invocations"."meeting_id"',
        operator: "=",
        value: expected.meetingId,
        cast: "uuid",
      }),
      sqlCompare({
        columnSql: '"agent_tool_invocations"."agent_profile_id"',
        operator: "=",
        value: expected.agentProfileId,
        cast: "uuid",
      }),
      sqlCompare({ columnSql: '"agent_tool_invocations"."status"', operator: "=", value: expected.status, cast: null }),
      sqlCompare({
        columnSql: '"agent_tool_invocations"."confirmation_status"',
        operator: "=",
        value: expected.confirmationStatus,
        cast: null,
      }),
      expected.confirmedAt === null
        ? sqlIsNull({ columnSql: '"agent_tool_invocations"."confirmed_at"', isNegated: false })
        : sqlCompare({
            columnSql: '"agent_tool_invocations"."confirmed_at"',
            operator: "=",
            value: expected.confirmedAt,
            cast: "timestamptz",
          }),
    ]);

    return db.$queryRaw<Prisma.agentToolInvocationsModel[]>`
                          UPDATE "agent_tool_invocations"
                          SET ${Prisma.join(assignments, ", ")}
                          ${sqlWhereClause(where)}
                          RETURNING "id" AS "id", "meeting_id" AS "meetingId", "utterance_id" AS "utteranceId", "user_id" AS "userId", "agent_profile_id" AS "agentProfileId", "connector_id" AS "connectorId", "provider" AS "provider", "tool_name" AS "toolName", "tool_version" AS "toolVersion", "policy_version" AS "policyVersion", "side_effect_class" AS "sideEffectClass", "status" AS "status", "confirmation_status" AS "confirmationStatus", "confirmation_actor_user_id" AS "confirmationActorUserId", "idempotency_key" AS "idempotencyKey", "redacted_args" AS "redactedArgs", "redacted_result_summary" AS "redactedResultSummary", "error_code" AS "errorCode", "duration_ms" AS "durationMs", "created_at" AS "createdAt", "confirmed_at" AS "confirmedAt", "executed_at" AS "executedAt"
                        `;
  })();

  return decodedToolInvocation(row);
}

async function decodedToolInvocation(row: Prisma.agentToolInvocationsModel | undefined) {
  const decoded = row === undefined ? undefined : await decodeContentRow({ model: "agentToolInvocations", value: row });

  return decoded === undefined
    ? null
    : {
        ...decoded,
        redactedArgs: readJsonObject(decoded.redactedArgs),
        redactedResultSummary: readJsonObject(decoded.redactedResultSummary),
      };
}

type UpdateAgentToolInvocationResult = Promise<{
  id: string;
  meetingId: string;
  utteranceId: string;
  userId: string;
  agentProfileId: string;
  connectorId: string | null;
  provider: string;
  toolName: string;
  toolVersion: string;
  policyVersion: string;
  sideEffectClass: string;
  status: string;
  confirmationStatus: string;
  confirmationActorUserId: string | null;
  idempotencyKey: string | null;
  redactedArgs: Record<string, unknown>;
  redactedResultSummary: Record<string, unknown>;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: Date;
  confirmedAt: Date | null;
  executedAt: Date | null;
}>;

/** Updates details only; status changes must go through `transitionAgentToolInvocation`. */
export async function updateAgentToolInvocation(
  input: AgentToolInvocationDetailChanges & { invocationId: string },
): UpdateAgentToolInvocationResult {
  const [row] = await mapRow({
    value: db.agentToolInvocations.updateManyAndReturn({
      where: { id: input.invocationId },
      data: {
        ...(input.confirmationActorUserId !== undefined
          ? { confirmationActorUserId: input.confirmationActorUserId }
          : {}),
        ...(input.redactedResultSummary !== undefined
          ? { redactedResultSummary: jsonInput(input.redactedResultSummary) }
          : {}),
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.confirmedAt !== undefined ? { confirmedAt: input.confirmedAt } : {}),
        ...(input.executedAt !== undefined ? { executedAt: input.executedAt } : {}),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        redactedArgs: readJsonObject(row.redactedArgs),
        redactedResultSummary: readJsonObject(row.redactedResultSummary),
      })),
  });

  if (!row) {
    throw new Error(FAILED_TO_UPDATE_AGENT_TOOL_INVOCATION_MESSAGE);
  }

  return row;
}

type GetMeetingByRoomNameResult = Promise<{
  id: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  workspaceId: string;
  createdByUserId: string;
  kind: MeetingKind;
  status: "scheduled" | "active" | "ended";
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
} | null>;

export async function getMeetingByRoomName(roomName: string): GetMeetingByRoomNameResult {
  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { roomName },
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredMeeting(row)),
  });

  return meeting ?? null;
}

type MarkMeetingHiddenFromHistoryResult = Promise<{
  id: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  workspaceId: string;
  createdByUserId: string;
  kind: MeetingKind;
  status: "scheduled" | "active" | "ended";
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
} | null>;

const readStoredMeetingTaskList = (row: Prisma.meetingTaskListsModel) => ({
  ...row,
  status: meetingTaskListStatusSchema.parse(row.status),
  error: row.error === null ? null : readJsonObject(row.error),
});

const bumpMeetingTaskListVersions = async (args: {
  executor: typeof db | AccountTransaction;
  taskListIds: string[];
}) => {
  const { executor, taskListIds } = args;
  await mapRowsSequentially({
    rows: await mapRow({
      value: executor.meetingTaskLists.findMany({
        where: { id: { in: taskListIds } },
      }),
      map: (rows) => rows.map(readStoredMeetingTaskList),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: executor.meetingTaskLists.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            taskListVersion: storedRow.taskListVersion + 1,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map(readStoredMeetingTaskList),
      });

      return updatedRows[0];
    },
  });
};

export async function markMeetingHiddenFromHistory(input: {
  meetingId: string;
  reason: string;
  actorUserId?: string | null;
}): MarkMeetingHiddenFromHistoryResult {
  const [updatedMeeting] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.meetings.findMany({
        where: { id: input.meetingId },
      }),
      map: (rows) => rows.map((row) => readStoredMeeting(row)),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.meetings.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            hiddenFromHistoryAt: storedRow.hiddenFromHistoryAt ?? new Date(),
            hiddenFromHistoryReason: input.reason,
          },
        }),
        map: (rows) => rows.map((row) => readStoredMeeting(row)),
      });

      return updatedRows[0];
    },
  });

  if (!updatedMeeting) {
    return null;
  }

  const existingTasks = await db.meetingTasks.findMany({
    where: { meetingId: input.meetingId },
    select: {
      id: true,
      ownerUserId: true,
      taskListId: true,
      revision: true,
    },
  });
  const taskIds = existingTasks.map((task) => task.id);
  const workspaceId = updatedMeeting.workspaceId;

  if (taskIds.length !== 0) {
    await db.assignedTaskPlacements.deleteMany({
      where: whereAnd([{ sourceType: "meeting" }, { sourceTaskId: { in: taskIds } }]),
    });

    const taskListIds = [...new Set(existingTasks.map((task) => task.taskListId))];
    await bumpMeetingTaskListVersions({ executor: db, taskListIds });

    const recipientWorkspaces = await eligibleMeetingTaskRecipientWorkspaces({
      meetingId: input.meetingId,
      assigneeUserIds: existingTasks.map((task) => task.ownerUserId),
    });
    const events = existingTasks.flatMap((task) => {
      const payload = buildTaskRealtimePayload({
        eventName: "task.deleted",
        workspaceId: updatedMeeting.workspaceId,
        meetingId: input.meetingId,
        taskId: task.id,
        revision: task.revision + 1,
        actorUserId: input.actorUserId ?? null,
      });
      const userEvents =
        task.ownerUserId !== null && task.ownerUserId !== ""
          ? meetingUserTaskRealtimeEvents({
              recipientWorkspaces,
              userId: task.ownerUserId,
              eventName: "task.deleted",
              payload,
              dedupeKey: `task:${task.id}:deleted:user:${task.ownerUserId}:meeting-hidden`,
            })
          : [];

      return [
        {
          channel: meetingTasksRealtimeChannel({ workspaceId, meetingId: input.meetingId }),
          eventName: "task.deleted",
          payload,
          dedupeKey: `task:${task.id}:deleted:meeting-hidden`,
        },
        ...userEvents,
      ];
    });
    await publishRealtimeEvents(
      await addMeetingTaskAttendeeRealtimeEvents({
        meetingId: input.meetingId,
        workspaceId,
        events,
      }),
    );
  }

  return updatedMeeting;
}

/** Each lookup executes once; no per-row correlated previous-segment scan. */
export async function listTranscriptSegmentsInWindow(input: {
  meetingId: string;
  since: Date;
  until: Date;
  /** @external existing wire contract */ includePrevious?: boolean;
  segmentIds?: string[];
}): Promise<
  {
    id: string;
    speakerUserId: string | null;
    speakerRole: string;
    content: string;
    startedAt: Date;
    endedAt: Date | null;
  }[]
> {
  const [window, previous, recorded] = await Promise.all([
    db.transcriptSegments.findMany({
      where: whereAnd([
        { transcripts: { meetingId: input.meetingId } },
        { startedAt: { gte: input.since } },
        { startedAt: { lte: input.until } },
      ]),
      select: {
        id: true,
        speakerUserId: true,
        speakerRole: true,
        content: true,
        startedAt: true,
        endedAt: true,
      },
    }),
    input.includePrevious === true
      ? db.transcriptSegments.findMany({
          where: whereAnd([
            { transcripts: { meetingId: input.meetingId } },
            { speakerRole: "human" },
            { startedAt: { lt: input.since } },
          ]),
          orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: {
            id: true,
            speakerUserId: true,
            speakerRole: true,
            content: true,
            startedAt: true,
            endedAt: true,
          },
        })
      : Promise.resolve([]),
    input.segmentIds !== undefined && input.segmentIds.length !== 0
      ? db.transcriptSegments.findMany({
          where: whereAnd([{ transcripts: { meetingId: input.meetingId } }, { id: { in: input.segmentIds } }]),
          select: {
            id: true,
            speakerUserId: true,
            speakerRole: true,
            content: true,
            startedAt: true,
            endedAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  return [...new Map([...previous, ...window, ...recorded].map((segment) => [segment.id, segment])).values()].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
}

type GetTranscriptForMeetingResult = Promise<{
  transcript: { id: string; meetingId: string; source: string; metadata: Record<string, unknown>; createdAt: Date };
  segments:
    | {
        id: string;
        transcriptId: string;
        speakerIdentity: string;
        speakerUserId: string | null;
        speakerRole: string;
        speakerName: string;
        source: string;
        sourceSegmentId: string | null;
        meetingTurnId: string | null;
        agentProfileId: string | null;
        agentOwnerUserId: string | null;
        voiceId: string | null;
        content: string;
        startedAt: Date;
        endedAt: Date | null;
        createdAt: Date;
      }[]
    | {
        speakerIdentity: string;
        speakerRole: "human";
        source: "legacy-transcript";
        sourceSegmentId: string | null;
        id: string;
        transcriptId: string;
        speakerUserId: string | null;
        speakerName: string;
        content: string;
        startedAt: Date;
        endedAt: Date | null;
        createdAt: Date;
      }[];
} | null>;

const TRANSCRIPT_SEGMENT_PAGE_LIMIT = 200;

export async function listTranscriptSegmentsAfter(input: {
  meetingId: string;
  createdAt: Date;
  segmentId: string;
  limit?: number;
}): Promise<{ id: string; createdAt: Date; startedAt: Date; content: string }[]> {
  const requestedLimit = input.limit ?? TRANSCRIPT_SEGMENT_PAGE_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), TRANSCRIPT_SEGMENT_PAGE_LIMIT);

  return db.transcriptSegments.findMany({
    where: whereAnd([
      { transcripts: { meetingId: input.meetingId } },
      whereOr([
        { createdAt: { gt: input.createdAt } },
        whereAnd([{ createdAt: input.createdAt }, { id: { gt: input.segmentId } }]),
      ]),
    ]),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      createdAt: true,
      startedAt: true,
      content: true,
    },
  });
}

/** Read finalization metadata without decrypting segments or repairing old transcripts. */
export async function getMeetingTranscriptOverview(meetingId: string): Promise<{
  transcript: NonNullable<Awaited<GetTranscriptForMeetingResult>>["transcript"];
  hasTranscriptSegments: boolean;
} | null> {
  const transcript = await db.transcripts.findFirst({
    where: { meetingId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!transcript) {
    return null;
  }
  // Include segments on historical duplicate transcripts without moving or reading their content.
  const segment = await db.transcriptSegments.findFirst({
    where: { transcripts: { meetingId } },
    select: { id: true },
  });

  return {
    transcript: { ...transcript, metadata: readJsonObject(transcript.metadata) },
    hasTranscriptSegments: segment !== null,
  };
}

export async function getTranscriptForMeeting(meetingId: string): GetTranscriptForMeetingResult {
  const transcript = await ensureSingleTranscriptForMeeting(meetingId);

  if (!transcript) {
    return null;
  }

  const segments = await db.transcriptSegments.findMany({
    where: { transcriptId: transcript.id },
    orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }],
  });

  return { transcript, segments };
}

type CreateMeetingAssetResult = Promise<{
  id: string;
  createdAt: string;
  updatedAt: string;
  kind: "screen_capture";
  meetingId: string;
  mimeType: "image/jpeg" | "image/png";
  byteSize: number;
  width: number | null;
  height: number | null;
  capturedAt: string;
  participantIdentity: string | null;
  trackSid: string | null;
  trigger: "manual" | "automatic_task_context" | "automatic_bug_context";
  transcriptSegmentIds: string[];
  transcriptExcerpt: string | null;
  speakerName: string | null;
  /** @external existing wire contract */ includeInLinear: boolean;
}>;

const mergeExistingMeetingAsset = async (input: {
  input: {
    meetingId: string;
    contentHash: string;
    transcriptExcerpt?: string | null;
    speakerName?: string | null;
  };
  inputTranscriptSegmentIds: string[];
}): CreateMeetingAssetResult => {
  const { input: assetInput, inputTranscriptSegmentIds } = input;
  const existing = await mapRow({
    value: db.meetingAssets.findFirst({
      where: whereAnd([{ meetingId: assetInput.meetingId }, { contentHash: assetInput.contentHash }]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            trigger: meetingAssetTriggerSchema.parse(row.trigger),
            transcriptSegmentIds: readStringArray(row.transcriptSegmentIds),
          },
  });
  if (!existing) {
    throw new Error(FAILED_TO_PERSIST_MEETING_ASSET_MESSAGE);
  }
  const transcriptSegmentIds = [...new Set([...existing.transcriptSegmentIds, ...inputTranscriptSegmentIds])];
  if (transcriptSegmentIds.length > MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS) {
    throw new Error(meetingAssetSegmentLimitMessage());
  }
  const [merged] = await mapRow({
    value: db.meetingAssets.updateManyAndReturn({
      where: { id: existing.id },
      data: {
        transcriptSegmentIds: jsonInput(transcriptSegmentIds),
        transcriptExcerpt: existing.transcriptExcerpt ?? assetInput.transcriptExcerpt ?? null,
        speakerName: existing.speakerName ?? assetInput.speakerName ?? null,
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        trigger: meetingAssetTriggerSchema.parse(row.trigger),
        transcriptSegmentIds: readStringArray(row.transcriptSegmentIds),
      })),
  });

  return parseMeetingAssetRow(merged ?? existing);
};

export async function createMeetingAsset(input: {
  id?: string;
  meetingId: string;
  storageKey: string;
  contentHash: string;
  mimeType: "image/jpeg" | "image/png";
  byteSize: number;
  width?: number | null;
  height?: number | null;
  capturedAt: Date;
  participantIdentity?: string | null;
  trackSid?: string | null;
  trigger: MeetingAssetTrigger;
  transcriptSegmentId?: string | null;
  transcriptSegmentIds?: string[];
  transcriptExcerpt?: string | null;
  speakerName?: string | null;
}): CreateMeetingAssetResult {
  const inputTranscriptSegmentIds = [
    ...new Set([
      ...(input.transcriptSegmentIds ?? []),
      ...(typeof input.transcriptSegmentId === "string" && input.transcriptSegmentId !== ""
        ? [input.transcriptSegmentId]
        : []),
    ]),
  ];
  if (inputTranscriptSegmentIds.length > MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS) {
    throw new Error(meetingAssetSegmentLimitMessage());
  }
  const created = await mapRow({
    value: mapRow({
      value: insertRaw<Prisma.meetingAssetsModel>({
        executor: db,
        table: "meeting_assets",
        rows: [
          {
            ...(input.id !== undefined && input.id !== "" ? { id: input.id } : {}),
            meetingId: input.meetingId,
            storageKey: input.storageKey,
            contentHash: input.contentHash,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            width: input.width ?? null,
            height: input.height ?? null,
            capturedAt: input.capturedAt,
            participantIdentity: input.participantIdentity ?? null,
            trackSid: input.trackSid ?? null,
            trigger: input.trigger,
            transcriptSegmentIds: inputTranscriptSegmentIds,
            transcriptExcerpt: input.transcriptExcerpt ?? null,
            speakerName: input.speakerName ?? null,
          },
        ],
        columns: [
          { key: "id", column: "id", cast: "uuid" },
          { key: "meetingId", column: "meeting_id", cast: "uuid" },
          { key: "kind", column: "kind", cast: null },
          { key: "storageKey", column: "storage_key", cast: null },
          { key: "contentHash", column: "content_hash", cast: null },
          { key: "mimeType", column: "mime_type", cast: null },
          { key: "byteSize", column: "byte_size", cast: "int" },
          { key: "width", column: "width", cast: "int" },
          { key: "height", column: "height", cast: "int" },
          { key: "capturedAt", column: "captured_at", cast: "timestamptz" },
          { key: "participantIdentity", column: "participant_identity", cast: null },
          { key: "trackSid", column: "track_sid", cast: null },
          { key: "trigger", column: "trigger", cast: null },
          { key: "transcriptSegmentIds", column: "transcript_segment_ids", cast: "jsonb" },
          { key: "transcriptExcerpt", column: "transcript_excerpt", cast: null },
          { key: "speakerName", column: "speaker_name", cast: null },
          { key: "includeInLinear", column: "include_in_linear", cast: "boolean" },
          { key: "createdAt", column: "created_at", cast: "timestamptz" },
          { key: "updatedAt", column: "updated_at", cast: "timestamptz" },
        ],
        conflict: sqlConflictNothing({ targetSql: 'ON CONFLICT ("meeting_id", "content_hash")', where: undefined }),
        returning: Prisma.raw(
          '"id" AS "id", "meeting_id" AS "meetingId", "kind" AS "kind", "storage_key" AS "storageKey", "content_hash" AS "contentHash", "mime_type" AS "mimeType", "byte_size" AS "byteSize", "width" AS "width", "height" AS "height", "captured_at" AS "capturedAt", "participant_identity" AS "participantIdentity", "track_sid" AS "trackSid", "trigger" AS "trigger", "transcript_segment_ids" AS "transcriptSegmentIds", "transcript_excerpt" AS "transcriptExcerpt", "speaker_name" AS "speakerName", "include_in_linear" AS "includeInLinear", "created_at" AS "createdAt", "updated_at" AS "updatedAt"',
        ),
      }),
      map: (rows) => rows[0],
    }),
    map: (row) =>
      row === undefined
        ? undefined
        : {
            ...row,
            trigger: meetingAssetTriggerSchema.parse(row.trigger),
            transcriptSegmentIds: readStringArray(row.transcriptSegmentIds),
          },
  });
  if (created) {
    return parseMeetingAssetRow(created);
  }

  return mergeExistingMeetingAsset({ input, inputTranscriptSegmentIds });
}

type ListMeetingAssetsResult = Promise<
  {
    id: string;
    createdAt: string;
    updatedAt: string;
    kind: "screen_capture";
    meetingId: string;
    mimeType: "image/jpeg" | "image/png";
    byteSize: number;
    width: number | null;
    height: number | null;
    capturedAt: string;
    participantIdentity: string | null;
    trackSid: string | null;
    trigger: "manual" | "automatic_task_context" | "automatic_bug_context";
    transcriptSegmentIds: string[];
    transcriptExcerpt: string | null;
    speakerName: string | null;
    /** @external existing wire contract */ includeInLinear: boolean;
  }[]
>;

export async function listMeetingAssets(meetingId: string): ListMeetingAssetsResult {
  const rows = await mapRow({
    value: db.meetingAssets.findMany({
      where: { meetingId },
      orderBy: [{ capturedAt: "asc" }, { createdAt: "asc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        trigger: meetingAssetTriggerSchema.parse(row.trigger),
        transcriptSegmentIds: readStringArray(row.transcriptSegmentIds),
      })),
  });

  return rows.map(parseMeetingAssetRow);
}

type GetMeetingAssetByIdResult = Promise<{
  asset: {
    id: string;
    createdAt: string;
    updatedAt: string;
    kind: "screen_capture";
    meetingId: string;
    mimeType: "image/jpeg" | "image/png";
    byteSize: number;
    width: number | null;
    height: number | null;
    capturedAt: string;
    participantIdentity: string | null;
    trackSid: string | null;
    trigger: "manual" | "automatic_task_context" | "automatic_bug_context";
    transcriptSegmentIds: string[];
    transcriptExcerpt: string | null;
    speakerName: string | null;
    /** @external existing wire contract */ includeInLinear: boolean;
  };
  storageKey: string;
} | null>;

export async function getMeetingAssetById(input: { assetId: string; meetingId: string }): GetMeetingAssetByIdResult {
  const row = await mapRow({
    value: db.meetingAssets.findFirst({
      where: { id: input.assetId, meetingId: input.meetingId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            trigger: meetingAssetTriggerSchema.parse(row.trigger),
            transcriptSegmentIds: readStringArray(row.transcriptSegmentIds),
          },
  });

  return row ? { asset: parseMeetingAssetRow(row), storageKey: row.storageKey } : null;
}

type UpdateMeetingAssetResult = Promise<{
  id: string;
  createdAt: string;
  updatedAt: string;
  kind: "screen_capture";
  meetingId: string;
  mimeType: "image/jpeg" | "image/png";
  byteSize: number;
  width: number | null;
  height: number | null;
  capturedAt: string;
  participantIdentity: string | null;
  trackSid: string | null;
  trigger: "manual" | "automatic_task_context" | "automatic_bug_context";
  transcriptSegmentIds: string[];
  transcriptExcerpt: string | null;
  speakerName: string | null;
  /** @external existing wire contract */ includeInLinear: boolean;
} | null>;

export async function updateMeetingAsset(input: {
  assetId: string;
  meetingId: string;
  /** @external existing wire contract */ includeInLinear: boolean;
}): UpdateMeetingAssetResult {
  const [row] = await mapRow({
    value: db.meetingAssets.updateManyAndReturn({
      where: whereAnd([{ id: input.assetId }, { meetingId: input.meetingId }]),
      data: {
        includeInLinear: input.includeInLinear,
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        trigger: meetingAssetTriggerSchema.parse(row.trigger),
        transcriptSegmentIds: readStringArray(row.transcriptSegmentIds),
      })),
  });

  return row ? parseMeetingAssetRow(row) : null;
}

export async function ensureTranscriptForMeeting(
  meetingId: string,
): Promise<{ id: string; source: string; createdAt: Date; metadata: Record<string, unknown>; meetingId: string }> {
  const existing = await ensureSingleTranscriptForMeeting(meetingId);

  if (existing) {
    return existing;
  }

  return mapRow({
    value: db.transcripts.upsert({
      where: { meetingId },
      // Keep this a native database upsert without changing existing transcript metadata.
      update: { meetingId },
      create: {
        meetingId,
        source: "livekit",
        metadata: jsonInput({ mode: "placeholder" }),
      },
    }),
    map: (row) => ({ ...row, metadata: readJsonObject(row.metadata) }),
  });
}

type AppendTranscriptSegmentResult = Promise<
  | {
      id: string;
      source: string;
      createdAt: Date;
      startedAt: Date;
      endedAt: Date | null;
      voiceId: string | null;
      agentProfileId: string | null;
      content: string;
      speakerName: string;
      transcriptId: string;
      speakerIdentity: string;
      speakerUserId: string | null;
      speakerRole: string;
      sourceSegmentId: string | null;
      meetingTurnId: string | null;
      agentOwnerUserId: string | null;
    }
  | {
      speakerIdentity: string;
      speakerRole: "human";
      source: "legacy-transcript";
      sourceSegmentId: string | null;
      id: string;
      transcriptId: string;
      speakerUserId: string | null;
      speakerName: string;
      content: string;
      startedAt: Date;
      endedAt: Date | null;
      createdAt: Date;
    }
>;

export async function appendTranscriptSegment(input: {
  meetingId: string;
  speakerIdentity: string;
  speakerName: string;
  speakerUserId?: string;
  speakerRole: TranscriptSpeakerRole;
  source?: TranscriptSegmentSource;
  sourceSegmentId?: string;
  meetingTurnId?: string;
  agentProfileId?: string;
  agentOwnerUserId?: string;
  voiceId?: string;
  content: string;
  startedAt: Date;
  endedAt?: Date;
}): AppendTranscriptSegmentResult {
  const transcript = await ensureTranscriptForMeeting(input.meetingId);

  if (input.sourceSegmentId !== undefined && input.sourceSegmentId !== "") {
    const existing = await mapRow({
      value: db.transcriptSegments.findFirst({
        where: whereAnd([
          { transcriptId: transcript.id },
          { source: input.source ?? "legacy-transcript" },
          { sourceSegmentId: input.sourceSegmentId },
        ]),
        take: 1,
      }),
      map: (row) => row ?? undefined,
    });

    if (existing) {
      return existing;
    }
  }

  const segment = await db.transcriptSegments.create({
    data: {
      transcriptId: transcript.id,
      speakerIdentity: input.speakerIdentity,
      speakerName: input.speakerName,
      speakerUserId: input.speakerUserId,
      speakerRole: input.speakerRole,
      source: input.source ?? "legacy-transcript",
      sourceSegmentId: input.sourceSegmentId,
      meetingTurnId: input.meetingTurnId,
      agentProfileId: input.agentProfileId,
      agentOwnerUserId: input.agentOwnerUserId,
      voiceId: input.voiceId,
      content: input.content,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    },
  });

  return segment;
}

export async function updateTranscriptForMeeting(input: {
  meetingId: string;
  source?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; source: string; createdAt: Date; metadata: Record<string, unknown>; meetingId: string }> {
  const transcript = await ensureTranscriptForMeeting(input.meetingId);
  const nextMetadata = input.metadata ? { ...transcript.metadata, ...input.metadata } : transcript.metadata;

  const [updated] = await mapRow({
    value: db.transcripts.updateManyAndReturn({
      where: { id: transcript.id },
      data: {
        source: input.source ?? transcript.source,
        metadata: jsonInput(nextMetadata),
      },
    }),
    map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
  });

  return updated ?? transcript;
}

type ReplaceTranscriptSegmentsForMeetingResult = Promise<
  (
    | {
        id: string;
        source: string;
        createdAt: Date;
        startedAt: Date;
        endedAt: Date | null;
        voiceId: string | null;
        agentProfileId: string | null;
        content: string;
        speakerName: string;
        transcriptId: string;
        speakerIdentity: string;
        speakerUserId: string | null;
        speakerRole: string;
        sourceSegmentId: string | null;
        meetingTurnId: string | null;
        agentOwnerUserId: string | null;
      }
    | {
        speakerIdentity: string;
        speakerRole: "human";
        source: "legacy-transcript";
        sourceSegmentId: string | null;
        id: string;
        transcriptId: string;
        speakerUserId: string | null;
        speakerName: string;
        content: string;
        startedAt: Date;
        endedAt: Date | null;
        createdAt: Date;
      }
  )[]
>;

export async function replaceTranscriptSegmentsForMeeting(input: {
  meetingId: string;
  source?: string;
  metadata?: Record<string, unknown>;
  segments: {
    speakerIdentity: string;
    speakerName: string;
    speakerUserId?: string;
    speakerRole: TranscriptSpeakerRole;
    source?: TranscriptSegmentSource;
    sourceSegmentId?: string;
    content: string;
    startedAt: Date;
    endedAt?: Date;
  }[];
}): ReplaceTranscriptSegmentsForMeetingResult {
  const transcript = await ensureTranscriptForMeeting(input.meetingId);
  const nextMetadata = input.metadata ? { ...transcript.metadata, ...input.metadata } : transcript.metadata;

  await db.transcripts.updateMany({
    where: { id: transcript.id },
    data: {
      source: input.source ?? transcript.source,
      metadata: jsonInput(nextMetadata),
    },
  });

  await db.transcriptSegments.deleteMany({
    where: { transcriptId: transcript.id },
  });

  if (input.segments.length === 0) {
    return [];
  }

  return db.transcriptSegments.createManyAndReturn({
    data: input.segments.map((segment) => ({
      transcriptId: transcript.id,
      speakerIdentity: segment.speakerIdentity,
      speakerName: segment.speakerName,
      speakerUserId: segment.speakerUserId,
      speakerRole: segment.speakerRole,
      source: segment.source ?? "legacy-transcript",
      sourceSegmentId: segment.sourceSegmentId,
      content: segment.content,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
    })),
  });
}

type ReplaceTranscriptSegmentsForMeetingBySourcesResult = Promise<
  (
    | {
        id: string;
        source: string;
        createdAt: Date;
        startedAt: Date;
        endedAt: Date | null;
        voiceId: string | null;
        agentProfileId: string | null;
        content: string;
        speakerName: string;
        transcriptId: string;
        speakerIdentity: string;
        speakerUserId: string | null;
        speakerRole: string;
        sourceSegmentId: string | null;
        meetingTurnId: string | null;
        agentOwnerUserId: string | null;
      }
    | {
        speakerIdentity: string;
        speakerRole: "human";
        source: "legacy-transcript";
        sourceSegmentId: string | null;
        id: string;
        transcriptId: string;
        speakerUserId: string | null;
        speakerName: string;
        content: string;
        startedAt: Date;
        endedAt: Date | null;
        createdAt: Date;
      }
  )[]
>;

async function remapMeetingTranscriptSegmentCursorsWithin(args: {
  input: {
    meetingId: string;
  };
  inserted: {
    id: string;
    speakerRole: string;
    startedAt: Date;
    endedAt: Date | null;
  }[];
}) {
  const { input, inserted } = args;
  const [[ambientCursor], [liveTaskCursor]] = await Promise.all([
    db.meetingAmbientContextCursors.findMany({
      where: { meetingId: input.meetingId },
      take: 1,
    }),
    db.meetingLiveTaskCursors.findMany({
      where: { meetingId: input.meetingId },
      take: 1,
    }),
  ]);

  const remappedSegmentFor = (
    cursor:
      | {
          lastProcessedSegmentId: string | null;
          processedThrough: Date | null;
        }
      | undefined,
  ) => {
    if (!cursor || Boolean(cursor.lastProcessedSegmentId) || !cursor.processedThrough) {
      return null;
    }
    const processedThroughMs = cursor.processedThrough.getTime();

    return inserted
      .filter(
        (segment) =>
          segment.speakerRole === "human" && (segment.endedAt ?? segment.startedAt).getTime() <= processedThroughMs,
      )
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
      .at(-1);
  };

  const remappedAmbientSegment = remappedSegmentFor(ambientCursor);
  if (remappedAmbientSegment) {
    await db.meetingAmbientContextCursors.updateMany({
      where: { meetingId: input.meetingId },
      data: {
        lastProcessedSegmentId: remappedAmbientSegment.id,
        updatedAt: new Date(),
      },
    });
  }

  const remappedLiveTaskSegment = remappedSegmentFor(liveTaskCursor);
  if (remappedLiveTaskSegment) {
    await db.meetingLiveTaskCursors.updateMany({
      where: { meetingId: input.meetingId },
      data: {
        lastProcessedSegmentId: remappedLiveTaskSegment.id,
        updatedAt: new Date(),
      },
    });
  }
}
type replaceTranscriptSegmentsForMeetingBySourcesWithinRow6 = {
  input: {
    meetingId: string;
    source?: string;
    metadata?: Record<string, unknown>;
    deleteSources: TranscriptSegmentSource[];
    segments: {
      speakerIdentity: string;
      speakerName: string;
      speakerUserId?: string;
      speakerRole: TranscriptSpeakerRole;
      source: TranscriptSegmentSource;
      sourceSegmentId?: string;
      content: string;
      startedAt: Date;
      endedAt?: Date;
    }[];
  };
  transcript: { id: string; source: string; createdAt: Date; metadata: Record<string, unknown>; meetingId: string };
  nextMetadata: { [x: string]: unknown };
};

const replaceTranscriptSegmentsForMeetingBySourcesWithin = async (
  args: replaceTranscriptSegmentsForMeetingBySourcesWithinRow6,
) => {
  const { input, transcript, nextMetadata } = args;

  await db.transcripts.updateMany({
    where: { id: transcript.id },
    data: {
      source: input.source ?? transcript.source,
      metadata: jsonInput(nextMetadata),
    },
  });

  const deleteConditions = input.deleteSources.map((segmentSource) => ({ source: segmentSource }));

  if (deleteConditions.length !== 0) {
    const [onlyDeleteCondition] = deleteConditions;
    const sourceCondition = deleteConditions.length === 1 ? onlyDeleteCondition : whereOr(deleteConditions);
    if (sourceCondition) {
      await db.transcriptSegments.deleteMany({
        where: whereAnd([{ transcriptId: transcript.id }, sourceCondition]),
      });
    }
  }

  const inserted =
    input.segments.length === 0
      ? []
      : await db.transcriptSegments.createManyAndReturn({
          data: input.segments.map((segment) => ({
            transcriptId: transcript.id,
            speakerIdentity: segment.speakerIdentity,
            speakerName: segment.speakerName,
            speakerUserId: segment.speakerUserId,
            speakerRole: segment.speakerRole,
            source: segment.source,
            sourceSegmentId: segment.sourceSegmentId,
            content: segment.content,
            startedAt: segment.startedAt,
            endedAt: segment.endedAt,
          })),
        });

  await remapMeetingTranscriptSegmentCursorsWithin({ input, inserted });

  return inserted;
};

export async function replaceTranscriptSegmentsForMeetingBySources(input: {
  meetingId: string;
  source?: string;
  metadata?: Record<string, unknown>;
  deleteSources: TranscriptSegmentSource[];
  segments: {
    speakerIdentity: string;
    speakerName: string;
    speakerUserId?: string;
    speakerRole: TranscriptSpeakerRole;
    source: TranscriptSegmentSource;
    sourceSegmentId?: string;
    content: string;
    startedAt: Date;
    endedAt?: Date;
  }[];
}): ReplaceTranscriptSegmentsForMeetingBySourcesResult {
  if (!(await hasTranscriptSegmentMetadataColumns())) {
    return replaceTranscriptSegmentsForMeeting({
      meetingId: input.meetingId,
      source: input.source,
      metadata: input.metadata,
      segments: input.segments,
    });
  }

  const transcript = await ensureTranscriptForMeeting(input.meetingId);
  const nextMetadata = input.metadata ? { ...transcript.metadata, ...input.metadata } : transcript.metadata;

  return replaceTranscriptSegmentsForMeetingBySourcesWithin({ input, transcript, nextMetadata });
}

async function ensureSingleTranscriptForMeeting(meetingId: string) {
  return (async () => {
    const transcriptRows = await mapRow({
      value: db.transcripts.findMany({
        where: { meetingId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
    });

    const [primaryTranscript, ...duplicateTranscripts] = transcriptRows;
    if (!primaryTranscript) {
      return null;
    }

    if (duplicateTranscripts.length === 0) {
      return primaryTranscript;
    }

    const duplicateIds = duplicateTranscripts.map((transcript) => transcript.id);

    await db.transcriptSegments.updateMany({
      where: { transcriptId: { in: duplicateIds } },
      data: {
        transcriptId: primaryTranscript.id,
      },
    });

    await db.transcripts.deleteMany({
      where: { id: { in: duplicateIds } },
    });

    return primaryTranscript;
  })();
}

export async function getSummaryForMeeting(meetingId: string): Promise<{
  id: string;
  meetingId: string;
  content: string;
  model: string;
  generatedAt: Date;
  createdAt: Date;
} | null> {
  const summary = await mapRow({
    value: db.summaries.findFirst({
      where: { meetingId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return summary ?? null;
}

/** One query for the summaries of many meetings, keyed by meeting id (meetings without one are absent). */
export async function getSummariesForMeetings(
  meetingIds: string[],
): Promise<Map<string, NonNullable<Awaited<ReturnType<typeof getSummaryForMeeting>>>>> {
  if (meetingIds.length === 0) {
    return new Map();
  }
  const rows = await db.summaries.findMany({ where: { meetingId: { in: meetingIds } } });

  return new Map(rows.map((row) => [row.meetingId, row]));
}

export async function listActionItemsForMeeting(meetingId: string): Promise<
  {
    id: string;
    meetingId: string;
    text: string;
    assignee: string | null;
    status: "open" | "done";
    createdAt: Date;
    updatedAt: Date;
  }[]
> {
  return mapRow({
    value: db.actionItems.findMany({
      where: { meetingId },
      orderBy: [{ createdAt: "desc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({ ...row, status: readStringUnion({ values: ["open", "done"], value: row.status }) })),
  });
}

export async function createActionItemForMeeting(input: {
  meetingId: string;
  text: string;
  assignee?: string | null;
}): Promise<{
  status: "open" | "done";
  id: string;
  createdAt: Date;
  updatedAt: Date;
  meetingId: string;
  text: string;
  assignee: string | null;
}> {
  const item = await mapRow({
    value: db.actionItems.create({
      data: {
        meetingId: input.meetingId,
        text: input.text,
        assignee: input.assignee ?? null,
        status: "open",
      },
    }),
    map: (row) => ({
      ...row,
      status: readStringUnion({ values: ["open", "done"], value: row.status }),
    }),
  });

  return item;
}

export async function upsertSummaryForMeeting(input: {
  meetingId: string;
  content: string;
  model: string;
  shouldPreserveExisting?: boolean;
  jobId?: string | null;
}): Promise<{ id: string; createdAt: Date; meetingId: string; content: string; model: string; generatedAt: Date }> {
  return withUniqueViolationRetry({
    run: () => withRequestResult({ ...input, run: (executor) => insertSummaryForMeeting({ ...input, executor }) }),
  });
}

async function insertSummaryForMeeting(input: {
  executor: typeof db | AccountTransaction;
  meetingId: string;
  content: string;
  model: string;
  shouldPreserveExisting?: boolean;
}): Promise<{ id: string; createdAt: Date; meetingId: string; content: string; model: string; generatedAt: Date }> {
  const [summary] =
    input.shouldPreserveExisting === true
      ? await insertRaw<Prisma.summariesModel>({
          executor: input.executor,
          table: "summaries",
          rows: [
            {
              meetingId: input.meetingId,
              content: input.content,
              model: input.model,
            },
          ],
          columns: [
            { key: "id", column: "id", cast: "uuid" },
            { key: "meetingId", column: "meeting_id", cast: "uuid" },
            { key: "content", column: "content", cast: null },
            { key: "model", column: "model", cast: null },
            { key: "generatedAt", column: "generated_at", cast: "timestamptz" },
            { key: "createdAt", column: "created_at", cast: "timestamptz" },
          ],
          conflict: sqlConflictNothing({ targetSql: 'ON CONFLICT ("meeting_id")', where: undefined }),
          returning: Prisma.raw(
            '"id" AS "id", "meeting_id" AS "meetingId", "content" AS "content", "model" AS "model", "generated_at" AS "generatedAt", "created_at" AS "createdAt"',
          ),
        })
      : await mapRow({
          value: (async () => {
            const data = {
              meetingId: input.meetingId,
              content: input.content,
              model: input.model,
            };

            return input.executor.summaries.upsert({
              where: { meetingId: data.meetingId },
              create: data,
              update: {
                content: input.content,
                model: input.model,
                generatedAt: new Date(),
              },
            });
          })(),
          map: (row) => [row],
        });

  const saved =
    summary ??
    (input.shouldPreserveExisting === true
      ? ((await mapRow({
          value: input.executor.summaries.findFirst({
            where: { meetingId: input.meetingId },
            take: 1,
          }),
          map: (row) => row ?? undefined,
        })) ?? undefined)
      : null);
  if (!saved) {
    throw new Error(FAILED_TO_UPSERT_SUMMARY_MESSAGE);
  }

  return saved;
}

export async function replaceActionItemsForMeeting(
  ...args: [meetingId: string, items: { text: string; assignee?: string | null }[], jobId?: string | null]
): Promise<
  {
    status: "open" | "done";
    id: string;
    createdAt: Date;
    updatedAt: Date;
    meetingId: string;
    text: string;
    assignee: string | null;
  }[]
> {
  const [meetingId, items, jobId] = args;

  return withRequestResult({
    meetingId,
    jobId,
    run: async (executor) => {
      await executor.actionItems.deleteMany({
        where: { meetingId },
      });

      if (items.length === 0) {
        return [];
      }

      return mapRow({
        value: executor.actionItems.createManyAndReturn({
          data: items.map((item) => ({
            meetingId,
            text: item.text,
            assignee: item.assignee ?? null,
            status: "open" as const,
          })),
        }),
        map: (rows) =>
          rows.map((row) => ({ ...row, status: readStringUnion({ values: ["open", "done"], value: row.status }) })),
      });
    },
  });
}

export type LiveMeetingTaskEvidenceInput = {
  roles: LiveMeetingTaskEvidenceRole[];
  transcriptSegmentId: string | null;
  sourceSegmentId: string | null;
  fullSegmentText: string;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  contentHash: string;
  speakerIdentity: string | null;
  speakerUserId: string | null;
  speakerName: string;
  startedAt: Date;
  endedAt: Date;
  sequence: number;
};

type ListMeetingLiveTaskCandidatesResult = Promise<
  {
    id: string;
    createdAt: string;
    updatedAt: string;
    meetingId: string;
    promptVersion: string | null;
    model: string | null;
    revision: number;
    actionConfirmableAt: string | null;
    linkedTaskId: string | null;
    state: "deferred" | "confirmed" | "rejected" | "retracted";
    unresolvedQuestions: string[];
    firstEvidenceAt: string;
    lastEvidenceAt: string;
    evidence: {
      id: string;
      startedAt: string;
      endedAt: string;
      contentHash: string;
      speakerName: string;
      speakerIdentity: string | null;
      speakerUserId: string | null;
      sourceSegmentId: string | null;
      quote: string;
      candidateId: string;
      roles: ("owner" | "scope" | "completion" | "due_date" | "action" | "cancellation" | "context")[];
      transcriptSegmentId: string | null;
      fullSegmentText: string;
      quoteStart: number;
      quoteEnd: number;
      sequence: number;
    }[];
    proposal: {
      type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
      owner: {
        name: string | null;
        email: string | null;
        userId: string | null;
        confidence: "low" | "medium" | "high" | null;
      };
      title: string;
      description: string | null;
      workKind:
        | "bug_or_issue"
        | "implementation"
        | "design"
        | "research"
        | "customer_follow_up"
        | "sales_or_crm"
        | "scheduling"
        | "documentation"
        | "general";
      confidence: "low" | "medium" | "high";
      dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
      completion: {
        confidence: "low" | "medium" | "high" | null;
        /** @external existing wire contract */ completedDuringMeeting: boolean;
        quote: string | null;
      };
      sourceQuotes: {
        quote: string;
        speaker: string | null;
        timestamp: string | null;
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        speakerIdentity?: string | null | undefined;
        sourceSegmentId?: string | null | undefined;
        segmentId?: string | null | undefined;
      }[];
      sourceReason: string;
    };
  }[]
>;

export async function listMeetingLiveTaskCandidates(input: {
  meetingId: string;
  states?: LiveMeetingTaskCandidateState[];
}): ListMeetingLiveTaskCandidatesResult {
  const conditions = [
    { meetingId: input.meetingId },
    ...(input.states !== undefined && input.states.length !== 0 ? [{ state: { in: input.states } }] : []),
  ];
  const rows = await mapRow({
    value: db.meetingLiveTaskCandidates.findMany({
      where: whereAnd(conditions),
      orderBy: [{ createdAt: "asc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        state: liveMeetingTaskCandidateStateSchema.parse(row.state),
        type: meetingTaskTypeSchema.parse(row.type),
        workKind: meetingTaskWorkKindSchema.parse(row.workKind),
        ownerConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.ownerConfidence }),
        dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
        confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
        completion: meetingTaskCompletionSchema.parse(row.completion),
        sourceQuotes: z.array(meetingTaskSourceQuoteSchema).parse(row.sourceQuotes),
        unresolvedQuestions: readStringArray(row.unresolvedQuestions),
      })),
  });
  if (rows.length === 0) {
    return [];
  }
  const evidenceRows = await mapRow({
    value: db.meetingLiveTaskCandidateEvidence.findMany({
      where: { candidateId: { in: rows.map((row) => row.id) } },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
    }),
    map: (rows) => rows.map((row) => ({ ...row, roles: z.array(liveMeetingTaskEvidenceRoleSchema).parse(row.roles) })),
  });
  const evidenceByCandidate = new Map<string, LiveTaskEvidenceRow[]>();
  evidenceRows.forEach((evidence) => {
    const items = evidenceByCandidate.get(evidence.candidateId) ?? [];
    evidenceByCandidate.set(evidence.candidateId, [...items, evidence]);
  });

  return rows.map((row) =>
    parseLiveMeetingTaskCandidateRow({ row, evidenceRows: evidenceByCandidate.get(row.id) ?? [] }),
  );
}

export async function reanchorMeetingLiveTaskEvidence(meetingId: string): Promise<number> {
  const [evidenceRows, refinedSegments] = await Promise.all([
    db.meetingLiveTaskCandidateEvidence.findMany({
      where: { meetingLiveTaskCandidates: { meetingId } },
      select: {
        id: true,
        transcriptSegmentId: true,
        sourceSegmentId: true,
        fullSegmentText: true,
        speakerIdentity: true,
        speakerName: true,
        startedAt: true,
        endedAt: true,
      },
    }),
    db.transcriptSegments.findMany({
      where: { transcripts: { meetingId } },
      select: {
        id: true,
        sourceSegmentId: true,
        speakerIdentity: true,
        speakerName: true,
        content: true,
        startedAt: true,
        endedAt: true,
      },
    }),
  ]);

  return evidenceRows.reduce(async (previous, evidence) => {
    const count = await previous;
    const sourceMatch = hasText(evidence.sourceSegmentId)
      ? refinedSegments.find((segment) => segment.sourceSegmentId === evidence.sourceSegmentId)
      : null;
    const fallbackMatches =
      sourceMatch === null || sourceMatch === undefined
        ? refinedSegments
            .filter((segment) => {
              const isSameSpeaker = hasText(evidence.speakerIdentity)
                ? segment.speakerIdentity === evidence.speakerIdentity
                : normalizeTaskReconciliationText(segment.speakerName) ===
                  normalizeTaskReconciliationText(evidence.speakerName);
              const isWithinTime =
                Math.abs(segment.startedAt.getTime() - evidence.startedAt.getTime()) <= EVIDENCE_TIME_WINDOW_MS ||
                Math.abs((segment.endedAt ?? segment.startedAt).getTime() - evidence.endedAt.getTime()) <=
                  EVIDENCE_TIME_WINDOW_MS;

              return isSameSpeaker && isWithinTime;
            })
            .map((segment) => ({
              segment,
              similarity: normalizedTranscriptSimilarity({
                left: evidence.fullSegmentText,
                right: segment.content,
              }),
            }))
            .filter((match) => match.similarity >= EVIDENCE_TEXT_SIMILARITY_THRESHOLD)
            .sort((left, right) => right.similarity - left.similarity)
        : [];
    const match = sourceMatch ?? fallbackMatches[0]?.segment ?? null;
    if (match === null || evidence.transcriptSegmentId === match.id) {
      return count;
    }
    await db.meetingLiveTaskCandidateEvidence.updateMany({
      where: { id: evidence.id },
      data: {
        transcriptSegmentId: match.id,
      },
    });

    return count + 1;
  }, Promise.resolve(0));
}

type UpsertMeetingLiveTaskCandidateResult = Promise<{
  id: string;
  createdAt: string;
  updatedAt: string;
  meetingId: string;
  promptVersion: string | null;
  model: string | null;
  revision: number;
  actionConfirmableAt: string | null;
  linkedTaskId: string | null;
  state: "deferred" | "confirmed" | "rejected" | "retracted";
  unresolvedQuestions: string[];
  firstEvidenceAt: string;
  lastEvidenceAt: string;
  evidence: {
    id: string;
    startedAt: string;
    endedAt: string;
    contentHash: string;
    speakerName: string;
    speakerIdentity: string | null;
    speakerUserId: string | null;
    sourceSegmentId: string | null;
    quote: string;
    candidateId: string;
    roles: ("owner" | "scope" | "completion" | "due_date" | "action" | "cancellation" | "context")[];
    transcriptSegmentId: string | null;
    fullSegmentText: string;
    quoteStart: number;
    quoteEnd: number;
    sequence: number;
  }[];
  proposal: {
    type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
    owner: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    title: string;
    description: string | null;
    workKind:
      | "bug_or_issue"
      | "implementation"
      | "design"
      | "research"
      | "customer_follow_up"
      | "sales_or_crm"
      | "scheduling"
      | "documentation"
      | "general";
    confidence: "low" | "medium" | "high";
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    completion: {
      confidence: "low" | "medium" | "high" | null;
      /** @external existing wire contract */ completedDuringMeeting: boolean;
      quote: string | null;
    };
    sourceQuotes: {
      quote: string;
      speaker: string | null;
      timestamp: string | null;
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      speakerIdentity?: string | null | undefined;
      sourceSegmentId?: string | null | undefined;
      segmentId?: string | null | undefined;
    }[];
    sourceReason: string;
  };
}>;

function liveMeetingTaskCandidatePersistenceValues(input: {
  meetingId: string;
  linkedTaskId?: string | null;
  state: LiveMeetingTaskCandidateState;
  proposal: MeetingTaskCandidate;
  unresolvedQuestions?: string[];
  firstEvidenceAt: Date;
  actionConfirmableAt?: Date | null;
  lastEvidenceAt: Date;
  model?: string | null;
  promptVersion?: string | null;
}) {
  return {
    meetingId: input.meetingId,
    linkedTaskId: input.linkedTaskId ?? null,
    state: input.state,
    title: input.proposal.title,
    description: input.proposal.description ?? null,
    type: input.proposal.type,
    workKind: input.proposal.workKind,
    ownerUserId: input.proposal.owner.userId ?? null,
    ownerName: input.proposal.owner.name ?? null,
    ownerEmail: input.proposal.owner.email ?? null,
    ownerConfidence: input.proposal.owner.confidence ?? null,
    dueDateValue: input.proposal.dueDate.value ?? null,
    dueDateConfidence: input.proposal.dueDate.confidence ?? null,
    confidence: input.proposal.confidence,
    completion: input.proposal.completion,
    sourceQuotes: input.proposal.sourceQuotes,
    sourceReason: input.proposal.sourceReason,
    unresolvedQuestions: input.unresolvedQuestions ?? [],
    firstEvidenceAt: input.firstEvidenceAt,
    actionConfirmableAt: input.actionConfirmableAt ?? null,
    lastEvidenceAt: input.lastEvidenceAt,
    model: input.model ?? null,
    promptVersion: input.promptVersion ?? null,
  };
}

async function upsertLiveMeetingTaskCandidateRowWithin(args: {
  input: { id?: string | null; meetingId: string };
  values: ReturnType<typeof liveMeetingTaskCandidatePersistenceValues>;
}) {
  const { input, values } = args;
  const [updatedRow] =
    input.id !== undefined && input.id !== null && input.id !== ""
      ? await mapRowsSequentially({
          rows: await mapRow({
            value: db.meetingLiveTaskCandidates.findMany({
              where: whereAnd([{ id: input.id }, { meetingId: input.meetingId }]),
            }),
            map: (rows) =>
              rows.map((row) => ({
                ...row,
                state: liveMeetingTaskCandidateStateSchema.parse(row.state),
                type: meetingTaskTypeSchema.parse(row.type),
                workKind: meetingTaskWorkKindSchema.parse(row.workKind),
                ownerConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.ownerConfidence }),
                dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
                confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
                completion: meetingTaskCompletionSchema.parse(row.completion),
                sourceQuotes: z.array(meetingTaskSourceQuoteSchema).parse(row.sourceQuotes),
                unresolvedQuestions: readStringArray(row.unresolvedQuestions),
              })),
          }),
          visit: async (storedRow) => {
            const updatedRows = await mapRow({
              value: db.meetingLiveTaskCandidates.updateManyAndReturn({
                where: { id: storedRow.id },
                data: {
                  ...values,
                  revision: storedRow.revision + 1,
                  updatedAt: new Date(),
                },
              }),
              map: (rows) =>
                rows.map((row) => ({
                  ...row,
                  state: liveMeetingTaskCandidateStateSchema.parse(row.state),
                  type: meetingTaskTypeSchema.parse(row.type),
                  workKind: meetingTaskWorkKindSchema.parse(row.workKind),
                  ownerConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.ownerConfidence }),
                  dueDateConfidence: parseNullable({
                    schema: meetingTaskConfidenceSchema,
                    value: row.dueDateConfidence,
                  }),
                  confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
                  completion: meetingTaskCompletionSchema.parse(row.completion),
                  sourceQuotes: z.array(meetingTaskSourceQuoteSchema).parse(row.sourceQuotes),
                  unresolvedQuestions: readStringArray(row.unresolvedQuestions),
                })),
            });

            return updatedRows[0];
          },
        })
      : [];
  const [row] = updatedRow
    ? [updatedRow]
    : await mapRow({
        value: db.meetingLiveTaskCandidates.create({
          data: {
            ...values,
            ...(typeof input.id === "string" && input.id !== "" ? { id: input.id } : {}),
          },
        }),
        map: (row) => [
          {
            ...row,
            state: liveMeetingTaskCandidateStateSchema.parse(row.state),
            type: meetingTaskTypeSchema.parse(row.type),
            workKind: meetingTaskWorkKindSchema.parse(row.workKind),
            ownerConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.ownerConfidence }),
            dueDateConfidence: parseNullable({
              schema: meetingTaskConfidenceSchema,
              value: row.dueDateConfidence,
            }),
            confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
            completion: meetingTaskCompletionSchema.parse(row.completion),
            sourceQuotes: z.array(meetingTaskSourceQuoteSchema).parse(row.sourceQuotes),
            unresolvedQuestions: readStringArray(row.unresolvedQuestions),
          },
        ],
      });

  return row;
}

async function replaceLiveMeetingTaskCandidateEvidenceWithin(args: {
  candidateId: string;
  evidence: LiveMeetingTaskEvidenceInput[];
}) {
  const { candidateId, evidence } = args;
  await db.meetingLiveTaskCandidateEvidence.deleteMany({
    where: { candidateId },
  });
  if (evidence.length === 0) {
    return [];
  }

  return mapRow({
    value: db.meetingLiveTaskCandidateEvidence.createManyAndReturn({
      data: evidence.map((item) => ({
        ...item,
        candidateId,
      })),
    }),
    map: (rows) => rows.map((row) => ({ ...row, roles: z.array(liveMeetingTaskEvidenceRoleSchema).parse(row.roles) })),
  });
}

const upsertMeetingLiveTaskCandidateWithin = async (args: {
  input: {
    id?: string | null;
    meetingId: string;
    linkedTaskId?: string | null;
    state: LiveMeetingTaskCandidateState;
    proposal: MeetingTaskCandidate;
    unresolvedQuestions?: string[];
    firstEvidenceAt: Date;
    actionConfirmableAt?: Date | null;
    lastEvidenceAt: Date;
    model?: string | null;
    promptVersion?: string | null;
    evidence: LiveMeetingTaskEvidenceInput[];
  };
}) => {
  const { input } = args;
  const values = liveMeetingTaskCandidatePersistenceValues(input);
  const row = await upsertLiveMeetingTaskCandidateRowWithin({ input, values });
  const evidenceRows = await replaceLiveMeetingTaskCandidateEvidenceWithin({
    candidateId: row.id,
    evidence: input.evidence,
  });

  return parseLiveMeetingTaskCandidateRow({ row, evidenceRows });
};

export async function upsertMeetingLiveTaskCandidate(input: {
  id?: string | null;
  meetingId: string;
  linkedTaskId?: string | null;
  state: LiveMeetingTaskCandidateState;
  proposal: MeetingTaskCandidate;
  unresolvedQuestions?: string[];
  firstEvidenceAt: Date;
  actionConfirmableAt?: Date | null;
  lastEvidenceAt: Date;
  model?: string | null;
  promptVersion?: string | null;
  evidence: LiveMeetingTaskEvidenceInput[];
}): UpsertMeetingLiveTaskCandidateResult {
  return (() => upsertMeetingLiveTaskCandidateWithin({ input }))();
}

export async function getMeetingLiveTaskCursor(meetingId: string): Promise<{
  lastProcessedSegmentId: string | null;
  processedThrough: Date | null;
  confirmedTaskOffset: number;
} | null> {
  const row = await mapRow({
    value: db.meetingLiveTaskCursors.findFirst({
      where: { meetingId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return row
    ? {
        lastProcessedSegmentId: row.lastProcessedSegmentId ?? null,
        processedThrough: row.processedThrough ?? null,
        confirmedTaskOffset: row.confirmedTaskOffset,
      }
    : null;
}

export async function updateMeetingLiveTaskCursor(input: {
  meetingId: string;
  lastProcessedSegmentId: string;
  processedThrough: Date;
  confirmedTaskOffset: number;
}): Promise<void> {
  await db.meetingLiveTaskCursors.upsert({
    where: { meetingId: input.meetingId },
    create: input,
    update: {
      lastProcessedSegmentId: input.lastProcessedSegmentId,
      processedThrough: input.processedThrough,
      confirmedTaskOffset: input.confirmedTaskOffset,
      updatedAt: new Date(),
    },
  });
}

export async function withMeetingLiveTaskDetectionLock<T>(
  ...args: [meetingId: string, operation: () => Promise<T>]
): Promise<T> {
  const operation = args[1];

  return operation();
}

type GetMeetingTaskListForMeetingResult = Promise<{
  status: "pending" | "generating" | "completed" | "failed";
  error: Record<string, unknown> | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  promptVersion: string | null;
  model: string | null;
  phase: string | null;
  transcriptHash: string | null;
  taskListVersion: number;
  items: {
    type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
    status: "open" | "completed" | "dismissed";
    owner: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    title: string;
    meetingId: string;
    position: number;
    assignee: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    taskListId: string;
    description: string | null;
    workKind:
      | "bug_or_issue"
      | "implementation"
      | "design"
      | "research"
      | "customer_follow_up"
      | "sales_or_crm"
      | "scheduling"
      | "documentation"
      | "general";
    confidence: "low" | "medium" | "high";
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    sourceQuotes: {
      quote: string;
      speaker: string | null;
      timestamp: string | null;
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      speakerIdentity?: string | null | undefined;
      sourceSegmentId?: string | null | undefined;
      segmentId?: string | null | undefined;
    }[];
    sourceReason: string;
    revision: number;
    createdFrom: "meeting_transcript";
    origin: "live" | "final";
    statusSource: "user" | "model";
    statusActorUserId: string | null;
    statusChangedAt: string | null;
    actionConfirmableAt: string | null;
    detectedAt: string | null;
    firstRenderedAt: string | null;
    assetIds: string[];
    externalLinks: Record<string, unknown>[];
  }[];
} | null>;

export async function getMeetingTaskListForMeeting(meetingId: string): GetMeetingTaskListForMeetingResult {
  const listRow = await mapRow({
    value: db.meetingTaskLists.findFirst({
      where: { meetingId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: meetingTaskListStatusSchema.parse(row.status),
            error: row.error === null ? null : readJsonObject(row.error),
          },
  });

  if (!listRow) {
    return null;
  }

  const taskRows = await mapRow({
    value: db.meetingTasks.findMany({
      where: { taskListId: listRow.id },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
    map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
  });

  return parseMeetingTaskListRow({ row: listRow, taskRows });
}

type UpsertMeetingTaskListResult = Promise<{
  status: "pending" | "generating" | "completed" | "failed";
  error: Record<string, unknown> | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  promptVersion: string | null;
  model: string | null;
  phase: string | null;
  transcriptHash: string | null;
  taskListVersion: number;
  items: {
    type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
    status: "open" | "completed" | "dismissed";
    owner: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    title: string;
    meetingId: string;
    position: number;
    assignee: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    taskListId: string;
    description: string | null;
    workKind:
      | "bug_or_issue"
      | "implementation"
      | "design"
      | "research"
      | "customer_follow_up"
      | "sales_or_crm"
      | "scheduling"
      | "documentation"
      | "general";
    confidence: "low" | "medium" | "high";
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    sourceQuotes: {
      quote: string;
      speaker: string | null;
      timestamp: string | null;
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      speakerIdentity?: string | null | undefined;
      sourceSegmentId?: string | null | undefined;
      segmentId?: string | null | undefined;
    }[];
    sourceReason: string;
    revision: number;
    createdFrom: "meeting_transcript";
    origin: "live" | "final";
    statusSource: "user" | "model";
    statusActorUserId: string | null;
    statusChangedAt: string | null;
    actionConfirmableAt: string | null;
    detectedAt: string | null;
    firstRenderedAt: string | null;
    assetIds: string[];
    externalLinks: Record<string, unknown>[];
  }[];
}>;

const presentMeetingTaskListFields = (input: {
  model?: string | null;
  promptVersion?: string | null;
  transcriptHash?: string | null;
}): { model?: string; promptVersion?: string; transcriptHash?: string } => ({
  ...(input.model !== undefined && input.model !== null ? { model: input.model } : {}),
  ...(input.promptVersion !== undefined && input.promptVersion !== null ? { promptVersion: input.promptVersion } : {}),
  ...(input.transcriptHash !== undefined && input.transcriptHash !== null
    ? { transcriptHash: input.transcriptHash }
    : {}),
});

const meetingTaskListInsertColumns: readonly RawInsertColumn[] = [
  { key: "id", column: "id", cast: "uuid" },
  { key: "meetingId", column: "meeting_id", cast: "uuid" },
  { key: "status", column: "status", cast: null },
  { key: "phase", column: "phase", cast: null },
  { key: "error", column: "error", cast: "jsonb" },
  { key: "model", column: "model", cast: null },
  { key: "promptVersion", column: "prompt_version", cast: null },
  { key: "transcriptHash", column: "transcript_hash", cast: null },
  { key: "createdAt", column: "created_at", cast: "timestamptz" },
  { key: "updatedAt", column: "updated_at", cast: "timestamptz" },
  { key: "completedAt", column: "completed_at", cast: "timestamptz" },
  { key: "taskListVersion", column: "task_list_version", cast: "int" },
];

export async function upsertMeetingTaskList(input: {
  jobId?: string | null;
  meetingId: string;
  status: MeetingTaskListStatus;
  phase?: string | null;
  error?: Record<string, unknown> | null;
  model?: string | null;
  promptVersion?: string | null;
  transcriptHash?: string | null;
  completedAt?: Date | null;
}): UpsertMeetingTaskListResult {
  return withRequestResult({
    ...input,
    run: async (executor) => {
      const inserted = await mapRow({
        value: mapRow({
          value: insertRaw<Prisma.meetingTaskListsModel>({
            executor,
            table: "meeting_task_lists",
            rows: [
              {
                meetingId: input.meetingId,
                status: input.status,
                phase: input.phase ?? null,
                error: input.error ?? null,
                model: input.model ?? null,
                promptVersion: input.promptVersion ?? null,
                transcriptHash: input.transcriptHash ?? null,
                completedAt: input.completedAt ?? null,
              },
            ],
            columns: meetingTaskListInsertColumns,
            conflict: sqlConflictNothing({ targetSql: 'ON CONFLICT ("meeting_id")', where: undefined }),
            returning: Prisma.raw(
              '"id" AS "id", "meeting_id" AS "meetingId", "status" AS "status", "phase" AS "phase", "error" AS "error", "model" AS "model", "prompt_version" AS "promptVersion", "transcript_hash" AS "transcriptHash", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "completed_at" AS "completedAt", "task_list_version" AS "taskListVersion"',
            ),
          }),
          map: (rows) => rows[0],
        }),
        map: (row) =>
          row === undefined
            ? undefined
            : {
                ...row,
                status: meetingTaskListStatusSchema.parse(row.status),
                error: row.error === null ? null : readJsonObject(row.error),
              },
      });
      const created = inserted;
      if (created !== undefined) {
        return parseMeetingTaskListRow({ row: created });
      }
      const current = await mapRow({
        value: executor.meetingTaskLists.findFirst({
          where: { meetingId: input.meetingId },
          take: 1,
        }),
        map: (row) =>
          row === null
            ? undefined
            : {
                ...row,
                status: meetingTaskListStatusSchema.parse(row.status),
                error: row.error === null ? null : readJsonObject(row.error),
              },
      });
      if (current === undefined) {
        throw new Error(failedToUpsertMeetingTaskListForMeetingMessage(input.meetingId));
      }
      const [row] = await mapRow({
        value: executor.meetingTaskLists.updateManyAndReturn({
          where: { id: current.id },
          data: {
            status: input.status,
            phase: input.phase ?? null,
            error: jsonInput(input.error ?? null),
            ...presentMeetingTaskListFields(input),
            taskListVersion: current.taskListVersion + 1,
            completedAt: input.completedAt ?? null,
            updatedAt: new Date(),
          },
        }),
        map: (rows) =>
          rows.map((row) => ({
            ...row,
            status: meetingTaskListStatusSchema.parse(row.status),
            error: row.error === null ? null : readJsonObject(row.error),
          })),
      });
      if (row === undefined) {
        throw new Error(failedToUpsertMeetingTaskListForMeetingMessage(input.meetingId));
      }

      return parseMeetingTaskListRow({ row });
    },
  });
}

type ReplaceMeetingTasksForListResult = Promise<
  {
    type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
    status: "open" | "completed" | "dismissed";
    owner: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    title: string;
    meetingId: string;
    position: number;
    assignee: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    taskListId: string;
    description: string | null;
    workKind:
      | "bug_or_issue"
      | "implementation"
      | "design"
      | "research"
      | "customer_follow_up"
      | "sales_or_crm"
      | "scheduling"
      | "documentation"
      | "general";
    confidence: "low" | "medium" | "high";
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    sourceQuotes: {
      quote: string;
      speaker: string | null;
      timestamp: string | null;
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      speakerIdentity?: string | null | undefined;
      sourceSegmentId?: string | null | undefined;
      segmentId?: string | null | undefined;
    }[];
    sourceReason: string;
    revision: number;
    createdFrom: "meeting_transcript";
    origin: "live" | "final";
    statusSource: "user" | "model";
    statusActorUserId: string | null;
    statusChangedAt: string | null;
    actionConfirmableAt: string | null;
    detectedAt: string | null;
    firstRenderedAt: string | null;
    assetIds: string[];
    externalLinks: Record<string, unknown>[];
  }[]
>;

export async function replaceMeetingTasksForList(input: {
  jobId?: string | null;
  meetingId: string;
  taskListId: string;
  items: MeetingTaskCandidate[];
}): ReplaceMeetingTasksForListResult {
  return withRequestResult({
    ...input,
    run: async (executor) => {
      const [linkedAssets, linkingSegments] = await Promise.all([
        mapRow({
          value: executor.meetingAssets.findMany({
            where: { meetingId: input.meetingId },
            select: {
              id: true,
              transcriptSegmentIds: true,
              transcriptExcerpt: true,
              capturedAt: true,
            },
          }),
          map: (rows) =>
            rows.map((row) => ({
              ...row,
              transcriptSegmentIds: readStringArray(row.transcriptSegmentIds),
            })),
        }),
        executor.transcriptSegments.findMany({
          where: { transcripts: { meetingId: input.meetingId } },
          orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            startedAt: true,
            content: true,
          },
        }),
      ]);
      await executor.meetingTasks.deleteMany({
        where: { taskListId: input.taskListId },
      });

      if (input.items.length === 0) {
        await bumpMeetingTaskListVersions({ executor, taskListIds: [input.taskListId] });

        return [];
      }

      const completedAt = new Date();
      const rows = await mapRow({
        value: executor.meetingTasks.createManyAndReturn({
          data: input.items.map((item, index) => ({
            meetingId: input.meetingId,
            taskListId: input.taskListId,
            position: index,
            title: item.title,
            description: item.description ?? null,
            type: item.type,
            workKind: item.workKind,
            ownerUserId: item.owner.userId ?? null,
            ownerName: item.owner.name ?? null,
            ownerEmail: item.owner.email ?? null,
            ownerConfidence: item.owner.confidence ?? null,
            dueDateValue: item.dueDate.value ?? null,
            dueDateConfidence: item.dueDate.confidence ?? null,
            confidence: item.confidence,
            sourceQuotes: jsonInput(item.sourceQuotes),
            sourceReason: item.sourceReason,
            status: item.completion.completedDuringMeeting ? ("completed" as const) : ("open" as const),
            completedAt: item.completion.completedDuringMeeting ? completedAt : null,
            createdFrom: "meeting_transcript" as const,
            assetIds: jsonInput(
              assetIdsForTaskCandidate({ candidate: item, assets: linkedAssets, segments: linkingSegments }),
            ),
            externalLinks: jsonInput([]),
          })),
        }),
        map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
      });

      await bumpMeetingTaskListVersions({ executor, taskListIds: [input.taskListId] });

      return rows.map(parseMeetingTaskRow);
    },
  });
}

type UpsertLiveMeetingTaskResult = Promise<{
  type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
  status: "open" | "completed" | "dismissed";
  owner: {
    name: string | null;
    email: string | null;
    userId: string | null;
    confidence: "low" | "medium" | "high" | null;
  };
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  title: string;
  meetingId: string;
  position: number;
  assignee: {
    name: string | null;
    email: string | null;
    userId: string | null;
    confidence: "low" | "medium" | "high" | null;
  };
  taskListId: string;
  description: string | null;
  workKind:
    | "bug_or_issue"
    | "implementation"
    | "design"
    | "research"
    | "customer_follow_up"
    | "sales_or_crm"
    | "scheduling"
    | "documentation"
    | "general";
  confidence: "low" | "medium" | "high";
  dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
  sourceQuotes: {
    quote: string;
    speaker: string | null;
    timestamp: string | null;
    startedAt?: string | null | undefined;
    endedAt?: string | null | undefined;
    speakerIdentity?: string | null | undefined;
    sourceSegmentId?: string | null | undefined;
    segmentId?: string | null | undefined;
  }[];
  sourceReason: string;
  revision: number;
  createdFrom: "meeting_transcript";
  origin: "live" | "final";
  statusSource: "user" | "model";
  statusActorUserId: string | null;
  statusChangedAt: string | null;
  actionConfirmableAt: string | null;
  detectedAt: string | null;
  firstRenderedAt: string | null;
  assetIds: string[];
  externalLinks: Record<string, unknown>[];
} | null>;

async function updateExistingLiveMeetingTaskRowWithin(args: {
  input: {
    item: MeetingTaskCandidate;
    actionConfirmableAt: Date;
  };
  previous: Prisma.meetingTasksModel;
  desiredStatus: MeetingTaskStatus;
  desiredCompletedAt: Date | null;
}) {
  const { input, previous, desiredStatus, desiredCompletedAt } = args;
  const shouldPreserveUserStatus = previous.statusSource === "user";

  const [row] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.meetingTasks.findMany({
        where: { id: previous.id },
      }),
      map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.meetingTasks.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            title: input.item.title,
            description: input.item.description ?? null,
            type: input.item.type,
            workKind: input.item.workKind,
            ownerUserId: input.item.owner.userId ?? null,
            ownerName: input.item.owner.name ?? null,
            ownerEmail: input.item.owner.email ?? null,
            ownerConfidence: input.item.owner.confidence ?? null,
            dueDateValue: input.item.dueDate.value ?? null,
            dueDateConfidence: input.item.dueDate.confidence ?? null,
            confidence: input.item.confidence,
            sourceQuotes: jsonInput(input.item.sourceQuotes),
            sourceReason: input.item.sourceReason,
            status: shouldPreserveUserStatus ? previous.status : desiredStatus,
            statusSource: shouldPreserveUserStatus ? previous.statusSource : "model",
            statusChangedAt:
              shouldPreserveUserStatus || previous.status === desiredStatus ? previous.statusChangedAt : new Date(),
            completedAt: shouldPreserveUserStatus ? previous.completedAt : desiredCompletedAt,
            actionConfirmableAt: previous.actionConfirmableAt ?? input.actionConfirmableAt,
            detectedAt: previous.detectedAt ?? new Date(),
            revision: storedRow.revision + 1,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
      });

      return updatedRows[0];
    },
  });

  return row;
}

async function insertNewLiveMeetingTaskRowWithin(args: {
  input: {
    meetingId: string;
    item: MeetingTaskCandidate;
    actionConfirmableAt: Date;
  };
  list: Prisma.meetingTaskListsModel;
  desiredStatus: MeetingTaskStatus;
  desiredCompletedAt: Date | null;
}) {
  const { input, list, desiredStatus, desiredCompletedAt } = args;
  const row = await mapRow({
    value: db.meetingTasks.create({
      data: {
        meetingId: input.meetingId,
        taskListId: list.id,
        position: (
          await db.meetingTasks.findMany({
            where: { taskListId: list.id },
            select: {
              id: true,
            },
          })
        ).length,
        title: input.item.title,
        description: input.item.description ?? null,
        type: input.item.type,
        workKind: input.item.workKind,
        ownerUserId: input.item.owner.userId ?? null,
        ownerName: input.item.owner.name ?? null,
        ownerEmail: input.item.owner.email ?? null,
        ownerConfidence: input.item.owner.confidence ?? null,
        dueDateValue: input.item.dueDate.value ?? null,
        dueDateConfidence: input.item.dueDate.confidence ?? null,
        confidence: input.item.confidence,
        sourceQuotes: jsonInput(input.item.sourceQuotes),
        sourceReason: input.item.sourceReason,
        status: desiredStatus,
        statusSource: "model",
        statusChangedAt: new Date(),
        completedAt: desiredCompletedAt,
        createdFrom: "meeting_transcript",
        origin: "live",
        actionConfirmableAt: input.actionConfirmableAt,
        detectedAt: new Date(),
        assetIds: jsonInput([]),
        externalLinks: jsonInput([]),
      },
    }),
    map: (row) => readStoredMeetingTask(row),
  });

  return row;
}

async function persistLiveMeetingTaskRowWithin(args: {
  input: {
    meetingId: string;
    taskId?: string | null;
    item: MeetingTaskCandidate;
    actionConfirmableAt: Date;
    status?: MeetingTaskStatus;
  };
  list: Prisma.meetingTaskListsModel;
}) {
  const { input, list } = args;
  const desiredStatus = input.status ?? (input.item.completion.completedDuringMeeting ? "completed" : "open");
  const desiredCompletedAt = desiredStatus === "completed" ? new Date() : null;
  const [previous] =
    input.taskId !== undefined && input.taskId !== null && input.taskId !== ""
      ? await mapRow({
          value: db.meetingTasks.findMany({
            where: whereAnd([{ id: input.taskId }, { meetingId: input.meetingId }, { taskListId: list.id }]),
            take: 1,
          }),
          map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
        })
      : [];

  const row = previous
    ? await updateExistingLiveMeetingTaskRowWithin({
        input,
        previous,
        desiredStatus,
        desiredCompletedAt,
      })
    : await insertNewLiveMeetingTaskRowWithin({
        input,
        list,
        desiredStatus,
        desiredCompletedAt,
      });
  if (!row) {
    throw new Error(FAILED_TO_PERSIST_LIVE_MEETING_TASK_MESSAGE);
  }

  return { row, previous };
}
const columnsHoist5183 = [
  { key: "id", column: "id", cast: "uuid" },
  { key: "meetingId", column: "meeting_id", cast: "uuid" },
  { key: "taskId", column: "task_id", cast: "uuid" },
  { key: "taskRevision", column: "task_revision", cast: "int" },
  { key: "kind", column: "kind", cast: null },
  { key: "evidenceAt", column: "evidence_at", cast: "timestamptz" },
  { key: "transcriptReceivedAt", column: "transcript_received_at", cast: "timestamptz" },
  { key: "queueStartedAt", column: "queue_started_at", cast: "timestamptz" },
  { key: "modelCompletedAt", column: "model_completed_at", cast: "timestamptz" },
  { key: "validationCommittedAt", column: "validation_committed_at", cast: "timestamptz" },
  { key: "outboxPublishedAt", column: "outbox_published_at", cast: "timestamptz" },
  { key: "realtimeReceivedAt", column: "realtime_received_at", cast: "timestamptz" },
  { key: "refetchStartedAt", column: "refetch_started_at", cast: "timestamptz" },
  { key: "refetchCompletedAt", column: "refetch_completed_at", cast: "timestamptz" },
  { key: "renderedAt", column: "rendered_at", cast: "timestamptz" },
  { key: "clientContinuity", column: "client_continuity", cast: null },
  { key: "createdAt", column: "created_at", cast: "timestamptz" },
  { key: "updatedAt", column: "updated_at", cast: "timestamptz" },
] as const;

async function finalizeLiveMeetingTaskWithin(args: {
  input: {
    meetingId: string;
    candidateId: string;
    model: string;
    promptVersion: string;
    latencyObservations?: {
      kind: "appearance" | "owner" | "due_date" | "completion";
      evidenceAt: Date;
      transcriptReceivedAt?: Date | null;
      queueStartedAt?: Date | null;
      modelCompletedAt?: Date | null;
    }[];
  };
  meeting: { workspaceId: string };
  list: Prisma.meetingTaskListsModel;
  row: Prisma.meetingTasksModel;
  previous: Prisma.meetingTasksModel | undefined;
}) {
  const { input, list, row } = args;
  if (input.latencyObservations !== undefined && input.latencyObservations.length !== 0) {
    await mapRow({
      value: insertRaw<Prisma.meetingTaskLatencyObservationsModel>({
        executor: db,
        table: "meeting_task_latency_observations",
        rows: input.latencyObservations.map((observation) => ({
          meetingId: input.meetingId,
          taskId: row.id,
          taskRevision: row.revision,
          kind: observation.kind,
          evidenceAt: observation.evidenceAt,
          transcriptReceivedAt: observation.transcriptReceivedAt ?? null,
          queueStartedAt: observation.queueStartedAt ?? null,
          modelCompletedAt: observation.modelCompletedAt ?? null,
          validationCommittedAt: new Date(),
        })),
        columns: columnsHoist5183,
        conflict: sqlConflictNothing({
          targetSql: 'ON CONFLICT ("task_id", "task_revision", "kind")',
          where: undefined,
        }),
        returning: Prisma.raw(
          '"id" AS "id", "meeting_id" AS "meetingId", "task_id" AS "taskId", "task_revision" AS "taskRevision", "kind" AS "kind", "evidence_at" AS "evidenceAt", "transcript_received_at" AS "transcriptReceivedAt", "queue_started_at" AS "queueStartedAt", "model_completed_at" AS "modelCompletedAt", "validation_committed_at" AS "validationCommittedAt", "outbox_published_at" AS "outboxPublishedAt", "realtime_received_at" AS "realtimeReceivedAt", "refetch_started_at" AS "refetchStartedAt", "refetch_completed_at" AS "refetchCompletedAt", "rendered_at" AS "renderedAt", "client_continuity" AS "clientContinuity", "created_at" AS "createdAt", "updated_at" AS "updatedAt"',
        ),
      }),
      map: () => undefined,
    });
  }

  await mapRowsSequentially({
    rows: await mapRow({
      value: db.meetingTaskLists.findMany({
        where: { id: list.id },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          status: meetingTaskListStatusSchema.parse(row.status),
          error: row.error === null ? null : readJsonObject(row.error),
        })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.meetingTaskLists.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            status: "generating",
            phase: "listening",
            model: input.model,
            promptVersion: input.promptVersion,
            taskListVersion: storedRow.taskListVersion + 1,
            updatedAt: new Date(),
          },
        }),
        map: (rows) =>
          rows.map((row) => ({
            ...row,
            status: meetingTaskListStatusSchema.parse(row.status),
            error: row.error === null ? null : readJsonObject(row.error),
          })),
      });

      return updatedRows[0];
    },
  });
  const persistedStatus = row.status;
  await db.meetingLiveTaskCandidates.updateMany({
    where: whereAnd([{ id: input.candidateId }, { meetingId: input.meetingId }]),
    data: {
      linkedTaskId: row.id,
      state: persistedStatus === "dismissed" ? "retracted" : "confirmed",
      updatedAt: new Date(),
    },
  });
}

const upsertLiveMeetingTaskWithin = async (args: {
  input: {
    meetingId: string;
    candidateId: string;
    taskId?: string | null;
    item: MeetingTaskCandidate;
    actionConfirmableAt: Date;
    model: string;
    promptVersion: string;
    status?: MeetingTaskStatus;
    latencyObservations?: {
      kind: "appearance" | "owner" | "due_date" | "completion";
      evidenceAt: Date;
      transcriptReceivedAt?: Date | null;
      queueStartedAt?: Date | null;
      modelCompletedAt?: Date | null;
    }[];
  };
}) => {
  const { input } = args;

  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { id: input.meetingId },
      take: 1,
      select: {
        workspaceId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });
  if (!meeting) {
    throw new Error(meetingNotFoundMessage(input.meetingId));
  }

  await mapRow({
    value: insertRaw<Prisma.meetingTaskListsModel>({
      executor: db,
      table: "meeting_task_lists",
      rows: [
        {
          meetingId: input.meetingId,
          status: "generating",
          phase: "listening",
          model: input.model,
          promptVersion: input.promptVersion,
          completedAt: null,
        },
      ],
      columns: meetingTaskListInsertColumns,
      conflict: sqlConflictNothing({ targetSql: 'ON CONFLICT ("meeting_id")', where: undefined }),
      returning: Prisma.raw(
        '"id" AS "id", "meeting_id" AS "meetingId", "status" AS "status", "phase" AS "phase", "error" AS "error", "model" AS "model", "prompt_version" AS "promptVersion", "transcript_hash" AS "transcriptHash", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "completed_at" AS "completedAt", "task_list_version" AS "taskListVersion"',
      ),
    }),
    map: () => undefined,
  });
  const list = await mapRow({
    value: db.meetingTaskLists.findFirst({
      where: { meetingId: input.meetingId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: meetingTaskListStatusSchema.parse(row.status),
            error: row.error === null ? null : readJsonObject(row.error),
          },
  });
  if (!list) {
    throw new Error(FAILED_TO_CREATE_LIVE_MEETING_TASK_LIST_MESSAGE);
  }
  if (list.status === "completed") {
    const [existingCompletedTask] =
      input.taskId !== undefined && input.taskId !== null && input.taskId !== ""
        ? await mapRow({
            value: db.meetingTasks.findMany({
              where: whereAnd([{ id: input.taskId }, { meetingId: input.meetingId }]),
              take: 1,
            }),
            map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
          })
        : [];

    return existingCompletedTask !== undefined ? parseMeetingTaskRow(existingCompletedTask) : null;
  }

  const { row, previous } = await persistLiveMeetingTaskRowWithin({ input, list });
  await finalizeLiveMeetingTaskWithin({ input, meeting, list, row, previous });

  return parseMeetingTaskRow(row);
};

export async function upsertLiveMeetingTask(input: {
  meetingId: string;
  candidateId: string;
  taskId?: string | null;
  item: MeetingTaskCandidate;
  actionConfirmableAt: Date;
  model: string;
  promptVersion: string;
  status?: MeetingTaskStatus;
  latencyObservations?: {
    kind: "appearance" | "owner" | "due_date" | "completion";
    evidenceAt: Date;
    transcriptReceivedAt?: Date | null;
    queueStartedAt?: Date | null;
    modelCompletedAt?: Date | null;
  }[];
}): UpsertLiveMeetingTaskResult {
  return (() => upsertLiveMeetingTaskWithin({ input }))();
}

export async function reportMeetingTaskRendered(input: {
  meetingId: string;
  taskId: string;
  renderedAt: Date;
  realtimeReceivedAt?: Date | null;
  refetchStartedAt?: Date | null;
  refetchCompletedAt?: Date | null;
  taskRevision?: number | null;
  observedKinds?: ("appearance" | "owner" | "due_date" | "completion")[];
  clientContinuity?: "continuous" | "recovered" | null;
}): Promise<boolean> {
  const observedKinds: ("appearance" | "owner" | "due_date" | "completion")[] =
    input.observedKinds !== undefined && input.observedKinds.length !== 0 ? input.observedKinds : ["appearance"];
  const [row] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.meetingTasks.findMany({
        where: whereAnd([{ id: input.taskId }, { meetingId: input.meetingId }]),
      }),
      map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
    }),
    visit: async (storedRow) => {
      const updatedRows = await db.meetingTasks.updateManyAndReturn({
        where: { id: storedRow.id },
        data: {
          firstRenderedAt: observedKinds.includes("appearance")
            ? earliestInstant({ current: storedRow.firstRenderedAt, incoming: input.renderedAt })
            : undefined,
          firstRenderedReportedAt: observedKinds.includes("appearance")
            ? (storedRow.firstRenderedReportedAt ?? new Date())
            : undefined,
          realtimeReceivedAt: input.realtimeReceivedAt
            ? earliestInstant({ current: storedRow.realtimeReceivedAt, incoming: input.realtimeReceivedAt })
            : undefined,
          refetchStartedAt: input.refetchStartedAt
            ? earliestInstant({ current: storedRow.refetchStartedAt, incoming: input.refetchStartedAt })
            : undefined,
          refetchCompletedAt: input.refetchCompletedAt
            ? earliestInstant({ current: storedRow.refetchCompletedAt, incoming: input.refetchCompletedAt })
            : undefined,
        },
        select: { id: true, revision: true },
      });

      return updatedRows[0];
    },
  });
  if (!row) {
    return false;
  }

  const revision = input.taskRevision ?? row.revision;
  await mapRowsSequentially({
    rows: await mapRow({
      value: db.meetingTaskLatencyObservations.findMany({
        where: whereAnd([{ taskId: input.taskId }, { taskRevision: revision }, { kind: { in: observedKinds } }]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          kind: readStringUnion({ values: ["appearance", "owner", "due_date", "completion"], value: row.kind }),
          clientContinuity: readNullableStringUnion({
            values: ["continuous", "recovered"],
            value: row.clientContinuity,
          }),
        })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.meetingTaskLatencyObservations.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            renderedAt: earliestInstant({ current: storedRow.renderedAt, incoming: input.renderedAt }),
            realtimeReceivedAt: input.realtimeReceivedAt
              ? earliestInstant({ current: storedRow.realtimeReceivedAt, incoming: input.realtimeReceivedAt })
              : undefined,
            refetchStartedAt: input.refetchStartedAt
              ? earliestInstant({ current: storedRow.refetchStartedAt, incoming: input.refetchStartedAt })
              : undefined,
            refetchCompletedAt: input.refetchCompletedAt
              ? earliestInstant({ current: storedRow.refetchCompletedAt, incoming: input.refetchCompletedAt })
              : undefined,
            clientContinuity: input.clientContinuity ?? undefined,
            updatedAt: new Date(),
          },
        }),
        map: (rows) =>
          rows.map((row) => ({
            ...row,
            kind: readStringUnion({ values: ["appearance", "owner", "due_date", "completion"], value: row.kind }),
            clientContinuity: readNullableStringUnion({
              values: ["continuous", "recovered"],
              value: row.clientContinuity,
            }),
          })),
      });

      return updatedRows[0];
    },
  });

  return true;
}

function normalizeTaskReconciliationText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function meetingTaskTitleTokenSimilarity(input: { leftTitle: string; rightTitle: string }) {
  const leftTokens = new Set(
    normalizeTaskReconciliationText(input.leftTitle)
      .split(" ")
      .filter((token) => token.length > TOKEN_MIN_LENGTH),
  );
  const rightTokens = new Set(
    normalizeTaskReconciliationText(input.rightTitle)
      .split(" ")
      .filter((token) => token.length > TOKEN_MIN_LENGTH),
  );
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;

  return overlap / Math.max(leftTokens.size, rightTokens.size, 1);
}

function meetingTaskReconciliationScore(input: { existing: Prisma.meetingTasksModel; item: MeetingTaskCandidate }) {
  const { existing, item } = input;
  const existingQuotes = z.array(meetingTaskSourceQuoteSchema).parse(existing.sourceQuotes ?? []);
  const existingSegmentIds = new Set(
    existingQuotes.map((quote) => quote.segmentId).filter((value): value is string => Boolean(value)),
  );
  const hasSharedSegment = item.sourceQuotes.some(
    (quote) =>
      quote.segmentId !== null &&
      quote.segmentId !== undefined &&
      quote.segmentId !== "" &&
      existingSegmentIds.has(quote.segmentId),
  );
  const existingQuoteText = new Set(existingQuotes.map((quote) => normalizeTaskReconciliationText(quote.quote)));
  const hasSharedQuote = item.sourceQuotes.some((quote) =>
    existingQuoteText.has(normalizeTaskReconciliationText(quote.quote)),
  );
  const existingTitle = normalizeTaskReconciliationText(existing.title);
  const nextTitle = normalizeTaskReconciliationText(item.title);
  if (existingTitle === nextTitle) {
    return EXACT_TASK_TITLE_SCORE;
  }

  const tokenSimilarity = meetingTaskTitleTokenSimilarity({ leftTitle: existing.title, rightTitle: item.title });
  const characterSimilarity = normalizedTranscriptSimilarity({ left: existing.title, right: item.title });
  if (tokenSimilarity >= HIGH_TITLE_TOKEN_SIMILARITY || characterSimilarity >= HIGH_TITLE_CHARACTER_SIMILARITY) {
    return (
      SHARED_EVIDENCE_TITLE_SCORE +
      Number(hasSharedQuote) * SHARED_EVIDENCE_SCORE_STEP +
      Number(hasSharedSegment) * SHARED_EVIDENCE_SCORE_STEP
    );
  }
  // Evidence is only a corroborating signal. One utterance can contain two
  // independent tasks, so a shared segment or full quote is never sufficient
  // to transfer a durable ID or user status on its own.
  if (
    hasSharedQuote &&
    (tokenSimilarity >= QUOTE_TOKEN_SIMILARITY || characterSimilarity >= QUOTE_CHARACTER_SIMILARITY)
  ) {
    return QUOTE_MATCH_SCORE;
  }
  if (
    hasSharedSegment &&
    (tokenSimilarity >= SEGMENT_TOKEN_SIMILARITY || characterSimilarity >= SEGMENT_CHARACTER_SIMILARITY)
  ) {
    return SEGMENT_MATCH_SCORE;
  }

  return 0;
}

type ReplaceAndCompleteMeetingTasksForListResult = Promise<{
  taskList: {
    status: "pending" | "generating" | "completed" | "failed";
    error: Record<string, unknown> | null;
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    meetingId: string;
    promptVersion: string | null;
    model: string | null;
    phase: string | null;
    transcriptHash: string | null;
    taskListVersion: number;
    items: {
      type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
      status: "open" | "completed" | "dismissed";
      owner: {
        name: string | null;
        email: string | null;
        userId: string | null;
        confidence: "low" | "medium" | "high" | null;
      };
      id: string;
      createdAt: string;
      updatedAt: string;
      completedAt: string | null;
      title: string;
      meetingId: string;
      position: number;
      assignee: {
        name: string | null;
        email: string | null;
        userId: string | null;
        confidence: "low" | "medium" | "high" | null;
      };
      taskListId: string;
      description: string | null;
      workKind:
        | "bug_or_issue"
        | "implementation"
        | "design"
        | "research"
        | "customer_follow_up"
        | "sales_or_crm"
        | "scheduling"
        | "documentation"
        | "general";
      confidence: "low" | "medium" | "high";
      dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
      sourceQuotes: {
        quote: string;
        speaker: string | null;
        timestamp: string | null;
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        speakerIdentity?: string | null | undefined;
        sourceSegmentId?: string | null | undefined;
        segmentId?: string | null | undefined;
      }[];
      sourceReason: string;
      revision: number;
      createdFrom: "meeting_transcript";
      origin: "live" | "final";
      statusSource: "user" | "model";
      statusActorUserId: string | null;
      statusChangedAt: string | null;
      actionConfirmableAt: string | null;
      detectedAt: string | null;
      firstRenderedAt: string | null;
      assetIds: string[];
      externalLinks: Record<string, unknown>[];
    }[];
  };
  tasks: {
    type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
    status: "open" | "completed" | "dismissed";
    owner: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    title: string;
    meetingId: string;
    position: number;
    assignee: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    taskListId: string;
    description: string | null;
    workKind:
      | "bug_or_issue"
      | "implementation"
      | "design"
      | "research"
      | "customer_follow_up"
      | "sales_or_crm"
      | "scheduling"
      | "documentation"
      | "general";
    confidence: "low" | "medium" | "high";
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    sourceQuotes: {
      quote: string;
      speaker: string | null;
      timestamp: string | null;
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      speakerIdentity?: string | null | undefined;
      sourceSegmentId?: string | null | undefined;
      segmentId?: string | null | undefined;
    }[];
    sourceReason: string;
    revision: number;
    createdFrom: "meeting_transcript";
    origin: "live" | "final";
    statusSource: "user" | "model";
    statusActorUserId: string | null;
    statusChangedAt: string | null;
    actionConfirmableAt: string | null;
    detectedAt: string | null;
    firstRenderedAt: string | null;
    assetIds: string[];
    externalLinks: Record<string, unknown>[];
  }[];
}>;

type FinalMeetingTaskListReconciliationState = {
  taskRows: Prisma.meetingTasksModel[];
  unmatchedExisting: Set<string>;
};

type FinalMeetingTaskReconciliationAssets = {
  linkedAssets: {
    id: string;
    transcriptSegmentIds: string[];
    transcriptExcerpt: string | null;
    capturedAt: Date;
  }[];
  linkingSegments: {
    id: string;
    startedAt: Date;
    content: string;
  }[];
};

function finalMeetingTaskCandidateBlockedByUserDismissal(args: {
  userDismissedRows: Prisma.meetingTasksModel[];
  item: MeetingTaskCandidate;
}) {
  return args.userDismissedRows.some((row) => meetingTaskReconciliationScore({ existing: row, item: args.item }) > 0);
}

function pickFinalMeetingTaskReconciliationMatch(args: {
  existingRows: Prisma.meetingTasksModel[];
  unmatchedExisting: Set<string>;
  item: MeetingTaskCandidate;
}) {
  return args.existingRows
    .filter((row) => args.unmatchedExisting.has(row.id))
    .map((row) => ({ row, score: meetingTaskReconciliationScore({ existing: row, item: args.item }) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return Number(right.row.statusSource === "user") - Number(left.row.statusSource === "user");
    })[0]?.row;
}

function finalMeetingTaskCandidateSharedValues(args: {
  item: MeetingTaskCandidate;
  index: number;
  assets: FinalMeetingTaskReconciliationAssets;
}) {
  const { item, index, assets } = args;

  return {
    position: index,
    title: item.title,
    description: item.description ?? null,
    type: item.type,
    workKind: item.workKind,
    ownerUserId: item.owner.userId ?? null,
    ownerName: item.owner.name ?? null,
    ownerEmail: item.owner.email ?? null,
    ownerConfidence: item.owner.confidence ?? null,
    dueDateValue: item.dueDate.value ?? null,
    dueDateConfidence: item.dueDate.confidence ?? null,
    confidence: item.confidence,
    sourceQuotes: item.sourceQuotes,
    sourceReason: item.sourceReason,
    assetIds: assetIdsForTaskCandidate({
      candidate: item,
      assets: assets.linkedAssets,
      segments: assets.linkingSegments,
    }),
  };
}

async function updateFinalMeetingTaskReconciliationMatchWithin(args: {
  executor: typeof db | AccountTransaction;
  input: {
    meetingId: string;
    taskListId: string;
    completedAt?: Date | null;
  };
  state: FinalMeetingTaskListReconciliationState;
  item: MeetingTaskCandidate;
  index: number;
  match: Prisma.meetingTasksModel;
  modelStatus: MeetingTaskStatus;
  assets: FinalMeetingTaskReconciliationAssets;
}): Promise<FinalMeetingTaskListReconciliationState> {
  const { executor, input, state, item, index, match, modelStatus, assets } = args;
  const nextUnmatched = new Set(state.unmatchedExisting);
  nextUnmatched.delete(match.id);
  const shouldPreserveUserStatus = match.statusSource === "user";
  const sharedValues = finalMeetingTaskCandidateSharedValues({ item, index, assets });
  const [updated] = await mapRowsSequentially({
    rows: await mapRow({
      value: executor.meetingTasks.findMany({
        where: { id: match.id },
      }),
      map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: executor.meetingTasks.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            ...sharedValues,
            status: shouldPreserveUserStatus ? match.status : modelStatus,
            statusSource: shouldPreserveUserStatus ? "user" : "model",
            statusChangedAt:
              shouldPreserveUserStatus || match.status === modelStatus ? match.statusChangedAt : new Date(),
            completedAt: shouldPreserveUserStatus
              ? match.completedAt
              : modelStatus === "completed"
                ? (input.completedAt ?? new Date())
                : null,
            revision: storedRow.revision + 1,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
      });

      return updatedRows[0];
    },
  });

  return {
    taskRows: updated ? state.taskRows.concat(updated) : state.taskRows,
    unmatchedExisting: nextUnmatched,
  };
}

async function insertFinalMeetingTaskReconciliationRowWithin(args: {
  executor: typeof db | AccountTransaction;
  input: {
    meetingId: string;
    taskListId: string;
    completedAt?: Date | null;
  };
  state: FinalMeetingTaskListReconciliationState;
  item: MeetingTaskCandidate;
  index: number;
  modelStatus: MeetingTaskStatus;
  assets: FinalMeetingTaskReconciliationAssets;
}): Promise<FinalMeetingTaskListReconciliationState> {
  const { executor, input, state, item, index, modelStatus, assets } = args;
  const sharedValues = finalMeetingTaskCandidateSharedValues({ item, index, assets });
  const inserted = await mapRow({
    value: executor.meetingTasks.create({
      data: {
        meetingId: input.meetingId,
        taskListId: input.taskListId,
        ...sharedValues,
        status: modelStatus,
        statusSource: "model",
        statusChangedAt: new Date(),
        completedAt: modelStatus === "completed" ? (input.completedAt ?? new Date()) : null,
        createdFrom: "meeting_transcript",
        origin: "final",
        detectedAt: new Date(),
        externalLinks: jsonInput([]),
      },
    }),
    map: (row) => readStoredMeetingTask(row),
  });

  return {
    taskRows: state.taskRows.concat(inserted),
    unmatchedExisting: state.unmatchedExisting,
  };
}

async function reconcileFinalMeetingTaskCandidateWithin(args: {
  executor: typeof db | AccountTransaction;
  input: {
    meetingId: string;
    taskListId: string;
    completedAt?: Date | null;
  };
  state: FinalMeetingTaskListReconciliationState;
  item: MeetingTaskCandidate;
  index: number;
  existingRows: Prisma.meetingTasksModel[];
  userDismissedRows: Prisma.meetingTasksModel[];
  linkedAssets: FinalMeetingTaskReconciliationAssets["linkedAssets"];
  linkingSegments: FinalMeetingTaskReconciliationAssets["linkingSegments"];
}): Promise<FinalMeetingTaskListReconciliationState> {
  const { executor, input, state, item, index, existingRows, userDismissedRows, linkedAssets, linkingSegments } = args;
  if (finalMeetingTaskCandidateBlockedByUserDismissal({ userDismissedRows, item })) {
    return state;
  }
  const match = pickFinalMeetingTaskReconciliationMatch({
    existingRows,
    unmatchedExisting: state.unmatchedExisting,
    item,
  });
  const modelStatus: MeetingTaskStatus = item.completion.completedDuringMeeting ? "completed" : "open";
  const assets = { linkedAssets, linkingSegments };
  if (match) {
    return updateFinalMeetingTaskReconciliationMatchWithin({
      executor,
      input,
      state,
      item,
      index,
      match,
      modelStatus,
      assets,
    });
  }

  return insertFinalMeetingTaskReconciliationRowWithin({
    executor,
    input,
    state,
    item,
    index,
    modelStatus,
    assets,
  });
}

async function preserveUnmatchedMeetingTasksForListWithin(args: {
  executor: typeof db | AccountTransaction;
  input: { items: MeetingTaskCandidate[] };
  rows: Prisma.meetingTasksModel[];
  existing: Prisma.meetingTasksModel;
  offset: number;
}) {
  const { executor, input, rows, existing, offset } = args;
  const shouldPreserveUserStatus = existing.statusSource === "user";
  const preservedPosition = input.items.length + offset;
  const [updated] = await mapRowsSequentially({
    rows: await mapRow({
      value: executor.meetingTasks.findMany({
        where: { id: existing.id },
      }),
      map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: executor.meetingTasks.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            position: preservedPosition,
            status: shouldPreserveUserStatus ? existing.status : "dismissed",
            statusSource: shouldPreserveUserStatus ? "user" : "model",
            statusChangedAt:
              shouldPreserveUserStatus || existing.status === "dismissed" ? existing.statusChangedAt : new Date(),
            completedAt: shouldPreserveUserStatus ? existing.completedAt : null,
            revision: storedRow.revision + 1,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
      });

      return updatedRows[0];
    },
  });

  return updated ? rows.concat(updated) : rows;
}

const replaceAndCompleteMeetingTasksForListWithin = async (args: {
  executor: typeof db | AccountTransaction;
  input: {
    meetingId: string;
    taskListId: string;
    items: MeetingTaskCandidate[];
    model?: string | null;
    promptVersion?: string | null;
    transcriptHash?: string | null;
    completedAt?: Date | null;
  };
}) => {
  const { executor, input } = args;

  const meeting = await mapRow({
    value: executor.meetings.findFirst({
      where: { id: input.meetingId },
      take: 1,
      select: {
        workspaceId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  if (!meeting) {
    throw new Error(meetingNotFoundMessage(input.meetingId));
  }

  const [linkedAssets, linkingSegments] = await Promise.all([
    mapRow({
      value: executor.meetingAssets.findMany({
        where: { meetingId: input.meetingId },
        select: {
          id: true,
          transcriptSegmentIds: true,
          transcriptExcerpt: true,
          capturedAt: true,
        },
      }),
      map: (rows) => rows.map((row) => ({ ...row, transcriptSegmentIds: readStringArray(row.transcriptSegmentIds) })),
    }),
    executor.transcriptSegments.findMany({
      where: { transcripts: { meetingId: input.meetingId } },
      orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        startedAt: true,
        content: true,
      },
    }),
  ]);

  const existingRows = await mapRow({
    value: executor.meetingTasks.findMany({
      where: { taskListId: input.taskListId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
    map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
  });
  const userDismissedRows = existingRows.filter((row) => row.status === "dismissed" && row.statusSource === "user");
  const initialReconciliation: Promise<{
    taskRows: Prisma.meetingTasksModel[];
    unmatchedExisting: Set<string>;
  }> = Promise.resolve({
    taskRows: [],
    unmatchedExisting: new Set(existingRows.map((row) => row.id)),
  });
  const reconciledItems = await input.items.reduce(async (previous, item, index) => {
    const state = await previous;

    return reconcileFinalMeetingTaskCandidateWithin({
      executor,
      input,
      state,
      item,
      index,
      existingRows,
      userDismissedRows,
      linkedAssets,
      linkingSegments,
    });
  }, initialReconciliation);
  const preservedRows = existingRows.filter((row) => reconciledItems.unmatchedExisting.has(row.id));
  const taskRows = await preservedRows.reduce(async (previous, existing, offset) => {
    const rows = await previous;

    return preserveUnmatchedMeetingTasksForListWithin({ executor, input, rows, existing, offset });
  }, Promise.resolve(reconciledItems.taskRows));

  return completeMeetingTaskListAndPublishRealtimeWithin({
    executor,
    input,
    meetingWorkspaceId: meeting.workspaceId,
    taskRows,
  });
};

async function completeMeetingTaskListAndPublishRealtimeWithin(args: {
  executor: typeof db | AccountTransaction;
  input: {
    meetingId: string;
    taskListId: string;
    model?: string | null;
    promptVersion?: string | null;
    transcriptHash?: string | null;
    completedAt?: Date | null;
  };
  meetingWorkspaceId: string;
  taskRows: Prisma.meetingTasksModel[];
}) {
  const { executor, input, meetingWorkspaceId, taskRows } = args;

  const [taskListRow] = await mapRowsSequentially({
    rows: await mapRow({
      value: executor.meetingTaskLists.findMany({
        where: whereAnd([{ id: input.taskListId }, { meetingId: input.meetingId }]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          status: meetingTaskListStatusSchema.parse(row.status),
          error: row.error === null ? null : readJsonObject(row.error),
        })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: executor.meetingTaskLists.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            status: "completed",
            phase: "complete",
            error: jsonInput(null),
            model: input.model ?? null,
            promptVersion: input.promptVersion ?? null,
            transcriptHash: input.transcriptHash ?? null,
            taskListVersion: storedRow.taskListVersion + 1,
            completedAt: input.completedAt ?? new Date(),
            updatedAt: new Date(),
          },
        }),
        map: (rows) =>
          rows.map((row) => ({
            ...row,
            status: meetingTaskListStatusSchema.parse(row.status),
            error: row.error === null ? null : readJsonObject(row.error),
          })),
      });

      return updatedRows[0];
    },
  });

  if (!taskListRow) {
    throw new Error(meetingTaskListNotFoundMessage(input.taskListId));
  }

  return {
    meetingWorkspaceId,
    taskList: parseMeetingTaskListRow({ row: taskListRow, taskRows }),
    tasks: taskRows.map(parseMeetingTaskRow),
  };
}

async function publishCompletedMeetingTasks(args: {
  input: { meetingId: string };
  result: Awaited<ReturnType<typeof replaceAndCompleteMeetingTasksForListWithin>>;
}): Promise<void> {
  const { input, result } = args;
  const { tasks, taskList, meetingWorkspaceId } = result;
  const events = buildGeneratedTaskRealtimeEvents({
    recipientWorkspaces: await eligibleMeetingTaskRecipientWorkspaces({
      meetingId: input.meetingId,
      assigneeUserIds: tasks.map((task) => task.assignee.userId),
    }),
    workspaceId: meetingWorkspaceId,
    meetingId: input.meetingId,
    taskListVersion: taskList.taskListVersion,
    tasks,
  });
  const eventsWithAttendees = await addMeetingTaskAttendeeRealtimeEvents({
    meetingId: input.meetingId,
    workspaceId: meetingWorkspaceId,
    events,
  });

  await publishRealtimeEvents(eventsWithAttendees);
}

export async function replaceAndCompleteMeetingTasksForList(input: {
  jobId?: string | null;
  meetingId: string;
  taskListId: string;
  items: MeetingTaskCandidate[];
  model?: string | null;
  promptVersion?: string | null;
  transcriptHash?: string | null;
  completedAt?: Date | null;
}): ReplaceAndCompleteMeetingTasksForListResult {
  const result = await withRequestResult({
    ...input,
    run: (executor) => replaceAndCompleteMeetingTasksForListWithin({ input, executor }),
  });
  await publishCompletedMeetingTasks({ input, result });

  return { taskList: result.taskList, tasks: result.tasks };
}

type UpdateMeetingTaskResult = Promise<{
  type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
  status: "open" | "completed" | "dismissed";
  owner: {
    name: string | null;
    email: string | null;
    userId: string | null;
    confidence: "low" | "medium" | "high" | null;
  };
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  title: string;
  meetingId: string;
  position: number;
  assignee: {
    name: string | null;
    email: string | null;
    userId: string | null;
    confidence: "low" | "medium" | "high" | null;
  };
  taskListId: string;
  description: string | null;
  workKind:
    | "bug_or_issue"
    | "implementation"
    | "design"
    | "research"
    | "customer_follow_up"
    | "sales_or_crm"
    | "scheduling"
    | "documentation"
    | "general";
  confidence: "low" | "medium" | "high";
  dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
  sourceQuotes: {
    quote: string;
    speaker: string | null;
    timestamp: string | null;
    startedAt?: string | null | undefined;
    endedAt?: string | null | undefined;
    speakerIdentity?: string | null | undefined;
    sourceSegmentId?: string | null | undefined;
    segmentId?: string | null | undefined;
  }[];
  sourceReason: string;
  revision: number;
  createdFrom: "meeting_transcript";
  origin: "live" | "final";
  statusSource: "user" | "model";
  statusActorUserId: string | null;
  statusChangedAt: string | null;
  actionConfirmableAt: string | null;
  detectedAt: string | null;
  firstRenderedAt: string | null;
  assetIds: string[];
  externalLinks: Record<string, unknown>[];
}>;

function meetingTaskPatchAssigneeFields(input: {
  assigneeUserId?: string | null;
  assigneeName?: string | null;
  assigneeEmail?: string | null;
  ownerUserId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
}) {
  const nextAssigneeUserId = input.assigneeUserId !== undefined ? input.assigneeUserId : input.ownerUserId;
  const nextAssigneeName = input.assigneeName !== undefined ? input.assigneeName : input.ownerName;
  const nextAssigneeEmail = input.assigneeEmail !== undefined ? input.assigneeEmail : input.ownerEmail;
  const hasAssigneeChange = nextAssigneeUserId !== undefined || nextAssigneeName !== undefined;

  return { nextAssigneeUserId, nextAssigneeName, nextAssigneeEmail, hasAssigneeChange };
}

function meetingTaskPatchCompletedAt(input: {
  status?: MeetingTaskStatus;
  previousStatus: MeetingTaskStatus;
  previousCompletedAt: Date | null;
}) {
  if (input.status === undefined) {
    return undefined;
  }
  if (input.status === "completed") {
    return input.previousStatus === "completed" ? (input.previousCompletedAt ?? new Date()) : new Date();
  }

  return null;
}
type patchMeetingTaskRowWithinRow7 = {
  input: {
    meetingId: string;
    taskId: string;
    title?: string;
    description?: string | null;
    ownerUserId?: string | null;
    ownerName?: string | null;
    ownerEmail?: string | null;
    assigneeUserId?: string | null;
    assigneeName?: string | null;
    assigneeEmail?: string | null;
    dueDateValue?: string | null;
    status?: MeetingTaskStatus;
    actorUserId?: string | null;
  };
  previous: {
    task: Prisma.meetingTasksModel;
    workspaceId: string;
    taskListStatus: string;
  };
};

async function patchMeetingTaskRowWithin(args: patchMeetingTaskRowWithinRow7) {
  const { input, previous } = args;
  const { nextAssigneeUserId, nextAssigneeName, nextAssigneeEmail, hasAssigneeChange } =
    meetingTaskPatchAssigneeFields(input);
  const nextCompletedAt = meetingTaskPatchCompletedAt({
    status: input.status,
    previousStatus: meetingTaskStatusSchema.parse(previous.task.status),
    previousCompletedAt: previous.task.completedAt,
  });

  const [updated] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.meetingTasks.findMany({
        where: whereAnd([{ id: input.taskId }, { meetingId: input.meetingId }]),
      }),
      map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.meetingTasks.updateManyAndReturn({
          where: { id: storedRow.id },
          data: {
            title: input.title,
            description: input.description,
            ownerUserId: nextAssigneeUserId,
            ownerName: nextAssigneeName,
            ownerEmail: nextAssigneeEmail,
            ownerConfidence: !hasAssigneeChange
              ? undefined
              : (nextAssigneeUserId !== null && nextAssigneeUserId !== "") ||
                  (nextAssigneeName !== null && nextAssigneeName !== "")
                ? "high"
                : null,
            dueDateValue: input.dueDateValue,
            dueDateConfidence:
              input.dueDateValue === undefined
                ? undefined
                : input.dueDateValue !== null && input.dueDateValue !== ""
                  ? "high"
                  : null,
            status: input.status,
            statusSource: input.status === undefined ? undefined : "user",
            statusActorUserId: input.status === undefined ? undefined : (input.actorUserId ?? null),
            statusChangedAt:
              input.status === undefined || input.status === previous.task.status ? undefined : new Date(),
            completedAt: nextCompletedAt,
            revision: storedRow.revision + 1,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
      });

      return updatedRows[0];
    },
  });

  return updated;
}

const shiftSectionPlacementPositions = async (input: {
  workspaceId: string;
  assigneeUserId: string;
  sectionId: string;
  actorUserId: string | null;
}) => {
  await mapRowsSequentially({
    rows: await mapRow({
      value: db.assignedTaskPlacements.findMany({
        where: whereAnd([
          { workspaceId: input.workspaceId },
          { assigneeUserId: input.assigneeUserId },
          { sectionId: input.sectionId },
        ]),
      }),
      map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.assignedTaskPlacements.updateManyAndReturn({
          where: whereAnd([
            { sourceType: storedRow.sourceType },
            { sourceTaskId: storedRow.sourceTaskId },
            { workspaceId: storedRow.workspaceId },
            { assigneeUserId: storedRow.assigneeUserId },
          ]),
          data: {
            position: storedRow.position + 1,
            revision: storedRow.revision + 1,
            updatedByUserId: input.actorUserId,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
      });

      return updatedRows[0];
    },
  });
};

async function insertMeetingTaskInboxPlacementWithin(args: {
  input: {
    actorUserId?: string | null;
  };
  updated: Prisma.meetingTasksModel;
  ownerUserId: string;
  placementWorkspaceId: string;
}) {
  const { input, updated, ownerUserId, placementWorkspaceId } = args;
  const placementState: { revision: number | null; sectionId: string | null } = {
    revision: null,
    sectionId: null,
  };
  const defaultSectionFilter = whereAnd([
    { workspaceId: placementWorkspaceId },
    { isDefault: true },
    { deletedAt: null },
  ]);
  const selectedDefaultSection = await mapRow({
    value: db.workspaceTaskSections.findFirst({
      where: defaultSectionFilter,
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });
  const [insertedDefaultSection] = selectedDefaultSection
    ? []
    : await mapRow({
        value: createIgnoringUniqueConflict(() =>
          db.workspaceTaskSections.create({
            data: {
              workspaceId: placementWorkspaceId,
              title: "Inbox",
              position: 0,
              isDefault: true,
              createdByUserId: input.actorUserId ?? ownerUserId,
              updatedByUserId: input.actorUserId ?? ownerUserId,
            },
          }),
        ),
        map: (row) => (row === undefined ? [] : [row]),
      });
  const [reloadedDefaultSection] =
    selectedDefaultSection || insertedDefaultSection
      ? []
      : await db.workspaceTaskSections.findMany({
          where: defaultSectionFilter,
          take: 1,
        });
  const defaultSection = selectedDefaultSection ?? insertedDefaultSection ?? reloadedDefaultSection;

  if (defaultSection) {
    await shiftSectionPlacementPositions({
      workspaceId: placementWorkspaceId,
      assigneeUserId: ownerUserId,
      sectionId: defaultSection.id,
      actorUserId: input.actorUserId ?? null,
    });
    const placement = await mapRow({
      value: db.assignedTaskPlacements.create({
        data: {
          sourceType: "meeting",
          sourceTaskId: updated.id,
          workspaceId: placementWorkspaceId,
          assigneeUserId: ownerUserId,
          sectionId: defaultSection.id,
          position: 0,
          updatedByUserId: input.actorUserId ?? null,
        },
      }),
      map: (row) => ({
        ...row,
        sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType),
      }),
    });
    placementState.revision = placement.revision;
    placementState.sectionId = placement.sectionId;
  }

  return placementState;
}

async function syncMeetingTaskPlacementAfterPatchWithin(args: {
  input: {
    meetingId: string;
    actorUserId?: string | null;
  };
  previous: {
    task: Prisma.meetingTasksModel;
    workspaceId: string;
    taskListStatus: string;
  };
  updated: Prisma.meetingTasksModel;
}) {
  const { input, previous, updated } = args;
  const placementWorkspaces = await meetingTaskRecipientWorkspaces({ meetingId: input.meetingId });
  const placementWorkspaceId =
    updated.ownerUserId !== null && updated.ownerUserId !== ""
      ? (placementWorkspaces.get(updated.ownerUserId) ?? previous.workspaceId)
      : previous.workspaceId;
  const placementState: { revision: number | null; sectionId: string | null } = {
    revision: null,
    sectionId: null,
  };
  if (previous.taskListStatus === "completed") {
    const staleOwnerCondition =
      updated.ownerUserId !== null && updated.ownerUserId !== ""
        ? whereOr([{ assigneeUserId: { not: updated.ownerUserId } }, { workspaceId: { not: placementWorkspaceId } }])
        : undefined;
    const stalePlacementConditions = [
      { sourceType: "meeting" },
      { sourceTaskId: updated.id },
      ...(staleOwnerCondition ? [staleOwnerCondition] : []),
    ];
    // Remove old owners and legacy host-workspace rows; retain the current
    // placement's section/order when it already matches the personal feed.
    await db.assignedTaskPlacements.deleteMany({
      where: whereAnd(stalePlacementConditions),
    });

    if (updated.ownerUserId !== null && updated.ownerUserId !== "") {
      const existingPlacement = await mapRow({
        value: db.assignedTaskPlacements.findFirst({
          where: whereAnd([
            { sourceType: "meeting" },
            { sourceTaskId: updated.id },
            { workspaceId: placementWorkspaceId },
            { assigneeUserId: updated.ownerUserId },
          ]),
          take: 1,
        }),
        map: (row) =>
          row === null ? undefined : { ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) },
      });

      if (existingPlacement) {
        placementState.revision = existingPlacement.revision;
        placementState.sectionId = existingPlacement.sectionId;
      } else {
        const insertedPlacement = await insertMeetingTaskInboxPlacementWithin({
          input,
          updated,
          ownerUserId: updated.ownerUserId,
          placementWorkspaceId,
        });
        placementState.revision = insertedPlacement.revision;
        placementState.sectionId = insertedPlacement.sectionId;
      }
    }
  }

  return placementState;
}

function meetingTaskPatchMeetingEventName(args: {
  hasChangedAssignee: boolean;
  updated: Prisma.meetingTasksModel;
}): TaskRealtimeEventName {
  const { hasChangedAssignee, updated } = args;
  if (hasChangedAssignee) {
    return updated.ownerUserId !== null && updated.ownerUserId !== "" ? "task.assigned" : "task.unassigned";
  }

  return updated.status === "dismissed" ? "task.dismissed" : "task.updated";
}
type meetingTaskPatchUserRealtimeEventsRow8 = {
  previous: {
    task: Prisma.meetingTasksModel;
    taskListStatus: string;
  };
  updated: Prisma.meetingTasksModel;
  basePayload: {
    workspaceId: string;
    meetingId: string;
    taskId: string;
    revision: number;
    actorUserId: string | null;
  };
  hasChangedAssignee: boolean;
  meetingEventName: TaskRealtimeEventName;
  meetingPayload: ReturnType<typeof buildTaskRealtimePayload>;
  placementRevision: number | null;
  sectionId: string | null;
  recipientWorkspaces: Map<string, string>;
};

function meetingTaskPatchUserRealtimeEvents(args: meetingTaskPatchUserRealtimeEventsRow8) {
  const {
    previous,
    updated,
    basePayload,
    hasChangedAssignee,
    meetingEventName,
    meetingPayload,
    placementRevision,
    sectionId,
    recipientWorkspaces,
  } = args;
  if (previous.taskListStatus !== "completed") {
    return [];
  }

  return [
    ...(hasChangedAssignee && updated.ownerUserId !== null && updated.ownerUserId !== ""
      ? meetingUserTaskRealtimeEvents({
          recipientWorkspaces,
          userId: updated.ownerUserId,
          eventName: "task.assigned",
          payload: buildTaskRealtimePayload({
            ...basePayload,
            eventName: "task.assigned",
            sectionId,
            placementRevision,
          }),
          dedupeKey: `task:${updated.id}:revision:${updated.revision}:assigned:${updated.ownerUserId}`,
        })
      : []),
    ...(!hasChangedAssignee && updated.ownerUserId !== null && updated.ownerUserId !== ""
      ? meetingUserTaskRealtimeEvents({
          recipientWorkspaces,
          userId: updated.ownerUserId,
          eventName: meetingEventName,
          payload: meetingPayload,
          dedupeKey: `task:${updated.id}:revision:${updated.revision}:user:${updated.ownerUserId}`,
        })
      : []),
    ...(hasChangedAssignee &&
    previous.task.ownerUserId !== null &&
    previous.task.ownerUserId !== "" &&
    previous.task.ownerUserId !== updated.ownerUserId
      ? meetingUserTaskRealtimeEvents({
          recipientWorkspaces,
          userId: previous.task.ownerUserId,
          eventName: "task.unassigned",
          payload: buildTaskRealtimePayload({
            ...basePayload,
            eventName: "task.unassigned",
          }),
          dedupeKey: `task:${updated.id}:revision:${updated.revision}:unassigned:${previous.task.ownerUserId}`,
        })
      : []),
  ];
}

function buildMeetingTaskPatchRealtimeEvents(args: {
  previous: {
    task: Prisma.meetingTasksModel;
    workspaceId: string;
    taskListStatus: string;
  };
  updated: Prisma.meetingTasksModel;
  input: {
    meetingId: string;
    actorUserId?: string | null;
  };
  hasChangedAssignee: boolean;
  placementRevision: number | null;
  sectionId: string | null;
  recipientWorkspaces: Map<string, string>;
}) {
  const { previous, updated, input, hasChangedAssignee, placementRevision, sectionId, recipientWorkspaces } = args;
  const channel = meetingTasksRealtimeChannel({
    workspaceId: previous.workspaceId,
    meetingId: input.meetingId,
  });
  const basePayload = {
    workspaceId: previous.workspaceId,
    meetingId: input.meetingId,
    taskId: updated.id,
    revision: updated.revision,
    actorUserId: input.actorUserId ?? null,
  };
  const meetingEventName = meetingTaskPatchMeetingEventName({ hasChangedAssignee, updated });
  const meetingPayload = buildTaskRealtimePayload({
    ...basePayload,
    eventName: meetingEventName,
    sectionId,
    placementRevision,
  });
  const userEvents = meetingTaskPatchUserRealtimeEvents({
    previous,
    updated,
    basePayload,
    hasChangedAssignee,
    meetingEventName,
    meetingPayload,
    placementRevision,
    sectionId,
    recipientWorkspaces,
  });

  return {
    meetingEventName,
    events: [
      {
        channel,
        eventName: meetingEventName,
        payload: meetingPayload,
        dedupeKey: `task:${updated.id}:revision:${updated.revision}:meeting`,
      },
      ...userEvents,
    ],
  };
}

async function publishMeetingTaskPatchRealtimeWithin(args: {
  input: {
    meetingId: string;
    actorUserId?: string | null;
  };
  previous: {
    task: Prisma.meetingTasksModel;
    workspaceId: string;
    taskListStatus: string;
  };
  updated: Prisma.meetingTasksModel;
  hasChangedAssignee: boolean;
  placementState: { revision: number | null; sectionId: string | null };
}) {
  const { input, previous, updated, hasChangedAssignee, placementState } = args;
  const recipientWorkspaces = await eligibleMeetingTaskRecipientWorkspaces({
    meetingId: input.meetingId,
    assigneeUserIds: [previous.task.ownerUserId, updated.ownerUserId],
  });
  const { events } = buildMeetingTaskPatchRealtimeEvents({
    previous,
    updated,
    input,
    hasChangedAssignee,
    placementRevision: placementState.revision,
    sectionId: placementState.sectionId,
    recipientWorkspaces,
  });

  if (events.length !== 0) {
    if (previous.taskListStatus === "completed") {
      const eventsWithAttendees = await addMeetingTaskAttendeeRealtimeEvents({
        meetingId: input.meetingId,
        workspaceId: previous.workspaceId,
        events,
      });
      await publishRealtimeEvents(eventsWithAttendees);
    } else {
      await publishRealtimeEvents(events);
    }
  }
}

const updateMeetingTaskWithin = async (args: {
  input: {
    meetingId: string;
    taskId: string;
    title?: string;
    description?: string | null;
    ownerUserId?: string | null;
    ownerName?: string | null;
    ownerEmail?: string | null;
    assigneeUserId?: string | null;
    assigneeName?: string | null;
    assigneeEmail?: string | null;
    dueDateValue?: string | null;
    status?: MeetingTaskStatus;
    actorUserId?: string | null;
  };
}) => {
  const { input } = args;

  const previous = await mapRow({
    value: db.meetingTasks.findFirst({
      where: whereAnd([{ id: input.taskId }, { meetingId: input.meetingId }]),
      take: 1,
      select: {
        id: true,
        meetingId: true,
        taskListId: true,
        position: true,
        title: true,
        description: true,
        type: true,
        ownerName: true,
        ownerEmail: true,
        ownerConfidence: true,
        dueDateValue: true,
        dueDateConfidence: true,
        confidence: true,
        sourceQuotes: true,
        sourceReason: true,
        status: true,
        createdFrom: true,
        externalLinks: true,
        createdAt: true,
        updatedAt: true,
        workKind: true,
        ownerUserId: true,
        revision: true,
        completedAt: true,
        assetIds: true,
        origin: true,
        statusSource: true,
        statusActorUserId: true,
        statusChangedAt: true,
        actionConfirmableAt: true,
        detectedAt: true,
        firstRenderedAt: true,
        firstRenderedReportedAt: true,
        realtimeReceivedAt: true,
        refetchStartedAt: true,
        refetchCompletedAt: true,
        meetings: { select: { workspaceId: true } },
        meetingTaskLists: { select: { status: true } },
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : ((row) => ({
            task: readStoredMeetingTask(row),
            workspaceId: row.meetings.workspaceId,
            taskListStatus: meetingTaskListStatusSchema.parse(row.meetingTaskLists.status),
          }))(row),
  });

  if (!previous) {
    return null;
  }

  const updated = await patchMeetingTaskRowWithin({ input, previous });
  if (!updated) {
    return null;
  }

  const placementState = await syncMeetingTaskPlacementAfterPatchWithin({ input, previous, updated });
  const hasChangedAssignee = previous.task.ownerUserId !== updated.ownerUserId;
  await publishMeetingTaskPatchRealtimeWithin({
    input,
    previous,
    updated,
    hasChangedAssignee,
    placementState,
  });

  return updated;
};

export async function updateMeetingTask(input: {
  meetingId: string;
  taskId: string;
  title?: string;
  description?: string | null;
  ownerUserId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  assigneeUserId?: string | null;
  assigneeName?: string | null;
  assigneeEmail?: string | null;
  dueDateValue?: string | null;
  status?: MeetingTaskStatus;
  actorUserId?: string | null;
}): UpdateMeetingTaskResult {
  const row = await updateMeetingTaskWithin({ input });

  if (!row) {
    throw new Error(failedToUpdateMeetingTaskMessage(input.taskId));
  }

  return parseMeetingTaskRow(row);
}

async function emitMeetingTaskDeletionRealtimeWithin(args: {
  input: {
    meetingId: string;
    actorUserId?: string | null;
  };
  meeting: { workspaceId: string };
  existingTasks: {
    id: string;
    ownerUserId: string | null;
    taskListId: string;
    revision: number;
  }[];
}) {
  const { input, meeting, existingTasks } = args;
  const recipientWorkspaces = await eligibleMeetingTaskRecipientWorkspaces({
    meetingId: input.meetingId,
    assigneeUserIds: existingTasks.map((task) => task.ownerUserId),
  });
  const events = existingTasks.flatMap((task) => {
    const payload = buildTaskRealtimePayload({
      eventName: "task.deleted",
      workspaceId: meeting.workspaceId,
      meetingId: input.meetingId,
      taskId: task.id,
      revision: task.revision + 1,
      actorUserId: input.actorUserId ?? null,
    });
    const userEvents =
      task.ownerUserId !== null && task.ownerUserId !== ""
        ? meetingUserTaskRealtimeEvents({
            recipientWorkspaces,
            userId: task.ownerUserId,
            eventName: "task.deleted",
            payload,
            dedupeKey: `task:${task.id}:deleted:user:${task.ownerUserId}`,
          })
        : [];

    return [
      {
        channel: meetingTasksRealtimeChannel({
          workspaceId: meeting.workspaceId,
          meetingId: input.meetingId,
        }),
        eventName: "task.deleted",
        payload,
        dedupeKey: `task:${task.id}:deleted:meeting`,
      },
      ...userEvents,
    ];
  });
  if (events.length !== 0) {
    const eventsWithAttendees = await addMeetingTaskAttendeeRealtimeEvents({
      meetingId: input.meetingId,
      workspaceId: meeting.workspaceId,
      events,
    });
    await publishRealtimeEvents(eventsWithAttendees);
  }
}

const deleteMeetingTasksByIdsWithin = async (args: {
  input: {
    meetingId: string;
    taskIds: string[];
    actorUserId?: string | null;
    expectedRevisions?: Record<string, number>;
  };
  uniqueTaskIds: string[];
}) => {
  const { input, uniqueTaskIds } = args;

  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { id: input.meetingId },
      take: 1,
      select: {
        workspaceId: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  const existingTasks = await db.meetingTasks.findMany({
    where: whereAnd([{ meetingId: input.meetingId }, { id: { in: uniqueTaskIds } }]),
    select: {
      id: true,
      ownerUserId: true,
      taskListId: true,
      revision: true,
    },
  });
  if (input.expectedRevisions && existingTasks.length !== 0) {
    const existingById = new Map(existingTasks.map((task) => [task.id, task]));
    const hasChangedTask = uniqueTaskIds.some(
      (taskId) => existingById.get(taskId)?.revision !== input.expectedRevisions?.[taskId],
    );
    if (hasChangedTask) {
      throw new Error(MEETING_TASKS_CHANGED_BEFORE_CONDITIONAL_DELETION_MESSAGE);
    }
  }

  if (meeting && existingTasks.length !== 0) {
    await db.assignedTaskPlacements.deleteMany({
      where: whereAnd([{ sourceType: "meeting" }, { sourceTaskId: { in: existingTasks.map((task) => task.id) } }]),
    });
  }

  const deleted = await (async () => {
    const where20 = sqlAnd([
      sqlCompare({ columnSql: '"meeting_tasks"."meeting_id"', operator: "=", value: input.meetingId, cast: "uuid" }),
      sqlIn({ columnSql: '"meeting_tasks"."id"', values: uniqueTaskIds, cast: "uuid", isNegated: false }),
    ]);

    return db.$queryRaw<{ id: string }[]>`
                        DELETE FROM "meeting_tasks"
                        ${sqlWhereClause(where20)}
                        RETURNING "id" AS "id"
                        `;
  })();

  const taskListIds = [...new Set(existingTasks.map((task) => task.taskListId))];
  if (taskListIds.length !== 0) {
    await mapRowsSequentially({
      rows: await mapRow({
        value: db.meetingTaskLists.findMany({
          where: { id: { in: taskListIds } },
        }),
        map: (rows) =>
          rows.map((row) => ({
            ...row,
            status: meetingTaskListStatusSchema.parse(row.status),
            error: row.error === null ? null : readJsonObject(row.error),
          })),
      }),
      visit: async (storedRow) => {
        const updatedRows = await mapRow({
          value: db.meetingTaskLists.updateManyAndReturn({
            where: { id: storedRow.id },
            data: {
              taskListVersion: storedRow.taskListVersion + 1,
              updatedAt: new Date(),
            },
          }),
          map: (rows) =>
            rows.map((row) => ({
              ...row,
              status: meetingTaskListStatusSchema.parse(row.status),
              error: row.error === null ? null : readJsonObject(row.error),
            })),
        });

        return updatedRows[0];
      },
    });
  }

  if (meeting) {
    await emitMeetingTaskDeletionRealtimeWithin({ input, meeting, existingTasks });
  }

  return deleted;
};

export async function deleteMeetingTasksByIds(input: {
  meetingId: string;
  taskIds: string[];
  actorUserId?: string | null;
  expectedRevisions?: Record<string, number>;
}): Promise<string[]> {
  const uniqueTaskIds = [...new Set(input.taskIds)];
  if (uniqueTaskIds.length === 0) {
    return [];
  }

  const rows = await deleteMeetingTasksByIdsWithin({ input, uniqueTaskIds });

  return rows.map((row) => row.id);
}

export async function publishTaskRealtimeEvent(input: {
  workspaceId: string;
  meetingId: string;
  channel: string;
  eventName: TaskRealtimeEventName;
  taskId?: string | null;
  revision?: number | null;
  taskListVersion?: number | null;
  actorUserId?: string | null;
  dedupeKey: string;
}): Promise<void> {
  const payload = buildTaskRealtimePayload({
    eventName: input.eventName,
    workspaceId: input.workspaceId,
    meetingId: input.meetingId,
    taskId: input.taskId ?? null,
    revision: input.revision ?? null,
    taskListVersion: input.taskListVersion ?? null,
    actorUserId: input.actorUserId ?? null,
  });
  await publishRealtimeEvents([{ channel: input.channel, eventName: input.eventName, payload }]);
}

export async function publishCalendarRealtimeEvent(input: {
  userId: string;
  provider: CalendarProvider;
  connectorId?: string | null;
  calendarId?: string | null;
  resourceState?: string | null;
  messageNumber?: string | null;
  dedupeKey: string;
}): Promise<void> {
  const eventName = "calendar.events.changed" satisfies CalendarRealtimeEventName;
  const workspaceIds = await listWorkspaceIdsForUser(input.userId);
  const payload = buildCalendarRealtimePayload({
    eventName,
    userId: input.userId,
    provider: input.provider,
    connectorId: input.connectorId ?? null,
    calendarId: input.calendarId ?? null,
    resourceState: input.resourceState ?? null,
    messageNumber: input.messageNumber ?? null,
  });

  await publishRealtimeEvents(
    workspaceIds.map((workspaceId) => ({
      channel: userCalendarRealtimeChannel({ workspaceId, userId: input.userId }),
      eventName,
      payload,
    })),
  );
}

function toIsoString(value: Date | string | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const PAST_MEETING_LOOKBACK_DAYS = 365;
const DEFAULT_PARTICIPANT_THREAD_LIMIT = 16;

const pastMeetingParticipants = (input: {
  rows: { meetingId: string; email: string | null; displayName: string | null }[];
  meetingId: string;
}) => {
  const seen = new Set<string>();

  return input.rows.flatMap((row) => {
    if (
      row.meetingId !== input.meetingId ||
      row.email === null ||
      row.email === "" ||
      row.displayName === null ||
      row.displayName === ""
    ) {
      return [];
    }
    const key = `${row.email}\u0000${row.displayName}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);

    return [{ email: row.email, displayName: row.displayName }];
  });
};
type rowsRow9 = {
  meeting__id: string;
  meeting__title: string;
  meeting__roomName: string;
  meeting__createdByUserId: string;
  meeting__status: "scheduled" | "active" | "ended";
  meeting__createdAt: Date;
  meeting__startedAt: Date | null;
  meeting__endedAt: Date | null;
  meeting__hiddenFromHistoryAt: Date | null;
  meeting__hiddenFromHistoryReason: string | null;
  meeting__workspaceId: string;
  meeting__meetingLinkId: string | null;
  meeting__instanceNumber: number;
  meeting__kind: MeetingKind;
  isConfidential: boolean;
  meeting__confidentialitySource: ("auto" | "manual") | null;
  meeting__confidentialityUpdatedByUserId: string | null;
  meeting__confidentialityUpdatedAt: Date | null;
  meeting__agentIntroKey: string | null;
  meeting__currentLinkKey: string | null;
  summary: string | null;
  summaryId: string | null;
};

const rowsSql3 = `
                             SELECT "meetings"."id" AS "meeting__id",
                             "meetings"."title" AS "meeting__title",
                             "meetings"."room_name" AS "meeting__roomName",
                             "meetings"."created_by_user_id" AS "meeting__createdByUserId",
                             "meetings"."status" AS "meeting__status",
                             "meetings"."created_at" AS "meeting__createdAt",
                             "meetings"."started_at" AS "meeting__startedAt",
                             "meetings"."ended_at" AS "meeting__endedAt",
                             "meetings"."hidden_from_history_at" AS "meeting__hiddenFromHistoryAt",
                             "meetings"."hidden_from_history_reason" AS "meeting__hiddenFromHistoryReason",
                             "meetings"."workspace_id" AS "meeting__workspaceId",
                             "meetings"."meeting_link_id" AS "meeting__meetingLinkId",
                             "meetings"."instance_number" AS "meeting__instanceNumber",
                             "meetings"."kind" AS "meeting__kind",
                             "meetings"."is_confidential" AS "isConfidential",
                             "meetings"."confidentiality_source" AS "meeting__confidentialitySource",
                             "meetings"."confidentiality_updated_by_user_id" AS "meeting__confidentialityUpdatedByUserId",
                             "meetings"."confidentiality_updated_at" AS "meeting__confidentialityUpdatedAt",
                             "meetings"."agent_intro_key" AS "meeting__agentIntroKey",
                             "meetings"."current_link_key" AS "meeting__currentLinkKey",
                             "summaries"."id" AS "summaryId",
                             "summaries"."content" AS "summary"
                             FROM "meetings"
                             INNER JOIN "meeting_participants" ON `;

export async function listMeetingBriefPastMeetingContextCandidates(input: {
  userId: string;
  before: Date;
  limit?: number;
}): Promise<MeetingBriefPastMeetingContextCandidate[]> {
  const windowStart = new Date(input.before.getTime() - PAST_MEETING_LOOKBACK_DAYS * MILLISECONDS_PER_DAY);
  const meetingsRows = await (async () => {
    const where21 = sqlAnd([
      sqlCompare({ columnSql: '"meetings"."status"', operator: "=", value: "ended", cast: null }),
      sqlIsNull({ columnSql: '"meetings"."hidden_from_history_at"', isNegated: false }),
      sqlIsNull({ columnSql: '"meetings"."ended_at"', isNegated: true }),
      sqlCompare({ columnSql: '"meetings"."ended_at"', operator: "<", value: input.before, cast: "timestamptz" }),
      sqlCompare({ columnSql: '"meetings"."ended_at"', operator: ">", value: windowStart, cast: "timestamptz" }),
    ]);
    const join210 = sqlAnd([
      sqlColCompare({ leftSql: '"meeting_participants"."meeting_id"', operator: "=", rightSql: '"meetings"."id"' }),
      sqlCompare({ columnSql: '"meeting_participants"."user_id"', operator: "=", value: input.userId, cast: "uuid" }),
    ]);
    const join211 = sqlColCompare({ leftSql: '"summaries"."meeting_id"', operator: "=", rightSql: '"meetings"."id"' });
    const order21 = sqlOrderBy([sqlSort({ columnSql: '"meetings"."ended_at"', direction: "DESC" })]);
    const limit21 = input.limit ?? DEFAULT_PARTICIPANT_THREAD_LIMIT;
    const rows = await decodeContentAliases({
      rows: await db.$queryRaw<rowsRow9[]>`${Prisma.raw(rowsSql3)}${join210}
                             LEFT JOIN "summaries" ON ${join211}
                             ${sqlWhereClause(where21)}

                             ${order21}
                             ${sqlLimit(limit21)}


                             `,
      projections: [
        contentProjection({ model: "meetings", prefix: "meeting__" }),
        { model: "summaries", fields: { id: "summaryId", content: "summary" } },
      ],
    });

    return rows.map((row) => ({
      summary: row.summary,
      meeting: {
        id: row.meeting__id,
        title: row.meeting__title,
        roomName: row.meeting__roomName,
        createdByUserId: row.meeting__createdByUserId,
        status: row.meeting__status,
        createdAt: row.meeting__createdAt,
        startedAt: row.meeting__startedAt,
        endedAt: row.meeting__endedAt,
        hiddenFromHistoryAt: row.meeting__hiddenFromHistoryAt,
        hiddenFromHistoryReason: row.meeting__hiddenFromHistoryReason,
        workspaceId: row.meeting__workspaceId,
        meetingLinkId: row.meeting__meetingLinkId,
        instanceNumber: row.meeting__instanceNumber,
        kind: row.meeting__kind,
        isConfidential: row.isConfidential,
        confidentialitySource: row.meeting__confidentialitySource,
        confidentialityUpdatedByUserId: row.meeting__confidentialityUpdatedByUserId,
        confidentialityUpdatedAt: row.meeting__confidentialityUpdatedAt,
        agentIntroKey: row.meeting__agentIntroKey,
        currentLinkKey: row.meeting__currentLinkKey,
      },
    }));
  })();
  const meetingIds = meetingsRows.map((row) => row.meeting.id);
  const participantRows =
    meetingIds.length === 0
      ? []
      : await mapRow({
          value: db.meetingParticipants.findMany({
            where: { meetingId: { in: meetingIds } },
            select: {
              meetingId: true,
              users: { select: { email: true, displayName: true } },
            },
          }),
          map: (rows) =>
            rows.map((row) => ({
              meetingId: row.meetingId,
              email: row.users.email,
              displayName: row.users.displayName,
            })),
        });

  return meetingsRows.flatMap((row) => {
    const endedAt = row.meeting.endedAt;
    if (endedAt === null) {
      return [];
    }

    return [
      {
        meetingId: row.meeting.id,
        title: row.meeting.title,
        endedAt: endedAt.toISOString(),
        summary: row.summary,
        participants: pastMeetingParticipants({ rows: participantRows, meetingId: row.meeting.id }),
      },
    ];
  });
}

/**
 * Tasks created from a confidential meeting are visible only to that
 * meeting's participants (and its organizer) — assignment alone is not
 * enough. Ended meeting tasks also retain the meeting notes entitlement gate.
 */
const participantMeetingIdSet = async (args: { userId: string; meetingIds: string[] }) => {
  if (args.meetingIds.length === 0) {
    return new Set<string>();
  }
  const rows = await db.meetingParticipants.findMany({
    where: whereAnd([{ userId: args.userId }, { meetingId: { in: args.meetingIds } }]),
    select: {
      meetingId: true,
    },
  });

  return new Set(rows.map((row) => row.meetingId));
};

const entitledEndedMeetingIdSet = async (args: { userId: string; meetings: Prisma.meetingsModel[] }) => {
  const endedIds = [
    ...new Set(args.meetings.filter((meeting) => meeting.status === "ended").map((meeting) => meeting.id)),
  ];

  return endedIds.reduce<Promise<Set<string>>>(async (previous, meetingId) => {
    const ids = await previous;
    const isAllowed = await hasMemoryNotesEntitlement({ userId: args.userId, meetingId });
    if (!isAllowed) {
      return ids;
    }

    return new Set([...ids, meetingId]);
  }, Promise.resolve(new Set<string>()));
};

const meetingTaskIsVisible = (args: {
  meeting: Prisma.meetingsModel;
  userId: string;
  participantMeetingIds: Set<string>;
  entitledEndedMeetingIds: Set<string>;
}) => {
  const canSeeConfidential =
    !args.meeting.isConfidential ||
    args.meeting.createdByUserId === args.userId ||
    args.participantMeetingIds.has(args.meeting.id);
  const isNotesAllowed = args.meeting.status !== "ended" || args.entitledEndedMeetingIds.has(args.meeting.id);

  return canSeeConfidential && isNotesAllowed;
};

const visibleMeetingTaskRows = async <Row extends { meeting: Prisma.meetingsModel }>(args: {
  userId: string;
  rows: Row[];
}) => {
  const participantMeetingIds = await participantMeetingIdSet({
    userId: args.userId,
    meetingIds: [...new Set(args.rows.map((row) => row.meeting.id))],
  });
  const entitledEndedMeetingIds = await entitledEndedMeetingIdSet({
    userId: args.userId,
    meetings: args.rows.map((row) => row.meeting),
  });

  return args.rows.filter((row) =>
    meetingTaskIsVisible({
      meeting: row.meeting,
      userId: args.userId,
      participantMeetingIds,
      entitledEndedMeetingIds,
    }),
  );
};

const filingWorkspaceByMeetingId = async (args: { userId: string; meetingIds: string[] }) => {
  if (args.meetingIds.length === 0) {
    return new Map<string, string>();
  }
  const rows = await db.meetingAttendeeWorkspaces.findMany({
    where: whereAnd([{ userId: args.userId }, { meetingId: { in: args.meetingIds } }]),
    select: {
      meetingId: true,
      workspaceId: true,
    },
  });

  return new Map(rows.map((row) => [row.meetingId, row.workspaceId]));
};

const loadPersonalClearances = async (userId: string) => {
  const [ranges, items] = await Promise.all([
    db.personalTaskClearances.findMany({
      where: { userId },
    }),
    mapRow({
      value: db.personalTaskItemClearances.findMany({
        where: { userId },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          sourceType: readStringUnion({ values: ["meeting", "workspace"], value: row.sourceType }),
        })),
    }),
  ]);

  return {
    rangeCutoffByWorkspace: new Map(ranges.map((row) => [row.workspaceId, row.completedBefore])),
    itemCutoffByKey: new Map(
      items.map((row) => [`${row.sourceType}:${row.sourceTaskId}:${row.workspaceId}`, row.completedBefore]),
    ),
  };
};

const completionIsAfterCutoff = (args: { completedAt: Date | null; updatedAt: Date; cutoff: Date }) =>
  args.completedAt !== null
    ? args.completedAt.getTime() > args.cutoff.getTime()
    : args.updatedAt.getTime() > args.cutoff.getTime();

const personalTaskIsUncleared = (args: {
  status: string;
  completedAt: Date | null;
  updatedAt: Date;
  workspaceId: string;
  sourceType: "meeting" | "workspace";
  taskId: string;
  clearances: Awaited<ReturnType<typeof loadPersonalClearances>>;
}) => {
  if (args.status !== "completed") {
    return true;
  }
  const rangeCutoff = args.clearances.rangeCutoffByWorkspace.get(args.workspaceId);
  const itemCutoff = args.clearances.itemCutoffByKey.get(`${args.sourceType}:${args.taskId}:${args.workspaceId}`);
  const isRangeAllowed =
    rangeCutoff === undefined ||
    completionIsAfterCutoff({ completedAt: args.completedAt, updatedAt: args.updatedAt, cutoff: rangeCutoff });
  const isItemAllowed =
    itemCutoff === undefined ||
    completionIsAfterCutoff({ completedAt: args.completedAt, updatedAt: args.updatedAt, cutoff: itemCutoff });

  return isRangeAllowed && isItemAllowed;
};

type PersonalMeetingScope = {
  userId: string;
  workspaceIds: Set<string>;
  participantMeetingIds: Set<string>;
  filingWorkspaceByMeeting: Map<string, string>;
  suspendedHostWorkspaceIds: Set<string>;
  entitledEndedMeetingIds: Set<string>;
  clearances: Awaited<ReturnType<typeof loadPersonalClearances>>;
};

const loadPersonalMeetingScope = async (args: {
  userId: string;
  workspaceIds: string[];
  meetings: Prisma.meetingsModel[];
}): Promise<PersonalMeetingScope> => {
  const meetingIds = [...new Set(args.meetings.map((meeting) => meeting.id))];
  const [participantMeetingIds, filingWorkspaceByMeeting, suspendedRows, entitledEndedMeetingIds, clearances] =
    await Promise.all([
      participantMeetingIdSet({ userId: args.userId, meetingIds }),
      filingWorkspaceByMeetingId({ userId: args.userId, meetingIds }),
      db.workspaceMemberships.findMany({
        where: whereAnd([{ userId: args.userId }, { status: "suspended" }]),
        select: {
          workspaceId: true,
        },
      }),
      entitledEndedMeetingIdSet({ userId: args.userId, meetings: args.meetings }),
      loadPersonalClearances(args.userId),
    ]);

  return {
    userId: args.userId,
    workspaceIds: new Set(args.workspaceIds),
    participantMeetingIds,
    filingWorkspaceByMeeting,
    suspendedHostWorkspaceIds: new Set(suspendedRows.map((row) => row.workspaceId)),
    entitledEndedMeetingIds,
    clearances,
  };
};

const viewerWorkspaceIdForMeeting = (args: { meeting: Prisma.meetingsModel; scope: PersonalMeetingScope }) =>
  args.scope.participantMeetingIds.has(args.meeting.id)
    ? (args.scope.filingWorkspaceByMeeting.get(args.meeting.id) ?? args.meeting.workspaceId)
    : args.meeting.workspaceId;

const personalMeetingRowAllowed = (args: {
  task: Prisma.meetingTasksModel;
  meeting: Prisma.meetingsModel;
  scope: PersonalMeetingScope;
  shouldRequireNotesVisibility: boolean;
}) => {
  const viewerWorkspaceId = viewerWorkspaceIdForMeeting({ meeting: args.meeting, scope: args.scope });
  if (
    !args.scope.workspaceIds.has(viewerWorkspaceId) ||
    args.scope.suspendedHostWorkspaceIds.has(args.meeting.workspaceId)
  ) {
    return false;
  }
  const isUncleared = personalTaskIsUncleared({
    status: args.task.status,
    completedAt: args.task.completedAt,
    updatedAt: args.task.updatedAt,
    workspaceId: viewerWorkspaceId,
    sourceType: "meeting",
    taskId: args.task.id,
    clearances: args.scope.clearances,
  });
  if (!isUncleared) {
    return false;
  }
  if (!args.shouldRequireNotesVisibility) {
    return true;
  }

  return meetingTaskIsVisible({
    meeting: args.meeting,
    userId: args.scope.userId,
    participantMeetingIds: args.scope.participantMeetingIds,
    entitledEndedMeetingIds: args.scope.entitledEndedMeetingIds,
  });
};

const otherPersonalMeetingAllowed = (args: {
  task: Prisma.meetingTasksModel;
  meeting: Prisma.meetingsModel;
  scope: PersonalMeetingScope;
}) => {
  if (!personalMeetingRowAllowed({ ...args, shouldRequireNotesVisibility: false })) {
    return false;
  }
  const isParticipant = args.scope.participantMeetingIds.has(args.meeting.id);

  return (
    isParticipant ||
    args.meeting.createdByUserId === args.scope.userId ||
    (!args.meeting.isConfidential && args.meeting.kind === "standard")
  );
};

type ListAssignedTasksForUserResult = Promise<
  {
    task: {
      type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
      status: "open" | "completed" | "dismissed";
      owner: {
        name: string | null;
        email: string | null;
        userId: string | null;
        confidence: "low" | "medium" | "high" | null;
      };
      id: string;
      createdAt: string;
      updatedAt: string;
      completedAt: string | null;
      title: string;
      meetingId: string;
      position: number;
      assignee: {
        name: string | null;
        email: string | null;
        userId: string | null;
        confidence: "low" | "medium" | "high" | null;
      };
      taskListId: string;
      description: string | null;
      workKind:
        | "bug_or_issue"
        | "implementation"
        | "design"
        | "research"
        | "customer_follow_up"
        | "sales_or_crm"
        | "scheduling"
        | "documentation"
        | "general";
      confidence: "low" | "medium" | "high";
      dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
      sourceQuotes: {
        quote: string;
        speaker: string | null;
        timestamp: string | null;
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        speakerIdentity?: string | null | undefined;
        sourceSegmentId?: string | null | undefined;
        segmentId?: string | null | undefined;
      }[];
      sourceReason: string;
      revision: number;
      createdFrom: "meeting_transcript";
      origin: "live" | "final";
      statusSource: "user" | "model";
      statusActorUserId: string | null;
      statusChangedAt: string | null;
      actionConfirmableAt: string | null;
      detectedAt: string | null;
      firstRenderedAt: string | null;
      assetIds: string[];
      externalLinks: Record<string, unknown>[];
    };
    meeting: { id: string; workspaceId: string; title: string; startedAt: string | null; endedAt: string | null };
  }[]
>;

export async function listAssignedTasksForUser(input: {
  userId: string;
  workspaceIds: string[];
}): ListAssignedTasksForUserResult {
  const workspaceIds = [...new Set(input.workspaceIds)].filter(Boolean);
  if (workspaceIds.length === 0) {
    return [];
  }

  const rows = await mapRow({
    value: db.meetingTasks.findMany({
      where: whereAnd([
        { meetingTaskLists: { status: "completed" } },
        { ownerUserId: input.userId },
        { status: { not: "dismissed" } },
        { meetings: { hiddenFromHistoryAt: null } },
        { meetings: { workspaceId: { in: workspaceIds } } },
      ]),
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        meetingId: true,
        taskListId: true,
        position: true,
        title: true,
        description: true,
        type: true,
        ownerName: true,
        ownerEmail: true,
        ownerConfidence: true,
        dueDateValue: true,
        dueDateConfidence: true,
        confidence: true,
        sourceQuotes: true,
        sourceReason: true,
        status: true,
        createdFrom: true,
        externalLinks: true,
        createdAt: true,
        updatedAt: true,
        workKind: true,
        ownerUserId: true,
        revision: true,
        completedAt: true,
        assetIds: true,
        origin: true,
        statusSource: true,
        statusActorUserId: true,
        statusChangedAt: true,
        actionConfirmableAt: true,
        detectedAt: true,
        firstRenderedAt: true,
        firstRenderedReportedAt: true,
        realtimeReceivedAt: true,
        refetchStartedAt: true,
        refetchCompletedAt: true,
        meetings: true,
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        task: readStoredMeetingTask(row),
        meeting: readStoredMeeting(row.meetings),
      })),
  });
  const visibleRows = await visibleMeetingTaskRows({ userId: input.userId, rows });

  return visibleRows.map((row) => ({
    task: parseMeetingTaskRow(row.task),
    meeting: {
      id: row.meeting.id,
      workspaceId: row.meeting.workspaceId,
      title: row.meeting.title,
      startedAt: row.meeting.startedAt?.toISOString() ?? null,
      endedAt: row.meeting.endedAt?.toISOString() ?? null,
    },
  }));
}

type ListWorkspaceAssignedTasksForUserResult = Promise<{
  sections: {
    id: string;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
    createdByUserId: string | null;
    workspaceId: string;
    title: string;
    isDefault: boolean;
    position: number;
    updatedByUserId: string | null;
  }[];
  tasks: {
    status: "open" | "completed" | "dismissed";
    owner: { displayName: string; avatarUrl: string | null; userId: string } | null;
    updatedAt: string;
    completedAt: string | null;
    workspaceId: string;
    title: string;
    position: number;
    description: string | null;
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    revision: number;
    taskId: string;
    sourceType: "meeting" | "workspace";
    sectionId: string;
    sourceId: string;
    /** @external existing wire contract */ editable: boolean;
    /** @external existing wire contract */ reassignable: boolean;
    /** @external existing wire contract */ deletable: boolean;
    /** @external existing wire contract */ reorderable: boolean;
    isMine: boolean;
    placementRevision: number;
    sourceMeeting: { id: string; title: string; startedAt: string | null; endedAt: string | null } | null;
    viewerWorkspaceId?: string | undefined;
  }[];
}>;

function collectWorkspaceBoardAssignedTasks(args: {
  meetingRows: { task: Prisma.meetingTasksModel; meeting: Prisma.meetingsModel }[];
  workspaceRows: Prisma.workspaceTasksModel[];
  placementByKey: Map<string, Prisma.assignedTaskPlacementsModel>;
  sectionPositionById: Map<string, number>;
}) {
  const { meetingRows, workspaceRows, placementByKey, sectionPositionById } = args;
  const collectedTasks: { tasks: UnifiedAssignedTask[] } = { tasks: [] };
  meetingRows.forEach((row) => {
    const task = parseMeetingTaskRow(row.task);
    if (task.status === "dismissed") {
      return;
    }
    const placement = placementByKey.get(`meeting:${task.id}`);
    if (!placement) {
      return;
    }
    collectedTasks.tasks = collectedTasks.tasks.concat(
      unifiedAssignedTaskSchema.parse({
        sourceType: "meeting",
        sourceId: row.meeting.id,
        taskId: task.id,
        workspaceId: row.meeting.workspaceId,
        /** @external existing wire contract */ editable: true,
        /** @external existing wire contract */ reassignable: true,
        /** @external existing wire contract */ deletable: true,
        /** @external existing wire contract */ reorderable: true,
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate,
        sectionId: placement.sectionId,
        position: placement.position,
        revision: task.revision,
        placementRevision: placement.revision,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        sourceMeeting: {
          id: row.meeting.id,
          title: row.meeting.title,
          startedAt: row.meeting.startedAt?.toISOString() ?? null,
          endedAt: row.meeting.endedAt?.toISOString() ?? null,
        },
      }),
    );
  });

  workspaceRows.forEach((row) => {
    const task = parseWorkspaceTaskRow(row);
    if (task.status === "dismissed") {
      return;
    }
    const placement = placementByKey.get(`workspace:${task.id}`);
    if (!placement) {
      return;
    }
    collectedTasks.tasks = collectedTasks.tasks.concat(
      unifiedAssignedTaskSchema.parse({
        sourceType: "workspace",
        sourceId: task.id,
        taskId: task.id,
        workspaceId: task.workspaceId,
        /** @external existing wire contract */ editable: true,
        /** @external existing wire contract */ reassignable: true,
        /** @external existing wire contract */ deletable: true,
        /** @external existing wire contract */ reorderable: true,
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate,
        sectionId: placement.sectionId,
        position: placement.position,
        revision: task.revision,
        placementRevision: placement.revision,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        sourceMeeting: null,
      }),
    );
  });

  const unifiedTasks = [...collectedTasks.tasks].sort((first, second) => {
    const sectionDelta =
      (sectionPositionById.get(first.sectionId) ?? 0) - (sectionPositionById.get(second.sectionId) ?? 0);
    if (sectionDelta !== 0) {
      return sectionDelta;
    }
    const positionDelta = first.position - second.position;
    if (positionDelta !== 0) {
      return positionDelta;
    }

    return first.updatedAt.localeCompare(second.updatedAt);
  });

  return unifiedTasks;
}
const selectHoist7243: Prisma.meetingTasksSelect = {
  id: true,
  meetingId: true,
  taskListId: true,
  position: true,
  title: true,
  description: true,
  type: true,
  ownerName: true,
  ownerEmail: true,
  ownerConfidence: true,
  dueDateValue: true,
  dueDateConfidence: true,
  confidence: true,
  sourceQuotes: true,
  sourceReason: true,
  status: true,
  createdFrom: true,
  externalLinks: true,
  createdAt: true,
  updatedAt: true,
  workKind: true,
  ownerUserId: true,
  revision: true,
  completedAt: true,
  assetIds: true,
  origin: true,
  statusSource: true,
  statusActorUserId: true,
  statusChangedAt: true,
  actionConfirmableAt: true,
  detectedAt: true,
  firstRenderedAt: true,
  firstRenderedReportedAt: true,
  realtimeReceivedAt: true,
  refetchStartedAt: true,
  refetchCompletedAt: true,
  meetings: true,
};

export async function listWorkspaceAssignedTasksForUser(input: {
  userId: string;
  workspaceId: string;
}): ListWorkspaceAssignedTasksForUserResult {
  const sections = await listWorkspaceTaskSections({
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
  });

  const [loadedMeetingRows, workspaceRows] = await Promise.all([
    mapRow({
      value: db.meetingTasks.findMany({
        where: whereAnd([
          { meetingTaskLists: { status: "completed" } },
          { meetings: { workspaceId: input.workspaceId } },
          { ownerUserId: input.userId },
          { meetings: { hiddenFromHistoryAt: null } },
          { status: { not: "dismissed" } },
        ]),
        select: selectHoist7243,
      }),
      map: (rows) =>
        rows.map((row) => ({
          task: readStoredMeetingTask(row),
          meeting: readStoredMeeting(row.meetings),
        })),
    }),
    mapRow({
      value: db.workspaceTasks.findMany({
        where: whereAnd([
          { workspaceId: input.workspaceId },
          whereOr([{ assigneeUserId: input.userId }, { assigneeUserId: null }]),
          { status: { not: "dismissed" } },
        ]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
          status: meetingTaskStatusSchema.parse(row.status),
        })),
    }),
  ]);

  const meetingRows = await visibleMeetingTaskRows({ userId: input.userId, rows: loadedMeetingRows });

  await ensureAssignedTaskPlacements({
    workspaceId: input.workspaceId,
    assigneeUserId: input.userId,
    actorUserId: input.userId,
    tasks: [
      ...meetingRows.map((row) => ({ sourceType: "meeting" as const, sourceTaskId: row.task.id })),
      ...workspaceRows.map((row) => ({ sourceType: "workspace" as const, sourceTaskId: row.id })),
    ],
  });

  const sourceTaskIds = [...meetingRows.map((row) => row.task.id), ...workspaceRows.map((row) => row.id)];
  const placementRows =
    sourceTaskIds.length !== 0
      ? await mapRow({
          value: db.assignedTaskPlacements.findMany({
            where: whereAnd([
              { workspaceId: input.workspaceId },
              { assigneeUserId: input.userId },
              { sourceTaskId: { in: sourceTaskIds } },
            ]),
          }),
          map: (rows) =>
            rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
        })
      : [];
  const placementByKey = new Map(placementRows.map((row) => [`${row.sourceType}:${row.sourceTaskId}`, row]));
  const sectionPositionById = new Map(sections.map((section) => [section.id, section.position]));

  const unifiedTasks = collectWorkspaceBoardAssignedTasks({
    meetingRows,
    workspaceRows,
    placementByKey,
    sectionPositionById,
  });

  return {
    sections,
    tasks: unifiedTasks,
  };
}
const selectHoist7780: Prisma.meetingTasksSelect = {
  id: true,
  meetingId: true,
  taskListId: true,
  position: true,
  title: true,
  description: true,
  type: true,
  ownerName: true,
  ownerEmail: true,
  ownerConfidence: true,
  dueDateValue: true,
  dueDateConfidence: true,
  confidence: true,
  sourceQuotes: true,
  sourceReason: true,
  status: true,
  createdFrom: true,
  externalLinks: true,
  createdAt: true,
  updatedAt: true,
  workKind: true,
  ownerUserId: true,
  revision: true,
  completedAt: true,
  assetIds: true,
  origin: true,
  statusSource: true,
  statusActorUserId: true,
  statusChangedAt: true,
  actionConfirmableAt: true,
  detectedAt: true,
  firstRenderedAt: true,
  firstRenderedReportedAt: true,
  realtimeReceivedAt: true,
  refetchStartedAt: true,
  refetchCompletedAt: true,
  meetings: true,
  usersMeetingTasksOwnerUserIdTousers: { select: { id: true, displayName: true, avatarUrl: true } },
};

const selectHoist7685: Prisma.meetingTasksSelect = {
  id: true,
  meetingId: true,
  taskListId: true,
  position: true,
  title: true,
  description: true,
  type: true,
  ownerName: true,
  ownerEmail: true,
  ownerConfidence: true,
  dueDateValue: true,
  dueDateConfidence: true,
  confidence: true,
  sourceQuotes: true,
  sourceReason: true,
  status: true,
  createdFrom: true,
  externalLinks: true,
  createdAt: true,
  updatedAt: true,
  workKind: true,
  ownerUserId: true,
  revision: true,
  completedAt: true,
  assetIds: true,
  origin: true,
  statusSource: true,
  statusActorUserId: true,
  statusChangedAt: true,
  actionConfirmableAt: true,
  detectedAt: true,
  firstRenderedAt: true,
  firstRenderedReportedAt: true,
  realtimeReceivedAt: true,
  refetchStartedAt: true,
  refetchCompletedAt: true,
  meetings: true,
};

async function loadPersonalAssignedTaskSourceRows(args: { userId: string; workspaceIds: string[] }) {
  return Promise.all([
    mapRow({
      value: db.meetingTasks.findMany({
        where: whereAnd([
          { meetingTaskLists: { status: "completed" } },
          { ownerUserId: args.userId },
          { meetings: { hiddenFromHistoryAt: null } },
          { status: { not: "dismissed" } },
        ]),
        select: selectHoist7685,
      }),
      map: (rows) =>
        rows.map((row) => ({
          task: readStoredMeetingTask(row),
          meeting: readStoredMeeting(row.meetings),
        })),
    }),
    mapRow({
      value: db.meetingTasks.findMany({
        where: whereAnd([
          { meetingTaskLists: { status: "completed" } },
          whereOr([{ ownerUserId: null }, { ownerUserId: { not: args.userId } }]),
          { meetings: { hiddenFromHistoryAt: null } },
          { meetings: { kind: { not: "agent_intro" } } },
          { status: { not: "dismissed" } },
        ]),
        select: selectHoist7780,
      }),
      map: (rows) =>
        rows.map((row) => ({
          task: readStoredMeetingTask(row),
          meeting: readStoredMeeting(row.meetings),
          ownerUserId: row.usersMeetingTasksOwnerUserIdTousers?.id ?? null,
          ownerDisplayName: row.usersMeetingTasksOwnerUserIdTousers?.displayName ?? null,
          ownerAvatarUrl: row.usersMeetingTasksOwnerUserIdTousers?.avatarUrl ?? null,
        })),
    }),
    mapRow({
      value: db.workspaceTasks.findMany({
        where: whereAnd([
          { assigneeUserId: args.userId },
          { workspaceId: { in: args.workspaceIds } },
          { status: { not: "dismissed" } },
        ]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
          status: meetingTaskStatusSchema.parse(row.status),
        })),
    }),
    mapRow({
      value: db.workspaceTasks.findMany({
        where: whereAnd([
          whereOr([{ assigneeUserId: null }, { assigneeUserId: { not: args.userId } }]),
          { workspaceId: { in: args.workspaceIds } },
          { status: { not: "dismissed" } },
        ]),
        select: {
          id: true,
          workspaceId: true,
          createdByUserId: true,
          updatedByUserId: true,
          assigneeUserId: true,
          title: true,
          description: true,
          dueDateValue: true,
          dueDateConfidence: true,
          status: true,
          revision: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
          usersWorkspaceTasksAssigneeUserIdTousers: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      }),
      map: (rows) =>
        rows.map((row) => ({
          task: {
            ...row,
            dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
            status: meetingTaskStatusSchema.parse(row.status),
          },
          ownerUserId: row.usersWorkspaceTasksAssigneeUserIdTousers?.id ?? null,
          ownerDisplayName: row.usersWorkspaceTasksAssigneeUserIdTousers?.displayName ?? null,
          ownerAvatarUrl: row.usersWorkspaceTasksAssigneeUserIdTousers?.avatarUrl ?? null,
        })),
    }),
  ]);
}

async function queryPersonalAssignedTaskRows(args: { userId: string; workspaceIds: string[] }) {
  const [mineMeetingRows, otherMeetingRows, mineWorkspaceRows, otherWorkspaceRows] =
    await loadPersonalAssignedTaskSourceRows(args);
  const scope = await loadPersonalMeetingScope({
    userId: args.userId,
    workspaceIds: args.workspaceIds,
    meetings: [...mineMeetingRows, ...otherMeetingRows].map((row) => row.meeting),
  });
  const visibleMineMeetings = mineMeetingRows.flatMap((row) => {
    if (
      !personalMeetingRowAllowed({ task: row.task, meeting: row.meeting, scope, shouldRequireNotesVisibility: true })
    ) {
      return [];
    }

    return [{ ...row, viewerWorkspaceId: viewerWorkspaceIdForMeeting({ meeting: row.meeting, scope }) }];
  });
  const visibleOtherMeetings = otherMeetingRows.flatMap((row) => {
    if (!otherPersonalMeetingAllowed({ task: row.task, meeting: row.meeting, scope })) {
      return [];
    }

    return [
      {
        ...row,
        viewerWorkspaceId: viewerWorkspaceIdForMeeting({ meeting: row.meeting, scope }),
        /** @external personal task response */ viewerCanReassign:
          scope.participantMeetingIds.has(row.meeting.id) || row.meeting.createdByUserId === args.userId,
      },
    ];
  });
  const visibleMineWorkspace = mineWorkspaceRows.filter((row) =>
    personalTaskIsUncleared({
      status: row.status,
      completedAt: row.completedAt,
      updatedAt: row.updatedAt,
      workspaceId: row.workspaceId,
      sourceType: "workspace",
      taskId: row.id,
      clearances: scope.clearances,
    }),
  );
  const visibleOtherWorkspace = otherWorkspaceRows.filter((row) =>
    personalTaskIsUncleared({
      status: row.task.status,
      completedAt: row.task.completedAt,
      updatedAt: row.task.updatedAt,
      workspaceId: row.task.workspaceId,
      sourceType: "workspace",
      taskId: row.task.id,
      clearances: scope.clearances,
    }),
  );

  return [visibleMineMeetings, visibleMineWorkspace, visibleOtherMeetings, visibleOtherWorkspace] as const;
}

async function ensurePersonalAssignedTaskPlacements(args: {
  userId: string;
  meetingRows: { task: Prisma.meetingTasksModel; viewerWorkspaceId: string }[];
  workspaceRows: Prisma.workspaceTasksModel[];
}) {
  const tasksByWorkspace = new Map<string, { sourceType: "meeting" | "workspace"; sourceTaskId: string }[]>();
  args.meetingRows.forEach((row) => {
    const tasks = tasksByWorkspace.get(row.viewerWorkspaceId) ?? [];
    tasksByWorkspace.set(row.viewerWorkspaceId, tasks.concat({ sourceType: "meeting", sourceTaskId: row.task.id }));
  });
  args.workspaceRows.forEach((row) => {
    const tasks = tasksByWorkspace.get(row.workspaceId) ?? [];
    tasksByWorkspace.set(row.workspaceId, tasks.concat({ sourceType: "workspace", sourceTaskId: row.id }));
  });

  await Promise.all(
    Array.from(tasksByWorkspace.entries()).map(([workspaceId, tasks]) =>
      ensureAssignedTaskPlacements({
        workspaceId,
        assigneeUserId: args.userId,
        actorUserId: args.userId,
        tasks,
      }),
    ),
  );
}

async function loadPersonalAssignedTaskPlacementByKey(args: {
  userId: string;
  workspaceIds: string[];
  meetingRows: { task: Prisma.meetingTasksModel }[];
  workspaceRows: Prisma.workspaceTasksModel[];
}) {
  const sourceTaskIds = [...args.meetingRows.map((row) => row.task.id), ...args.workspaceRows.map((row) => row.id)];
  const placementRows =
    sourceTaskIds.length !== 0
      ? await mapRow({
          value: db.assignedTaskPlacements.findMany({
            where: whereAnd([
              { assigneeUserId: args.userId },
              { workspaceId: { in: args.workspaceIds } },
              { sourceTaskId: { in: sourceTaskIds } },
            ]),
          }),
          map: (rows) =>
            rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
        })
      : [];

  return new Map(placementRows.map((row) => [`${row.sourceType}:${row.sourceTaskId}:${row.workspaceId}`, row]));
}

function personalAssignedTaskOwnerFromJoin(args: {
  ownerUserId: string | null;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
}) {
  return args.ownerUserId !== null && args.ownerUserId !== ""
    ? {
        userId: args.ownerUserId,
        displayName: args.ownerDisplayName ?? "Member",
        avatarUrl: args.ownerAvatarUrl ?? null,
      }
    : null;
}

function collectPersonalMineAssignedTasks(args: {
  meetingRows: {
    task: Prisma.meetingTasksModel;
    meeting: Prisma.meetingsModel;
    viewerWorkspaceId: string;
  }[];
  workspaceRows: Prisma.workspaceTasksModel[];
  placementByKey: Map<string, Prisma.assignedTaskPlacementsModel>;
}) {
  const collectedTasks: { tasks: UnifiedAssignedTask[] } = { tasks: [] };
  args.meetingRows.forEach((row) => {
    const task = parseMeetingTaskRow(row.task);
    const placement = args.placementByKey.get(`meeting:${task.id}:${row.viewerWorkspaceId}`);
    if (!placement) {
      return;
    }
    collectedTasks.tasks = collectedTasks.tasks.concat(
      unifiedAssignedTaskSchema.parse({
        sourceType: "meeting",
        sourceId: row.meeting.id,
        taskId: task.id,
        workspaceId: row.meeting.workspaceId,
        viewerWorkspaceId: row.viewerWorkspaceId,
        /** @external existing wire contract */ editable: true,
        /** @external existing wire contract */ reassignable: true,
        /** @external existing wire contract */ deletable: true,
        /** @external existing wire contract */ reorderable: false,
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate,
        sectionId: placement.sectionId,
        position: placement.position,
        revision: task.revision,
        placementRevision: placement.revision,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        sourceMeeting: {
          id: row.meeting.id,
          title: row.meeting.title,
          startedAt: row.meeting.startedAt?.toISOString() ?? null,
          endedAt: row.meeting.endedAt?.toISOString() ?? null,
        },
      }),
    );
  });
  args.workspaceRows.forEach((row) => {
    const task = parseWorkspaceTaskRow(row);
    const placement = args.placementByKey.get(`workspace:${task.id}:${task.workspaceId}`);
    if (!placement) {
      return;
    }
    collectedTasks.tasks = collectedTasks.tasks.concat(
      unifiedAssignedTaskSchema.parse({
        sourceType: "workspace",
        sourceId: task.id,
        taskId: task.id,
        workspaceId: task.workspaceId,
        /** @external existing wire contract */ editable: true,
        /** @external existing wire contract */ reassignable: true,
        /** @external existing wire contract */ deletable: true,
        /** @external existing wire contract */ reorderable: false,
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate,
        sectionId: placement.sectionId,
        position: placement.position,
        revision: task.revision,
        placementRevision: placement.revision,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        sourceMeeting: null,
      }),
    );
  });

  return collectedTasks.tasks;
}

function collectPersonalOthersAssignedTasks(args: {
  otherWorkspaceRows: {
    task: Prisma.workspaceTasksModel;
    ownerUserId: string | null;
    ownerDisplayName: string | null;
    ownerAvatarUrl: string | null;
  }[];
  otherMeetingRows: {
    task: Prisma.meetingTasksModel;
    meeting: Prisma.meetingsModel;
    viewerWorkspaceId: string;
    /** @external existing wire contract */
    viewerCanReassign: boolean;
    ownerUserId: string | null;
    ownerDisplayName: string | null;
    ownerAvatarUrl: string | null;
  }[];
}) {
  const collectedTasks: { tasks: UnifiedAssignedTask[] } = { tasks: [] };
  args.otherWorkspaceRows.forEach((row) => {
    const task = parseWorkspaceTaskRow(row.task);
    collectedTasks.tasks = collectedTasks.tasks.concat(
      unifiedAssignedTaskSchema.parse({
        sourceType: "workspace",
        sourceId: task.id,
        taskId: task.id,
        workspaceId: task.workspaceId,
        /** @external existing wire contract */ editable: true,
        /** @external existing wire contract */ reassignable: true,
        /** @external existing wire contract */ deletable: true,
        /** @external existing wire contract */ reorderable: false,
        isMine: false,
        owner: personalAssignedTaskOwnerFromJoin(row),
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate,
        sectionId: UNPLACED_ASSIGNED_TASK_SECTION_ID,
        position: 0,
        revision: task.revision,
        placementRevision: 1,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        sourceMeeting: null,
      }),
    );
  });
  args.otherMeetingRows.forEach((row) => {
    const task = parseMeetingTaskRow(row.task);
    collectedTasks.tasks = collectedTasks.tasks.concat(
      unifiedAssignedTaskSchema.parse({
        sourceType: "meeting",
        sourceId: row.meeting.id,
        taskId: task.id,
        workspaceId: row.meeting.workspaceId,
        viewerWorkspaceId: row.viewerWorkspaceId,
        /** @external existing wire contract */ editable: false,
        /** @external existing wire contract */ reassignable: row.viewerCanReassign,
        /** @external existing wire contract */ deletable: false,
        /** @external existing wire contract */ reorderable: false,
        isMine: false,
        owner: personalAssignedTaskOwnerFromJoin(row),
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate,
        sectionId: UNPLACED_ASSIGNED_TASK_SECTION_ID,
        position: 0,
        revision: task.revision,
        placementRevision: 1,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        sourceMeeting: {
          id: row.meeting.id,
          title: row.meeting.title,
          startedAt: row.meeting.startedAt?.toISOString() ?? null,
          endedAt: row.meeting.endedAt?.toISOString() ?? null,
        },
      }),
    );
  });

  return collectedTasks.tasks;
}

function sortPersonalAssignedTasks(tasks: UnifiedAssignedTask[]) {
  return [...tasks].sort((first, second) => {
    const updatedAtDelta = second.updatedAt.localeCompare(first.updatedAt);
    if (updatedAtDelta !== 0) {
      return updatedAtDelta;
    }

    return first.title.localeCompare(second.title);
  });
}

async function loadPersonalAssignedTaskSourceMeetings(args: {
  userId: string;
  workspaceIds: string[];
  unifiedTasks: UnifiedAssignedTask[];
}) {
  const sourceMeetingIds = [
    ...new Set(args.unifiedTasks.filter((task) => task.sourceType === "meeting").map((task) => task.sourceId)),
  ];
  if (sourceMeetingIds.length === 0) {
    return [];
  }

  const meetingRows = await mapRow({
    value: db.meetings.findMany({
      where: whereAnd([{ id: { in: sourceMeetingIds } }, { hiddenFromHistoryAt: null }]),
    }),
    map: (rows) => rows.map((row) => readStoredMeeting(row)),
  });
  const scope = await loadPersonalMeetingScope({
    userId: args.userId,
    workspaceIds: args.workspaceIds,
    meetings: meetingRows,
  });
  const visibleMeetings = meetingRows.filter((meeting) => {
    const viewerWorkspaceId = viewerWorkspaceIdForMeeting({ meeting, scope });
    if (!scope.workspaceIds.has(viewerWorkspaceId) || scope.suspendedHostWorkspaceIds.has(meeting.workspaceId)) {
      return false;
    }

    return meetingTaskIsVisible({
      meeting,
      userId: args.userId,
      participantMeetingIds: scope.participantMeetingIds,
      entitledEndedMeetingIds: scope.entitledEndedMeetingIds,
    });
  });
  if (visibleMeetings.length === 0) {
    return [];
  }

  const participantRows = await mapRow({
    value: db.meetingParticipants.findMany({
      where: whereAnd([
        { meetingId: { in: visibleMeetings.map((meeting) => meeting.id) } },
        { role: { in: ["host", "guest"] } },
        { users: { deletedAt: null } },
      ]),
      select: {
        meetingId: true,
        users: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        meetingId: row.meetingId,
        userId: row.users.id,
        displayName: row.users.displayName,
        avatarUrl: row.users.avatarUrl,
      })),
  });
  const participantsByMeeting = new Map<string, { userId: string; displayName: string; avatarUrl: string | null }[]>();
  participantRows.forEach((row) => {
    const participants = participantsByMeeting.get(row.meetingId) ?? [];
    participantsByMeeting.set(row.meetingId, [
      ...participants,
      { userId: row.userId, displayName: row.displayName, avatarUrl: row.avatarUrl },
    ]);
  });

  return visibleMeetings.map((meeting) => ({
    id: meeting.id,
    workspaceId: meeting.workspaceId,
    createdByUserId: meeting.createdByUserId,
    kind: meeting.kind,
    isConfidential: meeting.isConfidential,
    participants: (participantsByMeeting.get(meeting.id) ?? []).toSorted((first, second) => {
      const nameDelta = first.displayName.localeCompare(second.displayName);
      if (nameDelta !== 0) {
        return nameDelta;
      }

      return first.userId.localeCompare(second.userId);
    }),
  }));
}

type ListPersonalAssignedTasksForUserResult = Promise<{
  tasks: {
    status: "open" | "completed" | "dismissed";
    owner: { displayName: string; avatarUrl: string | null; userId: string } | null;
    updatedAt: string;
    completedAt: string | null;
    workspaceId: string;
    title: string;
    position: number;
    description: string | null;
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    revision: number;
    taskId: string;
    sourceType: "meeting" | "workspace";
    sectionId: string;
    sourceId: string;
    /** @external existing wire contract */ editable: boolean;
    /** @external existing wire contract */ reassignable: boolean;
    /** @external existing wire contract */ deletable: boolean;
    /** @external existing wire contract */ reorderable: boolean;
    isMine: boolean;
    placementRevision: number;
    sourceMeeting: { id: string; title: string; startedAt: string | null; endedAt: string | null } | null;
    viewerWorkspaceId?: string | undefined;
  }[];
  sourceMeetings: {
    id: string;
    workspaceId: string;
    createdByUserId: string;
    kind: MeetingKind;
    isConfidential: boolean;
    participants: { userId: string; displayName: string; avatarUrl: string | null }[];
  }[];
}>;

export async function listPersonalAssignedTasksForUser(input: {
  userId: string;
}): ListPersonalAssignedTasksForUserResult {
  const workspaceIds = await listWorkspaceIdsForUser(input.userId);
  if (workspaceIds.length === 0) {
    return { tasks: [], sourceMeetings: [] };
  }

  const [meetingRows, workspaceRows, otherMeetingRows, otherWorkspaceRows] = await queryPersonalAssignedTaskRows({
    userId: input.userId,
    workspaceIds,
  });
  await ensurePersonalAssignedTaskPlacements({ userId: input.userId, meetingRows, workspaceRows });
  const placementByKey = await loadPersonalAssignedTaskPlacementByKey({
    userId: input.userId,
    workspaceIds,
    meetingRows,
    workspaceRows,
  });
  const mineTasks = collectPersonalMineAssignedTasks({ meetingRows, workspaceRows, placementByKey });
  const otherTasks = collectPersonalOthersAssignedTasks({ otherMeetingRows, otherWorkspaceRows });
  const unifiedTasks = sortPersonalAssignedTasks(mineTasks.concat(otherTasks));
  const sourceMeetings = await loadPersonalAssignedTaskSourceMeetings({
    userId: input.userId,
    workspaceIds,
    unifiedTasks,
  });

  return { tasks: unifiedTasks, sourceMeetings };
}

function workspaceTaskRealtimeEvent(input: {
  workspaceId: string;
  userId: string;
  eventName: TaskRealtimeEventName;
  taskId?: string | null;
  sectionId?: string | null;
  revision?: number | null;
  placementRevision?: number | null;
  actorUserId?: string | null;
  dedupeSuffix: string;
}): RealtimeOutboxEventInput {
  return {
    channel: userTasksRealtimeChannel({
      workspaceId: input.workspaceId,
      userId: input.userId,
    }),
    eventName: input.eventName,
    payload: buildTaskRealtimePayload({
      eventName: input.eventName,
      workspaceId: input.workspaceId,
      taskId: input.taskId ?? null,
      sourceType: input.taskId !== undefined && input.taskId !== null && input.taskId !== "" ? "workspace" : undefined,
      sourceTaskId: input.taskId ?? null,
      sectionId: input.sectionId ?? null,
      revision: input.revision ?? null,
      placementRevision: input.placementRevision ?? null,
      actorUserId: input.actorUserId ?? null,
    }),
    dedupeKey: `workspace:${input.workspaceId}:user:${input.userId}:${input.eventName}:${input.dedupeSuffix}`,
  };
}

function workspaceTaskBroadcastRealtimeEvent(
  input: Omit<Parameters<typeof workspaceTaskRealtimeEvent>[0], "userId">,
): RealtimeOutboxEventInput {
  return {
    channel: workspaceTasksRealtimeChannel({ workspaceId: input.workspaceId }),
    eventName: input.eventName,
    payload: buildTaskRealtimePayload({
      eventName: input.eventName,
      workspaceId: input.workspaceId,
      taskId: input.taskId ?? null,
      sourceType: input.taskId !== undefined && input.taskId !== null && input.taskId !== "" ? "workspace" : undefined,
      sourceTaskId: input.taskId ?? null,
      sectionId: input.sectionId ?? null,
      revision: input.revision ?? null,
      placementRevision: input.placementRevision ?? null,
      actorUserId: input.actorUserId ?? null,
    }),
    dedupeKey: `workspace:${input.workspaceId}:tasks:${input.eventName}:${input.dedupeSuffix}`,
  };
}

function userTaskRealtimeEvents(input: Parameters<typeof workspaceTaskRealtimeEvent>[0]): RealtimeOutboxEventInput[] {
  return [workspaceTaskRealtimeEvent(input)];
}

type CreateWorkspaceTaskResult = Promise<{
  status: "open" | "completed" | "dismissed";
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  createdByUserId: string | null;
  workspaceId: string;
  title: string;
  description: string | null;
  dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
  revision: number;
  updatedByUserId: string | null;
  assigneeUserId: string | null;
}>;

async function resolveWorkspaceTaskTargetSectionWithin(args: {
  input: {
    workspaceId: string;
    actorUserId: string;
    sectionId?: string | null;
  };
}) {
  const { input } = args;
  const [section] =
    input.sectionId !== undefined && input.sectionId !== null && input.sectionId !== ""
      ? await db.workspaceTaskSections.findMany({
          where: whereAnd([{ id: input.sectionId }, { workspaceId: input.workspaceId }, { deletedAt: null }]),
          take: 1,
        })
      : await db.workspaceTaskSections.findMany({
          where: whereAnd([{ workspaceId: input.workspaceId }, { isDefault: true }, { deletedAt: null }]),
          take: 1,
        });

  if (input.sectionId !== undefined && input.sectionId !== null && input.sectionId !== "" && !section) {
    throw new Error(TASK_SECTION_NOT_FOUND_MESSAGE);
  }

  const [createdTargetSection] = section
    ? []
    : await mapRow({
        value: createIgnoringUniqueConflict(() =>
          db.workspaceTaskSections.create({
            data: {
              workspaceId: input.workspaceId,
              title: "Inbox",
              position: 0,
              isDefault: true,
              createdByUserId: input.actorUserId,
              updatedByUserId: input.actorUserId,
            },
          }),
        ),
        map: (row) => (row === undefined ? [] : [row]),
      });
  const [reloadedTargetSection] =
    section || createdTargetSection
      ? []
      : await db.workspaceTaskSections.findMany({
          where: whereAnd([{ workspaceId: input.workspaceId }, { isDefault: true }, { deletedAt: null }]),
          take: 1,
        });
  const targetSection = section ?? createdTargetSection ?? reloadedTargetSection;

  if (!targetSection) {
    throw new Error(TASK_SECTION_NOT_FOUND_MESSAGE);
  }

  return targetSection;
}

function workspaceTaskAssigneePlacementInsertIndex(args: {
  sectionRows: Prisma.assignedTaskPlacementsModel[];
  beforeTaskId?: string | null;
  afterTaskId?: string | null;
}) {
  const { sectionRows, beforeTaskId, afterTaskId } = args;
  if (beforeTaskId !== undefined && beforeTaskId !== null && beforeTaskId !== "") {
    const beforeIndex = sectionRows.findIndex((row) => row.sourceTaskId === beforeTaskId);
    if (beforeIndex < 0) {
      throw new Error(ANCHOR_TASK_NOT_FOUND_MESSAGE);
    }

    return beforeIndex;
  }
  if (afterTaskId !== undefined && afterTaskId !== null && afterTaskId !== "") {
    const afterIndex = sectionRows.findIndex((row) => row.sourceTaskId === afterTaskId);
    if (afterIndex < 0) {
      throw new Error(ANCHOR_TASK_NOT_FOUND_MESSAGE);
    }

    return afterIndex + 1;
  }

  return 0;
}

async function insertWorkspaceTaskAssigneePlacementWithin(args: {
  input: {
    workspaceId: string;
    actorUserId: string;
    beforeTaskId?: string | null;
    afterTaskId?: string | null;
  };
  assigneeUserId: string;
  targetSection: Prisma.workspaceTaskSectionsModel;
  task: Prisma.workspaceTasksModel;
}) {
  const { input, assigneeUserId, targetSection, task } = args;
  const sectionRows = await mapRow({
    value: db.assignedTaskPlacements.findMany({
      where: whereAnd([{ workspaceId: input.workspaceId }, { assigneeUserId }, { sectionId: targetSection.id }]),
      orderBy: [{ position: "asc" }, { updatedAt: "asc" }],
    }),
    map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
  });
  const insertIndex = workspaceTaskAssigneePlacementInsertIndex({
    sectionRows,
    beforeTaskId: input.beforeTaskId,
    afterTaskId: input.afterTaskId,
  });
  await mapRowsSequentially({
    rows: await mapRow({
      value: db.assignedTaskPlacements.findMany({
        where: whereAnd([
          { workspaceId: input.workspaceId },
          { assigneeUserId },
          { sectionId: targetSection.id },
          { position: { gte: insertIndex } },
        ]),
      }),
      map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.assignedTaskPlacements.updateManyAndReturn({
          where: whereAnd([
            { sourceType: storedRow.sourceType },
            { sourceTaskId: storedRow.sourceTaskId },
            { workspaceId: storedRow.workspaceId },
            { assigneeUserId: storedRow.assigneeUserId },
          ]),
          data: {
            position: storedRow.position + 1,
            revision: storedRow.revision + 1,
            updatedByUserId: input.actorUserId,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
      });

      return updatedRows[0];
    },
  });
  const placement = await mapRow({
    value: db.assignedTaskPlacements.create({
      data: {
        sourceType: "workspace",
        sourceTaskId: task.id,
        workspaceId: input.workspaceId,
        assigneeUserId,
        sectionId: targetSection.id,
        position: insertIndex,
        updatedByUserId: input.actorUserId,
      },
    }),
    map: (row) => ({
      ...row,
      sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType),
    }),
  });
  const revision = placement.revision;

  return {
    revision,
    events: userTaskRealtimeEvents({
      workspaceId: input.workspaceId,
      userId: assigneeUserId,
      eventName: "workspace.task.created",
      taskId: task.id,
      sectionId: targetSection.id,
      revision: task.revision,
      placementRevision: revision,
      actorUserId: input.actorUserId,
      dedupeSuffix: `task:${task.id}:created:${task.revision}`,
    }),
  };
}

async function publishCreateWorkspaceTaskRealtimeWithin(args: {
  input: { workspaceId: string; actorUserId: string };
  task: Prisma.workspaceTasksModel;
  targetSection: Prisma.workspaceTaskSectionsModel;
  assigneePlacement: { revision: number; events: RealtimeOutboxEventInput[] } | null;
}) {
  const { input, task, targetSection, assigneePlacement } = args;
  const placementRevision = assigneePlacement?.revision ?? null;
  const events = [
    ...(assigneePlacement?.events ?? []),
    workspaceTaskBroadcastRealtimeEvent({
      workspaceId: input.workspaceId,
      eventName: "workspace.task.created",
      taskId: task.id,
      sectionId: targetSection.id,
      revision: task.revision,
      placementRevision,
      actorUserId: input.actorUserId,
      dedupeSuffix: `task:${task.id}:created:${task.revision}`,
    }),
  ];
  await publishRealtimeEvents(events);
}

async function insertWorkspaceTaskRowWithin(args: {
  input: {
    workspaceId: string;
    actorUserId: string;
    title?: string;
    description?: string | null;
    assigneeUserId?: string | null;
    dueDateValue?: string | null;
  };
  assigneeUserId: string | null;
}) {
  const { input, assigneeUserId } = args;
  const task = await mapRow({
    value: db.workspaceTasks.create({
      data: {
        workspaceId: input.workspaceId,
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
        assigneeUserId,
        title: (input.title?.trim() ?? "") !== "" ? (input.title?.trim() ?? "") : "New Task",
        description: input.description ?? null,
        dueDateValue: input.dueDateValue ?? null,
        dueDateConfidence:
          input.dueDateValue === undefined
            ? null
            : input.dueDateValue !== null && input.dueDateValue !== ""
              ? "high"
              : null,
        status: "open",
      },
    }),
    map: (row) => ({
      ...row,
      dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
      status: meetingTaskStatusSchema.parse(row.status),
    }),
  });

  return task;
}

const createWorkspaceTaskWithin = async (args: {
  input: {
    workspaceId: string;
    actorUserId: string;
    title?: string;
    description?: string | null;
    assigneeUserId?: string | null;
    dueDateValue?: string | null;
    sectionId?: string | null;
    beforeTaskId?: string | null;
    afterTaskId?: string | null;
  };
}) => {
  const { input } = args;

  if (
    input.beforeTaskId !== undefined &&
    input.beforeTaskId !== null &&
    input.beforeTaskId !== "" &&
    input.afterTaskId !== undefined &&
    input.afterTaskId !== null &&
    input.afterTaskId !== ""
  ) {
    throw new Error(ONLY_ONE_REORDER_ANCHOR_CAN_BE_PROVIDED_MESSAGE);
  }
  const assigneeUserId = input.assigneeUserId === undefined ? input.actorUserId : input.assigneeUserId;
  const targetSection = await resolveWorkspaceTaskTargetSectionWithin({ input });
  const task = await insertWorkspaceTaskRowWithin({ input, assigneeUserId });

  const assigneePlacement =
    assigneeUserId !== null && assigneeUserId !== ""
      ? await insertWorkspaceTaskAssigneePlacementWithin({
          input,
          assigneeUserId,
          targetSection,
          task,
        })
      : null;
  await publishCreateWorkspaceTaskRealtimeWithin({ input, task, targetSection, assigneePlacement });

  return task;
};

export async function createWorkspaceTask(input: {
  workspaceId: string;
  actorUserId: string;
  title?: string;
  description?: string | null;
  assigneeUserId?: string | null;
  dueDateValue?: string | null;
  sectionId?: string | null;
  beforeTaskId?: string | null;
  afterTaskId?: string | null;
}): CreateWorkspaceTaskResult {
  const row = await createWorkspaceTaskWithin({ input });

  return parseWorkspaceTaskRow(row);
}

type UpdateWorkspaceTaskResult = Promise<{
  status: "open" | "completed" | "dismissed";
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  createdByUserId: string | null;
  workspaceId: string;
  title: string;
  description: string | null;
  dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
  revision: number;
  updatedByUserId: string | null;
  assigneeUserId: string | null;
}>;

async function resolveWorkspaceTaskAssigneePlacementSectionIdWithin(args: {
  input: { workspaceId: string; taskId: string; sectionId?: string | null };
  nextAssigneeUserId: string;
  existingPlacement: Prisma.assignedTaskPlacementsModel | undefined;
}) {
  const { input, existingPlacement } = args;
  const requestedSectionId = input.sectionId ?? existingPlacement?.sectionId ?? null;
  if (requestedSectionId !== null && requestedSectionId !== "") {
    return requestedSectionId;
  }
  const defaultSection = await mapRow({
    value: db.workspaceTaskSections.findFirst({
      where: whereAnd([{ workspaceId: input.workspaceId }, { isDefault: true }, { deletedAt: null }]),
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return defaultSection?.id ?? null;
}

async function patchExistingWorkspaceTaskAssigneePlacementWithin(args: {
  input: {
    workspaceId: string;
    taskId: string;
    actorUserId: string;
    assigneeUserId?: string | null;
    sectionId?: string | null;
  };
  nextAssigneeUserId: string;
  existingPlacement: Prisma.assignedTaskPlacementsModel;
  sectionId: string;
}) {
  const { input, nextAssigneeUserId, existingPlacement, sectionId } = args;
  if (input.sectionId === undefined && input.assigneeUserId === undefined) {
    return { revision: existingPlacement.revision, sectionId };
  }

  const [placement] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.assignedTaskPlacements.findMany({
        where: whereAnd([
          { sourceType: "workspace" },
          { sourceTaskId: input.taskId },
          { workspaceId: input.workspaceId },
          { assigneeUserId: nextAssigneeUserId },
        ]),
      }),
      map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.assignedTaskPlacements.updateManyAndReturn({
          where: whereAnd([
            { sourceType: storedRow.sourceType },
            { sourceTaskId: storedRow.sourceTaskId },
            { workspaceId: storedRow.workspaceId },
            { assigneeUserId: storedRow.assigneeUserId },
          ]),
          data: {
            sectionId,
            revision: storedRow.revision + 1,
            updatedByUserId: input.actorUserId,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
      });

      return updatedRows[0];
    },
  });

  return { revision: placement === undefined ? null : placement.revision, sectionId };
}

async function insertWorkspaceTaskAssigneePlacementForUpdateWithin(args: {
  input: { workspaceId: string; taskId: string; actorUserId: string };
  nextAssigneeUserId: string;
  sectionId: string;
}) {
  const { input, nextAssigneeUserId, sectionId } = args;
  await mapRowsSequentially({
    rows: await mapRow({
      value: db.assignedTaskPlacements.findMany({
        where: whereAnd([{ workspaceId: input.workspaceId }, { assigneeUserId: nextAssigneeUserId }, { sectionId }]),
      }),
      map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.assignedTaskPlacements.updateManyAndReturn({
          where: whereAnd([
            { sourceType: storedRow.sourceType },
            { sourceTaskId: storedRow.sourceTaskId },
            { workspaceId: storedRow.workspaceId },
            { assigneeUserId: storedRow.assigneeUserId },
          ]),
          data: {
            position: storedRow.position + 1,
            revision: storedRow.revision + 1,
            updatedByUserId: input.actorUserId,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
      });

      return updatedRows[0];
    },
  });
  const placement = await mapRow({
    value: db.assignedTaskPlacements.create({
      data: {
        sourceType: "workspace",
        sourceTaskId: input.taskId,
        workspaceId: input.workspaceId,
        assigneeUserId: nextAssigneeUserId,
        sectionId,
        position: 0,
        updatedByUserId: input.actorUserId,
      },
    }),
    map: (row) => ({
      ...row,
      sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType),
    }),
  });

  return { revision: placement.revision, sectionId };
}

async function syncWorkspaceTaskAssigneePlacementWithin(args: {
  input: {
    workspaceId: string;
    taskId: string;
    actorUserId: string;
    assigneeUserId?: string | null;
    sectionId?: string | null;
  };
  nextAssigneeUserId: string;
}) {
  const { input, nextAssigneeUserId } = args;
  const existingPlacement = await mapRow({
    value: db.assignedTaskPlacements.findFirst({
      where: whereAnd([
        { sourceType: "workspace" },
        { sourceTaskId: input.taskId },
        { workspaceId: input.workspaceId },
        { assigneeUserId: nextAssigneeUserId },
      ]),
      take: 1,
    }),
    map: (row) =>
      row === null ? undefined : { ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) },
  });
  const sectionId = await resolveWorkspaceTaskAssigneePlacementSectionIdWithin({
    input,
    nextAssigneeUserId,
    existingPlacement,
  });
  if (sectionId === null || sectionId === "") {
    return { revision: null, sectionId: null };
  }
  if (existingPlacement) {
    return patchExistingWorkspaceTaskAssigneePlacementWithin({
      input,
      nextAssigneeUserId,
      existingPlacement,
      sectionId,
    });
  }

  return insertWorkspaceTaskAssigneePlacementForUpdateWithin({
    input,
    nextAssigneeUserId,
    sectionId,
  });
}

async function publishUpdateWorkspaceTaskRealtimeWithin(args: {
  input: { workspaceId: string; taskId: string; actorUserId: string };
  previous: Prisma.workspaceTasksModel;
  updated: Prisma.workspaceTasksModel;
  nextAssigneeUserId: string | null;
  placementRevision: number | null;
  sectionId: string | null;
}) {
  const { input, previous, updated, nextAssigneeUserId, placementRevision, sectionId } = args;
  const eventUserIds = [
    ...new Set([previous.assigneeUserId, nextAssigneeUserId].filter((userId): userId is string => Boolean(userId))),
  ];
  const events = [
    ...eventUserIds.flatMap((userId) =>
      userTaskRealtimeEvents({
        workspaceId: input.workspaceId,
        userId,
        eventName: updated.status === "dismissed" ? "workspace.task.deleted" : "workspace.task.updated",
        taskId: updated.id,
        sectionId,
        revision: updated.revision,
        placementRevision,
        actorUserId: input.actorUserId,
        dedupeSuffix: `task:${updated.id}:updated:${updated.revision}:${placementRevision ?? "none"}`,
      }),
    ),
    workspaceTaskBroadcastRealtimeEvent({
      workspaceId: input.workspaceId,
      eventName: updated.status === "dismissed" ? "workspace.task.deleted" : "workspace.task.updated",
      taskId: updated.id,
      sectionId,
      revision: updated.revision,
      placementRevision,
      actorUserId: input.actorUserId,
      dedupeSuffix: `task:${updated.id}:updated:${updated.revision}:${placementRevision ?? "none"}`,
    }),
  ];
  await publishRealtimeEvents(events);
}

const readStoredWorkspaceTask = (row: Prisma.workspaceTasksModel) => ({
  ...row,
  dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
  status: meetingTaskStatusSchema.parse(row.status),
});

const patchStoredWorkspaceTask = async (input: {
  storedRow: Prisma.workspaceTasksModel;
  title?: string;
  description?: string | null;
  assigneeUserId?: string | null;
  actorUserId: string;
  dueDateValue?: string | null;
  status?: MeetingTaskStatus;
  completedAt?: Date | null;
}) => {
  const updatedRows = await mapRow({
    value: db.workspaceTasks.updateManyAndReturn({
      where: { id: input.storedRow.id },
      data: {
        title: input.title,
        description: input.description,
        assigneeUserId: input.assigneeUserId,
        updatedByUserId: input.actorUserId,
        dueDateValue: input.dueDateValue,
        dueDateConfidence:
          input.dueDateValue === undefined
            ? undefined
            : input.dueDateValue !== null && input.dueDateValue !== ""
              ? "high"
              : null,
        status: input.status,
        completedAt: input.completedAt,
        revision: input.storedRow.revision + 1,
        updatedAt: new Date(),
      },
    }),
    map: (rows) => rows.map(readStoredWorkspaceTask),
  });

  return updatedRows[0];
};

const updateWorkspaceTaskWithin = async (args: {
  input: {
    workspaceId: string;
    taskId: string;
    actorUserId: string;
    title?: string;
    description?: string | null;
    assigneeUserId?: string | null;
    dueDateValue?: string | null;
    status?: MeetingTaskStatus;
    sectionId?: string | null;
  };
}) => {
  const { input } = args;

  const previous = await mapRow({
    value: db.workspaceTasks.findFirst({
      where: whereAnd([{ id: input.taskId }, { workspaceId: input.workspaceId }]),
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredWorkspaceTask(row)),
  });

  if (!previous) {
    return null;
  }

  const nextCompletedAt =
    input.status === undefined
      ? undefined
      : input.status === "completed"
        ? previous.status === "completed"
          ? (previous.completedAt ?? new Date())
          : new Date()
        : null;
  const nextAssigneeUserId = input.assigneeUserId === undefined ? previous.assigneeUserId : input.assigneeUserId;

  const [updated] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.workspaceTasks.findMany({
        where: whereAnd([{ id: input.taskId }, { workspaceId: input.workspaceId }]),
      }),
      map: (rows) => rows.map(readStoredWorkspaceTask),
    }),
    visit: async (storedRow) =>
      patchStoredWorkspaceTask({
        storedRow,
        title: input.title,
        description: input.description,
        assigneeUserId: input.assigneeUserId,
        actorUserId: input.actorUserId,
        dueDateValue: input.dueDateValue,
        status: input.status,
        completedAt: nextCompletedAt,
      }),
  });

  if (!updated) {
    return null;
  }

  const placementState =
    nextAssigneeUserId !== null && nextAssigneeUserId !== ""
      ? await syncWorkspaceTaskAssigneePlacementWithin({ input, nextAssigneeUserId })
      : { revision: null, sectionId: null };
  await publishUpdateWorkspaceTaskRealtimeWithin({
    input,
    previous,
    updated,
    nextAssigneeUserId,
    placementRevision: placementState.revision,
    sectionId: placementState.sectionId,
  });

  return updated;
};

export async function updateWorkspaceTask(input: {
  workspaceId: string;
  taskId: string;
  actorUserId: string;
  title?: string;
  description?: string | null;
  assigneeUserId?: string | null;
  dueDateValue?: string | null;
  status?: MeetingTaskStatus;
  sectionId?: string | null;
}): UpdateWorkspaceTaskResult {
  const row = await updateWorkspaceTaskWithin({ input });

  if (!row) {
    throw new Error(workspaceTaskNotFoundMessage(input.taskId));
  }

  return parseWorkspaceTaskRow(row);
}

export async function deleteWorkspaceTasksByIds(input: {
  workspaceId: string;
  taskIds: string[];
  actorUserId: string;
}): Promise<string[]> {
  const uniqueTaskIds = [...new Set(input.taskIds)];
  if (uniqueTaskIds.length === 0) {
    return [];
  }

  const deletedIds = await (async () => {
    const existingTasks = await mapRow({
      value: db.workspaceTasks.findMany({
        where: whereAnd([{ workspaceId: input.workspaceId }, { id: { in: uniqueTaskIds } }]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
          status: meetingTaskStatusSchema.parse(row.status),
        })),
    });
    const placements = await mapRow({
      value: db.assignedTaskPlacements.findMany({
        where: whereAnd([
          { workspaceId: input.workspaceId },
          { sourceType: "workspace" },
          { sourceTaskId: { in: uniqueTaskIds } },
        ]),
      }),
      map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
    });

    await db.assignedTaskPlacements.deleteMany({
      where: whereAnd([
        { workspaceId: input.workspaceId },
        { sourceType: "workspace" },
        { sourceTaskId: { in: uniqueTaskIds } },
      ]),
    });
    const deleted = await (async () => {
      const where22 = sqlAnd([
        sqlCompare({
          columnSql: '"workspace_tasks"."workspace_id"',
          operator: "=",
          value: input.workspaceId,
          cast: "uuid",
        }),
        sqlIn({ columnSql: '"workspace_tasks"."id"', values: uniqueTaskIds, cast: "uuid", isNegated: false }),
      ]);

      return db.$queryRaw<{ id: string }[]>`
                          DELETE FROM "workspace_tasks"
                          ${sqlWhereClause(where22)}
                          RETURNING "id" AS "id"
                          `;
    })();

    const events = existingTasks.flatMap((task) => [
      workspaceTaskBroadcastRealtimeEvent({
        workspaceId: input.workspaceId,
        eventName: "workspace.task.deleted",
        taskId: task.id,
        revision: task.revision + 1,
        actorUserId: input.actorUserId,
        dedupeSuffix: `task:${task.id}:deleted`,
      }),
      ...placements
        .filter((placement) => placement.sourceTaskId === task.id)
        .flatMap((placement) =>
          userTaskRealtimeEvents({
            workspaceId: input.workspaceId,
            userId: placement.assigneeUserId,
            eventName: "workspace.task.deleted",
            taskId: task.id,
            sectionId: placement.sectionId,
            revision: task.revision + 1,
            placementRevision: placement.revision + 1,
            actorUserId: input.actorUserId,
            dedupeSuffix: `task:${task.id}:deleted:${placement.assigneeUserId}`,
          }),
        ),
    ]);
    if (events.length !== 0) {
      await publishRealtimeEvents(events);
    }

    return deleted.map((row) => row.id);
  })();

  return deletedIds;
}

type CreateWorkspaceTaskSectionResult = Promise<{
  id: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  workspaceId: string;
  title: string;
  isDefault: boolean;
  position: number;
  updatedByUserId: string | null;
}>;

function rethrowWorkspaceTaskSectionConflict(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new WorkspaceTaskSectionTitleConflictError();
  }

  throw error;
}

export async function createWorkspaceTaskSection(input: {
  workspaceId: string;
  actorUserId: string;
  title: string;
  position?: number;
}): CreateWorkspaceTaskSectionResult {
  const row = await (async () => {
    const sectionRows = await db.workspaceTaskSections.findMany({
      where: whereAnd([{ workspaceId: input.workspaceId }, { deletedAt: null }]),
      select: {
        position: true,
      },
    });
    const maxRow = {
      maxPosition: sectionRows.reduce((maxPosition, row) => Math.max(maxPosition, row.position), 0),
    };
    try {
      return await db.workspaceTaskSections.create({
        data: {
          workspaceId: input.workspaceId,
          title: input.title,
          position: input.position ?? maxRow.maxPosition,
          isDefault: false,
          createdByUserId: input.actorUserId,
          updatedByUserId: input.actorUserId,
        },
      });
    } catch (error: unknown) {
      rethrowWorkspaceTaskSectionConflict(error);
    }
  })();

  const userIds = await listWorkspaceMemberUserIds(input.workspaceId);
  await publishRealtimeEvents(
    userIds.flatMap((userId) =>
      userTaskRealtimeEvents({
        workspaceId: input.workspaceId,
        userId,
        eventName: "workspace.task.section.created",
        sectionId: row.id,
        actorUserId: input.actorUserId,
        dedupeSuffix: `section:${row.id}:created`,
      }),
    ),
  );

  return parseWorkspaceTaskSectionRow(row);
}

type UpdateWorkspaceTaskSectionResult = Promise<{
  id: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  workspaceId: string;
  title: string;
  isDefault: boolean;
  position: number;
  updatedByUserId: string | null;
}>;

export async function updateWorkspaceTaskSection(input: {
  workspaceId: string;
  sectionId: string;
  actorUserId: string;
  title?: string;
  position?: number;
}): UpdateWorkspaceTaskSectionResult {
  const [row] = await (async () => {
    try {
      return await db.workspaceTaskSections.updateManyAndReturn({
        where: whereAnd([{ id: input.sectionId }, { workspaceId: input.workspaceId }, { deletedAt: null }]),
        data: {
          title: input.title,
          position: input.position,
          updatedByUserId: input.actorUserId,
          updatedAt: new Date(),
        },
      });
    } catch (error: unknown) {
      rethrowWorkspaceTaskSectionConflict(error);
    }
  })();

  if (!row) {
    throw new Error(taskSectionNotFoundMessage(input.sectionId));
  }

  const userIds = await listWorkspaceMemberUserIds(input.workspaceId);
  await publishRealtimeEvents(
    userIds.flatMap((userId) =>
      userTaskRealtimeEvents({
        workspaceId: input.workspaceId,
        userId,
        eventName: "workspace.task.section.updated",
        sectionId: row.id,
        actorUserId: input.actorUserId,
        dedupeSuffix: `section:${row.id}:updated:${row.updatedAt.toISOString()}`,
      }),
    ),
  );

  return parseWorkspaceTaskSectionRow(row);
}

function buildDeleteWorkspaceTaskSectionRealtimeEvents(args: {
  input: { workspaceId: string; sectionId: string; actorUserId: string };
  userIds: string[];
  workspaceRows: Prisma.workspaceTasksModel[];
  placements: Prisma.assignedTaskPlacementsModel[];
}) {
  const { input, userIds, workspaceRows, placements } = args;

  return [
    ...workspaceRows.map((task) =>
      workspaceTaskBroadcastRealtimeEvent({
        workspaceId: input.workspaceId,
        eventName: "workspace.task.deleted",
        taskId: task.id,
        sectionId: input.sectionId,
        revision: task.revision + 1,
        actorUserId: input.actorUserId,
        dedupeSuffix: `section:${input.sectionId}:task:${task.id}:deleted`,
      }),
    ),
    ...placements.flatMap((placement) => {
      const workspaceTask = workspaceRows.find((task) => task.id === placement.sourceTaskId);

      return userTaskRealtimeEvents({
        workspaceId: input.workspaceId,
        userId: placement.assigneeUserId,
        eventName: "workspace.task.deleted",
        taskId: placement.sourceType === "workspace" ? placement.sourceTaskId : null,
        sectionId: input.sectionId,
        revision: workspaceTask ? workspaceTask.revision + 1 : null,
        placementRevision: placement.revision + 1,
        actorUserId: input.actorUserId,
        dedupeSuffix: `section:${input.sectionId}:task:${placement.sourceType}:${placement.sourceTaskId}:deleted`,
      });
    }),
    ...userIds.flatMap((userId) =>
      userTaskRealtimeEvents({
        workspaceId: input.workspaceId,
        userId,
        eventName: "workspace.task.section.updated",
        sectionId: input.sectionId,
        actorUserId: input.actorUserId,
        dedupeSuffix: `section:${input.sectionId}:deleted:${userId}`,
      }),
    ),
  ];
}
const selectHoist8888: Prisma.meetingTasksSelect = {
  id: true,
  meetingId: true,
  taskListId: true,
  position: true,
  title: true,
  description: true,
  type: true,
  ownerName: true,
  ownerEmail: true,
  ownerConfidence: true,
  dueDateValue: true,
  dueDateConfidence: true,
  confidence: true,
  sourceQuotes: true,
  sourceReason: true,
  status: true,
  createdFrom: true,
  externalLinks: true,
  createdAt: true,
  updatedAt: true,
  workKind: true,
  ownerUserId: true,
  revision: true,
  completedAt: true,
  assetIds: true,
  origin: true,
  statusSource: true,
  statusActorUserId: true,
  statusChangedAt: true,
  actionConfirmableAt: true,
  detectedAt: true,
  firstRenderedAt: true,
  firstRenderedReportedAt: true,
  realtimeReceivedAt: true,
  refetchStartedAt: true,
  refetchCompletedAt: true,
  meetings: true,
};

async function purgeWorkspaceTaskSectionContentsWithin(args: {
  input: { workspaceId: string; sectionId: string; actorUserId: string };
}) {
  const { input } = args;
  const placements = await mapRow({
    value: db.assignedTaskPlacements.findMany({
      where: whereAnd([{ workspaceId: input.workspaceId }, { sectionId: input.sectionId }]),
    }),
    map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
  });
  const workspaceTaskIds = placements
    .filter((placement) => placement.sourceType === "workspace")
    .map((placement) => placement.sourceTaskId);
  const meetingTaskIds = placements
    .filter((placement) => placement.sourceType === "meeting")
    .map((placement) => placement.sourceTaskId);

  const workspaceRows =
    workspaceTaskIds.length !== 0
      ? await mapRow({
          value: db.workspaceTasks.findMany({
            where: whereAnd([{ workspaceId: input.workspaceId }, { id: { in: workspaceTaskIds } }]),
          }),
          map: (rows) =>
            rows.map((row) => ({
              ...row,
              dueDateConfidence: parseNullable({ schema: meetingTaskConfidenceSchema, value: row.dueDateConfidence }),
              status: meetingTaskStatusSchema.parse(row.status),
            })),
        })
      : [];
  const meetingRows =
    meetingTaskIds.length !== 0
      ? await mapRow({
          value: db.meetingTasks.findMany({
            where: whereAnd([{ meetings: { workspaceId: input.workspaceId } }, { id: { in: meetingTaskIds } }]),
            select: selectHoist8888,
          }),
          map: (rows) =>
            rows.map((row) => ({
              task: readStoredMeetingTask(row),
              meeting: readStoredMeeting(row.meetings),
            })),
        })
      : [];

  if (workspaceTaskIds.length !== 0) {
    await db.workspaceTasks.deleteMany({
      where: whereAnd([{ workspaceId: input.workspaceId }, { id: { in: workspaceTaskIds } }]),
    });
  }
  if (meetingTaskIds.length !== 0) {
    await mapRowsSequentially({
      rows: await mapRow({
        value: db.meetingTasks.findMany({
          where: { id: { in: meetingTaskIds } },
        }),
        map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
      }),
      visit: async (storedRow) => {
        const updatedRows = await mapRow({
          value: db.meetingTasks.updateManyAndReturn({
            where: { id: storedRow.id },
            data: {
              status: "dismissed",
              completedAt: null,
              revision: storedRow.revision + 1,
              updatedAt: new Date(),
            },
          }),
          map: (rows) => rows.map((row) => readStoredMeetingTask(row)),
        });

        return updatedRows[0];
      },
    });
  }
  await db.assignedTaskPlacements.deleteMany({
    where: whereAnd([{ workspaceId: input.workspaceId }, { sectionId: input.sectionId }]),
  });
  await db.workspaceTaskSections.updateMany({
    where: whereAnd([{ id: input.sectionId }, { workspaceId: input.workspaceId }]),
    data: {
      deletedAt: new Date(),
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
    },
  });

  return { workspaceRows, meetingRows, placements };
}

const deleteWorkspaceTaskSectionWithin = async (args: {
  input: {
    workspaceId: string;
    sectionId: string;
    actorUserId: string;
  };
  userIds: string[];
}) => {
  const { input, userIds } = args;

  const section = await mapRow({
    value: db.workspaceTaskSections.findFirst({
      where: whereAnd([{ id: input.sectionId }, { workspaceId: input.workspaceId }, { deletedAt: null }]),
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });
  if (!section) {
    throw new Error(TASK_SECTION_NOT_FOUND_MESSAGE);
  }
  if (section.isDefault) {
    throw new Error(DEFAULT_TASK_SECTION_CANNOT_BE_DELETED_MESSAGE);
  }

  const { workspaceRows, meetingRows, placements } = await purgeWorkspaceTaskSectionContentsWithin({ input });
  const events = buildDeleteWorkspaceTaskSectionRealtimeEvents({
    input,
    userIds,
    workspaceRows,
    placements,
  });
  if (events.length !== 0) {
    await publishRealtimeEvents(events);
  }

  return {
    sectionId: input.sectionId,
    taskIds: [...workspaceRows.map((task) => task.id), ...meetingRows.map((row) => row.task.id)],
  };
};

export async function deleteWorkspaceTaskSection(input: {
  workspaceId: string;
  sectionId: string;
  actorUserId: string;
}): Promise<{ sectionId: string; taskIds: string[] }> {
  const userIds = await listWorkspaceMemberUserIds(input.workspaceId);
  const result = await deleteWorkspaceTaskSectionWithin({ input, userIds });

  return result;
}

type ReorderWorkspaceAssignedTasksResult = Promise<{
  sections: {
    id: string;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
    createdByUserId: string | null;
    workspaceId: string;
    title: string;
    isDefault: boolean;
    position: number;
    updatedByUserId: string | null;
  }[];
  tasks: {
    status: "open" | "completed" | "dismissed";
    owner: { displayName: string; avatarUrl: string | null; userId: string } | null;
    updatedAt: string;
    completedAt: string | null;
    workspaceId: string;
    title: string;
    position: number;
    description: string | null;
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    revision: number;
    taskId: string;
    sourceType: "meeting" | "workspace";
    sectionId: string;
    sourceId: string;
    /** @external existing wire contract */ editable: boolean;
    /** @external existing wire contract */ reassignable: boolean;
    /** @external existing wire contract */ deletable: boolean;
    /** @external existing wire contract */ reorderable: boolean;
    isMine: boolean;
    placementRevision: number;
    sourceMeeting: { id: string; title: string; startedAt: string | null; endedAt: string | null } | null;
    viewerWorkspaceId?: string | undefined;
  }[];
}>;

function computeWorkspaceAssignedTaskReorderLayout(args: {
  input: {
    targetSectionId: string;
    beforeTaskId?: string | null;
    afterTaskId?: string | null;
  };
  scopeRows: Prisma.assignedTaskPlacementsModel[];
  movedTaskIds: string[];
  movedRows: Prisma.assignedTaskPlacementsModel[];
}) {
  const { input, scopeRows, movedTaskIds, movedRows } = args;
  const movedById = new Map(movedRows.map((row) => [row.sourceTaskId, row]));
  const orderedMovedRows = movedTaskIds
    .map((taskId) => movedById.get(taskId))
    .filter((row): row is (typeof movedRows)[number] => Boolean(row));
  const movedIdSet = new Set(movedTaskIds);
  const sectionIdsToRenumber = new Set([...movedRows.map((row) => row.sectionId), input.targetSectionId]);
  const unmovedTargetRows = scopeRows.filter(
    (row) => row.sectionId === input.targetSectionId && !movedIdSet.has(row.sourceTaskId),
  );
  const insertIndex = (() => {
    if (input.beforeTaskId !== undefined && input.beforeTaskId !== null && input.beforeTaskId !== "") {
      const beforeIndex = unmovedTargetRows.findIndex((row) => row.sourceTaskId === input.beforeTaskId);

      return beforeIndex >= 0 ? beforeIndex : unmovedTargetRows.length;
    }
    if (input.afterTaskId !== undefined && input.afterTaskId !== null && input.afterTaskId !== "") {
      const afterIndex = unmovedTargetRows.findIndex((row) => row.sourceTaskId === input.afterTaskId);

      return afterIndex >= 0 ? afterIndex + 1 : unmovedTargetRows.length;
    }

    return unmovedTargetRows.length;
  })();
  const targetRows = [
    ...unmovedTargetRows.slice(0, insertIndex),
    ...orderedMovedRows.map((row) => ({
      ...row,
      sectionId: input.targetSectionId,
    })),
    ...unmovedTargetRows.slice(insertIndex),
  ];

  return { targetRows, sectionIdsToRenumber, movedIdSet };
}

async function renumberWorkspaceAssignedPlacementRowWithin(args: {
  input: { workspaceId: string; assigneeUserId: string; actorUserId: string };
  row: Prisma.assignedTaskPlacementsModel;
  sectionId: string;
  position: number;
  movedIdSet: Set<string>;
}) {
  const { input, row, sectionId, position, movedIdSet } = args;
  const [updated] = await mapRowsSequentially({
    rows: await mapRow({
      value: db.assignedTaskPlacements.findMany({
        where: whereAnd([
          { sourceType: row.sourceType },
          { sourceTaskId: row.sourceTaskId },
          { workspaceId: input.workspaceId },
          { assigneeUserId: input.assigneeUserId },
        ]),
      }),
      map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
    }),
    visit: async (storedRow) => {
      const updatedRows = await mapRow({
        value: db.assignedTaskPlacements.updateManyAndReturn({
          where: whereAnd([
            { sourceType: storedRow.sourceType },
            { sourceTaskId: storedRow.sourceTaskId },
            { workspaceId: storedRow.workspaceId },
            { assigneeUserId: storedRow.assigneeUserId },
          ]),
          data: {
            sectionId,
            position,
            revision: storedRow.revision + 1,
            updatedByUserId: input.actorUserId,
            updatedAt: new Date(),
          },
        }),
        map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
      });

      return updatedRows[0];
    },
  });
  if (!movedIdSet.has(row.sourceTaskId) || !updated) {
    return [];
  }

  return userTaskRealtimeEvents({
    workspaceId: input.workspaceId,
    userId: input.assigneeUserId,
    eventName: "workspace.task.placement.updated",
    taskId: row.sourceType === "workspace" ? row.sourceTaskId : null,
    sectionId: updated.sectionId,
    placementRevision: updated.revision,
    actorUserId: input.actorUserId,
    dedupeSuffix: `placement:${row.sourceType}:${row.sourceTaskId}:${updated.revision}`,
  });
}

async function renumberWorkspaceAssignedPlacementSectionWithin(args: {
  input: { workspaceId: string; assigneeUserId: string; actorUserId: string };
  rows: Prisma.assignedTaskPlacementsModel[];
  sectionId: string;
  movedIdSet: Set<string>;
}) {
  return args.rows.reduce<Promise<RealtimeOutboxEventInput[]>>(async (previousEvents, row, position) => {
    const eventsSoFar = await previousEvents;
    const rowEvents = await renumberWorkspaceAssignedPlacementRowWithin({
      input: args.input,
      row,
      sectionId: args.sectionId,
      position,
      movedIdSet: args.movedIdSet,
    });

    return eventsSoFar.concat(rowEvents);
  }, Promise.resolve([]));
}

async function applyWorkspaceAssignedTaskReorderPlacementsWithin(args: {
  input: {
    workspaceId: string;
    assigneeUserId: string;
    actorUserId: string;
    targetSectionId: string;
  };
  scopeRows: Prisma.assignedTaskPlacementsModel[];
  targetRows: Prisma.assignedTaskPlacementsModel[];
  sectionIdsToRenumber: Set<string>;
  movedIdSet: Set<string>;
}) {
  const { input, scopeRows, targetRows, sectionIdsToRenumber, movedIdSet } = args;

  return [...sectionIdsToRenumber].reduce<Promise<RealtimeOutboxEventInput[]>>(async (previous, sectionId) => {
    const collected = await previous;
    const rows =
      sectionId === input.targetSectionId
        ? targetRows
        : scopeRows.filter((row) => row.sectionId === sectionId && !movedIdSet.has(row.sourceTaskId));
    const sectionEvents = await renumberWorkspaceAssignedPlacementSectionWithin({
      input,
      rows,
      sectionId,
      movedIdSet,
    });

    return collected.concat(sectionEvents);
  }, Promise.resolve([]));
}

const reorderWorkspaceAssignedTasksWithin = async (args: {
  input: {
    workspaceId: string;
    assigneeUserId: string;
    actorUserId: string;
    movedTaskIds: string[];
    targetSectionId: string;
    beforeTaskId?: string | null;
    afterTaskId?: string | null;
  };
  movedTaskIds: string[];
}) => {
  const { input, movedTaskIds } = args;

  const targetSection = await mapRow({
    value: db.workspaceTaskSections.findFirst({
      where: whereAnd([{ id: input.targetSectionId }, { workspaceId: input.workspaceId }, { deletedAt: null }]),
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });
  if (!targetSection) {
    throw new Error(TARGET_SECTION_NOT_FOUND_MESSAGE);
  }

  const scopeRows = await mapRow({
    value: db.assignedTaskPlacements.findMany({
      where: whereAnd([{ workspaceId: input.workspaceId }, { assigneeUserId: input.assigneeUserId }]),
      orderBy: [{ position: "asc" }, { updatedAt: "asc" }],
    }),
    map: (rows) => rows.map((row) => ({ ...row, sourceType: assignedTaskSourceTypeSchema.parse(row.sourceType) })),
  });
  const movedRows = scopeRows.filter((row) => movedTaskIds.includes(row.sourceTaskId));
  if (movedRows.length !== movedTaskIds.length) {
    throw new Error(ONLY_REORDERABLE_ASSIGNED_TASKS_CAN_BE_MOVED_MESSAGE);
  }

  const { targetRows, sectionIdsToRenumber, movedIdSet } = computeWorkspaceAssignedTaskReorderLayout({
    input,
    scopeRows,
    movedTaskIds,
    movedRows,
  });
  const events = await applyWorkspaceAssignedTaskReorderPlacementsWithin({
    input,
    scopeRows,
    targetRows,
    sectionIdsToRenumber,
    movedIdSet,
  });

  if (events.length !== 0) {
    await publishRealtimeEvents(events);
  }
};

export async function reorderWorkspaceAssignedTasks(input: {
  workspaceId: string;
  assigneeUserId: string;
  actorUserId: string;
  movedTaskIds: string[];
  targetSectionId: string;
  beforeTaskId?: string | null;
  afterTaskId?: string | null;
}): ReorderWorkspaceAssignedTasksResult {
  const movedTaskIds = [...new Set(input.movedTaskIds)];
  if (movedTaskIds.length === 0) {
    return listWorkspaceAssignedTasksForUser({
      workspaceId: input.workspaceId,
      userId: input.assigneeUserId,
    });
  }

  await reorderWorkspaceAssignedTasksWithin({ input, movedTaskIds });

  return listWorkspaceAssignedTasksForUser({
    workspaceId: input.workspaceId,
    userId: input.assigneeUserId,
  });
}

type GetAssignedTaskContextResult = Promise<{
  task: {
    type: "action_item" | "follow_up" | "task" | "decision_follow_up" | "open_question";
    status: "open" | "completed" | "dismissed";
    owner: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    title: string;
    meetingId: string;
    position: number;
    assignee: {
      name: string | null;
      email: string | null;
      userId: string | null;
      confidence: "low" | "medium" | "high" | null;
    };
    taskListId: string;
    description: string | null;
    workKind:
      | "bug_or_issue"
      | "implementation"
      | "design"
      | "research"
      | "customer_follow_up"
      | "sales_or_crm"
      | "scheduling"
      | "documentation"
      | "general";
    confidence: "low" | "medium" | "high";
    dueDate: { value: string | null; confidence: "low" | "medium" | "high" | null };
    sourceQuotes: {
      quote: string;
      speaker: string | null;
      timestamp: string | null;
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      speakerIdentity?: string | null | undefined;
      sourceSegmentId?: string | null | undefined;
      segmentId?: string | null | undefined;
    }[];
    sourceReason: string;
    revision: number;
    createdFrom: "meeting_transcript";
    origin: "live" | "final";
    statusSource: "user" | "model";
    statusActorUserId: string | null;
    statusChangedAt: string | null;
    actionConfirmableAt: string | null;
    detectedAt: string | null;
    firstRenderedAt: string | null;
    assetIds: string[];
    externalLinks: Record<string, unknown>[];
  };
  meeting: { id: string; workspaceId: string; title: string; startedAt: string | null; endedAt: string | null };
  summary: null;
  relatedDecisions: { id: string; text: string; finality: "final" | "tentative" | "provisional" }[];
  relatedActionItems: { id: string; title: string; description: string | null }[];
} | null>;
type rowsRow10 = {
  task__id: string;
  task__meetingId: string;
  task__taskListId: string;
  task__position: number;
  task__title: string;
  task__description: string | null;
  task__type: MeetingTaskType;
  task__ownerName: string | null;
  task__ownerEmail: string | null;
  task__ownerConfidence: MeetingTaskCandidate["owner"]["confidence"] | null;
  task__dueDateValue: string | null;
  task__dueDateConfidence: MeetingTaskCandidate["dueDate"]["confidence"] | null;
  task__confidence: "low" | "medium" | "high";
  task__sourceQuotes: Prisma.JsonValue;
  task__sourceReason: string;
  task__status: MeetingTaskStatus;
  task__createdFrom: "meeting_transcript";
  task__externalLinks: Prisma.JsonValue;
  task__createdAt: Date;
  task__updatedAt: Date;
  task__workKind: MeetingTaskWorkKind;
  task__ownerUserId: string | null;
  task__revision: number;
  task__completedAt: Date | null;
  task__assetIds: Prisma.JsonValue;
  task__origin: MeetingTaskDetectionOrigin;
  task__statusSource: MeetingTaskStatusSource;
  task__statusActorUserId: string | null;
  task__statusChangedAt: Date;
  task__actionConfirmableAt: Date | null;
  task__detectedAt: Date | null;
  task__firstRenderedAt: Date | null;
  task__firstRenderedReportedAt: Date | null;
  task__realtimeReceivedAt: Date | null;
  task__refetchStartedAt: Date | null;
  task__refetchCompletedAt: Date | null;
  meeting__id: string;
  meeting__title: string;
  meeting__roomName: string;
  meeting__createdByUserId: string;
  meeting__status: "scheduled" | "active" | "ended";
  meeting__createdAt: Date;
  meeting__startedAt: Date | null;
  meeting__endedAt: Date | null;
  meeting__hiddenFromHistoryAt: Date | null;
  meeting__hiddenFromHistoryReason: string | null;
  meeting__workspaceId: string;
  meeting__meetingLinkId: string | null;
  meeting__instanceNumber: number;
  meeting__kind: MeetingKind;
  isConfidential: boolean;
  meeting__confidentialitySource: ("auto" | "manual") | null;
  meeting__confidentialityUpdatedByUserId: string | null;
  meeting__confidentialityUpdatedAt: Date | null;
  meeting__agentIntroKey: string | null;
  meeting__currentLinkKey: string | null;
  extraction__id: string | null;
  extraction__meetingId: string | null;
  extraction__status: ("pending" | "running" | "completed" | "partial" | "failed") | null;
  extraction__meetingType: MeetingType | null;
  extraction__meetingTypeConfidence: ExtractionConfidence | null;
  extraction__meetingTypeReasoning: string | null;
  extraction__participants: Prisma.JsonValue | null;
  extraction__summaryShort: string | null;
  extraction__summaryBullets: Prisma.JsonValue | null;
  extraction__decisions: Prisma.JsonValue | null;
  extraction__actionItems: Prisma.JsonValue | null;
  extraction__openQuestions: Prisma.JsonValue | null;
  extraction__risks: Prisma.JsonValue | null;
  extraction__keyTopics: Prisma.JsonValue | null;
  extraction__signals: Prisma.JsonValue | null;
  extraction__failedToolCalls: Prisma.JsonValue | null;
  extraction__extractionModel: string | null;
  extraction__extractionPromptVersion: string | null;
  extraction__transcriptHash: string | null;
  extraction__durationMs: number | null;
  extraction__startedAt: Date | null;
  extraction__completedAt: Date | null;
  extraction__createdAt: Date | null;
  extraction__updatedAt: Date | null;
  extraction__highlights: Prisma.JsonValue | null;
  extraction__contentStatus: ("pending" | "running" | "completed" | "partial" | "failed") | null;
  extraction__signalsStatus: ("pending" | "running" | "completed" | "partial" | "failed") | null;
};

const rowsSql4 = `
                      SELECT "meeting_tasks"."id" AS "task__id",
                      "meeting_tasks"."meeting_id" AS "task__meetingId",
                      "meeting_tasks"."task_list_id" AS "task__taskListId",
                      "meeting_tasks"."position" AS "task__position",
                      "meeting_tasks"."title" AS "task__title",
                      "meeting_tasks"."description" AS "task__description",
                      "meeting_tasks"."type" AS "task__type",
                      "meeting_tasks"."owner_name" AS "task__ownerName",
                      "meeting_tasks"."owner_email" AS "task__ownerEmail",
                      "meeting_tasks"."owner_confidence" AS "task__ownerConfidence",
                      "meeting_tasks"."due_date_value" AS "task__dueDateValue",
                      "meeting_tasks"."due_date_confidence" AS "task__dueDateConfidence",
                      "meeting_tasks"."confidence" AS "task__confidence",
                      "meeting_tasks"."source_quotes" AS "task__sourceQuotes",
                      "meeting_tasks"."source_reason" AS "task__sourceReason",
                      "meeting_tasks"."status" AS "task__status",
                      "meeting_tasks"."created_from" AS "task__createdFrom",
                      "meeting_tasks"."external_links" AS "task__externalLinks",
                      "meeting_tasks"."created_at" AS "task__createdAt",
                      "meeting_tasks"."updated_at" AS "task__updatedAt",
                      "meeting_tasks"."work_kind" AS "task__workKind",
                      "meeting_tasks"."owner_user_id" AS "task__ownerUserId",
                      "meeting_tasks"."revision" AS "task__revision",
                      "meeting_tasks"."completed_at" AS "task__completedAt",
                      "meeting_tasks"."asset_ids" AS "task__assetIds",
                      "meeting_tasks"."origin" AS "task__origin",
                      "meeting_tasks"."status_source" AS "task__statusSource",
                      "meeting_tasks"."status_actor_user_id" AS "task__statusActorUserId",
                      "meeting_tasks"."status_changed_at" AS "task__statusChangedAt",
                      "meeting_tasks"."action_confirmable_at" AS "task__actionConfirmableAt",
                      "meeting_tasks"."detected_at" AS "task__detectedAt",
                      "meeting_tasks"."first_rendered_at" AS "task__firstRenderedAt",
                      "meeting_tasks"."first_rendered_reported_at" AS "task__firstRenderedReportedAt",
                      "meeting_tasks"."realtime_received_at" AS "task__realtimeReceivedAt",
                      "meeting_tasks"."refetch_started_at" AS "task__refetchStartedAt",
                      "meeting_tasks"."refetch_completed_at" AS "task__refetchCompletedAt",
                      "meetings"."id" AS "meeting__id",
                      "meetings"."title" AS "meeting__title",
                      "meetings"."room_name" AS "meeting__roomName",
                      "meetings"."created_by_user_id" AS "meeting__createdByUserId",
                      "meetings"."status" AS "meeting__status",
                      "meetings"."created_at" AS "meeting__createdAt",
                      "meetings"."started_at" AS "meeting__startedAt",
                      "meetings"."ended_at" AS "meeting__endedAt",
                      "meetings"."hidden_from_history_at" AS "meeting__hiddenFromHistoryAt",
                      "meetings"."hidden_from_history_reason" AS "meeting__hiddenFromHistoryReason",
                      "meetings"."workspace_id" AS "meeting__workspaceId",
                      "meetings"."meeting_link_id" AS "meeting__meetingLinkId",
                      "meetings"."instance_number" AS "meeting__instanceNumber",
                      "meetings"."kind" AS "meeting__kind",
                      "meetings"."is_confidential" AS "isConfidential",
                      "meetings"."confidentiality_source" AS "meeting__confidentialitySource",
                      "meetings"."confidentiality_updated_by_user_id" AS "meeting__confidentialityUpdatedByUserId",
                      "meetings"."confidentiality_updated_at" AS "meeting__confidentialityUpdatedAt",
                      "meetings"."agent_intro_key" AS "meeting__agentIntroKey",
                      "meetings"."current_link_key" AS "meeting__currentLinkKey",
                      "meeting_extractions"."id" AS "extraction__id",
                      "meeting_extractions"."meeting_id" AS "extraction__meetingId",
                      "meeting_extractions"."status" AS "extraction__status",
                      "meeting_extractions"."meeting_type" AS "extraction__meetingType",
                      "meeting_extractions"."meeting_type_confidence" AS "extraction__meetingTypeConfidence",
                      "meeting_extractions"."meeting_type_reasoning" AS "extraction__meetingTypeReasoning",
                      "meeting_extractions"."participants" AS "extraction__participants",
                      "meeting_extractions"."summary_short" AS "extraction__summaryShort",
                      "meeting_extractions"."summary_bullets" AS "extraction__summaryBullets",
                      "meeting_extractions"."decisions" AS "extraction__decisions",
                      "meeting_extractions"."action_items" AS "extraction__actionItems",
                      "meeting_extractions"."open_questions" AS "extraction__openQuestions",
                      "meeting_extractions"."risks" AS "extraction__risks",
                      "meeting_extractions"."key_topics" AS "extraction__keyTopics",
                      "meeting_extractions"."signals" AS "extraction__signals",
                      "meeting_extractions"."failed_tool_calls" AS "extraction__failedToolCalls",
                      "meeting_extractions"."extraction_model" AS "extraction__extractionModel",
                      "meeting_extractions"."extraction_prompt_version" AS "extraction__extractionPromptVersion",
                      "meeting_extractions"."transcript_hash" AS "extraction__transcriptHash",
                      "meeting_extractions"."duration_ms" AS "extraction__durationMs",
                      "meeting_extractions"."started_at" AS "extraction__startedAt",
                      "meeting_extractions"."completed_at" AS "extraction__completedAt",
                      "meeting_extractions"."created_at" AS "extraction__createdAt",
                      "meeting_extractions"."updated_at" AS "extraction__updatedAt",
                      "meeting_extractions"."highlights" AS "extraction__highlights",
                      "meeting_extractions"."content_status" AS "extraction__contentStatus",
                      "meeting_extractions"."signals_status" AS "extraction__signalsStatus"
                      FROM "meeting_tasks"
                      INNER JOIN "meeting_task_lists" ON `;

const mapAssignedTaskContextRow = (row: rowsRow10) => ({
  task: {
    id: row.task__id,
    meetingId: row.task__meetingId,
    taskListId: row.task__taskListId,
    position: row.task__position,
    title: row.task__title,
    description: row.task__description,
    type: row.task__type,
    ownerName: row.task__ownerName,
    ownerEmail: row.task__ownerEmail,
    ownerConfidence: row.task__ownerConfidence,
    dueDateValue: row.task__dueDateValue,
    dueDateConfidence: row.task__dueDateConfidence,
    confidence: row.task__confidence,
    sourceQuotes: row.task__sourceQuotes,
    sourceReason: row.task__sourceReason,
    status: row.task__status,
    createdFrom: row.task__createdFrom,
    externalLinks: row.task__externalLinks,
    createdAt: row.task__createdAt,
    updatedAt: row.task__updatedAt,
    workKind: row.task__workKind,
    ownerUserId: row.task__ownerUserId,
    revision: row.task__revision,
    completedAt: row.task__completedAt,
    assetIds: row.task__assetIds,
    origin: row.task__origin,
    statusSource: row.task__statusSource,
    statusActorUserId: row.task__statusActorUserId,
    statusChangedAt: row.task__statusChangedAt,
    actionConfirmableAt: row.task__actionConfirmableAt,
    detectedAt: row.task__detectedAt,
    firstRenderedAt: row.task__firstRenderedAt,
    firstRenderedReportedAt: row.task__firstRenderedReportedAt,
    realtimeReceivedAt: row.task__realtimeReceivedAt,
    refetchStartedAt: row.task__refetchStartedAt,
    refetchCompletedAt: row.task__refetchCompletedAt,
  },
  meeting: {
    id: row.meeting__id,
    title: row.meeting__title,
    roomName: row.meeting__roomName,
    createdByUserId: row.meeting__createdByUserId,
    status: row.meeting__status,
    createdAt: row.meeting__createdAt,
    startedAt: row.meeting__startedAt,
    endedAt: row.meeting__endedAt,
    hiddenFromHistoryAt: row.meeting__hiddenFromHistoryAt,
    hiddenFromHistoryReason: row.meeting__hiddenFromHistoryReason,
    workspaceId: row.meeting__workspaceId,
    meetingLinkId: row.meeting__meetingLinkId,
    instanceNumber: row.meeting__instanceNumber,
    kind: row.meeting__kind,
    isConfidential: row.isConfidential,
    confidentialitySource: row.meeting__confidentialitySource,
    confidentialityUpdatedByUserId: row.meeting__confidentialityUpdatedByUserId,
    confidentialityUpdatedAt: row.meeting__confidentialityUpdatedAt,
    agentIntroKey: row.meeting__agentIntroKey,
    currentLinkKey: row.meeting__currentLinkKey,
  },
  extraction:
    row.extraction__id === null
      ? null
      : {
          id: row.extraction__id,
          meetingId: readPresent(row.extraction__meetingId),
          status: readPresent(row.extraction__status),
          meetingType: row.extraction__meetingType,
          meetingTypeConfidence: row.extraction__meetingTypeConfidence,
          meetingTypeReasoning: row.extraction__meetingTypeReasoning,
          participants: readPresent(row.extraction__participants),
          summaryShort: row.extraction__summaryShort,
          summaryBullets: readPresent(row.extraction__summaryBullets),
          decisions: readPresent(row.extraction__decisions),
          actionItems: readPresent(row.extraction__actionItems),
          openQuestions: readPresent(row.extraction__openQuestions),
          risks: readPresent(row.extraction__risks),
          keyTopics: readPresent(row.extraction__keyTopics),
          signals: readPresent(row.extraction__signals),
          failedToolCalls: readPresent(row.extraction__failedToolCalls),
          extractionModel: readPresent(row.extraction__extractionModel),
          extractionPromptVersion: readPresent(row.extraction__extractionPromptVersion),
          transcriptHash: readPresent(row.extraction__transcriptHash),
          durationMs: row.extraction__durationMs,
          startedAt: row.extraction__startedAt,
          completedAt: row.extraction__completedAt,
          createdAt: readPresent(row.extraction__createdAt),
          updatedAt: readPresent(row.extraction__updatedAt),
          highlights: readPresent(row.extraction__highlights),
          contentStatus: readPresent(row.extraction__contentStatus),
          signalsStatus: readPresent(row.extraction__signalsStatus),
        },
});

export async function getAssignedTaskContext(input: { taskId: string; userId: string }): GetAssignedTaskContextResult {
  const row = await mapRow({
    value: (async () => {
      const where23 = sqlAnd([
        sqlCompare({ columnSql: '"meeting_task_lists"."status"', operator: "=", value: "completed", cast: null }),
        sqlCompare({ columnSql: '"meeting_tasks"."id"', operator: "=", value: input.taskId, cast: "uuid" }),
        sqlCompare({ columnSql: '"meeting_tasks"."status"', operator: "<>", value: "dismissed", cast: null }),
      ]);
      const join230 = sqlColCompare({
        leftSql: '"meeting_task_lists"."id"',
        operator: "=",
        rightSql: '"meeting_tasks"."task_list_id"',
      });
      const join231 = sqlColCompare({
        leftSql: '"meetings"."id"',
        operator: "=",
        rightSql: '"meeting_tasks"."meeting_id"',
      });
      const join232 = sqlColCompare({
        leftSql: '"meeting_extractions"."meeting_id"',
        operator: "=",
        rightSql: '"meetings"."id"',
      });
      const limit23 = 1;
      const rows = await decodeContentAliases({
        rows: await db.$queryRaw<rowsRow10[]>`${Prisma.raw(rowsSql4)}${join230}
                      INNER JOIN "meetings" ON ${join231}
                      LEFT JOIN "meeting_extractions" ON ${join232}
                      ${sqlWhereClause(where23)}


                      ${sqlLimit(limit23)}


                      `,
        projections: [
          contentProjection({ model: "meetingTasks", prefix: "task__" }),
          contentProjection({ model: "meetings", prefix: "meeting__" }),
          contentProjection({ model: "meetingExtractions", prefix: "extraction__" }),
        ],
      });

      return rows.map(mapAssignedTaskContextRow);
    })(),
    map: (rows) => rows[0],
  });

  if (!row) {
    return null;
  }
  const participantMeetingIds = await participantMeetingIdSet({ userId: input.userId, meetingIds: [row.meeting.id] });
  const entitledEndedMeetingIds = await entitledEndedMeetingIdSet({ userId: input.userId, meetings: [row.meeting] });
  const canReadTask =
    (row.task.ownerUserId === input.userId || participantMeetingIds.has(row.meeting.id)) &&
    meetingTaskIsVisible({
      meeting: row.meeting,
      userId: input.userId,
      participantMeetingIds,
      entitledEndedMeetingIds,
    });
  if (!canReadTask) {
    return null;
  }

  const task = parseMeetingTaskRow(row.task);
  const taskSegmentIds = new Set(task.sourceQuotes.map((quote) => quote.segmentId).filter(Boolean));
  const extraction = row.extraction ? parseMeetingExtractionRow(row.extraction) : null;
  const relatedDecisions =
    extraction?.decisions
      .filter((decision) =>
        decision.sourceSpans.some((span) => span.segmentIds.some((segmentId) => taskSegmentIds.has(segmentId))),
      )
      .map((decision) => ({
        id: decision.id,
        text: decision.text,
        finality: decision.finality,
      })) ?? [];
  const relatedActionItems =
    extraction?.actionItems
      .filter((actionItem) =>
        actionItem.sourceSpans.some((span) => span.segmentIds.some((segmentId) => taskSegmentIds.has(segmentId))),
      )
      .map((actionItem) => ({
        id: actionItem.id,
        title: actionItem.title,
        description: actionItem.description ?? null,
      })) ?? [];

  return {
    task,
    meeting: {
      id: row.meeting.id,
      workspaceId: row.meeting.workspaceId,
      title: row.meeting.title,
      startedAt: row.meeting.startedAt?.toISOString() ?? null,
      endedAt: row.meeting.endedAt?.toISOString() ?? null,
    },
    summary: null,
    relatedDecisions,
    relatedActionItems,
  };
}

export type RealtimeOutboxJob = {
  id: string;
  channel: string;
  eventName: string;
  payload: Record<string, unknown>;
  attemptCount: number;
};

type ListActiveCapabilitiesResult = Promise<
  {
    sideEffectScope: "none" | "private_draft" | "shared_draft" | "external_action";
    id: string;
    name: string;
    createdAt: Date;
    metadata: Record<string, unknown>;
    updatedAt: Date;
    description: string;
    key: string;
    category:
      | "documentation"
      | "communication"
      | "execution"
      | "state_sync"
      | "coordination"
      | "investigation"
      | "preparation";
    applicableMeetingTypes: (
      | "team_sync"
      | "one_on_one"
      | "sales_call"
      | "customer_success"
      | "product_review"
      | "standup"
      | "hiring_debrief"
      | "exec_review"
      | "planning"
      | "brainstorm"
      | "interview"
      | "retrospective"
      | "postmortem"
      | "manager_check_in"
      | "other"
    )[];
    requiredSignals: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exclusionSignals: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exampleTriggers: string[];
    defaultPriority: number;
    isActive: boolean;
  }[]
>;

export async function listActiveCapabilities(): ListActiveCapabilitiesResult {
  const rows = await mapRow({
    value: db.capabilityCatalog.findMany({
      where: activeCapabilityPredicate(),
      orderBy: [{ defaultPriority: "desc" }, { name: "asc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        category: readStringUnion({
          values: [
            "communication",
            "documentation",
            "execution",
            "state_sync",
            "coordination",
            "investigation",
            "preparation",
          ],
          value: row.category,
        }),
        applicableMeetingTypes: z.array(meetingTypeSchema).parse(row.applicableMeetingTypes),
        requiredSignals: z.array(signalReferenceSchema).parse(row.requiredSignals),
        exclusionSignals: z.array(signalReferenceSchema).parse(row.exclusionSignals),
        exampleTriggers: readStringArray(row.exampleTriggers),
        sideEffectScope: readStringUnion({
          values: ["none", "private_draft", "shared_draft", "external_action"],
          value: row.sideEffectScope,
        }),
        metadata: readJsonObject(row.metadata),
      })),
  });

  return rows.map(parseCapabilityCatalogRow);
}

type ListCapabilitiesForUserResult = Promise<
  {
    isEnabled: boolean;
    sideEffectScope: "none" | "private_draft" | "shared_draft" | "external_action";
    id: string;
    name: string;
    createdAt: Date;
    metadata: Record<string, unknown>;
    updatedAt: Date;
    description: string;
    key: string;
    category:
      | "documentation"
      | "communication"
      | "execution"
      | "state_sync"
      | "coordination"
      | "investigation"
      | "preparation";
    applicableMeetingTypes: (
      | "team_sync"
      | "one_on_one"
      | "sales_call"
      | "customer_success"
      | "product_review"
      | "standup"
      | "hiring_debrief"
      | "exec_review"
      | "planning"
      | "brainstorm"
      | "interview"
      | "retrospective"
      | "postmortem"
      | "manager_check_in"
      | "other"
    )[];
    requiredSignals: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exclusionSignals: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exampleTriggers: string[];
    defaultPriority: number;
    isActive: boolean;
  }[]
>;
type rowsRow11 = {
  capability__id: string;
  capability__key: string;
  capability__name: string;
  capability__description: string;
  capability__category:
    | "communication"
    | "documentation"
    | "execution"
    | "state_sync"
    | "coordination"
    | "investigation"
    | "preparation";
  capability__applicableMeetingTypes: Prisma.JsonValue;
  capability__requiredSignals: Prisma.JsonValue;
  capability__exclusionSignals: Prisma.JsonValue;
  capability__exampleTriggers: Prisma.JsonValue;
  capability__sideEffectScope: "none" | "private_draft" | "shared_draft" | "external_action";
  capability__defaultPriority: number;
  isActive: boolean;
  capability__metadata: Prisma.JsonValue;
  capability__createdAt: Date;
  capability__updatedAt: Date;
  preference__userId: string | null;
  preference__capabilityKey: string | null;
  isEnabled: boolean | null;
  preference__createdAt: Date | null;
  preference__updatedAt: Date | null;
};

const rowsSql5 = `
                     SELECT "capability_catalog"."id" AS "capability__id",
                     "capability_catalog"."key" AS "capability__key",
                     "capability_catalog"."name" AS "capability__name",
                     "capability_catalog"."description" AS "capability__description",
                     "capability_catalog"."category" AS "capability__category",
                     "capability_catalog"."applicable_meeting_types" AS "capability__applicableMeetingTypes",
                     "capability_catalog"."required_signals" AS "capability__requiredSignals",
                     "capability_catalog"."exclusion_signals" AS "capability__exclusionSignals",
                     "capability_catalog"."example_triggers" AS "capability__exampleTriggers",
                     "capability_catalog"."side_effect_scope" AS "capability__sideEffectScope",
                     "capability_catalog"."default_priority" AS "capability__defaultPriority",
                     "capability_catalog"."is_active" AS "isActive",
                     "capability_catalog"."metadata" AS "capability__metadata",
                     "capability_catalog"."created_at" AS "capability__createdAt",
                     "capability_catalog"."updated_at" AS "capability__updatedAt",
                     "user_capability_preferences"."user_id" AS "preference__userId",
                     "user_capability_preferences"."capability_key" AS "preference__capabilityKey",
                     "user_capability_preferences"."is_enabled" AS "isEnabled",
                     "user_capability_preferences"."created_at" AS "preference__createdAt",
                     "user_capability_preferences"."updated_at" AS "preference__updatedAt"
                     FROM "capability_catalog"
                     LEFT JOIN "user_capability_preferences" ON `;

export async function listCapabilitiesForUser(userId: string): ListCapabilitiesForUserResult {
  const rows = await (async () => {
    const where24 = sqlAnd([
      sqlCompare({
        columnSql: '"capability_catalog"."is_active"',
        operator: "=",
        value: comparedValue(true),
        cast: "boolean",
      }),
      sqlIn({
        columnSql: '"capability_catalog"."key"',
        values: [...REMOVED_CAPABILITY_KEYS],
        cast: null,
        isNegated: true,
      }),
    ]);
    const join240 = sqlAnd([
      sqlColCompare({
        leftSql: '"user_capability_preferences"."capability_key"',
        operator: "=",
        rightSql: '"capability_catalog"."key"',
      }),
      sqlCompare({ columnSql: '"user_capability_preferences"."user_id"', operator: "=", value: userId, cast: "uuid" }),
    ]);
    const order24 = sqlOrderBy([
      sqlSort({ columnSql: '"capability_catalog"."default_priority"', direction: "DESC" }),
      sqlSort({ columnSql: '"capability_catalog"."name"', direction: "ASC" }),
    ]);
    const rows = await db.$queryRaw<rowsRow11[]>`${Prisma.raw(rowsSql5)}${join240}
                     ${sqlWhereClause(where24)}

                     ${order24}



                     `;

    return rows.map((row) => ({
      capability: {
        id: row.capability__id,
        key: row.capability__key,
        name: row.capability__name,
        description: row.capability__description,
        category: row.capability__category,
        applicableMeetingTypes: row.capability__applicableMeetingTypes,
        requiredSignals: row.capability__requiredSignals,
        exclusionSignals: row.capability__exclusionSignals,
        exampleTriggers: row.capability__exampleTriggers,
        sideEffectScope: row.capability__sideEffectScope,
        defaultPriority: row.capability__defaultPriority,
        isActive: row.isActive,
        metadata: row.capability__metadata,
        createdAt: row.capability__createdAt,
        updatedAt: row.capability__updatedAt,
      },
      preference:
        row.preference__userId === null
          ? null
          : {
              userId: row.preference__userId,
              capabilityKey: row.preference__capabilityKey,
              isEnabled: row.isEnabled,
              createdAt: row.preference__createdAt,
              updatedAt: row.preference__updatedAt,
            },
    }));
  })();

  return rows.map((row) => ({
    ...parseCapabilityCatalogRow(row.capability),
    isEnabled: row.preference?.isEnabled ?? true,
  }));
}

type ListEnabledCapabilitiesForUserResult = Promise<
  {
    id: string;
    key: string;
    name: string;
    description: string;
    category:
      | "documentation"
      | "communication"
      | "execution"
      | "state_sync"
      | "coordination"
      | "investigation"
      | "preparation";
    applicableMeetingTypes: (
      | "team_sync"
      | "one_on_one"
      | "sales_call"
      | "customer_success"
      | "product_review"
      | "standup"
      | "hiring_debrief"
      | "exec_review"
      | "planning"
      | "brainstorm"
      | "interview"
      | "retrospective"
      | "postmortem"
      | "manager_check_in"
      | "other"
    )[];
    requiredSignals: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exclusionSignals: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exampleTriggers: string[];
    sideEffectScope: "none" | "private_draft" | "shared_draft" | "external_action";
    defaultPriority: number;
    isActive: boolean;
    metadata: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
  }[]
>;

export async function listEnabledCapabilitiesForUser(userId: string): ListEnabledCapabilitiesForUserResult {
  const capabilities = await listCapabilitiesForUser(userId);

  return capabilities
    .filter((capability) => capability.isEnabled)
    .map((capability) => ({
      id: capability.id,
      key: capability.key,
      name: capability.name,
      description: capability.description,
      category: capability.category,
      applicableMeetingTypes: capability.applicableMeetingTypes,
      requiredSignals: capability.requiredSignals,
      exclusionSignals: capability.exclusionSignals,
      exampleTriggers: capability.exampleTriggers,
      sideEffectScope: capability.sideEffectScope,
      defaultPriority: capability.defaultPriority,
      isActive: capability.isActive,
      metadata: capability.metadata,
      createdAt: capability.createdAt,
      updatedAt: capability.updatedAt,
    }));
}

type GetCapabilityByKeyResult = Promise<{
  sideEffectScope: "none" | "private_draft" | "shared_draft" | "external_action";
  id: string;
  name: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
  updatedAt: Date;
  description: string;
  key: string;
  category:
    | "documentation"
    | "communication"
    | "execution"
    | "state_sync"
    | "coordination"
    | "investigation"
    | "preparation";
  applicableMeetingTypes: (
    | "team_sync"
    | "one_on_one"
    | "sales_call"
    | "customer_success"
    | "product_review"
    | "standup"
    | "hiring_debrief"
    | "exec_review"
    | "planning"
    | "brainstorm"
    | "interview"
    | "retrospective"
    | "postmortem"
    | "manager_check_in"
    | "other"
  )[];
  requiredSignals: {
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    description?: string | undefined;
  }[];
  exclusionSignals: {
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    description?: string | undefined;
  }[];
  exampleTriggers: string[];
  defaultPriority: number;
  isActive: boolean;
} | null>;

export async function getCapabilityByKey(key: string): GetCapabilityByKeyResult {
  if (readStringArray(REMOVED_CAPABILITY_KEYS).includes(key)) {
    return null;
  }

  const row = await mapRow({
    value: db.capabilityCatalog.findFirst({
      where: { key },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            category: readStringUnion({
              values: [
                "communication",
                "documentation",
                "execution",
                "state_sync",
                "coordination",
                "investigation",
                "preparation",
              ],
              value: row.category,
            }),
            applicableMeetingTypes: z.array(meetingTypeSchema).parse(row.applicableMeetingTypes),
            requiredSignals: z.array(signalReferenceSchema).parse(row.requiredSignals),
            exclusionSignals: z.array(signalReferenceSchema).parse(row.exclusionSignals),
            exampleTriggers: readStringArray(row.exampleTriggers),
            sideEffectScope: readStringUnion({
              values: ["none", "private_draft", "shared_draft", "external_action"],
              value: row.sideEffectScope,
            }),
            metadata: readJsonObject(row.metadata),
          },
  });

  return row ? parseCapabilityCatalogRow(row) : null;
}

type UpsertUserCapabilityPreferenceResult = Promise<{
  isEnabled: boolean;
  sideEffectScope: "none" | "private_draft" | "shared_draft" | "external_action";
  id: string;
  name: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
  updatedAt: Date;
  description: string;
  key: string;
  category:
    | "documentation"
    | "communication"
    | "execution"
    | "state_sync"
    | "coordination"
    | "investigation"
    | "preparation";
  applicableMeetingTypes: (
    | "team_sync"
    | "one_on_one"
    | "sales_call"
    | "customer_success"
    | "product_review"
    | "standup"
    | "hiring_debrief"
    | "exec_review"
    | "planning"
    | "brainstorm"
    | "interview"
    | "retrospective"
    | "postmortem"
    | "manager_check_in"
    | "other"
  )[];
  requiredSignals: {
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    description?: string | undefined;
  }[];
  exclusionSignals: {
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    description?: string | undefined;
  }[];
  exampleTriggers: string[];
  defaultPriority: number;
  isActive: boolean;
} | null>;

export async function upsertUserCapabilityPreference(input: {
  userId: string;
  capabilityKey: string;
  isEnabled: boolean;
}): UpsertUserCapabilityPreferenceResult {
  if (readStringArray(REMOVED_CAPABILITY_KEYS).includes(input.capabilityKey)) {
    return null;
  }

  await db.userCapabilityPreferences.upsert({
    where: { userId_capabilityKey: { userId: input.userId, capabilityKey: input.capabilityKey } },
    create: input,
    update: {
      isEnabled: input.isEnabled,
      updatedAt: new Date(),
    },
  });

  const capabilities = await listCapabilitiesForUser(input.userId);

  return capabilities.find((capability) => capability.key === input.capabilityKey) ?? null;
}

export async function getUserMediaPreferences(
  userId: string,
): Promise<{ /** @external existing wire contract */ backgroundBlurEnabled: boolean }> {
  const row = await mapRow({
    value: db.userMediaPreferences.findFirst({
      where: { userId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return {
    /** @external existing wire contract */ backgroundBlurEnabled: row?.backgroundBlurEnabled ?? false,
  };
}

export async function upsertUserMediaPreferences(input: {
  userId: string;
  /** @external existing wire contract */ backgroundBlurEnabled: boolean;
}): Promise<{ /** @external existing wire contract */ backgroundBlurEnabled: boolean }> {
  const row = await db.userMediaPreferences.upsert({
    where: { userId: input.userId },
    create: input,
    update: {
      backgroundBlurEnabled: input.backgroundBlurEnabled,
      updatedAt: new Date(),
    },
  });

  return {
    /** @external existing wire contract */ backgroundBlurEnabled: row.backgroundBlurEnabled,
  };
}

type ListCapabilitiesForMeetingTypeResult = Promise<
  {
    sideEffectScope: "none" | "private_draft" | "shared_draft" | "external_action";
    id: string;
    name: string;
    createdAt: Date;
    metadata: Record<string, unknown>;
    updatedAt: Date;
    description: string;
    key: string;
    category:
      | "documentation"
      | "communication"
      | "execution"
      | "state_sync"
      | "coordination"
      | "investigation"
      | "preparation";
    applicableMeetingTypes: (
      | "team_sync"
      | "one_on_one"
      | "sales_call"
      | "customer_success"
      | "product_review"
      | "standup"
      | "hiring_debrief"
      | "exec_review"
      | "planning"
      | "brainstorm"
      | "interview"
      | "retrospective"
      | "postmortem"
      | "manager_check_in"
      | "other"
    )[];
    requiredSignals: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exclusionSignals: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exampleTriggers: string[];
    defaultPriority: number;
    isActive: boolean;
  }[]
>;

export async function listCapabilitiesForMeetingType(meetingType: MeetingType): ListCapabilitiesForMeetingTypeResult {
  const rows = await mapRow({
    value: db.capabilityCatalog.findMany({
      where: activeCapabilityPredicate(),
      orderBy: [{ defaultPriority: "desc" }, { name: "asc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        category: readStringUnion({
          values: [
            "communication",
            "documentation",
            "execution",
            "state_sync",
            "coordination",
            "investigation",
            "preparation",
          ],
          value: row.category,
        }),
        applicableMeetingTypes: z.array(meetingTypeSchema).parse(row.applicableMeetingTypes),
        requiredSignals: z.array(signalReferenceSchema).parse(row.requiredSignals),
        exclusionSignals: z.array(signalReferenceSchema).parse(row.exclusionSignals),
        exampleTriggers: readStringArray(row.exampleTriggers),
        sideEffectScope: readStringUnion({
          values: ["none", "private_draft", "shared_draft", "external_action"],
          value: row.sideEffectScope,
        }),
        metadata: readJsonObject(row.metadata),
      })),
  });

  return rows.filter((row) => row.applicableMeetingTypes.includes(meetingType)).map(parseCapabilityCatalogRow);
}

type UpsertCapabilityResult = Promise<{
  sideEffectScope: "none" | "private_draft" | "shared_draft" | "external_action";
  id: string;
  name: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
  updatedAt: Date;
  description: string;
  key: string;
  category:
    | "documentation"
    | "communication"
    | "execution"
    | "state_sync"
    | "coordination"
    | "investigation"
    | "preparation";
  applicableMeetingTypes: (
    | "team_sync"
    | "one_on_one"
    | "sales_call"
    | "customer_success"
    | "product_review"
    | "standup"
    | "hiring_debrief"
    | "exec_review"
    | "planning"
    | "brainstorm"
    | "interview"
    | "retrospective"
    | "postmortem"
    | "manager_check_in"
    | "other"
  )[];
  requiredSignals: {
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    description?: string | undefined;
  }[];
  exclusionSignals: {
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    description?: string | undefined;
  }[];
  exampleTriggers: string[];
  defaultPriority: number;
  isActive: boolean;
}>;

export async function upsertCapability(capability: CapabilityCatalogInput): UpsertCapabilityResult {
  const parsedCapability = capabilityCatalogInputSchema.parse(capability);

  const row = await mapRow({
    value: db.capabilityCatalog.upsert({
      where: { key: parsedCapability.key },
      create: {
        ...parsedCapability,
        applicableMeetingTypes: jsonInput(parsedCapability.applicableMeetingTypes),
        requiredSignals: jsonInput(parsedCapability.requiredSignals),
        exclusionSignals: jsonInput(parsedCapability.exclusionSignals),
        exampleTriggers: jsonInput(parsedCapability.exampleTriggers),
        metadata: jsonInput(parsedCapability.metadata),
      },
      update: {
        name: parsedCapability.name,
        description: parsedCapability.description,
        category: parsedCapability.category,
        applicableMeetingTypes: jsonInput(parsedCapability.applicableMeetingTypes),
        requiredSignals: jsonInput(parsedCapability.requiredSignals),
        exclusionSignals: jsonInput(parsedCapability.exclusionSignals),
        exampleTriggers: jsonInput(parsedCapability.exampleTriggers),
        sideEffectScope: parsedCapability.sideEffectScope,
        defaultPriority: parsedCapability.defaultPriority,
        isActive: parsedCapability.isActive,
        metadata: jsonInput(parsedCapability.metadata),
        updatedAt: new Date(),
      },
    }),
    map: (row) => ({
      ...row,
      category: readStringUnion({
        values: [
          "communication",
          "documentation",
          "execution",
          "state_sync",
          "coordination",
          "investigation",
          "preparation",
        ],
        value: row.category,
      }),
      applicableMeetingTypes: z.array(meetingTypeSchema).parse(row.applicableMeetingTypes),
      requiredSignals: z.array(signalReferenceSchema).parse(row.requiredSignals),
      exclusionSignals: z.array(signalReferenceSchema).parse(row.exclusionSignals),
      exampleTriggers: readStringArray(row.exampleTriggers),
      sideEffectScope: readStringUnion({
        values: ["none", "private_draft", "shared_draft", "external_action"],
        value: row.sideEffectScope,
      }),
      metadata: readJsonObject(row.metadata),
    }),
  });

  return parseCapabilityCatalogRow(row);
}

type GetExtractionByMeetingIdResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "partial";
  meetingType:
    | "team_sync"
    | "one_on_one"
    | "sales_call"
    | "customer_success"
    | "product_review"
    | "standup"
    | "hiring_debrief"
    | "exec_review"
    | "planning"
    | "brainstorm"
    | "interview"
    | "retrospective"
    | "postmortem"
    | "manager_check_in"
    | "other"
    | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  durationMs: number | null;
  actionItems: {
    id: string;
    title: string;
    confidence: "low" | "medium" | "high";
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    description?: string | undefined;
    ownerHint?:
      | {
          name: string;
          confidence: "low" | "medium" | "high";
        }
      | undefined;
    dueHint?:
      | {
          text: string;
          confidence: "low" | "medium" | "high";
          isoDate?: string | null | undefined;
        }
      | undefined;
  }[];
  transcriptHash: string;
  contentStatus: "pending" | "completed" | "failed" | "running" | "partial";
  signalsStatus: "pending" | "completed" | "failed" | "running" | "partial";
  meetingTypeConfidence: "low" | "medium" | "high" | null;
  meetingTypeReasoning: string | null;
  participants: {
    name: string;
    confidence: "low" | "medium" | "high";
    roleHint?: string | null | undefined;
  }[];
  summaryShort: string | null;
  summaryBullets: string[];
  decisions: {
    id: string;
    text: string;
    confidence: "low" | "medium" | "high";
    finality: "final" | "tentative" | "provisional";
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
  }[];
  openQuestions: {
    id: string;
    text: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    priority: "low" | "medium" | "high";
  }[];
  risks: {
    id: string;
    text: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    severity: "low" | "medium" | "high";
  }[];
  highlights: {
    id: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    theme: string;
    takeaway: string;
  }[];
  keyTopics: string[];
  signals: {
    confidence: "low" | "medium" | "high";
    key: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    createdAt?: string | undefined;
    origin?:
      | {
          kind: "manual" | "core_model" | "core_rule" | "custom_model" | "custom_rule";
          promptVersion?: string | undefined;
          model?: string | undefined;
          ruleId?: string | undefined;
          signalDefinitionVersion?: string | undefined;
        }
      | undefined;
    namespace?: "user" | "readymeet.core" | "readymeet.engineering" | "readymeet.sales" | "agent" | undefined;
    definitionId?: string | null | undefined;
    evidence?:
      | {
          excerpt: string;
          lineStart: number;
          lineEnd: number;
          segmentIds: string[];
          startedAt?: string | null | undefined;
          endedAt?: string | null | undefined;
          verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
          verificationReason?: string | undefined;
          sourceSpanIndex?: number | undefined;
        }[]
      | undefined;
    entities?: Record<string, unknown> | undefined;
    sourcePhase?:
      | "content_extraction"
      | "signal_extraction"
      | "deterministic_inference"
      | "custom_signal_detection"
      | "manual_override"
      | undefined;
    reasoning?: string | undefined;
  }[];
  failedToolCalls: {
    error: string;
    toolName: string;
    occurredAt: string;
    rawInput?: unknown;
  }[];
  extractionModel: string;
  extractionPromptVersion: string;
} | null>;

export async function getExtractionByMeetingId(meetingId: string): GetExtractionByMeetingIdResult {
  const row = await db.meetingExtractions.findFirst({
    where: { meetingId },
    take: 1,
  });

  return row ? parseMeetingExtractionRow(row) : null;
}

type GetExtractionByIdResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "partial";
  meetingType:
    | "team_sync"
    | "one_on_one"
    | "sales_call"
    | "customer_success"
    | "product_review"
    | "standup"
    | "hiring_debrief"
    | "exec_review"
    | "planning"
    | "brainstorm"
    | "interview"
    | "retrospective"
    | "postmortem"
    | "manager_check_in"
    | "other"
    | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  durationMs: number | null;
  actionItems: {
    id: string;
    title: string;
    confidence: "low" | "medium" | "high";
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    description?: string | undefined;
    ownerHint?:
      | {
          name: string;
          confidence: "low" | "medium" | "high";
        }
      | undefined;
    dueHint?:
      | {
          text: string;
          confidence: "low" | "medium" | "high";
          isoDate?: string | null | undefined;
        }
      | undefined;
  }[];
  transcriptHash: string;
  contentStatus: "pending" | "completed" | "failed" | "running" | "partial";
  signalsStatus: "pending" | "completed" | "failed" | "running" | "partial";
  meetingTypeConfidence: "low" | "medium" | "high" | null;
  meetingTypeReasoning: string | null;
  participants: {
    name: string;
    confidence: "low" | "medium" | "high";
    roleHint?: string | null | undefined;
  }[];
  summaryShort: string | null;
  summaryBullets: string[];
  decisions: {
    id: string;
    text: string;
    confidence: "low" | "medium" | "high";
    finality: "final" | "tentative" | "provisional";
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
  }[];
  openQuestions: {
    id: string;
    text: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    priority: "low" | "medium" | "high";
  }[];
  risks: {
    id: string;
    text: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    severity: "low" | "medium" | "high";
  }[];
  highlights: {
    id: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    theme: string;
    takeaway: string;
  }[];
  keyTopics: string[];
  signals: {
    confidence: "low" | "medium" | "high";
    key: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    createdAt?: string | undefined;
    origin?:
      | {
          kind: "manual" | "core_model" | "core_rule" | "custom_model" | "custom_rule";
          promptVersion?: string | undefined;
          model?: string | undefined;
          ruleId?: string | undefined;
          signalDefinitionVersion?: string | undefined;
        }
      | undefined;
    namespace?: "user" | "readymeet.core" | "readymeet.engineering" | "readymeet.sales" | "agent" | undefined;
    definitionId?: string | null | undefined;
    evidence?:
      | {
          excerpt: string;
          lineStart: number;
          lineEnd: number;
          segmentIds: string[];
          startedAt?: string | null | undefined;
          endedAt?: string | null | undefined;
          verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
          verificationReason?: string | undefined;
          sourceSpanIndex?: number | undefined;
        }[]
      | undefined;
    entities?: Record<string, unknown> | undefined;
    sourcePhase?:
      | "content_extraction"
      | "signal_extraction"
      | "deterministic_inference"
      | "custom_signal_detection"
      | "manual_override"
      | undefined;
    reasoning?: string | undefined;
  }[];
  failedToolCalls: {
    error: string;
    toolName: string;
    occurredAt: string;
    rawInput?: unknown;
  }[];
  extractionModel: string;
  extractionPromptVersion: string;
} | null>;

export async function getExtractionById(id: string): GetExtractionByIdResult {
  const row = await db.meetingExtractions.findFirst({
    where: { id },
    take: 1,
  });

  return row ? parseMeetingExtractionRow(row) : null;
}

export async function getExtractionStatus(
  id: string,
): Promise<"pending" | "completed" | "failed" | "running" | "partial" | null> {
  const row = await mapRow({
    value: db.meetingExtractions.findFirst({
      where: { id },
      take: 1,
      select: {
        status: true,
      },
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: readStringUnion({
              values: ["pending", "running", "completed", "partial", "failed"],
              value: row.status,
            }),
          },
  });

  return row ? extractionStatusSchema.parse(row.status) : null;
}

type ListExtractionsByStatusResult = Promise<
  {
    status: "pending" | "completed" | "failed" | "running" | "partial";
    meetingType:
      | "team_sync"
      | "one_on_one"
      | "sales_call"
      | "customer_success"
      | "product_review"
      | "standup"
      | "hiring_debrief"
      | "exec_review"
      | "planning"
      | "brainstorm"
      | "interview"
      | "retrospective"
      | "postmortem"
      | "manager_check_in"
      | "other"
      | null;
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    startedAt: string | null;
    meetingId: string;
    durationMs: number | null;
    actionItems: {
      id: string;
      title: string;
      confidence: "low" | "medium" | "high";
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      description?: string | undefined;
      ownerHint?:
        | {
            name: string;
            confidence: "low" | "medium" | "high";
          }
        | undefined;
      dueHint?:
        | {
            text: string;
            confidence: "low" | "medium" | "high";
            isoDate?: string | null | undefined;
          }
        | undefined;
    }[];
    transcriptHash: string;
    contentStatus: "pending" | "completed" | "failed" | "running" | "partial";
    signalsStatus: "pending" | "completed" | "failed" | "running" | "partial";
    meetingTypeConfidence: "low" | "medium" | "high" | null;
    meetingTypeReasoning: string | null;
    participants: {
      name: string;
      confidence: "low" | "medium" | "high";
      roleHint?: string | null | undefined;
    }[];
    summaryShort: string | null;
    summaryBullets: string[];
    decisions: {
      id: string;
      text: string;
      confidence: "low" | "medium" | "high";
      finality: "final" | "tentative" | "provisional";
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
    }[];
    openQuestions: {
      id: string;
      text: string;
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      priority: "low" | "medium" | "high";
    }[];
    risks: {
      id: string;
      text: string;
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      severity: "low" | "medium" | "high";
    }[];
    highlights: {
      id: string;
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      theme: string;
      takeaway: string;
    }[];
    keyTopics: string[];
    signals: {
      confidence: "low" | "medium" | "high";
      key: string;
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      createdAt?: string | undefined;
      origin?:
        | {
            kind: "manual" | "core_model" | "core_rule" | "custom_model" | "custom_rule";
            promptVersion?: string | undefined;
            model?: string | undefined;
            ruleId?: string | undefined;
            signalDefinitionVersion?: string | undefined;
          }
        | undefined;
      namespace?: "user" | "readymeet.core" | "readymeet.engineering" | "readymeet.sales" | "agent" | undefined;
      definitionId?: string | null | undefined;
      evidence?:
        | {
            excerpt: string;
            lineStart: number;
            lineEnd: number;
            segmentIds: string[];
            startedAt?: string | null | undefined;
            endedAt?: string | null | undefined;
            verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
            verificationReason?: string | undefined;
            sourceSpanIndex?: number | undefined;
          }[]
        | undefined;
      entities?: Record<string, unknown> | undefined;
      sourcePhase?:
        | "content_extraction"
        | "signal_extraction"
        | "deterministic_inference"
        | "custom_signal_detection"
        | "manual_override"
        | undefined;
      reasoning?: string | undefined;
    }[];
    failedToolCalls: {
      error: string;
      toolName: string;
      occurredAt: string;
      rawInput?: unknown;
    }[];
    extractionModel: string;
    extractionPromptVersion: string;
  }[]
>;

export async function listExtractionsByStatus(status: ExtractionStatus): ListExtractionsByStatusResult {
  const rows = await db.meetingExtractions.findMany({
    where: { status },
    orderBy: [{ updatedAt: "desc" }],
  });

  return rows.map(parseMeetingExtractionRow);
}

type GetExtractionsWithSignalResult = Promise<
  {
    status: "pending" | "completed" | "failed" | "running" | "partial";
    meetingType:
      | "team_sync"
      | "one_on_one"
      | "sales_call"
      | "customer_success"
      | "product_review"
      | "standup"
      | "hiring_debrief"
      | "exec_review"
      | "planning"
      | "brainstorm"
      | "interview"
      | "retrospective"
      | "postmortem"
      | "manager_check_in"
      | "other"
      | null;
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    startedAt: string | null;
    meetingId: string;
    durationMs: number | null;
    actionItems: {
      id: string;
      title: string;
      confidence: "low" | "medium" | "high";
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      description?: string | undefined;
      ownerHint?:
        | {
            name: string;
            confidence: "low" | "medium" | "high";
          }
        | undefined;
      dueHint?:
        | {
            text: string;
            confidence: "low" | "medium" | "high";
            isoDate?: string | null | undefined;
          }
        | undefined;
    }[];
    transcriptHash: string;
    contentStatus: "pending" | "completed" | "failed" | "running" | "partial";
    signalsStatus: "pending" | "completed" | "failed" | "running" | "partial";
    meetingTypeConfidence: "low" | "medium" | "high" | null;
    meetingTypeReasoning: string | null;
    participants: {
      name: string;
      confidence: "low" | "medium" | "high";
      roleHint?: string | null | undefined;
    }[];
    summaryShort: string | null;
    summaryBullets: string[];
    decisions: {
      id: string;
      text: string;
      confidence: "low" | "medium" | "high";
      finality: "final" | "tentative" | "provisional";
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
    }[];
    openQuestions: {
      id: string;
      text: string;
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      priority: "low" | "medium" | "high";
    }[];
    risks: {
      id: string;
      text: string;
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      severity: "low" | "medium" | "high";
    }[];
    highlights: {
      id: string;
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      theme: string;
      takeaway: string;
    }[];
    keyTopics: string[];
    signals: {
      confidence: "low" | "medium" | "high";
      key: string;
      sourceSpans: {
        excerpt: string;
        lineStart: number;
        lineEnd: number;
        segmentIds: string[];
        startedAt?: string | null | undefined;
        endedAt?: string | null | undefined;
        verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
        verificationReason?: string | undefined;
      }[];
      createdAt?: string | undefined;
      origin?:
        | {
            kind: "manual" | "core_model" | "core_rule" | "custom_model" | "custom_rule";
            promptVersion?: string | undefined;
            model?: string | undefined;
            ruleId?: string | undefined;
            signalDefinitionVersion?: string | undefined;
          }
        | undefined;
      namespace?: "user" | "readymeet.core" | "readymeet.engineering" | "readymeet.sales" | "agent" | undefined;
      definitionId?: string | null | undefined;
      evidence?:
        | {
            excerpt: string;
            lineStart: number;
            lineEnd: number;
            segmentIds: string[];
            startedAt?: string | null | undefined;
            endedAt?: string | null | undefined;
            verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
            verificationReason?: string | undefined;
            sourceSpanIndex?: number | undefined;
          }[]
        | undefined;
      entities?: Record<string, unknown> | undefined;
      sourcePhase?:
        | "content_extraction"
        | "signal_extraction"
        | "deterministic_inference"
        | "custom_signal_detection"
        | "manual_override"
        | undefined;
      reasoning?: string | undefined;
    }[];
    failedToolCalls: {
      error: string;
      toolName: string;
      occurredAt: string;
      rawInput?: unknown;
    }[];
    extractionModel: string;
    extractionPromptVersion: string;
  }[]
>;

export async function getExtractionsWithSignal(signalKey: SignalKey): GetExtractionsWithSignalResult {
  const rows = await db.meetingExtractions.findMany({
    orderBy: [{ updatedAt: "desc" }],
  });

  return rows
    .filter((row) =>
      z
        .array(signalPresenceSchema)
        .parse(row.signals)
        .some((signal) => signal.key === signalKey),
    )
    .map(parseMeetingExtractionRow);
}

type UpsertMeetingExtractionResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "partial";
  meetingType:
    | "team_sync"
    | "one_on_one"
    | "sales_call"
    | "customer_success"
    | "product_review"
    | "standup"
    | "hiring_debrief"
    | "exec_review"
    | "planning"
    | "brainstorm"
    | "interview"
    | "retrospective"
    | "postmortem"
    | "manager_check_in"
    | "other"
    | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  durationMs: number | null;
  actionItems: {
    id: string;
    title: string;
    confidence: "low" | "medium" | "high";
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    description?: string | undefined;
    ownerHint?:
      | {
          name: string;
          confidence: "low" | "medium" | "high";
        }
      | undefined;
    dueHint?:
      | {
          text: string;
          confidence: "low" | "medium" | "high";
          isoDate?: string | null | undefined;
        }
      | undefined;
  }[];
  transcriptHash: string;
  contentStatus: "pending" | "completed" | "failed" | "running" | "partial";
  signalsStatus: "pending" | "completed" | "failed" | "running" | "partial";
  meetingTypeConfidence: "low" | "medium" | "high" | null;
  meetingTypeReasoning: string | null;
  participants: {
    name: string;
    confidence: "low" | "medium" | "high";
    roleHint?: string | null | undefined;
  }[];
  summaryShort: string | null;
  summaryBullets: string[];
  decisions: {
    id: string;
    text: string;
    confidence: "low" | "medium" | "high";
    finality: "final" | "tentative" | "provisional";
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
  }[];
  openQuestions: {
    id: string;
    text: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    priority: "low" | "medium" | "high";
  }[];
  risks: {
    id: string;
    text: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    severity: "low" | "medium" | "high";
  }[];
  highlights: {
    id: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    theme: string;
    takeaway: string;
  }[];
  keyTopics: string[];
  signals: {
    confidence: "low" | "medium" | "high";
    key: string;
    sourceSpans: {
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      segmentIds: string[];
      startedAt?: string | null | undefined;
      endedAt?: string | null | undefined;
      verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
      verificationReason?: string | undefined;
    }[];
    createdAt?: string | undefined;
    origin?:
      | {
          kind: "manual" | "core_model" | "core_rule" | "custom_model" | "custom_rule";
          promptVersion?: string | undefined;
          model?: string | undefined;
          ruleId?: string | undefined;
          signalDefinitionVersion?: string | undefined;
        }
      | undefined;
    namespace?: "user" | "readymeet.core" | "readymeet.engineering" | "readymeet.sales" | "agent" | undefined;
    definitionId?: string | null | undefined;
    evidence?:
      | {
          excerpt: string;
          lineStart: number;
          lineEnd: number;
          segmentIds: string[];
          startedAt?: string | null | undefined;
          endedAt?: string | null | undefined;
          verificationStatus?: "verified" | "corrected" | "unverified" | undefined;
          verificationReason?: string | undefined;
          sourceSpanIndex?: number | undefined;
        }[]
      | undefined;
    entities?: Record<string, unknown> | undefined;
    sourcePhase?:
      | "content_extraction"
      | "signal_extraction"
      | "deterministic_inference"
      | "custom_signal_detection"
      | "manual_override"
      | undefined;
    reasoning?: string | undefined;
  }[];
  failedToolCalls: {
    error: string;
    toolName: string;
    occurredAt: string;
    rawInput?: unknown;
  }[];
  extractionModel: string;
  extractionPromptVersion: string;
}>;

type MeetingExtractionPersistenceInput = {
  meetingId: string;
  status: ExtractionStatus;
  contentStatus?: ExtractionStatus;
  signalsStatus?: ExtractionStatus;
  meetingType?: MeetingType | null;
  meetingTypeConfidence?: ExtractionConfidence | null;
  meetingTypeReasoning?: string | null;
  participants?: MeetingExtraction["participants"];
  summaryShort?: string | null;
  summaryBullets?: string[];
  decisions?: MeetingExtraction["decisions"];
  actionItems?: MeetingExtraction["actionItems"];
  openQuestions?: MeetingExtraction["openQuestions"];
  risks?: MeetingExtraction["risks"];
  highlights?: MeetingExtraction["highlights"];
  keyTopics?: string[];
  signals?: MeetingExtraction["signals"];
  failedToolCalls?: MeetingExtraction["failedToolCalls"];
  extractionModel: string;
  extractionPromptVersion: string;
  transcriptHash: string;
  durationMs?: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
};

function meetingExtractionLifecycleFields(input: MeetingExtractionPersistenceInput) {
  return {
    meetingId: input.meetingId,
    status: input.status,
    contentStatus: input.contentStatus ?? input.status,
    signalsStatus: input.signalsStatus ?? input.status,
    extractionModel: input.extractionModel,
    extractionPromptVersion: input.extractionPromptVersion,
    transcriptHash: input.transcriptHash,
    durationMs: input.durationMs ?? null,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
  };
}

function meetingExtractionClassificationFields(input: MeetingExtractionPersistenceInput) {
  return {
    meetingType: input.meetingType ?? null,
    meetingTypeConfidence: input.meetingTypeConfidence ?? null,
    meetingTypeReasoning: input.meetingTypeReasoning ?? null,
  };
}

function meetingExtractionContentFields(input: MeetingExtractionPersistenceInput) {
  return {
    participants: jsonInput(input.participants ?? []),
    summaryShort: input.summaryShort ?? null,
    summaryBullets: jsonInput(input.summaryBullets ?? []),
    decisions: jsonInput(input.decisions ?? []),
    actionItems: jsonInput(input.actionItems ?? []),
    openQuestions: jsonInput(input.openQuestions ?? []),
    risks: jsonInput(input.risks ?? []),
    highlights: jsonInput(input.highlights ?? []),
    keyTopics: jsonInput(input.keyTopics ?? []),
    signals: jsonInput(input.signals ?? []),
    failedToolCalls: jsonInput(input.failedToolCalls ?? []),
  };
}

function meetingExtractionPersistenceValues(input: MeetingExtractionPersistenceInput) {
  return {
    ...meetingExtractionLifecycleFields(input),
    ...meetingExtractionClassificationFields(input),
    ...meetingExtractionContentFields(input),
  };
}
type upsertMeetingExtractionRow12 = {
  meetingId: string;
  status: ExtractionStatus;
  contentStatus?: ExtractionStatus;
  signalsStatus?: ExtractionStatus;
  meetingType?: MeetingType | null;
  meetingTypeConfidence?: ExtractionConfidence | null;
  meetingTypeReasoning?: string | null;
  participants?: MeetingExtraction["participants"];
  summaryShort?: string | null;
  summaryBullets?: string[];
  decisions?: MeetingExtraction["decisions"];
  actionItems?: MeetingExtraction["actionItems"];
  openQuestions?: MeetingExtraction["openQuestions"];
  risks?: MeetingExtraction["risks"];
  highlights?: MeetingExtraction["highlights"];
  keyTopics?: string[];
  signals?: MeetingExtraction["signals"];
  failedToolCalls?: MeetingExtraction["failedToolCalls"];
  extractionModel: string;
  extractionPromptVersion: string;
  transcriptHash: string;
  durationMs?: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
};

export async function upsertMeetingExtraction(input: upsertMeetingExtractionRow12): UpsertMeetingExtractionResult {
  const persistenceValues = meetingExtractionPersistenceValues(input);
  const row = await db.meetingExtractions.upsert({
    where: { meetingId: persistenceValues.meetingId },
    create: persistenceValues,
    update: {
      ...persistenceValues,
      updatedAt: new Date(),
    },
  });

  return parseMeetingExtractionRow(row);
}

type GetRecommendationsByExtractionIdResult = Promise<
  {
    id: string;
    createdAt: string;
    meetingId: string;
    payload: Record<string, unknown>;
    confidence: "low" | "medium" | "high";
    capabilityKey: string;
    reasoning: string;
    extractionId: string;
    rank: number;
    rawScore: number;
    finalScore: number;
    signalsMatched: {
      confidence: "low" | "medium" | "high";
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      score: number;
      description?: string | undefined;
    }[];
    signalsMissing: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exclusionSignalsChecked: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      /** @external existing wire contract */ present: boolean;
      /** @external existing wire contract */ excluded: boolean;
      description?: string | undefined;
      confidence?: "low" | "medium" | "high" | undefined;
    }[];
    selectionPromptVersion: string;
    selectionModel: string;
  }[]
>;

export async function getRecommendationsByExtractionId(
  ...args: [extractionId: string, selectionPromptVersion?: string]
): GetRecommendationsByExtractionIdResult {
  const [extractionId, selectionPromptVersion] = args;
  const rows = await mapRow({
    value: db.meetingCapabilityRecommendations.findMany({
      where:
        selectionPromptVersion !== undefined && selectionPromptVersion !== ""
          ? whereAnd([{ extractionId }, { selectionPromptVersion }])
          : { extractionId },
      orderBy: [{ rank: "asc" }, { createdAt: "desc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        signalsMatched: z.array(recommendationSignalMatchSchema).parse(row.signalsMatched),
        signalsMissing: z.array(recommendationMissingSignalSchema).parse(row.signalsMissing),
        exclusionSignalsChecked: z.array(recommendationExclusionSignalCheckSchema).parse(row.exclusionSignalsChecked),
        payload: readJsonObject(row.payload),
        confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
      })),
  });

  return rows.map(parseCapabilityRecommendationRow);
}

type GetRecommendationsByMeetingIdResult = Promise<
  {
    id: string;
    createdAt: string;
    meetingId: string;
    payload: Record<string, unknown>;
    confidence: "low" | "medium" | "high";
    capabilityKey: string;
    reasoning: string;
    extractionId: string;
    rank: number;
    rawScore: number;
    finalScore: number;
    signalsMatched: {
      confidence: "low" | "medium" | "high";
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      score: number;
      description?: string | undefined;
    }[];
    signalsMissing: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exclusionSignalsChecked: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      /** @external existing wire contract */ present: boolean;
      /** @external existing wire contract */ excluded: boolean;
      description?: string | undefined;
      confidence?: "low" | "medium" | "high" | undefined;
    }[];
    selectionPromptVersion: string;
    selectionModel: string;
  }[]
>;

export async function getRecommendationsByMeetingId(meetingId: string): GetRecommendationsByMeetingIdResult {
  const latest = await mapRow({
    value: db.meetingCapabilityRecommendations.findFirst({
      where: { meetingId },
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            signalsMatched: z.array(recommendationSignalMatchSchema).parse(row.signalsMatched),
            signalsMissing: z.array(recommendationMissingSignalSchema).parse(row.signalsMissing),
            exclusionSignalsChecked: z
              .array(recommendationExclusionSignalCheckSchema)
              .parse(row.exclusionSignalsChecked),
            payload: readJsonObject(row.payload),
            confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
          },
  });

  if (!latest) {
    return [];
  }

  const rows = await mapRow({
    value: db.meetingCapabilityRecommendations.findMany({
      where: whereAnd([
        { meetingId },
        { extractionId: latest.extractionId },
        { selectionPromptVersion: latest.selectionPromptVersion },
      ]),
      orderBy: [{ rank: "asc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        signalsMatched: z.array(recommendationSignalMatchSchema).parse(row.signalsMatched),
        signalsMissing: z.array(recommendationMissingSignalSchema).parse(row.signalsMissing),
        exclusionSignalsChecked: z.array(recommendationExclusionSignalCheckSchema).parse(row.exclusionSignalsChecked),
        payload: readJsonObject(row.payload),
        confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
      })),
  });

  return rows.map(parseCapabilityRecommendationRow);
}

type GetRecommendationByIdResult = Promise<{
  id: string;
  createdAt: string;
  meetingId: string;
  payload: Record<string, unknown>;
  confidence: "low" | "medium" | "high";
  capabilityKey: string;
  reasoning: string;
  extractionId: string;
  rank: number;
  rawScore: number;
  finalScore: number;
  signalsMatched: {
    confidence: "low" | "medium" | "high";
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    score: number;
    description?: string | undefined;
  }[];
  signalsMissing: {
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    description?: string | undefined;
  }[];
  exclusionSignalsChecked: {
    key:
      | "external_participants_present"
      | "decisions_made"
      | "open_questions_remain"
      | "action_commitments_made"
      | "customer_objections_raised"
      | "crm_relevant_context"
      | "product_or_feature_discussion"
      | "engineering_issue_identified"
      | "follow_up_meeting_referenced"
      | "research_question_identified"
      | "web_research_task_identified"
      | "purely_informational"
      | "routine_status_sync";
    /** @external existing wire contract */ present: boolean;
    /** @external existing wire contract */ excluded: boolean;
    description?: string | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
  }[];
  selectionPromptVersion: string;
  selectionModel: string;
} | null>;

export async function getRecommendationById(recommendationId: string): GetRecommendationByIdResult {
  const row = await mapRow({
    value: db.meetingCapabilityRecommendations.findFirst({
      where: { id: recommendationId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            signalsMatched: z.array(recommendationSignalMatchSchema).parse(row.signalsMatched),
            signalsMissing: z.array(recommendationMissingSignalSchema).parse(row.signalsMissing),
            exclusionSignalsChecked: z
              .array(recommendationExclusionSignalCheckSchema)
              .parse(row.exclusionSignalsChecked),
            payload: readJsonObject(row.payload),
            confidence: readStringUnion({ values: ["low", "medium", "high"], value: row.confidence }),
          },
  });

  return row ? parseCapabilityRecommendationRow(row) : null;
}

export async function deleteRecommendationsByExtractionId(
  ...args: [extractionId: string, selectionPromptVersion?: string]
): Promise<void> {
  const [extractionId, selectionPromptVersion] = args;
  await db.meetingCapabilityRecommendations.deleteMany({
    where:
      selectionPromptVersion !== undefined && selectionPromptVersion !== ""
        ? whereAnd([{ extractionId }, { selectionPromptVersion }])
        : { extractionId },
  });
}

type InsertCapabilityRecommendationsResult = Promise<
  {
    id: string;
    createdAt: string;
    meetingId: string;
    payload: Record<string, unknown>;
    confidence: "low" | "medium" | "high";
    capabilityKey: string;
    reasoning: string;
    extractionId: string;
    rank: number;
    rawScore: number;
    finalScore: number;
    signalsMatched: {
      confidence: "low" | "medium" | "high";
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      score: number;
      description?: string | undefined;
    }[];
    signalsMissing: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      description?: string | undefined;
    }[];
    exclusionSignalsChecked: {
      key:
        | "external_participants_present"
        | "decisions_made"
        | "open_questions_remain"
        | "action_commitments_made"
        | "customer_objections_raised"
        | "crm_relevant_context"
        | "product_or_feature_discussion"
        | "engineering_issue_identified"
        | "follow_up_meeting_referenced"
        | "research_question_identified"
        | "web_research_task_identified"
        | "purely_informational"
        | "routine_status_sync";
      /** @external existing wire contract */ present: boolean;
      /** @external existing wire contract */ excluded: boolean;
      description?: string | undefined;
      confidence?: "low" | "medium" | "high" | undefined;
    }[];
    selectionPromptVersion: string;
    selectionModel: string;
  }[]
>;

export async function insertCapabilityRecommendations(
  recommendations: {
    meetingId: string;
    extractionId: string;
    capabilityKey: string;
    rank: number;
    rawScore: number;
    finalScore: number;
    signalsMatched: CapabilityRecommendationRow["signalsMatched"];
    signalsMissing: CapabilityRecommendationRow["signalsMissing"];
    exclusionSignalsChecked: CapabilityRecommendationRow["exclusionSignalsChecked"];
    reasoning: string;
    payload: Record<string, unknown>;
    confidence: ExtractionConfidence;
    selectionPromptVersion: string;
    selectionModel: string;
  }[],
): InsertCapabilityRecommendationsResult {
  if (recommendations.length === 0) {
    return [];
  }
  const firstRecommendation = recommendations[0];
  if (firstRecommendation === undefined) {
    return [];
  }

  await mapRow({
    value: insertRaw<Prisma.meetingCapabilityRecommendationsModel>({
      executor: db,
      table: "meeting_capability_recommendations",
      rows: recommendations,
      columns: [
        { key: "id", column: "id", cast: "uuid" },
        { key: "meetingId", column: "meeting_id", cast: "uuid" },
        { key: "extractionId", column: "extraction_id", cast: "uuid" },
        { key: "capabilityKey", column: "capability_key", cast: null },
        { key: "rank", column: "rank", cast: "int" },
        { key: "rawScore", column: "raw_score", cast: "int" },
        { key: "finalScore", column: "final_score", cast: "int" },
        { key: "signalsMatched", column: "signals_matched", cast: "jsonb" },
        { key: "signalsMissing", column: "signals_missing", cast: "jsonb" },
        { key: "exclusionSignalsChecked", column: "exclusion_signals_checked", cast: "jsonb" },
        { key: "reasoning", column: "reasoning", cast: null },
        { key: "payload", column: "payload", cast: "jsonb" },
        { key: "confidence", column: "confidence", cast: null },
        { key: "selectionPromptVersion", column: "selection_prompt_version", cast: null },
        { key: "selectionModel", column: "selection_model", cast: null },
        { key: "createdAt", column: "created_at", cast: "timestamptz" },
      ],
      conflict: sqlConflictNothing({
        targetSql: 'ON CONFLICT ("extraction_id", "capability_key", "selection_prompt_version")',
        where: undefined,
      }),
      returning: Prisma.raw(
        '"id" AS "id", "meeting_id" AS "meetingId", "extraction_id" AS "extractionId", "capability_key" AS "capabilityKey", "rank" AS "rank", "raw_score" AS "rawScore", "final_score" AS "finalScore", "signals_matched" AS "signalsMatched", "signals_missing" AS "signalsMissing", "exclusion_signals_checked" AS "exclusionSignalsChecked", "reasoning" AS "reasoning", "payload" AS "payload", "confidence" AS "confidence", "selection_prompt_version" AS "selectionPromptVersion", "selection_model" AS "selectionModel", "created_at" AS "createdAt"',
      ),
    }),
    map: () => undefined,
  });

  return getRecommendationsByExtractionId(firstRecommendation.extractionId, firstRecommendation.selectionPromptVersion);
}

type ListCapabilityWorkflowRunsForMeetingResult = Promise<
  {
    status: "pending" | "completed" | "failed" | "running" | "ready" | "awaiting_user" | "needs_connection";
    error: string | null;
    id: string;
    plan: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    meetingId: string;
    result: Record<string, unknown>;
    phase:
      | "failed"
      | "syncing"
      | "needs_connection"
      | "checking_connection"
      | "reviewing_evidence"
      | "scoping_issues"
      | "validating_issue_evidence"
      | "searching_linear"
      | "preparing_drafts"
      | "reading_meeting"
      | "analyzing_meeting"
      | "generating_feedback"
      | "gathering_context"
      | "drafting_plan"
      | "awaiting_user_review"
      | "revising_plan"
      | "ready_to_sync"
      | "synced";
    context: Record<string, unknown>;
    capabilityKey: string;
    recommendationId: string;
    draft: Record<string, unknown>;
  }[]
>;

export async function listCapabilityWorkflowRunsForMeeting(
  meetingId: string,
): ListCapabilityWorkflowRunsForMeetingResult {
  const rows = await mapRow({
    value: db.capabilityWorkflowRuns.findMany({
      where: { meetingId },
      orderBy: [{ createdAt: "desc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: capabilityWorkflowStatusSchema.parse(row.status),
        phase: capabilityWorkflowPhaseSchema.parse(row.phase),
        context: readJsonObject(row.context),
        plan: readJsonObject(row.plan),
        draft: readJsonObject(row.draft),
        result: readJsonObject(row.result),
      })),
  });

  return rows.map(parseCapabilityWorkflowRunRow);
}

type GetCapabilityWorkflowRunByIdResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "ready" | "awaiting_user" | "needs_connection";
  error: string | null;
  id: string;
  plan: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  phase:
    | "failed"
    | "syncing"
    | "needs_connection"
    | "checking_connection"
    | "reviewing_evidence"
    | "scoping_issues"
    | "validating_issue_evidence"
    | "searching_linear"
    | "preparing_drafts"
    | "reading_meeting"
    | "analyzing_meeting"
    | "generating_feedback"
    | "gathering_context"
    | "drafting_plan"
    | "awaiting_user_review"
    | "revising_plan"
    | "ready_to_sync"
    | "synced";
  context: Record<string, unknown>;
  capabilityKey: string;
  recommendationId: string;
  draft: Record<string, unknown>;
} | null>;

export async function getCapabilityWorkflowRunById(workflowRunId: string): GetCapabilityWorkflowRunByIdResult {
  const row = await mapRow({
    value: db.capabilityWorkflowRuns.findFirst({
      where: { id: workflowRunId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: capabilityWorkflowStatusSchema.parse(row.status),
            phase: capabilityWorkflowPhaseSchema.parse(row.phase),
            context: readJsonObject(row.context),
            plan: readJsonObject(row.plan),
            draft: readJsonObject(row.draft),
            result: readJsonObject(row.result),
          },
  });

  return row ? parseCapabilityWorkflowRunRow(row) : null;
}

type GetCapabilityWorkflowRunByRecommendationIdResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "ready" | "awaiting_user" | "needs_connection";
  error: string | null;
  id: string;
  plan: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  phase:
    | "failed"
    | "syncing"
    | "needs_connection"
    | "checking_connection"
    | "reviewing_evidence"
    | "scoping_issues"
    | "validating_issue_evidence"
    | "searching_linear"
    | "preparing_drafts"
    | "reading_meeting"
    | "analyzing_meeting"
    | "generating_feedback"
    | "gathering_context"
    | "drafting_plan"
    | "awaiting_user_review"
    | "revising_plan"
    | "ready_to_sync"
    | "synced";
  context: Record<string, unknown>;
  capabilityKey: string;
  recommendationId: string;
  draft: Record<string, unknown>;
} | null>;

export async function getCapabilityWorkflowRunByRecommendationId(
  recommendationId: string,
): GetCapabilityWorkflowRunByRecommendationIdResult {
  const row = await mapRow({
    value: db.capabilityWorkflowRuns.findFirst({
      where: { recommendationId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: capabilityWorkflowStatusSchema.parse(row.status),
            phase: capabilityWorkflowPhaseSchema.parse(row.phase),
            context: readJsonObject(row.context),
            plan: readJsonObject(row.plan),
            draft: readJsonObject(row.draft),
            result: readJsonObject(row.result),
          },
  });

  return row ? parseCapabilityWorkflowRunRow(row) : null;
}

type UpsertCapabilityWorkflowRunResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "ready" | "awaiting_user" | "needs_connection";
  error: string | null;
  id: string;
  plan: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  phase:
    | "failed"
    | "syncing"
    | "needs_connection"
    | "checking_connection"
    | "reviewing_evidence"
    | "scoping_issues"
    | "validating_issue_evidence"
    | "searching_linear"
    | "preparing_drafts"
    | "reading_meeting"
    | "analyzing_meeting"
    | "generating_feedback"
    | "gathering_context"
    | "drafting_plan"
    | "awaiting_user_review"
    | "revising_plan"
    | "ready_to_sync"
    | "synced";
  context: Record<string, unknown>;
  capabilityKey: string;
  recommendationId: string;
  draft: Record<string, unknown>;
}>;

export async function upsertCapabilityWorkflowRun(input: {
  meetingId: string;
  recommendationId: string;
  capabilityKey: string;
  status: CapabilityWorkflowStatus;
  phase: CapabilityWorkflowPhase;
  context?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  draft?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string | null;
  completedAt?: Date | null;
}): UpsertCapabilityWorkflowRunResult {
  const row = await mapRow({
    value: (async () => {
      const data = {
        meetingId: input.meetingId,
        recommendationId: input.recommendationId,
        capabilityKey: input.capabilityKey,
        status: input.status,
        phase: input.phase,
        context: jsonInput(input.context ?? {}),
        plan: jsonInput(input.plan ?? {}),
        draft: jsonInput(input.draft ?? {}),
        result: jsonInput(input.result ?? {}),
        error: input.error ?? null,
        completedAt: input.completedAt ?? null,
      };

      return db.capabilityWorkflowRuns.upsert({
        where: { recommendationId: data.recommendationId },
        create: data,
        update: {
          status: input.status,
          phase: input.phase,
          context: input.context === undefined ? undefined : jsonInput(input.context),
          plan: input.plan === undefined ? undefined : jsonInput(input.plan),
          draft: input.draft === undefined ? undefined : jsonInput(input.draft),
          result: input.result === undefined ? undefined : jsonInput(input.result),
          error: input.error ?? null,
          completedAt: input.completedAt ?? null,
          updatedAt: new Date(),
        },
      });
    })(),
    map: (row) => ({
      ...row,
      status: capabilityWorkflowStatusSchema.parse(row.status),
      phase: capabilityWorkflowPhaseSchema.parse(row.phase),
      context: readJsonObject(row.context),
      plan: readJsonObject(row.plan),
      draft: readJsonObject(row.draft),
      result: readJsonObject(row.result),
    }),
  });

  return parseCapabilityWorkflowRunRow(row);
}

type UpdateCapabilityWorkflowRunResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "ready" | "awaiting_user" | "needs_connection";
  error: string | null;
  id: string;
  plan: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  phase:
    | "failed"
    | "syncing"
    | "needs_connection"
    | "checking_connection"
    | "reviewing_evidence"
    | "scoping_issues"
    | "validating_issue_evidence"
    | "searching_linear"
    | "preparing_drafts"
    | "reading_meeting"
    | "analyzing_meeting"
    | "generating_feedback"
    | "gathering_context"
    | "drafting_plan"
    | "awaiting_user_review"
    | "revising_plan"
    | "ready_to_sync"
    | "synced";
  context: Record<string, unknown>;
  capabilityKey: string;
  recommendationId: string;
  draft: Record<string, unknown>;
}>;

export async function updateCapabilityWorkflowRun(input: {
  workflowRunId: string;
  status?: CapabilityWorkflowStatus;
  phase?: CapabilityWorkflowPhase;
  context?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  draft?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string | null;
  completedAt?: Date | null;
}): UpdateCapabilityWorkflowRunResult {
  const [row] = await mapRow({
    value: db.capabilityWorkflowRuns.updateManyAndReturn({
      where: { id: input.workflowRunId },
      data: {
        status: input.status,
        phase: input.phase,
        context: input.context === undefined ? undefined : jsonInput(input.context),
        plan: input.plan === undefined ? undefined : jsonInput(input.plan),
        draft: input.draft === undefined ? undefined : jsonInput(input.draft),
        result: input.result === undefined ? undefined : jsonInput(input.result),
        error: input.error,
        completedAt: input.completedAt,
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: capabilityWorkflowStatusSchema.parse(row.status),
        phase: capabilityWorkflowPhaseSchema.parse(row.phase),
        context: readJsonObject(row.context),
        plan: readJsonObject(row.plan),
        draft: readJsonObject(row.draft),
        result: readJsonObject(row.result),
      })),
  });

  if (!row) {
    throw new Error(FAILED_TO_UPDATE_CAPABILITY_WORKFLOW_RUN_MESSAGE);
  }

  return parseCapabilityWorkflowRunRow(row);
}

export async function addCapabilityWorkflowMessage(input: {
  workflowRunId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<{
  id: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  role: "assistant" | "user" | "system";
  content: string;
  workflowRunId: string;
}> {
  const row = await mapRow({
    value: db.capabilityWorkflowMessages.create({
      data: {
        workflowRunId: input.workflowRunId,
        role: input.role,
        content: input.content,
        metadata: jsonInput(input.metadata ?? {}),
      },
    }),
    map: (row) => ({ ...row, metadata: readJsonObject(row.metadata) }),
  });

  return parseCapabilityWorkflowMessageRow(row);
}

export async function listCapabilityWorkflowMessages(workflowRunId: string): Promise<
  {
    id: string;
    createdAt: string;
    metadata: Record<string, unknown>;
    role: "assistant" | "user" | "system";
    content: string;
    workflowRunId: string;
  }[]
> {
  const rows = await mapRow({
    value: db.capabilityWorkflowMessages.findMany({
      where: { workflowRunId },
      orderBy: [{ createdAt: "asc" }],
    }),
    map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
  });

  return rows.map(parseCapabilityWorkflowMessageRow);
}

type GetSuggestedActionRunByMeetingIdResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "cancelled" | "skipped" | "no_work_found";
  phase:
    | "reading_notes"
    | "complete"
    | "extracting_facts"
    | "validating_evidence"
    | "detecting_signals"
    | "matching_agents"
    | "preparing_work";
  steps: {
    status: "pending" | "completed" | "failed" | "running" | "skipped";
    id:
      | "reading_notes"
      | "extracting_facts"
      | "validating_evidence"
      | "detecting_signals"
      | "matching_agents"
      | "preparing_work";
    label: string;
  }[];
  selectedRecommendationIds: string[];
  message: string | null;
  error: string | null;
  id: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  startedAt: Date | null;
  meetingId: string;
} | null>;

export async function getSuggestedActionRunByMeetingId(meetingId: string): GetSuggestedActionRunByMeetingIdResult {
  const row = await mapRow({
    value: db.meetingSuggestedActionRuns.findFirst({
      where: { meetingId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return row ? parseSuggestedActionRunRow(row) : null;
}

type UpsertSuggestedActionRunResult = Promise<{
  status: "pending" | "completed" | "failed" | "running" | "cancelled" | "skipped" | "no_work_found";
  phase:
    | "reading_notes"
    | "complete"
    | "extracting_facts"
    | "validating_evidence"
    | "detecting_signals"
    | "matching_agents"
    | "preparing_work";
  steps: {
    status: "pending" | "completed" | "failed" | "running" | "skipped";
    id:
      | "reading_notes"
      | "extracting_facts"
      | "validating_evidence"
      | "detecting_signals"
      | "matching_agents"
      | "preparing_work";
    label: string;
  }[];
  selectedRecommendationIds: string[];
  message: string | null;
  error: string | null;
  id: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  startedAt: Date | null;
  meetingId: string;
}>;

export async function upsertSuggestedActionRun(input: {
  meetingId: string;
  status: SuggestedActionRunStatus;
  phase: SuggestedActionRunPhase;
  steps: SuggestedActionStep[];
  message?: string | null;
  error?: string | null;
  selectedRecommendationIds?: string[];
  startedAt?: Date | null;
  completedAt?: Date | null;
}): UpsertSuggestedActionRunResult {
  const row = await (async () => {
    const data = {
      meetingId: input.meetingId,
      status: input.status,
      phase: input.phase,
      steps: jsonInput(input.steps),
      message: input.message ?? null,
      error: input.error ?? null,
      selectedRecommendationIds: jsonInput(input.selectedRecommendationIds ?? []),
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
    };

    return db.meetingSuggestedActionRuns.upsert({
      where: { meetingId: data.meetingId },
      create: data,
      update: {
        status: input.status,
        phase: input.phase,
        steps: jsonInput(input.steps),
        message: input.message ?? null,
        error: input.error ?? null,
        selectedRecommendationIds: jsonInput(input.selectedRecommendationIds ?? []),
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        updatedAt: new Date(),
      },
    });
  })();

  return parseSuggestedActionRunRow(row);
}

async function loadLinearTaskReviewRun(row: Prisma.linearTaskReviewRunsModel | undefined) {
  if (!row) {
    return null;
  }
  const items = await db.linearTaskReviewItems.findMany({
    where: { runId: row.id },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });

  return parseLinearTaskReviewRunRow({ row, items });
}

type GetLatestLinearTaskReviewForMeetingResult = Promise<{
  status:
    | "completed"
    | "failed"
    | "queued"
    | "stale"
    | "reviewing"
    | "awaiting_user"
    | "revising"
    | "syncing"
    | "no_matches"
    | "needs_connection";
  error: string | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  promptVersion: string | null;
  connectorId: string | null;
  model: string | null;
  phase: string;
  taskListId: string;
  inputHash: string;
  items: {
    id: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    syncStatus: "pending" | "failed" | "syncing" | "created" | "skipped";
    position: number;
    description: string | null;
    confidence: number;
    reasoning: string;
    runId: string;
    sourceTaskIds: string[];
    decision: "linear" | "uncertain";
    issueDraft: {
      evidence: { quote: string; speaker: string | null; timestamp: string | null; segmentId: string | null }[];
      problem: string;
      observedBehavior: string | null;
      expectedBehavior: string | null;
      requestedChange: string | null;
      reproductionSteps: string[];
      impact: string | null;
    } | null;
    teamId: string | null;
    teamName: string | null;
    /** @external existing wire contract */ included: boolean;
    syncError: string | null;
    duplicateIssues: {
      status: string | null;
      id: string;
      title: string;
      url: string;
      identifier: string;
      rationale: string;
    }[];
    targetAction: "create" | "link_existing" | "create_duplicate";
    targetIssue: { id: string; title: string; url: string; identifier: string } | null;
    relationId: string | null;
    meetingContextSyncedAt: string | null;
    externalIssue: { id: string; title: string; url: string; identifier: string } | null;
  }[];
} | null>;

export async function getLatestLinearTaskReviewForMeeting(
  meetingId: string,
): GetLatestLinearTaskReviewForMeetingResult {
  const row = await mapRow({
    value: db.linearTaskReviewRuns.findFirst({
      where: { meetingId },
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: linearTaskReviewStatusSchema.parse(row.status),
            inputSnapshot: readUnknownArray(row.inputSnapshot),
          },
  });

  return loadLinearTaskReviewRun(row);
}

type GetLinearTaskReviewByIdResult = Promise<{
  status:
    | "completed"
    | "failed"
    | "queued"
    | "stale"
    | "reviewing"
    | "awaiting_user"
    | "revising"
    | "syncing"
    | "no_matches"
    | "needs_connection";
  error: string | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  promptVersion: string | null;
  connectorId: string | null;
  model: string | null;
  phase: string;
  taskListId: string;
  inputHash: string;
  items: {
    id: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    syncStatus: "pending" | "failed" | "syncing" | "created" | "skipped";
    position: number;
    description: string | null;
    confidence: number;
    reasoning: string;
    runId: string;
    sourceTaskIds: string[];
    decision: "linear" | "uncertain";
    issueDraft: {
      evidence: { quote: string; speaker: string | null; timestamp: string | null; segmentId: string | null }[];
      problem: string;
      observedBehavior: string | null;
      expectedBehavior: string | null;
      requestedChange: string | null;
      reproductionSteps: string[];
      impact: string | null;
    } | null;
    teamId: string | null;
    teamName: string | null;
    /** @external existing wire contract */ included: boolean;
    syncError: string | null;
    duplicateIssues: {
      status: string | null;
      id: string;
      title: string;
      url: string;
      identifier: string;
      rationale: string;
    }[];
    targetAction: "create" | "link_existing" | "create_duplicate";
    targetIssue: { id: string; title: string; url: string; identifier: string } | null;
    relationId: string | null;
    meetingContextSyncedAt: string | null;
    externalIssue: { id: string; title: string; url: string; identifier: string } | null;
  }[];
} | null>;

export async function getLinearTaskReviewById(runId: string): GetLinearTaskReviewByIdResult {
  const row = await mapRow({
    value: db.linearTaskReviewRuns.findFirst({
      where: { id: runId },
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: linearTaskReviewStatusSchema.parse(row.status),
            inputSnapshot: readUnknownArray(row.inputSnapshot),
          },
  });

  return loadLinearTaskReviewRun(row);
}

export async function getLinearTaskReviewInputSnapshot(runId: string): Promise<unknown[]> {
  const row = await mapRow({
    value: db.linearTaskReviewRuns.findFirst({
      where: { id: runId },
      take: 1,
      select: {
        inputSnapshot: true,
      },
    }),
    map: (row) => (row === null ? undefined : { ...row, inputSnapshot: readUnknownArray(row.inputSnapshot) }),
  });

  return row?.inputSnapshot ?? [];
}

type CreateLinearTaskReviewRunResult = Promise<{
  status:
    | "completed"
    | "failed"
    | "queued"
    | "stale"
    | "reviewing"
    | "awaiting_user"
    | "revising"
    | "syncing"
    | "no_matches"
    | "needs_connection";
  error: string | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  promptVersion: string | null;
  connectorId: string | null;
  model: string | null;
  phase: string;
  taskListId: string;
  inputHash: string;
  items: {
    id: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    syncStatus: "pending" | "failed" | "syncing" | "created" | "skipped";
    position: number;
    description: string | null;
    confidence: number;
    reasoning: string;
    runId: string;
    sourceTaskIds: string[];
    decision: "linear" | "uncertain";
    issueDraft: {
      evidence: { quote: string; speaker: string | null; timestamp: string | null; segmentId: string | null }[];
      problem: string;
      observedBehavior: string | null;
      expectedBehavior: string | null;
      requestedChange: string | null;
      reproductionSteps: string[];
      impact: string | null;
    } | null;
    teamId: string | null;
    teamName: string | null;
    /** @external existing wire contract */ included: boolean;
    syncError: string | null;
    duplicateIssues: {
      status: string | null;
      id: string;
      title: string;
      url: string;
      identifier: string;
      rationale: string;
    }[];
    targetAction: "create" | "link_existing" | "create_duplicate";
    targetIssue: { id: string; title: string; url: string; identifier: string } | null;
    relationId: string | null;
    meetingContextSyncedAt: string | null;
    externalIssue: { id: string; title: string; url: string; identifier: string } | null;
  }[];
}>;

export async function createLinearTaskReviewRun(input: {
  meetingId: string;
  taskListId: string;
  userId: string;
  connectorId: string;
  inputHash: string;
  inputSnapshot: unknown[];
  promptVersion?: string | null;
}): CreateLinearTaskReviewRunResult {
  const created = await mapRow({
    value: mapRow({
      value: insertRaw<Prisma.linearTaskReviewRunsModel>({
        executor: db,
        table: "linear_task_review_runs",
        rows: [
          {
            meetingId: input.meetingId,
            taskListId: input.taskListId,
            userId: input.userId,
            connectorId: input.connectorId,
            inputHash: input.inputHash,
            inputSnapshot: input.inputSnapshot,
            promptVersion: input.promptVersion ?? null,
            status: "queued",
            phase: "queued",
          },
        ],
        columns: [
          { key: "id", column: "id", cast: "uuid" },
          { key: "meetingId", column: "meeting_id", cast: "uuid" },
          { key: "taskListId", column: "task_list_id", cast: "uuid" },
          { key: "userId", column: "user_id", cast: "uuid" },
          { key: "connectorId", column: "connector_id", cast: "uuid" },
          { key: "status", column: "status", cast: null },
          { key: "phase", column: "phase", cast: null },
          { key: "inputHash", column: "input_hash", cast: null },
          { key: "model", column: "model", cast: null },
          { key: "promptVersion", column: "prompt_version", cast: null },
          { key: "error", column: "error", cast: null },
          { key: "startedAt", column: "started_at", cast: "timestamptz" },
          { key: "completedAt", column: "completed_at", cast: "timestamptz" },
          { key: "createdAt", column: "created_at", cast: "timestamptz" },
          { key: "updatedAt", column: "updated_at", cast: "timestamptz" },
          { key: "inputSnapshot", column: "input_snapshot", cast: "jsonb" },
        ],
        conflict: sqlConflictNothing({ targetSql: 'ON CONFLICT ("meeting_id", "input_hash")', where: undefined }),
        returning: Prisma.raw(
          '"id" AS "id", "meeting_id" AS "meetingId", "task_list_id" AS "taskListId", "user_id" AS "userId", "connector_id" AS "connectorId", "status" AS "status", "phase" AS "phase", "input_hash" AS "inputHash", "model" AS "model", "prompt_version" AS "promptVersion", "error" AS "error", "started_at" AS "startedAt", "completed_at" AS "completedAt", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "input_snapshot" AS "inputSnapshot"',
        ),
      }),
      map: (rows) => rows[0],
    }),
    map: (row) =>
      row === undefined
        ? undefined
        : {
            ...row,
            status: linearTaskReviewStatusSchema.parse(row.status),
            inputSnapshot: readUnknownArray(row.inputSnapshot),
          },
  });
  if (created) {
    return parseLinearTaskReviewRunRow({ row: created, items: [] });
  }
  const existing = await mapRow({
    value: db.linearTaskReviewRuns.findFirst({
      where: whereAnd([{ meetingId: input.meetingId }, { inputHash: input.inputHash }]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            status: linearTaskReviewStatusSchema.parse(row.status),
            inputSnapshot: readUnknownArray(row.inputSnapshot),
          },
  });
  const run = await loadLinearTaskReviewRun(existing);
  if (!run) {
    throw new Error(failedToCreateLinearTaskReviewForMeetingMessage(input.meetingId));
  }

  return run;
}

type UpdateLinearTaskReviewRunResult = Promise<{
  status:
    | "completed"
    | "failed"
    | "queued"
    | "stale"
    | "reviewing"
    | "awaiting_user"
    | "revising"
    | "syncing"
    | "no_matches"
    | "needs_connection";
  error: string | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  promptVersion: string | null;
  connectorId: string | null;
  model: string | null;
  phase: string;
  taskListId: string;
  inputHash: string;
  items: {
    id: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    syncStatus: "pending" | "failed" | "syncing" | "created" | "skipped";
    position: number;
    description: string | null;
    confidence: number;
    reasoning: string;
    runId: string;
    sourceTaskIds: string[];
    decision: "linear" | "uncertain";
    issueDraft: {
      evidence: { quote: string; speaker: string | null; timestamp: string | null; segmentId: string | null }[];
      problem: string;
      observedBehavior: string | null;
      expectedBehavior: string | null;
      requestedChange: string | null;
      reproductionSteps: string[];
      impact: string | null;
    } | null;
    teamId: string | null;
    teamName: string | null;
    /** @external existing wire contract */ included: boolean;
    syncError: string | null;
    duplicateIssues: {
      status: string | null;
      id: string;
      title: string;
      url: string;
      identifier: string;
      rationale: string;
    }[];
    targetAction: "create" | "link_existing" | "create_duplicate";
    targetIssue: { id: string; title: string; url: string; identifier: string } | null;
    relationId: string | null;
    meetingContextSyncedAt: string | null;
    externalIssue: { id: string; title: string; url: string; identifier: string } | null;
  }[];
}>;

export async function updateLinearTaskReviewRun(input: {
  runId: string;
  status?: LinearTaskReviewStatus;
  phase?: string;
  connectorId?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}): UpdateLinearTaskReviewRunResult {
  const [row] = await mapRow({
    value: db.linearTaskReviewRuns.updateManyAndReturn({
      where: { id: input.runId },
      data: {
        status: input.status,
        phase: input.phase,
        connectorId: input.connectorId,
        model: input.model,
        promptVersion: input.promptVersion,
        error: input.error,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: linearTaskReviewStatusSchema.parse(row.status),
        inputSnapshot: readUnknownArray(row.inputSnapshot),
      })),
  });
  const run = await loadLinearTaskReviewRun(row);
  if (!run) {
    throw new Error(linearTaskReviewWasNotFoundMessage(input.runId));
  }

  return run;
}

/**
 * Atomically claims a user-confirmed review action. Only one revision or sync
 * request can transition an awaiting run, preventing concurrent side effects
 * and preventing a revision from replacing items while they are being synced.
 */
type ClaimLinearTaskReviewRunActionResult = Promise<{
  status:
    | "completed"
    | "failed"
    | "queued"
    | "stale"
    | "reviewing"
    | "awaiting_user"
    | "revising"
    | "syncing"
    | "no_matches"
    | "needs_connection";
  error: string | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  promptVersion: string | null;
  connectorId: string | null;
  model: string | null;
  phase: string;
  taskListId: string;
  inputHash: string;
  items: {
    id: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    syncStatus: "pending" | "failed" | "syncing" | "created" | "skipped";
    position: number;
    description: string | null;
    confidence: number;
    reasoning: string;
    runId: string;
    sourceTaskIds: string[];
    decision: "linear" | "uncertain";
    issueDraft: {
      evidence: { quote: string; speaker: string | null; timestamp: string | null; segmentId: string | null }[];
      problem: string;
      observedBehavior: string | null;
      expectedBehavior: string | null;
      requestedChange: string | null;
      reproductionSteps: string[];
      impact: string | null;
    } | null;
    teamId: string | null;
    teamName: string | null;
    /** @external existing wire contract */ included: boolean;
    syncError: string | null;
    duplicateIssues: {
      status: string | null;
      id: string;
      title: string;
      url: string;
      identifier: string;
      rationale: string;
    }[];
    targetAction: "create" | "link_existing" | "create_duplicate";
    targetIssue: { id: string; title: string; url: string; identifier: string } | null;
    relationId: string | null;
    meetingContextSyncedAt: string | null;
    externalIssue: { id: string; title: string; url: string; identifier: string } | null;
  }[];
} | null>;

export async function claimLinearTaskReviewRunAction(input: {
  runId: string;
  status: Extract<LinearTaskReviewStatus, "revising" | "syncing">;
  phase: string;
}): ClaimLinearTaskReviewRunActionResult {
  const [row] = await mapRow({
    value: db.linearTaskReviewRuns.updateManyAndReturn({
      where: whereAnd([{ id: input.runId }, { status: "awaiting_user" }]),
      data: {
        status: input.status,
        phase: input.phase,
        error: null,
        completedAt: null,
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: linearTaskReviewStatusSchema.parse(row.status),
        inputSnapshot: readUnknownArray(row.inputSnapshot),
      })),
  });

  return loadLinearTaskReviewRun(row);
}

type ReplaceLinearTaskReviewItemsResult = Promise<{
  status:
    | "completed"
    | "failed"
    | "queued"
    | "stale"
    | "reviewing"
    | "awaiting_user"
    | "revising"
    | "syncing"
    | "no_matches"
    | "needs_connection";
  error: string | null;
  id: string;
  createdAt: string;
  userId: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  promptVersion: string | null;
  connectorId: string | null;
  model: string | null;
  phase: string;
  taskListId: string;
  inputHash: string;
  items: {
    id: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    syncStatus: "pending" | "failed" | "syncing" | "created" | "skipped";
    position: number;
    description: string | null;
    confidence: number;
    reasoning: string;
    runId: string;
    sourceTaskIds: string[];
    decision: "linear" | "uncertain";
    issueDraft: {
      evidence: { quote: string; speaker: string | null; timestamp: string | null; segmentId: string | null }[];
      problem: string;
      observedBehavior: string | null;
      expectedBehavior: string | null;
      requestedChange: string | null;
      reproductionSteps: string[];
      impact: string | null;
    } | null;
    teamId: string | null;
    teamName: string | null;
    /** @external existing wire contract */ included: boolean;
    syncError: string | null;
    duplicateIssues: {
      status: string | null;
      id: string;
      title: string;
      url: string;
      identifier: string;
      rationale: string;
    }[];
    targetAction: "create" | "link_existing" | "create_duplicate";
    targetIssue: { id: string; title: string; url: string; identifier: string } | null;
    relationId: string | null;
    meetingContextSyncedAt: string | null;
    externalIssue: { id: string; title: string; url: string; identifier: string } | null;
  }[];
}>;

export async function replaceLinearTaskReviewItems(input: {
  runId: string;
  candidates: (LinearTaskReviewCandidate & { /** @external existing wire contract */ included?: boolean })[];
}): ReplaceLinearTaskReviewItemsResult {
  await (async () => {
    await db.linearTaskReviewItems.deleteMany({
      where: { runId: input.runId },
    });
    if (input.candidates.length === 0) {
      return;
    }
    await db.linearTaskReviewItems.createMany({
      data: input.candidates.map((candidate, position) => ({
        runId: input.runId,
        position,
        sourceTaskIds: jsonInput([...new Set(candidate.sourceTaskIds)]),
        decision: candidate.decision === "not_linear" ? "uncertain" : candidate.decision,
        confidence: Math.round(candidate.confidence * CONFIDENCE_PERCENT_SCALE),
        reasoning: candidate.reasoning,
        title: candidate.title,
        description: candidate.description,
        issueDraft: jsonInput(candidate.issueDraft),
        teamId: candidate.teamId,
        teamName: candidate.teamName,
        /** @external existing wire contract */ included: candidate.included ?? true,
        duplicateIssues: jsonInput(candidate.duplicateIssues),
        targetAction: candidate.targetAction,
        targetIssue: jsonInput(candidate.targetIssue),
        relationId: candidate.relationId,
        syncStatus: "pending" as const,
      })),
    });
  })();
  const run = await getLinearTaskReviewById(input.runId);
  if (!run) {
    throw new Error(linearTaskReviewWasNotFoundMessage(input.runId));
  }

  return run;
}

type UpdateLinearTaskReviewItemResult = Promise<{
  id: string;
  runId: string;
  position: number;
  sourceTaskIds: string[];
  decision: "linear" | "uncertain";
  confidence: number;
  reasoning: string;
  title: string;
  description: string | null;
  issueDraft: {
    evidence: { quote: string; speaker: string | null; timestamp: string | null; segmentId: string | null }[];
    problem: string;
    observedBehavior: string | null;
    expectedBehavior: string | null;
    requestedChange: string | null;
    reproductionSteps: string[];
    impact: string | null;
  } | null;
  teamId: string | null;
  teamName: string | null;
  /** @external existing wire contract */ included: boolean;
  syncStatus: "pending" | "failed" | "syncing" | "created" | "skipped";
  syncError: string | null;
  duplicateIssues: {
    status: string | null;
    id: string;
    title: string;
    url: string;
    identifier: string;
    rationale: string;
  }[];
  targetAction: "create" | "link_existing" | "create_duplicate";
  targetIssue: { id: string; title: string; url: string; identifier: string } | null;
  relationId: string | null;
  meetingContextSyncedAt: string | null;
  externalIssue: { id: string; identifier: string; title: string; url: string } | null;
  createdAt: string;
  updatedAt: string;
} | null>;

export async function updateLinearTaskReviewItem(input: {
  itemId: string;
  syncStatus?: LinearTaskReviewSyncStatus;
  syncError?: string | null;
  targetAction?: LinearTaskReviewCandidate["targetAction"];
  targetIssue?: LinearTaskReviewCandidate["targetIssue"];
  relationId?: string | null;
  meetingContextSyncedAt?: Date | null;
  externalIssue?: { id: string; identifier: string; title: string; url: string } | null;
}): UpdateLinearTaskReviewItemResult {
  const [row] = await db.linearTaskReviewItems.updateManyAndReturn({
    where: { id: input.itemId },
    data: {
      syncStatus: input.syncStatus,
      syncError: input.syncError,
      targetAction: input.targetAction,
      targetIssue: input.targetIssue === undefined ? undefined : jsonInput(input.targetIssue),
      relationId: input.relationId,
      meetingContextSyncedAt: input.meetingContextSyncedAt,
      externalIssueId: input.externalIssue === undefined ? undefined : (input.externalIssue?.id ?? null),
      externalIssueIdentifier:
        input.externalIssue === undefined ? undefined : (input.externalIssue?.identifier ?? null),
      externalIssueTitle: input.externalIssue === undefined ? undefined : (input.externalIssue?.title ?? null),
      externalIssueUrl: input.externalIssue === undefined ? undefined : (input.externalIssue?.url ?? null),
      updatedAt: new Date(),
    },
  });

  return row ? parseLinearTaskReviewItemRow(row) : null;
}

type AmbientContextRow = Prisma.meetingAmbientContextItemsModel;

export type StoredMeetingAmbientContextItem = MeetingAmbientContextItem & {
  mentionSegmentIds: string[] | null;
  imageStorageKey: string | null;
  imageMimeType: string | null;
};

function parseAmbientContextItemRow(row: AmbientContextRow): StoredMeetingAmbientContextItem {
  const imageVersion = row.imageStorageKey?.split("/").at(-1) ?? null;

  return {
    ...meetingAmbientContextItemSchema.parse({
      id: row.id,
      meetingId: row.meetingId,
      entityKind: row.entityKind,
      canonicalKey: row.canonicalKey,
      displayName: row.displayName,
      qualifier: row.qualifier,
      imageUrl:
        row.imageStorageKey !== null && row.imageStorageKey !== ""
          ? `/v1/meetings/${row.meetingId}/ambient-context/${row.id}/image?v=${encodeURIComponent(imageVersion ?? "1")}`
          : null,
      imageStatus: row.imageStatus,
      professionalTitle: row.professionalTitle,
      companyName: row.companyName,
      headquarters: row.headquarters,
      officialWebsite: row.officialWebsite,
      profileUrl: row.profileUrl,
      summary: row.summary,
      facts: row.facts,
      citations: row.citations,
      facets: row.facets,
      status: row.status,
      mentionCount: row.mentionCount,
      error: row.error,
      firstMentionedAt: row.firstMentionedAt.toISOString(),
      lastMentionedAt: row.lastMentionedAt.toISOString(),
      researchStartedAt: row.researchStartedAt?.toISOString() ?? null,
      researchCompletedAt: row.researchCompletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
    imageStorageKey: row.imageStorageKey,
    imageMimeType: row.imageMimeType,
    mentionSegmentIds: readNullableStringArray(row.mentionSegmentIds),
  };
}

const payloadFlagIsTrue = (input: { payload: Record<string, unknown>; key: string }): boolean => {
  const value = input.payload[input.key];

  return value === true || value === "true";
};

const payloadTextEquals = (input: { payload: Record<string, unknown>; key: string; expected: string }): boolean => {
  const value = input.payload[input.key];
  if (typeof value === "string") {
    return value === input.expected;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value) === input.expected;
  }

  return false;
};

async function expireRequestExecutions(input: {
  meetingId: string;
  type: AiWorkflowJobType;
  scopeKey?: string;
}): Promise<void> {
  await db.aiWorkflowExecutions.updateMany({
    where: whereAnd([
      { meetingId: input.meetingId },
      { type: input.type },
      input.scopeKey === undefined ? undefined : { scopeKey: input.scopeKey },
      { status: { in: ["queued", "running"] } },
      { startedAt: { lte: new Date(Date.now() - REQUEST_EXECUTION_MAX_AGE_MS) } },
    ]),
    data: {
      status: "failed",
      phase: "interrupted",
      error: REQUEST_EXECUTION_EXPIRED_MESSAGE,
      completedAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

export async function startAiWorkflowExecution(input: {
  meetingId: string;
  type: AiWorkflowJobType;
  scopeKey?: string;
  extractionId?: string | null;
  phase?: string;
  payload?: Record<string, unknown>;
}): Promise<AiWorkflowJobView> {
  return withRequestMutation({
    meetingId: input.meetingId,
    run: async (executor) => {
      const row = await mapRow({
        value: executor.aiWorkflowExecutions.create({
          data: {
            meetingId: input.meetingId,
            type: input.type,
            scopeKey: input.scopeKey ?? "default",
            extractionId: input.extractionId,
            phase: input.phase ?? "running",
            payload: jsonInput(input.payload ?? {}),
            status: "running",
          },
        }),
        map: (row) => ({
          ...row,
          type: aiWorkflowJobTypeSchema.parse(row.type),
          status: aiWorkflowJobStatusSchema.parse(row.status),
          payload: readJsonObject(row.payload),
          result: readJsonObject(row.result),
        }),
      });

      return parseAiWorkflowJobRow(row);
    },
  });
}

export type MeetingNotesRegenerationClaim =
  | { status: "claimed"; job: AiWorkflowJobView }
  | { status: "in_progress" }
  | { status: "not_needed" }
  | { status: "recently_failed" };

/**
 * Starts at most one notes regeneration per meeting. Under the meeting lock it
 * re-reads the summary, so a repeat click after a finished run (or alongside a
 * live one) never starts, and never pays for, a second run.
 */
export async function claimMeetingNotesRegeneration(input: {
  meetingId: string;
  regenerableSummaryModel: string;
  retryAfterFailureMs?: number;
}): Promise<MeetingNotesRegenerationClaim> {
  return withRequestMutation({
    meetingId: input.meetingId,
    run: async (executor): Promise<MeetingNotesRegenerationClaim> => {
      const now = Date.now();
      const summary = await executor.summaries.findFirst({
        where: { meetingId: input.meetingId },
        select: { model: true },
      });
      if (summary?.model !== input.regenerableSummaryModel) {
        return { status: "not_needed" };
      }
      const liveRun = await executor.aiWorkflowExecutions.findFirst({
        where: whereAnd([
          { meetingId: input.meetingId },
          { type: "generate_meeting_snapshot" },
          { status: { in: ["queued", "running"] } },
          { startedAt: { gt: new Date(now - REQUEST_EXECUTION_MAX_AGE_MS) } },
        ]),
        select: { id: true },
      });
      if (liveRun !== null) {
        return { status: "in_progress" };
      }
      if (input.retryAfterFailureMs !== undefined) {
        const recentFailure = await executor.aiWorkflowExecutions.findFirst({
          where: whereAnd([
            { meetingId: input.meetingId },
            { type: "generate_meeting_snapshot" },
            { status: "failed" },
            { completedAt: { gt: new Date(now - input.retryAfterFailureMs) } },
          ]),
          orderBy: { completedAt: "desc" },
          select: { completedAt: true },
        });
        if (
          recentFailure?.completedAt &&
          !(await creditsAddedSince({ executor, meetingId: input.meetingId, since: recentFailure.completedAt }))
        ) {
          return { status: "recently_failed" };
        }
      }
      const row = await executor.aiWorkflowExecutions.create({
        data: {
          meetingId: input.meetingId,
          type: "generate_meeting_snapshot",
          scopeKey: "default",
          phase: "running",
          payload: jsonInput({ trigger: "regenerate_fallback_notes" }),
          status: "running",
        },
      });

      return { status: "claimed", job: parseAiWorkflowJobRow(row) };
    },
  });
}

// A top-up or a new subscription after a failed run is a reason to retry right away.
async function creditsAddedSince(input: {
  executor: AccountTransaction;
  meetingId: string;
  since: Date;
}): Promise<boolean> {
  const meeting = await input.executor.meetings.findFirst({
    where: { id: input.meetingId },
    select: { workspaceId: true },
  });
  if (meeting === null) {
    return false;
  }
  const grant = await input.executor.creditGrants.findFirst({
    where: { workspaceId: meeting.workspaceId, createdAt: { gt: input.since } },
    select: { id: true },
  });
  if (grant !== null) {
    return true;
  }
  const subscription = await input.executor.billingSubscriptions.findFirst({
    where: {
      workspaceId: meeting.workspaceId,
      status: { in: ["active", "trialing"] },
      statusChangedAt: { gt: input.since },
    },
    select: { id: true },
  });

  return subscription !== null;
}

const readVoiceSearchItemIds = async (meetingId: string): Promise<Set<string>> => {
  const jobs = await mapRow({
    value: db.aiWorkflowExecutions.findMany({
      where: whereAnd([{ meetingId }, { type: "research_ambient_entity" }, { status: { in: ["queued", "running"] } }]),
      select: {
        payload: true,
      },
    }),
    map: (rows) => rows.map((row) => ({ ...row, payload: readJsonObject(row.payload) })),
  });

  return new Set(
    jobs.flatMap((job) => {
      const itemId = job.payload.itemId;
      const isVoiceSearch = payloadFlagIsTrue({ payload: job.payload, key: "voiceSearchCheck" });

      return typeof itemId === "string" && isVoiceSearch ? [itemId] : [];
    }),
  );
};

const isAmbientContextItemVisible = (input: {
  item: {
    id: string;
    error: string | null;
    summary: string | null;
    status: string;
    researchStartedAt: Date | null;
  };
  voiceSearchItemIds: ReadonlySet<string>;
}): boolean => {
  const hasPublishedSummary = input.item.summary !== null && input.item.summary !== "";
  const isSuppressedVoiceSearch = input.item.error === AMBIENT_VOICE_SEARCH_HANDLED && !hasPublishedSummary;
  const isHiddenPendingVoiceSearch =
    input.item.status === "pending" &&
    input.item.summary === null &&
    input.item.researchStartedAt === null &&
    input.voiceSearchItemIds.has(input.item.id);

  return !isSuppressedVoiceSearch && !isHiddenPendingVoiceSearch;
};

const listVisibleAmbientContextRows = async (meetingId: string) => {
  const [rows, voiceSearchItemIds] = await Promise.all([
    mapRow({
      value: db.meetingAmbientContextItems.findMany({
        where: { meetingId },
        orderBy: [{ lastMentionedAt: "desc" }, { createdAt: "desc" }],
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
          imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
          facts: readStringArray(row.facts),
          citations: z.array(ambientContextCitationSchema).parse(row.citations),
          facets: readStringArray(row.facets),
          status: ambientContextResearchStatusSchema.parse(row.status),
          mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
        })),
    }),
    readVoiceSearchItemIds(meetingId),
  ]);

  return rows.filter((item) => isAmbientContextItemVisible({ item, voiceSearchItemIds }));
};

export async function listMeetingAmbientContextItems(meetingId: string): Promise<StoredMeetingAmbientContextItem[]> {
  const rows = await listVisibleAmbientContextRows(meetingId);

  return rows.map(parseAmbientContextItemRow);
}

/** Only identity metadata is eligible for model context, never research output. */
export async function listMeetingAmbientContextKnownEntities(meetingId: string): Promise<
  {
    facets: string[];
    entityKind: "person" | "company";
    displayName: string;
    canonicalKey: string;
    qualifier: string | null;
  }[]
> {
  const rows = await listVisibleAmbientContextRows(meetingId);

  return rows.slice(0, AMBIENT_CONTEXT_KNOWN_ENTITY_LIMIT).map((row) => ({
    entityKind: row.entityKind,
    displayName: row.displayName,
    canonicalKey: row.canonicalKey,
    qualifier: row.qualifier,
    facets: row.facets,
  }));
}

/** Resolved pronouns/first names are mention evidence, never a research retry. */
export async function recordMeetingAmbientContextReference(input: {
  meetingId: string;
  canonicalKey: string;
  mentionedAt: Date;
  mentionSegmentIds: string[];
}): Promise<{ item: StoredMeetingAmbientContextItem } | null> {
  const ids = [...new Set(input.mentionSegmentIds)];

  return (async () => {
    const existing = await mapRow({
      value: db.meetingAmbientContextItems.findFirst({
        where: whereAnd([{ meetingId: input.meetingId }, { canonicalKey: input.canonicalKey }]),
        take: 1,
      }),
      map: (row) =>
        row === null
          ? undefined
          : {
              ...row,
              entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
              imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
              facts: readStringArray(row.facts),
              citations: z.array(ambientContextCitationSchema).parse(row.citations),
              facets: readStringArray(row.facets),
              status: ambientContextResearchStatusSchema.parse(row.status),
              mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
            },
    });
    // A stale reference must not recreate a deleted identity or start research.
    if (!existing) {
      return null;
    }
    const [row] = await mapRow({
      value: db.meetingAmbientContextItems.updateManyAndReturn({
        where: { id: existing.id },
        data: {
          mentionCount: existing.mentionCount + ids.length,
          mentionSegmentIds: jsonInput(
            existing.mentionSegmentIds ? [...new Set([...existing.mentionSegmentIds, ...ids])] : null,
          ),
          lastMentionedAt: input.mentionedAt,
          updatedAt: new Date(),
        },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
          imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
          facts: readStringArray(row.facts),
          citations: z.array(ambientContextCitationSchema).parse(row.citations),
          facets: readStringArray(row.facets),
          status: ambientContextResearchStatusSchema.parse(row.status),
          mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
        })),
    });

    return row ? { item: parseAmbientContextItemRow(row) } : null;
  })();
}

export async function getMeetingAmbientContextItem(input: {
  meetingId: string;
  itemId: string;
}): Promise<StoredMeetingAmbientContextItem | null> {
  const row = await mapRow({
    value: db.meetingAmbientContextItems.findFirst({
      where: whereAnd([{ meetingId: input.meetingId }, { id: input.itemId }]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
            imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
            facts: readStringArray(row.facts),
            citations: z.array(ambientContextCitationSchema).parse(row.citations),
            facets: readStringArray(row.facets),
            status: ambientContextResearchStatusSchema.parse(row.status),
            mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
          },
  });

  return row ? parseAmbientContextItemRow(row) : null;
}

export function ambientContextResearchJobScope(item: Pick<MeetingAmbientContextItem, "id" | "facets">): string {
  const facetHash = createHash("sha1")
    .update([...item.facets].sort().join("|"))
    .digest("hex")
    .slice(0, LINEAR_CANDIDATE_LIMIT);

  return `ambient:${item.id}:${facetHash}`;
}

type UpsertMeetingAmbientContextMentionAndEnqueueResearchResult = Promise<{
  item: {
    status: "pending" | "failed" | "ready" | "researching";
    error: string | null;
    id: string;
    displayName: string;
    createdAt: string;
    updatedAt: string;
    meetingId: string;
    entityKind: "person" | "company";
    canonicalKey: string;
    qualifier: string | null;
    imageStatus: "pending" | "ready" | "unavailable";
    professionalTitle: string | null;
    companyName: string | null;
    headquarters: string | null;
    officialWebsite: string | null;
    profileUrl: string | null;
    summary: string | null;
    facts: string[];
    citations: {
      title: string;
      domain: string | null;
      url: string;
      excerpt: string | null;
      isArticle?: boolean | undefined;
    }[];
    facets: string[];
    mentionCount: number;
    firstMentionedAt: string;
    lastMentionedAt: string;
    researchStartedAt: string | null;
    researchCompletedAt: string | null;
    imageUrl: string | null;
  };
  shouldResearch: boolean;
  isNew: boolean;
  researchJob: {
    type:
      | "finalize_meeting"
      | "resolve_meeting_title"
      | "meeting_post_end_pipeline"
      | "generate_meeting_snapshot"
      | "generate_meeting_tasks"
      | "extract_meeting_content"
      | "detect_meeting_signals"
      | "select_capabilities"
      | "draft_capability_payloads"
      | "execute_capability_workflow"
      | "run_meeting_research"
      | "detect_live_meeting_tasks"
      | "detect_ambient_context"
      | "track_meeting"
      | "research_ambient_entity"
      | "enrich_ambient_context_image"
      | "review_linear_tasks"
      | "review_ashby_actions"
      | "deliver_meeting_to_slack";
    status: "completed" | "failed" | "running" | "queued" | "cancelled";
    error: string | null;
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    startedAt: string | null;
    meetingId: string;
    result: Record<string, unknown>;
    runAfter: string;
    attemptCount: number;
    maxAttempts: number;
    lockedBy: string | null;
    lockedAt: string | null;
    payload: Record<string, unknown>;
    phase: string;
    extractionId: string | null;
    scopeKey: string;
  } | null;
}>;

function ambientContextMentionShouldResearchOnUpdate(args: {
  existing: Prisma.meetingAmbientContextItemsModel;
  hasNewFacet: boolean;
}) {
  const isTerminalIdentityFailure =
    (args.existing.error === AMBIENT_IDENTITY_UNVERIFIED || args.existing.error === AMBIENT_VOICE_SEARCH_HANDLED) &&
    !(args.existing.summary !== null && args.existing.summary !== "" && args.hasNewFacet);

  return (
    !isTerminalIdentityFailure &&
    (args.existing.status === "failed" ||
      (args.hasNewFacet && args.existing.status !== "pending" && args.existing.status !== "researching"))
  );
}

async function insertAmbientContextMentionRowWithin(args: {
  input: {
    meetingId: string;
    entityKind: AmbientContextEntityKind;
    canonicalKey: string;
    displayName: string;
    qualifier?: string | null;
    facets: string[];
    mentionedAt: Date;
    firstMentionedAt?: Date;
  };
  mentionCount: number;
  segmentIds: string[] | null;
}) {
  const { input, mentionCount, segmentIds } = args;
  const created = await mapRow({
    value: db.meetingAmbientContextItems.create({
      data: {
        meetingId: input.meetingId,
        entityKind: input.entityKind,
        canonicalKey: input.canonicalKey,
        displayName: input.displayName,
        qualifier: input.qualifier ?? null,
        facets: jsonInput([...new Set(input.facets)]),
        mentionCount,
        mentionSegmentIds: jsonInput(segmentIds),
        firstMentionedAt: input.firstMentionedAt ?? input.mentionedAt,
        lastMentionedAt: input.mentionedAt,
      },
    }),
    map: (row) => ({
      ...row,
      entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
      imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
      facts: readStringArray(row.facts),
      citations: z.array(ambientContextCitationSchema).parse(row.citations),
      facets: readStringArray(row.facets),
      status: ambientContextResearchStatusSchema.parse(row.status),
      mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
    }),
  });

  return {
    item: parseAmbientContextItemRow(created),
    shouldResearch: true,
    isNew: true,
  };
}

async function updateAmbientContextMentionRowWithin(args: {
  input: {
    displayName: string;
    qualifier?: string | null;
    facets: string[];
    mentionedAt: Date;
  };
  existing: Prisma.meetingAmbientContextItemsModel;
  mentionCount: number;
  segmentIds: string[] | null;
}) {
  const { input, existing, mentionCount, segmentIds } = args;
  const existingFacets = readStringArray(existing.facets ?? []);
  const nextFacets = [...new Set([...existingFacets, ...input.facets])];
  const hasNewFacet = nextFacets.length > existingFacets.length;
  const shouldResearch = ambientContextMentionShouldResearchOnUpdate({ existing, hasNewFacet });
  const [updated] = await mapRow({
    value: db.meetingAmbientContextItems.updateManyAndReturn({
      where: { id: existing.id },
      data: {
        displayName: input.displayName,
        qualifier: input.qualifier ?? existing.qualifier,
        facets: jsonInput(nextFacets),
        mentionCount: existing.mentionCount + mentionCount,
        mentionSegmentIds: jsonInput(
          existing.mentionSegmentIds !== null && segmentIds !== null
            ? [...new Set([...readStringArray(existing.mentionSegmentIds), ...segmentIds])]
            : null,
        ),
        lastMentionedAt: input.mentionedAt,
        ...(shouldResearch ? { status: "pending" as const, error: null } : {}),
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
        imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
        facts: readStringArray(row.facts),
        citations: z.array(ambientContextCitationSchema).parse(row.citations),
        facets: readStringArray(row.facets),
        status: ambientContextResearchStatusSchema.parse(row.status),
        mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
      })),
  });
  if (!updated) {
    throw new Error(FAILED_TO_UPDATE_AMBIENT_CONTEXT_MENTION_MESSAGE);
  }

  return {
    item: parseAmbientContextItemRow(updated),
    shouldResearch,
    isNew: false,
  };
}

async function persistMeetingAmbientContextMentionWithin(args: {
  input: {
    meetingId: string;
    entityKind: AmbientContextEntityKind;
    canonicalKey: string;
    displayName: string;
    qualifier?: string | null;
    facets: string[];
    mentionedAt: Date;
    firstMentionedAt?: Date;
  };
  mentionCount: number;
  segmentIds: string[] | null;
  existing: Prisma.meetingAmbientContextItemsModel | undefined;
}) {
  if (!args.existing) {
    return insertAmbientContextMentionRowWithin(args);
  }

  return updateAmbientContextMentionRowWithin({
    input: args.input,
    existing: args.existing,
    mentionCount: args.mentionCount,
    segmentIds: args.segmentIds,
  });
}

const ambientResearchPayload = (input: {
  existing?: Record<string, unknown>;
  itemId: string;
  researchRunAfter?: Date;
  voiceSearchRequestedAt?: Date;
}): Record<string, unknown> => ({
  ...input.existing,
  itemId: input.itemId,
  ...(input.researchRunAfter ? { /** @external existing wire contract */ voiceSearchCheck: true } : {}),
  ...(input.voiceSearchRequestedAt ? { voiceSearchRequestedAt: input.voiceSearchRequestedAt.toISOString() } : {}),
});

async function enqueueMeetingAmbientContextResearchJobWithin(args: {
  input: { meetingId: string; researchRunAfter?: Date; voiceSearchRequestedAt?: Date };
  item: StoredMeetingAmbientContextItem;
}) {
  return startAiWorkflowExecution({
    meetingId: args.input.meetingId,
    type: "research_ambient_entity",
    scopeKey: ambientContextResearchJobScope(args.item),
    payload: ambientResearchPayload({ itemId: args.item.id, ...args.input }),
  });
}

const upsertMeetingAmbientContextMentionAndEnqueueResearchWithin = async (args: {
  input: {
    meetingId: string;
    entityKind: AmbientContextEntityKind;
    canonicalKey: string;
    displayName: string;
    qualifier?: string | null;
    facets: string[];
    mentionedAt: Date;
    firstMentionedAt?: Date;
    mentionSegmentIds?: string[];
    mentionCount?: number;
    researchRunAfter?: Date;
    voiceSearchRequestedAt?: Date;
  };
  mentionCount: number;
  segmentIds: string[] | null;
}) => {
  const { input, mentionCount, segmentIds } = args;

  const existing = await mapRow({
    value: db.meetingAmbientContextItems.findFirst({
      where: whereAnd([{ meetingId: input.meetingId }, { canonicalKey: input.canonicalKey }]),
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
            imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
            facts: readStringArray(row.facts),
            citations: z.array(ambientContextCitationSchema).parse(row.citations),
            facets: readStringArray(row.facets),
            status: ambientContextResearchStatusSchema.parse(row.status),
            mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
          },
  });

  const mention = await persistMeetingAmbientContextMentionWithin({
    input,
    mentionCount,
    segmentIds,
    existing,
  });
  const { item, shouldResearch, isNew } = mention;
  const researchJob =
    shouldResearch || item.status === "pending"
      ? await enqueueMeetingAmbientContextResearchJobWithin({ input, item })
      : null;

  return { item, shouldResearch, isNew, researchJob };
};

export async function upsertMeetingAmbientContextMentionAndEnqueueResearch(input: {
  meetingId: string;
  entityKind: AmbientContextEntityKind;
  canonicalKey: string;
  displayName: string;
  qualifier?: string | null;
  facets: string[];
  mentionedAt: Date;
  firstMentionedAt?: Date;
  mentionSegmentIds?: string[];
  mentionCount?: number;
  researchRunAfter?: Date;
  voiceSearchRequestedAt?: Date;
}): UpsertMeetingAmbientContextMentionAndEnqueueResearchResult {
  const segmentIds = (input.mentionSegmentIds?.length ?? 0) > 0 ? [...new Set(input.mentionSegmentIds)] : null;
  // Count validated supporting rows ourselves. Model counts may include
  // repeats within one segment or surrounding context that is not evidence.
  const mentionCount = segmentIds?.length ?? Math.max(1, input.mentionCount ?? 1);

  return upsertMeetingAmbientContextMentionAndEnqueueResearchWithin({ input, mentionCount, segmentIds });
}

/** A superseded request cannot overwrite a newer explicit retry. */
export async function recordAmbientContextResearchFailure(input: {
  meetingId: string;
  itemId: string;
  jobId: string;
  error: string;
}): Promise<StoredMeetingAmbientContextItem | null> {
  return (async () => {
    const [item] = await mapRow({
      value: db.meetingAmbientContextItems.findMany({
        where: whereAnd([{ meetingId: input.meetingId }, { id: input.itemId }]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
          imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
          facts: readStringArray(row.facts),
          citations: z.array(ambientContextCitationSchema).parse(row.citations),
          facets: readStringArray(row.facets),
          status: ambientContextResearchStatusSchema.parse(row.status),
          mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
        })),
    });
    if (!item) {
      return null;
    }
    const [storedJob] = await mapRow({
      value: db.aiWorkflowExecutions.findMany({
        where: whereAnd([
          { id: input.jobId },
          { meetingId: input.meetingId },
          { type: "research_ambient_entity" },
          { status: { in: ["queued", "running"] } },
        ]),
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          type: aiWorkflowJobTypeSchema.parse(row.type),
          status: aiWorkflowJobStatusSchema.parse(row.status),
          payload: readJsonObject(row.payload),
          result: readJsonObject(row.result),
        })),
    });
    const job =
      storedJob !== undefined &&
      payloadTextEquals({ payload: storedJob.payload, key: "itemId", expected: input.itemId })
        ? storedJob
        : undefined;
    if (!job) {
      return null;
    }
    const latest = await mapRow({
      value: db.aiWorkflowExecutions.findFirst({
        where: whereAnd([{ meetingId: input.meetingId }, { type: job.type }, { scopeKey: job.scopeKey }]),
        orderBy: [{ createdAt: "desc" }],
        take: 1,
      }),
      map: (row) =>
        row === null
          ? undefined
          : {
              ...row,
              type: aiWorkflowJobTypeSchema.parse(row.type),
              status: aiWorkflowJobStatusSchema.parse(row.status),
              payload: readJsonObject(row.payload),
              result: readJsonObject(row.result),
            },
    });
    if (latest?.id !== job.id) {
      return null;
    }
    const [updated] = await mapRow({
      value: db.meetingAmbientContextItems.updateManyAndReturn({
        where: whereAnd([{ id: item.id }, { status: { in: ["pending", "researching"] } }]),
        data: {
          status: "failed",
          error: input.error.slice(0, AMBIENT_ERROR_MAX_LENGTH),
          updatedAt: new Date(),
        },
      }),
      map: (rows) =>
        rows.map((row) => ({
          ...row,
          entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
          imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
          facts: readStringArray(row.facts),
          citations: z.array(ambientContextCitationSchema).parse(row.citations),
          facets: readStringArray(row.facets),
          status: ambientContextResearchStatusSchema.parse(row.status),
          mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
        })),
    });

    return updated ? parseAmbientContextItemRow(updated) : null;
  })();
}

type RetryFailedMeetingAmbientContextItemAndEnqueueResearchResult = Promise<{
  item: StoredMeetingAmbientContextItem;
  researchJob: {
    type:
      | "finalize_meeting"
      | "resolve_meeting_title"
      | "meeting_post_end_pipeline"
      | "generate_meeting_snapshot"
      | "generate_meeting_tasks"
      | "extract_meeting_content"
      | "detect_meeting_signals"
      | "select_capabilities"
      | "draft_capability_payloads"
      | "execute_capability_workflow"
      | "run_meeting_research"
      | "detect_live_meeting_tasks"
      | "detect_ambient_context"
      | "track_meeting"
      | "research_ambient_entity"
      | "enrich_ambient_context_image"
      | "review_linear_tasks"
      | "review_ashby_actions"
      | "deliver_meeting_to_slack";
    status: "completed" | "failed" | "running" | "queued" | "cancelled";
    error: string | null;
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    startedAt: string | null;
    meetingId: string;
    result: Record<string, unknown>;
    runAfter: string;
    attemptCount: number;
    maxAttempts: number;
    lockedBy: string | null;
    lockedAt: string | null;
    payload: Record<string, unknown>;
    phase: string;
    extractionId: string | null;
    scopeKey: string;
  };
} | null>;

async function enqueueManualAmbientContextResearchRetryWithin(args: {
  input: { meetingId: string; itemId: string };
  current: Prisma.meetingAmbientContextItemsModel;
}) {
  const { input, current } = args;
  const [updated] = await mapRow({
    value: db.meetingAmbientContextItems.updateManyAndReturn({
      where: whereAnd([
        { meetingId: input.meetingId },
        { id: input.itemId },
        whereOr([
          { status: { in: ["failed", "pending", "researching"] } },
          whereAnd([{ status: "ready" }, { error: AMBIENT_IDENTITY_UNVERIFIED }]),
        ]),
      ]),
      data: {
        status: "pending",
        error: null,
        researchStartedAt: null,
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
        imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
        facts: readStringArray(row.facts),
        citations: z.array(ambientContextCitationSchema).parse(row.citations),
        facets: readStringArray(row.facets),
        status: ambientContextResearchStatusSchema.parse(row.status),
        mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
      })),
  });
  if (!updated) {
    return null;
  }

  const item = parseAmbientContextItemRow(updated);
  const scopeKey = `${ambientContextResearchJobScope(item)}${current.status === "pending" || current.status === "researching" ? "" : ":manual"}`;
  const job = await startAiWorkflowExecution({
    meetingId: input.meetingId,
    type: "research_ambient_entity",
    scopeKey,
    payload: { itemId: item.id },
  });

  return { item, researchJob: job };
}

const retryFailedMeetingAmbientContextItemAndEnqueueResearchWithin = async (args: {
  input: {
    meetingId: string;
    itemId: string;
  };
}) => {
  const { input } = args;

  const [current] = await mapRow({
    value: db.meetingAmbientContextItems.findMany({
      where: whereAnd([{ meetingId: input.meetingId }, { id: input.itemId }]),
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
        imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
        facts: readStringArray(row.facts),
        citations: z.array(ambientContextCitationSchema).parse(row.citations),
        facets: readStringArray(row.facets),
        status: ambientContextResearchStatusSchema.parse(row.status),
        mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
      })),
  });
  if (!current || (current.status === "ready" && current.error !== AMBIENT_IDENTITY_UNVERIFIED)) {
    return null;
  }

  return enqueueManualAmbientContextResearchRetryWithin({ input, current });
};

export async function retryFailedMeetingAmbientContextItemAndEnqueueResearch(input: {
  meetingId: string;
  itemId: string;
}): RetryFailedMeetingAmbientContextItemAndEnqueueResearchResult {
  return (() => retryFailedMeetingAmbientContextItemAndEnqueueResearchWithin({ input }))();
}

/** Remove only an unresearched duplicate whose evidence has not changed.
 * Share the mention-upsert lock so a later independent mention can safely
 * create a fresh item instead of inheriting a permanent suppression error.
 */
export async function deleteUnchangedAmbientVoiceDuplicate(input: {
  meetingId: string;
  itemId: string;
  canonicalKey: string;
  mentionCount: number;
}): Promise<boolean> {
  return (async () => {
    const [row] = await (async () => {
      const where25 = sqlAnd([
        sqlCompare({
          columnSql: '"meeting_ambient_context_items"."meeting_id"',
          operator: "=",
          value: input.meetingId,
          cast: "uuid",
        }),
        sqlCompare({
          columnSql: '"meeting_ambient_context_items"."id"',
          operator: "=",
          value: input.itemId,
          cast: "uuid",
        }),
        sqlCompare({
          columnSql: '"meeting_ambient_context_items"."mention_count"',
          operator: "=",
          value: input.mentionCount,
          cast: "int",
        }),
        sqlCompare({
          columnSql: '"meeting_ambient_context_items"."status"',
          operator: "=",
          value: "pending",
          cast: null,
        }),
        sqlIsNull({ columnSql: '"meeting_ambient_context_items"."summary"', isNegated: false }),
        sqlIsNull({ columnSql: '"meeting_ambient_context_items"."research_started_at"', isNegated: false }),
        sqlIsNull({ columnSql: '"meeting_ambient_context_items"."research_completed_at"', isNegated: false }),
        sqlIsNull({ columnSql: '"meeting_ambient_context_items"."image_storage_key"', isNegated: false }),
      ]);

      return db.$queryRaw<{ id: string }[]>`
                        DELETE FROM "meeting_ambient_context_items"
                        ${sqlWhereClause(where25)}
                        RETURNING "id" AS "id"
                        `;
    })();

    return Boolean(row);
  })();
}

const buildMeetingAmbientContextItemStatusUpdateValues = (input: {
  status?: AmbientContextResearchStatus;
  imageStatus?: AmbientContextImageStatus;
  imageStorageKey?: string | null;
  imageMimeType?: string | null;
  error?: string | null;
  researchStartedAt?: Date | null;
  researchCompletedAt?: Date | null;
}) => ({
  ...(input.status !== undefined ? { status: input.status } : {}),
  ...(input.imageStatus !== undefined ? { imageStatus: input.imageStatus } : {}),
  ...(input.imageStorageKey !== undefined ? { imageStorageKey: input.imageStorageKey } : {}),
  ...(input.imageMimeType !== undefined ? { imageMimeType: input.imageMimeType } : {}),
  ...(input.error !== undefined ? { error: input.error } : {}),
  ...(input.researchStartedAt !== undefined ? { researchStartedAt: input.researchStartedAt } : {}),
  ...(input.researchCompletedAt !== undefined ? { researchCompletedAt: input.researchCompletedAt } : {}),
});

const buildMeetingAmbientContextItemContentUpdateValues = (input: {
  professionalTitle?: string | null;
  companyName?: string | null;
  headquarters?: string | null;
  officialWebsite?: string | null;
  profileUrl?: string | null;
  summary?: string | null;
  facts?: string[];
  citations?: AmbientContextCitation[];
}) => ({
  ...(input.professionalTitle !== undefined ? { professionalTitle: input.professionalTitle } : {}),
  ...(input.companyName !== undefined ? { companyName: input.companyName } : {}),
  ...(input.headquarters !== undefined ? { headquarters: input.headquarters } : {}),
  ...(input.officialWebsite !== undefined ? { officialWebsite: input.officialWebsite } : {}),
  ...(input.profileUrl !== undefined ? { profileUrl: input.profileUrl } : {}),
  ...(input.summary !== undefined ? { summary: input.summary } : {}),
  ...(input.facts !== undefined ? { facts: input.facts } : {}),
  ...(input.citations !== undefined ? { citations: input.citations } : {}),
});

const buildMeetingAmbientContextItemUpdateValues = (input: {
  status?: AmbientContextResearchStatus;
  imageStatus?: AmbientContextImageStatus;
  imageStorageKey?: string | null;
  imageMimeType?: string | null;
  professionalTitle?: string | null;
  companyName?: string | null;
  headquarters?: string | null;
  officialWebsite?: string | null;
  profileUrl?: string | null;
  summary?: string | null;
  facts?: string[];
  citations?: AmbientContextCitation[];
  error?: string | null;
  researchStartedAt?: Date | null;
  researchCompletedAt?: Date | null;
}) => ({
  ...buildMeetingAmbientContextItemStatusUpdateValues(input),
  ...buildMeetingAmbientContextItemContentUpdateValues(input),
  updatedAt: new Date(),
});

export async function updateMeetingAmbientContextItem(input: {
  meetingId: string;
  itemId: string;
  status?: AmbientContextResearchStatus;
  imageStatus?: AmbientContextImageStatus;
  imageStorageKey?: string | null;
  imageMimeType?: string | null;
  professionalTitle?: string | null;
  companyName?: string | null;
  headquarters?: string | null;
  officialWebsite?: string | null;
  profileUrl?: string | null;
  summary?: string | null;
  facts?: string[];
  citations?: AmbientContextCitation[];
  error?: string | null;
  researchStartedAt?: Date | null;
  researchCompletedAt?: Date | null;
}): Promise<StoredMeetingAmbientContextItem | null> {
  const [row] = await mapRow({
    value: db.meetingAmbientContextItems.updateManyAndReturn({
      where: whereAnd([{ meetingId: input.meetingId }, { id: input.itemId }]),
      data: buildMeetingAmbientContextItemUpdateValues(input),
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        entityKind: ambientContextEntityKindSchema.parse(row.entityKind),
        imageStatus: ambientContextImageStatusSchema.parse(row.imageStatus),
        facts: readStringArray(row.facts),
        citations: z.array(ambientContextCitationSchema).parse(row.citations),
        facets: readStringArray(row.facets),
        status: ambientContextResearchStatusSchema.parse(row.status),
        mentionSegmentIds: row.mentionSegmentIds === null ? null : readStringArray(row.mentionSegmentIds),
      })),
  });

  return row ? parseAmbientContextItemRow(row) : null;
}

export async function getMeetingAmbientContextCursor(
  meetingId: string,
): Promise<{ lastProcessedSegmentId: string | null; processedThrough: Date | null; detectionState: string } | null> {
  const row = await mapRow({
    value: db.meetingAmbientContextCursors.findFirst({
      where: { meetingId },
      take: 1,
    }),
    map: (row) => row ?? undefined,
  });

  return row
    ? {
        lastProcessedSegmentId: row.lastProcessedSegmentId,
        processedThrough: row.processedThrough,
        detectionState: row.detectionState,
      }
    : null;
}

/** Claim before any provider work. Never expire/reclaim an ambiguous attempt. */
export async function withMeetingAmbientContextDetectionLock<T>(
  ...args: [meetingId: string, operation: () => Promise<T>]
): Promise<T | null> {
  const [meetingId, operation] = args;
  const [meeting] = await db.meetings.findMany({
    where: { id: meetingId },
    select: {
      id: true,
    },
  });
  if (!meeting) {
    return null;
  }
  await createIgnoringUniqueConflict(() =>
    db.meetingAmbientContextCursors.create({
      data: {
        meetingId,
      },
    }),
  );
  const cursorForMeeting = { meetingId };
  async function claimOrRequest(): Promise<boolean> {
    const [claimed] = await db.meetingAmbientContextCursors.updateManyAndReturn({
      where: whereAnd([cursorForMeeting, { detectionState: "idle" }]),
      data: {
        detectionState: "running",
        detectionRequested: false,
        updatedAt: new Date(),
      },
    });
    if (claimed) {
      return true;
    }
    const [requested] = await db.meetingAmbientContextCursors.updateManyAndReturn({
      where: whereAnd([cursorForMeeting, { detectionState: "running" }]),
      data: {
        detectionRequested: true,
      },
    });
    if (requested) {
      return false;
    }
    const [cursor] = await db.meetingAmbientContextCursors.findMany({
      where: cursorForMeeting,
    });

    // Completion may have released the claim between the two conditional writes.
    return cursor?.detectionState === "idle" ? claimOrRequest() : false;
  }
  if (!(await claimOrRequest())) {
    return null;
  }
  async function releaseOrRepeat(): Promise<boolean> {
    const [released] = await db.meetingAmbientContextCursors.updateManyAndReturn({
      where: { meetingId, detectionRequested: false },
      data: {
        detectionState: "idle",
        updatedAt: new Date(),
      },
    });
    if (released) {
      return false;
    }
    const [pending] = await db.meetingAmbientContextCursors.updateManyAndReturn({
      where: { meetingId, detectionRequested: true },
      data: {
        detectionRequested: false,
        updatedAt: new Date(),
      },
    });

    return pending !== undefined;
  }
  async function runUntilSettled(): Promise<T> {
    const result = await operation();

    return (await releaseOrRepeat()) ? runUntilSettled() : result;
  }
  try {
    return await runUntilSettled();
  } catch (error) {
    // If persistence itself is unavailable, the existing running claim still
    // prevents paid replay after a worker restart or job-lease recovery.
    try {
      await db.meetingAmbientContextCursors.updateMany({
        where: { meetingId },
        data: {
          detectionState: "failed",
          updatedAt: new Date(),
        },
      });
    } catch (unlockError) {
      void unlockError;
    }
    throw error;
  }
}

export async function updateMeetingAmbientContextCursor(input: {
  meetingId: string;
  lastProcessedSegmentId: string;
  processedThrough: Date;
}): Promise<void> {
  await db.meetingAmbientContextCursors.upsert({
    where: { meetingId: input.meetingId },
    create: input,
    update: {
      lastProcessedSegmentId: input.lastProcessedSegmentId,
      processedThrough: input.processedThrough,
      updatedAt: new Date(),
    },
  });
}

export async function publishAmbientContextRealtimeUpdate(input: {
  workspaceId: string;
  meetingId: string;
  itemId: string;
  status: AmbientContextResearchStatus;
}): Promise<void> {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  await publishRealtimeEvents([
    {
      channel: meetingAmbientContextRealtimeChannel(input),
      eventName: "ambient-context.updated",
      payload: { ...input, version: 1, eventId, occurredAt },
    },
  ]);
}

/** One preview per meeting, including terminal jobs, shared by all API replicas. */
type EnsureGuestMeetingPreviewJobResult = Promise<{
  type:
    | "finalize_meeting"
    | "resolve_meeting_title"
    | "meeting_post_end_pipeline"
    | "generate_meeting_snapshot"
    | "generate_meeting_tasks"
    | "extract_meeting_content"
    | "detect_meeting_signals"
    | "select_capabilities"
    | "draft_capability_payloads"
    | "execute_capability_workflow"
    | "run_meeting_research"
    | "detect_live_meeting_tasks"
    | "detect_ambient_context"
    | "track_meeting"
    | "research_ambient_entity"
    | "enrich_ambient_context_image"
    | "review_linear_tasks"
    | "review_ashby_actions"
    | "deliver_meeting_to_slack";
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: string | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  payload: Record<string, unknown>;
  phase: string;
  extractionId: string | null;
  scopeKey: string;
} | null>;

export async function ensureGuestMeetingPreviewJob(
  ...args: [meetingId: string, requestId?: string]
): EnsureGuestMeetingPreviewJobResult {
  const [meetingId, requestId = randomUUID()] = args;
  await expireRequestExecutions({ meetingId, type: "resolve_meeting_title", scopeKey: GUEST_MEETING_PREVIEW_SCOPE });
  const existing = await getLatestAiWorkflowJobForMeeting({
    meetingId,
    type: "resolve_meeting_title",
    scopeKey: GUEST_MEETING_PREVIEW_SCOPE,
  });
  if (existing?.status === "completed" || existing?.status === "running") {
    return existing;
  }
  const meeting = await getMeetingById(meetingId);
  if (!meeting || meeting.status === "ended") {
    return null;
  }
  const claimed = await mapRow({
    value: mapRow({
      value: insertRaw<Prisma.aiWorkflowExecutionsModel>({
        executor: db,
        table: "ai_workflow_executions",
        rows: [
          {
            id: requestId,
            meetingId,
            type: "resolve_meeting_title",
            scopeKey: GUEST_MEETING_PREVIEW_SCOPE,
            payload: { trigger: "guest_waiting" },
          },
        ],
        columns: [
          { key: "id", column: "id", cast: "uuid" },
          { key: "meetingId", column: "meeting_id", cast: "uuid" },
          { key: "extractionId", column: "extraction_id", cast: "uuid" },
          { key: "type", column: "type", cast: null },
          { key: "scopeKey", column: "scope_key", cast: null },
          { key: "status", column: "status", cast: null },
          { key: "phase", column: "phase", cast: null },
          { key: "payload", column: "payload", cast: "jsonb" },
          { key: "result", column: "result", cast: "jsonb" },
          { key: "error", column: "error", cast: null },
          { key: "startedAt", column: "started_at", cast: "timestamptz" },
          { key: "completedAt", column: "completed_at", cast: "timestamptz" },
          { key: "createdAt", column: "created_at", cast: "timestamptz" },
          { key: "updatedAt", column: "updated_at", cast: "timestamptz" },
        ],
        conflict: sqlConflictNothing({ targetSql: 'ON CONFLICT ("preview_key")', where: undefined }),
        returning: Prisma.raw(
          '"id" AS "id", "meeting_id" AS "meetingId", "extraction_id" AS "extractionId", "type" AS "type", "scope_key" AS "scopeKey", "status" AS "status", "phase" AS "phase", "payload" AS "payload", "result" AS "result", "error" AS "error", "started_at" AS "startedAt", "completed_at" AS "completedAt", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "preview_key" AS "previewKey"',
        ),
      }),
      map: (rows) => rows[0],
    }),
    map: (row) =>
      row === undefined
        ? undefined
        : {
            ...row,
            type: aiWorkflowJobTypeSchema.parse(row.type),
            status: aiWorkflowJobStatusSchema.parse(row.status),
            payload: readJsonObject(row.payload),
            result: readJsonObject(row.result),
          },
  });

  return claimed
    ? parseAiWorkflowJobRow(claimed)
    : getLatestAiWorkflowJobForMeeting({
        meetingId,
        type: "resolve_meeting_title",
        scopeKey: GUEST_MEETING_PREVIEW_SCOPE,
      });
}

type EnqueueAiWorkflowJobResult = Promise<{
  type:
    | "finalize_meeting"
    | "resolve_meeting_title"
    | "meeting_post_end_pipeline"
    | "generate_meeting_snapshot"
    | "generate_meeting_tasks"
    | "extract_meeting_content"
    | "detect_meeting_signals"
    | "select_capabilities"
    | "draft_capability_payloads"
    | "execute_capability_workflow"
    | "run_meeting_research"
    | "detect_live_meeting_tasks"
    | "detect_ambient_context"
    | "track_meeting"
    | "research_ambient_entity"
    | "enrich_ambient_context_image"
    | "review_linear_tasks"
    | "review_ashby_actions"
    | "deliver_meeting_to_slack";
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: string | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  payload: Record<string, unknown>;
  phase: string;
  extractionId: string | null;
  scopeKey: string;
}>;

export async function enqueueAiWorkflowJob(input: {
  meetingId: string;
  extractionId?: string | null;
  type: AiWorkflowJobType;
  scopeKey?: string;
  phase?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAfter?: Date;
}): EnqueueAiWorkflowJobResult {
  return startAiWorkflowExecution(input);
}

type MarkMeetingEndedAndEnqueueFinalizationJobResult = Promise<{
  type:
    | "finalize_meeting"
    | "resolve_meeting_title"
    | "meeting_post_end_pipeline"
    | "generate_meeting_snapshot"
    | "generate_meeting_tasks"
    | "extract_meeting_content"
    | "detect_meeting_signals"
    | "select_capabilities"
    | "draft_capability_payloads"
    | "execute_capability_workflow"
    | "run_meeting_research"
    | "detect_live_meeting_tasks"
    | "detect_ambient_context"
    | "track_meeting"
    | "research_ambient_entity"
    | "enrich_ambient_context_image"
    | "review_linear_tasks"
    | "review_ashby_actions"
    | "deliver_meeting_to_slack";
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: string | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  payload: Record<string, unknown>;
  phase: string;
  extractionId: string | null;
  scopeKey: string;
} | null>;

const meetingHasPresentNonAssistant = async (meetingId: string): Promise<boolean> => {
  const row = await mapRow({
    value: db.meetingParticipants.findFirst({
      where: whereAnd([{ meetingId }, { role: { not: "assistant" } }, { leftAt: null }]),
      take: 1,
      select: {
        id: true,
      },
    }),
    map: (row) => row ?? undefined,
  });

  return row !== undefined;
};

const markStandardMeetingParticipantsCompletedFirstMeeting = async (meetingId: string): Promise<void> => {
  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { id: meetingId },
      take: 1,
      select: {
        kind: true,
      },
    }),
    map: (row) => (row === null ? undefined : { ...row, kind: meetingKindSchema.parse(row.kind) }),
  });
  if (!meeting || meeting.kind !== "standard") {
    return;
  }
  const participants = await db.meetingParticipants.findMany({
    where: whereAnd([{ meetingId }, { role: { not: "assistant" } }]),
    select: {
      userId: true,
    },
  });
  const userIds = [...new Set(participants.map((participant) => participant.userId))];
  if (userIds.length === 0) {
    return;
  }
  await db.users.updateMany({
    where: { id: { in: userIds } },
    data: {
      hasCompletedFirstMeeting: true,
    },
  });
};

const enqueueMeetingFinalizationJob = async (meetingId: string) =>
  startAiWorkflowExecution({ meetingId, type: "finalize_meeting", payload: { trigger: "meeting_ended" } });

export async function markMeetingEndedAndEnqueueFinalizationJob(
  ...args: [meetingId: string, options?: { /** @external existing wire contract */ force?: boolean }]
): MarkMeetingEndedAndEnqueueFinalizationJobResult {
  const [meetingId, options = {}] = args;
  const meeting = await mapRow({
    value: db.meetings.findFirst({
      where: { id: meetingId },
      take: 1,
    }),
    map: (row) => (row === null ? undefined : readStoredMeeting(row)),
  });
  if (!meeting) {
    return null;
  }
  if (options.force !== true && (meeting.status !== "active" || (await meetingHasPresentNonAssistant(meetingId)))) {
    return null;
  }
  const [ended] = await db.meetings.updateManyAndReturn({
    where: whereAnd([{ id: meetingId }, options.force === true ? undefined : { status: "active" }]),
    data: {
      status: "ended",
      endedAt: meeting.endedAt ?? new Date(),
    },
    select: { id: true },
  });
  if (!ended) {
    return null;
  }
  await markStandardMeetingParticipantsCompletedFirstMeeting(meetingId);

  return enqueueMeetingFinalizationJob(meetingId);
}

type HeartbeatAiWorkflowJobResult = Promise<{
  type:
    | "finalize_meeting"
    | "resolve_meeting_title"
    | "meeting_post_end_pipeline"
    | "generate_meeting_snapshot"
    | "generate_meeting_tasks"
    | "extract_meeting_content"
    | "detect_meeting_signals"
    | "select_capabilities"
    | "draft_capability_payloads"
    | "execute_capability_workflow"
    | "run_meeting_research"
    | "detect_live_meeting_tasks"
    | "detect_ambient_context"
    | "track_meeting"
    | "research_ambient_entity"
    | "enrich_ambient_context_image"
    | "review_linear_tasks"
    | "review_ashby_actions"
    | "deliver_meeting_to_slack";
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: string | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  payload: Record<string, unknown>;
  phase: string;
  extractionId: string | null;
  scopeKey: string;
} | null>;

export async function heartbeatAiWorkflowJob(input: {
  jobId: string;
  workerId: string;
  phase?: string;
  extractionId?: string | null;
  result?: Record<string, unknown>;
}): HeartbeatAiWorkflowJobResult {
  const [row] = await mapRow({
    value: db.aiWorkflowExecutions.updateManyAndReturn({
      where: whereAnd([{ id: input.jobId }, { status: "running" }]),
      data: {
        phase: input.phase,
        extractionId: input.extractionId ?? undefined,
        result: input.result === undefined ? undefined : jsonInput(input.result),
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        type: aiWorkflowJobTypeSchema.parse(row.type),
        status: aiWorkflowJobStatusSchema.parse(row.status),
        payload: readJsonObject(row.payload),
        result: readJsonObject(row.result),
      })),
  });

  return row ? parseAiWorkflowJobRow(row) : null;
}

/** A bounded, provider-free ownership wait is not a failed AI attempt. */

type CompleteAiWorkflowJobResult = Promise<{
  type:
    | "finalize_meeting"
    | "resolve_meeting_title"
    | "meeting_post_end_pipeline"
    | "generate_meeting_snapshot"
    | "generate_meeting_tasks"
    | "extract_meeting_content"
    | "detect_meeting_signals"
    | "select_capabilities"
    | "draft_capability_payloads"
    | "execute_capability_workflow"
    | "run_meeting_research"
    | "detect_live_meeting_tasks"
    | "detect_ambient_context"
    | "track_meeting"
    | "research_ambient_entity"
    | "enrich_ambient_context_image"
    | "review_linear_tasks"
    | "review_ashby_actions"
    | "deliver_meeting_to_slack";
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: string | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  payload: Record<string, unknown>;
  phase: string;
  extractionId: string | null;
  scopeKey: string;
}>;

export async function completeAiWorkflowJob(input: {
  jobId: string;
  result?: Record<string, unknown>;
  phase?: string;
}): CompleteAiWorkflowJobResult {
  const [row] = await mapRow({
    value: db.aiWorkflowExecutions.updateManyAndReturn({
      where: whereAnd([{ id: input.jobId }, { status: "running" }]),
      data: {
        status: "completed",
        phase: input.phase ?? "complete",
        result: jsonInput(input.result ?? {}),
        error: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        type: aiWorkflowJobTypeSchema.parse(row.type),
        status: aiWorkflowJobStatusSchema.parse(row.status),
        payload: readJsonObject(row.payload),
        result: readJsonObject(row.result),
      })),
  });
  if (!row) {
    throw new Error(failedToCompleteAiWorkflowJobMessage(input.jobId));
  }

  return parseAiWorkflowJobRow(row);
}

type FailAiWorkflowJobResult = Promise<{
  type:
    | "finalize_meeting"
    | "resolve_meeting_title"
    | "meeting_post_end_pipeline"
    | "generate_meeting_snapshot"
    | "generate_meeting_tasks"
    | "extract_meeting_content"
    | "detect_meeting_signals"
    | "select_capabilities"
    | "draft_capability_payloads"
    | "execute_capability_workflow"
    | "run_meeting_research"
    | "detect_live_meeting_tasks"
    | "detect_ambient_context"
    | "track_meeting"
    | "research_ambient_entity"
    | "enrich_ambient_context_image"
    | "review_linear_tasks"
    | "review_ashby_actions"
    | "deliver_meeting_to_slack";
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: string | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  payload: Record<string, unknown>;
  phase: string;
  extractionId: string | null;
  scopeKey: string;
}>;

export async function failAiWorkflowJob(input: {
  jobId: string;
  error: string;
  retryDelayMs?: number;
  phase?: string;
}): FailAiWorkflowJobResult {
  const [row] = await mapRow({
    value: db.aiWorkflowExecutions.updateManyAndReturn({
      where: whereAnd([{ id: input.jobId }, { status: "running" }]),
      data: {
        status: "failed",
        phase: input.phase,
        error: input.error,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        type: aiWorkflowJobTypeSchema.parse(row.type),
        status: aiWorkflowJobStatusSchema.parse(row.status),
        payload: readJsonObject(row.payload),
        result: readJsonObject(row.result),
      })),
  });
  if (!row) {
    const existing = await mapRow({
      value: db.aiWorkflowExecutions.findFirst({
        where: { id: input.jobId },
        take: 1,
      }),
      map: (row) =>
        row === null
          ? undefined
          : {
              ...row,
              type: aiWorkflowJobTypeSchema.parse(row.type),
              status: aiWorkflowJobStatusSchema.parse(row.status),
              payload: readJsonObject(row.payload),
              result: readJsonObject(row.result),
            },
    });
    if (existing !== undefined) {
      return parseAiWorkflowJobRow(existing);
    }
    throw new Error(failedToFailAiWorkflowJobMessage(input.jobId));
  }

  return parseAiWorkflowJobRow(row);
}

type ListAiWorkflowJobsForMeetingResult = Promise<
  {
    type:
      | "finalize_meeting"
      | "resolve_meeting_title"
      | "meeting_post_end_pipeline"
      | "generate_meeting_snapshot"
      | "generate_meeting_tasks"
      | "extract_meeting_content"
      | "detect_meeting_signals"
      | "select_capabilities"
      | "draft_capability_payloads"
      | "execute_capability_workflow"
      | "run_meeting_research"
      | "detect_live_meeting_tasks"
      | "detect_ambient_context"
      | "track_meeting"
      | "research_ambient_entity"
      | "enrich_ambient_context_image"
      | "review_linear_tasks"
      | "review_ashby_actions"
      | "deliver_meeting_to_slack";
    status: "completed" | "failed" | "running" | "queued" | "cancelled";
    error: string | null;
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    startedAt: string | null;
    meetingId: string;
    result: Record<string, unknown>;
    runAfter: string;
    attemptCount: number;
    maxAttempts: number;
    lockedBy: string | null;
    lockedAt: string | null;
    payload: Record<string, unknown>;
    phase: string;
    extractionId: string | null;
    scopeKey: string;
  }[]
>;

export async function listAiWorkflowJobsForMeeting(meetingId: string): ListAiWorkflowJobsForMeetingResult {
  const rows = await mapRow({
    value: db.aiWorkflowExecutions.findMany({
      where: { meetingId },
      orderBy: [{ createdAt: "desc" }],
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        type: aiWorkflowJobTypeSchema.parse(row.type),
        status: aiWorkflowJobStatusSchema.parse(row.status),
        payload: readJsonObject(row.payload),
        result: readJsonObject(row.result),
      })),
  });

  return rows.map(parseAiWorkflowJobRow);
}

type GetLatestAiWorkflowJobForMeetingResult = Promise<{
  type:
    | "finalize_meeting"
    | "resolve_meeting_title"
    | "meeting_post_end_pipeline"
    | "generate_meeting_snapshot"
    | "generate_meeting_tasks"
    | "extract_meeting_content"
    | "detect_meeting_signals"
    | "select_capabilities"
    | "draft_capability_payloads"
    | "execute_capability_workflow"
    | "run_meeting_research"
    | "detect_live_meeting_tasks"
    | "detect_ambient_context"
    | "track_meeting"
    | "research_ambient_entity"
    | "enrich_ambient_context_image"
    | "review_linear_tasks"
    | "review_ashby_actions"
    | "deliver_meeting_to_slack";
  status: "completed" | "failed" | "running" | "queued" | "cancelled";
  error: string | null;
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
  meetingId: string;
  result: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  payload: Record<string, unknown>;
  phase: string;
  extractionId: string | null;
  scopeKey: string;
} | null>;

export async function getLatestAiWorkflowJobForMeeting(input: {
  meetingId: string;
  type: AiWorkflowJobType;
  scopeKey?: string;
}): GetLatestAiWorkflowJobForMeetingResult {
  await expireRequestExecutions(input);
  const row = await mapRow({
    value: db.aiWorkflowExecutions.findFirst({
      where:
        input.scopeKey !== undefined && input.scopeKey !== ""
          ? whereAnd([{ meetingId: input.meetingId }, { type: input.type }, { scopeKey: input.scopeKey }])
          : whereAnd([{ meetingId: input.meetingId }, { type: input.type }]),
      orderBy: [{ createdAt: "desc" }],
      take: 1,
    }),
    map: (row) =>
      row === null
        ? undefined
        : {
            ...row,
            type: aiWorkflowJobTypeSchema.parse(row.type),
            status: aiWorkflowJobStatusSchema.parse(row.status),
            payload: readJsonObject(row.payload),
            result: readJsonObject(row.result),
          },
  });

  return row ? parseAiWorkflowJobRow(row) : null;
}

/**
 * Finds ended meetings that have no summary and no active finalization or
 * snapshot job. The AI worker periodically re-enqueues these so a process
 * crash or a failed terminal fallback cannot strand the pipeline forever.
 */
export async function listEndedMeetingIdsNeedingFinalizationRecovery(
  input: {
    olderThanMs?: number;
    limit?: number;
  } = {},
): Promise<string[]> {
  const olderThan = new Date(Date.now() - (input.olderThanMs ?? DEFAULT_FINALIZATION_RECOVERY_AGE_MS));
  const limit = input.limit ?? DEFAULT_OUTBOX_CLAIM_LIMIT;
  const ended = await db.meetings.findMany({
    where: whereAnd([{ status: "ended" }, { endedAt: { not: null } }, { endedAt: { lt: olderThan } }]),
    select: {
      id: true,
      endedAt: true,
    },
  });
  if (ended.length === 0) {
    return [];
  }
  const meetingIds = ended.map((meeting) => meeting.id);
  const [summaryRows, activeJobs] = await Promise.all([
    db.summaries.findMany({
      where: { meetingId: { in: meetingIds } },
      select: {
        meetingId: true,
      },
    }),
    db.aiWorkflowExecutions.findMany({
      where: whereAnd([
        { meetingId: { in: meetingIds } },
        { type: { in: ["finalize_meeting", "generate_meeting_snapshot"] } },
        { status: { in: ["queued", "running"] } },
      ]),
      select: {
        meetingId: true,
      },
    }),
  ]);
  const summarizedMeetingIds = new Set(summaryRows.map((row) => row.meetingId));
  const activeMeetingIds = new Set(activeJobs.map((row) => row.meetingId));

  return ended
    .filter(
      (meeting) =>
        meeting.endedAt !== null && !summarizedMeetingIds.has(meeting.id) && !activeMeetingIds.has(meeting.id),
    )
    .toSorted((left, right) => (left.endedAt?.getTime() ?? 0) - (right.endedAt?.getTime() ?? 0))
    .slice(0, limit)
    .map((meeting) => meeting.id);
}

export async function markMeetingActive(meetingId: string): Promise<void> {
  const started = await db.meetings.updateManyAndReturn({
    where: whereAnd([{ id: meetingId }, { status: { not: "ended" } }, { startedAt: null }]),
    data: {
      status: "active",
      startedAt: new Date(),
    },
    select: { id: true },
  });
  if (started.length !== 0) {
    return;
  }

  await db.meetings.updateMany({
    where: whereAnd([{ id: meetingId }, { status: { not: "ended" } }, { startedAt: { not: null } }]),
    data: {
      status: "active",
    },
  });
}

/** Returns true only for the call that moved the meeting to ended; that call owns finalization. */
export async function markMeetingEnded(meetingId: string): Promise<boolean> {
  const meeting = await db.meetings.findUnique({ where: { id: meetingId }, select: { endedAt: true } });
  if (meeting === null) {
    return false;
  }
  const ended = await db.meetings.updateMany({
    where: { id: meetingId, status: { not: "ended" } },
    data: {
      status: "ended",
      endedAt: meeting.endedAt ?? new Date(),
    },
  });

  await markStandardMeetingParticipantsCompletedFirstMeeting(meetingId);

  return ended.count === 1;
}

type UpdateMeetingTimelineResult = Promise<{
  id: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  workspaceId: string;
  createdByUserId: string;
  kind: MeetingKind;
  status: "scheduled" | "active" | "ended";
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
}>;

export async function updateMeetingTimeline(input: {
  meetingId: string;
  startedAt: Date;
  endedAt: Date;
  status?: "scheduled" | "active" | "ended";
}): UpdateMeetingTimelineResult {
  const [meeting] = await mapRow({
    value: db.meetings.updateManyAndReturn({
      where: { id: input.meetingId },
      data: {
        status: input.status,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
      },
    }),
    map: (rows) => rows.map((row) => readStoredMeeting(row)),
  });

  if (!meeting) {
    throw new Error(FAILED_TO_UPDATE_MEETING_TIMELINE_MESSAGE);
  }

  return meeting;
}

type UpdateMeetingTitleResult = Promise<{
  id: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  workspaceId: string;
  createdByUserId: string;
  kind: MeetingKind;
  status: "scheduled" | "active" | "ended";
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
}>;

export async function updateMeetingTitle(input: { meetingId: string; title: string }): UpdateMeetingTitleResult {
  const [meeting] = await mapRow({
    value: db.meetings.updateManyAndReturn({
      where: { id: input.meetingId },
      data: {
        title: input.title,
      },
    }),
    map: (rows) => rows.map((row) => readStoredMeeting(row)),
  });

  if (!meeting) {
    throw new Error(FAILED_TO_UPDATE_MEETING_TITLE_MESSAGE);
  }

  return meeting;
}

type UpdateMeetingTitleIfCurrentResult = Promise<{
  id: string;
  title: string;
  roomName: string;
  meetingLinkId: string | null;
  instanceNumber: number;
  workspaceId: string;
  createdByUserId: string;
  kind: MeetingKind;
  status: "scheduled" | "active" | "ended";
  isConfidential: boolean;
  confidentialitySource: "auto" | "manual" | null;
  confidentialityUpdatedByUserId: string | null;
  confidentialityUpdatedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  hiddenFromHistoryAt: Date | null;
  hiddenFromHistoryReason: string | null;
} | null>;

export async function updateMeetingTitleIfCurrent(input: {
  jobId?: string | null;
  meetingId: string;
  currentTitle: string;
  title: string;
}): UpdateMeetingTitleIfCurrentResult {
  return withRequestMutation({
    meetingId: input.meetingId,
    run: async (executor) => {
      // The outer row lock serializes user renames and model-generated titles.
      if (input.jobId !== undefined && input.jobId !== null) {
        const [job] = await executor.$queryRaw<{ status: string; startedAt: Date }[]>`
          SELECT status, started_at AS "startedAt" FROM ai_workflow_executions
          WHERE id = ${input.jobId}::uuid AND meeting_id = ${input.meetingId}::uuid FOR UPDATE
        `;
        if (
          job === undefined ||
          job.status !== "running" ||
          job.startedAt.getTime() <= Date.now() - REQUEST_EXECUTION_MAX_AGE_MS
        ) {
          throw new RequestExecutionExpiredError();
        }
      }
      const current = await executor.meetings.findUnique({ where: { id: input.meetingId } });
      if (current === null || current.title !== input.currentTitle) {
        return null;
      }
      const [meeting] = await executor.meetings.updateManyAndReturn({
        where: { id: input.meetingId },
        data: { title: input.title },
      });

      return meeting === undefined ? null : readStoredMeeting(meeting);
    },
  });
}

export async function listParticipantsForMeeting(meetingId: string): Promise<
  {
    userId: string;
    email: string;
    displayName: string;
    source: "guest" | "auth" | "dev_login" | "debug_import";
    role: "host" | "guest" | "assistant";
    joinedAt: Date;
    leftAt: Date | null;
  }[]
> {
  return mapRow({
    value: db.meetingParticipants.findMany({
      where: whereAnd([{ meetingId }, { users: { deletedAt: null } }]),
      select: {
        role: true,
        joinedAt: true,
        leftAt: true,
        users: { select: { id: true, email: true, displayName: true, source: true } },
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        userId: row.users.id,
        email: row.users.email,
        displayName: row.users.displayName,
        source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.users.source }),
        role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      })),
  });
}

export async function listActiveHumanParticipantsForMeeting(meetingId: string): Promise<
  {
    userId: string;
    displayName: string;
    email: string;
    avatarUrl: string | null;
    role: "host" | "guest" | "assistant";
  }[]
> {
  return mapRow({
    value: db.meetingParticipants.findMany({
      where: whereAnd([
        { meetingId },
        { users: { deletedAt: null } },
        { role: { in: ["host", "guest"] } },
        { leftAt: null },
      ]),
      orderBy: [{ users: { displayName: "asc" } }],
      select: {
        role: true,
        users: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        userId: row.users.id,
        displayName: row.users.displayName,
        email: row.users.email,
        avatarUrl: row.users.avatarUrl,
        role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
      })),
  });
}

type HumanMeetingParticipant = {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  role: "host" | "guest" | "assistant";
};

export async function listHumanParticipantsForMeeting(meetingId: string): Promise<HumanMeetingParticipant[]> {
  return (await listHumanParticipantsForMeetings([meetingId])).get(meetingId) ?? [];
}

/** One query for the host and guest participants of many meetings, keyed by meeting id. */
export async function listHumanParticipantsForMeetings(
  meetingIds: string[],
): Promise<Map<string, HumanMeetingParticipant[]>> {
  const rows =
    meetingIds.length === 0
      ? []
      : await db.meetingParticipants.findMany({
          where: whereAnd([
            { meetingId: { in: meetingIds } },
            { users: { deletedAt: null } },
            { role: { in: ["host", "guest"] } },
          ]),
          orderBy: [{ users: { displayName: "asc" } }],
          select: {
            meetingId: true,
            role: true,
            users: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
          },
        });

  const byMeeting = new Map<string, HumanMeetingParticipant[]>(meetingIds.map((meetingId) => [meetingId, []]));
  rows.forEach((row) => {
    byMeeting.set(row.meetingId, [
      ...(byMeeting.get(row.meetingId) ?? []),
      {
        userId: row.users.id,
        displayName: row.users.displayName,
        email: row.users.email,
        avatarUrl: row.users.avatarUrl,
        role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
      },
    ]);
  });

  return byMeeting;
}

type GetMeetingRuntimeStateResult = Promise<{
  activeHumanParticipantCount: number;
  activeHumanParticipants: {
    userId: string;
    displayName: string;
    email: string;
    avatarUrl: string | null;
    role: "host" | "guest" | "assistant";
  }[];
  allHumanParticipants: {
    userId: string;
    displayName: string;
    email: string;
    avatarUrl: string | null;
    role: "host" | "guest" | "assistant";
  }[];
}>;

export async function getMeetingRuntimeState(meetingId: string): GetMeetingRuntimeStateResult {
  const [activeHumanParticipants, allHumanParticipants] = await Promise.all([
    listActiveHumanParticipantsForMeeting(meetingId),
    listHumanParticipantsForMeeting(meetingId),
  ]);

  return {
    activeHumanParticipantCount: activeHumanParticipants.length,
    activeHumanParticipants,
    allHumanParticipants,
  };
}

function toNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toOptionalIso(value: unknown) {
  return value instanceof Date ? value.toISOString() : null;
}

type CreditUsageFilterInput = {
  startDate?: Date | null;
  endDate?: Date | null;
  actionType?: string | null;
  model?: string | null;
};

function buildCreditUsageWhere(input: CreditUsageFilterInput) {
  const actionType = input.actionType?.trim() ?? "";
  const model = input.model?.trim() ?? "";
  const filters = [
    input.startDate !== undefined && input.startDate !== null ? { createdAt: { gte: input.startDate } } : undefined,
    input.endDate !== undefined && input.endDate !== null ? { createdAt: { lt: input.endDate } } : undefined,
    actionType !== "" ? { actionType: normalizeCreditActionType(actionType) } : undefined,
    model !== "" ? { model } : undefined,
  ].filter((filter) => filter !== undefined);

  return filters.length === 0 ? undefined : whereAnd(filters);
}

const creditUsageSnakeRow = (input: {
  creditsCharged: string | number | null;
  actualCostMicroUsd: string | number | null;
  revenueMicroUsd: string | number | null;
  profitMicroUsd: string | number | null;
  eventCount?: number;
}): Record<string, unknown> => ({
  credits_charged: input.creditsCharged ?? 0,
  actual_cost_micro_usd: input.actualCostMicroUsd ?? 0,
  revenue_micro_usd: input.revenueMicroUsd ?? 0,
  profit_micro_usd: input.profitMicroUsd ?? 0,
  ...(input.eventCount !== undefined ? { event_count: input.eventCount } : {}),
});

const UNPRICED_CREDIT_EVENT_WARNING = "Some credit events include unpriced provider calls.";

const countUnpricedCreditEvents = (rows: { metadata: Record<string, unknown> }[]): number =>
  rows.filter((row) => {
    const value = row.metadata.unpricedCallCount;

    return typeof value === "number" && value > 0;
  }).length;

const firstRankDifference = (ranks: number[]): number => ranks.find((rank) => rank !== 0) ?? 0;

const mergeCreditUsageModels = (
  rows: {
    model: string | null;
    creditsCharged: string | null;
    actualCostMicroUsd: string | null;
    revenueMicroUsd: string | null;
    profitMicroUsd: string | null;
    eventCount: number;
  }[],
) => {
  const grouped: Record<
    string,
    {
      creditsCharged: number;
      actualCostMicroUsd: number;
      revenueMicroUsd: number;
      profitMicroUsd: number;
      eventCount: number;
    }
  > = {};
  rows.forEach((row) => {
    const key = row.model ?? "unknown";
    const current = grouped[key] ?? {
      creditsCharged: 0,
      actualCostMicroUsd: 0,
      revenueMicroUsd: 0,
      profitMicroUsd: 0,
      eventCount: 0,
    };
    grouped[key] = {
      creditsCharged: current.creditsCharged + toNumber(row.creditsCharged),
      actualCostMicroUsd: current.actualCostMicroUsd + toNumber(row.actualCostMicroUsd),
      revenueMicroUsd: current.revenueMicroUsd + toNumber(row.revenueMicroUsd),
      profitMicroUsd: current.profitMicroUsd + toNumber(row.profitMicroUsd),
      eventCount: current.eventCount + row.eventCount,
    };
  });

  return Object.entries(grouped)
    .map(([model, totals]) => ({ model, ...totals }))
    .toSorted((left, right) =>
      firstRankDifference([right.revenueMicroUsd - left.revenueMicroUsd, left.model.localeCompare(right.model)]),
    );
};

function formatActionLabel(actionType: string) {
  return actionType.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getCreditUsageTotals(input: { row: Record<string, unknown>; fallbackPricePerCreditMicroUsd: number }) {
  const row = input.row;
  const fallbackPricePerCreditMicroUsd = input.fallbackPricePerCreditMicroUsd;
  const creditsCharged = toNumber(row.credits_charged);
  const actualCostMicroUsd = toNumber(row.actual_cost_micro_usd);
  const revenueMicroUsd = toNumber(row.revenue_micro_usd);
  const profitMicroUsd = toNumber(row.profit_micro_usd);
  const pricePerCreditMicroUsd =
    creditsCharged > 0 ? Math.max(1, Math.round(revenueMicroUsd / creditsCharged)) : fallbackPricePerCreditMicroUsd;

  return {
    creditsCharged,
    actualCostMicroUsd,
    revenueMicroUsd,
    profitMicroUsd,
    grossMargin: grossMarginFromMicroUsd({ revenueMicroUsd, profitMicroUsd }),
    averageCostPerCreditMicroUsd: creditsCharged > 0 ? Math.max(0, Math.round(actualCostMicroUsd / creditsCharged)) : 0,
    pricePerCreditMicroUsd,
  };
}

type GetAdminAiUsageSummaryDataResult = Promise<{
  generatedAt: string;
  range: { startDate: string | null; endDate: string | null };
  totals: {
    creditsCharged: number;
    actualCostMicroUsd: number;
    revenueMicroUsd: number;
    profitMicroUsd: number;
    grossMargin: number | null;
    averageCostPerCreditMicroUsd: number;
    pricePerCreditMicroUsd: number;
  };
  byActionType: {
    key: string;
    label: string;
    creditsCharged: number;
    actualCostMicroUsd: number;
    revenueMicroUsd: number;
    profitMicroUsd: number;
    grossMargin: number | null;
    eventCount: number;
  }[];
  byModel: {
    key: string;
    label: string;
    creditsCharged: number;
    actualCostMicroUsd: number;
    revenueMicroUsd: number;
    profitMicroUsd: number;
    grossMargin: number | null;
    eventCount: number;
  }[];
  warnings: string[];
}>;

const creditUsageBreakdown = (input: {
  row: Record<string, unknown>;
  key: string;
  label: string;
  fallbackPricePerCreditMicroUsd: number;
}) => {
  const totals = getCreditUsageTotals({
    row: input.row,
    fallbackPricePerCreditMicroUsd: input.fallbackPricePerCreditMicroUsd,
  });

  return {
    key: input.key,
    label: input.label,
    creditsCharged: totals.creditsCharged,
    actualCostMicroUsd: totals.actualCostMicroUsd,
    revenueMicroUsd: totals.revenueMicroUsd,
    profitMicroUsd: totals.profitMicroUsd,
    grossMargin: totals.grossMargin,
    eventCount: toNumber(input.row.event_count),
  };
};

const loadAdminCreditUsageBuckets = (where: ReturnType<typeof buildCreditUsageWhere>) =>
  Promise.all([
    mapRow({
      value: db.aiCreditUsageEvents.aggregate({
        where,
        _sum: { creditsCharged: true, actualCostMicroUsd: true, revenueMicroUsd: true, profitMicroUsd: true },
      }),
      map: (row) => [
        {
          creditsCharged: row._sum.creditsCharged === null ? null : String(row._sum.creditsCharged),
          actualCostMicroUsd: row._sum.actualCostMicroUsd === null ? null : String(row._sum.actualCostMicroUsd),
          revenueMicroUsd: row._sum.revenueMicroUsd === null ? null : String(row._sum.revenueMicroUsd),
          profitMicroUsd: row._sum.profitMicroUsd === null ? null : String(row._sum.profitMicroUsd),
        },
      ],
    }),
    mapRow({
      value: db.aiCreditUsageEvents.groupBy({
        by: ["actionType"],
        where,
        _sum: { creditsCharged: true, actualCostMicroUsd: true, revenueMicroUsd: true, profitMicroUsd: true },
        _count: { _all: true },
      }),
      map: (rows) =>
        rows.map((row) => ({
          actionType: row.actionType,
          creditsCharged: row._sum.creditsCharged === null ? null : String(row._sum.creditsCharged),
          actualCostMicroUsd: row._sum.actualCostMicroUsd === null ? null : String(row._sum.actualCostMicroUsd),
          revenueMicroUsd: row._sum.revenueMicroUsd === null ? null : String(row._sum.revenueMicroUsd),
          profitMicroUsd: row._sum.profitMicroUsd === null ? null : String(row._sum.profitMicroUsd),
          eventCount: row._count._all,
        })),
    }),
    mapRow({
      value: db.aiCreditUsageEvents.groupBy({
        by: ["model"],
        where,
        _sum: { creditsCharged: true, actualCostMicroUsd: true, revenueMicroUsd: true, profitMicroUsd: true },
        _count: { _all: true },
      }),
      map: (rows) =>
        rows.map((row) => ({
          model: row.model,
          creditsCharged: row._sum.creditsCharged === null ? null : String(row._sum.creditsCharged),
          actualCostMicroUsd: row._sum.actualCostMicroUsd === null ? null : String(row._sum.actualCostMicroUsd),
          revenueMicroUsd: row._sum.revenueMicroUsd === null ? null : String(row._sum.revenueMicroUsd),
          profitMicroUsd: row._sum.profitMicroUsd === null ? null : String(row._sum.profitMicroUsd),
          eventCount: row._count._all,
        })),
    }),
    mapRow({
      value: db.aiCreditUsageEvents.findMany({
        where,
        select: {
          metadata: true,
        },
      }),
      map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
    }),
  ]);

export async function getAdminAiUsageSummaryData(input: CreditUsageFilterInput = {}): GetAdminAiUsageSummaryDataResult {
  const pricing = await getActiveAiCreditPricingConfig();
  const where = buildCreditUsageWhere(input);
  const [totalsRows, actionRows, modelRows, metadataRows] = await loadAdminCreditUsageBuckets(where);
  const orderedActions = actionRows.toSorted((left, right) =>
    firstRankDifference([
      toNumber(right.revenueMicroUsd) - toNumber(left.revenueMicroUsd),
      left.actionType.localeCompare(right.actionType),
    ]),
  );
  const orderedModels = mergeCreditUsageModels(modelRows);

  return {
    generatedAt: new Date().toISOString(),
    range: {
      startDate: input.startDate?.toISOString() ?? null,
      endDate: input.endDate?.toISOString() ?? null,
    },
    totals: getCreditUsageTotals({
      row: creditUsageSnakeRow(
        totalsRows[0] ?? {
          creditsCharged: 0,
          actualCostMicroUsd: 0,
          revenueMicroUsd: 0,
          profitMicroUsd: 0,
        },
      ),
      fallbackPricePerCreditMicroUsd: pricing.pricePerCreditMicroUsd,
    }),
    byActionType: orderedActions.map((row) =>
      creditUsageBreakdown({
        row: creditUsageSnakeRow(row),
        key: row.actionType,
        label: formatActionLabel(row.actionType),
        fallbackPricePerCreditMicroUsd: pricing.pricePerCreditMicroUsd,
      }),
    ),
    byModel: orderedModels.map((row) =>
      creditUsageBreakdown({
        row: creditUsageSnakeRow(row),
        key: row.model,
        label: row.model,
        fallbackPricePerCreditMicroUsd: pricing.pricePerCreditMicroUsd,
      }),
    ),
    warnings: countUnpricedCreditEvents(metadataRows) > 0 ? [UNPRICED_CREDIT_EVENT_WARNING] : [],
  };
}

type GetAdminAiUsageEventsDataResult = Promise<{
  events: {
    id: string;
    createdAt: string;
    user: {
      id: string;
      email: string;
      displayName: string;
      avatarUrl: string | null;
    };
    meeting: { id: string; title: string } | null;
    actionType: string;
    actionLabel: string;
    provider: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    toolCallCount: number;
    actualCostMicroUsd: number;
    pricePerCreditMicroUsd: number;
    creditsCharged: number;
    revenueMicroUsd: number;
    profitMicroUsd: number;
    grossMargin: number | null;
    /** @external existing wire contract */ included: boolean;
    metadata: Record<string, unknown>;
  }[];
  totalCount: number;
}>;

const UNTITLED_MEETING_TITLE = "Untitled meeting";

const creditUsageEventSortValue = (input: {
  createdAt: Date;
  actualCostMicroUsd: number;
  creditsCharged: number;
  revenueMicroUsd: number;
  profitMicroUsd: number;
  sort: string;
}): number | null => {
  if (input.sort === "cost") {
    return input.actualCostMicroUsd;
  }
  if (input.sort === "credits") {
    return input.creditsCharged;
  }
  if (input.sort === "revenue") {
    return input.revenueMicroUsd;
  }
  if (input.sort === "profit") {
    return input.profitMicroUsd;
  }
  if (input.sort === "margin") {
    return input.revenueMicroUsd > 0 ? input.profitMicroUsd / input.revenueMicroUsd : null;
  }

  return input.createdAt.getTime();
};

const compareNullableNumbers = (input: {
  left: number | null;
  right: number | null;
  direction: "asc" | "desc";
}): number => {
  if (input.left === null || input.right === null) {
    if (input.left === null && input.right === null) {
      return 0;
    }

    return input.left === null ? 1 : -1;
  }

  return input.direction === "asc" ? input.left - input.right : input.right - input.left;
};
type mapAdminCreditUsageEventRow13 = {
  id: string;
  createdAt: Date;
  userId: string;
  meetingId: string | null;
  actionType: string;
  actionLabel: string;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCallCount: number;
  actualCostMicroUsd: number;
  pricePerCreditMicroUsd: number;
  creditsCharged: number;
  revenueMicroUsd: number;
  profitMicroUsd: number;
  /** @external billing usage response */ included: boolean;
  metadata: Record<string, unknown>;
  userEmail: string;
  userDisplayName: string;
  userAvatarUrl: string | null;
  meetingTitle: string | null;
};

const mapAdminCreditUsageEvent = (row: mapAdminCreditUsageEventRow13) => ({
  id: row.id,
  createdAt: row.createdAt.toISOString(),
  user: {
    id: row.userId,
    email: row.userEmail,
    displayName: row.userDisplayName,
    avatarUrl: row.userAvatarUrl,
  },
  meeting:
    row.meetingId !== null && row.meetingId !== ""
      ? { id: row.meetingId, title: row.meetingTitle ?? UNTITLED_MEETING_TITLE }
      : null,
  actionType: normalizeCreditActionType(row.actionType),
  actionLabel: row.actionLabel,
  provider: row.provider,
  model: row.model,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cachedInputTokens: row.cachedInputTokens,
  toolCallCount: row.toolCallCount,
  actualCostMicroUsd: row.actualCostMicroUsd,
  pricePerCreditMicroUsd: row.pricePerCreditMicroUsd,
  creditsCharged: row.creditsCharged,
  revenueMicroUsd: row.revenueMicroUsd,
  profitMicroUsd: row.profitMicroUsd,
  grossMargin: grossMarginFromMicroUsd({ revenueMicroUsd: row.revenueMicroUsd, profitMicroUsd: row.profitMicroUsd }),
  /** @external existing wire contract */ included: row.included,
  metadata: row.metadata,
});

export async function getAdminAiUsageEventsData(
  input: CreditUsageFilterInput & {
    limit?: number | null;
    offset?: number | null;
    sort?: string | null;
    direction?: string | null;
  } = {},
): GetAdminAiUsageEventsDataResult {
  const direction = input.direction === "asc" ? "asc" : "desc";
  const sort = input.sort ?? "date";
  const limit = Math.min(ADMIN_USAGE_MAX_LIMIT, Math.max(1, Math.round(input.limit ?? ADMIN_USAGE_DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.round(input.offset ?? 0));
  const [eventRows, countRows] = await Promise.all([
    mapRow({
      value: db.aiCreditUsageEvents.findMany({
        where: whereAnd([buildCreditUsageWhere(input), { users: { deletedAt: null } }]),
        select: {
          id: true,
          createdAt: true,
          userId: true,
          meetingId: true,
          actionType: true,
          actionLabel: true,
          provider: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          cachedInputTokens: true,
          toolCallCount: true,
          actualCostMicroUsd: true,
          pricePerCreditMicroUsd: true,
          creditsCharged: true,
          revenueMicroUsd: true,
          profitMicroUsd: true,
          included: true,
          metadata: true,
          users: { select: { email: true, displayName: true, avatarUrl: true } },
          meetings: { select: { title: true } },
        },
      }),
      map: (rows) =>
        rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          userId: row.userId,
          meetingId: row.meetingId,
          actionType: row.actionType,
          actionLabel: row.actionLabel,
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cachedInputTokens: row.cachedInputTokens,
          toolCallCount: row.toolCallCount,
          actualCostMicroUsd: row.actualCostMicroUsd,
          pricePerCreditMicroUsd: row.pricePerCreditMicroUsd,
          creditsCharged: row.creditsCharged,
          revenueMicroUsd: row.revenueMicroUsd,
          profitMicroUsd: row.profitMicroUsd,
          /** @external existing wire contract */ included: row.included,
          metadata: readJsonObject(row.metadata),
          userEmail: row.users.email,
          userDisplayName: row.users.displayName,
          userAvatarUrl: row.users.avatarUrl,
          meetingTitle: row.meetings?.title ?? null,
        })),
    }),
    mapRow({
      value: db.aiCreditUsageEvents.count({
        where: whereAnd([buildCreditUsageWhere(input), { users: { deletedAt: null } }]),
      }),
      map: (value) => [{ totalCount: value }],
    }),
  ]);
  const page = eventRows
    .toSorted((left, right) =>
      compareNullableNumbers({
        left: creditUsageEventSortValue({ ...left, sort }),
        right: creditUsageEventSortValue({ ...right, sort }),
        direction,
      }),
    )
    .slice(offset, offset + limit);

  return {
    events: page.map(mapAdminCreditUsageEvent),
    totalCount: countRows[0]?.totalCount ?? 0,
  };
}

export async function getUserCreditUsageData(input: {
  userId: string;
  startDate?: Date;
  endDate?: Date;
}): Promise<{ billingPeriod: { startDate: string; endDate: string }; creditsUsed: number; actionCount: number }> {
  const startDate = input.startDate ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const endDate = input.endDate ?? new Date();
  const [row] = await mapRow({
    value: db.aiCreditUsageEvents.aggregate({
      where: whereAnd([{ userId: input.userId }, { createdAt: { gte: startDate } }, { createdAt: { lt: endDate } }]),
      _sum: { creditsCharged: true },
      _count: { _all: true },
    }),
    map: (row) => [
      {
        creditsCharged: row._sum.creditsCharged === null ? null : String(row._sum.creditsCharged),
        actionCount: row._count._all,
      },
    ],
  });

  return {
    billingPeriod: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    },
    creditsUsed: toNumber(row.creditsCharged),
    actionCount: row.actionCount,
  };
}

const truncSum = (values: number[]): number => Math.trunc(values.reduce((total, value) => total + value, 0));

const roundedSum = (values: number[]): number => Math.round(values.reduce((total, value) => total + value, 0));

const utcMonthStart = (instant: Date): Date => new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1));

const utcMonthKey = (instant: Date): string => utcMonthStart(instant).toISOString();

const isOnOrAfter = (input: { instant: Date; cutoff: Date }): boolean =>
  input.instant.getTime() >= input.cutoff.getTime();

const groupRows = <Row>(input: { rows: Row[]; keyOf: (row: Row) => string }): Map<string, Row[]> => {
  const grouped = new Map<string, Row[]>();
  input.rows.forEach((row) => {
    const key = input.keyOf(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  });

  return grouped;
};

const latestByUpdatedAt = <Row extends { updatedAt: Date }>(rows: Row[]): Row | null =>
  rows.reduce<Row | null>((current, row) => {
    if (current === null || row.updatedAt.getTime() >= current.updatedAt.getTime()) {
      return row;
    }

    return current;
  }, null);

const elapsedSeconds = (input: { startedAt: Date | null; endedAt: Date | null; createdAt: Date; now: Date }): number =>
  Math.max(
    0,
    ((input.endedAt ?? input.now).getTime() - (input.startedAt ?? input.createdAt).getTime()) / MILLISECONDS_PER_SECOND,
  );

const loadAdminUserRows = () =>
  mapRow({
    value: db.users.findMany({
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        source: true,
        plan: true,
        privateBetaProEnabledAt: true,
        deletedAt: true,
        createdAt: true,
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        source: readStringUnion({ values: ["auth", "dev_login", "debug_import", "guest"], value: row.source }),
        plan: readStringUnion({
          values: ["free", "pro", "max", "business", "business_multilingual", "enterprise"],
          value: row.plan,
        }),
      })),
  });

const loadAdminAccountRows = () =>
  db.userAuthAccounts.findMany({
    select: {
      userId: true,
      provider: true,
      providerAccountId: true,
      firstAuthenticatedAt: true,
      lastAuthenticatedAt: true,
      authCount: true,
    },
  });

const loadAdminMeetingRows = () =>
  mapRow({
    value: db.meetings.findMany({
      select: {
        id: true,
        title: true,
        roomName: true,
        status: true,
        createdAt: true,
        startedAt: true,
        endedAt: true,
        createdByUserId: true,
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        ...row,
        status: readStringUnion({ values: ["scheduled", "active", "ended"], value: row.status }),
      })),
  });

const loadAdminTranscriptRows = () =>
  mapRow({
    value: db.transcripts.findMany({
      select: {
        id: true,
        meetingId: true,
        source: true,
        metadata: true,
      },
    }),
    map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
  });

const loadAdminParticipantRows = () =>
  mapRow({
    value: db.meetingParticipants.findMany({
      select: {
        meetingId: true,
        userId: true,
        role: true,
        joinedAt: true,
        leftAt: true,
        users: { select: { displayName: true } },
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        meetingId: row.meetingId,
        userId: row.userId,
        role: readStringUnion({ values: ["host", "guest", "assistant"], value: row.role }),
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
        displayName: row.users.displayName,
      })),
  });

const loadAdminJobRows = () =>
  (async () => {
    const where26 = Prisma.empty;
    const join260 = sqlColCompare({
      leftSql: '"meetings"."id"',
      operator: "=",
      rightSql: '"ai_workflow_executions"."meeting_id"',
    });
    const join261 = sqlColCompare({
      leftSql: '"users"."id"',
      operator: "=",
      rightSql: '"meetings"."created_by_user_id"',
    });

    return decodeContentAliases({
      rows: await db.$queryRaw<
        {
          id: string;
          meetingId: string;
          type: AiWorkflowJobType;
          status: AiWorkflowJobStatus;
          phase: string;
          startedAt: Date;
          createdAt: Date;
          updatedAt: Date;
          error: string | null;
          meetingTitle: string;
          hostUserId: string;
          hostEmail: string;
          hostDeletedAt: Date | null;
        }[]
      >`
  SELECT "ai_workflow_executions"."id" AS "id",
  "ai_workflow_executions"."meeting_id" AS "meetingId",
  "ai_workflow_executions"."type" AS "type",
  "ai_workflow_executions"."status" AS "status",
  "ai_workflow_executions"."phase" AS "phase",
  "ai_workflow_executions"."started_at" AS "startedAt",
  "ai_workflow_executions"."created_at" AS "createdAt",
  "ai_workflow_executions"."updated_at" AS "updatedAt",
  "ai_workflow_executions"."error" AS "error",
  "meetings"."title" AS "meetingTitle",
  "meetings"."created_by_user_id" AS "hostUserId",
  "users"."email" AS "hostEmail",
  "users"."deleted_at" AS "hostDeletedAt"
  FROM "ai_workflow_executions"
  INNER JOIN "meetings" ON ${join260}
  INNER JOIN "users" ON ${join261}
  ${sqlWhereClause(where26)}





  `,
      projections: [
        { model: "meetings", fields: { id: "meetingId", title: "meetingTitle" } },
        { model: "aiWorkflowExecutions", fields: { id: "id", error: CONTENT_ERROR_FIELD } },
      ],
    });
  })();

const loadAdminWorkflowRows = () =>
  (async () => {
    const where27 = Prisma.empty;
    const join270 = sqlColCompare({
      leftSql: '"meetings"."id"',
      operator: "=",
      rightSql: '"capability_workflow_runs"."meeting_id"',
    });
    const join271 = sqlColCompare({
      leftSql: '"users"."id"',
      operator: "=",
      rightSql: '"meetings"."created_by_user_id"',
    });

    return decodeContentAliases({
      rows: await db.$queryRaw<
        {
          id: string;
          meetingId: string;
          capabilityKey: string;
          status: CapabilityWorkflowStatus;
          phase: CapabilityWorkflowPhase;
          createdAt: Date;
          updatedAt: Date;
          error: string | null;
          meetingTitle: string;
          hostUserId: string;
          hostEmail: string;
          hostDeletedAt: Date | null;
        }[]
      >`
  SELECT "capability_workflow_runs"."id" AS "id",
  "capability_workflow_runs"."meeting_id" AS "meetingId",
  "capability_workflow_runs"."capability_key" AS "capabilityKey",
  "capability_workflow_runs"."status" AS "status",
  "capability_workflow_runs"."phase" AS "phase",
  "capability_workflow_runs"."created_at" AS "createdAt",
  "capability_workflow_runs"."updated_at" AS "updatedAt",
  "capability_workflow_runs"."error" AS "error",
  "meetings"."title" AS "meetingTitle",
  "meetings"."created_by_user_id" AS "hostUserId",
  "users"."email" AS "hostEmail",
  "users"."deleted_at" AS "hostDeletedAt"
  FROM "capability_workflow_runs"
  INNER JOIN "meetings" ON ${join270}
  INNER JOIN "users" ON ${join271}
  ${sqlWhereClause(where27)}





  `,
      projections: [
        { model: "meetings", fields: { id: "meetingId", title: "meetingTitle" } },
        { model: "capabilityWorkflowRuns", fields: { id: "id", error: CONTENT_ERROR_FIELD } },
      ],
    });
  })();

const loadAdminCreditRows = () =>
  db.aiCreditUsageEvents.findMany({
    select: {
      userId: true,
      creditsCharged: true,
      revenueMicroUsd: true,
      createdAt: true,
    },
  });

const loadAdminUsageRows = () =>
  mapRow({
    value: db.usageEvents.findMany({
      select: {
        userId: true,
        category: true,
        model: true,
        sku: true,
        unitCount: true,
        costMicroUsd: true,
        metadata: true,
        occurredAt: true,
      },
    }),
    map: (rows) => rows.map((row) => ({ ...row, metadata: readJsonObject(row.metadata) })),
  });

const loadAdminSubscriptionRows = () =>
  db.billingSubscriptions.findMany({
    select: {
      userId: true,
      workspaceId: true,
      status: true,
      planInterval: true,
      currentPeriodEnd: true,
      statusChangedAt: true,
      updatedAt: true,
    },
  });

const loadAdminMembershipRows = () =>
  mapRow({
    value: db.workspaceMemberships.findMany({
      select: {
        userId: true,
        workspaceId: true,
        status: true,
      },
    }),
    map: (rows) =>
      rows.map((row) => ({ ...row, status: readStringUnion({ values: ["active", "suspended"], value: row.status }) })),
  });

const loadAdminWorkspaceRows = () =>
  db.workspaces.findMany({
    select: {
      id: true,
      name: true,
    },
  });

const loadAdminPrivateBetaRows = () =>
  db.privateBetaWaitlistEntries.findMany({
    select: {
      id: true,
      userId: true,
      requestedAt: true,
      updatedAt: true,
    },
  });

const loadAdminTurnRows = () =>
  mapRow({
    value: db.meetingTurns.findMany({
      select: {
        id: true,
        meetingId: true,
        ownerUserId: true,
        assistantDisplayName: true,
        status: true,
        startedAt: true,
        updatedAt: true,
        meetings: { select: { title: true } },
        users: { select: { email: true, deletedAt: true } },
      },
    }),
    map: (rows) =>
      rows.map((row) => ({
        id: row.id,
        meetingId: row.meetingId,
        ownerUserId: row.ownerUserId,
        assistantDisplayName: row.assistantDisplayName,
        status: row.status,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
        meetingTitle: row.meetings.title,
        userEmail: row.users.email,
        userDeletedAt: row.users.deletedAt,
      })),
  });

const loadAdminOverviewSources = async () => {
  const [
    userRows,
    accountRows,
    meetingRows,
    transcriptRows,
    participantRows,
    jobRows,
    workflowRows,
    creditRows,
    usageRows,
    subscriptionRows,
    membershipRows,
    workspaceRows,
    privateBetaRows,
    turnRows,
  ] = await Promise.all([
    loadAdminUserRows(),
    loadAdminAccountRows(),
    loadAdminMeetingRows(),
    loadAdminTranscriptRows(),
    loadAdminParticipantRows(),
    loadAdminJobRows(),
    loadAdminWorkflowRows(),
    loadAdminCreditRows(),
    loadAdminUsageRows(),
    loadAdminSubscriptionRows(),
    loadAdminMembershipRows(),
    loadAdminWorkspaceRows(),
    loadAdminPrivateBetaRows(),
    loadAdminTurnRows(),
  ]);

  return {
    userRows,
    accountRows,
    meetingRows,
    transcriptRows,
    participantRows,
    jobRows,
    workflowRows,
    creditRows,
    usageRows,
    subscriptionRows,
    membershipRows,
    workspaceRows,
    privateBetaRows,
    turnRows,
  };
};

type AdminOverviewSources = Awaited<ReturnType<typeof loadAdminOverviewSources>>;
type AdminUser = AdminOverviewSources["userRows"][number];
type AdminAccount = AdminOverviewSources["accountRows"][number];
type AdminMeeting = AdminOverviewSources["meetingRows"][number];
type AdminUsage = AdminOverviewSources["usageRows"][number];
type AdminCredit = AdminOverviewSources["creditRows"][number];
type AdminSubscription = AdminOverviewSources["subscriptionRows"][number];
type AdminParticipant = AdminOverviewSources["participantRows"][number];
type AdminJob = AdminOverviewSources["jobRows"][number];
type AdminWorkflow = AdminOverviewSources["workflowRows"][number];
type AdminTurn = AdminOverviewSources["turnRows"][number];
type AdminTranscript = AdminOverviewSources["transcriptRows"][number];

type AccountMetrics = {
  accounts: Record<string, unknown>[];
  firstAuthenticatedAt: Date | null;
  lastAuthenticatedAt: Date | null;
  authCount: number;
};

type HostedMetrics = {
  hostedMeetingsCount: number;
  transcribedMeetingsCount: number;
  activeMeetingsCount: number;
  transcribedSeconds: number;
  lastMeetingAt: Date | null;
};

type JobMetrics = {
  snapshotJobCount: number;
  taskJobCount: number;
  capabilityJobCount: number;
  failedJobCount: number;
};

type WorkflowMetrics = {
  workflowRunCount: number;
  workflowCompletedCount: number;
};

type CreditMetrics = {
  creditsCharged: number;
  monthCreditsCharged: number;
  creditRevenueMicroUsd: number;
  creditMonthRevenueMicroUsd: number;
  creditActionCount: number;
  creditMonthActionCount: number;
};

type UsageMetrics = {
  trackedCostMicroUsd: number;
  trackedMonthCostMicroUsd: number;
};

type LlmBucket = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  monthCostMicroUsd: number;
  callCount: number;
  unpricedCallCount: number;
};

type LlmMetrics = {
  modelUsage: Record<string, unknown>[];
  llmCostMicroUsd: number;
  llmMonthCostMicroUsd: number;
  llmUnpricedCallCount: number;
};

type LiveKitMetrics = {
  livekitCostMicroUsd: number;
  livekitMonthCostMicroUsd: number;
  livekitParticipantSeconds: number;
  livekitMonthParticipantSeconds: number;
  livekitEventCount: number;
  livekitMonthEventCount: number;
};

type FixedMetrics = {
  fixedCostMicroUsd: number;
  fixedMonthCostMicroUsd: number;
};

type MonthAmount = {
  userId: string;
  monthKey: string;
  amount: number;
  eventCount: number;
};

const accountMetrics = (rows: AdminAccount[]): AccountMetrics => {
  const ordered = rows.toSorted(
    (left, right) => right.lastAuthenticatedAt.getTime() - left.lastAuthenticatedAt.getTime(),
  );
  const firstAuthenticatedAt = ordered.reduce<Date | null>((current, row) => {
    if (current === null || row.firstAuthenticatedAt.getTime() < current.getTime()) {
      return row.firstAuthenticatedAt;
    }

    return current;
  }, null);

  return {
    accounts: ordered.map((row) => ({
      provider: row.provider,
      providerAccountId: row.providerAccountId,
      firstAuthenticatedAt: row.firstAuthenticatedAt.toISOString(),
      lastAuthenticatedAt: row.lastAuthenticatedAt.toISOString(),
      authCount: row.authCount,
    })),
    firstAuthenticatedAt,
    lastAuthenticatedAt: ordered[0]?.lastAuthenticatedAt ?? null,
    authCount: Math.trunc(ordered.reduce((total, row) => total + row.authCount, 0)),
  };
};

const hostedMetrics = (input: {
  meetings: AdminMeeting[];
  transcriptMeetingIds: ReadonlySet<string>;
  now: Date;
}): HostedMetrics => {
  const transcribed = input.meetings.filter((meeting) => input.transcriptMeetingIds.has(meeting.id));
  const lastMeetingAt = input.meetings.reduce<Date | null>((current, meeting) => {
    if (current === null || meeting.createdAt.getTime() > current.getTime()) {
      return meeting.createdAt;
    }

    return current;
  }, null);

  return {
    hostedMeetingsCount: input.meetings.length,
    transcribedMeetingsCount: transcribed.length,
    activeMeetingsCount: input.meetings.filter((meeting) => meeting.status === "active").length,
    transcribedSeconds: truncSum(transcribed.map((meeting) => elapsedSeconds({ ...meeting, now: input.now }))),
    lastMeetingAt,
  };
};

const jobMetrics = (rows: { type: string; status: string }[]): JobMetrics => ({
  snapshotJobCount: rows.filter((row) => row.type === "generate_meeting_snapshot").length,
  taskJobCount: rows.filter((row) => row.type === "generate_meeting_tasks").length,
  capabilityJobCount: rows.filter((row) => row.type === "meeting_post_end_pipeline").length,
  failedJobCount: rows.filter((row) => row.status === "failed").length,
});

const workflowMetrics = (rows: { status: string }[]): WorkflowMetrics => ({
  workflowRunCount: rows.length,
  workflowCompletedCount: rows.filter((row) => row.status === "completed").length,
});

const creditMetrics = (input: { rows: AdminCredit[]; monthStart: Date }): CreditMetrics => {
  const monthRows = input.rows.filter((row) => isOnOrAfter({ instant: row.createdAt, cutoff: input.monthStart }));

  return {
    creditsCharged: truncSum(input.rows.map((row) => row.creditsCharged)),
    monthCreditsCharged: truncSum(monthRows.map((row) => row.creditsCharged)),
    creditRevenueMicroUsd: truncSum(input.rows.map((row) => row.revenueMicroUsd)),
    creditMonthRevenueMicroUsd: truncSum(monthRows.map((row) => row.revenueMicroUsd)),
    creditActionCount: input.rows.length,
    creditMonthActionCount: monthRows.length,
  };
};

const usageCostMetrics = (input: { rows: AdminUsage[]; monthStart: Date }): UsageMetrics => {
  const tracked = input.rows.filter((row) => row.category !== "realtime_room");
  const monthRows = tracked.filter((row) => isOnOrAfter({ instant: row.occurredAt, cutoff: input.monthStart }));

  return {
    trackedCostMicroUsd: truncSum(tracked.map((row) => row.costMicroUsd)),
    trackedMonthCostMicroUsd: truncSum(monthRows.map((row) => row.costMicroUsd)),
  };
};

const finiteMetadataNumber = (input: { metadata: Record<string, unknown>; key: string }): number | null => {
  const value = input.metadata[input.key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const llmModelName = (row: { model: string | null; sku: string | null }): string => row.model ?? row.sku ?? "unknown";

const emptyLlmBucket = (model: string): LlmBucket => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costMicroUsd: 0,
  monthCostMicroUsd: 0,
  callCount: 0,
  unpricedCallCount: 0,
});

const addLlmEvent = (input: { bucket: LlmBucket; row: AdminUsage; monthStart: Date }): LlmBucket => {
  const totalTokens = finiteMetadataNumber({ metadata: input.row.metadata, key: "totalTokens" }) ?? input.row.unitCount;
  const monthCost = isOnOrAfter({ instant: input.row.occurredAt, cutoff: input.monthStart })
    ? input.row.costMicroUsd
    : 0;

  return {
    model: input.bucket.model,
    inputTokens:
      input.bucket.inputTokens + (finiteMetadataNumber({ metadata: input.row.metadata, key: "inputTokens" }) ?? 0),
    outputTokens:
      input.bucket.outputTokens + (finiteMetadataNumber({ metadata: input.row.metadata, key: "outputTokens" }) ?? 0),
    totalTokens: input.bucket.totalTokens + totalTokens,
    costMicroUsd: input.bucket.costMicroUsd + input.row.costMicroUsd,
    monthCostMicroUsd: input.bucket.monthCostMicroUsd + monthCost,
    callCount: input.bucket.callCount + 1,
    unpricedCallCount: input.bucket.unpricedCallCount + (metadataRateMissing(input.row.metadata) ? 1 : 0),
  };
};

const finishLlmBucket = (bucket: LlmBucket): LlmBucket => ({
  ...bucket,
  inputTokens: Math.trunc(bucket.inputTokens),
  outputTokens: Math.trunc(bucket.outputTokens),
  totalTokens: Math.trunc(bucket.totalTokens),
  costMicroUsd: Math.trunc(bucket.costMicroUsd),
  monthCostMicroUsd: Math.trunc(bucket.monthCostMicroUsd),
});

const llmMetrics = (input: { rows: AdminUsage[]; monthStart: Date }): LlmMetrics => {
  const grouped = new Map<string, LlmBucket>();
  input.rows
    .filter((row) => row.category === "llm")
    .forEach((row) => {
      const model = llmModelName(row);
      grouped.set(
        model,
        addLlmEvent({
          bucket: grouped.get(model) ?? emptyLlmBucket(model),
          row,
          monthStart: input.monthStart,
        }),
      );
    });
  const models = [...grouped.values()]
    .map(finishLlmBucket)
    .toSorted((left, right) =>
      firstRankDifference([
        right.monthCostMicroUsd - left.monthCostMicroUsd,
        right.costMicroUsd - left.costMicroUsd,
        left.model.localeCompare(right.model),
      ]),
    );

  return {
    modelUsage: models.map((model) => ({
      model: model.model,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      totalTokens: model.totalTokens,
      costMicroUsd: model.costMicroUsd,
      monthCostMicroUsd: model.monthCostMicroUsd,
      callCount: model.callCount,
      unpricedCallCount: model.unpricedCallCount,
    })),
    llmCostMicroUsd: models.reduce((total, model) => total + model.costMicroUsd, 0),
    llmMonthCostMicroUsd: models.reduce((total, model) => total + model.monthCostMicroUsd, 0),
    llmUnpricedCallCount: models.reduce((total, model) => total + model.unpricedCallCount, 0),
  };
};

const liveKitSlices = (rows: AdminUsage[]): MonthAmount[] => {
  const grouped = new Map<string, MonthAmount>();
  rows
    .filter((row) => row.category === "realtime_room")
    .forEach((row) => {
      const monthKey = utcMonthKey(row.occurredAt);
      const key = `${row.userId}:${monthKey}`;
      const current = grouped.get(key) ?? { userId: row.userId, monthKey, amount: 0, eventCount: 0 };
      grouped.set(key, {
        userId: current.userId,
        monthKey: current.monthKey,
        amount: current.amount + row.unitCount,
        eventCount: current.eventCount + 1,
      });
    });

  return [...grouped.values()];
};

const monthAmountTotals = (rows: MonthAmount[]): Map<string, number> => {
  const totals = new Map<string, number>();
  rows.forEach((row) => {
    totals.set(row.monthKey, (totals.get(row.monthKey) ?? 0) + row.amount);
  });

  return totals;
};

const allocatedRoomCost = (input: {
  totalSeconds: number;
  userSeconds: number;
  includedMinutes: number;
  costPerMinute: number;
}): number => {
  if (input.totalSeconds <= 0) {
    return 0;
  }
  const billableMinutes =
    Math.max(input.totalSeconds - input.includedMinutes * SECONDS_PER_MINUTE, 0) / SECONDS_PER_MINUTE;

  return billableMinutes * input.costPerMinute * (input.userSeconds / input.totalSeconds);
};

const liveKitMetricsForUser = (input: {
  userId: string;
  slices: MonthAmount[];
  monthTotals: Map<string, number>;
  currentMonthKey: string;
  includedMinutes: number;
  costPerMinute: number;
}): LiveKitMetrics => {
  const mine = input.slices.filter((slice) => slice.userId === input.userId);
  const current = mine.filter((slice) => slice.monthKey === input.currentMonthKey);
  const share = (slice: MonthAmount) =>
    allocatedRoomCost({
      totalSeconds: input.monthTotals.get(slice.monthKey) ?? 0,
      userSeconds: slice.amount,
      includedMinutes: input.includedMinutes,
      costPerMinute: input.costPerMinute,
    });

  return {
    livekitCostMicroUsd: roundedSum(mine.map(share)),
    livekitMonthCostMicroUsd: roundedSum(current.map(share)),
    livekitParticipantSeconds: truncSum(mine.map((slice) => slice.amount)),
    livekitMonthParticipantSeconds: truncSum(current.map((slice) => slice.amount)),
    livekitEventCount: mine.reduce((total, slice) => total + slice.eventCount, 0),
    livekitMonthEventCount: current.reduce((total, slice) => total + slice.eventCount, 0),
  };
};

const fixedInfraSlices = (input: {
  meetings: AdminMeeting[];
  transcriptMeetingIds: ReadonlySet<string>;
  now: Date;
}): MonthAmount[] => {
  const grouped = new Map<string, MonthAmount>();
  input.meetings
    .filter((meeting) => input.transcriptMeetingIds.has(meeting.id))
    .forEach((meeting) => {
      const monthKey = utcMonthKey(meeting.endedAt ?? meeting.startedAt ?? meeting.createdAt);
      const key = `${meeting.createdByUserId}:${monthKey}`;
      const current = grouped.get(key) ?? { userId: meeting.createdByUserId, monthKey, amount: 0, eventCount: 0 };
      grouped.set(key, {
        userId: current.userId,
        monthKey: current.monthKey,
        amount: current.amount + elapsedSeconds({ ...meeting, now: input.now }),
        eventCount: current.eventCount,
      });
    });

  return [...grouped.values()];
};

const fixedMetricsForUser = (input: {
  userId: string;
  slices: MonthAmount[];
  monthTotals: Map<string, number>;
  currentMonthKey: string;
  fixedMonthly: number;
}): FixedMetrics => {
  const mine = input.slices.filter((slice) => slice.userId === input.userId);
  const current = mine.filter((slice) => slice.monthKey === input.currentMonthKey);
  const share = (slice: MonthAmount) => {
    const total = input.monthTotals.get(slice.monthKey) ?? 0;

    return total > 0 ? (input.fixedMonthly * slice.amount) / total : 0;
  };

  return {
    fixedCostMicroUsd: truncSum(mine.map(share)),
    fixedMonthCostMicroUsd: truncSum(current.map(share)),
  };
};

const personalBillingForUser = (rows: AdminSubscription[]): Record<string, unknown> | null => {
  const latest = latestByUpdatedAt(rows);
  if (latest === null) {
    return null;
  }

  return {
    status: latest.status,
    planInterval: latest.planInterval,
    currentPeriodEnd: latest.currentPeriodEnd?.toISOString() ?? null,
    statusChangedAt: latest.statusChangedAt.toISOString(),
  };
};

const workspaceBillingForUser = (input: {
  userId: string;
  memberships: AdminOverviewSources["membershipRows"];
  subscriptionsByWorkspace: Map<string, AdminSubscription[]>;
  workspaceNames: Map<string, string>;
}): Record<string, unknown>[] =>
  input.memberships
    .filter((membership) => membership.status === "active")
    .flatMap((membership) => {
      const latest = latestByUpdatedAt(input.subscriptionsByWorkspace.get(membership.workspaceId) ?? []);
      if (latest === null) {
        return [];
      }
      const workspaceName = input.workspaceNames.get(membership.workspaceId) ?? "";

      return [
        {
          workspaceId: membership.workspaceId,
          workspaceName,
          status: latest.status,
          planInterval: latest.planInterval,
          currentPeriodEnd: latest.currentPeriodEnd?.toISOString() ?? null,
          statusChangedAt: latest.statusChangedAt.toISOString(),
          isBillingOwner: latest.userId === input.userId,
        },
      ];
    })
    .toSorted((left, right) => left.workspaceName.localeCompare(right.workspaceName));

const buildAdminOverviewIndexes = (input: {
  sources: AdminOverviewSources;
  now: Date;
  fixedInfraMonthlyCostMicroUsd: number;
  liveKitIncludedParticipantMinutes: number;
  liveKitParticipantMinuteCostMicroUsd: number;
}) => {
  const transcriptMeetingIds = new Set(input.sources.transcriptRows.map((row) => row.meetingId));
  const liveSlices = liveKitSlices(input.sources.usageRows);
  const infraSlices = fixedInfraSlices({
    meetings: input.sources.meetingRows,
    transcriptMeetingIds,
    now: input.now,
  });
  const workspaceSubscriptions = input.sources.subscriptionRows.filter(
    (row): row is AdminSubscription & { workspaceId: string } => row.workspaceId !== null,
  );

  return {
    sources: input.sources,
    now: input.now,
    monthStart: utcMonthStart(input.now),
    currentMonthKey: utcMonthKey(input.now),
    fixedMonthly: input.fixedInfraMonthlyCostMicroUsd,
    includedMinutes: input.liveKitIncludedParticipantMinutes,
    minuteCost: input.liveKitParticipantMinuteCostMicroUsd,
    usersById: new Map(input.sources.userRows.map((row) => [row.id, row])),
    accountsByUser: groupRows({ rows: input.sources.accountRows, keyOf: (row) => row.userId }),
    meetingsByHost: groupRows({ rows: input.sources.meetingRows, keyOf: (row) => row.createdByUserId }),
    transcriptByMeeting: new Map(input.sources.transcriptRows.map((row) => [row.meetingId, row])),
    transcriptMeetingIds,
    participantsByMeeting: groupRows({ rows: input.sources.participantRows, keyOf: (row) => row.meetingId }),
    jobsByHost: groupRows({ rows: input.sources.jobRows, keyOf: (row) => row.hostUserId }),
    workflowsByHost: groupRows({ rows: input.sources.workflowRows, keyOf: (row) => row.hostUserId }),
    creditsByUser: groupRows({ rows: input.sources.creditRows, keyOf: (row) => row.userId }),
    usageByUser: groupRows({ rows: input.sources.usageRows, keyOf: (row) => row.userId }),
    personalSubscriptionsByUser: groupRows({
      rows: input.sources.subscriptionRows.filter((row) => row.workspaceId === null),
      keyOf: (row) => row.userId,
    }),
    membershipsByUser: groupRows({ rows: input.sources.membershipRows, keyOf: (row) => row.userId }),
    subscriptionsByWorkspace: groupRows({ rows: workspaceSubscriptions, keyOf: (row) => row.workspaceId }),
    workspaceNames: new Map(input.sources.workspaceRows.map((row) => [row.id, row.name])),
    liveSlices,
    liveMonthTotals: monthAmountTotals(liveSlices),
    infraSlices,
    infraMonthTotals: monthAmountTotals(infraSlices),
  };
};

type AdminOverviewIndexes = ReturnType<typeof buildAdminOverviewIndexes>;

const adminUserRecord = (input: { indexes: AdminOverviewIndexes; user: AdminUser }): Record<string, unknown> => {
  const accounts = accountMetrics(input.indexes.accountsByUser.get(input.user.id) ?? []);
  const hosted = hostedMetrics({
    meetings: input.indexes.meetingsByHost.get(input.user.id) ?? [],
    transcriptMeetingIds: input.indexes.transcriptMeetingIds,
    now: input.indexes.now,
  });
  const jobs = jobMetrics(input.indexes.jobsByHost.get(input.user.id) ?? []);
  const workflows = workflowMetrics(input.indexes.workflowsByHost.get(input.user.id) ?? []);
  const credits = creditMetrics({
    rows: input.indexes.creditsByUser.get(input.user.id) ?? [],
    monthStart: input.indexes.monthStart,
  });
  const usage = usageCostMetrics({
    rows: input.indexes.usageByUser.get(input.user.id) ?? [],
    monthStart: input.indexes.monthStart,
  });
  const llm = llmMetrics({
    rows: input.indexes.usageByUser.get(input.user.id) ?? [],
    monthStart: input.indexes.monthStart,
  });
  const liveKit = liveKitMetricsForUser({
    userId: input.user.id,
    slices: input.indexes.liveSlices,
    monthTotals: input.indexes.liveMonthTotals,
    currentMonthKey: input.indexes.currentMonthKey,
    includedMinutes: input.indexes.includedMinutes,
    costPerMinute: input.indexes.minuteCost,
  });
  const fixed = fixedMetricsForUser({
    userId: input.user.id,
    slices: input.indexes.infraSlices,
    monthTotals: input.indexes.infraMonthTotals,
    currentMonthKey: input.indexes.currentMonthKey,
    fixedMonthly: input.indexes.fixedMonthly,
  });

  return {
    id: input.user.id,
    email: input.user.email,
    display_name: input.user.displayName,
    avatar_url: input.user.avatarUrl,
    plan: input.user.plan,
    private_beta_pro_enabled_at: input.user.privateBetaProEnabledAt,
    created_at: input.user.createdAt,
    personal_billing_subscription: personalBillingForUser(
      input.indexes.personalSubscriptionsByUser.get(input.user.id) ?? [],
    ),
    workspace_billing_subscriptions: workspaceBillingForUser({
      userId: input.user.id,
      memberships: input.indexes.membershipsByUser.get(input.user.id) ?? [],
      subscriptionsByWorkspace: input.indexes.subscriptionsByWorkspace,
      workspaceNames: input.indexes.workspaceNames,
    }),
    auth_accounts: accounts.accounts,
    first_authenticated_at: accounts.firstAuthenticatedAt,
    last_authenticated_at: accounts.lastAuthenticatedAt,
    auth_count: accounts.authCount,
    hosted_meetings_count: hosted.hostedMeetingsCount,
    transcribed_meetings_count: hosted.transcribedMeetingsCount,
    active_meetings_count: hosted.activeMeetingsCount,
    transcribed_seconds: hosted.transcribedSeconds,
    last_meeting_at: hosted.lastMeetingAt,
    snapshot_job_count: jobs.snapshotJobCount,
    task_job_count: jobs.taskJobCount,
    capability_job_count: jobs.capabilityJobCount,
    failed_job_count: jobs.failedJobCount,
    workflow_run_count: workflows.workflowRunCount,
    workflow_completed_count: workflows.workflowCompletedCount,
    usage_cost_micro_usd: usage.trackedCostMicroUsd,
    usage_month_cost_micro_usd: usage.trackedMonthCostMicroUsd,
    fixed_cost_micro_usd: fixed.fixedCostMicroUsd,
    fixed_month_cost_micro_usd: fixed.fixedMonthCostMicroUsd,
    livekit_cost_micro_usd: liveKit.livekitCostMicroUsd,
    livekit_month_cost_micro_usd: liveKit.livekitMonthCostMicroUsd,
    llm_cost_micro_usd: llm.llmCostMicroUsd,
    llm_month_cost_micro_usd: llm.llmMonthCostMicroUsd,
    llm_unpriced_call_count: llm.llmUnpricedCallCount,
    llm_model_usage: llm.modelUsage,
    credits_charged: credits.creditsCharged,
    month_credits_charged: credits.monthCreditsCharged,
    credit_revenue_micro_usd: credits.creditRevenueMicroUsd,
    credit_month_revenue_micro_usd: credits.creditMonthRevenueMicroUsd,
    credit_action_count: credits.creditActionCount,
    credit_month_action_count: credits.creditMonthActionCount,
    livekit_participant_seconds: liveKit.livekitParticipantSeconds,
    livekit_month_participant_seconds: liveKit.livekitMonthParticipantSeconds,
    livekit_event_count: liveKit.livekitEventCount,
    livekit_month_event_count: liveKit.livekitMonthEventCount,
  };
};

const lastAuthenticatedMillis = (input: { indexes: AdminOverviewIndexes; user: AdminUser }): number => {
  const rows = input.indexes.accountsByUser.get(input.user.id) ?? [];
  const last = rows.reduce<Date | null>((current, row) => {
    if (current === null || row.lastAuthenticatedAt.getTime() > current.getTime()) {
      return row.lastAuthenticatedAt;
    }

    return current;
  }, null);

  return (last ?? input.user.createdAt).getTime();
};

const buildAdminUserRows = (indexes: AdminOverviewIndexes): Record<string, unknown>[] =>
  indexes.sources.userRows
    .filter((user) => user.source === "auth" && user.deletedAt === null)
    .toSorted(
      (left, right) =>
        lastAuthenticatedMillis({ indexes, user: right }) - lastAuthenticatedMillis({ indexes, user: left }),
    )
    .map((user) => adminUserRecord({ indexes, user }));

const adminWaitlistRecord = (input: {
  entry: { id: string; userId: string; requestedAt: Date; updatedAt: Date };
  user: AdminUser;
  indexes: AdminOverviewIndexes;
}): Record<string, unknown> => {
  const accounts = accountMetrics(input.indexes.accountsByUser.get(input.user.id) ?? []);
  const hosted = hostedMetrics({
    meetings: input.indexes.meetingsByHost.get(input.user.id) ?? [],
    transcriptMeetingIds: input.indexes.transcriptMeetingIds,
    now: input.indexes.now,
  });

  return {
    id: input.entry.id,
    user_id: input.user.id,
    requested_at: input.entry.requestedAt,
    updated_at: input.entry.updatedAt,
    email: input.user.email,
    display_name: input.user.displayName,
    avatar_url: input.user.avatarUrl,
    plan: input.user.plan,
    auth_accounts: accounts.accounts,
    first_authenticated_at: accounts.firstAuthenticatedAt,
    last_authenticated_at: accounts.lastAuthenticatedAt,
    auth_count: accounts.authCount,
    hosted_meetings_count: hosted.hostedMeetingsCount,
    transcribed_meetings_count: hosted.transcribedMeetingsCount,
    transcribed_seconds: hosted.transcribedSeconds,
    last_meeting_at: hosted.lastMeetingAt,
  };
};

const waitlistUser = (input: {
  indexes: AdminOverviewIndexes;
  userId: string;
  plan: "free" | null;
}): AdminUser | null => {
  const user = input.indexes.usersById.get(input.userId);
  if (!user || user.source !== "auth" || user.deletedAt !== null) {
    return null;
  }
  if (input.plan !== null && user.plan !== input.plan) {
    return null;
  }

  return user;
};

const buildWaitlistRows = (input: {
  indexes: AdminOverviewIndexes;
  entries: { id: string; userId: string; requestedAt: Date; updatedAt: Date }[];
  plan: "free" | null;
}): Record<string, unknown>[] =>
  input.entries
    .toSorted((left, right) => left.requestedAt.getTime() - right.requestedAt.getTime())
    .flatMap((entry) => {
      const user = waitlistUser({ indexes: input.indexes, userId: entry.userId, plan: input.plan });

      return user === null ? [] : [adminWaitlistRecord({ entry, user, indexes: input.indexes })];
    });

const meetingActivityMillis = (meeting: { startedAt: Date | null; createdAt: Date }): number =>
  (meeting.startedAt ?? meeting.createdAt).getTime();

const transcriptMode = (metadata: Record<string, unknown>): string | null => {
  const mode = metadata.mode;
  if (typeof mode === "string") {
    return mode;
  }
  if (typeof mode === "number" || typeof mode === "boolean") {
    return String(mode);
  }

  return null;
};

const openRoomRecord = (input: {
  meeting: AdminMeeting;
  host: AdminUser;
  participants: AdminParticipant[];
  transcript: AdminTranscript | undefined;
}): Record<string, unknown> => {
  const visible = input.participants.filter((row) => row.role === "host" || row.role === "guest");

  return {
    id: input.meeting.id,
    title: input.meeting.title,
    room_name: input.meeting.roomName,
    status: input.meeting.status,
    created_at: input.meeting.createdAt,
    started_at: input.meeting.startedAt,
    ended_at: input.meeting.endedAt,
    host_user_id: input.host.id,
    host_email: input.host.email,
    host_display_name: input.host.displayName,
    active_participant_count: visible.filter((row) => row.leftAt === null).length,
    participants: visible
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName))
      .map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
        leftAt: row.leftAt?.toISOString() ?? null,
      })),
    transcript_source: input.transcript?.source ?? null,
    transcript_mode: input.transcript === undefined ? null : transcriptMode(input.transcript.metadata),
    has_transcript: input.transcript !== undefined,
  };
};

const buildOpenRoomRows = (indexes: AdminOverviewIndexes): Record<string, unknown>[] =>
  indexes.sources.meetingRows
    .filter((meeting) => meeting.status === "active")
    .toSorted((left, right) => meetingActivityMillis(right) - meetingActivityMillis(left))
    .flatMap((meeting) => {
      const host = indexes.usersById.get(meeting.createdByUserId);
      if (!host || host.deletedAt !== null) {
        return [];
      }

      return [
        openRoomRecord({
          meeting,
          host,
          participants: indexes.participantsByMeeting.get(meeting.id) ?? [],
          transcript: indexes.transcriptByMeeting.get(meeting.id),
        }),
      ];
    });

const buildActiveJobRows = (rows: AdminJob[]): Record<string, unknown>[] =>
  rows
    .filter((row) => (row.status === "queued" || row.status === "running") && row.hostDeletedAt === null)
    .toSorted((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .map((row) => ({
      id: row.id,
      meeting_id: row.meetingId,
      meeting_title: row.meetingTitle,
      user_id: row.hostUserId,
      user_email: row.hostEmail,
      type: row.type,
      status: row.status,
      phase: row.phase,
      attempt_count: 1,
      max_attempts: 1,
      locked_by: null,
      locked_at: null,
      started_at: row.startedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      error: row.error,
    }));

const buildActiveWorkflowRows = (rows: AdminWorkflow[]): Record<string, unknown>[] =>
  rows
    .filter((row) => (row.status === "pending" || row.status === "running") && row.hostDeletedAt === null)
    .toSorted((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .map((row) => ({
      id: row.id,
      meeting_id: row.meetingId,
      meeting_title: row.meetingTitle,
      user_id: row.hostUserId,
      user_email: row.hostEmail,
      capability_key: row.capabilityKey,
      status: row.status,
      phase: row.phase,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      error: row.error,
    }));

const buildActiveTurnRows = (rows: AdminTurn[]): Record<string, unknown>[] =>
  rows
    .filter((row) => row.status === "active" && row.userDeletedAt === null)
    .toSorted((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
    .map((row) => ({
      id: row.id,
      meeting_id: row.meetingId,
      meeting_title: row.meetingTitle,
      user_id: row.ownerUserId,
      user_email: row.userEmail,
      assistant_display_name: row.assistantDisplayName,
      status: row.status,
      started_at: row.startedAt,
      updated_at: row.updatedAt,
    }));

const adminGlobalRecord = (input: { sources: AdminOverviewSources; monthStart: Date }): Record<string, unknown> => {
  const authUsers = input.sources.userRows.filter((user) => user.source === "auth" && user.deletedAt === null);
  const activeHostIds = new Set(
    input.sources.meetingRows
      .filter((meeting) => isOnOrAfter({ instant: meeting.createdAt, cutoff: input.monthStart }))
      .map((meeting) => meeting.createdByUserId),
  );
  const tracked = input.sources.usageRows.filter((row) => row.category !== "realtime_room");
  const monthTracked = tracked.filter((row) => isOnOrAfter({ instant: row.occurredAt, cutoff: input.monthStart }));

  return {
    authenticated_user_count: authUsers.length,
    active_user_count: authUsers.filter((user) => activeHostIds.has(user.id)).length,
    total_meeting_count: input.sources.meetingRows.length,
    transcribed_meeting_count: input.sources.transcriptRows.length,
    open_room_count: input.sources.meetingRows.filter((meeting) => meeting.status === "active").length,
    active_job_count: input.sources.jobRows.filter((job) => job.status === "queued" || job.status === "running").length,
    tracked_cost_micro_usd: truncSum(tracked.map((row) => row.costMicroUsd)),
    tracked_month_cost_micro_usd: truncSum(monthTracked.map((row) => row.costMicroUsd)),
  };
};

const adminCategoryRows = (input: { rows: AdminUsage[]; monthStart: Date }): Record<string, unknown>[] => {
  const grouped = groupRows({
    rows: input.rows.filter((row) => row.category !== "realtime_room"),
    keyOf: (row) => row.category,
  });

  return [...grouped.entries()]
    .toSorted((left, right) => left[0].localeCompare(right[0]))
    .map(([category, events]) => ({
      category,
      cost_micro_usd: truncSum(events.map((row) => row.costMicroUsd)),
      month_cost_micro_usd: truncSum(
        events
          .filter((row) => isOnOrAfter({ instant: row.occurredAt, cutoff: input.monthStart }))
          .map((row) => row.costMicroUsd),
      ),
      event_count: events.length,
      unconfigured_event_count: events.filter((row) => metadataRateMissing(row.metadata)).length,
    }));
};

const buildAdminOverviewBundle = (input: {
  sources: AdminOverviewSources;
  now: Date;
  fixedInfraMonthlyCostMicroUsd: number;
  liveKitIncludedParticipantMinutes: number;
  liveKitParticipantMinuteCostMicroUsd: number;
}) => {
  const indexes = buildAdminOverviewIndexes(input);

  return {
    userRows: buildAdminUserRows(indexes),
    waitlistRows: buildWaitlistRows({ indexes, entries: input.sources.privateBetaRows, plan: "free" }),
    openRoomRows: buildOpenRoomRows(indexes),
    activeJobRows: buildActiveJobRows(input.sources.jobRows),
    activeWorkflowRows: buildActiveWorkflowRows(input.sources.workflowRows),
    activeTurnRows: buildActiveTurnRows(input.sources.turnRows),
    global: adminGlobalRecord({ sources: input.sources, monthStart: indexes.monthStart }),
    categoryRows: adminCategoryRows({ rows: input.sources.usageRows, monthStart: indexes.monthStart }),
  };
};

const isCurrentAdminBillingSubscription = (subscription: Record<string, unknown> | null): boolean => {
  if (!subscription || !["active", "trialing", "past_due"].includes(String(subscription.status))) {
    return false;
  }
  if (subscription.status === "past_due") {
    const changedAt = typeof subscription.statusChangedAt === "string" ? Date.parse(subscription.statusChangedAt) : 0;
    if (changedAt <= Date.now() - BILLING_PAST_DUE_GRACE_DAYS * MILLISECONDS_PER_DAY) {
      return false;
    }
  }
  const periodEnd =
    typeof subscription.currentPeriodEnd === "string"
      ? Date.parse(subscription.currentPeriodEnd)
      : Number.POSITIVE_INFINITY;

  return !Number.isFinite(periodEnd) || periodEnd > Date.now();
};

const mapAdminOverviewBilling = (row: Record<string, unknown>) => {
  const isManualEntitlement = Boolean(row.private_beta_pro_enabled_at) && row.plan !== "free";
  const personalSubscription = isUnknownRecord(row.personal_billing_subscription)
    ? row.personal_billing_subscription
    : null;
  const workspaceSubscriptions = Array.isArray(row.workspace_billing_subscriptions)
    ? row.workspace_billing_subscriptions.filter(isUnknownRecord)
    : [];
  const hasPersonalStripe = isCurrentAdminBillingSubscription(personalSubscription);
  const hasWorkspaceStripe = workspaceSubscriptions.some(isCurrentAdminBillingSubscription);
  const hasStripe = hasPersonalStripe || hasWorkspaceStripe;

  return {
    source:
      isManualEntitlement && hasStripe
        ? "manual_and_stripe"
        : isManualEntitlement
          ? "manual"
          : hasPersonalStripe
            ? "stripe_personal"
            : hasWorkspaceStripe
              ? "stripe_workspace"
              : "none",
    /** @external existing wire contract */ manualEntitlement: isManualEntitlement,
    personalSubscription,
    workspaceSubscriptions,
  };
};

const mapAdminOverviewUserRow = (input: {
  row: Record<string, unknown>;
  acquisitions: Awaited<ReturnType<typeof getAdminAcquisition>>;
}) => {
  const { row, acquisitions } = input;
  const usageCost = toNumber(row.usage_cost_micro_usd);
  const monthUsageCost = toNumber(row.usage_month_cost_micro_usd);
  const fixedCost = toNumber(row.fixed_cost_micro_usd);
  const fixedMonthCost = toNumber(row.fixed_month_cost_micro_usd);
  const liveKitCost = toNumber(row.livekit_cost_micro_usd);
  const liveKitMonthCost = toNumber(row.livekit_month_cost_micro_usd);
  const llmCost = toNumber(row.llm_cost_micro_usd);
  const llmMonthCost = toNumber(row.llm_month_cost_micro_usd);

  return {
    id: readString(row.id),
    acquisition: acquisitions.get(readString(row.id)) ?? null,
    email: readString(row.email),
    displayName: readString(row.display_name),
    avatarUrl: readNullableString(row.avatar_url) ?? null,
    plan: readUserPlan(row.plan) ?? "free",
    billing: mapAdminOverviewBilling(row),
    createdAt: toOptionalIso(row.created_at) ?? new Date(0).toISOString(),
    authAccounts: Array.isArray(row.auth_accounts) ? row.auth_accounts : [],
    firstAuthenticatedAt: toOptionalIso(row.first_authenticated_at),
    lastAuthenticatedAt: toOptionalIso(row.last_authenticated_at),
    authCount: toNumber(row.auth_count),
    hostedMeetingsCount: toNumber(row.hosted_meetings_count),
    transcribedMeetingsCount: toNumber(row.transcribed_meetings_count),
    activeMeetingsCount: toNumber(row.active_meetings_count),
    transcribedSeconds: toNumber(row.transcribed_seconds),
    lastMeetingAt: toOptionalIso(row.last_meeting_at),
    snapshotJobCount: toNumber(row.snapshot_job_count),
    taskJobCount: toNumber(row.task_job_count),
    capabilityJobCount: toNumber(row.capability_job_count),
    failedJobCount: toNumber(row.failed_job_count),
    workflowRunCount: toNumber(row.workflow_run_count),
    workflowCompletedCount: toNumber(row.workflow_completed_count),
    trackedCostMicroUsd: usageCost + fixedCost + liveKitCost,
    trackedMonthCostMicroUsd: monthUsageCost + fixedMonthCost + liveKitMonthCost,
    creditUsage: {
      creditsCharged: toNumber(row.credits_charged),
      monthCreditsCharged: toNumber(row.month_credits_charged),
      revenueMicroUsd: toNumber(row.credit_revenue_micro_usd),
      monthRevenueMicroUsd: toNumber(row.credit_month_revenue_micro_usd),
      actionCount: toNumber(row.credit_action_count),
      monthActionCount: toNumber(row.credit_month_action_count),
    },
    costBreakdown: {
      usageMicroUsd: usageCost,
      fixedInfraMicroUsd: fixedCost,
      usageMonthMicroUsd: monthUsageCost,
      fixedInfraMonthMicroUsd: fixedMonthCost,
      llmMicroUsd: llmCost,
      llmMonthMicroUsd: llmMonthCost,
      llmUnpricedCallCount: toNumber(row.llm_unpriced_call_count),
      liveKitMicroUsd: liveKitCost,
      liveKitMonthMicroUsd: liveKitMonthCost,
      liveKitParticipantSeconds: toNumber(row.livekit_participant_seconds),
      liveKitMonthParticipantSeconds: toNumber(row.livekit_month_participant_seconds),
      liveKitEventCount: toNumber(row.livekit_event_count),
      liveKitMonthEventCount: toNumber(row.livekit_month_event_count),
    },
    llmUsageByModel: Array.isArray(row.llm_model_usage) ? row.llm_model_usage : [],
  };
};

const mapAdminOverviewWaitlistRows = (rows: Record<string, unknown>[]) =>
  rows.map((row) => ({
    id: readString(row.id),
    requestedAt: toOptionalIso(row.requested_at) ?? new Date(0).toISOString(),
    updatedAt: toOptionalIso(row.updated_at) ?? new Date(0).toISOString(),
    user: {
      id: readString(row.user_id),
      email: readString(row.email),
      displayName: readString(row.display_name),
      avatarUrl: readNullableString(row.avatar_url) ?? null,
      plan: readUserPlan(row.plan) ?? "free",
    },
    authAccounts: Array.isArray(row.auth_accounts) ? row.auth_accounts : [],
    firstAuthenticatedAt: toOptionalIso(row.first_authenticated_at),
    lastAuthenticatedAt: toOptionalIso(row.last_authenticated_at),
    authCount: toNumber(row.auth_count),
    hostedMeetingsCount: toNumber(row.hosted_meetings_count),
    transcribedMeetingsCount: toNumber(row.transcribed_meetings_count),
    transcribedSeconds: toNumber(row.transcribed_seconds),
    lastMeetingAt: toOptionalIso(row.last_meeting_at),
  }));

const mapAdminOverviewOpenRoomRows = (rows: Record<string, unknown>[]) =>
  rows.map((row) => ({
    id: readString(row.id),
    title: readString(row.title),
    roomName: readString(row.room_name),
    status: readString(row.status),
    createdAt: toOptionalIso(row.created_at) ?? new Date(0).toISOString(),
    startedAt: toOptionalIso(row.started_at),
    endedAt: toOptionalIso(row.ended_at),
    host: {
      userId: readString(row.host_user_id),
      email: readString(row.host_email),
      displayName: readString(row.host_display_name),
    },
    activeParticipantCount: toNumber(row.active_participant_count),
    participants: Array.isArray(row.participants) ? row.participants : [],
    transcript: {
      hasTranscript: Boolean(row.has_transcript),
      source: readNullableString(row.transcript_source) ?? null,
      mode: readNullableString(row.transcript_mode) ?? null,
    },
    livekitStatus: "not_checked" as const,
  }));

const mapAdminOverviewActiveProcesses = (input: {
  activeJobRows: Record<string, unknown>[];
  activeWorkflowRows: Record<string, unknown>[];
  activeTurnRows: Record<string, unknown>[];
}) => [
  ...input.activeJobRows.map((row) => ({
    id: readString(row.id),
    kind: "ai_workflow_job" as const,
    meetingId: readString(row.meeting_id),
    meetingTitle: readString(row.meeting_title),
    userId: readString(row.user_id),
    userEmail: readString(row.user_email),
    label: readString(row.type),
    status: readString(row.status),
    phase: readString(row.phase),
    startedAt: toOptionalIso(row.started_at),
    createdAt: toOptionalIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toOptionalIso(row.updated_at) ?? new Date(0).toISOString(),
    error: readNullableString(row.error) ?? null,
    metadata: {
      attemptCount: toNumber(row.attempt_count),
      maxAttempts: toNumber(row.max_attempts),
      lockedBy: readNullableString(row.locked_by) ?? null,
      lockedAt: toOptionalIso(row.locked_at),
    },
  })),
  ...input.activeWorkflowRows.map((row) => ({
    id: readString(row.id),
    kind: "capability_workflow" as const,
    meetingId: readString(row.meeting_id),
    meetingTitle: readString(row.meeting_title),
    userId: readString(row.user_id),
    userEmail: readString(row.user_email),
    label: readString(row.capability_key),
    status: readString(row.status),
    phase: readString(row.phase),
    startedAt: toOptionalIso(row.created_at),
    createdAt: toOptionalIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toOptionalIso(row.updated_at) ?? new Date(0).toISOString(),
    error: readNullableString(row.error) ?? null,
    metadata: {},
  })),
  ...input.activeTurnRows.map((row) => ({
    id: readString(row.id),
    kind: "active_assistant_turn" as const,
    meetingId: readString(row.meeting_id),
    meetingTitle: readString(row.meeting_title),
    userId: readString(row.user_id),
    userEmail: readString(row.user_email),
    label: readString(row.assistant_display_name),
    status: readString(row.status),
    phase: "active",
    startedAt: toOptionalIso(row.started_at),
    createdAt: toOptionalIso(row.started_at) ?? new Date(0).toISOString(),
    updatedAt: toOptionalIso(row.updated_at) ?? new Date(0).toISOString(),
    error: null,
    metadata: {},
  })),
];

const summarizeAdminOverviewUsageTotals = (input: {
  usersData: ReturnType<typeof mapAdminOverviewUserRow>[];
  liveKitIncludedParticipantMinutes: number;
}) => {
  const { usersData, liveKitIncludedParticipantMinutes } = input;
  const fixedInfraTotalMicroUsd = usersData.reduce((total, user) => total + user.costBreakdown.fixedInfraMicroUsd, 0);
  const fixedInfraMonthMicroUsd = usersData.reduce(
    (total, user) => total + user.costBreakdown.fixedInfraMonthMicroUsd,
    0,
  );
  const liveKitTotalMicroUsd = usersData.reduce((total, user) => total + user.costBreakdown.liveKitMicroUsd, 0);
  const liveKitMonthMicroUsd = usersData.reduce((total, user) => total + user.costBreakdown.liveKitMonthMicroUsd, 0);
  const liveKitParticipantSeconds = usersData.reduce(
    (total, user) => total + user.costBreakdown.liveKitParticipantSeconds,
    0,
  );
  const liveKitMonthParticipantSeconds = usersData.reduce(
    (total, user) => total + user.costBreakdown.liveKitMonthParticipantSeconds,
    0,
  );
  const liveKitEventCount = usersData.reduce((total, user) => total + user.costBreakdown.liveKitEventCount, 0);
  const liveKitBillableMonthParticipantMinutes = Math.max(
    0,
    liveKitMonthParticipantSeconds / SECONDS_PER_MINUTE - liveKitIncludedParticipantMinutes,
  );

  return {
    fixedInfraTotalMicroUsd,
    fixedInfraMonthMicroUsd,
    liveKitTotalMicroUsd,
    liveKitMonthMicroUsd,
    liveKitParticipantSeconds,
    liveKitMonthParticipantSeconds,
    liveKitEventCount,
    liveKitBillableMonthParticipantMinutes,
  };
};

const buildAdminOverviewGlobalSummary = (input: {
  global: Record<string, unknown>;
  usageTotals: ReturnType<typeof summarizeAdminOverviewUsageTotals>;
}) => ({
  authenticatedUserCount: toNumber(input.global.authenticated_user_count),
  activeUserCount: toNumber(input.global.active_user_count),
  totalMeetingCount: toNumber(input.global.total_meeting_count),
  transcribedMeetingCount: toNumber(input.global.transcribed_meeting_count),
  openRoomCount: toNumber(input.global.open_room_count),
  activeJobCount: toNumber(input.global.active_job_count),
  trackedCostMicroUsd:
    toNumber(input.global.tracked_cost_micro_usd) +
    input.usageTotals.fixedInfraTotalMicroUsd +
    input.usageTotals.liveKitTotalMicroUsd,
  trackedMonthCostMicroUsd:
    toNumber(input.global.tracked_month_cost_micro_usd) +
    input.usageTotals.fixedInfraMonthMicroUsd +
    input.usageTotals.liveKitMonthMicroUsd,
});

const buildAdminOverviewCostCategories = (input: {
  categoryRows: Record<string, unknown>[];
  usageTotals: ReturnType<typeof summarizeAdminOverviewUsageTotals>;
  usersData: ReturnType<typeof mapAdminOverviewUserRow>[];
  fixedInfraMonthlyCostMicroUsd: number;
  liveKitIncludedParticipantMinutes: number;
  liveKitParticipantMinuteCostMicroUsd: number;
}) => [
  ...input.categoryRows.map((row) => ({
    category: readString(row.category),
    costMicroUsd: toNumber(row.cost_micro_usd),
    monthCostMicroUsd: toNumber(row.month_cost_micro_usd),
    eventCount: toNumber(row.event_count),
    unconfiguredEventCount: toNumber(row.unconfigured_event_count),
    metadata: {},
  })),
  {
    category: "realtime_room",
    costMicroUsd: input.usageTotals.liveKitTotalMicroUsd,
    monthCostMicroUsd: input.usageTotals.liveKitMonthMicroUsd,
    eventCount: input.usageTotals.liveKitEventCount,
    unconfiguredEventCount: input.liveKitParticipantMinuteCostMicroUsd > 0 ? 0 : input.usageTotals.liveKitEventCount,
    metadata: {
      billableMonthParticipantMinutes: input.usageTotals.liveKitBillableMonthParticipantMinutes,
      /** @external existing wire contract */ freeQuotaCovered:
        input.usageTotals.liveKitBillableMonthParticipantMinutes === 0,
      includedParticipantMinutes: input.liveKitIncludedParticipantMinutes,
      monthParticipantMinutes: input.usageTotals.liveKitMonthParticipantSeconds / SECONDS_PER_MINUTE,
      participantMinuteCostMicroUsd: input.liveKitParticipantMinuteCostMicroUsd,
      participantMinutes: input.usageTotals.liveKitParticipantSeconds / SECONDS_PER_MINUTE,
    },
  },
  {
    category: "fixed_infra",
    costMicroUsd: input.usageTotals.fixedInfraTotalMicroUsd,
    monthCostMicroUsd: input.usageTotals.fixedInfraMonthMicroUsd,
    eventCount: input.usageTotals.fixedInfraTotalMicroUsd > 0 ? input.usersData.length : 0,
    unconfiguredEventCount: input.fixedInfraMonthlyCostMicroUsd > 0 ? 0 : input.usersData.length,
    metadata: {},
  },
];

type GetAdminOverviewDataResult = Promise<{
  generatedAt: string;
  users: ReturnType<typeof mapAdminOverviewUserRow>[];
  waitlistEntries: ReturnType<typeof mapAdminOverviewWaitlistRows>;
  global: Record<string, unknown>;
  costCategories: ReturnType<typeof buildAdminOverviewCostCategories>;
  openRooms: unknown[];
  activeProcesses: unknown[];
}>;

export async function getAdminOverviewData(input: {
  fixedInfraMonthlyCostMicroUsd: number;
  liveKitIncludedParticipantMinutes: number;
  liveKitParticipantMinuteCostMicroUsd: number;
}): GetAdminOverviewDataResult {
  const fixedInfraMonthlyCostMicroUsd = Math.max(0, Math.round(input.fixedInfraMonthlyCostMicroUsd));
  const liveKitIncludedParticipantMinutes = Math.max(0, Math.round(input.liveKitIncludedParticipantMinutes));
  const liveKitParticipantMinuteCostMicroUsd = Math.max(0, Math.round(input.liveKitParticipantMinuteCostMicroUsd));
  const bundle = buildAdminOverviewBundle({
    sources: await loadAdminOverviewSources(),
    now: new Date(),
    fixedInfraMonthlyCostMicroUsd,
    liveKitIncludedParticipantMinutes,
    liveKitParticipantMinuteCostMicroUsd,
  });
  const acquisitions = await getAdminAcquisition(bundle.userRows.map((row) => readString(row.id)));
  const usersData = bundle.userRows.map((row) => mapAdminOverviewUserRow({ row, acquisitions }));
  const usageTotals = summarizeAdminOverviewUsageTotals({ usersData, liveKitIncludedParticipantMinutes });

  return {
    generatedAt: new Date().toISOString(),
    users: usersData,
    waitlistEntries: mapAdminOverviewWaitlistRows(bundle.waitlistRows),
    global: buildAdminOverviewGlobalSummary({ global: bundle.global, usageTotals }),
    costCategories: buildAdminOverviewCostCategories({
      categoryRows: bundle.categoryRows,
      usageTotals,
      usersData,
      fixedInfraMonthlyCostMicroUsd,
      liveKitIncludedParticipantMinutes,
      liveKitParticipantMinuteCostMicroUsd,
    }),
    openRooms: mapAdminOverviewOpenRoomRows(bundle.openRoomRows),
    activeProcesses: mapAdminOverviewActiveProcesses({
      activeJobRows: bundle.activeJobRows,
      activeWorkflowRows: bundle.activeWorkflowRows,
      activeTurnRows: bundle.activeTurnRows,
    }),
  };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";

  return trimmed !== "" ? trimmed : null;
}
