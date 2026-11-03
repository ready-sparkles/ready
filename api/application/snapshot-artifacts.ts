import type { AiWorkflowJobView } from "@readymeet/shared";
import { FALLBACK_SUMMARY_MODEL, INSUFFICIENT_CREDITS_CODE, meetingSnapshotSchema } from "@readymeet/shared";
import { z } from "zod";

import {
  buildOneOnOneParticipantTitle,
  shouldReplaceMeetingTitleWithSnapshot,
  titlesMatchIgnoringCase,
} from "../domain/meeting-title";
import { triggerMeetingSnapshot } from "../ports/gate-assistant-client";
import { repositories } from "../ports/repository-runtime";

import { recordArtifactRequest } from "./artifact-request";
import { buildShortMeetingTitleFromTranscript, FALLBACK_MEETING_SUMMARY } from "./meeting-title-fallback";

type LoggerLike = {
  info?(...args: [bindings: Record<string, unknown>, message: string]): void;
  warn(...args: [bindings: Record<string, unknown>, message: string]): void;
};

const SNAPSHOT_LOG_MESSAGE = "Generated durable meeting snapshot";
const FALLBACK_SNAPSHOT_LOG_MESSAGE = "Persisted fallback meeting summary after snapshot job failed permanently";
const CREDIT_BLOCKED_SUMMARY =
  "Meeting notes weren't generated because there weren't enough AI credits. Add credits, then choose Generate notes. The transcript is available for review.";
// Summaries saved before the wording change still mark a credit-blocked meeting.
const LEGACY_CREDIT_BLOCKED_SUMMARY =
  "Meeting notes could not be generated because the meeting host ran out of AI credits. The transcript is available for review.";

export function isCreditBlockedSummary(summary: { model: string; content: string }): boolean {
  return (
    summary.model === FALLBACK_SUMMARY_MODEL &&
    (summary.content === CREDIT_BLOCKED_SUMMARY || summary.content === LEGACY_CREDIT_BLOCKED_SUMMARY)
  );
}
// Guests cannot add credits or choose Generate notes, so they get no billing instructions.
const GUEST_CREDIT_BLOCKED_SUMMARY =
  "The host's notes for this meeting aren't available yet. Check back later. The transcript is available for review.";

/** Notes as a guest may read them: the host-only credit instructions become a neutral status. */
export function toGuestVisibleSummary<Summary extends { model: string; content: string }>(
  summary: Summary | null,
): Summary | null {
  return summary !== null && isCreditBlockedSummary(summary)
    ? { ...summary, content: GUEST_CREDIT_BLOCKED_SUMMARY }
    : summary;
}
const HTTP_PAYMENT_REQUIRED = 402;
const creditDenialSchema = z.object({
  statusCode: z.literal(HTTP_PAYMENT_REQUIRED),
  code: z.literal(INSUFFICIENT_CREDITS_CODE),
});

export function completedQuickTitleFromJob(
  job: Pick<AiWorkflowJobView, "status" | "result"> | null | undefined,
): string | null {
  const title = job?.result.title;
  if (
    job?.status !== "completed" ||
    job.result.updated !== true ||
    typeof title !== "string" ||
    title.trim().length === 0
  ) {
    return null;
  }

  return title.trim();
}

export function canSnapshotReplaceMeetingTitle(input: {
  currentTitle: string;
  participantTitle: string | null;
  transcriptFallbackTitle: string | null;
  quickTitle: string | null;
}): boolean {
  return (
    shouldReplaceMeetingTitleWithSnapshot(input.currentTitle) ||
    titlesMatchIgnoringCase({ left: input.currentTitle, right: input.participantTitle }) ||
    titlesMatchIgnoringCase({ left: input.currentTitle, right: input.transcriptFallbackTitle }) ||
    titlesMatchIgnoringCase({ left: input.currentTitle, right: input.quickTitle })
  );
}

