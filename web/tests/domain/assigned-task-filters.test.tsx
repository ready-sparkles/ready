import type { AssignedTaskMeetingMetadata, UnifiedAssignedTask } from "@readymeet/shared";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  canUpdateAssignedTaskStatus,
  filterReopenableAssignedTasks,
  filterUnifiedAssignedTasksByView,
  filterUnifiedAssignedTasksByWorkspace,
  getAssignedTaskAssigneeWorkspaceIds,
  getAssignedTaskViewDropPatch,
  mergeAssignedTaskMeetingMetadata,
  sortUnifiedAssignedTasksForView,
} from "../../domain/assigned-task-filters";

function taskStatusProbe(input: { sourceType: "meeting" | "workspace"; isEditable: boolean }) {
  return {
    sourceType: input.sourceType,
    /** @external assigned task wire field */
    editable: input.isEditable,
  };
}

function isUnifiedAssignedTaskLike(value: object): value is UnifiedAssignedTask {
  return "taskId" in value && "sourceType" in value && "workspaceId" in value;
}

function unifiedTaskMissingIsMine(base: UnifiedAssignedTask): UnifiedAssignedTask {
  const legacy = { ...base };
  Reflect.deleteProperty(legacy, "isMine");
  assert.ok(isUnifiedAssignedTaskLike(legacy));

  return legacy;
}

function unifiedTask(input: {
  id: string;
  status?: UnifiedAssignedTask["status"];
  isEditable?: boolean;
  isReassignable?: boolean;
  isMine?: boolean;
  owner?: UnifiedAssignedTask["owner"];
  title?: string;
  updatedAt?: string;
  completedAt?: string | null;
  workspaceId?: string;
}): UnifiedAssignedTask {
  return {
    sourceType: "workspace",
    sourceId: input.id,
    taskId: input.id,
    workspaceId: input.workspaceId ?? "55555555-5555-4555-8555-555555555555",
    /** @external assigned task wire field */
    editable: input.isEditable ?? true,
    /** @external assigned task wire field */
    reassignable: input.isReassignable ?? input.isEditable ?? true,
    /** @external assigned task wire field */
    deletable: true,
    /** @external assigned task wire field */
    reorderable: true,
    /** @external assigned task wire field */
    isMine: input.isMine ?? true,
    owner: input.owner ?? null,
    title: input.title ?? `Task ${input.id}`,
    description: null,
    status: input.status ?? "open",
    dueDate: { value: null, confidence: null },
    sectionId: "99999999-9999-4999-8999-999999999999",
    position: 0,
    revision: 1,
    placementRevision: 1,
    updatedAt: input.updatedAt ?? "2026-05-01T18:00:00.000Z",
    completedAt: input.completedAt ?? (input.status === "completed" ? "2026-05-01T18:00:00.000Z" : null),
    sourceMeeting: null,
  };
}

const MINE_OPEN = unifiedTask({ id: "66666666-6666-4666-8666-666666666666" });
const MINE_DONE = unifiedTask({ id: "77777777-7777-4777-8777-777777777777", status: "completed" });
const OTHERS_OPEN = unifiedTask({
  id: "88888888-8888-4888-8888-888888888888",
  isMine: false,
  isEditable: false,
  owner: { userId: "11111111-1111-4111-8111-111111111111", displayName: "Personaz", avatarUrl: null },
});
const UNASSIGNED_OPEN = unifiedTask({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  isMine: false,
  isEditable: true,
  owner: null,
});
const OTHERS_DONE = unifiedTask({
  id: "99999999-9999-4999-8999-999999999999",
  isMine: false,
  isEditable: false,
  status: "completed",
});
const DISMISSED = unifiedTask({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "dismissed" });
const ALL = [MINE_OPEN, MINE_DONE, OTHERS_OPEN, UNASSIGNED_OPEN, OTHERS_DONE, DISMISSED];

void test("workspace filtering excludes tasks cached for another workspace", () => {
  const otherWorkspaceTask = unifiedTask({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workspaceId: "44444444-4444-4444-8444-444444444444",
  });
  assert.deepEqual(
    filterUnifiedAssignedTasksByWorkspace({
      tasks: [MINE_OPEN, otherWorkspaceTask],
      workspaceId: MINE_OPEN.workspaceId,
    }).map((task) => task.taskId),
    [MINE_OPEN.taskId],
  );
  assert.deepEqual(filterUnifiedAssignedTasksByWorkspace({ tasks: [MINE_OPEN], workspaceId: null }), []);
});

