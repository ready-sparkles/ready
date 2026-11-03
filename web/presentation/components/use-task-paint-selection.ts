import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface Point {
  x: number;
  y: number;
}

export interface TaskPaintSelectionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PaintGesture {
  pointerId: number;
  pointerType: string;
  origin: Point;
  start: Point;
  current: Point;
  base: Set<string>;
  isAdditive: boolean;
  isDragging: boolean;
  isStartedOnRow: boolean;
  rows: { id: string; box: TaskPaintSelectionBox }[];
  scroll: HTMLElement;
  isUsingDocumentScroll: boolean;
}

interface TaskPaintSelectionBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const TASK_PAINT_MOUSE_ACTIVATION_DISTANCE_PX = 6;
const TASK_PAINT_POINTER_ACTIVATION_DISTANCE_PX = 10;
const TASK_PAINT_FRAME_DELTA_CAP_MS = 32;
const TASK_PAINT_SCROLL_SPEED_FACTOR = 0.65;
const TASK_PAINT_AUTOSCROLL_EDGE_PX = 48;
const TASK_ROW_MISSING_DATA_TASK_ID_MESSAGE = "Task row is missing data-task-id.";
const TASK_PAINT_IGNORE_TARGET_SELECTOR =
  'input, textarea, select, a, [contenteditable="true"], [role="dialog"], [role="menu"], .workspace-task-section-row, .workspace-task-page-header, .workspace-task-period-header';

function getDocumentScrollElement(): HTMLElement {
  const scrollingElement = document.scrollingElement;
  if (scrollingElement instanceof HTMLElement) {
    return scrollingElement;
  }

  return document.documentElement;
}

export function taskPaintStartBounds(
  ...[rootBounds, contentBounds]: [TaskPaintSelectionBounds, TaskPaintSelectionBounds]
): TaskPaintSelectionBounds {
  return {
    left: contentBounds.left,
    right: contentBounds.right,
    top: rootBounds.top,
    bottom: rootBounds.bottom,
  };
}

