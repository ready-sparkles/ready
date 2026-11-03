import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  isMemoryQuotaFailure,
  memoryFailureDiagnostic,
  memoryFailureDiagnosticSchema,
  MemoryGenerationRejected,
  MemoryRequestFailed,
  rejectMemoryValidation,
} from "../domain/memory-diagnostics";

const TEST_SECRET_VALUE = "private transcript and secret@example.com";
const TEST_RESPONSE_SCHEMA_CODE = "response_schema";
const TEST_MODEL_STAGE = "model";
const TEST_INPUT_STAGE = "input";
const TEST_WORKER_STAGE = "worker";
const TEST_INVALID_ENUM_ISSUE_CODE = "invalid_enum_value";
const TEST_PROVIDER_ERROR_CODE = "provider_error";
const TEST_UNEXPECTED_ERROR_CODE = "unexpected_error";
const TEST_UNKNOWN_FACT_CODE = "unknown_fact";
const TEST_EVIDENCE_STAGE = "evidence";
const TEST_CUSTOM_ISSUE_CODE = "custom";
const TEST_FIELD_PATH_TOKEN = "field";
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const TEST_CREDIT_BALANCE_EXHAUSTED_CODE = "credit_balance_exhausted";
const TEST_INSUFFICIENT_QUOTA_TYPE = "insufficient_quota";
const TEST_RATE_LIMIT_EXCEEDED_CODE = "rate_limit_exceeded";
const TEST_SLOW_DOWN_CODE = "slow_down";
const TEST_PROJECT_SPEND_LIMIT_CODE = "project_spend_limit_exceeded";
const TEST_SECRET_PROVIDER_BODY = "secret provider body";
const TEST_SECRET_AUTHORIZATION = "secret";
const TEST_PRIVATE_EMAIL = "private@example.test";
const TEST_PRIVATE_TYPE = "private";
const TEST_SAFE_REJECTION_MESSAGE = "safe";
const TEST_PRIVATE_PROVIDER_BODY = "private provider body";
const MEMORY_DIAGNOSTIC_ISSUES_LIMIT = 12;
const ZOD_ISSUE_GENERATION_COUNT = 20;
const TEST_SECRET_EMAIL = "secret@example.com";
const TEST_TRANSPORT_ERROR_CODE = "transport_error";
const TEST_REQUEST_TIMEOUT_CODE = "request_timeout";
const TEST_REQUEST_ABORTED_CODE = "request_aborted";
const SDK_API_CALL_ERROR_NAME = "AI_APICallError";
const TIMEOUT_ERROR_NAME = "TimeoutError";
const ABORT_ERROR_NAME = "AbortError";

const EXPECTED_SCHEMA_DIAGNOSTIC = {
  code: TEST_RESPONSE_SCHEMA_CODE,
  stage: TEST_MODEL_STAGE,
  issues: [{ code: TEST_INVALID_ENUM_ISSUE_CODE, path: ["memories", 0, "category"] }],
} as const;

const EXPECTED_QUOTA_DIAGNOSTIC = {
  code: TEST_PROVIDER_ERROR_CODE,
  stage: TEST_MODEL_STAGE,
  httpStatus: HTTP_STATUS_TOO_MANY_REQUESTS,
  providerCode: TEST_CREDIT_BALANCE_EXHAUSTED_CODE,
} as const;

const EXPECTED_UNKNOWN_PROVIDER_DIAGNOSTIC = {
  code: TEST_PROVIDER_ERROR_CODE,
  stage: TEST_MODEL_STAGE,
  httpStatus: HTTP_STATUS_TOO_MANY_REQUESTS,
} as const;

const EXPECTED_UNEXPECTED_WORKER_DIAGNOSTIC = {
  code: TEST_UNEXPECTED_ERROR_CODE,
  stage: TEST_WORKER_STAGE,
} as const;

