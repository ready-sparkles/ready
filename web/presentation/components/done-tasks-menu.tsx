"use client";

import { type ClearDoneTasksRange, getDoneTasksCutoff, type UnifiedAssignedTask } from "@readymeet/shared";

import { TaskSelectionMenu } from "./task-selection-menu";

type DoneTaskExtraAction = {
  label: string;
  /** @external TaskSelectionMenu extra action field */
  disabled: boolean;
  onSelect: () => void;
};

const options: { range: ClearDoneTasksRange; label: string }[] = [
  { range: "all", label: "Clear all done" },
  { range: "week", label: "Clear older than 1 week" },
  { range: "month", label: "Clear older than 1 month" },
  { range: "six_months", label: "Clear older than 6 months" },
  { range: "year", label: "Clear older than 1 year" },
];

export function DoneTasksMenu({
  tasks,
  isBusy,
  onClear,
  selection,
}: {
  tasks: Pick<UnifiedAssignedTask, "status" | "completedAt" | "updatedAt">[];
  isBusy: boolean;
  onClear: (range: ClearDoneTasksRange) => void;
  selection?: {
    canReopen: boolean;
    canClear: boolean;
    onReopen: () => void;
    onClear: () => void;
  };
}) {
  return (
    <TaskSelectionMenu
      className="workspace-done-tasks-menu"
      label="Clear completed tasks"
      busy={isBusy}
      hasSelection={Boolean(selection)}
      completeLabel="Mark as uncompleted"
      removeLabel="Clear selected"
      canComplete={selection?.canReopen ?? false}
      canRemove={selection?.canClear ?? false}
      onComplete={() => selection?.onReopen()}
      onRemove={() => selection?.onClear()}
      extraActions={options.map(({ range, label }) => {
        const cutoff = getDoneTasksCutoff({ range }).getTime();

        const isDisabled = !tasks.some(
          (task) => task.status === "completed" && new Date(task.completedAt ?? task.updatedAt).getTime() <= cutoff,
        );

        const action: DoneTaskExtraAction = { label, disabled: isDisabled, onSelect: () => onClear(range) };

        return action;
      })}
    />
  );
}
