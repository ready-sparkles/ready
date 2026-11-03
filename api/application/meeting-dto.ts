import { repositories } from "../ports/repository-runtime";

import { ensureMeetingCallInForMeetingSafely } from "./meeting-call-in";

/**
 * How the requesting viewer relates to the meeting being serialized. Routes
 * derive this from their access level (request.meetingAccess.viewerRole) or
 * pass it explicitly on link-admission routes that serve strangers.
 * 'workspace' is an active member of the meeting's workspace viewing a
 * non-confidential meeting they did not attend: read access, no call-in.
 */
export type MeetingViewerRole = "host" | "participant" | "workspace" | "guest" | "untrusted";

// Call-in details (dial-in number + PIN) join the meeting directly over SIP
// with no waiting room, so the PIN is an admission credential. Only
// full-account hosts/participants may receive it; admitted guests and
// untrusted viewers never do.
const CALL_IN_VIEWER_ROLES: ReadonlySet<MeetingViewerRole> = new Set(["host", "participant"]);
const DEFAULT_MEETING_INSTANCE_NUMBER = 1;

function viewerMayReceiveCallIn(viewerRole: MeetingViewerRole): boolean {
  return CALL_IN_VIEWER_ROLES.has(viewerRole);
}

export type MeetingDTOInput = {
  id: string;
  workspaceId: string;
  title: string;
  roomName: string;
  meetingLinkId?: string | null;
  instanceNumber?: number;
  meetingLink?: MeetingLinkDTOInput | null;
  createdByUserId: string;
  kind?: "standard" | "agent_intro";
  status: "scheduled" | "active" | "ended";
  /** @external meeting confidentiality wire field */
  isConfidential?: boolean;
  confidentialitySource?: "auto" | "manual" | null;
  /** @external meeting confidentiality requirement wire field */
  confidentialityIsRequired?: boolean;
  /** @external viewer confidentiality edit permission wire field */
  viewerCanChangeConfidentiality?: boolean;
  viewerRole?: MeetingViewerRole;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  notePreview?: string | null;
  participantNames?: string[];
  participants?: {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
  }[];
};

export type MeetingLinkDTOInput = {
  id: string;
  workspaceId: string;
  code: string;
  createdByUserId: string;
  title: string;
  status: string;
  callIn?: MeetingLinkCallInDTOInput | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MeetingLinkCallInDTOInput = {
  phoneNumber: string;
  pin: string;
  status: string;
};

export function toMeetingLinkDTO(meetingLink: MeetingLinkDTOInput): {
  id: string;
  workspaceId: string;
  code: string;
  createdByUserId: string;
  title: string;
  status: "active" | "disabled";
  callIn: { phoneNumber: string; pin: string } | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: meetingLink.id,
    workspaceId: meetingLink.workspaceId,
    code: meetingLink.code,
    createdByUserId: meetingLink.createdByUserId,
    title: meetingLink.title,
    status: meetingLink.status === "active" ? "active" : "disabled",
    callIn:
      meetingLink.callIn?.status === "active"
        ? {
            phoneNumber: meetingLink.callIn.phoneNumber,
            pin: meetingLink.callIn.pin,
          }
        : null,
    createdAt: meetingLink.createdAt.toISOString(),
    updatedAt: meetingLink.updatedAt.toISOString(),
  };
}

export function toMeetingDTO(meeting: MeetingDTOInput): ReturnType<typeof buildMeetingDtoRecord> {
  return buildMeetingDtoRecord(meeting);
}

function buildMeetingDtoRecord(meeting: MeetingDTOInput) {
  return {
    id: meeting.id,
    workspaceId: meeting.workspaceId,
    title: meeting.title,
    roomName: meeting.roomName,
    meetingLinkId: meeting.meetingLinkId ?? null,
    instanceNumber: meeting.instanceNumber ?? DEFAULT_MEETING_INSTANCE_NUMBER,
    meetingLink: meeting.meetingLink ? toMeetingLinkDTO(meeting.meetingLink) : null,
    createdByUserId: meeting.createdByUserId,
    kind: meeting.kind ?? "standard",
    status: meeting.status,
    /** @external meeting confidentiality wire field */
    isConfidential: meeting.isConfidential ?? false,
    confidentialitySource: meeting.confidentialitySource ?? null,
    /** @external meeting confidentiality requirement wire field */
    confidentialityIsRequired: meeting.confidentialityIsRequired ?? false,
    /** @external viewer confidentiality edit permission wire field */
    viewerCanChangeConfidentiality: meeting.viewerCanChangeConfidentiality ?? false,
    viewerRole: meeting.viewerRole,
    createdAt: meeting.createdAt.toISOString(),
    startedAt: meeting.startedAt !== null ? meeting.startedAt.toISOString() : null,
    endedAt: meeting.endedAt !== null ? meeting.endedAt.toISOString() : null,
    notePreview: meeting.notePreview ?? null,
    participantNames: meeting.participantNames ?? [],
    participants: meeting.participants ?? [],
  };
}

