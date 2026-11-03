import { createOpenAI } from "@ai-sdk/openai";
import {
  APICallError,
  createGateway,
  generateText,
  jsonSchema,
  type ModelMessage,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  tool,
} from "ai";
import { z } from "zod";

import {
  createCountedFetch,
  OPENAI_BASE_URL,
  type OpenAIProviderBounds,
  OpenAIRequestNotDispatchedError,
  validateLocallyBoundedRequest,
} from "./input-count";
import {
  billingProviderOptions,
  type GatewayBillingIdentity,
  normalizeTotalUsage,
  type TotalUsage,
  usageFromPayload,
} from "./transport-usage";

export type { OpenAIProviderBounds } from "./input-count";
export { countOpenAIResponseInput, OpenAIRequestNotDispatchedError } from "./input-count";
export type { BillingIdentity, GatewayBillingIdentity, TotalUsage } from "./transport-usage";
export type { ExecuteTypeSafeInput, ExecuteTypeSafeResult } from "./typesafe";
export { createTypeSafeModel, executeTypeSafeDecision } from "./typesafe";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_MIN_ERROR = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_MAX = 599;
const LLM_RESPONSES_MAX_RETRIES = 0;
const JSON_CONTENT_TYPE = "application/json";
const EMPTY_TEXT = "";
const RESPONSES_BODY_INVALID_MESSAGE = "OpenAI responses body is not supported.";
const OUTPUT_TEXT_PART_TYPE = "output_text";
const MESSAGE_ITEM_TYPE = "message";
const ASSISTANT_MESSAGE_ROLE = "assistant";
const FUNCTION_TOOL_RESULT_NAME = "function";
const JSON_SCHEMA_FORMAT = "json_schema";
const JSON_OBJECT_FORMAT = "json_object";
const SYSTEM_MESSAGE_MODE = "system" as const;
const REASONING_ENCRYPTED_CONTENT = "reasoning.encrypted_content";

export type ExecuteOpenAIResponsesInput = {
  apiKey: string;
  billing?: GatewayBillingIdentity;
  beforeProviderCall?: (bounds: OpenAIProviderBounds) => Promise<void>;
  inputTokenCountBilling?: "free";
  body: object;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries: number;
  fetch?: typeof globalThis.fetch;
};

export type ExecuteOpenAIResponsesResult = {
  isOk: boolean;
  status: number;
  payload: Record<string, unknown>;
  totalUsage?: TotalUsage;
};

const messageInputSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
const toolOutputInputSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});
const functionCallInputSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
const reasoningInputSchema = z.object({
  type: z.literal("reasoning"),
  id: z.string().optional(),
  encrypted_content: z.string().optional(),
});
const responsesBodySchema = z.object({
  model: z.string(),
  input: z.array(z.union([messageInputSchema, toolOutputInputSchema, functionCallInputSchema, reasoningInputSchema])),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        name: z.string(),
        description: z.string().optional(),
        /** @external OpenAI function tool wire field */
        strict: z.boolean().optional(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  tool_choice: z.enum(["auto", "required", "none"]).optional(),
  /** @external OpenAI parallel tool calls flag */
  parallel_tool_calls: z.boolean().optional(),
  /** @external OpenAI response store flag */
  store: z.boolean().optional(),
  reasoning: z.object({ effort: z.string() }).optional(),
  prompt_cache_options: z.object({ mode: z.literal("explicit") }).optional(),
  prompt_cache_retention: z.literal("in_memory").optional(),
  max_output_tokens: z.number().optional(),
  text: z
    .object({
      format: z
        .object({
          type: z.string(),
          name: z.string().optional(),
          /** @external OpenAI structured-output JSON schema wire field */
          strict: z.boolean().optional(),
          schema: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
});
const countedResponsesBodySchema = responsesBodySchema
  .extend({
    input: z.array(
      z.union([
        messageInputSchema.strict(),
        toolOutputInputSchema.strict(),
        functionCallInputSchema.strict(),
        reasoningInputSchema.strict(),
      ]),
    ),
    tools: responsesBodySchema.shape.tools.unwrap().element.strict().array().optional(),
    reasoning: responsesBodySchema.shape.reasoning.unwrap().strict().optional(),
    prompt_cache_options: responsesBodySchema.shape.prompt_cache_options.unwrap().strict().optional(),
    text: z
      .object({ format: responsesBodySchema.shape.text.unwrap().shape.format.unwrap().strict().optional() })
      .strict()
      .optional(),
  })
  .strict();
const responseRecordSchema = z.record(z.string(), z.unknown());

type ResponsesBody = z.infer<typeof responsesBodySchema>;
type PromptParts =
  | { system?: string; prompt: string; messages?: undefined }
  | { system?: string; prompt?: undefined; messages: ModelMessage[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function jsonSchemaFromRecord(schema: Record<string, unknown>) {
  return jsonSchema(schema as Parameters<typeof jsonSchema>[0]);
}

function outputTextPart(text: string): Record<string, unknown> {
  return { type: OUTPUT_TEXT_PART_TYPE, text, annotations: [] };
}

function messageItem(input: { text: string; index: number }): Record<string, unknown> {
  return {
    type: MESSAGE_ITEM_TYPE,
    role: ASSISTANT_MESSAGE_ROLE,
    id: `msg_${input.index}`,
    content: [outputTextPart(input.text)],
  };
}

function withAnnotations(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type !== OUTPUT_TEXT_PART_TYPE || part.annotations !== undefined) {
    return part;
  }

  return { ...part, annotations: [] };
}

function normalizeContent(content: unknown): unknown {
  if (!isUnknownArray(content)) {
    return content;
  }

  return content.map((part) => (isRecord(part) ? withAnnotations(part) : part));
}

function normalizeMessageItem(input: { item: Record<string, unknown>; index: number }): Record<string, unknown> {
  const id = typeof input.item.id === "string" ? input.item.id : `msg_${input.index}`;

  return {
    ...input.item,
    type: MESSAGE_ITEM_TYPE,
    role: ASSISTANT_MESSAGE_ROLE,
    id,
    content: normalizeContent(input.item.content),
  };
}

function normalizeOutputItem(input: { item: unknown; index: number }): unknown {
  if (!isRecord(input.item) || input.item.type !== MESSAGE_ITEM_TYPE) {
    return input.item;
  }

  return normalizeMessageItem({ item: input.item, index: input.index });
}

function normalizeSuccessBody(value: Record<string, unknown>): Record<string, unknown> {
  if (isUnknownArray(value.output)) {
    return {
      ...value,
      output: value.output.map((item, index) => normalizeOutputItem({ item, index })),
    };
  }
  if (typeof value.output_text === "string") {
    return { ...value, output: [messageItem({ text: value.output_text, index: 0 })] };
  }

  return { ...value, output: [] };
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("json");
}

function jsonResponse(input: { response: Response; body: Record<string, unknown> }): Response {
  const headers = new Headers(input.response.headers);
  headers.delete("content-length");
  headers.set("content-type", JSON_CONTENT_TYPE);

  return new Response(JSON.stringify(input.body), {
    status: input.response.status,
    statusText: input.response.statusText,
    headers,
  });
}

function createTrackedFetch(baseFetch: typeof globalThis.fetch): {
  fetch: typeof globalThis.fetch;
  successBody: () => Record<string, unknown> | undefined;
} {
  const state: { body?: Record<string, unknown> } = {};
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const response = await baseFetch(url, init);
    if (!response.ok || !isJsonResponse(response)) {
      return response;
    }
    const parsed = responseRecordSchema.safeParse(await response.json());
    if (!parsed.success) {
      return jsonResponse({ response, body: {} });
    }
    const normalized = normalizeSuccessBody(parsed.data);
    state.body = normalized;

    return jsonResponse({ response, body: normalized });
  };

  return { successBody: () => state.body, fetch };
}

function textFromOutput(output: unknown): string {
  if (!isUnknownArray(output)) {
    return EMPTY_TEXT;
  }

  return output
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== MESSAGE_ITEM_TYPE || !isUnknownArray(item.content)) {
        return [];
      }

      return item.content.flatMap((part) =>
        isRecord(part) && part.type === OUTPUT_TEXT_PART_TYPE && typeof part.text === "string" ? [part.text] : [],
      );
    })
    .join("");
}

function withOutputText(input: { body: Record<string, unknown>; fallbackText: string }): Record<string, unknown> {
  if (typeof input.body.output_text === "string" && input.body.output_text !== EMPTY_TEXT) {
    return input.body;
  }
  const fromOutput = textFromOutput(input.body.output);
  const outputText = fromOutput !== EMPTY_TEXT ? fromOutput : input.fallbackText;

  return { ...input.body, output_text: outputText };
}

function successResult(input: {
  payload: Record<string, unknown>;
  totalUsage?: TotalUsage;
}): ExecuteOpenAIResponsesResult {
  return {
    isOk: true,
    status: HTTP_STATUS_OK,
    payload: input.payload,
    totalUsage: input.totalUsage ?? usageFromPayload(input.payload),
  };
}

function failureResult(input: { status: number; payload: Record<string, unknown> }): ExecuteOpenAIResponsesResult {
  return { isOk: false, status: input.status, payload: input.payload, totalUsage: usageFromPayload(input.payload) };
}

function parseResponsesBody(body: object): ResponsesBody {
  const parsed = responsesBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(RESPONSES_BODY_INVALID_MESSAGE);
  }

  return parsed.data;
}

function toolResultMessage(item: z.infer<typeof toolOutputInputSchema>): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: item.call_id,
        toolName: FUNCTION_TOOL_RESULT_NAME,
        output: { type: "text", value: item.output },
      },
    ],
  };
}

