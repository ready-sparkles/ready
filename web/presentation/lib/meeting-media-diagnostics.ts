import { MEDIA_QUALITY_REPORT_MAX, type MediaQualityDiagnostic, type SentMediaQuality } from "@readymeet/shared";
import {
  ConnectionState,
  isVideoCodec,
  type LocalTrack,
  LocalVideoTrack,
  type RemoteTrack,
  RemoteVideoTrack,
  type Room,
  RoomEvent,
  Track,
} from "livekit-client";

import { statsCodecName } from "../../domain/meeting-media-stats";

import { MEETING_MEDIA_CONFIG as config } from "./meeting-media-config";
import { type MeetingMediaPolicy, rememberCpuLimitation } from "./meeting-media-policy";
import { displayedVideoSize, type DisplaySize, ReceiverHealthMonitor } from "./meeting-media-receiver-health";
import {
  CAMERA_RECOVERY,
  cameraHealth,
  CameraRecoveryActuator,
  CameraRecoveryController,
  type RecoveryAction,
} from "./meeting-media-recovery";
import { getMeetingCaptureTrack } from "./meeting-media-track";

/** Sampling detects a sustained interval, never extrapolating across a sleep,
 * mute, reconnect or missing-stats gap. It only influences the next join. */
const LINT_NUM_N1000 = 1000;
const LINT_NUM_N8 = 8;
const LINT_NUM_N15_000 = 15_000;
const MEDIA_STATS_UNAVAILABLE = "stats unavailable";

function isStatsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type StatsFieldKind = "string" | "number" | "boolean";

