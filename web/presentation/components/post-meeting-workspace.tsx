"use client";

import {
  buildMeetingNotesPreview,
  FALLBACK_SUMMARY_MODEL,
  type LinearTaskReviewRun,
  type Meeting,
  stripSummaryTaskSection,
} from "@readymeet/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  ApiError,
  deleteMeeting,
  getApiErrorCode,
  getApiErrorMessage,
  getMeetingLinearTaskReview,
  getMeetingNotesRegenerationProgress,
  getMeetingPreparationPreview,
  regenerateMeetingNotes,
  runMeetingSnapshot,
} from "../../composition/api";
import {
  fallbackMeetingPreparationLines,
  readMeetingPreparationHandoff,
  resolveMeetingPreparationPreview,
} from "../../composition/meeting-preparation";
import {
  meetingDetailOptions,
  meetingNotesViewOptions,
  workspaceMeetingsOptions,
  workspaceMeetingsQueryKey,
} from "../../composition/workspace-meetings-query";
import {
  clearWorkspaceNotesRevealPending,
  hasWorkspaceNotesRevealPending,
  WORKSPACE_END_MEETING_DETAIL_KEY,
  WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT,
  WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY,
} from "../../composition/workspace-transition";
import { isAltShiftShortcut, isEditableShortcutTarget } from "../../domain/keyboard-shortcuts";
import { formatMeetingSummaryAndTasksForClipboard, getMeetingCopyParticipantNames } from "../../domain/meeting-copy";
import { loadPostMeetingRefresh } from "../../domain/post-meeting-refresh";
import {
  meetingDetailQueryKey,
  meetingLinearTaskReviewQueryKey,
  meetingNotesViewQueryKey,
} from "../../domain/query-keys";
import type { MeetingDetailPayload, MeetingNotesViewPayload } from "../../domain/types";
import { getCachedWorkspaceMeetings, setCachedWorkspaceMeetings } from "../../domain/workspace-meetings-cache";
import { useRealtimeFallbackPolling } from "../hooks/use-realtime-fallback-polling";
import { useMeetingTaskRealtime } from "../hooks/use-task-realtime";
import { useTrialOffer } from "../lib/use-trial-offer";

import { AgentThinkingBlock } from "./agent-thinking";
import { AshbyMeetingReview } from "./ashby-review";
import { useAuth } from "./auth-provider";
import { ReadyMeetingTodayLogo } from "./calendar-ready-meeting-logo";
import { MeetingPreparationProgress } from "./meeting-preparation-progress";
import { MeetingProUpgradeCard } from "./meeting-pro-upgrade-card";
import { MeetingRejoinBanner, useMeetingWaitingState } from "./meeting-waiting-state";
import { PastMeetingRemoveDialog } from "./past-meeting-remove-dialog";
import { RegenerateNotesButton } from "./regenerate-notes-button";
import { SlackMeetingReviewPanel } from "./slack-meeting-review";
import { useToast } from "./toast-provider";
import { useBottomFollow } from "./use-bottom-follow";
import { useMeetingTasksStatus } from "./use-meeting-tasks-status";
import { WorkspaceGeneratedNotes } from "./workspace-generated-notes";
import { WorkspaceShell } from "./workspace-shell";
import { WorkspaceTasksSection } from "./workspace-tasks-section";

type PostMeetingPayload = MeetingNotesViewPayload;

const LINEAR_REVIEW_STALE_MS = 30_000;
const LINEAR_REVIEW_POLL_MS = 4_000;

const KEY_CODE_C = "KeyC";
const KEY_CODE_S = "KeyS";
const KEY_CODE_D = "KeyD";

const NOTES_LONG_WAIT_ATTEMPTS = 78;
const NOTES_SLOW_POLL_ATTEMPTS = 138;

const MEETING_META_PILL_LIMIT = 8;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const TRANSCRIPT_POLL_FAST_MAX_ATTEMPTS = 30;
const TRANSCRIPT_POLL_INTERVAL_FAST_MS = 2_000;
const TRANSCRIPT_POLL_INTERVAL_MEDIUM_MS = 5_000;
const TRANSCRIPT_POLL_INTERVAL_SLOW_MS = 30_000;
const PREPARATION_PREVIEW_RETRY_MS = 5_000;
const PREPARATION_LINES_POLL_MS = 1_000;
const DEFERRED_SNAPSHOT_RETRY_MS = 30_000;
/** Twelve 30s retries outlast the API's 3-minute window for a finalization that stopped renewing its claim. */
const DEFERRED_SNAPSHOT_MAX_RETRIES = 12;
const SOURCE_EXCERPT_NEIGHBOR_SEGMENTS = 1;
const WORKSPACE_REVEAL_COMPLETE_SESSION_VALUE = "1";

const POST_MEETING_WORKSPACE_COPY = {
  loadingTranscript: "Loading transcript…",
  retryTranscript: "Retry loading transcript",
  transcriptUnavailable: "Transcript access is unavailable.",
  transcriptExcerptSeparator: " · ",
  assistantSpeakerLabel: "Assistant",
  systemSpeakerLabel: "System",
  participantSpeakerLabel: "Participant",
  meetingReadyHeading: "Your meeting is ready",
  loadingMeetingTitle: "Meeting title",
  loadingOverview: "Overview",
  placeholderDate: "Sep 20, 12:00 PM",
  placeholderParticipant: "Participant",
  meetingUnavailable: "This meeting is unavailable.",
  unableToLoadMeeting: "Unable to load this meeting. Please try again.",
  failedToLoadWorkspace: "Failed to load workspace",
  failedToRefreshWorkspace: "Failed to refresh workspace",
  meetingIsUnavailable: "Meeting is unavailable.",
  failedToRefreshMeetingNotes: "Failed to refresh meeting notes",
  failedToStartMeetingNotes: "Failed to start meeting notes",
  meetingNotesStillFinalizing: "Meeting notes are taking longer than expected. Refresh the page to check again.",
  meetingTooShortTitle: "Meeting was too short",
  noTranscriptToCopy: "No transcript available to copy",
  transcriptCopiedTitle: "Transcript copied",
  transcriptCopiedMessage: "The meeting transcript is on your clipboard.",
  failedToCopyTranscript: "Failed to copy transcript",
  summaryTasksNotReady: "Summary and tasks are not ready to copy",
  summaryTasksCopiedTitle: "Summary and tasks copied",
  summaryTasksCopiedMessage: "The meeting summary and tasks are ready to paste into an email.",
  failedToCopySummaryTasks: "Failed to copy summary and tasks",
  meetingRemovedTitle: "Meeting removed",
  meetingRestoredTitle: "Meeting restored",
  failedToDeleteMeeting: "Failed to delete meeting",
  scrollToLatestLabel: "Scroll to latest content",
  overviewHeading: "Overview",
  meetingInProgressTitle: "Meeting is still in progress",
  takingLongerTitle: "Taking longer than expected",
  preparingNotesTitle: "Preparing your notes",
  takingLongerDetail: "Processing is still running in the background. You can navigate away and return later.",
  finalMomentsDetail: "Including the final moments of the meeting.",
  noSummaryYet: "No summary yet.",
  noNotesCaptured: "No notes were captured for this meeting.",
  sourceTranscriptHeading: "Source transcript",
  sourceExcerptUnavailable: "This transcript excerpt is no longer available.",
  planCheckFailed: "Could not check your plan. ",
  tryAgain: "Try again",
  tasksNotPrepared: "Tasks could not be prepared.",
  finalizingTitle: "Finalizing meeting title...",
  copyTranscriptLabel: "Copy transcript",
  copySummaryTasksLabel: "Copy summary & tasks",
  deletingMeeting: "Deleting...",
  deleteMeeting: "Delete meeting",
  meetingActionsLabel: "Meeting actions",
  meetingMetadataLabel: "Meeting metadata",
  sourceExcerptLabel: "Source transcript excerpt",
  loadingMeetingMetadata: "Loading meeting metadata",
  loadingMeetingLabel: "Loading meeting",
  loadingOverviewLabel: "Loading overview",
  loadingMeetingNotesLabel: "Loading meeting notes",
  shortcutOption: "⌥",
  shortcutShift: "⇧",
  shortcutKeyCopy: "C",
  shortcutKeySummary: "S",
  shortcutKeyDelete: "D",
} as const;

function formatMeetingRemovedMessage(title: string) {
  return `"${title}" was removed from past meetings.`;
}

function hasPostMeetingNotesArtifact(detail: PostMeetingPayload | null | undefined) {
  if (detail === null || detail === undefined) {
    return false;
  }

  // Readiness comes from the artifact existing, never its text: notes can legitimately be empty.
  return detail.summary !== null || detail.notesPreview?.status === "ready";
}

function getTranscriptSpeakerLabel(segment: MeetingDetailPayload["transcriptSegments"][number]) {
  if (segment.speakerRole === "assistant") {
    const normalizedName = segment.speakerName.trim();
    if (normalizedName.length === 0 || normalizedName.startsWith("readymeet-assistant-")) {
      return POST_MEETING_WORKSPACE_COPY.assistantSpeakerLabel;
    }

    return normalizedName;
  }

  if (segment.speakerRole === "system") {
    return POST_MEETING_WORKSPACE_COPY.systemSpeakerLabel;
  }

  const normalizedName = segment.speakerName.trim();

  return normalizedName.length > 0 ? normalizedName : POST_MEETING_WORKSPACE_COPY.participantSpeakerLabel;
}

function shouldHideGenericMeetingTitle(detail: PostMeetingPayload | null) {
  if (!detail) {
    return false;
  }

  return detail.meeting.status === "ended" && detail.meeting.title.trim().toLowerCase() === "instant meeting";
}

function formatMeetingDateTime(meeting: PostMeetingPayload["meeting"]) {
  const anchor = meeting.startedAt ?? meeting.createdAt;

  return new Date(anchor).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMeetingCopyDateTime(meeting: PostMeetingPayload["meeting"]) {
  const anchor = meeting.startedAt ?? meeting.createdAt;

  return new Date(anchor).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getMeetingParticipantPills(detail: PostMeetingPayload | null) {
  if (!detail) {
    return [];
  }

  return Array.from(
    new Set(
      detail.meetingRuntime.allHumanParticipants.map((participant) => participant.displayName.trim()).filter(Boolean),
    ),
  ).slice(0, MEETING_META_PILL_LIMIT);
}

const NOTES_LOCKED_CARD_VARIANTS = {
  signup_required: {
    description: "Decisions, tasks, and follow-ups are waiting. Sign up to view them.",
    action: "Sign up",
    href: "/signup",
  },
  credits_required: {
    description: "You’ve used your available credits. Buy credits to view this meeting.",
    action: "Buy credits",
    href: "/workspace/settings?tab=billing",
  },
} as const;

/**
 * Shown in place of the generated notes and tasks when the viewer may not
 * see them yet: guests are asked to sign up, free users to upgrade, and
 * paid-plan users out of credits to buy more. Notes are still generated
 * server-side either way.
 */
export function MeetingNotesLockedCard({
  reason,
  signupHref = "/signup",
  token,
  workspaceId,
  paymentStatus,
}: {
  reason: "upgrade_required" | "credits_required" | "signup_required" | null;
  signupHref?: string;
  token?: string;
  workspaceId?: string;
  paymentStatus?: "processing" | "failed";
}) {
  if (reason === "upgrade_required" || reason === null) {
    return <MeetingProUpgradeCard token={token} workspaceId={workspaceId} paymentStatus={paymentStatus} />;
  }
  const variant = NOTES_LOCKED_CARD_VARIANTS[reason];
  const href = reason === "signup_required" ? signupHref : variant.href;

  return (
    <section className="workspace-meeting-brief-card workspace-ready-meeting-card workspace-notes-locked-card">
      <div className="workspace-meeting-brief-card-inner">
        <div className="workspace-meeting-brief-card-head">
          <ReadyMeetingTodayLogo />
        </div>
        <div className="workspace-meeting-brief-card-copy">
          <h5>{POST_MEETING_WORKSPACE_COPY.meetingReadyHeading}</h5>
          <p>{variant.description}</p>
        </div>
        <Link className="workspace-ready-meeting-action" href={href}>
          {variant.action}
        </Link>
      </div>
    </section>
  );
}

function readEndMeetingDetailHandoff(_input: { meetingId: string; userId?: string }): PostMeetingPayload | null {
  clearEndMeetingDetailHandoff("");

  return null;
}

function clearEndMeetingDetailHandoff(_meetingId: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(WORKSPACE_END_MEETING_DETAIL_KEY);
  } catch (error) {
    // Clear malformed handoffs so they cannot keep affecting future opens.
    void error;
  }
}

function getExactMeetingDetail(input: {
  detail: PostMeetingPayload | null | undefined;
  meetingId: string;
}): PostMeetingPayload | null {
  const { detail, meetingId } = input;

  return detail?.meeting.id === meetingId ? detail : null;
}

function isMeetingDetailUnavailable(error: unknown) {
  return (
    error instanceof ApiError && (error.status === HTTP_STATUS_FORBIDDEN || error.status === HTTP_STATUS_NOT_FOUND)
  );
}

function shouldAnimateWorkspaceNotesReveal() {
  if (typeof window === "undefined") {
    return false;
  }

  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function hasWorkspaceRevealCompleted() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return (
      window.sessionStorage.getItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY) ===
      WORKSPACE_REVEAL_COMPLETE_SESSION_VALUE
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return false;
  }
}

function getWorkspaceNotesRevealState(meetingId: string) {
  const isPending = hasWorkspaceNotesRevealPending(meetingId);
  const canAnimate = shouldAnimateWorkspaceNotesReveal();
  const isShellRevealComplete = hasWorkspaceRevealCompleted();

  return {
    isWaiting: isPending && canAnimate && !isShellRevealComplete,
    shouldAnimate: isPending && canAnimate && isShellRevealComplete,
  };
}

function EllipsisIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20.3887 4.09277" className="meeting-actions-icon" fill="none">
      <path
        d="M18.0039 4.07129C19.1318 4.07129 20.0449 3.16895 20.0449 2.04102C20.0449 0.913086 19.1318 0 18.0039 0C16.876 0 15.9629 0.913086 15.9629 2.04102C15.9629 3.16895 16.876 4.07129 18.0039 4.07129Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <path
        d="M10.0225 4.07129C11.1504 4.07129 12.0527 3.16895 12.0527 2.04102C12.0527 0.913086 11.1504 0 10.0225 0C8.89453 0 7.98145 0.913086 7.98145 2.04102C7.98145 3.16895 8.89453 4.07129 10.0225 4.07129Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <path
        d="M2.04102 4.07129C3.16895 4.07129 4.07129 3.16895 4.07129 2.04102C4.07129 0.913086 3.16895 0 2.04102 0C0.913086 0 0 0.913086 0 2.04102C0 3.16895 0.913086 4.07129 2.04102 4.07129Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
    </svg>
  );
}

