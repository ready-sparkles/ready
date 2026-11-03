export const WORKSPACE_END_MEETING_TRANSITION_KEY = "readymeet-workspace-end-meeting-transition";
export const WORKSPACE_END_MEETING_DETAIL_KEY = "readymeet-workspace-end-meeting-detail";
export const WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY = "readymeet-workspace-end-meeting-reveal-complete";
export const WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT = "readymeet:workspace-end-meeting-reveal-complete";
const WORKSPACE_END_MEETING_NOTES_REVEAL_PENDING_KEY = "readymeet-workspace-end-meeting-notes-reveal-pending";
export const WORKSPACE_END_MEETING_PREPARATION_KEY = "readymeet-workspace-end-meeting-preparation";
export const WORKSPACE_END_MEETING_BACKGROUND_FADE_MS = 520;
export const WORKSPACE_END_MEETING_LOADER_FADE_MS = 340;
export const WORKSPACE_END_MEETING_REVEAL_DELAY_MS = 100;
export const WORKSPACE_END_MEETING_TRANSITION_SETTLE_MS = 420;
export const WORKSPACE_CREATION_TRANSITION_KEY = "readymeet-workspace-creation-transition";
export const WORKSPACE_CREATION_EXIT_FADE_MS = 160;
export const WORKSPACE_CREATION_ENTER_FADE_MS = 220;
const WORKSPACE_SWITCH_EXIT_FADE_MS = 160;
const WORKSPACE_SWITCH_ENTER_FADE_MS = 220;

const WORKSPACE_SWITCH_TRANSITION_CLASS = "is-workspace-switch-transitioning";
const WORKSPACE_SWITCH_FADE_OUT_CLASS = "is-workspace-switch-fade-out";
const WORKSPACE_SWITCH_HIDDEN_CLASS = "is-workspace-switch-hidden";
const WORKSPACE_SWITCH_FADE_IN_CLASS = "is-workspace-switch-fade-in";
const WORKSPACE_SWITCH_PHASE_CLASSES = [
  WORKSPACE_SWITCH_FADE_OUT_CLASS,
  WORKSPACE_SWITCH_HIDDEN_CLASS,
  WORKSPACE_SWITCH_FADE_IN_CLASS,
];

export function markWorkspaceNotesRevealPending(meetingId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(WORKSPACE_END_MEETING_NOTES_REVEAL_PENDING_KEY, meetingId);
  } catch (error) {
    void error;
    // Best-effort handoff. Static notes remain usable when storage is unavailable.
  }
}

export function hasWorkspaceNotesRevealPending(meetingId: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.sessionStorage.getItem(WORKSPACE_END_MEETING_NOTES_REVEAL_PENDING_KEY) === meetingId;
  } catch (error) {
    void error;

    return false;
  }
}

export function clearWorkspaceNotesRevealPending(meetingId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (window.sessionStorage.getItem(WORKSPACE_END_MEETING_NOTES_REVEAL_PENDING_KEY) === meetingId) {
      window.sessionStorage.removeItem(WORKSPACE_END_MEETING_NOTES_REVEAL_PENDING_KEY);
    }
  } catch (error) {
    void error;
    // Best-effort cleanup.
  }
}

/**
 * Workspace-scoped list and settings routes can update in place when the
 * active workspace changes. Avoiding a redundant navigation keeps their
 * shared left rail mounted for the entire content transition. Resource routes
 * such as a meeting detail must return to the workspace root because their
 * current identifier belongs to the previous workspace.
 */
export function getWorkspaceSwitchNavigationTarget(pathname: string | null): "/workspace" | null {
  if (
    pathname === "/workspace" ||
    pathname === "/workspace/" ||
    /^\/workspace\/settings\/?$/.test(pathname ?? "") ||
    /^\/workspace\/tasks(?:\/|$)/.test(pathname ?? "") ||
    /^\/workspace\/mail(?:\/|$)/.test(pathname ?? "")
  ) {
    return null;
  }

  return "/workspace";
}

async function waitForWorkspaceSwitchFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

async function waitForWorkspaceSwitchDuration(duration: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, duration);
  });
}

function setWorkspaceSwitchPhase(phaseClass: string): void {
  const root = document.documentElement;
  root.classList.add(WORKSPACE_SWITCH_TRANSITION_CLASS);
  root.classList.remove(...WORKSPACE_SWITCH_PHASE_CLASSES);
  root.classList.add(phaseClass);
}

function clearWorkspaceSwitchFade(): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.classList.remove(WORKSPACE_SWITCH_TRANSITION_CLASS, ...WORKSPACE_SWITCH_PHASE_CLASSES);
}

export function isWorkspaceSwitchTransitionActive(): boolean {
  return (
    typeof document !== "undefined" && document.documentElement.classList.contains(WORKSPACE_SWITCH_TRANSITION_CLASS)
  );
}

export async function fadeOutWorkspaceForSwitch(): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  document.documentElement.classList.add(WORKSPACE_SWITCH_TRANSITION_CLASS);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return false;
  }

  setWorkspaceSwitchPhase(WORKSPACE_SWITCH_FADE_OUT_CLASS);
  await waitForWorkspaceSwitchDuration(WORKSPACE_SWITCH_EXIT_FADE_MS);
  setWorkspaceSwitchPhase(WORKSPACE_SWITCH_HIDDEN_CLASS);

  return true;
}

export async function fadeInWorkspaceAfterSwitch(shouldAnimate: boolean): Promise<void> {
  if (!shouldAnimate || typeof window === "undefined") {
    clearWorkspaceSwitchFade();

    return;
  }

  setWorkspaceSwitchPhase(WORKSPACE_SWITCH_HIDDEN_CLASS);
  await waitForWorkspaceSwitchFrame();
  setWorkspaceSwitchPhase(WORKSPACE_SWITCH_FADE_IN_CLASS);
  await waitForWorkspaceSwitchDuration(WORKSPACE_SWITCH_ENTER_FADE_MS);
  clearWorkspaceSwitchFade();
}
