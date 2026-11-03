import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { Prisma, PrismaClient } from "../../../generated/prisma/client";

import { encryptedClient } from "./content-client";
import { dbEnv } from "./env";

// @prisma/adapter-pg sends DateTime parameters as zone-less UTC text. PostgreSQL reads
// zone-less timestamptz input in the session TimeZone, so a non-UTC server default
// (for example America/Los_Angeles) would shift every stored timestamp by its offset.
// Pin every pooled session to UTC with a startup option: it applies before any query
// runs and survives reconnects. It is appended last so it wins over any TimeZone the
// connection string already sets, while other startup options are kept.
const UTC_SESSION_OPTION = "-c TimeZone=UTC";

export function withUtcSessionTimeZone(connectionString: string): string {
  const url = new URL(connectionString);
  const existing = url.searchParams.get("options")?.trim() ?? "";
  url.searchParams.set("options", existing === "" ? UTC_SESSION_OPTION : `${existing} ${UTC_SESSION_OPTION}`);

  return url.toString();
}

const pool = new Pool({
  connectionString: withUtcSessionTimeZone(dbEnv.DATABASE_URL),
  max: dbEnv.DATABASE_POOL_MAX,
});

export type DbPoolErrorHandler = (error: Error) => void;

const defaultDbPoolErrorHandler: DbPoolErrorHandler = (error) => {
  console.error("Unexpected error on idle PostgreSQL client.", error);
};

const dbPoolErrorHandlerState: { current: DbPoolErrorHandler } = {
  current: defaultDbPoolErrorHandler,
};

/**
 * Replaces the default stderr reporter for unexpected errors from idle pool
 * clients. Services use this to route the non-fatal failure through their
 * structured logger and error tracker.
 */
export function setDbPoolErrorHandler(handler: DbPoolErrorHandler): void {
  dbPoolErrorHandlerState.current = handler;
}

const handlePoolError = (error: Error) => {
  // pg-pool attaches the whole client to the error before re-emitting it. It
  // includes connection internals and makes logs both noisy and sensitive.
  delete (error as Error & { client?: unknown }).client;

  try {
    dbPoolErrorHandlerState.current(error);
  } catch (handlerError) {
    console.error("Database pool error handler failed.", handlerError);
    defaultDbPoolErrorHandler(error);
  }
};
pool.on("error", handlePoolError);

// PostgreSQL itself does not cancel an open transaction after five seconds.
// Prisma's default does, which turns a lock wait into a failed transaction.
const INTERACTIVE_TRANSACTION_TIMEOUT_MS = 20_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
  transactionOptions: {
    timeout: INTERACTIVE_TRANSACTION_TIMEOUT_MS,
  },
});

export const db = encryptedClient({ client: prisma });
export type DbConnection = PrismaClient;
export type DbTransaction = Prisma.TransactionClient;
export { pool, Prisma };

export async function closeDbPool(): Promise<void> {
  await db.$disconnect();
  await pool.end();
}
