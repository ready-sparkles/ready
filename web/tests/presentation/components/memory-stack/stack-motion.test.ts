import assert from "node:assert/strict";
import test from "node:test";

import {
  accumulateStackWheel,
  advanceStackMotion,
  STACK_WHEEL_IDLE_MS,
  type StackWheelState,
} from "../../../../presentation/components/memory-stack/stack-motion";

const SAMPLE_DELTA = 60;
const SAMPLE_PAGE_HEIGHT = 600;
const SAMPLE_MAX_INDEX = 1598;
const DELTA_SCROLL_120_CARDS = 7200;
const EXPECTED_POSITION_AFTER_SCROLL_120_CARDS = 120;
const LINE_MODE_DELTA = 3.75;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const EXPECTED_POSITION_AFTER_LINE_MODE_DELTA = 1;
const EXPECTED_POSITION_AFTER_PAGE_MODE_DELTA = 10;
const TINY_TRACKPAD_STEP_COUNT = 60;
const UNIT_WHEEL_DELTA = 1;
const TRACKPAD_STEP_INTERVAL_MS = 8;
const TINY_TRACKPAD_NO_WHEEL_STATE_MESSAGE = "Tiny trackpad deltas produced no wheel state";
const NUMERIC_TOLERANCE = 1e-10;
const REVERSE_WHEEL_DELTA = -6;
const REVERSE_START_POSITION = 0.8;
const REVERSE_GESTURE_NOW_MS = 480;
const EXPECTED_REVERSED_POSITION = 0.7;
const CONTINUED_DESTINATION = 5;
const EXPECTED_CONTINUED_POSITION = 6;
const OVERSHOOT_WHEEL_DELTA = 1e6;
const NEGATIVE_CARD_WHEEL_DELTA = -60;
const EDGE_SCROLL_NOW_MS = 10;
const EXPECTED_POSITION_BEFORE_MAX = 1597;
const FRAME_HALF_DIVISOR = 2;
const FPS_THIRTY = 30;
const FPS_SIXTY = 60;
const FPS_ONE_TWENTY = 120;
const MOTION_TARGET_ONE = 1;
const MOTION_TARGET_TWO = 2;
const MOTION_TARGET_ONE_TWENTY = 120;
const FRAME_RATE_OPTIONS: readonly number[] = [FPS_THIRTY, FPS_SIXTY, FPS_ONE_TWENTY];
const MOTION_TARGET_OPTIONS: readonly number[] = [MOTION_TARGET_ONE, MOTION_TARGET_ONE_TWENTY, SAMPLE_MAX_INDEX];
const FIRST_FRAME_MIN_POSITION = 0.1;

function runStackMotionSettling(input: { target: number; fps: number }) {
  const { target, fps } = input;
  const state = Array.from({ length: fps / FRAME_HALF_DIVISOR }, () => 0).reduce(
    (current) => {
      const next = advanceStackMotion({
        position: current.position,
        velocity: current.velocity,
        target,
        seconds: 1 / fps,
      });
      assert.ok(next.position >= current.position && next.position <= target, "Travel must not bounce or overshoot");

      return next;
    },
    {
      position: 0,
      velocity: 0,
      /** @external advanceStackMotion settled wire field. */
      settled: false,
    },
  );
  assert.equal(state.position, target);
  assert.equal(state.settled, true);
}

