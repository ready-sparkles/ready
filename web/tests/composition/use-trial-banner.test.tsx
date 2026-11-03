import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { useTrialBanner } from "../../composition/use-trial-banner";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TRIAL_OFFER_BUTTON_LABEL = "Trial offer";
const STORAGE_BLOCKED_MESSAGE = "Storage blocked";

function runTrialBannerAuthTest(isDismissed: boolean): void {
  void test(`trial banner waits for auth and dismissal preference (dismissed: ${isDismissed})`, () => {
    window.localStorage.clear();
    if (isDismissed) {
      window.localStorage.setItem("ready:beta-credit-card-dismissed:account", "1");
    }
    const frameState = { values: [] as boolean[] };
    function Banner({ userId, isLoading }: { userId: string | null; isLoading: boolean }) {
      const banner = useTrialBanner({ userId, isAuthLoading: isLoading });
      frameState.values = [...frameState.values, banner.visible];

      return banner.visible ? <button onClick={banner.dismiss}>{TRIAL_OFFER_BUTTON_LABEL}</button> : null;
    }
    const screen = render(<Banner userId={null} isLoading />);
    try {
      assert.deepEqual(frameState.values, [false]);
      screen.rerender(<Banner userId="account" isLoading />);
      assert.ok(frameState.values.every((isVisible) => !isVisible));
      frameState.values = [];
      screen.rerender(<Banner userId="account" isLoading={false} />);
      assert.equal(frameState.values[0], false, "the first resolved-auth render still waits for storage");
      if (isDismissed) {
        assert.ok(
          frameState.values.every((isVisible) => !isVisible),
          "a dismissed banner never renders, even briefly",
        );
        assert.equal(screen.queryByRole("button"), null);
      } else {
        fireEvent.click(screen.getByRole("button", { name: TRIAL_OFFER_BUTTON_LABEL }));
        assert.equal(screen.queryByRole("button"), null);
        assert.equal(window.localStorage.getItem("ready:beta-credit-card-dismissed:account"), "1");
      }
      frameState.values = [];
      screen.rerender(<Banner userId="recreated-account" isLoading={false} />);
      assert.equal(frameState.values[0], false);
      assert.notEqual(screen.queryByRole("button", { name: TRIAL_OFFER_BUTTON_LABEL }), null);
      frameState.values = [];
      screen.rerender(<Banner userId="account" isLoading={false} />);
      assert.ok(
        frameState.values.every((isVisible) => !isVisible),
        "switching back never borrows the other account’s visible state",
      );
    } finally {
      cleanup();
      window.localStorage.clear();
    }
  });
}

runTrialBannerAuthTest(true);
runTrialBannerAuthTest(false);

void test("a dismissal survives background auth refresh when browser storage is unavailable", (t) => {
  t.mock.method(window.localStorage, "getItem", () => {
    throw new Error(STORAGE_BLOCKED_MESSAGE);
  });
  t.mock.method(window.localStorage, "setItem", () => {
    throw new Error(STORAGE_BLOCKED_MESSAGE);
  });
  function Banner({ isLoading }: { isLoading: boolean }) {
    const banner = useTrialBanner({ userId: "account", isAuthLoading: isLoading });

    return banner.visible ? <button onClick={banner.dismiss}>{TRIAL_OFFER_BUTTON_LABEL}</button> : null;
  }
  const screen = render(<Banner isLoading={false} />);
  try {
    fireEvent.click(screen.getByRole("button", { name: TRIAL_OFFER_BUTTON_LABEL }));
    assert.equal(screen.queryByRole("button"), null);
    screen.rerender(<Banner isLoading />);
    screen.rerender(<Banner isLoading={false} />);
    assert.ok(screen.queryByRole("button") === null, "a background auth refresh must preserve the in-memory dismissal");
  } finally {
    cleanup();
  }
});
