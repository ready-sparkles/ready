import "../composition/env";

import { closeDbPool, db, memorySyncChanges, memorySyncVersion, persistMemoryExtraction } from "@readymeet/db";
import { fixtureGeneration, memoryFixture } from "@readymeet/db/testing/memory";
import { memoryCandidateSchema, memoryEvidenceSchema } from "@readymeet/shared";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { z } from "zod";

import { memoryRoutes } from "../adapters/primary/http/routes/memory";
import { signAuthToken } from "../adapters/primary/http/support/auth";
import { decodeMemoryPosition } from "../application/memory-sync-cursor";

const EXPECTED_JSON_MESSAGE = "Expected JSON";

type JsonInput = string | number | boolean | null | JsonInput[] | { readonly [key: string]: JsonInput };

function isJsonInput(value: unknown): value is JsonInput {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonInput(item));
  }
  if (typeof value === "object") {
    return Object.values(value).every((item) => isJsonInput(item));
  }

  return false;
}

function jsonInput(value: unknown): Exclude<JsonInput, null> {
  if (value === null || !isJsonInput(value)) {
    throw new Error(EXPECTED_JSON_MESSAGE);
  }

  return value;
}

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_BAD_REQUEST = 400;
const MEMORY_LIST_FIRST_PAGE_SIZE = 50;
const MEMORY_LIST_SECOND_PAGE_SIZE = 5;
const MEMORY_EXTRA_CLONE_COUNT = 54;
const MEMORY_SCALE_PEOPLE_TOTAL = 125;
const MEMORY_PEOPLE_PAGE_SIZE = 50;
const MEMORY_PEOPLE_LAST_PAGE_SIZE = 25;
const MEMORY_PEOPLE_DATE_FILTER_COUNT = 30;
const MEMORY_UNPAGINATED_LENGTH_FLOOR = 50;
const SCALE_PERSON_INDEX_ZERO = 0;
const SCALE_SEARCH_SINGLE_RESULT = 1;
const SCALE_CATEGORY_EMPTY_RESULT = 0;
const MEMORY_SYNC_INITIAL_LIST_LENGTH = 1;
const YEAR_SCALE_BASE = 2026;
const MONTH_JANUARY = 0;
const DAY_FIRST = 1;
const HOUR_MIDNIGHT = 0;
const MINUTE_SCALE_CUTOFF = 30;
const MEMORY_CURSOR_PREFIX = "m1.";
const MEMORY_EVIDENCE_QUOTE = "Evidence";
const MEMORY_ADDED_TITLE = "Added memory";
const MEMORY_SCALE_QUERY = "Scale";
const MEMORY_SCALE_PERSON_LABEL = "Scale person";
const MEMORY_UPDATED_QUERY = "Updated";
const REVOKED_SECRET_TITLE = "Revoked secret";
const MEMORY_FIXTURE_DISPLAY_NAME = "Fixture";
const MEMORY_FIXTURE_EMAIL_DOMAIN = "@memory-fixture.test";
const MEMORY_SYNC_ZERO_CURSOR = "0";

const MEMORY_SYNC_TEST_MESSAGES = {
  expectedMemoryFixtureSourceAndInput: "Expected memory fixture source and input",
  expectedMemoryJob: "Expected a memory job",
  expectedMemoryCursorPosition: "Expected a memory cursor position",
  expectedMemorySource: "Expected a memory source",
  expectedRelationshipMemory: "Expected a relationship memory",
};

const relationshipMemoryRowSchema = memoryCandidateSchema.extend({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  meetingId: z.string().uuid(),
  occurredAt: z.string(),
  evidenceOccurredAt: z.string().nullable().optional(),
});

const memoryListPageSchema = z.object({
  memories: z.array(relationshipMemoryRowSchema),
  nextCursor: z.string().nullable(),
  syncCursor: z.string(),
  previousCursor: z.string().nullable().optional(),
});

const memorySyncChangesSchema = z.object({
  memories: z.array(relationshipMemoryRowSchema),
  removedIds: z.array(z.string().uuid()),
  syncCursor: z.string(),
  hasMore: z.boolean(),
  /** @external memory list sync reset wire field */
  reset: z.boolean().optional(),
});

