/* eslint-disable policy/named-parameters -- The create call matches the OpenAI responses API. */
import { assistantEnv } from "./assistant-env";

export function openAIClientApiKey(): string | undefined {
  const env = assistantEnv();

  return env.OPENAI_INPUT_TOKEN_COUNT_BILLING === "free"
    ? env.OPENAI_API_KEY
    : env.AI_GATEWAY_API_KEY !== undefined && env.AI_GATEWAY_API_KEY !== ""
      ? env.AI_GATEWAY_API_KEY
      : env.OPENAI_API_KEY;
}

const OPENAI_CLIENT_NOT_CONFIGURED_MESSAGE = "OpenAI client port is not configured.";

export class OpenAIUsageSettlementError extends Error {
  constructor(cause: unknown) {
    super("OpenAI usage settlement failed.", { cause });
    this.name = "OpenAIUsageSettlementError";
  }
}

export type OpenAIFunctionTool = {
  type: "function";
  name: string;
  /** @external OpenAI function tool wire field */
  strict?: boolean;
  description?: string;
  parameters: object;
};

export type OpenAIModelResponse = {
  id?: string;
  status?: string | null;
  output_text?: string;
  incomplete_details?: { reason?: string | null } | null;
  output?: OpenAIResponseOutputItem[];
  usage?: unknown;
  totalUsage?: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cachedInputTokens: number | undefined;
    cacheWriteInputTokens?: number | undefined;
  };
  error?: unknown;
};

type OpenAIResponseOutputItem = {
  type?: string;
  name?: string;
  arguments?: string;
  id?: string;
  content?: unknown;
};

export type OpenAIResponseFunctionToolCall = OpenAIResponseOutputItem & {
  type: "function_call";
  name: string;
  arguments: string;
};

export type OpenAIClientOptions = {
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
};

export type OpenAIMeteringContext = {
  meetingId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  memoryAuthorization?: {
    jobId: string;
    leaseToken: string;
    ownerUserId: string;
    meetingId: string;
    historyMemoryIds?: string[];
  };
  source: string;
  operation?: string | null;
};

export type OpenAIProviderBounds = Readonly<{
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
}>;

export type OpenAIClient = {
  responses: {
    create(
      body: Record<string, unknown>,
      options?: {
        timeout?: number;
        signal?: AbortSignal;
        beforeProviderCall?: (bounds: OpenAIProviderBounds) => Promise<void>;
        inputTokenCountBilling?: "free";
        billing?: {
          userId: string;
          workspaceId: string;
          feature: string;
          gatewayApiKey: string;
          maxInputTokens?: number;
        };
      },
    ): Promise<OpenAIModelResponse>;
  };
};

type OpenAIClientPort = {
  createOpenAIClient(options: OpenAIClientOptions): OpenAIClient;
};

const openAIClientState: { port?: OpenAIClientPort } = {};

export function configureOpenAIClient(port: OpenAIClientPort): void {
  openAIClientState.port = port;
}

export function createOpenAIClient(options: OpenAIClientOptions): OpenAIClient {
  if (openAIClientState.port === undefined) {
    throw new Error(OPENAI_CLIENT_NOT_CONFIGURED_MESSAGE);
  }

  return openAIClientState.port.createOpenAIClient(options);
}
