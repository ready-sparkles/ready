import { WorkspaceAdminError } from "@readymeet/db/domain/persistence-errors";
import {
  acceptWorkspaceInvitationResponseSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  deleteWorkspaceRequestSchema,
  deleteWorkspaceResponseSchema,
  inviteWorkspaceMembersRequestSchema,
  inviteWorkspaceMembersResponseSchema,
  myWorkspaceResponseSchema,
  removeWorkspaceMemberResponseSchema,
  restoreWorkspaceMemberRequestSchema,
  revokeWorkspaceInvitationResponseSchema,
  setActiveWorkspaceRequestSchema,
  transferWorkspaceOwnershipRequestSchema,
  updateWorkspaceMemberRequestSchema,
  updateWorkspaceSettingsRequestSchema,
  workspaceInvitationActionResponseSchema,
  workspaceInvitationPublicInfoResponseSchema,
  workspaceLogoUploadRequestSchema,
  workspaceMemberActionResponseSchema,
  workspaceMembersResponseSchemaV2,
  workspaceSettingsResponseSchema,
} from "@readymeet/shared";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { isResendConfigured, ResendError, sendResendEmail } from "../../../../application/resend-client";
import { apiEnv } from "../../../../composition/env";
import { buildWorkspaceInviteEmail } from "../../../../domain/workspace-invite-email";
import { validateWorkspaceLogoDataUrl } from "../../../../domain/workspace-logo";
import { isStripeConfigured } from "../../../../ports/gate-stripe-billing";
import { syncWorkspaceSeatQuantity } from "../../../../ports/gate-workspace-stripe-billing";
import { repositories } from "../../../../ports/repository-runtime";
import { requireAuth } from "../plugins/auth";
import {
  getWorkspaceMembershipContext,
  requireActiveWorkspaceMember,
  requireWorkspaceManager,
  requireWorkspaceOwner,
} from "../support/workspace-access";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GONE = 410;
const INVITATION_TOKEN_RANDOM_BYTES = 32;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const RATE_LIMIT_WORKSPACES_CREATE_MAX = 10;
const RATE_LIMIT_INVITATIONS_PUBLIC_GET_MAX = 30;
const RATE_LIMIT_INVITATIONS_ACCEPT_MAX = 20;
const CODE_INVALID_WORKSPACE_NAME = "invalid_workspace_name";
const CODE_WORKSPACE_SUBSCRIPTION_ACTIVE = "workspace_subscription_active";
const MESSAGE_A_WORKSPACE_NAME_IS_REQUIRED_MAX_255_CHARACTERS = "A workspace name is required (max 255 characters).";
const MESSAGE_WORKSPACE_NOT_FOUND = "Workspace not found";
const MESSAGE_WORKSPACE_NAME_IS_REQUIRED_MAX_255_CHARACTERS = "Workspace name is required (max 255 characters).";
const MESSAGE_A_LOGO_IMAGE_IS_REQUIRED = "A logo image is required.";
const MESSAGE_WORKSPACE_NAME_CONFIRMATION_IS_REQUIRED = "Workspace name confirmation is required.";
const MESSAGE_CONFIRMATION_NAME_DOES_NOT_MATCH_THIS_WORKSPACE = "Confirmation name does not match this workspace.";
const MESSAGE_A_VALID_ROLE_IS_REQUIRED = "A valid role is required.";
const MESSAGE_MEMBER_NOT_FOUND = "Member not found";
const MESSAGE_CHOOSE_AN_ACTIVE_MEMBER_TO_BECOME_THE_WORKSPACE_OWNER =
  "Choose an active member to become the workspace owner.";
const MESSAGE_AT_LEAST_ONE_EMAIL_ADDRESS_AND_A_ROLE_ARE_REQUIRED =
  "At least one email address and a role are required.";
const MESSAGE_INVITATION_IS_NO_LONGER_OPEN = "Invitation is no longer open.";
const MESSAGE_EMAIL_SENDING_IS_NOT_CONFIGURED_CONTACT_YOUR_READY_ADMINISTRATOR =
  "Email sending is not configured. Contact your Ready administrator.";
const MESSAGE_THE_INVITATION_EMAIL_COULD_NOT_BE_SENT_TRY_AGAIN = "The invitation email could not be sent. Try again.";
const MESSAGE_THIS_INVITATION_LINK_IS_NOT_VALID = "This invitation link is not valid.";
const MESSAGE_A_WORKSPACE_ID_IS_REQUIRED = "A workspace id is required.";
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_WORKSPACE_INVITATIONS_CANNOT_GRANT_THE_OWNER_ROLE = "Workspace invitations cannot grant the Owner role.";
const MESSAGE_CANCEL_THIS_WORKSPACE_PLAN_IN_BILLING_BEFORE_DELETING_THE_WORKSPACE =
  "Cancel this workspace's plan in Billing before deleting the workspace.";

const emailSchema = z.string().trim().toLowerCase().email();

const workspaceMemberTargetParamsSchema = z.object({
  workspaceId: z.string(),
  targetUserId: z.string(),
});

