"use client";

import { calendarRealtimeEventSchema } from "@readymeet/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { calendarEventsQueryKey } from "../../domain/query-keys";
import {
  attachSharedChannel,
  isTransientRealtimeError,
  REALTIME_RETRY_DELAYS_MS,
  subscribeSharedChannel,
} from "../../domain/realtime-shared-channel";
import { useRealtimeClient } from "../components/realtime-provider";

const CALENDAR_REALTIME_FAST_RECONCILE_DELAY_MS = 1_500;
const CALENDAR_REALTIME_SLOW_RECONCILE_DELAY_MS = 5_000;
const CALENDAR_REALTIME_UNAVAILABLE_LOG = "[readymeet:realtime] calendar realtime unavailable.";

type RealtimeClient = NonNullable<ReturnType<typeof useRealtimeClient>["client"]>;
type RealtimeChannel = ReturnType<RealtimeClient["channels"]["get"]>;

function calendarChannel(input: { workspaceId: string; userId: string }): string {
  return `workspace:${input.workspaceId}:user:${input.userId}:tasks`;
}

async function detachChannel(channel: RealtimeChannel): Promise<void> {
  try {
    await channel.detach();
  } catch (detachError: unknown) {
    void detachError;
    // The scoped client may already be closing or the channel may never have attached.
  }
}

export function useCalendarRealtime(input: {
  workspaceId?: string | null;
  userId?: string | null;
  isEnabled?: boolean;
}): void {
  const { client, refreshRealtimeAuth, scopeKey } = useRealtimeClient();
  const queryClient = useQueryClient();
  const reconcileTimeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    const workspaceId = input.workspaceId;
    const userId = input.userId;
    const hasWorkspaceId = workspaceId !== null && workspaceId !== undefined && workspaceId !== "";
    const hasUserId = userId !== null && userId !== undefined && userId !== "";
    if (client === null || !hasWorkspaceId || !hasUserId || input.isEnabled === false) {
      return;
    }

    const effectState = { isCancelled: false };
    const channel = client.channels.get(
      calendarChannel({
        workspaceId,
        userId,
      }),
    );
    const clearReconcileTimeouts = (): void => {
      reconcileTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      reconcileTimeoutsRef.current = [];
    };
    const invalidateCalendarEvents = (): void => {
      const queryKey = calendarEventsQueryKey(userId);
      void queryClient.invalidateQueries({ queryKey });
      clearReconcileTimeouts();
      reconcileTimeoutsRef.current = [
        CALENDAR_REALTIME_FAST_RECONCILE_DELAY_MS,
        CALENDAR_REALTIME_SLOW_RECONCILE_DELAY_MS,
      ].map((delayMs) =>
        window.setTimeout(() => {
          void queryClient.refetchQueries({ queryKey, type: "active" });
        }, delayMs),
      );
    };
    const handler = (message: { data?: unknown }): void => {
      const parsed = calendarRealtimeEventSchema.safeParse(message.data);
      if (!parsed.success || parsed.data.userId === userId) {
        invalidateCalendarEvents();
      }
    };

    const connect = async (attempt: number): Promise<void> => {
      try {
        await refreshRealtimeAuth(`calendar:${workspaceId}:${userId}:initial`);
        await attachSharedChannel(channel);
        if (!effectState.isCancelled) {
          await subscribeSharedChannel({ channel, handler });
        }
      } catch (attachError) {
        if (effectState.isCancelled) {
          return;
        }
        const retryDelayMs = REALTIME_RETRY_DELAYS_MS[attempt];
        if (isTransientRealtimeError(attachError) && retryDelayMs !== undefined) {
          await new Promise((resolve) => {
            setTimeout(resolve, retryDelayMs);
          });
          await connect(attempt + 1);

          return;
        }
        console.error(CALENDAR_REALTIME_UNAVAILABLE_LOG, { error: attachError });
      }
    };
    void connect(0);

    return () => {
      effectState.isCancelled = true;
      clearReconcileTimeouts();
      channel.unsubscribe(handler);
      void detachChannel(channel);
    };
  }, [client, input.isEnabled, input.userId, input.workspaceId, queryClient, refreshRealtimeAuth, scopeKey]);
}