const memoryPeoplePageSchema = z.object({
  people: z.array(z.object({ id: z.string().uuid() }).passthrough()),
  nextCursor: z.string().nullable().optional(),
  previousCursor: z.string().nullable().optional(),
});

const memoryDetailSchema = z.object({
  evidence: z.array(memoryEvidenceSchema),
  people: z.array(z.object({ id: z.string().uuid() }).passthrough()),
});

const scaleCutoffIso = new Date(
  Date.UTC(YEAR_SCALE_BASE, MONTH_JANUARY, DAY_FIRST, HOUR_MIDNIGHT, MINUTE_SCALE_CUTOFF),
).toISOString();

type MemoryFixtureInstance = Awaited<ReturnType<typeof memoryFixture>>;

after(closeDbPool);
const isIsolatedDb = process.env.MEMORY_ISOLATED_DB === "1";

function isPresent<T>(value: T): value is NonNullable<T> {
  return value !== undefined && value !== null;
}

function fixtureAuthToken(f: MemoryFixtureInstance) {
  return signAuthToken({
    sub: f.userId,
    email: `${f.userId}${MEMORY_FIXTURE_EMAIL_DOMAIN}`,
    displayName: MEMORY_FIXTURE_DISPLAY_NAME,
    workspaceId: f.workspaceId,
  });
}

function memoryAuthHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function injectMemoryListPage(input: { app: FastifyInstance; url: string; headers: { authorization: string } }) {
  const response = await input.app.inject({ url: input.url, headers: input.headers });
  assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);

  return memoryListPageSchema.parse(response.json());
}

async function injectMemoryPeoplePage(input: {
  app: FastifyInstance;
  url: string;
  headers: { authorization: string };
}) {
  const response = await input.app.inject({ url: input.url, headers: input.headers });
  assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);

  return memoryPeoplePageSchema.parse(response.json());
}

async function injectMemoryDetailPage(input: {
  app: FastifyInstance;
  url: string;
  headers: { authorization: string };
}) {
  const response = await input.app.inject({ url: input.url, headers: input.headers });
  assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);

  return memoryDetailSchema.parse(response.json());
}

async function injectMemorySyncPage(input: {
  app: FastifyInstance;
  path: string;
  headers: { authorization: string };
  cursor: string;
  through: string | null;
  filters: Record<string, string | undefined>;
}) {
  const response = await input.app.inject({
    method: "POST",
    url: `${input.path}/sync`,
    headers: input.headers,
    payload: { cursor: input.cursor, through: input.through, filters: input.filters },
  });
  assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);

  return memorySyncChangesSchema.parse(response.json());
}

async function persistedFixture(f: MemoryFixtureInstance) {
  const { source: loadedSource, input: loadedInput, job } = await f.enqueue();
  if (!isPresent(loadedSource) || !isPresent(loadedInput)) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemoryFixtureSourceAndInput);
  }
  if (job === null) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemoryJob);
  }
  const value = fixtureGeneration(loadedInput);
  await persistMemoryExtraction({
    job,
    source: loadedSource,
    candidates: value.memories,
    model: "fixture",
    generation: {
      value,
      history: [],
      sourceIds: [loadedSource.id],
      inputSources: [loadedSource],
      language: "en",
    },
  });

  return { source: loadedSource, input: loadedInput };
}

async function cloneMemoryRow(input: { id: string; sourceId: string; templateId: string; segmentId: string }) {
  const templates = await db.relationshipMemories.findMany({ where: { id: input.templateId } });
  const template = templates[0];
  if (template === undefined) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedRelationshipMemory);
  }
  await db.relationshipMemories.create({
    data: {
      id: input.id,
      sourceId: input.sourceId,
      fingerprint: input.id,
      title: MEMORY_ADDED_TITLE,
      description: template.description,
      category: template.category,
      personIds: template.personIds,
      /** @external persisted relationship memory sensitive */
      sensitive: template.sensitive,
      confidence: template.confidence,
      occurredAt: template.occurredAt,
      importance: template.importance,
      factFingerprint: input.id,
      factIdentity: jsonInput(template.factIdentity),
    },
  });
  await db.memoryEvidence.create({
    data: {
      memoryId: input.id,
      segmentId: input.segmentId,
      quote: MEMORY_EVIDENCE_QUOTE,
    },
  });
}

