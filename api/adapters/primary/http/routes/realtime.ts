import {
  joinRequestRealtimeChannels,
  meetingAmbientContextRealtimeChannel,
  meetingJoinRequestsRealtimeChannels,
  meetingTrackerChannel,
} from "@readymeet/shared";
import type { FastifyInstance } from "fastify";

import { apiEnv } from "../../../../composition/env";
import Ably from "../../../../composition/platform/ably";
import { repositories } from "../../../../ports/repository-runtime";
import { requireMeetingScopedAuth } from "../plugins/auth";

const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_SERVICE_UNAVAILABLE_STATUS = 503;
const REALTIME_UNAUTHORIZED_MESSAGE = "Unauthorized";
const REALTIME_NOT_CONFIGURED_MESSAGE = "Realtime is not configured.";
const ABLY_SUBSCRIBE_CAPABILITY = ["subscribe"] as const;

const ablyRestState: { client: Ably.Rest | null } = { client: null };

function getAblyRest(): Ably.Rest | null {
  if (apiEnv.ABLY_API_KEY === "") {
    return null;
  }

  ablyRestState.client ??= new Ably.Rest({ key: apiEnv.ABLY_API_KEY });

  return ablyRestState.client;
}

function withSubscribeCapability(input: {
  capability: Record<string, string[]>;
  channel: string;
}): Record<string, string[]> {
  return { ...input.capability, [input.channel]: [...ABLY_SUBSCRIBE_CAPABILITY] };
}

async function buildGuestCapability(input: {
  capability: Record<string, string[]>;
  user: {
    workspaceId: string;
    joinRequestId?: string | null;
    meetingId?: string | null;
    id: string;
  };
}): Promise<Record<string, string[]>> {
  const joinRequestChannels =
    input.user.joinRequestId !== null && input.user.joinRequestId !== undefined && input.user.joinRequestId !== ""
      ? joinRequestRealtimeChannels({
          workspaceId: input.user.workspaceId,
          requestId: input.user.joinRequestId,
        })
      : [];
  const capabilityWithJoinRequests = joinRequestChannels.reduce(
    (capability, channel) => withSubscribeCapability({ capability, channel }),
    input.capability,
  );
  const meetingId = input.user.meetingId;
  if (
    meetingId === null ||
    meetingId === undefined ||
    meetingId === "" ||
    !(await repositories().hasJoinedAdmittedMeeting({
      meetingId,
      userId: input.user.id,
      joinRequestId: input.user.joinRequestId,
    }))
  ) {
    return capabilityWithJoinRequests;
  }

  const capabilityWithTracker = withSubscribeCapability({
    capability: capabilityWithJoinRequests,
    channel: meetingTrackerChannel({ workspaceId: input.user.workspaceId, meetingId }),
  });
  const capabilityWithAmbient = withSubscribeCapability({
    capability: capabilityWithTracker,
    channel: meetingAmbientContextRealtimeChannel({
      workspaceId: input.user.workspaceId,
      meetingId,
    }),
  });

  return withSubscribeCapability({
    capability: capabilityWithAmbient,
    channel: repositories().meetingTasksRealtimeChannel({
      workspaceId: input.user.workspaceId,
      meetingId,
    }),
  });
}

async function buildAuthenticatedCapability(input: {
  capability: Record<string, string[]>;
  userId: string;
}): Promise<Record<string, string[]>> {
  const [participantMeetings, workspaceIds, hostMeetings, activeJoinRequests] = await Promise.all([
    repositories().listParticipantMeetingChannelsForUser(input.userId),
    repositories().listWorkspaceIdsForUser(input.userId),
    repositories().listHostJoinRequestChannelsForUser(input.userId),
    repositories().listActiveJoinRequestChannelsForUser(input.userId),
  ]);
  const workspaceCapability = workspaceIds.reduce((capability, workspaceId) => {
    const withWorkspaceTasks = withSubscribeCapability({
      capability,
      channel: repositories().workspaceTasksRealtimeChannel({ workspaceId }),
    });
    const withUserTasks = withSubscribeCapability({
      capability: withWorkspaceTasks,
      channel: repositories().userTasksRealtimeChannel({ workspaceId, userId: input.userId }),
    });

    return withSubscribeCapability({
      capability: withUserTasks,
      channel: repositories().userCalendarRealtimeChannel({ workspaceId, userId: input.userId }),
    });
  }, input.capability);
  const participantCapability = participantMeetings.reduce((capability, meeting) => {
    const withTasks = withSubscribeCapability({
      capability,
      channel: repositories().meetingTasksRealtimeChannel({
        workspaceId: meeting.workspaceId,
        meetingId: meeting.meetingId,
      }),
    });

    const withTracker = withSubscribeCapability({
      capability: withTasks,
      channel: meetingTrackerChannel({ workspaceId: meeting.workspaceId, meetingId: meeting.meetingId }),
    });

    return withSubscribeCapability({
      capability: withTracker,
      channel: meetingAmbientContextRealtimeChannel({
        workspaceId: meeting.workspaceId,
        meetingId: meeting.meetingId,
      }),
    });
  }, workspaceCapability);
  const hostCapability = hostMeetings.reduce((capability, meeting) => {
    return meetingJoinRequestsRealtimeChannels(meeting).reduce(
      (nextCapability, channel) => withSubscribeCapability({ capability: nextCapability, channel }),
      capability,
    );
  }, participantCapability);

  return activeJoinRequests.reduce((capability, joinRequest) => {
    return joinRequestRealtimeChannels(joinRequest).reduce(
      (nextCapability, channel) => withSubscribeCapability({ capability: nextCapability, channel }),
      capability,
    );
  }, hostCapability);
}

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/realtime/ably-token", { preHandler: requireMeetingScopedAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED_STATUS).send({ message: REALTIME_UNAUTHORIZED_MESSAGE });
    }

    const rest = getAblyRest();
    if (rest === null) {
      return reply.code(HTTP_SERVICE_UNAVAILABLE_STATUS).send({ message: REALTIME_NOT_CONFIGURED_MESSAGE });
    }

    const capability =
      user.tokenKind === "guest"
        ? await buildGuestCapability({ capability: {}, user })
        : await buildAuthenticatedCapability({ capability: {}, userId: user.id });

    const tokenRequest = await rest.auth.createTokenRequest({
      clientId: user.id,
      ttl: apiEnv.ABLY_CLIENT_TTL_MS,
      capability: JSON.stringify(capability),
    });

    return tokenRequest;
  });
}
