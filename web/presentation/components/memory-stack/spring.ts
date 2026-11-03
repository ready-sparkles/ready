type SpringOptions = {
  stiffness: number;
  damping: number;
  positionTolerance: number;
  velocityTolerance: number;
  maxStep?: number;
  /** @external existing wire contract */
  clampOvershoot?: boolean;
  /** @external existing wire contract */
  stopOnReverse?: boolean;
};

const DEFAULT_FRAME_RATE = 30;
const CRITICAL_DAMPING_DIVISOR = 2;
const CRITICAL_DAMPING_THRESHOLD = 1e-8;

type SpringAdvanceResult = {
  position: number;
  velocity: number;
  /** @external existing wire contract */
  settled: boolean;
};

/** Exact damped spring step, shared by card travel and ruler focus/return.
 * Retarget using the current position and velocity; no animation clock restarts. */
export function advanceSpring(input: {
  position: number;
  velocity: number;
  target: number;
  seconds: number;
  options: SpringOptions;
}): SpringAdvanceResult {
  const { position, velocity, target, seconds, options } = input;
  const dt = Math.max(0, Math.min(seconds, options.maxStep ?? 1 / DEFAULT_FRAME_RATE));
  const currentVelocity = options.stopOnReverse === true && velocity * (target - position) < 0 ? 0 : velocity;
  const displacement = position - target;
  const decayRate = options.damping / CRITICAL_DAMPING_DIVISOR;
  const discriminant = decayRate * decayRate - options.stiffness;
  const underdampedStep = (): { nextDisplacement: number; nextVelocity: number } => {
    const frequency = Math.sqrt(-discriminant);
    const coefficient = (currentVelocity + decayRate * displacement) / frequency;
    const sin = Math.sin(frequency * dt);
    const cos = Math.cos(frequency * dt);
    const decay = Math.exp(-decayRate * dt);
    const nextDisplacement = (displacement * cos + coefficient * sin) * decay;
    const nextVelocity =
      (-decayRate * (displacement * cos + coefficient * sin) + frequency * (coefficient * cos - displacement * sin)) *
      decay;

    return { nextDisplacement, nextVelocity };
  };
  const criticallyDampedStep = (): { nextDisplacement: number; nextVelocity: number } => {
    const coefficient = currentVelocity + decayRate * displacement;
    const decay = Math.exp(-decayRate * dt);
    const nextDisplacement = (displacement + coefficient * dt) * decay;
    const nextVelocity = (currentVelocity - decayRate * coefficient * dt) * decay;

    return { nextDisplacement, nextVelocity };
  };
  const overdampedStep = (): { nextDisplacement: number; nextVelocity: number } => {
    const root = Math.sqrt(discriminant);
    const slow = -decayRate + root;
    const fast = -decayRate - root;
    const slowTerm = ((currentVelocity - fast * displacement) / (slow - fast)) * Math.exp(slow * dt);
    const fastTerm = ((slow * displacement - currentVelocity) / (slow - fast)) * Math.exp(fast * dt);
    const nextDisplacement = slowTerm + fastTerm;
    const nextVelocity = slow * slowTerm + fast * fastTerm;

    return { nextDisplacement, nextVelocity };
  };
  const { nextDisplacement, nextVelocity } =
    Math.abs(discriminant) < CRITICAL_DAMPING_THRESHOLD
      ? criticallyDampedStep()
      : discriminant > 0
        ? overdampedStep()
        : underdampedStep();
  const nextPosition = target + nextDisplacement;
  const isCrossed = options.clampOvershoot === true && (target - position) * (target - nextPosition) < 0;
  const isSettled =
    isCrossed ||
    (Math.abs(nextDisplacement) < options.positionTolerance && Math.abs(nextVelocity) < options.velocityTolerance);

  return {
    position: isSettled ? target : nextPosition,
    velocity: isSettled ? 0 : nextVelocity,
    settled: isSettled,
  };
}
