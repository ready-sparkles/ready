"use client";

import type {
  CalendarEventPrepEstimateResponse,
  CalendarEventPrepProcessor,
  CalendarEventPrepProgress,
  CalendarEventPrepResponse,
  CalendarEventPrepSource,
  CalendarEventsResponse,
  CalendarProvider,
  Meeting,
  NormalizedCalendarEvent,
} from "@readymeet/shared";
import { type QueryClient, useIsRestoring, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  addReadyMeetingToCalendarEvent,
  connectCalendar,
  deleteCalendarEvent,
  deleteMeeting,
  getApiErrorCode,
  getApiErrorMessage,
  getCalendarEventPrep,
  getCalendarEventPrepEstimate,
  getMyAgentSettings,
  listCalendarEvents,
  listMeetings,
  startCalendarEventPrep,
} from "../../composition/api";
import {
  getCachedCalendarConnectionProviders,
  setCachedCalendarConnectionProviders,
  subscribeToCalendarConnectionProviders,
} from "../../composition/calendar-connection-store";
import { webEnv } from "../../composition/env";
import {
  calendarReadyMeetingOptions,
  meetingNotesViewOptions,
  workspaceMeetingsOptions,
  workspaceMeetingsQueryKey,
} from "../../composition/workspace-meetings-query";
import {
  addReadyMeetingToCalendarEventsResponse,
  type CalendarEventPerson,
  getCalendarEventAvatarUrlCandidates,
  getCalendarEventDatedSubtitleParts,
  getCalendarEventParticipantPeople,
  getCalendarEventPersonInitials,
  getCalendarEventSelection,
  getCalendarEventSubtitleParts,
  getCalendarEventTitle,
  getCalendarProviderLabel,
  getUpcomingCalendarEventGroups,
  getUpcomingPreviousCalendarNavigation,
  getVisibleCalendarEvents,
  removeCalendarEventFromResponse,
} from "../../domain/calendar-events";
import { getAddReadyMeetingErrorMessage } from "../../domain/calendar-ready-meeting-errors";
import { getMeetingBriefProgressDisplay } from "../../domain/meeting-brief-progress";
import { shouldOpenPastMeetingRemoveShortcut } from "../../domain/past-meeting-removal";
import {
  getPastMeetingCardSubtitle,
  getPastMeetingPeriodNavigation,
  groupPastMeetings,
  type PastMeetingGroup,
  resolvePastMeetingSelection,
} from "../../domain/past-meetings";
import { calendarEventPrepQueryKey, calendarEventsQueryKey, meetingDetailQueryKey } from "../../domain/query-keys";
import { getCachedWorkspaceMeetings, setCachedWorkspaceMeetings } from "../../domain/workspace-meetings-cache";
import { useCalendarRealtime } from "../hooks/use-calendar-realtime";

import { AgentBreathingSignal, AgentThinkingBlock } from "./agent-thinking";
import { useAuth } from "./auth-provider";
import { CalendarEventDeleteDialog } from "./calendar-event-delete-dialog";
import { ReadyMeetingLogo } from "./calendar-ready-meeting-logo";
import { GoogleCalendarLogo } from "./google-calendar-logo";
import { PastMeetingRemoveDialog } from "./past-meeting-remove-dialog";
import { type MeetingLoadFailure, PostMeetingWorkspace } from "./post-meeting-workspace";
import { type ToastInput, useToast } from "./toast-provider";
import { useMobileMeetingNavigation } from "./use-mobile-meeting-navigation";
import { CalendarChevronIcon } from "./workspace-nav-icons";
import { ArchiveTrayIcon, CalendarStackIcon, WorkspaceShell } from "./workspace-shell";

import "./workspace-mobile-meetings.css";

const WORKSPACE_HOME_DEFAULT_GREETING_NAME = "there";
const MEETING_BRIEF_DEFAULT_COMPANY_TITLE = "Company";
const MEETING_BRIEF_SOURCES_MAX_VISIBLE = 6;
const MEETING_BRIEF_BULLET_LABEL_SEPARATOR = ":";
const SECONDS_PER_MINUTE = 60;
const WORKSPACE_QUERY_STALE_TIME_MS = 30_000;
const CALENDAR_REFRESH_INTERVAL_MS = 30_000;
const CALENDAR_WEBHOOK_UNAVAILABLE_POLL_MINUTES = 5;
const MILLISECONDS_PER_MINUTE = 60_000;
const CALENDAR_REFRESH_INTERVAL_WHEN_WEBHOOK_UNAVAILABLE_MS =
  CALENDAR_WEBHOOK_UNAVAILABLE_POLL_MINUTES * MILLISECONDS_PER_MINUTE;
const CALENDAR_NOW_TICK_MS = 60_000;
const CALENDAR_PREP_POLL_INTERVAL_MS = 3_000;
const CALENDAR_PREP_LOADING_TICK_MS = 1_000;
const RECENTLY_ADDED_READY_MEETING_CLEAR_MS = 1_200;
const COPIED_READY_MEETING_RESET_MS = 1_400;
const MEETING_BRIEF_FAVICON_SIZE_PX = 32;
const CALENDAR_OAUTH_POPUP_WIDTH = 620;
const CALENDAR_OAUTH_POPUP_HEIGHT = 760;

const WORKSPACE_HOME_MESSAGES = {
  sourcesCountLabel: (input: { count: number }) => `${input.count} Sources`,
  sessionUnavailable: "Workspace session is unavailable",
  meetingPrepNotStarted: "Meeting prep has not started.",
  companyContextFallback: "No reliable company context found yet.",
  prepProcessorPricingFallback: "Could not load processor pricing.",
  failedToLoadWorkspace: "Failed to load workspace",
  failedToDeleteMeeting: "Failed to delete meeting",
  meetingRemovedTitle: "Meeting removed",
  meetingRestoredTitle: "Meeting restored",
  calendarEventCannotBeDeletedTitle: "Calendar event cannot be deleted",
  calendarEventCannotBeDeletedMessage: "Only Google Calendar events can be deleted from Ready right now.",
  calendarEventDeletedTitle: "Calendar event deleted",
  calendarEventRestoredTitle: "Calendar event restored",
  calendarEventDeleteFallback: "Calendar event could not be deleted.",
  calendarConnectedTitle: "Calendar connected",
  calendarConnectedMessage: (providerLabel: string) => `${providerLabel} is ready.`,
  calendarConnectionFailedTitle: "Calendar connection failed",
  calendarConnectionFailedMessage: "Try connecting again.",
  calendarConnectFailedMessage: "Unable to connect your calendar.",
  calendarPrepCreditsTitle: "Add credits to run meeting prep",
  calendarPrepCreditsFallback: "Buy credits or wait for your monthly credits to reset.",
  calendarPrepStartFailedTitle: "Meeting prep could not start",
  calendarPrepStartFailedFallback: "Meeting prep could not start.",
  googleCalendarPermissionTitle: "Google Calendar permission needed",
  googleCalendarPermissionMessage: "Approve calendar write access, then add Ready Meeting again.",
  readyMeetingAddedTitle: "Ready Meeting added",
  readyMeetingAlreadyAddedTitle: "Ready Meeting already added",
  readyMeetingAlreadyAddedMessage: "This Google Calendar event already has Ready Meeting conferencing.",
  readyMeetingAddedMessage: "Ready Meeting conferencing was added to your Google Calendar event.",
  readyMeetingAddFailedTitle: "Ready Meeting could not be added",
  copyUnavailable: "Copy is not available in this browser.",
  meetingLinkCopiedTitle: "Meeting link copied",
  meetingLinkCopiedMessage: "Ready meeting link is on your clipboard.",
  meetingLinkCopyFailedTitle: "Meeting link could not be copied",
  meetingLinkCopyFailedMessage: "Try selecting and copying the link directly.",
  unableToLoadCalendar: "Unable to load calendar",
  refreshCalendarHint: "Try refreshing the page.",
  noUpcomingMeetings: "No upcoming meetings",
  noMeetings: "No meetings",
  meetingBrief: "Meeting brief",
  readyMeetingTitle: "Ready",
  readyMeetingConnectDescription: "Add a video call to this event with a meeting link, dial-in number, and PIN.",
  addingVideoCall: "Adding...",
  addVideoCall: "Add video call",
  joinMeetingLabel: "Join meeting:",
  dialInLabel: "Dial-in:",
  pinLabel: "PIN:",
  briefSectionTitle: "Brief",
  peopleSectionTitle: "People",
  emptyBriefBullet: "No relevant prior context found yet.",
  setupGreeting: (firstName: string) => `Hi ${firstName}`,
  setupHero: "Let's get you set up in just a few steps.",
  setupProgress: "Setup progress",
  setupProgressCount: (done: number) => `${done} / 2 done`,
  tryFirstMeeting: "Try your first meeting",
  tryFirstMeetingDescription: "Talk with your agent or invite others to join.",
  firstMeetingCompletedAria: "First meeting completed",
  completed: "Completed",
  start: "Start",
  connectCalendar: "Connect your calendar",
  connectCalendarDescription: "View your upcoming meetings.",
  connect: "Connect",
  chooseCalendarProvider: "Choose calendar provider",
  opening: "Opening...",
  loadingMeetings: "Loading meetings",
  noPastMeetings: "No past meetings",
  recent: "Recent",
  olderMeetings: "Older meetings",
  newerMeetings: "Newer meetings",
  goToUpcomingMeetings: "Go to upcoming meetings",
  pastMeetings: "Past meetings",
  pastMeetingPeriodNavigationAria: "Past meeting period navigation",
  nextMeeting: "Next meeting",
  goToPastMeetings: "Go to past meetings",
  previousUpcomingGroup: "Previous upcoming group",
  nextUpcomingGroup: "Next upcoming group",
  upcomingDefaultLabel: "Upcoming",
  backToMeetings: (viewLabel: string) => `Back to ${viewLabel} meetings`,
  sizingUpMeeting: "Sizing up this meeting",
  sizingUpMeetingDetail: "Checking what Ready can research before the call.",
  prepareForMeeting: "Prepare for your meeting",
  meetingResearchPro: "Meeting research is on Pro.",
  meetingPrepDefault: "Get up to speed on the people and company before the call.",
  upgradeToPro: "Upgrade to Pro",
  tryAgain: "Try again",
  preparingBrief: "Preparing your brief...",
  preparingBriefStatus: (input: { elapsed: string; lineText: string }) =>
    `Preparing your brief. ${input.elapsed}. ${input.lineText}`,
  guestLabel: "Guest",
  usPhonePrefix: "(US) +1",
  calendarPrepEstimateUnavailable: "Calendar prep estimate is unavailable",
  meetingRemovedDetail: (title: string) => `"${title}" was removed from past meetings.`,
  calendarEventDeletedDetail: (title: string) => `"${title}" was removed from your upcoming calendar.`,
  readyMeetingPinSuffix: "#",
  copyReadyMeetingLinkAria: "Copy Ready meeting link",
  readyMeetingDialInAria: "Ready Meeting dial-in details",
  calendarDayNavigationAria: "Calendar day navigation",
  meetingBriefSectionsAria: "Meeting brief sections",
  meetingDetailsAria: "Meeting details",
  participantsAria: "Participants",
} as const;

function formatReadyMeetingDialInLine(phone: string) {
  return `${WORKSPACE_HOME_MESSAGES.dialInLabel} ${phone}`;
}

function formatReadyMeetingPinLine(pin: string) {
  return `${WORKSPACE_HOME_MESSAGES.pinLabel} ${pin}${WORKSPACE_HOME_MESSAGES.readyMeetingPinSuffix}`;
}

const MILLISECONDS_PER_SECOND = 1000;

function hasNonEmptyText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCalendarPostMessageData(value: unknown): value is { type?: string; provider?: CalendarProvider } {
  return typeof value === "object" && value !== null;
}

function getFirstName(input: { displayName?: string | null; email?: string | null }) {
  const name = input.displayName?.trim();
  if (hasNonEmptyText(name)) {
    return name.split(/\s+/)[0] ?? name;
  }

  const emailName = input.email?.split("@")[0]?.trim();

  return hasNonEmptyText(emailName) ? emailName : WORKSPACE_HOME_DEFAULT_GREETING_NAME;
}

function hasWorkspaceRemovalBlockingOverlay() {
  if (typeof document === "undefined") {
    return false;
  }

  return Boolean(document.querySelector('.meeting-actions-popover, [role="dialog"]'));
}

const FREEMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);

function domainFromEmail(email?: string | null) {
  const domain = email?.trim().toLowerCase().split("@")[1]?.trim();

  return hasNonEmptyText(domain) && !FREEMAIL_DOMAINS.has(domain) ? domain : null;
}

function formatCompanyTitleFromDomain(domain: string) {
  const label = domain.split(".")[0] ?? domain;
  const formatted = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

  return formatted !== "" ? formatted : domain;
}

function getMeetingBriefCompanyTitle(input: {
  event: NormalizedCalendarEvent | null;
  prep: CalendarEventPrepResponse | null;
  userEmail?: string | null;
}) {
  const researchedName = input.prep?.company?.companyName?.trim();
  if (hasNonEmptyText(researchedName)) {
    return researchedName;
  }

  const event = input.event;
  if (event === null) {
    return MEETING_BRIEF_DEFAULT_COMPANY_TITLE;
  }

  const ownDomain = domainFromEmail(input.userEmail);
  const organizerDomain = domainFromEmail(event.organizer?.email);
  if (organizerDomain !== null && organizerDomain !== ownDomain) {
    return formatCompanyTitleFromDomain(organizerDomain);
  }

  return getMajorityAttendeeCompanyTitle({ event, ownDomain });
}

function getMajorityAttendeeCompanyTitle(input: { event: NormalizedCalendarEvent; ownDomain: string | null }) {
  const domainCounts = input.event.attendees.reduce((counts, attendee) => {
    const domain = domainFromEmail(attendee.email);
    if (domain === null || domain === input.ownDomain) {
      return counts;
    }

    return new Map([...counts, [domain, (counts.get(domain) ?? 0) + 1]]);
  }, new Map<string, number>());

  const sortedDomainCounts = [...domainCounts.entries()].sort((left, right) => right[1] - left[1]);
  const majorityDomain = sortedDomainCounts[0]?.[0];

  return hasNonEmptyText(majorityDomain)
    ? formatCompanyTitleFromDomain(majorityDomain)
    : MEETING_BRIEF_DEFAULT_COMPANY_TITLE;
}

function isLocalCalendarWebhookUnavailable() {
  try {
    return new URL(webEnv.NEXT_PUBLIC_API_BASE_URL).protocol !== "https:";
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return true;
  }
}

function formatReadyMeetingDisplayUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./i, "");
    const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;

    return `${host}${suffix === "/" ? "" : suffix.replace(/\/$/, "")}`;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  }
}

function getReadyMeetingCodeFromJoinUrl(url: string) {
  try {
    return (
      new URL(url).pathname
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)[0] ?? null
    );
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    const normalized = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");

    const code = normalized.split("/").slice(1).join("/").split(/[?#]/)[0]?.trim();

    return hasNonEmptyText(code) ? code : null;
  }
}

function formatReadyMeetingDialInPhoneNumber(phoneNumber: string) {
  const normalized = phoneNumber.trim();
  const match = normalized.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (match !== null) {
    const areaCode = match[1] ?? "";
    const prefix = match[2] ?? "";
    const lineNumber = match[3] ?? "";

    return `${WORKSPACE_HOME_MESSAGES.usPhonePrefix} ${areaCode}-${prefix}-${lineNumber}`;
  }

  return normalized;
}

function SetupAgentIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-setup-icon workspace-setup-agent-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
      />
    </svg>
  );
}

function getSourceHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return null;
  }
}

