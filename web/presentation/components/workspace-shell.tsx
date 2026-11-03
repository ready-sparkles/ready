"use client";

import { useDroppable } from "@dnd-kit/core";
import type { Meeting } from "@readymeet/shared";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  getApiErrorMessage,
  getMemoryStatus,
  getMyWorkspace,
  listPersonalAssignedTasks,
  setActiveWorkspace,
} from "../../composition/api";
import { useMarketplaceBanner } from "../../composition/use-marketplace-banner";
import { useMemoryNavigationCache } from "../../composition/use-memory-navigation-cache";
import { useTrialBanner } from "../../composition/use-trial-banner";
import { workspaceMeetingsOptions } from "../../composition/workspace-meetings-query";
import { syncActiveWorkspaceSession } from "../../composition/workspace-session-sync";
import {
  fadeInWorkspaceAfterSwitch,
  fadeOutWorkspaceForSwitch,
  getWorkspaceSwitchNavigationTarget,
  isWorkspaceSwitchTransitionActive,
  WORKSPACE_CREATION_ENTER_FADE_MS,
  WORKSPACE_CREATION_TRANSITION_KEY,
  WORKSPACE_END_MEETING_BACKGROUND_FADE_MS,
  WORKSPACE_END_MEETING_LOADER_FADE_MS,
  WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT,
  WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY,
  WORKSPACE_END_MEETING_REVEAL_DELAY_MS,
  WORKSPACE_END_MEETING_TRANSITION_KEY,
  WORKSPACE_END_MEETING_TRANSITION_SETTLE_MS,
} from "../../composition/workspace-transition";
import {
  type AssignedTaskView,
  filterUnifiedAssignedTasksByView,
  filterUnifiedAssignedTasksByWorkspace,
  taskViewDropTargetId,
} from "../../domain/assigned-task-filters";
import { isAltShiftShortcut, isEditableShortcutTarget } from "../../domain/keyboard-shortcuts";
import { canShowMemoryNavigation } from "../../domain/memory-navigation";
import { personalAssignedTasksQueryKey } from "../../domain/query-keys";
import { rememberWorkspaceLocation } from "../../domain/workspace-return-location";
import {
  canShowWorkspaceSwitcherMenu,
  resolveWorkspaceShortcut,
  type WorkspaceShortcutPrefix,
} from "../../domain/workspace-switcher-shortcuts";
import { beginInstantMeetingLaunch } from "../lib/meeting-launch";
import { trialOfferTitle, useTrialOffer } from "../lib/use-trial-offer";

import { useAuth } from "./auth-provider";
import { GoogleIcon } from "./auth-provider-icons";
import { EndMeetingAnalysisOverlay, type EndMeetingFlowState } from "./end-meeting-analysis";
import { useToast } from "./toast-provider";
import {
  ActivityNavIcon,
  ArchiveTrayIcon,
  ArrowForwardIcon,
  CalendarStackIcon,
  ChevronDownIcon,
  GiftIcon,
  LayersNavIcon,
  MemoryAllNavIcon,
  PeopleNavIcon,
  StarNavIcon,
  VideoPlusIcon,
} from "./workspace-nav-icons";

export { ActivityNavIcon, ArchiveTrayIcon, CalendarStackIcon, LayersNavIcon, StarNavIcon } from "./workspace-nav-icons";

const END_MEETING_WORKSPACE_HANDOFF_FLOW: EndMeetingFlowState = {
  startedAt: 0,
  phase: "routing",
  detail: null,
  transientError: null,
};

const WORKSPACE_USER_INITIALS_MAX_CHARS = 2;
const MEMORY_STATUS_STALE_TIME_MS = 60_000;
const MEMORY_STATUS_GC_MINUTES = 5;
const MILLISECONDS_PER_MINUTE = 60_000;
const MEETING_LAUNCH_NAVIGATION_DELAY_MS = 170;
const PERSONAL_TASKS_STALE_TIME_MS = 20_000;
const WORKSPACE_CREATION_FADE_BUFFER_MS = 80;
const ACCOUNT_DROPDOWN_OFFSET_PX = 5;
const SWITCHER_SUBMENU_TOP_OFFSET_PX = 7;
const SWITCHER_SUBMENU_LEFT_GAP_PX = 16;
const SWITCHER_SUBMENU_LEFT_OVERLAP_PX = 8;
const SWITCHER_CLOSE_DELAY_MS = 160;
const END_MEETING_SETTLE_EXTRA_MS = 160;
const END_MEETING_LOADER_FADE_BUFFER_MS = 80;
const END_MEETING_BACKGROUND_FADE_EXTRA_MS = 160;
const WORKSPACE_SWITCHER_MAX_INDEX = 9;
const TRIAL_BANNER_MIN_REMAINING_MEETINGS = 3;

const WORKSPACE_SHELL_KEYBOARD = {
  logOutCode: "KeyQ",
} as const;

const WORKSPACE_SHELL_MESSAGES = {
  memoryStatusRequiresWorkspace: "Memory status requires an authenticated workspace.",
  assignedTasksRequireSession: "Assigned tasks require an authenticated session.",
  switchWorkspaceRefreshRequired: "Could not switch workspace. Refresh Ready before continuing.",
  switchWorkspaceFailed: "Could not switch workspace.",
  openAccountMenuAria: "Open account menu",
  accountMenuAria: "Account menu",
  settingsLabel: "Settings",
  shortcutThen: "then",
  shortcutSettingsFirst: "G",
  shortcutSettingsSecond: "S",
  invitePeopleLabel: "Invite people",
  switchWorkspaceLabel: "Switch workspace",
  switchWorkspaceMenuAria: "Switch workspace",
  shortcutSwitcherFirst: "O",
  shortcutSwitcherSecond: "W",
  workspacesLoadFailed: "Couldn't load workspaces. ",
  workspacesRetry: "Retry",
  workspacesLoading: "Loading workspaces…",
  workspaceSwitching: "Switching…",
  createWorkspaceLabel: "Create a new workspace...",
  logOutLabel: "Log out",
  shortcutLogOutAlt: "⌥",
  shortcutLogOutShift: "⇧",
  shortcutLogOutKey: "Q",
  newMeetingLabel: "New",
  meetingsSection: "Meetings",
  upcomingLabel: "Upcoming",
  pastLabel: "Past",
  tasksSection: "Tasks",
  mineLabel: "Mine",
  othersLabel: "Others",
  doneLabel: "Done",
  memorySection: "Memory",
  memoryAllLabel: "All",
  memoryPeopleLabel: "People",
  marketplaceCardAria: "Google Calendar add-on",
  marketplaceDismissAria: "Hide Google Calendar add-on",
  marketplaceTitle: "Ready for Google Calendar",
  marketplaceBody: "Add Ready meeting links to your events with the Google Calendar add-on.",
  marketplaceInstall: "Install add-on",
  trialCardAria: "Free trial",
  trialDismissAria: "Hide free trial",
  trialFirstMeetingsFree: "Your first 3 meetings are free.",
  trialBody: "Work with a live AI agent in your meeting. AI usage limits apply.",
  viewPlansLabel: "View plans",
  closeWorkspaceMenuAria: "Close workspace menu",
  openWorkspaceMenuAria: "Open workspace menu",
  workspaceNavigationAria: "Workspace navigation",
  accountSection: "Account",
  mineOpenTasksAria: (input: { count: number }) => `${input.count} of my open tasks`,
  workspaceShortcutIndex: (input: { index: number }) => `⇧ ${input.index}`,
} as const;

type WorkspaceShellProps = {
  meetings: Meeting[];
  activeSidebarView?:
    | "memory-all"
    | "memory-people"
    | "past"
    | "upcoming"
    | "tasks-mine"
    | "tasks-others"
    | "tasks-activity"
    | null;
  contentClassName?: string;
  taskDropTargets?: TaskDropTargets;
  /** @external WorkspaceShell prop */
  endMeetingContentReady?: boolean;
  endMeetingLoadFailure?: { message: string; retry: () => void } | null;
  children: React.ReactNode;
};

type TaskDropTargets = {
  canDropOnView: (view: AssignedTaskView) => boolean;
  isDraggingTask: boolean;
};

function ignoreBrowserStorageFailure(error: unknown) {
  if (error instanceof Error || typeof error === "string") {
    return;
  }

  throw error;
}

function clearEndMeetingRevealComplete() {
  try {
    window.sessionStorage.removeItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY);
  } catch (error) {
    ignoreBrowserStorageFailure(error);
  }
}

function markEndMeetingRevealComplete() {
  try {
    window.sessionStorage.setItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY, "1");
  } catch (error) {
    ignoreBrowserStorageFailure(error);
  }

  window.dispatchEvent(new CustomEvent(WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT));
}

function readWorkspaceCreationTransition() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.sessionStorage.getItem(WORKSPACE_CREATION_TRANSITION_KEY) === "1";
  } catch (error) {
    ignoreBrowserStorageFailure(error);

    return false;
  }
}

function clearWorkspaceCreationTransition() {
  try {
    window.sessionStorage.removeItem(WORKSPACE_CREATION_TRANSITION_KEY);
  } catch (error) {
    ignoreBrowserStorageFailure(error);
  }
}

function readActiveHTMLElement(): HTMLElement | null {
  const element = document.activeElement;

  return element instanceof HTMLElement ? element : null;
}

function readTransitionEventTarget(event: TransitionEvent): HTMLElement | null {
  return event.target instanceof HTMLElement ? event.target : null;
}

function getWorkspaceUserInitials(input: { displayName?: string | null; email?: string | null }) {
  const source = (input.displayName ?? input.email ?? "?").trim();
  if (source.length === 0) {
    return "?";
  }

  const words = source.replace(/@.*/, "").split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return source.charAt(0).toUpperCase();
  }

  if (words.length === 1) {
    const [onlyWord = source] = words;

    return onlyWord.slice(0, WORKSPACE_USER_INITIALS_MAX_CHARS).toUpperCase();
  }

  const [firstWord = "", secondWord = ""] = words;

  return `${firstWord[0] ?? ""}${secondWord[0] ?? ""}`.toUpperCase();
}

function WorkspaceCheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none">
      <path
        d="M3 8.4 6.4 11.8 13 4.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorkspaceCaretIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none">
      <path
        d="M6 3.8 10.4 8 6 12.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorkspaceGlyphIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none">
      <path
        d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorkspaceMobileMenuIcon() {
  return (
    <span className="workspace-mobile-menu-icon" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function WorkspaceLogoutIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-nav-icon" fill="none">
      <path
        d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TaskNavItem({
  taskView,
  href,
  isActive,
  dropTargets,
  onPointerDown,
  children,
}: {
  taskView: AssignedTaskView;
  href: string;
  isActive: boolean;
  dropTargets?: TaskDropTargets;
  onPointerDown: () => void;
  children: React.ReactNode;
}) {
  if (!dropTargets) {
    return (
      <Link
        href={href}
        prefetch={true}
        className={`workspace-category-item${isActive ? " is-active" : ""}`}
        onPointerDown={onPointerDown}
      >
        {children}
      </Link>
    );
  }

  return (
    <DroppableTaskNavItem
      taskView={taskView}
      href={href}
      isActive={isActive}
      canDrop={dropTargets.canDropOnView(taskView)}
      isDraggingTask={dropTargets.isDraggingTask}
      onPointerDown={onPointerDown}
    >
      {children}
    </DroppableTaskNavItem>
  );
}

function refetchTrialOfferOnWorkspaceNavigation(input: {
  session: ReturnType<typeof useAuth>["session"];
  refetch: ReturnType<typeof useTrialOffer>["refetch"];
}) {
  const { session, refetch } = input;
  if (session !== null && session.token !== "" && session.user.source !== "guest") {
    void refetch({ cancelRefetch: false });
  }
}

function handleWorkspaceNewMeetingClick(input: {
  event: React.MouseEvent<HTMLAnchorElement>;
  session: ReturnType<typeof useAuth>["session"];
  router: ReturnType<typeof useRouter>;
  setIsMeetingLaunchFadeActive: (value: boolean) => void;
}) {
  const { event, session, router, setIsMeetingLaunchFadeActive } = input;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }
  event.preventDefault();

  if (session) {
    const existingMeetingId = window.localStorage.getItem("readymeet-active-meeting-id");
    void (async () => {
      try {
        await beginInstantMeetingLaunch({ token: session.token, existingMeetingId });
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
      }
    })();
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    router.push("/meet");

    return;
  }

  setIsMeetingLaunchFadeActive(true);
  window.setTimeout(() => {
    router.push("/meet");
  }, MEETING_LAUNCH_NAVIGATION_DELAY_MS);
}

function clearEndMeetingRevealTimeouts(input: {
  backgroundFallbackTimeoutId: number | null;
  loaderFallbackTimeoutId: number | null;
  completeFallbackTimeoutId: number | null;
  settleTimeoutId: number | null;
}) {
  if (input.backgroundFallbackTimeoutId !== null) {
    window.clearTimeout(input.backgroundFallbackTimeoutId);
  }
  if (input.loaderFallbackTimeoutId !== null) {
    window.clearTimeout(input.loaderFallbackTimeoutId);
  }
  if (input.completeFallbackTimeoutId !== null) {
    window.clearTimeout(input.completeFallbackTimeoutId);
  }
  if (input.settleTimeoutId !== null) {
    window.clearTimeout(input.settleTimeoutId);
  }
}

function createEndMeetingRevealTransitionListeners(input: {
  layoutElement: HTMLDivElement | null;
  setIsEndMeetingLoaderExiting: (value: boolean) => void;
  setIsEndMeetingTransitionRevealed: (value: boolean) => void;
  setShouldRunEndMeetingTransition: (value: boolean) => void;
}) {
  const {
    layoutElement,
    setIsEndMeetingLoaderExiting,
    setIsEndMeetingTransitionRevealed,
    setShouldRunEndMeetingTransition,
  } = input;
  const revealState: {
    hasStartedLoaderExit: boolean;
    hasRevealedWorkspace: boolean;
    hasCompletedReveal: boolean;
    backgroundFallbackTimeoutId: number | null;
    loaderFallbackTimeoutId: number | null;
    completeFallbackTimeoutId: number | null;
    settleTimeoutId: number | null;
  } = {
    hasStartedLoaderExit: false,
    hasRevealedWorkspace: false,
    hasCompletedReveal: false,
    backgroundFallbackTimeoutId: null,
    loaderFallbackTimeoutId: null,
    completeFallbackTimeoutId: null,
    settleTimeoutId: null,
  };

  const completeReveal = () => {
    if (revealState.hasCompletedReveal) {
      return;
    }

    revealState.hasCompletedReveal = true;
    markEndMeetingRevealComplete();
    revealState.settleTimeoutId = window.setTimeout(() => {
      setShouldRunEndMeetingTransition(false);
    }, END_MEETING_SETTLE_EXTRA_MS);
  };

  const revealWorkspace = () => {
    if (revealState.hasRevealedWorkspace) {
      return;
    }

    revealState.hasRevealedWorkspace = true;
    setIsEndMeetingTransitionRevealed(true);

    revealState.completeFallbackTimeoutId = window.setTimeout(
      completeReveal,
      WORKSPACE_END_MEETING_TRANSITION_SETTLE_MS,
    );
  };

  const startLoaderExit = () => {
    if (revealState.hasStartedLoaderExit) {
      return;
    }

    revealState.hasStartedLoaderExit = true;
    setIsEndMeetingLoaderExiting(true);
    revealState.loaderFallbackTimeoutId = window.setTimeout(
      revealWorkspace,
      WORKSPACE_END_MEETING_LOADER_FADE_MS + END_MEETING_LOADER_FADE_BUFFER_MS,
    );
  };

  const handleTransitionEnd = (event: TransitionEvent) => {
    const target = readTransitionEventTarget(event);

    if (target === layoutElement && event.propertyName === "opacity" && event.pseudoElement === "::before") {
      startLoaderExit();

      return;
    }

    if (target?.classList.contains("live-end-meeting-overlay") === true && event.propertyName === "opacity") {
      revealWorkspace();

      return;
    }

    if (target?.classList.contains("workspace-content") === true && event.propertyName === "opacity") {
      completeReveal();
    }
  };

  layoutElement?.addEventListener("transitionend", handleTransitionEnd);

  revealState.backgroundFallbackTimeoutId = window.setTimeout(
    startLoaderExit,
    WORKSPACE_END_MEETING_BACKGROUND_FADE_MS + END_MEETING_BACKGROUND_FADE_EXTRA_MS,
  );

  return () => {
    layoutElement?.removeEventListener("transitionend", handleTransitionEnd);
    clearEndMeetingRevealTimeouts(revealState);
  };
}

function attachEndMeetingContentRevealTransition(input: {
  shouldRunEndMeetingTransition: boolean;
  isEndMeetingMinimumElapsed: boolean;
  isEndMeetingContentReady: boolean;
  finishEndMeetingTransition: () => void;
  workspaceLayoutRef: React.RefObject<HTMLDivElement | null>;
  setIsEndMeetingBackgroundRevealed: (value: boolean) => void;
  setIsEndMeetingLoaderExiting: (value: boolean) => void;
  setIsEndMeetingTransitionRevealed: (value: boolean) => void;
  setShouldRunEndMeetingTransition: (value: boolean) => void;
}) {
  if (!input.shouldRunEndMeetingTransition || !input.isEndMeetingMinimumElapsed || !input.isEndMeetingContentReady) {
    return undefined;
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    input.finishEndMeetingTransition();

    return undefined;
  }

  input.setIsEndMeetingBackgroundRevealed(true);

  return createEndMeetingRevealTransitionListeners({
    layoutElement: input.workspaceLayoutRef.current,
    setIsEndMeetingLoaderExiting: input.setIsEndMeetingLoaderExiting,
    setIsEndMeetingTransitionRevealed: input.setIsEndMeetingTransitionRevealed,
    setShouldRunEndMeetingTransition: input.setShouldRunEndMeetingTransition,
  });
}

function resolveWorkspaceContentClassName(contentClassName: string | undefined) {
  if (contentClassName !== undefined && contentClassName !== "") {
    return `workspace-content ${contentClassName}`;
  }

  return "workspace-content";
}

function buildWorkspaceShellLayoutClassName(input: {
  shouldRunWorkspaceCreationTransition: boolean;
  shouldRunEndMeetingTransition: boolean;
  isEndMeetingBackgroundRevealed: boolean;
  isEndMeetingTransitionRevealed: boolean;
}) {
  return [
    "workspace-layout",
    input.shouldRunWorkspaceCreationTransition ? "is-entering-from-create" : "",
    input.shouldRunEndMeetingTransition ? "is-entering-from-live" : "",
    input.isEndMeetingBackgroundRevealed ? "is-end-meeting-background-revealed" : "",
    input.isEndMeetingTransitionRevealed ? "is-end-meeting-transition-revealed" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function attachMobileNavigationOpenSideEffects(input: {
  isOpen: boolean;
  mobileNavigationRef: React.RefObject<HTMLDivElement | null>;
  mobileNavigationMenuRef: React.RefObject<HTMLDivElement | null>;
  mobileNavigationTriggerRef: React.RefObject<HTMLButtonElement | null>;
  setIsMobileNavigationOpen: (value: boolean) => void;
}) {
  const {
    isOpen,
    mobileNavigationRef,
    mobileNavigationMenuRef,
    mobileNavigationTriggerRef,
    setIsMobileNavigationOpen,
  } = input;
  if (!isOpen) {
    return undefined;
  }

  const previousBodyOverflow = document.body.style.overflow;
  const focusFrameId = window.requestAnimationFrame(() => {
    mobileNavigationMenuRef.current
      ?.querySelector<HTMLElement>(".workspace-mobile-menu-item")
      ?.focus({ preventScroll: true });
  });
  const handleKeyDown = (event: KeyboardEvent) => {
    handleMobileNavigationMenuKeyDown({
      event,
      mobileNavigationRef,
      setIsMobileNavigationOpen,
    });
  };

  document.body.style.overflow = "hidden";
  window.addEventListener("keydown", handleKeyDown);

  return () => {
    window.cancelAnimationFrame(focusFrameId);
    document.body.style.overflow = previousBodyOverflow;
    window.removeEventListener("keydown", handleKeyDown);
    const trigger = mobileNavigationTriggerRef.current;
    if (trigger && trigger.getClientRects().length > 0) {
      trigger.focus({ preventScroll: true });
    }
  };
}

function attachWorkspaceShellMobileViewportListener(input: {
  setIsAccountMenuOpen: (value: boolean) => void;
  setIsMobileNavigationOpen: (value: boolean) => void;
}) {
  const { setIsAccountMenuOpen, setIsMobileNavigationOpen } = input;
  const mobileViewport = window.matchMedia("(max-width: 1000px)");
  const handleViewportChange = () => {
    if (mobileViewport.matches) {
      setIsAccountMenuOpen(false);
    } else {
      setIsMobileNavigationOpen(false);
    }
  };

  handleViewportChange();
  mobileViewport.addEventListener("change", handleViewportChange);

  return () => {
    mobileViewport.removeEventListener("change", handleViewportChange);
  };
}

function handleMobileNavigationMenuKeyDown(input: {
  event: KeyboardEvent;
  mobileNavigationRef: React.RefObject<HTMLDivElement | null>;
  setIsMobileNavigationOpen: (value: boolean) => void;
}) {
  const { event, mobileNavigationRef, setIsMobileNavigationOpen } = input;
  if (event.key === "Escape") {
    event.preventDefault();
    setIsMobileNavigationOpen(false);

    return;
  }

  if (event.key !== "Tab") {
    return;
  }

  const focusableElements = Array.from(
    mobileNavigationRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  ).filter((element) => element.getClientRects().length > 0);
  const firstFocusableElement = focusableElements[0];
  const lastFocusableElement = focusableElements.at(-1);

  if (!firstFocusableElement || !lastFocusableElement) {
    return;
  }

  if (event.shiftKey && document.activeElement === firstFocusableElement) {
    event.preventDefault();
    lastFocusableElement.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === lastFocusableElement) {
    event.preventDefault();
    firstFocusableElement.focus({ preventScroll: true });
  }
}

function runWorkspaceCreationEnterTransition(input: { shouldRun: boolean; setShouldRun: (value: boolean) => void }) {
  const { shouldRun, setShouldRun } = input;
  if (!shouldRun) {
    return undefined;
  }

  clearWorkspaceCreationTransition();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setShouldRun(false);

    return undefined;
  }

  const timeoutId = window.setTimeout(() => {
    setShouldRun(false);
  }, WORKSPACE_CREATION_ENTER_FADE_MS + WORKSPACE_CREATION_FADE_BUFFER_MS);

  return () => {
    window.clearTimeout(timeoutId);
  };
}

function attachWorkspaceAccountMenuDismissListeners(input: {
  isAccountMenuOpen: boolean;
  accountMenuRef: React.RefObject<HTMLDivElement | null>;
  accountDropdownRef: React.RefObject<HTMLDivElement | null>;
  workspaceSwitcherSubmenuRef: React.RefObject<HTMLDivElement | null>;
  setIsAccountMenuOpen: (value: boolean) => void;
}) {
  const { isAccountMenuOpen, accountMenuRef, accountDropdownRef, workspaceSwitcherSubmenuRef, setIsAccountMenuOpen } =
    input;
  if (!isAccountMenuOpen) {
    return undefined;
  }

  const handlePointerDown = (event: MouseEvent) => {
    if (!(event.target instanceof Node)) {
      return;
    }
    const target = event.target;
    if (
      !(accountMenuRef.current?.contains(target) ?? false) &&
      !(accountDropdownRef.current?.contains(target) ?? false) &&
      !(workspaceSwitcherSubmenuRef.current?.contains(target) ?? false)
    ) {
      setIsAccountMenuOpen(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setIsAccountMenuOpen(false);
    }
  };

  window.addEventListener("mousedown", handlePointerDown);
  window.addEventListener("keydown", handleKeyDown);

  return () => {
    window.removeEventListener("mousedown", handlePointerDown);
    window.removeEventListener("keydown", handleKeyDown);
  };
}

function attachWorkspaceShellRafMeasure(input: { isEnabled: boolean; onDisabled: () => void; measure: () => void }) {
  const { isEnabled, onDisabled, measure } = input;
  if (!isEnabled) {
    onDisabled();

    return undefined;
  }

  measure();
  const frame = { id: 0 };
  frame.id = window.requestAnimationFrame(function tick() {
    measure();
    frame.id = window.requestAnimationFrame(tick);
  });

  return () => {
    window.cancelAnimationFrame(frame.id);
  };
}

function setupEndMeetingTransitionOnMount(input: {
  shouldRunEndMeetingTransition: boolean;
  setIsEndMeetingBackgroundRevealed: (value: boolean) => void;
  setIsEndMeetingLoaderExiting: (value: boolean) => void;
  setIsEndMeetingTransitionRevealed: (value: boolean) => void;
  setIsEndMeetingMinimumElapsed: (value: boolean) => void;
}) {
  const {
    shouldRunEndMeetingTransition,
    setIsEndMeetingBackgroundRevealed,
    setIsEndMeetingLoaderExiting,
    setIsEndMeetingTransitionRevealed,
    setIsEndMeetingMinimumElapsed,
  } = input;
  if (!shouldRunEndMeetingTransition) {
    setIsEndMeetingBackgroundRevealed(true);
    setIsEndMeetingLoaderExiting(true);
    setIsEndMeetingTransitionRevealed(true);
    setIsEndMeetingMinimumElapsed(true);
    // The shell is fully visible. Signal that, so notes left waiting by a reload in the middle of an
    // end-meeting transition run their reveal instead of staying hidden.
    markEndMeetingRevealComplete();

    return undefined;
  }

  try {
    window.sessionStorage.removeItem(WORKSPACE_END_MEETING_TRANSITION_KEY);
  } catch (error) {
    ignoreBrowserStorageFailure(error);
  }
  clearEndMeetingRevealComplete();

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setIsEndMeetingMinimumElapsed(true);

    return undefined;
  }

  setIsEndMeetingBackgroundRevealed(false);
  setIsEndMeetingLoaderExiting(false);
  setIsEndMeetingTransitionRevealed(false);
  setIsEndMeetingMinimumElapsed(false);

  const minimumVisibleTimeoutId = window.setTimeout(() => {
    setIsEndMeetingMinimumElapsed(true);
  }, WORKSPACE_END_MEETING_REVEAL_DELAY_MS);

  return () => {
    window.clearTimeout(minimumVisibleTimeoutId);
  };
}

function handleWorkspaceShellGlobalKeyDown(input: {
  event: KeyboardEvent;
  workspaceShortcutPrefixRef: React.RefObject<WorkspaceShortcutPrefix>;
  isWorkspaceSwitcherOpen: boolean;
  myWorkspaces: Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null;
  signOut: () => void;
  goToSettings: () => void;
  openWorkspaceSwitcher: () => void;
  handleSwitchWorkspace: (workspaceId: string) => Promise<void>;
}) {
  const {
    event,
    workspaceShortcutPrefixRef,
    isWorkspaceSwitcherOpen,
    myWorkspaces,
    signOut,
    goToSettings,
    openWorkspaceSwitcher,
    handleSwitchWorkspace,
  } = input;
  if (event.defaultPrevented || isEditableShortcutTarget(event.target)) {
    return;
  }

  if (isAltShiftShortcut({ event, code: WORKSPACE_SHELL_KEYBOARD.logOutCode })) {
    event.preventDefault();
    workspaceShortcutPrefixRef.current = null;
    signOut();

    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    workspaceShortcutPrefixRef.current = null;

    return;
  }

  const { action, prefix } = resolveWorkspaceShortcut({
    key: event.key,
    now: Date.now(),
    prefix: workspaceShortcutPrefixRef.current,
    isSwitcherOpen: isWorkspaceSwitcherOpen,
  });
  workspaceShortcutPrefixRef.current = prefix;

  if (action.type === "open-settings") {
    event.preventDefault();
    goToSettings();

    return;
  }
  if (action.type === "open-workspace-switcher") {
    event.preventDefault();
    openWorkspaceSwitcher();

    return;
  }
  if (action.type === "switch-workspace") {
    const workspace = myWorkspaces?.[action.index];
    if (workspace !== undefined) {
      event.preventDefault();
      void handleSwitchWorkspace(workspace.id);
    }
  }
}

async function performWorkspaceSwitch(input: {
  workspaceId: string;
  session: NonNullable<ReturnType<typeof useAuth>["session"]>;
  pathname: string;
  router: ReturnType<typeof useRouter>;
  refreshSession: ReturnType<typeof useAuth>["refreshSession"];
  updateCachedUser: ReturnType<typeof useAuth>["updateCachedUser"];
  showToast: ReturnType<typeof useToast>["showToast"];
  setMyWorkspaces: React.Dispatch<
    React.SetStateAction<Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null>
  >;
  setSwitchingWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const {
    workspaceId,
    session,
    pathname,
    router,
    refreshSession,
    updateCachedUser,
    showToast,
    setMyWorkspaces,
    setSwitchingWorkspaceId,
  } = input;
  const workspaceSwitch = { shouldAnimate: false };
  try {
    const [activationResult, fadeResult] = await Promise.allSettled([
      setActiveWorkspace({ token: session.token, workspaceId }),
      fadeOutWorkspaceForSwitch(),
    ]);
    if (fadeResult.status === "fulfilled") {
      workspaceSwitch.shouldAnimate = fadeResult.value;
    } else {
      throw fadeResult.reason;
    }
    if (activationResult.status === "rejected") {
      throw activationResult.reason;
    }
    const nextSession = await syncActiveWorkspaceSession({
      token: session.token,
      workspaceId,
      refreshSession,
      updateCachedUser,
    });
    if (nextSession === null) {
      throw new Error(WORKSPACE_SHELL_MESSAGES.switchWorkspaceRefreshRequired);
    }
    setMyWorkspaces(
      (current) => current?.map((workspace) => ({ ...workspace, isActive: workspace.id === workspaceId })) ?? current,
    );
    const navigationTarget = getWorkspaceSwitchNavigationTarget(pathname);
    if (navigationTarget !== null) {
      router.push(navigationTarget);
    }
    await fadeInWorkspaceAfterSwitch(workspaceSwitch.shouldAnimate);
  } catch (error) {
    await fadeInWorkspaceAfterSwitch(workspaceSwitch.shouldAnimate);
    showToast({
      id: `workspace-switch-failed:${workspaceId}`,
      message: getApiErrorMessage({ error, fallback: WORKSPACE_SHELL_MESSAGES.switchWorkspaceFailed }),
      tone: "warning",
    });
  } finally {
    setSwitchingWorkspaceId(null);
  }
}

function handleMenuRovingFocusKeyDown(input: { event: React.KeyboardEvent<HTMLDivElement>; items: HTMLElement[] }) {
  const { event, items } = input;
  if (items.length === 0) {
    return;
  }
  const activeElement = readActiveHTMLElement();
  const currentIndex = activeElement === null ? -1 : items.indexOf(activeElement);
  const focusItem = (index: number) => {
    event.preventDefault();
    items[((index % items.length) + items.length) % items.length]?.focus({ preventScroll: true });
  };

  switch (event.key) {
    case "ArrowDown":
      focusItem(currentIndex + 1);
      break;
    case "ArrowUp":
      focusItem(currentIndex === -1 ? items.length - 1 : currentIndex - 1);
      break;
    case "Home":
      focusItem(0);
      break;
    case "End":
      focusItem(items.length - 1);
      break;
    default:
      break;
  }
}

async function fetchWorkspaceSwitcherList(input: {
  token: string;
  setMyWorkspaces: React.Dispatch<
    React.SetStateAction<Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null>
  >;
  setHasWorkspacesLoadFailed: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { token, setMyWorkspaces, setHasWorkspacesLoadFailed } = input;
  setHasWorkspacesLoadFailed(false);
  try {
    const payload = await getMyWorkspace(token);
    setMyWorkspaces(payload.workspaces);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    setHasWorkspacesLoadFailed(true);
  }
}

function processAccountMenuKeyDown(input: {
  event: React.KeyboardEvent<HTMLDivElement>;
  workspaceSwitcherSubmenuRef: React.RefObject<HTMLDivElement | null>;
  getAccountMenuItems: () => HTMLElement[];
}) {
  const { event, workspaceSwitcherSubmenuRef, getAccountMenuItems } = input;
  if (event.target instanceof Node && workspaceSwitcherSubmenuRef.current?.contains(event.target) === true) {
    return;
  }
  handleMenuRovingFocusKeyDown({ event, items: getAccountMenuItems() });
}

function measureWorkspaceAccountDropdownPosition(input: {
  accountMenuRef: React.RefObject<HTMLDivElement | null>;
  setAccountDropdownPosition: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>;
}) {
  const anchor = input.accountMenuRef.current;
  if (!anchor) {
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const next = { top: rect.bottom + ACCOUNT_DROPDOWN_OFFSET_PX, left: rect.left };
  input.setAccountDropdownPosition((current) =>
    current && current.top === next.top && current.left === next.left ? current : next,
  );
}

function measureWorkspaceSwitcherSubmenuPosition(input: {
  workspaceSwitcherTriggerRef: React.RefObject<HTMLButtonElement | null>;
  accountDropdownRef: React.RefObject<HTMLDivElement | null>;
  setSwitcherSubmenuPosition: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>;
}) {
  const trigger = input.workspaceSwitcherTriggerRef.current;
  if (!trigger) {
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const dropdownRect = input.accountDropdownRef.current?.getBoundingClientRect();
  const next = {
    top: rect.top - SWITCHER_SUBMENU_TOP_OFFSET_PX,
    left: (dropdownRect?.right ?? rect.right + SWITCHER_SUBMENU_LEFT_GAP_PX) - SWITCHER_SUBMENU_LEFT_OVERLAP_PX,
  };
  input.setSwitcherSubmenuPosition((current) =>
    current && current.top === next.top && current.left === next.left ? current : next,
  );
}

function attachWorkspaceShellGlobalKeyDownListener(input: {
  workspaceShortcutPrefixRef: React.RefObject<WorkspaceShortcutPrefix>;
  isWorkspaceSwitcherOpen: boolean;
  myWorkspaces: Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null;
  signOut: () => void;
  goToSettings: () => void;
  openWorkspaceSwitcher: () => void;
  handleSwitchWorkspace: (workspaceId: string) => Promise<void>;
}) {
  const handleKeyDown = (event: KeyboardEvent) => {
    handleWorkspaceShellGlobalKeyDown({
      event,
      workspaceShortcutPrefixRef: input.workspaceShortcutPrefixRef,
      isWorkspaceSwitcherOpen: input.isWorkspaceSwitcherOpen,
      myWorkspaces: input.myWorkspaces,
      signOut: input.signOut,
      goToSettings: input.goToSettings,
      openWorkspaceSwitcher: input.openWorkspaceSwitcher,
      handleSwitchWorkspace: input.handleSwitchWorkspace,
    });
  };

  window.addEventListener("keydown", handleKeyDown);

  return () => {
    window.removeEventListener("keydown", handleKeyDown);
  };
}

async function runWorkspaceShellSwitchWorkspace(input: {
  workspaceId: string;
  session: NonNullable<ReturnType<typeof useAuth>["session"]>;
  switchingWorkspaceId: string | null;
  pathname: string;
  router: ReturnType<typeof useRouter>;
  refreshSession: ReturnType<typeof useAuth>["refreshSession"];
  updateCachedUser: ReturnType<typeof useAuth>["updateCachedUser"];
  showToast: ReturnType<typeof useToast>["showToast"];
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSwitchingWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setMyWorkspaces: React.Dispatch<
    React.SetStateAction<Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null>
  >;
}) {
  if (Boolean(input.switchingWorkspaceId) || isWorkspaceSwitchTransitionActive()) {
    return;
  }
  if (input.workspaceId === input.session.user.workspaceId) {
    input.setIsAccountMenuOpen(false);

    return;
  }
  input.setSwitchingWorkspaceId(input.workspaceId);
  input.setIsAccountMenuOpen(false);
  await performWorkspaceSwitch({
    workspaceId: input.workspaceId,
    session: input.session,
    pathname: input.pathname,
    router: input.router,
    refreshSession: input.refreshSession,
    updateCachedUser: input.updateCachedUser,
    showToast: input.showToast,
    setMyWorkspaces: input.setMyWorkspaces,
    setSwitchingWorkspaceId: input.setSwitchingWorkspaceId,
  });
}

function processSwitcherSubmenuKeyDown(input: {
  event: React.KeyboardEvent<HTMLDivElement>;
  getSwitcherItems: () => HTMLElement[];
  closeSwitcherToTrigger: () => void;
}) {
  const { event, getSwitcherItems, closeSwitcherToTrigger } = input;
  const items = getSwitcherItems();
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    handleMenuRovingFocusKeyDown({ event, items });
    if (items.length !== 0) {
      event.stopPropagation();
    }

    return;
  }

  switch (event.key) {
    case "ArrowLeft":
      event.preventDefault();
      event.stopPropagation();
      closeSwitcherToTrigger();
      break;
    case "Escape":
      event.preventDefault();
      event.stopPropagation();
      closeSwitcherToTrigger();
      break;
    default:
      break;
  }
}

function rememberWorkspaceShellLocation(input: {
  userId: string | null;
  workspaceId: string | undefined;
  location: string;
}) {
  const { userId, workspaceId, location } = input;
  if (userId === null || userId === "" || workspaceId === undefined) {
    return;
  }
  try {
    rememberWorkspaceLocation({
      storage: window.sessionStorage,
      userId,
      workspaceId,
      location,
    });
  } catch (error) {
    ignoreBrowserStorageFailure(error);
  }
}

function DroppableTaskNavItem({
  taskView,
  href,
  isActive,
  canDrop,
  isDraggingTask,
  onPointerDown,
  children,
}: {
  taskView: AssignedTaskView;
  href: string;
  isActive: boolean;
  canDrop: boolean;
  isDraggingTask: boolean;
  onPointerDown: () => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: taskViewDropTargetId(taskView),
    disabled: !canDrop,
  });

  return (
    <Link
      ref={setNodeRef}
      href={href}
      prefetch={true}
      className={[
        "workspace-category-item",
        isActive ? "is-active" : "",
        canDrop ? "is-task-drop-target" : "",
        canDrop && isOver ? "is-task-drop-over" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={onPointerDown}
      onClick={(event) => {
        if (isDraggingTask) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </Link>
  );
}

function readMemoryStatusQueryEnabled(input: {
  sessionToken: string | undefined;
  memoryWorkspaceId: string | undefined;
  session: ReturnType<typeof useAuth>["session"];
}) {
  const { sessionToken, memoryWorkspaceId, session } = input;

  return (
    sessionToken !== undefined &&
    sessionToken !== "" &&
    memoryWorkspaceId !== undefined &&
    session !== null &&
    session.user.source !== "guest"
  );
}

function useWorkspaceShellMemoryNavigation(input: {
  session: ReturnType<typeof useAuth>["session"];
  userId: string | null;
  workspaceId: string | undefined;
}) {
  const { session, userId, workspaceId } = input;
  const sessionToken = session?.token;
  const memoryWorkspaceId = session?.user.workspaceId;
  const memoryStatus = useQuery({
    queryKey: ["relationship-memory", userId, memoryWorkspaceId, "status"],
    queryFn: () => {
      if (sessionToken === undefined || memoryWorkspaceId === undefined) {
        throw new Error(WORKSPACE_SHELL_MESSAGES.memoryStatusRequiresWorkspace);
      }

      return getMemoryStatus({ token: sessionToken, workspaceId: memoryWorkspaceId });
    },
    enabled: readMemoryStatusQueryEnabled({ sessionToken, memoryWorkspaceId, session }),
    staleTime: MEMORY_STATUS_STALE_TIME_MS,
    gcTime: MEMORY_STATUS_GC_MINUTES * MILLISECONDS_PER_MINUTE,
  });
  const isMemoryNavigationVisible = canShowMemoryNavigation({
    user: session?.user,
    isStatusAvailable: memoryStatus.data?.available,
  });
  useMemoryNavigationCache({
    session: {
      token: session?.token ?? "",
      userId: userId ?? "",
      workspaceId: workspaceId ?? "",
    },
    isEnabled: session?.token !== undefined && session.token !== "" && isMemoryNavigationVisible,
  });

  return { memoryStatus, isMemoryNavigationVisible };
}

function readShouldRunEndMeetingTransitionFromSession() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.sessionStorage.getItem(WORKSPACE_END_MEETING_TRANSITION_KEY) === "1";
}

function useWorkspaceShellEndMeetingTransition(input: { isEndMeetingContentReady: boolean }) {
  const { isEndMeetingContentReady } = input;
  const [shouldRunEndMeetingTransition, setShouldRunEndMeetingTransition] = useState(
    readShouldRunEndMeetingTransitionFromSession,
  );
  const [isEndMeetingBackgroundRevealed, setIsEndMeetingBackgroundRevealed] = useState(false);
  const [isEndMeetingLoaderExiting, setIsEndMeetingLoaderExiting] = useState(false);
  const [isEndMeetingTransitionRevealed, setIsEndMeetingTransitionRevealed] = useState(
    () => !shouldRunEndMeetingTransition,
  );
  const [isEndMeetingMinimumElapsed, setIsEndMeetingMinimumElapsed] = useState(() => !shouldRunEndMeetingTransition);
  const workspaceLayoutRef = useRef<HTMLDivElement | null>(null);

  const finishEndMeetingTransition = useCallback(() => {
    if (!shouldRunEndMeetingTransition) {
      return;
    }

    setIsEndMeetingBackgroundRevealed(true);
    setIsEndMeetingLoaderExiting(true);
    setIsEndMeetingTransitionRevealed(true);
    setIsEndMeetingMinimumElapsed(true);
    markEndMeetingRevealComplete();
    setShouldRunEndMeetingTransition(false);
  }, [shouldRunEndMeetingTransition]);

  useEffect(
    () =>
      setupEndMeetingTransitionOnMount({
        shouldRunEndMeetingTransition,
        setIsEndMeetingBackgroundRevealed,
        setIsEndMeetingLoaderExiting,
        setIsEndMeetingTransitionRevealed,
        setIsEndMeetingMinimumElapsed,
      }),
    [shouldRunEndMeetingTransition],
  );

  useEffect(
    () =>
      attachEndMeetingContentRevealTransition({
        shouldRunEndMeetingTransition,
        isEndMeetingMinimumElapsed,
        isEndMeetingContentReady,
        finishEndMeetingTransition,
        workspaceLayoutRef,
        setIsEndMeetingBackgroundRevealed,
        setIsEndMeetingLoaderExiting,
        setIsEndMeetingTransitionRevealed,
        setShouldRunEndMeetingTransition,
      }),
    [isEndMeetingContentReady, finishEndMeetingTransition, isEndMeetingMinimumElapsed, shouldRunEndMeetingTransition],
  );

  return {
    shouldRunEndMeetingTransition,
    isEndMeetingBackgroundRevealed,
    isEndMeetingLoaderExiting,
    isEndMeetingTransitionRevealed,
    isEndMeetingMinimumElapsed,
    workspaceLayoutRef,
    finishEndMeetingTransition,
  };
}

function readWorkspaceShellBannerUserId(input: {
  session: ReturnType<typeof useAuth>["session"];
  userId: string | null;
}) {
  return input.session?.user.source === "guest" ? null : input.userId;
}

function useWorkspaceShellPromoBanners(input: {
  session: ReturnType<typeof useAuth>["session"];
  userId: string | null;
  isAuthLoading: boolean;
}) {
  const bannerUserId = readWorkspaceShellBannerUserId({ session: input.session, userId: input.userId });
  const trialBanner = useTrialBanner({ userId: bannerUserId, isAuthLoading: input.isAuthLoading });
  const marketplaceBanner = useMarketplaceBanner({ userId: bannerUserId, isAuthLoading: input.isAuthLoading });

  return { trialBanner, marketplaceBanner };
}

function useWorkspaceShellMineTaskCount(input: {
  session: ReturnType<typeof useAuth>["session"];
  userId: string | null;
}) {
  const { session, userId } = input;
  const sessionToken = session?.token;
  const todayTasksQuery = useQuery({
    queryKey: personalAssignedTasksQueryKey(userId),
    queryFn: () => {
      if (sessionToken === undefined) {
        throw new Error(WORKSPACE_SHELL_MESSAGES.assignedTasksRequireSession);
      }

      return listPersonalAssignedTasks(sessionToken);
    },
    enabled: session?.token !== undefined && session.token !== "" && userId !== null && userId !== "",
    staleTime: PERSONAL_TASKS_STALE_TIME_MS,
  });
  const activeWorkspaceTasks = filterUnifiedAssignedTasksByWorkspace({
    tasks: todayTasksQuery.data?.tasks ?? [],
    workspaceId: session?.user.workspaceId,
  });
  const mineTaskCount = filterUnifiedAssignedTasksByView({ tasks: activeWorkspaceTasks, view: "mine" }).length;

  return { todayTasksQuery, mineTaskCount };
}

function useWorkspaceShellMobileNavigation(input: {
  workspaceLocationKey: string;
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const [isMobileNavigationOpen, setIsMobileNavigationOpen] = useState(false);
  const mobileNavigationRef = useRef<HTMLDivElement | null>(null);
  const mobileNavigationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavigationMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setIsMobileNavigationOpen(false);
  }, [input.workspaceLocationKey]);

  useEffect(
    () =>
      attachWorkspaceShellMobileViewportListener({
        setIsAccountMenuOpen: input.setIsAccountMenuOpen,
        setIsMobileNavigationOpen,
      }),
    [input.setIsAccountMenuOpen],
  );

  useEffect(
    () =>
      attachMobileNavigationOpenSideEffects({
        isOpen: isMobileNavigationOpen,
        mobileNavigationRef,
        mobileNavigationMenuRef,
        mobileNavigationTriggerRef,
        setIsMobileNavigationOpen,
      }),
    [isMobileNavigationOpen],
  );

  return {
    isMobileNavigationOpen,
    setIsMobileNavigationOpen,
    mobileNavigationRef,
    mobileNavigationTriggerRef,
    mobileNavigationMenuRef,
  };
}

function readWorkspaceShellAvatarPresentation(input: {
  session: ReturnType<typeof useAuth>["session"];
  hasAvatarError: boolean;
}) {
  const shouldShowAvatarImage =
    // avatarUrl is null (not undefined) for users without a photo; both mean "show initials".
    typeof input.session?.user.avatarUrl === "string" && input.session.user.avatarUrl !== "" && !input.hasAvatarError;
  const avatarInitials = getWorkspaceUserInitials({
    displayName: input.session?.user.displayName,
    email: input.session?.user.email,
  });
  const avatarImageUrl = shouldShowAvatarImage ? (input.session?.user.avatarUrl ?? undefined) : undefined;

  return { shouldShowAvatarImage, avatarInitials, avatarImageUrl };
}

function useWorkspaceShellAccountWorkspaceList(input: { session: ReturnType<typeof useAuth>["session"] }) {
  const { session } = input;
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [myWorkspaces, setMyWorkspaces] = useState<Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null>(
    null,
  );
  const [hasWorkspacesLoadFailed, setHasWorkspacesLoadFailed] = useState(false);
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null);
  const [hasAvatarError, setHasAvatarError] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const accountDropdownRef = useRef<HTMLDivElement | null>(null);
  const [accountDropdownPosition, setAccountDropdownPosition] = useState<{ top: number; left: number } | null>(null);
  const shouldAutoFocusAccountMenuRef = useRef(false);
  const avatarPresentation = readWorkspaceShellAvatarPresentation({ session, hasAvatarError });
  const canUseWorkspaceSwitcher = canShowWorkspaceSwitcherMenu({
    isSignedIn: Boolean(session),
    userSource: session?.user.source,
    workspaceCount: myWorkspaces?.length ?? null,
  });
  const loadMyWorkspaces = useCallback(() => {
    if (session?.token === undefined || session.token === "" || session.user.source === "guest") {
      return;
    }
    void fetchWorkspaceSwitcherList({
      token: session.token,
      setMyWorkspaces,
      setHasWorkspacesLoadFailed,
    });
  }, [session?.token, session?.user.source]);

  useEffect(() => {
    if (!isAccountMenuOpen || myWorkspaces !== null || hasWorkspacesLoadFailed) {
      return;
    }
    loadMyWorkspaces();
  }, [hasWorkspacesLoadFailed, isAccountMenuOpen, loadMyWorkspaces, myWorkspaces]);

  useEffect(() => {
    if (!isAccountMenuOpen) {
      setHasWorkspacesLoadFailed(false);
    }
  }, [isAccountMenuOpen]);

  return {
    isAccountMenuOpen,
    setIsAccountMenuOpen,
    myWorkspaces,
    setMyWorkspaces,
    hasWorkspacesLoadFailed,
    switchingWorkspaceId,
    setSwitchingWorkspaceId,
    hasAvatarError,
    setHasAvatarError,
    accountMenuRef,
    accountDropdownRef,
    accountDropdownPosition,
    setAccountDropdownPosition,
    shouldAutoFocusAccountMenuRef,
    ...avatarPresentation,
    canUseWorkspaceSwitcher,
    loadMyWorkspaces,
  };
}

function useWorkspaceShellAccountSwitcherSwitch(input: {
  session: ReturnType<typeof useAuth>["session"];
  pathname: string;
  router: ReturnType<typeof useRouter>;
  refreshSession: ReturnType<typeof useAuth>["refreshSession"];
  updateCachedUser: ReturnType<typeof useAuth>["updateCachedUser"];
  showToast: ReturnType<typeof useToast>["showToast"];
  isAccountMenuOpen: boolean;
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  accountMenuRef: React.RefObject<HTMLDivElement | null>;
  accountDropdownRef: React.RefObject<HTMLDivElement | null>;
  setAccountDropdownPosition: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>;
  setMyWorkspaces: React.Dispatch<
    React.SetStateAction<Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null>
  >;
  switchingWorkspaceId: string | null;
  setSwitchingWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const [isWorkspaceSwitcherOpen, setIsWorkspaceSwitcherOpen] = useState(false);
  const workspaceShortcutPrefixRef = useRef<WorkspaceShortcutPrefix>(null);
  const workspaceSwitcherTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceSwitcherSubmenuRef = useRef<HTMLDivElement | null>(null);
  const [switcherSubmenuPosition, setSwitcherSubmenuPosition] = useState<{ top: number; left: number } | null>(null);

  const handleSwitchWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!input.session) {
        return;
      }
      await runWorkspaceShellSwitchWorkspace({
        workspaceId,
        session: input.session,
        switchingWorkspaceId: input.switchingWorkspaceId,
        pathname: input.pathname,
        router: input.router,
        refreshSession: input.refreshSession,
        updateCachedUser: input.updateCachedUser,
        showToast: input.showToast,
        setIsAccountMenuOpen: input.setIsAccountMenuOpen,
        setSwitchingWorkspaceId: input.setSwitchingWorkspaceId,
        setMyWorkspaces: input.setMyWorkspaces,
      });
    },
    [
      input.pathname,
      input.refreshSession,
      input.router,
      input.session,
      input.showToast,
      input.switchingWorkspaceId,
      input.updateCachedUser,
      input.setIsAccountMenuOpen,
      input.setMyWorkspaces,
      input.setSwitchingWorkspaceId,
    ],
  );

  useEffect(() => {
    if (!input.isAccountMenuOpen) {
      setIsWorkspaceSwitcherOpen(false);
    }
  }, [input.isAccountMenuOpen]);

  useEffect(
    () =>
      attachWorkspaceShellRafMeasure({
        isEnabled: input.isAccountMenuOpen,
        onDisabled: () => input.setAccountDropdownPosition(null),
        measure: () =>
          measureWorkspaceAccountDropdownPosition({
            accountMenuRef: input.accountMenuRef,
            setAccountDropdownPosition: input.setAccountDropdownPosition,
          }),
      }),
    [input.isAccountMenuOpen, input.accountMenuRef, input.setAccountDropdownPosition],
  );

  useEffect(
    () =>
      attachWorkspaceShellRafMeasure({
        isEnabled: isWorkspaceSwitcherOpen,
        onDisabled: () => setSwitcherSubmenuPosition(null),
        measure: () =>
          measureWorkspaceSwitcherSubmenuPosition({
            workspaceSwitcherTriggerRef,
            accountDropdownRef: input.accountDropdownRef,
            setSwitcherSubmenuPosition,
          }),
      }),
    [isWorkspaceSwitcherOpen, input.accountDropdownRef],
  );

  return {
    isWorkspaceSwitcherOpen,
    setIsWorkspaceSwitcherOpen,
    workspaceShortcutPrefixRef,
    workspaceSwitcherTriggerRef,
    workspaceSwitcherSubmenuRef,
    switcherSubmenuPosition,
    handleSwitchWorkspace,
  };
}

function useWorkspaceShellAccountSwitcherFocus(input: {
  isAccountMenuOpen: boolean;
  isWorkspaceSwitcherOpen: boolean;
  accountDropdownRef: React.RefObject<HTMLDivElement | null>;
  accountDropdownPosition: { top: number; left: number } | null;
  shouldAutoFocusAccountMenuRef: React.RefObject<boolean>;
  workspaceSwitcherSubmenuRef: React.RefObject<HTMLDivElement | null>;
  switcherSubmenuPosition: { top: number; left: number } | null;
  setIsWorkspaceSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
  workspaceSwitcherTriggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const shouldAutoFocusAccountMenuRef = input.shouldAutoFocusAccountMenuRef;
  const getAccountMenuItems = useCallback(() => {
    const dropdown = input.accountDropdownRef.current;
    if (!dropdown) {
      return [];
    }

    return Array.from(dropdown.querySelectorAll<HTMLElement>("[data-account-item]"));
  }, [input.accountDropdownRef]);

  const hasAutoFocusedAccountMenuRef = useRef(false);
  useEffect(() => {
    if (!input.isAccountMenuOpen) {
      hasAutoFocusedAccountMenuRef.current = false;
      shouldAutoFocusAccountMenuRef.current = false;

      return;
    }
    if (!shouldAutoFocusAccountMenuRef.current) {
      return;
    }
    if (hasAutoFocusedAccountMenuRef.current || !input.accountDropdownPosition || input.isWorkspaceSwitcherOpen) {
      return;
    }
    hasAutoFocusedAccountMenuRef.current = true;
    getAccountMenuItems()[0]?.focus({ preventScroll: true });
  }, [
    input.accountDropdownPosition,
    getAccountMenuItems,
    input.isAccountMenuOpen,
    input.isWorkspaceSwitcherOpen,
    shouldAutoFocusAccountMenuRef,
  ]);

  const handleAccountMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      processAccountMenuKeyDown({
        event,
        workspaceSwitcherSubmenuRef: input.workspaceSwitcherSubmenuRef,
        getAccountMenuItems,
      });
    },
    [getAccountMenuItems, input.workspaceSwitcherSubmenuRef],
  );

  const getSwitcherItems = useCallback(() => {
    const submenu = input.workspaceSwitcherSubmenuRef.current;
    if (!submenu) {
      return [];
    }

    return Array.from(submenu.querySelectorAll<HTMLElement>("[data-switcher-item]:not(:disabled)"));
  }, [input.workspaceSwitcherSubmenuRef]);

  const hasAutoFocusedSwitcherRef = useRef(false);
  useEffect(() => {
    if (!input.isWorkspaceSwitcherOpen) {
      hasAutoFocusedSwitcherRef.current = false;

      return;
    }
    if (hasAutoFocusedSwitcherRef.current || !input.switcherSubmenuPosition) {
      return;
    }
    hasAutoFocusedSwitcherRef.current = true;
    getSwitcherItems()[0]?.focus({ preventScroll: true });
  }, [getSwitcherItems, input.isWorkspaceSwitcherOpen, input.switcherSubmenuPosition]);

  const closeSwitcherToTrigger = useCallback(() => {
    input.setIsWorkspaceSwitcherOpen(false);
    input.workspaceSwitcherTriggerRef.current?.focus({ preventScroll: true });
  }, [input.setIsWorkspaceSwitcherOpen, input.workspaceSwitcherTriggerRef]);

  const handleSwitcherSubmenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      processSwitcherSubmenuKeyDown({
        event,
        getSwitcherItems,
        closeSwitcherToTrigger,
      });
    },
    [closeSwitcherToTrigger, getSwitcherItems],
  );

  return { handleAccountMenuKeyDown, handleSwitcherSubmenuKeyDown, closeSwitcherToTrigger };
}

