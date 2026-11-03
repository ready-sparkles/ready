import {
  compareRelationshipMemories,
  decodeMemoryPosition,
  type MemoryListChanges,
  type MemoryListPage,
  type RelationshipMemory,
} from "@readymeet/shared";
import type { InfiniteData } from "@tanstack/react-query";

const MAX_MEMORY_PAGE_ITEMS = 100;
class MemoryListSyncResetError extends Error {
  constructor() {
    super("memory-list-sync-reset");
    this.name = "MemoryListSyncResetError";
  }
}

class MemoryListSyncOverflowError extends Error {
  constructor() {
    super("memory-list-sync-overflow");
    this.name = "MemoryListSyncOverflowError";
  }
}

export type MemoryListData = InfiniteData<MemoryListPage, string>;

function memorySliceEndIndex(input: {
  ordered: RelationshipMemory[];
  offset: number;
  boundary: ReturnType<typeof decodeMemoryPosition>;
}): number {
  const remaining = input.ordered.slice(input.offset);
  const firstPastBoundary = remaining.findIndex(
    (memory) => input.boundary !== undefined && compareRelationshipMemories(memory, input.boundary) > 0,
  );

  return firstPastBoundary === -1 ? input.ordered.length : input.offset + firstPastBoundary;
}

export function mergeMemoryChanges(...args: [MemoryListData, MemoryListChanges]): MemoryListData {
  const [data, changes] = args;
  if (changes.memories.length === 0 && changes.removedIds.length === 0) {
    if (data.pages[0]?.syncCursor === changes.syncCursor) {
      return data;
    }

    return {
      ...data,
      pages: data.pages.map((page) => ({ ...page, syncCursor: changes.syncCursor })),
    };
  }
  const removed = new Set(changes.removedIds);
  const byId = new Map(
    data.pages
      .flatMap((page) => page.memories)
      .filter((memory) => !removed.has(memory.id))
      .map((memory) => [memory.id, memory]),
  );
  changes.memories.forEach((memory) => {
    byId.set(memory.id, memory);
  });
  const ordered = [...byId.values()].sort(compareRelationshipMemories);

  const mergedPages = data.pages.reduce<{ offset: number; pages: MemoryListPage[] }>(
    (acc, page) => {
      const boundary = decodeMemoryPosition(page.nextCursor ?? undefined);
      const sliceEnd = memorySliceEndIndex({ ordered, offset: acc.offset, boundary });
      const memories = ordered.slice(acc.offset, sliceEnd);

      return {
        offset: sliceEnd,
        pages: [...acc.pages, { ...page, memories, syncCursor: changes.syncCursor }],
      };
    },
    { offset: 0, pages: [] },
  );

  return {
    pageParams: data.pageParams,
    pages: mergedPages.pages,
  };
}

/** TanStack still walks its cached pages on refetch. Only the first invokes the
 * delta endpoint; the remaining pages are replayed locally and committed atomically. */
export function createMemoryListQuery({
  getData,
  list,
  sync,
}: {
  getData: () => MemoryListData | undefined;
  list: (input: { before: string; signal: AbortSignal }) => Promise<MemoryListPage>;
  sync: (input: { cursor: string; through: string | null; signal: AbortSignal }) => Promise<MemoryListChanges>;
}): (input: { pageParam: string; signal: AbortSignal }) => Promise<MemoryListPage> {
  const replayState: { replay: Map<string, MemoryListPage> | undefined } = { replay: undefined };

  const applySyncChanges = async (input: {
    data: MemoryListData;
    cursor: string;
    through: string | null;
    signal: AbortSignal;
  }): Promise<MemoryListData> => {
    const changes = await sync({ cursor: input.cursor, through: input.through, signal: input.signal });
    input.signal.throwIfAborted();
    if (changes.reset === true) {
      throw new MemoryListSyncResetError();
    }
    const nextData = mergeMemoryChanges(input.data, changes);
    if (nextData.pages.some((page) => page.memories.length > MAX_MEMORY_PAGE_ITEMS)) {
      throw new MemoryListSyncOverflowError();
    }
    if (!changes.hasMore || input.signal.aborted) {
      return nextData;
    }

    return applySyncChanges({
      data: nextData,
      cursor: changes.syncCursor,
      through: input.through,
      signal: input.signal,
    });
  };

  const loadReplayPage = async (input: { pageParam: string; signal: AbortSignal }): Promise<MemoryListPage> => {
    if (input.pageParam === getData()?.pageParams[0]) {
      replayState.replay = undefined;
    }

    const replayPage = replayState.replay?.get(input.pageParam);

    return replayPage ?? list({ before: input.pageParam, signal: input.signal });
  };

  const loadInitialPage = async (signal: AbortSignal): Promise<MemoryListPage> => {
    const initialData = getData();
    const cursor = initialData?.pages[0]?.syncCursor;
    if (initialData === undefined || cursor === undefined) {
      return list({ before: "", signal });
    }
    const lastPage = initialData.pages.at(-1);
    const through = lastPage?.nextCursor ?? null;
    try {
      const data = await applySyncChanges({ data: initialData, cursor, through, signal });
      signal.throwIfAborted();
      replayState.replay = new Map(
        data.pageParams.flatMap((param, index) => {
          const page = data.pages[index];

          return page === undefined ? [] : [[param, page] as const];
        }),
      );
      const firstPage = data.pages[0];
      if (firstPage === undefined) {
        return await list({ before: "", signal });
      }

      return firstPage;
    } catch (error: unknown) {
      if (error instanceof MemoryListSyncResetError || error instanceof MemoryListSyncOverflowError) {
        return list({ before: "", signal });
      }
      throw error;
    }
  };

  return async ({ pageParam, signal }: { pageParam: string; signal: AbortSignal }): Promise<MemoryListPage> => {
    if (pageParam.length > 0) {
      return loadReplayPage({ pageParam, signal });
    }
    replayState.replay = undefined;

    return loadInitialPage(signal);
  };
}
