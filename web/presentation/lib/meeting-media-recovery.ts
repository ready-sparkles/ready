import type { SentMediaQuality } from "@readymeet/shared";
import type { LocalVideoTrack } from "livekit-client";

import { boundedMetric as number, qualityCodec } from "../../domain/meeting-media-stats";

import { captureCaps, getMeetingCaptureTrack } from "./meeting-media-track";

type Reason = SentMediaQuality["reason"];
export type CameraHealth = Pick<
  SentMediaQuality,
  "reason" | "codec" | "width" | "height" | "fps" | "bitrate" | "availableBitrate" | "rttMs" | "powerEfficientEncoder"
>;
export type RecoveryAction = { level: number; action: "reduce" | "recover" };

const BITS_PER_BYTE = 8;
const MS_PER_SECOND = 1000;
const BITRATE_SCALE_NUMERATOR = BITS_PER_BYTE * MS_PER_SECOND;
const MAX_FRAME_DIMENSION = 16_384;
const MAX_FRAMES_PER_SECOND = 240;
const MAX_BITRATE_BPS = 1_000_000_000;
const MAX_ROUND_TRIP_MS = 120_000;
const RECOVERY_LEVEL_ZERO = 0;
const RECOVERY_LEVEL_ONE = 1;
const RECOVERY_LEVEL_TWO = 2;
const RECOVERY_LEVEL_THREE = 3;
const RECOVERY_LEVELS = [RECOVERY_LEVEL_ZERO, RECOVERY_LEVEL_ONE, RECOVERY_LEVEL_TWO, RECOVERY_LEVEL_THREE] as const;
const HD_LONG_EDGE = 1280;
const HD_SHORT_EDGE = 720;
const REDUCED_FPS_LEVEL_ONE = 20;
const REDUCED_FPS_LEVEL_TWO = 15;
const CAMERA_UNAVAILABLE_MESSAGE = "Camera unavailable.";
const CAMERA_PRESSURE_MS = 20_000;
const CAMERA_STABLE_MS = 120_000;
const CAMERA_COOLDOWN_MS = 30_000;
const CAMERA_MAX_SAMPLE_GAP_MS = 7_500;
const CAMERA_PROBE_RELAPSE_MS = 120_000;
const CAMERA_FAILED_PROBE_BACKOFF_MS = 600_000;
const CAMERA_REPORT_MS = 60_000;

export const CAMERA_RECOVERY = {
  pressureMs: CAMERA_PRESSURE_MS,
  stableMs: CAMERA_STABLE_MS,
  cooldownMs: CAMERA_COOLDOWN_MS,
  maxSampleGapMs: CAMERA_MAX_SAMPLE_GAP_MS,
  probeRelapseMs: CAMERA_PROBE_RELAPSE_MS,
  failedProbeBackoffMs: CAMERA_FAILED_PROBE_BACKOFF_MS,
  reportMs: CAMERA_REPORT_MS,
};

type OutboundVideoStream = { stat: OutboundRtpStats; report: RTCStatsReport; index: number };

/** lib.dom lags the WebRTC stats spec: Chrome reports powerEfficientEncoder and legacy mediaType. */
type OutboundRtpStats = RTCOutboundRtpStreamStats & {
  mediaType?: string;
  /** @external WebRTC RTCOutboundRtpStreamStats field */
  powerEfficientEncoder?: boolean;
};

function isOutboundVideoRtp(stat: RTCStats): stat is OutboundRtpStats {
  if (stat.type !== "outbound-rtp") {
    return false;
  }
  const outbound: Partial<OutboundRtpStats> = stat;

  return outbound.kind === "video" || outbound.mediaType === "video" || outbound.frameWidth !== undefined;
}

function collectOutboundVideoStreams(reports: (RTCStatsReport | undefined)[]): OutboundVideoStream[] {
  return reports.flatMap((report, index) =>
    report === undefined
      ? []
      : [...report.values()].flatMap((stat: RTCStats) => (isOutboundVideoRtp(stat) ? [{ stat, report, index }] : [])),
  );
}

function sortActiveStreams(streams: OutboundVideoStream[]): OutboundVideoStream[] {
  return [...streams.filter(({ stat }) => Number(stat.framesPerSecond) > 0)].sort(
    (a, b) =>
      Number(b.stat.frameWidth) * Number(b.stat.frameHeight) - Number(a.stat.frameWidth) * Number(a.stat.frameHeight),
  );
}