function getSourceFaviconUrl(url: string) {
  const hostname = getSourceHostname(url);

  return hostname !== null
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=${MEETING_BRIEF_FAVICON_SIZE_PX}`
    : null;
}

function MeetingBriefSources({ sources }: { sources: CalendarEventPrepSource[] }) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    function closeOnOutsidePointerDown(event: PointerEvent) {
      const details = detailsRef.current;
      if (details === null || !details.open || event.target === null || !(event.target instanceof Node)) {
        return;
      }
      if (!details.contains(event.target)) {
        details.open = false;
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
    };
  }, []);

  if (sources.length === 0) {
    return null;
  }
  const sourceItems = sources.slice(0, MEETING_BRIEF_SOURCES_MAX_VISIBLE).map((source) => ({
    ...source,
    faviconUrl: getSourceFaviconUrl(source.url),
    hostname: getSourceHostname(source.url),
  }));
  const faviconItems = sourceItems
    .filter((source) => Boolean(source.faviconUrl))
    .filter((source, index, all) => all.findIndex((item) => item.hostname === source.hostname) === index)
    .slice(0, MEETING_BRIEF_SOURCES_MAX_VISIBLE);

  return (
    <details ref={detailsRef} className="workspace-meeting-brief-sources">
      <summary className="workspace-meta-pill workspace-meeting-brief-sources-pill">
        {faviconItems.length !== 0 ? (
          <span className="workspace-meeting-brief-source-favicon-stack" aria-hidden="true">
            {faviconItems.map((source) => (
              <span key={source.hostname ?? source.url} className="workspace-meeting-brief-source-favicon-circle">
                <img src={source.faviconUrl ?? ""} alt="" />
              </span>
            ))}
          </span>
        ) : null}
        <span>{WORKSPACE_HOME_MESSAGES.sourcesCountLabel({ count: sources.length })}</span>
      </summary>
      <div className="workspace-meeting-brief-sources-popover">
        {sourceItems.map((source) => (
          <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
            {hasNonEmptyText(source.faviconUrl) ? <img aria-hidden="true" src={source.faviconUrl} alt="" /> : null}
            <span>{source.title}</span>
          </a>
        ))}
      </div>
    </details>
  );
}

type MeetingBriefResearchKind = "people" | "company";

function getMeetingBriefSectionProgress(input: {
  progress: CalendarEventPrepProgress | null | undefined;
  kind: MeetingBriefResearchKind;
}) {
  if (input.progress === null || input.progress === undefined) {
    return null;
  }

  return input.kind === "people"
    ? {
        status: input.progress.peopleStatus,
        message: input.progress.peopleMessage,
        messages: input.progress.peopleMessages,
      }
    : {
        status: input.progress.companyStatus,
        message: input.progress.companyMessage,
        messages: input.progress.companyMessages,
      };
}

function timestampFromIso(value?: string | null) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatMeetingPrepElapsed(totalSeconds: number) {
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;

  return `${minutes}m ${seconds}s`;
}

const MEETING_BRIEF_PROGRESS_VISIBLE_LINE_COUNT = 8;
const MEETING_BRIEF_PROGRESS_MAX_RENDERED_LINE_COUNT = 20;
const MEETING_BRIEF_PROGRESS_LINE_STEP_PX = 24.5;

function MeetingBriefResearchProgress({
  elapsedSeconds,
  fallbackMessages,
  peopleMessages,
  companyMessages,
  prepStatus,
}: {
  elapsedSeconds: number;
  fallbackMessages?: readonly (string | null | undefined)[] | null;
  peopleMessages?: readonly string[] | null;
  companyMessages?: readonly string[] | null;
  prepStatus: CalendarEventPrepResponse["status"] | "loading";
}) {
  const progressDisplay = getMeetingBriefProgressDisplay({
    peopleMessages,
    companyMessages,
    fallbackMessages,
    prepStatus,
  });
  const lines = progressDisplay.lines.slice(-MEETING_BRIEF_PROGRESS_MAX_RENDERED_LINE_COUNT);
  const hiddenLineCount = Math.max(0, lines.length - MEETING_BRIEF_PROGRESS_VISIBLE_LINE_COUNT);
  const linesStyle = {
    "--workspace-meeting-brief-progress-offset": `${hiddenLineCount * -MEETING_BRIEF_PROGRESS_LINE_STEP_PX}px`,
  } satisfies CSSProperties;
  const formattedElapsed = formatMeetingPrepElapsed(elapsedSeconds);
  const statusLabel = WORKSPACE_HOME_MESSAGES.preparingBriefStatus({
    elapsed: formattedElapsed,
    lineText: lines.map((line) => line.text).join(". "),
  });

  return (
    <div
      className="workspace-meeting-brief-progress workspace-thinking-block workspace-meeting-prep-thinking"
      role="status"
      aria-live="polite"
      aria-label={statusLabel}
    >
      <AgentBreathingSignal />
      <div className="workspace-thinking-block-copy">
        <div className="workspace-meeting-brief-progress-header">
          <span className="workspace-thinking-block-line">{WORKSPACE_HOME_MESSAGES.preparingBrief}</span>
          <span className="workspace-meeting-brief-progress-duration">{formattedElapsed}</span>
        </div>
        <div className="workspace-meeting-brief-progress-lines" style={linesStyle} aria-hidden="true">
          <div className="workspace-meeting-brief-progress-line-stack">
            {lines.map((line) => (
              <p key={line.text}>{line.text}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderMeetingBriefBulletText(bullet: string) {
  const formattedBullet = bullet
    .replace(/^(Background|Scope):\s+/i, "")
    .replace(/^(\s*)([a-z])/, (_match, leading: string, letter: string) => `${leading}${letter.toUpperCase()}`);
  const match = /^([^:]{1,90}):\s+(.+)$/.exec(formattedBullet);
  if (!match) {
    return formattedBullet;
  }

  return (
    <>
      <strong className="workspace-meeting-brief-bullet-emphasis">
        {match[1]}
        {MEETING_BRIEF_BULLET_LABEL_SEPARATOR}
      </strong>{" "}
      {match[2]}
    </>
  );
}

function MeetingBriefPlainSection({
  bullets,
  sources,
  title,
}: {
  bullets: string[];
  sources: CalendarEventPrepSource[];
  title: string;
}) {
  return (
    <section className="workspace-meeting-brief-plain-section">
      <h5>{title}</h5>
      {bullets.map((bullet) => (
        <p key={bullet}>
          <span aria-hidden="true" className="workspace-meeting-brief-bullet" />
          <span>{renderMeetingBriefBulletText(bullet)}</span>
        </p>
      ))}
      <MeetingBriefSources sources={sources} />
    </section>
  );
}

function MeetingPrepPromptLoadingCard() {
  return (
    <AgentThinkingBlock
      className="workspace-meeting-prep-thinking"
      title={WORKSPACE_HOME_MESSAGES.sizingUpMeeting}
      detail={WORKSPACE_HOME_MESSAGES.sizingUpMeetingDetail}
      orbState="breathing"
    />
  );
}

function shouldShowMeetingPrepPromptLoading(input: {
  estimate: CalendarEventPrepEstimateResponse | null;
  errorMessage: string | null;
  isLoading: boolean;
  isUpgradeRequired: boolean;
}) {
  return (
    !input.isUpgradeRequired && input.estimate === null && (input.isLoading || !hasNonEmptyText(input.errorMessage))
  );
}

function hasMeetingPrepEstimateErrorRetry(input: {
  estimate: CalendarEventPrepEstimateResponse | null;
  errorMessage: string | null;
  isUpgradeRequired: boolean;
}) {
  return !input.isUpgradeRequired && input.estimate === null && hasNonEmptyText(input.errorMessage);
}

function MeetingPrepPromptCard({
  estimate,
  errorMessage,
  isBusy,
  isLoading,
  isUpgradeRequired,
  onRetry,
  onSelect,
  onUpgrade,
}: {
  estimate: CalendarEventPrepEstimateResponse | null;
  errorMessage: string | null;
  isBusy: boolean;
  isLoading: boolean;
  isUpgradeRequired: boolean;
  onRetry: () => void;
  onSelect: (processor: CalendarEventPrepProcessor) => void;
  onUpgrade: () => void;
}) {
  if (shouldShowMeetingPrepPromptLoading({ estimate, errorMessage, isLoading, isUpgradeRequired })) {
    return <MeetingPrepPromptLoadingCard />;
  }

  const hasPrepEstimateErrorRetry = hasMeetingPrepEstimateErrorRetry({
    estimate,
    errorMessage,
    isUpgradeRequired,
  });

  return (
    <section className="workspace-meeting-prep-menu">
      <div className="workspace-meeting-prep-menu-copy">
        <div className="workspace-meeting-prep-menu-title">
          <svg
            aria-hidden="true"
            className="workspace-meeting-prep-menu-logo"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 15V9C18 6.17157 18 4.75736 17.1213 3.87868C16.2426 3 14.8284 3 12 3H8C5.17157 3 3.75736 3 2.87868 3.87868C2 4.75736 2 6.17157 2 9V15C2 17.8284 2 19.2426 2.87868 20.1213C3.75736 21 5.17157 21 8 21H20" />
            <path d="M6 8L14 8" />
            <path d="M6 12L14 12" />
            <path d="M6 16L10 16" />
            <path d="M18 8H19C20.4142 8 21.1213 8 21.5607 8.43934C22 8.87868 22 9.58579 22 11V19C22 20.1046 21.1046 21 20 21C18.8954 21 18 20.1046 18 19V8Z" />
          </svg>
          <h5>{WORKSPACE_HOME_MESSAGES.prepareForMeeting}</h5>
        </div>
        <p>
          {isUpgradeRequired
            ? WORKSPACE_HOME_MESSAGES.meetingResearchPro
            : hasPrepEstimateErrorRetry
              ? errorMessage
              : WORKSPACE_HOME_MESSAGES.meetingPrepDefault}
        </p>
      </div>
      <div className="workspace-meeting-prep-options" aria-label="Meeting prep options">
        {isUpgradeRequired ? (
          <button type="button" disabled={isBusy} onClick={onUpgrade}>
            <span>{WORKSPACE_HOME_MESSAGES.upgradeToPro}</span>
          </button>
        ) : hasPrepEstimateErrorRetry ? (
          <button type="button" disabled={isBusy} onClick={onRetry}>
            <span>{WORKSPACE_HOME_MESSAGES.tryAgain}</span>
          </button>
        ) : (
          estimate?.options.map((option) => (
            <button key={option.processor} type="button" disabled={isBusy} onClick={() => onSelect(option.processor)}>
              <span>{getPrepProcessorDisplayLabel(option)}</span>
              <small>
                <span className="workspace-meeting-prep-subtitle-desktop">{getPrepProcessorSubtitle({ option })}</span>
                <span className="workspace-meeting-prep-subtitle-mobile">
                  {getPrepProcessorSubtitle({ option, isCompact: true })}
                </span>
              </small>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function getPrepProcessorDisplayLabel(option: CalendarEventPrepEstimateResponse["options"][number]) {
  if (option.processor === "core") {
    return "Quick";
  }

  if (option.processor === "pro") {
    return "Thorough";
  }

  return "Deep";
}

function getPrepProcessorSubtitle(input: {
  option: CalendarEventPrepEstimateResponse["options"][number];
  isCompact?: boolean;
}) {
  const isCompact = input.isCompact === true;
  if (input.option.processor === "core") {
    return isCompact ? "1–5 min" : "The essentials · 1–5 min";
  }

  if (input.option.processor === "pro") {
    return isCompact ? "3–9 min" : "More detail from more sources · 3–9 min";
  }

  return isCompact ? "5–25 min" : "The most complete brief · 5–25 min";
}

function OutlookCalendarLogoDefsEarly() {
  return (
    <>
      <linearGradient
        id="workspace-outlook-linear0"
        gradientUnits="userSpaceOnUse"
        x1="9.98908"
        y1="22.364901"
        x2="30.932199"
        y2="9.37495"
        gradientTransform="matrix(15,0,0,15,0,0)"
      >
        <stop offset="0" stopColor="rgb(12.54902%,65.490196%,98.039216%)" stopOpacity="1" />
        <stop offset="0.4" stopColor="rgb(23.137255%,83.529412%,100%)" stopOpacity="1" />
        <stop offset="1" stopColor="rgb(76.862745%,69.019608%,100%)" stopOpacity="1" />
      </linearGradient>
      <linearGradient
        id="workspace-outlook-linear1"
        gradientUnits="userSpaceOnUse"
        x1="17.197201"
        y1="26.7945"
        x2="28.856199"
        y2="8.12575"
        gradientTransform="matrix(15,0,0,15,0,0)"
      >
        <stop offset="0" stopColor="rgb(8.627451%,35.294118%,85.098039%)" stopOpacity="1" />
        <stop offset="0.5008" stopColor="rgb(9.411765%,50.196078%,89.803922%)" stopOpacity="1" />
        <stop offset="1" stopColor="rgb(52.156863%,52.941176%,100%)" stopOpacity="1" />
      </linearGradient>
      <linearGradient
        id="workspace-outlook-linear2"
        gradientUnits="userSpaceOnUse"
        x1="25.7005"
        y1="27.048401"
        x2="12.7563"
        y2="16.501301"
        gradientTransform="matrix(15,0,0,15,0,0)"
      >
        <stop offset="0.236946" stopColor="rgb(26.666667%,54.117647%,100%)" stopOpacity="0" />
        <stop offset="0.792113" stopColor="rgb(0%,19.607843%,69.411765%)" stopOpacity="0.2" />
      </linearGradient>
      <linearGradient
        id="workspace-outlook-linear3"
        gradientUnits="userSpaceOnUse"
        x1="24.0534"
        y1="31.1099"
        x2="44.509998"
        y2="18.0177"
        gradientTransform="matrix(15,0,0,15,0,0)"
      >
        <stop offset="0" stopColor="rgb(10.196078%,26.27451%,65.098039%)" stopOpacity="1" />
        <stop offset="0.492267" stopColor="rgb(12.54902%,32.156863%,79.607843%)" stopOpacity="1" />
        <stop offset="1" stopColor="rgb(37.254902%,12.54902%,79.607843%)" stopOpacity="1" />
      </linearGradient>
    </>
  );
}

function OutlookCalendarLogoDefsLate() {
  return (
    <>
      <linearGradient
        id="workspace-outlook-linear4"
        gradientUnits="userSpaceOnUse"
        x1="29.8281"
        y1="30.327299"
        x2="17.397499"
        y2="19.570801"
        gradientTransform="matrix(15,0,0,15,0,0)"
      >
        <stop offset="0" stopColor="rgb(0%,27.058824%,72.54902%)" stopOpacity="0" />
        <stop offset="0.669859" stopColor="rgb(5.098039%,12.156863%,41.176471%)" stopOpacity="0.2" />
      </linearGradient>
      <radialGradient
        id="workspace-outlook-radial0"
        gradientUnits="userSpaceOnUse"
        cx="0"
        cy="0"
        fx="0"
        fy="0"
        r="1"
        gradientTransform="matrix(0.000000000000024802,-405.040512,438.393002,0.000000000000026844,360.027008,102.268202)"
      >
        <stop offset="0.568182" stopColor="rgb(15.294118%,37.254902%,94.117647%)" stopOpacity="0" />
        <stop offset="0.992424" stopColor="rgb(0%,12.941176%,46.666667%)" stopOpacity="1" />
      </radialGradient>
    </>
  );
}

function OutlookCalendarLogoDefsLateTail() {
  return (
    <>
      <linearGradient
        id="workspace-outlook-linear5"
        gradientUnits="userSpaceOnUse"
        x1="41.998001"
        y1="29.9431"
        x2="23.8517"
        y2="29.9431"
        gradientTransform="matrix(15,0,0,15,0,0)"
      >
        <stop offset="0" stopColor="rgb(30.196078%,76.862745%,100%)" stopOpacity="1" />
        <stop offset="0.196145" stopColor="rgb(5.882353%,68.627451%,100%)" stopOpacity="1" />
      </linearGradient>
      <radialGradient
        id="workspace-outlook-radial1"
        gradientUnits="userSpaceOnUse"
        cx="0"
        cy="0"
        fx="0"
        fy="0"
        r="1"
        gradientTransform="matrix(122.73959,-122.73959,122.73959,122.73959,421.392002,568.675518)"
      >
        <stop offset="0.259477" stopColor="rgb(0%,37.647059%,81.960784%)" stopOpacity="0.4" />
        <stop offset="0.908166" stopColor="rgb(1.176471%,51.372549%,94.509804%)" stopOpacity="0" />
      </radialGradient>
      <radialGradient
        id="workspace-outlook-radial2"
        gradientUnits="userSpaceOnUse"
        cx="0"
        cy="0"
        fx="0"
        fy="0"
        r="1"
        gradientTransform="matrix(357.407022,-468.445926,423.594568,323.187085,159.471002,697.080002)"
      >
        <stop offset="0.732317" stopColor="rgb(95.686275%,65.490196%,96.862745%)" stopOpacity="0" />
        <stop offset="1" stopColor="rgb(95.686275%,65.490196%,96.862745%)" stopOpacity="0.501961" />
      </radialGradient>
      <radialGradient
        id="workspace-outlook-radial3"
        gradientUnits="userSpaceOnUse"
        cx="0"
        cy="0"
        fx="0"
        fy="0"
        r="1"
        gradientTransform="matrix(-170.860868,259.725406,-674.018133,-443.404152,278.562012,412.978506)"
      >
        <stop offset="0" stopColor="rgb(28.627451%,87.058824%,100%)" stopOpacity="1" />
        <stop offset="0.724349" stopColor="rgb(16.078431%,76.470588%,100%)" stopOpacity="1" />
      </radialGradient>
      <linearGradient
        id="workspace-outlook-linear6"
        gradientUnits="userSpaceOnUse"
        x1="3.45756"
        y1="37.872299"
        x2="20.9291"
        y2="37.859699"
        gradientTransform="matrix(15,0,0,15,0,0)"
      >
        <stop offset="0.205882" stopColor="rgb(42.352941%,87.843137%,100%)" stopOpacity="1" />
        <stop offset="0.535" stopColor="rgb(31.372549%,83.529412%,100%)" stopOpacity="0" />
      </linearGradient>
      <radialGradient
        id="workspace-outlook-radial4"
        gradientUnits="userSpaceOnUse"
        cx="0"
        cy="0"
        fx="0"
        fy="0"
        r="1"
        gradientTransform="matrix(215.76719,230.769125,-230.769125,215.76719,59.143649,354.231005)"
      >
        <stop offset="0.038877" stopColor="rgb(0%,56.862745%,100%)" stopOpacity="1" />
        <stop offset="0.919119" stopColor="rgb(9.411765%,23.921569%,67.843137%)" stopOpacity="1" />
      </radialGradient>
      <radialGradient
        id="workspace-outlook-radial5"
        gradientUnits="userSpaceOnUse"
        cx="0"
        cy="0"
        fx="0"
        fy="0"
        r="1"
        gradientTransform="matrix(0.000000000000010287,167.999997,-193.782005,0.000000000000011866,180,491.158504)"
      >
        <stop offset="0.557796" stopColor="rgb(5.882353%,64.705882%,96.862745%)" stopOpacity="0" />
        <stop offset="1" stopColor="rgb(45.490196%,77.647059%,100%)" stopOpacity="0.501961" />
      </radialGradient>
    </>
  );
}

function OutlookCalendarLogoDefs() {
  return (
    <defs>
      <OutlookCalendarLogoDefsEarly />
      <OutlookCalendarLogoDefsLate />
      <OutlookCalendarLogoDefsLateTail />
    </defs>
  );
}

function OutlookCalendarLogoPaths() {
  return (
    <g>
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-linear0)"
        d="M 463.984375 140.144531 L 119.636719 358.414062 L 90.023438 311.695312 L 90.023438 271.4375 C 90.023438 256.78125 97.445312 243.121094 109.742188 235.144531 L 309.910156 105.257812 C 340.40625 85.46875 379.6875 85.464844 410.1875 105.25 Z M 463.984375 140.144531 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-linear1)"
        d="M 407.101562 103.339844 C 408.136719 103.953125 409.164062 104.59375 410.183594 105.253906 L 566.398438 206.585938 L 179.0625 452.105469 L 119.625 358.335938 L 403.894531 177.800781 C 430.820312 160.699219 432 122.230469 407.101562 103.339844 Z M 407.101562 103.339844 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-linear2)"
        d="M 407.101562 103.339844 C 408.136719 103.953125 409.164062 104.59375 410.183594 105.253906 L 566.398438 206.585938 L 179.0625 452.105469 L 119.625 358.335938 L 403.894531 177.800781 C 430.820312 160.699219 432 122.230469 407.101562 103.339844 Z M 407.101562 103.339844 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-linear3)"
        d="M 333.601562 498.988281 L 179.066406 452.109375 L 507.628906 243.835938 C 535.300781 226.296875 535.230469 185.898438 507.496094 168.457031 L 506.015625 167.527344 L 510.277344 170.175781 L 610.273438 235.042969 C 622.574219 243.019531 629.996094 256.683594 629.996094 271.34375 L 629.996094 310.304688 Z M 333.601562 498.988281 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-linear4)"
        d="M 333.601562 498.988281 L 179.066406 452.109375 L 507.628906 243.835938 C 535.300781 226.296875 535.230469 185.898438 507.496094 168.457031 L 506.015625 167.527344 L 510.277344 170.175781 L 610.273438 235.042969 C 622.574219 243.019531 629.996094 256.683594 629.996094 271.34375 L 629.996094 310.304688 Z M 333.601562 498.988281 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-radial0)"
        d="M 410.1875 105.25 C 379.6875 85.464844 340.40625 85.46875 309.90625 105.257812 L 109.742188 235.144531 C 97.445312 243.121094 90.023438 256.78125 90.023438 271.4375 L 90.023438 273.40625 C 90.507812 288.121094 98.25 301.679688 110.757812 309.566406 L 359.644531 466.476562 L 609.160156 309.804688 C 622.121094 301.667969 629.984375 287.441406 629.984375 272.140625 L 629.984375 310.308594 L 629.992188 271.34375 C 629.992188 256.683594 622.566406 243.023438 610.269531 235.042969 Z M 410.1875 105.25 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-linear5)"
        d="M 315.769531 630.050781 L 536.21875 630.050781 C 587.996094 630.050781 629.96875 588.078125 629.96875 536.300781 L 629.96875 272.140625 C 629.96875 287.441406 622.105469 301.667969 609.148438 309.804688 L 281.242188 515.695312 C 263.554688 526.804688 252.820312 546.222656 252.820312 567.109375 C 252.824219 601.871094 281.003906 630.050781 315.769531 630.050781 Z M 315.769531 630.050781 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-radial1)"
        d="M 315.769531 630.050781 L 536.21875 630.050781 C 587.996094 630.050781 629.96875 588.078125 629.96875 536.300781 L 629.96875 272.140625 C 629.96875 287.441406 622.105469 301.667969 609.148438 309.804688 L 281.242188 515.695312 C 263.554688 526.804688 252.820312 546.222656 252.820312 567.109375 C 252.824219 601.871094 281.003906 630.050781 315.769531 630.050781 Z M 315.769531 630.050781 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-radial2)"
        d="M 315.769531 630.050781 L 536.21875 630.050781 C 587.996094 630.050781 629.96875 588.078125 629.96875 536.300781 L 629.96875 272.140625 C 629.96875 287.441406 622.105469 301.667969 609.148438 309.804688 L 281.242188 515.695312 C 263.554688 526.804688 252.820312 546.222656 252.820312 567.109375 C 252.824219 601.871094 281.003906 630.050781 315.769531 630.050781 Z M 315.769531 630.050781 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-radial3)"
        d="M 405.402344 630.035156 L 183.738281 630.035156 C 131.960938 630.035156 89.988281 588.0625 89.988281 536.285156 L 89.988281 271.945312 C 89.988281 287.21875 97.824219 301.421875 110.742188 309.566406 L 438.324219 516.085938 C 456.257812 527.390625 467.132812 547.113281 467.132812 568.3125 C 467.128906 602.402344 439.492188 630.035156 405.402344 630.035156 Z M 405.402344 630.035156 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-linear6)"
        d="M 405.402344 630.035156 L 183.738281 630.035156 C 131.960938 630.035156 89.988281 588.0625 89.988281 536.285156 L 89.988281 271.945312 C 89.988281 287.21875 97.824219 301.421875 110.742188 309.566406 L 438.324219 516.085938 C 456.257812 527.390625 467.132812 547.113281 467.132812 568.3125 C 467.128906 602.402344 439.492188 630.035156 405.402344 630.035156 Z M 405.402344 630.035156 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-radial4)"
        d="M 108.75 345 L 251.25 345 C 278.175781 345 300 366.824219 300 393.75 L 300 536.25 C 300 563.175781 278.175781 585 251.25 585 L 108.75 585 C 81.824219 585 60 563.175781 60 536.25 L 60 393.75 C 60 366.824219 81.824219 345 108.75 345 Z M 108.75 345 "
      />
      <path
        fillRule="nonzero"
        fill="url(#workspace-outlook-radial5)"
        d="M 108.75 345 L 251.25 345 C 278.175781 345 300 366.824219 300 393.75 L 300 536.25 C 300 563.175781 278.175781 585 251.25 585 L 108.75 585 C 81.824219 585 60 563.175781 60 536.25 L 60 393.75 C 60 366.824219 81.824219 345 108.75 345 Z M 108.75 345 "
      />
      <path
        fillRule="nonzero"
        fill="#FFFFFF"
        d="M 179.386719 534 C 159.539062 534 143.25 527.789062 130.511719 515.375 C 117.773438 502.960938 111.402344 486.757812 111.402344 466.769531 C 111.402344 445.660156 117.867188 428.589844 130.796875 415.550781 C 143.730469 402.515625 160.660156 396 181.59375 396 C 201.375 396 217.472656 402.238281 229.890625 414.714844 C 242.375 427.191406 248.617188 443.644531 248.617188 464.066406 C 248.617188 485.050781 242.148438 501.964844 229.21875 514.816406 C 216.351562 527.605469 199.742188 534 179.386719 534 Z M 179.960938 507.648438 C 190.777344 507.648438 199.484375 503.953125 206.078125 496.566406 C 212.671875 489.179688 215.96875 478.902344 215.96875 465.742188 C 215.96875 452.023438 212.765625 441.347656 206.367188 433.710938 C 199.964844 426.074219 191.417969 422.257812 180.730469 422.257812 C 169.71875 422.257812 160.851562 426.199219 154.132812 434.082031 C 147.410156 441.90625 144.050781 452.273438 144.050781 465.183594 C 144.050781 478.285156 147.410156 488.652344 154.132812 496.285156 C 160.851562 503.859375 169.460938 507.648438 179.960938 507.648438 Z M 179.960938 507.648438 "
      />
      <path
        fillRule="nonzero"
        fill="#FFFFFF"
        d="M 179.332031 535.847656 C 159.5625 535.847656 143.332031 529.472656 130.640625 516.71875 C 117.953125 503.964844 111.605469 487.320312 111.605469 466.789062 C 111.605469 445.105469 118.046875 427.570312 130.929688 414.179688 C 143.8125 400.785156 160.679688 394.089844 181.53125 394.089844 C 201.234375 394.089844 217.273438 400.5 229.644531 413.316406 C 242.082031 426.136719 248.296875 443.035156 248.296875 464.015625 C 248.296875 485.566406 241.855469 502.945312 228.976562 516.144531 C 216.15625 529.28125 199.609375 535.847656 179.332031 535.847656 Z M 179.902344 508.78125 C 190.679688 508.78125 199.355469 504.984375 205.921875 497.398438 C 212.492188 489.808594 215.773438 479.253906 215.773438 465.734375 C 215.773438 451.640625 212.585938 440.675781 206.210938 432.832031 C 199.832031 424.988281 191.320312 421.066406 180.671875 421.066406 C 169.699219 421.066406 160.867188 425.113281 154.171875 433.214844 C 147.476562 441.246094 144.128906 451.898438 144.128906 465.160156 C 144.128906 478.617188 147.476562 489.265625 154.171875 497.109375 C 160.867188 504.890625 169.445312 508.78125 179.902344 508.78125 Z M 179.902344 508.78125 "
      />
    </g>
  );
}

export function OutlookCalendarLogo() {
  return (
    <svg aria-hidden="true" viewBox="60 90.4 570.02 539.67" className="workspace-calendar-provider-logo">
      <OutlookCalendarLogoDefs />
      <OutlookCalendarLogoPaths />
    </svg>
  );
}

function CalendarProviderLogo({ provider }: { provider: CalendarProvider }) {
  return provider === "google_calendar" ? (
    <GoogleCalendarLogo className="workspace-calendar-provider-logo is-google-calendar-logo" />
  ) : (
    <OutlookCalendarLogo />
  );
}

function getCalendarParticipantPillKey(input: { person: CalendarEventPerson; index: number }) {
  const { person, index } = input;
  const emailKey = person.email?.trim().toLowerCase();
  if (hasNonEmptyText(emailKey)) {
    return emailKey;
  }

  const nameKey = person.name?.trim().toLowerCase();
  if (hasNonEmptyText(nameKey)) {
    return nameKey;
  }

  return String(index);
}

function getCalendarPersonLabel(person: CalendarEventPerson) {
  const trimmedName = person.name?.trim();
  const emailLocalPart = person.email?.split("@")[0]?.trim();
  const label = hasNonEmptyText(trimmedName)
    ? trimmedName
    : hasNonEmptyText(emailLocalPart)
      ? emailLocalPart
      : WORKSPACE_HOME_MESSAGES.guestLabel;
  if (/\s/.test(label) || !/[._-]/.test(label)) {
    return label;
  }

  return label
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function CalendarEventParticipantPill({
  currentUserAvatarUrl,
  currentUserDisplayName,
  currentUserEmail,
  person,
}: {
  currentUserAvatarUrl?: string | null;
  currentUserDisplayName?: string | null;
  currentUserEmail?: string | null;
  person: CalendarEventPerson;
}) {
  const avatarUrlCandidates = getCalendarEventAvatarUrlCandidates({
    person,
    currentUserAvatarUrl,
    currentUserDisplayName,
    currentUserEmail,
  });
  const [failedAvatarUrls, setFailedAvatarUrls] = useState<string[]>([]);
  const avatarUrl = avatarUrlCandidates.find((candidate) => !failedAvatarUrls.includes(candidate)) ?? null;
  const hasAvatarUrl = hasNonEmptyText(avatarUrl);

  useEffect(() => {
    setFailedAvatarUrls([]);
  }, [avatarUrlCandidates.join("\n")]);

  return (
    <span className="workspace-meta-pill workspace-calendar-participant-pill">
      <span className={`workspace-calendar-participant-avatar${hasAvatarUrl ? "" : " is-initials"}`} aria-hidden="true">
        {hasAvatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            onError={() =>
              setFailedAvatarUrls((current) => (current.includes(avatarUrl) ? current : [...current, avatarUrl]))
            }
          />
        ) : (
          <span>{getCalendarEventPersonInitials(person)}</span>
        )}
      </span>
      <span className="workspace-calendar-participant-name">{getCalendarPersonLabel(person)}</span>
    </span>
  );
}

function CalendarEventParticipantPills({
  currentUserAvatarUrl,
  currentUserDisplayName,
  currentUserEmail,
  event,
}: {
  currentUserAvatarUrl?: string | null;
  currentUserDisplayName?: string | null;
  currentUserEmail?: string | null;
  event: NormalizedCalendarEvent;
}) {
  const people = getCalendarEventParticipantPeople(event, currentUserEmail, currentUserDisplayName);

  if (people.length === 0) {
    return null;
  }

  return (
    <span className="workspace-calendar-participant-pills" aria-label={WORKSPACE_HOME_MESSAGES.participantsAria}>
      {people.map((person, index) => (
        <CalendarEventParticipantPill
          key={getCalendarParticipantPillKey({ person, index })}
          currentUserAvatarUrl={currentUserAvatarUrl}
          currentUserDisplayName={currentUserDisplayName}
          currentUserEmail={currentUserEmail}
          person={person}
        />
      ))}
    </span>
  );
}

function ReadyMeetingCopyIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ReadyMeetingCheckIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ReadyMeetingCopyStatusIcon({ isCopied }: { isCopied: boolean }) {
  return (
    <span className="workspace-ready-meeting-copy-icon" aria-hidden="true">
      <ReadyMeetingCopyIcon className={`workspace-ready-meeting-copy-status-icon${isCopied ? "" : " is-visible"}`} />
      <ReadyMeetingCheckIcon className={`workspace-ready-meeting-copy-status-icon${isCopied ? " is-visible" : ""}`} />
    </span>
  );
}

function isCalendarProviderValue(value: string): value is CalendarProvider {
  return value === "google_calendar" || value === "outlook_calendar";
}

function computeConnectedCalendarProviders(input: {
  isCalendarEventsSuccess: boolean;
  calendarEventsData: CalendarEventsResponse | undefined;
  cachedCalendarProviders: CalendarProvider[] | null;
  agentSettingsConnectors: { provider: string; status: string }[] | undefined;
}) {
  if (input.isCalendarEventsSuccess && input.calendarEventsData !== undefined) {
    return input.calendarEventsData.connectedProviders;
  }
  const providers = new Set<CalendarProvider>([
    ...(input.cachedCalendarProviders ?? []),
    ...(input.calendarEventsData?.connectedProviders ?? []),
    ...(input.agentSettingsConnectors ?? []).flatMap((connector) =>
      isCalendarProviderValue(connector.provider) && connector.status === "connected" ? [connector.provider] : [],
    ),
  ]);

  return Array.from(providers);
}

function useDismissOnOutsidePointer(input: {
  isActive: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
}) {
  const { isActive, containerRef, onDismiss } = input;

  useEffect(() => {
    if (!isActive) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target) === true) {
        return;
      }
      onDismiss();
    }

    window.addEventListener("pointerdown", handlePointerDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [containerRef, isActive, onDismiss]);
}

function useWorkspaceCalendarOAuthMessages(input: {
  connectedCalendarProviders: CalendarProvider[];
  refetchCalendarConnection: () => void;
  sessionUserId: string | undefined;
  showToast: (toast: ToastInput) => void;
  onConnectingCalendarProviderChange: (provider: CalendarProvider | null) => void;
  onCalendarProviderPickerOpenChange: (isOpen: boolean) => void;
}) {
  const {
    connectedCalendarProviders,
    refetchCalendarConnection,
    sessionUserId,
    showToast,
    onConnectingCalendarProviderChange,
    onCalendarProviderPickerOpenChange,
  } = input;

  useEffect(() => {
    function handleCalendarMessage(event: MessageEvent) {
      const apiOrigin = new URL(webEnv.NEXT_PUBLIC_API_BASE_URL).origin;
      if (event.origin !== apiOrigin) {
        return;
      }

      if (!isCalendarPostMessageData(event.data)) {
        return;
      }

      const data = event.data;
      if (data.type === "readymeet.calendar.connected") {
        onConnectingCalendarProviderChange(null);
        onCalendarProviderPickerOpenChange(false);
        const userId = sessionUserId;
        const provider = data.provider;
        if (hasNonEmptyText(userId) && provider !== undefined) {
          setCachedCalendarConnectionProviders(userId, [...connectedCalendarProviders, provider]);
        }
        refetchCalendarConnection();
        const connectedProvider = provider ?? "google_calendar";
        showToast({
          id: `calendar-connected:${connectedProvider}`,
          title: WORKSPACE_HOME_MESSAGES.calendarConnectedTitle,
          message: WORKSPACE_HOME_MESSAGES.calendarConnectedMessage(getCalendarProviderLabel(connectedProvider)),
          tone: "success",
        });
      } else if (data.type === "readymeet.calendar.error") {
        onConnectingCalendarProviderChange(null);
        showToast({
          id: `calendar-error:${data.provider ?? "calendar"}`,
          title: WORKSPACE_HOME_MESSAGES.calendarConnectionFailedTitle,
          message: WORKSPACE_HOME_MESSAGES.calendarConnectionFailedMessage,
          tone: "warning",
        });
      }
    }

    window.addEventListener("message", handleCalendarMessage);

    return () => {
      window.removeEventListener("message", handleCalendarMessage);
    };
  }, [
    connectedCalendarProviders,
    onCalendarProviderPickerOpenChange,
    onConnectingCalendarProviderChange,
    refetchCalendarConnection,
    sessionUserId,
    showToast,
  ]);
}

function useWorkspacePastMeetingDeleteShortcut(input: {
  view: "past" | "upcoming";
  isMobile: boolean;
  isMobileDetailOpen: boolean;
  pastMeetingRemoveTarget: Meeting | null;
  selectedPastMeetingForDisplay: Meeting | null | undefined;
  onRequestPastMeetingRemoval: (meeting: Meeting) => void;
}) {
  const {
    view,
    isMobile,
    isMobileDetailOpen,
    pastMeetingRemoveTarget,
    selectedPastMeetingForDisplay,
    onRequestPastMeetingRemoval,
  } = input;

  useEffect(() => {
    if (view !== "past" || (isMobile && !isMobileDetailOpen)) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldOpenPastMeetingRemoveShortcut({
          event,
          context: {
            view,
            hasSelectedMeeting: Boolean(selectedPastMeetingForDisplay),
            hasActiveOverlay: Boolean(pastMeetingRemoveTarget) || hasWorkspaceRemovalBlockingOverlay(),
          },
        })
      ) {
        return;
      }

      if (!selectedPastMeetingForDisplay) {
        return;
      }

      event.preventDefault();
      onRequestPastMeetingRemoval(selectedPastMeetingForDisplay);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    isMobile,
    isMobileDetailOpen,
    onRequestPastMeetingRemoval,
    pastMeetingRemoveTarget,
    selectedPastMeetingForDisplay,
    view,
  ]);
}

function useWorkspaceUpcomingCalendarDeleteShortcut(input: {
  view: "past" | "upcoming";
  isMobile: boolean;
  isMobileDetailOpen: boolean;
  calendarEventDeleteTarget: NormalizedCalendarEvent | null;
  selectedCalendarEvent: NormalizedCalendarEvent | null;
  onRequestCalendarEventDeletion: (event: NormalizedCalendarEvent) => void;
}) {
  const {
    view,
    isMobile,
    isMobileDetailOpen,
    calendarEventDeleteTarget,
    selectedCalendarEvent,
    onRequestCalendarEventDeletion,
  } = input;

  useEffect(() => {
    if (view !== "upcoming" || (isMobile && !isMobileDetailOpen)) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldOpenPastMeetingRemoveShortcut({
          event,
          context: {
            view,
            hasSelectedCalendarEvent: Boolean(selectedCalendarEvent),
            hasActiveOverlay: Boolean(calendarEventDeleteTarget) || hasWorkspaceRemovalBlockingOverlay(),
          },
        })
      ) {
        return;
      }

      if (!selectedCalendarEvent) {
        return;
      }

      event.preventDefault();
      onRequestCalendarEventDeletion(selectedCalendarEvent);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    calendarEventDeleteTarget,
    isMobile,
    isMobileDetailOpen,
    onRequestCalendarEventDeletion,
    selectedCalendarEvent,
    view,
  ]);
}

function useSyncWorkspaceMeetingsOnScopeChange(input: {
  sessionUserId: string | undefined;
  sessionWorkspaceId: string | undefined;
  workspaceScope: { userId: string | null; workspaceId: string | null };
  previousWorkspaceScopeRef: { current: { userId: string | null; workspaceId: string | null } };
  onWorkspaceScopeMeetingsReset: () => void;
  setMeetingsScope: (scope: { userId: string | null; workspaceId: string | null }) => void;
  setMeetings: (meetings: Meeting[]) => void;
}) {
  const {
    sessionUserId,
    sessionWorkspaceId,
    workspaceScope,
    previousWorkspaceScopeRef,
    onWorkspaceScopeMeetingsReset,
    setMeetingsScope,
    setMeetings,
  } = input;

  useEffect(() => {
    const cached = getCachedWorkspaceMeetings(sessionUserId, sessionWorkspaceId);
    setMeetingsScope(workspaceScope);
    setMeetings(cached ?? []);

    const previousScope = previousWorkspaceScopeRef.current;
    const hasWorkspaceScopeChanged =
      previousScope.userId !== null &&
      previousScope.workspaceId !== null &&
      (previousScope.userId !== workspaceScope.userId || previousScope.workspaceId !== workspaceScope.workspaceId);
    previousWorkspaceScopeRef.current = workspaceScope;

    if (hasWorkspaceScopeChanged) {
      onWorkspaceScopeMeetingsReset();
    }
  }, [
    onWorkspaceScopeMeetingsReset,
    previousWorkspaceScopeRef,
    sessionUserId,
    sessionWorkspaceId,
    setMeetings,
    setMeetingsScope,
    workspaceScope,
  ]);
}

function useWorkspaceCachedCalendarProviders(sessionUserId: string | undefined) {
  const [cachedCalendarProviders, setCachedCalendarProviders] = useState<CalendarProvider[] | null>(() =>
    getCachedCalendarConnectionProviders(sessionUserId),
  );

  useEffect(() => {
    setCachedCalendarProviders(getCachedCalendarConnectionProviders(sessionUserId));

    return subscribeToCalendarConnectionProviders(sessionUserId, setCachedCalendarProviders);
  }, [sessionUserId]);

  return cachedCalendarProviders;
}

function useWorkspaceConnectionProviderCachePersistence(input: {
  isUpcomingView: boolean;
  sessionUserId: string | undefined;
  calendarEventsData: CalendarEventsResponse | undefined;
  isCalendarEventsSuccess: boolean;
  agentSettingsData: Awaited<ReturnType<typeof getMyAgentSettings>> | undefined;
  isAgentSettingsSuccess: boolean;
}) {
  const {
    isUpcomingView,
    sessionUserId,
    calendarEventsData,
    isCalendarEventsSuccess,
    agentSettingsData,
    isAgentSettingsSuccess,
  } = input;

  useEffect(() => {
    if (!isUpcomingView || !hasNonEmptyText(sessionUserId)) {
      return;
    }

    const providers = new Set<CalendarProvider>(calendarEventsData?.connectedProviders ?? []);
    if (isCalendarEventsSuccess) {
      setCachedCalendarConnectionProviders(sessionUserId, Array.from(providers));

      return;
    }

    if (isAgentSettingsSuccess && agentSettingsData !== undefined) {
      const connectedProviders = new Set<CalendarProvider>([
        ...providers,
        ...agentSettingsData.connectors.flatMap((connector) =>
          isCalendarProviderValue(connector.provider) && connector.status === "connected" ? [connector.provider] : [],
        ),
      ]);
      setCachedCalendarConnectionProviders(sessionUserId, Array.from(connectedProviders));
    }
  }, [
    agentSettingsData,
    calendarEventsData,
    isAgentSettingsSuccess,
    isCalendarEventsSuccess,
    isUpcomingView,
    sessionUserId,
  ]);
}

function useWorkspaceMeetingsRefresh(input: {
  session: { token: string; user: { id: string; workspaceId: string } } | null | undefined;
  meetingsQueryKey: readonly unknown[];
  queryClient: QueryClient;
  workspaceScope: { userId: string | null; workspaceId: string | null };
  workspaceScopeRef: { current: { userId: string | null; workspaceId: string | null } };
  meetingsQueryData: Meeting[] | undefined;
  sessionUserId: string | undefined;
  sessionWorkspaceId: string | undefined;
  setMeetingsScope: (scope: { userId: string | null; workspaceId: string | null }) => void;
  setMeetings: (meetings: Meeting[]) => void;
  setError: (message: string | null) => void;
}) {
  const {
    session,
    meetingsQueryKey,
    queryClient,
    workspaceScope,
    workspaceScopeRef,
    meetingsQueryData,
    sessionUserId,
    sessionWorkspaceId,
    setMeetingsScope,
    setMeetings,
    setError,
  } = input;

  const refreshMeetings = useCallback(async () => {
    if (!session) {
      return;
    }

    const requestScope = {
      userId: session.user.id,
      workspaceId: session.user.workspaceId,
    };
    const meetingList = await listMeetings(session.token);
    if (
      workspaceScopeRef.current.userId !== requestScope.userId ||
      workspaceScopeRef.current.workspaceId !== requestScope.workspaceId
    ) {
      return;
    }
    setMeetingsScope(requestScope);
    setMeetings(meetingList);
    setCachedWorkspaceMeetings(session.user.id, session.user.workspaceId, meetingList);
    queryClient.setQueryData(meetingsQueryKey, meetingList);
  }, [meetingsQueryKey, queryClient, session, setMeetings, setMeetingsScope, workspaceScopeRef]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshMeetings();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : WORKSPACE_HOME_MESSAGES.failedToLoadWorkspace);
      }
    })();
  }, [refreshMeetings, setError]);

  useEffect(() => {
    if (meetingsQueryData) {
      setMeetingsScope(workspaceScope);
      setMeetings(meetingsQueryData);
      setCachedWorkspaceMeetings(sessionUserId, sessionWorkspaceId, meetingsQueryData);
    }
  }, [meetingsQueryData, sessionUserId, sessionWorkspaceId, setMeetings, setMeetingsScope, workspaceScope]);
}

function useWorkspaceCalendarNow(input: { isUpcomingView: boolean; hasConnectedCalendar: boolean }) {
  const [calendarNow, setCalendarNow] = useState(() => new Date());

  useEffect(() => {
    if (!input.isUpcomingView || !input.hasConnectedCalendar) {
      return;
    }

    setCalendarNow(new Date());
    const timerId = window.setInterval(() => setCalendarNow(new Date()), CALENDAR_NOW_TICK_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [input.hasConnectedCalendar, input.isUpcomingView]);

  return calendarNow;
}

function getWorkspaceSelectedCalendarEventForDisplay(input: {
  isMobile: boolean;
  mobileDetailId: string | null;
  calendarEvents: NormalizedCalendarEvent[];
  selectedEventFromGroup: NormalizedCalendarEvent | null;
}) {
  if (input.isMobile) {
    return input.calendarEvents.find((event) => event.id === input.mobileDetailId) ?? null;
  }

  return input.selectedEventFromGroup;
}

function getWorkspaceMeetingsListState(input: {
  meetingsScope: { userId: string | null; workspaceId: string | null };
  workspaceScope: { userId: string | null; workspaceId: string | null };
  meetingsQueryData: Meeting[] | undefined;
  meetings: Meeting[];
  isRestoringQueryCache: boolean;
  isMeetingsQueryFetching: boolean;
}) {
  const canUseMeetingsState =
    input.meetingsScope.userId === input.workspaceScope.userId &&
    input.meetingsScope.workspaceId === input.workspaceScope.workspaceId;
  const meetingsForDisplay = input.meetingsQueryData ?? (canUseMeetingsState ? input.meetings : []);
  const isMeetingListResolving =
    input.isRestoringQueryCache || (input.isMeetingsQueryFetching && meetingsForDisplay.length === 0);

  return { canUseMeetingsState, meetingsForDisplay, isMeetingListResolving };
}

function getWorkspaceShouldShowNoUpcomingMeetings(input: {
  hasConnectedCalendar: boolean;
  hasCalendarEventsResult: boolean;
  calendarEventGroupsLength: number;
}) {
  return input.hasConnectedCalendar && input.hasCalendarEventsResult && input.calendarEventGroupsLength === 0;
}

function getWorkspaceShouldShowPastRecentButton(input: {
  pastMeetingGroupsLength: number;
  pastMeetingSelectionGroupIndex: number;
}) {
  return input.pastMeetingGroupsLength !== 0 && input.pastMeetingSelectionGroupIndex > 0;
}

// Temporarily hide Upcoming meeting prep while keeping its backend and saved results.
const upcomingMeetingPrep = { isVisible: false };

function getWorkspaceCanShowPrepPromptSurface(input: {
  selectedCalendarEvent: NormalizedCalendarEvent | null;
  shouldShowPrepLoader: boolean;
  calendarEventPrep: CalendarEventPrepResponse | null;
  selectedCalendarPrepSummary: CalendarEventsResponse["prepSummaries"][number] | null;
  hasStartedSelectedCalendarPrep: boolean;
}) {
  return (
    upcomingMeetingPrep.isVisible &&
    input.selectedCalendarEvent !== null &&
    !input.shouldShowPrepLoader &&
    input.calendarEventPrep === null &&
    input.selectedCalendarPrepSummary === null &&
    !input.hasStartedSelectedCalendarPrep
  );
}

function getWorkspaceSelectedCalendarReadyMeetingState(input: {
  selectedCalendarEvent: NormalizedCalendarEvent | null;
  recentlyAddedReadyMeetingEventKey: string | null;
  copiedReadyMeetingEventKey: string | null;
}) {
  const selectedCalendarReadyMeeting = input.selectedCalendarEvent?.readyMeeting ?? null;
  const selectedCalendarEventKey = input.selectedCalendarEvent
    ? (input.selectedCalendarEvent.providerEventKey ?? input.selectedCalendarEvent.providerEventId)
    : null;
  const selectedReadyMeetingCode = selectedCalendarReadyMeeting
    ? (selectedCalendarReadyMeeting.code ?? getReadyMeetingCodeFromJoinUrl(selectedCalendarReadyMeeting.joinUrl))
    : null;
  const isSelectedReadyMeetingRecentlyAdded =
    selectedCalendarEventKey !== null && selectedCalendarEventKey === input.recentlyAddedReadyMeetingEventKey;
  const isSelectedReadyMeetingUrlCopied =
    selectedCalendarEventKey !== null && selectedCalendarEventKey === input.copiedReadyMeetingEventKey;
  const shouldShowReadyMeetingConnect =
    input.selectedCalendarEvent !== null &&
    input.selectedCalendarEvent.provider === "google_calendar" &&
    input.selectedCalendarEvent.canAddReadyMeeting === true &&
    selectedCalendarReadyMeeting === null;
  const shouldShowReadyMeetingCard = selectedCalendarReadyMeeting !== null;

  return {
    selectedCalendarReadyMeeting,
    selectedCalendarEventKey,
    selectedReadyMeetingCode,
    isSelectedReadyMeetingRecentlyAdded,
    isSelectedReadyMeetingUrlCopied,
    shouldShowReadyMeetingConnect,
    shouldShowReadyMeetingCard,
  };
}

function getWorkspaceMeetingBriefPrepSectionVisibility(input: {
  peoplePrepBullets: string[];
  briefPrepBullets: string[];
  calendarEventPrep: CalendarEventPrepResponse | null;
}) {
  return {
    shouldShowPeoplePrep: input.peoplePrepBullets.length !== 0,
    shouldShowBriefPrep: input.briefPrepBullets.length !== 0,
    shouldShowCompanyPrep: Boolean(input.calendarEventPrep?.company),
  };
}

function getWorkspaceShellEndMeetingState(input: {
  view: "past" | "upcoming";
  pastDetailMeetingId: string | null;
  readyPastMeetingId: string | null;
  pastMeetingLoadFailure: MeetingLoadFailure | null;
}) {
  const isEndMeetingContentReady =
    input.view !== "past" ||
    input.pastDetailMeetingId === null ||
    input.readyPastMeetingId === input.pastDetailMeetingId;
  const endMeetingLoadFailure =
    input.view === "past" && input.pastMeetingLoadFailure?.meetingId === input.pastDetailMeetingId
      ? input.pastMeetingLoadFailure
      : null;

  return { isEndMeetingContentReady, endMeetingLoadFailure };
}

function getWorkspaceShouldShowEmptyMeetingBriefPrep(input: {
  shouldShowPrepLoader: boolean;
  shouldShowReadyMeetingConnect: boolean;
  shouldShowReadyMeetingCard: boolean;
  shouldShowPrepPrompt: boolean;
  shouldShowBriefPrep: boolean;
  shouldShowPeoplePrep: boolean;
  shouldShowCompanyPrep: boolean;
}) {
  return (
    !input.shouldShowPrepLoader &&
    !input.shouldShowReadyMeetingConnect &&
    !input.shouldShowReadyMeetingCard &&
    !input.shouldShowPrepPrompt &&
    !input.shouldShowBriefPrep &&
    !input.shouldShowPeoplePrep &&
    !input.shouldShowCompanyPrep
  );
}

function getWorkspaceSelectedCalendarPrepPlanRequired(input: {
  selectedCalendarEventId: string | null;
  calendarPrepAccess: NonNullable<CalendarEventsResponse["prepAccess"]> | null;
  calendarPrepPlanRequiredEventIds: Set<string>;
}) {
  if (input.selectedCalendarEventId === null) {
    return false;
  }

  return (
    (input.calendarPrepAccess !== null &&
      !input.calendarPrepAccess.hasPrepPlan &&
      !input.calendarPrepAccess.canStartCalendarPrep) ||
    (input.calendarPrepAccess?.hasPrepPlan !== true &&
      input.calendarPrepPlanRequiredEventIds.has(input.selectedCalendarEventId))
  );
}

function getWorkspacePastDetailMeetingId(input: {
  isMobile: boolean;
  mobileDetailId: string | null;
  selectedPastMeetingIdForDisplay: string | null;
  selectedPastMeetingId: string | null;
}) {
  return input.isMobile ? input.mobileDetailId : (input.selectedPastMeetingIdForDisplay ?? input.selectedPastMeetingId);
}

function getWorkspaceMeetingBriefPrepBulletLists(input: {
  shouldShowPrepLoader: boolean;
  calendarEventPrep: CalendarEventPrepResponse | null;
}) {
  if (input.shouldShowPrepLoader) {
    const emptyBullets: string[] = [];

    return { peoplePrepBullets: emptyBullets, briefPrepBullets: emptyBullets };
  }

  const peoplePrepBullets =
    input.calendarEventPrep !== null && input.calendarEventPrep.people.bullets.length !== 0
      ? input.calendarEventPrep.people.bullets
      : [];
  const briefPrepBullets =
    input.calendarEventPrep !== null && input.calendarEventPrep.brief.bullets.length !== 0
      ? input.calendarEventPrep.brief.bullets
      : [];

  return { peoplePrepBullets, briefPrepBullets };
}

function getWorkspaceMeetingBriefCompanyPrepBullets(input: {
  shouldShowPrepLoader: boolean;
  calendarEventPrep: CalendarEventPrepResponse | null;
}) {
  if (input.shouldShowPrepLoader) {
    return [];
  }

  const companyBullets = input.calendarEventPrep?.company?.bullets ?? [];

  return companyBullets.length !== 0 ? companyBullets : [WORKSPACE_HOME_MESSAGES.companyContextFallback];
}

function getWorkspacePastMeetingsPlaceholderState(input: {
  isMeetingListResolving: boolean;
  pastMeetingsLength: number;
  selectedPastMeetingId: string | null;
  isMeetingsQuerySuccess: boolean;
}) {
  const shouldShowPastMeetingsLoading =
    input.isMeetingListResolving && input.pastMeetingsLength === 0 && input.selectedPastMeetingId === null;
  const shouldShowNoPastMeetings =
    !input.isMeetingListResolving &&
    input.isMeetingsQuerySuccess &&
    input.pastMeetingsLength === 0 &&
    input.selectedPastMeetingId === null;

  return {
    shouldShowPastMeetingsLoading,
    shouldShowNoPastMeetings,
    shouldShowPastMeetingsPlaceholder: shouldShowPastMeetingsLoading || shouldShowNoPastMeetings,
  };
}

function getWorkspaceUpcomingSetupProgress(input: {
  session: {
    user: { hasCompletedFirstMeeting?: boolean; hasCompletedAgentIntro?: boolean; id: string };
  } | null;
  meetingsForDisplay: Meeting[];
  hasConnectedCalendar: boolean;
}) {
  const hasCompletedFirstMeeting =
    input.session?.user.hasCompletedFirstMeeting === true ||
    input.meetingsForDisplay.some((meeting) => meeting.status === "ended");
  const sessionUserId = input.session?.user.id;
  const hasCreatedOwnStandardMeeting =
    hasNonEmptyText(sessionUserId) &&
    input.meetingsForDisplay.some(
      (meeting) => meeting.createdByUserId === sessionUserId && meeting.kind === "standard",
    );
  const hasCompletedAgentIntro = input.session?.user.hasCompletedAgentIntro === true;
  const hasCompletedAgentIntroSetup =
    hasCompletedAgentIntro || hasCreatedOwnStandardMeeting || hasCompletedFirstMeeting;
  const shouldShowAgentIntroCta =
    input.session !== null && !hasCompletedAgentIntro && !hasCreatedOwnStandardMeeting && !hasCompletedFirstMeeting;
  const setupDoneCount = (hasCompletedAgentIntroSetup ? 1 : 0) + (input.hasConnectedCalendar ? 1 : 0);

  return { hasCompletedAgentIntroSetup, shouldShowAgentIntroCta, setupDoneCount };
}

async function fetchWorkspaceCalendarEventPrep(input: {
  session: ReturnType<typeof useAuth>["session"];
  queryClient: QueryClient;
  selectedCalendarPrepQueryKey: ReturnType<typeof calendarEventPrepQueryKey>;
  selectedCalendarPrepSummary: CalendarEventsResponse["prepSummaries"][number] | null;
  hasStartedSelectedCalendarPrep: boolean;
}) {
  const {
    session,
    queryClient,
    selectedCalendarPrepQueryKey,
    selectedCalendarPrepSummary,
    hasStartedSelectedCalendarPrep,
  } = input;
  const existing = queryClient.getQueryData<CalendarEventPrepResponse>(selectedCalendarPrepQueryKey);
  const existingPrepId = existing?.prepId;
  if (
    existing !== undefined &&
    hasNonEmptyText(existingPrepId) &&
    (existing.status === "pending" ||
      existing.status === "running" ||
      existingPrepId === selectedCalendarPrepSummary?.prepId ||
      hasStartedSelectedCalendarPrep)
  ) {
    if (!session) {
      throw new Error(WORKSPACE_HOME_MESSAGES.sessionUnavailable);
    }

    return getCalendarEventPrep({ token: session.token, prepId: existingPrepId });
  }
  const summaryPrepId = selectedCalendarPrepSummary?.prepId;
  if (hasNonEmptyText(summaryPrepId)) {
    if (!session) {
      throw new Error(WORKSPACE_HOME_MESSAGES.sessionUnavailable);
    }

    return getCalendarEventPrep({ token: session.token, prepId: summaryPrepId });
  }
  throw new Error(WORKSPACE_HOME_MESSAGES.meetingPrepNotStarted);
}

function getWorkspaceCalendarPrepLoadingState(input: {
  calendarEventPrep: CalendarEventPrepResponse | null;
  selectedCalendarPrepSummary: CalendarEventsResponse["prepSummaries"][number] | null;
  isCalendarEventPrepQueryLoading: boolean;
  selectedCalendarEventId: string | null;
  calendarPrepStartingEventId: string | null;
}) {
  const isSelectedSummaryLoading =
    input.calendarEventPrep === null &&
    (input.selectedCalendarPrepSummary?.status === "pending" ||
      input.selectedCalendarPrepSummary?.status === "running");
  const isStartingSelectedCalendarPrep =
    input.selectedCalendarEventId !== null && input.calendarPrepStartingEventId === input.selectedCalendarEventId;

  return (
    isStartingSelectedCalendarPrep ||
    input.isCalendarEventPrepQueryLoading ||
    isSelectedSummaryLoading ||
    input.calendarEventPrep?.status === "pending" ||
    input.calendarEventPrep?.status === "running"
  );
}

function useWorkspaceCalendarEventPrep(input: {
  session: ReturnType<typeof useAuth>["session"];
  sessionUserId: string | undefined;
  isUpcomingView: boolean;
  hasConnectedCalendar: boolean;
  selectedCalendarEvent: NormalizedCalendarEvent | null;
  selectedCalendarPrepSummary: CalendarEventsResponse["prepSummaries"][number] | null;
  hasStartedSelectedCalendarPrep: boolean;
  calendarPrepStartingEventId: string | null;
  queryClient: QueryClient;
}) {
  const {
    session,
    sessionUserId,
    isUpcomingView,
    hasConnectedCalendar,
    selectedCalendarEvent,
    selectedCalendarPrepSummary,
    hasStartedSelectedCalendarPrep,
    calendarPrepStartingEventId,
    queryClient,
  } = input;
  const selectedCalendarEventId = selectedCalendarEvent?.id ?? null;
  const selectedCalendarPrepQueryKey = calendarEventPrepQueryKey(sessionUserId, selectedCalendarEvent);
  const calendarEventPrepQuery = useQuery({
    queryKey: selectedCalendarPrepQueryKey,
    queryFn: () =>
      fetchWorkspaceCalendarEventPrep({
        session,
        queryClient,
        selectedCalendarPrepQueryKey,
        selectedCalendarPrepSummary,
        hasStartedSelectedCalendarPrep,
      }),
    enabled:
      hasNonEmptyText(session?.token) &&
      isUpcomingView &&
      hasConnectedCalendar &&
      selectedCalendarEvent !== null &&
      (hasNonEmptyText(selectedCalendarPrepSummary?.prepId) || hasStartedSelectedCalendarPrep),
    refetchInterval: (query) => {
      const data = query.state.data;

      return data?.status === "pending" || data?.status === "running" ? CALENDAR_PREP_POLL_INTERVAL_MS : false;
    },
    retry: false,
    staleTime: 0,
  });
  const calendarEventPrep = calendarEventPrepQuery.data ?? null;

  return {
    calendarEventPrep,
    isCalendarPrepLoading: getWorkspaceCalendarPrepLoadingState({
      calendarEventPrep,
      selectedCalendarPrepSummary,
      isCalendarEventPrepQueryLoading: calendarEventPrepQuery.isLoading,
      selectedCalendarEventId,
      calendarPrepStartingEventId,
    }),
  };
}

function useWorkspaceCalendarPrepEstimate(input: {
  session: ReturnType<typeof useAuth>["session"];
  sessionUserId: string | undefined;
  selectedCalendarEvent: NormalizedCalendarEvent | null;
  selectedCalendarEventId: string | null;
  shouldShowPrepPrompt: boolean;
  isSelectedCalendarPrepPlanRequired: boolean;
}) {
  const {
    session,
    sessionUserId,
    selectedCalendarEvent,
    selectedCalendarEventId,
    shouldShowPrepPrompt,
    isSelectedCalendarPrepPlanRequired,
  } = input;
  const calendarPrepEstimateQuery = useQuery({
    queryKey: ["calendar-event-prep-estimate", sessionUserId, selectedCalendarEventId],
    queryFn: () => {
      if (!session || selectedCalendarEvent === null) {
        throw new Error(WORKSPACE_HOME_MESSAGES.calendarPrepEstimateUnavailable);
      }

      return getCalendarEventPrepEstimate({ token: session.token, event: selectedCalendarEvent });
    },
    enabled: hasNonEmptyText(session?.token) && shouldShowPrepPrompt && !isSelectedCalendarPrepPlanRequired,
    staleTime: WORKSPACE_QUERY_STALE_TIME_MS,
  });
  const calendarPrepEstimate = calendarPrepEstimateQuery.data ?? null;
  const calendarPrepEstimateErrorMessage = calendarPrepEstimateQuery.isError
    ? getApiErrorMessage({
        error: calendarPrepEstimateQuery.error,
        fallback: WORKSPACE_HOME_MESSAGES.prepProcessorPricingFallback,
      })
    : null;

  return { calendarPrepEstimate, calendarPrepEstimateErrorMessage, calendarPrepEstimateQuery };
}

function useWorkspaceSelectedReadyMeetingCallIn(input: {
  session: ReturnType<typeof useAuth>["session"];
  selectedCalendarReadyMeeting: NonNullable<NormalizedCalendarEvent["readyMeeting"]> | null;
  selectedReadyMeetingCode: string | null;
}) {
  const { session, selectedCalendarReadyMeeting, selectedReadyMeetingCode } = input;
  const selectedReadyMeetingResolveQuery = useQuery({
    ...calendarReadyMeetingOptions({ session, code: selectedReadyMeetingCode }),
    enabled:
      hasNonEmptyText(session?.token) &&
      selectedCalendarReadyMeeting !== null &&
      (selectedCalendarReadyMeeting.callIn === null || selectedCalendarReadyMeeting.callIn === undefined) &&
      hasNonEmptyText(selectedReadyMeetingCode),
  });

  return selectedCalendarReadyMeeting?.callIn ?? selectedReadyMeetingResolveQuery.data?.meetingLink.callIn ?? null;
}

function useWorkspaceRecentlyAddedReadyMeetingAutoClear(input: {
  recentlyAddedReadyMeetingEventKey: string | null;
  setRecentlyAddedReadyMeetingEventKey: (eventKey: string | null) => void;
}) {
  const { recentlyAddedReadyMeetingEventKey, setRecentlyAddedReadyMeetingEventKey } = input;

  useEffect(() => {
    if (!hasNonEmptyText(recentlyAddedReadyMeetingEventKey)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRecentlyAddedReadyMeetingEventKey(null);
    }, RECENTLY_ADDED_READY_MEETING_CLEAR_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [recentlyAddedReadyMeetingEventKey, setRecentlyAddedReadyMeetingEventKey]);
}

function useWorkspaceReadyMeetingCopyTimerCleanup(readyMeetingCopyTimerRef: RefObject<number | null>) {
  useEffect(() => {
    return () => {
      if (readyMeetingCopyTimerRef.current !== null) {
        window.clearTimeout(readyMeetingCopyTimerRef.current);
      }
    };
  }, [readyMeetingCopyTimerRef]);
}

function useWorkspacePastViewInitialMeetingId(input: {
  view: "past" | "upcoming";
  initialMeetingId: string | null;
  setSelectedPastMeetingId: (meetingId: string | null) => void;
}) {
  const { view, initialMeetingId, setSelectedPastMeetingId } = input;

  useEffect(() => {
    if (view !== "past") {
      return;
    }

    setSelectedPastMeetingId(initialMeetingId);
  }, [initialMeetingId, setSelectedPastMeetingId, view]);
}

function useWorkspaceCalendarPrepElapsedSeconds(input: {
  selectedCalendarEventId: string | null;
  isCalendarPrepLoading: boolean;
  prepProgressStartedAt: string | null | undefined;
  summaryProgressStartedAt: string | null | undefined;
}) {
  const { selectedCalendarEventId, isCalendarPrepLoading, prepProgressStartedAt, summaryProgressStartedAt } = input;
  const [calendarPrepLoadingStartedAt, setCalendarPrepLoadingStartedAt] = useState(() => Date.now());
  const [calendarPrepLoadingNow, setCalendarPrepLoadingNow] = useState(() => Date.now());

  useEffect(() => {
    const now = Date.now();
    setCalendarPrepLoadingStartedAt(now);
    setCalendarPrepLoadingNow(now);
  }, [selectedCalendarEventId]);

  useEffect(() => {
    if (!isCalendarPrepLoading) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setCalendarPrepLoadingNow(Date.now());
    }, CALENDAR_PREP_LOADING_TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isCalendarPrepLoading]);

  const calendarPrepStartedAtMs =
    timestampFromIso(prepProgressStartedAt) ??
    timestampFromIso(summaryProgressStartedAt) ??
    calendarPrepLoadingStartedAt;

  return Math.max(0, Math.floor((calendarPrepLoadingNow - calendarPrepStartedAtMs) / MILLISECONDS_PER_SECOND));
}

function WorkspaceUpcomingCalendarEventButton({
  event,
  selectedCalendarEventGroupKind,
  selectedCalendarEventId,
  isMobile,
  isMobileDetailOpen,
  onSelectEvent,
}: {
  event: NormalizedCalendarEvent;
  selectedCalendarEventGroupKind: string | undefined;
  selectedCalendarEventId: string | null;
  isMobile: boolean;
  isMobileDetailOpen: boolean;
  onSelectEvent: (eventId: string) => void;
}) {
  const subtitle =
    selectedCalendarEventGroupKind === "day"
      ? getCalendarEventSubtitleParts(event)
      : getCalendarEventDatedSubtitleParts(event);

  return (
    <button
      type="button"
      className={`workspace-upcoming-event-block is-text-only${
        selectedCalendarEventId === event.id && (!isMobile || isMobileDetailOpen) ? " is-selected" : ""
      }`}
      aria-pressed={selectedCalendarEventId === event.id ? !isMobile || isMobileDetailOpen : false}
      onClick={() => onSelectEvent(event.id)}
    >
      <span className="workspace-upcoming-event-copy">
        <strong>{getCalendarEventTitle(event)}</strong>
        <span className="workspace-upcoming-event-subtitle">
          <span className="workspace-upcoming-event-time">{subtitle.primary}</span>
          {hasNonEmptyText(subtitle.secondary) ? (
            <span className="workspace-upcoming-event-location">{subtitle.secondary}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

async function confirmWorkspacePastMeetingRemoval(input: {
  session: { token: string; user: { id: string; workspaceId: string } };
  meetingToRemove: Meeting;
  previousMeetings: Meeting[];
  onPastMeetingDeleted: (payload: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  showToast: (toast: ToastInput) => void;
  setError: (message: string | null) => void;
  setMeetingsScope: (scope: { userId: string; workspaceId: string }) => void;
  setMeetings: (meetings: Meeting[]) => void;
  queryClient: QueryClient;
  meetingsQueryKey: readonly unknown[];
  setSelectedPastMeetingId: (meetingId: string | null) => void;
  router: { replace: (href: string) => void };
}) {
  const {
    session,
    meetingToRemove,
    previousMeetings,
    onPastMeetingDeleted,
    showToast,
    setError,
    setMeetingsScope,
    setMeetings,
    queryClient,
    meetingsQueryKey,
    setSelectedPastMeetingId,
    router,
  } = input;

  const remainingMeetings = previousMeetings.filter((meeting) => meeting.id !== meetingToRemove.id);

  setError(null);
  onPastMeetingDeleted({
    deletedMeetingId: meetingToRemove.id,
    remainingMeetings,
  });
  showToast({
    id: `past-meeting-remove:${meetingToRemove.id}`,
    title: WORKSPACE_HOME_MESSAGES.meetingRemovedTitle,
    message: WORKSPACE_HOME_MESSAGES.meetingRemovedDetail(meetingToRemove.title),
    tone: "success",
  });

  try {
    await deleteMeeting({ token: session.token, meetingId: meetingToRemove.id });
  } catch (nextError) {
    const message = nextError instanceof Error ? nextError.message : WORKSPACE_HOME_MESSAGES.failedToDeleteMeeting;
    setMeetingsScope({ userId: session.user.id, workspaceId: session.user.workspaceId });
    setMeetings(previousMeetings);
    setCachedWorkspaceMeetings(session.user.id, session.user.workspaceId, previousMeetings);
    queryClient.setQueryData(meetingsQueryKey, previousMeetings);
    setSelectedPastMeetingId(meetingToRemove.id);
    router.replace(`/workspace/${meetingToRemove.id}`);
    setError(message);
    showToast({
      id: `past-meeting-remove-error:${meetingToRemove.id}`,
      title: WORKSPACE_HOME_MESSAGES.meetingRestoredTitle,
      message,
      tone: "warning",
    });
  }
}

async function startWorkspaceCalendarConnect(input: {
  session: { token: string };
  provider: CalendarProvider;
  setConnectingCalendarProvider: (provider: CalendarProvider | null) => void;
  showToast: (toast: ToastInput) => void;
}) {
  const { session, provider, setConnectingCalendarProvider, showToast } = input;

  setConnectingCalendarProvider(provider);
  const popup = window.open(
    "about:blank",
    `readymeet-calendar-oauth-${provider}`,
    `popup=yes,width=${CALENDAR_OAUTH_POPUP_WIDTH},height=${CALENDAR_OAUTH_POPUP_HEIGHT},menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes`,
  );
  try {
    const authorizationUrl = await connectCalendar({
      token: session.token,
      input: {
        provider,
        returnTo: window.location.href,
      },
    });
    if (!popup) {
      window.location.assign(authorizationUrl);

      return;
    }
    popup.location.href = authorizationUrl;
    popup.focus();
  } catch (nextError) {
    popup?.close();
    setConnectingCalendarProvider(null);
    showToast({
      id: `calendar-connect-error:${provider}`,
      title: WORKSPACE_HOME_MESSAGES.calendarConnectionFailedTitle,
      message: nextError instanceof Error ? nextError.message : WORKSPACE_HOME_MESSAGES.calendarConnectFailedMessage,
      tone: "warning",
    });
  }
}

async function runWorkspaceCalendarEventPrep(input: {
  session: { token: string; user: { id: string } };
  event: NormalizedCalendarEvent;
  processor?: CalendarEventPrepProcessor;
  calendarPrepStartingEventId: string | null;
  calendarEventsKey: readonly unknown[];
  queryClient: QueryClient;
  router: { push: (href: string) => void };
  showToast: (toast: ToastInput) => void;
  setCalendarPrepStartingEventId: (eventId: string | null) => void;
  setStartedCalendarPrepEventIds: (update: (current: Set<string>) => Set<string>) => void;
  setCalendarPrepPlanRequiredEventIds: (update: (current: Set<string>) => Set<string>) => void;
}) {
  const {
    session,
    event,
    processor,
    calendarPrepStartingEventId,
    calendarEventsKey,
    queryClient,
    router,
    showToast,
    setCalendarPrepStartingEventId,
    setStartedCalendarPrepEventIds,
    setCalendarPrepPlanRequiredEventIds,
  } = input;

  if (calendarPrepStartingEventId !== null) {
    return;
  }

  setCalendarPrepStartingEventId(event.id);

  try {
    const prep = await startCalendarEventPrep({ token: session.token, event, processor });
    queryClient.setQueryData(calendarEventPrepQueryKey(session.user.id, event), prep);
    setStartedCalendarPrepEventIds((current) => new Set(current).add(event.id));
    setCalendarPrepPlanRequiredEventIds((current) => {
      if (!current.has(event.id)) {
        return current;
      }
      const next = new Set(current);
      next.delete(event.id);

      return next;
    });
    void queryClient.invalidateQueries({ queryKey: calendarEventsKey });
  } catch (nextError) {
    if (getApiErrorCode(nextError) === "calendar_prep_plan_required") {
      setCalendarPrepPlanRequiredEventIds((current) => new Set(current).add(event.id));
      void queryClient.invalidateQueries({ queryKey: calendarEventsKey });

      return;
    }
    if (getApiErrorCode(nextError) === "calendar_prep_credits_required") {
      showToast({
        id: `calendar-prep-credits:${event.id}`,
        title: WORKSPACE_HOME_MESSAGES.calendarPrepCreditsTitle,
        message: getApiErrorMessage({
          error: nextError,
          fallback: WORKSPACE_HOME_MESSAGES.calendarPrepCreditsFallback,
        }),
        tone: "warning",
      });
      router.push("/workspace/settings?tab=billing");

      return;
    }
    showToast({
      id: `calendar-prep-error:${event.id}`,
      title: WORKSPACE_HOME_MESSAGES.calendarPrepStartFailedTitle,
      message: getApiErrorMessage({
        error: nextError,
        fallback: WORKSPACE_HOME_MESSAGES.calendarPrepStartFailedFallback,
      }),
      tone: "warning",
    });
  } finally {
    setCalendarPrepStartingEventId(null);
  }
}

async function addReadyMeetingToWorkspaceCalendarEvent(input: {
  session: { token: string };
  event: NormalizedCalendarEvent;
  calendarEventsKey: readonly unknown[];
  queryClient: QueryClient;
  showToast: (toast: ToastInput) => void;
  startGoogleCalendarConnect: () => Promise<void>;
  setAddingReadyMeetingEventId: (eventId: string | null) => void;
  setRecentlyAddedReadyMeetingEventKey: (eventKey: string) => void;
}) {
  const {
    session,
    event,
    calendarEventsKey,
    queryClient,
    showToast,
    startGoogleCalendarConnect,
    setAddingReadyMeetingEventId,
    setRecentlyAddedReadyMeetingEventKey,
  } = input;

  if (!hasNonEmptyText(event.calendarAccountId)) {
    return;
  }

  if (event.needsCalendarWriteConsent === true) {
    showToast({
      id: `calendar-write-consent:${event.id}`,
      title: WORKSPACE_HOME_MESSAGES.googleCalendarPermissionTitle,
      message: WORKSPACE_HOME_MESSAGES.googleCalendarPermissionMessage,
      tone: "warning",
    });
    await startGoogleCalendarConnect();

    return;
  }

  setAddingReadyMeetingEventId(event.id);
  try {
    const result = await addReadyMeetingToCalendarEvent({
      token: session.token,
      input: {
        calendarAccountId: event.calendarAccountId,
        providerEventId: event.providerEventId,
        providerRecurringEventId: event.providerRecurringEventId ?? null,
        calendarId: event.calendarId,
      },
    });
    setRecentlyAddedReadyMeetingEventKey(result.providerEventKey);
    queryClient.setQueryData<CalendarEventsResponse | undefined>(calendarEventsKey, (current) =>
      addReadyMeetingToCalendarEventsResponse(current, {
        providerEventKey: result.providerEventKey,
        readyMeeting: result.readyMeeting,
      }),
    );
    await queryClient.invalidateQueries({ queryKey: calendarEventsKey });
    showToast({
      id: `calendar-ready-meeting:${event.id}`,
      title: result.alreadyAdded
        ? WORKSPACE_HOME_MESSAGES.readyMeetingAlreadyAddedTitle
        : WORKSPACE_HOME_MESSAGES.readyMeetingAddedTitle,
      message: result.alreadyAdded
        ? WORKSPACE_HOME_MESSAGES.readyMeetingAlreadyAddedMessage
        : WORKSPACE_HOME_MESSAGES.readyMeetingAddedMessage,
      tone: "success",
    });
  } catch (nextError) {
    if (getApiErrorCode(nextError) === "calendar_write_scope_required") {
      showToast({
        id: `calendar-write-consent-required:${event.id}`,
        title: WORKSPACE_HOME_MESSAGES.googleCalendarPermissionTitle,
        message: WORKSPACE_HOME_MESSAGES.googleCalendarPermissionMessage,
        tone: "warning",
      });
      await startGoogleCalendarConnect();

      return;
    }
    showToast({
      id: `calendar-ready-meeting-error:${event.id}`,
      title: WORKSPACE_HOME_MESSAGES.readyMeetingAddFailedTitle,
      message: getAddReadyMeetingErrorMessage(nextError),
      tone: "warning",
    });
  } finally {
    setAddingReadyMeetingEventId(null);
  }
}

async function copyWorkspaceReadyMeetingUrl(input: {
  event: NormalizedCalendarEvent;
  showToast: (toast: ToastInput) => void;
  readyMeetingCopyTimerRef: { current: number | null };
  setCopiedReadyMeetingEventKey: (eventKey: string | null) => void;
}) {
  const { event, showToast, readyMeetingCopyTimerRef, setCopiedReadyMeetingEventKey } = input;
  const joinUrl = event.readyMeeting?.joinUrl ?? null;
  if (!hasNonEmptyText(joinUrl)) {
    return;
  }

  const eventKey = event.providerEventKey ?? event.providerEventId;
  try {
    if (typeof navigator.clipboard.writeText !== "function") {
      throw new Error(WORKSPACE_HOME_MESSAGES.copyUnavailable);
    }

    await navigator.clipboard.writeText(joinUrl);
    if (readyMeetingCopyTimerRef.current !== null) {
      window.clearTimeout(readyMeetingCopyTimerRef.current);
    }
    setCopiedReadyMeetingEventKey(eventKey);
    readyMeetingCopyTimerRef.current = window.setTimeout(() => {
      setCopiedReadyMeetingEventKey(null);
      readyMeetingCopyTimerRef.current = null;
    }, COPIED_READY_MEETING_RESET_MS);
    showToast({
      id: `calendar-ready-meeting-copy:${event.id}`,
      title: WORKSPACE_HOME_MESSAGES.meetingLinkCopiedTitle,
      message: WORKSPACE_HOME_MESSAGES.meetingLinkCopiedMessage,
      tone: "success",
    });
  } catch (nextError) {
    showToast({
      id: `calendar-ready-meeting-copy-error:${event.id}`,
      title: WORKSPACE_HOME_MESSAGES.meetingLinkCopyFailedTitle,
      message: nextError instanceof Error ? nextError.message : WORKSPACE_HOME_MESSAGES.meetingLinkCopyFailedMessage,
      tone: "warning",
    });
  }
}

async function confirmWorkspaceCalendarEventDeletion(input: {
  session: { token: string };
  eventToDelete: NormalizedCalendarEvent;
  calendarAccountId: string;
  calendarEventsKey: readonly unknown[];
  calendarGroupEvents: NormalizedCalendarEvent[];
  queryClient: QueryClient;
  showToast: (toast: ToastInput) => void;
  setError: (message: string | null) => void;
  setCalendarEventDeleteError: (message: string | null) => void;
  setManuallySelectedCalendarEventId: (eventId: string | null) => void;
}) {
  const {
    session,
    eventToDelete,
    calendarAccountId,
    calendarEventsKey,
    calendarGroupEvents,
    queryClient,
    showToast,
    setError,
    setCalendarEventDeleteError,
    setManuallySelectedCalendarEventId,
  } = input;

  const previousCalendarData = queryClient.getQueryData<CalendarEventsResponse>(calendarEventsKey);
  const deletedEventIndex = calendarGroupEvents.findIndex((event) => event.id === eventToDelete.id);
  const nextSelectedEvent =
    deletedEventIndex >= 0
      ? (calendarGroupEvents[deletedEventIndex + 1] ?? calendarGroupEvents[deletedEventIndex - 1] ?? null)
      : null;

  setError(null);
  setCalendarEventDeleteError(null);
  queryClient.setQueryData<CalendarEventsResponse | undefined>(calendarEventsKey, (current) =>
    removeCalendarEventFromResponse(current, eventToDelete.id),
  );
  setManuallySelectedCalendarEventId(nextSelectedEvent?.id ?? null);
  showToast({
    id: `calendar-event-delete:${eventToDelete.id}`,
    title: WORKSPACE_HOME_MESSAGES.calendarEventDeletedTitle,
    message: WORKSPACE_HOME_MESSAGES.calendarEventDeletedDetail(getCalendarEventTitle(eventToDelete)),
    tone: "success",
  });

  try {
    await deleteCalendarEvent({
      token: session.token,
      input: {
        calendarAccountId,
        providerEventId: eventToDelete.providerEventId,
        calendarId: eventToDelete.calendarId,
      },
    });
    await queryClient.invalidateQueries({ queryKey: calendarEventsKey });
  } catch (nextError) {
    const message = getApiErrorMessage({
      error: nextError,
      fallback: WORKSPACE_HOME_MESSAGES.calendarEventDeleteFallback,
    });
    queryClient.setQueryData(calendarEventsKey, previousCalendarData);
    setManuallySelectedCalendarEventId(eventToDelete.id);
    setError(message);
    showToast({
      id: `calendar-event-delete-error:${eventToDelete.id}`,
      title: WORKSPACE_HOME_MESSAGES.calendarEventRestoredTitle,
      message,
      tone: "warning",
    });
  }
}

function WorkspaceMeetingBriefReadyMeetingConnectCard({
  event,
  addingReadyMeetingEventId,
  connectingCalendarProvider,
  onAddReadyMeeting,
}: {
  event: NormalizedCalendarEvent;
  addingReadyMeetingEventId: string | null;
  connectingCalendarProvider: CalendarProvider | null;
  onAddReadyMeeting: (event: NormalizedCalendarEvent) => void;
}) {
  return (
    <section className="workspace-meeting-brief-card workspace-ready-meeting-card">
      <div className="workspace-meeting-brief-card-inner">
        <div className="workspace-meeting-brief-card-head">
          <ReadyMeetingLogo event={event} />
        </div>
        <div className="workspace-meeting-brief-card-copy">
          <h5>{WORKSPACE_HOME_MESSAGES.readyMeetingTitle}</h5>
          <p>{WORKSPACE_HOME_MESSAGES.readyMeetingConnectDescription}</p>
        </div>
        <button
          type="button"
          className="workspace-ready-meeting-action"
          disabled={addingReadyMeetingEventId !== null || connectingCalendarProvider !== null}
          onClick={() => onAddReadyMeeting(event)}
        >
          {addingReadyMeetingEventId === event.id || connectingCalendarProvider === "google_calendar"
            ? WORKSPACE_HOME_MESSAGES.addingVideoCall
            : WORKSPACE_HOME_MESSAGES.addVideoCall}
        </button>
      </div>
    </section>
  );
}

function WorkspaceMeetingBriefPrepResults({
  shouldShowBriefPrep,
  briefPrepBullets,
  shouldShowPeoplePrep,
  peoplePrepBullets,
  peoplePrepSources,
  shouldShowCompanyPrep,
  companyPrepTitle,
  companyPrepBullets,
  companyPrepSources,
  shouldShowEmptyPrep,
}: {
  shouldShowBriefPrep: boolean;
  briefPrepBullets: string[];
  shouldShowPeoplePrep: boolean;
  peoplePrepBullets: string[];
  peoplePrepSources: CalendarEventPrepSource[];
  shouldShowCompanyPrep: boolean;
  companyPrepTitle: string;
  companyPrepBullets: string[];
  companyPrepSources: CalendarEventPrepSource[];
  shouldShowEmptyPrep: boolean;
}) {
  return (
    <>
      {shouldShowBriefPrep ? (
        <MeetingBriefPlainSection
          title={WORKSPACE_HOME_MESSAGES.briefSectionTitle}
          bullets={briefPrepBullets}
          sources={[]}
        />
      ) : null}

      {shouldShowPeoplePrep ? (
        <MeetingBriefPlainSection
          title={WORKSPACE_HOME_MESSAGES.peopleSectionTitle}
          bullets={peoplePrepBullets}
          sources={peoplePrepSources}
        />
      ) : null}

      {shouldShowCompanyPrep ? (
        <MeetingBriefPlainSection title={companyPrepTitle} bullets={companyPrepBullets} sources={companyPrepSources} />
      ) : null}

      {shouldShowEmptyPrep ? (
        <MeetingBriefPlainSection
          title={WORKSPACE_HOME_MESSAGES.briefSectionTitle}
          bullets={[WORKSPACE_HOME_MESSAGES.emptyBriefBullet]}
          sources={[]}
        />
      ) : null}
    </>
  );
}

function WorkspaceMeetingBriefPrepFlow({
  shouldShowPrepPrompt,
  calendarPrepEstimate,
  calendarPrepEstimateErrorMessage,
  calendarPrepStartingEventId,
  isCalendarPrepEstimateFetching,
  isSelectedCalendarPrepPlanRequired,
  onRetryPrepEstimate,
  onRunCalendarEventPrep,
  onOpenCalendarPrepUpgrade,
  shouldShowPrepLoader,
  calendarPrepElapsedSeconds,
  prepFallbackMessages,
  peoplePrepMessages,
  companyPrepMessages,
  calendarEventPrepStatus,
  shouldShowBriefPrep,
  briefPrepBullets,
  shouldShowPeoplePrep,
  peoplePrepBullets,
  peoplePrepSources,
  shouldShowCompanyPrep,
  companyPrepTitle,
  companyPrepBullets,
  companyPrepSources,
  shouldShowEmptyPrep,
}: {
  shouldShowPrepPrompt: boolean;
  calendarPrepEstimate: CalendarEventPrepEstimateResponse | null;
  calendarPrepEstimateErrorMessage: string | null;
  calendarPrepStartingEventId: string | null;
  isCalendarPrepEstimateFetching: boolean;
  isSelectedCalendarPrepPlanRequired: boolean;
  onRetryPrepEstimate: () => void;
  onRunCalendarEventPrep: (processor: CalendarEventPrepProcessor) => void;
  onOpenCalendarPrepUpgrade: () => void;
  shouldShowPrepLoader: boolean;
  calendarPrepElapsedSeconds: number;
  prepFallbackMessages: readonly (string | null | undefined)[];
  peoplePrepMessages: string[];
  companyPrepMessages: string[];
  calendarEventPrepStatus: CalendarEventPrepResponse["status"] | "loading";
  shouldShowBriefPrep: boolean;
  briefPrepBullets: string[];
  shouldShowPeoplePrep: boolean;
  peoplePrepBullets: string[];
  peoplePrepSources: CalendarEventPrepSource[];
  shouldShowCompanyPrep: boolean;
  companyPrepTitle: string;
  companyPrepBullets: string[];
  companyPrepSources: CalendarEventPrepSource[];
  shouldShowEmptyPrep: boolean;
}) {
  return (
    <>
      {shouldShowPrepPrompt ? (
        <MeetingPrepPromptCard
          estimate={calendarPrepEstimate}
          errorMessage={calendarPrepEstimateErrorMessage}
          isBusy={calendarPrepStartingEventId !== null}
          isLoading={isCalendarPrepEstimateFetching}
          isUpgradeRequired={isSelectedCalendarPrepPlanRequired}
          onRetry={onRetryPrepEstimate}
          onSelect={onRunCalendarEventPrep}
          onUpgrade={onOpenCalendarPrepUpgrade}
        />
      ) : null}

      {shouldShowPrepLoader ? (
        <MeetingBriefResearchProgress
          elapsedSeconds={calendarPrepElapsedSeconds}
          fallbackMessages={prepFallbackMessages}
          peopleMessages={peoplePrepMessages}
          companyMessages={companyPrepMessages}
          prepStatus={calendarEventPrepStatus}
        />
      ) : (
        <WorkspaceMeetingBriefPrepResults
          shouldShowBriefPrep={shouldShowBriefPrep}
          briefPrepBullets={briefPrepBullets}
          shouldShowPeoplePrep={shouldShowPeoplePrep}
          peoplePrepBullets={peoplePrepBullets}
          peoplePrepSources={peoplePrepSources}
          shouldShowCompanyPrep={shouldShowCompanyPrep}
          companyPrepTitle={companyPrepTitle}
          companyPrepBullets={companyPrepBullets}
          companyPrepSources={companyPrepSources}
          shouldShowEmptyPrep={shouldShowEmptyPrep}
        />
      )}
    </>
  );
}

function WorkspaceMeetingBriefReadyMeetingConnectSection({
  shouldShowReadyMeetingConnect,
  event,
  addingReadyMeetingEventId,
  connectingCalendarProvider,
  onAddReadyMeeting,
}: {
  shouldShowReadyMeetingConnect: boolean;
  event: NormalizedCalendarEvent;
  addingReadyMeetingEventId: string | null;
  connectingCalendarProvider: CalendarProvider | null;
  onAddReadyMeeting: (event: NormalizedCalendarEvent) => void;
}) {
  if (!shouldShowReadyMeetingConnect) {
    return null;
  }

  return (
    <WorkspaceMeetingBriefReadyMeetingConnectCard
      event={event}
      addingReadyMeetingEventId={addingReadyMeetingEventId}
      connectingCalendarProvider={connectingCalendarProvider}
      onAddReadyMeeting={onAddReadyMeeting}
    />
  );
}

function WorkspaceMeetingBriefSelectedEventConnectCards({
  event,
  shouldShowReadyMeetingConnect,
  addingReadyMeetingEventId,
  connectingCalendarProvider,
  onAddReadyMeeting,
  selectedCalendarReadyMeeting,
  selectedCalendarReadyMeetingCallIn,
  isSelectedReadyMeetingRecentlyAdded,
  isSelectedReadyMeetingUrlCopied,
  onCopyReadyMeetingUrl,
}: {
  event: NormalizedCalendarEvent;
  shouldShowReadyMeetingConnect: boolean;
  addingReadyMeetingEventId: string | null;
  connectingCalendarProvider: CalendarProvider | null;
  onAddReadyMeeting: (event: NormalizedCalendarEvent) => void;
  selectedCalendarReadyMeeting: NonNullable<NormalizedCalendarEvent["readyMeeting"]> | null;
  selectedCalendarReadyMeetingCallIn: { phoneNumber: string; pin: string } | null;
  isSelectedReadyMeetingRecentlyAdded: boolean;
  isSelectedReadyMeetingUrlCopied: boolean;
  onCopyReadyMeetingUrl: (event: NormalizedCalendarEvent) => void;
}) {
  return (
    <>
      <WorkspaceMeetingBriefReadyMeetingConnectSection
        shouldShowReadyMeetingConnect={shouldShowReadyMeetingConnect}
        event={event}
        addingReadyMeetingEventId={addingReadyMeetingEventId}
        connectingCalendarProvider={connectingCalendarProvider}
        onAddReadyMeeting={onAddReadyMeeting}
      />

      <WorkspaceMeetingBriefReadyMeetingLinkedSection
        selectedCalendarReadyMeeting={selectedCalendarReadyMeeting}
        event={event}
        callIn={selectedCalendarReadyMeetingCallIn}
        isRecentlyAdded={isSelectedReadyMeetingRecentlyAdded}
        isUrlCopied={isSelectedReadyMeetingUrlCopied}
        onCopyReadyMeetingUrl={onCopyReadyMeetingUrl}
      />
    </>
  );
}

function WorkspaceMeetingBriefReadyMeetingLinkedSection({
  selectedCalendarReadyMeeting,
  event,
  callIn,
  isRecentlyAdded,
  isUrlCopied,
  onCopyReadyMeetingUrl,
}: {
  selectedCalendarReadyMeeting: NonNullable<NormalizedCalendarEvent["readyMeeting"]> | null;
  event: NormalizedCalendarEvent;
  callIn: { phoneNumber: string; pin: string } | null;
  isRecentlyAdded: boolean;
  isUrlCopied: boolean;
  onCopyReadyMeetingUrl: (event: NormalizedCalendarEvent) => void;
}) {
  if (selectedCalendarReadyMeeting === null) {
    return null;
  }

  return (
    <WorkspaceMeetingBriefReadyMeetingLinkedCard
      event={event}
      readyMeeting={selectedCalendarReadyMeeting}
      callIn={callIn}
      isRecentlyAdded={isRecentlyAdded}
      isUrlCopied={isUrlCopied}
      onCopyReadyMeetingUrl={onCopyReadyMeetingUrl}
    />
  );
}

function WorkspaceMeetingBriefReadyMeetingLinkedCard({
  event,
  readyMeeting,
  callIn,
  isRecentlyAdded,
  isUrlCopied,
  onCopyReadyMeetingUrl,
}: {
  event: NormalizedCalendarEvent;
  readyMeeting: NonNullable<NormalizedCalendarEvent["readyMeeting"]>;
  callIn: { phoneNumber: string; pin: string } | null;
  isRecentlyAdded: boolean;
  isUrlCopied: boolean;
  onCopyReadyMeetingUrl: (event: NormalizedCalendarEvent) => void;
}) {
  return (
    <section
      className={`workspace-meeting-brief-card workspace-ready-meeting-card is-linked${
        isRecentlyAdded ? " is-generated" : ""
      }`}
    >
      <div className="workspace-meeting-brief-card-inner">
        <div className="workspace-meeting-brief-card-head">
          <ReadyMeetingLogo event={event} />
        </div>
        <div className="workspace-meeting-brief-card-copy">
          <h5>{WORKSPACE_HOME_MESSAGES.readyMeetingTitle}</h5>
          <div className="workspace-ready-meeting-url-row">
            <span className="workspace-ready-meeting-label">{WORKSPACE_HOME_MESSAGES.joinMeetingLabel}</span>
            <a className="workspace-ready-meeting-link" href={readyMeeting.joinUrl} target="_blank" rel="noreferrer">
              {formatReadyMeetingDisplayUrl(readyMeeting.joinUrl)}
            </a>
            <button
              type="button"
              className={`workspace-ready-meeting-copy-button${isUrlCopied ? " is-copied" : ""}`}
              aria-label={WORKSPACE_HOME_MESSAGES.copyReadyMeetingLinkAria}
              title={WORKSPACE_HOME_MESSAGES.copyReadyMeetingLinkAria}
              onClick={() => onCopyReadyMeetingUrl(event)}
            >
              <ReadyMeetingCopyStatusIcon isCopied={isUrlCopied} />
            </button>
          </div>
        </div>
        {callIn !== null ? (
          <div className="workspace-ready-meeting-call-in" aria-label={WORKSPACE_HOME_MESSAGES.readyMeetingDialInAria}>
            <span>{formatReadyMeetingDialInLine(formatReadyMeetingDialInPhoneNumber(callIn.phoneNumber))}</span>
            <span>{formatReadyMeetingPinLine(callIn.pin)}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function applyWorkspacePastMeetingDeletion(input: {
  deletedMeetingId: string;
  remainingMeetings: Meeting[];
  workspaceScope: { userId: string | null; workspaceId: string | null };
  sessionUserId: string | undefined;
  sessionWorkspaceId: string | undefined;
  meetingsQueryKey: readonly unknown[];
  queryClient: QueryClient;
  calendarNow: Date;
  pastMeetingSelectionGroupIndex: number;
  isMobile: boolean;
  onMobileReset: () => void;
  router: { replace: (href: string) => void };
  setMeetingsScope: (scope: { userId: string | null; workspaceId: string | null }) => void;
  setMeetings: (meetings: Meeting[]) => void;
  setSelectedPastPeriodIndex: (index: number) => void;
  setSelectedPastMeetingId: (meetingId: string | null) => void;
}) {
  const {
    deletedMeetingId,
    remainingMeetings,
    workspaceScope,
    sessionUserId,
    sessionWorkspaceId,
    meetingsQueryKey,
    queryClient,
    calendarNow,
    pastMeetingSelectionGroupIndex,
    isMobile,
    onMobileReset,
    router,
    setMeetingsScope,
    setMeetings,
    setSelectedPastPeriodIndex,
    setSelectedPastMeetingId,
  } = input;

  setMeetingsScope(workspaceScope);
  setMeetings(remainingMeetings);
  setCachedWorkspaceMeetings(sessionUserId, sessionWorkspaceId, remainingMeetings);
  queryClient.setQueryData(meetingsQueryKey, remainingMeetings);
  queryClient.removeQueries({ queryKey: meetingDetailQueryKey(deletedMeetingId) });

  const remainingPastGroups = groupPastMeetings(
    remainingMeetings.filter((meeting) => meeting.status === "ended"),
    calendarNow,
  );
  const groupIndex = Math.min(pastMeetingSelectionGroupIndex, Math.max(remainingPastGroups.length - 1, 0));
  const nextMeeting = remainingPastGroups[groupIndex]?.meetings[0] ?? remainingPastGroups[0]?.meetings[0] ?? null;
  setSelectedPastPeriodIndex(groupIndex);
  setSelectedPastMeetingId(nextMeeting?.id ?? null);
  if (isMobile) {
    onMobileReset();
  } else {
    router.replace(nextMeeting ? `/workspace/${nextMeeting.id}` : "/workspace?view=past");
  }
}

function WorkspaceUpcomingCalendarBoard({
  isMobileDetailOpen,
  selectedCalendarGroupIndexForDisplay,
  calendarEventGroupsLength,
  onJumpToNextMeeting,
  onSelectPreviousGroup,
  onSelectNextGroup,
  selectedCalendarEventGroupLabel,
  calendarGroupEvents,
  selectedCalendarEventGroupKind,
  selectedCalendarEventId,
  isMobile,
  isMobileDetailOpenForEvents,
  onSelectEvent,
}: {
  isMobileDetailOpen: boolean;
  selectedCalendarGroupIndexForDisplay: number;
  calendarEventGroupsLength: number;
  onJumpToNextMeeting: () => void;
  onSelectPreviousGroup: () => void;
  onSelectNextGroup: () => void;
  selectedCalendarEventGroupLabel: string;
  calendarGroupEvents: NormalizedCalendarEvent[];
  selectedCalendarEventGroupKind: string | undefined;
  selectedCalendarEventId: string | null;
  isMobile: boolean;
  isMobileDetailOpenForEvents: boolean;
  onSelectEvent: (eventId: string) => void;
}) {
  return (
    <div className="workspace-upcoming-calendar-board" inert={isMobileDetailOpen}>
      <div className="workspace-upcoming-calendar-toolbar">
        <div className="workspace-upcoming-calendar-nav" aria-label={WORKSPACE_HOME_MESSAGES.calendarDayNavigationAria}>
          {selectedCalendarGroupIndexForDisplay > 0 ? (
            <button type="button" className="workspace-upcoming-calendar-today-button" onClick={onJumpToNextMeeting}>
              {WORKSPACE_HOME_MESSAGES.nextMeeting}
            </button>
          ) : null}
          <button
            type="button"
            className="workspace-upcoming-calendar-nav-button is-previous"
            aria-label={
              selectedCalendarGroupIndexForDisplay === 0
                ? WORKSPACE_HOME_MESSAGES.goToPastMeetings
                : WORKSPACE_HOME_MESSAGES.previousUpcomingGroup
            }
            onClick={onSelectPreviousGroup}
          >
            <CalendarChevronIcon />
          </button>
          <button
            type="button"
            className="workspace-upcoming-calendar-nav-button"
            aria-label={WORKSPACE_HOME_MESSAGES.nextUpcomingGroup}
            disabled={selectedCalendarGroupIndexForDisplay >= calendarEventGroupsLength - 1}
            onClick={onSelectNextGroup}
          >
            <CalendarChevronIcon />
          </button>
        </div>
      </div>

      <div className="workspace-upcoming-day-grid">
        <div className="workspace-upcoming-day-column">
          <div className="workspace-upcoming-day-events">
            <div className={`workspace-upcoming-event-section${calendarGroupEvents.length === 0 ? " is-empty" : ""}`}>
              <div className="workspace-upcoming-event-section-title">{selectedCalendarEventGroupLabel}</div>
              {calendarGroupEvents.length !== 0 ? (
                <div className="workspace-upcoming-event-section-list">
                  {calendarGroupEvents.map((event) => (
                    <WorkspaceUpcomingCalendarEventButton
                      key={event.id}
                      event={event}
                      selectedCalendarEventGroupKind={selectedCalendarEventGroupKind}
                      selectedCalendarEventId={selectedCalendarEventId}
                      isMobile={isMobile}
                      isMobileDetailOpen={isMobileDetailOpenForEvents}
                      onSelectEvent={onSelectEvent}
                    />
                  ))}
                </div>
              ) : (
                <div className="workspace-upcoming-day-empty">{WORKSPACE_HOME_MESSAGES.noMeetings}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspaceMeetingBriefEventHeader({
  event,
  subtitlePrimary,
  subtitleSecondary,
  currentUserAvatarUrl,
  currentUserDisplayName,
  currentUserEmail,
}: {
  event: NormalizedCalendarEvent;
  subtitlePrimary?: string | null;
  subtitleSecondary?: string | null;
  currentUserAvatarUrl?: string | null;
  currentUserDisplayName?: string | null;
  currentUserEmail?: string | null;
}) {
  return (
    <div className="workspace-meeting-brief-title-block">
      <h4>{getCalendarEventTitle(event)}</h4>
      <div className="workspace-meeting-meta-pills" aria-label={WORKSPACE_HOME_MESSAGES.meetingDetailsAria}>
        <span className="workspace-meta-pill">{subtitlePrimary}</span>
        {hasNonEmptyText(subtitleSecondary) ? <span className="workspace-meta-pill">{subtitleSecondary}</span> : null}
        <CalendarEventParticipantPills
          currentUserAvatarUrl={currentUserAvatarUrl}
          currentUserDisplayName={currentUserDisplayName}
          currentUserEmail={currentUserEmail}
          event={event}
        />
      </div>
    </div>
  );
}

function WorkspacePastMeetingDetailRegion({
  view,
  isMobile,
  isMobileDetailOpen,
  backButtonRef,
  onMobileBack,
  pastMeetingDetailPaneRef,
  pastMeetingDetailOverlayRef,
  pastDetailMeetingId,
  onMeetingReady,
  onMeetingLoadFailure,
  onMeetingDeleted,
  onRequestDeleteMeeting,
}: {
  view: "past" | "upcoming";
  isMobile: boolean;
  isMobileDetailOpen: boolean;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onMobileBack: () => void;
  pastMeetingDetailPaneRef: RefObject<HTMLDivElement | null>;
  pastMeetingDetailOverlayRef: RefObject<HTMLDivElement | null>;
  pastDetailMeetingId: string | null;
  onMeetingReady: (meetingId: string | null) => void;
  onMeetingLoadFailure: (failure: MeetingLoadFailure | null) => void;
  onMeetingDeleted: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  onRequestDeleteMeeting: (meeting: Meeting) => void;
}) {
  return (
    <div className="workspace-past-meeting-detail-region" inert={isMobile ? !isMobileDetailOpen : false}>
      <button
        ref={backButtonRef}
        type="button"
        className="workspace-mobile-meeting-back workspace-upcoming-calendar-nav-button is-previous"
        onClick={onMobileBack}
        aria-label={WORKSPACE_HOME_MESSAGES.backToMeetings(view)}
      >
        <CalendarChevronIcon />
      </button>
      <div ref={pastMeetingDetailPaneRef} className="workspace-past-meeting-detail-pane">
        {pastDetailMeetingId !== null ? (
          <PostMeetingWorkspace
            key={pastDetailMeetingId}
            meetingId={pastDetailMeetingId}
            onMeetingReady={onMeetingReady}
            onMeetingLoadFailure={onMeetingLoadFailure}
            renderShell={false}
            scrollContainerRef={pastMeetingDetailPaneRef}
            scrollControlContainerRef={pastMeetingDetailOverlayRef}
            onMeetingDeleted={onMeetingDeleted}
            onRequestDeleteMeeting={onRequestDeleteMeeting}
          />
        ) : (
          <div className="workspace-empty-meetings-placeholder">
            <ArchiveTrayIcon />
            <p>{WORKSPACE_HOME_MESSAGES.noPastMeetings}</p>
          </div>
        )}
        <div className="workspace-scroll-bottom-spacer" aria-hidden="true" />
      </div>
      <div ref={pastMeetingDetailOverlayRef} className="workspace-past-meeting-detail-overlay" />
    </div>
  );
}

function WorkspaceUpcomingSetupShell({
  firstName,
  setupDoneCount,
  hasCompletedAgentIntroSetup,
  shouldShowAgentIntroCta,
  calendarProviderPickerRef,
  isCalendarProviderPickerOpen,
  onToggleCalendarProviderPicker,
  connectingCalendarProvider,
  onStartCalendarConnect,
}: {
  firstName: string;
  setupDoneCount: number;
  hasCompletedAgentIntroSetup: boolean;
  shouldShowAgentIntroCta: boolean;
  calendarProviderPickerRef: RefObject<HTMLDivElement | null>;
  isCalendarProviderPickerOpen: boolean;
  onToggleCalendarProviderPicker: () => void;
  connectingCalendarProvider: CalendarProvider | null;
  onStartCalendarConnect: (provider: CalendarProvider) => void;
}) {
  return (
    <div className="workspace-setup-shell">
      <div className="workspace-setup-hero">
        <h2>{WORKSPACE_HOME_MESSAGES.setupGreeting(firstName)}</h2>
        <p>{WORKSPACE_HOME_MESSAGES.setupHero}</p>
      </div>

      <div className="workspace-setup-card">
        <div className="workspace-setup-card-header">
          <h3>{WORKSPACE_HOME_MESSAGES.setupProgress}</h3>
          <span>{WORKSPACE_HOME_MESSAGES.setupProgressCount(setupDoneCount)}</span>
        </div>

        <div className="workspace-setup-list">
          <WorkspaceSetupAgentIntroRow
            hasCompletedAgentIntroSetup={hasCompletedAgentIntroSetup}
            shouldShowAgentIntroCta={shouldShowAgentIntroCta}
          />

          <WorkspaceSetupCalendarConnectRow
            calendarProviderPickerRef={calendarProviderPickerRef}
            isCalendarProviderPickerOpen={isCalendarProviderPickerOpen}
            onToggleCalendarProviderPicker={onToggleCalendarProviderPicker}
            connectingCalendarProvider={connectingCalendarProvider}
            onStartCalendarConnect={onStartCalendarConnect}
          />
        </div>
      </div>
    </div>
  );
}

function WorkspaceSetupAgentIntroRow({
  hasCompletedAgentIntroSetup,
  shouldShowAgentIntroCta,
}: {
  hasCompletedAgentIntroSetup: boolean;
  shouldShowAgentIntroCta: boolean;
}) {
  return (
    <div className="workspace-setup-row">
      <div className="workspace-setup-icon-tile">
        <SetupAgentIcon />
      </div>
      <div className="workspace-setup-copy">
        <h4>{WORKSPACE_HOME_MESSAGES.tryFirstMeeting}</h4>
        <p>{WORKSPACE_HOME_MESSAGES.tryFirstMeetingDescription}</p>
      </div>
      {hasCompletedAgentIntroSetup || !shouldShowAgentIntroCta ? (
        <span
          className="workspace-setup-action is-complete"
          aria-label={WORKSPACE_HOME_MESSAGES.firstMeetingCompletedAria}
        >
          <span className="workspace-setup-action-label">{WORKSPACE_HOME_MESSAGES.completed}</span>
        </span>
      ) : (
        <Link href="/meet?intent=agent_intro" className="workspace-setup-action">
          <span className="workspace-setup-action-label">{WORKSPACE_HOME_MESSAGES.start}</span>
        </Link>
      )}
    </div>
  );
}

function WorkspaceSetupCalendarConnectRow({
  calendarProviderPickerRef,
  isCalendarProviderPickerOpen,
  onToggleCalendarProviderPicker,
  connectingCalendarProvider,
  onStartCalendarConnect,
}: {
  calendarProviderPickerRef: RefObject<HTMLDivElement | null>;
  isCalendarProviderPickerOpen: boolean;
  onToggleCalendarProviderPicker: () => void;
  connectingCalendarProvider: CalendarProvider | null;
  onStartCalendarConnect: (provider: CalendarProvider) => void;
}) {
  return (
    <div className="workspace-setup-row">
      <div className="workspace-setup-icon-tile">
        <ArchiveTrayIcon />
      </div>
      <div className="workspace-setup-copy">
        <h4>{WORKSPACE_HOME_MESSAGES.connectCalendar}</h4>
        <p>{WORKSPACE_HOME_MESSAGES.connectCalendarDescription}</p>
      </div>
      <div className="workspace-calendar-connect" ref={calendarProviderPickerRef}>
        <button
          type="button"
          className="workspace-setup-action"
          aria-haspopup="menu"
          /** @external aria-expanded wire */
          aria-expanded={isCalendarProviderPickerOpen}
          onClick={onToggleCalendarProviderPicker}
        >
          <span className="workspace-setup-action-label">{WORKSPACE_HOME_MESSAGES.connect}</span>
        </button>
        {isCalendarProviderPickerOpen ? (
          <div
            className="workspace-calendar-provider-picker"
            role="menu"
            aria-label={WORKSPACE_HOME_MESSAGES.chooseCalendarProvider}
          >
            {(["google_calendar", "outlook_calendar"] as const).map((provider) => (
              <button
                key={provider}
                type="button"
                role="menuitem"
                onClick={() => onStartCalendarConnect(provider)}
                disabled={connectingCalendarProvider !== null}
              >
                <CalendarProviderLogo provider={provider} />
                <span>
                  {connectingCalendarProvider === provider
                    ? WORKSPACE_HOME_MESSAGES.opening
                    : getCalendarProviderLabel(provider)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkspacePastMeetingListButton({
  meeting,
  calendarNow,
  selectedPastMeetingIdForDisplay,
  isMobile,
  isMobileDetailOpen,
  onPrefetch,
  onSelect,
}: {
  meeting: Meeting;
  calendarNow: Date;
  selectedPastMeetingIdForDisplay: string | null;
  isMobile: boolean;
  isMobileDetailOpen: boolean;
  onPrefetch: (meetingId: string) => void;
  onSelect: (meeting: Meeting) => void;
}) {
  const subtitle = getPastMeetingCardSubtitle(meeting, calendarNow);

  return (
    <button
      type="button"
      className={`workspace-upcoming-event-block is-text-only${
        selectedPastMeetingIdForDisplay === meeting.id && (!isMobile || isMobileDetailOpen) ? " is-selected" : ""
      }`}
      aria-pressed={selectedPastMeetingIdForDisplay === meeting.id ? !isMobile || isMobileDetailOpen : false}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          onPrefetch(meeting.id);
        }
      }}
      onFocus={() => onPrefetch(meeting.id)}
      onClick={() => onSelect(meeting)}
    >
      <span className="workspace-upcoming-event-copy">
        <strong>{meeting.title}</strong>
        {subtitle.kind === "recent" ? (
          <span className="workspace-past-meeting-recent-subtitle">
            <span className="workspace-past-meeting-recent-time">{subtitle.label}</span>
            {hasNonEmptyText(subtitle.notePreview) ? (
              <span className="workspace-past-meeting-note-preview">{subtitle.notePreview}</span>
            ) : null}
          </span>
        ) : (
          <span className="workspace-upcoming-event-subtitle">{subtitle.text}</span>
        )}
      </span>
    </button>
  );
}

function WorkspaceUpcomingCalendarErrorPlaceholder() {
  return (
    <div className="workspace-placeholder-card">
      <h3>{WORKSPACE_HOME_MESSAGES.unableToLoadCalendar}</h3>
      <p>{WORKSPACE_HOME_MESSAGES.refreshCalendarHint}</p>
    </div>
  );
}

function WorkspaceUpcomingCalendarNoMeetingsPlaceholder() {
  return (
    <div className="workspace-upcoming-empty-screen workspace-empty-meetings-placeholder">
      <CalendarStackIcon />
      <p>{WORKSPACE_HOME_MESSAGES.noUpcomingMeetings}</p>
    </div>
  );
}

function WorkspacePastMeetingsPlaceholder({
  shouldShowPastMeetingsLoading,
}: {
  shouldShowPastMeetingsLoading: boolean;
}) {
  return (
    <div className="workspace-upcoming-empty-screen workspace-empty-meetings-placeholder">
      {!shouldShowPastMeetingsLoading ? <ArchiveTrayIcon /> : null}
      <p
        className={shouldShowPastMeetingsLoading ? "workspace-loading-status" : undefined}
        role={shouldShowPastMeetingsLoading ? "status" : undefined}
      >
        {shouldShowPastMeetingsLoading
          ? WORKSPACE_HOME_MESSAGES.loadingMeetings
          : WORKSPACE_HOME_MESSAGES.noPastMeetings}
      </p>
    </div>
  );
}

function WorkspacePastMeetingPeriodToolbar({
  shouldShowPastRecentButton,
  pastPeriodNavigation,
  pastMeetingGroupsLength,
  onSelectRecentPastPeriod,
  onSelectOlderPastPeriod,
  onSelectNewerPastPeriod,
}: {
  shouldShowPastRecentButton: boolean;
  pastPeriodNavigation: {
    olderGroupIndex: number | null;
    newerRoute: string | null;
  };
  pastMeetingGroupsLength: number;
  onSelectRecentPastPeriod: () => void;
  onSelectOlderPastPeriod: () => void;
  onSelectNewerPastPeriod: () => void;
}) {
  return (
    <div className="workspace-upcoming-calendar-toolbar">
      <div
        className="workspace-upcoming-calendar-nav"
        aria-label={WORKSPACE_HOME_MESSAGES.pastMeetingPeriodNavigationAria}
      >
        {shouldShowPastRecentButton ? (
          <button type="button" className="workspace-upcoming-calendar-today-button" onClick={onSelectRecentPastPeriod}>
            {WORKSPACE_HOME_MESSAGES.recent}
          </button>
        ) : null}
        <button
          type="button"
          className="workspace-upcoming-calendar-nav-button is-previous"
          aria-label={WORKSPACE_HOME_MESSAGES.olderMeetings}
          disabled={pastPeriodNavigation.olderGroupIndex === null}
          onClick={onSelectOlderPastPeriod}
        >
          <CalendarChevronIcon />
        </button>
        <button
          type="button"
          className="workspace-upcoming-calendar-nav-button"
          aria-label={
            hasNonEmptyText(pastPeriodNavigation.newerRoute)
              ? WORKSPACE_HOME_MESSAGES.goToUpcomingMeetings
              : WORKSPACE_HOME_MESSAGES.newerMeetings
          }
          disabled={pastMeetingGroupsLength === 0}
          onClick={onSelectNewerPastPeriod}
        >
          <CalendarChevronIcon />
        </button>
      </div>
    </div>
  );
}

function WorkspacePastMeetingPeriodDayGrid({
  selectedPastMeetingGroup,
  calendarNow,
  selectedPastMeetingIdForDisplay,
  isMobile,
  isMobileDetailOpen,
  onPrefetchPastMeeting,
  onSelectPastMeeting,
}: {
  selectedPastMeetingGroup: PastMeetingGroup | null;
  calendarNow: Date;
  selectedPastMeetingIdForDisplay: string | null;
  isMobile: boolean;
  isMobileDetailOpen: boolean;
  onPrefetchPastMeeting: (meetingId: string) => void;
  onSelectPastMeeting: (meeting: Meeting) => void;
}) {
  return (
    <div className="workspace-upcoming-day-grid">
      <div className="workspace-upcoming-day-column">
        <div className="workspace-upcoming-day-events">
          <div className={`workspace-upcoming-event-section${!selectedPastMeetingGroup ? " is-empty" : ""}`}>
            <div className="workspace-upcoming-event-section-title">
              {selectedPastMeetingGroup?.label ?? WORKSPACE_HOME_MESSAGES.pastMeetings}
            </div>
            {selectedPastMeetingGroup ? (
              <div className="workspace-upcoming-event-section-list">
                {selectedPastMeetingGroup.meetings.map((meeting) => (
                  <WorkspacePastMeetingListButton
                    key={meeting.id}
                    meeting={meeting}
                    calendarNow={calendarNow}
                    selectedPastMeetingIdForDisplay={selectedPastMeetingIdForDisplay}
                    isMobile={isMobile}
                    isMobileDetailOpen={isMobileDetailOpen}
                    onPrefetch={onPrefetchPastMeeting}
                    onSelect={onSelectPastMeeting}
                  />
                ))}
              </div>
            ) : (
              <div className="workspace-upcoming-day-empty">{WORKSPACE_HOME_MESSAGES.noMeetings}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspaceHomeErrorBanner({ error }: { error: string | null }) {
  if (error === null || error === "") {
    return null;
  }

  return <div className="error-text">{error}</div>;
}

function WorkspaceMeetingBriefPaneShell({
  isBriefPaneInert,
  backButtonRef,
  onBack,
  backAriaLabel,
  children,
}: {
  isBriefPaneInert: boolean;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  backAriaLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="workspace-meeting-brief-placeholder" inert={isBriefPaneInert}>
      <button
        ref={backButtonRef}
        type="button"
        className="workspace-mobile-meeting-back workspace-upcoming-calendar-nav-button is-previous"
        onClick={onBack}
        aria-label={backAriaLabel}
      >
        <CalendarChevronIcon />
      </button>
      <div className="workspace-meeting-brief-placeholder-header">
        <h3>{WORKSPACE_HOME_MESSAGES.meetingBrief}</h3>
      </div>
      <div className="workspace-meeting-brief-content">{children}</div>
    </div>
  );
}

function WorkspacePastMeetingsLoadedScreen({
  isMobileDetailOpen,
  shouldShowPastRecentButton,
  pastPeriodNavigation,
  pastMeetingGroupsLength,
  onSelectRecentPastPeriod,
  onSelectOlderPastPeriod,
  onSelectNewerPastPeriod,
  selectedPastMeetingGroup,
  calendarNow,
  selectedPastMeetingIdForDisplay,
  isMobile,
  onPrefetchPastMeeting,
  onSelectPastMeeting,
  view,
  backButtonRef,
  onMobileBack,
  pastMeetingDetailPaneRef,
  pastMeetingDetailOverlayRef,
  pastDetailMeetingId,
  onMeetingReady,
  onMeetingLoadFailure,
  onMeetingDeleted,
  onRequestDeleteMeeting,
}: {
  isMobileDetailOpen: boolean;
  shouldShowPastRecentButton: boolean;
  pastPeriodNavigation: {
    olderGroupIndex: number | null;
    newerRoute: string | null;
  };
  pastMeetingGroupsLength: number;
  onSelectRecentPastPeriod: () => void;
  onSelectOlderPastPeriod: () => void;
  onSelectNewerPastPeriod: () => void;
  selectedPastMeetingGroup: PastMeetingGroup | null;
  calendarNow: Date;
  selectedPastMeetingIdForDisplay: string | null;
  isMobile: boolean;
  onPrefetchPastMeeting: (meetingId: string) => void;
  onSelectPastMeeting: (meeting: Meeting) => void;
  view: "past" | "upcoming";
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onMobileBack: () => void;
  pastMeetingDetailPaneRef: RefObject<HTMLDivElement | null>;
  pastMeetingDetailOverlayRef: RefObject<HTMLDivElement | null>;
  pastDetailMeetingId: string | null;
  onMeetingReady: (meetingId: string | null) => void;
  onMeetingLoadFailure: (failure: MeetingLoadFailure | null) => void;
  onMeetingDeleted: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  onRequestDeleteMeeting: (meeting: Meeting) => void;
}) {
  return (
    <div className="workspace-upcoming-calendar-screen workspace-past-meetings-screen">
      <div className="workspace-upcoming-calendar-board" inert={isMobileDetailOpen}>
        <WorkspacePastMeetingPeriodToolbar
          shouldShowPastRecentButton={shouldShowPastRecentButton}
          pastPeriodNavigation={pastPeriodNavigation}
          pastMeetingGroupsLength={pastMeetingGroupsLength}
          onSelectRecentPastPeriod={onSelectRecentPastPeriod}
          onSelectOlderPastPeriod={onSelectOlderPastPeriod}
          onSelectNewerPastPeriod={onSelectNewerPastPeriod}
        />

        <WorkspacePastMeetingPeriodDayGrid
          selectedPastMeetingGroup={selectedPastMeetingGroup}
          calendarNow={calendarNow}
          selectedPastMeetingIdForDisplay={selectedPastMeetingIdForDisplay}
          isMobile={isMobile}
          isMobileDetailOpen={isMobileDetailOpen}
          onPrefetchPastMeeting={onPrefetchPastMeeting}
          onSelectPastMeeting={onSelectPastMeeting}
        />
      </div>

      <WorkspacePastMeetingDetailRegion
        view={view}
        isMobile={isMobile}
        isMobileDetailOpen={isMobileDetailOpen}
        backButtonRef={backButtonRef}
        onMobileBack={onMobileBack}
        pastMeetingDetailPaneRef={pastMeetingDetailPaneRef}
        pastMeetingDetailOverlayRef={pastMeetingDetailOverlayRef}
        pastDetailMeetingId={pastDetailMeetingId}
        onMeetingReady={onMeetingReady}
        onMeetingLoadFailure={onMeetingLoadFailure}
        onMeetingDeleted={onMeetingDeleted}
        onRequestDeleteMeeting={onRequestDeleteMeeting}
      />
    </div>
  );
}

function getWorkspaceHasResolvedCalendarAvailability(input: {
  hasConnectedCalendar: boolean;
  hasCalendarEventsResult: boolean;
  hasAgentSettingsResult: boolean;
  hasCachedCalendarAvailability: boolean;
}) {
  return (
    input.hasConnectedCalendar ||
    input.hasCalendarEventsResult ||
    input.hasAgentSettingsResult ||
    input.hasCachedCalendarAvailability
  );
}

function getWorkspaceIsResolvingCalendarAvailability(input: {
  view: "past" | "upcoming";
  hasResolvedCalendarAvailability: boolean;
  isCalendarEventsError: boolean;
  isRestoringQueryCache: boolean;
  isCalendarEventsFetching: boolean;
  isAgentSettingsFetching: boolean;
}) {
  return (
    input.view === "upcoming" &&
    !input.hasResolvedCalendarAvailability &&
    !input.isCalendarEventsError &&
    (input.isRestoringQueryCache || input.isCalendarEventsFetching || input.isAgentSettingsFetching)
  );
}

function getWorkspaceIsWaitingForCalendarEvents(input: {
  view: "past" | "upcoming";
  hasConnectedCalendar: boolean;
  calendarEventsData: CalendarEventsResponse | undefined;
  isCalendarEventsError: boolean;
  isRestoringQueryCache: boolean;
  isCalendarEventsFetching: boolean;
}) {
  return (
    input.view === "upcoming" &&
    input.hasConnectedCalendar &&
    input.calendarEventsData === undefined &&
    !input.isCalendarEventsError &&
    (input.isRestoringQueryCache || input.isCalendarEventsFetching)
  );
}

function getWorkspaceHomeUpcomingCalendarContentState(input: {
  view: "past" | "upcoming";
  hasConnectedCalendar: boolean;
  hasCalendarEventsResult: boolean;
  hasAgentSettingsResult: boolean;
  hasCachedCalendarAvailability: boolean;
  isCalendarEventsError: boolean;
  isRestoringQueryCache: boolean;
  isCalendarEventsFetching: boolean;
  isAgentSettingsFetching: boolean;
  calendarEventsData: CalendarEventsResponse | undefined;
}) {
  const hasResolvedCalendarAvailability = getWorkspaceHasResolvedCalendarAvailability({
    hasConnectedCalendar: input.hasConnectedCalendar,
    hasCalendarEventsResult: input.hasCalendarEventsResult,
    hasAgentSettingsResult: input.hasAgentSettingsResult,
    hasCachedCalendarAvailability: input.hasCachedCalendarAvailability,
  });
  const isResolvingCalendarAvailability = getWorkspaceIsResolvingCalendarAvailability({
    view: input.view,
    hasResolvedCalendarAvailability,
    isCalendarEventsError: input.isCalendarEventsError,
    isRestoringQueryCache: input.isRestoringQueryCache,
    isCalendarEventsFetching: input.isCalendarEventsFetching,
    isAgentSettingsFetching: input.isAgentSettingsFetching,
  });
  const isWaitingForCalendarEvents = getWorkspaceIsWaitingForCalendarEvents({
    view: input.view,
    hasConnectedCalendar: input.hasConnectedCalendar,
    calendarEventsData: input.calendarEventsData,
    isCalendarEventsError: input.isCalendarEventsError,
    isRestoringQueryCache: input.isRestoringQueryCache,
    isCalendarEventsFetching: input.isCalendarEventsFetching,
  });

  return {
    shouldShowUpcomingCalendarSurface: input.hasConnectedCalendar || isResolvingCalendarAvailability,
    shouldHoldUpcomingCalendarContent: isResolvingCalendarAvailability || isWaitingForCalendarEvents,
  };
}

function getWorkspacePageRootClassName(input: {
  view: "past" | "upcoming";
  shouldShowUpcomingCalendarSurface: boolean;
  isMobileDetailOpen: boolean;
}) {
  const viewClassName =
    input.view === "upcoming"
      ? `meeting-page workspace-upcoming-page${input.shouldShowUpcomingCalendarSurface ? " is-calendar-connected" : ""}`
      : "meeting-page workspace-past-page is-calendar-connected";

  return `${viewClassName} workspace-mobile-meeting-navigation${input.isMobileDetailOpen ? " is-mobile-detail-open" : ""}`;
}

function WorkspaceHomeUpcomingViewBody({
  shouldShowUpcomingCalendarSurface,
  calendarConnectedContent,
  setupShell,
}: {
  shouldShowUpcomingCalendarSurface: boolean;
  calendarConnectedContent: ReactNode;
  setupShell: ReactNode;
}): ReactNode {
  if (shouldShowUpcomingCalendarSurface) {
    return <div className="workspace-upcoming-calendar-stack">{calendarConnectedContent}</div>;
  }

  return setupShell;
}

function WorkspaceHomePastMeetingsStackMain({
  shouldShowPastMeetingsPlaceholder,
  shouldShowPastMeetingsLoading,
  loadedScreen,
}: {
  shouldShowPastMeetingsPlaceholder: boolean;
  shouldShowPastMeetingsLoading: boolean;
  loadedScreen: ReactNode;
}): ReactNode {
  if (shouldShowPastMeetingsPlaceholder) {
    return <WorkspacePastMeetingsPlaceholder shouldShowPastMeetingsLoading={shouldShowPastMeetingsLoading} />;
  }

  return loadedScreen;
}

function WorkspaceHomeUpcomingCalendarStackMain({
  isCalendarEventsError,
  shouldHoldUpcomingCalendarContent,
  shouldShowNoUpcomingMeetings,
  children,
}: {
  isCalendarEventsError: boolean;
  shouldHoldUpcomingCalendarContent: boolean;
  shouldShowNoUpcomingMeetings: boolean;
  children: ReactNode;
}): ReactNode {
  if (isCalendarEventsError) {
    return <WorkspaceUpcomingCalendarErrorPlaceholder />;
  }

  if (shouldHoldUpcomingCalendarContent) {
    return null;
  }

  if (shouldShowNoUpcomingMeetings) {
    return <WorkspaceUpcomingCalendarNoMeetingsPlaceholder />;
  }

  return children;
}

function WorkspaceHomeUpcomingCalendarConnectedScreen(input: {
  view: "past" | "upcoming";
  isMobileDetailOpen: boolean;
  selectedCalendarGroupIndexForDisplay: number;
  calendarEventGroupsLength: number;
  onSelectCalendarGroupIndex: (getNextIndex: (current: number) => number) => void;
  onSelectPreviousCalendarGroup: () => void;
  onSelectUpcomingCalendarEvent: (eventId: string) => void;
  selectedCalendarEventGroupLabel: string;
  calendarGroupEvents: NormalizedCalendarEvent[];
  selectedCalendarEventGroupKind: string | undefined;
  selectedCalendarEventId: string | null;
  isMobile: boolean;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onMobileBack: () => void;
  selectedCalendarEvent: NormalizedCalendarEvent | null;
  briefPane: Omit<WorkspaceHomeSelectedCalendarBriefPaneBodyInput, "selectedCalendarEvent" | "onRunCalendarEventPrep">;
  onRunCalendarEventPrepForSelected: (processor: CalendarEventPrepProcessor) => void;
}) {
  const {
    view,
    isMobileDetailOpen,
    selectedCalendarGroupIndexForDisplay,
    calendarEventGroupsLength,
    onSelectCalendarGroupIndex,
    onSelectPreviousCalendarGroup,
    onSelectUpcomingCalendarEvent,
    selectedCalendarEventGroupLabel,
    calendarGroupEvents,
    selectedCalendarEventGroupKind,
    selectedCalendarEventId,
    isMobile,
    backButtonRef,
    onMobileBack,
    selectedCalendarEvent,
    briefPane,
    onRunCalendarEventPrepForSelected,
  } = input;

  return (
    <div className="workspace-upcoming-calendar-screen">
      <WorkspaceUpcomingCalendarBoard
        isMobileDetailOpen={isMobileDetailOpen}
        selectedCalendarGroupIndexForDisplay={selectedCalendarGroupIndexForDisplay}
        calendarEventGroupsLength={calendarEventGroupsLength}
        onJumpToNextMeeting={() => onSelectCalendarGroupIndex(() => 0)}
        onSelectPreviousGroup={onSelectPreviousCalendarGroup}
        onSelectNextGroup={() => onSelectCalendarGroupIndex((current) => current + 1)}
        selectedCalendarEventGroupLabel={selectedCalendarEventGroupLabel}
        calendarGroupEvents={calendarGroupEvents}
        selectedCalendarEventGroupKind={selectedCalendarEventGroupKind}
        selectedCalendarEventId={selectedCalendarEventId}
        isMobile={isMobile}
        isMobileDetailOpenForEvents={isMobileDetailOpen}
        onSelectEvent={onSelectUpcomingCalendarEvent}
      />

      <WorkspaceMeetingBriefPaneShell
        isBriefPaneInert={isMobile ? !isMobileDetailOpen : false}
        backButtonRef={backButtonRef}
        onBack={onMobileBack}
        backAriaLabel={WORKSPACE_HOME_MESSAGES.backToMeetings(view)}
      >
        {selectedCalendarEvent ? (
          <WorkspaceHomeSelectedCalendarBriefPaneBody
            {...briefPane}
            selectedCalendarEvent={selectedCalendarEvent}
            onRunCalendarEventPrep={onRunCalendarEventPrepForSelected}
          />
        ) : null}
      </WorkspaceMeetingBriefPaneShell>
    </div>
  );
}

function WorkspaceHomePastMeetingsColumn(input: {
  shouldShowPastMeetingsPlaceholder: boolean;
  shouldShowPastMeetingsLoading: boolean;
  loadedScreen: ReactNode;
}) {
  return (
    <div className="workspace-upcoming-calendar-stack">
      <WorkspaceHomePastMeetingsStackMain
        shouldShowPastMeetingsPlaceholder={input.shouldShowPastMeetingsPlaceholder}
        shouldShowPastMeetingsLoading={input.shouldShowPastMeetingsLoading}
        loadedScreen={input.loadedScreen}
      />
    </div>
  );
}

function WorkspaceHomeRemovalDialogs({
  pastMeetingRemoveTarget,
  onCancelPastMeetingRemoval,
  onConfirmPastMeetingRemoval,
  calendarEventDeleteTarget,
  calendarEventDeleteError,
  onCancelCalendarEventDeletion,
  onConfirmCalendarEventDeletion,
}: {
  pastMeetingRemoveTarget: Meeting | null;
  onCancelPastMeetingRemoval: () => void;
  onConfirmPastMeetingRemoval: () => void;
  calendarEventDeleteTarget: NormalizedCalendarEvent | null;
  calendarEventDeleteError: string | null;
  onCancelCalendarEventDeletion: () => void;
  onConfirmCalendarEventDeletion: () => void;
}) {
  return (
    <>
      <PastMeetingRemoveDialog
        meeting={pastMeetingRemoveTarget}
        isPending={false}
        error={null}
        onCancel={onCancelPastMeetingRemoval}
        onConfirm={onConfirmPastMeetingRemoval}
      />
      <CalendarEventDeleteDialog
        event={calendarEventDeleteTarget}
        pending={false}
        error={calendarEventDeleteError}
        onCancel={onCancelCalendarEventDeletion}
        onConfirm={onConfirmCalendarEventDeletion}
      />
    </>
  );
}

function getWorkspaceHomeSelectedCalendarBriefProgressMessages(input: { progress: CalendarEventPrepProgress | null }) {
  const peopleSectionProgress = getMeetingBriefSectionProgress({ progress: input.progress, kind: "people" });
  const companySectionProgress = getMeetingBriefSectionProgress({ progress: input.progress, kind: "company" });

  return {
    peoplePrepMessages: peopleSectionProgress?.messages ?? [],
    companyPrepMessages: companySectionProgress?.messages ?? [],
    prepFallbackMessages: [peopleSectionProgress?.message, companySectionProgress?.message],
  };
}

function useWorkspaceHomeSelectedCalendarBriefEventPrepFetch(input: {
  session: ReturnType<typeof useAuth>["session"];
  sessionUserId: string | undefined;
  selectedCalendarEvent: NormalizedCalendarEvent;
  calendarPrepSummaries: CalendarEventsResponse["prepSummaries"];
  calendarPrepAccess: NonNullable<CalendarEventsResponse["prepAccess"]> | null;
  calendarPrepPlanRequiredEventIds: Set<string>;
  startedCalendarPrepEventIds: Set<string>;
  calendarPrepStartingEventId: string | null;
  isUpcomingView: boolean;
  hasConnectedCalendar: boolean;
  queryClient: QueryClient;
}) {
  const { selectedCalendarEvent } = input;
  const selectedCalendarEventId = selectedCalendarEvent.id;
  const selectedCalendarPrepSummary = useMemo(
    () => input.calendarPrepSummaries.find((summary) => summary.calendarEventId === selectedCalendarEventId) ?? null,
    [input.calendarPrepSummaries, selectedCalendarEventId],
  );
  const isSelectedCalendarPrepPlanRequired = getWorkspaceSelectedCalendarPrepPlanRequired({
    selectedCalendarEventId,
    calendarPrepAccess: input.calendarPrepAccess,
    calendarPrepPlanRequiredEventIds: input.calendarPrepPlanRequiredEventIds,
  });
  const hasStartedSelectedCalendarPrep = input.startedCalendarPrepEventIds.has(selectedCalendarEventId);
  const { calendarEventPrep, isCalendarPrepLoading } = useWorkspaceCalendarEventPrep({
    session: input.session,
    sessionUserId: input.sessionUserId,
    isUpcomingView: input.isUpcomingView,
    hasConnectedCalendar: input.hasConnectedCalendar,
    selectedCalendarEvent,
    selectedCalendarPrepSummary,
    hasStartedSelectedCalendarPrep,
    calendarPrepStartingEventId: input.calendarPrepStartingEventId,
    queryClient: input.queryClient,
  });
  const calendarPrepElapsedSeconds = useWorkspaceCalendarPrepElapsedSeconds({
    selectedCalendarEventId,
    isCalendarPrepLoading,
    prepProgressStartedAt: calendarEventPrep?.progress?.startedAt,
    summaryProgressStartedAt: selectedCalendarPrepSummary?.progress?.startedAt,
  });

  return {
    selectedCalendarEventId,
    selectedCalendarPrepSummary,
    hasStartedSelectedCalendarPrep,
    isSelectedCalendarPrepPlanRequired,
    calendarEventPrep,
    shouldShowPrepLoader: isCalendarPrepLoading,
    calendarPrepElapsedSeconds,
  };
}

function useWorkspaceHomeSelectedCalendarBriefPrepPresentation(input: {
  session: ReturnType<typeof useAuth>["session"];
  sessionUserId: string | undefined;
  selectedCalendarEvent: NormalizedCalendarEvent;
  selectedCalendarEventId: string;
  selectedCalendarPrepSummary: CalendarEventsResponse["prepSummaries"][number] | null;
  hasStartedSelectedCalendarPrep: boolean;
  isSelectedCalendarPrepPlanRequired: boolean;
  calendarEventPrep: CalendarEventPrepResponse | null;
  shouldShowPrepLoader: boolean;
  calendarPrepElapsedSeconds: number;
}) {
  const { selectedCalendarEvent, calendarEventPrep, selectedCalendarPrepSummary, shouldShowPrepLoader } = input;
  const prepProgress = calendarEventPrep?.progress ?? selectedCalendarPrepSummary?.progress ?? null;
  const { peoplePrepMessages, companyPrepMessages, prepFallbackMessages } =
    getWorkspaceHomeSelectedCalendarBriefProgressMessages({ progress: prepProgress });
  const { peoplePrepBullets, briefPrepBullets } = getWorkspaceMeetingBriefPrepBulletLists({
    shouldShowPrepLoader,
    calendarEventPrep,
  });
  const companyPrepTitle = getMeetingBriefCompanyTitle({
    event: selectedCalendarEvent,
    prep: calendarEventPrep,
    userEmail: input.session?.user.email,
  });
  const companyPrepBullets = getWorkspaceMeetingBriefCompanyPrepBullets({
    shouldShowPrepLoader,
    calendarEventPrep,
  });
  const shouldShowPrepPrompt = getWorkspaceCanShowPrepPromptSurface({
    selectedCalendarEvent,
    shouldShowPrepLoader,
    calendarEventPrep,
    selectedCalendarPrepSummary,
    hasStartedSelectedCalendarPrep: input.hasStartedSelectedCalendarPrep,
  });
  const { calendarPrepEstimate, calendarPrepEstimateErrorMessage, calendarPrepEstimateQuery } =
    useWorkspaceCalendarPrepEstimate({
      session: input.session,
      sessionUserId: input.sessionUserId,
      selectedCalendarEvent,
      selectedCalendarEventId: input.selectedCalendarEventId,
      shouldShowPrepPrompt,
      isSelectedCalendarPrepPlanRequired: input.isSelectedCalendarPrepPlanRequired,
    });

  return {
    calendarEventPrep,
    shouldShowPrepLoader,
    calendarPrepElapsedSeconds: input.calendarPrepElapsedSeconds,
    peoplePrepMessages,
    companyPrepMessages,
    prepFallbackMessages,
    peoplePrepBullets,
    briefPrepBullets,
    companyPrepTitle,
    companyPrepBullets,
    shouldShowPrepPrompt,
    calendarPrepEstimate,
    calendarPrepEstimateErrorMessage,
    calendarPrepEstimateQuery,
    isSelectedCalendarPrepPlanRequired: input.isSelectedCalendarPrepPlanRequired,
  };
}

function useWorkspaceHomeSelectedCalendarBriefPrepDisplay(input: {
  session: ReturnType<typeof useAuth>["session"];
  sessionUserId: string | undefined;
  selectedCalendarEvent: NormalizedCalendarEvent;
  shouldShowPrepLoader: boolean;
  briefPrepBullets: string[];
  peoplePrepBullets: string[];
  calendarEventPrep: CalendarEventPrepResponse | null;
  shouldShowPrepPrompt: boolean;
  recentlyAddedReadyMeetingEventKey: string | null;
  copiedReadyMeetingEventKey: string | null;
  setRecentlyAddedReadyMeetingEventKey: (eventKey: string | null) => void;
}) {
  const { shouldShowPeoplePrep, shouldShowBriefPrep, shouldShowCompanyPrep } =
    getWorkspaceMeetingBriefPrepSectionVisibility({
      peoplePrepBullets: input.peoplePrepBullets,
      briefPrepBullets: input.briefPrepBullets,
      calendarEventPrep: input.calendarEventPrep,
    });
  const {
    selectedCalendarReadyMeeting,
    isSelectedReadyMeetingRecentlyAdded,
    isSelectedReadyMeetingUrlCopied,
    shouldShowReadyMeetingConnect,
    shouldShowReadyMeetingCard,
    selectedReadyMeetingCode,
  } = getWorkspaceSelectedCalendarReadyMeetingState({
    selectedCalendarEvent: input.selectedCalendarEvent,
    recentlyAddedReadyMeetingEventKey: input.recentlyAddedReadyMeetingEventKey,
    copiedReadyMeetingEventKey: input.copiedReadyMeetingEventKey,
  });
  const selectedCalendarReadyMeetingCallIn = useWorkspaceSelectedReadyMeetingCallIn({
    session: input.session,
    selectedCalendarReadyMeeting,
    selectedReadyMeetingCode,
  });
  const shouldShowEmptyPrep = getWorkspaceShouldShowEmptyMeetingBriefPrep({
    shouldShowPrepLoader: input.shouldShowPrepLoader,
    shouldShowReadyMeetingConnect,
    shouldShowReadyMeetingCard,
    shouldShowPrepPrompt: input.shouldShowPrepPrompt,
    shouldShowBriefPrep,
    shouldShowPeoplePrep,
    shouldShowCompanyPrep,
  });
  useWorkspaceRecentlyAddedReadyMeetingAutoClear({
    recentlyAddedReadyMeetingEventKey: input.recentlyAddedReadyMeetingEventKey,
    setRecentlyAddedReadyMeetingEventKey: input.setRecentlyAddedReadyMeetingEventKey,
  });

  return {
    shouldShowPeoplePrep,
    shouldShowBriefPrep,
    shouldShowCompanyPrep,
    selectedCalendarReadyMeeting,
    isSelectedReadyMeetingRecentlyAdded,
    isSelectedReadyMeetingUrlCopied,
    shouldShowReadyMeetingConnect,
    selectedCalendarReadyMeetingCallIn,
    shouldShowEmptyPrep,
  };
}

function WorkspaceHomeSelectedCalendarBriefEventHeaderSection(input: {
  event: NormalizedCalendarEvent;
  currentUserAvatarUrl?: string | null;
  currentUserDisplayName?: string | null;
  currentUserEmail?: string | null;
}) {
  const subtitle = getCalendarEventSubtitleParts(input.event);

  return (
    <WorkspaceMeetingBriefEventHeader
      event={input.event}
      subtitlePrimary={subtitle.primary}
      subtitleSecondary={subtitle.secondary}
      currentUserAvatarUrl={input.currentUserAvatarUrl}
      currentUserDisplayName={input.currentUserDisplayName}
      currentUserEmail={input.currentUserEmail}
    />
  );
}

function WorkspaceHomeSelectedCalendarBriefMeetingCardsSection(input: {
  event: NormalizedCalendarEvent;
  shouldShowReadyMeetingConnect: boolean;
  addingReadyMeetingEventId: string | null;
  connectingCalendarProvider: CalendarProvider | null;
  onAddReadyMeeting: (event: NormalizedCalendarEvent) => void;
  selectedCalendarReadyMeeting: NonNullable<NormalizedCalendarEvent["readyMeeting"]> | null;
  selectedCalendarReadyMeetingCallIn: { phoneNumber: string; pin: string } | null;
  isSelectedReadyMeetingRecentlyAdded: boolean;
  isSelectedReadyMeetingUrlCopied: boolean;
  onCopyReadyMeetingUrl: (event: NormalizedCalendarEvent) => void;
  shouldShowPrepPrompt: boolean;
  calendarPrepEstimate: CalendarEventPrepEstimateResponse | null;
  calendarPrepEstimateErrorMessage: string | null;
  calendarPrepStartingEventId: string | null;
  isCalendarPrepEstimateFetching: boolean;
  isSelectedCalendarPrepPlanRequired: boolean;
  onRetryPrepEstimate: () => void;
  onRunCalendarEventPrep: (processor: CalendarEventPrepProcessor) => void;
  onOpenCalendarPrepUpgrade: () => void;
  shouldShowPrepLoader: boolean;
  calendarPrepElapsedSeconds: number;
  prepFallbackMessages: readonly (string | null | undefined)[];
  peoplePrepMessages: string[];
  companyPrepMessages: string[];
  calendarEventPrepStatus: CalendarEventPrepResponse["status"] | "loading";
  shouldShowBriefPrep: boolean;
  briefPrepBullets: string[];
  shouldShowPeoplePrep: boolean;
  peoplePrepBullets: string[];
  peoplePrepSources: CalendarEventPrepSource[];
  shouldShowCompanyPrep: boolean;
  companyPrepTitle: string;
  companyPrepBullets: string[];
  companyPrepSources: CalendarEventPrepSource[];
  shouldShowEmptyPrep: boolean;
}) {
  return (
    <div className="workspace-meeting-brief-cards" aria-label={WORKSPACE_HOME_MESSAGES.meetingBriefSectionsAria}>
      <WorkspaceMeetingBriefSelectedEventConnectCards
        event={input.event}
        shouldShowReadyMeetingConnect={input.shouldShowReadyMeetingConnect}
        addingReadyMeetingEventId={input.addingReadyMeetingEventId}
        connectingCalendarProvider={input.connectingCalendarProvider}
        onAddReadyMeeting={input.onAddReadyMeeting}
        selectedCalendarReadyMeeting={input.selectedCalendarReadyMeeting}
        selectedCalendarReadyMeetingCallIn={input.selectedCalendarReadyMeetingCallIn}
        isSelectedReadyMeetingRecentlyAdded={input.isSelectedReadyMeetingRecentlyAdded}
        isSelectedReadyMeetingUrlCopied={input.isSelectedReadyMeetingUrlCopied}
        onCopyReadyMeetingUrl={input.onCopyReadyMeetingUrl}
      />

      {upcomingMeetingPrep.isVisible ? (
        <WorkspaceMeetingBriefPrepFlow
          shouldShowPrepPrompt={input.shouldShowPrepPrompt}
          calendarPrepEstimate={input.calendarPrepEstimate}
          calendarPrepEstimateErrorMessage={input.calendarPrepEstimateErrorMessage}
          calendarPrepStartingEventId={input.calendarPrepStartingEventId}
          isCalendarPrepEstimateFetching={input.isCalendarPrepEstimateFetching}
          isSelectedCalendarPrepPlanRequired={input.isSelectedCalendarPrepPlanRequired}
          onRetryPrepEstimate={input.onRetryPrepEstimate}
          onRunCalendarEventPrep={input.onRunCalendarEventPrep}
          onOpenCalendarPrepUpgrade={input.onOpenCalendarPrepUpgrade}
          shouldShowPrepLoader={input.shouldShowPrepLoader}
          calendarPrepElapsedSeconds={input.calendarPrepElapsedSeconds}
          prepFallbackMessages={input.prepFallbackMessages}
          peoplePrepMessages={input.peoplePrepMessages}
          companyPrepMessages={input.companyPrepMessages}
          calendarEventPrepStatus={input.calendarEventPrepStatus}
          shouldShowBriefPrep={input.shouldShowBriefPrep}
          briefPrepBullets={input.briefPrepBullets}
          shouldShowPeoplePrep={input.shouldShowPeoplePrep}
          peoplePrepBullets={input.peoplePrepBullets}
          peoplePrepSources={input.peoplePrepSources}
          shouldShowCompanyPrep={input.shouldShowCompanyPrep}
          companyPrepTitle={input.companyPrepTitle}
          companyPrepBullets={input.companyPrepBullets}
          companyPrepSources={input.companyPrepSources}
          shouldShowEmptyPrep={input.shouldShowEmptyPrep}
        />
      ) : null}
    </div>
  );
}

type WorkspaceHomeSelectedCalendarBriefPaneBodyInput = {
  session: ReturnType<typeof useAuth>["session"];
  sessionUserId: string | undefined;
  selectedCalendarEvent: NormalizedCalendarEvent;
  calendarPrepSummaries: CalendarEventsResponse["prepSummaries"];
  calendarPrepAccess: NonNullable<CalendarEventsResponse["prepAccess"]> | null;
  calendarPrepPlanRequiredEventIds: Set<string>;
  startedCalendarPrepEventIds: Set<string>;
  calendarPrepStartingEventId: string | null;
  isUpcomingView: boolean;
  hasConnectedCalendar: boolean;
  queryClient: QueryClient;
  connectingCalendarProvider: CalendarProvider | null;
  addingReadyMeetingEventId: string | null;
  recentlyAddedReadyMeetingEventKey: string | null;
  copiedReadyMeetingEventKey: string | null;
  setRecentlyAddedReadyMeetingEventKey: (eventKey: string | null) => void;
  onAddReadyMeeting: (event: NormalizedCalendarEvent) => void;
  onCopyReadyMeetingUrl: (event: NormalizedCalendarEvent) => void;
  onRunCalendarEventPrep: (processor: CalendarEventPrepProcessor) => void;
  onOpenCalendarPrepUpgrade: () => void;
};

function WorkspaceHomeSelectedCalendarBriefPaneSections(input: {
  briefPane: WorkspaceHomeSelectedCalendarBriefPaneBodyInput;
  prepSession: ReturnType<typeof useWorkspaceHomeSelectedCalendarBriefPrepPresentation>;
  prepDisplay: ReturnType<typeof useWorkspaceHomeSelectedCalendarBriefPrepDisplay>;
}) {
  const { briefPane, prepSession, prepDisplay } = input;

  return (
    <>
      <WorkspaceHomeSelectedCalendarBriefEventHeaderSection
        event={briefPane.selectedCalendarEvent}
        currentUserAvatarUrl={briefPane.session?.user.avatarUrl}
        currentUserDisplayName={briefPane.session?.user.displayName}
        currentUserEmail={briefPane.session?.user.email}
      />
      <WorkspaceHomeSelectedCalendarBriefMeetingCardsSection
        event={briefPane.selectedCalendarEvent}
        shouldShowReadyMeetingConnect={prepDisplay.shouldShowReadyMeetingConnect}
        addingReadyMeetingEventId={briefPane.addingReadyMeetingEventId}
        connectingCalendarProvider={briefPane.connectingCalendarProvider}
        onAddReadyMeeting={briefPane.onAddReadyMeeting}
        selectedCalendarReadyMeeting={prepDisplay.selectedCalendarReadyMeeting}
        selectedCalendarReadyMeetingCallIn={prepDisplay.selectedCalendarReadyMeetingCallIn}
        isSelectedReadyMeetingRecentlyAdded={prepDisplay.isSelectedReadyMeetingRecentlyAdded}
        isSelectedReadyMeetingUrlCopied={prepDisplay.isSelectedReadyMeetingUrlCopied}
        onCopyReadyMeetingUrl={briefPane.onCopyReadyMeetingUrl}
        shouldShowPrepPrompt={prepSession.shouldShowPrepPrompt}
        calendarPrepEstimate={prepSession.calendarPrepEstimate}
        calendarPrepEstimateErrorMessage={prepSession.calendarPrepEstimateErrorMessage}
        calendarPrepStartingEventId={briefPane.calendarPrepStartingEventId}
        isCalendarPrepEstimateFetching={prepSession.calendarPrepEstimateQuery.isFetching}
        isSelectedCalendarPrepPlanRequired={prepSession.isSelectedCalendarPrepPlanRequired}
        onRetryPrepEstimate={() => void prepSession.calendarPrepEstimateQuery.refetch()}
        onRunCalendarEventPrep={briefPane.onRunCalendarEventPrep}
        onOpenCalendarPrepUpgrade={briefPane.onOpenCalendarPrepUpgrade}
        shouldShowPrepLoader={prepSession.shouldShowPrepLoader}
        calendarPrepElapsedSeconds={prepSession.calendarPrepElapsedSeconds}
        prepFallbackMessages={prepSession.prepFallbackMessages}
        peoplePrepMessages={prepSession.peoplePrepMessages}
        companyPrepMessages={prepSession.companyPrepMessages}
        calendarEventPrepStatus={prepSession.calendarEventPrep?.status ?? "loading"}
        shouldShowBriefPrep={prepDisplay.shouldShowBriefPrep}
        briefPrepBullets={prepSession.briefPrepBullets}
        shouldShowPeoplePrep={prepDisplay.shouldShowPeoplePrep}
        peoplePrepBullets={prepSession.peoplePrepBullets}
        peoplePrepSources={prepSession.calendarEventPrep?.people.sources ?? []}
        shouldShowCompanyPrep={prepDisplay.shouldShowCompanyPrep}
        companyPrepTitle={prepSession.companyPrepTitle}
        companyPrepBullets={prepSession.companyPrepBullets}
        companyPrepSources={prepSession.calendarEventPrep?.company?.sources ?? []}
        shouldShowEmptyPrep={prepDisplay.shouldShowEmptyPrep}
      />
      <div className="workspace-scroll-bottom-spacer" aria-hidden="true" />
    </>
  );
}

function WorkspaceHomeSelectedCalendarBriefPaneBody(input: WorkspaceHomeSelectedCalendarBriefPaneBodyInput) {
  const eventPrep = useWorkspaceHomeSelectedCalendarBriefEventPrepFetch({
    session: input.session,
    sessionUserId: input.sessionUserId,
    selectedCalendarEvent: input.selectedCalendarEvent,
    calendarPrepSummaries: input.calendarPrepSummaries,
    calendarPrepAccess: input.calendarPrepAccess,
    calendarPrepPlanRequiredEventIds: input.calendarPrepPlanRequiredEventIds,
    startedCalendarPrepEventIds: input.startedCalendarPrepEventIds,
    calendarPrepStartingEventId: input.calendarPrepStartingEventId,
    isUpcomingView: input.isUpcomingView,
    hasConnectedCalendar: input.hasConnectedCalendar,
    queryClient: input.queryClient,
  });
  const prepSession = useWorkspaceHomeSelectedCalendarBriefPrepPresentation({
    session: input.session,
    sessionUserId: input.sessionUserId,
    selectedCalendarEvent: input.selectedCalendarEvent,
    selectedCalendarEventId: eventPrep.selectedCalendarEventId,
    selectedCalendarPrepSummary: eventPrep.selectedCalendarPrepSummary,
    hasStartedSelectedCalendarPrep: eventPrep.hasStartedSelectedCalendarPrep,
    isSelectedCalendarPrepPlanRequired: eventPrep.isSelectedCalendarPrepPlanRequired,
    calendarEventPrep: eventPrep.calendarEventPrep,
    shouldShowPrepLoader: eventPrep.shouldShowPrepLoader,
    calendarPrepElapsedSeconds: eventPrep.calendarPrepElapsedSeconds,
  });
  const prepDisplay = useWorkspaceHomeSelectedCalendarBriefPrepDisplay({
    session: input.session,
    sessionUserId: input.sessionUserId,
    selectedCalendarEvent: input.selectedCalendarEvent,
    shouldShowPrepLoader: prepSession.shouldShowPrepLoader,
    briefPrepBullets: prepSession.briefPrepBullets,
    peoplePrepBullets: prepSession.peoplePrepBullets,
    calendarEventPrep: prepSession.calendarEventPrep,
    shouldShowPrepPrompt: prepSession.shouldShowPrepPrompt,
    recentlyAddedReadyMeetingEventKey: input.recentlyAddedReadyMeetingEventKey,
    copiedReadyMeetingEventKey: input.copiedReadyMeetingEventKey,
    setRecentlyAddedReadyMeetingEventKey: input.setRecentlyAddedReadyMeetingEventKey,
  });

  return (
    <WorkspaceHomeSelectedCalendarBriefPaneSections
      briefPane={input}
      prepSession={prepSession}
      prepDisplay={prepDisplay}
    />
  );
}

function useWorkspaceHomePastMeetingsDisplay(input: {
  meetingsForDisplay: Meeting[];
  calendarNow: Date;
  selectedPastMeetingId: string | null;
  selectedPastPeriodIndex: number;
  isMeetingListResolving: boolean;
  isMeetingsQuerySuccess: boolean;
  isMobile: boolean;
  mobileDetailId: string | null;
}) {
  const pastMeetings = useMemo(
    () => input.meetingsForDisplay.filter((meeting) => meeting.status === "ended"),
    [input.meetingsForDisplay],
  );
  const pastMeetingGroups = useMemo(
    () => groupPastMeetings(pastMeetings, input.calendarNow),
    [input.calendarNow, pastMeetings],
  );
  const { shouldShowPastMeetingsLoading, shouldShowPastMeetingsPlaceholder } = getWorkspacePastMeetingsPlaceholderState(
    {
      isMeetingListResolving: input.isMeetingListResolving,
      pastMeetingsLength: pastMeetings.length,
      selectedPastMeetingId: input.selectedPastMeetingId,
      isMeetingsQuerySuccess: input.isMeetingsQuerySuccess,
    },
  );
  const pastMeetingSelection = useMemo(
    () =>
      resolvePastMeetingSelection({
        groups: pastMeetingGroups,
        selectedMeetingId: input.selectedPastMeetingId,
        preferredGroupIndex: input.selectedPastPeriodIndex,
      }),
    [pastMeetingGroups, input.selectedPastMeetingId, input.selectedPastPeriodIndex],
  );
  const selectedPastMeetingGroup = pastMeetingGroups[pastMeetingSelection.groupIndex] ?? null;
  const selectedPastMeetingIdForDisplay = pastMeetingSelection.meetingId;
  const selectedPastMeetingForDisplay = pastMeetingSelection.meeting;
  const pastDetailMeetingId = getWorkspacePastDetailMeetingId({
    isMobile: input.isMobile,
    mobileDetailId: input.mobileDetailId,
    selectedPastMeetingIdForDisplay,
    selectedPastMeetingId: input.selectedPastMeetingId,
  });
  const pastPeriodNavigation = useMemo(
    () => getPastMeetingPeriodNavigation(pastMeetingGroups, pastMeetingSelection.groupIndex),
    [pastMeetingGroups, pastMeetingSelection.groupIndex],
  );
  const shouldShowPastRecentButton = getWorkspaceShouldShowPastRecentButton({
    pastMeetingGroupsLength: pastMeetingGroups.length,
    pastMeetingSelectionGroupIndex: pastMeetingSelection.groupIndex,
  });

  return {
    pastMeetingGroups,
    shouldShowPastMeetingsLoading,
    shouldShowPastMeetingsPlaceholder,
    pastMeetingSelection,
    selectedPastMeetingGroup,
    selectedPastMeetingIdForDisplay,
    selectedPastMeetingForDisplay,
    pastDetailMeetingId,
    pastPeriodNavigation,
    shouldShowPastRecentButton,
  };
}

function useWorkspaceHomeUpcomingCalendarSelection(input: {
  calendarEventsQueryData: CalendarEventsResponse | undefined;
  calendarNow: Date;
  selectedCalendarGroupIndex: number;
  manuallySelectedCalendarEventId: string | null;
  isMobile: boolean;
  mobileDetailId: string | null;
  hasConnectedCalendar: boolean;
  hasCalendarEventsResult: boolean;
}) {
  const calendarEvents = useMemo(
    () => getVisibleCalendarEvents(input.calendarEventsQueryData?.events ?? []),
    [input.calendarEventsQueryData?.events],
  );
  const calendarEventGroups = useMemo(
    () => getUpcomingCalendarEventGroups(calendarEvents, input.calendarNow),
    [calendarEvents, input.calendarNow],
  );
  const shouldShowNoUpcomingMeetings = getWorkspaceShouldShowNoUpcomingMeetings({
    hasConnectedCalendar: input.hasConnectedCalendar,
    hasCalendarEventsResult: input.hasCalendarEventsResult,
    calendarEventGroupsLength: calendarEventGroups.length,
  });
  const selectedCalendarGroupIndexForDisplay = Math.min(
    Math.max(input.selectedCalendarGroupIndex, 0),
    Math.max(calendarEventGroups.length - 1, 0),
  );
  const selectedCalendarEventGroup = calendarEventGroups[selectedCalendarGroupIndexForDisplay] ?? null;
  const selectedCalendarEventGroupLabel = selectedCalendarEventGroup?.label ?? "Upcoming";
  const calendarGroupEvents = selectedCalendarEventGroup?.events ?? [];
  const calendarEventSelection = useMemo(
    () => getCalendarEventSelection(calendarGroupEvents, input.manuallySelectedCalendarEventId),
    [calendarGroupEvents, input.manuallySelectedCalendarEventId],
  );
  const selectedCalendarEvent = getWorkspaceSelectedCalendarEventForDisplay({
    isMobile: input.isMobile,
    mobileDetailId: input.mobileDetailId,
    calendarEvents,
    selectedEventFromGroup: calendarEventSelection.selectedEvent,
  });

  return {
    calendarEvents,
    calendarEventGroups,
    shouldShowNoUpcomingMeetings,
    selectedCalendarGroupIndexForDisplay,
    selectedCalendarEventGroup,
    selectedCalendarEventGroupLabel,
    calendarGroupEvents,
    selectedCalendarEvent,
    selectedCalendarEventId: selectedCalendarEvent?.id ?? null,
    calendarPrepSummaries: input.calendarEventsQueryData?.prepSummaries ?? [],
    calendarPrepAccess: input.calendarEventsQueryData?.prepAccess ?? null,
  };
}

function useWorkspaceHomeAgentSettingsQuery(input: {
  session: { token: string; user: { id: string } } | null | undefined;
  isUpcomingView: boolean;
}) {
  return useQuery({
    queryKey: ["agent-settings", input.session?.user.id],
    queryFn: () => {
      if (!input.session) {
        throw new Error(WORKSPACE_HOME_MESSAGES.sessionUnavailable);
      }

      return getMyAgentSettings({ token: input.session.token });
    },
    enabled: Boolean(input.session && input.isUpcomingView),
    staleTime: WORKSPACE_QUERY_STALE_TIME_MS,
  });
}

function useWorkspaceHomeMeetingsQuery(
  session: { token: string; user: { id: string; workspaceId: string } } | null | undefined,
) {
  // An existing query-cache entry already wins over initialData, so only the module cache is a fallback here.
  return useQuery({
    ...workspaceMeetingsOptions(session),
    initialData: () => getCachedWorkspaceMeetings(session?.user.id, session?.user.workspaceId) ?? undefined,
  });
}

function useWorkspaceHomeCalendarEventsQuery(input: {
  session: ReturnType<typeof useAuth>["session"];
  calendarEventsKey: readonly unknown[];
  queryClient: QueryClient;
  isUpcomingView: boolean;
}) {
  return useQuery({
    queryKey: input.calendarEventsKey,
    queryFn: () => {
      if (!input.session) {
        throw new Error(WORKSPACE_HOME_MESSAGES.sessionUnavailable);
      }

      return listCalendarEvents({ token: input.session.token });
    },
    enabled: Boolean(input.session && input.isUpcomingView),
    initialData: () => input.queryClient.getQueryData<CalendarEventsResponse>(input.calendarEventsKey),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: input.isUpcomingView
      ? isLocalCalendarWebhookUnavailable()
        ? CALENDAR_REFRESH_INTERVAL_MS
        : CALENDAR_REFRESH_INTERVAL_WHEN_WEBHOOK_UNAVAILABLE_MS
      : false,
  });
}

function useWorkspaceHomeCalendarEventDeletion(input: {
  session: ReturnType<typeof useAuth>["session"];
  showToast: (toast: ToastInput) => void;
  calendarEventDeleteTarget: NormalizedCalendarEvent | null;
  setCalendarEventDeleteTarget: (event: NormalizedCalendarEvent | null) => void;
  setCalendarEventDeleteError: (error: string | null) => void;
  calendarEventsKey: readonly unknown[];
  calendarGroupEvents: NormalizedCalendarEvent[];
  queryClient: QueryClient;
  setError: (message: string | null) => void;
  setManuallySelectedCalendarEventId: (eventId: string | null) => void;
}) {
  const requestCalendarEventDeletion = useCallback(
    (event: NormalizedCalendarEvent) => {
      input.setCalendarEventDeleteError(null);
      if (event.provider !== "google_calendar" || !hasNonEmptyText(event.calendarAccountId)) {
        input.showToast({
          id: `calendar-event-delete-unsupported:${event.id}`,
          title: WORKSPACE_HOME_MESSAGES.calendarEventCannotBeDeletedTitle,
          message: WORKSPACE_HOME_MESSAGES.calendarEventCannotBeDeletedMessage,
          tone: "warning",
        });

        return;
      }

      input.setCalendarEventDeleteTarget(event);
    },
    [input.setCalendarEventDeleteError, input.setCalendarEventDeleteTarget, input.showToast],
  );

  const confirmCalendarEventDeletion = useCallback(async () => {
    if (
      !input.session ||
      input.calendarEventDeleteTarget === null ||
      !hasNonEmptyText(input.calendarEventDeleteTarget.calendarAccountId)
    ) {
      return;
    }

    const eventToDelete = input.calendarEventDeleteTarget;
    const calendarAccountId = input.calendarEventDeleteTarget.calendarAccountId;
    input.setCalendarEventDeleteTarget(null);
    await confirmWorkspaceCalendarEventDeletion({
      session: input.session,
      eventToDelete,
      calendarAccountId,
      calendarEventsKey: input.calendarEventsKey,
      calendarGroupEvents: input.calendarGroupEvents,
      queryClient: input.queryClient,
      showToast: input.showToast,
      setError: input.setError,
      setCalendarEventDeleteError: input.setCalendarEventDeleteError,
      setManuallySelectedCalendarEventId: input.setManuallySelectedCalendarEventId,
    });
  }, [
    input.calendarEventDeleteTarget,
    input.calendarEventsKey,
    input.calendarGroupEvents,
    input.queryClient,
    input.session,
    input.setCalendarEventDeleteError,
    input.setCalendarEventDeleteTarget,
    input.setError,
    input.setManuallySelectedCalendarEventId,
    input.showToast,
  ]);

  return { requestCalendarEventDeletion, confirmCalendarEventDeletion };
}

function useWorkspaceHomePastMeetingSelection(input: {
  pastMeetingGroups: PastMeetingGroup[];
  router: ReturnType<typeof useRouter>;
  isMobile: boolean;
  onOpenMobileDetail: (detailId: string) => void;
  session: ReturnType<typeof useAuth>["session"];
  queryClient: QueryClient;
  setSelectedPastPeriodIndex: (index: number) => void;
  setSelectedPastMeetingId: (meetingId: string | null) => void;
}) {
  const selectPastPeriodIndex = useCallback(
    (groupIndex: number) => {
      const group = input.pastMeetingGroups[groupIndex];
      const meeting = group?.meetings[0] ?? null;
      input.setSelectedPastPeriodIndex(groupIndex);
      input.setSelectedPastMeetingId(meeting?.id ?? null);
      if (!input.isMobile) {
        input.router.push(meeting ? `/workspace/${meeting.id}` : "/workspace?view=past");
      }
    },
    [
      input.isMobile,
      input.pastMeetingGroups,
      input.router,
      input.setSelectedPastMeetingId,
      input.setSelectedPastPeriodIndex,
    ],
  );

  const prefetchPastMeeting = useCallback(
    (meetingId: string) => {
      const session = input.session;
      if (session === null) {
        return;
      }
      void input.queryClient.prefetchQuery({
        ...meetingNotesViewOptions({ session, meetingId }),
        staleTime: WORKSPACE_QUERY_STALE_TIME_MS,
      });
    },
    [input.queryClient, input.session],
  );

  const selectPastMeeting = useCallback(
    (meeting: Meeting) => {
      const groupIndex = input.pastMeetingGroups.findIndex((group) =>
        group.meetings.some((item) => item.id === meeting.id),
      );
      if (groupIndex >= 0) {
        input.setSelectedPastPeriodIndex(groupIndex);
      }
      input.setSelectedPastMeetingId(meeting.id);
      if (input.isMobile) {
        input.onOpenMobileDetail(meeting.id);
      } else {
        input.router.push(`/workspace/${meeting.id}`);
      }
    },
    [
      input.isMobile,
      input.onOpenMobileDetail,
      input.pastMeetingGroups,
      input.router,
      input.setSelectedPastMeetingId,
      input.setSelectedPastPeriodIndex,
    ],
  );

  return { selectPastPeriodIndex, prefetchPastMeeting, selectPastMeeting };
}

function useWorkspaceHomePastPeriodNavigation(input: {
  pastMeetingGroups: PastMeetingGroup[];
  pastPeriodNavigation: {
    olderGroupIndex: number | null;
    newerGroupIndex: number | null;
    newerRoute: string | null;
  };
  router: ReturnType<typeof useRouter>;
  selectPastPeriodIndex: (groupIndex: number) => void;
}) {
  const selectOlderPastPeriod = useCallback(() => {
    if (input.pastPeriodNavigation.olderGroupIndex === null) {
      return;
    }

    input.selectPastPeriodIndex(input.pastPeriodNavigation.olderGroupIndex);
  }, [input.pastPeriodNavigation.olderGroupIndex, input.selectPastPeriodIndex]);

  const selectNewerPastPeriod = useCallback(() => {
    if (hasNonEmptyText(input.pastPeriodNavigation.newerRoute)) {
      input.router.push(input.pastPeriodNavigation.newerRoute);

      return;
    }

    if (input.pastPeriodNavigation.newerGroupIndex !== null) {
      input.selectPastPeriodIndex(input.pastPeriodNavigation.newerGroupIndex);
    }
  }, [
    input.pastPeriodNavigation.newerGroupIndex,
    input.pastPeriodNavigation.newerRoute,
    input.router,
    input.selectPastPeriodIndex,
  ]);

  const selectRecentPastPeriod = useCallback(() => {
    if (input.pastMeetingGroups.length === 0) {
      return;
    }

    input.selectPastPeriodIndex(0);
  }, [input.pastMeetingGroups.length, input.selectPastPeriodIndex]);

  return { selectOlderPastPeriod, selectNewerPastPeriod, selectRecentPastPeriod };
}

function useWorkspaceHomePastMeetingDeletedHandler(input: {
  workspaceScope: { userId: string | null; workspaceId: string | null };
  sessionUserId: string | undefined;
  sessionWorkspaceId: string | undefined;
  meetingsQueryKey: readonly unknown[];
  queryClient: QueryClient;
  calendarNow: Date;
  pastMeetingSelectionGroupIndex: number;
  isMobile: boolean;
  onMobileReset: () => void;
  router: ReturnType<typeof useRouter>;
  setMeetingsScope: (scope: { userId: string | null; workspaceId: string | null }) => void;
  setMeetings: (meetings: Meeting[]) => void;
  setSelectedPastPeriodIndex: (index: number) => void;
  setSelectedPastMeetingId: (meetingId: string | null) => void;
}) {
  return useCallback(
    (deletedInput: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => {
      applyWorkspacePastMeetingDeletion({
        deletedMeetingId: deletedInput.deletedMeetingId,
        remainingMeetings: deletedInput.remainingMeetings,
        workspaceScope: input.workspaceScope,
        sessionUserId: input.sessionUserId,
        sessionWorkspaceId: input.sessionWorkspaceId,
        meetingsQueryKey: input.meetingsQueryKey,
        queryClient: input.queryClient,
        calendarNow: input.calendarNow,
        pastMeetingSelectionGroupIndex: input.pastMeetingSelectionGroupIndex,
        isMobile: input.isMobile,
        onMobileReset: input.onMobileReset,
        router: input.router,
        setMeetingsScope: input.setMeetingsScope,
        setMeetings: input.setMeetings,
        setSelectedPastPeriodIndex: input.setSelectedPastPeriodIndex,
        setSelectedPastMeetingId: input.setSelectedPastMeetingId,
      });
    },
    [
      input.calendarNow,
      input.isMobile,
      input.meetingsQueryKey,
      input.onMobileReset,
      input.pastMeetingSelectionGroupIndex,
      input.queryClient,
      input.router,
      input.sessionUserId,
      input.sessionWorkspaceId,
      input.setMeetings,
      input.setMeetingsScope,
      input.setSelectedPastMeetingId,
      input.setSelectedPastPeriodIndex,
      input.workspaceScope,
    ],
  );
}

function useWorkspaceHomePastMeetingRemovalActions(input: {
  session: ReturnType<typeof useAuth>["session"];
  pastMeetingRemoveTarget: Meeting | null;
  setPastMeetingRemoveTarget: (meeting: Meeting | null) => void;
  meetingsForDisplay: Meeting[];
  onPastMeetingDeleted: (deletedInput: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  showToast: (toast: ToastInput) => void;
  setError: (message: string | null) => void;
  setMeetingsScope: (scope: { userId: string | null; workspaceId: string | null }) => void;
  setMeetings: (meetings: Meeting[]) => void;
  queryClient: QueryClient;
  meetingsQueryKey: readonly unknown[];
  setSelectedPastMeetingId: (meetingId: string | null) => void;
  router: ReturnType<typeof useRouter>;
}) {
  const requestPastMeetingRemoval = useCallback(
    (meeting: Meeting) => {
      input.setPastMeetingRemoveTarget(meeting);
    },
    [input.setPastMeetingRemoveTarget],
  );

  const confirmPastMeetingRemoval = useCallback(async () => {
    const session = input.session;
    const pastMeetingRemoveTarget = input.pastMeetingRemoveTarget;
    if (session === null || pastMeetingRemoveTarget === null) {
      return;
    }

    const meetingToRemove = pastMeetingRemoveTarget;
    input.setPastMeetingRemoveTarget(null);
    await confirmWorkspacePastMeetingRemoval({
      session,
      meetingToRemove,
      previousMeetings: input.meetingsForDisplay,
      onPastMeetingDeleted: input.onPastMeetingDeleted,
      showToast: input.showToast,
      setError: input.setError,
      setMeetingsScope: input.setMeetingsScope,
      setMeetings: input.setMeetings,
      queryClient: input.queryClient,
      meetingsQueryKey: input.meetingsQueryKey,
      setSelectedPastMeetingId: input.setSelectedPastMeetingId,
      router: input.router,
    });
  }, [
    input.meetingsForDisplay,
    input.meetingsQueryKey,
    input.onPastMeetingDeleted,
    input.pastMeetingRemoveTarget,
    input.queryClient,
    input.router,
    input.session,
    input.setError,
    input.setMeetings,
    input.setMeetingsScope,
    input.setPastMeetingRemoveTarget,
    input.setSelectedPastMeetingId,
    input.showToast,
  ]);

  return { requestPastMeetingRemoval, confirmPastMeetingRemoval };
}

function useWorkspaceHomeUpcomingCalendarNavigation(input: {
  isMobile: boolean;
  onOpenMobileDetail: (detailId: string) => void;
  setManuallySelectedCalendarEventId: (eventId: string | null) => void;
  setSelectedCalendarGroupIndex: (getNextIndex: (current: number) => number) => void;
  selectedCalendarGroupIndexForDisplay: number;
  router: ReturnType<typeof useRouter>;
}) {
  const selectUpcomingCalendarEvent = useCallback(
    (eventId: string) => {
      input.setManuallySelectedCalendarEventId(eventId);
      if (input.isMobile) {
        input.onOpenMobileDetail(eventId);
      }
    },
    [input.isMobile, input.onOpenMobileDetail, input.setManuallySelectedCalendarEventId],
  );

  const selectCalendarGroupIndex = useCallback(
    (getNextIndex: (current: number) => number) => {
      input.setSelectedCalendarGroupIndex(getNextIndex);
      input.setManuallySelectedCalendarEventId(null);
    },
    [input.setSelectedCalendarGroupIndex, input.setManuallySelectedCalendarEventId],
  );

  const selectPreviousCalendarGroup = useCallback(() => {
    const target = getUpcomingPreviousCalendarNavigation(input.selectedCalendarGroupIndexForDisplay);
    if (hasNonEmptyText(target.route)) {
      input.router.push(target.route);

      return;
    }

    selectCalendarGroupIndex(() => target.dayOffset ?? 0);
  }, [input.router, input.selectedCalendarGroupIndexForDisplay, selectCalendarGroupIndex]);

  return { selectUpcomingCalendarEvent, selectCalendarGroupIndex, selectPreviousCalendarGroup };
}

function useWorkspaceHomeUpcomingConnectActions(input: {
  session: ReturnType<typeof useAuth>["session"];
  showToast: (toast: ToastInput) => void;
  queryClient: QueryClient;
  calendarEventsKey: readonly unknown[];
  sessionUserId: string | undefined;
  setConnectingCalendarProvider: (provider: CalendarProvider | null) => void;
}) {
  const refetchCalendarConnection = useCallback(() => {
    void input.queryClient.invalidateQueries({ queryKey: ["agent-settings", input.sessionUserId] });
    void input.queryClient.invalidateQueries({ queryKey: input.calendarEventsKey });
  }, [input.calendarEventsKey, input.queryClient, input.sessionUserId]);

  const startCalendarConnect = useCallback(
    async (provider: CalendarProvider) => {
      const session = input.session;
      if (session === null) {
        return;
      }

      await startWorkspaceCalendarConnect({
        session,
        provider,
        setConnectingCalendarProvider: input.setConnectingCalendarProvider,
        showToast: input.showToast,
      });
    },
    [input.session, input.setConnectingCalendarProvider, input.showToast],
  );

  return { refetchCalendarConnection, startCalendarConnect };
}

function useWorkspaceHomeUpcomingMeetingEventActions(input: {
  session: ReturnType<typeof useAuth>["session"];
  showToast: (toast: ToastInput) => void;
  queryClient: QueryClient;
  calendarEventsKey: readonly unknown[];
  router: ReturnType<typeof useRouter>;
  calendarPrepStartingEventId: string | null;
  setCalendarPrepStartingEventId: (eventId: string | null) => void;
  setStartedCalendarPrepEventIds: (update: (current: Set<string>) => Set<string>) => void;
  setCalendarPrepPlanRequiredEventIds: (update: (current: Set<string>) => Set<string>) => void;
  startCalendarConnect: (provider: CalendarProvider) => Promise<void>;
  setAddingReadyMeetingEventId: (eventId: string | null) => void;
  setRecentlyAddedReadyMeetingEventKey: (key: string | null) => void;
  readyMeetingCopyTimerRef: RefObject<number | null>;
  setCopiedReadyMeetingEventKey: (key: string | null) => void;
}) {
  const runCalendarEventPrep = useCallback(
    async (event: NormalizedCalendarEvent, processor?: CalendarEventPrepProcessor) => {
      const session = input.session;
      if (session === null) {
        return;
      }

      await runWorkspaceCalendarEventPrep({
        session,
        event,
        processor,
        calendarPrepStartingEventId: input.calendarPrepStartingEventId,
        calendarEventsKey: input.calendarEventsKey,
        queryClient: input.queryClient,
        router: input.router,
        showToast: input.showToast,
        setCalendarPrepStartingEventId: input.setCalendarPrepStartingEventId,
        setStartedCalendarPrepEventIds: input.setStartedCalendarPrepEventIds,
        setCalendarPrepPlanRequiredEventIds: input.setCalendarPrepPlanRequiredEventIds,
      });
    },
    [
      input.calendarEventsKey,
      input.calendarPrepStartingEventId,
      input.queryClient,
      input.router,
      input.session,
      input.setCalendarPrepPlanRequiredEventIds,
      input.setCalendarPrepStartingEventId,
      input.setStartedCalendarPrepEventIds,
      input.showToast,
    ],
  );

  const openCalendarPrepUpgrade = useCallback(() => {
    input.router.push("/workspace/settings?tab=billing&upgrade=year");
  }, [input.router]);

  const handleAddReadyMeeting = useCallback(
    async (event: NormalizedCalendarEvent) => {
      const session = input.session;
      if (session === null) {
        return;
      }

      await addReadyMeetingToWorkspaceCalendarEvent({
        session,
        event,
        calendarEventsKey: input.calendarEventsKey,
        queryClient: input.queryClient,
        showToast: input.showToast,
        startGoogleCalendarConnect: () => input.startCalendarConnect("google_calendar"),
        setAddingReadyMeetingEventId: input.setAddingReadyMeetingEventId,
        setRecentlyAddedReadyMeetingEventKey: input.setRecentlyAddedReadyMeetingEventKey,
      });
    },
    [
      input.calendarEventsKey,
      input.queryClient,
      input.session,
      input.setAddingReadyMeetingEventId,
      input.setRecentlyAddedReadyMeetingEventKey,
      input.showToast,
      input.startCalendarConnect,
    ],
  );

  const handleCopyReadyMeetingUrl = useCallback(
    async (event: NormalizedCalendarEvent) => {
      await copyWorkspaceReadyMeetingUrl({
        event,
        showToast: input.showToast,
        readyMeetingCopyTimerRef: input.readyMeetingCopyTimerRef,
        setCopiedReadyMeetingEventKey: input.setCopiedReadyMeetingEventKey,
      });
    },
    [input.readyMeetingCopyTimerRef, input.setCopiedReadyMeetingEventKey, input.showToast],
  );

  return { runCalendarEventPrep, openCalendarPrepUpgrade, handleAddReadyMeeting, handleCopyReadyMeetingUrl };
}

function useWorkspaceHomeSelectionHandlers(input: {
  pastMeetingGroups: PastMeetingGroup[];
  pastPeriodNavigation: {
    olderGroupIndex: number | null;
    newerGroupIndex: number | null;
    newerRoute: string | null;
  };
  router: ReturnType<typeof useRouter>;
  isMobile: boolean;
  onOpenMobileDetail: (detailId: string) => void;
  session: ReturnType<typeof useAuth>["session"];
  queryClient: QueryClient;
  setSelectedPastPeriodIndex: (index: number) => void;
  setSelectedPastMeetingId: (meetingId: string | null) => void;
  setManuallySelectedCalendarEventId: (eventId: string | null) => void;
  setSelectedCalendarGroupIndex: (getNextIndex: (current: number) => number) => void;
  selectedCalendarGroupIndexForDisplay: number;
}) {
  const { selectUpcomingCalendarEvent, selectCalendarGroupIndex, selectPreviousCalendarGroup } =
    useWorkspaceHomeUpcomingCalendarNavigation({
      isMobile: input.isMobile,
      onOpenMobileDetail: input.onOpenMobileDetail,
      setManuallySelectedCalendarEventId: input.setManuallySelectedCalendarEventId,
      setSelectedCalendarGroupIndex: input.setSelectedCalendarGroupIndex,
      selectedCalendarGroupIndexForDisplay: input.selectedCalendarGroupIndexForDisplay,
      router: input.router,
    });

  const { selectPastPeriodIndex, prefetchPastMeeting, selectPastMeeting } = useWorkspaceHomePastMeetingSelection({
    pastMeetingGroups: input.pastMeetingGroups,
    router: input.router,
    isMobile: input.isMobile,
    onOpenMobileDetail: input.onOpenMobileDetail,
    session: input.session,
    queryClient: input.queryClient,
    setSelectedPastPeriodIndex: input.setSelectedPastPeriodIndex,
    setSelectedPastMeetingId: input.setSelectedPastMeetingId,
  });

  const { selectOlderPastPeriod, selectNewerPastPeriod, selectRecentPastPeriod } = useWorkspaceHomePastPeriodNavigation(
    {
      pastMeetingGroups: input.pastMeetingGroups,
      pastPeriodNavigation: input.pastPeriodNavigation,
      router: input.router,
      selectPastPeriodIndex,
    },
  );

  return {
    selectUpcomingCalendarEvent,
    selectCalendarGroupIndex,
    selectPreviousCalendarGroup,
    selectPastPeriodIndex,
    prefetchPastMeeting,
    selectPastMeeting,
    selectOlderPastPeriod,
    selectNewerPastPeriod,
    selectRecentPastPeriod,
  };
}

function useWorkspaceHomeUpcomingActionsPipeline(input: {
  session: ReturnType<typeof useAuth>["session"];
  showToast: (toast: ToastInput) => void;
  queryClient: QueryClient;
  calendarEventsKey: readonly unknown[];
  sessionUserId: string | undefined;
  setConnectingCalendarProvider: (provider: CalendarProvider | null) => void;
  connectedCalendarProviders: CalendarProvider[];
  setIsCalendarProviderPickerOpen: (isOpen: boolean) => void;
  router: ReturnType<typeof useRouter>;
  calendarPrepStartingEventId: string | null;
  setCalendarPrepStartingEventId: (eventId: string | null) => void;
  setStartedCalendarPrepEventIds: (update: (current: Set<string>) => Set<string>) => void;
  setCalendarPrepPlanRequiredEventIds: (update: (current: Set<string>) => Set<string>) => void;
  setAddingReadyMeetingEventId: (eventId: string | null) => void;
  setRecentlyAddedReadyMeetingEventKey: (key: string | null) => void;
  readyMeetingCopyTimerRef: RefObject<number | null>;
  setCopiedReadyMeetingEventKey: (key: string | null) => void;
}) {
  const { refetchCalendarConnection, startCalendarConnect } = useWorkspaceHomeUpcomingConnectActions({
    session: input.session,
    showToast: input.showToast,
    queryClient: input.queryClient,
    calendarEventsKey: input.calendarEventsKey,
    sessionUserId: input.sessionUserId,
    setConnectingCalendarProvider: input.setConnectingCalendarProvider,
  });

  useWorkspaceCalendarOAuthMessages({
    connectedCalendarProviders: input.connectedCalendarProviders,
    refetchCalendarConnection,
    sessionUserId: input.sessionUserId,
    showToast: input.showToast,
    onConnectingCalendarProviderChange: input.setConnectingCalendarProvider,
    onCalendarProviderPickerOpenChange: input.setIsCalendarProviderPickerOpen,
  });

  const { runCalendarEventPrep, openCalendarPrepUpgrade, handleAddReadyMeeting, handleCopyReadyMeetingUrl } =
    useWorkspaceHomeUpcomingMeetingEventActions({
      session: input.session,
      showToast: input.showToast,
      queryClient: input.queryClient,
      calendarEventsKey: input.calendarEventsKey,
      router: input.router,
      calendarPrepStartingEventId: input.calendarPrepStartingEventId,
      setCalendarPrepStartingEventId: input.setCalendarPrepStartingEventId,
      setStartedCalendarPrepEventIds: input.setStartedCalendarPrepEventIds,
      setCalendarPrepPlanRequiredEventIds: input.setCalendarPrepPlanRequiredEventIds,
      startCalendarConnect,
      setAddingReadyMeetingEventId: input.setAddingReadyMeetingEventId,
      setRecentlyAddedReadyMeetingEventKey: input.setRecentlyAddedReadyMeetingEventKey,
      readyMeetingCopyTimerRef: input.readyMeetingCopyTimerRef,
      setCopiedReadyMeetingEventKey: input.setCopiedReadyMeetingEventKey,
    });

  return {
    startCalendarConnect,
    runCalendarEventPrep,
    openCalendarPrepUpgrade,
    handleAddReadyMeeting,
    handleCopyReadyMeetingUrl,
  };
}

function useWorkspaceHomePastMeetingRemovalController(input: {
  view: "past" | "upcoming";
  initialMeetingId: string | null;
  session: ReturnType<typeof useAuth>["session"];
  sessionUserId: string | undefined;
  sessionWorkspaceId: string | undefined;
  showToast: (toast: ToastInput) => void;
  workspaceScope: { userId: string | null; workspaceId: string | null };
  meetingsQueryKey: readonly unknown[];
  queryClient: QueryClient;
  calendarNow: Date;
  pastMeetingSelectionGroupIndex: number;
  mobileNavigation: { isMobile: boolean; reset: () => void };
  isMobileDetailOpen: boolean;
  router: ReturnType<typeof useRouter>;
  setMeetingsScope: (scope: { userId: string | null; workspaceId: string | null }) => void;
  setMeetings: (meetings: Meeting[]) => void;
  setSelectedPastPeriodIndex: (index: number) => void;
  setSelectedPastMeetingId: (meetingId: string | null) => void;
  pastMeetingRemoveTarget: Meeting | null;
  setPastMeetingRemoveTarget: (meeting: Meeting | null) => void;
  meetingsForDisplay: Meeting[];
  setError: (message: string | null) => void;
  selectedPastMeetingForDisplay: Meeting | null;
}) {
  const onPastMeetingDeleted = useWorkspaceHomePastMeetingDeletedHandler({
    workspaceScope: input.workspaceScope,
    sessionUserId: input.sessionUserId,
    sessionWorkspaceId: input.sessionWorkspaceId,
    meetingsQueryKey: input.meetingsQueryKey,
    queryClient: input.queryClient,
    calendarNow: input.calendarNow,
    pastMeetingSelectionGroupIndex: input.pastMeetingSelectionGroupIndex,
    isMobile: input.mobileNavigation.isMobile,
    onMobileReset: input.mobileNavigation.reset,
    router: input.router,
    setMeetingsScope: input.setMeetingsScope,
    setMeetings: input.setMeetings,
    setSelectedPastPeriodIndex: input.setSelectedPastPeriodIndex,
    setSelectedPastMeetingId: input.setSelectedPastMeetingId,
  });

  const { requestPastMeetingRemoval, confirmPastMeetingRemoval } = useWorkspaceHomePastMeetingRemovalActions({
    session: input.session,
    pastMeetingRemoveTarget: input.pastMeetingRemoveTarget,
    setPastMeetingRemoveTarget: input.setPastMeetingRemoveTarget,
    meetingsForDisplay: input.meetingsForDisplay,
    onPastMeetingDeleted,
    showToast: input.showToast,
    setError: input.setError,
    setMeetingsScope: input.setMeetingsScope,
    setMeetings: input.setMeetings,
    queryClient: input.queryClient,
    meetingsQueryKey: input.meetingsQueryKey,
    setSelectedPastMeetingId: input.setSelectedPastMeetingId,
    router: input.router,
  });

  useWorkspacePastMeetingDeleteShortcut({
    view: input.view,
    isMobile: input.mobileNavigation.isMobile,
    isMobileDetailOpen: input.isMobileDetailOpen,
    pastMeetingRemoveTarget: input.pastMeetingRemoveTarget,
    selectedPastMeetingForDisplay: input.selectedPastMeetingForDisplay,
    onRequestPastMeetingRemoval: requestPastMeetingRemoval,
  });

  useWorkspacePastViewInitialMeetingId({
    view: input.view,
    initialMeetingId: input.initialMeetingId,
    setSelectedPastMeetingId: input.setSelectedPastMeetingId,
  });

  return { onPastMeetingDeleted, requestPastMeetingRemoval, confirmPastMeetingRemoval };
}

function useWorkspaceHomeCalendarRemovalAndPersistence(input: {
  view: "past" | "upcoming";
  isUpcomingView: boolean;
  session: ReturnType<typeof useAuth>["session"];
  sessionUserId: string | undefined;
  showToast: (toast: ToastInput) => void;
  mobileNavigation: { isMobile: boolean };
  isMobileDetailOpen: boolean;
  setError: (message: string | null) => void;
  calendarEventDeleteTarget: NormalizedCalendarEvent | null;
  setCalendarEventDeleteTarget: (event: NormalizedCalendarEvent | null) => void;
  setCalendarEventDeleteError: (error: string | null) => void;
  calendarEventsKey: readonly unknown[];
  calendarGroupEvents: NormalizedCalendarEvent[];
  queryClient: QueryClient;
  setManuallySelectedCalendarEventId: (eventId: string | null) => void;
  selectedCalendarEvent: NormalizedCalendarEvent | null;
  calendarEventsQuery: { data: CalendarEventsResponse | undefined; isSuccess: boolean };
  agentSettingsQuery: Pick<ReturnType<typeof useWorkspaceHomeAgentSettingsQuery>, "data" | "isSuccess">;
}) {
  const { requestCalendarEventDeletion, confirmCalendarEventDeletion } = useWorkspaceHomeCalendarEventDeletion({
    session: input.session,
    showToast: input.showToast,
    calendarEventDeleteTarget: input.calendarEventDeleteTarget,
    setCalendarEventDeleteTarget: input.setCalendarEventDeleteTarget,
    setCalendarEventDeleteError: input.setCalendarEventDeleteError,
    calendarEventsKey: input.calendarEventsKey,
    calendarGroupEvents: input.calendarGroupEvents,
    queryClient: input.queryClient,
    setError: input.setError,
    setManuallySelectedCalendarEventId: input.setManuallySelectedCalendarEventId,
  });

  useWorkspaceUpcomingCalendarDeleteShortcut({
    view: input.view,
    isMobile: input.mobileNavigation.isMobile,
    isMobileDetailOpen: input.isMobileDetailOpen,
    calendarEventDeleteTarget: input.calendarEventDeleteTarget,
    selectedCalendarEvent: input.selectedCalendarEvent,
    onRequestCalendarEventDeletion: requestCalendarEventDeletion,
  });

  useWorkspaceConnectionProviderCachePersistence({
    isUpcomingView: input.isUpcomingView,
    sessionUserId: input.sessionUserId,
    calendarEventsData: input.calendarEventsQuery.data,
    isCalendarEventsSuccess: input.calendarEventsQuery.isSuccess,
    agentSettingsData: input.agentSettingsQuery.data,
    isAgentSettingsSuccess: input.agentSettingsQuery.isSuccess,
  });

  return { confirmCalendarEventDeletion };
}

function useWorkspaceHomeLocalState(input: {
  initialMeetingId: string | null;
  sessionUserId: string | undefined;
  sessionWorkspaceId: string | undefined;
  workspaceScope: { userId: string | null; workspaceId: string | null };
}) {
  const queryClient = useQueryClient();
  const [meetings, setMeetings] = useState<Meeting[]>(
    () =>
      queryClient.getQueryData<Meeting[]>(
        workspaceMeetingsQueryKey({ id: input.sessionUserId, workspaceId: input.sessionWorkspaceId }),
      ) ??
      getCachedWorkspaceMeetings(input.sessionUserId, input.sessionWorkspaceId) ??
      [],
  );
  const [meetingsScope, setMeetingsScope] = useState(input.workspaceScope);
  const [error, setError] = useState<string | null>(null);
  const [isCalendarProviderPickerOpen, setIsCalendarProviderPickerOpen] = useState(false);
  const [connectingCalendarProvider, setConnectingCalendarProvider] = useState<CalendarProvider | null>(null);
  const [manuallySelectedCalendarEventId, setManuallySelectedCalendarEventId] = useState<string | null>(null);
  const [selectedCalendarGroupIndex, setSelectedCalendarGroupIndex] = useState(0);
  const [selectedPastMeetingId, setSelectedPastMeetingId] = useState<string | null>(input.initialMeetingId);
  const [readyPastMeetingId, setReadyPastMeetingId] = useState<string | null>(null);
  const [pastMeetingLoadFailure, setPastMeetingLoadFailure] = useState<MeetingLoadFailure | null>(null);
  const [selectedPastPeriodIndex, setSelectedPastPeriodIndex] = useState(0);
  const [pastMeetingRemoveTarget, setPastMeetingRemoveTarget] = useState<Meeting | null>(null);
  const [calendarEventDeleteTarget, setCalendarEventDeleteTarget] = useState<NormalizedCalendarEvent | null>(null);
  const [calendarEventDeleteError, setCalendarEventDeleteError] = useState<string | null>(null);
  const [addingReadyMeetingEventId, setAddingReadyMeetingEventId] = useState<string | null>(null);
  const [calendarPrepStartingEventId, setCalendarPrepStartingEventId] = useState<string | null>(null);
  const [startedCalendarPrepEventIds, setStartedCalendarPrepEventIds] = useState<Set<string>>(() => new Set());
  const [calendarPrepPlanRequiredEventIds, setCalendarPrepPlanRequiredEventIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [recentlyAddedReadyMeetingEventKey, setRecentlyAddedReadyMeetingEventKey] = useState<string | null>(null);
  const [copiedReadyMeetingEventKey, setCopiedReadyMeetingEventKey] = useState<string | null>(null);
  const calendarProviderPickerRef = useRef<HTMLDivElement | null>(null);
  const readyMeetingCopyTimerRef = useRef<number | null>(null);

  return {
    meetings,
    setMeetings,
    meetingsScope,
    setMeetingsScope,
    error,
    setError,
    isCalendarProviderPickerOpen,
    setIsCalendarProviderPickerOpen,
    connectingCalendarProvider,
    setConnectingCalendarProvider,
    manuallySelectedCalendarEventId,
    setManuallySelectedCalendarEventId,
    selectedCalendarGroupIndex,
    setSelectedCalendarGroupIndex,
    selectedPastMeetingId,
    setSelectedPastMeetingId,
    readyPastMeetingId,
    setReadyPastMeetingId,
    pastMeetingLoadFailure,
    setPastMeetingLoadFailure,
    selectedPastPeriodIndex,
    setSelectedPastPeriodIndex,
    pastMeetingRemoveTarget,
    setPastMeetingRemoveTarget,
    calendarEventDeleteTarget,
    setCalendarEventDeleteTarget,
    calendarEventDeleteError,
    setCalendarEventDeleteError,
    addingReadyMeetingEventId,
    setAddingReadyMeetingEventId,
    calendarPrepStartingEventId,
    setCalendarPrepStartingEventId,
    startedCalendarPrepEventIds,
    setStartedCalendarPrepEventIds,
    calendarPrepPlanRequiredEventIds,
    setCalendarPrepPlanRequiredEventIds,
    recentlyAddedReadyMeetingEventKey,
    setRecentlyAddedReadyMeetingEventKey,
    copiedReadyMeetingEventKey,
    setCopiedReadyMeetingEventKey,
    calendarProviderPickerRef,
    readyMeetingCopyTimerRef,
  };
}

function useWorkspaceHomeMeetingListAndPastDisplay(input: {
  calendarEventsQuery: { isSuccess: boolean; data: CalendarEventsResponse | undefined };
  agentSettingsQuery: Pick<ReturnType<typeof useWorkspaceHomeAgentSettingsQuery>, "data">;
  cachedCalendarProviders: CalendarProvider[] | null;
  isUpcomingView: boolean;
  meetingsScope: { userId: string | null; workspaceId: string | null };
  workspaceScope: { userId: string | null; workspaceId: string | null };
  meetingsQuery: { data: Meeting[] | undefined; isSuccess: boolean; isFetching: boolean };
  meetings: Meeting[];
  isRestoringQueryCache: boolean;
  calendarNowInput: { selectedPastMeetingId: string | null; selectedPastPeriodIndex: number };
  mobileNavigation: { isMobile: boolean; detailId: string | null };
}) {
  const connectedCalendarProviders = useMemo(
    () =>
      computeConnectedCalendarProviders({
        isCalendarEventsSuccess: input.calendarEventsQuery.isSuccess,
        calendarEventsData: input.calendarEventsQuery.data,
        cachedCalendarProviders: input.cachedCalendarProviders,
        agentSettingsConnectors: input.agentSettingsQuery.data?.connectors,
      }),
    [
      input.agentSettingsQuery.data?.connectors,
      input.cachedCalendarProviders,
      input.calendarEventsQuery.data,
      input.calendarEventsQuery.isSuccess,
    ],
  );
  const hasConnectedCalendar = connectedCalendarProviders.length !== 0;
  const calendarNow = useWorkspaceCalendarNow({ isUpcomingView: input.isUpcomingView, hasConnectedCalendar });

  const { meetingsForDisplay, isMeetingListResolving } = getWorkspaceMeetingsListState({
    meetingsScope: input.meetingsScope,
    workspaceScope: input.workspaceScope,
    meetingsQueryData: input.meetingsQuery.data,
    meetings: input.meetings,
    isRestoringQueryCache: input.isRestoringQueryCache,
    isMeetingsQueryFetching: input.meetingsQuery.isFetching,
  });
  const pastMeetingsDisplay = useWorkspaceHomePastMeetingsDisplay({
    meetingsForDisplay,
    calendarNow,
    selectedPastMeetingId: input.calendarNowInput.selectedPastMeetingId,
    selectedPastPeriodIndex: input.calendarNowInput.selectedPastPeriodIndex,
    isMeetingListResolving,
    isMeetingsQuerySuccess: input.meetingsQuery.isSuccess,
    isMobile: input.mobileNavigation.isMobile,
    mobileDetailId: input.mobileNavigation.detailId,
  });

  return {
    connectedCalendarProviders,
    hasConnectedCalendar,
    calendarNow,
    meetingsForDisplay,
    isMeetingListResolving,
    pastMeetingGroups: pastMeetingsDisplay.pastMeetingGroups,
    shouldShowPastMeetingsLoading: pastMeetingsDisplay.shouldShowPastMeetingsLoading,
    shouldShowPastMeetingsPlaceholder: pastMeetingsDisplay.shouldShowPastMeetingsPlaceholder,
    pastMeetingSelection: pastMeetingsDisplay.pastMeetingSelection,
    selectedPastMeetingGroup: pastMeetingsDisplay.selectedPastMeetingGroup,
    selectedPastMeetingIdForDisplay: pastMeetingsDisplay.selectedPastMeetingIdForDisplay,
    selectedPastMeetingForDisplay: pastMeetingsDisplay.selectedPastMeetingForDisplay,
    pastDetailMeetingId: pastMeetingsDisplay.pastDetailMeetingId,
    pastPeriodNavigation: pastMeetingsDisplay.pastPeriodNavigation,
    shouldShowPastRecentButton: pastMeetingsDisplay.shouldShowPastRecentButton,
  };
}

function useWorkspaceHomeUpcomingMeetingDisplay(input: {
  view: "past" | "upcoming";
  session: ReturnType<typeof useAuth>["session"];
  meetingsForDisplay: Meeting[];
  hasConnectedCalendar: boolean;
  calendarEventsQuery: {
    isSuccess: boolean;
    isError: boolean;
    isFetching: boolean;
    data: CalendarEventsResponse | undefined;
  };
  agentSettingsQuery: { isSuccess: boolean; isFetching: boolean };
  cachedCalendarProviders: CalendarProvider[] | null;
  isRestoringQueryCache: boolean;
  calendarNow: Date;
  selectedCalendarGroupIndex: number;
  manuallySelectedCalendarEventId: string | null;
  mobileNavigation: { isMobile: boolean; detailId: string | null };
}) {
  const firstName = getFirstName({
    displayName: input.session?.user.displayName,
    email: input.session?.user.email,
  });
  const hasCalendarEventsResult = input.calendarEventsQuery.isSuccess;
  const hasAgentSettingsResult = input.agentSettingsQuery.isSuccess;
  const hasCachedCalendarAvailability = input.cachedCalendarProviders !== null;
  const { shouldShowUpcomingCalendarSurface, shouldHoldUpcomingCalendarContent } =
    getWorkspaceHomeUpcomingCalendarContentState({
      view: input.view,
      hasConnectedCalendar: input.hasConnectedCalendar,
      hasCalendarEventsResult,
      hasAgentSettingsResult,
      hasCachedCalendarAvailability,
      isCalendarEventsError: input.calendarEventsQuery.isError,
      isRestoringQueryCache: input.isRestoringQueryCache,
      isCalendarEventsFetching: input.calendarEventsQuery.isFetching,
      isAgentSettingsFetching: input.agentSettingsQuery.isFetching,
      calendarEventsData: input.calendarEventsQuery.data,
    });

  const upcomingCalendarSelection = useWorkspaceHomeUpcomingCalendarSelection({
    calendarEventsQueryData: input.calendarEventsQuery.data,
    calendarNow: input.calendarNow,
    selectedCalendarGroupIndex: input.selectedCalendarGroupIndex,
    manuallySelectedCalendarEventId: input.manuallySelectedCalendarEventId,
    isMobile: input.mobileNavigation.isMobile,
    mobileDetailId: input.mobileNavigation.detailId,
    hasConnectedCalendar: input.hasConnectedCalendar,
    hasCalendarEventsResult,
  });
  const { hasCompletedAgentIntroSetup, shouldShowAgentIntroCta, setupDoneCount } = getWorkspaceUpcomingSetupProgress({
    session: input.session,
    meetingsForDisplay: input.meetingsForDisplay,
    hasConnectedCalendar: input.hasConnectedCalendar,
  });

  return {
    firstName,
    shouldShowUpcomingCalendarSurface,
    shouldHoldUpcomingCalendarContent,
    shouldShowNoUpcomingMeetings: upcomingCalendarSelection.shouldShowNoUpcomingMeetings,
    selectedCalendarGroupIndexForDisplay: upcomingCalendarSelection.selectedCalendarGroupIndexForDisplay,
    selectedCalendarEventGroup: upcomingCalendarSelection.selectedCalendarEventGroup,
    selectedCalendarEventGroupLabel: upcomingCalendarSelection.selectedCalendarEventGroupLabel,
    calendarGroupEvents: upcomingCalendarSelection.calendarGroupEvents,
    selectedCalendarEvent: upcomingCalendarSelection.selectedCalendarEvent,
    selectedCalendarEventId: upcomingCalendarSelection.selectedCalendarEventId,
    calendarPrepSummaries: upcomingCalendarSelection.calendarPrepSummaries,
    calendarPrepAccess: upcomingCalendarSelection.calendarPrepAccess,
    calendarEventGroups: upcomingCalendarSelection.calendarEventGroups,
    hasCompletedAgentIntroSetup,
    shouldShowAgentIntroCta,
    setupDoneCount,
  };
}

function useWorkspaceHomeSessionBootstrap(input: { initialMeetingId: string | null; view: "past" | "upcoming" }) {
  const mobileNavigation = useMobileMeetingNavigation({ view: input.view, initialMeetingId: input.initialMeetingId });
  const isMobileDetailOpen = mobileNavigation.isMobile && mobileNavigation.isOpen;
  const isUpcomingView = input.view === "upcoming";
  const pastMeetingDetailPaneRef = useRef<HTMLDivElement | null>(null);
  const pastMeetingDetailOverlayRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const { session } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const isRestoringQueryCache = useIsRestoring();
  const meetingsQueryKey = useMemo(
    () => workspaceMeetingsQueryKey({ id: session?.user.id, workspaceId: session?.user.workspaceId }),
    [session?.user.id, session?.user.workspaceId],
  );
  const workspaceScope = useMemo(
    () => ({
      userId: session?.user.id ?? null,
      workspaceId: session?.user.workspaceId ?? null,
    }),
    [session?.user.id, session?.user.workspaceId],
  );
  const workspaceScopeRef = useRef(workspaceScope);
  useLayoutEffect(() => {
    workspaceScopeRef.current = workspaceScope;
  });
  const previousWorkspaceScopeRef = useRef(workspaceScope);
  const calendarEventsKey = useMemo(() => calendarEventsQueryKey(session?.user.id), [session?.user.id]);
  const localState = useWorkspaceHomeLocalState({
    initialMeetingId: input.initialMeetingId,
    sessionUserId: session?.user.id,
    sessionWorkspaceId: session?.user.workspaceId,
    workspaceScope,
  });
  const cachedCalendarProviders = useWorkspaceCachedCalendarProviders(session?.user.id);
  const meetingsQuery = useWorkspaceHomeMeetingsQuery(session);
  const agentSettingsQuery = useWorkspaceHomeAgentSettingsQuery({
    session,
    isUpcomingView,
  });
  const calendarEventsQuery = useWorkspaceHomeCalendarEventsQuery({
    session,
    calendarEventsKey,
    queryClient,
    isUpcomingView,
  });

  return {
    mobileNavigation,
    isMobileDetailOpen,
    isUpcomingView,
    pastMeetingDetailPaneRef,
    pastMeetingDetailOverlayRef,
    router,
    session,
    showToast,
    queryClient,
    isRestoringQueryCache,
    meetingsQueryKey,
    workspaceScope,
    workspaceScopeRef,
    previousWorkspaceScopeRef,
    calendarEventsKey,
    localState,
    cachedCalendarProviders,
    meetingsQuery,
    agentSettingsQuery,
    calendarEventsQuery,
  };
}

function useWorkspaceHomeMeetingsLifecycle(input: {
  session: ReturnType<typeof useAuth>["session"];
  isUpcomingView: boolean;
  meetingsQueryKey: readonly [string, string | undefined, string | undefined];
  queryClient: QueryClient;
  workspaceScope: { userId: string | null; workspaceId: string | null };
  workspaceScopeRef: RefObject<{ userId: string | null; workspaceId: string | null }>;
  previousWorkspaceScopeRef: RefObject<{ userId: string | null; workspaceId: string | null }>;
  meetingsQuery: ReturnType<typeof useWorkspaceHomeMeetingsQuery>;
  mobileNavigation: ReturnType<typeof useMobileMeetingNavigation>;
  localState: ReturnType<typeof useWorkspaceHomeLocalState>;
}) {
  const { localState } = input;
  useCalendarRealtime({
    workspaceId: input.session?.user.workspaceId,
    userId: input.session?.user.id,
    /** @external useCalendarRealtime wire */
    isEnabled: input.isUpcomingView,
  });

  const resetWorkspaceScopeNavigation = useCallback(() => {
    input.mobileNavigation.reset();
    localState.setSelectedPastMeetingId(null);
    localState.setSelectedPastPeriodIndex(0);
    localState.setPastMeetingRemoveTarget(null);
  }, [input.mobileNavigation.reset, localState]);

  useSyncWorkspaceMeetingsOnScopeChange({
    sessionUserId: input.session?.user.id,
    sessionWorkspaceId: input.session?.user.workspaceId,
    workspaceScope: input.workspaceScope,
    previousWorkspaceScopeRef: input.previousWorkspaceScopeRef,
    onWorkspaceScopeMeetingsReset: resetWorkspaceScopeNavigation,
    setMeetingsScope: localState.setMeetingsScope,
    setMeetings: localState.setMeetings,
  });

  useWorkspaceMeetingsRefresh({
    session: input.session,
    meetingsQueryKey: input.meetingsQueryKey,
    queryClient: input.queryClient,
    workspaceScope: input.workspaceScope,
    workspaceScopeRef: input.workspaceScopeRef,
    meetingsQueryData: input.meetingsQuery.data,
    sessionUserId: input.session?.user.id,
    sessionWorkspaceId: input.session?.user.workspaceId,
    setMeetingsScope: localState.setMeetingsScope,
    setMeetings: localState.setMeetings,
    setError: localState.setError,
  });

  const dismissCalendarProviderPicker = useCallback(() => {
    localState.setIsCalendarProviderPickerOpen(false);
  }, [localState]);
  useDismissOnOutsidePointer({
    isActive: localState.isCalendarProviderPickerOpen,
    containerRef: localState.calendarProviderPickerRef,
    onDismiss: dismissCalendarProviderPicker,
  });
}

function useWorkspaceHomeMeetingViews(input: {
  view: "past" | "upcoming";
  session: ReturnType<typeof useAuth>["session"];
  isUpcomingView: boolean;
  isRestoringQueryCache: boolean;
  calendarEventsQuery: ReturnType<typeof useWorkspaceHomeCalendarEventsQuery>;
  agentSettingsQuery: ReturnType<typeof useWorkspaceHomeAgentSettingsQuery>;
  cachedCalendarProviders: CalendarProvider[] | null;
  meetingsScope: { userId: string | null; workspaceId: string | null };
  workspaceScope: { userId: string | null; workspaceId: string | null };
  meetingsQuery: ReturnType<typeof useWorkspaceHomeMeetingsQuery>;
  localState: ReturnType<typeof useWorkspaceHomeLocalState>;
  mobileNavigation: ReturnType<typeof useMobileMeetingNavigation>;
}) {
  const pastDisplay = useWorkspaceHomeMeetingListAndPastDisplay({
    calendarEventsQuery: input.calendarEventsQuery,
    agentSettingsQuery: input.agentSettingsQuery,
    cachedCalendarProviders: input.cachedCalendarProviders,
    isUpcomingView: input.isUpcomingView,
    meetingsScope: input.meetingsScope,
    workspaceScope: input.workspaceScope,
    meetingsQuery: input.meetingsQuery,
    meetings: input.localState.meetings,
    isRestoringQueryCache: input.isRestoringQueryCache,
    calendarNowInput: {
      selectedPastMeetingId: input.localState.selectedPastMeetingId,
      selectedPastPeriodIndex: input.localState.selectedPastPeriodIndex,
    },
    mobileNavigation: input.mobileNavigation,
  });
  const upcomingDisplay = useWorkspaceHomeUpcomingMeetingDisplay({
    view: input.view,
    session: input.session,
    meetingsForDisplay: pastDisplay.meetingsForDisplay,
    hasConnectedCalendar: pastDisplay.hasConnectedCalendar,
    calendarEventsQuery: input.calendarEventsQuery,
    agentSettingsQuery: input.agentSettingsQuery,
    cachedCalendarProviders: input.cachedCalendarProviders,
    isRestoringQueryCache: input.isRestoringQueryCache,
    calendarNow: pastDisplay.calendarNow,
    selectedCalendarGroupIndex: input.localState.selectedCalendarGroupIndex,
    manuallySelectedCalendarEventId: input.localState.manuallySelectedCalendarEventId,
    mobileNavigation: input.mobileNavigation,
  });
  useWorkspaceReadyMeetingCopyTimerCleanup(input.localState.readyMeetingCopyTimerRef);

  return { pastDisplay, upcomingDisplay };
}

function useWorkspaceHomePageInteractions(input: {
  view: "past" | "upcoming";
  initialMeetingId: string | null;
  session: ReturnType<typeof useAuth>["session"];
  showToast: (toast: ToastInput) => void;
  queryClient: QueryClient;
  router: ReturnType<typeof useRouter>;
  meetingsQueryKey: readonly [string, string | undefined, string | undefined];
  workspaceScope: { userId: string | null; workspaceId: string | null };
  calendarEventsKey: ReturnType<typeof calendarEventsQueryKey>;
  isUpcomingView: boolean;
  isMobileDetailOpen: boolean;
  mobileNavigation: ReturnType<typeof useMobileMeetingNavigation>;
  localState: ReturnType<typeof useWorkspaceHomeLocalState>;
  meetingViews: ReturnType<typeof useWorkspaceHomeMeetingViews>;
  calendarEventsQuery: ReturnType<typeof useWorkspaceHomeCalendarEventsQuery>;
  agentSettingsQuery: ReturnType<typeof useWorkspaceHomeAgentSettingsQuery>;
}) {
  const { localState, meetingViews } = input;
  const { pastDisplay, upcomingDisplay } = meetingViews;

  const selectionHandlers = useWorkspaceHomeSelectionHandlers({
    pastMeetingGroups: pastDisplay.pastMeetingGroups,
    pastPeriodNavigation: pastDisplay.pastPeriodNavigation,
    router: input.router,
    isMobile: input.mobileNavigation.isMobile,
    onOpenMobileDetail: input.mobileNavigation.open,
    session: input.session,
    queryClient: input.queryClient,
    setSelectedPastPeriodIndex: localState.setSelectedPastPeriodIndex,
    setSelectedPastMeetingId: localState.setSelectedPastMeetingId,
    setManuallySelectedCalendarEventId: localState.setManuallySelectedCalendarEventId,
    setSelectedCalendarGroupIndex: localState.setSelectedCalendarGroupIndex,
    selectedCalendarGroupIndexForDisplay: upcomingDisplay.selectedCalendarGroupIndexForDisplay,
  });

  const removalInteractions = useWorkspaceHomeRemovalInteractions({
    view: input.view,
    initialMeetingId: input.initialMeetingId,
    session: input.session,
    showToast: input.showToast,
    queryClient: input.queryClient,
    router: input.router,
    meetingsQueryKey: input.meetingsQueryKey,
    workspaceScope: input.workspaceScope,
    calendarEventsKey: input.calendarEventsKey,
    isUpcomingView: input.isUpcomingView,
    isMobileDetailOpen: input.isMobileDetailOpen,
    mobileNavigation: input.mobileNavigation,
    localState,
    pastDisplay,
    upcomingDisplay,
    calendarEventsQuery: input.calendarEventsQuery,
    agentSettingsQuery: input.agentSettingsQuery,
  });

  const upcomingActions = useWorkspaceHomeUpcomingActionsPipeline({
    session: input.session,
    showToast: input.showToast,
    queryClient: input.queryClient,
    calendarEventsKey: input.calendarEventsKey,
    sessionUserId: input.session?.user.id,
    setConnectingCalendarProvider: localState.setConnectingCalendarProvider,
    connectedCalendarProviders: pastDisplay.connectedCalendarProviders,
    setIsCalendarProviderPickerOpen: localState.setIsCalendarProviderPickerOpen,
    router: input.router,
    calendarPrepStartingEventId: localState.calendarPrepStartingEventId,
    setCalendarPrepStartingEventId: localState.setCalendarPrepStartingEventId,
    setStartedCalendarPrepEventIds: localState.setStartedCalendarPrepEventIds,
    setCalendarPrepPlanRequiredEventIds: localState.setCalendarPrepPlanRequiredEventIds,
    setAddingReadyMeetingEventId: localState.setAddingReadyMeetingEventId,
    setRecentlyAddedReadyMeetingEventKey: localState.setRecentlyAddedReadyMeetingEventKey,
    readyMeetingCopyTimerRef: localState.readyMeetingCopyTimerRef,
    setCopiedReadyMeetingEventKey: localState.setCopiedReadyMeetingEventKey,
  });

  return { selectionHandlers, removalInteractions, upcomingActions };
}

function useWorkspaceHomeRemovalInteractions(input: {
  view: "past" | "upcoming";
  initialMeetingId: string | null;
  session: ReturnType<typeof useAuth>["session"];
  showToast: (toast: ToastInput) => void;
  queryClient: QueryClient;
  router: ReturnType<typeof useRouter>;
  meetingsQueryKey: readonly [string, string | undefined, string | undefined];
  workspaceScope: { userId: string | null; workspaceId: string | null };
  calendarEventsKey: ReturnType<typeof calendarEventsQueryKey>;
  isUpcomingView: boolean;
  isMobileDetailOpen: boolean;
  mobileNavigation: ReturnType<typeof useMobileMeetingNavigation>;
  localState: ReturnType<typeof useWorkspaceHomeLocalState>;
  pastDisplay: ReturnType<typeof useWorkspaceHomeMeetingListAndPastDisplay>;
  upcomingDisplay: ReturnType<typeof useWorkspaceHomeUpcomingMeetingDisplay>;
  calendarEventsQuery: ReturnType<typeof useWorkspaceHomeCalendarEventsQuery>;
  agentSettingsQuery: ReturnType<typeof useWorkspaceHomeAgentSettingsQuery>;
}) {
  const pastMeetingRemoval = useWorkspaceHomePastMeetingRemovalController({
    view: input.view,
    initialMeetingId: input.initialMeetingId,
    session: input.session,
    sessionUserId: input.session?.user.id,
    sessionWorkspaceId: input.session?.user.workspaceId,
    showToast: input.showToast,
    workspaceScope: input.workspaceScope,
    meetingsQueryKey: input.meetingsQueryKey,
    queryClient: input.queryClient,
    calendarNow: input.pastDisplay.calendarNow,
    pastMeetingSelectionGroupIndex: input.pastDisplay.pastMeetingSelection.groupIndex,
    mobileNavigation: input.mobileNavigation,
    isMobileDetailOpen: input.isMobileDetailOpen,
    router: input.router,
    setMeetingsScope: input.localState.setMeetingsScope,
    setMeetings: input.localState.setMeetings,
    setSelectedPastPeriodIndex: input.localState.setSelectedPastPeriodIndex,
    setSelectedPastMeetingId: input.localState.setSelectedPastMeetingId,
    pastMeetingRemoveTarget: input.localState.pastMeetingRemoveTarget,
    setPastMeetingRemoveTarget: input.localState.setPastMeetingRemoveTarget,
    meetingsForDisplay: input.pastDisplay.meetingsForDisplay,
    setError: input.localState.setError,
    selectedPastMeetingForDisplay: input.pastDisplay.selectedPastMeetingForDisplay,
  });

  const calendarRemoval = useWorkspaceHomeCalendarRemovalAndPersistence({
    view: input.view,
    isUpcomingView: input.isUpcomingView,
    session: input.session,
    sessionUserId: input.session?.user.id,
    showToast: input.showToast,
    mobileNavigation: input.mobileNavigation,
    isMobileDetailOpen: input.isMobileDetailOpen,
    setError: input.localState.setError,
    calendarEventDeleteTarget: input.localState.calendarEventDeleteTarget,
    setCalendarEventDeleteTarget: input.localState.setCalendarEventDeleteTarget,
    setCalendarEventDeleteError: input.localState.setCalendarEventDeleteError,
    calendarEventsKey: input.calendarEventsKey,
    calendarGroupEvents: input.upcomingDisplay.calendarGroupEvents,
    queryClient: input.queryClient,
    setManuallySelectedCalendarEventId: input.localState.setManuallySelectedCalendarEventId,
    selectedCalendarEvent: input.upcomingDisplay.selectedCalendarEvent,
    calendarEventsQuery: input.calendarEventsQuery,
    agentSettingsQuery: input.agentSettingsQuery,
  });

  return { pastMeetingRemoval, calendarRemoval };
}

function buildWorkspaceHomeShellUpcomingBranchInput(input: {
  view: "past" | "upcoming";
  bootstrap: ReturnType<typeof useWorkspaceHomeSessionBootstrap>;
  meetingViews: ReturnType<typeof useWorkspaceHomeMeetingViews>;
  pageInteractions: ReturnType<typeof useWorkspaceHomePageInteractions>;
}): Parameters<typeof WorkspaceHomeUpcomingShellBranch>[0] {
  const { bootstrap, meetingViews, pageInteractions } = input;
  const { localState } = bootstrap;
  const { pastDisplay, upcomingDisplay } = meetingViews;
  const { selectionHandlers, upcomingActions } = pageInteractions;
  const isUpcomingView = bootstrap.isUpcomingView;

  return {
    view: input.view,
    shouldShowUpcomingCalendarSurface: upcomingDisplay.shouldShowUpcomingCalendarSurface,
    isCalendarEventsError: bootstrap.calendarEventsQuery.isError,
    shouldHoldUpcomingCalendarContent: upcomingDisplay.shouldHoldUpcomingCalendarContent,
    shouldShowNoUpcomingMeetings: upcomingDisplay.shouldShowNoUpcomingMeetings,
    isMobileDetailOpen: bootstrap.isMobileDetailOpen,
    selectedCalendarGroupIndexForDisplay: upcomingDisplay.selectedCalendarGroupIndexForDisplay,
    calendarEventGroupsLength: upcomingDisplay.calendarEventGroups.length,
    onSelectCalendarGroupIndex: selectionHandlers.selectCalendarGroupIndex,
    onSelectPreviousCalendarGroup: selectionHandlers.selectPreviousCalendarGroup,
    onSelectUpcomingCalendarEvent: selectionHandlers.selectUpcomingCalendarEvent,
    selectedCalendarEventGroupLabel: upcomingDisplay.selectedCalendarEventGroupLabel,
    calendarGroupEvents: upcomingDisplay.calendarGroupEvents,
    selectedCalendarEventGroupKind: upcomingDisplay.selectedCalendarEventGroup?.kind,
    selectedCalendarEventId: upcomingDisplay.selectedCalendarEventId,
    isMobile: bootstrap.mobileNavigation.isMobile,
    mobileBackButtonRef: bootstrap.mobileNavigation.backButton,
    onMobileBack: bootstrap.mobileNavigation.close,
    selectedCalendarEvent: upcomingDisplay.selectedCalendarEvent,
    briefPane: {
      session: bootstrap.session,
      sessionUserId: bootstrap.session?.user.id,
      calendarPrepSummaries: upcomingDisplay.calendarPrepSummaries,
      calendarPrepAccess: upcomingDisplay.calendarPrepAccess ?? null,
      calendarPrepPlanRequiredEventIds: localState.calendarPrepPlanRequiredEventIds,
      startedCalendarPrepEventIds: localState.startedCalendarPrepEventIds,
      calendarPrepStartingEventId: localState.calendarPrepStartingEventId,
      isUpcomingView,
      hasConnectedCalendar: pastDisplay.hasConnectedCalendar,
      queryClient: bootstrap.queryClient,
      connectingCalendarProvider: localState.connectingCalendarProvider,
      addingReadyMeetingEventId: localState.addingReadyMeetingEventId,
      recentlyAddedReadyMeetingEventKey: localState.recentlyAddedReadyMeetingEventKey,
      copiedReadyMeetingEventKey: localState.copiedReadyMeetingEventKey,
      setRecentlyAddedReadyMeetingEventKey: localState.setRecentlyAddedReadyMeetingEventKey,
      onAddReadyMeeting: (event) => {
        void upcomingActions.handleAddReadyMeeting(event);
      },
      onCopyReadyMeetingUrl: (event) => {
        void upcomingActions.handleCopyReadyMeetingUrl(event);
      },
      onOpenCalendarPrepUpgrade: upcomingActions.openCalendarPrepUpgrade,
    },
    onRunCalendarEventPrepForSelected: (processor) => {
      if (upcomingDisplay.selectedCalendarEvent) {
        void upcomingActions.runCalendarEventPrep(upcomingDisplay.selectedCalendarEvent, processor);
      }
    },
    firstName: upcomingDisplay.firstName,
    setupDoneCount: upcomingDisplay.setupDoneCount,
    hasCompletedAgentIntroSetup: upcomingDisplay.hasCompletedAgentIntroSetup,
    shouldShowAgentIntroCta: upcomingDisplay.shouldShowAgentIntroCta,
    calendarProviderPickerRef: localState.calendarProviderPickerRef,
    isCalendarProviderPickerOpen: localState.isCalendarProviderPickerOpen,
    onToggleCalendarProviderPicker: () => localState.setIsCalendarProviderPickerOpen((isOpen) => !isOpen),
    connectingCalendarProvider: localState.connectingCalendarProvider,
    onStartCalendarConnect: (provider) => {
      void upcomingActions.startCalendarConnect(provider);
    },
  };
}

function buildWorkspaceHomeShellPastBranchInput(input: {
  view: "past" | "upcoming";
  bootstrap: ReturnType<typeof useWorkspaceHomeSessionBootstrap>;
  meetingViews: ReturnType<typeof useWorkspaceHomeMeetingViews>;
  pageInteractions: ReturnType<typeof useWorkspaceHomePageInteractions>;
}): Parameters<typeof WorkspaceHomePastShellBranch>[0] {
  const { bootstrap, meetingViews, pageInteractions } = input;
  const { localState } = bootstrap;
  const { pastDisplay } = meetingViews;
  const { selectionHandlers, removalInteractions } = pageInteractions;

  return {
    view: input.view,
    shouldShowPastMeetingsPlaceholder: pastDisplay.shouldShowPastMeetingsPlaceholder,
    shouldShowPastMeetingsLoading: pastDisplay.shouldShowPastMeetingsLoading,
    isMobileDetailOpen: bootstrap.isMobileDetailOpen,
    shouldShowPastRecentButton: pastDisplay.shouldShowPastRecentButton,
    pastPeriodNavigation: pastDisplay.pastPeriodNavigation,
    pastMeetingGroupsLength: pastDisplay.pastMeetingGroups.length,
    onSelectRecentPastPeriod: selectionHandlers.selectRecentPastPeriod,
    onSelectOlderPastPeriod: selectionHandlers.selectOlderPastPeriod,
    onSelectNewerPastPeriod: selectionHandlers.selectNewerPastPeriod,
    selectedPastMeetingGroup: pastDisplay.selectedPastMeetingGroup,
    calendarNow: pastDisplay.calendarNow,
    selectedPastMeetingIdForDisplay: pastDisplay.selectedPastMeetingIdForDisplay,
    isMobile: bootstrap.mobileNavigation.isMobile,
    onPrefetchPastMeeting: selectionHandlers.prefetchPastMeeting,
    onSelectPastMeeting: selectionHandlers.selectPastMeeting,
    mobileBackButtonRef: bootstrap.mobileNavigation.backButton,
    onMobileBack: bootstrap.mobileNavigation.close,
    pastMeetingDetailPaneRef: bootstrap.pastMeetingDetailPaneRef,
    pastMeetingDetailOverlayRef: bootstrap.pastMeetingDetailOverlayRef,
    pastDetailMeetingId: pastDisplay.pastDetailMeetingId,
    onMeetingReady: localState.setReadyPastMeetingId,
    onMeetingLoadFailure: localState.setPastMeetingLoadFailure,
    onPastMeetingDeleted: removalInteractions.pastMeetingRemoval.onPastMeetingDeleted,
    onRequestDeleteMeeting: removalInteractions.pastMeetingRemoval.requestPastMeetingRemoval,
  };
}

function buildWorkspaceHomeShellTreeInput(input: {
  view: "past" | "upcoming";
  bootstrap: ReturnType<typeof useWorkspaceHomeSessionBootstrap>;
  meetingViews: ReturnType<typeof useWorkspaceHomeMeetingViews>;
  pageInteractions: ReturnType<typeof useWorkspaceHomePageInteractions>;
}): WorkspaceHomeShellTreeInput {
  const { bootstrap, meetingViews, pageInteractions } = input;
  const { localState } = bootstrap;
  const { pastDisplay, upcomingDisplay } = meetingViews;
  const { removalInteractions } = pageInteractions;
  const isUpcomingView = bootstrap.isUpcomingView;
  const isFullBleedWorkspace =
    input.view === "past" || (isUpcomingView && upcomingDisplay.shouldShowUpcomingCalendarSurface);
  const workspaceShellEndMeetingState = getWorkspaceShellEndMeetingState({
    view: input.view,
    pastDetailMeetingId: pastDisplay.pastDetailMeetingId,
    readyPastMeetingId: localState.readyPastMeetingId,
    pastMeetingLoadFailure: localState.pastMeetingLoadFailure,
  });

  return {
    meetingsForDisplay: pastDisplay.meetingsForDisplay,
    view: input.view,
    workspaceShellEndMeetingState,
    isFullBleedWorkspace,
    error: localState.error,
    isUpcomingView,
    shouldShowUpcomingCalendarSurface: upcomingDisplay.shouldShowUpcomingCalendarSurface,
    isMobileDetailOpen: bootstrap.isMobileDetailOpen,
    upcomingBranch: buildWorkspaceHomeShellUpcomingBranchInput(input),
    pastBranch: buildWorkspaceHomeShellPastBranchInput(input),
    pastMeetingRemoveTarget: localState.pastMeetingRemoveTarget,
    onCancelPastMeetingRemoval: () => {
      localState.setPastMeetingRemoveTarget(null);
    },
    onConfirmPastMeetingRemoval: () => void removalInteractions.pastMeetingRemoval.confirmPastMeetingRemoval(),
    calendarEventDeleteTarget: localState.calendarEventDeleteTarget,
    calendarEventDeleteError: localState.calendarEventDeleteError,
    onCancelCalendarEventDeletion: () => {
      localState.setCalendarEventDeleteTarget(null);
      localState.setCalendarEventDeleteError(null);
    },
    onConfirmCalendarEventDeletion: () => void removalInteractions.calendarRemoval.confirmCalendarEventDeletion(),
  };
}

type WorkspaceHomeShellBriefPaneInput = Omit<
  WorkspaceHomeSelectedCalendarBriefPaneBodyInput,
  "selectedCalendarEvent" | "onRunCalendarEventPrep"
>;

function WorkspaceHomeUpcomingShellBranch(input: {
  view: "past" | "upcoming";
  shouldShowUpcomingCalendarSurface: boolean;
  isCalendarEventsError: boolean;
  shouldHoldUpcomingCalendarContent: boolean;
  shouldShowNoUpcomingMeetings: boolean;
  isMobileDetailOpen: boolean;
  selectedCalendarGroupIndexForDisplay: number;
  calendarEventGroupsLength: number;
  onSelectCalendarGroupIndex: (getNextIndex: (current: number) => number) => void;
  onSelectPreviousCalendarGroup: () => void;
  onSelectUpcomingCalendarEvent: (eventId: string) => void;
  selectedCalendarEventGroupLabel: string;
  calendarGroupEvents: NormalizedCalendarEvent[];
  selectedCalendarEventGroupKind: string | undefined;
  selectedCalendarEventId: string | null;
  isMobile: boolean;
  mobileBackButtonRef: RefObject<HTMLButtonElement | null>;
  onMobileBack: () => void;
  selectedCalendarEvent: NormalizedCalendarEvent | null;
  briefPane: WorkspaceHomeShellBriefPaneInput;
  onRunCalendarEventPrepForSelected: (processor: CalendarEventPrepProcessor) => void;
  firstName: string;
  setupDoneCount: number;
  hasCompletedAgentIntroSetup: boolean;
  shouldShowAgentIntroCta: boolean;
  calendarProviderPickerRef: RefObject<HTMLDivElement | null>;
  isCalendarProviderPickerOpen: boolean;
  onToggleCalendarProviderPicker: () => void;
  connectingCalendarProvider: CalendarProvider | null;
  onStartCalendarConnect: (provider: CalendarProvider) => void;
}) {
  return (
    <WorkspaceHomeUpcomingViewBody
      shouldShowUpcomingCalendarSurface={input.shouldShowUpcomingCalendarSurface}
      calendarConnectedContent={
        <WorkspaceHomeUpcomingCalendarStackMain
          isCalendarEventsError={input.isCalendarEventsError}
          shouldHoldUpcomingCalendarContent={input.shouldHoldUpcomingCalendarContent}
          shouldShowNoUpcomingMeetings={input.shouldShowNoUpcomingMeetings}
        >
          <WorkspaceHomeUpcomingCalendarConnectedScreen
            view={input.view}
            isMobileDetailOpen={input.isMobileDetailOpen}
            selectedCalendarGroupIndexForDisplay={input.selectedCalendarGroupIndexForDisplay}
            calendarEventGroupsLength={input.calendarEventGroupsLength}
            onSelectCalendarGroupIndex={input.onSelectCalendarGroupIndex}
            onSelectPreviousCalendarGroup={input.onSelectPreviousCalendarGroup}
            onSelectUpcomingCalendarEvent={input.onSelectUpcomingCalendarEvent}
            selectedCalendarEventGroupLabel={input.selectedCalendarEventGroupLabel}
            calendarGroupEvents={input.calendarGroupEvents}
            selectedCalendarEventGroupKind={input.selectedCalendarEventGroupKind}
            selectedCalendarEventId={input.selectedCalendarEventId}
            isMobile={input.isMobile}
            backButtonRef={input.mobileBackButtonRef}
            onMobileBack={input.onMobileBack}
            selectedCalendarEvent={input.selectedCalendarEvent}
            briefPane={input.briefPane}
            onRunCalendarEventPrepForSelected={input.onRunCalendarEventPrepForSelected}
          />
        </WorkspaceHomeUpcomingCalendarStackMain>
      }
      setupShell={
        <WorkspaceUpcomingSetupShell
          firstName={input.firstName}
          setupDoneCount={input.setupDoneCount}
          hasCompletedAgentIntroSetup={input.hasCompletedAgentIntroSetup}
          shouldShowAgentIntroCta={input.shouldShowAgentIntroCta}
          calendarProviderPickerRef={input.calendarProviderPickerRef}
          isCalendarProviderPickerOpen={input.isCalendarProviderPickerOpen}
          onToggleCalendarProviderPicker={input.onToggleCalendarProviderPicker}
          connectingCalendarProvider={input.connectingCalendarProvider}
          onStartCalendarConnect={input.onStartCalendarConnect}
        />
      }
    />
  );
}

function WorkspaceHomePastShellBranch(input: {
  view: "past" | "upcoming";
  shouldShowPastMeetingsPlaceholder: boolean;
  shouldShowPastMeetingsLoading: boolean;
  isMobileDetailOpen: boolean;
  shouldShowPastRecentButton: boolean;
  pastPeriodNavigation: ReturnType<typeof getPastMeetingPeriodNavigation>;
  pastMeetingGroupsLength: number;
  onSelectRecentPastPeriod: () => void;
  onSelectOlderPastPeriod: () => void;
  onSelectNewerPastPeriod: () => void;
  selectedPastMeetingGroup: PastMeetingGroup | null;
  calendarNow: Date;
  selectedPastMeetingIdForDisplay: string | null;
  isMobile: boolean;
  onPrefetchPastMeeting: (meetingId: string) => void;
  onSelectPastMeeting: (meeting: Meeting) => void;
  mobileBackButtonRef: RefObject<HTMLButtonElement | null>;
  onMobileBack: () => void;
  pastMeetingDetailPaneRef: RefObject<HTMLDivElement | null>;
  pastMeetingDetailOverlayRef: RefObject<HTMLDivElement | null>;
  pastDetailMeetingId: string | null;
  onMeetingReady: (meetingId: string | null) => void;
  onMeetingLoadFailure: (failure: MeetingLoadFailure | null) => void;
  onPastMeetingDeleted: (input: { deletedMeetingId: string; remainingMeetings: Meeting[] }) => void;
  onRequestDeleteMeeting: (meeting: Meeting) => void;
}) {
  return (
    <WorkspaceHomePastMeetingsColumn
      shouldShowPastMeetingsPlaceholder={input.shouldShowPastMeetingsPlaceholder}
      shouldShowPastMeetingsLoading={input.shouldShowPastMeetingsLoading}
      loadedScreen={
        <WorkspacePastMeetingsLoadedScreen
          isMobileDetailOpen={input.isMobileDetailOpen}
          shouldShowPastRecentButton={input.shouldShowPastRecentButton}
          pastPeriodNavigation={input.pastPeriodNavigation}
          pastMeetingGroupsLength={input.pastMeetingGroupsLength}
          onSelectRecentPastPeriod={input.onSelectRecentPastPeriod}
          onSelectOlderPastPeriod={input.onSelectOlderPastPeriod}
          onSelectNewerPastPeriod={input.onSelectNewerPastPeriod}
          selectedPastMeetingGroup={input.selectedPastMeetingGroup}
          calendarNow={input.calendarNow}
          selectedPastMeetingIdForDisplay={input.selectedPastMeetingIdForDisplay}
          isMobile={input.isMobile}
          onPrefetchPastMeeting={input.onPrefetchPastMeeting}
          onSelectPastMeeting={input.onSelectPastMeeting}
          view={input.view}
          backButtonRef={input.mobileBackButtonRef}
          onMobileBack={input.onMobileBack}
          pastMeetingDetailPaneRef={input.pastMeetingDetailPaneRef}
          pastMeetingDetailOverlayRef={input.pastMeetingDetailOverlayRef}
          pastDetailMeetingId={input.pastDetailMeetingId}
          onMeetingReady={input.onMeetingReady}
          onMeetingLoadFailure={input.onMeetingLoadFailure}
          onMeetingDeleted={input.onPastMeetingDeleted}
          onRequestDeleteMeeting={input.onRequestDeleteMeeting}
        />
      }
    />
  );
}

type WorkspaceHomeShellTreeInput = {
  meetingsForDisplay: Meeting[];
  view: "past" | "upcoming";
  workspaceShellEndMeetingState: ReturnType<typeof getWorkspaceShellEndMeetingState>;
  isFullBleedWorkspace: boolean;
  error: string | null;
  isUpcomingView: boolean;
  upcomingBranch: Parameters<typeof WorkspaceHomeUpcomingShellBranch>[0];
  pastBranch: Parameters<typeof WorkspaceHomePastShellBranch>[0];
  pastMeetingRemoveTarget: Meeting | null;
  onCancelPastMeetingRemoval: () => void;
  onConfirmPastMeetingRemoval: () => void;
  calendarEventDeleteTarget: NormalizedCalendarEvent | null;
  calendarEventDeleteError: string | null;
  onCancelCalendarEventDeletion: () => void;
  onConfirmCalendarEventDeletion: () => void;
  shouldShowUpcomingCalendarSurface: boolean;
  isMobileDetailOpen: boolean;
};

function WorkspaceHomeShellTree(input: WorkspaceHomeShellTreeInput) {
  return (
    <WorkspaceShell
      meetings={input.meetingsForDisplay}
      activeSidebarView={input.view}
      endMeetingContentReady={input.workspaceShellEndMeetingState.isEndMeetingContentReady}
      endMeetingLoadFailure={input.workspaceShellEndMeetingState.endMeetingLoadFailure}
      contentClassName={input.isFullBleedWorkspace ? "workspace-content-full-bleed" : undefined}
    >
      <div
        className={getWorkspacePageRootClassName({
          view: input.view,
          shouldShowUpcomingCalendarSurface: input.shouldShowUpcomingCalendarSurface,
          isMobileDetailOpen: input.isMobileDetailOpen,
        })}
      >
        <WorkspaceHomeErrorBanner error={input.error} />
        {input.isUpcomingView ? (
          <WorkspaceHomeUpcomingShellBranch {...input.upcomingBranch} />
        ) : (
          <WorkspaceHomePastShellBranch {...input.pastBranch} />
        )}
      </div>
      <WorkspaceHomeRemovalDialogs
        pastMeetingRemoveTarget={input.pastMeetingRemoveTarget}
        onCancelPastMeetingRemoval={input.onCancelPastMeetingRemoval}
        onConfirmPastMeetingRemoval={input.onConfirmPastMeetingRemoval}
        calendarEventDeleteTarget={input.calendarEventDeleteTarget}
        calendarEventDeleteError={input.calendarEventDeleteError}
        onCancelCalendarEventDeletion={input.onCancelCalendarEventDeletion}
        onConfirmCalendarEventDeletion={input.onConfirmCalendarEventDeletion}
      />
    </WorkspaceShell>
  );
}

export function WorkspaceHome({
  initialMeetingId = null,
  view = "past",
}: {
  initialMeetingId?: string | null;
  view?: "past" | "upcoming";
}) {
  const bootstrap = useWorkspaceHomeSessionBootstrap({ initialMeetingId, view });
  useWorkspaceHomeMeetingsLifecycle({
    session: bootstrap.session,
    isUpcomingView: bootstrap.isUpcomingView,
    meetingsQueryKey: bootstrap.meetingsQueryKey,
    queryClient: bootstrap.queryClient,
    workspaceScope: bootstrap.workspaceScope,
    workspaceScopeRef: bootstrap.workspaceScopeRef,
    previousWorkspaceScopeRef: bootstrap.previousWorkspaceScopeRef,
    meetingsQuery: bootstrap.meetingsQuery,
    mobileNavigation: bootstrap.mobileNavigation,
    localState: bootstrap.localState,
  });
  const meetingViews = useWorkspaceHomeMeetingViews({
    view,
    session: bootstrap.session,
    isUpcomingView: bootstrap.isUpcomingView,
    isRestoringQueryCache: bootstrap.isRestoringQueryCache,
    calendarEventsQuery: bootstrap.calendarEventsQuery,
    agentSettingsQuery: bootstrap.agentSettingsQuery,
    cachedCalendarProviders: bootstrap.cachedCalendarProviders,
    meetingsScope: bootstrap.localState.meetingsScope,
    workspaceScope: bootstrap.workspaceScope,
    meetingsQuery: bootstrap.meetingsQuery,
    localState: bootstrap.localState,
    mobileNavigation: bootstrap.mobileNavigation,
  });
  const pageInteractions = useWorkspaceHomePageInteractions({
    view,
    initialMeetingId,
    session: bootstrap.session,
    showToast: bootstrap.showToast,
    queryClient: bootstrap.queryClient,
    router: bootstrap.router,
    meetingsQueryKey: bootstrap.meetingsQueryKey,
    workspaceScope: bootstrap.workspaceScope,
    calendarEventsKey: bootstrap.calendarEventsKey,
    isUpcomingView: bootstrap.isUpcomingView,
    isMobileDetailOpen: bootstrap.isMobileDetailOpen,
    mobileNavigation: bootstrap.mobileNavigation,
    localState: bootstrap.localState,
    meetingViews,
    calendarEventsQuery: bootstrap.calendarEventsQuery,
    agentSettingsQuery: bootstrap.agentSettingsQuery,
  });

  return WorkspaceHomeShellTree(buildWorkspaceHomeShellTreeInput({ view, bootstrap, meetingViews, pageInteractions }));
}
