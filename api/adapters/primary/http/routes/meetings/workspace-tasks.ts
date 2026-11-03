import {
  WORKSPACE_TASK_SECTION_TITLE_CONFLICT_MESSAGE,
  WorkspaceTaskSectionTitleConflictError,
} from "@readymeet/db/domain/persistence-errors";
import { isUniqueViolation } from "@readymeet/db/domain/unique-violation";
import {
  assignedTaskContextResponseSchema,
  assignedTasksResponseSchema,
  clearDoneTasksRequestSchema,
  clearDoneTasksResponseSchema,
  clearSelectedDoneTasksRequestSchema,
  clearSelectedDoneTasksResponseSchema,
  createWorkspaceTaskRequestSchema,
  deleteWorkspaceTaskSectionResponseSchema,
  deleteWorkspaceTasksRequestSchema,
  personalAssignedTasksResponseSchema,
  reorderWorkspaceTasksRequestSchema,
  reorderWorkspaceTasksResponseSchema,
  updateWorkspaceTaskRequestSchema,
  upsertWorkspaceTaskSectionRequestSchema,
  userWorkspaceIdsResponseSchema,
  workspaceAssignedTasksResponseSchema,
  workspaceMembersResponseSchema,
  workspaceTaskResponseSchema,
  workspaceTaskSectionResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { repositories } from "../../../../../ports/repository-runtime";
import { requireAuth } from "../../plugins/auth";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_WORKSPACE_ACCESS_REQUIRED = "Workspace access required";
const MESSAGE_ONLY_MEMBERS_VIEW_WORKSPACE_TASKS = "Only workspace members can view workspace tasks.";
const MESSAGE_ONLY_MEMBERS_CREATE_WORKSPACE_TASKS = "Only workspace members can create workspace tasks.";
const MESSAGE_ONLY_MEMBERS_UPDATE_WORKSPACE_TASKS = "Only workspace members can update workspace tasks.";
const MESSAGE_ONLY_MEMBERS_DELETE_WORKSPACE_TASKS = "Only workspace members can delete workspace tasks.";
const MESSAGE_ONLY_MEMBERS_CREATE_TASK_SECTIONS = "Only workspace members can create task sections.";
const MESSAGE_ONLY_MEMBERS_UPDATE_TASK_SECTIONS = "Only workspace members can update task sections.";
const MESSAGE_ONLY_MEMBERS_DELETE_TASK_SECTIONS = "Only workspace members can delete task sections.";
const MESSAGE_ONLY_MEMBERS_REORDER_WORKSPACE_TASKS = "Only workspace members can reorder workspace tasks.";
const MESSAGE_TASK_ASSIGNEE_MUST_BE_MEMBER = "Task assignee must be a member of this workspace.";
const MESSAGE_TASK_COULD_NOT_BE_CREATED = "Task could not be created.";
const MESSAGE_TASK_NOT_FOUND = "Task not found.";
const MESSAGE_SECTION_COULD_NOT_BE_CREATED = "Section could not be created.";
const MESSAGE_SECTION_COULD_NOT_BE_UPDATED = "Section could not be updated.";
const MESSAGE_SECTION_NOT_FOUND = "Section not found.";
const STORED_DRIVER_ERROR_NAMES = new Set([
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientValidationError",
  "PrismaClientInitializationError",
]);

function isStoredDriverError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name: unknown = Reflect.get(error, "name");

  return typeof name === "string" && STORED_DRIVER_ERROR_NAMES.has(name);
}

function replyForSectionWriteError(input: {
  error: unknown;
  reply: FastifyReply;
  fallbackStatus: number;
  fallbackMessage: string;
  driverMessage: string;
}): FastifyReply {
  if (input.error instanceof WorkspaceTaskSectionTitleConflictError || isUniqueViolation(input.error)) {
    return input.reply.code(HTTP_CONFLICT).send({ message: WORKSPACE_TASK_SECTION_TITLE_CONFLICT_MESSAGE });
  }
  if (isStoredDriverError(input.error)) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: input.driverMessage });
  }
  const message = input.error instanceof Error ? input.error.message : input.fallbackMessage;

  return input.reply.code(input.fallbackStatus).send({ message });
}
const MESSAGE_SECTION_COULD_NOT_BE_DELETED = "Section could not be deleted.";
const MESSAGE_TASKS_COULD_NOT_BE_REORDERED = "Tasks could not be reordered.";
const MESSAGE_ASSIGNED_TASK_CONTEXT_UNAVAILABLE = "Assigned task context is not available.";

const workspaceIdParamsSchema = z.object({ workspaceId: z.string().uuid() });
const workspaceTaskParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  taskId: z.string().uuid(),
});
const workspaceSectionParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  sectionId: z.string().uuid(),
});
const taskIdParamsSchema = z.object({ taskId: z.string().uuid() });

async function registerWorkspaceTaskMemberRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:workspaceId/members", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    const { workspaceId } = workspaceIdParamsSchema.parse(request.params);
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_WORKSPACE_ACCESS_REQUIRED });
    }

    const members = await repositories().listWorkspaceMembers(workspaceId);

    return workspaceMembersResponseSchema.parse({ members });
  });

  app.get("/me/workspaces", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const workspaceIds = await repositories().listWorkspaceIdsForUser(user.id);

    return userWorkspaceIdsResponseSchema.parse({
      workspaceIds: workspaceIds.length !== 0 ? workspaceIds : [user.workspaceId],
    });
  });

  app.get("/me/tasks", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const workspaceIds = await repositories().listWorkspaceIdsForUser(user.id);
    const tasks = await repositories().listAssignedTasksForUser({
      userId: user.id,
      workspaceIds: workspaceIds.length !== 0 ? workspaceIds : [user.workspaceId],
    });

    return assignedTasksResponseSchema.parse({ tasks });
  });
}

async function registerPersonalAssignedTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/tasks/personal", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const payload = await repositories().listPersonalAssignedTasksForUser({ userId: user.id });

    return personalAssignedTasksResponseSchema.parse(payload);
  });

  app.post("/me/tasks/personal/clear-done", { preHandler: requireAuth }, async (request, reply) => {
    if (request.user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = clearDoneTasksRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    const completedBefore = await repositories().clearPersonalDoneTasks({ userId: request.user.id, ...parsed.data });
    if (completedBefore === null) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_WORKSPACE_ACCESS_REQUIRED });
    }

    return clearDoneTasksResponseSchema.parse({ completedBefore });
  });

  app.post("/me/tasks/personal/clear-selected", { preHandler: requireAuth }, async (request, reply) => {
    if (request.user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = clearSelectedDoneTasksRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    if (!(await repositories().isWorkspaceMember({ userId: request.user.id, workspaceId: parsed.data.workspaceId }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_WORKSPACE_ACCESS_REQUIRED });
    }
    const tasks = await repositories().clearSelectedPersonalDoneTasks({ userId: request.user.id, ...parsed.data });

    return clearSelectedDoneTasksResponseSchema.parse({ tasks });
  });
}

async function registerWorkspaceAssignedTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:workspaceId/me/tasks", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const { workspaceId } = workspaceIdParamsSchema.parse(request.params);
    if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEMBERS_VIEW_WORKSPACE_TASKS });
    }

    const payload = await repositories().listWorkspaceAssignedTasksForUser({
      userId: user.id,
      workspaceId,
    });

    return workspaceAssignedTasksResponseSchema.parse(payload);
  });

  app.post("/workspaces/:workspaceId/tasks", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const { workspaceId } = workspaceIdParamsSchema.parse(request.params);
    if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEMBERS_CREATE_WORKSPACE_TASKS });
    }
    const parsed = createWorkspaceTaskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    if (
      parsed.data.assigneeUserId !== undefined &&
      parsed.data.assigneeUserId !== null &&
      parsed.data.assigneeUserId !== "" &&
      !(await repositories().isWorkspaceMember({ workspaceId, userId: parsed.data.assigneeUserId }))
    ) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_TASK_ASSIGNEE_MUST_BE_MEMBER });
    }

    try {
      const task = await repositories().createWorkspaceTask({
        workspaceId,
        actorUserId: user.id,
        title: parsed.data.title,
        description: parsed.data.description,
        assigneeUserId: parsed.data.assigneeUserId,
        dueDateValue: parsed.data.dueDateValue,
        sectionId: parsed.data.sectionId,
        beforeTaskId: parsed.data.beforeTaskId,
        afterTaskId: parsed.data.afterTaskId,
      });

      return workspaceTaskResponseSchema.parse({ task });
    } catch (error) {
      return reply.code(HTTP_BAD_REQUEST).send({
        message: error instanceof Error ? error.message : MESSAGE_TASK_COULD_NOT_BE_CREATED,
      });
    }
  });

  app.patch("/workspaces/:workspaceId/tasks/:taskId", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const { workspaceId, taskId } = workspaceTaskParamsSchema.parse(request.params);
    if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEMBERS_UPDATE_WORKSPACE_TASKS });
    }
    const parsed = updateWorkspaceTaskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    if (
      parsed.data.assigneeUserId !== undefined &&
      parsed.data.assigneeUserId !== null &&
      parsed.data.assigneeUserId !== "" &&
      !(await repositories().isWorkspaceMember({ workspaceId, userId: parsed.data.assigneeUserId }))
    ) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_TASK_ASSIGNEE_MUST_BE_MEMBER });
    }

    try {
      const task = await repositories().updateWorkspaceTask({
        workspaceId,
        taskId,
        actorUserId: user.id,
        title: parsed.data.title,
        description: parsed.data.description,
        assigneeUserId: parsed.data.assigneeUserId,
        dueDateValue: parsed.data.dueDateValue,
        status: parsed.data.status,
        sectionId: parsed.data.sectionId,
      });

      return workspaceTaskResponseSchema.parse({ task });
    } catch (error) {
      return reply.code(HTTP_NOT_FOUND).send({
        message: error instanceof Error ? error.message : MESSAGE_TASK_NOT_FOUND,
      });
    }
  });
}

