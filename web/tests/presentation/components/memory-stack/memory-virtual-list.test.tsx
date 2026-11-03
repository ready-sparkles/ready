import "../../../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RelationshipMemory } from "@readymeet/shared";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React, { createRef } from "react";

import { buildMemoryRulerItems } from "../../../../presentation/components/memory-stack/memory-ruler";
import {
  MemoryVirtualList,
  type MemoryVirtualListHandle,
} from "../../../../presentation/components/memory-stack/memory-virtual-list";
import { createListGeometry } from "../../../../presentation/components/memory-stack/windowing";

const MEMORY_FIXTURE_COUNT = 2000;
const LOGICAL_MEMORY_SCALE = 100_000;
const MAX_MOUNTED_ROWS = 100;
const SCROLLER_CLIENT_HEIGHT = 600;
const MEMORIES_PER_DAY_BUCKET = 100;
const FIXTURE_DATE_YEAR = 2026;
const FIXTURE_DATE_MONTH_INDEX = 8;
const FIXTURE_DATE_DAY_BASE = 19;
const FIXTURE_DATE_HOUR_NOON = 12;
const REMOTE_SCROLL_INDEX = 1500;
const MANUAL_SCROLL_TOP = 40_000;
const MIN_NEAREST_INDEX_AFTER_SCROLL = 900;
const ARROW_ROW_SVG_COUNT = 3;
const DAY_GROUP_HEADER_COUNT = 1;
const TIME_ELEMENT_COUNT = 0;
const MEETING_LOCAL_YEAR = 2026;
const MEETING_LOCAL_MONTH = 8;
const MEETING_LOCAL_DAY = 19;
const MEETING_LOCAL_HOUR = 23;
const MEETING_LOCAL_MINUTE = 0;
const EVIDENCE_LOCAL_YEAR = 2026;
const EVIDENCE_LOCAL_MONTH = 8;
const EVIDENCE_LOCAL_DAY = 20;
const EVIDENCE_LOCAL_HOUR = 0;
const EVIDENCE_LOCAL_MINUTE = 15;
const HIGH_IMPORTANCE = 4;
const LOW_IMPORTANCE = 1;
const EXPANDED_MEMORY_ID = "memory-10";
const KEY_NAV_SOURCE_INDEX = 9;
const FOCUS_MEMORY_INDEX = 2;
const LAST_MEMORY_INDEX = MEMORY_FIXTURE_COUNT - 1;
const GEOMETRY_ITEM_COUNT = 6;
const GEOMETRY_EXPANDED_INDEX = 1;
const GEOMETRY_EXPANDED_HEIGHT = 400;
const GEOMETRY_FIRST_DAY_START = 0;
const GEOMETRY_SECOND_DAY_START = 3;
const GEOMETRY_COLLAPSED_INDEX_A = 3;
const GEOMETRY_COLLAPSED_INDEX_B = 4;
const GEOMETRY_COLLAPSED_INDEX_C = 5;
const GEOMETRY_ROW_HEIGHT = 40;
const GEOMETRY_DAY_HEADER_HEIGHT = 48;
const GEOMETRY_EXPECTED_TOTAL = 576;
const GEOMETRY_PROBE_INDEX = 2;
const GEOMETRY_EXPECTED_OFFSET = 488;
const GEOMETRY_SCROLL_POSITION = 490;
const GEOMETRY_VISIBLE_START = 0;
const GEOMETRY_VISIBLE_MID = 1;
const GEOMETRY_VISIBLE_END = 2;
const GEOMETRY_VISIBLE_BOUNDARY = 3;
const RULER_ALIGNMENT_SMALL_ROW_COUNT = 3;
const DAY_HEADER_SLOT_OFFSET = 48;
const RULER_TOP_TOLERANCE = 0.01;
const RULER_MIDPOINT_DIVISOR = 2;
const RULER_JUMP_INDEX = 1;
const EXPANDED_TRANSCRIPT_COPY = "Expanded transcript";

afterEach(cleanup);
after(async () => GlobalRegistrator.unregister());

function required<T>({ value, label }: { value: T | null | undefined; label: string }): T {
  if (value === null || value === undefined) {
    throw new Error(label);
  }

  return value;
}

const memories: RelationshipMemory[] = Array.from({ length: MEMORY_FIXTURE_COUNT }, (_, index) => ({
  id: `memory-${index}`,
  sourceId: "source",
  meetingId: "meeting",
  title: `Memory ${index}`,
  description: "An example memory",
  personIds: [],
  candidateSubjectId: null,
  candidateSubjectKey: null,
  /** @external relationship memory wire field */
  sensitive: false,
  confidence: "high",
  evidence: [],
  category: "Sales",
  occurredAt: new Date(
    Date.UTC(
      FIXTURE_DATE_YEAR,
      FIXTURE_DATE_MONTH_INDEX,
      FIXTURE_DATE_DAY_BASE - Math.floor(index / MEMORIES_PER_DAY_BUCKET),
      FIXTURE_DATE_HOUR_NOON,
    ),
  ).toISOString(),
}));

