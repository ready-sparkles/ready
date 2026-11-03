const UNIQUE_VIOLATION_CODES = new Set(["P2002", "23505"]);
const MAX_CAUSE_DEPTH = 8;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");

  return typeof code === "string" ? code : undefined;
}

function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  return Reflect.get(error, "cause");
}

function hasUniqueViolationCode(input: { error: unknown; seen: Set<unknown>; depth: number }): boolean {
  const { error, seen, depth } = input;
  if (typeof error !== "object" || error === null || seen.has(error) || depth > MAX_CAUSE_DEPTH) {
    return false;
  }
  seen.add(error);
  const code = errorCode(error);
  if (code !== undefined && UNIQUE_VIOLATION_CODES.has(code)) {
    return true;
  }

  return hasUniqueViolationCode({ error: errorCause(error), seen, depth: depth + 1 });
}

/** True for a Prisma P2002 or PostgreSQL 23505 unique violation, including a wrapped cause. */
export function isUniqueViolation(error: unknown): boolean {
  return hasUniqueViolationCode({ error, seen: new Set(), depth: 0 });
}
