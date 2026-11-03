import { configureMeetingContentKeys } from "@readymeet/db";
import { preserveMeetingContent } from "@readymeet/db/maintenance/content";
import { z } from "zod";

import { configureApiEnv } from "../ports/api-env";
import { apiEnvSchema } from "../ports/env-schema";

import { convertStoredContentObject } from "./content-object-cutover";

const USAGE =
  "Requires NODE_ENV=production, --writers-stopped and --backup-confirmed. Stop every writer and confirm a database backup before running.";
const FAILURE =
  "Content maintenance failed; database transaction rolled back. Keep writers stopped and inspect the failure before retrying. No private error details logged.";

async function main(): Promise<void> {
  z.literal("production").parse(process.env.NODE_ENV);
  if (!process.argv.includes("--writers-stopped") || !process.argv.includes("--backup-confirmed")) {
    throw new Error(USAGE);
  }
  configureApiEnv(apiEnvSchema.parse(process.env));
  configureMeetingContentKeys();
  await preserveMeetingContent(convertStoredContentObject);
  process.stdout.write(
    "Content encrypted, verified and committed. Deploy only the encrypted release. Original image copies remain for recovery.\n",
  );
}

try {
  await main();
} catch (error) {
  void error;
  process.stderr.write(`${FAILURE}\n${USAGE}\n`);
  process.exitCode = 1;
}
