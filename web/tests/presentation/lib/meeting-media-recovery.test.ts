import type { LocalVideoTrack } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";

import {
  type CameraHealth,
  cameraHealth,
  CameraRecoveryActuator,
  CameraRecoveryController,
  type RecoveryAction,
} from "../../../presentation/lib/meeting-media-recovery";

const RECOVERY_ROUND_TRIP_TIME_SECONDS = 0.02;

const MESSAGE_EXPECTED_RECOVERY_PROBE = "Expected a recovery probe";
const MESSAGE_EXPECTED_APPLIED_CAMERA_CONSTRAINTS = "Expected applied camera constraints";

const TEST_VALUE_1000 = 1000;
const TEST_VALUE_10000 = 10000;
const TEST_VALUE_1080 = 1080;
const TEST_VALUE_11000 = 11000;
const TEST_VALUE_120000 = 120000;
const TEST_VALUE_125000 = 125000;
const TEST_VALUE_1280 = 1280;
const TEST_VALUE_130000 = 130000;
const TEST_VALUE_15 = 15;
const TEST_VALUE_15000 = 15000;
const TEST_VALUE_155000 = 155000;
const TEST_VALUE_16000 = 16000;
const TEST_VALUE_160000 = 160000;
const TEST_VALUE_180000 = 180000;
const TEST_VALUE_1920 = 1920;
const TEST_VALUE_2 = 2;
const TEST_VALUE_20 = 20;
const TEST_VALUE_20000 = 20000;
const TEST_VALUE_200000 = 200000;
const TEST_VALUE_205000 = 205000;
const TEST_VALUE_25 = 25;
const TEST_VALUE_25000 = 25000;
const TEST_VALUE_3 = 3;
const TEST_VALUE_30 = 30;
const TEST_VALUE_30000 = 30000;
const TEST_VALUE_325000 = 325000;
const TEST_VALUE_35000 = 35000;
const TEST_VALUE_360 = 360;
const TEST_VALUE_3_000_000 = 3_000_000;
const TEST_VALUE_3_600_000 = 3_600_000;
const TEST_VALUE_3_605_000 = 3_605_000;
const TEST_VALUE_3_625_000 = 3_625_000;
const TEST_VALUE_3_630_000 = 3_630_000;
const TEST_VALUE_3_750_000 = 3_750_000;
const TEST_VALUE_40000 = 40000;
const TEST_VALUE_45000 = 45000;
const TEST_VALUE_480 = 480;
const TEST_VALUE_5000 = 5000;
const TEST_VALUE_50000 = 50000;
const TEST_VALUE_5_000_000 = 5_000_000;
const TEST_VALUE_55000 = 55000;
const TEST_VALUE_60000 = 60000;
const TEST_VALUE_640 = 640;
const TEST_VALUE_70000 = 70000;
const TEST_VALUE_720 = 720;
const TEST_VALUE_720000 = 720000;
const TEST_VALUE_725000 = 725000;
const TEST_VALUE_75000 = 75000;
const TEST_VALUE_750000 = 750000;
const TEST_VALUE_755000 = 755000;
const TEST_VALUE_80000 = 80000;

const good: CameraHealth = {
  reason: "none",
  codec: "av1",
  width: TEST_VALUE_1920,
  height: TEST_VALUE_1080,
  fps: TEST_VALUE_30,
  bitrate: TEST_VALUE_3_000_000,
  availableBitrate: TEST_VALUE_5_000_000,
  rttMs: TEST_VALUE_25,
  powerEfficientEncoder: null,
};

function observeHealthWindow(input: {
  controller: CameraRecoveryController;
  reason: CameraHealth["reason"];
  from: number;
  to: number;
}): ReturnType<CameraRecoveryController["observe"]> {
  const stepCount = input.to < input.from ? 0 : Math.floor((input.to - input.from) / TEST_VALUE_5000) + 1;

  return Array.from({ length: stepCount }, (_, index) => input.from + index * TEST_VALUE_5000).reduce<
    ReturnType<CameraRecoveryController["observe"]>
  >((_latest, now) => input.controller.observe({ health: { ...good, reason: input.reason }, now }), undefined);
}

function isRtcStat(value: unknown): value is RTCStats {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof Reflect.get(value, "type") === "string"
  );
}

function isRtcStatsReport(value: unknown): value is RTCStatsReport {
  return value instanceof Map && [...value.values()].every((stat) => isRtcStat(stat));
}

