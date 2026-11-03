import type { getMeetingById, getTranscriptForMeeting } from "@readymeet/db";
import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePostMeetingPipelineEligibility } from "../../domain/post-meeting-pipeline-eligibility";

type EligibilityInput = Parameters<typeof evaluatePostMeetingPipelineEligibility>[0];
type MeetingRow = NonNullable<Awaited<ReturnType<typeof getMeetingById>>>;
type TranscriptBundle = NonNullable<Awaited<ReturnType<typeof getTranscriptForMeeting>>>;
type TranscriptSegmentRow = Extract<TranscriptBundle["segments"][number], { meetingTurnId: string | null }>;
const MIN_ELIGIBLE_HUMAN_TRANSCRIPT_WORDS = 10;
const TEST_MEETING_ID = "00000000-0000-0000-0000-000000000001";
const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const TEST_USER_ID = "00000000-0000-0000-0000-000000000003";
const TEST_TRANSCRIPT_ID = "00000000-0000-0000-0000-000000000004";
const TEST_SEGMENT_ASSISTANT_ID = "00000000-0000-0000-0000-000000000005";
const TEST_SEGMENT_HUMAN_ID = "00000000-0000-0000-0000-000000000006";

function meetingRow(input: Pick<MeetingRow, "startedAt" | "endedAt">): MeetingRow {
  return {
    id: TEST_MEETING_ID,
    title: "Pipeline eligibility test",
    roomName: "pipeline-eligibility-test",
    meetingLinkId: null,
    instanceNumber: 1,
    workspaceId: TEST_WORKSPACE_ID,
    createdByUserId: TEST_USER_ID,
    kind: "standard",
    status: "ended",
    isConfidential: false,
    confidentialitySource: null,
    confidentialityUpdatedByUserId: null,
    confidentialityUpdatedAt: null,
    createdAt: input.startedAt ?? new Date("2026-05-04T12:00:00.000Z"),
    hiddenFromHistoryAt: null,
    hiddenFromHistoryReason: null,
    ...input,
  };
}

function transcriptSegment(input: {
  id: string;
  speakerRole: TranscriptSegmentRow["speakerRole"];
  content: string;
  startedAt: Date;
  endedAt: Date | null;
}): TranscriptSegmentRow {
  return {
    id: input.id,
    transcriptId: TEST_TRANSCRIPT_ID,
    speakerIdentity: input.speakerRole === "human" ? "human:test" : "assistant:test",
    speakerUserId: null,
    speakerRole: input.speakerRole,
    speakerName: input.speakerRole === "human" ? "Personbr" : "Assistant",
    source: "legacy-transcript",
    sourceSegmentId: null,
    meetingTurnId: null,
    agentProfileId: null,
    agentOwnerUserId: null,
    voiceId: null,
    content: input.content,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    createdAt: input.startedAt,
  };
}

function transcriptBundle(input: { segments: TranscriptSegmentRow[] }): TranscriptBundle {
  return {
    transcript: {
      id: TEST_TRANSCRIPT_ID,
      meetingId: TEST_MEETING_ID,
      source: "livekit-python-live",
      metadata: { mode: "agent-live-finalized" },
      createdAt: input.segments[0]?.startedAt ?? new Date("2026-05-04T12:00:00.000Z"),
    },
    segments: input.segments,
  };
}

function eligibilityInput(input: { meeting: MeetingRow; transcriptData: TranscriptBundle }): EligibilityInput {
  return input;
}

void test("solo meetings with persisted human transcript rows are eligible for the post-meeting pipeline", () => {
  const startedAt = new Date("2026-05-04T12:00:00.000Z");
  const endedAt = new Date("2026-05-04T12:01:00.000Z");

  const eligibility = evaluatePostMeetingPipelineEligibility(
    eligibilityInput({
      meeting: meetingRow({ startedAt, endedAt }),
      transcriptData: transcriptBundle({
        segments: [
          transcriptSegment({
            id: TEST_SEGMENT_ASSISTANT_ID,
            speakerRole: "assistant",
            content: "Sure, I can help with that.",
            startedAt,
            endedAt,
          }),
          transcriptSegment({
            id: TEST_SEGMENT_HUMAN_ID,
            speakerRole: "human",
            content: "No niin testataan suomenkielinen puhe ja varmistetaan että tehtävät syntyvät kokouksen jälkeen.",
            startedAt,
            endedAt,
          }),
        ],
      }),
    }),
  );

  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.humanTranscriptWordCount >= MIN_ELIGIBLE_HUMAN_TRANSCRIPT_WORDS, true);
});

void test("assistant-only transcript rows still do not make a meeting eligible", () => {
  const startedAt = new Date("2026-05-04T12:00:00.000Z");
  const endedAt = new Date("2026-05-04T12:01:00.000Z");

  const eligibility = evaluatePostMeetingPipelineEligibility(
    eligibilityInput({
      meeting: meetingRow({ startedAt, endedAt }),
      transcriptData: transcriptBundle({
        segments: [
          transcriptSegment({
            id: TEST_SEGMENT_ASSISTANT_ID,
            speakerRole: "assistant",
            content:
              "I can create notes and tasks after this meeting, but assistant speech should not count as human transcript.",
            startedAt,
            endedAt,
          }),
        ],
      }),
    }),
  );

  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, "too_short_transcript");
});
