import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import type { MeetingViewerRole } from "../../../../application/meeting-dto";
import { repositories } from "../../../../ports/repository-runtime";
import { requireAuth, requireMeetingScopedAuth } from "../plugins/auth";

export type MeetingRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;

/**
 * Access levels for /meetings/:meetingId-scoped routes. Every meeting route
 * must declare one (enforced by routes/meetings/route-access.test.ts):
 *
 * - 'participant':       full-account creator or participant. Guests denied.
 * - 'host':              full-account creator or host-role participant.
 * - 'admitted-guest':    guest with an admitted join request for this meeting,
 *                        or a full-account creator/participant.
 * - 'joined-guest':      guest who has joined after admission, or a
 *                        full-account creator/participant.
 * - 'any-authenticated': any valid token scoped to this meeting; loads the
 *                        meeting without a membership requirement (e.g. a
 *                        waiting guest leaving). Handlers must gate any
 *                        privileged action themselves.
 */
export type MeetingAccessLevel = "participant" | "host" | "admitted-guest" | "joined-guest" | "any-authenticated";

export type MeetingAccess = {
  meeting: MeetingRecord;
  level: MeetingAccessLevel;
  viewerRole: MeetingViewerRole;
};

declare module "fastify" {
  interface FastifyRequest {
    meetingAccess?: MeetingAccess;
  }
}

/**
 * Plans with hosting entitlements beyond the free tier. Since billing moved
 * to gating notes/tasks visibility by credits, meetings themselves are
 * unlimited on every plan: any signed-in account can create and host, and
 * links are always joinable. The shape survives so callers keep working and
 * a hosting limit could return without another migration.
 */
export const MEETING_CREATOR_PLANS = new Set(["business", "business_multilingual", "enterprise"]);
/** Null means hosting is unlimited (Infinity would fail the zod contract and JSON-serialize to null anyway). */
export const FREE_STANDARD_MEETING_LIMIT: number | null = null;

export type MeetingHostingAccess = {
  canCreateStandardMeeting: boolean;
  canHostStandardMeetings: boolean;
  freeStandardMeetingLimit: number | null;
  hasCreatorPlan: boolean;
  standardMeetingCount: number;
};

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_MEETING_NOT_FOUND = "Meeting not found";
const MESSAGE_FULL_ACCOUNT_REQUIRED = "Full account required";
const MESSAGE_WAITING_FOR_HOST = "Waiting for the host to admit you.";
const CODE_WAITING_FOR_HOST = "waiting_for_host";
const MESSAGE_MEETING_NOTES_ADMITTED_ONLY = "Meeting notes are available only to admitted participants.";
const CODE_WORKSPACE_SUSPENDED = "workspace_suspended";
const MESSAGE_WORKSPACE_SUSPENDED = "Your access to this workspace is suspended. Contact a workspace admin.";
const MESSAGE_ONLY_HOST_CAN_PERFORM_ACTION = "Only the meeting host can perform this action.";
const CODE_JOIN_REQUEST_REQUIRED = "join_request_required";
const MESSAGE_ASK_TO_JOIN_FIRST = "Ask to join this meeting first.";
const MESSAGE_MEETING_PARTICIPANTS_ONLY = "This meeting is available only to participants.";
const MESSAGE_REQUIRE_MEETING_ACCESS_PREHANDLER_MISSING = "requireMeetingAccess preHandler did not run for this route.";

export async function getMeetingHostingAccessForUser(createdByUserId: string | null): Promise<MeetingHostingAccess> {
  if (createdByUserId === null || createdByUserId === "") {
    return {
      canCreateStandardMeeting: false,
      canHostStandardMeetings: false,
      freeStandardMeetingLimit: FREE_STANDARD_MEETING_LIMIT,
      hasCreatorPlan: false,
      standardMeetingCount: 0,
    };
  }

  const [plan, standardMeetingCount] = await Promise.all([
    repositories().getUserPlan(createdByUserId),
    repositories().countUserCreatedStandardMeetings(createdByUserId),
  ]);
  const hasCreatorPlan = plan !== null && MEETING_CREATOR_PLANS.has(plan);

  return {
    canCreateStandardMeeting: true,
    canHostStandardMeetings: true,
    freeStandardMeetingLimit: FREE_STANDARD_MEETING_LIMIT,
    hasCreatorPlan,
    standardMeetingCount,
  };
}

export async function isTrustedMeetingUser(input: { meeting: MeetingRecord; userId: string }): Promise<boolean> {
  return (
    input.meeting.createdByUserId === input.userId ||
    (await repositories().isMeetingParticipant({ meetingId: input.meeting.id, userId: input.userId }))
  );
}

export async function isAuthorizedMeetingHost(input: { meeting: MeetingRecord; userId: string }): Promise<boolean> {
  if (input.meeting.createdByUserId === input.userId) {
    return true;
  }
  const participants = await repositories().listParticipantsForMeeting(input.meeting.id);

  return participants.some((participant) => participant.userId === input.userId && participant.role === "host");
}

