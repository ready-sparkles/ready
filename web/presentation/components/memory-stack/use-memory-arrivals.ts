"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Distinguish new processing results from initial loads, filter changes and pagination. */
export function useMemoryArrivals({
  memories,
  scope,
  ready: isReady,
  pageCount,
  pageWindow = String(pageCount),
}: {
  memories: readonly { id: string }[];
  scope: string;
  /** @external ready */
  ready: boolean;
  pageCount: number;
  pageWindow?: string;
}): { arrivingIds: string[]; onArrivalComplete: (id: string) => void } {
  const previous = useRef<{ scope: string; seen: Set<string>; pageWindow: string } | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  useLayoutEffect(() => {
    if (previous.current?.scope !== scope) {
      previous.current = null;
      setPending([]);
    }
    if (!isReady) {
      return;
    }
    const before = previous.current;
    const fresh =
      before && pageWindow === before.pageWindow
        ? memories.filter((memory) => !before.seen.has(memory.id)).map((memory) => memory.id)
        : [];
    // Retain only the current window; pagination identities suppress replays
    // when evicted records are loaded again.
    const seen = new Set(memories.map((memory) => memory.id));
    previous.current = { scope, seen, pageWindow };
    setPending((current) => {
      const present = new Set(memories.map((memory) => memory.id));
      const next = [...new Set([...current.filter((id) => present.has(id)), ...fresh])];

      return next.length === current.length && next.every((id, i) => id === current[i]) ? current : next;
    });
  }, [memories, scope, isReady, pageWindow]);
  const complete = useCallback((id: string) => setPending((current) => current.filter((item) => item !== id)), []);

  return { arrivingIds: pending, onArrivalComplete: complete };
}
