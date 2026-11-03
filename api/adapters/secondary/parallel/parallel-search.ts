import { z } from "zod";

const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const PARALLEL_ERROR_BODY_MAX_CHARS = 500;
const PARALLEL_FIRST_ATTEMPT_INDEX = 0;

const PARALLEL_SEARCH_MESSAGE = {
  requestFailed: "Parallel Search failed ({status}): {body}",
  retryFailed: "Parallel Search failed after one retry: {detail}",
  networkError: "network error",
} as const;

const parallelSearchResponseSchema = z.record(z.string(), z.unknown());

export class ParallelSearchError extends Error {
  public readonly status: number | null;

  constructor(input: { message: string; status: number | null }) {
    super(input.message);
    this.name = "ParallelSearchError";
    this.status = input.status;
  }
}

function retryableStatus(status: number): boolean {
  return status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN;
}

/**
 * The only Ready-owned entry point for Parallel Search. Search callers cannot
 * select a slower mode: Turbo is applied after the caller's body is spread.
 */
export async function parallelSearchTurbo<T extends Record<string, unknown>>(input: {
  apiKey: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<T> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const runAttempt = async (attemptInput: { attemptIndex: number; lastError: unknown }): Promise<T> => {
    const attemptIndex = attemptInput.attemptIndex;
    const lastError = attemptInput.lastError;
    try {
      const response = await fetchImpl(PARALLEL_SEARCH_URL, {
        method: "POST",
        signal: input.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
        },
        body: JSON.stringify({ ...input.body, mode: "turbo" }),
      });
      if (!response.ok) {
        const responseText = await response.text();
        const error = new ParallelSearchError({
          message: PARALLEL_SEARCH_MESSAGE.requestFailed
            .replace("{status}", String(response.status))
            .replace("{body}", responseText.slice(0, PARALLEL_ERROR_BODY_MAX_CHARS)),
          status: response.status,
        });
        if (attemptIndex === PARALLEL_FIRST_ATTEMPT_INDEX && retryableStatus(response.status)) {
          return await runAttempt({ attemptIndex: attemptIndex + 1, lastError: error });
        }
        throw error;
      }

      const parsed = z
        .custom<T>((value) => parallelSearchResponseSchema.safeParse(value).success)
        .safeParse(await response.json());
      if (!parsed.success) {
        throw new ParallelSearchError({
          message: PARALLEL_SEARCH_MESSAGE.networkError,
          status: response.status,
        });
      }

      return parsed.data;
    } catch (error) {
      if (input.signal?.aborted === true) {
        throw error;
      }
      if (error instanceof ParallelSearchError) {
        throw error;
      }
      if (attemptIndex === PARALLEL_FIRST_ATTEMPT_INDEX) {
        return runAttempt({ attemptIndex: attemptIndex + 1, lastError: error });
      }
      throw new ParallelSearchError({
        message: PARALLEL_SEARCH_MESSAGE.retryFailed.replace(
          "{detail}",
          lastError instanceof Error ? lastError.message : PARALLEL_SEARCH_MESSAGE.networkError,
        ),
        status: null,
      });
    }
  };

  return runAttempt({ attemptIndex: PARALLEL_FIRST_ATTEMPT_INDEX, lastError: null });
}
