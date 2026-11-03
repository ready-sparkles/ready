import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import { getGuestRecognition, recognizeGuest } from "../adapters/secondary/postgres/guest-recognition";
import {
  actOnMemories,
  listMemoryPeople,
  memoryPeopleForMeetingUsers,
  persistMemoryExtraction,
  prepareMemoryInput,
  readMemoryProjection,
  saveMemoryProjection,
} from "../adapters/secondary/postgres/relationship-memory";
import {
  GuestSessionLinkConflictError,
  transferGuestMeetingAccessToUser,
} from "../adapters/secondary/postgres/repositories";

import { fixtureGeneration, memoryFixture } from "./memory-fixture";

const HISTORY_SUMMARY_COUNT = 2;
const GUEST_SUMMARY_TEXT = "Guest summary";
const ACCOUNT_SUMMARY_TEXT = "Account summary";
const PROPOSAL_PENDING_TEXT = "Proposal pending";
const FORGOTTEN_FACT_TEXT = "Forgotten fact";
const PREVIOUSLY_SAVED_SUMMARY_TEXT = "Previously saved summary";
const MISSING_REQUIRED_VALUE = "Expected a value.";
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error(MISSING_REQUIRED_VALUE);
  }

  return value;
};

const factSubject = (value: unknown): string => {
  if (typeof value === "object" && value !== null && "subject" in value && typeof value.subject === "string") {
    return value.subject;
  }

  throw new Error(MISSING_REQUIRED_VALUE);
};

const counted = async (count: Promise<number>): Promise<number> => count;

const deleteUsers = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) {
    return;
  }
  await db.users.deleteMany({ where: { id: { in: ids } } });
};

const deleteBrowsers = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) {
    return;
  }
  await db.guestBrowserIdentities.deleteMany({ where: { id: { in: ids } } });
};

const fileEndedAttendee = async (input: { meetingId: string; userId: string; workspaceId: string }): Promise<void> => {
  await db.meetingAttendeeWorkspaces.createMany({
    data: {
      meetingId: input.meetingId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      assignment: "joined_workspace",
    },
    /** @external Prisma field */ skipDuplicates: true,
  });
};

const copyAttendance = async (input: { meetingId: string; fromUserId: string; toUserId: string }): Promise<void> => {
  const participants = await db.meetingParticipants.findMany({
    where: { meetingId: input.meetingId, userId: input.fromUserId },
    select: { /** @external Prisma field */ joinedAt: true, /** @external Prisma field */ leftAt: true },
  });
  if (participants.length !== 0) {
    await db.meetingParticipants.createMany({
      data: participants.map((row) => ({
        meetingId: input.meetingId,
        userId: input.toUserId,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      })),
    });
  }
  const intervals = await db.meetingAttendanceIntervals.findMany({
    where: { meetingId: input.meetingId, userId: input.fromUserId },
    select: { /** @external Prisma field */ joinedAt: true, /** @external Prisma field */ leftAt: true },
  });
  if (intervals.length !== 0) {
    await db.meetingAttendanceIntervals.createMany({
      data: intervals.map((row) => ({
        meetingId: input.meetingId,
        userId: input.toUserId,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      })),
    });
  }
};

after(closeDbPool);
const isolated = {
  /** @external node:test skip option */
  skip: process.env.MEMORY_ISOLATED_DB !== "1",
};

async function assertSignupPersonProfileUpdatesAfterTransfer(input: {
  account: string;
  f: Awaited<ReturnType<typeof memoryFixture>>;
  after: Awaited<ReturnType<Awaited<ReturnType<typeof memoryFixture>>["enqueue"]>>;
}) {
  await db.users.updateMany({
    where: { id: input.account },
    data: { displayName: "Personqg New", avatarUrl: "https://example.com/new.jpg" },
  });
  const updated = required(
    (await listMemoryPeople({ scope: input.f.scope, sourceIds: [required(input.after.source).id] }))[0],
  );
  assert.equal(updated.name, "Personqg New");
  assert.equal(updated.imageUrl, "https://example.com/new.jpg");
}

type MemoryFixture = Awaited<ReturnType<typeof memoryFixture>>;
type EnqueuedMemory = Awaited<ReturnType<MemoryFixture["enqueue"]>>;

