import { createHash } from "node:crypto";
import { z } from "zod";

export { decodeMemoryPosition, encodeMemoryPosition } from "@readymeet/shared";

const MAX_MEMORY_SYNC_SOURCES = 10_000;
const syncSchema = z.object({
  scope: z.string(),
  version: z.string().regex(/^\d{1,19}$/),
  sources: z.array(z.string().uuid()).max(MAX_MEMORY_SYNC_SOURCES),
});
export function memorySyncScope(input: { userId: string; workspaceId: string; filters: object }): string {
  return createHash("sha256")
    .update(JSON.stringify([input.userId, input.workspaceId, input.filters]))
    .digest("hex");
}
export const encodeMemorySyncCursor = (cursor: z.infer<typeof syncSchema>): string =>
  Buffer.from(JSON.stringify({ ...cursor, sources: [...cursor.sources].sort() })).toString("base64url");
export const decodeMemorySyncCursor = (cursor: string): z.infer<typeof syncSchema> =>
  syncSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
