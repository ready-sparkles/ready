import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MeetingTrackerItem, MeetingTrackerState } from "@readymeet/shared";
import { fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { MeetingTrackerPanel } from "../../../presentation/components/meeting-tracker-panel";
import { meetingTrackerPanelVisibility } from "../../../presentation/lib/meeting-tracker-panel-state";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const COPY = {
  empty: "None yet",
  legacyIntro: "Your summary, as you talk",
  launchDay: "Choose launch day",
  launchPlan: "Send the launch plan",
  unavailable: "Meeting tracking is not available.",
} as const;
const SECTION_COUNT = 3;
const CLOSE_EVENT_COUNT = 3;
const RESOLVED_REVISION = 2;
const REACTIVATED_REVISION = 3;
const baseProps = { isOpen: true, hasError: false, onClose: () => {} };

void test("shows all sections with task owner and deadline on a separate metadata line", () => {
  const closes = { count: 0 };
  const view = render(
    <MeetingTrackerPanel
      isOpen
      hasError={false}
      onClose={() => {
        closes.count += 1;
      }}
      state={{
        revision: 1,
        updatedAt: null,
        status: "idle",
        items: [
          {
            id: "one",
            section: "open_item",
            text: COPY.launchDay,
            status: "active",
            owner: null,
            due: null,
            evidence: [{ segmentId: "segment", quote: "We agreed to launch Friday." }],
          },
          {
            id: "two",
            section: "next_step",
            text: COPY.launchPlan,
            status: "active",
            owner: "Personbr",
            due: "Now",
            evidence: [{ segmentId: "segment", quote: "I will send the launch plan now." }],
          },
        ],
      }}
    />,
  );
  ["Decisions", "Open questions", "Tasks"].forEach((name) => {
    assert.notEqual(view.getByRole("heading", { name }), null);
  });
  assert.equal(view.getAllByText(COPY.empty).length, 1);
  assert.equal(view.queryByText(COPY.legacyIntro), null);
  assert.notEqual(view.container.querySelector(".live-ambient-context-sheet"), null);
  assert.notEqual(view.getByText(COPY.launchDay), null);
  const task = view.getByText(COPY.launchPlan);
  const metadata = view.getByText("Personbr · Now");
  assert.equal(metadata.classList.contains("live-meeting-tracker-meta"), true);
  assert.equal(metadata.parentElement, task.parentElement);
  assert.equal(task.nextElementSibling, metadata);
  assert.equal(view.getByText(COPY.launchDay).closest("li")?.querySelector(".live-meeting-tracker-meta"), null);
  assert.equal(view.queryByText("Source"), null);
  assert.equal(view.queryByText("We agreed to launch Friday."), null);
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(closes.count, 1);
  view.unmount();
});

void test("a failed live summary remains reachable with saved items and recovers in place", (t) => {
  const state: MeetingTrackerState = {
    revision: 1,
    updatedAt: null,
    status: "idle",
    items: [
      {
        id: "one",
        section: "next_step",
        text: COPY.launchPlan,
        status: "active",
        owner: "Personbr",
        due: null,
        evidence: [{ segmentId: "segment", quote: "I will send the launch plan." }],
      },
    ],
  };
  const closes = { count: 0 };
  const content = (current: MeetingTrackerState) => {
    const visibility = meetingTrackerPanelVisibility({
      state: current,
      hasJoinedMeeting: true,
      isTrackerOpen: true,
      shouldShowLiveMeetingChrome: true,
      isAvatarRevealed: true,
    });
    assert.equal(visibility.isTriggerVisible, true);

    return (
      <MeetingTrackerPanel
        state={current}
        hasError={false}
        isOpen={visibility.isOpen}
        onClose={() => {
          closes.count += 1;
        }}
      />
    );
  };
  const view = render(content(state));
  t.after(() => view.unmount());
  view.rerender(content({ ...state, status: "failed" }));
  assert.equal(view.getByLabelText("Summary").getAttribute("aria-hidden"), "false");
  assert.match(view.getByRole("status").textContent, /Live updates are delayed/);
  assert.notEqual(view.getByText(COPY.launchPlan), null);
  view.getAllByRole("button", { name: "Close summary" }).forEach((button) => {
    fireEvent.click(button);
  });
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(closes.count, CLOSE_EVENT_COUNT);
  view.rerender(content(state));
  assert.equal(view.queryByRole("status"), null);
  assert.notEqual(view.getByText(COPY.launchPlan), null);
});

const RESOLVABLE_SECTIONS = ["open_item", "next_step"] as const;
RESOLVABLE_SECTIONS.forEach((section) => {
  void test(`removes a resolved ${section} and shows it again when reactivated`, () => {
    const item: MeetingTrackerItem = {
      id: "one",
      section,
      text: COPY.launchDay,
      status: "active",
      owner: null,
      due: null,
      evidence: [{ segmentId: "segment", quote: "Which day?" }],
    };
    const state: MeetingTrackerState = { revision: 1, updatedAt: null, status: "idle", items: [item] };
    const view = render(<MeetingTrackerPanel {...baseProps} state={state} />);
    assert.notEqual(view.getByText(COPY.launchDay), null);
    view.rerender(
      <MeetingTrackerPanel
        {...baseProps}
        state={{ ...state, revision: RESOLVED_REVISION, items: [{ ...item, status: "resolved" }] }}
      />,
    );
    assert.equal(view.queryByText(COPY.launchDay), null);
    assert.equal(view.queryByText("Resolved"), null);
    assert.equal(view.getAllByRole("heading").length, SECTION_COUNT);
    assert.equal(view.getAllByText(COPY.empty).length, SECTION_COUNT);
    view.rerender(<MeetingTrackerPanel {...baseProps} state={{ ...state, revision: REACTIVATED_REVISION }} />);
    assert.notEqual(view.getByText(COPY.launchDay), null);
    assert.equal(view.queryByText(COPY.legacyIntro), null);
    view.unmount();
  });
});

void test("empty summary keeps all sections visible and preserves failure and unavailable states", () => {
  const state: MeetingTrackerState = { revision: 0, updatedAt: null, status: "idle", items: [] };
  const view = render(<MeetingTrackerPanel {...baseProps} state={state} />);
  assert.equal(view.getAllByRole("heading").length, SECTION_COUNT);
  assert.equal(view.getAllByText(COPY.empty).length, SECTION_COUNT);
  view.rerender(<MeetingTrackerPanel {...baseProps} state={{ ...state, status: "failed" }} />);
  assert.notEqual(view.getByRole("status"), null);
  assert.equal(view.queryByText(COPY.legacyIntro), null);
  view.rerender(<MeetingTrackerPanel {...baseProps} state={{ ...state, status: "unavailable" }} />);
  assert.notEqual(view.getByText(COPY.unavailable), null);
  assert.equal(view.queryByText(COPY.legacyIntro), null);
  view.unmount();
});
