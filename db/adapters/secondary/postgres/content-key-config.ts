import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import { CONTENT_KEY_CONFIG_MESSAGES, MeetingContentKeyConfigError } from "../../../domain/content-key-errors";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_PREFIX_BYTES = NONCE_BYTES + TAG_BYTES;
const HEX_KEY = /^[0-9a-fA-F]{64}$/u;
const UNWRAP_FAILED = "Content key unwrap failed.";
const localWrappingKey = createHash("sha256").update("readymeet-local-development-only-content-wrapping-key").digest();
const localLookupKey = createHash("sha256").update("readymeet-local-development-only-lookup-key").digest();
const announcement = { hasLogged: false };

type ContentKeyContext = { application: string; purpose: string; model: string; recordId: string };
type KeyName = "MEETING_CONTENT_WRAPPING_KEY" | "MEETING_CONTENT_LOOKUP_KEY";
export type ContentKeyMode = "env" | "local-development";

function announceLocalProvider(): void {
  if (announcement.hasLogged) {
    return;
  }
  announcement.hasLogged = true;
  console.error(CONTENT_KEY_CONFIG_MESSAGES.localProviderActive);
}

function readHexKey(name: KeyName): Buffer | undefined {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!HEX_KEY.test(value)) {
    throw new MeetingContentKeyConfigError(
      name === "MEETING_CONTENT_WRAPPING_KEY"
        ? CONTENT_KEY_CONFIG_MESSAGES.invalidEncryptionKey
        : CONTENT_KEY_CONFIG_MESSAGES.invalidLookupKey,
    );
  }

  return Buffer.from(value, "hex");
}

function envKeys(): { wrapping: Buffer; lookup: Buffer } {
  const wrapping = readHexKey("MEETING_CONTENT_WRAPPING_KEY");
  const lookup = readHexKey("MEETING_CONTENT_LOOKUP_KEY");
  if (wrapping === undefined || lookup === undefined) {
    throw new MeetingContentKeyConfigError(CONTENT_KEY_CONFIG_MESSAGES.missingKeys);
  }

  return { wrapping, lookup };
}

export function resetContentKeyAnnouncementForTests(): void {
  announcement.hasLogged = false;
}

/**
 * Production and other non-development environments require both env keys.
 * Development uses those keys when they are set, and otherwise a process-local
 * provider that cannot be selected outside NODE_ENV=development.
 */
export function resolveContentKeyMode(): ContentKeyMode {
  const wrapping = readHexKey("MEETING_CONTENT_WRAPPING_KEY");
  const lookup = readHexKey("MEETING_CONTENT_LOOKUP_KEY");
  if (wrapping !== undefined && lookup !== undefined) {
    return "env";
  }
  if (wrapping !== undefined || lookup !== undefined) {
    throw new MeetingContentKeyConfigError(CONTENT_KEY_CONFIG_MESSAGES.missingKeys);
  }
  if (process.env.NODE_ENV === "development") {
    announceLocalProvider();

    return "local-development";
  }

  throw new MeetingContentKeyConfigError(CONTENT_KEY_CONFIG_MESSAGES.missingKeys);
}

/** Validate key configuration at process start. Tests keep the synthetic preload instead. */
export function configureMeetingContentKeys(): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  resolveContentKeyMode();
}

function wrappingKey(): Buffer {
  if (resolveContentKeyMode() === "local-development") {
    return localWrappingKey;
  }

  return envKeys().wrapping;
}

function lookupKey(): Buffer {
  if (resolveContentKeyMode() === "local-development") {
    return localLookupKey;
  }

  return envKeys().lookup;
}

export function wrapContentDataKey(context: ContentKeyContext): { plaintext: Uint8Array; wrapped: Uint8Array } {
  const plaintext = randomBytes(KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey(), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(context)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return { plaintext, wrapped: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]) };
}

export function unwrapContentDataKey(input: { wrapped: Uint8Array; context: ContentKeyContext }): Uint8Array {
  if (input.wrapped.byteLength <= WRAPPED_PREFIX_BYTES) {
    throw new Error(UNWRAP_FAILED);
  }
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey(), input.wrapped.subarray(0, NONCE_BYTES));
  decipher.setAAD(Buffer.from(JSON.stringify(input.context)));
  decipher.setAuthTag(input.wrapped.subarray(NONCE_BYTES, WRAPPED_PREFIX_BYTES));

  return Buffer.concat([decipher.update(input.wrapped.subarray(WRAPPED_PREFIX_BYTES)), decipher.final()]);
}

export function contentLookupMac(message: Uint8Array): Uint8Array {
  return createHmac("sha256", lookupKey()).update(message).digest();
}
