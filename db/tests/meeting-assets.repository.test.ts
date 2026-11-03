import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool } from "../adapters/secondary/postgres/client";
import {
  appendTranscriptSegment,
  createMeeting,
  createMeetingAsset,
  getMeetingTaskListForMeeting,
  getTranscriptForMeeting,
  listMeetingAssets,
  replaceMeetingTasksForList,
  updateMeetingAsset,
  upsertMeetingTaskList,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

const MISSING_REQUIRED_VALUE = "Expected a value.";
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error(MISSING_REQUIRED_VALUE);
  }

  return value;
};

const CONTENT_HASH_LENGTH = 64;
const SAMPLE_BYTE_SIZE = 123;
const EXTRA_SEGMENT_COUNT = 7;
const MERGED_SEGMENT_COUNT = 9;
const SEGMENT_COUNT = 4;
const DATE_FILTER_SEGMENT_INDEX = 3;
const SEGMENT_SPACING_MS = 5_000;

after(async () => {
  await closeDbPool();
});

void test("same-frame captures normalize and merge transcript provenance and retain explicit Linear approval", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@meeting-assets.readymeet.test`,
    displayName: "Meeting Asset Tester",
  });
  const meeting = await createMeeting({
    title: "Meeting asset repository test",
    roomName: `meeting-assets-${randomUUID()}`,
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const firstSegmentId = randomUUID();
  const secondSegmentId = randomUUID();
  const contentHash = randomUUID().replaceAll("-", "").padEnd(CONTENT_HASH_LENGTH, "0").slice(0, CONTENT_HASH_LENGTH);
  const base = {
    meetingId: meeting.id,
    storageKey: `meeting-assets/${meeting.id}/${contentHash}.jpg`,
    contentHash,
    mimeType: "image/jpeg" as const,
    byteSize: SAMPLE_BYTE_SIZE,
    capturedAt: new Date("2026-08-05T12:00:00.000Z"),
    participantIdentity: "customer-browser",
    trackSid: "TR_screen",
    trigger: "automatic_bug_context" as const,
    transcriptExcerpt: "The checkout is stuck here.",
    speakerName: "Customer",
  };

  const createdAssetId = randomUUID();
  const created = await createMeetingAsset({
    ...base,
    id: createdAssetId,
    transcriptSegmentId: firstSegmentId,
  });
  const merged = await createMeetingAsset({
    ...base,
    id: randomUUID(),
    transcriptSegmentIds: [secondSegmentId],
  });
  assert.equal(created.id, createdAssetId);
  assert.equal(merged.id, created.id);
  assert.deepEqual(new Set(merged.transcriptSegmentIds), new Set([firstSegmentId, secondSegmentId]));

  const remainingSegmentIds = Array.from({ length: EXTRA_SEGMENT_COUNT }, () => randomUUID());
  const capped = await createMeetingAsset({ ...base, transcriptSegmentIds: remainingSegmentIds });
  assert.equal(capped.transcriptSegmentIds.length, MERGED_SEGMENT_COUNT);
  await assert.rejects(
    createMeetingAsset({ ...base, transcriptSegmentId: randomUUID() }),
    /at most 9 unique transcript segments/,
  );

  const approved = await updateMeetingAsset({
    assetId: created.id,
    meetingId: meeting.id,
    /** @external existing meeting asset field */
    includeInLinear: true,
  });
  assert.equal(approved?.includeInLinear, true);
  assert.equal((await listMeetingAssets(meeting.id)).length, 1);
});

void test("task generation links nearby screen evidence before any Linear review", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@task-evidence.readymeet.test`,
    displayName: "Task Evidence Tester",
  });
  const meeting = await createMeeting({
    title: "Task evidence repository test",
    roomName: `task-evidence-${randomUUID()}`,
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const startedAt = new Date("2026-08-05T12:00:00.000Z");
  const segments = await Promise.all(
    Array.from({ length: SEGMENT_COUNT }, (_, index) =>
      appendTranscriptSegment({
        meetingId: meeting.id,
        speakerIdentity: "customer-browser",
        speakerName: "Customer",
        speakerRole: "human",
        content:
          index === DATE_FILTER_SEGMENT_INDEX
            ? "Can we add a date filter to this dashboard?"
            : `Nearby dashboard context ${index}`,
        startedAt: new Date(startedAt.getTime() + index * SEGMENT_SPACING_MS),
      }),
    ),
  );
  assert.equal(new Set(segments.map((segment) => required(segment).transcriptId)).size, 1);
  const transcript = required(await getTranscriptForMeeting(meeting.id));
  assert.equal(transcript.segments.length, SEGMENT_COUNT, "all concurrent writes are retained");
  const contentHash = randomUUID().replaceAll("-", "").padEnd(CONTENT_HASH_LENGTH, "0").slice(0, CONTENT_HASH_LENGTH);
  const asset = await createMeetingAsset({
    meetingId: meeting.id,
    storageKey: `meeting-assets/${meeting.id}/${contentHash}.jpg`,
    contentHash,
    mimeType: "image/jpeg",
    byteSize: SAMPLE_BYTE_SIZE,
    capturedAt: new Date(startedAt.getTime() + SEGMENT_SPACING_MS),
    participantIdentity: "customer-browser",
    trackSid: "TR_screen",
    trigger: "automatic_task_context",
    transcriptSegmentIds: [required(segments[1]).id],
    transcriptExcerpt: "Here is the analytics dashboard.",
    speakerName: "Customer",
  });
  const taskList = await upsertMeetingTaskList({
    meetingId: meeting.id,
    status: "generating",
    phase: "finding_followups",
  });
  await replaceMeetingTasksForList({
    meetingId: meeting.id,
    taskListId: taskList.id,
    items: [
      {
        title: "Add a date filter to the analytics dashboard",
        description: "Support a custom date range.",
        type: "task",
        workKind: "implementation",
        owner: { userId: null, name: null, email: null, confidence: null },
        dueDate: { value: null, confidence: null },
        confidence: "high",
        completion: {
          /** @external existing task candidate field */
          completedDuringMeeting: false,
          quote: null,
          confidence: null,
        },
        sourceQuotes: [
          {
            quote: required(segments[DATE_FILTER_SEGMENT_INDEX]).content,
            speaker: "Customer",
            timestamp: required(segments[DATE_FILTER_SEGMENT_INDEX]).startedAt.toISOString(),
            segmentId: required(segments[DATE_FILTER_SEGMENT_INDEX]).id,
          },
        ],
        sourceReason: "The customer requested a concrete dashboard change.",
      },
    ],
  });

  const persisted = await getMeetingTaskListForMeeting(meeting.id);
  assert.deepEqual(persisted?.items[0]?.assetIds, [asset.id]);
});
