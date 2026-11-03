import { configureApiEnv } from "../ports/api-env";
import { apiEnvSchema } from "../ports/env-schema";

await import("./a-configure");
await import("./wire");

export const apiEnv = apiEnvSchema.parse(process.env);

configureApiEnv(apiEnv);
