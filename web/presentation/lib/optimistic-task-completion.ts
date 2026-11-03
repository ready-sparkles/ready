import type { AssignedTaskSummary, MeetingTask, UnifiedAssignedTask, WorkspaceTaskSection } from "@readymeet/shared";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  activeMeetingTasksStatusQueryKey,
  assignedTaskContextQueryKey,
  assignedTasksQueryKey,
  meetingDetailQueryKey,
  meetingNotesViewQueryKey,
  personalAssignedTasksQueryKey,
  terminalMeetingTasksStatusQueryKey,
} from "../../domain/query-keys";
import type { MeetingDetailPayload, MeetingNotesViewPayload } from "../../domain/types";
import type { MeetingTasksStatusView } from "../components/use-meeting-tasks-status";

export type OptimisticTaskStatus = "open" | "completed";

type WorkspaceAssignedTasksCache = {
  sections: WorkspaceTaskSection[];
  tasks: UnifiedAssignedTask[];
};

type PersonalAssignedTasksCache = {
  tasks: UnifiedAssignedTask[];
};

type OptimisticTaskPatch = {
  taskId: string;
  meetingId: string;
  userId?: string | null;
  status: OptimisticTaskStatus;
  completedAt?: string | null;
};

type TaskCacheSnapshot = {
  meetingDetail: MeetingDetailPayload | undefined;
  meetingNotesView: MeetingNotesViewPayload | undefined;
  activeTaskStatus: MeetingTasksStatusView | undefined;
  terminalTaskStatus: MeetingTasksStatusView | undefined;
  assignedTasks: AssignedTaskSummary[] | undefined;
  personalAssignedTasks: PersonalAssignedTasksCache | undefined;
  workspaceAssignedTasks: [QueryKey, WorkspaceAssignedTasksCache | undefined][];
  assignedTaskContext: AssignedTaskSummary | undefined;
};

type OptimisticTaskPatchInput = OptimisticTaskPatch | { task: MeetingTask };

function patchTask(input: { task: MeetingTask; patch: OptimisticTaskPatchInput }): MeetingTask {
  if ("task" in input.patch) {
    return input.patch.task;
  }

  return {
    ...input.task,
    status: input.patch.status,
    completedAt:
      input.patch.completedAt ??
      (input.patch.status === "completed" ? (input.task.completedAt ?? new Date().toISOString()) : null),
  };
}

function patchTaskList<T extends { items: MeetingTask[] } | null>(input: {
  taskList: T;
  patch: OptimisticTaskPatchInput;
}): T {
  if (input.taskList === null) {
    return input.taskList;
  }

  const taskId = "task" in input.patch ? input.patch.task.id : input.patch.taskId;
  const currentItems = input.taskList.items;
  const items = currentItems.map((task) => {
    if (task.id !== taskId) {
      return task;
    }

    return patchTask({ task, patch: input.patch });
  });
  const isChanged = items.some((task, index) => task !== currentItems[index]);

  return isChanged ? { ...input.taskList, items } : input.taskList;
}

function patchMeetingDetail<T extends { tasks: MeetingDetailPayload["tasks"] }>(input: {
  detail: T | undefined;
  patch: OptimisticTaskPatchInput;
}): T | undefined {
  if (input.detail?.tasks === undefined) {
    return input.detail;
  }

  return {
    ...input.detail,
    tasks: patchTaskList({ taskList: input.detail.tasks, patch: input.patch }),
  };
}

function patchTaskStatus(input: {
  status: MeetingTasksStatusView | undefined;
  patch: OptimisticTaskPatchInput;
}): MeetingTasksStatusView | undefined {
  if (input.status?.tasks === undefined) {
    return input.status;
  }

  return {
    ...input.status,
    tasks: patchTaskList({ taskList: input.status.tasks, patch: input.patch }),
  };
}

function patchAssignedTasks(input: {
  assignedTasks: AssignedTaskSummary[] | undefined;
  patch: OptimisticTaskPatchInput;
}): AssignedTaskSummary[] | undefined {
  if (input.assignedTasks === undefined) {
    return input.assignedTasks;
  }

  const taskId = "task" in input.patch ? input.patch.task.id : input.patch.taskId;
  const currentTasks = input.assignedTasks;
  const nextTasks = currentTasks.map((entry) => {
    if (entry.task.id !== taskId) {
      return entry;
    }

    return {
      ...entry,
      task: patchTask({ task: entry.task, patch: input.patch }),
    };
  });
  const isChanged = nextTasks.some((entry, index) => entry !== currentTasks[index]);

  return isChanged ? nextTasks : input.assignedTasks;
}

