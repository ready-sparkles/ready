import type { CalendarEventsResponse, NormalizedCalendarEvent } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  addReadyMeetingToCalendarEventsResponse,
  getCalendarEventAvatarUrlCandidates,
  getCalendarEventDatedSubtitleParts,
  getCalendarEventLogoDay,
  getCalendarEventParticipantPeople,
  getCalendarEventPersonInitials,
  getCalendarEventSelection,
  getCalendarEventSubtitleParts,
  getCalendarEventTitle,
  getUpcomingCalendarEventGroups,
  getUpcomingPreviousCalendarNavigation,
  getVisibleCalendarEvents,
  removeCalendarEventFromResponse,
} from "../../domain/calendar-events";

const READY_MEETING_CODE = "abc-defg-hij";
const READY_MEETING_LINK_ID = "11111111-1111-4111-8111-111111111111";
const READY_MEETING_JOIN_URL = `https://app.ready.test/${READY_MEETING_CODE}`;

function event(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: "google_calendar:primary:event-1",
    provider: "google_calendar",
    providerEventId: "event-1",
    providerRecurringEventId: null,
    providerEventKey: overrides.providerEventId ?? "event-1",
    calendarId: "primary",
    title: "Design review",
    start: "2026-05-06T18:00:00.000Z",
    end: "2026-05-06T19:00:00.000Z",
    timezone: "UTC",
    location: null,
    organizer: null,
    attendees: [],
    isPrivate: false,
    isCancelled: false,
    isAllDay: false,
    canAddReadyMeeting: true,
    /** @external calendar event wire field */
    needsCalendarWriteConsent: false,
    joinUrl: null,
    readyMeeting: null,
    sourceUrl: null,
    ...overrides,
  };
}

const TEST_VALUE_2 = 2;
const TEST_VALUE_2026 = 2026;
const TEST_VALUE_23 = 23;
const TEST_VALUE_3 = 3;
const TEST_VALUE_30 = 30;
const TEST_VALUE_8 = 8;
const TEST_VALUE_9 = 9;
void test("private calendar events render with a private title", () => {
  assert.equal(getCalendarEventTitle(event({ isPrivate: true, title: "Hidden thing" })), "Private event");
});

void test("Ready logo uses the selected event day in the viewer calendar timezone", () => {
  assert.equal(
    getCalendarEventLogoDay(
      event({
        start: new Date(TEST_VALUE_2026, TEST_VALUE_8, TEST_VALUE_30, TEST_VALUE_23, TEST_VALUE_30).toISOString(),
      }),
    ),
    TEST_VALUE_30,
  );
  assert.equal(
    getCalendarEventLogoDay(
      event({ start: new Date(TEST_VALUE_2026, TEST_VALUE_9, 1, 0, TEST_VALUE_30).toISOString() }),
    ),
    1,
  );
});

void test("Ready logo preserves all-day dates and omits invalid dates", () => {
  assert.equal(getCalendarEventLogoDay(event({ start: "2026-10-01", isAllDay: true })), 1);
  assert.equal(getCalendarEventLogoDay(event({ start: "2026-10-01T00:00:00.000Z", isAllDay: true })), 1);
  assert.equal(getCalendarEventLogoDay(event({ start: "invalid" })), null);
});

void test("cancelled calendar events are filtered from visible events", () => {
  assert.deepEqual(
    getVisibleCalendarEvents([event({ id: "visible" }), event({ id: "cancelled", isCancelled: true })]).map(
      (item) => item.id,
    ),
    ["visible"],
  );
});

