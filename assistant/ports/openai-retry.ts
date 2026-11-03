const OPENAI_RETRY_NOT_CONFIGURED_MESSAGE = "OpenAI retry port is not configured.";

type OpenAIRetryInput<T> = {
  operation: () => Promise<T>;
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (input: { error: unknown; attempt: number }) => void;
};

type OpenAIRetryPort = {
  withOpenAIRetry<T>(input: OpenAIRetryInput<T>): Promise<T>;
};

const openAIRetryState: { port?: OpenAIRetryPort } = {};

export function configureOpenAIRetry(port: OpenAIRetryPort): void {
  openAIRetryState.port = port;
}

function openAIRetry(): OpenAIRetryPort {
  if (openAIRetryState.port === undefined) {
    throw new Error(OPENAI_RETRY_NOT_CONFIGURED_MESSAGE);
  }

  return openAIRetryState.port;
}

export async function withOpenAIRetry<T>(input: OpenAIRetryInput<T>): Promise<T> {
  return openAIRetry().withOpenAIRetry(input);
}
