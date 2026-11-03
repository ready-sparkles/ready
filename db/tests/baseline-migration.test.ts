import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { z } from "zod";

const execute = promisify(execFile);
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const legacyArchive = fileURLToPath(new URL("../testdata/legacy-migrations-cf06fed6.tar.gz", import.meta.url));
const manifestSchema = z.object({ legacyFiles: z.array(z.string()), schemaSha256: z.array(z.string()) });
const MARKER = "0133_baseline.sql";
const MANUAL_OBJECT = "baseline_untracked_object";
const TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 1_048_576;
const CATALOG_ROW_COUNT = 2;
const LEGACY_DELETION_QUEUE_FILE = "0122_attachment_deletion_queue.sql";
const PRODUCTION_LOAD_TEST_MIGRATION = "0110_production_load_test.sql";
const PRODUCTION_LOAD_TEST_AFTER_FILE = "0109_completed_meeting_trial_slots.sql";
const PRODUCTION_LOAD_TEST_SQL = fileURLToPath(new URL("../testdata/0110_production_load_test.sql", import.meta.url));
const INSERT_ID_MISSING_MESSAGE = "Expected an inserted row id.";
const API_HEALTH_FAILED_MESSAGE = "API /health did not return ok.";
const API_HEALTH_MARKER = "API_HEALTH_OK";
const HEALTH_API_PORT = 4173;
const MARKER_AND_LOAD_TEST_COUNT = 2;
const API_INDEX_URL = new URL("../../api/index.ts", import.meta.url).href;
const API_HEALTH_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "test",
  AUTH_JWT_SECRET: "ci_dummy_jwt_secret_0123456789",
  LIVEKIT_URL: "wss://ci.livekit.invalid",
  LIVEKIT_API_KEY: "ci_dummy_key",
  LIVEKIT_API_SECRET: "ci_dummy_secret",
  LIVEKIT_WEBHOOK_SECRET: "ci_dummy_webhook_secret",
  ASSISTANT_SERVICE_URL: "http://localhost:4100",
  ASSISTANT_SERVICE_SECRET: "ci_dummy_assistant_secret",
  API_PORT: String(HEALTH_API_PORT),
};

const withClient = async <T>(input: { connection: string; run: (client: Client) => Promise<T> }): Promise<T> => {
  const { connection, run } = input;
  const client = new Client({ connectionString: connection });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
};

const migrate = (connection: string) =>
  execute(process.execPath, ["--import", "tsx", "migrate.ts"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: connection },
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });

const migrateViaRailwayStartPath = (connection: string) =>
  execute("corepack", ["pnpm", "db:migrate"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: connection },
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });

function readInsertedId(rows: { id: string }[]): string {
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(INSERT_ID_MISSING_MESSAGE);
  }

  return id;
}

function assertApiServesHealth(connection: string): void {
  const probe = [
    `await import(${JSON.stringify(API_INDEX_URL)});`,
    `const response = await fetch(${JSON.stringify(`http://127.0.0.1:${String(HEALTH_API_PORT)}/health`)});`,
    `const body = await response.json();`,
    `if (response.ok !== true || body.status !== "ok") { throw new Error(${JSON.stringify(API_HEALTH_FAILED_MESSAGE)}); }`,
    `process.stdout.write(${JSON.stringify(`${API_HEALTH_MARKER}\n`)});`,
    `process.kill(process.pid, "SIGTERM");`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probe], {
    cwd: repoRoot,
    env: { ...API_HEALTH_ENV, DATABASE_URL: connection },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(API_HEALTH_MARKER));
}

async function insertJobsThroughLoadTestTriggers(client: Client): Promise<void> {
  const user = await client.query<{ id: string }>(
    "INSERT INTO users(email, display_name) VALUES ('load-test-trigger@example.test', 'Load') RETURNING id",
  );
  const userId = readInsertedId(user.rows);
  const workspace = await client.query<{ id: string }>(
    "INSERT INTO workspaces(name, created_by_user_id) VALUES ('Load', $1) RETURNING id",
    [userId],
  );
  const workspaceId = readInsertedId(workspace.rows);
  const meeting = await client.query<{ id: string }>(
    "INSERT INTO meetings(title, room_name, created_by_user_id, workspace_id) VALUES ('Load', 'load-test-room', $1, $2) RETURNING id",
    [userId, workspaceId],
  );
  const meetingId = readInsertedId(meeting.rows);
  await client.query("INSERT INTO ai_workflow_jobs(meeting_id, type) VALUES ($1, 'extract_meeting_content')", [
    meetingId,
  ]);
  await client.query(
    `INSERT INTO memory_jobs(user_id, workspace_id, kind, dedupe_key, preferences_revision, prompt_version)
     VALUES ($1, $2, 'extract', 'load-test-trigger', 1, 'test')`,
    [userId, workspaceId],
  );
}

