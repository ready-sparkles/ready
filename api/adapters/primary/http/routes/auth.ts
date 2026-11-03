import {
  AuthenticationIdentityConflictError,
  GuestSessionLinkConflictError,
} from "@readymeet/db/domain/persistence-errors";
import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  authResponseSchema,
  devLoginRequestSchema,
  googleAddonAuthResponseSchema,
  googleAddonLoginRequestSchema,
  linkGuestSessionRequestSchema,
  linkGuestSessionResponseSchema,
  oauthLoginRequestSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { z } from "zod";

import { importGoogleAddonCalendarSafely } from "../../../../application/google-addon-calendar";
import { googleAddonCalendarCredentialStorage } from "../../../../application/google-addon-calendar-storage";
import { generateFinalizedMeetingMemories } from "../../../../application/relationship-memory";
import { apiEnv } from "../../../../composition/env";
import { repositories } from "../../../../ports/repository-runtime";
import { isVerifiedEmailClaim, verifyGoogleIdToken } from "../../../secondary/jose/google-id-token";
import { requireAuth } from "../plugins/auth";
import {
  type AuthTokenPayload,
  GoogleAddonHandoffAccountMismatchError,
  signAuthToken,
  signGoogleAddonWebHandoff,
  verifyAuthToken,
  verifyGoogleAddonOAuthBinding,
} from "../support/auth";

import { connectCalendarAccount } from "./integrations";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const GOOGLE_ADDON_LOGIN_RATE_LIMIT_MAX = 30;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_USER_NOT_FOUND = "User not found";
const MESSAGE_UNAUTHORIZED_AUTH_EXCHANGE_REQUEST = "Unauthorized auth exchange request";
const MESSAGE_GOOGLE_ADDON_HANDOFF_REQUIRES_GOOGLE_OAUTH = "Google add-on handoff requires Google OAuth";
const MESSAGE_CALENDAR_CREDENTIALS_REQUIRE_VERIFIED_ADDON_HANDOFF =
  "Calendar credentials require a verified add-on handoff";
const MESSAGE_READY_ACCOUNT_DOES_NOT_MATCH_ADDON = "Ready account does not match the add-on";
const MESSAGE_GOOGLE_ADDON_SIGN_IN_NOT_CONFIGURED = "Google add-on sign-in is not configured";
const MESSAGE_INVALID_GOOGLE_IDENTITY_TOKEN = "Invalid Google identity token";
const MESSAGE_VERIFIED_GOOGLE_EMAIL_REQUIRED = "A verified Google email is required";
const MESSAGE_GUEST_TOKEN_NOT_LINKABLE = "Guest token is not linkable.";
const MESSAGE_INVALID_GUEST_TOKEN = "Invalid guest token";
const MESSAGE_GOOGLE_ADDON_HANDOFF_INVALID_OR_EXPIRED = "Google add-on handoff is invalid or expired";

type OAuthLoginRequestBody = z.infer<typeof oauthLoginRequestSchema>;
type FullAuthUser = NonNullable<FastifyRequest["user"]>;
type GuestAuthSessionRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getGuestAuthSessionById"]>>>;

function hashGuestSecret(input: { secret: string }) {
  return createHash("sha256").update(input.secret).digest("hex");
}

