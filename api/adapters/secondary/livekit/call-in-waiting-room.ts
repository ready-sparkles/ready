import {
  CALL_IN_MEETING_LINK_ATTRIBUTE,
  callerDisplayNameFromSipAttributes,
  getSipCallId,
  parseMeetingLinkIdFromHoldingRoomName,
} from "../../../domain/call-in-holding-room";
import { apiEnv } from "../../../ports/api-env";
import { repositories } from "../../../ports/repository-runtime";

import { removeLiveKitParticipant, startRoomAudioPlayback, stopRoomAudioPlayback } from "./livekit";
import type { WebhookEvent } from "./sdk";

type LoggerLike = {
  warn(...args: [bindings: Record<string, unknown>, message: string]): void;
};

export const MAX_WAITING_JOIN_REQUESTS_PER_LINK = 25;

const HOLD_AUDIO_PARTICIPANT_IDENTITY = "ready-hold-audio";

function getHoldAudioUrl() {
  const url = apiEnv().LIVEKIT_CALL_IN_HOLD_AUDIO_URL.trim();

  return url !== "" ? url : null;
}

async function disconnectHoldingRoomCaller(input: {
  roomName: string;
  participantIdentity: string;
  logger: LoggerLike;
}) {
  try {
    await removeLiveKitParticipant(input.roomName, input.participantIdentity);
  } catch (error) {
    input.logger.warn(
      { error, roomName: input.roomName, participantIdentity: input.participantIdentity },
      "Failed to disconnect call-in participant from holding room",
    );
  }
}

async function announceWaitingMessage(input: { roomName: string; logger: LoggerLike }) {
  const audioUrl = getHoldAudioUrl();
  if (audioUrl === null) {
    return;
  }

  try {
    await startRoomAudioPlayback({
      roomName: input.roomName,
      audioUrl,
      participantIdentity: HOLD_AUDIO_PARTICIPANT_IDENTITY,
      participantName: "Ready",
    });
  } catch (error) {
    input.logger.warn({ error, roomName: input.roomName }, "Failed to play call-in waiting announcement");
  }
}

export async function stopWaitingMessageSafely(...args: [roomName: string, logger: LoggerLike]): Promise<void> {
  const [roomName, logger] = args;
  if (getHoldAudioUrl() === null) {
    return;
  }

  try {
    await stopRoomAudioPlayback(roomName);
  } catch (error) {
    logger.warn({ error, roomName }, "Failed to stop call-in waiting announcement");
  }
}

async function handleHoldingRoomParticipantJoined(input: {
  roomName: string;
  participantIdentity: string;
  attributes: Record<string, string>;
  logger: LoggerLike;
}) {
  const sipCallId = getSipCallId(input.attributes);
  if (sipCallId === null) {
    // Not a SIP caller (e.g. the hold-audio ingress participant).
    return;
  }

  const trimmedMeetingLinkAttribute = input.attributes[CALL_IN_MEETING_LINK_ATTRIBUTE]?.trim();
  const meetingLinkId =
    trimmedMeetingLinkAttribute !== undefined && trimmedMeetingLinkAttribute !== ""
      ? trimmedMeetingLinkAttribute
      : parseMeetingLinkIdFromHoldingRoomName(input.roomName);
  if (meetingLinkId === null || meetingLinkId === "") {
    input.logger.warn(
      { roomName: input.roomName, sipCallId },
      "Could not resolve meeting link for call-in holding room participant",
    );
    await disconnectHoldingRoomCaller({
      roomName: input.roomName,
      participantIdentity: input.participantIdentity,
      logger: input.logger,
    });

    return;
  }

  const meeting = await repositories().getCurrentMeetingForLink(meetingLinkId);
  if (!meeting || meeting.status === "ended") {
    await disconnectHoldingRoomCaller({
      roomName: input.roomName,
      participantIdentity: input.participantIdentity,
      logger: input.logger,
    });

    return;
  }

  const existing = await repositories().getCallInMeetingJoinRequestBySipCallId(sipCallId);
  if (existing) {
    return;
  }

  // Every call mints a fresh guest identity, so apply the same waiting-list
  // cap as anonymous web join requests.
  if ((await repositories().countWaitingJoinRequestsForLink(meetingLinkId)) >= MAX_WAITING_JOIN_REQUESTS_PER_LINK) {
    await disconnectHoldingRoomCaller({
      roomName: input.roomName,
      participantIdentity: input.participantIdentity,
      logger: input.logger,
    });

    return;
  }

  const displayName = callerDisplayNameFromSipAttributes(input.attributes);
  const guestUser = await repositories().createGuestUser({ displayName });
  const { request, created: isCreated } = await repositories().createCallInMeetingJoinRequest({
    meetingLinkId,
    meetingId: meeting.id,
    userId: guestUser.id,
    displayName,
    sipCallId,
    sipParticipantIdentity: input.participantIdentity,
    sipHoldingRoom: input.roomName,
  });
  if (!isCreated) {
    return;
  }

  await repositories().publishMeetingJoinRequestRealtime({
    request,
    eventName: "join-request.created",
  });
  await announceWaitingMessage({ roomName: input.roomName, logger: input.logger });
}

async function handleHoldingRoomParticipantLeft(input: {
  roomName: string;
  attributes: Record<string, string>;
  logger: LoggerLike;
}) {
  const sipCallId = getSipCallId(input.attributes);
  if (sipCallId === null) {
    return;
  }

  const expired = await repositories().expireCallInMeetingJoinRequest({ sipCallId });
  if (!expired) {
    return;
  }

  await repositories().publishMeetingJoinRequestRealtime({
    request: expired,
    eventName: "join-request.updated",
  });
  await stopWaitingMessageSafely(input.roomName, input.logger);
}

export async function handleCallInHoldingRoomEvent(...args: [event: WebhookEvent, logger: LoggerLike]): Promise<void> {
  const [event, logger] = args;
  const roomName = event.room?.name;
  const participant = event.participant;
  const participantIdentity = participant?.identity;
  if (
    roomName === undefined ||
    roomName === "" ||
    participant === undefined ||
    participantIdentity === undefined ||
    participantIdentity === ""
  ) {
    return;
  }

  const attributes = participant.attributes;

  if (event.event === "participant_joined") {
    await handleHoldingRoomParticipantJoined({
      roomName,
      participantIdentity,
      attributes,
      logger,
    });
  }

  if (event.event === "participant_left" || event.event === "participant_connection_aborted") {
    await handleHoldingRoomParticipantLeft({ roomName, attributes, logger });
  }
}