function readStatsField(input: {
  stat: Record<string, unknown>;
  key: string;
  kind: StatsFieldKind;
}): string | number | boolean | undefined {
  const value = input.stat[input.key];
  if (input.kind === "string") {
    return typeof value === "string" ? value : undefined;
  }
  if (input.kind === "number") {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  return typeof value === "boolean" ? value : undefined;
}

function readStatsString(input: { stat: Record<string, unknown>; key: string }): string | undefined {
  const value = readStatsField({ ...input, kind: "string" });

  return typeof value === "string" ? value : undefined;
}

function readStatsNumber(input: { stat: Record<string, unknown>; key: string }): number | undefined {
  const value = readStatsField({ ...input, kind: "number" });

  return typeof value === "number" ? value : undefined;
}

function readStatsBoolean(input: { stat: Record<string, unknown>; key: string }): boolean | undefined {
  const value = readStatsField({ ...input, kind: "boolean" });

  return typeof value === "boolean" ? value : undefined;
}

export class SustainedCpuTracker {
  private previous?: number;
  private since?: number;
  private isRecorded = false;
  observe(input: { isCpuLimited: boolean; now: number }): boolean {
    if (
      !input.isCpuLimited ||
      this.previous === undefined ||
      input.now - this.previous > config.diagnostics.maxSampleGapMs ||
      input.now <= this.previous
    ) {
      this.since = input.isCpuLimited ? input.now : undefined;
    }
    this.previous = input.now;
    if (this.isRecorded || this.since === undefined || input.now - this.since < config.diagnostics.sustainedCpuMs) {
      return false;
    }
    this.isRecorded = true;

    return true;
  }
}

export type CounterSample = {
  timestamp: number;
  bytes: number;
  frames?: number;
  packets?: number;
  lost?: number;
  totalEncodeTime?: number;
};
function packetLossRate(input: { packets?: number; lost?: number }): number | null {
  const { packets, lost } = input;
  if (packets === undefined || lost === undefined || packets < 0 || packets + lost <= 0) {
    return null;
  }

  return lost / (packets + lost);
}

function counterRatesNamed(input: { current: CounterSample; previous?: CounterSample }) {
  const { current, previous } = input;
  const seconds = previous ? (current.timestamp - previous.timestamp) / LINT_NUM_N1000 : 0;
  if (!previous || seconds <= 0 || current.bytes < previous.bytes) {
    return { bitrate: null, fps: null, packetLoss: null };
  }
  const packets =
    current.packets !== undefined && previous.packets !== undefined ? current.packets - previous.packets : undefined;
  const lost =
    current.lost !== undefined && previous.lost !== undefined ? Math.max(0, current.lost - previous.lost) : undefined;

  return {
    bitrate: ((current.bytes - previous.bytes) * LINT_NUM_N8) / seconds,
    fps:
      current.frames !== undefined && previous.frames !== undefined && current.frames >= previous.frames
        ? (current.frames - previous.frames) / seconds
        : null,
    packetLoss: packetLossRate({ packets, lost }),
  };
}

export function counterRates(
  ...args: [current: CounterSample, previous?: CounterSample]
): ReturnType<typeof counterRatesNamed> {
  const [current, previous] = args;

  return counterRatesNamed({ current, previous });
}

/** Interval encode latency, not total CPU utilization. Missing/reset counters
 * remain unknown; software/hardware classification is left to the browser. */
function encodeMillisecondsPerFrameNamed(input: { current: CounterSample; previous?: CounterSample }) {
  const { current, previous } = input;
  if (
    !previous ||
    current.timestamp <= previous.timestamp ||
    current.frames === undefined ||
    previous.frames === undefined ||
    current.frames <= previous.frames ||
    current.totalEncodeTime === undefined ||
    previous.totalEncodeTime === undefined ||
    current.totalEncodeTime < previous.totalEncodeTime
  ) {
    return null;
  }

  return (LINT_NUM_N1000 * (current.totalEncodeTime - previous.totalEncodeTime)) / (current.frames - previous.frames);
}

export function encodeMillisecondsPerFrame(
  ...args: [current: CounterSample, previous?: CounterSample]
): ReturnType<typeof encodeMillisecondsPerFrameNamed> {
  const [current, previous] = args;

  return encodeMillisecondsPerFrameNamed({ current, previous });
}

type DiagnosticRow = Record<string, unknown>;
/** Returns the upload so the queue can keep one in flight at a time. */
export type MediaHealthReporter = (
  ...args: [
    reports: MediaQualityDiagnostic[],
    options: { /** @external media health upload wire field */ keepalive: boolean },
  ]
) => Promise<unknown> | void;
/** Periodic summaries are batched; adjustment events flush on the next tick. */
const HEALTH_FLUSH_MS = 30_000;
const MAX_RECEIVERS = LINT_NUM_N8;
const isAdjustment = (report: MediaQualityDiagnostic) => report.direction === "sent" && report.action !== "sample";
type MeetingMediaDiagnostics = {
  policy: MeetingMediaPolicy;
  samples: { at: number; tracks: DiagnosticRow[] }[];
};
declare global {
  interface Window {
    __readyMediaDiagnostics?: MeetingMediaDiagnostics;
  }
}

function readDiagnosticsStopFlag(stopState: { isStopped: boolean }): boolean {
  return stopState.isStopped;
}

function lookupStatsEntry(input: {
  report: RTCStatsReport | undefined;
  id: string | undefined;
}): Record<string, unknown> | undefined {
  if (input.report === undefined || input.id === undefined || input.id === "") {
    return undefined;
  }
  const entry: unknown = input.report.get(input.id);

  return isStatsRecord(entry) ? entry : undefined;
}

type MeetingMediaStatsReportSlice = {
  report: RTCStatsReport | undefined;
  encodings?: RTCRtpEncodingParameters[];
  isBackupLayer: boolean;
};

function counterSampleFromRtpStat(input: {
  stat: Record<string, unknown>;
  remote: Record<string, unknown> | undefined;
  isLocal: boolean;
}): CounterSample {
  const packetsSent = readStatsNumber({ stat: input.stat, key: "packetsSent" });
  const remotePacketsLost =
    input.remote !== undefined ? readStatsNumber({ stat: input.remote, key: "packetsLost" }) : undefined;

  return {
    timestamp: readStatsNumber({ stat: input.stat, key: "timestamp" }) ?? 0,
    bytes:
      (input.isLocal
        ? readStatsNumber({ stat: input.stat, key: "bytesSent" })
        : readStatsNumber({ stat: input.stat, key: "bytesReceived" })) ?? 0,
    frames: input.isLocal
      ? readStatsNumber({ stat: input.stat, key: "framesEncoded" })
      : readStatsNumber({ stat: input.stat, key: "framesDecoded" }),
    totalEncodeTime: input.isLocal ? readStatsNumber({ stat: input.stat, key: "totalEncodeTime" }) : undefined,
    packets: input.isLocal
      ? packetsSent !== undefined && remotePacketsLost !== undefined
        ? Math.max(0, packetsSent - remotePacketsLost)
        : undefined
      : readStatsNumber({ stat: input.stat, key: "packetsReceived" }),
    lost: input.isLocal ? remotePacketsLost : readStatsNumber({ stat: input.stat, key: "packetsLost" }),
  };
}

function meetingMediaDeveloperEncodingsSnapshot(encodings?: RTCRtpEncodingParameters[]) {
  return encodings?.map((encoding) => ({
    rid: encoding.rid,
    /** @external WebRTC encoding wire field */
    active: encoding.active,
    scaleResolutionDownBy: encoding.scaleResolutionDownBy,
    scalabilityMode: (encoding as RTCRtpEncodingParameters & { scalabilityMode?: string }).scalabilityMode,
  }));
}

function meetingMediaRtpStatLinkage(input: { stat: Record<string, unknown>; report: RTCStatsReport | undefined }): {
  remote: Record<string, unknown> | undefined;
  pair: Record<string, unknown> | undefined;
} {
  const remoteId = readStatsString({ stat: input.stat, key: "remoteId" });
  const remote = lookupStatsEntry({ report: input.report, id: remoteId });
  const transportId = readStatsString({ stat: input.stat, key: "transportId" });
  const transport = lookupStatsEntry({ report: input.report, id: transportId });
  const selectedCandidatePairId =
    transport !== undefined ? readStatsString({ stat: transport, key: "selectedCandidatePairId" }) : undefined;
  const pair = lookupStatsEntry({ report: input.report, id: selectedCandidatePairId });

  return { remote, pair };
}

function meetingMediaLocalTrackDiagnostics(input: { track: LocalTrack | RemoteTrack; isLocal: boolean }) {
  if (!input.isLocal) {
    return { capture: undefined, output: undefined };
  }
  const capture = getMeetingCaptureTrack(input.track);
  const settings = capture.getSettings();
  const outputSettings = input.track.mediaStreamTrack.getSettings();

  return {
    capture: {
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      contentHint: input.track.mediaStreamTrack.contentHint,
    },
    output: {
      width: outputSettings.width,
      height: outputSettings.height,
      frameRate: outputSettings.frameRate,
    },
  };
}

function meetingMediaRtpTimingDiagnostics(input: {
  isLocal: boolean;
  stat: Record<string, unknown>;
  remote: Record<string, unknown> | undefined;
  pair: Record<string, unknown> | undefined;
}): { jitterSeconds: number | null; rttSeconds: number | null } {
  const jitterSeconds =
    (input.isLocal
      ? readStatsNumber({ stat: input.remote ?? {}, key: "jitter" })
      : readStatsNumber({ stat: input.stat, key: "jitter" })) ?? null;

  return {
    jitterSeconds,
    rttSeconds:
      readStatsNumber({ stat: input.remote ?? {}, key: "roundTripTime" }) ??
      readStatsNumber({ stat: input.pair ?? {}, key: "currentRoundTripTime" }) ??
      null,
  };
}

function meetingMediaCodecSelectionReason(input: {
  isLocal: boolean;
  source: Track.Source;
  policy: MeetingMediaPolicy;
}): string | undefined {
  if (!input.isLocal) {
    return undefined;
  }
  if (input.source === Track.Source.Camera) {
    return input.policy.camera.reason;
  }
  if (input.source === Track.Source.ScreenShare) {
    return input.policy.screen.reason;
  }

  return undefined;
}

function meetingMediaRtpStatMatchesDirection(input: { stat: Record<string, unknown>; isLocal: boolean }) {
  const statType = readStatsString({ stat: input.stat, key: "type" });
  const expectedType = input.isLocal ? "outbound-rtp" : "inbound-rtp";

  return statType === expectedType;
}

function meetingMediaDeveloperQualityFields(stat: Record<string, unknown>) {
  return {
    qualityLimitationReason: readStatsString({ stat, key: "qualityLimitationReason" }) ?? null,
    qualityLimitationDurations: stat["qualityLimitationDurations"] ?? null,
    freezeCount: readStatsNumber({ stat, key: "freezeCount" }) ?? null,
    totalFreezesDuration: readStatsNumber({ stat, key: "totalFreezesDuration" }) ?? null,
  };
}

function meetingMediaDeveloperRowDocument(input: {
  stat: Record<string, unknown>;
  codec: Record<string, unknown> | undefined;
  isLocal: boolean;
  source: Track.Source;
  trackKey: string;
  isBackupLayer: boolean;
  capture: ReturnType<typeof meetingMediaLocalTrackDiagnostics>["capture"];
  output: ReturnType<typeof meetingMediaLocalTrackDiagnostics>["output"];
  rates: ReturnType<typeof counterRatesNamed>;
  encodeMsPerFrame: number | null;
  sample: CounterSample;
  timing: ReturnType<typeof meetingMediaRtpTimingDiagnostics>;
  encodings?: RTCRtpEncodingParameters[];
  sdkStats: unknown;
  policy: MeetingMediaPolicy;
}): DiagnosticRow {
  const direction = input.isLocal ? "sent" : "received";
  const codecMime =
    input.codec !== undefined ? (readStatsString({ stat: input.codec, key: "mimeType" }) ?? null) : null;

  return {
    direction,
    source: input.source,
    track: input.trackKey,
    isBackupLayer: input.isBackupLayer,
    resolution: {
      width: readStatsNumber({ stat: input.stat, key: "frameWidth" }) ?? null,
      height: readStatsNumber({ stat: input.stat, key: "frameHeight" }) ?? null,
    },
    capture: input.capture,
    output: input.output,
    fps: readStatsNumber({ stat: input.stat, key: "framesPerSecond" }) ?? input.rates.fps,
    bitrate: input.rates.bitrate,
    encoderImplementation: readStatsString({ stat: input.stat, key: "encoderImplementation" }) ?? null,
    /** @external WebRTC stats wire field */
    powerEfficientEncoder: readStatsBoolean({ stat: input.stat, key: "powerEfficientEncoder" }) ?? null,
    encodeMsPerFrame: input.encodeMsPerFrame,
    codec: codecMime,
    rid: readStatsString({ stat: input.stat, key: "rid" }) ?? null,
    scalabilityMode: readStatsString({ stat: input.stat, key: "scalabilityMode" }) ?? null,
    activeSvcLayer: null,
    encodings: meetingMediaDeveloperEncodingsSnapshot(input.encodings),
    packetsLost: input.sample.lost ?? null,
    packetLoss: input.rates.packetLoss,
    jitterSeconds: input.timing.jitterSeconds,
    rttSeconds: input.timing.rttSeconds,
    ...meetingMediaDeveloperQualityFields(input.stat),
    sdkStats: input.sdkStats ?? null,
    selectionReason: meetingMediaCodecSelectionReason({
      isLocal: input.isLocal,
      source: input.source,
      policy: input.policy,
    }),
  };
}

function meetingMediaDeveloperRowFromStat(input: {
  stat: Record<string, unknown>;
  report: RTCStatsReport | undefined;
  encodings?: RTCRtpEncodingParameters[];
  isBackupLayer: boolean;
  streamKey: string;
  isLocal: boolean;
  source: Track.Source;
  trackKey: string;
  track: LocalTrack | RemoteTrack;
  policy: MeetingMediaPolicy;
  previous: Map<string, CounterSample>;
  sdkStats: unknown;
}): DiagnosticRow[] {
  if (!meetingMediaRtpStatMatchesDirection({ stat: input.stat, isLocal: input.isLocal })) {
    return [];
  }
  const { previous } = input;
  const codecId = readStatsString({ stat: input.stat, key: "codecId" });
  const codec = lookupStatsEntry({ report: input.report, id: codecId });
  const { remote, pair } = meetingMediaRtpStatLinkage({ stat: input.stat, report: input.report });
  const sample = counterSampleFromRtpStat({ stat: input.stat, remote, isLocal: input.isLocal });
  const rates = counterRatesNamed({ current: sample, previous: previous.get(input.streamKey) });
  const encodeMsPerFrame = encodeMillisecondsPerFrameNamed({
    current: sample,
    previous: previous.get(input.streamKey),
  });
  previous.set(input.streamKey, sample);
  const { capture, output } = meetingMediaLocalTrackDiagnostics({ track: input.track, isLocal: input.isLocal });

  return [
    meetingMediaDeveloperRowDocument({
      stat: input.stat,
      codec,
      isLocal: input.isLocal,
      source: input.source,
      trackKey: input.trackKey,
      isBackupLayer: input.isBackupLayer,
      capture,
      output,
      rates,
      encodeMsPerFrame,
      sample,
      timing: meetingMediaRtpTimingDiagnostics({
        isLocal: input.isLocal,
        stat: input.stat,
        remote,
        pair,
      }),
      encodings: input.encodings,
      sdkStats: input.sdkStats,
      policy: input.policy,
    }),
  ];
}

function meetingMediaDeveloperStatRows(input: {
  statsReports: MeetingMediaStatsReportSlice[];
  track: LocalTrack | RemoteTrack;
  source: Track.Source;
  key: string;
  isLocal: boolean;
  policy: MeetingMediaPolicy;
  previous: Map<string, CounterSample>;
  sdkStats: unknown;
}): DiagnosticRow[] {
  return input.statsReports.flatMap(({ report, encodings, isBackupLayer }) =>
    Array.from(report?.values() ?? []).flatMap((stat) => {
      if (!isStatsRecord(stat)) {
        return [];
      }
      const statId = readStatsString({ stat, key: "id" }) ?? "unknown";
      const streamKey = `${input.key}:${isBackupLayer}:${statId}`;

      return meetingMediaDeveloperRowFromStat({
        stat,
        report,
        encodings,
        isBackupLayer,
        streamKey,
        isLocal: input.isLocal,
        source: input.source,
        trackKey: input.key,
        track: input.track,
        policy: input.policy,
        previous: input.previous,
        sdkStats: input.sdkStats,
      });
    }),
  );
}

async function gatherMeetingMediaTrackStatsReports(input: {
  track: LocalTrack | RemoteTrack;
  isDeveloper: boolean;
}): Promise<MeetingMediaStatsReportSlice[]> {
  const primary: MeetingMediaStatsReportSlice = {
    report: await input.track.getRTCStatsReport(),
    isBackupLayer: false,
    encodings:
      input.isDeveloper && input.track instanceof LocalVideoTrack
        ? input.track.sender?.getParameters().encodings
        : undefined,
  };
  if (!(input.track instanceof LocalVideoTrack)) {
    return [primary];
  }

  const backupReports = await Array.from(input.track.simulcastCodecs.values()).reduce<
    Promise<MeetingMediaStatsReportSlice[]>
  >(async (previous, simulcastCodec) => {
    const collected = await previous;
    if (
      !simulcastCodec.sender ||
      simulcastCodec.sender === ("sender" in input.track ? input.track.sender : undefined)
    ) {
      return collected;
    }

    return [
      ...collected,
      {
        report: await simulcastCodec.sender.getStats(),
        encodings: input.isDeveloper ? simulcastCodec.sender.getParameters().encodings : undefined,
        isBackupLayer: true,
      },
    ];
  }, Promise.resolve([]));

  return [primary, ...backupReports];
}

async function meetingMediaDeveloperSdkStats(input: { track: LocalTrack | RemoteTrack; isDeveloper: boolean }) {
  if (!input.isDeveloper) {
    return undefined;
  }
  if (input.track instanceof LocalVideoTrack) {
    return input.track.getSenderStats();
  }
  if (input.track instanceof RemoteVideoTrack) {
    return input.track.getReceiverStats();
  }

  return undefined;
}

function observeMeetingMediaOutboundCpuLimits(input: {
  track: LocalVideoTrack;
  source: Track.Source;
  key: string;
  statsReports: MeetingMediaStatsReportSlice[];
  cpu: Map<string, SustainedCpuTracker>;
}) {
  const { track, source, key, statsReports, cpu } = input;
  if (source !== Track.Source.Camera && source !== Track.Source.ScreenShare) {
    return;
  }
  const mediaSource = source === Track.Source.Camera ? "camera" : "screen";
  statsReports.forEach(({ report, isBackupLayer }) => {
    const codecStates = new Map<string, boolean>();
    report?.forEach((stat) => {
      if (!isStatsRecord(stat)) {
        return;
      }
      if (readStatsString({ stat, key: "type" }) !== "outbound-rtp") {
        return;
      }
      const codec = statsCodecName({ report, stat });
      if (codec === undefined || codec === "" || !isVideoCodec(codec)) {
        return;
      }
      const framesPerSecond = readStatsNumber({ stat, key: "framesPerSecond" }) ?? 0;
      codecStates.set(
        codec,
        Boolean(codecStates.get(codec)) ||
          (!track.isMuted &&
            !track.isUpstreamPaused &&
            readStatsString({ stat, key: "qualityLimitationReason" }) === "cpu" &&
            framesPerSecond > 0),
      );
    });
    Array.from(codecStates).forEach(([codec, isCpuLimited]) => {
      const cpuKey = `${key}:${isBackupLayer}:${codec}`;
      const monitor = cpu.get(cpuKey) ?? new SustainedCpuTracker();
      cpu.set(cpuKey, monitor);
      if (monitor.observe({ isCpuLimited, now: Date.now() }) && isVideoCodec(codec)) {
        rememberCpuLimitation(mediaSource, codec);
      }
    });
  });
}

type MeetingMediaCameraRecoveryEntry = {
  controller: CameraRecoveryController;
  actuator?: CameraRecoveryActuator;
  counter?: ReturnType<typeof cameraHealth>["counter"];
  reportedAt: number;
};

type MeetingMediaCameraRecoveryEmit = (emitInput: {
  action: SentMediaQuality["action"];
  outcome?: SentMediaQuality["outcome"];
}) => void;

async function meetingMediaRestoreCameraCaps(input: {
  actuator: CameraRecoveryActuator;
  level: number;
  controller: CameraRecoveryController;
  stopState: { isStopped: boolean };
  emit: MeetingMediaCameraRecoveryEmit;
}) {
  try {
    await input.actuator.apply(input.level);
  } catch (error) {
    if (error instanceof Error || error !== undefined) {
      input.controller.resetCapture();
      if (!readDiagnosticsStopFlag(input.stopState)) {
        input.emit({ action: "restore", outcome: "failed" });
      }
    }

    return;
  }
  if (!readDiagnosticsStopFlag(input.stopState)) {
    input.emit({ action: "restore" });
  }
}

async function meetingMediaApplyCameraRecoveryAction(input: {
  actuator: CameraRecoveryActuator;
  action: RecoveryAction;
  controller: CameraRecoveryController;
  stopState: { isStopped: boolean };
  emit: MeetingMediaCameraRecoveryEmit;
  now: number;
}) {
  try {
    await input.actuator.apply(input.action.level);
  } catch (error) {
    if (error instanceof Error || error !== undefined) {
      input.controller.failed({ action: input.action, now: input.now });
      if (!readDiagnosticsStopFlag(input.stopState)) {
        input.emit({ action: "apply-failed" });
      }
    }

    return;
  }
  if (!readDiagnosticsStopFlag(input.stopState)) {
    input.controller.applied({ action: input.action, now: input.now });
    input.emit({ action: input.action.action });
  }
}

function meetingMediaCameraRecoveryEmitFactory(input: {
  state: MeetingMediaCameraRecoveryEntry;
  health: ReturnType<typeof cameraHealth>["health"];
  now: number;
  key: string;
  queueHealth: (report: MediaQualityDiagnostic) => void;
}): MeetingMediaCameraRecoveryEmit {
  const { state, health, now, key, queueHealth } = input;

  return (emitInput) => {
    const outcome =
      emitInput.outcome ??
      (emitInput.action === "apply-failed" ? "failed" : emitInput.action === "sample" ? "changed" : "succeeded");
    state.reportedAt = now;
    queueHealth({
      direction: "sent",
      sampledAt: now,
      event: "media-quality",
      phase: "in-room",
      kind: "camera",
      trackSid: key,
      outcome,
      action: emitInput.action,
      level: state.controller.level,
      ...health,
    });
  };
}

async function runMeetingMediaCameraRecoveryDecision(input: {
  track: LocalVideoTrack;
  capture: MediaStreamTrack;
  state: MeetingMediaCameraRecoveryEntry;
  health: ReturnType<typeof cameraHealth>["health"];
  stopState: { isStopped: boolean };
  emit: MeetingMediaCameraRecoveryEmit;
  now: number;
}) {
  if (input.track.isMuted || input.track.isUpstreamPaused || input.capture.readyState !== "live") {
    input.state.controller.resetWindow();

    return;
  }
  const actuator = input.state.actuator;
  if (actuator !== undefined && actuator.hasLostCaps(input.state.controller.level)) {
    await meetingMediaRestoreCameraCaps({
      actuator,
      level: input.state.controller.level,
      controller: input.state.controller,
      stopState: input.stopState,
      emit: input.emit,
    });

    return;
  }
  const action = input.state.controller.observe({ health: input.health, now: input.now });
  if (action && input.state.actuator) {
    await meetingMediaApplyCameraRecoveryAction({
      actuator: input.state.actuator,
      action,
      controller: input.state.controller,
      stopState: input.stopState,
      emit: input.emit,
      now: input.now,
    });

    return;
  }
  if (input.now - input.state.reportedAt >= CAMERA_RECOVERY.reportMs) {
    input.emit({ action: "sample" });
  }
}

async function runMeetingMediaLocalCameraRecovery(input: {
  track: LocalVideoTrack;
  key: string;
  statsReports: MeetingMediaStatsReportSlice[];
  room: Room;
  stopState: { isStopped: boolean };
  recovery: Map<LocalVideoTrack, MeetingMediaCameraRecoveryEntry>;
  queueHealth: (report: MediaQualityDiagnostic) => void;
}) {
  const { track, key, statsReports, room, stopState, recovery, queueHealth } = input;
  if (readDiagnosticsStopFlag(stopState) || room.state !== ConnectionState.Connected) {
    return;
  }
  const now = Date.now();
  const existing = recovery.get(track);
  const capture = getMeetingCaptureTrack(track);
  const state =
    !existing || (existing.actuator && existing.actuator.capture !== capture)
      ? { controller: new CameraRecoveryController(), reportedAt: now }
      : existing;
  if (state !== existing) {
    recovery.set(track, state);
  }
  const { health, counter } = cameraHealth({
    reports: statsReports.map((item) => item.report),
    previous: state.counter,
    now,
  });
  state.counter = counter;
  if (
    !state.actuator &&
    Boolean(health.width) &&
    Boolean(health.height) &&
    Boolean(health.fps) &&
    capture.readyState === "live"
  ) {
    state.actuator = new CameraRecoveryActuator(track);
    state.controller.levels = state.actuator.levels();
  }
  const emit = meetingMediaCameraRecoveryEmitFactory({ state, health, now, key, queueHealth });
  await runMeetingMediaCameraRecoveryDecision({ track, capture, state, health, stopState, emit, now });
}

function sampleMeetingMediaRemoteCameraHealth(input: {
  track: RemoteVideoTrack;
  key: string;
  display: DisplaySize;
  statsReports: MeetingMediaStatsReportSlice[];
  room: Room;
  stopState: { isStopped: boolean };
  receivers: Map<RemoteVideoTrack, { monitor: ReceiverHealthMonitor; reportedAt: number; signal: string }>;
  queueHealth: (report: MediaQualityDiagnostic) => void;
}) {
  const { track, key, display, statsReports, room, stopState, receivers, queueHealth } = input;
  if (readDiagnosticsStopFlag(stopState) || room.state !== ConnectionState.Connected) {
    return;
  }
  const now = Date.now();
  const state = receivers.get(track) ?? {
    monitor: new ReceiverHealthMonitor(),
    reportedAt: now,
    signal: "normal",
  };
  receivers.set(track, state);
  const health = state.monitor.sample({ report: statsReports[0]?.report, display, now });
  const signal = health.qualitySignal;
  if (
    now - state.reportedAt >= CAMERA_RECOVERY.reportMs ||
    (signal !== "unknown" && signal !== state.signal && now - state.reportedAt >= LINT_NUM_N15_000)
  ) {
    state.reportedAt = now;
    if (signal !== "unknown") {
      state.signal = signal;
    }
    queueHealth({
      event: "media-quality",
      phase: "in-room",
      kind: "camera",
      direction: "received",
      sampledAt: now,
      trackSid: key,
      outcome: "changed",
      ...health,
    });
  }
}

async function collectMeetingMediaTrackDiagnostics(input: {
  track: LocalTrack | RemoteTrack;
  source: Track.Source;
  key: string;
  display: DisplaySize | null;
  isDeveloper: boolean;
  policy: MeetingMediaPolicy;
  room: Room;
  stopState: { isStopped: boolean };
  previous: Map<string, CounterSample>;
  cpu: Map<string, SustainedCpuTracker>;
  recovery: Map<LocalVideoTrack, MeetingMediaCameraRecoveryEntry>;
  receivers: Map<RemoteVideoTrack, { monitor: ReceiverHealthMonitor; reportedAt: number; signal: string }>;
  queueHealth: (report: MediaQualityDiagnostic) => void;
}): Promise<DiagnosticRow[]> {
  const {
    track,
    source,
    key,
    display,
    isDeveloper,
    policy,
    room,
    stopState,
    previous,
    cpu,
    recovery,
    receivers,
    queueHealth,
  } = input;
  const isLocal = track.isLocal;
  const sdkStats = await meetingMediaDeveloperSdkStats({ track, isDeveloper });
  const statsReports = await gatherMeetingMediaTrackStatsReports({ track, isDeveloper });
  if (track instanceof LocalVideoTrack) {
    observeMeetingMediaOutboundCpuLimits({ track, source, key, statsReports, cpu });
  }
  if (track instanceof LocalVideoTrack && source === Track.Source.Camera) {
    await runMeetingMediaLocalCameraRecovery({
      track,
      key,
      statsReports,
      room,
      stopState,
      recovery,
      queueHealth,
    });
  }
  if (track instanceof RemoteVideoTrack && source === Track.Source.Camera && display !== null) {
    sampleMeetingMediaRemoteCameraHealth({
      track,
      key,
      display,
      statsReports,
      room,
      stopState,
      receivers,
      queueHealth,
    });
  }
  if (!isDeveloper) {
    return [];
  }

  return meetingMediaDeveloperStatRows({
    statsReports,
    track,
    source,
    key,
    isLocal,
    policy,
    previous,
    sdkStats,
  });
}

type MeetingMediaDiagnosticsCollect = (collectInput: {
  track: LocalTrack | RemoteTrack;
  source: Track.Source;
  key: string;
  display: DisplaySize | null;
}) => Promise<DiagnosticRow[]>;

function createMeetingMediaHealthQueue(input: {
  reportHealth?: MediaHealthReporter;
  stopState: { isStopped: boolean };
}) {
  const queue: { reports: MediaQualityDiagnostic[] } = { reports: [] };
  const runtime: { flushedAt: number; isUploading: boolean } = { flushedAt: Date.now(), isUploading: false };
  const queueHealth = (report: MediaQualityDiagnostic) => {
    if (input.stopState.isStopped || !input.reportHealth) {
      return;
    }
    if (queue.reports.length >= MEDIA_QUALITY_REPORT_MAX) {
      const summary = queue.reports.findIndex((item) => !isAdjustment(item));
      if (!isAdjustment(report) || summary < 0) {
        return;
      }
      queue.reports = queue.reports.filter((_, index) => index !== summary);
    }
    queue.reports = [...queue.reports, report];
  };
  const flushHealth = (/** @external media health flush wire field */ isKeepalive: boolean) => {
    const reportHealth = input.reportHealth;
    if (queue.reports.length === 0 || !reportHealth || (runtime.isUploading && !isKeepalive)) {
      return;
    }
    runtime.flushedAt = Date.now();
    const batch = queue.reports;
    queue.reports = [];
    const upload = (() => {
      try {
        return reportHealth(batch, { keepalive: isKeepalive });
      } catch (error) {
        return error instanceof Error ? undefined : undefined;
      }
    })();
    if (!upload) {
      return;
    }
    const settled = (async () => {
      try {
        await upload;
      } catch (error) {
        if (error instanceof Error || error !== undefined) {
          return;
        }
      }
    })();
    if (!isKeepalive) {
      runtime.isUploading = true;
      void settled.finally(() => {
        runtime.isUploading = false;
      });
    }
  };

  return { queue, runtime, queueHealth, flushHealth };
}

function selectMeetingMediaRemoteReceivers(input: { room: Room; reportHealth?: MediaHealthReporter }) {
  const selected = new Map<RemoteVideoTrack, { sid: string; display: DisplaySize }>();
  if (!input.reportHealth) {
    return selected;
  }
  const candidates: { track: RemoteVideoTrack; sid: string; display: DisplaySize }[] = Array.from(
    input.room.remoteParticipants.values(),
  ).flatMap((participant) =>
    Array.from(participant.trackPublications.values()).flatMap((publication) => {
      const track = publication.track;
      if (!(track instanceof RemoteVideoTrack) || publication.source !== Track.Source.Camera || track.isMuted) {
        return [];
      }
      const display = displayedVideoSize(track);

      return display ? [{ track, sid: publication.trackSid, display }] : [];
    }),
  );
  const rankedReceivers = [...candidates].sort(
    (a, b) => b.display.width * b.display.height - a.display.width * a.display.height,
  );
  rankedReceivers.slice(0, MAX_RECEIVERS).forEach(({ track, ...item }) => {
    selected.set(track, item);
  });

  return selected;
}

async function executeMeetingMediaDiagnosticsSample(input: {
  room: Room;
  isDeveloper: boolean;
  history: MeetingMediaDiagnostics;
  reportHealth?: MediaHealthReporter;
  stopState: { isStopped: boolean };
  recovery: Map<LocalVideoTrack, MeetingMediaCameraRecoveryEntry>;
  cpu: Map<string, SustainedCpuTracker>;
  receivers: Map<RemoteVideoTrack, { monitor: ReceiverHealthMonitor; reportedAt: number; signal: string }>;
  queue: { reports: MediaQualityDiagnostic[] };
  runtime: { flushedAt: number; isUploading: boolean };
  flushHealth: (isKeepalive: boolean) => void;
  collect: MeetingMediaDiagnosticsCollect;
}) {
  const { room, isDeveloper, history, stopState, recovery, cpu, receivers, queue, runtime, flushHealth, collect } =
    input;
  try {
    const currentTracks = new Set(
      Array.from(room.localParticipant.trackPublications.values(), (publication) => publication.track),
    );
    Array.from(recovery.keys()).forEach((track) => {
      if (!currentTracks.has(track)) {
        recovery.delete(track);
      }
    });
    const localWork = Array.from(room.localParticipant.trackPublications.values()).flatMap((publication) => {
      const track = publication.track;
      if (!track || (!isDeveloper && !(track instanceof LocalVideoTrack))) {
        return [];
      }
      if (
        !isDeveloper &&
        track instanceof LocalVideoTrack &&
        (track.isMuted || track.isUpstreamPaused || track.mediaStreamTrack.readyState !== "live")
      ) {
        recovery.get(track)?.controller.resetWindow();
        Array.from(cpu).forEach(([key, monitor]) => {
          if (key.startsWith(`${publication.trackSid}:`)) {
            monitor.observe({ isCpuLimited: false, now: Date.now() });
          }
        });

        return [];
      }

      return [collect({ track, source: publication.source, key: publication.trackSid, display: null })];
    });
    const selected = selectMeetingMediaRemoteReceivers({ room, reportHealth: input.reportHealth });
    Array.from(receivers.keys()).forEach((track) => {
      if (!selected.has(track)) {
        receivers.delete(track);
      }
    });
    const remoteWork = isDeveloper
      ? Array.from(room.remoteParticipants.values()).flatMap((participant) =>
          Array.from(participant.trackPublications.values()).flatMap((publication) => {
            const track = publication.track;
            if (!track) {
              return [];
            }

            return [
              collect({
                track,
                source: publication.source,
                key: publication.trackSid,
                display: track instanceof RemoteVideoTrack ? (selected.get(track)?.display ?? null) : null,
              }),
            ];
          }),
        )
      : Array.from(selected).map(([track, { sid, display }]) =>
          collect({ track, source: Track.Source.Camera, key: sid, display }),
        );
    const results = await Promise.allSettled([...localWork, ...remoteWork]);
    if (
      !readDiagnosticsStopFlag(stopState) &&
      (queue.reports.some(isAdjustment) || Date.now() - runtime.flushedAt >= HEALTH_FLUSH_MS)
    ) {
      flushHealth(false);
    }
    if (readDiagnosticsStopFlag(stopState) || !isDeveloper) {
      return;
    }
    const tracks = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [{ error: MEDIA_STATS_UNAVAILABLE }],
    );
    const entry = { at: Date.now(), tracks };
    const samples = [...history.samples, entry];
    history.samples = samples.length > config.diagnostics.historySamples ? samples.slice(1) : samples;
    window.dispatchEvent(new CustomEvent("ready:media-diagnostics", { detail: entry }));
  } catch (error) {
    if (error instanceof Error || error !== undefined) {
      return;
    }
  }
}

