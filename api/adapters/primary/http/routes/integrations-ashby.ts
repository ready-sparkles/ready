import {
  type AshbyErrorCode,
  ashbyIntegrationStatusResponseSchema,
  ashbySaveKeyRequestSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { repositories } from "../../../../ports/repository-runtime";
import {
  AshbyApiError,
  type AshbyClient,
  createAshbyClient,
  verifyAshbyKey,
} from "../../../secondary/ashby/ashby-client";
import type { AshbyKeySecret } from "../../../secondary/ashby/ashby-profile-links";
import { encryptJsonSecret } from "../../../secondary/node/secret-crypto";
import {
  getWorkspaceMembershipContext,
  isWorkspaceManagerRole,
  requireActiveWorkspaceMember,
  requireWorkspaceManager,
} from "../support/workspace-access";

const HTTP_BAD_REQUEST = 400;
const HTTP_BAD_GATEWAY = 502;
const HTTP_CONFLICT = 409;
const MESSAGE_AUTHENTICATED_USER_REQUIRED = "Authenticated user is required";
const MESSAGE_ASHBY_DID_NOT_RESPOND = "Ashby did not respond. Try again in a moment.";
const MESSAGE_PASTE_ASHBY_API_KEY = "Paste an Ashby API key.";
const MESSAGE_ASHBY_DID_NOT_ACCEPT_API_KEY = "Ashby did not accept this API key. Check that you copied the whole key.";
const MESSAGE_ASHBY_MISSING_CANDIDATES_READ_PERMISSION =
  "This key can’t read candidates. Enable candidatesRead for it in Ashby.";
const MESSAGE_ASHBY_MUST_BE_CONFIGURED_BY_ADMIN = "Ashby must be set up by a workspace admin first.";
const CODE_ASHBY_INVALID_KEY = "ashby_invalid_key";
const CODE_ASHBY_MISSING_PERMISSION = "ashby_missing_permission";
const CODE_ASHBY_NOT_CONFIGURED = "ashby_not_configured";

type AshbyRouteDependencies = {
  createClient: (apiKey: string) => AshbyClient;
};

const defaultDependencies: AshbyRouteDependencies = {
  createClient: (apiKey) => createAshbyClient(apiKey),
};

async function buildStatus(input: { workspaceId: string; userId: string; canManage: boolean }) {
  const [integration, isMemberConnected, admins] = await Promise.all([
    repositories().getWorkspaceAshbyIntegration(input.workspaceId),
    repositories().isAshbyMemberConnected({ workspaceId: input.workspaceId, userId: input.userId }),
    repositories().listWorkspaceAdminNames(input.workspaceId),
  ]);

  const configuredByName = integration?.configuredByName;

  return ashbyIntegrationStatusResponseSchema.parse({
    /** @external ashby status field */
    configured: Boolean(integration),
    canManage: input.canManage,
    configuredBy:
      configuredByName !== undefined && configuredByName !== null && configuredByName.length > 0
        ? { displayName: configuredByName }
        : null,
    configuredAt: integration?.updatedAt ?? null,
    admins: admins.map((displayName) => ({ displayName })),
    /** @external ashby status field */
    connected: Boolean(integration) && isMemberConnected,
  });
}

function sendAshbyError(input: { reply: FastifyReply; status: number; code: AshbyErrorCode; message: string }) {
  return input.reply.code(input.status).send({ code: input.code, message: input.message });
}

function requireRequestUser(request: { user?: { id: string } }) {
  const user = request.user;
  if (!user) {
    throw new Error(MESSAGE_AUTHENTICATED_USER_REQUIRED);
  }

  return user;
}

async function getAshbyIntegrationStatus(request: FastifyRequest) {
  const { workspaceId, role } = getWorkspaceMembershipContext(request);

  return buildStatus({
    workspaceId,
    userId: requireRequestUser(request).id,
    canManage: isWorkspaceManagerRole(role),
  });
}

async function putAshbyIntegration(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  dependencies: AshbyRouteDependencies;
}) {
  const { workspaceId } = getWorkspaceMembershipContext(input.request);
  const parsed = ashbySaveKeyRequestSchema.safeParse(input.request.body);
  if (!parsed.success) {
    return sendAshbyError({
      reply: input.reply,
      status: HTTP_BAD_REQUEST,
      code: CODE_ASHBY_INVALID_KEY,
      message: MESSAGE_PASTE_ASHBY_API_KEY,
    });
  }
  try {
    await verifyAshbyKey(input.dependencies.createClient(parsed.data.apiKey));
  } catch (error) {
    if (error instanceof AshbyApiError && error.kind === "invalid_key") {
      return sendAshbyError({
        reply: input.reply,
        status: HTTP_BAD_REQUEST,
        code: CODE_ASHBY_INVALID_KEY,
        message: MESSAGE_ASHBY_DID_NOT_ACCEPT_API_KEY,
      });
    }
    if (error instanceof AshbyApiError && error.kind === "missing_permission") {
      return sendAshbyError({
        reply: input.reply,
        status: HTTP_BAD_REQUEST,
        code: CODE_ASHBY_MISSING_PERMISSION,
        message: MESSAGE_ASHBY_MISSING_CANDIDATES_READ_PERMISSION,
      });
    }
    if (error instanceof AshbyApiError) {
      return input.reply.code(HTTP_BAD_GATEWAY).send({ message: MESSAGE_ASHBY_DID_NOT_RESPOND });
    }
    throw error;
  }
  await repositories().saveWorkspaceAshbyIntegration({
    workspaceId,
    secretRef: encryptJsonSecret({ apiKey: parsed.data.apiKey } satisfies AshbyKeySecret),
    configuredByUserId: requireRequestUser(input.request).id,
  });
  // The admin who set Ashby up is using it too.
  await repositories().connectAshbyMember({ workspaceId, userId: requireRequestUser(input.request).id });
  input.request.log.info(
    { workspaceId, userId: requireRequestUser(input.request).id },
    "Ashby key saved for workspace",
  );

  return buildStatus({ workspaceId, userId: requireRequestUser(input.request).id, canManage: true });
}