function useWorkspaceShellAccountSwitcherCommands(input: {
  router: ReturnType<typeof useRouter>;
  logout: ReturnType<typeof useAuth>["logout"];
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  canUseWorkspaceSwitcher: boolean;
  setIsWorkspaceSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const switcherCloseTimerRef = useRef<number | null>(null);
  const cancelSwitcherClose = useCallback(() => {
    if (switcherCloseTimerRef.current !== null) {
      window.clearTimeout(switcherCloseTimerRef.current);
      switcherCloseTimerRef.current = null;
    }
  }, []);
  const scheduleSwitcherClose = useCallback(() => {
    cancelSwitcherClose();
    switcherCloseTimerRef.current = window.setTimeout(() => {
      switcherCloseTimerRef.current = null;
      input.setIsWorkspaceSwitcherOpen(false);
    }, SWITCHER_CLOSE_DELAY_MS);
  }, [cancelSwitcherClose, input.setIsWorkspaceSwitcherOpen]);

  useEffect(() => cancelSwitcherClose, [cancelSwitcherClose]);

  const openWorkspaceSwitcher = useCallback(() => {
    if (!input.canUseWorkspaceSwitcher) {
      return;
    }
    cancelSwitcherClose();
    input.setIsAccountMenuOpen(true);
    input.setIsWorkspaceSwitcherOpen(true);
  }, [
    cancelSwitcherClose,
    input.canUseWorkspaceSwitcher,
    input.setIsAccountMenuOpen,
    input.setIsWorkspaceSwitcherOpen,
  ]);

  const goToCreateWorkspace = useCallback(() => {
    input.setIsAccountMenuOpen(false);
    input.router.push("/workspace/new");
  }, [input.router, input.setIsAccountMenuOpen]);

  const goToSettings = useCallback(() => {
    input.setIsAccountMenuOpen(false);
    input.router.push("/workspace/settings");
  }, [input.router, input.setIsAccountMenuOpen]);

  const signOut = useCallback(() => {
    input.setIsAccountMenuOpen(false);
    void input.logout();
  }, [input.logout, input.setIsAccountMenuOpen]);

  return {
    cancelSwitcherClose,
    scheduleSwitcherClose,
    openWorkspaceSwitcher,
    goToCreateWorkspace,
    goToSettings,
    signOut,
  };
}

function useWorkspaceShellAccountSwitcherControls(input: {
  session: ReturnType<typeof useAuth>["session"];
  pathname: string;
  router: ReturnType<typeof useRouter>;
  refreshSession: ReturnType<typeof useAuth>["refreshSession"];
  updateCachedUser: ReturnType<typeof useAuth>["updateCachedUser"];
  showToast: ReturnType<typeof useToast>["showToast"];
  logout: ReturnType<typeof useAuth>["logout"];
  isAccountMenuOpen: boolean;
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  accountMenuRef: React.RefObject<HTMLDivElement | null>;
  accountDropdownRef: React.RefObject<HTMLDivElement | null>;
  accountDropdownPosition: { top: number; left: number } | null;
  setAccountDropdownPosition: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>;
  shouldAutoFocusAccountMenuRef: React.RefObject<boolean>;
  canUseWorkspaceSwitcher: boolean;
  myWorkspaces: Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null;
  setMyWorkspaces: React.Dispatch<
    React.SetStateAction<Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null>
  >;
  switchingWorkspaceId: string | null;
  setSwitchingWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const switchState = useWorkspaceShellAccountSwitcherSwitch(input);
  const focusState = useWorkspaceShellAccountSwitcherFocus({
    isAccountMenuOpen: input.isAccountMenuOpen,
    isWorkspaceSwitcherOpen: switchState.isWorkspaceSwitcherOpen,
    accountDropdownRef: input.accountDropdownRef,
    accountDropdownPosition: input.accountDropdownPosition,
    shouldAutoFocusAccountMenuRef: input.shouldAutoFocusAccountMenuRef,
    workspaceSwitcherSubmenuRef: switchState.workspaceSwitcherSubmenuRef,
    switcherSubmenuPosition: switchState.switcherSubmenuPosition,
    setIsWorkspaceSwitcherOpen: switchState.setIsWorkspaceSwitcherOpen,
    workspaceSwitcherTriggerRef: switchState.workspaceSwitcherTriggerRef,
  });
  const commandState = useWorkspaceShellAccountSwitcherCommands({
    router: input.router,
    logout: input.logout,
    setIsAccountMenuOpen: input.setIsAccountMenuOpen,
    canUseWorkspaceSwitcher: input.canUseWorkspaceSwitcher,
    setIsWorkspaceSwitcherOpen: switchState.setIsWorkspaceSwitcherOpen,
  });

  useEffect(
    () =>
      attachWorkspaceAccountMenuDismissListeners({
        isAccountMenuOpen: input.isAccountMenuOpen,
        accountMenuRef: input.accountMenuRef,
        accountDropdownRef: input.accountDropdownRef,
        workspaceSwitcherSubmenuRef: switchState.workspaceSwitcherSubmenuRef,
        setIsAccountMenuOpen: input.setIsAccountMenuOpen,
      }),
    [
      input.isAccountMenuOpen,
      input.accountDropdownRef,
      input.accountMenuRef,
      input.setIsAccountMenuOpen,
      switchState.workspaceSwitcherSubmenuRef,
    ],
  );

  useEffect(
    () =>
      attachWorkspaceShellGlobalKeyDownListener({
        workspaceShortcutPrefixRef: switchState.workspaceShortcutPrefixRef,
        isWorkspaceSwitcherOpen: switchState.isWorkspaceSwitcherOpen,
        myWorkspaces: input.myWorkspaces,
        signOut: commandState.signOut,
        goToSettings: commandState.goToSettings,
        openWorkspaceSwitcher: commandState.openWorkspaceSwitcher,
        handleSwitchWorkspace: switchState.handleSwitchWorkspace,
      }),
    [
      commandState.goToSettings,
      switchState.handleSwitchWorkspace,
      switchState.isWorkspaceSwitcherOpen,
      input.myWorkspaces,
      switchState.workspaceShortcutPrefixRef,
      commandState.openWorkspaceSwitcher,
      commandState.signOut,
    ],
  );

  return { ...switchState, ...focusState, ...commandState };
}

function useWorkspaceShellSessionBootstrap(input: { meetings: Meeting[]; isEndMeetingContentReady: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workspaceLocationKey = `${pathname}?${searchParams.toString()}`;
  const { session, isLoading: isAuthLoading, logout, refreshSession, updateCachedUser } = useAuth();
  const { showToast } = useToast();
  const userId = session?.user.id ?? null;
  const workspaceId = session?.user.workspaceId;
  useEffect(() => {
    rememberWorkspaceShellLocation({ userId, workspaceId, location: workspaceLocationKey });
  }, [userId, workspaceId, workspaceLocationKey]);
  const { memoryStatus, isMemoryNavigationVisible } = useWorkspaceShellMemoryNavigation({
    session,
    userId,
    workspaceId,
  });
  const trialOffer = useTrialOffer(session?.user.source === "guest" ? null : session?.token, session?.user.workspaceId);
  useEffect(() => {
    refetchTrialOfferOnWorkspaceNavigation({ session, refetch: trialOffer.refetch });
  }, [pathname, input.meetings.length, session, trialOffer.refetch]);
  const [isMeetingLaunchFadeActive, setIsMeetingLaunchFadeActive] = useState(false);
  const [shouldRunWorkspaceCreationTransition, setShouldRunWorkspaceCreationTransition] = useState(
    readWorkspaceCreationTransition,
  );
  const handleNewMeetingClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      handleWorkspaceNewMeetingClick({
        event,
        session,
        router,
        setIsMeetingLaunchFadeActive,
      });
    },
    [router, session],
  );
  useQuery(workspaceMeetingsOptions(session));
  const { todayTasksQuery, mineTaskCount } = useWorkspaceShellMineTaskCount({ session, userId });
  const endMeeting = useWorkspaceShellEndMeetingTransition({
    isEndMeetingContentReady: input.isEndMeetingContentReady,
  });

  return {
    router,
    pathname,
    workspaceLocationKey,
    session,
    isAuthLoading,
    logout,
    refreshSession,
    updateCachedUser,
    showToast,
    userId,
    workspaceId,
    memoryStatus,
    isMemoryNavigationVisible,
    trialOffer,
    isMeetingLaunchFadeActive,
    setIsMeetingLaunchFadeActive,
    shouldRunWorkspaceCreationTransition,
    setShouldRunWorkspaceCreationTransition,
    handleNewMeetingClick,
    todayTasksQuery,
    mineTaskCount,
    ...endMeeting,
  };
}

function assembleWorkspaceShellRuntimeValue(input: {
  shell: {
    meetings: Meeting[];
    activeSidebarView: WorkspaceShellProps["activeSidebarView"];
    contentClassName: string | undefined;
    taskDropTargets: TaskDropTargets | undefined;
    isEndMeetingContentReady: boolean;
    endMeetingLoadFailure: WorkspaceShellProps["endMeetingLoadFailure"];
    children: React.ReactNode;
  };
  sessionBootstrap: ReturnType<typeof useWorkspaceShellSessionBootstrap>;
  accountWorkspace: ReturnType<typeof useWorkspaceShellAccountWorkspaceList>;
  mobile: ReturnType<typeof useWorkspaceShellMobileNavigation>;
  switcher: ReturnType<typeof useWorkspaceShellAccountSwitcherControls>;
  promo: ReturnType<typeof useWorkspaceShellPromoBanners>;
}) {
  const { shell, sessionBootstrap, accountWorkspace, mobile, switcher, promo } = input;

  return {
    meetings: shell.meetings,
    activeSidebarView: shell.activeSidebarView,
    contentClassName: shell.contentClassName,
    taskDropTargets: shell.taskDropTargets,
    /** @external WorkspaceShell prop */
    endMeetingContentReady: shell.isEndMeetingContentReady,
    endMeetingLoadFailure: shell.endMeetingLoadFailure,
    children: shell.children,
    ...sessionBootstrap,
    ...accountWorkspace,
    ...mobile,
    ...switcher,
    ...promo,
  };
}

function useWorkspaceShellRuntime(props: WorkspaceShellProps) {
  const isEndMeetingContentReady = props.endMeetingContentReady ?? true;
  const sessionBootstrap = useWorkspaceShellSessionBootstrap({ meetings: props.meetings, isEndMeetingContentReady });
  const accountWorkspace = useWorkspaceShellAccountWorkspaceList({ session: sessionBootstrap.session });
  const promo = useWorkspaceShellPromoBanners({
    session: sessionBootstrap.session,
    userId: sessionBootstrap.userId,
    isAuthLoading: sessionBootstrap.isAuthLoading,
  });
  const mobile = useWorkspaceShellMobileNavigation({
    workspaceLocationKey: sessionBootstrap.workspaceLocationKey,
    setIsAccountMenuOpen: accountWorkspace.setIsAccountMenuOpen,
  });
  const switcher = useWorkspaceShellAccountSwitcherControls({
    session: sessionBootstrap.session,
    pathname: sessionBootstrap.pathname,
    router: sessionBootstrap.router,
    refreshSession: sessionBootstrap.refreshSession,
    updateCachedUser: sessionBootstrap.updateCachedUser,
    showToast: sessionBootstrap.showToast,
    logout: sessionBootstrap.logout,
    isAccountMenuOpen: accountWorkspace.isAccountMenuOpen,
    setIsAccountMenuOpen: accountWorkspace.setIsAccountMenuOpen,
    accountMenuRef: accountWorkspace.accountMenuRef,
    accountDropdownRef: accountWorkspace.accountDropdownRef,
    accountDropdownPosition: accountWorkspace.accountDropdownPosition,
    setAccountDropdownPosition: accountWorkspace.setAccountDropdownPosition,
    shouldAutoFocusAccountMenuRef: accountWorkspace.shouldAutoFocusAccountMenuRef,
    canUseWorkspaceSwitcher: accountWorkspace.canUseWorkspaceSwitcher,
    myWorkspaces: accountWorkspace.myWorkspaces,
    setMyWorkspaces: accountWorkspace.setMyWorkspaces,
    switchingWorkspaceId: accountWorkspace.switchingWorkspaceId,
    setSwitchingWorkspaceId: accountWorkspace.setSwitchingWorkspaceId,
  });

  useEffect(
    () =>
      runWorkspaceCreationEnterTransition({
        shouldRun: sessionBootstrap.shouldRunWorkspaceCreationTransition,
        setShouldRun: sessionBootstrap.setShouldRunWorkspaceCreationTransition,
      }),
    [sessionBootstrap.shouldRunWorkspaceCreationTransition, sessionBootstrap.setShouldRunWorkspaceCreationTransition],
  );

  return assembleWorkspaceShellRuntimeValue({
    shell: {
      meetings: props.meetings,
      activeSidebarView: props.activeSidebarView ?? null,
      contentClassName: props.contentClassName,
      taskDropTargets: props.taskDropTargets,
      isEndMeetingContentReady,
      endMeetingLoadFailure: props.endMeetingLoadFailure ?? null,
      children: props.children,
    },
    sessionBootstrap,
    accountWorkspace,
    mobile,
    switcher,
    promo,
  });
}

function WorkspaceShellAccountTrigger(input: {
  isAccountMenuOpen: boolean;
  shouldShowAvatarImage: boolean;
  avatarImageUrl: string | undefined;
  avatarInitials: string;
  shouldAutoFocusAccountMenuRef: React.RefObject<boolean>;
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setHasAvatarError: (value: boolean) => void;
}) {
  const {
    isAccountMenuOpen,
    shouldShowAvatarImage,
    avatarImageUrl,
    avatarInitials,
    shouldAutoFocusAccountMenuRef,
    setIsAccountMenuOpen,
    setHasAvatarError,
  } = input;

  return (
    <button
      type="button"
      className={`workspace-account-trigger${isAccountMenuOpen ? " is-open" : ""}`}
      aria-haspopup="menu"
      aria-expanded={isAccountMenuOpen}
      aria-label={WORKSPACE_SHELL_MESSAGES.openAccountMenuAria}
      onClick={(event) => {
        shouldAutoFocusAccountMenuRef.current = event.detail === 0;
        setIsAccountMenuOpen((isOpen) => !isOpen);
      }}
    >
      <span className="workspace-account-avatar" aria-hidden="true">
        {shouldShowAvatarImage ? (
          <img
            src={avatarImageUrl}
            alt=""
            className="workspace-account-avatar-image"
            referrerPolicy="no-referrer"
            onError={() => setHasAvatarError(true)}
          />
        ) : (
          <span className="workspace-account-avatar-fallback">{avatarInitials}</span>
        )}
      </span>
      <ChevronDownIcon />
    </button>
  );
}

function WorkspaceShellMobileMenuMeetingsTasks(input: {
  activeSidebarView: WorkspaceShellProps["activeSidebarView"];
  mineTaskCount: number;
  finishEndMeetingTransition: () => void;
  closeMobileMenu: () => void;
}) {
  const { activeSidebarView, mineTaskCount, finishEndMeetingTransition, closeMobileMenu } = input;

  return (
    <>
      <section className="workspace-mobile-menu-section">
        <h2>{WORKSPACE_SHELL_MESSAGES.meetingsSection}</h2>
        <div className="workspace-mobile-menu-list">
          <Link
            href="/workspace?view=upcoming"
            prefetch={true}
            className={`workspace-mobile-menu-item${activeSidebarView === "upcoming" ? " is-active" : ""}`}
            onPointerDown={finishEndMeetingTransition}
            onClick={closeMobileMenu}
          >
            <CalendarStackIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.upcomingLabel}</span>
          </Link>
          <Link
            href="/workspace?view=past"
            prefetch={true}
            className={`workspace-mobile-menu-item${activeSidebarView === "past" ? " is-active" : ""}`}
            onPointerDown={finishEndMeetingTransition}
            onClick={closeMobileMenu}
          >
            <ArchiveTrayIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.pastLabel}</span>
          </Link>
        </div>
      </section>

      <section className="workspace-mobile-menu-section">
        <h2>{WORKSPACE_SHELL_MESSAGES.tasksSection}</h2>
        <div className="workspace-mobile-menu-list">
          <Link
            href="/workspace/tasks/mine"
            prefetch={true}
            className={`workspace-mobile-menu-item${activeSidebarView === "tasks-mine" ? " is-active" : ""}`}
            onPointerDown={finishEndMeetingTransition}
            onClick={closeMobileMenu}
          >
            <StarNavIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.mineLabel}</span>
            {mineTaskCount > 0 ? (
              <span
                className="workspace-mobile-menu-count"
                aria-label={WORKSPACE_SHELL_MESSAGES.mineOpenTasksAria({ count: mineTaskCount })}
              >
                {mineTaskCount}
              </span>
            ) : null}
          </Link>
          <Link
            href="/workspace/tasks/others"
            prefetch={true}
            className={`workspace-mobile-menu-item${activeSidebarView === "tasks-others" ? " is-active" : ""}`}
            onPointerDown={finishEndMeetingTransition}
            onClick={closeMobileMenu}
          >
            <LayersNavIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.othersLabel}</span>
          </Link>
          <Link
            href="/workspace/tasks/done"
            prefetch={true}
            className={`workspace-mobile-menu-item${activeSidebarView === "tasks-activity" ? " is-active" : ""}`}
            onPointerDown={finishEndMeetingTransition}
            onClick={closeMobileMenu}
          >
            <ActivityNavIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.doneLabel}</span>
          </Link>
        </div>
      </section>
    </>
  );
}

