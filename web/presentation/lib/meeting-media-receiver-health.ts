import type { ReceivedMediaQuality } from "@readymeet/shared";
import type { RemoteVideoTrack } from "livekit-client";

import { boundedMetric as bounded, qualityCodec } from "../../domain/meeting-media-stats";

const LINT_NUM_N7500 = 7500;
const LINT_NUM_N1000 = 1000;
const LINT_NUM_N16384 = 16384;
const LINT_NUM_N240 = 240;
const LINT_NUM_N8 = 8;
const LINT_NUM_N1_000_000_000 = 1_000_000_000;
const LINT_NUM_N640 = 640;
const LINT_NUM_N360 = 360;
const LINT_NUM_N2 = 2;
const LINT_NUM_N20_000 = 20_000;

export type DisplaySize = { width: number; height: number };

type ReceiverHealthSample = {
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
  codec: ReturnType<typeof qualityCodec>;
  qualitySignal: ReceivedMediaQuality["qualitySignal"];
  displayWidth: number | null;
  displayHeight: number | null;
  packetLoss: number | null;
  freezeCount: number | null;
};

function resolveReceiverQualitySignal(input: {
  condition: ReceivedMediaQuality["qualitySignal"];
  now: number;
  since: number | undefined;
}): ReceivedMediaQuality["qualitySignal"] {
  if (input.condition === "unknown" || input.condition === "normal") {
    return input.condition;
  }

  return input.now - (input.since ?? input.now) >= LINT_NUM_N20_000 ? input.condition : "normal";
}

function isLargeVideoDisplay(display: DisplaySize | null) {
  return (
    display !== null &&
    Math.max(display.width, display.height) >= LINT_NUM_N640 &&
    Math.min(display.width, display.height) >= LINT_NUM_N360
  );
}

function isReceiverSampleContinuous(input: {
  previous?: {
    id: string;
    at: number;
    bytes: number | null;
    frames: number | null;
    packets: number | null;
    lost: number | null;
  };
  currentId: string;
  now: number;
}) {
  return (
    input.previous !== undefined &&
    input.currentId === input.previous.id &&
    input.now > input.previous.at &&
    input.now - input.previous.at <= LINT_NUM_N7500
  );
}

function buildReceiverCounter(input: { stat: Record<string, unknown> | undefined; now: number }) {
  return {
    id: typeof input.stat?.id === "string" || typeof input.stat?.id === "number" ? String(input.stat.id) : "",
    at: input.now,
    bytes: bounded({ value: input.stat?.bytesReceived, max: Number.MAX_SAFE_INTEGER }),
    frames: bounded({ value: input.stat?.framesDecoded, max: Number.MAX_SAFE_INTEGER }),
    packets: bounded({ value: input.stat?.packetsReceived, max: Number.MAX_SAFE_INTEGER }),
    lost: bounded({ value: input.stat?.packetsLost, max: Number.MAX_SAFE_INTEGER }),
  };
}

function receiverPacketLoss(input: { packets: number | null; lost: number | null }) {
  return input.packets !== null && input.lost !== null && input.packets + input.lost > 0
    ? input.lost / (input.packets + input.lost)
    : null;
}

function selectInboundVideoStat(report: RTCStatsReport | undefined) {
  const selected: { stat?: Record<string, unknown> } = {};
  report?.forEach((entry) => {
    if (isInboundRtpStat(entry)) {
      selected.stat = entry;
    }
  });

  return selected.stat;
}

function classifyReceiverHealthCondition(input: {
  display: DisplaySize | null;
  isValid: boolean;
  fps: number | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  isLargeDisplay: boolean;
}): ReceivedMediaQuality["qualitySignal"] {
  if (input.display === null || !input.isValid || input.fps === null) {
    return "unknown";
  }
  if (input.frames === 0) {
    return "sustained-no-frames";
  }
  if (input.width === null || input.height === null) {
    return "unknown";
  }
  if (
    input.isLargeDisplay &&
    Math.max(input.width, input.height) < Math.max(input.display.width, input.display.height) / LINT_NUM_N2
  ) {
    return "sustained-low-resolution";
  }

  return "normal";
}

function isRtcStatsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function computeReceiverHealthMetrics(input: {
  isValid: boolean;
  current: {
    id: string;
    at: number;
    bytes: number | null;
    frames: number | null;
    packets: number | null;
    lost: number | null;
  };
  previous?: {
    id: string;
    at: number;
    bytes: number | null;
    frames: number | null;
    packets: number | null;
    lost: number | null;
  };
  now: number;
  stat?: Record<string, unknown>;
  report: RTCStatsReport | undefined;
}) {
  const delta = (key: "bytes" | "frames" | "packets" | "lost") =>
    input.isValid &&
    input.previous !== undefined &&
    input.current[key] !== null &&
    input.previous[key] !== null &&
    input.current[key] >= input.previous[key]
      ? input.current[key] - input.previous[key]
      : null;
  const seconds = input.isValid && input.previous !== undefined ? (input.now - input.previous.at) / LINT_NUM_N1000 : 0;
  const bytes = delta("bytes");
  const frames = delta("frames");
  const packets = delta("packets");
  const lost = delta("lost");
  const width = bounded({ value: input.stat?.frameWidth, max: LINT_NUM_N16384 });
  const height = bounded({ value: input.stat?.frameHeight, max: LINT_NUM_N16384 });
  const fps = bounded({ value: frames === null ? null : frames / seconds, max: LINT_NUM_N240 });
  const bitrate = bounded({
    value: bytes === null ? null : (bytes * LINT_NUM_N8) / seconds,
    max: LINT_NUM_N1_000_000_000,
  });

  return {
    bytes,
    frames,
    packets,
    lost,
    width,
    height,
    fps,
    bitrate,
    codec: qualityCodec({ report: input.report, stat: input.stat }),
  };
}

function isInboundRtpStat(value: unknown): value is Record<string, unknown> {
  if (!isRtcStatsRecord(value)) {
    return false;
  }
  if (value.type !== "inbound-rtp") {
    return false;
  }

  return value.kind === "video" || value.mediaType === "video";
}

/** CSS display size, not a claim about the SFU's requested or selected layer. */
export function displayedVideoSize(track: RemoteVideoTrack): DisplaySize | null {
  if (typeof document === "undefined" || document.visibilityState !== "visible") {
    return null;
  }

  return track.attachedElements.reduce<DisplaySize | null>((largest, element) => {
    if (!element.isConnected) {
      return largest;
    }
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return largest;
    }
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth
    ) {
      return largest;
    }
    if (!largest || rect.width * rect.height > largest.width * largest.height) {
      return { width: rect.width, height: rect.height };
    }

    return largest;
  }, null);
}

/** Observation only. A resolution mismatch can reflect source quality, layout,
 * bandwidth or a receiver issue; it is never sufficient to restart a camera. */
export class ReceiverHealthMonitor {
  private previous?: {
    id: string;
    at: number;
    bytes: number | null;
    frames: number | null;
    packets: number | null;
    lost: number | null;
  };

  private since?: number;
  private condition?: string;

  sample(input: {
    report: RTCStatsReport | undefined;
    display: DisplaySize | null;
    now: number;
  }): ReceiverHealthSample {
    return this.sampleNamed(input);
  }

  private sampleNamed(input: {
    report: RTCStatsReport | undefined;
    display: DisplaySize | null;
    now: number;
  }): ReceiverHealthSample {
    const { report, display, now } = input;
    const stat = selectInboundVideoStat(report);
    const current = buildReceiverCounter({ stat, now });
    const previous = this.previous;
    const isValid = isReceiverSampleContinuous({ previous, currentId: current.id, now });
    const { frames, packets, lost, width, height, fps, bitrate, codec } = computeReceiverHealthMetrics({
      isValid,
      current,
      previous,
      now,
      stat,
      report,
    });
    const isLargeDisplay = isLargeVideoDisplay(display);
    const condition = classifyReceiverHealthCondition({
      display,
      isValid,
      fps,
      frames,
      width,
      height,
      isLargeDisplay,
    });
    if (!isValid || condition !== this.condition) {
      this.since = now;
    }
    this.condition = condition;
    this.previous = current;
    const qualitySignal = resolveReceiverQualitySignal({ condition, now, since: this.since });

    return {
      width,
      height,
      fps,
      bitrate,
      codec,
      qualitySignal,
      displayWidth: bounded({ value: display?.width, max: LINT_NUM_N16384 }),
      displayHeight: bounded({ value: display?.height, max: LINT_NUM_N16384 }),
      packetLoss: receiverPacketLoss({ packets, lost }),
      freezeCount: bounded({ value: stat?.freezeCount, max: Number.MAX_SAFE_INTEGER }),
    };
  }
}
