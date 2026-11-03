import { readdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { runPrismaCli } from "./migrations";

const SHADOW_DATABASE_SUFFIX = "_shadow";
const MIGRATION_NUMBER_WIDTH = 4;
const NUMBERED_MIGRATION_PATTERN = /^(\d+)_/;
const PRISMA_TIMESTAMP_MIGRATION_PATTERN = /^\d{14}_/;
const MIGRATION_NAME_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const DUPLICATE_DATABASE_SQLSTATE = "42P04";
const INVALID_MIGRATION_NAME_MESSAGE = "Migration names are lower_snake_case, e.g. add_meeting_tags.";
const INVALID_DATABASE_NAME_MESSAGE = "The shadow database name must be letters, digits and underscores.";
const MISSING_CREATED_MIGRATION_MESSAGE = "Prisma did not create a migration directory.";
const ADMIN_DATABASE = "postgres";

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const migrationsDir = path.join(packageDir, "prisma/migrations");

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/** The scratch database Prisma replays migrations into: SHADOW_DATABASE_URL, else `<database>_shadow`. */
export function shadowDatabaseUrl(input: { databaseUrl: string; configured?: string }): string {
  if (input.configured !== undefined && input.configured !== "") {
    return input.configured;
  }
  const url = new URL(input.databaseUrl);
  url.pathname = `/${databaseName(url)}${SHADOW_DATABASE_SUFFIX}`;

  return url.toString();
}

/**
 * 0_init is a pg_dump that sets check_function_bodies with SET LOCAL. Prisma replays it outside a
 * transaction, so the setting is ignored and PL/pgSQL bodies that name later tables fail. Its
 * checksum is recorded in every deployed _prisma_migrations, so instead of editing it the shadow
 * database carries the setting at the database level, which survives Prisma's shadow resets.
 */
export async function ensureShadowDatabase(input: { shadowUrl: string }): Promise<void> {
  const shadow = new URL(input.shadowUrl);
  const name = databaseName(shadow);
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(INVALID_DATABASE_NAME_MESSAGE);
  }
  const admin = new URL(input.shadowUrl);
  admin.pathname = `/${ADMIN_DATABASE}`;
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    try {
      await client.query(`CREATE DATABASE "${name}"`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === DUPLICATE_DATABASE_SQLSTATE)) {
        throw error;
      }
    }
    await client.query(`ALTER DATABASE "${name}" SET check_function_bodies = off`);
  } finally {
    await client.end();
  }
}

/** Next directory name in the repository's numbered sequence, e.g. 0137_add_meeting_tags. */
export function nextMigrationDirectory(input: { existing: string[]; name: string }): string {
  if (!MIGRATION_NAME_PATTERN.test(input.name)) {
    throw new Error(INVALID_MIGRATION_NAME_MESSAGE);
  }
  const highest = input.existing.reduce((maximum, directory) => {
    const match = NUMBERED_MIGRATION_PATTERN.exec(directory);
    if (match === null || PRISMA_TIMESTAMP_MIGRATION_PATTERN.test(directory)) {
      return maximum;
    }

    return Math.max(maximum, Number(match[1]));
  }, 0);

  return `${String(highest + 1).padStart(MIGRATION_NUMBER_WIDTH, "0")}_${input.name}`;
}

/** Runs `prisma migrate dev --create-only` and renames Prisma's timestamped directory into the numbered sequence. */
export async function createMigration(input: {
  name: string;
  databaseUrl: string;
  shadowUrl: string;
}): Promise<string> {
  const before = await readdir(migrationsDir);
  const directory = nextMigrationDirectory({ existing: before, name: input.name });
  await ensureShadowDatabase({ shadowUrl: input.shadowUrl });
  await runPrismaCli({
    args: ["migrate", "dev", "--create-only", "--name", input.name],
    databaseUrl: input.databaseUrl,
    shadowDatabaseUrl: input.shadowUrl,
  });
  const created = (await readdir(migrationsDir)).filter(
    (entry) => !before.includes(entry) && PRISMA_TIMESTAMP_MIGRATION_PATTERN.test(entry),
  );
  const [timestamped] = created;
  if (timestamped === undefined) {
    throw new Error(MISSING_CREATED_MIGRATION_MESSAGE);
  }
  await rename(path.join(migrationsDir, timestamped), path.join(migrationsDir, directory));

  return directory;
}
