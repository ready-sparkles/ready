import { InsufficientAiCreditsError, PaidPlanRequiredForCreditsError } from "@readymeet/db/domain/persistence-errors";
import assert from "node:assert/strict";
import test from "node:test";

import {
  InsufficientProviderCreditsError,
  isProviderAccountingError,
  ProviderAdmissionError,
  ProviderSettlementError,
  UnboundedProviderUsageError,
} from "../../application/metered-provider";
import { screenAshbyTranscript } from "../../domain/ashby-review-model";

const ADMISSION_REFUSED_MESSAGE = "admission refused";
const UNBOUNDED_MESSAGE = "unbounded";
const SETTLEMENT_FAILED_MESSAGE = "settlement failed";
const OFFLINE_MESSAGE = "offline";

const ACCOUNTING_ERRORS = (): Error[] => [
  new ProviderAdmissionError(ADMISSION_REFUSED_MESSAGE),
  new UnboundedProviderUsageError(UNBOUNDED_MESSAGE),
  new InsufficientProviderCreditsError(),
  new ProviderSettlementError(SETTLEMENT_FAILED_MESSAGE),
  new InsufficientAiCreditsError(),
  new PaidPlanRequiredForCreditsError(),
];
const segments = [{ id: "segment-1", content: "We should move the candidate to onsite.", speaker: null }];

void test("plan-required and credit refusals count as provider accounting errors", () => {
  ACCOUNTING_ERRORS().forEach((error) => {
    assert.equal(isProviderAccountingError(error), true, error.name);
  });
  assert.equal(isProviderAccountingError(new Error(OFFLINE_MESSAGE)), false);
  assert.equal(isProviderAccountingError(OFFLINE_MESSAGE), false);
});

void test("Ashby screening propagates every accounting error instead of failing open", async () => {
  await ACCOUNTING_ERRORS().reduce(async (previous, error) => {
    await previous;
    const options = {
      apiKey: "test",
      model: "jev",
      decide: async () => Promise.reject(error),
    };
    await assert.rejects(
      screenAshbyTranscript(segments, { ...options, isAccountingError: isProviderAccountingError }),
      error,
    );
  }, Promise.resolve());
  assert.equal(
    await screenAshbyTranscript(segments, {
      apiKey: "test",
      model: "jev",
      decide: async () => Promise.reject(new Error(OFFLINE_MESSAGE)),
      isAccountingError: isProviderAccountingError,
    }),
    true,
  );
});
