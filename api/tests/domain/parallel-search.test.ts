import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { ParallelSearchError, parallelSearchTurbo } from "../../adapters/secondary/parallel/parallel-search";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_BAD_REQUEST = 400;
const EXPECTED_RETRY_CALL_COUNT = 2;

const parallelSearchRequestBodySchema = z.record(z.string(), z.unknown());

function readRequestInitBody(init: RequestInit | undefined): string {
  if (init === undefined) {
    return "";
  }
  if (typeof init.body === "string") {
    return init.body;
  }
  if (init.body === undefined || init.body === null) {
    return "";
  }

  return JSON.stringify(init.body);
}

function parseParallelSearchRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  return parallelSearchRequestBodySchema.parse(JSON.parse(readRequestInitBody(init)));
}

void test("Parallel Search adapter forcibly applies Turbo mode", async () => {
  const receivedBodies: { values: Record<string, unknown>[] } = { values: [] };
  const result = await parallelSearchTurbo<{ search_id: string }>({
    apiKey: "test-key",
    body: { objective: "Test", mode: "advanced" },
    fetchImpl: async (...args: Parameters<typeof fetch>) => {
      const init = args[1];
      receivedBodies.values = [...receivedBodies.values, parseParallelSearchRequestBody(init)];

      return new Response(JSON.stringify({ search_id: "search-1" }), {
        status: HTTP_STATUS_OK,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(receivedBodies.values[0]?.mode, "turbo");
  assert.equal(result.search_id, "search-1");
});

void test("Parallel Search retries one transient response and then succeeds", async () => {
  const calls = { count: 0 };
  await parallelSearchTurbo({
    apiKey: "test-key",
    body: { objective: "Test" },
    fetchImpl: async () => {
      calls.count += 1;

      return calls.count === 1
        ? new Response("busy", { status: HTTP_STATUS_TOO_MANY_REQUESTS })
        : new Response("{}", { status: HTTP_STATUS_OK, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls.count, EXPECTED_RETRY_CALL_COUNT);
});

void test("Parallel Search does not retry non-transient client errors", async () => {
  const calls = { count: 0 };
  await assert.rejects(
    parallelSearchTurbo({
      apiKey: "test-key",
      body: { objective: "Test" },
      fetchImpl: async () => {
        calls.count += 1;

        return new Response("bad request", { status: HTTP_STATUS_BAD_REQUEST });
      },
    }),
    (error) => error instanceof ParallelSearchError && error.status === HTTP_STATUS_BAD_REQUEST,
  );
  assert.equal(calls.count, 1);
});