function safeEqual(input: { left: string; right: string }) {
  const leftBuffer = Buffer.from(input.left);
  const rightBuffer = Buffer.from(input.right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

type AuthenticatedUserRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getUserById"]>>>;

function toAuthenticatedUserDTO(input: {
  user: AuthenticatedUserRecord;
  authProvider: "dev-login" | "google" | "microsoft-entra-id" | null;
}) {
  return {
    id: input.user.id,
    email: input.user.email,
    displayName: input.user.displayName,
    avatarUrl: input.user.avatarUrl,
    source: input.user.source,
    authProvider: input.authProvider,
    plan: input.user.plan,
    hasCompletedFirstMeeting: input.user.hasCompletedFirstMeeting,
    hasCompletedAgentIntro: Boolean(input.user.agentIntroCompletedAt),
    /** @external auth user memory availability wire field */
    memoryAvailable: apiEnv.MEMORY_ENABLED,
    workspaceId: input.user.workspaceId,
    sessionVersion: input.user.sessionVersion,
    deletedAt: input.user.deletedAt?.toISOString() ?? null,
    createdAt: input.user.createdAt.toISOString(),
  };
}

function readExpectedGoogleAddonUserId(data: {
  googleAddonHandoffToken?: string;
  provider?: "google" | "microsoft-entra-id";
  providerAccountId?: string | null;
}) {
  if (data.googleAddonHandoffToken === undefined) {
    return { isAccepted: true as const, userId: null };
  }
  if (
    data.provider !== "google" ||
    data.providerAccountId === undefined ||
    data.providerAccountId === null ||
    data.providerAccountId.length === 0
  ) {
    return {
      isAccepted: false as const,
      statusCode: HTTP_BAD_REQUEST,
      message: MESSAGE_GOOGLE_ADDON_HANDOFF_REQUIRES_GOOGLE_OAUTH,
    };
  }
  try {
    return {
      isAccepted: true as const,
      userId: verifyGoogleAddonOAuthBinding({
        token: data.googleAddonHandoffToken,
        providerAccountId: data.providerAccountId,
      }).readyUserId,
    };
  } catch (error) {
    if (error instanceof GoogleAddonHandoffAccountMismatchError) {
      return { isAccepted: false as const, statusCode: HTTP_FORBIDDEN, message: error.message };
    }

    return {
      isAccepted: false as const,
      statusCode: HTTP_UNAUTHORIZED,
      message: MESSAGE_GOOGLE_ADDON_HANDOFF_INVALID_OR_EXPIRED,
    };
  }
}

function signUserSession(user: AuthenticatedUserRecord) {
  return signAuthToken({
    sub: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    plan: user.plan,
    workspaceId: user.workspaceId,
    sessionVersion: user.sessionVersion,
    tokenKind: "full",
    source: user.source,
  });
}

function readAuthExchangeSecret(request: FastifyRequest) {
  const exchangeSecret = request.headers["x-auth-exchange-secret"];

  return Array.isArray(exchangeSecret) ? exchangeSecret[0] : exchangeSecret;
}

function isMissingVerifiedAddonHandoffForCalendar(input: {
  data: OAuthLoginRequestBody;
  expectedGoogleAddonUserId: string | null;
}) {
  return (
    input.data.googleAddonCalendarCredentials !== undefined &&
    (input.expectedGoogleAddonUserId === null || input.expectedGoogleAddonUserId.length === 0)
  );
}

async function upsertAuthenticatedOAuthUser(data: OAuthLoginRequestBody) {
  if (
    data.provider === undefined ||
    data.providerAccountId === undefined ||
    data.providerAccountId === null ||
    data.providerAccountId.length === 0
  ) {
    return null;
  }

  return repositories().upsertUserFromAuthentication({
    provider: data.provider,
    providerAccountId: data.providerAccountId,
    email: data.email,
    displayName: data.displayName,
    avatarUrl: data.avatarUrl,
    metadata: {
      email: data.email,
      via: "web-oauth",
    },
  });
}

async function resolveOAuthLoginUser(input: {
  data: OAuthLoginRequestBody;
  authenticatedUser: Awaited<ReturnType<typeof upsertAuthenticatedOAuthUser>>;
}) {
  return (
    input.authenticatedUser?.user ??
    (await repositories().upsertUser({
      email: input.data.email,
      displayName: input.data.displayName,
      avatarUrl: input.data.avatarUrl,
      source: "auth",
    }))
  );
}

async function recordOAuthAuthenticationWhenProviderOnly(input: {
  data: OAuthLoginRequestBody;
  user: AuthenticatedUserRecord;
}) {
  if (
    input.data.provider !== undefined &&
    (input.data.providerAccountId === undefined ||
      input.data.providerAccountId === null ||
      input.data.providerAccountId.length === 0)
  ) {
    await repositories().recordUserAuthentication({
      userId: input.user.id,
      provider: input.data.provider,
      providerAccountId: input.data.providerAccountId ?? null,
      metadata: {
        email: input.data.email,
      },
    });
  }
}

async function importOAuthGoogleAddonCalendarIfNeeded(input: {
  data: OAuthLoginRequestBody;
  user: AuthenticatedUserRecord;
  expectedGoogleAddonUserId: string | null;
  request: FastifyRequest;
}) {
  const providerAccountId = input.data.providerAccountId;
  if (
    !input.data.googleAddonCalendarCredentials ||
    input.expectedGoogleAddonUserId === null ||
    input.expectedGoogleAddonUserId.length === 0 ||
    typeof providerAccountId !== "string" ||
    providerAccountId === ""
  ) {
    return;
  }

  const isCalendarConnected = await importGoogleAddonCalendarSafely({
    credentials: input.data.googleAddonCalendarCredentials,
    googleSubject: providerAccountId,
    pending: googleAddonCalendarCredentialStorage({ user: input.user, googleSubject: providerAccountId }),
    connect: (grant) =>
      connectCalendarAccount({
        userId: input.user.id,
        displayName: input.user.displayName,
        ...grant,
        log: input.request.log,
      }),
    warn: (...args) => input.request.log.warn({ userId: input.user.id, ...args[0] }, args[1]),
  });
  input.request.log.info(
    {
      userId: input.user.id,
      isCalendarConnected,
      hasOfflineCredential: Boolean(input.data.googleAddonCalendarCredentials.refreshToken),
      grantedScopeCount: input.data.googleAddonCalendarCredentials.scope.split(/[,\s]+/).filter(Boolean).length,
    },
    "Marketplace sign-in Calendar grant processed",
  );
}

function googleAddonDisplayNameFromClaims(claims: { name?: string; email: string }) {
  const trimmedName = claims.name?.trim();
  if (trimmedName !== undefined && trimmedName.length > 0) {
    return trimmedName;
  }

  const localPart = claims.email.split("@")[0];

  return localPart !== undefined && localPart.length > 0 ? localPart : claims.email;
}

function verifyGuestTokenForLinking(guestToken: string) {
  try {
    return { isValid: true as const, payload: verifyAuthToken(guestToken) };
  } catch (error) {
    const failure = error instanceof Error ? error.message : "Invalid guest token";

    return { isValid: false as const, failure };
  }
}

function isGuestPayloadLinkable(payload: AuthTokenPayload) {
  return (
    payload.tokenKind === "guest" &&
    payload.source === "guest" &&
    payload.guestSessionId !== undefined &&
    payload.guestSessionId.length > 0 &&
    payload.guestSessionSecret !== undefined &&
    payload.guestSessionSecret.length > 0 &&
    payload.joinRequestId !== undefined &&
    payload.joinRequestId !== null &&
    payload.joinRequestId.length > 0
  );
}

function isGuestSessionAuthorized(input: {
  guestSession: GuestAuthSessionRecord;
  payload: AuthTokenPayload;
  fullUser: FullAuthUser;
}) {
  return (
    input.guestSession.session.userId === input.payload.sub &&
    input.guestSession.session.joinRequestId === input.payload.joinRequestId &&
    !(
      input.guestSession.session.revokedAt !== null && input.guestSession.session.linkedToUserId !== input.fullUser.id
    ) &&
    !(
      input.guestSession.session.linkedToUserId !== null &&
      input.guestSession.session.linkedToUserId.length > 0 &&
      input.guestSession.session.linkedToUserId !== input.fullUser.id
    ) &&
    input.guestSession.session.expiresAt.getTime() > Date.now() &&
    safeEqual({
      left: input.guestSession.session.secretHash,
      right: hashGuestSecret({ secret: input.payload.guestSessionSecret ?? "" }),
    })
  );
}

async function transferGuestMeetingsUnlessAlreadyLinked(input: {
  guestSession: GuestAuthSessionRecord;
  payload: AuthTokenPayload;
  fullUser: FullAuthUser;
}) {
  try {
    return input.guestSession.session.linkedToUserId === input.fullUser.id
      ? []
      : await repositories().transferGuestMeetingAccessToUser({
          guestUserId: input.payload.sub,
          targetUserId: input.fullUser.id,
          targetWorkspaceId: input.fullUser.workspaceId,
        });
  } catch (error) {
    if (error instanceof GuestSessionLinkConflictError) {
      return error;
    }
    throw error;
  }
}

async function publishLinkGuestSessionRealtime(input: { joinRequestId: string; fullUser: FullAuthUser }) {
  const originalRequest = await repositories().getMeetingJoinRequestById(input.joinRequestId);
  if (!originalRequest) {
    return null;
  }
  await repositories().publishMeetingJoinRequestRealtime({
    request: originalRequest,
    eventName: "join-request.updated",
  });
  if (originalRequest.userId === input.fullUser.id) {
    return originalRequest;
  }
  const linkedRequest = await repositories().getActiveMeetingJoinRequestForUser(
    originalRequest.meetingLinkId,
    input.fullUser.id,
  );
  if (linkedRequest && linkedRequest.id !== originalRequest.id) {
    await repositories().publishMeetingJoinRequestRealtime({
      request: linkedRequest,
      eventName: "join-request.updated",
    });
  }

  return linkedRequest;
}

async function handleGetAuthMe(request: FastifyRequest, reply: FastifyReply) {
  const userId = request.user?.id;
  if (userId === undefined || userId.length === 0) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
  }

  const user = await repositories().getUserById(userId);
  if (user === null) {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_USER_NOT_FOUND });
  }

  return authResponseSchema.parse({
    token: signUserSession(user),
    user: toAuthenticatedUserDTO({
      user,
      authProvider: user.source === "dev_login" ? "dev-login" : null,
    }),
  });
}

