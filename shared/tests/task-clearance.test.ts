import assert from "node:assert/strict";
import test from "node:test";

import {
  clearDoneTasksRequestSchema,
  clearSelectedDoneTasksRequestSchema,
  getDoneTasksCutoff,
  MAX_SELECTED_DONE_TASKS,
} from "../domain/task-clearance";

void test("clear cutoffs use completion age and clamp calendar months", () => {
  const now = new Date("2026-03-31T12:00:00.000Z");
  assert.equal(getDoneTasksCutoff({ range: "all", now }).toISOString(), now.toISOString());
  assert.equal(getDoneTasksCutoff({ range: "week", now }).toISOString(), "2026-03-24T12:00:00.000Z");
  assert.equal(getDoneTasksCutoff({ range: "month", now }).toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(getDoneTasksCutoff({ range: "six_months", now }).toISOString(), "2025-09-30T12:00:00.000Z");
  assert.equal(
    getDoneTasksCutoff({ range: "year", now: new Date("2024-02-29T12:00:00.000Z") }).toISOString(),
    "2023-02-28T12:00:00.000Z",
  );
  assert.equal(now.toISOString(), "2026-03-31T12:00:00.000Z");
});

void test("clear requests require a real workspace and a supported range", () => {
  assert.equal(clearDoneTasksRequestSchema.safeParse({ workspaceId: "invalid", range: "all" }).success, false);
  assert.equal(
    clearDoneTasksRequestSchema.safeParse({ workspaceId: "11111111-1111-4111-8111-111111111111", range: "forever" })
      .success,
    false,
  );
});

void test("selected clearing accepts a single large request and rejects oversized selections before writes", () => {
  const task = { sourceType: "meeting", taskId: "11111111-1111-4111-8111-111111111111" };
  const request = {
    workspaceId: task.taskId,
    tasks: Array.from({ length: MAX_SELECTED_DONE_TASKS }, () => task),
  };
  assert.equal(clearSelectedDoneTasksRequestSchema.parse(request).tasks.length, MAX_SELECTED_DONE_TASKS);
  assert.equal(
    clearSelectedDoneTasksRequestSchema.safeParse({
      ...request,
      tasks: Array.from({ length: MAX_SELECTED_DONE_TASKS + 1 }, () => task),
    }).success,
    false,
  );
});