function isOutboundRtpStreamStats(value: RTCStats): value is RTCOutboundRtpStreamStats {
  return value.type === "outbound-rtp";
}

function rtcStatFixture(input: { type: string; fields: Record<string, unknown> }): RTCStats {
  const stat: unknown = { type: input.type, ...input.fields };
  assert.ok(isRtcStat(stat));

  return stat;
}

function outboundRtpVideoStat(input: {
  reason: string;
  overrides?: Record<string, unknown>;
}): RTCOutboundRtpStreamStats {
  const overrides = input.overrides ?? {};
  const stat: unknown = {
    id: "out",
    type: "outbound-rtp",
    kind: "video",
    frameWidth: TEST_VALUE_1920,
    frameHeight: TEST_VALUE_1080,
    framesPerSecond: TEST_VALUE_30,
    qualityLimitationReason: input.reason,
    bytesSent: TEST_VALUE_1000,
    codecId: "codec",
    transportId: "transport",
    ...overrides,
  };
  assert.ok(isRtcStat(stat) && isOutboundRtpStreamStats(stat));

  return stat;
}

function statsReportFixture(input: { reason: string; overrides?: Record<string, unknown> }): RTCStatsReport {
  const report = new Map<string, RTCStats>([
    ["out", outboundRtpVideoStat(input)],
    ["codec", rtcStatFixture({ type: "codec", fields: { mimeType: "video/AV1" } })],
    ["transport", rtcStatFixture({ type: "transport", fields: { selectedCandidatePairId: "pair" } })],
    [
      "pair",
      rtcStatFixture({
        type: "candidate-pair",
        fields: {
          availableOutgoingBitrate: TEST_VALUE_5_000_000,
          currentRoundTripTime: RECOVERY_ROUND_TRIP_TIME_SECONDS,
        },
      }),
    ],
  ]);
  assert.ok(isRtcStatsReport(report));

  return report;
}

function requireRecoveryAction(value: RecoveryAction | undefined): RecoveryAction {
  assert.ok(value !== undefined);

  return value;
}

function isLocalVideoTrack(value: unknown): value is LocalVideoTrack {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === "video" && "mediaStreamTrack" in value
  );
}

function localVideoTrackFixture(input: { mediaStreamTrack: MediaStreamTrack }): LocalVideoTrack {
  const track = {
    kind: "video",
    mediaStreamTrack: input.mediaStreamTrack,
    getProcessor: () => undefined,
  };
  assert.ok(isLocalVideoTrack(track));

  return track;
}

function isMediaStreamTrack(value: unknown): value is MediaStreamTrack {
  return (
    typeof value === "object" &&
    value !== null &&
    "getSettings" in value &&
    "applyConstraints" in value &&
    "getConstraints" in value
  );
}

void test("only sustained CPU pressure reduces quality, with a cooldown and commit after device success", () => {
  (["bandwidth", "unknown", "other", "none"] as const).forEach((reason) => {
    assert.equal(
      observeHealthWindow({ controller: new CameraRecoveryController(), reason, from: 0, to: TEST_VALUE_60000 }),
      undefined,
    );
  });
  const c = new CameraRecoveryController();
  assert.equal(observeHealthWindow({ controller: c, reason: "cpu", from: 0, to: TEST_VALUE_15000 }), undefined);
  const action = c.observe({ health: { ...good, reason: "cpu" }, now: TEST_VALUE_20000 });
  assert.deepEqual(action, { action: "reduce", level: 1 });
  assert.equal(c.level, 0);
  c.applied({ action: requireRecoveryAction(action), now: TEST_VALUE_20000 });
  assert.equal(
    observeHealthWindow({ controller: c, reason: "cpu", from: TEST_VALUE_25000, to: TEST_VALUE_45000 }),
    undefined,
  );
  assert.deepEqual(c.observe({ health: { ...good, reason: "cpu" }, now: TEST_VALUE_50000 }), {
    action: "reduce",
    level: TEST_VALUE_2,
  });
});