void test("100,000 logical memories still mount fewer than 100 rows in a normal viewport", () => {
  const rows = Array.from({ length: LOGICAL_MEMORY_SCALE }, (_, index) => ({
    ...required({ value: memories[0], label: "Expected a memory fixture." }),
    id: `scale-${index}`,
  }));
  const view = setup({ rows });
  const mounted = view.container.querySelectorAll("[data-memory-id]").length;
  assert.ok(mounted > 0 && mounted < MAX_MOUNTED_ROWS);
});

function setup({
  preview: isPreview = false,
  expandedId,
  rows = memories,
}: {
  /** @external memory virtual list wire field */
  preview?: boolean;
  expandedId?: string;
  rows?: RelationshipMemory[];
} = {}) {
  const ref = createRef<MemoryVirtualListHandle>();
  const view = render(
    <div className={isPreview ? "relationship-memory-upgrade-preview" : "relationship-memory-content"}>
      <MemoryVirtualList
        ref={ref}
        memories={rows}
        preview={isPreview}
        expandedId={expandedId}
        detail={<div>{EXPANDED_TRANSCRIPT_COPY}</div>}
      />
    </div>,
  );
  const scroller = required({
    value: view.container.firstElementChild instanceof HTMLElement ? view.container.firstElementChild : null,
    label: "Expected a scroller element.",
  });
  const list = required({
    value: view.container.querySelector<HTMLElement>(".memory-virtual-list"),
    label: "Expected a memory virtual list.",
  });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: SCROLLER_CLIENT_HEIGHT });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 0, SCROLLER_CLIENT_HEIGHT);
  list.getBoundingClientRect = () => new DOMRect(0, -scroller.scrollTop, 0, Number.parseFloat(list.style.height));
  scroller.scrollTo = function scrollTo(optionsOrX?: ScrollToOptions | number, y?: number) {
    const scrollTopTarget = typeof optionsOrX === "number" ? (typeof y === "number" ? y : 0) : (optionsOrX?.top ?? 0);
    // Model the browser's real scroll limit; an unclamped mock hides end-of-list bugs.
    const maxScroll = Math.max(0, Number.parseFloat(list.style.height) - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(maxScroll, scrollTopTarget));
    fireEvent.scroll(scroller);
  } satisfies typeof scroller.scrollTo;

  return { ...view, ref, scroller, list };
}

const rowName = (index: number) => ({
  name: `Open memory: Memory ${index}`,
  /** @external testing-library role query wire field */
  exact: true,
});

void test("arrow rows replace timestamps while preserving importance order, day groups, and ruler targets", () => {
  const meetingTime = new Date(
    MEETING_LOCAL_YEAR,
    MEETING_LOCAL_MONTH,
    MEETING_LOCAL_DAY,
    MEETING_LOCAL_HOUR,
    MEETING_LOCAL_MINUTE,
  ).toISOString();
  const evidenceTime = new Date(
    EVIDENCE_LOCAL_YEAR,
    EVIDENCE_LOCAL_MONTH,
    EVIDENCE_LOCAL_DAY,
    EVIDENCE_LOCAL_HOUR,
    EVIDENCE_LOCAL_MINUTE,
  ).toISOString();
  const rows = [
    {
      ...required({ value: memories[0], label: "Expected a memory fixture." }),
      occurredAt: meetingTime,
      evidenceOccurredAt: meetingTime,
      importance: HIGH_IMPORTANCE,
    },
    {
      ...required({ value: memories[1], label: "Expected a memory fixture." }),
      occurredAt: meetingTime,
      evidenceOccurredAt: evidenceTime,
      importance: LOW_IMPORTANCE,
    },
    {
      ...required({ value: memories[2], label: "Expected a memory fixture." }),
      occurredAt: meetingTime,
      evidenceOccurredAt: null,
    },
  ];
  const view = render(<MemoryVirtualList memories={rows} />);
  assert.deepEqual(
    [...view.container.querySelectorAll(".relationship-memory-title")].map((element) => element.textContent),
    rows.map((row) => row.title),
  );
  assert.equal(view.container.querySelectorAll("time").length, TIME_ELEMENT_COUNT);
  assert.equal(view.container.querySelectorAll(".relationship-memory-list-arrow svg").length, ARROW_ROW_SVG_COUNT);
  assert.equal(view.container.querySelectorAll("h2").length, DAY_GROUP_HEADER_COUNT);
  const ticks = buildMemoryRulerItems(rows).filter((item) => item.kind === "moment");
  assert.deepEqual(
    ticks.map((tick) => tick.id),
    rows.map((row) => row.id).reverse(),
  );
  const secondRow = required({ value: rows[1], label: "Expected a second memory." });
  const secondTick = required({
    value: ticks.find((tick) => tick.id === secondRow.id),
    label: "Expected a ruler tick for the second memory.",
  });
  assert.equal(secondTick.index, 1);
  assert.ok(
    secondTick.label.endsWith(
      new Date(evidenceTime).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    ),
  );
});

