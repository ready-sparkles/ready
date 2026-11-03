import { repositoryPort } from "@readymeet/db";
import { configureRealtimePublisher } from "@readymeet/db/ports/realtime";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publishRealtimeEvent } from "../adapters/secondary/ably/realtime-publisher";
import { configureRepositoryPort } from "../ports/repository-runtime";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
/** Strip the build output folder so source and compiled `dist/` startup resolve the same package directory. */
const sourceOrBuildDir = path.resolve(currentDirPath, "..");
const serviceRoot = path.basename(sourceOrBuildDir) === "dist" ? path.dirname(sourceOrBuildDir) : sourceOrBuildDir;
const workspaceRoot = path.dirname(serviceRoot);
const injectedEnv = { ...process.env };

config({ path: path.join(workspaceRoot, ".env") });
config({ path: path.join(serviceRoot, ".env"), override: true });
Object.assign(process.env, injectedEnv);

configureRepositoryPort(repositoryPort);
configureRealtimePublisher(publishRealtimeEvent);
