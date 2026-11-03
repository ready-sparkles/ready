import assert from "node:assert/strict";
import test from "node:test";

import {
  decorateCalendarEventsWithReadyMeetings,
  markCalendarConnectorDisconnectedForAuthFailure,
} from "../../../../../adapters/primary/http/routes/integrations";
import {
  normalizeGoogleCalendarEvent,
  normalizeOutlookCalendarEvent,
} from "../../../../../application/calendar-client";
import { repositories } from "../../../../../ports/repository-runtime";

const FIXTURE_LINK_CODE = "abc-defg-hij";
const MESSAGE_INVALID_CALENDAR_CONNECTOR_FIXTURE = "Invalid calendar connector fixture.";

void test("Google listing returns mapped links without provisioning missing dial-in", async (t) => {
  const port = repositories();
  const event = normalizeGoogleCalendarEvent({ id: "google-event" });
  t.mock.method(port, "listCalendarReadyLinkMappingsForProviderEvents", async () => [
    {
      calendarReadyLink: { providerEventId: "google-event" },
      meetingLink: { id: "link", code: FIXTURE_LINK_CODE, status: "active", createdByUserId: "owner" },
      callIn: null,
    },
  ]);
  t.mock.method(port, "getCurrentMeetingForLink", async () =>
    assert.fail("Listing must not provision a meeting or dial-in"),
  );
  const [decorated] = await decorateCalendarEventsWithReadyMeetings(
    decorationInput({ provider: "google_calendar", events: [event] }),
  );
  assert.equal(decorated?.readyMeeting?.meetingLinkId, "link");
  assert.equal(decorated.readyMeeting.callIn, null);
  assert.equal(decorated.canAddReadyMeeting, false);
});

void test("Google listing preserves stored dial-in when reconciling provider links", async (t) => {
  const port = repositories();
  const event = normalizeGoogleCalendarEvent({ id: "google-event", description: "https://ready.app/abc-defg-hij" });
  t.mock.method(port, "listCalendarReadyLinkMappingsForProviderEvents", async () => []);
  t.mock.method(port, "getMeetingLinkByCode", async () => ({
    id: "link",
    code: FIXTURE_LINK_CODE,
    status: "active",
    workspaceId: "workspace",
  }));
  t.mock.method(port, "getCalendarReadyLinkForProviderEvent", async () => ({ id: "mapping" }));
  t.mock.method(port, "getCurrentMeetingForLink", async () => assert.fail("Listing must not provision dial-in"));
  t.mock.method(port, "getMeetingLinkCallIn", async () => ({
    status: "active",
    phoneNumber: "+12025550123",
    pin: "123456",
  }));
  const [decorated] = await decorateCalendarEventsWithReadyMeetings(
    decorationInput({ provider: "google_calendar", events: [event] }),
  );
  assert.deepEqual(decorated?.readyMeeting?.callIn, { phoneNumber: "+12025550123", pin: "123456" });
  t.mock.method(port, "getMeetingLinkCallIn", async () => null);
  const [pending] = await decorateCalendarEventsWithReadyMeetings(
    decorationInput({ provider: "google_calendar", events: [event] }),
  );
  assert.equal(pending?.readyMeeting?.meetingLinkId, "link");
  assert.equal(pending.readyMeeting.callIn, null);
});

type DecorationInput = Parameters<typeof decorateCalendarEventsWithReadyMeetings>[0];
type CalendarConnectorFixture = Pick<DecorationInput["connector"], "id" | "provider">;

function isCalendarConnectorFixture(value: CalendarConnectorFixture): value is DecorationInput["connector"] {
  return (
    typeof value.id === "string" && (value.provider === "google_calendar" || value.provider === "outlook_calendar")
  );
}

function decorationInput(input: {
  provider: "google_calendar" | "outlook_calendar";
  events: DecorationInput["events"];
}): DecorationInput {
  const connector: CalendarConnectorFixture = { id: "calendar-account", provider: input.provider };
  if (!isCalendarConnectorFixture(connector)) {
    throw new Error(MESSAGE_INVALID_CALENDAR_CONNECTOR_FIXTURE);
  }

  return {
    events: input.events,
    connector,
    tokens: {
      provider: input.provider,
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: "2030-01-01T00:00:00Z",
      scope: "",
      tokenType: "Bearer",
    },
    userId: "user",
    workspaceId: "workspace",
    logger: { warn: () => {} },
  };
}