function WorkspaceShellMobileMenuMemoryAccount(input: {
  isMemoryNavigationVisible: boolean;
  activeSidebarView: WorkspaceShellProps["activeSidebarView"];
  closeMobileMenu: () => void;
  signOut: () => void;
}) {
  const { isMemoryNavigationVisible, activeSidebarView, closeMobileMenu, signOut } = input;

  return (
    <>
      {isMemoryNavigationVisible ? (
        <section className="workspace-mobile-menu-section">
          <h2>{WORKSPACE_SHELL_MESSAGES.memorySection}</h2>
          <div className="workspace-mobile-menu-list">
            <Link
              href="/workspace/memory"
              prefetch={true}
              className={`workspace-mobile-menu-item${activeSidebarView === "memory-all" ? " is-active" : ""}`}
              onClick={closeMobileMenu}
            >
              <MemoryAllNavIcon />
              <span>{WORKSPACE_SHELL_MESSAGES.memoryAllLabel}</span>
            </Link>
            <Link
              href="/workspace/memory/people"
              prefetch={true}
              className={`workspace-mobile-menu-item${activeSidebarView === "memory-people" ? " is-active" : ""}`}
              onClick={closeMobileMenu}
            >
              <PeopleNavIcon />
              <span>{WORKSPACE_SHELL_MESSAGES.memoryPeopleLabel}</span>
            </Link>
          </div>
        </section>
      ) : null}

      <section className="workspace-mobile-menu-section">
        <h2>{WORKSPACE_SHELL_MESSAGES.accountSection}</h2>
        <div className="workspace-mobile-menu-list">
          <button
            type="button"
            className="workspace-mobile-menu-item workspace-mobile-menu-logout"
            onClick={() => {
              closeMobileMenu();
              signOut();
            }}
          >
            <WorkspaceLogoutIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.logOutLabel}</span>
          </button>
        </div>
      </section>
    </>
  );
}