void test("meeting task completion is independent from broad editability", () => {
  const sharedMeetingTask = taskStatusProbe({ sourceType: "meeting", isEditable: false });
  assert.equal(canUpdateAssignedTaskStatus({ task: sharedMeetingTask, sourceMeetingKind: "standard" }), true);
  assert.equal(canUpdateAssignedTaskStatus({ task: sharedMeetingTask, sourceMeetingKind: "agent_intro" }), false);
  assert.equal(canUpdateAssignedTaskStatus({ task: sharedMeetingTask }), false);
  assert.equal(
    canUpdateAssignedTaskStatus({
      task: taskStatusProbe({ sourceType: "workspace", isEditable: false }),
      sourceMeetingKind: "standard",
    }),
    false,
  );
  assert.equal(
    canUpdateAssignedTaskStatus({
      task: taskStatusProbe({ sourceType: "meeting", isEditable: true }),
      sourceMeetingKind: "agent_intro",
    }),
    true,
  );
});

void test("Mine holds the viewer’s open tasks only", () => {
  assert.deepEqual(
    filterUnifiedAssignedTasksByView({ tasks: ALL, view: "mine" }).map((task) => task.taskId),
    [MINE_OPEN.taskId],
  );
});

void test("external meeting tasks appear in their attendee filing workspace, not the host workspace", () => {
  const task: UnifiedAssignedTask = {
    ...MINE_OPEN,
    sourceType: "meeting",
    viewerWorkspaceId: "11111111-1111-4111-8111-111111111111",
  };
  assert.deepEqual(filterUnifiedAssignedTasksByWorkspace({ tasks: [task], workspaceId: task.viewerWorkspaceId }), [
    task,
  ]);
  assert.deepEqual(filterUnifiedAssignedTasksByWorkspace({ tasks: [task], workspaceId: task.workspaceId }), []);
  assert.deepEqual(filterUnifiedAssignedTasksByView({ tasks: [task], view: "mine" }), [task]);
});

void test("Others holds other people’s and unassigned open tasks", () => {
  assert.deepEqual(
    filterUnifiedAssignedTasksByView({ tasks: ALL, view: "others" }).map((task) => task.taskId),
    [OTHERS_OPEN.taskId, UNASSIGNED_OPEN.taskId],
  );
});

void test("Done holds completed tasks from both mine and others", () => {
  assert.deepEqual(
    filterUnifiedAssignedTasksByView({ tasks: ALL, view: "done" }).map((task) => task.taskId),
    [MINE_DONE.taskId, OTHERS_DONE.taskId],
  );
});

void test("tasks from payloads that predate isMine count as mine", () => {
  const legacyTask = unifiedTaskMissingIsMine(MINE_OPEN);
  assert.equal(filterUnifiedAssignedTasksByView({ tasks: [legacyTask], view: "mine" }).length, 1);
  assert.equal(filterUnifiedAssignedTasksByView({ tasks: [legacyTask], view: "others" }).length, 0);
});

void test("dropping a task on Done completes it", () => {
  assert.deepEqual(getAssignedTaskViewDropPatch({ task: MINE_OPEN, sourceView: "mine", targetView: "done" }), {
    type: "status",
    status: "completed",
  });
});

void test("dropping a completed own task on Mine reopens it", () => {
  assert.deepEqual(getAssignedTaskViewDropPatch({ task: MINE_DONE, sourceView: "done", targetView: "mine" }), {
    type: "status",
    status: "open",
  });
});

void test("dropping an assignable task from Others on Mine assigns it to the viewer", () => {
  const readOnlyReassignableTask = unifiedTask({
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    isMine: false,
    isEditable: false,
    isReassignable: true,
  });
  assert.deepEqual(
    getAssignedTaskViewDropPatch({
      task: readOnlyReassignableTask,
      sourceView: "others",
      targetView: "mine",
      permissions: {
        /** @external assigned task permission wire field */
        canReassign: readOnlyReassignableTask.reassignable,
      },
    }),
    { type: "assign-to-viewer" },
  );
  assert.equal(getAssignedTaskViewDropPatch({ task: OTHERS_OPEN, sourceView: "others", targetView: "mine" }), null);
});

