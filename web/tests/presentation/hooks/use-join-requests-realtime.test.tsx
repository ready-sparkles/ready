import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  JOIN_REQUEST_REALTIME_VERSION,
  type JoinRequestRealtimePayload,
  type MeetingJoinRequest,
} from "@readymeet/shared";
import { act, renderHook } from "@testing-library/react";
import type Ably from "ably";
import assert from "node:assert/strict";
import test from "node:test";
import { useState } from "react";

import {
  JOIN_REQUEST_LIST_POLL_MS,
  useJoinRequestsRealtime,
  useMeetingJoinRequestWatch,
} from "../../../presentation/hooks/use-join-requests-realtime";
import { useJoinRequestsRefresh } from "../../../presentation/hooks/use-join-requests-refresh";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SECOND_RECOVERY_READ = 2;
const RECONNECT_CATCH_UP_READS = 2;
const DENIED_MESSAGE = "Denied";
const ATTACHMENT_TIMEOUT_MESSAGE = "Attachment timed out";
const meetingId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const request: MeetingJoinRequest = {
  id: "44444444-4444-4444-8444-444444444444",
  meetingLinkId: workspaceId,
  meetingId,
  userId: workspaceId,
  displayName: "Guest",
  status: "waiting",
  requestedAt: "2026-09-25T10:00:00Z",
  decidedAt: null,
  decidedByUserId: null,
  createdAt: "2026-09-25T10:00:00Z",
  updatedAt: "2026-09-25T10:00:00Z",
};

function joinRequestEvent(nextRequest: MeetingJoinRequest): JoinRequestRealtimePayload {
  return {
    version: JOIN_REQUEST_REALTIME_VERSION,
    eventId: "55555555-5555-4555-8555-555555555555",
    eventName: "join-request.updated",
    request: nextRequest,
    meeting: null,
    occurredAt: "2026-09-25T10:00:00Z",
  };
}

function fakeRealtime(attachment: Promise<void> = Promise.resolve()) {
  const listeners = new Set<(change: Ably.ChannelStateChange) => void>();
  const connectionListeners = new Set<() => void>();
  const messages = new Set<(message: { data?: unknown }) => void>();
  const channel = {
    state: "initialized",
    on: (listener: (change: Ably.ChannelStateChange) => void) => listeners.add(listener),
    off: (listener: (change: Ably.ChannelStateChange) => void) => listeners.delete(listener),
    subscribe: async (listener: (message: { data?: unknown }) => void) => {
      messages.add(listener);
      await attachment;
      channel.state = "attached";
      listeners.forEach((handler) => {
        handler({ current: "attached", previous: "attaching", resumed: false });
      });
    },
    unsubscribe: (listener: (message: { data?: unknown }) => void) => messages.delete(listener),
    detach: async () => {
      channel.state = "detached";
    },
  };
  const connection = {
    state: "connected",
    on: (listener: () => void) => connectionListeners.add(listener),
    off: (listener: () => void) => connectionListeners.delete(listener),
  };
  const value = { channels: { get: () => channel }, connection };
  const isClient = (candidate: object): candidate is Ably.Realtime =>
    "channels" in candidate && "connection" in candidate;
  assert.ok(isClient(value));

  return { client: value, channel, connection, listeners, connectionListeners, messages };
}

