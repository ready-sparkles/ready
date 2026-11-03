import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { createAmbientContextItem } from "../../../domain/testing/ambient-context-fixture";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { AmbientContextPill } = await import("../../../presentation/components/ambient-context-pill");

const item = createAmbientContextItem();
const AMBIENT_CONTEXT_PILL_TEST_COPY = {
  expectedButtonType: "Expected ambient context pill control to be a button",
} as const;

const GLOW_ANIMATION_WAIT_MS = 540;
const WEB_SEARCH_UPDATED_AT_OFFSET_MS = 1000;
const RERENDER_STRESS_ITERATIONS = 100;

void test("loading pill opens its subject and updates without remounting or fading the name", () => {
  const selected: { value: string | null } = { value: null };
  const props = {
    webSearchState: null,
    imageUrls: {},
    isVisible: true,
    isOpen: false,
    onClick: (key: string) => {
      selected.value = key;
    },
  };
  const view = render(<AmbientContextPill {...props} items={[item]} />);
  const button = view.getByRole("button", { name: "Linear. Researching. Open relevant details." });
  fireEvent.click(button);
  assert.equal(selected.value, `ambient:${item.id}`);
  (["researching", "ready"] as const).forEach((status) => {
    view.rerender(
      <AmbientContextPill
        {...props}
        items={[{ ...item, status, summary: status === "ready" ? "Product planning software." : null }]}
      />,
    );
    assert.equal(view.getByRole("button"), button);
    assert.ok(button.querySelector(".live-ambient-context-pill-content.is-visible"));
    assert.equal(button.textContent.includes("Linear"), true);
  });
  assert.equal(button.getAttribute("aria-label"), "Linear. Open relevant details.");
  assert.equal(button.classList.contains("is-result"), true);
  view.unmount();
});

void test("failure and expiry animate out before removing the pill and block outgoing clicks", async () => {
  await [[{ ...item, status: "failed" as const }], []].reduce(async (previous, remainingItems) => {
    await previous;
    const clicks = { count: 0 };
    const props = {
      webSearchState: null,
      imageUrls: {},
      isVisible: true,
      isOpen: false,
      onClick: () => {
        clicks.count += 1;
      },
    };
    const view = render(<AmbientContextPill {...props} items={[item]} />);
    const button = view.getByRole("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(AMBIENT_CONTEXT_PILL_TEST_COPY.expectedButtonType);
    }
    await waitFor(() =>
      assert.equal(
        view.container.querySelector<HTMLElement>(".live-ambient-context-pill-positioner")?.style.opacity,
        "1",
      ),
    );
    view.rerender(<AmbientContextPill {...props} items={remainingItems} />);
    assert.equal(button.isConnected, true, "exit keeps the outgoing pill mounted");
    assert.equal(button.disabled, true);
    fireEvent.click(button);
    assert.equal(clicks.count, 0);
    await waitFor(() => assert.equal(Boolean(view.container.querySelector("button")), false), {
      mutationObserverOptions: { childList: true, subtree: true },
    });
    view.unmount();
  }, Promise.resolve());
});

void test("glow accompanies a displayed answer, not a pending name or return to an older answer", async () => {
  const props = { webSearchState: null, imageUrls: {}, isVisible: true, isOpen: false, onClick: () => {} };
  const view = render(<AmbientContextPill {...props} items={[item]} />);
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
  const ready = { ...item, status: "ready" as const, summary: "Product planning software." };
  view.rerender(<AmbientContextPill {...props} items={[ready]} />);
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), true);
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, GLOW_ANIMATION_WAIT_MS);
    });
  });
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
  const next = { ...item, id: "next", displayName: "Ramp", lastMentionedAt: "2026-09-25T10:01:00Z" };
  view.rerender(<AmbientContextPill {...props} items={[next, ready]} />);
  await waitFor(() => assert.equal(view.getByRole("button").textContent.includes("Ramp"), true));
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
  view.rerender(<AmbientContextPill {...props} items={[{ ...next, status: "failed" }, ready]} />);
  await waitFor(() => assert.equal(view.getByRole("button").textContent.includes("Linear"), true));
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
  view.unmount();
});

