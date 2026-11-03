import { GuestRecognitionConsentRequired } from "@readymeet/db/domain/persistence-errors";
import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  createMeetingJoinRequestSchema,
  GUEST_RECOGNITION_EXPIRES_HEADER,
  GUEST_RECOGNITION_HEADER,
  GUEST_RECOGNITION_NOTICE_VERSION,
  meetingJoinRequestDecisionResponseSchema,
  meetingJoinRequestListResponseSchema,
  meetingJoinRequestResponseSchema,
  meetingJoinRequestStatusResponseSchema,
  meetingLinkPrejoinResponseSchema,
  meetingLinkResolveResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import {
  getSyncedCallInForMeeting,
  syncMeetingCallInInBackground,
  toMeetingDTO,
  toMeetingDTOForViewer,
  toMeetingLinkDTO,
} from "../../../../../application/meeting-dto";
import { ensureMeetingAssistantCoverage } from "../../../../../application/meeting-lifecycle";
import { apiEnv } from "../../../../../composition/env";
import { normalizeMeetingLinkCode } from "../../../../../composition/meeting-link-codes";
import { callInCallerParticipantInfo } from "../../../../../domain/call-in-holding-room";
import { repositories } from "../../../../../ports/repository-runtime";
import {
  MAX_WAITING_JOIN_REQUESTS_PER_LINK,
  stopWaitingMessageSafely,
} from "../../../../secondary/livekit/call-in-waiting-room";
import {
  moveLiveKitParticipant,
  removeLiveKitParticipant,
  updateLiveKitParticipantInfo,
} from "../../../../secondary/livekit/livekit";
import { authenticateOptionalFullAuth, requireAuth, requireMeetingScopedAuth } from "../../plugins/auth";
import { readBearerToken, signAuthToken } from "../../support/auth";
import { guestRecognitionRateKey } from "../../support/guest-recognition-proxy";
import {
  getMeetingAccess,
  getMeetingHostingAccessForUser,
  isAuthorizedMeetingHost,
  isTrustedMeetingUser,
  type MeetingRecord,
  requireMeetingAccess,
} from "../../support/meeting-access";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const GUEST_SESSION_TTL_HOURS = 24;
const GUEST_SESSION_TTL_MS =
  GUEST_SESSION_TTL_HOURS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const GUEST_RECOGNITION_GET_RATE_LIMIT_MAX = 60;
const GUEST_RECOGNITION_DELETE_RATE_LIMIT_MAX = 30;
const MEETING_LINK_PREJOIN_RATE_LIMIT_MAX = 60;
const MEETING_LINK_JOIN_REQUEST_RATE_LIMIT_MAX = 10;
const MEETING_JOIN_REQUEST_STATUS_RATE_LIMIT_MAX = 120;
const ALREADY_TRUSTED_CODE = "already_trusted";
const MEETING_HOST_PLAN_REQUIRED_CODE = "meeting_host_plan_required";
const JOIN_REQUEST_REQUIRED_CODE = "join_request_required";
const MESSAGE_MEETING_LINK_NOT_FOUND = "Meeting link not found";
const MESSAGE_BROWSER_RECOGNITION_UNAVAILABLE =
  "Browser recognition is unavailable or its notice has changed. Refresh and try again.";
const MESSAGE_MEETING_LINK_NOT_OPEN = "This meeting link is not open yet.";
const MESSAGE_ALREADY_TRUSTED = "You can already join this meeting.";
const MESSAGE_NAME_REQUIRED_TO_JOIN = "Name is required to ask to join.";
const MESSAGE_TOO_MANY_WAITING_TO_JOIN =
  "Too many people are waiting to join this meeting. Please try again in a moment.";
const MESSAGE_BROWSER_RECOGNITION_EXPIRED = "Browser recognition expired or was turned off. Refresh to choose again.";
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_JOIN_REQUEST_NOT_FOUND = "Join request not found.";
const MESSAGE_JOIN_REQUEST_NOT_AVAILABLE = "Join request is not available to this session.";
const MESSAGE_ASK_TO_JOIN_FIRST = "Ask to join this meeting first.";
const MESSAGE_JOIN_REQUEST_NOT_FOUND_FOR_MEETING = "Join request not found for this meeting.";
const MESSAGE_MEETING_HAS_ENDED = "This meeting has ended.";
const MESSAGE_JOIN_REQUEST_NO_LONGER_WAITING = "Join request is no longer waiting.";
const MESSAGE_COULD_NOT_CONNECT_CALLER = "Could not connect the caller to the meeting. Try again or deny the request.";
const MESSAGE_MEETING_ACCESS_MISSING_USER = "Meeting access is missing an authenticated user.";
const GUEST_SESSION_SECRET_BYTE_LENGTH = 32;

