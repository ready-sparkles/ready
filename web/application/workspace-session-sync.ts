import type { AuthSession } from "../domain/types";

import { getCurrentAuthSession } from "./api";

/** @external existing auth provider callback contract */
interface UpdateCachedUser {
  (input: { user: AuthSession["user"]; options?: { token?: string } }): Promise<AuthSession | null>;
}

type RefreshSession = () => Promise<AuthSession | null>;

export async function syncActiveWorkspaceSession(input: {
  token: string;
  workspaceId: string;
  refreshSession: RefreshSession;
  updateCachedUser: UpdateCachedUser;
}): Promise<AuthSession | null> {
  try {
    const currentSession = await getCurrentAuthSession(input.token);
    if (currentSession.user.workspaceId === input.workspaceId) {
      const nextSession = await input.updateCachedUser({
        user: currentSession.user,
        options: { token: currentSession.token },
      });
      if (nextSession?.user.workspaceId === input.workspaceId && nextSession.token === currentSession.token) {
        return nextSession;
      }
    }
  } catch (error: unknown) {
    void error;
    // Fall back to a server-side NextAuth refresh below.
  }

  try {
    const refreshedSession = await input.refreshSession();

    return refreshedSession?.user.workspaceId === input.workspaceId ? refreshedSession : null;
  } catch (error: unknown) {
    void error;

    return null;
  }
}
