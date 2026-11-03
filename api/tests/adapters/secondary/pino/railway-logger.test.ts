import { CONTENT_KEY_CONFIG_MESSAGES, isPublicContentKeyConfigMessage } from "@readymeet/db/domain/content-key-errors";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { z } from "zod";

import { createRailwayLogger } from "../../../../adapters/secondary/pino/railway-logger";

const INCOMPLETE_MEETING_TASKS_ERROR_MESSAGE = "Meeting tasks response was incomplete";
const POOL_CLOSED_ERROR_MESSAGE = "pool closed";
const AI_WORKFLOW_JOB_FAILED_MESSAGE = "AI workflow job failed";
const UNEXPECTED_ERROR_MESSAGE = "Unexpected error";
const PRIVATE_ERROR_MESSAGE = "Operation failed; private error details omitted.";
const PRIVATE_SENTINEL = "PRIVATE-MEETING-SENTINEL";
const CONNECTION_REFUSED_CODE = "ECONNREFUSED";
const TRANSACTION_TIMEOUT_CODE = "P2028";
const MEETING_CONTENT_KEY_CONFIG_ERROR_NAME = "MeetingContentKeyConfigError";
const MEETING_CONTENT_KEYS_UNCONFIGURED_CODE = "MEETING_CONTENT_KEYS_UNCONFIGURED";

const loggedErrorSchema = z
  .object({
    message: z.string(),
    name: z.string().optional(),
    code: z.string().optional(),
  })
  .strict();

const loggedJobFailureSchema = z.object({
  error: loggedErrorSchema,
});

const loggedPoolFailureSchema = z.object({
  err: loggedErrorSchema,
});

function createCaptureStream(): { stream: PassThrough; getChunks: () => string[] } {
  const stream = new PassThrough();
  const captureState = { chunks: [] as string[] };
  stream.on("data", (chunk: Buffer | string) => {
    captureState.chunks = [...captureState.chunks, chunk.toString()];
  });

  return { stream, getChunks: () => captureState.chunks };
}

void test("Railway logger routes info to stdout and warnings or errors to stderr", () => {
  const stdoutCapture = createCaptureStream();
  const stderrCapture = createCaptureStream();
  const logger = createRailwayLogger({ stdout: stdoutCapture.stream, stderr: stderrCapture.stream });

  logger.info("healthy-worker.");
  logger.warn("degraded-worker.");
  logger.error("failed-worker.");

  const stdoutText = stdoutCapture.getChunks().join("");
  const stderrText = stderrCapture.getChunks().join("");
  assert.match(stdoutText, /healthy-worker/);
  assert.doesNotMatch(stdoutText, /degraded-worker|failed-worker/);
  assert.match(stderrText, /degraded-worker/);
  assert.match(stderrText, /failed-worker/);
  assert.doesNotMatch(stderrText, /healthy-worker/);
});

void test("Railway logger omits private error messages, stacks and nested causes under error or err", () => {
  const stderrCapture = createCaptureStream();
  const logger = createRailwayLogger({ stdout: createCaptureStream().stream, stderr: stderrCapture.stream });

  logger.warn({ error: new Error(INCOMPLETE_MEETING_TASKS_ERROR_MESSAGE) }, AI_WORKFLOW_JOB_FAILED_MESSAGE);
  logger.error({ err: new Error(POOL_CLOSED_ERROR_MESSAGE) }, UNEXPECTED_ERROR_MESSAGE);

  const capturedChunks = stderrCapture.getChunks();
  const jobFailureRaw = capturedChunks[0];
  const poolFailureRaw = capturedChunks[1];
  const jobFailure = loggedJobFailureSchema.parse(JSON.parse(jobFailureRaw ?? ""));
  const poolFailure = loggedPoolFailureSchema.parse(JSON.parse(poolFailureRaw ?? ""));
  assert.equal(jobFailure.error.message, PRIVATE_ERROR_MESSAGE);
  assert.equal(poolFailure.err.message, PRIVATE_ERROR_MESSAGE);
  assert.doesNotMatch(stderrCapture.getChunks().join(""), /pool closed|Meeting tasks response was incomplete/u);
});

