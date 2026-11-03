"use client";
import type { RelationshipMemory } from "@readymeet/shared";
import {
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  type SetStateAction,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { CategoryBadge, memoryDay, MemoryIcon, MemoryTimelineArrow } from "../memory-browser-controls";

import {
  createListGeometry,
  DEFAULT_EXPANDED_MEMORY_ROW_HEIGHT,
  getMemoryDayGroups,
  lowerBound,
  MEMORY_DAY_HEADER_HEIGHT,
  windowIndices,
} from "./windowing";

const MEMORY_VIRTUAL_LIST_DEFAULT_VIEWPORT_HEIGHT = 800;
const MEMORY_VIRTUAL_LIST_INITIAL_ROW_HEIGHT = 39.52;
const MEMORY_VIRTUAL_LIST_VIEWPORT_OVERSCAN_ABOVE = 2;
const MEMORY_VIRTUAL_LIST_VIEWPORT_OVERSCAN_BELOW = 3;
const MEMORY_VIRTUAL_LIST_NEAREST_INDEX_SLOT_BEFORE = 1;
const MEMORY_VIRTUAL_LIST_NEAREST_INDEX_SLOT_AFTER = 2;
const MEMORY_VIRTUAL_LIST_WINDOW_SLOT_MISSING_MESSAGE = "Memory window slot is missing";
const MEMORY_VIRTUAL_LIST_ROW_MISSING_MESSAGE = "Memory row is missing";

type MemoryVirtualListSizes = {
  row: number;
  header: number;
  expanded: number;
  expandedId: string;
};

type MemoryVirtualListGeometry = ReturnType<typeof createListGeometry>;

type MemoryVirtualListScrollToIndex = {
  /** @external memory virtual list handle contract */
  (...args: [index: number, behavior: ScrollBehavior]): void;
};

export type MemoryVirtualListHandle = {
  scrollToIndex: MemoryVirtualListScrollToIndex;
  nearestIndex: () => number;
};

function memoryVirtualListSizesEqual(input: {
  next: MemoryVirtualListSizes;
  previous: MemoryVirtualListSizes;
}): boolean {
  return (
    input.next.row === input.previous.row &&
    input.next.header === input.previous.header &&
    input.next.expanded === input.previous.expanded &&
    input.next.expandedId === input.previous.expandedId
  );
}

function parseMarginPixels(value: string): number {
  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveMemoryWindowIndices(input: {
  geometry: MemoryVirtualListGeometry;
  visible: readonly number[];
  viewport: { top: number; height: number };
  expandedIndex: number;
  focusedIndex: number;
}): number[] {
  const start = input.geometry.indexAt(
    input.viewport.top - input.viewport.height * MEMORY_VIRTUAL_LIST_VIEWPORT_OVERSCAN_ABOVE,
  );
  const end =
    input.geometry.indexAt(input.viewport.top + input.viewport.height * MEMORY_VIRTUAL_LIST_VIEWPORT_OVERSCAN_BELOW) +
    1;
  const pinned = [input.expandedIndex, input.focusedIndex]
    .filter((index) => index >= 0)
    .map((index) => lowerBound({ items: input.visible, value: index, offset: (item) => item }));

  return windowIndices({
    count: input.visible.length,
    start: lowerBound({ items: input.visible, value: start, offset: (item) => item }),
    end: lowerBound({ items: input.visible, value: end, offset: (item) => item }),
    pinned,
  }).flatMap((slot) => {
    const index = input.visible[slot];
    if (index === undefined) {
      throw new Error(MEMORY_VIRTUAL_LIST_WINDOW_SLOT_MISSING_MESSAGE);
    }

    return [index];
  });
}

function computeMemoryVirtualListTrailingSpace(input: {
  geometry: MemoryVirtualListGeometry;
  visible: readonly number[];
  viewport: { height: number; anchorInset: number };
}): number {
  const lastIndex = input.visible.at(-1);
  if (lastIndex === undefined) {
    return 0;
  }
  const lastRowHeight = input.geometry.height(lastIndex) - input.geometry.headerHeight(lastIndex);

  return Math.max(0, input.viewport.height - input.viewport.anchorInset - lastRowHeight);
}

function scrollMemoryVirtualListToIndex(input: {
  index: number;
  behavior: ScrollBehavior;
  scroller: () => HTMLElement | null | undefined;
  root: RefObject<HTMLDivElement | null>;
  days: readonly string[];
  memories: readonly RelationshipMemory[];
  collapsed: ReadonlySet<string>;
  setCollapsed: (value: ReadonlySet<string>) => void;
  expandedIndex: number;
  expandedId?: string;
  sizes: MemoryVirtualListSizes;
  dayStarts: readonly number[];
  geometry: MemoryVirtualListGeometry;
  anchor: (element: HTMLElement) => number;
  measureViewport: () => void;
}) {
  const element = input.scroller();
  const day = input.days[input.index];
  const memory = input.memories[input.index];
  if (
    element === null ||
    element === undefined ||
    input.root.current === null ||
    memory === undefined ||
    day === undefined
  ) {
    return;
  }
  const isDayExpanding = input.collapsed.has(day);
  const nextCollapsed = new Set(input.collapsed);
  if (isDayExpanding) {
    nextCollapsed.delete(day);
  }
  const nextGeometry = isDayExpanding
    ? createListGeometry({
        count: input.memories.length,
        expandedIndex: input.expandedIndex,
        expandedHeight:
          input.sizes.expandedId === input.expandedId ? input.sizes.expanded : DEFAULT_EXPANDED_MEMORY_ROW_HEIGHT,
        dayStarts: input.dayStarts,
        collapsedIndices: new Set(
          input.days.flatMap((value, rowIndex) => (nextCollapsed.has(value) ? [rowIndex] : [])),
        ),
        rowHeight: input.sizes.row,
        dayHeaderHeight: input.sizes.header,
      })
    : input.geometry;
  if (isDayExpanding) {
    flushSync(() => input.setCollapsed(nextCollapsed));
  }
  const rootElement = input.root.current;
  const top =
    input.index === 0
      ? 0
      : element.scrollTop +
        rootElement.getBoundingClientRect().top +
        nextGeometry.offset(input.index) +
        nextGeometry.headerHeight(input.index) -
        input.anchor(element);
  element.scrollTo({ top, behavior: input.behavior });
  if (input.behavior === "instant") {
    flushSync(input.measureViewport);
  }
}

function nearestMemoryVirtualListIndex(input: {
  scroller: () => HTMLElement | null | undefined;
  root: RefObject<HTMLDivElement | null>;
  geometry: MemoryVirtualListGeometry;
  visible: readonly number[];
  anchor: (element: HTMLElement) => number;
}): number {
  const element = input.scroller();
  const rootElement = input.root.current;
  if (element === null || element === undefined || rootElement === null) {
    return 0;
  }
  const position = input.anchor(element) - rootElement.getBoundingClientRect().top;
  const current = input.geometry.indexAt(position);
  const slot = lowerBound({ items: input.visible, value: current, offset: (item) => item });
  const candidates = input.visible.slice(
    Math.max(0, slot - MEMORY_VIRTUAL_LIST_NEAREST_INDEX_SLOT_BEFORE),
    slot + MEMORY_VIRTUAL_LIST_NEAREST_INDEX_SLOT_AFTER,
  );

  return candidates.reduce(
    (best, index) =>
      Math.abs(input.geometry.offset(index) + input.geometry.headerHeight(index) - position) <
      Math.abs(input.geometry.offset(best) + input.geometry.headerHeight(best) - position)
        ? index
        : best,
    current,
  );
}

function moveMemoryVirtualListFocus(input: {
  event: KeyboardEvent<HTMLElement>;
  index: number;
  visible: readonly number[];
  collapsedIndices: ReadonlySet<number>;
  expandedIndex: number;
  memories: readonly RelationshipMemory[];
  setFocusedId: (value: string | null) => void;
  scrollToIndex: MemoryVirtualListScrollToIndex;
  root: RefObject<HTMLDivElement | null>;
}) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(input.event.key)) {
    return;
  }
  input.event.preventDefault();
  const available = input.visible.filter((item) => !input.collapsedIndices.has(item) && item !== input.expandedIndex);
  const slot = available.indexOf(input.index);
  const nextSlot =
    input.event.key === "Home"
      ? 0
      : input.event.key === "End"
        ? available.length - 1
        : Math.max(0, Math.min(available.length - 1, slot + (input.event.key === "ArrowDown" ? 1 : -1)));
  const next = available[nextSlot];
  const nextMemory = next === undefined ? undefined : input.memories[next];
  if (next === undefined || nextMemory === undefined) {
    return;
  }
  flushSync(() => input.setFocusedId(nextMemory.id));
  input.scrollToIndex(next, "instant");
  input.root.current
    ?.querySelector<HTMLElement>(`[data-memory-id="${nextMemory.id}"] [data-browser-row]`)
    ?.focus({ preventScroll: true });
}