const workspaceInvitationParamsSchema = z.object({
  workspaceId: z.string(),
  invitationId: z.string(),
});

const invitationTokenParamsSchema = z.object({
  token: z.string(),
});

function newInvitationToken() {
  const token = randomBytes(INVITATION_TOKEN_RANDOM_BYTES).toString("base64url");

  return { token, tokenHash: hashInvitationToken(token) };
}

function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function invitationExpiry() {
  return new Date(
    Date.now() +
      apiEnv.WORKSPACE_INVITE_EXPIRY_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
  );
}

function invitationAcceptUrl(token: string) {
  return `${apiEnv.NEXT_PUBLIC_WEB_URL}/invite/${token}`;
}

function assignableInvitationRole(role: "owner" | "admin" | "member"): "admin" | "member" {
  if (role === "owner") {
    throw new Error(MESSAGE_WORKSPACE_INVITATIONS_CANNOT_GRANT_THE_OWNER_ROLE);
  }

  return role;
}

function toInvitationDTO(invitation: {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  expiresAt: Date;
  createdAt: Date;
  invitedByName?: string | null;
}) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: assignableInvitationRole(invitation.role),
    state: invitation.expiresAt.getTime() <= Date.now() ? ("expired" as const) : ("pending" as const),
    invitedByName: invitation.invitedByName ?? null,
    invitedAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

function toMemberDTO(input: {
  member: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    role: "owner" | "admin" | "member";
    status: "active" | "suspended";
    joinedAt: Date;
    lastSeenAt: Date | null;
  };
  viewerUserId: string;
}) {
  const member = input.member;

  return {
    userId: member.userId,
    email: member.email,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt.toISOString(),
    lastSeenAt: member.lastSeenAt ? member.lastSeenAt.toISOString() : null,
    isSelf: member.userId === input.viewerUserId,
  };
}

function sendWorkspaceAdminError(input: { reply: FastifyReply; error: unknown }) {
  const error = input.error;
  if (error instanceof WorkspaceAdminError) {
    const status =
      error.code === "membership_not_found" || error.code === "invitation_not_found"
        ? HTTP_NOT_FOUND
        : error.code === "workspace_manager_required" ||
            error.code === "workspace_owner_required" ||
            error.code === "owner_protected" ||
            error.code === "self_action_not_allowed"
          ? HTTP_FORBIDDEN
          : HTTP_CONFLICT;

    return input.reply.code(status).send({ code: error.code, message: error.message });
  }
  throw error;
}

async function sendInvitationEmail(input: {
  token: string;
  email: string;
  role: "admin" | "member";
  inviterName: string;
  workspaceName: string;
  expiresAt: Date;
}) {
  const message = buildWorkspaceInviteEmail({
    inviterName: input.inviterName,
    workspaceName: input.workspaceName,
    role: input.role,
    acceptUrl: invitationAcceptUrl(input.token),
    expiresAt: input.expiresAt,
  });

  return sendResendEmail({
    to: input.email,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}

function readAuthenticatedUser(request: FastifyRequest) {
  const user = request.user;
  if (!user) {
    throw new Error(MESSAGE_UNAUTHORIZED);
  }

  return user;
}

async function captureAction<T>(action: () => Promise<T>): Promise<{ value: T } | { failure: unknown }> {
  try {
    return { value: await action() };
  } catch (error) {
    return { failure: error };
  }
}

type WorkspaceInviteFailure = {
  email: string;
  reason: "invalid_email" | "already_member" | "already_invited" | "send_failed";
};

async function revokeFailedInvitation(input: {
  workspaceId: string;
  invitationId: string;
  email: string;
  log: FastifyBaseLogger;
}) {
  try {
    await repositories().revokeWorkspaceInvitation({
      workspaceId: input.workspaceId,
      invitationId: input.invitationId,
    });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    input.log.error({ err: error, email: input.email }, "workspace invitation revoke failed after send failure");
  }
}

async function inviteWorkspaceEmail(input: {
  rawEmail: string;
  seen: ReadonlySet<string>;
  workspaceId: string;
  workspaceName: string;
  role: "admin" | "member";
  actor: { id: string; displayName: string };
  log: FastifyBaseLogger;
}): Promise<
  | { status: "skip"; seen: ReadonlySet<string> }
  | { status: "failure"; seen: ReadonlySet<string>; failure: WorkspaceInviteFailure }
  | { status: "invited"; seen: ReadonlySet<string>; invitation: ReturnType<typeof toInvitationDTO> }
> {
  const parsed = emailSchema.safeParse(input.rawEmail);
  if (!parsed.success) {
    return {
      status: "failure",
      seen: input.seen,
      failure: { email: input.rawEmail, reason: "invalid_email" },
    };
  }
  const email = parsed.data;
  if (input.seen.has(email)) {
    return { status: "skip", seen: input.seen };
  }
  const seen = new Set(input.seen);
  seen.add(email);
  const { token, tokenHash } = newInvitationToken();
  const expiresAt = invitationExpiry();
  const created = await captureAction(() =>
    repositories().createWorkspaceInvitation({
      workspaceId: input.workspaceId,
      email,
      role: input.role,
      invitedByUserId: input.actor.id,
      tokenHash,
      expiresAt,
    }),
  );
  if ("failure" in created) {
    if (!(created.failure instanceof WorkspaceAdminError)) {
      throw created.failure;
    }

    return {
      status: "failure",
      seen,
      failure: {
        email,
        reason: created.failure.code === "already_member" ? "already_member" : "already_invited",
      },
    };
  }

  try {
    await sendInvitationEmail({
      token,
      email,
      role: input.role,
      inviterName: input.actor.displayName,
      workspaceName: input.workspaceName,
      expiresAt,
    });
  } catch (error) {
    if (!(error instanceof ResendError)) {
      throw error;
    }
    input.log.error({ err: error, email }, "workspace invitation email failed");
    await revokeFailedInvitation({
      workspaceId: input.workspaceId,
      invitationId: created.value.id,
      email,
      log: input.log,
    });

    return { status: "failure", seen, failure: { email, reason: "send_failed" } };
  }

  await repositories().recordWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    actorUserId: input.actor.id,
    eventType: "invitation.created",
    subjectType: "invitation",
    subjectId: created.value.id,
    metadata: { email, role: input.role },
  });

  return {
    status: "invited",
    seen,
    invitation: toInvitationDTO({ ...created.value, invitedByName: input.actor.displayName }),
  };
}

