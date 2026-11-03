import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BackgroundTransformer, ProcessorWrapper, type VideoTransformerInitOptions } from "@livekit/track-processors";
import type { LocalVideoTrack } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  GuardedBlurTransformer,
  isCameraBlurReady,
  setLocalVideoTrackBackgroundBlur,
  subscribeBackgroundBlur,
} from "../../../presentation/lib/background-blur";
import { MeetBackgroundTransformer } from "../../../presentation/lib/meet-blur/transformer";
import { MEETING_MEDIA_CONFIG } from "../../../presentation/lib/meeting-media-config";

GlobalRegistrator.register();
// Processing is stubbed in these tests; advertise the browser capabilities it needs.
Object.defineProperty(BackgroundTransformer, "isSupported", { configurable: true, get: () => true });
Object.defineProperty(ProcessorWrapper, "isSupported", { configurable: true, get: () => true });

const BLUR_UNSUPPORTED = "Background blur isn’t supported in this browser. Turn blur off to use your camera.";

const MODEL_UNAVAILABLE = "model unavailable";
function isFrame(value: object): value is VideoFrame {
  return "close" in value;
}
function frame(onClose = () => {}): VideoFrame {
  const value = { close: onClose };
  assert.ok(isFrame(value));

  return value;
}
function isInitOptions(value: object): value is VideoTransformerInitOptions {
  return "outputCanvas" in value;
}
function initOptions(): VideoTransformerInitOptions {
  const value = { outputCanvas: {}, inputElement: {} };
  assert.ok(isInitOptions(value));

  return value;
}
function isTrack(value: object): value is LocalVideoTrack {
  return "getProcessor" in value;
}
function mockTrack(value: object): LocalVideoTrack {
  assert.ok(isTrack(value));

  return value;
}
function sink(output: { frames: VideoFrame[] }): TransformStreamDefaultController<VideoFrame> {
  const captured = output;

  return {
    desiredSize: 1,
    enqueue: (value) => {
      if (value !== undefined) {
        captured.frames = [...captured.frames, value];
      }
    },
    error: () => {},
    terminate: () => {},
  };
}
function deferred() {
  const state: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve;
  });

  return {
    promise,
    resolve: () => {
      state.resolve?.();
    },
  };
}

void test("stock output stays hidden until a successfully processed frame, and never forwards raw output", async (t) => {
  t.mock.method(BackgroundTransformer.prototype, "init", async () => {});
  t.mock.method(BackgroundTransformer.prototype, "destroy", async () => {});
  const raw = frame();
  const blurred = frame();
  const state = { shouldProcess: false, isResolved: false, readiness: [] as boolean[] };
  t.mock.method(
    BackgroundTransformer.prototype,
    "transform",
    async function (
      this: BackgroundTransformer,
      input: VideoFrame,
      controller: TransformStreamDefaultController<VideoFrame>,
    ) {
      assert.equal(this.isFirstFrame, false);
      controller.enqueue(input);
      if (state.shouldProcess) {
        controller.enqueue(blurred);
        this.options.onFrameProcessed?.({ processingTimeMs: 1, segmentationTimeMs: 1, filterTimeMs: 0 });
      }
    },
  );
  const transformer = new GuardedBlurTransformer({
    options: { blurRadius: MEETING_MEDIA_CONFIG.blur.radius },
    onReady: (isReady) => {
      state.readiness = [...state.readiness, isReady];
    },
  });
  await transformer.init(initOptions());
  void (async () => {
    await transformer.ready;
    state.isResolved = true;
  })();
  const output = { frames: [] as VideoFrame[] };
  await transformer.transform(raw, sink(output));
  assert.equal(state.isResolved, false);
  assert.deepEqual(output.frames, []);
  state.shouldProcess = true;
  await transformer.transform(raw, sink(output));
  await transformer.ready;
  assert.deepEqual(output.frames, [blurred]);
  assert.deepEqual(state.readiness, [false, true]);
  await transformer.destroy();
});

void test("teardown rejects pending readiness and ignores late output", async (t) => {
  t.mock.method(BackgroundTransformer.prototype, "init", async () => {});
  t.mock.method(BackgroundTransformer.prototype, "destroy", async () => {});
  const pending = deferred();
  const state = { isClosed: false };
  const processed = frame(() => {
    state.isClosed = true;
  });
  t.mock.method(
    BackgroundTransformer.prototype,
    "transform",
    async function (
      this: BackgroundTransformer,
      _frame: VideoFrame,
      controller: TransformStreamDefaultController<VideoFrame>,
    ) {
      await pending.promise;
      controller.enqueue(processed);
      this.options.onFrameProcessed?.({ processingTimeMs: 1, segmentationTimeMs: 1, filterTimeMs: 0 });
    },
  );
  const transformer = new GuardedBlurTransformer({ options: {}, onReady: () => {} });
  await transformer.init(initOptions());
  const rejected = assert.rejects(transformer.ready, /stopped/);
  const output = { frames: [] as VideoFrame[] };
  const processing = transformer.transform(frame(), sink(output));
  await transformer.destroy();
  pending.resolve();
  await processing;
  await rejected;
  assert.deepEqual(output.frames, []);
  assert.equal(state.isClosed, true);
});

