import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";

after(closeDbPool);

const POSTGRES_FOREIGN_KEY_VIOLATION_CODE = "23503";
const ISOLATION_MEETING_COUNT = 2;

const hasPostgresCode = (input: { error: unknown; code: string }): boolean => {
  if (typeof input.error !== "object" || input.error === null) {
    return false;
  }
  if ("code" in input.error && input.error.code === input.code) {
    return true;
  }
  if ("originalCode" in input.error && input.error.originalCode === input.code) {
    return true;
  }
  if ("cause" in input.error && hasPostgresCode({ error: input.error.cause, code: input.code })) {
    return true;
  }
  if (
    "meta" in input.error &&
    typeof input.error.meta === "object" &&
    input.error.meta !== null &&
    "driverAdapterError" in input.error.meta
  ) {
    return hasPostgresCode({ error: input.error.meta.driverAdapterError, code: input.code });
  }

  return false;
};

type IsolationFixture = {
  owner: string;
  workspaceA: string;
  workspaceB: string;
  meetingA: string;
  meetingB: string;
  sourceA: string;
  personA: string;
  now: Date;
};

const seedIsolationMeetings = async (input: IsolationFixture): Promise<void> => {
  await db.users.create({
    data: {
      id: input.owner,
      email: `${input.owner}@isolation.test`,
      displayName: "Isolation fixture",
    },
  });
  await db.workspaces.createMany({
    data: [
      { id: input.workspaceA, name: "A", createdByUserId: input.owner },
      { id: input.workspaceB, name: "B", createdByUserId: input.owner },
    ],
  });
  await db.memoryPreferences.createMany({
    data: [
      { userId: input.owner, workspaceId: input.workspaceA },
      { userId: input.owner, workspaceId: input.workspaceB },
    ],
  });
  await db.meetings.createMany({
    data: [
      {
        id: input.meetingA,
        title: "A",
        roomName: input.meetingA,
        workspaceId: input.workspaceA,
        createdByUserId: input.owner,
      },
      {
        id: input.meetingB,
        title: "B",
        roomName: input.meetingB,
        workspaceId: input.workspaceB,
        createdByUserId: input.owner,
      },
    ],
  });
};

const seedIsolationMemory = async (input: IsolationFixture): Promise<void> => {
  await db.memorySources.create({
    data: {
      id: input.sourceA,
      userId: input.owner,
      workspaceId: input.workspaceA,
      kind: "meeting_transcript",
      externalId: input.meetingA,
      meetingId: input.meetingA,
      occurredAt: input.now,
      revision: "revision",
      isCurrent: true,
    },
  });
  await db.memoryPeople.create({
    data: {
      id: input.personA,
      userId: input.owner,
      workspaceId: input.workspaceA,
      name: "Peer",
    },
  });
  await db.memoryPersonIdentities.create({
    data: {
      personId: input.personA,
      userId: input.owner,
      workspaceId: input.workspaceA,
      kind: "user_id",
      identity: input.personA,
    },
  });
  await db.memoryPersonProjections.create({
    data: {
      personId: input.personA,
      inputHash: "saved",
      content: { summary: [], standing: [] },
      promptVersion: "1.2.0",
    },
  });
  await db.memoryInteractions.create({
    data: {
      sourceId: input.sourceA,
      personId: input.personA,
      occurredAt: input.now,
    },
  });
  await db.relationshipMemories.create({
    data: {
      sourceId: input.sourceA,
      fingerprint: input.personA,
      title: "Saved",
      description: "Saved",
      category: "General",
      personIds: [input.personA],
      /** @external column */
      sensitive: false,
      confidence: "high",
      occurredAt: input.now,
      factFingerprint: input.personA,
      factIdentity: {},
    },
  });
  await db.memorySuppressions.create({
    data: {
      sourceId: input.sourceA,
      factFingerprint: "keep",
      factIdentity: {},
    },
  });
};

const seedWorkspaceIsolationFixture = async (input: IsolationFixture): Promise<void> => {
  await seedIsolationMeetings(input);
  await seedIsolationMemory(input);
};

void test(
  "a memory source must stay in the meeting workspace",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const owner = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const meetingA = randomUUID();
    const meetingB = randomUUID();
    const sourceA = randomUUID();
    const personA = randomUUID();
    const now = new Date();
    try {
      await seedWorkspaceIsolationFixture({
        owner,
        workspaceA,
        workspaceB,
        meetingA,
        meetingB,
        sourceA,
        personA,
        now,
      });

      const savedSources = await db.memorySources.findMany({
        where: { id: sourceA },
        select: { /** @external Prisma field */ id: true },
      });
      const savedMeetings = await db.meetings.findMany({
        where: { id: { in: [meetingA, meetingB] } },
        select: { /** @external Prisma field */ id: true },
      });
      const savedMemories = await db.relationshipMemories.findMany({
        where: { sourceId: sourceA },
        select: { /** @external Prisma field */ id: true },
      });
      assert.equal(savedSources.length, 1);
      assert.equal(savedMeetings.length, ISOLATION_MEETING_COUNT);
      assert.equal(savedMemories.length, 1);

      await assert.rejects(
        () =>
          db.memorySources.create({
            data: {
              userId: owner,
              workspaceId: workspaceB,
              kind: "meeting_transcript",
              externalId: meetingA,
              meetingId: meetingA,
              occurredAt: now,
              revision: "revision",
            },
          }),
        (error: unknown) => hasPostgresCode({ error, code: POSTGRES_FOREIGN_KEY_VIOLATION_CODE }),
      );

      const stillSaved = await db.memorySources.findMany({
        where: { userId: owner, workspaceId: workspaceA },
        select: { /** @external Prisma field */ id: true },
      });
      assert.equal(stillSaved.length, 1);
    } finally {
      await db.meetings.deleteMany({ where: { id: { in: [meetingA, meetingB] } } });
      await db.workspaces.deleteMany({ where: { id: { in: [workspaceA, workspaceB] } } });
      await db.users.deleteMany({ where: { id: owner } });
    }
  },
);
