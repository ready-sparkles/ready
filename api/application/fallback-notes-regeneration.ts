import {
  type AiWorkflowJobView,
  FALLBACK_SUMMARY_MODEL,
  type MeetingNotesRegenerationProgress,
} from "@readymeet/shared";

import { repositories } from "../ports/repository-runtime";

import { type RequestWorkLogger, runAiWorkflowInRequest } from "./request-ai-workflow";
import { isCreditBlockedSummary } from "./snapshot-artifacts";

// An automatic retry waits this long after a failed run, so opening a meeting
// that still cannot afford notes does not re-run the model on every visit.
const AUTOMATIC_RETRY_AFTER_FAILURE_MS = 900_000;
const REGENERATION_FAILED_MESSAGE = "Fallback meeting notes regeneration failed";

export type FallbackNotesRegeneration = "started" | "in_progress" | "not_needed" | "recently_failed";

/**
 * Replaces a meeting's fallback summary with real notes. The claim is taken
 * before returning and the model work continues in the background, so a
 * second click or a second tab sees "in_progress" instead of paying again.
 */
export async function regenerateFallbackMeetingNotes(input: {
  meetingId: string;
  logger: RequestWorkLogger;
  trigger: "manual" | "automatic";
}): Promise<FallbackNotesRegeneration> {
  const claim = await repositories().claimMeetingNotesRegeneration({
    meetingId: input.meetingId,
    regenerableSummaryModel: FALLBACK_SUMMARY_MODEL,
    ...(input.trigger === "automatic" ? { retryAfterFailureMs: AUTOMATIC_RETRY_AFTER_FAILURE_MS } : {}),
  });
  if (claim.status !== "claimed") {
    return claim.status;
  }
  void runRegenerationWithoutBlocking({
    meetingId: input.meetingId,
    job: claim.job,
    logger: input.logger,
    trigger: input.trigger,
  });

  return "started";
}

// The claimed job records the failure itself; this only keeps a background rejection from going unobserved.
async function runRegenerationWithoutBlocking(input: {
  meetingId: string;
  job: AiWorkflowJobView;
  logger: RequestWorkLogger;
  trigger: "manual" | "automatic";
}): Promise<void> {
  try {
    await runAiWorkflowInRequest({
      meetingId: input.meetingId,
      type: "generate_meeting_snapshot",
      job: input.job,
      logger: input.logger,
    });
  } catch (error: unknown) {
    input.logger.warn({ error, meetingId: input.meetingId, trigger: input.trigger }, REGENERATION_FAILED_MESSAGE);
  }
}

/** Only credit-blocked notes regenerate on their own; other fallbacks wait for the host to ask. */
export async function regenerateCreditBlockedNotesOnOpen(input: {
  meetingId: string;
  summary: { model: string; content: string } | null;
  logger: RequestWorkLogger;
}): Promise<FallbackNotesRegeneration> {
  if (input.summary === null || !isCreditBlockedSummary(input.summary)) {
    return "not_needed";
  }

  return regenerateFallbackMeetingNotes({ meetingId: input.meetingId, logger: input.logger, trigger: "automatic" });
}

/**
 * Lets the host's button stop waiting as soon as a run ends. Real notes (or no
 * notes to replace) are "done"; fallback notes with no live snapshot run mean
 * the run failed or finished without replacing them.
 */
export async function fallbackNotesRegenerationProgress(meetingId: string): Promise<MeetingNotesRegenerationProgress> {
  const summary = await repositories().getSummaryForMeeting(meetingId);
  if (summary?.model !== FALLBACK_SUMMARY_MODEL) {
    return "done";
  }
  const job = await repositories().getLatestAiWorkflowJobForMeeting({ meetingId, type: "generate_meeting_snapshot" });

  return job?.status === "queued" || job?.status === "running" ? "in_progress" : "failed";
}
