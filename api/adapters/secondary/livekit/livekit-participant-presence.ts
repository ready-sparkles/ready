import { z } from "zod";

import { getSipCallId } from "../../../domain/call-in-holding-room";
import { repositories } from "../../../ports/repository-runtime";

import { listLiveKitParticipants } from "./livekit";
import { resolveLiveKitGuestUserId } from "./livekit-guest-participant";
import { ParticipantInfo_State as ParticipantInfoState } from "./sdk";

const liveKitUserIdentityPrefixSchema = z.string().uuid();

function parseUserIdFromLiveKitIdentity(identity: string | null | undefined): string | null {
  if (identity === null || identity === undefined || identity === "") {
    return null;
  }

  const [candidate] = identity.split(":", 1);
  const parsed = liveKitUserIdentityPrefixSchema.safeParse(candidate);

  return parsed.success ? parsed.data : null;
}

type WebhookParticipant =
  | {
      identity?: string;
      attributes?: Record<string, string>;
    }
  | undefined;

// Signed-in participants encode their user id; guests and call-in participants
// are matched through their meeting-scoped join request instead.
export async function resolveMeetingParticipantUserId(input: {
  meetingId: string;
  participant: WebhookParticipant;
  isLeaving?: boolean;
}): Promise<string | null> {
  const isLeaving = input.isLeaving === true;
  if (input.participant?.identity?.startsWith("guest:") === true) {
    return resolveLiveKitGuestUserId({ meetingId: input.meetingId, identity: input.participant.identity, isLeaving });
  }

  const userId = parseUserIdFromLiveKitIdentity(input.participant?.identity);
  if (userId !== null) {
    return userId;
  }

  const sipCallId = getSipCallId(input.participant?.attributes);
  if (sipCallId === null || sipCallId === "") {
    return null;
  }

  const joinRequest = await repositories().getCallInMeetingJoinRequestBySipCallId(sipCallId);
  if (!joinRequest || joinRequest.meetingId !== input.meetingId || joinRequest.status !== "admitted") {
    return null;
  }

  return joinRequest.userId;
}

const presenceDependencies = {
  listParticipants: listLiveKitParticipants,
  resolveUserId: resolveMeetingParticipantUserId,
  get markLeft() {
    return repositories().markParticipantLeft;
  },
};
type PresenceDependencies = typeof presenceDependencies;

// LiveKit owns connection-level presence. Read its current roster rather than
// treating a single departure event as proof that every device has left.
export async function listConnectedMeetingUserIds(input: {
  meetingId: string;
  roomName: string;
  dependencies?: Pick<PresenceDependencies, "listParticipants" | "resolveUserId">;
}): Promise<Set<string>> {
  const dependencies = input.dependencies ?? presenceDependencies;
  const participants = await dependencies.listParticipants(input.roomName);
  const userIds = await Promise.all(
    participants
      .filter((participant) => participant.state !== ParticipantInfoState.DISCONNECTED)
      .map((participant) =>
        dependencies.resolveUserId({
          meetingId: input.meetingId,
          participant,
          isLeaving: true,
        }),
      ),
  );

  return new Set(userIds.filter((userId): userId is string => userId !== null));
}

export async function markParticipantLeftIfDisconnected(input: {
  meetingId: string;
  roomName: string;
  userId: string;
  dependencies?: PresenceDependencies;
}): Promise<boolean> {
  const dependencies = input.dependencies ?? presenceDependencies;
  const connectedUserIds = await listConnectedMeetingUserIds({
    meetingId: input.meetingId,
    roomName: input.roomName,
    dependencies,
  });
  if (connectedUserIds.has(input.userId)) {
    return false;
  }
  await dependencies.markLeft({ meetingId: input.meetingId, userId: input.userId });

  return true;
}
