import { z } from "zod";

const FREE_BILLING_ATTESTATION_REQUIRED = "OpenAI input token counting requires a free billing attestation.";
const COUNT_FAILED = (status: number) => `OpenAI input token count failed (${status}).`;
const COUNTED_EXECUTION_NOT_DISPATCHED = "Counted OpenAI execution did not dispatch an authorized request.";
const SINGLE_GENERATION_REQUIRED = "A counted execution permits only one generation request.";
const SERIALIZED_POST_REQUIRED = "Counted OpenAI requests require a serialized Responses POST.";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export type OpenAIProviderBounds = Readonly<{
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
}>;

export class OpenAIRequestNotDispatchedError extends Error {
  readonly isProviderRequestDispatched = false;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "OpenAIRequestNotDispatchedError";
  }
}

const safeTokenCount = z.number().int().nonnegative().safe();
const textPart = z.union([
  z.object({ type: z.literal("input_text"), text: z.string() }).strict(),
  z.object({ type: z.literal("output_text"), text: z.string(), annotations: z.array(z.unknown()).optional() }).strict(),
]);
const functionTool = z
  .object({
    type: z.literal("function"),
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()),
    strict: z.boolean().nullable().optional(),
  })
  .strict();
const wireInput = z.union([
  z
    .object({
      type: z.literal("message").optional(),
      role: z.enum(["system", "developer", "user", "assistant"]),
      content: z.union([z.string(), z.array(textPart)]),
      id: z.string().optional(),
      status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call"),
      call_id: z.string(),
      name: z.string(),
      arguments: z.string(),
      id: z.string().optional(),
      status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call_output"),
      call_id: z.string(),
      output: z.string(),
      id: z.string().optional(),
      status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning"),
      id: z.string().optional(),
      encrypted_content: z.string().nullable().optional(),
      summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() }).strict()).optional(),
      content: z.array(z.object({ type: z.literal("reasoning_text"), text: z.string() }).strict()).optional(),
      status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    })
    .strict(),
]);
const format = z.union([
  z.object({ type: z.literal("text") }).strict(),
  z.object({ type: z.literal("json_object") }).strict(),
  z
    .object({
      type: z.literal("json_schema"),
      name: z.string(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().nullable().optional(),
    })
    .strict(),
]);
const countFields = {
  model: z.string().min(1),
  input: z.union([z.string(), z.array(wireInput)]),
  instructions: z.string().optional(),
  tools: z.array(functionTool).optional(),
  tool_choice: z
    .union([z.enum(["auto", "required", "none"]), z.object({ type: z.literal("function"), name: z.string() }).strict()])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  text: z
    .object({ format: format.optional(), verbosity: z.enum(["low", "medium", "high"]).optional() })
    .strict()
    .optional(),
  reasoning: z
    .object({
      effort: z.string().optional(),
      summary: z.string().nullable().optional(),
      generate_summary: z.string().nullable().optional(),
      context: z.enum(["current_turn", "all_turns"]).optional(),
      mode: z.literal("standard").optional(),
    })
    .strict()
    .optional(),
  truncation: z.enum(["auto", "disabled"]).optional(),
  personality: z.string().optional(),
};
// Stored references, hosted tools and context management cannot bind an immutable spend bound.
const wireBodySchema = z
  .object({
    ...countFields,
    max_output_tokens: safeTokenCount.positive().optional(),
    max_tool_calls: safeTokenCount.optional(),
    temperature: z.number().finite().optional(),
    top_p: z.number().finite().optional(),
    top_logprobs: safeTokenCount.optional(),
    stream: z.literal(false).optional(),
    include: z.array(z.literal("reasoning.encrypted_content")).optional(),
    store: z.boolean().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    user: z.string().optional(),
    safety_identifier: z.string().optional(),
    service_tier: z.enum(["auto", "default", "flex", "priority"]).optional(),
    prompt_cache_key: z.string().optional(),
    prompt_cache_options: z
      .object({ mode: z.literal("explicit") })
      .strict()
      .optional(),
    prompt_cache_retention: z.enum(["in_memory", "24h"]).optional(),
  })
  .strict();
const countBodySchema = z.object(countFields);
const countResponseSchema = z
  .object({ object: z.literal("response.input_tokens"), input_tokens: safeTokenCount })
  .strict();

export async function countOpenAIResponseInput(input: {
  apiKey: string;
  body: object;
  inputTokenCountBilling: "free";
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): Promise<number> {
  if (!z.literal("free").safeParse(input.inputTokenCountBilling).success) {
    throw new Error(FREE_BILLING_ATTESTATION_REQUIRED);
  }
  const snapshot = wireBodySchema.parse(JSON.parse(JSON.stringify(input.body)));
  const body = JSON.stringify(countBodySchema.parse(snapshot));
  const signal =
    input.timeoutMs === undefined
      ? input.signal
      : AbortSignal.any([...(input.signal === undefined ? [] : [input.signal]), AbortSignal.timeout(input.timeoutMs)]);
  signal?.throwIfAborted();
  const response = await (input.fetch ?? globalThis.fetch)(`${OPENAI_BASE_URL}/responses/input_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body,
    signal,
  });
  if (!response.ok) {
    throw new Error(COUNT_FAILED(response.status));
  }

  return countResponseSchema.parse(await response.json()).input_tokens;
}

export function createCountedFetch(input: {
  apiKey: string;
  beforeProviderCall: (bounds: OpenAIProviderBounds) => Promise<void>;
  inputTokenCountBilling?: "free";
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch: typeof globalThis.fetch;
}): {
  fetch: typeof globalThis.fetch;
  assertDispatched: () => void;
  rethrowPreflight: (error: unknown) => void;
} {
  if (input.inputTokenCountBilling !== "free") {
    throw new OpenAIRequestNotDispatchedError(new Error(FREE_BILLING_ATTESTATION_REQUIRED));
  }
  const state: { isStarted: boolean; isDispatched: boolean; error?: OpenAIRequestNotDispatchedError } = {
    isStarted: false,
    isDispatched: false,
  };
  const markDispatched = () => {
    state.isDispatched = true;
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    try {
      if (state.isStarted) {
        throw new Error(SINGLE_GENERATION_REQUIRED);
      }
      state.isStarted = true;
      const requestUrl = url instanceof Request ? url.url : String(url);
      if (requestUrl !== `${OPENAI_BASE_URL}/responses` || init?.method !== "POST" || typeof init.body !== "string") {
        throw new Error(SERIALIZED_POST_REQUIRED);
      }
      const generation = { ...init, headers: new Headers(init.headers), body: init.body };
      const body = wireBodySchema.parse(JSON.parse(generation.body));
      const maxOutputTokens = safeTokenCount.positive().parse(body.max_output_tokens);
      input.signal?.throwIfAborted();
      const inputTokens = await countOpenAIResponseInput({
        apiKey: input.apiKey,
        body,
        inputTokenCountBilling: z.literal("free").parse(input.inputTokenCountBilling),
        signal: generation.signal ?? input.signal,
        timeoutMs: input.timeoutMs,
        fetch: input.fetch,
      });
      generation.signal?.throwIfAborted();
      input.signal?.throwIfAborted();
      await input.beforeProviderCall(Object.freeze({ model: body.model, inputTokens, maxOutputTokens }));
      generation.signal?.throwIfAborted();
      input.signal?.throwIfAborted();
      markDispatched();

      return await input.fetch(url, generation);
    } catch (error) {
      if (!state.isDispatched) {
        state.error = new OpenAIRequestNotDispatchedError(error);
        throw state.error;
      }
      throw error;
    }
  };

  return {
    fetch,
    assertDispatched: () => {
      if (!state.isDispatched) {
        throw new OpenAIRequestNotDispatchedError(new Error(COUNTED_EXECUTION_NOT_DISPATCHED));
      }
    },
    rethrowPreflight: (error) => {
      if (!state.isDispatched) {
        throw state.error ?? new OpenAIRequestNotDispatchedError(error);
      }
    },
  };
}

const REASONING_COUNT_REQUIRED = "Reasoning history requires verified input counting.";

export function validateLocallyBoundedRequest(body: object): void {
  const parsed = wireBodySchema.parse(body);
  if (typeof parsed.input !== "string" && parsed.input.some((item) => item.type === "reasoning")) {
    throw new Error(REASONING_COUNT_REQUIRED);
  }
}
