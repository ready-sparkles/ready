import "../../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RelationshipMemory } from "@readymeet/shared";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";

import { MemoryCardBrowser } from "../../../presentation/components/memory-stack/memory-card-browser";
import type { MemoryDisplayMode } from "../../../presentation/components/memory-stack/memory-layout-toggle";
import { useMemoryArrivals } from "../../../presentation/components/memory-stack/use-memory-arrivals";

const HARNESS_LIST_LABEL = "List";
const MISSING_NAVIGATION_CONTROL_ERROR = "Missing navigation control";
const MISSING_MEMORY_CARD_STAGE_ERROR = "Missing memory card stage";
const MISSING_FRONT_MEMORY_CARD_ERROR = "Missing front memory card";

const PAGE_COUNT_INITIAL = 0;
const PAGE_COUNT_SINGLE = 1;
const PAGE_COUNT_TWO = 2;

const MS_BEFORE_REVEAL_TICK = 999;
const REVEAL_EDGE_TICK_MS = 1;
const REVEAL_DURATION_MS = 400;
const MODE_SWITCH_CANCEL_WAIT_MS = 2000;
const BATCH_SWEEP_WAIT_MS = 1400;

const VISIT_ANIMATION_FRAME_COUNT = 3;
const VISIT_FRAME_DELTA_MS = 1000;

const LOAD_MORE_EXPECTED_AFTER_RETRY = 2;
const LOAD_MORE_EXPECTED_AFTER_RECOVERY = 3;

const POINTER_ID_PRIMARY = 1;
const POINTER_ID_SECONDARY = 2;

const TOUCH_DEFAULT_Y = 100;
const TOUCH_X_CENTER = 250;
const TOUCH_X_SLIGHT = 248;
const TOUCH_Y_SCROLL = 180;
const TOUCH_X_MICRO_SWIPE = 246;
const TOUCH_X_EDGE = 20;
const TOUCH_X_DRAG = 200;
const TOUCH_X_SECOND_POINTER = 180;
const TOUCH_X_NAVIGATE = 100;

const SETTLE_ANIMATION_FRAME_COUNT = 60;
const SETTLE_FRAME_DELTA_MS = 16;

const BOUNDED_ROW_TOTAL = 1050;
const BOUNDED_ROW_PAGE_SIZE = 1000;
const BOUNDED_PAGE_COUNT = 20;
const BOUNDED_PAGE_OVERLAP = 50;

const REQUEST_ANIMATION_FRAME_HANDLE = 1;

