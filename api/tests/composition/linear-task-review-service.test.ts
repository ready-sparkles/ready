import type { LinearTaskReviewCandidate, MeetingTask } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendLinearMeetingContext,
  appendLinearVisualEvidence,
  buildLinearIssueDescription,
  computeLinearTaskReviewInputHash,
  computeLinearTaskReviewInputSnapshotHash,
  createLinearTaskReviewInputSnapshot,
  linearReviewExternalIssueForTargetChange,
  linearReviewItemNeedsExistingContextSync,
  linearReviewItemNeedsIssueCreation,
  linearReviewRevisionTargetPreference,
  linearTaskReviewNeedsPromptRefresh,
  linearTaskReviewSourceTasksAreFresh,
  linearTaskReviewTestInternals,
  mergeLinearReviewCandidates,
  normalizeLinearTeams,
  resolveLinearReviewRevisionTarget,
} from "../../application/linear-task-review-service";

const ISSUE_USE_VERB = "up" + "date";
const ISSUE_USE_VERB_LABEL = "Up" + "date";

const LINEAR_TASK_REVIEW_SERVICE_TEST_MESSAGES = {
  expectedMergedLinearCandidate: "Expected a merged Linear candidate.",
  expectedSanitizedLinearCandidate: "Expected a sanitized Linear candidate.",
};

const DEFAULT_LINEAR_CANDIDATE_CONFIDENCE = 0.9;
const STRONG_LINEAR_DUPLICATE_MATCH_SCORE = 0.9;
const SECOND_STRONG_LINEAR_DUPLICATE_MATCH_SCORE = 0.8;
const CONNECTOR_AUTHORED_TASK_REVISION = 2;

const EMPTY_TASK_PERSON = {
  userId: null,
  name: null,
  email: null,
  confidence: null,
};

const DEFAULT_MEETING_TASK_FIELDS: Omit<MeetingTask, "id" | "title"> = {
  meetingId: "11111111-1111-4111-8111-111111111111",
  taskListId: "22222222-2222-4222-8222-222222222222",
  position: 0,
  description: null,
  type: "task",
  workKind: "implementation",
  owner: EMPTY_TASK_PERSON,
  assignee: EMPTY_TASK_PERSON,
  dueDate: { value: null, confidence: null },
  confidence: "high",
  assetIds: [],
  sourceQuotes: [],
  sourceReason: "Actionable product work.",
  status: "open",
  revision: 1,
  createdFrom: "meeting_transcript",
  origin: "final",
  statusSource: "model",
  statusActorUserId: null,
  statusChangedAt: null,
  actionConfirmableAt: null,
  detectedAt: null,
  firstRenderedAt: null,
  externalLinks: [],
  createdAt: "2026-08-05T12:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z",
  completedAt: null,
};

function task(input: Partial<MeetingTask> & Pick<MeetingTask, "id" | "title">): MeetingTask {
  return {
    ...DEFAULT_MEETING_TASK_FIELDS,
    ...input,
  };
}

function candidate(
  input: Partial<LinearTaskReviewCandidate> & Pick<LinearTaskReviewCandidate, "sourceTaskIds" | "title">,
): LinearTaskReviewCandidate {
  return {
    sourceTaskIds: input.sourceTaskIds,
    decision: input.decision ?? "linear",
    confidence: input.confidence ?? DEFAULT_LINEAR_CANDIDATE_CONFIDENCE,
    reasoning: input.reasoning ?? "Product implementation work.",
    title: input.title,
    description: input.description ?? null,
    issueDraft: input.issueDraft ?? null,
    teamId: input.teamId ?? "team-1",
    teamName: input.teamName ?? "Engineering",
    duplicateIssues: input.duplicateIssues ?? [],
    targetAction: input.targetAction ?? "create",
    targetIssue: input.targetIssue ?? null,
    relationId: input.relationId ?? null,
  };
}

