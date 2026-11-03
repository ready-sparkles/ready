"use client";
import type { RelationshipMemory } from "@readymeet/shared";
import { cubicBezier } from "motion";
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";

import { MemoryIcon } from "../memory-icons";

import { MemoryCardOrganicShimmer, MemoryCardOrganicShimmerFilter } from "./memory-card-shimmer";
import type { MemoryDisplayMode } from "./memory-layout-toggle";
import { buildMemoryRulerItems, type MemoryRulerHandle, WindowedMemoryRuler } from "./memory-ruler";
import type { MemoryVirtualListHandle } from "./memory-virtual-list";
import { accumulateStackWheel, advanceStackMotion, STACK_WHEEL_IDLE_MS, type StackWheelState } from "./stack-motion";
import { createMemoryTravelStore } from "./travel-store";
import { windowIndices } from "./windowing";

export type MemoryCardBrowserHandle = { selectLayout: (mode: MemoryDisplayMode) => void };
type Travel = {
  position: number;
  velocity: number;
  target: number;
  wheel?: StackWheelState;
  from: number;
  startedAt: number;
  duration: number;
  isEdge: boolean;
};
type ViewTransition = { finished: Promise<void>; skipTransition: () => void };

const NO_ARRIVALS: readonly string[] = [];
const ignoreArrival = () => {};
const CARD_SHIFT_BEZIER_X1 = 0.22;
const CARD_SHIFT_BEZIER_Y1 = 1;
const CARD_SHIFT_BEZIER_X2 = 0.36;
const CARD_SHIFT_BEZIER_Y2 = 1;
const easeCardShift = cubicBezier(
  CARD_SHIFT_BEZIER_X1,
  CARD_SHIFT_BEZIER_Y1,
  CARD_SHIFT_BEZIER_X2,
  CARD_SHIFT_BEZIER_Y2,
);
const RGB_CHANNEL_12 = 12;
const RGB_CHANNEL_13 = 13;
const RGB_CHANNEL_14 = 14;
const RGB_CHANNEL_15 = 15;
const RGB_CHANNEL_17 = 17;
const RGB_CHANNEL_19 = 19;
const RGB_CHANNEL_20 = 20;
const RGB_CHANNEL_22 = 22;
const RGB_CHANNEL_23 = 23;
const DARK_SURFACE_LAYER_0: readonly [number, number, number] = [RGB_CHANNEL_23, RGB_CHANNEL_23, RGB_CHANNEL_23];
const DARK_SURFACE_LAYER_1: readonly [number, number, number] = [RGB_CHANNEL_20, RGB_CHANNEL_22, RGB_CHANNEL_20];
const DARK_SURFACE_LAYER_2: readonly [number, number, number] = [RGB_CHANNEL_17, RGB_CHANNEL_19, RGB_CHANNEL_17];
const DARK_SURFACE_LAYER_3: readonly [number, number, number] = [RGB_CHANNEL_15, RGB_CHANNEL_17, RGB_CHANNEL_15];
const DARK_SURFACE_LAYER_4: readonly [number, number, number] = [RGB_CHANNEL_12, RGB_CHANNEL_14, RGB_CHANNEL_13];
const DARK_SURFACES = [
  DARK_SURFACE_LAYER_0,
  DARK_SURFACE_LAYER_1,
  DARK_SURFACE_LAYER_2,
  DARK_SURFACE_LAYER_3,
  DARK_SURFACE_LAYER_4,
];
const TRAVEL_BRAKING_START = 0.34;
const TRAVEL_SETTLING_DISTANCE_MAX = 8;
const TRAVEL_SETTLING_DISTANCE_DIVISOR = 2;
const TRAVEL_EASE_CUBIC_NEG_A = -2;
const TRAVEL_EASE_CUBIC_B = 3;
const TRAVEL_EASE_CUBIC_C = 2;
const TRAVEL_EASE_SETTLING_NUMERATOR = 3;
const TRAVEL_EASE_END_POWER = 3;
const MEMORY_CARD_BROWSER_COPY = {
  surfaceChannelMissing: "Memory card surface channel is missing",
  loadMoreError: "Could not load more memories. ",
  tryAgain: "Try again",
  loadingMoreStatus: "Loading more memories",
  openMemoryLabelPrefix: "Open memory:",
} as const;

function formatOpenMemoryLabel(title: string): string {
  return `${MEMORY_CARD_BROWSER_COPY.openMemoryLabelPrefix} ${title}`;
}
const MS_PER_SECOND = 1000;
const ARRIVAL_REVEAL_DELAY_MS = MS_PER_SECOND;
const ARRIVAL_FINISH_DELAY_MS = 1400;
const LIST_PREVIEW_ANCHOR_OFFSET = 32;
const LIST_ANCHOR_MIN_TOP = 74;
const LIST_ANCHOR_FALLBACK_BOTTOM = 56;
const LIST_ANCHOR_TOOLBAR_GAP = 18;
const TRAVEL_DURATION_MAX_MS = 1090;
const TRAVEL_DURATION_MIN_MS = 390;
const TRAVEL_DURATION_BASE_MS = 300;
const TRAVEL_DURATION_PER_INDEX_MS = 18;
const EDGE_FADE_SINGLE_MS = 200;
const EDGE_FADE_MULTI_MS = 90;
const EDGE_TRAVEL_SINGLE_MS = 460;
const POINTER_VELOCITY_CUTOFF_MS = 100;
const POINTER_RELEASE_VELOCITY_SCALE = 0.16;
const POINTER_DRAG_THRESHOLD_PX = 10;
const POINTER_SPAN_MIN_PX = 180;
const POINTER_SPAN_WIDTH_RATIO = 0.75;
const POINTER_VELOCITY_CLAMP = 4;
const POINTER_VELOCITY_MIN_DELTA_SECONDS = 0.001;
const LOAD_MORE_THRESHOLD_FROM_END = 5;
const STACK_WINDOW_BACK = 2;
const STACK_WINDOW_FORWARD = 8;
const STACK_DEPTH_MAX = 4;
const STACK_CONTENT_DEPTH_FADE_START = 5;
const STACK_TRANSLATE_PASSED_PX = 92;
const STACK_SCALE_PASSED_DELTA = 0.02;
const STACK_TRANSLATE_DEPTH_PX = 24;
const STACK_TRANSLATE_Z_DEPTH = 72;
const STACK_SCALE_DEPTH_DELTA = 0.025;
const STACK_ZINDEX_TRAVEL_MULTIPLIER = 10;
const STACK_ZINDEX_TRAVEL_OFFSET = 10;
const STACK_ZINDEX_EXIT_OFFSET = 20;
const EXIT_TRANSITION_SINGLE_MS = 200;
const EXIT_TRANSITION_MULTI_MS = 90;

// Highlight's long-distance braking curve, used when selecting a rear card.
function easeTravel(input: { progress: number; distance: number }): number {
  const { progress, distance } = input;
  if (distance <= Number.EPSILON) {
    return 1;
  }
  const brakingStart = TRAVEL_BRAKING_START;
  const brakingDuration = 1 - brakingStart;
  const settlingDistance = Math.min(TRAVEL_SETTLING_DISTANCE_MAX, distance / TRAVEL_SETTLING_DISTANCE_DIVISOR);
  const cruiseDistance = distance - settlingDistance;
  if (progress <= brakingStart) {
    const p = progress / brakingStart;

    return (
      ((TRAVEL_EASE_CUBIC_NEG_A * p ** TRAVEL_EASE_END_POWER + TRAVEL_EASE_CUBIC_B * p ** TRAVEL_EASE_CUBIC_C) *
        cruiseDistance +
        (p ** TRAVEL_EASE_END_POWER - p ** TRAVEL_EASE_CUBIC_C) *
          ((TRAVEL_EASE_SETTLING_NUMERATOR * settlingDistance) / brakingDuration) *
          brakingStart) /
      distance
    );
  }

  return (
    (cruiseDistance +
      settlingDistance * (1 - (1 - (progress - brakingStart) / brakingDuration) ** TRAVEL_EASE_END_POWER)) /
    distance
  );
}

function blendMemoryDarkSurface(stackDepth: number): string | null {
  const lower = DARK_SURFACES[Math.floor(stackDepth)];
  const upper = DARK_SURFACES[Math.ceil(stackDepth)];
  if (lower === undefined || upper === undefined) {
    return null;
  }

  return `rgb(${lower
    .map((channel, channelIndex) => {
      const upperChannel = upper[channelIndex];
      if (upperChannel === undefined) {
        throw new Error(MEMORY_CARD_BROWSER_COPY.surfaceChannelMissing);
      }

      return Math.round(channel + (upperChannel - channel) * (stackDepth % 1));
    })
    .join(" ")})`;
}

type StackCardMetrics = {
  depth: number;
  stackDepth: number;
  passed: number;
  darkSurface: string;
  opacity: number;
  contentOpacity: number;
  isActive: boolean;
  isRear: boolean;
  isEntering: boolean;
  isHiddenExit: boolean;
};

