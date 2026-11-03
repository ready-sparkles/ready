import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BackgroundTransformer, ProcessorWrapper } from "@livekit/track-processors";
import { type LocalParticipant, LocalVideoTrack } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  cancelMeetingCameraStart,
  enableMeetingCameraWithFallback,
  getMeetingCameraTrack,
  isMeetingCameraStarting,
  MeetingCameraStartCancelledError,
  setMeetingCameraBlurPreference,
} from "../../../presentation/lib/livekit";

GlobalRegistrator.register();
// Processing is stubbed in these tests; advertise the browser capabilities it needs.
Object.defineProperty(BackgroundTransformer, "isSupported", { configurable: true, get: () => true });
Object.defineProperty(ProcessorWrapper, "isSupported", { configurable: true, get: () => true });

Object.defineProperty(navigator, "mediaDevices", {
  value: { getUserMedia: async () => new MediaStream() },
  configurable: true,
});
const CAMERA_WIDTH = 640;
const CAPTURE_ATTEMPTS_WITH_FALLBACK = 2;
const CAMERA_HEIGHT = 480;
const TEST_TIMEOUT_MS = 2_000;

void test("blur selected during camera acquisition is applied before publication", async (t) => {
  const state: {
    release?: (stream: MediaStream) => void;
    calls: string[];
    processor?: Parameters<LocalVideoTrack["setProcessor"]>[0];
  } = { calls: [] };
  t.mock.method(
    navigator.mediaDevices,
    "getUserMedia",
    () =>
      new Promise<MediaStream>((resolve) => {
        state.release = resolve;
      }),
  );
  t.mock.method(
    LocalVideoTrack.prototype,
    "setProcessor",
    async (processor: Parameters<LocalVideoTrack["setProcessor"]>[0]) => {
      state.processor = processor;
      state.calls = [...state.calls, "blur"];
    },
  );
  t.mock.method(LocalVideoTrack.prototype, "getProcessor", () => state.processor);
  t.mock.method(LocalVideoTrack.prototype, "pauseUpstream", async () => {});
  t.mock.method(LocalVideoTrack.prototype, "resumeUpstream", async () => {});
  const capture = z.custom<MediaStreamTrack>().parse(
    Object.assign(new EventTarget(), {
      id: "camera",
      kind: "video",
      readyState: "live",
      /** @external MediaStreamTrack contract */
      enabled: true,
      getConstraints: () => ({}),
      getSettings: () => ({ width: CAMERA_WIDTH, height: CAMERA_HEIGHT }),
      applyConstraints: async () => {},
      stop: () => {},
    }),
  );
  const participant = z.custom<LocalParticipant>().parse({
    getTrackPublication: () => undefined,
    unpublishTrack: async () => {},
    publishTrack: async (track: LocalVideoTrack) => {
      assert.equal(
        getMeetingCameraTrack(participant),
        track,
        "blur toggles can find a camera before publication finishes",
      );
      state.calls = [...state.calls, "publish"];
      t.after(() => track.stop());

      return {};
    },
    setCameraEnabled: async () => {
      state.calls = [...state.calls, "raw"];
    },
  });
  setMeetingCameraBlurPreference(participant, Promise.resolve(false));
  const starting = enableMeetingCameraWithFallback(participant);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(isMeetingCameraStarting(participant), true);
  setMeetingCameraBlurPreference(participant, Promise.resolve(true));
  const stream = z.custom<MediaStream>().parse({ getTracks: () => [capture] });
  state.release?.(stream);
  await starting;
  assert.deepEqual(state.calls, ["blur", "publish"]);
});

void test(
  "cancellation during acquisition prevents default-device recovery",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state: { reject?: (error: Error) => void; calls: number } = { calls: 0 };
    t.mock.method(navigator.mediaDevices, "getUserMedia", () => {
      state.calls += 1;

      return new Promise<MediaStream>((_, reject) => {
        state.reject = reject;
      });
    });
    const participant = z.custom<LocalParticipant>().parse({
      getTrackPublication: () => undefined,
      unpublishTrack: async () => {},
      publishTrack: async () => ({}),
      setCameraEnabled: async () => {},
    });
    setMeetingCameraBlurPreference(participant, Promise.resolve(true));
    const starting = enableMeetingCameraWithFallback(participant, "selected-camera");
    const rejected = assert.rejects(starting, MeetingCameraStartCancelledError);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    cancelMeetingCameraStart(participant);
    state.reject?.(new DOMException("Camera removed", "NotFoundError"));
    await rejected;
    assert.equal(state.calls, 1);
  },
);

