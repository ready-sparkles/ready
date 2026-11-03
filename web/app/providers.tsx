"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useCallback } from "react";

import { listMyWorkspaceIds } from "../composition/api";
import { SessionProvider } from "../composition/next-auth-react";
import { isIsolatedPreviewPath } from "../domain/isolated-preview-path";
import { assignedTasksQueryKey, personalAssignedTasksQueryKey } from "../domain/query-keys";
import { supportsReadyAppearance } from "../domain/theme";
import { AuthProvider, useAuth } from "../presentation/components/auth-provider";
import { DynamicFavicon } from "../presentation/components/dynamic-favicon";
import { ReadyQueryProvider } from "../presentation/components/query-provider";
import { RealtimeProvider } from "../presentation/components/realtime-provider";
import { ThemeProvider } from "../presentation/components/theme-provider";
import { ToastProvider } from "../presentation/components/toast-provider";
import { WorkspaceSwitchHotkeys } from "../presentation/components/workspace-switch-hotkeys";
import { useRealtimeFallbackPolling } from "../presentation/hooks/use-realtime-fallback-polling";
import { useAssignedTaskRealtime } from "../presentation/hooks/use-task-realtime";

const WORKSPACE_IDS_STALE_TIME_MS = 30_000;
const MISSING_WORKSPACE_SESSION_MESSAGE = "Workspace session is missing.";

function assignedTaskRealtimeScope(input: { isGuestSession: boolean; workspaceIds: string[]; sessionUserId: string }) {
  if (input.isGuestSession || input.sessionUserId.length === 0) {
    return { memberWorkspaceIds: [], memberUserId: null };
  }

  return { memberWorkspaceIds: input.workspaceIds, memberUserId: input.sessionUserId };
}

function AssignedTaskRealtimeBridge() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const isGuestSession = session?.user.source === "guest";
  const sessionToken = session?.token ?? "";
  const sessionUserId = session?.user.id ?? "";
  const sessionWorkspaceId = session?.user.workspaceId ?? "";
  const workspaceIdsQuery = useQuery({
    queryKey: ["my-workspace-ids", session?.user.id],
    queryFn: () => {
      if (sessionToken.length === 0) {
        throw new Error(MISSING_WORKSPACE_SESSION_MESSAGE);
      }

      return listMyWorkspaceIds(sessionToken);
    },
    enabled: sessionToken.length > 0 && sessionUserId.length > 0 && !isGuestSession,
    staleTime: WORKSPACE_IDS_STALE_TIME_MS,
  });
  const workspaceIds = [
    ...new Set([...(workspaceIdsQuery.data ?? []), ...(sessionWorkspaceId.length > 0 ? [sessionWorkspaceId] : [])]),
  ];
  const { memberWorkspaceIds, memberUserId } = assignedTaskRealtimeScope({
    isGuestSession,
    workspaceIds,
    sessionUserId,
  });
  // Guests have no assigned-task channel capability; subscribing only produces 40160 noise.
  const assignedTaskRealtime = useAssignedTaskRealtime({
    workspaceIds: memberWorkspaceIds,
    userId: memberUserId,
  });
  const pollAssignedTasksFallback = useCallback(() => {
    if (sessionUserId.length === 0 || isGuestSession) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: assignedTasksQueryKey(sessionUserId) });
    void queryClient.invalidateQueries({ queryKey: personalAssignedTasksQueryKey(sessionUserId) });
  }, [isGuestSession, queryClient, sessionUserId]);

  useRealtimeFallbackPolling({
    enabled: assignedTaskRealtime.status === "degraded",
    onPoll: pollAssignedTasksFallback,
  });

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Product examples and the homepage demo must not mount real account
  // services, restore private query caches, or subscribe to live task updates.
  if (isIsolatedPreviewPath(pathname)) {
    return (
      <ThemeProvider
        appearanceEnabled={false}
        fixedTheme={
          pathname === "/demo/workspace/dark-notes" ||
          pathname === "/demo/workspace/dark-memory" ||
          pathname === "/demo/workspace/dark-tasks"
            ? "dark"
            : "light"
        }
      >
        {children}
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider appearanceEnabled={supportsReadyAppearance(pathname)}>
      <SessionProvider>
        <DynamicFavicon />
        <AuthProvider>
          <ReadyQueryProvider>
            <RealtimeProvider>
              <AssignedTaskRealtimeBridge />
              <ToastProvider>
                <WorkspaceSwitchHotkeys />
                {children}
              </ToastProvider>
            </RealtimeProvider>
          </ReadyQueryProvider>
        </AuthProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
