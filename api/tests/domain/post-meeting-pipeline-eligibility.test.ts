import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePostMeetingPipelineEligibility,
  type PipelineEligibilityInput,
} from "../../domain/post-meeting-pipeline-eligibility";

const MIN_DURATION_MS = 10_000;
const BELOW_MIN_DURATION_MS = 9_999;
const LONG_DURATION_MS = 60_000;
const TEN_HUMAN_WORDS = "one two three four five six seven eight nine ten";
const NINE_HUMAN_WORDS = "one two three four five six seven eight nine";
const TEN_UNICODE_WORDS = "Äiti 東京 １２３ café naïve don't l’été co-operate 42 résumé.";
const MIN_WORD_COUNT = 10;
const BELOW_MIN_WORD_COUNT = 9;

type Segment = NonNullable<PipelineEligibilityInput["transcriptData"]>["segments"][number];

function meeting(durationMs: number): NonNullable<PipelineEligibilityInput["meeting"]> {
  return { startedAt: new Date(0), endedAt: new Date(durationMs) };
}

function segment(input: Partial<Segment> = {}): Segment {
  return {
    speakerRole: "human",
    content: TEN_HUMAN_WORDS,
    startedAt: new Date(0),
    endedAt: new Date(MIN_DURATION_MS),
    ...input,
  };
}

void test("post-meeting eligibility keeps the exact duration and human-word boundaries", () => {
  const cases = [
    {
      durationMs: BELOW_MIN_DURATION_MS,
      content: TEN_HUMAN_WORDS,
      expected: {
        /** @external post-meeting pipeline eligible flag */
        eligible: false,
        reason: "too_short_duration",
        durationMs: BELOW_MIN_DURATION_MS,
        humanTranscriptWordCount: MIN_WORD_COUNT,
      },
    },
    {
      durationMs: MIN_DURATION_MS,
      content: NINE_HUMAN_WORDS,
      expected: {
        /** @external post-meeting pipeline eligible flag */
        eligible: false,
        reason: "too_short_transcript",
        durationMs: MIN_DURATION_MS,
        humanTranscriptWordCount: BELOW_MIN_WORD_COUNT,
      },
    },
    {
      durationMs: MIN_DURATION_MS,
      content: TEN_UNICODE_WORDS,
      expected: {
        /** @external post-meeting pipeline eligible flag */
        eligible: true,
        durationMs: MIN_DURATION_MS,
        humanTranscriptWordCount: MIN_WORD_COUNT,
      },
    },
  ];

  cases.forEach(({ durationMs, content, expected }) => {
    assert.deepEqual(
      evaluatePostMeetingPipelineEligibility({
        meeting: meeting(durationMs),
        transcriptData: { segments: [segment({ content })] },
      }),
      expected,
    );
  });
});

void test("only human segment content counts, including across segments", () => {
  assert.deepEqual(
    evaluatePostMeetingPipelineEligibility({
      meeting: meeting(MIN_DURATION_MS),
      transcriptData: {
        segments: [
          segment({ content: NINE_HUMAN_WORDS }),
          segment({ content: "ten" }),
          segment({ speakerRole: "assistant" }),
          segment({ speakerRole: "unknown" }),
        ],
      },
    }),
    {
      /** @external post-meeting pipeline eligible flag */
      eligible: true,
      durationMs: MIN_DURATION_MS,
      humanTranscriptWordCount: MIN_WORD_COUNT,
    },
  );
});

void test("missing meeting timestamps fall back to all segment endpoints regardless of order or speaker", () => {
  [null, { startedAt: new Date(LONG_DURATION_MS), endedAt: null }, { startedAt: null, endedAt: new Date(0) }].forEach(
    (incompleteMeeting) => {
      assert.deepEqual(
        evaluatePostMeetingPipelineEligibility({
          meeting: incompleteMeeting,
          transcriptData: {
            segments: [
              segment({ startedAt: new Date(MIN_DURATION_MS), endedAt: null }),
              segment({ speakerRole: "assistant", startedAt: null, endedAt: new Date(0) }),
            ],
          },
        }),
        {
          /** @external post-meeting pipeline eligible flag */
          eligible: true,
          durationMs: MIN_DURATION_MS,
          humanTranscriptWordCount: MIN_WORD_COUNT,
        },
      );
    },
  );
});

void test("complete meeting timestamps take precedence over segment times and negative duration stays zero", () => {
  [0, -MIN_DURATION_MS, BELOW_MIN_DURATION_MS].forEach((durationMs) => {
    assert.deepEqual(
      evaluatePostMeetingPipelineEligibility({
        meeting: meeting(durationMs),
        transcriptData: { segments: [segment({ endedAt: new Date(LONG_DURATION_MS) })] },
      }),
      {
        /** @external post-meeting pipeline eligible flag */
        eligible: false,
        reason: "too_short_duration",
        durationMs: Math.max(0, durationMs),
        humanTranscriptWordCount: MIN_WORD_COUNT,
      },
    );
  });
});

void test("missing, empty, or non-human transcript data has zero human words", () => {
  [
    null,
    { segments: [] },
    { segments: [segment({ content: " ... 👋 " })] },
    { segments: [segment({ speakerRole: "assistant" })] },
  ].forEach((transcriptData) => {
    assert.deepEqual(evaluatePostMeetingPipelineEligibility({ meeting: meeting(MIN_DURATION_MS), transcriptData }), {
      /** @external post-meeting pipeline eligible flag */
      eligible: false,
      reason: "too_short_transcript",
      durationMs: MIN_DURATION_MS,
      humanTranscriptWordCount: 0,
    });
  });
  assert.deepEqual(evaluatePostMeetingPipelineEligibility({ meeting: null, transcriptData: null }), {
    /** @external post-meeting pipeline eligible flag */
    eligible: false,
    reason: "too_short_duration",
    durationMs: 0,
    humanTranscriptWordCount: 0,
  });
});

void test("fewer than two segment endpoints or equal endpoints give zero fallback duration", () => {
  [
    { startedAt: null, endedAt: null },
    { startedAt: new Date(MIN_DURATION_MS), endedAt: null },
    { startedAt: new Date(MIN_DURATION_MS), endedAt: new Date(MIN_DURATION_MS) },
  ].forEach((timestamps) => {
    assert.deepEqual(
      evaluatePostMeetingPipelineEligibility({
        meeting: null,
        transcriptData: { segments: [segment(timestamps)] },
      }),
      {
        /** @external post-meeting pipeline eligible flag */
        eligible: false,
        reason: "too_short_duration",
        durationMs: 0,
        humanTranscriptWordCount: MIN_WORD_COUNT,
      },
    );
  });
});
