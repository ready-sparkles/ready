import "../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MemoryPerson } from "@readymeet/shared";
import { cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import React, { useMemo, useRef } from "react";

import { useMemoryPeopleScrollAnchor } from "../../composition/use-memory-people-scroll-anchor";

const TEST_VALUE_1000 = 1000;
const TEST_VALUE_1100 = 1100;
const TEST_VALUE_20 = 20;
const TEST_VALUE_32 = 32;
const TEST_VALUE_50 = 50;
const TEST_VALUE_600 = 600;
const TEST_VALUE_940 = 940;
const TEST_VALUE_990 = 990;

after(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});
const people = Array.from({ length: TEST_VALUE_1100 }, (_, id) => ({
  id: String(id),
  name: String(id),
  lastContact: "2026-01-01",
  categories: [],
}));
function Window({ start }: { start: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const groups = useMemo<[string, MemoryPerson[]][]>(
    () => [["January", people.slice(start, start + TEST_VALUE_1000)]],
    [start],
  );
  useMemoryPeopleScrollAnchor({ listRef: ref, groups, rowHeight: TEST_VALUE_32 });

  return (
    <div className="relationship-memory-content">
      <div ref={ref}>
        {Array.from({ length: TEST_VALUE_20 }, (_, index) => (
          <ol key={index} data-people-group-index="0" data-chunk={index} />
        ))}
      </div>
    </div>
  );
}

void test("evicting and prepending People pages preserves the visible person and moves the bottom sentinel away", (t) => {
  t.mock.method(HTMLElement.prototype, "getBoundingClientRect", function (this: HTMLElement) {
    const closestScroller = this.closest(".relationship-memory-content");
    if (!(closestScroller instanceof HTMLElement)) {
      assert.fail("expected .relationship-memory-content ancestor to be an HTMLElement");
    }
    const scroller = closestScroller;

    const top =
      this.dataset.chunk !== undefined && this.dataset.chunk !== ""
        ? Number(this.dataset.chunk) * TEST_VALUE_50 * TEST_VALUE_32 - scroller.scrollTop
        : 0;

    return new DOMRect(0, top, TEST_VALUE_600, TEST_VALUE_32);
  });
  const view = render(<Window start={0} />);
  const firstChild = view.container.firstElementChild;
  if (!(firstChild instanceof HTMLElement)) {
    assert.fail("expected container firstElementChild to be an HTMLElement");
  }
  const scroller = firstChild;
  scroller.scrollTop = TEST_VALUE_990 * TEST_VALUE_32;
  fireEvent.scroll(scroller);
  view.rerender(<Window start={TEST_VALUE_50} />);
  assert.equal(scroller.scrollTop, TEST_VALUE_940 * TEST_VALUE_32);
  view.rerender(<Window start={0} />);
  assert.equal(scroller.scrollTop, TEST_VALUE_990 * TEST_VALUE_32);
  view.unmount();
});
