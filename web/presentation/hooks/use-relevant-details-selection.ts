"use client";

import { useEffect, useRef } from "react";

import { type RelevantDetailsHistoryItem, relevantDetailsResultVersion } from "../../domain/relevant-details";

export function useRelevantDetailsSelection(input: {
  latest: RelevantDetailsHistoryItem | undefined;
  isOpen: boolean;
  onSelect: (key: string | null) => void;
}): void {
  const version = relevantDetailsResultVersion(input.latest);
  const key = input.latest?.key ?? null;
  const previousLatest = useRef<{ key: string; version: string | null; occurredAt: number } | null>(null);
  const occurredAt = input.latest?.occurredAt ?? null;
  useEffect(() => {
    const previous = previousLatest.current;
    // Losing the newest pill candidate is a fallback, not an arrival. Keep
    // the watched item's failure/timeout and retry action visible in the panel.
    if (
      key === null ||
      key.length === 0 ||
      occurredAt === null ||
      (previous !== null && key !== previous.key && occurredAt <= previous.occurredAt)
    ) {
      return;
    }
    previousLatest.current = { key, version, occurredAt };
    if (previous?.version !== version && input.isOpen) {
      input.onSelect(key);
    }
  }, [key, version, occurredAt, input.isOpen, input.onSelect]);
}
