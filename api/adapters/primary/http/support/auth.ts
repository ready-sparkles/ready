import { type UserPlan, userPlanSchema } from "@readymeet/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import jwt from "../../../../composition/platform/jsonwebtoken";
import { apiEnv } from "../../../../ports/api-env";

export type AuthTokenPayload = {
  sub: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  plan?: UserPlan;
  workspaceId?: string;
  sessionVersion?: number;
  tokenKind?: "full" | "guest";
  source?: "auth" | "dev_login" | "debug_import" | "guest";
  guestSessionId?: string;
  guestSessionSecret?: string;
  meetingId?: string | null;
  meetingLinkId?: string | null;
  joinRequestId?: string | null;
};

const authTokenPayloadSchema = z.object({
  sub: z.string(),
  email: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
  plan: userPlanSchema.optional(),
  workspaceId: z.string().optional(),
  sessionVersion: z.number().optional(),
  tokenKind: z.enum(["full", "guest"]).optional(),
  source: z.enum(["auth", "dev_login", "debug_import", "guest"]).optional(),
  guestSessionId: z.string().optional(),
  guestSessionSecret: z.string().optional(),
  meetingId: z.string().nullable().optional(),
  meetingLinkId: z.string().nullable().optional(),
  joinRequestId: z.string().nullable().optional(),
});

const AUTH_TOKEN_EXPIRY = "7d";
const GOOGLE_ADDON_WEB_HANDOFF_TOKEN_EXPIRY = "1h";
const GOOGLE_ADDON_WEB_HANDOFF_AUDIENCE = "ready-web";
const GOOGLE_ADDON_WEB_HANDOFF_ISSUER = "ready-api";
const GOOGLE_ADDON_WEB_HANDOFF_PURPOSE = "google-addon-web-handoff";
const MESSAGE_GOOGLE_ADDON_ACCOUNT_MISMATCH = "Selected Google account does not match the add-on";
const BEARER_PREFIX = "Bearer ";
const OAUTH_STATE_TOKEN_EXPIRY = "10m";
const OAUTH_STATE_ISSUER = "ready-api";
const MESSAGE_SCOPED_TOKEN_NOT_A_SESSION = "Token is scoped to another purpose and is not a session";

export type OAuthStateProvider = "slack" | "linear" | "calendar";

function oauthStateAudience(provider: OAuthStateProvider): string {
  return `ready-oauth-state:${provider}`;
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, apiEnv().AUTH_JWT_SECRET, {
    expiresIn: AUTH_TOKEN_EXPIRY,
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const verified = jwt.verify(token, apiEnv().AUTH_JWT_SECRET);
  // Session tokens are signed without an audience. Any token that carries one
  // (OAuth state, Google add-on handoff) was minted for another purpose and
  // must never be accepted as a login session.
  if (typeof verified !== "string" && verified.aud !== undefined) {
    throw new Error(MESSAGE_SCOPED_TOKEN_NOT_A_SESSION);
  }

  return authTokenPayloadSchema.parse(verified);
}

/**
 * Signs an OAuth `state` value. The provider-specific audience keeps a state
 * token from being replayed as a session bearer token or as another
 * provider's state.
 */
export function signOAuthState({ provider, state }: { provider: OAuthStateProvider; state: object }): string {
  return jwt.sign(state, apiEnv().AUTH_JWT_SECRET, {
    audience: oauthStateAudience(provider),
    expiresIn: OAUTH_STATE_TOKEN_EXPIRY,
    issuer: OAUTH_STATE_ISSUER,
  });
}

export function verifyOAuthState({ provider, token }: { provider: OAuthStateProvider; token: string }): unknown {
  return jwt.verify(token, apiEnv().AUTH_JWT_SECRET, {
    audience: oauthStateAudience(provider),
    issuer: OAUTH_STATE_ISSUER,
  });
}

type GoogleAddonWebHandoffPayload = {
  purpose: "google-addon-web-handoff";
  handoffId: string;
  readyUserId: string;
  googleSubject: string;
  email: string;
};

// Registered JWT claims (iat, exp, aud, iss) pass through unchanged, as on main.
const googleAddonWebHandoffPayloadSchema = z
  .object({
    purpose: z.literal(GOOGLE_ADDON_WEB_HANDOFF_PURPOSE),
    handoffId: z.string().min(1),
    readyUserId: z.string().min(1),
    googleSubject: z.string().min(1),
    email: z.string().min(1),
  })
  .passthrough();

export function signGoogleAddonWebHandoff(payload: Omit<GoogleAddonWebHandoffPayload, "purpose">): string {
  return jwt.sign({ ...payload, purpose: GOOGLE_ADDON_WEB_HANDOFF_PURPOSE }, apiEnv().AUTH_JWT_SECRET, {
    audience: GOOGLE_ADDON_WEB_HANDOFF_AUDIENCE,
    expiresIn: GOOGLE_ADDON_WEB_HANDOFF_TOKEN_EXPIRY,
    issuer: GOOGLE_ADDON_WEB_HANDOFF_ISSUER,
  });
}

export function verifyGoogleAddonWebHandoff(token: string): GoogleAddonWebHandoffPayload {
  const verified = jwt.verify(token, apiEnv().AUTH_JWT_SECRET, {
    audience: GOOGLE_ADDON_WEB_HANDOFF_AUDIENCE,
    issuer: GOOGLE_ADDON_WEB_HANDOFF_ISSUER,
  });

  return googleAddonWebHandoffPayloadSchema.parse(verified);
}

export class GoogleAddonHandoffAccountMismatchError extends Error {
  constructor() {
    super(MESSAGE_GOOGLE_ADDON_ACCOUNT_MISMATCH);
    this.name = "GoogleAddonHandoffAccountMismatchError";
  }
}

export function verifyGoogleAddonOAuthBinding(input: {
  token: string;
  providerAccountId: string;
}): GoogleAddonWebHandoffPayload {
  const handoff = verifyGoogleAddonWebHandoff(input.token);
  if (handoff.googleSubject !== input.providerAccountId) {
    throw new GoogleAddonHandoffAccountMismatchError();
  }

  return handoff;
}

export function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header === undefined || header.length === 0 || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }

  return header.replace(BEARER_PREFIX, "").trim();
}