const assertScopedSignupResult = async (input: {
  data: EnqueuedMemory | null;
  fixture: MemoryFixture;
  other: MemoryFixture;
  account: string;
  originalId: string;
  otherPerson: string;
}): Promise<void> => {
  const after = input.data
    ? {
        ...input.data,
        input: await prepareMemoryInput({
          scope: input.fixture.scope,
          source: required(input.data.source),
          preferences: input.data.prefs,
        }),
      }
    : await input.fixture.enqueue();
  const id = required(required(after.input).people[0]).id;
  if (input.originalId.length > 0) {
    assert.equal(id, input.originalId);
  }
  assert.equal(required(required(after.input).people[0]).name, "Personqg Personqi");
  const people = await listMemoryPeople({ scope: input.fixture.scope, sourceIds: [required(after.source).id] });
  assert.equal(people.length, 1);
  assert.equal(required(people[0]).id, id);
  assert.equal(required(people[0]).imageUrl, "https://example.com/photo.jpg");
  assert.equal(required(people[0]).name, "Personqg Personqi");
  assert.deepEqual(await memoryPeopleForMeetingUsers({ scope: input.other.scope, userIds: [input.account] }), [
    { userId: input.account, personId: input.otherPerson },
  ]);
  assert.notEqual(input.otherPerson, id);
  const [otherParticipant] = await db.meetingParticipants.findMany({
    where: { meetingId: input.other.meetingId, userId: input.account },
    select: { /** @external Prisma field */ id: true },
  });
  assert.equal(otherParticipant, undefined);
  await assertSignupPersonProfileUpdatesAfterTransfer({ account: input.account, f: input.fixture, after });
  await assert.rejects(
    transferGuestMeetingAccessToUser({
      guestUserId: input.fixture.peer,
      targetUserId: input.other.peer,
      targetWorkspaceId: input.other.workspaceId,
    }),
    GuestSessionLinkConflictError,
  );
};

const assertSignupKeepsScopedPerson = async ({
  hasCookie,
  isBeforeExtraction,
}: {
  hasCookie: boolean;
  isBeforeExtraction: boolean;
}): Promise<void> => {
  const f = await memoryFixture();
  const other = await memoryFixture();
  const account = randomUUID();
  const browser = { id: undefined as string | undefined };
  try {
    await db.users.updateMany({ where: { id: f.peer }, data: { source: "guest", displayName: "Personqh" } });
    if (hasCookie) {
      const cookie = await recognizeGuest({ guestUserId: f.peer, explicitOptIn: true });
      browser.id = required(await getGuestRecognition(cookie.token)).id;
    }
    await db.users.create({
      data: {
        id: account,
        email: `${account}@test.example`,
        displayName: "Personqg Personqi",
        source: "auth",
        avatarUrl: "https://example.com/photo.jpg",
        activeWorkspaceId: f.workspaceId,
      },
    });
    await db.workspaceMemberships.create({ data: { userId: account, workspaceId: f.workspaceId, role: "member" } });
    const data = isBeforeExtraction ? null : await f.enqueue();
    const originalId = data === null ? "" : required(required(data.input).people[0]).id;
    const otherPerson = randomUUID();
    await db.memoryPeople.create({
      data: {
        id: otherPerson,
        userId: other.userId,
        workspaceId: other.workspaceId,
        name: "Personqh",
      },
    });
    await db.memoryPersonIdentities.create({
      data: {
        personId: otherPerson,
        userId: other.userId,
        workspaceId: other.workspaceId,
        kind: hasCookie ? "guest_browser" : "user_id",
        identity: browser.id ?? f.peer,
      },
    });
    await transferGuestMeetingAccessToUser({
      guestUserId: f.peer,
      targetUserId: account,
      targetWorkspaceId: f.workspaceId,
    });
    await transferGuestMeetingAccessToUser({
      guestUserId: f.peer,
      targetUserId: account,
      targetWorkspaceId: f.workspaceId,
    });
    await assertScopedSignupResult({ data, fixture: f, other, account, originalId, otherPerson });
  } finally {
    if (browser.id !== undefined) {
      await deleteBrowsers([browser.id]);
    }
    await f.cleanup();
    await other.cleanup();
    await deleteUsers([account]);
  }
};

[false, true].forEach((hasCookie) => {
  [false, true].forEach((isBeforeExtraction) => {
    void test(
      `signup keeps the scoped person, account name and photo (before extraction: ${isBeforeExtraction}, cookie: ${hasCookie})`,
      isolated,
      async () => {
        await assertSignupKeepsScopedPerson({ hasCookie, isBeforeExtraction });
      },
    );
  });
});