// Calendar event writes get a larger bounded opportunity to embed phone details.
export const CALENDAR_EVENT_CALL_IN_WAIT_MS = 5_000;

export function syncMeetingCallInInBackground(input: Parameters<typeof ensureMeetingCallInForMeetingSafely>[0]): void {
  void ensureMeetingCallInForMeetingSafely(input);
}

/**
 * Awaits call-in provisioning and returns the synced call-in, for one-shot
 * callers (e.g. the Calendar add-on) that must embed the dial-in immediately
 * rather than re-fetching the meeting later.
 */
async function ensureSyncedCallInForMeeting(
  input: Parameters<typeof ensureMeetingCallInForMeetingSafely>[0],
): Promise<Awaited<ReturnType<typeof getSyncedCallInForMeeting>>> {
  await ensureMeetingCallInForMeetingSafely(input);

  return getSyncedCallInForMeeting({
    meeting: input.meeting,
    meetingLink: input.meetingLink ?? null,
  });
}

/**
 * Gives synchronous clients a small opportunity to receive dial-in details
 * without making conference creation wait indefinitely on the SIP provider.
 * Provisioning continues after the timeout and later meeting-link resolutions
 * can pick up the completed call-in record.
 */
const DEFAULT_SYNCED_CALL_IN_WAIT_MS = 1_500;

export async function waitForSyncedCallInForMeeting({
  input,
  timeoutMs = DEFAULT_SYNCED_CALL_IN_WAIT_MS,
}: {
  input: Parameters<typeof ensureMeetingCallInForMeetingSafely>[0];
  timeoutMs?: number;
}): Promise<Awaited<ReturnType<typeof getSyncedCallInForMeeting>>> {
  const timeoutState: { handle: ReturnType<typeof setTimeout> | undefined } = { handle: undefined };
  const provision = ensureSyncedCallInForMeeting(input);
  const deadline = new Promise<null>((resolve) => {
    timeoutState.handle = setTimeout(() => resolve(null), timeoutMs);
    timeoutState.handle.unref();
  });

  try {
    return await Promise.race([provision, deadline]);
  } finally {
    if (timeoutState.handle !== undefined) {
      clearTimeout(timeoutState.handle);
    }
  }
}

export async function getSyncedCallInForMeeting({
  meeting,
  meetingLink,
}: {
  meeting: Pick<MeetingDTOInput, "id">;
  meetingLink: Pick<MeetingLinkDTOInput, "id"> | null;
}): Promise<MeetingLinkCallInDTOInput | null> {
  const callIn = meetingLink !== null ? await repositories().getMeetingLinkCallIn(meetingLink.id) : null;

  return callIn?.lastSyncedMeetingId === meeting.id ? callIn : null;
}

/**
 * Serializes a meeting (resolving its link if not preattached) scoped to the
 * viewer: callIn is fetched only for viewers allowed to receive it and
 * stripped from any preattached link otherwise.
 */
export async function toMeetingDTOForViewer({
  input,
  viewerRole,
}: {
  input: MeetingDTOInput;
  viewerRole: MeetingViewerRole;
}): Promise<ReturnType<typeof toMeetingDTO>> {
  // The serialized meeting carries the viewer's role so read-only 'workspace'
  // viewers can skip run-triggering calls client-side. Callers that computed
  // a more precise role per meeting may pre-set it on the input.
  const meeting: MeetingDTOInput = { viewerRole, ...input };
  const isCallInIncluded = viewerMayReceiveCallIn(viewerRole);

  if (meeting.meetingLink) {
    return toMeetingDTO(
      isCallInIncluded
        ? meeting
        : {
            ...meeting,
            meetingLink: { ...meeting.meetingLink, callIn: null },
          },
    );
  }

  const meetingLinkId = meeting.meetingLinkId ?? "";
  if (meetingLinkId.length === 0) {
    return toMeetingDTO(meeting);
  }

  const meetingLink = await repositories().getMeetingLinkForMeeting(meeting.id);
  const callIn = isCallInIncluded ? await getSyncedCallInForMeeting({ meeting, meetingLink }) : null;

  return toMeetingDTO({
    ...meeting,
    meetingLink: meetingLink
      ? {
          ...meetingLink,
          callIn,
        }
      : null,
  });
}