void test("upcoming includes all calendar events regardless of participants or Ready link", () => {
  const self = {
    email: "calendar@example.com",
    name: "Host",
    responseStatus: "accepted",
    avatarUrl: null,
    readyMeetAvatarUrl: null,
  };
  const readyMeeting = {
    source: "provider_event" as const,
    joinUrl: "https://ready.app/abc-defg-hij",
    callIn: { phoneNumber: "+12025550123", pin: "123456" },
  };
  const addon = event({ id: "addon", organizer: self, attendees: [], canAddReadyMeeting: false, readyMeeting });
  const web = event({
    id: "web",
    organizer: self,
    attendees: [self],
    readyMeeting: { ...readyMeeting, source: "mapping" },
  });
  const events = getVisibleCalendarEvents([
    addon,
    web,
    event({ id: "unknown-attendees", readyMeeting }),
    event({ id: "personal", organizer: self, attendees: [self] }),
    event({ id: "no-attendees", attendees: [], readyMeeting: null }),
    event({ id: "cancelled", isCancelled: true, readyMeeting }),
    event({ id: "ordinary-meeting", attendees: [{ ...self, email: "other@example.com" }] }),
    event({ id: "ended", readyMeeting, end: "2026-05-06T17:00:00.000Z" }),
  ]);
  const upcoming = getUpcomingCalendarEventGroups(events, new Date("2026-05-06T17:30:00.000Z")).flatMap(
    (group) => group.events,
  );
  assert.deepEqual(
    upcoming.map((item) => item.id),
    ["addon", "web", "unknown-attendees", "personal", "no-attendees", "ordinary-meeting"],
  );
  assert.equal(
    upcoming[0]?.readyMeeting,
    addon.readyMeeting,
    "preserve the provider link, dial-in, and PIN for the existing Ready card",
  );
  assert.deepEqual(upcoming[0]?.readyMeeting?.callIn, web.readyMeeting?.callIn);
});

void test("calendar event response removal drops event and prep summary", () => {
  const response: CalendarEventsResponse = {
    events: [
      event({ id: "google_calendar:primary:event-1" }),
      event({ id: "google_calendar:primary:event-2", providerEventId: "event-2" }),
    ],
    connectedProviders: ["google_calendar"],
    /** @external calendar events response wire field */
    needsConnection: false,
    photoPermissionMissingProviders: [],
    prepSummaries: [
      {
        calendarEventId: "google_calendar:primary:event-1",
        eventFingerprint: "fingerprint-1",
        prepId: "11111111-1111-4111-8111-111111111111",
        status: "completed",
        /** @external calendar prep summary wire field */
        companyVisible: true,
        progress: null,
      },
      {
        calendarEventId: "google_calendar:primary:event-2",
        eventFingerprint: "fingerprint-2",
        prepId: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        /** @external calendar prep summary wire field */
        companyVisible: true,
        progress: null,
      },
    ],
  };

  const next = removeCalendarEventFromResponse(response, "google_calendar:primary:event-1");

  assert.deepEqual(
    next?.events.map((item) => item.id),
    ["google_calendar:primary:event-2"],
  );
  assert.deepEqual(
    next.prepSummaries.map((summary) => summary.calendarEventId),
    ["google_calendar:primary:event-2"],
  );
});

void test("calendar event response Ready meeting update applies to matching provider event key", () => {
  const response: CalendarEventsResponse = {
    events: [
      event({
        id: "google_calendar:primary:occurrence-1",
        providerEventId: "occurrence-1",
        providerRecurringEventId: "series-1",
        providerEventKey: "series-1",
      }),
      event({
        id: "google_calendar:primary:occurrence-2",
        providerEventId: "occurrence-2",
        providerRecurringEventId: "series-1",
        providerEventKey: "series-1",
      }),
      event({
        id: "google_calendar:primary:event-3",
        providerEventId: "event-3",
        providerEventKey: "event-3",
      }),
    ],
    connectedProviders: ["google_calendar"],
    /** @external calendar events response wire field */
    needsConnection: false,
    photoPermissionMissingProviders: [],
    prepSummaries: [],
  };
  const readyMeeting = {
    source: "mapping" as const,
    meetingLinkId: READY_MEETING_LINK_ID,
    code: READY_MEETING_CODE,
    joinUrl: READY_MEETING_JOIN_URL,
    callIn: { phoneNumber: "+15551234567", pin: "123456" },
  };

  const next = addReadyMeetingToCalendarEventsResponse(response, {
    providerEventKey: "series-1",
    readyMeeting,
  });

  assert.deepEqual(
    next?.events.map((item) => item.readyMeeting?.joinUrl ?? null),
    ["https://app.ready.test/abc-defg-hij", "https://app.ready.test/abc-defg-hij", null],
  );
  assert.deepEqual(
    next.events.map((item) => item.canAddReadyMeeting),
    [false, false, true],
  );
});

