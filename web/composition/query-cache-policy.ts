import type { QueryKey } from "@tanstack/react-query";

const CACHE_RETENTION_DAYS = 7;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;

export const READYMEET_QUERY_GC_TIME_MS =
  CACHE_RETENTION_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

type PersistedQueryScope = "user" | "workspace";

export function persistedQueryScope(_queryKey: QueryKey): PersistedQueryScope | null {
  // Authorized meeting data is already plaintext in memory; never make a durable browser copy.
  return null;
}

export function shouldPersistQuery(queryKey: QueryKey): boolean {
  return persistedQueryScope(queryKey) !== null;
}
