import {
  INSUFFICIENT_CREDITS_CODE,
  INSUFFICIENT_CREDITS_USER_MESSAGE,
  MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE,
  MeetingTitleTranscriptRequired,
  MEMORY_EXTRACTION_REQUEST_TIMEOUT_MS,
  type MemoryFailureDiagnostic,
  memoryFailureDiagnosticSchema,
  type MemoryGenerationInput,
  MemoryGenerationRejected,
  MemoryRequestFailed,
  type VoiceSearchIdentityEvidence,
} from "@readymeet/shared";
import { z } from "zod";

import { apiEnv } from "../../../ports/api-env";
import {
  extractionResponseSchema,
  memoryGenerationResponseSchema,
  snapshotResponseSchema,
  tasksResponseSchema,
} from "../../../ports/gate-assistant-client";

import { Agent } from "./sdk";

const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_PAYMENT_REQUIRED_STATUS = 402;
const HTTP_INTERNAL_SERVER_ERROR_STATUS = 500;
const HTTP_PAYLOAD_TOO_LARGE_STATUS = 413;
const HTTP_UNPROCESSABLE_ENTITY_STATUS = 422;

const MESSAGE_ASSISTANT_REQUEST_TIMED_OUT_PREFIX = "Assistant service request timed out after ";
const MESSAGE_ASSISTANT_REQUEST_TIMED_OUT_SUFFIX = "ms";
const MESSAGE_ASSISTANT_CLIENT_NON_ERROR_LOG = "[assistant-client] Error (non-Error thrown):.";
const MESSAGE_ASSISTANT_SERVICE_ERROR_PREFIX = "Assistant service error (";
const MESSAGE_ASSISTANT_SERVICE_ERROR_MIDDLE = "): ";
const MESSAGE_MEMORY_ASSISTANT_REJECTED_PREFIX = "Memory assistant rejected request (";
const MESSAGE_MEMORY_ASSISTANT_REJECTED_SUFFIX = ")";
const MESSAGE_ASSISTANT_EMPTY_RESPONSE_BODY = "";

const ASSISTANT_TITLE_REQUEST_MEETING_IN_PROGRESS_FIELD = "meetingInProgress";
const ASSISTANT_CAPABILITY_SELECTION_FORCE_REFRESH_FIELD = "forceRefresh";

const assistantJsonRecordSchema = z.record(z.string(), z.unknown());

const postCallSummaryResponseSchema = z.object({
  summary: z.unknown(),
  actionItems: z.array(z.unknown()),
});

const meetingTitleResponseSchema = z.object({
  title: z.string(),
  preparationLines: z.array(z.string()),
  preparationLinesFallback: z.boolean(),
  model: z.string(),
});

const liveTranscriptionStartResponseSchema = z.object({
  ok: z.boolean(),
  started: z.boolean(),
});

const liveTranscriptionStopResponseSchema = z.object({
  ok: z.boolean(),
  stopped: z.boolean(),
  finalized: z.boolean().optional(),
});

const roomAssistantStartResponseSchema = z.object({
  ok: z.boolean(),
  started: z.boolean(),
});

const roomAssistantStopResponseSchema = z.object({
  ok: z.boolean(),
  stopped: z.boolean(),
  drained: z.boolean().optional(),
});

const memoryFailureBodySchema = z.object({
  diagnostic: memoryFailureDiagnosticSchema.optional(),
});

const assistantErrorCodeBodySchema = z.object({
  code: z.string(),
});

/**
 * A non-2xx assistant response. Status and body stay readable on the error.
 *
 * A 402 is a credit or plan refusal that reaches the user, so it carries a `code`
 * (the assistant's, else `insufficient_credits`) and a fixed user-facing message
 * instead of the raw upstream body. Other statuses keep the raw message; the API
 * error handler answers those with a generic 500.
 */
class AssistantServiceError extends Error {
  readonly statusCode: number;
  readonly status: number;
  readonly responseText: string;
  readonly code: string | undefined;

