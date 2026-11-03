import "../../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";

import { MemoryLoadMore } from "../../../presentation/components/memory-load-more";

const EXPECTED_LOAD_COUNT_AFTER_RETRY = 2;

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

class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = "0px";
  readonly thresholds: readonly number[] = [0];

  constructor(private readonly onDisconnect: () => void) {}

  disconnect(): void {
    this.onDisconnect();
  }

  observe(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(): void {}
}

after(async () => GlobalRegistrator.unregister());
void test("scroll sentinel preloads near the end, suspends while fetching, and requires retry after failure", (t) => {
  const observerState = {
    callback: undefined as IntersectionObserverCallback | undefined,
    disconnects: 0,
  };
  t.mock.method(globalThis, "IntersectionObserver", function (cb: IntersectionObserverCallback) {
    observerState.callback = cb;

    return new TestIntersectionObserver(() => {
      observerState.disconnects += 1;
    });
  });
  const loadState = { count: 0 };
  const load = () => {
    loadState.count += 1;
  };
  const screen = render(<MemoryLoadMore load={load} loading={false} failed={false} />);
  try {
    const callback = observerState.callback;
    assert.ok(callback);
    const observer = new TestIntersectionObserver(() => {});
    act(() => callback([createIntersectionObserverEntry({ isIntersecting: true })], observer));
    assert.equal(loadState.count, 1);
    screen.rerender(<MemoryLoadMore load={load} loading={true} failed={false} />);
    assert.equal(observerState.disconnects, 1);
    observerState.callback = undefined;
    screen.rerender(<MemoryLoadMore load={load} loading={false} failed={true} />);
    assert.equal(observerState.callback, undefined);
    fireEvent.click(screen.getByRole("button", { name: "Try loading more again" }));
    assert.equal(loadState.count, EXPECTED_LOAD_COUNT_AFTER_RETRY);
  } finally {
    cleanup();
  }
});