function measureStackCardMetrics(input: {
  cardIndex: number;
  visualPosition: number;
  memoryId: string;
  isTraveling: boolean;
  enteringId: string | null;
  exitIndex: number | null;
  edgeTravel: Travel | null;
}): StackCardMetrics | null {
  const { cardIndex, visualPosition, memoryId, isTraveling, enteringId, exitIndex, edgeTravel } = input;
  const depth = cardIndex - visualPosition;
  const stackDepth = Math.min(STACK_DEPTH_MAX, Math.max(0, depth));
  const passed = Math.min(1, Math.max(0, -depth));
  const darkSurface = blendMemoryDarkSurface(stackDepth);
  if (darkSurface === null) {
    return null;
  }
  const opacity = depth < 0 ? 1 - passed : Math.min(1, Math.max(0, STACK_CONTENT_DEPTH_FADE_START - depth));
  const contentOpacity = Math.max(0, 1 - Math.abs(depth));
  const isActive = cardIndex === Math.round(visualPosition);
  const isRear = !isTraveling && depth > 0 && depth <= STACK_DEPTH_MAX;
  const isEntering = isActive && !isTraveling && memoryId === enteringId;
  const isHiddenExit =
    exitIndex === cardIndex || (edgeTravel?.isEdge === true && cardIndex === Math.round(edgeTravel.from));

  return {
    depth,
    stackDepth,
    passed,
    darkSurface,
    opacity,
    contentOpacity,
    isActive,
    isRear,
    isEntering,
    isHiddenExit,
  };
}

function stackCardDisplayedOpacity(input: { metrics: StackCardMetrics; isTraveling: boolean }): number {
  const { metrics, isTraveling } = input;
  if (metrics.isHiddenExit) {
    return 0;
  }
  if (isTraveling) {
    return metrics.opacity;
  }
  if (metrics.depth >= 0 && metrics.depth <= STACK_DEPTH_MAX) {
    return 1;
  }

  return 0;
}

function buildStackCardStyle(input: {
  metrics: StackCardMetrics;
  cardIndex: number;
  index: number;
  memoriesLength: number;
  isTraveling: boolean;
}): CSSProperties {
  const { metrics, cardIndex, index, memoriesLength, isTraveling } = input;
  const { depth, stackDepth, passed, darkSurface } = metrics;

  return {
    "--stack-depth": stackDepth,
    "--memory-dark-surface": darkSurface,
    opacity: stackCardDisplayedOpacity({ metrics, isTraveling }),
    pointerEvents: !isTraveling && (metrics.isActive || metrics.isRear) ? "auto" : "none",
    transform:
      depth < 0
        ? `translate3d(0, ${passed * STACK_TRANSLATE_PASSED_PX}px, 0) scale(${1 + passed * STACK_SCALE_PASSED_DELTA})`
        : `translate3d(0, ${-stackDepth * STACK_TRANSLATE_DEPTH_PX}px, ${stackDepth * -STACK_TRANSLATE_Z_DEPTH}px) scale(${1 - stackDepth * STACK_SCALE_DEPTH_DELTA})`,
    viewTransitionName:
      cardIndex - index >= 0 && cardIndex - index <= STACK_DEPTH_MAX
        ? `memory-layout-card-${cardIndex - index}`
        : "none",
    zIndex: isTraveling
      ? memoriesLength + STACK_ZINDEX_TRAVEL_OFFSET - Math.round(Math.abs(depth) * STACK_ZINDEX_TRAVEL_MULTIPLIER)
      : memoriesLength - stackDepth,
  };
}

function renderStackMemoryCardBody(input: {
  cardIndex: number;
  memory: RelationshipMemory;
  metrics: StackCardMetrics;
  isTraveling: boolean;
  isRevealed: boolean;
  renderCard: (card: { memory: RelationshipMemory; isActive: boolean }) => ReactNode;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
}): ReactNode {
  const { cardIndex, memory, metrics, isTraveling, isRevealed, renderCard, navigate } = input;
  const { contentOpacity, isActive, isRear, isEntering, isHiddenExit } = metrics;

  if (contentOpacity > 0 && !isHiddenExit) {
    return (
      <div
        className="memory-card-reveal-content"
        inert={!isActive || (isEntering && !isRevealed)}
        style={{ opacity: isEntering ? undefined : isTraveling ? contentOpacity : 1 }}
      >
        {renderCard({ memory, isActive: isActive && !isTraveling })}
      </div>
    );
  }
  if (isRear) {
    return (
      <button
        type="button"
        className="memory-stack-card-target"
        aria-label={formatOpenMemoryLabel(memory.title)}
        onClick={() => navigate({ request: cardIndex, isEdge: true })}
      />
    );
  }

  return null;
}

function renderStackMemoryCard(input: {
  cardIndex: number;
  memory: RelationshipMemory;
  memoriesLength: number;
  visualPosition: number;
  index: number;
  isTraveling: boolean;
  isDisabled: boolean;
  enteringId: string | null;
  isRevealed: boolean;
  exitIndex: number | null;
  edgeTravel: Travel | null;
  renderCard: (card: { memory: RelationshipMemory; isActive: boolean }) => ReactNode;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
}): ReactNode {
  const {
    cardIndex,
    memory,
    memoriesLength,
    visualPosition,
    index,
    isTraveling,
    isDisabled,
    isRevealed,
    renderCard,
    navigate,
  } = input;
  const metrics = measureStackCardMetrics({
    cardIndex,
    visualPosition,
    memoryId: memory.id,
    isTraveling,
    enteringId: input.enteringId,
    exitIndex: input.exitIndex,
    edgeTravel: input.edgeTravel,
  });
  if (metrics === null) {
    return null;
  }
  const { contentOpacity, isActive, isRear, isEntering } = metrics;

  return (
    <article
      key={memory.id}
      className={`memory-snapshot-card${contentOpacity > 0 ? " is-active" : ""}${isEntering ? " is-entering" : ""}${isEntering && isRevealed ? " is-revealing" : ""}`}
      data-memory-id={memory.id}
      aria-hidden={!isActive && !isRear ? true : false}
      inert={isDisabled && !isActive ? true : false}
      style={buildStackCardStyle({ metrics, cardIndex, index, memoriesLength, isTraveling })}
    >
      {renderStackMemoryCardBody({
        cardIndex,
        memory,
        metrics,
        isTraveling,
        isRevealed,
        renderCard,
        navigate,
      })}
      {isEntering ? <MemoryCardOrganicShimmer isRevealed={isRevealed} /> : null}
    </article>
  );
}

type StackPointerDrag = {
  id: number;
  x: number;
  y: number;
  from: number;
  position: number;
  velocity: number;
  at: number;
  span: number;
  isDragging: boolean;
};

function stepStackTravelAnimation(input: {
  timestamp: number;
  previousTimestamp: number;
  distance: number;
  travelRef: { current: Travel | null };
  frameRef: { current: number };
  store: ReturnType<typeof createMemoryTravelStore>;
  commit: (next: number) => void;
  stop: () => void;
  setIsExitFading: (value: boolean) => void;
  setExitIndex: (value: number | null) => void;
  schedule: (next: { timestamp: number; previousTimestamp: number }) => void;
}): void {
  const {
    timestamp,
    previousTimestamp,
    distance,
    travelRef,
    frameRef,
    store,
    commit,
    stop,
    setIsExitFading,
    setExitIndex,
    schedule,
  } = input;
  const motion = travelRef.current;
  if (motion === null) {
    return;
  }
  if (motion.isEdge) {
    setIsExitFading(true);
    const fade = distance === 1 ? EDGE_FADE_SINGLE_MS : EDGE_FADE_MULTI_MS;
    const elapsed = timestamp - motion.startedAt;
    if (elapsed < fade) {
      frameRef.current = requestAnimationFrame((nextTimestamp) => {
        schedule({ timestamp: nextTimestamp, previousTimestamp });
      });

      return;
    }
    setExitIndex(null);
    const p = Math.min(1, (elapsed - fade) / (distance === 1 ? EDGE_TRAVEL_SINGLE_MS : motion.duration));
    motion.position =
      motion.from +
      (motion.target - motion.from) * (distance === 1 ? easeCardShift(p) : easeTravel({ progress: p, distance }));
    store.set(motion.position);
    if (p >= 1) {
      commit(motion.target);
      stop();

      return;
    }
  } else {
    const wheelState = motion.wheel;
    const isWheelFinished = wheelState === undefined || timestamp - wheelState.at >= STACK_WHEEL_IDLE_MS;
    const goal = isWheelFinished ? motion.target : wheelState.position;
    const nextFrame = advanceStackMotion({
      position: motion.position,
      velocity: motion.velocity,
      target: goal,
      seconds: (timestamp - previousTimestamp) / MS_PER_SECOND,
    });
    motion.position = nextFrame.position;
    motion.velocity = nextFrame.velocity;
    store.set(motion.position);
    if (isWheelFinished && nextFrame.settled) {
      commit(motion.target);
      stop();

      return;
    }
  }
  frameRef.current = requestAnimationFrame((nextTimestamp) => {
    schedule({ timestamp: nextTimestamp, previousTimestamp: timestamp });
  });
}

function reconcilePollArrivals(input: {
  arrivingIds: readonly string[];
  observedArrivals: { current: readonly string[] };
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  rowsRef: { current: RelationshipMemory[] };
  stop: () => void;
  commit: (next: number) => void;
  onArrivalComplete: (id: string) => void;
}): void {
  const { arrivingIds, observedArrivals, mode, isDisabled, rowsRef, stop, commit, onArrivalComplete } = input;
  const fresh = arrivingIds.filter((id) => !observedArrivals.current.includes(id));
  observedArrivals.current = arrivingIds;
  if (mode !== "stack" || isDisabled) {
    arrivingIds.forEach(onArrivalComplete);

    return;
  }
  if (fresh.length === 0) {
    return;
  }
  const next = rowsRef.current.findIndex((memory) => fresh.includes(memory.id));
  const representativeId = rowsRef.current[next]?.id;
  arrivingIds.filter((id) => id !== representativeId).forEach(onArrivalComplete);
  if (next >= 0) {
    stop();
    commit(next);
  }
}

