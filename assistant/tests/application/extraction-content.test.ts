import assert from "node:assert/strict";
import test from "node:test";

import { validateHumanReadableExtraction } from "../../application/extraction-content";
import type { TranscriptLineReference } from "../../application/extraction-tools";

const CONTENT_TEST_LINE_FIRST = 1;
const CONTENT_TEST_LINE_SECOND = 2;
const CONTENT_TEST_DURATION_MS = 1000;
const CONTENT_TEST_MAX_SUMMARY_BULLETS = 6;
const CONTENT_TEST_HIGHLIGHT_THEME_MAX_CHARS = 40;
const CONTENT_TEST_HIGHLIGHT_TAKEAWAY_MAX_CHARS = 200;

const CONTENT_TEST_MESSAGES = {
  shipDashboardRedesign: "We should ship the dashboard redesign next month.",
  writeRolloutTaskList: "I can write the rollout task list today.",
  shipDecisionText: "Ship the dashboard redesign next month.",
  writeRolloutTitle: "Write the rollout task list",
  absentTranscriptText: "This text is absent from the transcript.",
  absentQuestionText: "What text is absent from the transcript?",
  classificationReasoning: "The team discussed a product change.",
  summaryShort: "The team discussed shipping the dashboard redesign.",
  summaryBulletDashboard: "The dashboard redesign was discussed.",
  summaryBulletLeo: "Personav owned a task list.",
  summaryBulletTimeline: "The timeline was next month.",
  highlightTheme: "Dashboard redesign",
  highlightTakeaway: "The team discussed shipping the dashboard redesign next month.",
  keyTopicDashboard: "Dashboard redesign",
  writeRolloutTodayTitle: "Write the rollout task list today",
  dueHintToday: "today",
  emptyIsoDate: "",
  emptyOwnerName: "",
  lowConfidence: "low",
  highConfidence: "high",
  finalityFinal: "final",
  productReviewMedium: "Product discussion.",
  teamDiscussedDashboard: "The team discussed dashboard work.",
  summaryBulletOne: "One",
  summaryBulletTwo: "Two",
  summaryBulletThree: "Three",
} as const;

const transcriptLines: TranscriptLineReference[] = [
  {
    lineNumber: CONTENT_TEST_LINE_FIRST,
    segmentId: "11111111-1111-4111-8111-111111111111",
    speakerName: "Personbi",
    content: "We should ship the dashboard redesign next month.",
    startedAt: "2026-04-24T10:00:00.000Z",
    endedAt: "2026-04-24T10:00:04.000Z",
  },
  {
    lineNumber: CONTENT_TEST_LINE_SECOND,
    segmentId: "22222222-2222-4222-8222-222222222222",
    speakerName: "Personav",
    content: "I can write the rollout task list today.",
    startedAt: "2026-04-24T10:00:05.000Z",
    endedAt: "2026-04-24T10:00:08.000Z",
  },
];

function validate(rawText: string) {
  return validateHumanReadableExtraction({
    rawText,
    transcriptLines,
    id: "33333333-3333-4333-8333-333333333333",
    meetingId: "44444444-4444-4444-8444-444444444444",
    participants: [{ name: "Personbi", roleHint: null, confidence: "medium" }],
    status: "completed",
    extractionModel: "mock-content",
    extractionPromptVersion: "test",
    transcriptHash: "hash",
    durationMs: CONTENT_TEST_DURATION_MS,
    startedAt: new Date("2026-04-24T10:00:00.000Z"),
    completedAt: new Date("2026-04-24T10:00:01.000Z"),
    createdAt: new Date("2026-04-24T10:00:00.000Z"),
    updatedAt: new Date("2026-04-24T10:00:01.000Z"),
  });
}

