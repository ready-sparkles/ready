import assert from "node:assert/strict";
import test from "node:test";

import {
  getEndedMeetingHistoryVisibility,
  getEndedMeetingNotesPath,
  getMeetingNotesPath,
} from "../../domain/meeting-links";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

void test("an ended meeting links signed-in users to its workspace notes page", () => {
  assert.equal(
    getEndedMeetingNotesPath({
      meeting: { id: MEETING_ID, status: "ended" },
      isGuestSession: false,
      historyVisibility: "listed",
    }),
    `/workspace/${MEETING_ID}`,
  );
});

void test("an ended meeting links guests to the guest notes page", () => {
  assert.equal(
    getEndedMeetingNotesPath({
      meeting: { id: MEETING_ID, status: "ended" },
      isGuestSession: true,
      historyVisibility: "listed",
    }),
    `/guest/meetings/${MEETING_ID}/notes`,
  );
});

void test("meetings that have not ended get no notes link", () => {
  assert.equal(
    getEndedMeetingNotesPath({
      meeting: { id: MEETING_ID, status: "active" },
      isGuestSession: false,
      historyVisibility: "listed",
    }),
    null,
  );
  assert.equal(getEndedMeetingNotesPath({ meeting: null, isGuestSession: false, historyVisibility: "listed" }), null);
});

void test("the notes path matches the page each session can open", () => {
  assert.equal(getMeetingNotesPath({ meetingId: MEETING_ID, isGuestSession: false }), `/workspace/${MEETING_ID}`);
  assert.equal(
    getMeetingNotesPath({ meetingId: MEETING_ID, isGuestSession: true }),
    `/guest/meetings/${MEETING_ID}/notes`,
  );
});

void test("an ended meeting hidden as too short gets no notes link, for users and guests", () => {
  const paths = [false, true].map((isGuestSession) =>
    getEndedMeetingNotesPath({
      meeting: { id: MEETING_ID, status: "ended" },
      isGuestSession,
      historyVisibility: "hidden_too_short",
    }),
  );

  assert.deepEqual(paths, [null, null]);
});

void test("an ended meeting gets no notes link until its history visibility is known", () => {
  assert.equal(
    getEndedMeetingNotesPath({
      meeting: { id: MEETING_ID, status: "ended" },
      isGuestSession: false,
      historyVisibility: "unknown",
    }),
    null,
  );
});

void test("a skipped post-meeting disposition marks the meeting hidden as too short", () => {
  assert.equal(getEndedMeetingHistoryVisibility({ postMeetingDisposition: { status: "skipped" } }), "hidden_too_short");
  assert.equal(getEndedMeetingHistoryVisibility({ postMeetingDisposition: null }), "listed");
  assert.equal(getEndedMeetingHistoryVisibility({ postMeetingDisposition: undefined }), "listed");
});