function patchAssignedTaskContext(input: {
  context: AssignedTaskSummary | undefined;
  patch: OptimisticTaskPatchInput;
}): AssignedTaskSummary | undefined {
  if (input.context === undefined) {
    return input.context;
  }

  const taskId = "task" in input.patch ? input.patch.task.id : input.patch.taskId;
  if (input.context.task.id !== taskId) {
    return input.context;
  }

  return {
    ...input.context,
    task: patchTask({ task: input.context.task, patch: input.patch }),
  };
}

function patchUnifiedAssignedTask(input: {
  task: UnifiedAssignedTask;
  patch: OptimisticTaskPatchInput;
}): UnifiedAssignedTask {
  if ("task" in input.patch) {
    return {
      ...input.task,
      title: input.patch.task.title,
      description: input.patch.task.description,
      status: input.patch.task.status,
      dueDate: input.patch.task.dueDate,
      revision: input.patch.task.revision,
      updatedAt: input.patch.task.updatedAt,
      completedAt: input.patch.task.completedAt,
    };
  }

  return {
    ...input.task,
    status: input.patch.status,
    completedAt:
      input.patch.completedAt ??
      (input.patch.status === "completed" ? (input.task.completedAt ?? new Date().toISOString()) : null),
  };
}

function patchWorkspaceAssignedTasks(input: {
  cache: WorkspaceAssignedTasksCache | undefined;
  patch: OptimisticTaskPatchInput;
}): WorkspaceAssignedTasksCache | undefined {
  if (input.cache === undefined) {
    return input.cache;
  }

  const taskId = "task" in input.patch ? input.patch.task.id : input.patch.taskId;
  const currentTasks = input.cache.tasks;
  const tasks = currentTasks.map((task) => {
    if (task.sourceType !== "meeting" || task.taskId !== taskId) {
      return task;
    }

    return patchUnifiedAssignedTask({ task, patch: input.patch });
  });
  const isChanged = tasks.some((task, index) => task !== currentTasks[index]);

  return isChanged ? { ...input.cache, tasks } : input.cache;
}

function patchPersonalAssignedTasks(input: {
  cache: PersonalAssignedTasksCache | undefined;
  patch: OptimisticTaskPatchInput;
}): PersonalAssignedTasksCache | undefined {
  if (input.cache === undefined) {
    return input.cache;
  }

  const taskId = "task" in input.patch ? input.patch.task.id : input.patch.taskId;
  const currentTasks = input.cache.tasks;
  const tasks = currentTasks.map((task) => {
    if (task.sourceType !== "meeting" || task.taskId !== taskId) {
      return task;
    }

    return patchUnifiedAssignedTask({ task, patch: input.patch });
  });
  const isChanged = tasks.some((task, index) => task !== currentTasks[index]);

  return isChanged ? { ...input.cache, tasks } : input.cache;
}

function snapshotTaskCaches(input: {
  queryClient: QueryClient;
  patch: Pick<OptimisticTaskPatch, "meetingId" | "taskId" | "userId">;
}): TaskCacheSnapshot {
  return {
    meetingNotesView: input.queryClient.getQueryData<MeetingNotesViewPayload>(
      meetingNotesViewQueryKey(input.patch.meetingId),
    ),
    meetingDetail: input.queryClient.getQueryData<MeetingDetailPayload>(meetingDetailQueryKey(input.patch.meetingId)),
    activeTaskStatus: input.queryClient.getQueryData<MeetingTasksStatusView>(
      activeMeetingTasksStatusQueryKey(input.patch.meetingId),
    ),
    terminalTaskStatus: input.queryClient.getQueryData<MeetingTasksStatusView>(
      terminalMeetingTasksStatusQueryKey(input.patch.meetingId),
    ),
    assignedTasks: input.queryClient.getQueryData<AssignedTaskSummary[]>(assignedTasksQueryKey(input.patch.userId)),
    personalAssignedTasks: input.queryClient.getQueryData<PersonalAssignedTasksCache>(
      personalAssignedTasksQueryKey(input.patch.userId),
    ),
    workspaceAssignedTasks: input.queryClient.getQueriesData<WorkspaceAssignedTasksCache>({
      queryKey: ["assignedTasks", "workspace"],
    }),
    assignedTaskContext: input.queryClient.getQueryData<AssignedTaskSummary>(
      assignedTaskContextQueryKey(input.patch.taskId),
    ),
  };
}