function registerWorkspaceCreateRoute(app: FastifyInstance): void {
  // Any signed-in (non-guest) user may create workspaces; the DB layer
  // enforces the per-user creation cap and re-checks the guest guard.
  app.post(
    "/workspaces",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: RATE_LIMIT_WORKSPACES_CREATE_MAX, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = readAuthenticatedUser(request);
      const body = createWorkspaceRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(HTTP_BAD_REQUEST).send({
          code: CODE_INVALID_WORKSPACE_NAME,
          message: MESSAGE_A_WORKSPACE_NAME_IS_REQUIRED_MAX_255_CHARACTERS,
        });
      }

      const created = await captureAction(() =>
        repositories().createWorkspaceForUser({
          userId: user.id,
          name: body.data.name,
          maxWorkspacesPerUser: apiEnv.WORKSPACE_MAX_PER_USER,
        }),
      );
      if ("failure" in created) {
        if (!(created.failure instanceof WorkspaceAdminError)) {
          throw created.failure;
        }
        const status = created.failure.code === CODE_INVALID_WORKSPACE_NAME ? HTTP_BAD_REQUEST : HTTP_FORBIDDEN;

        return reply.code(status).send({ code: created.failure.code, message: created.failure.message });
      }
      const workspace = created.value;

      await repositories().recordWorkspaceAuditEvent({
        workspaceId: workspace.id,
        actorUserId: user.id,
        eventType: "workspace.created",
        subjectType: "workspace",
        subjectId: workspace.id,
        metadata: { name: workspace.name },
      });

      return createWorkspaceResponseSchema.parse({
        workspace: { id: workspace.id, name: workspace.name, role: "owner" },
      });
    },
  );
}

function registerWorkspaceSettingsRoutes(app: FastifyInstance): void {
  // Any active member may read basic workspace identity (name + logo).
  app.get("/workspaces/:workspaceId/settings", { preHandler: requireActiveWorkspaceMember }, async (request, reply) => {
    const membership = getWorkspaceMembershipContext(request);
    const workspace = await repositories().getWorkspaceById(membership.workspaceId);
    if (!workspace) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
    }

    return workspaceSettingsResponseSchema.parse({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        logoUrl: workspace.logoUrl ?? null,
        isLiveSummaryEnabled: workspace.isLiveSummaryEnabled,
        isAmbientContextEnabled: workspace.isAmbientContextEnabled,
        viewerRole: membership.role,
        createdAt: workspace.createdAt.toISOString(),
      },
    });
  });

  app.patch("/workspaces/:workspaceId/settings", { preHandler: requireWorkspaceManager }, async (request, reply) => {
    const membership = getWorkspaceMembershipContext(request);
    const body = updateWorkspaceSettingsRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_WORKSPACE_NAME_IS_REQUIRED_MAX_255_CHARACTERS });
    }

    const currentWorkspace = await repositories().getWorkspaceById(membership.workspaceId);
    if (!currentWorkspace) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
    }
    if (
      (body.data.name === undefined || currentWorkspace.name === body.data.name) &&
      (body.data.isLiveSummaryEnabled === undefined ||
        currentWorkspace.isLiveSummaryEnabled === body.data.isLiveSummaryEnabled) &&
      (body.data.isAmbientContextEnabled === undefined ||
        currentWorkspace.isAmbientContextEnabled === body.data.isAmbientContextEnabled)
    ) {
      return workspaceSettingsResponseSchema.parse({
        workspace: {
          id: currentWorkspace.id,
          name: currentWorkspace.name,
          logoUrl: currentWorkspace.logoUrl ?? null,
          isLiveSummaryEnabled: currentWorkspace.isLiveSummaryEnabled,
          isAmbientContextEnabled: currentWorkspace.isAmbientContextEnabled,
          viewerRole: membership.role,
          createdAt: currentWorkspace.createdAt.toISOString(),
        },
      });
    }

    const workspace = await repositories().updateWorkspaceSettings({
      workspaceId: membership.workspaceId,
      ...body.data,
    });
    if (!workspace) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
    }
    await repositories().recordWorkspaceAuditEvent({
      workspaceId: membership.workspaceId,
      actorUserId: readAuthenticatedUser(request).id,
      eventType: body.data.name === undefined ? "workspace.intelligence.updated" : "workspace.name.updated",
      subjectType: "workspace",
      subjectId: membership.workspaceId,
      metadata: { ...body.data },
    });

    return workspaceSettingsResponseSchema.parse({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        logoUrl: workspace.logoUrl ?? null,
        isLiveSummaryEnabled: workspace.isLiveSummaryEnabled,
        isAmbientContextEnabled: workspace.isAmbientContextEnabled,
        viewerRole: membership.role,
        createdAt: workspace.createdAt.toISOString(),
      },
    });
  });
}

