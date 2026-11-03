export function meetingJoinRequestsRealtimeChannel(input: { workspaceId: string; meetingId: string }): string {
  return `workspace:${input.workspaceId}:meeting:${input.meetingId}:join-requests`;
}

export function joinRequestRealtimeChannel(input: { workspaceId: string; requestId: string }): string {
  return `workspace:${input.workspaceId}:join-request:${input.requestId}`;
}

export function meetingAmbientContextRealtimeChannel(input: { workspaceId: string; meetingId: string }): string {
  return `workspace:${input.workspaceId}:meeting:${input.meetingId}:ambient-context`;
}

/** Temporary unscoped names retained for one rolling-deploy compatibility window. */
export function legacyMeetingJoinRequestsRealtimeChannel(input: { meetingId: string }): string {
  return `meeting:${input.meetingId}:join-requests`;
}

export function legacyJoinRequestRealtimeChannel(input: { requestId: string }): string {
  return `join-request:${input.requestId}`;
}

export function meetingJoinRequestsRealtimeChannels(input: {
  workspaceId: string;
  meetingId: string;
}): readonly [string, string] {
  return [meetingJoinRequestsRealtimeChannel(input), legacyMeetingJoinRequestsRealtimeChannel(input)] as const;
}

export function joinRequestRealtimeChannels(input: {
  workspaceId: string;
  requestId: string;
}): readonly [string, string] {
  return [joinRequestRealtimeChannel(input), legacyJoinRequestRealtimeChannel(input)] as const;
}

export function isLegacyJoinRequestRealtimeChannel(channel: string): boolean {
  return channel.startsWith("join-request:") || (channel.startsWith("meeting:") && channel.endsWith(":join-requests"));
}