function cancelStaleEnteringMemory(input: {
  enteringId: string | null;
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  isTraveling: boolean;
  shouldReduceMotion: boolean;
  visibleId: string | undefined;
  onArrivalComplete: (id: string) => void;
  setEnteringId: (id: string | null) => void;
  setIsRevealed: (value: boolean) => void;
}): boolean {
  const {
    enteringId,
    mode,
    isDisabled,
    isTraveling,
    shouldReduceMotion,
    visibleId,
    onArrivalComplete,
    setEnteringId,
    setIsRevealed,
  } = input;
  if (
    enteringId === null ||
    enteringId === "" ||
    (mode === "stack" && !isDisabled && !isTraveling && !shouldReduceMotion && visibleId === enteringId)
  ) {
    return false;
  }
  onArrivalComplete(enteringId);
  setEnteringId(null);
  setIsRevealed(false);

  return true;
}

function tryStartEnteringMemory(input: {
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  isTraveling: boolean;
  enteringId: string | null;
  visibleId: string | undefined;
  arrivingIds: readonly string[];
  shouldReduceMotion: boolean;
  onArrivalComplete: (id: string) => void;
  setEnteringId: (id: string | null) => void;
  setIsRevealed: (value: boolean) => void;
}): void {
  const {
    mode,
    isDisabled,
    isTraveling,
    enteringId,
    visibleId,
    arrivingIds,
    shouldReduceMotion,
    onArrivalComplete,
    setEnteringId,
    setIsRevealed,
  } = input;
  if (
    mode !== "stack" ||
    isDisabled ||
    isTraveling ||
    (enteringId !== null && enteringId !== "") ||
    visibleId === undefined ||
    visibleId === "" ||
    !arrivingIds.includes(visibleId)
  ) {
    return;
  }
  if (shouldReduceMotion) {
    onArrivalComplete(visibleId);

    return;
  }
  setEnteringId(visibleId);
  setIsRevealed(false);
}

function reconcileEnteringMemoryLayout(input: {
  isMotionReady: boolean;
  enteringId: string | null;
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  isTraveling: boolean;
  shouldReduceMotion: boolean;
  visibleId: string | undefined;
  arrivingIds: readonly string[];
  onArrivalComplete: (id: string) => void;
  setEnteringId: (id: string | null) => void;
  setIsRevealed: (value: boolean) => void;
}): void {
  if (!input.isMotionReady) {
    return;
  }
  if (cancelStaleEnteringMemory(input)) {
    return;
  }
  tryStartEnteringMemory(input);
}

function scrollMemoryListDom(input: {
  next: number;
  isInstant: boolean;
  shouldReduceMotion: boolean;
  memoryId: string;
  root: { current: HTMLDivElement | null };
  rowsRef: { current: RelationshipMemory[] };
  getListScroller: () => HTMLElement | null | undefined;
  getListAnchor: (scroller: HTMLElement) => number;
  commit: (next: number) => void;
}): void {
  const { next, isInstant, shouldReduceMotion, memoryId, root, getListScroller, getListAnchor, commit } = input;
  const row = root.current?.querySelector<HTMLElement>(`[data-memory-id="${memoryId}"]`);
  const scroller = getListScroller();
  if (!row || !scroller) {
    return;
  }
  const group = row.closest(".relationship-memory-group");
  const disclosure = group?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  if (row.closest("[hidden]")) {
    flushSync(() => disclosure?.click());
  }
  const anchor = getListAnchor(scroller);
  scroller.scrollTo({
    top: next === 0 ? 0 : scroller.scrollTop + row.getBoundingClientRect().top - anchor,
    behavior: isInstant || shouldReduceMotion ? "instant" : "smooth",
  });
  commit(next);
}

function tryRetargetStackTravel(input: {
  current: Travel | null;
  isEdge: boolean;
  shouldReduceMotion: boolean;
  next: number;
  wheelInput?: StackWheelState;
  setTarget: (next: number) => void;
}): boolean {
  const { current, isEdge, shouldReduceMotion, next, wheelInput, setTarget } = input;
  if (current && !current.isEdge && !isEdge && !shouldReduceMotion) {
    current.target = next;
    current.wheel = wheelInput;
    setTarget(next);

    return true;
  }

  return false;
}

function launchStackTravel(input: {
  from: number;
  next: number;
  wheelInput?: StackWheelState;
  releaseVelocity: number;
  isEdge: boolean;
  current: Travel | null;
  travelRef: { current: Travel | null };
  frameRef: { current: number };
  root: { current: HTMLDivElement | null };
  store: ReturnType<typeof createMemoryTravelStore>;
  commit: (next: number) => void;
  stop: () => void;
  setTarget: (next: number) => void;
  setIsTraveling: (value: boolean) => void;
  setExitIndex: (value: number | null) => void;
  setIsExitFading: (value: boolean) => void;
}): void {
  const {
    from,
    next,
    wheelInput,
    releaseVelocity,
    isEdge,
    current,
    travelRef,
    frameRef,
    root,
    store,
    commit,
    stop,
    setTarget,
    setIsTraveling,
    setExitIndex,
    setIsExitFading,
  } = input;
  const now = performance.now();
  const distance = Math.abs(next - from);
  travelRef.current = {
    position: from,
    from,
    velocity: current?.velocity ?? releaseVelocity,
    target: next,
    wheel: wheelInput,
    startedAt: now,
    duration: Math.min(
      TRAVEL_DURATION_MAX_MS,
      Math.max(TRAVEL_DURATION_MIN_MS, TRAVEL_DURATION_BASE_MS + distance * TRAVEL_DURATION_PER_INDEX_MS),
    ),
    isEdge,
  };
  setTarget(next);
  setIsTraveling(true);
  setExitIndex(isEdge ? Math.round(from) : null);
  setIsExitFading(false);
  store.set(from);
  const animate = (frameInput: { timestamp: number; previousTimestamp: number }) => {
    stepStackTravelAnimation({
      timestamp: frameInput.timestamp,
      previousTimestamp: frameInput.previousTimestamp,
      distance,
      travelRef,
      frameRef,
      store,
      commit,
      stop,
      setIsExitFading,
      setExitIndex,
      schedule: animate,
    });
  };
  scheduleStackTravelFrames({
    isEdge,
    now,
    root,
    travelRef,
    frameRef,
    animate,
  });
}

function scheduleStackTravelFrames(input: {
  isEdge: boolean;
  now: number;
  root: { current: HTMLDivElement | null };
  travelRef: { current: Travel | null };
  frameRef: { current: number };
  animate: (frameInput: { timestamp: number; previousTimestamp: number }) => void;
}): void {
  const { isEdge, now, root, travelRef, frameRef, animate } = input;
  if (isEdge) {
    frameRef.current = requestAnimationFrame(() => {
      root.current?.getBoundingClientRect();
      frameRef.current = requestAnimationFrame((timestamp) => {
        if (travelRef.current) {
          travelRef.current.startedAt = timestamp;
        }
        animate({ timestamp, previousTimestamp: now });
      });
    });

    return;
  }
  frameRef.current = requestAnimationFrame((timestamp) => {
    animate({ timestamp, previousTimestamp: now });
  });
}

function finishStackPointerDrag(input: {
  panel: HTMLDivElement;
  pointerGesture: { current: StackPointerDrag | null };
  rowsRef: { current: RelationshipMemory[] };
  startTravel: (request: { next: number; releaseVelocity?: number }) => void;
  isCancelled: boolean;
}): void {
  const { panel, pointerGesture, rowsRef, startTravel, isCancelled } = input;
  const drag = pointerGesture.current;
  pointerGesture.current = null;
  if (!drag) {
    return;
  }
  if (panel.hasPointerCapture(drag.id)) {
    panel.releasePointerCapture(drag.id);
  }
  if (!drag.isDragging) {
    return;
  }
  const clamp = (value: number) => Math.max(0, Math.min(rowsRef.current.length - 1, value));
  const velocity = isCancelled || performance.now() - drag.at > POINTER_VELOCITY_CUTOFF_MS ? 0 : drag.velocity;
  const origin = Math.round(drag.from);
  const next = isCancelled ? origin : Math.round(drag.position + velocity * POINTER_RELEASE_VELOCITY_SCALE);
  startTravel({
    next: clamp(Math.max(origin - 1, Math.min(origin + 1, next))),
    releaseVelocity: velocity,
  });
}

function handleStackPointerDown(input: {
  event: PointerEvent;
  panel: HTMLDivElement;
  pointerGesture: { current: StackPointerDrag | null };
  clickSuppression: { isSuppressed: boolean };
  readTravelPosition: () => number;
  finish: (finishInput: { isCancelled: boolean }) => void;
}): void {
  const { event, pointerGesture, clickSuppression, readTravelPosition, finish } = input;
  if (event.pointerType !== "touch") {
    return;
  }
  if (!event.isPrimary) {
    finish({ isCancelled: true });

    return;
  }
  clickSuppression.isSuppressed = false;
  if (!(event.target instanceof Element)) {
    return;
  }
  const stage = event.target.closest<HTMLElement>(".memory-card-stage");
  if (
    !stage ||
    event.target.closest(
      'button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"]',
    )
  ) {
    return;
  }
  const from = readTravelPosition();
  pointerGesture.current = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    from,
    position: from,
    velocity: 0,
    at: performance.now(),
    span: Math.max(POINTER_SPAN_MIN_PX, stage.clientWidth * POINTER_SPAN_WIDTH_RATIO),
    isDragging: false,
  };
}

