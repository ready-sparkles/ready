import { normalizeCallbackUrl } from "../../domain/login-callback";
import { googleAddonFlowMarkerSchema } from "../../domain/schemas/login-form-utils";

const GOOGLE_ADDON_OAUTH_HANDOFF_TOKEN_MAX_LENGTH = 4096;
const MAX_LOGIN_HINT_LENGTH = 320;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1000;
const AUTH_ENTRY_MAX_AGE_SECONDS = 3600;

function isMeetingJoinCallback(value: string): boolean {
  const path = value.split("?")[0] ?? value;

  if (path === "/meet" || path === "/meeting") {
    return true;
  }

  const isSingleRoomSegment = /^\/[A-Za-z0-9-]+$/.test(path);
  const reservedRoutes = new Set(["/", "/debug", "/login", "/meet", "/meeting", "/meetings", "/signup", "/workspace"]);

  return isSingleRoomSegment && !reservedRoutes.has(path);
}

export type AuthEntryVariant = "login" | "signup";

const GOOGLE_WORKSPACE_ADDON_AUTH_SOURCE = "google-workspace-addon";

type GoogleWorkspaceAddonSignInInput = {
  accountId: string | null;
  callbackUrl: string;
  complete: string | null;
  handoffId: string | null;
  handoffToken: string | null;
  loginHint: string | null;
  source: string | null;
};

type GoogleWorkspaceAddonSignInContext = {
  expectedAccountId: string | null;
  handoffId: string | null;
  handoffToken: string | null;
  isCompletion: boolean;
  loginHint: string | null;
  oauthCallbackUrl: string;
  retryUrl: string;
};

type BuildGoogleWorkspaceAddonLoginUrlInput = {
  accountId: string;
  callbackUrl: string;
  handoffId: string;
  handoffToken: string | null;
  isComplete: boolean;
  loginHint: string | null;
};

function normalizedGoogleAddonHandoffToken_(value: string | null) {
  const token = value?.trim() ?? "";

  return token.length <= GOOGLE_ADDON_OAUTH_HANDOFF_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ? token
    : null;
}

function buildGoogleWorkspaceAddonLoginUrl_(input: BuildGoogleWorkspaceAddonLoginUrlInput) {
  const params = new URLSearchParams({
    source: GOOGLE_WORKSPACE_ADDON_AUTH_SOURCE,
    accountId: input.accountId,
    callbackUrl: input.callbackUrl,
  });
  params.set("handoffId", input.handoffId);
  if (input.isComplete) {
    params.set("complete", "1");
  }
  if (input.loginHint !== null && input.loginHint !== "") {
    params.set("loginHint", input.loginHint);
  }
  if (input.handoffToken !== null && input.handoffToken !== "" && !input.isComplete) {
    params.set("handoffToken", input.handoffToken);
  }

  return `/login?${params.toString()}`;
}

function normalizedGoogleWorkspaceAddonLoginHint_(loginHint: string | null) {
  const normalizedLoginHint = loginHint?.trim() ?? "";

  return normalizedLoginHint.length <= MAX_LOGIN_HINT_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedLoginHint)
    ? normalizedLoginHint
    : null;
}

function normalizedGoogleWorkspaceAddonHandoffId_(handoffId: string | null) {
  const trimmedHandoffId = handoffId?.trim() ?? "";

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmedHandoffId)
    ? trimmedHandoffId.toLowerCase()
    : null;
}

