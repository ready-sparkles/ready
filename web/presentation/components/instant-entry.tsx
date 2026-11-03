"use client";

import type { Meeting } from "@readymeet/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type JSX, type RefObject, useEffect, useRef, useState } from "react";

import {
  ApiError,
  getApiErrorCode,
  getApiErrorMessage,
  getPrivateBetaWaitlistEntry,
  joinPrivateBetaWaitlist,
  listMeetings,
} from "../../composition/api";
import { signOut } from "../../composition/next-auth-react";
import { getMeetingPublicCode, getMeetingPublicPath } from "../../domain/meeting-links";
import type { AuthSession } from "../../domain/types";
import { beginInstantMeetingLaunch, cancelMeetingLaunchMedia, clearInstantMeetingLaunch } from "../lib/meeting-launch";

import { useAuth } from "./auth-provider";
import { PrivateBetaApplicationModal } from "./private-beta-application-modal";
import { WorkspaceShell } from "./workspace-shell";

const ACTIVE_MEETING_KEY = "readymeet-active-meeting-id";

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_CONFLICT = 409;

const INSTANT_ENTRY_PAST_MEETINGS_TITLE = "Past meetings";
const INSTANT_ENTRY_PAST_MEETINGS_SUBTITLE = "All completed meetings in one place.";
const INSTANT_ENTRY_NO_PAST_MEETINGS_TITLE = "No past meetings yet";
const INSTANT_ENTRY_NO_PAST_MEETINGS_DETAIL = "Your completed meetings will show up here after they end.";
const INSTANT_ENTRY_COULD_NOT_START_MEETING = "Could not start the meeting.";
const INSTANT_ENTRY_MEETING_ENDED_LABEL = "Ended";

function ignoreCaughtFailure(error: unknown) {
  if (error instanceof Error || typeof error === "string" || (typeof error === "object" && error !== null)) {
    return;
  }
  throw error;
}

