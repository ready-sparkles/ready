import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MeetingTrackerState } from "@readymeet/shared";
import { act, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../../composition/api";
import {
  type MeetingTrackerRealtimeChannel,
  type MeetingTrackerRealtimeClient,
  useMeetingTracker,
} from "../../../presentation/hooks/use-meeting-tracker";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const state: MeetingTrackerState = { revision: 1, items: [], updatedAt: null, status: "idle" };
const SECOND_REVISION = 2;
const CONNECTION_FAILED = "Connection failed";
const FORBIDDEN = "Forbidden";
const SERVICE_UNAVAILABLE_STATUS = 503;
const refreshAuth = async (): Promise<void> => {};

type LoadInput = { token: string; meetingId: string; signal?: AbortSignal };
type FakeChannel = {
  channel: MeetingTrackerRealtimeChannel;
  listeners: Map<string, () => void>;
  probe: { message?: () => void; subscriptions: number };
};

function createFakeChannel(beforeSubscribe: () => Promise<void> = async () => {}): FakeChannel {
  const listeners = new Map<string, () => void>();
  const probe: FakeChannel["probe"] = { subscriptions: 0 };
  const channel: MeetingTrackerRealtimeChannel = {
    listen: ({ event, callback }) => {
      listeners.set(event, callback);
    },
    unlisten: ({ event }) => {
      listeners.delete(event);
    },
    subscribe: async ({ callback }) => {
      probe.subscriptions += 1;
      probe.message = callback;
      await beforeSubscribe();
    },
    unsubscribe: () => {
      probe.message = undefined;
    },
  };

  return { channel, listeners, probe };
}

function createGate(): { promise: Promise<void>; settle: (input: { shouldFail: boolean }) => void } {
  const handlers: { resolve: () => void; reject: (error: Error) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const promise = new Promise<void>((resolve, reject) => {
    handlers.resolve = resolve;
    handlers.reject = reject;
  });

  return {
    promise,
    settle: ({ shouldFail }) => {
      if (shouldFail) {
        handlers.reject(new Error(CONNECTION_FAILED));
      } else {
        handlers.resolve();
      }
    },
  };
}

async function assertCleanupDuringPending(input: {
  pending: "auth" | "subscribe";
  shouldFail: boolean;
}): Promise<void> {
  const gate = createGate();
  const fake = createFakeChannel(async () => {
    if (input.pending === "subscribe") {
      await gate.promise;
    }
  });
  const loads: { count: number; signal?: AbortSignal } = { count: 0 };
  const load = async ({ signal }: LoadInput): Promise<MeetingTrackerState> => {
    loads.count += 1;
    loads.signal = signal;

    return state;
  };
  const authorize = async (): Promise<void> => {
    if (input.pending === "auth") {
      await gate.promise;
    }
  };
  // A stable client mirrors the memoized production adapter; a new object each render would re-run the effect.
  const client: MeetingTrackerRealtimeClient = { getChannel: () => fake.channel };
  const view = renderHook(() =>
    useMeetingTracker({
      token: "session",
      meetingId: "first",
      workspaceId: "workspace",
      isEnabled: true,
      client,
      refreshAuth: authorize,
      load,
    }),
  );
  await act(async () => {});
  const expectedSubscriptions = input.pending === "auth" ? 0 : 1;
  assert.equal(fake.probe.subscriptions, expectedSubscriptions);
  view.unmount();
  assert.equal(loads.signal?.aborted, true);
  assert.equal(fake.listeners.size, 0);
  assert.equal(fake.probe.message, undefined);
  const loadsAtUnmount = loads.count;
  await act(async () => {
    gate.settle({ shouldFail: input.shouldFail });
  });
  assert.equal(fake.probe.subscriptions, expectedSubscriptions);
  assert.equal(fake.probe.message, undefined);
  assert.equal(fake.listeners.size, 0);
  assert.equal(loads.count, loadsAtUnmount);
}

const PENDING_CASES = [
  { pending: "auth", shouldFail: false },
  { pending: "auth", shouldFail: true },
  { pending: "subscribe", shouldFail: false },
  { pending: "subscribe", shouldFail: true },
] as const;

PENDING_CASES.forEach(({ pending, shouldFail }) => {
  void test(`cleans up when unmounted during ${pending}, then it ${shouldFail ? "fails" : "completes"}`, async () => {
    await assertCleanupDuringPending({ pending, shouldFail });
  });
});

void test("ignores late responses from an old meeting and clears state when leaving", async () => {
  const pendingFirst: { finish: (value: MeetingTrackerState) => void } = { finish: () => {} };
  const load = async ({ meetingId }: LoadInput): Promise<MeetingTrackerState> =>
    meetingId === "first"
      ? new Promise<MeetingTrackerState>((resolve) => {
          pendingFirst.finish = resolve;
        })
      : { ...state, revision: SECOND_REVISION };
  const view = renderHook(
    ({ meetingId, isEnabled }) =>
      useMeetingTracker({ token: "session", meetingId, isEnabled, client: null, refreshAuth, load }),
    { initialProps: { meetingId: "first", isEnabled: true } },
  );
  view.rerender({ meetingId: "second", isEnabled: true });
  await act(async () => {});
  assert.equal(view.result.current.data?.revision, SECOND_REVISION);
  await act(async () => {
    pendingFirst.finish(state);
  });
  assert.equal(view.result.current.data.revision, SECOND_REVISION);
  view.rerender({ meetingId: "second", isEnabled: false });
  assert.equal(view.result.current.data, null);
  view.unmount();
});

void test("refetches on reconnect, keeps outages quiet, clears denied data, and removes listeners on unmount", async () => {
  const fake = createFakeChannel();
  const access = { isDenied: false, isUnavailable: false };
  const load = async (): Promise<MeetingTrackerState> => {
    if (access.isUnavailable) {
      throw new ApiError({ status: SERVICE_UNAVAILABLE_STATUS, responseText: CONNECTION_FAILED });
    }
    if (access.isDenied) {
      throw new Error(FORBIDDEN);
    }

    return state;
  };
  // A stable client mirrors the memoized production adapter; a new object each render would re-run the effect.
  const client: MeetingTrackerRealtimeClient = { getChannel: () => fake.channel };
  const view = renderHook(() =>
    useMeetingTracker({
      token: "session",
      meetingId: "first",
      workspaceId: "workspace",
      isEnabled: true,
      client,
      refreshAuth,
      load,
    }),
  );
  await act(async () => {});
  assert.deepEqual(view.result.current.data, state);
  access.isDenied = true;
  await act(async () => {
    fake.listeners.get("attached")?.();
  });
  assert.equal(view.result.current.data, null);
  assert.equal(view.result.current.hasError, true);
  access.isDenied = false;
  await act(async () => {
    fake.probe.message?.();
  });
  assert.deepEqual(view.result.current.data, state);
  access.isUnavailable = true;
  await act(async () => {
    fake.probe.message?.();
  });
  assert.equal(view.result.current.data, null);
  assert.equal(view.result.current.hasError, false);
  access.isUnavailable = false;
  await act(async () => {
    fake.probe.message?.();
  });
  assert.deepEqual(view.result.current.data, state);
  view.unmount();
  assert.equal(fake.listeners.size, 0);
  assert.equal(fake.probe.message, undefined);
});

void test("unchanged tracker responses retain the existing data reference", async () => {
  const fake = createFakeChannel();
  const client: MeetingTrackerRealtimeClient = { getChannel: () => fake.channel };
  const load = async (): Promise<MeetingTrackerState> => ({ ...state, items: [] });
  const view = renderHook(() =>
    useMeetingTracker({
      token: "session",
      meetingId: "first",
      workspaceId: "workspace",
      isEnabled: true,
      client,
      refreshAuth,
      load,
    }),
  );
  await act(async () => {});
  const initial = view.result.current.data;
  await act(async () => fake.probe.message?.());
  assert.equal(view.result.current.data, initial);
  view.unmount();
});
