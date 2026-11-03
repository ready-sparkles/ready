import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { MemoryListData } from "./memory-list-sync";

export async function removeForgottenMemories({
  client,
  scope,
  ids,
}: {
  client: QueryClient;
  scope: QueryKey;
  ids: string[];
}): Promise<void> {
  // Cancel before patching so an older response cannot restore deleted text.
  await client.cancelQueries({ queryKey: scope });
  const forgotten = new Set(ids);
  client.setQueriesData<MemoryListData>({ queryKey: [...scope, "list"] }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            memories: page.memories.filter((memory) => !forgotten.has(memory.id)),
          })),
        }
      : data,
  );
  // Person summaries and evidence can quote a removed memory; invalidate their
  // contents, including inactive person views, rather than retaining old text.
  client.setQueriesData<{ memories: { id: string }[]; projection: unknown }>(
    { queryKey: [...scope, "person"] },
    (data) =>
      data
        ? {
            ...data,
            projection: null,
            memories: data.memories.filter((memory) => !forgotten.has(memory.id)),
          }
        : data,
  );
  client.removeQueries({ queryKey: [...scope, "evidence"] });
}

export function memoryChannelName({ userId, workspaceId }: { userId: string; workspaceId: string }): string {
  return `readymeet:memory:${userId}:${workspaceId}`;
}

export function broadcastMemoryForget({
  userId,
  workspaceId,
  ids,
}: {
  userId: string;
  workspaceId: string;
  ids: string[];
}): void {
  if (typeof BroadcastChannel === "undefined") {
    return;
  }
  const channel = new BroadcastChannel(memoryChannelName({ userId, workspaceId }));
  channel.postMessage({ type: "forget", ids });
  channel.close();
}
