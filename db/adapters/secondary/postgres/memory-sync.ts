import { db } from "./client";
import type { MemoryScope } from "./relationship-memory";

const DEFAULT_MEMORY_SYNC_CHANGE_LIMIT = 500;

export async function memorySyncVersion(scope: MemoryScope): Promise<string> {
  const row = await db.memorySyncHeads.findUnique({
    where: { userId_workspaceId: { userId: scope.userId, workspaceId: scope.workspaceId } },
  });

  return row?.version.toString() ?? "0";
}

export async function memorySyncChanges(options: {
  scope: MemoryScope;
  since: string;
  limit?: number;
}): Promise<{ id: string; version: string }[]> {
  const rows = await db.memorySyncChanges.findMany({
    where: {
      userId: options.scope.userId,
      workspaceId: options.scope.workspaceId,
      version: { gt: BigInt(options.since) },
    },
    orderBy: { version: "asc" },
    take: options.limit ?? DEFAULT_MEMORY_SYNC_CHANGE_LIMIT,
  });

  return rows.map((row) => ({ id: row.memoryId, version: row.version.toString() }));
}

// An old source newly made accessible needs a new baseline. Sources generated
// after the cursor are already covered by the change feed and need no reset.
export async function memorySyncNeedsBaseline(options: {
  scope: MemoryScope;
  sourceIds: string[];
  since: string;
}): Promise<boolean> {
  if (options.sourceIds.length === 0) {
    return false;
  }
  const row = await db.memorySyncChanges.findFirst({
    where: {
      userId: options.scope.userId,
      workspaceId: options.scope.workspaceId,
      sourceId: { in: options.sourceIds },
      version: { lte: BigInt(options.since) },
    },
  });

  return row !== null;
}
