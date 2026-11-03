import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import { persistMemoryExtraction } from "../adapters/secondary/postgres/relationship-memory";

import { fixtureGeneration, memoryFixture } from "./memory-fixture";

const MISSING_REQUIRED_VALUE = "Expected a value.";
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error(MISSING_REQUIRED_VALUE);
  }

  return value;
};

after(closeDbPool);
void test(
  "a saved extraction keeps memories, summary content, and a completed job",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const f = await memoryFixture();
    try {
      const { source, input, job: requestJob } = await f.enqueue();
      const savedSource = required(source);
      const prepared = required(input);
      const job = required(requestJob);
      const value = fixtureGeneration(prepared);
      const person = required(prepared.people[0]);
      await persistMemoryExtraction({
        job,
        source: savedSource,
        candidates: value.memories,
        model: "fixture",
        generation: {
          value,
          history: [],
          sourceIds: [savedSource.id],
          inputSources: [savedSource],
          language: "English",
        },
      });
      const memories = await db.relationshipMemories.findMany({
        where: { sourceId: savedSource.id },
        select: { /** @external Prisma field */ id: true, /** @external Prisma field */ title: true },
      });
      assert.equal(memories.length !== 0, true);
      const [projection] = await db.memoryPersonProjections.findMany({
        where: { personId: person.id },
        select: { /** @external Prisma field */ content: true, /** @external Prisma field */ sourceRevisions: true },
      });
      assert.ok(projection);
      assert.equal(Boolean(projection.content), true);
      assert.deepEqual(projection.sourceRevisions, { [savedSource.id]: savedSource.revision });
      const [completed] = await db.memoryGenerationLedger.findMany({
        where: { jobId: job.id },
        select: { /** @external Prisma field */ completedAt: true },
      });
      assert.ok(completed?.completedAt);
      const ledger = await db.memoryGenerationLedger.findMany({
        where: { userId: f.userId, meetingId: f.meetingId },
        select: { /** @external Prisma field */ jobId: true },
      });
      assert.equal(ledger.length, 1);
    } finally {
      await f.cleanup();
    }
  },
);
