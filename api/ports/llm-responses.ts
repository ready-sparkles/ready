import { bindPortFunction } from "./bind-port";

const LLM_RESPONSES_PORT_IS_NOT_CONFIGURED_MESSAGE = "LLM responses port is not configured.";

export type LlmResponsesResult = {
  isOk: boolean;
  status: number;
  payload: Record<string, unknown>;
  totalUsage?: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cachedInputTokens: number | undefined;
    cacheWriteInputTokens?: number;
  };
};

type LlmProviderBounds = Readonly<{ model: string; inputTokens: number; maxOutputTokens: number }>;

export type LlmInputCountRequest = {
  apiKey: string;
  body: object;
  inputTokenCountBilling: "free";
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export type LlmResponsesRequest = {
  beforeProviderCall?: (bounds: LlmProviderBounds) => Promise<void>;
  inputTokenCountBilling?: "free";
  apiKey: string;
  billing?: { userId: string; workspaceId: string; feature: string; gatewayApiKey: string; maxInputTokens?: number };
  body: object;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

type LlmResponsesPort = {
  createLlmResponse: (input: LlmResponsesRequest) => Promise<LlmResponsesResult>;
  countOpenAIResponseInput?: (input: LlmInputCountRequest) => Promise<number>;
};

const llmResponsesState: { port?: LlmResponsesPort } = {};

export function configureLlmResponses(port: LlmResponsesPort): void {
  llmResponsesState.port = port;
}

function llmResponses(): LlmResponsesPort {
  if (llmResponsesState.port === undefined) {
    throw new Error(LLM_RESPONSES_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return llmResponsesState.port;
}

export async function countLlmResponseInput(input: LlmInputCountRequest): Promise<number> {
  const count = llmResponses().countOpenAIResponseInput;
  if (count === undefined) {
    throw new Error(LLM_RESPONSES_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return count(input);
}

export function isLlmRequestNotDispatched(error: unknown): error is Error & { cause?: unknown } {
  return (
    error instanceof Error && "isProviderRequestDispatched" in error && error.isProviderRequestDispatched === false
  );
}

export const createLlmResponse: LlmResponsesPort["createLlmResponse"] = bindPortFunction(
  () => llmResponses().createLlmResponse,
);
