import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MeetingJoinRequest } from "@readymeet/shared";
import { act, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { useJoinRequestsRefresh } from "../../../presentation/hooks/use-join-requests-refresh";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REQUEST_TIMEOUT_MS = 10_000;
const RECOVERY_READS = 2;
const FORBIDDEN_STATUS = 403;
const meetingId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const request: MeetingJoinRequest = {
  id: "44444444-4444-4444-8444-444444444444",
  meetingLinkId: otherId,
  meetingId,
  userId: otherId,
  displayName: "Guest",
  status: "waiting",
  requestedAt: "2026-09-25T10:00:00Z",
  decidedAt: null,
  decidedByUserId: null,
  createdAt: "2026-09-25T10:00:00Z",
  updatedAt: "2026-09-25T10:00:00Z",
};
const refreshAuthAfterUnauthorized = async () => null;
const input = { meetingId, token: "token-A", scopeKey: "viewer", isEnabled: true, refreshAuthAfterUnauthorized };
const response = (requests: MeetingJoinRequest[]) => new Response(JSON.stringify({ requests }));

void test("a timed-out HTTP read releases the queue so a queued recovery can succeed", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const deadline = new AbortController();
  const timeoutState = { signal: deadline.signal };
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, REQUEST_TIMEOUT_MS);

    return timeoutState.signal;
  });
  const reads = { count: 0 };
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    reads.count += 1;
    if (reads.count === 1) {
      return new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    }

    return response([request]);
  });
  const view = renderHook(() => useJoinRequestsRefresh(input));
  const pending = { read: Promise.resolve() };
  act(() => {
    pending.read = view.result.current.loadJoinRequests();
  });
  assert.equal(reads.count, 1);
  assert.equal(view.result.current.isJoinRequestsLoading, true);
  // Each HTTP attempt gets its own deadline, including the queued follow-up.
  timeoutState.signal = new AbortController().signal;
  act(() => {
    void view.result.current.loadJoinRequests();
  });
  await act(async () => {
    deadline.abort(new DOMException("Timeout", "TimeoutError"));
    await pending.read;
  });
  assert.equal(errors.mock.callCount(), 1, "real timeouts must still be reported");
  assert.equal(reads.count, RECOVERY_READS);
  assert.deepEqual(view.result.current.joinRequests, [request]);
  assert.equal(view.result.current.canModerateJoinRequests, true);
  assert.equal(view.result.current.isJoinRequestsLoading, false);
  view.unmount();
});

void test("retired-session reads and queued work cannot overwrite a denied current viewer", async (t) => {
  const old = { resolve: (_response: Response) => {}, signal: null as AbortSignal | null | undefined };
  const reads = { count: 0 };
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    reads.count += 1;
    if (new Headers(options.headers).get("authorization") === "Bearer token-A") {
      old.signal = options.signal;

      // Deliberately ignore abort to exercise the result guard as well as cancellation.
      return new Promise<Response>((resolve) => {
        old.resolve = resolve;
      });
    }

    return new Response("Forbidden", { status: FORBIDDEN_STATUS });
  });
  const view = renderHook((props) => useJoinRequestsRefresh(props), { initialProps: input });
  const pending = { read: Promise.resolve() };
  act(() => {
    pending.read = view.result.current.loadJoinRequests();
    void view.result.current.loadJoinRequests();
  });
  await act(async () => {
    view.rerender({ ...input, token: "token-B", scopeKey: "other-viewer" });
  });
  assert.equal(old.signal?.aborted, true);
  await act(async () => view.result.current.loadJoinRequests());
  assert.equal(view.result.current.canModerateJoinRequests, false);
  await act(async () => {
    old.resolve(response([request]));
    await pending.read;
  });
  assert.equal(reads.count, RECOVERY_READS, "retired queued work makes no additional HTTP calls");
  assert.deepEqual(view.result.current.joinRequests, []);
  assert.equal(view.result.current.canModerateJoinRequests, false);
  assert.equal(view.result.current.isJoinRequestsLoading, false);
  view.unmount();
});

void test("an event invalidation during HTTP triggers a second authoritative snapshot", async (t) => {
  const old = { resolve: (_response: Response) => {} };
  const reads = { count: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    reads.count += 1;
    if (reads.count === 1) {
      return new Promise<Response>((resolve) => {
        old.resolve = resolve;
      });
    }

    return response([]);
  });
  const view = renderHook(() => useJoinRequestsRefresh(input));
  const pending = { read: Promise.resolve() };
  act(() => {
    pending.read = view.result.current.loadJoinRequests();
    void view.result.current.loadJoinRequests();
  });
  await act(async () => {
    old.resolve(response([request]));
    await pending.read;
  });
  assert.equal(reads.count, RECOVERY_READS);
  assert.deepEqual(view.result.current.joinRequests, []);
  assert.equal(view.result.current.canModerateJoinRequests, true);
  view.unmount();
});

void test("cancelling a retired join-request refresh does not report a service outage", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
  );
  const view = renderHook(() => useJoinRequestsRefresh(input));
  const pending = { read: Promise.resolve() };
  act(() => {
    pending.read = view.result.current.loadJoinRequests();
  });
  await act(async () => {
    view.unmount();
    await pending.read;
  });
  assert.equal(errors.mock.callCount(), 0);
});

void test("a 403 for a non-host stops further join-request reads for that viewer", async (t) => {
  const reads = { count: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    reads.count += 1;

    return new Response("Forbidden", { status: FORBIDDEN_STATUS });
  });
  const view = renderHook((props) => useJoinRequestsRefresh(props), { initialProps: input });
  assert.equal(view.result.current.canPollJoinRequests, true);
  await act(async () => view.result.current.loadJoinRequests());
  assert.equal(reads.count, 1);
  assert.equal(view.result.current.canModerateJoinRequests, false);
  assert.equal(view.result.current.canPollJoinRequests, false);
  await act(async () => view.result.current.loadJoinRequests());
  await act(async () => view.result.current.loadJoinRequests());
  assert.equal(reads.count, 1, "polling ticks after the 403 make no HTTP calls");
  await act(async () => {
    view.rerender({ ...input, token: "token-B" });
  });
  assert.equal(view.result.current.canPollJoinRequests, true, "a new session checks access again");
  await act(async () => view.result.current.loadJoinRequests());
  assert.equal(reads.count, RECOVERY_READS);
  view.unmount();
});
