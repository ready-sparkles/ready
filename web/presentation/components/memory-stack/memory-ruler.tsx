"use client";
// Ruler lens, edge panning, hit testing and windowing ported from Highlight.
import type { RelationshipMemory } from "@readymeet/shared";
import {
  type CSSProperties,
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { memoryDay } from "../memory-browser-controls";

import { advanceSpring } from "./spring";
import type { MemoryTravelStore } from "./travel-store";
import { lowerBound, nearestIndex, windowIndices } from "./windowing";

const MEMORY_RULER_MOMENT_GAP = 7;
const MEMORY_RULER_DAY_TO_MOMENT_GAP = 14;
const MEMORY_RULER_DAY_SECTION_GAP = 18;
const MEMORY_RULER_HOVER_RADIUS = 8;
const MEMORY_RULER_MAGNIFICATION_RADIUS = 56;
const MEMORY_RULER_SPREAD_RADIUS = 84;
const MEMORY_RULER_SPREAD_STRENGTH = 4.92;
const MEMORY_RULER_RESTING_TICK_WIDTH = 8;
const MEMORY_RULER_ACTIVE_TICK_WIDTH = 18;
const MEMORY_RULER_MAX_TICK_WIDTH = 84;
const MEMORY_RULER_RESTING_TICK_HEIGHT = 2.5;
const MEMORY_RULER_MAX_TICK_HEIGHT = 24;
const MEMORY_RULER_SPRING_STIFFNESS = 240;
const MEMORY_RULER_SPRING_DAMPING = 31;
const MEMORY_RULER_EDGE_ZONE = 88;
const MEMORY_RULER_EDGE_MAX_SPEED = 520;
const MEMORY_RULER_EDGE_VELOCITY_RESPONSE = 10;
const MEMORY_RULER_EDGE_RETURN_STIFFNESS = 180;
const MEMORY_RULER_EDGE_RETURN_DAMPING = 27;
const MEMORY_RULER_EDGE_CONTENT_INSET = 28;
const MEMORY_RULER_DATE_PAD_WIDTH = 2;
const MEMORY_RULER_MS_PER_SECOND = 1000;
const MEMORY_RULER_FRAMES_PER_SECOND = 30;
const MEMORY_RULER_MAX_FRAME_SECONDS = 1 / MEMORY_RULER_FRAMES_PER_SECOND;
const MEMORY_RULER_FOCUS_POSITION_TOLERANCE = 0.01;
const MEMORY_RULER_FOCUS_VELOCITY_TOLERANCE = 0.01;
const MEMORY_RULER_STRENGTH_POSITION_TOLERANCE = 0.001;
const MEMORY_RULER_STRENGTH_VELOCITY_TOLERANCE = 0.001;
const MEMORY_RULER_STRENGTH_SNAP_THRESHOLD = 0.001;
const MEMORY_RULER_EDGE_RETURN_POSITION_TOLERANCE = 0.05;
const MEMORY_RULER_EDGE_RETURN_VELOCITY_TOLERANCE = 0.05;
const MEMORY_RULER_EDGE_PROGRESS_THRESHOLD = 0.001;
const MEMORY_RULER_EDGE_VELOCITY_THRESHOLD = 0.05;
const MEMORY_RULER_DEFAULT_TRACK_HEIGHT = 800;
const MEMORY_RULER_SPREAD_DIVISOR = 2;
const MEMORY_RULER_OVERSCAN_BASE = 200;
const MEMORY_RULER_TODAY_VISIBILITY_INSET = 12;
const MEMORY_RULER_TODAY_VISIBILITY_TOP_OFFSET = 78;
const MEMORY_RULER_HALF_DIVISOR = 2;
const MEMORY_RULER_CENTER_DIVISOR = 2;
const MEMORY_RULER_TICK_OPACITY_TODAY_BASE = 0.72;
const MEMORY_RULER_TICK_OPACITY_TODAY_SCALE = 0.28;
const MEMORY_RULER_TICK_OPACITY_DAY_BASE = 0.46;
const MEMORY_RULER_TICK_OPACITY_DAY_SCALE = 0.34;
const MEMORY_RULER_TICK_OPACITY_MOMENT_BASE = 0.32;
const MEMORY_RULER_TICK_OPACITY_MOMENT_SCALE = 0.68;
const MEMORY_RULER_MAGNIFICATION_POWER = 1.35;
const MEMORY_RULER_DAY_FONT_BASE = 10;
const MEMORY_RULER_DAY_FONT_SCALE = 1.2;
const MEMORY_RULER_MOMENT_FONT_BASE = 9;
const MEMORY_RULER_MOMENT_FONT_SCALE = 2;
const MEMORY_RULER_ITEM_MISSING_MESSAGE = "Memory ruler item is missing";
const MEMORY_RULER_DAY_MISSING_MESSAGE = "Memory ruler day is missing its first memory";

const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(MEMORY_RULER_DATE_PAD_WIDTH, "0")}-${String(date.getDate()).padStart(MEMORY_RULER_DATE_PAD_WIDTH, "0")}`;

type MemoryRulerFocus = {
  offset: number;
  strength: number;
};

type MemoryRulerFocusMotion = MemoryRulerFocus & {
  offsetVelocity: number;
  strengthVelocity: number;
};

function advanceMemoryRulerFocusFrame(input: {
  motion: MemoryRulerFocusMotion;
  target: MemoryRulerFocus;
  deltaTime: number;
}): { motion: MemoryRulerFocusMotion; isSettled: boolean } {
  const { motion, target, deltaTime } = input;
  const offsetStep = advanceSpring({
    position: motion.offset,
    velocity: motion.offsetVelocity,
    target: target.offset,
    seconds: deltaTime,
    options: {
      stiffness: MEMORY_RULER_SPRING_STIFFNESS,
      damping: MEMORY_RULER_SPRING_DAMPING,
      positionTolerance: MEMORY_RULER_FOCUS_POSITION_TOLERANCE,
      velocityTolerance: MEMORY_RULER_FOCUS_VELOCITY_TOLERANCE,
    },
  });
  const strengthStep = advanceSpring({
    position: motion.strength,
    velocity: motion.strengthVelocity,
    target: target.strength,
    seconds: deltaTime,
    options: {
      stiffness: MEMORY_RULER_SPRING_STIFFNESS,
      damping: MEMORY_RULER_SPRING_DAMPING,
      positionTolerance: MEMORY_RULER_STRENGTH_POSITION_TOLERANCE,
      velocityTolerance: MEMORY_RULER_STRENGTH_VELOCITY_TOLERANCE,
    },
  });

  return {
    motion: {
      offset: offsetStep.position,
      offsetVelocity: offsetStep.velocity,
      strength: Math.min(1, Math.max(0, strengthStep.position)),
      strengthVelocity: strengthStep.velocity,
    },
    isSettled: offsetStep.settled && strengthStep.settled,
  };
}

function snapMemoryRulerFocusMotionToTarget(input: { target: MemoryRulerFocus }): MemoryRulerFocusMotion {
  return {
    offset: input.target.offset,
    offsetVelocity: 0,
    strength: input.target.strength,
    strengthVelocity: 0,
  };
}

function useMemoryRulerFocus(pointerOffset: number | null): MemoryRulerFocus {
  const [focus, setFocus] = useState<MemoryRulerFocus>({ offset: 0, strength: 0 });
  const [isReducedMotionPreferred, setIsReducedMotionPreferred] = useState(false);
  const motionRef = useRef<MemoryRulerFocusMotion>({
    offset: 0,
    offsetVelocity: 0,
    strength: 0,
    strengthVelocity: 0,
  });
  const targetRef = useRef<MemoryRulerFocus>({ offset: 0, strength: 0 });
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);

  const animateFocus = useCallback((timestamp: number) => {
    const motion = motionRef.current;
    const target = targetRef.current;
    const previousTimestamp = lastFrameTimeRef.current !== 0 ? lastFrameTimeRef.current : timestamp;
    const deltaTime = Math.min(
      (timestamp - previousTimestamp) / MEMORY_RULER_MS_PER_SECOND,
      MEMORY_RULER_MAX_FRAME_SECONDS,
    );
    lastFrameTimeRef.current = timestamp;

    const focusStep = advanceMemoryRulerFocusFrame({ motion, target, deltaTime });
    motionRef.current = focusStep.motion;
    setFocus({ offset: focusStep.motion.offset, strength: focusStep.motion.strength });

    if (focusStep.isSettled) {
      animationFrameRef.current = null;
      lastFrameTimeRef.current = 0;

      return;
    }

    animationFrameRef.current = requestAnimationFrame(animateFocus);
  }, []);

  const startFocusAnimation = useCallback(() => {
    if (animationFrameRef.current === null) {
      lastFrameTimeRef.current = 0;
      animationFrameRef.current = requestAnimationFrame(animateFocus);
    }
  }, [animateFocus]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setIsReducedMotionPreferred(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener("change", handleChange);

    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const motion = motionRef.current;
    const target = {
      offset: pointerOffset ?? motion.offset,
      strength: pointerOffset === null ? 0 : 1,
    };
    targetRef.current = target;

    if (isReducedMotionPreferred) {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      lastFrameTimeRef.current = 0;
      motionRef.current = snapMemoryRulerFocusMotionToTarget({ target });
      setFocus(target);

      return;
    }

    if (pointerOffset !== null && motion.strength < MEMORY_RULER_STRENGTH_SNAP_THRESHOLD) {
      motionRef.current = { ...motion, offset: pointerOffset, offsetVelocity: 0 };
      setFocus({ offset: pointerOffset, strength: motion.strength });
    }

    startFocusAnimation();
  }, [pointerOffset, isReducedMotionPreferred, startFocusAnimation]);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      lastFrameTimeRef.current = 0;
    },
    [],
  );

  return focus;
}

type MemoryRulerEdgePanPointer = {
  offset: number;
  halfHeight: number;
  min: number;
  max: number;
};

type MemoryRulerEdgePanMotion = {
  offset: number;
  velocity: number;
};

function getMemoryRulerEdgeProgress(pointer: MemoryRulerEdgePanPointer) {
  const edgeStart = Math.max(0, pointer.halfHeight - MEMORY_RULER_EDGE_ZONE);

  return Math.min(1, Math.max(0, (Math.abs(pointer.offset) - edgeStart) / MEMORY_RULER_EDGE_ZONE));
}

function advanceMemoryRulerEdgePanWithoutPointer(input: { motion: MemoryRulerEdgePanMotion; deltaTime: number }): {
  motion: MemoryRulerEdgePanMotion;
  shouldContinue: boolean;
} {
  const step = advanceSpring({
    position: input.motion.offset,
    velocity: input.motion.velocity,
    target: 0,
    seconds: input.deltaTime,
    options: {
      stiffness: MEMORY_RULER_EDGE_RETURN_STIFFNESS,
      damping: MEMORY_RULER_EDGE_RETURN_DAMPING,
      positionTolerance: MEMORY_RULER_EDGE_RETURN_POSITION_TOLERANCE,
      velocityTolerance: MEMORY_RULER_EDGE_RETURN_VELOCITY_TOLERANCE,
    },
  });

  return {
    motion: { offset: step.position, velocity: step.velocity },
    shouldContinue: !step.settled,
  };
}

function advanceMemoryRulerEdgePanWithPointer(input: {
  motion: MemoryRulerEdgePanMotion;
  pointer: MemoryRulerEdgePanPointer;
  deltaTime: number;
}): { motion: MemoryRulerEdgePanMotion; shouldContinue: boolean } {
  const { motion, pointer, deltaTime } = input;
  const edgeProgress = getMemoryRulerEdgeProgress(pointer);
  const direction = pointer.offset < 0 ? 1 : -1;
  const targetVelocity = direction * MEMORY_RULER_EDGE_MAX_SPEED * edgeProgress * edgeProgress;
  const velocityBlend = 1 - Math.exp(-MEMORY_RULER_EDGE_VELOCITY_RESPONSE * deltaTime);

  const blendedVelocity = motion.velocity + (targetVelocity - motion.velocity) * velocityBlend;
  const unclampedOffset = motion.offset + blendedVelocity * deltaTime;
  const offset = Math.min(pointer.max, Math.max(pointer.min, unclampedOffset));
  const isPushingPastTop = offset >= pointer.max && blendedVelocity > 0;
  const isPushingPastBottom = offset <= pointer.min && blendedVelocity < 0;
  const velocity = isPushingPastTop || isPushingPastBottom ? 0 : blendedVelocity;

  return {
    motion: { offset, velocity },
    shouldContinue:
      (edgeProgress > MEMORY_RULER_EDGE_PROGRESS_THRESHOLD && !isPushingPastTop && !isPushingPastBottom) ||
      Math.abs(velocity) > MEMORY_RULER_EDGE_VELOCITY_THRESHOLD,
  };
}

function useMemoryRulerEdgePan(isReducedMotionPreferred: boolean) {
  const [offset, setOffset] = useState(0);
  const motionRef = useRef<MemoryRulerEdgePanMotion>({ offset: 0, velocity: 0 });
  const pointerRef = useRef<MemoryRulerEdgePanPointer | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);

  const animatePan = useCallback((timestamp: number) => {
    const motion = motionRef.current;
    const pointer = pointerRef.current;
    const previousTimestamp = lastFrameTimeRef.current !== 0 ? lastFrameTimeRef.current : timestamp;
    const deltaTime = Math.min(
      (timestamp - previousTimestamp) / MEMORY_RULER_MS_PER_SECOND,
      MEMORY_RULER_MAX_FRAME_SECONDS,
    );
    lastFrameTimeRef.current = timestamp;
    const panStep = pointer
      ? advanceMemoryRulerEdgePanWithPointer({ motion, pointer, deltaTime })
      : advanceMemoryRulerEdgePanWithoutPointer({ motion, deltaTime });
    motionRef.current = panStep.motion;
    const shouldContinue = panStep.shouldContinue;

    setOffset(panStep.motion.offset);

    if (!shouldContinue) {
      animationFrameRef.current = null;
      lastFrameTimeRef.current = 0;

      return;
    }

    animationFrameRef.current = requestAnimationFrame(animatePan);
  }, []);

  const startAnimation = useCallback(() => {
    if (animationFrameRef.current === null) {
      lastFrameTimeRef.current = 0;
      animationFrameRef.current = requestAnimationFrame(animatePan);
    }
  }, [animatePan]);

  const updatePointer = useCallback(
    (pointer: MemoryRulerEdgePanPointer) => {
      pointerRef.current = pointer;

      if (isReducedMotionPreferred) {
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        const edgeProgress = getMemoryRulerEdgeProgress(pointer);
        if (edgeProgress > 0) {
          const nextOffset = pointer.offset < 0 ? pointer.max : pointer.min;
          motionRef.current = { offset: nextOffset, velocity: 0 };
          setOffset(nextOffset);
        }

        return;
      }

      startAnimation();
    },
    [isReducedMotionPreferred, startAnimation],
  );

  const release = useCallback(() => {
    pointerRef.current = null;

    if (isReducedMotionPreferred) {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      motionRef.current = { offset: 0, velocity: 0 };
      lastFrameTimeRef.current = 0;
      setOffset(0);

      return;
    }

    startAnimation();
  }, [isReducedMotionPreferred, startAnimation]);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );

  return { offset, updatePointer, release };
}

type WindowedRulerItem = {
  id: string;
  kind: "day" | "moment" | "today";
  day: string;
  index: number;
  offset: number;
  label: string;
  title?: string;
};
export type MemoryRulerHandle = { reset: () => void; resume: () => void };

type MemoryRulerLensDynamics = {
  magnification: number;
  warpedOffset: number;
};

function computeMemoryRulerLensDynamics(input: {
  itemOffset: number;
  center: number;
  panOffset: number;
  focus: MemoryRulerFocus;
}): MemoryRulerLensDynamics {
  const value = input.itemOffset - input.center + input.panOffset;
  const delta = value - input.focus.offset;
  const distance = Math.abs(delta);
  const magnification = Math.max(0, 1 - distance / MEMORY_RULER_MAGNIFICATION_RADIUS) * input.focus.strength;
  const spread = Math.min(distance, MEMORY_RULER_SPREAD_RADIUS);
  const displacement =
    input.focus.strength *
    MEMORY_RULER_SPREAD_STRENGTH *
    (spread - (spread * spread) / (MEMORY_RULER_SPREAD_DIVISOR * MEMORY_RULER_SPREAD_RADIUS));

  return { magnification, warpedOffset: value + Math.sign(delta) * displacement };
}

function collectVisibleMemoryRulerItems(input: {
  items: readonly WindowedRulerItem[];
  indicesById: Map<string, number>;
  focusedId: string | null;
  start: number;
  end: number;
}): WindowedRulerItem[] {
  return windowIndices({
    count: input.items.length,
    start: input.start,
    end: input.end,
    pinned: [input.indicesById.get(input.focusedId ?? "") ?? -1],
  }).flatMap((index) => {
    const item = input.items[index];
    if (item === undefined) {
      throw new Error(MEMORY_RULER_ITEM_MISSING_MESSAGE);
    }

    return [item];
  });
}

function computeMemoryRulerHoveredIndex(input: {
  pointer: number | null;
  moments: WindowedRulerItem[];
  center: number;
  panOffset: number;
  baseOffset: (offset: number) => number;
}): number {
  if (input.pointer === null) {
    return -1;
  }
  const nearest =
    input.moments[
      nearestIndex({
        items: input.moments,
        value: input.pointer + input.center - input.panOffset,
        offset: (item) => item.offset,
      })
    ];
  if (nearest === undefined) {
    return -1;
  }

  return Math.abs(input.baseOffset(nearest.offset) - input.pointer) <= MEMORY_RULER_HOVER_RADIUS ? nearest.index : -1;
}

function isMemoryRulerTodayInView(input: {
  today: WindowedRulerItem | undefined;
  todayWarpedOffset: number;
  halfHeight: number;
}): boolean {
  if (input.today === undefined) {
    return true;
  }

  return (
    input.todayWarpedOffset + MEMORY_RULER_TODAY_VISIBILITY_INSET >=
      -input.halfHeight + MEMORY_RULER_TODAY_VISIBILITY_TOP_OFFSET &&
    input.todayWarpedOffset - MEMORY_RULER_TODAY_VISIBILITY_INSET <= input.halfHeight
  );
}

function useMemoryRulerTrackHeight(track: HTMLDivElement | null) {
  const [height, setHeight] = useState(MEMORY_RULER_DEFAULT_TRACK_HEIGHT);

  useLayoutEffect(() => {
    if (track === null) {
      return;
    }
    const measure = () => {
      if (track.clientHeight !== 0) {
        setHeight(track.clientHeight);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    measure();

    return () => observer.disconnect();
  }, [track]);

  return height;
}

function buildMemoryRulerTickOpacity(input: {
  item: WindowedRulerItem;
  magnification: number;
  isDay: boolean;
  isActive: boolean;
}): number {
  if (input.item.kind === "today") {
    return MEMORY_RULER_TICK_OPACITY_TODAY_BASE + input.magnification * MEMORY_RULER_TICK_OPACITY_TODAY_SCALE;
  }
  if (input.isDay) {
    return MEMORY_RULER_TICK_OPACITY_DAY_BASE + input.magnification * MEMORY_RULER_TICK_OPACITY_DAY_SCALE;
  }
  if (input.isActive) {
    return 1;
  }

  return MEMORY_RULER_TICK_OPACITY_MOMENT_BASE + input.magnification * MEMORY_RULER_TICK_OPACITY_MOMENT_SCALE;
}

function buildMemoryRulerTickStyle(input: {
  item: WindowedRulerItem;
  dynamics: MemoryRulerLensDynamics;
  isDay: boolean;
  isActive: boolean;
}): CSSProperties {
  const { magnification, warpedOffset } = input.dynamics;
  const restingWidth = input.isActive ? MEMORY_RULER_ACTIVE_TICK_WIDTH : MEMORY_RULER_RESTING_TICK_WIDTH;

  return {
    "--ruler-tick-offset": `${warpedOffset}px`,
    "--ruler-tick-opacity": buildMemoryRulerTickOpacity({
      item: input.item,
      magnification,
      isDay: input.isDay,
      isActive: input.isActive,
    }),
    "--ruler-tick-height": `${MEMORY_RULER_RESTING_TICK_HEIGHT + Math.pow(magnification, MEMORY_RULER_MAGNIFICATION_POWER) * (MEMORY_RULER_MAX_TICK_HEIGHT - MEMORY_RULER_RESTING_TICK_HEIGHT)}px`,
    "--ruler-tick-width": input.isDay
      ? "43px"
      : `${restingWidth + magnification * (MEMORY_RULER_MAX_TICK_WIDTH - restingWidth)}px`,
    fontSize: `${input.isDay ? MEMORY_RULER_DAY_FONT_BASE + magnification * MEMORY_RULER_DAY_FONT_SCALE : MEMORY_RULER_MOMENT_FONT_BASE + magnification * MEMORY_RULER_MOMENT_FONT_SCALE}px`,
  };
}

function MemoryRulerTickRow({
  item,
  dynamics,
  position,
  activeDay,
  hoveredIndex,
  todayIndex,
  onNavigate,
  onFocusId,
  onBlurId,
}: {
  item: WindowedRulerItem;
  dynamics: MemoryRulerLensDynamics;
  position: number;
  activeDay: string | undefined;
  hoveredIndex: number;
  todayIndex: number;
  onNavigate: (index: number) => void;
  onFocusId: (id: string) => void;
  onBlurId: () => void;
}) {
  const isDay = item.kind !== "moment";
  const isActive = item.kind === "moment" ? item.index === Math.round(position) : item.day === activeDay;
  const style = buildMemoryRulerTickStyle({ item, dynamics, isDay, isActive });

  if (item.kind === "today") {
    return (
      <button
        key={item.id}
        type="button"
        className="memory-ruler-day memory-ruler-today-row"
        style={style}
        aria-label="Go to Today"
        onClick={() => onNavigate(todayIndex)}
      >
        <span>{item.label}</span>
        <i aria-hidden="true" />
      </button>
    );
  }

  const titleSuffix = item.title !== undefined && item.title !== "" ? `: ${item.title}` : "";

  return (
    <button
      key={item.id}
      type="button"
      style={style}
      onFocus={() => onFocusId(item.id)}
      onBlur={onBlurId}
      className={`${isDay ? "memory-ruler-day" : "memory-ruler-moment"}${isActive ? " is-active" : ""}${!isDay && item.index === hoveredIndex ? " is-hovered" : ""}`}
      onClick={() => onNavigate(item.index)}
      aria-label={`Go to ${item.label}${titleSuffix}`}
      aria-current={isActive ? "date" : undefined}
    >
      <span>{item.label}</span>
      <i aria-hidden="true" />
    </button>
  );
}

function MemoryRulerFloatingTodayButton({
  todayIndex,
  onNavigate,
  onDismissPointer,
}: {
  todayIndex: number;
  onNavigate: (index: number) => void;
  onDismissPointer: () => void;
}) {
  return (
    <button
      type="button"
      className="memory-toolbar-pill memory-today-button"
      aria-label="Today — go to latest memory"
      onClick={() => {
        onDismissPointer();
        onNavigate(todayIndex);
      }}
    >
      Today
    </button>
  );
}

function handleMemoryRulerPointerMove(input: {
  event: ReactPointerEvent<HTMLDivElement>;
  items: readonly WindowedRulerItem[];
  center: number;
  onPointerOffset: (offset: number) => void;
  onClearDismissed: () => void;
  updatePointer: (pointer: MemoryRulerEdgePanPointer) => void;
}) {
  const bounds = input.event.currentTarget.getBoundingClientRect();
  const offset = input.event.clientY - bounds.top - bounds.height / MEMORY_RULER_HALF_DIVISOR;
  const limit = Math.max(0, bounds.height / MEMORY_RULER_HALF_DIVISOR - MEMORY_RULER_EDGE_CONTENT_INSET);
  input.onPointerOffset(offset);
  input.onClearDismissed();
  input.updatePointer({
    offset,
    halfHeight: bounds.height / MEMORY_RULER_HALF_DIVISOR,
    min: Math.min(0, limit - ((input.items.at(-1)?.offset ?? input.center) - input.center)),
    max: Math.max(0, -limit - ((input.items[0]?.offset ?? input.center) - input.center)),
  });
}

function handleMemoryRulerTrackClick(input: {
  event: ReactMouseEvent<HTMLDivElement>;
  items: readonly WindowedRulerItem[];
  todayIndex: number;
  warpedOffsetAt: (offset: number) => number;
  onNavigate: (index: number) => void;
}) {
  if (input.event.target !== input.event.currentTarget || input.items.length === 0) {
    return;
  }
  const bounds = input.event.currentTarget.getBoundingClientRect();
  const offset = input.event.clientY - bounds.top - bounds.height / MEMORY_RULER_HALF_DIVISOR;
  const item =
    input.items[
      nearestIndex({
        items: input.items,
        value: offset,
        offset: (rulerItem) => input.warpedOffsetAt(rulerItem.offset),
      })
    ];
  if (item !== undefined) {
    input.onNavigate(item.kind === "today" ? input.todayIndex : item.index);
  }
}

function useWindowedMemoryRulerViewport(input: {
  items: readonly WindowedRulerItem[];
  position: number;
  trackHeight: number;
  pointer: number | null;
  focusedId: string | null;
  focus: MemoryRulerFocus;
  panOffset: number;
}) {
  const { indicesById, byIndex, today, moments } = useMemo(() => getRulerItemIndex(input.items), [input.items]);
  const lower = byIndex.get(Math.floor(input.position))?.offset ?? 0;
  const upper = byIndex.get(Math.ceil(input.position))?.offset ?? lower;
  const center = lower + (upper - lower) * (input.position - Math.floor(input.position));
  const active = byIndex.get(Math.round(input.position));
  const baseOffset = (offset: number) => offset - center + input.panOffset;
  const lensDynamicsAt = (itemOffset: number) =>
    computeMemoryRulerLensDynamics({
      itemOffset,
      center,
      panOffset: input.panOffset,
      focus: input.focus,
    });
  const half = input.trackHeight / MEMORY_RULER_HALF_DIVISOR;
  const overscan = MEMORY_RULER_OVERSCAN_BASE + MEMORY_RULER_SPREAD_RADIUS * MEMORY_RULER_SPREAD_STRENGTH;
  const start = lowerBound({
    items: input.items,
    value: center - input.panOffset - half - overscan,
    offset: (item) => item.offset,
  });
  const end = lowerBound({
    items: input.items,
    value: center - input.panOffset + half + overscan,
    offset: (item) => item.offset,
  });
  const visible = collectVisibleMemoryRulerItems({
    items: input.items,
    indicesById,
    focusedId: input.focusedId,
    start,
    end,
  });
  const hoveredIndex = computeMemoryRulerHoveredIndex({
    pointer: input.pointer,
    moments,
    center,
    panOffset: input.panOffset,
    baseOffset,
  });
  const todayWarpedOffset = today !== undefined ? lensDynamicsAt(today.offset).warpedOffset : 0;
  const isTodayVisible = isMemoryRulerTodayInView({ today, todayWarpedOffset, halfHeight: half });

  return { active, visible, hoveredIndex, lensDynamicsAt, center, isTodayVisible };
}

function useWindowedMemoryRulerController(input: {
  ref?: Ref<MemoryRulerHandle>;
  items: readonly WindowedRulerItem[];
  selectedPosition: number;
  travelStore: MemoryTravelStore;
  onNavigate: (index: number) => void;
  isReducedMotionPreferred: boolean;
  todayIndex: number;
  shouldShowTodayControl: boolean;
  isInteractionDisabled: boolean;
}) {
  const travelPosition = useSyncExternalStore(
    input.travelStore.subscribe,
    input.travelStore.getSnapshot,
    input.travelStore.getSnapshot,
  );
  const position = travelPosition ?? input.selectedPosition;
  const [track, setTrack] = useState<HTMLDivElement | null>(null);
  const height = useMemoryRulerTrackHeight(track);
  const [pointer, setPointer] = useState<number | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focus = useMemoryRulerFocus(pointer);
  const pan = useMemoryRulerEdgePan(input.isReducedMotionPreferred);
  const viewport = useWindowedMemoryRulerViewport({
    items: input.items,
    position,
    trackHeight: height,
    pointer,
    focusedId,
    focus,
    panOffset: pan.offset,
  });
  const { active, visible, hoveredIndex, lensDynamicsAt, center, isTodayVisible } = viewport;

  useEffect(() => {
    if (isTodayVisible) {
      setIsDismissed(false);
    }
  }, [isTodayVisible]);
  useImperativeHandle(input.ref, () => ({
    reset: () => {
      setPointer(null);
      pan.release();
      setIsDismissed(false);
    },
    resume: () => setIsDismissed(false),
  }));
  const clearDismissed = useCallback(() => setIsDismissed(false), []);
  const dismissTodayPill = useCallback(() => {
    setPointer(null);
    pan.release();
    setIsDismissed(true);
  }, [pan]);
  const move = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      handleMemoryRulerPointerMove({
        event,
        items: input.items,
        center,
        onPointerOffset: setPointer,
        onClearDismissed: clearDismissed,
        updatePointer: pan.updatePointer,
      });
    },
    [input.items, center, clearDismissed, pan.updatePointer],
  );
  const click = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      handleMemoryRulerTrackClick({
        event,
        items: input.items,
        todayIndex: input.todayIndex,
        warpedOffsetAt: (offset) => lensDynamicsAt(offset).warpedOffset,
        onNavigate: input.onNavigate,
      });
    },
    [input.items, input.todayIndex, input.onNavigate, focus, pan.offset, center],
  );
  const shouldShowTodayPill =
    input.shouldShowTodayControl && !input.isInteractionDisabled && !isTodayVisible && !isDismissed;

  return {
    setTrack,
    position,
    active,
    visible,
    hoveredIndex,
    lensDynamicsAt,
    move,
    click,
    clearDismissed,
    dismissTodayPill,
    shouldShowTodayPill,
    setPointer,
    setFocusedId,
    pan,
    todayIndex: input.todayIndex,
    onNavigate: input.onNavigate,
  };
}

// Frame-by-frame pointer motion only rerenders this small, windowed subtree.
export const WindowedMemoryRuler = memo(function WindowedMemoryRuler({
  ref,
  items,
  position: selectedPosition,
  travelStore,
  onNavigate,
  /** @external memory ruler wire */
  prefersReducedMotion,
  label,
  /** @external memory ruler wire */
  disabled,
  todayIndex = 0,
  /** @external memory ruler wire */
  showTodayButton,
}: {
  ref?: Ref<MemoryRulerHandle>;
  travelStore: MemoryTravelStore;
  items: readonly WindowedRulerItem[];
  position: number;
  onNavigate: (index: number) => void;
  /** @external memory ruler wire */
  prefersReducedMotion: boolean;
  label: string;
  /** @external memory ruler wire */
  disabled: boolean;
  todayIndex?: number;
  /** @external memory ruler wire */
  showTodayButton?: boolean;
}) {
  const ruler = useWindowedMemoryRulerController({
    ref,
    items,
    selectedPosition,
    travelStore,
    onNavigate,
    isReducedMotionPreferred: prefersReducedMotion,
    todayIndex,
    shouldShowTodayControl: showTodayButton ?? false,
    isInteractionDisabled: disabled,
  });

  return (
    <aside className="memory-ruler" aria-label={label} inert={disabled} onWheelCapture={ruler.clearDismissed}>
      <div
        ref={ruler.setTrack}
        className="memory-ruler-track"
        onClick={ruler.click}
        onPointerEnter={ruler.move}
        onPointerMove={ruler.move}
        onPointerLeave={() => {
          ruler.setPointer(null);
          ruler.pan.release();
        }}
      >
        <div className="memory-ruler-rows">
          {ruler.visible.map((item) => (
            <MemoryRulerTickRow
              key={item.id}
              item={item}
              dynamics={ruler.lensDynamicsAt(item.offset)}
              position={ruler.position}
              activeDay={ruler.active?.day}
              hoveredIndex={ruler.hoveredIndex}
              todayIndex={ruler.todayIndex}
              onNavigate={ruler.onNavigate}
              onFocusId={ruler.setFocusedId}
              onBlurId={() => ruler.setFocusedId(null)}
            />
          ))}
        </div>
      </div>
      {ruler.shouldShowTodayPill ? (
        <MemoryRulerFloatingTodayButton
          todayIndex={ruler.todayIndex}
          onNavigate={ruler.onNavigate}
          onDismissPointer={ruler.dismissTodayPill}
        />
      ) : null}
    </aside>
  );
});

function indexRulerItems(items: readonly WindowedRulerItem[]) {
  const indicesById = new Map<string, number>();
  const byIndex = new Map<number, WindowedRulerItem>();
  const today = items.reduce<WindowedRulerItem | undefined>((current, item, index) => {
    indicesById.set(item.id, index);
    if (item.kind === "moment") {
      byIndex.set(item.index, item);
    }
    if (item.kind === "today" || (item.kind === "day" && item.day === localDay(new Date()))) {
      return item;
    }

    return current;
  }, undefined);

  return { indicesById, byIndex, today, moments: items.filter((item) => item.kind === "moment") };
}
const rulerItemIndexes = new WeakMap<readonly WindowedRulerItem[], ReturnType<typeof indexRulerItems>>();
function getRulerItemIndex(items: readonly WindowedRulerItem[]) {
  const cached = rulerItemIndexes.get(items);
  if (cached) {
    return cached;
  }
  const index = indexRulerItems(items);
  rulerItemIndexes.set(items, index);

  return index;
}

type RulerMemory = Pick<RelationshipMemory, "id" | "title" | "occurredAt" | "evidenceOccurredAt">;

export function buildMemoryRulerItems(memories: readonly RulerMemory[]): WindowedRulerItem[] {
  const groups = memories.reduce((grouped, memory, index) => {
    const day = localDay(new Date(memory.occurredAt));
    const existing = grouped.get(day) ?? [];
    const nextGrouped = new Map(grouped);
    nextGrouped.set(day, [...existing, { memory, index }]);

    return nextGrouped;
  }, new Map<string, { memory: RulerMemory; index: number }[]>());
  const built = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce<{ items: WindowedRulerItem[]; offset: number }>(
      (state, [day, entries], dayIndex) => {
        const first = entries[0];
        if (!first) {
          throw new Error(MEMORY_RULER_DAY_MISSING_MESSAGE);
        }
        const dayOffset = state.offset + (dayIndex === 0 ? 0 : MEMORY_RULER_DAY_SECTION_GAP);
        const dayItem: WindowedRulerItem = {
          id: `day-${day}`,
          kind: "day",
          day,
          index: first.index,
          offset: dayOffset,
          label: memoryDay(first.memory.occurredAt),
        };
        const moments = [...entries]
          // Reverse the list order, including ties from the same meeting.
          // The bottommost memory tick must always address the top list row.
          .sort((a, b) => b.index - a.index)
          .reduce<{ items: WindowedRulerItem[]; offset: number }>(
            (momentState, { memory, index }, momentIndex) => {
              const momentOffset = momentState.offset + (momentIndex === 0 ? 0 : MEMORY_RULER_MOMENT_GAP);
              const displayTime = memory.evidenceOccurredAt ?? memory.occurredAt;
              const time = new Date(displayTime).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              });

              return {
                offset: momentOffset,
                items: [
                  ...momentState.items,
                  {
                    id: memory.id,
                    kind: "moment",
                    day,
                    index,
                    offset: momentOffset,
                    label: `${memoryDay(displayTime)} · ${time}`,
                    title: memory.title,
                  },
                ],
              };
            },
            { items: [], offset: dayOffset + MEMORY_RULER_DAY_TO_MOMENT_GAP },
          );

        return { offset: moments.offset, items: [...state.items, dayItem, ...moments.items] };
      },
      { items: [], offset: 0 },
    );
  const today = localDay(new Date());
  const todayItem: WindowedRulerItem = {
    id: `today-${today}`,
    kind: "today",
    day: today,
    index: -1,
    offset: built.offset + (built.items.length !== 0 ? MEMORY_RULER_DAY_SECTION_GAP : 0),
    label: "Today",
  };
  const items = groups.has(today) ? built.items : [...built.items, todayItem];
  const center = ((items[0]?.offset ?? 0) + (items.at(-1)?.offset ?? 0)) / MEMORY_RULER_CENTER_DIVISOR;

  return items.map((item) => ({ ...item, offset: item.offset - center }));
}
