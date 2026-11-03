import { meetingAgentToolInvocationActionResponseSchema } from "@readymeet/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  AgentToolBrokerError,
  cancelAgentToolInvocationFromMeetingClient,
  confirmAgentToolInvocationFromMeetingClient,
} from "../../../../../application/agent-tool-broker";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";

const HTTP_BAD_REQUEST_STATUS = 400;
const AUTHENTICATION_REQUIRED_MESSAGE = "Authentication required.";

const invocationParamsSchema = z.object({
  invocationId: z.string().uuid(),
});

function sendBrokerError(input: { reply: FastifyReply; error: unknown }): FastifyReply | never {
  if (input.error instanceof AgentToolBrokerError) {
    return input.reply.code(input.error.statusCode).send({
      message: input.error.message,
      code: input.error.code,
    });
  }
  throw input.error;
}

export async function meetingAgentToolRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/meetings/:meetingId/agent-tools/:invocationId/confirm",
    {
      preHandler: requireMeetingAccess("participant", {
        forbiddenMessage: "Only meeting participants can confirm assistant actions.",
      }),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const user = request.user;
      if (user === undefined) {
        return reply.code(HTTP_BAD_REQUEST_STATUS).send({ message: AUTHENTICATION_REQUIRED_MESSAGE });
      }
      const parsedParams = invocationParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST_STATUS).send({ message: parsedParams.error.message });
      }

      try {
        const confirmed = await confirmAgentToolInvocationFromMeetingClient({
          meetingId: meeting.id,
          pendingInvocationId: parsedParams.data.invocationId,
          user: {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
          },
        });

        return meetingAgentToolInvocationActionResponseSchema.parse({
          /** @external ok */
          ok: true,
          invocationId: confirmed.invocationId,
          status: "completed",
          resultSummary: confirmed.result,
        });
      } catch (error) {
        return sendBrokerError({ reply, error });
      }
    },
  );

  app.post(
    "/meetings/:meetingId/agent-tools/:invocationId/cancel",
    {
      preHandler: requireMeetingAccess("participant", {
        forbiddenMessage: "Only meeting participants can cancel assistant actions.",
      }),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const user = request.user;
      if (user === undefined) {
        return reply.code(HTTP_BAD_REQUEST_STATUS).send({ message: AUTHENTICATION_REQUIRED_MESSAGE });
      }
      const parsedParams = invocationParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST_STATUS).send({ message: parsedParams.error.message });
      }

      try {
        const cancelled = await cancelAgentToolInvocationFromMeetingClient({
          meetingId: meeting.id,
          pendingInvocationId: parsedParams.data.invocationId,
          userId: user.id,
        });

        return meetingAgentToolInvocationActionResponseSchema.parse({
          /** @external ok */
          ok: true,
          invocationId: cancelled.invocationId,
          status: "cancelled",
          resultSummary: null,
        });
      } catch (error) {
        return sendBrokerError({ reply, error });
      }
    },
  );
}
