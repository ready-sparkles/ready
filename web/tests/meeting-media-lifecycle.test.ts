import { BackgroundTransformer } from "@livekit/track-processors";
import type { MediaQualityDiagnostic, ReceivedMediaQuality, SentMediaQuality } from "@readymeet/shared";
import {
  ConnectionState,
  type LocalTrackPublication,
  LocalVideoTrack,
  RemoteVideoTrack,
  type Room,
  RoomEvent,
  Track,
  TrackEvent,
} from "livekit-client";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";

import {
  acquireMeetingMediaTracks,
  createMeetingRoom,
  prepareMeetingCameraForPublish,
} from "../presentation/lib/livekit";
import { MEETING_MEDIA_CONFIG as config } from "../presentation/lib/meeting-media-config";
import { startMeetingMediaDiagnostics } from "../presentation/lib/meeting-media-diagnostics";
import { selectMeetingMediaPolicy } from "../presentation/lib/meeting-media-policy";
import { getMeetingCaptureTrack } from "../presentation/lib/meeting-media-track";

const LIFECYCLE_FRAMES_DECODED_PER_MS = 0.03;

const TEST_VALUE_100 = 100;
const TEST_VALUE_1080 = 1080;
const TEST_VALUE_112000 = 112000;
const TEST_VALUE_1280 = 1280;
const TEST_VALUE_14 = 14;
const TEST_VALUE_15 = 15;
const TEST_VALUE_16 = 16;
const TEST_VALUE_1920 = 1920;
const TEST_VALUE_2 = 2;
const TEST_VALUE_20 = 20;
const TEST_VALUE_24 = 24;
const TEST_VALUE_25 = 25;
const TEST_VALUE_270 = 270;
const TEST_VALUE_3 = 3;
const TEST_VALUE_30 = 30;
const TEST_VALUE_4 = 4;
const TEST_VALUE_480 = 480;
const TEST_VALUE_5 = 5;
const TEST_VALUE_5000 = 5000;
const TEST_VALUE_6 = 6;
const TEST_VALUE_60000 = 60000;
const TEST_VALUE_720 = 720;

function requireValue<T>(value: T | null | undefined) {
  if (value === null || value === undefined) {
    throw new TypeError(String(value));
  }

  return value;
}

async function repeatTimerFlush(input: { count: number; advance: () => void; flush: () => Promise<void> }) {
  await Array.from({ length: input.count }, (_value, index) => index).reduce(async (previous) => {
    await previous;
    input.advance();
    await input.flush();
  }, Promise.resolve());
}

function replaceGlobal(input: { t: TestContext; key: string; value: unknown }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, input.key);
  Object.defineProperty(globalThis, input.key, { value: input.value, configurable: true, writable: true });
  input.t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, input.key, previous);
    } else {
      Reflect.deleteProperty(globalThis, input.key);
    }
  });
}

function isLifecycleTestRoom(value: unknown): value is Room {
  return (
    typeof value === "object" &&
    value !== null &&
    "localParticipant" in value &&
    "remoteParticipants" in value &&
    "state" in value
  );
}

function lifecycleTestRoom(value: object): Room {
  assert.ok(isLifecycleTestRoom(value));

  return value;
}

function isLifecycleLocalVideoTrack(value: unknown): value is LocalVideoTrack {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === LocalVideoTrack.prototype;
}

function createLifecycleLocalVideoTrack(): LocalVideoTrack {
  const track: unknown = Object.create(LocalVideoTrack.prototype);
  assert.ok(isLifecycleLocalVideoTrack(track));

  return track;
}

function isLifecycleRemoteVideoTrack(value: unknown): value is RemoteVideoTrack {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === RemoteVideoTrack.prototype;
}

function createLifecycleRemoteVideoTrack(): RemoteVideoTrack {
  const track: unknown = Object.create(RemoteVideoTrack.prototype);
  assert.ok(isLifecycleRemoteVideoTrack(track));

  return track;
}

function isSentMediaQuality(report: MediaQualityDiagnostic): report is SentMediaQuality {
  return report.direction === "sent";
}

function sentMediaQualityBatch(batch: MediaQualityDiagnostic[]): SentMediaQuality[] {
  return batch.filter(isSentMediaQuality);
}

function isReceivedMediaQuality(report: MediaQualityDiagnostic): report is ReceivedMediaQuality {
  return report.direction === "received";
}

function receivedMediaQualityBatch(batch: MediaQualityDiagnostic[]): ReceivedMediaQuality[] {
  return batch.filter(isReceivedMediaQuality);
}

