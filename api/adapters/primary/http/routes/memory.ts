import { MemoryBusyError, MemoryNotFoundError } from "@readymeet/db/domain/persistence-errors";
import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  memoryActionSchema,
  memoryCategorySchema,
  memoryPersonMatchesFilters,
  memoryPreferencesSchema,
  normalizeMemoryCategory,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  decodeMemoryPosition,
  decodeMemorySyncCursor,
  encodeMemoryPosition,
  encodeMemorySyncCursor,
  memorySyncScope,
} from "../../../../application/memory-sync-cursor";
import { memoryReadContext } from "../../../../application/relationship-memory";
import { apiEnv } from "../../../../composition/env";
import { repositories } from "../../../../ports/repository-runtime";
import { ashbyProfileLinksForPerson } from "../../../secondary/ashby/ashby-profile-links";
import { getWorkspaceMembershipContext, requireActiveWorkspaceMember } from "../support/workspace-access";

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_GONE = 410;
const MESSAGE_MEMORY_IS_NOT_AVAILABLE_YET = "Memory is not available yet.";
const MESSAGE_INVALID_MEMORY_PREFERENCES = "Invalid memory preferences";
const MESSAGE_MEMORY_GENERATION_CANNOT_BE_RETRIED = "Memory generation cannot be retried.";
const MESSAGE_INVALID_MEMORY_FILTER = "Invalid memory filter";
const MESSAGE_CHOOSE_ONE_PAGINATION_DIRECTION = "Choose one pagination direction";
const MESSAGE_INVALID_MEMORY_CURSOR = "Invalid memory cursor";
const MESSAGE_INVALID_MEMORY_SYNC_REQUEST = "Invalid memory sync request";
const MESSAGE_INVALID_MEMORY_SYNC_CURSOR = "Invalid memory sync cursor";
const MESSAGE_INVALID_PEOPLE_CURSOR_OR_FILTERS = "Invalid people cursor or filters";
const MESSAGE_INVALID_PEOPLE_CURSOR = "Invalid people cursor";
const MESSAGE_PERSON_NOT_FOUND = "Person not found";
const MESSAGE_INVALID_MEMORY_ACTION = "Invalid memory action";
const MESSAGE_MEMORY_NOT_FOUND = "Memory not found";
const MEMORY_BUSY_CODE = "memory_busy";
const MEMORY_BUSY_RETRY_AFTER_SECONDS = 5;
const MESSAGE_AUTHENTICATED_USER_REQUIRED = "Authenticated user is required";

const MEMORY_LIST_PAGE_SIZE = 50;
const MEMORY_LIST_FETCH_SIZE = MEMORY_LIST_PAGE_SIZE + 1;
const MEMORY_SYNC_BATCH_SIZE = 500;
const MEMORY_PEOPLE_SCAN_BATCH_SIZE = 250;
const MEMORY_PEOPLE_PAGE_SIZE = 50;
const MEMORY_PEOPLE_SCAN_MAX_BATCHES = 4096;
const MEMORY_QUERY_MAX_LENGTH = 200;
const MEMORY_SYNC_CURSOR_MAX_LENGTH = 800_000;
const MEMORY_POSITION_MAX_LENGTH = 1000;
const MEMORY_RECENT_LIMIT = 50;

const memoryMeetingRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  occurredAt: z
    .union([z.date(), z.string()])
    .transform((value) => (value instanceof Date ? value.toISOString() : value)),
});

const scopeFor = (request: FastifyRequest) => {
  const user = request.user;
  if (user === undefined) {
    throw new Error(MESSAGE_AUTHENTICATED_USER_REQUIRED);
  }

  return {
    userId: user.id,
    workspaceId: getWorkspaceMembershipContext(request).workspaceId,
  };
};
type MemoryScope = ReturnType<typeof scopeFor>;
type MemoryRouteAccess = { preHandler: typeof requireActiveWorkspaceMember };

