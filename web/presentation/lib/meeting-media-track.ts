import type { LocalTrack, RemoteTrack } from "livekit-client";

/** ProcessorWrapper exposes the original capture as source while LiveKit's
 * mediaStreamTrack points at processed output. Share this lookup between
 * capture constraints and diagnostics so both observe the same device track. */
export function getMeetingCaptureTrack(track: LocalTrack | RemoteTrack | MediaStreamTrack): MediaStreamTrack {
  if (!("mediaStreamTrack" in track)) {
    return track;
  }
  const processor = "getProcessor" in track ? track.getProcessor() : undefined;

  return processor &&
    "source" in processor &&
    typeof MediaStreamTrack !== "undefined" &&
    processor.source instanceof MediaStreamTrack
    ? processor.source
    : track.mediaStreamTrack;
}

/** Upper bounds a constraint set enforces, orientation-independent. Ideals and
 * bare numbers are preferences, not bounds, so they count as uncapped. */
export function captureCaps(constraints: MediaTrackConstraints): { long: number; short: number; frameRate: number } {
  const cap = (value: ConstrainDouble | ConstrainULong | undefined) =>
    typeof value === "object" ? Math.min(value.max ?? Infinity, value.exact ?? Infinity) : Infinity;
  const width = cap(constraints.width),
    height = cap(constraints.height);

  return { long: Math.max(width, height), short: Math.min(width, height), frameRate: cap(constraints.frameRate) };
}