const meetingLinkCodeParamsSchema = z.object({ code: z.string() });
const joinRequestIdParamsSchema = z.object({ requestId: z.string().uuid() });

const recognitionAvailable = () => apiEnv.GUEST_RECOGNITION_ENABLED && Boolean(apiEnv.GUEST_RECOGNITION_PROXY_SECRET);

function isAgentIntroAccessible(input: {
  meeting: MeetingRecord | null;
  meetingLink: { createdByUserId: string };
  authUserId?: string | null;
}) {
  return (
    input.meeting?.kind !== "agent_intro" ||
    (input.authUserId !== null &&
      input.authUserId !== undefined &&
      input.authUserId === input.meetingLink.createdByUserId)
  );
}

function hashGuestSecret(input: { secret: string }) {
  return createHash("sha256").update(input.secret).digest("hex");
}

function signGuestMeetingToken(input: {
  userId: string;
  email: string;
  displayName: string;
  workspaceId: string;
  meetingLinkId: string;
  meetingId?: string | null;
  joinRequestId: string;
  guestSessionId: string;
  guestSessionSecret: string;
}) {
  return signAuthToken({
    sub: input.userId,
    email: input.email,
    displayName: input.displayName,
    avatarUrl: null,
    plan: "free",
    workspaceId: input.workspaceId,
    sessionVersion: 1,
    tokenKind: "guest",
    source: "guest",
    meetingLinkId: input.meetingLinkId,
    meetingId: input.meetingId ?? null,
    joinRequestId: input.joinRequestId,
    guestSessionId: input.guestSessionId,
    guestSessionSecret: input.guestSessionSecret,
  });
}

async function mintGuestJoinSession(input: {
  guestUser: NonNullable<Awaited<ReturnType<RepositoryPort["createGuestUser"]>>>;
  meetingLink: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingLinkByCode"]>>>;
  currentMeetingId: string | null;
  joinRequestId: string;
}) {
  const secret = randomBytes(GUEST_SESSION_SECRET_BYTE_LENGTH).toString("base64url");
  const expiresAt = new Date(Date.now() + GUEST_SESSION_TTL_MS);
  await repositories().cleanupGuestMeetingSessions();
  const session = await repositories().createGuestAuthSession({
    userId: input.guestUser.id,
    meetingLinkId: input.meetingLink.id,
    meetingId: input.currentMeetingId,
    joinRequestId: input.joinRequestId,
    secretHash: hashGuestSecret({ secret }),
    expiresAt,
  });

  return {
    token: signGuestMeetingToken({
      userId: input.guestUser.id,
      email: input.guestUser.email,
      displayName: input.guestUser.displayName,
      workspaceId: input.meetingLink.workspaceId,
      meetingLinkId: input.meetingLink.id,
      meetingId: input.currentMeetingId,
      joinRequestId: input.joinRequestId,
      guestSessionId: session.id,
      guestSessionSecret: secret,
    }),
    expiresAt: expiresAt.toISOString(),
    user: {
      id: input.guestUser.id,
      email: input.guestUser.email,
      displayName: input.guestUser.displayName,
      avatarUrl: input.guestUser.avatarUrl,
      source: input.guestUser.source,
      authProvider: null,
      plan: input.guestUser.plan,
      hasCompletedFirstMeeting: input.guestUser.hasCompletedFirstMeeting,
      hasCompletedAgentIntro: false,
      workspaceId: input.meetingLink.workspaceId,
      sessionVersion: input.guestUser.sessionVersion,
      deletedAt: input.guestUser.deletedAt?.toISOString() ?? null,
      createdAt: input.guestUser.createdAt.toISOString(),
    },
  };
}

