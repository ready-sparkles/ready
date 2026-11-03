import { mediaQualityDiagnosticSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { ReceiverHealthMonitor } from "../../../presentation/lib/meeting-media-receiver-health";

const FRAMES_DECODED_PER_MS = 0.03;

const TEST_VALUE_10 = 10;
const TEST_VALUE_100 = 100;
const TEST_VALUE_100000 = 100000;
const TEST_VALUE_105000 = 105000;
const TEST_VALUE_112000 = 112000;
const TEST_VALUE_1280 = 1280;
const TEST_VALUE_14 = 14;
const TEST_VALUE_180 = 180;
const TEST_VALUE_2 = 2;
const TEST_VALUE_25000 = 25000;
const TEST_VALUE_270 = 270;
const TEST_VALUE_30 = 30;
const TEST_VALUE_30000 = 30000;
const TEST_VALUE_320 = 320;
const TEST_VALUE_35000 = 35000;
const TEST_VALUE_480 = 480;
const TEST_VALUE_50 = 50;
const TEST_VALUE_5000 = 5000;
const TEST_VALUE_5050 = 5050;
const TEST_VALUE_60000 = 60000;
const TEST_VALUE_65000 = 65000;
const TEST_VALUE_720 = 720;
const TEST_VALUE_90000 = 90000;
const TEST_VALUE_95000 = 95000;
const MISSING_RECEIVER_HEALTH_SAMPLE_MESSAGE = "Expected a receiver health sample.";

function isRtcStatsReport(value: object): value is RTCStatsReport {
  return value instanceof Map;
}

function report(input: { at: number; overrides?: Record<string, unknown> }) {
  const overrides = input.overrides ?? {};

  const stats = new Map([
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
        bytesReceived: input.at * TEST_VALUE_14,
        framesDecoded: input.at * FRAMES_DECODED_PER_MS,
        packetsReceived: input.at,
        packetsLost: input.at / TEST_VALUE_100,
        freezeCount: TEST_VALUE_2,
        ...overrides,
      },
    ],
  ]);

  if (!isRtcStatsReport(stats)) {
    throw new Error(MISSING_RECEIVER_HEALTH_SAMPLE_MESSAGE);
  }

  return stats;
}
const large = { width: TEST_VALUE_1280, height: TEST_VALUE_720 };

function sampleInstants({
  start,
  end,
  step,
  isInclusive,
}: {
  start: number;
  end: number;
  step: number;
  isInclusive: boolean;
}) {
  const span = (end - start) / step;
  const count = isInclusive ? Math.floor(span) + 1 : Math.ceil(span);

  return Array.from({ length: count }, (_, index) => start + index * step);
}

