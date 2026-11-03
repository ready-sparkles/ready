import { bindPortFunction } from "./bind-port";

const MEETING_NOTES_ACCESS_PORT_IS_NOT_CONFIGURED_MESSAGE = "MeetingNotesAccess port is not configured.";

type MeetingViewerRole = "host" | "participant" | "workspace" | "guest" | "untrusted";

type MeetingNotesAccess = {
  /** @external meeting notes access payload */
  locked: boolean;
  reason: "upgrade_required" | "credits_required" | "signup_required" | null;
};

type MeetingNotesAccessPort = {
  resolveMeetingNotesAccess: (input: {
    meeting: {
      id: string;
      status: string;
      kind: string;
      workspaceId: string;
      createdByUserId: string;
      createdAt: Date;
    };
    viewerRole: MeetingViewerRole;
    userId: string;
  }) => Promise<MeetingNotesAccess>;
};

const meetingNotesAccessState: { port?: MeetingNotesAccessPort } = {};

export function configureMeetingNotesAccess(port: MeetingNotesAccessPort): void {
  meetingNotesAccessState.port = port;
}

function meetingNotesAccess(): MeetingNotesAccessPort {
  if (meetingNotesAccessState.port === undefined) {
    throw new Error(MEETING_NOTES_ACCESS_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return meetingNotesAccessState.port;
}

export const resolveMeetingNotesAccess: MeetingNotesAccessPort["resolveMeetingNotesAccess"] = bindPortFunction(
  () => meetingNotesAccess().resolveMeetingNotesAccess,
);
