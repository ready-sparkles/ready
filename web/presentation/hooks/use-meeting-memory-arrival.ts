"use client";

import { useEffect, useMemo } from "react";

import type { AmbientContextViewItem } from "../../domain/ambient-context-view";
import { ambientContextPillTimestamp } from "../../domain/ambient-context-view";

/** Auto-open only newly observed participant memory, never transcript research or polling. */
export function useMeetingMemoryArrival(input: {
  scopeKey: string;
  /** @external existing wire contract */
  enabled: boolean;
  arrivals: AmbientContextViewItem[];
  items: AmbientContextViewItem[];
  onOpen: (key: string) => void;
}): void {
  const { scopeKey, enabled: isMemoryArrivalEnabled, arrivals, items, onOpen } = input;
  const shown = useMemo(() => new Map<string, string>(), [scopeKey]);
  useEffect(() => {
    if (!isMemoryArrivalEnabled) {
      return;
    }
    const fresh = arrivals.filter(
      (item) => (item.privateDetails?.memory && shown.get(item.id) !== item.lastMentionedAt) === true,
    );
    if (fresh.length === 0) {
      return;
    }
    const newest = fresh.reduce((latest, item) =>
      ambientContextPillTimestamp(item) > ambientContextPillTimestamp(latest) ? item : latest,
    );
    const target = items.find((item) => (item.id === newest.id || item.selectionAliases?.includes(newest.id)) === true);
    if (!target) {
      return;
    }
    fresh.forEach((item) => {
      shown.set(item.id, item.lastMentionedAt);
    });
    onOpen(`ambient:${target.id}`);
  }, [isMemoryArrivalEnabled, arrivals, items, onOpen, shown]);
}
