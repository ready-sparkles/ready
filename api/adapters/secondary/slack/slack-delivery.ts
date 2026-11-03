import { repositories } from "../../../ports/repository-runtime";

import { prepareSlackMeetingReview } from "./slack-review-service";

/** Legacy workflow name retained for queued jobs. This only prepares a review; never sends. */
export async function runSlackMeetingDelivery(input: {
  meetingId: string;
  logger: {
    info(...args: [bindings: Record<string, unknown>, message: string]): void;
    warn(...args: [bindings: Record<string, unknown>, message: string]): void;
  };
  shouldFinalizeFailure?: boolean;
}): Promise<{
  status: "awaiting_user" | "skipped";
  category: "sales" | null;
  channelId: string | null;
  skipReason: "not_configured" | null;
} | null> {
  const meeting = await repositories().getMeetingById(input.meetingId);
  if (!meeting) {
    return null;
  }
  const review = await prepareSlackMeetingReview(input.meetingId, meeting.createdByUserId);

  return {
    status: review ? "awaiting_user" : "skipped",
    category: review?.channelEligible === true ? "sales" : null,
    channelId: review?.channel?.id ?? null,
    skipReason: review ? null : "not_configured",
  };
}
