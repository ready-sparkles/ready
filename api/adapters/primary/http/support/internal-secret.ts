import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of a shared-secret request header. Both sides are hashed first so
 * neither the length nor the content of the expected secret leaks through timing.
 */
export function matchesInternalSecret(input: { header: string | string[] | undefined; expected: string }): boolean {
  const provided = Array.isArray(input.header) ? input.header[0] : input.header;
  if (typeof provided !== "string" || provided === "" || input.expected === "") {
    return false;
  }

  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(input.expected).digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}