void test("custom blur drops frames while uninitialized instead of exposing the camera", () => {
  const transformer = new MeetBackgroundTransformer({});
  const state = { isClosed: false };
  const input = frame(() => {
    state.isClosed = true;
  });
  const output = { frames: [] as VideoFrame[] };
  transformer.transform(input, sink(output));
  assert.deepEqual(output.frames, []);
  assert.equal(state.isClosed, true);
});

void test("camera stays paused and hidden until processor attachment completes, then reuses it", async () => {
  const state: { calls: string[]; processor?: Parameters<LocalVideoTrack["setProcessor"]>[0] } = { calls: [] };
  const pending = deferred();
  const track = mockTrack({
    mediaStreamTrack: { readyState: "live" },
    getProcessor: () => state.processor,
    pauseUpstream: async () => {
      state.calls = [...state.calls, "pause"];
    },
    resumeUpstream: async () => {
      state.calls = [...state.calls, "resume"];
    },
    setProcessor: async (next: typeof state.processor) => {
      state.calls = [...state.calls, "attach"];
      state.processor = next;
      await pending.promise;
    },
    stopProcessor: async () => {
      state.processor = undefined;
    },
  });
  const enabling = setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(state.calls, ["pause", "attach"]);
  assert.equal(isCameraBlurReady(track), false);
  pending.resolve();
  await enabling;
  assert.deepEqual(state.calls, ["pause", "attach", "resume"]);
  assert.equal(isCameraBlurReady(track), true);
  await setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
  assert.deepEqual(state.calls, ["pause", "attach", "resume"]);
});

void test("blur initialization failure keeps output hidden and never resumes raw upstream", async () => {
  const state = { calls: [] as string[] };
  const track = mockTrack({
    getProcessor: () => undefined,
    pauseUpstream: async () => {
      state.calls = [...state.calls, "pause"];
    },
    resumeUpstream: async () => {
      state.calls = [...state.calls, "resume"];
    },
    setProcessor: async () => {
      throw new Error(MODEL_UNAVAILABLE);
    },
    mute: async () => {},
    stop: () => {
      state.calls = [...state.calls, "stop"];
    },
  });
  await assert.rejects(setLocalVideoTrackBackgroundBlur({ track, isEnabled: true }), /model unavailable/);
  assert.deepEqual(state.calls, ["pause"]);
  assert.equal(isCameraBlurReady(track), false);
});

void test("custom initialization rejection falls back before any video is exposed", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(MeetBackgroundTransformer, "isSupported");
  assert.ok(descriptor);
  Object.defineProperty(MeetBackgroundTransformer, "isSupported", { configurable: true, get: () => true });
  t.after(() => Object.defineProperty(MeetBackgroundTransformer, "isSupported", descriptor));
  t.mock.method(MeetBackgroundTransformer.prototype, "init", async () => {
    throw new Error(MODEL_UNAVAILABLE);
  });
  t.mock.method(BackgroundTransformer.prototype, "init", async () => {});
  t.mock.method(BackgroundTransformer.prototype, "destroy", async () => {});
  const processed = frame();
  t.mock.method(
    BackgroundTransformer.prototype,
    "transform",
    async function (
      this: BackgroundTransformer,
      _frame: VideoFrame,
      controller: TransformStreamDefaultController<VideoFrame>,
    ) {
      controller.enqueue(processed);
      this.options.onFrameProcessed?.({ processingTimeMs: 1, segmentationTimeMs: 1, filterTimeMs: 0 });
    },
  );
  const transformer = new GuardedBlurTransformer({ options: {}, onReady: () => {} });
  await transformer.init(initOptions());
  const output = { frames: [] as VideoFrame[] };
  await transformer.transform(frame(), sink(output));
  await transformer.ready;
  assert.deepEqual(output.frames, [processed]);
  await transformer.destroy();
});

void test("a stalled processor times out with camera output still hidden", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const state = { resumes: 0 };
  const track = mockTrack({
    getProcessor: () => undefined,
    pauseUpstream: async () => {},
    resumeUpstream: async () => {
      state.resumes += 1;
    },
    setProcessor: async () => pending.promise,
  });
  const enabling = setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
  const rejected = assert.rejects(enabling, /Background blur could not start/);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const timeoutMs = 15_000;
  t.mock.timers.tick(timeoutMs);
  await rejected;
  assert.equal(state.resumes, 0);
  assert.equal(isCameraBlurReady(track), false);
  pending.resolve();
});

