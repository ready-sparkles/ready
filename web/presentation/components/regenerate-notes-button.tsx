"use client";

import type { MeetingNotesRegenerationProgress, RegenerateMeetingNotesResponse } from "@readymeet/shared";
import { useEffect, useRef, useState } from "react";

const REGENERATE_NOTES_COPY = {
  generate: "Generate notes",
  generating: "Generating notes…",
  failed: "Notes couldn't be generated. Try again in a moment.",
  timedOut: "Notes are taking longer than expected. Check back in a minute.",
};
const REGENERATE_NOTES_POLL_INTERVAL_MS = 3000;
const REGENERATE_NOTES_POLL_TIMEOUT_MS = 180_000;

type RegenerateNotesPhase = "idle" | "generating" | "failed" | "timed_out";

function ignoreCaughtFailure(error: unknown) {
  if (error instanceof Error || typeof error === "string" || (typeof error === "object" && error !== null)) {
    return;
  }
  throw error;
}

// A failed poll only delays the reveal; the next interval tries again.
async function refreshQuietly(refresh: () => Promise<void>): Promise<void> {
  try {
    await refresh();
  } catch (error: unknown) {
    ignoreCaughtFailure(error);
  }
}

/**
 * One poll: refresh the meeting and ask the server where the run stands, so a
 * failed run is reported now instead of when the poll window runs out. A failed
 * progress check is ignored; the next interval tries again.
 */
async function pollRegeneration(input: {
  refresh: () => Promise<void>;
  checkProgress?: () => Promise<MeetingNotesRegenerationProgress>;
}): Promise<MeetingNotesRegenerationProgress | null> {
  await refreshQuietly(input.refresh);
  if (input.checkProgress === undefined) {
    return null;
  }
  try {
    return await input.checkProgress();
  } catch (error: unknown) {
    ignoreCaughtFailure(error);

    return null;
  }
}

/** Started runs keep the button busy until the refreshed meeting carries real notes. */
async function requestRegeneration(input: {
  onRegenerate: () => Promise<RegenerateMeetingNotesResponse>;
  refresh: () => Promise<void>;
}): Promise<RegenerateNotesPhase> {
  try {
    const { status } = await input.onRegenerate();
    if (status === "recently_failed") {
      return "failed";
    }
    if (status === "not_needed") {
      await input.refresh();

      return "idle";
    }

    return "generating";
  } catch (error: unknown) {
    ignoreCaughtFailure(error);

    return "failed";
  }
}

/**
 * Offered on fallback notes the host can now afford. The button stays busy
 * until the refreshed meeting carries real notes (which unmounts it), so a
 * double click sends one request and the server dedupes any other tab.
 */
export function RegenerateNotesButton({
  onRegenerate,
  refresh,
  checkProgress,
  pollIntervalMs = REGENERATE_NOTES_POLL_INTERVAL_MS,
  pollTimeoutMs = REGENERATE_NOTES_POLL_TIMEOUT_MS,
}: {
  onRegenerate: () => Promise<RegenerateMeetingNotesResponse>;
  refresh: () => Promise<void>;
  /** Where the started run stands; "failed" shows the failure right away. */
  checkProgress?: () => Promise<MeetingNotesRegenerationProgress>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}) {
  const [phase, setPhase] = useState<RegenerateNotesPhase>("idle");
  const isRequestingRef = useRef(false);
  // Read through a ref so a new callback identity each render does not restart the poll window.
  const checkProgressRef = useRef(checkProgress);
  useEffect(() => {
    checkProgressRef.current = checkProgress;
  }, [checkProgress]);

  useEffect(() => {
    if (phase !== "generating") {
      isRequestingRef.current = false;

      return;
    }
    const startedAt = Date.now();
    const state = { isActive: true, isPolling: false };
    const poll = async () => {
      state.isPolling = true;
      const progress = await pollRegeneration({ refresh, checkProgress: checkProgressRef.current });
      state.isPolling = false;
      if (state.isActive && progress === "failed") {
        setPhase("failed");
      }
    };
    const interval = setInterval(() => {
      if (Date.now() - startedAt >= pollTimeoutMs) {
        setPhase("timed_out");

        return;
      }
      if (!state.isPolling) {
        void poll();
      }
    }, pollIntervalMs);

    return () => {
      state.isActive = false;
      clearInterval(interval);
    };
  }, [phase, pollIntervalMs, pollTimeoutMs, refresh]);

  const generate = async () => {
    if (isRequestingRef.current) {
      return;
    }
    isRequestingRef.current = true;
    setPhase("generating");
    setPhase(await requestRegeneration({ onRegenerate, refresh }));
  };

  const isGenerating = phase === "generating";
  const message =
    phase === "failed" ? REGENERATE_NOTES_COPY.failed : phase === "timed_out" ? REGENERATE_NOTES_COPY.timedOut : null;

  return (
    <div className="workspace-notes-regenerate">
      {message === null ? null : (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      <button
        type="button"
        className="workspace-flow-secondary-button"
        disabled={isGenerating}
        aria-busy={isGenerating}
        onClick={() => {
          void generate();
        }}
      >
        {isGenerating ? REGENERATE_NOTES_COPY.generating : REGENERATE_NOTES_COPY.generate}
      </button>
    </div>
  );
}
