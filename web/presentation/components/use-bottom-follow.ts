"use client";

import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const SMOOTH_SCROLL_LOCK_MS = 420;
const INSTANT_SCROLL_LOCK_MS = 80;
const FOLLOW_LATEST_INTERVAL_MS = 120;
const BOTTOM_FOLLOW_AWAY_THRESHOLD_PX = 48;
const VIEWPORT_BOTTOM_TOLERANCE_PX = 1;

function getDistanceFromBottom(container: HTMLElement | null) {
  if (container) {
    return Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
  }

  const documentElement = document.documentElement;

  return Math.max(0, documentElement.scrollHeight - window.innerHeight - window.scrollY);
}

function isContentEndBelowViewport(input: { container: HTMLElement | null; contentEnd: HTMLElement }) {
  const contentEndBottom = input.contentEnd.getBoundingClientRect().bottom;
  const viewportBottom = input.container ? input.container.getBoundingClientRect().bottom : window.innerHeight;

  return contentEndBottom > viewportBottom + VIEWPORT_BOTTOM_TOLERANCE_PX;
}

type BottomFollowScrollBehavior = ScrollBehavior | "instant";

function scrollBehavior(behavior: BottomFollowScrollBehavior): ScrollBehavior {
  return behavior === "instant" ? "auto" : behavior;
}

function attachBottomFollowListeners(input: {
  containerRef?: RefObject<HTMLElement | null>;
  contentEndRef?: RefObject<HTMLElement | null>;
  followLatestContent: (behavior?: BottomFollowScrollBehavior) => void;
  refreshVisibility: () => void;
  onUserScrollIntent: () => void;
}) {
  const scrollTarget = input.containerRef?.current ?? window;
  const contentEnd = input.contentEndRef?.current ?? null;
  const visibilityFrameId = window.requestAnimationFrame(input.refreshVisibility);
  const contentResizeObserver =
    typeof ResizeObserver === "undefined" || contentEnd === null
      ? null
      : new ResizeObserver(() => {
          input.followLatestContent("instant");
        });
  if (contentResizeObserver !== null && contentEnd !== null) {
    contentResizeObserver.observe(contentEnd);
  }
  scrollTarget.addEventListener("scroll", input.refreshVisibility, { passive: true });
  scrollTarget.addEventListener("pointerdown", input.onUserScrollIntent, { passive: true });
  scrollTarget.addEventListener("touchstart", input.onUserScrollIntent, { passive: true });
  scrollTarget.addEventListener("wheel", input.onUserScrollIntent, { passive: true });
  window.addEventListener("resize", input.refreshVisibility);

  return (): void => {
    window.cancelAnimationFrame(visibilityFrameId);
    contentResizeObserver?.disconnect();
    scrollTarget.removeEventListener("scroll", input.refreshVisibility);
    scrollTarget.removeEventListener("pointerdown", input.onUserScrollIntent);
    scrollTarget.removeEventListener("touchstart", input.onUserScrollIntent);
    scrollTarget.removeEventListener("wheel", input.onUserScrollIntent);
    window.removeEventListener("resize", input.refreshVisibility);
  };
}

