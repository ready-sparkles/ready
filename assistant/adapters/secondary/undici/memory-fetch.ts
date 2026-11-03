import { Agent } from "./sdk";

const MEMORY_DISPATCHER_HEADER_TIMEOUT_MS = 0;
const MEMORY_DISPATCHER_BODY_TIMEOUT_MS = 0;

// Only memory requests use this dispatcher. Abort deadlines cover headers and body.
const memoryDispatcher = new Agent({
  headersTimeout: MEMORY_DISPATCHER_HEADER_TIMEOUT_MS,
  bodyTimeout: MEMORY_DISPATCHER_BODY_TIMEOUT_MS,
}).compose(
  (dispatch) => (options, handler) =>
    dispatch(
      {
        ...options,
        headersTimeout: MEMORY_DISPATCHER_HEADER_TIMEOUT_MS,
        bodyTimeout: MEMORY_DISPATCHER_BODY_TIMEOUT_MS,
      },
      handler,
    ),
);

export const openAIMemoryFetch: typeof globalThis.fetch = async (url, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("content-length");
  const request = { ...init, headers, dispatcher: memoryDispatcher };

  return globalThis.fetch(url, request);
};
