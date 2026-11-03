import type { AuthSession } from "./types";

export function canAccessAuthenticatedRoute(input: {
  session: AuthSession | null;
  shouldAllowGuest?: boolean;
}): boolean {
  if (!input.session) {
    return false;
  }

  return input.shouldAllowGuest === true || input.session.user.source !== "guest";
}