const assertRepairedMemoryIdentity = async ({
  memoryId,
  accountPersonId,
  guestPersonId,
}: {
  memoryId: string;
  accountPersonId: string;
  guestPersonId: string;
}): Promise<void> => {
  await db.relationshipMemories.updateMany({
    where: { id: memoryId },
    data: { personIds: [accountPersonId], candidateSubjectId: accountPersonId },
  });
  const [memory] = await db.relationshipMemories.findMany({
    where: { id: memoryId },
    select: { /** @external Prisma field */ personIds: true },
  });
  assert.deepEqual(memory?.personIds, [guestPersonId]);
  await db.memoryPersonProjections.create({
    data: {
      personId: accountPersonId,
      inputHash: "stale",
      content: {},
      promptVersion: "fixture",
    },
  });
  assert.equal(await counted(db.memoryPersonProjections.count({ where: { personId: accountPersonId } })), 0);
  const [name] = await db.memoryPersonNames.findMany({
    where: { personId: guestPersonId },
    select: { /** @external Prisma field */ name: true },
  });
  assert.equal(required(name).name, "Personqh");
};

const assertCollisionProjection = async ({
  projectionCase,
  guestPersonId,
  accountPersonId,
  accountId,
  guestUserId,
  workspaceId,
  scope,
  sourceId,
  sourceRevision,
  memoryId,
}: {
  projectionCase: "both" | "account only" | "stale guest" | "stale account";
  guestPersonId: string;
  accountPersonId: string;
  accountId: string;
  guestUserId: string;
  workspaceId: string;
  scope: Parameters<typeof listMemoryPeople>[0]["scope"];
  sourceId: string;
  sourceRevision: string | number;
  memoryId: string;
}): Promise<void> => {
  const guestSummary = { text: GUEST_SUMMARY_TEXT, memoryIds: [memoryId] };
  const accountSummary = { text: ACCOUNT_SUMMARY_TEXT, memoryIds: [memoryId] };
  const standing = { text: PROPOSAL_PENDING_TEXT, memoryIds: [memoryId] };
  const revisions: Record<string, string> = { [sourceId]: String(sourceRevision) };
  if (projectionCase !== "account only") {
    await saveMemoryProjection({
      personId: guestPersonId,
      inputHash: "guest",
      projection: { summary: [guestSummary], standing: [standing] },
      sourceRevisions: projectionCase === "stale guest" ? { [sourceId]: "old-revision" } : revisions,
    });
  }
  await saveMemoryProjection({
    personId: accountPersonId,
    inputHash: "account",
    projection: {
      summary: [accountSummary, { text: FORGOTTEN_FACT_TEXT, memoryIds: [randomUUID()] }],
      standing: [standing],
    },
    sourceRevisions: projectionCase === "stale account" ? { [sourceId]: "old-revision" } : revisions,
  });
  await transferGuestMeetingAccessToUser({
    guestUserId,
    targetUserId: accountId,
    targetWorkspaceId: workspaceId,
  });
  const projection = await readMemoryProjection({ personId: guestPersonId, sourceIds: [sourceId] });
  assert.deepEqual(projection, {
    summary:
      projectionCase === "both"
        ? [accountSummary, guestSummary]
        : projectionCase === "stale account"
          ? [guestSummary]
          : [accountSummary],
    standing: [standing],
  });
  assert.equal(await readMemoryProjection({ personId: guestPersonId, sourceIds: [] }), null);
  assert.equal(await readMemoryProjection({ personId: accountPersonId, sourceIds: [sourceId] }), null);
  await transferGuestMeetingAccessToUser({ guestUserId, targetUserId: accountId });
  assert.deepEqual(await readMemoryProjection({ personId: guestPersonId, sourceIds: [sourceId] }), projection);
  const [memory] = await db.relationshipMemories.findMany({
    where: { id: memoryId },
    select: {
      /** @external Prisma field */ id: true,
      /** @external Prisma field */ personIds: true,
      /** @external Prisma field */ candidateSubjectId: true,
      /** @external Prisma field */ factFingerprint: true,
      /** @external Prisma field */ factIdentity: true,
    },
  });
  const savedMemory = required(memory);
  assert.deepEqual(savedMemory.personIds, [guestPersonId]);
  assert.equal(savedMemory.candidateSubjectId, guestPersonId);
  assert.equal(savedMemory.factFingerprint, "immutable-fact");
  assert.equal(factSubject(savedMemory.factIdentity), accountPersonId);
  assert.equal(await counted(db.memoryEvidence.count({ where: { memoryId: savedMemory.id } })), 1);
  assert.equal(await counted(db.memorySuppressions.count({ where: { sourceId } })), 1);
  assert.equal((await listMemoryPeople({ scope, sourceIds: [sourceId] })).length, 1);
  await assertRepairedMemoryIdentity({ memoryId: savedMemory.id, accountPersonId, guestPersonId });
};