function isLifecycleLocalTrackPublication(value: unknown): value is LocalTrackPublication {
  return typeof value === "object" && value !== null && "track" in value;
}

function lifecycleLocalTrackPublication(value: object): LocalTrackPublication {
  assert.ok(isLifecycleLocalTrackPublication(value));

  return value;
}

function isBlurProcessorVideoTrack(value: unknown): value is LocalVideoTrack {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "getProcessor" in value &&
    "setProcessor" in value &&
    typeof Reflect.get(value, "getProcessor") === "function" &&
    typeof Reflect.get(value, "setProcessor") === "function"
  );
}

function blurProcessorVideoTrack(value: object): LocalVideoTrack {
  // Define own properties so prototype getters such as mediaStreamTrack are shadowed, not invoked as setters.
  const track: unknown = Object.create(
    LocalVideoTrack.prototype,
    Object.fromEntries(Object.entries(value).map(([key, entry]: [string, unknown]) => [key, { value: entry }])),
  );
  assert.ok(isBlurProcessorVideoTrack(track));

  return track;
}

class CaptureTrack extends EventTarget {
  kind = "video";
  id = "working-camera";
  isTrackEnabled = true;
  get enabled() {
    return this.isTrackEnabled;
  }

  set enabled(isEnabled: boolean) {
    this.isTrackEnabled = isEnabled;
  }

  readyState = "live";
  constraints = { deviceId: "selected" };
  settings = { width: TEST_VALUE_1080, height: TEST_VALUE_1920, frameRate: TEST_VALUE_30, deviceId: "selected" };
  getSettings() {
    return this.settings;
  }

  getConstraints() {
    return this.constraints;
  }

  async applyConstraints() {
    throw new DOMException("unsupported cap", "OverconstrainedError");
  }

  stop() {
    this.readyState = "ended";
  }
}

class CaptureStream {
  constructor(private readonly tracks: CaptureTrack[]) {}
  getTracks() {
    return this.tracks;
  }
}

void test("prejoin acquisition and join reuse keep a working camera after cap rejection", async (t) => {
  t.mock.method(console, "warn", () => {});
  const raw = new CaptureTrack();
  const captures = { count: 0 };
  replaceGlobal({ t, key: "MediaStream", value: CaptureStream });
  replaceGlobal({
    t,
    key: "navigator",
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          captures.count += 1;

          return new CaptureStream([raw]);
        },
      },
    },
  });
  const acquired = await acquireMeetingMediaTracks();
  assert.equal(captures.count, 1);
  assert.equal(acquired.videoError, null);
  assert.equal(acquired.tracks.length, 1);
  const acquiredTrack = requireValue(acquired.tracks[0]);
  assert.equal(acquiredTrack.mediaStreamTrack, raw);
  assert.equal(raw.readyState, "live");
  const room = await createMeetingRoom({});
  await prepareMeetingCameraForPublish(room.localParticipant, acquiredTrack);
  assert.equal(captures.count, 1);
  assert.equal(requireValue(acquired.tracks[0]).mediaStreamTrack, raw);
  assert.equal(raw.readyState, "live");
  acquired.tracks.forEach((track) => {
    track.stop();
  });
  await room.disconnect();
});

void test("production CPU sampling uses one raw report per encoder at the slower cadence", async (t) => {
  const previousMode = Object.hasOwn(process.env, "NODE_ENV") ? process.env.NODE_ENV : undefined;
  Object.assign(process.env, { NODE_ENV: "production" });
  t.after(() => {
    if (previousMode === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      Object.assign(process.env, { NODE_ENV: previousMode });
    }
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls = { raw: 0, backup: 0, helper: 0, parameter: 0 };
  const track = createLifecycleLocalVideoTrack();
  Object.defineProperties(track, {
    isLocal: { value: true },
    isMuted: { value: false, writable: true },
    isUpstreamPaused: { value: false },
    mediaStreamTrack: { value: { readyState: "live" } },
    getSenderStats: {
      value: async () => {
        calls.helper += 1;
      },
    },
    getRTCStatsReport: {
      value: async () => {
        calls.raw += 1;

        return new Map();
      },
    },
    sender: {
      value: {
        getParameters: () => {
          calls.parameter += 1;

          return { encodings: [] };
        },
      },
    },
    simulcastCodecs: {
      value: new Map([
        [
          "vp8",
          {
            sender: {
              getStats: async () => {
                calls.backup += 1;

                return new Map();
              },
              getParameters: () => {
                calls.parameter += 1;

                return { encodings: [] };
              },
            },
          },
        ],
      ]),
    },
  });
  const roomState = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    localParticipant: {
      trackPublications: new Map([["camera", { track, source: Track.Source.Camera, trackSid: "camera" }]]),
    },
    remoteParticipants: { forEach: () => assert.fail("production must not sample receivers") },
  });
  const room = lifecycleTestRoom(roomState);
  const policy = await selectMeetingMediaPolicy();
  const stop = startMeetingMediaDiagnostics(room, policy);
  t.after(stop);
  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  await flush();
  assert.equal(calls.raw, 1);
  assert.equal(calls.backup, 1);
  assert.equal(calls.helper, 0);
  assert.equal(calls.parameter, 0);
  t.mock.timers.tick(config.diagnostics.productionIntervalMs - 1);
  await flush();
  assert.equal(calls.raw, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.raw, TEST_VALUE_2);
  track.isMuted = true;
  t.mock.timers.tick(config.diagnostics.productionIntervalMs);
  await flush();
  assert.equal(calls.raw, TEST_VALUE_2);
  room.emit(RoomEvent.Disconnected);
  track.isMuted = false;
  t.mock.timers.tick(config.diagnostics.productionIntervalMs);
  await flush();
  assert.equal(calls.raw, TEST_VALUE_2);
});

