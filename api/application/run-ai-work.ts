import type { AiWorkflowJobView } from "@readymeet/shared";
import { randomUUID } from "node:crypto";

import { repositories } from "../ports/repository-runtime";

import {
  bindLinearTaskReviewEnqueue,
  createRequestWorkflow,
  registerRequestWorkflowHandler,
  type RequestWorkLogger,
  runAiWorkflowInRequest,
} from "./request-ai-workflow";

export { createRequestWorkflow, runAiWorkflowInRequest };

export async function ensureGuestMeetingPreviewInRequest(input: {
  meetingId: string;
  logger: RequestWorkLogger;
}): Promise<AiWorkflowJobView | null> {
  const requestId = randomUUID();
  const job = await repositories().ensureGuestMeetingPreviewJob(input.meetingId, requestId);
  if (job === null || job.status !== "running" || job.id !== requestId) {
    return job;
  }

  return runAiWorkflowInRequest({
    meetingId: input.meetingId,
    type: "resolve_meeting_title",
    job,
    logger: input.logger,
  });
}

registerRequestWorkflowHandler({
  type: "review_linear_tasks",
  handler: async ({ job, logger }) => {
    const { runLinearTaskReviewJob } = await import("./linear-task-review-service");
    await runLinearTaskReviewJob({ job, logger });
  },
});

registerRequestWorkflowHandler({
  type: "detect_ambient_context",
  handler: async ({ job, logger }) => {
    const { runAmbientContextDetectionJob } = await import("./ambient-context");

    return runAmbientContextDetectionJob({ job, logger });
  },
});

registerRequestWorkflowHandler({
  type: "research_ambient_entity",
  handler: async ({ job, logger }) => {
    const { runAmbientEntityResearchJob } = await import("./ambient-context");

    return runAmbientEntityResearchJob({ job, logger });
  },
});

registerRequestWorkflowHandler({
  type: "enrich_ambient_context_image",
  handler: async ({ job, logger }) => {
    const { runAmbientContextImageEnrichmentJob } = await import("./ambient-context");

    return runAmbientContextImageEnrichmentJob({ job, logger });
  },
});

bindLinearTaskReviewEnqueue(async (meetingId) => {
  const { enqueueLinearTaskReviewIfEligible } = await import("./linear-task-review-service");
  await enqueueLinearTaskReviewIfEligible(meetingId);
});
