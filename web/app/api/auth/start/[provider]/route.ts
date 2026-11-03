import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

import { signIn } from "../../../../../auth";
import {
  GOOGLE_ADDON_OAUTH_HANDOFF_COOKIE,
  GOOGLE_ADDON_OAUTH_HANDOFF_MAX_AGE_SECONDS,
  googleAddonAuthorizationParams,
  parseGoogleAddonOAuthHandoffToken,
} from "../../../../../domain/google-addon-oauth-handoff";
import { isOutlookAddonCallback, normalizeCallbackUrl } from "../../../../../domain/login-callback";

const MAX_LOGIN_HINT_LENGTH = 320;

type OAuthProvider = "google" | "microsoft-entra-id";

type RouteContext = {
  params: Promise<{
    provider?: string;
  }>;
};

function isOAuthProvider(value: string | undefined): value is OAuthProvider {
  return value === "google" || value === "microsoft-entra-id";
}

function isLocalDevLogin(value: string | undefined): boolean {
  return value === "dev-login" && process.env.NODE_ENV !== "production";
}

export async function GET(request: NextRequest, { params }: RouteContext): Promise<Awaited<ReturnType<typeof signIn>>> {
  const { provider } = await params;

  if (isLocalDevLogin(provider)) {
    // Credentials providers cannot start from a GET to Auth.js; sign in server-side instead.
    return signIn("dev-login", { redirectTo: normalizeCallbackUrl(request.nextUrl.searchParams.get("callbackUrl")) });
  }

  if (!isOAuthProvider(provider)) {
    return NextResponse.redirect(new URL("/login?error=Configuration", request.url));
  }

  const callbackUrl = normalizeCallbackUrl(request.nextUrl.searchParams.get("callbackUrl"));
  const cookieStore = await cookies();
  const googleAddonHandoffToken =
    provider === "google"
      ? parseGoogleAddonOAuthHandoffToken(request.nextUrl.searchParams.get("googleAddonHandoffToken"))
      : null;
  if (googleAddonHandoffToken !== null) {
    cookieStore.set(GOOGLE_ADDON_OAUTH_HANDOFF_COOKIE, googleAddonHandoffToken, {
      httpOnly: true,
      maxAge: GOOGLE_ADDON_OAUTH_HANDOFF_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  } else {
    cookieStore.delete(GOOGLE_ADDON_OAUTH_HANDOFF_COOKIE);
  }
  const authorizationParams: Record<string, string> = googleAddonAuthorizationParams(googleAddonHandoffToken);
  if (
    isOutlookAddonCallback(callbackUrl) ||
    (provider === "google" && request.nextUrl.searchParams.get("prompt") === "select_account")
  ) {
    authorizationParams.prompt = "select_account";
  }
  const loginHint = request.nextUrl.searchParams.get("loginHint")?.trim();
  if (
    provider === "google" &&
    loginHint !== undefined &&
    loginHint !== "" &&
    loginHint.length <= MAX_LOGIN_HINT_LENGTH &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginHint)
  ) {
    authorizationParams.login_hint = loginHint;
  }

  return signIn(
    provider,
    { redirectTo: callbackUrl },
    Object.keys(authorizationParams).length !== 0 ? authorizationParams : undefined,
  );
}
