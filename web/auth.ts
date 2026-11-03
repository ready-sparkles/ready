import { authResponseSchema, type User, userSchema } from "@readymeet/shared";
import NextAuth, { type Account, type NextAuthConfig, type Session, type User as NextAuthUser } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

import { cookies } from "./adapters/primary/next-http/request-cookies";
import { exchangeOAuthForApiSession, refreshApiSession } from "./application/server-auth-exchange";
import { serverEnv } from "./application/server-env";
import { withSessionMemoryCapability } from "./application/session-memory-capability";
import { apiTokenMatchesUser } from "./domain/api-session-consistency";
import { exchangeWithSessionRecovery } from "./domain/auth-exchange-recovery";
import { oauthExchangeEmail, shouldReuseCachedApiSession } from "./domain/auth-jwt-session";
import {
  GOOGLE_ADDON_OAUTH_HANDOFF_COOKIE,
  parseGoogleAddonOAuthHandoffToken,
} from "./domain/google-addon-oauth-handoff";

type OAuthProvider = "google" | "microsoft-entra-id";
type DevLoginUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  apiToken: string;
  appUser: User;
};

async function readFreshOAuthAttribution(account: { provider?: string } | null | undefined): Promise<{
  googleAddonHandoffToken: string | null;
}> {
  if (!account) {
    return { googleAddonHandoffToken: null };
  }
  const cookieStore = await cookies();
  const googleAddonHandoffToken =
    account.provider === "google"
      ? parseGoogleAddonOAuthHandoffToken(cookieStore.get(GOOGLE_ADDON_OAUTH_HANDOFF_COOKIE)?.value)
      : null;
  cookieStore.delete(GOOGLE_ADDON_OAUTH_HANDOFF_COOKIE);

  return { googleAddonHandoffToken };
}

function isSupportedProvider(value: string | undefined): value is OAuthProvider {
  return value === "google" || value === "microsoft-entra-id";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDevLoginUser(value: unknown): value is DevLoginUser {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.apiToken !== "string") {
    return false;
  }
  const appUser = value.appUser;
  if (!isRecord(appUser)) {
    return false;
  }

  return typeof appUser.id === "string";
}