async function applyJoinRequestRecognitionHeaders(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  guestUser: NonNullable<Awaited<ReturnType<RepositoryPort["createGuestUser"]>>>;
  recognition: NonNullable<z.infer<typeof createMeetingJoinRequestSchema>["recognition"]>;
}): Promise<boolean> {
  const header = input.request.headers[GUEST_RECOGNITION_HEADER];
  const token = typeof header === "string" ? header : undefined;
  if (input.recognition.enabled) {
    try {
      const recognition = await repositories().recognizeGuest({
        token,
        guestUserId: input.guestUser.id,
        explicitOptIn: input.recognition.explicitOptIn,
      });
      input.reply.header(GUEST_RECOGNITION_HEADER, recognition.token);
      input.reply.header(GUEST_RECOGNITION_EXPIRES_HEADER, recognition.expiresAt.toISOString());
    } catch (error) {
      if (error instanceof GuestRecognitionConsentRequired) {
        await input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_BROWSER_RECOGNITION_EXPIRED });

        return true;
      }
      throw error;
    }
  } else {
    await repositories().revokeGuestRecognition(token);
    input.reply.header(GUEST_RECOGNITION_HEADER, "clear");
  }

  return false;
}

type MeetingLinkJoinContext = {
  parsed: z.infer<typeof createMeetingJoinRequestSchema>;
  authUser: Awaited<ReturnType<typeof authenticateOptionalFullAuth>>;
  meetingLink: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingLinkByCode"]>>>;
  currentMeeting: Awaited<ReturnType<RepositoryPort["getCurrentMeetingForLink"]>>;
};

async function ensureMeetingLinkAcceptsJoinRequest(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  authUser: MeetingLinkJoinContext["authUser"];
  parsed: z.infer<typeof createMeetingJoinRequestSchema>;
  meetingLink: MeetingLinkJoinContext["meetingLink"];
  currentMeeting: MeetingLinkJoinContext["currentMeeting"];
}): Promise<boolean> {
  if (
    input.authUser &&
    input.currentMeeting &&
    (await isTrustedMeetingUser({ meeting: input.currentMeeting, userId: input.authUser.id }))
  ) {
    await input.reply.code(HTTP_CONFLICT).send({ code: ALREADY_TRUSTED_CODE, message: MESSAGE_ALREADY_TRUSTED });

    return false;
  }

  const requestedDisplayName = input.parsed.displayName;
  if (!input.authUser && (requestedDisplayName === undefined || requestedDisplayName.trim().length === 0)) {
    await input.reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_NAME_REQUIRED_TO_JOIN });

    return false;
  }

  if (
    !input.authUser &&
    (await repositories().countWaitingJoinRequestsForLink(input.meetingLink.id)) >= MAX_WAITING_JOIN_REQUESTS_PER_LINK
  ) {
    await input.reply.code(HTTP_TOO_MANY_REQUESTS).send({
      message: MESSAGE_TOO_MANY_WAITING_TO_JOIN,
    });

    return false;
  }

  const recognitionToken = input.request.headers[GUEST_RECOGNITION_HEADER];
  if (
    !input.authUser &&
    input.parsed.recognition?.enabled === true &&
    !input.parsed.recognition.explicitOptIn &&
    !(await repositories().getGuestRecognition(typeof recognitionToken === "string" ? recognitionToken : undefined))
  ) {
    await input.reply.code(HTTP_CONFLICT).send({ message: MESSAGE_BROWSER_RECOGNITION_EXPIRED });

    return false;
  }

  return true;
}

