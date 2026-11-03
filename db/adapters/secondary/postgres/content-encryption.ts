import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

import { MeetingContentCryptoError, MeetingContentKeyConfigError } from "../../../domain/content-key-errors";

import { resetContentFingerprintForTests } from "./content-fingerprint";
import { resetContentKeyAnnouncementForTests, unwrapContentDataKey, wrapContentDataKey } from "./content-key-config";

const PREFIX = "ready-content:v1:";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_WRAPPED_KEY_TEXT = 16384;
const FAILURE = "Meeting content encryption failed.";
const TEST_OVERRIDE = "Content key overrides require NODE_ENV=test.";
const envelopeSchema = z
  .object({
    key: z.string().min(1).max(MAX_WRAPPED_KEY_TEXT),
    nonce: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();

type JsonContent = string | number | boolean | null | JsonContent[] | { [key: string]: JsonContent };
const jsonContentSchema: z.ZodType<JsonContent> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonContentSchema),
    z.record(z.string(), jsonContentSchema),
  ]),
);

type Context = { application: string; purpose: string; model: string; recordId: string };
export type ContentKeyService = {
  generate: (context: Context) => Promise<{ plaintext: Uint8Array; wrapped: Uint8Array }>;
  decrypt: (input: { wrapped: Uint8Array; context: Context }) => Promise<Uint8Array>;
};

const keyServiceState: { override?: ContentKeyService } = {};

/** Test preload only. Production ignores this override. */
export function setContentKeyServiceForTests(service: ContentKeyService): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(TEST_OVERRIDE);
  }
  keyServiceState.override = service;
}

export function resetMeetingContentKeysForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(TEST_OVERRIDE);
  }
  keyServiceState.override = undefined;
  resetContentFingerprintForTests();
  resetContentKeyAnnouncementForTests();
}

function installedOverride(): ContentKeyService | undefined {
  if (process.env.NODE_ENV === "production") {
    return undefined;
  }

  return keyServiceState.override;
}

function envKeyService(): ContentKeyService {
  return {
    generate: async (context) => wrapContentDataKey(context),
    decrypt: async (input) => unwrapContentDataKey(input),
  };
}

function service(): ContentKeyService {
  const override = installedOverride();
  if (override !== undefined) {
    return override;
  }

  return envKeyService();
}
const contextFor = (input: { model: string; recordId: string }): Context => ({
  application: "readymeet",
  purpose: "meeting-content",
  model: input.model,
  recordId: input.recordId,
});
const aadFor = (input: { context: Context; field: string }) =>
  Buffer.from(JSON.stringify({ ...input.context, field: input.field }));

function decode(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(FAILURE);
  }

  return Buffer.from(value, "base64");
}

function safeFailure(error: unknown): never {
  if (error instanceof MeetingContentKeyConfigError || error instanceof MeetingContentCryptoError) {
    throw error;
  }
  // Never attach SDK errors, causes, or validation payloads: callers may log this error.
  throw new MeetingContentCryptoError();
}

async function generateKey(context: Context): Promise<{ plaintext: Uint8Array; wrapped: Uint8Array }> {
  try {
    return await service().generate(context);
  } catch (error) {
    return safeFailure(error);
  }
}

/** One fresh data key per record write, independent nonces and authenticated field bindings. */
export async function encryptContentFields(input: {
  model: string;
  recordId: string;
  fields: Record<string, unknown>;
}): Promise<Record<string, string>> {
  const context = contextFor(input);
  const generated = await generateKey(context);
  try {
    if (generated.plaintext.byteLength !== KEY_BYTES || generated.wrapped.byteLength === 0) {
      throw new Error(FAILURE);
    }

    return Object.fromEntries(
      Object.entries(input.fields).map(([field, value]) => {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", generated.plaintext, nonce);
        cipher.setAAD(aadFor({ context, field }));
        // Match JSON/Prisma serialization: undefined object properties are omitted, array holes become null.
        const serialized = JSON.stringify(value);
        jsonContentSchema.parse(JSON.parse(serialized));
        const plaintext = Buffer.from(serialized, "utf8");
        try {
          const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

          return [
            field,
            PREFIX +
              JSON.stringify({
                key: Buffer.from(generated.wrapped).toString("base64"),
                nonce: nonce.toString("base64"),
                tag: cipher.getAuthTag().toString("base64"),
                ciphertext: ciphertext.toString("base64"),
              }),
          ];
        } finally {
          plaintext.fill(0);
        }
      }),
    );
  } catch (error) {
    return safeFailure(error);
  } finally {
    generated.plaintext.fill(0);
  }
}

export async function decryptContentFields(input: {
  model: string;
  recordId: string;
  fields: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const context = contextFor(input);
  const keys = new Map<string, Uint8Array>();
  try {
    return await Object.entries(input.fields).reduce<Promise<Record<string, unknown>>>(
      async (pending, [field, stored]) => {
        const fields = await pending;
        if (typeof stored !== "string" || !stored.startsWith(PREFIX)) {
          throw new Error(FAILURE);
        }
        const envelope = envelopeSchema.parse(JSON.parse(stored.slice(PREFIX.length)));
        const key = keys.get(envelope.key) ?? (await service().decrypt({ wrapped: decode(envelope.key), context }));
        keys.set(envelope.key, key);
        const nonce = decode(envelope.nonce);
        const tag = decode(envelope.tag);
        if (key.byteLength !== KEY_BYTES || nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
          throw new Error(FAILURE);
        }
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aadFor({ context, field }));
        decipher.setAuthTag(tag);
        const chunks = new Set<Buffer>();
        try {
          const partial = decipher.update(decode(envelope.ciphertext));
          chunks.add(partial);
          const final = decipher.final();
          chunks.add(final);
          const plaintext = Buffer.concat([...chunks]);
          chunks.add(plaintext);

          return { ...fields, [field]: jsonContentSchema.parse(JSON.parse(plaintext.toString("utf8"))) };
        } finally {
          chunks.forEach((chunk) => {
            chunk.fill(0);
          });
        }
      },
      Promise.resolve({}),
    );
  } catch (error) {
    return safeFailure(error);
  } finally {
    keys.forEach((key) => {
      key.fill(0);
    });
  }
}