after(async () => {
  await GlobalRegistrator.unregister();
});
const existing: RelationshipMemory = {
  id: "existing",
  sourceId: "source",
  meetingId: "meeting",
  title: "Existing memory",
  description: "Existing context.",
  category: "Sales",
  personIds: [],
  candidateSubjectId: null,
  candidateSubjectKey: null,
  /** @external relationship memory wire field */
  sensitive: false,
  confidence: "high",
  evidence: [],
  occurredAt: "2026-09-18T10:00:00Z",
};
const fresh = {
  ...existing,
  id: "fresh",
  title: "Newly processed memory",
  occurredAt: "2026-09-19T10:00:00Z",
};
function Harness({ memories, mode = "stack" }: { memories: RelationshipMemory[]; mode?: MemoryDisplayMode }) {
  const arrivals = useMemoryArrivals({ memories, scope: "all", ready: true, pageCount: 1 });

  return (
    <>
      <output data-testid="pending">{arrivals.arrivingIds.join(",")}</output>
      {memories.length !== 0 ? (
        <MemoryCardBrowser
          {...arrivals}
          memories={memories}
          mode={mode}
          onModeChange={() => {}}
          disabled={false}
          hasMore={false}
          loadingMore={false}
          loadMore={() => {}}
          renderCard={({ memory }) => (
            <>
              <div>{memory.title}</div>
              <a href="#transcript">View transcript</a>
            </>
          )}
        >
          <div>{HARNESS_LIST_LABEL}</div>
        </MemoryCardBrowser>
      ) : null}
      <button>Upgrade to Pro</button>
    </>
  );
}
void test("arrivals exclude initial loads, repeat polls, filter results and pagination", (t) => {
  t.after(cleanup);
  const props = {
    memories: [] as { id: string }[],
    scope: "all",
    /** @external memory arrivals hook contract */
    ready: false,
    pageCount: PAGE_COUNT_INITIAL,
  };
  const { result, rerender } = renderHook(useMemoryArrivals, { initialProps: props });
  rerender({ ...props, memories: [existing], ready: true, pageCount: PAGE_COUNT_SINGLE });
  assert.deepEqual(result.current.arrivingIds, []);
  rerender({ ...props, memories: [fresh, existing], ready: true, pageCount: PAGE_COUNT_SINGLE });
  assert.deepEqual(result.current.arrivingIds, ["fresh"]);
  act(() => result.current.onArrivalComplete("fresh"));
  rerender({ ...props, memories: [fresh, existing], ready: true, pageCount: PAGE_COUNT_SINGLE });
  assert.deepEqual(result.current.arrivingIds, []);
  rerender({
    ...props,
    memories: [fresh, existing, { id: "older-page" }],
    ready: true,
    pageCount: PAGE_COUNT_TWO,
  });
  assert.deepEqual(result.current.arrivingIds, []);
  rerender({
    ...props,
    memories: [fresh, existing],
    scope: "filtered",
    ready: false,
    pageCount: PAGE_COUNT_SINGLE,
  });
  rerender({
    ...props,
    memories: [{ id: "filtered-result" }],
    scope: "filtered",
    ready: true,
    pageCount: PAGE_COUNT_SINGLE,
  });
  assert.deepEqual(result.current.arrivingIds, []);
});
void test("new cards use the 1000ms sweep and 400ms reveal exactly once", (t) => {
  t.after(cleanup);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const screen = render(<Harness memories={[existing]} />);
  assert.equal(screen.container.querySelector(".is-entering"), null);
  screen.rerender(<Harness memories={[fresh, existing]} />);
  const card = () => screen.container.querySelector(".memory-snapshot-card.is-entering");
  assert.equal(card()?.getAttribute("data-memory-id"), "fresh");
  assert.notEqual(card()?.querySelector(".memory-card-organic-shimmer-wave"), null);
  assert.notEqual(card()?.querySelector(".memory-card-reveal-content[inert]"), null);
  act(() => t.mock.timers.tick(MS_BEFORE_REVEAL_TICK));
  assert.ok(!(card()?.classList.contains("is-revealing") ?? false));
  act(() => t.mock.timers.tick(REVEAL_EDGE_TICK_MS));
  assert.ok(card()?.classList.contains("is-revealing") === true);
  assert.equal(card()?.querySelector(".memory-card-reveal-content[inert]"), null);
  act(() => t.mock.timers.tick(REVEAL_DURATION_MS));
  assert.equal(card(), null);
  assert.equal(screen.container.querySelector(".memory-card-organic-shimmer"), null);
  screen.rerender(<Harness memories={[fresh, existing]} />);
  assert.equal(card(), null);
});
void test("first processed memory animates after an empty browser", (t) => {
  t.after(cleanup);
  const screen = render(<Harness memories={[]} />);
  screen.rerender(<Harness memories={[fresh]} />);
  assert.equal(screen.container.querySelector(".is-entering")?.getAttribute("data-memory-id"), "fresh");
});
void test("switching to list cancels arrival without replaying it", (t) => {
  t.after(cleanup);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const screen = render(<Harness memories={[existing]} />);
  screen.rerender(<Harness memories={[fresh, existing]} />);
  assert.notEqual(screen.container.querySelector(".is-entering"), null);
  screen.rerender(<Harness memories={[fresh, existing]} mode="list" />);
  act(() => t.mock.timers.tick(MODE_SWITCH_CANCEL_WAIT_MS));
  screen.rerender(<Harness memories={[fresh, existing]} />);
  assert.equal(screen.container.querySelector(".is-entering"), null);
  assert.notEqual(screen.getByText(fresh.title), null);
});
void test("reduced motion shows new content immediately without a shimmer", (t) => {
  t.after(cleanup);
  const matchMedia = window.matchMedia.bind(window);
  t.mock.method(window, "matchMedia", (query: string) => {
    const result = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(result, "matches", { value: true });
    }

    return result;
  });
  const screen = render(<Harness memories={[existing]} />);
  screen.rerender(<Harness memories={[fresh, existing]} />);
  assert.notEqual(screen.getByText(fresh.title), null);
  assert.equal(screen.container.querySelector(".is-entering"), null);
  assert.equal(screen.container.querySelector(".memory-card-organic-shimmer"), null);
});