function handleStackPointerMove(input: {
  event: PointerEvent;
  panel: HTMLDivElement;
  pointerGesture: { current: StackPointerDrag | null };
  clickSuppression: { isSuppressed: boolean };
  readTravelPosition: () => number;
  frameRef: { current: number };
  travelRef: { current: Travel | null };
  wheelRef: { current: StackWheelState | null };
  store: ReturnType<typeof createMemoryTravelStore>;
  rowsRef: { current: RelationshipMemory[] };
  shouldReduceMotion: boolean;
  setExitIndex: (value: number | null) => void;
  setIsExitFading: (value: boolean) => void;
  setIsTraveling: (value: boolean) => void;
}): void {
  const {
    event,
    panel,
    pointerGesture,
    clickSuppression,
    readTravelPosition,
    frameRef,
    travelRef,
    wheelRef,
    store,
    rowsRef,
    shouldReduceMotion,
    setExitIndex,
    setIsExitFading,
    setIsTraveling,
  } = input;
  const drag = pointerGesture.current;
  if (!drag || drag.id !== event.pointerId) {
    return;
  }
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.isDragging) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < POINTER_DRAG_THRESHOLD_PX) {
      return;
    }
    if (Math.abs(dy) >= Math.abs(dx)) {
      pointerGesture.current = null;

      return;
    }
    drag.from = readTravelPosition();
    drag.position = drag.from;
    drag.isDragging = true;
    clickSuppression.isSuppressed = true;
    cancelAnimationFrame(frameRef.current);
    travelRef.current = null;
    wheelRef.current = null;
    setExitIndex(null);
    setIsExitFading(false);
    if (!shouldReduceMotion) {
      setIsTraveling(true);
    }
    panel.setPointerCapture(event.pointerId);
  }
  event.preventDefault();
  const clamp = (value: number) => Math.max(0, Math.min(rowsRef.current.length - 1, value));
  const now = performance.now();
  const next = clamp(drag.from + Math.max(-1, Math.min(1, -dx / drag.span)));
  drag.velocity = Math.max(
    -POINTER_VELOCITY_CLAMP,
    Math.min(
      POINTER_VELOCITY_CLAMP,
      (next - drag.position) / Math.max(POINTER_VELOCITY_MIN_DELTA_SECONDS, (now - drag.at) / MS_PER_SECOND),
    ),
  );
  drag.position = next;
  drag.at = now;
  if (!shouldReduceMotion) {
    store.set(next);
  }
}

function bindStackTouchPointerNavigation(input: {
  panel: HTMLDivElement;
  rowsRef: { current: RelationshipMemory[] };
  travelRef: { current: Travel | null };
  wheelRef: { current: StackWheelState | null };
  frameRef: { current: number };
  indexRef: { current: number };
  store: ReturnType<typeof createMemoryTravelStore>;
  shouldReduceMotion: boolean;
  startTravel: (request: { next: number; releaseVelocity?: number }) => void;
  stop: () => void;
  setExitIndex: (value: number | null) => void;
  setIsExitFading: (value: boolean) => void;
  setIsTraveling: (value: boolean) => void;
}): () => void {
  const {
    panel,
    rowsRef,
    travelRef,
    wheelRef,
    frameRef,
    indexRef,
    store,
    shouldReduceMotion,
    startTravel,
    stop,
    setExitIndex,
    setIsExitFading,
    setIsTraveling,
  } = input;
  const pointerGesture: { current: StackPointerDrag | null } = { current: null };
  const clickSuppression = { isSuppressed: false };
  const readTravelPosition = () => travelRef.current?.position ?? store.getSnapshot() ?? indexRef.current;
  const finish = (finishInput: { isCancelled: boolean }) => {
    finishStackPointerDrag({
      panel,
      pointerGesture,
      rowsRef,
      startTravel,
      isCancelled: finishInput.isCancelled,
    });
  };
  const down = (event: PointerEvent) => {
    handleStackPointerDown({ event, panel, pointerGesture, clickSuppression, readTravelPosition, finish });
  };
  const move = (event: PointerEvent) => {
    handleStackPointerMove({
      event,
      panel,
      pointerGesture,
      clickSuppression,
      readTravelPosition,
      frameRef,
      travelRef,
      wheelRef,
      store,
      rowsRef,
      shouldReduceMotion,
      setExitIndex,
      setIsExitFading,
      setIsTraveling,
    });
  };
  const endPointer = (input: { event: PointerEvent; isCancelled: boolean }) => {
    if (pointerGesture.current?.id === input.event.pointerId) {
      finish({ isCancelled: input.isCancelled });
    }
  };
  const up = (event: PointerEvent) => endPointer({ event, isCancelled: false });
  const cancel = (event: PointerEvent) => endPointer({ event, isCancelled: true });
  const click = (event: MouseEvent) => {
    if (!clickSuppression.isSuppressed) {
      return;
    }
    clickSuppression.isSuppressed = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return attachPanelPointerListeners({
    panel,
    pointerGesture,
    down,
    move,
    up,
    cancel,
    click,
    stop,
  });
}

function attachPanelPointerListeners(input: {
  panel: HTMLDivElement;
  pointerGesture: { current: StackPointerDrag | null };
  down: (event: PointerEvent) => void;
  move: (event: PointerEvent) => void;
  up: (event: PointerEvent) => void;
  cancel: (event: PointerEvent) => void;
  click: (event: MouseEvent) => void;
  stop: () => void;
}): () => void {
  const { panel, pointerGesture, down, move, up, cancel, click, stop } = input;
  panel.addEventListener("pointerdown", down);
  panel.addEventListener("pointermove", move, { passive: false });
  panel.addEventListener("pointerup", up);
  panel.addEventListener("pointercancel", cancel);
  panel.addEventListener("lostpointercapture", cancel);
  panel.addEventListener("click", click, true);

  return () => {
    const drag = pointerGesture.current;
    pointerGesture.current = null;
    if (drag && panel.hasPointerCapture(drag.id)) {
      panel.releasePointerCapture(drag.id);
    }
    if (drag?.isDragging === true) {
      stop();
    }
    panel.removeEventListener("pointerdown", down);
    panel.removeEventListener("pointermove", move);
    panel.removeEventListener("pointerup", up);
    panel.removeEventListener("pointercancel", cancel);
    panel.removeEventListener("lostpointercapture", cancel);
    panel.removeEventListener("click", click, true);
  };
}

function runMemoryLayoutSelect(input: {
  nextMode: MemoryDisplayMode;
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  transitionRef: { current: ViewTransition | null };
  travelRef: { current: Travel | null };
  indexRef: { current: number };
  root: { current: HTMLDivElement | null };
  rowsRef: { current: RelationshipMemory[] };
  rulerRef: { current: MemoryRulerHandle | null };
  stop: () => void;
  commit: (next: number) => void;
  onModeChange: (mode: MemoryDisplayMode) => void;
  shouldReduceMotion: boolean;
  scrollList: (request: { next: number; isInstant?: boolean }) => void;
}): void {
  const {
    nextMode,
    mode,
    isDisabled,
    transitionRef,
    travelRef,
    indexRef,
    root,
    rowsRef,
    rulerRef,
    stop,
    commit,
    onModeChange,
    shouldReduceMotion,
    scrollList,
  } = input;
  if (nextMode === mode || isDisabled) {
    return;
  }
  transitionRef.current?.skipTransition();
  const selected = Math.round(travelRef.current?.position ?? indexRef.current);
  flushSync(() => {
    stop();
    commit(selected);
    rulerRef.current?.reset();
  });
  const nameRows = () => {
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-memory-id]") ?? [])];
    rows.forEach((element) => {
      const { style, dataset } = element;
      const offset = rowsRef.current.findIndex((memory) => memory.id === dataset.memoryId) - selected;
      style.viewTransitionName = offset >= 0 && offset <= STACK_DEPTH_MAX ? `memory-layout-card-${offset}` : "none";
    });
  };
  nameRows();
  const update = () => {
    flushSync(() => onModeChange(nextMode));
    if (nextMode === "list") {
      scrollList({ next: selected, isInstant: true });
      nameRows();
    }
  };
  const startViewTransition = Reflect.get(document, "startViewTransition");
  if (shouldReduceMotion || typeof startViewTransition !== "function") {
    update();

    return;
  }
  const className = nextMode === "list" ? "memory-layout-to-list" : "memory-layout-to-stack";
  document.documentElement.classList.remove("memory-layout-to-list", "memory-layout-to-stack");
  document.documentElement.classList.add(className);
  const next = startViewTransition(update);
  transitionRef.current = next;
  void (async () => {
    try {
      await next.finished;
    } catch (error) {
      if (!(error instanceof Error)) {
        return;
      }
    } finally {
      if (transitionRef.current === next) {
        transitionRef.current = null;
        document.documentElement.classList.remove(className);
      }
    }
  })();
}

