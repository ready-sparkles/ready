"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import Ably from "../../composition/ably";
import { webEnv } from "../../composition/env";
import { ablyTokenPayloadSchema } from "../../composition/realtime-token";
import type { AuthSession } from "../../domain/types";

import { useAuth } from "./auth-provider";

const HTTP_UNAUTHORIZED_STATUS = 401;
/** "Connection <state>" matches isTransientRealtimeError, so subscribers retry quietly. */
const MESSAGE_REALTIME_CONNECTION_STATE = (state: string): string => `Connection ${state}`;
const MESSAGE_REALTIME_AUTH_REFRESH_FAILED = "[readymeet:realtime] Ably auth refresh failed.";
const MESSAGE_USE_REALTIME_CLIENT_OUTSIDE_PROVIDER = "useRealtimeClient must be used within RealtimeProvider";
const MESSAGE_MISSING_API_TOKEN = "Missing API token";
const MESSAGE_REALTIME_AUTH_FAILED = "Realtime auth failed";

type RealtimeContextValue = {
  client: Ably.Realtime | null;
  scopeKey: string;
  refreshRealtimeAuth: (reason?: string) => Promise<void>;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

async function requestRealtimeToken(apiToken: string): Promise<Response> {
  return fetch(`${webEnv.NEXT_PUBLIC_API_BASE_URL}/v1/realtime/ably-token`, {
    headers: {
      authorization: `Bearer ${apiToken}`,
    },
    cache: "no-store",
  });
}

function createAblyAuthCallback(input: {
  tokenRef: React.RefObject<string | null>;
  refreshSessionRef: React.RefObject<() => Promise<AuthSession | null>>;
}): NonNullable<Ably.ClientOptions["authCallback"]> {
  return (_tokenParams, callback) => {
    void (async () => {
      try {
        const token = input.tokenRef.current;
        if (token === null || token.length === 0) {
          callback(MESSAGE_MISSING_API_TOKEN, null);

          return;
        }

        const firstResponse = await requestRealtimeToken(token);
        const response =
          firstResponse.ok || firstResponse.status !== HTTP_UNAUTHORIZED_STATUS
            ? firstResponse
            : await (async () => {
                const nextSession = await input.refreshSessionRef.current();
                const nextToken = nextSession?.token ?? null;
                if (nextToken === null || nextToken.length === 0) {
                  return firstResponse;
                }

                return requestRealtimeToken(nextToken);
              })();

        if (!response.ok) {
          callback(`${MESSAGE_REALTIME_AUTH_FAILED} (${response.status})`, null);

          return;
        }
        const tokenPayload = ablyTokenPayloadSchema.parse(await response.json());
        callback(null, tokenPayload);
      } catch (error) {
        callback(error instanceof Error ? error.message : MESSAGE_REALTIME_AUTH_FAILED, null);
      }
    })();
  };
}

async function waitForRealtimeConnected(realtime: Ably.Realtime): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onStateChange = (change: Ably.ConnectionStateChange) => {
      if (change.current === "connected") {
        realtime.connection.off(onStateChange);
        resolve();
      } else if (change.current === "failed" || change.current === "suspended" || change.current === "closed") {
        realtime.connection.off(onStateChange);
        reject(new Error(MESSAGE_REALTIME_CONNECTION_STATE(change.current), { cause: change.reason }));
      }
    };
    realtime.connection.on(onStateChange);
  });
}

function teardownRealtimeClient(realtime: Ably.Realtime): void {
  Object.values(realtime.channels.all).forEach((channel) => {
    try {
      channel.unsubscribe();
    } catch (error) {
      if (error instanceof Error) {
        // Best-effort cleanup. The scoped client is closing.
      }
    }
  });
  try {
    realtime.close();
  } catch (error) {
    if (error instanceof Error) {
      // `close()` is valid during teardown; pending auth/attach work can already be closing.
    }
  }
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { refreshSession, session } = useAuth();

  return (
    <RealtimeClientProvider refreshSession={refreshSession} session={session}>
      {children}
    </RealtimeClientProvider>
  );
}

/**
 * Session-driven owner of the app's single Ably connection. Exported
 * separately from RealtimeProvider (which binds it to useAuth) so tests can
 * drive session changes and inject a client factory.
 */
export function RealtimeClientProvider({
  children,
  createClient = (options) => new Ably.Realtime(options),
  refreshSession,
  session,
}: {
  children: React.ReactNode;
  createClient?: (options: Ably.ClientOptions) => Ably.Realtime;
  refreshSession: () => Promise<AuthSession | null>;
  session: AuthSession | null;
}) {
  const tokenRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    tokenRef.current = session?.token ?? null;
  });
  // Read through refs so the client-creation effect never depends on callback
  // or session identity: recreating the Ably client means closing and
  // reopening the websocket, which must only happen when the user or
  // workspace actually changes.
  const refreshSessionRef = useRef(refreshSession);
  useLayoutEffect(() => {
    refreshSessionRef.current = refreshSession;
  });
  const createClientRef = useRef(createClient);
  useLayoutEffect(() => {
    createClientRef.current = createClient;
  });
  const userId = session?.user.id ?? null;
  const workspaceId = session?.user.workspaceId ?? null;
  const scopeKey = `${userId ?? "anonymous"}:${workspaceId ?? "none"}`;
  const [client, setClient] = useState<Ably.Realtime | null>(null);
  const clientRef = useRef<Ably.Realtime | null>(null);

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  const refreshRealtimeAuth = useCallback(async (reason = "manual") => {
    const realtime = clientRef.current;
    if (realtime === null) {
      return;
    }

    // The initial connect already fetches a fresh token. Calling authorize() while it is
    // connecting makes Ably abort that socket and reconnect ("WebSocket is closed before
    // the connection is established"), so wait for the connection instead.
    const connectionState = realtime.connection.state;
    if (connectionState === "initialized" || connectionState === "connecting") {
      await waitForRealtimeConnected(realtime);

      return;
    }

    try {
      await realtime.auth.authorize();
    } catch (error) {
      // A closed/closing client (teardown, API reload) rejects authorize(); Ably
      // re-authenticates on reconnect, so only unexpected failures are errors.
      if (realtime.connection.state !== "closed" && realtime.connection.state !== "closing") {
        console.error(MESSAGE_REALTIME_AUTH_REFRESH_FAILED, {
          reason,
          error,
        });
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    if (userId === null || workspaceId === null) {
      setClient(null);

      return;
    }

    const realtime = createClientRef.current({
      clientId: userId,
      authCallback: createAblyAuthCallback({ tokenRef, refreshSessionRef }),
      // Connect after mount settles: a StrictMode/dev double-mount tears the first
      // client down before it opens a socket ("WebSocket is closed before ...").
      autoConnect: false,
    });
    const connectTimer = setTimeout(() => {
      realtime.connect();
    }, 0);

    setClient(realtime);

    return () => {
      clearTimeout(connectTimer);
      setClient((current) => (current === realtime ? null : current));
      teardownRealtimeClient(realtime);
    };
  }, [userId, workspaceId]);

  const value = useMemo(() => ({ client, refreshRealtimeAuth, scopeKey }), [client, refreshRealtimeAuth, scopeKey]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeClient() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error(MESSAGE_USE_REALTIME_CLIENT_OUTSIDE_PROVIDER);
  }

  return context;
}
