"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, getGuestMeetingNotes, linkGuestSession } from "../../composition/api";
import { startOAuthSignIn } from "../../composition/auth-client";
import type { AuthSession } from "../../domain/types";

import { type StoredGuestSession, useAuth } from "./auth-provider";
import { GuestNotesExperience, type GuestNotesState } from "./guest-notes-experience";
import { getSignupHref } from "./login-form-utils";
import { useToast } from "./toast-provider";

const GUEST_NOTES_POLL_INTERVAL_MS = 2500;
const GUEST_NOTES_RETRY_INTERVAL_MS = 5000;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;

const GUEST_MEETING_NOTES_COPY = {
  guestNotesUnavailable: "These guest notes are no longer available.",
  reconnectingTitle: "Reconnecting to your meeting notes",
  reconnectingMessage: "We’ll keep trying automatically.",
  saveFailed: "Could not save these notes to your account yet.",
  emptyTitle: "Guest notes unavailable",
  emptyDescription: "Use the same browser session you joined with, or sign in with the invited account.",
  signInWithGoogle: "Sign in with Google",
  savingLabel: "Saving...",
  saveToAccountLabel: "Save to your account",
  createAccountLabel: "Create an account",
} as const;

function shouldContinueGuestNotesPoll(payload: GuestNotesState) {
  return Boolean(
    payload.meeting.status !== "ended" ||
    (!payload.postMeetingDisposition &&
      !payload.notesAccess.locked &&
      (!payload.summary || (payload.tasksStatus && !payload.tasksStatus.isTerminal))),
  );
}

type GuestNotesPollSession = StoredGuestSession | AuthSession;

function startGuestMeetingNotesPolling(input: {
  guestNotesSession: GuestNotesPollSession;
  meetingId: string;
  showToast: (toast: { id: string; title: string; message: string; tone: "info" }) => void;
  setNotes: (notes: GuestNotesState) => void;
  setError: (error: string | null) => void;
}): () => void {
  const { guestNotesSession, meetingId, showToast, setNotes, setError } = input;
  const pollState: { isCancelled: boolean; timeoutId: number | null; hasShownReconnectToast: boolean } = {
    isCancelled: false,
    timeoutId: null,
    hasShownReconnectToast: false,
  };

  const poll = async () => {
    try {
      const payload = await getGuestMeetingNotes({ token: guestNotesSession.token, meetingId });
      if (!pollState.isCancelled) {
        setNotes(payload);
        setError(null);
        pollState.hasShownReconnectToast = false;
      }
      if (!pollState.isCancelled && shouldContinueGuestNotesPoll(payload)) {
        pollState.timeoutId = window.setTimeout(() => void poll(), GUEST_NOTES_POLL_INTERVAL_MS);
      }
    } catch (nextError) {
      if (pollState.isCancelled) {
        return;
      }
      const status = nextError instanceof ApiError ? nextError.status : null;
      if (status === HTTP_STATUS_UNAUTHORIZED || status === HTTP_STATUS_FORBIDDEN || status === HTTP_STATUS_NOT_FOUND) {
        setError(GUEST_MEETING_NOTES_COPY.guestNotesUnavailable);

        return;
      }
      if (!pollState.hasShownReconnectToast) {
        pollState.hasShownReconnectToast = true;
        showToast({
          id: `guest-notes-reconnecting:${meetingId}`,
          title: GUEST_MEETING_NOTES_COPY.reconnectingTitle,
          message: GUEST_MEETING_NOTES_COPY.reconnectingMessage,
          tone: "info",
        });
      }
      pollState.timeoutId = window.setTimeout(() => void poll(), GUEST_NOTES_RETRY_INTERVAL_MS);
    }
  };

  void poll();

  return () => {
    pollState.isCancelled = true;
    if (pollState.timeoutId !== null) {
      window.clearTimeout(pollState.timeoutId);
    }
  };
}