void test("all-day calendar event subtitle stays normalized", () => {
  assert.deepEqual(getCalendarEventSubtitleParts(event({ isAllDay: true, location: "Office" })), {
    primary: "All day",
    secondary: "Office",
  });
});

void test("calendar event subtitle omits repeated matching day period", () => {
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T13:00:00.000",
        end: "2026-05-06T14:00:00.000",
      }),
    ),
    { primary: "1 - 2 PM", secondary: null },
  );
});

void test("calendar event subtitle keeps both day periods when they differ", () => {
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T11:30:00.000",
        end: "2026-05-06T13:00:00.000",
        location: "Office",
      }),
    ),
    { primary: "11:30 AM - 1 PM", secondary: "Office" },
  );
});

void test("calendar event subtitle shortens attached Google Meet locations", () => {
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T18:00:00.000",
        end: "2026-05-06T19:00:00.000",
        location: "See attached Google Meet link",
      }),
    ),
    { primary: "6 - 7 PM", secondary: "Google Meet" },
  );
});

void test("calendar event subtitle shortens common meeting platform locations", () => {
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T18:00:00.000",
        end: "2026-05-06T19:00:00.000",
        location: "Join Zoom Meeting",
      }),
    ),
    { primary: "6 - 7 PM", secondary: "Zoom" },
  );
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T18:00:00.000",
        end: "2026-05-06T19:00:00.000",
        location: "Microsoft Teams Meeting",
      }),
    ),
    { primary: "6 - 7 PM", secondary: "Microsoft Teams" },
  );
});

void test("calendar event subtitle omits raw URL-only locations", () => {
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T18:00:00.000",
        end: "2026-05-06T19:00:00.000",
        location: "http://localhost:3000/abc-defg-hij",
      }),
    ),
    { primary: "6 - 7 PM", secondary: null },
  );
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T18:00:00.000",
        end: "2026-05-06T19:00:00.000",
        location: "ready.app/abc-defg-hij",
      }),
    ),
    {
      primary: "6 - 7 PM",
      secondary: null,
    },
  );
});

void test("calendar event subtitle omits generated Ready meeting location", () => {
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T18:00:00.000",
        end: "2026-05-06T19:00:00.000",
        location: READY_MEETING_JOIN_URL,
        readyMeeting: {
          source: "mapping",
          meetingLinkId: READY_MEETING_LINK_ID,
          code: READY_MEETING_CODE,
          joinUrl: READY_MEETING_JOIN_URL,
          callIn: null,
        },
      }),
    ),
    { primary: "6 - 7 PM", secondary: null },
  );
});

void test("calendar event subtitle parts split time from location for card rendering", () => {
  assert.deepEqual(
    getCalendarEventSubtitleParts(
      event({
        start: "2026-05-06T18:00:00.000",
        end: "2026-05-06T19:00:00.000",
        location: "See attached Google Meet link",
      }),
    ),
    {
      primary: "6 - 7 PM",
      secondary: "Google Meet",
    },
  );
});

void test("calendar event dated subtitle includes weekday and compact date", () => {
  assert.deepEqual(
    getCalendarEventDatedSubtitleParts(
      event({
        start: "2026-05-04T12:00:00.000",
        end: "2026-05-04T16:00:00.000",
        location: "Office",
      }),
    ),
    {
      primary: "Monday 5/4, 12 - 4 PM",
      secondary: "Office",
    },
  );
});

void test("calendar event selection picks the first event immediately when navigation clears manual selection", () => {
  const selection = getCalendarEventSelection([event({ id: "first" }), event({ id: "second" })], null);

  assert.equal(selection.selectedEventId, "first");
  assert.equal(selection.selectedEvent?.id, "first");
});

void test("calendar event selection keeps a manually selected event while it is still present", () => {
  const selection = getCalendarEventSelection([event({ id: "first" }), event({ id: "second" })], "second");

  assert.equal(selection.selectedEventId, "second");
  assert.equal(selection.selectedEvent?.id, "second");
});

void test("calendar event selection falls back when refetch removes the selected event", () => {
  const selection = getCalendarEventSelection([event({ id: "replacement" })], "removed");

  assert.equal(selection.selectedEventId, "replacement");
  assert.equal(selection.selectedEvent?.id, "replacement");
});

