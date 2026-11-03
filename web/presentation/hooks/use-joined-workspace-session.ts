"use client";

import { useEffect } from "react";

import type { AuthSession } from "../../domain/types";
import { createTimerGroup } from "../lib/timer-group";

// Auth exchanges retain the previous session for 30 seconds after a temporary failure.
export const JOINED_WORKSPACE_REFRESH_RETRY_MS = 31_000;

/** Session synchronization must never gate an already-successful meeting join. */
export function useJoinedWorkspaceSession({
  enabled: isEnabled,
  userId,
  expectedWorkspaceId,
  refreshSession,
  onSynced,
}: {
  /** @external React hook option */
  enabled: boolean;
  userId: string | undefined;
  expectedWorkspaceId: string | null;
  refreshSession: () => Promise<AuthSession | null>;
  onSynced: (session: AuthSession) => void;
}): void {
  useEffect(() => {
    if (!isEnabled || userId === undefined || expectedWorkspaceId === null) {
      return;
    }
    const lifecycle = { isCancelled: false };
    const timers = createTimerGroup();
    const refresh = async (): Promise<void> => {
      const session = await (async (): Promise<AuthSession | null> => {
        try {
          return await refreshSession();
        } catch (error) {
          if (error instanceof Error) {
            // Keep the call running while the authentication service recovers.
          }

          return null;
        }
      })();
      if (lifecycle.isCancelled) {
        return;
      }
      if (session !== null && session.user.id !== userId) {
        return;
      }
      if (session !== null && session.user.workspaceId === expectedWorkspaceId) {
        onSynced(session);

        return;
      }
      timers.setTimeout({
        run: () => {
          void refresh();
        },
        delayMs: JOINED_WORKSPACE_REFRESH_RETRY_MS,
      });
    };
    void refresh();

    return () => {
      lifecycle.isCancelled = true;
      timers.clear();
    };
  }, [isEnabled, userId, expectedWorkspaceId, refreshSession, onSynced]);
}