async function registerWorkspaceTaskDeleteRoutes(app: FastifyInstance): Promise<void> {
  app.delete("/workspaces/:workspaceId/tasks", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const { workspaceId } = workspaceIdParamsSchema.parse(request.params);
    if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEMBERS_DELETE_WORKSPACE_TASKS });
    }
    const parsed = deleteWorkspaceTasksRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    const taskIds = await repositories().deleteWorkspaceTasksByIds({
      workspaceId,
      taskIds: parsed.data.taskIds,
      actorUserId: user.id,
    });

    return { taskIds };
  });
}

async function registerWorkspaceTaskSectionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:workspaceId/task-sections", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const { workspaceId } = workspaceIdParamsSchema.parse(request.params);
    if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEMBERS_CREATE_TASK_SECTIONS });
    }
    const parsed = upsertWorkspaceTaskSectionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    try {
      const section = await repositories().createWorkspaceTaskSection({
        workspaceId,
        actorUserId: user.id,
        title: parsed.data.title,
        position: parsed.data.position,
      });

      return workspaceTaskSectionResponseSchema.parse({ section });
    } catch (error: unknown) {
      return replyForSectionWriteError({
        error,
        reply,
        fallbackStatus: HTTP_BAD_REQUEST,
        fallbackMessage: MESSAGE_SECTION_COULD_NOT_BE_CREATED,
        driverMessage: MESSAGE_SECTION_COULD_NOT_BE_CREATED,
      });
    }
  });

  app.patch(
    "/workspaces/:workspaceId/task-sections/:sectionId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (user === undefined) {
        return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
      }
      const { workspaceId, sectionId } = workspaceSectionParamsSchema.parse(request.params);
      if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
        return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEMBERS_UPDATE_TASK_SECTIONS });
      }
      const parsed = upsertWorkspaceTaskSectionRequestSchema.partial().safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }
      try {
        const section = await repositories().updateWorkspaceTaskSection({
          workspaceId,
          sectionId,
          actorUserId: user.id,
          title: parsed.data.title,
          position: parsed.data.position,
        });

        return workspaceTaskSectionResponseSchema.parse({ section });
      } catch (error: unknown) {
        return replyForSectionWriteError({
          error,
          reply,
          fallbackStatus: HTTP_NOT_FOUND,
          fallbackMessage: MESSAGE_SECTION_NOT_FOUND,
          driverMessage: MESSAGE_SECTION_COULD_NOT_BE_UPDATED,
        });
      }
    },
  );

  app.delete(
    "/workspaces/:workspaceId/task-sections/:sectionId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (user === undefined) {
        return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
      }
      const { workspaceId, sectionId } = workspaceSectionParamsSchema.parse(request.params);
      if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
        return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEMBERS_DELETE_TASK_SECTIONS });
      }
      try {
        const payload = await repositories().deleteWorkspaceTaskSection({
          workspaceId,
          sectionId,
          actorUserId: user.id,
        });

        return deleteWorkspaceTaskSectionResponseSchema.parse(payload);
      } catch (error) {
        return reply.code(HTTP_BAD_REQUEST).send({
          message: error instanceof Error ? error.message : MESSAGE_SECTION_COULD_NOT_BE_DELETED,
        });
      }
    },
  );
}

async function registerWorkspaceTaskReorderAndContextRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:workspaceId/tasks/reorder", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const { workspaceId } = workspaceIdParamsSchema.parse(request.params);
    if (!(await repositories().isWorkspaceMember({ workspaceId, userId: user.id }))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ONLY_MEMBERS_REORDER_WORKSPACE_TASKS });
    }
    const parsed = reorderWorkspaceTasksRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    try {
      const payload = await repositories().reorderWorkspaceAssignedTasks({
        workspaceId,
        assigneeUserId: user.id,
        actorUserId: user.id,
        movedTaskIds: parsed.data.movedTaskIds,
        targetSectionId: parsed.data.targetSectionId,
        beforeTaskId: parsed.data.beforeTaskId,
        afterTaskId: parsed.data.afterTaskId,
      });

      return reorderWorkspaceTasksResponseSchema.parse({ tasks: payload.tasks });
    } catch (error) {
      return reply.code(HTTP_BAD_REQUEST).send({
        message: error instanceof Error ? error.message : MESSAGE_TASKS_COULD_NOT_BE_REORDERED,
      });
    }
  });

  app.get("/me/tasks/:taskId/context", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    const { taskId } = taskIdParamsSchema.parse(request.params);
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const context = await repositories().getAssignedTaskContext({
      taskId,
      userId: user.id,
    });
    if (!context) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ASSIGNED_TASK_CONTEXT_UNAVAILABLE });
    }

    return assignedTaskContextResponseSchema.parse({ context });
  });
}

export async function workspaceTaskRoutes(app: FastifyInstance): Promise<void> {
  await registerWorkspaceTaskMemberRoutes(app);
  await registerPersonalAssignedTaskRoutes(app);
  await registerWorkspaceAssignedTaskRoutes(app);
  await registerWorkspaceTaskDeleteRoutes(app);
  await registerWorkspaceTaskSectionRoutes(app);
  await registerWorkspaceTaskReorderAndContextRoutes(app);
}
