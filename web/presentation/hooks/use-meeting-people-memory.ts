"use client";

import { useEffect, useMemo, useState } from "react";

import { listMeetingPeopleMemory } from "../../composition/api";
import type { AmbientContextViewItem } from "../../domain/ambient-context-view";
import { createTimerGroup } from "../lib/timer-group";

const PEOPLE_MEMORY_LOAD_TIMEOUT_MS = 10_000;
const PEOPLE_MEMORY_REFRESH_INTERVAL_MS = 5_000;

/** No shared channel or persistent cache: results belong only to this viewer/session. */
export function useMeetingPeopleMemory(input: {
  token: string | undefined;
  meetingId: string | undefined;
  /** @external hook enablement contract */
  enabled: boolean;
  arrivalsKey: string;
  load?: typeof listMeetingPeopleMemory;
}): AmbientContextViewItem[] {
  const { token, meetingId, enabled: isEnabled, arrivalsKey, load = listMeetingPeopleMemory } = input;
  const scope = useMemo(
    () => ({
      token,
      meetingId,
      isEnabled,
      arrivals: new Map<string, { version: string; shownAt: string }>(),
    }),
    [token, meetingId, isEnabled],
  );
  const [result, setResult] = useState<{ scope: typeof scope; items: AmbientContextViewItem[] } | null>(null);

  useEffect(() => {
    if (!isEnabled || token === undefined || meetingId === undefined) {
      return;
    }

    const controller = new AbortController();
    const timers = createTimerGroup();
    const refresh = async (): Promise<void> => {
      try {
        const items = await load({
          token,
          meetingId,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PEOPLE_MEMORY_LOAD_TIMEOUT_MS)]),
        });
        if (!controller.signal.aborted) {
          const shownAt = new Date().toISOString();
          const arrivals = scope.arrivals;
          const nextItems = items.map((item) => {
            const existingArrival = arrivals.get(item.id);
            const arrival =
              existingArrival !== undefined && existingArrival.version === item.lastMentionedAt
                ? existingArrival
                : { version: item.lastMentionedAt, shownAt };
            if (arrival !== existingArrival) {
              arrivals.set(item.id, arrival);
            }

            return { ...item, researchCompletedAt: arrival.shownAt, memoryArrivalVersion: item.lastMentionedAt };
          });
          setResult((current) =>
            current?.scope === scope && JSON.stringify(current.items) === JSON.stringify(nextItems)
              ? current
              : { scope, items: nextItems },
          );
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        if (!controller.signal.aborted) {
          setResult((current) =>
            current?.scope === scope && current.items.length === 0 ? current : { scope, items: [] },
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          timers.setTimeout({
            run: () => {
              void refresh();
            },
            delayMs: PEOPLE_MEMORY_REFRESH_INTERVAL_MS,
          });
        }
      }
    };
    void refresh();

    return () => {
      controller.abort();
      timers.clear();
    };
  }, [scope, token, meetingId, isEnabled, arrivalsKey, load]);

  return result?.scope === scope && isEnabled ? result.items : [];
}