async function loadMeetingLinkJoinContext(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  authUser: MeetingLinkJoinContext["authUser"];
}): Promise<MeetingLinkJoinContext | null> {
  const parsed = createMeetingJoinRequestSchema.safeParse(input.request.body);
  if (!parsed.success) {
    await input.reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });

    return null;
  }

  if (
    parsed.data.recognition?.enabled === true &&
    (!recognitionAvailable() || parsed.data.recognition.noticeVersion !== GUEST_RECOGNITION_NOTICE_VERSION)
  ) {
    await input.reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_BROWSER_RECOGNITION_UNAVAILABLE });

    return null;
  }

  const { code } = meetingLinkCodeParamsSchema.parse(input.request.params);
  const meetingLink = await repositories().getMeetingLinkByCode(normalizeMeetingLinkCode(code));
  if (!meetingLink || meetingLink.status !== "active") {
    await input.reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_LINK_NOT_FOUND });

    return null;
  }

  const [currentMeeting, latestMeeting] = await Promise.all([
    repositories().getCurrentMeetingForLink(meetingLink.id),
    repositories().getLatestMeetingForLink(meetingLink.id),
  ]);
  const hostingAccess = await getMeetingHostingAccessForUser(meetingLink.createdByUserId);
  const canHostLink = currentMeeting ? hostingAccess.canHostStandardMeetings : hostingAccess.canCreateStandardMeeting;
  if (!canHostLink) {
    await input.reply.code(HTTP_FORBIDDEN).send({
      code: MEETING_HOST_PLAN_REQUIRED_CODE,
      message: MESSAGE_MEETING_LINK_NOT_OPEN,
    });

    return null;
  }

  const introGuardMeeting = currentMeeting ?? latestMeeting;
  if (!isAgentIntroAccessible({ meeting: introGuardMeeting, meetingLink, authUserId: input.authUser?.id })) {
    await input.reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_LINK_NOT_FOUND });

    return null;
  }

  const canAcceptJoinRequest = await ensureMeetingLinkAcceptsJoinRequest({
    request: input.request,
    reply: input.reply,
    authUser: input.authUser,
    parsed: parsed.data,
    meetingLink,
    currentMeeting,
  });
  if (!canAcceptJoinRequest) {
    return null;
  }

  return { parsed: parsed.data, authUser: input.authUser, meetingLink, currentMeeting };
}

async function createMeetingLinkGuestUser(input: { parsed: z.infer<typeof createMeetingJoinRequestSchema> }) {
  return repositories().createGuestUser({
    displayName: input.parsed.displayName ?? "Guest",
  });
}

async function handleMeetingLinkJoinRequest(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { request, reply } = input;
  const bearerToken = readBearerToken(request);
  const authUser = bearerToken !== null ? await authenticateOptionalFullAuth(request, reply) : null;
  if (reply.sent) {
    return;
  }

  const joinContext = await loadMeetingLinkJoinContext({ request, reply, authUser });
  if (joinContext === null) {
    return;
  }

  const { parsed, meetingLink, currentMeeting, authUser: joinAuthUser } = joinContext;

  const guestUser =
    joinAuthUser === null || joinAuthUser === undefined ? await createMeetingLinkGuestUser({ parsed }) : null;
  const requester = guestUser ?? joinAuthUser;
  if (requester === null || requester === undefined) {
    return;
  }

  return completeMeetingLinkJoinRequest({
    request,
    reply,
    parsed,
    meetingLink,
    currentMeeting,
    guestUser,
    requester,
  });
}

async function completeMeetingLinkJoinRequest(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  parsed: z.infer<typeof createMeetingJoinRequestSchema>;
  meetingLink: MeetingLinkJoinContext["meetingLink"];
  currentMeeting: MeetingLinkJoinContext["currentMeeting"];
  guestUser: Awaited<ReturnType<typeof createMeetingLinkGuestUser>> | null;
  requester: { id: string; displayName: string };
}) {
  const guestUser = input.guestUser;
  const joinRequest = await repositories().createOrReuseMeetingJoinRequest({
    meetingLinkId: input.meetingLink.id,
    meetingId: input.currentMeeting?.id ?? null,
    userId: input.requester.id,
    displayName: input.requester.displayName,
  });

  const guestSession =
    guestUser === null
      ? null
      : await mintGuestJoinSession({
          guestUser,
          meetingLink: input.meetingLink,
          currentMeetingId: input.currentMeeting?.id ?? null,
          joinRequestId: joinRequest.id,
        });

  if (guestUser !== null && input.parsed.recognition !== undefined) {
    const isRecognitionBlocked = await applyJoinRequestRecognitionHeaders({
      request: input.request,
      reply: input.reply,
      guestUser,
      recognition: input.parsed.recognition,
    });
    if (isRecognitionBlocked) {
      return;
    }
  }
  input.reply.header("Cache-Control", "no-store");
  // The request is already saved. The host's request list polls and the guest's
  // status polls, so a realtime outage must not turn asking to join into an error.
  try {
    await repositories().publishMeetingJoinRequestRealtime({
      request: joinRequest,
      eventName: "join-request.created",
    });
  } catch (error) {
    input.request.log.warn(
      { error, joinRequestId: joinRequest.id },
      "Join request saved but its realtime announcement failed",
    );
  }

  return meetingJoinRequestResponseSchema.parse({
    hasActiveParticipants:
      input.currentMeeting !== null &&
      (await repositories().listActiveHumanParticipantsForMeeting(input.currentMeeting.id)).length !== 0,
    request: joinRequest,
    meeting: input.currentMeeting
      ? await toMeetingDTOForViewer({ input: input.currentMeeting, viewerRole: "untrusted" })
      : null,
    meetingLink: toMeetingLinkDTO(input.meetingLink),
    guestSession,
  });
}

