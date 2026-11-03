import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  createMeeting,
  getRecommendationsByExtractionId,
  insertCapabilityRecommendations,
  upsertCapability,
  upsertMeetingExtraction,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

const TEST_CAPABILITY_DEFAULT_PRIORITY = 84;
const TEST_RECOMMENDATION_SCORE = 120;
const TEST_SIGNAL_MATCH_SCORE = 30;

after(async () => {
  await closeDbPool();
});

async function createRecommendationFixture() {
  await upsertCapability({
    key: "file_issue_or_bug",
    name: "Bug Report",
    description: "File a bug report.",
    category: "execution",
    applicableMeetingTypes: ["product_review"],
    requiredSignals: [{ key: "engineering_issue_identified" }],
    exclusionSignals: [],
    exampleTriggers: ["We found a bug.", "File this issue."],
    sideEffectScope: "external_action",
    defaultPriority: TEST_CAPABILITY_DEFAULT_PRIORITY,
    isActive: true,
    metadata: {},
  });
  const user = await upsertUser({
    email: `${randomUUID()}@readymeet.test`,
    displayName: "Recommendation Test User",
  });
  const meeting = await createMeeting({
    title: "Recommendation repository test",
    roomName: `recommendation-${randomUUID()}`,
    createdByUserId: user.id,
  });
  const extraction = await upsertMeetingExtraction({
    meetingId: meeting.id,
    status: "completed",
    meetingType: "product_review",
    extractionModel: "mock-extractor",
    extractionPromptVersion: "1.1.8",
    transcriptHash: randomUUID(),
    startedAt: new Date(),
    completedAt: new Date(),
  });

  return { meeting, extraction };
}

void test("recommendation row persists and round-trips through repository helpers", async () => {
  const { meeting, extraction } = await createRecommendationFixture();
  const rows = await insertCapabilityRecommendations([
    {
      meetingId: meeting.id,
      extractionId: extraction.id,
      capabilityKey: "file_issue_or_bug",
      rank: 1,
      rawScore: TEST_RECOMMENDATION_SCORE,
      finalScore: TEST_RECOMMENDATION_SCORE,
      signalsMatched: [{ key: "engineering_issue_identified", confidence: "high", score: TEST_SIGNAL_MATCH_SCORE }],
      signalsMissing: [],
      exclusionSignalsChecked: [],
      reasoning: "The meeting includes a concrete engineering issue.",
      payload: { issues: [{ title: "Fix export crash" }] },
      confidence: "high",
      selectionPromptVersion: "repo-test-1",
      selectionModel: "mock-selector",
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.capabilityKey, "file_issue_or_bug");
  assert.deepEqual(rows[0].payload, { issues: [{ title: "Fix export crash" }] });

  const fetched = await getRecommendationsByExtractionId(extraction.id, "repo-test-1");
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0]?.signalsMatched[0]?.key, "engineering_issue_identified");
});

void test("unique constraint includes extraction, capability key, and prompt version", async () => {
  const { meeting, extraction } = await createRecommendationFixture();
  await db.meetingCapabilityRecommendations.create({
    data: {
      meetingId: meeting.id,
      extractionId: extraction.id,
      capabilityKey: "file_issue_or_bug",
      rank: 1,
      rawScore: TEST_RECOMMENDATION_SCORE,
      finalScore: TEST_RECOMMENDATION_SCORE,
      reasoning: "First recommendation.",
      confidence: "high",
      selectionPromptVersion: "repo-test-unique",
      selectionModel: "mock-selector",
    },
  });

  await assert.rejects(
    db.meetingCapabilityRecommendations.create({
      data: {
        meetingId: meeting.id,
        extractionId: extraction.id,
        capabilityKey: "file_issue_or_bug",
        rank: 1,
        rawScore: TEST_RECOMMENDATION_SCORE,
        finalScore: TEST_RECOMMENDATION_SCORE,
        reasoning: "Duplicate recommendation.",
        confidence: "high",
        selectionPromptVersion: "repo-test-unique",
        selectionModel: "mock-selector",
      },
    }),
    /meeting_capability_recommendations_extraction_capability_prompt|duplicate/i,
  );

  await db.meetingCapabilityRecommendations.create({
    data: {
      meetingId: meeting.id,
      extractionId: extraction.id,
      capabilityKey: "file_issue_or_bug",
      rank: 1,
      rawScore: TEST_RECOMMENDATION_SCORE,
      finalScore: TEST_RECOMMENDATION_SCORE,
      reasoning: "New prompt version recommendation.",
      confidence: "high",
      selectionPromptVersion: "repo-test-unique-next",
      selectionModel: "mock-selector",
    },
  });
});