void test("a batch reveals once and consumes every arrival, including cards visited later", (t) => {
  t.after(cleanup);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const frames = { next: (() => {}) as FrameRequestCallback };
  t.mock.method(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.next = callback;

    return REQUEST_ANIMATION_FRAME_HANDLE;
  });
  t.mock.method(globalThis, "cancelAnimationFrame", () => {});
  const second = { ...fresh, id: "second", title: "Second new memory" };
  const third = { ...fresh, id: "third", title: "Third new memory" };
  const memories = [fresh, second, third, existing];
  const screen = render(<Harness memories={[existing]} />);
  screen.rerender(<Harness memories={memories} />);
  assert.equal(screen.container.querySelector(".is-entering")?.getAttribute("data-memory-id"), fresh.id);
  assert.equal(screen.getByTestId("pending").textContent, fresh.id);
  act(() => t.mock.timers.tick(BATCH_SWEEP_WAIT_MS));
  assert.equal(screen.getByTestId("pending").textContent, "");
  [second, third].forEach((memory) => {
    fireEvent.click(screen.getByRole("button", { name: `Open memory: ${memory.title}` }));
    Array.from({ length: VISIT_ANIMATION_FRAME_COUNT }, (_, frame) => frame).forEach((frame) => {
      act(() => frames.next(performance.now() + frame * VISIT_FRAME_DELTA_MS));
    });
    assert.notEqual(screen.getByText(memory.title), null);
    assert.equal(screen.container.querySelector(".is-entering"), null);
  });
});

void test("a batch received in list mode does not replay when switching to cards", (t) => {
  t.after(cleanup);
  const memories = [fresh, { ...fresh, id: "second" }, existing];
  const screen = render(<Harness memories={[existing]} mode="list" />);
  screen.rerender(<Harness memories={memories} mode="list" />);
  assert.equal(screen.getByTestId("pending").textContent, "");
  screen.rerender(<Harness memories={memories} />);
  assert.equal(screen.container.querySelector(".is-entering"), null);
});

void test("arrow keys respect focused controls while still navigating from the page", (t) => {
  t.after(cleanup);
  const matchMedia = window.matchMedia.bind(window);
  t.mock.method(window, "matchMedia", (query: string) => {
    const result = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(result, "matches", { value: true });
    }

    return result;
  });
  const screen = render(<Harness memories={[fresh, existing]} />);
  const controls = [
    screen.getByRole("link", { name: "View transcript" }),
    screen.getByRole("button", { name: "Upgrade to Pro" }),
    screen.getByRole("button", { name: "Go to an older memory" }),
  ];
  controls.forEach((control) => {
    control.focus();
    ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].forEach((key) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      fireEvent(control, event);
      assert.equal(event.defaultPrevented, false);
      assert.equal(document.activeElement, control);
      assert.notEqual(screen.getByText(fresh.title), null);
    });
  });
  const lastControl = controls.at(-1);
  if (lastControl === undefined) {
    throw new Error(MISSING_NAVIGATION_CONTROL_ERROR);
  }
  lastControl.blur();
  fireEvent.keyDown(document.body, { key: "ArrowUp" });
  assert.notEqual(screen.getByText(existing.title), null);
  fireEvent.keyDown(document.body, { key: "ArrowDown" });
  assert.notEqual(screen.getByText(fresh.title), null);
});