export function getGoogleWorkspaceAddonSignInContext({
  accountId,
  callbackUrl,
  complete,
  handoffId,
  handoffToken,
  loginHint,
  source,
}: GoogleWorkspaceAddonSignInInput): GoogleWorkspaceAddonSignInContext | null {
  if (source !== GOOGLE_WORKSPACE_ADDON_AUTH_SOURCE) {
    return null;
  }

  const expectedAccountId = accountId?.trim() ?? "";
  const hasValidAccountId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    expectedAccountId,
  );
  const safeLoginHint = normalizedGoogleWorkspaceAddonLoginHint_(loginHint);
  const safeHandoffToken = normalizedGoogleAddonHandoffToken_(handoffToken);
  const safeHandoffId = normalizedGoogleWorkspaceAddonHandoffId_(handoffId);
  // The signed token is consumed by the server during OAuth and intentionally
  // omitted from the completion URL. The client-only completion check is
  // separately bound to the matching pre-OAuth handoff marker.
  const canVerifyAccount =
    hasValidAccountId && safeHandoffId !== null && (complete === "1" || safeHandoffToken !== null);

  return {
    expectedAccountId: canVerifyAccount ? expectedAccountId.toLowerCase() : null,
    handoffId: safeHandoffId,
    handoffToken: safeHandoffToken,
    isCompletion: complete === "1",
    loginHint: safeLoginHint,
    oauthCallbackUrl: buildGoogleWorkspaceAddonLoginUrl_({
      accountId: expectedAccountId,
      callbackUrl,
      handoffId: safeHandoffId ?? "",
      handoffToken: null,
      loginHint: safeLoginHint,
      isComplete: true,
    }),
    retryUrl: buildGoogleWorkspaceAddonLoginUrl_({
      accountId: expectedAccountId,
      callbackUrl,
      handoffId: safeHandoffId ?? "",
      handoffToken: safeHandoffToken,
      loginHint: safeLoginHint,
      isComplete: false,
    }),
  };
}

type GoogleWorkspaceAddonSessionAction = "none" | "invalid" | "complete" | "clear";

export function getGoogleWorkspaceAddonSessionAction(input: {
  authenticatedAccountId: string | null | undefined;
  expectedAccountId: string | null;
  hasVerifiedFlowState: boolean;
  isCompletion: boolean;
  sessionStatus: "authenticated" | "loading" | "unauthenticated";
}): GoogleWorkspaceAddonSessionAction {
  if (input.sessionStatus !== "authenticated") {
    return "none";
  }
  if (!input.isCompletion) {
    return "none";
  }
  if (!input.hasVerifiedFlowState) {
    return "invalid";
  }

  return input.expectedAccountId !== null &&
    input.expectedAccountId !== "" &&
    input.authenticatedAccountId === input.expectedAccountId
    ? "complete"
    : "clear";
}

export function getSignupHref(callbackUrl: string): string {
  const params = new URLSearchParams({ callbackUrl });

  return `/signup?${params.toString()}`;
}

type LoginCopy = {
  googleLabel: string;
  isJoinMeeting: boolean;
  legalPrefix: string;
  microsoftLabel: string;
  title: string;
};

export function getLoginCopy(...args: [callbackUrl: string, variant?: AuthEntryVariant]): LoginCopy {
  const [callbackUrl, variant = "login"] = args;
  const isJoinMeeting = isMeetingJoinCallback(callbackUrl);

  if (isJoinMeeting) {
    return {
      isJoinMeeting,
      title: "Join meeting",
      googleLabel: "Join with Google",
      microsoftLabel: "Join with Microsoft",
      legalPrefix: "By joining a meeting",
    };
  }

  if (variant === "signup") {
    return {
      isJoinMeeting,
      title: "Welcome to Ready",
      googleLabel: "Sign up with Google",
      microsoftLabel: "Sign up with Microsoft",
      legalPrefix: "By signing up",
    };
  }

  return {
    isJoinMeeting,
    title: "Sign in to Ready",
    googleLabel: "Continue with Google",
    microsoftLabel: "Continue with Microsoft",
    legalPrefix: "By continuing",
  };
}

// Auth errors always land on /login (the NextAuth error page), so the page
// the user started from is remembered in a short-lived cookie set when they
// click a provider button. Error recovery reads it to send signup-originated
// users back to /signup instead of /login.
const AUTH_ENTRY_COOKIE = "ready-auth-entry";
const GOOGLE_ADDON_FLOW_COOKIE_PREFIX = "ready-addon-flow-";
const GOOGLE_ADDON_FLOW_MAX_AGE_SECONDS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;