function MemoryCardBrowserStackStage(input: {
  memories: RelationshipMemory[];
  visualPosition: number;
  target: number;
  index: number;
  isTraveling: boolean;
  isDisabled: boolean;
  enteringId: string | null;
  isRevealed: boolean;
  exitIndex: number | null;
  isExitFading: boolean;
  travelRef: { current: Travel | null };
  renderCard: (card: { memory: RelationshipMemory; isActive: boolean }) => ReactNode;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
}): ReactNode {
  const {
    memories,
    visualPosition,
    target,
    index,
    isTraveling,
    isDisabled,
    enteringId,
    isRevealed,
    exitIndex,
    isExitFading,
    travelRef,
    renderCard,
    navigate,
  } = input;
  const exitMemory = exitIndex === null ? undefined : memories[exitIndex];

  return (
    <>
      <div className="memory-card-stage" aria-label="Memory cards">
        {windowIndices({
          count: memories.length,
          start: Math.floor(visualPosition) - STACK_WINDOW_BACK,
          end: Math.ceil(visualPosition) + STACK_WINDOW_FORWARD,
          pinned: [target],
        }).map((cardIndex) => {
          const memory = memories[cardIndex];
          if (memory === undefined) {
            return null;
          }

          return renderStackMemoryCard({
            cardIndex,
            memory,
            memoriesLength: memories.length,
            visualPosition,
            index,
            isTraveling,
            isDisabled,
            enteringId,
            isRevealed,
            exitIndex,
            edgeTravel: travelRef.current,
            renderCard,
            navigate,
          });
        })}
        {exitMemory !== undefined && exitIndex !== null ? (
          <article
            className={`memory-snapshot-card memory-card-exit${isExitFading ? " is-fading" : ""}`}
            aria-hidden="true"
            inert
            style={{
              zIndex: memories.length + STACK_ZINDEX_EXIT_OFFSET,
              transitionDuration:
                Math.abs((travelRef.current?.target ?? index) - exitIndex) === 1
                  ? `${EXIT_TRANSITION_SINGLE_MS}ms`
                  : `${EXIT_TRANSITION_MULTI_MS}ms`,
            }}
          >
            {renderCard({ memory: exitMemory, isActive: false })}
          </article>
        ) : null}
      </div>
    </>
  );
}

function MemoryCardBrowserRuler(input: {
  ruler: RefObject<MemoryRulerHandle | null>;
  rulerItems: ReturnType<typeof buildMemoryRulerItems>;
  index: number;
  store: ReturnType<typeof createMemoryTravelStore>;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
  shouldReduceMotion: boolean;
  isDisabled: boolean;
}): ReactNode {
  const { ruler, rulerItems, index, store, navigate, shouldReduceMotion, isDisabled } = input;

  return (
    <WindowedMemoryRuler
      ref={ruler}
      items={rulerItems}
      position={index}
      travelStore={store}
      onNavigate={(rulerIndex) => navigate({ request: rulerIndex })}
      prefersReducedMotion={shouldReduceMotion}
      label="Memory dates"
      disabled={isDisabled}
      showTodayButton
    />
  );
}

function MemoryCardBrowserStackOverlays(input: {
  isUpgradePreview: boolean;
  navigationHost: HTMLElement | null;
  navigation: ReactNode;
  hasLoadMoreFailed: boolean;
  loadMore: () => void;
  isLoadingMore: boolean;
}): ReactNode {
  const { isUpgradePreview, navigationHost, navigation, hasLoadMoreFailed, loadMore, isLoadingMore } = input;

  return (
    <>
      {isUpgradePreview && navigationHost
        ? createPortal(<div className="memory-upgrade-navigation-layer">{navigation}</div>, navigationHost)
        : navigation}
      {hasLoadMoreFailed ? (
        <p className="memory-card-load-error" role="alert">
          {MEMORY_CARD_BROWSER_COPY.loadMoreError}
          <button type="button" onClick={loadMore} disabled={isLoadingMore}>
            {MEMORY_CARD_BROWSER_COPY.tryAgain}
          </button>
        </p>
      ) : null}
      {isLoadingMore ? (
        <span className="relationship-sr-only" role="status">
          {MEMORY_CARD_BROWSER_COPY.loadingMoreStatus}
        </span>
      ) : null}
    </>
  );
}

function MemoryCardBrowserMainContent(input: {
  mode: MemoryDisplayMode;
  children: ReactNode;
  memories: RelationshipMemory[];
  visualPosition: number;
  target: number;
  index: number;
  isTraveling: boolean;
  isDisabled: boolean;
  enteringId: string | null;
  isRevealed: boolean;
  exitIndex: number | null;
  isExitFading: boolean;
  travelRef: { current: Travel | null };
  renderCard: (card: { memory: RelationshipMemory; isActive: boolean }) => ReactNode;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
  isUpgradePreview: boolean;
  navigationHost: HTMLElement | null;
  navigation: ReactNode;
  hasLoadMoreFailed: boolean;
  loadMore: () => void;
  isLoadingMore: boolean;
}): ReactNode {
  if (input.mode === "list") {
    return input.children;
  }

  return (
    <>
      <MemoryCardBrowserStackStage
        memories={input.memories}
        visualPosition={input.visualPosition}
        target={input.target}
        index={input.index}
        isTraveling={input.isTraveling}
        isDisabled={input.isDisabled}
        enteringId={input.enteringId}
        isRevealed={input.isRevealed}
        exitIndex={input.exitIndex}
        isExitFading={input.isExitFading}
        travelRef={input.travelRef}
        renderCard={input.renderCard}
        navigate={input.navigate}
      />
      <MemoryCardBrowserStackOverlays
        isUpgradePreview={input.isUpgradePreview}
        navigationHost={input.navigationHost}
        navigation={input.navigation}
        hasLoadMoreFailed={input.hasLoadMoreFailed}
        loadMore={input.loadMore}
        isLoadingMore={input.isLoadingMore}
      />
    </>
  );
}

function MemoryCardBrowserView(input: {
  attachRoot: (element: HTMLDivElement | null) => void;
  mode: MemoryDisplayMode;
  isTraveling: boolean;
  isFocused: boolean;
  enteringId: string | null;
  children: ReactNode;
  memories: RelationshipMemory[];
  visualPosition: number;
  target: number;
  index: number;
  isDisabled: boolean;
  isRevealed: boolean;
  exitIndex: number | null;
  isExitFading: boolean;
  travelRef: { current: Travel | null };
  renderCard: (card: { memory: RelationshipMemory; isActive: boolean }) => ReactNode;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
  isUpgradePreview: boolean;
  navigationHost: HTMLElement | null;
  navigation: ReactNode;
  hasLoadMoreFailed: boolean;
  loadMore: () => void;
  isLoadingMore: boolean;
  ruler: RefObject<MemoryRulerHandle | null>;
  rulerItems: ReturnType<typeof buildMemoryRulerItems>;
  store: ReturnType<typeof createMemoryTravelStore>;
  shouldReduceMotion: boolean;
}): ReactNode {
  return (
    <div
      ref={input.attachRoot}
      className={`memory-card-browser${input.mode === "stack" ? " is-stack" : " is-list"}${input.isTraveling ? " is-ruler-traveling" : ""}${input.isFocused ? " is-focused" : ""}`}
    >
      {input.enteringId !== null && input.enteringId !== "" ? <MemoryCardOrganicShimmerFilter /> : null}
      <MemoryCardBrowserMainContent
        mode={input.mode}
        children={input.children}
        memories={input.memories}
        visualPosition={input.visualPosition}
        target={input.target}
        index={input.index}
        isTraveling={input.isTraveling}
        isDisabled={input.isDisabled}
        enteringId={input.enteringId}
        isRevealed={input.isRevealed}
        exitIndex={input.exitIndex}
        isExitFading={input.isExitFading}
        travelRef={input.travelRef}
        renderCard={input.renderCard}
        navigate={input.navigate}
        isUpgradePreview={input.isUpgradePreview}
        navigationHost={input.navigationHost}
        navigation={input.navigation}
        hasLoadMoreFailed={input.hasLoadMoreFailed}
        loadMore={input.loadMore}
        isLoadingMore={input.isLoadingMore}
      />
      {input.mode === "stack" ? (
        <MemoryCardBrowserRuler
          ruler={input.ruler}
          rulerItems={input.rulerItems}
          index={input.index}
          store={input.store}
          navigate={input.navigate}
          shouldReduceMotion={input.shouldReduceMotion}
          isDisabled={input.isDisabled}
        />
      ) : null}
    </div>
  );
}

function useMemoryCardBrowserListNavigation(input: {
  isUpgradePreview: boolean;
  root: { current: HTMLDivElement | null };
  listRef?: RefObject<MemoryVirtualListHandle | null>;
  shouldReduceMotion: boolean;
  commit: (next: number) => void;
  rowsRef: { current: RelationshipMemory[] };
  mode: MemoryDisplayMode;
  isDisabled: boolean;
}): { scrollList: (request: { next: number; isInstant?: boolean }) => void } {
  const { isUpgradePreview, root, listRef, shouldReduceMotion, commit, rowsRef, mode, isDisabled } = input;
  const getListScroller = useCallback(() => {
    if (isUpgradePreview) {
      return root.current?.querySelector<HTMLElement>(".relationship-memory-upgrade-preview");
    }

    return root.current?.closest<HTMLElement>(".relationship-memory-content");
  }, [isUpgradePreview, root]);
  const getListAnchor = useCallback(
    (scroller: HTMLElement) => {
      if (isUpgradePreview) {
        return scroller.getBoundingClientRect().top + LIST_PREVIEW_ANCHOR_OFFSET;
      }
      const toolbar = document.querySelector(".relationship-memory-toolbar");

      return Math.max(
        LIST_ANCHOR_MIN_TOP,
        (toolbar?.getBoundingClientRect().bottom ?? LIST_ANCHOR_FALLBACK_BOTTOM) + LIST_ANCHOR_TOOLBAR_GAP,
      );
    },
    [isUpgradePreview],
  );
  const scrollList = useCallback(
    (request: { next: number; isInstant?: boolean }) => {
      const { next, isInstant = false } = request;
      if (listRef?.current) {
        listRef.current.scrollToIndex(next, isInstant || shouldReduceMotion ? "instant" : "smooth");
        commit(next);

        return;
      }
      const memoryId = rowsRef.current[next]?.id;
      if (memoryId === undefined || memoryId === "") {
        return;
      }
      scrollMemoryListDom({
        next,
        isInstant,
        shouldReduceMotion,
        memoryId,
        root,
        rowsRef,
        getListScroller,
        getListAnchor,
        commit,
      });
    },
    [commit, shouldReduceMotion, getListScroller, getListAnchor, listRef, root, rowsRef],
  );
  useEffect(() => {
    if (mode !== "list" || isDisabled) {
      return;
    }
    const scroller = getListScroller();
    if (!scroller) {
      return;
    }
    const scrollFrame = { current: 0 };
    const sync = () => {
      if (scrollFrame.current !== 0) {
        return;
      }
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = 0;
        if (listRef?.current) {
          commit(listRef.current.nearestIndex());

          return;
        }
        const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-memory-id]") ?? [])].filter(
          (row) => !row.closest("[hidden]"),
        );
        if (rows.length === 0) {
          return;
        }
        const anchor = getListAnchor(scroller);
        const nearest = rows.reduce((a, b) =>
          Math.abs(a.getBoundingClientRect().top - anchor) <= Math.abs(b.getBoundingClientRect().top - anchor) ? a : b,
        );
        const next = rowsRef.current.findIndex((memory) => memory.id === nearest.dataset.memoryId);
        if (next >= 0) {
          commit(next);
        }
      });
    };
    scroller.addEventListener("scroll", sync, { passive: true });

    return () => {
      scroller.removeEventListener("scroll", sync);
      cancelAnimationFrame(scrollFrame.current);
    };
  }, [mode, isDisabled, commit, getListScroller, getListAnchor, listRef, root, rowsRef]);

  return { scrollList };
}