export function isPointWithinTaskPaintSelectionBounds(...[point, bounds]: [Point, TaskPaintSelectionBounds]): boolean {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

export function canStartTaskPaintPointer({
  pointerType,
  button,
  isPrimary,
}: {
  pointerType: string;
  button: number;
  isPrimary: boolean;
}): boolean {
  return isPrimary && button === 0 && (pointerType === "mouse" || pointerType === "touch" || pointerType === "pen");
}

export function taskPaintActivationDistance(pointerType: string): number {
  return pointerType === "mouse" ? TASK_PAINT_MOUSE_ACTIVATION_DISTANCE_PX : TASK_PAINT_POINTER_ACTIVATION_DISTANCE_PX;
}

type TaskPaintGestureIntent = "pending" | "paint" | "pan";

export function taskPaintGestureIntent(
  ...[pointerType, deltaX, deltaY]: [string, number, number]
): TaskPaintGestureIntent {
  if (Math.hypot(deltaX, deltaY) < taskPaintActivationDistance(pointerType)) {
    return "pending";
  }
  if (pointerType === "touch" && Math.abs(deltaY) >= Math.abs(deltaX)) {
    return "pan";
  }

  return "paint";
}

export function shouldSuppressClickAfterTaskPaint(...[isDragging, isCancelled]: [boolean, boolean]): boolean {
  return isDragging && !isCancelled;
}

function isIgnoredTaskPaintTarget(target: Element): boolean {
  if (target.closest(TASK_PAINT_IGNORE_TARGET_SELECTOR)) {
    return true;
  }
  const button = target.closest("button");

  return button !== null && !button.classList.contains("workspace-task-title-button");
}

function shouldSkipTaskPaintRowSelection(input: {
  row: HTMLElement | null;
  selectedIds: Set<string>;
  event: PointerEvent;
}): boolean {
  const rowTaskId = input.row?.dataset.taskId;

  return rowTaskId !== undefined && input.selectedIds.has(rowTaskId) && !input.event.metaKey && !input.event.ctrlKey;
}

function collectTaskPaintRows(input: {
  root: HTMLElement;
  bounds: DOMRect;
}): { id: string; box: TaskPaintSelectionBox }[] {
  return Array.from(input.root.querySelectorAll<HTMLElement>("[data-task-id]")).map((element) => {
    const id = element.dataset.taskId;
    if (id === undefined) {
      throw new Error(TASK_ROW_MISSING_DATA_TASK_ID_MESSAGE);
    }
    const rect = element.getBoundingClientRect();

    return {
      id,
      box: {
        left: rect.left - input.bounds.left,
        top: rect.top - input.bounds.top,
        width: rect.width,
        height: rect.height,
      },
    };
  });
}

function computePaintSelectedIds(input: { gesture: PaintGesture; box: TaskPaintSelectionBox }): Set<string> {
  const { gesture, box } = input;
  const left = box.left;
  const top = box.top;
  const right = box.left + box.width;
  const bottom = box.top + box.height;

  return gesture.rows.reduce(
    (selected, { id, box: row }) => {
      const isIntersecting =
        row.left <= right && row.left + row.width >= left && row.top <= bottom && row.top + row.height >= top;
      if (!isIntersecting) {
        return selected;
      }
      if (gesture.isAdditive && gesture.base.has(id)) {
        return new Set([...selected].filter((selectedId) => selectedId !== id));
      }

      return new Set([...selected, id]);
    },
    gesture.isAdditive ? new Set(gesture.base) : new Set<string>(),
  );
}

function localPointFromRoot(input: { root: HTMLElement; point: Point }): Point {
  const bounds = input.root.getBoundingClientRect();

  return { x: input.point.x - bounds.left, y: input.point.y - bounds.top };
}

function applyPaintSelectionUpdate(input: {
  root: HTMLElement;
  gesture: PaintGesture;
  selectRef: RefObject<(ids: Set<string>) => void>;
  setBox: (box: TaskPaintSelectionBox | null) => void;
}): void {
  const { gesture, root, selectRef, setBox } = input;
  if (!gesture.isDragging) {
    return;
  }
  const end = localPointFromRoot({ root, point: gesture.current });
  const left = Math.min(gesture.start.x, end.x);
  const top = Math.min(gesture.start.y, end.y);
  const right = Math.max(gesture.start.x, end.x);
  const bottom = Math.max(gesture.start.y, end.y);
  const box = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  selectRef.current(computePaintSelectedIds({ gesture, box }));
  setBox(box);
}

interface PaintFrameState {
  id: number;
  previous: number;
}

function finishTaskPaintGesture(input: {
  root: HTMLDivElement;
  isCancelled: boolean;
  gestureRef: RefObject<PaintGesture | null>;
  paintFrame: PaintFrameState;
  suppressClickRef: RefObject<boolean>;
  selectRef: RefObject<(ids: Set<string>) => void>;
  setBox: (box: TaskPaintSelectionBox | null) => void;
}): void {
  const { root, isCancelled, gestureRef, paintFrame, suppressClickRef, selectRef, setBox } = input;
  const gesture = gestureRef.current;
  if (!gesture) {
    return;
  }
  gestureRef.current = null;
  cancelAnimationFrame(paintFrame.id);
  paintFrame.previous = 0;
  suppressClickRef.current = shouldSuppressClickAfterTaskPaint(gesture.isDragging, isCancelled);
  if (gesture.isDragging) {
    if (isCancelled) {
      selectRef.current(gesture.base);
    }
  } else if (!isCancelled && !gesture.isStartedOnRow && !gesture.isAdditive) {
    selectRef.current(new Set());
  }
  if (root.hasPointerCapture(gesture.pointerId)) {
    root.releasePointerCapture(gesture.pointerId);
  }
  setBox(null);
}

function createTaskPaintAutoscrollTick(input: {
  gestureRef: RefObject<PaintGesture | null>;
  paintFrame: PaintFrameState;
  update: () => void;
}): (now: number) => void {
  const { gestureRef, paintFrame, update } = input;
  const tick = (now: number) => {
    const gesture = gestureRef.current;
    if (!gesture || !gesture.isDragging) {
      return;
    }
    const previousTimestamp = paintFrame.previous === 0 ? now : paintFrame.previous;
    const elapsed = Math.min(TASK_PAINT_FRAME_DELTA_CAP_MS, now - previousTimestamp);
    paintFrame.previous = now;
    const bounds = gesture.isUsingDocumentScroll
      ? { top: 0, bottom: window.innerHeight }
      : gesture.scroll.getBoundingClientRect();
    const y = gesture.current.y;
    const speed =
      y < bounds.top + TASK_PAINT_AUTOSCROLL_EDGE_PX
        ? -Math.min(1, (bounds.top + TASK_PAINT_AUTOSCROLL_EDGE_PX - y) / TASK_PAINT_AUTOSCROLL_EDGE_PX)
        : y > bounds.bottom - TASK_PAINT_AUTOSCROLL_EDGE_PX
          ? Math.min(1, (y - bounds.bottom + TASK_PAINT_AUTOSCROLL_EDGE_PX) / TASK_PAINT_AUTOSCROLL_EDGE_PX)
          : 0;
    const previousScrollTop = gesture.scroll.scrollTop;
    gesture.scroll.scrollTop += speed * elapsed * TASK_PAINT_SCROLL_SPEED_FACTOR;
    if (previousScrollTop !== gesture.scroll.scrollTop) {
      update();
    }
    paintFrame.id = requestAnimationFrame(tick);
  };

  return tick;
}

function createTaskPaintMoveHandler(input: {
  root: HTMLDivElement;
  gestureRef: RefObject<PaintGesture | null>;
  paintFrame: PaintFrameState;
  update: () => void;
  finish: (isCancelled: boolean) => void;
  tick: (now: number) => void;
}): (event: PointerEvent) => void {
  const { root, gestureRef, paintFrame, update, finish, tick } = input;

  return (event: PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    gesture.current = { x: event.clientX, y: event.clientY };
    if (!gesture.isDragging) {
      const intent = taskPaintGestureIntent(
        gesture.pointerType,
        event.clientX - gesture.origin.x,
        event.clientY - gesture.origin.y,
      );
      if (intent === "pending") {
        return;
      }
      if (intent === "pan") {
        finish(true);

        return;
      }
      gesture.isDragging = true;
      root.setPointerCapture(event.pointerId);
      root.focus({ preventScroll: true });
      paintFrame.id = requestAnimationFrame(tick);
    }
    event.preventDefault();
    update();
  };
}

function bindTaskPaintSelectionListeners(input: {
  root: HTMLDivElement;
  scroll: HTMLElement;
  move: (event: PointerEvent) => void;
  up: (event: PointerEvent) => void;
  cancel: () => void;
  escape: (event: KeyboardEvent) => void;
  pointerDown: (event: PointerEvent) => void;
  click: (event: MouseEvent) => void;
  update: () => void;
  finish: (isCancelled: boolean) => void;
}): () => void {
  const { root, scroll, move, up, cancel, escape, pointerDown, click, update, finish } = input;

  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", escape, true);
  root.addEventListener("lostpointercapture", cancel);
  scroll.addEventListener("pointerdown", pointerDown, true);
  scroll.addEventListener("click", click, true);
  window.addEventListener("scroll", update, { passive: true });

  return () => {
    finish(true);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", escape, true);
    root.removeEventListener("lostpointercapture", cancel);
    scroll.removeEventListener("pointerdown", pointerDown, true);
    scroll.removeEventListener("click", click, true);
    window.removeEventListener("scroll", update);
  };
}

function installTaskPaintSelectionEffect(input: {
  root: HTMLDivElement;
  gestureRef: RefObject<PaintGesture | null>;
  suppressClickRef: RefObject<boolean>;
  selectRef: RefObject<(ids: Set<string>) => void>;
  setBox: (box: TaskPaintSelectionBox | null) => void;
  onDocumentPointerDown: (event: PointerEvent) => void;
}): () => void {
  const { root, gestureRef, suppressClickRef, selectRef, setBox, onDocumentPointerDown } = input;
  const paintFrame: PaintFrameState = { id: 0, previous: 0 };
  const update = () => {
    const gesture = gestureRef.current;
    if (!gesture || !gesture.isDragging) {
      return;
    }
    applyPaintSelectionUpdate({ root, gesture, selectRef, setBox });
  };
  const finish = (isCancelled: boolean) => {
    finishTaskPaintGesture({
      root,
      isCancelled,
      gestureRef,
      paintFrame,
      suppressClickRef,
      selectRef,
      setBox,
    });
  };
  const tick = createTaskPaintAutoscrollTick({ gestureRef, paintFrame, update });
  const move = createTaskPaintMoveHandler({ root, gestureRef, paintFrame, update, finish, tick });
  const up = (event: PointerEvent) => {
    if (gestureRef.current?.pointerId !== event.pointerId) {
      return;
    }
    if (gestureRef.current.isDragging) {
      gestureRef.current.current = { x: event.clientX, y: event.clientY };
      update();
    }
    finish(false);
  };
  const cancel = () => finish(true);
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && gestureRef.current) {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
    }
  };
  const click = (event: MouseEvent) => {
    if (!suppressClickRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };
  const scroll = getDocumentScrollElement();

  return bindTaskPaintSelectionListeners({
    root,
    scroll,
    move,
    up,
    cancel,
    escape,
    pointerDown: onDocumentPointerDown,
    click,
    update,
    finish,
  });
}

