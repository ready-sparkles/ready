import type { ApiEnv } from "./env-schema";

const API_ENVIRONMENT_IS_NOT_CONFIGURED_MESSAGE = "API environment is not configured.";

const apiEnvState: { env?: ApiEnv } = {};

export function configureApiEnv(env: ApiEnv): void {
  apiEnvState.env = env;
}

export function apiEnv(): ApiEnv {
  if (apiEnvState.env === undefined) {
    throw new Error(API_ENVIRONMENT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return apiEnvState.env;
}
