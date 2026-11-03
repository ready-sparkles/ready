"use client";
import { MEETING_TRACKER_EVENT, meetingTrackerChannel, type MeetingTrackerState } from "@readymeet/shared";
import { useEffect, useMemo, useState } from "react";

import type Ably from "../../composition/ably";
import { getMeetingTracker } from "../../composition/api";
import { reportOptionalLiveServiceFailure } from "../lib/optional-live-feature-failure";

const MEETING_TRACKER_REQUEST_TIMEOUT_MS = 10_000;
// Also refresh terminal failure status and permissions when no update event arrives.
const MEETING_TRACKER_POLL_INTERVAL_MS = 10_000;
const MEETING_TRACKER_AUTH_REASON = "meeting-tracker";

type ChannelStateEvent = "attached" | "update";
type ChannelListener = { event: ChannelStateEvent; callback: () => void };
type MessageListener = { event: string; callback: () => void };
/** Minimal realtime surface used by the tracker; see toMeetingTrackerRealtimeClient for the Ably adapter. */
export type MeetingTrackerRealtimeChannel = {
  listen: (listener: ChannelListener) => void;
  unlisten: (listener: ChannelListener) => void;
  subscribe: (listener: MessageListener) => Promise<void>;
  unsubscribe: (listener: MessageListener) => void;
};
export type MeetingTrackerRealtimeClient = { getChannel: (name: string) => MeetingTrackerRealtimeChannel };

export function toMeetingTrackerRealtimeClient(client: Ably.Realtime | null): MeetingTrackerRealtimeClient | null {
  if (client === null) {
    return null;
  }

  return {
    getChannel: (name) => {
      const channel = client.channels.get(name);

      return {
        listen: ({ event, callback }) => {
          channel.on(event, callback);
        },
        unlisten: ({ event, callback }) => {
          channel.off(event, callback);
        },
        subscribe: async ({ event, callback }) => {
          await channel.subscribe(event, callback);
        },
        unsubscribe: ({ event, callback }) => {
          channel.unsubscribe(event, callback);
        },
      };
    },
  };
}
type MeetingTrackerLoader = typeof getMeetingTracker;
type MeetingTrackerResult = { data: MeetingTrackerState | null; hasError: boolean };
type RefreshLoopState = { isActive: boolean; isRunning: boolean; isRequested: boolean };

const EMPTY_RESULT: MeetingTrackerResult = { data: null, hasError: false };

async function loadTrackerResult(input: {
  load: MeetingTrackerLoader;
  token: string;
  meetingId: string;
  signal: AbortSignal;
}): Promise<MeetingTrackerResult> {
  try {
    const data = await input.load({
      token: input.token,
      meetingId: input.meetingId,
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(MEETING_TRACKER_REQUEST_TIMEOUT_MS)]),
    });

    return { data, hasError: false };
  } catch (error) {
    // Clear sensitive results on denied access, expired sessions, or loss of verification.
    return {
      data: null,
      hasError:
        !reportOptionalLiveServiceFailure({ error, feature: "research" }) && (error instanceof Error || error !== null),
    };
  }
}

// Reads through a call so narrowing from before an await does not hide cleanup that happened during it.
function isLoopActive(loop: RefreshLoopState): boolean {
  return loop.isActive;
}

function isLoopRequested(loop: RefreshLoopState): boolean {
  return loop.isRequested;
}

/** Serializes refreshes; an update arriving mid-request schedules exactly one follow-up refresh. */
async function runRefreshLoop(input: {
  loop: RefreshLoopState;
  fetchResult: () => Promise<MeetingTrackerResult>;
  onResult: (result: MeetingTrackerResult) => void;
}): Promise<void> {
  const { loop } = input;
  if (loop.isRunning) {
    loop.isRequested = true;

    return;
  }
  loop.isRunning = true;
  loop.isRequested = false;
  const result = await input.fetchResult();
  if (isLoopActive(loop)) {
    input.onResult(result);
  }
  loop.isRunning = false;
  if (isLoopActive(loop) && isLoopRequested(loop)) {
    await runRefreshLoop(input);
  }
}

async function subscribeToTrackerUpdates(input: {
  channel: MeetingTrackerRealtimeChannel;
  loop: RefreshLoopState;
  refreshAuth: (reason: string) => Promise<void>;
  onUpdate: () => void;
}): Promise<void> {
  const { channel, loop, onUpdate } = input;
  try {
    await input.refreshAuth(MEETING_TRACKER_AUTH_REASON);
    if (!loop.isActive) {
      return;
    }
    await channel.subscribe({ event: MEETING_TRACKER_EVENT, callback: onUpdate });
    if (!isLoopActive(loop)) {
      channel.unsubscribe({ event: MEETING_TRACKER_EVENT, callback: onUpdate });

      return;
    }
    onUpdate();
  } catch (error) {
    // Polling also recovers missing realtime configuration.
    if (!(error instanceof Error)) {
      throw error;
    }
  }
}

export function useMeetingTracker({
  token,
  meetingId,
  workspaceId,
  isEnabled,
  client,
  refreshAuth,
  load = getMeetingTracker,
}: {
  token?: string;
  meetingId?: string;
  workspaceId?: string;
  isEnabled: boolean;
  client: MeetingTrackerRealtimeClient | null;
  refreshAuth: (reason: string) => Promise<void>;
  load?: MeetingTrackerLoader;
}): MeetingTrackerResult {
  const scope = useMemo(() => ({ token, meetingId, isEnabled }), [token, meetingId, isEnabled]);
  const [result, setResult] = useState<(MeetingTrackerResult & { scope: typeof scope }) | null>(null);
  useEffect(() => {
    if (!isEnabled || token === undefined || token === "" || meetingId === undefined || meetingId === "") {
      return undefined;
    }
    const loop: RefreshLoopState = { isActive: true, isRunning: false, isRequested: false };
    const controller = new AbortController();
    const onUpdate = () => {
      void runRefreshLoop({
        loop,
        fetchResult: async () => loadTrackerResult({ load, token, meetingId, signal: controller.signal }),
        onResult: (next) =>
          setResult((current) =>
            current?.scope === scope &&
            current.hasError === next.hasError &&
            JSON.stringify(current.data) === JSON.stringify(next.data)
              ? current
              : { ...next, scope },
          ),
      });
    };
    const channel =
      client !== null && workspaceId !== undefined && workspaceId !== ""
        ? client.getChannel(meetingTrackerChannel({ workspaceId, meetingId }))
        : null;
    if (channel !== null) {
      channel.listen({ event: "attached", callback: onUpdate });
      channel.listen({ event: "update", callback: onUpdate });
      void subscribeToTrackerUpdates({ channel, loop, refreshAuth, onUpdate });
    }
    onUpdate();
    const timer = setInterval(onUpdate, MEETING_TRACKER_POLL_INTERVAL_MS);

    return () => {
      loop.isActive = false;
      controller.abort();
      clearInterval(timer);
      channel?.unlisten({ event: "attached", callback: onUpdate });
      channel?.unlisten({ event: "update", callback: onUpdate });
      channel?.unsubscribe({ event: MEETING_TRACKER_EVENT, callback: onUpdate });
    };
  }, [scope, token, meetingId, workspaceId, isEnabled, client, refreshAuth, load]);

  return result?.scope === scope ? { data: result.data, hasError: result.hasError } : EMPTY_RESULT;
}
