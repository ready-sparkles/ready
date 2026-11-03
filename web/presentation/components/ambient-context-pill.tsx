"use client";

import type { MeetingAmbientContextItem } from "@readymeet/shared";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";

import { ambientContextMonogram } from "../../domain/ambient-context-view";
import {
  ambientResultVersion,
  type RelevantDetailsPresentation,
  relevantDetailsPresentation,
  type RelevantDetailsWebResult,
} from "../../domain/relevant-details";

const AMBIENT_CONTEXT_PILL_EXIT_MS = 55;
const AMBIENT_CONTEXT_PILL_RESIZE_MS = 140;
const AMBIENT_CONTEXT_PILL_ARRIVAL_GLOW_MS = 520;
const AMBIENT_CONTEXT_PILL_OFFSET_X = -8;
const AMBIENT_CONTEXT_PILL_FADE_DURATION_S = 0.18;
const AMBIENT_CONTEXT_PILL_FADE_EASE_X1 = 0.23;
const AMBIENT_CONTEXT_PILL_FADE_EASE_Y2 = 0.32;
const AMBIENT_CONTEXT_PILL_LAYOUT_DURATION_S = 0.14;
const AMBIENT_CONTEXT_PILL_LAYOUT_EASE_X1 = 0.77;
const AMBIENT_CONTEXT_PILL_LAYOUT_EASE_X3 = 0.175;

const AMBIENT_CONTEXT_PILL_FADE_EASE: [number, number, number, number] = [
  AMBIENT_CONTEXT_PILL_FADE_EASE_X1,
  1,
  AMBIENT_CONTEXT_PILL_FADE_EASE_Y2,
  1,
];
const AMBIENT_CONTEXT_PILL_LAYOUT_EASE: [number, number, number, number] = [
  AMBIENT_CONTEXT_PILL_LAYOUT_EASE_X1,
  0,
  AMBIENT_CONTEXT_PILL_LAYOUT_EASE_X3,
  1,
];

export function AmbientContextPill({
  items,
  webSearchState,
  imageUrls,
  isVisible,
  isOpen,
  onClick,
}: {
  items: MeetingAmbientContextItem[];
  webSearchState: RelevantDetailsWebResult | null;
  imageUrls: Record<string, string>;
  isVisible: boolean;
  isOpen: boolean;
  onClick: (itemKey: string) => void;
}) {
  // The first snapshot (including an asynchronous initial load) is history.
  // Only answers arriving after that baseline while controls are visible glow.
  const observedResults = useRef(new Map<string, string>());
  const shownResults = useRef(new Map<string, string>());
  const hasBaseline = useRef(false);
  const [arrivingResults, setArrivingResults] = useState(new Map<string, string>());
  const webResultKey = webSearchState?.key;
  const resultVersions = useMemo(() => {
    const versions = new Map<string, string>(
      items.flatMap((item) => {
        const version = ambientResultVersion(item);

        return version !== null && version !== "" ? [[`ambient:${item.id}`, version] as const] : [];
      }),
    );
    if (webResultKey !== undefined && webResultKey !== "") {
      versions.set(webResultKey, webResultKey);
    }

    return versions;
  }, [items, webResultKey]);
  const hasItems = items.length !== 0 || Boolean(webResultKey);
  useEffect(() => {
    const fresh = [...resultVersions].filter(([key, version]) => observedResults.current.get(key) !== version);
    resultVersions.forEach((version, key) => {
      observedResults.current.set(key, version);
    });
    if (!isVisible) {
      setArrivingResults((current) => (current.size !== 0 ? new Map() : current));
    } else if (hasBaseline.current && fresh.length !== 0) {
      setArrivingResults((current) => new Map([...current, ...fresh]));
    }
    if (hasItems) {
      hasBaseline.current = true;
    }
  }, [resultVersions, hasItems, isVisible]);
  const webLabel = webSearchState?.label;
  const webUpdatedAt = webSearchState?.updatedAt;
  const nextContent = useMemo(
    () =>
      relevantDetailsPresentation({
        items,
        web:
          webResultKey !== undefined && webResultKey !== "" && webLabel !== undefined && webUpdatedAt !== undefined
            ? { key: webResultKey, label: webLabel, updatedAt: webUpdatedAt }
            : null,
      }),
    [items, webResultKey, webLabel, webUpdatedAt],
  );

  return (
    <AnimatePresence>
      {nextContent ? (
        <AmbientContextPillContent
          key="context-pill"
          shownResults={shownResults.current}
          arrivingResults={arrivingResults}
          nextContent={nextContent}
          imageUrls={imageUrls}
          isVisible={isVisible}
          isOpen={isOpen}
          onClick={onClick}
        />
      ) : null}
    </AnimatePresence>
  );
}

