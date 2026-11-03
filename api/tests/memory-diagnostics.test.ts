import "../composition/env";

import {
  memoryFailureDiagnostic,
  type MemoryGenerationInput,
  MemoryGenerationRejected,
  MemoryRequestFailed,
} from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { triggerMemoryGeneration } from "../adapters/secondary/undici/assistant-client";

const RESPONSE_SCHEMA_DIAGNOSTIC_CODE = "response_schema";
const MODEL_DIAGNOSTIC_STAGE = "model";
const INVALID_STRING_ISSUE_CODE = "invalid_string";
const MEMORY_ISSUE_REF_PATH = ["memories", 0, "ref"];
const PRIVATE_MODEL_OUTPUT_MESSAGE = "private model output";
const SECRET_EXAMPLE_EMAIL = "secret@example.com";
const NOT_JSON_SECRET_RESPONSE_BODY = "not-json secret@example.com";
const PRIVATE_RESPONSE_MESSAGE = "private";
const ASSISTANT_REJECTED_DIAGNOSTIC_CODE = "assistant_rejected";
const API_DIAGNOSTIC_STAGE = "api";
const PROVIDER_ERROR_DIAGNOSTIC_CODE = "provider_error";
const MEMORY_GENERATION_JOB_ID = "job";
const MEMORY_GENERATION_LEASE_TOKEN = "lease";

const HTTP_STATUS_UNPROCESSABLE_ENTITY = 422;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;

const emptyMemoryGenerationInput = z
  .custom<MemoryGenerationInput>((_value): _value is MemoryGenerationInput => true)
  .parse({});

void test("assistant diagnostic survives the HTTP boundary without raw response text", async (t) => {
  const diagnostic = {
    code: RESPONSE_SCHEMA_DIAGNOSTIC_CODE,
    stage: MODEL_DIAGNOSTIC_STAGE,
    issues: [{ code: INVALID_STRING_ISSUE_CODE, path: MEMORY_ISSUE_REF_PATH }],
  };
  const calls = { count: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    calls.count += 1;

    return new Response(
      JSON.stringify({
        diagnostic,
        message: PRIVATE_MODEL_OUTPUT_MESSAGE,
        secret: SECRET_EXAMPLE_EMAIL,
      }),
      {
        status: HTTP_STATUS_UNPROCESSABLE_ENTITY,
      },
    );
  });
  await assert.rejects(
    () =>
      triggerMemoryGeneration(emptyMemoryGenerationInput, {
        jobId: MEMORY_GENERATION_JOB_ID,
        leaseToken: MEMORY_GENERATION_LEASE_TOKEN,
      }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryGenerationRejected);
      assert.deepEqual(memoryFailureDiagnostic(error), diagnostic);
      assert.equal(JSON.stringify(error).includes("private"), false);
      assert.equal(JSON.stringify(error).includes("secret@example.com"), false);

      return true;
    },
  );
  assert.equal(calls.count, 1);
});

void test("malformed/legacy diagnostics are consumed and safely downgraded", async (t) => {
  await [
    NOT_JSON_SECRET_RESPONSE_BODY,
    JSON.stringify({
      message: PRIVATE_RESPONSE_MESSAGE,
      diagnostic: { code: SECRET_EXAMPLE_EMAIL, stage: MODEL_DIAGNOSTIC_STAGE },
    }),
  ].reduce(async (previous, body) => {
    await previous;
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status: HTTP_STATUS_UNPROCESSABLE_ENTITY }));
    await assert.rejects(
      () =>
        triggerMemoryGeneration(emptyMemoryGenerationInput, {
          jobId: MEMORY_GENERATION_JOB_ID,
          leaseToken: MEMORY_GENERATION_LEASE_TOKEN,
        }),
      (error: unknown) => {
        assert.deepEqual(memoryFailureDiagnostic(error), {
          code: ASSISTANT_REJECTED_DIAGNOSTIC_CODE,
          stage: API_DIAGNOSTIC_STAGE,
        });
        assert.equal(JSON.stringify(error).includes("secret@example.com"), false);

        return true;
      },
    );
  }, Promise.resolve());
});

void test("provider errors keep their diagnostic for terminal failure reporting", async (t) => {
  const diagnostic = {
    code: PROVIDER_ERROR_DIAGNOSTIC_CODE,
    stage: MODEL_DIAGNOSTIC_STAGE,
    httpStatus: HTTP_STATUS_TOO_MANY_REQUESTS,
  };
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ diagnostic }), { status: HTTP_STATUS_SERVICE_UNAVAILABLE }),
  );
  await assert.rejects(
    () =>
      triggerMemoryGeneration(emptyMemoryGenerationInput, {
        jobId: MEMORY_GENERATION_JOB_ID,
        leaseToken: MEMORY_GENERATION_LEASE_TOKEN,
      }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryRequestFailed);
      assert.equal(error instanceof MemoryGenerationRejected, false);
      assert.deepEqual(memoryFailureDiagnostic(error), diagnostic);

      return true;
    },
  );
});
