import type { LocalVideoTrack } from "livekit-client";
import { useSyncExternalStore } from "react";

import { isCameraBlurReady, subscribeBackgroundBlur } from "./background-blur";

export function useCameraBlurReady(track: LocalVideoTrack | null): boolean {
  return useSyncExternalStore(
    subscribeBackgroundBlur,
    () => isCameraBlurReady(track),
    () => false,
  );
}
