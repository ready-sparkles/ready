import { aiWorkflowJobTypeSchema } from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import { createLiveAiWorkRunner } from "../../../../application/live-ai-work";
import { runAiWorkflowInRequest } from "../../../../application/run-ai-work";
import { apiEnv } from "../../../../composition/env";
import { matchesInternalSecret } from "../support/internal-secret";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const MESSAGE_UNAUTHORIZED_INTERNAL_REQUEST = "Unauthorized internal request";
const MESSAGE_INVALID_AI_WORK_REQUEST = "Invalid AI work request";

const aiWorkRequestSchema = z.object({
  meetingId: z.string().uuid(),
  type: aiWorkflowJobTypeSchema,
  scopeKey: z.string().trim().min(1).optional(),
  phase: z.string().trim().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  maxAttempts: z.number().int().positive().optional(),
});

const requireInternalSecret: preHandlerAsyncHookHandler = async (request, reply) => {
  const incomingSecret = request.headers["x-assistant-service-secret"];
  if (!matchesInternalSecret({ header: incomingSecret, expected: apiEnv.ASSISTANT_SERVICE_SECRET })) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED_INTERNAL_REQUEST });
  }

  return undefined;
};

export async function internalAiWorkRoutes(app: FastifyInstance): Promise<void> {
  const liveWork = createLiveAiWorkRunner();
  app.addHook("onClose", liveWork.drain);
  app.post("/internal/ai-work", { preHandler: requireInternalSecret }, async (request, reply: FastifyReply) => {
    const parsed = aiWorkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_AI_WORK_REQUEST });
    }
    const run =
      parsed.data.type === "track_meeting" || parsed.data.type === "detect_ambient_context"
        ? liveWork.start
        : runAiWorkflowInRequest;
    await run({
      meetingId: parsed.data.meetingId,
      type: parsed.data.type,
      scopeKey: parsed.data.scopeKey,
      phase: parsed.data.phase,
      payload: parsed.data.payload,
      maxAttempts: parsed.data.maxAttempts,
      logger: request.log,
    });

    return {
      /** @external ai work accepted */
      ok: true,
    };
  });
}