async function cloneMemorySource(input: { templateId: string; id: string }) {
  const templates = await db.memorySources.findMany({ where: { id: input.templateId } });
  const template = templates[0];
  if (template === undefined) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemorySource);
  }
  await db.memorySources.create({
    data: {
      id: input.id,
      userId: template.userId,
      workspaceId: template.workspaceId,
      kind: template.kind,
      externalId: input.id,
      meetingId: template.meetingId,
      occurredAt: template.occurredAt,
      revision: template.revision,
      isCurrent: true,
      /** @external persisted memory source includeSensitive */
      includeSensitive: template.includeSensitive,
    },
  });
}

async function seedScalePeople(input: { fixture: MemoryFixtureInstance; sourceId: string }) {
  await Array.from({ length: MEMORY_SCALE_PEOPLE_TOTAL }, (_, index) => index).reduce(async (previous, index) => {
    await previous;
    const id = randomUUID();
    await db.memoryPeople.create({
      data: {
        id,
        userId: input.fixture.userId,
        workspaceId: input.fixture.workspaceId,
        name: `${MEMORY_SCALE_PERSON_LABEL} ${index}`,
      },
    });
    await db.memoryInteractions.create({
      data: {
        sourceId: input.sourceId,
        personId: id,
        occurredAt: new Date(Date.UTC(YEAR_SCALE_BASE, MONTH_JANUARY, DAY_FIRST, HOUR_MIDNIGHT, index)),
      },
    });
  }, Promise.resolve());
}

async function assertMemoryListPagination(input: {
  app: FastifyInstance;
  path: string;
  headers: { authorization: string };
}) {
  const first = await injectMemoryListPage({ app: input.app, url: input.path, headers: input.headers });
  assert.equal(first.memories.length, MEMORY_LIST_FIRST_PAGE_SIZE);
  assert.ok(first.nextCursor !== null && first.nextCursor.startsWith(MEMORY_CURSOR_PREFIX));
  const second = await injectMemoryListPage({
    app: input.app,
    url: `${input.path}?before=${first.nextCursor}`,
    headers: input.headers,
  });
  assert.equal(second.memories.length, MEMORY_LIST_SECOND_PAGE_SIZE);
  const newer = await injectMemoryListPage({
    app: input.app,
    url: `${input.path}?after=${second.previousCursor ?? ""}`,
    headers: input.headers,
  });
  assert.deepEqual(
    newer.memories.map((row) => row.id),
    first.memories.map((row) => row.id),
  );
  assert.equal(newer.previousCursor, null);

  return { first, second };
}