const EXPECTED_TRANSPORT_DIAGNOSTIC = {
  code: TEST_PROVIDER_ERROR_CODE,
  stage: TEST_MODEL_STAGE,
  httpStatus: HTTP_STATUS_TOO_MANY_REQUESTS,
} as const;

void test("schema diagnostics retain codes and field paths but never rejected values or messages", () => {
  const result = z
    .object({ memories: z.array(z.object({ category: z.enum(["Sales"]) })) })
    .safeParse({ memories: [{ category: TEST_SECRET_VALUE }] });
  assert.equal(result.success, false);
  const diagnostic = memoryFailureDiagnostic(result.error, TEST_MODEL_STAGE);
  assert.deepEqual(diagnostic, EXPECTED_SCHEMA_DIAGNOSTIC);
  assert.equal(JSON.stringify(diagnostic).includes(TEST_SECRET_VALUE), false);
  assert.deepEqual(memoryFailureDiagnostic(rejectMemoryValidation(result.error, TEST_MODEL_STAGE)), diagnostic);
});

void test("quota diagnostics survive transport while arbitrary provider content stays private", () => {
  const diagnostic = memoryFailureDiagnostic(
    {
      status: HTTP_STATUS_TOO_MANY_REQUESTS,
      code: TEST_CREDIT_BALANCE_EXHAUSTED_CODE,
      type: TEST_INSUFFICIENT_QUOTA_TYPE,
      message: TEST_SECRET_PROVIDER_BODY,
      headers: { authorization: TEST_SECRET_AUTHORIZATION },
    },
    TEST_MODEL_STAGE,
  );
  assert.deepEqual(diagnostic, EXPECTED_QUOTA_DIAGNOSTIC);
  const transported = new MemoryRequestFailed(
    memoryFailureDiagnosticSchema.parse(JSON.parse(JSON.stringify(diagnostic))),
  );
  assert.equal(isMemoryQuotaFailure(transported), true);
  const rateLimitPayload: unknown = { status: HTTP_STATUS_TOO_MANY_REQUESTS, code: TEST_RATE_LIMIT_EXCEEDED_CODE };
  assert.equal(isMemoryQuotaFailure(rateLimitPayload), false);
  const slowDownPayload: unknown = { status: HTTP_STATUS_TOO_MANY_REQUESTS, code: TEST_SLOW_DOWN_CODE };
  assert.equal(isMemoryQuotaFailure(slowDownPayload), false);
  const projectSpendPayload: unknown = {
    status: HTTP_STATUS_TOO_MANY_REQUESTS,
    code: TEST_PROJECT_SPEND_LIMIT_CODE,
  };
  assert.equal(isMemoryQuotaFailure(projectSpendPayload), true);
  const statusOnlyPayload: unknown = { status: HTTP_STATUS_TOO_MANY_REQUESTS };
  assert.equal(isMemoryQuotaFailure(statusOnlyPayload), false);
  const insufficientQuotaPayload: unknown = {
    status: HTTP_STATUS_TOO_MANY_REQUESTS,
    type: TEST_INSUFFICIENT_QUOTA_TYPE,
  };
  assert.equal(isMemoryQuotaFailure(insufficientQuotaPayload), true);
  assert.deepEqual(
    memoryFailureDiagnostic(
      { status: HTTP_STATUS_TOO_MANY_REQUESTS, code: TEST_PRIVATE_EMAIL, type: TEST_PRIVATE_TYPE },
      TEST_MODEL_STAGE,
    ),
    EXPECTED_UNKNOWN_PROVIDER_DIAGNOSTIC,
  );
  assert.equal(
    memoryFailureDiagnosticSchema.safeParse({ ...diagnostic, providerCode: TEST_PRIVATE_EMAIL }).success,
    false,
  );
});