void test("stock blur fallback preserves native landscape and portrait output dimensions", async (t) => {
  class Frame {
    codedWidth: number;
    codedHeight: number;
    displayWidth: number;
    displayHeight: number;
    timestamp = 1;
    isClosed = false;
    constructor(source: { width: number; height: number }) {
      this.codedWidth = this.displayWidth = source.width;
      this.codedHeight = this.displayHeight = source.height;
    }

    close() {
      this.isClosed = true;
    }
  }
  replaceGlobal({ t, key: "VideoFrame", value: Frame });
  replaceGlobal({ t, key: "OffscreenCanvas", value: undefined }); // force stock fallback without custom WebGL pipeline
  const transformer = new BackgroundTransformer({ blurRadius: config.blur.radius });
  transformer.isFirstFrame = false;
  Object.defineProperty(transformer, "canvas", { value: { width: 1, height: 1 }, writable: true });
  const mockSegmentForVideo = (input: { frame: unknown; time: number; callback: (result: unknown) => void }) => {
    input.callback({ close: () => {} });
  };
  Object.defineProperty(transformer, "imageSegmenter", {
    value: {
      segmentForVideo(...segmentArgs: [unknown, number, (result: unknown) => void]) {
        const [frame, time, callback] = segmentArgs;
        mockSegmentForVideo({ frame, time, callback });
      },
    },
    writable: true,
  });
  function isLifecycleMockVideoFrame(value: object): value is VideoFrame {
    return (
      typeof Reflect.get(value, "displayWidth") === "number" && typeof Reflect.get(value, "displayHeight") === "number"
    );
  }

  const lifecycleVideoFrame = (input: { value: Frame }): VideoFrame => {
    assert.ok(isLifecycleMockVideoFrame(input.value));

    return input.value;
  };
  function isLifecycleTransformController(value: object): value is TransformStreamDefaultController<VideoFrame> {
    return typeof Reflect.get(value, "enqueue") === "function";
  }

  const lifecycleTransformController = (input: {
    enqueue: (frame: Frame) => void;
  }): TransformStreamDefaultController<VideoFrame> => {
    assert.ok(isLifecycleTransformController(input));

    return input;
  };
  await [
    { width: TEST_VALUE_1920, height: TEST_VALUE_1080 },
    { width: TEST_VALUE_1080, height: TEST_VALUE_1920 },
  ].reduce(async (previous, dimensions) => {
    await previous;
    const input = new Frame(dimensions);
    const captured: { frames: Frame[] } = { frames: [] };
    await transformer.transform(
      lifecycleVideoFrame({ value: input }),
      lifecycleTransformController({
        enqueue: (frame: Frame) => {
          captured.frames = [...captured.frames, frame];
        },
      }),
    );
    assert.equal(captured.frames.length, 1);
    const frame = requireValue(captured.frames[0]);
    assert.equal(frame.displayWidth, dimensions.width);
    assert.equal(frame.displayHeight, dimensions.height);
    assert.equal(input.isClosed, true);
  }, Promise.resolve());
});