function registerMeetingLinkGuestRecognitionRoutes(app: FastifyInstance): void {
  app.get(
    "/guest-recognition",
    {
      config: {
        rateLimit: {
          max: GUEST_RECOGNITION_GET_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
          keyGenerator: guestRecognitionRateKey,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const token = request.headers[GUEST_RECOGNITION_HEADER];
      const identity = typeof token === "string" ? await repositories().getGuestRecognition(token) : null;

      return {
        /** @external guest recognition available wire field */
        available: recognitionAvailable(),
        /** @external guest recognition recognized wire field */
        recognized: identity !== null,
        lastDisplayName: identity?.lastDisplayName ?? null,
      };
    },
  );
  app.delete(
    "/guest-recognition",
    {
      config: {
        rateLimit: {
          max: GUEST_RECOGNITION_DELETE_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
          keyGenerator: guestRecognitionRateKey,
        },
      },
    },
    async (request, reply) => {
      const token = request.headers[GUEST_RECOGNITION_HEADER];
      if (typeof token === "string") {
        await repositories().revokeGuestRecognition(token);
      }
      reply.header("Cache-Control", "no-store");

      return {
        /** @external guest recognition revoke ok wire field */
        ok: true,
      };
    },
  );
}

function registerMeetingLinkPrejoinRoutes(app: FastifyInstance): void {
  app.get(
    "/meeting-links/:code/prejoin",
    {
      config: {
        rateLimit: {
          max: MEETING_LINK_PREJOIN_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
          keyGenerator: guestRecognitionRateKey,
        },
      },
    },
    async (request, reply) => {
      const bearerToken = readBearerToken(request);
      const authUser = bearerToken !== null ? await authenticateOptionalFullAuth(request, reply) : null;
      if (reply.sent) {
        return;
      }

      const { code } = meetingLinkCodeParamsSchema.parse(request.params);
      const meetingLink = await repositories().getMeetingLinkByCode(normalizeMeetingLinkCode(code));
      if (!meetingLink || meetingLink.status !== "active") {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_LINK_NOT_FOUND });
      }

      const [currentMeeting, latestMeeting] = await Promise.all([
        repositories().getCurrentMeetingForLink(meetingLink.id),
        repositories().getLatestMeetingForLink(meetingLink.id),
      ]);
      const introGuardMeeting = currentMeeting ?? latestMeeting;
      if (!isAgentIntroAccessible({ meeting: introGuardMeeting, meetingLink, authUserId: authUser?.id })) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_LINK_NOT_FOUND });
      }

      const isTrusted = Boolean(
        authUser && currentMeeting && (await isTrustedMeetingUser({ meeting: currentMeeting, userId: authUser.id })),
      );
      const hostingAccess = await getMeetingHostingAccessForUser(meetingLink.createdByUserId);

      const hasActiveParticipants =
        currentMeeting !== null &&
        (await repositories().listActiveHumanParticipantsForMeeting(currentMeeting.id)).length !== 0;

      return meetingLinkPrejoinResponseSchema.parse({
        /** @external meeting link prejoin active participants wire field */
        hasActiveParticipants,
        meeting: currentMeeting
          ? await toMeetingDTOForViewer({ input: currentMeeting, viewerRole: "untrusted" })
          : null,
        meetingLink: toMeetingLinkDTO(meetingLink),
        /** @external meeting link prejoin trusted wire field */
        trusted: isTrusted,
        /** @external meeting link prejoin host plan required wire field */
        hostPlanRequired: currentMeeting
          ? !hostingAccess.canHostStandardMeetings
          : !hostingAccess.canCreateStandardMeeting,
      });
    },
  );
}