const seedAccountCollision = async (input: {
  fixture: MemoryFixture;
  account: string;
}): Promise<{
  browserId: string;
  guestPersonId: string;
  accountPersonId: string;
  sourceId: string;
  sourceRevision: string | number;
  memoryId: string;
}> => {
  await db.users.updateMany({
    where: { id: input.fixture.peer },
    data: { source: "guest", displayName: "Personqh" },
  });
  const token = await recognizeGuest({ guestUserId: input.fixture.peer, explicitOptIn: true });
  const browserId = required(await getGuestRecognition(token.token)).id;
  const data = await input.fixture.enqueue();
  const guestPersonId = required(required(data.input).people[0]).id;
  const accountPersonId = randomUUID();
  await db.users.create({
    data: {
      id: input.account,
      email: `${input.account}@test.example`,
      displayName: "Personqg",
      source: "auth",
    },
  });
  await db.workspaceMemberships.create({
    data: { userId: input.account, workspaceId: input.fixture.workspaceId, role: "member" },
  });
  await db.memoryPeople.create({
    data: {
      id: accountPersonId,
      userId: input.fixture.userId,
      workspaceId: input.fixture.workspaceId,
      name: "Personqg",
    },
  });
  await db.memoryPersonIdentities.create({
    data: {
      personId: accountPersonId,
      userId: input.fixture.userId,
      workspaceId: input.fixture.workspaceId,
      kind: "user_id",
      identity: input.account,
    },
  });
  const sourceId = required(data.source).id;
  await db.memoryInteractions.create({
    data: { sourceId, personId: accountPersonId, occurredAt: new Date() },
  });
  const saved = await db.relationshipMemories.create({
    data: {
      sourceId,
      fingerprint: "fixture",
      title: "Proposal",
      description: "Proposal",
      category: "Sales",
      personIds: [accountPersonId],
      candidateSubjectId: accountPersonId,
      /** @external column */
      sensitive: false,
      confidence: "high",
      occurredAt: new Date(),
      factFingerprint: "immutable-fact",
      factIdentity: { subject: accountPersonId, predicate: "offer", object: "proposal", context: "" },
    },
    select: { /** @external Prisma field */ id: true },
  });
  const memoryId = required(saved).id;
  await db.memoryEvidence.create({
    data: { memoryId, segmentId: input.fixture.segmentId, quote: "I will send you the proposal." },
  });
  await db.memorySuppressions.create({
    data: {
      sourceId,
      factFingerprint: "forgotten",
      factIdentity: { subject: accountPersonId, predicate: "private", object: "fact", context: "" },
    },
  });
  await db.memorySources.updateMany({ where: { id: sourceId }, data: { isCurrent: true } });

  return {
    browserId,
    guestPersonId,
    accountPersonId,
    sourceId,
    sourceRevision: required(data.source).revision,
    memoryId,
  };
};

(["both", "account only", "stale guest", "stale account"] as const).forEach((projectionCase) => {
  void test(`account collision preserves valid projections and evidence (${projectionCase})`, isolated, async () => {
    const f = await memoryFixture();
    const account = randomUUID();
    const browser = { id: undefined as string | undefined };
    try {
      const seeded = await seedAccountCollision({ fixture: f, account });
      browser.id = seeded.browserId;
      await assertCollisionProjection({
        projectionCase,
        accountId: account,
        guestUserId: f.peer,
        workspaceId: f.workspaceId,
        scope: f.scope,
        guestPersonId: seeded.guestPersonId,
        accountPersonId: seeded.accountPersonId,
        sourceId: seeded.sourceId,
        sourceRevision: seeded.sourceRevision,
        memoryId: seeded.memoryId,
      });
    } finally {
      if (browser.id !== undefined) {
        await deleteBrowsers([browser.id]);
      }
      await f.cleanup();
      await deleteUsers([account]);
    }
  });
});