void test("processed camera constraints and diagnostics resolve the original capture", (t) => {
  replaceGlobal({ t, key: "MediaStreamTrack", value: CaptureTrack });
  const original = new CaptureTrack();
  const output = new CaptureTrack();
  output.settings = { width: TEST_VALUE_1280, height: TEST_VALUE_720, frameRate: TEST_VALUE_30, deviceId: "processed" };
  const track = blurProcessorVideoTrack({
    kind: "video",
    mediaStreamTrack: output,
    getProcessor: () => ({ source: original }),
  });
  assert.equal(getMeetingCaptureTrack(track), original);
  assert.ok(output instanceof MediaStreamTrack);
  assert.equal(getMeetingCaptureTrack(output), output);
});

async function createProductionConstraintsHarness(t: TestContext) {
  const quality = { reason: "cpu" };
  const appliedState = { items: [] as MediaTrackConstraints[] };
  const capture = {
    readyState: "live",
    getSettings: () => ({ width: TEST_VALUE_1920, height: TEST_VALUE_1080, frameRate: TEST_VALUE_30 }),
    getConstraints: () =>
      appliedState.items.at(-1) ?? { deviceId: { exact: "selected-camera" }, frameRate: { max: TEST_VALUE_30 } },
    applyConstraints: async (value: MediaTrackConstraints) => {
      appliedState.items = [...appliedState.items, value];
    },
  };
  const track = createLifecycleLocalVideoTrack();
  Object.defineProperties(track, {
    isLocal: { value: true },
    isMuted: { value: false, writable: true },
    isUpstreamPaused: { value: false },
    mediaStreamTrack: { value: capture, writable: true },
    getProcessor: { value: () => undefined },
    getRTCStatsReport: {
      value: async () =>
        new Map([
          ["codec", { mimeType: "video/AV1" }],
          [
            "out",
            {
              id: "out",
              type: "outbound-rtp",
              kind: "video",
              frameWidth: TEST_VALUE_1920,
              frameHeight: TEST_VALUE_1080,
              framesPerSecond: TEST_VALUE_30,
              qualityLimitationReason: quality.reason,
              codecId: "codec",
              bytesSent: Date.now() * TEST_VALUE_100,
            },
          ],
        ]),
    },
    simulcastCodecs: { value: new Map() },
  });
  const roomState = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    localParticipant: {
      trackPublications: new Map([["camera", { track, source: Track.Source.Camera, trackSid: "camera" }]]),
    },
    remoteParticipants: new Map(),
  });
  const room = lifecycleTestRoom(roomState);
  const eventState = { items: [] as SentMediaQuality[] };
  const flushState = { items: [] as { size: number; isKeepalive: boolean }[] };
  const stop = startMeetingMediaDiagnostics(room, await selectMeetingMediaPolicy(), (batch, options) => {
    flushState.items = [...flushState.items, { size: batch.length, isKeepalive: options.keepalive }];
    eventState.items = [...eventState.items, ...sentMediaQualityBatch(batch)];
  });
  t.after(stop);
  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  const tick = async (count: number) => {
    await repeatTimerFlush({
      count,
      advance: () => {
        t.mock.timers.tick(TEST_VALUE_5000);
      },
      flush,
    });
  };

  return {
    quality,
    appliedState,
    capture,
    track,
    room,
    eventState,
    flushState,
    tick,
    flush,
  };
}

async function assertProductionConstraintsReductionPhase(input: {
  quality: { reason: string };
  appliedState: { items: MediaTrackConstraints[] };
  eventState: { items: SentMediaQuality[] };
  tick: (count: number) => Promise<void>;
  flush: () => Promise<void>;
}) {
  const { quality, appliedState, eventState, tick, flush } = input;
  await flush();
  await tick(TEST_VALUE_4);
  assert.equal(appliedState.items.length, 1);
  assert.deepEqual(requireValue(appliedState.items[0]).frameRate, { ideal: TEST_VALUE_20, max: TEST_VALUE_20 });
  assert.deepEqual(requireValue(appliedState.items[0]).deviceId, { exact: "selected-camera" });
  assert.equal(requireValue(eventState.items.at(-1)).action, "reduce");
  assert.equal(eventState.items.length, 1, "the adjustment flushes promptly; no empty first summary");
  quality.reason = "none";
  await tick(TEST_VALUE_25);
  assert.equal(appliedState.items.length, TEST_VALUE_2);
  assert.deepEqual(requireValue(appliedState.items[1]).frameRate, { max: TEST_VALUE_30 });
  assert.equal(requireValue(eventState.items.at(-1)).action, "recover");
  const reportedEvents = [...eventState.items];
  assert.ok(reportedEvents.length <= TEST_VALUE_5, "minute summaries plus adjustment events only");
  quality.reason = "cpu";
  await tick(TEST_VALUE_6);
  assert.equal(appliedState.items.length, TEST_VALUE_3);
}

