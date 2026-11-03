import type { TaskRealtimeEvent } from "@readymeet/shared";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  createTaskRealtimeOrderingState,
  evaluateTaskRealtimeEvent,
  isTaskDeletionRealtimeEvent,
  rememberTaskListVersion,
  rememberTaskRevision,
} from "../../domain/task-realtime-ordering";

const TASK_REVISION_BASE = 2;
const TASK_REVISION_STALE = 2;
const TASK_REVISION_ADVANCED = 3;
const TASK_REVISION_GAP = 4;
const TASK_LIST_VERSION_BASE = 2;
const TASK_LIST_VERSION_GAP = 5;

void test("meeting and workspace deletion events both remove tasks immediately", () => {
  assert.equal(isTaskDeletionRealtimeEvent("task.deleted"), true);
  assert.equal(isTaskDeletionRealtimeEvent("workspace.task.deleted"), true);
  assert.equal(isTaskDeletionRealtimeEvent("workspace.task.updated"), false);
});

function event(overrides: Partial<TaskRealtimeEvent> = {}): TaskRealtimeEvent {
  const has = (key: keyof TaskRealtimeEvent) => Object.prototype.hasOwnProperty.call(overrides, key);

  return {
    version: 1,
    eventId: overrides.eventId ?? "11111111-1111-4111-8111-111111111111",
    eventName: overrides.eventName ?? "task.updated",
    workspaceId: overrides.workspaceId ?? "22222222-2222-4222-8222-222222222222",
    meetingId: overrides.meetingId ?? "33333333-3333-4333-8333-333333333333",
    taskId: has("taskId") ? overrides.taskId : "44444444-4444-4444-8444-444444444444",
    revision: has("revision") ? overrides.revision : TASK_REVISION_BASE,
    taskListVersion: has("taskListVersion") ? overrides.taskListVersion : null,
    occurredAt: overrides.occurredAt ?? "2026-05-01T12:00:00.000Z",
    actorUserId: overrides.actorUserId ?? null,
  };
}

void test("task realtime ordering ignores duplicate event ids", () => {
  const state = createTaskRealtimeOrderingState();
  rememberTaskRevision(state, "44444444-4444-4444-8444-444444444444", 1);

  assert.equal(evaluateTaskRealtimeEvent(state, event()).action, "apply");
  const duplicate = evaluateTaskRealtimeEvent(state, event());

  assert.deepEqual(duplicate, { action: "ignore", reason: "duplicate" });
});

void test("task realtime ordering rejects stale revisions", () => {
  const state = createTaskRealtimeOrderingState();
  rememberTaskRevision(state, "44444444-4444-4444-8444-444444444444", TASK_REVISION_ADVANCED);

  const decision = evaluateTaskRealtimeEvent(
    state,
    event({
      eventId: "55555555-5555-4555-8555-555555555555",
      revision: TASK_REVISION_STALE,
    }),
  );

  assert.deepEqual(decision, { action: "ignore", reason: "stale-task-revision" });
});

void test("task realtime ordering refetches on revision gaps", () => {
  const state = createTaskRealtimeOrderingState();
  rememberTaskRevision(state, "44444444-4444-4444-8444-444444444444", 1);

  const decision = evaluateTaskRealtimeEvent(
    state,
    event({
      eventId: "55555555-5555-4555-8555-555555555555",
      revision: TASK_REVISION_GAP,
    }),
  );

  assert.deepEqual(decision, { action: "refetch", reason: "task-revision-gap" });
});

void test("task realtime ordering refetches on task list gaps", () => {
  const state = createTaskRealtimeOrderingState();
  rememberTaskListVersion(state, "33333333-3333-4333-8333-333333333333", TASK_LIST_VERSION_BASE);

  const decision = evaluateTaskRealtimeEvent(
    state,
    event({
      eventId: "55555555-5555-4555-8555-555555555555",
      eventName: "task.list.updated",
      taskId: null,
      revision: null,
      taskListVersion: TASK_LIST_VERSION_GAP,
    }),
  );

  assert.deepEqual(decision, { action: "refetch", reason: "task-list-version-gap" });
});
