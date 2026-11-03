import type { Meeting, MeetingJoinRequest } from "@readymeet/shared";

export function hasWaitingMeetingEnded(input: {
  request: Pick<MeetingJoinRequest, "meetingId" | "status">;
  meeting: Pick<Meeting, "id" | "status"> | null;
}): boolean {
  const { request, meeting } = input;
  const hasMatchingEndedMeeting =
    request.meetingId !== null &&
    request.meetingId !== "" &&
    meeting !== null &&
    meeting.id === request.meetingId &&
    meeting.status === "ended";

  return request.status === "expired" || hasMatchingEndedMeeting;
}
