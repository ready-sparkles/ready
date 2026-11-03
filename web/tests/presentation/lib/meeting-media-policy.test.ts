import type { LocalTrack } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";

import {
  constrainMeetingCamera,
  createMeetingRoom,
  getMeetingAudioCaptureOptions,
  getMeetingCameraCaptureOptions,
  getMeetingPublishDefaults,
} from "../../../presentation/lib/livekit";
import { MEETING_MEDIA_CONFIG as config } from "../../../presentation/lib/meeting-media-config";
import {
  counterRates,
  encodeMillisecondsPerFrame,
  SustainedCpuTracker,
} from "../../../presentation/lib/meeting-media-diagnostics";
import {
  type EncodingCost,
  type PolicyEnvironment,
  probeEncodingCost,
  rememberCpuLimitation,
  selectCodec,
  selectMeetingMediaPolicy,
} from "../../../presentation/lib/meeting-media-policy";

const EXPECTED_PACKET_LOSS_RATE = 0.01;
const LATENCY_MEASUREMENT_TOLERANCE = 0.001;
const ENCODE_LATENCY_TOTAL_ENCODE_TIME = 1.6;
const MESSAGE_MISSING_RESOLVER_PREFIX = "Missing resolver for";
const MESSAGE_BLOCKED = "blocked";
const MESSAGE_QUOTA = "quota";
const MESSAGE_CAMERA_CONSTRAINTS_NOT_APPLIED = "Camera constraints were not applied";
const MESSAGE_PORTRAIT_CONSTRAINTS_NOT_APPLIED = "Portrait constraints were not applied";
const MESSAGE_ENCODE_LATENCY_EXPECTED = "Expected encode latency";
const MESSAGE_WEBRTC_UNSUPPORTED = "webrtc unsupported";
const MESSAGE_UNAVAILABLE = "unavailable";
const MESSAGE_MUST_NOT_STOP_CAMERA = "must not stop working camera";

const TEST_VALUE_100 = 100;

function encodingCostFixture(input: {
  /** @external encoding probe wire field */
  supported: boolean;
  /** @external encoding probe wire field */
  smooth: boolean;
  /** @external encoding probe wire field */
  powerEfficient: boolean;
}) {
  return input;
}

function isVideoLocalTrack(value: unknown): value is LocalTrack {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === "video" && "mediaStreamTrack" in value
  );
}

function videoLocalTrack(input: { mediaStreamTrack: MediaStreamTrack; getProcessor?: () => undefined }): LocalTrack {
  const track = {
    kind: "video",
    mediaStreamTrack: input.mediaStreamTrack,
    getProcessor: input.getProcessor ?? (() => undefined),
  };
  assert.ok(isVideoLocalTrack(track));

  return track;
}

function fakeVideoMediaStreamTrack(input: {
  getSettings: () => MediaTrackSettings;
  getConstraints: () => MediaTrackConstraints;
  applyConstraints: (constraints: MediaTrackConstraints) => Promise<void>;
  stop?: () => void;
}): MediaStreamTrack {
  const track = {
    kind: "video",
    readyState: "live",
    ...input,
  };
  assert.ok(isFakeMediaStreamTrack(track));

  return track;
}

function isFakeMediaStreamTrack(value: { kind: string }): value is MediaStreamTrack & { kind: string } {
  return value.kind === "video";
}

function environment(overrides: Partial<PolicyEnvironment> = {}): PolicyEnvironment {
  const values = new Map<string, string>();

  return {
    codecs: ["av1", "vp9", "h264", "vp8"].map((codec) => ({ mimeType: `video/${codec}` })),
    sdkSupports: () => true,
    encodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }),
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    deviceKey: "device:",
    now: () => TEST_VALUE_100,
    ...overrides,
  };
}

async function flushProbeTasks() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