function registerMeetingLinkJoinRequestRoutes(app: FastifyInstance): void {
  app.post(
    "/meeting-links/:code/join-requests",
    {
      config: {
        rateLimit: {
          max: MEETING_LINK_JOIN_REQUEST_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
          keyGenerator: guestRecognitionRateKey,
        },
      },
    },
    async (request, reply) => handleMeetingLinkJoinRequest({ request, reply }),
  );

  app.get(
    "/meeting-join-requests/:requestId",
    {
      preHandler: requireMeetingScopedAuth,
      config: { rateLimit: { max: MEETING_JOIN_REQUEST_STATUS_RATE_LIMIT_MAX, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { requestId } = joinRequestIdParamsSchema.parse(request.params);
      const user = request.user;
      if (!user) {
        return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
      }

      const joinRequest = await repositories().getMeetingJoinRequestById(requestId);
      if (!joinRequest) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_JOIN_REQUEST_NOT_FOUND });
      }

      const meeting =
        joinRequest.meetingId !== null ? await repositories().getMeetingById(joinRequest.meetingId) : null;

      const canViewOwnRequest =
        joinRequest.userId === user.id && (user.tokenKind !== "guest" || user.joinRequestId === joinRequest.id);
      const canViewAsHost =
        user.tokenKind !== "guest" && meeting !== null && (await isAuthorizedMeetingHost({ meeting, userId: user.id }));
      if (!canViewOwnRequest && !canViewAsHost) {
        return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_JOIN_REQUEST_NOT_AVAILABLE });
      }

      const hasActiveParticipants =
        meeting !== null &&
        meeting.status !== "ended" &&
        (await repositories().listActiveHumanParticipantsForMeeting(meeting.id)).length !== 0;

      return meetingJoinRequestStatusResponseSchema.parse({
        /** @external meeting join request active participants wire field */
        hasActiveParticipants,
        request: joinRequest,
        meeting: meeting ? await toMeetingDTOForViewer({ input: meeting, viewerRole: "untrusted" }) : null,
      });
    },
  );
}

function registerMeetingLinkResolveRoutes(app: FastifyInstance): void {
  app.post("/meeting-links/:code/resolve", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const { code } = meetingLinkCodeParamsSchema.parse(request.params);
    const normalizedCode = normalizeMeetingLinkCode(code);
    const meetingLinkRecord = await repositories().getMeetingLinkByCode(normalizedCode);
    if (!meetingLinkRecord || meetingLinkRecord.status !== "active") {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_LINK_NOT_FOUND });
    }

    const [currentMeeting, latestMeeting] = await Promise.all([
      repositories().getCurrentMeetingForLink(meetingLinkRecord.id),
      repositories().getLatestMeetingForLink(meetingLinkRecord.id),
    ]);
    const hostingAccess = await getMeetingHostingAccessForUser(meetingLinkRecord.createdByUserId);
    const canResolveLink = currentMeeting
      ? hostingAccess.canHostStandardMeetings
      : hostingAccess.canCreateStandardMeeting;
    if (!canResolveLink) {
      return reply.code(HTTP_FORBIDDEN).send({
        code: MEETING_HOST_PLAN_REQUIRED_CODE,
        message: MESSAGE_MEETING_LINK_NOT_OPEN,
      });
    }

    const introGuardMeeting = currentMeeting ?? latestMeeting;
    if (
      !isAgentIntroAccessible({
        meeting: introGuardMeeting,
        meetingLink: meetingLinkRecord,
        authUserId: request.user.id,
      })
    ) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_LINK_NOT_FOUND });
    }

    const canResolveMeetingLink = currentMeeting
      ? await isTrustedMeetingUser({ meeting: currentMeeting, userId: request.user.id })
      : meetingLinkRecord.createdByUserId === request.user.id;
    if (!canResolveMeetingLink) {
      return reply.code(HTTP_FORBIDDEN).send({ code: JOIN_REQUEST_REQUIRED_CODE, message: MESSAGE_ASK_TO_JOIN_FIRST });
    }

    const resolved = await repositories().resolveMeetingLink({ code: normalizedCode });
    if (!resolved) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_LINK_NOT_FOUND });
    }

    if (resolved.created) {
      const attachedRequests = await repositories().attachWaitingJoinRequestsToMeeting({
        meetingLinkId: resolved.meetingLink.id,
        meetingId: resolved.meeting.id,
      });
      await attachedRequests.reduce(async (previous, attachedRequest) => {
        await previous;
        await repositories().publishMeetingJoinRequestRealtime({
          request: attachedRequest,
          eventName: "join-request.updated",
        });
      }, Promise.resolve());
    }

    // A guest can become the host (or another trusted participant) after
    // signing in. Successful authorized entry must settle their old wait.
    const ownRequest = await repositories().getActiveMeetingJoinRequestForUser(
      resolved.meetingLink.id,
      request.user.id,
    );
    if (ownRequest?.status === "waiting") {
      const admitted = await repositories().decideMeetingJoinRequest({
        requestId: ownRequest.id,
        meetingId: resolved.meeting.id,
        decidedByUserId: request.user.id,
        status: "admitted",
      });
      if (admitted) {
        await repositories().publishMeetingJoinRequestRealtime({
          request: admitted,
          eventName: "join-request.updated",
        });
      }
    }

    syncMeetingCallInInBackground({
      meeting: resolved.meeting,
      meetingLink: resolved.meetingLink,
      logger: request.log,
    });
    const callIn = await getSyncedCallInForMeeting({ meeting: resolved.meeting, meetingLink: resolved.meetingLink });
    const meetingLink = {
      ...resolved.meetingLink,
      callIn,
    };

    return meetingLinkResolveResponseSchema.parse({
      meeting: toMeetingDTO({
        ...resolved.meeting,
        meetingLink,
      }),
      meetingLink: toMeetingLinkDTO(meetingLink),
    });
  });
}

