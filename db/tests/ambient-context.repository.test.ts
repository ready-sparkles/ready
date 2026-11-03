import type { MeetingTaskCandidate } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  appendTranscriptSegment,
  completeAiWorkflowJob,
  createMeeting,
  failAiWorkflowJob,
  getMeetingAmbientContextCursor,
  getMeetingLiveTaskCursor,
  listAiWorkflowJobsForMeeting,
  listMeetingLiveTaskCandidates,
  reanchorMeetingLiveTaskEvidence,
  replaceTranscriptSegmentsForMeetingBySources,
  retryFailedMeetingAmbientContextItemAndEnqueueResearch,
  updateMeetingAmbientContextCursor,
  updateMeetingAmbientContextItem,
  updateMeetingLiveTaskCursor,
  upsertMeetingAmbientContextMentionAndEnqueueResearch,
  upsertMeetingLiveTaskCandidate,
  upsertUser,
  withMeetingAmbientContextDetectionLock,
} from "../adapters/secondary/postgres/repositories";

const PROVIDER_FAILURE_MESSAGE = "provider failure";
const EXPECTED_TEST_COUNT_2 = 2;

/** @fixtureCapture createdMeetingIds */
const ambientContextTestState = { createdMeetingIds: [] as string[] };

const LIVE_TASK_CONFIRMED_OFFSET = 3;

const MESSAGE_REQUIRED_FIXTURE_VALUE = "Expected a required fixture value.";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error(MESSAGE_REQUIRED_FIXTURE_VALUE);
  }

  return value;
}

after(async () => {
  if (ambientContextTestState.createdMeetingIds.length !== 0) {
    await db.meetings.deleteMany({ where: { id: { in: ambientContextTestState.createdMeetingIds } } });
  }
  await closeDbPool();
});

void test("post-call refinement re-anchors live task evidence without changing its immutable quote", async () => {
  const meeting = await createAmbientContextTestMeeting("Live task evidence re-anchor");
  const liveSegment = await appendTranscriptSegment({
    meetingId: meeting.id,
    speakerIdentity: "participant-one",
    speakerName: "Participant One",
    speakerRole: "human",
    source: "livekit-python-live",
    sourceSegmentId: "live-task-evidence-one",
    content: "I will send the launch deck tomorrow",
    startedAt: new Date("2026-08-17T13:00:00.000Z"),
    endedAt: new Date("2026-08-17T13:00:02.000Z"),
  });
  const proposal: MeetingTaskCandidate = {
    title: "Send the launch deck",
    description: null,
    type: "task",
    workKind: "documentation",
    owner: { userId: null, name: null, email: null, confidence: null },
    dueDate: { value: "tomorrow", confidence: "high" },
    confidence: "high",
    completion: { completedDuringMeeting: false, quote: null, confidence: null },
    sourceQuotes: [{ quote: "I will send the launch deck tomorrow", speaker: "Participant One", timestamp: null }],
    sourceReason: "Explicit commitment.",
  };
  await upsertMeetingLiveTaskCandidate({
    meetingId: meeting.id,
    state: "confirmed",
    proposal,
    firstEvidenceAt: liveSegment.startedAt,
    actionConfirmableAt: liveSegment.endedAt,
    lastEvidenceAt: required(liveSegment.endedAt),
    evidence: [
      {
        roles: ["action", "scope", "due_date"],
        transcriptSegmentId: liveSegment.id,
        sourceSegmentId: liveSegment.sourceSegmentId,
        fullSegmentText: liveSegment.content,
        quote: liveSegment.content,
        quoteStart: 0,
        quoteEnd: liveSegment.content.length,
        contentHash: "immutable-live-content-hash",
        speakerIdentity: liveSegment.speakerIdentity,
        speakerUserId: liveSegment.speakerUserId,
        speakerName: liveSegment.speakerName,
        startedAt: liveSegment.startedAt,
        endedAt: required(liveSegment.endedAt),
        sequence: 0,
      },
    ],
  });

  const [refinedSegment] = await replaceTranscriptSegmentsForMeetingBySources({
    meetingId: meeting.id,
    source: "livekit-python-postcall",
    deleteSources: ["livekit-python-live", "livekit-python-postcall"],
    segments: [
      {
        speakerIdentity: "participant-one",
        speakerName: "Participant One",
        speakerRole: "human",
        source: "livekit-python-postcall",
        content: "I’ll send the launch deck tomorrow.",
        startedAt: new Date("2026-08-17T13:00:00.500Z"),
        endedAt: new Date("2026-08-17T13:00:02.500Z"),
      },
    ],
  });
  assert.ok(refinedSegment);
  assert.equal(await reanchorMeetingLiveTaskEvidence(meeting.id), 1);
  const [candidate] = await listMeetingLiveTaskCandidates({ meetingId: meeting.id });
  assert.equal(candidate?.evidence[0]?.transcriptSegmentId, refinedSegment.id);
  assert.equal(candidate.evidence[0].fullSegmentText, "I will send the launch deck tomorrow");
  assert.equal(candidate.evidence[0].quote, "I will send the launch deck tomorrow");
});

