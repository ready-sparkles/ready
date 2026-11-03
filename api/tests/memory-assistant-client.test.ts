import {
  INSUFFICIENT_AI_CREDITS_MESSAGE,
  INSUFFICIENT_CREDITS_CODE,
  INSUFFICIENT_CREDITS_USER_MESSAGE,
  MEMORY_EXTRACTION_REQUEST_TIMEOUT_MS,
  MEMORY_MODEL_TIMEOUT_MS,
  type MemoryGenerationInput,
} from "@readymeet/shared";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";

import { triggerMemoryGeneration, triggerPostCallSummary } from "../adapters/secondary/undici/assistant-client";
import { apiEnv } from "../composition/env";

const memoryGenerationInputFixture = z
  .custom<MemoryGenerationInput>((_value): _value is MemoryGenerationInput => true)
  .parse({});

const WORKER_STOPPED_MESSAGE = "worker stopped";

function readAssistantServiceEnv(): { url: string; secret: string } {
  return {
    url: apiEnv.ASSISTANT_SERVICE_URL,
    secret: apiEnv.ASSISTANT_SERVICE_SECRET,
  };
}

function applyAssistantServiceEnv(options: { url: string; secret: string }): void {
  apiEnv.ASSISTANT_SERVICE_URL = options.url;
  apiEnv.ASSISTANT_SERVICE_SECRET = options.secret;
}

function portFromListenAddress(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string") {
    assert.fail();
  }

  return address.port;
}

void test("worker cancellation aborts the memory request and prevents subsequent calls", async (t) => {
  const calls = { count: 0 };
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls.count += 1;
    const signal = options.signal;
    assert.ok(signal);

    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const pending = assert.rejects(
    triggerMemoryGeneration(memoryGenerationInputFixture, { jobId: "job", leaseToken: "lease" }, controller.signal),
    new RegExp(WORKER_STOPPED_MESSAGE),
  );
  await setImmediate();
  controller.abort(new Error(WORKER_STOPPED_MESSAGE));
  await pending;
  await assert.rejects(
    triggerMemoryGeneration(memoryGenerationInputFixture, { jobId: "job", leaseToken: "lease" }, controller.signal),
    new RegExp(WORKER_STOPPED_MESSAGE),
  );
  assert.equal(calls.count, 1);
});

void test("memory dispatcher works with the runtime fetch over a real local connection", async () => {
  const previousEnv = readAssistantServiceEnv();
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ value: { memories: [], people: [] }, model: "fixture" }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const hasTcpAddress = address !== null && typeof address !== "string";
    assert.ok(hasTcpAddress);
    applyAssistantServiceEnv({ url: `http://127.0.0.1:${portFromListenAddress(address)}`, secret: "fixture" });
    assert.deepEqual(
      await triggerMemoryGeneration(memoryGenerationInputFixture, {
        jobId: "job",
        leaseToken: "lease",
      }),
      {
        value: { memories: [], people: [] },
        model: "fixture",
      },
    );
  } finally {
    applyAssistantServiceEnv(previousEnv);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

void test("memory waits beyond the old model and transport limits, with no change to notes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const captured: {
    memorySignal: AbortSignal | null;
    release: (() => void) | null;
  } = { memorySignal: null, release: null };
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit & { dispatcher?: unknown }) => {
    const signal = options.signal;
    assert.ok(signal);
    if (url.includes("/memory/")) {
      assert.ok(
        options.dispatcher !== null && options.dispatcher !== undefined,
        "memory uses its own long-request dispatcher",
      );
      captured.memorySignal = signal;
      await new Promise<void>((resolve) => {
        captured.release = resolve;
      });
    } else {
      assert.equal(options.dispatcher, undefined, "notes retain their existing transport");
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }

    return new Response(JSON.stringify({ value: { memories: [], people: [] }, model: "fixture" }));
  });
  const memory = triggerMemoryGeneration(memoryGenerationInputFixture, {
    jobId: "job",
    leaseToken: "lease",
  });
  const notes = assert.rejects(triggerPostCallSummary("fixture"), /timed out/);
  await setImmediate();
  t.mock.timers.tick(apiEnv.ASSISTANT_SERVICE_SUMMARY_TIMEOUT_MS);
  await notes;
  t.mock.timers.tick(MEMORY_MODEL_TIMEOUT_MS - apiEnv.ASSISTANT_SERVICE_SUMMARY_TIMEOUT_MS);
  assert.ok(captured.memorySignal);
  assert.equal(captured.memorySignal.aborted, false, "the API waits longer than the 10-minute model budget");
  assert.ok(captured.release);
  captured.release();
  await memory;
  t.mock.timers.tick(MEMORY_EXTRACTION_REQUEST_TIMEOUT_MS);
  assert.equal(captured.memorySignal.aborted, false, "successful requests clear their deadline");
});

void test("memory deadline also cancels a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const captured: { signal: AbortSignal | null } = { signal: null };
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const signal = options.signal;
    assert.ok(signal);
    captured.signal = signal;

    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }),
    );
  });
  const rejected = assert.rejects(
    triggerMemoryGeneration(memoryGenerationInputFixture, { jobId: "job", leaseToken: "lease" }),
    /timed out/,
  );
  await setImmediate();
  t.mock.timers.tick(MEMORY_EXTRACTION_REQUEST_TIMEOUT_MS - 1);
  assert.ok(captured.signal);
  assert.equal(captured.signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
});

const assistantErrorSchema = z.object({
  statusCode: z.number(),
  code: z.string().optional(),
  message: z.string(),
  responseText: z.string(),
});

void test("summary credit rejection preserves HTTP 402 with a user-facing message and code", async (t) => {
  const statusCode = 402;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: INSUFFICIENT_CREDITS_CODE, message: INSUFFICIENT_AI_CREDITS_MESSAGE },
      { status: statusCode },
    ),
  );
  await assert.rejects(triggerPostCallSummary("meeting"), (error: unknown) => {
    const parsed = assistantErrorSchema.parse(error);
    assert.equal(parsed.statusCode, statusCode);
    assert.equal(parsed.code, INSUFFICIENT_CREDITS_CODE);
    assert.equal(parsed.message, INSUFFICIENT_CREDITS_USER_MESSAGE);
    assert.ok(parsed.responseText.includes(INSUFFICIENT_AI_CREDITS_MESSAGE));

    return true;
  });
});

void test("a 402 without a JSON code body still reports insufficient_credits", async (t) => {
  const statusCode = 402;
  t.mock.method(globalThis, "fetch", async () => new Response("payment required", { status: statusCode }));
  await assert.rejects(triggerPostCallSummary("meeting"), (error: unknown) => {
    const parsed = assistantErrorSchema.parse(error);
    assert.equal(parsed.statusCode, statusCode);
    assert.equal(parsed.code, INSUFFICIENT_CREDITS_CODE);
    assert.equal(parsed.message, INSUFFICIENT_CREDITS_USER_MESSAGE);

    return true;
  });
});

void test("a non-402 assistant failure stays a 500 without a code", async (t) => {
  const upstreamStatus = 503;
  const internalStatus = 500;
  t.mock.method(globalThis, "fetch", async () => new Response("upstream down", { status: upstreamStatus }));
  await assert.rejects(triggerPostCallSummary("meeting"), (error: unknown) => {
    const parsed = assistantErrorSchema.parse(error);
    assert.equal(parsed.statusCode, internalStatus);
    assert.equal(parsed.code, undefined);
    assert.match(parsed.message, /Assistant service error \(503\): upstream down/);

    return true;
  });
});
