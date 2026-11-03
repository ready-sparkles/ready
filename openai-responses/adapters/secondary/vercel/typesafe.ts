import { APICallError, generateText, type LanguageModel, UnsupportedFunctionalityError } from "ai";
import { z } from "zod";

import {
  type BillingIdentity,
  billingProviderOptions,
  normalizeTotalUsage,
  type TotalUsage,
  usageFromPayload,
} from "./transport-usage";

type TypeSafeLanguageModel = Extract<LanguageModel, { specificationVersion: "v4" }>;

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const EVALUATION_PROMPT = "Evaluate the supplied state and questions.";
const REQUEST_FAILED_MESSAGE = "TypeSafe request failed";
const payloadSchema = z.record(z.string(), z.unknown());

export type ExecuteTypeSafeInput = {
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  billing?: BillingIdentity;
};

export type ExecuteTypeSafeResult = {
  isOk: boolean;
  status: number;
  payload: unknown;
  rawBody: string;
  headers: Record<string, string>;
  totalUsage?: TotalUsage;
};

function parsePayload(rawBody: string): unknown {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(rawBody));

    return parsed.success ? parsed.data : rawBody;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    return rawBody;
  }
}

export function createTypeSafeModel(
  input: Omit<ExecuteTypeSafeInput, "signal" | "timeoutMs" | "billing">,
): TypeSafeLanguageModel {
  const modelId = typeof input.body.model === "string" ? input.body.model : DEFAULT_MODEL;

  return {
    specificationVersion: "v4",
    provider: "typesafe",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const body = JSON.stringify({ ...input.body, model: modelId });
      const response = await (input.fetch ?? globalThis.fetch)(TYPESAFE_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
        body,
        signal: options.abortSignal,
      });
      const rawBody = await response.text();
      if (!response.ok) {
        throw new APICallError({
          message: REQUEST_FAILED_MESSAGE,
          url: TYPESAFE_URL,
          requestBodyValues: input.body,
          statusCode: response.status,
          responseBody: rawBody,
          responseHeaders: Object.fromEntries(response.headers),
          isRetryable: false,
        });
      }
      const usage = usageFromPayload(parsePayload(rawBody));
      const billing = options.providerOptions?.gateway;

      return {
        // Keep malformed successes intact: callers must settle usage before validating answers.
        content: [{ type: "text", text: rawBody }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: usage?.inputTokens,
            noCache: undefined,
            cacheRead: usage?.cachedInputTokens,
            cacheWrite: usage?.cacheWriteInputTokens,
          },
          outputTokens: { total: usage?.outputTokens, text: undefined, reasoning: undefined },
        },
        providerMetadata: { typesafe: { status: response.status, ...(billing ?? {}) } },
        request: { body },
        response: { body: rawBody, headers: Object.fromEntries(response.headers) },
        warnings: [],
      };
    },
    doStream() {
      throw new UnsupportedFunctionalityError({ functionality: "TypeSafe streaming" });
    },
  };
}

export async function executeTypeSafeDecision(input: ExecuteTypeSafeInput): Promise<ExecuteTypeSafeResult> {
  try {
    const result = await generateText({
      model: createTypeSafeModel(input),
      prompt: EVALUATION_PROMPT,
      maxRetries: 0,
      abortSignal: input.signal,
      timeout: input.timeoutMs,
      ...(input.billing !== undefined ? { providerOptions: { gateway: billingProviderOptions(input.billing) } } : {}),
    });
    const payload = parsePayload(result.text);

    return {
      isOk: true,
      status: Number(result.finalStep.providerMetadata?.typesafe?.status),
      payload,
      rawBody: result.text,
      headers: result.finalStep.response.headers ?? {},
      ...(usageFromPayload(payload) !== undefined ? { totalUsage: normalizeTotalUsage(result.usage) } : {}),
    };
  } catch (error) {
    if (!APICallError.isInstance(error) || error.statusCode === undefined) {
      throw error;
    }
    const rawBody = error.responseBody ?? "";
    const payload = parsePayload(rawBody);

    return {
      isOk: false,
      status: error.statusCode,
      payload,
      rawBody,
      headers: error.responseHeaders ?? {},
      totalUsage: usageFromPayload(payload),
    };
  }
}