async function assertProductionConstraintsReplacementPhase(input: {
  capture: {
    readyState: string;
    getSettings: () => { width: number; height: number; frameRate: number };
    getConstraints: () => MediaTrackConstraints;
    applyConstraints: (value: MediaTrackConstraints) => Promise<void>;
  };
  track: LocalVideoTrack;
  room: Room;
  appliedState: { items: MediaTrackConstraints[] };
  eventState: { items: SentMediaQuality[] };
  flushState: { items: { size: number; isKeepalive: boolean }[] };
  tick: (count: number) => Promise<void>;
}) {
  const { capture, track, room, appliedState, eventState, flushState, tick } = input;
  const replacementAppliedState = { items: [] as MediaTrackConstraints[] };
  const replacement = {
    ...capture,
    getSettings: () => ({ width: TEST_VALUE_1280, height: TEST_VALUE_720, frameRate: TEST_VALUE_24 }),
    getConstraints: () =>
      replacementAppliedState.items.at(-1) ?? {
        deviceId: { exact: "replacement-camera" },
        frameRate: { max: TEST_VALUE_24 },
      },
    applyConstraints: async (value: MediaTrackConstraints) => {
      replacementAppliedState.items = [...replacementAppliedState.items, value];
    },
  };
  Object.defineProperty(track, "mediaStreamTrack", { value: replacement, writable: true });
  await tick(TEST_VALUE_5);
  assert.equal(replacementAppliedState.items.length, 1);
  assert.deepEqual(requireValue(replacementAppliedState.items[0]).width, {
    ideal: TEST_VALUE_1280,
    max: TEST_VALUE_1280,
  });
  assert.deepEqual(requireValue(replacementAppliedState.items[0]).frameRate, {
    ideal: TEST_VALUE_20,
    max: TEST_VALUE_20,
  });
  assert.deepEqual(requireValue(replacementAppliedState.items[0]).deviceId, { exact: "replacement-camera" });
  assert.equal(requireValue(eventState.items.at(-1)).level, 1, "replacement camera starts with fresh control state");
  track.isMuted = true;
  await tick(TEST_VALUE_6);
  track.isMuted = false;
  await tick(TEST_VALUE_3);
  assert.equal(replacementAppliedState.items.length, 1, "muted time must not advance pressure window");
  room.emit(RoomEvent.Reconnecting);
  await tick(TEST_VALUE_3);
  assert.equal(replacementAppliedState.items.length, 1, "reconnect resets pressure observation");
  const flushedBeforeDisconnect = flushState.items.length;
  room.emit(RoomEvent.Disconnected);
  assert.ok(
    flushState.items.slice(flushedBeforeDisconnect).every((entry) => entry.isKeepalive),
    "disconnect flushes with keepalive",
  );
  assert.ok(flushState.items.every((entry) => entry.size <= TEST_VALUE_20));
  const flushedAtDisconnect = flushState.items.length;
  await tick(TEST_VALUE_6);
  assert.equal(replacementAppliedState.items.length, 1);
  assert.equal(appliedState.items.length, TEST_VALUE_3, "old capture must never be changed again");
  assert.equal(flushState.items.length, flushedAtDisconnect, "nothing reported after disconnect");
}

async function runProductionSamplingConstraintsTest(t: TestContext) {
  productionMode(t);
  const harness = await createProductionConstraintsHarness(t);
  await assertProductionConstraintsReductionPhase(harness);
  await assertProductionConstraintsReplacementPhase(harness);
}

void test("production sampling applies and recovers camera constraints with bounded health reporting", async (t) => {
  await runProductionSamplingConstraintsTest(t);
});

