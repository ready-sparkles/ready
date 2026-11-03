import { FALLBACK_SUMMARY_MODEL } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  regenerateCreditBlockedNotesOnOpen,
  regenerateFallbackMeetingNotes,
} from "../../application/fallback-notes-regeneration";
import { isCreditBlockedSummary } from "../../application/snapshot-artifacts";
import { repositories } from "../../ports/repository-runtime";

const CREDIT_BLOCKED =
  "Meeting notes weren't generated because there weren't enough AI credits. Add credits, then choose Generate notes. The transcript is available for review.";
const LEGACY_CREDIT_BLOCKED =
  "Meeting notes could not be generated because the meeting host ran out of AI credits. The transcript is available for review.";
const GENERIC_FALLBACK = "Meeting notes are unavailable right now. The transcript is available for review.";

type ClaimInput = Parameters<ReturnType<typeof repositories>["claimMeetingNotesRegeneration"]>[0];

function silentLogger(t: test.TestContext) {
  return { info: t.mock.fn(), warn: t.mock.fn(), error: t.mock.fn() };
}

void test("credit-blocked fallbacks are recognised in both the current and the legacy wording", () => {
  assert.equal(isCreditBlockedSummary({ model: FALLBACK_SUMMARY_MODEL, content: CREDIT_BLOCKED }), true);
  assert.equal(isCreditBlockedSummary({ model: FALLBACK_SUMMARY_MODEL, content: LEGACY_CREDIT_BLOCKED }), true);
  assert.equal(isCreditBlockedSummary({ model: FALLBACK_SUMMARY_MODEL, content: GENERIC_FALLBACK }), false);
  assert.equal(isCreditBlockedSummary({ model: "gpt-5.4-mini", content: CREDIT_BLOCKED }), false);
});

void test("a claim the server already holds or no longer needs is reported instead of paying again", async (t) => {
  const outcomes = ["in_progress", "not_needed", "recently_failed"] as const;
  const seen = { inputs: [] as ClaimInput[] };
  t.mock.method(repositories(), "claimMeetingNotesRegeneration", async (claimInput: ClaimInput) => {
    const status = outcomes[seen.inputs.length] ?? "not_needed";
    seen.inputs = [...seen.inputs, claimInput];

    return { status };
  });
  const logger = silentLogger(t);
  const results = await outcomes.reduce<Promise<string[]>>(async (previous) => {
    const collected = await previous;

    return [...collected, await regenerateFallbackMeetingNotes({ meetingId: "meeting", logger, trigger: "manual" })];
  }, Promise.resolve([]));
  assert.deepEqual(results, ["in_progress", "not_needed", "recently_failed"]);
  assert.ok(seen.inputs.every((claimInput) => claimInput.regenerableSummaryModel === FALLBACK_SUMMARY_MODEL));
  assert.ok(seen.inputs.every((claimInput) => claimInput.retryAfterFailureMs === undefined));
});

void test("opening a meeting retries only credit-blocked notes and backs off after a failed retry", async (t) => {
  const seen = { inputs: [] as ClaimInput[] };
  t.mock.method(repositories(), "claimMeetingNotesRegeneration", async (claimInput: ClaimInput) => {
    seen.inputs = [...seen.inputs, claimInput];

    return { status: "recently_failed" as const };
  });
  const logger = silentLogger(t);
  const open = (summary: { model: string; content: string } | null) =>
    regenerateCreditBlockedNotesOnOpen({ meetingId: "meeting", summary, logger });

  assert.equal(await open(null), "not_needed");
  assert.equal(await open({ model: FALLBACK_SUMMARY_MODEL, content: GENERIC_FALLBACK }), "not_needed");
  assert.equal(await open({ model: "gpt-5.4-mini", content: "Real notes" }), "not_needed");
  assert.equal(seen.inputs.length, 0);

  assert.equal(await open({ model: FALLBACK_SUMMARY_MODEL, content: LEGACY_CREDIT_BLOCKED }), "recently_failed");
  assert.equal(seen.inputs.length, 1);
  assert.ok(seen.inputs.every((claimInput) => (claimInput.retryAfterFailureMs ?? 0) > 0));
});
