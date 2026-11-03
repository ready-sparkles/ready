const MEMORY_FETCH_NOT_CONFIGURED_MESSAGE = "Memory fetch port is not configured.";

const memoryFetchState: { fetch?: typeof globalThis.fetch } = {};

export function configureMemoryFetch(fetchImpl: typeof globalThis.fetch): void {
  memoryFetchState.fetch = fetchImpl;
}

export function openAIMemoryFetch(): typeof globalThis.fetch {
  if (memoryFetchState.fetch === undefined) {
    throw new Error(MEMORY_FETCH_NOT_CONFIGURED_MESSAGE);
  }

  return memoryFetchState.fetch;
}