// Ported with Highlight's motion implementation to preserve its input and settling behavior.
void test("Highlight stack physics preserve wheel accumulation, reversal, bounds and refresh-rate independent settling", () => {
  const sample = {
    delta: SAMPLE_DELTA,
    deltaMode: 0,
    pageHeight: SAMPLE_PAGE_HEIGHT,
    position: 0,
    destination: 0,
    maxIndex: SAMPLE_MAX_INDEX,
    now: 0,
  };
  assert.equal(accumulateStackWheel({ previous: null, ...sample }).position, EXPECTED_POSITION_AFTER_LINE_MODE_DELTA);
  assert.equal(
    accumulateStackWheel({ previous: null, ...sample, delta: DELTA_SCROLL_120_CARDS }).position,
    EXPECTED_POSITION_AFTER_SCROLL_120_CARDS,
  );
  assert.equal(
    accumulateStackWheel({ previous: null, ...sample, delta: LINE_MODE_DELTA, deltaMode: WHEEL_DELTA_MODE_LINE })
      .position,
    EXPECTED_POSITION_AFTER_LINE_MODE_DELTA,
  );
  assert.equal(
    accumulateStackWheel({ previous: null, ...sample, delta: UNIT_WHEEL_DELTA, deltaMode: WHEEL_DELTA_MODE_PAGE })
      .position,
    EXPECTED_POSITION_AFTER_PAGE_MODE_DELTA,
  );
  const wheel = Array.from({ length: TINY_TRACKPAD_STEP_COUNT }, (_, index) => index).reduce<StackWheelState | null>(
    (current, index) =>
      accumulateStackWheel({
        previous: current,
        ...sample,
        delta: UNIT_WHEEL_DELTA,
        now: index * TRACKPAD_STEP_INTERVAL_MS,
      }),
    null,
  );
  if (!wheel) {
    throw new Error(TINY_TRACKPAD_NO_WHEEL_STATE_MESSAGE);
  }
  assert.ok(
    Math.abs(wheel.position - EXPECTED_POSITION_AFTER_LINE_MODE_DELTA) < NUMERIC_TOLERANCE,
    "Tiny trackpad deltas must accumulate without being discarded",
  );
  const reversed = accumulateStackWheel({
    previous: wheel,
    ...sample,
    delta: REVERSE_WHEEL_DELTA,
    position: REVERSE_START_POSITION,
    now: REVERSE_GESTURE_NOW_MS,
  });
  assert.ok(
    Math.abs(reversed.position - EXPECTED_REVERSED_POSITION) < NUMERIC_TOLERANCE,
    "Reversing must start at the visible card, not a distant queued destination",
  );
  const continued = accumulateStackWheel({
    previous: reversed,
    ...sample,
    destination: CONTINUED_DESTINATION,
    now: REVERSE_GESTURE_NOW_MS + STACK_WHEEL_IDLE_MS,
  });
  assert.equal(
    continued.position,
    EXPECTED_CONTINUED_POSITION,
    "A new gesture must start from the current destination",
  );
  const edge = accumulateStackWheel({ previous: null, ...sample, delta: OVERSHOOT_WHEEL_DELTA });
  assert.equal(edge.position, SAMPLE_MAX_INDEX);
  assert.equal(
    accumulateStackWheel({
      previous: edge,
      ...sample,
      position: SAMPLE_MAX_INDEX,
      destination: SAMPLE_MAX_INDEX,
      delta: NEGATIVE_CARD_WHEEL_DELTA,
      now: EDGE_SCROLL_NOW_MS,
    }).position,
    EXPECTED_POSITION_BEFORE_MAX,
  );
  assert.equal(accumulateStackWheel({ previous: null, ...sample, delta: NEGATIVE_CARD_WHEEL_DELTA }).position, 0);
});

void test("Highlight stack physics settle independent of refresh rate", () => {
  FRAME_RATE_OPTIONS.forEach((fps) => {
    MOTION_TARGET_OPTIONS.forEach((target) => {
      runStackMotionSettling({ target, fps });
    });
  });
  const firstMotion = advanceStackMotion({
    position: 0,
    velocity: 0,
    target: MOTION_TARGET_ONE,
    seconds: 1 / FPS_SIXTY,
  });
  assert.ok(firstMotion.position > FIRST_FRAME_MIN_POSITION, "The first frame must move, without a fade or timer gate");
  const motion = advanceStackMotion({
    position: firstMotion.position,
    velocity: firstMotion.velocity,
    target: MOTION_TARGET_TWO,
    seconds: 1 / FPS_SIXTY,
  });
  assert.ok(
    motion.position > firstMotion.position && motion.velocity > firstMotion.velocity,
    "Repeated input must accelerate the current motion",
  );
  const reverse = advanceStackMotion({
    position: motion.position,
    velocity: motion.velocity,
    target: 0,
    seconds: 1 / FPS_SIXTY,
  });
  assert.ok(
    reverse.position < motion.position && reverse.velocity < 0,
    "Opposite input must reverse on the next frame",
  );
  assert.equal(advanceStackMotion({ position: 1, velocity: 0, target: 1, seconds: 0 }).position, 1);
});