void test("selected-device capture does not repeat a denied permission request", async (t) => {
  const state = { calls: 0 };
  const denied = new DOMException("Permission denied", "NotAllowedError");
  t.mock.method(navigator.mediaDevices, "getUserMedia", async () => {
    state.calls += 1;
    throw denied;
  });
  const participant = z.custom<LocalParticipant>().parse({
    getTrackPublication: () => undefined,
    unpublishTrack: async () => {},
    publishTrack: async () => ({}),
    setCameraEnabled: async () => {},
  });
  setMeetingCameraBlurPreference(participant, Promise.resolve(true));
  await assert.rejects(enableMeetingCameraWithFallback(participant, "selected-camera"), denied);
  assert.equal(state.calls, 1);
});

void test("cancelling while the old camera is unpublished never opens a new device", async (t) => {
  const state: { release?: () => void; captures: number } = { captures: 0 };
  const unpublishing = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  t.mock.method(navigator.mediaDevices, "getUserMedia", async () => {
    state.captures += 1;

    return new MediaStream();
  });
  const participant = z.custom<LocalParticipant>().parse({
    getTrackPublication: () => ({ track: { stop: () => {} } }),
    unpublishTrack: async () => unpublishing,
    publishTrack: async () => ({}),
    setCameraEnabled: async () => {},
  });
  const starting = enableMeetingCameraWithFallback(participant);
  const rejected = assert.rejects(starting, MeetingCameraStartCancelledError);
  cancelMeetingCameraStart(participant);
  state.release?.();
  await rejected;
  assert.equal(state.captures, 0);
});

["Starting videoinput failed", "Timeout starting video source"].forEach((message) => {
  void test(`hardware AbortError remains reportable: ${message}`, async (t) => {
    const state = { captures: 0, publications: 0 };
    const failure = new DOMException(message, "AbortError");
    t.mock.method(navigator.mediaDevices, "getUserMedia", async () => {
      state.captures += 1;
      throw failure;
    });
    const participant = z.custom<LocalParticipant>().parse({
      getTrackPublication: () => undefined,
      unpublishTrack: async () => {},
      publishTrack: async () => {
        state.publications += 1;

        return {};
      },
      setCameraEnabled: async () => {},
    });
    setMeetingCameraBlurPreference(participant, Promise.resolve(true));
    await assert.rejects(enableMeetingCameraWithFallback(participant, "selected-camera"), (error: unknown) => {
      assert.equal(error, failure);
      assert.equal(error instanceof MeetingCameraStartCancelledError, false);

      return true;
    });
    assert.equal(state.captures, 1);
    assert.equal(state.publications, 0);
    assert.equal(isMeetingCameraStarting(participant), false);
  });
});

void test("cancelling default-camera fallback preserves cancellation identity", async (t) => {
  const state: { captures: number; reject?: (error: Error) => void } = { captures: 0 };
  t.mock.method(navigator.mediaDevices, "getUserMedia", async () => {
    state.captures += 1;
    if (state.captures === 1) {
      throw new DOMException("Saved camera missing", "NotFoundError");
    }

    return new Promise<MediaStream>((_, reject) => {
      state.reject = reject;
    });
  });
  const participant = z.custom<LocalParticipant>().parse({
    getTrackPublication: () => undefined,
    unpublishTrack: async () => {},
    publishTrack: async () => assert.fail("Cancelled camera must not publish"),
    setCameraEnabled: async () => {},
  });
  const starting = enableMeetingCameraWithFallback(participant, "missing-camera");
  const rejected = assert.rejects(starting, MeetingCameraStartCancelledError);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(state.captures, CAPTURE_ATTEMPTS_WITH_FALLBACK);
  assert.ok(state.reject);
  cancelMeetingCameraStart(participant);
  state.reject(new DOMException("Device request cancelled", "AbortError"));
  await rejected;
  assert.equal(isMeetingCameraStarting(participant), false);
});