async function applyNextLegacyFile(input: {
  client: Client;
  migrationsDir: string;
  files: string[];
  index: number;
  afterFile?: { file: string; run: (client: Client) => Promise<void> };
}): Promise<void> {
  const file = input.files[input.index];
  if (file === undefined) {
    return;
  }

  const sql = await readFile(path.join(input.migrationsDir, file), "utf8");
  await input.client.query("BEGIN");
  try {
    await input.client.query(sql);
    await input.client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    await input.client.query("COMMIT");
  } catch (error) {
    await input.client.query("ROLLBACK");
    throw error;
  }
  if (input.afterFile?.file === file) {
    await input.afterFile.run(input.client);
  }
  await applyNextLegacyFile({ ...input, index: input.index + 1 });
}

async function applyLegacySqlFiles(input: {
  connection: string;
  migrationsDir: string;
  afterFile?: { file: string; run: (client: Client) => Promise<void> };
}): Promise<string[]> {
  const files = (await readdir(input.migrationsDir))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  await withClient({
    connection: input.connection,
    run: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await applyNextLegacyFile({
        client,
        migrationsDir: input.migrationsDir,
        files,
        index: 0,
        afterFile: input.afterFile,
      });
    },
  });

  return files;
}

const snapshot = (connection: string) =>
  withClient({
    connection,
    run: async (client) => {
      const rows = await client.query("SELECT filename FROM schema_migrations ORDER BY filename");
      const config = await client.query(
        "SELECT price_per_credit_micro_usd, included_action_types, action_minimum_credits, metadata FROM ai_credit_pricing_config",
      );
      const catalog = await client.query("SELECT key, is_active FROM capability_catalog ORDER BY key");
      const policy = await client.query("SELECT future_only_since::text FROM memory_runtime_policy");

      return { history: rows.rows, config: config.rows, catalog: catalog.rows, policy: policy.rows };
    },
  });

function assertInitialSnapshot(initial: Awaited<ReturnType<typeof snapshot>>): void {
  assert.deepEqual(initial.history, [{ filename: MARKER }]);
  assert.equal(initial.config.length, 1);
  assert.equal(initial.catalog.length, CATALOG_ROW_COUNT);
  assert.equal(initial.policy.length, 1);
}