void test("waiting-room messages update the list and reconnect catches up", async () => {
  const fake = fakeRealtime();
  const reads = { count: 0 };
  const refresh = async () => {
    reads.count += 1;
  };
  const refreshAuth = async () => {};
  const authScopeRef = { current: null as string | null };
  const view = renderHook(() => {
    const [requests, setJoinRequests] = useState<MeetingJoinRequest[]>([]);
    const isHealthy = useJoinRequestsRealtime({
      client: fake.client,
      meetingId,
      workspaceId,
      scopeKey: "viewer",
      isEnabled: true,
      refreshAuth,
      authScopeRef,
      refresh,
      setJoinRequests,
    });

    return { isHealthy, requests };
  });
  await act(async () => {});
  assert.equal(view.result.current.isHealthy, true);
  const readsBeforeEvents = reads.count;
  act(() => {
    fake.messages.forEach((handler) => {
      handler({ data: { request } });
      handler({ data: joinRequestEvent({ ...request, meetingId: workspaceId }) });
    });
  });
  assert.deepEqual(view.result.current.requests, []);
  assert.equal(reads.count, readsBeforeEvents, "invalid events do not trigger reads");
  act(() =>
    fake.messages.forEach((handler) => {
      handler({ data: joinRequestEvent(request) });
    }),
  );
  assert.deepEqual(view.result.current.requests, [request]);
  assert.equal(reads.count, readsBeforeEvents + 1);
  act(() =>
    fake.messages.forEach((handler) => {
      handler({ data: joinRequestEvent({ ...request, status: "admitted" }) });
    }),
  );
  assert.deepEqual(view.result.current.requests, []);
  const initialReads = reads.count;
  assert.equal(initialReads, readsBeforeEvents + SECOND_RECOVERY_READ);
  act(() => {
    fake.connection.state = "disconnected";
    fake.connectionListeners.forEach((handler) => {
      handler();
    });
  });
  assert.equal(view.result.current.isHealthy, false);
  assert.equal(reads.count, initialReads);
  act(() => {
    fake.connection.state = "connected";
    fake.connectionListeners.forEach((handler) => {
      handler();
    });
  });
  assert.equal(view.result.current.isHealthy, true);
  assert.equal(reads.count, initialReads + 1);
  act(() =>
    fake.listeners.forEach((handler) => {
      handler({ current: "attached", previous: "attached", resumed: false });
    }),
  );
  assert.equal(reads.count, initialReads + RECONNECT_CATCH_UP_READS);
  const readsBeforeRace = reads.count;
  act(() =>
    fake.messages.forEach((handler) => {
      handler({ data: joinRequestEvent(request) });
    }),
  );
  assert.equal(reads.count, readsBeforeRace + 1, "an event during HTTP schedules a catch-up read");
  view.unmount();
  assert.equal(fake.listeners.size, 0);
  assert.equal(fake.connectionListeners.size, 0);
  assert.equal(fake.messages.size, 0);
});

void test("a delayed waiting event after admission converges to the authoritative HTTP list", async (t) => {
  const fake = fakeRealtime();
  const refreshAuth = async () => {};
  const authScopeRef = { current: null as string | null };
  const refreshAuthAfterUnauthorized = async () => null;
  const reads = { count: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    reads.count += 1;

    return new Response(JSON.stringify({ requests: [] }));
  });
  const view = renderHook(() => {
    const data = useJoinRequestsRefresh({
      meetingId,
      token: "token",
      scopeKey: "viewer",
      isEnabled: true,
      refreshAuthAfterUnauthorized,
    });
    useJoinRequestsRealtime({
      client: fake.client,
      meetingId,
      workspaceId,
      scopeKey: "viewer",
      isEnabled: true,
      refreshAuth,
      authScopeRef,
      refresh: data.loadJoinRequests,
      setJoinRequests: data.setJoinRequests,
    });

    return data;
  });
  await act(async () => {});
  const initialReads = reads.count;
  await act(async () => {
    fake.messages.forEach((handler) => {
      handler({ data: joinRequestEvent({ ...request, status: "admitted" }) });
    });
  });
  await act(async () => {
    fake.messages.forEach((handler) => {
      handler({ data: joinRequestEvent(request) });
    });
  });
  assert.equal(reads.count, initialReads + SECOND_RECOVERY_READ);
  assert.deepEqual(view.result.current.joinRequests, []);
  view.unmount();
});

void test("unmount during attachment ignores late messages and removes the eventual subscription", async () => {
  const gate = { finish: () => {} };
  const fake = fakeRealtime(
    new Promise<void>((resolve) => {
      gate.finish = resolve;
    }),
  );
  const reads = { count: 0 };
  const view = renderHook(() =>
    useJoinRequestsRealtime({
      client: fake.client,
      meetingId,
      workspaceId,
      scopeKey: "viewer",
      isEnabled: true,
      refreshAuth: async () => {},
      authScopeRef: { current: null },
      refresh: async () => {
        reads.count += 1;
      },
      setJoinRequests: () => {},
    }),
  );
  await act(async () => {});
  assert.equal(view.result.current, false);
  view.unmount();
  await act(async () => gate.finish());
  assert.equal(fake.messages.size, 0);
  assert.equal(fake.listeners.size, 0);
  assert.equal(fake.connectionListeners.size, 0);
  assert.equal(reads.count, 0);
});