const TEST_VALUE_10 = 10;
const TEST_VALUE_1000 = 1000;
const TEST_VALUE_1080 = 1080;
const TEST_VALUE_119 = 119;
const TEST_VALUE_1280 = 1280;
const TEST_VALUE_1440 = 1440;
const TEST_VALUE_150 = 150;
const TEST_VALUE_1920 = 1920;
const TEST_VALUE_1_700_000 = 1_700_000;
const TEST_VALUE_2 = 2;
const TEST_VALUE_20 = 20;
const TEST_VALUE_20_000 = 20_000;
const TEST_VALUE_22_000 = 22_000;
const TEST_VALUE_2_000_000 = 2_000_000;
const TEST_VALUE_3 = 3;
const TEST_VALUE_30 = 30;
const TEST_VALUE_3000 = 3000;
const TEST_VALUE_4 = 4;
const TEST_VALUE_501000 = 501000;
const TEST_VALUE_540 = 540;
const TEST_VALUE_60_000 = 60_000;
const TEST_VALUE_70 = 70;
const TEST_VALUE_720 = 720;
const TEST_VALUE_8 = 8;
const TEST_VALUE_80_000 = 80_000;
const TEST_VALUE_82_000 = 82_000;
void test("each resolution is one parallel wave and lower tiers wait for the current tier", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const heights: { values: number[] } = { values: [] };
  const env = environment({
    encodingInfo: ({ video }) => {
      heights.values = [...heights.values, video.height];

      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              supported: true,
              smooth: video.height <= TEST_VALUE_540,
              powerEfficient: false,
            }),
          TEST_VALUE_150,
        );
      });
    },
  });
  const progress = { isSettled: false };
  const selection = (async () => {
    const decision = await selectCodec("camera", env);
    progress.isSettled = true;

    return decision;
  })();
  assert.deepEqual(heights.values, [TEST_VALUE_720, TEST_VALUE_720, TEST_VALUE_720, TEST_VALUE_720]);
  t.mock.timers.tick(TEST_VALUE_150);
  await flushProbeTasks();
  assert.equal(progress.isSettled, false);
  assert.deepEqual(heights.values.slice(TEST_VALUE_4), [
    TEST_VALUE_540,
    TEST_VALUE_540,
    TEST_VALUE_540,
    TEST_VALUE_540,
  ]);
  t.mock.timers.tick(TEST_VALUE_150);
  const decision = await selection;
  assert.equal(decision.codec, "av1");
  assert.deepEqual(decision.target, config.camera.constrained);
});

void test("out-of-order completions preserve codec priority and share in-flight work", async () => {
  const resolvers = new Map<string, (cost: EncodingCost) => void>();
  const calls = { count: 0 };
  const env = environment({
    encodingInfo: ({ video }) => {
      calls.count += 1;

      return new Promise((resolve) => {
        resolvers.set(video.contentType, resolve);
      });
    },
  });
  const progress = { isSettled: false };
  const first = (async () => {
    const decision = await selectCodec("camera", env);
    progress.isSettled = true;

    return decision;
  })();
  const second = selectCodec("camera", env);
  assert.equal(calls.count, TEST_VALUE_4);
  const completeEncodingCost = encodingCostFixture({
    supported: true,
    smooth: true,
    powerEfficient: true,
  });
  const resolveStored = (contentType: string) => {
    const resolve = resolvers.get(contentType);
    if (resolve === undefined) {
      assert.fail(MESSAGE_MISSING_RESOLVER_PREFIX);

      return;
    }
    resolve(completeEncodingCost);
  };
  resolveStored("video/VP8");
  resolveStored("video/H264");
  resolveStored("video/VP9");
  await flushProbeTasks();
  assert.equal(progress.isSettled, false);
  resolveStored("video/AV1");
  const decisions = await Promise.all([first, second]);
  assert.ok(decisions.every((decision) => decision.codec === "av1"));
  assert.equal(calls.count, TEST_VALUE_4);
});

void test("a fast preferred codec returns before unused hangs, whose cooldown cannot block it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = environment({
    encodingInfo: async ({ video }) =>
      video.contentType === "video/AV1"
        ? { supported: true, smooth: true, powerEfficient: false }
        : new Promise(() => {}),
  });
  const captured: { decision?: Awaited<ReturnType<typeof selectCodec>> } = {};
  const selection = (async () => {
    captured.decision = await selectCodec("camera", env);
  })();
  await flushProbeTasks();
  assert.equal(captured.decision?.codec, "av1");
  assert.deepEqual(captured.decision.target, config.camera.efficient);
  t.mock.timers.tick(config.capability.timeoutMs);
  await flushProbeTasks();
  await selection;
  // A different uncached target must still be queried after background timeouts,
  // including after reloading the browser-local cooldown from storage.
  const reloaded = environment({ ...env });
  await (
    [
      [env, config.camera.constrained, config.camera.scalabilityMode],
      [reloaded, config.screen.full, config.screen.scalabilityMode],
    ] as const
  ).reduce(async (previous, [current, target, mode]) => {
    await previous;
    const result = await probeEncodingCost(current, "av1", target, mode);
    assert.equal(result.status, "complete");
    assert.equal(result.cached, false);
    assert.equal(result.cost?.smooth, true);
  }, Promise.resolve());
  await [env, reloaded].reduce(async (previous, current) => {
    await previous;
    assert.equal(
      (await probeEncodingCost(current, "vp9", config.camera.constrained, config.camera.scalabilityMode)).status,
      "skipped-after-timeout",
    );
  }, Promise.resolve());
});

