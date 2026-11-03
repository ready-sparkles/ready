import { googleAddonConferenceIdempotencyKey, outlookAddonConferenceIdempotencyKey } from "@readymeet/db";
import { createCalendarAddonConferenceResponseSchema } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";

import { calendarAddonRoutes } from "../../adapters/primary/http/routes/meetings/calendar-addon";

type Dependencies = NonNullable<Parameters<typeof calendarAddonRoutes>[1]>;

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_CONFLICT = 409;
const OUTLOOK_ADDON_CALL_IN_WAIT_MS = 2_500;
const SHOULD_USE_EXISTING_DIAL_IN_ERROR_MESSAGE = "Should use existing dial-in";
const MUST_NOT_CREATE_ERROR_MESSAGE = "must not create";
const CALENDAR_ADDON_READY_LOG_MESSAGE = "Calendar add-on conference ready";

const logLineSchema = z.record(z.string(), z.unknown());

const calendarAddonReadyLogSchema = z.object({
  msg: z.string(),
  source: z.string(),
  reused: z.boolean(),
  hasCallIn: z.boolean(),
});

const meetingLinkUnavailableResponseSchema = z.object({
  code: z.literal("meeting_link_unavailable"),
});

const user = {
  id: randomUUID(),
  email: "host@ready.test",
  displayName: "Host",
  avatarUrl: null,
  plan: "free" as const,
  workspaceId: randomUUID(),
  source: "auth" as const,
  tokenKind: "full" as const,
};
const link = {
  id: randomUUID(),
  code: "abc-def-ghi",
  title: "Test",
  workspaceId: user.workspaceId,
  createdByUserId: user.id,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};
const meeting = {
  id: randomUUID(),
  title: "Test",
  roomName: "internal-room",
  meetingLinkId: link.id,
  instanceNumber: 1,
  workspaceId: user.workspaceId,
  createdByUserId: user.id,
  kind: "standard" as const,
  status: "scheduled" as const,
  isConfidential: false,
  confidentialitySource: null,
  confidentialityUpdatedByUserId: null,
  confidentialityUpdatedAt: null,
  createdAt: new Date(),
  startedAt: null,
  endedAt: null,
  hiddenFromHistoryAt: null,
  hiddenFromHistoryReason: null,
};
const access = {
  canCreateStandardMeeting: true,
  canHostStandardMeetings: true,
  freeStandardMeetingLimit: null,
  hasCreatorPlan: false,
  standardMeetingCount: 1,
};
const payload = { title: "Test", requestId: randomUUID() };
const callIn = {
  id: randomUUID(),
  meetingLinkId: link.id,
  sipDispatchRuleId: null,
  dispatchRuleKind: "direct",
  lastSyncedMeetingId: meeting.id,
  lastSyncError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  phoneNumber: "+358 40 1234567",
  pin: "123456",
  status: "active",
};

function appendLogLine(input: { logCollector: { entries: Record<string, unknown>[] }; chunk: string }) {
  const parsed = logLineSchema.parse(JSON.parse(input.chunk));
  const logCollector = input.logCollector;
  logCollector.entries = [...logCollector.entries, parsed];
}

function parseConferenceResponse(response: { json(): unknown }) {
  return createCalendarAddonConferenceResponseSchema.parse(response.json());
}

function findReadyLog(input: { entries: readonly Record<string, unknown>[] }) {
  const candidate = input.entries.find((log) => log.msg === CALENDAR_ADDON_READY_LOG_MESSAGE);
  if (candidate === undefined) {
    return undefined;
  }

  return calendarAddonReadyLogSchema.parse(candidate);
}

function parseMeetingLinkUnavailableResponse(response: { json(): unknown }) {
  return meetingLinkUnavailableResponseSchema.parse(response.json());
}

async function appWith(
  input: { overrides?: Dependencies; logCollector?: { entries: Record<string, unknown>[] } } = {},
) {
  const overrides = input.overrides ?? {};
  const logCollector = input.logCollector ?? { entries: [] };
  const app = Fastify({
    logger: {
      stream: {
        write: (chunk: string) => {
          appendLogLine({ logCollector, chunk });
        },
      },
    },
  });
  await calendarAddonRoutes(app, {
    requireAuth: async (incomingRequest) => {
      const request = incomingRequest;
      request.user = user;
    },
    getMeetingHostingAccessForUser: async () => access,
    generateUniqueMeetingLinkCode: async () => link.code,
    createOrReuseCalendarAddonConference: async () => ({ meeting, meetingLink: link, reused: false }),
    resolveMeetingLink: async () => ({ meeting, meetingLink: link, created: false }),
    getSyncedCallInForMeeting: async () => callIn,
    waitForSyncedCallInForMeeting: async () => {
      throw new Error(SHOULD_USE_EXISTING_DIAL_IN_ERROR_MESSAGE);
    },
    ...overrides,
  });

  return app;
}

void test("Outlook conference endpoint rejects unauthenticated or forged identity before creation", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await calendarAddonRoutes(app);
  await [undefined, "Bearer forged"].reduce(async (previous, authorization) => {
    await previous;
    const response = await app.inject({
      method: "POST",
      url: "/meetings/outlook-addon",
      headers: authorization !== undefined ? { authorization } : {},
      payload,
    });
    assert.equal(response.statusCode, HTTP_STATUS_UNAUTHORIZED);
  }, Promise.resolve());
});