function useMemoryVirtualListScrollMemory(input: {
  root: RefObject<HTMLDivElement | null>;
  memories: readonly RelationshipMemory[];
  geometry: MemoryVirtualListGeometry;
}) {
  const previousWindow = useRef<{ first?: string; anchor?: string; offset: number } | null>(null);
  useLayoutEffect(() => {
    const element = input.root.current?.closest<HTMLElement>(".relationship-memory-content");
    if (element === null || element === undefined) {
      return;
    }
    const previous = previousWindow.current;
    if (
      element.scrollTop > 0 &&
      previous !== null &&
      previous.first !== input.memories[0]?.id &&
      previous.anchor !== undefined &&
      previous.anchor !== ""
    ) {
      const index = input.memories.findIndex((memory) => memory.id === previous.anchor);
      if (index >= 0) {
        element.scrollTop += input.geometry.offset(index) - previous.offset;
      }
    }
    const remember = () => {
      const top = element.getBoundingClientRect().top - (input.root.current?.getBoundingClientRect().top ?? 0);
      const index = input.geometry.indexAt(top);
      previousWindow.current = {
        first: input.memories[0]?.id,
        anchor: input.memories[index]?.id,
        offset: input.geometry.offset(index),
      };
    };
    remember();
    element.addEventListener("scroll", remember, { passive: true });

    return () => element.removeEventListener("scroll", remember);
  }, [input.memories, input.geometry, input.root]);
}

