import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";

import { clearSelectedDoneTasks } from "../application/api";

const SELECTED_TASK_COUNT = 501;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const OVERSIZED_SELECTION_COUNT = 10_001;
const CLEAR_FAILED_MESSAGE = "Clear failed";
const OVERSIZED_SELECTION_MESSAGE = "Select at most 10,000 tasks at once, or use Clear all done.";
const EXPECTED_JSON_BODY = "Expected a JSON request body.";
const MISSING_SAMPLE_TASK = "Expected a sample task.";

const clearSelectedRequestSchema = z.object({
  workspaceId: z.string(),
  tasks: z.array(
    z.object({
      sourceType: z.enum(["workspace", "meeting"]),
      taskId: z.string(),
    }),
  ),
});

const workspaceId = "11111111-1111-4111-8111-111111111111";
const tasks = Array.from({ length: SELECTED_TASK_COUNT }, () => ({
  sourceType: "workspace" as const,
  taskId: randomUUID(),
}));

void test("large selected clears use one request and return the whole selection", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith("/me/tasks/personal/clear-selected"));
    assert.equal(init.method, "POST");
    if (typeof init.body !== "string") {
      throw new Error(EXPECTED_JSON_BODY);
    }
    assert.deepEqual(clearSelectedRequestSchema.parse(JSON.parse(init.body)), { workspaceId, tasks });

    return Response.json({ tasks });
  });
  assert.deepEqual(await clearSelectedDoneTasks({ token: "test-token", workspaceId, tasks }), tasks);
  assert.equal(fetch.mock.callCount(), 1);
});

void test("failed selected clears do not continue with additional requests", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: CLEAR_FAILED_MESSAGE }, { status: HTTP_INTERNAL_SERVER_ERROR }),
  );
  await assert.rejects(
    clearSelectedDoneTasks({ token: "test-token", workspaceId, tasks }),
    new RegExp(CLEAR_FAILED_MESSAGE),
  );
  assert.equal(fetch.mock.callCount(), 1);
});

void test("oversized selections show friendly copy and are rejected before any request is sent", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("No write should be sent"));
  const sample = tasks[0];
  if (sample === undefined) {
    throw new Error(MISSING_SAMPLE_TASK);
  }
  await assert.rejects(
    clearSelectedDoneTasks({
      token: "test-token",
      workspaceId,
      tasks: Array.from({ length: OVERSIZED_SELECTION_COUNT }, () => sample),
    }),
    {
      name: "Error",
      message: OVERSIZED_SELECTION_MESSAGE,
    },
  );
  assert.equal(fetch.mock.callCount(), 0);
});
