import type { FastifyReply, FastifyRequest } from "fastify";

import { resolveMeetingNotesAccess } from "../../../../application/meeting-notes-access";

import { getMeetingAccess, type MeetingAccessLevel, requireMeetingAccess } from "./meeting-access";

const FORBIDDEN_HTTP_STATUS = 403;
const MEETING_NOTES_LOCKED_CODE = "meeting_notes_locked";
const MEETING_NOTES_LOCKED_MESSAGE = "Meeting notes are locked.";
const AUTHENTICATED_USER_REQUIRED_MESSAGE = "Expected authenticated user.";

/** Run after the route's meeting access guard; previews remain explicitly separate. */
export async function requireUnlockedMeetingNotes(input: {
  request: FastifyRequest;
  reply: FastifyReply;
}): Promise<void> {
  const { meeting, viewerRole } = getMeetingAccess(input.request);
  // Joined guests intentionally retain their read-only reveal. Mutations still
  // require full participant auth in the preceding route guard.
  if (viewerRole === "guest" && input.request.method === "GET") {
    return;
  }
  const userId = input.request.user?.id;
  if (typeof userId !== "string") {
    throw new Error(AUTHENTICATED_USER_REQUIRED_MESSAGE);
  }
  const notesAccess = await resolveMeetingNotesAccess({ meeting, viewerRole, userId });
  if (notesAccess.locked) {
    return input.reply.code(FORBIDDEN_HTTP_STATUS).send({
      code: MEETING_NOTES_LOCKED_CODE,
      message: MEETING_NOTES_LOCKED_MESSAGE,
      notesAccess,
    });
  }
}

/** Declare participant access and the notes policy together. */
export function requireMeetingNotesAccess(input: {
  level: MeetingAccessLevel;
  options?: {
    meetingIdFrom?: "params" | "body";
    forbiddenMessage?: string;
    /** @external meeting access preHandler option */
    allowWorkspaceViewer?: boolean;
  };
}): ReturnType<typeof requireMeetingAccess> {
  const { level, options = {} } = input;

  return [...requireMeetingAccess(level, options), (request, reply) => requireUnlockedMeetingNotes({ request, reply })];
}