void test("Outlook calendar reloads preserve Ready details without mapping or dial-in work", async () => {
  const events = [
    normalizeOutlookCalendarEvent({
      id: "with-dial-in",
      body: { content: "https://ready.app/abc-defg-hij\nDial-in: +1 202-555-0123 PIN: 123456#" },
    }),
    normalizeOutlookCalendarEvent({
      id: "pending-dial-in",
      onlineMeeting: { joinUrl: "https://ready.app/xyz-wxyz-xyz" },
    }),
    normalizeOutlookCalendarEvent({ id: "no-ready-link", subject: "Personal appointment" }),
  ];
  const unexpectedWork = async () => assert.fail("Outlook listing must not read/write mappings or provision dial-in");
  await [0, 1].reduce(async (pending) => {
    await pending;
    const decorated = await decorateCalendarEventsWithReadyMeetings({
      ...decorationInput({ provider: "outlook_calendar", events }),
      dependencies: {
        listMappings: unexpectedWork,
        reconcile: unexpectedWork,
      },
    });
    assert.deepEqual(
      decorated.map((event) => event.readyMeeting),
      events.map((event) => event.readyMeeting),
    );
    assert.deepEqual(decorated[0]?.readyMeeting?.callIn, { phoneNumber: "+12025550123", pin: "123456" });
    assert.equal(decorated[1]?.readyMeeting?.callIn, null);
    assert.ok(
      decorated.every(
        (event) =>
          event.calendarAccountId === "calendar-account" &&
          !(event.canAddReadyMeeting ?? false) &&
          !(event.needsCalendarWriteConsent ?? false),
      ),
    );
  }, Promise.resolve());
});

void test("Google calendar events retain their mapping and reconciliation flow", async () => {
  const event = normalizeGoogleCalendarEvent({
    id: "google-event",
    description: "https://ready.app/abc-defg-hij",
    organizer: {
      /** @external google calendar organizer wire field */
      self: true,
    },
  });
  const calls: { values: string[] } = { values: [] };
  const decorated = await decorateCalendarEventsWithReadyMeetings({
    ...decorationInput({ provider: "google_calendar", events: [event] }),
    dependencies: {
      listMappings: async (input) => {
        assert.equal(input.provider, "google_calendar");
        assert.deepEqual(input.providerEventKeys, ["google-event"]);
        calls.values = [...calls.values, "list"];

        return [];
      },
      reconcile: async (input) => {
        calls.values = [...calls.values, "reconcile"];

        return input.event.readyMeeting ?? null;
      },
    },
  });
  assert.deepEqual(calls.values, ["list", "reconcile"]);
  assert.deepEqual(decorated[0]?.readyMeeting, event.readyMeeting);
  assert.equal(decorated[0]?.canAddReadyMeeting, false);
});

void test("automatic Calendar auth failure preserves pending grants while stopping active sync", async () => {
  const operations: { values: string[] } = { values: [] };
  const updatedAt = new Date("2030-01-01T00:00:00.000Z");
  await markCalendarConnectorDisconnectedForAuthFailure({
    connector: { id: "connector", provider: "google_calendar", updatedAt },
    userId: "ready-user",
    dependencies: {
      disconnect: async (input) => {
        assert.deepEqual(input, {
          userId: "ready-user",
          accountId: "connector",
          /** @external calendar disconnect wire field */
          preservePending: true,
          expectedUpdatedAt: updatedAt,
        });
        operations.values = [...operations.values, "disconnect-active"];

        return { id: "connector", updatedAt: "2030-01-01T00:00:00.000Z" };
      },
      markInactive: async (connectorId) => {
        assert.equal(connectorId, "connector");
        operations.values = [...operations.values, "stop-sync"];
      },
      enqueue: async (event) => {
        assert.equal(event.userId, "ready-user");
        assert.equal(event.connectorId, "connector");
        assert.equal(event.resourceState, "disconnected");
        assert.match(event.dedupeKey, /2030-01-01T00:00:00\.000Z$/);
        operations.values = [...operations.values, "notify"];
      },
    },
  });
  assert.deepEqual(operations.values, ["disconnect-active", "stop-sync", "notify"]);
});

void test("stale automatic Calendar cleanup does not recreate removed or freshly reconnected accounts", async () => {
  await markCalendarConnectorDisconnectedForAuthFailure({
    connector: {
      id: "stale-connector",
      provider: "google_calendar",
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    },
    userId: "ready-user",
    dependencies: {
      disconnect: async () => null,
      markInactive: async () => assert.fail("removed account must not be reactivated"),
      enqueue: async () => assert.fail("no stale account notification"),
    },
  });
});
