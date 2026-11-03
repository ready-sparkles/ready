import assert from "node:assert/strict";
import test from "node:test";

import {
  CALENDAR_PREP_PROCESSOR_OPTIONS,
  calendarPrepAdvancedSearchCostMicroUsd,
  calendarPrepCreditQuote,
  calendarPrepParallelCostMicroUsd,
  calendarPrepTaskCostMicroUsd,
} from "../../application/calendar-prep-pricing";

const CORE_TASK_RUN_COUNT = 2;
const CORE_TASK_COST_MICRO_USD = 50_000;
const PRO_TASK_RUN_COUNT = 1;
const PRO_TASK_COST_MICRO_USD = 100_000;
const ULTRA_TASK_COST_MICRO_USD = 300_000;
const SINGLE_ADVANCED_SEARCH_REQUEST_COUNT = 1;
const ADVANCED_SEARCH_BASE_COST_MICRO_USD = 5_000;
const PARALLEL_PREP_COST_MICRO_USD = 55_000;
const PRO_PREP_CREDITS = 8;
const PRO_PREP_REVENUE_MICRO_USD = 800_000;
const MAX_PREP_REVENUE_MICRO_USD = 100_000;

void test("calendar prep pricing exposes only the supported processor choices", () => {
  assert.deepEqual(
    CALENDAR_PREP_PROCESSOR_OPTIONS.map((option) => option.processor),
    ["core", "pro", "ultra"],
  );
});

void test("calendar prep pricing estimates Task API processor request costs", () => {
  assert.equal(
    calendarPrepTaskCostMicroUsd({ processor: "core", taskRunCount: CORE_TASK_RUN_COUNT }),
    CORE_TASK_COST_MICRO_USD,
  );
  assert.equal(
    calendarPrepTaskCostMicroUsd({ processor: "pro", taskRunCount: PRO_TASK_RUN_COUNT }),
    PRO_TASK_COST_MICRO_USD,
  );
  assert.equal(
    calendarPrepTaskCostMicroUsd({ processor: "ultra", taskRunCount: PRO_TASK_RUN_COUNT }),
    ULTRA_TASK_COST_MICRO_USD,
  );
});

void test("calendar prep pricing includes the Advanced Search base request", () => {
  assert.equal(
    calendarPrepAdvancedSearchCostMicroUsd(SINGLE_ADVANCED_SEARCH_REQUEST_COUNT),
    ADVANCED_SEARCH_BASE_COST_MICRO_USD,
  );
  assert.equal(
    calendarPrepParallelCostMicroUsd({
      processor: "core",
      taskRunCount: CORE_TASK_RUN_COUNT,
      advancedSearchRequestCount: SINGLE_ADVANCED_SEARCH_REQUEST_COUNT,
    }),
    PARALLEL_PREP_COST_MICRO_USD,
  );
});

void test("calendar prep quotes use the member plan margin and skip included research", () => {
  const pro = calendarPrepCreditQuote({
    rawCostMicroUsd: PARALLEL_PREP_COST_MICRO_USD,
    plan: "pro",
    isIncluded: false,
  });
  const max = calendarPrepCreditQuote({
    rawCostMicroUsd: PARALLEL_PREP_COST_MICRO_USD,
    plan: "max",
    isIncluded: false,
  });
  const included = calendarPrepCreditQuote({
    rawCostMicroUsd: PARALLEL_PREP_COST_MICRO_USD,
    plan: "pro",
    isIncluded: true,
  });
  assert.equal(pro.creditsCharged, PRO_PREP_CREDITS);
  assert.equal(pro.revenueMicroUsd, PRO_PREP_REVENUE_MICRO_USD);
  assert.equal(max.creditsCharged, 1);
  assert.equal(max.revenueMicroUsd, MAX_PREP_REVENUE_MICRO_USD);
  assert.equal(included.creditsCharged, 0);
  assert.equal(included.revenueMicroUsd, 0);
});
