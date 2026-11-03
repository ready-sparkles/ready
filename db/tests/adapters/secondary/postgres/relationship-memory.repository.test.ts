import { FREE_PLAN_INCLUDED_NOTES_MEETINGS } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import {
  hasMemoryNotesEntitlement,
  listAccessibleMemorySources,
  listMemoryPeople,
  listRelationshipMemories,
  persistMemoryExtraction,
} from "../../../../adapters/secondary/postgres/relationship-memory";
import { createMeeting, upsertUser } from "../../../../adapters/secondary/postgres/repositories";
import { fixtureGeneration, memoryFixture } from "../../../memory-fixture";

const HISTORICAL_TRIAL_CREDITS = 200;

const MISSING_REQUIRED_VALUE = "Expected a value.";
const HIGH_IMPORTANCE_LEVEL = 4;
const EVIDENCE_LAG_MINUTES = 20;
const SEGMENT_OFFSET_MINUTES = 10;
const MILLISECONDS_PER_MINUTE = 60_000;

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error(MISSING_REQUIRED_VALUE);
  }

  return value;
};

after(closeDbPool);
void test(
  "saved memories retain search, category filters, personal scope and source invalidation",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const f = await memoryFixture({ external: true });
    try {
      const enqueued = await f.enqueue();
      const source = required(enqueued.source);
      const input = required(enqueued.input);
      const job = required(enqueued.job);
      const value = fixtureGeneration(input);
      await persistMemoryExtraction({
        job,
        source,
        candidates: value.memories,
        model: "fixture",
        generation: {
          value,
          history: [],
          sourceIds: [source.id],
          inputSources: [source],
          language: "English",
        },
      });
      assert.equal((await listRelationshipMemories({ sourceIds: [source.id], filters: { q: "proposal" } })).length, 1);
      assert.equal(
        (await listRelationshipMemories({ sourceIds: [source.id], filters: { category: "Sales" } })).length,
        1,
      );
      assert.equal(
        (
          await listRelationshipMemories({
            sourceIds: [source.id],
            filters: {
              category: "Sales",
              categoryOperator: "is_not",
            },
          })
        ).length,
        0,
      );
      assert.deepEqual(await listRelationshipMemories({ sourceIds: [] }), []);
      assert.deepEqual(await listAccessibleMemorySources({ userId: f.peer, workspaceId: f.workspaceId }), []);
      assert.equal((await listMemoryPeople({ scope: f.scope, sourceIds: [source.id] })).length, 1);
      await db.relationshipMemories.updateMany({
        where: { sourceId: source.id },
        data: { category: "Customer Success" },
      });
      assert.equal(
        (await listRelationshipMemories({ sourceIds: [source.id], filters: { category: "Customers" } })).length,
        1,
      );
      await db.transcriptSegments.updateMany({ where: { id: f.segmentId }, data: { content: "A correction." } });
      assert.deepEqual(await listRelationshipMemories({ sourceIds: [source.id] }), []);
    } finally {
      await f.cleanup();
    }
  },
);

void test(
  "evidence timestamps use the latest cited passage without changing rank or pagination",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const f = await memoryFixture();
    try {
      const [original] = await db.transcriptSegments.findMany({
        where: { id: f.segmentId },
        select: { /** @external Prisma field */ startedAt: true },
      });
      const startedAt = required(original).startedAt;
      const segmentIds = [randomUUID(), randomUUID(), randomUUID()];
      await db.transcriptSegments.createMany({
        data: segmentIds.map((id, index) => ({
          id,
          transcriptId: f.transcriptId,
          speakerIdentity: f.peer,
          speakerUserId: f.peer,
          speakerName: "Peer",
          content: "A later clarification.",
          startedAt: new Date(startedAt.getTime() + (index + 1) * SEGMENT_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE),
        })),
      });
      const enqueued = await f.enqueue();
      const source = required(enqueued.source);
      const input = required(enqueued.input);
      const job = required(enqueued.job);
      const value = fixtureGeneration(input);
      const base = required(value.memories[0]);
      const laterSegmentId = required(segmentIds[1]);
      const earlierSegmentId = required(segmentIds[0]);
      const candidates = [
        { ...base, title: "Important early memory", importance: HIGH_IMPORTANCE_LEVEL },
        {
          ...base,
          title: "Later combined memory",
          importance: 1 as const,
          factIdentity: { ...base.factIdentity, object: "clarification" },
          // Deliberately unordered: max timestamp, not last array entry or meeting end.
          evidence: [laterSegmentId, f.segmentId, earlierSegmentId].map((segmentId) => {
            const segment = input.segments.find((item) => item.id === segmentId);
            if (!segment) {
              throw new Error(MISSING_REQUIRED_VALUE);
            }

            return {
              segmentId,
              quote: segment.content,
            };
          }),
        },
      ];
      await persistMemoryExtraction({ job, source, candidates, model: "fixture" });
      const saved = await listRelationshipMemories({ sourceIds: [source.id] });
      const earliestSaved = required(saved[0]);
      const laterSaved = required(saved[1]);
      assert.deepEqual(
        saved.map((memory) => memory.title),
        candidates.map((memory) => memory.title),
      );
      assert.ok(saved.every((memory) => memory.occurredAt === source.occurredAt));
      assert.equal(Date.parse(required(earliestSaved.evidenceOccurredAt)), startedAt.getTime());
      assert.equal(
        Date.parse(required(laterSaved.evidenceOccurredAt)),
        startedAt.getTime() + EVIDENCE_LAG_MINUTES * MILLISECONDS_PER_MINUTE,
      );
      const page = await listRelationshipMemories({ sourceIds: [source.id], filters: { limit: 1 } });
      const pageItem = required(page[0]);
      const next = await listRelationshipMemories({
        sourceIds: [source.id],
        filters: {
          beforePosition: {
            id: pageItem.id,
            occurredAt: pageItem.occurredAt,
            importance: required(pageItem.importance),
          },
          limit: 1,
        },
      });
      assert.equal(required(next[0]).id, laterSaved.id);
    } finally {
      await f.cleanup();
    }
  },
);

void test("free meeting memory uses the three-meeting gate, not retired trial credits", async () => {
  const user = await upsertUser({ email: `${randomUUID()}@memory-billing.test`, displayName: "Free memory" });
  const meeting = await createMeeting({ title: "Free meeting", roomName: randomUUID(), createdByUserId: user.id });
  const input = { userId: user.id, meetingId: meeting.id };
  assert.equal(await hasMemoryNotesEntitlement(input), true);
  await db.aiCreditUsageEvents.create({
    data: {
      userId: user.id,
      workspaceId: user.workspaceId,
      actionType: "meeting_prep",
      actionLabel: "Historical trial usage",
      creditsCharged: HISTORICAL_TRIAL_CREDITS,
    },
  });
  assert.equal(await hasMemoryNotesEntitlement(input), true);
  await db.meetingTrialSlots.createMany({
    data: Array.from({ length: FREE_PLAN_INCLUDED_NOTES_MEETINGS }, (_, index) => ({
      userId: user.id,
      workspaceId: user.workspaceId,
      meetingId: null,
      slot: index + 1,
    })),
  });
  assert.equal(await hasMemoryNotesEntitlement(input), false);
});
