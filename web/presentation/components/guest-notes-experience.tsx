"use client";

import { type Meeting, stripSummaryTaskSection } from "@readymeet/shared";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { clearGuestNotesHandoff, readGuestNotesHandoff } from "../../composition/guest-notes-transition";
import { fallbackMeetingPreparationLines } from "../../composition/meeting-preparation";
import {
  WORKSPACE_END_MEETING_BACKGROUND_FADE_MS,
  WORKSPACE_END_MEETING_LOADER_FADE_MS,
  WORKSPACE_END_MEETING_REVEAL_DELAY_MS,
  WORKSPACE_END_MEETING_TRANSITION_SETTLE_MS,
} from "../../composition/workspace-transition";
import type { GuestNotesState } from "../../domain/schemas/guest-notes-experience";

import { AgentThinkingBlock } from "./agent-thinking";
import { EndMeetingAnalysisOverlay, getEndMeetingPreparationWaitMs } from "./end-meeting-analysis";
import { MeetingNotesPlaceholderCard } from "./meeting-notes-placeholder-card";
import { MeetingPreparationProgress } from "./meeting-preparation-progress";
import { MeetingRejoinBanner, useMeetingWaitingState } from "./meeting-waiting-state";
import { MeetingNotesEmptyMessage, MeetingNotesLockedCard } from "./post-meeting-workspace";
import { ReadyLogo } from "./ready-logo";
import { useBottomFollow } from "./use-bottom-follow";
import { WorkspaceGeneratedNotes } from "./workspace-generated-notes";
import { WorkspaceTasksSection } from "./workspace-tasks-section";

export type { GuestNotesState } from "../../domain/schemas/guest-notes-experience";

const MAX_GUEST_META_PARTICIPANT_PILLS = 8;
const GUEST_ENTRANCE_CLOCK_INTERVAL_MS = 250;
const GUEST_ENTRANCE_REDUCED_MOTION_DARK_DELAY_MS = 0;
const GUEST_ENTRANCE_REDUCED_MOTION_STEP_DELAY_MS = 100;
const GUEST_WAITING_LABEL_ELAPSED_FIRST_MS = 1_000;
const GUEST_WAITING_LABEL_ELAPSED_SECOND_MS = 2_000;

const GUEST_NOTES_COPY_CATCHING_UP = "Catching up on the conversation";
const GUEST_NOTES_COPY_GATHERING = "Gathering the conversation so far";
const GUEST_NOTES_COPY_PREPARING_VIEW = "Preparing your meeting view";
const GUEST_NOTES_COPY_MEETING_TOO_SHORT = "Meeting was too short";
const GUEST_NOTES_COPY_HOST_NOTES_UNAVAILABLE_TITLE = "Notes aren't available yet";
// The host's billing state is theirs; guests only learn that notes aren't ready.
const GUEST_NOTES_COPY_HOST_NOTES_UNAVAILABLE_DESCRIPTION =
  "The host's notes for this meeting aren't available yet. Check back later.";
const GUEST_NOTES_COPY_OVERVIEW = "Overview";
const GUEST_NOTES_COPY_MEETING_IN_PROGRESS = "Meeting is still in progress";
const GUEST_NOTES_COPY_PREPARING_NOTES = "Preparing your notes";
const GUEST_NOTES_COPY_FINAL_MOMENTS = "Including the final moments of the meeting.";
const GUEST_NOTES_COPY_KEEP_CONVERSATION = "Keep the conversation with you";
const GUEST_NOTES_COPY_CREATE_ACCOUNT = "Create an account to save your meeting notes and tasks.";

function hasGuestNotesRevealInput({ notes, error }: { notes: GuestNotesState | null; error: string | null }): boolean {
  return notes !== null || (error !== null && error !== "");
}

function getGuestWaitingLabel(elapsedMs: number): string {
  if (elapsedMs < GUEST_WAITING_LABEL_ELAPSED_FIRST_MS) {
    return GUEST_NOTES_COPY_CATCHING_UP;
  }

  if (elapsedMs < GUEST_WAITING_LABEL_ELAPSED_SECOND_MS) {
    return GUEST_NOTES_COPY_GATHERING;
  }

  return GUEST_NOTES_COPY_PREPARING_VIEW;
}

