import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";

import { convertExistingContent } from "../adapters/secondary/postgres/content-cutover";
import { decryptContentFields, encryptContentFields } from "../adapters/secondary/postgres/content-encryption";
import { contentFingerprint } from "../adapters/secondary/postgres/content-fingerprint";

const PARALLEL_IMAGE_COUNT = 12;
const MAINTENANCE_TEST_TIMEOUT_MS = 30_000;
const SENTINEL = "Preserved content 日本語";
const FAILURE = "Injected object failure";
const MIGRATIONS = [
  "0_init",
  "0134_plan_credit_reservations",
  "0135_meeting_intelligence_settings",
  "0136_insufficient_credits_sqlstate",
];
const CONTENT_SQL = await readFile(
  new URL("../prisma/migrations/0137_meeting_content_encryption/migration.sql", import.meta.url),
  "utf8",
);

async function fixture(run: (input: { client: PoolClient; connection: string }) => Promise<void>): Promise<void> {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const admin = new Pool({ connectionString: base.href });
  const name = `readymeet_content_cutover_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  base.pathname = `/${name}`;
  const pool = new Pool({ connectionString: base.href });
  const client = await pool.connect();
  try {
    await client.query<Record<string, unknown>>("BEGIN");
    await MIGRATIONS.reduce(async (pending, migration) => {
      await pending;
      await client.query<Record<string, unknown>>(
        await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8"),
      );
    }, Promise.resolve());
    await client.query<Record<string, unknown>>("COMMIT");
    await run({ client, connection: base.href });
  } finally {
    await client.query<Record<string, unknown>>("ROLLBACK");
    client.release();
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

async function seed(client: PoolClient): Promise<string> {
  const id = randomUUID();
  await client.query<Record<string, unknown>>(
    "INSERT INTO users(id,email,display_name) VALUES ($1,'cutover@example.test','User')",
    [id],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO workspaces(id,name,created_by_user_id) VALUES ($1,'Workspace',$1)",
    [id],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO meetings(id,workspace_id,created_by_user_id,title,room_name) VALUES ($1::uuid,$1::uuid,$1::uuid,$2,$1::text)",
    [id, SENTINEL],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO transcripts(id,meeting_id,metadata) VALUES ($1,$1,'null'::jsonb)",
    [id],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO transcript_segments(id,transcript_id,speaker_identity,speaker_name,content,started_at) VALUES ($1,$1,'speaker','Speaker',$2,'2026-10-21T01:02:03.123456Z')",
    [id, SENTINEL],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO workspace_task_sections(id,workspace_id,title) VALUES ($1,$1,$2)",
    [id, SENTINEL],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO ashby_meeting_analyses(meeting_id,input_hash,result) VALUES ($1,'text-key','[1,null,{\"isNested\":true}]'::jsonb)",
    [id],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO meeting_assets(id,meeting_id,storage_key,content_hash,mime_type,byte_size,captured_at,trigger) VALUES ($1,$1,'meeting-assets/original','test-hash','image/png',12,now(),'manual')",
    [id],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO meeting_attendee_workspaces(meeting_id,user_id,workspace_id,assignment) VALUES ($1,$1,$1,'host_workspace') ON CONFLICT DO NOTHING",
    [id],
  );
  await client.query<Record<string, unknown>>(
    "INSERT INTO memory_sources(id,user_id,workspace_id,kind,external_id,meeting_id,occurred_at,revision,is_current) VALUES ($1::uuid,$1::uuid,$1::uuid,'meeting',$1::text,$1::uuid,now(),'original',true)",
    [id],
  );

  return id;
}

void test("content cutover preserves plaintext, JSON null, compound IDs, timestamps, images and memory state", async () =>
  fixture(async ({ client }) => {
    const id = await seed(client);
    const before = (await client.query<Record<string, unknown>>("SELECT to_jsonb(u) AS value FROM users u")).rows;
    const triggers = (
      await client.query<Record<string, unknown>>(
        "SELECT tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname",
      )
    ).rows;
    await client.query<Record<string, unknown>>("BEGIN");
    await convertExistingContent({
      client,
      sql: CONTENT_SQL,
      convertObject: async ({ storageKey }) => `${storageKey}.encrypted`,
    });
    await client.query<Record<string, unknown>>("COMMIT");
    const meeting = (await client.query<Record<string, unknown>>("SELECT id,title FROM meetings")).rows[0];
    assert.ok(meeting);
    assert.equal(meeting.id, id);
    assert.equal(
      (await decryptContentFields({ model: "meetings", recordId: id, fields: { title: meeting.title } })).title,
      SENTINEL,
    );
    const transcript = (await client.query<Record<string, unknown>>("SELECT metadata FROM transcripts")).rows[0];
    assert.ok(transcript);
    assert.equal(
      (await decryptContentFields({ model: "transcripts", recordId: id, fields: { metadata: transcript.metadata } }))
        .metadata,
      null,
    );
    const analysis = (await client.query<Record<string, unknown>>("SELECT result FROM ashby_meeting_analyses")).rows[0];
    assert.ok(analysis);
    assert.deepEqual(
      (
        await decryptContentFields({
          model: "ashbyMeetingAnalyses",
          recordId: JSON.stringify([id, "text-key"]),
          fields: { result: analysis.result },
        })
      ).result,
      [1, null, { isNested: true }],
    );
    assert.equal(
      (await client.query<Record<string, unknown>>("SELECT title_fingerprint FROM workspace_task_sections")).rows[0]
        ?.title_fingerprint,
      await contentFingerprint({ domain: "workspaceTaskSections.title", value: SENTINEL }),
    );
    assert.equal(
      String(
        (await client.query<Record<string, unknown>>("SELECT started_at::text FROM transcript_segments")).rows[0]
          ?.started_at,
      ).includes(".123456"),
      true,
    );
    assert.equal(
      (await client.query<Record<string, unknown>>("SELECT is_current FROM memory_sources")).rows[0]?.is_current,
      true,
    );
    assert.equal(
      (await client.query<Record<string, unknown>>("SELECT storage_key,transcript_excerpt FROM meeting_assets")).rows[0]
        ?.storage_key,
      "meeting-assets/original.encrypted",
    );
    assert.equal(
      (await client.query<Record<string, unknown>>("SELECT transcript_excerpt IS NULL AS empty FROM meeting_assets"))
        .rows[0]?.empty,
      true,
    );
    assert.deepEqual(
      (await client.query<Record<string, unknown>>("SELECT to_jsonb(u) AS value FROM users u")).rows,
      before,
    );
    assert.deepEqual(
      (
        await client.query<Record<string, unknown>>(
          "SELECT tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname",
        )
      ).rows,
      triggers,
    );
  }));

void test("failed cutover rolls back rows, schema and trigger state, then retries", async () =>
  fixture(async ({ client }) => {
    const id = await seed(client);
    await client.query(
      "INSERT INTO meeting_assets(meeting_id,storage_key,content_hash,mime_type,byte_size,captured_at,trigger) SELECT $1,'meeting-assets/parallel-'||n,'parallel-'||n,'image/png',12,now(),'manual' FROM generate_series(1,$2::int) n",
      [id, PARALLEL_IMAGE_COUNT],
    );
    const completed = new Set<string>();
    await client.query<Record<string, unknown>>("BEGIN");
    await assert.rejects(
      convertExistingContent({
        client,
        sql: CONTENT_SQL,
        convertObject: async ({ storageKey }) => {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          completed.add(storageKey);
          if (storageKey === "meeting-assets/original") {
            throw new Error(FAILURE);
          }

          return `${storageKey}.encrypted`;
        },
      }),
      /Injected object failure/u,
    );
    const settled = completed.size;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(completed.size, settled);
    await client.query<Record<string, unknown>>("ROLLBACK");
    assert.equal(
      (await client.query<Record<string, unknown>>("SELECT title FROM meetings WHERE id=$1", [id])).rows[0]?.title,
      SENTINEL,
    );
    assert.equal(
      (
        await client.query<Record<string, unknown>>(
          "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='workspace_task_sections' AND column_name='title_fingerprint'",
        )
      ).rows[0]?.count,
      0,
    );
    assert.equal(
      (
        await client.query<Record<string, unknown>>(
          "SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'",
        )
      ).rows[0]?.count,
      0,
    );
    await client.query<Record<string, unknown>>("BEGIN");
    await convertExistingContent({
      client,
      sql: CONTENT_SQL,
      convertObject: async ({ storageKey }) => `${storageKey}.encrypted`,
    });
    await client.query<Record<string, unknown>>("COMMIT");
  }));

void test("validated existing envelopes are retained; malformed envelopes fail closed", async () =>
  fixture(async ({ client }) => {
    const id = await seed(client);
    const encrypted = await encryptContentFields({ model: "meetings", recordId: id, fields: { title: SENTINEL } });
    await client.query<Record<string, unknown>>("ALTER TABLE meetings ALTER COLUMN title TYPE text");
    await client.query<Record<string, unknown>>("UPDATE meetings SET title=$1 WHERE id=$2", [encrypted.title, id]);
    await client.query<Record<string, unknown>>("BEGIN");
    await convertExistingContent({
      client,
      sql: CONTENT_SQL,
      convertObject: async ({ storageKey }) => `${storageKey}.encrypted`,
    });
    assert.equal(
      (await client.query<Record<string, unknown>>("SELECT title FROM meetings WHERE id=$1", [id])).rows[0]?.title,
      encrypted.title,
    );
    await client.query<Record<string, unknown>>("ROLLBACK");
    await client.query<Record<string, unknown>>("UPDATE meetings SET title='ready-content:v1:broken'");
    await client.query<Record<string, unknown>>("BEGIN");
    await assert.rejects(
      convertExistingContent({ client, sql: CONTENT_SQL, convertObject: async ({ storageKey }) => storageKey }),
    );
    await client.query<Record<string, unknown>>("ROLLBACK");
  }));

void test("maintenance records the exact Prisma checksum only after conversion commits", async () =>
  fixture(async ({ client, connection }) => {
    await seed(client);
    await client.query(
      "CREATE TABLE schema_migrations(filename text PRIMARY KEY, applied_at timestamptz DEFAULT now()); INSERT INTO schema_migrations(filename) VALUES ('0133_baseline.sql')",
    );
    // The fixture applied these prerequisite schemas directly, so mark only those completed migrations.
    await client.query(
      "CREATE TABLE _prisma_migrations(id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)",
    );
    await client.query(
      "INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name) SELECT gen_random_uuid()::text,repeat('0',64),now(),unnest($1::text[])",
      [MIGRATIONS.filter((name) => name !== "0_init")],
    );
    const execute = promisify(execFile);
    const run = (shouldFail: boolean) =>
      execute(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./tests/content-key-preload.ts",
          "--input-type=module",
          "--eval",
          `import {preserveMeetingContent} from './adapters/secondary/postgres/content-cutover.ts'; await preserveMeetingContent(async ({storageKey})=>{if(${String(shouldFail)})throw new Error('injected');return storageKey+'.encrypted'})`,
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: { ...process.env, DATABASE_URL: connection },
          timeout: MAINTENANCE_TEST_TIMEOUT_MS,
        },
      );
    await assert.rejects(run(true));
    assert.equal(
      (
        await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name='0137_meeting_content_encryption'",
        )
      ).rows[0]?.count,
      0,
    );
    await client.query(
      "INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name) VALUES (gen_random_uuid()::text,repeat('0',64),now(),'0138_unexpected')",
    );
    await assert.rejects(run(false), (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error);
      assert.equal(String(error.stderr).includes("Unexpected later migration"), true);

      return true;
    });
    assert.equal((await client.query<{ title: string }>("SELECT title FROM meetings")).rows[0]?.title, SENTINEL);
    await client.query("DELETE FROM _prisma_migrations WHERE migration_name='0138_unexpected'");
    await client.query(
      "INSERT INTO _prisma_migrations(id,checksum,rolled_back_at,migration_name) VALUES (gen_random_uuid()::text,repeat('0',64),now(),'0137_meeting_content_encryption')",
    );
    await run(false);
    assert.equal(
      (
        await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name='0137_meeting_content_encryption' AND finished_at IS NOT NULL",
        )
      ).rows[0]?.count,
      1,
    );
    assert.equal(
      (
        await client.query<{ checksum: string }>(
          "SELECT checksum FROM _prisma_migrations WHERE migration_name='0137_meeting_content_encryption' AND finished_at IS NOT NULL",
        )
      ).rows[0]?.checksum,
      createHash("sha256").update(CONTENT_SQL).digest("hex"),
    );
    await assert.rejects(run(false));
  }));
