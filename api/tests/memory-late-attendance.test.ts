import { closeDbPool, consumeMemoryGeneration, db, listMemoryMeetingAttendees } from "@readymeet/db";
import { memoryFixture } from "@readymeet/db/testing/memory";
import assert from "node:assert/strict";
import { after, test } from "node:test";

after(closeDbPool);
(["attendance-first", "binding-first"] as const).forEach((order) => {
  void test(`late ${order} is discovered on the next request without a second allowance`, async () => {
    const f = await memoryFixture();
    try {
      const removedIntervals = await db.meetingAttendanceIntervals.findMany({
        where: { meetingId: f.meetingId, userId: f.userId },
      });
      await db.meetingAttendanceIntervals.deleteMany({
        where: { meetingId: f.meetingId, userId: f.userId },
      });
      const removedBindings = await db.meetingAttendeeWorkspaces.findMany({
        where: { meetingId: f.meetingId, userId: f.userId },
      });
      await db.meetingAttendeeWorkspaces.deleteMany({
        where: { meetingId: f.meetingId, userId: f.userId },
      });
      const interval = removedIntervals[0];
      const binding = removedBindings[0];
      assert.ok(interval);
      assert.ok(binding);
      const addAttendance = () =>
        db.meetingAttendanceIntervals.create({
          data: {
            id: interval.id,
            meetingId: interval.meetingId,
            userId: interval.userId,
            joinedAt: interval.joinedAt,
            leftAt: interval.leftAt,
          },
        });
      const addBinding = () =>
        db.meetingAttendeeWorkspaces.create({
          data: {
            meetingId: binding.meetingId,
            userId: binding.userId,
            workspaceId: binding.workspaceId,
            assignment: binding.assignment,
            createdAt: binding.createdAt,
          },
        });
      assert.equal(
        (await listMemoryMeetingAttendees(f.meetingId)).some((s) => s.userId === f.userId),
        false,
      );
      await (order === "attendance-first" ? addAttendance() : addBinding());
      assert.equal(
        (await listMemoryMeetingAttendees(f.meetingId)).some((s) => s.userId === f.userId),
        false,
      );
      await (order === "attendance-first" ? addBinding() : addAttendance());
      assert.equal(
        (await listMemoryMeetingAttendees(f.meetingId)).some((s) => s.userId === f.userId),
        true,
      );
      const { job } = await f.enqueue();
      assert.ok(job);
      await consumeMemoryGeneration({
        jobId: job.id,
        leaseToken: job.leaseToken,
        ownerUserId: f.userId,
        meetingId: f.meetingId,
      });
      assert.equal((await f.enqueue()).job, null);
      const rows = await db.memoryGenerationLedger.findMany({
        where: { meetingId: f.meetingId },
      });
      assert.equal(rows.length, 1);
    } finally {
      await f.cleanup();
    }
  });
});
void test("late attendance does not expose pre-cutoff history", async () => {
  const f = await memoryFixture({ endedAt: "2000-01-01T12:00:00Z" });
  try {
    assert.deepEqual(await listMemoryMeetingAttendees(f.meetingId), []);
  } finally {
    await f.cleanup();
  }
});