function registerWorkspaceLogoRoutes(app: FastifyInstance): void {
  app.put("/workspaces/:workspaceId/logo", { preHandler: requireWorkspaceManager }, async (request, reply) => {
    const membership = getWorkspaceMembershipContext(request);
    const body = workspaceLogoUploadRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_A_LOGO_IMAGE_IS_REQUIRED });
    }

    const validation = validateWorkspaceLogoDataUrl(body.data.dataUrl);
    if (!validation.ok) {
      const message =
        validation.reason === "too_large"
          ? "Logo must be 1 MB or smaller."
          : validation.reason === "unsupported_type"
            ? "Logo must be a PNG, JPEG, WebP, or GIF image."
            : "Logo upload was not a valid image.";

      return reply.code(HTTP_BAD_REQUEST).send({ code: validation.reason, message });
    }

    const workspace = await repositories().setWorkspaceLogo({
      workspaceId: membership.workspaceId,
      logoUrl: validation.dataUrl,
    });
    if (!workspace) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
    }
    await repositories().recordWorkspaceAuditEvent({
      workspaceId: membership.workspaceId,
      actorUserId: readAuthenticatedUser(request).id,
      eventType: "workspace.logo.updated",
      subjectType: "workspace",
      subjectId: membership.workspaceId,
      metadata: { mimeType: validation.mimeType, bytes: validation.bytes },
    });

    return workspaceSettingsResponseSchema.parse({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        logoUrl: workspace.logoUrl ?? null,
        isLiveSummaryEnabled: workspace.isLiveSummaryEnabled,
        isAmbientContextEnabled: workspace.isAmbientContextEnabled,
        viewerRole: membership.role,
        createdAt: workspace.createdAt.toISOString(),
      },
    });
  });

  app.delete("/workspaces/:workspaceId/logo", { preHandler: requireWorkspaceManager }, async (request, reply) => {
    const membership = getWorkspaceMembershipContext(request);
    const workspace = await repositories().setWorkspaceLogo({ workspaceId: membership.workspaceId, logoUrl: null });
    if (!workspace) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
    }
    await repositories().recordWorkspaceAuditEvent({
      workspaceId: membership.workspaceId,
      actorUserId: readAuthenticatedUser(request).id,
      eventType: "workspace.logo.removed",
      subjectType: "workspace",
      subjectId: membership.workspaceId,
    });

    return workspaceSettingsResponseSchema.parse({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        logoUrl: null,
        isLiveSummaryEnabled: workspace.isLiveSummaryEnabled,
        isAmbientContextEnabled: workspace.isAmbientContextEnabled,
        viewerRole: membership.role,
        createdAt: workspace.createdAt.toISOString(),
      },
    });
  });
}

function registerWorkspaceDeleteRoute(app: FastifyInstance): void {
  app.delete("/workspaces/:workspaceId", { preHandler: requireWorkspaceOwner }, async (request, reply) => {
    const membership = getWorkspaceMembershipContext(request);
    const user = readAuthenticatedUser(request);
    const body = deleteWorkspaceRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_WORKSPACE_NAME_CONFIRMATION_IS_REQUIRED });
    }

    const workspace = await repositories().getWorkspaceById(membership.workspaceId);
    if (!workspace) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
    }
    if (body.data.confirmationName !== workspace.name) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CONFIRMATION_NAME_DOES_NOT_MATCH_THIS_WORKSPACE });
    }
    const runningSubscription = await repositories().getRunningBillingSubscriptionForWorkspace({
      workspaceId: workspace.id,
    });
    if (runningSubscription) {
      return sendWorkspaceAdminError({
        reply,
        error: new WorkspaceAdminError({
          code: CODE_WORKSPACE_SUBSCRIPTION_ACTIVE,
          message: MESSAGE_CANCEL_THIS_WORKSPACE_PLAN_IN_BILLING_BEFORE_DELETING_THE_WORKSPACE,
        }),
      });
    }

    const deletion = await repositories().createDataDeletionRequest({
      userId: user.id,
      targetKind: "workspace",
      targetAccountId: workspace.id,
    });

    const deletedResult = await captureAction(() =>
      repositories().deleteWorkspaceForAdmin({
        workspaceId: workspace.id,
        actorUserId: user.id,
      }),
    );
    if ("failure" in deletedResult) {
      try {
        await repositories().updateDataDeletionRequest({
          id: deletion.id,
          status: "failed",
          error: {
            message:
              deletedResult.failure instanceof Error ? deletedResult.failure.message : "Workspace deletion failed",
          },
        });
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        request.log.error({ err: error }, "Failed to record workspace deletion failure");
      }

      return sendWorkspaceAdminError({ reply, error: deletedResult.failure });
    }
    const deleted = deletedResult.value;

    await repositories().updateDataDeletionRequest({
      id: deletion.id,
      status: "completed",
      completedAt: new Date(),
      providerRevocationStatus: {
        workspaceId: deleted.workspace.id,
        workspaceName: deleted.workspace.name,
      },
    });

    return deleteWorkspaceResponseSchema.parse({
      /** @external delete workspace ok wire field */
      ok: true,
      deletionId: deletion.id,
      activeWorkspaceId: deleted.activeWorkspaceId,
    });
  });
}

