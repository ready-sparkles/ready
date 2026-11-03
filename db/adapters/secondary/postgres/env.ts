import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Strip the build output folder so source and compiled `dist/` startup resolve the same package directory. */
const sourceOrBuildDir = path.resolve(__dirname, "..", "..", "..");
const serviceRoot = path.basename(sourceOrBuildDir) === "dist" ? path.dirname(sourceOrBuildDir) : sourceOrBuildDir;
const workspaceRoot = path.dirname(serviceRoot);

config({ path: path.join(workspaceRoot, ".env") });

const MAX_DATABASE_POOL_CONNECTIONS = 100;
const DEFAULT_DATABASE_POOL_CONNECTIONS = 10;
const dbEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_DATABASE_POOL_CONNECTIONS)
    .default(DEFAULT_DATABASE_POOL_CONNECTIONS),
  /** Scratch database for authoring migrations (db:migration:new); defaults to `<database>_shadow`. */
  SHADOW_DATABASE_URL: z.string().url().optional().or(z.literal("")),
});

export const dbEnv = dbEnvSchema.parse(process.env);
