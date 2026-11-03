import assert from "node:assert/strict";
import test from "node:test";

import { shouldOpenPastMeetingRemoveShortcut } from "../../domain/past-meeting-removal";

void test("past meeting remove shortcut handles Delete and Backspace on past view", () => {
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete" },
      context: { view: "past", hasSelectedMeeting: true },
    }),
    true,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Backspace" },
      context: { view: "past", hasSelectedMeeting: true },
    }),
    true,
  );
});

void test("upcoming calendar event remove shortcut handles Delete and Backspace on upcoming view", () => {
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete" },
      context: { view: "upcoming", hasSelectedCalendarEvent: true },
    }),
    true,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Backspace" },
      context: { view: "upcoming", hasSelectedCalendarEvent: true },
    }),
    true,
  );
});

void test("past meeting remove shortcut ignores editable targets", () => {
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete", target: { tagName: "INPUT" } },
      context: { view: "past", hasSelectedMeeting: true },
    }),
    false,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Backspace", target: { tagName: "textarea" } },
      context: { view: "past", hasSelectedMeeting: true },
    }),
    false,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete", target: { isContentEditable: true } },
      context: { view: "past", hasSelectedMeeting: true },
    }),
    false,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete", target: { tagName: "INPUT" } },
      context: { view: "upcoming", hasSelectedCalendarEvent: true },
    }),
    false,
  );
});

void test("past meeting remove shortcut ignores modifier keys", () => {
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete", metaKey: true } satisfies Pick<KeyboardEvent, "key" | "metaKey">,
      context: { view: "past", hasSelectedMeeting: true },
    }),
    false,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Backspace", shiftKey: true } satisfies Pick<KeyboardEvent, "key" | "shiftKey">,
      context: { view: "past", hasSelectedMeeting: true },
    }),
    false,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete", ctrlKey: true } satisfies Pick<KeyboardEvent, "key" | "ctrlKey">,
      context: { view: "upcoming", hasSelectedCalendarEvent: true },
    }),
    false,
  );
});

void test("past meeting remove shortcut requires past view with a selected meeting and no overlay", () => {
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete" },
      context: { view: "upcoming", hasSelectedMeeting: true },
    }),
    false,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete" },
      context: { view: "past", hasSelectedMeeting: false },
    }),
    false,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete" },
      context: { view: "past", hasSelectedMeeting: true, hasActiveOverlay: true },
    }),
    false,
  );
});

void test("upcoming calendar event remove shortcut requires a selected event and no overlay", () => {
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete" },
      context: { view: "upcoming", hasSelectedCalendarEvent: false },
    }),
    false,
  );
  assert.equal(
    shouldOpenPastMeetingRemoveShortcut({
      event: { key: "Delete" },
      context: { view: "upcoming", hasSelectedCalendarEvent: true, hasActiveOverlay: true },
    }),
    false,
  );
});
