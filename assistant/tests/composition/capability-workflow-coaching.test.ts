import "../../composition/wire";

import { meetingCoachingGenerationResponseSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingCoachingSystemPrompt,
  normalizeMeetingCoachingResponseForValidation,
} from "../../application/capability-workflow-coaching";

const COACHING_TEST_MAX_EVIDENCE_SNIPPETS = 2;
const COACHING_TEST_MAX_DETAIL_PARAGRAPHS = 4;
const COACHING_TEST_DEFAULT_FOLLOW_UP_PROMPT_COUNT = 3;

const COACHING_TEST_MESSAGES = {
  focusWorkedDetail: "Focus: what_worked_detail",
  focusImproveDetail: "Focus: what_to_improve_detail",
  labelTellMeMoreWorked: "Tell me more what worked",
  labelTellMeMoreImprove: "Tell me more what to improve",
  labelExplainWhatWorked: "Explain what worked",
  labelHelpMeImprove: "Help me improve",
  firstQuote: "First quote",
  secondQuote: "Second quote",
  thirdQuote: "Third quote",
  handoffQuestion: "Can you start on it today?",
} as const;

function coachingInsufficientEvidenceWire(isInsufficientRequesterEvidence: boolean) {
  return {
    /** @external insufficientRequesterEvidence */
    insufficientRequesterEvidence: isInsufficientRequesterEvidence,
  };
}