/** Detailed reports stay local in development. Production retains only bounded
 * camera health summaries and adjustment events via the batched media-quality API. */
export function startMeetingMediaDiagnostics(
  ...args: [room: Room, policy: MeetingMediaPolicy, reportHealth?: MediaHealthReporter]
): () => void {
  const [room, policy, reportHealth] = args;
  const isDeveloper = process.env.NODE_ENV === "development";
  const history: MeetingMediaDiagnostics = { policy, samples: [] };
  if (isDeveloper && typeof window !== "undefined") {
    window.__readyMediaDiagnostics = history;
  }
  const previous = new Map<string, CounterSample>();
  const cpu = new Map<string, SustainedCpuTracker>();
  const recovery = new Map<
    LocalVideoTrack,
    {
      controller: CameraRecoveryController;
      actuator?: CameraRecoveryActuator;
      counter?: ReturnType<typeof cameraHealth>["counter"];
      reportedAt: number;
    }
  >();
  const receivers = new Map<RemoteVideoTrack, { monitor: ReceiverHealthMonitor; reportedAt: number; signal: string }>();
  const stopState = { isStopped: false };
  const { queue, runtime, queueHealth, flushHealth } = createMeetingMediaHealthQueue({ reportHealth, stopState });
  const sampleLock = { isActive: false };

  const collect = async (collectInput: {
    track: LocalTrack | RemoteTrack;
    source: Track.Source;
    key: string;
    display: DisplaySize | null;
  }): Promise<DiagnosticRow[]> =>
    collectMeetingMediaTrackDiagnostics({
      ...collectInput,
      isDeveloper,
      policy,
      room,
      stopState,
      previous,
      cpu,
      recovery,
      receivers,
      queueHealth,
    });

  const sample = () => {
    if (readDiagnosticsStopFlag(stopState) || sampleLock.isActive || room.state !== ConnectionState.Connected) {
      return;
    }
    sampleLock.isActive = true;
    void executeMeetingMediaDiagnosticsSample({
      room,
      isDeveloper,
      history,
      reportHealth,
      stopState,
      recovery,
      cpu,
      receivers,
      queue,
      runtime,
      flushHealth,
      collect,
    }).finally(() => {
      sampleLock.isActive = false;
    });
  };
  const timer = setInterval(
    () => {
      sample();
    },
    isDeveloper ? config.diagnostics.intervalMs : config.diagnostics.productionIntervalMs,
  );
  const interrupt = () => {
    receivers.clear();
    Array.from(recovery.values()).forEach((state) => {
      const current = state;
      current.controller.resetWindow();
      current.counter = undefined;
    });
    Array.from(cpu.values()).forEach((monitor) => {
      monitor.observe({ isCpuLimited: false, now: Date.now() });
    });
  };
  room.on(RoomEvent.Reconnecting, interrupt);
  room.on(RoomEvent.SignalReconnecting, interrupt);
  sample();
  const stop = () => {
    stopState.isStopped = true;
    clearInterval(timer);
    flushHealth(true);
    previous.clear();
    cpu.clear();
    recovery.clear();
    receivers.clear();
    room.off(RoomEvent.Reconnecting, interrupt);
    room.off(RoomEvent.SignalReconnecting, interrupt);
    room.off(RoomEvent.Disconnected, stop);
  };
  room.once(RoomEvent.Disconnected, stop);

  return stop;
}
