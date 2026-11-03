import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  ambientContextPrivateDetailsSchema,
  canRetryAmbientContextResearch,
  meetingAmbientContextItemSchema,
  meetingAmbientContextResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { readAmbientContextImageObject } from "../../../../../application/ambient-context-image";
import { meetingPeopleMemory } from "../../../../../application/meeting-people-memory";
import { personCardPrivateDetails } from "../../../../../application/person-card-private";
import { runAiWorkflowInRequest } from "../../../../../application/run-ai-work";
import { repositories } from "../../../../../ports/repository-runtime";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";
import { requireMeetingNotesAccess } from "../../support/meeting-notes-guard";

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const MESSAGE_AMBIENT_CONTEXT_ITEM_NOT_FOUND = "Ambient context item not found";
const MESSAGE_CONTEXT_RESEARCH_IS_NO_LONGER_IN_A_RETRYABLE_STATE = "Context research is no longer in a retryable state";
const MESSAGE_AMBIENT_IDENTITY_IMAGE_NOT_FOUND = "Ambient identity image not found";

const ambientContextItemParamsSchema = z.object({ itemId: z.string() });
const HTTP_UNAUTHORIZED = 401;
const MESSAGE_UNAUTHORIZED = "Unauthorized";

const requireContextAccess = requireMeetingNotesAccess({
  level: "joined-guest",
  options: {
    forbiddenMessage: "Meeting context is available only to joined meeting participants.",
  },
});
const requireContextRetryAccess = requireMeetingNotesAccess({
  level: "participant",
  options: {
    forbiddenMessage: "Only meeting participants can retry context research.",
  },
});
const requireContextPrivateAccess = requireMeetingNotesAccess({
  level: "participant",
  options: {
    forbiddenMessage: "Only meeting participants can see their own details for this person.",
  },
});

function publicItem(item: Awaited<ReturnType<RepositoryPort["getMeetingAmbientContextItem"]>>) {
  if (!item) {
    return null;
  }

  return meetingAmbientContextItemSchema.parse(item);
}

async function registerAmbientContextRetryRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/meetings/:meetingId/ambient-context/:itemId/retry",
    { preHandler: requireContextRetryAccess },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const { itemId } = ambientContextItemParamsSchema.parse(request.params);
      const item = await repositories().getMeetingAmbientContextItem({ meetingId: meeting.id, itemId });
      if (!item) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_AMBIENT_CONTEXT_ITEM_NOT_FOUND });
      }
      if (!canRetryAmbientContextResearch(item) && item.status !== "pending" && item.status !== "researching") {
        return meetingAmbientContextItemSchema.parse(publicItem(item));
      }
      const retried = await repositories().retryFailedMeetingAmbientContextItemAndEnqueueResearch({
        meetingId: meeting.id,
        itemId,
      });
      if (!retried) {
        const completed = await repositories().getMeetingAmbientContextItem({ meetingId: meeting.id, itemId });
        if (completed?.status === "ready") {
          return meetingAmbientContextItemSchema.parse(publicItem(completed));
        }

        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_CONTEXT_RESEARCH_IS_NO_LONGER_IN_A_RETRYABLE_STATE });
      }
      await repositories().publishAmbientContextRealtimeUpdate({
        workspaceId: meeting.workspaceId,
        meetingId: meeting.id,
        itemId,
        status: retried.item.status,
      });

      await runAiWorkflowInRequest({
        meetingId: meeting.id,
        type: "research_ambient_entity",
        job: retried.researchJob,
        logger: request.log,
      });
      const completed = await repositories().getMeetingAmbientContextItem({ meetingId: meeting.id, itemId });
      if (!completed) {
        throw new Error(MESSAGE_AMBIENT_CONTEXT_ITEM_NOT_FOUND);
      }

      return meetingAmbientContextItemSchema.parse(publicItem(completed));
    },
  );
}

export async function meetingAmbientContextRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/meetings/:meetingId/people-memory",
    { preHandler: requireMeetingAccess("participant") },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const { meeting } = getMeetingAccess(request);
      const user = request.user;
      if (!user) {
        return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
      }
      if (user.workspaceId === "") {
        return { items: [] };
      }

      return meetingPeopleMemory({ userId: user.id, workspaceId: user.workspaceId }, meeting);
    },
  );

  app.get("/meetings/:meetingId/ambient-context", { preHandler: requireContextAccess }, async (request) => {
    const { meeting } = getMeetingAccess(request);
    const items = await repositories().listMeetingAmbientContextItems(meeting.id);

    return meetingAmbientContextResponseSchema.parse({ items: items.map(publicItem) });
  });

  await registerAmbientContextRetryRoute(app);

  // Per-viewer sections of a person card: the viewer's own memory and, if they
  // turned Ashby on, Ashby application facts. Computed on request for this
  // viewer only and never stored on the shared card. Guests are denied.
  app.get(
    "/meetings/:meetingId/ambient-context/:itemId/private",
    { preHandler: requireContextPrivateAccess },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const { itemId } = ambientContextItemParamsSchema.parse(request.params);
      const item = await repositories().getMeetingAmbientContextItem({ meetingId: meeting.id, itemId });
      if (!item) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_AMBIENT_CONTEXT_ITEM_NOT_FOUND });
      }
      reply.header("cache-control", "private, no-store");
      const user = request.user;
      if (!user) {
        return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
      }
      if (item.entityKind !== "person" || user.workspaceId === "") {
        return ambientContextPrivateDetailsSchema.parse({ memory: null, ashby: null });
      }

      return ambientContextPrivateDetailsSchema.parse(
        await personCardPrivateDetails({
          userId: user.id,
          workspaceId: user.workspaceId,
          displayName: item.displayName,
          logger: request.log,
        }),
      );
    },
  );

  app.get(
    "/meetings/:meetingId/ambient-context/:itemId/image",
    { preHandler: requireContextAccess },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const { itemId } = ambientContextItemParamsSchema.parse(request.params);
      const item = await repositories().getMeetingAmbientContextItem({ meetingId: meeting.id, itemId });
      if (item === null) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_AMBIENT_IDENTITY_IMAGE_NOT_FOUND });
      }
      if (item.imageStorageKey === null || item.imageStorageKey === "") {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_AMBIENT_IDENTITY_IMAGE_NOT_FOUND });
      }
      if (item.imageMimeType === null || item.imageMimeType === "") {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_AMBIENT_IDENTITY_IMAGE_NOT_FOUND });
      }
      const content = await readAmbientContextImageObject(item.imageStorageKey);
      reply.header("content-type", item.imageMimeType);
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");

      return reply.send(content);
    },
  );
}
