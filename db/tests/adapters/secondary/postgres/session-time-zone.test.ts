import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";

import { withUtcSessionTimeZone } from "../../../../adapters/secondary/postgres/client";
import { dbEnv } from "../../../../adapters/secondary/postgres/env";

import { SESSION_TIME_ZONE_RESULT_MARKER } from "./session-time-zone-probe";

const NON_UTC_ZONE = "America/Los_Angeles";
const PROBE_PATH = fileURLToPath(new URL("session-time-zone-probe.ts", import.meta.url));
const UTC_ZONE = "UTC";
const probeResultSchema = z.object({ zone: z.string(), age: z.number(), jsSkew: z.number() });
const PACKAGE_DIR = fileURLToPath(new URL("../../../../", import.meta.url));
const PROBE_TIMEOUT_MS = 60_000;
const MAX_CLOCK_SKEW_SECONDS = 5;

/** A connection whose server-side session default is a non-UTC zone, like a self-hosted Postgres. */
function nonUtcDatabaseUrl(): string {
  const url = new URL(dbEnv.DATABASE_URL);
  url.searchParams.set("options", `-c TimeZone=${NON_UTC_ZONE}`);

  return url.toString();
}

void test("the test connection really defaults to a non-UTC session zone", async () => {
  const client = new Client({ connectionString: nonUtcDatabaseUrl() });
  await client.connect();
  try {
    const result = await client.query<{ zone: string }>("SELECT current_setting('TimeZone') AS zone");
    assert.equal(result.rows[0]?.zone, NON_UTC_ZONE);
  } finally {
    await client.end();
  }
});

void test("Prisma writes on a non-UTC database store created_at at the database's now()", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", PROBE_PATH], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: nonUtcDatabaseUrl(), SESSION_TIME_ZONE_PROBE: "1" },
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  });
  const line = result.stdout.split("\n").find((entry) => entry.startsWith(SESSION_TIME_ZONE_RESULT_MARKER)) ?? "";
  assert.notEqual(line, "", `probe failed: ${result.stderr}`);
  const parsed = probeResultSchema.parse(JSON.parse(line.slice(SESSION_TIME_ZONE_RESULT_MARKER.length)));
  assert.equal(parsed.zone, UTC_ZONE);
  // Before the fix, created_at landed seven or eight hours in the future (age about -25200 s).
  assert.ok(Math.abs(parsed.age) < MAX_CLOCK_SKEW_SECONDS, `age ${String(parsed.age)}`);
  assert.ok(Math.abs(parsed.jsSkew) < MAX_CLOCK_SKEW_SECONDS, `jsSkew ${String(parsed.jsSkew)}`);
});

void test("the UTC session option is appended after any startup options the URL already carries", () => {
  const plain = new URL(withUtcSessionTimeZone("postgres://user:pass@db.example:5432/app"));
  assert.equal(plain.searchParams.get("options"), "-c TimeZone=UTC");

  const existing = new URL(
    withUtcSessionTimeZone(
      "postgres://user:pass@db.example:5432/app?sslmode=require&options=-c%20TimeZone%3DEurope%2FBerlin",
    ),
  );
  assert.equal(existing.searchParams.get("options"), "-c TimeZone=Europe/Berlin -c TimeZone=UTC");
  assert.equal(existing.searchParams.get("sslmode"), "require");
});