void test("dropping a reassignable task from Mine on Others clears its assignee", () => {
  assert.deepEqual(
    getAssignedTaskViewDropPatch({
      task: MINE_OPEN,
      sourceView: "mine",
      targetView: "others",
      permissions: {
        /** @external assigned task permission wire field */
        canReassign: true,
      },
    }),
    {
      type: "unassign",
    },
  );
  assert.equal(getAssignedTaskViewDropPatch({ task: MINE_OPEN, sourceView: "mine", targetView: "others" }), null);
  assert.equal(getAssignedTaskViewDropPatch({ task: MINE_DONE, sourceView: "done", targetView: "others" }), null);
});

void test("same-view and non-editable tasks without an explicit permission never produce a status patch", () => {
  assert.equal(getAssignedTaskViewDropPatch({ task: MINE_OPEN, sourceView: "mine", targetView: "mine" }), null);
  assert.equal(getAssignedTaskViewDropPatch({ task: OTHERS_OPEN, sourceView: "others", targetView: "done" }), null);
  const locked = unifiedTask({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", isEditable: false });
  assert.equal(getAssignedTaskViewDropPatch({ task: locked, sourceView: "mine", targetView: "done" }), null);
  assert.deepEqual(
    getAssignedTaskViewDropPatch({
      task: OTHERS_OPEN,
      sourceView: "others",
      targetView: "done",
      permissions: {
        /** @external assigned task permission wire field */
        canUpdateStatus: true,
      },
    }),
    {
      type: "status",
      status: "completed",
    },
  );
});

void test("Mine sort can preserve a completed lingering task position", () => {
  const newerTask = unifiedTask({
    id: "66666666-6666-4666-8666-666666666666",
    title: "Newer task",
    updatedAt: "2026-05-01T18:30:00.000Z",
  });
  const olderTaskBeforeCompletion = unifiedTask({
    id: "77777777-7777-4777-8777-777777777777",
    title: "Older task",
    updatedAt: "2026-05-01T18:00:00.000Z",
  });
  const olderTaskAfterCompletion = {
    ...olderTaskBeforeCompletion,
    status: "completed" as const,
    updatedAt: "2026-05-01T19:00:00.000Z",
    completedAt: "2026-05-01T19:00:00.000Z",
  };

  assert.deepEqual(
    sortUnifiedAssignedTasksForView({ tasks: [newerTask, olderTaskAfterCompletion], view: "mine" }).map(
      (task) => task.taskId,
    ),
    ["77777777-7777-4777-8777-777777777777", "66666666-6666-4666-8666-666666666666"],
  );

  assert.deepEqual(
    sortUnifiedAssignedTasksForView({
      tasks: [newerTask, olderTaskAfterCompletion],
      view: "mine",
      sortOverrides: {
        [olderTaskAfterCompletion.taskId]: {
          view: "mine",
          sortTime: Date.parse(olderTaskBeforeCompletion.updatedAt),
        },
      },
    }).map((task) => task.taskId),
    ["66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"],
  );
});

void test("reopening a mixed selection only includes completed tasks the viewer can update", () => {
  const standardTask: UnifiedAssignedTask = { ...OTHERS_DONE, sourceType: "meeting", sourceId: "standard" };
  const introTask: UnifiedAssignedTask = { ...OTHERS_DONE, sourceType: "meeting", sourceId: "intro" };
  const unknownTask: UnifiedAssignedTask = { ...OTHERS_DONE, sourceType: "meeting", sourceId: "unknown" };
  const canUpdate = (task: UnifiedAssignedTask) =>
    canUpdateAssignedTaskStatus({
      task,
      sourceMeetingKind:
        task.sourceId === "standard" ? "standard" : task.sourceId === "intro" ? "agent_intro" : undefined,
    });
  assert.deepEqual(
    filterReopenableAssignedTasks({
      tasks: [...ALL, standardTask, introTask, unknownTask],
      canUpdateStatus: canUpdate,
    }),
    [MINE_DONE, standardTask],
  );
  assert.deepEqual(
    filterReopenableAssignedTasks({
      tasks: [OTHERS_DONE, introTask, unknownTask],
      canUpdateStatus: canUpdate,
    }),
    [],
  );
});

void test("assignee lookup includes the source workspace of a task filed in the active workspace", () => {
  const active = MINE_OPEN.workspaceId;
  const source = "22222222-2222-4222-8222-222222222222";
  const external = { ...MINE_OPEN, sourceType: "meeting" as const, workspaceId: source, viewerWorkspaceId: active };
  assert.deepEqual(
    getAssignedTaskAssigneeWorkspaceIds({
      tasks: [MINE_OPEN, external, external],
      activeWorkspaceId: active,
      memberWorkspaceIds: [active, source],
    }),
    [active, source],
  );
  assert.deepEqual(
    getAssignedTaskAssigneeWorkspaceIds({ tasks: [external], activeWorkspaceId: active, memberWorkspaceIds: [active] }),
    [active],
    "attendance does not grant member-directory access",
  );
  assert.deepEqual(
    getAssignedTaskAssigneeWorkspaceIds({ tasks: [external], activeWorkspaceId: active, memberWorkspaceIds: [] }),
    [active],
    "wait for confirmed membership",
  );
});

void test("assignee lookup avoids unrelated cached workspaces and follows workspace switching", () => {
  const active = MINE_OPEN.workspaceId;
  const other = "22222222-2222-4222-8222-222222222222";
  const task = { ...MINE_OPEN, workspaceId: other };
  assert.deepEqual(
    getAssignedTaskAssigneeWorkspaceIds({
      tasks: [task],
      activeWorkspaceId: active,
      memberWorkspaceIds: [active, other],
    }),
    [active],
  );
  assert.deepEqual(
    getAssignedTaskAssigneeWorkspaceIds({
      tasks: [MINE_OPEN, task],
      activeWorkspaceId: other,
      memberWorkspaceIds: [active, other],
    }),
    [other],
  );
  assert.deepEqual(
    getAssignedTaskAssigneeWorkspaceIds({
      tasks: [MINE_OPEN, task],
      activeWorkspaceId: null,
      memberWorkspaceIds: [active, other],
    }),
    [],
  );
});

const EXTERNAL_MEETING: AssignedTaskMeetingMetadata = {
  id: "12121212-1212-4212-8212-121212121212",
  workspaceId: "34343434-3434-4434-8434-343434343434",
  createdByUserId: "56565656-5656-4656-8656-565656565656",
  kind: "standard",
  isConfidential: true,
  participants: [{ userId: "56565656-5656-4656-8656-565656565656", displayName: "External host", avatarUrl: null }],
};

void test("external task source metadata enables status actions without a workspace meeting cache entry", () => {
  const meetings = mergeAssignedTaskMeetingMetadata({ workspaceMeetings: [], sourceMeetings: [EXTERNAL_MEETING] });
  const task = { ...OTHERS_DONE, sourceType: "meeting" as const, sourceId: EXTERNAL_MEETING.id };
  const kind = meetings.find((meeting) => meeting.id === task.sourceId)?.kind;
  const canUpdateStatus = canUpdateAssignedTaskStatus({ task, sourceMeetingKind: kind });
  assert.equal(canUpdateStatus, true, "checkbox and keyboard status actions use the source meeting kind");
  assert.deepEqual(
    filterReopenableAssignedTasks({
      tasks: [task],
      canUpdateStatus: (item) => canUpdateAssignedTaskStatus({ task: item, sourceMeetingKind: kind }),
    }),
    [task],
  );
  assert.deepEqual(
    getAssignedTaskViewDropPatch({
      task: { ...task, status: "open" },
      sourceView: "others",
      targetView: "done",
      permissions: { canUpdateStatus },
    }),
    {
      type: "status",
      status: "completed",
    },
  );
  assert.deepEqual(
    getAssignedTaskViewDropPatch({
      task: { ...task, isMine: true },
      sourceView: "done",
      targetView: "mine",
      permissions: { canUpdateStatus },
    }),
    {
      type: "status",
      status: "open",
    },
  );
  assert.deepEqual(
    meetings[0]?.participants,
    EXTERNAL_MEETING.participants,
    "external assignees are available without host workspace membership",
  );
});

void test("fresh task source metadata overrides stale workspace meeting permissions and participants", () => {
  const fresh = { ...EXTERNAL_MEETING, kind: "agent_intro" as const, participants: [] };
  const meetings = mergeAssignedTaskMeetingMetadata({
    workspaceMeetings: [{ ...EXTERNAL_MEETING, isConfidential: false }],
    sourceMeetings: [fresh],
  });
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0]?.isConfidential, true);
  assert.deepEqual(meetings[0].participants, []);
  assert.equal(
    canUpdateAssignedTaskStatus({
      task: taskStatusProbe({ sourceType: "meeting", isEditable: false }),
      sourceMeetingKind: meetings[0].kind,
    }),
    false,
  );
});