async function assertMemoryPeoplePagination(input: {
  app: FastifyInstance;
  path: string;
  headers: { authorization: string };
}) {
  const peoplePath = `${input.path}/people?paged=1&q=${MEMORY_SCALE_QUERY}`;
  const peopleFirst = await injectMemoryPeoplePage({ app: input.app, url: peoplePath, headers: input.headers });
  const peopleSecond = await injectMemoryPeoplePage({
    app: input.app,
    url: `${peoplePath}&before=${peopleFirst.nextCursor ?? ""}`,
    headers: input.headers,
  });
  const peopleThird = await injectMemoryPeoplePage({
    app: input.app,
    url: `${peoplePath}&before=${peopleSecond.nextCursor ?? ""}`,
    headers: input.headers,
  });
  assert.equal(peopleFirst.people.length, MEMORY_PEOPLE_PAGE_SIZE);
  assert.equal(peopleSecond.people.length, MEMORY_PEOPLE_PAGE_SIZE);
  assert.equal(peopleThird.people.length, MEMORY_PEOPLE_LAST_PAGE_SIZE);
  assert.equal(
    new Set([...peopleFirst.people, ...peopleSecond.people, ...peopleThird.people].map((row) => row.id)).size,
    MEMORY_SCALE_PEOPLE_TOTAL,
  );
  const peopleNewer = await injectMemoryPeoplePage({
    app: input.app,
    url: `${peoplePath}&after=${peopleSecond.previousCursor ?? ""}`,
    headers: input.headers,
  });
  assert.deepEqual(
    peopleNewer.people.map((row) => row.id),
    peopleFirst.people.map((row) => row.id),
  );
  const peopleSearch = await injectMemoryPeoplePage({
    app: input.app,
    url: `${input.path}/people?paged=1&q=${encodeURIComponent(`${MEMORY_SCALE_PERSON_LABEL} ${SCALE_PERSON_INDEX_ZERO}`)}`,
    headers: input.headers,
  });
  assert.equal(peopleSearch.people.length, SCALE_SEARCH_SINGLE_RESULT);
  assert.equal(
    (await injectMemoryPeoplePage({ app: input.app, url: `${peoplePath}&category=Sales`, headers: input.headers }))
      .people.length,
    SCALE_CATEGORY_EMPTY_RESULT,
  );
  assert.equal(
    (
      await injectMemoryPeoplePage({
        app: input.app,
        url: `${peoplePath}&category=Sales&categoryOperator=is_not`,
        headers: input.headers,
      })
    ).people.length,
    MEMORY_PEOPLE_PAGE_SIZE,
  );
  const cutoff = encodeURIComponent(scaleCutoffIso);
  assert.equal(
    (
      await injectMemoryPeoplePage({
        app: input.app,
        url: `${peoplePath}&from=${cutoff}&dateOperator=is_not`,
        headers: input.headers,
      })
    ).people.length,
    MEMORY_PEOPLE_DATE_FILTER_COUNT,
  );
  assert.equal(
    (await input.app.inject({ url: `${input.path}/people?paged=1&before=invalid`, headers: input.headers })).statusCode,
    HTTP_STATUS_BAD_REQUEST,
  );
  assert.ok(
    (await injectMemoryPeoplePage({ app: input.app, url: `${input.path}/people`, headers: input.headers })).people
      .length > MEMORY_UNPAGINATED_LENGTH_FLOOR,
    "older clients retain their unpaginated contract",
  );

  return { peopleFirst };
}

async function assertIncrementalMemorySyncEdits(input: {
  app: FastifyInstance;
  path: string;
  headers: { authorization: string };
  first: z.infer<typeof memoryListPageSchema>;
  second: z.infer<typeof memoryListPageSchema>;
  original: string;
}) {
  const detail = await injectMemoryDetailPage({
    app: input.app,
    url: `${input.path}/${input.original}`,
    headers: input.headers,
  });
  assert.notEqual(detail.people.length, 0);
  const memoryOnFirstPage = input.first.memories.find((memory) => memory.id === input.original);
  const memoryOnSecondPage = input.second.memories.find((memory) => memory.id === input.original);
  assert.ok(
    detail.people.every(
      (person) =>
        memoryOnFirstPage?.personIds.includes(person.id) ?? memoryOnSecondPage?.personIds.includes(person.id) ?? false,
    ),
  );
  const category = input.first.memories[0]?.category;
  if (category === undefined) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemoryFixtureSourceAndInput);
  }
  const categorySearch = await injectMemoryPeoplePage({
    app: input.app,
    url: `${input.path}/people?paged=1&q=${encodeURIComponent(category)}`,
    headers: input.headers,
  });
  const detailPerson = detail.people[0];
  if (detailPerson === undefined) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemoryFixtureSourceAndInput);
  }
  assert.ok(categorySearch.people.some((person) => person.id === detailPerson.id));
  const unchanged = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: input.first.syncCursor,
    through: null,
    filters: {},
  });
  assert.deepEqual(unchanged.memories, []);
  assert.deepEqual(unchanged.removedIds, []);
  const olderMemory = input.second.memories[0];
  if (olderMemory === undefined) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemoryFixtureSourceAndInput);
  }
  const olderId = olderMemory.id;
  await db.relationshipMemories.updateMany({
    where: { id: olderId },
    data: { title: "Updated older memory" },
  });
  const edit = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: unchanged.syncCursor,
    through: null,
    filters: {},
  });
  assert.deepEqual(
    edit.memories.map((row) => row.id),
    [olderId],
  );
  assert.equal(edit.memories[0]?.title, "Updated older memory");
  const beforeLoaded = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: unchanged.syncCursor,
    through: input.first.nextCursor,
    filters: {},
  });
  assert.deepEqual(beforeLoaded.memories, [], "Do not fill unloaded history gaps with changed old rows");
  await db.memoryEvidence.updateMany({ where: { memoryId: olderId }, data: { quote: "Updated evidence" } });
  const evidence = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: edit.syncCursor,
    through: null,
    filters: {},
  });
  assert.equal(evidence.memories[0]?.evidence[0]?.quote, "Updated evidence");

  return { olderId, evidence };
}

