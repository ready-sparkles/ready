import assert from "node:assert/strict";
import test from "node:test";

import { buildMeetingNotesPreview, stripSummaryTaskSection } from "../domain/summary-text";

const PREVIEW_CHARACTER_LIMIT = 600;
const OVERSIZED_TEST_WORD_COUNT = 400;
const OVERSIZED_TEST_LINE_LENGTH = 2_000;

void test("separates current and legacy task headings from meeting notes", () => {
  ["Tasks", "Action items", "TASKS"].forEach((heading) => {
    ["\n", "\r\n"].forEach((newline) => {
      const content = ["General Summary", "- Ship on Friday.", "", heading, "- Personbr: send the brief."].join(
        newline,
      );
      assert.equal(stripSummaryTaskSection(content), "General Summary\n- Ship on Friday.");
    });
  });
});

void test("does not remove mentions of tasks or action items inside the notes", () => {
  const content = "General Summary\n- Tasks need owners.\n\nNotes\nThe team reviewed action items.";
  assert.equal(stripSummaryTaskSection(content), content);
});

void test("handles task-only and empty summaries", () => {
  assert.equal(stripSummaryTaskSection("Tasks\n- Send the brief."), "");
  assert.equal(stripSummaryTaskSection("Action items\n- Send the brief."), "");
  assert.equal(stripSummaryTaskSection(""), "");
});

void test("a leading task section removes only the tasks and keeps the notes after it", () => {
  ["Tasks", "Action items"].forEach((heading) => {
    ["- ", "1. "].forEach((marker) => {
      ["\n", "\r\n"].forEach((newline) => {
        const content = [heading, `${marker}Sam: send the brief.`, "", "Overview", "- Beta ships Friday."].join(
          newline,
        );
        assert.equal(stripSummaryTaskSection(content), "Overview\n- Beta ships Friday.");
      });
    });
  });
});

void test("a task section in the middle keeps every later notes section", () => {
  const content = [
    "Overview",
    "- Beta ships Friday.",
    "",
    "Action items",
    "- Sam: send the brief.",
    "",
    "- Gus: review the checklist.",
    "",
    "Launch plan",
    "- Gus reviews the checklist.",
  ].join("\n");
  assert.equal(
    stripSummaryTaskSection(content),
    "Overview\n- Beta ships Friday.\n\nLaunch plan\n- Gus reviews the checklist.",
  );
});

void test("locked previews of a summary that starts with tasks show the notes, not the tasks", () => {
  assert.equal(
    buildMeetingNotesPreview("Action items\n- Private task.\n\nOverview\n- Decision."),
    "Overview\n- Decision.",
  );
});

void test("locked notes previews keep only four lines and never include the task section", () => {
  assert.equal(
    buildMeetingNotesPreview("Overview\n- First.\n- Second.\n- Third.\nPrivate later section\n- Fourth."),
    "Overview\n- First.\n- Second.\n- Third.",
  );
  assert.equal(buildMeetingNotesPreview("Overview\n- Decision.\n\nTasks\n- Private task."), "Overview\n- Decision.");
  assert.equal(buildMeetingNotesPreview("Tasks\n- Private task."), "");
});

void test("locked notes previews enforce the character cap even for one huge line", () => {
  ["word ".repeat(OVERSIZED_TEST_WORD_COUNT), "x".repeat(OVERSIZED_TEST_LINE_LENGTH)].forEach((content) => {
    const preview = buildMeetingNotesPreview(content);
    assert.ok(preview.length <= PREVIEW_CHARACTER_LIMIT);
    assert.ok(preview.endsWith("…"));
  });
});
