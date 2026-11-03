"use client";

import type { MeetingJoinRequestStatus } from "@readymeet/shared";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { onInvalidApiToken } from "../../composition/api";
import { signOut, useSession } from "../../composition/next-auth-react";
import { rememberAuthProvider } from "../../composition/remembered-auth-provider";
import { useSuspendedWorkspaceRecovery } from "../../composition/use-suspended-workspace-recovery";
import { useVerifiedAuthSession } from "../../composition/use-verified-auth-session";
import { storedGuestSessionSchema } from "../../domain/schemas/auth-provider";
import { isCurrentSessionToken, staleSessionLoginUrl } from "../../domain/stale-session-redirect";
import type { AuthSession } from "../../domain/types";

const GUEST_AUTH_STORAGE_KEY = "readymeet-guest-session";

const MESSAGE_USE_AUTH_OUTSIDE_PROVIDER = "useAuth must be used within AuthProvider";

export type StoredGuestSession = AuthSession & {
  expiresAt: string;
  joinRequestId?: string;
  meetingId?: string | null;
  meetingLinkCode?: string;
  status?: MeetingJoinRequestStatus;
};

type AuthContextValue = {
  session: AuthSession | null;
  guestSession: StoredGuestSession | null;
  isLoading: boolean;
  refreshSession: () => Promise<AuthSession | null>;
  setGuestSession: (session: StoredGuestSession) => void;
  clearGuestSession: () => void;
  updateCachedUser: (input: { user: AuthSession["user"]; options?: { token?: string } }) => Promise<AuthSession | null>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredGuestSession(): StoredGuestSession | null {
  try {
    const raw = window.localStorage.getItem(GUEST_AUTH_STORAGE_KEY);
    if (raw === null || raw === "") {
      return null;
    }
    const parsed = storedGuestSessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) {
      window.localStorage.removeItem(GUEST_AUTH_STORAGE_KEY);

      return null;
    }

    return {
      token: parsed.data.token,
      expiresAt: parsed.data.expiresAt,
      joinRequestId: parsed.data.joinRequestId,
      meetingId: parsed.data.meetingId,
      meetingLinkCode: parsed.data.meetingLinkCode,
      status: parsed.data.status,
      user: parsed.data.user,
    };
  } catch (error: unknown) {
    if (error instanceof Error) {
      window.localStorage.removeItem(GUEST_AUTH_STORAGE_KEY);
    }

    return null;
  }
}

