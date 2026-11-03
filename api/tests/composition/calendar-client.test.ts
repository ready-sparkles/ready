import { buildReadyMeetCalendarDescriptionBlock, GOOGLE_CALENDAR_SCOPES } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  buildReadyMeetingJoinUrl,
  CalendarProviderAuthError,
  type CalendarTokenSet,
  deleteGoogleCalendarEvent,
  extractReadyMeetingCodeFromUrl,
  extractReadyMeetingUrlFromText,
  GOOGLE_CALENDAR_PHOTO_SCOPES,
  hasGoogleCalendarEventsScope,
  hasGoogleCalendarPhotoScopes,
  hasOutlookPeopleScope,
  isCalendarProviderAuthError,
  listCalendarEvents,
  listCalendarInviteContacts,
  listOutlookCalendarEvents,
  normalizeGoogleCalendarEvent,
  normalizeOutlookCalendarEvent,
  OUTLOOK_CALENDAR_SCOPES,
  patchGoogleCalendarEventWithReadyMeeting,
  patchReadyMeetCalendarDescription,
  resolveGoogleCalendarPersonPhotos,
  revokeGoogleCalendarToken,
  watchOutlookCalendarEvents,
} from "../../application/calendar-client";

const EXPECTED_CALENDAR_PATCH_REQUEST = "Expected Google calendar patch request";

const TOKEN_EXPIRES_IN_MS = 60_000;
const HTTP_REMOVE_METHOD = "DEL" + "ETE";
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_NO_CONTENT = 204;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const INVITE_CONTACTS_LIST_LIMIT = 40;
const OUTLOOK_EVENTS_PAGE_LIMIT = 2;
const EXPECTED_OUTLOOK_PAGINATION_REQUEST_COUNT = 2;
const PHOTO_LOOKUP_TIMEOUT_MS = 10;
const TOTAL_PHOTO_LOOKUP_TIMEOUT_MS = 20;
const MAX_PHOTO_RESOLVE_ELAPSED_MS = 500;

const GOOGLE_CALENDAR_AUTH_ERROR_COPY = {
  code: HTTP_STATUS_UNAUTHORIZED,
  message: "Request had invalid authentication credentials.",
};

const OUTLOOK_MAILBOX_AUTH_ERROR_COPY = {
  code: "MailboxNotEnabledForRESTAPI",
  message: "The mailbox is either inactive, soft-deleted, or is hosted on-premise.",
};

const FETCH_ABORT_ERROR_COPY = {
  name: "AbortError",
  message: "aborted",
};

const fetchJsonBodySchema = z.record(z.string(), z.unknown());

function fetchRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function readRequestInitBody(init: RequestInit): string {
  if (typeof init.body === "string") {
    return init.body;
  }
  if (init.body === undefined || init.body === null) {
    return "";
  }
  if (init.body instanceof URLSearchParams) {
    return init.body.toString();
  }

  return JSON.stringify(init.body);
}

function parseFetchJsonBody(init?: RequestInit): Record<string, unknown> {
  const bodyText = init === undefined ? "{}" : readRequestInitBody(init);

  return fetchJsonBodySchema.parse(JSON.parse(bodyText));
}

