import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpeechIndicatorState,
  DEFAULT_SPEECH_INDICATOR_CONFIG,
  type SpeechIndicatorState,
  updateSpeechIndicator,
} from "../../domain/speech-indicator";

const { onsetMs, releaseMs } = DEFAULT_SPEECH_INDICATOR_CONFIG;
const TICK = 60;

function run(input: { pattern: { isSpeaking: boolean; ticks: number }[]; initial?: SpeechIndicatorState }) {
  const initial = input.initial ?? createSpeechIndicatorState();
  const steps = input.pattern.flatMap((segment) => Array.from({ length: segment.ticks }, () => segment.isSpeaking));
  const result = steps.reduce<{ state: SpeechIndicatorState; now: number; visibility: boolean[] }>(
    (current, isSpeaking) => {
      const state = updateSpeechIndicator({
        state: current.state,
        rawSpeaking: isSpeaking,
        now: current.now,
      });

      return {
        state,
        now: current.now + TICK,
        visibility: [...current.visibility, state.visible],
      };
    },
    { state: initial, now: 0, visibility: [] },
  );

  return { state: result.state, visibility: result.visibility };
}

const TEST_VALUE_100 = 100;
const TEST_VALUE_2 = 2;
const TEST_VALUE_3 = 3;
const TEST_VALUE_5 = 5;
void test("a short noise blip never shows the indicator", () => {
  // Two ticks (120ms) of raw activity is below the onset requirement.
  const { visibility } = run({
    pattern: [
      { isSpeaking: true, ticks: TEST_VALUE_2 },
      { isSpeaking: false, ticks: TEST_VALUE_5 },
    ],
  });
  assert.ok(visibility.every((isVisible) => !isVisible));
});

void test("sustained speech shows the indicator only after the onset delay", () => {
  const ticksToOnset = Math.ceil(onsetMs / TICK) + 1;
  const { visibility } = run({ pattern: [{ isSpeaking: true, ticks: ticksToOnset }] });
  assert.equal(visibility[0], false);
  assert.equal(visibility[visibility.length - 1], true);
});

void test("interrupted noise resets the onset run", () => {
  // Repeated 120ms bursts with gaps never accumulate into an onset.
  const { visibility } = run({
    pattern: [
      { isSpeaking: true, ticks: TEST_VALUE_2 },
      { isSpeaking: false, ticks: 1 },
      { isSpeaking: true, ticks: TEST_VALUE_2 },
      { isSpeaking: false, ticks: 1 },
      { isSpeaking: true, ticks: TEST_VALUE_2 },
    ],
  });
  assert.ok(visibility.every((isVisible) => !isVisible));
});

void test("natural mid-sentence pauses do not blink the indicator", () => {
  const ticksToOnset = Math.ceil(onsetMs / TICK) + 1;
  const shortPause = Math.floor(releaseMs / TICK / TEST_VALUE_2);
  const { visibility } = run({
    pattern: [
      { isSpeaking: true, ticks: ticksToOnset },
      { isSpeaking: false, ticks: shortPause },
      { isSpeaking: true, ticks: TEST_VALUE_3 },
    ],
  });
  const afterOnset = visibility.slice(ticksToOnset - 1);
  assert.ok(afterOnset.every((isVisible) => isVisible));
});

void test("sustained silence hides the indicator after the release delay", () => {
  const ticksToOnset = Math.ceil(onsetMs / TICK) + 1;
  const ticksToRelease = Math.ceil(releaseMs / TICK) + 1;
  const { state, visibility } = run({
    pattern: [
      { isSpeaking: true, ticks: ticksToOnset },
      { isSpeaking: false, ticks: ticksToRelease },
    ],
  });
  assert.equal(state.visible, false);
  // It was visible before the silence ran out.
  assert.equal(visibility[ticksToOnset], true);
});

void test("after hiding, a fresh onset run is required again", () => {
  const ticksToOnset = Math.ceil(onsetMs / TICK) + 1;
  const ticksToRelease = Math.ceil(releaseMs / TICK) + 1;
  const { state } = run({
    pattern: [
      { isSpeaking: true, ticks: ticksToOnset },
      { isSpeaking: false, ticks: ticksToRelease },
      { isSpeaking: true, ticks: 1 },
    ],
  });
  assert.equal(state.visible, false);
});

void test("steady states return the same object (no re-render churn)", () => {
  const initial = createSpeechIndicatorState();
  const unchanged = updateSpeechIndicator({ state: initial, rawSpeaking: false, now: 0 });
  assert.equal(unchanged, initial);

  const visible: SpeechIndicatorState = {
    /** @external speech indicator wire field */
    visible: true,
    candidateSince: null,
    quietSince: null,
  };
  assert.equal(updateSpeechIndicator({ state: visible, rawSpeaking: true, now: TEST_VALUE_100 }), visible);
});