void test("arbitrary field names and error messages cannot leak into diagnostics", () => {
  const error = new z.ZodError(
    Array.from({ length: ZOD_ISSUE_GENERATION_COUNT }, () => ({
      code: TEST_CUSTOM_ISSUE_CODE,
      path: ["people", 0, TEST_SECRET_EMAIL],
      message: TEST_SECRET_EMAIL,
    })),
  );
  const diagnostic = memoryFailureDiagnostic(error, TEST_INPUT_STAGE);
  const issues = diagnostic.issues;
  assert.ok(issues);
  assert.equal(issues.length, MEMORY_DIAGNOSTIC_ISSUES_LIMIT);
  const firstIssue = issues[0];
  assert.ok(firstIssue);
  assert.deepEqual(firstIssue.path, ["people", 0, TEST_FIELD_PATH_TOKEN]);
  assert.equal(JSON.stringify(diagnostic).includes(TEST_SECRET_EMAIL), false);
  assert.deepEqual(memoryFailureDiagnostic(new Error(TEST_SECRET_EMAIL)), EXPECTED_UNEXPECTED_WORKER_DIAGNOSTIC);
  assert.equal(
    memoryFailureDiagnosticSchema.safeParse({ code: TEST_SECRET_EMAIL, stage: TEST_MODEL_STAGE }).success,
    false,
  );
  assert.equal(
    memoryFailureDiagnosticSchema.safeParse({
      code: TEST_RESPONSE_SCHEMA_CODE,
      stage: TEST_MODEL_STAGE,
      issues: [{ code: TEST_CUSTOM_ISSUE_CODE, path: [TEST_SECRET_EMAIL] }],
    }).success,
    false,
  );
});

void test("provider transport names stay distinct from an unexpected error", () => {
  assert.deepEqual(
    memoryFailureDiagnostic(
      Object.assign(new Error(TEST_PRIVATE_PROVIDER_BODY), { name: SDK_API_CALL_ERROR_NAME }),
      TEST_MODEL_STAGE,
    ),
    {
      code: TEST_TRANSPORT_ERROR_CODE,
      stage: TEST_MODEL_STAGE,
    },
  );
  assert.deepEqual(
    memoryFailureDiagnostic(
      Object.assign(new Error(TEST_PRIVATE_PROVIDER_BODY), { name: TIMEOUT_ERROR_NAME }),
      TEST_MODEL_STAGE,
    ),
    {
      code: TEST_REQUEST_TIMEOUT_CODE,
      stage: TEST_MODEL_STAGE,
    },
  );
  assert.deepEqual(
    memoryFailureDiagnostic(
      Object.assign(new Error(TEST_PRIVATE_PROVIDER_BODY), { name: ABORT_ERROR_NAME }),
      TEST_MODEL_STAGE,
    ),
    {
      code: TEST_REQUEST_ABORTED_CODE,
      stage: TEST_MODEL_STAGE,
    },
  );
  assert.equal(
    JSON.stringify(
      memoryFailureDiagnostic(Object.assign(new Error(TEST_PRIVATE_PROVIDER_BODY), { name: SDK_API_CALL_ERROR_NAME })),
    ).includes("private"),
    false,
  );
});

void test("specific validation failures remain terminal while transport errors remain retryable", () => {
  const rejected = new MemoryGenerationRejected(TEST_SAFE_REJECTION_MESSAGE, {
    code: TEST_UNKNOWN_FACT_CODE,
    stage: TEST_EVIDENCE_STAGE,
  });
  assert.equal(rejectMemoryValidation(rejected, TEST_MODEL_STAGE), rejected);
  const transport = Object.assign(new Error(TEST_PRIVATE_PROVIDER_BODY), { status: HTTP_STATUS_TOO_MANY_REQUESTS });
  assert.equal(rejectMemoryValidation(transport, TEST_MODEL_STAGE), transport);
  assert.deepEqual(memoryFailureDiagnostic(transport, TEST_MODEL_STAGE), EXPECTED_TRANSPORT_DIAGNOSTIC);
});