void test("a newer completed voice result takes priority over an older loading mention", () => {
  const selected: { value: string | null } = { value: null };
  const view = render(
    <AmbientContextPill
      items={[item]}
      imageUrls={{}}
      isVisible
      isOpen={false}
      webSearchState={{
        key: "web-search:result-1",
        label: "Events tomorrow",
        updatedAt: Date.parse(item.lastMentionedAt) + WEB_SEARCH_UPDATED_AT_OFFSET_MS,
      }}
      onClick={(key) => {
        selected.value = key;
      }}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Events tomorrow. Open relevant details." }));
  assert.equal(selected.value, "web-search:result-1");
  view.unmount();
});

void test("a pending mention that fails during the subject transition restores the visible result", () => {
  const props = { webSearchState: null, imageUrls: {}, isVisible: true, isOpen: false, onClick: () => {} };
  const view = render(<AmbientContextPill {...props} items={[item]} />);
  const ready = { ...item, status: "ready" as const, summary: "Product planning software." };
  view.rerender(<AmbientContextPill {...props} items={[ready]} />);
  const next = {
    ...item,
    id: "33333333-3333-4333-8333-333333333333",
    displayName: "Ramp",
    lastMentionedAt: "2026-09-25T10:01:00Z",
  };
  view.rerender(<AmbientContextPill {...props} items={[next, ready]} />);
  // The outgoing completed result must not briefly revert to its old spinner.
  assert.ok(view.getByRole("button").classList.contains("is-result"));
  view.rerender(<AmbientContextPill {...props} items={[{ ...next, status: "failed" }, ready]} />);
  const button = view.getByRole("button", { name: "Linear. Open relevant details." });
  assert.ok(button.querySelector(".live-ambient-context-pill-content.is-visible"));
  view.unmount();
});

void test("existing results do not glow on mount, initial fetch, rejoin, or controls reveal", () => {
  const ready = { ...item, status: "ready" as const, summary: "Existing answer." };
  const older = { ...ready, id: "older", lastMentionedAt: "2026-09-25T09:00:00Z" };
  const props = { webSearchState: null, imageUrls: {}, isVisible: true, isOpen: false, onClick: () => {} };
  [false, true].forEach((shouldStartEmpty) => {
    [false, true].forEach((shouldStartVisible) => {
      const view = render(
        <AmbientContextPill {...props} isVisible={shouldStartVisible} items={shouldStartEmpty ? [] : [ready, older]} />,
      );
      view.rerender(<AmbientContextPill {...props} isVisible={shouldStartVisible} items={[ready, older]} />);
      assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
      view.rerender(<AmbientContextPill {...props} items={[ready, older]} />);
      assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
      view.unmount();
    });
  });
});

void test("answers completed while controls are hidden do not glow when revealed", () => {
  const props = { webSearchState: null, imageUrls: {}, isOpen: false, onClick: () => {} };
  const view = render(<AmbientContextPill {...props} isVisible={false} items={[item]} />);
  const ready = { ...item, status: "ready" as const, summary: "Completed while hidden." };
  view.rerender(<AmbientContextPill {...props} isVisible={false} items={[ready]} />);
  view.rerender(<AmbientContextPill {...props} isVisible items={[ready]} />);
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
  view.unmount();
});

void test("an already announced result does not glow again after the pill disappears", async () => {
  const props = { webSearchState: null, imageUrls: {}, isVisible: true, isOpen: false, onClick: () => {} };
  const view = render(<AmbientContextPill {...props} items={[item]} />);
  const ready = { ...item, status: "ready" as const, summary: "Previously announced answer." };
  view.rerender(<AmbientContextPill {...props} items={[ready]} />);
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), true);
  await waitFor(() =>
    assert.equal(
      view.container.querySelector<HTMLElement>(".live-ambient-context-pill-positioner")?.style.opacity,
      "1",
    ),
  );
  view.rerender(<AmbientContextPill {...props} items={[]} />);
  await waitFor(() => assert.equal(Boolean(view.container.querySelector("button")), false));
  view.rerender(<AmbientContextPill {...props} items={[ready]} />);
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
  view.unmount();
});

void test("speech-meter rerenders with recreated web props do not rescan ambient result versions", () => {
  const reads = { count: 0 };
  const ready = {
    ...item,
    status: "ready" as const,
    summary: "Existing answer.",
    get researchCompletedAt() {
      reads.count += 1;

      return "2026-09-25T10:00:05Z";
    },
  };
  const items = [ready];
  const web = { key: "web-search:performance", label: "Search results", updatedAt: Date.parse("2026-09-25T10:00:10Z") };
  const props = { items, imageUrls: {}, isVisible: true, isOpen: false, onClick: () => {} };
  const view = render(<AmbientContextPill {...props} webSearchState={{ ...web }} />);
  const initialReads = reads.count;
  assert.ok(initialReads > 0);
  Array.from({ length: RERENDER_STRESS_ITERATIONS }).forEach(() => {
    view.rerender(<AmbientContextPill {...props} webSearchState={{ ...web }} />);
  });
  assert.equal(reads.count, initialReads, "stable primitive web values must not scan the result list again");
  view.unmount();
});

void test("mentions and image updates keep the old completion version quiet", () => {
  const ready = { ...item, status: "ready" as const, summary: "Existing answer." };
  const props = { webSearchState: null, imageUrls: {}, isVisible: true, isOpen: false, onClick: () => {} };
  const view = render(<AmbientContextPill {...props} items={[ready]} />);
  view.rerender(
    <AmbientContextPill {...props} items={[{ ...ready, updatedAt: "2026-09-25T10:10:00Z", imageStatus: "ready" }]} />,
  );
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false);
  view.rerender(<AmbientContextPill {...props} items={[{ ...ready, researchCompletedAt: "2026-09-25T10:11:00Z" }]} />);
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), true);
  view.unmount();
});

void test("follow-up start and an unverified outcome do not glow before a new completion", () => {
  const ready = {
    ...item,
    status: "ready" as const,
    summary: "Published answer.",
    researchCompletedAt: "2026-09-25T10:00:10Z",
  };
  const props = { webSearchState: null, imageUrls: {}, isVisible: true, isOpen: false, onClick: () => {} };
  const view = render(<AmbientContextPill {...props} items={[ready]} />);
  (["pending", "researching", "ready"] as const).forEach((status) => {
    view.rerender(
      <AmbientContextPill
        {...props}
        items={[
          {
            ...ready,
            status,
            lastMentionedAt: "2026-09-25T10:01:00Z",
            updatedAt: "2026-09-25T10:01:02Z",
            error: status === "ready" ? "ambient_identity_unverified" : null,
          },
        ]}
      />,
    );
    assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), false, status);
  });
  view.rerender(
    <AmbientContextPill
      {...props}
      items={[{ ...ready, summary: "New answer.", researchCompletedAt: "2026-09-25T10:02:00Z" }]}
    />,
  );
  assert.equal(view.getByRole("button").classList.contains("has-arrival-glow"), true);
  view.unmount();
});