function useMemoryVirtualListViewport(input: {
  root: RefObject<HTMLDivElement | null>;
  scroller: () => HTMLElement | null | undefined;
  anchor: (element: HTMLElement) => number;
}) {
  const [viewport, setViewport] = useState({
    top: 0,
    height: MEMORY_VIRTUAL_LIST_DEFAULT_VIEWPORT_HEIGHT,
    anchorInset: 0,
  });
  const measureViewport = useCallback(() => {
    const element = input.scroller();
    const rootElement = input.root.current;
    if (rootElement === null || element === null || element === undefined) {
      return;
    }
    const clientHeight = element.clientHeight;
    const next = {
      top: element.getBoundingClientRect().top - rootElement.getBoundingClientRect().top,
      height: clientHeight > 0 ? clientHeight : MEMORY_VIRTUAL_LIST_DEFAULT_VIEWPORT_HEIGHT,
      anchorInset: input.anchor(element) - element.getBoundingClientRect().top,
    };
    setViewport((previous) =>
      previous.top === next.top && previous.height === next.height && previous.anchorInset === next.anchorInset
        ? previous
        : next,
    );
  }, [input.scroller, input.anchor, input.root]);
  useLayoutEffect(() => {
    const element = input.scroller();
    const rootElement = input.root.current;
    if (element === null || element === undefined || rootElement === null) {
      return;
    }
    const frame: { id: number | null } = { id: null };
    const update = () => {
      frame.id = null;
      measureViewport();
    };
    const scroll = () => {
      frame.id ??= requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(rootElement);
    element.addEventListener("scroll", scroll, { passive: true });
    update();

    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", scroll);
      if (frame.id !== null) {
        cancelAnimationFrame(frame.id);
      }
    };
  }, [input.scroller, measureViewport, input.root]);

  return { viewport, measureViewport };
}