void test("automatic attachment recovery after rejection becomes healthy", async (t) => {
  const fake = fakeRealtime();
  const refreshAuth = async () => {};
  const refresh = async () => {};
  const authScopeRef = { current: null as string | null };
  t.mock.method(console, "error", () => {});
  t.mock.method(fake.channel, "subscribe", async (listener: (message: { data?: unknown }) => void) => {
    fake.messages.add(listener);
    fake.channel.state = "suspended";
    throw new Error(ATTACHMENT_TIMEOUT_MESSAGE);
  });
  const view = renderHook(() => {
    const [requests, setJoinRequests] = useState<MeetingJoinRequest[]>([]);
    const isHealthy = useJoinRequestsRealtime({
      client: fake.client,
      meetingId,
      workspaceId,
      scopeKey: "viewer",
      isEnabled: true,
      refreshAuth,
      authScopeRef,
      refresh,
      setJoinRequests,
    });

    return { isHealthy, requests };
  });
  await act(async () => {});
  assert.equal(view.result.current.isHealthy, false);
  act(() => {
    fake.channel.state = "attached";
    fake.listeners.forEach((handler) => {
      handler({ current: "attached", previous: "suspended", resumed: false });
    });
  });
  assert.equal(view.result.current.isHealthy, true);
  view.unmount();
  assert.equal(fake.messages.size, 0);
});

void test("a missed waiting-room event still shows the saved guest on the next check", async (t) => {
  const fake = fakeRealtime();
  const waitingList = { requests: [] as MeetingJoinRequest[] };
  const refreshAuthAfterUnauthorized = async () => null;
  const refreshAuth = async () => {};
  const authScopeRef = { current: null as string | null };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ requests: waitingList.requests })));
  const timers = new Map<number, () => void>();
  t.mock.method(window, "setInterval", (run: () => void, delay?: number) => {
    assert.equal(delay, JOIN_REQUEST_LIST_POLL_MS);
    timers.set(1, run);

    return 1;
  });
  t.mock.method(window, "clearInterval", (id: number) => timers.delete(id));
  const view = renderHook(() => {
    const data = useJoinRequestsRefresh({
      meetingId,
      token: "token",
      scopeKey: "host",
      isEnabled: true,
      refreshAuthAfterUnauthorized,
    });
    useMeetingJoinRequestWatch({
      client: fake.client,
      meetingId,
      workspaceId,
      scopeKey: "host",
      isEnabled: true,
      isPollingEnabled: true,
      refreshAuth,
      authScopeRef,
      refresh: data.loadJoinRequests,
      setJoinRequests: data.setJoinRequests,
    });

    return data.joinRequests;
  });
  await act(async () => {});
  assert.equal(timers.size, 1);
  assert.deepEqual(view.result.current, []);
  waitingList.requests = [request];
  await act(async () => {
    timers.forEach((run) => {
      run();
    });
  });
  assert.deepEqual(view.result.current, [request]);
  view.unmount();
  assert.equal(fake.messages.size, 0);
});

void test("failed authorization cannot claim an existing attached channel is healthy", async (t) => {
  const fake = fakeRealtime();
  fake.channel.state = "attached";
  t.mock.method(console, "error", () => {});
  const view = renderHook(() =>
    useJoinRequestsRealtime({
      client: fake.client,
      meetingId,
      workspaceId,
      scopeKey: "viewer",
      isEnabled: true,
      refreshAuth: async () => {
        throw new Error(DENIED_MESSAGE);
      },
      authScopeRef: { current: null },
      refresh: async () => {},
      setJoinRequests: () => {},
    }),
  );
  await act(async () => {});
  assert.equal(view.result.current, false);
  assert.equal(fake.messages.size, 0);
  view.unmount();
});

void test("failed subscription stays unhealthy", async (t) => {
  const fake = fakeRealtime();
  t.mock.method(fake.channel, "subscribe", async () => {
    throw new Error(DENIED_MESSAGE);
  });
  t.mock.method(console, "error", () => {});
  const view = renderHook(() => {
    const [requests, setJoinRequests] = useState<MeetingJoinRequest[]>([]);
    const isHealthy = useJoinRequestsRealtime({
      client: fake.client,
      meetingId,
      workspaceId,
      scopeKey: "viewer",
      isEnabled: true,
      refreshAuth: async () => {},
      authScopeRef: { current: null },
      refresh: async () => {},
      setJoinRequests,
    });

    return { isHealthy, requests };
  });
  await act(async () => {});
  assert.equal(view.result.current.isHealthy, false);
  assert.deepEqual(view.result.current.requests, []);
  view.unmount();
});