function bindStackWheelListener(input: {
  panel: HTMLDivElement;
  ruler: RefObject<MemoryRulerHandle | null>;
  travel: { current: Travel | null };
  wheel: { current: StackWheelState | null };
  indexRef: { current: number };
  rowsRef: { current: RelationshipMemory[] };
  startTravel: (request: { next: number; wheel?: StackWheelState }) => void;
}): () => void {
  const { panel, ruler, travel, wheel, indexRef, rowsRef, startTravel } = input;
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) {
      return;
    }
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    ruler.current?.resume();
    const motion = travel.current;
    const next = accumulateStackWheel({
      previous: wheel.current,
      delta,
      deltaMode: event.deltaMode,
      pageHeight: panel.clientHeight,
      position: motion?.position ?? indexRef.current,
      destination: motion?.target ?? indexRef.current,
      maxIndex: rowsRef.current.length - 1,
      now: performance.now(),
    });
    wheel.current = next;
    startTravel({ next: Math.round(next.position), wheel: next });
  };
  panel.addEventListener("wheel", onWheel, { passive: false });

  return () => panel.removeEventListener("wheel", onWheel);
}

function bindStackKeyboardListener(input: {
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
}): () => void {
  const { navigate } = input;
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest(
        'button, a[href], input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="textbox"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="menu"], [role="dialog"], [role="tablist"]',
      )
    ) {
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      navigate({ request: (current) => current + 1 });
    }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      navigate({ request: (current) => current - 1 });
    }
  };
  window.addEventListener("keydown", keydown);

  return () => window.removeEventListener("keydown", keydown);
}

function useMemoryCardStackInteractionEffects(input: {
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  isFocused: boolean;
  ids: string;
  selectedId?: string;
  rowsRef: { current: RelationshipMemory[] };
  travel: { current: Travel | null };
  wheel: { current: StackWheelState | null };
  frame: { current: number };
  indexRef: { current: number };
  root: { current: HTMLDivElement | null };
  ruler: RefObject<MemoryRulerHandle | null>;
  store: ReturnType<typeof createMemoryTravelStore>;
  shouldReduceMotion: boolean;
  startTravel: (request: { next: number; wheel?: StackWheelState; isEdge?: boolean; releaseVelocity?: number }) => void;
  stop: () => void;
  setExitIndex: (value: number | null) => void;
  setIsExitFading: (value: boolean) => void;
  setIsTraveling: (value: boolean) => void;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
}): void {
  const {
    mode,
    isDisabled,
    isFocused,
    ids,
    selectedId,
    rowsRef,
    travel,
    wheel,
    frame,
    indexRef,
    root,
    ruler,
    store,
    shouldReduceMotion,
    startTravel,
    stop,
    setExitIndex,
    setIsExitFading,
    setIsTraveling,
    navigate,
  } = input;
  useEffect(() => {
    const panel = root.current;
    if (!panel || mode !== "stack" || isDisabled || isFocused) {
      return;
    }

    return bindStackTouchPointerNavigation({
      panel,
      rowsRef,
      travelRef: travel,
      wheelRef: wheel,
      frameRef: frame,
      indexRef,
      store,
      shouldReduceMotion,
      startTravel,
      stop,
      setExitIndex,
      setIsExitFading,
      setIsTraveling,
    });
  }, [
    isDisabled,
    isFocused,
    mode,
    ids,
    selectedId,
    shouldReduceMotion,
    startTravel,
    store,
    stop,
    root,
    rowsRef,
    travel,
    wheel,
    frame,
    indexRef,
    setExitIndex,
    setIsExitFading,
    setIsTraveling,
  ]);
  useEffect(() => {
    const panel = root.current;
    if (!panel || mode !== "stack" || isDisabled) {
      return;
    }

    return bindStackWheelListener({ panel, ruler, travel, wheel, indexRef, rowsRef, startTravel });
  }, [isDisabled, mode, startTravel, root, ruler, travel, wheel, indexRef, rowsRef]);
  useEffect(() => {
    if (mode !== "stack" || isDisabled) {
      return;
    }

    return bindStackKeyboardListener({ navigate });
  }, [isDisabled, mode, navigate]);
}

function useMemoryCardStackTravel(input: {
  travel: { current: Travel | null };
  frame: { current: number };
  indexRef: { current: number };
  root: { current: HTMLDivElement | null };
  store: ReturnType<typeof createMemoryTravelStore>;
  shouldReduceMotion: boolean;
  commit: (next: number) => void;
  stop: () => void;
  setTarget: (next: number) => void;
  setIsTraveling: (value: boolean) => void;
  setExitIndex: (value: number | null) => void;
  setIsExitFading: (value: boolean) => void;
}): {
  startTravel: (request: { next: number; wheel?: StackWheelState; isEdge?: boolean; releaseVelocity?: number }) => void;
} {
  const {
    travel,
    frame,
    indexRef,
    root,
    store,
    shouldReduceMotion,
    commit,
    stop,
    setTarget,
    setIsTraveling,
    setExitIndex,
    setIsExitFading,
  } = input;
  const startTravel = useCallback(
    (request: { next: number; wheel?: StackWheelState; isEdge?: boolean; releaseVelocity?: number }) => {
      const { next, wheel: wheelInput, isEdge = false, releaseVelocity = 0 } = request;
      const current = travel.current;
      const from = current?.position ?? store.getSnapshot() ?? indexRef.current;
      if (
        tryRetargetStackTravel({
          current,
          isEdge,
          shouldReduceMotion,
          next,
          wheelInput,
          setTarget,
        })
      ) {
        return;
      }
      cancelAnimationFrame(frame.current);
      if (shouldReduceMotion || from === (wheelInput?.position ?? next)) {
        stop();
        commit(next);

        return;
      }
      launchStackTravel({
        from,
        next,
        wheelInput,
        releaseVelocity,
        isEdge,
        current,
        travelRef: travel,
        frameRef: frame,
        root,
        store,
        commit,
        stop,
        setTarget,
        setIsTraveling,
        setExitIndex,
        setIsExitFading,
      });
    },
    [
      commit,
      shouldReduceMotion,
      stop,
      store,
      travel,
      frame,
      root,
      indexRef,
      setTarget,
      setIsTraveling,
      setExitIndex,
      setIsExitFading,
    ],
  );

  return { startTravel };
}

function useMemoryCardBrowserNavigate(input: {
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  scrollList: (request: { next: number; isInstant?: boolean }) => void;
  rowsRef: { current: RelationshipMemory[] };
  travel: { current: Travel | null };
  wheel: { current: StackWheelState | null };
  ruler: RefObject<MemoryRulerHandle | null>;
  indexRef: { current: number };
  startTravel: (request: { next: number; wheel?: StackWheelState; isEdge?: boolean; releaseVelocity?: number }) => void;
}): {
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
} {
  const { mode, isDisabled, scrollList, rowsRef, travel, wheel, ruler, indexRef, startTravel } = input;
  const navigate = useCallback(
    (request: { request: number | ((current: number) => number); isEdge?: boolean }) => {
      const { request: value, isEdge = false } = request;
      if (isDisabled || rowsRef.current.length === 0) {
        return;
      }
      wheel.current = null;
      ruler.current?.reset();
      const motion = travel.current;
      const base = motion
        ? motion.wheel !== undefined
          ? Math.round(motion.position)
          : motion.target
        : indexRef.current;
      const next = Math.max(0, Math.min(rowsRef.current.length - 1, typeof value === "function" ? value(base) : value));
      if (mode === "list") {
        scrollList({ next });
      } else {
        startTravel({ next, isEdge });
      }
    },
    [isDisabled, mode, scrollList, startTravel, rowsRef, wheel, ruler, travel, indexRef],
  );

  return { navigate };
}

