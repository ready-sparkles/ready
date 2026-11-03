import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  createMeeting,
  heartbeatAiWorkflowJob,
  startAiWorkflowExecution,
  updateCapabilityWorkflowRun,
  upsertCapability,
  upsertCapabilityWorkflowRun,
  upsertMeetingExtraction,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

const TEST_CAPABILITY_DEFAULT_PRIORITY = 84;
const TEST_RECOMMENDATION_SCORE = 120;
const STORED_CONTEXT = { keep: "context" };
const STORED_PLAN = { keep: "plan" };
const STORED_DRAFT = { keep: "draft" };
const STORED_RESULT = { keep: "result" };
const STORED_JOB_RESULT = { keep: "job" };
const EXPECTED_RUNNING_JOB_MESSAGE = "Expected a running workflow job.";

after(async () => {
  await closeDbPool();
});

async function createWorkflowFixture() {
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
    displayName: "Workflow Test User",
  });
  const meeting = await createMeeting({
    title: "Workflow repository test",
    roomName: `workflow-${randomUUID()}`,
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
  const recommendation = await db.meetingCapabilityRecommendations.create({
    data: {
      meetingId: meeting.id,
      extractionId: extraction.id,
      capabilityKey: "file_issue_or_bug",
      rank: 1,
      rawScore: TEST_RECOMMENDATION_SCORE,
      finalScore: TEST_RECOMMENDATION_SCORE,
      reasoning: "The meeting includes a concrete engineering issue.",
      confidence: "high",
      selectionPromptVersion: "repo-test-workflow",
      selectionModel: "mock-selector",
    },
  });

  return { meeting, recommendation };
}

void test("omitted workflow JSON fields stay stored", async () => {
  const { meeting, recommendation } = await createWorkflowFixture();
  const created = await upsertCapabilityWorkflowRun({
    meetingId: meeting.id,
    recommendationId: recommendation.id,
    capabilityKey: "file_issue_or_bug",
    status: "running",
    phase: "reviewing_evidence",
    context: STORED_CONTEXT,
    plan: STORED_PLAN,
    draft: STORED_DRAFT,
    result: STORED_RESULT,
  });
  const updated = await updateCapabilityWorkflowRun({
    workflowRunId: created.id,
    status: "running",
    phase: "scoping_issues",
  });

  assert.deepEqual(updated.context, STORED_CONTEXT);
  assert.deepEqual(updated.plan, STORED_PLAN);
  assert.deepEqual(updated.draft, STORED_DRAFT);
  assert.deepEqual(updated.result, STORED_RESULT);

  const upserted = await upsertCapabilityWorkflowRun({
    meetingId: meeting.id,
    recommendationId: recommendation.id,
    capabilityKey: "file_issue_or_bug",
    status: "running",
    phase: "searching_linear",
  });

  assert.equal(upserted.phase, "searching_linear");
  assert.deepEqual(upserted.context, STORED_CONTEXT);
  assert.deepEqual(upserted.plan, STORED_PLAN);
  assert.deepEqual(upserted.draft, STORED_DRAFT);
  assert.deepEqual(upserted.result, STORED_RESULT);

  const job = await startAiWorkflowExecution({
    meetingId: meeting.id,
    type: "run_meeting_research",
  });
  const recorded = await heartbeatAiWorkflowJob({
    jobId: job.id,
    workerId: "workflow-test",
    result: STORED_JOB_RESULT,
  });
  const heartbeat = await heartbeatAiWorkflowJob({
    jobId: job.id,
    workerId: "workflow-test",
    phase: "still_running",
  });

  if (recorded === null || heartbeat === null) {
    throw new Error(EXPECTED_RUNNING_JOB_MESSAGE);
  }
  assert.deepEqual(recorded.result, STORED_JOB_RESULT);
  assert.equal(heartbeat.phase, "still_running");
  assert.deepEqual(heartbeat.result, STORED_JOB_RESULT);
});
