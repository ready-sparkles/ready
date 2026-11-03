import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";

import { pool } from "./client";
import { dbEnv } from "./env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_RETRY_LIMIT = 8;
const MIGRATION_RETRY_BASE_DELAY_MS = 1_000;
const TRANSIENT_MIGRATION_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "57P03",
  "57P01",
]);

// Session lock spans initial schema creation and every migration transaction.
const MIGRATION_LOCK_ID = 7_361_429;

const BASELINE_FILE = "0133_baseline.sql";
const PRISMA_MIGRATION_NAME = "0_init";
const INVENTORY_EXCLUDED_TABLES = "('schema_migrations','_prisma_migrations')";
const execute = promisify(execFile);
const BASELINE_ERROR =
  "Unsupported database state. Finish upgrading with the previous release before adopting the baseline.";
const failedPrismaMigrationMessage = (name: string) => `Prisma migration ${name} is recorded as failed.`;
const PLAN_CREDITS_MIGRATION = "0134_plan_credit_reservations";
const LEGACY_MIGRATION_COUNT = 133;
const SCHEMA_SIGNATURE_COUNT = 2;
const BASELINE_SCHEMA_ERROR = "Database schema does not match the migration baseline; no adoption marker was written.";
// Historical 0126 kept this queue (minus its due index) when it still held storage deletions.
const RETAINED_DELETION_TABLE = "pending_attachment_deletions";
const RETAINED_TABLE_KINDS = new Set(["column", "constraint", "policy", "table", "trigger"]);
const PRODUCTION_LOAD_TEST_MIGRATION = "0110_production_load_test.sql";
const PRODUCTION_LOAD_TEST_RELATIONS = new Set([
  "load_test_runs",
  "load_test_meetings",
  "load_test_jobs",
  "load_test_calls",
  "load_test_samples",
  "load_test_samples_id_seq",
]);
const PRODUCTION_LOAD_TEST_INDEXES = new Set([
  "load_test_one_active_run",
  "load_test_meetings_run",
  "load_test_runs_pkey",
  "load_test_meetings_pkey",
  "load_test_jobs_pkey",
  "load_test_calls_pkey",
  "load_test_samples_pkey",
]);
const PRODUCTION_LOAD_TEST_FUNCTIONS = new Set(["register_load_test_job()"]);
const PRODUCTION_LOAD_TEST_TRIGGERS = new Set([
  "ai_workflow_jobs.load_test_ai_job",
  "memory_jobs.load_test_memory_job",
]);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const baselineManifestSchema = z.object({
  legacyFiles: z.array(z.string()).length(LEGACY_MIGRATION_COUNT),
  schemaSha256: z.array(sha256Schema).length(SCHEMA_SIGNATURE_COUNT),
  retainedAttachmentDeletionsSha256: sha256Schema,
  objectSha256: z.record(z.string(), z.array(sha256Schema).min(1)),
});
type BaselineManifest = z.infer<typeof baselineManifestSchema>;
type InventoryRow = { kind: string; name: string; definition: string };
type InventoryDiff = { extra: string[]; missing: string[]; changed: string[] };
const DIFF_NAME_LIMIT = 40;
const EXTENSION_KIND = "extension";

