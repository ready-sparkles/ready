import type { QueryClient } from "@tanstack/react-query";

export const MEMORY_MAX_PAGES = 20;
export const MEMORY_SAVED_PAGES = 4;
export const MEMORY_MAX_INACTIVE_QUERIES = 6;
export const MEMORY_REFRESH_MS = 15_000;

export function trimInactiveMemoryQueries(input: { client: QueryClient; scope: readonly string[] }): void {
  const inactive = input.client
    .getQueryCache()
    .findAll({ queryKey: input.scope })
    .filter(
      (query) => query.getObserversCount() === 0 && ["list", "people", "person"].includes(String(query.queryKey[3])),
    )
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  inactive.slice(MEMORY_MAX_INACTIVE_QUERIES).forEach((query) => {
    input.client.removeQueries({ queryKey: query.queryKey, exact: true });
  });
}
