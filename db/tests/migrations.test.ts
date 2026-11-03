import assert from "node:assert/strict";
import { after, test } from "node:test";

import { pool } from "../adapters/secondary/postgres/client";
import { runMigrations } from "../adapters/secondary/postgres/migrations";

const FAILURE_MESSAGE = "Injected migration failure";
after(() => pool.end());
void test("migrator locks before schema creation and destroys its session on failure", async (t) => {
  const state: { queries: string[]; isDestroyed: boolean } = { queries: [], isDestroyed: false };
  t.mock.method(pool, "connect", async () => ({
    query: async (text: string) => {
      state.queries = [...state.queries, text];
      if (state.queries.length > 1) {
        throw new Error(FAILURE_MESSAGE);
      }

      return { rows: [] };
    },
    release: (shouldDestroy: boolean) => {
      state.isDestroyed = shouldDestroy;
    },
  }));
  // runMigrations owns pool shutdown; mock it so the file cleanup can close it once.
  const end = t.mock.method(pool, "end", async () => undefined);
  await assert.rejects(runMigrations(), { message: FAILURE_MESSAGE });
  assert.equal(state.queries[0]?.includes("advisory_lock"), true);
  assert.equal(state.queries[1]?.includes("schema_migrations"), true);
  assert.equal(state.isDestroyed, true);
  assert.equal(end.mock.callCount(), 1);
});
