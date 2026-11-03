import assert from "node:assert/strict";
import test from "node:test";

import { trialOfferTitle } from "../../../presentation/lib/use-trial-offer";

const TRIAL_MEETING_LIMIT = 3;
const SINGLE_REMAINING_MEETING = 1;

void test("full trial offers the meeting limit", () => {
  assert.equal(trialOfferTitle(TRIAL_MEETING_LIMIT), "Try up to 3 meetings, on us.");
});

void test("exhausted trial has no offer title", () => {
  assert.equal(trialOfferTitle(0), null);
});

void test("partially used trial shows only the remaining meetings", () => {
  assert.equal(trialOfferTitle(SINGLE_REMAINING_MEETING), "1 free meeting remaining.");
});