function googleAddonFlowBinding_(returnPath: string) {
  try {
    const url = new URL(returnPath, "https://ready.app");
    if (url.origin !== "https://ready.app" || url.pathname !== "/login") {
      return null;
    }
    const callbackUrl = url.searchParams.get("callbackUrl");
    if (callbackUrl === null || callbackUrl === "" || callbackUrl !== normalizeCallbackUrl(callbackUrl)) {
      return null;
    }
    const context = getGoogleWorkspaceAddonSignInContext({
      accountId: url.searchParams.get("accountId"),
      callbackUrl,
      complete: url.searchParams.get("complete"),
      handoffId: url.searchParams.get("handoffId"),
      handoffToken: url.searchParams.get("handoffToken"),
      loginHint: url.searchParams.get("loginHint"),
      source: url.searchParams.get("source"),
    });

    if (context === null) {
      return null;
    }
    if (context.expectedAccountId === null || context.expectedAccountId === "") {
      return null;
    }
    if (context.handoffId === null || context.handoffId === "") {
      return null;
    }

    return { accountId: context.expectedAccountId, callbackUrl, handoffId: context.handoffId };
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return null;
  }
}

function validatedAuthEntryReturnPath_(value: string) {
  if (value === "signup") {
    return "/signup";
  }
  if (value === "login") {
    return "/login";
  }

  try {
    const url = new URL(value, "https://ready.app");
    if (url.origin !== "https://ready.app" || url.pathname !== "/login") {
      return null;
    }
    const context = getGoogleWorkspaceAddonSignInContext({
      accountId: url.searchParams.get("accountId"),
      callbackUrl: normalizeCallbackUrl(url.searchParams.get("callbackUrl")),
      complete: url.searchParams.get("complete"),
      handoffId: url.searchParams.get("handoffId"),
      handoffToken: url.searchParams.get("handoffToken"),
      loginHint: url.searchParams.get("loginHint"),
      source: url.searchParams.get("source"),
    });

    if (context === null) {
      return null;
    }
    if (context.expectedAccountId === null || context.expectedAccountId === "") {
      return null;
    }
    if (context.isCompletion) {
      return null;
    }

    return context.retryUrl;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return null;
  }
}

function readAuthEntryReturnPath_() {
  if (typeof document === "undefined") {
    return null;
  }
  const match = new RegExp(`(?:^|;\\s*)${AUTH_ENTRY_COOKIE}=([^;]*)`).exec(document.cookie);
  if (match === null || match[1] === undefined || match[1] === "") {
    return null;
  }
  try {
    return validatedAuthEntryReturnPath_(decodeURIComponent(match[1]));
  } catch (error) {
    if (!(error instanceof URIError)) {
      throw error;
    }

    return null;
  }
}

