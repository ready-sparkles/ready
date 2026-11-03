import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";

import {
  type ContentKeyService,
  decryptContentFields,
  encryptContentFields,
  setContentKeyServiceForTests,
} from "../../../../adapters/secondary/postgres/content-encryption";

const FAILURE = /Meeting content encryption failed\./u;
const PREFIX = "ready-content:v1:";
const KEY_BYTES = 32;
const INVALID_KEY_BYTES = 16;
const SAMPLE_COUNT = 2;
const KEY_DENIED = "Content key denied access.";
const FAILURE_MESSAGE = "Meeting content encryption failed.";
const envelopeSchema = z.object({ key: z.string(), nonce: z.string(), tag: z.string(), ciphertext: z.string() });
const readEnvelope = (value: string) => envelopeSchema.parse(JSON.parse(value.slice(PREFIX.length)));

function fakeKeyService() {
  const keys = new Map<string, { key: Buffer; context: string }>();
  const plaintexts = new Set<Uint8Array>();
  const calls = { generate: 0, decrypt: 0 };
  const service: ContentKeyService = {
    generate: async (context) => {
      calls.generate += 1;
      const plaintext = randomBytes(KEY_BYTES);
      const wrapped = randomBytes(KEY_BYTES);
      keys.set(wrapped.toString("base64"), { key: Buffer.from(plaintext), context: JSON.stringify(context) });
      plaintexts.add(plaintext);

      return { plaintext, wrapped };
    },
    decrypt: async ({ wrapped, context }) => {
      calls.decrypt += 1;
      const stored = keys.get(Buffer.from(wrapped).toString("base64"));
      if (!stored || stored.context !== JSON.stringify(context)) {
        throw new Error(KEY_DENIED);
      }
      const plaintext = Buffer.from(stored.key);
      plaintexts.add(plaintext);

      return plaintext;
    },
  };

  return { service, calls, plaintexts };
}

void test("envelope encryption binds content to records and fields, fails closed, and clears keys", async (t) => {
  const keys = fakeKeyService();
  process.env.NODE_ENV = "test";
  setContentKeyServiceForTests(keys.service);
  const scope = { model: "transcriptSegments", recordId: randomUUID() };
  const sentinel = "SENSITIVE-meeting-🦊-中文-\u0000";
  const fields = { content: sentinel, empty: "", payload: { notes: [sentinel], count: SAMPLE_COUNT, nullable: null } };
  const encrypted = await encryptContentFields({ ...scope, fields });

  await t.test("round trips Unicode, empty text, arrays and JSON without plaintext copies", async () => {
    assert.equal(JSON.stringify(encrypted).includes(sentinel), false);
    assert.deepEqual(await decryptContentFields({ ...scope, fields: encrypted }), fields);
    assert.equal(keys.calls.generate, 1);
    assert.equal(keys.calls.decrypt, 1);
    assert.ok([...keys.plaintexts].every((key) => key.every((byte) => byte === 0)));
  });

  await t.test("uses fresh data keys and field nonces on every write", async () => {
    const second = await encryptContentFields({ ...scope, fields });
    assert.notEqual(second.content, encrypted.content);
    const content = readEnvelope(encrypted.content ?? "");
    const empty = readEnvelope(encrypted.empty ?? "");
    assert.notEqual(content.nonce, empty.nonce);
    assert.notEqual(content.key, readEnvelope(second.content ?? "").key);
  });

  await t.test("rejects cross-record, cross-model and cross-field substitution", async () => {
    await assert.rejects(decryptContentFields({ ...scope, recordId: randomUUID(), fields: encrypted }), FAILURE);
    await assert.rejects(decryptContentFields({ ...scope, model: "summaries", fields: encrypted }), FAILURE);
    await assert.rejects(decryptContentFields({ ...scope, fields: { other: encrypted.content } }), FAILURE);
  });

  await t.test("rejects modified ciphertext, nonce, tag and wrapped key", async () => {
    await Promise.all(
      (["ciphertext", "nonce", "tag", "key"] as const).map(async (field) => {
        const envelope = readEnvelope(encrypted.content ?? "");
        const bytes = Buffer.from(envelope[field], "base64");
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        envelope[field] = bytes.toString("base64");
        await assert.rejects(
          decryptContentFields({ ...scope, fields: { content: PREFIX + JSON.stringify(envelope) } }),
          FAILURE,
        );
      }),
    );
  });

  await t.test("rejects plaintext, malformed envelopes, invalid base64 and future versions", async () => {
    await Promise.all(
      [sentinel, null, {}, "ready-content:v2:{}", `${PREFIX}{`, `${PREFIX}{}`].map(async (stored) => {
        await assert.rejects(decryptContentFields({ ...scope, fields: { content: stored } }), FAILURE);
      }),
    );
    const envelope = readEnvelope(encrypted.content ?? "");
    envelope.nonce = "not-base64!";
    await assert.rejects(
      decryptContentFields({ ...scope, fields: { content: PREFIX + JSON.stringify(envelope) } }),
      FAILURE,
    );
  });

  await t.test("denied key operations never return content or include provider errors", async () => {
    setContentKeyServiceForTests({
      generate: async () => {
        throw new Error(sentinel);
      },
      decrypt: async () => {
        throw new Error(sentinel);
      },
    });
    await assert.rejects(encryptContentFields({ ...scope, fields }), FAILURE);
    await assert.rejects(decryptContentFields({ ...scope, fields: encrypted }), FAILURE);
    setContentKeyServiceForTests({
      generate: async () => {
        throw new Error(FAILURE_MESSAGE, { cause: sentinel });
      },
      decrypt: keys.service.decrypt,
    });
    await assert.rejects(encryptContentFields({ ...scope, fields }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, FAILURE_MESSAGE);
      assert.equal(error.cause, undefined);

      return true;
    });
    setContentKeyServiceForTests(keys.service);
  });

  await t.test("rejects invalid data-key lengths and wipes keys after failure", async () => {
    const key = randomBytes(INVALID_KEY_BYTES);
    setContentKeyServiceForTests({
      generate: async () => ({ plaintext: key, wrapped: randomBytes(KEY_BYTES) }),
      decrypt: keys.service.decrypt,
    });
    await assert.rejects(encryptContentFields({ ...scope, fields }), FAILURE);
    assert.ok(key.every((byte) => byte === 0));
    setContentKeyServiceForTests(keys.service);
  });

  await t.test("test key injection cannot be enabled in production", () => {
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => setContentKeyServiceForTests(keys.service), /require NODE_ENV=test/u);
    } finally {
      process.env.NODE_ENV = "test";
    }
  });
});
