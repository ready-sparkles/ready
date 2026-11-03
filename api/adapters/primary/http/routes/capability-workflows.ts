import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  capabilityWorkflowResponseSchema,
  capabilityWorkflowsResponseSchema,
  sendCapabilityWorkflowMessageRequestSchema,
  startCapabilityWorkflowRequestSchema,
  updateCapabilityWorkflowDraftRequestSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import {
  reviseCapabilityWorkflow,
  startCapabilityWorkflow,
  syncBugReportWorkflow,
  updateBugReportDraft,
} from "../../../../application/capability-workflow-service";
import { repositories } from "../../../../ports/repository-runtime";
import { requireAuth } from "../plugins/auth";
import { getMeetingAccess } from "../support/meeting-access";
import { requireUnlockedMeetingNotes } from "../support/meeting-notes-guard";

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_MEETING_NOT_FOUND = "Meeting not found";
const MESSAGE_WORKFLOW_NOT_FOUND = "Workflow not found";
const MESSAGE_UNABLE_TO_START_WORKFLOW = "Unable to start workflow";
const MESSAGE_UNABLE_TO_UPDATE_WORKFLOW = "Unable to update workflow";
const MESSAGE_UNABLE_TO_UPDATE_DRAFT = "Unable to update draft";
const MESSAGE_UNABLE_TO_SYNC_WORKFLOW = "Unable to sync workflow";

type MeetingRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;

const workflowOwnerAccessParamsSchema = z.object({
  meetingId: z.string().optional(),
  recommendationId: z.string().optional(),
  workflowRunId: z.string().optional(),
});

const recommendationIdParamsSchema = z.object({
  recommendationId: z.string(),
});

const workflowRunIdParamsSchema = z.object({
  workflowRunId: z.string(),
});

const startWorkflowRequestBodySchema = startCapabilityWorkflowRequestSchema.default({});

function requireUser(input: { user?: { id: string; email: string; displayName: string } }) {
  if (input.user === undefined) {
    throw new Error(MESSAGE_UNAUTHORIZED);
  }

  return input.user;
}

async function resolveWorkflowOwnerMeetingId(input: {
  params: z.infer<typeof workflowOwnerAccessParamsSchema>;
}): Promise<string | undefined> {
  const { params } = input;
  if (params.meetingId !== undefined) {
    return params.meetingId;
  }
  if (params.workflowRunId !== undefined) {
    return (await repositories().getCapabilityWorkflowRunById(params.workflowRunId))?.meetingId;
  }
  if (params.recommendationId !== undefined) {
    return (await repositories().getRecommendationById(params.recommendationId))?.meetingId;
  }

  return undefined;
}

function attachHostMeetingAccess(input: { request: FastifyRequest; meeting: MeetingRecord }) {
  const { request } = input;
  request.meetingAccess = { meeting: input.meeting, level: "host", viewerRole: "host" };
}

async function requireWorkflowOwnerAccess(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { request, reply } = input;
  const params = workflowOwnerAccessParamsSchema.parse(request.params);
  const meetingId = await resolveWorkflowOwnerMeetingId({ params });
  const meeting = meetingId !== undefined ? await repositories().getMeetingById(meetingId) : null;
  const user = request.user;
  if (user === undefined) {
    throw new Error(MESSAGE_UNAUTHORIZED);
  }
  if (meeting === null || meeting.createdByUserId !== user.id) {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_NOT_FOUND });
  }
  attachHostMeetingAccess({ request, meeting });
}

const requireWorkflowOwnerAccessHandler: preHandlerAsyncHookHandler = (request, reply) =>
  requireWorkflowOwnerAccess({ request, reply });

const requireUnlockedMeetingNotesHandler: preHandlerAsyncHookHandler = (request, reply) =>
  requireUnlockedMeetingNotes({ request, reply });

function registerListCapabilityWorkflowsRoute(input: {
  app: FastifyInstance;
  requireWorkflowAccess: preHandlerAsyncHookHandler[];
}): void {
  const { app, requireWorkflowAccess } = input;
  app.get("/meetings/:meetingId/capability-workflows", { preHandler: requireWorkflowAccess }, async (request) => {
    const { meeting } = getMeetingAccess(request);
    const workflows = await repositories().listCapabilityWorkflowRunsForMeeting(meeting.id);

    return capabilityWorkflowsResponseSchema.parse({ workflows });
  });
}

function registerStartCapabilityWorkflowRoute(input: {
  app: FastifyInstance;
  requireWorkflowAccess: preHandlerAsyncHookHandler[];
}): void {
  const { app, requireWorkflowAccess } = input;
  app.post(
    "/recommendations/:recommendationId/workflow",
    { preHandler: requireWorkflowAccess },
    async (request, reply) => {
      const user = requireUser({ user: request.user });
      const { recommendationId } = recommendationIdParamsSchema.parse(request.params);
      const parsed = startWorkflowRequestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      try {
        const result = await startCapabilityWorkflow({
          user,
          recommendationId,
          forceRefresh: parsed.data.forceRefresh,
        });

        return capabilityWorkflowResponseSchema.parse(result);
      } catch (error) {
        return reply.code(HTTP_BAD_REQUEST).send({
          message: error instanceof Error ? error.message : MESSAGE_UNABLE_TO_START_WORKFLOW,
        });
      }
    },
  );
}

