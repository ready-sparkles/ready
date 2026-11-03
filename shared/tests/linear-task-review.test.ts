import assert from "node:assert/strict";
import test from "node:test";

import {
  linearTaskReviewCandidateSchema,
  linearTaskReviewClassificationRequestSchema,
  linearTaskReviewRunSchema,
} from "../domain/linear-task-review";

const runId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const HIGH_ISSUE_CLASSIFICATION_CONFIDENCE = 0.94;
const LOW_ISSUE_CLASSIFICATION_CONFIDENCE = 0.8;
const GROUNDED_ISSUE_CONFIDENCE = 0.96;

void test("Linear review persists explicit source task ids for every proposed issue", () => {
  const parsed = linearTaskReviewRunSchema.parse({
    id: runId,
    meetingId: "33333333-3333-4333-8333-333333333333",
    taskListId: "44444444-4444-4444-8444-444444444444",
    userId: "55555555-5555-4555-8555-555555555555",
    connectorId: "66666666-6666-4666-8666-666666666666",
    status: "awaiting_user",
    phase: "awaiting_user",
    inputHash: "abc123",
    model: "test-model",
    promptVersion: "linear-task-review-v1",
    error: null,
    startedAt: "2026-08-05T12:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
    items: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        runId,
        position: 0,
        sourceTaskIds: [taskId],
        decision: "linear",
        confidence: HIGH_ISSUE_CLASSIFICATION_CONFIDENCE,
        reasoning: "This is implementation work for the product team.",
        title: "Fix CSV export memory usage",
        description: null,
        teamId: "team-1",
        teamName: "Engineering",
        /** @external existing wire contract */
        included: true,
        syncStatus: "pending",
        syncError: null,
        externalIssue: null,
        createdAt: "2026-08-05T12:00:00.000Z",
        updatedAt: "2026-08-05T12:00:00.000Z",
      },
    ],
  });

  const [parsedItem] = parsed.items;
  assert.ok(parsedItem);
  assert.deepEqual(parsedItem.sourceTaskIds, [taskId]);
});

void test("a proposed issue cannot lose its source-task mapping", () => {
  const parsed = linearTaskReviewCandidateSchema.safeParse({
    sourceTaskIds: [],
    decision: "linear",
    confidence: LOW_ISSUE_CLASSIFICATION_CONFIDENCE,
    reasoning: "Product work",
    title: "Build the feature",
    description: null,
    teamId: "team-1",
    teamName: "Engineering",
  });
  assert.equal(parsed.success, false);
});

void test("classification input rejects transcript payloads", () => {
  const parsed = linearTaskReviewClassificationRequestSchema.safeParse({
    meetingId: "33333333-3333-4333-8333-333333333333",
    tasks: [
      {
        id: taskId,
        title: "Build export flow",
        description: null,
        taskType: "task",
        workKind: "implementation",
        assigneeName: null,
        dueDate: null,
      },
    ],
    availableTeams: [{ id: "team-1", name: "Engineering", key: "ENG" }],
    transcript: "This must never be sent to the Linear matcher.",
  });
  assert.equal(parsed.success, false);
});

void test("grounded issue drafts preserve evidence and duplicate action state", () => {
  const parsed = linearTaskReviewCandidateSchema.parse({
    sourceTaskIds: ["11111111-1111-4111-8111-111111111111"],
    decision: "linear",
    confidence: GROUNDED_ISSUE_CONFIDENCE,
    reasoning: "The customer demonstrated a current product failure.",
    title: "Fix frozen checkout",
    description: null,
    issueDraft: {
      problem: "Checkout freezes after saving a card.",
      observedBehavior: "The page remains stuck.",
      expectedBehavior: null,
      requestedChange: "Keep checkout responsive.",
      reproductionSteps: ["Save a card during checkout."],
      impact: null,
      evidence: [
        {
          quote: "When I save this card, checkout is stuck here.",
          speaker: "Customer",
          timestamp: null,
          segmentId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    },
    teamId: "team-1",
    teamName: "Engineering",
    duplicateIssues: [
      {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Checkout hangs after saving cards",
        url: "https://linear.app/ready/issue/ENG-42",
        status: "Backlog",
        rationale: "Matches checkout and card-saving failure language.",
      },
    ],
    targetAction: "create_duplicate",
    targetIssue: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Checkout hangs after saving cards",
      url: "https://linear.app/ready/issue/ENG-42",
    },
    relationId: null,
  });

  assert.equal(parsed.issueDraft?.evidence[0]?.speaker, "Customer");
  assert.equal(parsed.targetAction, "create_duplicate");
  assert.equal(parsed.duplicateIssues[0]?.identifier, "ENG-42");
});
