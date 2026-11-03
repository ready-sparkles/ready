import type { RepositoryPort } from "@readymeet/db/ports/repository";

import { bindPortFunction } from "./bind-port";

const MEETING_ACCESS_PORT_IS_NOT_CONFIGURED_MESSAGE = "MeetingAccess port is not configured.";

type MeetingAccessPort = {
  isAuthorizedMeetingHost: (input: { meeting: MeetingRecord; userId: string }) => Promise<boolean>;
};

const meetingAccessState: { port?: MeetingAccessPort } = {};

export function configureMeetingAccess(port: MeetingAccessPort): void {
  meetingAccessState.port = port;
}

function meetingAccess(): MeetingAccessPort {
  if (meetingAccessState.port === undefined) {
    throw new Error(MEETING_ACCESS_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return meetingAccessState.port;
}

export const isAuthorizedMeetingHost: MeetingAccessPort["isAuthorizedMeetingHost"] = bindPortFunction(
  () => meetingAccess().isAuthorizedMeetingHost,
);

export type MeetingRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
