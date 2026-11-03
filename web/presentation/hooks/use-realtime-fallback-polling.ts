"use client";

import { useEffect } from "react";

export const REALTIME_FALLBACK_POLL_MS = 45_000;

function canPollNow(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return false;
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return false;
  }

  return true;
}

export function useRealtimeFallbackPolling({
  enabled: isEnabled,
  onPoll,
  intervalMs: intervalMsInput,
}: {
  /** @external React Query-style polling toggle from existing callers. */
  enabled: boolean;
  onPoll: () => void | Promise<void>;
  intervalMs?: number;
}): void {
  const intervalMs = intervalMsInput ?? REALTIME_FALLBACK_POLL_MS;

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    const cancelState = { isCancelled: false };
    const poll = (): void => {
      if (cancelState.isCancelled || !canPollNow()) {
        return;
      }
      void onPoll();
    };

    poll();
    const intervalId = window.setInterval(poll, intervalMs);
    window.addEventListener("online", poll);
    document.addEventListener("visibilitychange", poll);

    return () => {
      cancelState.isCancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("online", poll);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [isEnabled, intervalMs, onPoll]);
}
