import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  appendTranscriptSegment,
  createMeeting,
  listTranscriptSegmentsAfter,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

after(closeDbPool);

const PAGE_LIMIT = 2;
const LAST_SEEDED_SEGMENT_INDEX = 2;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const EXPECTED_TRANSCRIPT_PAGES_MESSAGE = "Expected transcript pages.";

void test("transcript pages stay in one meeting and order late speech by creation", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@transcript.readymeet.test`,
    displayName: "Transcript tester",
  });
  const meeting = await createMeeting({
    title: "Transcript page",
    roomName: `transcript-${randomUUID()}`,
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const other = await createMeeting({
    title: "Other transcript",
    roomName: `transcript-other-${randomUUID()}`,
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const createdAt = new Date("2026-09-23T00:00:00.000Z");
  const inserted = await [0, 1, LAST_SEEDED_SEGMENT_INDEX].reduce<Promise<{ id: string }[]>>(async (pending, index) => {
    const rows = await pending;
    const segment = await appendTranscriptSegment({
      meetingId: meeting.id,
      speakerIdentity: "speaker",
      speakerName: "Speaker",
      speakerRole: "human",
      content: `line ${index}`,
      startedAt: createdAt,
    });

    return [...rows, { id: segment.id }];
  }, Promise.resolve([]));
  const saved = inserted.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  await saved.reduce(async (pending, segment, index) => {
    await pending;
    await db.transcriptSegments.updateMany({
      where: { id: segment.id },
      data: { createdAt, startedAt: new Date(createdAt.getTime() - index * MS_PER_HOUR) },
    });
  }, Promise.resolve());
  await appendTranscriptSegment({
    meetingId: other.id,
    speakerIdentity: "speaker",
    speakerName: "Speaker",
    speakerRole: "human",
    content: "other meeting",
    startedAt: createdAt,
  });

  const first = await listTranscriptSegmentsAfter({
    meetingId: meeting.id,
    createdAt: new Date(createdAt.getTime() - 1),
    segmentId: "00000000-0000-0000-0000-000000000000",
    limit: PAGE_LIMIT,
  });
  assert.deepEqual(
    first.map((row) => row.id),
    saved.slice(0, PAGE_LIMIT).map((row) => row.id),
  );
  const second = await listTranscriptSegmentsAfter({
    meetingId: meeting.id,
    createdAt,
    segmentId: saved[1]?.id ?? "",
    limit: PAGE_LIMIT,
  });
  assert.deepEqual(
    second.map((row) => row.id),
    saved.slice(PAGE_LIMIT).map((row) => row.id),
  );
  const firstStartedAt = first[0]?.startedAt;
  const secondStartedAt = second[0]?.startedAt;
  if (firstStartedAt === undefined || secondStartedAt === undefined) {
    throw new Error(EXPECTED_TRANSCRIPT_PAGES_MESSAGE);
  }
  assert.ok(secondStartedAt < firstStartedAt);
  assert.deepEqual(
    await listTranscriptSegmentsAfter({
      meetingId: randomUUID(),
      createdAt,
      segmentId: saved[0]?.id ?? "",
    }),
    [],
  );

  await db.meetings.deleteMany({ where: { id: meeting.id } });
  await db.meetings.deleteMany({ where: { id: other.id } });
});