function WorkspaceShellMobileNavigation(input: {
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsAccountMenuOpen: (value: boolean) => void;
  mobileNavigationRef: React.RefObject<HTMLDivElement | null>;
  mobileNavigationTriggerRef: React.RefObject<HTMLButtonElement | null>;
  mobileNavigationMenuRef: React.RefObject<HTMLDivElement | null>;
  handleNewMeetingClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  activeSidebarView: WorkspaceShellProps["activeSidebarView"];
  mineTaskCount: number;
  finishEndMeetingTransition: () => void;
  isMemoryNavigationVisible: boolean;
  signOut: () => void;
}) {
  const {
    isOpen,
    setIsOpen,
    setIsAccountMenuOpen,
    mobileNavigationRef,
    mobileNavigationTriggerRef,
    mobileNavigationMenuRef,
    handleNewMeetingClick,
    activeSidebarView,
    mineTaskCount,
    finishEndMeetingTransition,
    isMemoryNavigationVisible,
    signOut,
  } = input;
  const closeMobileMenu = () => setIsOpen(false);

  return (
    <div
      ref={mobileNavigationRef}
      className={`workspace-mobile-navigation${isOpen ? " is-open" : ""}`}
      role={isOpen ? "dialog" : undefined}
      aria-modal={isOpen ? "true" : undefined}
      aria-label={isOpen ? "Workspace menu" : undefined}
    >
      <button
        ref={mobileNavigationTriggerRef}
        type="button"
        className={`workspace-mobile-menu-trigger${isOpen ? " is-open" : ""}`}
        aria-label={
          isOpen ? WORKSPACE_SHELL_MESSAGES.closeWorkspaceMenuAria : WORKSPACE_SHELL_MESSAGES.openWorkspaceMenuAria
        }
        aria-controls="workspace-mobile-menu"
        aria-expanded={isOpen}
        onClick={() => {
          setIsAccountMenuOpen(false);
          setIsOpen((isMenuOpen) => !isMenuOpen);
        }}
      >
        <WorkspaceMobileMenuIcon />
      </button>

      {isOpen ? (
        <div id="workspace-mobile-menu" className="workspace-mobile-menu-backdrop">
          <Link
            href="/meet"
            className="workspace-new-meeting-button workspace-mobile-new-meeting-button"
            onClick={(event) => {
              closeMobileMenu();
              handleNewMeetingClick(event);
            }}
          >
            <VideoPlusIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.newMeetingLabel}</span>
          </Link>

          <nav
            ref={mobileNavigationMenuRef}
            className="workspace-mobile-menu"
            aria-label={WORKSPACE_SHELL_MESSAGES.workspaceNavigationAria}
          >
            <WorkspaceShellMobileMenuMeetingsTasks
              activeSidebarView={activeSidebarView}
              mineTaskCount={mineTaskCount}
              finishEndMeetingTransition={finishEndMeetingTransition}
              closeMobileMenu={closeMobileMenu}
            />
            <WorkspaceShellMobileMenuMemoryAccount
              isMemoryNavigationVisible={isMemoryNavigationVisible}
              activeSidebarView={activeSidebarView}
              closeMobileMenu={closeMobileMenu}
              signOut={signOut}
            />
          </nav>
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceShellEndMeetingHandoffOverlay(input: {
  shouldShowHandoffOverlay: boolean;
  isEndMeetingLoaderExiting: boolean;
  finishEndMeetingTransition: () => void;
  router: ReturnType<typeof useRouter>;
  endMeetingShellProps: Pick<WorkspaceShellProps, "endMeetingContentReady" | "endMeetingLoadFailure">;
}) {
  if (!input.shouldShowHandoffOverlay) {
    return null;
  }

  const loadFailure = input.endMeetingShellProps.endMeetingLoadFailure;
  const shouldShowRecoveryActions =
    loadFailure !== null && loadFailure !== undefined && input.endMeetingShellProps.endMeetingContentReady !== true;

  return (
    <EndMeetingAnalysisOverlay
      flow={
        shouldShowRecoveryActions
          ? {
              ...END_MEETING_WORKSPACE_HANDOFF_FLOW,
              activeLabel: loadFailure.message,
              transientError: loadFailure.message,
            }
          : END_MEETING_WORKSPACE_HANDOFF_FLOW
      }
      now={0}
      isExiting={input.isEndMeetingLoaderExiting}
      isHandoff
      recoveryActions={
        shouldShowRecoveryActions ? (
          <div className="live-end-meeting-recovery-actions">
            <button type="button" onClick={loadFailure.retry}>
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                input.finishEndMeetingTransition();
                input.router.push("/workspace");
              }}
            >
              Back to workspace
            </button>
          </div>
        ) : undefined
      }
    />
  );
}

function WorkspaceShellMeetingsNav(input: {
  activeSidebarView: WorkspaceShellProps["activeSidebarView"];
  finishEndMeetingTransition: () => void;
}) {
  const { activeSidebarView, finishEndMeetingTransition } = input;

  return (
    <section className="workspace-sidebar-group workspace-primary-nav-group">
      <div className="workspace-nav-header">
        <h2>{WORKSPACE_SHELL_MESSAGES.meetingsSection}</h2>
      </div>

      <div className="workspace-category-list">
        <Link
          href="/workspace?view=upcoming"
          prefetch={true}
          className={`workspace-category-item${activeSidebarView === "upcoming" ? " is-active" : ""}`}
          onPointerDown={finishEndMeetingTransition}
        >
          <span className="workspace-category-item-main">
            <CalendarStackIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.upcomingLabel}</span>
          </span>
        </Link>

        <Link
          href="/workspace?view=past"
          prefetch={true}
          className={`workspace-category-item${activeSidebarView === "past" ? " is-active" : ""}`}
          onPointerDown={finishEndMeetingTransition}
        >
          <span className="workspace-category-item-main">
            <ArchiveTrayIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.pastLabel}</span>
          </span>
        </Link>
      </div>
    </section>
  );
}