// Column metadata covers nullability; PostgreSQL18-only NOT NULL constraint rows are redundant.
// Extra extensions (Railway pg_stat_statements, for example) and the catalog objects they
// own are not application schema. pgcrypto is required; other extensions are ignored.
const NOT_EXTENSION_OWNED_CLASS = `NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid='pg_class'::regclass AND dep.objid=c.oid AND dep.deptype='e')`;
const namedClassNotExtensionOwned = (relNameSql: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_depend dep ON dep.classid='pg_class'::regclass AND dep.objid=c.oid AND dep.deptype='e' WHERE ns.nspname='public' AND c.relname=${relNameSql})`;
const SCHEMA_INVENTORY_SQL = `SELECT kind, name, definition FROM (
 SELECT 'column' AS kind, c.relname || '.' || a.attname AS name,
 json_build_array(row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum),format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid))::text AS definition
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname NOT IN ${INVENTORY_EXCLUDED_TABLES} AND a.attnum>0 AND NOT a.attisdropped AND ${NOT_EXTENSION_OWNED_CLASS}
 UNION ALL
 SELECT 'constraint',c.relname||'.'||k.conname,pg_get_constraintdef(k.oid,true)
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname NOT IN ${INVENTORY_EXCLUDED_TABLES} AND k.contype<>'n' AND ${NOT_EXTENSION_OWNED_CLASS}
 UNION ALL
 SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename NOT IN ${INVENTORY_EXCLUDED_TABLES} AND ${namedClassNotExtensionOwned("tablename")}
 UNION ALL
 SELECT 'trigger',c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid,true)||':'||t.tgenabled::text
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname NOT IN ${INVENTORY_EXCLUDED_TABLES} AND ${NOT_EXTENSION_OWNED_CLASS}
 UNION ALL
 SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',pg_get_functiondef(p.oid)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f' AND NOT EXISTS(
 SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
 UNION ALL
 SELECT 'table',c.relname,json_build_array(c.relkind,c.relrowsecurity,c.relforcerowsecurity)::text
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') AND c.relname NOT IN ${INVENTORY_EXCLUDED_TABLES} AND ${NOT_EXTENSION_OWNED_CLASS}
 UNION ALL
 SELECT 'extension',extname,'' FROM pg_extension WHERE extname='pgcrypto'
 UNION ALL
 SELECT 'policy',tablename||'.'||policyname,json_build_array(permissive,roles,cmd,qual,with_check)::text
 FROM pg_policies WHERE schemaname='public' AND tablename NOT IN ${INVENTORY_EXCLUDED_TABLES} AND ${namedClassNotExtensionOwned("tablename")}
 UNION ALL
 SELECT 'enum',t.typname,string_agg(e.enumlabel,',' ORDER BY e.enumsortorder)
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
 WHERE n.nspname='public' AND NOT EXISTS(
 SELECT 1 FROM pg_depend dep WHERE dep.classid='pg_type'::regclass AND dep.objid=t.oid AND dep.deptype='e')
 GROUP BY t.typname
 UNION ALL
 SELECT 'view',viewname,definition FROM pg_views WHERE schemaname='public' AND ${namedClassNotExtensionOwned("viewname")}
) objects ORDER BY kind COLLATE "C",name COLLATE "C",definition COLLATE "C";`;

function digestInventory(rows: InventoryRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function inventoryKey(row: InventoryRow): string {
  return `${row.kind}|${row.name}`;
}

function digestDefinition(definition: string): string {
  return createHash("sha256").update(definition).digest("hex");
}

function uniqueSorted(names: string[]): string[] {
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

function displayInventoryName(key: string): string {
  const separator = key.indexOf("|");
  if (separator === -1) {
    return key;
  }

  return `${key.slice(0, separator)} ${key.slice(separator + 1)}`;
}

function formatNames(names: string[]): string {
  if (names.length === 0) {
    return "none";
  }

  const shown = names.slice(0, DIFF_NAME_LIMIT).map(displayInventoryName);
  const suffix = names.length > DIFF_NAME_LIMIT ? ` (+${String(names.length - DIFF_NAME_LIMIT)} more)` : "";

  return `${shown.join(", ")}${suffix}`;
}

function formatInventoryDiff(diff: InventoryDiff): string {
  return `extra: ${formatNames(diff.extra)}; missing: ${formatNames(diff.missing)}; changed: ${formatNames(diff.changed)}`;
}

function schemaMismatchError(diff: InventoryDiff): Error {
  return new Error([BASELINE_SCHEMA_ERROR, formatInventoryDiff(diff)].join(" "));
}

function unsupportedStateError(diff: InventoryDiff): Error {
  return new Error([BASELINE_ERROR, formatInventoryDiff(diff)].join(" "));
}

function diffInventory(input: { rows: InventoryRow[]; allowed: Record<string, string[]> }): InventoryDiff {
  const present = new Set(input.rows.map(inventoryKey));
  const extra = uniqueSorted(input.rows.map(inventoryKey).filter((key) => input.allowed[key] === undefined));
  const changed = uniqueSorted(
    input.rows
      .filter((row) => {
        const allowedHashes = input.allowed[inventoryKey(row)];

        return allowedHashes !== undefined && !allowedHashes.includes(digestDefinition(row.definition));
      })
      .map(inventoryKey),
  );
  const missing = uniqueSorted(Object.keys(input.allowed).filter((key) => !present.has(key)));

  return { extra, missing, changed };
}

function assertInventoryMatches(input: { rows: InventoryRow[]; manifest: BaselineManifest }): void {
  if (input.manifest.schemaSha256.includes(digestInventory(input.rows))) {
    return;
  }

  const diff = diffInventory({ rows: input.rows, allowed: input.manifest.objectSha256 });
  if (diff.extra.length === 0 && diff.missing.length === 0 && diff.changed.length === 0) {
    return;
  }

  throw schemaMismatchError(diff);
}

function isKnownHistoricalMigration(input: { file: string; legacyFiles: string[] }): boolean {
  return input.legacyFiles.includes(input.file) || input.file === PRODUCTION_LOAD_TEST_MIGRATION;
}

function describeHistoricalDiff(input: {
  appliedMigrations: Set<string>;
  historical: string[];
  legacyFiles: string[];
}): InventoryDiff {
  return {
    extra: uniqueSorted(
      input.historical.filter((file) => !isKnownHistoricalMigration({ file, legacyFiles: input.legacyFiles })),
    ),
    missing: uniqueSorted(input.legacyFiles.filter((file) => !input.appliedMigrations.has(file))),
    changed: [],
  };
}

function isAdoptableLegacyHistory(input: {
  appliedMigrations: Set<string>;
  historical: string[];
  legacyFiles: string[];
}): boolean {
  return (
    describeHistoricalDiff(input).extra.length === 0 &&
    input.legacyFiles.every((file) => input.appliedMigrations.has(file))
  );
}

function isProductionLoadTestRow(row: InventoryRow): boolean {
  if (
    PRODUCTION_LOAD_TEST_INDEXES.has(row.name) ||
    PRODUCTION_LOAD_TEST_FUNCTIONS.has(row.name) ||
    PRODUCTION_LOAD_TEST_TRIGGERS.has(row.name)
  ) {
    return true;
  }

  return [...PRODUCTION_LOAD_TEST_RELATIONS].some(
    (relation) => row.name === relation || row.name.startsWith(`${relation}.`),
  );
}

async function verifyBaselineSchema(input: {
  client: PoolClient;
  manifest: BaselineManifest;
  canRetainDeletions: boolean;
  canRetainLoadTest: boolean;
}): Promise<void> {
  const { client, manifest, canRetainDeletions, canRetainLoadTest } = input;
  const inventoried = await client.query<InventoryRow>(SCHEMA_INVENTORY_SQL);
  const comparableRows = canRetainLoadTest
    ? inventoried.rows.filter((row) => !isProductionLoadTestRow(row))
    : inventoried.rows;
  if (!canRetainDeletions) {
    assertInventoryMatches({ rows: comparableRows, manifest });

    return;
  }
  const retainedIndexes = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1",
    [RETAINED_DELETION_TABLE],
  );
  const retainedIndexNames = new Set(retainedIndexes.rows.map((row) => row.indexname));
  const isRetainedRow = (row: InventoryRow): boolean =>
    row.kind === "index"
      ? retainedIndexNames.has(row.name)
      : RETAINED_TABLE_KINDS.has(row.kind) &&
        (row.name === RETAINED_DELETION_TABLE || row.name.startsWith(`${RETAINED_DELETION_TABLE}.`));
  const retainedRows = comparableRows.filter(isRetainedRow);
  const baselineRows = comparableRows.filter((row) => !isRetainedRow(row));
  // The rest of the schema must still match exactly; the retained queue must match 0122 minus its due index.
  const isRetainedShapeValid =
    retainedRows.length === 0 || digestInventory(retainedRows) === manifest.retainedAttachmentDeletionsSha256;
  if (!isRetainedShapeValid) {
    throw schemaMismatchError({
      extra: [],
      missing: [],
      changed: uniqueSorted(retainedRows.map(inventoryKey)),
    });
  }

  assertInventoryMatches({ rows: baselineRows, manifest });
}

async function adoptBaseline(input: {
  client: PoolClient;
  migrationsDir: string;
  appliedMigrations: Set<string>;
  migrationFiles: string[];
  baseline: { sql: string; checksum: string };
}): Promise<void> {
  const { client, migrationsDir, appliedMigrations, migrationFiles, baseline } = input;
  const manifest = baselineManifestSchema.parse(
    JSON.parse(await readFile(path.join(migrationsDir, "baseline.json"), "utf8")),
  );
  const historical = [...appliedMigrations].filter((file) => !migrationFiles.includes(file));
  const historyDiff = describeHistoricalDiff({
    appliedMigrations,
    historical,
    legacyFiles: manifest.legacyFiles,
  });
  const isLegacy = isAdoptableLegacyHistory({
    appliedMigrations,
    historical,
    legacyFiles: manifest.legacyFiles,
  });
  // A marked fresh install has no historical rows; an adopted database retains all of them.
  if (appliedMigrations.has(BASELINE_FILE)) {
    if (historical.length !== 0 && !isLegacy) {
      throw unsupportedStateError(historyDiff);
    }
    await recordPrismaMigration({ client, checksum: baseline.checksum, name: PRISMA_MIGRATION_NAME });

    return;
  }
  if (appliedMigrations.size !== 0 && !isLegacy) {
    throw unsupportedStateError(historyDiff);
  }
  if (isLegacy) {
    await client.query("BEGIN");
    try {
      // Outstanding deletion records are left in place; only the shape of their table is checked.
      await verifyBaselineSchema({
        client,
        manifest,
        canRetainDeletions: true,
        canRetainLoadTest: appliedMigrations.has(PRODUCTION_LOAD_TEST_MIGRATION),
      });
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [BASELINE_FILE]);
      await recordPrismaMigration({ client, checksum: baseline.checksum, name: PRISMA_MIGRATION_NAME });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    return;
  }
  const objects = await client.query<InventoryRow>(SCHEMA_INVENTORY_SQL);
  const extraObjects = uniqueSorted(objects.rows.filter((row) => row.kind !== EXTENSION_KIND).map(inventoryKey));
  if (extraObjects.length !== 0) {
    throw unsupportedStateError({ extra: extraObjects, missing: [], changed: [] });
  }
  await client.query("BEGIN");
  try {
    await client.query(baseline.sql);
    await verifyBaselineSchema({ client, manifest, canRetainDeletions: false, canRetainLoadTest: false });
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [BASELINE_FILE]);
    await recordPrismaMigration({ client, checksum: baseline.checksum, name: PRISMA_MIGRATION_NAME });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function readMigrationErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = error.code;

  return typeof code === "string" ? code : undefined;
}

function isTransientMigrationError(error: unknown): boolean {
  const code = readMigrationErrorCode(error);

  return code !== undefined && TRANSIENT_MIGRATION_ERROR_CODES.has(code);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const packageDir = path.resolve(__dirname, "../../..");
const baselineSqlPath = path.join(packageDir, "prisma/migrations", PRISMA_MIGRATION_NAME, "migration.sql");

async function readBaselineMigration(): Promise<{ sql: string; checksum: string }> {
  const sql = await readFile(baselineSqlPath, "utf8");

  return { sql, checksum: createHash("sha256").update(sql).digest("hex") };
}

async function ensurePrismaMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public._prisma_migrations (
      id varchar(36) PRIMARY KEY,
      checksum varchar(64) NOT NULL,
      finished_at timestamptz,
      migration_name varchar(255) NOT NULL,
      logs text,
      rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(),
      applied_steps_count integer NOT NULL DEFAULT 0
    )
  `);
}