function toolCallInput(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = responseRecordSchema.safeParse(JSON.parse(argumentsText));
    if (parsed.success) {
      return parsed.data;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  return {};
}

function assistantToolCallMessage(item: z.infer<typeof functionCallInputSchema>): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: item.call_id,
        toolName: item.name,
        input: toolCallInput(item.arguments),
      },
    ],
  };
}

function assistantReasoningMessage(item: z.infer<typeof reasoningInputSchema>): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: EMPTY_TEXT,
        providerOptions: {
          openai: {
            ...(item.id !== undefined ? { itemId: item.id } : {}),
            ...(item.encrypted_content !== undefined ? { reasoningEncryptedContent: item.encrypted_content } : {}),
          },
        },
      },
    ],
  };
}

function systemPrompt(items: ResponsesBody["input"]): string | undefined {
  const systemItems = items.flatMap((item) => ("role" in item && item.role === "system" ? [item.content] : []));

  return systemItems.length === 0 ? undefined : systemItems.join("\n\n");
}

function conversationMessages(items: ResponsesBody["input"]): ModelMessage[] {
  return items.flatMap((item): ModelMessage[] => {
    if (!("type" in item)) {
      if (item.role === "system") {
        return [];
      }

      return [{ role: item.role, content: item.content }];
    }
    if (item.type === "function_call_output") {
      return [toolResultMessage(item)];
    }
    if (item.type === "function_call") {
      return [assistantToolCallMessage(item)];
    }

    return [assistantReasoningMessage(item)];
  });
}

function userPrompt(message: ModelMessage | undefined): string | undefined {
  if (message === undefined || message.role !== "user" || typeof message.content !== "string") {
    return undefined;
  }

  return message.content;
}

function toPrompt(items: ResponsesBody["input"]): PromptParts {
  const system = systemPrompt(items);
  const messages = conversationMessages(items);
  const prompt = messages.length === 1 ? userPrompt(messages[0]) : undefined;
  if (prompt !== undefined) {
    return { system, prompt };
  }
  if (messages.length === 0) {
    return { system, prompt: EMPTY_TEXT };
  }

  return { system, messages };
}

function buildTools(body: ResponsesBody) {
  if (body.tools === undefined) {
    return undefined;
  }

  return Object.fromEntries(
    body.tools.map((item) => [
      item.name,
      tool({
        description: item.description ?? item.name,
        inputSchema: jsonSchemaFromRecord(item.parameters),
        /** @external OpenAI function tool strict wire field */
        strict: item.strict ?? false,
      }),
    ]),
  );
}