void test("sleep, mute, stopped frames and missing measurements break the pressure window", () => {
  const c = new CameraRecoveryController();
  observeHealthWindow({ controller: c, reason: "cpu", from: 0, to: TEST_VALUE_15000 });
  assert.equal(c.observe({ health: { ...good, reason: "cpu" }, now: TEST_VALUE_30000 }), undefined);
  observeHealthWindow({ controller: c, reason: "cpu", from: TEST_VALUE_35000, to: TEST_VALUE_40000 });
  c.resetWindow();
  assert.equal(c.observe({ health: { ...good, reason: "cpu" }, now: TEST_VALUE_45000 }), undefined);
  c.observe({ health: { ...good, reason: "cpu", fps: 0 }, now: TEST_VALUE_50000 });
  assert.equal(
    observeHealthWindow({ controller: c, reason: "cpu", from: TEST_VALUE_55000, to: TEST_VALUE_70000 }),
    undefined,
  );
  c.observe({ health: { ...good, reason: "unknown" }, now: TEST_VALUE_75000 });
  assert.equal(c.observe({ health: { ...good, reason: "cpu" }, now: TEST_VALUE_80000 }), undefined);
});

void test("recovery requires two healthy minutes and a failed upward probe delays another attempt", () => {
  const c = new CameraRecoveryController();
  c.applied({ action: { action: "reduce", level: TEST_VALUE_2 }, now: 0 });
  assert.equal(
    observeHealthWindow({ controller: c, reason: "none", from: TEST_VALUE_5000, to: TEST_VALUE_120000 }),
    undefined,
  );
  const action = c.observe({ health: good, now: TEST_VALUE_125000 });
  assert.deepEqual(action, { action: "recover", level: 1 });
  c.applied({ action: requireRecoveryAction(action), now: TEST_VALUE_125000 });
  const relapse = observeHealthWindow({
    controller: c,
    reason: "cpu",
    from: TEST_VALUE_130000,
    to: TEST_VALUE_155000,
  });
  assert.deepEqual(relapse, { action: "reduce", level: TEST_VALUE_2 });
  c.applied({ action: requireRecoveryAction(relapse), now: TEST_VALUE_155000 });
  assert.equal(
    observeHealthWindow({ controller: c, reason: "none", from: TEST_VALUE_160000, to: TEST_VALUE_750000 }),
    undefined,
  );
  assert.deepEqual(c.observe({ health: good, now: TEST_VALUE_755000 }), { action: "recover", level: 1 });
});

void test("a rejected reduction retries after the cooldown and maximum reduction is bounded", () => {
  const c = new CameraRecoveryController();
  const reduce = observeHealthWindow({ controller: c, reason: "cpu", from: 0, to: TEST_VALUE_20000 });
  assert.deepEqual(reduce, { action: "reduce", level: 1 });
  c.failed({ action: requireRecoveryAction(reduce), now: TEST_VALUE_20000 });
  assert.equal(c.level, 0);
  assert.equal(
    observeHealthWindow({ controller: c, reason: "cpu", from: TEST_VALUE_25000, to: TEST_VALUE_45000 }),
    undefined,
    "cooldown still applies",
  );
  assert.deepEqual(
    c.observe({ health: { ...good, reason: "cpu" }, now: TEST_VALUE_50000 }),
    { action: "reduce", level: 1 },
    "CPU relief is not locked out",
  );
  c.applied({ action: { action: "reduce", level: TEST_VALUE_3 }, now: TEST_VALUE_50000 });
  assert.equal(
    observeHealthWindow({ controller: c, reason: "cpu", from: TEST_VALUE_55000, to: TEST_VALUE_180000 }),
    undefined,
  );
});

void test("a rejected upward probe waits ten minutes without blocking CPU relief", () => {
  const c = new CameraRecoveryController();
  c.applied({ action: { action: "reduce", level: 1 }, now: 0 });
  const probe = observeHealthWindow({
    controller: c,
    reason: "none",
    from: TEST_VALUE_5000,
    to: TEST_VALUE_125000,
  });
  assert.deepEqual(probe, { action: "recover", level: 0 });
  c.failed({ action: requireRecoveryAction(probe), now: TEST_VALUE_125000 });
  assert.equal(c.level, 1);
  assert.equal(
    observeHealthWindow({ controller: c, reason: "none", from: TEST_VALUE_130000, to: TEST_VALUE_720000 }),
    undefined,
  );
  assert.deepEqual(c.observe({ health: good, now: TEST_VALUE_725000 }), { action: "recover", level: 0 });
  const relief = new CameraRecoveryController();
  relief.applied({ action: { action: "reduce", level: 1 }, now: 0 });
  const failedProbe = observeHealthWindow({
    controller: relief,
    reason: "none",
    from: TEST_VALUE_5000,
    to: TEST_VALUE_125000,
  });
  if (failedProbe === undefined) {
    throw new Error(MESSAGE_EXPECTED_RECOVERY_PROBE);
  }
  relief.failed({ action: failedProbe, now: TEST_VALUE_125000 });
  assert.deepEqual(
    observeHealthWindow({
      controller: relief,
      reason: "cpu",
      from: TEST_VALUE_130000,
      to: TEST_VALUE_155000,
    }),
    {
      action: "reduce",
      level: TEST_VALUE_2,
    },
  );
});

