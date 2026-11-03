import {
  type AiWorkflowJobType,
  type AiWorkflowJobView,
  type MeetingTaskCandidate,
  meetingTaskCandidateSchema,
} from "@readymeet/shared";
import { z } from "zod";

import { repositories } from "../ports/repository-runtime";

const WORKFLOW_REQUEST_FAILED_MESSAGE = "Workflow request failed";
const LINEAR_REVIEW_ENQUEUE_UNBOUND_MESSAGE = "Linear task review enqueue is not bound.";
const missingRequestWorkflowHandlerMessage = (type: string): string =>
  `Request workflow handler is not registered: ${type}`;
const unsupportedWorkflowMessage = (type: string): string => `Unsupported request workflow: ${type}`;

export type RequestWorkLogger = {
  info(...args: [bindings: Record<string, unknown>, message: string]): void;
  warn(...args: [bindings: Record<string, unknown>, message: string]): void;
  error?(...args: [bindings: Record<string, unknown>, message: string]): void;
};

type RequestWorkflowLogger = RequestWorkLogger & {
  error(...args: [bindings: Record<string, unknown>, message: string]): void;
};

type RequestWorkflowHandler = (input: { job: AiWorkflowJobView; logger: RequestWorkflowLogger }) => Promise<unknown>;

// ponytail: linear and ambient register themselves so this file does not import them.
const requestWorkflowHandlers = new Map<AiWorkflowJobType, RequestWorkflowHandler>();
const linearTaskReviewEnqueues = new Map<string, (meetingId: string) => Promise<void>>();
const LINEAR_TASK_REVIEW_ENQUEUE_KEY = "after_tasks";

export function registerRequestWorkflowHandler(input: {
  type: AiWorkflowJobType;
  handler: RequestWorkflowHandler;
}): void {
  requestWorkflowHandlers.set(input.type, input.handler);
}

export function bindLinearTaskReviewEnqueue(enqueue: (meetingId: string) => Promise<void>): void {
  linearTaskReviewEnqueues.set(LINEAR_TASK_REVIEW_ENQUEUE_KEY, enqueue);
}

async function enqueueLinearTaskReviewAfterTasks(meetingId: string): Promise<void> {
  const enqueue = linearTaskReviewEnqueues.get(LINEAR_TASK_REVIEW_ENQUEUE_KEY);
  if (enqueue === undefined) {
    throw new Error(LINEAR_REVIEW_ENQUEUE_UNBOUND_MESSAGE);
  }
  await enqueue(meetingId);
}