const listQuery = z.object({
  personId: z.string().uuid().optional(),
  categoryOperator: z.enum(["is", "is_not"]).optional(),
  personOperator: z.enum(["is", "is_not"]).optional(),
  dateOperator: z.enum(["is", "is_not"]).optional(),
  category: z.preprocess(
    (value) => (typeof value === "string" ? normalizeMemoryCategory(value) : value),
    memoryCategorySchema.optional(),
  ),
  q: z.string().max(MEMORY_QUERY_MAX_LENGTH).optional(),
  after: z.string().startsWith("m1.").max(MEMORY_POSITION_MAX_LENGTH).optional(),
  before: z.union([z.string().uuid(), z.string().startsWith("m1.").max(MEMORY_POSITION_MAX_LENGTH)]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
const memoryListFiltersQuery = listQuery.omit({
  /** @external zod omit field key */
  before: true,
  /** @external zod omit field key */
  after: true,
});
const memoryPeopleFiltersQuery = listQuery.omit({
  /** @external zod omit field key */
  before: true,
  /** @external zod omit field key */
  after: true,
  /** @external zod omit field key */
  personId: true,
});
type MemoryPeopleFilters = z.infer<typeof memoryPeopleFiltersQuery>;

const peopleCursorPositionSchema = z.object({
  lastContact: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  id: z.string().uuid(),
});
type PeopleCursorPosition = z.infer<typeof peopleCursorPositionSchema>;

function encodePeopleCursor(person: PeopleCursorPosition) {
  return Buffer.from(JSON.stringify({ lastContact: person.lastContact, id: person.id })).toString("base64url");
}

function tryDecodeMemoryListPosition(input: { after?: string; before?: string }) {
  try {
    return { isOk: true as const, position: decodeMemoryPosition(input.after ?? input.before) };
  } catch (error) {
    return {
      isOk: false as const,
      reason: error instanceof Error ? error.message : MESSAGE_INVALID_MEMORY_CURSOR,
    };
  }
}

function memoryListUsesAfterCursor(after: string | undefined) {
  return after !== undefined && after.length > 0;
}

function memoryListNextCursor(input: {
  orderedMemories: Awaited<ReturnType<RepositoryPort["listRelationshipMemories"]>>;
  after: string | undefined;
  rowCount: number;
}) {
  const lastMemory = input.orderedMemories.at(-1);
  const isPagingForward = memoryListUsesAfterCursor(input.after) || input.rowCount > MEMORY_LIST_PAGE_SIZE;

  return input.orderedMemories.length !== 0 && isPagingForward && lastMemory !== undefined
    ? encodeMemoryPosition(lastMemory)
    : null;
}

function memoryListPreviousCursor(input: {
  orderedMemories: Awaited<ReturnType<RepositoryPort["listRelationshipMemories"]>>;
  before: string | undefined;
  after: string | undefined;
  rowCount: number;
}) {
  const firstMemory = input.orderedMemories[0];
  const isPagingBackward =
    (input.before !== undefined && input.before.length > 0) ||
    (memoryListUsesAfterCursor(input.after) && input.rowCount > MEMORY_LIST_PAGE_SIZE);

  return input.orderedMemories.length !== 0 && isPagingBackward && firstMemory !== undefined
    ? encodeMemoryPosition(firstMemory)
    : null;
}

function tryDecodePeopleCursorToken(cursorToken: string | undefined) {
  if (cursorToken === undefined || cursorToken.length === 0) {
    return { isOk: true as const, position: undefined };
  }
  try {
    return {
      isOk: true as const,
      position: peopleCursorPositionSchema.parse(JSON.parse(Buffer.from(cursorToken, "base64url").toString())),
    };
  } catch (error) {
    return {
      isOk: false as const,
      reason: error instanceof Error ? error.message : MESSAGE_INVALID_PEOPLE_CURSOR,
    };
  }
}

type MemoryPeopleScanState = {
  position: PeopleCursorPosition | undefined;
  matches: Awaited<ReturnType<RepositoryPort["listMemoryPeople"]>>;
  boundary: PeopleCursorPosition | undefined;
  hasCandidates: boolean;
};

async function scanFilteredMemoryPeople(input: {
  scope: MemoryScope;
  sourceIds: string[];
  position: PeopleCursorPosition | undefined;
  filters: MemoryPeopleFilters;
  after: string | undefined;
}): Promise<MemoryPeopleScanState> {
  const initialState: MemoryPeopleScanState = {
    position: input.position,
    matches: [],
    boundary: undefined,
    hasCandidates: true,
  };
  const isNewerPage = memoryListUsesAfterCursor(input.after);

  return Array.from({ length: MEMORY_PEOPLE_SCAN_MAX_BATCHES }, () => undefined).reduce(
    async (previousPromise, _step) => {
      const scan = await previousPromise;
      if (scan.matches.length > MEMORY_PEOPLE_PAGE_SIZE || !scan.hasCandidates) {
        return scan;
      }
      const candidates = await repositories().listMemoryPeople({
        scope: input.scope,
        sourceIds: input.sourceIds,
        page: {
          before: scan.position,
          newer: isNewerPage,
          limit: MEMORY_PEOPLE_SCAN_BATCH_SIZE,
          filters: input.filters,
        },
      });
      const boundary = candidates.at(-1);

      return {
        position: boundary,
        matches: [
          ...scan.matches,
          ...candidates.filter((person) => memoryPersonMatchesFilters({ person, filters: input.filters })),
        ],
        boundary,
        hasCandidates: candidates.length === MEMORY_PEOPLE_SCAN_BATCH_SIZE,
      };
    },
    Promise.resolve(initialState),
  );
}

function pagedPeopleContinuation(input: {
  scan: MemoryPeopleScanState;
  people: Awaited<ReturnType<RepositoryPort["listMemoryPeople"]>>;
}) {
  const lastBeforeOrder = input.people.at(-1);

  if (input.scan.matches.length > MEMORY_PEOPLE_PAGE_SIZE && lastBeforeOrder !== undefined) {
    return encodePeopleCursor(lastBeforeOrder);
  }
  if (input.scan.hasCandidates && input.scan.boundary !== undefined) {
    return encodePeopleCursor(input.scan.boundary);
  }

  return null;
}

function pagedPeopleNextCursor(input: {
  after: string | undefined;
  before: string | undefined;
  orderedPeople: Awaited<ReturnType<RepositoryPort["listMemoryPeople"]>>;
  continuation: string | null;
}) {
  if (!memoryListUsesAfterCursor(input.after)) {
    return input.continuation;
  }
  const lastPerson = input.orderedPeople.at(-1);

  return input.orderedPeople.length !== 0 && lastPerson !== undefined
    ? encodePeopleCursor(lastPerson)
    : (input.before ?? null);
}

function pagedPeoplePreviousCursor(input: {
  after: string | undefined;
  before: string | undefined;
  orderedPeople: Awaited<ReturnType<RepositoryPort["listMemoryPeople"]>>;
  continuation: string | null;
}) {
  if (memoryListUsesAfterCursor(input.after)) {
    return input.continuation;
  }
  const firstPerson = input.orderedPeople[0];
  const isPagingBackward =
    input.before !== undefined &&
    input.before.length > 0 &&
    input.orderedPeople.length !== 0 &&
    firstPerson !== undefined;

  return isPagingBackward ? encodePeopleCursor(firstPerson) : null;
}

function registerMemoryStatusRoute(input: { app: FastifyInstance; base: string; access: MemoryRouteAccess }): void {
  input.app.get(`${input.base}/status`, input.access, async (request) => {
    if (!apiEnv.MEMORY_ENABLED) {
      return {
        /** @external memory status available wire field */
        available: false,
        preferences: memoryPreferencesSchema.parse({}),
        progress: { queued: 0, running: 0, completed: 0, failed: 0 },
      };
    }
    const scope = scopeFor(request);
    const context = await memoryReadContext(scope);

    return {
      /** @external memory status available wire field */
      available: true,
      preferences: context.preferences,
      progress: await repositories().memoryJobProgress(scope),
      processingMeeting: await repositories().latestProcessingMemoryMeeting({ scope, sourceIds: context.sourceIds }),
    };
  });
}

function registerMemoryDisabledHook(input: { app: FastifyInstance }): void {
  input.app.addHook("preHandler", async (request, reply) => {
    const requestPath = request.url.split("?")[0] ?? "";
    if (!apiEnv.MEMORY_ENABLED && request.url.includes("/memory") && !requestPath.endsWith("/status")) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMORY_IS_NOT_AVAILABLE_YET });
    }
  });
}