void test("near-end pagination waits for explicit retry after a failed page load", (t) => {
  t.after(cleanup);
  const loadMore = t.mock.fn();
  const view = ({
    isLoadMoreFailed,
    isLoadingMore = false,
  }: {
    isLoadMoreFailed: boolean;
    isLoadingMore?: boolean;
  }) => (
    <MemoryCardBrowser
      memories={[existing]}
      arrivingIds={[]}
      onArrivalComplete={() => {}}
      mode="stack"
      onModeChange={() => {}}
      disabled={false}
      hasMore
      loadingMore={isLoadingMore}
      loadMoreFailed={isLoadMoreFailed}
      loadMore={loadMore}
      renderCard={({ memory }) => <div>{memory.title}</div>}
    >
      <div>{HARNESS_LIST_LABEL}</div>
    </MemoryCardBrowser>
  );
  const screen = render(view({ isLoadMoreFailed: false }));
  assert.equal(loadMore.mock.callCount(), 1, "Load the next page when approaching the end");
  screen.rerender(view({ isLoadMoreFailed: false, isLoadingMore: true }));
  screen.rerender(view({ isLoadMoreFailed: true }));
  assert.equal(loadMore.mock.callCount(), 1, "Finishing a failed request must not trigger another");
  assert.notEqual(screen.getByRole("alert"), null);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.equal(loadMore.mock.callCount(), LOAD_MORE_EXPECTED_AFTER_RETRY);
  screen.rerender(view({ isLoadMoreFailed: true, isLoadingMore: true }));
  const tryAgainButton = screen.getByRole("button", { name: "Try again" });
  assert.equal(tryAgainButton instanceof HTMLButtonElement ? tryAgainButton.disabled : undefined, true);
  screen.rerender(view({ isLoadMoreFailed: true }));
  assert.equal(loadMore.mock.callCount(), LOAD_MORE_EXPECTED_AFTER_RETRY, "A failed manual retry also remains stopped");
  screen.rerender(view({ isLoadMoreFailed: false }));
  assert.equal(
    loadMore.mock.callCount(),
    LOAD_MORE_EXPECTED_AFTER_RECOVERY,
    "Automatic pagination resumes after recovery",
  );
});

function touch(...touchArgs: [Element, string, number, number?, boolean?]) {
  const [target, type, x, y = TOUCH_DEFAULT_Y, isPrimary = true] = touchArgs;
  const event = new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: isPrimary ? POINTER_ID_PRIMARY : POINTER_ID_SECONDARY,
    pointerType: "touch",
    isPrimary,
    clientX: x,
    clientY: y,
  });
  fireEvent(target, event);

  return event;
}

void test("touch swipes navigate both ways with reduced motion, while taps, controls and vertical scrolling remain native", (t) => {
  t.after(cleanup);
  const matchMedia = window.matchMedia.bind(window);
  t.mock.method(window, "matchMedia", (query: string) => {
    const result = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(result, "matches", { value: true });
    }

    return result;
  });
  const screen = render(<Harness memories={[fresh, existing]} />);
  const stage = screen.container.querySelector(".memory-card-stage");
  if (stage === null) {
    throw new Error(MISSING_MEMORY_CARD_STAGE_ERROR);
  }
  const swipe = ({ from, to }: { from: number; to: number }) => {
    touch(stage, "pointerdown", from);
    touch(stage, "pointermove", to);
    touch(stage, "pointerup", to);
  };
  touch(stage, "pointerdown", TOUCH_X_CENTER);
  assert.equal(touch(stage, "pointermove", TOUCH_X_SLIGHT, TOUCH_Y_SCROLL).defaultPrevented, false);
  touch(stage, "pointerup", TOUCH_X_SLIGHT, TOUCH_Y_SCROLL);
  assert.notEqual(screen.getByText(fresh.title), null);
  swipe({ from: TOUCH_X_CENTER, to: TOUCH_X_MICRO_SWIPE });
  assert.notEqual(screen.getByText(fresh.title), null);
  const link = screen.getByRole("link", { name: "View transcript" });
  touch(link, "pointerdown", TOUCH_X_CENTER);
  touch(link, "pointermove", TOUCH_X_EDGE);
  touch(link, "pointerup", TOUCH_X_EDGE);
  assert.notEqual(screen.getByText(fresh.title), null);
  touch(stage, "pointerdown", TOUCH_X_CENTER);
  touch(stage, "pointermove", TOUCH_X_EDGE);
  assert.notEqual(screen.getByText(fresh.title), null, "reduced motion waits for release");
  touch(stage, "pointerup", TOUCH_X_EDGE);
  assert.notEqual(screen.getByText(existing.title), null);
  assert.equal(fireEvent.click(stage), false, "a completed drag must not activate a card");
  swipe({ from: TOUCH_X_CENTER, to: TOUCH_X_EDGE });
  assert.notEqual(screen.getByText(existing.title), null, "oldest boundary is clamped");
  swipe({ from: TOUCH_X_EDGE, to: TOUCH_X_CENTER });
  assert.notEqual(screen.getByText(fresh.title), null);
  swipe({ from: TOUCH_X_EDGE, to: TOUCH_X_CENTER });
  assert.notEqual(screen.getByText(fresh.title), null, "newest boundary is clamped");
});

