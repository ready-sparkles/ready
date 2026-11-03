"use client";

import {
  joinRequestRealtimePayloadSchema,
  type MeetingJoinRequest,
  meetingJoinRequestsRealtimeChannel,
} from "@readymeet/shared";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

import type Ably from "../../composition/ably";

import { useRealtimeFallbackPolling } from "./use-realtime-fallback-polling";

export const JOIN_REQUEST_LIST_POLL_MS = 5_000;

const SUBSCRIPTION_FAILURE_MESSAGE = "[readymeet:realtime] Join request subscription failed.";

async function detachJoinRequests(channel: Ably.RealtimeChannel): Promise<void> {
  try {
    await channel.detach();
  } catch (error) {
    // Best effort: the connection may already be closed.
    if (!(error instanceof Error)) {
      console.error(SUBSCRIPTION_FAILURE_MESSAGE, error);
    }
  }
}

async function subscribeJoinRequests(input: {
  channel: Ably.RealtimeChannel;
  authScope: string;
  refreshAuth: (reason: string) => Promise<void>;
  authScopeRef: { current: string | null };
  isCancelled: () => boolean;
  onMessage: (message: { data?: unknown }) => void;
  onSubscribed: () => void;
}): Promise<void> {
  try {
    if (input.authScopeRef.current !== input.authScope) {
      await input.refreshAuth("host-join-requests");
      if (input.isCancelled()) {
        return;
      }
      const authScopeRef = input.authScopeRef;
      authScopeRef.current = input.authScope;
    }
    if (input.isCancelled()) {
      return;
    }
    const attachment = input.channel.subscribe(input.onMessage);
    // Ably registers the listener before awaiting attach; a suspended attach can recover later.
    if (input.channel.state !== "failed") {
      input.onSubscribed();
    }
    await attachment;
    if (input.isCancelled()) {
      input.channel.unsubscribe(input.onMessage);
      await input.channel.detach();

      return;
    }
  } catch (error) {
    if (!input.isCancelled()) {
      console.error(SUBSCRIPTION_FAILURE_MESSAGE, error);
    }
  }
}

function applyJoinRequestMessage(input: {
  message: { data?: unknown };
  meetingId: string;
  setJoinRequests: Dispatch<SetStateAction<MeetingJoinRequest[]>>;
}): boolean {
  const parsed = joinRequestRealtimePayloadSchema.safeParse(input.message.data);
  if (!parsed.success || parsed.data.request.meetingId !== input.meetingId) {
    return false;
  }
  const next = parsed.data.request;
  input.setJoinRequests((current) => {
    if (next.status !== "waiting") {
      return current.filter((request) => request.id !== next.id);
    }
    if (current.some((request) => request.id === next.id)) {
      return current.map((request) => (request.id === next.id ? next : request));
    }

    return [...current, next].sort((left, right) => Date.parse(left.requestedAt) - Date.parse(right.requestedAt));
  });

  return true;
}

type JoinRequestsRealtimeInput = {
  client: Ably.Realtime | null;
  meetingId: string | undefined;
  workspaceId: string | undefined;
  scopeKey: string;
  isEnabled: boolean;
  refreshAuth: (reason: string) => Promise<void>;
  authScopeRef: { current: string | null };
  refresh: () => Promise<void>;
  setJoinRequests: Dispatch<SetStateAction<MeetingJoinRequest[]>>;
};

/** An attached channel is not healthy until its subscription and connection are ready. */
export function useJoinRequestsRealtime(input: JoinRequestsRealtimeInput): boolean {
  const { client, meetingId, workspaceId, scopeKey, isEnabled } = input;
  const [health, setHealth] = useState({ client, meetingId, scopeKey, isHealthy: false });
  useEffect(() => {
    if (
      !isEnabled ||
      client === null ||
      meetingId === undefined ||
      meetingId === "" ||
      workspaceId === undefined ||
      workspaceId === ""
    ) {
      return;
    }
    const channel = client.channels.get(meetingJoinRequestsRealtimeChannel({ workspaceId, meetingId }));
    const state = { isCancelled: false, isSubscribed: false, isHealthy: false };
    const syncHealth = () => {
      if (state.isCancelled) {
        return;
      }
      const isHealthy = state.isSubscribed && channel.state === "attached" && client.connection.state === "connected";
      if (isHealthy && !state.isHealthy) {
        void input.refresh();
      }
      state.isHealthy = isHealthy;
      setHealth((current) =>
        current.client === client &&
        current.meetingId === meetingId &&
        current.scopeKey === scopeKey &&
        current.isHealthy === isHealthy
          ? current
          : { client, meetingId, scopeKey, isHealthy },
      );
    };
    const onChannelState = (change: Ably.ChannelStateChange) => {
      syncHealth();
      if (
        !state.isCancelled &&
        state.isSubscribed &&
        change.current === "attached" &&
        change.previous === "attached" &&
        !change.resumed
      ) {
        void input.refresh();
      }
    };
    const onMessage = (message: { data?: unknown }) => {
      if (
        !state.isCancelled &&
        applyJoinRequestMessage({ message, meetingId, setJoinRequests: input.setJoinRequests })
      ) {
        // Outbox retries can deliver older events after admission; reconcile with the server.
        void input.refresh();
      }
    };
    channel.on(onChannelState);
    client.connection.on(syncHealth);
    syncHealth();
    void subscribeJoinRequests({
      channel,
      authScope: `${scopeKey}:${meetingId}`,
      refreshAuth: input.refreshAuth,
      authScopeRef: input.authScopeRef,
      isCancelled: () => state.isCancelled,
      onMessage,
      onSubscribed: () => {
        state.isSubscribed = true;
        syncHealth();
      },
    });

    return () => {
      state.isCancelled = true;
      channel.off(onChannelState);
      client.connection.off(syncHealth);
      channel.unsubscribe(onMessage);
      if (state.isSubscribed) {
        // Ended meetings lose this channel capability on the next token refresh.
        void detachJoinRequests(channel);
      }
    };
  }, [
    client,
    meetingId,
    workspaceId,
    scopeKey,
    isEnabled,
    input.refreshAuth,
    input.authScopeRef,
    input.refresh,
    input.setJoinRequests,
  ]);

  return (
    isEnabled &&
    health.client === client &&
    health.meetingId === meetingId &&
    health.scopeKey === scopeKey &&
    health.isHealthy
  );
}

/** Keep checking the waiting list while Ably is connected, so a missed publish still shows Admit. */
export function useMeetingJoinRequestWatch(input: JoinRequestsRealtimeInput & { isPollingEnabled: boolean }): void {
  useJoinRequestsRealtime(input);
  useRealtimeFallbackPolling({
    enabled: input.isPollingEnabled,
    intervalMs: JOIN_REQUEST_LIST_POLL_MS,
    onPoll: input.refresh,
  });
}
