import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import test from "node:test";

import { readGuestNotesHandoff } from "../../application/guest-notes-transition";

GlobalRegistrator.register();

const HANDOFF_STORAGE_KEY = "readymeet-guest-notes-handoff";
const NOW_MS = 100_000;
const RECENT_HANDOFF_STARTED_AT_MS = 99_000;
const STALE_HANDOFF_STARTED_AT_MS = 100_001;
const MESSAGE_STORAGE_UNAVAILABLE = "Storage unavailable";

void test("only a recent handoff for this meeting enables the dark entrance", (t) => {
  window.sessionStorage.clear();
  const invalidHandoffValues = [
    "invalid",
    JSON.stringify({ meetingId: "other", startedAt: RECENT_HANDOFF_STARTED_AT_MS }),
    JSON.stringify({ meetingId: "meeting", startedAt: 1 }),
    JSON.stringify({ meetingId: "meeting", startedAt: STALE_HANDOFF_STARTED_AT_MS }),
  ];
  assert.equal(readGuestNotesHandoff({ meetingId: "meeting", now: NOW_MS }), null);
  invalidHandoffValues.forEach((value) => {
    window.sessionStorage.setItem(HANDOFF_STORAGE_KEY, value);
    assert.equal(readGuestNotesHandoff({ meetingId: "meeting", now: NOW_MS }), null);
  });
  window.sessionStorage.setItem(
    HANDOFF_STORAGE_KEY,
    JSON.stringify({ meetingId: "meeting", startedAt: RECENT_HANDOFF_STARTED_AT_MS }),
  );
  assert.equal(readGuestNotesHandoff({ meetingId: "meeting", now: NOW_MS }), RECENT_HANDOFF_STARTED_AT_MS);
  t.mock.method(window.sessionStorage, "getItem", () => {
    throw new Error(MESSAGE_STORAGE_UNAVAILABLE);
  });
  assert.equal(readGuestNotesHandoff({ meetingId: "meeting", now: NOW_MS }), null);
});