function registerMemoryPreferencesRoute(input: {
  app: FastifyInstance;
  base: string;
  access: MemoryRouteAccess;
}): void {
  input.app.put(`${input.base}/preferences`, input.access, async (request, reply) => {
    const parsed = memoryPreferencesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_MEMORY_PREFERENCES });
    }
    const scope = scopeFor(request);
    const preferences = await repositories().saveMemoryPreferences({ scope, preferences: parsed.data });

    return { preferences };
  });
}

function registerMemoryRetryRoute(input: { app: FastifyInstance; base: string; access: MemoryRouteAccess }): void {
  input.app.post(`${input.base}/retry`, input.access, async (_request, reply) =>
    reply.code(HTTP_GONE).send({ message: MESSAGE_MEMORY_GENERATION_CANNOT_BE_RETRIED }),
  );
}

function registerMemoryListRoute(input: { app: FastifyInstance; base: string; access: MemoryRouteAccess }): void {
  input.app.get(input.base, input.access, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_MEMORY_FILTER });
    }
    const { before, after, ...filters } = parsed.data;
    const hasBeforeCursor = before !== undefined && before.length > 0;
    const hasAfterCursor = after !== undefined && after.length > 0;
    if (hasBeforeCursor && hasAfterCursor) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CHOOSE_ONE_PAGINATION_DIRECTION });
    }
    const decodedBefore = tryDecodeMemoryListPosition({ after, before });
    if (!decodedBefore.isOk) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_MEMORY_CURSOR });
    }
    const scope = scopeFor(request);
    // Both snapshots precede the content read; concurrent changes can be replayed.
    const [context, version] = await Promise.all([memoryReadContext(scope), repositories().memorySyncVersion(scope)]);
    const beforePosition = decodedBefore.position;
    const rows = await repositories().listRelationshipMemories({
      sourceIds: context.sourceIds,
      filters: {
        ...filters,
        before: beforePosition ? undefined : before,
        beforePosition,
        newer: memoryListUsesAfterCursor(after),
        limit: MEMORY_LIST_FETCH_SIZE,
      },
      scope,
    });
    const memories = rows.slice(0, MEMORY_LIST_PAGE_SIZE);
    const orderedMemories = memoryListUsesAfterCursor(after) ? [...memories].reverse() : memories;

    return {
      memories: orderedMemories,
      nextCursor: memoryListNextCursor({ orderedMemories, after, rowCount: rows.length }),
      previousCursor: memoryListPreviousCursor({ orderedMemories, before, after, rowCount: rows.length }),
      syncCursor: encodeMemorySyncCursor({
        version,
        sources: context.sourceIds,
        scope: memorySyncScope({ userId: scope.userId, workspaceId: scope.workspaceId, filters }),
      }),
    };
  });
}

