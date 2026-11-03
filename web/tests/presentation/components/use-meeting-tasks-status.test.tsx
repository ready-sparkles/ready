import type { MeetingTaskList } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  type MeetingTasksStatusView,
  normalizeMeetingTasksStatusForViewing,
  shouldRunMeetingTasksForStatus,
  statusFromTaskList,
} from "../../../presentation/components/use-meeting-tasks-status";

const meetingId = "11111111-1111-4111-8111-111111111111";
const taskListId = "22222222-2222-4222-8222-222222222222";

type MeetingTaskStatusBehavior = {
  /** @external meeting tasks viewing behavior */
  reuseExistingCompletedTasks?: boolean;
};

function taskList(input: Partial<MeetingTaskList> = {}): MeetingTaskList {
  return {
    id: taskListId,
    meetingId,
    status: "completed",
    phase: "complete",
    error: null,
    model: "test-model",
    promptVersion: "old-prompt-version",
    transcriptHash: "old-hash",
    taskListVersion: 1,
    items: [],
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
    completedAt: "2026-05-01T12:00:00.000Z",
    ...input,
  };
}

function status(input: Partial<MeetingTasksStatusView> = {}): MeetingTasksStatusView {
  return {
    status: "pending",
    phase: "pending",
    error: null,
    isTerminal: false,
    isCurrent: false,
    job: null,
    tasks: null,
    progress: null,
    ...input,
  };
}

const reuseCompletedTasksBehavior: MeetingTaskStatusBehavior = {
  reuseExistingCompletedTasks: true,
};

void test("stale completed initial tasks are reusable for past meeting viewing", () => {
  const reusableStatus = statusFromTaskList(taskList(), reuseCompletedTasksBehavior);

  assert.ok(reusableStatus !== null);
  assert.equal(reusableStatus.status, "completed");
  assert.equal(reusableStatus.isTerminal, true);
  assert.equal(reusableStatus.isCurrent, false);
});

void test("stale completed initial tasks are not reused by default", () => {
  assert.equal(statusFromTaskList(taskList()), null);
});

void test("completed task status payload prevents a follow-up run when reuse is enabled", () => {
  const normalizedStatus = normalizeMeetingTasksStatusForViewing(
    status({
      tasks: taskList(),
    }),
    reuseCompletedTasksBehavior,
  );

  assert.equal(normalizedStatus.status, "completed");
  assert.equal(normalizedStatus.isTerminal, true);
  assert.equal(shouldRunMeetingTasksForStatus(normalizedStatus, reuseCompletedTasksBehavior), false);
});

void test("missing tasks still allow generation", () => {
  assert.equal(shouldRunMeetingTasksForStatus(status(), reuseCompletedTasksBehavior), true);
});