export async function createRequestWorkflow(input: {
  meetingId: string;
  type: AiWorkflowJobType;
  scopeKey?: string;
  phase?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<AiWorkflowJobView> {
  return repositories().startAiWorkflowExecution(input);
}

function loggerWithError({ logger }: { logger: RequestWorkLogger }): RequestWorkflowLogger {
  return {
    info: (...args: [bindings: Record<string, unknown>, message: string]) => {
      logger.info(...args);
    },
    warn: (...args: [bindings: Record<string, unknown>, message: string]) => {
      logger.warn(...args);
    },
    error: (...args: [bindings: Record<string, unknown>, message: string]) => {
      logger.error?.(...args);
    },
  };
}

function requireRequestWorkflowHandler(type: AiWorkflowJobType): RequestWorkflowHandler {
  const handler = requestWorkflowHandlers.get(type);
  if (handler === undefined) {
    throw new Error(missingRequestWorkflowHandlerMessage(type));
  }

  return handler;
}

function readDeferUntil(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("deferUntil" in result)) {
    return undefined;
  }

  return typeof result.deferUntil === "string" ? result.deferUntil : undefined;
}

function isWorkflowRecord(result: unknown): result is Record<string, unknown> {
  return typeof result === "object" && result !== null && !Array.isArray(result);
}

function workflowResult(result: unknown): Record<string, unknown> | void {
  if (isWorkflowRecord(result)) {
    return result;
  }
}

function taskCandidatesFromUnknown(value: unknown): MeetingTaskCandidate[] | undefined {
  const parsed = z.array(meetingTaskCandidateSchema).safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

async function runSnapshotThenTasks(input: {
  meetingId: string;
  jobId: string;
  logger: RequestWorkLogger;
}): Promise<void> {
  const { generateAndPersistMeetingSnapshot } = await import("./snapshot-artifacts");
  const { snapshot } = await generateAndPersistMeetingSnapshot({
    meetingId: input.meetingId,
    logger: input.logger,
    options: { jobId: input.jobId },
  });
  await runAiWorkflowInRequest({
    meetingId: input.meetingId,
    type: "generate_meeting_tasks",
    payload: { snapshotTaskCandidates: snapshot.taskCandidates },
    logger: input.logger,
  });
}

/** Work is awaited by its owning request; execution rows are audit history, never queued. */
export async function runAiWorkflowInRequest(input: {
  meetingId: string;
  type: AiWorkflowJobType;
  scopeKey?: string;
  phase?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  logger: RequestWorkLogger;
  job?: AiWorkflowJobView;
}): Promise<AiWorkflowJobView> {
  const job = input.job ?? (await createRequestWorkflow(input));
  try {
    const result = await (async () => {
      if (await isIntelligenceDisabled(job)) {
        return { isDisabled: true };
      }

      return executeRequestWorkflow({ job, logger: loggerWithError({ logger: input.logger }) });
    })();

    return await repositories().completeAiWorkflowJob({ jobId: job.id, result: result ?? {} });
  } catch (error) {
    await repositories().failAiWorkflowJob({ jobId: job.id, error: WORKFLOW_REQUEST_FAILED_MESSAGE });
    if (input.type === "generate_meeting_snapshot") {
      const { persistSnapshotFallbackIfMissing } = await import("./snapshot-artifacts");
      await persistSnapshotFallbackIfMissing({ ...input, error });
    }
    throw error;
  }
}

async function isIntelligenceDisabled(job: AiWorkflowJobView): Promise<boolean> {
  if (
    !["track_meeting", "detect_ambient_context", "research_ambient_entity", "enrich_ambient_context_image"].includes(
      job.type,
    )
  ) {
    return false;
  }
  const meeting = await repositories().getMeetingById(job.meetingId);
  if (meeting === null) {
    return false;
  }
  const workspace = await repositories().getWorkspaceById(meeting.workspaceId);

  return job.type === "track_meeting"
    ? workspace?.isLiveSummaryEnabled === false
    : workspace?.isAmbientContextEnabled === false;
}

async function executeRequestWorkflow({
  job,
  logger,
}: {
  job: AiWorkflowJobView;
  logger: RequestWorkflowLogger;
}): Promise<Record<string, unknown> | void> {
  if (job.type === "finalize_meeting") {
    const { finalizeMeetingIfIdle } = await import("./meeting-lifecycle");
    await finalizeMeetingIfIdle(job.meetingId, logger, { force: true });

    return;
  }
  if (job.type === "resolve_meeting_title") {
    const { resolveAndPersistMeetingTitle } = await import("./meeting-title-resolution");

    return resolveAndPersistMeetingTitle({ meetingId: job.meetingId, options: { jobId: job.id } });
  }
  if (job.type === "generate_meeting_snapshot") {
    await runSnapshotThenTasks({ meetingId: job.meetingId, jobId: job.id, logger });

    return;
  }
  if (job.type === "generate_meeting_tasks") {
    await runTasksWorkflow({ job, logger });

    return;
  }
  if (job.type === "deliver_meeting_to_slack") {
    const { runSlackMeetingDelivery } = await import("../ports/gate-slack-delivery");
    await runSlackMeetingDelivery({ meetingId: job.meetingId, logger });

    return;
  }
  if (job.type === "review_linear_tasks") {
    await requireRequestWorkflowHandler(job.type)({ job, logger });

    return;
  }
  if (job.type === "run_meeting_research") {
    const { runMeetingResearchJob } = await import("./meeting-research");
    await runMeetingResearchJob({ job, workerId: "request", logger });

    return;
  }
  if (job.type === "detect_ambient_context") {
    return workflowResult(await requireRequestWorkflowHandler(job.type)({ job, logger }));
  }
  if (job.type === "research_ambient_entity") {
    const result = await requireRequestWorkflowHandler(job.type)({ job, logger });
    const deferUntil = readDeferUntil(result);
    if (deferUntil !== undefined) {
      const delayMs = Math.max(0, Date.parse(deferUntil) - Date.now());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });

      return executeRequestWorkflow({ job, logger });
    }

    return workflowResult(result);
  }
  if (job.type === "enrich_ambient_context_image") {
    return workflowResult(await requireRequestWorkflowHandler(job.type)({ job, logger }));
  }
  if (job.type === "review_ashby_actions") {
    const { processAshbyReviewJob } = await import("../ports/gate-ashby-review-service");
    await processAshbyReviewJob(job, logger);

    return;
  }
  if (job.type === "meeting_post_end_pipeline") {
    const { runSuggestedActionsPipeline } = await import("./suggested-actions");
    await runSuggestedActionsPipeline(job.meetingId, {
      warn: ({ bindings, message }) => {
        logger.warn(bindings, message);
      },
      info: ({ bindings, message }) => {
        logger.info(bindings, message);
      },
    });

    return;
  }
  if (job.type === "track_meeting") {
    const tracker = await import("./meeting-tracker");
    await tracker.runMeetingTracker({
      job,
      logger: { info: ({ fields, message }) => logger.info(fields, message) },
    });

    return;
  }
  throw new Error(unsupportedWorkflowMessage(job.type));
}

async function runTasksWorkflow({
  job,
  logger,
}: {
  job: AiWorkflowJobView;
  logger: RequestWorkflowLogger;
}): Promise<void> {
  const { generateAndPersistMeetingTasks } = await import("./task-artifacts");
  await generateAndPersistMeetingTasks(job.meetingId, logger, {
    jobId: job.id,
    initialCandidates: taskCandidatesFromUnknown(job.payload.snapshotTaskCandidates),
  });
  if (job.payload.trigger === "suggested_actions_dependency") {
    const { runSuggestedActionsPipeline } = await import("./suggested-actions");
    await runSuggestedActionsPipeline(job.meetingId, {
      warn: ({ bindings, message }) => {
        logger.warn(bindings, message);
      },
      info: ({ bindings, message }) => {
        logger.info(bindings, message);
      },
    });
  }
  const { enqueueAshbyReview } = await import("../ports/gate-ashby-review-service");
  await enqueueAshbyReview(job.meetingId);
  const { runSlackMeetingDelivery } = await import("../ports/gate-slack-delivery");
  await runSlackMeetingDelivery({ meetingId: job.meetingId, logger });
  await enqueueLinearTaskReviewAfterTasks(job.meetingId);
}
