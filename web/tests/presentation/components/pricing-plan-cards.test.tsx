import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { PricingPlanCards } from "../../../presentation/components/pricing-plan-cards";

GlobalRegistrator.register();
afterEach(cleanup);

void test("pricing shows all three plans and exact monthly and annual equivalents", () => {
  const props = { freeCtaLabel: "Start a trial", proCtaLabel: "Choose Pro" };
  const view = render(<PricingPlanCards {...props} planInterval="month" />);
  assert.deepEqual(
    view.getAllByRole("heading").map((heading) => heading.textContent),
    ["Free", "Pro", "Max"],
  );
  assert.equal(view.getByText("$25").isConnected, true);
  assert.equal(view.getByText("$120").isConnected, true);
  assert.equal(view.getByText("Everything in Pro").isConnected, true);
  assert.equal(view.getByText("Up to 10× as much AI usage as Pro*").isConnected, true);

  view.rerender(<PricingPlanCards {...props} planInterval="year" />);
  assert.equal(view.getByText("$17").isConnected, true);
  assert.equal(view.getByText("$100").isConnected, true);
});

void test("Max cannot trigger Pro checkout", (t) => {
  const onProCta = t.mock.fn();
  const view = render(
    <PricingPlanCards planInterval="month" freeCtaLabel="Current plan" proCtaLabel="Choose Pro" onProCta={onProCta} />,
  );
  const maxButton = view.getByRole("button", { name: "Choose Max" });
  assert.ok(maxButton.hasAttribute("disabled"));
  fireEvent.click(maxButton);
  assert.equal(onProCta.mock.callCount(), 0);
  fireEvent.click(view.getByRole("button", { name: "Choose Pro" }));
  assert.equal(onProCta.mock.callCount(), 1);
});

void test("Max links to signup when enabled on the public pricing page", () => {
  const view = render(
    <PricingPlanCards
      planInterval="month"
      freeCtaLabel="Start a trial"
      proCtaLabel="Choose Pro"
      maxCtaLabel="Start a trial"
      maxCtaHref="/signup"
    />,
  );
  assert.equal(view.getByRole("link", { name: "Start a trial" }).getAttribute("href"), "/signup");
});

void test("billing can enable Max without invoking the Pro checkout", (t) => {
  const onMaxCta = t.mock.fn(),
    onProCta = t.mock.fn();
  const view = render(
    <PricingPlanCards
      planInterval="month"
      freeCtaLabel="Current plan"
      proCtaLabel="Choose Pro"
      onProCta={onProCta}
      onMaxCta={onMaxCta}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Choose Max" }));
  assert.equal(onMaxCta.mock.callCount(), 1);
  assert.equal(onProCta.mock.callCount(), 0);
});
