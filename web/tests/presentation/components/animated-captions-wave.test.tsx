import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, render } from "@testing-library/react";
import assert from "node:assert/strict";
import { registerHooks, type ResolveHookSync } from "node:module";
import test from "node:test";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function createIntersectionObserverEntry(input: { isIntersecting: boolean }): IntersectionObserverEntry {
  return {
    boundingClientRect: new DOMRectReadOnly(0, 0, 0, 0),
    intersectionRatio: input.isIntersecting ? 1 : 0,
    intersectionRect: new DOMRectReadOnly(0, 0, 0, 0),
    isIntersecting: input.isIntersecting,
    rootBounds: null,
    target: document.createElement("div"),
    time: 0,
  };
}

// Only the static SVG is stubbed; animation lifecycle and React state are real.
const resolveLiveMeetingVisuals: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier !== "./live-meeting-visuals") {
    return nextResolve(specifier, context);
  }

  return { shortCircuit: true, url: "data:text/javascript,export const CaptionsWaveIcon = () => null;" };
};
const svgMock = registerHooks({ resolve: resolveLiveMeetingVisuals });
const { AnimatedCaptionsWave } = await import("../../../presentation/components/animated-captions-wave");
svgMock.deregister();

void test("frames stay in the icon and pause while inactive, hidden, offscreen, or reduced motion", (t) => {
  const mockReadLevel = 0.5;
  const animationTimerTickMs = 600;
  const expectedReadsAfterFirstAdvance = 10;
  const expectedParentRenders = 1;
  const expectedReadsAfterVisibility = 20;
  const expectedReadsAfterIntersection = 30;

  t.mock.timers.enable({ apis: ["setInterval"] });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  t.mock.method(window, "matchMedia", () => motion);
  const observerState: { callback?: IntersectionObserverCallback } = {};
  const originalObserver = globalThis.IntersectionObserver;
  class StubIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin = "0px";
    readonly thresholds: readonly number[] = [0];

    constructor(callback: IntersectionObserverCallback) {
      observerState.callback = callback;
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver = StubIntersectionObserver;
  const counts = { reads: 0, parentRenders: 0 };
  const readLevel = () => {
    counts.reads += 1;

    return mockReadLevel;
  };
  function Parent({ isActive = true, isEnabled = true, isError = false }) {
    counts.parentRenders += 1;

    return <AnimatedCaptionsWave isActive={isActive} isEnabled={isEnabled} isError={isError} readLevel={readLevel} />;
  }
  const view = render(<Parent />);
  const advance = () => act(() => t.mock.timers.tick(animationTimerTickMs));
  const expectPaused = () => {
    const before = counts.reads;
    advance();
    assert.equal(counts.reads, before);
  };
  const intersectionObserver = new StubIntersectionObserver(() => {});
  try {
    advance();
    assert.equal(counts.reads, expectedReadsAfterFirstAdvance);
    assert.equal(counts.parentRenders, expectedParentRenders);
    view.rerender(<Parent isActive={false} />);
    expectPaused();
    view.rerender(<Parent isEnabled={false} />);
    expectPaused();
    view.rerender(<Parent isError />);
    expectPaused();
    view.rerender(<Parent />);
    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expectPaused();
    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    advance();
    assert.equal(counts.reads, expectedReadsAfterVisibility);
    act(() =>
      observerState.callback?.([createIntersectionObserverEntry({ isIntersecting: false })], intersectionObserver),
    );
    expectPaused();
    act(() =>
      observerState.callback?.([createIntersectionObserverEntry({ isIntersecting: true })], intersectionObserver),
    );
    advance();
    assert.equal(counts.reads, expectedReadsAfterIntersection);
    act(() => {
      Object.defineProperty(motion, "matches", { configurable: true, value: true });
      motion.dispatchEvent(new Event("change"));
    });
    expectPaused();
    view.unmount();
    expectPaused();
  } finally {
    view.unmount();
    globalThis.IntersectionObserver = originalObserver;
  }
});
