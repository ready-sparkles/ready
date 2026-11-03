import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, renderHook } from "@testing-library/react";
import type Ably from "ably";
import assert from "node:assert/strict";
import test from "node:test";

import { useAmbientContextRealtime } from "../../../presentation/hooks/use-ambient-context-realtime";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const meetingId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const INITIAL_READ_COUNT = 1;
const AFTER_RECONNECT_READ_COUNT = 2;
const AFTER_CONTINUITY_READ_COUNT = 3;
const AFTER_MESSAGE_READ_COUNT = 4;
const EVENT_VERSION = 1;
const SCOPE_KEY = "personbr:workspace";
const OCCURRED_AT = "2026-09-25T10:00:00Z";

function isFakeRealtimeClient(value: object): value is Ably.Realtime {
  return "channels" in value && "connection" in value;
}

function fakeRealtimeClient(value: object): Ably.Realtime {
  assert.ok(isFakeRealtimeClient(value));

  return value;
}

function fakeRealtime(attachment?: Promise<void>) {
  const channelListeners = new Set<(change: Ably.ChannelStateChange) => void>();
  const connectionListeners = new Set<() => void>();
  const messages = new Set<(message: { data?: unknown }) => void>();
  const channel = {
    state: "initialized",
    on: (listener: (change: Ably.ChannelStateChange) => void) => {
      channelListeners.add(listener);
    },
    off: (listener: (change: Ably.ChannelStateChange) => void) => {
      channelListeners.delete(listener);
    },
    subscribe: async (...subscriptionArgs: [string, (message: { data?: unknown }) => void]) => {
      const [_event, listener] = subscriptionArgs;
      messages.add(listener);
      await attachment;
      channel.state = "attached";
      channelListeners.forEach((handler) => {
        handler({
          current: "attached",
          previous: "attaching",
          /** @external Ably channel state wire field */ resumed: false,
        });
      });
    },
    unsubscribe: (...subscriptionArgs: [string, (message: { data?: unknown }) => void]) => {
      const [_event, listener] = subscriptionArgs;
      messages.delete(listener);
    },
  };
  const connection = {
    state: "connected",
    on: (listener: () => void) => {
      connectionListeners.add(listener);
    },
    off: (listener: () => void) => {
      connectionListeners.delete(listener);
    },
  };
  const client = fakeRealtimeClient({ channels: { get: () => channel }, connection });

  return { client, channel, connection, channelListeners, connectionListeners, messages };
}

void test("health requires both connection and channel; reconnection and lost continuity refresh immediately", async () => {
  const fake = fakeRealtime();
  const reads = { count: 0 };
  const refresh = async () => {
    reads.count += 1;
  };
  const input = {
    client: fake.client,
    isEnabled: true,
    meetingId,
    workspaceId,
    scopeKey: SCOPE_KEY,
    refreshAuth: async () => {},
    refresh,
  };
  const view = renderHook(() => useAmbientContextRealtime(input));
  assert.equal(view.result.current, false);
  await act(async () => {});
  assert.equal(view.result.current, true);
  assert.equal(reads.count, INITIAL_READ_COUNT);
  act(() => {
    fake.connection.state = "disconnected";
    fake.connectionListeners.forEach((listener) => {
      listener();
    });
  });
  assert.equal(view.result.current, false);
  act(() => {
    fake.connection.state = "connected";
    fake.connectionListeners.forEach((listener) => {
      listener();
    });
  });
  assert.equal(view.result.current, true);
  assert.equal(reads.count, AFTER_RECONNECT_READ_COUNT);
  act(() => {
    fake.channelListeners.forEach((listener) => {
      listener({ current: "attached", previous: "attached", resumed: false });
    });
  });
  assert.equal(reads.count, AFTER_CONTINUITY_READ_COUNT);
  act(() => {
    fake.messages.forEach((listener) => {
      listener({
        data: {
          version: EVENT_VERSION,
          eventId: workspaceId,
          meetingId,
          itemId: workspaceId,
          status: "ready",
          occurredAt: OCCURRED_AT,
        },
      });
    });
  });
  assert.equal(reads.count, AFTER_MESSAGE_READ_COUNT);
  view.unmount();
  assert.equal(fake.channelListeners.size, 0);
  assert.equal(fake.connectionListeners.size, 0);
  assert.equal(fake.messages.size, 0);
});

void test("unmount during subscription attachment removes listeners before and after completion", async () => {
  const attachment: { finish: () => void } = { finish: () => {} };
  const fake = fakeRealtime(
    new Promise<void>((resolve) => {
      attachment.finish = resolve;
    }),
  );
  const reads = { count: 0 };
  const view = renderHook(() =>
    useAmbientContextRealtime({
      client: fake.client,
      /** @external ambient context realtime hook contract */
      isEnabled: true,
      meetingId,
      workspaceId,
      scopeKey: SCOPE_KEY,
      refreshAuth: async () => {},
      refresh: async () => {
        reads.count += 1;
      },
    }),
  );
  await act(async () => {});
  assert.equal(fake.messages.size, 1);
  assert.equal(view.result.current, false);
  view.unmount();
  assert.equal(fake.messages.size, 0);
  await act(async () => {
    attachment.finish();
  });
  assert.equal(fake.messages.size, 0);
  assert.equal(fake.channelListeners.size, 0);
  assert.equal(fake.connectionListeners.size, 0);
  assert.equal(reads.count, 0);
});