void test("CPU pressure long after a successful probe does not delay the next probe", () => {
  const c = new CameraRecoveryController();
  c.applied({ action: { action: "reduce", level: 1 }, now: 0 });
  const probe = observeHealthWindow({
    controller: c,
    reason: "none",
    from: TEST_VALUE_5000,
    to: TEST_VALUE_125000,
  });
  c.applied({ action: requireRecoveryAction(probe), now: TEST_VALUE_125000 });
  observeHealthWindow({ controller: c, reason: "none", from: TEST_VALUE_130000, to: TEST_VALUE_3_600_000 });
  const reduce = observeHealthWindow({
    controller: c,
    reason: "cpu",
    from: TEST_VALUE_3_605_000,
    to: TEST_VALUE_3_625_000,
  });
  assert.deepEqual(reduce, { action: "reduce", level: 1 });
  c.applied({ action: requireRecoveryAction(reduce), now: TEST_VALUE_3_625_000 });
  assert.deepEqual(
    observeHealthWindow({
      controller: c,
      reason: "none",
      from: TEST_VALUE_3_630_000,
      to: TEST_VALUE_3_750_000,
    }),
    { action: "recover", level: 0 },
  );
});

void test("levels that would not change the capture are skipped in both directions", () => {
  const c = new CameraRecoveryController();
  c.levels = [0, TEST_VALUE_3];
  assert.deepEqual(observeHealthWindow({ controller: c, reason: "cpu", from: 0, to: TEST_VALUE_20000 }), {
    action: "reduce",
    level: TEST_VALUE_3,
  });
  c.applied({ action: { action: "reduce", level: TEST_VALUE_3 }, now: TEST_VALUE_20000 });
  assert.equal(
    observeHealthWindow({ controller: c, reason: "cpu", from: TEST_VALUE_25000, to: TEST_VALUE_200000 }),
    undefined,
  );
  assert.deepEqual(
    observeHealthWindow({ controller: c, reason: "none", from: TEST_VALUE_205000, to: TEST_VALUE_325000 }),
    { action: "recover", level: 0 },
  );
  const fixed = new CameraRecoveryController();
  fixed.levels = [0];
  assert.equal(
    observeHealthWindow({ controller: fixed, reason: "cpu", from: 0, to: TEST_VALUE_120000 }),
    undefined,
    "nothing to reduce",
  );
});

void test("health combines active primary/backup reasons, separates bandwidth estimates and rejects counter resets", () => {
  const first = cameraHealth({
    reports: [
      statsReportFixture({ reason: "none" }),
      statsReportFixture({
        reason: "cpu",
        overrides: { id: "backup", frameWidth: TEST_VALUE_640, frameHeight: TEST_VALUE_360 },
      }),
    ],
    previous: undefined,
    now: 0,
  });
  assert.equal(first.health.reason, "cpu");
  assert.equal(first.health.width, TEST_VALUE_1920);
  assert.equal(first.health.codec, "av1");
  assert.equal(first.health.availableBitrate, TEST_VALUE_5_000_000);
  assert.equal(first.health.rttMs, TEST_VALUE_20);
  assert.equal(first.health.bitrate, null);
  assert.equal(
    cameraHealth({ reports: [statsReportFixture({ reason: "cpu" }), statsReportFixture({ reason: "bandwidth" })] })
      .health.reason,
    "bandwidth",
  );
  assert.equal(
    cameraHealth({
      reports: [
        statsReportFixture({ reason: "none" }),
        statsReportFixture({ reason: "cpu", overrides: { framesPerSecond: 0 } }),
      ],
    }).health.reason,
    "none",
  );
  assert.equal(
    cameraHealth({
      reports: [statsReportFixture({ reason: "none", overrides: { qualityLimitationReason: undefined } })],
    }).health.reason,
    "unknown",
  );
  const base = cameraHealth({ reports: [statsReportFixture({ reason: "none" })], previous: undefined, now: 0 });
  const next = cameraHealth({
    reports: [statsReportFixture({ reason: "none", overrides: { bytesSent: TEST_VALUE_11000 } })],
    previous: base.counter,
    now: TEST_VALUE_5000,
  });
  assert.equal(next.health.bitrate, TEST_VALUE_16000);
  assert.equal(
    cameraHealth({ reports: [statsReportFixture({ reason: "none" })], previous: next.counter, now: TEST_VALUE_10000 })
      .health.bitrate,
    null,
  );
  assert.equal(
    cameraHealth({
      reports: [statsReportFixture({ reason: "none", overrides: { id: "new" } })],
      previous: base.counter,
      now: TEST_VALUE_5000,
    }).health.bitrate,
    null,
  );
  assert.equal(
    cameraHealth({ reports: [statsReportFixture({ reason: "none", overrides: { framesPerSecond: NaN } })] }).health.fps,
    null,
  );
});

