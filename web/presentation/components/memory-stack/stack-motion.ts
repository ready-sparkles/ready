import { advanceSpring } from "./spring";
// Ported from Highlight memory; keep motion constants in sync with the reference.
export const STACK_WHEEL_IDLE_MS = 140;
const PIXELS_PER_CARD = 60;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const WHEEL_LINE_HEIGHT_PX = 16;
const STACK_SPRING_STIFFNESS = 38;
const STACK_SPRING_DAMPING_MULTIPLIER = 2;
const STACK_SPRING_POSITION_TOLERANCE = 0.001;
const STACK_SPRING_VELOCITY_TOLERANCE = 0.04;
const STACK_SPRING_MAX_STEP_SECONDS = 0.064;

export type StackWheelState = { position: number; direction: number; at: number };

// Keep the established stack gesture sensitivity independent of list row styling.
export function accumulateStackWheel(input: {
  previous: StackWheelState | null;
  delta: number;
  deltaMode: number;
  pageHeight: number;
  position: number;
  destination: number;
  maxIndex: number;
  now: number;
}): StackWheelState {
  const { previous, delta, deltaMode, pageHeight, position, destination, maxIndex, now } = input;
  const pixels =
    delta *
    (deltaMode === WHEEL_DELTA_MODE_LINE ? WHEEL_LINE_HEIGHT_PX : deltaMode === WHEEL_DELTA_MODE_PAGE ? pageHeight : 1);
  const direction = Math.sign(pixels);
  const isContinuing = previous !== null && now - previous.at < STACK_WHEEL_IDLE_MS;
  const isReversing = isContinuing && direction !== previous.direction;
  const base = isReversing ? position : isContinuing ? previous.position : destination;

  return {
    position: Math.max(0, Math.min(maxIndex, base + pixels / PIXELS_PER_CARD)),
    direction,
    at: now,
  };
}

// Exact critically damped spring: stable across frame rates and retargetable
// without restarting an easing curve. No bounce or queue behind old input.
export function advanceStackMotion(input: {
  position: number;
  velocity: number;
  target: number;
  seconds: number;
}): ReturnType<typeof advanceSpring> {
  return advanceSpring({
    position: input.position,
    velocity: input.velocity,
    target: input.target,
    seconds: input.seconds,
    options: {
      stiffness: STACK_SPRING_STIFFNESS * STACK_SPRING_STIFFNESS,
      damping: STACK_SPRING_DAMPING_MULTIPLIER * STACK_SPRING_STIFFNESS,
      positionTolerance: STACK_SPRING_POSITION_TOLERANCE,
      velocityTolerance: STACK_SPRING_VELOCITY_TOLERANCE,
      maxStep: STACK_SPRING_MAX_STEP_SECONDS,
      /** @external existing spring options contract */
      clampOvershoot: true,
      /** @external existing spring options contract */
      stopOnReverse: true,
    },
  });
}
