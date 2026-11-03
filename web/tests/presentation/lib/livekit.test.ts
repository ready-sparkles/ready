import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BackgroundTransformer, ProcessorWrapper } from "@livekit/track-processors";
import { type LocalParticipant, type LocalTrack, LocalVideoTrack } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";

import { setLocalVideoTrackBackgroundBlur } from "../../../presentation/lib/background-blur";
import {
  cancelMeetingCameraStart,
  enableMeetingCameraWithFallback,
  isMeetingCameraStarting,
  MeetingCameraFallbackError,
  MeetingCameraStartCancelledError,
  publishMeetingCamera,
  setMeetingCameraBlurPreference,
} from "../../../presentation/lib/livekit";

type CameraParticipant = Pick<LocalParticipant, "setCameraEnabled">;

GlobalRegistrator.register();
// Processing is stubbed in these tests; advertise the browser capabilities it needs.
Object.defineProperty(BackgroundTransformer, "isSupported", { configurable: true, get: () => true });
Object.defineProperty(ProcessorWrapper, "isSupported", { configurable: true, get: () => true });

const MESSAGE_SELECTED_CAMERA_DISAPPEARED = "selected camera disappeared";
const MESSAGE_REQUESTED_DEVICE_NOT_FOUND = "Requested device not found";
const MESSAGE_PERMISSION_DENIED = "Permission denied";
const MESSAGE_CAMERA_IN_USE = "Camera is already in use";
const MESSAGE_REMEMBERED_CAMERA_DISAPPEARED = "remembered camera disappeared";
const MESSAGE_DEFAULT_CAMERA_BUSY = "default camera is busy";

const ERROR_NAME_NOT_FOUND = "NotFoundError";
const ERROR_NAME_DEVICES_NOT_FOUND = "DevicesNotFoundError";
const ERROR_NAME_OVERCONSTRAINED = "OverconstrainedError";
const ERROR_NAME_NOT_ALLOWED = "NotAllowedError";
const ERROR_NAME_NOT_READABLE = "NotReadableError";

const TEST_VALUE_2 = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLocalTrackFixture(value: unknown): value is LocalTrack {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.kind === "string" &&
    "mediaStreamTrack" in value &&
    typeof value.getProcessor === "function" &&
    typeof value.stopProcessor === "function"
  );
}

function createCameraParticipant(
  onEnable: (input: { deviceId?: string; callIndex: number }) => void | Promise<void>,
): CameraParticipant {
  const callState = { index: 0 };

  const participant: CameraParticipant = {
    async setCameraEnabled(...args: Parameters<CameraParticipant["setCameraEnabled"]>) {
      void args[0];
      const currentCall = callState.index;
      callState.index += 1;
      const deviceId = args[1]?.deviceId;
      await onEnable({ deviceId: typeof deviceId === "string" ? deviceId : undefined, callIndex: currentCall });

      return undefined;
    },
  };

  return participant;
}

void test("camera enable retries the browser default when a selected device is unavailable", async () => {
  const calls: { values: (string | undefined)[] } = { values: [] };
  const unavailable = Object.assign(new Error(MESSAGE_SELECTED_CAMERA_DISAPPEARED), {
    name: ERROR_NAME_NOT_FOUND,
  });
  const participant = createCameraParticipant(({ deviceId, callIndex }) => {
    calls.values = [...calls.values, deviceId];
    if (callIndex === 0) {
      throw unavailable;
    }
  });

  const result = await enableMeetingCameraWithFallback(participant, "remembered-camera");

  assert.deepEqual(calls.values, ["remembered-camera", undefined]);
  assert.equal(result.recoveredWithDefaultDevice, true);
  assert.equal(result.firstError, unavailable);
});

void test("camera enable recognizes the legacy missing-device error name", async () => {
  const attempts = { count: 0 };
  const participant = createCameraParticipant(() => {
    attempts.count += 1;
    if (attempts.count === 1) {
      throw Object.assign(new Error(MESSAGE_SELECTED_CAMERA_DISAPPEARED), {
        name: ERROR_NAME_DEVICES_NOT_FOUND,
      });
    }
  });

  const result = await enableMeetingCameraWithFallback(participant, "remembered-camera");

  assert.equal(attempts.count, TEST_VALUE_2);
  assert.equal(result.recoveredWithDefaultDevice, true);
});