async function verifyInterruptedBootstrap(input: {
  create: () => Promise<string>;
  initial: Awaited<ReturnType<typeof snapshot>>;
}): Promise<void> {
  const { create, initial } = input;
  // A failure at the marker must roll back the entire fresh bootstrap.
  const interrupted = await create();
  await withClient({
    connection: interrupted,
    run: async (client) => {
      await client.query(
        "CREATE TABLE schema_migrations(filename text PRIMARY KEY CHECK(filename <> '0133_baseline.sql'), applied_at timestamptz NOT NULL DEFAULT now())",
      );
    },
  });
  await assert.rejects(migrate(interrupted), /check constraint/);
  await withClient({
    connection: interrupted,
    run: async (client) => {
      assert.equal(
        (await client.query<{ table_name: string | null }>("SELECT to_regclass('public.users') AS table_name")).rows[0]
          ?.table_name,
        null,
      );
      assert.equal(
        (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations")).rows[0]?.count,
        0,
      );
      await client.query("ALTER TABLE schema_migrations DROP CONSTRAINT schema_migrations_filename_check");
    },
  });
  await migrate(interrupted);
  assert.deepEqual((await snapshot(interrupted)).config, initial.config);
}

// Legacy-adoption fixtures must precede later Prisma migrations.
async function bootstrapBaseline(connection: string): Promise<void> {
  await withClient({
    connection,
    run: async (client) => {
      await client.query(
        "CREATE TABLE schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      await client.query(await readFile(new URL("../prisma/migrations/0_init/migration.sql", import.meta.url), "utf8"));
      await client.query("INSERT INTO schema_migrations(filename) VALUES($1)", [MARKER]);
    },
  });
}

async function verifySqlBillingMigrationAdoption(create: () => Promise<string>): Promise<void> {
  const connection = await create();
  await bootstrapBaseline(connection);
  await withClient({
    connection,
    run: async (client) => {
      await client.query(
        await readFile(
          new URL("../prisma/migrations/0134_plan_credit_reservations/migration.sql", import.meta.url),
          "utf8",
        ),
      );
      await client.query("INSERT INTO schema_migrations(filename) VALUES('0134_plan_credit_reservations.sql')");
      await client.query("INSERT INTO users(email, display_name) VALUES ('billing-adoption@example.test', 'Preserve')");
    },
  });
  await migrate(connection);
  await migrate(connection);
  await withClient({
    connection,
    run: async (client) => {
      const migrations = await client.query(
        "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name",
      );
      // Every Prisma migration directory, so adding a migration does not require editing this test.
      const directories = (
        await readdir(fileURLToPath(new URL("../prisma/migrations", import.meta.url)), { withFileTypes: true })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      assert.ok(directories.includes("0134_plan_credit_reservations"));
      assert.deepEqual(
        migrations.rows,
        directories.toSorted().map((name) => ({ migration_name: name })),
      );
      const user = await client.query("SELECT email FROM users WHERE email='billing-adoption@example.test'");
      assert.equal(user.rows.length, 1);
    },
  });
}

async function verifyColumnOrder(input: { create: () => Promise<string>; legacyFiles: string[] }): Promise<void> {
  const connection = await input.create();
  await bootstrapBaseline(connection);
  await withClient({
    connection,
    run: async (client) => {
      await client.query("DELETE FROM schema_migrations");
      await client.query("INSERT INTO schema_migrations(filename) SELECT unnest($1::text[])", [input.legacyFiles]);
      // Raw attnum gaps disappear on dump/restore and must not cause a false mismatch.
      await client.query("ALTER TABLE guest_memory_account_links ADD COLUMN discarded uuid");
      await client.query("ALTER TABLE guest_memory_account_links DROP COLUMN discarded");
    },
  });
  await migrate(connection);
  await withClient({
    connection,
    run: async (client) => {
      await client.query("DELETE FROM schema_migrations WHERE filename=$1", [MARKER]);
      // Preserve every named column, type, default and constraint while reversing live order.
      await client.query(`
        DROP TABLE guest_memory_account_links;
        CREATE TABLE guest_memory_account_links (
          account_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          guest_user_id uuid NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
        );
      `);
    },
  });
  await assert.rejects(migrate(connection), /schema does not match.*changed:.*column guest_memory_account_links/);
  await withClient({
    connection,
    run: async (client) => {
      assert.equal(
        (
          await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM schema_migrations WHERE filename=$1",
            [MARKER],
          )
        ).rows[0]?.count,
        0,
      );
    },
  });
}

// Historical 0126 kept the deletion queue, minus its due index, while it still held outstanding deletions.
const RETAINED_DELETION_TABLE_SQL = `
  CREATE TABLE pending_attachment_deletions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deletion_request_id uuid NOT NULL REFERENCES data_deletion_requests(id) ON DELETE CASCADE,
    storage_key text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    locked_until timestamptz,
    last_error text,
    UNIQUE (deletion_request_id, storage_key)
  );
`;
const RETAINED_STORAGE_KEY = "attachments/baseline-outstanding";

async function verifyRetainedAttachmentDeletions(input: {
  create: () => Promise<string>;
  legacyFiles: string[];
}): Promise<void> {
  const connection = await input.create();
  await bootstrapBaseline(connection);
  await withClient({
    connection,
    run: async (client) => {
      await client.query(RETAINED_DELETION_TABLE_SQL);
      await client.query(
        `WITH request AS (INSERT INTO data_deletion_requests(target_kind) VALUES ('attachments') RETURNING id)
         INSERT INTO pending_attachment_deletions(deletion_request_id, storage_key) SELECT id, $1 FROM request`,
        [RETAINED_STORAGE_KEY],
      );
      await client.query("DELETE FROM schema_migrations");
      await client.query("INSERT INTO schema_migrations(filename) SELECT unnest($1::text[])", [input.legacyFiles]);
    },
  });
  await migrate(connection);
  await withClient({
    connection,
    run: async (client) => {
      assert.equal(
        (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations")).rows[0]?.count,
        input.legacyFiles.length + 1,
      );
      assert.deepEqual(
        (await client.query("SELECT storage_key FROM pending_attachment_deletions")).rows,
        [{ storage_key: RETAINED_STORAGE_KEY }],
        "Adoption keeps outstanding storage deletions",
      );
      // Any other shape of the retained table is still drift.
      await client.query("DELETE FROM schema_migrations WHERE filename=$1", [MARKER]);
      await client.query("ALTER TABLE pending_attachment_deletions ADD COLUMN baseline_unapproved text");
    },
  });
  await assert.rejects(migrate(connection), /schema does not match/);
}

const DUMP_STYLE_MEETINGS_KIND_CHECK =
  "CHECK (kind::text = ANY (ARRAY['standard'::character varying, 'agent_intro'::character varying]::text[]))";

async function verifyFreshPgcryptoAlreadyInstalled(input: { create: () => Promise<string> }): Promise<void> {
  const connection = await input.create();
  await withClient({
    connection,
    run: async (client) => {
      await client.query("CREATE EXTENSION pgcrypto");
    },
  });
  await migrate(connection);
  await withClient({
    connection,
    run: async (client) => {
      assert.equal(
        (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations")).rows[0]?.count,
        1,
      );
      assert.equal(
        (await client.query<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname='pgcrypto'")).rows[0]
          ?.extname,
        "pgcrypto",
      );
    },
  });
}

async function verifyMixedEquivalentConstraint(input: {
  create: () => Promise<string>;
  legacyFiles: string[];
}): Promise<void> {
  const connection = await input.create();
  await bootstrapBaseline(connection);
  await withClient({
    connection,
    run: async (client) => {
      await client.query("DELETE FROM schema_migrations");
      await client.query("INSERT INTO schema_migrations(filename) SELECT unnest($1::text[])", [input.legacyFiles]);
      await client.query("ALTER TABLE meetings DROP CONSTRAINT meetings_kind_check");
      await client.query(`ALTER TABLE meetings ADD CONSTRAINT meetings_kind_check ${DUMP_STYLE_MEETINGS_KIND_CHECK}`);
    },
  });
  await migrate(connection);
  await withClient({
    connection,
    run: async (client) => {
      assert.equal(
        (
          await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM schema_migrations WHERE filename=$1",
            [MARKER],
          )
        ).rows[0]?.count,
        1,
      );
    },
  });
}

async function verifyLegacyHistoryAndUser(input: { connection: string; legacyFileCount: number }): Promise<void> {
  await withClient({
    connection: input.connection,
    run: async (client) => {
      assert.equal(
        (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations")).rows[0]?.count,
        input.legacyFileCount + 1,
      );
      assert.equal(
        (
          await client.query<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE email = $1", [
            "legacy-chain-preserve@example.test",
          ])
        ).rows[0]?.count,
        1,
      );
    },
  });
}

async function verifyLegacyPgStatStatements(input: {
  create: () => Promise<string>;
  migrationsDir: string;
}): Promise<void> {
  const connection = await input.create();
  await applyLegacySqlFiles({ connection, migrationsDir: input.migrationsDir });
  await withClient({
    connection,
    run: async (client) => {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    },
  });
  await migrateViaRailwayStartPath(connection);
  await withClient({
    connection,
    run: async (client) => {
      const marker = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM schema_migrations WHERE filename=$1",
        [MARKER],
      );
      const extension = await client.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname='pg_stat_statements'",
      );
      assert.equal(marker.rows[0]?.count, 1);
      assert.equal(extension.rows[0]?.extname, "pg_stat_statements");
    },
  });
}

async function verifyLegacyQueuedDeletions(input: {
  create: () => Promise<string>;
  migrationsDir: string;
}): Promise<void> {
  const connection = await input.create();
  await applyLegacySqlFiles({
    connection,
    migrationsDir: input.migrationsDir,
    afterFile: {
      file: LEGACY_DELETION_QUEUE_FILE,
      run: async (client) => {
        await client.query(
          `WITH request AS (INSERT INTO data_deletion_requests(target_kind) VALUES ('attachments') RETURNING id)
           INSERT INTO pending_attachment_deletions(deletion_request_id, storage_key) SELECT id, $1 FROM request`,
          [RETAINED_STORAGE_KEY],
        );
      },
    },
  });
  await migrateViaRailwayStartPath(connection);
  await withClient({
    connection,
    run: async (client) => {
      assert.deepEqual((await client.query("SELECT storage_key FROM pending_attachment_deletions")).rows, [
        { storage_key: RETAINED_STORAGE_KEY },
      ]);
    },
  });
}

async function verifyAdoptedDriftAndHistory(input: {
  connection: string;
  legacyFiles: string[];
  initial: Awaited<ReturnType<typeof snapshot>>;
}): Promise<void> {
  const { connection, legacyFiles, initial } = input;
  await withClient({
    connection,
    run: async (client) => {
      await client.query("DELETE FROM schema_migrations");
      await client.query("INSERT INTO schema_migrations(filename) SELECT unnest($1::text[])", [legacyFiles]);
      await client.query(
        "INSERT INTO users(email, display_name) VALUES ('baseline-preserve@example.test', 'Preserve')",
      );
    },
  });
  await migrate(connection);
  const adopted = await snapshot(connection);
  assert.equal(adopted.history.length, legacyFiles.length + 1);
  assert.deepEqual(adopted.config, initial.config);
  assert.deepEqual(adopted.catalog, initial.catalog);
  assert.deepEqual(adopted.policy, initial.policy);
  await withClient({
    connection,
    run: async (client) => {
      assert.equal(
        (
          await client.query<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE email = $1", [
            "baseline-preserve@example.test",
          ])
        ).rows[0]?.count,
        1,
      );
      await client.query("DELETE FROM schema_migrations WHERE filename=$1", [MARKER]);
      await client.query("ALTER TABLE users ADD COLUMN baseline_unapproved text");
    },
  });
  await assert.rejects(migrate(connection), /schema does not match.*extra:.*column users.baseline_unapproved/);
  await withClient({
    connection,
    run: async (client) => {
      assert.equal(
        (
          await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM schema_migrations WHERE filename=$1",
            [MARKER],
          )
        ).rows[0]?.count,
        0,
      );
      await client.query("ALTER TABLE users DROP COLUMN baseline_unapproved");
      await client.query("DELETE FROM schema_migrations WHERE filename=$1", [legacyFiles[0]]);
    },
  });
  await assert.rejects(migrate(connection), /previous release.*missing: 0001_init.sql/);
  await withClient({
    connection,
    run: async (client) => {
      await client.query("INSERT INTO schema_migrations(filename) VALUES($1)", [legacyFiles[0]]);
      await client.query("INSERT INTO schema_migrations(filename) VALUES('9999_unknown.sql')");
    },
  });
  await assert.rejects(migrate(connection), /previous release.*extra: 9999_unknown.sql/);
}