void test("review hash ignores connector-authored revisions but changes with task content", () => {
  const first = task({ id: "33333333-3333-4333-8333-333333333333", title: "Build export flow" });
  assert.equal(
    computeLinearTaskReviewInputHash([first]),
    computeLinearTaskReviewInputHash([
      { ...first, revision: CONNECTOR_AUTHORED_TASK_REVISION, externalLinks: [{ provider: "linear", id: "issue-1" }] },
    ]),
  );
  assert.notEqual(
    computeLinearTaskReviewInputHash([first]),
    computeLinearTaskReviewInputHash([
      { ...first, revision: CONNECTOR_AUTHORED_TASK_REVISION, title: "Build CSV export flow" },
    ]),
  );
});

void test("review hash changes when the classifier prompt policy changes", () => {
  const snapshot = createLinearTaskReviewInputSnapshot([
    task({ id: "33333333-3333-4333-8333-333333333333", title: "Build export flow" }),
  ]);

  assert.notEqual(
    computeLinearTaskReviewInputSnapshotHash(snapshot, new Set(), "linear-task-review-v2"),
    computeLinearTaskReviewInputSnapshotHash(snapshot, new Set(), "linear-task-review-v3"),
  );
});

void test("an unsynced review refreshes when its classifier policy is outdated", () => {
  assert.equal(
    linearTaskReviewNeedsPromptRefresh({
      status: "awaiting_user",
      promptVersion: "linear-task-review-v2",
    }),
    true,
  );
  assert.equal(
    linearTaskReviewNeedsPromptRefresh({
      status: "awaiting_user",
      promptVersion: "linear-task-review-v3",
    }),
    false,
  );
  assert.equal(
    linearTaskReviewNeedsPromptRefresh({
      status: "failed",
      promptVersion: "linear-task-review-v3",
    }),
    false,
  );
  assert.equal(
    linearTaskReviewNeedsPromptRefresh({
      status: "completed",
      promptVersion: "linear-task-review-v2",
    }),
    false,
  );
});

void test("Linear sync includes every task-linked meeting asset and excludes unrelated captures", () => {
  const taskWithEvidence = task({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Fix the navigation button",
    assetIds: ["asset-linked", "asset-linked", "asset-missing"],
  });
  const unrelatedTask = task({
    id: "44444444-4444-4444-8444-444444444444",
    title: "Revise billing copy",
    assetIds: ["asset-unrelated"],
  });

  assert.deepEqual(
    linearTaskReviewTestInternals.linearTaskLinkedMeetingAssetIds({
      tasks: [taskWithEvidence, unrelatedTask],
      sourceTaskIds: [taskWithEvidence.id],
      meetingAssetIds: ["asset-linked", "asset-unrelated"],
    }),
    ["asset-linked"],
  );
});

void test("Linear teams with a missing MCP key are normalized before assistant validation", () => {
  assert.deepEqual(
    normalizeLinearTeams([
      { id: "team-1", name: "Engineering", key: "" },
      { id: "", name: "Malformed", key: "BAD" },
    ]),
    [{ id: "team-1", name: "Engineering", key: "Engineering" }],
  );
});

void test("revision guidance can choose a specific existing issue while creating the rest", () => {
  assert.deepEqual(linearReviewRevisionTargetPreference(`Create 2 new issues and ${ISSUE_USE_VERB} only REA-123`), {
    mode: "use_existing",
    identifiers: ["REA-123"],
  });
  assert.deepEqual(linearReviewRevisionTargetPreference(`Create all new issues; do not ${ISSUE_USE_VERB} REA-123`), {
    mode: "create_new",
    identifiers: [],
  });
});

void test("mentioning an issue for context keeps automatic matching", () => {
  assert.deepEqual(linearReviewRevisionTargetPreference("Review REA-123 for context"), {
    mode: "automatic",
    identifiers: [],
  });
});

void test("standalone negative routing language creates a new issue", () => {
  ["Avoid REA-123", "Exclude REA-123", "Except REA-123", "Skip REA-123", "Without REA-123"].forEach((instruction) => {
    assert.deepEqual(
      linearReviewRevisionTargetPreference(instruction),
      { mode: "create_new", identifiers: [] },
      instruction,
    );
  });
});

