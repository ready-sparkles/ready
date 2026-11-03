import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BackgroundTransformer, ProcessorWrapper } from "@livekit/track-processors";
import { LocalVideoTrack, Track } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { isCameraBlurReady, setLocalVideoTrackBackgroundBlur } from "../../../presentation/lib/background-blur";

GlobalRegistrator.register();
// Processing is stubbed in these tests; advertise the browser capabilities it needs.
Object.defineProperty(BackgroundTransformer, "isSupported", { configurable: true, get: () => true });
Object.defineProperty(ProcessorWrapper, "isSupported", { configurable: true, get: () => true });

const TEST_WIDTH = 640;
const TEST_HEIGHT = 480;
const START_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 2_000;

void test(
  "timeout releases the real LiveKit attachment lock and discards late wrapper initialization",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const loading: { resolve?: () => void } = {};
    const model = new Promise<void>((resolve) => {
      loading.resolve = resolve;
    });
    const state = { hasEntered: false, destroyed: 0, started: 0 };
    // Stub browser resource allocation, retaining the installed wrapper's init/destroy lifecycle.
    const prototype = z
      .custom<{
        setup: () => Promise<void>;
        initStreamProcessorPath: () => void;
      }>()
      .parse(ProcessorWrapper.prototype);
    t.mock.method(prototype, "setup", async function (this: ProcessorWrapper<Record<string, unknown>>) {
      this.canvas = document.createElement("canvas");
    });
    t.mock.method(prototype, "initStreamProcessorPath", () => {
      state.started += 1;
    });
    t.mock.method(BackgroundTransformer.prototype, "init", async () => {
      state.hasEntered = true;
      await model;
    });
    t.mock.method(BackgroundTransformer.prototype, "destroy", async () => {
      state.destroyed += 1;
    });
    const capture = z.custom<MediaStreamTrack>().parse(
      Object.assign(new EventTarget(), {
        id: "camera",
        kind: "video",
        readyState: "live",
        /** @external MediaStreamTrack contract */
        enabled: true,
        getConstraints: () => ({}),
        getSettings: () => ({ width: TEST_WIDTH, height: TEST_HEIGHT }),
        applyConstraints: async () => {},
        stop: () => {},
      }),
    );
    const track = new LocalVideoTrack(capture);
    t.after(() => track.stop());
    const starting = setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
    const rejected = assert.rejects(starting, /could not start/);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(state.hasEntered, true);
    t.mock.timers.tick(START_TIMEOUT_MS);
    await rejected;
    assert.equal(isCameraBlurReady(track), false);
    // stopProcessor takes the same SDK lock as setProcessor: this must complete
    // before the blocked model resolves, otherwise the recovery UI is still stuck.
    await setLocalVideoTrackBackgroundBlur({ track, isEnabled: false });
    assert.equal(isCameraBlurReady(track), true);
    loading.resolve?.();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(track.getProcessor(), undefined);
    assert.equal(state.started, 1, "late SDK startup is drained without attaching to the camera");
    assert.ok(state.destroyed > 0);
    assert.equal(isCameraBlurReady(track), true, "late teardown cannot overwrite the user's blur-off choice");
    track.stop();
  },
);

void test(
  "camera-device processor restart has a deadline and discards late output",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const loading: { resolve?: () => void } = {};
    const model = new Promise<void>((resolve) => {
      loading.resolve = resolve;
    });
    const prototype = z
      .custom<{ setup: () => Promise<void>; initStreamProcessorPath: () => void }>()
      .parse(ProcessorWrapper.prototype);
    t.mock.method(prototype, "setup", async function (this: ProcessorWrapper<Record<string, unknown>>) {
      this.canvas = document.createElement("canvas");
    });
    t.mock.method(prototype, "initStreamProcessorPath", () => {});
    t.mock.method(BackgroundTransformer.prototype, "init", async () => model);
    t.mock.method(BackgroundTransformer.prototype, "destroy", async () => {});
    const state: { processor?: Parameters<LocalVideoTrack["setProcessor"]>[0] } = {};
    const capture = z.custom<MediaStreamTrack>().parse({ readyState: "live" });
    const track = z.custom<LocalVideoTrack>().parse({
      mediaStreamTrack: capture,
      getProcessor: () => state.processor,
      setProcessor: async (processor: typeof state.processor) => {
        state.processor = processor;
      },
      pauseUpstream: async () => {},
      resumeUpstream: async () => {},
    });
    await setLocalVideoTrackBackgroundBlur({ track, isEnabled: true });
    const processor = state.processor;
    assert.ok(processor);
    t.after(() => processor.destroy());
    const restarting = processor.restart({ track: capture, kind: Track.Kind.Video });
    const rejected = assert.rejects(restarting, /could not start/);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    t.mock.timers.tick(START_TIMEOUT_MS);
    await rejected;
    assert.equal(isCameraBlurReady(track), false);
    assert.equal(processor.processedTrack, undefined);
    assert.equal(Reflect.get(processor, "source"), capture, "capture constraints must still target the source camera");
    loading.resolve?.();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(isCameraBlurReady(track), false);
  },
);
