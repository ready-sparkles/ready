import * as Sentry from "@sentry/node";

import { assistantEnv } from "../../../ports/assistant-env";

/**
 * Error tracking is opt-in via SENTRY_DSN; without it every capture call is a
 * no-op, so callers never need to guard. Tracing stays off — this is crash
 * and degraded-mode reporting, not performance monitoring.
 */
export function initSentry(): boolean {
  const sentryDsn = assistantEnv().SENTRY_DSN;
  if (sentryDsn === "") {
    return false;
  }

  const sentryEnvironment = assistantEnv().SENTRY_ENVIRONMENT;
  const nodeEnvironment = assistantEnv().NODE_ENV;
  const resolvedEnvironment = sentryEnvironment !== "" ? sentryEnvironment : nodeEnvironment;

  Sentry.init({
    dsn: sentryDsn,
    environment: resolvedEnvironment,
    tracesSampleRate: 0,
  });

  return true;
}

export { Sentry };