  constructor(input: { status: number; text: string }) {
    const isPaymentRequired = input.status === HTTP_PAYMENT_REQUIRED_STATUS;
    super(isPaymentRequired ? INSUFFICIENT_CREDITS_USER_MESSAGE : formatAssistantServiceErrorMessage(input));
    this.name = "AssistantServiceError";
    this.statusCode = isPaymentRequired ? HTTP_PAYMENT_REQUIRED_STATUS : HTTP_INTERNAL_SERVER_ERROR_STATUS;
    this.status = input.status;
    this.responseText = input.text;
    this.code = isPaymentRequired ? (parseAssistantErrorCode(input.text) ?? INSUFFICIENT_CREDITS_CODE) : undefined;
  }
}

function parseAssistantErrorCode(responseText: string): string | null {
  try {
    const parsed = assistantErrorCodeBodySchema.safeParse(JSON.parse(responseText));

    return parsed.success ? parsed.data.code : null;
  } catch (parseError) {
    if (parseError instanceof SyntaxError) {
      return null;
    }
    throw parseError;
  }
}

type PostCallSummaryResponse = z.infer<typeof postCallSummaryResponseSchema>;
type ExtractionResponse = z.infer<typeof extractionResponseSchema>;
type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;
type MeetingTitleResponse = {
  title: string;
  preparationLines: string[];
  /** @external assistant title endpoint preparation lines fallback flag */
  preparationLinesFallback: boolean;
  model: string;
};
type TasksResponse = z.infer<typeof tasksResponseSchema>;
type LiveTranscriptionStartResponse = {
  /** @external assistant live transcription ok flag */
  ok: boolean;
  /** @external assistant live transcription started flag */
  started: boolean;
};
type LiveTranscriptionStopResponse = {
  /** @external assistant live transcription ok flag */
  ok: boolean;
  /** @external assistant live transcription stopped flag */
  stopped: boolean;
  /** @external assistant live transcription finalized flag */
  finalized?: boolean;
};
type RoomAssistantStartResponse = {
  /** @external assistant room assistant ok flag */
  ok: boolean;
  /** @external assistant room assistant started flag */
  started: boolean;
};
type RoomAssistantStopResponse = {
  /** @external assistant room assistant ok flag */
  ok: boolean;
  /** @external assistant room assistant stopped flag */
  stopped: boolean;
  /** @external assistant room assistant drained flag */
  drained?: boolean;
};
type MemoryGenerationResponse = z.infer<typeof memoryGenerationResponseSchema>;

function formatAssistantRequestTimedOutMessage(timeoutMs: number): string {
  return `${MESSAGE_ASSISTANT_REQUEST_TIMED_OUT_PREFIX}${timeoutMs}${MESSAGE_ASSISTANT_REQUEST_TIMED_OUT_SUFFIX}`;
}

function formatAssistantServiceErrorMessage(input: { status: number; text: string }): string {
  return `${MESSAGE_ASSISTANT_SERVICE_ERROR_PREFIX}${input.status}${MESSAGE_ASSISTANT_SERVICE_ERROR_MIDDLE}${input.text}`;
}

function formatMemoryAssistantRejectedMessage(status: number): string {
  return `${MESSAGE_MEMORY_ASSISTANT_REJECTED_PREFIX}${status}${MESSAGE_MEMORY_ASSISTANT_REJECTED_SUFFIX}`;
}

function createTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(formatAssistantRequestTimedOutMessage(timeoutMs)));
  }, timeoutMs);
  timeoutId.unref();

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

function logAssistantClientError(input: { url: string; error: unknown }): void {
  console.error(MESSAGE_ASSISTANT_CLIENT_NON_ERROR_LOG, {
    url: input.url,
    errorType: input.error instanceof Error ? input.error.name : typeof input.error,
  });
}