type AmbientContextPillContentProps = {
  shownResults: Map<string, string>;
  arrivingResults: Map<string, string>;
  nextContent: RelevantDetailsPresentation;
  imageUrls: Record<string, string>;
  isVisible: boolean;
  isOpen: boolean;
  onClick: (itemKey: string) => void;
};

function useAmbientPillDisplayedContent(input: {
  nextContent: RelevantDetailsPresentation;
  shouldReduceMotion: boolean | null;
}) {
  const { nextContent, shouldReduceMotion } = input;
  const nextContentKey = nextContent.key;
  const pendingContentRef = useRef(nextContent);
  useLayoutEffect(() => {
    pendingContentRef.current = nextContent;
  }, [nextContent]);
  const displayedContentRef = useRef(nextContent);
  const [displayedContent, setDisplayedContent] = useState(nextContent);
  const [contentTransitionPhase, setContentTransitionPhase] = useState<"visible" | "exiting" | "resizing">("visible");

  useEffect(() => {
    if (displayedContentRef.current.key === nextContentKey) {
      // A short-lived pending mention may fail while the previous subject is
      // fading out. Restore that subject instead of leaving it invisible.
      setContentTransitionPhase("visible");

      return;
    }

    if (shouldReduceMotion === true) {
      const pendingContent = pendingContentRef.current;
      displayedContentRef.current = pendingContent;
      setDisplayedContent(pendingContent);
      setContentTransitionPhase("visible");

      return;
    }

    setContentTransitionPhase("exiting");
    const timers = { revealTimerId: 0 };
    const swapTimerId = window.setTimeout(() => {
      const pendingContent = pendingContentRef.current;
      displayedContentRef.current = pendingContent;
      setDisplayedContent(pendingContent);
      setContentTransitionPhase("resizing");
      timers.revealTimerId = window.setTimeout(() => {
        setContentTransitionPhase("visible");
      }, AMBIENT_CONTEXT_PILL_RESIZE_MS);
    }, AMBIENT_CONTEXT_PILL_EXIT_MS);

    return () => {
      window.clearTimeout(swapTimerId);
      window.clearTimeout(timers.revealTimerId);
    };
  }, [nextContentKey, shouldReduceMotion]);

  const visibleContent = displayedContent.key === nextContentKey ? nextContent : displayedContentRef.current;
  useLayoutEffect(() => {
    displayedContentRef.current = visibleContent;
  }, [visibleContent]);

  return { visibleContent, contentTransitionPhase };
}

