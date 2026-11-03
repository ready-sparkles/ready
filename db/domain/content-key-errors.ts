export const MEETING_CONTENT_CRYPTO_FAILURE_MESSAGE = "Meeting content encryption failed.";
export const SKIPPED_PROTECTED_ROW_MESSAGE = "Skipped a protected row that could not be decrypted.";

export const CONTENT_KEY_CONFIG_MESSAGES = {
  invalidEncryptionKey: "MEETING_CONTENT_WRAPPING_KEY must be 64 hex characters (32 bytes).",
  invalidLookupKey: "MEETING_CONTENT_LOOKUP_KEY must be 64 hex characters (32 bytes).",
  missingKeys:
    "Meeting content encryption is not configured. Set MEETING_CONTENT_WRAPPING_KEY and MEETING_CONTENT_LOOKUP_KEY to 32-byte keys encoded as 64 hex characters. The local development key provider is refused outside NODE_ENV=development.",
  localProviderActive:
    "Meeting content encryption is using the local development key provider. This provider is refused when NODE_ENV is production. Set MEETING_CONTENT_WRAPPING_KEY and MEETING_CONTENT_LOOKUP_KEY to use application-managed keys.",
} as const;

const PUBLIC_CONTENT_KEY_CONFIG_MESSAGES = [
  CONTENT_KEY_CONFIG_MESSAGES.invalidEncryptionKey,
  CONTENT_KEY_CONFIG_MESSAGES.invalidLookupKey,
  CONTENT_KEY_CONFIG_MESSAGES.missingKeys,
] as const;

export function isPublicContentKeyConfigMessage(message: string): boolean {
  return PUBLIC_CONTENT_KEY_CONFIG_MESSAGES.some((candidate) => candidate === message);
}

/** Missing or invalid meeting-content key configuration. The message is a fixed string with no content or credentials. */
export class MeetingContentKeyConfigError extends Error {
  readonly code = "MEETING_CONTENT_KEYS_UNCONFIGURED";

  constructor(message: string) {
    super(message);
    this.name = "MeetingContentKeyConfigError";
  }
}

/** Encryption or decryption failed. The message is constant and carries no stored content. */
export class MeetingContentCryptoError extends Error {
  readonly code = "MEETING_CONTENT_CRYPTO_FAILED";

  constructor() {
    super(MEETING_CONTENT_CRYPTO_FAILURE_MESSAGE);
    this.name = "MeetingContentCryptoError";
  }
}