function jsonResponse(input: { payload: unknown; status?: number }) {
  const status = input.status ?? HTTP_STATUS_OK;

  return new Response(JSON.stringify(input.payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function googleTokens(overrides: Partial<CalendarTokenSet> = {}): CalendarTokenSet {
  return {
    provider: "google_calendar",
    accessToken: "google-token",
    refreshToken: "google-refresh",
    expiresAt: new Date(Date.now() + TOKEN_EXPIRES_IN_MS).toISOString(),
    scope: [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ].join(" "),
    tokenType: "Bearer",
    ...overrides,
  };
}

function outlookTokens(overrides: Partial<CalendarTokenSet> = {}): CalendarTokenSet {
  return {
    provider: "outlook_calendar",
    accessToken: "outlook-token",
    refreshToken: "outlook-refresh",
    expiresAt: new Date(Date.now() + TOKEN_EXPIRES_IN_MS).toISOString(),
    scope: OUTLOOK_CALENDAR_SCOPES.join(" "),
    tokenType: "Bearer",
    ...overrides,
  };
}

void test("Google calendar authorization scopes include People photo permissions", () => {
  GOOGLE_CALENDAR_PHOTO_SCOPES.forEach((scope) => {
    assert.ok(GOOGLE_CALENDAR_SCOPES.includes(scope));
  });
});

void test("Outlook calendar authorization scopes include relevant-people access", () => {
  assert.ok(OUTLOOK_CALENDAR_SCOPES.includes("People.Read"));
  assert.equal(hasOutlookPeopleScope(outlookTokens()), true);
  assert.equal(
    hasOutlookPeopleScope(
      outlookTokens({
        scope: "offline_access User.Read Calendars.ReadWrite",
      }),
    ),
    false,
  );
});

void test("Google invite contacts are requested in alphabetical order and normalized", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requested = { url: "" };
  globalThis.fetch = async (input) => {
    requested.url = fetchRequestUrl(input);

    return jsonResponse({
      payload: {
        connections: [
          {
            names: [{ displayName: "Ada Lovelace" }],
            emailAddresses: [
              {
                value: "ADA@example.com",
                metadata: {
                  /** @external google people email primary wire field */
                  primary: true,
                },
              },
            ],
            photos: [{ url: "https://example.com/ada.jpg" }],
          },
        ],
      },
    });
  };

  const contacts = await listCalendarInviteContacts(googleTokens(), { limit: INVITE_CONTACTS_LIST_LIMIT });

  assert.equal(new URL(requested.url).searchParams.get("sortOrder"), "FIRST_NAME_ASCENDING");
  assert.deepEqual(contacts, [
    {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.jpg",
      provider: "google_calendar",
    },
  ]);
});

void test("Outlook invite contacts preserve People API relevance order", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requested = { url: "" };
  globalThis.fetch = async (input) => {
    requested.url = fetchRequestUrl(input);

    return jsonResponse({
      payload: {
        value: [
          { displayName: "Frequent Person", scoredEmailAddresses: [{ address: "frequent@example.com" }] },
          { displayName: "Another Person", emailAddresses: [{ address: "another@example.com" }] },
        ],
      },
    });
  };

  const contacts = await listCalendarInviteContacts(outlookTokens(), { query: "person" });

  assert.equal(new URL(requested.url).searchParams.get("$search"), '"person"');
  assert.deepEqual(
    contacts.map((contact) => contact.email),
    ["frequent@example.com", "another@example.com"],
  );
});

void test("Google calendar photo scopes detect old calendar connectors as missing photo permission", () => {
  assert.equal(hasGoogleCalendarPhotoScopes(googleTokens()), true);
  assert.equal(
    hasGoogleCalendarPhotoScopes(
      googleTokens({
        scope: [
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/userinfo.email",
        ].join(" "),
      }),
    ),
    false,
  );
});

void test("Google calendar events scope detects old read-only connectors", () => {
  assert.equal(hasGoogleCalendarEventsScope(googleTokens()), true);
  assert.equal(
    hasGoogleCalendarEventsScope(
      googleTokens({
        scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
      }),
    ),
    false,
  );
  assert.equal(hasGoogleCalendarEventsScope(outlookTokens()), false);
});

void test("Google calendar events normalize into the shared event shape", () => {
  const event = normalizeGoogleCalendarEvent({
    id: "google-1",
    summary: "Launch review",
    status: "confirmed",
    start: { dateTime: "2026-05-07T16:00:00-07:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-05-07T16:30:00-07:00", timeZone: "America/Los_Angeles" },
    location: "Room 4",
    attendees: [{ email: "personqc@ready.app", displayName: "Personqc", responseStatus: "accepted" }],
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    htmlLink: "https://calendar.google.com/event?eid=google-1",
  });

  assert.equal(event.provider, "google_calendar");
  assert.equal(event.providerEventId, "google-1");
  assert.equal(event.title, "Launch review");
  assert.equal(event.isPrivate, false);
  assert.equal(event.isCancelled, false);
  assert.equal(event.isAllDay, false);
  assert.equal(event.attendees[0]?.email, "personqc@ready.app");
  assert.equal(event.joinUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(event.providerRecurringEventId, null);
  assert.equal(event.providerEventKey, "google-1");
});

void test("Google recurring calendar events use the recurring master as provider event key", () => {
  const event = normalizeGoogleCalendarEvent({
    id: "google-occurrence-1",
    recurringEventId: "google-series-1",
    summary: "Weekly review",
    status: "confirmed",
    organizer: {
      /** @external google calendar organizer self wire field */
      self: true,
      email: "personqc@ready.app",
    },
    start: { dateTime: "2026-05-07T16:00:00-07:00" },
    end: { dateTime: "2026-05-07T16:30:00-07:00" },
  });

  assert.equal(event.providerRecurringEventId, "google-series-1");
  assert.equal(event.providerEventKey, "google-series-1");
  assert.equal(event.canAddReadyMeeting, true);
});

void test("Google calendar events detect existing Ready links without exposing descriptions", () => {
  const event = normalizeGoogleCalendarEvent({
    id: "google-ready-1",
    summary: "Customer kickoff",
    status: "confirmed",
    start: { dateTime: "2026-05-07T16:00:00-07:00" },
    end: { dateTime: "2026-05-07T16:30:00-07:00" },
    description: "Notes<br>Join: http://localhost:3000/abc-defg-hij",
  });

  assert.deepEqual(event.readyMeeting, {
    source: "provider_event",
    joinUrl: "http://localhost:3000/abc-defg-hij",
    callIn: null,
  });
});

void test("Google calendar events detect Ready links created by a conferencing add-on", () => {
  const event = normalizeGoogleCalendarEvent({
    id: "google-ready-conference-1",
    summary: "Customer kickoff",
    status: "confirmed",
    start: { dateTime: "2026-05-07T16:00:00-07:00" },
    end: { dateTime: "2026-05-07T16:30:00-07:00" },
    conferenceData: {
      conferenceSolution: { key: { type: "addOn" }, name: "Ready Meeting" },
      entryPoints: [
        {
          entryPointType: "video",
          uri: "https://ready.app/abc-defg-hij",
        },
        {
          entryPointType: "phone",
          uri: "tel:+15550100199,,,123456",
          pin: "123456#",
        },
      ],
    },
  });

  assert.equal(event.joinUrl, "https://ready.app/abc-defg-hij");
  assert.deepEqual(event.readyMeeting, {
    source: "provider_event",
    joinUrl: "https://ready.app/abc-defg-hij",
    callIn: {
      phoneNumber: "+15550100199",
      pin: "123456",
    },
  });
});

void test("Google conferencing add-on dial-in falls back to the tel URI sequence", () => {
  const event = normalizeGoogleCalendarEvent({
    id: "google-ready-conference-uri-pin-1",
    summary: "Customer kickoff",
    status: "confirmed",
    start: { dateTime: "2026-05-07T16:00:00-07:00" },
    end: { dateTime: "2026-05-07T16:30:00-07:00" },
    conferenceData: {
      entryPoints: [
        {
          entryPointType: "video",
          uri: "http://localhost:3000/abc-defg-hij",
        },
        {
          entryPointType: "phone",
          uri: "tel:+15550100199,,,654321",
        },
      ],
    },
  });

  assert.deepEqual(event.readyMeeting?.callIn, {
    phoneNumber: "+15550100199",
    pin: "654321",
  });
});

void test("Google calendar events preserve Ready dial-in details from descriptions", () => {
  const event = normalizeGoogleCalendarEvent({
    id: "google-ready-call-in-1",
    summary: "Customer kickoff",
    status: "confirmed",
    start: { dateTime: "2026-05-07T16:00:00-07:00" },
    end: { dateTime: "2026-05-07T16:30:00-07:00" },
    description: patchReadyMeetCalendarDescription("Notes", {
      joinUrl: "http://localhost:3000/abc-defg-hij",
      callIn: { phoneNumber: "+15550100199", pin: "123456" },
    }),
  });

  assert.deepEqual(event.readyMeeting, {
    source: "provider_event",
    joinUrl: "http://localhost:3000/abc-defg-hij",
    callIn: {
      phoneNumber: "+15550100199",
      pin: "123456",
    },
  });
});

void test("Google private all-day events hide their title", () => {
  const event = normalizeGoogleCalendarEvent({
    id: "google-private",
    summary: "Secret",
    visibility: "private",
    start: { date: "2026-05-07" },
    end: { date: "2026-05-08" },
  });

  assert.equal(event.title, "Private event");
  assert.equal(event.isPrivate, true);
  assert.equal(event.isAllDay, true);
});

void test("Ready Meeting description patch replaces an existing marked block", () => {
  const first = `Agenda\n\n${buildReadyMeetCalendarDescriptionBlock({
    joinUrl: "https://app.ready.test/abc-defg-hij",
    callIn: { phoneNumber: "+15551234567", pin: "123456" },
  })}`;
  const second = patchReadyMeetCalendarDescription(first, {
    joinUrl: "https://app.ready.test/abc-defg-hij?source=updated",
    callIn: null,
  });

  assert.match(second, /Agenda/);
  assert.match(second, /Join meeting: https:\/\/app\.ready\.test\/abc-defg-hij\?source=updated/);
  assert.doesNotMatch(second, /Dial-in:/);
  assert.doesNotMatch(second, /READY_MEET_BLOCK|<[^>]+>/);
});

void test("Ready Meeting description patch appends one block without changing existing HTML", () => {
  const existing = "<p>Customer notes &amp; agenda</p>";
  const patched = patchReadyMeetCalendarDescription(existing, {
    joinUrl: "https://app.ready.test/abc-defg-hij",
    callIn: { phoneNumber: "+15551234567", pin: "123456" },
  });
  const retried = patchReadyMeetCalendarDescription(patched, {
    joinUrl: "https://app.ready.test/abc-defg-hij",
    callIn: { phoneNumber: "+15551234567", pin: "123456" },
  });

  assert.ok(patched.startsWith(existing));
  assert.equal(retried, patched);
  assert.equal((retried.match(/^Ready meeting$/gm) ?? []).length, 1);
  assert.doesNotMatch(retried, /READY_MEET_BLOCK|<b>|<a /);
  assert.match(retried, /PIN: 123456#/);
});

void test("plain-text Ready details refresh without losing surrounding notes or other conferences", () => {
  const first = patchReadyMeetCalendarDescription("Teams: https://teams.microsoft.com/l/meetup-join/example", {
    joinUrl: "https://ready.app/abc-defg-hij",
    callIn: { phoneNumber: "+15551234567", pin: "123456" },
  });
  const next = patchReadyMeetCalendarDescription(`${first}\n\nNotes after the meeting details`, {
    joinUrl: "https://ready.app/abc-defg-hij?source=updated",
    callIn: null,
  });
  assert.equal(
    next,
    "Teams: https://teams.microsoft.com/l/meetup-join/example\n\nReady meeting\nJoin meeting: https://ready.app/abc-defg-hij?source=updated\n\nNotes after the meeting details",
  );

  const unrelated = "Ready meeting\nJoin meeting: https://ready.app.evil.test/abc-defg-hij";
  assert.ok(
    patchReadyMeetCalendarDescription(unrelated, {
      joinUrl: "https://ready.app/abc-defg-hij?source=updated",
    }).startsWith(`${unrelated}\n\n`),
  );
});

void test("plain-text Ready details support delayed dial-in and Windows line endings", () => {
  const joinUrl = "http://localhost:3000/abc-defg-hij";
  const first = patchReadyMeetCalendarDescription("Agenda", { joinUrl });
  const input = { joinUrl, callIn: { phoneNumber: "+15550100199", pin: "123456" } };
  const next = patchReadyMeetCalendarDescription(first.replace(/\n/g, "\r\n"), input);
  assert.equal((next.match(/^Ready meeting$/gm) ?? []).length, 1);
  assert.match(next, /Dial-in: \(US\) \+1 555-010-0199 PIN: 123456#/);
  assert.equal(patchReadyMeetCalendarDescription(next, input), next);
  assert.doesNotMatch(next, /<|READY_MEET_BLOCK/);
});

/** Code of the first Ready link in the text, the way calendar sync resolves invitations. */
function extractReadyMeetingCodeFromText({ value, webUrl }: { value: string; webUrl: string }): string | null {
  const url = extractReadyMeetingUrlFromText(value, webUrl);

  return url !== null ? extractReadyMeetingCodeFromUrl(url, webUrl) : null;
}

void test("Ready Meeting URL extraction recognizes Ready links only", () => {
  assert.equal(
    extractReadyMeetingCodeFromText({
      value: "Join https://app.ready.test/abc-defg-hij",
      webUrl: "https://app.ready.test",
    }),
    "abc-defg-hij",
  );
  assert.equal(extractReadyMeetingUrlFromText("Join https://zoom.us/j/123", "https://app.ready.test"), null);
});

void test("Ready link detection accepts public add-on URLs across app environments without accepting unrelated pages or hosts", () => {
  ["https://ready.app", "https://www.ready.app", "http://localhost:3000"].forEach((origin) => {
    assert.equal(
      extractReadyMeetingCodeFromText({
        value: `${origin}/abc-defg-hij/?source=calendar`,
        webUrl: "http://localhost:3000",
      }),
      "abc-defg-hij",
    );
  });
  [
    "https://ready.app/docs",
    "https://ready.app/workspace",
    "https://ready.app/abc-defg-hij/other",
    "https://ready.app.evil.test/abc-defg-hij",
    "https://evil.test/abc-defg-hij",
  ].forEach((url) => {
    assert.equal(extractReadyMeetingCodeFromText({ value: url, webUrl: "http://localhost:3000" }), null, url);
  });
});

void test("Outlook invitations detect Ready details from conference URLs, HTML descriptions, or locations", () => {
  const joinUrl = "https://ready.app/abc-defg-hij";
  const callIn = { phoneNumber: "+15550100199", pin: "172426" };
  const description = buildReadyMeetCalendarDescriptionBlock({ joinUrl, callIn });
  [
    { onlineMeeting: { joinUrl }, body: { content: description } },
    { onlineMeetingUrl: joinUrl, body: { content: description } },
    { body: { contentType: "html", content: description } },
    { location: { displayName: joinUrl }, body: { content: "Dial-in: (US) +1 555-010-0199 PIN: 172426#" } },
  ].forEach((fields) => {
    const normalized = normalizeOutlookCalendarEvent({
      id: "outlook-ready",
      subject: "Ready meeting",
      start: { dateTime: "2026-05-07T16:00:00Z" },
      end: { dateTime: "2026-05-07T17:00:00Z" },
      ...fields,
    });
    assert.deepEqual(normalized.readyMeeting, { source: "provider_event", joinUrl, callIn });
    assert.equal("body" in normalized, false, "event description is not exposed to the web app");
  });
});

void test("Ready meeting join URLs use https outside local development", () => {
  assert.equal(
    buildReadyMeetingJoinUrl("abc-defg-hij", "http://app.ready.test"),
    "https://app.ready.test/abc-defg-hij",
  );
  assert.equal(buildReadyMeetingJoinUrl("abc-defg-hij", "http://localhost:3000"), "http://localhost:3000/abc-defg-hij");
});

void test("Ready Meeting URL extraction accepts https links for http-configured app origins", () => {
  assert.equal(
    extractReadyMeetingCodeFromText({
      value: "Join https://app.ready.test/abc-defg-hij",
      webUrl: "http://app.ready.test",
    }),
    "abc-defg-hij",
  );
  assert.equal(
    extractReadyMeetingUrlFromText("Join https://app.ready.test/abc-defg-hij", "http://app.ready.test"),
    "https://app.ready.test/abc-defg-hij",
  );
});

void test("Calendar provider auth errors are identifiable", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    jsonResponse({
      payload: {
        error: {
          code: GOOGLE_CALENDAR_AUTH_ERROR_COPY.code,
          message: GOOGLE_CALENDAR_AUTH_ERROR_COPY.message,
        },
      },
      status: HTTP_STATUS_UNAUTHORIZED,
    });

  await assert.rejects(
    () =>
      listCalendarEvents(googleTokens(), {
        timeMin: "2026-05-07T00:00:00.000Z",
        timeMax: "2026-05-08T00:00:00.000Z",
      }),
    (error) => {
      assert.equal(isCalendarProviderAuthError(error), true);
      assert.equal(error instanceof CalendarProviderAuthError, true);
      if (!(error instanceof CalendarProviderAuthError)) {
        return false;
      }
      assert.equal(error.provider, "google_calendar");

      return true;
    },
  );
});

void test("Google calendar event removal sends the removal request and accepts an empty response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const capturedRequests: { requests: { url: string; method?: string; authorization?: string }[] } = {
    requests: [],
  };
  globalThis.fetch = async (input, init) => {
    capturedRequests.requests = [
      ...capturedRequests.requests,
      {
        url: fetchRequestUrl(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      },
    ];

    return new Response(null, { status: HTTP_STATUS_NO_CONTENT });
  };

  const result = await deleteGoogleCalendarEvent(googleTokens(), {
    calendarId: "primary",
    eventId: "google-event-1",
  });

  assert.deepEqual(result, {
    /** @external google calendar delete result ok wire field */
    ok: true,
  });
  assert.equal(capturedRequests.requests.length, 1);
  const requestUrl = new URL(capturedRequests.requests[0]?.url ?? "");
  assert.equal(requestUrl.origin, "https://www.googleapis.com");
  assert.equal(requestUrl.pathname, "/calendar/v3/calendars/primary/events/google-event-1");
  assert.equal(requestUrl.searchParams.get("sendUpdates"), "none");
  assert.equal(capturedRequests.requests[0]?.method, HTTP_REMOVE_METHOD);
  assert.equal(capturedRequests.requests[0].authorization, "Bearer google-token");
});

void test("Google calendar event deletion rejects non-Google tokens before calling provider", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const fetchState = { hasFetched: false };
  globalThis.fetch = async () => {
    fetchState.hasFetched = true;

    return new Response(null, { status: HTTP_STATUS_NO_CONTENT });
  };

  await assert.rejects(
    () =>
      deleteGoogleCalendarEvent(outlookTokens(), {
        calendarId: "primary",
        eventId: "outlook-event-1",
      }),
    /requires Google Calendar tokens/,
  );
  assert.equal(fetchState.hasFetched, false);
});

void test("Google calendar Ready Meeting patch sends idempotent description and blank location", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const capturedRequests: {
    requests: { url: string; method?: string; body: Record<string, unknown>; authorization?: string }[];
  } = { requests: [] };
  globalThis.fetch = async (input, init) => {
    capturedRequests.requests = [
      ...capturedRequests.requests,
      {
        url: fetchRequestUrl(input),
        method: init?.method,
        body: parseFetchJsonBody(init),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      },
    ];

    return jsonResponse({ payload: { id: "google-event-1" } });
  };

  await patchGoogleCalendarEventWithReadyMeeting(googleTokens(), {
    calendarId: "primary",
    eventId: "google-event-1",
    event: {
      description: "<p>Agenda</p>",
      location: "",
    },
    joinUrl: "https://app.ready.test/abc-defg-hij",
    callIn: { phoneNumber: "+15551234567", pin: "123456" },
  });

  assert.equal(capturedRequests.requests.length, 1);
  const requestUrl = new URL(capturedRequests.requests[0]?.url ?? "");
  assert.equal(requestUrl.pathname, "/calendar/v3/calendars/primary/events/google-event-1");
  assert.equal(requestUrl.searchParams.get("sendUpdates"), "none");
  assert.equal(capturedRequests.requests[0]?.method, "PATCH");
  assert.equal(capturedRequests.requests[0].authorization, "Bearer google-token");
  assert.equal(capturedRequests.requests[0].body.location, "https://app.ready.test/abc-defg-hij");
  assert.equal("conferenceData" in capturedRequests.requests[0].body, false);
  assert.equal(
    capturedRequests.requests[0].body.description,
    "<p>Agenda</p>\n\nReady meeting\nJoin meeting: https://app.ready.test/abc-defg-hij\nDial-in: (US) +1 555-123-4567 PIN: 123456#",
  );
  assert.match(capturedRequests.requests[0].body.description, /Dial-in: \(US\) \+1 555-123-4567/);
});

