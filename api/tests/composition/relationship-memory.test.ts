import {
  actOnMemories,
  closeDbPool,
  consumeMemoryGeneration,
  db,
  listRelationshipMemories,
  readMemoryProjection,
} from "@readymeet/db";
import { fixtureGeneration, memoryFixture } from "@readymeet/db/testing/memory";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";

import { memoryRoutes } from "../../adapters/primary/http/routes/memory";
import { signAuthToken } from "../../adapters/primary/http/support/auth";
import { processMemoryJob } from "../../application/relationship-memory";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_GONE = 410;

const RELATIONSHIP_MEMORY_TEST_MESSAGES = {
  memoryFixtureDidNotEnqueueSource: "Memory fixture did not enqueue a source",
  memoryFixtureInputMissingPerson: "Memory fixture input is missing a person",
  expectedClaimedMemoryJob: "Expected a claimed memory job",
  expectedRelationshipMemory: "Expected a relationship memory",
  eventDispatchMustNotCallProvider: "Event dispatch must not call a provider",
  expectedFetchBodyString: "Expected fetch body to be a string",
};

const memoryGenerationAuthSchema = z.object({
  jobId: z.string(),
  leaseToken: z.string(),
  ownerUserId: z.string(),
  meetingId: z.string(),
  historyMemoryIds: z.array(z.string()).optional(),
});

const memoryPersonViewSchema = z.object({
  projection: z.unknown().nullable(),
  memories: z.array(z.unknown()),
  /** @external memory person processing wire field */
  processing: z.boolean(),
});

after(closeDbPool);
[false, true].forEach((isExternal) => {
  void test(
    `one future ${isExternal ? "external" : "native"} meeting publishes memories and summary in one call`,
    { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
    async (t) => {
      const f = await memoryFixture({ external: isExternal });
      const app = Fastify();
      try {
        const { source, input, job } = await f.enqueue();
        if (source === undefined || input === null) {
          throw new Error(RELATIONSHIP_MEMORY_TEST_MESSAGES.memoryFixtureDidNotEnqueueSource);
        }
        const person = input.people[0];
        if (person === undefined) {
          throw new Error(RELATIONSHIP_MEMORY_TEST_MESSAGES.memoryFixtureInputMissingPerson);
        }
        if (job === null) {
          throw new Error(RELATIONSHIP_MEMORY_TEST_MESSAGES.expectedClaimedMemoryJob);
        }
        const calls = { count: 0 };
        t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
          calls.count += 1;
          const body = options?.body;
          if (typeof body !== "string") {
            throw new Error(RELATIONSHIP_MEMORY_TEST_MESSAGES.expectedFetchBodyString);
          }
          const request = memoryGenerationAuthSchema.parse(JSON.parse(body));
          assert.equal(request.jobId, job.id);
          assert.equal(request.leaseToken, job.leaseToken);
          await consumeMemoryGeneration(request);

          return new Response(JSON.stringify({ model: "fixture", value: fixtureGeneration(input) }));
        });
        await processMemoryJob(job);
        assert.equal(calls.count, 1);
        const savedJobs = await db.memoryGenerationLedger.findMany({
          where: { jobId: job.id },
        });
        assert.ok(savedJobs[0]?.completedAt);
        const memories = await listRelationshipMemories({ sourceIds: [source.id] });
        assert.equal(memories.length, 1);
        const summary = await readMemoryProjection({ personId: person.id, sourceIds: [source.id] });
        assert.ok(summary !== null && summary.summary.length !== 0);
        assert.equal((await f.enqueue()).job, null);
        const token = signAuthToken({
          sub: f.userId,
          email: `${f.userId}@memory-fixture.test`,
          displayName: "Fixture",
          workspaceId: f.workspaceId,
        });
        const authHeaders = { authorization: `Bearer ${token}` };
        await app.register(memoryRoutes, { prefix: "/v1" });
        const path = `/v1/workspaces/${f.workspaceId}/memory`;
        // Reads and retired retry endpoint must not call any assistant endpoint.
        await [path, `${path}/people`, `${path}/people/${person.id}`, `${path}/status`].reduce(
          async (previous, url) => {
            await previous;
            const response = await app.inject({ url, headers: authHeaders });
            assert.equal(response.statusCode, HTTP_STATUS_OK, response.body);
          },
          Promise.resolve(),
        );
        assert.equal(
          (await app.inject({ method: "POST", url: `${path}/retry`, headers: authHeaders })).statusCode,
          HTTP_STATUS_GONE,
        );
        const memory = memories[0];
        if (memory === undefined) {
          throw new Error(RELATIONSHIP_MEMORY_TEST_MESSAGES.expectedRelationshipMemory);
        }
        await actOnMemories({ sourceIds: [source.id], ids: [memory.id], action: "forget" });
        const personViewResponse = await app.inject({ url: `${path}/people/${person.id}`, headers: authHeaders });
        const personViewBody: unknown = personViewResponse.json();
        const personView = memoryPersonViewSchema.parse(personViewBody);
        // The only summary line cited the forgotten memory, so Forget removes it from the person view too.
        assert.equal(personView.projection, null);
        assert.deepEqual(personView.memories, []);
        assert.equal(personView.processing, false);
        assert.equal(calls.count, 1);
      } finally {
        await app.close();
        await f.cleanup();
      }
    },
  );
});
