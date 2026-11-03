const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

const constraintName = (value: unknown): string | undefined => {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value !== "object" || value === null || !Object.prototype.hasOwnProperty.call(value, "index")) {
    return undefined;
  }
  const index: unknown = Object.getOwnPropertyDescriptor(value, "index")?.value;

  return typeof index === "string" && index !== "" ? index : undefined;
};

const postgresViolationFields = (error: unknown): { code: string | undefined; constraint: string | undefined }[] => {
  const seen = new Set<unknown>();
  const visit = (current: unknown): { code: string | undefined; constraint: string | undefined }[] => {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return [];
    }
    seen.add(current);
    const read = (key: string): unknown =>
      Object.prototype.hasOwnProperty.call(current, key)
        ? Object.getOwnPropertyDescriptor(current, key)?.value
        : undefined;
    const code = read("originalCode");
    const driverCode = read("code");

    return [
      {
        code: typeof code === "string" ? code : typeof driverCode === "string" ? driverCode : undefined,
        constraint: constraintName(read("constraint")),
      },
      ...Object.values(current).flatMap((value) => visit(value)),
    ];
  };

  return visit(error);
};

export function isPostgresUniqueConstraintError(input: { error: unknown; constraint: string }): boolean {
  return postgresViolationFields(input.error).some(
    (field) => field.code === POSTGRES_UNIQUE_VIOLATION_CODE && field.constraint === input.constraint,
  );
}