function WorkspaceShellMemoryNav(input: {
  isVisible: boolean;
  activeSidebarView: WorkspaceShellProps["activeSidebarView"];
}) {
  const { isVisible, activeSidebarView } = input;
  if (!isVisible) {
    return null;
  }

  return (
    <section className="workspace-sidebar-group workspace-primary-nav-group">
      <div className="workspace-nav-header">
        <h2>{WORKSPACE_SHELL_MESSAGES.memorySection}</h2>
      </div>
      <div className="workspace-category-list">
        <Link
          href="/workspace/memory"
          prefetch={true}
          className={`workspace-category-item${activeSidebarView === "memory-all" ? " is-active" : ""}`}
        >
          <span className="workspace-category-item-main">
            <MemoryAllNavIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.memoryAllLabel}</span>
          </span>
        </Link>
        <Link
          href="/workspace/memory/people"
          prefetch={true}
          className={`workspace-category-item${activeSidebarView === "memory-people" ? " is-active" : ""}`}
        >
          <span className="workspace-category-item-main">
            <PeopleNavIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.memoryPeopleLabel}</span>
          </span>
        </Link>
      </div>
    </section>
  );
}

function WorkspaceShellRailPromoCards(input: {
  marketplaceBanner: ReturnType<typeof useMarketplaceBanner>;
  trialBanner: ReturnType<typeof useTrialBanner>;
  trialOffer: ReturnType<typeof useTrialOffer>;
}) {
  const { marketplaceBanner, trialBanner, trialOffer } = input;

  if (marketplaceBanner.visible) {
    return (
      <section className="workspace-beta-credit-card" aria-label={WORKSPACE_SHELL_MESSAGES.marketplaceCardAria}>
        <button
          type="button"
          className="workspace-beta-credit-dismiss"
          aria-label={WORKSPACE_SHELL_MESSAGES.marketplaceDismissAria}
          onClick={marketplaceBanner.dismiss}
        >
          ×
        </button>
        <div className="workspace-beta-credit-card-main">
          <span className="workspace-beta-credit-icon-wrap" aria-hidden="true">
            <span className="workspace-beta-credit-icon">
              <GoogleIcon />
            </span>
          </span>
          <div>
            <strong>{WORKSPACE_SHELL_MESSAGES.marketplaceTitle}</strong>
            <p>{WORKSPACE_SHELL_MESSAGES.marketplaceBody}</p>
          </div>
        </div>
        <a
          href="https://workspace.google.com/marketplace/app/ready/1011295591976"
          target="_blank"
          rel="noopener noreferrer"
          className="workspace-beta-credit-link"
        >
          <span>{WORKSPACE_SHELL_MESSAGES.marketplaceInstall}</span>
          <ArrowForwardIcon />
        </a>
      </section>
    );
  }

  if (marketplaceBanner.showTrial && trialBanner.visible && trialOffer.remaining > 0) {
    return (
      <section className="workspace-beta-credit-card" aria-label={WORKSPACE_SHELL_MESSAGES.trialCardAria}>
        <button
          type="button"
          className="workspace-beta-credit-dismiss"
          aria-label={WORKSPACE_SHELL_MESSAGES.trialDismissAria}
          onClick={trialBanner.dismiss}
        >
          ×
        </button>
        <div className="workspace-beta-credit-card-main">
          <span className="workspace-beta-credit-icon-wrap">
            <GiftIcon />
          </span>
          <div>
            <strong>
              {trialOffer.remaining >= TRIAL_BANNER_MIN_REMAINING_MEETINGS
                ? WORKSPACE_SHELL_MESSAGES.trialFirstMeetingsFree
                : trialOfferTitle(trialOffer.remaining)}
            </strong>
            <p>{WORKSPACE_SHELL_MESSAGES.trialBody}</p>
          </div>
        </div>
        <Link href="/workspace/settings?tab=billing" className="workspace-beta-credit-link">
          <span>{WORKSPACE_SHELL_MESSAGES.viewPlansLabel}</span>
          <ArrowForwardIcon />
        </Link>
      </section>
    );
  }

  return null;
}

