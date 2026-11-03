import * as Sentry from "@sentry/node";

import { apiEnv } from "../../../ports/api-env";

/**
 * Error tracking is opt-in via SENTRY_DSN; without it every capture call is a
 * no-op, so callers never need to guard. Tracing stays off — this is crash
 * and degraded-mode reporting, not performance monitoring.
 */
export function initSentry(): boolean {
  if (apiEnv().SENTRY_DSN === "") {
    return false;
  }

  Sentry.init({
    dsn: apiEnv().SENTRY_DSN,
    environment: apiEnv().SENTRY_ENVIRONMENT !== "" ? apiEnv().SENTRY_ENVIRONMENT : apiEnv().NODE_ENV,
    tracesSampleRate: 0,
  });

  return true;
}

export { Sentry };
