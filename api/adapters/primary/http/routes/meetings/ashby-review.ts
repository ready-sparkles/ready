import { ashbyReviewActionSchema, ashbyReviewResponseSchema } from "@readymeet/shared";
import type { FastifyInstance } from "fastify";

import {
  actOnAshbyReview,
  ashbyReviewAccess,
  enqueueAshbyReview,
  getPrivateAshbyReview,
} from "../../../../secondary/ashby/ashby-review-service";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";

const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const MESSAGE_CONNECT_ASHBY_IN_YOUR_WORKSPACE_AND_UNLOCK_MEETING_NOTES_TO_REVIEW_ =
  "Connect Ashby in your workspace and unlock meeting notes to review actions.";
const MESSAGE_INVALID_ASHBY_REVIEW_ACTION = "Invalid Ashby review action.";
const MESSAGE_COULD_NOT_UPDATE_THE_REVIEW = "Could not update the review.";

export async function ashbyReviewRoutes(app: FastifyInstance): Promise<void> {
  const preHandler = requireMeetingAccess("participant", {
    forbiddenMessage: "Ashby review is available only to meeting participants.",
  });
  app.get("/meetings/:meetingId/ashby-review", { preHandler }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { meeting } = getMeetingAccess(request);
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const isEnabled = await ashbyReviewAccess(meeting.id, user.id);
    if (!isEnabled) {
      return ashbyReviewResponseSchema.parse({
        review: null,
        /** @external ashby review response */
        enabled: false,
      });
    }

    return ashbyReviewResponseSchema.parse({
      review: await getPrivateAshbyReview(meeting.id, user.id),
    });
  });
  app.post("/meetings/:meetingId/ashby-review/run", { preHandler }, async (request, reply) => {
    const { meeting } = getMeetingAccess(request);
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    if (!(await ashbyReviewAccess(meeting.id, user.id))) {
      return reply.code(HTTP_FORBIDDEN).send({
        message: MESSAGE_CONNECT_ASHBY_IN_YOUR_WORKSPACE_AND_UNLOCK_MEETING_NOTES_TO_REVIEW_,
      });
    }
    await enqueueAshbyReview(meeting.id);

    return { review: await getPrivateAshbyReview(meeting.id, user.id) };
  });
  app.post("/meetings/:meetingId/ashby-review", { preHandler }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const parsed = ashbyReviewActionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_ASHBY_REVIEW_ACTION });
    }
    const { meeting } = getMeetingAccess(request);
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    try {
      return ashbyReviewResponseSchema.parse({
        review: await actOnAshbyReview(meeting.id, user.id, parsed.data),
      });
    } catch (error) {
      return reply
        .code(HTTP_CONFLICT)
        .send({ message: error instanceof Error ? error.message : MESSAGE_COULD_NOT_UPDATE_THE_REVIEW });
    }
  });
}