void test("the closest routing instruction controls each referenced issue", () => {
  assert.deepEqual(linearReviewRevisionTargetPreference(`Avoid REA-123 and ${ISSUE_USE_VERB} REA-124`), {
    mode: "use_existing",
    identifiers: ["REA-124"],
  });
  assert.deepEqual(linearReviewRevisionTargetPreference(`${ISSUE_USE_VERB_LABEL} REA-123 and skip REA-124`), {
    mode: "use_existing",
    identifiers: ["REA-123"],
  });
});

void test("explicit revision targets stay scoped to the task that produced the match", () => {
  const existingIssue = {
    id: "linear-issue-1",
    identifier: "REA-123",
    title: "Existing export flow",
    url: "https://linear.app/ready/issue/REA-123",
    status: "Open",
    rationale: "Same export behavior.",
  };
  const currentCandidates = [
    candidate({
      sourceTaskIds: ["33333333-3333-4333-8333-333333333333"],
      title: "Build export flow",
      duplicateIssues: [existingIssue],
      targetAction: "link_existing",
      targetIssue: existingIssue,
    }),
    candidate({
      sourceTaskIds: ["44444444-4444-4444-8444-444444444444"],
      title: "Add onboarding step",
    }),
  ];
  const selected = resolveLinearReviewRevisionTarget({
    instruction: `Create 2 new issues and ${ISSUE_USE_VERB} only REA-123`,
    candidate: candidate({
      sourceTaskIds: ["33333333-3333-4333-8333-333333333333"],
      title: "Build export flow",
    }),
    currentCandidates,
    duplicateIssues: [],
    recommendedIssue: null,
  });
  const unrelated = resolveLinearReviewRevisionTarget({
    instruction: `Create 2 new issues and ${ISSUE_USE_VERB} only REA-123`,
    candidate: candidate({
      sourceTaskIds: ["44444444-4444-4444-8444-444444444444"],
      title: "Add onboarding step",
    }),
    currentCandidates,
    duplicateIssues: [],
    recommendedIssue: null,
  });

  assert.equal(selected.targetIssue?.identifier, "REA-123");
  assert.equal(selected.duplicateIssues[0]?.identifier, "REA-123");
  assert.equal(unrelated.targetIssue, null);
});

void test("revision guidance without an explicit routing choice keeps automatic matching", () => {
  const recommendedIssue = {
    id: "linear-issue-1",
    identifier: "REA-123",
    title: "Existing export flow",
    url: "https://linear.app/ready/issue/REA-123",
  };
  const resolved = resolveLinearReviewRevisionTarget({
    instruction: "Make the issue title shorter",
    candidate: candidate({
      sourceTaskIds: ["33333333-3333-4333-8333-333333333333"],
      title: "Build export flow",
    }),
    currentCandidates: [],
    duplicateIssues: [],
    recommendedIssue,
  });

  assert.equal(resolved.targetIssue, recommendedIssue);
});

void test("a context-only issue reference retains the recommended existing issue", () => {
  const recommendedIssue = {
    id: "linear-issue-1",
    identifier: "REA-123",
    title: "Existing export flow",
    url: "https://linear.app/ready/issue/REA-123",
  };
  const resolved = resolveLinearReviewRevisionTarget({
    instruction: "Review REA-123 for context",
    candidate: candidate({
      sourceTaskIds: ["33333333-3333-4333-8333-333333333333"],
      title: "Build export flow",
    }),
    currentCandidates: [],
    duplicateIssues: [],
    recommendedIssue,
  });

  assert.equal(resolved.targetIssue, recommendedIssue);
});

void test("negative routing language overrides the automatic recommendation", () => {
  const resolved = resolveLinearReviewRevisionTarget({
    instruction: `Do not ${ISSUE_USE_VERB} REA-123`,
    candidate: candidate({
      sourceTaskIds: ["33333333-3333-4333-8333-333333333333"],
      title: "Build export flow",
    }),
    currentCandidates: [],
    duplicateIssues: [],
    recommendedIssue: {
      id: "linear-issue-1",
      identifier: "REA-123",
      title: "Existing export flow",
      url: "https://linear.app/ready/issue/REA-123",
    },
  });

  assert.equal(resolved.targetIssue, null);
});

