// Pure helpers for the phone call-in waiting room: holding room naming and
// SIP participant attribute parsing. Kept free of env/db imports for testing.

const CALL_IN_HOLDING_ROOM_PREFIX = "call-hold-";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_LENGTH = 36;

const SIP_CALL_ID_ATTRIBUTE = "sip.callID";
const SIP_PHONE_NUMBER_ATTRIBUTE = "sip.phoneNumber";

export const CALL_IN_MEETING_LINK_ATTRIBUTE = "ready.meetingLinkId";

export function callInHoldingRoomPrefix(meetingLinkId: string): string {
  return `${CALL_IN_HOLDING_ROOM_PREFIX}${meetingLinkId}-`;
}

export function isCallInHoldingRoomName(roomName: string): boolean {
  return roomName.startsWith(CALL_IN_HOLDING_ROOM_PREFIX);
}

export function parseMeetingLinkIdFromHoldingRoomName(roomName: string): string | null {
  if (!isCallInHoldingRoomName(roomName)) {
    return null;
  }

  const candidate = roomName.slice(
    CALL_IN_HOLDING_ROOM_PREFIX.length,
    CALL_IN_HOLDING_ROOM_PREFIX.length + UUID_LENGTH,
  );

  return UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

export function getSipCallId(attributes: Record<string, string> | undefined): string | null {
  const sipCallId = attributes?.[SIP_CALL_ID_ATTRIBUTE]?.trim();
  if (sipCallId === undefined || sipCallId.length === 0) {
    return null;
  }

  return sipCallId;
}

const SIP_PHONE_DISPLAY_DIGIT_COUNT = 4;

export function callerDisplayNameFromSipAttributes(attributes: Record<string, string> | undefined): string {
  const digits = (attributes?.[SIP_PHONE_NUMBER_ATTRIBUTE] ?? "").replace(/\D/g, "");

  return digits.length >= SIP_PHONE_DISPLAY_DIGIT_COUNT
    ? `Caller ...${digits.slice(-SIP_PHONE_DISPLAY_DIGIT_COUNT)}`
    : "Phone caller";
}

// SIP participants never pass through our token minting, so admission must
// stamp the caller's guest identity onto the LiveKit participant. The userId
// attribute is the contract the backend transcriber and the web's speaker
// labels use to recognize a human participant.
export function callInCallerParticipantInfo(input: { userId: string; displayName: string }): {
  name: string;
  attributes: { userId: string };
} {
  return {
    name: input.displayName,
    attributes: { userId: input.userId },
  };
}
