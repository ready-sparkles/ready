"use client";

import { type RefObject, useLayoutEffect, useRef } from "react";

const TILE_PAIR_COUNT = 2;
const SOLO_TILE_COUNT = 1;
const MOVE_DURATION_MS = 440;
const AVATAR_EXIT_MS = 460;
const ENTER_DURATION_MS = 240;
const ENTER_DELAY_SOLO_TO_PAIR_MS = 80;
const CENTER_DIVISOR = 2;
const ENTER_INITIAL_SCALE = 0.96;
const VOICE_CONTROL_FADE_OFFSET = 120;
const VOICE_CONTROL_OPACITY_VISIBLE = 1;
const VOICE_CONTROL_OPACITY_HIDDEN = 0;
const VOICE_CONTROL_WIDTH_HIDDEN = "0px";
const VOICE_CONTROL_MARGIN_HIDDEN_PREFIX = "-";
const TRANSFORM_AT_REST = "translate(0px, 0px) scale(1, 1)";
const TILE_MOTION_FRAME_STEPS = 60;
const VOICE_CONTROL_DETACHED_MESSAGE = "Voice control is detached from the document";

type ParticipantTileTransitionRefs = {
  previousTileRectsRef: RefObject<Map<string, DOMRect>>;
  previousVoiceControlWidthRef: RefObject<number>;
  voiceControlAnimationRef: RefObject<Animation | null>;
  previousAvatarWidthsRef: RefObject<Map<string, number>>;
  previousParticipantVisualSignatureRef: RefObject<string>;
};

function getTransformFromRect({
  fromRect,
  toRect,
}: {
  fromRect: Pick<DOMRect, "left" | "top" | "width" | "height">;
  toRect: DOMRect;
}) {
  const fromCenterX = fromRect.left + fromRect.width / CENTER_DIVISOR;
  const fromCenterY = fromRect.top + fromRect.height / CENTER_DIVISOR;
  const toCenterX = toRect.left + toRect.width / CENTER_DIVISOR;
  const toCenterY = toRect.top + toRect.height / CENTER_DIVISOR;
  const scaleX = fromRect.width > 0 ? fromRect.width / toRect.width : 1;
  const scaleY = fromRect.height > 0 ? fromRect.height / toRect.height : 1;
  const deltaX = fromCenterX - toCenterX;
  const deltaY = fromCenterY - toCenterY;

  return `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`;
}

function animateVoiceControlShrink(input: {
  voiceControl: HTMLElement;
  previousVoiceControlWidthRef: RefObject<number>;
  voiceControlAnimationRef: RefObject<Animation | null>;
  moveDelayMs: number;
  moveDurationMs: number;
}) {
  const { voiceControl, previousVoiceControlWidthRef, voiceControlAnimationRef, moveDelayMs, moveDurationMs } = input;
  input.voiceControlAnimationRef.current?.cancel();
  const view = voiceControl.ownerDocument.defaultView;
  const parentElement = voiceControl.parentElement;
  if (view === null || parentElement === null) {
    throw new Error(VOICE_CONTROL_DETACHED_MESSAGE);
  }
  const gap = view.getComputedStyle(parentElement).columnGap;
  const animation = voiceControl.animate(
    [
      {
        width: `${previousVoiceControlWidthRef.current}px`,
        marginLeft: "0px",
        opacity: VOICE_CONTROL_OPACITY_VISIBLE,
        visibility: "visible",
        offset: 0,
      },
      { opacity: VOICE_CONTROL_OPACITY_HIDDEN, offset: VOICE_CONTROL_FADE_OFFSET / moveDurationMs },
      {
        width: VOICE_CONTROL_WIDTH_HIDDEN,
        marginLeft: `${VOICE_CONTROL_MARGIN_HIDDEN_PREFIX}${gap}`,
        opacity: VOICE_CONTROL_OPACITY_HIDDEN,
        visibility: "hidden",
        offset: 1,
      },
    ],
    {
      delay: moveDelayMs,
      duration: moveDurationMs,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      fill: "both",
    },
  );
  voiceControlAnimationRef.current = animation;
  animation.addEventListener("finish", () => animation.cancel());
}

function syncVoiceControlWidth(input: { voiceControl: HTMLElement; previousVoiceControlWidthRef: RefObject<number> }) {
  const { voiceControl, previousVoiceControlWidthRef } = input;
  if (voiceControl.classList.contains("is-hidden")) {
    return;
  }
  previousVoiceControlWidthRef.current = (
    voiceControl.querySelector("button") ?? voiceControl
  ).getBoundingClientRect().width;
}