void test("a preferred codec timeout retains a completed lower-priority result at full resolution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = environment({
    encodingInfo: async ({ video }) =>
      video.contentType === "video/AV1"
        ? new Promise(() => {})
        : { supported: true, smooth: true, powerEfficient: true },
  });
  const selection = selectCodec("screen", env);
  await flushProbeTasks();
  t.mock.timers.tick(config.capability.timeoutMs);
  const decision = await selection;
  assert.equal(decision.codec, "vp9");
  assert.deepEqual(decision.target, config.screen.full);
  assert.equal(decision.cost?.smooth, true);
});

void test("an unused rejecting probe is cached without failing a successful selection", async () => {
  const failures = { count: 0 };
  const env = environment({
    encodingInfo: async ({ video }) => {
      if (video.contentType === "video/VP8") {
        failures.count += 1;
        throw new TypeError(MESSAGE_UNAVAILABLE);
      }

      return { supported: true, smooth: true, powerEfficient: true };
    },
  });
  assert.equal((await selectCodec("camera", env)).codec, "av1");
  await flushProbeTasks();
  assert.equal((await probeEncodingCost(env, "vp8", config.camera.efficient)).status, "rejected");
  assert.equal(failures.count, 1);
});

void test("camera selects AV1 with confirmed target support including SVC", async () => {
  const probes: { values: unknown[] } = { values: [] };
  const policy = await selectMeetingMediaPolicy(
    environment({
      encodingInfo: async (query) => {
        probes.values = [...probes.values, query];

        return { supported: true, smooth: true, powerEfficient: true };
      },
    }),
  );
  assert.equal(policy.camera.codec, "av1");
  assert.equal(policy.camera.target.height, TEST_VALUE_720);
  assert.equal(policy.screen.target.height, TEST_VALUE_1440);
  assert.ok(probes.values.some((query) => JSON.stringify(query).includes("L3T3_KEY")));
  assert.ok(probes.values.some((query) => JSON.stringify(query).includes("L1T3")));
});

void test("smooth software AV1 is eligible for 720p camera and full-resolution screen", async () => {
  const policy = await selectMeetingMediaPolicy(
    environment({ encodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: false }) }),
  );
  assert.equal(policy.camera.codec, "av1");
  assert.equal(policy.camera.target.height, TEST_VALUE_720);
  assert.equal(policy.screen.codec, "av1");
  assert.match(policy.camera.reason, /powerEfficient=false/);
});

void test("AV1 smooth only at 720p is probed again at the lower actual target", async () => {
  const decision = await selectCodec(
    "camera",
    environment({
      encodingInfo: async ({ video }) => ({
        supported: true,
        smooth: video.height <= TEST_VALUE_720,
        powerEfficient: false,
      }),
    }),
  );
  assert.equal(decision.codec, "av1");
  assert.equal(decision.target.height, TEST_VALUE_720);
});

void test("screen preserves smooth 1440p VP9 ahead of lower-resolution AV1", async () => {
  const decision = await selectCodec(
    "screen",
    environment({
      encodingInfo: async ({ video }) => ({
        supported: true,
        smooth: video.contentType !== "video/AV1" || video.height <= TEST_VALUE_1080,
        powerEfficient: false,
      }),
    }),
  );
  assert.equal(decision.codec, "vp9");
  assert.deepEqual(decision.target, config.screen.full);
});

(["unsupported", "not smooth"] as const).forEach((failure) => {
  void test(`screen retries 1080p AV1 when every 1440p codec is ${failure}`, async () => {
    const decision = await selectCodec(
      "screen",
      environment({
        encodingInfo: async ({ video }) => ({
          supported: failure !== "unsupported" || video.height <= TEST_VALUE_1080,
          smooth: failure !== "not smooth" || video.height <= TEST_VALUE_1080,
          powerEfficient: false,
        }),
      }),
    );
    assert.equal(decision.codec, "av1");
    assert.deepEqual(decision.target, config.screen.constrained);
    assert.equal(decision.cost?.supported, true);
    assert.equal(decision.cost.smooth, true);
  });

  void test(`camera with CPU history retries 540p when every 720p codec is ${failure}`, async () => {
    const env = environment({
      encodingInfo: async ({ video }) => ({
        supported: failure !== "unsupported" || video.height <= TEST_VALUE_540,
        smooth: failure !== "not smooth" || video.height <= TEST_VALUE_540,
        powerEfficient: false,
      }),
    });
    rememberCpuLimitation("camera", "av1", env);
    const decision = await selectCodec("camera", env);
    assert.equal(decision.codec, "vp9");
    assert.deepEqual(decision.target, config.camera.constrained);
    assert.equal(decision.cost?.supported, true);
    assert.equal(decision.cost.smooth, true);
    assert.ok(
      decision.probes?.every((probe) => probe.codec !== "av1" && probe.target.height <= TEST_VALUE_720) === true,
    );
  });
});