function registerWorkspaceMembersListRoute(app: FastifyInstance): void {
  app.get(
    "/workspaces/:workspaceId/settings/members",
    { preHandler: requireActiveWorkspaceMember },
    async (request) => {
      const membership = getWorkspaceMembershipContext(request);
      const canManageMembers = membership.role === "owner" || membership.role === "admin";
      const [members, invitations] = await Promise.all([
        repositories().listWorkspaceMembersAdmin(membership.workspaceId),
        canManageMembers ? repositories().listOpenWorkspaceInvitations(membership.workspaceId) : Promise.resolve([]),
      ]);

      return workspaceMembersResponseSchemaV2.parse({
        viewerRole: membership.role,
        capabilities: {
          canManageMembers,
          canInviteMembers: canManageMembers,
          canTransferOwnership: membership.role === "owner",
          canManageBilling: membership.role === "owner",
          canDeleteWorkspace: membership.role === "owner",
        },
        members: members.map((member) => toMemberDTO({ member, viewerUserId: readAuthenticatedUser(request).id })),
        invitations: invitations.map(toInvitationDTO),
      });
    },
  );
}

function registerWorkspaceMemberRoleRoutes(app: FastifyInstance): void {
  app.patch(
    "/workspaces/:workspaceId/members/:targetUserId",
    { preHandler: requireWorkspaceManager },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const parsedParams = workspaceMemberTargetParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const { targetUserId } = parsedParams.data;
      const body = updateWorkspaceMemberRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_A_VALID_ROLE_IS_REQUIRED });
      }

      try {
        await repositories().updateWorkspaceMemberRole({
          workspaceId: membership.workspaceId,
          actorUserId: readAuthenticatedUser(request).id,
          targetUserId,
          role: body.data.role,
        });
      } catch (error) {
        return sendWorkspaceAdminError({ reply, error });
      }
      await repositories().recordWorkspaceAuditEvent({
        workspaceId: membership.workspaceId,
        actorUserId: readAuthenticatedUser(request).id,
        eventType: "member.role.changed",
        subjectType: "user",
        subjectId: targetUserId,
        metadata: { role: body.data.role },
      });

      const member = await repositories().getWorkspaceMemberAdmin({
        workspaceId: membership.workspaceId,
        userId: targetUserId,
      });
      if (!member) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMBER_NOT_FOUND });
      }
      await syncWorkspaceSeatsInRequest({ workspaceId: membership.workspaceId, log: request.log });

      return workspaceMemberActionResponseSchema.parse({
        member: toMemberDTO({ member, viewerUserId: readAuthenticatedUser(request).id }),
      });
    },
  );

  app.post(
    "/workspaces/:workspaceId/ownership/transfer",
    { preHandler: requireWorkspaceOwner },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const body = transferWorkspaceOwnershipRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .code(HTTP_BAD_REQUEST)
          .send({ message: MESSAGE_CHOOSE_AN_ACTIVE_MEMBER_TO_BECOME_THE_WORKSPACE_OWNER });
      }

      try {
        await repositories().transferWorkspaceOwnership({
          workspaceId: membership.workspaceId,
          actorUserId: readAuthenticatedUser(request).id,
          targetUserId: body.data.targetUserId,
        });
      } catch (error) {
        return sendWorkspaceAdminError({ reply, error });
      }

      const member = await repositories().getWorkspaceMemberAdmin({
        workspaceId: membership.workspaceId,
        userId: body.data.targetUserId,
      });
      if (!member) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMBER_NOT_FOUND });
      }
      await syncWorkspaceSeatsInRequest({ workspaceId: membership.workspaceId, log: request.log });

      return workspaceMemberActionResponseSchema.parse({
        member: toMemberDTO({ member, viewerUserId: readAuthenticatedUser(request).id }),
      });
    },
  );
}

async function syncWorkspaceSeatsInRequest(input: { workspaceId: string; log: FastifyBaseLogger }): Promise<void> {
  if (!isStripeConfigured()) {
    return;
  }
  await syncWorkspaceSeatQuantity({ workspaceId: input.workspaceId, log: input.log });
}

