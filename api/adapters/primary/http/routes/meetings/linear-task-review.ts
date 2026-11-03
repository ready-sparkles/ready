import {
  linearTaskReviewResponseSchema,
  reviseLinearTaskReviewRequestSchema,
  updateLinearTaskReviewTargetRequestSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  canUseLinearTaskReviewForMeeting,
  enqueueLinearTaskReviewIfEligible,
  getLinearTaskReviewIfEnabled,
  reviseLinearTaskReview,
  syncLinearTaskReview,
  updateLinearTaskReviewTarget,
} from "../../../../../application/linear-task-review-service";
import { repositories } from "../../../../../ports/repository-runtime";
import { requireAuth } from "../../plugins/auth";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

const CODE_MEETING_NOTES_LOCKED = "meeting_notes_locked";

const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_ONLY_MEETING_OWNER_CAN_RUN_LINEAR_TASK_REVIEW = "Only the meeting owner can run Linear task review.";
const MESSAGE_MEETING_NOTES_LOCKED = "Meeting notes are locked.";
const MESSAGE_CONNECT_LINEAR_AND_PREPARE_OPEN_TASK = "Connect Linear and prepare at least one open task first.";
const MESSAGE_LINEAR_TASK_REVIEW_NOT_FOUND = "Linear task review not found.";

const requireParticipant = requireMeetingAccess("participant", {
  forbiddenMessage: "Linear task review is available only to meeting participants.",
  allowWorkspaceViewer: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRunIdFromParams(input: { params: unknown }): string {
  if (!isRecord(input.params)) {
    return "";
  }

  const runId = input.params.runId;

  return typeof runId === "string" ? runId : "";
}

function readRunIdAndItemIdFromParams(input: { params: unknown }): { runId: string; itemId: string } {
  if (!isRecord(input.params)) {
    return { runId: "", itemId: "" };
  }

  const runId = input.params.runId;
  const itemId = input.params.itemId;

  return {
    runId: typeof runId === "string" ? runId : "",
    itemId: typeof itemId === "string" ? itemId : "",
  };
}

function requireRequestUser(input: { user: { id: string } | null | undefined }) {
  const { user } = input;
  if (user === null || user === undefined) {
    throw new Error(MESSAGE_UNAUTHORIZED);
  }

  return user;
}

async function loadOwnedLinearTaskReviewForRequest(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  runId: string;
}) {
  const review = await repositories().getLinearTaskReviewById(input.runId);
  const userId = requireRequestUser({ user: input.request.user }).id;
  if (!review || review.userId !== userId) {
    return {
      blocked: input.reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_LINEAR_TASK_REVIEW_NOT_FOUND }),
    };
  }

  if (!(await canUseLinearTaskReviewForMeeting(review.meetingId, userId))) {
    return {
      blocked: input.reply
        .code(HTTP_FORBIDDEN)
        .send({ code: CODE_MEETING_NOTES_LOCKED, message: MESSAGE_MEETING_NOTES_LOCKED }),
    };
  }

  return { review, userId };
}

function registerLinearTaskReviewGetRoute(app: FastifyInstance): void {
  app.get(
    "/meetings/:meetingId/linear-task-review",
    {
      preHandler: requireParticipant,
    },
    async (request) => {
      const { meeting } = getMeetingAccess(request);

      return linearTaskReviewResponseSchema.parse({
        review:
          requireRequestUser({ user: request.user }).id === meeting.createdByUserId
            ? await getLinearTaskReviewIfEnabled(meeting.id, meeting.createdByUserId)
            : null,
      });
    },
  );
}

function registerLinearTaskReviewRunRoute(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/linear-task-review/run",
    {
      preHandler: requireMeetingAccess("participant", {
        forbiddenMessage: "Only meeting participants can run Linear task review.",
      }),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const userId = requireRequestUser({ user: request.user }).id;
      if (meeting.createdByUserId !== userId) {
        return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEETING_OWNER_CAN_RUN_LINEAR_TASK_REVIEW });
      }
      if (!(await canUseLinearTaskReviewForMeeting(meeting.id, userId))) {
        return reply
          .code(HTTP_FORBIDDEN)
          .send({ code: CODE_MEETING_NOTES_LOCKED, message: MESSAGE_MEETING_NOTES_LOCKED });
      }
      const review = await enqueueLinearTaskReviewIfEligible(meeting.id);
      if (!review) {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_CONNECT_LINEAR_AND_PREPARE_OPEN_TASK });
      }

      return linearTaskReviewResponseSchema.parse({ review });
    },
  );
}

function registerLinearTaskReviewReviseRoute(app: FastifyInstance): void {
  app.post("/linear-task-reviews/:runId/revise", { preHandler: requireAuth }, async (request, reply) => {
    const runId = readRunIdFromParams({ params: request.params });
    const parsed = reviseLinearTaskReviewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    const loaded = await loadOwnedLinearTaskReviewForRequest({ request, reply, runId });
    if ("blocked" in loaded) {
      return loaded.blocked;
    }
    const updated = await reviseLinearTaskReview({
      runId,
      userId: loaded.userId,
      instruction: parsed.data.instruction,
    });

    return linearTaskReviewResponseSchema.parse({ review: updated });
  });
}

function registerLinearTaskReviewSyncRoute(app: FastifyInstance): void {
  app.post("/linear-task-reviews/:runId/sync", { preHandler: requireAuth }, async (request, reply) => {
    const runId = readRunIdFromParams({ params: request.params });
    const loaded = await loadOwnedLinearTaskReviewForRequest({ request, reply, runId });
    if ("blocked" in loaded) {
      return loaded.blocked;
    }
    const updated = await syncLinearTaskReview({ runId, userId: loaded.userId });

    return linearTaskReviewResponseSchema.parse({ review: updated });
  });
}

function registerLinearTaskReviewTargetRoute(app: FastifyInstance): void {
  app.post("/linear-task-reviews/:runId/items/:itemId/target", { preHandler: requireAuth }, async (request, reply) => {
    const { runId, itemId } = readRunIdAndItemIdFromParams({ params: request.params });
    const parsed = updateLinearTaskReviewTargetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    const loaded = await loadOwnedLinearTaskReviewForRequest({ request, reply, runId });
    if ("blocked" in loaded) {
      return loaded.blocked;
    }
    const updated = await updateLinearTaskReviewTarget({
      runId,
      itemId,
      userId: loaded.userId,
      action: parsed.data.action,
      issueId: parsed.data.issueId,
    });

    return linearTaskReviewResponseSchema.parse({ review: updated });
  });
}

export async function linearTaskReviewRoutes(app: FastifyInstance): Promise<void> {
  registerLinearTaskReviewGetRoute(app);
  registerLinearTaskReviewRunRoute(app);
  registerLinearTaskReviewReviseRoute(app);
  registerLinearTaskReviewSyncRoute(app);
  registerLinearTaskReviewTargetRoute(app);
}
