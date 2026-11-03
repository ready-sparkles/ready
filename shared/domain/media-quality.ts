import { z } from "zod";

export const MEDIA_QUALITY_REPORT_MAX = 20;

const MAX_MEDIA_TRACK_ID_LENGTH = 200;
const MAX_MEDIA_DIMENSION = 16_384;
const MAX_MEDIA_FRAMES_PER_SECOND = 240;
const MAX_MEDIA_BITRATE = 1_000_000_000;
const MAX_MEDIA_QUALITY_LEVEL = 3;
const MAX_MEDIA_RTT_MS = 120_000;

const common = {
  event: z.literal("media-quality"),
  phase: z.literal("in-room"),
  kind: z.literal("camera"),
  trackSid: z.string().min(1).max(MAX_MEDIA_TRACK_ID_LENGTH),
  sampledAt: z.number().int().nonnegative(),
  codec: z.enum(["av1", "vp9", "vp8", "h264", "unknown"]),
  width: z.number().int().min(0).max(MAX_MEDIA_DIMENSION).nullable(),
  height: z.number().int().min(0).max(MAX_MEDIA_DIMENSION).nullable(),
  fps: z.number().min(0).max(MAX_MEDIA_FRAMES_PER_SECOND).nullable(),
  bitrate: z.number().min(0).max(MAX_MEDIA_BITRATE).nullable(),
};

/** Numeric media health only: no device labels, SDP, addresses or media content. */
export const sentMediaQualitySchema = z
  .object({
    ...common,
    direction: z.literal("sent"),
    outcome: z.enum(["changed", "succeeded", "failed"]),
    // `restore` re-applies the current level after a processor reset loosened it.
    action: z.enum(["sample", "reduce", "recover", "restore", "apply-failed"]),
    level: z.number().int().min(0).max(MAX_MEDIA_QUALITY_LEVEL),
    reason: z.enum(["none", "cpu", "bandwidth", "other", "unknown"]),
    availableBitrate: z.number().min(0).max(MAX_MEDIA_BITRATE).nullable(),
    rttMs: z.number().min(0).max(MAX_MEDIA_RTT_MS).nullable(),
    powerEfficientEncoder: z.boolean().nullable(),
  })
  .strict();

export const receivedMediaQualitySchema = z
  .object({
    ...common,
    direction: z.literal("received"),
    outcome: z.literal("changed"),
    qualitySignal: z.enum(["normal", "unknown", "sustained-low-resolution", "sustained-no-frames"]),
    displayWidth: z.number().min(0).max(MAX_MEDIA_DIMENSION).nullable(),
    displayHeight: z.number().min(0).max(MAX_MEDIA_DIMENSION).nullable(),
    packetLoss: z.number().min(0).max(1).nullable(),
    freezeCount: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const mediaQualityDiagnosticSchema = z.discriminatedUnion("direction", [
  sentMediaQualitySchema,
  receivedMediaQualitySchema,
]);

/** Reports are batched so periodic telemetry costs one request per flush. */
export const mediaQualityReportSchema = z
  .object({
    reports: z.array(mediaQualityDiagnosticSchema).min(1).max(MEDIA_QUALITY_REPORT_MAX),
  })
  .strict();

export type SentMediaQuality = z.infer<typeof sentMediaQualitySchema>;
export type ReceivedMediaQuality = z.infer<typeof receivedMediaQualitySchema>;
export type MediaQualityDiagnostic = z.infer<typeof mediaQualityDiagnosticSchema>;
