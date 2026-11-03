import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time shared-secret check; hashing both sides keeps the expected secret's length out of the timing. */
export function matchesInternalSecret(input: { provided: string; expected: string }): boolean {
  if (input.provided === "" || input.expected === "") {
    return false;
  }

  return timingSafeEqual(
    createHash("sha256").update(input.provided).digest(),
    createHash("sha256").update(input.expected).digest(),
  );
}