void test("camera preserves smooth 720p H264 ahead of 540p VP9 after CPU limitation", async () => {
  const env = environment({
    encodingInfo: async ({ video }) => ({
      supported: true,
      smooth: video.contentType !== "video/VP9" || video.height <= TEST_VALUE_540,
      powerEfficient: false,
    }),
  });
  rememberCpuLimitation("camera", "av1", env);
  const decision = await selectCodec("camera", env);
  assert.equal(decision.codec, "h264");
  assert.deepEqual(decision.target, config.camera.efficient);
});

void test("camera preserves smooth 720p VP9 ahead of 540p AV1 without CPU history", async () => {
  const decision = await selectCodec(
    "camera",
    environment({
      encodingInfo: async ({ video }) => ({
        supported: true,
        smooth: video.contentType !== "video/AV1" || video.height <= TEST_VALUE_540,
        powerEfficient: false,
      }),
    }),
  );
  assert.equal(decision.codec, "vp9");
  assert.deepEqual(decision.target, config.camera.efficient);
});

void test("camera can reach a proven 540p target without prior CPU history", async () => {
  const decision = await selectCodec(
    "camera",
    environment({
      encodingInfo: async ({ video }) => ({
        supported: true,
        smooth: video.height <= TEST_VALUE_540,
        powerEfficient: false,
      }),
    }),
  );
  assert.equal(decision.codec, "av1");
  assert.deepEqual(decision.target, config.camera.constrained);
  assert.equal(decision.cost?.smooth, true);
});

void test("exhausted camera probes never restore a rejected 720p target in the last-resort fallback", async () => {
  const env = environment({ encodingInfo: async () => ({ supported: true, smooth: false, powerEfficient: false }) });
  rememberCpuLimitation("camera", "av1", env);
  const decision = await selectCodec("camera", env);
  assert.equal(decision.codec, config.backup.codec);
  assert.deepEqual(decision.target, config.camera.constrained);
  assert.equal(decision.cost, null);
  assert.match(decision.reason, /conservative VP8 fallback/);
});

void test("incomplete, missing and rejecting media capabilities never invent SVC support", async () => {
  await [
    undefined,
    async () => ({}),
    async () => {
      throw new TypeError(MESSAGE_WEBRTC_UNSUPPORTED);
    },
  ].reduce(async (previous, encodingInfo) => {
    await previous;
    const decision = await selectCodec("camera", environment({ encodingInfo }));
    assert.equal(decision.codec, "h264");
    assert.equal(decision.target.height, TEST_VALUE_720);
    assert.equal(decision.cost, null);
    assert.equal(decision.scalabilityMode, undefined);
  }, Promise.resolve());
});

void test("explicit mode exclusion wins over optimistic encodingInfo", async () => {
  const env = environment();
  env.codecs = env.codecs.map((codec) => ({ ...codec, scalabilityModes: ["L1T3"] }));
  assert.equal((await selectCodec("camera", env)).codec, "h264");
  assert.equal((await selectCodec("screen", env)).codec, "av1");
});

void test("SDK browser exclusions are respected even when RTP advertises AV1/VP9", async () => {
  const decision = await selectCodec(
    "camera",
    environment({ sdkSupports: (codec) => !["av1", "vp9"].includes(codec) }),
  );
  assert.equal(decision.codec, "h264");
});

void test("CPU history survives a new selection, lowers the next cap, and keeps sources separate", async () => {
  const env = environment();
  const initial = await selectMeetingMediaPolicy(env);
  rememberCpuLimitation("camera", "av1", env);
  const next = await selectMeetingMediaPolicy(env);
  assert.equal(initial.camera.codec, "av1");
  assert.equal(initial.camera.target.height, TEST_VALUE_720);
  assert.equal(next.camera.codec, "vp9");
  assert.equal(next.camera.target.height, TEST_VALUE_720);
  assert.equal(next.screen.codec, "av1");
  rememberCpuLimitation("camera", "vp9", env);
  assert.equal((await selectCodec("camera", env)).codec, "h264");
});

void test("cache is reused for the exact encode configuration and expires", async () => {
  const clock = { now: TEST_VALUE_100, probes: 0 };
  const env = environment({
    now: () => clock.now,
    encodingInfo: async () => {
      clock.probes += 1;

      return { supported: true, smooth: true, powerEfficient: true };
    },
  });
  await selectCodec("camera", env);
  await selectCodec("camera", env);
  assert.equal(clock.probes, config.camera.codecOrder.length);
  await selectCodec("screen", env);
  assert.equal(clock.probes, config.camera.codecOrder.length + config.screen.codecOrder.length);
  clock.now += config.capability.cacheMaxAgeMs + 1;
  await selectCodec("camera", env);
  assert.equal(clock.probes, config.camera.codecOrder.length * TEST_VALUE_2 + config.screen.codecOrder.length);
});