function formatPastMeetingEndedLabel(input: { endedAt: string | null | undefined }): { label: string } {
  const { endedAt } = input;
  const hasEndedAt = endedAt !== null && endedAt !== undefined && endedAt !== "";

  if (!hasEndedAt) {
    return { label: INSTANT_ENTRY_MEETING_ENDED_LABEL };
  }

  return {
    label: new Date(endedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  };
}

async function recoverInstantEntryLaunchFailure(input: {
  nextError: unknown;
  didRefreshAuth: RefObject<boolean>;
  didStart: RefObject<boolean>;
  refreshSession: () => Promise<AuthSession | null>;
  router: ReturnType<typeof useRouter>;
  setError: (value: string | null) => void;
  setRefreshedSession: (value: AuthSession | null) => void;
  setRetryCount: (update: (current: number) => number) => void;
}) {
  const { nextError, didRefreshAuth, didStart, refreshSession, router, setError, setRefreshedSession, setRetryCount } =
    input;

  clearInstantMeetingLaunch();
  if (nextError instanceof ApiError && nextError.status === HTTP_STATUS_UNAUTHORIZED && !didRefreshAuth.current) {
    didRefreshAuth.current = true;
    try {
      const nextSession = await refreshSession();
      if (nextSession) {
        setRefreshedSession(nextSession);
        didStart.current = false;
        setRetryCount((current) => current + 1);

        return;
      }

      void signOut({ callbackUrl: "/login?callbackUrl=%2Fmeet" });
    } catch (refreshError) {
      ignoreCaughtFailure(refreshError);
      void signOut({ callbackUrl: "/login?callbackUrl=%2Fmeet" });
    }

    return;
  }

  if (nextError instanceof ApiError && nextError.status === HTTP_STATUS_UNAUTHORIZED) {
    void signOut({ callbackUrl: "/login?callbackUrl=%2Fmeet" });

    return;
  }

  if (
    nextError instanceof ApiError &&
    nextError.status === HTTP_STATUS_CONFLICT &&
    getApiErrorCode(nextError) === "agent_intro_not_available"
  ) {
    cancelMeetingLaunchMedia();
    window.localStorage.removeItem(ACTIVE_MEETING_KEY);
    router.replace("/workspace?view=upcoming");

    return;
  }

  cancelMeetingLaunchMedia();
  didStart.current = false;
  setError(nextError instanceof Error ? nextError.message : "Failed to start meeting");
}

async function handleInstantEntryWaitlistJoin(input: {
  refreshedSession: AuthSession | null;
  session: AuthSession | null | undefined;
  isJoiningWaitlist: boolean;
  setIsJoiningWaitlist: (value: boolean) => void;
  setWaitlistError: (value: string | null) => void;
  setIsWaitlistJoined: (value: boolean) => void;
}) {
  const activeSession = input.refreshedSession ?? input.session;
  if (!activeSession || input.isJoiningWaitlist) {
    return;
  }

  input.setIsJoiningWaitlist(true);
  input.setWaitlistError(null);
  try {
    await joinPrivateBetaWaitlist(activeSession.token);
    input.setIsWaitlistJoined(true);
  } catch (joinError) {
    input.setWaitlistError(
      getApiErrorMessage({
        error: joinError,
        fallback: "Could not join the waitlist. Please try again.",
      }),
    );
  } finally {
    input.setIsJoiningWaitlist(false);
  }
}

async function runInstantEntryRequestAccessFlow(input: {
  activeSession: AuthSession;
  setWaitlistError: (value: string | null) => void;
  setIsJoiningWaitlist: (value: boolean) => void;
  setIsWaitlistJoined: (value: boolean) => void;
  setWorkspaceMeetings: (value: Meeting[]) => void;
  setIsPrivateBetaApplicationShown: (value: boolean) => void;
}) {
  const {
    activeSession,
    setWaitlistError,
    setIsJoiningWaitlist,
    setIsWaitlistJoined,
    setWorkspaceMeetings,
    setIsPrivateBetaApplicationShown,
  } = input;

  setWaitlistError(null);
  setIsJoiningWaitlist(true);
  const meetingsPromise = (async (): Promise<Meeting[]> => {
    try {
      return await listMeetings(activeSession.token);
    } catch (listError) {
      ignoreCaughtFailure(listError);

      return [];
    }
  })();
  try {
    await joinPrivateBetaWaitlist(activeSession.token);
    setIsWaitlistJoined(true);
  } catch (joinError) {
    const existingEntry = await (async () => {
      try {
        return await getPrivateBetaWaitlistEntry(activeSession.token);
      } catch (entryError) {
        ignoreCaughtFailure(entryError);

        return null;
      }
    })();
    setIsWaitlistJoined(Boolean(existingEntry));
    if (!existingEntry) {
      setWaitlistError(
        getApiErrorMessage({
          error: joinError,
          fallback: "Could not join the waitlist. Please try again.",
        }),
      );
    }
  } finally {
    setWorkspaceMeetings(await meetingsPromise);
    setIsJoiningWaitlist(false);
    setIsPrivateBetaApplicationShown(true);
  }
}

async function runInstantEntryMountEffect(input: {
  isLoading: boolean;
  didStart: RefObject<boolean>;
  refreshedSession: AuthSession | null;
  session: AuthSession | null | undefined;
  shouldRequestAccess: boolean;
  launchIntent: "agent_intro" | "standard";
  router: ReturnType<typeof useRouter>;
  setError: (value: string | null) => void;
  setWaitlistError: (value: string | null) => void;
  setIsJoiningWaitlist: (value: boolean) => void;
  setIsWaitlistJoined: (value: boolean) => void;
  setWorkspaceMeetings: (value: Meeting[]) => void;
  setIsPrivateBetaApplicationShown: (value: boolean) => void;
  updateCachedUser: (input: { user: AuthSession["user"] }) => Promise<unknown>;
  recoverLaunchFailure: (nextError: unknown) => Promise<void>;
}) {
  const {
    isLoading,
    didStart,
    refreshedSession,
    session,
    shouldRequestAccess,
    launchIntent,
    router,
    setError,
    setWaitlistError,
    setIsJoiningWaitlist,
    setIsWaitlistJoined,
    setWorkspaceMeetings,
    setIsPrivateBetaApplicationShown,
    updateCachedUser,
    recoverLaunchFailure,
  } = input;

  if (isLoading || didStart.current) {
    return;
  }

  const activeSession = refreshedSession ?? session;

  if (!activeSession) {
    const callbackUrl = shouldRequestAccess
      ? "%2Fmeet%3FrequestAccess%3D1"
      : launchIntent === "agent_intro"
        ? "%2Fmeet%3Fintent%3Dagent_intro"
        : "%2Fmeet";
    router.replace(`/login?callbackUrl=${callbackUrl}`);

    return;
  }

  didStart.current = true;
  setError(null);

  try {
    if (shouldRequestAccess) {
      await runInstantEntryRequestAccessFlow({
        activeSession,
        setWaitlistError,
        setIsJoiningWaitlist,
        setIsWaitlistJoined,
        setWorkspaceMeetings,
        setIsPrivateBetaApplicationShown,
      });

      return;
    }

    const existingMeetingId = launchIntent === "agent_intro" ? null : window.localStorage.getItem(ACTIVE_MEETING_KEY);
    const handoff = await beginInstantMeetingLaunch({
      token: activeSession.token,
      existingMeetingId,
      intent: launchIntent,
    });
    if (handoff.user) {
      await updateCachedUser({ user: handoff.user });
    }
    if (launchIntent === "agent_intro") {
      window.localStorage.removeItem(ACTIVE_MEETING_KEY);
    } else {
      window.localStorage.setItem(ACTIVE_MEETING_KEY, handoff.meeting.id);
    }
    router.replace(getMeetingPublicPath(handoff.meeting));
  } catch (nextError) {
    await recoverLaunchFailure(nextError);
  }
}

function buildInstantEntryPrivateBetaView(input: {
  workspaceMeetings: Meeting[];
  waitlistError: string | null;
  isWaitlistJoined: boolean;
  isJoiningWaitlist: boolean;
  onJoinWaitlist: () => void;
  onClose: () => void;
}): { content: JSX.Element } {
  const { workspaceMeetings, waitlistError, isWaitlistJoined, isJoiningWaitlist, onJoinWaitlist, onClose } = input;
  const pastMeetings = workspaceMeetings.filter((meeting) => meeting.status === "ended");

  const content = (
    <WorkspaceShell meetings={workspaceMeetings} activeSidebarView="past">
      <section className="meeting-page">
        <section className="workspace-collection-shell">
          <header className="meeting-header">
            <div>
              <h2>{INSTANT_ENTRY_PAST_MEETINGS_TITLE}</h2>
              <p className="muted">{INSTANT_ENTRY_PAST_MEETINGS_SUBTITLE}</p>
            </div>
          </header>

          <div className="workspace-meeting-collection">
            {pastMeetings.map((meeting) => {
              const endedLabel = formatPastMeetingEndedLabel({ endedAt: meeting.endedAt });

              return (
                <Link key={meeting.id} href={`/workspace/${meeting.id}`} className="workspace-meeting-card">
                  <div className="workspace-meeting-card-copy">
                    <strong>{meeting.title}</strong>
                    <span>{getMeetingPublicCode(meeting)}</span>
                  </div>
                  <small>{endedLabel.label}</small>
                </Link>
              );
            })}

            {pastMeetings.length === 0 ? (
              <article className="workspace-placeholder-card">
                <h3>{INSTANT_ENTRY_NO_PAST_MEETINGS_TITLE}</h3>
                <p>{INSTANT_ENTRY_NO_PAST_MEETINGS_DETAIL}</p>
              </article>
            ) : null}
          </div>
        </section>
      </section>
      <PrivateBetaApplicationModal
        error={waitlistError}
        isJoined={isWaitlistJoined}
        isJoining={isJoiningWaitlist}
        onJoin={onJoinWaitlist}
        onClose={onClose}
      />
    </WorkspaceShell>
  );

  return { content };
}

function buildInstantEntryPreparingShell(input: {
  error: string | null;
  didRefreshAuth: RefObject<boolean>;
  setRefreshedSession: (value: AuthSession | null) => void;
  setRetryCount: (update: (current: number) => number) => void;
}): { content: JSX.Element } {
  const { error, didRefreshAuth, setRefreshedSession, setRetryCount } = input;
  const hasError = error !== null && error !== "";

  const content = (
    <main className="instant-entry-shell" aria-label="Preparing meeting">
      {hasError ? (
        <section className="instant-entry-error" aria-live="polite">
          <p>{INSTANT_ENTRY_COULD_NOT_START_MEETING}</p>
          <button
            type="button"
            onClick={() => {
              clearInstantMeetingLaunch();
              window.localStorage.removeItem(ACTIVE_MEETING_KEY);
              didRefreshAuth.current = false;
              setRefreshedSession(null);
              setRetryCount((current) => current + 1);
            }}
          >
            Try again
          </button>
        </section>
      ) : null}
    </main>
  );

  return { content };
}

export function InstantEntry(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoading, refreshSession, session, updateCachedUser } = useAuth();
  const didStart = useRef(false);
  const didRefreshAuth = useRef(false);
  const [refreshedSession, setRefreshedSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceMeetings, setWorkspaceMeetings] = useState<Meeting[]>([]);
  const [isPrivateBetaApplicationShown, setIsPrivateBetaApplicationShown] = useState(false);
  const [isWaitlistJoined, setIsWaitlistJoined] = useState(false);
  const [isJoiningWaitlist, setIsJoiningWaitlist] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const shouldRequestAccess = searchParams.get("requestAccess") === "1";
  const launchIntent = searchParams.get("intent") === "agent_intro" ? "agent_intro" : "standard";

  const recoverLaunchFailure = async (nextError: unknown) => {
    await recoverInstantEntryLaunchFailure({
      nextError,
      didRefreshAuth,
      didStart,
      refreshSession,
      router,
      setError,
      setRefreshedSession,
      setRetryCount,
    });
  };

  const handleJoinWaitlist = async () => {
    await handleInstantEntryWaitlistJoin({
      refreshedSession,
      session,
      isJoiningWaitlist,
      setIsJoiningWaitlist,
      setWaitlistError,
      setIsWaitlistJoined,
    });
  };

  useEffect(() => {
    void runInstantEntryMountEffect({
      isLoading,
      didStart,
      refreshedSession,
      session,
      shouldRequestAccess,
      launchIntent,
      router,
      setError,
      setWaitlistError,
      setIsJoiningWaitlist,
      setIsWaitlistJoined,
      setWorkspaceMeetings,
      setIsPrivateBetaApplicationShown,
      updateCachedUser,
      recoverLaunchFailure,
    });
  }, [
    isLoading,
    launchIntent,
    refreshSession,
    refreshedSession,
    retryCount,
    router,
    session,
    shouldRequestAccess,
    updateCachedUser,
  ]);

  if (isPrivateBetaApplicationShown) {
    const privateBetaView = buildInstantEntryPrivateBetaView({
      workspaceMeetings,
      waitlistError,
      isWaitlistJoined,
      isJoiningWaitlist,
      onJoinWaitlist: () => {
        void handleJoinWaitlist();
      },
      onClose: () => {
        router.replace("/workspace");
      },
    });

    return privateBetaView.content;
  }

  const preparingShell = buildInstantEntryPreparingShell({
    error,
    didRefreshAuth,
    setRefreshedSession,
    setRetryCount,
  });

  return preparingShell.content;
}