void test("camera enable retries the browser default when a stale device constraint fails", async () => {
  const calls: { values: (string | undefined)[] } = { values: [] };
  const staleConstraint = Object.assign(new Error(MESSAGE_REQUESTED_DEVICE_NOT_FOUND), {
    name: ERROR_NAME_OVERCONSTRAINED,
  });
  const participant = createCameraParticipant(({ deviceId, callIndex }) => {
    calls.values = [...calls.values, deviceId];
    if (callIndex === 0) {
      throw staleConstraint;
    }
  });

  const result = await enableMeetingCameraWithFallback(participant, "stale-camera");

  assert.deepEqual(calls.values, ["stale-camera", undefined]);
  assert.equal(result.recoveredWithDefaultDevice, true);
  assert.equal(result.firstError, staleConstraint);
});

void test("camera enable does not repeat a denied permission prompt", async () => {
  const attempts = { count: 0 };
  const denied = Object.assign(new Error(MESSAGE_PERMISSION_DENIED), { name: ERROR_NAME_NOT_ALLOWED });
  const participant = createCameraParticipant(() => {
    attempts.count += 1;
    throw denied;
  });

  await assert.rejects(enableMeetingCameraWithFallback(participant, "remembered-camera"), denied);
  assert.equal(attempts.count, 1);
});

void test("camera enable does not switch devices when the selected camera is busy", async () => {
  const attempts = { count: 0 };
  const busy = Object.assign(new Error(MESSAGE_CAMERA_IN_USE), {
    name: ERROR_NAME_NOT_READABLE,
  });
  const participant = createCameraParticipant(() => {
    attempts.count += 1;
    throw busy;
  });

  await assert.rejects(enableMeetingCameraWithFallback(participant, "remembered-camera"), busy);
  assert.equal(attempts.count, 1);
});

void test("camera enable preserves the selected-device failure when the default also fails", async () => {
  const selectedError = Object.assign(new Error(MESSAGE_REMEMBERED_CAMERA_DISAPPEARED), {
    name: ERROR_NAME_NOT_FOUND,
  });
  const fallbackError = Object.assign(new Error(MESSAGE_DEFAULT_CAMERA_BUSY), {
    name: ERROR_NAME_NOT_READABLE,
  });
  const failureState = { values: [selectedError, fallbackError], index: 0 };
  const participant = createCameraParticipant(() => {
    const error = failureState.values[failureState.index] ?? fallbackError;
    failureState.index += 1;
    throw error;
  });

  await assert.rejects(enableMeetingCameraWithFallback(participant, "remembered-camera"), (error: unknown) => {
    assert.ok(error instanceof MeetingCameraFallbackError);
    assert.equal(error.name, ERROR_NAME_NOT_FOUND);
    assert.equal(error.message, selectedError.message);
    assert.equal(error.cause, selectedError);
    assert.equal(error.firstError, selectedError);
    assert.equal(error.fallbackError, fallbackError);

    return true;
  });
});

function isCameraPublishParticipant(value: object): value is LocalParticipant {
  return "publishTrack" in value;
}

void test("camera publication waits for blur readiness and cancellation prevents late publication", async () => {
  const state: {
    release?: () => void;
    calls: string[];
    processor?: Parameters<LocalVideoTrack["setProcessor"]>[0];
  } = { calls: [] };
  const wait = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const track: unknown = Object.create(
    LocalVideoTrack.prototype,
    Object.getOwnPropertyDescriptors({
      kind: "video",
      mediaStreamTrack: { readyState: "live" },
      getProcessor: () => state.processor,
      setProcessor: async (processor: typeof state.processor) => {
        state.processor = processor;
        await wait;
      },
      stopProcessor: async () => {},
      pauseUpstream: async () => {},
      resumeUpstream: async () => {},
      stop: () => {
        state.calls = [...state.calls, "stop"];
      },
    }),
  );
  assert.ok(isLocalTrackFixture(track));
  const participant = {
    publishTrack: async () => {
      state.calls = [...state.calls, "publish"];

      return {};
    },
  };
  assert.ok(isCameraPublishParticipant(participant));
  setMeetingCameraBlurPreference(participant, Promise.resolve(true));
  const publication = publishMeetingCamera(participant, track);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(isMeetingCameraStarting(participant), true);
  assert.equal(state.calls.length, 0);
  cancelMeetingCameraStart(participant);
  state.release?.();
  await assert.rejects(publication, MeetingCameraStartCancelledError);
  assert.equal(state.calls.includes("publish"), false);
  assert.equal(isMeetingCameraStarting(participant), false);
});