function useAmbientPillArrivalGlow(input: {
  shownResults: Map<string, string>;
  isPresent: boolean;
  isVisible: boolean;
  contentTransitionPhase: "visible" | "exiting" | "resizing";
  resultKey: string;
  resultVersion: string | null;
  isArriving: boolean;
  shouldReduceMotion: boolean | null;
}) {
  const {
    shownResults,
    isPresent,
    isVisible,
    contentTransitionPhase,
    resultKey,
    resultVersion,
    isArriving,
    shouldReduceMotion,
  } = input;
  const shownResultsRef = useRef(shownResults);
  useLayoutEffect(() => {
    shownResultsRef.current = shownResults;
  }, [shownResults]);
  const [hasArrivalGlow, setHasArrivalGlow] = useState(false);

  useEffect(() => {
    setHasArrivalGlow(false);
    if (
      !isPresent ||
      !isVisible ||
      contentTransitionPhase !== "visible" ||
      resultVersion === null ||
      resultVersion === "" ||
      !isArriving ||
      shownResultsRef.current.get(resultKey) === resultVersion
    ) {
      return;
    }
    shownResultsRef.current.set(resultKey, resultVersion);
    if (shouldReduceMotion === true) {
      return;
    }
    setHasArrivalGlow(true);
    const timeout = window.setTimeout(() => setHasArrivalGlow(false), AMBIENT_CONTEXT_PILL_ARRIVAL_GLOW_MS);

    return () => window.clearTimeout(timeout);
  }, [resultKey, resultVersion, isArriving, isPresent, isVisible, contentTransitionPhase, shouldReduceMotion]);

  return { hasArrivalGlow };
}

function AmbientContextPillContent(props: AmbientContextPillContentProps) {
  const { shownResults, arrivingResults, nextContent, imageUrls, isVisible, isOpen, onClick } = props;
  const isPresent = useIsPresent();
  const shouldReduceMotion = useReducedMotion();
  const { visibleContent, contentTransitionPhase } = useAmbientPillDisplayedContent({
    nextContent,
    shouldReduceMotion,
  });
  const isLoading = visibleContent.presentation.phase === "loading";
  const displayedImageUrl = visibleContent.item ? (imageUrls[visibleContent.item.id] ?? null) : null;
  const resultKey = visibleContent.selectionKey;
  const resultVersion = visibleContent.resultVersion;
  const isArriving = resultVersion !== null && arrivingResults.get(resultKey) === resultVersion;
  const { hasArrivalGlow } = useAmbientPillArrivalGlow({
    shownResults,
    isPresent,
    isVisible,
    contentTransitionPhase,
    resultKey,
    resultVersion,
    isArriving,
    shouldReduceMotion,
  });

  return (
    <AmbientContextPillContentView
      visibleContent={visibleContent}
      contentTransitionPhase={contentTransitionPhase}
      displayedImageUrl={displayedImageUrl}
      isLoading={isLoading}
      isVisible={isVisible}
      isPresent={isPresent}
      isOpen={isOpen}
      hasArrivalGlow={hasArrivalGlow}
      shouldReduceMotion={shouldReduceMotion}
      onClick={onClick}
    />
  );
}

function ambientContextPillPositionerMotion(input: {
  isVisible: boolean;
  isPresent: boolean;
  shouldReduceMotion: boolean | null;
}) {
  const { isVisible, isPresent, shouldReduceMotion } = input;
  const isReducedMotion = shouldReduceMotion === true;
  const motionOffsetX = isReducedMotion ? 0 : AMBIENT_CONTEXT_PILL_OFFSET_X;
  const fadeDuration = isReducedMotion ? 0 : AMBIENT_CONTEXT_PILL_FADE_DURATION_S;
  const animateOffsetX = isVisible || isReducedMotion ? 0 : AMBIENT_CONTEXT_PILL_OFFSET_X;

  return {
    className: `live-ambient-context-pill-positioner${isVisible && isPresent ? " is-revealed" : ""}`,
    initial: { opacity: 0, x: motionOffsetX },
    animate: { opacity: isVisible ? 1 : 0, x: animateOffsetX },
    exit: { opacity: 0, x: motionOffsetX },
    transition: { duration: fadeDuration, ease: AMBIENT_CONTEXT_PILL_FADE_EASE },
    style: { transition: "none", pointerEvents: isVisible && isPresent ? ("auto" as const) : ("none" as const) },
  };
}

