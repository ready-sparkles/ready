import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";

import { apiEnv } from "../../../../ports/api-env";
import { repositories } from "../../../../ports/repository-runtime";
import { type AuthTokenPayload, readBearerToken, verifyAuthToken } from "../support/auth";

const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_FORBIDDEN_STATUS = 403;
const AUTH_MESSAGES = {
  invalidToken: "Invalid token",
  invalidGuestToken: "Invalid guest token",
  missingBearerToken: "Missing bearer token",
  fullAccountRequired: "Full account required",
  guestMeetingSessionRequired: "Guest meeting session required",
  adminAccessRequired: "Admin access required",
} as const;
const GUEST_TOKEN_KIND = "guest";
const FREE_PLAN = "free";
const EMPTY_STRING = "";
const LAST_SEEN_LOCAL_THROTTLE_MS = 60_000;
const LAST_SEEN_LOCAL_CACHE_MAX = 10_000;
const ACTIVE_WORKSPACE_RESOLUTION_TTL_MS = 10_000;
const ACTIVE_WORKSPACE_RESOLUTION_CACHE_MAX = 10_000;
const DEFAULT_SESSION_VERSION = 1;

type AuthHandlerInput = { request: FastifyRequest; reply: FastifyReply };

function readAuthHandlerInput(
  ...args: readonly [AuthHandlerInput] | readonly [FastifyRequest, FastifyReply]
): AuthHandlerInput {
  return args.length === 1 ? args[0] : { request: args[0], reply: args[1] };
}

// Keep last-seen writes off the hot request path; SQL still throttles across API instances.
const lastSeenTouchedAt = new Map<string, number>();
const activeWorkspaceResolutionCache = new Map<string, { workspaceId: string; expiresAt: number }>();

function hashGuestSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function shouldTouchLastSeen({ userId }: { userId: string }): boolean {
  const now = Date.now();
  const previous = lastSeenTouchedAt.get(userId);
  if (previous !== undefined && now - previous < LAST_SEEN_LOCAL_THROTTLE_MS) {
    return false;
  }
  if (lastSeenTouchedAt.size >= LAST_SEEN_LOCAL_CACHE_MAX) {
    lastSeenTouchedAt.clear();
  }
  lastSeenTouchedAt.set(userId, now);

  return true;
}

function activeWorkspaceResolutionKey({
  userId,
  activeWorkspaceId,
}: {
  userId: string;
  activeWorkspaceId: string;
}): string {
  return `${userId}:${activeWorkspaceId}`;
}

/**
 * Drops this user's cached active-workspace resolutions, so their next request
 * re-resolves through the database. Call it when a request finds the user
 * suspended from a workspace: the cache may still point at that workspace, and
 * re-resolving moves them to an active (or replacement) workspace instead.
 */
export function forgetActiveWorkspaceResolution(userId: string): void {
  const userPrefix = `${userId}:`;
  [...activeWorkspaceResolutionCache.keys()]
    .filter((key) => key.startsWith(userPrefix))
    .forEach((key) => {
      activeWorkspaceResolutionCache.delete(key);
    });
}

async function resolveWorkspaceIdForAuth({
  payload,
  authState,
}: {
  payload: AuthTokenPayload;
  authState: NonNullable<Awaited<ReturnType<RepositoryPort["getUserAuthState"]>>>;
}): Promise<string> {
  if (authState.activeWorkspaceId === null || authState.activeWorkspaceId === EMPTY_STRING) {
    return (
      payload.workspaceId ??
      (await repositories().ensureDefaultWorkspaceForUser({
        userId: payload.sub,
        email: authState.email,
        displayName: authState.displayName,
      }))
    );
  }

  const now = Date.now();
  const cacheKey = activeWorkspaceResolutionKey({
    userId: payload.sub,
    activeWorkspaceId: authState.activeWorkspaceId,
  });
  const cached = activeWorkspaceResolutionCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.workspaceId;
  }

  const workspaceId = await repositories().ensureDefaultWorkspaceForUser({
    userId: payload.sub,
    email: authState.email,
    displayName: authState.displayName,
  });
  if (activeWorkspaceResolutionCache.size >= ACTIVE_WORKSPACE_RESOLUTION_CACHE_MAX) {
    activeWorkspaceResolutionCache.clear();
  }
  activeWorkspaceResolutionCache.set(cacheKey, {
    workspaceId,
    expiresAt: now + ACTIVE_WORKSPACE_RESOLUTION_TTL_MS,
  });

  return workspaceId;
}

