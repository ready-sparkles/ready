import "../../../composition/wire";

import assert from "node:assert/strict";
import test from "node:test";

import type { RunExtractionInput } from "../../../application/extraction-orchestrator";
import {
  calculateMeetingSnapshotTimeoutMs,
  formatSnapshotTranscript,
  getMeetingSnapshotTimeoutMs,
  isUsableSnapshotResponse,
  validateMeetingSnapshotOutput,
} from "../../../application/extraction-snapshot";

const SNAPSHOT_TEST_TIMEOUT_MIN_MS = 120_000;
const SNAPSHOT_TEST_TIMEOUT_MAX_MS = 240_000;
const SNAPSHOT_TEST_CONFIGURED_MINIMUM_MS = 30_000;
const SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_1 = 1;
const SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_50K = 50_001;
const SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_100K = 100_001;
const SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_150K = 150_001;
const SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_200K = 200_001;
const SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_500K = 500_000;
const SNAPSHOT_TEST_TIMEOUT_EXPECTED_120K = 120_000;
const SNAPSHOT_TEST_TIMEOUT_EXPECTED_150K = 150_000;
const SNAPSHOT_TEST_TIMEOUT_EXPECTED_180K = 180_000;
const SNAPSHOT_TEST_TIMEOUT_EXPECTED_210K = 210_000;
const SNAPSHOT_TEST_TIMEOUT_EXPECTED_240K = 240_000;
const SNAPSHOT_TEST_TIMEOUT_FLOOR_180K = 180_000;
const SNAPSHOT_TEST_TIMEOUT_FLOOR_300K = 300_000;
const SNAPSHOT_TEST_LONG_CONTEXT_REPEAT = 80_000;
const SNAPSHOT_TEST_DURATION_MS_3_2M = 3_200_000;
const SNAPSHOT_TEST_DURATION_MS_8_2M = 8_200_000;
const SNAPSHOT_TEST_FORMATTED_MAX_CHARS = 95_000;
const SNAPSHOT_TEST_ADAPTIVE_MAX_CHARS = 120_000;
const SNAPSHOT_TEST_TRANSCRIPT_SEGMENT_COUNT_400 = 400;
const SNAPSHOT_TEST_SEGMENT_INDEX_PAD_WIDTH = 12;
const SNAPSHOT_TEST_SEGMENT_INTERVAL_MS = 30_000;
const SNAPSHOT_TEST_MEETING_BASE_MS = Date.parse("2026-07-08T17:03:45.371Z");
const SNAPSHOT_TEST_CONTENT_REPEAT_SHORT = 24;
const SNAPSHOT_TEST_SEGMENT_COUNT_SMALL = 3;
const SNAPSHOT_TEST_PARTICIPANT_MOD_2 = 2;
const SNAPSHOT_TEST_SEGMENT_INDEX_FINAL_399 = 399;
const SNAPSHOT_TEST_SEGMENT_INDEX_MIDDLE_174 = 174;
const SNAPSHOT_TEST_SEGMENT_INDEX_MIDDLE_200 = 200;
const SNAPSHOT_TEST_CONTENT_LENGTH = 320;
const SNAPSHOT_TEST_REPEAT_9000 = 9000;
const SNAPSHOT_TEST_TRANSCRIPT_SEGMENT_COUNT_8 = 8;
const SNAPSHOT_TEST_TRANSCRIPT_SEGMENT_COUNT_48 = 48;
const SNAPSHOT_TEST_TRANSCRIPT_MIN_CHARS_90K = 90_000;
const SNAPSHOT_TEST_TRANSCRIPT_MAX_CHARS_790K = 790_000;
const SNAPSHOT_TEST_TRANSCRIPT_CAP_CHARS_780K = 780_000;
const SNAPSHOT_TEST_CONTENT_REPEAT_300 = 300;
const SNAPSHOT_TEST_SEGMENT_COUNT_3 = 3;

