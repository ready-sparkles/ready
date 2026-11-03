import { type AdaptiveStreamSettings, BackupCodecPolicy, type ScalabilityMode, type VideoCodec } from "livekit-client";

/** All meeting transport quality knobs. Bitrates are ceilings, never targets. */
const LINT_NUM_N2 = 2;
const LINT_NUM_N1280 = 1280;
const LINT_NUM_N720 = 720;
const LINT_NUM_N30 = 30;
const LINT_NUM_N1_700_000 = 1_700_000;
const LINT_NUM_N960 = 960;
const LINT_NUM_N540 = 540;
const LINT_NUM_N1_000_000 = 1_000_000;
const LINT_NUM_N320 = 320;
const LINT_NUM_N180 = 180;
const LINT_NUM_N150_000 = 150_000;
const LINT_NUM_N640 = 640;
const LINT_NUM_N360 = 360;
const LINT_NUM_N450_000 = 450_000;
const LINT_NUM_N2560 = 2560;
const LINT_NUM_N1440 = 1440;
const LINT_NUM_N15 = 15;
const LINT_NUM_N3_000_000 = 3_000_000;
const LINT_NUM_N1920 = 1920;
const LINT_NUM_N1080 = 1080;
const LINT_NUM_N2_500_000 = 2_500_000;
const LINT_NUM_N48_000 = 48_000;
const LINT_NUM_N40_000 = 40_000;
const LINT_NUM_N36 = 36;
const LINT_NUM_N256 = 256;
const LINT_NUM_N144 = 144;
const LINT_NUM_N4 = 4;
const LINT_NUM_N1500 = 1500;
const LINT_NUM_N7 = 7;
const LINT_NUM_N24 = 24;
const LINT_NUM_N60 = 60;
const LINT_NUM_N1000 = 1000;
const LINT_NUM_N5 = 5;
const LINT_NUM_N3 = 3;
const LINT_NUM_N2000 = 2000;
const LINT_NUM_N5000 = 5000;
const LINT_NUM_N150 = 150;
const LINT_NUM_N20_000 = 20_000;
const LINT_NUM_N6000 = 6000;
const LINT_NUM_N10_000 = 10_000;
const LINT_NUM_N300_000 = 300_000;
const LINT_NUM_N60_000 = 60_000;
const LINT_NUM_N25 = 25;
const MEETING_MEDIA_BLUR_TEMPORAL_BLEND = 0.35;
const MEETING_MEDIA_BLUR_BILATERAL_SIGMA_COLOR = 0.12;
const MEETING_MEDIA_BLUR_LIGHT_WRAP = 0.35;
const MEETING_MEDIA_BENCHMARK_MAX_CPU_LIMITED_FRACTION = 0.05;