async function handleOAuthLogin(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { request, reply } = input;
  const providedSecret = readAuthExchangeSecret(request);
  if (
    providedSecret === undefined ||
    providedSecret.length === 0 ||
    !safeEqual({ left: providedSecret, right: apiEnv.AUTH_EXCHANGE_SECRET })
  ) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED_AUTH_EXCHANGE_REQUEST });
  }

  const parsed = oauthLoginRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }

  const handoff = readExpectedGoogleAddonUserId(parsed.data);
  if (!handoff.isAccepted) {
    return reply.code(handoff.statusCode).send({ message: handoff.message });
  }
  const expectedGoogleAddonUserId = handoff.userId;

  if (isMissingVerifiedAddonHandoffForCalendar({ data: parsed.data, expectedGoogleAddonUserId })) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CALENDAR_CREDENTIALS_REQUIRE_VERIFIED_ADDON_HANDOFF });
  }

  const authenticatedUser = await upsertAuthenticatedOAuthUser(parsed.data);
  if (
    expectedGoogleAddonUserId !== null &&
    expectedGoogleAddonUserId.length > 0 &&
    authenticatedUser?.user.id !== expectedGoogleAddonUserId
  ) {
    return reply.code(HTTP_FORBIDDEN).send({ message: MESSAGE_READY_ACCOUNT_DOES_NOT_MATCH_ADDON });
  }
  const user = await resolveOAuthLoginUser({ data: parsed.data, authenticatedUser });

  await recordOAuthAuthenticationWhenProviderOnly({ data: parsed.data, user });
  await importOAuthGoogleAddonCalendarIfNeeded({
    data: parsed.data,
    user,
    expectedGoogleAddonUserId,
    request,
  });

  return authResponseSchema.parse({
    token: signUserSession(user),
    user: toAuthenticatedUserDTO({
      user,
      authProvider: parsed.data.provider ?? null,
    }),
  });
}

