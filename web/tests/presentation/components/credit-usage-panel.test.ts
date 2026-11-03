import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  workspaceCreditBalanceMicroUsd,
  WorkspaceCreditUsagePanel,
} from "../../../presentation/components/credit-usage-panel";

const POOL_CREDITS_SAMPLE = 125;
const POOL_PRICE_PER_CREDIT_MICRO_USD_SAMPLE = 250_000;
const EXPECTED_POOL_BALANCE_MICRO_USD = 31_250_000;
const FREE_TRIAL_REMAINING_CREDITS_SAMPLE = 750;
const TOPUP_PRICE_PER_CREDIT_MICRO_USD = 100_000;
const TOPUP_MIN_CREDITS = 100;
const TOPUP_MAX_CREDITS = 10_000;

void test("workspace balance only values purchased and promotional pool credits", () => {
  assert.equal(
    workspaceCreditBalanceMicroUsd({
      poolCredits: POOL_CREDITS_SAMPLE,
      poolPricePerCreditMicroUsd: POOL_PRICE_PER_CREDIT_MICRO_USD_SAMPLE,
    }),
    EXPECTED_POOL_BALANCE_MICRO_USD,
  );
});

void test("unused trial allowance does not increase the displayed workspace balance", () => {
  const billing = {
    freeTrial: { memberCount: 1, remainingCredits: FREE_TRIAL_REMAINING_CREDITS_SAMPLE },
    pool: { balance: 0, topupCredits: 0, promotionalCredits: 0, nextExpiry: null },
    topup: {
      pricePerCreditMicroUsd: TOPUP_PRICE_PER_CREDIT_MICRO_USD,
      minCredits: TOPUP_MIN_CREDITS,
      maxCredits: TOPUP_MAX_CREDITS,
    },
  };
  const markup = renderToStaticMarkup(createElement(WorkspaceCreditUsagePanel, { billing }));
  assert.match(markup, /<strong>\$0<\/strong>/);
  assert.doesNotMatch(markup, /\$75|free-trial credits/);
});
