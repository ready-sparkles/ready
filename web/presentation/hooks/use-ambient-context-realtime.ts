"use client";

import {
  AMBIENT_CONTEXT_REALTIME_EVENT_NAME,
  ambientContextRealtimeEventSchema,
  meetingAmbientContextRealtimeChannel,
} from "@readymeet/shared";
import { useEffect, useState } from "react";

import type Ably from "../../composition/ably";
import { reportOptionalLiveServiceFailure } from "../lib/optional-live-feature-failure";

const AMBIENT_CONTEXT_REALTIME_FAILURE_MESSAGE = "[readymeet:ambient-context] Realtime subscription failed.";

async function subscribeAmbientContextAfterAuth(input: {
  channel: Ably.RealtimeChannel;
  refreshAuth: (reason: string) => Promise<void>;
  onMessage: (message: { data?: unknown }) => void;
  readIsCancelled: () => boolean;
  onListening: () => void;
  onSubscribed: () => void;
}): Promise<void> {
  const { channel, refreshAuth, onMessage, readIsCancelled, onListening, onSubscribed } = input;
  try {
    await refreshAuth("ambient-context");
    if (readIsCancelled()) {
      return;
    }
    onListening();
    await channel.subscribe(AMBIENT_CONTEXT_REALTIME_EVENT_NAME, onMessage);
    if (readIsCancelled()) {
      channel.unsubscribe(AMBIENT_CONTEXT_REALTIME_EVENT_NAME, onMessage);

      return;
    }
    onSubscribed();
  } catch (error) {
    if (!readIsCancelled() && !reportOptionalLiveServiceFailure({ error, feature: "realtime" })) {
      console.error(AMBIENT_CONTEXT_REALTIME_FAILURE_MESSAGE);
    }
  }
}

export function useAmbientContextRealtime(input: {
  client: Ably.Realtime | null;
  isEnabled: boolean;
  meetingId: string | undefined;
  workspaceId: string | undefined;
  scopeKey: string;
  refreshAuth: (reason: string) => Promise<void>;
  refresh: () => Promise<void>;
}): boolean {
  const { client, isEnabled, meetingId, workspaceId, scopeKey, refreshAuth, refresh } = input;
  const [health, setHealth] = useState({ client, meetingId, scopeKey, isHealthy: false });

  useEffect(() => {
    const hasMeetingId = meetingId !== undefined && meetingId.length > 0;
    const hasWorkspaceId = workspaceId !== undefined && workspaceId.length > 0;
    if (!isEnabled || client === null || !hasMeetingId || !hasWorkspaceId) {
      return;
    }
    const channel = client.channels.get(meetingAmbientContextRealtimeChannel({ workspaceId, meetingId }));
    const subscriptionState = { isCancelled: false, isListening: false, hasBeenHealthy: false };
    const readIsCancelled = () => subscriptionState.isCancelled;
    const syncHealth = () => {
      if (readIsCancelled()) {
        return;
      }
      const isHealthy =
        subscriptionState.isListening && channel.state === "attached" && client.connection.state === "connected";
      setHealth((current) =>
        current.client === client &&
        current.meetingId === meetingId &&
        current.scopeKey === scopeKey &&
        current.isHealthy === isHealthy
          ? current
          : { client, meetingId, scopeKey, isHealthy },
      );
      if (isHealthy && !subscriptionState.hasBeenHealthy) {
        void refresh();
      }
      subscriptionState.hasBeenHealthy = isHealthy;
    };
    const onChannelState = (change: Ably.ChannelStateChange) => {
      syncHealth();
      if (
        subscriptionState.isListening &&
        change.current === "attached" &&
        change.previous === "attached" &&
        !change.resumed
      ) {
        void refresh();
      }
    };
    const onMessage = (message: { data?: unknown }) => {
      const parsed = ambientContextRealtimeEventSchema.safeParse(message.data);
      if (!readIsCancelled() && parsed.success && parsed.data.meetingId === meetingId) {
        void refresh();
      }
    };
    channel.on(onChannelState);
    client.connection.on(syncHealth);
    syncHealth();
    void subscribeAmbientContextAfterAuth({
      channel,
      refreshAuth,
      onMessage,
      readIsCancelled,
      onListening: () => {
        subscriptionState.isListening = true;
      },
      onSubscribed: syncHealth,
    });

    return () => {
      subscriptionState.isCancelled = true;
      channel.off(onChannelState);
      client.connection.off(syncHealth);
      channel.unsubscribe(AMBIENT_CONTEXT_REALTIME_EVENT_NAME, onMessage);
    };
  }, [client, isEnabled, meetingId, workspaceId, scopeKey, refreshAuth, refresh]);

  return (
    isEnabled &&
    health.client === client &&
    health.meetingId === meetingId &&
    health.scopeKey === scopeKey &&
    health.isHealthy
  );
}