void test("blocked or malformed storage does not prevent joining", async () => {
  await [
    () => "{broken",
    () => {
      throw new Error(MESSAGE_BLOCKED);
    },
    () => '{"cpuCodecs":{"camera":42}}',
  ].reduce(async (previous, getItem) => {
    await previous;
    const env = environment({
      storage: {
        getItem,
        setItem: () => {
          throw new Error(MESSAGE_QUOTA);
        },
      },
    });
    assert.equal((await selectCodec("camera", env)).codec, "av1");
    assert.doesNotThrow(() => rememberCpuLimitation("camera", "av1", env));
  }, Promise.resolve());
});

void test("CPU feedback requires consecutive samples and does not count muted or missing intervals", () => {
  const monitor = new SustainedCpuTracker();
  const sampleStepMs = 2000;
  Array.from(
    { length: Math.ceil(config.diagnostics.sustainedCpuMs / sampleStepMs) },
    (_value, index) => index * sampleStepMs,
  ).forEach((sampleAt) => {
    assert.equal(monitor.observe({ isCpuLimited: true, now: sampleAt }), false);
  });
  assert.equal(monitor.observe({ isCpuLimited: false, now: TEST_VALUE_20_000 }), false);
  assert.equal(monitor.observe({ isCpuLimited: true, now: TEST_VALUE_22_000 }), false);
  assert.equal(monitor.observe({ isCpuLimited: true, now: TEST_VALUE_60_000 }), false);
  const recoveryStartMs = 62_000;
  const recoveryEndMs = TEST_VALUE_80_000;
  Array.from(
    { length: (recoveryEndMs - recoveryStartMs) / sampleStepMs },
    (_value, index) => recoveryStartMs + index * sampleStepMs,
  ).forEach((sampleAt) => {
    assert.equal(monitor.observe({ isCpuLimited: true, now: sampleAt }), false);
  });
  assert.equal(monitor.observe({ isCpuLimited: true, now: TEST_VALUE_80_000 }), true);
  assert.equal(monitor.observe({ isCpuLimited: true, now: TEST_VALUE_82_000 }), false);
});

void test("diagnostic rates use deltas and treat reconnect counter resets as unknown", () => {
  const before = {
    timestamp: TEST_VALUE_1000,
    bytes: TEST_VALUE_1000,
    frames: TEST_VALUE_10,
    packets: TEST_VALUE_20,
    lost: TEST_VALUE_2,
  };
  const after = {
    timestamp: TEST_VALUE_3000,
    bytes: TEST_VALUE_501000,
    frames: TEST_VALUE_70,
    packets: TEST_VALUE_119,
    lost: TEST_VALUE_3,
  };
  assert.deepEqual(counterRates(after, before), {
    bitrate: TEST_VALUE_2_000_000,
    fps: TEST_VALUE_30,
    packetLoss: EXPECTED_PACKET_LOSS_RATE,
  });
  assert.deepEqual(counterRates(before, after), { bitrate: null, fps: null, packetLoss: null });
});

void test("capture constraints are ideal with strict upper bounds; reused tracks retain identity", async () => {
  const decision = await selectCodec("camera", environment());
  const applied: { constraints?: MediaTrackConstraints } = {};
  const raw = fakeVideoMediaStreamTrack({
    getConstraints: () => ({ deviceId: "selected" }),
    getSettings: () => ({ width: TEST_VALUE_1920, height: TEST_VALUE_1080 }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      applied.constraints = constraints;
    },
  });
  await constrainMeetingCamera(raw, decision);
  if (applied.constraints === undefined) {
    throw new Error(MESSAGE_CAMERA_CONSTRAINTS_NOT_APPLIED);
  }
  assert.deepEqual(applied.constraints.width, { ideal: TEST_VALUE_1280, max: TEST_VALUE_1280 });
  assert.equal(applied.constraints.deviceId, "selected");
  assert.equal(getMeetingCameraCaptureOptions("selected", decision).resolution?.height, TEST_VALUE_720);
  const publish = getMeetingPublishDefaults(decision);
  assert.equal(publish.videoCodec, "av1");
  assert.equal(publish.videoEncoding?.maxBitrate, TEST_VALUE_1_700_000);
  assert.equal(publish.degradationPreference, "maintain-framerate");
  assert.deepEqual(publish.backupCodec, {
    codec: "vp8",
    encoding: { maxBitrate: TEST_VALUE_1_700_000, maxFramerate: TEST_VALUE_30 },
  });
  assert.equal(publish.red, true);
  assert.equal(publish.dtx, true);
  assert.equal(publish.forceStereo, false);
  assert.equal(getMeetingAudioCaptureOptions().echoCancellation, true);
});