void test("signup links the guest account and keeps the observed person name", isolated, async () => {
  const f = await memoryFixture();
  const account = await memoryFixture();
  try {
    await db.users.updateMany({ where: { id: f.peer }, data: { source: "guest" } });
    const data = await f.enqueue();
    const personId = required(required(data.input).people[0]).id;
    const sourceId = required(data.source).id;
    await db.memoryPersonNames.createMany({
      data: {
        personId,
        sourceId,
        participantUserId: f.peer,
        name: "Personqh",
        normalizedName: "personqh",
        wordCount: 1,
        observedAt: new Date(),
      },
      /** @external Prisma field */ skipDuplicates: true,
    });
    await transferGuestMeetingAccessToUser({ guestUserId: f.peer, targetUserId: account.peer });
    const [link] = await db.guestMemoryAccountLinks.findMany({
      where: { guestUserId: f.peer },
      select: { /** @external Prisma field */ accountUserId: true },
    });
    assert.equal(link?.accountUserId, account.peer);
    const [moved] = await db.meetingParticipants.findMany({
      where: { meetingId: f.meetingId, userId: account.peer },
      select: { /** @external Prisma field */ id: true },
    });
    assert.ok(moved);
    const names = await db.memoryPersonNames.findMany({
      where: { personId, sourceId, participantUserId: f.peer },
      select: { /** @external Prisma field */ name: true },
    });
    assert.equal(names.length, 1);
  } finally {
    await f.cleanup();
    await account.cleanup();
  }
});

const publishInFlightExtraction = async ({
  scenario,
  hasHistory,
  fixture,
  guestUserId,
  guestPersonId,
  sourceIds,
  priorProjection,
}: {
  scenario: "empty" | "saved" | "forgotten";
  hasHistory: boolean;
  fixture: Awaited<ReturnType<typeof memoryFixture>>;
  guestUserId: string;
  guestPersonId: string;
  sourceIds: string[];
  priorProjection: Awaited<ReturnType<typeof readMemoryProjection>>;
}): Promise<void> => {
  const data = await fixture.enqueue();
  const job = required(data.job);
  const value = fixtureGeneration(required(data.input));
  const ids = [...sourceIds, required(data.source).id];
  if (scenario === "forgotten") {
    await db.relationshipMemories.updateMany({
      where: { sourceId: required(ids[0]) },
      data: { personIds: [required(value.people[0]).personId] },
    });
  }
  const storedMemories =
    scenario === "forgotten"
      ? await db.relationshipMemories.findMany({
          where: { sourceId: required(ids[0]) },
          select: {
            /** @external Prisma field */ id: true,
            /** @external Prisma field */ title: true,
            /** @external Prisma field */ description: true,
            /** @external Prisma field */ occurredAt: true,
          },
        })
      : [];
  const history =
    scenario === "forgotten"
      ? [
          {
            meetingId: fixture.meetingId,
            personId: required(value.people[0]).personId,
            name: "Personqh",
            language: "English",
            memories: storedMemories.map((memory) => ({
              id: memory.id,
              title: memory.title,
              description: memory.description,
              occurredAt: memory.occurredAt.toISOString(),
            })),
          },
        ]
      : [];
  await transferGuestMeetingAccessToUser({ guestUserId, targetUserId: fixture.peer });
  if (scenario === "forgotten") {
    await actOnMemories({
      sourceIds: ids,
      ids: [required(required(required(priorProjection).summary[0]).memoryIds[0])],
      action: "forget",
    });
  }
  await persistMemoryExtraction({
    job,
    source: required(data.source),
    candidates: value.memories,
    model: "fixture",
    generation: {
      value,
      history,
      sourceIds: ids,
      inputSources: [required(data.source)],
      language: "English",
    },
  });
  const projection = await readMemoryProjection({ personId: guestPersonId, sourceIds: ids });
  if (scenario === "forgotten") {
    // The generation is discarded, and the only saved line cited the forgotten memory, so nothing is left to show.
    assert.equal(projection, null, "changed generation inputs must not publish, and Forget removes the cited line");

    return;
  }
  assert.equal(required(required(projection).summary[0]).text, required(required(value.people[0]).summary[0]).text);
  assert.equal(required(projection).summary.length, hasHistory ? HISTORY_SUMMARY_COUNT : 1);
  if (priorProjection !== null) {
    assert.deepEqual(required(projection).summary[1], priorProjection.summary[0]);
  }
  assert.equal(await readMemoryProjection({ personId: required(value.people[0]).personId, sourceIds: ids }), null);
  const [memory] = await db.relationshipMemories.findMany({
    where: { sourceId: required(data.source).id },
    select: { /** @external Prisma field */ id: true, /** @external Prisma field */ personIds: true },
  });
  assert.deepEqual(required(memory).personIds, [guestPersonId]);
  assert.deepEqual(required(required(projection).summary[0]).memoryIds, [required(memory).id]);
  const [jobRow] = await db.memoryGenerationLedger.findMany({
    where: { jobId: job.id },
    select: { /** @external Prisma field */ completedAt: true },
  });
  assert.ok(required(jobRow).completedAt);
};