function registerWorkspaceMemberStatusRoutes(app: FastifyInstance): void {
  app.post(
    "/workspaces/:workspaceId/members/:targetUserId/suspend",
    { preHandler: requireWorkspaceManager },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const parsedParams = workspaceMemberTargetParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const { targetUserId } = parsedParams.data;

      try {
        await repositories().suspendWorkspaceMember({
          workspaceId: membership.workspaceId,
          actorUserId: readAuthenticatedUser(request).id,
          targetUserId,
        });
      } catch (error) {
        return sendWorkspaceAdminError({ reply, error });
      }
      await repositories().recordWorkspaceAuditEvent({
        workspaceId: membership.workspaceId,
        actorUserId: readAuthenticatedUser(request).id,
        eventType: "member.suspended",
        subjectType: "user",
        subjectId: targetUserId,
      });
      await syncWorkspaceSeatsInRequest({ workspaceId: membership.workspaceId, log: request.log });

      const member = await repositories().getWorkspaceMemberAdmin({
        workspaceId: membership.workspaceId,
        userId: targetUserId,
      });
      if (!member) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMBER_NOT_FOUND });
      }

      return workspaceMemberActionResponseSchema.parse({
        member: toMemberDTO({ member, viewerUserId: readAuthenticatedUser(request).id }),
      });
    },
  );

  app.post(
    "/workspaces/:workspaceId/members/:targetUserId/restore",
    { preHandler: requireWorkspaceManager },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const parsedParams = workspaceMemberTargetParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const { targetUserId } = parsedParams.data;
      const body = restoreWorkspaceMemberRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_A_VALID_ROLE_IS_REQUIRED });
      }

      try {
        await repositories().restoreWorkspaceMember({
          workspaceId: membership.workspaceId,
          actorUserId: readAuthenticatedUser(request).id,
          targetUserId,
          role: body.data.role,
        });
      } catch (error) {
        return sendWorkspaceAdminError({ reply, error });
      }
      await repositories().recordWorkspaceAuditEvent({
        workspaceId: membership.workspaceId,
        actorUserId: readAuthenticatedUser(request).id,
        eventType: "member.restored",
        subjectType: "user",
        subjectId: targetUserId,
        metadata: { role: body.data.role },
      });
      await syncWorkspaceSeatsInRequest({ workspaceId: membership.workspaceId, log: request.log });

      const member = await repositories().getWorkspaceMemberAdmin({
        workspaceId: membership.workspaceId,
        userId: targetUserId,
      });
      if (!member) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEMBER_NOT_FOUND });
      }

      return workspaceMemberActionResponseSchema.parse({
        member: toMemberDTO({ member, viewerUserId: readAuthenticatedUser(request).id }),
      });
    },
  );
}

function registerWorkspaceMemberRemoveRoute(app: FastifyInstance): void {
  app.delete(
    "/workspaces/:workspaceId/members/:targetUserId",
    { preHandler: requireWorkspaceManager },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const parsedParams = workspaceMemberTargetParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const { targetUserId } = parsedParams.data;

      try {
        await repositories().removeWorkspaceMember({
          workspaceId: membership.workspaceId,
          actorUserId: readAuthenticatedUser(request).id,
          targetUserId,
        });
      } catch (error) {
        return sendWorkspaceAdminError({ reply, error });
      }
      await repositories().recordWorkspaceAuditEvent({
        workspaceId: membership.workspaceId,
        actorUserId: readAuthenticatedUser(request).id,
        eventType: "member.removed",
        subjectType: "user",
        subjectId: targetUserId,
      });
      await syncWorkspaceSeatsInRequest({ workspaceId: membership.workspaceId, log: request.log });

      return removeWorkspaceMemberResponseSchema.parse({
        /** @external remove workspace member removed wire field */
        removed: true,
      });
    },
  );
}