const meetingIdSchema = z.string().uuid();
const meetingIdContainerSchema = z.object({ meetingId: meetingIdSchema });

const kMeetingAccessLevel = Symbol("meetingAccessLevel");
const kMeetingAllowsWorkspaceViewer = Symbol("meetingAllowsWorkspaceViewer");

const declaredMeetingAccessLevelSchema = z.custom<MeetingAccessLevel>((value) => typeof value === "string");
const declaredMeetingAllowsWorkspaceViewerSchema = z.custom<boolean>((value) => typeof value === "boolean");

// Lets the route-table test verify that a route's preHandler chain declares an
// access level, so a forgotten guard fails CI instead of shipping.
export function getDeclaredMeetingAccessLevel(handler: unknown): MeetingAccessLevel | undefined {
  if (typeof handler !== "function") {
    return undefined;
  }

  const parsed = declaredMeetingAccessLevelSchema.safeParse(Reflect.get(handler, kMeetingAccessLevel));

  return parsed.success ? parsed.data : undefined;
}

export function getDeclaredMeetingAllowsWorkspaceViewer(handler: unknown): boolean | undefined {
  if (typeof handler !== "function") {
    return undefined;
  }

  const parsed = declaredMeetingAllowsWorkspaceViewerSchema.safeParse(
    Reflect.get(handler, kMeetingAllowsWorkspaceViewer),
  );

  return parsed.success ? parsed.data : undefined;
}

type RequireMeetingAccessOptions = {
  /**
   * Where the meeting id lives. Defaults to the ':meetingId' route param;
   * '/livekit/token' carries it in the request body instead.
   */
  meetingIdFrom?: "params" | "body";
  /** Overrides the default 403 message for denied full-account users. */
  forbiddenMessage?: string;
  /**
   * Lets active members of the meeting's workspace through as read-only
   * 'workspace' viewers when the meeting is not confidential. Opt-in per
   * route: only GET routes that serve workspace-visible content set this.
   */
  /** @external meeting access preHandler option */
  allowWorkspaceViewer?: boolean;
};

function readMeetingId(input: { request: FastifyRequest; source: "params" | "body" }): string | null {
  const parsedContainer =
    input.source === "params"
      ? meetingIdContainerSchema.safeParse(input.request.params)
      : meetingIdContainerSchema.safeParse(input.request.body);

  return parsedContainer.success ? parsedContainer.data.meetingId : null;
}

function attachMeetingAccess(input: { request: FastifyRequest; meetingAccess: MeetingAccess }): void {
  const { request } = input;
  request.meetingAccess = input.meetingAccess;
}

async function resolveGuestAccess(input: {
  level: MeetingAccessLevel;
  meeting: MeetingRecord;
  user: NonNullable<FastifyRequest["user"]>;
  reply: FastifyReply;
}): Promise<FastifyReply | void> {
  const { level, meeting, user, reply } = input;

  if (level === "participant" || level === "host") {
    // Unreachable behind requireAuth; deny anyway if wiring ever changes.
    return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_FULL_ACCOUNT_REQUIRED });
  }

  if (user.meetingId !== meeting.id) {
    return reply.code(HTTP_FORBIDDEN).send({
      code: CODE_WAITING_FOR_HOST,
      message: MESSAGE_WAITING_FOR_HOST,
    });
  }

  if (level === "any-authenticated") {
    return;
  }

  const joinRequestId = user.joinRequestId;
  const hasJoinRequestId = joinRequestId !== null && joinRequestId !== undefined && joinRequestId !== "";
  const isAdmitted =
    hasJoinRequestId &&
    (level === "joined-guest"
      ? await repositories().hasJoinedAdmittedMeeting({
          meetingId: meeting.id,
          userId: user.id,
          joinRequestId,
        })
      : await repositories().hasAdmittedJoinRequestForMeeting({
          meetingId: meeting.id,
          userId: user.id,
          joinRequestId,
        }));
  if (!isAdmitted) {
    return level === "joined-guest"
      ? reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_MEETING_NOTES_ADMITTED_ONLY })
      : reply.code(HTTP_FORBIDDEN).send({
          code: CODE_WAITING_FOR_HOST,
          message: MESSAGE_WAITING_FOR_HOST,
        });
  }

  return;
}

async function resolveSuspendedMembershipReply(input: {
  membership: Awaited<ReturnType<RepositoryPort["getWorkspaceMembership"]>>;
  reply: FastifyReply;
}): Promise<boolean> {
  if (input.membership?.status !== "suspended") {
    return false;
  }

  input.reply.code(HTTP_FORBIDDEN).send({
    code: CODE_WORKSPACE_SUSPENDED,
    message: MESSAGE_WORKSPACE_SUSPENDED,
  });

  return true;
}