async function assertIncrementalMemorySyncLifecycle(input: {
  app: FastifyInstance;
  path: string;
  headers: { authorization: string };
  sourceId: string;
  segmentId: string;
  meetingId: string;
  first: z.infer<typeof memoryListPageSchema>;
  olderId: string;
  evidence: z.infer<typeof memorySyncChangesSchema>;
}) {
  const deletedPosition = decodeMemoryPosition(input.first.nextCursor ?? "");
  if (deletedPosition === undefined) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemoryCursorPosition);
  }
  const deleted = deletedPosition.id;
  await db.relationshipMemories.deleteMany({ where: { id: deleted } });
  const removal = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: input.evidence.syncCursor,
    through: null,
    filters: {},
  });
  assert.deepEqual(removal.removedIds, [deleted]);
  const afterDeletedAnchor = await injectMemoryListPage({
    app: input.app,
    url: `${input.path}?before=${input.first.nextCursor ?? ""}`,
    headers: input.headers,
  });
  assert.equal(afterDeletedAnchor.memories.length, MEMORY_LIST_SECOND_PAGE_SIZE);
  const newSource = randomUUID();
  await cloneMemorySource({ templateId: input.sourceId, id: newSource });
  const added = randomUUID();
  await cloneMemoryRow({
    id: added,
    sourceId: newSource,
    templateId: input.olderId,
    segmentId: input.segmentId,
  });
  const addition = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: removal.syncCursor,
    through: null,
    filters: {},
  });
  assert.equal(addition.reset, undefined, "A newly generated source must not reload old pages");
  assert.deepEqual(
    addition.memories.map((row) => row.id),
    [added],
  );
  const filtered = await injectMemoryListPage({
    app: input.app,
    url: `${input.path}?q=${MEMORY_UPDATED_QUERY}`,
    headers: input.headers,
  });
  await db.relationshipMemories.updateMany({
    where: { id: input.olderId },
    data: { title: "No longer matches" },
  });
  const excluded = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: filtered.syncCursor,
    through: null,
    filters: { q: MEMORY_UPDATED_QUERY },
  });
  assert.deepEqual(excluded.removedIds, [input.olderId]);
  await db.memorySources.updateMany({ where: { id: newSource }, data: { isCurrent: false } });
  const hidden = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: addition.syncCursor,
    through: null,
    filters: {},
  });
  assert.ok(hidden.removedIds.includes(added));
  await db.meetings.updateMany({
    where: { id: input.meetingId },
    data: { hiddenFromHistoryAt: new Date() },
  });
  const revoked = await injectMemorySyncPage({
    app: input.app,
    path: input.path,
    headers: input.headers,
    cursor: hidden.syncCursor,
    through: null,
    filters: {},
  });
  assert.equal(revoked.reset, true);
  assert.deepEqual(
    (await injectMemoryListPage({ app: input.app, url: input.path, headers: input.headers })).memories,
    [],
  );
}

