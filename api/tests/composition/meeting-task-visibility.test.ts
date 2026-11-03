import assert from "node:assert/strict";
import test from "node:test";

import { filterMeetingTaskStatusForViewer } from "../../application/meeting-task-visibility";

const generatingPayload = {
  status: "generating",
  tasks: {
    status: "generating",
    items: [{ id: "participant-only-task" }],
  },
};

void test("workspace viewers cannot read an in-progress meeting task list", () => {
  const visiblePayload = filterMeetingTaskStatusForViewer({ payload: generatingPayload, viewerRole: "workspace" });

  assert.equal(visiblePayload.status, "generating");
  assert.equal(visiblePayload.tasks, null);
});

void test("meeting participants can read an in-progress meeting task list", () => {
  assert.equal(
    filterMeetingTaskStatusForViewer({ payload: generatingPayload, viewerRole: "participant" }),
    generatingPayload,
  );
});

void test("workspace viewers can read a completed meeting task list", () => {
  const completedPayload = {
    status: "completed",
    tasks: {
      status: "completed",
      items: [{ id: "completed-task" }],
    },
  };

  assert.equal(
    filterMeetingTaskStatusForViewer({ payload: completedPayload, viewerRole: "workspace" }),
    completedPayload,
  );
});
