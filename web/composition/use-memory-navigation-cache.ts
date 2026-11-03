import { type QueryCacheNotifyEvent, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { z } from "zod";

import { MEMORY_REFRESH_MS, trimInactiveMemoryQueries } from "./memory-cache-limits";
import { memoryChannelName, removeForgottenMemories } from "./memory-cache-updates";
import { memoryListOptions, memoryPeopleOptions, type MemoryQuerySession } from "./memory-query-options";

const MAX_BROADCAST_FORGET_IDS = 1000;

const memoryForgetBroadcastSchema = z.object({
  type: z.literal("forget"),
  ids: z.array(z.string()).max(MAX_BROADCAST_FORGET_IDS),
});

export function useMemoryNavigationCache(input: { session: MemoryQuerySession; isEnabled: boolean }): void {
  const client = useQueryClient();
  const { token, userId, workspaceId } = input.session;
  const listOptions = useMemo(
    () => memoryListOptions({ client, session: { token, userId, workspaceId } }),
    [client, token, userId, workspaceId],
  );
  // Share the actual browser queries so clicking a tab reuses both cached data
  // and any request already in flight, just like the Tasks sidebar query.
  useInfiniteQuery({ ...listOptions, enabled: input.isEnabled, refetchInterval: MEMORY_REFRESH_MS });
  useInfiniteQuery({
    ...memoryPeopleOptions({ session: input.session }),
    enabled: input.isEnabled,
    refetchInterval: MEMORY_REFRESH_MS,
  });
  useEffect(() => {
    if (!input.isEnabled) {
      return;
    }
    const scope = ["relationship-memory", userId, workspaceId];
    const timer = setInterval(() => trimInactiveMemoryQueries({ client, scope }), MEMORY_REFRESH_MS);
    const scheduleState = { isScheduled: false };
    const memoryScopeKey = "relationship-memory";
    const unsubscribe = client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
      const queryKeySegments = z.array(z.unknown()).parse(event.query.queryKey);
      const queryKeyRootParse = z.string().safeParse(queryKeySegments[0]);
      const queryKeyRoot = queryKeyRootParse.success ? queryKeyRootParse.data : undefined;
      if (
        scheduleState.isScheduled ||
        !["observerRemoved", "updated"].includes(event.type) ||
        queryKeyRoot !== memoryScopeKey
      ) {
        return;
      }
      scheduleState.isScheduled = true;
      queueMicrotask(() => {
        scheduleState.isScheduled = false;
        trimInactiveMemoryQueries({ client, scope });
      });
    });

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [client, input.isEnabled, userId, workspaceId]);
  useEffect(() => {
    if (!input.isEnabled || typeof BroadcastChannel === "undefined") {
      return;
    }
    const scope = ["relationship-memory", userId, workspaceId];
    const channel = new BroadcastChannel(memoryChannelName({ userId, workspaceId }));
    const receive = (event: MessageEvent): void => {
      const parsed = memoryForgetBroadcastSchema.safeParse(event.data);
      if (!parsed.success) {
        return;
      }
      void (async () => {
        await removeForgottenMemories({ client, scope, ids: parsed.data.ids });
        await client.invalidateQueries({ queryKey: scope });
      })();
    };
    channel.addEventListener("message", receive);

    return () => {
      channel.removeEventListener("message", receive);
      channel.close();
    };
  }, [client, input.isEnabled, userId, workspaceId]);
}
