import { dbEnv } from "./adapters/secondary/postgres/env";
import { createMigration, shadowDatabaseUrl } from "./adapters/secondary/postgres/migration-authoring";
import { runMigrations } from "./adapters/secondary/postgres/migrations";

const MIGRATION_FAILED_MESSAGE = "Migration failed.";
const NEW_MIGRATION_COMMAND = "new";
const NEW_MIGRATION_USAGE_MESSAGE = "Usage: corepack pnpm db:migration:new <lower_snake_case_name>";
const ARGUMENT_OFFSET = 2;

async function createNamedMigration(name: string | undefined): Promise<void> {
  if (name === undefined) {
    throw new Error(NEW_MIGRATION_USAGE_MESSAGE);
  }
  const directory = await createMigration({
    name,
    databaseUrl: dbEnv.DATABASE_URL,
    shadowUrl: shadowDatabaseUrl({ databaseUrl: dbEnv.DATABASE_URL, configured: dbEnv.SHADOW_DATABASE_URL }),
  });
  process.stdout.write(`Created prisma/migrations/${directory}/migration.sql. Review it, then run db:migrate.\n`);
}

async function main(): Promise<void> {
  const [command, name] = process.argv.slice(ARGUMENT_OFFSET);
  if (command === NEW_MIGRATION_COMMAND) {
    await createNamedMigration(name);

    return;
  }
  await runMigrations();
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error(MIGRATION_FAILED_MESSAGE, error);
    process.exitCode = 1;
  }
})();
