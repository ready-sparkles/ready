import { MEETING_PREPARATION_FALLBACK_LINES } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingPreparationPreview,
  MEETING_PREPARATION_JOB_GRACE_MS,
} from "../../domain/meeting-preparation-preview";

void test("meeting preparation remains pending while its model job is active", () => {
  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: false,
      job: { status: "running", result: {} },
    }),
    {
      status: "pending",
      lines: [],
      source: null,
    },
  );
});

void test("meeting preparation keeps polling briefly when an ended meeting has no title job yet", () => {
  const endedAt = new Date("2026-08-10T12:00:00.000Z");

  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: false,
      job: null,
      endedAt,
      nowMs: endedAt.getTime() + MEETING_PREPARATION_JOB_GRACE_MS - 1,
    }),
    {
      status: "pending",
      lines: [],
      source: null,
    },
  );
});

void test("meeting preparation settles on fallback after the missing-job grace period", () => {
  const endedAt = new Date("2026-08-10T12:00:00.000Z");

  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: false,
      job: null,
      endedAt,
      nowMs: endedAt.getTime() + MEETING_PREPARATION_JOB_GRACE_MS,
    }),
    {
      status: "ready",
      lines: [...MEETING_PREPARATION_FALLBACK_LINES],
      source: "fallback",
    },
  );
});

void test("meeting preparation exposes completed transcript-grounded lines", () => {
  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: false,
      job: {
        status: "completed",
        result: {
          preparationLines: [
            "Tracing renewal options against the customer timeline.",
            "Separating pricing concerns from implementation risks.",
          ],
        },
      },
    }),
    {
      status: "ready",
      lines: [
        "Tracing renewal options against the customer timeline.",
        "Separating pricing concerns from implementation risks.",
      ],
      source: "model",
    },
  );
});

void test("completed title jobs can degrade only their preparation deck to fallback", () => {
  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: false,
      job: {
        status: "completed",
        result: {
          preparationLines: [...MEETING_PREPARATION_FALLBACK_LINES],
          /** @external existing preparation job result field */
          fallback: true,
        },
      },
    }),
    {
      status: "ready",
      lines: [...MEETING_PREPARATION_FALLBACK_LINES],
      source: "fallback",
    },
  );
});

void test("locked viewers without upgrade previews and failed jobs receive a finite fallback deck", () => {
  const expected = [...MEETING_PREPARATION_FALLBACK_LINES];

  assert.deepEqual(buildMeetingPreparationPreview({ locked: true, job: null }), {
    status: "ready",
    lines: expected,
    source: "fallback",
  });
  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: false,
      job: { status: "failed", result: {} },
    }),
    {
      status: "ready",
      lines: expected,
      source: "fallback",
    },
  );
});

const MEETING_PREPARATION_FULL_DECK_LINE_COUNT = 12;

void test("free upgrade previews expose the entire existing model deck without an excerpt cap", () => {
  const lines = Array.from(
    { length: MEETING_PREPARATION_FULL_DECK_LINE_COUNT },
    (_, index) => `Conclusion ${index + 1}: the customer launch depends on the security review finishing on Friday.`,
  );
  const job = { status: "completed" as const, result: { preparationLines: lines } };
  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: true,
      allowUpgradePreview: true,
      job,
    }),
    buildMeetingPreparationPreview({ locked: false, job }),
  );
  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: true,
      allowUpgradePreview: true,
      job,
    }).lines,
    lines,
  );
  assert.equal(
    buildMeetingPreparationPreview({ locked: true, job }).source,
    "fallback",
    "other locked viewers still receive generic preparation text",
  );
});

void test("free upgrade previews wait for the same model job while it is running", () => {
  assert.deepEqual(
    buildMeetingPreparationPreview({
      locked: true,
      allowUpgradePreview: true,
      job: { status: "running", result: {} },
    }),
    { status: "pending", lines: [], source: null },
  );
});