void test("pass 1 validates stable structured content and source spans before display", () => {
  const extraction = validate(
    JSON.stringify({
      classification: { type: "product_review", confidence: "high", reasoning: "The team discussed a product change." },
      summary: {
        short: "The team discussed shipping the dashboard redesign.",
        bullets: [
          "The dashboard redesign was discussed.",
          "Personav owned a task list.",
          "The timeline was next month.",
        ],
      },
      decisions: [
        {
          text: CONTENT_TEST_MESSAGES.shipDecisionText,
          finality: "final",
          confidence: "high",
          source_spans: [
            {
              excerpt: CONTENT_TEST_MESSAGES.shipDashboardRedesign,
              line_start: CONTENT_TEST_LINE_FIRST,
              line_end: CONTENT_TEST_LINE_FIRST,
            },
          ],
        },
      ],
      action_items: [
        {
          title: CONTENT_TEST_MESSAGES.writeRolloutTitle,
          owner_hint: { name: "Personav", confidence: "high" },
          confidence: "high",
          source_spans: [
            {
              excerpt: CONTENT_TEST_MESSAGES.writeRolloutTaskList,
              line_start: CONTENT_TEST_LINE_SECOND,
              line_end: CONTENT_TEST_LINE_SECOND,
            },
          ],
        },
      ],
      open_questions: [],
      risks: [],
      highlights: [
        {
          theme: "Dashboard redesign",
          takeaway: "The team discussed shipping the dashboard redesign next month.",
          source_spans: [{ excerpt: "We should ship the dashboard redesign next month.", line_start: 1, line_end: 1 }],
        },
      ],
      key_topics: ["Dashboard redesign"],
    }),
  );

  assert.equal(extraction.summaryShort, "The team discussed shipping the dashboard redesign.");
  assert.equal(extraction.decisions[0]?.sourceSpans[0]?.verificationStatus, "verified");
  assert.equal(extraction.signals.length, 0);
});

void test("pass 1 parser repairs fenced JSON with trailing commas", () => {
  const extraction = validate(`\`\`\`json
{
  "classification": { "type": "product_review", "confidence": "medium", "reasoning": "Product discussion." },
  "summary": { "short": "The team discussed dashboard work.", "bullets": ["One", "Two", "Three",] },
  "decisions": [],
  "action_items": [],
  "open_questions": [],
  "risks": [],
  "highlights": [],
  "key_topics": ["Dashboard",],
}
\`\`\``);

  assert.equal(extraction.meetingType, "product_review");
  assert.deepEqual(extraction.keyTopics, ["Dashboard"]);
});

void test("pass 1 normalizes bounded overproduction before schema validation", () => {
  const extraction = validate(
    JSON.stringify({
      classification: { type: "product_review", confidence: "medium", reasoning: "Product discussion." },
      summary: {
        short: "The team discussed dashboard work.",
        bullets: ["One", "Two", "Three", "Four", "Five", "Six", "Seven"],
      },
      decisions: [],
      action_items: [],
      open_questions: [],
      risks: [],
      highlights: [
        {
          theme: "This highlight theme is intentionally too verbose for the schema",
          takeaway:
            "The team discussed dashboard work in a sentence that is intentionally verbose enough to exceed the strict validation limit so the normalization layer can trim it without failing the whole extraction artifact for readers.",
          source_spans: [{ excerpt: "We should ship the dashboard redesign next month.", line_start: 1, line_end: 1 }],
        },
      ],
      key_topics: [],
    }),
  );

  assert.equal(extraction.summaryBullets.length, CONTENT_TEST_MAX_SUMMARY_BULLETS);
  assert.ok((extraction.highlights[0]?.theme.length ?? 0) <= CONTENT_TEST_HIGHLIGHT_THEME_MAX_CHARS);
  assert.ok((extraction.highlights[0]?.takeaway.length ?? 0) <= CONTENT_TEST_HIGHLIGHT_TAKEAWAY_MAX_CHARS);
});

void test("pass 1 accepts concise summaries for short meetings", () => {
  const extraction = validate(
    JSON.stringify({
      classification: { type: "standup", confidence: "medium", reasoning: "Brief status-style meeting." },
      summary: {
        short: "The team briefly discussed dashboard work.",
        bullets: ["Personav owned the rollout task list."],
      },
      decisions: [],
      action_items: [
        {
          title: CONTENT_TEST_MESSAGES.writeRolloutTitle,
          owner_hint: { name: "Personav", confidence: "high" },
          confidence: "high",
          source_spans: [
            {
              excerpt: CONTENT_TEST_MESSAGES.writeRolloutTaskList,
              line_start: CONTENT_TEST_LINE_SECOND,
              line_end: CONTENT_TEST_LINE_SECOND,
            },
          ],
        },
      ],
      open_questions: [],
      risks: [],
      highlights: [],
      key_topics: ["Dashboard"],
    }),
  );

  assert.deepEqual(extraction.summaryBullets, ["Personav owned the rollout task list."]);
  assert.equal(extraction.actionItems.length, 0);
});

