import assert from "node:assert/strict";
import test from "node:test";

import { advanceSpring } from "../../../../presentation/components/memory-stack/spring";

const FOCUS_STIFFNESS = 240;
const FOCUS_DAMPING = 31;
const FOCUS_TOLERANCE = 0.01;
const STRENGTH_STIFFNESS = 240;
const STRENGTH_DAMPING = 31;
const STRENGTH_TOLERANCE = 0.001;
const EDGE_RETURN_STIFFNESS = 180;
const EDGE_RETURN_DAMPING = 27;
const EDGE_RETURN_TOLERANCE = 0.05;
const FPS_THIRTY = 30;
const FPS_SIXTY = 60;
const FPS_ONE_TWENTY = 120;
const SPRING_CASES = [
  { name: "focus", stiffness: FOCUS_STIFFNESS, damping: FOCUS_DAMPING, tolerance: FOCUS_TOLERANCE },
  { name: "strength", stiffness: STRENGTH_STIFFNESS, damping: STRENGTH_DAMPING, tolerance: STRENGTH_TOLERANCE },
  {
    name: "edge return",
    stiffness: EDGE_RETURN_STIFFNESS,
    damping: EDGE_RETURN_DAMPING,
    tolerance: EDGE_RETURN_TOLERANCE,
  },
] as const;
const FRAME_RATE_OPTIONS = [FPS_THIRTY, FPS_SIXTY, FPS_ONE_TWENTY] as const;
const FRAME_HALF_DIVISOR = 2;
const FRAME_TRIPLE_MULTIPLIER = 3;
const TARGET_POSITION = 100;
const REVERSE_TARGET = -50;
const POSITION_JUMP_TOLERANCE = 20;
const NUMERIC_TOLERANCE = 1e-8;
const PAUSED_POSITION = 4;
const PAUSED_VELOCITY = 2;
const LARGE_DELTA_SECONDS = 60;

SPRING_CASES.forEach(({ name, stiffness, damping, tolerance }) => {
  void test(`${name} spring is stable across frame rates, retargets and settles`, () => {
    const options = {
      stiffness,
      damping,
      positionTolerance: tolerance,
      velocityTolerance: tolerance,
    };
    const sampleRecorder = { values: [] as number[] };
    FRAME_RATE_OPTIONS.forEach((fps) => {
      const halfFrameCount = fps / FRAME_HALF_DIVISOR;
      const midState: { position: number; velocity: number } = Array.from({ length: halfFrameCount }).reduce(
        (state: { position: number; velocity: number }) =>
          advanceSpring({
            position: state.position,
            velocity: state.velocity,
            target: TARGET_POSITION,
            seconds: 1 / fps,
            options,
          }),
        { position: 0, velocity: 0 },
      );
      sampleRecorder.values = [...sampleRecorder.values, midState.position];
      const reversed = advanceSpring({
        position: midState.position,
        velocity: midState.velocity,
        target: REVERSE_TARGET,
        seconds: 1 / fps,
        options,
      });
      assert.ok(Math.abs(reversed.position - midState.position) < POSITION_JUMP_TOLERANCE);
      const settledState = Array.from({ length: fps * FRAME_TRIPLE_MULTIPLIER }).reduce(
        (state: { position: number; velocity: number }) =>
          advanceSpring({
            position: state.position,
            velocity: state.velocity,
            target: REVERSE_TARGET,
            seconds: 1 / fps,
            options,
          }),
        { position: reversed.position, velocity: reversed.velocity },
      );
      assert.deepEqual(settledState, {
        position: REVERSE_TARGET,
        velocity: 0,
        /** @external advanceSpring settled wire field. */
        settled: true,
      });
    });
    assert.ok(Math.max(...sampleRecorder.values) - Math.min(...sampleRecorder.values) < NUMERIC_TOLERANCE);
    const paused = advanceSpring({
      position: PAUSED_POSITION,
      velocity: PAUSED_VELOCITY,
      target: TARGET_POSITION,
      seconds: 0,
      options,
    });
    assert.ok(Math.abs(paused.position - PAUSED_POSITION) < NUMERIC_TOLERANCE);
    assert.ok(Math.abs(paused.velocity - PAUSED_VELOCITY) < NUMERIC_TOLERANCE);
    assert.deepEqual(
      advanceSpring({
        position: PAUSED_POSITION,
        velocity: PAUSED_VELOCITY,
        target: TARGET_POSITION,
        seconds: LARGE_DELTA_SECONDS,
        options,
      }),
      advanceSpring({
        position: PAUSED_POSITION,
        velocity: PAUSED_VELOCITY,
        target: TARGET_POSITION,
        seconds: 1 / FPS_THIRTY,
        options,
      }),
    );
  });
});