async function exerciseIncrementalMemoryApi(input: { f: MemoryFixtureInstance; app: FastifyInstance }) {
  const { source } = await persistedFixture(input.f);
  const savedMemories = await db.relationshipMemories.findMany({
    where: { sourceId: source.id },
  });
  const original = savedMemories[0]?.id;
  if (original === undefined) {
    throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedRelationshipMemory);
  }
  await Array.from({ length: MEMORY_EXTRA_CLONE_COUNT }, () => randomUUID()).reduce(async (previous, id) => {
    await previous;
    await cloneMemoryRow({ id, sourceId: source.id, templateId: original, segmentId: input.f.segmentId });
  }, Promise.resolve());
  const headers = memoryAuthHeaders(fixtureAuthToken(input.f));
  await input.app.register(memoryRoutes, { prefix: "/v1" });
  const path = `/v1/workspaces/${input.f.workspaceId}/memory`;
  const { first, second } = await assertMemoryListPagination({ app: input.app, path, headers });
  await seedScalePeople({ fixture: input.f, sourceId: source.id });
  await assertMemoryPeoplePagination({ app: input.app, path, headers });
  const { olderId, evidence } = await assertIncrementalMemorySyncEdits({
    app: input.app,
    path,
    headers,
    first,
    second,
    original,
  });
  await assertIncrementalMemorySyncLifecycle({
    app: input.app,
    path,
    headers,
    sourceId: source.id,
    segmentId: input.f.segmentId,
    meetingId: input.f.meetingId,
    first,
    olderId,
    evidence,
  });
  assert.deepEqual(
    await memorySyncChanges({ scope: { ...input.f.scope, userId: input.f.peer }, since: MEMORY_SYNC_ZERO_CURSOR }),
    [],
  );
}

void test(
  "incremental memory API covers unchanged polls, edits, evidence, tombstones, filters, new sources and deleted pagination anchors",
  { skip: !isIsolatedDb },
  async () => {
    const f = await memoryFixture();
    const app = Fastify();
    try {
      await exerciseIncrementalMemoryApi({ f, app });
    } finally {
      await app.close();
      await f.cleanup();
    }
  },
);

async function revokeMemoryAccess(input: {
  kind: "meeting" | "membership" | "notes";
  userId: string;
  workspaceId: string;
  meetingId: string;
}) {
  if (input.kind === "meeting") {
    await db.meetings.updateMany({
      where: { id: input.meetingId },
      data: { hiddenFromHistoryAt: new Date() },
    });

    return;
  }
  if (input.kind === "membership") {
    await db.workspaceMemberships.updateMany({
      where: { userId: input.userId, workspaceId: input.workspaceId },
      data: { role: "member", status: "suspended" },
    });

    return;
  }
  await db.users.updateMany({ where: { id: input.userId }, data: { privateBetaProEnabledAt: null } });
}

async function removeMemoryParent(input: {
  parent: "source" | "meeting" | "workspace" | "user";
  sourceId: string;
  meetingId: string;
  workspaceId: string;
  userId: string;
}) {
  if (input.parent === "source") {
    await db.memorySources.deleteMany({ where: { id: input.sourceId } });

    return;
  }
  if (input.parent === "meeting") {
    await db.meetings.deleteMany({ where: { id: input.meetingId } });

    return;
  }
  if (input.parent === "workspace") {
    await db.workspaces.deleteMany({ where: { id: input.workspaceId } });

    return;
  }
  await db.users.deleteMany({ where: { id: input.userId } });
}