function buildOutput(body: ResponsesBody) {
  const format = body.text?.format;
  if (format?.type === JSON_SCHEMA_FORMAT && format.schema !== undefined) {
    return Output.object({
      schema: jsonSchemaFromRecord(format.schema),
      ...(format.name !== undefined ? { name: format.name } : {}),
    });
  }
  if (format?.type === JSON_OBJECT_FORMAT) {
    return Output.json();
  }

  return undefined;
}

function buildProviderOptions(input: { body: ResponsesBody; billing?: GatewayBillingIdentity; isCounted?: boolean }) {
  const { body, billing } = input;
  const effort = body.reasoning?.effort;
  const format = body.text?.format;
  const isStored = body.store ?? false;

  return {
    ...(billing !== undefined ? { gateway: billingProviderOptions(billing) } : {}),
    openai: {
      ...(input.isCounted === true && billing !== undefined
        ? {
            metadata: { userId: billing.userId, workspaceId: billing.workspaceId, feature: billing.feature },
            safetyIdentifier: billing.userId,
          }
        : {}),
      /** @external OpenAI responses store provider option */
      store: isStored,
      ...(isStored ? {} : { include: [REASONING_ENCRYPTED_CONTENT] }),
      ...(effort !== undefined
        ? {
            reasoningEffort: effort,
            /** @external OpenAI force reasoning provider option */
            forceReasoning: true,
          }
        : {}),
      reasoningSummary: null,
      ...(body.prompt_cache_options !== undefined ? { promptCacheOptions: body.prompt_cache_options } : {}),
      ...(body.prompt_cache_retention !== undefined ? { promptCacheRetention: body.prompt_cache_retention } : {}),
      ...(body.parallel_tool_calls !== undefined
        ? {
            /** @external OpenAI parallel tool calls provider option */
            parallelToolCalls: body.parallel_tool_calls,
          }
        : {}),
      ...(format?.type === JSON_SCHEMA_FORMAT
        ? {
            /** @external OpenAI strict JSON schema provider option */
            strictJsonSchema: format.strict ?? true,
          }
        : {}),
      systemMessageMode: SYSTEM_MESSAGE_MODE,
    },
  };
}

function toolSettings(body: ResponsesBody) {
  const tools = buildTools(body);
  if (tools === undefined) {
    return {};
  }

  return {
    tools,
    ...(body.tool_choice !== undefined ? { toolChoice: body.tool_choice } : {}),
  };
}

function outputSettings(body: ResponsesBody) {
  const output = buildOutput(body);

  return output === undefined ? {} : { output };
}

function hasGatewayCredential(billing?: GatewayBillingIdentity): boolean {
  return billing !== undefined && billing.gatewayApiKey !== "";
}

async function runGenerateText(input: {
  apiKey: string;
  billing?: GatewayBillingIdentity;
  isCounted?: boolean;
  fetch: typeof globalThis.fetch;
  body: ResponsesBody;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries: number;
}) {
  const prompt = toPrompt(input.body.input);
  const shared = {
    model:
      !hasGatewayCredential(input.billing) || input.isCounted === true
        ? createOpenAI({
            apiKey: input.apiKey,
            fetch: input.fetch,
            ...(input.isCounted === true ? { baseURL: OPENAI_BASE_URL } : {}),
          }).responses(input.body.model)
        : createGateway({ apiKey: input.billing?.gatewayApiKey, fetch: input.fetch })(
            input.body.model.startsWith("openai/") ? input.body.model : `openai/${input.body.model}`,
          ),
    maxOutputTokens: input.body.max_output_tokens,
    // One reservation authorizes one provider attempt; callers must reserve again to retry.
    maxRetries: input.billing === undefined && input.isCounted !== true ? input.maxRetries : 0,
    abortSignal: input.signal,
    timeout: input.timeoutMs,
    ...toolSettings(input.body),
    ...outputSettings(input.body),
    providerOptions: buildProviderOptions({ body: input.body, billing: input.billing, isCounted: input.isCounted }),
  };
  const include = {
    /** @external AI SDK response body option */
    responseBody: true,
  };
  if (prompt.prompt !== undefined) {
    return generateText({ ...shared, include, system: prompt.system, prompt: prompt.prompt });
  }

  return generateText({ ...shared, include, system: prompt.system, messages: prompt.messages });
}

