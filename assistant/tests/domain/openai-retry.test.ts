import assert from "node:assert/strict";
import { test } from "node:test";

import { isRetryableOpenAIError, withOpenAIRetry } from "../../adapters/secondary/openai/openai-retry";

const MESSAGE_ABORTED = "aborted";
const MESSAGE_INVALID_RESPONSE_BODY = "Invalid response body while trying to fetch: Premature close";
const MESSAGE_REQUEST_FAILED = "request failed";
const MESSAGE_RESET = "reset";
const MESSAGE_BAD_REQUEST = "bad request";
const MESSAGE_OTHER = "x";
const MESSAGE_PREMATURE_CLOSE = "Premature close";
const MESSAGE_VALIDATION_FAILED = "validation failed";
const CODE_ERR_STREAM_PREMATURE_CLOSE = "ERR_STREAM_PREMATURE_CLOSE";
const CODE_ECONNRESET = "ECONNRESET";
const CODE_ERR_OTHER = "ERR_OTHER";
const RETRY_ATTEMPTS_THREE = 3;
const RETRY_ATTEMPTS_TWO = 2;
const BASE_DELAY_MS = 1;
const RESULT_OK = "ok";

void test("isRetryableOpenAIError matches premature close by code", () => {
  const error = Object.assign(new Error(MESSAGE_ABORTED), { code: CODE_ERR_STREAM_PREMATURE_CLOSE });
  assert.equal(isRetryableOpenAIError(error), true);
});

void test("isRetryableOpenAIError matches premature close by message", () => {
  const error = new Error(MESSAGE_INVALID_RESPONSE_BODY);
  assert.equal(isRetryableOpenAIError(error), true);
});

void test("isRetryableOpenAIError inspects the error cause", () => {
  const error = new Error(MESSAGE_REQUEST_FAILED, {
    cause: Object.assign(new Error(MESSAGE_RESET), { code: CODE_ECONNRESET }),
  });
  assert.equal(isRetryableOpenAIError(error), true);
});

void test("isRetryableOpenAIError ignores non-transient errors", () => {
  assert.equal(isRetryableOpenAIError(new Error(MESSAGE_BAD_REQUEST)), false);
  assert.equal(isRetryableOpenAIError(Object.assign(new Error(MESSAGE_OTHER), { code: CODE_ERR_OTHER })), false);
});

void test("withOpenAIRetry retries a transient failure then succeeds", async () => {
  const state = { calls: 0 };
  const result = await withOpenAIRetry({
    operation: async () => {
      state.calls += 1;
      if (state.calls < RETRY_ATTEMPTS_THREE) {
        throw Object.assign(new Error(MESSAGE_PREMATURE_CLOSE), { code: CODE_ERR_STREAM_PREMATURE_CLOSE });
      }

      return RESULT_OK;
    },
    attempts: RETRY_ATTEMPTS_THREE,
    baseDelayMs: BASE_DELAY_MS,
  });
  assert.equal(result, RESULT_OK);
  assert.equal(state.calls, RETRY_ATTEMPTS_THREE);
});

void test("withOpenAIRetry does not retry non-transient errors", async () => {
  const state = { calls: 0 };
  await assert.rejects(
    withOpenAIRetry({
      operation: async () => {
        state.calls += 1;
        throw new Error(MESSAGE_VALIDATION_FAILED);
      },
      attempts: RETRY_ATTEMPTS_THREE,
      baseDelayMs: BASE_DELAY_MS,
    }),
    new RegExp(MESSAGE_VALIDATION_FAILED),
  );
  assert.equal(state.calls, 1);
});

void test("withOpenAIRetry gives up after the attempt budget", async () => {
  const state = { calls: 0 };
  await assert.rejects(
    withOpenAIRetry({
      operation: async () => {
        state.calls += 1;
        throw Object.assign(new Error(MESSAGE_PREMATURE_CLOSE), { code: CODE_ERR_STREAM_PREMATURE_CLOSE });
      },
      attempts: RETRY_ATTEMPTS_TWO,
      baseDelayMs: BASE_DELAY_MS,
    }),
    new RegExp(MESSAGE_PREMATURE_CLOSE),
  );
  assert.equal(state.calls, RETRY_ATTEMPTS_TWO);
});