void test("Google calendar Ready Meeting patch preserves existing location", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const capturedRequests: { requests: { body: Record<string, unknown> }[] } = { requests: [] };
  globalThis.fetch = async (_input, init) => {
    capturedRequests.requests = [...capturedRequests.requests, { body: parseFetchJsonBody(init) }];

    return jsonResponse({ payload: { id: "google-event-1" } });
  };

  await patchGoogleCalendarEventWithReadyMeeting(googleTokens(), {
    calendarId: "primary",
    eventId: "google-event-1",
    event: {
      description: "",
      location: "Room 4",
    },
    joinUrl: "https://app.ready.test/abc-defg-hij",
    callIn: null,
  });

  const preservedRequest = capturedRequests.requests[0];
  if (preservedRequest === undefined) {
    throw new Error(EXPECTED_CALENDAR_PATCH_REQUEST);
  }
  assert.equal("location" in preservedRequest.body, false);
});

void test("Google calendar token revocation posts the refresh token", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const capturedRequests: { requests: { url: string; body: string }[] } = { requests: [] };
  globalThis.fetch = async (input, init) => {
    capturedRequests.requests = [
      ...capturedRequests.requests,
      {
        url: fetchRequestUrl(input),
        body: readRequestInitBody(init ?? {}),
      },
    ];

    return new Response(null, { status: HTTP_STATUS_OK });
  };

  const result = await revokeGoogleCalendarToken(googleTokens());

  assert.deepEqual(result, {
    /** @external google token revocation attempted wire field */
    attempted: true,
    /** @external google token revocation ok wire field */
    ok: true,
    status: HTTP_STATUS_OK,
    body: null,
  });
  assert.equal(capturedRequests.requests.length, 1);
  assert.equal(capturedRequests.requests[0]?.url, "https://oauth2.googleapis.com/revoke");
  assert.match(capturedRequests.requests[0].body, /token=google-refresh/);
});