void test("calendar event selection clears immediately for empty days", () => {
  const selection = getCalendarEventSelection([], "previous-day-event");

  assert.equal(selection.selectedEventId, null);
  assert.equal(selection.selectedEvent, null);
});

void test("upcoming calendar groups skip empty today and show the next day with enough events", () => {
  const groups = getUpcomingCalendarEventGroups(
    [
      event({
        id: "tomorrow-1",
        start: "2026-05-09T15:00:00.000Z",
        end: "2026-05-09T15:30:00.000Z",
      }),
      event({
        id: "tomorrow-2",
        start: "2026-05-09T16:00:00.000Z",
        end: "2026-05-09T16:30:00.000Z",
      }),
      event({
        id: "tomorrow-3",
        start: "2026-05-09T17:00:00.000Z",
        end: "2026-05-09T17:30:00.000Z",
      }),
    ],
    new Date("2026-05-08T12:00:00.000Z"),
  );

  assert.equal(groups[0]?.kind, "day");
  assert.deepEqual(
    groups[0].events.map((item) => item.id),
    ["tomorrow-1", "tomorrow-2", "tomorrow-3"],
  );
});

void test("upcoming calendar groups widen to next seven days when a day has too few events", () => {
  const groups = getUpcomingCalendarEventGroups(
    [
      event({
        id: "day-1",
        start: "2026-05-09T15:00:00.000Z",
        end: "2026-05-09T15:30:00.000Z",
      }),
      event({
        id: "day-2",
        start: "2026-05-09T16:00:00.000Z",
        end: "2026-05-09T16:30:00.000Z",
      }),
      event({
        id: "week-1",
        start: "2026-05-12T17:00:00.000Z",
        end: "2026-05-12T17:30:00.000Z",
      }),
    ],
    new Date("2026-05-08T12:00:00.000Z"),
  );

  assert.equal(groups[0]?.kind, "next_7_days");
  assert.equal(groups[0].label, "Next 7 days");
  assert.deepEqual(
    groups[0].events.map((item) => item.id),
    ["day-1", "day-2", "week-1"],
  );
});

void test("upcoming calendar groups use week buckets when next seven days are not enough", () => {
  const groups = getUpcomingCalendarEventGroups(
    [
      event({
        id: "week-1",
        start: "2026-05-18T15:00:00.000Z",
        end: "2026-05-18T15:30:00.000Z",
      }),
      event({
        id: "week-2",
        start: "2026-05-19T16:00:00.000Z",
        end: "2026-05-19T16:30:00.000Z",
      }),
      event({
        id: "week-3",
        start: "2026-05-20T17:00:00.000Z",
        end: "2026-05-20T17:30:00.000Z",
      }),
    ],
    new Date("2026-05-08T12:00:00.000Z"),
  );

  assert.equal(groups[0]?.kind, "week");
  assert.match(groups[0].label, /^Week \d+$/);
  assert.deepEqual(
    groups[0].events.map((item) => item.id),
    ["week-1", "week-2", "week-3"],
  );
});

void test("upcoming calendar groups use month buckets when day and week buckets are too small", () => {
  const groups = getUpcomingCalendarEventGroups(
    [
      event({
        id: "month-1",
        start: "2026-06-02T15:00:00.000Z",
        end: "2026-06-02T15:30:00.000Z",
      }),
      event({
        id: "month-2",
        start: "2026-06-10T16:00:00.000Z",
        end: "2026-06-10T16:30:00.000Z",
      }),
      event({
        id: "month-3",
        start: "2026-06-20T17:00:00.000Z",
        end: "2026-06-20T17:30:00.000Z",
      }),
    ],
    new Date("2026-05-08T12:00:00.000Z"),
  );

  assert.equal(groups[0]?.kind, "month");
  assert.equal(groups[0].label, "June 2026");
  assert.deepEqual(
    groups[0].events.map((item) => item.id),
    ["month-1", "month-2", "month-3"],
  );
});

