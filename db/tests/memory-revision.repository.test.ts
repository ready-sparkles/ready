import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import { consumeMemoryGeneration } from "../adapters/secondary/postgres/memory-events";
import { revisionsByMeeting } from "../adapters/secondary/postgres/memory-transcript-revision";
import { listEligibleMemoryMeetings } from "../adapters/secondary/postgres/relationship-memory";

import { memoryFixture } from "./memory-fixture";

const CONTENT = 'A "quoted" proposal.\nC:\\notes — café';
const TIMESTAMPS = [
  ["2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00+00:00"],
  ["2026-10-15T12:00:00.100Z", "2026-10-15T12:00:00.1+00:00"],
  ["2026-10-15T12:00:00.120Z", "2026-10-15T12:00:00.12+00:00"],
  ["2026-10-15T12:00:00.123Z", "2026-10-15T12:00:00.123+00:00"],
  ["2026-10-15T12:00:00.123456Z", "2026-10-15T12:00:00.123456+00:00"],
] as const;

after(closeDbPool);

TIMESTAMPS.forEach(([timestamp, postgresJsonTimestamp]) => {
  void test(
    `memory revision preserves the PostgreSQL JSON timestamp ${postgresJsonTimestamp}`,
    {
      skip: process.env.MEMORY_ISOLATED_DB !== "1",
    },
    async () => {
      const fixture = await memoryFixture();
      try {
        const startedAt = new Date(timestamp);
        // Preserve a database timestamp more precise than Date in this fixture write.
        startedAt.toISOString = () => timestamp;
        await db.transcriptSegments.updateMany({
          where: { id: fixture.segmentId },
          data: {
            startedAt,
            content: CONTENT,
          },
        });
        // PostgreSQL jsonb_build_array(..., started_at)::text used this representation.
        const payload = `[${[fixture.segmentId, fixture.peer, "Peer", "human", CONTENT, postgresJsonTimestamp]
          .map((value) => JSON.stringify(value))
          .join(", ")}]`;
        const legacyRevision = createHash("md5").update(payload).digest("hex");
        const [meeting] = await listEligibleMemoryMeetings({ scope: fixture.scope, meetingId: fixture.meetingId });
        assert.equal(meeting?.revision, legacyRevision);
        const { job } = await fixture.enqueue();
        assert.ok(job);
        await consumeMemoryGeneration({
          jobId: job.id,
          leaseToken: job.leaseToken,
          ownerUserId: fixture.userId,
          meetingId: fixture.meetingId,
        });
        await db.transcriptSegments.updateMany({
          where: { id: fixture.segmentId },
          data: { content: "Changed transcript" },
        });
        const [changed] = await listEligibleMemoryMeetings({ scope: fixture.scope, meetingId: fixture.meetingId });
        assert.notEqual(changed?.revision, legacyRevision);
      } finally {
        await fixture.cleanup();
      }
    },
  );
});

void test(
  "rollout compatibility preserves the old millisecond ordering without changing new fingerprints",
  {
    skip: process.env.MEMORY_ISOLATED_DB !== "1",
  },
  async () => {
    const f = await memoryFixture();
    try {
      const otherId = randomUUID();
      const ids = [f.segmentId, otherId].sort();
      const times = ["2026-10-15T12:00:00.123456Z", "2026-10-15T12:00:00.123123Z"];
      await Promise.all(
        ids.map(async (id, index) => {
          const timestamp = times[index];
          assert.ok(timestamp !== undefined);
          const startedAt = new Date(timestamp);
          startedAt.toISOString = () => timestamp;
          if (id === f.segmentId) {
            await db.transcriptSegments.updateMany({ where: { id }, data: { startedAt, content: CONTENT } });
          } else {
            await db.transcriptSegments.create({
              data: {
                id,
                transcriptId: f.transcriptId,
                speakerIdentity: f.peer,
                speakerUserId: f.peer,
                speakerName: "Peer",
                content: CONTENT,
                startedAt,
              },
            });
          }
        }),
      );
      const previousPayload = ids
        .map(
          (id) =>
            `[${[id, f.peer, "Peer", "human", CONTENT, "2026-10-15 12:00:00.123+00"]
              .map((value) => JSON.stringify(value))
              .join(", ")}]`,
        )
        .join("");
      const revision = createHash("md5").update(previousPayload).digest("hex");
      const current = await revisionsByMeeting({ meetingIds: [f.meetingId], sources: [] });
      assert.notEqual(current.get(f.meetingId), revision);
      const compatible = await revisionsByMeeting({
        meetingIds: [f.meetingId],
        sources: [{ meetingId: f.meetingId, revision }],
      });
      assert.equal(compatible.get(f.meetingId), revision);
      const unknown = await revisionsByMeeting({
        meetingIds: [f.meetingId],
        sources: [{ meetingId: f.meetingId, revision: "unrecognized" }],
      });
      assert.equal(unknown.get(f.meetingId), current.get(f.meetingId));
    } finally {
      await f.cleanup();
    }
  },
);
