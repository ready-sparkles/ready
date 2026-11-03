import type { Meeting } from "@readymeet/shared";

export function getMeetingPublicCode(meeting: Pick<Meeting, "roomName" | "meetingLink">): string {
  return meeting.meetingLink?.code ?? meeting.roomName;
}

export function getMeetingPublicPath(meeting: Pick<Meeting, "roomName" | "meetingLink">): string {
  return `/${getMeetingPublicCode(meeting)}`;
}

/** Where a meeting's notes live: the workspace notes page, or the guest notes page for guests. */
export function getMeetingNotesPath(input: { meetingId: string; isGuestSession: boolean }): string {
  return input.isGuestSession ? `/guest/meetings/${input.meetingId}/notes` : `/workspace/${input.meetingId}`;
}

/**
 * Whether an ended meeting still has a notes page. "unknown" until the live
 * meeting response arrives; "hidden_too_short" when the API hid it from
 * history as too short (it has no notes, and the app sends users to the
 * meetings list instead).
 */
export type EndedMeetingHistoryVisibility = "unknown" | "listed" | "hidden_too_short";

export function getEndedMeetingHistoryVisibility(input: {
  postMeetingDisposition: { status: "skipped" } | null | undefined;
}): EndedMeetingHistoryVisibility {
  return input.postMeetingDisposition?.status === "skipped" ? "hidden_too_short" : "listed";
}

/** The notes link to offer on the live page, only once the meeting has ended and still has notes. */
export function getEndedMeetingNotesPath(input: {
  meeting: Pick<Meeting, "id" | "status"> | null;
  isGuestSession: boolean;
  historyVisibility: EndedMeetingHistoryVisibility;
}): string | null {
  if (input.meeting?.status !== "ended" || input.historyVisibility !== "listed") {
    return null;
  }

  return getMeetingNotesPath({ meetingId: input.meeting.id, isGuestSession: input.isGuestSession });
}