function WorkspaceShellTasksNav(input: {
  activeSidebarView: WorkspaceShellProps["activeSidebarView"];
  taskDropTargets: TaskDropTargets | undefined;
  mineTaskCount: number;
  finishEndMeetingTransition: () => void;
}) {
  const { activeSidebarView, taskDropTargets, mineTaskCount, finishEndMeetingTransition } = input;

  return (
    <section className="workspace-sidebar-group workspace-primary-nav-group">
      <div className="workspace-nav-header">
        <h2>{WORKSPACE_SHELL_MESSAGES.tasksSection}</h2>
      </div>

      <div className="workspace-category-list">
        <TaskNavItem
          taskView="mine"
          href="/workspace/tasks/mine"
          isActive={activeSidebarView === "tasks-mine"}
          dropTargets={taskDropTargets}
          onPointerDown={finishEndMeetingTransition}
        >
          <span className="workspace-category-item-main">
            <StarNavIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.mineLabel}</span>
          </span>
          {mineTaskCount > 0 ? (
            <span
              className="workspace-category-count"
              aria-label={WORKSPACE_SHELL_MESSAGES.mineOpenTasksAria({ count: mineTaskCount })}
            >
              {mineTaskCount}
            </span>
          ) : null}
        </TaskNavItem>

        <TaskNavItem
          taskView="others"
          href="/workspace/tasks/others"
          isActive={activeSidebarView === "tasks-others"}
          dropTargets={taskDropTargets}
          onPointerDown={finishEndMeetingTransition}
        >
          <span className="workspace-category-item-main">
            <LayersNavIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.othersLabel}</span>
          </span>
        </TaskNavItem>

        <TaskNavItem
          taskView="done"
          href="/workspace/tasks/done"
          isActive={activeSidebarView === "tasks-activity"}
          dropTargets={taskDropTargets}
          onPointerDown={finishEndMeetingTransition}
        >
          <span className="workspace-category-item-main">
            <ActivityNavIcon />
            <span>{WORKSPACE_SHELL_MESSAGES.doneLabel}</span>
          </span>
        </TaskNavItem>
      </div>
    </section>
  );
}

function WorkspaceShellAccountDropdownSettingsLinks(input: {
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <>
      <Link
        href="/workspace/settings"
        className="workspace-account-dropdown-item"
        role="menuitem"
        data-account-item
        tabIndex={-1}
        onClick={() => input.setIsAccountMenuOpen(false)}
      >
        <span className="workspace-account-dropdown-label">{WORKSPACE_SHELL_MESSAGES.settingsLabel}</span>
        <span className="workspace-account-dropdown-shortcut" aria-hidden="true">
          <span>{WORKSPACE_SHELL_MESSAGES.shortcutSettingsFirst}</span>
          <span>{WORKSPACE_SHELL_MESSAGES.shortcutThen}</span>
          <span>{WORKSPACE_SHELL_MESSAGES.shortcutSettingsSecond}</span>
        </span>
      </Link>
      <Link
        href="/workspace/settings?tab=members"
        className="workspace-account-dropdown-item"
        role="menuitem"
        data-account-item
        tabIndex={-1}
        onClick={() => input.setIsAccountMenuOpen(false)}
      >
        <span className="workspace-account-dropdown-label">{WORKSPACE_SHELL_MESSAGES.invitePeopleLabel}</span>
      </Link>
      <span className="workspace-account-dropdown-divider" aria-hidden="true" />
    </>
  );
}

function WorkspaceShellWorkspaceSwitcherWorkspaceRows(input: {
  myWorkspaces: NonNullable<Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"]>;
  session: ReturnType<typeof useAuth>["session"];
  switchingWorkspaceId: string | null;
  handleSwitchWorkspace: (workspaceId: string) => Promise<void>;
}) {
  const { myWorkspaces, session, switchingWorkspaceId, handleSwitchWorkspace } = input;

  return myWorkspaces.map((workspace, index) => (
    <button
      key={workspace.id}
      type="button"
      className="workspace-account-dropdown-item workspace-switcher-item"
      role="menuitemradio"
      aria-checked={workspace.id === session?.user.workspaceId}
      data-switcher-item
      tabIndex={-1}
      disabled={switchingWorkspaceId !== null}
      onClick={() => void handleSwitchWorkspace(workspace.id)}
    >
      {workspace.logoUrl !== null && workspace.logoUrl !== "" ? (
        <img className="workspace-switcher-logo" src={workspace.logoUrl} alt="" />
      ) : (
        <span className="workspace-switcher-logo workspace-switcher-logo-fallback">
          <WorkspaceGlyphIcon />
        </span>
      )}
      <span className="workspace-switcher-name">
        {switchingWorkspaceId === workspace.id ? WORKSPACE_SHELL_MESSAGES.workspaceSwitching : workspace.name}
      </span>
      <span className="workspace-switcher-check" aria-hidden="true">
        {workspace.id === session?.user.workspaceId ? <WorkspaceCheckIcon /> : null}
      </span>
      {index < WORKSPACE_SWITCHER_MAX_INDEX ? (
        <span className="workspace-switcher-index" aria-hidden="true">
          {WORKSPACE_SHELL_MESSAGES.workspaceShortcutIndex({ index: index + 1 })}
        </span>
      ) : null}
    </button>
  ));
}