function runTaskPaintPointerDown(input: {
  event: PointerEvent;
  root: HTMLDivElement;
  selectedIds: Set<string>;
  isDisabled: boolean;
  gestureRef: RefObject<PaintGesture | null>;
  suppressClickRef: RefObject<boolean>;
}): void {
  const { event, root, selectedIds, isDisabled, gestureRef, suppressClickRef } = input;
  suppressClickRef.current = false;
  if (
    isDisabled ||
    !canStartTaskPaintPointer({
      pointerType: event.pointerType,
      button: event.button,
      isPrimary: event.isPrimary,
    })
  ) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (isIgnoredTaskPaintTarget(target)) {
    return;
  }
  const row = target.closest<HTMLElement>("[data-task-id]");
  if (shouldSkipTaskPaintRowSelection({ row, selectedIds, event })) {
    return;
  }
  const scroll = getDocumentScrollElement();
  const bounds = root.getBoundingClientRect();
  const contentBounds = root.closest<HTMLElement>(".workspace-content-tasks")?.getBoundingClientRect() ?? bounds;
  const startBounds = taskPaintStartBounds(bounds, contentBounds);
  const origin = { x: event.clientX, y: event.clientY };
  if (!isPointWithinTaskPaintSelectionBounds(origin, startBounds)) {
    return;
  }
  gestureRef.current = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    origin,
    current: origin,
    start: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    base: new Set(selectedIds),
    isAdditive: event.metaKey || event.ctrlKey,
    isDragging: false,
    isStartedOnRow: Boolean(row),
    scroll,
    isUsingDocumentScroll: true,
    rows: collectTaskPaintRows({ root, bounds }),
  };
  event.stopPropagation();
  if (event.pointerType !== "touch") {
    event.preventDefault();
  }
}