async function triggerPostCallSummaryNamed(input: { meetingId: string }): Promise<PostCallSummaryResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/summarize`,
    body: { meetingId: input.meetingId },
    timeoutMs: apiEnv().ASSISTANT_SERVICE_SUMMARY_TIMEOUT_MS,
    responseSchema: postCallSummaryResponseSchema,
  });
}

export async function triggerPostCallSummary(...args: [meetingId: string]): Promise<PostCallSummaryResponse> {
  return triggerPostCallSummaryNamed({ meetingId: args[0] });
}

type AssistantMeteringContext = {
  meetingId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

async function triggerMeetingExtractionNamed(input: {
  meetingId: string;
  metering?: AssistantMeteringContext;
}): Promise<ExtractionResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/extract`,
    body: { meetingId: input.meetingId, metering: input.metering },
    timeoutMs: apiEnv().ASSISTANT_SERVICE_EXTRACTION_TIMEOUT_MS,
    responseSchema: extractionResponseSchema,
  });
}

export async function triggerMeetingExtraction(
  ...args: [meetingId: string, metering?: AssistantMeteringContext]
): Promise<ExtractionResponse> {
  return triggerMeetingExtractionNamed({ meetingId: args[0], metering: args[1] });
}

async function triggerMeetingSnapshotNamed(input: {
  meetingId: string;
  metering?: AssistantMeteringContext;
}): Promise<SnapshotResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/snapshot`,
    body: { meetingId: input.meetingId, metering: input.metering },
    timeoutMs: apiEnv().ASSISTANT_SERVICE_SNAPSHOT_TIMEOUT_MS,
    responseSchema: snapshotResponseSchema,
  });
}

export async function triggerMeetingSnapshot(
  ...args: [meetingId: string, metering?: AssistantMeteringContext]
): Promise<SnapshotResponse> {
  return triggerMeetingSnapshotNamed({ meetingId: args[0], metering: args[1] });
}

async function triggerMeetingTitleNamed(input: {
  meetingId: string;
  metering?: AssistantMeteringContext;
  isMeetingInProgress?: boolean;
}): Promise<MeetingTitleResponse> {
  const isMeetingInProgress = input.isMeetingInProgress ?? false;

  const titleRequestBody: Record<string, unknown> = {
    meetingId: input.meetingId,
    metering: input.metering,
  };
  titleRequestBody[ASSISTANT_TITLE_REQUEST_MEETING_IN_PROGRESS_FIELD] = isMeetingInProgress;

  try {
    return await requestAssistantNamed({
      path: `/internal/meetings/${input.meetingId}/title`,
      body: titleRequestBody,
      timeoutMs: apiEnv().ASSISTANT_SERVICE_TITLE_TIMEOUT_MS,
      responseSchema: meetingTitleResponseSchema,
    });
  } catch (error) {
    if (
      error instanceof AssistantServiceError &&
      error.status === HTTP_UNPROCESSABLE_ENTITY_STATUS &&
      parseAssistantErrorCode(error.responseText) === MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE
    ) {
      throw new MeetingTitleTranscriptRequired();
    }
    throw error;
  }
}

export async function triggerMeetingTitle(
  ...args: [meetingId: string, metering?: AssistantMeteringContext, meetingInProgress?: boolean]
): Promise<MeetingTitleResponse> {
  return triggerMeetingTitleNamed({
    meetingId: args[0],
    metering: args[1],
    isMeetingInProgress: args[2],
  });
}

type TriggerMeetingTasksInput = {
  initialCandidates: unknown[];
  dismissedTombstones?: unknown[];
  metering?: AssistantMeteringContext;
};

async function triggerMeetingTasksNamed(input: {
  meetingId: string;
  tasksInput: TriggerMeetingTasksInput;
}): Promise<TasksResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/tasks`,
    body: { meetingId: input.meetingId, ...input.tasksInput },
    timeoutMs: apiEnv().ASSISTANT_SERVICE_TASKS_TIMEOUT_MS,
    responseSchema: tasksResponseSchema,
  });
}

export async function triggerMeetingTasks(
  ...args: [meetingId: string, input: TriggerMeetingTasksInput]
): Promise<TasksResponse> {
  return triggerMeetingTasksNamed({ meetingId: args[0], tasksInput: args[1] });
}

