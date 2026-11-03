import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceGeneratedNotes } from "../../../presentation/components/workspace-generated-notes";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const FALLBACK = "Meeting notes could not be generated automatically. The transcript is available for review.";
const SHORT_MEETING = "Meeting was too short to process.";
const BULLET = "Ship the pilot on Tuesday.";
const REVEAL_WAIT_MS = 10_000;

function headingTexts(view: { queryAllByRole: (role: "heading") => HTMLElement[] }) {
  return view.queryAllByRole("heading").map((heading) => heading.textContent);
}

["static", "reveal"].forEach((mode) => {
  [
    FALLBACK,
    SHORT_MEETING,
    "The team agreed to ship.",
    "- Overview",
    "1. General Summary",
    "Overview of the launch: we agreed to ship.",
    "Summary: the team agreed to ship.",
  ].forEach((summary) => {
    void test(`${mode} notes preserve a non-heading first line: ${summary}`, async (t) => {
      t.after(cleanup);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(window, "setTimeout", globalThis.setTimeout);
      t.mock.method(window, "clearTimeout", globalThis.clearTimeout);
      const callbacks = { completed: 0 };
      const view = render(
        <WorkspaceGeneratedNotes
          summary={summary}
          mode={mode === "static" ? "static" : "reveal"}
          omitLeadingHeading
          onRevealComplete={() => {
            callbacks.completed += 1;
          }}
        />,
      );
      await act(async () => t.mock.timers.tick(REVEAL_WAIT_MS));
      const expected = summary.replace(/^(?:- |1\. )/, "");
      assert.equal(view.container.textContent, expected);
      assert.deepEqual(headingTexts(view), []);
      assert.equal(callbacks.completed, 1);
    });
  });
});

[
  "Overview",
  "General Summary",
  "## Overview",
  "**General Summary**",
  "overview:",
  "**Overview:**",
  "**Overview**:",
  "## Summary",
  "Summary",
  "Overview (00:00 - 05:00)",
].forEach((heading) => {
  void test(`omits only the redundant leading summary heading: ${heading}`, (t) => {
    t.after(cleanup);
    const view = render(
      <WorkspaceGeneratedNotes
        summary={`${heading}\n- ${BULLET}\nTopics\nDecisions\n- Keep scope small.`}
        mode="static"
        omitLeadingHeading
      />,
    );
    assert.equal(view.queryByText(heading), null);
    assert.deepEqual(
      headingTexts(view).filter((text) => /overview|summary/i.test(text)),
      [],
    );
    assert.equal(view.queryByText("Topics"), null);
    assert.notEqual(view.getByText(BULLET), null);
    assert.notEqual(view.getByRole("heading", { name: "Decisions" }), null);
  });
});

void test("keeps headings when omission is disabled and completes an empty summary", (t) => {
  t.after(cleanup);
  const callbacks = { completed: 0 };
  const view = render(<WorkspaceGeneratedNotes summary={`Overview\n- ${BULLET}`} mode="static" />);
  assert.notEqual(view.getByRole("heading", { name: "Overview" }), null);
  view.rerender(
    <WorkspaceGeneratedNotes
      summary=""
      mode="reveal"
      omitLeadingHeading
      onRevealComplete={() => {
        callbacks.completed += 1;
      }}
    />,
  );
  assert.equal(view.container.textContent, "");
  assert.equal(callbacks.completed, 1);
});

[FALLBACK, SHORT_MEETING, "Overview of the launch: we agreed to ship Friday."].forEach((prose) => {
  void test(`renders a prose first line as body text, not a heading: ${prose}`, (t) => {
    t.after(cleanup);
    const view = render(<WorkspaceGeneratedNotes summary={`${prose}\n- ${BULLET}`} mode="static" omitLeadingHeading />);
    assert.deepEqual(headingTexts(view), []);
    assert.equal(view.getByText(prose).tagName, "P");
    assert.notEqual(view.getByText(BULLET), null);
  });
});