void test("snapshot transcript formatter uses the gpt-5.6 Sol context budget beyond the old cap", () => {
  const transcript = Array.from({ length: SNAPSHOT_TEST_TRANSCRIPT_SEGMENT_COUNT_8 }, (_, index) => ({
    id: `11111111-1111-4111-8113-${String(index).padStart(SNAPSHOT_TEST_SEGMENT_INDEX_PAD_WIDTH, "0")}`,
    speakerIdentity: index % SNAPSHOT_TEST_PARTICIPANT_MOD_2 === 0 ? "personbr" : "personbd",
    speakerName: index % SNAPSHOT_TEST_PARTICIPANT_MOD_2 === 0 ? "Personbr" : "Personbd",
    content: `Segment ${index}. ${"Full transcript context should remain available for the snapshot model. ".repeat(SNAPSHOT_TEST_CONTENT_LENGTH)}`,
    startedAt: new Date(SNAPSHOT_TEST_MEETING_BASE_MS + index * SNAPSHOT_TEST_SEGMENT_INTERVAL_MS).toISOString(),
    endedAt: null,
  }));
  const input: RunExtractionInput = {
    meetingId: "11111111-1111-4111-8111-111111111111",
    transcript,
    metadata: {
      title: "Long complete meeting",
      participants: [{ name: "Personbr" }, { name: "Personbd" }],
      startedAt: "2026-07-08T17:03:31.128Z",
      durationMs: SNAPSHOT_TEST_DURATION_MS_8_2M,
    },
  };

  const formatted = formatSnapshotTranscript({ input, model: "gpt-5.6-sol" });

  assert.match(formatted, /complete transcript with 8 segments/);
  assert.ok(formatted.length > SNAPSHOT_TEST_TRANSCRIPT_MIN_CHARS_90K);
  assert.match(formatted, /Segment 7/);
});

void test("snapshot transcript formatter keeps gpt-5.6 Sol below the standard input tier", () => {
  const transcript = Array.from({ length: SNAPSHOT_TEST_TRANSCRIPT_SEGMENT_COUNT_48 }, (_, index) => ({
    id: `11111111-1111-4111-8114-${String(index).padStart(SNAPSHOT_TEST_SEGMENT_INDEX_PAD_WIDTH, "0")}`,
    speakerIdentity: index % SNAPSHOT_TEST_PARTICIPANT_MOD_2 === 0 ? "personbr" : "personbd",
    speakerName: index % SNAPSHOT_TEST_PARTICIPANT_MOD_2 === 0 ? "Personbr" : "Personbd",
    content: `Segment ${index}. ${"This long transcript should be condensed before it crosses the standard input tier. ".repeat(SNAPSHOT_TEST_CONTENT_REPEAT_300)}`,
    startedAt: new Date(SNAPSHOT_TEST_MEETING_BASE_MS + index * SNAPSHOT_TEST_SEGMENT_INTERVAL_MS).toISOString(),
    endedAt: null,
  }));
  const input: RunExtractionInput = {
    meetingId: "11111111-1111-4111-8111-111111111111",
    transcript,
    metadata: {
      title: "Large meeting",
      participants: [
        { name: "Personbr", email: "personbr@example.com" },
        { name: "Personbd", email: "personbd@example.com" },
      ],
      startedAt: "2026-07-08T17:03:31.128Z",
      durationMs: SNAPSHOT_TEST_DURATION_MS_8_2M,
    },
  };

  const formatted = formatSnapshotTranscript({ input, model: "gpt-5.6-sol" });

  assert.doesNotMatch(
    formatted,
    new RegExp(`complete transcript with ${SNAPSHOT_TEST_TRANSCRIPT_SEGMENT_COUNT_48} segments`),
  );
  assert.match(formatted, new RegExp(`capped at ${SNAPSHOT_TEST_TRANSCRIPT_CAP_CHARS_780K}`));
  assert.ok(formatted.length < SNAPSHOT_TEST_TRANSCRIPT_MAX_CHARS_790K);
  assert.match(formatted, /Personbr <personbr@example\.com>/);
});