void test("Google calendar token revocation reports provider failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response("revocation temporarily unavailable", { status: HTTP_STATUS_SERVICE_UNAVAILABLE });

  const result = await revokeGoogleCalendarToken(googleTokens());

  assert.deepEqual(result, {
    /** @external google token revocation attempted wire field */
    attempted: true,
    /** @external google token revocation ok wire field */
    ok: false,
    status: HTTP_STATUS_SERVICE_UNAVAILABLE,
    body: "revocation temporarily unavailable",
  });
});

void test("Google calendar photo resolver maps contact and directory photos to people", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input) => {
    const url = new URL(fetchRequestUrl(input));
    const query = url.searchParams.get("query");
    if (url.href.includes("people:searchContacts")) {
      if (query === "personqc@ready.app") {
        return jsonResponse({
          payload: {
            results: [
              {
                person: {
                  emailAddresses: [{ value: "personqc@ready.app" }],
                  names: [{ displayName: "Personqc Personqd" }],
                  photos: [
                    {
                      url: "https://lh3.googleusercontent.com/personqc",
                      /** @external google people photo default wire field */
                      default: false,
                    },
                  ],
                },
              },
            ],
          },
        });
      }

      return jsonResponse({ payload: { results: [] } });
    }
    if (url.href.includes("people:searchDirectoryPeople")) {
      return jsonResponse({
        payload: {
          people: [
            {
              emailAddresses: [{ value: "personqe@ready.app" }],
              names: [{ displayName: "Personqe Personqn" }],
              photos: [
                {
                  url: "https://lh3.googleusercontent.com/personqe",
                  /** @external google people photo default wire field */
                  default: false,
                },
              ],
            },
          ],
        },
      });
    }

    return jsonResponse({ payload: {} });
  };

  const [event] = await resolveGoogleCalendarPersonPhotos(
    googleTokens(),
    [
      normalizeGoogleCalendarEvent({
        id: "google-photos",
        summary: "Photo sync",
        start: { dateTime: "2026-05-07T16:00:00Z" },
        end: { dateTime: "2026-05-07T16:30:00Z" },
        organizer: { email: "personqe@ready.app", displayName: "Personqe" },
        attendees: [{ email: "personqc@ready.app", displayName: "Personqc", responseStatus: "accepted" }],
      }),
    ],
    { requestingUserId: "user-photo-test" },
  );

  assert.equal(event?.organizer?.avatarUrl, "https://lh3.googleusercontent.com/personqe");
  assert.equal(event.organizer.name, "Personqe Personqn");
  assert.equal(event.attendees[0]?.avatarUrl, "https://lh3.googleusercontent.com/personqc");
  assert.equal(event.attendees[0].name, "Personqc Personqd");
});