void test("CPU history still reduces the cap when browser capability APIs are absent", async () => {
  const env = environment({ codecs: [], encodingInfo: undefined });
  rememberCpuLimitation("camera", "vp8", env);
  assert.equal((await selectCodec("camera", env)).target.height, TEST_VALUE_720);
});

void test("a hung encoding API is bounded to one concurrent batch, without retrying lower tiers", async () => {
  const calls = { count: 0 };
  const env = environment({
    encodingInfo: () => {
      calls.count += 1;

      return new Promise(() => {});
    },
  });
  const decision = await selectCodec("camera", env);
  assert.equal(decision.codec, "h264");
  assert.equal(decision.target.height, TEST_VALUE_720);
  assert.equal(calls.count, config.camera.codecOrder.length);
});

void test("software AV1 retains explicit efficiency=false without mislabeling support as unknown", async () => {
  const decision = await selectCodec(
    "camera",
    environment({ encodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: false }) }),
  );
  assert.deepEqual(
    decision.probes?.filter((p) => p.codec === "av1").map((p) => [p.target.height, p.status, p.cost?.powerEfficient]),
    [[TEST_VALUE_720, "complete", false]],
  );
  assert.doesNotMatch(decision.reason, /unknown/);
});

const partialEncodingAnswer = {
  /** @external encoding probe wire field */
  supported: true,
  /** @external encoding probe wire field */
  smooth: true,
};

void test("unknown probe states remain distinct, including partial browser answers", async () => {
  await (
    [
      [undefined, "api-missing"],
      // A partial browser answer omits powerEfficient.
      [async () => partialEncodingAnswer, "incomplete"],
      [
        async () => {
          throw new TypeError(MESSAGE_WEBRTC_UNSUPPORTED);
        },
        "rejected",
      ],
    ] as const
  ).reduce(async (previous, [encodingInfo, status]) => {
    await previous;
    const env = environment({ encodingInfo });
    const result = await probeEncodingCost(env, "av1", config.camera.efficient, config.camera.scalabilityMode);
    assert.equal(result.status, status);
    assert.equal(result.cost, null);
    if (status === "incomplete") {
      assert.deepEqual(result.reported, {
        /** @external encoding probe wire field */
        supported: true,
        /** @external encoding probe wire field */
        smooth: true,
      });
    }
    const decision = await selectCodec("camera", env);
    assert.match(decision.reason, /encoding performance unknown/);
    assert.doesNotMatch(decision.reason, /explicitly reports/);
  }, Promise.resolve());
});

void test("cached probes preserve the original browser cost and label the cache", async () => {
  const env = environment();
  const a = await probeEncodingCost(env, "av1", config.camera.efficient);
  const b = await probeEncodingCost(env, "av1", config.camera.efficient);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.deepEqual(a.cost, b.cost);
});

void test("encode latency uses frame/time deltas and does not invent values for missing/reset counters", () => {
  const a = { timestamp: TEST_VALUE_1000, bytes: 0, frames: TEST_VALUE_10, totalEncodeTime: 1 };
  const b = {
    timestamp: TEST_VALUE_3000,
    bytes: TEST_VALUE_100,
    frames: TEST_VALUE_70,
    totalEncodeTime: ENCODE_LATENCY_TOTAL_ENCODE_TIME,
  };
  const latency = encodeMillisecondsPerFrame(b, a);
  if (latency === null) {
    throw new Error(MESSAGE_ENCODE_LATENCY_EXPECTED);
  }
  assert.ok(Math.abs(latency - TEST_VALUE_10) < LATENCY_MEASUREMENT_TOLERANCE);
  assert.equal(encodeMillisecondsPerFrame(a, b), null);
  assert.equal(encodeMillisecondsPerFrame(b, b), null);
  assert.equal(encodeMillisecondsPerFrame({ ...b, frames: TEST_VALUE_10 }, a), null);
  assert.equal(encodeMillisecondsPerFrame({ ...b, totalEncodeTime: undefined }, a), null);
});

void test("a non-smooth AV1 encoder falls back to a supported smooth codec", async () => {
  const choice = await selectCodec(
    "camera",
    environment({
      encodingInfo: async ({ video }) => ({
        supported: true,
        smooth: video.contentType !== "video/AV1",
        powerEfficient: false,
      }),
    }),
  );
  assert.equal(choice.codec, "vp9");
  assert.equal(choice.target.height, TEST_VALUE_720);
  assert.match(choice.reason, /av1: target unsupported or not smooth/);
});

