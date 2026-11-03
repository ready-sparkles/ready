import { livekitTokenRequestSchema, livekitTokenResponseSchema } from "@readymeet/shared";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { apiEnv } from "../../../../composition/env";
import { repositories } from "../../../../ports/repository-runtime";
import { createLiveKitToken } from "../../../secondary/livekit/livekit";
import { TrackSource } from "../../../secondary/livekit/sdk";
import { getMeetingAccess, requireMeetingAccess } from "../support/meeting-access";

const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_CONFLICT_STATUS = 409;

const LIVEKIT_ROUTE_MESSAGES = {
  authenticationRequired: "Authentication required.",
  meetingEnded: "This meeting has ended and can no longer be joined.",
} as const;

export async function livekitRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/livekit/token",
    {
      preHandler: requireMeetingAccess("admitted-guest", { meetingIdFrom: "body" }),
    },
    async (request, reply) => {
      const { meeting, viewerRole } = getMeetingAccess(request);
      const user = request.user;
      if (user === undefined) {
        return reply.code(HTTP_BAD_REQUEST_STATUS).send({ message: LIVEKIT_ROUTE_MESSAGES.authenticationRequired });
      }

      const parsed = livekitTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST_STATUS).send({ message: parsed.error.message });
      }

      if (meeting.status === "ended") {
        return reply.code(HTTP_CONFLICT_STATUS).send({ message: LIVEKIT_ROUTE_MESSAGES.meetingEnded });
      }

      const isGuestSession = viewerRole === "guest";
      if (!isGuestSession) {
        await repositories().recordMeetingAttendeeWorkspace({
          meetingId: meeting.id,
          userId: user.id,
          workspaceId: user.workspaceId,
        });
      }
      const joinRequestId = user.joinRequestId;
      const hasJoinRequestId = typeof joinRequestId === "string" && joinRequestId.length > 0;
      const token = await createLiveKitToken({
        roomName: meeting.roomName,
        participantName: parsed.data.participantName,
        participantIdentity:
          isGuestSession && hasJoinRequestId ? `guest:${joinRequestId}` : `${user.id}:${randomUUID()}`,
        participantUserId: user.id,
        participantAvatarUrl: user.avatarUrl,
        participantMetadata:
          isGuestSession && hasJoinRequestId
            ? {
                kind: "guest",
                meetingId: meeting.id,
                joinRequestId,
              }
            : {
                kind: "authenticated",
                meetingId: meeting.id,
              },
        canPublishSources: isGuestSession
          ? [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
          : undefined,
        canPublishData: true,
      });

      return livekitTokenResponseSchema.parse({
        token,
        wsUrl: apiEnv.LIVEKIT_URL,
        roomName: meeting.roomName,
      });
    },
  );
}