async function handleGoogleAddonLogin(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { request, reply } = input;
  const allowedAudiences = apiEnv.GOOGLE_ADDON_OAUTH_AUDIENCES.split(",")
    .map((audience) => audience.trim())
    .filter(Boolean);
  if (allowedAudiences.length === 0) {
    return reply.code(HTTP_SERVICE_UNAVAILABLE).send({ message: MESSAGE_GOOGLE_ADDON_SIGN_IN_NOT_CONFIGURED });
  }

  const parsed = googleAddonLoginRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }

  const claims = await verifyGoogleIdToken(parsed.data.idToken);
  if (claims === null || !allowedAudiences.includes(claims.aud)) {
    request.log.warn(
      { hasClaims: Boolean(claims), aud: claims?.aud },
      "google-addon-login rejected: token invalid or audience not allowed",
    );

    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_INVALID_GOOGLE_IDENTITY_TOKEN });
  }
  if (claims.email === undefined || claims.email.length === 0 || !isVerifiedEmailClaim(claims.email_verified)) {
    request.log.warn(
      { hasEmail: Boolean(claims.email), emailVerified: claims.email_verified },
      "google-addon-login rejected: email missing or unverified",
    );

    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_VERIFIED_GOOGLE_EMAIL_REQUIRED });
  }

  // Resolve the stable Google subject before email so a Workspace primary
  // email rename updates the existing Ready identity instead of forking it.
  const { user, accountCreated: isAccountCreated } = await repositories().upsertUserFromAuthentication({
    provider: "google",
    providerAccountId: claims.sub,
    email: claims.email,
    displayName: googleAddonDisplayNameFromClaims({ name: claims.name, email: claims.email }),
    avatarUrl: claims.picture ?? null,
    metadata: {
      email: claims.email,
      via: "google-workspace-addon",
    },
  });

  request.log.info({ userId: user.id, isAccountCreated }, "Google Workspace add-on account authenticated");

  const token = signAuthToken({
    sub: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    plan: user.plan,
    workspaceId: user.workspaceId,
    sessionVersion: user.sessionVersion,
    tokenKind: "full",
    source: user.source,
  });
  const webHandoffId = randomUUID();
  const webHandoffToken = signGoogleAddonWebHandoff({
    handoffId: webHandoffId,
    readyUserId: user.id,
    googleSubject: claims.sub,
    email: user.email,
  });

  return googleAddonAuthResponseSchema.parse({
    token,
    /** @external google add-on account created wire field */
    accountCreated: isAccountCreated,
    webHandoffId,
    webHandoffToken,
    user: toAuthenticatedUserDTO({ user, authProvider: "google" }),
  });
}

