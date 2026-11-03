import { QueryClient, QueryObserver } from "@tanstack/react-query";
import assert from "node:assert/strict";
import test from "node:test";

import { shouldPersistQuery } from "../../composition/query-cache-policy";
import { calendarReadyMeetingOptions, workspaceMeetingsOptions } from "../../composition/workspace-meetings-query";

const session = { token: "test-token", user: { id: "user-a", workspaceId: "workspace-a" } };

const FIXTURE_ID = "00000000-0000-4000-8000-000000000001";
const FIXTURE_CODE = "abc-defg-hij";
const FIXTURE_OTHER_CODE = "other-link";
const HTTP_FORBIDDEN = 403;
const MAX_CALL_IN_READS = 10;
const CALL_IN_POLL_MS = 2_000;

function resolvedLink(callIn: { phoneNumber: string; pin: string } | null) {
  return {
    meeting: {
      id: FIXTURE_ID,
      workspaceId: FIXTURE_ID,
      createdByUserId: FIXTURE_ID,
      title: "Fixture",
      roomName: "fixture",
      status: "scheduled",
      createdAt: "2030-01-01",
      startedAt: null,
      endedAt: null,
    },
    meetingLink: {
      id: FIXTURE_ID,
      workspaceId: FIXTURE_ID,
      createdByUserId: FIXTURE_ID,
      code: FIXTURE_CODE,
      title: "Fixture",
      status: "active",
      createdAt: "2030-01-01",
      updatedAt: "2030-01-01",
      callIn,
    },
  };
}

void test("selected calendar meeting refreshes missing dial-in and stops when provisioning completes", async (t) => {
  const client = new QueryClient();
  t.after(() => client.clear());
  const options = calendarReadyMeetingOptions({ session, code: FIXTURE_CODE });
  const interval = options.refetchInterval;
  assert.ok(typeof interval === "function");
  const observer = new QueryObserver(client, options);
  const request = t.mock.method(globalThis, "fetch", async () => Response.json(resolvedLink(null)));
  await observer.refetch();
  assert.equal(interval(observer.getCurrentQuery()), CALL_IN_POLL_MS);
  const callIn = { phoneNumber: "+12025550123", pin: "123456" };
  t.mock.method(globalThis, "fetch", async () => Response.json(resolvedLink(callIn)));
  await observer.refetch();
  assert.deepEqual(observer.getCurrentResult().data?.meetingLink.callIn, callIn);
  assert.equal(interval(observer.getCurrentQuery()), false);
  assert.equal(request.mock.callCount(), 1);
});

void test("dial-in refresh stops at its read limit or a failed request", async (t) => {
  const client = new QueryClient();
  t.after(() => client.clear());
  const options = calendarReadyMeetingOptions({ session, code: FIXTURE_CODE });
  const interval = options.refetchInterval;
  assert.ok(typeof interval === "function");
  const observer = new QueryObserver(client, options);
  t.mock.method(globalThis, "fetch", async () => Response.json(resolvedLink(null)));
  await Array.from({ length: MAX_CALL_IN_READS }).reduce(async (previous) => {
    await previous;
    await observer.refetch();
  }, Promise.resolve());
  assert.equal(interval(observer.getCurrentQuery()), false);
  const other = new QueryObserver(client, calendarReadyMeetingOptions({ session, code: FIXTURE_OTHER_CODE }));
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: HTTP_FORBIDDEN }));
  await other.refetch();
  assert.equal(other.getCurrentResult().isError, true);
  assert.equal(interval(other.getCurrentQuery()), false);
});

void test("shell warmup and page navigation share one request and expose cached data immediately", async (t) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  const request = t.mock.method(globalThis, "fetch", async () => Response.json({ meetings: [] }));
  await Promise.all([
    client.prefetchQuery(workspaceMeetingsOptions(session)),
    client.fetchQuery(workspaceMeetingsOptions(session)),
  ]);
  const observer = new QueryObserver(client, workspaceMeetingsOptions(session));
  const unsubscribe = observer.subscribe(() => {});
  t.after(unsubscribe);
  assert.equal(observer.getCurrentResult().isSuccess, true);
  assert.deepEqual(observer.getCurrentResult().data, []);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(shouldPersistQuery(workspaceMeetingsOptions(session).queryKey), false);
});

void test("warm meetings cannot satisfy a different account or workspace, or start anonymously", async (t) => {
  const client = new QueryClient();
  t.after(() => client.clear());
  client.setQueryData(workspaceMeetingsOptions(session).queryKey, []);
  [
    { id: "user-b", workspaceId: "workspace-a" },
    { id: "user-a", workspaceId: "workspace-b" },
  ].forEach((user) => {
    assert.equal(client.getQueryData(workspaceMeetingsOptions({ ...session, user }).queryKey), undefined);
  });
  assert.equal(workspaceMeetingsOptions(null).enabled, false);
  assert.equal(workspaceMeetingsOptions({ ...session, token: "" }).enabled, false);
});
