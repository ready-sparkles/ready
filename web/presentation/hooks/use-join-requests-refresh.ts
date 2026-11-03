"use client";

import type { MeetingJoinRequest } from "@readymeet/shared";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";

import { listMeetingJoinRequests } from "../../composition/api";
import { createQueuedRefresh } from "../../domain/queued-refresh";
import { loadJoinRequestsKeepingControlsOnOutage } from "../lib/live-meeting-join-requests";

const REQUEST_TIMEOUT_MS = 10_000;

type JoinRequestsRefreshInput = {
  meetingId: string | undefined;
  token: string | undefined;
  scopeKey: string;
  isEnabled: boolean;
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<{ token: string } | null>;
};

/** Keep queued reads and their results inside the same viewer/meeting lifetime. */
export function useJoinRequestsRefresh(input: JoinRequestsRefreshInput): {
  joinRequests: MeetingJoinRequest[];
  canModerateJoinRequests: boolean;
  isJoinRequestsLoading: boolean;
  /** False once the API answered 403 for this viewer and meeting, so polling stops instead of repeating it. */
  canPollJoinRequests: boolean;
  setJoinRequests: Dispatch<SetStateAction<MeetingJoinRequest[]>>;
  loadJoinRequests: () => Promise<void>;
} {
  const { meetingId, token, scopeKey, isEnabled, refreshAuthAfterUnauthorized } = input;
  const scope = `${scopeKey}:${meetingId ?? ""}:${token ?? ""}:${isEnabled}`;
  const [state, setState] = useState({
    scope,
    requests: [] as MeetingJoinRequest[],
    canModerate: false,
    isLoading: false,
    isForbidden: false,
  });
  const refreshRef = useRef(async () => {});
  const refresh = useCallback(() => refreshRef.current(), [scope]);
  const setJoinRequests: Dispatch<SetStateAction<MeetingJoinRequest[]>> = useCallback(
    (update) => {
      setState((current) =>
        current.scope === scope
          ? { ...current, requests: typeof update === "function" ? update(current.requests) : update }
          : current,
      );
    },
    [scope],
  );

  useEffect(() => {
    setState({ scope, requests: [], canModerate: false, isLoading: false, isForbidden: false });
    if (!isEnabled || meetingId === undefined || meetingId === "" || token === undefined || token === "") {
      return;
    }
    const controller = new AbortController();
    const updateState = (update: Partial<typeof state>) => {
      if (!controller.signal.aborted) {
        setState((current) => (current.scope === scope ? { ...current, ...update } : current));
      }
    };
    const isCancelled = () => controller.signal.aborted;
    // Non-hosts get 403 on every read; remember it for this viewer and meeting instead of asking again.
    const access = { isForbidden: false };
    const queuedRefresh = createQueuedRefresh(async () => {
      if (isCancelled() || access.isForbidden) {
        return;
      }
      updateState({ isLoading: true });
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      try {
        await loadJoinRequestsKeepingControlsOnOutage({
          token,
          signal: controller.signal,
          listJoinRequests: (nextToken) => listMeetingJoinRequests({ token: nextToken, meetingId, signal }),
          refreshAuthAfterUnauthorized: async (error) => {
            if (signal.aborted) {
              return null;
            }

            return refreshAuthAfterUnauthorized(error);
          },
          setJoinRequests: (requests) => {
            updateState({ requests, canModerate: true });
          },
          onForbidden: () => {
            access.isForbidden = true;
            updateState({ isForbidden: true });
          },
          setCanModerateJoinRequests: (canModerate) => {
            if (!canModerate) {
              updateState({ requests: [], canModerate: false });
            } else {
              updateState({ canModerate: true });
            }
          },
        });
      } finally {
        updateState({ isLoading: false });
      }
    });
    refreshRef.current = queuedRefresh;

    return () => {
      controller.abort();
      refreshRef.current = async () => {};
    };
  }, [scope, meetingId, token, isEnabled, refreshAuthAfterUnauthorized]);

  return {
    joinRequests: state.scope === scope ? state.requests : [],
    canModerateJoinRequests: state.scope === scope && state.canModerate,
    isJoinRequestsLoading: state.scope === scope && state.isLoading,
    canPollJoinRequests: state.scope === scope && !state.isForbidden,
    setJoinRequests,
    loadJoinRequests: refresh,
  };
}
