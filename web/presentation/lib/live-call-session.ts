import type { ConnectionState, Room } from "livekit-client";

type LiveCallSession = {
  meetingId: string;
  connectionState: ConnectionState;
  localParticipantIdentity: string | null;
};

export function createLiveCallSession(input: {
  meetingId: string;
  connectionState: ConnectionState;
  room: Room | null;
}): LiveCallSession {
  return {
    meetingId: input.meetingId,
    connectionState: input.connectionState,
    localParticipantIdentity: input.room?.localParticipant.identity ?? null,
  };
}