function getGuestSkippedMeetingDescription({
  trimmedSummary,
  skippedMessage,
}: {
  trimmedSummary: string | undefined;
  skippedMessage: string;
}): string {
  if (trimmedSummary !== undefined && trimmedSummary !== "") {
    return trimmedSummary;
  }

  return skippedMessage;
}

function getGuestMeetingMetaPills(meeting: Meeting) {
  const names = [
    ...(meeting.participantNames ?? []),
    ...(meeting.participants?.map((participant) => participant.displayName) ?? []),
  ];

  return [
    new Date(meeting.startedAt ?? meeting.createdAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    ...Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, MAX_GUEST_META_PARTICIPANT_PILLS),
  ];
}

function useGuestNotesEntrance({ meetingId, canReveal }: { meetingId: string; canReveal: boolean }) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [phase, setPhase] = useState<"dark" | "background" | "loader" | "content" | "complete">("complete");
  const [isReducedMotionPreferred, setIsReducedMotionPreferred] = useState(false);

  const entranceInitialized = useRef(false);
  useLayoutEffect(() => {
    if (!entranceInitialized.current) {
      entranceInitialized.current = true;
      const time = Date.now();
      const handoff = readGuestNotesHandoff({ meetingId, now: time });
      clearGuestNotesHandoff();
      setStartedAt(handoff);
      setPhase(handoff === null ? "complete" : "dark");
      setNow(time);
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setIsReducedMotionPreferred(media.matches);
    update();
    media.addEventListener("change", update);

    return () => media.removeEventListener("change", update);
  }, [meetingId]);

  useEffect(() => {
    if (phase === "complete") {
      return;
    }
    const interval = window.setInterval(() => setNow(Date.now()), GUEST_ENTRANCE_CLOCK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (startedAt === null || !canReveal || phase === "complete") {
      return;
    }
    const next = {
      dark: [
        "background",
        isReducedMotionPreferred
          ? GUEST_ENTRANCE_REDUCED_MOTION_DARK_DELAY_MS
          : Math.max(
              WORKSPACE_END_MEETING_REVEAL_DELAY_MS,
              getEndMeetingPreparationWaitMs({
                startedAt,
                now: Date.now(),
              }),
            ),
      ],
      background: [
        "loader",
        isReducedMotionPreferred
          ? GUEST_ENTRANCE_REDUCED_MOTION_STEP_DELAY_MS
          : WORKSPACE_END_MEETING_BACKGROUND_FADE_MS,
      ],
      loader: [
        "content",
        isReducedMotionPreferred ? GUEST_ENTRANCE_REDUCED_MOTION_STEP_DELAY_MS : WORKSPACE_END_MEETING_LOADER_FADE_MS,
      ],
      content: [
        "complete",
        isReducedMotionPreferred
          ? GUEST_ENTRANCE_REDUCED_MOTION_STEP_DELAY_MS
          : WORKSPACE_END_MEETING_TRANSITION_SETTLE_MS,
      ],
    } as const;
    const [nextPhase, delay] = next[phase];
    const timer = window.setTimeout(() => {
      setPhase(nextPhase);
      if (nextPhase === "complete") {
        clearGuestNotesHandoff();
      }
    }, delay);

    return () => window.clearTimeout(timer);
  }, [canReveal, isReducedMotionPreferred, phase, startedAt]);

  return {
    phase,
    now,
    startedAt: startedAt ?? now,
    isReducedMotionPreferred,
    hasLiveHandoff: startedAt !== null,
  };
}

type GuestNotesExperienceProps = {
  meetingId: string;
  notes: GuestNotesState | null;
  error: string | null;
  currentUserId: string | null;
  signupHref: string;
  signupAction: ReactNode;
};

type GuestNotesEntrance = ReturnType<typeof useGuestNotesEntrance>;

function getGuestNotesAccessState(notes: GuestNotesState | null) {
  const postMeetingDisposition = notes?.postMeetingDisposition ?? null;
  const isLocked = notes?.notesAccess.locked === true;
  const isMeetingInProgress = notes !== null && notes.meeting.status !== "ended" && postMeetingDisposition === null;
  const summary = isMeetingInProgress || isLocked || postMeetingDisposition !== null ? null : (notes?.summary ?? null);
  // Tasks render in their own section, so the notes are the summary without its task section (possibly empty).
  const notesContent = summary === null ? null : stripSummaryTaskSection(summary.content);

  return { postMeetingDisposition, isLocked, isMeetingInProgress, summary, notesContent };
}

function getGuestNotesIsTasksTerminal(tasksStatus: GuestNotesState["tasksStatus"]): boolean {
  return (
    tasksStatus?.isTerminal === true ||
    tasksStatus?.tasks?.status === "completed" ||
    tasksStatus?.tasks?.status === "failed"
  );
}

function shouldShowGuestNotesSignup({
  summary,
  isNotesRevealComplete,
  tasksStatus,
  isTasksTerminal,
  isTasksRevealComplete,
}: {
  summary: GuestNotesState["summary"] | null | undefined;
  isNotesRevealComplete: boolean;
  tasksStatus: GuestNotesState["tasksStatus"];
  isTasksTerminal: boolean;
  isTasksRevealComplete: boolean;
}): boolean {
  if (summary === null) {
    return false;
  }

  if (tasksStatus === null) {
    return isNotesRevealComplete;
  }

  return isNotesRevealComplete && isTasksTerminal && isTasksRevealComplete;
}

function getGuestNotesModelLines(notes: GuestNotesState | null): string[] | null {
  if (notes?.preparationPreview?.source !== "model") {
    return null;
  }

  return notes.preparationPreview.lines;
}

function getGuestNotesTasksSectionPhase({
  tasksStatus,
  isTasksTerminal,
}: {
  tasksStatus: GuestNotesState["tasksStatus"];
  isTasksTerminal: boolean;
}): "complete" | "idle" | "loading" {
  if (isTasksTerminal) {
    return "complete";
  }

  return tasksStatus ? "loading" : "idle";
}

type GuestNotesExperienceModel = {
  entrance: GuestNotesEntrance;
  contentEndRef: RefObject<HTMLDivElement | null>;
  isContentVisible: boolean;
  isNotesRevealComplete: boolean;
  setIsNotesRevealComplete: (value: boolean) => void;
  isTasksRevealComplete: boolean;
  setIsTasksRevealComplete: (value: boolean) => void;
  postMeetingDisposition: GuestNotesState["postMeetingDisposition"];
  isLocked: boolean;
  isMeetingInProgress: boolean;
  summary: GuestNotesState["summary"] | null | undefined;
  notesContent: string | null;
  shouldAnimateNotes: boolean;
  tasksStatus: GuestNotesState["tasksStatus"];
  isTasksTerminal: boolean;
  shouldShowSignup: boolean;
  bottomFollow: ReturnType<typeof useBottomFollow>;
  modelLines: string[] | null;
  waitingLines: string[];
  shouldShowRejoin: boolean;
  waitingLabel: string;
};

function useGuestNotesExperienceModel({
  meetingId,
  notes,
  error,
}: Pick<GuestNotesExperienceProps, "meetingId" | "notes" | "error">): GuestNotesExperienceModel {
  const entrance = useGuestNotesEntrance({
    meetingId,
    canReveal: hasGuestNotesRevealInput({ notes, error }),
  });
  const isContentVisible = entrance.phase === "content" || entrance.phase === "complete";
  const [hasNotesRevealCompleted, setIsNotesRevealComplete] = useState(false);
  const [isTasksRevealComplete, setIsTasksRevealComplete] = useState(false);
  const [hasAwaitedNotes, setHasAwaitedNotes] = useState(false);
  const contentEndRef = useRef<HTMLDivElement | null>(null);
  const { postMeetingDisposition, isLocked, isMeetingInProgress, summary, notesContent } =
    getGuestNotesAccessState(notes);
  // Empty notes have no rows to reveal, so the tasks and signup can follow right away.
  const isNotesRevealComplete = hasNotesRevealCompleted || notesContent === "";
  const shouldAnimateNotes = !entrance.isReducedMotionPreferred && (entrance.hasLiveHandoff || hasAwaitedNotes);
  const tasksStatus = notes?.tasksStatus ?? null;
  const isTasksTerminal = getGuestNotesIsTasksTerminal(tasksStatus);
  const shouldShowSignup = shouldShowGuestNotesSignup({
    summary,
    isNotesRevealComplete,
    tasksStatus,
    isTasksTerminal,
    isTasksRevealComplete,
  });
  const hasSummary = summary !== null;
  const bottomFollow = useBottomFollow({
    isActive: isContentVisible && hasSummary && shouldAnimateNotes,
    contentEndRef,
  });
  const modelLines = getGuestNotesModelLines(notes);
  const { waitingLines, isShowRejoin } = useMeetingWaitingState({
    isInProgress: isMeetingInProgress,
    conclusions: isLocked ? [] : (notes?.inProgressConclusions ?? []),
  });
  const shouldShowRejoin = isShowRejoin;

  useEffect(() => {
    if (notes !== null && summary === null && !isLocked && postMeetingDisposition === null) {
      setHasAwaitedNotes(true);
    }
  }, [isLocked, notes, postMeetingDisposition, summary]);

  useEffect(() => {
    setIsNotesRevealComplete(false);
    setIsTasksRevealComplete(false);
  }, [meetingId]);

  const elapsed = Math.max(0, entrance.now - entrance.startedAt);
  const waitingLabel = getGuestWaitingLabel(elapsed);

  return {
    entrance,
    contentEndRef,
    isContentVisible,
    isNotesRevealComplete,
    setIsNotesRevealComplete,
    isTasksRevealComplete,
    setIsTasksRevealComplete,
    postMeetingDisposition,
    isLocked,
    isMeetingInProgress,
    summary,
    notesContent,
    shouldAnimateNotes,
    tasksStatus,
    isTasksTerminal,
    shouldShowSignup,
    bottomFollow,
    modelLines,
    waitingLines,
    shouldShowRejoin,
    waitingLabel,
  };
}

function GuestNotesEntranceOverlay({
  model,
  isMeetingInProgress,
}: {
  model: GuestNotesExperienceModel;
  isMeetingInProgress: boolean;
}) {
  const { entrance, isContentVisible, waitingLabel } = model;

  if (entrance.phase === "complete") {
    return null;
  }

  return (
    <EndMeetingAnalysisOverlay
      flow={{
        startedAt: entrance.startedAt,
        phase: "synthesizing_notes",
        detail: null,
        transientError: null,
        ...(isMeetingInProgress ? { activeLabel: waitingLabel } : {}),
      }}
      now={entrance.now}
      disableTextAnimation={entrance.isReducedMotionPreferred}
      isExiting={entrance.phase === "loader" || isContentVisible}
      isHandoff
    />
  );
}

function GuestNotesMeetingHeader({ meeting }: { meeting: Meeting }) {
  return (
    <header className="meeting-header guest-notes-meeting-header">
      <div className="meeting-header-main">
        <h2>{meeting.title}</h2>
        <div className="workspace-meeting-meta-pills" aria-label="Meeting metadata">
          {getGuestMeetingMetaPills(meeting).map((pill) => (
            <span key={pill} className="workspace-meta-pill">
              {pill}
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}

function GuestNotesErrorAlert({ error }: { error: string }) {
  return (
    <p role="alert" className="guest-notes-error">
      {error}
    </p>
  );
}

function GuestNotesThinkingDetail({
  model,
  notes,
  meetingId,
}: {
  model: GuestNotesExperienceModel;
  notes: GuestNotesState;
  meetingId: string;
}) {
  const { isContentVisible, isMeetingInProgress, modelLines, waitingLines, shouldShowRejoin } = model;

  return (
    <>
      <AgentThinkingBlock
        title={isMeetingInProgress ? GUEST_NOTES_COPY_MEETING_IN_PROGRESS : GUEST_NOTES_COPY_PREPARING_NOTES}
        detail={
          isMeetingInProgress ? (
            isContentVisible ? (
              <MeetingPreparationProgress key="waiting" lines={waitingLines} />
            ) : null
          ) : notes.transcript?.isFinal === true ? (
            <MeetingPreparationProgress key="generating" lines={modelLines ?? fallbackMeetingPreparationLines()} />
          ) : (
            GUEST_NOTES_COPY_FINAL_MOMENTS
          )
        }
        orbState="breathing"
        className="workspace-meeting-notes-thinking"
      />
      {isMeetingInProgress && shouldShowRejoin ? <MeetingRejoinBanner meetingId={meetingId} /> : null}
    </>
  );
}

function GuestNotesSummaryBody({
  model,
  meetingId,
  notesContent,
}: {
  model: GuestNotesExperienceModel;
  meetingId: string;
  notesContent: string;
}) {
  const { shouldAnimateNotes, setIsNotesRevealComplete, bottomFollow } = model;

  if (notesContent.length === 0) {
    return <MeetingNotesEmptyMessage />;
  }

  return (
    <div className="workspace-flow-snapshot">
      <WorkspaceGeneratedNotes
        key={meetingId}
        summary={notesContent}
        mode={shouldAnimateNotes ? "reveal" : "static"}
        omitLeadingHeading
        onRowReveal={() => bottomFollow.followLatestContent()}
        onRevealComplete={() => setIsNotesRevealComplete(true)}
      />
    </div>
  );
}

/** Guests never see billing prompts; a lock that only the host can resolve reads as notes not being ready. */
function GuestNotesLockedCard({ notes, signupHref }: { notes: GuestNotesState | null; signupHref: string }) {
  const reason = notes?.notesAccess.reason ?? "signup_required";

  return reason === "signup_required" ? (
    <MeetingNotesLockedCard reason={reason} signupHref={signupHref} />
  ) : (
    <MeetingNotesPlaceholderCard
      title={GUEST_NOTES_COPY_HOST_NOTES_UNAVAILABLE_TITLE}
      description={GUEST_NOTES_COPY_HOST_NOTES_UNAVAILABLE_DESCRIPTION}
      contentClassName="guest-notes-placeholder-content"
      cardClassName="guest-notes-placeholder-card"
    />
  );
}

function GuestNotesOverviewSection({
  model,
  notes,
  meetingId,
  signupHref,
}: {
  model: GuestNotesExperienceModel;
  notes: GuestNotesState | null;
  meetingId: string;
  signupHref: string;
}) {
  const {
    isContentVisible,
    isLocked,
    isMeetingInProgress,
    postMeetingDisposition,
    shouldAnimateNotes,
    summary,
    notesContent,
  } = model;

  if (isLocked && !isMeetingInProgress) {
    return <GuestNotesLockedCard notes={notes} signupHref={signupHref} />;
  }

  if (postMeetingDisposition !== null) {
    return (
      <MeetingNotesPlaceholderCard
        title={GUEST_NOTES_COPY_MEETING_TOO_SHORT}
        description={getGuestSkippedMeetingDescription({
          trimmedSummary: notes?.summary?.content.trim(),
          skippedMessage: postMeetingDisposition.message,
        })}
        contentClassName="guest-notes-placeholder-content"
        cardClassName={`guest-notes-placeholder-card${isContentVisible && shouldAnimateNotes ? " is-revealing" : ""}`}
      />
    );
  }

  if (notes === null) {
    return null;
  }

  return (
    <>
      <h3>{GUEST_NOTES_COPY_OVERVIEW}</h3>
      {summary !== null && summary !== undefined && notesContent !== null ? (
        isContentVisible ? (
          <GuestNotesSummaryBody model={model} meetingId={meetingId} notesContent={notesContent} />
        ) : null
      ) : (
        <GuestNotesThinkingDetail model={model} notes={notes} meetingId={meetingId} />
      )}
    </>
  );
}

function GuestNotesTasksAndSignup({
  model,
  notes,
  currentUserId,
  signupAction,
}: {
  model: GuestNotesExperienceModel;
  notes: GuestNotesState | null;
  currentUserId: string | null;
  signupAction: ReactNode;
}) {
  const { isNotesRevealComplete, isTasksTerminal, setIsTasksRevealComplete, shouldShowSignup, summary, tasksStatus } =
    model;

  const tasksSectionPhase = getGuestNotesTasksSectionPhase({ tasksStatus, isTasksTerminal });

  return (
    <>
      {/* No task status means no task run exists for these notes, so there is nothing to wait for. */}
      {summary !== null &&
      summary !== undefined &&
      notes !== null &&
      isNotesRevealComplete &&
      tasksStatus !== null &&
      isTasksTerminal ? (
        <WorkspaceTasksSection
          taskList={tasksStatus.tasks}
          phase={tasksSectionPhase}
          generationPhase={tasksStatus.phase}
          generationProgress={tasksStatus.progress}
          participants={notes.meetingRuntime.allHumanParticipants}
          error={tasksStatus.error}
          currentUserId={currentUserId}
          onRevealComplete={() => setIsTasksRevealComplete(true)}
        />
      ) : null}
      {shouldShowSignup ? (
        <aside className="guest-notes-banner guest-notes-signup workspace-flow-reveal">
          <div>
            <h3>{GUEST_NOTES_COPY_KEEP_CONVERSATION}</h3>
            <p>{GUEST_NOTES_COPY_CREATE_ACCOUNT}</p>
          </div>
          {signupAction}
        </aside>
      ) : null}
    </>
  );
}

function GuestNotesRevealContent({
  model,
  notes,
  error,
  meetingId,
  signupHref,
  currentUserId,
  signupAction,
}: GuestNotesExperienceProps & { model: GuestNotesExperienceModel }) {
  const { contentEndRef, isContentVisible } = model;
  const hasError = error !== null && error !== "";

  return (
    <div className="guest-notes-reveal" inert={!isContentVisible} aria-hidden={!isContentVisible}>
      <header className="guest-notes-topbar">
        <div className="meeting-join-logo">
          <ReadyLogo />
        </div>
      </header>
      <section className="guest-notes-content has-notes" aria-label="Meeting notes">
        {notes !== null ? <GuestNotesMeetingHeader meeting={notes.meeting} /> : null}
        {hasError ? <GuestNotesErrorAlert error={error} /> : null}
        <section className="workspace-document-shell guest-notes-document-shell">
          <article className="workspace-document-page">
            <div className="workspace-document-stack" ref={contentEndRef}>
              <section className="workspace-document-section">
                <GuestNotesOverviewSection model={model} notes={notes} meetingId={meetingId} signupHref={signupHref} />
              </section>
              <GuestNotesTasksAndSignup
                model={model}
                notes={notes}
                currentUserId={currentUserId}
                signupAction={signupAction}
              />
            </div>
          </article>
        </section>
      </section>
    </div>
  );
}

export function GuestNotesExperience({
  meetingId,
  notes,
  error,
  currentUserId,
  signupHref,
  signupAction,
}: GuestNotesExperienceProps) {
  const model = useGuestNotesExperienceModel({ meetingId, notes, error });
  const { entrance, isContentVisible, isMeetingInProgress } = model;

  return (
    <main
      className={`guest-notes-shell is-entering-from-live${
        entrance.phase !== "dark" ? " is-end-meeting-background-revealed" : ""
      }${isContentVisible ? " is-end-meeting-transition-revealed" : ""}`}
    >
      <GuestNotesEntranceOverlay model={model} isMeetingInProgress={isMeetingInProgress} />
      <GuestNotesRevealContent
        model={model}
        meetingId={meetingId}
        notes={notes}
        error={error}
        currentUserId={currentUserId}
        signupHref={signupHref}
        signupAction={signupAction}
      />
    </main>
  );
}
