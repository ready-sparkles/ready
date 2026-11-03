import { z } from "zod";

const codes = [
  "input_schema",
  "input_too_large",
  "response_incomplete",
  "response_json",
  "response_schema",
  "output_schema",
  "invalid_segment_reference",
  "duplicate_memory_reference",
  "unknown_person",
  "duplicate_person",
  "unknown_fact",
  "ungrounded_evidence",
  "unknown_memory_reference",
  "cross_person_reference",
  "incomplete_summary",
  "missing_person_summary",
  "assistant_rejected",
  "provider_error",
  "request_aborted",
  "request_timeout",
  "transport_error",
  "unexpected_error",
] as const;
const stages = ["input", "model", "evidence", "projection", "api", "worker"] as const;
const quotaProviderCodes = [
  "credit_balance_exhausted",
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
] as const;
const providerCodes = [...quotaProviderCodes, "rate_limit_exceeded", "slow_down"] as const;
const fields = [
  "memories",
  "people",
  "summary",
  "standing",
  "ref",
  "title",
  "description",
  "category",
  "personIds",
  "personId",
  "candidateSubjectId",
  "candidateSubjectKey",
  "evidence",
  "segmentId",
  "quote",
  "factIdentity",
  "subject",
  "predicate",
  "object",
  "context",
  "existingFactKey",
  "importance",
  "sensitive",
  "confidence",
  "memoryRefs",
  "memoryIds",
  "history",
  "preferences",
  "includeSensitive",
  "language",
  "meetingId",
  "ownerUserId",
  "occurredAt",
  "segments",
  "id",
  "speakerUserId",
  "speakerName",
  "content",
  "startedAt",
  "knownFacts",
  "key",
  "identity",
  "suppressed",
  "segmentOrder",
  "name",
  "userId",
  "field",
] as const;
const MEMORY_HTTP_STATUS_MIN = 400;
const MEMORY_HTTP_STATUS_MAX = 599;
const MEMORY_DIAGNOSTIC_ISSUE_PATH_MAX = 1_000_000;
const MEMORY_DIAGNOSTIC_ISSUES_MAX = 12;
const MEMORY_ASSISTANT_REQUEST_FAILED_MESSAGE = "Memory assistant request failed";
const MEMORY_VALIDATION_REJECTED_MESSAGE = "Memory validation rejected the response";
const MEMORY_PROVIDER_ERROR_CODE = "provider_error";
const MEMORY_REQUEST_ABORTED_CODE = "request_aborted";
const MEMORY_REQUEST_TIMEOUT_CODE = "request_timeout";
const MEMORY_TRANSPORT_ERROR_CODE = "transport_error";
const MEMORY_UNEXPECTED_ERROR_CODE = "unexpected_error";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMemoryDiagnosticField = (value: string): value is (typeof fields)[number] =>
  (fields as readonly string[]).includes(value);

// This is the complete log/transport allowlist. Never log Error.message, Zod
// messages/received values, model output, quotes, titles, names or transcript text.
export const memoryFailureDiagnosticSchema = z.object({
  code: z.enum(codes),
  stage: z.enum(stages),
  httpStatus: z.number().int().min(MEMORY_HTTP_STATUS_MIN).max(MEMORY_HTTP_STATUS_MAX).optional(),
  providerCode: z.enum(providerCodes).optional(),
  issues: z
    .array(
      z.object({
        code: z.nativeEnum(z.ZodIssueCode),
        path: z
          .array(z.union([z.enum(fields), z.number().int().min(0).max(MEMORY_DIAGNOSTIC_ISSUE_PATH_MAX)]))
          .max(MEMORY_DIAGNOSTIC_ISSUES_MAX),
      }),
    )
    .max(MEMORY_DIAGNOSTIC_ISSUES_MAX)
    .optional(),
});
export type MemoryFailureDiagnostic = z.infer<typeof memoryFailureDiagnosticSchema>;
const MEMORY_ASSISTANT_REJECTED_DEFAULT_DIAGNOSTIC: MemoryFailureDiagnostic = {
  code: "assistant_rejected",
  stage: "model",
};
/** Retryable assistant/transport failure; distinct from a terminal validation rejection. */
export class MemoryRequestFailed extends Error {
  readonly diagnostic: MemoryFailureDiagnostic;
  constructor(diagnostic: MemoryFailureDiagnostic) {
    super(MEMORY_ASSISTANT_REQUEST_FAILED_MESSAGE);
    this.name = "MemoryRequestFailed";
    this.diagnostic = memoryFailureDiagnosticSchema.parse(diagnostic);
  }
}
export class MemoryGenerationRejected extends Error {
  readonly diagnostic: MemoryFailureDiagnostic;
  constructor(...args: [string, MemoryFailureDiagnostic?]) {
    const [message, diagnostic = MEMORY_ASSISTANT_REJECTED_DEFAULT_DIAGNOSTIC] = args;
    super(message);
    this.name = "MemoryGenerationRejected";
    this.diagnostic = memoryFailureDiagnosticSchema.parse(diagnostic);
  }
}