export const MEETING_MEDIA_CONFIG = {
  // Required on receivers too, regardless of their own camera codec.
  // SDK 2.18.1 single-PC AV1 failed decoding in the verified Chrome/SFU path.
  transport: { /** @external LiveKit room transport wire field */ singlePeerConnection: false },
  camera: {
    // Power efficiency is diagnostic; smooth software encoding is eligible.
    isSmoothSoftwareEncodingAllowed: true,
    cpuHistoryConstrainedCodecCount: LINT_NUM_N2,
    codecOrder: ["av1", "vp9", "h264", "vp8"] as readonly VideoCodec[],
    // Camera capture starts at 720p; no higher camera tier is offered.
    efficient: {
      width: LINT_NUM_N1280,
      height: LINT_NUM_N720,
      frameRate: LINT_NUM_N30,
      maxBitrate: LINT_NUM_N1_700_000,
    },
    constrained: {
      width: LINT_NUM_N960,
      height: LINT_NUM_N540,
      frameRate: LINT_NUM_N30,
      maxBitrate: LINT_NUM_N1_000_000,
    },
    scalabilityMode: "L3T3_KEY" as ScalabilityMode,
    degradationPreference: "maintain-framerate" as RTCDegradationPreference,
    layers: [
      { width: LINT_NUM_N320, height: LINT_NUM_N180, maxBitrate: LINT_NUM_N150_000, maxFramerate: LINT_NUM_N30 },
      { width: LINT_NUM_N640, height: LINT_NUM_N360, maxBitrate: LINT_NUM_N450_000, maxFramerate: LINT_NUM_N30 },
    ],
  },
  screen: {
    codecOrder: ["av1", "vp9", "vp8", "h264"] as readonly VideoCodec[],
    full: { width: LINT_NUM_N2560, height: LINT_NUM_N1440, frameRate: LINT_NUM_N15, maxBitrate: LINT_NUM_N3_000_000 },
    constrained: {
      width: LINT_NUM_N1920,
      height: LINT_NUM_N1080,
      frameRate: LINT_NUM_N15,
      maxBitrate: LINT_NUM_N2_500_000,
    },
    scalabilityMode: "L1T3" as ScalabilityMode,
    degradationPreference: "maintain-resolution" as RTCDegradationPreference,
    contentHint: "detail" as const,
    audioMaxBitrate: LINT_NUM_N48_000,
  },
  backup: { codec: "vp8" as const, policy: BackupCodecPolicy.PREFER_REGRESSION },
  audio: { sampleRate: LINT_NUM_N48_000, channelCount: 1, maxBitrate: LINT_NUM_N40_000 },
  // Keep the SDK default: DPR <= 2 uses density 1, DPR > 2 uses density 2.
  // 'screen' can request four times as many pixels on a 2x display.
  adaptiveStream: {
    pixelDensity: undefined,
    /** @external LiveKit adaptive stream wire field */
    pauseVideoInBackground: true,
  } as AdaptiveStreamSettings,
  blur: {
    radius: LINT_NUM_N36,
    maxProcessingWidth: LINT_NUM_N1280,
    maxProcessingHeight: LINT_NUM_N720,
    maskWidth: LINT_NUM_N256,
    maskHeight: LINT_NUM_N144,
    downsample: LINT_NUM_N4,
    temporalBlend: MEETING_MEDIA_BLUR_TEMPORAL_BLEND,
    bilateralSigmaColor: MEETING_MEDIA_BLUR_BILATERAL_SIGMA_COLOR,
    lightWrap: MEETING_MEDIA_BLUR_LIGHT_WRAP,
    maxConsecutiveErrors: LINT_NUM_N30,
  },
  capability: {
    timeoutMs: LINT_NUM_N1500,
    cacheMaxAgeMs: LINT_NUM_N7 * LINT_NUM_N24 * LINT_NUM_N60 * LINT_NUM_N60 * LINT_NUM_N1000,
    unknownCacheMaxAgeMs: LINT_NUM_N5 * LINT_NUM_N60 * LINT_NUM_N1000,
    version: LINT_NUM_N3,
    cpuHistoryMaxAgeMs: LINT_NUM_N7 * LINT_NUM_N24 * LINT_NUM_N60 * LINT_NUM_N60 * LINT_NUM_N1000,
  },
  diagnostics: {
    intervalMs: LINT_NUM_N2000,
    productionIntervalMs: LINT_NUM_N5000,
    historySamples: LINT_NUM_N150,
    sustainedCpuMs: LINT_NUM_N20_000,
    maxSampleGapMs: LINT_NUM_N6000,
  },
  benchmark: {
    codecs: ["av1", "vp9", "vp8"] as const,
    warmupMs: LINT_NUM_N10_000,
    durationMs: LINT_NUM_N300_000,
    // Local Chrome 154 / SDK 2.18.1 AV1 receives correctly in dual-PC mode.
    // Production rooms now use the same dual-PC transport policy.
    isVisualSinglePeerConnection: false,
    visualDurationMs: LINT_NUM_N60_000,
    scalabilityModes: ["L3T3_KEY", "L1T3"] as const,
    minFps: LINT_NUM_N25,
    maxCpuLimitedFraction: MEETING_MEDIA_BENCHMARK_MAX_CPU_LIMITED_FRACTION,
    serverUrl: "ws://127.0.0.1:7880",
    tokenPath: "/media-quality-test-tokens.json",
  },
  storagePrefix: "ready:meeting-media:",
};

export type MediaTarget = { width: number; height: number; frameRate: number; maxBitrate: number };
