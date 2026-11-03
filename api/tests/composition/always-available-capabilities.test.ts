import {
  closeDbPool,
  createMeeting,
  insertCapabilityRecommendations,
  upsertCapability,
  upsertMeetingExtraction,
  upsertParticipantPresence,
  upsertUser,
} from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { ensureAlwaysAvailableCapabilityRecommendationsForMeeting } from "../../application/always-available-capabilities";

const STANDARD_CAPABILITY_DEFAULT_PRIORITY = 80;
const CUSTOMER_FOLLOW_UP_DEFAULT_PRIORITY = 88;
const MEETING_COACHING_DEFAULT_PRIORITY = 40;
const PARTICIPANT_FOLLOW_UP_DEFAULT_PRIORITY = 39;

after(async () => {
  await closeDbPool();
});

async function upsertStandardTestCapabilities() {
  await upsertCapability({
    key: "draft_internal_recap",
    name: "Team Recap",
    description: "Draft a recap.",
    category: "communication",
    applicableMeetingTypes: ["standup"],
    requiredSignals: [],
    exclusionSignals: [],
    exampleTriggers: ["Draft a recap.", "Send everyone notes."],
    sideEffectScope: "private_draft",
    defaultPriority: STANDARD_CAPABILITY_DEFAULT_PRIORITY,
    isActive: true,
    metadata: {},
  });
  await upsertCapability({
    key: "file_issue_or_bug",
    name: "Bug Report",
    description: "File a bug report.",
    category: "execution",
    applicableMeetingTypes: ["team_sync", "product_review", "standup", "planning", "postmortem", "other"],
    requiredSignals: [{ key: "engineering_issue_identified" }],
    exclusionSignals: [],
    exampleTriggers: ["File a bug report.", "Create an issue."],
    sideEffectScope: "external_action",
    defaultPriority: STANDARD_CAPABILITY_DEFAULT_PRIORITY,
    isActive: true,
    metadata: {},
  });
  await upsertCapability({
    key: "draft_decision_brief",
    name: "Decision Brief",
    description: "Legacy removed decision brief.",
    category: "documentation",
    applicableMeetingTypes: ["standup"],
    requiredSignals: [],
    exclusionSignals: [],
    exampleTriggers: ["Draft a decision brief.", "Capture the decision."],
    sideEffectScope: "shared_draft",
    defaultPriority: STANDARD_CAPABILITY_DEFAULT_PRIORITY,
    isActive: true,
    metadata: {},
  });
  await upsertCapability({
    key: "draft_external_follow_up",
    name: "Customer Follow-Up",
    description: "Draft customer follow-up.",
    category: "communication",
    applicableMeetingTypes: ["sales_call", "customer_success", "interview", "standup", "other"],
    requiredSignals: [{ key: "external_participants_present" }, { key: "action_commitments_made" }],
    exclusionSignals: [],
    exampleTriggers: ["Draft customer follow-up.", "Follow up externally."],
    sideEffectScope: "private_draft",
    defaultPriority: CUSTOMER_FOLLOW_UP_DEFAULT_PRIORITY,
    isActive: true,
    metadata: {},
  });
}

async function upsertAlwaysAvailableTestCapabilities() {
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
    exampleTriggers: ["Give meeting feedback.", "Review this meeting."],
    sideEffectScope: "none",
    defaultPriority: MEETING_COACHING_DEFAULT_PRIORITY,
    isActive: true,
    metadata: {
      /** @external capability fixture */
      alwaysAvailable: true,
    },
  });
  await upsertCapability({
    key: "draft_participant_follow_up",
    name: "Participant Follow-Up",
    description: "Draft participant follow-up.",
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
    exampleTriggers: ["Draft a follow-up.", "Follow up with participants."],
    sideEffectScope: "private_draft",
    defaultPriority: PARTICIPANT_FOLLOW_UP_DEFAULT_PRIORITY,
    isActive: true,
    metadata: {
      /** @external capability fixture */
      alwaysAvailable: true,
    },
  });
}