async function verifyUntrackedPublicTable(input: { create: () => Promise<string> }): Promise<void> {
  const connection = await input.create();
  await withClient({
    connection,
    run: async (client) => {
      await client.query(`CREATE TABLE ${MANUAL_OBJECT}(id int)`);
    },
  });
  await assert.rejects(migrate(connection), /previous release.*extra:.*table baseline_untracked_object/);
}

async function applyProductionLoadTestAndProbeTriggers(client: Client): Promise<void> {
  await client.query(await readFile(PRODUCTION_LOAD_TEST_SQL, "utf8"));
  await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [PRODUCTION_LOAD_TEST_MIGRATION]);
  await insertJobsThroughLoadTestTriggers(client);
  // The later encryption cutover requires empty content tables, not synthetic trigger fixtures.
  await client.query("DELETE FROM meetings WHERE room_name = 'load-test-room'");
}

async function verifyProductionLoadTestHistory(input: {
  create: () => Promise<string>;
  migrationsDir: string;
  legacyFileCount: number;
}): Promise<void> {
  const connection = await input.create();
  await applyLegacySqlFiles({
    connection,
    migrationsDir: input.migrationsDir,
    afterFile: {
      file: PRODUCTION_LOAD_TEST_AFTER_FILE,
      run: applyProductionLoadTestAndProbeTriggers,
    },
  });
  await withClient({
    connection,
    run: async (client) => {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    },
  });
  await migrateViaRailwayStartPath(connection);
  await withClient({
    connection,
    run: async (client) => {
      const history = await client.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations WHERE filename = ANY($1::text[]) ORDER BY filename",
        [[MARKER, PRODUCTION_LOAD_TEST_MIGRATION]],
      );
      assert.deepEqual(
        history.rows.map((row) => row.filename),
        [PRODUCTION_LOAD_TEST_MIGRATION, MARKER],
      );
      assert.equal(
        (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations")).rows[0]?.count,
        input.legacyFileCount + MARKER_AND_LOAD_TEST_COUNT,
      );
      assert.equal(
        (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM load_test_runs")).rows[0]?.count,
        0,
      );
    },
  });
  assertApiServesHealth(connection);
  await withClient({
    connection,
    run: async (client) => {
      await client.query("DELETE FROM schema_migrations WHERE filename=$1", [MARKER]);
      await client.query("INSERT INTO schema_migrations(filename) VALUES('9999_unknown.sql')");
    },
  });
  await assert.rejects(migrate(connection), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /previous release.*extra: 9999_unknown.sql/);
    assert.doesNotMatch(error.message, /0110_production_load_test/);

    return true;
  });
}