async function recordPrismaMigration(input: { client: PoolClient; checksum: string; name: string }): Promise<void> {
  const { client, checksum, name } = input;
  await ensurePrismaMigrationTable(client);
  const existing = await client.query<{ finished_at: Date | null }>(
    "SELECT finished_at FROM public._prisma_migrations WHERE migration_name = $1 AND rolled_back_at IS NULL",
    [name],
  );
  if (existing.rows.some((row) => row.finished_at !== null)) {
    return;
  }
  if (existing.rows.length !== 0) {
    throw new Error(failedPrismaMigrationMessage(name));
  }
  await client.query(
    `INSERT INTO public._prisma_migrations
      (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
     VALUES ($1, $2, now(), $3, now(), 1)`,
    [randomUUID(), checksum, name],
  );
}

/** Runs the package's Prisma CLI with an explicit database (and optional shadow database). */
export async function runPrismaCli(input: {
  args: string[];
  databaseUrl: string;
  shadowDatabaseUrl?: string;
}): Promise<string> {
  const prismaEntry = path.join(packageDir, "node_modules/prisma/build/index.js");
  try {
    const { stdout } = await execute(process.execPath, [prismaEntry, ...input.args], {
      cwd: packageDir,
      env: {
        ...process.env,
        DATABASE_URL: input.databaseUrl,
        ...(input.shadowDatabaseUrl !== undefined ? { SHADOW_DATABASE_URL: input.shadowDatabaseUrl } : {}),
      },
    });

    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
    const message = error instanceof Error ? error.message : "Prisma migrate deploy failed.";
    throw new Error([message, stdout, stderr].filter((part) => part.length > 0).join("\n"));
  }
}