const memoryDiagnosticIssuePathPart = (part: string | number): number | (typeof fields)[number] | "field" =>
  typeof part === "number"
    ? Math.max(0, Math.min(MEMORY_DIAGNOSTIC_ISSUE_PATH_MAX, Math.floor(part)))
    : typeof part === "string" && isMemoryDiagnosticField(part)
      ? part
      : "field";

const memoryFailureDiagnosticFromZod = (input: {
  error: z.ZodError;
  stage: MemoryFailureDiagnostic["stage"];
}): MemoryFailureDiagnostic => ({
  code: input.stage === "input" ? "input_schema" : input.stage === "model" ? "response_schema" : "output_schema",
  stage: input.stage,
  issues: input.error.issues.slice(0, MEMORY_DIAGNOSTIC_ISSUES_MAX).map((issue) => ({
    code: issue.code,
    path: issue.path.slice(0, MEMORY_DIAGNOSTIC_ISSUES_MAX).map(memoryDiagnosticIssuePathPart),
  })),
});

const memoryFailureDiagnosticFromHttpRecord = (input: {
  error: Record<string, unknown>;
  stage: MemoryFailureDiagnostic["stage"];
}): MemoryFailureDiagnostic | undefined => {
  const status = input.error["status"];
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < MEMORY_HTTP_STATUS_MIN ||
    status > MEMORY_HTTP_STATUS_MAX
  ) {
    return undefined;
  }
  const providerCodeValue = input.error["code"];
  const providerType = input.error["type"];
  const providerCode =
    providerCodes.find((code) => code === providerCodeValue) ??
    (providerType === "insufficient_quota" ? "insufficient_quota" : undefined);

  return {
    code: MEMORY_PROVIDER_ERROR_CODE,
    stage: input.stage,
    httpStatus: status,
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
};

const memoryFailureDiagnosticFromNamedError = (input: {
  error: Record<string, unknown>;
  stage: MemoryFailureDiagnostic["stage"];
}): MemoryFailureDiagnostic | undefined => {
  const name = input.error["name"];
  if (name === "APIUserAbortError" || name === "AbortError") {
    return { code: MEMORY_REQUEST_ABORTED_CODE, stage: input.stage };
  }
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError") {
    return { code: MEMORY_REQUEST_TIMEOUT_CODE, stage: input.stage };
  }
  if (name === "APIConnectionError" || name === "AI_APICallError") {
    return { code: MEMORY_TRANSPORT_ERROR_CODE, stage: input.stage };
  }

  return undefined;
};

function memoryFailureDiagnosticImpl(input: {
  error: unknown;
  stage: MemoryFailureDiagnostic["stage"];
}): MemoryFailureDiagnostic {
  const { error, stage } = input;
  if (error instanceof MemoryGenerationRejected || error instanceof MemoryRequestFailed) {
    return memoryFailureDiagnosticSchema.parse(error.diagnostic);
  }
  if (error instanceof z.ZodError) {
    return memoryFailureDiagnosticFromZod({ error, stage });
  }
  if (isRecord(error)) {
    const httpDiagnostic = memoryFailureDiagnosticFromHttpRecord({ error, stage });
    if (httpDiagnostic !== undefined) {
      return httpDiagnostic;
    }
    const namedDiagnostic = memoryFailureDiagnosticFromNamedError({ error, stage });
    if (namedDiagnostic !== undefined) {
      return namedDiagnostic;
    }
  }

  return { code: MEMORY_UNEXPECTED_ERROR_CODE, stage };
}

export function memoryFailureDiagnostic(
  ...args: [unknown] | [unknown, MemoryFailureDiagnostic["stage"]]
): MemoryFailureDiagnostic {
  const [error, stage = "worker"] = args;

  return memoryFailureDiagnosticImpl({ error, stage });
}
export function isMemoryQuotaFailure(error: unknown): boolean {
  const { providerCode } = memoryFailureDiagnostic(error);

  return quotaProviderCodes.some((code) => code === providerCode);
}
export function rejectMemoryValidation(...args: [unknown, MemoryFailureDiagnostic["stage"]]): unknown {
  const [error, stage] = args;
  if (error instanceof MemoryGenerationRejected || !(error instanceof z.ZodError)) {
    return error;
  }

  return new MemoryGenerationRejected(MEMORY_VALIDATION_REJECTED_MESSAGE, memoryFailureDiagnostic(error, stage));
}