async function createProductionReceiverDiagnosticsHarness(t: TestContext) {
  const documentState = { visibilityState: "visible" };
  replaceGlobal({ t, key: "document", value: documentState });
  replaceGlobal({ t, key: "window", value: { innerWidth: TEST_VALUE_1920, innerHeight: TEST_VALUE_1080 } });
  replaceGlobal({
    t,
    key: "getComputedStyle",
    value: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  const calls = { count: 0 };
  const track = createLifecycleRemoteVideoTrack();
  Object.defineProperties(track, {
    isLocal: { value: false },
    isMuted: { value: false, writable: true },
    attachedElements: {
      value: [
        {
          isConnected: true,
          getBoundingClientRect: () => ({
            width: TEST_VALUE_1280,
            height: TEST_VALUE_720,
            top: 0,
            left: 0,
            right: TEST_VALUE_1280,
            bottom: TEST_VALUE_720,
          }),
        },
      ],
    },
    getRTCStatsReport: {
      value: async () => {
        calls.count += 1;

        return new Map([
          ["codec", { mimeType: "video/AV1" }],
          [
            "video",
            {
              id: "video",
              type: "inbound-rtp",
              kind: "video",
              codecId: "codec",
              frameWidth: TEST_VALUE_480,
              frameHeight: TEST_VALUE_270,
              bytesReceived: Date.now() * TEST_VALUE_14,
              framesDecoded: Date.now() * LIFECYCLE_FRAMES_DECODED_PER_MS,
              packetsReceived: Date.now(),
              packetsLost: 0,
            },
          ],
        ]);
      },
    },
  });
  const roomState = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    localParticipant: { trackPublications: new Map() },
    remoteParticipants: new Map([
      [
        "remote",
        { trackPublications: new Map([["camera", { track, source: Track.Source.Camera, trackSid: "TR_remote" }]]) },
      ],
    ]),
  });
  const room = lifecycleTestRoom(roomState);
  const reportState = { items: [] as ReceivedMediaQuality[] };
  const stop = startMeetingMediaDiagnostics(room, await selectMeetingMediaPolicy(), (batch) => {
    reportState.items = [...reportState.items, ...receivedMediaQualityBatch(batch)];
  });
  t.after(stop);
  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  return { documentState, calls, room, reportState, flush };
}

async function assertProductionReceiverDiagnosticsWarmup(input: {
  t: TestContext;
  calls: { count: number };
  reportState: { items: ReceivedMediaQuality[] };
  flush: () => Promise<void>;
}) {
  const { t, calls, reportState, flush } = input;
  await flush();
  await repeatTimerFlush({
    count: TEST_VALUE_5,
    advance: () => {
      t.mock.timers.tick(TEST_VALUE_5000);
    },
    flush,
  });
  assert.equal(calls.count, TEST_VALUE_6);
  assert.equal(reportState.items.length, 0, "no empty first-sample report; batches flush every 30 seconds");
  t.mock.timers.tick(TEST_VALUE_5000);
  await flush();
  assert.equal(reportState.items.length, 1);
  assert.equal(requireValue(reportState.items[0]).direction, "received");
  assert.equal(requireValue(reportState.items[0]).trackSid, "TR_remote");
  assert.equal(reportState.items.at(-1)?.qualitySignal, "sustained-low-resolution");
  assert.equal(reportState.items.at(-1)?.displayWidth, TEST_VALUE_1280);
  assert.equal(reportState.items.at(-1)?.bitrate, TEST_VALUE_112000);
}

async function assertProductionReceiverDiagnosticsVisibility(input: {
  t: TestContext;
  calls: { count: number };
  reportState: { items: ReceivedMediaQuality[] };
  documentState: { visibilityState: string };
  room: Room;
  flush: () => Promise<void>;
}) {
  const { t, calls, reportState, documentState, room, flush } = input;
  documentState.visibilityState = "hidden";
  const beforeHidden = calls.count;
  t.mock.timers.tick(TEST_VALUE_5000);
  await flush();
  assert.equal(calls.count, beforeHidden);
  documentState.visibilityState = "visible";
  const beforeVisible = reportState.items.length;
  await repeatTimerFlush({
    count: TEST_VALUE_3,
    advance: () => {
      t.mock.timers.tick(TEST_VALUE_5000);
    },
    flush,
  });
  assert.equal(calls.count, beforeHidden + TEST_VALUE_3, "sampling resumes when visible");
  assert.equal(reportState.items.length, beforeVisible, "re-selected video does not burst empty reports");
  room.emit(RoomEvent.Disconnected);
  const beforeDisconnect = calls.count;
  t.mock.timers.tick(TEST_VALUE_60000);
  await flush();
  assert.equal(calls.count, beforeDisconnect);
}

async function runProductionReceiverDiagnosticsTest(t: TestContext) {
  productionMode(t);
  const harness = await createProductionReceiverDiagnosticsHarness(t);
  await assertProductionReceiverDiagnosticsWarmup({ t, ...harness });
  await assertProductionReceiverDiagnosticsVisibility({ t, ...harness });
}

void test("production receiver diagnostics report visible video size, correlate tracks and stop after disconnect", async (t) => {
  await runProductionReceiverDiagnosticsTest(t);
});

