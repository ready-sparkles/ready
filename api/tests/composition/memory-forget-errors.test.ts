import { closeDbPool, listRelationshipMemories, persistMemoryExtraction, pool } from "@readymeet/db";
import { fixtureGeneration, memoryFixture } from "@readymeet/db/testing/memory";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { z } from "zod";

import { apiErrorResponse } from "../../adapters/primary/http/error-handler";
import { memoryRoutes } from "../../adapters/primary/http/routes/memory";
import { signAuthToken } from "../../adapters/primary/http/support/auth";

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const FIXTURE_VALUE_MISSING_MESSAGE = "Expected memory fixture value";
const MEMORY_NOT_FOUND_MESSAGE = "Memory not found";
const MEMORY_BUSY_CODE = "memory_busy";
const messageSchema = z.object({ message: z.string() }).strict();
const busyBodySchema = z.object({ code: z.string(), message: z.string() });

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error(FIXTURE_VALUE_MISSING_MESSAGE);
  }

  return value;
}

after(closeDbPool);

void test(
  "Forget: missing memory is 404, a locked summary is a retryable 503, and the retry succeeds",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const f = await memoryFixture();
    const app = Fastify();
    app.setErrorHandler((error, request, reply) => apiErrorResponse({ error, request, reply }));
    const locker = await pool.connect();
    try {
      const generation = await f.enqueue();
      const job = required(generation.job);
      const source = required(generation.source);
      const input = required(generation.input);
      const value = fixtureGeneration(input);
      await persistMemoryExtraction({
        job,
        source,
        candidates: value.memories,
        model: "fixture",
        generation: { value, history: [], sourceIds: [source.id], inputSources: [source], language: "English" },
      });
      const personId = required(input.people[0]).id;
      const memoryId = required((await listRelationshipMemories({ sourceIds: [source.id] }))[0]).id;
      const token = signAuthToken({
        sub: f.userId,
        email: `${f.userId}@memory-fixture.test`,
        displayName: "Fixture",
        workspaceId: f.workspaceId,
      });
      await app.register(memoryRoutes, { prefix: "/v1" });
      const forget = async (ids: string[]) =>
        app.inject({
          method: "POST",
          url: `/v1/workspaces/${f.workspaceId}/memory/actions`,
          headers: { authorization: `Bearer ${token}` },
          payload: { action: "forget", ids },
        });

      const missing = await forget([randomUUID()]);
      assert.equal(missing.statusCode, HTTP_NOT_FOUND);
      assert.deepEqual(messageSchema.parse(missing.json()), { message: MEMORY_NOT_FOUND_MESSAGE });

      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM memory_person_projections WHERE person_id = $1 FOR UPDATE", [personId]);
      const busy = await forget([memoryId]);
      assert.equal(busy.statusCode, HTTP_SERVICE_UNAVAILABLE);
      assert.equal(busy.headers["retry-after"], "5");
      assert.equal(busyBodySchema.parse(busy.json()).code, MEMORY_BUSY_CODE);
      await locker.query("ROLLBACK");

      const retried = await forget([memoryId]);
      assert.equal(retried.statusCode, HTTP_OK, retried.body);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      await app.close();
      await f.cleanup();
    }
  },
);