function registerMemorySyncRoute(input: { app: FastifyInstance; base: string; access: MemoryRouteAccess }): void {
  input.app.post(`${input.base}/sync`, input.access, async (request, reply) => {
    const parsed = z
      .object({
        filters: memoryListFiltersQuery,
        cursor: z.string().max(MEMORY_SYNC_CURSOR_MAX_LENGTH),
        through: z.string().max(MEMORY_POSITION_MAX_LENGTH).nullable(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_MEMORY_SYNC_REQUEST });
    }
    const decodedSync = (() => {
      try {
        const cursor = decodeMemorySyncCursor(parsed.data.cursor);
        const throughPosition = decodeMemoryPosition(parsed.data.through ?? undefined);
        if (parsed.data.through !== null && throughPosition === undefined) {
          throw new Error(MESSAGE_INVALID_MEMORY_SYNC_CURSOR);
        }

        return { isOk: true as const, cursor, throughPosition };
      } catch (error) {
        return {
          isOk: false as const,
          reason: error instanceof Error ? error.message : MESSAGE_INVALID_MEMORY_SYNC_CURSOR,
        };
      }
    })();
    if (!decodedSync.isOk) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_MEMORY_SYNC_CURSOR });
    }
    const { cursor, throughPosition } = decodedSync;
    const scope = scopeFor(request);
    const [context, version] = await Promise.all([memoryReadContext(scope), repositories().memorySyncVersion(scope)]);
    const scopeHash = memorySyncScope({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      filters: parsed.data.filters,
    });
    const currentSources = new Set(context.sourceIds);
    const previousSources = new Set(cursor.sources);
    const shouldReset =
      cursor.scope !== scopeHash ||
      BigInt(cursor.version) > BigInt(version) ||
      cursor.sources.some((id) => !currentSources.has(id)) ||
      (await repositories().memorySyncNeedsBaseline({
        scope,
        sourceIds: context.sourceIds.filter((id) => !previousSources.has(id)),
        since: cursor.version,
      }));
    if (shouldReset) {
      return {
        memories: [],
        removedIds: [],
        /** @external memory sync reset wire field */
        reset: true,
        /** @external memory sync has more wire field */
        hasMore: false,
        syncCursor: "",
      };
    }
    const changes = await repositories().memorySyncChanges({ scope, since: cursor.version });
    const ids = changes.map((change) => change.id);
    const memories =
      ids.length !== 0
        ? await repositories().listRelationshipMemories({
            sourceIds: context.sourceIds,
            filters: {
              ...parsed.data.filters,
              ids,
              throughPosition,
              limit: ids.length,
            },
            scope,
          })
        : [];
    const kept = new Set(memories.map((memory) => memory.id));

    // A transaction can move a change beyond this batch while it is read. Only
    // advance to the last delivered revision; the next batch safely replays it.
    return {
      memories,
      removedIds: ids.filter((id) => !kept.has(id)),
      /** @external memory sync has more wire field */
      hasMore: changes.length === MEMORY_SYNC_BATCH_SIZE,
      syncCursor: encodeMemorySyncCursor({
        scope: scopeHash,
        sources: context.sourceIds,
        version: changes.at(-1)?.version ?? version,
      }),
    };
  });
}