void test("pass 1 ignores legacy action item fields in model output", () => {
  const extraction = validate(
    JSON.stringify({
      classification: {
        type: "product_review",
        confidence: "medium",
        reasoning: CONTENT_TEST_MESSAGES.productReviewMedium,
      },
      summary: {
        short: CONTENT_TEST_MESSAGES.teamDiscussedDashboard,
        bullets: [
          CONTENT_TEST_MESSAGES.summaryBulletOne,
          CONTENT_TEST_MESSAGES.summaryBulletTwo,
          CONTENT_TEST_MESSAGES.summaryBulletThree,
        ],
      },
      decisions: [],
      action_items: [
        {
          title: CONTENT_TEST_MESSAGES.writeRolloutTitle,
          owner_hint: { name: CONTENT_TEST_MESSAGES.emptyOwnerName, confidence: CONTENT_TEST_MESSAGES.lowConfidence },
          due_hint: {
            text: CONTENT_TEST_MESSAGES.emptyIsoDate,
            iso_date: CONTENT_TEST_MESSAGES.emptyIsoDate,
            confidence: CONTENT_TEST_MESSAGES.lowConfidence,
          },
          confidence: "high",
          source_spans: [
            {
              excerpt: CONTENT_TEST_MESSAGES.writeRolloutTaskList,
              line_start: CONTENT_TEST_LINE_SECOND,
              line_end: CONTENT_TEST_LINE_SECOND,
            },
          ],
        },
        {
          title: CONTENT_TEST_MESSAGES.writeRolloutTodayTitle,
          due_hint: {
            text: CONTENT_TEST_MESSAGES.dueHintToday,
            iso_date: CONTENT_TEST_MESSAGES.emptyIsoDate,
            confidence: CONTENT_TEST_MESSAGES.highConfidence,
          },
          confidence: CONTENT_TEST_MESSAGES.highConfidence,
          source_spans: [
            {
              excerpt: CONTENT_TEST_MESSAGES.writeRolloutTaskList,
              line_start: CONTENT_TEST_LINE_SECOND,
              line_end: CONTENT_TEST_LINE_SECOND,
            },
          ],
        },
      ],
      open_questions: [],
      risks: [],
      highlights: [],
      key_topics: [],
    }),
  );

  assert.equal(extraction.actionItems.length, 0);
});

void test("pass 1 marks wrong-line source spans corrected and missing text unverified", () => {
  const extraction = validate(
    JSON.stringify({
      classification: { type: "product_review", confidence: "high", reasoning: "The team discussed a product change." },
      summary: {
        short: "The team discussed shipping the dashboard redesign.",
        bullets: [
          "The dashboard redesign was discussed.",
          "Personav owned a task list.",
          "The timeline was next month.",
        ],
      },
      decisions: [
        {
          text: CONTENT_TEST_MESSAGES.shipDecisionText,
          finality: CONTENT_TEST_MESSAGES.finalityFinal,
          confidence: CONTENT_TEST_MESSAGES.highConfidence,
          source_spans: [
            {
              excerpt: CONTENT_TEST_MESSAGES.shipDashboardRedesign,
              line_start: CONTENT_TEST_LINE_SECOND,
              line_end: CONTENT_TEST_LINE_SECOND,
            },
          ],
        },
      ],
      action_items: [],
      open_questions: [
        {
          text: CONTENT_TEST_MESSAGES.absentQuestionText,
          priority: CONTENT_TEST_MESSAGES.lowConfidence,
          source_spans: [
            {
              excerpt: CONTENT_TEST_MESSAGES.absentTranscriptText,
              line_start: CONTENT_TEST_LINE_SECOND,
              line_end: CONTENT_TEST_LINE_SECOND,
            },
          ],
        },
      ],
      risks: [],
      highlights: [],
      key_topics: [],
    }),
  );

  assert.equal(extraction.decisions[0]?.sourceSpans[0]?.verificationStatus, "corrected");
  assert.equal(extraction.decisions[0].sourceSpans[0].lineStart, CONTENT_TEST_LINE_FIRST);
  assert.equal(extraction.openQuestions[0]?.sourceSpans[0]?.verificationStatus, "unverified");
});
