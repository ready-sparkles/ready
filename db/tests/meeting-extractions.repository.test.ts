import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  createMeeting,
  getExtractionById,
  getExtractionByMeetingId,
  getExtractionStatus,
  getExtractionsWithSignal,
  listExtractionsByStatus,
  upsertMeetingExtraction,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

const DECISION_TEXT_SHIP_SHARE_SCREEN = "Ship the dedicated share screen next sprint.";
const SAMPLE_EXTRACTION_DURATION_MS = 1200;

async function createTestMeeting(title: string) {
  const user = await upsertUser({
    email: `${randomUUID()}@readymeet.test`,
    displayName: "Extraction Repository Tester",
  });

  return createMeeting({
    title,
    roomName: `room-${randomUUID()}`,
    createdByUserId: user.id,
  });
}

after(async () => {
  await closeDbPool();
});

void test("extraction row persists and round-trips through repository helpers", async () => {
  const meeting = await createTestMeeting("Extraction persistence");

  const persisted = await upsertMeetingExtraction({
    meetingId: meeting.id,
    status: "completed",
    meetingType: "product_review",
    meetingTypeConfidence: "high",
    meetingTypeReasoning: "Product review discussion.",
    participants: [
      {
        name: "Personbi",
        roleHint: "product",
        confidence: "high",
      },
    ],
    summaryShort: "The team committed to the dedicated share screen.",
    summaryBullets: ["Decision made", "Spec assigned", "Review planned"],
    decisions: [
      {
        id: randomUUID(),
        text: DECISION_TEXT_SHIP_SHARE_SCREEN,
        finality: "final",
        confidence: "high",
        sourceSpans: [
          {
            excerpt: "dedicated share screen next sprint",
            lineStart: 1,
            lineEnd: 1,
            segmentIds: ["11111111-1111-4111-8111-111111111111"],
            startedAt: "2026-04-22T10:00:00.000Z",
            endedAt: "2026-04-22T10:00:04.000Z",
          },
        ],
      },
    ],
    actionItems: [],
    openQuestions: [],
    risks: [],
    highlights: [
      {
        id: randomUUID(),
        theme: "share screen",
        takeaway: "The team chose the dedicated share screen direction.",
        sourceSpans: [
          {
            excerpt: "dedicated share screen next sprint",
            lineStart: 1,
            lineEnd: 1,
            segmentIds: ["11111111-1111-4111-8111-111111111111"],
            startedAt: "2026-04-22T10:00:00.000Z",
            endedAt: "2026-04-22T10:00:04.000Z",
          },
        ],
      },
    ],
    keyTopics: ["share screen"],
    signals: [
      {
        key: "product_or_feature_discussion",
        confidence: "high",
        sourceSpans: [
          {
            excerpt: "dedicated share screen",
            lineStart: 1,
            lineEnd: 1,
            segmentIds: ["11111111-1111-4111-8111-111111111111"],
            startedAt: "2026-04-22T10:00:00.000Z",
            endedAt: "2026-04-22T10:00:04.000Z",
          },
        ],
        reasoning: "The transcript centers on a product change.",
      },
    ],
    failedToolCalls: [],
    extractionModel: "mock-extractor",
    extractionPromptVersion: "1.0.0",
    transcriptHash: `hash-${randomUUID()}`,
    durationMs: SAMPLE_EXTRACTION_DURATION_MS,
    startedAt: new Date("2026-04-22T10:00:00.000Z"),
    completedAt: new Date("2026-04-22T10:00:01.200Z"),
  });

  const byMeetingId = await getExtractionByMeetingId(meeting.id);
  const byId = await getExtractionById(persisted.id);

  assert.ok(byMeetingId);
  assert.ok(byId);
  assert.equal(byMeetingId.id, persisted.id);
  assert.equal(byId.summaryShort, persisted.summaryShort);
  assert.equal(byId.highlights[0]?.theme, "share screen");
  assert.equal(byId.signals[0]?.key, "product_or_feature_discussion");
});

void test("unique constraint on meeting_id is enforced", async () => {
  const meeting = await createTestMeeting("Extraction unique constraint");
  const sharedHash = `hash-${randomUUID()}`;

  await db.meetingExtractions.create({
    data: {
      meetingId: meeting.id,
      status: "pending",
      extractionModel: "mock-extractor",
      extractionPromptVersion: "1.0.0",
      transcriptHash: sharedHash,
    },
  });

  await assert.rejects(
    db.meetingExtractions.create({
      data: {
        meetingId: meeting.id,
        status: "pending",
        extractionModel: "mock-extractor",
        extractionPromptVersion: "1.0.0",
        transcriptHash: `${sharedHash}-second`,
      },
    }),
    /meeting_extractions_meeting_uidx|duplicate/i,
  );
});

void test("status helpers and signal helpers return the expected rows", async () => {
  const meeting = await createTestMeeting("Extraction query helpers");

  const running = await upsertMeetingExtraction({
    meetingId: meeting.id,
    status: "running",
    extractionModel: "mock-extractor",
    extractionPromptVersion: "1.0.0",
    transcriptHash: `hash-${randomUUID()}`,
    startedAt: new Date(),
  });

  assert.equal(await getExtractionStatus(running.id), "running");

  const completed = await upsertMeetingExtraction({
    meetingId: meeting.id,
    status: "completed",
    signals: [
      {
        key: "product_or_feature_discussion",
        confidence: "high",
        sourceSpans: [
          {
            excerpt: "dedicated share screen",
            lineStart: 1,
            lineEnd: 1,
            segmentIds: ["11111111-1111-4111-8111-111111111111"],
            startedAt: "2026-04-22T10:00:00.000Z",
            endedAt: "2026-04-22T10:00:04.000Z",
          },
        ],
      },
    ],
    extractionModel: "mock-extractor",
    extractionPromptVersion: "1.0.0",
    transcriptHash: `hash-${randomUUID()}`,
    startedAt: new Date(),
    completedAt: new Date(),
  });

  const completedRows = await listExtractionsByStatus("completed");
  const signaledRows = await getExtractionsWithSignal("product_or_feature_discussion");

  assert.ok(completedRows.some((row) => row.id === completed.id));
  assert.ok(signaledRows.some((row) => row.id === completed.id));
});

void test("existing extraction rows without highlights load with an empty array default", async () => {
  const meeting = await createTestMeeting("Extraction highlights default");

  const row = await db.meetingExtractions.create({
    data: {
      meetingId: meeting.id,
      status: "pending",
      extractionModel: "mock-extractor",
      extractionPromptVersion: "1.1.0",
      transcriptHash: `hash-${randomUUID()}`,
    },
  });

  assert.equal(row.status, "pending");

  const loaded = await getExtractionById(row.id);
  assert.ok(loaded);
  assert.deepEqual(loaded.highlights, []);
});
