import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { useMarketplaceBanner } from "../../composition/use-marketplace-banner";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const MARKETPLACE_BUTTON_LABEL = "Marketplace";
const TRIAL_SLOT_LABEL = "Trial";
const BLOCKED_STORAGE_MESSAGE = "Blocked";

function Banner({
  userId,
  loading: isLoading = false,
}: {
  userId: string | null;
  /** @external loading */ loading?: boolean;
}) {
  const banner = useMarketplaceBanner({ userId, isAuthLoading: isLoading });

  return banner.visible ? (
    <button onClick={banner.dismiss}>{MARKETPLACE_BUTTON_LABEL}</button>
  ) : banner.showTrial ? (
    <span>{TRIAL_SLOT_LABEL}</span>
  ) : null;
}

void test("dismissal hides the slot until refresh or a new sign-in, and is account scoped", () => {
  window.localStorage.clear();
  const screen = render(<Banner userId="google-user" loading />);
  try {
    assert.equal(screen.container.textContent, "");
    screen.rerender(<Banner userId="google-user" />);
    fireEvent.click(screen.getByRole("button", { name: MARKETPLACE_BUTTON_LABEL }));
    assert.equal(screen.container.textContent, "");
    screen.rerender(<Banner userId="google-user" loading />);
    screen.rerender(<Banner userId="google-user" />);
    assert.equal(screen.container.textContent, "", "background auth refresh must not reveal trial");
    screen.unmount();
    const refreshed = render(<Banner userId="google-user" />);
    assert.equal(refreshed.container.textContent, TRIAL_SLOT_LABEL);
    refreshed.rerender(<Banner userId="another-google-user" />);
    assert.equal(refreshed.container.textContent, MARKETPLACE_BUTTON_LABEL);
    fireEvent.click(refreshed.getByRole("button"));
    refreshed.rerender(<Banner userId={null} />);
    refreshed.rerender(<Banner userId="another-google-user" />);
    assert.equal(refreshed.container.textContent, TRIAL_SLOT_LABEL);
  } finally {
    cleanup();
    window.localStorage.clear();
  }
});

void test("missing accounts do not show the banner and blocked storage still permits dismissal", (t) => {
  const screen = render(<Banner userId={null} />);
  try {
    assert.equal(screen.container.textContent, TRIAL_SLOT_LABEL);
    t.mock.method(window.localStorage, "getItem", () => {
      throw new Error(BLOCKED_STORAGE_MESSAGE);
    });
    t.mock.method(window.localStorage, "setItem", () => {
      throw new Error(BLOCKED_STORAGE_MESSAGE);
    });
    screen.rerender(<Banner userId="google-user" />);
    fireEvent.click(screen.getByRole("button"));
    screen.rerender(<Banner userId="google-user" loading />);
    screen.rerender(<Banner userId="google-user" />);
    assert.equal(screen.container.textContent, "");
  } finally {
    cleanup();
  }
});