export function patchTaskInCaches(input: {
  queryClient: QueryClient;
  patch: OptimisticTaskPatch | { task: MeetingTask; userId?: string | null };
}): void {
  const taskId = "task" in input.patch ? input.patch.task.id : input.patch.taskId;
  const meetingId = "task" in input.patch ? input.patch.task.meetingId : input.patch.meetingId;
  const userId = input.patch.userId;

  input.queryClient.setQueryData<MeetingDetailPayload | undefined>(meetingDetailQueryKey(meetingId), (current) =>
    patchMeetingDetail({ detail: current, patch: input.patch }),
  );
  input.queryClient.setQueryData<MeetingNotesViewPayload | undefined>(meetingNotesViewQueryKey(meetingId), (current) =>
    patchMeetingDetail({ detail: current, patch: input.patch }),
  );
  input.queryClient.setQueryData<MeetingTasksStatusView | undefined>(
    activeMeetingTasksStatusQueryKey(meetingId),
    (current) => patchTaskStatus({ status: current, patch: input.patch }),
  );
  input.queryClient.setQueryData<MeetingTasksStatusView | undefined>(
    terminalMeetingTasksStatusQueryKey(meetingId),
    (current) => patchTaskStatus({ status: current, patch: input.patch }),
  );
  input.queryClient.setQueryData<AssignedTaskSummary[] | undefined>(assignedTasksQueryKey(userId), (current) =>
    patchAssignedTasks({ assignedTasks: current, patch: input.patch }),
  );
  input.queryClient.setQueryData<PersonalAssignedTasksCache | undefined>(
    personalAssignedTasksQueryKey(userId),
    (current) => patchPersonalAssignedTasks({ cache: current, patch: input.patch }),
  );
  input.queryClient.setQueriesData<WorkspaceAssignedTasksCache | undefined>(
    { queryKey: ["assignedTasks", "workspace"] },
    (current) => patchWorkspaceAssignedTasks({ cache: current, patch: input.patch }),
  );
  input.queryClient.setQueryData<AssignedTaskSummary | undefined>(assignedTaskContextQueryKey(taskId), (current) =>
    patchAssignedTaskContext({ context: current, patch: input.patch }),
  );
}

async function cancelTaskQueries(input: {
  queryClient: QueryClient;
  patch: Pick<OptimisticTaskPatch, "meetingId" | "taskId" | "userId">;
}): Promise<void> {
  await Promise.all([
    input.queryClient.cancelQueries({ queryKey: meetingDetailQueryKey(input.patch.meetingId) }),
    input.queryClient.cancelQueries({ queryKey: activeMeetingTasksStatusQueryKey(input.patch.meetingId) }),
    input.queryClient.cancelQueries({ queryKey: terminalMeetingTasksStatusQueryKey(input.patch.meetingId) }),
    input.queryClient.cancelQueries({ queryKey: assignedTasksQueryKey(input.patch.userId) }),
    input.queryClient.cancelQueries({ queryKey: personalAssignedTasksQueryKey(input.patch.userId) }),
    input.queryClient.cancelQueries({ queryKey: ["assignedTasks", "workspace"] }),
    input.queryClient.cancelQueries({ queryKey: assignedTaskContextQueryKey(input.patch.taskId) }),
  ]);
}

export function invalidateTaskQueries(input: {
  queryClient: QueryClient;
  patch: Pick<OptimisticTaskPatch, "meetingId" | "taskId" | "userId">;
}): void {
  void input.queryClient.invalidateQueries({ queryKey: meetingDetailQueryKey(input.patch.meetingId) });
  void input.queryClient.invalidateQueries({ queryKey: activeMeetingTasksStatusQueryKey(input.patch.meetingId) });
  void input.queryClient.invalidateQueries({ queryKey: terminalMeetingTasksStatusQueryKey(input.patch.meetingId) });
  void input.queryClient.invalidateQueries({ queryKey: assignedTasksQueryKey(input.patch.userId) });
  void input.queryClient.invalidateQueries({ queryKey: personalAssignedTasksQueryKey(input.patch.userId) });
  void input.queryClient.invalidateQueries({ queryKey: ["assignedTasks", "workspace"] });
  void input.queryClient.invalidateQueries({ queryKey: assignedTaskContextQueryKey(input.patch.taskId) });
}