void test("Railway errors retain only fixed diagnostic names and codes", () => {
  const stderrCapture = createCaptureStream();
  const logger = createRailwayLogger({ stdout: createCaptureStream().stream, stderr: stderrCapture.stream });
  const failures = [
    {
      error: Object.assign(new Error(PRIVATE_SENTINEL), { code: CONNECTION_REFUSED_CODE }),
      expected: { name: "Error", code: CONNECTION_REFUSED_CODE },
    },
    { error: Object.assign(new Error(PRIVATE_SENTINEL), { name: "TimeoutError" }), expected: { name: "TimeoutError" } },
    {
      error: {
        name: "PrismaClientKnownRequestError",
        code: TRANSACTION_TIMEOUT_CODE,
        message: PRIVATE_SENTINEL,
        cause: { message: PRIVATE_SENTINEL },
      },
      expected: { name: "PrismaClientKnownRequestError", code: TRANSACTION_TIMEOUT_CODE },
    },
    {
      error: { name: PRIVATE_SENTINEL, code: PRIVATE_SENTINEL, message: PRIVATE_SENTINEL, stack: PRIVATE_SENTINEL },
      expected: {},
    },
    { error: null, expected: {} },
    { error: PRIVATE_SENTINEL, expected: {} },
  ];
  failures.forEach(({ error, expected }) => {
    logger.error({ err: error, error }, UNEXPECTED_ERROR_MESSAGE);
    const record = z
      .object({ err: loggedErrorSchema, error: loggedErrorSchema })
      .parse(JSON.parse(stderrCapture.getChunks().at(-1) ?? ""));
    assert.deepEqual(record.err, { message: PRIVATE_ERROR_MESSAGE, ...expected });
    assert.deepEqual(record.error, { message: PRIVATE_ERROR_MESSAGE, ...expected });
  });
  assert.equal(stderrCapture.getChunks().join("").includes(PRIVATE_SENTINEL), false);
});

void test("Railway logs name a missing meeting-content key configuration and still redact other text", () => {
  const stderrCapture = createCaptureStream();
  const logger = createRailwayLogger({ stdout: createCaptureStream().stream, stderr: stderrCapture.stream });
  Object.values(CONTENT_KEY_CONFIG_MESSAGES)
    .filter((message) => isPublicContentKeyConfigMessage(message))
    .forEach((message) => {
      logger.error(
        {
          err: {
            name: MEETING_CONTENT_KEY_CONFIG_ERROR_NAME,
            code: MEETING_CONTENT_KEYS_UNCONFIGURED_CODE,
            message,
          },
        },
        UNEXPECTED_ERROR_MESSAGE,
      );
      const record = z.object({ err: loggedErrorSchema }).parse(JSON.parse(stderrCapture.getChunks().at(-1) ?? ""));
      assert.equal(record.err.message, message);
      assert.equal(record.err.name, MEETING_CONTENT_KEY_CONFIG_ERROR_NAME);
      assert.equal(record.err.code, MEETING_CONTENT_KEYS_UNCONFIGURED_CODE);
    });
  logger.error(
    {
      err: {
        name: MEETING_CONTENT_KEY_CONFIG_ERROR_NAME,
        code: MEETING_CONTENT_KEYS_UNCONFIGURED_CODE,
        message: PRIVATE_SENTINEL,
      },
    },
    UNEXPECTED_ERROR_MESSAGE,
  );
  assert.equal(stderrCapture.getChunks().join("").includes(PRIVATE_SENTINEL), false);
  assert.equal(isPublicContentKeyConfigMessage(CONTENT_KEY_CONFIG_MESSAGES.localProviderActive), false);
});
