import type { MeetingLinkCodeStore } from "@readymeet/db/ports/meeting-link-code-store";

const roomCodeAlphabet = "abcdefghjkmnpqrstvwxyz";
const ROOM_CODE_SHORT_SEGMENT_LENGTH = 3;
const ROOM_CODE_LONG_SEGMENT_LENGTH = 4;
const UNIQUE_CODE_ATTEMPTS = 8;
const UNABLE_TO_GENERATE_ROOM_CODE_MESSAGE = "Unable to generate unique room code";

function randomCodeSegment(length: number): string {
  return Array.from({ length }, () => roomCodeAlphabet[Math.floor(Math.random() * roomCodeAlphabet.length)]).join("");
}

function generateRoomCode(): string {
  return `${randomCodeSegment(ROOM_CODE_SHORT_SEGMENT_LENGTH)}-${randomCodeSegment(ROOM_CODE_LONG_SEGMENT_LENGTH)}-${randomCodeSegment(ROOM_CODE_SHORT_SEGMENT_LENGTH)}`;
}

export function normalizeMeetingLinkCode(code: string): string {
  return code.trim().toLowerCase();
}

export async function generateUniqueMeetingLinkCode(params: { store: MeetingLinkCodeStore }): Promise<string> {
  const { store } = params;
  const attemptIndexes = Array.from({ length: UNIQUE_CODE_ATTEMPTS }, (_, index) => index);

  const resolvedCode = await attemptIndexes.reduce<Promise<string | undefined>>(async (previousAttempt) => {
    const previousCode = await previousAttempt;
    if (previousCode !== undefined) {
      return previousCode;
    }
    const code = generateRoomCode();
    const [existingMeetingLink, existingMeeting] = await Promise.all([
      store.getMeetingLinkByCode(code),
      store.getMeetingByRoomName(code),
    ]);
    if (existingMeetingLink !== null || existingMeeting !== null) {
      return undefined;
    }

    return code;
  }, Promise.resolve(undefined));

  if (resolvedCode === undefined) {
    throw new Error(UNABLE_TO_GENERATE_ROOM_CODE_MESSAGE);
  }

  return resolvedCode;
}