void test("meeting coaching prompt separates short initial bullets from detailed quote-backed follow-ups", () => {
  const prompt = buildMeetingCoachingSystemPrompt();

  assert.match(prompt, /one concise standalone sentence/i);
  assert.match(prompt, /single bullet/i);
  assert.match(prompt, /UI will not show quotes/i);
  assert.match(prompt, /detailed "tell me more" mode/i);
  assert.match(prompt, /visible answer only in detailParagraphs/i);
  assert.match(prompt, /Do not provide all three themes again/i);
  assert.match(prompt, /what_to_improve_detail/i);
  assert.match(prompt, /detailFocus to "improve"/i);
  assert.match(prompt, /custom_question_detail/i);
  assert.match(prompt, /answer the user's specific question directly/i);
  assert.match(prompt, /exact quote examples in each detailParagraph\.evidence/i);
  assert.match(prompt, /Never return more than two evidence snippets/i);
  assert.match(prompt, /Do not put quote text, speaker names, or timestamps inside point\.body/i);
});

void test("meeting coaching normalization caps excess evidence before strict validation", () => {
  const evidence = [
    {
      quote: COACHING_TEST_MESSAGES.firstQuote,
      speaker: "Personbr",
      timestamp: "00:01",
      segmentId: "11111111-1111-4111-8111-111111111111",
    },
    {
      quote: COACHING_TEST_MESSAGES.secondQuote,
      speaker: "Personbr",
      timestamp: "00:02",
      segmentId: "22222222-2222-4222-8222-222222222222",
    },
    {
      quote: COACHING_TEST_MESSAGES.thirdQuote,
      speaker: "Personbr",
      timestamp: "00:03",
      segmentId: "33333333-3333-4333-8333-333333333333",
    },
  ];

  const normalized = normalizeMeetingCoachingResponseForValidation({
    model: "test-model",
    promptVersion: "test",
    feedback: {
      summary: "Short coaching summary.",
      whatWorked: [
        {
          title: "Clear setup",
          body: "You set context clearly.",
          evidence,
        },
      ],
      whatToImprove: [
        {
          title: "Pacing",
          body: "Leave more space for replies.",
          evidence: [],
        },
      ],
      tryNextTime: [
        {
          title: "Pause",
          body: "Pause after assigning owners.",
          evidence: [],
        },
      ],
      followUpPrompts: [
        {
          id: "worked",
          label: COACHING_TEST_MESSAGES.labelTellMeMoreWorked,
          prompt: COACHING_TEST_MESSAGES.focusWorkedDetail,
        },
        {
          id: "improve",
          label: COACHING_TEST_MESSAGES.labelTellMeMoreImprove,
          prompt: COACHING_TEST_MESSAGES.focusImproveDetail,
        },
      ],
      detailFocus: "improve",
      detailParagraphs: [
        { body: "You can slow down around ownership handoffs.", evidence },
        { body: "A brief check for agreement would make the next step clearer.", evidence },
        { body: "Extra paragraph one.", evidence },
        { body: "Extra paragraph two.", evidence },
        { body: "Extra paragraph three.", evidence },
      ],
      ...coachingInsufficientEvidenceWire(false),
    },
  });

  const parsed = meetingCoachingGenerationResponseSchema.parse(normalized);

  assert.equal(parsed.feedback.whatWorked[0]?.evidence.length, COACHING_TEST_MAX_EVIDENCE_SNIPPETS);
  assert.equal(parsed.feedback.detailParagraphs.length, COACHING_TEST_MAX_DETAIL_PARAGRAPHS);
  assert.equal(parsed.feedback.detailParagraphs[0]?.evidence.length, COACHING_TEST_MAX_EVIDENCE_SNIPPETS);
  assert.equal(parsed.feedback.detailParagraphs[1]?.evidence.length, COACHING_TEST_MAX_EVIDENCE_SNIPPETS);
});

void test("meeting coaching normalization fills detail-mode placeholder sections", () => {
  const normalized = normalizeMeetingCoachingResponseForValidation({
    model: "test-model",
    promptVersion: "test",
    feedback: {
      summary: "Focused improvement detail.",
      whatWorked: [],
      whatToImprove: [],
      tryNextTime: [],
      followUpPrompts: [],
      detailFocus: "custom",
      detailParagraphs: [
        {
          body: "You can make the handoff clearer by pausing after the ask.",
          evidence: [
            {
              quote: COACHING_TEST_MESSAGES.handoffQuestion,
              speaker: "Personbr",
              timestamp: "00:01",
              segmentId: "11111111-1111-4111-8111-111111111111",
            },
          ],
        },
      ],
      ...coachingInsufficientEvidenceWire(false),
    },
  });

  const parsed = meetingCoachingGenerationResponseSchema.parse(normalized);

  assert.equal(parsed.feedback.whatWorked.length, 1);
  assert.equal(parsed.feedback.whatToImprove.length, 1);
  assert.equal(parsed.feedback.tryNextTime.length, 1);
  assert.equal(parsed.feedback.followUpPrompts.length, COACHING_TEST_DEFAULT_FOLLOW_UP_PROMPT_COUNT);
  assert.equal(parsed.feedback.detailFocus, "custom");
  assert.equal(parsed.feedback.detailParagraphs.length, 1);
});

void test("meeting coaching normalization nulls invalid evidence segment ids", () => {
  const normalized = normalizeMeetingCoachingResponseForValidation({
    model: "test-model",
    promptVersion: "test",
    feedback: {
      summary: "Short coaching summary.",
      whatWorked: [
        {
          title: "Clear setup",
          body: "You framed the discussion clearly.",
          evidence: [
            {
              quote: "Let us get started.",
              speaker: "Personbr",
              timestamp: "00:01",
              segmentId: "seg-001",
            },
          ],
        },
      ],
      whatToImprove: [
        {
          title: "Pause",
          body: "Pause after assigning next steps.",
          evidence: [],
        },
      ],
      tryNextTime: [
        {
          title: "Confirm",
          body: "Ask the owner to confirm the scope.",
          evidence: [],
        },
      ],
      followUpPrompts: [
        {
          id: "worked",
          label: COACHING_TEST_MESSAGES.labelExplainWhatWorked,
          prompt: COACHING_TEST_MESSAGES.focusWorkedDetail,
        },
        {
          id: "improve",
          label: COACHING_TEST_MESSAGES.labelHelpMeImprove,
          prompt: COACHING_TEST_MESSAGES.focusImproveDetail,
        },
      ],
      detailFocus: null,
      detailParagraphs: [],
      ...coachingInsufficientEvidenceWire(false),
    },
  });

  const parsed = meetingCoachingGenerationResponseSchema.parse(normalized);

  assert.equal(parsed.feedback.whatWorked[0]?.evidence[0]?.segmentId, null);
});
