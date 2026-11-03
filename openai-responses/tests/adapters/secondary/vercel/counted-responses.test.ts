import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  countOpenAIResponseInput,
  executeOpenAIResponses,
  type ExecuteOpenAIResponsesInput,
  type OpenAIProviderBounds,
  OpenAIRequestNotDispatchedError,
} from "../../../../adapters/secondary/vercel/responses";

const MODEL = "gpt-5.4-mini";
const MAX_OUTPUT_TOKENS = 32_000;
const INPUT_TOKENS = 12;
const OUTPUT_TOKENS = 8;
const REQUESTED_RETRIES = 5;
const FRACTIONAL_COUNT = 1.5;
const RATE_LIMIT_STATUS = 429;
const UNAVAILABLE_STATUS = 503;
const ATTEMPTS = 2;
const TEMPERATURE = 0.2;
const TOP_P = 0.8;
const NO_ADMISSION_MESSAGE = "No admission on failed counts";
const RATE_LIMIT_CODE = "rate_limited";
const INSTRUCTIONS = "Instructions";
const COUNT_URL = "https://api.openai.com/v1/responses/input_tokens";
const GENERATION_URL = "https://api.openai.com/v1/responses";
const API_KEY = "mock-openai-key";
const DENIED_MESSAGE = "Reservation denied";
const NETWORK_MESSAGE = "Network unavailable";
const ABORT_MESSAGE = "Cancelled";
const COUNT_FIELDS = [
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "text",
  "reasoning",
  "truncation",
  "personality",
];
const recordSchema = z.record(z.string(), z.unknown());
const body = { model: MODEL, input: [{ role: "user", content: "Summarize" }], max_output_tokens: MAX_OUTPUT_TOKENS };
const payload = {
  id: "resp-1",
  status: "completed",
  output_text: '{"answer":"ok"}',
  usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
};

function requestRecord(init: RequestInit | undefined): Record<string, unknown> {
  assert.ok(typeof init?.body === "string");

  return recordSchema.parse(JSON.parse(init.body));
}

function requestUrl(url: Parameters<typeof globalThis.fetch>[0]): string {
  return url instanceof Request ? url.url : url.toString();
}

function countResponse(): Response {
  return Response.json({ object: "response.input_tokens", input_tokens: INPUT_TOKENS });
}

function noDispatch(error: unknown): boolean {
  assert.ok(error instanceof OpenAIRequestNotDispatchedError);
  assert.equal(error.isProviderRequestDispatched, false);

  return true;
}

const countedInput = {
  apiKey: API_KEY,
  inputTokenCountBilling: "free" as const,
  body,
  maxRetries: REQUESTED_RETRIES,
  beforeProviderCall: async () => {},
};