function MeetingDetailLoadingFrame({
  title,
  meeting,
  error = null,
  isEmbedded = false,
}: {
  title: string;
  meeting?: Meeting | null;
  error?: string | null;
  isEmbedded?: boolean;
}) {
  const placeholderPills = meeting
    ? [
        formatMeetingDateTime(meeting),
        ...Array.from(
          new Set((meeting.participants ?? []).map((participant) => participant.displayName.trim()).filter(Boolean)),
        ).slice(0, MEETING_META_PILL_LIMIT),
      ]
    : [POST_MEETING_WORKSPACE_COPY.placeholderDate, POST_MEETING_WORKSPACE_COPY.placeholderParticipant];

  return (
    <section
      className={[
        "meeting-page workspace-meeting-detail-page workspace-meeting-loading-frame",
        isEmbedded ? "workspace-meeting-detail-page-embedded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-busy={error === null || error.length === 0}
    >
      <header className="meeting-header">
        <div className="meeting-header-main">
          <h2>
            {title.length > 0 ? (
              title
            ) : (
              <span
                className="workspace-flow-skeleton-line workspace-flow-skeleton-title-line"
                aria-label={POST_MEETING_WORKSPACE_COPY.loadingMeetingLabel}
              >
                <span aria-hidden="true">{POST_MEETING_WORKSPACE_COPY.loadingMeetingTitle}</span>
              </span>
            )}
          </h2>
          {error === null || error.length === 0 ? (
            <div
              className="workspace-meeting-meta-pills workspace-meeting-meta-skeleton"
              aria-label={POST_MEETING_WORKSPACE_COPY.loadingMeetingMetadata}
            >
              {placeholderPills.map((pill, index) => (
                <span
                  key={index}
                  className="workspace-meta-pill workspace-flow-skeleton-line workspace-flow-skeleton-meta-line"
                  aria-hidden="true"
                >
                  {pill}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      {error !== null && error.length > 0 ? <p className="error-text">{error}</p> : null}

      {error === null || error.length === 0 ? (
        <div className="workspace-document-shell">
          <div className="workspace-document-page">
            <div className="workspace-document-stack">
              <div className="workspace-document-section">
                <h3 aria-label={POST_MEETING_WORKSPACE_COPY.loadingOverviewLabel}>
                  <span
                    className="workspace-flow-skeleton-line workspace-flow-skeleton-overview-line"
                    aria-hidden="true"
                  >
                    {POST_MEETING_WORKSPACE_COPY.loadingOverview}
                  </span>
                </h3>
                <div className="workspace-flow-snapshot">
                  <div
                    className="workspace-flow-snapshot-notes is-static"
                    aria-label={POST_MEETING_WORKSPACE_COPY.loadingMeetingNotesLabel}
                  >
                    {["long", "medium", "short"].map((length) => (
                      <p key={length} className="workspace-flow-snapshot-note-line" aria-hidden="true">
                        <span className="workspace-flow-summary-bullet workspace-flow-skeleton-bullet" />
                        <span
                          className={`workspace-flow-skeleton-line workspace-flow-skeleton-bullet-line is-${length}`}
                        />
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export type MeetingLoadFailure = { meetingId: string; message: string; retry: () => void };

function PostMeetingSourceTranscriptExcerpt({
  segments,
  sourceSegmentId,
}: {
  segments: MeetingDetailPayload["transcriptSegments"];
  sourceSegmentId: string;
}) {
  const index = segments.findIndex((segment) => segment.id === sourceSegmentId);
  if (index < 0) {
    return <p>{POST_MEETING_WORKSPACE_COPY.sourceExcerptUnavailable}</p>;
  }

  return (
    <>
      {segments
        .slice(Math.max(0, index - SOURCE_EXCERPT_NEIGHBOR_SEGMENTS), index + SOURCE_EXCERPT_NEIGHBOR_SEGMENTS + 1)
        .map((segment) => (
          <blockquote key={segment.id} data-highlighted={segment.id === sourceSegmentId}>
            <p>{segment.content}</p>
            <footer>
              {getTranscriptSpeakerLabel(segment)}
              {POST_MEETING_WORKSPACE_COPY.transcriptExcerptSeparator}

              {new Date(segment.startedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </footer>
          </blockquote>
        ))}
    </>
  );
}

function usePostMeetingActionsMenuDismiss(input: {
  isActionsMenuOpen: boolean;
  actionsMenuRef: RefObject<HTMLDivElement | null>;
  setIsActionsMenuOpen: (value: boolean | ((isOpen: boolean) => boolean)) => void;
}) {
  const { isActionsMenuOpen, actionsMenuRef, setIsActionsMenuOpen } = input;

  useEffect(() => {
    if (!isActionsMenuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || actionsMenuRef.current?.contains(event.target) !== true) {
        setIsActionsMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsActionsMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsMenuRef, isActionsMenuOpen, setIsActionsMenuOpen]);
}

function usePostMeetingMeetingSwitchHandoff(input: {
  meetingId: string;
  userId?: string;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  didInitializeMeetingRef: RefObject<boolean>;
  snapshotRunMeetingIdRef: RefObject<string | null>;
  setDetail: (value: PostMeetingPayload | null) => void;
  setError: (value: string | null) => void;
  setUnavailableMeetingId: (value: string | null) => void;
  setPollAttempts: (value: number | ((current: number) => number)) => void;
  setIsWaitingForWorkspaceReveal: (value: boolean) => void;
  setShouldAnimateNotes: (value: boolean) => void;
  setIsNotesRevealComplete: (value: boolean) => void;
  setPreparationLines: (value: string[] | null) => void;
  setWaitingPreparationLines: (value: string[]) => void;
  setDeleteDialogMeeting: (value: Meeting | null) => void;
  setDeleteDialogError: (value: string | null) => void;
}) {
  const {
    meetingId,
    userId,
    detailQueryKey,
    queryClient,
    didInitializeMeetingRef,
    snapshotRunMeetingIdRef,
    setDetail,
    setError,
    setUnavailableMeetingId,
    setPollAttempts,
    setIsWaitingForWorkspaceReveal,
    setShouldAnimateNotes,
    setIsNotesRevealComplete,
    setPreparationLines,
    setWaitingPreparationLines,
    setDeleteDialogMeeting,
    setDeleteDialogError,
  } = input;

  useEffect(() => {
    if (didInitializeMeetingRef.current) {
      const handoffDetail = readEndMeetingDetailHandoff({ meetingId, userId });
      setDetail(handoffDetail);
      if (handoffDetail) {
        queryClient.setQueryData(detailQueryKey, handoffDetail);
        clearEndMeetingDetailHandoff(meetingId);
      }
      setError(null);
      setUnavailableMeetingId(null);
      setPollAttempts(0);
      const notesRevealState = getWorkspaceNotesRevealState(meetingId);
      setIsWaitingForWorkspaceReveal(notesRevealState.isWaiting);
      setShouldAnimateNotes(notesRevealState.shouldAnimate);
      setIsNotesRevealComplete(false);
      setPreparationLines(readMeetingPreparationHandoff(meetingId, userId));
      setWaitingPreparationLines([]);
    } else {
      const handoffDetail = readEndMeetingDetailHandoff({ meetingId, userId });
      if (handoffDetail) {
        setDetail(handoffDetail);
        queryClient.setQueryData(detailQueryKey, handoffDetail);
        clearEndMeetingDetailHandoff(meetingId);
      }
      didInitializeMeetingRef.current = true;
    }

    snapshotRunMeetingIdRef.current = null;
    setDeleteDialogMeeting(null);
    setDeleteDialogError(null);
  }, [
    detailQueryKey,
    didInitializeMeetingRef,
    meetingId,
    queryClient,
    setDeleteDialogError,
    setDeleteDialogMeeting,
    setDetail,
    setError,
    setIsNotesRevealComplete,
    setIsWaitingForWorkspaceReveal,
    setPollAttempts,
    setPreparationLines,
    setShouldAnimateNotes,
    setUnavailableMeetingId,
    setWaitingPreparationLines,
    userId,
  ]);
}

function usePostMeetingQueryResultSync(input: {
  meetingsQueryData: Meeting[] | undefined;
  detailQueryData: PostMeetingPayload | undefined;
  detailQueryError: unknown;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  meetingId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  refresh: () => Promise<void>;
  session: ReturnType<typeof useAuth>["session"];
  setMeetings: (value: Meeting[]) => void;
  setDetail: (value: PostMeetingPayload | null) => void;
  setUnavailableMeetingId: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const {
    meetingsQueryData,
    detailQueryData,
    detailQueryError,
    detailQueryKey,
    meetingId,
    queryClient,
    refresh,
    session,
    setMeetings,
    setDetail,
    setUnavailableMeetingId,
    setError,
  } = input;

  useEffect(() => {
    if (meetingsQueryData) {
      setMeetings(meetingsQueryData);
      setCachedWorkspaceMeetings(session?.user.id, session?.user.workspaceId, meetingsQueryData);
    }
  }, [meetingsQueryData, session?.user.id, session?.user.workspaceId, setMeetings]);

  useEffect(() => {
    if (detailQueryData) {
      setDetail(detailQueryData);
      setUnavailableMeetingId(null);
    }
  }, [detailQueryData, setDetail, setUnavailableMeetingId]);

  useEffect(() => {
    if (!isMeetingDetailUnavailable(detailQueryError)) {
      return;
    }

    queryClient.removeQueries({ queryKey: meetingDetailQueryKey(detailQueryKey[1]) });
    setDetail(null);
    setUnavailableMeetingId(meetingId);
    setError(
      getApiErrorMessage({ error: detailQueryError, fallback: POST_MEETING_WORKSPACE_COPY.meetingIsUnavailable }),
    );
  }, [detailQueryError, detailQueryKey, meetingId, queryClient, setDetail, setError, setUnavailableMeetingId]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        await refresh();
      } catch (nextError) {
        if (!controller.signal.aborted) {
          setError(
            getApiErrorMessage({ error: nextError, fallback: POST_MEETING_WORKSPACE_COPY.failedToLoadWorkspace }),
          );
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [refresh, session, setError]);
}

function usePostMeetingTranscriptDetailPolling(input: {
  session: ReturnType<typeof useAuth>["session"];
  renderedDetail: PostMeetingPayload | null;
  hasLockedPreviewPollingExpired: boolean;
  pollAttempts: number;
  refresh: () => Promise<void>;
  setError: (value: string | null) => void;
  setPollAttempts: (value: number | ((current: number) => number)) => void;
}) {
  const { session, renderedDetail, hasLockedPreviewPollingExpired, pollAttempts, refresh, setError, setPollAttempts } =
    input;

  useEffect(() => {
    if (!session || !renderedDetail) {
      return;
    }

    const hasSummary = renderedDetail.summary !== null;
    const isTranscriptFinal = renderedDetail.transcript?.isFinal ?? false;
    const shouldKeepPolling =
      renderedDetail.meeting.status !== "ended" ||
      !isTranscriptFinal ||
      (!hasSummary && (!renderedDetail.notesAccess.locked || renderedDetail.notesPreview?.status === "pending"));

    if (!shouldKeepPolling || hasLockedPreviewPollingExpired) {
      return;
    }

    const transcriptPollMs =
      pollAttempts < TRANSCRIPT_POLL_FAST_MAX_ATTEMPTS
        ? TRANSCRIPT_POLL_INTERVAL_FAST_MS
        : pollAttempts < NOTES_SLOW_POLL_ATTEMPTS
          ? TRANSCRIPT_POLL_INTERVAL_MEDIUM_MS
          : TRANSCRIPT_POLL_INTERVAL_SLOW_MS;
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          await refresh();
        } catch (nextError) {
          setError(
            getApiErrorMessage({ error: nextError, fallback: POST_MEETING_WORKSPACE_COPY.failedToRefreshWorkspace }),
          );
        } finally {
          setPollAttempts((current) => current + 1);
        }
      })();
    }, transcriptPollMs);

    return () => window.clearTimeout(timeoutId);
  }, [hasLockedPreviewPollingExpired, pollAttempts, refresh, renderedDetail, session, setError, setPollAttempts]);
}

function usePostMeetingAwaitingPreparationPreview(input: {
  sessionToken: string | null;
  meetingId: string;
  isAwaitingMeetingEnd: boolean;
  isNotesAccessLocked: boolean;
  setWaitingPreparationLines: (value: string[]) => void;
}) {
  const { sessionToken, meetingId, isAwaitingMeetingEnd, isNotesAccessLocked, setWaitingPreparationLines } = input;

  useEffect(() => {
    if (sessionToken === null || sessionToken.length === 0 || !isAwaitingMeetingEnd || isNotesAccessLocked) {
      return;
    }
    const controller = new AbortController();
    const timer: { timeoutId: number | undefined } = { timeoutId: undefined };
    const load = async () => {
      try {
        const preview = await getMeetingPreparationPreview({ token: sessionToken, meetingId });
        if (controller.signal.aborted) {
          return;
        }
        const resolution = resolveMeetingPreparationPreview(preview);
        if (resolution.modelDeck) {
          setWaitingPreparationLines(resolution.modelDeck.lines);

          return;
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
      }
      if (!controller.signal.aborted) {
        timer.timeoutId = window.setTimeout(() => void load(), PREPARATION_PREVIEW_RETRY_MS);
      }
    };
    void load();

    return () => {
      controller.abort();
      window.clearTimeout(timer.timeoutId);
    };
  }, [isAwaitingMeetingEnd, isNotesAccessLocked, meetingId, sessionToken, setWaitingPreparationLines]);
}

function usePostMeetingEndedPreparationLines(input: {
  sessionToken: string | null;
  meetingId: string;
  detailMeetingStatus: PostMeetingPayload["meeting"]["status"] | null;
  preparationLines: string[] | null;
  summaryContent: string | null;
  isNotesAccessLocked: boolean;
  isUpgradePreview: boolean;
  hasLockedPreviewPollingExpired: boolean;
  setPreparationLines: (value: string[] | null) => void;
}) {
  const {
    sessionToken,
    meetingId,
    detailMeetingStatus,
    preparationLines,
    summaryContent,
    isNotesAccessLocked,
    isUpgradePreview,
    hasLockedPreviewPollingExpired,
    setPreparationLines,
  } = input;

  useEffect(() => {
    if (
      sessionToken === null ||
      sessionToken.length === 0 ||
      detailMeetingStatus !== "ended" ||
      preparationLines !== null ||
      summaryContent !== null ||
      (isNotesAccessLocked && !isUpgradePreview) ||
      hasLockedPreviewPollingExpired
    ) {
      return;
    }

    const controller = new AbortController();
    const timer: { timeoutId: number | null } = { timeoutId: null };
    const loadPreparation = async () => {
      try {
        const preview = await getMeetingPreparationPreview({ token: sessionToken, meetingId });
        if (controller.signal.aborted) {
          return;
        }
        const resolution = resolveMeetingPreparationPreview(preview);
        if (resolution.modelDeck) {
          setPreparationLines(resolution.modelDeck.lines);

          return;
        }
        if (resolution.isTerminal) {
          return;
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
      }

      if (!controller.signal.aborted) {
        timer.timeoutId = window.setTimeout(() => {
          void loadPreparation();
        }, PREPARATION_LINES_POLL_MS);
      }
    };

    void loadPreparation();

    return () => {
      controller.abort();
      if (timer.timeoutId !== null) {
        window.clearTimeout(timer.timeoutId);
      }
    };
  }, [
    detailMeetingStatus,
    hasLockedPreviewPollingExpired,
    isUpgradePreview,
    meetingId,
    isNotesAccessLocked,
    preparationLines,
    sessionToken,
    setPreparationLines,
    summaryContent,
  ]);
}

type DeferredRetryTimer = { timeoutId: number | null };

/** Asks for deferred notes again while a finalization writes them, and reports when it never does. */
function useDeferredSnapshotRunRetry(input: { snapshotRunMeetingIdRef: RefObject<string | null> }) {
  const { snapshotRunMeetingIdRef } = input;
  const [tick, setTick] = useState(0);
  const retriesRef = useRef<{ meetingId: string | null; count: number }>({ meetingId: null, count: 0 });

  return useMemo(
    () => ({
      tick,
      track: (meetingId: string) => {
        if (retriesRef.current.meetingId !== meetingId) {
          retriesRef.current = { meetingId, count: 0 };
        }
      },
      schedule: (run: {
        snapshot: unknown;
        signal: AbortSignal;
        timer: DeferredRetryTimer;
        setError: (value: string | null) => void;
      }) => {
        const { snapshot, signal, timer, setError } = run;
        if (signal.aborted) {
          return;
        }
        const nextStep = deferredSnapshotRunStep({ snapshot, deferredRetries: retriesRef.current.count });
        if (nextStep === "give_up") {
          setError(POST_MEETING_WORKSPACE_COPY.meetingNotesStillFinalizing);
        }
        if (nextStep === "retry") {
          timer.timeoutId = window.setTimeout(() => {
            timer.timeoutId = null;
            retriesRef.current = { ...retriesRef.current, count: retriesRef.current.count + 1 };
            snapshotRunMeetingIdRef.current = null;
            setTick((current) => current + 1);
          }, DEFERRED_SNAPSHOT_RETRY_MS);
        }
      },
      cancel: (run: { timer: DeferredRetryTimer }) => {
        const { timer } = run;
        if (timer.timeoutId !== null) {
          window.clearTimeout(timer.timeoutId);
          // The pending retry is cancelled with this run, so the next run must be free to ask again.
          snapshotRunMeetingIdRef.current = null;
        }
      },
    }),
    [snapshotRunMeetingIdRef, tick],
  );
}

function reportSnapshotRunFailure(input: {
  error: unknown;
  signal: AbortSignal;
  queryClient: ReturnType<typeof useQueryClient>;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  snapshotRunMeetingIdRef: RefObject<string | null>;
  setError: (value: string | null) => void;
}): void {
  const { error, signal, queryClient, detailQueryKey, snapshotRunMeetingIdRef, setError } = input;
  if (signal.aborted) {
    return;
  }

  if (getApiErrorCode(error) === "meeting_notes_locked") {
    void queryClient.invalidateQueries({ queryKey: detailQueryKey, exact: true });

    return;
  }

  snapshotRunMeetingIdRef.current = null;
  setError(getApiErrorMessage({ error, fallback: POST_MEETING_WORKSPACE_COPY.failedToStartMeetingNotes }));
}

function usePostMeetingMeetingSnapshotRun(input: {
  sessionToken: string | null;
  detailMeetingId: string | null;
  isReadOnlyMeetingViewer: boolean;
  isNotesAccessLocked: boolean;
  detailMeetingStatus: PostMeetingPayload["meeting"]["status"] | null;
  isDetailTranscriptFinal: boolean;
  detailSummaryId: string | null;
  isPreviewReady: boolean;
  snapshotRunMeetingIdRef: RefObject<string | null>;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  refresh: () => Promise<void>;
  setError: (value: string | null) => void;
}) {
  const {
    sessionToken,
    detailMeetingId,
    isReadOnlyMeetingViewer,
    isNotesAccessLocked,
    detailMeetingStatus,
    isDetailTranscriptFinal,
    detailSummaryId,
    isPreviewReady,
    snapshotRunMeetingIdRef,
    detailQueryKey,
    queryClient,
    refresh,
    setError,
  } = input;
  const deferredRetry = useDeferredSnapshotRunRetry({ snapshotRunMeetingIdRef });

  useEffect(() => {
    if (
      sessionToken === null ||
      sessionToken.length === 0 ||
      detailMeetingId === null ||
      isReadOnlyMeetingViewer ||
      isNotesAccessLocked ||
      detailMeetingStatus !== "ended" ||
      !isDetailTranscriptFinal ||
      detailSummaryId !== null ||
      isPreviewReady ||
      snapshotRunMeetingIdRef.current === detailMeetingId
    ) {
      return;
    }

    const controller = new AbortController();
    const retryTimer: DeferredRetryTimer = { timeoutId: null };
    snapshotRunMeetingIdRef.current = detailMeetingId;
    deferredRetry.track(detailMeetingId);

    void (async () => {
      try {
        const run = await runMeetingSnapshot({ token: sessionToken, meetingId: detailMeetingId });
        if (controller.signal.aborted) {
          return;
        }
        try {
          await refresh();
        } catch (nextError) {
          setError(
            getApiErrorMessage({ error: nextError, fallback: POST_MEETING_WORKSPACE_COPY.failedToRefreshMeetingNotes }),
          );
        }
        deferredRetry.schedule({ snapshot: run.snapshot, signal: controller.signal, timer: retryTimer, setError });
      } catch (nextError) {
        reportSnapshotRunFailure({
          error: nextError,
          signal: controller.signal,
          queryClient,
          detailQueryKey,
          snapshotRunMeetingIdRef,
          setError,
        });
      }
    })();

    return () => {
      controller.abort();
      deferredRetry.cancel({ timer: retryTimer });
    };
  }, [
    deferredRetry,
    detailMeetingId,
    detailMeetingStatus,
    detailQueryKey,
    detailSummaryId,
    isDetailTranscriptFinal,
    isPreviewReady,
    isReadOnlyMeetingViewer,
    isNotesAccessLocked,
    queryClient,
    refresh,
    sessionToken,
    setError,
    snapshotRunMeetingIdRef,
  ]);
}

function usePostMeetingSkippedDisposition(input: {
  renderedDetail: PostMeetingPayload | null;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  const { renderedDetail, router, showToast } = input;

  useEffect(() => {
    if (renderedDetail?.postMeetingDisposition?.status !== "skipped") {
      return;
    }

    showToast({
      id: `post-meeting-skipped:${renderedDetail.meeting.id}:${renderedDetail.postMeetingDisposition.reason}`,
      title: POST_MEETING_WORKSPACE_COPY.meetingTooShortTitle,
      message: renderedDetail.postMeetingDisposition.message,
    });
    router.replace(renderedDetail.postMeetingDisposition.redirectTo);
  }, [renderedDetail, router, showToast]);
}

function usePostMeetingWorkspaceNotesReveal(input: {
  meetingId: string;
  isWaitingForWorkspaceReveal: boolean;
  shouldAnimateNotes: boolean;
  summaryContent: string | null;
  setIsWaitingForWorkspaceReveal: (value: boolean) => void;
  setShouldAnimateNotes: (value: boolean) => void;
  setIsNotesRevealComplete: (value: boolean) => void;
}) {
  const {
    meetingId,
    isWaitingForWorkspaceReveal,
    shouldAnimateNotes,
    summaryContent,
    setIsWaitingForWorkspaceReveal,
    setShouldAnimateNotes,
    setIsNotesRevealComplete,
  } = input;

  useEffect(() => {
    if (!shouldAnimateWorkspaceNotesReveal()) {
      clearWorkspaceNotesRevealPending(meetingId);
    }
  }, [meetingId]);

  useEffect(() => {
    if (!isWaitingForWorkspaceReveal) {
      return;
    }

    const startNotesReveal = () => {
      setIsWaitingForWorkspaceReveal(false);
      setShouldAnimateNotes(true);
      setIsNotesRevealComplete(false);
    };

    if (hasWorkspaceRevealCompleted()) {
      startNotesReveal();

      return;
    }

    window.addEventListener(WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT, startNotesReveal, { once: true });

    return () => {
      window.removeEventListener(WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT, startNotesReveal);
    };
  }, [isWaitingForWorkspaceReveal, setIsNotesRevealComplete, setIsWaitingForWorkspaceReveal, setShouldAnimateNotes]);

  useEffect(() => {
    if (summaryContent === null || isWaitingForWorkspaceReveal) {
      setIsNotesRevealComplete(false);

      return;
    }

    // A finalized summary with no notes beyond its tasks has nothing to animate.
    if (summaryContent.length === 0 || !shouldAnimateNotes) {
      setIsNotesRevealComplete(true);
    }
  }, [isWaitingForWorkspaceReveal, shouldAnimateNotes, summaryContent, setIsNotesRevealComplete]);
}

function getPostMeetingNotesThinkingTitle(input: {
  isAwaitingMeetingEnd: boolean;
  isTakingLongerThanExpected: boolean;
}) {
  if (input.isAwaitingMeetingEnd) {
    return POST_MEETING_WORKSPACE_COPY.meetingInProgressTitle;
  }

  if (input.isTakingLongerThanExpected) {
    return POST_MEETING_WORKSPACE_COPY.takingLongerTitle;
  }

  return POST_MEETING_WORKSPACE_COPY.preparingNotesTitle;
}

export function MeetingNotesEmptyMessage() {
  return <p className="muted workspace-notes-empty">{POST_MEETING_WORKSPACE_COPY.noNotesCaptured}</p>;
}

function PostMeetingNotesOverviewSection({
  meetingId,
  summaryContent,
  isWaitingForWorkspaceReveal,
  shouldAnimateNotes,
  canShowNotes,
  onNotesRowReveal,
  onNotesRevealComplete,
  isWaitingForFinalArtifacts,
  isAwaitingMeetingEnd,
  isTakingLongerThanExpected,
  isDetailTranscriptFinal,
  waitingLines,
  effectivePreparationLines,
  isUpgradePreview,
  shouldShowRejoin,
  isReadOnlyMeetingViewer,
}: {
  meetingId: string;
  summaryContent: string | null;
  isWaitingForWorkspaceReveal: boolean;
  shouldAnimateNotes: boolean;
  canShowNotes: boolean;
  onNotesRowReveal: () => void;
  onNotesRevealComplete: () => void;
  isWaitingForFinalArtifacts: boolean;
  isAwaitingMeetingEnd: boolean;
  isTakingLongerThanExpected: boolean;
  isDetailTranscriptFinal: boolean;
  waitingLines: string[];
  effectivePreparationLines: string[];
  isUpgradePreview: boolean;
  shouldShowRejoin: boolean;
  isReadOnlyMeetingViewer: boolean;
}) {
  return (
    <>
      <h3>{POST_MEETING_WORKSPACE_COPY.overviewHeading}</h3>
      {summaryContent !== null && summaryContent.length > 0 ? (
        !isWaitingForWorkspaceReveal ? (
          <div className="workspace-flow-snapshot">
            <WorkspaceGeneratedNotes
              key={meetingId}
              summary={summaryContent}
              mode={shouldAnimateNotes ? "reveal" : "static"}
              omitLeadingHeading
              onRowReveal={() => {
                if (canShowNotes) {
                  onNotesRowReveal();
                }
              }}
              onRevealComplete={onNotesRevealComplete}
            />
          </div>
        ) : null
      ) : summaryContent !== null ? (
        <MeetingNotesEmptyMessage />
      ) : isWaitingForFinalArtifacts ? (
        <AgentThinkingBlock
          title={getPostMeetingNotesThinkingTitle({ isAwaitingMeetingEnd, isTakingLongerThanExpected })}
          detail={
            isAwaitingMeetingEnd ? (
              !isWaitingForWorkspaceReveal ? (
                <MeetingPreparationProgress key="waiting" lines={waitingLines} />
              ) : null
            ) : isTakingLongerThanExpected ? (
              POST_MEETING_WORKSPACE_COPY.takingLongerDetail
            ) : isDetailTranscriptFinal ? (
              <MeetingPreparationProgress key="generating" lines={effectivePreparationLines} />
            ) : (
              POST_MEETING_WORKSPACE_COPY.finalMomentsDetail
            )
          }
          orbState="breathing"
          className="workspace-meeting-notes-thinking"
        />
      ) : (
        <p className="muted">{POST_MEETING_WORKSPACE_COPY.noSummaryYet}</p>
      )}
      {!isUpgradePreview && shouldShowRejoin && !isWaitingForWorkspaceReveal && !isReadOnlyMeetingViewer ? (
        <MeetingRejoinBanner meetingId={meetingId} />
      ) : null}
    </>
  );
}

function PostMeetingMeetingActionsMenu({
  actionsMenuRef,
  isActionsMenuOpen,
  setIsActionsMenuOpen,
  canShowNotes,
  onCopyTranscript,
  summaryAndTasksClipboard,
  onCopySummaryAndTasks,
  isDeletingMeeting,
  requestDeleteMeeting,
}: {
  actionsMenuRef: RefObject<HTMLDivElement | null>;
  isActionsMenuOpen: boolean;
  setIsActionsMenuOpen: (value: boolean | ((isOpen: boolean) => boolean)) => void;
  canShowNotes: boolean;
  onCopyTranscript: () => void | Promise<void>;
  summaryAndTasksClipboard: { text: string; html: string } | null;
  onCopySummaryAndTasks: () => void | Promise<void>;
  isDeletingMeeting: boolean;
  requestDeleteMeeting: () => void;
}) {
  return (
    <div className="meeting-page-controls">
      <div className="meeting-actions-menu" ref={actionsMenuRef}>
        <button
          type="button"
          className="meeting-actions-trigger"
          aria-label={POST_MEETING_WORKSPACE_COPY.meetingActionsLabel}
          aria-haspopup="menu"
          aria-expanded={isActionsMenuOpen}
          onClick={() => setIsActionsMenuOpen((isOpen) => !isOpen)}
        >
          <EllipsisIcon />
        </button>
        {isActionsMenuOpen ? (
          <div
            className="meeting-actions-popover"
            role="menu"
            aria-label={POST_MEETING_WORKSPACE_COPY.meetingActionsLabel}
          >
            <button
              type="button"
              role="menuitem"
              className="meeting-actions-item"
              disabled={!canShowNotes}
              onClick={() => void onCopyTranscript()}
            >
              <span className="meeting-actions-item-label">{POST_MEETING_WORKSPACE_COPY.copyTranscriptLabel}</span>
              <span className="meeting-actions-item-shortcut" aria-hidden="true">
                <span>{POST_MEETING_WORKSPACE_COPY.shortcutOption}</span>
                <span>{POST_MEETING_WORKSPACE_COPY.shortcutShift}</span>
                <span>{POST_MEETING_WORKSPACE_COPY.shortcutKeyCopy}</span>
              </span>
            </button>
            {summaryAndTasksClipboard ? (
              <button
                type="button"
                role="menuitem"
                className="meeting-actions-item"
                onClick={() => void onCopySummaryAndTasks()}
              >
                <span className="meeting-actions-item-label">{POST_MEETING_WORKSPACE_COPY.copySummaryTasksLabel}</span>
                <span className="meeting-actions-item-shortcut" aria-hidden="true">
                  <span>{POST_MEETING_WORKSPACE_COPY.shortcutOption}</span>
                  <span>{POST_MEETING_WORKSPACE_COPY.shortcutShift}</span>
                  <span>{POST_MEETING_WORKSPACE_COPY.shortcutKeySummary}</span>
                </span>
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="meeting-actions-item is-danger"
              disabled={isDeletingMeeting}
              onClick={requestDeleteMeeting}
            >
              <span className="meeting-actions-item-label">
                {isDeletingMeeting
                  ? POST_MEETING_WORKSPACE_COPY.deletingMeeting
                  : POST_MEETING_WORKSPACE_COPY.deleteMeeting}
              </span>
              <span className="meeting-actions-item-shortcut" aria-hidden="true">
                <span>{POST_MEETING_WORKSPACE_COPY.shortcutOption}</span>
                <span>{POST_MEETING_WORKSPACE_COPY.shortcutShift}</span>
                <span>{POST_MEETING_WORKSPACE_COPY.shortcutKeyDelete}</span>
              </span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function usePostMeetingWorkspaceLifecycleNotices(input: {
  meetingId: string;
  renderedDetail: PostMeetingPayload | null;
  renderedMeetingStatus: PostMeetingPayload["meeting"]["status"] | undefined;
  session: ReturnType<typeof useAuth>["session"];
  isAuthLoading: boolean;
  onMeetingReady?: (meetingId: string) => void;
  meetingLoadFailure: MeetingLoadFailure | null;
  onMeetingLoadFailure?: (failure: MeetingLoadFailure | null) => void;
  setPollAttempts: (value: number | ((current: number) => number)) => void;
  setMeetings: (value: Meeting[]) => void;
  workspaceUserId?: string;
  workspaceId?: string;
}) {
  const {
    meetingId,
    renderedDetail,
    renderedMeetingStatus,
    session,
    isAuthLoading,
    onMeetingReady,
    meetingLoadFailure,
    onMeetingLoadFailure,
    setPollAttempts,
    setMeetings,
    workspaceUserId,
    workspaceId,
  } = input;

  useEffect(() => {
    setPollAttempts(0);
  }, [meetingId, renderedMeetingStatus, setPollAttempts]);

  useEffect(() => {
    if (renderedDetail && session && !isAuthLoading) {
      onMeetingReady?.(meetingId);
    }
  }, [isAuthLoading, meetingId, onMeetingReady, renderedDetail, session]);

  useEffect(() => {
    onMeetingLoadFailure?.(meetingLoadFailure);
  }, [meetingLoadFailure, onMeetingLoadFailure]);

  useEffect(() => {
    setMeetings(getCachedWorkspaceMeetings(workspaceUserId, workspaceId) ?? []);
  }, [setMeetings, workspaceId, workspaceUserId]);
}

function buildPostMeetingMeetingMetaPills(detail: PostMeetingPayload | null) {
  if (!detail) {
    return [];
  }

  return [formatMeetingDateTime(detail.meeting), ...getMeetingParticipantPills(detail)];
}

function buildPostMeetingTranscriptText(detail: MeetingDetailPayload | null) {
  if (!detail) {
    return "";
  }

  return detail.transcriptSegments
    .map((segment) => `${getTranscriptSpeakerLabel(segment)}: ${segment.content}`)
    .join("\n\n");
}

function buildPostMeetingSummaryAndTasksClipboard(input: {
  canShowNotes: boolean;
  renderedDetail: PostMeetingPayload | null;
  summaryContent: string | null;
  effectiveTaskList: PostMeetingPayload["tasks"] | null;
}) {
  const { canShowNotes, renderedDetail, summaryContent, effectiveTaskList } = input;

  if (
    !canShowNotes ||
    renderedDetail === null ||
    summaryContent === null ||
    summaryContent.length === 0 ||
    effectiveTaskList?.status !== "completed"
  ) {
    return null;
  }

  return formatMeetingSummaryAndTasksForClipboard({
    title: renderedDetail.meeting.title,
    dateTime: formatMeetingCopyDateTime(renderedDetail.meeting),
    participants: getMeetingCopyParticipantNames(renderedDetail.meetingRuntime.allHumanParticipants),
    summary: summaryContent,
    tasks: effectiveTaskList.items,
  });
}

async function readTranscriptLoadError(text: Promise<string>): Promise<unknown> {
  try {
    await text;

    return null;
  } catch (error) {
    return error;
  }
}

function usePostMeetingClipboardActions(input: {
  canShowNotes: boolean;
  loadTranscriptText: () => Promise<string>;
  summaryAndTasksClipboard: { text: string; html: string } | null;
  detailMeetingId: string | null;
  showToast: ReturnType<typeof useToast>["showToast"];
  setError: (value: string | null) => void;
  setIsActionsMenuOpen: (value: boolean | ((isOpen: boolean) => boolean)) => void;
}) {
  const {
    canShowNotes,
    loadTranscriptText,
    summaryAndTasksClipboard,
    detailMeetingId,
    showToast,
    setError,
    setIsActionsMenuOpen,
  } = input;

  const onCopyTranscript = useCallback(async () => {
    if (!canShowNotes) {
      return;
    }
    const text = (async () => {
      const value = await loadTranscriptText();
      if (value.length === 0) {
        throw new Error(POST_MEETING_WORKSPACE_COPY.noTranscriptToCopy);
      }

      return value;
    })();
    try {
      // Start the clipboard operation in the click gesture, before the network wait (Safari).
      if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": (async () => new Blob([await text], { type: "text/plain" }))() }),
        ]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      setIsActionsMenuOpen(false);
      setError(null);
      showToast({
        id: `post-meeting-copy-transcript:${detailMeetingId ?? "unknown"}`,
        title: POST_MEETING_WORKSPACE_COPY.transcriptCopiedTitle,
        message: POST_MEETING_WORKSPACE_COPY.transcriptCopiedMessage,
        tone: "success",
      });
    } catch (nextError) {
      // A failed transcript load reaches clipboard.write() as the browser's own error, so prefer our reason.
      const reason = (await readTranscriptLoadError(text)) ?? nextError;
      setError(reason instanceof Error ? reason.message : POST_MEETING_WORKSPACE_COPY.failedToCopyTranscript);
    }
  }, [canShowNotes, detailMeetingId, setError, setIsActionsMenuOpen, showToast, loadTranscriptText]);

  const onCopySummaryAndTasks = useCallback(async () => {
    if (!summaryAndTasksClipboard) {
      setError(POST_MEETING_WORKSPACE_COPY.summaryTasksNotReady);
      setIsActionsMenuOpen(false);

      return;
    }

    try {
      const hasCopiedRichText = await (async () => {
        if (typeof ClipboardItem === "undefined") {
          return false;
        }
        if (typeof navigator.clipboard.write !== "function") {
          return false;
        }
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": new Blob([summaryAndTasksClipboard.text], { type: "text/plain" }),
              "text/html": new Blob([summaryAndTasksClipboard.html], { type: "text/html" }),
            }),
          ]);

          return true;
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }

          return false;
        }
      })();
      if (!hasCopiedRichText) {
        await navigator.clipboard.writeText(summaryAndTasksClipboard.text);
      }
      setIsActionsMenuOpen(false);
      setError(null);
      showToast({
        id: `post-meeting-copy-summary-tasks:${detailMeetingId ?? "unknown"}`,
        title: POST_MEETING_WORKSPACE_COPY.summaryTasksCopiedTitle,
        message: POST_MEETING_WORKSPACE_COPY.summaryTasksCopiedMessage,
        tone: "success",
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : POST_MEETING_WORKSPACE_COPY.failedToCopySummaryTasks);
    }
  }, [detailMeetingId, setError, setIsActionsMenuOpen, showToast, summaryAndTasksClipboard]);

  return { onCopyTranscript, onCopySummaryAndTasks };
}

async function executePostMeetingDeleteMeeting(input: {
  session: NonNullable<ReturnType<typeof useAuth>["session"]>;
  meetingToDelete: Meeting;
  previousMeetings: Meeting[];
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  router: ReturnType<typeof useRouter>;
  onMeetingDeleted?: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  showToast: ReturnType<typeof useToast>["showToast"];
  setError: (value: string | null) => void;
}) {
  const {
    session,
    meetingToDelete,
    previousMeetings,
    detailQueryKey,
    queryClient,
    router,
    onMeetingDeleted,
    showToast,
    setError,
  } = input;
  const remainingMeetings = previousMeetings.filter((meeting) => meeting.id !== meetingToDelete.id);

  setCachedWorkspaceMeetings(session.user.id, session.user.workspaceId, remainingMeetings);
  queryClient.setQueryData(workspaceMeetingsQueryKey(session.user), remainingMeetings);
  queryClient.removeQueries({ queryKey: meetingDetailQueryKey(detailQueryKey[1]) });
  if (onMeetingDeleted) {
    onMeetingDeleted({
      deletedMeetingId: meetingToDelete.id,
      remainingMeetings,
    });
  } else {
    router.push("/workspace");
  }
  showToast({
    id: `post-meeting-remove:${meetingToDelete.id}`,
    title: POST_MEETING_WORKSPACE_COPY.meetingRemovedTitle,
    message: formatMeetingRemovedMessage(meetingToDelete.title),
    tone: "success",
  });

  try {
    await deleteMeeting({ token: session.token, meetingId: meetingToDelete.id });
  } catch (nextError) {
    const message = nextError instanceof Error ? nextError.message : POST_MEETING_WORKSPACE_COPY.failedToDeleteMeeting;
    setCachedWorkspaceMeetings(session.user.id, session.user.workspaceId, previousMeetings);
    queryClient.setQueryData(workspaceMeetingsQueryKey(session.user), previousMeetings);
    setError(message);
    showToast({
      id: `post-meeting-remove-error:${meetingToDelete.id}`,
      title: POST_MEETING_WORKSPACE_COPY.meetingRestoredTitle,
      message,
      tone: "warning",
    });
  }
}

function usePostMeetingDeleteMeetingHandlers(input: {
  renderedDetail: PostMeetingPayload | null;
  onRequestDeleteMeeting?: (meeting: Meeting) => void;
  session: ReturnType<typeof useAuth>["session"];
  deleteDialogMeeting: Meeting | null;
  meetings: Meeting[];
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  router: ReturnType<typeof useRouter>;
  onMeetingDeleted?: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  showToast: ReturnType<typeof useToast>["showToast"];
  setIsActionsMenuOpen: (value: boolean | ((isOpen: boolean) => boolean)) => void;
  setDeleteDialogError: (value: string | null) => void;
  setDeleteDialogMeeting: (value: Meeting | null) => void;
  setIsDeletingMeeting: (value: boolean) => void;
  setError: (value: string | null) => void;
}) {
  const {
    renderedDetail,
    onRequestDeleteMeeting,
    session,
    deleteDialogMeeting,
    meetings,
    detailQueryKey,
    queryClient,
    router,
    onMeetingDeleted,
    showToast,
    setIsActionsMenuOpen,
    setDeleteDialogError,
    setDeleteDialogMeeting,
    setIsDeletingMeeting,
    setError,
  } = input;

  const requestDeleteMeeting = useCallback(() => {
    if (!renderedDetail) {
      return;
    }

    setIsActionsMenuOpen(false);
    setDeleteDialogError(null);
    if (onRequestDeleteMeeting) {
      onRequestDeleteMeeting(renderedDetail.meeting);

      return;
    }

    setDeleteDialogMeeting(renderedDetail.meeting);
  }, [onRequestDeleteMeeting, renderedDetail, setDeleteDialogError, setDeleteDialogMeeting, setIsActionsMenuOpen]);

  const confirmDeleteMeeting = useCallback(async () => {
    if (!session || !deleteDialogMeeting) {
      return;
    }

    const meetingToDelete = deleteDialogMeeting;
    const previousMeetings = meetings;

    setIsDeletingMeeting(true);
    setDeleteDialogError(null);
    setError(null);
    setDeleteDialogMeeting(null);
    setIsActionsMenuOpen(false);

    try {
      await executePostMeetingDeleteMeeting({
        session,
        meetingToDelete,
        previousMeetings,
        detailQueryKey,
        queryClient,
        router,
        onMeetingDeleted,
        showToast,
        setError,
      });
    } finally {
      setIsDeletingMeeting(false);
    }
  }, [
    deleteDialogMeeting,
    detailQueryKey,
    meetings,
    onMeetingDeleted,
    queryClient,
    router,
    session,
    setDeleteDialogError,
    setDeleteDialogMeeting,
    setError,
    setIsActionsMenuOpen,
    setIsDeletingMeeting,
    showToast,
  ]);

  return { requestDeleteMeeting, confirmDeleteMeeting };
}

function usePostMeetingActionKeyboardShortcuts(input: {
  shouldShowActionsMenu: boolean;
  onCopyTranscript: () => void | Promise<void>;
  onCopySummaryAndTasks: () => void | Promise<void>;
  requestDeleteMeeting: () => void;
  isDeletingMeeting: boolean;
  summaryAndTasksClipboard: { text: string; html: string } | null;
}) {
  const {
    shouldShowActionsMenu,
    onCopyTranscript,
    onCopySummaryAndTasks,
    requestDeleteMeeting,
    isDeletingMeeting,
    summaryAndTasksClipboard,
  } = input;

  useEffect(() => {
    if (!shouldShowActionsMenu) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) {
        return;
      }

      if (isAltShiftShortcut({ event, code: KEY_CODE_C })) {
        event.preventDefault();
        void onCopyTranscript();

        return;
      }

      if (isAltShiftShortcut({ event, code: KEY_CODE_S }) && summaryAndTasksClipboard) {
        event.preventDefault();
        void onCopySummaryAndTasks();

        return;
      }

      if (isAltShiftShortcut({ event, code: KEY_CODE_D }) && !isDeletingMeeting) {
        event.preventDefault();
        requestDeleteMeeting();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    shouldShowActionsMenu,
    onCopyTranscript,
    onCopySummaryAndTasks,
    requestDeleteMeeting,
    isDeletingMeeting,
    summaryAndTasksClipboard,
  ]);
}

function usePostMeetingInProgressNotesAnimation(input: {
  isAwaitingMeetingEnd: boolean;
  setShouldAnimateNotes: (value: boolean) => void;
}) {
  const { isAwaitingMeetingEnd, setShouldAnimateNotes } = input;

  useEffect(() => {
    if (isAwaitingMeetingEnd && shouldAnimateWorkspaceNotesReveal()) {
      setShouldAnimateNotes(true);
    }
  }, [isAwaitingMeetingEnd, setShouldAnimateNotes]);
}

function resolvePostMeetingBillingNotesAccess(input: {
  paymentStatus: "processing" | "failed" | undefined;
  isAwaitingMeetingEnd: boolean;
  renderedDetail: PostMeetingPayload | null;
}) {
  const { paymentStatus, isAwaitingMeetingEnd, renderedDetail } = input;

  if (paymentStatus === "processing" && !isAwaitingMeetingEnd) {
    return { /** @external locked */ locked: true, reason: "upgrade_required" as const };
  }

  return renderedDetail?.notesAccess ?? { locked: false, reason: null };
}

function resolvePostMeetingNotesGateFlags(input: {
  renderedDetail: PostMeetingPayload | null;
  notesAccess: PostMeetingPayload["notesAccess"];
  hasKnownBilling: boolean;
  isUpgradePreview: boolean;
}) {
  const { renderedDetail, notesAccess, hasKnownBilling, isUpgradePreview } = input;
  const hasNotesArtifact = hasPostMeetingNotesArtifact(renderedDetail);
  const shouldShowNotesAccessGate =
    renderedDetail?.postMeetingDisposition?.status !== "skipped" &&
    notesAccess.locked &&
    (hasKnownBilling || !isUpgradePreview) &&
    (!isUpgradePreview || hasNotesArtifact);

  return {
    shouldShowNotesAccessGate,
    canDisplayNotes: !shouldShowNotesAccessGate,
    isPreviewReady: renderedDetail?.notesPreview?.status === "ready",
  };
}

function resolveShouldRunPostMeetingTasks(input: {
  canShowNotes: boolean;
  sessionToken: string | null;
  detailMeetingId: string | null;
  summaryContent: string | null;
  isNotesRevealComplete: boolean;
  hasStablePostCallNotes: boolean;
}) {
  const { canShowNotes, sessionToken, detailMeetingId, summaryContent, isNotesRevealComplete, hasStablePostCallNotes } =
    input;

  return (
    canShowNotes &&
    sessionToken !== null &&
    sessionToken.length > 0 &&
    detailMeetingId !== null &&
    summaryContent !== null &&
    isNotesRevealComplete &&
    hasStablePostCallNotes
  );
}

function buildPostMeetingTaskAssignees(renderedDetail: PostMeetingPayload | null) {
  return (renderedDetail?.meetingRuntime.allHumanParticipants ?? []).map((participant) => ({
    userId: participant.userId,
    displayName: participant.displayName,
    email: participant.email ?? null,
    avatarUrl: "avatarUrl" in participant ? (participant.avatarUrl ?? null) : null,
  }));
}

function resolvePostMeetingTasksPhase(input: {
  hasEffectiveTasksTerminal: boolean;
  shouldRunTasks: boolean;
}): "idle" | "loading" | "complete" {
  if (input.hasEffectiveTasksTerminal) {
    return "complete";
  }

  if (input.shouldRunTasks) {
    return "loading";
  }

  return "idle";
}

function resolvePostMeetingRenderedDetail(input: {
  unavailableMeetingId: string | null;
  meetingId: string;
  cachedDetail: PostMeetingPayload | null;
  detailQueryData: PostMeetingPayload | undefined;
  detail: PostMeetingPayload | null;
}) {
  const { unavailableMeetingId, meetingId, cachedDetail, detailQueryData, detail } = input;

  if (unavailableMeetingId === meetingId) {
    return null;
  }

  return (
    cachedDetail ??
    getExactMeetingDetail({ detail: detailQueryData, meetingId }) ??
    getExactMeetingDetail({ detail, meetingId })
  );
}

function resolveHasLockedPreviewPollingExpired(input: {
  renderedDetail: PostMeetingPayload | null;
  pollAttempts: number;
}) {
  const { renderedDetail, pollAttempts } = input;

  return (
    renderedDetail?.notesAccess.locked === true &&
    renderedDetail.meeting.status === "ended" &&
    pollAttempts >= NOTES_SLOW_POLL_ATTEMPTS
  );
}

function resolvePostMeetingLoadFailure(input: {
  renderedDetail: PostMeetingPayload | null;
  error: string | null;
  unavailableMeetingId: string | null;
  meetingId: string;
  retry: () => void;
}): MeetingLoadFailure | null {
  const { renderedDetail, error, unavailableMeetingId, meetingId, retry } = input;

  if (renderedDetail !== null || error === null || error.length === 0) {
    return null;
  }

  return {
    meetingId,
    message:
      unavailableMeetingId === meetingId
        ? POST_MEETING_WORKSPACE_COPY.meetingUnavailable
        : POST_MEETING_WORKSPACE_COPY.unableToLoadMeeting,
    retry,
  };
}

function shouldShowPostMeetingWorkspaceTasksSection(input: {
  canDisplayNotes: boolean;
  summaryContent: string | null;
  isNotesRevealComplete: boolean;
}) {
  const { canDisplayNotes, summaryContent, isNotesRevealComplete } = input;

  return canDisplayNotes && summaryContent !== null && isNotesRevealComplete;
}

function shouldShowStandalonePostMeetingAshbyReview(input: {
  canDisplayNotes: boolean;
  summaryContent: string | null;
  isNotesRevealComplete: boolean;
  tasksPhase: "idle" | "loading" | "complete";
  sessionToken: string | null;
}) {
  const { canDisplayNotes, summaryContent, isNotesRevealComplete, tasksPhase, sessionToken } = input;

  if (!canDisplayNotes || tasksPhase !== "complete" || sessionToken === null || sessionToken.length === 0) {
    return false;
  }

  const hasRevealedSummary = summaryContent !== null && isNotesRevealComplete;

  return !hasRevealedSummary;
}

function resolvePostMeetingShouldFollowWorkspaceReveal(input: {
  canShowNotes: boolean;
  summaryContent: string | null;
  isWaitingForWorkspaceReveal: boolean;
  shouldAnimateNotes: boolean;
  isNotesRevealComplete: boolean;
  tasksPhase: "idle" | "loading" | "complete";
  linearTaskReviewStatus: LinearTaskReviewRun["status"] | undefined;
}) {
  const {
    canShowNotes,
    summaryContent,
    isWaitingForWorkspaceReveal,
    shouldAnimateNotes,
    isNotesRevealComplete,
    tasksPhase,
    linearTaskReviewStatus,
  } = input;

  if (!canShowNotes || summaryContent === null) {
    return false;
  }

  return (
    isWaitingForWorkspaceReveal ||
    (shouldAnimateNotes && !isNotesRevealComplete) ||
    tasksPhase === "loading" ||
    linearTaskReviewStatus === "reviewing" ||
    linearTaskReviewStatus === "revising"
  );
}

function resolvePostMeetingWaitingForFinalArtifacts(renderedDetail: PostMeetingPayload) {
  return (
    renderedDetail.meeting.status !== "ended" ||
    !(renderedDetail.transcript?.isFinal ?? false) ||
    (renderedDetail.summary === null &&
      (!renderedDetail.notesAccess.locked || renderedDetail.notesPreview?.status === "pending"))
  );
}

function resolvePostMeetingDisplayMeetingTitle(input: {
  renderedDetail: PostMeetingPayload;
  isWaitingForFinalArtifacts: boolean;
  fallbackTitle: string;
}) {
  const { renderedDetail, isWaitingForFinalArtifacts, fallbackTitle } = input;

  if (shouldHideGenericMeetingTitle(renderedDetail) && isWaitingForFinalArtifacts) {
    return POST_MEETING_WORKSPACE_COPY.finalizingTitle;
  }

  if (renderedDetail.meeting.title.length > 0) {
    return renderedDetail.meeting.title;
  }

  return fallbackTitle;
}

function resolvePostMeetingTasksError(input: {
  taskStatusError: string | null | undefined;
  effectiveTaskListStatus: string | null | undefined;
}) {
  const { taskStatusError, effectiveTaskListStatus } = input;

  if (taskStatusError !== null && taskStatusError !== undefined && taskStatusError.length > 0) {
    return taskStatusError;
  }

  if (effectiveTaskListStatus === "failed") {
    return POST_MEETING_WORKSPACE_COPY.tasksNotPrepared;
  }

  return null;
}

/** A ready preview may be empty (a tasks-only summary); only a pending preview is missing. */
function resolvePostMeetingPreviewContent(input: {
  notesPreview: PostMeetingPayload["notesPreview"] | undefined;
  fullSummaryContent: string | null;
}) {
  const { notesPreview, fullSummaryContent } = input;
  if (notesPreview !== null && notesPreview !== undefined) {
    return notesPreview.status === "ready" ? notesPreview.content : null;
  }

  return fullSummaryContent === null ? null : buildMeetingNotesPreview(fullSummaryContent);
}

function resolvePostMeetingSummaryContent(input: {
  isAwaitingMeetingEnd: boolean;
  renderedDetail: PostMeetingPayload | null;
  isUpgradePreview: boolean;
  shouldShowNotesAccessGate: boolean;
}) {
  const { isAwaitingMeetingEnd, renderedDetail, isUpgradePreview, shouldShowNotesAccessGate } = input;
  const summaryBody = renderedDetail?.summary?.content;
  // A stored summary is final, so its notes resolve even when only a task section (or nothing) remains.
  const fullSummaryContent =
    !isAwaitingMeetingEnd && summaryBody !== undefined ? stripSummaryTaskSection(summaryBody) : null;
  const previewContent = resolvePostMeetingPreviewContent({
    notesPreview: renderedDetail?.notesPreview,
    fullSummaryContent,
  });

  if (isUpgradePreview && shouldShowNotesAccessGate) {
    return previewContent;
  }

  return fullSummaryContent ?? (isUpgradePreview ? previewContent : null);
}

function PostMeetingWorkspaceScrollToBottomButton({
  canShowNotes,
  isUserAwayFromBottom,
  onScrollToBottom,
}: {
  canShowNotes: boolean;
  isUserAwayFromBottom: boolean;
  onScrollToBottom: () => void;
}) {
  if (!canShowNotes || !isUserAwayFromBottom) {
    return null;
  }

  return (
    <button
      type="button"
      className="workspace-scroll-bottom-button"
      onClick={onScrollToBottom}
      aria-label={POST_MEETING_WORKSPACE_COPY.scrollToLatestLabel}
    >
      <svg aria-hidden="true" viewBox="0 0 32 32" className="workspace-scroll-bottom-icon">
        <path d="M16 4.5V27.5M6.5 18L16 27.5L25.5 18" />
      </svg>
    </button>
  );
}

function PostMeetingWorkspaceNotesAccessSection({
  shouldShowNotesAccessGate,
  isUpgradePreview,
  notesOverview,
  notesAccess,
  paymentStatus,
  workspaceToken,
  workspaceId,
  billing,
  hasKnownBilling,
}: {
  shouldShowNotesAccessGate: boolean;
  isUpgradePreview: boolean;
  notesOverview: ReactNode;
  notesAccess: PostMeetingPayload["notesAccess"];
  paymentStatus?: "processing" | "failed";
  workspaceToken: string;
  workspaceId: string;
  billing: ReturnType<typeof useTrialOffer>;
  hasKnownBilling: boolean;
}) {
  return (
    <>
      {shouldShowNotesAccessGate && isUpgradePreview ? (
        <div className="meeting-notes-upgrade">
          <div className="meeting-notes-upgrade-preview" aria-hidden="true" inert>
            <section className="workspace-document-section">{notesOverview}</section>
          </div>
          <MeetingNotesLockedCard
            reason={notesAccess.reason}
            paymentStatus={paymentStatus}
            token={workspaceToken}
            workspaceId={workspaceId}
          />
        </div>
      ) : shouldShowNotesAccessGate ? (
        <MeetingNotesLockedCard reason={notesAccess.reason} token={workspaceToken} workspaceId={workspaceId} />
      ) : (
        notesOverview
      )}
      {billing.isError && !hasKnownBilling ? (
        <p role="alert">
          {POST_MEETING_WORKSPACE_COPY.planCheckFailed}
          <button onClick={() => void billing.refetch()}>{POST_MEETING_WORKSPACE_COPY.tryAgain}</button>
        </p>
      ) : null}
    </>
  );
}

function PostMeetingWorkspaceSourceSegmentSection({
  canShowNotes,
  sourceSegmentId,
  meetingId,
}: {
  canShowNotes: boolean;
  sourceSegmentId: string | null;
  meetingId: string;
}) {
  const { session } = useAuth();
  const options = meetingDetailOptions({ session, meetingId });
  const transcriptQuery = useQuery({
    ...options,
    enabled: options.enabled === true && canShowNotes && Boolean(sourceSegmentId),
  });
  if (!canShowNotes || sourceSegmentId === null || sourceSegmentId.length === 0) {
    return null;
  }

  return (
    <section
      className="workspace-document-section relationship-transcript-excerpt"
      aria-label={POST_MEETING_WORKSPACE_COPY.sourceExcerptLabel}
    >
      <h3>{POST_MEETING_WORKSPACE_COPY.sourceTranscriptHeading}</h3>
      {transcriptQuery.isError ? (
        <button type="button" onClick={() => void transcriptQuery.refetch()}>
          Retry loading transcript
        </button>
      ) : !transcriptQuery.data ? (
        <p role="status">{POST_MEETING_WORKSPACE_COPY.loadingTranscript}</p>
      ) : transcriptQuery.data.notesAccess.locked ? (
        <p>{POST_MEETING_WORKSPACE_COPY.transcriptUnavailable}</p>
      ) : (
        <PostMeetingSourceTranscriptExcerpt
          segments={transcriptQuery.data.transcriptSegments}
          sourceSegmentId={sourceSegmentId}
        />
      )}
    </section>
  );
}

function usePostMeetingLinearReview({
  sessionToken,
  canDisplayNotes,
  isNotesRevealComplete,
  sessionUserId,
  renderedDetail,
  meetingId,
}: {
  sessionToken: string | null;
  canDisplayNotes: boolean;
  isNotesRevealComplete: boolean;
  sessionUserId: string | undefined;
  renderedDetail: PostMeetingPayload | null;
  meetingId: string;
}) {
  return useQuery({
    queryKey: meetingLinearTaskReviewQueryKey(meetingId),
    queryFn: () => {
      if (sessionToken === null || sessionToken === "") {
        throw new Error(POST_MEETING_WORKSPACE_COPY.transcriptUnavailable);
      }

      return getMeetingLinearTaskReview({ token: sessionToken, meetingId });
    },
    enabled:
      Boolean(sessionToken) &&
      renderedDetail !== null &&
      !renderedDetail.notesAccess.locked &&
      canDisplayNotes &&
      isNotesRevealComplete &&
      sessionUserId === renderedDetail.meeting.createdByUserId,
    staleTime: LINEAR_REVIEW_STALE_MS,
    refetchInterval: (query) =>
      ["queued", "reviewing", "revising", "syncing"].includes(query.state.data?.status ?? "")
        ? LINEAR_REVIEW_POLL_MS
        : false,
  });
}

function PostMeetingWorkspaceTasksPanel({
  canDisplayNotes,
  summaryContent,
  isNotesRevealComplete,
  tasksPhase,
  sessionToken,
  effectiveTaskList,
  taskStatus,
  meetingId,
  taskAssignees,
  tasksError,
  refresh,
  workspaceUserId,
  renderedDetail,
  linearTaskReview,
  sessionUserId,
}: {
  canDisplayNotes: boolean;
  summaryContent: string | null;
  isNotesRevealComplete: boolean;
  tasksPhase: "idle" | "loading" | "complete";
  sessionToken: string | null;
  effectiveTaskList: PostMeetingPayload["tasks"] | null;
  taskStatus: ReturnType<typeof useMeetingTasksStatus> | undefined;
  meetingId: string;
  taskAssignees: ReturnType<typeof buildPostMeetingTaskAssignees>;
  tasksError: string | null;
  refresh: () => Promise<void>;
  workspaceUserId: string;
  renderedDetail: PostMeetingPayload;
  linearTaskReview: LinearTaskReviewRun | null;
  sessionUserId: string;
}) {
  const queryClient = useQueryClient();
  const shouldShowTasksSection =
    tasksPhase === "complete" &&
    shouldShowPostMeetingWorkspaceTasksSection({
      canDisplayNotes,
      summaryContent,
      isNotesRevealComplete,
    });
  const shouldShowStandaloneAshby = shouldShowStandalonePostMeetingAshbyReview({
    canDisplayNotes,
    summaryContent,
    isNotesRevealComplete,
    tasksPhase,
    sessionToken,
  });

  return (
    <>
      {shouldShowTasksSection ? (
        <WorkspaceTasksSection
          taskList={effectiveTaskList}
          phase={tasksPhase}
          generationPhase={taskStatus?.phase}
          generationProgress={taskStatus?.progress}
          token={sessionToken ?? undefined}
          meetingId={meetingId}
          participants={taskAssignees}
          hiddenTaskIds={[]}
          error={tasksError}
          onUpdated={() => void refresh()}
          currentUserId={workspaceUserId}
          linearTaskReview={linearTaskReview}
          onLinearTaskReviewChanged={(review) => {
            queryClient.setQueryData(meetingLinearTaskReviewQueryKey(meetingId), review);
          }}
          postTaskReview={
            <PostMeetingPostTaskReviewContent
              tasksPhase={tasksPhase}
              sessionToken={sessionToken}
              meetingId={meetingId}
              workspaceUserId={workspaceUserId}
              meetingCreatedByUserId={renderedDetail.meeting.createdByUserId}
              sessionUserId={sessionUserId}
            />
          }
        />
      ) : null}
      {shouldShowStandaloneAshby && sessionToken !== null ? (
        <AshbyMeetingReview key={`${meetingId}:${workspaceUserId}`} meetingId={meetingId} token={sessionToken} />
      ) : null}
    </>
  );
}

function PostMeetingWorkspaceDocumentStack({
  canShowNotes,
  sourceSegmentId,
  renderedDetail,
  shouldShowNotesAccessGate,
  isUpgradePreview,
  notesOverview,
  notesAccess,
  paymentStatus,
  workspaceToken,
  workspaceId,
  billing,
  hasKnownBilling,
  canDisplayNotes,
  summaryContent,
  isNotesRevealComplete,
  effectiveTaskList,
  tasksPhase,
  taskStatus,
  sessionToken,
  meetingId,
  taskAssignees,
  tasksError,
  refresh,
  workspaceUserId,
  linearTaskReview,
  sessionUserId,
}: {
  canShowNotes: boolean;
  sourceSegmentId: string | null;
  renderedDetail: PostMeetingPayload;
  shouldShowNotesAccessGate: boolean;
  isUpgradePreview: boolean;
  notesOverview: ReactNode;
  notesAccess: PostMeetingPayload["notesAccess"];
  paymentStatus?: "processing" | "failed";
  workspaceToken: string;
  workspaceId: string;
  billing: ReturnType<typeof useTrialOffer>;
  hasKnownBilling: boolean;
  canDisplayNotes: boolean;
  summaryContent: string | null;
  isNotesRevealComplete: boolean;
  effectiveTaskList: PostMeetingPayload["tasks"] | null;
  tasksPhase: "idle" | "loading" | "complete";
  taskStatus: ReturnType<typeof useMeetingTasksStatus> | undefined;
  sessionToken: string | null;
  meetingId: string;
  taskAssignees: ReturnType<typeof buildPostMeetingTaskAssignees>;
  tasksError: string | null;
  refresh: () => Promise<void>;
  workspaceUserId: string;
  linearTaskReview: LinearTaskReviewRun | null;
  sessionUserId: string;
}) {
  return (
    <div className="workspace-document-stack">
      <PostMeetingWorkspaceSourceSegmentSection
        canShowNotes={canShowNotes}
        sourceSegmentId={sourceSegmentId}
        meetingId={renderedDetail.meeting.id}
      />
      <div className="workspace-document-section">
        <PostMeetingWorkspaceNotesAccessSection
          shouldShowNotesAccessGate={shouldShowNotesAccessGate}
          isUpgradePreview={isUpgradePreview}
          notesOverview={notesOverview}
          notesAccess={notesAccess}
          paymentStatus={paymentStatus}
          workspaceToken={workspaceToken}
          workspaceId={workspaceId}
          billing={billing}
          hasKnownBilling={hasKnownBilling}
        />
      </div>
      <PostMeetingWorkspaceTasksPanel
        canDisplayNotes={canDisplayNotes}
        summaryContent={summaryContent}
        isNotesRevealComplete={isNotesRevealComplete}
        tasksPhase={tasksPhase}
        sessionToken={sessionToken}
        effectiveTaskList={effectiveTaskList}
        taskStatus={taskStatus}
        meetingId={meetingId}
        taskAssignees={taskAssignees}
        tasksError={tasksError}
        refresh={refresh}
        workspaceUserId={workspaceUserId}
        renderedDetail={renderedDetail}
        linearTaskReview={linearTaskReview}
        sessionUserId={sessionUserId}
      />
    </div>
  );
}

function resolvePostMeetingIsAwaitingMeetingEnd(renderedDetail: PostMeetingPayload | null) {
  if (renderedDetail === null) {
    return false;
  }

  return renderedDetail.meeting.status !== "ended" || renderedDetail.meetingRuntime.isAwaitingMeetingEnd;
}

function resolvePostMeetingWorkspaceMeetingContext(renderedDetail: PostMeetingPayload | null) {
  const detailMeetingId = renderedDetail?.meeting.id ?? null;
  const detailMeetingStatus = renderedDetail?.meeting.status ?? null;
  const isReadOnlyMeetingViewer = renderedDetail?.meeting.viewerRole === "workspace";
  const isDetailTranscriptFinal = renderedDetail?.transcript?.isFinal ?? false;
  const detailSummaryId = renderedDetail?.summary?.id ?? null;
  const isAwaitingMeetingEnd = resolvePostMeetingIsAwaitingMeetingEnd(renderedDetail);
  const hasStablePostCallNotes = detailMeetingStatus === "ended" && isDetailTranscriptFinal && detailSummaryId !== null;

  return {
    detailMeetingId,
    detailMeetingStatus,
    isReadOnlyMeetingViewer,
    isDetailTranscriptFinal,
    detailSummaryId,
    isAwaitingMeetingEnd,
    hasStablePostCallNotes,
  };
}

function usePostMeetingWorkspaceBillingSummaryState(input: {
  session: ReturnType<typeof useAuth>["session"];
  renderedDetail: PostMeetingPayload | null;
  isAwaitingMeetingEnd: boolean;
}) {
  const { session, renderedDetail, isAwaitingMeetingEnd } = input;
  const billing = useTrialOffer(session?.token, session?.user.workspaceId);
  const hasKnownBilling = billing.hasKnownPlan;
  const paymentStatus = billing.data?.checkout?.kind === "subscription" ? billing.data.checkout.status : undefined;
  const notesAccess = resolvePostMeetingBillingNotesAccess({
    paymentStatus,
    isAwaitingMeetingEnd,
    renderedDetail,
  });
  const isUpgradePreview = notesAccess.reason === "upgrade_required";
  const { shouldShowNotesAccessGate, canDisplayNotes, isPreviewReady } = resolvePostMeetingNotesGateFlags({
    renderedDetail,
    notesAccess,
    hasKnownBilling,
    isUpgradePreview,
  });
  const canShowNotes = hasKnownBilling && !notesAccess.locked;
  const summaryContent = resolvePostMeetingSummaryContent({
    isAwaitingMeetingEnd,
    renderedDetail,
    isUpgradePreview,
    shouldShowNotesAccessGate,
  });

  return {
    billing,
    hasKnownBilling,
    paymentStatus,
    notesAccess,
    isUpgradePreview,
    shouldShowNotesAccessGate,
    canDisplayNotes,
    isPreviewReady,
    canShowNotes,
    summaryContent,
  };
}

function usePostMeetingWorkspaceQuerySyncEffects(input: {
  meetingId: string;
  userId?: string;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  didInitializeMeetingRef: RefObject<boolean>;
  snapshotRunMeetingIdRef: RefObject<string | null>;
  setDetail: (value: PostMeetingPayload | null) => void;
  setError: (value: string | null) => void;
  setUnavailableMeetingId: (value: string | null) => void;
  setPollAttempts: (value: number | ((current: number) => number)) => void;
  setIsWaitingForWorkspaceReveal: (value: boolean) => void;
  setShouldAnimateNotes: (value: boolean) => void;
  setIsNotesRevealComplete: (value: boolean) => void;
  setPreparationLines: (value: string[] | null) => void;
  setWaitingPreparationLines: (value: string[]) => void;
  setDeleteDialogMeeting: (value: Meeting | null) => void;
  setDeleteDialogError: (value: string | null) => void;
  meetingsQueryData: Meeting[] | undefined;
  detailQueryData: PostMeetingPayload | undefined;
  detailQueryError: unknown;
  refresh: () => Promise<void>;
  session: ReturnType<typeof useAuth>["session"];
  setMeetings: (value: Meeting[]) => void;
  renderedDetail: PostMeetingPayload | null;
  hasLockedPreviewPollingExpired: boolean;
  pollAttempts: number;
  isAuthLoading: boolean;
  onMeetingReady?: (meetingId: string) => void;
  meetingLoadFailure: MeetingLoadFailure | null;
  onMeetingLoadFailure?: (failure: MeetingLoadFailure | null) => void;
  workspaceUserId?: string;
  workspaceId?: string;
}) {
  usePostMeetingMeetingSwitchHandoff({
    meetingId: input.meetingId,
    userId: input.userId,
    detailQueryKey: input.detailQueryKey,
    queryClient: input.queryClient,
    didInitializeMeetingRef: input.didInitializeMeetingRef,
    snapshotRunMeetingIdRef: input.snapshotRunMeetingIdRef,
    setDetail: input.setDetail,
    setError: input.setError,
    setUnavailableMeetingId: input.setUnavailableMeetingId,
    setPollAttempts: input.setPollAttempts,
    setIsWaitingForWorkspaceReveal: input.setIsWaitingForWorkspaceReveal,
    setShouldAnimateNotes: input.setShouldAnimateNotes,
    setIsNotesRevealComplete: input.setIsNotesRevealComplete,
    setPreparationLines: input.setPreparationLines,
    setWaitingPreparationLines: input.setWaitingPreparationLines,
    setDeleteDialogMeeting: input.setDeleteDialogMeeting,
    setDeleteDialogError: input.setDeleteDialogError,
  });
  usePostMeetingQueryResultSync({
    meetingsQueryData: input.meetingsQueryData,
    detailQueryData: input.detailQueryData,
    detailQueryError: input.detailQueryError,
    detailQueryKey: input.detailQueryKey,
    meetingId: input.meetingId,
    queryClient: input.queryClient,
    refresh: input.refresh,
    session: input.session,
    setMeetings: input.setMeetings,
    setDetail: input.setDetail,
    setUnavailableMeetingId: input.setUnavailableMeetingId,
    setError: input.setError,
  });
  usePostMeetingTranscriptDetailPolling({
    session: input.session,
    renderedDetail: input.renderedDetail,
    hasLockedPreviewPollingExpired: input.hasLockedPreviewPollingExpired,
    pollAttempts: input.pollAttempts,
    refresh: input.refresh,
    setError: input.setError,
    setPollAttempts: input.setPollAttempts,
  });
  usePostMeetingWorkspaceLifecycleNotices({
    meetingId: input.meetingId,
    renderedDetail: input.renderedDetail,
    renderedMeetingStatus: input.renderedDetail?.meeting.status,
    session: input.session,
    isAuthLoading: input.isAuthLoading,
    onMeetingReady: input.onMeetingReady,
    meetingLoadFailure: input.meetingLoadFailure,
    onMeetingLoadFailure: input.onMeetingLoadFailure,
    setPollAttempts: input.setPollAttempts,
    setMeetings: input.setMeetings,
    workspaceUserId: input.workspaceUserId,
    workspaceId: input.workspaceId,
  });
}

function usePostMeetingWorkspaceNotesGenerationEffects(input: {
  sessionToken: string | null;
  meetingId: string;
  isAwaitingMeetingEnd: boolean;
  isNotesAccessLocked: boolean;
  setWaitingPreparationLines: (value: string[]) => void;
  detailMeetingStatus: PostMeetingPayload["meeting"]["status"] | null;
  preparationLines: string[] | null;
  summaryContent: string | null;
  isUpgradePreview: boolean;
  hasLockedPreviewPollingExpired: boolean;
  setPreparationLines: (value: string[] | null) => void;
  detailMeetingId: string | null;
  isReadOnlyMeetingViewer: boolean;
  isDetailTranscriptFinal: boolean;
  detailSummaryId: string | null;
  isPreviewReady: boolean;
  snapshotRunMeetingIdRef: RefObject<string | null>;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  refresh: () => Promise<void>;
  setError: (value: string | null) => void;
}) {
  usePostMeetingAwaitingPreparationPreview({
    sessionToken: input.sessionToken,
    meetingId: input.meetingId,
    isAwaitingMeetingEnd: input.isAwaitingMeetingEnd,
    isNotesAccessLocked: input.isNotesAccessLocked,
    setWaitingPreparationLines: input.setWaitingPreparationLines,
  });
  usePostMeetingEndedPreparationLines({
    sessionToken: input.sessionToken,
    meetingId: input.meetingId,
    detailMeetingStatus: input.detailMeetingStatus,
    preparationLines: input.preparationLines,
    summaryContent: input.summaryContent,
    isNotesAccessLocked: input.isNotesAccessLocked,
    isUpgradePreview: input.isUpgradePreview,
    hasLockedPreviewPollingExpired: input.hasLockedPreviewPollingExpired,
    setPreparationLines: input.setPreparationLines,
  });
  usePostMeetingMeetingSnapshotRun({
    sessionToken: input.sessionToken,
    detailMeetingId: input.detailMeetingId,
    isReadOnlyMeetingViewer: input.isReadOnlyMeetingViewer,
    isNotesAccessLocked: input.isNotesAccessLocked,
    detailMeetingStatus: input.detailMeetingStatus,
    isDetailTranscriptFinal: input.isDetailTranscriptFinal,
    detailSummaryId: input.detailSummaryId,
    isPreviewReady: input.isPreviewReady,
    snapshotRunMeetingIdRef: input.snapshotRunMeetingIdRef,
    detailQueryKey: input.detailQueryKey,
    queryClient: input.queryClient,
    refresh: input.refresh,
    setError: input.setError,
  });
}

function usePostMeetingWorkspaceLocalState(input: {
  meetingId: string;
  session: ReturnType<typeof useAuth>["session"];
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { meetingId, session, queryClient } = input;
  const [meetings, setMeetings] = useState<Meeting[]>(
    () => getCachedWorkspaceMeetings(session?.user.id, session?.user.workspaceId) ?? [],
  );
  const [detail, setDetail] = useState<PostMeetingPayload | null>(
    () =>
      queryClient.getQueryData<PostMeetingPayload>(meetingNotesViewQueryKey(meetingId)) ??
      readEndMeetingDetailHandoff({ meetingId, userId: session?.user.id }),
  );
  const [error, setError] = useState<string | null>(null);
  const [unavailableMeetingId, setUnavailableMeetingId] = useState<string | null>(null);
  const [pollAttempts, setPollAttempts] = useState(0);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [isDeletingMeeting, setIsDeletingMeeting] = useState(false);
  const [deleteDialogMeeting, setDeleteDialogMeeting] = useState<Meeting | null>(null);
  const [deleteDialogError, setDeleteDialogError] = useState<string | null>(null);
  const [isNotesRevealComplete, setIsNotesRevealComplete] = useState(false);
  const [waitingPreparationLines, setWaitingPreparationLines] = useState<string[]>([]);
  const [preparationLines, setPreparationLines] = useState<string[] | null>(() =>
    readMeetingPreparationHandoff(meetingId, session?.user.id),
  );
  const [isWaitingForWorkspaceReveal, setIsWaitingForWorkspaceReveal] = useState(
    () => getWorkspaceNotesRevealState(meetingId).isWaiting,
  );
  const [shouldAnimateNotes, setShouldAnimateNotes] = useState(
    () => getWorkspaceNotesRevealState(meetingId).shouldAnimate,
  );
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const contentEndRef = useRef<HTMLDivElement | null>(null);
  const snapshotRunMeetingIdRef = useRef<string | null>(null);
  const didInitializeMeetingRef = useRef(false);

  return {
    meetings,
    setMeetings,
    detail,
    setDetail,
    error,
    setError,
    unavailableMeetingId,
    setUnavailableMeetingId,
    pollAttempts,
    setPollAttempts,
    isActionsMenuOpen,
    setIsActionsMenuOpen,
    isDeletingMeeting,
    setIsDeletingMeeting,
    deleteDialogMeeting,
    setDeleteDialogMeeting,
    deleteDialogError,
    setDeleteDialogError,
    isNotesRevealComplete,
    setIsNotesRevealComplete,
    waitingPreparationLines,
    setWaitingPreparationLines,
    preparationLines,
    setPreparationLines,
    isWaitingForWorkspaceReveal,
    setIsWaitingForWorkspaceReveal,
    shouldAnimateNotes,
    setShouldAnimateNotes,
    actionsMenuRef,
    contentEndRef,
    snapshotRunMeetingIdRef,
    didInitializeMeetingRef,
  };
}

function usePostMeetingWorkspaceMeetingQueries(input: {
  meetingId: string;
  session: ReturnType<typeof useAuth>["session"];
  unavailableMeetingId: string | null;
  detail: PostMeetingPayload | null;
  pollAttempts: number;
}) {
  const { meetingId, session, unavailableMeetingId, detail, pollAttempts } = input;
  const queryClient = useQueryClient();
  const detailQueryKey = useMemo(() => meetingNotesViewQueryKey(meetingId), [meetingId]);
  const meetingsQuery = useQuery(workspaceMeetingsOptions(session));
  const detailOptions = meetingNotesViewOptions({ session, meetingId });
  const detailQuery = useQuery({
    ...detailOptions,
    enabled: detailOptions.enabled === true && unavailableMeetingId !== meetingId,
  });
  const cachedDetail = getExactMeetingDetail({
    detail: queryClient.getQueryData<PostMeetingPayload>(detailQueryKey),
    meetingId,
  });
  const renderedDetail = resolvePostMeetingRenderedDetail({
    unavailableMeetingId,
    meetingId,
    cachedDetail,
    detailQueryData: detailQuery.data,
    detail,
  });
  const hasLockedPreviewPollingExpired = resolveHasLockedPreviewPollingExpired({ renderedDetail, pollAttempts });

  return {
    detailQueryKey,
    meetingsQuery,
    detailQuery,
    renderedDetail,
    hasLockedPreviewPollingExpired,
  };
}

function usePostMeetingWorkspaceRefresh(input: {
  session: ReturnType<typeof useAuth>["session"];
  meetingId: string;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  setMeetings: (value: Meeting[]) => void;
  setDetail: (value: PostMeetingPayload | null) => void;
  setUnavailableMeetingId: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const { session, meetingId, detailQueryKey, queryClient, setMeetings, setDetail, setUnavailableMeetingId, setError } =
    input;

  return useCallback(async () => {
    if (!session) {
      return;
    }

    const result = await loadPostMeetingRefresh({
      listMeetings: () => queryClient.fetchQuery({ ...workspaceMeetingsOptions(session), staleTime: 0 }),
      getMeeting: () => queryClient.fetchQuery({ ...meetingNotesViewOptions({ session, meetingId }), staleTime: 0 }),
      isMeetingUnavailable: isMeetingDetailUnavailable,
    });
    const meetingList = result.meetings;

    setMeetings(meetingList);
    setCachedWorkspaceMeetings(session.user.id, session.user.workspaceId, meetingList);
    if (result.kind === "unavailable") {
      // An unknown or hidden meeting is the normal not-found view, not a failure.
      queryClient.removeQueries({ queryKey: meetingDetailQueryKey(detailQueryKey[1]) });
      setDetail(null);
      setUnavailableMeetingId(meetingId);
      setError(getApiErrorMessage({ error: result.error, fallback: POST_MEETING_WORKSPACE_COPY.meetingIsUnavailable }));

      return;
    }
    setDetail(result.detail);
    setUnavailableMeetingId(null);
    setError(null);
  }, [detailQueryKey, meetingId, queryClient, session, setDetail, setError, setMeetings, setUnavailableMeetingId]);
}

function usePostMeetingRetryMeetingDetail(input: {
  session: ReturnType<typeof useAuth>["session"];
  meetingId: string;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  setDetail: (value: PostMeetingPayload | null) => void;
  setUnavailableMeetingId: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const { session, meetingId, detailQueryKey, queryClient, setDetail, setUnavailableMeetingId, setError } = input;

  return useCallback(() => {
    if (!session) {
      return;
    }
    setError(null);
    void (async () => {
      try {
        const selected = await queryClient.fetchQuery({
          ...meetingNotesViewOptions({ session, meetingId }),
          staleTime: 0,
        });
        setDetail(selected);
        setUnavailableMeetingId(null);
      } catch (nextError) {
        setError(getApiErrorMessage({ error: nextError, fallback: POST_MEETING_WORKSPACE_COPY.unableToLoadMeeting }));
      }
    })();
  }, [detailQueryKey, meetingId, queryClient, session, setDetail, setError, setUnavailableMeetingId]);
}

function usePostMeetingWorkspaceTaskBindings(input: {
  canShowNotes: boolean;
  sessionToken: string | null;
  detailMeetingId: string | null;
  summaryContent: string | null;
  isNotesRevealComplete: boolean;
  hasStablePostCallNotes: boolean;
  renderedDetail: PostMeetingPayload | null;
}) {
  const shouldRunTasks = resolveShouldRunPostMeetingTasks(input);
  const taskStatus = useMeetingTasksStatus({
    token: input.sessionToken,
    meetingId: input.detailMeetingId,
    /** @external enabled */
    enabled: shouldRunTasks,
    initialTasks: input.renderedDetail?.tasks ?? null,
    /** @external reuseExistingCompletedTasks */
    reuseExistingCompletedTasks: true,
  });
  const taskAssignees = useMemo(() => buildPostMeetingTaskAssignees(input.renderedDetail), [input.renderedDetail]);
  const effectiveTaskList = taskStatus?.tasks ?? input.renderedDetail?.tasks ?? null;
  const hasEffectiveTasksTerminal =
    taskStatus?.isTerminal === true ||
    effectiveTaskList?.status === "completed" ||
    effectiveTaskList?.status === "failed";
  const tasksPhase = resolvePostMeetingTasksPhase({ hasEffectiveTasksTerminal, shouldRunTasks });
  const tasksError = resolvePostMeetingTasksError({
    taskStatusError: taskStatus?.error,
    effectiveTaskListStatus: effectiveTaskList?.status,
  });

  return { taskStatus, taskAssignees, effectiveTaskList, tasksPhase, tasksError };
}

function usePostMeetingBottomFollowVisibilityEffect(input: {
  refreshVisibility: () => void;
  meetingId: string;
  renderedMeetingId: string | undefined;
}) {
  const { refreshVisibility, meetingId, renderedMeetingId } = input;

  useEffect(() => {
    const frameId = window.requestAnimationFrame(refreshVisibility);

    return () => window.cancelAnimationFrame(frameId);
  }, [refreshVisibility, meetingId, renderedMeetingId]);
}

function PostMeetingPostTaskReviewContent({
  tasksPhase,
  sessionToken,
  meetingId,
  workspaceUserId,
  meetingCreatedByUserId,
  sessionUserId,
}: {
  tasksPhase: "idle" | "loading" | "complete";
  sessionToken: string | null;
  meetingId: string;
  workspaceUserId: string;
  meetingCreatedByUserId: string;
  sessionUserId: string;
}) {
  if (tasksPhase !== "complete" || sessionToken === null || sessionToken.length === 0) {
    return null;
  }

  return (
    <>
      <AshbyMeetingReview key={`${meetingId}:${workspaceUserId}`} meetingId={meetingId} token={sessionToken} />
      {workspaceUserId === meetingCreatedByUserId ? (
        <SlackMeetingReviewPanel
          key={`slack:${meetingId}:${sessionUserId}`}
          meetingId={meetingId}
          token={sessionToken}
        />
      ) : null}
    </>
  );
}

function PostMeetingWorkspaceMeetingHeader({
  displayMeetingTitle,
  meetingMetaPills,
}: {
  displayMeetingTitle: string;
  meetingMetaPills: string[];
}) {
  return (
    <header className="meeting-header">
      <div className="meeting-header-main">
        <h2>{displayMeetingTitle}</h2>
        {meetingMetaPills.length !== 0 ? (
          <div className="workspace-meeting-meta-pills" aria-label={POST_MEETING_WORKSPACE_COPY.meetingMetadataLabel}>
            {meetingMetaPills.map((pill) => (
              <span key={pill} className="workspace-meta-pill">
                {pill}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </header>
  );
}

type PostMeetingWorkspaceMeetingDetailPageProps = {
  contentEndRef: RefObject<HTMLDivElement | null>;
  shouldRenderShell: boolean;
  shouldShowActionsMenu: boolean;
  actionsMenuRef: RefObject<HTMLDivElement | null>;
  isActionsMenuOpen: boolean;
  setIsActionsMenuOpen: (value: boolean | ((isOpen: boolean) => boolean)) => void;
  canShowNotes: boolean;
  onCopyTranscript: () => void | Promise<void>;
  summaryAndTasksClipboard: { text: string; html: string } | null;
  onCopySummaryAndTasks: () => void | Promise<void>;
  isDeletingMeeting: boolean;
  requestDeleteMeeting: () => void;
  displayMeetingTitle: string;
  meetingMetaPills: string[];
  error: string | null;
  notesOverview: ReactNode;
  scrollControlTarget: HTMLElement | null;
  scrollToBottomButton: ReactNode;
  documentStackProps: Omit<
    Parameters<typeof PostMeetingWorkspaceDocumentStack>[0],
    "notesOverview" | "renderedDetail"
  > & { renderedDetail: PostMeetingPayload };
  deleteDialogMeeting: Meeting | null;
  deleteDialogError: string | null;
  onDeleteDialogCancel: () => void;
  onDeleteDialogConfirm: () => void;
};

function PostMeetingWorkspaceMeetingDetailPage({
  contentEndRef,
  shouldRenderShell,
  shouldShowActionsMenu,
  actionsMenuRef,
  isActionsMenuOpen,
  setIsActionsMenuOpen,
  canShowNotes,
  onCopyTranscript,
  summaryAndTasksClipboard,
  onCopySummaryAndTasks,
  isDeletingMeeting,
  requestDeleteMeeting,
  displayMeetingTitle,
  meetingMetaPills,
  error,
  notesOverview,
  scrollControlTarget,
  scrollToBottomButton,
  documentStackProps,
  deleteDialogMeeting,
  deleteDialogError,
  onDeleteDialogCancel,
  onDeleteDialogConfirm,
}: PostMeetingWorkspaceMeetingDetailPageProps) {
  return (
    <>
      <section
        ref={contentEndRef}
        className={[
          "meeting-page workspace-meeting-detail-page",
          shouldRenderShell ? "" : "workspace-meeting-detail-page-embedded",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {shouldShowActionsMenu ? (
          <PostMeetingMeetingActionsMenu
            actionsMenuRef={actionsMenuRef}
            isActionsMenuOpen={isActionsMenuOpen}
            setIsActionsMenuOpen={setIsActionsMenuOpen}
            canShowNotes={canShowNotes}
            onCopyTranscript={onCopyTranscript}
            summaryAndTasksClipboard={summaryAndTasksClipboard}
            onCopySummaryAndTasks={onCopySummaryAndTasks}
            isDeletingMeeting={isDeletingMeeting}
            requestDeleteMeeting={requestDeleteMeeting}
          />
        ) : null}
        <PostMeetingWorkspaceMeetingHeader
          displayMeetingTitle={displayMeetingTitle}
          meetingMetaPills={meetingMetaPills}
        />
        {error !== null && error.length > 0 ? <p className="error-text">{error}</p> : null}
        <section className="workspace-document-shell">
          <article className="workspace-document-page">
            <PostMeetingWorkspaceDocumentStack {...documentStackProps} notesOverview={notesOverview} />
          </article>
        </section>
        {scrollControlTarget ? createPortal(scrollToBottomButton, scrollControlTarget) : scrollToBottomButton}
      </section>
      <PastMeetingRemoveDialog
        meeting={deleteDialogMeeting}
        isPending={isDeletingMeeting}
        error={deleteDialogError}
        onCancel={onDeleteDialogCancel}
        onConfirm={onDeleteDialogConfirm}
      />
    </>
  );
}

function usePostMeetingWorkspaceScrollFollow(input: {
  canShowNotes: boolean;
  summaryContent: string | null;
  isWaitingForWorkspaceReveal: boolean;
  shouldAnimateNotes: boolean;
  isNotesRevealComplete: boolean;
  tasksPhase: "idle" | "loading" | "complete";
  linearTaskReviewStatus: LinearTaskReviewRun["status"] | undefined;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  contentEndRef: RefObject<HTMLDivElement | null>;
  meetingId: string;
  renderedMeetingId?: string;
}) {
  const shouldFollowWorkspaceReveal = resolvePostMeetingShouldFollowWorkspaceReveal({
    canShowNotes: input.canShowNotes,
    summaryContent: input.summaryContent,
    isWaitingForWorkspaceReveal: input.isWaitingForWorkspaceReveal,
    shouldAnimateNotes: input.shouldAnimateNotes,
    isNotesRevealComplete: input.isNotesRevealComplete,
    tasksPhase: input.tasksPhase,
    linearTaskReviewStatus: input.linearTaskReviewStatus,
  });
  const bottomFollow = useBottomFollow({
    isActive: shouldFollowWorkspaceReveal,
    containerRef: input.scrollContainerRef,
    contentEndRef: input.contentEndRef,
    shouldObserveWhenInactive: input.canShowNotes,
  });
  usePostMeetingBottomFollowVisibilityEffect({
    refreshVisibility: bottomFollow.refreshVisibility,
    meetingId: input.meetingId,
    renderedMeetingId: input.renderedMeetingId,
  });

  return bottomFollow;
}

function usePostMeetingWorkspaceNotesPrelude(input: {
  meetingId: string;
  session: ReturnType<typeof useAuth>["session"];
  renderedDetail: PostMeetingPayload | null;
  waitingPreparationLines: string[];
  setShouldAnimateNotes: (value: boolean) => void;
  preparationLines: string[] | null;
  setWaitingPreparationLines: (value: string[]) => void;
  setPreparationLines: (value: string[] | null) => void;
  hasLockedPreviewPollingExpired: boolean;
  snapshotRunMeetingIdRef: RefObject<string | null>;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  refresh: () => Promise<void>;
  setError: (value: string | null) => void;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  const meetingContext = resolvePostMeetingWorkspaceMeetingContext(input.renderedDetail);
  const sessionToken = input.session?.token ?? null;
  const { waitingLines, isShowRejoin: shouldShowRejoin } = useMeetingWaitingState({
    isInProgress: meetingContext.isAwaitingMeetingEnd,
    conclusions: input.waitingPreparationLines,
  });
  usePostMeetingInProgressNotesAnimation({
    isAwaitingMeetingEnd: meetingContext.isAwaitingMeetingEnd,
    setShouldAnimateNotes: input.setShouldAnimateNotes,
  });
  const billingSummary = usePostMeetingWorkspaceBillingSummaryState({
    session: input.session,
    renderedDetail: input.renderedDetail,
    isAwaitingMeetingEnd: meetingContext.isAwaitingMeetingEnd,
  });
  const effectivePreparationLines = useMemo(
    () => input.preparationLines ?? fallbackMeetingPreparationLines(),
    [input.preparationLines],
  );
  usePostMeetingWorkspaceNotesGenerationEffects({
    sessionToken,
    meetingId: input.meetingId,
    isAwaitingMeetingEnd: meetingContext.isAwaitingMeetingEnd,
    isNotesAccessLocked: billingSummary.notesAccess.locked,
    setWaitingPreparationLines: input.setWaitingPreparationLines,
    detailMeetingStatus: meetingContext.detailMeetingStatus,
    preparationLines: input.preparationLines,
    summaryContent: billingSummary.summaryContent,
    isUpgradePreview: billingSummary.isUpgradePreview,
    hasLockedPreviewPollingExpired: input.hasLockedPreviewPollingExpired,
    setPreparationLines: input.setPreparationLines,
    detailMeetingId: meetingContext.detailMeetingId,
    isReadOnlyMeetingViewer: meetingContext.isReadOnlyMeetingViewer,
    isDetailTranscriptFinal: meetingContext.isDetailTranscriptFinal,
    detailSummaryId: meetingContext.detailSummaryId,
    isPreviewReady: billingSummary.isPreviewReady,
    snapshotRunMeetingIdRef: input.snapshotRunMeetingIdRef,
    detailQueryKey: input.detailQueryKey,
    queryClient: input.queryClient,
    refresh: input.refresh,
    setError: input.setError,
  });
  usePostMeetingSkippedDisposition({
    renderedDetail: input.renderedDetail,
    router: input.router,
    showToast: input.showToast,
  });

  return {
    meetingContext,
    sessionToken,
    waitingLines,
    shouldShowRejoin,
    billingSummary,
    effectivePreparationLines,
  };
}

function usePostMeetingWorkspaceNotesAndTasksFlow(input: {
  meetingId: string;
  session: ReturnType<typeof useAuth>["session"];
  renderedDetail: PostMeetingPayload | null;
  waitingPreparationLines: string[];
  setShouldAnimateNotes: (value: boolean) => void;
  preparationLines: string[] | null;
  setWaitingPreparationLines: (value: string[]) => void;
  setPreparationLines: (value: string[] | null) => void;
  hasLockedPreviewPollingExpired: boolean;
  snapshotRunMeetingIdRef: RefObject<string | null>;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  refresh: () => Promise<void>;
  setError: (value: string | null) => void;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
  isNotesRevealComplete: boolean;
  setIsNotesRevealComplete: (value: boolean) => void;
  isWaitingForWorkspaceReveal: boolean;
  setIsWaitingForWorkspaceReveal: (value: boolean) => void;
  shouldAnimateNotes: boolean;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  contentEndRef: RefObject<HTMLDivElement | null>;
}) {
  const { meetingContext, sessionToken, waitingLines, shouldShowRejoin, billingSummary, effectivePreparationLines } =
    usePostMeetingWorkspaceNotesPrelude(input);
  const taskBindings = usePostMeetingWorkspaceTaskBindings({
    canShowNotes: billingSummary.canShowNotes,
    sessionToken,
    detailMeetingId: meetingContext.detailMeetingId,
    summaryContent: billingSummary.summaryContent,
    isNotesRevealComplete: input.isNotesRevealComplete,
    hasStablePostCallNotes: meetingContext.hasStablePostCallNotes,
    renderedDetail: input.renderedDetail,
  });
  const linearTaskReview =
    usePostMeetingLinearReview({
      sessionToken,
      canDisplayNotes: billingSummary.canDisplayNotes,
      isNotesRevealComplete: input.isNotesRevealComplete,
      sessionUserId: input.session?.user.id,
      renderedDetail: input.renderedDetail,
      meetingId: input.meetingId,
    }).data ?? null;
  const bottomFollow = usePostMeetingWorkspaceScrollFollow({
    canShowNotes: billingSummary.canShowNotes,
    summaryContent: billingSummary.summaryContent,
    isWaitingForWorkspaceReveal: input.isWaitingForWorkspaceReveal,
    shouldAnimateNotes: input.shouldAnimateNotes,
    isNotesRevealComplete: input.isNotesRevealComplete,
    tasksPhase: taskBindings.tasksPhase,
    linearTaskReviewStatus: linearTaskReview?.status,
    scrollContainerRef: input.scrollContainerRef,
    contentEndRef: input.contentEndRef,
    meetingId: input.meetingId,
    renderedMeetingId: input.renderedDetail?.meeting.id,
  });
  usePostMeetingWorkspaceNotesReveal({
    meetingId: input.meetingId,
    isWaitingForWorkspaceReveal: input.isWaitingForWorkspaceReveal,
    shouldAnimateNotes: input.shouldAnimateNotes,
    summaryContent: billingSummary.summaryContent,
    setIsWaitingForWorkspaceReveal: input.setIsWaitingForWorkspaceReveal,
    setShouldAnimateNotes: input.setShouldAnimateNotes,
    setIsNotesRevealComplete: input.setIsNotesRevealComplete,
  });

  return {
    ...meetingContext,
    sessionToken,
    waitingLines,
    shouldShowRejoin,
    ...billingSummary,
    effectivePreparationLines,
    ...taskBindings,
    linearTaskReview,
    bottomFollow,
  };
}

function resolvePostMeetingWorkspaceMeetingActionsDisplay(input: {
  renderedDetail: PostMeetingPayload | null;
  pollAttempts: number;
  fallbackTitle: string;
}) {
  const isWaitingForFinalArtifacts =
    input.renderedDetail !== null && resolvePostMeetingWaitingForFinalArtifacts(input.renderedDetail);
  const isTakingLongerThanExpected = isWaitingForFinalArtifacts && input.pollAttempts >= NOTES_LONG_WAIT_ATTEMPTS;
  const displayMeetingTitle =
    input.renderedDetail !== null
      ? resolvePostMeetingDisplayMeetingTitle({
          renderedDetail: input.renderedDetail,
          isWaitingForFinalArtifacts,
          fallbackTitle: input.fallbackTitle,
        })
      : input.fallbackTitle;
  const shouldShowActionsMenu =
    (input.renderedDetail?.transcript?.isFinal ?? false) && (input.renderedDetail?.hasTranscriptSegments ?? false);

  return { isWaitingForFinalArtifacts, isTakingLongerThanExpected, displayMeetingTitle, shouldShowActionsMenu };
}

function usePostMeetingTranscriptLoader(input: {
  session: ReturnType<typeof useAuth>["session"];
  detailMeetingId: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  return useCallback(async () => {
    if (!input.session || input.detailMeetingId === null) {
      throw new Error(POST_MEETING_WORKSPACE_COPY.transcriptUnavailable);
    }
    const fullDetail = await input.queryClient.fetchQuery({
      ...meetingDetailOptions({ session: input.session, meetingId: input.detailMeetingId }),
      staleTime: 0,
    });
    if (fullDetail.notesAccess.locked) {
      throw new Error(POST_MEETING_WORKSPACE_COPY.transcriptUnavailable);
    }

    return buildPostMeetingTranscriptText(fullDetail);
  }, [input.session, input.detailMeetingId, input.queryClient]);
}

function usePostMeetingWorkspaceMeetingActions(input: {
  renderedDetail: PostMeetingPayload | null;
  pollAttempts: number;
  fallbackTitle: string;
  canShowNotes: boolean;
  summaryContent: string | null;
  effectiveTaskList: PostMeetingPayload["tasks"] | null;
  detailMeetingId: string | null;
  showToast: ReturnType<typeof useToast>["showToast"];
  setError: (value: string | null) => void;
  setIsActionsMenuOpen: (value: boolean | ((isOpen: boolean) => boolean)) => void;
  onRequestDeleteMeeting?: (meeting: Meeting) => void;
  session: ReturnType<typeof useAuth>["session"];
  deleteDialogMeeting: Meeting | null;
  meetings: Meeting[];
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  router: ReturnType<typeof useRouter>;
  onMeetingDeleted?: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  setDeleteDialogError: (value: string | null) => void;
  setDeleteDialogMeeting: (value: Meeting | null) => void;
  setIsDeletingMeeting: (value: boolean) => void;
  isActionsMenuOpen: boolean;
  actionsMenuRef: RefObject<HTMLDivElement | null>;
  isDeletingMeeting: boolean;
}) {
  const { isWaitingForFinalArtifacts, isTakingLongerThanExpected, displayMeetingTitle, shouldShowActionsMenu } =
    resolvePostMeetingWorkspaceMeetingActionsDisplay({
      renderedDetail: input.renderedDetail,
      pollAttempts: input.pollAttempts,
      fallbackTitle: input.fallbackTitle,
    });
  const meetingMetaPills = useMemo(
    () => buildPostMeetingMeetingMetaPills(input.renderedDetail),
    [input.renderedDetail],
  );
  const loadTranscriptText = usePostMeetingTranscriptLoader(input);
  const summaryAndTasksClipboard = useMemo(
    () =>
      buildPostMeetingSummaryAndTasksClipboard({
        canShowNotes: input.canShowNotes,
        renderedDetail: input.renderedDetail,
        summaryContent: input.summaryContent,
        effectiveTaskList: input.effectiveTaskList,
      }),
    [input.canShowNotes, input.effectiveTaskList, input.renderedDetail, input.summaryContent],
  );
  const { onCopyTranscript, onCopySummaryAndTasks } = usePostMeetingClipboardActions({
    canShowNotes: input.canShowNotes,
    loadTranscriptText,
    summaryAndTasksClipboard,
    detailMeetingId: input.detailMeetingId,
    showToast: input.showToast,
    setError: input.setError,
    setIsActionsMenuOpen: input.setIsActionsMenuOpen,
  });
  const { requestDeleteMeeting, confirmDeleteMeeting } = usePostMeetingDeleteMeetingHandlers({
    renderedDetail: input.renderedDetail,
    onRequestDeleteMeeting: input.onRequestDeleteMeeting,
    session: input.session,
    deleteDialogMeeting: input.deleteDialogMeeting,
    meetings: input.meetings,
    detailQueryKey: input.detailQueryKey,
    queryClient: input.queryClient,
    router: input.router,
    onMeetingDeleted: input.onMeetingDeleted,
    showToast: input.showToast,
    setIsActionsMenuOpen: input.setIsActionsMenuOpen,
    setDeleteDialogError: input.setDeleteDialogError,
    setDeleteDialogMeeting: input.setDeleteDialogMeeting,
    setIsDeletingMeeting: input.setIsDeletingMeeting,
    setError: input.setError,
  });
  usePostMeetingActionsMenuDismiss({
    isActionsMenuOpen: input.isActionsMenuOpen,
    actionsMenuRef: input.actionsMenuRef,
    setIsActionsMenuOpen: input.setIsActionsMenuOpen,
  });
  usePostMeetingActionKeyboardShortcuts({
    shouldShowActionsMenu,
    onCopyTranscript,
    onCopySummaryAndTasks,
    requestDeleteMeeting,
    isDeletingMeeting: input.isDeletingMeeting,
    summaryAndTasksClipboard,
  });

  return {
    isWaitingForFinalArtifacts,
    isTakingLongerThanExpected,
    displayMeetingTitle,
    meetingMetaPills,
    summaryAndTasksClipboard,
    shouldShowActionsMenu,
    onCopyTranscript,
    onCopySummaryAndTasks,
    requestDeleteMeeting,
    confirmDeleteMeeting,
  };
}

function buildPostMeetingWorkspaceDocumentStackProps(input: {
  notesFlow: ReturnType<typeof usePostMeetingWorkspaceNotesAndTasksFlow>;
  renderedDetail: PostMeetingPayload;
  sourceSegmentId: string | null;
  session: NonNullable<ReturnType<typeof useAuth>["session"]>;
  isNotesRevealComplete: boolean;
  meetingId: string;
  refresh: () => Promise<void>;
}) {
  const { notesFlow, renderedDetail, sourceSegmentId, session, isNotesRevealComplete, meetingId, refresh } = input;

  return {
    canShowNotes: notesFlow.canShowNotes,
    sourceSegmentId,
    renderedDetail,
    shouldShowNotesAccessGate: notesFlow.shouldShowNotesAccessGate,
    isUpgradePreview: notesFlow.isUpgradePreview,
    notesAccess: notesFlow.notesAccess,
    paymentStatus: notesFlow.paymentStatus,
    workspaceToken: session.token,
    workspaceId: session.user.workspaceId,
    billing: notesFlow.billing,
    hasKnownBilling: notesFlow.hasKnownBilling,
    canDisplayNotes: notesFlow.canDisplayNotes,
    summaryContent: notesFlow.summaryContent,
    isNotesRevealComplete,
    effectiveTaskList: notesFlow.effectiveTaskList,
    tasksPhase: notesFlow.tasksPhase,
    taskStatus: notesFlow.taskStatus,
    sessionToken: notesFlow.sessionToken,
    meetingId,
    taskAssignees: notesFlow.taskAssignees,
    tasksError: notesFlow.tasksError,
    refresh,
    workspaceUserId: session.user.id,
    linearTaskReview: notesFlow.linearTaskReview,
    sessionUserId: session.user.id,
  };
}

function PostMeetingWorkspaceResolvedNotesOverview({
  meetingId,
  notesFlow,
  meetingActions,
  isWaitingForWorkspaceReveal,
  shouldAnimateNotes,
  setIsNotesRevealComplete,
}: {
  meetingId: string;
  notesFlow: ReturnType<typeof usePostMeetingWorkspaceNotesAndTasksFlow>;
  meetingActions: ReturnType<typeof usePostMeetingWorkspaceMeetingActions>;
  isWaitingForWorkspaceReveal: boolean;
  shouldAnimateNotes: boolean;
  setIsNotesRevealComplete: (value: boolean) => void;
}) {
  return (
    <PostMeetingNotesOverviewSection
      meetingId={meetingId}
      summaryContent={notesFlow.summaryContent}
      isWaitingForWorkspaceReveal={isWaitingForWorkspaceReveal}
      shouldAnimateNotes={shouldAnimateNotes}
      canShowNotes={notesFlow.canShowNotes}
      onNotesRowReveal={() => notesFlow.bottomFollow.followLatestContent()}
      onNotesRevealComplete={() => {
        setIsNotesRevealComplete(true);
        clearWorkspaceNotesRevealPending(meetingId);
      }}
      isWaitingForFinalArtifacts={meetingActions.isWaitingForFinalArtifacts}
      isAwaitingMeetingEnd={notesFlow.isAwaitingMeetingEnd}
      isTakingLongerThanExpected={meetingActions.isTakingLongerThanExpected}
      isDetailTranscriptFinal={notesFlow.isDetailTranscriptFinal}
      waitingLines={notesFlow.waitingLines}
      effectivePreparationLines={notesFlow.effectivePreparationLines}
      isUpgradePreview={notesFlow.isUpgradePreview}
      shouldShowRejoin={notesFlow.shouldShowRejoin}
      isReadOnlyMeetingViewer={notesFlow.isReadOnlyMeetingViewer}
    />
  );
}

type PostMeetingWorkspaceResolvedMeetingPageProps = {
  meetingId: string;
  shouldRenderShell: boolean;
  renderedDetail: PostMeetingPayload;
  session: NonNullable<ReturnType<typeof useAuth>["session"]>;
  scrollControlContainerRef?: RefObject<HTMLElement | null>;
  sourceSegmentId: string | null;
  notesFlow: ReturnType<typeof usePostMeetingWorkspaceNotesAndTasksFlow>;
  meetingActions: ReturnType<typeof usePostMeetingWorkspaceMeetingActions>;
  error: string | null;
  isActionsMenuOpen: boolean;
  setIsActionsMenuOpen: (value: boolean | ((isOpen: boolean) => boolean)) => void;
  actionsMenuRef: RefObject<HTMLDivElement | null>;
  isDeletingMeeting: boolean;
  isWaitingForWorkspaceReveal: boolean;
  shouldAnimateNotes: boolean;
  isNotesRevealComplete: boolean;
  setIsNotesRevealComplete: (value: boolean) => void;
  contentEndRef: RefObject<HTMLDivElement | null>;
  deleteDialogMeeting: Meeting | null;
  deleteDialogError: string | null;
  setDeleteDialogMeeting: (value: Meeting | null) => void;
  setDeleteDialogError: (value: string | null) => void;
  refresh: () => Promise<void>;
};

/**
 * A null snapshot means the meeting's finalization is still writing the notes, so the page asks again
 * shortly: the API generates the notes itself once that finalization stops renewing its claim.
 */
export function deferredSnapshotRunStep(input: {
  snapshot: unknown;
  deferredRetries: number;
}): "done" | "retry" | "give_up" {
  if (input.snapshot !== null) {
    return "done";
  }

  return input.deferredRetries < DEFERRED_SNAPSHOT_MAX_RETRIES ? "retry" : "give_up";
}

/**
 * Only the host, with notes unlocked, can replace placeholder notes from a failed run.
 * The detail route reports the host as a participant, so the creator is recognised by id.
 */
export function canRegenerateFallbackNotes(input: {
  detail: {
    meeting: Pick<PostMeetingPayload["meeting"], "viewerRole" | "status" | "createdByUserId">;
    summary: Pick<NonNullable<PostMeetingPayload["summary"]>, "model"> | null;
  };
  canShowNotes: boolean;
  viewerUserId: string;
}): boolean {
  const isHost =
    input.detail.meeting.viewerRole === "host" || input.detail.meeting.createdByUserId === input.viewerUserId;

  return (
    input.canShowNotes &&
    isHost &&
    input.detail.meeting.status === "ended" &&
    input.detail.summary?.model === FALLBACK_SUMMARY_MODEL
  );
}

function PostMeetingWorkspaceResolvedMeetingPage(props: PostMeetingWorkspaceResolvedMeetingPageProps) {
  const {
    meetingId,
    shouldRenderShell,
    renderedDetail,
    session,
    scrollControlContainerRef,
    sourceSegmentId,
    notesFlow,
    meetingActions,
    error,
    isActionsMenuOpen,
    setIsActionsMenuOpen,
    actionsMenuRef,
    isDeletingMeeting,
    isWaitingForWorkspaceReveal,
    shouldAnimateNotes,
    isNotesRevealComplete,
    setIsNotesRevealComplete,
    contentEndRef,
    deleteDialogMeeting,
    deleteDialogError,
    setDeleteDialogMeeting,
    setDeleteDialogError,
    refresh,
  } = props;

  return (
    <PostMeetingWorkspaceMeetingDetailPage
      contentEndRef={contentEndRef}
      shouldRenderShell={shouldRenderShell}
      shouldShowActionsMenu={meetingActions.shouldShowActionsMenu}
      actionsMenuRef={actionsMenuRef}
      isActionsMenuOpen={isActionsMenuOpen}
      setIsActionsMenuOpen={setIsActionsMenuOpen}
      canShowNotes={notesFlow.canShowNotes}
      onCopyTranscript={meetingActions.onCopyTranscript}
      summaryAndTasksClipboard={meetingActions.summaryAndTasksClipboard}
      onCopySummaryAndTasks={meetingActions.onCopySummaryAndTasks}
      isDeletingMeeting={isDeletingMeeting}
      requestDeleteMeeting={meetingActions.requestDeleteMeeting}
      displayMeetingTitle={meetingActions.displayMeetingTitle}
      meetingMetaPills={meetingActions.meetingMetaPills}
      error={error}
      notesOverview={
        <>
          <PostMeetingWorkspaceResolvedNotesOverview
            meetingId={meetingId}
            notesFlow={notesFlow}
            meetingActions={meetingActions}
            isWaitingForWorkspaceReveal={isWaitingForWorkspaceReveal}
            shouldAnimateNotes={shouldAnimateNotes}
            setIsNotesRevealComplete={setIsNotesRevealComplete}
          />
          {canRegenerateFallbackNotes({
            detail: renderedDetail,
            canShowNotes: notesFlow.canShowNotes,
            viewerUserId: session.user.id,
          }) ? (
            <RegenerateNotesButton
              key={renderedDetail.summary?.generatedAt}
              onRegenerate={() => regenerateMeetingNotes({ token: session.token, meetingId })}
              checkProgress={async () =>
                (await getMeetingNotesRegenerationProgress({ token: session.token, meetingId })).status
              }
              refresh={refresh}
            />
          ) : null}
        </>
      }
      scrollControlTarget={scrollControlContainerRef?.current ?? null}
      scrollToBottomButton={
        <PostMeetingWorkspaceScrollToBottomButton
          canShowNotes={notesFlow.canShowNotes}
          isUserAwayFromBottom={notesFlow.bottomFollow.isUserAwayFromBottom}
          onScrollToBottom={() => notesFlow.bottomFollow.scrollToBottom()}
        />
      }
      documentStackProps={buildPostMeetingWorkspaceDocumentStackProps({
        notesFlow,
        renderedDetail,
        sourceSegmentId,
        session,
        isNotesRevealComplete,
        meetingId,
        refresh,
      })}
      deleteDialogMeeting={deleteDialogMeeting}
      deleteDialogError={deleteDialogError}
      onDeleteDialogCancel={() => {
        setDeleteDialogMeeting(null);
        setDeleteDialogError(null);
      }}
      onDeleteDialogConfirm={() => void meetingActions.confirmDeleteMeeting()}
    />
  );
}

function PostMeetingWorkspaceResolvedDetail(
  props: PostMeetingWorkspaceResolvedMeetingPageProps & { meetings: Meeting[] },
) {
  const { meetings, shouldRenderShell, ...meetingPageProps } = props;
  const detailPage = (
    <PostMeetingWorkspaceResolvedMeetingPage {...meetingPageProps} shouldRenderShell={shouldRenderShell} />
  );

  return shouldRenderShell ? <WorkspaceShell meetings={meetings}>{detailPage}</WorkspaceShell> : detailPage;
}

function usePostMeetingWorkspaceFetchBindings(input: {
  meetingId: string;
  session: ReturnType<typeof useAuth>["session"];
  queryClient: ReturnType<typeof useQueryClient>;
  detailQueryKey: ReturnType<typeof meetingNotesViewQueryKey>;
  renderedDetail: PostMeetingPayload | null;
  error: string | null;
  unavailableMeetingId: string | null;
  meetings: Meeting[];
  setDetail: (value: PostMeetingPayload | null) => void;
  setUnavailableMeetingId: (value: string | null) => void;
  setError: (value: string | null) => void;
  setMeetings: (value: Meeting[]) => void;
}) {
  const retryMeetingDetail = usePostMeetingRetryMeetingDetail({
    session: input.session,
    meetingId: input.meetingId,
    detailQueryKey: input.detailQueryKey,
    queryClient: input.queryClient,
    setDetail: input.setDetail,
    setUnavailableMeetingId: input.setUnavailableMeetingId,
    setError: input.setError,
  });
  const meetingLoadFailure = useMemo(
    () =>
      resolvePostMeetingLoadFailure({
        renderedDetail: input.renderedDetail,
        error: input.error,
        unavailableMeetingId: input.unavailableMeetingId,
        meetingId: input.meetingId,
        retry: retryMeetingDetail,
      }),
    [input.error, input.meetingId, input.renderedDetail, retryMeetingDetail, input.unavailableMeetingId],
  );
  const fallbackMeeting = input.meetings.find((meeting) => meeting.id === input.meetingId) ?? null;
  const fallbackTitle = fallbackMeeting?.title ?? "";
  const refresh = usePostMeetingWorkspaceRefresh({
    session: input.session,
    meetingId: input.meetingId,
    detailQueryKey: input.detailQueryKey,
    queryClient: input.queryClient,
    setMeetings: input.setMeetings,
    setDetail: input.setDetail,
    setUnavailableMeetingId: input.setUnavailableMeetingId,
    setError: input.setError,
  });
  const { setError } = input;
  const refreshInBackground = useCallback(() => {
    void input.queryClient.invalidateQueries({ queryKey: meetingLinearTaskReviewQueryKey(input.meetingId) });
    void (async () => {
      try {
        await refresh();
      } catch (nextError) {
        setError(
          getApiErrorMessage({ error: nextError, fallback: POST_MEETING_WORKSPACE_COPY.failedToRefreshWorkspace }),
        );
      }
    })();
  }, [refresh, setError, input.queryClient, input.meetingId]);
  const meetingTaskRealtime = useMeetingTaskRealtime({
    workspaceId: input.renderedDetail?.meeting.workspaceId ?? input.session?.user.workspaceId ?? null,
    meetingId: input.meetingId,
    onInvalidate: refreshInBackground,
  });
  const pollMeetingTasksFallback = refreshInBackground;
  useRealtimeFallbackPolling({
    enabled: meetingTaskRealtime.status === "degraded",
    onPoll: pollMeetingTasksFallback,
  });

  return { meetingLoadFailure, fallbackMeeting, fallbackTitle, refresh };
}

function usePostMeetingWorkspaceDataPipeline(input: {
  meetingId: string;
  session: ReturnType<typeof useAuth>["session"];
  isAuthLoading: boolean;
  onMeetingReady?: (meetingId: string) => void;
  onMeetingLoadFailure?: (failure: MeetingLoadFailure | null) => void;
}) {
  const queryClient = useQueryClient();
  const local = usePostMeetingWorkspaceLocalState({
    meetingId: input.meetingId,
    session: input.session,
    queryClient,
  });
  const queries = usePostMeetingWorkspaceMeetingQueries({
    meetingId: input.meetingId,
    session: input.session,
    unavailableMeetingId: local.unavailableMeetingId,
    detail: local.detail,
    pollAttempts: local.pollAttempts,
  });
  const fetchBindings = usePostMeetingWorkspaceFetchBindings({
    meetingId: input.meetingId,
    session: input.session,
    queryClient,
    detailQueryKey: queries.detailQueryKey,
    renderedDetail: queries.renderedDetail,
    error: local.error,
    unavailableMeetingId: local.unavailableMeetingId,
    meetings: local.meetings,
    setDetail: local.setDetail,
    setUnavailableMeetingId: local.setUnavailableMeetingId,
    setError: local.setError,
    setMeetings: local.setMeetings,
  });
  usePostMeetingWorkspaceQuerySyncEffects({
    meetingId: input.meetingId,
    userId: input.session?.user.id,
    detailQueryKey: queries.detailQueryKey,
    queryClient,
    didInitializeMeetingRef: local.didInitializeMeetingRef,
    snapshotRunMeetingIdRef: local.snapshotRunMeetingIdRef,
    setDetail: local.setDetail,
    setError: local.setError,
    setUnavailableMeetingId: local.setUnavailableMeetingId,
    setPollAttempts: local.setPollAttempts,
    setIsWaitingForWorkspaceReveal: local.setIsWaitingForWorkspaceReveal,
    setShouldAnimateNotes: local.setShouldAnimateNotes,
    setIsNotesRevealComplete: local.setIsNotesRevealComplete,
    setPreparationLines: local.setPreparationLines,
    setWaitingPreparationLines: local.setWaitingPreparationLines,
    setDeleteDialogMeeting: local.setDeleteDialogMeeting,
    setDeleteDialogError: local.setDeleteDialogError,
    meetingsQueryData: queries.meetingsQuery.data,
    detailQueryData: queries.detailQuery.data,
    detailQueryError: queries.detailQuery.error,
    refresh: fetchBindings.refresh,
    session: input.session,
    setMeetings: local.setMeetings,
    renderedDetail: queries.renderedDetail,
    hasLockedPreviewPollingExpired: queries.hasLockedPreviewPollingExpired,
    pollAttempts: local.pollAttempts,
    isAuthLoading: input.isAuthLoading,
    onMeetingReady: input.onMeetingReady,
    meetingLoadFailure: fetchBindings.meetingLoadFailure,
    onMeetingLoadFailure: input.onMeetingLoadFailure,
    workspaceUserId: input.session?.user.id,
    workspaceId: input.session?.user.workspaceId,
  });

  return { queryClient, local, queries, fetchBindings };
}

function usePostMeetingWorkspaceRenderedExperience(input: {
  meetingId: string;
  session: ReturnType<typeof useAuth>["session"];
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
  scrollContainerRef?: RefObject<HTMLElement | null>;
  onRequestDeleteMeeting?: (meeting: Meeting) => void;
  onMeetingDeleted?: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  queryClient: ReturnType<typeof useQueryClient>;
  local: ReturnType<typeof usePostMeetingWorkspaceLocalState>;
  queries: ReturnType<typeof usePostMeetingWorkspaceMeetingQueries>;
  fetchBindings: ReturnType<typeof usePostMeetingWorkspaceFetchBindings>;
}) {
  const notesFlow = usePostMeetingWorkspaceNotesAndTasksFlow({
    meetingId: input.meetingId,
    session: input.session,
    renderedDetail: input.queries.renderedDetail,
    waitingPreparationLines: input.local.waitingPreparationLines,
    setShouldAnimateNotes: input.local.setShouldAnimateNotes,
    preparationLines: input.local.preparationLines,
    setWaitingPreparationLines: input.local.setWaitingPreparationLines,
    setPreparationLines: input.local.setPreparationLines,
    hasLockedPreviewPollingExpired: input.queries.hasLockedPreviewPollingExpired,
    snapshotRunMeetingIdRef: input.local.snapshotRunMeetingIdRef,
    detailQueryKey: input.queries.detailQueryKey,
    queryClient: input.queryClient,
    refresh: input.fetchBindings.refresh,
    setError: input.local.setError,
    router: input.router,
    showToast: input.showToast,
    isNotesRevealComplete: input.local.isNotesRevealComplete,
    setIsNotesRevealComplete: input.local.setIsNotesRevealComplete,
    isWaitingForWorkspaceReveal: input.local.isWaitingForWorkspaceReveal,
    setIsWaitingForWorkspaceReveal: input.local.setIsWaitingForWorkspaceReveal,
    shouldAnimateNotes: input.local.shouldAnimateNotes,
    scrollContainerRef: input.scrollContainerRef,
    contentEndRef: input.local.contentEndRef,
  });
  const meetingActions = usePostMeetingWorkspaceMeetingActions({
    renderedDetail: input.queries.renderedDetail,
    pollAttempts: input.local.pollAttempts,
    fallbackTitle: input.fetchBindings.fallbackTitle,
    canShowNotes: notesFlow.canShowNotes,
    summaryContent: notesFlow.summaryContent,
    effectiveTaskList: notesFlow.effectiveTaskList,
    detailMeetingId: notesFlow.detailMeetingId,
    showToast: input.showToast,
    setError: input.local.setError,
    setIsActionsMenuOpen: input.local.setIsActionsMenuOpen,
    onRequestDeleteMeeting: input.onRequestDeleteMeeting,
    session: input.session,
    deleteDialogMeeting: input.local.deleteDialogMeeting,
    meetings: input.local.meetings,
    detailQueryKey: input.queries.detailQueryKey,
    queryClient: input.queryClient,
    router: input.router,
    onMeetingDeleted: input.onMeetingDeleted,
    setDeleteDialogError: input.local.setDeleteDialogError,
    setDeleteDialogMeeting: input.local.setDeleteDialogMeeting,
    setIsDeletingMeeting: input.local.setIsDeletingMeeting,
    isActionsMenuOpen: input.local.isActionsMenuOpen,
    actionsMenuRef: input.local.actionsMenuRef,
    isDeletingMeeting: input.local.isDeletingMeeting,
  });

  return { notesFlow, meetingActions };
}

function usePostMeetingWorkspaceController(input: {
  meetingId: string;
  session: ReturnType<typeof useAuth>["session"];
  isAuthLoading: boolean;
  onMeetingReady?: (meetingId: string) => void;
  onMeetingLoadFailure?: (failure: MeetingLoadFailure | null) => void;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
  scrollContainerRef?: RefObject<HTMLElement | null>;
  onRequestDeleteMeeting?: (meeting: Meeting) => void;
  onMeetingDeleted?: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
}) {
  const pipeline = usePostMeetingWorkspaceDataPipeline({
    meetingId: input.meetingId,
    session: input.session,
    isAuthLoading: input.isAuthLoading,
    onMeetingReady: input.onMeetingReady,
    onMeetingLoadFailure: input.onMeetingLoadFailure,
  });
  const experience = usePostMeetingWorkspaceRenderedExperience({
    meetingId: input.meetingId,
    session: input.session,
    router: input.router,
    showToast: input.showToast,
    scrollContainerRef: input.scrollContainerRef,
    onRequestDeleteMeeting: input.onRequestDeleteMeeting,
    onMeetingDeleted: input.onMeetingDeleted,
    queryClient: pipeline.queryClient,
    local: pipeline.local,
    queries: pipeline.queries,
    fetchBindings: pipeline.fetchBindings,
  });

  return { ...pipeline, ...experience };
}

function PostMeetingWorkspaceLoadingView({
  fallbackTitle,
  fallbackMeeting,
  error,
  shouldRenderShell,
  meetings,
  meetingLoadFailure,
}: {
  fallbackTitle: string;
  fallbackMeeting: Meeting | null;
  error: string | null;
  shouldRenderShell: boolean;
  meetings: Meeting[];
  meetingLoadFailure: MeetingLoadFailure | null;
}) {
  const loadingFrame = (
    <MeetingDetailLoadingFrame
      title={fallbackTitle}
      meeting={fallbackMeeting}
      error={error}
      isEmbedded={!shouldRenderShell}
    />
  );

  return shouldRenderShell ? (
    <WorkspaceShell meetings={meetings} endMeetingContentReady={false} endMeetingLoadFailure={meetingLoadFailure}>
      {loadingFrame}
    </WorkspaceShell>
  ) : (
    loadingFrame
  );
}

type PostMeetingWorkspaceProps = {
  meetingId: string;
  /** @external renderShell */
  renderShell?: boolean;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  scrollControlContainerRef?: RefObject<HTMLElement | null>;
  onMeetingReady?: (meetingId: string) => void;
  onMeetingLoadFailure?: (failure: MeetingLoadFailure | null) => void;
  onMeetingDeleted?: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  onRequestDeleteMeeting?: (meeting: Meeting) => void;
};

function readSourceSegmentId(searchParams: { get: (name: string) => string | null } | null): string | null {
  return searchParams?.get("segmentId") ?? null;
}

export function PostMeetingWorkspace({
  meetingId,
  /** @external renderShell */
  renderShell: shouldRenderShell = true,
  scrollContainerRef,
  scrollControlContainerRef,
  onMeetingDeleted,
  onMeetingReady,
  onMeetingLoadFailure,
  onRequestDeleteMeeting,
}: PostMeetingWorkspaceProps) {
  const router = useRouter();
  // Outside an App Router request context (e.g. embedded previews and tests) search params are null.
  const sourceSegmentId = readSourceSegmentId(useSearchParams());
  const { session, isLoading: isAuthLoading } = useAuth();
  const { showToast } = useToast();
  const workspace = usePostMeetingWorkspaceController({
    meetingId,
    session,
    isAuthLoading,
    onMeetingReady,
    onMeetingLoadFailure,
    router,
    showToast,
    scrollContainerRef,
    onRequestDeleteMeeting,
    onMeetingDeleted,
  });
  const { local, queries, fetchBindings, notesFlow, meetingActions } = workspace;
  const {
    meetings,
    error,
    isActionsMenuOpen,
    setIsActionsMenuOpen,
    isDeletingMeeting,
    deleteDialogMeeting,
    deleteDialogError,
    setDeleteDialogMeeting,
    setDeleteDialogError,
    isNotesRevealComplete,
    setIsNotesRevealComplete,
    isWaitingForWorkspaceReveal,
    shouldAnimateNotes,
    actionsMenuRef,
    contentEndRef,
  } = local;
  const { renderedDetail } = queries;
  const { meetingLoadFailure, fallbackMeeting, fallbackTitle, refresh } = fetchBindings;

  if (isAuthLoading || session === null) {
    return null;
  }

  if (renderedDetail === null) {
    return (
      <PostMeetingWorkspaceLoadingView
        fallbackTitle={fallbackTitle}
        fallbackMeeting={fallbackMeeting}
        error={error}
        shouldRenderShell={shouldRenderShell}
        meetings={meetings}
        meetingLoadFailure={meetingLoadFailure}
      />
    );
  }

  return (
    <PostMeetingWorkspaceResolvedDetail
      meetingId={meetingId}
      shouldRenderShell={shouldRenderShell}
      meetings={meetings}
      renderedDetail={renderedDetail}
      session={session}
      scrollControlContainerRef={scrollControlContainerRef}
      sourceSegmentId={sourceSegmentId}
      notesFlow={notesFlow}
      meetingActions={meetingActions}
      error={error}
      isActionsMenuOpen={isActionsMenuOpen}
      setIsActionsMenuOpen={setIsActionsMenuOpen}
      actionsMenuRef={actionsMenuRef}
      isDeletingMeeting={isDeletingMeeting}
      isWaitingForWorkspaceReveal={isWaitingForWorkspaceReveal}
      shouldAnimateNotes={shouldAnimateNotes}
      isNotesRevealComplete={isNotesRevealComplete}
      setIsNotesRevealComplete={setIsNotesRevealComplete}
      contentEndRef={contentEndRef}
      deleteDialogMeeting={deleteDialogMeeting}
      deleteDialogError={deleteDialogError}
      setDeleteDialogMeeting={setDeleteDialogMeeting}
      setDeleteDialogError={setDeleteDialogError}
      refresh={refresh}
    />
  );
}
