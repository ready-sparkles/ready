"use client";

import type { AmbientContextPrivateDetails, MeetingAmbientContextItem } from "@readymeet/shared";
import { useEffect, useMemo, useReducer } from "react";

import type { AmbientContextViewItem } from "../../domain/ambient-context-view";

/** Private results live only in this viewer's browser, scoped to their loader/session. */
export function useAmbientPrivateDetails(input: {
  items: MeetingAmbientContextItem[];
  load: ((item: MeetingAmbientContextItem) => Promise<AmbientContextPrivateDetails | null>) | undefined;
}): AmbientContextViewItem[] {
  const { items, load } = input;
  const cache = useMemo(
    () => ({
      load,
      results: new Map<string, AmbientContextPrivateDetails | null>(),
      requests: new Map<string, Promise<void>>(),
    }),
    [load],
  );
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const loadFn = cache.load;
    if (loadFn === undefined) {
      return;
    }
    const activeState = { isActive: true };
    items.forEach((item) => {
      if (item.entityKind !== "person" || cache.results.has(item.id)) {
        return;
      }
      const existingRequest = cache.requests.get(item.id);
      const notifyIfActive = async (request: Promise<void>) => {
        try {
          await request;
          if (activeState.isActive) {
            refresh();
          }
        } catch (error: unknown) {
          if (error instanceof Error) {
            // Load failures are cached as null private details.
          }
        }
      };
      if (existingRequest !== undefined) {
        void notifyIfActive(existingRequest);

        return;
      }
      const request = (async () => {
        try {
          const details = await loadFn(item);
          cache.results.set(item.id, details);
        } catch (error: unknown) {
          if (error instanceof Error) {
            cache.results.set(item.id, null);
          } else {
            cache.results.set(item.id, null);
          }
        }
      })();
      cache.requests.set(item.id, request);
      void notifyIfActive(request);
    });

    return () => {
      activeState.isActive = false;
    };
  }, [items, cache]);

  return useMemo(
    () =>
      items.map((item) =>
        load === undefined || item.entityKind !== "person"
          ? item
          : {
              ...item,
              /** @external existing wire contract */
              privateDetailsPending: !cache.results.has(item.id),
              privateDetails: cache.results.get(item.id) ?? null,
            },
      ),
    [items, load, cache, revision],
  );
}
