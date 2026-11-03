import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingTaskLanguageContext,
  estimateMeetingTaskInputTokens,
  MEETING_TASK_GLOBAL_VERIFICATION_INPUT_TOKEN_BUDGET,
  meetingTaskSemanticSimilarity,
  normalizedTranscriptSimilarity,
} from "../domain/meeting-tasks";

const LONG_TRANSCRIPT_SAMPLE_SEGMENTS = 30;
const MIDDLE_CONTEXT_REPETITIONS = 600;
const MAX_TASK_LANGUAGE_CONTEXT_CHARACTERS = 5_000;
const TOKEN_ESTIMATE_TEST_TEXT_LENGTH = 3_000;
const EXPECTED_LATIN_TOKEN_COUNT = 1_000;
const EXPECTED_CJK_TOKEN_COUNT = 2_400;
const GLOBAL_VERIFICATION_BUDGET_LOWER_BOUND = 200_000;
const GLOBAL_VERIFICATION_BUDGET_UPPER_BOUND = 272_000;
const MINIMUM_RELATED_TRANSCRIPT_SIMILARITY = 0.8;
const MAXIMUM_UNRELATED_TRANSCRIPT_SIMILARITY = 0.7;

void test("meeting task language context reports whole-transcript script evidence", () => {
  const context = buildMeetingTaskLanguageContext([
    "Да, я хочу сходить на вечеринку.",
    "Спасибо.",
    ...Array.from(
      { length: LONG_TRANSCRIPT_SAMPLE_SEGMENTS },
      (_, index) => `English meeting discussion continues across the transcript section ${index + 1}.`,
    ),
  ]);

  assert.match(context, /Whole-transcript script-letter counts: Latin=\d+, Cyrillic=\d+/);
  assert.match(context, /English meeting discussion continues/);
});

void test("meeting task language context samples uniformly across a long transcript", () => {
  const context = buildMeetingTaskLanguageContext([
    "Russian opening marker Русский.",
    "English middle discussion. ".repeat(MIDDLE_CONTEXT_REPETITIONS),
    "English closing marker.",
  ]);

  assert.match(context, /Uniform samples across the entire human transcript/);
  assert.match(context, /Russian opening marker/);
  assert.match(context, /English closing marker/);
  assert.ok(context.length < MAX_TASK_LANGUAGE_CONTEXT_CHARACTERS);
});

void test("meeting task language context defaults empty human speech to English", () => {
  assert.match(buildMeetingTaskLanguageContext(["", "   "]), /Default output language: English/);
});

void test("meeting task token estimate charges CJK text more densely than Latin text", () => {
  const latin = "a".repeat(TOKEN_ESTIMATE_TEST_TEXT_LENGTH);
  const cjk = "会".repeat(TOKEN_ESTIMATE_TEST_TEXT_LENGTH);
  assert.equal(estimateMeetingTaskInputTokens(latin), EXPECTED_LATIN_TOKEN_COUNT);
  assert.equal(estimateMeetingTaskInputTokens(cjk), EXPECTED_CJK_TOKEN_COUNT);
  assert.equal(estimateMeetingTaskInputTokens(""), 0);
});

void test("global verification budget stays inside the standard input pricing tier", () => {
  assert.ok(MEETING_TASK_GLOBAL_VERIFICATION_INPUT_TOKEN_BUDGET < GLOBAL_VERIFICATION_BUDGET_UPPER_BOUND);
  assert.ok(MEETING_TASK_GLOBAL_VERIFICATION_INPUT_TOKEN_BUDGET > GLOBAL_VERIFICATION_BUDGET_LOWER_BOUND);
});

void test("transcript refinement similarity tolerates small STT corrections but rejects unrelated speech", () => {
  assert.ok(
    normalizedTranscriptSimilarity({
      left: "Personaj please send the launch deck tomorrow",
      right: "Personaj, please send the launch deck tomorrow.",
    }) >= MINIMUM_RELATED_TRANSCRIPT_SIMILARITY,
  );
  assert.ok(
    normalizedTranscriptSimilarity({
      left: "Personaj please send the launch deck tomorrow",
      right: "We should discuss pricing next week",
    }) < MINIMUM_RELATED_TRANSCRIPT_SIMILARITY,
  );
});

void test("semantic task matching catches repeated evidence and rejects unrelated tasks", () => {
  const live = { title: "Send the revised launch deck", sourceQuotes: [{ quote: "I will send the deck." }] };
  assert.equal(
    meetingTaskSemanticSimilarity({
      left: live,
      right: {
        title: "Email the launch presentation",
        sourceQuotes: [{ quote: "I will send the deck." }],
      },
    }),
    1,
  );
  assert.ok(
    meetingTaskSemanticSimilarity({
      left: live,
      right: {
        title: "Book the customer interview",
        sourceQuotes: [{ quote: "Let us talk to the customer." }],
      },
    }) < MAXIMUM_UNRELATED_TRANSCRIPT_SIMILARITY,
  );
});