function registerWorkspaceInviteBatchRoute(app: FastifyInstance): void {
  app.post("/workspaces/:workspaceId/invitations", { preHandler: requireWorkspaceManager }, async (request, reply) => {
    const membership = getWorkspaceMembershipContext(request);
    const body = inviteWorkspaceMembersRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_AT_LEAST_ONE_EMAIL_ADDRESS_AND_A_ROLE_ARE_REQUIRED });
    }

    const workspace = await repositories().getWorkspaceById(membership.workspaceId);
    if (!workspace) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
    }

    // Never fail silently: without a Resend key the emailed link can never be
    // recovered (only the token hash is stored), so production refuses the
    // request outright; dev proceeds link-less by design for local testing.
    if (!isResendConfigured()) {
      if (apiEnv.NODE_ENV === "production") {
        request.log.error("RESEND_API_KEY is not configured; refusing to create invitations that cannot be emailed.");

        return inviteWorkspaceMembersResponseSchema.parse({
          invitations: [],
          failures: body.data.emails.map((email) => ({ email, reason: "send_failed" as const })),
        });
      }
      request.log.warn("RESEND_API_KEY is not configured; invitation emails are skipped in this environment.");
    }

    const actor = readAuthenticatedUser(request);
    const emptyInviteBatch: {
      invitations: ReturnType<typeof toInvitationDTO>[];
      failures: WorkspaceInviteFailure[];
      seen: ReadonlySet<string>;
    } = { invitations: [], failures: [], seen: new Set<string>() };
    const invited = await body.data.emails.reduce<Promise<typeof emptyInviteBatch>>(async (previous, rawEmail) => {
      const state = await previous;
      const outcome = await inviteWorkspaceEmail({
        rawEmail,
        seen: state.seen,
        workspaceId: membership.workspaceId,
        workspaceName: workspace.name,
        role: body.data.role,
        actor,
        log: request.log,
      });
      if (outcome.status === "invited") {
        return {
          invitations: [...state.invitations, outcome.invitation],
          failures: state.failures,
          seen: outcome.seen,
        };
      }
      if (outcome.status === "failure") {
        return {
          invitations: state.invitations,
          failures: [...state.failures, outcome.failure],
          seen: outcome.seen,
        };
      }

      return { invitations: state.invitations, failures: state.failures, seen: outcome.seen };
    }, Promise.resolve(emptyInviteBatch));

    return inviteWorkspaceMembersResponseSchema.parse({
      invitations: invited.invitations,
      failures: invited.failures,
    });
  });
}

function registerWorkspaceInvitationResendRoute(app: FastifyInstance): void {
  app.post(
    "/workspaces/:workspaceId/invitations/:invitationId/resend",
    { preHandler: requireWorkspaceManager },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const parsedParams = workspaceInvitationParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const { invitationId } = parsedParams.data;

      const existing = await repositories().getWorkspaceInvitationById({
        workspaceId: membership.workspaceId,
        invitationId,
      });
      if (!existing || existing.acceptedAt || existing.revokedAt) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_INVITATION_IS_NO_LONGER_OPEN });
      }

      if (!isResendConfigured() && apiEnv.NODE_ENV === "production") {
        request.log.error("RESEND_API_KEY is not configured; cannot resend workspace invitations.");

        return reply
          .code(HTTP_BAD_GATEWAY)
          .send({ message: MESSAGE_EMAIL_SENDING_IS_NOT_CONFIGURED_CONTACT_YOUR_READY_ADMINISTRATOR });
      }

      const workspace = await repositories().getWorkspaceById(membership.workspaceId);
      if (!workspace) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
      }

      // Rotate the token and extend the expiry so the newest email always wins.
      const { token, tokenHash } = newInvitationToken();
      const expiresAt = invitationExpiry();
      const resent = await captureAction(() =>
        repositories().markWorkspaceInvitationResent({
          workspaceId: membership.workspaceId,
          invitationId,
          tokenHash,
          expiresAt,
        }),
      );
      if ("failure" in resent) {
        return sendWorkspaceAdminError({ reply, error: resent.failure });
      }
      const invitation = resent.value;

      try {
        await sendInvitationEmail({
          token,
          email: invitation.email,
          role: assignableInvitationRole(invitation.role),
          inviterName: readAuthenticatedUser(request).displayName,
          workspaceName: workspace.name,
          expiresAt,
        });
      } catch (error) {
        if (error instanceof ResendError) {
          request.log.error({ err: error, email: invitation.email }, "workspace invitation resend failed");

          return reply
            .code(HTTP_BAD_GATEWAY)
            .send({ message: MESSAGE_THE_INVITATION_EMAIL_COULD_NOT_BE_SENT_TRY_AGAIN });
        }
        throw error;
      }

      await repositories().recordWorkspaceAuditEvent({
        workspaceId: membership.workspaceId,
        actorUserId: readAuthenticatedUser(request).id,
        eventType: "invitation.resent",
        subjectType: "invitation",
        subjectId: invitation.id,
        metadata: { email: invitation.email },
      });

      return workspaceInvitationActionResponseSchema.parse({
        invitation: toInvitationDTO({ ...invitation, invitedByName: readAuthenticatedUser(request).displayName }),
      });
    },
  );
}

function registerWorkspaceInvitationRevokeRoute(app: FastifyInstance): void {
  app.delete(
    "/workspaces/:workspaceId/invitations/:invitationId",
    { preHandler: requireWorkspaceManager },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const parsedParams = workspaceInvitationParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const { invitationId } = parsedParams.data;

      const revoked = await captureAction(() =>
        repositories().revokeWorkspaceInvitation({
          workspaceId: membership.workspaceId,
          invitationId,
        }),
      );
      if ("failure" in revoked) {
        return sendWorkspaceAdminError({ reply, error: revoked.failure });
      }
      const invitation = revoked.value;
      await repositories().recordWorkspaceAuditEvent({
        workspaceId: membership.workspaceId,
        actorUserId: readAuthenticatedUser(request).id,
        eventType: "invitation.revoked",
        subjectType: "invitation",
        subjectId: invitation.id,
        metadata: { email: invitation.email },
      });

      return revokeWorkspaceInvitationResponseSchema.parse({
        /** @external revoke workspace invitation revoked wire field */
        revoked: true,
      });
    },
  );
}

