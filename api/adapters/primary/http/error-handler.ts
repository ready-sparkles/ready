import type { FastifyReply, FastifyRequest } from "fastify";
import { STATUS_CODES } from "node:http";
import { z } from "zod";

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_MAX_STATUS = 599;
const INTERNAL_SERVER_ERROR_MESSAGE = "Internal Server Error";
const LOG_MESSAGE = "Unhandled API error";
const deliberateErrorSchema = z.object({
  statusCode: z.number().int().min(HTTP_BAD_REQUEST).max(HTTP_MAX_STATUS),
  code: z.string().optional(),
  message: z.string(),
});

/**
 * Last-resort error response for every API route (`app.setErrorHandler`).
 *
 * Errors that deliberately carry a 4xx or a non-500 5xx status (validation, BillingError,
 * an assistant 402, a plan or credit denial) keep their message, matching Fastify's
 * default body shape. Anything else is an unexpected failure, such as a Prisma error, a
 * ZodError or an upstream service's raw text. Its message can contain SQL, file paths or
 * code frames, so the response is a generic 500 and the details only go to the log (and
 * Sentry's onError hook).
 *
 * Plan and credit denials carry `statusCode: 402` and `code` on the error itself, so they
 * go through the same deliberate path as every other expected failure.
 */
export function apiErrorResponse(input: {
  error: unknown;
  request: FastifyRequest;
  reply: FastifyReply;
}): FastifyReply {
  const deliberate = input.error instanceof Error ? deliberateErrorSchema.safeParse(input.error) : undefined;
  if (deliberate?.success !== true || deliberate.data.statusCode === HTTP_INTERNAL_SERVER_ERROR) {
    input.request.log.error({ err: input.error }, LOG_MESSAGE);

    return input.reply.code(HTTP_INTERNAL_SERVER_ERROR).send({
      statusCode: HTTP_INTERNAL_SERVER_ERROR,
      error: INTERNAL_SERVER_ERROR_MESSAGE,
      message: INTERNAL_SERVER_ERROR_MESSAGE,
    });
  }
  const { statusCode, code, message } = deliberate.data;

  return input.reply.code(statusCode).send({
    statusCode,
    ...(code !== undefined ? { code } : {}),
    error: STATUS_CODES[statusCode] ?? INTERNAL_SERVER_ERROR_MESSAGE,
    message,
  });
}
