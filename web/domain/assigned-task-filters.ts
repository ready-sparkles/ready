import type { AssignedTaskMeetingMetadata, Meeting, UnifiedAssignedTask } from "@readymeet/shared";

/**
 * Task list views within the active workspace: Mine (every open task that belongs to the viewer), Others
 * (open tasks belonging to other people, surfaced from meetings the viewer
 * may see — the server enforces the confidentiality rules), and Done
 * (completed tasks from both). Due dates no longer partition views.
 */
export type AssignedTaskView = "mine" | "others" | "done";

export type AssignedTaskViewDropPatch =
  | { type: "status"; status: "open" | "completed" }
  | { type: "assign-to-viewer" }
  | { type: "unassign" };

type AssignedTaskViewDropPermissions = {
  canUpdateStatus?: boolean;
  canReassign?: boolean;
};
export type AssignedTaskSortOverrides = Record<
  string,
  {
    view: AssignedTaskView;
    sortTime: number;
  }
>;
const TASK_VIEW_DROP_TARGET_PREFIX = "task-view:";

export function taskViewDropTargetId(view: AssignedTaskView): string {
  return `${TASK_VIEW_DROP_TARGET_PREFIX}${view}`;
}

export function taskViewFromDropTargetId(id: string): AssignedTaskView | null {
  if (!id.startsWith(TASK_VIEW_DROP_TARGET_PREFIX)) {
    return null;
  }
  const view = id.slice(TASK_VIEW_DROP_TARGET_PREFIX.length);

  return view === "mine" || view === "others" || view === "done" ? view : null;
}

function isAssignedTaskMine(task: { isMine?: boolean }): boolean {
  // Older cached payloads predate the field; they only ever contained the
  // viewer's own tasks.
  return task.isMine !== false;
}

/** Source metadata from the task response takes precedence over the workspace meeting cache. */
export function mergeAssignedTaskMeetingMetadata({
  workspaceMeetings,
  sourceMeetings,
}: {
  workspaceMeetings: AssignedTaskMeetingMetadata[];
  sourceMeetings: AssignedTaskMeetingMetadata[];
}): AssignedTaskMeetingMetadata[] {
  const byId = new Map(workspaceMeetings.map((meeting) => [meeting.id, meeting]));
  const mergedMeetings = sourceMeetings.reduce((merged, meeting) => {
    const nextMeetings = new Map(merged);
    nextMeetings.set(meeting.id, { ...merged.get(meeting.id), ...meeting });

    return nextMeetings;
  }, new Map(byId));

  return [...mergedMeetings.values()];
}

export function canUpdateAssignedTaskStatus({
  task,
  sourceMeetingKind,
}: {
  task: Pick<UnifiedAssignedTask, "editable" | "sourceType">;
  sourceMeetingKind?: Meeting["kind"] | null;
}): boolean {
  // Other people's meeting tasks stay read-only for content and ordering,
  // but workspace viewers may complete standard-meeting tasks. Missing
  // meeting metadata fails closed to match the API authorization boundary.
  return task.editable || (task.sourceType === "meeting" && sourceMeetingKind === "standard");
}

export function filterReopenableAssignedTasks({
  tasks,
  canUpdateStatus,
}: {
  tasks: UnifiedAssignedTask[];
  canUpdateStatus: (task: UnifiedAssignedTask) => boolean;
}): UnifiedAssignedTask[] {
  return tasks.filter((task) => task.status === "completed" && canUpdateStatus(task));
}

export function filterUnifiedAssignedTasksByWorkspace({
  tasks,
  workspaceId,
}: {
  tasks: UnifiedAssignedTask[];
  workspaceId: string | null | undefined;
}): UnifiedAssignedTask[] {
  if (workspaceId === null || workspaceId === undefined || workspaceId.length === 0) {
    return [];
  }

  return tasks.filter((task) => (task.viewerWorkspaceId ?? task.workspaceId) === workspaceId);
}

/** Load source-workspace assignees only for visible tasks and known memberships. */
export function getAssignedTaskAssigneeWorkspaceIds({
  tasks,
  activeWorkspaceId,
  memberWorkspaceIds,
}: {
  tasks: UnifiedAssignedTask[];
  activeWorkspaceId: string | null;
  memberWorkspaceIds: readonly string[];
}): string[] {
  if (activeWorkspaceId === null || activeWorkspaceId.length === 0) {
    return [];
  }
  const memberships = new Set(memberWorkspaceIds);

  return [
    ...new Set([
      activeWorkspaceId,
      ...filterUnifiedAssignedTasksByWorkspace({ tasks, workspaceId: activeWorkspaceId })
        .map((task) => task.workspaceId)
        .filter((workspaceId) => memberships.has(workspaceId)),
    ]),
  ];
}

