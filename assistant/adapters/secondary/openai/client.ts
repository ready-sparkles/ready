/* eslint-disable policy/named-parameters -- The wrapper matches the OpenAI responses API. */
import { executeOpenAIResponses, OpenAIRequestNotDispatchedError } from "@readymeet/openai-responses";
import { z } from "zod";

import type { OpenAIClient, OpenAIClientOptions, OpenAIModelResponse } from "../../../ports/openai-client";

const providerErrorPayloadSchema = z.object({
  error: z.object({
    code: z.unknown(),
    type: z.unknown(),
    message: z.unknown(),
  }),
});

const BILLING_IDENTITY_REQUIRED_MESSAGE = "Explicit billing identity is required for assistant OpenAI calls.";
const OPENAI_REQUEST_ABORTED_MESSAGE = "Request was aborted.";
const ABORT_ERROR_NAME = "AbortError";
const TIMEOUT_ERROR_NAME = "TimeoutError";

const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 500;
const SECRET_LIKE_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_*-]{4,}|\bBearer\s+\S+/gi;
const REDACTED_SECRET = "[redacted]";

function sanitizeProviderErrorMessage(message: string): string {
  const redacted = message.replace(SECRET_LIKE_PATTERN, REDACTED_SECRET).trim();

  return redacted.length > MAX_PROVIDER_ERROR_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH)}…`
    : redacted;
}

function openAIResponsesFailedMessage(input: {
  status: number;
  code: string | undefined;
  providerMessage: string | undefined;
}): string {
  const codeSuffix = input.code !== undefined && input.code !== "" ? ` [${input.code}]` : "";
  const detail =
    input.providerMessage !== undefined && input.providerMessage !== "" ? `: ${input.providerMessage}` : ".";

  return `OpenAI responses request failed (${input.status})${codeSuffix}${detail}`;
}

class OpenAIResponsesRequestFailed extends Error {
  readonly providerResponse: OpenAIModelResponse;
  readonly status: number;
  readonly hasProviderUsage: boolean;
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly providerMessage: string | undefined;

  constructor(input: {
    status: number;
    payload: Record<string, unknown>;
    totalUsage?: OpenAIModelResponse["totalUsage"];
    hasProviderUsage: boolean;
  }) {
    const parsed = providerErrorPayloadSchema.safeParse(input.payload);
    const details = parsed.success ? parsed.data.error : {};
    const code = typeof details.code === "string" ? details.code : undefined;
    const providerMessage =
      typeof details.message === "string" && details.message.trim() !== ""
        ? sanitizeProviderErrorMessage(details.message)
        : undefined;
    super(openAIResponsesFailedMessage({ status: input.status, code, providerMessage }));
    this.name = "OpenAIResponsesRequestFailed";
    this.providerResponse = { ...input.payload, totalUsage: input.totalUsage };
    this.status = input.status;
    this.hasProviderUsage = input.hasProviderUsage;
    this.code = code;
    this.type = typeof details.type === "string" ? details.type : undefined;
    this.providerMessage = providerMessage;
  }
}

function hasAbortName(error: unknown): boolean {
  return error instanceof Error && (error.name === ABORT_ERROR_NAME || error.name === TIMEOUT_ERROR_NAME);
}

function toAbortError(input: { error: unknown; signal?: AbortSignal }): unknown {
  if (input.signal?.aborted !== true || hasAbortName(input.error)) {
    return input.error;
  }
  const reason: unknown = input.signal.reason;
  const message = reason instanceof Error && reason.message !== "" ? reason.message : OPENAI_REQUEST_ABORTED_MESSAGE;
  const abortError = new Error(message, { cause: input.error });
  abortError.name = ABORT_ERROR_NAME;

  return abortError;
}

export function createOpenAIClient(options: OpenAIClientOptions): OpenAIClient {
  return {
    responses: {
      async create(body, requestOptions): Promise<OpenAIModelResponse> {
        if (!requestOptions?.billing) {
          throw new Error(BILLING_IDENTITY_REQUIRED_MESSAGE);
        }
        const signal = requestOptions.signal;
        try {
          const result = await executeOpenAIResponses({
            apiKey: options.apiKey,
            body,
            signal,
            timeoutMs: requestOptions.timeout ?? options.timeout,
            maxRetries: 0,
            billing: requestOptions.billing,
            fetch: options.fetch,
            beforeProviderCall: requestOptions.beforeProviderCall,
            inputTokenCountBilling: requestOptions.inputTokenCountBilling,
          });
          if (!result.isOk) {
            throw new OpenAIResponsesRequestFailed({
              status: result.status,
              payload: result.payload,
              totalUsage: result.totalUsage,
              hasProviderUsage: result.totalUsage !== undefined || result.payload.usage !== undefined,
            });
          }

          return { ...result.payload, totalUsage: result.totalUsage };
        } catch (error) {
          if (error instanceof OpenAIRequestNotDispatchedError) {
            throw error;
          }
          throw toAbortError({ error, signal });
        }
      },
    },
  };
}
