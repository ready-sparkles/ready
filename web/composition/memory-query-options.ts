import type { MemoryListPage, MemoryPeoplePage } from "@readymeet/shared";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  type UseInfiniteQueryOptions,
} from "@tanstack/react-query";

import { getMemoryPeople, listMemories, syncMemories } from "../application/api";

import { MEMORY_MAX_PAGES } from "./memory-cache-limits";
import { createMemoryListQuery, type MemoryListData } from "./memory-list-sync";
import { READYMEET_QUERY_GC_TIME_MS } from "./query-cache-policy";

export type MemoryQuerySession = { token: string; userId: string; workspaceId: string };
const DEFAULT_MEMORY_FILTERS = {
  categoryOperator: "is",
  personOperator: "is",
  dateOperator: "is",
};

const MEMORY_NEWER_CURSOR_PREFIX = "newer:";
const MEMORY_NEWER_CURSOR_PREFIX_LENGTH = MEMORY_NEWER_CURSOR_PREFIX.length;
const MEMORY_LIST_STALE_TIME_MS = 20_000;

type MemoryQueryKey = (string | Record<string, string>)[];
type MemoryListQueryOptions = UseInfiniteQueryOptions<MemoryListPage, Error, MemoryListData, MemoryQueryKey, string>;
type MemoryPeopleQueryOptions = UseInfiniteQueryOptions<
  MemoryPeoplePage,
  Error,
  InfiniteData<MemoryPeoplePage, string>,
  MemoryQueryKey,
  string
>;

export function memoryListOptions({
  client,
  session,
  filters = DEFAULT_MEMORY_FILTERS,
}: {
  client: QueryClient;
  session: MemoryQuerySession;
  filters?: Record<string, string>;
}): MemoryListQueryOptions {
  const { token, userId, workspaceId } = session;
  const scope = ["relationship-memory", userId, workspaceId];
  const queryKey = [...scope, "list", filters];

  return infiniteQueryOptions({
    queryKey,
    queryFn: createMemoryListQuery({
      getData: () => client.getQueryData<MemoryListData>(queryKey),
      list: ({ before, signal }) =>
        listMemories({
          token,
          workspaceId,
          filters: {
            ...filters,
            ...(before.startsWith(MEMORY_NEWER_CURSOR_PREFIX)
              ? { after: before.slice(MEMORY_NEWER_CURSOR_PREFIX_LENGTH) }
              : before.length > 0
                ? { before }
                : {}),
          },
          signal,
        }),
      sync: async ({ cursor, through, signal }) => {
        const changes = await syncMemories({ token, workspaceId, request: { filters, cursor, through }, signal });
        signal.throwIfAborted();
        const changed = new Set([...changes.memories.map((memory) => memory.id), ...changes.removedIds]);
        if (changes.reset === true || Boolean(changed.size)) {
          void client.invalidateQueries({
            queryKey: [...scope, "evidence"],
            predicate: (query) => Boolean(changes.reset) || changed.has(String(query.queryKey[4])),
          });
        }

        return changes;
      },
    }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    getPreviousPageParam: (page) =>
      page.previousCursor !== null && page.previousCursor !== undefined
        ? `${MEMORY_NEWER_CURSOR_PREFIX}${page.previousCursor}`
        : undefined,
    maxPages: MEMORY_MAX_PAGES,
    staleTime: MEMORY_LIST_STALE_TIME_MS,
    gcTime: READYMEET_QUERY_GC_TIME_MS,
  });
}

export function memoryPeopleOptions({
  session,
  filters = {},
}: {
  session: MemoryQuerySession;
  filters?: Record<string, string>;
}): MemoryPeopleQueryOptions {
  const { token, userId, workspaceId } = session;

  return infiniteQueryOptions({
    queryKey: ["relationship-memory", userId, workspaceId, "people", filters],
    queryFn: ({ signal, pageParam }) =>
      getMemoryPeople({
        token,
        workspaceId,
        signal,
        filters: {
          ...filters,
          ...(pageParam.startsWith(MEMORY_NEWER_CURSOR_PREFIX)
            ? { after: pageParam.slice(MEMORY_NEWER_CURSOR_PREFIX_LENGTH) }
            : pageParam.length > 0
              ? { before: pageParam }
              : {}),
        },
      }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    getPreviousPageParam: (page) =>
      page.previousCursor !== null && page.previousCursor !== undefined
        ? `${MEMORY_NEWER_CURSOR_PREFIX}${page.previousCursor}`
        : undefined,
    maxPages: MEMORY_MAX_PAGES,
    staleTime: MEMORY_LIST_STALE_TIME_MS,
    gcTime: READYMEET_QUERY_GC_TIME_MS,
  });
}