void test("snapshot transcript formatter condenses CJK text by estimated tokens, not raw chars", () => {
  const transcript = Array.from({ length: SNAPSHOT_TEST_SEGMENT_COUNT_3 }, (_, index) => ({
    id: `11111111-1111-4111-8115-${String(index).padStart(SNAPSHOT_TEST_SEGMENT_INDEX_PAD_WIDTH, "0")}`,
    speakerIdentity: index % SNAPSHOT_TEST_PARTICIPANT_MOD_2 === 0 ? "yuki" : "mei",
    speakerName: index % SNAPSHOT_TEST_PARTICIPANT_MOD_2 === 0 ? "Yuki" : "Mei",
    content: `${index === SNAPSHOT_TEST_SEGMENT_COUNT_3 - 1 ? "最後の約束" : "会議の文脈"}。${"資料確認と次の対応を決めます。".repeat(SNAPSHOT_TEST_REPEAT_9000)}`,
    startedAt: new Date(SNAPSHOT_TEST_MEETING_BASE_MS + index * SNAPSHOT_TEST_SEGMENT_INTERVAL_MS).toISOString(),
    endedAt: null,
  }));
  const input: RunExtractionInput = {
    meetingId: "11111111-1111-4111-8111-111111111111",
    transcript,
    metadata: {
      title: "Large Japanese meeting",
      participants: [{ name: "Yuki" }, { name: "Mei" }],
      startedAt: "2026-07-08T17:03:31.128Z",
      durationMs: SNAPSHOT_TEST_DURATION_MS_3_2M,
    },
  };

  const formatted = formatSnapshotTranscript({ input, model: "gpt-5.6-sol" });

  assert.doesNotMatch(formatted, new RegExp(`complete transcript with ${SNAPSHOT_TEST_SEGMENT_COUNT_SMALL} segments`));
  assert.match(formatted, /adaptive transcript-only condensation|selected transcript-only packet/);
  assert.match(formatted, /最後の約束/);
  assert.ok(formatted.length < SNAPSHOT_TEST_ADAPTIVE_MAX_CHARS);
});

void test("snapshot timeout scales for large prompts", () => {
  const shortTimeout = getMeetingSnapshotTimeoutMs("short transcript");
  const longTimeout = getMeetingSnapshotTimeoutMs("Large meeting context. ".repeat(SNAPSHOT_TEST_LONG_CONTEXT_REPEAT));

  assert.ok(shortTimeout >= SNAPSHOT_TEST_TIMEOUT_MIN_MS);
  assert.ok(longTimeout > shortTimeout);
  assert.ok(longTimeout <= SNAPSHOT_TEST_TIMEOUT_MAX_MS);
});

void test("snapshot timeout scales from two to four minutes by estimated input tokens", () => {
  const configuredMinimumMs = SNAPSHOT_TEST_CONFIGURED_MINIMUM_MS;

  assert.equal(
    calculateMeetingSnapshotTimeoutMs({ estimatedTokens: SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_1, configuredMinimumMs }),
    SNAPSHOT_TEST_TIMEOUT_EXPECTED_120K,
  );
  assert.equal(
    calculateMeetingSnapshotTimeoutMs({ estimatedTokens: SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_50K, configuredMinimumMs }),
    SNAPSHOT_TEST_TIMEOUT_EXPECTED_150K,
  );
  assert.equal(
    calculateMeetingSnapshotTimeoutMs({ estimatedTokens: SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_100K, configuredMinimumMs }),
    SNAPSHOT_TEST_TIMEOUT_EXPECTED_180K,
  );
  assert.equal(
    calculateMeetingSnapshotTimeoutMs({ estimatedTokens: SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_150K, configuredMinimumMs }),
    SNAPSHOT_TEST_TIMEOUT_EXPECTED_210K,
  );
  assert.equal(
    calculateMeetingSnapshotTimeoutMs({ estimatedTokens: SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_200K, configuredMinimumMs }),
    SNAPSHOT_TEST_TIMEOUT_EXPECTED_240K,
  );
  assert.equal(
    calculateMeetingSnapshotTimeoutMs({ estimatedTokens: SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_500K, configuredMinimumMs }),
    SNAPSHOT_TEST_TIMEOUT_EXPECTED_240K,
  );
});

void test("snapshot timeout honors a configured floor without exceeding four minutes", () => {
  assert.equal(
    calculateMeetingSnapshotTimeoutMs({
      estimatedTokens: SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_1,
      configuredMinimumMs: SNAPSHOT_TEST_TIMEOUT_FLOOR_180K,
    }),
    SNAPSHOT_TEST_TIMEOUT_FLOOR_180K,
  );
  assert.equal(
    calculateMeetingSnapshotTimeoutMs({
      estimatedTokens: SNAPSHOT_TEST_TIMEOUT_TOKEN_TIER_1,
      configuredMinimumMs: SNAPSHOT_TEST_TIMEOUT_FLOOR_300K,
    }),
    SNAPSHOT_TEST_TIMEOUT_EXPECTED_240K,
  );
});

