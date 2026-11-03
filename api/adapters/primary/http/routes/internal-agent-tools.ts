import { createInternalMeetingAssetRequestSchema } from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import {
  AgentToolBrokerError,
  confirmAgentTool,
  executeAgentTool,
  getLinearMcpToolCatalogForUser,
  getVoiceWebResearchProgress,
  listAvailableAgentTools,
  prepareAgentTool,
  presentVoiceWebResearchRun,
} from "../../../../application/agent-tool-broker";
import { persistMeetingScreenCapture } from "../../../../application/meeting-asset-service";
import { apiEnv } from "../../../../composition/env";
import { repositories } from "../../../../ports/repository-runtime";
import { matchesInternalSecret } from "../support/internal-secret";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;

const PARTICIPANT_IDENTITY_MAX_LENGTH = 256;
const UTTERANCE_ID_MAX_LENGTH = 160;
const WEB_RESEARCH_QUERY_MAX_LENGTH = 500;
const IDEMPOTENCY_KEY_MAX_LENGTH = 180;
const LINEAR_MCP_DISPLAY_NAME_MAX_LENGTH = 160;

const MESSAGE_UNAUTHORIZED_INTERNAL_REQUEST = "Unauthorized internal request";
const MESSAGE_VALID_TOOL_OWNER_CONTEXT_REQUIRED = "Valid tool owner context required";
const MESSAGE_TOOL_OWNER_MISMATCH = "Tool owner mismatch";
const MESSAGE_ACTIVE_AUTHORIZED_MEETING_TURN_REQUIRED = "Active authorized meeting turn required";
const MESSAGE_MEETING_NOT_FOUND = "Meeting not found";
const MESSAGE_MEETING_ASSET_STORAGE_FAILED = "Meeting asset storage failed";

export const agentToolExecutionContextSchema = z.object({
  meetingId: z.string().uuid(),
  meetingTurnId: z.string().uuid(),
  participantIdentity: z.string().trim().min(1).max(PARTICIPANT_IDENTITY_MAX_LENGTH),
  utteranceId: z.string().trim().min(1).max(UTTERANCE_ID_MAX_LENGTH),
  requestingUserId: z.string().uuid(),
  activeSpeakerUserId: z.string().uuid(),
  agentProfileId: z.string().uuid(),
  allowedToolScope: z.literal("private"),
  createdAt: z.string().datetime({ offset: true }),
});

const brokerUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().trim().min(1),
  email: z.string().email().nullable().optional(),
});

const toolOwnerGuardBodySchema = z.object({
  context: agentToolExecutionContextSchema,
  user: z.object({ id: z.string().uuid() }).optional(),
});

const listRequestSchema = z.object({
  context: agentToolExecutionContextSchema,
});

const webResearchProgressRequestSchema = z.object({
  context: agentToolExecutionContextSchema,
  query: z.string().trim().min(1).max(WEB_RESEARCH_QUERY_MAX_LENGTH),
});

const presentVoiceWebResearchRunRequestSchema = z.object({
  context: agentToolExecutionContextSchema,
  runId: z.string().uuid(),
});

const executeRequestSchema = z.object({
  context: agentToolExecutionContextSchema,
  user: brokerUserSchema,
  toolName: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().trim().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).nullable().optional(),
});

const prepareRequestSchema = z.object({
  context: agentToolExecutionContextSchema,
  user: brokerUserSchema,
  toolName: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().trim().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH),
});

const confirmRequestSchema = z.object({
  context: agentToolExecutionContextSchema,
  user: brokerUserSchema,
  pendingInvocationId: z.string().uuid(),
  confirmationActorUserId: z.string().uuid(),
});

function sendBrokerError(input: { reply: FastifyReply; error: unknown }) {
  if (input.error instanceof AgentToolBrokerError) {
    return input.reply.code(input.error.statusCode).send({
      message: input.error.message,
      code: input.error.code,
    });
  }
  throw input.error;
}

const linearMcpCatalogRequestSchema = z.object({
  context: agentToolExecutionContextSchema,
  displayName: z.string().trim().min(1).max(LINEAR_MCP_DISPLAY_NAME_MAX_LENGTH).default("Ready participant"),
});

const requireInternalSecret: preHandlerAsyncHookHandler = async (request, reply) => {
  const incomingSecret = request.headers["x-assistant-service-secret"];
  if (!matchesInternalSecret({ header: incomingSecret, expected: apiEnv.ASSISTANT_SERVICE_SECRET })) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED_INTERNAL_REQUEST });
  }

  return;
};

