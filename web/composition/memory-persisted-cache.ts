import { z } from "zod";

import { MEMORY_MAX_INACTIVE_QUERIES, MEMORY_SAVED_PAGES } from "./memory-cache-limits";

const BYTES_PER_KILOBYTE = 1024;
const PERSISTED_MEMORY_BUDGET_MEGABYTES = 2;
const PERSISTED_MEMORY_BUDGET_BYTES = PERSISTED_MEMORY_BUDGET_MEGABYTES * BYTES_PER_KILOBYTE * BYTES_PER_KILOBYTE;

const MEMORY_PAGE_SCHEMA = z
  .object({
    memories: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const MEMORY_QUERY_DATA_SCHEMA = z.object({
  pages: z.array(MEMORY_PAGE_SCHEMA),
  pageParams: z.array(z.unknown()),
});

// Bound disk writes independently of how far an active browser has scrolled.
export function boundPersistedMemoryQueries<
  T extends { queryKey: readonly unknown[]; state: { data: unknown; dataUpdatedAt: number } },
>(queries: T[]): T[] {
  const budget = { bytes: 0, count: 0 };

  return [...queries]
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .flatMap((query) => {
      if (query.queryKey[0] !== "relationship-memory") {
        return [query];
      }
      if (budget.count >= MEMORY_MAX_INACTIVE_QUERIES) {
        return [];
      }
      const parsedData = MEMORY_QUERY_DATA_SCHEMA.safeParse(query.state.data);
      if (!parsedData.success) {
        return [];
      }
      const data = parsedData.data;
      const bounded = {
        ...query,
        state: {
          ...query.state,
          data: {
            ...data,
            pages: data.pages.slice(0, MEMORY_SAVED_PAGES).map((page) => {
              const parsedPage = MEMORY_PAGE_SCHEMA.safeParse(page);
              if (!parsedPage.success || parsedPage.data.memories === undefined) {
                return page;
              }

              return {
                ...parsedPage.data,
                memories: parsedPage.data.memories.map((memory) => ({ ...memory, evidence: [] })),
              };
            }),
            pageParams: data.pageParams.slice(0, MEMORY_SAVED_PAGES),
          },
        },
      };
      const size = new TextEncoder().encode(JSON.stringify(bounded)).length;
      if (budget.bytes + size > PERSISTED_MEMORY_BUDGET_BYTES) {
        return [];
      }
      budget.bytes += size;
      budget.count += 1;

      return [bounded];
    });
}
