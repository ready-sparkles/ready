"use client";

import { IsRestoringProvider, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { clear } from "../../composition/idb-keyval";
import { READYMEET_QUERY_GC_TIME_MS } from "../../composition/query-cache-policy";
import {
  WORKSPACE_END_MEETING_DETAIL_KEY,
  WORKSPACE_END_MEETING_PREPARATION_KEY,
} from "../../composition/workspace-transition";

import { useAuth } from "./auth-provider";

const DEFAULT_QUERY_STALE_TIME_MS = 30_000;

async function removeLegacyQueryCache(): Promise<void> {
  try {
    await clear();
  } catch (error) {
    void error;
  }
}

export function ReadyQueryProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const userId = session !== null && session.user.source !== "guest" ? session.user.id : null;

  return (
    <ReadyQueryScope
      userId={userId}
      workspaceId={userId !== null && userId !== "" ? (session?.user.workspaceId ?? null) : null}
    >
      {children}
    </ReadyQueryScope>
  );
}

export function ReadyQueryScope({
  userId,
  workspaceId,
  children,
}: {
  userId: string | null;
  workspaceId: string | null;
  children: React.ReactNode;
}) {
  // Replace the client before children render so neither accounts nor workspaces reuse private data.
  const queryClient = useMemo(() => {
    return new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: READYMEET_QUERY_GC_TIME_MS,
          staleTime: DEFAULT_QUERY_STALE_TIME_MS,
          refetchOnWindowFocus: true,
          refetchOnReconnect: true,
        },
      },
    });
  }, [userId, workspaceId]);

  useEffect(() => {
    // idb-keyval's store was used only for query persistence. Clear old plaintext generations.
    void removeLegacyQueryCache();
    try {
      window.sessionStorage.removeItem(WORKSPACE_END_MEETING_DETAIL_KEY);
      window.sessionStorage.removeItem(WORKSPACE_END_MEETING_PREPARATION_KEY);
    } catch (error) {
      // Browser storage can be unavailable; no query restore or new persistent write is attempted.
      void error;
    }

    return () => queryClient.clear();
  }, [queryClient]);

  return (
    <QueryClientProvider key={`${userId ?? "anonymous"}:${workspaceId ?? "none"}`} client={queryClient}>
      <IsRestoringProvider value={false}>{children}</IsRestoringProvider>
    </QueryClientProvider>
  );
}