export async function triggerMeetingTaskChunk(input: {
  voiceSearchIdentityEvidence?: VoiceSearchIdentityEvidence[];
  meetingId: string;
  metering?: AssistantMeteringContext;
  title: string | null;
  participants: { userId?: string; name: string; email?: string | null; roleHint?: string | null }[];
  chunkIndex: number;
  totalChunks: number;
  taskHintScore: number;
  transcriptText: string;
  languageContext?: string;
  extractionMode?: "general" | "personal_list";
}): Promise<TasksResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/tasks/chunk`,
    body: input,
    timeoutMs: apiEnv().ASSISTANT_SERVICE_TASKS_TIMEOUT_MS,
    responseSchema: tasksResponseSchema,
  });
}

export async function triggerMeetingTaskReconciliation(input: {
  voiceSearchIdentityEvidence?: VoiceSearchIdentityEvidence[];
  meetingId: string;
  metering?: AssistantMeteringContext;
  evidencePacket: unknown;
}): Promise<TasksResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/tasks/reconcile`,
    body: input,
    timeoutMs: apiEnv().ASSISTANT_SERVICE_TASKS_TIMEOUT_MS,
    responseSchema: tasksResponseSchema,
  });
}

async function triggerLinearTaskReviewNamed(input: {
  meetingId: string;
  reviewInput: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/linear-task-review`,
    body: input.reviewInput,
    timeoutMs: apiEnv().ASSISTANT_SERVICE_SELECTION_TIMEOUT_MS,
    responseSchema: assistantJsonRecordSchema,
  });
}

export async function triggerLinearTaskReview(
  ...args: [meetingId: string, input: Record<string, unknown>]
): Promise<unknown> {
  return triggerLinearTaskReviewNamed({ meetingId: args[0], reviewInput: args[1] });
}

async function triggerLinearTaskReviewRevisionNamed(input: {
  runId: string;
  reviewInput: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return requestAssistantNamed({
    path: `/internal/linear-task-reviews/${input.runId}/revise`,
    body: input.reviewInput,
    timeoutMs: apiEnv().ASSISTANT_SERVICE_SELECTION_TIMEOUT_MS,
    responseSchema: assistantJsonRecordSchema,
  });
}

export async function triggerLinearTaskReviewRevision(
  ...args: [runId: string, input: Record<string, unknown>]
): Promise<unknown> {
  return triggerLinearTaskReviewRevisionNamed({ runId: args[0], reviewInput: args[1] });
}

async function triggerMeetingSignalExtractionNamed(input: { meetingId: string }): Promise<ExtractionResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/extract-signals`,
    body: { meetingId: input.meetingId },
    timeoutMs: apiEnv().ASSISTANT_SERVICE_EXTRACTION_TIMEOUT_MS,
    responseSchema: extractionResponseSchema,
  });
}

export async function triggerMeetingSignalExtraction(...args: [meetingId: string]): Promise<ExtractionResponse> {
  return triggerMeetingSignalExtractionNamed({ meetingId: args[0] });
}

async function triggerCapabilitySelectionNamed(input: {
  extractionId: string;
  isForceRefresh?: boolean;
  tasks?: unknown;
  metering?: AssistantMeteringContext;
}): Promise<Record<string, unknown>> {
  const capabilitySelectionBody: Record<string, unknown> = {
    extractionId: input.extractionId,
    tasks: input.tasks,
    metering: input.metering,
  };
  capabilitySelectionBody[ASSISTANT_CAPABILITY_SELECTION_FORCE_REFRESH_FIELD] = input.isForceRefresh;

  return requestAssistantNamed({
    path: `/internal/extractions/${input.extractionId}/select-capabilities`,
    body: capabilitySelectionBody,
    timeoutMs: apiEnv().ASSISTANT_SERVICE_SELECTION_TIMEOUT_MS,
    responseSchema: assistantJsonRecordSchema,
  });
}

type CapabilitySelectionInput = {
  /** @external assistant capability selection force refresh flag */
  forceRefresh?: boolean;
  tasks?: unknown;
  metering?: AssistantMeteringContext;
};

export async function triggerCapabilitySelection(
  ...args: [extractionId: string, input?: CapabilitySelectionInput]
): Promise<unknown> {
  return triggerCapabilitySelectionNamed({
    extractionId: args[0],
    isForceRefresh: args[1]?.forceRefresh,
    tasks: args[1]?.tasks,
    metering: args[1]?.metering,
  });
}