const assertInFlightExtraction = async (scenario: "empty" | "saved" | "forgotten"): Promise<void> => {
  const hasHistory = scenario !== "empty";
  const f = await memoryFixture();
  const past = await memoryFixture();
  const guest = randomUUID(),
    guestPerson = randomUUID();
  try {
    await db.users.create({
      data: {
        id: guest,
        email: `${guest}@test.example`,
        displayName: "Personqh",
        source: "guest",
      },
    });
    await db.memoryPeople.create({
      data: {
        id: guestPerson,
        userId: f.userId,
        workspaceId: f.workspaceId,
        name: "Personqh",
      },
    });
    await db.memoryPersonIdentities.create({
      data: {
        personId: guestPerson,
        userId: f.userId,
        workspaceId: f.workspaceId,
        kind: "user_id",
        identity: guest,
      },
    });
    const trackedSources = { ids: [] as string[] };
    const prior = { projection: null as Awaited<ReturnType<typeof readMemoryProjection>> };
    if (hasHistory) {
      const old = await past.enqueue();
      const oldJob = required(old.job);
      const oldValue = fixtureGeneration(required(old.input));
      await persistMemoryExtraction({
        job: oldJob,
        source: required(old.source),
        candidates: oldValue.memories,
        model: "fixture",
        generation: {
          value: oldValue,
          history: [],
          sourceIds: [required(old.source).id],
          inputSources: [required(old.source)],
          language: "English",
        },
      });
      await copyAttendance({ meetingId: past.meetingId, fromUserId: past.userId, toUserId: f.userId });
      await fileEndedAttendee({ meetingId: past.meetingId, userId: f.userId, workspaceId: f.workspaceId });
      await db.memorySources.updateMany({
        where: { id: required(old.source).id },
        data: { userId: f.userId, workspaceId: f.workspaceId },
      });
      await db.relationshipMemories.updateMany({
        where: { sourceId: required(old.source).id },
        data: { personIds: [guestPerson] },
      });
      const [oldMemory] = await db.relationshipMemories.findMany({
        where: { sourceId: required(old.source).id },
        select: { /** @external Prisma field */ id: true },
      });
      const memoryId = required(oldMemory).id;
      prior.projection = {
        summary: [{ text: PREVIOUSLY_SAVED_SUMMARY_TEXT, memoryIds: [memoryId] }],
        standing: [],
      };
      await saveMemoryProjection({
        personId: guestPerson,
        inputHash: "previous",
        projection: prior.projection,
        sourceRevisions: {
          [required(old.source).id]: required(old.source).revision,
        },
      });
      trackedSources.ids = [...trackedSources.ids, required(old.source).id];
    }
    await publishInFlightExtraction({
      scenario,
      hasHistory,
      fixture: f,
      guestUserId: guest,
      guestPersonId: guestPerson,
      sourceIds: trackedSources.ids,
      priorProjection: prior.projection,
    });
  } finally {
    await f.cleanup();
    await past.cleanup();
    await deleteUsers([guest]);
  }
};

(["empty", "saved", "forgotten"] as const).forEach((scenario) => {
  void test(`in-flight extraction publishes to the surviving person (${scenario})`, isolated, async () => {
    await assertInFlightExtraction(scenario);
  });
});