async function handleLinkGuestSession(request: FastifyRequest, reply: FastifyReply) {
  const fullUser = request.user;
  if (fullUser === undefined) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
  }

  const parsed = linkGuestSessionRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }

  const verifiedGuestToken = verifyGuestTokenForLinking(parsed.data.guestToken);
  if (!verifiedGuestToken.isValid) {
    return reply.code(HTTP_UNAUTHORIZED).send({
      message: MESSAGE_INVALID_GUEST_TOKEN,
    });
  }
  const payload = verifiedGuestToken.payload;

  if (!isGuestPayloadLinkable(payload)) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_GUEST_TOKEN_NOT_LINKABLE });
  }

  const guestSession = await repositories().getGuestAuthSessionById(payload.guestSessionId ?? "");
  if (guestSession === null || !isGuestSessionAuthorized({ guestSession, payload, fullUser })) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_INVALID_GUEST_TOKEN });
  }

  const transferredMeetingIds = await transferGuestMeetingsUnlessAlreadyLinked({
    guestSession,
    payload,
    fullUser,
  });
  if (transferredMeetingIds instanceof GuestSessionLinkConflictError) {
    return reply.code(HTTP_CONFLICT).send({ message: transferredMeetingIds.message });
  }

  await Promise.all(transferredMeetingIds.map(generateFinalizedMeetingMemories));
  const linkedRequest = await publishLinkGuestSessionRealtime({
    joinRequestId: payload.joinRequestId ?? "",
    fullUser,
  });

  return linkGuestSessionResponseSchema.parse({
    /** @external link guest session ok wire field */
    ok: true,
    linkedUserId: fullUser.id,
    transferredMeetingIds,
    request: linkedRequest,
  });
}

async function handleDevLogin(request: FastifyRequest, reply: FastifyReply) {
  const parsed = devLoginRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }

  const user = await repositories().upsertUser({
    ...parsed.data,
    source: "dev_login",
  });
  const token = signAuthToken({
    sub: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    plan: user.plan,
    workspaceId: user.workspaceId,
    sessionVersion: user.sessionVersion,
    tokenKind: "full",
    source: user.source,
  });

  return authResponseSchema.parse({
    token,
    user: toAuthenticatedUserDTO({ user, authProvider: "dev-login" }),
  });
}

function registerAuthMeRoute(app: FastifyInstance): void {
  app.get("/auth/me", { preHandler: requireAuth }, handleGetAuthMe);
}

async function identityResponse(input: { reply: FastifyReply; run: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await input.run();
  } catch (error) {
    if (error instanceof AuthenticationIdentityConflictError) {
      return input.reply.code(HTTP_CONFLICT).send({ message: error.message });
    }
    throw error;
  }
}

function registerOAuthLoginRoute(app: FastifyInstance): void {
  app.post("/auth/oauth-login", (request, reply) =>
    identityResponse({ reply, run: () => handleOAuthLogin({ request, reply }) }),
  );
}

function registerGoogleAddonLoginRoute(app: FastifyInstance): void {
  // Sign-in for the Google Workspace add-on: verifies the add-on's OIDC
  // identity token and upserts the Ready account, mirroring oauth-login.
  // Unlike oauth-login there is no shared-secret caller, so the Google
  // signature/audience check is the whole trust boundary.
  app.post(
    "/auth/google-addon-login",
    {
      config: { rateLimit: { max: GOOGLE_ADDON_LOGIN_RATE_LIMIT_MAX, timeWindow: "1 minute" } },
    },
    (request, reply) => identityResponse({ reply, run: () => handleGoogleAddonLogin({ request, reply }) }),
  );
}

function registerLinkGuestSessionRoute(app: FastifyInstance): void {
  app.post("/auth/link-guest-session", { preHandler: requireAuth }, handleLinkGuestSession);
}

function registerDevLoginRoute(app: FastifyInstance): void {
  app.post("/auth/dev-login", handleDevLogin);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  registerAuthMeRoute(app);
  registerOAuthLoginRoute(app);
  registerGoogleAddonLoginRoute(app);
  registerLinkGuestSessionRoute(app);

  if (apiEnv.NODE_ENV === "production") {
    return;
  }

  registerDevLoginRoute(app);
}