export async function triggerBugReportDraftRevision(input: Record<string, unknown>): Promise<unknown> {
  return requestAssistantNamed({
    path: `/internal/capability-workflows/bug-report/revise-draft`,
    body: input,
    timeoutMs: apiEnv().ASSISTANT_SERVICE_WORKFLOW_TIMEOUT_MS,
    responseSchema: assistantJsonRecordSchema,
  });
}

export async function triggerBugReportIssuePlanning(input: Record<string, unknown>): Promise<unknown> {
  return requestAssistantNamed({
    path: `/internal/capability-workflows/bug-report/plan-issues`,
    body: input,
    timeoutMs: apiEnv().ASSISTANT_SERVICE_WORKFLOW_TIMEOUT_MS,
    responseSchema: assistantJsonRecordSchema,
  });
}

export async function triggerMeetingCoachingFeedback(input: Record<string, unknown>): Promise<unknown> {
  return requestAssistantNamed({
    path: `/internal/capability-workflows/meeting-coaching/generate-feedback`,
    body: input,
    timeoutMs: apiEnv().ASSISTANT_SERVICE_WORKFLOW_TIMEOUT_MS,
    responseSchema: assistantJsonRecordSchema,
  });
}

async function requestAssistantNamed<T>(input: {
  path: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  responseSchema: z.ZodType<T>;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? apiEnv().ASSISTANT_SERVICE_REQUEST_TIMEOUT_MS;
  const url = `${apiEnv().ASSISTANT_SERVICE_URL}${input.path}`;
  const timeout = createTimeoutSignal(timeoutMs);
  const response = await (async () => {
    try {
      return await fetch(url, {
        method: "POST",
        signal: timeout.signal,
        headers: {
          "content-type": "application/json",
          "x-assistant-service-secret": apiEnv().ASSISTANT_SERVICE_SECRET,
        },
        body: JSON.stringify(input.body),
      });
    } catch (error) {
      logAssistantClientError({ url, error });
      throw error;
    } finally {
      timeout.clear();
    }
  })();

  if (!response.ok) {
    const text = await response.text();
    throw new AssistantServiceError({ status: response.status, text });
  }

  const jsonPayload: unknown = await response.json();
  const parsed = input.responseSchema.safeParse(jsonPayload);
  if (!parsed.success) {
    throw new Error(
      formatAssistantServiceErrorMessage({ status: response.status, text: MESSAGE_ASSISTANT_EMPTY_RESPONSE_BODY }),
    );
  }

  return parsed.data;
}

async function startLiveMeetingTranscriptionNamed(input: {
  meetingId: string;
}): Promise<LiveTranscriptionStartResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/live-transcription/start`,
    body: { meetingId: input.meetingId },
    responseSchema: liveTranscriptionStartResponseSchema,
  });
}

export async function startLiveMeetingTranscription(
  ...args: [meetingId: string]
): Promise<LiveTranscriptionStartResponse> {
  return startLiveMeetingTranscriptionNamed({ meetingId: args[0] });
}

async function stopLiveMeetingTranscriptionNamed(input: { meetingId: string }): Promise<LiveTranscriptionStopResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/live-transcription/stop`,
    body: { meetingId: input.meetingId },
    timeoutMs: apiEnv().ASSISTANT_SERVICE_TRANSCRIPTION_STOP_TIMEOUT_MS,
    responseSchema: liveTranscriptionStopResponseSchema,
  });
}

export async function stopLiveMeetingTranscription(
  ...args: [meetingId: string]
): Promise<LiveTranscriptionStopResponse> {
  return stopLiveMeetingTranscriptionNamed({ meetingId: args[0] });
}

