import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "pg";

import { dbEnv } from "../adapters/secondary/postgres/env";
import {
  ensureShadowDatabase,
  nextMigrationDirectory,
  shadowDatabaseUrl,
} from "../adapters/secondary/postgres/migration-authoring";
import { runPrismaCli } from "../adapters/secondary/postgres/migrations";

const TIMEOUT_MS = 180_000;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

void test("new migrations continue the numbered sequence and ignore Prisma timestamps", () => {
  const existing = [
    "0_init",
    "0134_plan_credit_reservations",
    "0136_insufficient_credits_sqlstate",
    "20261021235100_draft",
    "migration_lock.toml",
  ];
  assert.equal(nextMigrationDirectory({ existing, name: "add_meeting_tags" }), "0137_add_meeting_tags");
  assert.throws(() => nextMigrationDirectory({ existing, name: "Add Tags" }));
});

void test("the shadow database defaults to <database>_shadow and honours SHADOW_DATABASE_URL", () => {
  const databaseUrl = "postgres://user@127.0.0.1:5432/readymeet_dev";
  assert.equal(new URL(shadowDatabaseUrl({ databaseUrl })).pathname, "/readymeet_dev_shadow");
  const configured = "postgres://user@127.0.0.1:5432/elsewhere";
  assert.equal(shadowDatabaseUrl({ databaseUrl, configured }), configured);
});

void test(
  "Prisma can replay every migration (0_init included) into a shadow database and finds no schema drift",
  { skip: process.env.READYMEET_ISOLATED_DB !== "1", timeout: TIMEOUT_MS },
  async (t) => {
    const url = new URL(dbEnv.DATABASE_URL);
    assert.ok(LOOPBACK_HOSTS.includes(url.hostname), "Use an isolated loopback database");
    const shadow = new URL(dbEnv.DATABASE_URL);
    shadow.pathname = `/readymeet_shadow_${randomUUID().replaceAll("-", "")}`;
    t.after(async () => {
      const admin = new Client({ connectionString: dbEnv.DATABASE_URL });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${shadow.pathname.slice(1)}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });
    await ensureShadowDatabase({ shadowUrl: shadow.toString() });
    // --exit-code: 0 when prisma/schema.prisma matches the replayed migrations, 2 when a migration is missing.
    const output = await runPrismaCli({
      args: [
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      databaseUrl: dbEnv.DATABASE_URL,
      shadowDatabaseUrl: shadow.toString(),
    });
    assert.match(output, /No difference detected|empty/i);
  },
);
