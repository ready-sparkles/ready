import type { MediaQualityDiagnostic } from "@readymeet/shared";

const MIME_CODEC_SEGMENT_INDEX = 1;

type RtcCodecStat = { mimeType?: string };

function isRtcCodecStat(value: unknown): value is RtcCodecStat {
  return typeof value === "object" && value !== null && "mimeType" in value;
}

function codecIdToString(codecId: unknown): string | undefined {
  if (typeof codecId === "string") {
    return codecId;
  }
  if (typeof codecId === "number") {
    return String(codecId);
  }

  return undefined;
}

function readMimeType(input: { report: RTCStatsReport | undefined; codecId: unknown }): string {
  const codecId = codecIdToString(input.codecId);
  const rawCodecStat: unknown =
    input.report === undefined || codecId === undefined ? undefined : input.report.get(codecId);
  if (!isRtcCodecStat(rawCodecStat)) {
    return "";
  }
  const mimeType = rawCodecStat.mimeType;

  return typeof mimeType === "string" ? mimeType : "";
}

/** Finite, non-negative and plausible, else null. Browsers omit or reset fields. */
export function boundedMetric(input: { value: unknown; max: number }): number | null {
  return typeof input.value === "number" && Number.isFinite(input.value) && input.value >= 0 && input.value <= input.max
    ? input.value
    : null;
}

/** Lower-case codec name ("av1") for an RTP stat, from its codec entry's mimeType. */
export function statsCodecName(input: {
  report: RTCStatsReport | undefined;
  stat: { codecId?: unknown } | undefined;
}): string | undefined {
  const mimeType = readMimeType({ report: input.report, codecId: input.stat?.codecId });

  return mimeType.split("/")[MIME_CODEC_SEGMENT_INDEX]?.toLowerCase();
}

export function qualityCodec(input: {
  report: RTCStatsReport | undefined;
  stat: { codecId?: unknown } | undefined;
}): MediaQualityDiagnostic["codec"] {
  const name = statsCodecName(input);

  return name === "av1" || name === "vp9" || name === "vp8" || name === "h264" ? name : "unknown";
}
