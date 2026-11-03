import "../../../composition/wire";

import {
  closeDbPool,
  createMeeting,
  upsertCapability,
  upsertMeetingExtraction,
  upsertParticipantPresence,
  upsertUser,
} from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type {
  CapabilitySelectionModelRunner,
  SelectionModelToolCall,
} from "../../../application/selection-orchestrator";
import { runSelection } from "../../../application/selection-orchestrator";

const FILE_ISSUE_DEFAULT_PRIORITY = 90;
const MEETING_COACHING_DEFAULT_PRIORITY = 40;
const DRAFT_FOLLOW_UP_DEFAULT_PRIORITY = 39;
const SELECTION_RUNNER_QUOTA_EXHAUSTED_MESSAGE = "quota exhausted";

class ScriptedSelectionRunner implements CapabilitySelectionModelRunner {
  constructor(private readonly calls: SelectionModelToolCall[]) {}

  async createPayloads(): Promise<SelectionModelToolCall[]> {
    return this.calls;
  }
}

class ThrowingSelectionRunner implements CapabilitySelectionModelRunner {
  async createPayloads(): Promise<SelectionModelToolCall[]> {
    throw new Error(SELECTION_RUNNER_QUOTA_EXHAUSTED_MESSAGE);
  }
}

after(async () => {
  await closeDbPool();
});

async function createCompletedExtraction() {
  await upsertCapability({
    key: "file_issue_or_bug",
    name: "Bug Report",
    description: "File engineering issues.",
    category: "execution",
    applicableMeetingTypes: ["team_sync", "product_review", "standup", "planning", "postmortem", "other"],
    requiredSignals: [{ key: "engineering_issue_identified" }],
    exclusionSignals: [],
    exampleTriggers: ["We found a bug.", "File this issue."],
    sideEffectScope: "external_action",
    defaultPriority: FILE_ISSUE_DEFAULT_PRIORITY,
    /** @external capability catalog active flag */
    isActive: true,
    metadata: {},
  });

  const user = await upsertUser({
    email: `${randomUUID()}@readymeet.test`,
    displayName: "Selection Test User",
  });
  const meeting = await createMeeting({
    title: "Selection test meeting",
    roomName: `selection-${randomUUID()}`,
    createdByUserId: user.id,
  });
  const extraction = await upsertMeetingExtraction({
    meetingId: meeting.id,
    status: "completed",
    meetingType: "product_review",
    participants: [{ name: "Personbi", roleHint: "PM", confidence: "high" }],
    summaryShort: "The team agreed on follow-up work.",
    summaryBullets: ["The export flow fails for enterprise accounts."],
    actionItems: [
      {
        id: randomUUID(),
        title: "File the export failure bug",
        ownerHint: { name: "Personbi", confidence: "high" },
        confidence: "high",
        sourceSpans: [
          {
            excerpt: "I will file the export failure bug.",
            lineStart: 1,
            lineEnd: 1,
            segmentIds: [],
            verificationStatus: "verified",
          },
        ],
      },
    ],
    decisions: [],
    signals: [
      {
        key: "engineering_issue_identified",
        confidence: "high",
        sourceSpans: [
          {
            excerpt: "The export flow fails for enterprise accounts.",
            lineStart: 1,
            lineEnd: 1,
            segmentIds: [],
            verificationStatus: "verified",
          },
        ],
      },
    ],
    extractionModel: "mock-extractor",
    extractionPromptVersion: "1.1.8",
    transcriptHash: randomUUID(),
    startedAt: new Date(),
    completedAt: new Date(),
  });

  return extraction;
}

async function upsertAlwaysAvailableCapabilities() {
  await upsertCapability({
    key: "meeting_coaching",
    name: "Meeting Feedback",
    description: "Review the meeting.",
    category: "preparation",
    applicableMeetingTypes: [
      "team_sync",
      "one_on_one",
      "sales_call",
      "customer_success",
      "product_review",
      "standup",
      "interview",
      "planning",
      "brainstorm",
      "retrospective",
      "postmortem",
      "manager_check_in",
      "other",
    ],
    requiredSignals: [],
    exclusionSignals: [],
    exampleTriggers: ["Give meeting feedback.", "Review how this meeting went."],
    sideEffectScope: "none",
    defaultPriority: MEETING_COACHING_DEFAULT_PRIORITY,
    /** @external capability catalog active flag */
    isActive: true,
    metadata: { /** @external capability catalog metadata contract */ alwaysAvailable: true },
  });
  await upsertCapability({
    key: "draft_participant_follow_up",
    name: "Participant Follow-Up",
    description: "Draft a follow-up for participants.",
    category: "communication",
    applicableMeetingTypes: [
      "team_sync",
      "one_on_one",
      "sales_call",
      "customer_success",
      "product_review",
      "standup",
      "interview",
      "planning",
      "brainstorm",
      "retrospective",
      "postmortem",
      "manager_check_in",
      "other",
    ],
    requiredSignals: [],
    exclusionSignals: [],
    exampleTriggers: ["Draft a follow-up.", "Help me follow up with everyone."],
    sideEffectScope: "private_draft",
    defaultPriority: DRAFT_FOLLOW_UP_DEFAULT_PRIORITY,
    /** @external capability catalog active flag */
    isActive: true,
    metadata: { /** @external capability catalog metadata contract */ alwaysAvailable: true },
  });
}

