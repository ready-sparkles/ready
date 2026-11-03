import "../../composition/wire";
import "../../adapters/secondary/node/env";

import Fastify from "fastify";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { get } from "node:http";
import test from "node:test";
import { z } from "zod";

import { withMemoryRequestSignal } from "../../adapters/primary/http/memory-request";
import { createMemoryModelRunner } from "../../application/relationship-memory";
import { assistantEnv } from "../../ports/assistant-env";
import { repositories } from "../../ports/repository-runtime";
import { mockAssistantUsageMetering } from "../usage-metering-fixture";

const EXPECTED_REQUEST_SIGNAL_ERROR = "Expected a request signal";
const EXPECTED_MOCK_STREAM_ERROR = "Expected mock stream";
const EXPECTED_MOCK_REQUEST_ERROR = "Expected mock request";

const MEMORY_REQUEST_TEST_MESSAGES = {
  fixturePrompt: "fixture",
  fixtureMeetingId: "fixture",
  fixtureOperationName: "fixture",
} as const;

void test("closing a real worker connection aborts the assistant model request", async (t) => {
  mockAssistantUsageMetering(t);
  t.mock.method(repositories(), "consumeMemoryGeneration", async () => undefined);
  const previousKey = assistantEnv().AI_GATEWAY_API_KEY;
  assistantEnv().AI_GATEWAY_API_KEY = "fixture-not-a-real-key";
  t.after(() => {
    assistantEnv().AI_GATEWAY_API_KEY = previousKey;
  });
  const modelEvents = new EventEmitter();
  const modelStarted = once(modelEvents, "started");
  const modelCancelled = once(modelEvents, "cancelled");
  const requests = new Map<number, string>();
  t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    requests.set(requests.size, String(url));
    const signal = options.signal;
    if (!signal) {
      throw new Error(EXPECTED_REQUEST_SIGNAL_ERROR);
    }
    const result = new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          modelEvents.emit("cancelled");
          reject(signal.reason);
        },
        { once: true },
      );
    });
    modelEvents.emit("started");

    return result;
  });
  const app = Fastify();
  app.get("/memory", (request, reply) =>
    withMemoryRequestSignal({
      request,
      reply,
      operation: (signal) =>
        createMemoryModelRunner({
          signal,
          authorization: {
            jobId: "job",
            leaseToken: "lease",
            ownerUserId: "owner",
            meetingId: "fixture",
          },
        }).run({
          prompt: MEMORY_REQUEST_TEST_MESSAGES.fixturePrompt,
          payload: {},
          schema: z.object({}),
          name: MEMORY_REQUEST_TEST_MESSAGES.fixtureOperationName,
          meetingId: MEMORY_REQUEST_TEST_MESSAGES.fixtureMeetingId,
        }),
    }),
  );
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const request = get(`${address}/memory`);
  request.on("error", () => {});
  try {
    await modelStarted;
    request.destroy();
    await modelCancelled;
    assert.equal(requests.size, 1);
  } finally {
    request.destroy();
    await app.close();
  }
});

type MockStream = ServerResponse;
type MockRequestRaw = IncomingMessage;

function isMockStream(stream: object): stream is MockStream {
  return (
    typeof Reflect.get(stream, "writableFinished") === "boolean" &&
    typeof Reflect.get(stream, "destroyed") === "boolean"
  );
}

function createMockStream(): MockStream {
  const stream = new EventEmitter();
  const fields: Pick<MockStream, "writableFinished" | "destroyed"> = {
    writableFinished: false,
    destroyed: false,
  };
  Object.assign(stream, fields);
  if (!isMockStream(stream)) {
    throw new Error(EXPECTED_MOCK_STREAM_ERROR);
  }

  return stream;
}

function isMockRequestRaw(raw: object): raw is MockRequestRaw {
  return typeof Reflect.get(raw, "destroyed") === "boolean" && typeof Reflect.get(raw, "complete") === "boolean";
}

function createMockRequestRaw(): MockRequestRaw {
  const raw = new EventEmitter();
  const fields: Pick<MockRequestRaw, "destroyed" | "complete"> = {
    destroyed: false,
    complete: true,
  };
  Object.assign(raw, fields);
  if (!isMockRequestRaw(raw)) {
    throw new Error(EXPECTED_MOCK_REQUEST_ERROR);
  }

  return raw;
}

function connection(): {
  raw: MockStream;
  request: Parameters<typeof withMemoryRequestSignal>[0]["request"];
  reply: Parameters<typeof withMemoryRequestSignal>[0]["reply"];
} {
  const raw = createMockStream();

  return {
    raw,
    request: {
      raw: createMockRequestRaw(),
    },
    reply: { raw },
  };
}
void test("memory response disconnect cancels the model and removes listeners", async () => {
  const { raw, request, reply } = connection();
  const signalRef: { current?: AbortSignal } = {};
  const pending = withMemoryRequestSignal({
    request,
    reply,
    operation: async (signal) => {
      signalRef.current = signal;

      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    },
  });
  const rejected = assert.rejects(pending, /disconnected/);
  raw.emit("close");
  await rejected;
  assert.ok(signalRef.current);
  assert.equal(signalRef.current.aborted, true);
  assert.equal(raw.listenerCount("close"), 0);
});
void test("normal completion cleans up without cancelling completed model work", async () => {
  const { raw, request, reply } = connection();
  const signalRef: { current?: AbortSignal } = {};
  assert.equal(
    await withMemoryRequestSignal({
      request,
      reply,
      operation: async (signal) => {
        signalRef.current = signal;

        return "done";
      },
    }),
    "done",
  );
  Object.assign(raw, {
    /** @external Node ServerResponse field */
    writableFinished: true,
  });
  raw.emit("close");
  assert.ok(signalRef.current);
  assert.equal(signalRef.current.aborted, false);
  assert.equal(raw.listenerCount("close"), 0);
});
void test("already disconnected requests never start a model call", async () => {
  const { raw, request, reply } = connection();
  Object.assign(raw, {
    /** @external Node stream field */
    destroyed: true,
  });
  await assert.rejects(
    withMemoryRequestSignal({
      request,
      reply,
      operation: async () => {
        assert.fail("must not start");
      },
    }),
    /disconnected/,
  );
  assert.equal(raw.listenerCount("close"), 0);
});
