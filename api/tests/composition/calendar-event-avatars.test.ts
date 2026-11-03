import type { NormalizedCalendarEvent } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReadyMeetCalendarAvatarFallbacks,
  applyReadyMeetCalendarProfileFallbacks,
} from "../../application/calendar-event-avatars";

function event(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: "google_calendar:primary:event-1",
    provider: "google_calendar",
    providerEventId: "event-1",
    calendarId: "primary",
    title: "Design review",
    start: "2026-05-07T18:00:00.000Z",
    end: "2026-05-07T19:00:00.000Z",
    timezone: "UTC",
    location: null,
    organizer: null,
    attendees: [],
    isPrivate: false,
    isCancelled: false,
    isAllDay: false,
    joinUrl: null,
    sourceUrl: null,
    ...overrides,
  };
}

void test("ReadyMeet avatar fallback maps attendee photos by email", () => {
  const withAvatar = applyReadyMeetCalendarAvatarFallbacks({
    events: [
      event({
        attendees: [
          {
            name: "Personbq Personbf",
            email: "personbr@example.com",
            responseStatus: "accepted",
            avatarUrl: null,
          },
        ],
      }),
    ],
    avatarUrlsByEmail: new Map([["personbr@example.com", "https://ready.app/avatar/personbq.png"]]),
  }).at(0);
  assert.ok(withAvatar !== undefined);
  const attendee = withAvatar.attendees.at(0);
  assert.ok(attendee !== undefined);

  assert.equal(attendee.avatarUrl, "https://ready.app/avatar/personbq.png");
  assert.equal(attendee.readyMeetAvatarUrl, "https://ready.app/avatar/personbq.png");
});

void test("ReadyMeet profile fallback maps attendee display names by email", () => {
  const withProfile = applyReadyMeetCalendarProfileFallbacks({
    events: [
      event({
        attendees: [
          {
            name: "personbq.personbf",
            email: "personbr@example.com",
            responseStatus: "accepted",
            avatarUrl: null,
          },
        ],
      }),
    ],
    profilesByEmail: new Map([
      [
        "personbr@example.com",
        {
          avatarUrl: "https://ready.app/avatar/personbq.png",
          displayName: "Personbq Personbf",
        },
      ],
    ]),
  }).at(0);
  assert.ok(withProfile !== undefined);
  const attendee = withProfile.attendees.at(0);
  assert.ok(attendee !== undefined);

  assert.equal(attendee.name, "Personbq Personbf");
  assert.equal(attendee.avatarUrl, "https://ready.app/avatar/personbq.png");
  assert.equal(attendee.readyMeetAvatarUrl, "https://ready.app/avatar/personbq.png");
});

void test("ReadyMeet avatar fallback does not replace provider photos", () => {
  const withAvatar = applyReadyMeetCalendarAvatarFallbacks({
    events: [
      event({
        organizer: {
          name: "Personaz",
          email: "personaz@example.com",
          responseStatus: null,
          avatarUrl: "https://lh3.googleusercontent.com/personaz",
        },
      }),
    ],
    avatarUrlsByEmail: new Map([["personaz@example.com", "https://ready.app/avatar/personaz.png"]]),
  }).at(0);
  assert.ok(withAvatar !== undefined);
  const organizer = withAvatar.organizer;
  assert.ok(organizer !== undefined && organizer !== null);

  assert.equal(organizer.avatarUrl, "https://lh3.googleusercontent.com/personaz");
  assert.equal(organizer.readyMeetAvatarUrl, "https://ready.app/avatar/personaz.png");
});