function registerMemoryPeopleListRoute(input: { app: FastifyInstance; base: string; access: MemoryRouteAccess }): void {
  input.app.get(`${input.base}/people`, input.access, async (request, reply) => {
    const parsed = memoryPeopleFiltersQuery
      .extend({
        before: z.string().max(MEMORY_POSITION_MAX_LENGTH).optional(),
        after: z.string().max(MEMORY_POSITION_MAX_LENGTH).optional(),
        paged: z.literal("1").optional(),
      })
      .safeParse(request.query);
    const hasInvalidPeoplePagination =
      parsed.success &&
      parsed.data.before !== undefined &&
      parsed.data.before.length > 0 &&
      parsed.data.after !== undefined &&
      parsed.data.after.length > 0;
    if (!parsed.success || hasInvalidPeoplePagination) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_PEOPLE_CURSOR_OR_FILTERS });
    }
    const { before, after, paged, ...filters } = parsed.data;
    const decodedPosition = tryDecodePeopleCursorToken(after ?? before);
    if (!decodedPosition.isOk) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_PEOPLE_CURSOR });
    }
    const scope = scopeFor(request);
    const context = await memoryReadContext(scope);
    // Older open clients still expect the unpaginated response during rollout.
    if (paged === undefined) {
      return { people: await repositories().listMemoryPeople({ scope, sourceIds: context.sourceIds }) };
    }
    // Filter in bounded batches so sparse searches return full result pages
    // without caching empty pages or loading every person into server memory.
    const scan = await scanFilteredMemoryPeople({
      scope,
      sourceIds: context.sourceIds,
      position: decodedPosition.position,
      filters,
      after,
    });
    const people = scan.matches.slice(0, MEMORY_PEOPLE_PAGE_SIZE);
    const continuation = pagedPeopleContinuation({ scan, people });
    const orderedPeople = memoryListUsesAfterCursor(after) ? [...people].reverse() : people;

    return {
      people: orderedPeople,
      nextCursor: pagedPeopleNextCursor({ after, before, orderedPeople, continuation }),
      previousCursor: pagedPeoplePreviousCursor({ after, before, orderedPeople, continuation }),
    };
  });
}

