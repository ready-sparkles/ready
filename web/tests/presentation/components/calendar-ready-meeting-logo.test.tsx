import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { NormalizedCalendarEvent } from "@readymeet/shared";
import { cleanup, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { ReadyMeetingLogo } from "../../../presentation/components/calendar-ready-meeting-logo";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
    /** @external NormalizedCalendarEvent wire field */
    needsCalendarWriteConsent: false,
    joinUrl: null,
    readyMeeting: null,
    sourceUrl: null,
    ...overrides,
  };
}

void test("invalid event dates render the standard Ready logo, retaining the card styling", (t) => {
  t.after(cleanup);
  const { container } = render(<ReadyMeetingLogo event={event({ start: "invalid", isAllDay: false })} />);
  const logo = container.querySelector(".workspace-ready-meeting-mark img");
  assert.ok(logo);
  assert.equal(logo.getAttribute("src"), `/logos/days/${new Date().getDate()}.svg`);
  assert.equal(logo.className, "meeting-pro-art-logo");
});

void test("valid event dates keep their event day rather than the fallback day", (t) => {
  t.after(cleanup);
  const { container } = render(<ReadyMeetingLogo event={event({ start: "2026-09-27", isAllDay: true })} />);
  assert.equal(container.querySelector("img")?.getAttribute("src"), "/logos/days/27.svg");
});
