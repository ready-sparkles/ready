import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { AshbyApiError, createAshbyClient, verifyAshbyKey } from "../../adapters/secondary/ashby/ashby-client";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const CANDIDATE_SEARCH_LIMIT = 100;
const RETRY_AFTER_HEADER_SECONDS = 3;
const RETRY_AFTER_SLEEP_MS = 3000;
const DEFAULT_RETRY_SLEEP_MS = 2000;
const EXPECTED_RETRY_REQUEST_COUNT = 3;
const VERIFY_KEY_LIST_LIMIT = 1;

const UNEXPECTED_ASHBY_REQUEST_MESSAGE = "Unexpected Ashby request";
const EXPECTED_ASHBY_REQUEST_MESSAGE = "Expected an Ashby request.";
const TOO_MANY_REQUESTS_MESSAGE = "Too many requests";
const INVALID_API_KEY_MESSAGE = "Invalid API key";
const MISSING_ENDPOINT_PERMISSION_CODE = "missing_endpoint_permission";
const MISSING_CANDIDATES_READ_MESSAGE = "Missing candidatesRead";
const MISSING_ENDPOINT_PERMISSION_MESSAGE = "Your API key does not have permission for this endpoint";

const ASHBY_ERROR_KIND_INVALID_KEY = "invalid_key";
const ASHBY_ERROR_KIND_MISSING_PERMISSION = "missing_permission";

const KIND_NOT_RETRIED_ASSERTION_SUFFIX = " is not retried";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

type FakeResponse = { status?: number; body: unknown; headers?: Record<string, string> };

const fetchJsonBodySchema = z.record(z.string(), z.unknown());
const fakeAshbyResponseBodySchema = z.record(z.string(), z.unknown());

function fetchRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function readRequestInitBody(init: RequestInit): string {
  if (typeof init.body === "string") {
    return init.body;
  }
  if (init.body === undefined || init.body === null) {
    return "";
  }

  return JSON.stringify(init.body);
}

function readRequestHeaders(init?: RequestInit): Record<string, string> {
  const headers = init?.headers;
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });

    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

function fakeFetch(responses: FakeResponse[]) {
  const calls: Call[] = [];
  const session = { calls };
  const queue = [...responses];
  const queueCursor = { index: 0 };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = fetchRequestUrl(input);
    const requestInit = init ?? {};
    const body = fetchJsonBodySchema.parse(JSON.parse(readRequestInitBody(requestInit)));
    session.calls = [...session.calls, { url, headers: readRequestHeaders(requestInit), body }];

    const next = queue[queueCursor.index];
    queueCursor.index += 1;
    if (next === undefined) {
      throw new Error(UNEXPECTED_ASHBY_REQUEST_MESSAGE);
    }

    const responseBody = fakeAshbyResponseBodySchema.parse(next.body);

    return new Response(JSON.stringify(responseBody), {
      status: next.status ?? HTTP_STATUS_OK,
      headers: next.headers,
    });
  };

  return { session, fetchImpl };
}

const noSleep = async () => {};

void test("candidate search uses Basic auth with the key as username", async () => {
  const candidate = {
    id: "cand-1",
    name: "Personqj Personqu",
    primaryEmailAddress: { value: "personqj@northstar.test" },
  };
  const { session, fetchImpl } = fakeFetch([
    { body: { /** @external ashby envelope success wire field */ success: true, results: [candidate] } },
  ]);
  const client = createAshbyClient("secret-key", { fetch: fetchImpl, sleep: noSleep });

  assert.deepEqual(await client.searchCandidates({ email: "personqj@northstar.test" }), [candidate]);
  const firstCall = session.calls[0];
  if (firstCall === undefined) {
    throw new Error(EXPECTED_ASHBY_REQUEST_MESSAGE);
  }
  assert.equal(firstCall.url, "https://api.ashbyhq.com/candidate.search");
  assert.equal(firstCall.headers.Authorization, `Basic ${Buffer.from("secret-key:").toString("base64")}`);
  assert.deepEqual(firstCall.body, { email: "personqj@northstar.test", limit: CANDIDATE_SEARCH_LIMIT });
});

void test("rate limits and server errors retry, honoring Retry-After", async () => {
  const values: number[] = [];
  const waitsState = { values };
  const { session, fetchImpl } = fakeFetch([
    {
      status: HTTP_STATUS_TOO_MANY_REQUESTS,
      body: { /** @external ashby envelope success wire field */ success: false, errors: [TOO_MANY_REQUESTS_MESSAGE] },
      headers: { "retry-after": String(RETRY_AFTER_HEADER_SECONDS) },
    },
    { status: HTTP_STATUS_SERVICE_UNAVAILABLE, body: {} },
    { body: { /** @external ashby envelope success wire field */ success: true, results: [] } },
  ]);
  const client = createAshbyClient("key", {
    fetch: fetchImpl,
    sleep: async (ms) => {
      waitsState.values = [...waitsState.values, ms];
    },
  });
  await client.searchCandidates({ name: "Personqj Personqu" });
  assert.equal(session.calls.length, EXPECTED_RETRY_REQUEST_COUNT);
  assert.deepEqual(waitsState.values, [RETRY_AFTER_SLEEP_MS, DEFAULT_RETRY_SLEEP_MS]);
});

void test("key and permission problems fail immediately with a clear kind", async () => {
  await (
    [
      [
        {
          status: HTTP_STATUS_UNAUTHORIZED,
          body: {
            /** @external ashby envelope success wire field */
            success: false,
            errors: [INVALID_API_KEY_MESSAGE],
          },
        },
        ASHBY_ERROR_KIND_INVALID_KEY,
      ],
      [
        {
          status: HTTP_STATUS_FORBIDDEN,
          body: {
            /** @external ashby envelope success wire field */
            success: false,
            errorInfo: { code: MISSING_ENDPOINT_PERMISSION_CODE, message: MISSING_CANDIDATES_READ_MESSAGE },
          },
        },
        ASHBY_ERROR_KIND_MISSING_PERMISSION,
      ],
      [
        {
          status: HTTP_STATUS_OK,
          body: {
            /** @external ashby envelope success wire field */
            success: false,
            errors: [{ message: MISSING_ENDPOINT_PERMISSION_MESSAGE }],
          },
        },
        ASHBY_ERROR_KIND_MISSING_PERMISSION,
      ],
    ] satisfies [FakeResponse, string][]
  ).reduce(async (previous, [response, kind]) => {
    await previous;
    const { session, fetchImpl } = fakeFetch([response]);
    const client = createAshbyClient("key", { fetch: fetchImpl, sleep: noSleep });
    await assert.rejects(
      client.searchCandidates({ email: "x@y.test" }),
      (error: unknown) => error instanceof AshbyApiError && error.kind === kind && !error.retryable,
    );
    assert.equal(session.calls.length, 1, `${kind}${KIND_NOT_RETRIED_ASSERTION_SUFFIX}`);
  }, Promise.resolve());
});

void test("verifying a key makes one read that needs candidatesRead", async () => {
  const { session, fetchImpl } = fakeFetch([
    { body: { /** @external ashby envelope success wire field */ success: true, results: [] } },
  ]);
  await verifyAshbyKey(createAshbyClient("key", { fetch: fetchImpl, sleep: noSleep }));
  assert.deepEqual(
    session.calls.map((call) => [call.url.split("/").at(-1), call.body]),
    [["candidate.list", { limit: VERIFY_KEY_LIST_LIMIT }]],
  );
});
