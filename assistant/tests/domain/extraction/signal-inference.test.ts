import type { MeetingExtraction } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { inferSignalsFromValidatedContent } from "../../../domain/extraction/signal-inference";

function sourceSpan(overrides: Partial<MeetingExtraction["decisions"][number]["sourceSpans"][number]> = {}) {
  return {
    excerpt: "Let’s pin the charting library for now.",
    lineStart: 1,
    lineEnd: 1,
    segmentIds: ["11111111-1111-4111-8111-111111111111"],
    startedAt: "2026-04-26T12:00:00.000Z",
    endedAt: "2026-04-26T12:00:04.000Z",
    verificationStatus: "verified" as const,
    ...overrides,
  };
}

const PIN_CHARTING_LIBRARY_DECISION_TEXT = "Pin the charting library to restore Safari 15 support.";
const PIN_CHARTING_LIBRARY_SHORT_TEXT = "Pin the charting library.";
const PARTNER_RESEARCH_QUESTION_TEXT = "Find and compare 20 relevant companies that could partner with us.";
const EXISTING_SIGNAL_REASONING = "Already registered by the signal model.";

const baseExtraction = {
  actionItems: [],
  decisions: [],
  highlights: [],
  keyTopics: [],
  openQuestions: [],
  risks: [],
  signals: [],
} satisfies Pick<
  MeetingExtraction,
  "actionItems" | "decisions" | "highlights" | "keyTopics" | "openQuestions" | "risks" | "signals"
>;

void test("validated decisions infer decisions_made signal", () => {
  const signals = inferSignalsFromValidatedContent({
    ...baseExtraction,
    decisions: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: PIN_CHARTING_LIBRARY_DECISION_TEXT,
        finality: "final",
        confidence: "high",
        sourceSpans: [sourceSpan()],
      },
    ],
  });

  assert.equal(signals[0]?.key, "decisions_made");
  assert.equal(signals[0].confidence, "high");
  assert.equal(signals[0].namespace, "readymeet.core");
  assert.equal(signals[0].origin?.kind, "core_rule");
  assert.match(signals[0].reasoning ?? "", /validated decisions/i);
});

void test("decisions_made inference ignores unverified decisions and existing signals", () => {
  assert.deepEqual(
    inferSignalsFromValidatedContent({
      ...baseExtraction,
      decisions: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          text: PIN_CHARTING_LIBRARY_SHORT_TEXT,
          finality: "final",
          confidence: "high",
          sourceSpans: [sourceSpan({ verificationStatus: "unverified" })],
        },
      ],
    }),
    [],
  );

  assert.deepEqual(
    inferSignalsFromValidatedContent({
      ...baseExtraction,
      decisions: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          text: PIN_CHARTING_LIBRARY_SHORT_TEXT,
          finality: "final",
          confidence: "high",
          sourceSpans: [sourceSpan()],
        },
      ],
      signals: [
        {
          key: "decisions_made",
          confidence: "medium",
          sourceSpans: [sourceSpan()],
          reasoning: EXISTING_SIGNAL_REASONING,
        },
      ],
    }),
    [],
  );
});

void test("web research task is inferred from grounded open research requests", () => {
  const signals = inferSignalsFromValidatedContent({
    ...baseExtraction,
    openQuestions: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        text: PARTNER_RESEARCH_QUESTION_TEXT,
        priority: "high",
        sourceSpans: [
          sourceSpan({
            excerpt: "Can you find and compare 20 relevant companies for this workflow?",
          }),
        ],
      },
    ],
  });

  const researchSignal = signals.find((signal) => signal.key === "web_research_task_identified");
  assert.equal(researchSignal?.confidence, "high");
  assert.match(researchSignal.reasoning ?? "", /web-backed research/i);
});
