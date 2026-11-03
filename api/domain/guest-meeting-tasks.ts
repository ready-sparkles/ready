import {
  FALLBACK_SUMMARY_MODEL,
  guestMeetingTasksStatusSchema,
  type MeetingTaskList,
  type MeetingTaskProgress,
} from "@readymeet/shared";

const TASKS_PREPARATION_FAILED_MESSAGE = "Tasks could not be prepared.";
// Placeholder notes (too short, generation failed, out of credits) start no task run.
const PLACEHOLDER_SUMMARY_MODELS: ReadonlySet<string> = new Set(["short-meeting-v1", FALLBACK_SUMMARY_MODEL]);

/** Explicit guest projection: never serialize workflow jobs or diagnostic details. */
export function toGuestMeetingTasksStatus(status: {
  status: MeetingTaskList["status"];
  phase: string;
  isTerminal: boolean;
  isCurrent: boolean;
  tasks: MeetingTaskList | null;
  progress: MeetingTaskProgress | null;
}): ReturnType<typeof guestMeetingTasksStatusSchema.parse> {
  return guestMeetingTasksStatusSchema.parse({
    status: status.status,
    phase: status.phase,
    error: status.status === "failed" ? TASKS_PREPARATION_FAILED_MESSAGE : null,
    isTerminal: status.isTerminal,
    isCurrent: status.isCurrent,
    tasks: status.tasks
      ? {
          ...status.tasks,
          error: null,
          model: null,
          promptVersion: null,
          transcriptHash: null,
        }
      : null,
    progress: status.progress,
  });
}

/**
 * Guest task status, or null when no task run exists and none will start on its own.
 * Placeholder notes never start one, and a guest cannot request one, so reporting the
 * pending status would leave the guest page on "Preparing meeting tasks" forever.
 */
export function projectGuestMeetingTasksStatus(input: {
  summary: { model: string } | null;
  status: Parameters<typeof toGuestMeetingTasksStatus>[0] & { job: object | null };
}): ReturnType<typeof toGuestMeetingTasksStatus> | null {
  const { summary, status } = input;
  const isPlaceholderSummary = summary !== null && PLACEHOLDER_SUMMARY_MODELS.has(summary.model);
  if (isPlaceholderSummary && !status.isTerminal && status.job === null && status.tasks === null) {
    return null;
  }

  return toGuestMeetingTasksStatus(status);
}