function registerSendCapabilityWorkflowMessageRoute(input: {
  app: FastifyInstance;
  requireWorkflowAccess: preHandlerAsyncHookHandler[];
}): void {
  const { app, requireWorkflowAccess } = input;
  app.post(
    "/capability-workflows/:workflowRunId/messages",
    { preHandler: requireWorkflowAccess },
    async (request, reply) => {
      const user = requireUser({ user: request.user });
      const parsed = sendCapabilityWorkflowMessageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }
      const { workflowRunId } = workflowRunIdParamsSchema.parse(request.params);

      try {
        const result = await reviseCapabilityWorkflow({
          user,
          workflowRunId,
          content: parsed.data.content,
        });

        return capabilityWorkflowResponseSchema.parse(result);
      } catch (error) {
        return reply.code(HTTP_BAD_REQUEST).send({
          message: error instanceof Error ? error.message : MESSAGE_UNABLE_TO_UPDATE_WORKFLOW,
        });
      }
    },
  );
}

function registerUpdateCapabilityWorkflowDraftRoute(input: {
  app: FastifyInstance;
  requireWorkflowAccess: preHandlerAsyncHookHandler[];
}): void {
  const { app, requireWorkflowAccess } = input;
  app.patch(
    "/capability-workflows/:workflowRunId/draft",
    { preHandler: requireWorkflowAccess },
    async (request, reply) => {
      const user = requireUser({ user: request.user });
      const parsed = updateCapabilityWorkflowDraftRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }
      const { workflowRunId } = workflowRunIdParamsSchema.parse(request.params);

      try {
        const result = await updateBugReportDraft({
          user,
          workflowRunId,
          draft: parsed.data.draft,
        });

        return capabilityWorkflowResponseSchema.parse(result);
      } catch (error) {
        return reply.code(HTTP_BAD_REQUEST).send({
          message: error instanceof Error ? error.message : MESSAGE_UNABLE_TO_UPDATE_DRAFT,
        });
      }
    },
  );
}

function registerSyncCapabilityWorkflowRoute(input: {
  app: FastifyInstance;
  requireWorkflowAccess: preHandlerAsyncHookHandler[];
}): void {
  const { app, requireWorkflowAccess } = input;
  app.post(
    "/capability-workflows/:workflowRunId/sync",
    { preHandler: requireWorkflowAccess },
    async (request, reply) => {
      const user = requireUser({ user: request.user });
      const { workflowRunId } = workflowRunIdParamsSchema.parse(request.params);

      try {
        const result = await syncBugReportWorkflow({ user, workflowRunId });

        return capabilityWorkflowResponseSchema.parse(result);
      } catch (error) {
        return reply.code(HTTP_BAD_REQUEST).send({
          message: error instanceof Error ? error.message : MESSAGE_UNABLE_TO_SYNC_WORKFLOW,
        });
      }
    },
  );
}

function registerGetCapabilityWorkflowRoute(input: {
  app: FastifyInstance;
  requireWorkflowAccess: preHandlerAsyncHookHandler[];
}): void {
  const { app, requireWorkflowAccess } = input;
  app.get("/capability-workflows/:workflowRunId", { preHandler: requireWorkflowAccess }, async (request, reply) => {
    const { workflowRunId } = workflowRunIdParamsSchema.parse(request.params);
    const workflow = await repositories().getCapabilityWorkflowRunById(workflowRunId);
    if (workflow === null) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKFLOW_NOT_FOUND });
    }

    return capabilityWorkflowResponseSchema.parse({
      workflow,
      messages: await repositories().listCapabilityWorkflowMessages(workflowRunId),
    });
  });
}

export async function capabilityWorkflowRoutes(app: FastifyInstance): Promise<void> {
  const requireWorkflowAccess: preHandlerAsyncHookHandler[] = [
    requireAuth,
    requireWorkflowOwnerAccessHandler,
    requireUnlockedMeetingNotesHandler,
  ];
  registerListCapabilityWorkflowsRoute({ app, requireWorkflowAccess });
  registerStartCapabilityWorkflowRoute({ app, requireWorkflowAccess });
  registerSendCapabilityWorkflowMessageRoute({ app, requireWorkflowAccess });
  registerUpdateCapabilityWorkflowDraftRoute({ app, requireWorkflowAccess });
  registerSyncCapabilityWorkflowRoute({ app, requireWorkflowAccess });
  registerGetCapabilityWorkflowRoute({ app, requireWorkflowAccess });
}