void test("actuator preserves camera identity/device, reduces cadence before resolution, and restores constraints", async () => {
  const original = {
    deviceId: { exact: "camera" },
    width: { max: TEST_VALUE_1080 },
    height: { max: TEST_VALUE_1920 },
    frameRate: { max: TEST_VALUE_30 },
  };
  const appliedRecorder = { constraints: [] as MediaTrackConstraints[] };
  const capture = {
    readyState: "live" as MediaStreamTrackState,
    getConstraints: () => original,
    getSettings: () => ({ width: TEST_VALUE_1080, height: TEST_VALUE_1920, frameRate: TEST_VALUE_30 }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      appliedRecorder.constraints = [...appliedRecorder.constraints, constraints];
    },
  };
  assert.ok(isMediaStreamTrack(capture));
  const actuator = new CameraRecoveryActuator(localVideoTrackFixture({ mediaStreamTrack: capture }));
  assert.equal(actuator.capture, capture);
  await [1, TEST_VALUE_2, TEST_VALUE_3, TEST_VALUE_2, 0].reduce(async (previous, level) => {
    await previous;
    await actuator.apply(level);
  }, Promise.resolve());
  const applied = appliedRecorder.constraints;
  assert.deepEqual(applied[0], {
    ...original,
    width: { ideal: TEST_VALUE_1080, max: TEST_VALUE_1080 },
    height: { ideal: TEST_VALUE_1920, max: TEST_VALUE_1920 },
    frameRate: { ideal: TEST_VALUE_20, max: TEST_VALUE_20 },
  });
  const reducedFrameRate = applied[1]?.frameRate;
  const reducedWidth = applied[TEST_VALUE_2]?.width;
  const reducedHeight = applied[TEST_VALUE_2]?.height;
  if (reducedFrameRate === undefined || reducedWidth === undefined || reducedHeight === undefined) {
    throw new Error(MESSAGE_EXPECTED_APPLIED_CAMERA_CONSTRAINTS);
  }
  assert.deepEqual(reducedFrameRate, { ideal: TEST_VALUE_15, max: TEST_VALUE_15 });
  assert.deepEqual(reducedWidth, { ideal: TEST_VALUE_720, max: TEST_VALUE_720 });
  assert.deepEqual(reducedHeight, { ideal: TEST_VALUE_1280, max: TEST_VALUE_1280 });
  assert.equal(applied[4], original);
  capture.readyState = "ended";
  await assert.rejects(actuator.apply(1));
});

function fakeCapture(input: { settings: MediaTrackSettings; original?: MediaTrackConstraints }) {
  const original = input.original ?? {};
  const appliedRecorder = { constraints: [] as MediaTrackConstraints[] };
  const capture = {
    readyState: "live" as MediaStreamTrackState,
    settings: input.settings,
    getConstraints: () => original,
    getSettings: () => capture.settings,
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      appliedRecorder.constraints = [...appliedRecorder.constraints, constraints];
    },
  };
  assert.ok(isMediaStreamTrack(capture));

  return {
    capture,
    applied: () => appliedRecorder.constraints,
    actuator: new CameraRecoveryActuator(localVideoTrackFixture({ mediaStreamTrack: capture })),
  };
}

