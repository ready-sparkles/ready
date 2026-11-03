import { type LocalTrackPublication, type Room, RoomEvent } from "livekit-client";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { disconnectAndStopRoomMedia, MEETING_DISCONNECT_TIMEOUT_MS } from "../../../presentation/lib/meeting-exit";

const DEVICE_LOCK_ERROR_MESSAGE = "Must not wait on device locks";
const UNPUBLISH_ERROR_MESSAGE = "Must not wait on unpublish";
const LATE_SDK_FAILURE_MESSAGE = "late SDK failure";
const DETACHED_ELEMENT_ERROR_MESSAGE = "detached element";
const WRITABLE_CONTROL_CLOSED_MESSAGE = "writableControl already closed";
const SDK_FAILURE_MESSAGE = "SDK failure";
const EXPECTED_CAMERA_TRACK_ERROR = "Expected camera track";
const EXPECTED_EMITTING_ROOM_ERROR = "Expected emitting room";
const OUTPUT_STOPPED_EVENT = "output stopped";
const LOCAL_DETACHED_EVENT = "local detached";
const TRACK_STOPPED_EVENT = "track stopped";
const REMOTE_DETACHED_EVENT = "remote detached";
const DISCONNECT_EVENT = "disconnect";

type EventRecorder = {
  append: (message: string) => void;
  snapshot: () => string[];
  reset: () => void;
};

function createEventRecorder(): EventRecorder {
  const bag = { values: [] as string[] };

  return {
    append: (message: string) => {
      bag.values = [...bag.values, message];
    },
    snapshot: () => bag.values,
    reset: () => {
      bag.values = [];
    },
  };
}

function fakeTrack(input: { recorder: EventRecorder; label?: string }) {
  const label = input.label ?? "";

  return {
    mediaStreamTrack: { stop: () => input.recorder.append(`${OUTPUT_STOPPED_EVENT}${label}`) },
    detach: () => input.recorder.append(`${LOCAL_DETACHED_EVENT}${label}`),
    stop: () => input.recorder.append(`${TRACK_STOPPED_EVENT}${label}`),
  };
}

function isFakePublication(value: object): value is LocalTrackPublication {
  return "track" in value;
}

function fakePublication(value: object): LocalTrackPublication {
  assert.ok(isFakePublication(value));

  return value;
}

function isEmittingRoom(value: unknown): value is Room {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "emit") === "function";
}

function fakeRoom(input: { disconnect: () => Promise<void>; recorder: EventRecorder }): Room {
  const track = fakeTrack({ recorder: input.recorder });
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const on = (...onArgs: [string, (...args: unknown[]) => void]) => {
    const [event, listener] = onArgs;
    listeners.set(`${event}`, listener);
  };
  const emit = (...emitArgs: [string, ...unknown[]]) => {
    const [event, ...args] = emitArgs;
    const handler = listeners.get(`${event}`);
    if (handler !== undefined) {
      handler(...args);
    }
  };

  const room = {
    on,
    emit,
    localParticipant: {
      trackPublications: new Map([["camera", { track }]]),
      setCameraEnabled: () => {
        throw new Error(DEVICE_LOCK_ERROR_MESSAGE);
      },
      setMicrophoneEnabled: () => {
        throw new Error(DEVICE_LOCK_ERROR_MESSAGE);
      },
      unpublishTrack: () => {
        throw new Error(UNPUBLISH_ERROR_MESSAGE);
      },
    },
    remoteParticipants: new Map([
      [
        "remote",
        {
          trackPublications: new Map([
            [
              "audio",
              {
                track: { detach: () => input.recorder.append(REMOTE_DETACHED_EVENT) },
              },
            ],
          ]),
        },
      ],
    ]),
    disconnect: () => {
      input.recorder.append(DISCONNECT_EVENT);

      return input.disconnect();
    },
  };

  if (!isEmittingRoom(room)) {
    throw new Error(EXPECTED_EMITTING_ROOM_ERROR);
  }

  return room;
}

void test("media stops synchronously and departure is bounded when SDK disconnect stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const recorder = createEventRecorder();
  const rejectState: { reject?: (error: Error) => void } = {};
  const room = fakeRoom({
    disconnect: () =>
      new Promise<void>((_, fail) => {
        rejectState.reject = fail;
      }),
    recorder,
  });
  const leaving = disconnectAndStopRoomMedia(room);
  assert.deepEqual(recorder.snapshot(), [
    OUTPUT_STOPPED_EVENT,
    OUTPUT_STOPPED_EVENT,
    LOCAL_DETACHED_EVENT,
    TRACK_STOPPED_EVENT,
    REMOTE_DETACHED_EVENT,
    DISCONNECT_EVENT,
  ]);
  const eventsBeforeDuplicate = recorder.snapshot();
  const duplicate = disconnectAndStopRoomMedia(room);
  assert.deepEqual(recorder.snapshot(), eventsBeforeDuplicate, "duplicate cleanup shares the same attempt");
  const finishState = { isFinished: false };
  const trackLeavingCompletion = async () => {
    await leaving;
    finishState.isFinished = true;
  };
  void trackLeavingCompletion();
  t.mock.timers.tick(MEETING_DISCONNECT_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(finishState.isFinished, false);
  t.mock.timers.tick(1);
  await Promise.all([leaving, duplicate]);
  assert.equal(finishState.isFinished, true);
  rejectState.reject?.(new Error(LATE_SDK_FAILURE_MESSAGE));
  await trackLeavingCompletion();
});