void test("large lists keep DOM bounded; ruler jumps reach unmounted rows and return to the top", () => {
  const view = setup();
  assert.ok(view.container.querySelectorAll("[data-memory-id]").length < MAX_MOUNTED_ROWS);
  assert.equal(view.queryByRole("button", rowName(REMOTE_SCROLL_INDEX)), null);
  act(() =>
    required({ value: view.ref.current, label: "Expected a memory list handle." }).scrollToIndex(
      REMOTE_SCROLL_INDEX,
      "instant",
    ),
  );
  assert.equal(
    view.getByRole("button", rowName(REMOTE_SCROLL_INDEX)).getAttribute("aria-label"),
    rowName(REMOTE_SCROLL_INDEX).name,
  );
  assert.equal(
    required({ value: view.ref.current, label: "Expected a memory list handle." }).nearestIndex(),
    REMOTE_SCROLL_INDEX,
  );
  assert.ok(view.container.querySelectorAll("[data-memory-id]").length < MAX_MOUNTED_ROWS);
  act(() => required({ value: view.ref.current, label: "Expected a memory list handle." }).scrollToIndex(0, "instant"));
  assert.equal(view.scroller.scrollTop, 0);
  assert.equal(view.getByRole("button", rowName(0)).getAttribute("aria-label"), rowName(0).name);
});

void test("expanded and focused rows stay mounted outside the viewport", () => {
  const view = setup({ expandedId: EXPANDED_MEMORY_ID });
  fireEvent.keyDown(view.getByRole("button", rowName(KEY_NAV_SOURCE_INDEX)), { key: "ArrowDown" });
  const arrowActiveElement = document.activeElement;
  assert.ok(arrowActiveElement !== null);
  assert.equal(arrowActiveElement.getAttribute("aria-label"), "Open memory: Memory 11");
  act(() => view.getByRole("button", rowName(FOCUS_MEMORY_INDEX)).focus());
  act(() =>
    required({ value: view.ref.current, label: "Expected a memory list handle." }).scrollToIndex(
      REMOTE_SCROLL_INDEX,
      "instant",
    ),
  );
  assert.equal(view.getByText(EXPANDED_TRANSCRIPT_COPY).textContent, EXPANDED_TRANSCRIPT_COPY);
  assert.equal(
    view.getByRole("button", rowName(FOCUS_MEMORY_INDEX)).getAttribute("aria-label"),
    rowName(FOCUS_MEMORY_INDEX).name,
  );
  const focusedActiveElement = document.activeElement;
  assert.ok(focusedActiveElement !== null);
  assert.equal(focusedActiveElement.getAttribute("aria-label"), "Open memory: Memory 2");
  assert.ok(view.container.querySelectorAll("[data-memory-id]").length < MAX_MOUNTED_ROWS);
});

void test("Home and End navigate the full data set rather than mounted rows", () => {
  const view = setup();
  fireEvent.keyDown(view.getByRole("button", rowName(0)), { key: "End" });
  const lastActiveElement = document.activeElement;
  assert.ok(lastActiveElement !== null);
  assert.equal(lastActiveElement.getAttribute("aria-label"), `Open memory: Memory ${LAST_MEMORY_INDEX}`);
  fireEvent.keyDown(lastActiveElement, { key: "Home" });
  const firstActiveElement = document.activeElement;
  assert.ok(firstActiveElement !== null);
  assert.equal(firstActiveElement.getAttribute("aria-label"), "Open memory: Memory 0");
});

void test("ruler navigation reopens a collapsed target group", () => {
  const view = setup();
  fireEvent.click(
    required({
      value: view.container.querySelector<HTMLButtonElement>("h2 button"),
      label: "Expected a group toggle.",
    }),
  );
  assert.equal(view.queryByRole("button", rowName(0)), null);
  act(() =>
    required({ value: view.ref.current, label: "Expected a memory list handle." }).scrollToIndex(
      REMOTE_SCROLL_INDEX,
      "instant",
    ),
  );
  act(() => required({ value: view.ref.current, label: "Expected a memory list handle." }).scrollToIndex(0, "instant"));
  assert.equal(view.getByRole("button", rowName(0)).getAttribute("aria-label"), rowName(0).name);
  assert.equal(view.container.querySelector("h2 button")?.getAttribute("aria-expanded"), "true");
});

