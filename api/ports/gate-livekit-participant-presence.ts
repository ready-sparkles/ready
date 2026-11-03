import { bindPortFunction } from "./bind-port";

const LIVEKIT_PARTICIPANT_PRESENCE_PORT_IS_NOT_CONFIGURED_MESSAGE =
  "LivekitParticipantPresence port is not configured.";

type LivekitParticipantPresencePort = {
  listConnectedMeetingUserIds: (input: { meetingId: string; roomName: string }) => Promise<Set<string>>;
};

const livekitParticipantPresenceState: { port?: LivekitParticipantPresencePort } = {};

export function configureLivekitParticipantPresence(port: LivekitParticipantPresencePort): void {
  livekitParticipantPresenceState.port = port;
}

function livekitParticipantPresence(): LivekitParticipantPresencePort {
  if (livekitParticipantPresenceState.port === undefined) {
    throw new Error(LIVEKIT_PARTICIPANT_PRESENCE_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return livekitParticipantPresenceState.port;
}

export const listConnectedMeetingUserIds: LivekitParticipantPresencePort["listConnectedMeetingUserIds"] =
  bindPortFunction(() => livekitParticipantPresence().listConnectedMeetingUserIds);
