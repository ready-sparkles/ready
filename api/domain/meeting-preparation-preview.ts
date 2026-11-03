import {
  type AiWorkflowJobView,
  MEETING_PREPARATION_FALLBACK_LINES,
  meetingPreparationLinesSchema,
  type MeetingPreparationPreview,
  meetingPreparationPreviewResponseSchema,
} from "@readymeet/shared";

const fallbackLines = [...MEETING_PREPARATION_FALLBACK_LINES];
export const MEETING_PREPARATION_JOB_GRACE_MS = 10_000;

function isWithinMissingJobGrace(input: { endedAt?: Date | string | null; nowMs?: number }) {
  if (input.endedAt === undefined || input.endedAt === null) {
    return false;
  }

  const endedAtMs = input.endedAt instanceof Date ? input.endedAt.getTime() : Date.parse(input.endedAt);

  return Number.isFinite(endedAtMs) && (input.nowMs ?? Date.now()) - endedAtMs < MEETING_PREPARATION_JOB_GRACE_MS;
}

export function buildMeetingPreparationPreview(input: {
  job: Pick<AiWorkflowJobView, "status" | "result"> | null | undefined;
  /** @external existing preview API field */
  locked: boolean;
  /** @external existing preview API field */
  allowUpgradePreview?: boolean;
  endedAt?: Date | string | null;
  nowMs?: number;
}): MeetingPreparationPreview {
  const isLocked = input.locked;
  const shouldAllowUpgradePreview = input.allowUpgradePreview ?? false;

  if (isLocked && !shouldAllowUpgradePreview) {
    return meetingPreparationPreviewResponseSchema.parse({
      status: "ready",
      lines: fallbackLines,
      source: "fallback",
    });
  }

  if (!input.job) {
    if (isWithinMissingJobGrace(input)) {
      return meetingPreparationPreviewResponseSchema.parse({
        status: "pending",
        lines: [],
        source: null,
      });
    }

    return meetingPreparationPreviewResponseSchema.parse({
      status: "ready",
      lines: fallbackLines,
      source: "fallback",
    });
  }

  if (input.job.status === "queued" || input.job.status === "running") {
    return meetingPreparationPreviewResponseSchema.parse({
      status: "pending",
      lines: [],
      source: null,
    });
  }

  if (input.job.status === "completed") {
    const parsedLines = meetingPreparationLinesSchema.safeParse(input.job.result.preparationLines);
    if (parsedLines.success) {
      return meetingPreparationPreviewResponseSchema.parse({
        status: "ready",
        lines: parsedLines.data,
        source: input.job.result.fallback === true ? "fallback" : "model",
      });
    }
  }

  return meetingPreparationPreviewResponseSchema.parse({
    status: "ready",
    lines: fallbackLines,
    source: "fallback",
  });
}