// Gateway returns SDK content, not the OpenAI wire body that legacy callers consume.
function gatewayOutput(content: unknown): Record<string, unknown>[] {
  if (!isUnknownArray(content)) {
    return [];
  }

  return content.flatMap((part, index): Record<string, unknown>[] => {
    if (!isRecord(part)) {
      return [];
    }
    if (part.type === "text" && typeof part.text === "string") {
      return [messageItem({ text: part.text, index })];
    }
    const metadata =
      isRecord(part.providerMetadata) && isRecord(part.providerMetadata.openai) ? part.providerMetadata.openai : {};
    if (part.type === "tool-call") {
      return [
        {
          type: "function_call",
          id: metadata.itemId ?? `fc_${index}`,
          call_id: part.toolCallId,
          name: part.toolName,
          arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
        },
      ];
    }
    if (part.type === "reasoning") {
      // The SDK splits summaries of one encrypted reasoning item into separate parts.
      const summaries = content.filter(
        (candidate) =>
          isRecord(candidate) &&
          candidate.type === "reasoning" &&
          (candidate === part ||
            (metadata.itemId !== undefined &&
              isRecord(candidate.providerMetadata) &&
              isRecord(candidate.providerMetadata.openai) &&
              candidate.providerMetadata.openai.itemId === metadata.itemId)),
      );
      if (summaries[0] !== part) {
        return [];
      }

      return [
        {
          type: "reasoning",
          id: metadata.itemId ?? `rs_${index}`,
          encrypted_content: metadata.reasoningEncryptedContent,
          summary: summaries.flatMap((summary) =>
            isRecord(summary) && typeof summary.text === "string" && summary.text !== EMPTY_TEXT
              ? [{ type: "summary_text", text: summary.text }]
              : [],
          ),
        },
      ];
    }

    return [];
  });
}