async function resolveFullUserAccess(input: {
  level: MeetingAccessLevel;
  meeting: MeetingRecord;
  user: NonNullable<FastifyRequest["user"]>;
  reply: FastifyReply;
  forbiddenMessage?: string;
  /** @external meeting access preHandler option */
  allowWorkspaceViewer?: boolean;
}): Promise<{ viewerRole: MeetingViewerRole } | undefined> {
  const { level, meeting, user, reply } = input;

  const membership = await repositories().getWorkspaceMembership({
    workspaceId: meeting.workspaceId,
    userId: user.id,
  });
  if (await resolveSuspendedMembershipReply({ membership, reply })) {
    return undefined;
  }

  if (level === "host") {
    if (!(await isAuthorizedMeetingHost({ meeting, userId: user.id }))) {
      reply.code(HTTP_FORBIDDEN).send({
        message: input.forbiddenMessage ?? MESSAGE_ONLY_HOST_CAN_PERFORM_ACTION,
      });

      return undefined;
    }

    return { viewerRole: "host" };
  }

  const isTrusted = await isTrustedMeetingUser({ meeting, userId: user.id });
  const isWorkspaceViewer =
    !isTrusted && input.allowWorkspaceViewer === true && !meeting.isConfidential && membership?.status === "active";

  if (level === "any-authenticated") {
    return { viewerRole: isTrusted ? "participant" : isWorkspaceViewer ? "workspace" : "untrusted" };
  }

  if (isTrusted) {
    return { viewerRole: "participant" };
  }

  return resolveUntrustedFullUserAccess({
    level,
    reply,
    forbiddenMessage: input.forbiddenMessage,
    isWorkspaceViewer,
  });
}

function resolveUntrustedFullUserAccess(input: {
  level: MeetingAccessLevel;
  reply: FastifyReply;
  forbiddenMessage?: string;
  isWorkspaceViewer: boolean;
}): { viewerRole: MeetingViewerRole } | undefined {
  if (input.isWorkspaceViewer) {
    return { viewerRole: "workspace" };
  }
  if (input.level === "admitted-guest" || input.level === "joined-guest") {
    input.reply.code(HTTP_FORBIDDEN).send({
      code: CODE_JOIN_REQUEST_REQUIRED,
      message: MESSAGE_ASK_TO_JOIN_FIRST,
    });
  } else {
    input.reply.code(HTTP_FORBIDDEN).send({
      message: input.forbiddenMessage ?? MESSAGE_MEETING_PARTICIPANTS_ONLY,
    });
  }

  return undefined;
}

type RequireMeetingAccessInput = {
  level: MeetingAccessLevel;
} & RequireMeetingAccessOptions;

function readRequireMeetingAccessInput(
  ...args: readonly [RequireMeetingAccessInput] | readonly [MeetingAccessLevel, RequireMeetingAccessOptions?]
): RequireMeetingAccessInput {
  if (typeof args[0] === "string") {
    return { level: args[0], ...(args[1] ?? {}) };
  }

  return args[0];
}

/**
 * Builds the preHandler chain for a meeting-scoped route: authenticates the
 * caller (full-account auth for 'participant'/'host', meeting-scoped auth
 * otherwise), loads the meeting once, denies by default, and attaches the
 * decision to `request.meetingAccess`.
 */
export function requireMeetingAccess(
  ...args: readonly [RequireMeetingAccessInput] | readonly [MeetingAccessLevel, RequireMeetingAccessOptions?]
): preHandlerAsyncHookHandler[] {
  const { level, ...options } = readRequireMeetingAccessInput(...args);
  const isFullAccountRoute = level === "participant" || level === "host";
  const authHandler = isFullAccountRoute ? requireAuth : requireMeetingScopedAuth;

  const accessHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const meetingId = readMeetingId({ request, source: options.meetingIdFrom ?? "params" });
    if (meetingId === null) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_NOT_FOUND });
    }

    const meeting = await repositories().getMeetingById(meetingId);
    if (meeting === null) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_NOT_FOUND });
    }

    if (user.tokenKind === "guest") {
      await resolveGuestAccess({ level, meeting, user, reply });
      if (reply.sent) {
        return reply;
      }
      attachMeetingAccess({
        request,
        meetingAccess: { meeting, level, viewerRole: "guest" },
      });

      return;
    }

    const granted = await resolveFullUserAccess({
      level,
      meeting,
      user,
      reply,
      forbiddenMessage: options.forbiddenMessage,
      allowWorkspaceViewer: options.allowWorkspaceViewer,
    });
    if (granted === undefined) {
      return;
    }
    attachMeetingAccess({
      request,
      meetingAccess: { meeting, level, viewerRole: granted.viewerRole },
    });
  };

  Object.defineProperty(accessHandler, kMeetingAccessLevel, { value: level });
  Object.defineProperty(accessHandler, kMeetingAllowsWorkspaceViewer, {
    value: options.allowWorkspaceViewer === true,
  });

  return [authHandler, accessHandler];
}

/**
 * Narrows `request.meetingAccess` for handlers; throws if the preHandler did
 * not run (a wiring bug), so routes never proceed without an access decision.
 */
export function getMeetingAccess(request: FastifyRequest): MeetingAccess {
  if (request.meetingAccess === undefined) {
    throw new Error(MESSAGE_REQUIRE_MEETING_ACCESS_PREHANDLER_MISSING);
  }

  return request.meetingAccess;
}
