import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import { setContentKeyServiceForTests } from "../adapters/secondary/postgres/content-encryption";
import { setContentFingerprintServiceForTests } from "../adapters/secondary/postgres/content-fingerprint";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const PREFIX_BYTES = 28;
const TEST_DENIED = "Synthetic content-key context mismatch.";

/** Isolated tests only: production never installs this provider or uses local keys. */
export function configureContentTestKeys(): void {
  process.env.NODE_ENV = "test";
  const wrappingKey = createHash("sha256").update("synthetic-test-only-content-wrapping-key").digest();
  setContentKeyServiceForTests({
    generate: async (context) => {
      const plaintext = randomBytes(KEY_BYTES);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(context)));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const wrapped = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);

      return { plaintext, wrapped };
    },
    decrypt: async ({ wrapped, context }) => {
      if (wrapped.length < PREFIX_BYTES) {
        throw new Error(TEST_DENIED);
      }
      const decipher = createDecipheriv("aes-256-gcm", wrappingKey, wrapped.slice(0, NONCE_BYTES));
      decipher.setAAD(Buffer.from(JSON.stringify(context)));
      decipher.setAuthTag(wrapped.slice(NONCE_BYTES, PREFIX_BYTES));

      return Buffer.concat([decipher.update(wrapped.slice(PREFIX_BYTES)), decipher.final()]);
    },
  });
  const fingerprintKey = createHash("sha256").update("synthetic-test-only-lookup-key").digest();
  setContentFingerprintServiceForTests(async (message) =>
    createHmac("sha256", fingerprintKey).update(message).digest(),
  );
}
