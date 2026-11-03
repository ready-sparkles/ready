import type { FastifyRequest } from "fastify";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { guestRecognitionRateKey } from "../../adapters/primary/http/support/guest-recognition-proxy";
import { apiEnv } from "../../composition/env";

const SHA256_HEX_LENGTH = 64;
const PROXY_SIGNATURE_STALE_MS = 120_000;
const REQUEST_CAPTURE_FAILED_MESSAGE = "Expected Fastify request to be captured.";

const HTTP_REMOVE_METHOD = "DELETE" as const;
const INJECT_METHODS = ["GET", "POST", "PUT", "PATCH", HTTP_REMOVE_METHOD] as const;

function isInjectMethod(value: string): value is (typeof INJECT_METHODS)[number] {
  return INJECT_METHODS.some((method) => method === value);
}

async function captureGuestRecognitionRequest(input: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
}): Promise<FastifyRequest> {
  const { method } = input;
  assert.ok(isInjectMethod(method));
  const app = Fastify();
  const capturedHolder: { request?: FastifyRequest } = {};
  app.addHook("onRequest", (request, _reply, done) => {
    capturedHolder.request = request;
    done();
  });
  app.route({ method, url: input.url, handler: async () => "ok" });
  await app.ready();
  await app.inject({ method, url: input.url, headers: input.headers });
  await app.close();
  if (capturedHolder.request === undefined) {
    throw new Error(REQUEST_CAPTURE_FAILED_MESSAGE);
  }

  return capturedHolder.request;
}

void test("only a fresh signed proxy address changes the rate-limit key", async () => {
  const secret = "proxy-test-secret-long-enough-for-validation";
  const restoreSecret = swapGuestRecognitionProxySecret(secret);
  try {
    const timestamp = String(Date.now());
    const client = "client-address-hash";
    const method = "POST";
    const url = "/v1/meeting-links/abc/join-requests";
    const sign = (time: string) =>
      createHmac("sha256", secret).update(`${method}:${url}:${time}:${client}`).digest("hex");
    const request = (value: string) =>
      captureGuestRecognitionRequest({
        method,
        url,
        headers: { "x-ready-guest-proxy": value },
      });
    const validRequest = await request(`${timestamp}.${client}.${sign(timestamp)}`);
    assert.equal(guestRecognitionRateKey(validRequest), `guest-proxy:${client}`);

    const invalidSignatureRequest = await request(`${timestamp}.${client}.${"a".repeat(SHA256_HEX_LENGTH)}`);
    assert.equal(guestRecognitionRateKey(invalidSignatureRequest), invalidSignatureRequest.ip);

    const old = String(Date.now() - PROXY_SIGNATURE_STALE_MS);
    const staleRequest = await request(`${old}.${client}.${sign(old)}`);
    assert.equal(guestRecognitionRateKey(staleRequest), staleRequest.ip);

    const replayProxyHeader = validRequest.headers["x-ready-guest-proxy"];
    const replayHeaders: Record<string, string> =
      typeof replayProxyHeader === "string" ? { "x-ready-guest-proxy": replayProxyHeader } : {};
    const replay = await captureGuestRecognitionRequest({
      method: "POST",
      url: "/v1/another-path",
      headers: replayHeaders,
    });
    assert.equal(guestRecognitionRateKey(replay), replay.ip);
  } finally {
    restoreSecret();
  }
});

function swapGuestRecognitionProxySecret(nextSecret: string): () => void {
  const previousSecret = apiEnv.GUEST_RECOGNITION_PROXY_SECRET;
  apiEnv.GUEST_RECOGNITION_PROXY_SECRET = nextSecret;

  return () => {
    apiEnv.GUEST_RECOGNITION_PROXY_SECRET = previousSecret;
  };
}