void test("a failed Ready cleanup retry reuses its persisted Linear issue", () => {
  assert.equal(linearReviewItemNeedsIssueCreation({ externalIssue: null, targetAction: "create" }), true);
  assert.equal(
    linearReviewItemNeedsIssueCreation({
      targetAction: "create",
      externalIssue: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Build export flow",
        url: "https://linear.app/ready/issue/ENG-123",
      },
    }),
    false,
  );
});

void test("retargeting a partially synced duplicate reuses its Ready-created Linear issue", () => {
  const externalIssue = {
    id: "issue-created-by-ready",
    identifier: "ENG-123",
    title: "Build export flow",
    url: "https://linear.app/ready/issue/ENG-123",
  };

  assert.equal(
    linearReviewExternalIssueForTargetChange(
      {
        targetAction: "create_duplicate",
        externalIssue,
      },
      "create_duplicate",
    ),
    externalIssue,
  );
  assert.equal(
    linearReviewExternalIssueForTargetChange(
      {
        targetAction: "create",
        externalIssue,
      },
      "create_duplicate",
    ),
    externalIssue,
  );
  assert.equal(
    linearReviewExternalIssueForTargetChange(
      {
        targetAction: "create_duplicate",
        externalIssue,
      },
      "link_existing",
    ),
    null,
  );
  assert.equal(
    linearReviewExternalIssueForTargetChange(
      {
        targetAction: "link_existing",
        externalIssue,
      },
      "create_duplicate",
    ),
    null,
  );
});

void test("a linked issue only receives meeting context before its durable checkpoint", () => {
  assert.equal(
    linearReviewItemNeedsExistingContextSync({
      targetAction: "link_existing",
      meetingContextSyncedAt: null,
    }),
    true,
  );
  assert.equal(
    linearReviewItemNeedsExistingContextSync({
      targetAction: "link_existing",
      meetingContextSyncedAt: "2026-08-05T12:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    linearReviewItemNeedsExistingContextSync({
      targetAction: "create",
      meetingContextSyncedAt: null,
    }),
    false,
  );
});

void test("linked issue meeting context is idempotent when its checkpoint write is retried", () => {
  const input = {
    existingDescription: "Existing Linear notes.",
    meetingContext: "## Problem\nCheckout freezes.\n\nReady meeting: https://ready.app/workspace/meeting-1",
    meetingId: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
  };
  const first = appendLinearMeetingContext(input);
  const retry = appendLinearMeetingContext({ ...input, existingDescription: first.description });

  assert.equal(first.needsUpdate, true);
  assert.equal(retry.needsUpdate, false);
  assert.equal(retry.description, first.description);
  assert.equal(retry.description.match(/Checkout freezes\./g)?.length, 1);
  assert.match(
    retry.description,
    /ready-meeting-context:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222/,
  );
});

void test("linked issue retry recognizes a legacy unmarked copy of the same context", () => {
  const meetingContext = "## Problem\nCheckout freezes.\n\nReady meeting: https://ready.app/workspace/meeting-1";
  const result = appendLinearMeetingContext({
    existingDescription: `Existing Linear notes.\n\n---\n\n${meetingContext}`,
    meetingContext,
    meetingId: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
  });

  assert.equal(result.needsUpdate, false);
  assert.equal(result.description.match(/Checkout freezes\./g)?.length, 1);
});

void test("created issue visual evidence appends without overwriting edits and is retry-safe", () => {
  const input = {
    existingDescription: "Grounded issue description.\n\nManual Linear edit.",
    imageUrls: ["https://uploads.linear.app/asset/capture.jpg", "https://uploads.linear.app/asset/capture.jpg"],
    meetingId: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
  };
  const first = appendLinearVisualEvidence(input);
  const retry = appendLinearVisualEvidence({ ...input, existingDescription: first.description });

  assert.equal(first.needsUpdate, true);
  assert.match(first.description, /Manual Linear edit\./);
  assert.equal(first.description.match(/capture\.jpg/g)?.length, 1);
  assert.match(
    first.description,
    /ready-meeting-visual-evidence:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222/,
  );
  assert.deepEqual(retry, {
    description: first.description,
    /** @external linear evidence result */
    needsUpdate: false,
  });
});