function registerMemoryPersonDetailRoute(input: {
  app: FastifyInstance;
  base: string;
  access: MemoryRouteAccess;
}): void {
  input.app.get(`${input.base}/people/:personId`, input.access, async (request, reply) => {
    const parsed = z.object({ personId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_PERSON_NOT_FOUND });
    }
    const scope = scopeFor(request);
    const context = await memoryReadContext(scope);
    const person = (
      await repositories().listMemoryPeople({
        scope,
        sourceIds: context.sourceIds,
        page: { personId: parsed.data.personId, limit: 1 },
      })
    ).find((p) => p.id === parsed.data.personId);
    if (person === undefined) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_PERSON_NOT_FOUND });
    }
    const projection = await repositories().readMemoryProjection({ personId: person.id, sourceIds: context.sourceIds });
    const standingIds = [...new Set(projection?.standing.flatMap((item) => item.memoryIds) ?? [])];
    const recent = await repositories().listRelationshipMemories({
      sourceIds: context.sourceIds,
      filters: { personId: person.id, limit: MEMORY_RECENT_LIMIT },
      scope,
    });
    const referenced =
      standingIds.length !== 0
        ? await repositories().listRelationshipMemories({
            sourceIds: context.sourceIds,
            filters: { personId: person.id, ids: standingIds, limit: standingIds.length },
            scope,
          })
        : [];
    const memories = [...new Map([...recent, ...referenced].map((memory) => [memory.id, memory])).values()];
    // Meetings include real interactions even when extraction intentionally returned zero memories.
    const meetings = z
      .array(memoryMeetingRowSchema)
      .parse(await repositories().listMemoryPersonMeetings({ personId: person.id, sourceIds: context.sourceIds }));
    // Profile pills are per viewer: the Ashby link shows only to members who turned Ashby on.
    const profileLinks = await (async () => {
      try {
        return await ashbyProfileLinksForPerson({
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          email: person.email,
        });
      } catch (error) {
        request.log.warn({ err: error, personId: person.id }, "Ashby profile link lookup failed");

        return [];
      }
    })();

    return {
      person: profileLinks.length !== 0 ? { ...person, profileLinks } : person,
      projection,
      memories,
      meetings,
      /** @external memory person processing wire field */
      processing: false,
    };
  });
}

function registerMemoryActionsRoute(input: { app: FastifyInstance; base: string; access: MemoryRouteAccess }): void {
  input.app.post(`${input.base}/actions`, input.access, async (request, reply) => {
    const parsed = memoryActionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_MEMORY_ACTION });
    }
    const scope = scopeFor(request);
    try {
      const context = await memoryReadContext(scope);
      await repositories().actOnMemories({
        sourceIds: context.sourceIds,
        ids: parsed.data.ids,
        action: parsed.data.action,
      });
    } catch (error) {
      if (error instanceof MemoryNotFoundError) {
        request.log.warn({ err: error }, MESSAGE_MEMORY_NOT_FOUND);

        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMORY_NOT_FOUND });
      }
      if (error instanceof MemoryBusyError) {
        request.log.warn({ err: error }, error.message);

        return reply
          .code(HTTP_SERVICE_UNAVAILABLE)
          .header("retry-after", String(MEMORY_BUSY_RETRY_AFTER_SECONDS))
          .send({ code: MEMORY_BUSY_CODE, message: error.message });
      }
      throw error;
    }

    return {
      /** @external memory action ok wire field */
      ok: true,
    };
  });
}

function registerMemoryDetailRoute(input: { app: FastifyInstance; base: string; access: MemoryRouteAccess }): void {
  input.app.get(`${input.base}/:memoryId`, input.access, async (request, reply) => {
    const parsed = z.object({ memoryId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMORY_NOT_FOUND });
    }
    const scope = scopeFor(request);
    const context = await memoryReadContext(scope);
    const visibleMemory = await repositories().readVisibleRelationshipMemoryPersonIds({
      memoryId: parsed.data.memoryId,
      sourceIds: context.sourceIds,
    });
    if (visibleMemory === null) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMORY_NOT_FOUND });
    }
    const evidence = await repositories().getMemoryEvidenceDetails({
      sourceIds: context.sourceIds,
      memoryId: parsed.data.memoryId,
    });
    if (evidence.length === 0) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMORY_NOT_FOUND });
    }
    const personIds = visibleMemory.personIds;
    const people = await repositories().listMemoryPeople({
      scope,
      sourceIds: context.sourceIds,
      page: { personIds },
    });

    return { evidence, people };
  });
}

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  const base = "/workspaces/:workspaceId/memory";
  const access = { preHandler: requireActiveWorkspaceMember };
  registerMemoryStatusRoute({ app, base, access });
  registerMemoryDisabledHook({ app });
  registerMemoryPreferencesRoute({ app, base, access });
  registerMemoryRetryRoute({ app, base, access });
  registerMemoryListRoute({ app, base, access });
  registerMemorySyncRoute({ app, base, access });
  registerMemoryPeopleListRoute({ app, base, access });
  registerMemoryPersonDetailRoute({ app, base, access });
  registerMemoryActionsRoute({ app, base, access });
  registerMemoryDetailRoute({ app, base, access });
}
