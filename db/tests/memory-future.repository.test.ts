import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db, pool } from "../adapters/secondary/postgres/client";
import { consumeMemoryGeneration, listMemoryMeetingAttendees } from "../adapters/secondary/postgres/memory-events";
import {
  actOnMemories,
  finishMemoryJob,
  listRelationshipMemories,
  persistMemoryExtraction,
  readMemoryProjection,
} from "../adapters/secondary/postgres/relationship-memory";
import { MemoryBusyError, MemoryNotFoundError } from "../domain/persistence-errors";

import { fixtureGeneration, memoryFixture } from "./memory-fixture";

const FIXTURE_FAILURE_MESSAGE = "fixture failure";
const EXPECTED_TEST_COUNT_2 = 2;
const INVALID_EVIDENCE_MESSAGE = "invalid evidence";
const KEPT_SUMMARY_TEXT = "Prefers asynchronous status updates.";
// Forget sets lock_timeout to 5s, well inside Prisma's 20s transaction timeout.
const FORGET_BUSY_MAX_MS = 10_000;

const options = { /** @external node:test skip option */ skip: process.env.MEMORY_ISOLATED_DB !== "1" };
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "Expected fixture value");

  return value;
}
after(closeDbPool);
void test("meetings before the cutoff do not start generation", options, async () => {
  const f = await memoryFixture({ endedAt: "2000-01-01T12:00:00Z" });
  try {
    assert.equal((await f.enqueue()).job, null);
    assert.deepEqual(await listMemoryMeetingAttendees(f.meetingId), []);
  } finally {
    await f.cleanup();
  }
});
void test("concurrent requests consume one per-attendee model allowance", options, async () => {
  const f = await memoryFixture({ external: true });
  try {
    const requests = await Promise.all([f.enqueue(), f.enqueue(), f.enqueue()]);
    assert.equal(requests.filter((r) => r.job !== null).length, 1);
    const generation = required(requests.find((r) => r.job !== null));
    const job = required(generation.job);
    const auth = { jobId: job.id, leaseToken: job.leaseToken, ownerUserId: f.userId, meetingId: f.meetingId };
    await assert.rejects(consumeMemoryGeneration({ ...auth, ownerUserId: f.peer }));
    await assert.rejects(consumeMemoryGeneration({ ...auth, leaseToken: randomUUID() }));
    const attempts = await Promise.allSettled([
      consumeMemoryGeneration(auth),
      consumeMemoryGeneration(auth),
      consumeMemoryGeneration(auth),
    ]);
    assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
    const source = required(generation.source);
    const input = required(generation.input);
    const value = fixtureGeneration(input);
    await persistMemoryExtraction({
      job,
      source,
      candidates: value.memories,
      model: "fixture",
      generation: { value, history: [], sourceIds: [source.id], inputSources: [source], language: "English" },
    });
    await assert.rejects(persistMemoryExtraction({ job, source, candidates: value.memories, model: "fixture" }));
    assert.equal((await f.enqueue()).job, null);
    await db.memorySources.deleteMany({ where: { id: source.id } });
    assert.equal((await f.enqueue()).job, null, "deleting output never restores the paid model allowance");
  } finally {
    await f.cleanup();
  }
});
[false, true].forEach((isDispatched) => {
  void test(`request failure preserves the model allowance (dispatched: ${isDispatched})`, options, async () => {
    const f = await memoryFixture();
    try {
      const job = required((await f.enqueue()).job);
      if (isDispatched) {
        await consumeMemoryGeneration({
          jobId: job.id,
          leaseToken: job.leaseToken,
          ownerUserId: f.userId,
          meetingId: f.meetingId,
        });
      }
      await finishMemoryJob({ job, error: new Error(FIXTURE_FAILURE_MESSAGE) });
      assert.equal((await f.enqueue()).job, null);
      const [row] = await db.memoryGenerationLedger.findMany({ where: { jobId: job.id } });
      assert.ok(row?.completedAt);
      assert.ok(typeof row.error === "string" && row.error !== "");
    } finally {
      await f.cleanup();
    }
  });
});
void test(
  "Forget removes summary lines that cite the memory, and access and transcript deletion hide it",
  options,
  async () => {
    const f = await memoryFixture();
    try {
      const generation = await f.enqueue();
      const job = required(generation.job),
        source = required(generation.source),
        input = required(generation.input);
      const value = fixtureGeneration(input);
      await persistMemoryExtraction({
        job,
        source,
        candidates: value.memories,
        model: "fixture",
        generation: { value, history: [], sourceIds: [source.id], inputSources: [source], language: "English" },
      });
      const personId = required(input.people[0]).id;
      const summary = await readMemoryProjection({ personId, sourceIds: [source.id] });
      assert.ok(summary !== null && summary.summary.length !== 0);
      assert.equal(await readMemoryProjection({ personId, sourceIds: [] }), null);
      const memories = await listRelationshipMemories({ sourceIds: [source.id] });
      const forgottenId = required(memories[0]).id;
      await assert.rejects(actOnMemories({ sourceIds: [], ids: [forgottenId], action: "forget" }));
      await actOnMemories({ sourceIds: [source.id], ids: [forgottenId], action: "forget" });
      assert.deepEqual(await listRelationshipMemories({ sourceIds: [source.id] }), []);
      assert.equal(await readMemoryProjection({ personId, sourceIds: [source.id] }), null);
      const [stored] = await db.memoryPersonProjections.findMany({
        where: { personId },
        select: { /** @external Prisma field */ content: true },
      });
      assert.ok(stored !== undefined, "Forget keeps the projection row and its provenance");
      assert.ok(!JSON.stringify(stored.content).includes(forgottenId), "the saved summary no longer cites the memory");
      await db.transcripts.deleteMany({ where: { id: f.transcriptId } });
      assert.equal(await readMemoryProjection({ personId, sourceIds: [source.id] }), null);
    } finally {
      await f.cleanup();
    }
  },
);
void test("Forget keeps summary lines backed only by memories that remain", options, async () => {
  const f = await memoryFixture();
  try {
    const generation = await f.enqueue();
    const job = required(generation.job),
      source = required(generation.source),
      input = required(generation.input);
    const value = fixtureGeneration(input);
    const original = required(value.memories[0]);
    const extra = {
      ...original,
      ref: "N2",
      title: "Your peer prefers asynchronous status updates",
      description: "They prefer asynchronous Slack status updates.",
      factIdentity: { ...original.factIdentity, predicate: "prefers", object: "asynchronous status updates" },
    };
    const people = value.people.map((person) => ({
      ...person,
      summary: [...person.summary, { text: KEPT_SUMMARY_TEXT, memoryRefs: ["N2"] }],
    }));
    const extended = { ...value, memories: [original, extra], people };
    await persistMemoryExtraction({
      job,
      source,
      candidates: extended.memories,
      model: "fixture",
      generation: {
        value: extended,
        history: [],
        sourceIds: [source.id],
        inputSources: [source],
        language: "English",
      },
    });
    const personId = required(input.people[0]).id;
    const before = required(await readMemoryProjection({ personId, sourceIds: [source.id] }));
    assert.equal(before.summary.length, EXPECTED_TEST_COUNT_2);
    const memories = await listRelationshipMemories({ sourceIds: [source.id] });
    const forgotten = required(memories.find((memory) => memory.title === original.title));
    const kept = required(memories.find((memory) => memory.title === extra.title));
    await actOnMemories({ sourceIds: [source.id], ids: [forgotten.id], action: "forget" });
    const after = required(await readMemoryProjection({ personId, sourceIds: [source.id] }));
    assert.deepEqual(after.summary, [{ text: KEPT_SUMMARY_TEXT, memoryIds: [kept.id] }]);
  } finally {
    await f.cleanup();
  }
});
void test("Reading a summary hides lines whose cited memory is gone", options, async () => {
  const f = await memoryFixture();
  try {
    const generation = await f.enqueue();
    const job = required(generation.job),
      source = required(generation.source),
      input = required(generation.input);
    const value = fixtureGeneration(input);
    await persistMemoryExtraction({
      job,
      source,
      candidates: value.memories,
      model: "fixture",
      generation: { value, history: [], sourceIds: [source.id], inputSources: [source], language: "English" },
    });
    const personId = required(input.people[0]).id;
    assert.ok((await readMemoryProjection({ personId, sourceIds: [source.id] })) !== null);
    // Simulate a summary written before Forget pruned projections: the memory row is gone, the saved line is not.
    await db.relationshipMemories.deleteMany({ where: { sourceId: source.id } });
    assert.equal(await readMemoryProjection({ personId, sourceIds: [source.id] }), null);
  } finally {
    await f.cleanup();
  }
});
void test("zero memories is a completed result and attendee allowances are separate", options, async () => {
  const f = await memoryFixture();
  try {
    const generation = await f.enqueue();
    const job = required(generation.job),
      source = required(generation.source);
    await persistMemoryExtraction({ job, source, candidates: [], model: "fixture" });
    assert.equal((await f.enqueue()).job, null);
    const attendees = await listMemoryMeetingAttendees(f.meetingId);
    assert.equal(attendees.length, EXPECTED_TEST_COUNT_2);
    assert.ok(attendees.some((a) => a.userId === f.peer));
  } finally {
    await f.cleanup();
  }
});
void test("invalid evidence does not publish or restore a consumed allowance", options, async () => {
  const f = await memoryFixture();
  try {
    const generation = await f.enqueue();
    const job = required(generation.job),
      source = required(generation.source),
      input = required(generation.input);
    await consumeMemoryGeneration({
      jobId: job.id,
      leaseToken: job.leaseToken,
      ownerUserId: f.userId,
      meetingId: f.meetingId,
    });
    const value = fixtureGeneration(input);
    required(required(value.memories[0]).evidence[0]).segmentId = randomUUID();
    await assert.rejects(persistMemoryExtraction({ job, source, candidates: value.memories, model: "fixture" }));
    await finishMemoryJob({ job, error: new Error(INVALID_EVIDENCE_MESSAGE) });
    assert.deepEqual(await listRelationshipMemories({ sourceIds: [source.id] }), []);
    assert.equal((await f.enqueue()).job, null);
  } finally {
    await f.cleanup();
  }
});
void test(
  "Forget answers a locked summary row with a fast retryable MemoryBusyError, and only a missing memory is not found",
  options,
  async () => {
    const f = await memoryFixture();
    const locker = await pool.connect();
    try {
      const generation = await f.enqueue();
      const job = required(generation.job),
        source = required(generation.source),
        input = required(generation.input);
      const value = fixtureGeneration(input);
      await persistMemoryExtraction({
        job,
        source,
        candidates: value.memories,
        model: "fixture",
        generation: { value, history: [], sourceIds: [source.id], inputSources: [source], language: "English" },
      });
      const personId = required(input.people[0]).id;
      const memoryId = required((await listRelationshipMemories({ sourceIds: [source.id] }))[0]).id;

      await assert.rejects(
        actOnMemories({ sourceIds: [source.id], ids: [randomUUID()], action: "forget" }),
        MemoryNotFoundError,
      );

      // A concurrent meeting is saving this person's summary and holds the row.
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM memory_person_projections WHERE person_id = $1 FOR UPDATE", [personId]);
      const startedAt = Date.now();
      await assert.rejects(
        actOnMemories({ sourceIds: [source.id], ids: [memoryId], action: "forget" }),
        MemoryBusyError,
      );
      assert.ok(Date.now() - startedAt < FORGET_BUSY_MAX_MS, "Forget gives up before the transaction timeout");
      assert.equal((await listRelationshipMemories({ sourceIds: [source.id] })).length, value.memories.length);
      await locker.query("ROLLBACK");

      // The same request succeeds once the lock is gone.
      await actOnMemories({ sourceIds: [source.id], ids: [memoryId], action: "forget" });
      assert.equal(
        (await listRelationshipMemories({ sourceIds: [source.id] })).some((memory) => memory.id === memoryId),
        false,
      );
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      await f.cleanup();
    }
  },
);
