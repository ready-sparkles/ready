import { WORKSPACE_TASK_SECTION_TITLE_CONFLICT_MESSAGE } from "@readymeet/db/domain/persistence-errors";
import { workspaceTaskSectionResponseSchema } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";

import { workspaceTaskRoutes } from "../../../../../adapters/primary/http/routes/meetings/workspace-tasks";
import { signAuthToken } from "../../../../../adapters/primary/http/support/auth";
import { repositories } from "../../../../../ports/repository-runtime";

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const INDEX_NAME = "workspace_task_sections_title_uidx";
const DRIVER_SENTINEL = "Invalid `db.workspaceTaskSections.create()` invocation";
const UNIQUE_VIOLATION_CODE = "P2002";
const PRISMA_KNOWN_REQUEST_ERROR = "PrismaClientKnownRequestError";
const PRISMA_VALIDATION_ERROR = "PrismaClientValidationError";
const DRIVER_ERROR_TEXT = `${DRIVER_SENTINEL} constraint: \`${INDEX_NAME}\``;
const SECTION_CREATE_FAILURE_MESSAGE = "Section could not be created.";
const MISSING_SECTION_MESSAGE = 'Task section "missing" not found';
const PLANNING_TITLE = "Planning";
const sectionErrorSchema = z.object({ message: z.string() }).strict();
type RepositoryPort = ReturnType<typeof repositories>;
type CreateSection = RepositoryPort["createWorkspaceTaskSection"];
type UpdateSection = RepositoryPort["updateWorkspaceTaskSection"];

function section(input: { workspaceId: string; title: string }) {
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title,
    position: 1,
    isDefault: false,
    createdByUserId: randomUUID(),
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function driverError(input: { code?: string; name?: string }): Error {
  return Object.assign(new Error(DRIVER_ERROR_TEXT), {
    name: input.name ?? PRISMA_KNOWN_REQUEST_ERROR,
    ...(input.code === undefined ? {} : { code: input.code }),
  });
}

async function appFor(input: { create?: CreateSection; update?: UpdateSection }): Promise<{
  workspaceId: string;
  inject: (request: { method: "POST" | "PATCH"; url: string; payload: { title: string } }) => Promise<{
    statusCode: number;
    body: string;
  }>;
  close: () => Promise<void>;
}> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const app = Fastify({ logger: false });
  const port = repositories();
  const previous = {
    getUserAuthState: port.getUserAuthState,
    touchUserLastSeen: port.touchUserLastSeen,
    isWorkspaceMember: port.isWorkspaceMember,
    createWorkspaceTaskSection: port.createWorkspaceTaskSection,
    updateWorkspaceTaskSection: port.updateWorkspaceTaskSection,
  };
  port.getUserAuthState = async () => ({
    id: userId,
    email: "owner@example.com",
    displayName: "Owner",
    avatarUrl: null,
    source: "auth",
    plan: "free",
    agentIntroCompletedAt: null,
    sessionVersion: 1,
    activeWorkspaceId: null,
    deletedAt: null,
  });
  port.touchUserLastSeen = async () => undefined;
  port.isWorkspaceMember = async () => true;
  port.createWorkspaceTaskSection = input.create ?? (async () => section({ workspaceId, title: PLANNING_TITLE }));
  port.updateWorkspaceTaskSection = input.update ?? (async () => section({ workspaceId, title: "Renamed" }));
  await app.register(workspaceTaskRoutes);
  const token = signAuthToken({
    sub: userId,
    email: "owner@example.com",
    displayName: "Owner",
    workspaceId,
    sessionVersion: 1,
  });

  return {
    workspaceId,
    inject: (request) =>
      app.inject({
        method: request.method,
        url: request.url,
        headers: { authorization: `Bearer ${token}` },
        payload: request.payload,
      }),
    close: async () => {
      Object.assign(port, previous);
      await app.close();
    },
  };
}

async function expectSectionResponse(input: {
  create?: CreateSection;
  update?: UpdateSection;
  method: "POST" | "PATCH";
  statusCode: number;
  message?: string;
  title?: string;
}): Promise<void> {
  const fixture = await appFor({ create: input.create, update: input.update });
  try {
    const url =
      input.method === "POST"
        ? `/workspaces/${fixture.workspaceId}/task-sections`
        : `/workspaces/${fixture.workspaceId}/task-sections/${randomUUID()}`;
    const response = await fixture.inject({ method: input.method, url, payload: { title: PLANNING_TITLE } });
    assert.equal(response.statusCode, input.statusCode);
    if (input.message !== undefined) {
      assert.deepEqual(sectionErrorSchema.parse(JSON.parse(response.body)), { message: input.message });
    }
    if (input.title !== undefined) {
      assert.equal(workspaceTaskSectionResponseSchema.parse(JSON.parse(response.body)).section.title, input.title);
    }
    assert.equal(response.body.includes(INDEX_NAME), false);
    assert.equal(response.body.includes(DRIVER_SENTINEL), false);
  } finally {
    await fixture.close();
  }
}

void test("creating a task section returns the title", async () => {
  await expectSectionResponse({ method: "POST", statusCode: HTTP_OK, title: PLANNING_TITLE });
});

void test("a duplicate task section title is a conflict and hides the database index", async () => {
  const duplicate = async () => {
    throw driverError({ code: UNIQUE_VIOLATION_CODE });
  };
  await expectSectionResponse({
    create: duplicate,
    method: "POST",
    statusCode: HTTP_CONFLICT,
    message: WORKSPACE_TASK_SECTION_TITLE_CONFLICT_MESSAGE,
  });
  await expectSectionResponse({
    update: duplicate,
    method: "PATCH",
    statusCode: HTTP_CONFLICT,
    message: WORKSPACE_TASK_SECTION_TITLE_CONFLICT_MESSAGE,
  });
});

void test("other stored section failures stay generic and a missing section stays not found", async () => {
  await expectSectionResponse({
    create: async () => {
      throw driverError({ name: PRISMA_VALIDATION_ERROR });
    },
    method: "POST",
    statusCode: HTTP_BAD_REQUEST,
    message: SECTION_CREATE_FAILURE_MESSAGE,
  });
  await expectSectionResponse({
    update: async () => {
      throw new Error(MISSING_SECTION_MESSAGE);
    },
    method: "PATCH",
    statusCode: HTTP_NOT_FOUND,
    message: MISSING_SECTION_MESSAGE,
  });
});