void test("touch drag tracks the current stack position, cancellation restores it, and release settles to the next card", (t) => {
  t.after(cleanup);
  const frames = { next: (() => {}) as FrameRequestCallback };
  t.mock.method(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.next = callback;

    return REQUEST_ANIMATION_FRAME_HANDLE;
  });
  t.mock.method(globalThis, "cancelAnimationFrame", () => {});
  const screen = render(<Harness memories={[fresh, existing]} />);
  const stage = screen.container.querySelector(".memory-card-stage");
  if (stage === null) {
    throw new Error(MISSING_MEMORY_CARD_STAGE_ERROR);
  }
  const front = () => {
    const card = screen.container.querySelector('[data-memory-id="fresh"]');
    if (card === null) {
      throw new Error(MISSING_FRONT_MEMORY_CARD_ERROR);
    }
    if (!(card instanceof HTMLElement)) {
      throw new Error(MISSING_FRONT_MEMORY_CARD_ERROR);
    }

    return card;
  };
  const settle = () => {
    const now = performance.now();
    Array.from({ length: SETTLE_ANIMATION_FRAME_COUNT }, (_, index) => index + 1).forEach((frame) => {
      act(() => frames.next(now + frame * SETTLE_FRAME_DELTA_MS));
    });
  };
  touch(stage, "pointerdown", TOUCH_X_CENTER);
  touch(stage, "pointermove", TOUCH_X_DRAG);
  assert.notEqual(screen.container.querySelector(".is-ruler-traveling"), null);
  assert.ok(front().style.transform.includes("scale(1."), "card follows the finger before release");
  touch(stage, "pointercancel", TOUCH_X_DRAG);
  settle();
  assert.notEqual(screen.getByText(fresh.title), null);
  assert.equal(screen.container.querySelector(".is-ruler-traveling"), null);
  touch(stage, "pointerdown", TOUCH_X_CENTER);
  touch(stage, "pointermove", TOUCH_X_DRAG);
  touch(stage, "pointerdown", TOUCH_X_SECOND_POINTER, TOUCH_DEFAULT_Y, false);
  settle();
  assert.notEqual(screen.getByText(fresh.title), null, "a second finger cancels card navigation");
  touch(stage, "pointerdown", TOUCH_X_CENTER);
  touch(stage, "pointermove", TOUCH_X_NAVIGATE);
  touch(stage, "pointerup", TOUCH_X_NAVIGATE);
  settle();
  assert.notEqual(screen.getByText(existing.title), null);
  assert.equal(screen.container.querySelector(".is-ruler-traveling"), null);
});

void test("bounded forward and backward pages stay quiet while real arrivals still animate", (t) => {
  t.after(cleanup);
  const rows = Array.from({ length: BOUNDED_ROW_TOTAL }, (_, id) => ({ id: String(id) }));
  const props = {
    memories: rows.slice(0, BOUNDED_ROW_PAGE_SIZE),
    scope: "all",
    /** @external memory arrivals hook contract */
    ready: true,
    pageCount: BOUNDED_PAGE_COUNT,
    pageWindow: "0-19",
  };
  const { result, rerender } = renderHook(useMemoryArrivals, { initialProps: props });
  rerender({ ...props, memories: rows.slice(BOUNDED_PAGE_OVERLAP), pageWindow: "1-20" });
  assert.deepEqual(result.current.arrivingIds, []);
  rerender(props);
  assert.deepEqual(result.current.arrivingIds, []);
  rerender({ ...props, memories: [{ id: "newly-generated" }, ...props.memories] });
  assert.deepEqual(result.current.arrivingIds, ["newly-generated"]);
});