export function filterUnifiedAssignedTasksByView({
  tasks,
  view,
}: {
  tasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
}): UnifiedAssignedTask[] {
  return tasks.filter((task) => {
    if (task.status === "dismissed") {
      return false;
    }
    if (view === "done") {
      return task.status === "completed";
    }
    if (task.status !== "open") {
      return false;
    }

    return view === "mine" ? isAssignedTaskMine(task) : !isAssignedTaskMine(task);
  });
}

export function getAssignedTaskSortTime({
  task,
  view,
  sortOverrides,
}: {
  task: UnifiedAssignedTask;
  view: AssignedTaskView;
  sortOverrides?: AssignedTaskSortOverrides;
}): number {
  const override = sortOverrides?.[task.taskId];
  if (override?.view === view) {
    return override.sortTime;
  }
  const primary = view === "done" ? (task.completedAt ?? task.updatedAt) : task.updatedAt;
  const timestamp = Date.parse(primary);

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareUnifiedAssignedTaskPair({
  first,
  second,
  view,
  sortOverrides,
}: {
  first: UnifiedAssignedTask;
  second: UnifiedAssignedTask;
  view: AssignedTaskView;
  sortOverrides?: AssignedTaskSortOverrides;
}): number {
  const sortDelta =
    getAssignedTaskSortTime({ task: second, view, sortOverrides }) -
    getAssignedTaskSortTime({ task: first, view, sortOverrides });

  return sortDelta !== 0 ? sortDelta : first.title.localeCompare(second.title);
}

export function sortUnifiedAssignedTasksForView({
  tasks,
  view,
  sortOverrides,
}: {
  tasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
  sortOverrides?: AssignedTaskSortOverrides;
}): UnifiedAssignedTask[] {
  return [...tasks].sort((first, second) => compareUnifiedAssignedTaskPair({ first, second, view, sortOverrides }));
}

function getReassignDropPatch({
  sourceView,
  targetView,
  permissions,
}: {
  sourceView: AssignedTaskView;
  targetView: AssignedTaskView;
  permissions: AssignedTaskViewDropPermissions;
}): AssignedTaskViewDropPatch | null {
  if (sourceView === "others" && targetView === "mine" && permissions.canReassign === true) {
    return { type: "assign-to-viewer" };
  }
  if (sourceView === "mine" && targetView === "others" && permissions.canReassign === true) {
    return { type: "unassign" };
  }

  return null;
}

function getStatusDropPatch({
  task,
  sourceView,
  targetView,
  canUpdateStatus,
}: {
  task: UnifiedAssignedTask;
  sourceView: AssignedTaskView;
  targetView: AssignedTaskView;
  canUpdateStatus: boolean;
}): AssignedTaskViewDropPatch | null {
  if (targetView === "done" && canUpdateStatus) {
    return { type: "status", status: "completed" };
  }
  if (targetView === "mine" && sourceView === "done" && isAssignedTaskMine(task) && canUpdateStatus) {
    return { type: "status", status: "open" };
  }

  return null;
}

/**
 * What dropping a task onto a view's nav item means now that views partition
 * by ownership: Done completes, dragging a completed task of your own back to
 * Mine reopens it. Dragging an assignable task from Others to Mine assigns it
 * to the viewer, while dragging from Mine to Others clears its assignee.
 */
export function getAssignedTaskViewDropPatch({
  task,
  sourceView,
  targetView,
  permissions = {},
}: {
  task: UnifiedAssignedTask;
  sourceView: AssignedTaskView;
  targetView: AssignedTaskView;
  permissions?: AssignedTaskViewDropPermissions;
}): AssignedTaskViewDropPatch | null {
  if (sourceView === targetView || task.status === "dismissed") {
    return null;
  }

  const canUpdateStatus = permissions.canUpdateStatus ?? task.editable;
  const reassignPatch = getReassignDropPatch({ sourceView, targetView, permissions });
  if (reassignPatch !== null) {
    return reassignPatch;
  }

  return getStatusDropPatch({ task, sourceView, targetView, canUpdateStatus });
}
