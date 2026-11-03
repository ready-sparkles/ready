import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";

import {
  decryptJsonSecret,
  decryptStoredJsonSecret,
  encryptJsonSecret,
} from "../../adapters/secondary/node/secret-crypto";
import { apiEnv } from "../../ports/api-env";

const TAG_BYTES = 16;
const IV_BYTES = 12;
const TAG_PART = 2;
const CIPHERTEXT_PART = 3;
const NUMERIC_VALUE = 42;
const SECRET_VALUE = { token: "synthetic", nested: [null, true, NUMERIC_VALUE, "hello"] };

void test("JSON secrets round trip with the existing v1 envelope and full tag", () => {
  [SECRET_VALUE, null, false, NUMERIC_VALUE, "hello", []].forEach((value) => {
    const encrypted = encryptJsonSecret(value);
    assert.equal(encrypted.split(":")[0], "v1");
    assert.equal(Buffer.from(encrypted.split(":")[TAG_PART] ?? "", "base64url").length, TAG_BYTES);
    assert.deepEqual(decryptJsonSecret(encrypted), value);
  });
});

void test("decrypts a v1 envelope produced with the legacy encryption settings", () => {
  const key = createHash("sha256").update(apiEnv().OAUTH_TOKEN_ENCRYPTION_KEY).digest();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(SECRET_VALUE), "utf8"), cipher.final()]);
  const envelope = [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
  assert.deepEqual(decryptJsonSecret(envelope), SECRET_VALUE);
});

void test("rejects every truncated authentication tag, including valid GCM prefix lengths", () => {
  const parts = encryptJsonSecret(SECRET_VALUE).split(":");
  const tag = Buffer.from(parts[TAG_PART] ?? "", "base64url");
  Array.from({ length: TAG_BYTES }, (_, length) => length).forEach((length) => {
    const truncated = parts
      .map((part, index) => (index === TAG_PART ? tag.subarray(0, length).toString("base64url") : part))
      .join(":");
    assert.throws(() => decryptJsonSecret(truncated), `Accepted a ${length}-byte tag`);
  });
  const extended = parts
    .map((part, index) => (index === TAG_PART ? Buffer.concat([tag, Buffer.alloc(1)]).toString("base64url") : part))
    .join(":");
  assert.throws(() => decryptJsonSecret(extended));
});

void test("rejects tampered tags and ciphertext", () => {
  const parts = encryptJsonSecret(SECRET_VALUE).split(":");
  [TAG_PART, CIPHERTEXT_PART].forEach((changedPart) => {
    const bytes = Buffer.from(parts[changedPart] ?? "", "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = parts.map((part, index) => (index === changedPart ? bytes.toString("base64url") : part)).join(":");
    assert.throws(() => decryptJsonSecret(tampered));
  });
});

void test("stored-secret schema validation is preserved", () => {
  const secretRef = encryptJsonSecret({ token: "synthetic" });
  assert.deepEqual(decryptStoredJsonSecret({ secretRef, schema: z.object({ token: z.string() }) }), {
    token: "synthetic",
  });
  assert.throws(() => decryptStoredJsonSecret({ secretRef, schema: z.object({ token: z.number() }) }));
});