function productionMode(t: TestContext) {
  const previousMode = Object.hasOwn(process.env, "NODE_ENV") ? process.env.NODE_ENV : undefined;
  Object.assign(process.env, { NODE_ENV: "production" });
  t.after(() => {
    if (previousMode === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      Object.assign(process.env, { NODE_ENV: previousMode });
    }
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
}

/** A 1080p30 camera whose encoder reports sustained CPU limitation. */
function cpuLimitedCamera(original: MediaTrackConstraints) {
  const camera: {
    constraints: MediaTrackConstraints;
    applied: MediaTrackConstraints[];
    isConstraintRejected: boolean;
  } = { constraints: original, applied: [], isConstraintRejected: false };
  const capture = {
    readyState: "live",
    getSettings: () => ({ width: TEST_VALUE_1920, height: TEST_VALUE_1080, frameRate: TEST_VALUE_30 }),
    getConstraints: () => camera.constraints,
    applyConstraints: async (next: MediaTrackConstraints) => {
      if (camera.isConstraintRejected) {
        throw new DOMException("rejected", "OverconstrainedError");
      }
      camera.constraints = next;
      camera.applied = [...camera.applied, next];
    },
  };
  const track = createLifecycleLocalVideoTrack();
  Object.defineProperties(track, {
    isLocal: { value: true },
    isMuted: { value: false },
    isUpstreamPaused: { value: false },
    mediaStreamTrack: { value: capture },
    getProcessor: { value: () => undefined },
    simulcastCodecs: { value: new Map() },
    getRTCStatsReport: {
      value: async () =>
        new Map([
          ["codec", { mimeType: "video/AV1" }],
          [
            "out",
            {
              id: "out",
              type: "outbound-rtp",
              kind: "video",
              codecId: "codec",
              frameWidth: TEST_VALUE_1920,
              frameHeight: TEST_VALUE_1080,
              framesPerSecond: TEST_VALUE_30,
              qualityLimitationReason: "cpu",
              bytesSent: Date.now() * TEST_VALUE_100,
            },
          ],
        ]),
    },
  });
  const roomState = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    localParticipant: {
      trackPublications: new Map([["camera", { track, source: Track.Source.Camera, trackSid: "camera" }]]),
    },
    remoteParticipants: new Map(),
  });
  const room = lifecycleTestRoom(roomState);

  return { camera, room };
}

void test("a same-source processor reset restores the current recovery caps", async (t) => {
  productionMode(t);
  const original = {
    width: { max: TEST_VALUE_1920 },
    height: { max: TEST_VALUE_1080 },
    frameRate: { max: TEST_VALUE_30 },
  };
  const { camera, room } = cpuLimitedCamera(original);
  const eventState = { items: [] as SentMediaQuality[] };
  const stop = startMeetingMediaDiagnostics(room, await selectMeetingMediaPolicy(), (batch) => {
    eventState.items = [...eventState.items, ...sentMediaQualityBatch(batch)];
  });
  t.after(stop);
  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  const tick = async (count: number) => {
    await repeatTimerFlush({
      count,
      advance: () => {
        t.mock.timers.tick(TEST_VALUE_5000);
      },
      flush,
    });
  };
  const last = () => {
    const event = requireValue(eventState.items.at(-1));

    return { action: event.action, outcome: event.outcome, level: event.level };
  };
  await flush();
  await tick(TEST_VALUE_16);
  assert.equal(camera.applied.length, TEST_VALUE_3);
  const maximum = camera.constraints;
  camera.constraints = original; // stopProcessor restores the SDK baseline without replacing this source.
  await tick(1);
  assert.equal(camera.applied.length, TEST_VALUE_4, "the current level is re-applied on the next sample");
  assert.deepEqual(
    [camera.constraints.width, camera.constraints.frameRate],
    [maximum.width, { ideal: TEST_VALUE_15, max: TEST_VALUE_15 }],
  );
  assert.deepEqual(last(), { action: "restore", outcome: "succeeded", level: TEST_VALUE_3 });
  await tick(TEST_VALUE_6);
  assert.equal(camera.applied.length, TEST_VALUE_4, "restored caps are stable at the maximum level");
  camera.isConstraintRejected = true;
  camera.constraints = original;
  await tick(1);
  assert.deepEqual(
    last(),
    { action: "restore", outcome: "failed", level: 0 },
    "unrestorable caps fall back to level 0",
  );
  camera.isConstraintRejected = false;
  await tick(TEST_VALUE_4);
  assert.equal(camera.applied.length, TEST_VALUE_4, "relief is re-earned over a fresh pressure window");
  await tick(1);
  assert.equal(camera.applied.length, TEST_VALUE_5);
  assert.deepEqual(camera.constraints.frameRate, { ideal: TEST_VALUE_20, max: TEST_VALUE_20 });
});

