import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MeetingAmbientContextItem } from "@readymeet/shared";
import { act, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { useCallback, useEffect, useState } from "react";

import { ambientContextPillPresentation } from "../../../domain/ambient-context-view";
import { createAmbientContextItem } from "../../../domain/testing/ambient-context-fixture";
import {
  AMBIENT_CONTEXT_LOADING_LIMIT_MS,
  useAmbientContextRecovery,
} from "../../../presentation/hooks/use-ambient-context-recovery";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const start = Date.parse("2026-09-25T10:00:00Z");
const pending = createAmbientContextItem();
const ready = { ...pending, status: "ready" as const, summary: "Product planning software." };
const CLOSED_PANEL_POLL_MS = 45_000;
const MIN_CLOSED_PANEL_REQUESTS = 3;
const ONE_MS = 1;
const MENTION_COUNT_REPEAT = 2;
const SPEECH_METER_FRAME_COUNT = 100;
const SPEECH_METER_FRAME_MS = 60;
const SINGLE_LOAD_COUNT = 1;
const ZERO_CANCEL_COUNT = 0;
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60_000;
const HOUR_MS = MINUTES_PER_HOUR * MS_PER_MINUTE;
const MINUTE_MS = MS_PER_MINUTE;
const SINGLE_ITEM_COUNT = 1;
const ZERO_ITEM_COUNT = 0;
const INITIAL_REFRESH_COUNT = 1;
const SAFETY_POLL_TICKS = 44;
const SECOND_MS = 1000;
const AFTER_SLOW_POLL_REFRESH_COUNT = 2;
const AFTER_UNHEALTHY_REFRESH_COUNT = 3;
const AFTER_RECOVERY_POLL_REFRESH_COUNT = 4;
const RECOVERY_POLL_MS = 5000;
const ACTIVE_TIMER_COUNT = 2;
const ZERO_TIMER_COUNT = 0;
const ZERO_REQUEST_COUNT = 0;
const ONE_REQUEST_COUNT = 1;
const ONE_SECOND_BEFORE_LIMIT_MS = 1000;

function fakeClock(t: TestContext) {
  const clock = { now: start, nextId: 0 };
  const timers = new Map<number, { callback: () => void; at: number; repeat: number }>();
  t.mock.method(Date, "now", () => clock.now);
  t.mock.method(performance, "now", () => clock.now - start);
  t.mock.method(window, "setTimeout", (callback: () => void, delay = 0) => {
    clock.nextId += 1;
    timers.set(clock.nextId, { callback, at: clock.now + delay, repeat: 0 });

    return clock.nextId;
  });
  t.mock.method(window, "setInterval", (callback: () => void, delay = 0) => {
    clock.nextId += 1;
    timers.set(clock.nextId, { callback, at: clock.now + delay, repeat: delay });

    return clock.nextId;
  });
  t.mock.method(window, "clearTimeout", (id: number) => {
    timers.delete(id);
  });
  t.mock.method(window, "clearInterval", (id: number) => {
    timers.delete(id);
  });

  return {
    timers,
    async advance(ms: number) {
      clock.now += ms;
      await act(async () => {
        [...timers].forEach(([id, timer]) => {
          if (!timers.has(id) || timer.at > clock.now) {
            return;
          }
          if (timer.repeat !== 0) {
            timers.set(id, { ...timer, at: clock.now + timer.repeat });
          } else {
            timers.delete(id);
          }
          timer.callback();
        });
      });
    },
  };
}

void test("closed panel polling recovers missed creation and completion events", async (t) => {
  const clock = fakeClock(t);
  const server = { items: [] as MeetingAmbientContextItem[] };
  const requests = { count: 0 };
  const view = renderHook(() => {
    const [items, setItems] = useState<MeetingAmbientContextItem[]>([]);
    const refresh = useCallback(async () => {
      requests.count += 1;
      setItems(server.items);
    }, []);

    return useAmbientContextRecovery({
      items,
      /** @external ambient context recovery hook contract */
      enabled: true,
      /** @external ambient context recovery hook contract */
      realtimeHealthy: true,
      refresh,
    });
  });
  server.items = [pending];
  await clock.advance(CLOSED_PANEL_POLL_MS);
  assert.equal(ambientContextPillPresentation(view.result.current.pillItems)?.phase, "loading");
  server.items = [ready];
  await clock.advance(CLOSED_PANEL_POLL_MS);
  assert.equal(ambientContextPillPresentation(view.result.current.pillItems)?.phase, "result");
  assert.ok(requests.count >= MIN_CLOSED_PANEL_REQUESTS);
  view.unmount();
  assert.equal(clock.timers.size, 0);
});

void test("a hung fetch cannot prevent expiry; repeat mentions do not extend loading; late results return", async (t) => {
  const clock = fakeClock(t);
  const older = {
    ...ready,
    id: "older",
    displayName: "Ramp",
    lastMentionedAt: new Date(start - ONE_SECOND_BEFORE_LIMIT_MS).toISOString(),
  };
  const refresh = () => new Promise<void>(() => {});
  const view = renderHook(
    ({ items }) =>
      useAmbientContextRecovery({
        items,
        /** @external ambient context recovery hook contract */
        enabled: true,
        /** @external ambient context recovery hook contract */
        realtimeHealthy: true,
        refresh,
      }),
    { initialProps: { items: [pending, older] } },
  );
  await clock.advance(AMBIENT_CONTEXT_LOADING_LIMIT_MS - 1);
  const repeated = {
    ...pending,
    status: "researching" as const,
    mentionCount: MENTION_COUNT_REPEAT,
    researchStartedAt: new Date(Date.now()).toISOString(),
    updatedAt: new Date(Date.now()).toISOString(),
  };
  view.rerender({ items: [repeated, older] });
  assert.equal(ambientContextPillPresentation(view.result.current.pillItems)?.subjectId, pending.id);
  await clock.advance(ONE_MS);
  assert.deepEqual(view.result.current.pillItems, [older]);
  assert.equal(view.result.current.expiredItemIds.has(pending.id), true);
  // Expiration is presentation metadata, not a mutation of the server/history item.
  assert.equal(repeated.status, "researching");
  assert.equal(ambientContextPillPresentation(view.result.current.pillItems)?.subjectId, older.id);
  view.rerender({ items: [ready, older] });
  assert.equal(view.result.current.expiredItemIds.has(ready.id), false);
  assert.equal(ambientContextPillPresentation(view.result.current.pillItems)?.subjectId, ready.id);
  assert.equal(ambientContextPillPresentation(view.result.current.pillItems)?.phase, "result");
  view.unmount();
});

void test("speech-meter renders preserve array identity and do not cancel an image-loading effect", async (t) => {
  const clock = fakeClock(t);
  const items = [pending, { ...ready, id: "older" }];
  const imageState = { loads: 0, cancelledLoads: 0, isShown: false, finish: () => {} };
  const refresh = async () => {};
  const view = renderHook(() => {
    const recovery = useAmbientContextRecovery({
      items,
      /** @external ambient context recovery hook contract */
      enabled: true,
      /** @external ambient context recovery hook contract */
      realtimeHealthy: true,
      refresh,
    });
    useEffect(() => {
      imageState.loads += 1;
      const cancellation = { isCancelled: false };
      imageState.finish = () => {
        if (!cancellation.isCancelled) {
          imageState.isShown = true;
        }
      };

      return () => {
        cancellation.isCancelled = true;
        imageState.cancelledLoads += 1;
      };
    }, [recovery.pillItems]);

    return recovery;
  });
  const first = view.result.current.pillItems;
  await Array.from({ length: SPEECH_METER_FRAME_COUNT }).reduce(async (previous) => {
    await previous;
    await clock.advance(SPEECH_METER_FRAME_MS);
    view.rerender();
    assert.equal(view.result.current.pillItems, first);
  }, Promise.resolve());
  assert.equal(imageState.loads, SINGLE_LOAD_COUNT);
  assert.equal(imageState.cancelledLoads, ZERO_CANCEL_COUNT);
  imageState.finish();
  assert.equal(imageState.isShown, true);
  await clock.advance(AMBIENT_CONTEXT_LOADING_LIMIT_MS);
  const expired = view.result.current.pillItems;
  await clock.advance(SPEECH_METER_FRAME_MS);
  view.rerender();
  assert.equal(view.result.current.pillItems, expired);
  view.unmount();
});

void test("wall-clock skew and clock adjustments cannot prematurely expire a pill", async (t) => {
  const clock = fakeClock(t);
  t.mock.method(Date, "now", () => start + HOUR_MS);
  const items = [{ ...pending, status: "researching" as const, researchStartedAt: pending.createdAt }];
  const view = renderHook(() =>
    useAmbientContextRecovery({
      items,
      enabled: true,
      realtimeHealthy: true,
      refresh: async () => {},
    }),
  );
  assert.equal(view.result.current.pillItems.length, SINGLE_ITEM_COUNT);
  await clock.advance(MINUTE_MS);
  t.mock.method(Date, "now", () => start - HOUR_MS);
  view.rerender();
  assert.equal(view.result.current.pillItems.length, SINGLE_ITEM_COUNT);
  await clock.advance(MINUTE_MS);
  assert.equal(view.result.current.pillItems.length, ZERO_ITEM_COUNT);
  view.unmount();
});

void test("healthy realtime uses only a slow safety poll, and disconnection enables faster recovery", async (t) => {
  const clock = fakeClock(t);
  const items = [pending];
  const requests = { count: 0 };
  const refresh = async () => {
    requests.count += 1;
  };
  const view = renderHook(
    ({ isRealtimeHealthy }) =>
      useAmbientContextRecovery({
        items,
        /** @external ambient context recovery hook contract */
        enabled: true,
        /** @external ambient context recovery hook contract */
        realtimeHealthy: isRealtimeHealthy,
        refresh,
      }),
    { initialProps: { isRealtimeHealthy: true } },
  );
  assert.equal(requests.count, INITIAL_REFRESH_COUNT);
  await Array.from({ length: SAFETY_POLL_TICKS }).reduce(async (previous) => {
    await previous;
    await clock.advance(SECOND_MS);
  }, Promise.resolve());
  assert.equal(requests.count, INITIAL_REFRESH_COUNT);
  await clock.advance(SECOND_MS);
  assert.equal(requests.count, AFTER_SLOW_POLL_REFRESH_COUNT);
  view.rerender({ isRealtimeHealthy: false });
  assert.equal(requests.count, AFTER_UNHEALTHY_REFRESH_COUNT);
  await clock.advance(RECOVERY_POLL_MS);
  assert.equal(requests.count, AFTER_RECOVERY_POLL_REFRESH_COUNT);
  view.rerender({ isRealtimeHealthy: true });
  const recoveredRequests = requests.count;
  await clock.advance(RECOVERY_POLL_MS);
  assert.equal(requests.count, recoveredRequests);
  view.unmount();
});

void test("loading gets a local deadline and an observed retry gets a fresh deadline", async (t) => {
  const clock = fakeClock(t);
  await clock.advance(AMBIENT_CONTEXT_LOADING_LIMIT_MS);
  const view = renderHook(
    ({ items }) =>
      useAmbientContextRecovery({
        items,
        /** @external ambient context recovery hook contract */
        enabled: true,
        /** @external ambient context recovery hook contract */
        realtimeHealthy: true,
        refresh: async () => {},
      }),
    { initialProps: { items: [pending] } },
  );
  assert.equal(view.result.current.pillItems.length, 1);
  await clock.advance(AMBIENT_CONTEXT_LOADING_LIMIT_MS);
  assert.deepEqual(view.result.current.pillItems, []);
  view.rerender({ items: [{ ...pending, status: "failed" }] });
  view.rerender({
    items: [{ ...pending, researchStartedAt: pending.createdAt, updatedAt: new Date(Date.now()).toISOString() }],
  });
  assert.equal(ambientContextPillPresentation(view.result.current.pillItems)?.phase, "loading");
  await clock.advance(AMBIENT_CONTEXT_LOADING_LIMIT_MS);
  assert.deepEqual(view.result.current.pillItems, []);
  view.unmount();
});

void test("disabled recovery makes no requests and clears timers on leaving a meeting", (t) => {
  const clock = fakeClock(t);
  const requests = { count: 0 };
  const refresh = async () => {
    requests.count += 1;
  };
  const view = renderHook(
    ({ isRecoveryEnabled }) =>
      useAmbientContextRecovery({
        items: [pending],
        /** @external ambient context recovery hook contract */
        enabled: isRecoveryEnabled,
        /** @external ambient context recovery hook contract */
        realtimeHealthy: true,
        refresh,
      }),
    { initialProps: { isRecoveryEnabled: false } },
  );
  assert.equal(requests.count, ZERO_REQUEST_COUNT);
  assert.equal(clock.timers.size, ZERO_TIMER_COUNT);
  view.rerender({ isRecoveryEnabled: true });
  assert.equal(requests.count, ONE_REQUEST_COUNT);
  assert.equal(clock.timers.size, ACTIVE_TIMER_COUNT);
  view.rerender({ isRecoveryEnabled: false });
  assert.equal(clock.timers.size, ZERO_TIMER_COUNT);
  view.unmount();
});

void test("a successful explicit retry restarts the local wait even when the server reuses the same running job", async (t) => {
  const clock = fakeClock(t);
  const items = [pending];
  const view = renderHook(() =>
    useAmbientContextRecovery({
      items,
      enabled: true,
      realtimeHealthy: true,
      refresh: async () => {},
    }),
  );
  await clock.advance(AMBIENT_CONTEXT_LOADING_LIMIT_MS);
  assert.equal(view.result.current.expiredItemIds.has(pending.id), true);
  act(() => view.result.current.restartWait(pending.id));
  assert.equal(view.result.current.expiredItemIds.has(pending.id), false);
  assert.equal(view.result.current.pillItems.length, 1);
  await clock.advance(AMBIENT_CONTEXT_LOADING_LIMIT_MS);
  assert.equal(view.result.current.pillItems.length, 0);
  view.unmount();
});