async function deleteAshbyIntegration(request: FastifyRequest) {
  const { workspaceId } = getWorkspaceMembershipContext(request);
  await repositories().deleteWorkspaceAshbyIntegration(workspaceId);
  request.log.info({ workspaceId, userId: requireRequestUser(request).id }, "Ashby key removed from workspace");

  return buildStatus({ workspaceId, userId: requireRequestUser(request).id, canManage: true });
}

async function connectAshbyIntegration(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId, role } = getWorkspaceMembershipContext(request);
  if (!(await repositories().connectAshbyMember({ workspaceId, userId: requireRequestUser(request).id }))) {
    return sendAshbyError({
      reply,
      status: HTTP_CONFLICT,
      code: CODE_ASHBY_NOT_CONFIGURED,
      message: MESSAGE_ASHBY_MUST_BE_CONFIGURED_BY_ADMIN,
    });
  }

  return buildStatus({
    workspaceId,
    userId: requireRequestUser(request).id,
    canManage: isWorkspaceManagerRole(role),
  });
}

async function disconnectAshbyIntegration(request: FastifyRequest) {
  const { workspaceId, role } = getWorkspaceMembershipContext(request);
  await repositories().disconnectAshbyMember({ workspaceId, userId: requireRequestUser(request).id });

  return buildStatus({
    workspaceId,
    userId: requireRequestUser(request).id,
    canManage: isWorkspaceManagerRole(role),
  });
}

export async function ashbyIntegrationRoutes(
  ...args: [app: FastifyInstance, options?: { dependencies?: AshbyRouteDependencies }]
): Promise<void> {
  const [app, options = {}] = args;
  const dependencies = options.dependencies ?? defaultDependencies;

  app.get(
    "/workspaces/:workspaceId/integrations/ashby",
    { preHandler: requireActiveWorkspaceMember },
    getAshbyIntegrationStatus,
  );

  // Admin only. The key is checked against Ashby before it is stored, and it is
  // never returned to any client.
  app.put("/workspaces/:workspaceId/integrations/ashby", { preHandler: requireWorkspaceManager }, (request, reply) =>
    putAshbyIntegration({ request, reply, dependencies }),
  );

  app.delete(
    "/workspaces/:workspaceId/integrations/ashby",
    { preHandler: requireWorkspaceManager },
    deleteAshbyIntegration,
  );

  // Any member turns Ashby on or off for themselves, using the workspace key.
  app.post(
    "/workspaces/:workspaceId/integrations/ashby/connect",
    { preHandler: requireActiveWorkspaceMember },
    connectAshbyIntegration,
  );

  app.post(
    "/workspaces/:workspaceId/integrations/ashby/disconnect",
    { preHandler: requireActiveWorkspaceMember },
    disconnectAshbyIntegration,
  );
}
