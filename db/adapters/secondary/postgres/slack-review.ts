import { type SlackMeetingReview, slackMeetingReviewSchema } from "@readymeet/shared";

import { db, Prisma } from "./client";

const SLACK_REVIEW_REFRESH_BEFORE_SHARE_MESSAGE =
  "The meeting changed or is confidential. Refresh the review before sharing.";

/** Read the meeting, then let the request send. Each save is its own statement. */
export async function withSlackChannelSharingLock<T>(input: {
  meetingId: string;
  userId: string;
  send: () => Promise<T>;
}): Promise<T> {
  const meeting = await db.meetings.findUnique({
    where: { id: input.meetingId },
  });
  if (
    meeting === null ||
    meeting.isConfidential ||
    meeting.status !== "ended" ||
    meeting.createdByUserId !== input.userId
  ) {
    throw new Error(SLACK_REVIEW_REFRESH_BEFORE_SHARE_MESSAGE);
  }

  return input.send();
}

export async function getSlackMeetingReview(meetingId: string): Promise<SlackMeetingReview | null> {
  const row = await db.slackMeetingReviews.findUnique({
    where: { meetingId },
  });

  return row !== null ? slackMeetingReviewSchema.parse(row.review) : null;
}

/** Reopen only an unsent dismissal. Sending, completed, and uncertain deliveries stay closed. */
export async function reopenDismissedSlackMeetingReview(input: {
  meetingId: string;
  userId: string;
  expectedVersion: number;
}): Promise<SlackMeetingReview | null> {
  const row = await db.slackMeetingReviews.findFirst({
    where: {
      meetingId: input.meetingId,
      userId: input.userId,
      version: input.expectedVersion,
      status: "dismissed",
    },
  });
  if (row === null) {
    return null;
  }
  const delivery = await db.slackReviewDeliveries.findFirst({
    where: { reviewId: row.id },
  });
  if (delivery !== null) {
    return null;
  }
  const current = slackMeetingReviewSchema.parse(row.review);
  const nextVersion = current.version + 1;
  const nextReview = { ...current, status: "awaiting_user" as const, version: nextVersion };
  const updated = await db.slackMeetingReviews.updateManyAndReturn({
    where: {
      id: row.id,
      version: input.expectedVersion,
      status: "dismissed",
    },
    data: {
      status: "awaiting_user",
      version: nextVersion,
      review: nextReview,
      updatedAt: new Date(),
    },
  });
  const saved = updated[0];

  return saved !== undefined ? slackMeetingReviewSchema.parse(saved.review) : null;
}

export async function saveSlackMeetingReview(input: {
  review: SlackMeetingReview;
  expectedVersion?: number;
}): Promise<SlackMeetingReview | null> {
  if (input.expectedVersion === undefined) {
    const inserted = await db.slackMeetingReviews.createManyAndReturn({
      data: [
        {
          id: input.review.id,
          meetingId: input.review.meetingId,
          userId: input.review.userId,
          version: input.review.version,
          status: input.review.status,
          review: input.review,
        },
      ],
      skipDuplicates: true,
    });
    const row = inserted[0];

    return row !== undefined ? slackMeetingReviewSchema.parse(row.review) : null;
  }
  const updated = await db.slackMeetingReviews.updateManyAndReturn({
    where: {
      meetingId: input.review.meetingId,
      version: input.expectedVersion,
      status: "awaiting_user",
    },
    data: {
      version: input.review.version,
      status: input.review.status,
      review: input.review,
      updatedAt: new Date(),
    },
  });
  const row = updated[0];

  return row !== undefined ? slackMeetingReviewSchema.parse(row.review) : null;
}

export async function finishSlackMeetingReview(input: { review: SlackMeetingReview }): Promise<void> {
  await db.slackMeetingReviews.updateMany({
    where: { id: input.review.id, status: "sending" },
    data: {
      status: input.review.status,
      review: input.review,
      updatedAt: new Date(),
    },
  });
}

/** Claim before any Slack side effect. A second claim for the same destination does nothing. */
export async function claimSlackReviewDestination(input: { reviewId: string; destination: string }): Promise<boolean> {
  try {
    await db.slackReviewDeliveries.create({
      data: {
        reviewId: input.reviewId,
        destination: input.destination,
        status: "sending",
      },
    });

    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

export async function finishSlackReviewDestination(input: {
  reviewId: string;
  destination: string;
  messageTs: string | null;
}): Promise<void> {
  await db.slackReviewDeliveries.updateMany({
    where: { reviewId: input.reviewId, destination: input.destination },
    data: { status: "sent", messageTs: input.messageTs },
  });
}