function useMemoryVirtualListSizeMeasurement(input: {
  root: RefObject<HTMLDivElement | null>;
  expandedId?: string;
  windowKey: string;
  setSizes: Dispatch<SetStateAction<MemoryVirtualListSizes>>;
}) {
  useLayoutEffect(() => {
    const rootElement = input.root.current;
    if (rootElement === null) {
      return;
    }
    const row = rootElement.querySelector<HTMLElement>(".relationship-memory-row:not(.is-expanded)");
    const header = rootElement.querySelector<HTMLElement>("[data-memory-day-header]");
    const expanded = rootElement.querySelector<HTMLElement>(".relationship-memory-row.is-expanded");
    const measure = () => {
      const rowHeight = row?.getBoundingClientRect().height;
      const headerHeight = header?.getBoundingClientRect().height;
      const expandedHeight = expanded?.getBoundingClientRect().height;
      const style = expanded ? getComputedStyle(expanded) : null;
      input.setSizes((previous) => {
        const next: MemoryVirtualListSizes = {
          row: rowHeight !== undefined && rowHeight > 0 ? rowHeight : previous.row,
          header: headerHeight !== undefined && headerHeight > 0 ? headerHeight : previous.header,
          expanded:
            expandedHeight !== undefined && expandedHeight > 0
              ? expandedHeight +
                parseMarginPixels(style?.marginTop ?? "") +
                parseMarginPixels(style?.marginBottom ?? "")
              : previous.expanded,
          expandedId:
            expandedHeight !== undefined && expandedHeight > 0 ? (input.expandedId ?? "") : previous.expandedId,
        };

        return memoryVirtualListSizesEqual({ next, previous }) ? previous : next;
      });
    };
    const observer = new ResizeObserver(measure);
    [row, header, expanded].forEach((element) => {
      if (element) {
        observer.observe(element);
      }
    });
    measure();

    return () => observer.disconnect();
  }, [input.expandedId, input.windowKey, input.root, input.setSizes]);
}

function MemoryVirtualListRows(input: {
  indices: readonly number[];
  memories: readonly RelationshipMemory[];
  headers: ReadonlyMap<number, { day: string; count: number; index: number }>;
  geometry: MemoryVirtualListGeometry;
  expandedId?: string;
  collapsedIndices: ReadonlySet<number>;
  setCollapsed: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** @external memory virtual list wire field */
  focused: boolean;
  /** @external memory virtual list wire field */
  preview: boolean;
  detail?: ReactNode;
  onOpen?: (memory: RelationshipMemory) => void;
  moveFocus: (args: { event: KeyboardEvent<HTMLElement>; index: number }) => void;
}) {
  return input.indices.map((index) => {
    const memory = input.memories[index];
    if (memory === undefined) {
      throw new Error(MEMORY_VIRTUAL_LIST_ROW_MISSING_MESSAGE);
    }
    const group = input.headers.get(index);
    const isExpanded = input.expandedId === memory.id;
    const isCollapsed = input.collapsedIndices.has(index);
    const content = (
      <>
        <span className="relationship-memory-list-arrow" aria-hidden="true">
          <MemoryTimelineArrow />
        </span>
        <span className="relationship-memory-title">{memory.title}</span>
        <CategoryBadge category={memory.category} />
      </>
    );

    return (
      <section
        key={memory.id}
        data-memory-slot={memory.id}
        className="relationship-memory-group memory-virtual-slot"
        style={{ top: input.geometry.offset(index) }}
      >
        {group !== undefined ? (
          <h2 className="relationship-memory-group-heading" data-memory-day-header inert={input.focused}>
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() =>
                input.setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(group.day)) {
                    next.delete(group.day);
                  } else {
                    next.add(group.day);
                  }

                  return next;
                })
              }
            >
              <span className="relationship-group-chevron" aria-hidden="true">
                <MemoryIcon name="disclosure" />
              </span>
              {group.day}
              <span className="relationship-group-count">{group.count}</span>
            </button>
          </h2>
        ) : null}
        {!isCollapsed ? (
          <ol className="relationship-memory-list">
            <li
              data-memory-id={memory.id}
              inert={input.focused ? !isExpanded : false}
              className={`relationship-memory-row${isExpanded ? " is-expanded" : ""}`}
            >
              {isExpanded ? (
                input.detail
              ) : input.preview ? (
                <div className="relationship-memory-open">{content}</div>
              ) : (
                <button
                  data-browser-row
                  className="relationship-memory-open"
                  aria-label={`Open memory: ${memory.title}`}
                  aria-expanded={false}
                  onKeyDown={(event) => input.moveFocus({ event, index })}
                  onClick={() => input.onOpen?.(memory)}
                >
                  {content}
                </button>
              )}
            </li>
          </ol>
        ) : null}
      </section>
    );
  });
}