async function startMeetingAssistantNamed(input: { meetingId: string }): Promise<RoomAssistantStartResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/room-assistant/start`,
    body: { meetingId: input.meetingId },
    responseSchema: roomAssistantStartResponseSchema,
  });
}

export async function startMeetingAssistant(...args: [meetingId: string]): Promise<RoomAssistantStartResponse> {
  return startMeetingAssistantNamed({ meetingId: args[0] });
}

async function stopMeetingAssistantNamed(input: { meetingId: string }): Promise<RoomAssistantStopResponse> {
  return requestAssistantNamed({
    path: `/internal/meetings/${input.meetingId}/room-assistant/stop`,
    body: { meetingId: input.meetingId },
    responseSchema: roomAssistantStopResponseSchema,
  });
}

export async function stopMeetingAssistant(...args: [meetingId: string]): Promise<RoomAssistantStopResponse> {
  return stopMeetingAssistantNamed({ meetingId: args[0] });
}

// Memory has its own dispatcher; notes/task requests keep their existing transport.
const memoryDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 }).compose(
  (dispatch) => (options, handler) => dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler),
);

const memoryAssistantRejectedDefaultDiagnostic = {
  code: "assistant_rejected",
  stage: "api",
} satisfies MemoryFailureDiagnostic;

async function requestMemoryAssistantNamed<T>(input: {
  path: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  responseSchema: z.ZodType<T>;
}): Promise<T> {
  input.signal?.throwIfAborted();
  const timeout = createTimeoutSignal(input.timeoutMs);
  try {
    const options = {
      method: "POST",
      signal: input.signal ? AbortSignal.any([timeout.signal, input.signal]) : timeout.signal,
      dispatcher: memoryDispatcher,
      headers: {
        "content-type": "application/json",
        "x-assistant-service-secret": apiEnv().ASSISTANT_SERVICE_SECRET,
      },
      body: JSON.stringify(input.body),
    };
    const response = await fetch(`${apiEnv().ASSISTANT_SERVICE_URL}${input.path}`, options);
    if (!response.ok) {
      const errorBody: unknown = await (async () => {
        try {
          const jsonPayload: unknown = await response.json();
          const parsed = memoryFailureBodySchema.safeParse(jsonPayload);

          return parsed.success ? parsed.data : null;
        } catch (error) {
          if (!(error instanceof Error)) {
            return null;
          }

          return null;
        }
      })();
      const failureBody = memoryFailureBodySchema.safeParse(errorBody);
      const diagnostic = memoryFailureDiagnosticSchema.safeParse(
        failureBody.success ? failureBody.data.diagnostic : null,
      );
      const detail = diagnostic.success ? diagnostic.data : memoryAssistantRejectedDefaultDiagnostic;
      if (
        [HTTP_BAD_REQUEST_STATUS, HTTP_PAYLOAD_TOO_LARGE_STATUS, HTTP_UNPROCESSABLE_ENTITY_STATUS].includes(
          response.status,
        )
      ) {
        throw new MemoryGenerationRejected(formatMemoryAssistantRejectedMessage(response.status), detail);
      }
      throw new MemoryRequestFailed(detail);
    }

    // Keep the deadline active until the response body has also been read.
    const jsonPayload: unknown = await response.json();
    const parsed = input.responseSchema.safeParse(jsonPayload);
    if (!parsed.success) {
      throw new MemoryRequestFailed(memoryAssistantRejectedDefaultDiagnostic);
    }

    return parsed.data;
  } finally {
    timeout.clear();
  }
}

async function triggerMemoryGenerationNamed(input: {
  generationInput: MemoryGenerationInput;
  authorization: { jobId: string; leaseToken: string };
  signal?: AbortSignal;
}): Promise<MemoryGenerationResponse> {
  return requestMemoryAssistantNamed({
    path: "/internal/memory/generate",
    body: { ...input.generationInput, ...input.authorization } satisfies Record<string, unknown>,
    timeoutMs: MEMORY_EXTRACTION_REQUEST_TIMEOUT_MS,
    signal: input.signal,
    responseSchema: memoryGenerationResponseSchema,
  });
}

export async function triggerMemoryGeneration(
  ...args: [input: MemoryGenerationInput, authorization: { jobId: string; leaseToken: string }, signal?: AbortSignal]
): Promise<MemoryGenerationResponse> {
  return triggerMemoryGenerationNamed({
    generationInput: args[0],
    authorization: args[1],
    signal: args[2],
  });
}
