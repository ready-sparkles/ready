import {
  slackMeetingReviewResponseSchema,
  slackReviewActionSchema,
  slackReviewRevisionSchema,
} from "@readymeet/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { resolveMeetingNotesAccess } from "../../../../../application/meeting-notes-access";
import { repositories } from "../../../../../ports/repository-runtime";
import {
  confirmSlackMeetingReview,
  prepareSlackMeetingReview,
  reviseSlackMeetingReview,
} from "../../../../secondary/slack/slack-review-service";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";

const HTTP_FORBIDDEN = 403;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const SLACK_REVIEW_OWNER_ONLY_MESSAGE = "Only the meeting owner can share notes to Slack.";
const MEETING_NOTES_LOCKED_MESSAGE = "Meeting notes are locked.";
const INVALID_REVIEW_REQUEST_MESSAGE = "Invalid review request.";
const REVIEW_CHANGED_MESSAGE = "This review changed. Refresh it.";
const REVIEW_ALREADY_HANDLED_MESSAGE = "This review is already being handled.";
const SLACK_REVIEW_PREPARE_FAILED_MESSAGE = "Could not prepare Slack sharing.";

const slackPrepareBodySchema = z.object({
  /** @external slack review refresh flag */
  refresh: z.boolean().optional(),
});

const SLACK_REVIEW_ACTIONS = ["prepare", "confirm", "revise", "dismiss"] as const;

type SlackReviewAction = (typeof SLACK_REVIEW_ACTIONS)[number];

async function handleSlackReviewAction(input: {
  action: SlackReviewAction;
  meetingId: string;
  userId: string;
  body: unknown;
}) {
  if (input.action === "prepare") {
    const parsedBody = slackPrepareBodySchema.parse(input.body);

    return prepareSlackMeetingReview(input.meetingId, input.userId, parsedBody.refresh === true, true);
  }

  const parsed = (input.action === "revise" ? slackReviewRevisionSchema : slackReviewActionSchema).safeParse(
    input.body,
  );
  if (!parsed.success) {
    return { kind: "invalid_request" as const };
  }
  if (input.action === "confirm") {
    return confirmSlackMeetingReview(input.meetingId, input.userId, parsed.data.version);
  }
  if (input.action === "revise") {
    const revision = slackReviewRevisionSchema.parse(input.body);

    return reviseSlackMeetingReview(input.meetingId, input.userId, parsed.data.version, revision.instruction);
  }
  const existing = await repositories().getSlackMeetingReview(input.meetingId);
  if (!existing || existing.userId !== input.userId || existing.version !== parsed.data.version) {
    throw new Error(REVIEW_CHANGED_MESSAGE);
  }
  const savedReview = await repositories().saveSlackMeetingReview({
    review: { ...existing, status: "dismissed", version: existing.version + 1 },
    expectedVersion: existing.version,
  });
  if (savedReview === null) {
    throw new Error(REVIEW_ALREADY_HANDLED_MESSAGE);
  }

  return savedReview;
}

export async function slackReviewRoutes(app: FastifyInstance): Promise<void> {
  const access = requireMeetingAccess("participant");
  SLACK_REVIEW_ACTIONS.forEach((action) => {
    app.post(`/meetings/:meetingId/slack-review/${action}`, { preHandler: access }, async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const user = request.user;
      if (user === undefined) {
        return reply.code(HTTP_FORBIDDEN).send({ message: SLACK_REVIEW_OWNER_ONLY_MESSAGE });
      }
      const userId = user.id;
      if (meeting.createdByUserId !== userId) {
        return reply.code(HTTP_FORBIDDEN).send({ message: SLACK_REVIEW_OWNER_ONLY_MESSAGE });
      }
      if ((await resolveMeetingNotesAccess({ meeting, viewerRole: "participant", userId })).locked) {
        return reply.code(HTTP_FORBIDDEN).send({ message: MEETING_NOTES_LOCKED_MESSAGE });
      }
      try {
        const requestBody =
          action === "prepare"
            ? slackPrepareBodySchema.parse(request.body)
            : action === "revise"
              ? slackReviewRevisionSchema.parse(request.body)
              : slackReviewActionSchema.parse(request.body);
        const reviewResult = await handleSlackReviewAction({
          action,
          meetingId: meeting.id,
          userId,
          body: requestBody,
        });
        if (reviewResult !== null && typeof reviewResult === "object" && "kind" in reviewResult) {
          return await reply.code(HTTP_BAD_REQUEST).send({ message: INVALID_REVIEW_REQUEST_MESSAGE });
        }

        return slackMeetingReviewResponseSchema.parse({ review: reviewResult });
      } catch (error) {
        request.log.warn({ error, meetingId: meeting.id }, "Slack review request failed");

        return reply
          .code(HTTP_CONFLICT)
          .send({ message: error instanceof Error ? error.message : SLACK_REVIEW_PREPARE_FAILED_MESSAGE });
      }
    });
  });
}