function animateTileEnter(input: {
  tileElement: HTMLElement;
  moveDelayMs: number;
  enterDelayMs: number;
  enterDurationMs: number;
}) {
  const { tileElement, moveDelayMs, enterDelayMs, enterDurationMs } = input;
  tileElement.style.willChange = "transform, opacity";
  const animation = tileElement.animate(
    [
      { opacity: 0, transform: `scale(${ENTER_INITIAL_SCALE})` },
      { opacity: 1, transform: "scale(1)" },
    ],
    {
      delay: moveDelayMs + enterDelayMs,
      duration: enterDurationMs,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      fill: "both",
    },
  );
  animation.addEventListener("finish", () => {
    tileElement.style.willChange = "";
    animation.cancel();
  });
  animation.addEventListener("cancel", () => {
    tileElement.style.willChange = "";
  });
}

function createAvatarCompensationAnimation(input: {
  tileElement: HTMLElement;
  participantId: string;
  previousRect: DOMRect;
  nextRect: DOMRect;
  avatar: HTMLElement;
  localAvatarTile: HTMLElement | undefined;
  previousAvatarWidthsRef: RefObject<Map<string, number>>;
  moveDelayMs: number;
  moveDurationMs: number;
}) {
  const {
    tileElement,
    participantId,
    previousRect,
    nextRect,
    avatar,
    localAvatarTile,
    previousAvatarWidthsRef,
    moveDelayMs,
    moveDurationMs,
  } = input;
  if (tileElement !== localAvatarTile) {
    return undefined;
  }
  const previousAvatarWidth = previousAvatarWidthsRef.current.get(participantId);
  if (
    avatar.offsetWidth <= 0 ||
    previousAvatarWidth === undefined ||
    previousAvatarWidth <= 0 ||
    previousRect.width <= 0 ||
    previousRect.height <= 0
  ) {
    return undefined;
  }
  const ratio = previousAvatarWidth / avatar.offsetWidth;
  const scale = `${(ratio * nextRect.width) / previousRect.width} ${(ratio * nextRect.height) / previousRect.height}`;

  return avatar.animate([{ scale }, { scale }], {
    duration: moveDelayMs + moveDurationMs,
    fill: "both",
  });
}

function interpolateTileRect(input: {
  fromRect: DOMRect;
  toRect: DOMRect;
  progress: number;
}): Pick<DOMRect, "left" | "top" | "width" | "height"> {
  const { fromRect, toRect, progress } = input;

  return {
    left: fromRect.left + (toRect.left - fromRect.left) * progress,
    top: fromRect.top + (toRect.top - fromRect.top) * progress,
    width: fromRect.width + (toRect.width - fromRect.width) * progress,
    height: fromRect.height + (toRect.height - fromRect.height) * progress,
  };
}

function readTileCornerRadius(tileElement: HTMLElement): number {
  const radius = Number.parseFloat(window.getComputedStyle(tileElement).borderTopLeftRadius);

  return Number.isFinite(radius) ? radius : 0;
}

// Inverse radii keep rounded corners constant while FLIP scales the tile.
function buildTileMotionFrames(input: {
  tileElement: HTMLElement;
  previousRect: DOMRect;
  nextRect: DOMRect;
}): Keyframe[] {
  const { tileElement, previousRect, nextRect } = input;
  const radius = readTileCornerRadius(tileElement);

  return Array.from({ length: TILE_MOTION_FRAME_STEPS + 1 }, (_, index) => {
    const progress = index / TILE_MOTION_FRAME_STEPS;
    const rect = interpolateTileRect({ fromRect: previousRect, toRect: nextRect, progress });

    return {
      offset: progress,
      transform: getTransformFromRect({ fromRect: rect, toRect: nextRect }),
      borderRadius: `${(radius * nextRect.width) / rect.width}px / ${(radius * nextRect.height) / rect.height}px`,
    };
  });
}