void test("a newer waiting-room blur choice wins over a pending older preference before publication", async () => {
  const state: { resolve?: (isEnabled: boolean) => void; calls: string[] } = { calls: [] };
  const older = new Promise<boolean>((resolve) => {
    state.resolve = resolve;
  });
  const track: unknown = Object.create(
    LocalVideoTrack.prototype,
    Object.getOwnPropertyDescriptors({
      kind: "video",
      mediaStreamTrack: { readyState: "live" },
      getProcessor: () => undefined,
      setProcessor: async () => {
        state.calls = [...state.calls, "blur"];
      },
      stopProcessor: async () => {},
      pauseUpstream: async () => {},
      resumeUpstream: async () => {},
      stop: () => {},
    }),
  );
  assert.ok(isLocalTrackFixture(track));
  const participant = {
    publishTrack: async () => {
      state.calls = [...state.calls, "publish"];

      return {};
    },
  };
  assert.ok(isCameraPublishParticipant(participant));
  setMeetingCameraBlurPreference(participant, older);
  const publication = publishMeetingCamera(participant, track);
  setMeetingCameraBlurPreference(participant, Promise.resolve(true));
  state.resolve?.(false);
  await publication;
  assert.deepEqual(state.calls, ["blur", "publish"]);
});

void test("published microphone remains controllable while the camera is starting, including after mute", async () => {
  const { isMeetingMicrophoneControlDisabled } = await import("../../../presentation/lib/livekit");
  const state = { isPublished: false, isMuted: false };
  const participant = {
    publishTrack: async () => ({}),
    getTrackPublication: () => (state.isPublished ? { isMuted: state.isMuted } : undefined),
  };
  assert.ok(isCameraPublishParticipant(participant));
  const input = { room: { localParticipant: participant }, isBusy: true };
  assert.equal(isMeetingMicrophoneControlDisabled(input), true);
  state.isPublished = true;
  assert.equal(isMeetingMicrophoneControlDisabled(input), false);
  state.isMuted = true;
  assert.equal(isMeetingMicrophoneControlDisabled(input), false);
  assert.equal(isMeetingMicrophoneControlDisabled({ room: null, isBusy: false }), true);
});

void test("publishing a prepared waiting-room camera reuses its blur processor", async () => {
  const state: {
    processor?: Parameters<LocalVideoTrack["setProcessor"]>[0];
    calls: string[];
  } = { calls: [] };
  const track: unknown = Object.create(
    LocalVideoTrack.prototype,
    Object.getOwnPropertyDescriptors({
      kind: "video",
      mediaStreamTrack: { readyState: "live" },
      getProcessor: () => state.processor,
      setProcessor: async (processor: Parameters<LocalVideoTrack["setProcessor"]>[0]) => {
        state.processor = processor;
        state.calls = [...state.calls, "prepare"];
      },
      stopProcessor: async () => {
        state.calls = [...state.calls, "stopProcessor"];
      },
      pauseUpstream: async () => {},
      resumeUpstream: async () => {},
      stop: () => {
        state.calls = [...state.calls, "stop"];
      },
    }),
  );
  assert.ok(track instanceof LocalVideoTrack);
  await setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
  const preparedProcessor = state.processor;
  assert.ok(preparedProcessor);
  const participant = {
    publishTrack: async (publishedTrack: LocalTrack) => {
      assert.equal(publishedTrack, track);
      assert.equal(publishedTrack.getProcessor(), preparedProcessor);
      state.calls = [...state.calls, "publish"];

      return {};
    },
  };
  assert.ok(isCameraPublishParticipant(participant));
  setMeetingCameraBlurPreference(participant, Promise.resolve(true));
  await publishMeetingCamera(participant, track);
  assert.deepEqual(state.calls, ["prepare", "publish"]);
  assert.equal(track.getProcessor(), preparedProcessor);
});