function gatewayResponsesPayload(input: {
  content: unknown;
  text: string;
  finishReason: string | undefined;
  response: { id?: string; modelId?: string };
  usage: TotalUsage | undefined;
}): Record<string, unknown> {
  const { usage } = input;

  return {
    id: input.response.id,
    model: input.response.modelId,
    status: input.finishReason === "length" ? "incomplete" : "completed",
    ...(input.finishReason === "length" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: gatewayOutput(input.content),
    output_text: input.text,
    usage: {
      input_tokens: usage?.inputTokens,
      output_tokens: usage?.outputTokens,
      input_tokens_details: {
        cached_tokens: usage?.cachedInputTokens,
        cache_write_tokens: usage?.cacheWriteInputTokens,
      },
    },
  };
}

function recordFromJsonText(text: string): Record<string, unknown> {
  try {
    const parsed = responseRecordSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  return { message: text };
}

function recordFromResponseBody(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    return body === EMPTY_TEXT ? {} : recordFromJsonText(body);
  }
  const parsed = responseRecordSchema.safeParse(body);

  return parsed.success ? parsed.data : {};
}

function isResponsesPayload(payload: Record<string, unknown>): boolean {
  const hasResponseField = "status" in payload || "output" in payload || "output_text" in payload;
  const hasError = payload.error !== undefined && payload.error !== null;

  return hasResponseField && !hasError;
}

function resultFromApiCallError(error: APICallError): ExecuteOpenAIResponsesResult {
  if (error.statusCode === undefined) {
    throw error;
  }
  const payload = recordFromResponseBody(error.responseBody);
  if (isResponsesPayload(payload)) {
    return successResult({ payload: withOutputText({ body: payload, fallbackText: EMPTY_TEXT }) });
  }

  return failureResult({
    status: error.statusCode,
    payload,
  });
}

function recordFromModelResponse(response: { body?: unknown } | undefined): Record<string, unknown> | undefined {
  if (response === undefined) {
    return undefined;
  }
  const parsed = responseRecordSchema.safeParse(response.body);

  return parsed.success ? parsed.data : undefined;
}

function resultFromNoObjectError(input: {
  error: NoObjectGeneratedError;
  successBody: Record<string, unknown> | undefined;
  isGateway?: boolean;
}): ExecuteOpenAIResponsesResult {
  const body = recordFromModelResponse(input.error.response) ?? input.successBody ?? {};

  return successResult({
    totalUsage: input.error.usage !== undefined ? normalizeTotalUsage(input.error.usage) : undefined,
    payload: withOutputText({
      body:
        input.isGateway === true
          ? gatewayResponsesPayload({
              content: body.content,
              text: input.error.text ?? EMPTY_TEXT,
              finishReason:
                isRecord(body.finishReason) && typeof body.finishReason.unified === "string"
                  ? body.finishReason.unified
                  : undefined,
              response: input.error.response ?? {},
              usage: input.error.usage !== undefined ? normalizeTotalUsage(input.error.usage) : undefined,
            })
          : body,
      fallbackText: input.error.text ?? EMPTY_TEXT,
    }),
  });
}

const GATEWAY_ERROR_MARKER = Symbol.for("vercel.ai.gateway.error");
const GATEWAY_FAILURE_MESSAGE = "AI Gateway rejected the request.";
const GATEWAY_AUTHENTICATION_ERROR_TYPE = "authentication_error";
const GATEWAY_AUTHENTICATION_ERROR_NAMES = new Set(["GatewayAuthenticationError", "GatewayError"]);
const gatewayErrorFieldsSchema = z.object({
  statusCode: z.number().int().min(HTTP_STATUS_MIN_ERROR).max(HTTP_STATUS_MAX),
  type: z.string().optional(),
});

function unwrapProviderError(error: unknown): unknown {
  if (RetryError.isInstance(error)) {
    return unwrapProviderError(error.lastError);
  }
  // Gateway wraps HTTP failures; the cause retains the upstream status and error body.
  if (error instanceof Error && GATEWAY_ERROR_MARKER in error && APICallError.isInstance(error.cause)) {
    return error.cause;
  }

  return error;
}

/**
 * Gateway errors raised by the Gateway itself (authentication, rate limit, bad request, ...) carry
 * an HTTP status but no upstream APICallError. Return them as failed results so billing sees the
 * status and can release holds for definitive rejections instead of keeping them as unknown.
 * The Gateway's own message (with terminal colour codes and setup hints) stays in server logs.
 */
function resultFromGatewayError(error: unknown): ExecuteOpenAIResponsesResult | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  // generateText replaces Gateway authentication errors with a status-less Error (named
  // GatewayAuthenticationError, or GatewayError in production); both mean the key was rejected.
  if (GATEWAY_AUTHENTICATION_ERROR_NAMES.has(error.name) && !(GATEWAY_ERROR_MARKER in error)) {
    return failureResult({
      status: HTTP_STATUS_UNAUTHORIZED,
      payload: { error: { message: GATEWAY_FAILURE_MESSAGE, type: GATEWAY_AUTHENTICATION_ERROR_TYPE } },
    });
  }
  if (!(GATEWAY_ERROR_MARKER in error)) {
    return undefined;
  }
  const fields = gatewayErrorFieldsSchema.safeParse(error);
  if (!fields.success) {
    return undefined;
  }

  return failureResult({
    status: fields.data.statusCode,
    payload: { error: { message: GATEWAY_FAILURE_MESSAGE, type: fields.data.type ?? "gateway_error" } },
  });
}