async function deployPrismaMigrations(): Promise<void> {
  await runPrismaCli({ args: ["migrate", "deploy"], databaseUrl: dbEnv.DATABASE_URL });
}

type ContentMaintenance = (input: { client: PoolClient; sql: string }) => Promise<void>;
const FAILED_MAINTENANCE = "Resolve failed migrations before content maintenance.";
const APPLIED_MAINTENANCE = "Content migration already applied; maintenance refused.";
const FUTURE_MAINTENANCE = "Unexpected later migration; review content maintenance first.";
const CONTENT_MIGRATION = "0137_meeting_content_encryption";
// Later migrations reviewed as independent of the content cutover. Maintenance stops at the cutover
// and leaves these to the next ordinary `migrate deploy`; any other later migration is refused.
const CUTOVER_INDEPENDENT_MIGRATIONS: ReadonlySet<string> = new Set(["0138_meeting_finalization_claims"]);

async function applyContentMaintenance(input: { client: PoolClient; convert: ContentMaintenance }): Promise<void> {
  const { client, convert } = input;
  const allNames = (await readdir(path.join(packageDir, "prisma/migrations")))
    .filter((name) => /^\d+_/u.test(name) && name !== PRISMA_MIGRATION_NAME)
    .sort();
  const names = allNames.filter((name) => name <= CONTENT_MIGRATION);
  const applied = await client.query<{ migration_name: string; finished_at: Date | null }>(
    "SELECT migration_name, finished_at FROM public._prisma_migrations WHERE rolled_back_at IS NULL",
  );
  if (applied.rows.some((row) => row.finished_at === null)) {
    throw new Error(FAILED_MAINTENANCE);
  }
  if (applied.rows.some((row) => row.migration_name === CONTENT_MIGRATION)) {
    throw new Error(APPLIED_MAINTENANCE);
  }
  if (
    allNames.some((name) => name > CONTENT_MIGRATION && !CUTOVER_INDEPENDENT_MIGRATIONS.has(name)) ||
    applied.rows.some((row) => row.migration_name !== PRISMA_MIGRATION_NAME && !names.includes(row.migration_name))
  ) {
    throw new Error(FUTURE_MAINTENANCE);
  }
  await client.query("BEGIN");
  try {
    await names.reduce(async (pending, name) => {
      await pending;
      if (applied.rows.some((row) => row.migration_name === name)) {
        return;
      }
      const sql = await readFile(path.join(packageDir, "prisma/migrations", name, "migration.sql"), "utf8");
      if (name === CONTENT_MIGRATION) {
        await convert({ client, sql });
      } else {
        await client.query(sql);
      }
      await recordPrismaMigration({ client, name, checksum: createHash("sha256").update(sql).digest("hex") });
    }, Promise.resolve());
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Maintenance-only path; holds the same session lock as ordinary migrations. */
export async function runContentMaintenance(convert: ContentMaintenance): Promise<void> {
  try {
    await runMigrationsOnce(convert);
  } finally {
    await pool.end();
  }
}

async function runMigrationsOnce(convert?: ContentMaintenance): Promise<void> {
  const migrationsDir = path.resolve(__dirname, "../../../migrations");
  // The baseline marker stays 0133_baseline.sql. Later changes are Prisma migration directories.
  const migrationFiles = [BASELINE_FILE, `${PLAN_CREDITS_MIGRATION}.sql`];
  const baseline = await readBaselineMigration();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await ensureMigrationTable(client);
    await client.query("SET search_path TO public");
    const appliedMigrationRows = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    const appliedMigrations = new Set(appliedMigrationRows.rows.map((row) => row.filename));

    await adoptBaseline({ client, migrationsDir, appliedMigrations, migrationFiles, baseline });
    // Billing may have shipped under the SQL migrator before this Prisma cutover.
    if (appliedMigrations.has(`${PLAN_CREDITS_MIGRATION}.sql`)) {
      const sql = await readFile(
        path.join(packageDir, "prisma/migrations", PLAN_CREDITS_MIGRATION, "migration.sql"),
        "utf8",
      );
      await recordPrismaMigration({
        client,
        name: PLAN_CREDITS_MIGRATION,
        checksum: createHash("sha256").update(sql).digest("hex"),
      });
    }
    if (convert === undefined) {
      await deployPrismaMigrations();
    } else {
      await applyContentMaintenance({ client, convert });
    }
  } finally {
    // Destroy this connection: even a failed unlock must not return a locked session to the pool.
    client.release(true);
  }

  process.stdout.write("Migrations applied.\n");
}

async function runMigrationsWithRetry(input: { attempt: number }): Promise<void> {
  try {
    await runMigrationsOnce();
  } catch (error) {
    const isLastAttempt = input.attempt >= MIGRATION_RETRY_LIMIT;
    if (!isTransientMigrationError(error) || isLastAttempt) {
      throw error;
    }

    const delayMs = MIGRATION_RETRY_BASE_DELAY_MS * input.attempt;
    const code = readMigrationErrorCode(error);
    const codeSuffix = code !== undefined && code.length !== 0 ? ` ${code}` : "";
    process.stderr.write(
      `Migration attempt ${input.attempt} failed with transient error${codeSuffix}. Retrying in ${delayMs}ms...\n`,
    );
    await delay(delayMs);
    await runMigrationsWithRetry({ attempt: input.attempt + 1 });
  }
}

export async function runMigrations(): Promise<void> {
  try {
    await runMigrationsWithRetry({ attempt: 1 });
  } finally {
    await pool.end();
  }
}