// Drag through unselected rows to paint a selection. Selected rows retain
// their existing drag-and-drop behavior unless a modifier key is held.
export function useTaskPaintSelection({
  rootRef,
  selectedIds,
  onSelect,
  /** @external task paint disabled option */
  disabled,
  resetKey,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  /** @external task paint disabled option */
  disabled: boolean;
  resetKey: string;
}): { box: TaskPaintSelectionBox | null } {
  const [box, setBox] = useState<TaskPaintSelectionBox | null>(null);
  const gestureRef = useRef<PaintGesture | null>(null);
  const suppressClickRef = useRef(false);
  const pointerStartRef = useRef<(event: PointerEvent) => void>(() => {});
  const selectRef = useRef(onSelect);
  useLayoutEffect(() => {
    selectRef.current = onSelect;
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    return installTaskPaintSelectionEffect({
      root,
      gestureRef,
      suppressClickRef,
      selectRef,
      setBox,
      onDocumentPointerDown: (event) => pointerStartRef.current(event),
    });
  }, [disabled, resetKey, rootRef]);

  useLayoutEffect(() => {
    pointerStartRef.current = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      runTaskPaintPointerDown({
        event,
        root,
        selectedIds,
        isDisabled: disabled,
        gestureRef,
        suppressClickRef,
      });
    };
  });

  return { box };
}