function useMemoryCardBrowserStackNavigation(input: {
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  isFocused: boolean;
  ids: string;
  selectedId?: string;
  scrollList: (request: { next: number; isInstant?: boolean }) => void;
  rowsRef: { current: RelationshipMemory[] };
  travel: { current: Travel | null };
  wheel: { current: StackWheelState | null };
  frame: { current: number };
  indexRef: { current: number };
  root: { current: HTMLDivElement | null };
  ruler: RefObject<MemoryRulerHandle | null>;
  store: ReturnType<typeof createMemoryTravelStore>;
  shouldReduceMotion: boolean;
  commit: (next: number) => void;
  stop: () => void;
  setTarget: (next: number) => void;
  setIsTraveling: (value: boolean) => void;
  setExitIndex: (value: number | null) => void;
  setIsExitFading: (value: boolean) => void;
}): {
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
} {
  const {
    mode,
    isDisabled,
    isFocused,
    ids,
    selectedId,
    scrollList,
    rowsRef,
    travel,
    wheel,
    frame,
    indexRef,
    root,
    ruler,
    store,
    shouldReduceMotion,
    commit,
    stop,
    setTarget,
    setIsTraveling,
    setExitIndex,
    setIsExitFading,
  } = input;
  const { startTravel } = useMemoryCardStackTravel({
    travel,
    frame,
    indexRef,
    root,
    store,
    shouldReduceMotion,
    commit,
    stop,
    setTarget,
    setIsTraveling,
    setExitIndex,
    setIsExitFading,
  });
  const { navigate } = useMemoryCardBrowserNavigate({
    mode,
    isDisabled,
    scrollList,
    rowsRef,
    travel,
    wheel,
    ruler,
    indexRef,
    startTravel,
  });
  useMemoryCardStackInteractionEffects({
    mode,
    isDisabled,
    isFocused,
    ids,
    selectedId,
    rowsRef,
    travel,
    wheel,
    frame,
    indexRef,
    root,
    ruler,
    store,
    shouldReduceMotion,
    startTravel,
    stop,
    setExitIndex,
    setIsExitFading,
    setIsTraveling,
    navigate,
  });

  return { navigate };
}

function useMemoryCardMotionPreference(input: {
  setShouldReduceMotion: (value: boolean) => void;
  setIsMotionReady: (value: boolean) => void;
}): void {
  const { setShouldReduceMotion, setIsMotionReady } = input;
  useLayoutEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setShouldReduceMotion(query.matches);
    update();
    setIsMotionReady(true);
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, [setIsMotionReady, setShouldReduceMotion]);
}

function useMemoryCardEnteringLifecycle(input: {
  memories: RelationshipMemory[];
  arrivingIds: readonly string[];
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  visualPosition: number;
  rowsRef: { current: RelationshipMemory[] };
  observedArrivals: { current: readonly string[] };
  isMotionReady: boolean;
  enteringId: string | null;
  isTraveling: boolean;
  shouldReduceMotion: boolean;
  onArrivalComplete: (id: string) => void;
  setEnteringId: (id: string | null) => void;
  setIsRevealed: (value: boolean) => void;
  commit: (next: number) => void;
  stop: () => void;
}): void {
  const {
    memories,
    arrivingIds,
    mode,
    isDisabled,
    visualPosition,
    rowsRef,
    observedArrivals,
    isMotionReady,
    enteringId,
    isTraveling,
    shouldReduceMotion,
    onArrivalComplete,
    setEnteringId,
    setIsRevealed,
    commit,
    stop,
  } = input;
  useLayoutEffect(() => {
    reconcilePollArrivals({
      arrivingIds,
      observedArrivals,
      mode,
      isDisabled,
      rowsRef,
      stop,
      commit,
      onArrivalComplete,
    });
  }, [arrivingIds, mode, isDisabled, stop, commit, onArrivalComplete, observedArrivals, rowsRef]);
  const visibleId = memories[Math.round(visualPosition)]?.id;
  useLayoutEffect(() => {
    reconcileEnteringMemoryLayout({
      isMotionReady,
      enteringId,
      mode,
      isDisabled,
      isTraveling,
      shouldReduceMotion,
      visibleId,
      arrivingIds,
      onArrivalComplete,
      setEnteringId,
      setIsRevealed,
    });
  }, [
    arrivingIds,
    isDisabled,
    enteringId,
    mode,
    isMotionReady,
    onArrivalComplete,
    shouldReduceMotion,
    isTraveling,
    visibleId,
    setEnteringId,
    setIsRevealed,
  ]);
  useEffect(() => {
    if (enteringId === null || enteringId === "") {
      return;
    }
    const reveal = setTimeout(() => setIsRevealed(true), ARRIVAL_REVEAL_DELAY_MS);
    const finish = setTimeout(() => {
      onArrivalComplete(enteringId);
      setEnteringId(null);
      setIsRevealed(false);
    }, ARRIVAL_FINISH_DELAY_MS);

    return () => {
      clearTimeout(reveal);
      clearTimeout(finish);
    };
  }, [enteringId, onArrivalComplete, setEnteringId, setIsRevealed]);
}

function useMemoryCardIndexLifecycle(input: {
  selectedId?: string;
  ids: string;
  rowsRef: { current: RelationshipMemory[] };
  activeId: { current: string | undefined };
  travel: { current: Travel | null };
  transition: { current: ViewTransition | null };
  frame: { current: number };
  isDisabled: boolean;
  shouldReduceMotion: boolean;
  commit: (next: number) => void;
  stop: () => void;
}): void {
  const {
    selectedId,
    ids,
    rowsRef,
    activeId,
    travel,
    transition,
    frame,
    isDisabled,
    shouldReduceMotion,
    commit,
    stop,
  } = input;
  useLayoutEffect(() => {
    const found = rowsRef.current.findIndex((memory) => memory.id === activeId.current);
    stop();
    commit(found < 0 ? 0 : found);
  }, [ids, stop, commit, rowsRef, activeId]);
  useEffect(() => {
    if (selectedId !== undefined && selectedId !== "") {
      const found = rowsRef.current.findIndex((memory) => memory.id === selectedId);
      if (found >= 0) {
        stop();
        commit(found);
      }
    }
  }, [selectedId, stop, commit, rowsRef]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      transition.current?.skipTransition();
      document.documentElement.classList.remove("memory-layout-to-list", "memory-layout-to-stack");
    },
    [frame, transition],
  );
  useEffect(() => {
    if (isDisabled || shouldReduceMotion) {
      const next = travel.current?.target;
      stop();
      if (next !== undefined) {
        commit(next);
      }
    }
  }, [isDisabled, shouldReduceMotion, stop, commit, travel]);
}

type MemoryCardBrowserProps = {
  ref?: Ref<MemoryCardBrowserHandle>;
  memories: RelationshipMemory[];
  mode: MemoryDisplayMode;
  onModeChange: (mode: MemoryDisplayMode) => void;
  selectedId?: string;
  /** @external existing memory card browser prop contract */
  disabled: boolean;
  /** @external existing memory card browser prop contract */
  focused?: boolean;
  children: ReactNode;
  listRef?: RefObject<MemoryVirtualListHandle | null>;
  renderCard: (input: { memory: RelationshipMemory; isActive: boolean }) => ReactNode;
  /** @external existing memory card browser prop contract */
  hasMore: boolean;
  /** @external existing memory card browser prop contract */
  loadingMore: boolean;
  /** @external existing memory card browser prop contract */
  loadMoreFailed?: boolean;
  /** @external existing memory card browser prop contract */
  upgradePreview?: boolean;
  arrivingIds?: readonly string[];
  onArrivalComplete?: (id: string) => void;
  loadMore: () => void;
};

function useMemoryCardBrowserCore(input: { memories: RelationshipMemory[]; isUpgradePreview: boolean }) {
  const { memories, isUpgradePreview } = input;
  const root = useRef<HTMLDivElement>(null);
  const [navigationHost, setNavigationHost] = useState<HTMLElement | null>(null);
  const attachRoot = useCallback(
    (element: HTMLDivElement | null) => {
      root.current = element;
      setNavigationHost(isUpgradePreview ? (element?.parentElement ?? null) : null);
    },
    [isUpgradePreview],
  );
  const ruler = useRef<MemoryRulerHandle>(null);
  const [store] = useState(createMemoryTravelStore);
  const position = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const activeId = useRef(memories[0]?.id);
  const [target, setTarget] = useState(0);
  const [isTraveling, setIsTraveling] = useState(false);
  const [exitIndex, setExitIndex] = useState<number | null>(null);
  const [isExitFading, setIsExitFading] = useState(false);
  const [shouldReduceMotion, setShouldReduceMotion] = useState(true);
  const [isMotionReady, setIsMotionReady] = useState(false);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const observedArrivals = useRef<readonly string[]>([]);
  const travel = useRef<Travel | null>(null);
  const wheel = useRef<StackWheelState | null>(null);
  const frame = useRef(0);
  const transition = useRef<ViewTransition | null>(null);
  const rowsRef = useRef(memories);
  useLayoutEffect(() => {
    rowsRef.current = memories;
  });
  const ids = memories.map((memory) => memory.id).join(",");
  const rulerItems = useMemo(() => buildMemoryRulerItems(memories), [memories]);
  const visualPosition = position ?? index;
  const commit = useCallback((next: number) => {
    indexRef.current = next;
    activeId.current = rowsRef.current[next]?.id;
    setIndex(next);
    setTarget(next);
  }, []);
  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    travel.current = null;
    wheel.current = null;
    store.set(null);
    setIsTraveling(false);
    setExitIndex(null);
    setIsExitFading(false);
  }, [store]);

  return {
    root,
    navigationHost,
    attachRoot,
    ruler,
    store,
    index,
    indexRef,
    activeId,
    target,
    isTraveling,
    exitIndex,
    isExitFading,
    shouldReduceMotion,
    setShouldReduceMotion,
    isMotionReady,
    setIsMotionReady,
    enteringId,
    setEnteringId,
    isRevealed,
    setIsRevealed,
    observedArrivals,
    travel,
    wheel,
    frame,
    transition,
    rowsRef,
    ids,
    rulerItems,
    visualPosition,
    commit,
    stop,
    setTarget,
    setIsTraveling,
    setExitIndex,
    setIsExitFading,
  };
}