const linkLiveLookupGuests = async (input: {
  hasCookie: boolean;
  guests: string[];
  scope: { userId: string; workspaceId: string };
  peerId: string;
}): Promise<{ subjectIds: string[]; browserIds: string[] }> => {
  await db.users.createMany({
    data: input.guests.map((id) => ({
      id,
      email: `${id}@test.example`,
      displayName: "Personqh",
      source: "guest" as const,
    })),
  });
  const cookieToken = input.hasCookie
    ? (await recognizeGuest({ guestUserId: required(input.guests[0]), explicitOptIn: true })).token
    : undefined;
  const firstBrowserId = cookieToken === undefined ? undefined : required(await getGuestRecognition(cookieToken)).id;
  assert.deepEqual(await memoryPeopleForMeetingUsers({ scope: input.scope, userIds: input.guests }), []);
  await transferGuestMeetingAccessToUser({ guestUserId: required(input.guests[0]), targetUserId: input.peerId });
  const subjectIds = [required(input.guests[0])];
  if (cookieToken === undefined) {
    return { subjectIds, browserIds: [] };
  }
  await recognizeGuest({ guestUserId: required(input.guests[1]), token: cookieToken, explicitOptIn: false });
  const separate = await recognizeGuest({ guestUserId: required(input.guests[2]), explicitOptIn: true });

  return {
    subjectIds: [...subjectIds, required(input.guests[1])],
    browserIds: [required(firstBrowserId), required(await getGuestRecognition(separate.token)).id],
  };
};

[false, true].forEach((hasCookie) => {
  void test(
    `live lookup follows verified account links before guest extraction (cookie: ${hasCookie})`,
    isolated,
    async () => {
      const f = await memoryFixture();
      const other = await memoryFixture();
      const guests = [randomUUID(), randomUUID(), randomUUID()];
      const trackedBrowsers = { ids: [] as string[] };
      try {
        const data = await f.enqueue();
        const personId = required(required(data.input).people[0]).id;
        const linked = await linkLiveLookupGuests({
          hasCookie,
          guests,
          scope: f.scope,
          peerId: f.peer,
        });
        trackedBrowsers.ids = linked.browserIds;
        const trackedSubjects = { ids: linked.subjectIds };
        await trackedSubjects.ids.reduce(async (previous, userId) => {
          await previous;
          assert.deepEqual(await memoryPeopleForMeetingUsers({ scope: f.scope, userIds: [userId] }), [
            { userId, personId },
          ]);
        }, Promise.resolve());
        assert.deepEqual(
          await memoryPeopleForMeetingUsers({ scope: f.scope, userIds: [required(guests[2])] }),
          [],
          "same name and a separate browser never match",
        );
        assert.deepEqual(await memoryPeopleForMeetingUsers({ scope: other.scope, userIds: trackedSubjects.ids }), []);
        assert.deepEqual(
          await memoryPeopleForMeetingUsers({
            scope: { ...f.scope, workspaceId: other.workspaceId },
            userIds: trackedSubjects.ids,
          }),
          [],
        );
        const otherPerson = randomUUID();
        await db.memoryPeople.create({
          data: {
            id: otherPerson,
            userId: other.userId,
            workspaceId: other.workspaceId,
            name: "Personqg",
          },
        });
        await db.memoryPersonIdentities.create({
          data: {
            personId: otherPerson,
            userId: other.userId,
            workspaceId: other.workspaceId,
            kind: "user_id",
            identity: f.peer,
          },
        });
        await trackedSubjects.ids.reduce(async (previous, userId) => {
          await previous;
          assert.deepEqual(await memoryPeopleForMeetingUsers({ scope: other.scope, userIds: [userId] }), [
            { userId, personId: otherPerson },
          ]);
        }, Promise.resolve());
        const browserIdentityCount =
          trackedBrowsers.ids.length === 0
            ? 0
            : await counted(
                db.memoryPersonIdentities.count({
                  where: { kind: "guest_browser", identity: { in: trackedBrowsers.ids } },
                }),
              );
        assert.equal(browserIdentityCount, 0, "lookup does not depend on extraction creating browser identities");
        assert.equal(
          await counted(db.meetingParticipants.count({ where: { userId: { in: guests } } })),
          0,
          "recognition never grants meeting access",
        );
      } finally {
        await deleteBrowsers(trackedBrowsers.ids);
        await f.cleanup();
        await other.cleanup();
        await deleteUsers(guests);
      }
    },
  );
});
