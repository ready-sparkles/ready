import type { WorkspaceMemberRole } from "@readymeet/shared";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { repositories } from "../../../../ports/repository-runtime";
import { forgetActiveWorkspaceResolution, requireAuth } from "../plugins/auth";

type WorkspaceMembershipContext = {
  workspaceId: string;
  role: WorkspaceMemberRole;
  status: "active" | "suspended";
};

declare module "fastify" {
  interface FastifyRequest {
    workspaceMembership?: WorkspaceMembershipContext;
  }
}

const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_FORBIDDEN_STATUS = 403;
const HTTP_NOT_FOUND_STATUS = 404;
const UNAUTHORIZED_MESSAGE = "Unauthorized";
const WORKSPACE_NOT_FOUND_MESSAGE = "Workspace not found";
const WORKSPACE_ACCESS_REQUIRED_MESSAGE = "Workspace access required";
const WORKSPACE_SUSPENDED_CODE = "workspace_suspended";
const WORKSPACE_SUSPENDED_MESSAGE = "Your access to this workspace is suspended. Contact a workspace admin.";
const WORKSPACE_MANAGER_ACCESS_REQUIRED_MESSAGE = "Workspace manager access required";
const WORKSPACE_OWNER_ACCESS_REQUIRED_MESSAGE = "Workspace owner access required";
const WORKSPACE_MEMBERSHIP_MISSING_MESSAGE = "workspace membership preHandler did not run for this route";
const workspaceRouteParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const workspaceMembershipByRequest = new WeakMap<FastifyRequest, WorkspaceMembershipContext>();

export function isWorkspaceManagerRole(role: WorkspaceMemberRole): boolean {
  return role === "owner" || role === "admin";
}

export function isWorkspaceOwnerRole(role: WorkspaceMemberRole): boolean {
  return role === "owner";
}

function readWorkspaceId(request: FastifyRequest): string | null {
  const parsed = workspaceRouteParamsSchema.safeParse(request.params);

  return parsed.success ? parsed.data.workspaceId : null;
}

async function resolveMembership(options: {
  request: FastifyRequest;
  reply: FastifyReply;
  input: { requiredRole: "member" | "manager" | "owner" };
}): Promise<FastifyReply | null> {
  const { request, reply, input } = options;
  const user = request.user;
  if (user === undefined) {
    return reply.code(HTTP_UNAUTHORIZED_STATUS).send({ message: UNAUTHORIZED_MESSAGE });
  }

  const workspaceId = readWorkspaceId(request);
  if (workspaceId === null) {
    return reply.code(HTTP_NOT_FOUND_STATUS).send({ message: WORKSPACE_NOT_FOUND_MESSAGE });
  }

  const membership = await repositories().getWorkspaceMembership({ workspaceId, userId: user.id });
  if (membership === null) {
    return reply.code(HTTP_FORBIDDEN_STATUS).send({ message: WORKSPACE_ACCESS_REQUIRED_MESSAGE });
  }
  if (membership.status === "suspended") {
    // The client re-resolves its session on this code; make sure that request
    // is not answered from a cached resolution that still names this workspace.
    forgetActiveWorkspaceResolution(user.id);

    return reply.code(HTTP_FORBIDDEN_STATUS).send({
      code: WORKSPACE_SUSPENDED_CODE,
      message: WORKSPACE_SUSPENDED_MESSAGE,
    });
  }
  if (input.requiredRole === "manager" && !isWorkspaceManagerRole(membership.role)) {
    return reply.code(HTTP_FORBIDDEN_STATUS).send({ message: WORKSPACE_MANAGER_ACCESS_REQUIRED_MESSAGE });
  }
  if (input.requiredRole === "owner" && !isWorkspaceOwnerRole(membership.role)) {
    return reply.code(HTTP_FORBIDDEN_STATUS).send({ message: WORKSPACE_OWNER_ACCESS_REQUIRED_MESSAGE });
  }

  const workspaceMembership: WorkspaceMembershipContext = {
    workspaceId,
    role: membership.role,
    status: membership.status,
  };
  workspaceMembershipByRequest.set(request, workspaceMembership);

  return null;
}

/**
 * PreHandler chain for '/workspaces/:workspaceId'-scoped admin routes:
 * full-account auth plus an active admin membership in that workspace.
 */
export const requireWorkspaceManager: preHandlerHookHandler[] = [
  requireAuth,
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await resolveMembership({ request, reply, input: { requiredRole: "manager" } });
  },
];

/** Backwards-compatible name for meeting routes where Owner is also an Admin. */

export const requireWorkspaceOwner: preHandlerHookHandler[] = [
  requireAuth,
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await resolveMembership({ request, reply, input: { requiredRole: "owner" } });
  },
];

/** Active member (any role) of the ':workspaceId' route param's workspace. */
export const requireActiveWorkspaceMember: preHandlerHookHandler[] = [
  requireAuth,
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await resolveMembership({ request, reply, input: { requiredRole: "member" } });
  },
];

export function getWorkspaceMembershipContext(request: FastifyRequest): WorkspaceMembershipContext {
  const membership = workspaceMembershipByRequest.get(request);
  if (membership === undefined) {
    throw new Error(WORKSPACE_MEMBERSHIP_MISSING_MESSAGE);
  }

  return membership;
}

/**
 * Whether the user may change a meeting's confidentiality: the organizer may
 * always (during and after the meeting); a participating workspace admin may
 * only while the meeting has not ended. Workspace admins who are not
 * participants never may — confidentiality has no admin bypass.
 */
export function canChangeMeetingConfidentiality(input: {
  meeting: { createdByUserId: string | null; status: string; workspaceId: string };
  userId: string;
  isParticipant: boolean;
  isWorkspaceAdmin: boolean;
}): boolean {
  if (input.meeting.createdByUserId === input.userId) {
    return true;
  }

  return input.meeting.status !== "ended" && input.isParticipant && input.isWorkspaceAdmin;
}