void test("CPU history expires rather than permanently penalizing a browser", async () => {
  const clock = { now: TEST_VALUE_100 };
  const env = environment({ now: () => clock.now });
  rememberCpuLimitation("camera", "av1", env);
  assert.equal((await selectCodec("camera", env)).codec, "vp9");
  rememberCpuLimitation("camera", "vp9", env);
  assert.equal((await selectCodec("camera", env)).target.height, TEST_VALUE_540);
  clock.now += config.capability.cpuHistoryMaxAgeMs;
  const recovered = await selectCodec("camera", env);
  assert.equal(recovered.codec, "av1");
  assert.equal(recovered.target.height, TEST_VALUE_720);
});

void test("malformed, future and expired CPU records do not reduce camera quality", async () => {
  await [
    { camera: [] },
    { camera: { av1: "bad" } },
    { camera: { av1: TEST_VALUE_1000 } },
    { camera: { av1: -config.capability.cpuHistoryMaxAgeMs } },
  ].reduce(async (previous, cpuLimitedAt) => {
    await previous;
    const env = environment({
      storage: {
        getItem: (key) => (key.endsWith("history") ? JSON.stringify({ cpuLimitedAt }) : null),
        setItem: () => {},
      },
    });
    assert.equal((await selectCodec("camera", env)).codec, "av1");
  }, Promise.resolve());
});

void test("ordinary meeting rooms use dual connections even for non-AV1 publishers", async () => {
  const room = await createMeetingRoom({});
  assert.equal(room.options.singlePeerConnection, false);
  assert.equal(room.options.dynacast, true);
  assert.notEqual(room.options.adaptiveStream, false);
  const backupCodec = room.options.publishDefaults?.backupCodec;
  const backupCodecName = backupCodec !== undefined && typeof backupCodec === "object" ? backupCodec.codec : undefined;
  assert.equal(backupCodecName, "vp8");
  await room.disconnect();
});

void test("advertised SVC modes never substitute for AV1 encoding performance on either source", async () => {
  await [
    undefined,
    async () => ({}),
    async () => {
      throw new TypeError(MESSAGE_UNAVAILABLE);
    },
  ].reduce(async (previous, encodingInfo) => {
    await previous;
    const env = environment({
      encodingInfo,
      codecs: ["av1", "vp9", "vp8"].map((codec) => ({
        mimeType: `video/${codec}`,
        scalabilityModes: [config.camera.scalabilityMode, config.screen.scalabilityMode],
      })),
    });
    const camera = await selectCodec("camera", env);
    const screen = await selectCodec("screen", env);
    assert.equal(camera.codec, "vp9");
    assert.equal(camera.target.height, TEST_VALUE_720);
    assert.equal(screen.codec, "vp9");
    assert.deepEqual(screen.target, config.screen.constrained);
    assert.equal(screen.cost, null);
    assert.match(screen.reason, /av1: encoding performance unknown/);
  }, Promise.resolve());
});

void test("concurrent selections share probes; incomplete results expire and retry", async () => {
  const clock = { calls: 0, now: TEST_VALUE_100 };
  const configurations = new Set<string>();
  const env = environment({
    storage: undefined,
    now: () => clock.now,
    encodingInfo: async (query) => {
      clock.calls += 1;
      configurations.add(JSON.stringify(query));
      await Promise.resolve();

      return { supported: true };
    },
  });
  const first = await Promise.all([
    selectMeetingMediaPolicy(env),
    selectMeetingMediaPolicy(env),
    selectMeetingMediaPolicy(env),
  ]);
  const initialCalls = clock.calls;
  assert.equal(new Set(first.map((value) => value.camera.codec)).size, 1);
  // Each exact target is queried once across all three concurrent callers.
  assert.equal(clock.calls, configurations.size);
  await selectMeetingMediaPolicy(env);
  assert.equal(clock.calls, initialCalls);
  clock.now += config.capability.unknownCacheMaxAgeMs;
  await selectMeetingMediaPolicy(env);
  assert.equal(clock.calls, initialCalls * TEST_VALUE_2);
});