type GuestMeetingNotesPageViewProps = {
  isLoading: boolean;
  guestNotesSession: StoredGuestSession | AuthSession | null;
  meetingId: string;
  notes: GuestNotesState | null;
  error: string | null;
  notesCallbackUrl: string;
  fullSession: AuthSession | null;
  isLinking: boolean;
  onSaveToAccount: () => void | Promise<void>;
};

function GuestMeetingNotesPageView({
  isLoading,
  guestNotesSession,
  meetingId,
  notes,
  error,
  notesCallbackUrl,
  fullSession,
  isLinking,
  onSaveToAccount,
}: GuestMeetingNotesPageViewProps) {
  if (!isLoading && !guestNotesSession) {
    return (
      <main className="guest-notes-shell">
        <section className="guest-notes-empty">
          <h1>{GUEST_MEETING_NOTES_COPY.emptyTitle}</h1>
          <p>{GUEST_MEETING_NOTES_COPY.emptyDescription}</p>
          <button type="button" onClick={() => void startOAuthSignIn("google", notesCallbackUrl)}>
            {GUEST_MEETING_NOTES_COPY.signInWithGoogle}
          </button>
        </section>
      </main>
    );
  }

  return (
    <GuestNotesExperience
      key={meetingId}
      meetingId={meetingId}
      notes={notes}
      error={error}
      currentUserId={guestNotesSession?.user.id ?? null}
      signupHref={getSignupHref(notesCallbackUrl)}
      signupAction={
        fullSession ? (
          <button
            className="workspace-setup-action"
            type="button"
            disabled={isLinking}
            onClick={() => void onSaveToAccount()}
          >
            {isLinking ? GUEST_MEETING_NOTES_COPY.savingLabel : GUEST_MEETING_NOTES_COPY.saveToAccountLabel}
          </button>
        ) : (
          <a className="workspace-setup-action" href={getSignupHref(notesCallbackUrl)}>
            {GUEST_MEETING_NOTES_COPY.createAccountLabel}
          </a>
        )
      }
    />
  );
}

export function GuestMeetingNotesPage({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const { clearGuestSession, guestSession, isLoading, session } = useAuth();
  const [notes, setNotes] = useState<GuestNotesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const didAutoLink = useRef(false);

  const fullSession = session?.user.source !== "guest" ? session : null;
  const notesCallbackUrl = `/guest/meetings/${meetingId}/notes`;
  const guestNotesSession =
    guestSession?.meetingId === meetingId ||
    (guestSession?.joinRequestId !== undefined && guestSession.joinRequestId !== "")
      ? guestSession
      : session?.user.source === "guest"
        ? session
        : null;
  useEffect(() => {
    if (isLoading || !guestNotesSession) {
      return;
    }

    return startGuestMeetingNotesPolling({
      guestNotesSession,
      meetingId,
      showToast,
      setNotes,
      setError,
    });
  }, [guestNotesSession, isLoading, meetingId, showToast]);

  const saveToAccount = useCallback(async () => {
    if (!guestSession) {
      await startOAuthSignIn("google", notesCallbackUrl);

      return;
    }
    if (!fullSession) {
      await startOAuthSignIn("google", notesCallbackUrl);

      return;
    }

    setIsLinking(true);
    try {
      await linkGuestSession({ token: fullSession.token, guestToken: guestSession.token });
      clearGuestSession();
      router.replace(`/workspace/${meetingId}`);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      setError(GUEST_MEETING_NOTES_COPY.saveFailed);
      setIsLinking(false);
    }
  }, [clearGuestSession, fullSession, guestSession, meetingId, notesCallbackUrl, router]);

  useEffect(() => {
    if (didAutoLink.current || !fullSession || !guestSession) {
      return;
    }

    didAutoLink.current = true;
    void saveToAccount();
  }, [fullSession, guestSession, saveToAccount]);

  return (
    <GuestMeetingNotesPageView
      isLoading={isLoading}
      guestNotesSession={guestNotesSession}
      meetingId={meetingId}
      notes={notes}
      error={error}
      notesCallbackUrl={notesCallbackUrl}
      fullSession={fullSession}
      isLinking={isLinking}
      onSaveToAccount={saveToAccount}
    />
  );
}
