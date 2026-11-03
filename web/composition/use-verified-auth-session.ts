"use client";

import { userSchema } from "@readymeet/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import type { AuthSessionStatus } from "../domain/auth-session-continuity";
import type { AuthSession } from "../domain/types";

const SESSION_VERIFY_TIMEOUT_MS = 5_000;
const SESSION_VERIFY_RETRY_COOLDOWN_MS = 30_000;
const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_FORBIDDEN_STATUS = 403;
const AUTH_MISSING_APP_AUTH_ERROR = "missing_app_auth";

const VERIFIED_AUTH_SESSION_MESSAGES = {
  sessionVerificationUnavailable: "Session verification temporarily unavailable.",
  invalidSessionResponse: "Invalid session response.",
  invalidSessionToken: "Invalid session token.",
} as const;

const browserSessionResponseSchema = z.union([
  z.null(),
  z.object({
    apiToken: z.string().min(1).optional(),
    appUser: userSchema.optional(),
    authError: z.string().optional(),
  }),
]);

/** Unlike NextAuth's client fetch helper, transport failures are not returned as sign-out. */
export async function verifyBrowserSession(signal: AbortSignal): Promise<AuthSession | null> {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(SESSION_VERIFY_TIMEOUT_MS)]),
  });
  if (response.status === HTTP_UNAUTHORIZED_STATUS || response.status === HTTP_FORBIDDEN_STATUS) {
    return null;
  }
  if (!response.ok) {
    throw new Error(VERIFIED_AUTH_SESSION_MESSAGES.sessionVerificationUnavailable);
  }
  const parsed = browserSessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(VERIFIED_AUTH_SESSION_MESSAGES.invalidSessionResponse);
  }
  if (parsed.data === null) {
    return null;
  }
  const data = parsed.data;
  if (Object.keys(data).length === 0 || data.authError === AUTH_MISSING_APP_AUTH_ERROR) {
    return null;
  }
  if (data.apiToken === undefined || data.apiToken === "") {
    throw new Error(VERIFIED_AUTH_SESSION_MESSAGES.invalidSessionToken);
  }
  if (data.appUser === undefined) {
    throw new Error(VERIFIED_AUTH_SESSION_MESSAGES.invalidSessionResponse);
  }

  return { token: data.apiToken, user: data.appUser };
}

type VerifiedAuthSessionResult = {
  session: AuthSession | null;
  clearForSignOut: () => void;
};

export function useVerifiedAuthSession(input: {
  currentSession: AuthSession | null;
  status: AuthSessionStatus;
  verify?: typeof verifyBrowserSession;
}): VerifiedAuthSessionResult {
  const { currentSession, status, verify = verifyBrowserSession } = input;
  const previousSession = useRef<AuthSession | null>(currentSession);
  const lastVerificationAttempt = useRef<{ source: AuthSession; at: number } | null>(null);
  const [isExplicitSignOut, setIsExplicitSignOut] = useState(false);
  const [verification, setVerification] = useState<{ source: AuthSession; result: AuthSession | null } | null>(null);

  useEffect(() => {
    if (currentSession !== null && !isExplicitSignOut) {
      previousSession.current = currentSession;
      setVerification(null);
    } else if (isExplicitSignOut && status === "unauthenticated") {
      previousSession.current = null;
      setVerification(null);
      setIsExplicitSignOut(false);
    }
  }, [currentSession, isExplicitSignOut, status]);

  useEffect(() => {
    const source = previousSession.current;
    if (currentSession !== null || source === null || isExplicitSignOut || status === "loading") {
      return;
    }
    if (verification?.source === source && verification.result === null) {
      return;
    }
    const controller = new AbortController();
    const lifecycle = {
      isDisposed: false,
      isInFlight: false,
      hasConfirmedSignedOut: false,
    };
    const check = async (): Promise<void> => {
      const lastAttempt = lastVerificationAttempt.current;
      if (
        controller.signal.aborted ||
        lifecycle.isInFlight ||
        lifecycle.hasConfirmedSignedOut ||
        (lastAttempt?.source === source && Date.now() - lastAttempt.at < SESSION_VERIFY_RETRY_COOLDOWN_MS)
      ) {
        return;
      }
      lifecycle.isInFlight = true;
      lastVerificationAttempt.current = { source, at: Date.now() };
      try {
        const result = await verify(controller.signal);
        if (!lifecycle.isDisposed) {
          lifecycle.hasConfirmedSignedOut = result === null;
          setVerification({ source, result });
        }
      } catch (error) {
        if (error instanceof Error) {
          // Keep the last verified identity, not new permissions. API requests
          // still use the original token and are authorized by the server.
          // Retry only on focus/online, with a cooldown; never poll indefinitely.
        }
      } finally {
        lifecycle.isInFlight = false;
      }
    };
    const onRecovery = (): void => {
      void check();
    };
    void check();
    window.addEventListener("focus", onRecovery);
    window.addEventListener("online", onRecovery);

    return () => {
      lifecycle.isDisposed = true;
      controller.abort();
      window.removeEventListener("focus", onRecovery);
      window.removeEventListener("online", onRecovery);
    };
  }, [currentSession, isExplicitSignOut, status, verification, verify]);

  const clearForSignOut = useCallback((): void => {
    previousSession.current = null;
    lastVerificationAttempt.current = null;
    setVerification(null);
    setIsExplicitSignOut(true);
  }, []);

  const session = isExplicitSignOut
    ? null
    : (currentSession ??
      (verification?.source === previousSession.current ? (verification.result ?? null) : previousSession.current));

  return { session, clearForSignOut };
}
