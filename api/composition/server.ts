import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { closeDbPool, setDbPoolErrorHandler } from "@readymeet/db";
import Fastify from "fastify";

import { apiErrorResponse } from "../adapters/primary/http/error-handler";
import { API_ROUTER_OPTIONS } from "../adapters/primary/http/router-options";
import { accountRoutes } from "../adapters/primary/http/routes/account";
import { adminRoutes } from "../adapters/primary/http/routes/admin";
import { agentRoutes } from "../adapters/primary/http/routes/agent";
import { authRoutes } from "../adapters/primary/http/routes/auth";
import { billingRoutes } from "../adapters/primary/http/routes/billing";
import { capabilityRoutes } from "../adapters/primary/http/routes/capabilities";
import { capabilityWorkflowRoutes } from "../adapters/primary/http/routes/capability-workflows";
import { creditUsageRoutes } from "../adapters/primary/http/routes/credit-usage";
import { integrationRoutes } from "../adapters/primary/http/routes/integrations";
import { ashbyIntegrationRoutes } from "../adapters/primary/http/routes/integrations-ashby";
import { slackIntegrationRoutes } from "../adapters/primary/http/routes/integrations-slack";
import { internalAgentToolRoutes } from "../adapters/primary/http/routes/internal-agent-tools";
import { internalAiWorkRoutes } from "../adapters/primary/http/routes/internal-ai-work";
import { internalMeetingAgentRoutes } from "../adapters/primary/http/routes/internal-meeting-agent";
import { livekitRoutes } from "../adapters/primary/http/routes/livekit";
import { meetingRoutes } from "../adapters/primary/http/routes/meetings";
import { memoryRoutes } from "../adapters/primary/http/routes/memory";
import { realtimeRoutes } from "../adapters/primary/http/routes/realtime";
import { webhookRoutes } from "../adapters/primary/http/routes/webhooks";
import { workspaceAdminRoutes } from "../adapters/primary/http/routes/workspaces";
import { createRailwayLogger } from "../adapters/secondary/pino/railway-logger";
import { initSentry, Sentry } from "../adapters/secondary/sentry/sentry";

import { apiEnv } from "./env";

const isSentryEnabled = initSentry();
const app = Fastify({
  routerOptions: API_ROUTER_OPTIONS,
  loggerInstance: createRailwayLogger(),
});
const SERVER_CLOSE_TIMEOUT_MS = 2_000;
const SERVER_FORCE_EXIT_GRACE_MS = 500;
const DB_CLOSE_TIMEOUT_MS = 1_000;

if (isSentryEnabled) {
  Sentry.setupFastifyErrorHandler(app);
}

// Registered before every route plugin so each one inherits it.
app.setErrorHandler((error, request, reply) => apiErrorResponse({ error, request, reply }));

setDbPoolErrorHandler((error) => {
  app.log.error({ err: error }, "Unexpected error on idle PostgreSQL client");
  Sentry.captureException(error, { tags: { source: "postgresPool" } });
});

await app.register(cors, {
  // Dev web servers fall back to another port when 3000 is taken; accept any
  // localhost origin (hostname, IPv4 loopback, or IPv6 loopback) outside
  // production so the API keeps working with them.
  origin:
    apiEnv.NODE_ENV === "production"
      ? [apiEnv.NEXT_PUBLIC_WEB_URL]
      : [apiEnv.NEXT_PUBLIC_WEB_URL, /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/],
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

// No global limit; the unauthenticated meeting-link routes opt in via
// per-route `config.rateLimit` (they can create DB rows without an account).
await app.register(rateLimit, { global: false });

await app.register(authRoutes, { prefix: "/v1" });
await app.register(accountRoutes, { prefix: "/v1" });
await app.register(adminRoutes, { prefix: "/v1" });
await app.register(billingRoutes, { prefix: "/v1" });
await app.register(agentRoutes, { prefix: "/v1" });
await app.register(capabilityRoutes, { prefix: "/v1" });
await app.register(capabilityWorkflowRoutes, { prefix: "/v1" });
await app.register(creditUsageRoutes, { prefix: "/v1" });
await app.register(integrationRoutes, { prefix: "/v1" });
await app.register(slackIntegrationRoutes, { prefix: "/v1" });
await app.register(ashbyIntegrationRoutes, { prefix: "/v1" });
await app.register(internalAgentToolRoutes, { prefix: "/v1" });
await app.register(internalAiWorkRoutes, { prefix: "/v1" });
await app.register(internalMeetingAgentRoutes, { prefix: "/v1" });
await app.register(meetingRoutes, { prefix: "/v1" });
await app.register(memoryRoutes, { prefix: "/v1" });
await app.register(livekitRoutes, { prefix: "/v1" });
await app.register(realtimeRoutes, { prefix: "/v1" });
await app.register(webhookRoutes, { prefix: "/v1" });
await app.register(workspaceAdminRoutes, { prefix: "/v1" });

app.get("/health", async () => ({ status: "ok" }));
app.get("/health/workers", async () => ({ status: "ok" }));

const server = await (async () => {
  try {
    return await app.listen({ host: apiEnv.API_HOST, port: apiEnv.API_PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
})();

const shutdownState = { isClosing: false };

function createCleanupTimeout({ timeoutMs, label }: { timeoutMs: number; label: string }) {
  const timeoutState: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    timeoutState.resolve = resolve;
  });
  const timeoutId = setTimeout(() => {
    app.log.warn({ label, timeoutMs }, "API cleanup timed out");
    timeoutState.resolve?.();
  }, timeoutMs);
  timeoutId.unref();

  return {
    promise,
    clear: () => clearTimeout(timeoutId),
  };
}

async function settleCleanup({ task, timeoutMs, label }: { task: Promise<unknown>; timeoutMs: number; label: string }) {
  const guardedTask = async () => {
    try {
      await task;
    } catch (error) {
      app.log.warn({ error, label }, "API cleanup step failed");
    }
  };
  const guardedTaskPromise = guardedTask();
  const timeout = createCleanupTimeout({ timeoutMs, label });

  try {
    await Promise.race([guardedTaskPromise, timeout.promise]);
  } finally {
    timeout.clear();
  }
}

const closeServer = async (signal: string) => {
  if (shutdownState.isClosing) {
    return;
  }

  shutdownState.isClosing = true;
  app.log.info({ signal, server }, "Shutting down API service");

  const forceExitTimer = setTimeout(() => {
    app.log.warn({ signal }, "API shutdown timed out, forcing exit");
    process.exit(1);
  }, SERVER_CLOSE_TIMEOUT_MS + SERVER_FORCE_EXIT_GRACE_MS);
  forceExitTimer.unref();

  try {
    await settleCleanup({ task: app.close(), timeoutMs: SERVER_CLOSE_TIMEOUT_MS, label: "app.close" });
    await settleCleanup({ task: closeDbPool(), timeoutMs: DB_CLOSE_TIMEOUT_MS, label: "db pool close" });
    process.exit(0);
  } catch (error) {
    app.log.error({ error, signal }, "API shutdown failed");
    process.exit(1);
  }
};

process.once("SIGINT", () => {
  void closeServer("SIGINT");
});

process.once("SIGTERM", () => {
  void closeServer("SIGTERM");
});