function safeEqual({ left, right }: { left: string; right: string }): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function sendInvalidToken({ reply, message }: { reply: FastifyReply; message: string }): Promise<FastifyReply> {
  return reply.code(HTTP_UNAUTHORIZED_STATUS).send({ message });
}

async function authenticateFullPayload(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  payload: AuthTokenPayload;
}): Promise<FastifyReply | void> {
  const { request, reply, payload } = input;
  const authState = await repositories().getUserAuthState(payload.sub);
  if (
    authState === null ||
    authState.deletedAt !== null ||
    authState.sessionVersion !== (payload.sessionVersion ?? DEFAULT_SESSION_VERSION) ||
    authState.source === GUEST_TOKEN_KIND ||
    payload.tokenKind === GUEST_TOKEN_KIND
  ) {
    return sendInvalidToken({ reply, message: AUTH_MESSAGES.invalidToken });
  }

  // Validate active workspace selections through the database before caching them briefly.
  const workspaceId = await resolveWorkspaceIdForAuth({ payload, authState });

  request.user = {
    id: payload.sub,
    email: authState.email,
    displayName: authState.displayName,
    avatarUrl: authState.avatarUrl ?? payload.avatarUrl ?? null,
    plan: payload.plan ?? authState.plan,
    workspaceId,
    source: authState.source,
    tokenKind: "full",
  };

  // Authenticated activity advances last-seen without slowing the request.
  if (shouldTouchLastSeen({ userId: payload.sub })) {
    void touchLastSeenWithoutBlocking({ userId: payload.sub });
  }
}

// Presence is best-effort; a failed write must not change authentication results.
async function touchLastSeenWithoutBlocking({ userId }: { userId: string }): Promise<void> {
  try {
    await repositories().touchUserLastSeen(userId);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return;
    }
  }
}

type ValidGuestAuthPayload = AuthTokenPayload & {
  guestSessionId: string;
  guestSessionSecret: string;
  meetingLinkId: string;
  joinRequestId: string;
  workspaceId: string;
};

function isGuestPayloadValid(payload: AuthTokenPayload): payload is ValidGuestAuthPayload {
  return (
    payload.tokenKind === GUEST_TOKEN_KIND &&
    payload.source === GUEST_TOKEN_KIND &&
    typeof payload.guestSessionId === "string" &&
    payload.guestSessionId !== EMPTY_STRING &&
    typeof payload.guestSessionSecret === "string" &&
    payload.guestSessionSecret !== EMPTY_STRING &&
    typeof payload.meetingLinkId === "string" &&
    payload.meetingLinkId !== EMPTY_STRING &&
    typeof payload.joinRequestId === "string" &&
    payload.joinRequestId !== EMPTY_STRING &&
    typeof payload.workspaceId === "string" &&
    payload.workspaceId !== EMPTY_STRING
  );
}

function isGuestSessionInvalid({
  authState,
  sessionRow,
  payload,
  meetingLinkId,
  joinRequestId,
  guestSessionSecret,
}: {
  authState: NonNullable<Awaited<ReturnType<RepositoryPort["getUserAuthState"]>>>;
  sessionRow: NonNullable<Awaited<ReturnType<RepositoryPort["getGuestAuthSessionById"]>>>;
  payload: AuthTokenPayload;
  meetingLinkId: string;
  joinRequestId: string;
  guestSessionSecret: string;
}): boolean {
  return (
    authState.deletedAt !== null ||
    authState.source !== GUEST_TOKEN_KIND ||
    sessionRow.user.id !== payload.sub ||
    sessionRow.session.userId !== payload.sub ||
    sessionRow.session.meetingLinkId !== meetingLinkId ||
    sessionRow.session.joinRequestId !== joinRequestId ||
    Boolean(sessionRow.session.revokedAt) ||
    Boolean(sessionRow.session.linkedToUserId) ||
    sessionRow.session.expiresAt.getTime() <= Date.now() ||
    !safeEqual({ left: sessionRow.session.secretHash, right: hashGuestSecret(guestSessionSecret) })
  );
}