function useAuthSessionMutations(input: {
  stableFullSession: AuthSession | null;
  guestSession: StoredGuestSession | null;
  update: ReturnType<typeof useSession>["update"];
  setGuestSession: (session: StoredGuestSession) => void;
}) {
  const sessionStateRef = useRef({
    fullSession: input.stableFullSession,
    guestSession: input.guestSession,
    update: input.update,
  });
  useLayoutEffect(() => {
    sessionStateRef.current = {
      fullSession: input.stableFullSession,
      guestSession: input.guestSession,
      update: input.update,
    };
  });

  const refreshSession = useCallback(async (): Promise<AuthSession | null> => {
    const {
      fullSession: cachedFullSession,
      guestSession: cachedGuestSession,
      update: refresh,
    } = sessionStateRef.current;
    if (cachedFullSession === null && cachedGuestSession !== null) {
      return cachedGuestSession;
    }

    const nextData = await refresh({
      /** @external existing wire contract */
      refreshApiToken: true,
    });
    if (
      typeof nextData?.apiToken !== "string" ||
      nextData.appUser === undefined ||
      nextData.authError !== undefined ||
      (nextData.apiRefreshRetryAt ?? 0) > Date.now()
    ) {
      return null;
    }

    return {
      token: nextData.apiToken,
      user: nextData.appUser,
    };
  }, []);

  const updateCachedUser = useCallback(
    async (updateInput: { user: AuthSession["user"]; options?: { token?: string } }): Promise<AuthSession | null> => {
      const {
        fullSession: cachedFullSession,
        guestSession: cachedGuestSession,
        update: refresh,
      } = sessionStateRef.current;
      if (cachedFullSession === null && cachedGuestSession !== null) {
        const nextGuestSession = {
          ...cachedGuestSession,
          ...(updateInput.options?.token !== undefined ? { token: updateInput.options.token } : {}),
          user: updateInput.user,
        };
        input.setGuestSession(nextGuestSession);

        return nextGuestSession;
      }

      const nextData = await refresh({ appUser: updateInput.user, apiToken: updateInput.options?.token });
      if (
        typeof nextData?.apiToken !== "string" ||
        nextData.appUser === undefined ||
        nextData.authError !== undefined
      ) {
        return null;
      }

      return {
        token: nextData.apiToken,
        user: nextData.appUser,
      };
    },
    [input.setGuestSession],
  );

  return { refreshSession, updateCachedUser };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data, status, update } = useSession();
  const [guestSession, setGuestSessionState] = useState<StoredGuestSession | null>(null);
  const [hasLoadedGuestSession, setHasLoadedGuestSession] = useState(false);

  useEffect(() => {
    setGuestSessionState(readStoredGuestSession());
    setHasLoadedGuestSession(true);
  }, []);

  const fullSession = useMemo<AuthSession | null>(() => {
    if (typeof data?.apiToken !== "string" || data.appUser === undefined || data.authError !== undefined) {
      return null;
    }

    return {
      token: data.apiToken,
      user: data.appUser,
    };
  }, [data]);

  useEffect(() => {
    if (fullSession !== null) {
      rememberAuthProvider(fullSession.user.authProvider);
    }
  }, [fullSession]);
  const { session: stableFullSession, clearForSignOut } = useVerifiedAuthSession({
    currentSession: fullSession,
    status,
  });

  const session = stableFullSession ?? guestSession;

  const setGuestSession = useCallback((nextSession: StoredGuestSession) => {
    window.localStorage.setItem(GUEST_AUTH_STORAGE_KEY, JSON.stringify(nextSession));
    setGuestSessionState(nextSession);
  }, []);

  const clearGuestSession = useCallback(() => {
    window.localStorage.removeItem(GUEST_AUTH_STORAGE_KEY);
    setGuestSessionState(null);
  }, []);

  const logout = useCallback(async () => {
    clearForSignOut();
    clearGuestSession();
    await signOut({ callbackUrl: "/login" });
  }, [clearForSignOut, clearGuestSession]);

  // A token revoked elsewhere ("Log out of all devices") signs this stale tab out
  // and returns to the current page after login, instead of surfacing 401 errors.
  const staleSignOutRef = useRef(false);
  const fullSessionToken = stableFullSession?.token ?? null;
  useEffect(
    () =>
      onInvalidApiToken((rejectedToken) => {
        if (staleSignOutRef.current || !isCurrentSessionToken({ rejectedToken, sessionToken: fullSessionToken })) {
          return;
        }
        staleSignOutRef.current = true;
        clearForSignOut();
        void signOut({ callbackUrl: staleSessionLoginUrl(window.location) });
      }),
    [clearForSignOut, fullSessionToken],
  );

  const { refreshSession, updateCachedUser } = useAuthSessionMutations({
    stableFullSession,
    guestSession,
    update,
    setGuestSession,
  });
  useSuspendedWorkspaceRecovery({ session: stableFullSession, refreshSession });

  const value = useMemo(
    () => ({
      session,
      guestSession,
      isLoading: status === "loading" || !hasLoadedGuestSession,
      refreshSession,
      setGuestSession,
      clearGuestSession,
      updateCachedUser,
      logout,
    }),
    [
      clearGuestSession,
      guestSession,
      hasLoadedGuestSession,
      logout,
      refreshSession,
      session,
      setGuestSession,
      status,
      updateCachedUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** A fixed signed-in session with no NextAuth, guest storage, or sign-out side effects. */
export function StaticAuthProvider({ session, children }: { session: AuthSession; children: React.ReactNode }) {
  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      guestSession: null,
      isLoading: false,
      refreshSession: async () => session,
      setGuestSession: () => {},
      clearGuestSession: () => {},
      updateCachedUser: async () => session,
      logout: async () => {},
    }),
    [session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error(MESSAGE_USE_AUTH_OUTSIDE_PROVIDER);
  }

  return context;
}
