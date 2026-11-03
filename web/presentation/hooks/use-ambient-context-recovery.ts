"use client";

import type { MeetingAmbientContextItem } from "@readymeet/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ambientContextItemHasReadableResult,
  ambientContextItemIsResearching,
} from "../../domain/ambient-context-view";

import { REALTIME_FALLBACK_POLL_MS, useRealtimeFallbackPolling } from "./use-realtime-fallback-polling";

export const AMBIENT_CONTEXT_LOADING_LIMIT_MS = 120_000;
const AMBIENT_CONTEXT_RETRY_POLL_MS = 5_000;
const AMBIENT_CONTEXT_BACKGROUND_POLL_MS = 15_000;

function loadingDeadlines(input: {
  items: MeetingAmbientContextItem[];
  previous: Map<string, number>;
}): Map<string, number> {
  const { items, previous } = input;
  const now = performance.now();
  const next = new Map(
    items.filter(ambientContextItemIsResearching).map((item) => {
      // Repeated mentions and pending -> researching updates must not extend the
      // visible wait. A completed/failed item clears its deadline for a later retry.
      // Measure time observed by this browser, independently of server/wall clocks.
      return [item.id, previous.get(item.id) ?? now + AMBIENT_CONTEXT_LOADING_LIMIT_MS];
    }),
  );

  return next.size === previous.size && [...next].every(([id, deadline]) => previous.get(id) === deadline)
    ? previous
    : next;
}

/** Presentation timeout only: keep fetching so late successful results reappear. */
export function useAmbientContextRecovery(input: {
  items: MeetingAmbientContextItem[];
  /** @external ambient context recovery enable flag */
  enabled: boolean;
  /** @external realtime channel health flag */
  realtimeHealthy: boolean;
  refresh: () => Promise<void>;
}): {
  pillItems: MeetingAmbientContextItem[];
  expiredItemIds: Set<string>;
  restartWait: (itemId: string) => void;
} {
  const { items, enabled: isRecoveryEnabled, realtimeHealthy: isRealtimeHealthy, refresh } = input;
  const [clock, setClock] = useState(() => performance.now());
  const [deadlines, setDeadlines] = useState(() => loadingDeadlines({ items, previous: new Map() }));
  const currentDeadlines = loadingDeadlines({ items, previous: deadlines });
  if (currentDeadlines !== deadlines) {
    setDeadlines(currentDeadlines);
  }
  const expiredItemIds = useMemo(
    () => new Set([...currentDeadlines].filter(([, deadline]) => deadline <= clock).map(([id]) => id)),
    [currentDeadlines, clock],
  );
  // Keep identity stable across unrelated renders (including the speech meter).
  // Only the pill is filtered; panel history retains the original items.
  const pillItems = useMemo(
    () =>
      expiredItemIds.size > 0
        ? items.filter((item) => !expiredItemIds.has(item.id) || ambientContextItemHasReadableResult(item))
        : items,
    [items, expiredItemIds],
  );
  const hasLoading = items.some((item) => ambientContextItemIsResearching(item) && !expiredItemIds.has(item.id));

  useEffect(() => {
    if (!isRecoveryEnabled || !hasLoading) {
      return;
    }
    const nextDeadline = Math.min(...[...currentDeadlines.values()].filter((deadline) => deadline > clock));
    const timeout = window.setTimeout(() => setClock(performance.now()), Math.max(0, nextDeadline - performance.now()));

    return () => window.clearTimeout(timeout);
  }, [isRecoveryEnabled, hasLoading, currentDeadlines, clock]);

  useRealtimeFallbackPolling({
    enabled: isRecoveryEnabled,
    onPoll: refresh,
    intervalMs: isRealtimeHealthy
      ? REALTIME_FALLBACK_POLL_MS
      : hasLoading
        ? AMBIENT_CONTEXT_RETRY_POLL_MS
        : AMBIENT_CONTEXT_BACKGROUND_POLL_MS,
  });
  const restartWait = useCallback((itemId: string) => {
    setDeadlines((current) => new Map(current).set(itemId, performance.now() + AMBIENT_CONTEXT_LOADING_LIMIT_MS));
    setClock(performance.now());
  }, []);

  return { pillItems, expiredItemIds, restartWait };
}