async function authenticateGuestPayload(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  payload: AuthTokenPayload;
}): Promise<FastifyReply | void> {
  const { request, reply, payload } = input;
  if (!isGuestPayloadValid(payload)) {
    return sendInvalidToken({ reply, message: AUTH_MESSAGES.invalidGuestToken });
  }

  const { guestSessionId, guestSessionSecret, meetingLinkId, joinRequestId, workspaceId } = payload;

  const authState = await repositories().getUserAuthState(payload.sub);
  const sessionRow = await repositories().getGuestAuthSessionById(guestSessionId);
  if (authState === null || sessionRow === null) {
    return sendInvalidToken({ reply, message: AUTH_MESSAGES.invalidGuestToken });
  }
  if (
    isGuestSessionInvalid({
      authState,
      sessionRow,
      payload,
      meetingLinkId,
      joinRequestId,
      guestSessionSecret,
    })
  ) {
    return sendInvalidToken({ reply, message: AUTH_MESSAGES.invalidGuestToken });
  }

  request.user = {
    id: payload.sub,
    email: authState.email,
    displayName: authState.displayName,
    avatarUrl: authState.avatarUrl ?? null,
    plan: FREE_PLAN,
    workspaceId,
    source: GUEST_TOKEN_KIND,
    tokenKind: GUEST_TOKEN_KIND,
    guestSessionId,
    meetingId: sessionRow.session.meetingId ?? payload.meetingId ?? null,
    meetingLinkId,
    joinRequestId,
  };
}

function readVerifiedAuthToken({ token }: { token: string }): AuthTokenPayload | null {
  try {
    return verifyAuthToken(token);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null;
    }

    return null;
  }
}

async function requirePayload({
  request,
  reply,
  allowed,
}: {
  request: FastifyRequest;
  reply: FastifyReply;
  allowed: "full" | "guest" | "meeting-scoped";
}): Promise<FastifyReply | void> {
  const token = readBearerToken(request);
  if (token === null || token === EMPTY_STRING) {
    return sendInvalidToken({ reply, message: AUTH_MESSAGES.missingBearerToken });
  }

  const payload = readVerifiedAuthToken({ token });
  if (payload === null) {
    return sendInvalidToken({ reply, message: AUTH_MESSAGES.invalidToken });
  }

  if (payload.tokenKind === GUEST_TOKEN_KIND || payload.source === GUEST_TOKEN_KIND) {
    if (allowed !== GUEST_TOKEN_KIND && allowed !== "meeting-scoped") {
      return reply.code(HTTP_FORBIDDEN_STATUS).send({ message: AUTH_MESSAGES.fullAccountRequired });
    }

    return authenticateGuestPayload({ request, reply, payload });
  }

  if (allowed === GUEST_TOKEN_KIND) {
    return reply.code(HTTP_FORBIDDEN_STATUS).send({ message: AUTH_MESSAGES.guestMeetingSessionRequired });
  }

  return authenticateFullPayload({ request, reply, payload });
}

export const requireAuth: preHandlerAsyncHookHandler = async (request, reply) => {
  return requirePayload({ request, reply, allowed: "full" });
};

export const requireMeetingScopedAuth: preHandlerAsyncHookHandler = async (request, reply) => {
  return requirePayload({ request, reply, allowed: "meeting-scoped" });
};

export async function authenticateOptionalFullAuth(
  ...args: readonly [AuthHandlerInput] | readonly [FastifyRequest, FastifyReply]
): Promise<FastifyRequest["user"] | null> {
  const { request, reply } = readAuthHandlerInput(...args);
  const token = readBearerToken(request);
  if (token === null || token === EMPTY_STRING) {
    return null;
  }

  await requirePayload({ request, reply, allowed: "full" });
  if (reply.sent) {
    return null;
  }

  return request.user ?? null;
}

export const requireAdmin: preHandlerAsyncHookHandler = async (request, reply) => {
  await requirePayload({ request, reply, allowed: "full" });
  if (reply.sent) {
    return;
  }

  const email = request.user?.email.trim().toLowerCase();
  if (email === undefined || !apiEnv().ADMIN_EMAIL.includes(email)) {
    return reply.code(HTTP_FORBIDDEN_STATUS).send({ message: AUTH_MESSAGES.adminAccessRequired });
  }
};
