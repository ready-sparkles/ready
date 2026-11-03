import "../composition/wire";

import Fastify from "fastify";
import assert from "node:assert/strict";
import test from "node:test";

import { internalRoutes } from "../adapters/primary/http/routes";

void test("closing an idle assistant does not stop shared transcription sessions", async (t) => {
  const requestLog = { items: [] as unknown[] };
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    requestLog.items = [...requestLog.items, url];

    return Response.json({ status: "ok", activeMeetings: 0 });
  });
  const app = Fastify();
  await app.register(internalRoutes);
  await app.ready();
  await app.close();
  assert.deepEqual(requestLog.items, []);
});
