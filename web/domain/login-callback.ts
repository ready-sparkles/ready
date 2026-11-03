export const DEFAULT_LOGIN_CALLBACK_URL = "/workspace?view=upcoming";

// Any origin works here: it only checks that the callback resolves to the same origin.
const CALLBACK_BASE_ORIGIN = "https://callback.invalid";

function parseSameOriginCallback(value: string): URL | null {
  try {
    const url = new URL(value, CALLBACK_BASE_ORIGIN);

    return url.origin === CALLBACK_BASE_ORIGIN ? url : null;
  } catch (error) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

/**
 * Only ever return the path the URL parser produced, never the raw input. Browsers
 * read "\" as "/" and drop tabs and newlines, so redirecting to the raw string can
 * leave the site even when a check on that string passed.
 *
 * Removing "." and ".." can leave a path that starts with "//"
 * (`/a/..//evil.example`). That string is another site when used as a redirect.
 */
export function normalizeCallbackUrl(value: string | null): string {
  if (value === null || !value.startsWith("/")) {
    return DEFAULT_LOGIN_CALLBACK_URL;
  }

  const url = parseSameOriginCallback(value);
  if (url === null || url.pathname === "/login" || url.pathname === "/signup" || url.pathname.startsWith("//")) {
    return DEFAULT_LOGIN_CALLBACK_URL;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

/** Scope the provider account chooser to the Outlook dialog flow. */
export function isOutlookAddonCallback(callbackUrl: string): boolean {
  return callbackUrl.startsWith("/outlook/dialog.html#");
}