function WorkspaceShellWorkspaceSwitcherSubmenuPanel(input: {
  session: ReturnType<typeof useAuth>["session"];
  myWorkspaces: Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null;
  hasWorkspacesLoadFailed: boolean;
  switchingWorkspaceId: string | null;
  loadMyWorkspaces: () => void;
  goToCreateWorkspace: () => void;
  handleSwitchWorkspace: (workspaceId: string) => Promise<void>;
  workspaceSwitcherSubmenuRef: React.RefObject<HTMLDivElement | null>;
  switcherSubmenuPosition: { top: number; left: number };
  cancelSwitcherClose: () => void;
  scheduleSwitcherClose: () => void;
  handleSwitcherSubmenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const {
    session,
    myWorkspaces,
    hasWorkspacesLoadFailed,
    switchingWorkspaceId,
    loadMyWorkspaces,
    goToCreateWorkspace,
    handleSwitchWorkspace,
    workspaceSwitcherSubmenuRef,
    switcherSubmenuPosition,
    cancelSwitcherClose,
    scheduleSwitcherClose,
    handleSwitcherSubmenuKeyDown,
  } = input;

  return (
    <div
      ref={workspaceSwitcherSubmenuRef}
      className="workspace-switcher-submenu"
      role="menu"
      aria-label={WORKSPACE_SHELL_MESSAGES.switchWorkspaceMenuAria}
      style={{ top: switcherSubmenuPosition.top, left: switcherSubmenuPosition.left }}
      onMouseEnter={cancelSwitcherClose}
      onMouseLeave={scheduleSwitcherClose}
      onKeyDown={handleSwitcherSubmenuKeyDown}
    >
      {session?.user.email !== undefined && session.user.email !== "" ? (
        <span className="workspace-account-dropdown-heading workspace-switcher-account-heading">
          {session.user.email}
        </span>
      ) : null}
      {myWorkspaces === null ? (
        hasWorkspacesLoadFailed ? (
          <span className="workspace-switcher-empty">
            {WORKSPACE_SHELL_MESSAGES.workspacesLoadFailed}
            <button
              type="button"
              className="workspace-switcher-retry"
              role="menuitem"
              data-switcher-item
              tabIndex={-1}
              onClick={loadMyWorkspaces}
            >
              {WORKSPACE_SHELL_MESSAGES.workspacesRetry}
            </button>
          </span>
        ) : (
          <span className="workspace-loading-status" role="status">
            {WORKSPACE_SHELL_MESSAGES.workspacesLoading}
          </span>
        )
      ) : (
        <WorkspaceShellWorkspaceSwitcherWorkspaceRows
          myWorkspaces={myWorkspaces}
          session={session}
          switchingWorkspaceId={switchingWorkspaceId}
          handleSwitchWorkspace={handleSwitchWorkspace}
        />
      )}
      <span className="workspace-account-dropdown-divider" aria-hidden="true" />
      <button
        type="button"
        className="workspace-account-dropdown-item"
        role="menuitem"
        data-switcher-item
        tabIndex={-1}
        onClick={goToCreateWorkspace}
      >
        <span className="workspace-account-dropdown-label">{WORKSPACE_SHELL_MESSAGES.createWorkspaceLabel}</span>
      </button>
    </div>
  );
}

function WorkspaceShellWorkspaceSwitcherHoverMenu(input: {
  isWorkspaceSwitcherOpen: boolean;
  setIsWorkspaceSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
  cancelSwitcherClose: () => void;
  scheduleSwitcherClose: () => void;
  openWorkspaceSwitcher: () => void;
  workspaceSwitcherTriggerRef: React.RefObject<HTMLButtonElement | null>;
  switcherSubmenuPosition: { top: number; left: number } | null;
  session: ReturnType<typeof useAuth>["session"];
  myWorkspaces: Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null;
  hasWorkspacesLoadFailed: boolean;
  switchingWorkspaceId: string | null;
  loadMyWorkspaces: () => void;
  goToCreateWorkspace: () => void;
  handleSwitchWorkspace: (workspaceId: string) => Promise<void>;
  workspaceSwitcherSubmenuRef: React.RefObject<HTMLDivElement | null>;
  handleSwitcherSubmenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const {
    isWorkspaceSwitcherOpen,
    setIsWorkspaceSwitcherOpen,
    cancelSwitcherClose,
    scheduleSwitcherClose,
    openWorkspaceSwitcher,
    workspaceSwitcherTriggerRef,
    switcherSubmenuPosition,
    session,
    myWorkspaces,
    hasWorkspacesLoadFailed,
    switchingWorkspaceId,
    loadMyWorkspaces,
    goToCreateWorkspace,
    handleSwitchWorkspace,
    workspaceSwitcherSubmenuRef,
    handleSwitcherSubmenuKeyDown,
  } = input;

  return (
    <div
      className="workspace-switcher-submenu-wrap"
      onMouseEnter={() => {
        cancelSwitcherClose();
        setIsWorkspaceSwitcherOpen(true);
      }}
      onMouseLeave={scheduleSwitcherClose}
    >
      <button
        ref={workspaceSwitcherTriggerRef}
        type="button"
        className={`workspace-account-dropdown-item workspace-switcher-trigger${isWorkspaceSwitcherOpen ? " is-open" : ""}`}
        role="menuitem"
        data-account-item
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={isWorkspaceSwitcherOpen}
        onClick={openWorkspaceSwitcher}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            openWorkspaceSwitcher();
          }
        }}
      >
        <span className="workspace-account-dropdown-label">{WORKSPACE_SHELL_MESSAGES.switchWorkspaceLabel}</span>
        <span className="workspace-account-dropdown-shortcut" aria-hidden="true">
          <span>{WORKSPACE_SHELL_MESSAGES.shortcutSwitcherFirst}</span>
          <span>{WORKSPACE_SHELL_MESSAGES.shortcutThen}</span>
          <span>{WORKSPACE_SHELL_MESSAGES.shortcutSwitcherSecond}</span>
        </span>
        <span className="workspace-switcher-caret" aria-hidden="true">
          <WorkspaceCaretIcon />
        </span>
      </button>

      {isWorkspaceSwitcherOpen && switcherSubmenuPosition && typeof document !== "undefined"
        ? createPortal(
            <WorkspaceShellWorkspaceSwitcherSubmenuPanel
              session={session}
              myWorkspaces={myWorkspaces}
              hasWorkspacesLoadFailed={hasWorkspacesLoadFailed}
              switchingWorkspaceId={switchingWorkspaceId}
              loadMyWorkspaces={loadMyWorkspaces}
              goToCreateWorkspace={goToCreateWorkspace}
              handleSwitchWorkspace={handleSwitchWorkspace}
              workspaceSwitcherSubmenuRef={workspaceSwitcherSubmenuRef}
              switcherSubmenuPosition={switcherSubmenuPosition}
              cancelSwitcherClose={cancelSwitcherClose}
              scheduleSwitcherClose={scheduleSwitcherClose}
              handleSwitcherSubmenuKeyDown={handleSwitcherSubmenuKeyDown}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function WorkspaceShellPrimaryRailSidebar(input: {
  activeSidebarView: WorkspaceShellProps["activeSidebarView"];
  taskDropTargets: TaskDropTargets | undefined;
  mineTaskCount: number;
  finishEndMeetingTransition: () => void;
  isMemoryNavigationVisible: boolean;
  marketplaceBanner: ReturnType<typeof useMarketplaceBanner>;
  trialBanner: ReturnType<typeof useTrialBanner>;
  trialOffer: ReturnType<typeof useTrialOffer>;
}) {
  const {
    activeSidebarView,
    taskDropTargets,
    mineTaskCount,
    finishEndMeetingTransition,
    isMemoryNavigationVisible,
    marketplaceBanner,
    trialBanner,
    trialOffer,
  } = input;

  return (
    <>
      <div className="workspace-primary-rail-content">
        <WorkspaceShellMeetingsNav
          activeSidebarView={activeSidebarView}
          finishEndMeetingTransition={finishEndMeetingTransition}
        />

        <WorkspaceShellTasksNav
          activeSidebarView={activeSidebarView}
          taskDropTargets={taskDropTargets}
          mineTaskCount={mineTaskCount}
          finishEndMeetingTransition={finishEndMeetingTransition}
        />

        <WorkspaceShellMemoryNav isVisible={isMemoryNavigationVisible} activeSidebarView={activeSidebarView} />
      </div>

      <WorkspaceShellRailPromoCards
        marketplaceBanner={marketplaceBanner}
        trialBanner={trialBanner}
        trialOffer={trialOffer}
      />
    </>
  );
}

function WorkspaceShellAccountDropdownSignOutItem(input: { signOut: () => void }) {
  return (
    <button
      type="button"
      className="workspace-account-dropdown-item"
      role="menuitem"
      data-account-item
      tabIndex={-1}
      onClick={input.signOut}
    >
      <span className="workspace-account-dropdown-label">{WORKSPACE_SHELL_MESSAGES.logOutLabel}</span>
      <span className="workspace-account-dropdown-shortcut" aria-hidden="true">
        <span>{WORKSPACE_SHELL_MESSAGES.shortcutLogOutAlt}</span>
        <span>{WORKSPACE_SHELL_MESSAGES.shortcutLogOutShift}</span>
        <span>{WORKSPACE_SHELL_MESSAGES.shortcutLogOutKey}</span>
      </span>
    </button>
  );
}

function WorkspaceShellAccountDropdownPortal(input: {
  isAccountMenuOpen: boolean;
  accountDropdownPosition: { top: number; left: number } | null;
  accountDropdownRef: React.RefObject<HTMLDivElement | null>;
  handleAccountMenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  canUseWorkspaceSwitcher: boolean;
  isWorkspaceSwitcherOpen: boolean;
  setIsWorkspaceSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
  cancelSwitcherClose: () => void;
  scheduleSwitcherClose: () => void;
  openWorkspaceSwitcher: () => void;
  workspaceSwitcherTriggerRef: React.RefObject<HTMLButtonElement | null>;
  switcherSubmenuPosition: { top: number; left: number } | null;
  session: ReturnType<typeof useAuth>["session"];
  myWorkspaces: Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null;
  hasWorkspacesLoadFailed: boolean;
  switchingWorkspaceId: string | null;
  loadMyWorkspaces: () => void;
  goToCreateWorkspace: () => void;
  handleSwitchWorkspace: (workspaceId: string) => Promise<void>;
  workspaceSwitcherSubmenuRef: React.RefObject<HTMLDivElement | null>;
  handleSwitcherSubmenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  signOut: () => void;
}) {
  if (!input.isAccountMenuOpen || !input.accountDropdownPosition || typeof document === "undefined") {
    return null;
  }

  const position = input.accountDropdownPosition;

  return createPortal(
    <div
      ref={input.accountDropdownRef}
      className="workspace-account-dropdown"
      role="menu"
      aria-label={WORKSPACE_SHELL_MESSAGES.accountMenuAria}
      style={{ top: position.top, left: position.left }}
      onKeyDown={input.handleAccountMenuKeyDown}
    >
      <WorkspaceShellAccountDropdownSettingsLinks setIsAccountMenuOpen={input.setIsAccountMenuOpen} />
      {input.canUseWorkspaceSwitcher ? (
        <WorkspaceShellWorkspaceSwitcherHoverMenu
          isWorkspaceSwitcherOpen={input.isWorkspaceSwitcherOpen}
          setIsWorkspaceSwitcherOpen={input.setIsWorkspaceSwitcherOpen}
          cancelSwitcherClose={input.cancelSwitcherClose}
          scheduleSwitcherClose={input.scheduleSwitcherClose}
          openWorkspaceSwitcher={input.openWorkspaceSwitcher}
          workspaceSwitcherTriggerRef={input.workspaceSwitcherTriggerRef}
          switcherSubmenuPosition={input.switcherSubmenuPosition}
          session={input.session}
          myWorkspaces={input.myWorkspaces}
          hasWorkspacesLoadFailed={input.hasWorkspacesLoadFailed}
          switchingWorkspaceId={input.switchingWorkspaceId}
          loadMyWorkspaces={input.loadMyWorkspaces}
          goToCreateWorkspace={input.goToCreateWorkspace}
          handleSwitchWorkspace={input.handleSwitchWorkspace}
          workspaceSwitcherSubmenuRef={input.workspaceSwitcherSubmenuRef}
          handleSwitcherSubmenuKeyDown={input.handleSwitcherSubmenuKeyDown}
        />
      ) : null}
      <WorkspaceShellAccountDropdownSignOutItem signOut={input.signOut} />
    </div>,
    document.body,
  );
}

function WorkspaceShellAccountMenuRegion(input: {
  accountMenuRef: React.RefObject<HTMLDivElement | null>;
  isAccountMenuOpen: boolean;
  shouldShowAvatarImage: boolean;
  avatarImageUrl: string | undefined;
  avatarInitials: string;
  shouldAutoFocusAccountMenuRef: React.RefObject<boolean>;
  setIsAccountMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setHasAvatarError: (value: boolean) => void;
  accountDropdownPosition: { top: number; left: number } | null;
  accountDropdownRef: React.RefObject<HTMLDivElement | null>;
  handleAccountMenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  canUseWorkspaceSwitcher: boolean;
  isWorkspaceSwitcherOpen: boolean;
  setIsWorkspaceSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
  cancelSwitcherClose: () => void;
  scheduleSwitcherClose: () => void;
  openWorkspaceSwitcher: () => void;
  workspaceSwitcherTriggerRef: React.RefObject<HTMLButtonElement | null>;
  switcherSubmenuPosition: { top: number; left: number } | null;
  session: ReturnType<typeof useAuth>["session"];
  myWorkspaces: Awaited<ReturnType<typeof getMyWorkspace>>["workspaces"] | null;
  hasWorkspacesLoadFailed: boolean;
  switchingWorkspaceId: string | null;
  loadMyWorkspaces: () => void;
  goToCreateWorkspace: () => void;
  handleSwitchWorkspace: (workspaceId: string) => Promise<void>;
  workspaceSwitcherSubmenuRef: React.RefObject<HTMLDivElement | null>;
  handleSwitcherSubmenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  signOut: () => void;
}) {
  return (
    <div className="workspace-account-menu" ref={input.accountMenuRef}>
      <WorkspaceShellAccountTrigger
        isAccountMenuOpen={input.isAccountMenuOpen}
        shouldShowAvatarImage={input.shouldShowAvatarImage}
        avatarImageUrl={input.avatarImageUrl}
        avatarInitials={input.avatarInitials}
        shouldAutoFocusAccountMenuRef={input.shouldAutoFocusAccountMenuRef}
        setIsAccountMenuOpen={input.setIsAccountMenuOpen}
        setHasAvatarError={input.setHasAvatarError}
      />
      <WorkspaceShellAccountDropdownPortal {...input} />
    </div>
  );
}

function WorkspaceShellDesktopPrimaryRail(input: { runtime: ReturnType<typeof useWorkspaceShellRuntime> }) {
  const { runtime } = input;

  return (
    <aside className="workspace-primary-rail">
      <div className="workspace-primary-rail-top">
        <WorkspaceShellAccountMenuRegion
          accountMenuRef={runtime.accountMenuRef}
          isAccountMenuOpen={runtime.isAccountMenuOpen}
          shouldShowAvatarImage={runtime.shouldShowAvatarImage}
          avatarImageUrl={runtime.avatarImageUrl}
          avatarInitials={runtime.avatarInitials}
          shouldAutoFocusAccountMenuRef={runtime.shouldAutoFocusAccountMenuRef}
          setIsAccountMenuOpen={runtime.setIsAccountMenuOpen}
          setHasAvatarError={runtime.setHasAvatarError}
          accountDropdownPosition={runtime.accountDropdownPosition}
          accountDropdownRef={runtime.accountDropdownRef}
          handleAccountMenuKeyDown={runtime.handleAccountMenuKeyDown}
          canUseWorkspaceSwitcher={runtime.canUseWorkspaceSwitcher}
          isWorkspaceSwitcherOpen={runtime.isWorkspaceSwitcherOpen}
          setIsWorkspaceSwitcherOpen={runtime.setIsWorkspaceSwitcherOpen}
          cancelSwitcherClose={runtime.cancelSwitcherClose}
          scheduleSwitcherClose={runtime.scheduleSwitcherClose}
          openWorkspaceSwitcher={runtime.openWorkspaceSwitcher}
          workspaceSwitcherTriggerRef={runtime.workspaceSwitcherTriggerRef}
          switcherSubmenuPosition={runtime.switcherSubmenuPosition}
          session={runtime.session}
          myWorkspaces={runtime.myWorkspaces}
          hasWorkspacesLoadFailed={runtime.hasWorkspacesLoadFailed}
          switchingWorkspaceId={runtime.switchingWorkspaceId}
          loadMyWorkspaces={runtime.loadMyWorkspaces}
          goToCreateWorkspace={runtime.goToCreateWorkspace}
          handleSwitchWorkspace={runtime.handleSwitchWorkspace}
          workspaceSwitcherSubmenuRef={runtime.workspaceSwitcherSubmenuRef}
          handleSwitcherSubmenuKeyDown={runtime.handleSwitcherSubmenuKeyDown}
          signOut={runtime.signOut}
        />

        <Link href="/meet" className="workspace-new-meeting-button" onClick={runtime.handleNewMeetingClick}>
          <VideoPlusIcon />
          <span>{WORKSPACE_SHELL_MESSAGES.newMeetingLabel}</span>
        </Link>
      </div>

      <WorkspaceShellPrimaryRailSidebar
        activeSidebarView={runtime.activeSidebarView}
        taskDropTargets={runtime.taskDropTargets}
        mineTaskCount={runtime.mineTaskCount}
        finishEndMeetingTransition={runtime.finishEndMeetingTransition}
        isMemoryNavigationVisible={runtime.isMemoryNavigationVisible}
        marketplaceBanner={runtime.marketplaceBanner}
        trialBanner={runtime.trialBanner}
        trialOffer={runtime.trialOffer}
      />
    </aside>
  );
}

function WorkspaceShellView(runtime: ReturnType<typeof useWorkspaceShellRuntime>) {
  const {
    activeSidebarView,
    contentClassName,
    /** @external WorkspaceShell prop */
    endMeetingContentReady,
    endMeetingLoadFailure,
    children,
    router,
    isMeetingLaunchFadeActive,
    shouldRunWorkspaceCreationTransition,
    handleNewMeetingClick,
    mineTaskCount,
    shouldRunEndMeetingTransition,
    isEndMeetingBackgroundRevealed,
    isEndMeetingLoaderExiting,
    isEndMeetingTransitionRevealed,
    isMobileNavigationOpen,
    setIsMobileNavigationOpen,
    setIsAccountMenuOpen,
    mobileNavigationRef,
    mobileNavigationTriggerRef,
    mobileNavigationMenuRef,
    workspaceLayoutRef,
    finishEndMeetingTransition,
    isMemoryNavigationVisible,
    signOut,
  } = runtime;

  return (
    <div
      ref={workspaceLayoutRef}
      className={buildWorkspaceShellLayoutClassName({
        shouldRunWorkspaceCreationTransition,
        shouldRunEndMeetingTransition,
        isEndMeetingBackgroundRevealed,
        isEndMeetingTransitionRevealed,
      })}
    >
      <WorkspaceShellEndMeetingHandoffOverlay
        shouldShowHandoffOverlay={shouldRunEndMeetingTransition}
        endMeetingShellProps={{ endMeetingContentReady, endMeetingLoadFailure }}
        isEndMeetingLoaderExiting={isEndMeetingLoaderExiting}
        finishEndMeetingTransition={finishEndMeetingTransition}
        router={router}
      />
      {isMeetingLaunchFadeActive ? <div className="workspace-meeting-launch-fade" aria-hidden="true" /> : null}
      <WorkspaceShellDesktopPrimaryRail runtime={runtime} />

      <WorkspaceShellMobileNavigation
        isOpen={isMobileNavigationOpen}
        setIsOpen={setIsMobileNavigationOpen}
        setIsAccountMenuOpen={setIsAccountMenuOpen}
        mobileNavigationRef={mobileNavigationRef}
        mobileNavigationTriggerRef={mobileNavigationTriggerRef}
        mobileNavigationMenuRef={mobileNavigationMenuRef}
        handleNewMeetingClick={handleNewMeetingClick}
        activeSidebarView={activeSidebarView}
        mineTaskCount={mineTaskCount}
        finishEndMeetingTransition={finishEndMeetingTransition}
        isMemoryNavigationVisible={isMemoryNavigationVisible}
        signOut={signOut}
      />

      <main
        className={resolveWorkspaceContentClassName(contentClassName)}
        aria-hidden={isMobileNavigationOpen || undefined}
        inert={isMobileNavigationOpen || undefined}
      >
        {children}
      </main>
    </div>
  );
}

export function WorkspaceShell({
  meetings,
  activeSidebarView = null,
  contentClassName,
  taskDropTargets,
  endMeetingContentReady: isEndMeetingContentReadyFromShell = true,
  endMeetingLoadFailure = null,
  children,
}: WorkspaceShellProps) {
  const runtime = useWorkspaceShellRuntime({
    meetings,
    activeSidebarView,
    contentClassName,
    taskDropTargets,
    endMeetingContentReady: isEndMeetingContentReadyFromShell,
    endMeetingLoadFailure,
    children,
  });

  return <WorkspaceShellView {...runtime} />;
}