void test("authenticated Outlook validation and hosting denial never create a room", async (t) => {
  const app = await appWith({
    overrides: {
      createOrReuseCalendarAddonConference: async () => {
        throw new Error(MUST_NOT_CREATE_ERROR_MESSAGE);
      },
      getMeetingHostingAccessForUser: async () => ({ ...access, canCreateStandardMeeting: false }),
    },
  });
  t.after(() => app.close());
  await [
    { ...payload, userId: randomUUID() },
    { ...payload, workspaceId: randomUUID() },
    { ...payload, requestId: "bad" },
  ].reduce(async (previous, invalid) => {
    await previous;
    assert.equal(
      (await app.inject({ method: "POST", url: "/meetings/outlook-addon", payload: invalid })).statusCode,
      HTTP_STATUS_BAD_REQUEST,
    );
  }, Promise.resolve());
  assert.equal(
    (await app.inject({ method: "POST", url: "/meetings/outlook-addon", payload })).statusCode,
    HTTP_STATUS_FORBIDDEN,
  );
});

[true, false].forEach((isReused) => {
  void test(`Outlook ${isReused ? "retry" : "creation"} binds identity and key, returns existing call-in without waiting`, async (t) => {
    const logCollector: { entries: Record<string, unknown>[] } = { entries: [] };
    const app = await appWith({
      overrides: {
        createOrReuseCalendarAddonConference: async (input) => {
          assert.equal(input.createdByUserId, user.id);
          assert.equal(input.workspaceId, user.workspaceId);
          assert.equal(input.idempotencyKey, outlookAddonConferenceIdempotencyKey(payload.requestId));
          assert.equal(input.replaceInactive, true);

          return { meeting, meetingLink: link, reused: isReused };
        },
      },
      logCollector,
    });
    t.after(() => app.close());
    const result = await app.inject({ method: "POST", url: "/meetings/outlook-addon", payload });
    assert.equal(result.statusCode, HTTP_STATUS_OK, result.body);
    const readyLog = findReadyLog({ entries: logCollector.entries });
    assert.equal(readyLog?.source, "outlook-addon");
    assert.equal(readyLog.reused, isReused);
    assert.equal(readyLog.hasCallIn, true);
    const body = parseConferenceResponse(result);
    assert.equal(body.reused, isReused);
    assert.equal(body.meetingLink.code, link.code);
    assert.ok(body.meetingLink.callIn !== null && body.meetingLink.callIn !== undefined);
    assert.equal(body.meetingLink.callIn.phoneNumber, callIn.phoneNumber);
  });
});

void test("missing dial-in waits only for the bounded budget and still returns a usable link", async (t) => {
  const waits = { count: 0 };
  const app = await appWith({
    overrides: {
      getSyncedCallInForMeeting: async () => null,
      waitForSyncedCallInForMeeting: async (input) => {
        waits.count += 1;
        assert.equal(input.timeoutMs, OUTLOOK_ADDON_CALL_IN_WAIT_MS);

        return null;
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/meetings/outlook-addon", payload });
  assert.equal(response.statusCode, HTTP_STATUS_OK);
  const body = parseConferenceResponse(response);
  assert.equal(body.meetingLink.callIn, null);
  assert.equal(waits.count, 1);
});

void test("unavailable resolved rooms return a distinct conflict, never a dead link", async (t) => {
  const app = await appWith({
    overrides: {
      createOrReuseCalendarAddonConference: async () => ({ meeting: null, meetingLink: link, reused: true }),
      resolveMeetingLink: async () => null,
    },
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/meetings/outlook-addon", payload });
  assert.equal(response.statusCode, HTTP_STATUS_CONFLICT);
  const conflict = parseMeetingLinkUnavailableResponse(response);
  assert.equal(conflict.code, "meeting_link_unavailable");
});

void test("shared path preserves Google retry keys and description refresh enqueue", async (t) => {
  const google = {
    title: "Test",
    calendarId: "primary",
    eventId: "event-1",
    calendarAccessToken: "test-only-access-token",
    calendarWebBaseUrl: "https://ready.app",
  };
  const queued = { isQueued: false };
  const app = await appWith({
    overrides: {
      createOrReuseCalendarAddonConference: async (input) => {
        assert.equal(input.idempotencyKey, googleAddonConferenceIdempotencyKey(google));
        assert.equal(input.replaceInactive, false);

        return { meeting, meetingLink: link, reused: true };
      },
      publishGoogleCalendarDescription: async (input) => {
        queued.isQueued = true;
        assert.equal(input.meetingLinkId, link.id);
        assert.equal(input.userId, user.id);
        assert.equal(input.accessToken, "test-only-access-token");
        assert.equal(input.email, user.email);
        assert.equal(input.calendarId, "primary");
        assert.equal(input.eventId, "event-1");
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/meetings/google-calendar-addon", payload: google });
  assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);
  assert.equal(queued.isQueued, true);
});
