import { z } from "zod";

import { Prisma } from "./client";

/** Raised by debit_ai_usage_credits() when a usage row needs credits nobody has (migration 0136). */
export const INSUFFICIENT_AI_CREDITS_SQLSTATE = "RM402";
/** lock_timeout expired while waiting for a row lock. */
export const LOCK_NOT_AVAILABLE_SQLSTATE = "55P03";
/** Prisma gave up on an interactive transaction (timeout or closed transaction). */
const PRISMA_TRANSACTION_API_ERROR = "P2028";

const driverAdapterMetaSchema = z.object({
  driverAdapterError: z.object({
    cause: z.object({ code: z.string() }).passthrough(),
  }),
});
const pgErrorSchema = z.object({ code: z.string() }).passthrough();

/** The PostgreSQL SQLSTATE behind a Prisma driver-adapter error or a raw pg error, if any. */
export function postgresSqlState(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const parsed = driverAdapterMetaSchema.safeParse(error.meta);

    return parsed.success ? parsed.data.driverAdapterError.cause.code : undefined;
  }
  if (error instanceof Error) {
    const parsed = pgErrorSchema.safeParse(error);

    return parsed.success && /^[0-9A-Z]{5}$/.test(parsed.data.code) ? parsed.data.code : undefined;
  }

  return undefined;
}

export function isPrismaTransactionTimeout(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_TRANSACTION_API_ERROR;
}
