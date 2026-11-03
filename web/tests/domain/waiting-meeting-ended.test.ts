import assert from "node:assert/strict";
import test from "node:test";

import { hasWaitingMeetingEnded } from "../../domain/waiting-meeting-ended";

void test("a waiting or admitted request cannot enter its ended meeting", () => {
  (["waiting", "admitted"] as const).forEach((status) => {
    assert.equal(
      hasWaitingMeetingEnded({
        request: { meetingId: "meeting-1", status },
        meeting: { id: "meeting-1", status: "ended" },
      }),
      true,
    );
  });
});

void test("an unscheduled request or a different meeting ending does not end this wait", () => {
  assert.equal(hasWaitingMeetingEnded({ request: { meetingId: null, status: "waiting" }, meeting: null }), false);
  assert.equal(
    hasWaitingMeetingEnded({
      request: { meetingId: "meeting-2", status: "waiting" },
      meeting: { id: "meeting-1", status: "ended" },
    }),
    false,
  );
});

void test("expired requests leave the waiting screen even without a meeting", () => {
  assert.equal(hasWaitingMeetingEnded({ request: { meetingId: null, status: "expired" }, meeting: null }), true);
});