function animateTileMove(input: {
  tileElement: HTMLElement;
  previousRect: DOMRect;
  nextRect: DOMRect;
  avatar: HTMLElement | null | undefined;
  participantId: string;
  localAvatarTile: HTMLElement | undefined;
  localMovingTile: HTMLElement | undefined;
  previousAvatarWidthsRef: RefObject<Map<string, number>>;
  moveDelayMs: number;
  moveDurationMs: number;
}) {
  const {
    tileElement,
    previousRect,
    nextRect,
    avatar,
    participantId,
    localAvatarTile,
    localMovingTile,
    previousAvatarWidthsRef,
    moveDelayMs,
    moveDurationMs,
  } = input;
  const previousTransform = getTransformFromRect({ fromRect: previousRect, toRect: nextRect });
  if (previousTransform === TRANSFORM_AT_REST) {
    tileElement.style.willChange = "";

    return;
  }

  const avatarCompensation =
    avatar !== null && avatar !== undefined
      ? createAvatarCompensationAnimation({
          tileElement,
          participantId,
          previousRect,
          nextRect,
          avatar,
          localAvatarTile,
          previousAvatarWidthsRef,
          moveDelayMs,
          moveDurationMs,
        })
      : undefined;
  if (tileElement === localMovingTile) {
    tileElement.classList.add("is-tile-moving");
  }
  tileElement.style.willChange = "transform";
  const animation = tileElement.animate(buildTileMotionFrames({ tileElement, previousRect, nextRect }), {
    delay: moveDelayMs,
    duration: moveDurationMs,
    easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    fill: "both",
  });
  animation.addEventListener("finish", () => {
    avatarCompensation?.cancel();
    tileElement.classList.remove("is-tile-moving");
    tileElement.style.willChange = "";
    animation.cancel();
  });
  animation.addEventListener("cancel", () => {
    avatarCompensation?.cancel();
    tileElement.classList.remove("is-tile-moving");
    tileElement.style.willChange = "";
  });
}

function startTileMotion(input: {
  tileElement: HTMLElement;
  participantId: string;
  previousRect: DOMRect | null | undefined;
  nextRect: DOMRect;
  avatar: HTMLElement | null | undefined;
  localAvatarTile: HTMLElement | undefined;
  localMovingTile: HTMLElement | undefined;
  previousAvatarWidthsRef: RefObject<Map<string, number>>;
  moveDelayMs: number;
  moveDurationMs: number;
  enterDelayMs: number;
  enterDurationMs: number;
}) {
  if (!input.previousRect) {
    animateTileEnter(input);

    return;
  }

  animateTileMove({ ...input, previousRect: input.previousRect });
}

function updateParticipantTiles(input: {
  tileElements: HTMLElement[];
  shouldAnimate: boolean;
  previousRects: Map<string, DOMRect>;
  nextRects: Map<string, DOMRect>;
  nextAvatarWidths: Map<string, number>;
  localAvatarTile: HTMLElement | undefined;
  localMovingTile: HTMLElement | undefined;
  previousAvatarWidthsRef: RefObject<Map<string, number>>;
  moveDelayMs: number;
  moveDurationMs: number;
  enterDelayMs: number;
  enterDurationMs: number;
}) {
  const {
    tileElements,
    shouldAnimate,
    previousRects,
    nextRects,
    nextAvatarWidths,
    localAvatarTile,
    localMovingTile,
    previousAvatarWidthsRef,
    moveDelayMs,
    moveDurationMs,
    enterDelayMs,
    enterDurationMs,
  } = input;

  tileElements.forEach((element) => {
    const tileElement = element;
    const participantId = tileElement.dataset.participantVisualId;
    if (participantId === undefined || participantId.length === 0) {
      return;
    }

    const existingAnimations = tileElement.getAnimations().filter((animation) => {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect)) {
        return false;
      }

      return effect.getKeyframes().some((frame) => frame.transform !== undefined);
    });
    const hasRunningAnimation = existingAnimations.some((animation) => animation.playState === "running");
    const presentationRect = hasRunningAnimation ? tileElement.getBoundingClientRect() : null;
    existingAnimations.forEach((animation) => {
      animation.cancel();
    });
    const nextRect = tileElement.getBoundingClientRect();
    nextRects.set(participantId, nextRect);
    const avatarLayer = tileElement.querySelector<HTMLElement>(".live-media-avatar-layer");
    const avatar = avatarLayer?.querySelector<HTMLElement>(".live-video-tile > div");
    const avatarWidth = avatar?.getBoundingClientRect().width;
    if (avatarWidth !== undefined && avatarWidth > 0) {
      nextAvatarWidths.set(participantId, avatarWidth);
    }

    if (!shouldAnimate) {
      tileElement.style.willChange = "";

      return;
    }

    const previousRect = presentationRect ?? previousRects.get(participantId);
    if (typeof tileElement.animate !== "function" || nextRect.width <= 0 || nextRect.height <= 0) {
      return;
    }
    startTileMotion({
      tileElement,
      participantId,
      previousRect,
      nextRect,
      avatar,
      localAvatarTile,
      localMovingTile,
      previousAvatarWidthsRef,
      moveDelayMs,
      moveDurationMs,
      enterDelayMs,
      enterDurationMs,
    });
  });
}