export function hasGoogleWorkspaceAddonAuthEntry(returnPath: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const binding = googleAddonFlowBinding_(returnPath);
  if (!binding) {
    return false;
  }
  const cookieName = GOOGLE_ADDON_FLOW_COOKIE_PREFIX + binding.handoffId;
  const match = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]*)`).exec(document.cookie);
  if (match === null || match[1] === undefined || match[1] === "") {
    return false;
  }
  try {
    const parsed = googleAddonFlowMarkerSchema.safeParse(JSON.parse(decodeURIComponent(match[1])));
    if (!parsed.success) {
      return false;
    }
    const stored = parsed.data;

    return (
      stored.accountId === binding.accountId &&
      stored.callbackUrl === binding.callbackUrl &&
      Number.isFinite(stored.expiresAt) &&
      stored.expiresAt > Date.now()
    );
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof URIError)) {
      throw error;
    }

    return false;
  }
}

export function clearGoogleWorkspaceAddonAuthEntry(returnPath: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const binding = googleAddonFlowBinding_(returnPath);
  if (!binding) {
    return;
  }
  document.cookie = `${GOOGLE_ADDON_FLOW_COOKIE_PREFIX}${binding.handoffId}=; path=/; max-age=0; SameSite=Lax`;
}

export function rememberAuthEntryPoint(...args: [variant: AuthEntryVariant, returnPath?: string]): void {
  const [variant, returnPath] = args;
  if (typeof document === "undefined") {
    return;
  }
  const storedValue =
    returnPath !== undefined && returnPath !== "" ? (validatedAuthEntryReturnPath_(returnPath) ?? variant) : variant;
  document.cookie = `${AUTH_ENTRY_COOKIE}=${encodeURIComponent(storedValue)}; path=/; max-age=${AUTH_ENTRY_MAX_AGE_SECONDS}; SameSite=Lax`;
  const binding = googleAddonFlowBinding_(storedValue);
  if (binding) {
    // Another tab may clear the generic retry cookie when signOut broadcasts.
    // Bind completion independently, without copying the signed token here.
    const marker = {
      accountId: binding.accountId,
      callbackUrl: binding.callbackUrl,
      expiresAt: Date.now() + GOOGLE_ADDON_FLOW_MAX_AGE_SECONDS * MS_PER_SECOND,
    };
    document.cookie = `${GOOGLE_ADDON_FLOW_COOKIE_PREFIX}${binding.handoffId}=${encodeURIComponent(JSON.stringify(marker))}; path=/; max-age=${GOOGLE_ADDON_FLOW_MAX_AGE_SECONDS}; SameSite=Lax`;
  }
}

export function clearAuthEntryPoint(): void {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${AUTH_ENTRY_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

export function consumeAuthEntryReturnPath(): string {
  if (typeof document === "undefined") {
    return "/login";
  }
  const returnPath = readAuthEntryReturnPath_();
  clearAuthEntryPoint();

  return returnPath ?? "/login";
}

type LoginErrorCopy = {
  description: string;
  title: string;
};

function loginErrorCopyForKnownCode_(value: string): LoginErrorCopy | null {
  switch (value) {
    case "AccessDenied":
      return {
        title: "Access denied",
        description:
          "Ready could not finish sign-in because the account did not pass our sign-in checks. This usually means the provider did not share a verified email address, or the account is not allowed to use this Ready workspace yet.",
      };
    case "OAuthAccountNotLinked":
    case "AccountNotLinked":
      return {
        title: "Account already exists",
        description:
          "Ready found an existing account with this email that was created with a different sign-in method. Sign in with the original Google or Microsoft account, then connect the other provider from settings.",
      };
    case "OAuthCallbackError":
    case "OAuthSignInError":
    case "CallbackRouteError":
      return {
        title: "Sign-in could not finish",
        description:
          "The identity provider returned an error before Ready could complete authentication. This can happen if consent was cancelled, the provider session expired, or the provider response was missing required profile details.",
      };
    case "InvalidCallbackUrl":
      return {
        title: "Invalid sign-in link",
        description:
          "Ready blocked this sign-in because the return link was invalid. Start again from the Ready sign-in page so authentication can return to a trusted Ready URL.",
      };
    case "Configuration":
    case "InvalidEndpoints":
    case "MissingSecret":
      return {
        title: "Sign-in is misconfigured",
        description:
          "Ready could not start authentication because the sign-in provider is not configured correctly. This is a server-side setup issue and needs an admin to check the production auth settings.",
      };
    case "Verification":
    case "InvalidCheck":
    case "MissingCSRF":
      return {
        title: "Sign-in verification failed",
        description:
          "Ready could not verify the sign-in session. Browser cookie restrictions, an expired provider session, or a changed sign-in tab can cause this. Start sign-in again from a fresh Ready sign-in page.",
      };
    case "CredentialsSignin":
      return {
        title: "Sign-in failed",
        description: "Ready could not verify those credentials. Check the account details and try signing in again.",
      };
    default:
      return null;
  }
}

export function getLoginErrorCopy(value: string | null): LoginErrorCopy | null {
  if (value === null) {
    return null;
  }

  const knownCopy = loginErrorCopyForKnownCode_(value);
  if (knownCopy !== null) {
    return knownCopy;
  }

  return value !== ""
    ? {
        title: "Sign-in failed",
        description:
          "Ready could not complete authentication. Try signing in again, and if it keeps happening ask an admin to check the auth logs for the exact provider error.",
      }
    : null;
}