export async function generateAndPersistMeetingSnapshot(input: {
  meetingId: string;
  logger: LoggerLike;
  options?: { jobId?: string | null };
}): Promise<{ snapshot: ReturnType<typeof meetingSnapshotSchema.parse>; summary: unknown; actionItems: unknown[] }> {
  if (input.options?.jobId === undefined || input.options.jobId === null) {
    return recordArtifactRequest({
      meetingId: input.meetingId,
      type: "generate_meeting_snapshot",
      run: (jobId) => generateAndPersistMeetingSnapshot({ ...input, options: { jobId } }),
    });
  }
  const response = await triggerMeetingSnapshot(input.meetingId, { jobId: input.options.jobId });
  const snapshot = meetingSnapshotSchema.parse(response.snapshot);

  const [summary, actionItems] = await Promise.all([
    repositories().upsertSummaryForMeeting({
      meetingId: input.meetingId,
      jobId: input.options.jobId,
      content: snapshot.summary,
      model: `lightweight:${snapshot.snapshotModel}`,
    }),
    repositories().replaceActionItemsForMeeting(input.meetingId, snapshot.actionItems, input.options.jobId),
  ]);

  const [meeting, participants, transcriptData, quickTitleJob] = await Promise.all([
    repositories().getMeetingById(input.meetingId),
    repositories().listParticipantsForMeeting(input.meetingId),
    repositories().getTranscriptForMeeting(input.meetingId),
    repositories().getLatestAiWorkflowJobForMeeting({
      meetingId: input.meetingId,
      type: "resolve_meeting_title",
      scopeKey: "default",
    }),
  ]);
  if (meeting !== null) {
    const participantTitle = buildOneOnOneParticipantTitle(participants);
    // Recognize deterministic fallbacks and the completed quick-title result
    // as machine-generated provenance. The final snapshot may improve those,
    // while the compare-and-swap below protects a concurrent manual rename.
    const transcriptFallbackTitle = buildShortMeetingTitleFromTranscript(transcriptData);
    const quickTitle = completedQuickTitleFromJob(quickTitleJob);
    const nextTitle = participantTitle ?? snapshot.title;
    if (
      canSnapshotReplaceMeetingTitle({
        currentTitle: meeting.title,
        participantTitle,
        transcriptFallbackTitle,
        quickTitle,
      }) &&
      nextTitle !== meeting.title
    ) {
      await repositories().updateMeetingTitleIfCurrent({
        meetingId: input.meetingId,
        currentTitle: meeting.title,
        title: nextTitle,
        jobId: input.options.jobId,
      });
    }
  }

  input.logger.info?.(
    {
      meetingId: input.meetingId,
      snapshotModel: snapshot.snapshotModel,
      actionItemCount: actionItems.length,
    },
    SNAPSHOT_LOG_MESSAGE,
  );

  return { snapshot, summary, actionItems };
}

export async function persistSnapshotFallbackIfMissing(input: {
  meetingId: string;
  logger: LoggerLike;
  error?: unknown;
}): Promise<void> {
  const existingSummary = await repositories().getSummaryForMeeting(input.meetingId);
  if (existingSummary !== null) {
    return;
  }

  // Every credit refusal (db, provider admission, assistant HTTP) carries this 402 shape.
  const isCreditDenial = creditDenialSchema.safeParse(input.error).success;
  await repositories().upsertSummaryForMeeting({
    meetingId: input.meetingId,
    content: isCreditDenial ? CREDIT_BLOCKED_SUMMARY : FALLBACK_MEETING_SUMMARY,
    model: FALLBACK_SUMMARY_MODEL,
    shouldPreserveExisting: true,
  });
  input.logger.warn(
    { meetingId: input.meetingId, ...(isCreditDenial ? { code: INSUFFICIENT_CREDITS_CODE } : {}) },
    FALLBACK_SNAPSHOT_LOG_MESSAGE,
  );
}