void test("upcoming calendar groups ignore events that already ended", () => {
  const groups = getUpcomingCalendarEventGroups(
    [
      event({ id: "past", start: "2026-05-08T08:00:00.000Z", end: "2026-05-08T09:00:00.000Z" }),
      event({
        id: "future-1",
        start: "2026-05-08T15:00:00.000Z",
        end: "2026-05-08T15:30:00.000Z",
      }),
      event({
        id: "future-2",
        start: "2026-05-08T16:00:00.000Z",
        end: "2026-05-08T16:30:00.000Z",
      }),
      event({
        id: "future-3",
        start: "2026-05-08T17:00:00.000Z",
        end: "2026-05-08T17:30:00.000Z",
      }),
    ],
    new Date("2026-05-08T12:00:00.000Z"),
  );

  assert.deepEqual(
    groups[0]?.events.map((item) => item.id),
    ["future-1", "future-2", "future-3"],
  );
});

void test("upcoming previous navigation routes to past from today", () => {
  assert.deepEqual(getUpcomingPreviousCalendarNavigation(0), {
    dayOffset: null,
    route: "/workspace?view=past",
  });
});

void test("upcoming previous navigation moves back a day from future days", () => {
  assert.deepEqual(getUpcomingPreviousCalendarNavigation(TEST_VALUE_3), {
    dayOffset: TEST_VALUE_2,
    route: null,
  });
});

void test("calendar event avatar initials remain available when no photo is present", () => {
  assert.equal(
    getCalendarEventPersonInitials({
      name: "Personaz",
      email: "personaz@example.com",
      responseStatus: "accepted",
      avatarUrl: null,
    }),
    "P",
  );
});

void test("calendar event participant people prefer other attendees and dedupe organizer", () => {
  const people = getCalendarEventParticipantPeople(
    event({
      organizer: {
        name: "Personbr",
        email: "personbr@example.com",
        responseStatus: null,
        avatarUrl: "https://lh3.googleusercontent.com/personbr",
      },
      attendees: [
        {
          name: "Personbr",
          email: "personbr@example.com",
          responseStatus: "accepted",
          avatarUrl: "https://lh3.googleusercontent.com/personbr",
        },
        {
          name: "Personaz",
          email: "personaz@example.com",
          responseStatus: "accepted",
          avatarUrl: "https://lh3.googleusercontent.com/personaz",
        },
      ],
    }),
    "personbr@example.com",
    "Personbr",
  );

  assert.deepEqual(
    people.map((person) => person.email),
    ["personaz@example.com"],
  );
});

void test("calendar event participant people fall back to organizer for solo events", () => {
  const people = getCalendarEventParticipantPeople(
    event({
      organizer: {
        name: "Personbr",
        email: "personbr@example.com",
        responseStatus: null,
        avatarUrl: "https://lh3.googleusercontent.com/personbr",
      },
      attendees: [],
    }),
    "personbr@example.com",
    "Personbr",
  );

  assert.deepEqual(
    people.map((person) => person.email),
    ["personbr@example.com"],
  );
});

void test("calendar event avatar URL candidates prefer Ready user image, then provider image", () => {
  assert.deepEqual(
    getCalendarEventAvatarUrlCandidates({
      person: {
        name: "Personbr",
        email: "personbr@example.com",
        responseStatus: null,
        avatarUrl: "https://lh3.googleusercontent.com/personbr",
        readyMeetAvatarUrl: "https://ready.app/avatar/personbr.png",
      },
      currentUserAvatarUrl: "https://ready.app/avatar/current-personbr.png",
      currentUserDisplayName: "Personbr",
      currentUserEmail: "personbr@example.com",
    }),
    [
      "https://ready.app/avatar/personbr.png",
      "https://ready.app/avatar/current-personbr.png",
      "https://lh3.googleusercontent.com/personbr",
    ],
  );
});

void test("calendar event avatar URL candidates fall back to Ready user image before initials", () => {
  assert.deepEqual(
    getCalendarEventAvatarUrlCandidates({
      person: {
        name: "Personbr",
        email: "personbr@example.com",
        responseStatus: null,
        avatarUrl: null,
        readyMeetAvatarUrl: "https://ready.app/avatar/personbr.png",
      },
    }),
    ["https://ready.app/avatar/personbr.png"],
  );
});
