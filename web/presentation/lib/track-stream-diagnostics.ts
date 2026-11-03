import { Track } from "livekit-client";

export function createTrackStreamDiagnosticLimiter(): {
  shouldReport: {
    (...args: [trackSid: string, streamState: Track.StreamState, isVisible: boolean]): boolean;
  };
} {
  const stateByTrackSid = new Map<string, Track.StreamState>();

  return {
    shouldReport(...args: [trackSid: string, streamState: Track.StreamState, isVisible: boolean]) {
      const [trackSid, streamState, isVisible] = args;
      const previousState = stateByTrackSid.get(trackSid);
      stateByTrackSid.set(trackSid, streamState);

      return streamState === Track.StreamState.Paused && previousState !== Track.StreamState.Paused && isVisible;
    },
  };
}
