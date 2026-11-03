"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { getApiErrorMessage, getMyWorkspace, setActiveWorkspace } from "../../composition/api";
import { syncActiveWorkspaceSession } from "../../composition/workspace-session-sync";
import {
  fadeInWorkspaceAfterSwitch,
  fadeOutWorkspaceForSwitch,
  getWorkspaceSwitchNavigationTarget,
  isWorkspaceSwitchTransitionActive,
} from "../../composition/workspace-transition";
import { isEditableShortcutTarget } from "../../domain/keyboard-shortcuts";
import {
  canUseWorkspaceSwitchHotkeyOnPath,
  resolveWorkspaceSwitchHotkey,
} from "../../domain/workspace-switcher-shortcuts";

import { useAuth } from "./auth-provider";
import { useToast } from "./toast-provider";

const MESSAGE_WORKSPACE_SWITCH_REFRESH_REQUIRED = "Could not switch workspace. Refresh Ready before continuing.";
const TOAST_WORKSPACE_SWITCH_FAILED_ID = "workspace-switch-hotkey-failed";
const MESSAGE_WORKSPACE_SWITCH_FAILED = "Could not switch workspace.";

function isMeetingRoomMounted() {
  return Boolean(document.querySelector('[data-readymeet-meeting-room="true"]'));
}

/** Global listener mounted once in the app providers. */
export function WorkspaceSwitchHotkeys() {
  const pathname = usePathname();
  const router = useRouter();
  const { session, refreshSession, updateCachedUser } = useAuth();
  const { showToast } = useToast();
  const isSwitchingRef = useRef(false);

  const isHotkeyListenerEnabled = Boolean(
    session && session.user.source !== "guest" && canUseWorkspaceSwitchHotkeyOnPath(pathname),
  );

  useEffect(() => {
    if (!isHotkeyListenerEnabled || !session) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) {
        return;
      }
      if (isMeetingRoomMounted()) {
        return;
      }
      const index = resolveWorkspaceSwitchHotkey(event);
      if (index === null) {
        return;
      }
      event.preventDefault();
      if (isSwitchingRef.current || isWorkspaceSwitchTransitionActive()) {
        return;
      }
      isSwitchingRef.current = true;

      void (async () => {
        const animationState = { shouldAnimateWorkspaceSwitch: false };
        try {
          const payload = await getMyWorkspace(session.token);
          const workspace = payload.workspaces[index];
          if (!workspace || workspace.id === session.user.workspaceId) {
            return;
          }
          if (isWorkspaceSwitchTransitionActive()) {
            return;
          }
          const [activationResult, fadeResult] = await Promise.allSettled([
            setActiveWorkspace({ token: session.token, workspaceId: workspace.id }),
            fadeOutWorkspaceForSwitch(),
          ]);
          if (fadeResult.status === "fulfilled") {
            animationState.shouldAnimateWorkspaceSwitch = fadeResult.value;
          } else {
            throw fadeResult.reason;
          }
          if (activationResult.status === "rejected") {
            throw activationResult.reason;
          }
          const nextSession = await syncActiveWorkspaceSession({
            token: session.token,
            workspaceId: workspace.id,
            refreshSession,
            updateCachedUser,
          });
          if (!nextSession) {
            throw new Error(MESSAGE_WORKSPACE_SWITCH_REFRESH_REQUIRED);
          }
          const navigationTarget = getWorkspaceSwitchNavigationTarget(pathname);
          if (navigationTarget !== null) {
            router.push(navigationTarget);
          }
          await fadeInWorkspaceAfterSwitch(animationState.shouldAnimateWorkspaceSwitch);
        } catch (error) {
          await fadeInWorkspaceAfterSwitch(animationState.shouldAnimateWorkspaceSwitch);
          showToast({
            id: TOAST_WORKSPACE_SWITCH_FAILED_ID,
            message: getApiErrorMessage({ error, fallback: MESSAGE_WORKSPACE_SWITCH_FAILED }),
            tone: "warning",
          });
        } finally {
          isSwitchingRef.current = false;
        }
      })();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isHotkeyListenerEnabled, pathname, refreshSession, router, session, showToast, updateCachedUser]);

  return null;
}
