/** Login URL that returns the user to where they were after a revoked session is signed out. */
export function staleSessionLoginUrl(location: { pathname: string; search: string }): string {
  const current = `${location.pathname}${location.search}`;
  if (current === "" || current === "/" || location.pathname.startsWith("/login")) {
    return "/login";
  }

  return `/login?callbackUrl=${encodeURIComponent(current)}`;
}

/** Only the token this tab currently holds counts as stale; late 401s for an older token are ignored. */
export function isCurrentSessionToken(input: {
  rejectedToken: string;
  sessionToken: string | null | undefined;
}): boolean {
  return input.sessionToken !== null && input.sessionToken !== undefined && input.sessionToken === input.rejectedToken;
}