void test("selection is idempotent for the same extraction and prompt version", async () => {
  const extraction = await createCompletedExtraction();
  const runner = new ScriptedSelectionRunner([
    {
      name: "payload_file_issue_or_bug",
      argumentsText: JSON.stringify({
        reasoning: "The extraction includes a concrete export failure.",
        confidence: "high",
        title: "Export failure",
        description: "The export flow fails for enterprise accounts.",
        severity_hint: "medium",
        issues: [
          {
            title: "Fix enterprise export failure",
            description: "The export flow fails for enterprise accounts.",
            severity_hint: "medium",
          },
        ],
      }),
    },
  ]);

  const first = await runSelection({
    extractionId: extraction.id,
    promptVersion: "test-1.0.0",
    modelRunner: runner,
    model: "mock-selector",
  });
  const second = await runSelection({
    extractionId: extraction.id,
    promptVersion: "test-1.0.0",
    modelRunner: new ScriptedSelectionRunner([]),
    model: "mock-selector",
  });

  assert.ok(first.recommendations.length !== 0);
  assert.deepEqual(
    second.recommendations.map((recommendation) => recommendation.id),
    first.recommendations.map((recommendation) => recommendation.id),
  );
});

void test("selection creates new rows for a new prompt version and falls back on payload failures", async () => {
  const extraction = await createCompletedExtraction();
  const first = await runSelection({
    extractionId: extraction.id,
    promptVersion: "test-1.0.0",
    modelRunner: new ScriptedSelectionRunner([]),
    model: "mock-selector",
  });
  const second = await runSelection({
    extractionId: extraction.id,
    promptVersion: "test-1.0.1",
    modelRunner: new ScriptedSelectionRunner([]),
    model: "mock-selector",
  });

  assert.ok(first.recommendations.length !== 0);
  assert.equal(second.recommendations.length, first.recommendations.length);
  assert.notEqual(second.recommendations[0]?.id, first.recommendations[0]?.id);
  const secondBugRecommendation = second.recommendations.find(
    (recommendation) => recommendation.capabilityKey === "file_issue_or_bug",
  );
  assert.ok(secondBugRecommendation);
  assert.equal(secondBugRecommendation.reasoning, "Automatic reasoning generation failed.");
  assert.equal(secondBugRecommendation.confidence, "low");
});

void test("selection persists ranked recommendations when payload generation throws", async () => {
  const extraction = await createCompletedExtraction();
  const result = await runSelection({
    extractionId: extraction.id,
    promptVersion: "test-payload-throw",
    modelRunner: new ThrowingSelectionRunner(),
    model: "mock-selector",
  });

  assert.ok(result.recommendations.length !== 0);
  const bugRecommendation = result.recommendations.find(
    (recommendation) => recommendation.capabilityKey === "file_issue_or_bug",
  );
  assert.ok(bugRecommendation);
  assert.equal(bugRecommendation.reasoning, "Automatic reasoning generation failed.");
  assert.equal(bugRecommendation.confidence, "low");
});

void test("selection persists deterministic defaults even when no signals are present", async () => {
  await upsertAlwaysAvailableCapabilities();
  const organizer = await upsertUser({
    email: `${randomUUID()}@readymeet.test`,
    displayName: "Default Organizer",
  });
  const guest = await upsertUser({
    email: `${randomUUID()}@readymeet.test`,
    displayName: "Participant010",
  });
  const meeting = await createMeeting({
    title: "Default capability meeting",
    roomName: `selection-${randomUUID()}`,
    createdByUserId: organizer.id,
  });
  await upsertParticipantPresence({
    meetingId: meeting.id,
    userId: guest.id,
    role: "guest",
  });
  const extraction = await upsertMeetingExtraction({
    meetingId: meeting.id,
    status: "completed",
    meetingType: "standup",
    extractionModel: "mock-extractor",
    extractionPromptVersion: "1.1.8",
    transcriptHash: randomUUID(),
    signalsStatus: "completed",
    startedAt: new Date(),
    completedAt: new Date(),
  });

  const result = await runSelection({
    extractionId: extraction.id,
    promptVersion: "test-defaults",
    modelRunner: new ScriptedSelectionRunner([]),
    model: "mock-selector",
  });

  assert.deepEqual(
    result.recommendations.map((recommendation) => recommendation.capabilityKey),
    ["meeting_coaching", "draft_participant_follow_up"],
  );
  assert.equal(result.recommendations[0]?.payload.buttonLabel, "Review how the meeting went");
  assert.equal(result.recommendations[1]?.payload.buttonLabel, "Draft follow-up for Participant010");
  assert.deepEqual(result.recommendations[1].payload.recipientUserIds, [guest.id]);
});

void test("selection falls back to coaching when no signal capability passes", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@readymeet.test`,
    displayName: "Empty Selection Test User",
  });
  const meeting = await createMeeting({
    title: "Empty selection meeting",
    roomName: `selection-${randomUUID()}`,
    createdByUserId: user.id,
  });
  const extraction = await upsertMeetingExtraction({
    meetingId: meeting.id,
    status: "completed",
    meetingType: "standup",
    extractionModel: "mock-extractor",
    extractionPromptVersion: "1.1.8",
    transcriptHash: randomUUID(),
    startedAt: new Date(),
    completedAt: new Date(),
  });

  const result = await runSelection({
    extractionId: extraction.id,
    promptVersion: "test-empty",
    modelRunner: new ScriptedSelectionRunner([]),
    model: "mock-selector",
  });

  assert.deepEqual(
    result.recommendations.map((recommendation) => recommendation.capabilityKey),
    ["meeting_coaching"],
  );
});
