import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assistantEnvSchema, configureAssistantEnv } from "../../../ports/assistant-env";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

/** Strip the build output folder so source and compiled `dist/` startup resolve the same package directory. */
const sourceOrBuildDir = path.resolve(currentDirPath, "..", "..", "..");
const serviceRoot = path.basename(sourceOrBuildDir) === "dist" ? path.dirname(sourceOrBuildDir) : sourceOrBuildDir;
const workspaceRoot = path.dirname(serviceRoot);

config({ path: path.join(workspaceRoot, ".env") });
config({ path: path.join(serviceRoot, ".env"), override: true });

configureAssistantEnv(assistantEnvSchema.parse(process.env));
