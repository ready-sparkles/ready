import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  failMeetingTracker,
  finishMeetingTracker,
  loadMeetingTrackerInput,
  readMeetingTracker,
} from "../adapters/secondary/postgres/meeting-tracker";
import { appendTranscriptSegment, createMeeting, upsertUser } from "../adapters/secondary/postgres/repositories";
import { configureRealtimePublisher } from "../ports/realtime";

const fixtureMeetings: { ids: string[] } = { ids: [] };
configureRealtimePublisher(async () => undefined);
afterEach(async () => {
  if (fixtureMeetings.ids.length !== 0) {
    await db.meetings.deleteMany({ where: { id: { in: fixtureMeetings.ids } } });
  }
});
after(closeDbPool);
async function fixture() {
  const user = await upsertUser({ email: `${randomUUID()}@tracker.readymeet.test`, displayName: "Tracker tester" });
  const meeting = await createMeeting({
    title: "Tracker test",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  fixtureMeetings.ids = [...fixtureMeetings.ids, meeting.id];

  return meeting;
}
async function append({ meetingId, content }: { meetingId: string; content: string }) {
  return appendTranscriptSegment({
    meetingId,
    content,
    speakerRole: "human",
    source: "livekit-python-live",
    sourceSegmentId: randomUUID(),
    speakerIdentity: "personbr",
    speakerName: "Personbr",
    startedAt: new Date(),
  });
}

void test("requests retain late speech without accepting stale snapshot writes", async () => {
  const meeting = await fixture();
  const first = await append({ meetingId: meeting.id, content: "We will launch Friday." });
  const snapshot = await loadMeetingTrackerInput(meeting.id);
  assert.deepEqual(
    snapshot.segments.map((s) => s.id),
    [first.id],
  );
  const late = await append({ meetingId: meeting.id, content: "Who owns the launch?" });
  assert.equal(
    await finishMeetingTracker({ meetingId: meeting.id, revision: 0, items: [], processedIds: [first.id] }),
    true,
  );
  assert.equal(await finishMeetingTracker({ meetingId: meeting.id, revision: 0, items: [], processedIds: [] }), false);
  const next = await loadMeetingTrackerInput(meeting.id);
  assert.deepEqual(
    next.segments.filter((s) => !next.processedIds.includes(s.id)).map((s) => s.id),
    [late.id],
  );
  assert.equal(
    await finishMeetingTracker({ meetingId: meeting.id, revision: 1, items: [], processedIds: [first.id, late.id] }),
    true,
  );
  await failMeetingTracker({ meetingId: meeting.id, revision: 0 });
  assert.equal((await readMeetingTracker(meeting.id)).status, "idle");
});
void test("failure does not advance the cursor; a later request can retry", async () => {
  const meeting = await fixture();
  const segment = await append({ meetingId: meeting.id, content: "Personbr will send the deck." });
  await failMeetingTracker({ meetingId: meeting.id, revision: 0 });
  assert.equal((await readMeetingTracker(meeting.id)).status, "failed");
  assert.deepEqual((await loadMeetingTrackerInput(meeting.id)).processedIds, []);
  assert.equal(
    await finishMeetingTracker({ meetingId: meeting.id, revision: 0, items: [], processedIds: [segment.id] }),
    true,
  );
  assert.equal((await readMeetingTracker(meeting.id)).status, "idle");
});
void test("duplicate events and assistant speech are excluded from new tracker input", async () => {
  const meeting = await fixture();
  const input = {
    meetingId: meeting.id,
    content: "Hello",
    speakerRole: "human" as const,
    source: "livekit-python-live" as const,
    sourceSegmentId: randomUUID(),
    speakerIdentity: "personbr",
    speakerName: "Personbr",
    startedAt: new Date(),
  };
  const one = await appendTranscriptSegment(input);
  assert.equal((await appendTranscriptSegment(input)).id, one.id);
  await appendTranscriptSegment({ ...input, sourceSegmentId: randomUUID(), speakerRole: "assistant" });
  assert.equal((await loadMeetingTrackerInput(meeting.id)).segments.length, 1);
});
