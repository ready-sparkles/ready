import type { UnifiedAssignedTask } from "@readymeet/shared";

type AssignedTaskDeletePlan = {
  meetingTasks: {
    meetingId: string;
    taskId: string;
  }[];
  workspaceTaskGroups: {
    workspaceId: string;
    taskIds: string[];
  }[];
};

export function buildAssignedTaskDeletePlan(tasks: UnifiedAssignedTask[]): AssignedTaskDeletePlan {
  const accumulated = tasks.reduce<{
    meetingTasks: AssignedTaskDeletePlan["meetingTasks"];
    workspaceTaskIdsByWorkspaceId: Map<string, string[]>;
  }>(
    (acc, task) => {
      if (task.sourceType === "meeting") {
        return {
          meetingTasks: [...acc.meetingTasks, { meetingId: task.sourceId, taskId: task.taskId }],
          workspaceTaskIdsByWorkspaceId: acc.workspaceTaskIdsByWorkspaceId,
        };
      }

      const existingTaskIds = acc.workspaceTaskIdsByWorkspaceId.get(task.workspaceId);
      const nextTaskIds = existingTaskIds === undefined ? [task.taskId] : [...existingTaskIds, task.taskId];
      const nextWorkspaceTaskIdsByWorkspaceId = new Map(acc.workspaceTaskIdsByWorkspaceId);
      nextWorkspaceTaskIdsByWorkspaceId.set(task.workspaceId, nextTaskIds);

      return {
        meetingTasks: acc.meetingTasks,
        workspaceTaskIdsByWorkspaceId: nextWorkspaceTaskIdsByWorkspaceId,
      };
    },
    { meetingTasks: [], workspaceTaskIdsByWorkspaceId: new Map<string, string[]>() },
  );

  return {
    meetingTasks: accumulated.meetingTasks,
    workspaceTaskGroups: Array.from(accumulated.workspaceTaskIdsByWorkspaceId, ([workspaceId, taskIds]) => ({
      workspaceId,
      taskIds,
    })),
  };
}