function registerMeetingHostJoinRequestRoutes(app: FastifyInstance): void {
  app.get(
    "/meetings/:meetingId/join-requests",
    {
      preHandler: requireMeetingAccess("host", {
        forbiddenMessage: "Only the meeting host can view join requests.",
      }),
    },
    async (request) => {
      const { meeting } = getMeetingAccess(request);
      const requests = await repositories().listWaitingJoinRequestsForMeeting(meeting.id);

      return meetingJoinRequestListResponseSchema.parse({ requests });
    },
  );

  app.post(
    "/meetings/:meetingId/join-requests/:requestId/admit",
    {
      preHandler: requireMeetingAccess("host", {
        forbiddenMessage: "Only the meeting host can admit guests.",
      }),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const { requestId } = joinRequestIdParamsSchema.parse(request.params);
      const user = request.user;
      if (!user) {
        throw new Error(MESSAGE_MEETING_ACCESS_MISSING_USER);
      }

      const joinRequest = await repositories().getMeetingJoinRequestById(requestId);
      if (!joinRequest || joinRequest.meetingLinkId !== meeting.meetingLinkId) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_JOIN_REQUEST_NOT_FOUND_FOR_MEETING });
      }
      if (meeting.status === "ended") {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_HAS_ENDED });
      }

      // Admission is saved before it is published. If publishing fails the
      // guest stays admitted and the host gets an error. Retrying an already-
      // admitted request retries publishing; guest status polling also recovers.
      const decided = await repositories().decideMeetingJoinRequest({
        requestId,
        meetingId: meeting.id,
        decidedByUserId: user.id,
        status: "admitted",
      });
      if (!decided) {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_JOIN_REQUEST_NO_LONGER_WAITING });
      }

      // Phone callers wait in a per-call holding room; admission moves them
      // into the meeting room. Decide first so the holding room's
      // participant_left webhook (fired by the move) cannot expire the request.
      const holdingRoom = decided.sipHoldingRoom;
      const callerIdentity = decided.sipParticipantIdentity;
      if (
        holdingRoom !== null &&
        holdingRoom.length > 0 &&
        callerIdentity !== null &&
        callerIdentity.length > 0 &&
        joinRequest.status === "waiting"
      ) {
        try {
          // Stamp before the move so the caller arrives in the meeting room
          // already carrying the userId attribute that backend transcription
          // and speaker labels key on.
          await updateLiveKitParticipantInfo({
            roomName: holdingRoom,
            participantIdentity: callerIdentity,
            ...callInCallerParticipantInfo({
              userId: decided.userId,
              displayName: decided.displayName,
            }),
          });
          await moveLiveKitParticipant(holdingRoom, callerIdentity, meeting.roomName);
        } catch (error) {
          request.log.error(
            { error, meetingId: meeting.id, requestId },
            "Failed to admit call-in participant into meeting room",
          );
          const reverted = await repositories().revertMeetingJoinRequestToWaiting(requestId);
          if (reverted) {
            await repositories().publishMeetingJoinRequestRealtime({
              request: reverted,
              eventName: "join-request.updated",
            });
          }

          return reply.code(HTTP_BAD_GATEWAY).send({
            message: MESSAGE_COULD_NOT_CONNECT_CALLER,
          });
        }
        await stopWaitingMessageSafely(holdingRoom, request.log);
      }

      await repositories().ensureMeetingParticipantRecord({
        meetingId: meeting.id,
        userId: decided.userId,
        role: "guest",
      });
      await repositories().maybeAutoMarkMeetingConfidential(meeting.id);
      await repositories().publishMeetingJoinRequestRealtime({
        request: decided,
        eventName: "join-request.admitted",
        // Ship the meeting with the admitted event so the guest can mint a
        // LiveKit token immediately instead of fetching the meeting first.
        meeting: await toMeetingDTOForViewer({ input: meeting, viewerRole: "untrusted" }),
      });
      await ensureMeetingAssistantCoverage(meeting.id, request.log);

      return meetingJoinRequestDecisionResponseSchema.parse({ request: decided });
    },
  );
}