function resultFromCaughtError(input: {
  error: unknown;
  successBody: Record<string, unknown> | undefined;
  isGateway?: boolean;
}): ExecuteOpenAIResponsesResult {
  const error = unwrapProviderError(input.error);
  if (NoObjectGeneratedError.isInstance(error)) {
    return resultFromNoObjectError({ error, successBody: input.successBody, isGateway: input.isGateway });
  }
  if (NoOutputGeneratedError.isInstance(error)) {
    return successResult({ payload: withOutputText({ body: input.successBody ?? {}, fallbackText: EMPTY_TEXT }) });
  }
  if (APICallError.isInstance(error)) {
    return resultFromApiCallError(error);
  }
  const gatewayFailure = resultFromGatewayError(error);
  if (gatewayFailure !== undefined) {
    return gatewayFailure;
  }

  throw error;
}

const SERIALIZED_TEXT_REQUIRED = "A serialized text request is required.";
const INPUT_RESERVATION_EXCEEDED = "Serialized request exceeds its input reservation.";
const LOCAL_WIRE_FRAMING_TOKENS = 1024;

function validateInputReservation(input: { body: object; maxInputTokens?: number; init?: RequestInit }): void {
  if (input.maxInputTokens === undefined) {
    return;
  }
  if (input.init?.method !== "POST" || typeof input.init.body !== "string") {
    throw new OpenAIRequestNotDispatchedError(new Error(SERIALIZED_TEXT_REQUIRED));
  }
  validateLocallyBoundedRequest(input.body);
  const finalBytes = new TextEncoder().encode(input.init.body).length;
  if (finalBytes + LOCAL_WIRE_FRAMING_TOKENS > input.maxInputTokens) {
    throw new OpenAIRequestNotDispatchedError(new Error(INPUT_RESERVATION_EXCEEDED));
  }
}

export async function executeOpenAIResponses(
  input: ExecuteOpenAIResponsesInput,
): Promise<ExecuteOpenAIResponsesResult> {
  const baseFetch = input.fetch ?? globalThis.fetch;
  const beforeProviderCall = input.beforeProviderCall;
  const isCounted = beforeProviderCall !== undefined;
  const isGateway = hasGatewayCredential(input.billing) && !isCounted;
  const counted =
    beforeProviderCall === undefined
      ? undefined
      : createCountedFetch({ ...input, beforeProviderCall, fetch: baseFetch });
  const dispatch = { isStarted: false };
  const uncountedFetch: typeof globalThis.fetch = async (url, init) => {
    input.signal?.throwIfAborted();
    init?.signal?.throwIfAborted();
    validateInputReservation({ body: input.body, maxInputTokens: input.billing?.maxInputTokens, init });
    dispatch.isStarted = true;

    return baseFetch(url, init);
  };
  const tracked = createTrackedFetch(counted?.fetch ?? uncountedFetch);
  try {
    const result = await runGenerateText({
      apiKey: input.apiKey,
      billing: input.billing,
      isCounted,
      fetch: tracked.fetch,
      body: isCounted ? countedResponsesBodySchema.parse(input.body) : parseResponsesBody(input.body),
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries,
    });
    counted?.assertDispatched();
    const parsedBody = responseRecordSchema.safeParse(result.finalStep.response.body);

    return successResult({
      payload: withOutputText({
        body: isGateway
          ? gatewayResponsesPayload({
              content: result.content,
              text: result.text,
              finishReason: result.finishReason,
              response: result.finalStep.response,
              usage: normalizeTotalUsage(result.usage),
            })
          : parsedBody.success
            ? parsedBody.data
            : (tracked.successBody() ?? {}),
        fallbackText: result.text,
      }),
      totalUsage: normalizeTotalUsage(result.usage),
    });
  } catch (error) {
    counted?.rethrowPreflight(error);
    if (!isCounted && !dispatch.isStarted) {
      throw new OpenAIRequestNotDispatchedError(error);
    }

    return resultFromCaughtError({ error, successBody: tracked.successBody(), isGateway });
  }
}

export async function createLlmResponse(
  input: Omit<ExecuteOpenAIResponsesInput, "maxRetries">,
): Promise<ExecuteOpenAIResponsesResult> {
  return executeOpenAIResponses({ ...input, maxRetries: LLM_RESPONSES_MAX_RETRIES });
}