void test("counted Responses matches final SDK wire conversion for tools, normalized structured output and encrypted history", async () => {
  const bodies = [
    body,
    {
      ...body,
      input: [
        { role: "system", content: "System instructions" },
        ...body.input,
        { type: "reasoning", id: "rs-old", encrypted_content: "encrypted-old" },
        { type: "function_call", call_id: "call-1", name: "classify", arguments: '{"value":"x"}' },
        { type: "function_call_output", call_id: "call-1", output: "result" },
      ],
      tools: [
        {
          type: "function",
          name: "classify",
          /** @external OpenAI wire field */ strict: true,
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            /** @external OpenAI wire field */ additionalProperties: false,
          },
        },
      ],
      tool_choice: "auto",
      /** @external OpenAI wire field */ parallel_tool_calls: false,
      reasoning: { effort: "low" },
      prompt_cache_options: { mode: "explicit" },
      prompt_cache_retention: "in_memory",
      text: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            /** @external OpenAI wire field */ additionalProperties: false,
          },
        },
      },
    },
  ];
  await Promise.all(
    bodies.map(async (requestBody) => {
      const legacy: { serialized?: BodyInit | null } = {};
      await executeOpenAIResponses({
        apiKey: API_KEY,
        body: requestBody,
        maxRetries: 0,
        fetch: async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
          legacy.serialized = init?.body;

          return Response.json(payload);
        },
      });
      const calls: { items: string[] } = { items: [] };
      const bounds: { items: OpenAIProviderBounds[] } = { items: [] };
      const count: { body?: Record<string, unknown> } = {};
      const result = await executeOpenAIResponses({
        ...countedInput,
        body: requestBody,
        beforeProviderCall: async (value) => {
          assert.deepEqual(calls.items, [COUNT_URL]);
          bounds.items = [...bounds.items, value];
          assert.ok(Object.isFrozen(value));
        },
        fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
          calls.items = [...calls.items, requestUrl(url)];
          assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${API_KEY}`);
          if (requestUrl(url) === COUNT_URL) {
            count.body = requestRecord(init);

            return countResponse();
          }
          assert.equal(init?.body, legacy.serialized);
          const generation = requestRecord(init);
          assert.equal(generation.max_output_tokens, MAX_OUTPUT_TOKENS);
          assert.deepEqual(
            count.body,
            Object.fromEntries(Object.entries(generation).filter(([key]) => COUNT_FIELDS.includes(key))),
          );
          if (requestBody !== body) {
            assert.match(JSON.stringify(count.body), /encrypted-old/);
            assert.match(JSON.stringify(count.body), /json_schema/);
            assert.match(JSON.stringify(count.body), /classify/);
          }

          return Response.json(payload);
        },
      });
      assert.deepEqual(calls.items, [COUNT_URL, GENERATION_URL]);
      assert.deepEqual(bounds.items, [{ model: MODEL, inputTokens: INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS }]);
      assert.equal(result.isOk, true);
      assert.equal(result.payload.output_text, payload.output_text);
      assert.equal(result.totalUsage?.inputTokens, INPUT_TOKENS);
    }),
  );
});

void test("counted Responses uses direct identity metadata, not Gateway credentials or ambient base URL", async () => {
  const previous = process.env.OPENAI_BASE_URL;
  const restoreEnvironment = () => {
    if (previous === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previous;
    }
  };
  process.env.OPENAI_BASE_URL = "https://proxy.invalid/v1";
  const calls: { items: string[] } = { items: [] };
  try {
    await executeOpenAIResponses({
      ...countedInput,
      billing: { userId: "member-1", workspaceId: "workspace-1", feature: "summary", gatewayApiKey: "not-used" },
      fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
        calls.items = [...calls.items, requestUrl(url)];
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${API_KEY}`);
        if (requestUrl(url) === COUNT_URL) {
          assert.equal(requestRecord(init).metadata, undefined);

          return countResponse();
        }
        assert.deepEqual(requestRecord(init).metadata, {
          userId: "member-1",
          workspaceId: "workspace-1",
          feature: "summary",
        });
        assert.equal(requestRecord(init).safety_identifier, "member-1");

        return Response.json(payload);
      },
    });
  } finally {
    restoreEnvironment();
  }
  assert.deepEqual(calls.items, [COUNT_URL, GENERATION_URL]);
});

void test("counted Responses binds generation bytes despite mutation during count and awaited reservation", async () => {
  const mutableBody = structuredClone(body);
  const count: { body?: Record<string, unknown> } = {};
  const result = await executeOpenAIResponses({
    ...countedInput,
    body: mutableBody,
    beforeProviderCall: async (bounds) => {
      await Promise.resolve();
      mutableBody.input = [...mutableBody.input, { role: "user", content: "Changed during reservation" }];
      mutableBody.max_output_tokens = 1;
      assert.ok(Object.isFrozen(bounds));
    },
    fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
      if (requestUrl(url) === COUNT_URL) {
        count.body = requestRecord(init);
        mutableBody.input = [{ role: "user", content: "Changed during count" }];

        return countResponse();
      }
      const generation = requestRecord(init);
      assert.equal(generation.max_output_tokens, MAX_OUTPUT_TOKENS);
      assert.deepEqual(generation.input, count.body?.input);
      assert.ok(typeof init?.body === "string");
      assert.doesNotMatch(init.body, /Changed/);

      return Response.json(payload);
    },
  });
  assert.equal(result.isOk, true);
});