function useBottomFollowListeners(input: {
  isActive: boolean;
  shouldObserveWhenInactive: boolean;
  containerRef?: RefObject<HTMLElement | null>;
  contentEndRef?: RefObject<HTMLElement | null>;
  followLatestContent: (behavior?: BottomFollowScrollBehavior) => void;
  refreshVisibility: () => void;
  scrollToBottom: (behavior?: BottomFollowScrollBehavior) => void;
  isFollowingRef: RefObject<boolean>;
  isAutoScrollingRef: RefObject<boolean>;
  autoScrollTimeoutRef: RefObject<number | null>;
  setIsUserAwayFromBottom: (value: boolean) => void;
}) {
  useEffect(() => {
    const {
      isActive,
      shouldObserveWhenInactive,
      containerRef,
      contentEndRef,
      followLatestContent,
      refreshVisibility,
      scrollToBottom,
      isFollowingRef,
      isAutoScrollingRef,
      autoScrollTimeoutRef,
      setIsUserAwayFromBottom,
    } = input;

    if (!isActive && !shouldObserveWhenInactive) {
      isFollowingRef.current = true;
      setIsUserAwayFromBottom(false);

      return;
    }

    if (isActive) {
      scrollToBottom("instant");
    }

    const intervalId = isActive
      ? window.setInterval(() => followLatestContent("instant"), FOLLOW_LATEST_INTERVAL_MS)
      : null;

    const handleUserScrollIntent = (): void => {
      if (autoScrollTimeoutRef.current !== null) {
        window.clearTimeout(autoScrollTimeoutRef.current);
        autoScrollTimeoutRef.current = null;
      }
      isAutoScrollingRef.current = false;
    };

    const detachListeners = attachBottomFollowListeners({
      containerRef,
      contentEndRef,
      followLatestContent: (behavior) => {
        if (isFollowingRef.current) {
          followLatestContent(behavior);
        } else {
          refreshVisibility();
        }
      },
      refreshVisibility,
      onUserScrollIntent: handleUserScrollIntent,
    });

    return (): void => {
      detachListeners();
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    input.autoScrollTimeoutRef,
    input.containerRef,
    input.contentEndRef,
    input.followLatestContent,
    input.isActive,
    input.isAutoScrollingRef,
    input.isFollowingRef,
    input.refreshVisibility,
    input.scrollToBottom,
    input.setIsUserAwayFromBottom,
    input.shouldObserveWhenInactive,
  ]);
}

export function useBottomFollow(input: {
  isActive: boolean;
  containerRef?: RefObject<HTMLElement | null>;
  contentEndRef?: RefObject<HTMLElement | null>;
  shouldObserveWhenInactive?: boolean;
}): {
  isUserAwayFromBottom: boolean;
  followLatestContent: (behavior?: BottomFollowScrollBehavior) => void;
  refreshVisibility: () => void;
  scrollToBottom: (behavior?: BottomFollowScrollBehavior) => void;
} {
  const { isActive, containerRef, contentEndRef, shouldObserveWhenInactive = false } = input;
  const [isUserAwayFromBottom, setIsUserAwayFromBottom] = useState(false);
  const isAutoScrollingRef = useRef(false);
  const autoScrollTimeoutRef = useRef<number | null>(null);
  const isFollowingRef = useRef(true);

  const scrollToBottom = useCallback(
    (behavior: BottomFollowScrollBehavior = "smooth"): void => {
      isFollowingRef.current = true;
      setIsUserAwayFromBottom(false);
      isAutoScrollingRef.current = true;
      if (autoScrollTimeoutRef.current !== null) {
        window.clearTimeout(autoScrollTimeoutRef.current);
      }
      const container = containerRef?.current ?? null;
      const contentEnd = contentEndRef?.current ?? null;
      if (container) {
        const top = contentEnd
          ? container.scrollTop + contentEnd.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom
          : container.scrollHeight;
        container.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior(behavior) });
      } else {
        const top = contentEnd
          ? window.scrollY + contentEnd.getBoundingClientRect().bottom - window.innerHeight
          : document.documentElement.scrollHeight;
        window.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior(behavior) });
      }
      autoScrollTimeoutRef.current = window.setTimeout(
        () => {
          isAutoScrollingRef.current = false;
          autoScrollTimeoutRef.current = null;
        },
        behavior === "smooth" ? SMOOTH_SCROLL_LOCK_MS : INSTANT_SCROLL_LOCK_MS,
      );
    },
    [containerRef, contentEndRef],
  );

  const followLatestContent = useCallback(
    (behavior: BottomFollowScrollBehavior = "instant"): void => {
      if (!isFollowingRef.current || isAutoScrollingRef.current) {
        return;
      }
      const container = containerRef?.current ?? null;
      const contentEnd = contentEndRef?.current ?? null;
      if (contentEnd !== null && !isContentEndBelowViewport({ container, contentEnd })) {
        return;
      }
      scrollToBottom(behavior);
    },
    [containerRef, contentEndRef, scrollToBottom],
  );

  const refreshVisibility = useCallback((): void => {
    if (isAutoScrollingRef.current) {
      return;
    }
    const container = containerRef?.current ?? null;
    const contentEnd = contentEndRef?.current ?? null;
    const isAway =
      contentEnd !== null
        ? isContentEndBelowViewport({ container, contentEnd })
        : getDistanceFromBottom(container) > BOTTOM_FOLLOW_AWAY_THRESHOLD_PX;
    isFollowingRef.current = !isAway;
    setIsUserAwayFromBottom(isAway);
  }, [containerRef, contentEndRef]);

  useBottomFollowListeners({
    isActive,
    shouldObserveWhenInactive,
    containerRef,
    contentEndRef,
    followLatestContent,
    refreshVisibility,
    scrollToBottom,
    isFollowingRef,
    isAutoScrollingRef,
    autoScrollTimeoutRef,
    setIsUserAwayFromBottom,
  });

  useEffect(
    () => (): void => {
      if (autoScrollTimeoutRef.current !== null) {
        window.clearTimeout(autoScrollTimeoutRef.current);
      }
    },
    [],
  );

  return { isUserAwayFromBottom, followLatestContent, refreshVisibility, scrollToBottom };
}
