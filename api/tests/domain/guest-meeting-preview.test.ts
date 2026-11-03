import assert from "node:assert/strict";
import test from "node:test";

import { getGuestMeetingConclusions, getGuestMeetingPreviewTitle } from "../../domain/guest-meeting-preview";

const lines = ["The pilot starts next Tuesday.", "Three customers join the first cohort."];

void test("guest preview titles preserve supplied titles and use only human transcript for placeholders", () => {
  const segments = [
    { speakerRole: "human", content: "The onboarding pilot will start with three customers next Tuesday." },
  ];
  assert.equal(getGuestMeetingPreviewTitle({ title: "Onboarding pilot", segments }), "Onboarding pilot");
  assert.notEqual(getGuestMeetingPreviewTitle({ title: "Instant meeting", segments }), "Instant meeting");
  const firstSegment = segments[0];
  assert.ok(firstSegment);
  assert.equal(
    getGuestMeetingPreviewTitle({
      title: "Instant meeting",
      segments: [{ ...firstSegment, speakerRole: "assistant" }],
    }),
    "Instant meeting",
  );
});

void test("guest conclusions only expose validated completed model output", () => {
  assert.deepEqual(getGuestMeetingConclusions(null), []);
  (["queued", "running", "failed", "cancelled"] as const).forEach((status) => {
    assert.deepEqual(getGuestMeetingConclusions({ status, result: { preparationLines: lines } }), []);
  });
  assert.deepEqual(getGuestMeetingConclusions({ status: "completed", result: { preparationLines: lines } }), lines);
  assert.deepEqual(
    getGuestMeetingConclusions({
      status: "completed",
      result: { preparationLines: lines, /** @external existing wire contract */ fallback: true },
    }),
    [],
  );
  assert.deepEqual(getGuestMeetingConclusions({ status: "completed", result: { preparationLines: [""] } }), []);
});
