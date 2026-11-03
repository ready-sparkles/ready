import type { MeetingJoinRequest } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { loadJoinRequestsKeepingControlsOnOutage } from "../../../presentation/lib/live-meeting-join-requests";

const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_FORBIDDEN_STATUS = 403;
const HTTP_UNAVAILABLE_STATUS = 503;
const HOST_TOKEN = "host-token";
const FRESH_TOKEN = "fresh-token";
const UNAVAILABLE_MESSAGE = "unavailable";
const TIMED_OUT_MESSAGE = "timed out";
const FORBIDDEN_MESSAGE = "forbidden";
const UNAUTHORIZED_MESSAGE = "unauthorized";
const TIMESTAMP = "2026-10-14T00:00:00.000Z";

const WAITING_GUEST: MeetingJoinRequest = {
  id: "00000000-0000-4000-8000-000000000001",
  meetingLinkId: "00000000-0000-4000-8000-000000000002",
  meetingId: "00000000-0000-4000-8000-000000000003",
  userId: "00000000-0000-4000-8000-000000000004",
  displayName: "Waiting guest",
  status: "waiting",
  requestedAt: TIMESTAMP,
  decidedAt: null,
  decidedByUserId: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function createState() {
  const state = { requests: [WAITING_GUEST], canModerate: true };

  return {
    state,
    setJoinRequests: (requests: MeetingJoinRequest[]) => {
      state.requests = requests;
    },
    setCanModerateJoinRequests: (canModerate: boolean) => {
      state.canModerate = canModerate;
    },
  };
}

void test("a transient join-request outage keeps the host's admit and deny controls", async (t) => {
  const harness = createState();
  const refreshCalls = { count: 0 };
  t.mock.method(console, "error", () => undefined);
  const refreshAuthAfterUnauthorized = () => {
    refreshCalls.count += 1;

    return Promise.resolve(null);
  };
  {
    await loadJoinRequestsKeepingControlsOnOutage({
      token: HOST_TOKEN,
      listJoinRequests: () =>
        Promise.reject(Object.assign(new Error(UNAVAILABLE_MESSAGE), { status: HTTP_UNAVAILABLE_STATUS })),
      refreshAuthAfterUnauthorized,
      ...harness,
    });
    await loadJoinRequestsKeepingControlsOnOutage({
      token: HOST_TOKEN,
      listJoinRequests: () => Promise.reject(new DOMException(TIMED_OUT_MESSAGE, "TimeoutError")),
      refreshAuthAfterUnauthorized,
      ...harness,
    });
    await loadJoinRequestsKeepingControlsOnOutage({
      token: HOST_TOKEN,
      listJoinRequests: () => Promise.reject(new Error(UNAVAILABLE_MESSAGE)),
      refreshAuthAfterUnauthorized,
      ...harness,
    });
  }

  assert.equal(refreshCalls.count, 0);
  assert.equal(harness.state.canModerate, true);
  assert.deepEqual(harness.state.requests, [WAITING_GUEST]);
});

void test("a permission failure still removes the moderation controls", async () => {
  const harness = createState();
  await loadJoinRequestsKeepingControlsOnOutage({
    token: HOST_TOKEN,
    listJoinRequests: () =>
      Promise.reject(Object.assign(new Error(FORBIDDEN_MESSAGE), { status: HTTP_FORBIDDEN_STATUS })),
    refreshAuthAfterUnauthorized: () => Promise.resolve(null),
    ...harness,
  });

  assert.equal(harness.state.canModerate, false);
  assert.deepEqual(harness.state.requests, []);
});

void test("an unauthorized load retries with the refreshed session", async () => {
  const harness = createState();
  harness.setCanModerateJoinRequests(false);
  const seen: { tokens: string[] } = { tokens: [] };
  await loadJoinRequestsKeepingControlsOnOutage({
    token: HOST_TOKEN,
    listJoinRequests: (token) => {
      seen.tokens = [...seen.tokens, token];

      return token === FRESH_TOKEN
        ? Promise.resolve([WAITING_GUEST])
        : Promise.reject(Object.assign(new Error(UNAUTHORIZED_MESSAGE), { status: HTTP_UNAUTHORIZED_STATUS }));
    },
    refreshAuthAfterUnauthorized: () => Promise.resolve({ token: FRESH_TOKEN }),
    ...harness,
  });

  assert.deepEqual(seen.tokens, [HOST_TOKEN, FRESH_TOKEN]);
  assert.equal(harness.state.canModerate, true);
});