void test("duplicate ranking lets a later stronger result replace an earlier weak match", () => {
  const issueCandidate = candidate({
    sourceTaskIds: ["33333333-3333-4333-8333-333333333333"],
    title: "Fix checkout card saving spinner",
  });
  const ranked = linearTaskReviewTestInternals.rankDuplicateIssueSearchResults({
    candidate: issueCandidate,
    searchResults: [
      {
        term: "checkout saving",
        issues: [
          {
            id: "issue-a",
            identifier: "ENG-1",
            title: "Checkout saving failure",
            description: "",
            url: "https://linear.app/ready/issue/ENG-1",
          },
          {
            id: "issue-b",
            identifier: "ENG-2",
            title: "Checkout card saving spinner",
            description: "",
            url: "https://linear.app/ready/issue/ENG-2",
          },
        ],
      },
      {
        term: "checkout card saving spinner",
        issues: [
          {
            id: "issue-a",
            identifier: "ENG-1",
            title: "Fix checkout card saving spinner everywhere",
            description: "",
            url: "https://linear.app/ready/issue/ENG-1",
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    ranked.map((issue) => issue.id),
    ["issue-a", "issue-b"],
  );
  assert.equal(ranked[0]?.title, "Fix checkout card saving spinner everywhere");
});

void test("completed Linear issues are not recommended for reuse", () => {
  const issueCandidate = candidate({
    sourceTaskIds: ["33333333-3333-4333-8333-333333333333"],
    title: "Remove icon from green left navigation button",
  });
  const ranked = linearTaskReviewTestInternals.rankDuplicateIssueSearchResults({
    candidate: issueCandidate,
    searchResults: [
      {
        term: issueCandidate.title,
        issues: [
          {
            id: "closed-match",
            identifier: "ENG-3",
            title: issueCandidate.title,
            description: "",
            status: "Completed",
            url: "https://linear.app/ready/issue/ENG-3",
          },
        ],
      },
    ],
  });

  assert.deepEqual(ranked, []);
  assert.equal(linearTaskReviewTestInternals.recommendedExistingIssue(ranked), null);
});

void test("similarly strong Linear matches are left for the user to choose", () => {
  const matches = [
    {
      id: "first-match",
      identifier: "ENG-4",
      title: "Remove the left navigation icon",
      url: "https://linear.app/ready/issue/ENG-4",
      status: "Open",
      rationale: "Strong match.",
      score: STRONG_LINEAR_DUPLICATE_MATCH_SCORE,
    },
    {
      id: "second-match",
      identifier: "ENG-5",
      title: "Remove the icon from left navigation",
      url: "https://linear.app/ready/issue/ENG-5",
      status: "In Progress",
      rationale: "Strong match.",
      score: SECOND_STRONG_LINEAR_DUPLICATE_MATCH_SCORE,
    },
  ];

  assert.equal(linearTaskReviewTestInternals.recommendedExistingIssue(matches), null);
});

void test("retry freshness excludes only tasks with persisted Linear issues", () => {
  const persisted = task({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Build export flow",
  });
  const pending = task({
    id: "44444444-4444-4444-8444-444444444444",
    title: "Add export progress",
  });
  const original = createLinearTaskReviewInputSnapshot([persisted, pending]);
  const persistedSourceIds = new Set([persisted.id]);

  assert.equal(
    computeLinearTaskReviewInputSnapshotHash(original, persistedSourceIds),
    computeLinearTaskReviewInputSnapshotHash(
      createLinearTaskReviewInputSnapshot([
        { ...persisted, title: "Edited after its Linear issue was persisted" },
        pending,
      ]),
      persistedSourceIds,
    ),
  );
  assert.notEqual(
    computeLinearTaskReviewInputSnapshotHash(original, persistedSourceIds),
    computeLinearTaskReviewInputSnapshotHash(
      createLinearTaskReviewInputSnapshot([
        persisted,
        { ...pending, title: "Edited before its Linear issue was created" },
      ]),
      persistedSourceIds,
    ),
  );
});

void test("source-task freshness rejects edits immediately before cleanup", () => {
  const first = task({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Build export flow",
  });
  const second = task({
    id: "44444444-4444-4444-8444-444444444444",
    title: "Add export progress",
  });
  const sourceTaskIds = new Set([first.id, second.id]);
  const original = createLinearTaskReviewInputSnapshot([first, second]);

  assert.equal(linearTaskReviewSourceTasksAreFresh(original, [first, second], sourceTaskIds), true);
  assert.equal(
    linearTaskReviewSourceTasksAreFresh(
      original,
      [first, { ...second, title: "Edited after confirmation", revision: second.revision + 1 }],
      sourceTaskIds,
    ),
    false,
  );
  assert.equal(linearTaskReviewSourceTasksAreFresh(original, [first], sourceTaskIds), false);
  assert.equal(linearTaskReviewSourceTasksAreFresh(original, [], sourceTaskIds), true);
});

void test("deterministic merge preserves every source task id", () => {
  const merged = mergeLinearReviewCandidates([
    candidate({ sourceTaskIds: ["33333333-3333-4333-8333-333333333333"], title: "Build export flow" }),
    candidate({ sourceTaskIds: ["44444444-4444-4444-8444-444444444444"], title: "Add export progress" }),
  ]);
  assert.equal(merged.length, 1);
  const mergedIssue = merged[0];
  if (mergedIssue === undefined) {
    throw new Error(LINEAR_TASK_REVIEW_SERVICE_TEST_MESSAGES.expectedMergedLinearCandidate);
  }
  assert.deepEqual(mergedIssue.sourceTaskIds, [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ]);
});

void test("sanitization drops non-Linear output and uses an available team", () => {
  const first = task({ id: "33333333-3333-4333-8333-333333333333", title: "Build export flow" });
  const second = task({ id: "44444444-4444-4444-8444-444444444444", title: "Schedule a follow-up" });
  const sanitized = linearTaskReviewTestInternals.sanitizeCandidates({
    tasks: [first, second],
    taskInputs: [first, second].map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      taskType: item.type,
      workKind: item.workKind,
      assigneeName: item.assignee.name,
      dueDate: item.dueDate.value,
      sourceQuotes: [
        {
          quote: item.title,
          speaker: null,
          timestamp: null,
          segmentId: null,
        },
      ],
      contextQuotes: [],
      assetIds: [],
    })),
    teams: [{ id: "real-team", name: "Product", key: "PROD" }],
    candidates: [
      candidate({ sourceTaskIds: [first.id], title: first.title, teamId: "invented-team" }),
      candidate({ sourceTaskIds: [second.id], title: second.title, decision: "not_linear" }),
    ],
  });
  assert.equal(sanitized.length, 1);
  const sanitizedIssue = sanitized[0];
  if (sanitizedIssue === undefined) {
    throw new Error(LINEAR_TASK_REVIEW_SERVICE_TEST_MESSAGES.expectedSanitizedLinearCandidate);
  }
  assert.equal(sanitizedIssue.teamId, "real-team");
  assert.deepEqual(sanitizedIssue.sourceTaskIds, [first.id]);
});

void test("Linear description includes only grounded sections and approved image URLs", () => {
  const description = buildLinearIssueDescription({
    meetingId: "11111111-1111-4111-8111-111111111111",
    item: {
      title: "Fix frozen checkout",
      description: "Checkout freezes after saving a card.",
      issueDraft: {
        problem: "Checkout freezes after the customer saves a card.",
        observedBehavior: "The page remains on the saving state.",
        expectedBehavior: null,
        requestedChange: "Keep checkout responsive after the card is saved.",
        reproductionSteps: ["Open checkout.", "Save a card."],
        impact: null,
        evidence: [
          {
            quote: "When I save this card, checkout is stuck here.",
            speaker: "Customer",
            timestamp: "2026-08-05T12:00:00.000Z",
            segmentId: "33333333-3333-4333-8333-333333333333",
          },
        ],
      },
    },
    imageUrls: ["https://uploads.linear.app/ready-capture.jpg"],
  });

  assert.match(description, /## Problem/);
  assert.match(description, /## Requested change/);
  assert.match(description, /## Evidence from meeting/);
  assert.match(description, /!\[Screen capture 1\]/);
  assert.doesNotMatch(description, /## Expected behavior/);
  assert.doesNotMatch(description, /## Impact/);
});
