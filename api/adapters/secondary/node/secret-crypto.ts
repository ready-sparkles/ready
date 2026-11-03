import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { apiEnv } from "../../../ports/api-env";

const ALGORITHM = "aes-256-gcm";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ENCRYPTED_SECRET_VERSION = "v1";
const MESSAGE_UNSUPPORTED_ENCRYPTED_SECRET_FORMAT = "Unsupported encrypted secret format.";

const encryptedSecretPartsSchema = z.tuple([
  z.literal(ENCRYPTED_SECRET_VERSION),
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
]);

type DecryptedJsonSecret =
  | string
  | number
  | boolean
  | null
  | DecryptedJsonSecret[]
  | { [key: string]: DecryptedJsonSecret };

const decryptedJsonSecretSchema: z.ZodType<DecryptedJsonSecret> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(decryptedJsonSecretSchema),
    z.record(z.string(), decryptedJsonSecretSchema),
  ]),
);

function key(): Buffer {
  return createHash("sha256").update(apiEnv().OAUTH_TOKEN_ENCRYPTION_KEY).digest();
}

export function encryptJsonSecret(value: unknown): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const plaintext = JSON.stringify(value);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_SECRET_VERSION}:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptJsonSecret(secretRef: string): DecryptedJsonSecret {
  const parsedParts = encryptedSecretPartsSchema.safeParse(secretRef.split(":"));
  if (!parsedParts.success) {
    throw new Error(MESSAGE_UNSUPPORTED_ENCRYPTED_SECRET_FORMAT);
  }

  const [, ivText, tagText, encryptedText] = parsedParts.data;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivText, "base64url"), {
    authTagLength: GCM_TAG_BYTES,
  });
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]);

  const decodedText = decrypted.toString("utf8");

  return decryptedJsonSecretSchema.parse(JSON.parse(decodedText));
}

export const isStoredJsonObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decrypts a secret stored with encryptJsonSecret and checks it against the caller's schema. */
export function decryptStoredJsonSecret<T>(input: { secretRef: string; schema: z.ZodType<T> }): T {
  return input.schema.parse(decryptJsonSecret(input.secretRef));
}