(["list", "sync"] as const).forEach((endpoint) => {
  (["meeting", "membership", "notes"] as const).forEach((revocation) => {
    void test(`${endpoint} omits memories after ${revocation} access is removed`, { skip: !isIsolatedDb }, async () => {
      const f = await memoryFixture();
      const app = Fastify();
      try {
        await persistedFixture(f);
        const headers = memoryAuthHeaders(fixtureAuthToken(f));
        await app.register(memoryRoutes, { prefix: "/v1" });
        const path = `/v1/workspaces/${f.workspaceId}/memory`;
        const baseline = await app.inject({ url: path, headers });
        assert.equal(baseline.statusCode, HTTP_STATUS_OK, baseline.body);
        const initial = memoryListPageSchema.parse(baseline.json());
        assert.equal(initial.memories.length, MEMORY_SYNC_INITIAL_LIST_LENGTH);
        const firstMemory = initial.memories[0];
        if (firstMemory === undefined) {
          throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemoryFixtureSourceAndInput);
        }
        const id = firstMemory.id;
        await db.relationshipMemories.updateMany({
          where: { id },
          data: { title: REVOKED_SECRET_TITLE },
        });
        await revokeMemoryAccess({
          kind: revocation,
          userId: f.userId,
          workspaceId: f.workspaceId,
          meetingId: f.meetingId,
        });
        const response = await app.inject(
          endpoint === "list"
            ? { url: path, headers }
            : {
                method: "POST",
                url: `${path}/sync`,
                headers,
                payload: { cursor: initial.syncCursor, through: null, filters: {} },
              },
        );
        if (revocation === "membership") {
          assert.equal(response.statusCode, HTTP_STATUS_FORBIDDEN, response.body);
          assert.ok(!response.body.includes(REVOKED_SECRET_TITLE));

          return;
        }
        assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);
        if (endpoint === "list") {
          const parsed = memoryListPageSchema.parse(response.json());
          assert.deepEqual(parsed.memories, []);
        } else {
          const parsed = memorySyncChangesSchema.parse(response.json());
          assert.deepEqual(parsed.memories, []);
          if (parsed.reset === true) {
            assert.deepEqual(parsed.removedIds, []);
          } else {
            assert.deepEqual(parsed.removedIds, [id]);
          }
        }
        assert.ok(!response.body.includes(REVOKED_SECRET_TITLE));
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
});

(["source", "meeting", "workspace", "user"] as const).forEach((parent) => {
  void test(
    `removing a ${parent} preserves cascade tombstones or clears the owner's sync state`,
    { skip: !isIsolatedDb },
    async () => {
      const f = await memoryFixture({ external: parent === "workspace" });
      const app = Fastify();
      try {
        const { source } = await persistedFixture(f);
        const headers = memoryAuthHeaders(fixtureAuthToken(f));
        await app.register(memoryRoutes, { prefix: "/v1" });
        const path = `/v1/workspaces/${f.workspaceId}/memory`;
        const baseline = await app.inject({ url: path, headers });
        assert.equal(baseline.statusCode, HTTP_STATUS_OK, baseline.body);
        const initial = memoryListPageSchema.parse(baseline.json());
        const firstMemory = initial.memories[0];
        if (firstMemory === undefined) {
          throw new Error(MEMORY_SYNC_TEST_MESSAGES.expectedMemoryFixtureSourceAndInput);
        }
        const id = firstMemory.id;
        const before = await memorySyncVersion(f.scope);
        await removeMemoryParent({
          parent,
          sourceId: source.id,
          meetingId: f.meetingId,
          workspaceId: f.workspaceId,
          userId: f.userId,
        });
        const remaining = await db.relationshipMemories.findMany({
          where: { id },
        });
        assert.equal(remaining.length, 0);
        if (parent === "source" || parent === "meeting") {
          assert.deepEqual(
            (await memorySyncChanges({ scope: f.scope, since: before })).map((row) => row.id),
            [id],
          );
          const response = await app.inject({
            method: "POST",
            url: `${path}/sync`,
            headers,
            payload: { cursor: initial.syncCursor, through: null, filters: {} },
          });
          assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);
          const syncBody = memorySyncChangesSchema.parse(response.json());
          assert.equal(syncBody.reset, true, "The missing source clears cached pages");
          assert.deepEqual((await injectMemoryListPage({ app, url: path, headers })).memories, []);
        } else {
          assert.deepEqual(await memorySyncChanges({ scope: f.scope, since: MEMORY_SYNC_ZERO_CURSOR }), []);
          assert.equal(await memorySyncVersion(f.scope), MEMORY_SYNC_ZERO_CURSOR);
        }
      } finally {
        await app.close();
        await f.cleanup();
      }
    },
  );
});