void test("actuator levels include only steps that change cadence or size", () => {
  assert.deepEqual(
    fakeCapture({
      settings: { width: TEST_VALUE_1920, height: TEST_VALUE_1080, frameRate: TEST_VALUE_30 },
    }).actuator.levels(),
    [0, 1, TEST_VALUE_2, TEST_VALUE_3],
  );
  assert.deepEqual(
    fakeCapture({
      settings: { width: TEST_VALUE_1080, height: TEST_VALUE_1920, frameRate: TEST_VALUE_15 },
    }).actuator.levels(),
    [0, TEST_VALUE_3],
  );
  assert.deepEqual(
    fakeCapture({
      settings: { width: TEST_VALUE_1280, height: TEST_VALUE_720, frameRate: TEST_VALUE_20 },
    }).actuator.levels(),
    [0, TEST_VALUE_2],
  );
  assert.deepEqual(
    fakeCapture({
      settings: { width: TEST_VALUE_640, height: TEST_VALUE_480, frameRate: TEST_VALUE_15 },
    }).actuator.levels(),
    [0],
  );
});

void test("actuator follows the camera orientation at apply time", async () => {
  const original = { deviceId: { exact: "camera" }, width: { max: TEST_VALUE_1280 }, height: { max: TEST_VALUE_720 } };
  const { capture, applied, actuator } = fakeCapture({
    settings: { width: TEST_VALUE_1280, height: TEST_VALUE_720, frameRate: TEST_VALUE_30 },
    original,
  });
  capture.settings = { width: TEST_VALUE_720, height: TEST_VALUE_1280, frameRate: TEST_VALUE_30 };
  await actuator.apply(1);
  assert.deepEqual(applied()[0], {
    ...original,
    width: { ideal: TEST_VALUE_720, max: TEST_VALUE_720 },
    height: { ideal: TEST_VALUE_1280, max: TEST_VALUE_1280 },
    frameRate: { ideal: TEST_VALUE_20, max: TEST_VALUE_20 },
  });
  await actuator.apply(0);
  assert.deepEqual(applied()[1], {
    deviceId: { exact: "camera" },
    width: { max: TEST_VALUE_720 },
    height: { max: TEST_VALUE_1280 },
  });
  capture.settings = { width: TEST_VALUE_1280, height: TEST_VALUE_720, frameRate: TEST_VALUE_20 };
  await actuator.apply(0);
  assert.equal(applied()[TEST_VALUE_2], original);
});

void test("lost caps reset control without losing the original restoration baseline", async () => {
  const original = {
    width: { max: TEST_VALUE_1920 },
    height: { max: TEST_VALUE_1080 },
    frameRate: { max: TEST_VALUE_30 },
  };
  const constraints: { current: MediaTrackConstraints } = { current: original };
  const capture = {
    readyState: "live" as MediaStreamTrackState,
    getConstraints: () => constraints.current,
    getSettings: () => ({ width: TEST_VALUE_1920, height: TEST_VALUE_1080, frameRate: TEST_VALUE_30 }),
    applyConstraints: async (next: MediaTrackConstraints) => {
      constraints.current = next;
    },
  };
  assert.ok(isMediaStreamTrack(capture));
  const actuator = new CameraRecoveryActuator(localVideoTrackFixture({ mediaStreamTrack: capture }));
  const controller = new CameraRecoveryController();
  await actuator.apply(TEST_VALUE_3);
  controller.applied({ action: { action: "reduce", level: TEST_VALUE_3 }, now: 0 });
  assert.equal(actuator.hasLostCaps(TEST_VALUE_3), false);
  constraints.current = original; // SDK stopProcessor restores its constraints on the same source.
  assert.equal(actuator.hasLostCaps(TEST_VALUE_3), true);
  controller.resetCapture();
  assert.equal(
    observeHealthWindow({ controller, reason: "cpu", from: TEST_VALUE_5000, to: TEST_VALUE_20000 }),
    undefined,
  );
  assert.deepEqual(observeHealthWindow({ controller, reason: "cpu", from: TEST_VALUE_25000, to: TEST_VALUE_25000 }), {
    action: "reduce",
    level: 1,
  });
  await actuator.apply(1);
  assert.equal(actuator.hasLostCaps(1), false);
  await actuator.apply(0);
  assert.deepEqual(constraints.current, original);
});
