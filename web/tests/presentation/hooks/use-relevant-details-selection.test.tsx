import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MeetingAmbientContextItem } from "@readymeet/shared";
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import { useState } from "react";

import { latestRelevantDetailsKey, relevantDetailsHistoryItems } from "../../../domain/relevant-details";
import { createAmbientContextItem } from "../../../domain/testing/ambient-context-fixture";
import { AmbientContextPanel } from "../../../presentation/components/ambient-context-panel";
import { useRelevantDetailsSelection } from "../../../presentation/hooks/use-relevant-details-selection";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WAIT_FOR_RETRY_BUTTON_MS = 4_000;
const MESSAGE_RESEARCH_FAILED = "Ready couldn’t finish this research.";
const MESSAGE_RESEARCH_TIMEOUT = "Research is taking longer than expected.";
const API_CODE_AMBIENT_IDENTITY_UNVERIFIED = "ambient_identity_unverified";

void test("manual history selection survives mentions, image arrivals and unverified follow-ups", () => {
  const ready = createAmbientContextItem({
    status: "ready",
    summary: "Published answer.",
    researchCompletedAt: "2026-09-25T10:00:10Z",
  });
  const view = renderHook(
    ({ item, isOpen }) => {
      const [selected, select] = useState<string | null>(null);
      useRelevantDetailsSelection({
        latest: relevantDetailsHistoryItems({ ambientItems: [item], webSearchItems: [] })[0],
        isOpen,
        onSelect: select,
      });

      return { selected, select };
    },
    { initialProps: { item: ready, isOpen: true } },
  );
  act(() => view.result.current.select("ambient:older"));
  (
    [
      { lastMentionedAt: "2026-09-25T10:01:00Z" },
      { imageStatus: "ready" as const },
      { status: "researching" as const },
      { status: "ready" as const, error: API_CODE_AMBIENT_IDENTITY_UNVERIFIED },
    ] as const
  ).forEach((update) => {
    view.rerender({ item: { ...ready, ...update, updatedAt: "2026-09-25T10:01:01Z" }, isOpen: true });
    assert.equal(view.result.current.selected, "ambient:older");
  });
  view.rerender({
    item: { ...ready, researchCompletedAt: "2026-09-25T10:02:00Z", summary: "New verified answer." },
    isOpen: true,
  });
  assert.equal(view.result.current.selected, `ambient:${ready.id}`);
  act(() => view.result.current.select("ambient:older"));
  view.rerender({ item: { ...ready, researchCompletedAt: "2026-09-25T10:03:00Z" }, isOpen: false });
  view.rerender({ item: { ...ready, researchCompletedAt: "2026-09-25T10:03:00Z" }, isOpen: true });
  assert.equal(view.result.current.selected, "ambient:older", "reopening does not replay an unseen completion");
  view.unmount();
});

const RETRY_OUTCOMES = ["failed", "timeout"] as const;
const HAS_OLDER_RESULT_OPTIONS = [true, false] as const;

RETRY_OUTCOMES.forEach((outcome) => {
  HAS_OLDER_RESULT_OPTIONS.forEach((hasOlder) => {
    void test(`${outcome} keeps the watched panel item and retry action, older result: ${hasOlder}`, async () => {
      const older = createAmbientContextItem({
        id: "older",
        displayName: "Older company",
        status: "ready",
        summary: "Older answer.",
        researchCompletedAt: "2026-09-25T10:00:10Z",
      });
      const watched = createAmbientContextItem({
        id: "watched",
        displayName: "Watched company",
        status: "researching",
        lastMentionedAt: "2026-09-25T10:01:00Z",
      });
      const retryState = { id: null as string | null };
      function Panel({ items, expired }: { items: MeetingAmbientContextItem[]; expired: Set<string> }) {
        const [selected, select] = useState<string | null>(null);
        const latestKey = latestRelevantDetailsKey({ items, webSearchItems: [], expiredItemIds: expired });
        const latest = relevantDetailsHistoryItems({ ambientItems: items, webSearchItems: [] }).find(
          (item) => item.key === latestKey,
        );
        useRelevantDetailsSelection({ latest, isOpen: true, onSelect: select });

        return (
          <AmbientContextPanel
            ambientItems={items}
            expiredItemIds={expired}
            webSearchItems={[]}
            imageUrls={{}}
            isOpen
            selectedItemKey={selected}
            onSelect={select}
            onClose={() => {}}
            onRetry={async (id) => {
              retryState.id = id;
            }}
          />
        );
      }
      const items = hasOlder ? [watched, older] : [watched];
      const view = render(<Panel items={items} expired={new Set()} />);
      const settled = items.map((item) =>
        item.id === watched.id && outcome === "failed" ? { ...item, status: "failed" as const } : item,
      );
      view.rerender(<Panel items={settled} expired={new Set(outcome === "timeout" ? [watched.id] : [])} />);
      await waitFor(() => assert.ok(view.queryByRole("button", { name: "Try again" }) !== null), {
        timeout: WAIT_FOR_RETRY_BUTTON_MS,
      });
      view.getByText(outcome === "failed" ? MESSAGE_RESEARCH_FAILED : MESSAGE_RESEARCH_TIMEOUT);
      assert.equal(view.queryByText("Older answer."), null);
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Try again" }));
      });
      assert.equal(retryState.id, watched.id);
      view.unmount();
    });
  });
});

void test("fallback does not reset arrival history; later completions and new subjects still follow", () => {
  const watched = createAmbientContextItem({ id: "watched", lastMentionedAt: "2026-09-25T10:01:00Z" });
  const older = createAmbientContextItem({
    id: "older",
    status: "ready",
    summary: "Old answer.",
    researchCompletedAt: "2026-09-25T10:00:10Z",
  });
  const view = renderHook(
    ({ latest }) => {
      const [selected, select] = useState<string | null>(null);
      useRelevantDetailsSelection({ latest, isOpen: true, onSelect: select });

      return selected;
    },
    { initialProps: { latest: relevantDetailsHistoryItems({ ambientItems: [watched], webSearchItems: [] })[0] } },
  );
  view.rerender({ latest: relevantDetailsHistoryItems({ ambientItems: [older], webSearchItems: [] })[0] });
  assert.equal(view.result.current, "ambient:watched");
  view.rerender({ latest: undefined });
  view.rerender({ latest: relevantDetailsHistoryItems({ ambientItems: [older], webSearchItems: [] })[0] });
  assert.equal(view.result.current, "ambient:watched");
  view.rerender({
    latest: relevantDetailsHistoryItems({
      ambientItems: [{ ...older, researchCompletedAt: "2026-09-25T10:02:00Z" }],
      webSearchItems: [],
    })[0],
  });
  assert.equal(view.result.current, "ambient:older");
  view.rerender({
    latest: relevantDetailsHistoryItems({
      ambientItems: [{ ...watched, id: "new-subject", lastMentionedAt: "2026-09-25T10:03:00Z" }],
      webSearchItems: [],
    })[0],
  });
  assert.equal(view.result.current, "ambient:new-subject");
  view.unmount();
});