async function upsertCapabilities() {
  await upsertStandardTestCapabilities();
  await upsertAlwaysAvailableTestCapabilities();
}

async function createMeetingWithBaseRecommendation(input: { hasGuest?: boolean; baseCapabilityKey?: string }) {
  await upsertCapabilities();
  const organizer = await upsertUser({
    email: `${randomUUID()}@readymeet.test`,
    displayName: "Organizer User",
  });
  const meeting = await createMeeting({
    title: "Always available capability test",
    roomName: `always-${randomUUID()}`,
    createdByUserId: organizer.id,
  });

  const guest =
    input.hasGuest === true
      ? await upsertUser({
          email: `${randomUUID()}@readymeet.test`,
          displayName: "Personaz",
        })
      : null;
  if (guest) {
    await upsertParticipantPresence({
      meetingId: meeting.id,
      userId: guest.id,
      role: "guest",
    });
  }

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
  await insertCapabilityRecommendations([
    {
      meetingId: meeting.id,
      extractionId: extraction.id,
      capabilityKey: input.baseCapabilityKey ?? "file_issue_or_bug",
      rank: 1,
      rawScore: STANDARD_CAPABILITY_DEFAULT_PRIORITY,
      finalScore: STANDARD_CAPABILITY_DEFAULT_PRIORITY,
      signalsMatched: [],
      signalsMissing: [],
      exclusionSignalsChecked: [],
      reasoning: "Base recommendation.",
      payload: {},
      confidence: "medium",
      selectionPromptVersion: "test-always",
      selectionModel: "mock-selector",
    },
  ]);

  return { meeting, guest };
}

void test("ensureAlwaysAvailableCapabilityRecommendationsForMeeting appends coaching and participant follow-up", async () => {
  const { meeting, guest } = await createMeetingWithBaseRecommendation({ hasGuest: true });
  const recommendations = await ensureAlwaysAvailableCapabilityRecommendationsForMeeting(meeting.id);

  assert.deepEqual(
    recommendations.map((recommendation) => recommendation.capabilityKey),
    ["file_issue_or_bug", "meeting_coaching", "draft_participant_follow_up"],
  );
  assert.equal(recommendations[1]?.payload.buttonLabel, "Review how the meeting went");
  assert.equal(recommendations[2]?.payload.buttonLabel, "Draft follow-up for Personaz");
  assert.deepEqual(recommendations[2].payload.recipientUserIds, [guest?.id]);
});

void test("ensureAlwaysAvailableCapabilityRecommendationsForMeeting skips follow-up for organizer-only meetings", async () => {
  const { meeting } = await createMeetingWithBaseRecommendation({ hasGuest: false });
  const recommendations = await ensureAlwaysAvailableCapabilityRecommendationsForMeeting(meeting.id);

  assert.deepEqual(
    recommendations.map((recommendation) => recommendation.capabilityKey),
    ["file_issue_or_bug", "meeting_coaching"],
  );
});

void test("ensureAlwaysAvailableCapabilityRecommendationsForMeeting avoids duplicate follow-up options", async () => {
  const { meeting } = await createMeetingWithBaseRecommendation({
    hasGuest: true,
    baseCapabilityKey: "draft_external_follow_up",
  });
  const recommendations = await ensureAlwaysAvailableCapabilityRecommendationsForMeeting(meeting.id);

  assert.deepEqual(
    recommendations.map((recommendation) => recommendation.capabilityKey),
    ["draft_external_follow_up", "meeting_coaching"],
  );
});

void test("ensureAlwaysAvailableCapabilityRecommendationsForMeeting hides stale removed recommendations", async () => {
  const { meeting } = await createMeetingWithBaseRecommendation({
    hasGuest: true,
    baseCapabilityKey: "draft_decision_brief",
  });
  const recommendations = await ensureAlwaysAvailableCapabilityRecommendationsForMeeting(meeting.id);

  assert.deepEqual(
    recommendations.map((recommendation) => recommendation.capabilityKey),
    ["meeting_coaching", "draft_participant_follow_up"],
  );
});