function renderMemoryCardNavigation(input: {
  isDisabled: boolean;
  target: number;
  memoriesLength: number;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
}): ReactNode {
  const { isDisabled, target, memoriesLength, navigate } = input;

  return (
    <div className="memory-ruler-controls memory-card-navigation" inert={isDisabled}>
      <button
        type="button"
        className="workspace-upcoming-calendar-nav-button memory-ruler-control-button is-older"
        aria-label="Go to an older memory"
        disabled={target >= memoriesLength - 1}
        onClick={() => navigate({ request: (current) => current + 1 })}
      >
        <MemoryIcon name="chevron" />
      </button>
      <button
        type="button"
        className="workspace-upcoming-calendar-nav-button memory-ruler-control-button is-newer"
        aria-label="Go to a newer memory"
        disabled={target <= 0}
        onClick={() => navigate({ request: (current) => current - 1 })}
      >
        <MemoryIcon name="chevron" />
      </button>
    </div>
  );
}

function useMemoryCardBrowserChrome(input: {
  ref?: Ref<MemoryCardBrowserHandle>;
  mode: MemoryDisplayMode;
  isDisabled: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  hasLoadMoreFailed: boolean;
  target: number;
  index: number;
  memoriesLength: number;
  loadMore: () => void;
  transition: { current: ViewTransition | null };
  travel: { current: Travel | null };
  indexRef: { current: number };
  root: { current: HTMLDivElement | null };
  rowsRef: { current: RelationshipMemory[] };
  ruler: RefObject<MemoryRulerHandle | null>;
  stop: () => void;
  commit: (next: number) => void;
  onModeChange: (mode: MemoryDisplayMode) => void;
  shouldReduceMotion: boolean;
  scrollList: (request: { next: number; isInstant?: boolean }) => void;
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
}): { navigation: ReactNode } {
  const {
    ref,
    mode,
    isDisabled,
    hasMore,
    isLoadingMore,
    hasLoadMoreFailed,
    target,
    index,
    memoriesLength,
    loadMore,
    transition,
    travel,
    indexRef,
    root,
    rowsRef,
    ruler,
    stop,
    commit,
    onModeChange,
    shouldReduceMotion,
    scrollList,
    navigate,
  } = input;
  const selectLayout = (nextMode: MemoryDisplayMode) => {
    runMemoryLayoutSelect({
      nextMode,
      mode,
      isDisabled,
      transitionRef: transition,
      travelRef: travel,
      indexRef,
      root,
      rowsRef,
      rulerRef: ruler,
      stop,
      commit,
      onModeChange,
      shouldReduceMotion,
      scrollList,
    });
  };
  useImperativeHandle(ref, () => ({ selectLayout }));
  useEffect(() => {
    if (
      mode === "stack" &&
      hasMore &&
      !isLoadingMore &&
      !hasLoadMoreFailed &&
      Math.max(target, index) >= memoriesLength - LOAD_MORE_THRESHOLD_FROM_END
    ) {
      loadMore();
    }
  }, [mode, hasMore, isLoadingMore, hasLoadMoreFailed, target, index, memoriesLength, loadMore]);
  const navigation = renderMemoryCardNavigation({ isDisabled, target, memoriesLength, navigate });

  return { navigation };
}

function useMemoryCardBrowserLifecycleBundle(input: {
  core: ReturnType<typeof useMemoryCardBrowserCore>;
  memories: RelationshipMemory[];
  mode: MemoryDisplayMode;
  selectedId?: string;
  arrivingIds: readonly string[];
  onArrivalComplete: (id: string) => void;
  isDisabled: boolean;
}): void {
  const { core, memories, mode, selectedId, arrivingIds, onArrivalComplete, isDisabled } = input;
  const {
    rowsRef,
    activeId,
    travel,
    transition,
    frame,
    shouldReduceMotion,
    setShouldReduceMotion,
    isMotionReady,
    setIsMotionReady,
    enteringId,
    isTraveling,
    setEnteringId,
    setIsRevealed,
    observedArrivals,
    ids,
    visualPosition,
    commit,
    stop,
  } = core;
  useMemoryCardMotionPreference({ setShouldReduceMotion, setIsMotionReady });
  useMemoryCardIndexLifecycle({
    selectedId,
    ids,
    rowsRef,
    activeId,
    travel,
    transition,
    frame,
    isDisabled,
    shouldReduceMotion,
    commit,
    stop,
  });
  useMemoryCardEnteringLifecycle({
    memories,
    arrivingIds,
    mode,
    isDisabled,
    visualPosition,
    rowsRef,
    observedArrivals,
    isMotionReady,
    enteringId,
    isTraveling,
    shouldReduceMotion,
    onArrivalComplete,
    setEnteringId,
    setIsRevealed,
    commit,
    stop,
  });
}

function useMemoryCardBrowserListAndStackNav(input: {
  core: ReturnType<typeof useMemoryCardBrowserCore>;
  mode: MemoryDisplayMode;
  selectedId?: string;
  listRef?: RefObject<MemoryVirtualListHandle | null>;
  isDisabled: boolean;
  isFocused: boolean;
  isUpgradePreview: boolean;
}): {
  navigate: (request: { request: number | ((current: number) => number); isEdge?: boolean }) => void;
  scrollList: (request: { next: number; isInstant?: boolean }) => void;
} {
  const { core, mode, selectedId, listRef, isDisabled, isFocused, isUpgradePreview } = input;
  const {
    root,
    ruler,
    store,
    indexRef,
    travel,
    wheel,
    frame,
    rowsRef,
    ids,
    shouldReduceMotion,
    commit,
    stop,
    setTarget,
    setIsTraveling,
    setExitIndex,
    setIsExitFading,
  } = core;
  const { scrollList } = useMemoryCardBrowserListNavigation({
    isUpgradePreview,
    root,
    listRef,
    shouldReduceMotion,
    commit,
    rowsRef,
    mode,
    isDisabled,
  });
  const { navigate } = useMemoryCardBrowserStackNavigation({
    mode,
    isDisabled,
    isFocused,
    ids,
    selectedId,
    scrollList,
    rowsRef,
    travel,
    wheel,
    frame,
    indexRef,
    root,
    ruler,
    store,
    shouldReduceMotion,
    commit,
    stop,
    setTarget,
    setIsTraveling,
    setExitIndex,
    setIsExitFading,
  });

  return { navigate, scrollList };
}

export function MemoryCardBrowser({
  ref,
  memories,
  mode,
  onModeChange,
  selectedId,
  children,
  listRef,
  renderCard,
  loadMore,
  arrivingIds = NO_ARRIVALS,
  onArrivalComplete = ignoreArrival,
  ...browserProps
}: MemoryCardBrowserProps) {
  const isDisabled = browserProps.disabled;
  const isFocused = browserProps.focused === true;
  const hasMore = browserProps.hasMore;
  const isLoadingMore = browserProps.loadingMore;
  const hasLoadMoreFailed = browserProps.loadMoreFailed === true;
  const isUpgradePreview = browserProps.upgradePreview === true;
  const core = useMemoryCardBrowserCore({ memories, isUpgradePreview });
  useMemoryCardBrowserLifecycleBundle({
    core,
    memories,
    mode,
    selectedId,
    arrivingIds,
    onArrivalComplete,
    isDisabled,
  });
  const { navigate, scrollList } = useMemoryCardBrowserListAndStackNav({
    core,
    mode,
    selectedId,
    listRef,
    isDisabled,
    isFocused,
    isUpgradePreview,
  });
  const { navigation } = useMemoryCardBrowserChrome({
    ref,
    mode,
    isDisabled,
    hasMore,
    isLoadingMore,
    hasLoadMoreFailed,
    target: core.target,
    index: core.index,
    memoriesLength: memories.length,
    loadMore,
    transition: core.transition,
    travel: core.travel,
    indexRef: core.indexRef,
    root: core.root,
    rowsRef: core.rowsRef,
    ruler: core.ruler,
    stop: core.stop,
    commit: core.commit,
    onModeChange,
    shouldReduceMotion: core.shouldReduceMotion,
    scrollList,
    navigate,
  });

  return (
    <MemoryCardBrowserView
      attachRoot={core.attachRoot}
      mode={mode}
      isTraveling={core.isTraveling}
      isFocused={isFocused}
      enteringId={core.enteringId}
      children={children}
      memories={memories}
      visualPosition={core.visualPosition}
      target={core.target}
      index={core.index}
      isDisabled={isDisabled}
      isRevealed={core.isRevealed}
      exitIndex={core.exitIndex}
      isExitFading={core.isExitFading}
      travelRef={core.travel}
      renderCard={renderCard}
      navigate={navigate}
      isUpgradePreview={isUpgradePreview}
      navigationHost={core.navigationHost}
      navigation={navigation}
      hasLoadMoreFailed={hasLoadMoreFailed}
      loadMore={loadMore}
      isLoadingMore={isLoadingMore}
      ruler={core.ruler}
      rulerItems={core.rulerItems}
      store={core.store}
      shouldReduceMotion={core.shouldReduceMotion}
    />
  );
}
