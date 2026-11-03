/**
 * Retries a call when the failure is a transient network or stream error.
 */

import { OpenAIUsageSettlementError } from "../../../ports/openai-client";

const RETRYABLE_ERROR_CODES = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

const DEFAULT_OPENAI_RETRY_ATTEMPTS = 3;
const DEFAULT_OPENAI_RETRY_BASE_DELAY_MS = 250;
const OPENAI_RETRY_BACKOFF_BASE = 2;

function collectErrorText(error: unknown): string {
  if (error === null || error === undefined) {
    return "";
  }
  if (error instanceof Error) {
    return `${error.name} ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }

  return JSON.stringify(error);
}

function candidateHasRetryableCode(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const code = (candidate as { code?: unknown }).code;

  return typeof code === "string" && RETRYABLE_ERROR_CODES.has(code);
}

function candidateMatchesRetryableText(candidate: unknown): boolean {
  const text = collectErrorText(candidate);

  return /premature close|socket hang up|network|stream closed/i.test(text);
}

export function isRetryableOpenAIError(error: unknown): boolean {
  if (error instanceof OpenAIUsageSettlementError) {
    return false;
  }
  const cause =
    error !== null && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const candidates = cause === undefined ? [error] : [error, cause];

  return candidates.some(
    (candidate) => candidateHasRetryableCode(candidate) || candidateMatchesRetryableText(candidate),
  );
}

export async function withOpenAIRetry<T>(input: {
  operation: () => Promise<T>;
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (input: { error: unknown; attempt: number }) => void;
}): Promise<T> {
  const attempts = input.attempts ?? DEFAULT_OPENAI_RETRY_ATTEMPTS;
  const baseDelayMs = input.baseDelayMs ?? DEFAULT_OPENAI_RETRY_BASE_DELAY_MS;

  const runAttempt = async (attempt: number): Promise<T> => {
    try {
      return await input.operation();
    } catch (error) {
      const isLastAttempt = attempt >= attempts;
      if (isLastAttempt || !isRetryableOpenAIError(error)) {
        throw error;
      }
      input.onRetry?.({ error, attempt });
      const delay = baseDelayMs * OPENAI_RETRY_BACKOFF_BASE ** (attempt - 1);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });

      return runAttempt(attempt + 1);
    }
  };

  return runAttempt(1);
}