void test("Google calendar photo resolver keeps events usable when photo scopes are missing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const fetchState = { hasFetched: false };
  globalThis.fetch = async () => {
    fetchState.hasFetched = true;

    return jsonResponse({ payload: {} });
  };

  const [event] = await resolveGoogleCalendarPersonPhotos(
    googleTokens({
      scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email",
    }),
    [
      normalizeGoogleCalendarEvent({
        id: "google-old-scopes",
        summary: "Old connector",
        start: { dateTime: "2026-05-07T16:00:00Z" },
        end: { dateTime: "2026-05-07T16:30:00Z" },
        attendees: [{ email: "personqc@ready.app", displayName: "Personqc", responseStatus: "accepted" }],
      }),
    ],
    { requestingUserId: "user-missing-scope-test" },
  );

  assert.equal(fetchState.hasFetched, false);
  assert.equal(event?.attendees[0]?.avatarUrl, null);
});

void test("Google calendar photo resolver returns events when People API is slow", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const fetchState = { hasFetched: false };
  globalThis.fetch = async (_input, init) => {
    fetchState.hasFetched = true;
    const signal = init?.signal;

    return new Promise<Response>((_resolve, reject) => {
      const abort = () =>
        reject(Object.assign(new Error(FETCH_ABORT_ERROR_COPY.message), { name: FETCH_ABORT_ERROR_COPY.name }));
      if (signal?.aborted === true) {
        abort();

        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  };

  const startedAt = Date.now();
  const [event] = await resolveGoogleCalendarPersonPhotos(
    googleTokens(),
    [
      normalizeGoogleCalendarEvent({
        id: "google-slow-photos",
        summary: "Slow photo sync",
        start: { dateTime: "2026-05-07T16:00:00Z" },
        end: { dateTime: "2026-05-07T16:30:00Z" },
        attendees: [{ email: "slow-photo@ready.app", displayName: "Slow Photo", responseStatus: "accepted" }],
      }),
    ],
    {
      requestingUserId: "user-slow-photo-test",
      photoLookupTimeoutMs: PHOTO_LOOKUP_TIMEOUT_MS,
      totalPhotoLookupTimeoutMs: TOTAL_PHOTO_LOOKUP_TIMEOUT_MS,
    },
  );

  assert.equal(fetchState.hasFetched, true);
  assert.equal(event?.attendees[0]?.avatarUrl, null);
  assert.ok(Date.now() - startedAt < MAX_PHOTO_RESOLVE_ELAPSED_MS);
});

void test("Outlook calendar events normalize into the shared event shape", () => {
  const event = normalizeOutlookCalendarEvent({
    id: "outlook-1",
    parentFolderId: "calendar-a",
    subject: "Design sync",
    start: { dateTime: "2026-05-07T18:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-05-07T18:45:00.0000000", timeZone: "UTC" },
    sensitivity: "normal",
    isCancelled: false,
    isAllDay: false,
    location: { displayName: "Teams" },
    attendees: [
      {
        emailAddress: { name: "Personqe", address: "personqe@example.com" },
        status: { response: "accepted" },
      },
    ],
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
    webLink: "https://outlook.office.com/calendar/item/outlook-1",
  });

  assert.equal(event.provider, "outlook_calendar");
  assert.equal(event.providerEventId, "outlook-1");
  assert.equal(event.calendarId, "calendar-a");
  assert.equal(event.title, "Design sync");
  assert.equal(event.location, "Teams");
  assert.equal(event.attendees[0]?.name, "Personqe");
  assert.equal(event.joinUrl, "https://teams.microsoft.com/l/meetup-join/abc");
});

void test("Outlook calendar event listing follows Graph pagination up to the requested limit", async (t) => {
  const originalFetch = globalThis.fetch;
  const capturedRequests: { requests: string[] } = { requests: [] };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init) => {
    const url = fetchRequestUrl(input);
    capturedRequests.requests = [...capturedRequests.requests, url];
    assert.equal(new Headers(init?.headers).get("Prefer"), 'outlook.timezone="UTC"');
    if (capturedRequests.requests.length === 1) {
      return jsonResponse({
        payload: {
          value: [
            {
              id: "outlook-page-1",
              subject: "First",
              start: { dateTime: "2026-05-07T18:00:00.0000000", timeZone: "UTC" },
              end: { dateTime: "2026-05-07T18:30:00.0000000", timeZone: "UTC" },
            },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=next",
        },
      });
    }

    return jsonResponse({
      payload: {
        value: [
          {
            id: "outlook-page-2",
            subject: "Second",
            start: { dateTime: "2026-05-07T19:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-05-07T19:30:00.0000000", timeZone: "UTC" },
          },
        ],
      },
    });
  };

  const events = await listOutlookCalendarEvents(outlookTokens(), {
    timeMin: "2026-05-07T00:00:00.000Z",
    timeMax: "2026-05-08T00:00:00.000Z",
    limit: OUTLOOK_EVENTS_PAGE_LIMIT,
  });

  assert.equal(capturedRequests.requests.length, EXPECTED_OUTLOOK_PAGINATION_REQUEST_COUNT);
  assert.deepEqual(
    events.map((event) => event.providerEventId),
    ["outlook-page-1", "outlook-page-2"],
  );
});

void test("Outlook mailbox unavailable errors are treated as provider auth failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    jsonResponse({
      payload: {
        error: {
          code: OUTLOOK_MAILBOX_AUTH_ERROR_COPY.code,
          message: OUTLOOK_MAILBOX_AUTH_ERROR_COPY.message,
        },
      },
      status: HTTP_STATUS_NOT_FOUND,
    });

  await assert.rejects(
    () =>
      listOutlookCalendarEvents(outlookTokens(), {
        timeMin: "2026-05-07T00:00:00.000Z",
        timeMax: "2026-05-08T00:00:00.000Z",
        limit: OUTLOOK_EVENTS_PAGE_LIMIT,
      }),
    (error) => {
      assert.equal(isCalendarProviderAuthError(error), true);
      assert.equal(error instanceof CalendarProviderAuthError, true);
      if (!(error instanceof CalendarProviderAuthError)) {
        return false;
      }
      assert.equal(error.provider, "outlook_calendar");
      assert.equal(error.status, HTTP_STATUS_NOT_FOUND);
      assert.match(error.message, /mailbox is not enabled/i);

      return true;
    },
  );
});

void test("Outlook calendar subscription sends Graph webhook body", async (t) => {
  const originalFetch = globalThis.fetch;
  const capturedRequests: { requests: { url: string; body: Record<string, unknown> }[] } = { requests: [] };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init) => {
    capturedRequests.requests = [
      ...capturedRequests.requests,
      {
        url: fetchRequestUrl(input),
        body: parseFetchJsonBody(init),
      },
    ];

    return jsonResponse({
      payload: {
        id: "subscription-1",
        resource: "me/events",
        expirationDateTime: "2026-05-22T12:00:00.000Z",
      },
    });
  };

  const subscription = await watchOutlookCalendarEvents(outlookTokens(), {
    notificationUrl: "https://api.ready.test/v1/integrations/calendar/outlook_calendar/webhook",
    clientState: "signed-state",
    expirationAt: new Date("2026-05-22T12:00:00.000Z"),
  });

  assert.equal(subscription.subscriptionId, "subscription-1");
  assert.equal(capturedRequests.requests[0]?.body.changeType, "created,updated,deleted");
  assert.equal(capturedRequests.requests[0].body.resource, "me/events");
  assert.equal(capturedRequests.requests[0].body.clientState, "signed-state");
});
