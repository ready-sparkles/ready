const PRO_GROSS_MARGIN = 0.93;
const MAX_GROSS_MARGIN = 0.3;
const MONTHLY_ALLOWANCE = 250;
const PERCENT = 100;
const INVALID_PROVIDER_COST_MESSAGE = "Provider cost must be a nonnegative safe integer in micro-USD.";

/** Code every service sends with HTTP 402 when AI work is refused for lack of credits or plan. */
// eslint-disable-next-line no-restricted-syntax -- Single definition of the credits code; every caller imports it.
export const INSUFFICIENT_CREDITS_CODE = "insufficient_credits";
/** Internal message on credit-denial errors. */
export const INSUFFICIENT_AI_CREDITS_MESSAGE = "Insufficient AI credits.";
/** User-facing message for the API's 402. The upstream body stays in logs only. */
export const INSUFFICIENT_CREDITS_USER_MESSAGE =
  "You don't have enough AI credits for this. Add credits or upgrade your plan to keep using AI in your meetings.";

export const PLAN_CREDITS = {
  pro: { grossMargin: PRO_GROSS_MARGIN, monthlyAllowance: MONTHLY_ALLOWANCE },
  max: { grossMargin: MAX_GROSS_MARGIN, monthlyAllowance: MONTHLY_ALLOWANCE },
} as const;
export const CREDIT_PRICE_MICRO_USD = 100_000;
export type CreditPlan = keyof typeof PLAN_CREDITS;

export function calculatePlanCredits(input: {
  providerCostMicroUsd: number;
  plan: CreditPlan;
  isIncluded: boolean;
}): number {
  if (!Number.isSafeInteger(input.providerCostMicroUsd) || input.providerCostMicroUsd < 0) {
    throw new RangeError(INVALID_PROVIDER_COST_MESSAGE);
  }
  if (input.isIncluded || input.providerCostMicroUsd === 0) {
    return 0;
  }
  // Integer percentages avoid rounding a whole-credit boundary up twice.
  const retainedPercent = PERCENT - Math.round(PLAN_CREDITS[input.plan].grossMargin * PERCENT);

  return Math.ceil(input.providerCostMicroUsd / ((CREDIT_PRICE_MICRO_USD * retainedPercent) / PERCENT));
}

/**
 * The one private-beta rule shared by charging and the notes lock: a
 * private-beta Pro entitlement (already void for free plans and personal
 * subscriptions) runs AI without spending credits until the billing workspace
 * has its own subscription.
 */
export function hasPrivateBetaUnlimitedCredits(input: {
  hasPrivateBetaProEntitlement: boolean;
  isWorkspaceSubscriptionActive: boolean;
}): boolean {
  return input.hasPrivateBetaProEntitlement && !input.isWorkspaceSubscriptionActive;
}

/** Credits a member can spend right now: the unused monthly allowance plus the workspace pool. */
export function spendableAiCredits(input: { allowanceRemaining: number; poolBalance: number }): number {
  return Math.max(0, input.allowanceRemaining) + Math.max(0, input.poolBalance);
}

/** Smallest output budget a charged request is shrunk to before it is refused for credits. */
export const MIN_CREDIT_FITTED_OUTPUT_TOKENS = 4096;

/**
 * Smallest output budget a charged notes (meeting snapshot) run may start with.
 * Snapshot reasoning plus JSON routinely needs well over 4096 tokens, so a run
 * fitted below this would truncate. Below it, notes stay locked for credits.
 */
export const MIN_NOTES_RUN_OUTPUT_TOKENS = 16_384;

/**
 * Fewest credits a charged notes run can start with: MIN_NOTES_RUN_OUTPUT_TOKENS,
 * the floor the assistant's credit fitting never shrinks a notes run below. The
 * notes lock uses this, so notes are never unlocked for a balance that cannot
 * pay for even the smallest notes run.
 */
export function minimumNotesRunCredits(input: { outputPerMillion: number | undefined; plan: CreditPlan }): number {
  // USD per million tokens is numerically micro-USD per token.
  const outputCostMicroUsd = Math.ceil(MIN_NOTES_RUN_OUTPUT_TOKENS * (input.outputPerMillion ?? 0));

  return Math.max(
    1,
    calculatePlanCredits({ providerCostMicroUsd: outputCostMicroUsd, plan: input.plan, isIncluded: false }),
  );
}