async function createAmbientContextTestMeeting(label: string) {
  const user = await upsertUser({
    email: `${randomUUID()}@ambient-context.readymeet.test`,
    displayName: "Ambient Context Tester",
  });
  const meeting = await createMeeting({
    title: label,
    roomName: `ambient-context-${randomUUID()}`,
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  ambientContextTestState.createdMeetingIds = [...ambientContextTestState.createdMeetingIds, meeting.id];

  return meeting;
}

void test("explicit retries start a fresh execution without reviving terminal work", async () => {
  const meeting = await createAmbientContextTestMeeting("Research execution history");
  const created = await upsertMeetingAmbientContextMentionAndEnqueueResearch({
    meetingId: meeting.id,
    entityKind: "company",
    canonicalKey: "company:linear",
    displayName: "Linear",
    facets: [],
    mentionedAt: new Date(),
  });
  const job = required(created.researchJob);
  assert.equal(job.status, "running");
  const failed = await failAiWorkflowJob({ jobId: job.id, error: PROVIDER_FAILURE_MESSAGE });
  assert.equal(failed.status, "failed");
  assert.ok(failed.completedAt !== null);
  await updateMeetingAmbientContextItem({ meetingId: meeting.id, itemId: created.item.id, status: "failed" });
  const retried = required(
    await retryFailedMeetingAmbientContextItemAndEnqueueResearch({ meetingId: meeting.id, itemId: created.item.id }),
  );
  assert.notEqual(retried.researchJob.id, job.id);
  assert.equal(retried.researchJob.status, "running");
  await completeAiWorkflowJob({ jobId: retried.researchJob.id, result: { status: "ready" } });
  await updateMeetingAmbientContextItem({
    meetingId: meeting.id,
    itemId: created.item.id,
    status: "ready",
    error: null,
  });
  assert.equal(
    await retryFailedMeetingAmbientContextItemAndEnqueueResearch({ meetingId: meeting.id, itemId: created.item.id }),
    null,
  );
  assert.equal((await listAiWorkflowJobsForMeeting(meeting.id)).length, EXPECTED_TEST_COUNT_2);
});

void test("post-call transcript replacement remaps the ambient cursor by its durable time horizon", async () => {
  const meeting = await createAmbientContextTestMeeting("Ambient cursor replacement");
  const firstLive = await appendTranscriptSegment({
    meetingId: meeting.id,
    speakerIdentity: "participant-one",
    speakerName: "Participant One",
    speakerRole: "human",
    source: "livekit-python-live",
    sourceSegmentId: "live-one",
    content: "We use Linear for product planning.",
    startedAt: new Date("2026-08-17T12:00:00.000Z"),
    endedAt: new Date("2026-08-17T12:00:01.000Z"),
  });
  await appendTranscriptSegment({
    meetingId: meeting.id,
    speakerIdentity: "participant-one",
    speakerName: "Participant One",
    speakerRole: "human",
    source: "livekit-python-live",
    sourceSegmentId: "live-two",
    content: "The next topic is pricing.",
    startedAt: new Date("2026-08-17T12:00:02.000Z"),
    endedAt: new Date("2026-08-17T12:00:03.000Z"),
  });
  await updateMeetingAmbientContextCursor({
    meetingId: meeting.id,
    lastProcessedSegmentId: firstLive.id,
    processedThrough: required(firstLive.endedAt),
  });
  await updateMeetingLiveTaskCursor({
    meetingId: meeting.id,
    lastProcessedSegmentId: firstLive.id,
    processedThrough: required(firstLive.endedAt),
    confirmedTaskOffset: LIVE_TASK_CONFIRMED_OFFSET,
  });

  const finalized = await replaceTranscriptSegmentsForMeetingBySources({
    meetingId: meeting.id,
    source: "livekit-python-postcall",
    deleteSources: ["livekit-python-live", "livekit-python-postcall"],
    segments: [
      {
        speakerIdentity: "participant-one",
        speakerName: "Participant One",
        speakerRole: "human",
        source: "livekit-python-postcall",
        content: "We use Linear for product planning.",
        startedAt: new Date("2026-08-17T12:00:00.000Z"),
        endedAt: new Date("2026-08-17T12:00:01.000Z"),
      },
      {
        speakerIdentity: "participant-one",
        speakerName: "Participant One",
        speakerRole: "human",
        source: "livekit-python-postcall",
        content: "The next topic is pricing.",
        startedAt: new Date("2026-08-17T12:00:02.000Z"),
        endedAt: new Date("2026-08-17T12:00:03.000Z"),
      },
    ],
  });

  const cursor = await getMeetingAmbientContextCursor(meeting.id);
  const liveTaskCursor = await getMeetingLiveTaskCursor(meeting.id);
  assert.equal(cursor?.lastProcessedSegmentId, finalized[0]?.id);
  assert.equal(cursor?.processedThrough?.toISOString(), "2026-08-17T12:00:01.000Z");
  assert.equal(liveTaskCursor?.lastProcessedSegmentId, finalized[0]?.id);
  assert.equal(liveTaskCursor?.processedThrough?.toISOString(), "2026-08-17T12:00:01.000Z");
  assert.equal(liveTaskCursor.confirmedTaskOffset, LIVE_TASK_CONFIRMED_OFFSET);
});

void test("ambient detection repeats for final speech received during a run", async () => {
  const meeting = await createAmbientContextTestMeeting("Ambient pending speech");
  const state = { release: () => {}, started: () => {}, runs: 0, speech: "first", processed: "" };
  const blocked = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    state.started = resolve;
  });
  const operation = async () => {
    state.runs += 1;
    const snapshot = state.speech;
    if (state.runs === 1) {
      state.started();
      await blocked;
    }
    Object.assign(state, { processed: snapshot });

    return snapshot;
  };
  const first = withMeetingAmbientContextDetectionLock(meeting.id, operation);
  await started;
  try {
    state.speech = "final speech";
    const competing = await Promise.all([
      withMeetingAmbientContextDetectionLock(meeting.id, operation),
      withMeetingAmbientContextDetectionLock(meeting.id, operation),
    ]);
    assert.deepEqual(competing, [null, null]);
    assert.equal(state.runs, 1);
  } finally {
    state.release();
  }
  assert.equal(await first, "final speech");
  assert.equal(state.processed, "final speech");
  assert.equal(state.runs, EXPECTED_TEST_COUNT_2);
  assert.equal((await getMeetingAmbientContextCursor(meeting.id))?.detectionState, "idle");
});

void test("ambient detection does not retry failed provider work when speech is pending", async () => {
  const meeting = await createAmbientContextTestMeeting("Ambient failed pending speech");
  const state = { runs: 0 };
  await assert.rejects(
    withMeetingAmbientContextDetectionLock(meeting.id, async () => {
      state.runs += 1;
      await withMeetingAmbientContextDetectionLock(meeting.id, async () => {
        assert.fail("overlapping detection");
      });
      throw new Error(PROVIDER_FAILURE_MESSAGE);
    }),
    /provider failure/,
  );
  assert.equal(state.runs, 1);
  assert.equal((await getMeetingAmbientContextCursor(meeting.id))?.detectionState, "failed");
});
