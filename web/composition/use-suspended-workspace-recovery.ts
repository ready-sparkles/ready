"use client";

import { useEffect, useRef } from "react";

import { isCurrentSessionToken } from "../domain/stale-session-redirect";
import type { AuthSession } from "../domain/types";

import { onSuspendedWorkspace } from "./api";

/** Wait this long before a new re-resolve try for a workspace whose last try did not move the session. */
export const SUSPENDED_WORKSPACE_RETRY_COOLDOWN_MS = 30_000;

async function refreshMovesWorkspace(input: {
  refreshSession: () => Promise<AuthSession | null>;
  workspaceId: string;
}): Promise<boolean> {
  try {
    const next = await input.refreshSession();

    return next !== null && next.user.workspaceId !== input.workspaceId;
  } catch (error: unknown) {
    void error;

    // Keep the current session; workspace pages still show their own errors.
    return false;
  }
}

/**
 * A user can be suspended from their active workspace while signed in. The API
 * then answers workspace requests with 403 `workspace_suspended`, but the
 * session still names that workspace. Re-resolve the session the same way a
 * fresh sign-in does: the API moves the user to an active workspace, or opens
 * an owned replacement when they have none.
 *
 * Only one refresh runs at a time. When a refresh fails, returns no session,
 * or keeps the same workspace, a later rejection may try again after a
 * cooldown, so a temporary outage cannot block recovery and a server that
 * keeps the workspace cannot cause a loop.
 */
export function useSuspendedWorkspaceRecovery(input: {
  session: AuthSession | null;
  refreshSession: () => Promise<AuthSession | null>;
  subscribe?: typeof onSuspendedWorkspace;
  now?: () => number;
}): void {
  const { session, refreshSession, subscribe = onSuspendedWorkspace, now = Date.now } = input;
  const retryNotBeforeByWorkspaceIdRef = useRef(new Map<string, number>());
  const isRefreshingRef = useRef(false);
  const sessionToken = session?.token ?? null;
  const workspaceId = session?.user.workspaceId ?? null;

  useEffect(
    () =>
      subscribe((rejectedToken) => {
        if (
          workspaceId === null ||
          isRefreshingRef.current ||
          now() < (retryNotBeforeByWorkspaceIdRef.current.get(workspaceId) ?? 0) ||
          !isCurrentSessionToken({ rejectedToken, sessionToken })
        ) {
          return;
        }
        isRefreshingRef.current = true;
        void (async () => {
          const hasMovedToOtherWorkspace = await refreshMovesWorkspace({ refreshSession, workspaceId });
          retryNotBeforeByWorkspaceIdRef.current.set(
            workspaceId,
            hasMovedToOtherWorkspace ? Number.POSITIVE_INFINITY : now() + SUSPENDED_WORKSPACE_RETRY_COOLDOWN_MS,
          );
          isRefreshingRef.current = false;
        })();
      }),
    [now, refreshSession, sessionToken, subscribe, workspaceId],
  );
}