async function verifyLegacyChainUpgrade(input: {
  create: () => Promise<string>;
  legacyFiles: string[];
}): Promise<void> {
  const legacyRoot = await mkdtemp(path.join(tmpdir(), "legacy-migrations-"));
  await execute("tar", ["-xzf", legacyArchive, "-C", legacyRoot]);
  const migrationsDir = path.join(legacyRoot, "migrations");
  try {
    const upgraded = await input.create();
    const applied = await applyLegacySqlFiles({ connection: upgraded, migrationsDir });
    assert.deepEqual(applied, input.legacyFiles);
    await withClient({
      connection: upgraded,
      run: async (client) => {
        await client.query(
          "INSERT INTO users(email, display_name) VALUES ('legacy-chain-preserve@example.test', 'Preserve')",
        );
      },
    });
    await migrateViaRailwayStartPath(upgraded);
    await verifyLegacyHistoryAndUser({ connection: upgraded, legacyFileCount: input.legacyFiles.length });
    await verifyLegacyPgStatStatements({ create: input.create, migrationsDir });
    await verifyLegacyQueuedDeletions({ create: input.create, migrationsDir });
    await verifyProductionLoadTestHistory({
      create: input.create,
      migrationsDir,
      legacyFileCount: input.legacyFiles.length,
    });
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }
}