void test("counted Responses preserves denied callback cause, never dispatches and never retries", async () => {
  const denied = new Error(DENIED_MESSAGE);
  const calls: { items: string[] } = { items: [] };
  const callbacks: { items: OpenAIProviderBounds[] } = { items: [] };
  await assert.rejects(
    executeOpenAIResponses({
      ...countedInput,
      beforeProviderCall: async (bounds) => {
        callbacks.items = [...callbacks.items, bounds];
        throw denied;
      },
      fetch: async (url) => {
        calls.items = [...calls.items, requestUrl(url)];

        return countResponse();
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAIRequestNotDispatchedError);
      assert.equal(error.cause, denied);
      assert.equal(error.message, DENIED_MESSAGE);

      return noDispatch(error);
    },
  );
  assert.deepEqual(calls.items, [COUNT_URL]);
  assert.equal(callbacks.items.length, 1);
});

void test("counted Responses rejects missing billing attestation and unsupported application fields before network", async () => {
  const calls: { items: string[] } = { items: [] };
  const invalidInputs: ExecuteOpenAIResponsesInput[] = [
    { ...countedInput, inputTokenCountBilling: undefined },
    ...[
      { ...body, /** @external OpenAI wire field */ unknown: true },
      { ...body, context_management: [] },
      { ...body, reasoning: { effort: "low", mode: "pro" } },
      { ...body, tools: [{ type: "web_search" }] },
      { ...body, input: [{ type: "item_reference", id: "stored" }] },
      { ...body, max_output_tokens: undefined },
      { ...body, max_output_tokens: 0 },
    ].map((invalidBody) => ({ ...countedInput, body: invalidBody })),
  ];
  await Promise.all(
    invalidInputs.map(async (input) => {
      await assert.rejects(
        executeOpenAIResponses({
          ...input,
          fetch: async (url) => {
            calls.items = [...calls.items, requestUrl(url)];

            return countResponse();
          },
        }),
        noDispatch,
      );
    }),
  );
  assert.deepEqual(calls.items, []);
});

void test("counted Responses fails closed on malformed and failed counts without hidden retries", async () => {
  const responses = [
    () => Response.json({ object: "response.input_tokens", input_tokens: -1 }),
    () => Response.json({ object: "response.input_tokens", input_tokens: FRACTIONAL_COUNT }),
    () => Response.json({ object: "response.input_tokens", input_tokens: Number.MAX_SAFE_INTEGER + 1 }),
    () => Response.json({ input_tokens: INPUT_TOKENS }),
    () => Response.json({ object: "response.input_tokens", input_tokens: "12" }),
    () => Response.json({ object: "response.input_tokens", input_tokens: null }),
    () => Response.json({ object: "wrong", input_tokens: INPUT_TOKENS }),
    () => new Response("not-json"),
    () => Response.json({ error: RATE_LIMIT_CODE }, { status: RATE_LIMIT_STATUS, headers: { "retry-after-ms": "0" } }),
    () => {
      throw new Error(NETWORK_MESSAGE);
    },
  ];
  await Promise.all(
    responses.map(async (respond) => {
      const calls: { items: string[] } = { items: [] };
      await assert.rejects(
        executeOpenAIResponses({
          ...countedInput,
          beforeProviderCall: async () => assert.fail(NO_ADMISSION_MESSAGE),
          fetch: async (url) => {
            calls.items = [...calls.items, requestUrl(url)];

            return respond();
          },
        }),
        noDispatch,
      );
      assert.deepEqual(calls.items, [COUNT_URL]);
    }),
  );
});

void test("counted Responses accepts explicit zero count", async () => {
  const bounds: { items: OpenAIProviderBounds[] } = { items: [] };
  await executeOpenAIResponses({
    ...countedInput,
    beforeProviderCall: async (value) => {
      bounds.items = [...bounds.items, value];
    },
    fetch: async (url) =>
      requestUrl(url) === COUNT_URL
        ? Response.json({ object: "response.input_tokens", input_tokens: 0 })
        : Response.json(payload),
  });
  assert.equal(bounds.items[0]?.inputTokens, 0);
});

void test("counted Responses cancellation before count, after count and after reservation proves no dispatch", async () => {
  await Promise.all(
    ["before", "count", "reservation"].map(async (stage) => {
      const controller = new AbortController();
      const abort = new Error(ABORT_MESSAGE);
      const calls: { items: string[] } = { items: [] };
      const admissions: { items: OpenAIProviderBounds[] } = { items: [] };
      if (stage === "before") {
        controller.abort(abort);
      }
      await assert.rejects(
        executeOpenAIResponses({
          ...countedInput,
          signal: controller.signal,
          beforeProviderCall: async (bounds) => {
            admissions.items = [...admissions.items, bounds];
            controller.abort(abort);
          },
          fetch: async (url) => {
            calls.items = [...calls.items, requestUrl(url)];
            if (stage === "count") {
              controller.abort(abort);
            }

            return countResponse();
          },
        }),
        noDispatch,
      );
      assert.deepEqual(calls.items, stage === "before" ? [] : [COUNT_URL]);
      assert.equal(admissions.items.length, stage === "reservation" ? 1 : 0);
    }),
  );
});

void test("counted Responses generation HTTP and network failures are never marked no-dispatch or retried", async () => {
  await Promise.all(
    [false, true].map(async (isNetworkFailure) => {
      const calls: { items: string[] } = { items: [] };
      const failure = new Error(NETWORK_MESSAGE);
      const run = executeOpenAIResponses({
        ...countedInput,
        fetch: async (url) => {
          calls.items = [...calls.items, requestUrl(url)];
          if (requestUrl(url) === COUNT_URL) {
            return countResponse();
          }
          if (isNetworkFailure) {
            throw failure;
          }

          return Response.json(
            { error: { message: NETWORK_MESSAGE } },
            { status: UNAVAILABLE_STATUS, headers: { "retry-after-ms": "0" } },
          );
        },
      });
      if (isNetworkFailure) {
        await assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!(error instanceof OpenAIRequestNotDispatchedError));
          assert.ok(!("isProviderRequestDispatched" in error));

          return true;
        });
      } else {
        const result = await run;
        assert.equal(result.isOk, false);
        assert.equal(result.status, UNAVAILABLE_STATUS);
      }
      assert.deepEqual(calls.items, [COUNT_URL, GENERATION_URL]);
    }),
  );
});