void test("flags sustained low resolution on a large video, not a low bitrate alone", () => {
  const monitor = new ReceiverHealthMonitor();
  assert.equal(monitor.sample({ report: report({ at: 0 }), display: large, now: 0 }).bitrate, null);
  sampleInstants({ start: TEST_VALUE_5000, end: TEST_VALUE_25000, step: TEST_VALUE_5000, isInclusive: false }).forEach(
    (at) => {
      assert.equal(monitor.sample({ report: report({ at }), display: large, now: at }).qualitySignal, "normal");
    },
  );
  const result = monitor.sample({
    report: report({ at: TEST_VALUE_25000 }),
    display: large,
    now: TEST_VALUE_25000,
  });
  assert.equal(result.qualitySignal, "sustained-low-resolution");
  assert.equal(result.bitrate, TEST_VALUE_112000);
  assert.equal(result.fps, TEST_VALUE_30);
  assert.equal(result.packetLoss, TEST_VALUE_50 / TEST_VALUE_5050);
  assert.equal(result.freezeCount, TEST_VALUE_2);
  assert.equal(
    monitor.sample({
      report: report({
        at: TEST_VALUE_30000,
        overrides: { frameWidth: TEST_VALUE_1280, frameHeight: TEST_VALUE_720 },
      }),
      display: large,
      now: TEST_VALUE_30000,
    }).qualitySignal,
    "normal",
  );
});
void test("small tiles, hidden video, missing stats and sampling gaps cannot accumulate poor quality time", () => {
  const monitor = new ReceiverHealthMonitor();
  sampleInstants({ start: 0, end: TEST_VALUE_60000, step: TEST_VALUE_5000, isInclusive: true }).forEach((at) => {
    assert.notEqual(
      monitor.sample({ report: report({ at }), display: { width: TEST_VALUE_320, height: TEST_VALUE_180 }, now: at })
        .qualitySignal,
      "sustained-low-resolution",
    );
  });
  monitor.sample({ report: report({ at: TEST_VALUE_65000 }), display: large, now: TEST_VALUE_65000 });
  assert.equal(
    monitor.sample({ report: report({ at: TEST_VALUE_90000 }), display: large, now: TEST_VALUE_90000 }).qualitySignal,
    "unknown",
  );
  assert.equal(
    monitor.sample({ report: report({ at: TEST_VALUE_95000 }), display: null, now: TEST_VALUE_95000 }).qualitySignal,
    "unknown",
  );
  assert.equal(monitor.sample({ report: undefined, display: large, now: TEST_VALUE_100000 }).fps, null);
  assert.equal(
    monitor.sample({ report: report({ at: TEST_VALUE_105000 }), display: large, now: TEST_VALUE_105000 }).qualitySignal,
    "unknown",
  );
});
void test("stalled decoded frames trigger a sustained signal and reset counters stay unknown", () => {
  const monitor = new ReceiverHealthMonitor();
  sampleInstants({ start: 0, end: TEST_VALUE_25000, step: TEST_VALUE_5000, isInclusive: true }).forEach((at) => {
    const result = monitor.sample({
      report: report({ at, overrides: { framesDecoded: TEST_VALUE_10 } }),
      display: large,
      now: at,
    });
    if (at === TEST_VALUE_25000) {
      assert.equal(result.qualitySignal, "sustained-no-frames");
    }
  });
  assert.equal(
    monitor.sample({
      report: report({ at: TEST_VALUE_30000, overrides: { framesDecoded: 0, bytesReceived: 0 } }),
      display: large,
      now: TEST_VALUE_30000,
    }).qualitySignal,
    "unknown",
  );
  assert.equal(
    monitor.sample({
      report: report({ at: TEST_VALUE_35000, overrides: { id: "replacement" } }),
      display: large,
      now: TEST_VALUE_35000,
    }).bitrate,
    null,
  );
});
void test("received reports accept bounded metrics but reject arbitrary transport and device data", () => {
  const health = new ReceiverHealthMonitor().sample({ report: report({ at: 0 }), display: large, now: 0 });
  const payload = {
    event: "media-quality",
    phase: "in-room",
    outcome: "changed",
    kind: "camera",
    trackSid: "TR_camera",
    direction: "received",
    sampledAt: 0,
    ...health,
  };
  assert.ok(mediaQualityDiagnosticSchema.safeParse(payload).success);
  [
    { sdp: "private" },
    { deviceLabel: "private" },
    { packetLoss: TEST_VALUE_2 },
    { displayWidth: Infinity },
    { level: 0 },
    { reason: "unknown" },
    { direction: "sent" },
  ].forEach((extra) => {
    assert.equal(mediaQualityDiagnosticSchema.safeParse({ ...payload, ...extra }).success, false);
  });
});

void test("a receiver that never decodes its first frame is flagged without dimensions", () => {
  const monitor = new ReceiverHealthMonitor();
  const samples = sampleInstants({ start: 0, end: TEST_VALUE_25000, step: TEST_VALUE_5000, isInclusive: true }).map(
    (at) =>
      monitor.sample({
        report: report({ at, overrides: { framesDecoded: 0, frameWidth: undefined, frameHeight: undefined } }),
        display: large,
        now: at,
      }),
  );
  const result = samples[samples.length - 1];
  if (result === undefined) {
    throw new Error(MISSING_RECEIVER_HEALTH_SAMPLE_MESSAGE);
  }
  assert.equal(result.qualitySignal, "sustained-no-frames");
  assert.equal(result.width, null);
  assert.equal(
    monitor.sample({ report: report({ at: TEST_VALUE_30000 }), display: large, now: TEST_VALUE_30000 }).qualitySignal,
    "normal",
  );
  assert.equal(
    monitor.sample({
      report: report({ at: TEST_VALUE_35000, overrides: { framesDecoded: undefined } }),
      display: large,
      now: TEST_VALUE_35000,
    }).qualitySignal,
    "unknown",
  );
});