function useMemoryVirtualListLayout(input: {
  root: RefObject<HTMLDivElement | null>;
  memories: RelationshipMemory[];
  expandedId?: string;
  focusedId: string | null;
  collapsed: ReadonlySet<string>;
  /** @external memory virtual list wire field */
  preview: boolean;
}) {
  const groups = useMemo(
    () => getMemoryDayGroups(input.memories.map((memory) => memoryDay(memory.occurredAt))),
    [input.memories],
  );
  const days = useMemo(() => input.memories.map((memory) => memoryDay(memory.occurredAt)), [input.memories]);
  const dayStarts = useMemo(() => groups.map((group) => group.index), [groups]);
  const headers = useMemo(() => new Map(groups.map((group) => [group.index, group])), [groups]);
  const expandedIndex = input.memories.findIndex((memory) => memory.id === input.expandedId);
  const focusedIndex = input.memories.findIndex((memory) => memory.id === input.focusedId);
  const collapsedIndices = useMemo(
    () => new Set(days.flatMap((day, index) => (input.collapsed.has(day) ? [index] : []))),
    [days, input.collapsed],
  );
  const [sizes, setSizes] = useState<MemoryVirtualListSizes>(() => ({
    row: MEMORY_VIRTUAL_LIST_INITIAL_ROW_HEIGHT,
    header: MEMORY_DAY_HEADER_HEIGHT,
    expanded: DEFAULT_EXPANDED_MEMORY_ROW_HEIGHT,
    expandedId: "",
  }));
  const geometry = useMemo(
    () =>
      createListGeometry({
        count: input.memories.length,
        expandedIndex,
        expandedHeight: sizes.expandedId === input.expandedId ? sizes.expanded : DEFAULT_EXPANDED_MEMORY_ROW_HEIGHT,
        dayStarts,
        collapsedIndices,
        rowHeight: sizes.row,
        dayHeaderHeight: sizes.header,
      }),
    [input.memories.length, expandedIndex, input.expandedId, sizes, dayStarts, collapsedIndices],
  );
  useMemoryVirtualListScrollMemory({ root: input.root, memories: input.memories, geometry });
  const scroller = useCallback(
    () =>
      input.preview
        ? input.root.current?.closest<HTMLElement>(".relationship-memory-upgrade-preview")
        : input.root.current?.closest<HTMLElement>(".relationship-memory-content"),
    [input.preview, input.root],
  );
  const anchor = useCallback(
    (element: HTMLElement) =>
      (input.root.current?.getBoundingClientRect().top ?? element.getBoundingClientRect().top) +
      element.scrollTop +
      geometry.headerHeight(0),
    [geometry, input.root],
  );
  const { viewport, measureViewport } = useMemoryVirtualListViewport({ root: input.root, scroller, anchor });
  const visible = geometry.visibleIndices;
  const indices = useMemo(
    () =>
      resolveMemoryWindowIndices({
        geometry,
        visible,
        viewport,
        expandedIndex,
        focusedIndex,
      }),
    [geometry, visible, viewport, expandedIndex, focusedIndex],
  );
  const windowKey = indices.join(",");
  useMemoryVirtualListSizeMeasurement({ root: input.root, expandedId: input.expandedId, windowKey, setSizes });

  return {
    days,
    dayStarts,
    headers,
    indices,
    geometry,
    trailingSpace: computeMemoryVirtualListTrailingSpace({ geometry, visible, viewport }),
    collapsedIndices,
    expandedIndex,
    sizes,
    scroller,
    anchor,
    measureViewport,
    visible,
  };
}