function resolveQualityReason(active: OutboundVideoStream[]): Reason {
  const reasons = active.map(({ stat }) => stat.qualityLimitationReason);
  if (reasons.includes("bandwidth")) {
    return "bandwidth";
  }
  if (reasons.includes("cpu")) {
    return "cpu";
  }
  if (reasons.length !== 0 && reasons.every((value) => value === "none")) {
    return "none";
  }
  if (reasons.includes("other")) {
    return "other";
  }

  return "unknown";
}

function readBitrate(input: {
  previous?: { at: number; bytes: number; ids: string };
  now: number;
  bytes: number;
  ids: string;
}): number | null {
  if (input.previous === undefined) {
    return null;
  }
  if (input.previous.ids !== input.ids) {
    return null;
  }
  if (input.now <= input.previous.at) {
    return null;
  }
  if (input.now - input.previous.at > CAMERA_RECOVERY.maxSampleGapMs) {
    return null;
  }
  if (input.bytes < input.previous.bytes) {
    return null;
  }

  return number({
    value: ((input.bytes - input.previous.bytes) * BITRATE_SCALE_NUMERATOR) / (input.now - input.previous.at),
    max: MAX_BITRATE_BPS,
  });
}

function isHealthSampleReady(health: CameraHealth): boolean {
  return (
    health.width !== null &&
    health.width !== 0 &&
    health.height !== null &&
    health.height !== 0 &&
    health.fps !== null &&
    health.fps !== 0 &&
    health.reason !== "unknown" &&
    health.reason !== "other"
  );
}

function readRoundTripSeconds(input: { remote: RTCStats | undefined; pair: RTCStats | undefined }): number | undefined {
  if (input.remote !== undefined && "roundTripTime" in input.remote && typeof input.remote.roundTripTime === "number") {
    return input.remote.roundTripTime;
  }
  if (
    input.pair !== undefined &&
    "currentRoundTripTime" in input.pair &&
    typeof input.pair.currentRoundTripTime === "number"
  ) {
    return input.pair.currentRoundTripTime;
  }

  return undefined;
}

function readAvailableOutgoingBitrate(pair: RTCStats | undefined): number | undefined {
  if (pair !== undefined && "availableOutgoingBitrate" in pair && typeof pair.availableOutgoingBitrate === "number") {
    return pair.availableOutgoingBitrate;
  }

  return undefined;
}

function buildStreamIds(streams: OutboundVideoStream[]): string {
  return [...streams.map(({ stat: streamStat, index }) => `${index}:${streamStat.id}`)].sort().join(",");
}