void test(
  "baseline supports empty and fully upgraded databases, not partial history or schema drift",
  {
    skip: process.env.READYMEET_ISOLATED_DB !== "1",
    timeout: TIMEOUT_MS,
  },
  async (t) => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Use an isolated loopback database");
    const admin = new Client({ connectionString: url.href });
    await admin.connect();
    const names = { current: [] as string[] };
    t.after(async () => {
      await names.current.reduce(async (previous, name) => {
        await previous;
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }, Promise.resolve());
      await admin.end();
    });
    const create = async () => {
      const name = `baseline_test_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE "${name}"`);
      names.current = [...names.current, name];
      const connection = new URL(url);
      connection.pathname = `/${name}`;

      return connection.href;
    };

    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(new URL("../migrations/baseline.json", import.meta.url), "utf8")),
    );
    const fresh = await create();
    await Promise.all([migrate(fresh), migrate(fresh)]);

    const initial = await snapshot(fresh);
    assertInitialSnapshot(initial);
    await migrate(fresh);
    assert.deepEqual(await snapshot(fresh), initial, "Repeat startup preserves catalog and permanent cutoff");

    const baselineOnly = await create();
    await bootstrapBaseline(baselineOnly);
    await verifyAdoptedDriftAndHistory({
      connection: baselineOnly,
      legacyFiles: manifest.legacyFiles,
      initial: await snapshot(baselineOnly),
    });
    await verifySqlBillingMigrationAdoption(create);
    await verifyUntrackedPublicTable({ create });
    await verifyInterruptedBootstrap({ create, initial });
    await verifyColumnOrder({ create, legacyFiles: manifest.legacyFiles });
    await verifyRetainedAttachmentDeletions({ create, legacyFiles: manifest.legacyFiles });
    await verifyFreshPgcryptoAlreadyInstalled({ create });
    await verifyMixedEquivalentConstraint({ create, legacyFiles: manifest.legacyFiles });
    await verifyLegacyChainUpgrade({ create, legacyFiles: manifest.legacyFiles });
  },
);