function AmbientContextPillContentView(input: {
  visibleContent: RelevantDetailsPresentation;
  contentTransitionPhase: "visible" | "exiting" | "resizing";
  displayedImageUrl: string | null;
  isLoading: boolean;
  isVisible: boolean;
  isPresent: boolean;
  isOpen: boolean;
  hasArrivalGlow: boolean;
  shouldReduceMotion: boolean | null;
  onClick: (itemKey: string) => void;
}) {
  const {
    visibleContent,
    contentTransitionPhase,
    displayedImageUrl,
    isLoading,
    isVisible,
    isPresent,
    isOpen,
    hasArrivalGlow,
    shouldReduceMotion,
    onClick,
  } = input;
  const positionerMotion = ambientContextPillPositionerMotion({ isVisible, isPresent, shouldReduceMotion });
  const isReducedMotion = shouldReduceMotion === true;
  const researchingSuffix = isLoading ? " Researching." : "";
  const pillClassName = `live-ambient-context-pill is-${visibleContent.presentation.phase}${isOpen ? " is-open" : ""}${hasArrivalGlow ? " has-arrival-glow" : ""}`;

  return (
    <motion.span {...positionerMotion}>
      <motion.button
        layout={isReducedMotion ? false : "size"}
        transition={{
          layout: { duration: AMBIENT_CONTEXT_PILL_LAYOUT_DURATION_S, ease: AMBIENT_CONTEXT_PILL_LAYOUT_EASE },
        }}
        type="button"
        className={pillClassName}
        disabled={!isPresent || !isVisible}
        tabIndex={isPresent && isVisible ? 0 : -1}
        onClick={() => onClick(visibleContent.selectionKey)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={`${visibleContent.presentation.label}.${researchingSuffix} Open relevant details.`}
        title={visibleContent.presentation.label}
      >
        <span className={`live-ambient-context-pill-content is-${contentTransitionPhase}`}>
          <AmbientContextPillIcon
            item={visibleContent.item}
            imageUrl={displayedImageUrl}
            isWebSearch={visibleContent.isWebSearch}
            isLoading={isLoading}
            shouldReduceMotion={Boolean(shouldReduceMotion)}
          />
          <span className="live-ambient-context-pill-label" aria-hidden="true">
            {visibleContent.presentation.label}
          </span>
        </span>
      </motion.button>
    </motion.span>
  );
}

function AmbientContextPillIcon({
  item,
  imageUrl,
  isWebSearch,
  isLoading,
  shouldReduceMotion,
}: {
  item: MeetingAmbientContextItem | null;
  imageUrl: string | null;
  isWebSearch: boolean;
  isLoading: boolean;
  shouldReduceMotion: boolean;
}) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  if (isWebSearch || isLoading) {
    return (
      <span className="live-user-avatar-media live-ambient-context-pill-icon is-web-search" aria-hidden="true">
        <ThinkingOrb
          state="searching"
          size={20}
          theme="dark"
          paused={!isLoading || shouldReduceMotion}
          className="live-ambient-context-pill-orb"
          aria-hidden="true"
        />
      </span>
    );
  }

  if (!item) {
    return null;
  }
  const resolvedImageUrl = imageUrl !== null && imageUrl !== "" && imageUrl !== failedImageUrl ? imageUrl : null;

  return (
    <span
      className={`live-user-avatar-media live-ambient-context-pill-icon is-${item.entityKind}${resolvedImageUrl !== null ? " has-image" : " has-monogram"}`}
      aria-hidden="true"
    >
      {resolvedImageUrl !== null ? (
        <img
          src={resolvedImageUrl}
          alt=""
          className="live-user-avatar-image"
          referrerPolicy="no-referrer"
          onError={() => setFailedImageUrl(resolvedImageUrl)}
        />
      ) : (
        <span className="live-user-avatar-fallback">{ambientContextMonogram(item)}</span>
      )}
    </span>
  );
}
