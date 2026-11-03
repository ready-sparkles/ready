import { bindPortFunction } from "./bind-port";

const PARALLEL_SEARCH_PORT_IS_NOT_CONFIGURED_MESSAGE = "ParallelSearch port is not configured.";

type ParallelSearchPort = {
  parallelSearchTurbo: <T extends Record<string, unknown>>(input: {
    apiKey: string;
    body: Record<string, unknown>;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }) => Promise<T>;
};

const parallelSearchState: { port?: ParallelSearchPort } = {};

export function configureParallelSearch(port: ParallelSearchPort): void {
  parallelSearchState.port = port;
}

function parallelSearch(): ParallelSearchPort {
  if (parallelSearchState.port === undefined) {
    throw new Error(PARALLEL_SEARCH_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return parallelSearchState.port;
}

export const parallelSearchTurbo: ParallelSearchPort["parallelSearchTurbo"] = bindPortFunction(
  () => parallelSearch().parallelSearchTurbo,
);
