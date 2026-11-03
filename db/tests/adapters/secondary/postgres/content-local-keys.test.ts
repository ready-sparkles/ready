import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  decryptContentFields,
  encryptContentFields,
  resetMeetingContentKeysForTests,
} from "../../../../adapters/secondary/postgres/content-encryption";
import { contentFingerprint } from "../../../../adapters/secondary/postgres/content-fingerprint";
import { resolveContentKeyMode } from "../../../../adapters/secondary/postgres/content-key-config";
import { CONTENT_KEY_CONFIG_MESSAGES, MeetingContentKeyConfigError } from "../../../../domain/content-key-errors";
import { configureContentTestKeys } from "../../../content-key-fixture";

type KeyEnvName = "NODE_ENV" | "MEETING_CONTENT_WRAPPING_KEY" | "MEETING_CONTENT_LOOKUP_KEY";

const VALID_WRAPPING_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const VALID_LOOKUP_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const INVALID_KEY_SENTINEL = "not-a-hex-key-SENTINEL-999999999999";
const PLAINTEXT = "local-dev-meeting-title";
const LOCAL_PROVIDER_LOG = "local development key provider";

function snapshotEnv(): Record<KeyEnvName, string | undefined> {
  return {
    NODE_ENV: process.env.NODE_ENV,
    MEETING_CONTENT_WRAPPING_KEY: process.env.MEETING_CONTENT_WRAPPING_KEY,
    MEETING_CONTENT_LOOKUP_KEY: process.env.MEETING_CONTENT_LOOKUP_KEY,
  };
}

function applyEnv(values: Record<string, string | undefined>): void {
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);

      return;
    }
    process.env[key] = value;
  });
}

function captureConsoleError(): { text: () => string; restore: () => void } {
  const original = console.error;
  const state = { lines: [] as string[] };
  console.error = (...parts: unknown[]) => {
    state.lines = [...state.lines, parts.map((value) => String(value)).join(" ")];
  };

  return {
    text: () => state.lines.join("\n"),
    restore: () => {
      console.error = original;
    },
  };
}

async function withKeyEnv(input: {
  env: Record<string, string | undefined>;
  run: (logs: () => string) => Promise<void>;
}): Promise<void> {
  const saved = snapshotEnv();
  resetMeetingContentKeysForTests();
  applyEnv({
    MEETING_CONTENT_WRAPPING_KEY: undefined,
    MEETING_CONTENT_LOOKUP_KEY: undefined,
    ...input.env,
  });
  const captured = captureConsoleError();
  try {
    await input.run(captured.text);
  } finally {
    captured.restore();
    applyEnv(saved);
    resetMeetingContentKeysForTests();
    configureContentTestKeys();
  }
}

void test("development without env keys round-trips content and names the local provider", async () => {
  await withKeyEnv({
    env: { NODE_ENV: "development" },
    run: async (logs) => {
      const scope = { model: "meetings", recordId: randomUUID() };
      const encrypted = await encryptContentFields({ ...scope, fields: { title: PLAINTEXT } });
      assert.equal(JSON.stringify(encrypted).includes(PLAINTEXT), false);
      assert.equal(resolveContentKeyMode(), "local-development");
      assert.deepEqual(await decryptContentFields({ ...scope, fields: encrypted }), { title: PLAINTEXT });
      const fingerprint = await contentFingerprint({ domain: "meetings.title", value: PLAINTEXT });
      assert.equal(fingerprint, await contentFingerprint({ domain: "meetings.title", value: PLAINTEXT }));
      const log = logs();
      assert.equal(log.includes(PLAINTEXT), false);
      assert.match(log, /local development key provider/);
      assert.match(log, /MEETING_CONTENT_WRAPPING_KEY/);
      assert.match(log, /MEETING_CONTENT_LOOKUP_KEY/);
      assert.match(log, /refused when NODE_ENV is production/);
    },
  });
});

void test("production env keys round-trip content and lookups", async () => {
  await withKeyEnv({
    env: {
      NODE_ENV: "production",
      MEETING_CONTENT_WRAPPING_KEY: VALID_WRAPPING_KEY,
      MEETING_CONTENT_LOOKUP_KEY: VALID_LOOKUP_KEY,
    },
    run: async (logs) => {
      const scope = { model: "meetings", recordId: randomUUID() };
      const encrypted = await encryptContentFields({ ...scope, fields: { title: PLAINTEXT } });
      assert.equal(JSON.stringify(encrypted).includes(PLAINTEXT), false);
      assert.equal(resolveContentKeyMode(), "env");
      assert.deepEqual(await decryptContentFields({ ...scope, fields: encrypted }), { title: PLAINTEXT });
      const fingerprint = await contentFingerprint({ domain: "meetings.title", value: PLAINTEXT });
      assert.equal(fingerprint, await contentFingerprint({ domain: "meetings.title", value: PLAINTEXT }));
      assert.equal(logs().includes(LOCAL_PROVIDER_LOG), false);
    },
  });
});

void test("production and non-development refuse missing or invalid keys", async () => {
  await withKeyEnv({
    env: { NODE_ENV: "production" },
    run: async () => {
      await assert.rejects(
        encryptContentFields({ model: "meetings", recordId: randomUUID(), fields: { title: PLAINTEXT } }),
        (error: unknown) => {
          assert.ok(error instanceof MeetingContentKeyConfigError);
          assert.equal(error.message, CONTENT_KEY_CONFIG_MESSAGES.missingKeys);
          assert.equal(error.message.includes(PLAINTEXT), false);

          return true;
        },
      );
    },
  });
  await withKeyEnv({
    env: { NODE_ENV: "development", MEETING_CONTENT_WRAPPING_KEY: INVALID_KEY_SENTINEL },
    run: async (logs) => {
      await assert.rejects(
        encryptContentFields({ model: "meetings", recordId: randomUUID(), fields: { title: PLAINTEXT } }),
        (error: unknown) => {
          assert.ok(error instanceof MeetingContentKeyConfigError);
          assert.equal(error.message, CONTENT_KEY_CONFIG_MESSAGES.invalidEncryptionKey);
          assert.equal(error.message.includes(INVALID_KEY_SENTINEL), false);

          return true;
        },
      );
      assert.equal(logs().includes(LOCAL_PROVIDER_LOG), false);
    },
  });
  await withKeyEnv({
    env: { NODE_ENV: "development", MEETING_CONTENT_WRAPPING_KEY: VALID_WRAPPING_KEY },
    run: async () => {
      await assert.rejects(
        encryptContentFields({ model: "meetings", recordId: randomUUID(), fields: { title: PLAINTEXT } }),
        (error: unknown) => {
          assert.ok(error instanceof MeetingContentKeyConfigError);
          assert.equal(error.message, CONTENT_KEY_CONFIG_MESSAGES.missingKeys);

          return true;
        },
      );
    },
  });
  await withKeyEnv({
    env: { NODE_ENV: "test" },
    run: async (logs) => {
      await assert.rejects(
        encryptContentFields({ model: "meetings", recordId: randomUUID(), fields: { title: PLAINTEXT } }),
        (error: unknown) => error instanceof MeetingContentKeyConfigError,
      );
      assert.equal(logs().includes(LOCAL_PROVIDER_LOG), false);
    },
  });
});