void test("unknown results survive a fresh environment with the same browser storage", async () => {
  await [
    undefined,
    async () => ({}),
    async () => {
      throw new Error(MESSAGE_UNAVAILABLE);
    },
  ].reduce(async (previous, encodingInfo) => {
    await previous;
    const clock = { now: TEST_VALUE_100, calls: 0 };
    const first = environment({ encodingInfo, now: () => clock.now });
    await probeEncodingCost(first, "av1", config.screen.full, config.screen.scalabilityMode);
    const next = environment({
      storage: first.storage,
      now: () => clock.now,
      encodingInfo: async () => {
        clock.calls += 1;

        return { supported: true, smooth: true, powerEfficient: false };
      },
    });
    const cached = await probeEncodingCost(next, "av1", config.screen.full, config.screen.scalabilityMode);
    assert.equal(cached.cached, true);
    assert.equal(cached.cost, null);
    assert.equal(clock.calls, 0);
    clock.now += config.capability.unknownCacheMaxAgeMs;
    assert.equal(
      (await probeEncodingCost(next, "av1", config.screen.full, config.screen.scalabilityMode)).cost?.supported,
      true,
    );
    assert.equal(clock.calls, 1);
  }, Promise.resolve());
});

void test("timeout cooldown covers screen AV1 and later joins, then permits recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: TEST_VALUE_100, calls: 0 };
  const env = environment({
    now: () => clock.now,
    codecs: ["av1", "vp9"].map((codec) => ({
      mimeType: `video/${codec}`,
      scalabilityModes: [config.camera.scalabilityMode, config.screen.scalabilityMode],
    })),
    encodingInfo: () => {
      clock.calls += 1;

      return new Promise(() => {});
    },
  });
  const choices = Promise.all([selectMeetingMediaPolicy(env), selectMeetingMediaPolicy(env)]);
  t.mock.timers.tick(config.capability.timeoutMs);
  const [first] = await choices;
  assert.equal(first.screen.codec, "vp9");
  assert.equal(first.screen.target.height, TEST_VALUE_1080);
  assert.equal(first.camera.codec, "vp9");
  assert.equal(clock.calls, TEST_VALUE_4); // Two codecs at each of the camera/screen targets, shared by both callers.
  await selectMeetingMediaPolicy(env);
  const reloaded = environment({
    ...env,
    encodingInfo: async () => {
      clock.calls += 1;

      return { supported: true, smooth: true, powerEfficient: false };
    },
  });
  assert.equal((await selectMeetingMediaPolicy(reloaded)).screen.codec, "vp9");
  assert.equal(clock.calls, TEST_VALUE_4);
  clock.now += config.capability.unknownCacheMaxAgeMs;
  assert.equal((await selectMeetingMediaPolicy(reloaded)).screen.codec, "av1");
  assert.equal(clock.calls, TEST_VALUE_8);
});

void test("portrait capture gets the same pixel budget with swapped bounds", async () => {
  const decision = await selectCodec("camera", environment({ encodingInfo: undefined }));
  const applied: { constraints?: MediaTrackConstraints } = {};
  const raw = fakeVideoMediaStreamTrack({
    getSettings: () => ({ width: TEST_VALUE_1080, height: TEST_VALUE_1920 }),
    getConstraints: () => ({ deviceId: "portrait-camera", facingMode: "user" }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      applied.constraints = constraints;
    },
  });
  await constrainMeetingCamera(raw, decision);
  if (applied.constraints === undefined) {
    throw new Error(MESSAGE_PORTRAIT_CONSTRAINTS_NOT_APPLIED);
  }
  assert.deepEqual(applied.constraints.width, { ideal: TEST_VALUE_720, max: TEST_VALUE_720 });
  assert.deepEqual(applied.constraints.height, { ideal: TEST_VALUE_1280, max: TEST_VALUE_1280 });
  assert.equal(applied.constraints.deviceId, "portrait-camera");
  assert.equal(applied.constraints.facingMode, "user");
});

void test("rejected capture caps retain a usable raw or reused local track", async (t) => {
  // Cap rejections are reported through console.error (the lint policy's only console channel).
  const warn = t.mock.method(console, "error", () => {});
  const decision = await selectCodec("camera", environment());
  const originalSettings = { width: TEST_VALUE_1920, height: TEST_VALUE_1080, frameRate: TEST_VALUE_30 };
  const raw = fakeVideoMediaStreamTrack({
    getSettings: () => originalSettings,
    getConstraints: () => ({ deviceId: "selected" }),
    stop: () => assert.fail(MESSAGE_MUST_NOT_STOP_CAMERA),
    applyConstraints: async () => {
      throw new DOMException("unsupported limit", "OverconstrainedError");
    },
  });
  await assert.doesNotReject(constrainMeetingCamera(raw, decision));
  const local = videoLocalTrack({ mediaStreamTrack: raw });
  await assert.doesNotReject(constrainMeetingCamera(local, decision));
  assert.equal(local.mediaStreamTrack, raw);
  assert.equal(raw.readyState, "live");
  assert.equal(raw.getSettings(), originalSettings);
  assert.equal(warn.mock.callCount(), TEST_VALUE_2);
});