function resolveSoloToPairMotion(input: {
  previousRects: Map<string, DOMRect>;
  tileCount: number;
  tileElements: HTMLElement[];
}) {
  const isSoloToPair = input.previousRects.size === SOLO_TILE_COUNT && input.tileCount === TILE_PAIR_COUNT;
  const localMovingTile = isSoloToPair
    ? input.tileElements.find((tile) => tile.closest(".is-local-participant"))
    : undefined;
  const isLocalVideoOn = localMovingTile !== undefined && localMovingTile.classList.contains("is-video-on");
  const localAvatarTile = isLocalVideoOn ? undefined : localMovingTile;
  const moveDelayMs = localAvatarTile !== undefined ? AVATAR_EXIT_MS : 0;
  const enterDelayMs = isSoloToPair ? MOVE_DURATION_MS : ENTER_DELAY_SOLO_TO_PAIR_MS;

  return { isSoloToPair, localMovingTile, localAvatarTile, moveDelayMs, enterDelayMs };
}

function runParticipantTileTransitionLayout(input: {
  liveVideoGridRef: RefObject<HTMLDivElement | null>;
  participantVisualSignature: string;
  isTransitionEnabled: boolean;
  refs: ParticipantTileTransitionRefs;
}) {
  const { liveVideoGridRef, participantVisualSignature, isTransitionEnabled, refs } = input;
  const {
    previousTileRectsRef,
    previousVoiceControlWidthRef,
    voiceControlAnimationRef,
    previousAvatarWidthsRef,
    previousParticipantVisualSignatureRef,
  } = refs;

  if (typeof window === "undefined") {
    return;
  }

  const isReducedMotionPreferred = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!isTransitionEnabled || isReducedMotionPreferred) {
    voiceControlAnimationRef.current?.cancel();
    previousTileRectsRef.current.clear();
    previousParticipantVisualSignatureRef.current = "";

    return;
  }

  const gridElement = liveVideoGridRef.current;
  if (!gridElement) {
    return;
  }

  const tileElements = Array.from(
    gridElement.querySelectorAll<HTMLElement>(".live-video-flip-target[data-participant-visual-id]"),
  );

  const nextRects = new Map<string, DOMRect>();
  const nextAvatarWidths = new Map<string, number>();
  const previousRects = previousTileRectsRef.current;
  const previousSignature = previousParticipantVisualSignatureRef.current;
  const shouldAnimate =
    participantVisualSignature.length > 0 &&
    previousSignature.length > 0 &&
    previousSignature !== participantVisualSignature;
  const moveDurationMs = MOVE_DURATION_MS;
  const enterDurationMs = ENTER_DURATION_MS;
  const { isSoloToPair, localMovingTile, localAvatarTile, moveDelayMs, enterDelayMs } = resolveSoloToPairMotion({
    previousRects,
    tileCount: tileElements.length,
    tileElements,
  });
  const voiceControl = gridElement.closest(".live-shell")?.querySelector<HTMLElement>(".live-solo-voice-control");
  const shouldShrinkVoiceControl = shouldAnimate && isSoloToPair && previousVoiceControlWidthRef.current > 0;
  if (voiceControl && shouldShrinkVoiceControl) {
    animateVoiceControlShrink({
      voiceControl,
      previousVoiceControlWidthRef,
      voiceControlAnimationRef,
      moveDelayMs,
      moveDurationMs,
    });
  } else if (voiceControl) {
    syncVoiceControlWidth({ voiceControl, previousVoiceControlWidthRef });
  }

  updateParticipantTiles({
    tileElements,
    shouldAnimate,
    previousRects,
    nextRects,
    nextAvatarWidths,
    localAvatarTile,
    localMovingTile,
    previousAvatarWidthsRef,
    moveDelayMs,
    moveDurationMs,
    enterDelayMs,
    enterDurationMs,
  });

  previousTileRectsRef.current = nextRects;
  previousAvatarWidthsRef.current = nextAvatarWidths;
  previousParticipantVisualSignatureRef.current = participantVisualSignature;
}

// Shared by the real meeting and its public replay.
export function useParticipantTileTransition(
  ...[liveVideoGridRef, participantVisualSignature, isTransitionEnabled, layout]: [
    RefObject<HTMLDivElement | null>,
    string,
    /** @external live meeting tile transition hook contract */
    boolean,
    unknown?,
  ]
): void {
  const previousTileRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const previousVoiceControlWidthRef = useRef(0);
  const voiceControlAnimationRef = useRef<Animation | null>(null);
  const previousAvatarWidthsRef = useRef(new Map<string, number>());
  const previousParticipantVisualSignatureRef = useRef("");
  useLayoutEffect(() => {
    runParticipantTileTransitionLayout({
      liveVideoGridRef,
      participantVisualSignature,
      isTransitionEnabled,
      refs: {
        previousTileRectsRef,
        previousVoiceControlWidthRef,
        voiceControlAnimationRef,
        previousAvatarWidthsRef,
        previousParticipantVisualSignatureRef,
      },
    });
  }, [liveVideoGridRef, layout, participantVisualSignature, isTransitionEnabled]);
}
