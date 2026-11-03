import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, renderHook } from "@testing-library/react";
import { type Room, RoomEvent } from "livekit-client";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";

import type { MeetingDetailPayload } from "../../../domain/types";
import { useLiveMeetingDetailRefresh } from "../../../presentation/hooks/use-live-meeting-detail-refresh";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const ACTIVE_MS = 1500;
const HAR_WINDOW_MS = 43_000;
const SPEECH_SETTLE_MS = 12_000;
const QUIET_WINDOW_MS = 30_000;
const MINUTE_MS = 60_000;
const SECOND_READ = 2;
const THIRD_READ = 3;
const OFFLINE_MESSAGE = "Offline";

function fakeClock(t: TestContext) {
  const state = { now: 0, nextId: 0 };
  const timers = new Map<number, { at: number; run: () => void }>();
  t.mock.method(performance, "now", () => state.now);
  t.mock.method(window, "setTimeout", (run: () => void, ms = 0) => {
    state.nextId += 1;
    timers.set(state.nextId, { at: state.now + ms, run });

    return state.nextId;
  });
  t.mock.method(window, "clearTimeout", (id: number) => timers.delete(id));

  return {
    timers,
    async advance(ms: number) {
      const end = state.now + ms;
      const runNext = async (): Promise<void> => {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)
          .at(0);
        if (next === undefined) {
          return;
        }
        state.now = next[1].at;
        timers.delete(next[0]);
        await act(async () => next[1].run());
        await runNext();
      };
      await runNext();
      const clockState = state;
      clockState.now = end;
    },
  };
}

function fakeRoom() {
  const emitter = new EventEmitter();
  const room = Object.assign(emitter, { activeSpeakers: [] as unknown[] });
  const isRoom = (value: object): value is Room => "activeSpeakers" in value && "on" in value;
  assert.ok(isRoom(room));

  return { room, emitter };
}

const detailFixture = {
  meetingRuntime: { activeHumanParticipants: [] },
  transcriptSegments: [],
};
function detailForTest(): MeetingDetailPayload {
  const isDetail = (value: object): value is MeetingDetailPayload =>
    "meetingRuntime" in value && "transcriptSegments" in value;
  assert.ok(isDetail(detailFixture));

  return detailFixture;
}
const detail = detailForTest();

void test("idle call makes one detail read in the HAR's 43-second window; activity restores fast polling", async (t) => {
  const clock = fakeClock(t);
  const { room, emitter } = fakeRoom();
  const reads = { count: 0 };
  const load = async () => {
    reads.count += 1;

    return detail;
  };
  const participants = t.mock.fn();
  const segments = t.mock.fn();
  const view = renderHook(() =>
    useLiveMeetingDetailRefresh({
      token: "session",
      meetingId: "meeting",
      isEnabled: true,
      room,
      finalTranscriptKey: "",
      load,
      setActiveHumanParticipants: participants,
      setLiveTranscriptSegments: segments,
    }),
  );
  await act(async () => {});
  await clock.advance(HAR_WINDOW_MS);
  assert.equal(reads.count, 1);
  assert.equal(participants.mock.callCount(), 1);
  emitter.emit(RoomEvent.ActiveSpeakersChanged, []);
  await clock.advance(ACTIVE_MS);
  assert.equal(reads.count, SECOND_READ);
  await clock.advance(ACTIVE_MS);
  assert.equal(reads.count, THIRD_READ);
  await clock.advance(SPEECH_SETTLE_MS);
  const afterSpeech = reads.count;
  await clock.advance(QUIET_WINDOW_MS);
  assert.equal(reads.count, afterSpeech);
  view.unmount();
  assert.equal(clock.timers.size, 0);
  assert.equal(room.eventNames().length, 0);
});

void test("roster changes and reconnects request fresh data without overlapping a slow request", async (t) => {
  const clock = fakeClock(t);
  const { room, emitter } = fakeRoom();
  const reads = { count: 0, signal: undefined as AbortSignal | undefined, finish: () => {} };
  const load = async (input: { options?: { signal?: AbortSignal } }) => {
    reads.count += 1;
    reads.signal = input.options?.signal;
    await new Promise<void>((resolve) => {
      reads.finish = resolve;
    });

    return detail;
  };
  const segments = t.mock.fn();
  const view = renderHook(() =>
    useLiveMeetingDetailRefresh({
      token: "session",
      meetingId: "meeting",
      isEnabled: true,
      room,
      finalTranscriptKey: "",
      load,
      setActiveHumanParticipants: () => {},
      setLiveTranscriptSegments: segments,
    }),
  );
  emitter.emit(RoomEvent.ParticipantConnected);
  emitter.emit(RoomEvent.Reconnected);
  await clock.advance(ACTIVE_MS);
  assert.equal(reads.count, 1);
  await act(async () => reads.finish());
  await clock.advance(ACTIVE_MS);
  assert.equal(reads.count, SECOND_READ);
  view.unmount();
  assert.equal(reads.signal?.aborted, true);
  const countAtUnmount = segments.mock.callCount();
  await act(async () => reads.finish());
  assert.equal(segments.mock.callCount(), countAtUnmount);
  assert.equal(clock.timers.size, 0);
});

void test("failed reads retry quickly and leaving stops requests", async (t) => {
  const clock = fakeClock(t);
  const { room } = fakeRoom();
  const reads = { count: 0 };
  const load = async () => {
    reads.count += 1;
    if (reads.count === 1) {
      throw new Error(OFFLINE_MESSAGE);
    }

    return detail;
  };
  const segments = t.mock.fn();
  const setParticipants = () => {};
  const view = renderHook(
    ({ isEnabled }) =>
      useLiveMeetingDetailRefresh({
        token: "session",
        meetingId: "meeting",
        isEnabled,
        room,
        finalTranscriptKey: "",
        load,
        setActiveHumanParticipants: setParticipants,
        setLiveTranscriptSegments: segments,
      }),
    { initialProps: { isEnabled: true } },
  );
  await act(async () => {});
  await clock.advance(ACTIVE_MS);
  assert.equal(reads.count, SECOND_READ);
  assert.equal(segments.mock.callCount(), 1);
  view.rerender({ isEnabled: false });
  await clock.advance(MINUTE_MS);
  assert.equal(reads.count, SECOND_READ);
  view.unmount();
});

void test("a finalized caption refreshes persisted detail without restarting on unrelated renders", async (t) => {
  const clock = fakeClock(t);
  const { room } = fakeRoom();
  const reads = { count: 0 };
  const load = async () => {
    reads.count += 1;

    return detail;
  };
  const participants = t.mock.fn();
  const segments = t.mock.fn();
  const view = renderHook(
    ({ finalTranscriptKey }) =>
      useLiveMeetingDetailRefresh({
        token: "session",
        meetingId: "meeting",
        isEnabled: true,
        room,
        finalTranscriptKey,
        load,
        setActiveHumanParticipants: participants,
        setLiveTranscriptSegments: segments,
      }),
    { initialProps: { finalTranscriptKey: "" } },
  );
  await act(async () => {});
  await clock.advance(HAR_WINDOW_MS);
  assert.equal(reads.count, 1);
  view.rerender({ finalTranscriptKey: "segment:Hello" });
  await clock.advance(ACTIVE_MS);
  assert.equal(reads.count, SECOND_READ);
  view.rerender({ finalTranscriptKey: "segment:Hello" });
  await act(async () => {});
  assert.equal(reads.count, SECOND_READ);
  await clock.advance(ACTIVE_MS);
  assert.equal(reads.count, THIRD_READ);
  view.unmount();
});
