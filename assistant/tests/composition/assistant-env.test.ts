import assert from "node:assert/strict";
import test from "node:test";

import { assistantEnvSchema } from "../../ports/assistant-env";

const requiredEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/readymeet",
  ASSISTANT_SERVICE_SECRET: "test-secret",
};

const productionEnv = {
  ...requiredEnv,
  NODE_ENV: "production",
  API_BASE_URL: "https://api.ready.app",
  LIVEKIT_REALTIME_SERVICE_URL: "https://realtime.ready.app",
  LIVEKIT_REALTIME_SERVICE_SECRET: "unique-realtime-secret",
};

void test("production cannot start with any missing local-only default", () => {
  const result = assistantEnvSchema.safeParse({ ...requiredEnv, NODE_ENV: "production" });
  assert.equal(result.success, false);
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path),
    [["API_BASE_URL"], ["LIVEKIT_REALTIME_SERVICE_URL"], ["LIVEKIT_REALTIME_SERVICE_SECRET"]],
  );
  assert.match(result.error.issues[0]?.message ?? "", /API_BASE_URL.*production/);
});

void test("production rejects a local-only default set explicitly", () => {
  const result = assistantEnvSchema.safeParse({ ...productionEnv, API_BASE_URL: "http://localhost:4000" });
  assert.equal(result.success, false);
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path),
    [["API_BASE_URL"]],
  );
});

void test("production retains the configured addresses", () => {
  const env = assistantEnvSchema.parse(productionEnv);
  assert.equal(env.API_BASE_URL, "https://api.ready.app");
  assert.equal(env.LIVEKIT_REALTIME_SERVICE_URL, "https://realtime.ready.app");
});

void test("local development and tests retain their default API address", () => {
  [undefined, "development", "test"].forEach((NODE_ENV) => {
    const env = assistantEnvSchema.parse({ ...requiredEnv, NODE_ENV });
    assert.equal(env.API_BASE_URL, "http://localhost:4000");
    assert.equal(env.LIVEKIT_REALTIME_SERVICE_URL, "http://localhost:4200");
  });
});

void test("an empty or malformed API address fails validation", () => {
  ["", "not-a-url"].forEach((API_BASE_URL) => {
    assert.equal(assistantEnvSchema.safeParse({ ...productionEnv, API_BASE_URL }).success, false);
  });
});