void test("snapshot transcript formatter bounds very long transcripts while preserving full-meeting coverage and ending", () => {
  const transcript = Array.from({ length: SNAPSHOT_TEST_TRANSCRIPT_SEGMENT_COUNT_400 }, (_, index) => ({
    id: `11111111-1111-4111-8111-${String(index).padStart(SNAPSHOT_TEST_SEGMENT_INDEX_PAD_WIDTH, "0")}`,
    speakerIdentity: index % SNAPSHOT_TEST_PARTICIPANT_MOD_2 === 0 ? "personbr" : "personbd",
    speakerName: index % SNAPSHOT_TEST_PARTICIPANT_MOD_2 === 0 ? "Personbr" : "Personbd",
    content: `${index === SNAPSHOT_TEST_SEGMENT_INDEX_FINAL_399 ? "Final commitment segment" : "Middle context segment"} ${index}. ${"Detailed meeting context. ".repeat(SNAPSHOT_TEST_CONTENT_REPEAT_SHORT)}`,
    startedAt: new Date(SNAPSHOT_TEST_MEETING_BASE_MS + index * SNAPSHOT_TEST_SEGMENT_INTERVAL_MS).toISOString(),
    endedAt: null,
  }));
  const input: RunExtractionInput = {
    meetingId: "11111111-1111-4111-8111-111111111111",
    transcript,
    metadata: {
      title: "Very long meeting",
      participants: [{ name: "Personbr" }, { name: "Personbd" }],
      startedAt: "2026-07-08T17:03:31.128Z",
      durationMs: SNAPSHOT_TEST_DURATION_MS_3_2M,
    },
  };

  const formatted = formatSnapshotTranscript({ input, model: "gpt-4o-mini" });

  assert.match(formatted, /Transcript source: transcript text only/);
  assert.match(
    formatted,
    new RegExp(
      `(?:adaptive transcript-only condensation|selected transcript-only packet) (?:of|from) ${SNAPSHOT_TEST_TRANSCRIPT_SEGMENT_COUNT_400} segments`,
    ),
  );
  assert.match(
    formatted,
    new RegExp(
      `Middle context segment (?:${SNAPSHOT_TEST_SEGMENT_INDEX_MIDDLE_174}|${SNAPSHOT_TEST_SEGMENT_INDEX_MIDDLE_200})`,
    ),
  );
  assert.match(formatted, new RegExp(`Final commitment segment ${SNAPSHOT_TEST_SEGMENT_INDEX_FINAL_399}`));
  assert.ok(formatted.length < SNAPSHOT_TEST_FORMATTED_MAX_CHARS);
});

void test("snapshot output keeps decisions as final section when there are no next steps", () => {
  const parsed = validateMeetingSnapshotOutput(
    JSON.stringify({
      title: "Roadmap Review",
      summary: [
        "Overview",
        "- The team narrowed the roadmap around enterprise reporting.",
        "",
        "Decisions",
        "- Enterprise reporting will be the next roadmap priority.",
      ].join("\n"),
      actionItems: [],
    }),
  );

  assert.match(parsed.summary, /Decisions\n- Enterprise reporting will be the next roadmap priority\.$/);
});

void test("snapshot output rejects missing summary", () => {
  assert.throws(() =>
    validateMeetingSnapshotOutput(
      JSON.stringify({
        title: "Missing Summary",
        actionItems: [],
      }),
    ),
  );
});

void test("snapshot output rejects missing title", () => {
  assert.throws(() =>
    validateMeetingSnapshotOutput(
      JSON.stringify({
        summary: "Overview\n- The conversation appears to be a brief check-in.",
        actionItems: [],
      }),
    ),
  );
});

void test("only a complete, valid snapshot response is billable", () => {
  const valid = JSON.stringify({
    title: "Roadmap Review",
    summary: "Overview\n- The team narrowed the roadmap.",
    actionItems: [],
  });
  assert.equal(isUsableSnapshotResponse({ status: "completed", output_text: valid }), true);
  assert.equal(
    isUsableSnapshotResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: valid,
    }),
    false,
  );
  assert.equal(isUsableSnapshotResponse({ status: "completed", output_text: "" }), false);
  assert.equal(isUsableSnapshotResponse({ status: "completed", output_text: '{"title":"Cut off' }), false);
  assert.equal(
    isUsableSnapshotResponse({
      status: "completed",
      output_text: JSON.stringify({ title: "No summary", actionItems: [] }),
    }),
    false,
  );
});
