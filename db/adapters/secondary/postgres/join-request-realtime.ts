import {
  JOIN_REQUEST_REALTIME_VERSION,
  joinRequestRealtimeChannels,
  type JoinRequestRealtimeEventName,
  type JoinRequestRealtimePayload,
  type Meeting,
  type MeetingJoinRequest,
  meetingJoinRequestsRealtimeChannels,
} from "@readymeet/shared";
import { randomUUID } from "node:crypto";

import { publishRealtimeEvents } from "../../../ports/realtime";

export type MeetingJoinRequestRecord = MeetingJoinRequest & {
  sipCallId: string | null;
  sipParticipantIdentity: string | null;
  sipHoldingRoom: string | null;
};

/** Deliver waiting-room updates on this request. Hosts and guests subscribe to these channels. */
export async function publishMeetingJoinRequestEvents(input: {
  workspaceId: string;
  request: MeetingJoinRequestRecord;
  eventName: JoinRequestRealtimeEventName;
  meeting?: Meeting;
}): Promise<void> {
  const payload: JoinRequestRealtimePayload = {
    version: JOIN_REQUEST_REALTIME_VERSION,
    eventId: randomUUID(),
    eventName: input.eventName,
    request: input.request,
    meeting: input.meeting ?? null,
    occurredAt: new Date().toISOString(),
  };
  const meetingId = input.request.meetingId;
  const channels = [
    ...joinRequestRealtimeChannels({
      workspaceId: input.workspaceId,
      requestId: input.request.id,
    }),
    ...(meetingId === null || meetingId === ""
      ? []
      : meetingJoinRequestsRealtimeChannels({
          workspaceId: input.workspaceId,
          meetingId,
        })),
  ];

  await publishRealtimeEvents(
    channels.map((channel) => ({
      channel,
      eventName: input.eventName,
      payload,
    })),
  );
}
