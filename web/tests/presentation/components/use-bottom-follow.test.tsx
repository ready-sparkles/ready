import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fireEvent, render, waitFor } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import { useRef } from "react";

import { useBottomFollow } from "../../../presentation/components/use-bottom-follow";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SCROLL_HEIGHT = 960;
const PANE_CLIENT_HEIGHT = 480;
const OBSERVED_SCROLL_HEIGHT = 1160;
const DEFAULT_INITIAL_SCROLL_TOP = 480;
const USER_SCROLL_TOP_AFTER_SCROLL_UP = 300;
const MANUAL_CONTAINER_SCROLL_TOP = 680;
const VISIBLE_CONTENT_END_BOTTOM = 280;
const SMOOTH_SCROLL_TO_TOP = 480;

function paneViewportRect(): DOMRect {
  return new DOMRect(0, 0, 0, PANE_CLIENT_HEIGHT);
}

function contentEndRectForScrollTop(scrollTop: number): DOMRect {
  return new DOMRect(0, 0, 0, SCROLL_HEIGHT - scrollTop);
}

function contentEndRectAt(bottom: number): DOMRect {
  return new DOMRect(0, 0, 0, bottom);
}

function BottomFollowHarness({ onContainerScroll }: { onContainerScroll: (options: ScrollToOptions) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useBottomFollow({ isActive: true, containerRef });

  return (
    <div
      ref={(node) => {
        containerRef.current = node;
        if (!node) {
          return;
        }

        const scrollHost = node;
        Object.defineProperties(scrollHost, {
          scrollHeight: { configurable: true, value: SCROLL_HEIGHT },
          clientHeight: { configurable: true, value: PANE_CLIENT_HEIGHT },
          scrollTo: {
            configurable: true,
            value: (options: ScrollToOptions) => onContainerScroll(options),
          },
        });
      }}
    />
  );
}

function ObservedBottomFollowHarness({
  onContainerScroll,
  initialScrollTop = DEFAULT_INITIAL_SCROLL_TOP,
}: {
  onContainerScroll: (options: ScrollToOptions) => void;
  initialScrollTop?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentEndRef = useRef<HTMLDivElement | null>(null);
  const bottomFollow = useBottomFollow({
    isActive: false,
    containerRef,
    contentEndRef,
    shouldObserveWhenInactive: true,
  });

  return (
    <>
      <div
        data-testid="scroll-pane"
        ref={(node) => {
          containerRef.current = node;
          if (!node) {
            return;
          }

          const scrollHost = node;
          Object.defineProperties(scrollHost, {
            scrollHeight: { configurable: true, value: OBSERVED_SCROLL_HEIGHT },
            clientHeight: { configurable: true, value: PANE_CLIENT_HEIGHT },
            scrollTop: { configurable: true, writable: true, value: initialScrollTop },
            getBoundingClientRect: {
              configurable: true,
              value: () => paneViewportRect(),
            },
            scrollTo: {
              configurable: true,
              value: (options: ScrollToOptions) => onContainerScroll(options),
            },
          });
        }}
      />
      <div
        data-testid="content-end"
        ref={(node) => {
          contentEndRef.current = node;
          if (!node) {
            return;
          }

          const contentEndHost = node;
          Object.defineProperty(contentEndHost, "getBoundingClientRect", {
            configurable: true,
            value: () => {
              const scrollTop = containerRef.current?.scrollTop ?? 0;

              return contentEndRectForScrollTop(scrollTop);
            },
          });
        }}
      />
      {bottomFollow.isUserAwayFromBottom ? (
        <button type="button" onClick={() => bottomFollow.scrollToBottom()}>
          Latest
        </button>
      ) : null}
    </>
  );
}

function ManualBottomFollowHarness({ onContainerScroll }: { onContainerScroll: (options: ScrollToOptions) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentEndRef = useRef<HTMLDivElement | null>(null);
  const bottomFollow = useBottomFollow({
    isActive: false,
    containerRef,
    contentEndRef,
    shouldObserveWhenInactive: true,
  });

  return (
    <>
      <div
        ref={(node) => {
          containerRef.current = node;
          if (!node) {
            return;
          }
          const scrollHost = node;
          Object.defineProperties(scrollHost, {
            scrollTop: { configurable: true, writable: true, value: MANUAL_CONTAINER_SCROLL_TOP },
            getBoundingClientRect: {
              configurable: true,
              value: () => paneViewportRect(),
            },
            scrollTo: {
              configurable: true,
              value: (options: ScrollToOptions) => onContainerScroll(options),
            },
          });
        }}
      />
      <div
        ref={(node) => {
          contentEndRef.current = node;
          if (node) {
            const contentEndHost = node;
            Object.defineProperty(contentEndHost, "getBoundingClientRect", {
              configurable: true,
              value: () => contentEndRectAt(VISIBLE_CONTENT_END_BOTTOM),
            });
          }
        }}
      />
      <button type="button" onClick={() => bottomFollow.followLatestContent()}>
        Follow next row
      </button>
    </>
  );
}

void test("bottom follow scrolls the supplied pane instead of the browser window", () => {
  const scrolls: ScrollToOptions[] = [];
  const containerScrollCapture = { scrolls };
  const windowScrolls = { count: 0 };
  const originalWindowScrollTo = window.scrollTo.bind(window);
  window.scrollTo = () => {
    windowScrolls.count += 1;
  };

  const view = render(
    <BottomFollowHarness
      onContainerScroll={(options) => {
        containerScrollCapture.scrolls = [...containerScrollCapture.scrolls, options];
      }}
    />,
  );

  assert.deepEqual(containerScrollCapture.scrolls, [{ top: SCROLL_HEIGHT, behavior: "auto" }]);
  assert.equal(windowScrolls.count, 0);

  view.unmount();
  window.scrollTo = originalWindowScrollTo;
});

void test("observing a completed document exposes a return control after the user scrolls up", () => {
  const scrolls: ScrollToOptions[] = [];
  const containerScrollCapture = { scrolls };
  const view = render(
    <ObservedBottomFollowHarness
      onContainerScroll={(options) => {
        containerScrollCapture.scrolls = [...containerScrollCapture.scrolls, options];
      }}
    />,
  );
  const pane = view.getByTestId("scroll-pane");

  fireEvent.scroll(pane);
  assert.equal(view.queryByRole("button", { name: "Latest" }), null);

  pane.scrollTop = USER_SCROLL_TOP_AFTER_SCROLL_UP;
  fireEvent.scroll(pane);

  fireEvent.click(view.getByRole("button", { name: "Latest" }));
  assert.deepEqual(containerScrollCapture.scrolls, [{ top: SMOOTH_SCROLL_TO_TOP, behavior: "smooth" }]);
  assert.equal(view.queryByRole("button", { name: "Latest" }), null);
  view.unmount();
});

void test("a newly mounted document measures whether its content end is visible", async () => {
  const view = render(<ObservedBottomFollowHarness initialScrollTop={0} onContainerScroll={() => undefined} />);

  await waitFor(() => {
    view.getByRole("button", { name: "Latest" });
  });
  view.unmount();
});

void test("auto-follow never pulls upward when the content end is already visible", () => {
  const scrolls: ScrollToOptions[] = [];
  const containerScrollCapture = { scrolls };
  const view = render(
    <ManualBottomFollowHarness
      onContainerScroll={(options) => {
        containerScrollCapture.scrolls = [...containerScrollCapture.scrolls, options];
      }}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Follow next row" }));
  assert.deepEqual(containerScrollCapture.scrolls, []);
  view.unmount();
});