function registerPublicInvitationRoutes(app: FastifyInstance): void {
  // Public: the accept page needs invitation context before sign-in.
  app.get(
    "/invitations/:token",
    {
      config: { rateLimit: { max: RATE_LIMIT_INVITATIONS_PUBLIC_GET_MAX, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsedParams = invitationTokenParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const { token } = parsedParams.data;
      const row = await repositories().getWorkspaceInvitationByTokenHash(hashInvitationToken(token));
      if (!row) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_THIS_INVITATION_LINK_IS_NOT_VALID });
      }

      return workspaceInvitationPublicInfoResponseSchema.parse({
        invitation: {
          workspaceName: row.workspaceName,
          workspaceLogoUrl: row.workspaceLogoUrl ?? null,
          inviterName: row.inviterName ?? null,
          email: row.invitation.email,
          role: row.invitation.role,
          state: repositories().workspaceInvitationState(row.invitation),
          expiresAt: row.invitation.expiresAt.toISOString(),
        },
      });
    },
  );

  app.post(
    "/invitations/:token/accept",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: RATE_LIMIT_INVITATIONS_ACCEPT_MAX, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsedParams = invitationTokenParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const { token } = parsedParams.data;
      const user = readAuthenticatedUser(request);

      const acceptedResult = await captureAction(() =>
        repositories().acceptWorkspaceInvitation({
          tokenHash: hashInvitationToken(token),
          userId: user.id,
          userEmail: user.email,
        }),
      );
      if ("failure" in acceptedResult) {
        if (!(acceptedResult.failure instanceof WorkspaceAdminError)) {
          throw acceptedResult.failure;
        }
        const status =
          acceptedResult.failure.code === "invitation_not_found"
            ? HTTP_NOT_FOUND
            : acceptedResult.failure.code === "invitation_email_mismatch"
              ? HTTP_FORBIDDEN
              : HTTP_GONE;

        return reply.code(status).send({ code: acceptedResult.failure.code, message: acceptedResult.failure.message });
      }
      const accepted = acceptedResult.value;

      await repositories().recordWorkspaceAuditEvent({
        workspaceId: accepted.invitation.workspaceId,
        actorUserId: user.id,
        eventType: "invitation.accepted",
        subjectType: "invitation",
        subjectId: accepted.invitation.id,
        metadata: { email: accepted.invitation.email },
      });
      await syncWorkspaceSeatsInRequest({ workspaceId: accepted.invitation.workspaceId, log: request.log });

      return acceptWorkspaceInvitationResponseSchema.parse({
        workspaceId: accepted.invitation.workspaceId,
        role: accepted.role,
      });
    },
  );
}

function registerMeWorkspaceRoutes(app: FastifyInstance): void {
  // Lightweight workspace context for the signed-in user (nav gating; the
  // server still enforces every admin route independently).
  app.get("/me/workspace", { preHandler: requireAuth }, async (request, reply) => {
    const user = readAuthenticatedUser(request);
    const [workspace, membership, memberships] = await Promise.all([
      repositories().getWorkspaceById(user.workspaceId),
      repositories().getWorkspaceMembership({ workspaceId: user.workspaceId, userId: user.id }),
      repositories().listMyWorkspacesDetailed(user.id),
    ]);
    if (!workspace || !membership) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WORKSPACE_NOT_FOUND });
    }

    return myWorkspaceResponseSchema.parse({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        logoUrl: workspace.logoUrl ?? null,
        role: membership.role,
        status: membership.status,
      },
      workspaces: memberships.map((row) => ({
        id: row.id,
        name: row.name,
        logoUrl: row.logoUrl ?? null,
        role: row.role,
        isActive: row.id === user.workspaceId,
      })),
    });
  });

  app.post("/me/workspace/active", { preHandler: requireAuth }, async (request, reply) => {
    const user = readAuthenticatedUser(request);
    const body = setActiveWorkspaceRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_A_WORKSPACE_ID_IS_REQUIRED });
    }

    try {
      await repositories().setActiveWorkspaceForUser({ userId: user.id, workspaceId: body.data.workspaceId });
    } catch (error) {
      if (error instanceof WorkspaceAdminError) {
        return reply.code(HTTP_FORBIDDEN).send({ code: error.code, message: error.message });
      }
      throw error;
    }

    return { workspaceId: body.data.workspaceId };
  });
}

export async function workspaceAdminRoutes(app: FastifyInstance): Promise<void> {
  registerWorkspaceCreateRoute(app);
  registerWorkspaceSettingsRoutes(app);
  registerWorkspaceLogoRoutes(app);
  registerWorkspaceDeleteRoute(app);
  registerWorkspaceMembersListRoute(app);
  registerWorkspaceMemberRoleRoutes(app);
  registerWorkspaceMemberStatusRoutes(app);
  registerWorkspaceMemberRemoveRoute(app);
  registerWorkspaceInviteBatchRoute(app);
  registerWorkspaceInvitationResendRoute(app);
  registerWorkspaceInvitationRevokeRoute(app);
  registerPublicInvitationRoutes(app);
  registerMeWorkspaceRoutes(app);
}
