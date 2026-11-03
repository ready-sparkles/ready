import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fireEvent, render } from "@testing-library/react";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import assert from "node:assert/strict";
import test from "node:test";

import { PublicTopbar } from "../../../presentation/components/public-topbar";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const PUBLIC_TOPBAR_TEST_COPY = {
  resourcesSummaryMissing: "Resources summary is missing",
  mobileNavigationMissing: "Mobile navigation menu is missing",
  missingNavigationLinkPrefix: "Missing navigation link",
} as const;

function setup() {
  const view = render(
    <PathnameContext.Provider value="/">
      <PublicTopbar />
    </PathnameContext.Provider>,
  );
  const summary = view.getByText("Resources").closest("summary");
  if (summary === null) {
    throw new Error(PUBLIC_TOPBAR_TEST_COPY.resourcesSummaryMissing);
  }
  const menu = summary.parentElement;
  if (!(menu instanceof HTMLDetailsElement)) {
    throw new Error(PUBLIC_TOPBAR_TEST_COPY.resourcesSummaryMissing);
  }

  return { view, summary, menu };
}

void test("hover then click keeps Resources open, without swallowing subsequent clicks", () => {
  const { view, summary, menu } = setup();
  try {
    fireEvent.pointerOver(summary, { pointerType: "mouse" });
    assert.equal(menu.open, true);
    assert.equal(fireEvent.click(summary, { detail: 1 }), false, "cancel the native close on the first click");
    // Happy DOM toggles details before dispatch, so verify cancellation here;
    // the actual open state after the click is checked in the browser.
    assert.equal(fireEvent.click(summary, { detail: 1 }), true, "subsequent clicks retain native toggling");
  } finally {
    view.unmount();
  }
});

void test("keyboard and touch activation retain native behavior", () => {
  const { view, summary, menu } = setup();
  try {
    fireEvent.pointerOver(summary, { pointerType: "touch" });
    assert.equal(menu.open, false);
    assert.equal(fireEvent.click(summary, { detail: 1 }), true);
    fireEvent.pointerOver(summary, { pointerType: "mouse" });
    assert.equal(fireEvent.click(summary, { detail: 0 }), true);
    fireEvent.keyDown(summary, { key: "Escape" });
    assert.equal(menu.open, false);
  } finally {
    view.unmount();
  }
});

void test("mobile navigation exposes each destination directly and closes after selection", () => {
  (
    [
      ["Pricing", "/pricing"],
      ["About", "/about"],
      ["Updates", "/updates"],
      ["Sign in", "/login"],
    ] as const
  ).forEach(([label, href]) => {
    const { view } = setup();
    try {
      fireEvent.click(view.getByRole("button", { name: "Open navigation menu" }));
      const mobile = view.container.querySelector("#public-home-mobile-menu");
      if (mobile === null) {
        throw new Error(PUBLIC_TOPBAR_TEST_COPY.mobileNavigationMissing);
      }
      assert.equal(mobile.querySelector("details"), null);
      assert.deepEqual(
        [...mobile.querySelectorAll("a")].map((link) => link.textContent),
        ["Sign in", "Pricing", "About", "Updates"],
      );
      const link = [...mobile.querySelectorAll("a")].find((candidate) => candidate.textContent === label);
      if (link === undefined) {
        const message = `${PUBLIC_TOPBAR_TEST_COPY.missingNavigationLinkPrefix} ${label}`;
        throw new Error(message);
      }
      assert.equal(link.getAttribute("href"), href);
      fireEvent.click(link);
      assert.equal(view.container.querySelector("#public-home-mobile-menu"), null);
      assert.equal(document.body.style.overflow, "");
    } finally {
      view.unmount();
    }
  });
});

void test("Escape closes mobile navigation and returns focus to its button", () => {
  const { view } = setup();
  try {
    const trigger = view.getByRole("button", { name: "Open navigation menu" });
    fireEvent.click(trigger);
    assert.equal(document.body.style.overflow, "hidden");
    fireEvent.keyDown(window, { key: "Escape" });
    assert.equal(view.container.querySelector("#public-home-mobile-menu"), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(document.body.style.overflow, "");
  } finally {
    view.unmount();
  }
});

void test("topbar shrinks only two-digit day numerals", (context) => {
  const singleDigitDay = 9;
  const firstTwoDigitDay = 10;
  const lastDay = 31;
  [singleDigitDay, firstTwoDigitDay, lastDay].forEach((day) => {
    const dateMock = context.mock.method(Date.prototype, "getDate", () => day);
    const { view } = setup();
    try {
      const numeral = view.container.querySelector('.public-home-brand-logo > path[fill="#EFF6FF"]');
      assert.ok(numeral);
      assert.equal(
        numeral.getAttribute("transform"),
        day === singleDigitDay ? null : "translate(60 63.2) scale(0.9) translate(-60 -63.2)",
      );
    } finally {
      view.unmount();
      dateMock.mock.restore();
    }
  });
});
