import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";

import { matchesInternalSecret } from "../../../application/internal-secret";
import { assistantEnv } from "../../../ports/assistant-env";

const HTTP_UNAUTHORIZED_STATUS = 401;
const INTERNAL_SECURE_MESSAGES = {
  unauthorizedInternalRequest: "Unauthorized internal request",
} as const;

export const requireInternalSecret: preHandlerAsyncHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const incomingSecret = request.headers["x-assistant-service-secret"];
  const hasValidSecret =
    typeof incomingSecret === "string" &&
    matchesInternalSecret({ provided: incomingSecret, expected: assistantEnv().ASSISTANT_SERVICE_SECRET });

  if (!hasValidSecret) {
    return reply.code(HTTP_UNAUTHORIZED_STATUS).send({ message: INTERNAL_SECURE_MESSAGES.unauthorizedInternalRequest });
  }

  return;
};