void test("media health keeps one upload in flight and always sends the final keepalive batch", async (t) => {
  productionMode(t);
  const { room } = cpuLimitedCamera({ frameRate: { max: TEST_VALUE_30 } });
  const uploadState = { items: [] as { actions: string[]; isKeepalive: boolean; release: () => void }[] };
  const stop = startMeetingMediaDiagnostics(
    room,
    await selectMeetingMediaPolicy(),
    (batch, options) =>
      new Promise<void>((resolve) => {
        uploadState.items = [
          ...uploadState.items,
          {
            actions: batch.map((report) => (report.direction === "sent" ? report.action : "received")),
            isKeepalive: options.keepalive,
            release: resolve,
          },
        ];
      }),
  );
  t.after(stop);
  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  const tick = async (count: number) => {
    await repeatTimerFlush({
      count,
      advance: () => {
        t.mock.timers.tick(TEST_VALUE_5000);
      },
      flush,
    });
  };
  await flush();
  await tick(TEST_VALUE_4);
  assert.deepEqual(
    uploadState.items.map((upload) => upload.actions),
    [["reduce"]],
  );
  await tick(TEST_VALUE_6);
  assert.equal(
    uploadState.items.length,
    1,
    "the next adjustment is held, not dropped, while the first upload is in flight",
  );
  requireValue(uploadState.items[0]).release();
  await flush();
  await tick(1);
  assert.deepEqual(
    uploadState.items.map((upload) => upload.actions),
    [["reduce"], ["reduce"]],
  );
  await tick(TEST_VALUE_5);
  assert.equal(uploadState.items.length, TEST_VALUE_2, "held again behind the unfinished second upload");
  room.emit(RoomEvent.Disconnected);
  assert.equal(uploadState.items.length, TEST_VALUE_3);
  const finalUpload = requireValue(uploadState.items[TEST_VALUE_2]);
  assert.deepEqual([finalUpload.actions, finalUpload.isKeepalive], [["reduce"], true]);
});

void test("a processor reset that loosens the camera cap re-applies the meeting policy", async (t) => {
  t.mock.method(console, "warn", () => {});
  const appliedState = { items: [] as MediaTrackConstraints[] };
  const captureState: { constraints: MediaTrackConstraints } = { constraints: { deviceId: "selected" } };
  const capture = {
    kind: "video",
    readyState: "live",
    getSettings: () => ({ width: TEST_VALUE_1920, height: TEST_VALUE_1080, frameRate: TEST_VALUE_30 }),
    getConstraints: () => captureState.constraints,
    applyConstraints: async (next: MediaTrackConstraints) => {
      captureState.constraints = next;
      appliedState.items = [...appliedState.items, next];
    },
  };
  const track = createLifecycleLocalVideoTrack();
  Object.defineProperties(track, {
    kind: { value: "video" },
    source: { value: Track.Source.Camera },
    mediaStreamTrack: { value: capture },
    getProcessor: { value: () => undefined },
  });
  const room = await createMeetingRoom({});
  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  room.emit(RoomEvent.LocalTrackPublished, lifecycleLocalTrackPublication({ track }), room.localParticipant);
  await flush();
  assert.equal(appliedState.items.length, 1);
  const cap = requireValue(appliedState.items[0]);
  captureState.constraints = { ...cap, frameRate: { ideal: TEST_VALUE_15, max: TEST_VALUE_15 } };
  track.emit(TrackEvent.TrackProcessorUpdate);
  await flush();
  assert.equal(appliedState.items.length, 1, "tighter in-call recovery caps are left alone");
  captureState.constraints = {
    deviceId: "selected",
    width: { ideal: TEST_VALUE_1920 },
    height: { ideal: TEST_VALUE_1080 },
    frameRate: { ideal: TEST_VALUE_30 },
  };
  track.emit(TrackEvent.TrackProcessorUpdate);
  await flush();
  assert.equal(appliedState.items.length, TEST_VALUE_2, "stopProcessor restored ideal-only SDK constraints");
  assert.deepEqual(
    [
      requireValue(appliedState.items[1]).width,
      requireValue(appliedState.items[1]).height,
      requireValue(appliedState.items[1]).frameRate,
    ],
    [cap.width, cap.height, cap.frameRate],
  );
  await room.disconnect();
});
