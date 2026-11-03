import type { MeetingTaskCandidate } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { assetIdsForTaskCandidate, type TaskAssetLinkingSegment } from "../../domain/task-asset-linking";

const TRANSCRIPT_SEGMENT_COUNT = 8;
const UUID_SEQUENCE_PAD_LENGTH = 12;
const MESSAGE_MISSING_INDEXED_VALUE = "Missing value at the requested index.";

const TRANSCRIPT_YEAR = 2026;
const TRANSCRIPT_MONTH_AUGUST = 7;
const TRANSCRIPT_DAY = 5;
const TRANSCRIPT_BASE_HOUR = 12;
const TRANSCRIPT_BASE_MINUTE = 0;
const TRANSCRIPT_SEGMENT_SPACING_SECONDS = 10;

const EXACT_SEGMENT_INDEX = 3;
const NEARBY_SEGMENT_INDEX = 5;

const DEFAULT_SOURCE_TIMESTAMP = "2026-08-05T12:00:30.000Z";
const SEMANTIC_CAPTURE_TIMESTAMP = "2026-08-05T12:00:32.000Z";
const DISTANT_CAPTURE_TIMESTAMP = "2026-08-05T12:05:00.000Z";

const segmentIds = Array.from(
  { length: TRANSCRIPT_SEGMENT_COUNT },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(UUID_SEQUENCE_PAD_LENGTH, "0")}`,
);

function at<T>(input: { values: readonly T[]; index: number }): T {
  const value = input.values[input.index];
  if (value === undefined) {
    throw new Error(MESSAGE_MISSING_INDEXED_VALUE);
  }

  return value;
}

const segments: TaskAssetLinkingSegment[] = segmentIds.map((id, index) => ({
  id,
  startedAt: new Date(
    Date.UTC(
      TRANSCRIPT_YEAR,
      TRANSCRIPT_MONTH_AUGUST,
      TRANSCRIPT_DAY,
      TRANSCRIPT_BASE_HOUR,
      TRANSCRIPT_BASE_MINUTE,
      index * TRANSCRIPT_SEGMENT_SPACING_SECONDS,
    ),
  ),
  content: `Transcript segment ${index}`,
}));

function candidate(input: { segmentId: string | null; timestamp?: string }): MeetingTaskCandidate {
  const timestamp = input.timestamp ?? DEFAULT_SOURCE_TIMESTAMP;

  return {
    title: "Add a date filter to the analytics dashboard",
    description: "Let customers filter the dashboard by a custom date range.",
    type: "task",
    workKind: "implementation",
    owner: { userId: null, name: null, email: null, confidence: null },
    dueDate: { value: null, confidence: null },
    confidence: "high",
    completion: { completedDuringMeeting: false, quote: null, confidence: null },
    sourceQuotes: [
      {
        quote: "Can we add a date filter to this dashboard?",
        speaker: "Customer",
        timestamp,
        segmentId: input.segmentId,
      },
    ],
    sourceReason: "The customer requested a concrete dashboard change.",
  };
}

void test("links exact or nearby transcript provenance only when its excerpt matches the task", () => {
  const assets = [
    {
      id: "exact",
      transcriptSegmentIds: [at({ values: segmentIds, index: EXACT_SEGMENT_INDEX })],
      transcriptExcerpt: "Can we add a date filter to this dashboard?",
      capturedAt: at({ values: segments, index: EXACT_SEGMENT_INDEX }).startedAt,
    },
    {
      id: "nearby",
      transcriptSegmentIds: [at({ values: segmentIds, index: NEARBY_SEGMENT_INDEX })],
      transcriptExcerpt: "The dashboard date filter should support a custom range.",
      capturedAt: at({ values: segments, index: NEARBY_SEGMENT_INDEX }).startedAt,
    },
  ];

  assert.deepEqual(
    assetIdsForTaskCandidate({
      candidate: candidate({ segmentId: at({ values: segmentIds, index: EXACT_SEGMENT_INDEX }) }),
      assets,
      segments,
    }),
    ["exact", "nearby"],
  );
});

void test("uses close time plus transcript meaning when segment provenance is unavailable", () => {
  const assets = [
    {
      id: "semantic",
      transcriptSegmentIds: [],
      transcriptExcerpt: "Can we add the date filter to this dashboard?",
      capturedAt: new Date(SEMANTIC_CAPTURE_TIMESTAMP),
    },
  ];

  assert.deepEqual(assetIdsForTaskCandidate({ candidate: candidate({ segmentId: null }), assets, segments }), [
    "semantic",
  ]);
});

void test("does not link unrelated or distant captures", () => {
  const assets = [
    {
      id: "unrelated-exact-segment",
      transcriptSegmentIds: [at({ values: segmentIds, index: EXACT_SEGMENT_INDEX })],
      transcriptExcerpt: "The billing address field overlaps the checkout button.",
      capturedAt: new Date(DEFAULT_SOURCE_TIMESTAMP),
    },
    {
      id: "unrelated-nearby-segment",
      transcriptSegmentIds: [at({ values: segmentIds, index: NEARBY_SEGMENT_INDEX })],
      transcriptExcerpt: "The billing address field overlaps the checkout button.",
      capturedAt: new Date(SEMANTIC_CAPTURE_TIMESTAMP),
    },
    {
      id: "distant",
      transcriptSegmentIds: [],
      transcriptExcerpt: "Can we add the date filter to this dashboard?",
      capturedAt: new Date(DISTANT_CAPTURE_TIMESTAMP),
    },
  ];

  assert.deepEqual(
    assetIdsForTaskCandidate({
      candidate: candidate({ segmentId: at({ values: segmentIds, index: EXACT_SEGMENT_INDEX }) }),
      assets,
      segments,
    }),
    [],
  );
});