class CaptureTrack {
  /** @external stopped */
  public isStopped = false;
  stop(): void {
    this.isStopped = true;
  }
}

function useCaptureTrackGlobal(t: TestContext): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "MediaStreamTrack");
  Object.defineProperty(globalThis, "MediaStreamTrack", { configurable: true, value: CaptureTrack });
  t.after(() => {
    if (original) {
      Object.defineProperty(globalThis, "MediaStreamTrack", original);
    } else {
      Reflect.deleteProperty(globalThis, "MediaStreamTrack");
    }
  });
}

void test("raw camera and processed output are both stopped even if detachment fails", async (t) => {
  useCaptureTrackGlobal(t);
  const source = new CaptureTrack();
  const recorder = createEventRecorder();
  const room = fakeRoom({ disconnect: async () => {}, recorder });
  const publication = room.localParticipant.trackPublications.get("camera");
  const track = publication?.track;
  if (track === undefined) {
    assert.fail(EXPECTED_CAMERA_TRACK_ERROR);
  }
  Object.assign(track, {
    getProcessor: () => ({ source }),
    detach: () => {
      throw new Error(DETACHED_ELEMENT_ERROR_MESSAGE);
    },
  });
  await disconnectAndStopRoomMedia(room);
  assert.equal(source.isStopped, true);
  assert.deepEqual(recorder.snapshot(), [
    OUTPUT_STOPPED_EVENT,
    TRACK_STOPPED_EVENT,
    REMOTE_DETACHED_EVENT,
    DISCONNECT_EVENT,
  ]);
});

void test("processor teardown starts while the source is live and its failure is handled", async (t) => {
  useCaptureTrackGlobal(t);
  const unhandledRecorder = createEventRecorder();
  const onUnhandled = (reason: unknown) => {
    unhandledRecorder.append(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => {
    process.off("unhandledRejection", onUnhandled);
  });
  const source = new CaptureTrack();
  const recorder = createEventRecorder();
  const destroyState = { calls: 0 };
  const processor = {
    source,
    destroy: () => {
      destroyState.calls += 1;
      recorder.append(`processor destroyed (source live: ${!source.isStopped})`);

      return destroyState.calls === 1 ? Promise.reject(new Error(WRITABLE_CONTROL_CLOSED_MESSAGE)) : Promise.resolve();
    },
  };
  const room = fakeRoom({ disconnect: async () => {}, recorder });
  const publication = room.localParticipant.trackPublications.get("camera");
  const track = publication?.track;
  if (track === undefined) {
    assert.fail(EXPECTED_CAMERA_TRACK_ERROR);
  }
  Object.assign(track, {
    getProcessor: () => processor,
    stop: () => {
      recorder.append(TRACK_STOPPED_EVENT);
      void processor.destroy();
    },
  });
  await disconnectAndStopRoomMedia(room);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(recorder.snapshot()[0], "processor destroyed (source live: true)");
  assert.equal(source.isStopped, true);
  assert.deepEqual(unhandledRecorder.snapshot(), []);
});

function runDisconnectFailureTest(isSynchronous: boolean): void {
  void test(`disconnect failure settles cleanup (synchronous: ${isSynchronous})`, async () => {
    const room = fakeRoom({
      disconnect: () => {
        if (isSynchronous) {
          throw new Error(SDK_FAILURE_MESSAGE);
        }

        return Promise.reject(new Error(SDK_FAILURE_MESSAGE));
      },
      recorder: createEventRecorder(),
    });
    await disconnectAndStopRoomMedia(room);
    await disconnectAndStopRoomMedia(null);
  });
}

runDisconnectFailureTest(false);
runDisconnectFailureTest(true);

void test("a camera or microphone published after cleanup starts is stopped on arrival", async () => {
  const recorder = createEventRecorder();
  const finishState: { finish?: () => void } = {};
  const room = fakeRoom({
    disconnect: () =>
      new Promise<void>((resolve) => {
        finishState.finish = resolve;
      }),
    recorder,
  });
  const leaving = disconnectAndStopRoomMedia(room);
  recorder.reset();
  room.emit(
    RoomEvent.LocalTrackPublished,
    fakePublication({ track: fakeTrack({ recorder, label: " (late)" }) }),
    room.localParticipant,
  );
  assert.deepEqual(recorder.snapshot(), [
    `${OUTPUT_STOPPED_EVENT} (late)`,
    `${OUTPUT_STOPPED_EVENT} (late)`,
    `${LOCAL_DETACHED_EVENT} (late)`,
    `${TRACK_STOPPED_EVENT} (late)`,
  ]);
  finishState.finish?.();
  await leaving;
});
