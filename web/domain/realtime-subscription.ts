export async function authorizeRealtimeSetup(input: {
  refreshAuth: () => Promise<unknown>;
  isCancelled: () => boolean;
}): Promise<boolean> {
  await input.refreshAuth();

  return !input.isCancelled();
}

export function shouldSubscribeToJoinedMeetingChannel(input: {
  hasJoinedMeeting: boolean;
  isGuestSession: boolean;
}): boolean {
  return input.hasJoinedMeeting && !input.isGuestSession;
}

export async function recoverFailedRealtimeChannel(channel: { state?: unknown; attach: () => unknown }): Promise<void> {
  const channelState = channel.state;
  const normalizedState = typeof channelState === "string" ? channelState : "";
  if (normalizedState.toLowerCase() === "failed") {
    await channel.attach();
  }
}

export async function subscribeAndTrackRealtimeChannel<TChannel>(input: {
  channel: TChannel;
  subscribe: () => Promise<unknown>;
  unsubscribe: () => void;
  detach?: () => Promise<unknown> | void;
  isCancelled: () => boolean;
  subscribedChannels: Set<TChannel>;
}): Promise<void> {
  await input.subscribe();

  if (input.isCancelled()) {
    input.unsubscribe();
    await input.detach?.();

    return;
  }

  const subscribedChannels = input.subscribedChannels;
  subscribedChannels.add(input.channel);
}

export function shouldRefetchForRealtimeContinuity(input: {
  eventName: string;
  stateChange: { /** @external Ably channel state contract */ resumed?: boolean; previous?: string };
  isSuspended?: boolean;
}): boolean {
  if (input.eventName !== "attached" && input.eventName !== "update") {
    return false;
  }

  return (
    input.stateChange.resumed === false || input.isSuspended === true || input.stateChange.previous === "suspended"
  );
}