function registerAgentToolOwnerGuard(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    await requireInternalSecret.call(app, request, reply);
    if (reply.sent || request.routeOptions.url?.endsWith("/meeting-assets") === true) {
      return;
    }
    const parsedBody = toolOwnerGuardBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_VALID_TOOL_OWNER_CONTEXT_REQUIRED });
    }
    const owner = {
      meetingId: parsedBody.data.context.meetingId,
      userId: parsedBody.data.context.requestingUserId,
      agentProfileId: parsedBody.data.context.agentProfileId,
      meetingTurnId: parsedBody.data.context.meetingTurnId,
      participantIdentity: parsedBody.data.context.participantIdentity,
    };
    if (
      parsedBody.data.context.activeSpeakerUserId !== owner.userId ||
      (parsedBody.data.user !== undefined && parsedBody.data.user.id !== owner.userId)
    ) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_TOOL_OWNER_MISMATCH });
    }
    if (!(await repositories().hasActiveMeetingToolOwner(owner))) {
      return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_ACTIVE_AUTHORIZED_MEETING_TURN_REQUIRED });
    }
  });
}

function registerMeetingAssetsRoute(app: FastifyInstance): void {
  app.post("/internal/agent-tools/meeting-assets", { preHandler: requireInternalSecret }, async (request, reply) => {
    const parsed = createInternalMeetingAssetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    const meeting = await repositories().getMeetingById(parsed.data.meetingId);
    if (!meeting) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_NOT_FOUND });
    }
    try {
      const asset = await persistMeetingScreenCapture({
        meetingId: meeting.id,
        imageDataUrl: parsed.data.imageDataUrl,
        capturedAt: new Date(parsed.data.capturedAt),
        participantIdentity: parsed.data.participantIdentity,
        trackSid: parsed.data.trackSid,
        trigger: parsed.data.trigger,
        transcriptSegmentId: parsed.data.transcriptSegmentId,
        transcriptSegmentIds: parsed.data.transcriptSegmentIds,
        transcriptExcerpt: parsed.data.transcriptExcerpt,
        speakerName: parsed.data.speakerName,
      });

      return { asset };
    } catch (error) {
      request.log.warn({ error, meetingId: meeting.id }, "Meeting asset capture could not be persisted");

      return reply.code(HTTP_SERVICE_UNAVAILABLE).send({
        message: error instanceof Error ? error.message : MESSAGE_MEETING_ASSET_STORAGE_FAILED,
      });
    }
  });
}

function registerLinearMcpCatalogRoute(app: FastifyInstance): void {
  app.post(
    "/internal/agent-tools/linear-mcp-catalog",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const parsed = linearMcpCatalogRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }
      try {
        const catalog = await getLinearMcpToolCatalogForUser({
          userId: parsed.data.context.requestingUserId,
          displayName: parsed.data.displayName,
        });
        request.log.info(
          {
            meetingId: parsed.data.context.meetingId,
            userId: parsed.data.context.requestingUserId,
            isConnected: catalog.connected,
            toolCount: catalog.tools.length,
          },
          "Linear MCP tool catalog requested",
        );

        return catalog;
      } catch (error) {
        return sendBrokerError({ reply, error });
      }
    },
  );
}

function registerInternalAgentToolBrokerRoutes(app: FastifyInstance): void {
  app.post("/internal/agent-tools/list", { preHandler: requireInternalSecret }, async (request, reply) => {
    const parsed = listRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    try {
      return await listAvailableAgentTools(parsed.data);
    } catch (error) {
      return sendBrokerError({ reply, error });
    }
  });

  app.post("/internal/agent-tools/execute", { preHandler: requireInternalSecret }, async (request, reply) => {
    const parsed = executeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    try {
      return await executeAgentTool(parsed.data);
    } catch (error) {
      return sendBrokerError({ reply, error });
    }
  });

  app.post(
    "/internal/agent-tools/web-search/present",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const parsed = presentVoiceWebResearchRunRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }
      try {
        return await presentVoiceWebResearchRun(parsed.data);
      } catch (error) {
        return sendBrokerError({ reply, error });
      }
    },
  );

  app.post(
    "/internal/agent-tools/web-search/progress",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const parsed = webResearchProgressRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }
      try {
        return await getVoiceWebResearchProgress(parsed.data);
      } catch (error) {
        return sendBrokerError({ reply, error });
      }
    },
  );

  app.post("/internal/agent-tools/prepare", { preHandler: requireInternalSecret }, async (request, reply) => {
    const parsed = prepareRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    try {
      return await prepareAgentTool(parsed.data);
    } catch (error) {
      return sendBrokerError({ reply, error });
    }
  });

  app.post("/internal/agent-tools/confirm", { preHandler: requireInternalSecret }, async (request, reply) => {
    const parsed = confirmRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    try {
      return await confirmAgentTool(parsed.data);
    } catch (error) {
      return sendBrokerError({ reply, error });
    }
  });
}

export async function internalAgentToolRoutes(app: FastifyInstance): Promise<void> {
  registerAgentToolOwnerGuard(app);
  registerMeetingAssetsRoute(app);
  registerLinearMcpCatalogRoute(app);
  registerInternalAgentToolBrokerRoutes(app);
}
