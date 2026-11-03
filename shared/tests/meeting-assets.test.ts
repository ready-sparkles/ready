import assert from "node:assert/strict";
import test from "node:test";

import { createInternalMeetingAssetRequestSchema } from "../domain/meeting-assets";

const TOO_MANY_TRANSCRIPT_SEGMENTS = 10;
const MAX_TRANSCRIPT_SEGMENTS = 9;
const UUID_SUFFIX_LENGTH = 12;

void test("automatic task captures accept a bounded transcript context window", () => {
  const result = createInternalMeetingAssetRequestSchema.safeParse({
    meetingId: "11111111-1111-4111-8111-111111111111",
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    capturedAt: "2026-08-05T12:00:00.000Z",
    trigger: "automatic_task_context",
    transcriptSegmentId: "22222222-2222-4222-8222-222222222222",
    transcriptSegmentIds: ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
  });

  assert.equal(result.success, true);
});

void test("automatic task captures accept Python ISO timestamps with a UTC offset", () => {
  const result = createInternalMeetingAssetRequestSchema.safeParse({
    meetingId: "11111111-1111-4111-8111-111111111111",
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    capturedAt: "2026-08-06T03:59:40.943445+00:00",
    trigger: "automatic_task_context",
  });

  assert.equal(result.success, true);
});

void test("automatic task captures reject timestamps without an explicit timezone", () => {
  const result = createInternalMeetingAssetRequestSchema.safeParse({
    meetingId: "11111111-1111-4111-8111-111111111111",
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    capturedAt: "2026-08-06T03:59:40.943445",
    trigger: "automatic_task_context",
  });

  assert.equal(result.success, false);
});

void test("automatic task captures reject an unbounded transcript context window", () => {
  const result = createInternalMeetingAssetRequestSchema.safeParse({
    meetingId: "11111111-1111-4111-8111-111111111111",
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    capturedAt: "2026-08-05T12:00:00.000Z",
    trigger: "automatic_task_context",
    transcriptSegmentIds: Array.from(
      { length: TOO_MANY_TRANSCRIPT_SEGMENTS },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(UUID_SUFFIX_LENGTH, "0")}`,
    ),
  });

  assert.equal(result.success, false);
});

void test("automatic task captures apply the segment cap after merging unique provenance", () => {
  const transcriptSegmentIds = Array.from(
    { length: MAX_TRANSCRIPT_SEGMENTS },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(UUID_SUFFIX_LENGTH, "0")}`,
  );
  const result = createInternalMeetingAssetRequestSchema.safeParse({
    meetingId: "11111111-1111-4111-8111-111111111111",
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    capturedAt: "2026-08-05T12:00:00.000Z",
    trigger: "automatic_task_context",
    transcriptSegmentId: "99999999-9999-4999-8999-999999999999",
    transcriptSegmentIds,
  });

  assert.equal(result.success, false);
});
