import {
  calculatePlanCredits,
  type CalendarEventPrepEstimateResponse,
  type CalendarEventPrepProcessor,
  CREDIT_PRICE_MICRO_USD,
  type CreditPlan,
  PLAN_CREDITS,
} from "@readymeet/shared";

import { repositories } from "../ports/repository-runtime";

import { getCalendarPrepAccessForUser, shouldRequireCalendarPrepGrantCredits } from "./calendar-prep-access";

const CORE_PRICE_PER_THOUSAND_REQUESTS_USD = 25;
const PRO_PRICE_PER_THOUSAND_REQUESTS_USD = 100;
const ULTRA_PRICE_PER_THOUSAND_REQUESTS_USD = 300;
const REQUESTS_PER_PRICING_UNIT = 1000;
const MICRO_USD_PER_USD = 1_000_000;

type CalendarPrepProcessorOption = {
  processor: CalendarEventPrepProcessor;
  label: string;
  pricePerThousandRequestsUsd: number;
  latency: string;
  maxFields: string;
};

export const CALENDAR_PREP_PROCESSOR_OPTIONS: CalendarPrepProcessorOption[] = [
  {
    processor: "core",
    label: "Core",
    pricePerThousandRequestsUsd: CORE_PRICE_PER_THOUSAND_REQUESTS_USD,
    latency: "1m-5m",
    maxFields: "~10",
  },
  {
    processor: "pro",
    label: "Pro",
    pricePerThousandRequestsUsd: PRO_PRICE_PER_THOUSAND_REQUESTS_USD,
    latency: "3m-9m",
    maxFields: "~20",
  },
  {
    processor: "ultra",
    label: "Ultra",
    pricePerThousandRequestsUsd: ULTRA_PRICE_PER_THOUSAND_REQUESTS_USD,
    latency: "5m-25m",
    maxFields: "~20",
  },
];

const PARALLEL_ADVANCED_SEARCH_PRICE_PER_THOUSAND_REQUESTS_USD = 5;

function microUsdFromUsd(value: number): number {
  return Math.max(0, Math.round(value * MICRO_USD_PER_USD));
}

export function calendarPrepTaskCostMicroUsd(input: {
  processor: CalendarEventPrepProcessor;
  taskRunCount: number;
}): number {
  const option = CALENDAR_PREP_PROCESSOR_OPTIONS.find((item) => item.processor === input.processor);
  if (!option) {
    return 0;
  }

  return microUsdFromUsd(
    (option.pricePerThousandRequestsUsd / REQUESTS_PER_PRICING_UNIT) * Math.max(0, input.taskRunCount),
  );
}

export function calendarPrepAdvancedSearchCostMicroUsd(advancedSearchRequestCount: number): number {
  return microUsdFromUsd(
    (PARALLEL_ADVANCED_SEARCH_PRICE_PER_THOUSAND_REQUESTS_USD / REQUESTS_PER_PRICING_UNIT) *
      Math.max(0, advancedSearchRequestCount),
  );
}

export function calendarPrepParallelCostMicroUsd(input: {
  processor: CalendarEventPrepProcessor;
  taskRunCount: number;
  advancedSearchRequestCount: number;
}): number {
  return calendarPrepTaskCostMicroUsd(input) + calendarPrepAdvancedSearchCostMicroUsd(input.advancedSearchRequestCount);
}

export function calendarPrepCreditQuote(input: { rawCostMicroUsd: number; plan: CreditPlan; isIncluded: boolean }): {
  rawCostMicroUsd: number;
  pricePerCreditMicroUsd: number;
  markupMultiplier: number;
  creditsCharged: number;
  revenueMicroUsd: number;
} {
  const creditsCharged = calculatePlanCredits({
    providerCostMicroUsd: input.rawCostMicroUsd,
    plan: input.plan,
    isIncluded: input.isIncluded,
  });
  const retainedShare = 1 - PLAN_CREDITS[input.plan].grossMargin;

  return {
    rawCostMicroUsd: input.rawCostMicroUsd,
    pricePerCreditMicroUsd: CREDIT_PRICE_MICRO_USD,
    markupMultiplier: retainedShare === 0 ? 0 : 1 / retainedShare,
    creditsCharged,
    revenueMicroUsd: creditsCharged * CREDIT_PRICE_MICRO_USD,
  };
}

export async function calendarPrepBillingTerms(userId: string): Promise<{
  plan: CreditPlan;
  isIncluded: boolean;
  workspaceId: string | null;
  workspacePlan: string | null;
}> {
  const user = await repositories().getUserById(userId);
  const workspaceId = user !== null && user.workspaceId.length > 0 ? user.workspaceId : null;
  const [access, workspacePlan] = await Promise.all([
    getCalendarPrepAccessForUser(userId),
    workspaceId === null ? Promise.resolve(null) : repositories().getWorkspacePlan(workspaceId),
  ]);

  return {
    plan: workspacePlan === "max" ? "max" : "pro",
    isIncluded: !shouldRequireCalendarPrepGrantCredits(access),
    workspaceId,
    workspacePlan,
  };
}

export async function calendarPrepProcessorEstimateOptions(input: {
  userId: string;
  taskRunCount: number;
  advancedSearchRequestCount: number;
}): Promise<CalendarEventPrepEstimateResponse["options"]> {
  const terms = await calendarPrepBillingTerms(input.userId);

  return CALENDAR_PREP_PROCESSOR_OPTIONS.map((option) => {
    const estimate = calendarPrepCreditQuote({
      rawCostMicroUsd: calendarPrepParallelCostMicroUsd({
        processor: option.processor,
        taskRunCount: input.taskRunCount,
        advancedSearchRequestCount: input.advancedSearchRequestCount,
      }),
      plan: terms.plan,
      isIncluded: terms.isIncluded,
    });

    return {
      ...option,
      taskRunCount: input.taskRunCount,
      advancedSearchRequestCount: input.advancedSearchRequestCount,
      ...estimate,
    };
  });
}