void test("enabling blur after a queued disable preserves the latest choice", async () => {
  const state: { processor?: Parameters<LocalVideoTrack["setProcessor"]>[0]; rawRestores: number } = { rawRestores: 0 };
  const track = mockTrack({
    mediaStreamTrack: { readyState: "live" },
    getProcessor: () => state.processor,
    pauseUpstream: async () => {},
    resumeUpstream: async () => {},
    setProcessor: async (processor: Parameters<LocalVideoTrack["setProcessor"]>[0]) => {
      state.processor = processor;
    },
    stopProcessor: async () => {
      state.rawRestores += 1;
      state.processor = undefined;
    },
  });
  await setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
  const disabling = setLocalVideoTrackBackgroundBlur({ track, isEnabled: false });
  const enabling = setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
  await Promise.all([disabling, enabling]);
  assert.equal(state.rawRestores, 0, "superseded disable must not restore raw output");
  assert.ok(track.getProcessor(), "a ready processor cannot bypass an earlier queued disable");
});

void test("an in-progress disable cannot mark a newer blur request ready", async () => {
  const stopping = deferred();
  const stopStarted = deferred();
  const attaching = deferred();
  const attachStarted = deferred();
  const attachmentCount = { value: 0 };
  const state: {
    processor?: Parameters<LocalVideoTrack["setProcessor"]>[0];
    readiness: boolean[];
  } = {
    readiness: [],
  };
  const track = mockTrack({
    mediaStreamTrack: { readyState: "live" },
    getProcessor: () => state.processor,
    pauseUpstream: async () => {},
    resumeUpstream: async () => {},
    setProcessor: async (processor: Parameters<LocalVideoTrack["setProcessor"]>[0]) => {
      attachmentCount.value += 1;
      if (attachmentCount.value > 1) {
        attachStarted.resolve();
        await attaching.promise;
      }
      state.processor = processor;
    },
    stopProcessor: async () => {
      stopStarted.resolve();
      await stopping.promise;
      state.processor = undefined;
    },
  });
  await setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
  const disabling = setLocalVideoTrackBackgroundBlur({ track, isEnabled: false });
  await stopStarted.promise;
  const unsubscribe = subscribeBackgroundBlur(() => {
    state.readiness = [...state.readiness, isCameraBlurReady(track)];
  });
  const enabling = setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
  stopping.resolve();
  await attachStarted.promise;
  const interimReadiness = state.readiness;
  attaching.resolve();
  await Promise.all([disabling, enabling]);
  unsubscribe();
  assert.deepEqual(interimReadiness, [false], "keep the avatar visible until the replacement is ready");
  assert.equal(isCameraBlurReady(track), true);
});

void test("runtime fallback readiness waits for its first processed frame", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(MeetBackgroundTransformer, "isSupported");
  assert.ok(descriptor);
  Object.defineProperty(MeetBackgroundTransformer, "isSupported", { configurable: true, get: () => true });
  t.after(() => Object.defineProperty(MeetBackgroundTransformer, "isSupported", descriptor));
  const failure: { trigger?: (error: Error) => void } = {};
  t.mock.method(MeetBackgroundTransformer.prototype, "init", async function (this: MeetBackgroundTransformer) {
    const options = z.custom<{ onFatalError?: (error: Error) => void }>().parse(Reflect.get(this, "options"));
    failure.trigger = options.onFatalError;
    t.mock.method(this, "transform", (_frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) => {
      controller.enqueue(frame());
    });
  });
  t.mock.method(BackgroundTransformer.prototype, "init", async () => {});
  t.mock.method(BackgroundTransformer.prototype, "destroy", async () => {});
  t.mock.method(
    BackgroundTransformer.prototype,
    "transform",
    async function (
      this: BackgroundTransformer,
      _frame: VideoFrame,
      controller: TransformStreamDefaultController<VideoFrame>,
    ) {
      controller.enqueue(frame());
      this.options.onFrameProcessed?.({ processingTimeMs: 1, segmentationTimeMs: 1, filterTimeMs: 0 });
    },
  );
  const transformer = new GuardedBlurTransformer({ options: {}, onReady: () => {} });
  await transformer.init(initOptions());
  const output = { frames: [] as VideoFrame[] };
  await transformer.transform(frame(), sink(output));
  await transformer.ready;
  failure.trigger?.(new Error(MODEL_UNAVAILABLE));
  await transformer.transform(frame(), sink(output));
  const state = { isReady: false };
  void (async () => {
    await transformer.ready;
    state.isReady = true;
  })();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(state.isReady, false, "the original successful frame must not satisfy fallback readiness");
  await transformer.transform(frame(), sink(output));
  await transformer.ready;
  assert.equal(state.isReady, true);
  await transformer.destroy();
});

void test("unsupported blur fails before attachment and tells users how to enable the camera", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(BackgroundTransformer, "isSupported");
  assert.ok(descriptor);
  Object.defineProperty(BackgroundTransformer, "isSupported", { configurable: true, get: () => false });
  t.after(() => Object.defineProperty(BackgroundTransformer, "isSupported", descriptor));
  const track = mockTrack({
    getProcessor: () => undefined,
    pauseUpstream: async () => assert.fail("Unsupported blur must fail before touching the camera"),
    setProcessor: async () => assert.fail("Unsupported blur must not initialize a processor"),
  });
  await assert.rejects(setLocalVideoTrackBackgroundBlur({ track, isEnabled: true }), {
    message: BLUR_UNSUPPORTED,
  });
  await setLocalVideoTrackBackgroundBlur({ track, isEnabled: false });
});