void test("keeps topic titles as headings and strips markdown heading markers", (t) => {
  t.after(cleanup);
  const view = render(
    <WorkspaceGeneratedNotes
      summary={`Launch plan\n- ${BULLET}\n## Onboarding\n- Gus reviews the checklist.`}
      mode="static"
      omitLeadingHeading
    />,
  );
  assert.notEqual(view.getByRole("heading", { name: "Launch plan" }), null);
  assert.notEqual(view.getByRole("heading", { name: "Onboarding" }), null);
  assert.equal(view.queryByText("## Onboarding"), null);
});

["What should we ship next?", "Pricing…", "Pricing...", "Q3 vs. Q4 plan"].forEach((title) => {
  void test(`renders a title that introduces bullets as a heading: ${title}`, (t) => {
    t.after(cleanup);
    const view = render(<WorkspaceGeneratedNotes summary={`${title}\n- ${BULLET}`} mode="static" omitLeadingHeading />);
    assert.deepEqual(headingTexts(view), [title]);
    assert.equal(view.getByText(BULLET).tagName, "P");
  });
});

["Notes unavailable for this meeting", "Any questions?", "Launch plan"].forEach((line) => {
  void test(`renders a standalone line as body text: ${line}`, (t) => {
    t.after(cleanup);
    const view = render(<WorkspaceGeneratedNotes summary={line} mode="static" omitLeadingHeading />);
    assert.deepEqual(headingTexts(view), []);
    assert.equal(view.getByText(line).tagName, "P");
  });
});

void test("renders a closing line with nothing under it as body text", (t) => {
  t.after(cleanup);
  const closing = "The rest of the call was open Q&A";
  const view = render(
    <WorkspaceGeneratedNotes summary={`Launch plan\n- ${BULLET}\n${closing}`} mode="static" omitLeadingHeading />,
  );
  assert.notEqual(view.getByRole("heading", { name: "Launch plan" }), null);
  assert.deepEqual(headingTexts(view), ["Launch plan"]);
  assert.equal(view.getByText(closing).tagName, "P");
});

void test("completed notes stay visible through summary refreshes and a new meeting can reveal", async (t) => {
  t.after(cleanup);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(window, "setTimeout", globalThis.setTimeout);
  t.mock.method(window, "clearTimeout", globalThis.clearTimeout);
  const callbacks = { completed: 0 };
  const summary = "Overview\n- The fictional robot sorted colored blocks.";
  const onRevealComplete = () => {
    callbacks.completed += 1;
  };
  const view = render(
    <WorkspaceGeneratedNotes key="meeting-one" summary={summary} onRevealComplete={onRevealComplete} />,
  );
  await act(async () => t.mock.timers.tick(REVEAL_WAIT_MS));
  assert.equal(callbacks.completed, 1);
  [summary, `${summary}\n`, `${summary}\n- The robot finished.`].forEach((refreshedSummary) => {
    view.rerender(
      <WorkspaceGeneratedNotes key="meeting-one" summary={refreshedSummary} onRevealComplete={onRevealComplete} />,
    );
    assert.ok(view.container.textContent.includes("The fictional robot sorted colored blocks."));
    assert.notEqual(view.container.querySelector(".is-static"), null);
    assert.equal(view.container.querySelector(".live-transcript-line-animated"), null);
    assert.equal(callbacks.completed, 1);
  });
  await act(async () => t.mock.timers.tick(REVEAL_WAIT_MS));
  assert.equal(callbacks.completed, 1);
  assert.ok(view.container.textContent.includes("The robot finished."));
  view.rerender(<WorkspaceGeneratedNotes key="meeting-two" summary={summary} onRevealComplete={onRevealComplete} />);
  assert.equal(view.container.textContent, "");
  await act(async () => t.mock.timers.tick(REVEAL_WAIT_MS));
  const completedMeetings = 2;
  assert.equal(callbacks.completed, completedMeetings);
});