function useMemoryVirtualListRuntime(input: {
  ref?: Ref<MemoryVirtualListHandle>;
  containerRef?: RefObject<HTMLDivElement | null>;
  memories: RelationshipMemory[];
  expandedId?: string;
  /** @external memory virtual list wire field */
  preview: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const hostContainerRef = input.containerRef;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const layout = useMemoryVirtualListLayout({
    root,
    memories: input.memories,
    expandedId: input.expandedId,
    focusedId,
    collapsed,
    preview: input.preview,
  });
  const scrollToIndex: MemoryVirtualListScrollToIndex = (...args) =>
    scrollMemoryVirtualListToIndex({
      index: args[0],
      behavior: args[1],
      scroller: layout.scroller,
      root,
      days: layout.days,
      memories: input.memories,
      collapsed,
      setCollapsed,
      expandedIndex: layout.expandedIndex,
      expandedId: input.expandedId,
      sizes: layout.sizes,
      dayStarts: layout.dayStarts,
      geometry: layout.geometry,
      anchor: layout.anchor,
      measureViewport: layout.measureViewport,
    });
  useImperativeHandle(input.ref, () => ({
    scrollToIndex,
    nearestIndex: () =>
      nearestMemoryVirtualListIndex({
        scroller: layout.scroller,
        root,
        geometry: layout.geometry,
        visible: layout.visible,
        anchor: layout.anchor,
      }),
  }));
  const moveFocus = (args: { event: KeyboardEvent<HTMLElement>; index: number }) =>
    moveMemoryVirtualListFocus({
      event: args.event,
      index: args.index,
      visible: layout.visible,
      collapsedIndices: layout.collapsedIndices,
      expandedIndex: layout.expandedIndex,
      memories: input.memories,
      setFocusedId,
      scrollToIndex,
      root,
    });

  return {
    root,
    hostContainerRef,
    headers: layout.headers,
    indices: layout.indices,
    geometry: layout.geometry,
    trailingSpace: layout.trailingSpace,
    collapsed,
    setCollapsed,
    collapsedIndices: layout.collapsedIndices,
    setFocusedId,
    moveFocus,
  };
}

// Highlight's list window: two screens behind and ahead, with expanded and focused
// rows pinned. Ready measures its own compact rows and expanded transcript height.
export function MemoryVirtualList(props: {
  ref?: Ref<MemoryVirtualListHandle>;
  containerRef?: RefObject<HTMLDivElement | null>;
  memories: RelationshipMemory[];
  expandedId?: string;
  detail?: ReactNode;
  /** @external memory virtual list wire field */
  focused?: boolean;
  /** @external memory virtual list wire field */
  preview?: boolean;
  onOpen?: (memory: RelationshipMemory) => void;
}) {
  const runtime = useMemoryVirtualListRuntime({
    ref: props.ref,
    containerRef: props.containerRef,
    memories: props.memories,
    expandedId: props.expandedId,
    preview: props.preview ?? false,
  });

  return (
    <div
      ref={(element) => {
        runtime.root.current = element;
        if (runtime.hostContainerRef !== undefined) {
          runtime.hostContainerRef.current = element;
        }
      }}
      data-memory-browser-list
      className="memory-virtual-list"
      style={{ height: runtime.geometry.total + runtime.trailingSpace }}
      onFocusCapture={(event) => {
        const eventTarget = event.target;
        if (!(eventTarget instanceof HTMLElement)) {
          return;
        }
        const slot = eventTarget.closest<HTMLElement>("[data-memory-slot]");
        runtime.setFocusedId(slot?.dataset.memorySlot ?? null);
      }}
      onBlurCapture={(event) => {
        const target = event.relatedTarget;
        if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target)) {
          runtime.setFocusedId(null);
        }
      }}
    >
      <MemoryVirtualListRows
        indices={runtime.indices}
        memories={props.memories}
        headers={runtime.headers}
        geometry={runtime.geometry}
        expandedId={props.expandedId}
        collapsedIndices={runtime.collapsedIndices}
        setCollapsed={runtime.setCollapsed}
        focused={props.focused ?? false}
        preview={props.preview ?? false}
        detail={props.detail}
        onOpen={props.onOpen}
        moveFocus={runtime.moveFocus}
      />
    </div>
  );
}
