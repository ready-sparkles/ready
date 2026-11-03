import { closeDbPool, setDbPoolErrorHandler } from "@readymeet/db";
import Fastify from "fastify";

import { internalRoutes } from "../adapters/primary/http/routes";
import { initSentry, Sentry } from "../adapters/secondary/sentry/sentry";
import { assistantEnv } from "../ports/assistant-env";

const isSentryEnabled = initSentry();
const app = Fastify({ logger: true });
const SERVER_CLOSE_TIMEOUT_MS = 2_000;
const FORCE_EXIT_BUFFER_MS = 500;
const DATABASE_POOL_CLOSE_TIMEOUT_MS = 1_000;

if (isSentryEnabled) {
  Sentry.setupFastifyErrorHandler(app);
}

setDbPoolErrorHandler((error) => {
  app.log.error({ err: error }, "Unexpected error on idle PostgreSQL client");
  Sentry.captureException(error, { tags: { source: "postgresPool" } });
});

await app.register(internalRoutes);

app.get("/health", async () => ({ status: "ok" }));

const server = await (async () => {
  try {
    return await app.listen({ host: "0.0.0.0", port: assistantEnv().ASSISTANT_PORT });
  } catch (error: unknown) {
    app.log.error(error);
    process.exit(1);
  }
})();

const shutdownState = { isClosing: false };

async function settleCleanup(input: { task: Promise<unknown>; timeoutMs: number; label: string }) {
  const timeoutState = { timeoutId: null as NodeJS.Timeout | null };
  try {
    await Promise.race([
      (async () => {
        try {
          await input.task;
        } catch (error: unknown) {
          app.log.warn({ error, label: input.label }, "Assistant cleanup step failed");
        }
      })(),
      (async () => {
        await new Promise<void>((resolve) => {
          timeoutState.timeoutId = setTimeout(() => {
            app.log.warn({ label: input.label, timeoutMs: input.timeoutMs }, "Assistant cleanup timed out");
            resolve();
          }, input.timeoutMs);
          timeoutState.timeoutId.unref();
        });
      })(),
    ]);
  } finally {
    if (timeoutState.timeoutId !== null) {
      clearTimeout(timeoutState.timeoutId);
    }
  }
}

const closeServer = async (signal: string) => {
  if (shutdownState.isClosing) {
    return;
  }

  shutdownState.isClosing = true;
  app.log.info({ signal, server }, "Shutting down assistant service");

  const forceExitTimer = setTimeout(() => {
    app.log.warn({ signal }, "Assistant shutdown timed out, forcing exit");
    process.exit(1);
  }, SERVER_CLOSE_TIMEOUT_MS + FORCE_EXIT_BUFFER_MS);
  forceExitTimer.unref();

  try {
    await settleCleanup({ task: app.close(), timeoutMs: SERVER_CLOSE_TIMEOUT_MS, label: "app.close" });
    await settleCleanup({
      task: (async () => {
        try {
          await closeDbPool();
        } catch (error: unknown) {
          if (error instanceof Error) {
            // Pool shutdown is best-effort during process exit.
          }
        }
      })(),
      timeoutMs: DATABASE_POOL_CLOSE_TIMEOUT_MS,
      label: "db pool close",
    });
    process.exit(0);
  } catch (error: unknown) {
    app.log.error({ error, signal }, "Assistant shutdown failed");
    process.exit(1);
  }
};

process.once("SIGINT", () => {
  void closeServer("SIGINT");
});

process.once("SIGTERM", () => {
  void closeServer("SIGTERM");
});

process.on("unhandledRejection", (error) => {
  app.log.error({ error }, "Unhandled rejection in assistant service");
  Sentry.captureException(error, { tags: { source: "unhandledRejection" } });
});

process.on("uncaughtExceptionMonitor", (error) => {
  app.log.error({ error }, "Uncaught exception in assistant service");
  Sentry.captureException(error, { tags: { source: "uncaughtException" } });
});