function registerMeetingHostJoinRequestDenyRoutes(app: FastifyInstance): void {
  app.post(
    "/meetings/:meetingId/join-requests/:requestId/deny",
    {
      preHandler: requireMeetingAccess("host", {
        forbiddenMessage: "Only the meeting host can deny guests.",
      }),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const { requestId } = joinRequestIdParamsSchema.parse(request.params);
      const user = request.user;
      if (!user) {
        throw new Error(MESSAGE_MEETING_ACCESS_MISSING_USER);
      }

      const joinRequest = await repositories().getMeetingJoinRequestById(requestId);
      if (!joinRequest || joinRequest.meetingLinkId !== meeting.meetingLinkId) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_JOIN_REQUEST_NOT_FOUND_FOR_MEETING });
      }

      const decided = await repositories().decideMeetingJoinRequest({
        requestId,
        meetingId: meeting.id,
        decidedByUserId: user.id,
        status: "denied",
      });
      if (!decided) {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_JOIN_REQUEST_NO_LONGER_WAITING });
      }

      // Denying must also disconnect the participant. Phone callers are hung up
      // wherever they are: the holding room while waiting, or the meeting room
      // if they were previously admitted. Web guests have a deterministic
      // LiveKit identity, so the meeting room can evict them directly.
      const holdingRoom = joinRequest.sipHoldingRoom;
      const callerIdentity = joinRequest.sipParticipantIdentity;
      if (holdingRoom !== null && holdingRoom.length > 0 && callerIdentity !== null && callerIdentity.length > 0) {
        try {
          await removeLiveKitParticipant(holdingRoom, callerIdentity);
          if (joinRequest.status === "admitted") {
            await removeLiveKitParticipant(meeting.roomName, callerIdentity);
          }
        } catch (error) {
          request.log.warn(
            { error, meetingId: meeting.id, requestId },
            "Failed to disconnect denied call-in participant",
          );
        }
        await stopWaitingMessageSafely(holdingRoom, request.log);
      } else if (joinRequest.status === "admitted") {
        try {
          await removeLiveKitParticipant(meeting.roomName, `guest:${joinRequest.id}`);
        } catch (error) {
          request.log.warn(
            { error, meetingId: meeting.id, requestId },
            "Failed to remove denied guest from LiveKit room",
          );
        }
      }

      await repositories().publishMeetingJoinRequestRealtime({
        request: decided,
        eventName: "join-request.denied",
      });

      return meetingJoinRequestDecisionResponseSchema.parse({ request: decided });
    },
  );
}

export async function meetingLinkRoutes(app: FastifyInstance): Promise<void> {
  registerMeetingLinkGuestRecognitionRoutes(app);
  registerMeetingLinkPrejoinRoutes(app);
  registerMeetingLinkJoinRequestRoutes(app);
  registerMeetingLinkResolveRoutes(app);
  registerMeetingHostJoinRequestRoutes(app);
  registerMeetingHostJoinRequestDenyRoutes(app);
}