void test("free preview uses its own scroller without memory action buttons", () => {
  const view = setup({ /** @external memory virtual list wire field */ preview: true });
  act(() =>
    required({ value: view.ref.current, label: "Expected a memory list handle." }).scrollToIndex(
      REMOTE_SCROLL_INDEX,
      "instant",
    ),
  );
  assert.equal(
    required({ value: view.ref.current, label: "Expected a memory list handle." }).nearestIndex(),
    REMOTE_SCROLL_INDEX,
  );
  assert.ok(view.scroller.scrollTop > 0);
  assert.equal(view.queryByRole("button", { name: /Open memory|View transcript|Forget/ }), null);
});

void test("manual scrolling replaces the visible DOM window", async () => {
  const view = setup();
  await act(async () => {
    view.scroller.scrollTo({ top: MANUAL_SCROLL_TOP });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  assert.equal(view.queryByRole("button", rowName(0)) === null, true);
  assert.ok(view.container.querySelectorAll("[data-memory-id]").length < MAX_MOUNTED_ROWS);
  assert.ok(
    required({ value: view.ref.current, label: "Expected a memory list handle." }).nearestIndex() >
      MIN_NEAREST_INDEX_AFTER_SCROLL,
  );
});

void test("geometry includes measured rows, expanded height, headers and collapsed groups", () => {
  const geometry = createListGeometry({
    count: GEOMETRY_ITEM_COUNT,
    expandedIndex: GEOMETRY_EXPANDED_INDEX,
    expandedHeight: GEOMETRY_EXPANDED_HEIGHT,
    dayStarts: [GEOMETRY_FIRST_DAY_START, GEOMETRY_SECOND_DAY_START],
    collapsedIndices: new Set([GEOMETRY_COLLAPSED_INDEX_A, GEOMETRY_COLLAPSED_INDEX_B, GEOMETRY_COLLAPSED_INDEX_C]),
    rowHeight: GEOMETRY_ROW_HEIGHT,
    dayHeaderHeight: GEOMETRY_DAY_HEADER_HEIGHT,
  });
  assert.equal(geometry.total, GEOMETRY_EXPECTED_TOTAL);
  assert.equal(geometry.offset(GEOMETRY_PROBE_INDEX), GEOMETRY_EXPECTED_OFFSET);
  assert.equal(geometry.indexAt(GEOMETRY_SCROLL_POSITION), GEOMETRY_PROBE_INDEX);
  assert.deepEqual(geometry.visibleIndices, [
    GEOMETRY_VISIBLE_START,
    GEOMETRY_VISIBLE_MID,
    GEOMETRY_VISIBLE_END,
    GEOMETRY_VISIBLE_BOUNDARY,
  ]);
  assert.equal(createListGeometry({ count: 0 }).total, 0);
});

[false, true].forEach((isPreviewMode) => {
  [RULER_ALIGNMENT_SMALL_ROW_COUNT, MEMORY_FIXTURE_COUNT].forEach((count) => {
    void test(`all ruler targets align with the first row, including the oldest (${count} rows, preview=${isPreviewMode})`, () => {
      const view = setup({
        /** @external memory virtual list wire field */
        preview: isPreviewMode,
        rows: memories.slice(0, count),
      });
      const handle = required({ value: view.ref.current, label: "Expected a memory list handle." });
      // Measure the fixture's viewport before navigating, as ResizeObserver does in a browser.
      act(() => handle.scrollToIndex(0, "instant"));
      const rowTop = (index: number) => {
        const slot = required({
          value: view.container.querySelector<HTMLElement>(`[data-memory-slot="memory-${index}"]`),
          label: `Expected a memory slot for ${index}.`,
        });

        return (
          view.list.getBoundingClientRect().top +
          Number.parseFloat(slot.style.top) +
          (slot.querySelector("h2") ? DAY_HEADER_SLOT_OFFSET : 0)
        );
      };
      const firstTop = rowTop(0);
      [Math.floor(count / RULER_MIDPOINT_DIVISOR), count - 1, RULER_JUMP_INDEX, 0].forEach((index) => {
        act(() => handle.scrollToIndex(index, "instant"));
        assert.ok(
          Math.abs(rowTop(index) - firstTop) < RULER_TOP_TOLERANCE,
          `row ${index} must reach the same top position`,
        );
        assert.equal(handle.nearestIndex(), index);
        assert.ok(view.container.querySelectorAll("[data-memory-id]").length < MAX_MOUNTED_ROWS);
      });
      assert.equal(view.scroller.scrollTop, 0);
    });
  });
});