function isRtcStat(value: unknown): value is RTCStats {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function readReportStat(input: {
  report: RTCStatsReport | undefined;
  statId: string | undefined;
}): RTCStats | undefined {
  if (input.report === undefined || input.statId === undefined) {
    return undefined;
  }

  const stat: unknown = input.report.get(input.statId);

  return isRtcStat(stat) ? stat : undefined;
}

function readCandidatePair(input: {
  report: RTCStatsReport | undefined;
  transport: RTCStats | undefined;
}): RTCStats | undefined {
  if (
    input.transport === undefined ||
    !("selectedCandidatePairId" in input.transport) ||
    typeof input.transport.selectedCandidatePairId !== "string"
  ) {
    return undefined;
  }

  return readReportStat({ report: input.report, statId: input.transport.selectedCandidatePairId });
}

function readRtpTransportContext(primary: OutboundVideoStream | undefined): {
  remote: RTCStats | undefined;
  pair: RTCStats | undefined;
} {
  const stat = primary?.stat;
  const report = primary?.report;
  const transport = readReportStat({ report, statId: stat?.transportId });
  const pair = readCandidatePair({ report, transport });
  const remote = readReportStat({ report, statId: stat?.remoteId });

  return { remote, pair };
}

function readPowerEfficientEncoder(stat: OutboundRtpStats | undefined): boolean | null {
  if (stat === undefined) {
    return null;
  }
  const value: unknown = stat.powerEfficientEncoder;

  return typeof value === "boolean" ? value : null;
}

function sumOutboundBytes(streams: OutboundVideoStream[]): number {
  return streams.reduce(
    (sum, { stat: streamStat }) => sum + (number({ value: streamStat.bytesSent, max: Number.MAX_SAFE_INTEGER }) ?? 0),
    0,
  );
}

function buildCameraHealth(input: {
  active: OutboundVideoStream[];
  streams: OutboundVideoStream[];
  previous?: { at: number; bytes: number; ids: string };
  now: number;
}): CameraHealth {
  const primary = input.active[0];
  const stat = primary?.stat;
  const report = primary?.report;
  const { remote, pair } = readRtpTransportContext(primary);
  const bytes = sumOutboundBytes(input.streams);
  const ids = buildStreamIds(input.streams);
  const roundTripSeconds = readRoundTripSeconds({ remote, pair });

  return {
    /** @external SentMediaQuality wire field */
    powerEfficientEncoder: readPowerEfficientEncoder(stat),
    reason: resolveQualityReason(input.active),
    codec: qualityCodec({ report, stat }),
    width: number({ value: stat?.frameWidth, max: MAX_FRAME_DIMENSION }),
    height: number({ value: stat?.frameHeight, max: MAX_FRAME_DIMENSION }),
    fps: number({ value: stat?.framesPerSecond, max: MAX_FRAMES_PER_SECOND }),
    bitrate: readBitrate({ previous: input.previous, now: input.now, bytes, ids }),
    availableBitrate: number({ value: readAvailableOutgoingBitrate(pair), max: MAX_BITRATE_BPS }),
    rttMs: number({
      value: roundTripSeconds !== undefined ? roundTripSeconds * MS_PER_SECOND : undefined,
      max: MAX_ROUND_TRIP_MS,
    }),
  };
}

function findRecoveryAction(input: {
  controller: CameraRecoveryController;
  health: CameraHealth;
  now: number;
  elapsed: number;
}): RecoveryAction | undefined {
  const higher = input.controller.levels.find((level) => level > input.controller.level);
  const lower = input.controller.levels.filter((level) => level < input.controller.level).at(-1);
  if (input.health.reason === "cpu" && input.elapsed >= CAMERA_RECOVERY.pressureMs && higher !== undefined) {
    return { action: "reduce", level: higher };
  }
  if (
    input.health.reason === "none" &&
    input.elapsed >= CAMERA_RECOVERY.stableMs &&
    lower !== undefined &&
    input.controller.isRecoveryAllowed(input.now)
  ) {
    return { action: "recover", level: lower };
  }

  return undefined;
}

/** Commits only after constraints succeed. Missing stats, pauses and sleeps do
 * not count as healthy time. CPU pressure soon after an upward probe, or a
 * rejected probe, delays the next probe; a rejected reduction may retry after
 * the normal cooldown so CPU relief is never locked out. */
export class CameraRecoveryController {
  level = RECOVERY_LEVEL_ZERO;
  /** Levels that change the capture. The actuator narrows this per camera so a
   * no-op step (e.g. 20 fps on a 15 fps camera) never consumes a cooldown. */
  levels: readonly number[] = [...RECOVERY_LEVELS];
  private previous?: number;
  private since?: number;
  private reason?: Reason;
  private changedAt = -Infinity;
  private recoverAfter = -Infinity;
  private probedAt = -Infinity;

  isRecoveryAllowed(now: number): boolean {
    return now >= this.recoverAfter;
  }

  resetWindow(): void {
    this.previous = this.since = undefined;
    this.reason = undefined;
  }

  /** Fallback when caps lost to a processor reset cannot be re-applied: the
   * capture now runs unreduced, so observe pressure afresh from level 0. */
  resetCapture(): void {
    this.level = RECOVERY_LEVEL_ZERO;
    this.changedAt = this.probedAt = -Infinity;
    this.resetWindow();
  }

  observe(input: { health: CameraHealth; now: number }): RecoveryAction | undefined {
    if (!isHealthSampleReady(input.health)) {
      this.resetWindow();

      return undefined;
    }
    if (
      this.previous === undefined ||
      input.now <= this.previous ||
      input.now - this.previous > CAMERA_RECOVERY.maxSampleGapMs ||
      input.health.reason !== this.reason
    ) {
      this.since = input.now;
    }
    this.previous = input.now;
    this.reason = input.health.reason;
    if (input.now - this.changedAt < CAMERA_RECOVERY.cooldownMs) {
      return undefined;
    }
    const elapsed = input.now - (this.since ?? input.now);

    return findRecoveryAction({ controller: this, health: input.health, now: input.now, elapsed });
  }

  applied(input: { action: RecoveryAction; now: number }): void {
    if (input.action.action === "recover") {
      this.probedAt = input.now;
    } else if (input.now - this.probedAt <= CAMERA_RECOVERY.probeRelapseMs) {
      this.recoverAfter = input.now + CAMERA_RECOVERY.failedProbeBackoffMs;
    }
    this.level = input.action.level;
    this.changedAt = input.now;
    this.resetWindow();
  }

  failed(input: { action: RecoveryAction; now: number }): void {
    if (input.action.action === "recover") {
      this.recoverAfter = input.now + CAMERA_RECOVERY.failedProbeBackoffMs;
    }
    this.changedAt = input.now;
    this.resetWindow();
  }
}

/** The largest actively encoded stream describes visible quality. CPU on any
 * active encoder (including a backup codec) counts; ambiguous mixed pressure
 * is treated as bandwidth so we do not fight congestion control. */
export function cameraHealth(input: {
  reports: (RTCStatsReport | undefined)[];
  previous?: { at: number; bytes: number; ids: string };
  now?: number;
}): { health: CameraHealth; counter: { at: number; bytes: number; ids: string } } {
  const now = input.now ?? Date.now();
  const streams = collectOutboundVideoStreams(input.reports);
  const active = sortActiveStreams(streams);
  const health = buildCameraHealth({ active, streams, previous: input.previous, now });
  const bytes = sumOutboundBytes(streams);
  const ids = buildStreamIds(streams);

  return { health, counter: { at: now, bytes, ids } };
}

/** Keep the existing camera/processor/publication. applyConstraints is atomic;
 * rejection leaves the current camera working. Never republish audio or stop
 * the camera to implement a quality adjustment. */
export class CameraRecoveryActuator {
  readonly capture: MediaStreamTrack;
  private readonly original: MediaTrackConstraints;
  private readonly isPortrait: boolean;
  private readonly long: number;
  private readonly short: number;
  private readonly fps: number;

  constructor(track: LocalVideoTrack) {
    this.capture = getMeetingCaptureTrack(track);
    this.original = this.capture.getConstraints();
    const { width = 0, height = 0, frameRate = 0 } = this.capture.getSettings();
    // Keep orientation-independent edges: a phone can rotate after this
    // snapshot, so apply() maps them onto the orientation at that time.
    this.isPortrait = height > width;
    this.long = Math.max(width, height);
    this.short = Math.min(width, height);
    this.fps = frameRate;
  }

  /** Levels 1-2 cap cadence at 20 then 15 fps; only level 3 also caps capture
   * at 720p. The original capture size and frame rate are never increased. */
  levels(): number[] {
    return RECOVERY_LEVELS.reduce<number[]>((acc, level) => {
      if (level === RECOVERY_LEVEL_ZERO) {
        return [RECOVERY_LEVEL_ZERO];
      }
      const previousLevel = acc.at(-1);
      if (previousLevel === undefined) {
        return acc;
      }
      const below = this.target(previousLevel);
      const next = this.target(level);
      if (next.long !== below.long || next.short !== below.short || next.frameRate !== below.frameRate) {
        return [...acc, level];
      }

      return acc;
    }, []);
  }

  /** Check enforced bounds rather than settings: a camera can temporarily run
   * below a removed cap. Numeric constraints are ideals, not upper bounds. */
  hasLostCaps(level: number): boolean {
    if (level === RECOVERY_LEVEL_ZERO) {
      return false;
    }
    const caps = captureCaps(this.capture.getConstraints());
    const target = this.target(level);

    return caps.frameRate > target.frameRate || caps.long > target.long || caps.short > target.short;
  }

  async apply(level: number): Promise<void> {
    if (this.capture.readyState !== "live" || this.long === 0 || this.short === 0 || this.fps === 0) {
      throw new Error(CAMERA_UNAVAILABLE_MESSAGE);
    }
    const { width, height } = this.capture.getSettings();
    const isPortraitNow =
      typeof width === "number" && typeof height === "number" && width > 0 && height > 0
        ? height > width
        : this.isPortrait;
    const original =
      isPortraitNow === this.isPortrait
        ? this.original
        : { ...this.original, width: this.original.height, height: this.original.width };
    if (level === RECOVERY_LEVEL_ZERO) {
      await this.capture.applyConstraints(original);

      return;
    }
    const target = this.target(level);
    const capWidth = isPortraitNow ? target.short : target.long;
    const capHeight = isPortraitNow ? target.long : target.short;
    await this.capture.applyConstraints({
      ...original,
      width: { ideal: capWidth, max: capWidth },
      height: { ideal: capHeight, max: capHeight },
      frameRate: { ideal: target.frameRate, max: target.frameRate },
    });
  }

  private target(level: number): { long: number; short: number; frameRate: number } {
    const scale =
      level === RECOVERY_LEVEL_THREE ? Math.min(1, HD_LONG_EDGE / this.long, HD_SHORT_EDGE / this.short) : 1;

    return {
      long: Math.floor(this.long * scale),
      short: Math.floor(this.short * scale),
      frameRate:
        level === RECOVERY_LEVEL_ZERO
          ? this.fps
          : Math.min(this.fps, level === RECOVERY_LEVEL_ONE ? REDUCED_FPS_LEVEL_ONE : REDUCED_FPS_LEVEL_TWO),
    };
  }
}
