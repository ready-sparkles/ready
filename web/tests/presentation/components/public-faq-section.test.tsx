import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { PublicFaqSection } from "../../../presentation/components/public-faq-section";

GlobalRegistrator.register({ url: "http://localhost:3000/pricing" });
afterEach(cleanup);

const ITEMS = [{ id: "usage", question: "What does usage mean?", answer: "AI work measured in credits." }];

void test("usage link opens, focuses, and scrolls to its FAQ, including after it is closed again", (t) => {
  const scroll = t.mock.method(HTMLElement.prototype, "scrollIntoView", () => undefined);
  const view = render(
    <>
      <a href="/pricing#usage">Usage limits</a>
      <PublicFaqSection id="pricing-faq" items={ITEMS} initiallyOpen={0} />
    </>,
  );
  const question = view.getByRole("button", { name: "What does usage mean?" });
  const link = view.getByRole("link", { name: "Usage limits" });
  fireEvent.click(link);
  assert.equal(question.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, question);
  assert.equal(scroll.mock.callCount(), 1);
  fireEvent.click(question);
  assert.equal(question.getAttribute("aria-expanded"), "false");
  fireEvent.click(link);
  assert.equal(question.getAttribute("aria-expanded"), "true");
});

void test("a direct usage fragment opens the FAQ on arrival", () => {
  window.history.replaceState(null, "", "/pricing#usage");
  const view = render(<PublicFaqSection id="pricing-faq" items={ITEMS} initiallyOpen={0} />);
  assert.equal(view.getByRole("button", { name: "What does usage mean?" }).getAttribute("aria-expanded"), "true");
  window.history.replaceState(null, "", "/pricing");
});