function restoreTaskCaches(input: {
  queryClient: QueryClient;
  patch: Pick<OptimisticTaskPatch, "meetingId" | "taskId" | "userId">;
  snapshot: TaskCacheSnapshot;
}): void {
  input.queryClient.setQueryData(meetingDetailQueryKey(input.patch.meetingId), input.snapshot.meetingDetail);
  input.queryClient.setQueryData(meetingNotesViewQueryKey(input.patch.meetingId), input.snapshot.meetingNotesView);
  input.queryClient.setQueryData(
    activeMeetingTasksStatusQueryKey(input.patch.meetingId),
    input.snapshot.activeTaskStatus,
  );
  input.queryClient.setQueryData(
    terminalMeetingTasksStatusQueryKey(input.patch.meetingId),
    input.snapshot.terminalTaskStatus,
  );
  input.queryClient.setQueryData(assignedTasksQueryKey(input.patch.userId), input.snapshot.assignedTasks);
  input.queryClient.setQueryData(
    personalAssignedTasksQueryKey(input.patch.userId),
    input.snapshot.personalAssignedTasks,
  );
  input.snapshot.workspaceAssignedTasks.forEach(([queryKey, data]) => {
    input.queryClient.setQueryData(queryKey, data);
  });
  input.queryClient.setQueryData(assignedTaskContextQueryKey(input.patch.taskId), input.snapshot.assignedTaskContext);
}

type OptimisticTaskCompletionController = {
  apply: (patch: OptimisticTaskPatch) => Promise<number>;
  reconcile: (input: { task: MeetingTask; userId?: string | null; mutationVersion?: number }) => boolean;
  rollback: (input: { patch: OptimisticTaskPatch; mutationVersion?: number }) => boolean;
  reapplyPending: () => void;
  hasPending: (taskId: string) => boolean;
  pendingTaskIds: () => Set<string>;
};

export function createOptimisticTaskCompletionController(queryClient: QueryClient): OptimisticTaskCompletionController {
  const pendingPatches = new Map<string, OptimisticTaskPatch>();
  const snapshots = new Map<string, TaskCacheSnapshot>();
  const mutationVersions = new Map<string, number>();

  function nextMutationVersion(taskId: string): number {
    const nextVersion = (mutationVersions.get(taskId) ?? 0) + 1;
    mutationVersions.set(taskId, nextVersion);

    return nextVersion;
  }

  function isCurrentMutation(input: { taskId: string; mutationVersion?: number }): boolean {
    return input.mutationVersion === undefined || mutationVersions.get(input.taskId) === input.mutationVersion;
  }

  return {
    async apply(patch: OptimisticTaskPatch) {
      const normalizedPatch = {
        ...patch,
        completedAt: patch.completedAt ?? (patch.status === "completed" ? new Date().toISOString() : null),
      };
      await cancelTaskQueries({ queryClient, patch: normalizedPatch });
      if (!snapshots.has(normalizedPatch.taskId)) {
        snapshots.set(normalizedPatch.taskId, snapshotTaskCaches({ queryClient, patch: normalizedPatch }));
      }
      const mutationVersion = nextMutationVersion(normalizedPatch.taskId);
      pendingPatches.set(normalizedPatch.taskId, normalizedPatch);
      patchTaskInCaches({ queryClient, patch: normalizedPatch });

      return mutationVersion;
    },
    reconcile(input: { task: MeetingTask; userId?: string | null; mutationVersion?: number }) {
      if (!isCurrentMutation({ taskId: input.task.id, mutationVersion: input.mutationVersion })) {
        return false;
      }
      pendingPatches.delete(input.task.id);
      snapshots.delete(input.task.id);
      patchTaskInCaches({ queryClient, patch: { task: input.task, userId: input.userId } });

      return true;
    },
    rollback(input: { patch: OptimisticTaskPatch; mutationVersion?: number }) {
      if (!isCurrentMutation({ taskId: input.patch.taskId, mutationVersion: input.mutationVersion })) {
        return false;
      }
      pendingPatches.delete(input.patch.taskId);
      const snapshot = snapshots.get(input.patch.taskId);
      snapshots.delete(input.patch.taskId);
      if (snapshot !== undefined) {
        restoreTaskCaches({ queryClient, patch: input.patch, snapshot });
      }

      return true;
    },
    reapplyPending() {
      Array.from(pendingPatches.values()).forEach((pendingPatch) => {
        patchTaskInCaches({ queryClient, patch: pendingPatch });
      });
    },
    hasPending(taskId: string) {
      return pendingPatches.has(taskId);
    },
    pendingTaskIds() {
      return new Set(pendingPatches.keys());
    },
  };
}