void test("each counted execution obtains a fresh count and reservation", async () => {
  const calls: { items: string[] } = { items: [] };
  const admissions: { items: OpenAIProviderBounds[] } = { items: [] };
  await Promise.all(
    Array.from({ length: ATTEMPTS }, async () => {
      await executeOpenAIResponses({
        ...countedInput,
        beforeProviderCall: async (value) => {
          admissions.items = [...admissions.items, value];
        },
        fetch: async (url) => {
          calls.items = [...calls.items, requestUrl(url)];

          return requestUrl(url) === COUNT_URL ? countResponse() : Response.json(payload);
        },
      });
    }),
  );
  assert.equal(calls.items.filter((url) => url === COUNT_URL).length, ATTEMPTS);
  assert.equal(calls.items.filter((url) => url === GENERATION_URL).length, ATTEMPTS);
  assert.equal(admissions.items.length, ATTEMPTS);
});

void test("countOpenAIResponseInput snapshots and projects documented fields without modifying generation controls", async () => {
  const wireBody = {
    ...structuredClone(body),
    instructions: INSTRUCTIONS,
    personality: "friendly",
    reasoning: { effort: "low", summary: "auto", context: "all_turns" },
    tools: [
      {
        type: "function",
        name: "classify",
        parameters: { type: "object", properties: {} },
        /** @external OpenAI wire field */ strict: true,
      },
    ],
    tool_choice: { type: "function", name: "classify" },
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "result",
        description: "Result",
        schema: { type: "object" },
        /** @external OpenAI wire field */ strict: true,
      },
    },
    metadata: { audit: "local" },
    /** @external OpenAI wire field */ store: false,
    temperature: TEMPERATURE,
    top_p: TOP_P,
    top_logprobs: 0,
    max_tool_calls: 1,
    user: "user",
    safety_identifier: "user",
    service_tier: "default",
    prompt_cache_key: "cache",
    prompt_cache_retention: "in_memory",
    include: ["reasoning.encrypted_content"],
    /** @external OpenAI wire field */ stream: false,
  };
  const snapshot = structuredClone(wireBody);
  const count = await countOpenAIResponseInput({
    apiKey: API_KEY,
    body: wireBody,
    inputTokenCountBilling: "free",
    fetch: async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
      assert.equal(requestUrl(url), COUNT_URL);
      await Promise.resolve();
      assert.deepEqual(
        requestRecord(init),
        Object.fromEntries(Object.entries(snapshot).filter(([key]) => COUNT_FIELDS.includes(key))),
      );
      assert.deepEqual(wireBody, snapshot);

      return countResponse();
    },
  });
  assert.equal(count, INPUT_TOKENS);
});

void test("countOpenAIResponseInput rejects unsafe wire shapes and missing attestation with zero network", async () => {
  const invalidBodies = [
    { ...body, /** @external OpenAI wire field */ unknown: true },
    { ...body, conversation: "mutable" },
    { ...body, previous_response_id: "stored" },
    { ...body, context_management: [] },
    { ...body, prompt: { id: "template" } },
    { ...body, reasoning: { mode: "pro" } },
    { ...body, reasoning: { /** @external OpenAI wire field */ unknown: true } },
    {
      ...body,
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://remote.invalid/image" }] }],
    },
    { ...body, input: [{ type: "item_reference", id: "stored" }] },
    { ...body, tools: [{ type: "web_search" }] },
    { ...body, tools: [{ type: "mcp", server_url: "https://remote.invalid" }] },
  ];
  const calls: { items: string[] } = { items: [] };
  const fetch: typeof globalThis.fetch = async (url) => {
    calls.items = [...calls.items, requestUrl(url)];

    return countResponse();
  };
  await Promise.all(
    invalidBodies.map(async (invalidBody) => {
      await assert.rejects(
        countOpenAIResponseInput({ apiKey: API_KEY, body: invalidBody, inputTokenCountBilling: "free", fetch }),
      );
    }),
  );
  await assert.rejects(async () => {
    await Reflect.apply(countOpenAIResponseInput, undefined, [{ apiKey: API_KEY, body, fetch }]);
  });
  assert.deepEqual(calls.items, []);
});
