export const GOOGLE_ADDON_OAUTH_HANDOFF_COOKIE = "ready-addon-oauth-handoff";
const GOOGLE_ADDON_OAUTH_HANDOFF_MAX_AGE_MINUTES = 60;
const SECONDS_PER_MINUTE = 60;
export const GOOGLE_ADDON_OAUTH_HANDOFF_MAX_AGE_SECONDS =
  GOOGLE_ADDON_OAUTH_HANDOFF_MAX_AGE_MINUTES * SECONDS_PER_MINUTE;
const GOOGLE_ADDON_OAUTH_HANDOFF_TOKEN_MAX_LENGTH = 4096;

export function parseGoogleAddonOAuthHandoffToken(value: string | null | undefined): string | null {
  const token = value?.trim() ?? "";

  return token.length <= GOOGLE_ADDON_OAUTH_HANDOFF_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ? token
    : null;
}

// Opening the web app verifies identity only. Calendar synchronization is an
// independent, explicit Connect action, never a side effect of add-on sign-in.
export function googleAddonAuthorizationParams(handoffToken: string | null): Record<string, string> {
  return handoffToken !== null && handoffToken !== ""
    ? { scope: "openid email profile", access_type: "online", include_granted_scopes: "false" }
    : {};
}
