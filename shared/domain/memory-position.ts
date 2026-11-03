import { z } from "zod";

import type { RelationshipMemory } from "./relationship-memory";

const MAX_MEMORY_POSITION_TIMESTAMP_LENGTH = 80;
const MAX_MEMORY_POSITION_IMPORTANCE = 100;
const DEFAULT_MEMORY_IMPORTANCE = 1;
const MEMORY_POSITION_PREFIX = "m1.";

const positionSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z
    .string()
    .max(MAX_MEMORY_POSITION_TIMESTAMP_LENGTH)
    .refine((value) => Number.isFinite(Date.parse(value))),
  importance: z.number().int().min(0).max(MAX_MEMORY_POSITION_IMPORTANCE),
});

export const encodeMemoryPosition = (memory: RelationshipMemory): string =>
  `${MEMORY_POSITION_PREFIX}${btoa(
    JSON.stringify({
      id: memory.id,
      occurredAt: memory.occurredAt,
      importance: memory.importance ?? DEFAULT_MEMORY_IMPORTANCE,
    }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
export function decodeMemoryPosition(cursor?: string): z.infer<typeof positionSchema> | undefined {
  if (cursor === undefined || cursor === "" || !cursor.startsWith(MEMORY_POSITION_PREFIX)) {
    return undefined;
  }

  return positionSchema.parse(
    JSON.parse(atob(cursor.slice(MEMORY_POSITION_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/"))),
  );
}