function buildDevLoginProvider(devLoginEmail: string) {
  return Credentials({
    id: "dev-login",
    name: "Local dev sign-in",
    credentials: {},
    async authorize() {
      const response = await fetch(`${serverEnv.INTERNAL_API_BASE_URL}/v1/auth/dev-login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: serverEnv.DEV_LOGIN_EMAIL,
          displayName: serverEnv.DEV_LOGIN_DISPLAY_NAME ?? devLoginEmail.split("@")[0],
        }),
        cache: "no-store",
      });
      if (!response.ok) {
        return null;
      }
      const payload: unknown = await response.json();
      const parsed = authResponseSchema.safeParse(payload);
      if (!parsed.success) {
        return null;
      }
      const appUser = parsed.data.user;

      return {
        id: appUser.id,
        email: appUser.email,
        name: appUser.displayName,
        image: appUser.avatarUrl,
        apiToken: parsed.data.token,
        appUser,
      } satisfies DevLoginUser;
    },
  });
}

function buildProviders() {
  const devLoginEmail = serverEnv.DEV_LOGIN_EMAIL;
  const devProviders =
    serverEnv.NODE_ENV !== "production" && typeof devLoginEmail === "string" && devLoginEmail.length > 0
      ? [buildDevLoginProvider(devLoginEmail)]
      : [];

  const googleProviders =
    Boolean(serverEnv.AUTH_GOOGLE_ID) && Boolean(serverEnv.AUTH_GOOGLE_SECRET)
      ? [
          Google({
            clientId: serverEnv.AUTH_GOOGLE_ID,
            clientSecret: serverEnv.AUTH_GOOGLE_SECRET,
            authorization: {
              params: {
                scope: "openid email profile",
              },
            },
          }),
        ]
      : [];

  const microsoftProviders =
    Boolean(serverEnv.AUTH_MICROSOFT_ENTRA_ID_ID) && Boolean(serverEnv.AUTH_MICROSOFT_ENTRA_ID_SECRET)
      ? [
          MicrosoftEntraID({
            clientId: serverEnv.AUTH_MICROSOFT_ENTRA_ID_ID,
            clientSecret: serverEnv.AUTH_MICROSOFT_ENTRA_ID_SECRET,
            issuer: serverEnv.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
            authorization: {
              params: {
                scope: "openid profile email User.Read",
              },
            },
          }),
        ]
      : [];

  const configuredProviders = [...devProviders, ...googleProviders, ...microsoftProviders];

  if (configuredProviders.length === 0) {
    return [
      Credentials({
        name: "OAuth Not Configured",
        credentials: {
          noop: { label: "noop", type: "text" },
        },
        async authorize() {
          return null;
        },
      }),
    ];
  }

  return configuredProviders;
}

function deriveDisplayName(input: { providerName?: string | null; email?: string | null }) {
  const providerName = input.providerName?.trim() ?? "";
  if (providerName.length > 0) {
    return providerName;
  }
  const email = input.email?.trim() ?? "";
  if (email.length > 0) {
    return email.split("@")[0] ?? "ReadyMeet User";
  }

  return "ReadyMeet User";
}

function deriveAvatarUrl(input: { providerImage?: string | null; tokenPicture?: unknown }) {
  if (typeof input.providerImage === "string" && Boolean(input.providerImage.trim())) {
    return input.providerImage.trim();
  }

  if (typeof input.tokenPicture === "string" && Boolean(input.tokenPicture.trim())) {
    return input.tokenPicture.trim();
  }

  return null;
}

function applyDevLoginToToken(input: { token: JWT; user: DevLoginUser }): JWT {
  return {
    ...input.token,
    apiToken: input.user.apiToken,
    appUser: input.user.appUser,
    apiAuthProvider: "dev-login",
  };
}

function tryMergeCachedUserUpdate(input: {
  token: JWT;
  cachedUserUpdate: ReturnType<typeof userSchema.safeParse> | null;
  cachedApiTokenUpdate: unknown;
}): JWT | null {
  const { token, cachedUserUpdate, cachedApiTokenUpdate } = input;
  const hasCachedApiToken = typeof token.apiToken === "string" && token.apiToken.length > 0;
  if (cachedUserUpdate?.success !== true || !(hasCachedApiToken || typeof cachedApiTokenUpdate === "string")) {
    return null;
  }
  const trimmedCachedToken = typeof cachedApiTokenUpdate === "string" ? cachedApiTokenUpdate.trim() : "";
  const nextApiToken = trimmedCachedToken.length > 0 ? trimmedCachedToken : token.apiToken;
  if (!apiTokenMatchesUser({ apiToken: nextApiToken, userId: cachedUserUpdate.data.id })) {
    return null;
  }

  return {
    ...token,
    apiToken: nextApiToken,
    appUser: cachedUserUpdate.data,
  };
}

async function enrichTokenWithCachedSession(input: { token: JWT; existingUser: User | undefined }): Promise<JWT> {
  if (!input.existingUser || typeof input.token.apiToken !== "string") {
    return input.token;
  }
  const nextAppUser = await withSessionMemoryCapability({
    user: input.existingUser,
    apiToken: input.token.apiToken,
    apiBaseUrl: serverEnv.INTERNAL_API_BASE_URL,
  });

  return { ...input.token, appUser: nextAppUser };
}

async function jwtWithoutFreshAccount(input: {
  token: JWT;
  existingUser: User | undefined;
}): Promise<JWT | Record<string, never>> {
  const apiToken = input.token.apiToken;
  if (!input.existingUser || typeof apiToken !== "string") {
    return {};
  }
  const exchanged = await exchangeWithSessionRecovery({
    token: input.token,
    hasFreshOAuthAccount: false,
    exchange: () => refreshApiSession(apiToken),
  });

  return {
    ...input.token,
    apiToken: exchanged.token,
    appUser: exchanged.user,
  };
}

function resolveOAuthProvider(input: { account: Account; token: JWT }): OAuthProvider | null {
  if (isSupportedProvider(input.account.provider)) {
    return input.account.provider;
  }
  if (isSupportedProvider(input.token.oauthProvider)) {
    return input.token.oauthProvider;
  }

  return null;
}

function resolveProviderAccountId(input: { account: Account; token: JWT }): string | null {
  const accountProviderId =
    typeof input.account.providerAccountId === "string" ? input.account.providerAccountId.trim() : "";
  if (accountProviderId.length > 0) {
    return accountProviderId;
  }
  const cachedProviderId =
    typeof input.token.oauthProviderAccountId === "string" ? input.token.oauthProviderAccountId.trim() : "";

  return cachedProviderId.length > 0 ? cachedProviderId : null;
}

function buildOAuthExchangeFields(input: {
  provider: OAuthProvider;
  exchangeEmail: string;
  exchanged: { token: string; user: User };
  account: Account;
  token: JWT;
}): JWT {
  const oauthProviderAccountId =
    typeof input.account.providerAccountId === "string" ? input.account.providerAccountId.trim() : "";

  return {
    ...input.token,
    oauthProvider: input.provider,
    apiAuthProvider: input.provider,
    email: input.exchangeEmail,
    ...(oauthProviderAccountId.length > 0 ? { oauthProviderAccountId } : {}),
    apiToken: input.exchanged.token,
    appUser: input.exchanged.user,
  };
}

async function jwtWithFreshOAuthAccount(input: {
  token: JWT;
  user: NextAuthUser | undefined;
  account: Account;
}): Promise<JWT> {
  const provider = resolveOAuthProvider({ account: input.account, token: input.token });
  const exchangeEmail = oauthExchangeEmail({
    hasFreshOAuthAccount: true,
    tokenEmail: input.token.email,
    userEmail: input.user?.email,
  });

  if (provider === null || exchangeEmail === null || exchangeEmail.length === 0) {
    return input.token;
  }

  const displayName = deriveDisplayName({
    providerName: input.user?.name ?? input.token.name,
    email: exchangeEmail,
  });
  const tokenPicture = isRecord(input.token) ? input.token.picture : undefined;
  const avatarUrl = deriveAvatarUrl({
    providerImage: input.user?.image,
    tokenPicture,
  });

  const { googleAddonHandoffToken } = await readFreshOAuthAttribution(input.account);

  const exchanged = await exchangeWithSessionRecovery({
    token: input.token,
    hasFreshOAuthAccount: true,
    exchange: () =>
      exchangeOAuthForApiSession({
        email: exchangeEmail,
        displayName,
        avatarUrl,
        provider,
        googleAddonHandoffToken,
        providerAccountId: resolveProviderAccountId({ account: input.account, token: input.token }),
      }),
  });

  return buildOAuthExchangeFields({
    provider,
    exchangeEmail,
    exchanged,
    account: input.account,
    token: input.token,
  });
}

function readJwtUpdateFromSession(input: { trigger?: "signIn" | "signUp" | "update"; session?: unknown }): {
  shouldRefreshApiToken: boolean;
  cachedUserUpdate: ReturnType<typeof userSchema.safeParse> | null;
  cachedApiTokenUpdate: unknown;
} {
  const sessionRecord = isRecord(input.session) ? input.session : null;
  if (input.trigger !== "update" || sessionRecord === null) {
    return {
      shouldRefreshApiToken: false,
      cachedUserUpdate: null,
      cachedApiTokenUpdate: null,
    };
  }

  return {
    shouldRefreshApiToken: sessionRecord.refreshApiToken === true,
    cachedUserUpdate: userSchema.safeParse(sessionRecord.appUser),
    cachedApiTokenUpdate: sessionRecord.apiToken,
  };
}

async function handleJwtCallback(input: {
  token: JWT;
  user: NextAuthUser | undefined;
  account?: Account | null;
  trigger?: "signIn" | "signUp" | "update";
  session?: unknown;
}): Promise<JWT | Record<string, never>> {
  const { token, user, account, trigger, session } = input;
  if (account?.provider === "dev-login" && isDevLoginUser(user)) {
    return applyDevLoginToToken({ token, user });
  }

  const existingUser = token.appUser;
  const { shouldRefreshApiToken, cachedUserUpdate, cachedApiTokenUpdate } = readJwtUpdateFromSession({
    trigger,
    session,
  });

  const cachedMerge = tryMergeCachedUserUpdate({ token, cachedUserUpdate, cachedApiTokenUpdate });
  if (cachedMerge !== null) {
    return cachedMerge;
  }

  if (
    shouldReuseCachedApiSession({
      apiToken: token.apiToken,
      existingUserId: existingUser?.id,
      existingWorkspaceId: existingUser?.workspaceId,
      hasFreshOAuthAccount: Boolean(account),
      shouldRefreshApiToken,
    })
  ) {
    return enrichTokenWithCachedSession({ token, existingUser });
  }

  if (!account) {
    return jwtWithoutFreshAccount({ token, existingUser });
  }

  return jwtWithFreshOAuthAccount({ token, user, account });
}

function resolveSessionAuthProvider(input: {
  token: JWT;
  appUser: User;
}): "google" | "microsoft-entra-id" | "dev-login" | null {
  if (
    input.token.apiAuthProvider === "google" ||
    input.token.apiAuthProvider === "microsoft-entra-id" ||
    input.token.apiAuthProvider === "dev-login"
  ) {
    return input.token.apiAuthProvider;
  }

  return input.appUser.authProvider ?? null;
}

async function handleSessionCallback(input: { session: Session; token: JWT }): Promise<Session> {
  const { session, token } = input;
  const appUser = token.appUser;
  if (
    typeof token.apiToken !== "string" ||
    token.apiToken.length === 0 ||
    appUser === undefined ||
    !apiTokenMatchesUser({ apiToken: token.apiToken, userId: appUser.id })
  ) {
    return {
      ...session,
      authError: "missing_app_auth",
    };
  }

  const authProvider = resolveSessionAuthProvider({ token, appUser });
  const sessionAppUser = {
    ...appUser,
    authProvider,
  };

  return {
    ...session,
    apiRefreshRetryAt: token.apiRefreshRetryAt,
    apiToken: token.apiToken,
    appUser: sessionAppUser,
    user: {
      ...session.user,
      email: sessionAppUser.email,
      name: sessionAppUser.displayName,
      image: sessionAppUser.avatarUrl,
    },
  };
}

export const authConfig = {
  providers: buildProviders(),
  pages: {
    signIn: "/login",
    error: "/login",
  },
  secret: serverEnv.AUTH_SECRET,
  trustHost: serverEnv.AUTH_TRUST_HOST,
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (user.email === null || user.email === undefined || user.email.length === 0) {
        return false;
      }

      if (account?.provider === "dev-login") {
        return true;
      }

      if (!isSupportedProvider(account?.provider)) {
        return false;
      }
      if (account.provider === "google" && profile?.email_verified !== true) {
        return false;
      }

      return true;
    },
    async jwt({ token, user, account, trigger, session }) {
      return handleJwtCallback({ token, user, account, trigger, session });
    },
    async session({ session, token }) {
      return handleSessionCallback({ session, token });
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn } = NextAuth(authConfig);
