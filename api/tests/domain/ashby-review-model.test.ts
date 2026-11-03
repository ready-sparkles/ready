import assert from "node:assert/strict";
import test from "node:test";

import {
  ASHBY_GATE_QUESTIONS,
  ashbyTranscriptWindows,
  extractAshbyProposals,
  isConfidentAshbyNegative,
  screenAshbyTranscript,
} from "../../domain/ashby-review-model";

const EXPECTED_ASHBY_TRANSCRIPT_SEGMENT_MESSAGE = "Expected an Ashby transcript segment";
const OFFLINE_ERROR_MESSAGE = "offline";
const CONFIDENT_NEGATIVE_YES_PROBABILITY = 0.01;
const CONFIDENT_NEGATIVE_UNCERTAIN_PROBABILITY = 0.01;
const CONFIDENT_NEGATIVE_NO_PROBABILITY = 0.98;
const NON_CONFIDENT_YES_PROBABILITY = 0.1;
const NON_CONFIDENT_NO_PROBABILITY = 0.9;
const UNICODE_WINDOW_TEXT_REPEAT_COUNT = 4000;
const SERIALIZED_BYTE_BUDGET = 18000;
const PRODUCT_PLANNING_REPEAT_COUNT = 10000;
const HTTP_STATUS_OK = 200;
const isNeverAccountingError = () => false;

function completedExtraction(payload: unknown) {
  return async () => ({ isOk: true, status: HTTP_STATUS_OK, payload });
}

const id = "11111111-1111-4111-8111-111111111111";
const segments = [{ id, content: "Move Personqj Personqm to the technical interview.", speaker: "Personqc" }];
const firstSegment = segments[0];
if (!firstSegment) {
  throw new Error(EXPECTED_ASHBY_TRANSCRIPT_SEGMENT_MESSAGE);
}
const no = {
  type: "choice",
  choice: "no",
  probabilities: {
    yes: CONFIDENT_NEGATIVE_YES_PROBABILITY,
    uncertain: CONFIDENT_NEGATIVE_UNCERTAIN_PROBABILITY,
    no: CONFIDENT_NEGATIVE_NO_PROBABILITY,
  },
};
void test("stage answer must be a confident negative to skip", () => {
  assert.equal(isConfidentAshbyNegative({ answers: { stage: no } }), true);
  [
    { ...no, choice: "uncertain" },
    { ...no, probabilities: { yes: NON_CONFIDENT_YES_PROBABILITY, uncertain: 0, no: NON_CONFIDENT_NO_PROBABILITY } },
    {},
    null,
  ].forEach((answer) => {
    assert.equal(isConfidentAshbyNegative({ answers: { stage: answer } }), false);
  });
  assert.equal(isConfidentAshbyNegative({ answers: { note: no } }), false);
  Object.values(ASHBY_GATE_QUESTIONS).forEach((question) => {
    assert.match(question.instructions, /employment/);
    assert.match(question.instructions, /sales prospects/);
    assert.match(question.instructions, /mixed-topic/);
  });
});
void test("windows preserve Unicode and cover all text within serialized byte budget", () => {
  const text = "a😀招聘 candidate ".repeat(UNICODE_WINDOW_TEXT_REPEAT_COUNT);
  const windows = ashbyTranscriptWindows([{ id, content: text, speaker: "Personqc" }]);
  assert.ok(windows.length > 1);
  windows.forEach((window) => {
    assert.ok(Buffer.byteLength(JSON.stringify(window)) <= SERIALIZED_BYTE_BUDGET);
    assert.ok(!JSON.stringify(window).includes("\\ud83d"));
  });
  const pieces = windows.flat();
  // Overlap is intentional; all ordered source chunks remain represented.
  const remaining = pieces.reduce((textRemaining, piece) => {
    if (textRemaining.startsWith(piece.content)) {
      return textRemaining.slice(piece.content.length);
    }

    return textRemaining;
  }, text);
  assert.equal(remaining, "");
});
void test("provider errors and uncertain answers escalate; confident negatives cover every window", async () => {
  assert.equal(
    await screenAshbyTranscript(segments, { apiKey: "", model: "jev", isAccountingError: isNeverAccountingError }),
    true,
  );
  assert.equal(
    await screenAshbyTranscript(segments, {
      apiKey: "test",
      model: "jev",
      isAccountingError: isNeverAccountingError,
      fetch: async () => {
        throw new Error(OFFLINE_ERROR_MESSAGE);
      },
    }),
    true,
  );
  const calls = { count: 0 };
  const input = [{ id, content: "Product planning. ".repeat(PRODUCT_PLANNING_REPEAT_COUNT), speaker: null }];
  assert.equal(
    await screenAshbyTranscript(input, {
      apiKey: "test",
      model: "jev",
      isAccountingError: isNeverAccountingError,
      fetch: async () => {
        calls.count += 1;

        return Response.json({ answers: { stage: no } });
      },
    }),
    false,
  );
  assert.equal(calls.count, ashbyTranscriptWindows(input).length);
});
void test("extraction rejects invented evidence and incomplete output", async () => {
  const proposal = {
    kind: "stage",
    candidateName: "Personqj Personqm",
    candidateEmail: null,
    jobTitle: null,

    stageName: "Technical Interview",
    evidence: [{ segmentId: id, quote: firstSegment.content }],
  };
  const run = (value: unknown) =>
    extractAshbyProposals({
      segments,
      apiKey: "test",
      model: "test",
      complete: completedExtraction(value),
    });
  assert.equal(
    (await run({ output_text: JSON.stringify({ proposals: [proposal], clarification: null }) })).proposals.length,
    1,
  );
  await assert.rejects(run({ status: "incomplete", output_text: "{}" }), /incomplete/);
  await assert.rejects(
    run({
      output_text: JSON.stringify({
        proposals: [{ ...proposal, evidence: [{ segmentId: id, quote: "Hire them!" }] }],
        clarification: null,
      }),
    }),
    /evidence/,
  );
});

void test("candidate note output is rejected even with valid evidence", async () => {
  await assert.rejects(
    extractAshbyProposals({
      segments,
      apiKey: "test",
      model: "test",
      complete: completedExtraction({
        output_text: JSON.stringify({
          proposals: [
            {
              kind: "note",
              candidateName: "Personqj Personqm",
              candidateEmail: null,
              jobTitle: null,
              note: "Interview feedback",
              stageName: null,
              evidence: [{ segmentId: id, quote: firstSegment.content }],
            },
          ],
          clarification: null,
        }),
      }),
    }),
    /Invalid literal value/,
  );
  assert.deepEqual(Object.keys(ASHBY_GATE_QUESTIONS), ["stage"]);
});
