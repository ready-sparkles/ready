import { InsufficientAiCreditsError } from "@readymeet/db/domain/persistence-errors";
import { INSUFFICIENT_CREDITS_CODE } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  canSnapshotReplaceMeetingTitle,
  completedQuickTitleFromJob,
  persistSnapshotFallbackIfMissing,
} from "../../application/snapshot-artifacts";
import { repositories } from "../../ports/repository-runtime";

void test("completed quick title provenance allows the final snapshot to improve it", () => {
  const quickTitleJobResult: Record<string, unknown> = { title: "Early Product Review" };
  quickTitleJobResult.updated = true;
  const quickTitle = completedQuickTitleFromJob({
    status: "completed",
    result: quickTitleJobResult,
  });

  assert.equal(quickTitle, "Early Product Review");
  assert.equal(
    canSnapshotReplaceMeetingTitle({
      currentTitle: "early product review",
      participantTitle: null,
      transcriptFallbackTitle: "Opening Transcript Fragment",
      quickTitle,
    }),
    true,
  );
});

void test("manual and calendar titles remain protected from snapshot replacement", () => {
  assert.equal(
    canSnapshotReplaceMeetingTitle({
      currentTitle: "Customer Renewal Plan",
      participantTitle: null,
      transcriptFallbackTitle: "Pricing Discussion",
      quickTitle: "Pricing Review",
    }),
    false,
  );

  const calendarJobResult: Record<string, unknown> = { title: "Calendar Planning" };
  calendarJobResult.updated = false;
  assert.equal(
    completedQuickTitleFromJob({
      status: "completed",
      result: calendarJobResult,
    }),
    null,
  );
});

void test("snapshot fallback explains typed and upstream credit denials without exposing private errors", async (t) => {
  t.mock.method(repositories(), "getSummaryForMeeting", async () => null);
  const save = t.mock.method(repositories(), "upsertSummaryForMeeting", async () => ({}));
  const PRIVATE_ERROR = "private provider content";
  const HTTP_PAYMENT_REQUIRED = 402;
  const logger = { warn: t.mock.fn() };
  await Promise.all(
    [
      new InsufficientAiCreditsError(),
      Object.assign(new Error(PRIVATE_ERROR), { statusCode: HTTP_PAYMENT_REQUIRED, code: INSUFFICIENT_CREDITS_CODE }),
    ].map(async (error) => {
      await persistSnapshotFallbackIfMissing({ meetingId: "meeting", logger, error });
    }),
  );
  save.mock.calls.forEach((call) => {
    const input = call.arguments[0];
    assert.ok(input);
    assert.match(input.content, /AI credits/);
    assert.equal(input.model, "fallback-summary-v1");
    assert.equal(input.shouldPreserveExisting, true);
  });
  logger.warn.mock.calls.forEach((call) => {
    assert.deepEqual(call.arguments[0], { meetingId: "meeting", code: INSUFFICIENT_CREDITS_CODE });
  });
});

void test("unknown snapshot failures stay generic and successful notes remain unchanged", async (t) => {
  t.mock.method(repositories(), "getSummaryForMeeting", async () => null);
  const save = t.mock.method(repositories(), "upsertSummaryForMeeting", async () => ({}));
  const input = { meetingId: "meeting", logger: { warn() {} } };
  const PRIVATE_ERROR = "private details";
  await persistSnapshotFallbackIfMissing({ ...input, error: new Error(PRIVATE_ERROR) });
  assert.equal(
    save.mock.calls[0]?.arguments[0]?.content,
    "Meeting notes could not be generated automatically. The transcript is available for review.",
  );
  t.mock.method(repositories(), "getSummaryForMeeting", async () => ({ content: "saved notes" }));
  await persistSnapshotFallbackIfMissing({ ...input, error: new InsufficientAiCreditsError() });
  assert.equal(save.mock.callCount(), 1);
});
