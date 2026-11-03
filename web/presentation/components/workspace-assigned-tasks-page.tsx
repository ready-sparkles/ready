"use client";

import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type AssignedTaskMeetingMetadata,
  type ClearDoneTasksRange,
  type Meeting,
  type UnifiedAssignedTask,
  UNPLACED_ASSIGNED_TASK_SECTION_ID,
  type WorkspaceTaskSection,
} from "@readymeet/shared";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type { CSSProperties, Dispatch, MouseEvent, ReactNode, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  clearPersonalDoneTasks,
  clearSelectedDoneTasks,
  createWorkspaceTask,
  deleteWorkspaceTasks,
  deleteWorkspaceTaskSection,
  listMyWorkspaceIds,
  listPersonalAssignedTasks,
  listWorkspaceMembers,
  reorderWorkspaceTasks,
  updateMeetingTask,
  updateWorkspaceTask,
  updateWorkspaceTaskSection,
} from "../../composition/api";
import { workspaceMeetingsOptions, workspaceMeetingsQueryKey } from "../../composition/workspace-meetings-query";
import { buildAssignedTaskDeletePlan } from "../../domain/assigned-task-deletion";
import {
  type AssignedTaskSortOverrides,
  type AssignedTaskView,
  type AssignedTaskViewDropPatch,
  canUpdateAssignedTaskStatus,
  filterReopenableAssignedTasks,
  filterUnifiedAssignedTasksByView,
  filterUnifiedAssignedTasksByWorkspace,
  getAssignedTaskAssigneeWorkspaceIds,
  getAssignedTaskSortTime,
  getAssignedTaskViewDropPatch,
  mergeAssignedTaskMeetingMetadata,
  sortUnifiedAssignedTasksForView,
  taskViewFromDropTargetId,
} from "../../domain/assigned-task-filters";
import { personalAssignedTasksQueryKey } from "../../domain/query-keys";
import { updateTaskSelection } from "../../domain/task-selection-updates";
import { getCachedWorkspaceMeetings, setCachedWorkspaceMeetings } from "../../domain/workspace-meetings-cache";

import { useAuth } from "./auth-provider";
import { DoneTasksMenu } from "./done-tasks-menu";
import { mergeTaskAssigneeParticipants, type TaskAssigneeParticipant, TaskAssigneePill } from "./task-assignee-pill";
import { TaskSelectionMenu } from "./task-selection-menu";
import { type TaskPaintSelectionBox, useTaskPaintSelection } from "./use-task-paint-selection";
import { CalendarChevronIcon } from "./workspace-nav-icons";
import { ActivityNavIcon, LayersNavIcon, StarNavIcon, WorkspaceShell } from "./workspace-shell";
import { TaskCheckboxIcon } from "./workspace-tasks-section";

type TaskDraft = {
  title: string;
  description: string;
};

type RenderSection = {
  groupId: string;
  label: string;
  section: WorkspaceTaskSection;
  tasks: UnifiedAssignedTask[];
};

type WorkspaceAssignedTasksCache = {
  sections?: WorkspaceTaskSection[];
  tasks: UnifiedAssignedTask[];
};
type CreateTaskInsertionTarget = { type: "task"; taskId: string } | { type: "section"; sectionId: string } | null;
type DragInsertionTarget = {
  sectionId: string;
  index: number;
} | null;
type DragAnchorTarget = {
  targetSectionId: string;
  beforeTaskId?: string;
  afterTaskId?: string;
};

type TaskStatus = UnifiedAssignedTask["status"];
type StatusLingerState = {
  view: AssignedTaskView;
  isFading: boolean;
  sortTime: number;
};

type PendingCreateUpdate = {
  title: string;
  description: string | null;
};
type PendingCreateResolution = {
  task: UnifiedAssignedTask;
  pendingUpdate: PendingCreateUpdate | undefined;
};
type PendingCreateSectionResolution = {
  section: WorkspaceTaskSection;
  pendingTitle: string | undefined;
};
type SectionDeleteConfirmation = {
  section: WorkspaceTaskSection;
  tasks: UnifiedAssignedTask[];
};
type OptimisticTaskOrderHint = {
  sectionId: string;
  beforeTaskId?: string;
  afterTaskId?: string;
};

const NEW_TASK_PLACEHOLDER_TITLE = "New Task";
const TASK_STATUS_LINGER_MS = 3_000;
const TASK_STATUS_FADE_MS = 260;
const TASK_NAV_DRAG_PREVIEW_WIDTH = 136;
const TASK_NAV_DRAG_PREVIEW_ROW_HEIGHT = 13;
const TASK_NAV_DRAG_PREVIEW_STACK_OFFSET = 4;
const PERSONAL_TASK_SECTION_ID = "00000000-0000-4000-8000-000000000000";
const PERSONAL_TASK_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const PERSONAL_TASK_SECTION_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const TASK_LIST_BACK_TO_TOP_SCROLL_Y = 48;
const MILLISECONDS_PER_DAY = 86_400_000;
const DAYS_IN_WEEK = 7;
const MONTH_KEY_PAD_LENGTH = 2;
const POSITION_AVERAGE_DIVISOR = 2;
const POSITION_OFFSET_BEFORE = 1;
const OPTIMISTIC_PLACEHOLDER_MATCH_MS = 3_000;
const RECT_CENTER_DIVISOR = 2;
const BINARY_SEARCH_MIDDLE_DIVISOR = 2;
const ROW_GROWTH_TRANSITION_MS = 220;
const ROW_GROWTH_FALLBACK_MS = TASK_STATUS_FADE_MS;
const ROW_HEIGHT_CHANGE_THRESHOLD = 1;
const DRAG_PREVIEW_MAX_TASKS = 3;
const DRAG_PREVIEW_MULTI_ROW_HEIGHT = 44;
const DRAG_PREVIEW_STACK_GAP = 10;
const DRAG_PREVIEW_BADGE_INSET = 12;
const DRAG_PREVIEW_BADGE_MIN = 24;
const DRAG_PREVIEW_BADGE_MAX_OFFSET = 8;
const DRAG_PREVIEW_SECONDARY_OPACITY = 0.88;
const DRAG_PREVIEW_TRANSLATE_X = 3;
const DRAG_PREVIEW_NAV_TRANSLATE_X = 2;
const PERSONAL_TASKS_STALE_TIME_MS = 20_000;
const WORKSPACE_QUERY_STALE_TIME_MS = 30_000;
const POINTER_SENSOR_ACTIVATION_DISTANCE = 6;
const MISSING_SESSION_ERROR = "Missing session";
const TASK_ASSIGNEE_UNAVAILABLE_ERROR = "Task assignee is not available.";
const SECTION_DELETE_TITLE = "Delete section?";

function isPresentString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

function taskViewCopy(view: AssignedTaskView) {
  if (view === "mine") {
    return { title: "Mine" };
  }
  if (view === "done") {
    return { title: "Done" };
  }

  return { title: "Others" };
}

function activeSidebarViewForTaskView(view: AssignedTaskView) {
  if (view === "mine") {
    return "tasks-mine" as const;
  }
  if (view === "done") {
    return "tasks-activity" as const;
  }

  return "tasks-others" as const;
}

function EmptyTaskViewIcon({ view }: { view: AssignedTaskView }) {
  return (
    <div className="workspace-task-empty-visual" aria-hidden="true">
      {view === "mine" ? <StarNavIcon /> : view === "done" ? <ActivityNavIcon /> : <LayersNavIcon />}
    </div>
  );
}

function TextDocumentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-source-icon" fill="none">
      <path
        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NewTaskButtonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-topbar-plus-icon" fill="none">
      <path
        d="M12 4.5v15m7.5-7.5h-15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TaskListBackToTopButton() {
  const [isVisible, setIsVisible] = useState(false);

  useLayoutEffect(() => {
    const update = () => setIsVisible(window.scrollY > TASK_LIST_BACK_TO_TOP_SCROLL_Y);
    update();
    window.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(document.documentElement);
    observer.observe(document.body);

    return () => {
      window.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <button
      type="button"
      className="workspace-task-topbar-button workspace-task-back-to-top"
      style={{ display: isVisible ? undefined : "none" }}
      aria-label="Back to top"
      title="Back to top"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={() =>
        window.scrollTo({
          top: 0,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        })
      }
    >
      <CalendarChevronIcon />
    </button>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-topbar-search-icon" fill="none">
      <path
        d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchClearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-search-clear-icon">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="m8.75 8.75 6.5 6.5M15.25 8.75l-6.5 6.5" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();

  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable ||
    Boolean(target.closest('[role="menu"], [role="listbox"]'))
  );
}

const taskActivityDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const taskActivityDateTooltipFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const taskActivityMonthFormatter = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const taskActivityMonthYearFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function buildRenderSectionsForAssignedTasks(input: {
  visibleTasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
  statusLingerByTaskId: Record<string, StatusLingerState>;
  defaultSection: WorkspaceTaskSection;
}): RenderSection[] {
  const { visibleTasks, view, statusLingerByTaskId, defaultSection } = input;
  const statusLingerSortOverrides = Object.fromEntries<AssignedTaskSortOverrides[string]>(
    Object.entries(statusLingerByTaskId).map(([taskId, state]) => [
      taskId,
      {
        view: state.view,
        sortTime: state.sortTime,
      },
    ]),
  );
  const tasks = sortUnifiedAssignedTasksForView({
    tasks: visibleTasks,
    view,
    sortOverrides: statusLingerSortOverrides,
  });
  const referenceTimestamp = Date.now();
  const periods = new Map<string, RenderSection>();
  tasks.forEach((task) => {
    const period = taskActivityPeriod({
      timestamp: getAssignedTaskSortTime({ task, view, sortOverrides: statusLingerSortOverrides }),
      referenceTimestamp,
    });
    const groupId = `task-period-${period.key}`;
    const existingPeriod = periods.get(groupId);
    if (existingPeriod) {
      periods.set(groupId, { ...existingPeriod, tasks: [...existingPeriod.tasks, task] });
    } else {
      periods.set(groupId, {
        groupId,
        label: period.label,
        section: { ...defaultSection, title: taskViewCopy(view).title },
        tasks: [task],
      });
    }
  });

  return [...periods.values()];
}

function taskActivityPeriod(input: { timestamp: number; referenceTimestamp: number }) {
  const { timestamp, referenceTimestamp } = input;
  const activity = new Date(timestamp);
  const reference = new Date(referenceTimestamp);
  const activityDay = Date.UTC(activity.getUTCFullYear(), activity.getUTCMonth(), activity.getUTCDate());
  const referenceDay = Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate());
  const weekStart = referenceDay - reference.getUTCDay() * MILLISECONDS_PER_DAY;
  if (activityDay >= weekStart) {
    return { key: "this-week", label: "This week" };
  }
  if (activityDay >= weekStart - DAYS_IN_WEEK * MILLISECONDS_PER_DAY) {
    return { key: "last-week", label: "Last week" };
  }
  const monthKey = `${activity.getUTCFullYear()}-${String(activity.getUTCMonth() + 1).padStart(MONTH_KEY_PAD_LENGTH, "0")}`;
  const referenceMonthKey = `${reference.getUTCFullYear()}-${String(reference.getUTCMonth() + 1).padStart(MONTH_KEY_PAD_LENGTH, "0")}`;
  if (monthKey === referenceMonthKey) {
    return { key: monthKey, label: "This month" };
  }

  return {
    key: monthKey,
    label: (activity.getUTCFullYear() === reference.getUTCFullYear()
      ? taskActivityMonthFormatter
      : taskActivityMonthYearFormatter
    ).format(activity),
  };
}

function sourceLinkForTask(task: UnifiedAssignedTask) {
  return task.sourceMeeting ? `/workspace/${task.sourceMeeting.id}` : null;
}

function taskDescription(task: UnifiedAssignedTask) {
  return task.description?.trim() ?? "";
}

// In-flight optimistic creates (temporary id -> server id, null on failure) so a
// delete issued before the create resolves can target the real task.
const pendingTaskCreateIds = new Map<string, Promise<string | null>>();
// Removed while their create was in flight; the delete path removes the server task.
const deletedTemporaryTaskIds = new Set<string>();

function trackPendingTaskCreate(input: { temporaryTaskId: string; createRequest: Promise<{ id: string }> }) {
  const settleTaskId = async (): Promise<string | null> => {
    try {
      return (await input.createRequest).id;
    } catch (error) {
      // The create path surfaces the failure; a pending delete just has nothing to remove.
      if (error instanceof Error) {
        return null;
      }

      return null;
    }
  };
  pendingTaskCreateIds.set(input.temporaryTaskId, settleTaskId());
}

function forgetPendingTaskCreate(temporaryTaskId: string) {
  // The id mapping is kept: the row can keep its temporary id after the create
  // resolves (e.g. while it is still being edited), and a later delete needs it.
  deletedTemporaryTaskIds.delete(temporaryTaskId);
}

async function resolveTasksForDelete(tasks: UnifiedAssignedTask[]): Promise<UnifiedAssignedTask[]> {
  const resolved = await Promise.all(
    tasks.map(async (task) => {
      if (!isTemporaryTaskId(task.taskId)) {
        return task;
      }
      deletedTemporaryTaskIds.add(task.taskId);
      const serverTaskId = (await pendingTaskCreateIds.get(task.taskId)) ?? null;

      return serverTaskId === null ? null : { ...task, taskId: serverTaskId, sourceId: serverTaskId };
    }),
  );

  return resolved.filter((task): task is UnifiedAssignedTask => task !== null);
}

function isTemporaryTaskId(taskId: string) {
  return taskId.startsWith("temporary-task:");
}

function updateCachedTaskContent(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  task: UnifiedAssignedTask;
  title: string;
  description: string | null;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, task, title, description } = input;
  if (data === undefined) {
    return data;
  }
  const updatedAt = new Date().toISOString();
  const tasks = data.tasks.map((item) => {
    if (item.sourceType !== task.sourceType || item.taskId !== task.taskId) {
      return item;
    }

    return {
      ...item,
      title,
      description,
      revision: item.revision + 1,
      updatedAt,
    };
  });
  const hasChanged = tasks.some((item, index) => item !== data.tasks[index]);

  return hasChanged ? { ...data, tasks } : data;
}

function updateCachedTaskStatus(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  task: UnifiedAssignedTask;
  status: TaskStatus;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, task, status } = input;
  if (data === undefined) {
    return data;
  }
  const now = new Date().toISOString();
  const tasks = data.tasks.map((item) => {
    if (item.sourceType !== task.sourceType || item.taskId !== task.taskId) {
      return item;
    }

    return {
      ...item,
      status,
      completedAt: status === "completed" ? now : null,
      revision: item.revision + 1,
      updatedAt: now,
    };
  });
  const hasChanged = tasks.some((item, index) => item !== data.tasks[index]);

  return hasChanged ? { ...data, tasks } : data;
}

function updateCachedTaskAssignee(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  task: UnifiedAssignedTask;
  currentUserId: string;
  assignee: TaskAssigneeParticipant | null;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, task, currentUserId, assignee } = input;
  if (data === undefined) {
    return data;
  }
  const now = new Date().toISOString();
  const nextOwnerUserId = assignee?.userId ?? null;
  const tasks = data.tasks.map((item) => {
    if (item.sourceType !== task.sourceType || item.taskId !== task.taskId) {
      return item;
    }

    return {
      ...item,
      isMine: nextOwnerUserId === currentUserId,
      owner:
        nextOwnerUserId !== null && nextOwnerUserId !== "" && nextOwnerUserId !== currentUserId && assignee !== null
          ? {
              userId: assignee.userId,
              displayName: assignee.displayName,
              avatarUrl: assignee.avatarUrl,
            }
          : null,
      revision: item.revision + 1,
      updatedAt: now,
    };
  });
  const hasChanged = tasks.some((item, index) => item !== data.tasks[index]);

  return hasChanged ? { ...data, tasks } : data;
}

function updateCachedTaskViewPatch(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  task: UnifiedAssignedTask;
  patch: AssignedTaskViewDropPatch;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, task, patch } = input;
  if (data === undefined) {
    return data;
  }
  if (patch.type !== "status") {
    return data;
  }
  const now = new Date().toISOString();
  const tasks = data.tasks.map((item) => {
    if (item.sourceType !== task.sourceType || item.taskId !== task.taskId) {
      return item;
    }

    return {
      ...item,
      status: patch.status,
      completedAt:
        patch.status === "completed" ? (item.status === "completed" ? (item.completedAt ?? now) : now) : null,
      revision: item.revision + 1,
      updatedAt: now,
    };
  });
  const hasChanged = tasks.some((item, index) => item !== data.tasks[index]);

  return hasChanged ? { ...data, tasks } : data;
}

function addCachedTask(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  task: UnifiedAssignedTask;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, task } = input;
  if (data === undefined) {
    return data;
  }
  const isReplaced = data.tasks.some((item) => item.sourceType === task.sourceType && item.taskId === task.taskId);
  const tasks = isReplaced
    ? data.tasks.map((item) => (item.sourceType === task.sourceType && item.taskId === task.taskId ? task : item))
    : [...data.tasks, task];

  return {
    ...data,
    tasks,
  };
}

function removeCachedTask(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  taskId: string;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, taskId } = input;
  if (data === undefined) {
    return data;
  }

  return {
    ...data,
    tasks: data.tasks.filter((task) => task.taskId !== taskId),
  };
}

function addCachedSection(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  section: WorkspaceTaskSection;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, section } = input;
  if (data === undefined) {
    return data;
  }
  const sections = data.sections ?? [];
  const isReplaced = sections.some((item) => item.id === section.id);

  return {
    ...data,
    sections: isReplaced ? sections.map((item) => (item.id === section.id ? section : item)) : [...sections, section],
  };
}

function removeCachedSection(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  sectionId: string;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, sectionId } = input;
  if (data === undefined) {
    return data;
  }

  return {
    ...data,
    sections: (data.sections ?? []).filter((section) => section.id !== sectionId),
  };
}

function updateCachedSectionTitle(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  sectionId: string;
  title: string;
}): WorkspaceAssignedTasksCache | undefined {
  const { data, sectionId, title } = input;
  if (data === undefined) {
    return data;
  }
  const now = new Date().toISOString();

  return {
    ...data,
    sections: (data.sections ?? []).map((section) =>
      section.id === sectionId ? { ...section, title, updatedAt: now } : section,
    ),
  };
}

function reorderCachedTasks(input: {
  data: WorkspaceAssignedTasksCache | undefined;
  reorder: {
    movedTaskIds: string[];
    targetSectionId: string;
    beforeTaskId?: string;
    afterTaskId?: string;
  };
}): WorkspaceAssignedTasksCache | undefined {
  const { data, reorder } = input;
  if (data === undefined) {
    return data;
  }
  const movedIdSet = new Set(reorder.movedTaskIds);
  const taskById = new Map(data.tasks.map((task) => [task.taskId, task]));
  const movedTasks = reorder.movedTaskIds
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is UnifiedAssignedTask => task !== undefined);
  if (movedTasks.length !== reorder.movedTaskIds.length) {
    return data;
  }

  const sectionIdsToRenumber = new Set([...movedTasks.map((task) => task.sectionId), reorder.targetSectionId]);
  const targetRows = sortTasksForDisplay(
    data.tasks.filter((task) => task.sectionId === reorder.targetSectionId && !movedIdSet.has(task.taskId)),
  );
  const beforeIndex =
    reorder.beforeTaskId !== undefined && reorder.beforeTaskId !== ""
      ? targetRows.findIndex((task) => task.taskId === reorder.beforeTaskId)
      : -1;
  const afterIndex =
    reorder.afterTaskId !== undefined && reorder.afterTaskId !== ""
      ? targetRows.findIndex((task) => task.taskId === reorder.afterTaskId)
      : -1;
  const insertIndex =
    reorder.beforeTaskId !== undefined && reorder.beforeTaskId !== ""
      ? beforeIndex >= 0
        ? beforeIndex
        : targetRows.length
      : reorder.afterTaskId !== undefined && reorder.afterTaskId !== ""
        ? afterIndex >= 0
          ? afterIndex + 1
          : targetRows.length
        : targetRows.length;
  const insertedTargetRows = [
    ...targetRows.slice(0, insertIndex),
    ...movedTasks.map((task) => ({
      ...task,
      sectionId: reorder.targetSectionId,
    })),
    ...targetRows.slice(insertIndex),
  ];

  const now = new Date().toISOString();
  const nextTaskById = new Map(taskById);
  [...sectionIdsToRenumber].forEach((sectionId) => {
    const sectionRows =
      sectionId === reorder.targetSectionId
        ? insertedTargetRows
        : sortTasksForDisplay(
            data.tasks.filter((task) => task.sectionId === sectionId && !movedIdSet.has(task.taskId)),
          );
    sectionRows.forEach((task, position) => {
      nextTaskById.set(task.taskId, {
        ...task,
        sectionId,
        position,
        placementRevision: task.placementRevision + 1,
        updatedAt: now,
      });
    });
  });

  return {
    ...data,
    tasks: data.tasks.map((task) => nextTaskById.get(task.taskId) ?? task),
  };
}

function taskWithStatus(input: { task: UnifiedAssignedTask; status: TaskStatus }): UnifiedAssignedTask {
  const { task, status } = input;

  return {
    ...task,
    status,
    completedAt: status === "completed" ? new Date().toISOString() : null,
  };
}

function compareTasksForDisplay(input: { first: UnifiedAssignedTask; second: UnifiedAssignedTask }) {
  const { first, second } = input;
  const positionDelta = first.position - second.position;
  if (positionDelta !== 0) {
    return positionDelta;
  }
  const firstUpdatedAt = Date.parse(first.updatedAt);
  const secondUpdatedAt = Date.parse(second.updatedAt);
  if (!Number.isNaN(firstUpdatedAt) && !Number.isNaN(secondUpdatedAt) && firstUpdatedAt !== secondUpdatedAt) {
    return secondUpdatedAt - firstUpdatedAt;
  }

  return first.title.localeCompare(second.title);
}

function sortTasksForDisplay(tasks: UnifiedAssignedTask[]) {
  return [...tasks].sort((first, second) => compareTasksForDisplay({ first, second }));
}

function positionTaskFromOrderHint(input: {
  task: UnifiedAssignedTask;
  tasks: UnifiedAssignedTask[];
  hint: OptimisticTaskOrderHint;
}) {
  const { task, tasks, hint } = input;
  const sectionRows = sortTasksForDisplay(
    tasks.filter((item) => item.sectionId === hint.sectionId && item.taskId !== task.taskId),
  );
  if (hint.beforeTaskId !== undefined && hint.beforeTaskId !== "") {
    const beforeIndex = sectionRows.findIndex((item) => item.taskId === hint.beforeTaskId);
    const beforeTask = sectionRows[beforeIndex];
    if (beforeIndex >= 0 && beforeTask !== undefined) {
      const previousTask = sectionRows[beforeIndex - 1] ?? null;

      return {
        ...task,
        sectionId: hint.sectionId,
        position:
          previousTask !== null
            ? (previousTask.position + beforeTask.position) / POSITION_AVERAGE_DIVISOR
            : beforeTask.position - POSITION_OFFSET_BEFORE,
      };
    }
  }
  if (hint.afterTaskId !== undefined && hint.afterTaskId !== "") {
    const afterIndex = sectionRows.findIndex((item) => item.taskId === hint.afterTaskId);
    const afterTask = sectionRows[afterIndex];
    if (afterIndex >= 0 && afterTask !== undefined) {
      const nextTask = sectionRows[afterIndex + 1] ?? null;

      return {
        ...task,
        sectionId: hint.sectionId,
        position:
          nextTask !== null
            ? (afterTask.position + nextTask.position) / POSITION_AVERAGE_DIVISOR
            : afterTask.position + POSITION_OFFSET_BEFORE,
      };
    }
  }

  return {
    ...task,
    sectionId: hint.sectionId,
    position: Math.min(0, ...sectionRows.map((item) => item.position)) - 1,
  };
}

function applyOptimisticTaskOrderHints(input: {
  tasks: UnifiedAssignedTask[];
  hints: Record<string, OptimisticTaskOrderHint>;
}) {
  const { tasks, hints } = input;

  return Object.entries(hints).reduce((nextTasks, [taskId, hint]) => {
    const task = nextTasks.find((item) => item.taskId === taskId);
    if (task === undefined) {
      return nextTasks;
    }
    const positionedTask = positionTaskFromOrderHint({ task, tasks: nextTasks, hint });

    return nextTasks.map((item) => (item.taskId === taskId ? positionedTask : item));
  }, tasks);
}

function taskMatchesSearch(input: {
  task: UnifiedAssignedTask;
  section: WorkspaceTaskSection | undefined;
  query: string;
}) {
  const { task, section, query } = input;
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }
  const searchableText = [task.title, task.description ?? "", task.sourceMeeting?.title ?? "", section?.title ?? ""]
    .join(" ")
    .toLowerCase();

  return searchableText.includes(normalizedQuery);
}

function isServerPlaceholderForOptimisticCreate(input: {
  task: UnifiedAssignedTask;
  optimisticTasks: UnifiedAssignedTask[];
}) {
  const { task, optimisticTasks } = input;
  if (task.sourceType !== "workspace" || task.title !== NEW_TASK_PLACEHOLDER_TITLE || task.status !== "open") {
    return false;
  }

  return optimisticTasks.some((optimisticTask) => {
    if (
      !optimisticTask.taskId.startsWith("temporary-task:") ||
      (optimisticTask.sectionId !== PERSONAL_TASK_SECTION_ID && optimisticTask.sectionId !== task.sectionId) ||
      optimisticTask.dueDate.value !== task.dueDate.value
    ) {
      return false;
    }
    const optimisticStartedAt = Date.parse(optimisticTask.updatedAt);
    const taskUpdatedAt = Date.parse(task.updatedAt);

    return (
      Number.isNaN(optimisticStartedAt) ||
      Number.isNaN(taskUpdatedAt) ||
      taskUpdatedAt + OPTIMISTIC_PLACEHOLDER_MATCH_MS >= optimisticStartedAt
    );
  });
}

function TaskDropPlaceholder({ isVisible }: { isVisible: boolean }) {
  if (!isVisible) {
    return null;
  }

  return <div className="workspace-task-drop-placeholder" aria-hidden="true" />;
}

function activeCenterYFromDragEvent(event: DragMoveEvent | DragOverEvent | DragEndEvent) {
  const rect = event.active.rect.current.translated ?? event.active.rect.current.initial;

  return rect !== null ? rect.top + rect.height / RECT_CENTER_DIVISOR : null;
}

function isPointInsideRect(input: { point: { x: number; y: number } | null; rect: DOMRect | null }) {
  const { point, rect } = input;
  if (point === null || rect === null) {
    return false;
  }

  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function clampTitleCaretOffset(input: { offset: number; title: string }) {
  const { offset, title } = input;

  return Math.max(0, Math.min(title.length, offset));
}

function caretOffsetFromTextNode(input: {
  container: HTMLElement;
  node: Node | null | undefined;
  offset: number | null | undefined;
  title: string;
}) {
  const { container, node, offset, title } = input;
  if (node === null || node === undefined || typeof offset !== "number" || !container.contains(node)) {
    return null;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return clampTitleCaretOffset({ offset, title });
  }

  return null;
}

function approximateCaretOffsetFromPoint(input: { element: HTMLElement; clientX: number; title: string }) {
  const { element, clientX, title } = input;
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
  const computedStyle = window.getComputedStyle(element);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return title.length;
  }
  context.font = computedStyle.font;
  const searchCaret = (range: { low: number; high: number }): number => {
    const { low, high } = range;
    if (low >= high) {
      return low;
    }
    const middle = Math.ceil((low + high) / BINARY_SEARCH_MIDDLE_DIVISOR);

    return context.measureText(title.slice(0, middle)).width <= x
      ? searchCaret({ low: middle, high })
      : searchCaret({ low, high: middle - 1 });
  };

  return clampTitleCaretOffset({ offset: searchCaret({ low: 0, high: title.length }), title });
}

function readCaretPositionFromPoint(input: {
  doc: Document;
  point: { x: number; y: number };
}): { offsetNode: Node; offset: number } | null {
  const { doc, point } = input;
  const caretPositionFromPoint: unknown = Reflect.get(doc, "caretPositionFromPoint");
  if (typeof caretPositionFromPoint !== "function") {
    return null;
  }
  const raw: unknown = Reflect.apply(caretPositionFromPoint, doc, [point.x, point.y]);
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const offsetNode: unknown = Reflect.get(raw, "offsetNode");
  const offset: unknown = Reflect.get(raw, "offset");
  if (!(offsetNode instanceof Node) || typeof offset !== "number") {
    return null;
  }

  return { offsetNode, offset };
}

function readCaretRangeFromPoint(input: { doc: Document; point: { x: number; y: number } }): Range | null {
  const { doc, point } = input;
  const caretRangeFromPoint: unknown = Reflect.get(doc, "caretRangeFromPoint");
  if (typeof caretRangeFromPoint !== "function") {
    return null;
  }
  const raw: unknown = Reflect.apply(caretRangeFromPoint, doc, [point.x, point.y]);
  if (raw instanceof Range) {
    return raw;
  }

  return null;
}

function titleCaretOffsetFromClick(input: { event: MouseEvent<HTMLElement>; title: string; textSelector?: string }) {
  const { event, title, textSelector = ".workspace-task-title-text" } = input;
  const eventTarget = event.target;
  const textElement =
    (eventTarget instanceof HTMLElement ? eventTarget.closest<HTMLElement>(textSelector) : null) ??
    event.currentTarget.querySelector<HTMLElement>(textSelector);
  if (textElement === null) {
    return title.length;
  }
  const caretPosition = readCaretPositionFromPoint({ doc: document, point: { x: event.clientX, y: event.clientY } });
  const positionOffset = caretOffsetFromTextNode({
    container: textElement,
    node: caretPosition?.offsetNode,
    offset: caretPosition?.offset,
    title,
  });
  if (positionOffset !== null) {
    return positionOffset;
  }
  // Keep the legacy fallback for browsers without caretPositionFromPoint.
  const caretRange = readCaretRangeFromPoint({ doc: document, point: { x: event.clientX, y: event.clientY } });
  const rangeOffset = caretOffsetFromTextNode({
    container: textElement,
    node: caretRange?.startContainer,
    offset: caretRange?.startOffset,
    title,
  });
  if (rangeOffset !== null) {
    return rangeOffset;
  }

  return approximateCaretOffsetFromPoint({ element: textElement, clientX: event.clientX, title });
}

function sectionTitleCaretOffsetFromClick(input: { event: MouseEvent<HTMLElement>; title: string }) {
  return titleCaretOffsetFromClick({
    event: input.event,
    title: input.title,
    textSelector: ".workspace-task-section-title-text",
  });
}

function taskAssigneeParticipantForOwner(input: {
  task: UnifiedAssignedTask;
  currentUser: TaskAssigneeParticipant | null;
  participants: TaskAssigneeParticipant[];
}) {
  const { task, currentUser, participants } = input;
  if (task.isMine) {
    return currentUser;
  }
  if (!task.owner) {
    return null;
  }

  return (
    participants.find((participant) => participant.userId === task.owner?.userId) ?? {
      ...task.owner,
      email: null,
    }
  );
}

function setTextareaHeightToContent(textarea: HTMLTextAreaElement) {
  const field = textarea;
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

function useTaskRowGrowthAnimation(input: {
  rowHeightRef: RefObject<HTMLDivElement | null>;
  measuredRowHeightRef: RefObject<number | null>;
  wasEditingRef: RefObject<boolean>;
  isEditing: boolean;
  isEntering: boolean;
  draftTitle: string;
  draftDescription: string;
}) {
  const { rowHeightRef, measuredRowHeightRef, wasEditingRef, isEditing, isEntering, draftTitle, draftDescription } =
    input;

  useLayoutEffect(() => {
    const element = rowHeightRef.current;
    if (element === null) {
      return;
    }

    const nextHeight = element.scrollHeight;
    const previousHeight = measuredRowHeightRef.current;
    measuredRowHeightRef.current = nextHeight;
    const isPreviouslyEditing = wasEditingRef.current;
    wasEditingRef.current = isEditing;
    const startHeight = previousHeight ?? (isEntering ? 0 : null);
    const shouldAnimateGrowth = isEntering || (isEditing && !isPreviouslyEditing);
    if (
      !shouldAnimateGrowth ||
      startHeight === null ||
      Math.abs(startHeight - nextHeight) < ROW_HEIGHT_CHANGE_THRESHOLD ||
      nextHeight < startHeight
    ) {
      element.style.height = "";
      element.style.overflow = "";
      element.style.transition = "";

      return;
    }

    const transitionElement = element;
    const transition = `height ${ROW_GROWTH_TRANSITION_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    transitionElement.style.height = `${startHeight}px`;
    transitionElement.style.overflow = "hidden";
    transitionElement.getBoundingClientRect();
    transitionElement.style.transition = transition;
    transitionElement.style.height = `${nextHeight}px`;

    function finishTransition(event?: TransitionEvent) {
      if (event !== undefined && event.target !== transitionElement) {
        return;
      }
      transitionElement.style.height = "";
      transitionElement.style.overflow = "";
      transitionElement.style.transition = "";
      transitionElement.removeEventListener("transitionend", finishTransition);
    }

    transitionElement.addEventListener("transitionend", finishTransition);
    const fallbackId = window.setTimeout(() => finishTransition(), ROW_GROWTH_FALLBACK_MS);

    return () => {
      window.clearTimeout(fallbackId);
      transitionElement.removeEventListener("transitionend", finishTransition);
      transitionElement.style.height = "";
      transitionElement.style.overflow = "";
      transitionElement.style.transition = "";
    };
  }, [draftDescription, draftTitle, isEditing, isEntering, measuredRowHeightRef, rowHeightRef, wasEditingRef]);
}

type TaskRowProps = {
  task: UnifiedAssignedTask;
  isActive: boolean;
  isSelected: boolean;
  isSelectedAfterPrevious: boolean;
  isSelectedBeforeNext: boolean;
  isHiddenDuringDrag: boolean;
  isEditing: boolean;
  canDrag: boolean;
  draft: TaskDraft;
  onDraftChange: (draft: TaskDraft) => void;
  onSelect: (event: MouseEvent) => void;
  onBeginEdit: (caretOffset?: number) => void;
  onCancelEdit: () => void;
  onCommitEdit: (draftOverride?: TaskDraft) => void;
  onToggleDone: () => void;
  canToggleDone: boolean;
  onAssignTask: (input: { task: UnifiedAssignedTask; nextOwnerUserId: string | null }) => Promise<void>;
  onAssigneeMenuOpen: (workspaceId: string) => void;
  participants: TaskAssigneeParticipant[];
  currentUserParticipant: TaskAssigneeParticipant | null;
  canAssignTask: boolean;
  isAssigning: boolean;
  initialTitleCaret: number | null;
  isFadingOut: boolean;
  isEntering: boolean;
  shouldSuppressSortableTransform: boolean;
};

function TaskRowEditMode({
  task,
  draft,
  sourceHref,
  titleTextareaRef,
  descriptionTextareaRef,
  onDraftChange,
  onCancelEdit,
  onCommitEdit,
  resizeTitleTextarea,
  resizeDescriptionTextarea,
}: {
  task: UnifiedAssignedTask;
  draft: TaskDraft;
  sourceHref: string | null;
  titleTextareaRef: RefObject<HTMLTextAreaElement | null>;
  descriptionTextareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (draft: TaskDraft) => void;
  onCancelEdit: () => void;
  onCommitEdit: (draftOverride?: TaskDraft) => void;
  resizeTitleTextarea: (passedTextarea?: HTMLTextAreaElement | null) => void;
  resizeDescriptionTextarea: (passedTextarea?: HTMLTextAreaElement | null) => void;
}) {
  return (
    <div
      className="workspace-task-editor"
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (event.relatedTarget === null || !event.currentTarget.contains(event.relatedTarget)) {
          onCommitEdit();
        }
      }}
    >
      <div className="workspace-task-title-row">
        <span className="workspace-task-title-edit-shell">
          <textarea
            className="workspace-task-title-input"
            value={draft.title}
            autoFocus
            rows={1}
            ref={titleTextareaRef}
            aria-label="Task title"
            placeholder={NEW_TASK_PLACEHOLDER_TITLE}
            onChange={(event) => {
              onDraftChange({ ...draft, title: event.target.value });
              resizeTitleTextarea(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelEdit();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitEdit({
                  title: event.currentTarget.value,
                  description: descriptionTextareaRef.current?.value ?? draft.description,
                });
              }
            }}
          />
          <span className="workspace-task-title-edit-sizer" aria-hidden="true">
            {draft.title.length > 0 ? draft.title : task.title}
          </span>
        </span>
        {sourceHref !== null ? (
          <span className="workspace-task-source-link workspace-task-source-link-spacer" aria-hidden="true">
            <TextDocumentIcon />
          </span>
        ) : null}
      </div>
      <textarea
        className="workspace-task-description-input"
        value={draft.description}
        placeholder="Notes"
        rows={1}
        ref={descriptionTextareaRef}
        onChange={(event) => {
          onDraftChange({ ...draft, description: event.target.value });
          resizeDescriptionTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancelEdit();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            onCommitEdit({
              title: titleTextareaRef.current?.value ?? draft.title,
              description: event.currentTarget.value,
            });
          }
        }}
      />
    </div>
  );
}

function TaskRowViewMode({
  task,
  sourceHref,
  shouldShowAssigneeControl,
  onBeginEdit,
}: {
  task: UnifiedAssignedTask;
  sourceHref: string | null;
  shouldShowAssigneeControl: boolean;
  onBeginEdit: (caretOffset?: number) => void;
}) {
  return (
    <div className="workspace-task-copy">
      <div className={`workspace-task-title-row${shouldShowAssigneeControl ? " has-owner-control" : ""}`}>
        <button
          type="button"
          className="workspace-task-title-button"
          onPointerDown={(event) => {
            event.stopPropagation();
            // Keep focus (and the open editor's layout) put so the modifier click lands on this row.
            if (isSelectionModifierClick(event)) {
              event.preventDefault();
            }
          }}
          onClick={(event) => {
            // Modifier clicks extend the row selection instead of editing the title.
            if (isSelectionModifierClick(event)) {
              return;
            }
            event.stopPropagation();
            onBeginEdit(titleCaretOffsetFromClick({ event, title: task.title }));
          }}
        >
          <span className="workspace-task-title-text">{task.title}</span>
        </button>
        {sourceHref !== null ? (
          <Link
            href={sourceHref}
            className="workspace-task-source-link"
            aria-label={`Open source meeting: ${task.sourceMeeting?.title ?? task.title}`}
            title={task.sourceMeeting?.title ?? task.title}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <TextDocumentIcon />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function TaskRowBody({
  task,
  isEditing,
  draft,
  sourceHref,
  shouldShowAssigneeControl,
  titleTextareaRef,
  descriptionTextareaRef,
  onDraftChange,
  onCancelEdit,
  onCommitEdit,
  onBeginEdit,
  resizeTitleTextarea,
  resizeDescriptionTextarea,
}: {
  task: UnifiedAssignedTask;
  isEditing: boolean;
  draft: TaskDraft;
  sourceHref: string | null;
  shouldShowAssigneeControl: boolean;
  titleTextareaRef: RefObject<HTMLTextAreaElement | null>;
  descriptionTextareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (draft: TaskDraft) => void;
  onCancelEdit: () => void;
  onCommitEdit: (draftOverride?: TaskDraft) => void;
  onBeginEdit: (caretOffset?: number) => void;
  resizeTitleTextarea: (passedTextarea?: HTMLTextAreaElement | null) => void;
  resizeDescriptionTextarea: (passedTextarea?: HTMLTextAreaElement | null) => void;
}) {
  if (isEditing) {
    return (
      <TaskRowEditMode
        task={task}
        draft={draft}
        sourceHref={sourceHref}
        titleTextareaRef={titleTextareaRef}
        descriptionTextareaRef={descriptionTextareaRef}
        onDraftChange={onDraftChange}
        onCancelEdit={onCancelEdit}
        onCommitEdit={onCommitEdit}
        resizeTitleTextarea={resizeTitleTextarea}
        resizeDescriptionTextarea={resizeDescriptionTextarea}
      />
    );
  }

  return (
    <TaskRowViewMode
      task={task}
      sourceHref={sourceHref}
      shouldShowAssigneeControl={shouldShowAssigneeControl}
      onBeginEdit={onBeginEdit}
    />
  );
}

function taskRowClassName(input: {
  isCompleted: boolean;
  isActive: boolean;
  isSelected: boolean;
  isSelectedAfterPrevious: boolean;
  isSelectedBeforeNext: boolean;
  isEditing: boolean;
  isFadingOut: boolean;
  canDrag: boolean;
  isSourceLocked: boolean;
}): string {
  const {
    isCompleted,
    isActive,
    isSelected,
    isSelectedAfterPrevious,
    isSelectedBeforeNext,
    isEditing,
    isFadingOut,
    canDrag,
    isSourceLocked,
  } = input;

  return [
    "workspace-task-row",
    isCompleted ? "is-completed" : "",
    isActive ? "is-active" : "",
    isSelected ? "is-selected" : "",
    isSelectedAfterPrevious ? "is-selected-after-previous" : "",
    isSelectedBeforeNext ? "is-selected-before-next" : "",
    isEditing ? "is-editing" : "",
    isFadingOut ? "is-fading-out" : "",
    canDrag ? "is-reorderable" : "",
    isSourceLocked ? "is-source-locked" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function TaskRowMeta({
  task,
  shouldShowAssigneeControl,
  currentAssignee,
  participants,
  canAssign,
  isAssigning,
  hasValidActivityDate,
  activityDateTime,
  activityDate,
  isCompleted,
  onAssigneeMenuOpen,
  onAssignTask,
}: {
  task: UnifiedAssignedTask;
  shouldShowAssigneeControl: boolean;
  currentAssignee: TaskAssigneeParticipant | null;
  participants: TaskAssigneeParticipant[];
  canAssign: boolean;
  isAssigning: boolean;
  hasValidActivityDate: boolean;
  activityDateTime: string;
  activityDate: Date;
  isCompleted: boolean;
  onAssigneeMenuOpen: (workspaceId: string) => void;
  onAssignTask: (input: { task: UnifiedAssignedTask; nextOwnerUserId: string | null }) => Promise<void>;
}) {
  return (
    <div className="workspace-task-row-meta" onPointerDown={(event) => event.stopPropagation()}>
      {shouldShowAssigneeControl ? (
        <TaskAssigneePill
          assignee={currentAssignee}
          participants={participants}
          variant="avatar"
          expandOnMobile
          disabled={!canAssign || isAssigning}
          onOpen={() => onAssigneeMenuOpen(task.workspaceId)}
          onChange={(nextOwnerUserId) => onAssignTask({ task, nextOwnerUserId })}
        />
      ) : null}
      {hasValidActivityDate ? (
        <time
          className="workspace-task-activity-date"
          dateTime={activityDateTime}
          title={`${isCompleted ? "Completed" : "Updated"} ${taskActivityDateTooltipFormatter.format(activityDate)}`}
        >
          {taskActivityDateFormatter.format(activityDate)}
        </time>
      ) : null}
    </div>
  );
}

function useTaskRowEditingLayout(input: {
  isEditing: boolean;
  isEntering: boolean;
  draft: TaskDraft;
  initialTitleCaret: number | null;
}) {
  const { isEditing, isEntering, draft, initialTitleCaret } = input;
  const titleTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rowHeightRef = useRef<HTMLDivElement | null>(null);
  const measuredRowHeightRef = useRef<number | null>(null);
  const wasEditingRef = useRef(isEditing);
  const resizeTitleTextarea = useCallback((passedTextarea?: HTMLTextAreaElement | null) => {
    const textarea = passedTextarea ?? titleTextareaRef.current;
    if (textarea === null) {
      return;
    }
    setTextareaHeightToContent(textarea);
  }, []);
  const resizeDescriptionTextarea = useCallback((passedTextarea?: HTMLTextAreaElement | null) => {
    const textarea = passedTextarea ?? descriptionTextareaRef.current;
    if (textarea === null) {
      return;
    }
    setTextareaHeightToContent(textarea);
  }, []);

  useLayoutEffect(() => {
    if (isEditing) {
      resizeTitleTextarea();
      resizeDescriptionTextarea();
    }
  }, [draft.description, draft.title, isEditing, resizeDescriptionTextarea, resizeTitleTextarea]);

  useLayoutEffect(() => {
    if (!isEditing || initialTitleCaret === null) {
      return;
    }
    const element = titleTextareaRef.current;
    if (element === null) {
      return;
    }
    const offset = clampTitleCaretOffset({ offset: initialTitleCaret, title: element.value });
    element.setSelectionRange(offset, offset);
  }, [initialTitleCaret, isEditing]);

  useTaskRowGrowthAnimation({
    rowHeightRef,
    measuredRowHeightRef,
    wasEditingRef,
    isEditing,
    isEntering,
    draftTitle: draft.title,
    draftDescription: draft.description,
  });

  return {
    titleTextareaRef,
    descriptionTextareaRef,
    rowHeightRef,
    resizeTitleTextarea,
    resizeDescriptionTextarea,
  };
}

function useTaskRowSortable(input: { taskId: string; canDrag: boolean; shouldSuppressSortableTransform: boolean }) {
  const { taskId, canDrag, shouldSuppressSortableTransform } = input;
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
    id: taskId,
    disabled: !canDrag,
  });
  const style: CSSProperties = {
    transform: shouldSuppressSortableTransform ? undefined : CSS.Transform.toString(transform),
    transition: shouldSuppressSortableTransform ? undefined : transition,
  };

  return { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, style };
}

function isSelectionModifierClick(event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">): boolean {
  return event.shiftKey || event.metaKey || event.ctrlKey;
}

function taskRowPointerSelectHandler(input: { onSelect: (event: MouseEvent) => void }) {
  return (event: MouseEvent) => {
    const target = event.target;
    const isModifierTitleClick =
      isSelectionModifierClick(event) &&
      target instanceof HTMLElement &&
      target.closest(".workspace-task-title-button") !== null;
    if (!isModifierTitleClick && target instanceof HTMLElement && target.closest("button, a, input, textarea")) {
      return;
    }
    input.onSelect(event);
  };
}

function TaskRow({
  task,
  isActive,
  isSelected,
  isSelectedAfterPrevious,
  isSelectedBeforeNext,
  isHiddenDuringDrag,
  isEditing,
  canDrag,
  draft,
  onDraftChange,
  onSelect,
  onBeginEdit,
  onCancelEdit,
  onCommitEdit,
  onToggleDone,
  canToggleDone,
  onAssignTask,
  onAssigneeMenuOpen,
  participants,
  currentUserParticipant,
  canAssignTask,
  isAssigning,
  initialTitleCaret,
  isFadingOut,
  isEntering,
  shouldSuppressSortableTransform,
}: TaskRowProps) {
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, style } = useTaskRowSortable({
    taskId: task.taskId,
    canDrag,
    shouldSuppressSortableTransform,
  });
  const isCompleted = task.status === "completed";
  const sourceHref = sourceLinkForTask(task);
  const activityDateTime = isCompleted ? (task.completedAt ?? task.updatedAt) : task.updatedAt;
  const activityDate = new Date(activityDateTime);
  const hasValidActivityDate = !Number.isNaN(activityDate.getTime());
  const currentAssignee = taskAssigneeParticipantForOwner({ task, currentUser: currentUserParticipant, participants });
  const shouldShowAssigneeControl = task.sourceType === "workspace" || sourceHref !== null;
  const canAssign = shouldShowAssigneeControl && canAssignTask;
  const { titleTextareaRef, descriptionTextareaRef, rowHeightRef, resizeTitleTextarea, resizeDescriptionTextarea } =
    useTaskRowEditingLayout({ isEditing, isEntering, draft, initialTitleCaret });

  const handleRowClick = taskRowPointerSelectHandler({ onSelect });

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        "workspace-task-row-shell",
        isDragging ? "is-dragging" : "",
        isHiddenDuringDrag ? "is-hidden-during-drag" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={`workspace-task-edit-spacer${isEditing ? " is-expanded" : ""}`} aria-hidden="true" />
      <div ref={rowHeightRef} className="workspace-task-row-height">
        <TaskRowActivator
          task={task}
          isCompleted={isCompleted}
          isActive={isActive}
          isSelected={isSelected}
          isSelectedAfterPrevious={isSelectedAfterPrevious}
          isSelectedBeforeNext={isSelectedBeforeNext}
          isEditing={isEditing}
          isFadingOut={isFadingOut}
          canDrag={canDrag}
          canToggleDone={canToggleDone}
          draft={draft}
          sourceHref={sourceHref}
          shouldShowAssigneeControl={shouldShowAssigneeControl}
          titleTextareaRef={titleTextareaRef}
          descriptionTextareaRef={descriptionTextareaRef}
          currentAssignee={currentAssignee}
          participants={participants}
          canAssign={canAssign}
          isAssigning={isAssigning}
          hasValidActivityDate={hasValidActivityDate}
          activityDateTime={activityDateTime}
          activityDate={activityDate}
          setActivatorNodeRef={setActivatorNodeRef}
          sortableAttributes={attributes}
          sortableListeners={listeners}
          onRowClick={handleRowClick}
          onDraftChange={onDraftChange}
          onCancelEdit={onCancelEdit}
          onCommitEdit={onCommitEdit}
          onBeginEdit={onBeginEdit}
          resizeTitleTextarea={resizeTitleTextarea}
          resizeDescriptionTextarea={resizeDescriptionTextarea}
          onToggleDone={onToggleDone}
          onAssigneeMenuOpen={onAssigneeMenuOpen}
          onAssignTask={onAssignTask}
        />
      </div>
    </div>
  );
}

type TaskRowActivatorProps = Pick<
  TaskRowProps,
  | "task"
  | "isActive"
  | "isSelected"
  | "isSelectedAfterPrevious"
  | "isSelectedBeforeNext"
  | "isEditing"
  | "isFadingOut"
  | "canDrag"
  | "canToggleDone"
  | "draft"
  | "participants"
  | "isAssigning"
  | "onDraftChange"
  | "onCancelEdit"
  | "onCommitEdit"
  | "onBeginEdit"
  | "onToggleDone"
  | "onAssigneeMenuOpen"
  | "onAssignTask"
> & {
  isCompleted: boolean;
  sourceHref: string | null;
  shouldShowAssigneeControl: boolean;
  titleTextareaRef: RefObject<HTMLTextAreaElement | null>;
  descriptionTextareaRef: RefObject<HTMLTextAreaElement | null>;
  currentAssignee: TaskAssigneeParticipant | null;
  participants: TaskAssigneeParticipant[];
  canAssign: boolean;
  hasValidActivityDate: boolean;
  activityDateTime: string;
  activityDate: Date;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  sortableAttributes: ReturnType<typeof useSortable>["attributes"];
  sortableListeners: ReturnType<typeof useSortable>["listeners"];
  onRowClick: (event: MouseEvent) => void;
  resizeTitleTextarea: (passedTextarea?: HTMLTextAreaElement | null) => void;
  resizeDescriptionTextarea: (passedTextarea?: HTMLTextAreaElement | null) => void;
};

function TaskRowDoneCheckbox(input: { isCompleted: boolean; canToggleDone: boolean; onToggleDone: () => void }) {
  const { isCompleted, canToggleDone, onToggleDone } = input;

  return (
    <button
      type="button"
      className="workspace-task-checkbox"
      aria-label={isCompleted ? "Mark task open" : "Mark task complete"}
      aria-pressed={isCompleted}
      disabled={!canToggleDone}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggleDone();
      }}
    >
      <TaskCheckboxIcon checked={isCompleted} />
    </button>
  );
}

function TaskRowActivator(input: TaskRowActivatorProps) {
  const {
    task,
    isActive,
    isSelected,
    isSelectedAfterPrevious,
    isSelectedBeforeNext,
    isEditing,
    isFadingOut,
    canDrag,
    canToggleDone,
    draft,
    sourceHref,
    shouldShowAssigneeControl,
    titleTextareaRef,
    descriptionTextareaRef,
    currentAssignee,
    participants,
    canAssign,
    isAssigning,
    hasValidActivityDate,
    activityDateTime,
    activityDate,
    isCompleted,
    setActivatorNodeRef,
    sortableAttributes,
    sortableListeners,
    onRowClick,
    onDraftChange,
    onCancelEdit,
    onCommitEdit,
    onBeginEdit,
    resizeTitleTextarea,
    resizeDescriptionTextarea,
    onToggleDone,
    onAssigneeMenuOpen,
    onAssignTask,
  } = input;

  return (
    <div
      className={taskRowClassName({
        isCompleted,
        isActive,
        isSelected,
        isSelectedAfterPrevious,
        isSelectedBeforeNext,
        isEditing,
        isFadingOut,
        canDrag,
        isSourceLocked: !task.editable,
      })}
      data-task-id={task.taskId}
      ref={setActivatorNodeRef}
      onMouseDown={(event) => {
        // A modifier click must not blur an open editor first: the collapsing row would
        // shift the layout and the click would land on a different row.
        if (isSelectionModifierClick(event)) {
          event.preventDefault();
        }
      }}
      onClick={onRowClick}
      {...sortableAttributes}
      {...sortableListeners}
    >
      <TaskRowDoneCheckbox isCompleted={isCompleted} canToggleDone={canToggleDone} onToggleDone={onToggleDone} />
      <div className="workspace-task-row-body">
        <TaskRowBody
          task={task}
          isEditing={isEditing}
          draft={draft}
          sourceHref={sourceHref}
          shouldShowAssigneeControl={shouldShowAssigneeControl}
          titleTextareaRef={titleTextareaRef}
          descriptionTextareaRef={descriptionTextareaRef}
          onDraftChange={onDraftChange}
          onCancelEdit={onCancelEdit}
          onCommitEdit={onCommitEdit}
          onBeginEdit={onBeginEdit}
          resizeTitleTextarea={resizeTitleTextarea}
          resizeDescriptionTextarea={resizeDescriptionTextarea}
        />
      </div>
      <TaskRowMeta
        task={task}
        shouldShowAssigneeControl={shouldShowAssigneeControl}
        currentAssignee={currentAssignee}
        participants={participants}
        canAssign={canAssign}
        isAssigning={isAssigning}
        hasValidActivityDate={hasValidActivityDate}
        activityDateTime={activityDateTime}
        activityDate={activityDate}
        isCompleted={isCompleted}
        onAssigneeMenuOpen={onAssigneeMenuOpen}
        onAssignTask={onAssignTask}
      />
    </div>
  );
}

function useSectionHeaderTitleEditor(input: {
  isEditing: boolean;
  draftTitle: string;
  initialTitleCaret: number | null;
}) {
  const { isEditing, draftTitle, initialTitleCaret } = input;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeTextarea = useCallback((passedTextarea?: HTMLTextAreaElement | null) => {
    const textarea = passedTextarea ?? textareaRef.current;
    if (textarea === null) {
      return;
    }
    setTextareaHeightToContent(textarea);
  }, []);

  useLayoutEffect(() => {
    if (isEditing) {
      resizeTextarea();
      const element = textareaRef.current;
      if (element !== null) {
        const offset =
          initialTitleCaret === null
            ? element.value.length
            : clampTitleCaretOffset({ offset: initialTitleCaret, title: element.value });
        element.setSelectionRange(offset, offset);
      }
    }
  }, [initialTitleCaret, isEditing, resizeTextarea]);

  useLayoutEffect(() => {
    if (isEditing) {
      resizeTextarea();
    }
  }, [draftTitle, isEditing, resizeTextarea]);

  return { textareaRef, resizeTextarea };
}

function SectionHeaderRow({
  section,
  isActive,
  isEditing,
  draftTitle,
  onDraftChange,
  onSelect,
  onBeginEdit,
  onCancelEdit,
  onCommitEdit,
  initialTitleCaret,
  placeholder,
}: {
  section: WorkspaceTaskSection;
  isActive: boolean;
  isEditing: boolean;
  draftTitle: string;
  onDraftChange: (title: string) => void;
  onSelect: () => void;
  onBeginEdit: (caretOffset?: number) => void;
  onCancelEdit: () => void;
  onCommitEdit: (titleOverride?: string) => void;
  initialTitleCaret: number | null;
  placeholder: string;
}) {
  const { textareaRef, resizeTextarea } = useSectionHeaderTitleEditor({ isEditing, draftTitle, initialTitleCaret });

  return (
    <div
      className={`workspace-task-section-row${isActive ? " is-active" : ""}${isEditing ? " is-editing" : ""}`}
      data-section-id={section.id}
      onClick={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("button, textarea")) {
          return;
        }
        onSelect();
      }}
    >
      {isEditing ? (
        <span className="workspace-task-section-title-edit-shell" onPointerDown={(event) => event.stopPropagation()}>
          <textarea
            ref={textareaRef}
            className="workspace-task-section-title-editor"
            value={draftTitle}
            autoFocus
            rows={1}
            aria-label="Section title"
            placeholder={placeholder}
            onChange={(event) => {
              onDraftChange(event.currentTarget.value);
              resizeTextarea(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelEdit();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitEdit(event.currentTarget.value);
              }
            }}
            onBlur={(event) => {
              if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) {
                onCommitEdit(event.currentTarget.value);
              }
            }}
          />
          <span className="workspace-task-section-title-edit-sizer" aria-hidden="true">
            {draftTitle.length > 0 ? draftTitle : placeholder}
          </span>
        </span>
      ) : (
        <button
          type="button"
          className="workspace-task-section-title-button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onBeginEdit(sectionTitleCaretOffsetFromClick({ event, title: section.title }));
          }}
        >
          <span className="workspace-task-section-title-text">{section.title}</span>
        </button>
      )}
    </div>
  );
}

function dragPreviewBadgeLeft(input: { cursorAnchorX: number | null; previewWidth: number | null }) {
  const { cursorAnchorX, previewWidth } = input;
  if (cursorAnchorX === null || previewWidth === null) {
    return null;
  }

  return Math.min(
    Math.max(cursorAnchorX + DRAG_PREVIEW_BADGE_INSET, DRAG_PREVIEW_BADGE_MIN),
    previewWidth - DRAG_PREVIEW_BADGE_MAX_OFFSET,
  );
}

function dragPreviewLayout(input: {
  previewTasks: UnifiedAssignedTask[];
  width: number | null;
  cursorOffsetX: number | null;
  cursorOffsetY: number | null;
  isOverTaskNav: boolean;
}) {
  const { previewTasks, width, cursorOffsetX, cursorOffsetY, isOverTaskNav } = input;
  const compactHeight =
    TASK_NAV_DRAG_PREVIEW_ROW_HEIGHT + (previewTasks.length - 1) * TASK_NAV_DRAG_PREVIEW_STACK_OFFSET;
  const previewWidth = isOverTaskNav ? TASK_NAV_DRAG_PREVIEW_WIDTH : width;
  const previewHeight = isOverTaskNav
    ? compactHeight
    : previewTasks.length > 1
      ? DRAG_PREVIEW_MULTI_ROW_HEIGHT + (previewTasks.length - 1) * DRAG_PREVIEW_STACK_GAP
      : null;
  const cursorAnchorX = isOverTaskNav ? TASK_NAV_DRAG_PREVIEW_WIDTH / RECT_CENTER_DIVISOR : cursorOffsetX;
  const cursorAnchorY = isOverTaskNav ? compactHeight / RECT_CENTER_DIVISOR : cursorOffsetY;
  const translateX =
    isOverTaskNav && cursorOffsetX !== null ? cursorOffsetX - TASK_NAV_DRAG_PREVIEW_WIDTH / RECT_CENTER_DIVISOR : 0;
  const translateY = isOverTaskNav && cursorOffsetY !== null ? cursorOffsetY - compactHeight / RECT_CENTER_DIVISOR : 0;
  const badgeLeft = dragPreviewBadgeLeft({ cursorAnchorX, previewWidth });
  const badgeTop = cursorAnchorY === null ? null : Math.max(cursorAnchorY - DRAG_PREVIEW_BADGE_INSET, 0);
  const stackStyle: CSSProperties = {
    ...(previewWidth !== null ? { width: previewWidth } : {}),
    ...(previewHeight !== null ? { height: previewHeight } : {}),
    ...(isOverTaskNav ? { transform: `translate(${translateX}px, ${translateY}px)` } : {}),
  };

  return { stackStyle, badgeLeft, badgeTop };
}

function DragPreview({
  tasks,
  width,
  cursorOffsetX,
  cursorOffsetY,
  isOverTaskNav,
}: {
  tasks: UnifiedAssignedTask[];
  width: number | null;
  cursorOffsetX: number | null;
  cursorOffsetY: number | null;
  isOverTaskNav: boolean;
}) {
  const previewTasks = tasks.slice(0, DRAG_PREVIEW_MAX_TASKS);
  const { stackStyle, badgeLeft, badgeTop } = dragPreviewLayout({
    previewTasks,
    width,
    cursorOffsetX,
    cursorOffsetY,
    isOverTaskNav,
  });

  return (
    <div
      className={[
        "workspace-task-drag-preview-stack",
        previewTasks.length > 1 ? "is-multi" : "",
        isOverTaskNav ? "is-over-task-view" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={stackStyle}
    >
      {previewTasks.map((task, index) => (
        <div
          key={`${task.sourceType}:${task.taskId}`}
          className="workspace-task-drag-preview"
          style={
            previewTasks.length > 1
              ? {
                  opacity: index === 0 ? 1 : DRAG_PREVIEW_SECONDARY_OPACITY,
                  top: index * (isOverTaskNav ? TASK_NAV_DRAG_PREVIEW_STACK_OFFSET : DRAG_PREVIEW_STACK_GAP),
                  transform: `translateX(${index * (isOverTaskNav ? DRAG_PREVIEW_NAV_TRANSLATE_X : DRAG_PREVIEW_TRANSLATE_X)}px)`,
                  zIndex: previewTasks.length - index,
                }
              : undefined
          }
        >
          <TaskCheckboxIcon checked={task.status === "completed"} />
          <span style={index > 0 ? { visibility: "hidden" } : undefined} aria-hidden={index > 0 ? true : undefined}>
            {task.title}
          </span>
        </div>
      ))}
      {tasks.length > 1 || isOverTaskNav ? (
        <span
          className="workspace-task-drag-count"
          style={{
            ...(badgeLeft !== null ? { left: badgeLeft } : {}),
            ...(badgeTop !== null ? { top: badgeTop } : {}),
          }}
        >
          {tasks.length}
        </span>
      ) : null}
    </div>
  );
}

function useAssignedTasksPageQueries(input: {
  session: ReturnType<typeof useAuth>["session"];
  userId: string | null;
  workspaceId: string | null;
}) {
  const { session, userId, workspaceId } = input;
  const tasksQuery = useQuery({
    queryKey: personalAssignedTasksQueryKey(userId),
    queryFn: () => {
      if (!isPresentString(session?.token)) {
        throw new Error(MISSING_SESSION_ERROR);
      }

      return listPersonalAssignedTasks(session.token);
    },
    enabled: isPresentString(session?.token) && isPresentString(userId),
    staleTime: PERSONAL_TASKS_STALE_TIME_MS,
  });
  const meetingsQuery = useQuery(workspaceMeetingsOptions(session));
  const workspaceIdsQuery = useQuery({
    queryKey: ["my-workspace-ids", session?.user.id],
    queryFn: () => {
      if (!isPresentString(session?.token)) {
        throw new Error(MISSING_SESSION_ERROR);
      }

      return listMyWorkspaceIds(session.token);
    },
    enabled: isPresentString(session?.token) && isPresentString(userId) && session.user.source !== "guest",
    staleTime: WORKSPACE_QUERY_STALE_TIME_MS,
  });
  const taskWorkspaceIds = useMemo(
    () =>
      getAssignedTaskAssigneeWorkspaceIds({
        tasks: tasksQuery.data?.tasks ?? [],
        activeWorkspaceId: workspaceId,
        memberWorkspaceIds: workspaceIdsQuery.data ?? [],
      }),
    [tasksQuery.data?.tasks, workspaceId, workspaceIdsQuery.data],
  );
  const workspaceMemberQueries = useQueries({
    queries: taskWorkspaceIds.map((taskWorkspaceId) => ({
      queryKey: ["workspace-members", taskWorkspaceId],
      queryFn: () => {
        if (!isPresentString(session?.token)) {
          throw new Error(MISSING_SESSION_ERROR);
        }

        return listWorkspaceMembers({ token: session.token, workspaceId: taskWorkspaceId });
      },
      /** @external @tanstack/react-query useQueries option */
      enabled: isPresentString(session?.token),
      staleTime: WORKSPACE_QUERY_STALE_TIME_MS,
    })),
  });

  return { tasksQuery, meetingsQuery, workspaceIdsQuery, taskWorkspaceIds, workspaceMemberQueries };
}

function dragStartPointerCoords(input: { activatorEvent: DragStartEvent["activatorEvent"] }) {
  const { activatorEvent } = input;
  if (activatorEvent instanceof MouseEvent || activatorEvent instanceof PointerEvent) {
    return { x: activatorEvent.clientX, y: activatorEvent.clientY };
  }
  if (activatorEvent instanceof TouchEvent) {
    return {
      x: activatorEvent.touches[0]?.clientX ?? null,
      y: activatorEvent.touches[0]?.clientY ?? null,
    };
  }

  return { x: null, y: null };
}

async function applyAssignedTaskDragViewDrop(input: {
  taskPatches: {
    task: UnifiedAssignedTask;
    patch: AssignedTaskViewDropPatch;
  }[];
  userId: string;
  sessionToken: string;
  currentUserParticipant: TaskAssigneeParticipant | null;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: (message: string | null) => void;
  onComplete: () => void;
}) {
  const {
    taskPatches,
    userId,
    sessionToken,
    currentUserParticipant,
    queryClient,
    invalidateTasks,
    setError,
    onComplete,
  } = input;
  const queryKey = personalAssignedTasksQueryKey(userId);
  await queryClient.cancelQueries({ queryKey });
  const previousTasks = queryClient.getQueryData<WorkspaceAssignedTasksCache>(queryKey);
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
    taskPatches.reduce(
      (next, { task, patch }) =>
        patch.type === "status"
          ? updateCachedTaskViewPatch({ data: next, task, patch })
          : updateCachedTaskAssignee({
              data: next,
              task,
              currentUserId: userId,
              assignee: patch.type === "assign-to-viewer" ? currentUserParticipant : null,
            }),
      current,
    ),
  );
  onComplete();
  try {
    await Promise.all(
      taskPatches.map(({ task, patch }) => {
        const update =
          patch.type === "status"
            ? { status: patch.status }
            : { assigneeUserId: patch.type === "assign-to-viewer" ? userId : null };

        return task.sourceType === "workspace"
          ? updateWorkspaceTask({
              token: sessionToken,
              workspaceId: task.workspaceId,
              taskId: task.taskId,
              input: update,
            })
          : updateMeetingTask({ token: sessionToken, meetingId: task.sourceId, taskId: task.taskId, input: update });
      }),
    );
    invalidateTasks();
  } catch (nextError) {
    queryClient.setQueryData(queryKey, previousTasks);
    setError(nextError instanceof Error ? nextError.message : "Tasks could not be moved.");
    invalidateTasks();
  }
}

async function applyAssignedTaskDragReorder(input: {
  reorderInput: {
    movedTaskIds: string[];
    targetSectionId: string;
    beforeTaskId?: string;
    afterTaskId?: string;
  };
  sessionToken: string;
  workspaceId: string;
  userId: string;
  sections: WorkspaceTaskSection[];
  allTasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
  isSearching: boolean;
  trimmedSearchQuery: string;
  lingeringTaskIds: Set<string>;
  sectionById: Map<string, WorkspaceTaskSection>;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: (message: string | null) => void;
  onPreview: (tasks: UnifiedAssignedTask[]) => void;
  onPreviewClear: () => void;
  onDragEnd: () => void;
}) {
  const {
    reorderInput,
    sessionToken,
    workspaceId,
    userId,
    sections,
    allTasks,
    view,
    isSearching,
    trimmedSearchQuery,
    lingeringTaskIds,
    sectionById,
    queryClient,
    invalidateTasks,
    setError,
    onPreview,
    onPreviewClear,
    onDragEnd,
  } = input;
  const queryKey = personalAssignedTasksQueryKey(userId);
  await queryClient.cancelQueries({ queryKey });
  const previousTasks = queryClient.getQueryData<WorkspaceAssignedTasksCache>(queryKey);
  const previewCache = reorderCachedTasks({ data: { sections, tasks: allTasks }, reorder: reorderInput });
  const previewVisibleTasks = (previewCache?.tasks ?? allTasks)
    .filter(
      (task) =>
        lingeringTaskIds.has(task.taskId) || filterUnifiedAssignedTasksByView({ tasks: [task], view }).length !== 0,
    )
    .filter(
      (task) =>
        !isSearching ||
        taskMatchesSearch({ task, section: sectionById.get(task.sectionId), query: trimmedSearchQuery }),
    );
  flushSync(() => {
    onPreview(previewVisibleTasks);
    onDragEnd();
  });
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
    reorderCachedTasks({ data: current, reorder: reorderInput }),
  );

  try {
    const tasks = await reorderWorkspaceTasks({ token: sessionToken, workspaceId, input: reorderInput });
    queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
      current ? { ...current, tasks } : current,
    );
    window.requestAnimationFrame(() => onPreviewClear());
    invalidateTasks();
  } catch (nextError) {
    queryClient.setQueryData(queryKey, previousTasks);
    onPreviewClear();
    setError(nextError instanceof Error ? nextError.message : "Tasks could not be reordered.");
  }
}

async function persistCommittedTaskEdit(input: {
  sessionToken: string;
  task: UnifiedAssignedTask;
  title: string;
  description: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
  userId: string;
  invalidateTasks: () => void;
  setError: (message: string | null) => void;
}) {
  const { sessionToken, task, title, description, queryClient, userId, invalidateTasks, setError } = input;
  const queryKey = personalAssignedTasksQueryKey(userId);
  const previousTasks = queryClient.getQueryData<WorkspaceAssignedTasksCache>(queryKey);
  try {
    if (task.sourceType === "workspace") {
      await updateWorkspaceTask({
        token: sessionToken,
        workspaceId: task.workspaceId,
        taskId: task.taskId,
        input: {
          title,
          description,
        },
      });
    } else {
      await updateMeetingTask({
        token: sessionToken,
        meetingId: task.sourceId,
        taskId: task.taskId,
        input: {
          title,
          description,
        },
      });
    }
    invalidateTasks();
  } catch (nextError) {
    queryClient.setQueryData(queryKey, previousTasks);
    setError(nextError instanceof Error ? nextError.message : "Task could not be saved.");
  }
}

function buildOptimisticAssignedWorkspaceTask(input: {
  view: AssignedTaskView;
  workspaceId: string;
  allTasks: UnifiedAssignedTask[];
}) {
  const { view, workspaceId, allTasks } = input;
  const isCreateForOthers = view === "others";
  const temporaryTaskId = `temporary-task:${crypto.randomUUID()}`;
  const dueDateValue = null;
  const sectionId = isCreateForOthers ? UNPLACED_ASSIGNED_TASK_SECTION_ID : PERSONAL_TASK_SECTION_ID;
  const now = new Date().toISOString();
  const position = Math.min(0, ...allTasks.map((task) => task.position)) - 1;
  const optimisticTask: UnifiedAssignedTask = {
    sourceType: "workspace",
    sourceId: temporaryTaskId,
    taskId: temporaryTaskId,
    workspaceId,
    /** @external UnifiedAssignedTask wire field */
    editable: true,
    /** @external UnifiedAssignedTask wire field */
    reassignable: true,
    /** @external UnifiedAssignedTask wire field */
    deletable: true,
    isMine: !isCreateForOthers,
    owner: null,
    /** @external UnifiedAssignedTask wire field */
    reorderable: !isCreateForOthers,
    title: NEW_TASK_PLACEHOLDER_TITLE,
    description: null,
    status: "open",
    dueDate: {
      value: dueDateValue,
      confidence: null,
    },
    sectionId,
    position,
    revision: 1,
    placementRevision: 1,
    updatedAt: now,
    completedAt: null,
    sourceMeeting: null,
  };

  return { isCreateForOthers, temporaryTaskId, dueDateValue, optimisticTask };
}

function stageOptimisticAssignedWorkspaceTaskCreate(input: {
  temporaryTaskId: string;
  optimisticTask: UnifiedAssignedTask;
  markTaskEntering: (taskId: string) => void;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  setTitleCaretByTaskId: Dispatch<SetStateAction<Record<string, number | null>>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
  editingTaskIdRef: RefObject<string | null>;
}) {
  const {
    temporaryTaskId,
    optimisticTask,
    markTaskEntering,
    setOptimisticCreateTasksById,
    setActiveTaskId,
    setSelectedTaskIds,
    setSelectionAnchorId,
    setDrafts,
    setTitleCaretByTaskId,
    createTaskInsertionTargetRef,
    setEditingTaskId,
    editingTaskIdRef,
  } = input;
  setOptimisticCreateTasksById((current) => ({
    ...current,
    [temporaryTaskId]: optimisticTask,
  }));
  markTaskEntering(temporaryTaskId);
  setActiveTaskId(temporaryTaskId);
  setSelectedTaskIds(new Set([temporaryTaskId]));
  setSelectionAnchorId(temporaryTaskId);
  setDrafts((current) => ({
    ...current,
    [temporaryTaskId]: {
      title: "",
      description: "",
    },
  }));
  setTitleCaretByTaskId((current) => ({
    ...current,
    [temporaryTaskId]: 0,
  }));
  createTaskInsertionTargetRef.current = { type: "task", taskId: temporaryTaskId };
  setEditingTaskId(temporaryTaskId);
  editingTaskIdRef.current = temporaryTaskId;
}

async function runCreateAssignedWorkspaceTask(input: {
  sessionToken: string;
  workspaceId: string;
  userId: string;
  view: AssignedTaskView;
  allTasks: UnifiedAssignedTask[];
  queryClient: ReturnType<typeof useQueryClient>;
  markTaskEntering: (taskId: string) => void;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  setTitleCaretByTaskId: Dispatch<SetStateAction<Record<string, number | null>>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
  editingTaskIdRef: RefObject<string | null>;
  setOptimisticCreateServerTaskIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  pendingCreateResolutionsRef: RefObject<Record<string, PendingCreateResolution>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  resolveTemporaryTask: (temporaryTaskId: string) => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const {
    sessionToken,
    workspaceId,
    userId,
    view,
    allTasks,
    queryClient,
    markTaskEntering,
    setOptimisticCreateTasksById,
    setActiveTaskId,
    setSelectedTaskIds,
    setSelectionAnchorId,
    setDrafts,
    setTitleCaretByTaskId,
    createTaskInsertionTargetRef,
    setEditingTaskId,
    editingTaskIdRef,
    setOptimisticCreateServerTaskIdsByTemporaryId,
    pendingCreateUpdatesRef,
    pendingCreateResolutionsRef,
    optimisticCreateTaskOrderHintsRef,
    resolveTemporaryTask,
    setError,
  } = input;
  const { isCreateForOthers, temporaryTaskId, dueDateValue, optimisticTask } = buildOptimisticAssignedWorkspaceTask({
    view,
    workspaceId,
    allTasks,
  });
  const queryKey = personalAssignedTasksQueryKey(userId);
  void queryClient.cancelQueries({ queryKey });
  stageOptimisticAssignedWorkspaceTaskCreate({
    temporaryTaskId,
    optimisticTask,
    markTaskEntering,
    setOptimisticCreateTasksById,
    setActiveTaskId,
    setSelectedTaskIds,
    setSelectionAnchorId,
    setDrafts,
    setTitleCaretByTaskId,
    createTaskInsertionTargetRef,
    setEditingTaskId,
    editingTaskIdRef,
  });
  await submitCreatedAssignedWorkspaceTask({
    sessionToken,
    workspaceId,
    isCreateForOthers,
    dueDateValue,
    temporaryTaskId,
    optimisticTask,
    queryKey,
    queryClient,
    setOptimisticCreateServerTaskIdsByTemporaryId,
    pendingCreateUpdatesRef,
    pendingCreateResolutionsRef,
    optimisticCreateTaskOrderHintsRef,
    setOptimisticCreateTasksById,
    editingTaskIdRef,
    resolveTemporaryTask,
    setError,
  });
}

function rollbackFailedTaskCreate(input: {
  temporaryTaskId: string;
  queryKey: ReturnType<typeof personalAssignedTasksQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  setOptimisticCreateServerTaskIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  pendingCreateResolutionsRef: RefObject<Record<string, PendingCreateResolution>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
}) {
  const { temporaryTaskId, pendingCreateUpdatesRef, pendingCreateResolutionsRef, optimisticCreateTaskOrderHintsRef } =
    input;
  input.queryClient.setQueryData<WorkspaceAssignedTasksCache>(input.queryKey, (current) =>
    removeCachedTask({ data: current, taskId: temporaryTaskId }),
  );
  input.setOptimisticCreateTasksById((current) => {
    const next = { ...current };
    delete next[temporaryTaskId];

    return next;
  });
  delete pendingCreateUpdatesRef.current[temporaryTaskId];
  delete pendingCreateResolutionsRef.current[temporaryTaskId];
  delete optimisticCreateTaskOrderHintsRef.current[temporaryTaskId];
  input.setOptimisticCreateServerTaskIdsByTemporaryId((current) => {
    const next = { ...current };
    delete next[temporaryTaskId];

    return next;
  });
}

async function submitCreatedAssignedWorkspaceTask(input: {
  sessionToken: string;
  workspaceId: string;
  isCreateForOthers: boolean;
  dueDateValue: null;
  temporaryTaskId: string;
  optimisticTask: UnifiedAssignedTask;
  queryKey: ReturnType<typeof personalAssignedTasksQueryKey>;
  queryClient: ReturnType<typeof useQueryClient>;
  setOptimisticCreateServerTaskIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  pendingCreateResolutionsRef: RefObject<Record<string, PendingCreateResolution>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  editingTaskIdRef: RefObject<string | null>;
  resolveTemporaryTask: (temporaryTaskId: string) => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const {
    sessionToken,
    workspaceId,
    isCreateForOthers,
    dueDateValue,
    temporaryTaskId,
    optimisticTask,
    setOptimisticCreateServerTaskIdsByTemporaryId,
    pendingCreateUpdatesRef,
    pendingCreateResolutionsRef,
    editingTaskIdRef,
    resolveTemporaryTask,
    setError,
  } = input;
  const createRequest = createWorkspaceTask({
    token: sessionToken,
    workspaceId,
    input: { title: NEW_TASK_PLACEHOLDER_TITLE, assigneeUserId: isCreateForOthers ? null : undefined, dueDateValue },
  });
  trackPendingTaskCreate({ temporaryTaskId, createRequest });
  try {
    const task = await createRequest;
    if (deletedTemporaryTaskIds.has(temporaryTaskId)) {
      return;
    }
    const createdTask: UnifiedAssignedTask = {
      ...optimisticTask,
      sourceId: task.id,
      taskId: task.id,
      title: task.title,
      description: task.description,
      dueDate: task.dueDate,
      revision: task.revision,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
    };
    setOptimisticCreateServerTaskIdsByTemporaryId((current) => ({
      ...current,
      [temporaryTaskId]: task.id,
    }));
    const pendingUpdate = pendingCreateUpdatesRef.current[temporaryTaskId];
    delete pendingCreateUpdatesRef.current[temporaryTaskId];
    const replacementTask: UnifiedAssignedTask = pendingUpdate
      ? {
          ...createdTask,
          title: pendingUpdate.title,
          description: pendingUpdate.description,
        }
      : createdTask;
    pendingCreateResolutionsRef.current[temporaryTaskId] = {
      task: replacementTask,
      pendingUpdate,
    };
    if (editingTaskIdRef.current === temporaryTaskId) {
      return;
    }
    await resolveTemporaryTask(temporaryTaskId);
  } catch (nextError) {
    rollbackFailedTaskCreate(input);
    setError(nextError instanceof Error ? nextError.message : "Task could not be created.");
  } finally {
    forgetPendingTaskCreate(temporaryTaskId);
  }
}

function commitTemporarySectionTitleChange(input: {
  section: WorkspaceTaskSection;
  nextTitle: string;
  workspaceId: string | null;
  userId: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
  setOptimisticCreateSectionsById: Dispatch<SetStateAction<Record<string, WorkspaceTaskSection>>>;
  pendingCreateSectionTitlesRef: RefObject<Record<string, string>>;
  editingSectionIdRef: RefObject<string | null>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  resolveTemporarySection: (temporarySectionId: string) => Promise<void>;
}) {
  const {
    section,
    nextTitle,
    workspaceId,
    userId,
    queryClient,
    setOptimisticCreateSectionsById,
    pendingCreateSectionTitlesRef,
    editingSectionIdRef,
    setEditingSectionId,
    resolveTemporarySection,
  } = input;
  pendingCreateSectionTitlesRef.current[section.id] = nextTitle;
  if (nextTitle !== section.title && isPresentString(workspaceId) && isPresentString(userId)) {
    queryClient.setQueryData<WorkspaceAssignedTasksCache>(personalAssignedTasksQueryKey(userId), (current) =>
      updateCachedSectionTitle({ data: current, sectionId: section.id, title: nextTitle }),
    );
    setOptimisticCreateSectionsById((current) => {
      const optimisticSection = current[section.id];
      if (!optimisticSection) {
        return current;
      }

      return {
        ...current,
        [section.id]: {
          ...optimisticSection,
          title: nextTitle,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  }
  editingSectionIdRef.current = null;
  setEditingSectionId(null);
  void resolveTemporarySection(section.id);
}

async function persistWorkspaceSectionTitle(input: {
  sessionToken: string;
  workspaceId: string;
  userId: string;
  section: WorkspaceTaskSection;
  nextTitle: string;
  queryClient: ReturnType<typeof useQueryClient>;
  editingSectionIdRef: RefObject<string | null>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
  setError: (message: string | null) => void;
}) {
  const {
    sessionToken,
    workspaceId,
    userId,
    section,
    nextTitle,
    queryClient,
    editingSectionIdRef,
    setEditingSectionId,
    invalidateTasks,
    setError,
  } = input;
  const queryKey = personalAssignedTasksQueryKey(userId);
  const previousTasks = queryClient.getQueryData<WorkspaceAssignedTasksCache>(queryKey);
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
    updateCachedSectionTitle({ data: current, sectionId: section.id, title: nextTitle }),
  );
  editingSectionIdRef.current = null;
  setEditingSectionId(null);
  try {
    const updatedSection = await updateWorkspaceTaskSection({
      token: sessionToken,
      workspaceId,
      sectionId: section.id,
      input: {
        title: nextTitle,
      },
    });
    queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            sections: (current.sections ?? []).map((item) => (item.id === updatedSection.id ? updatedSection : item)),
          }
        : current,
    );
    invalidateTasks();
  } catch (nextError) {
    queryClient.setQueryData(queryKey, previousTasks);
    setError(nextError instanceof Error ? nextError.message : "Section could not be updated.");
  }
}

function assigneeParticipantsForAssignedTaskRow(input: {
  task: UnifiedAssignedTask;
  assigneeParticipantsByMeetingId: Map<string, TaskAssigneeParticipant[]>;
  workspaceAssigneeParticipantsByWorkspaceId: Map<string, TaskAssigneeParticipant[]>;
}) {
  const { task, assigneeParticipantsByMeetingId, workspaceAssigneeParticipantsByWorkspaceId } = input;
  if (task.sourceType === "meeting") {
    return assigneeParticipantsByMeetingId.get(task.sourceId) ?? [];
  }

  return workspaceAssigneeParticipantsByWorkspaceId.get(task.workspaceId) ?? [];
}

function assignedTaskSortableRowSelection(input: {
  shouldSuppressRowSelectionDuringDrag: boolean;
  activeTaskId: string | null;
  taskId: string;
  isSelected: boolean;
  selectedTaskIds: Set<string>;
  tasks: UnifiedAssignedTask[];
  index: number;
}) {
  const { shouldSuppressRowSelectionDuringDrag, activeTaskId, taskId, isSelected, selectedTaskIds, tasks, index } =
    input;
  if (shouldSuppressRowSelectionDuringDrag) {
    return {
      isActive: false,
      isSelected: false,
      isSelectedAfterPrevious: false,
      isSelectedBeforeNext: false,
    };
  }

  return {
    isActive: activeTaskId === taskId,
    isSelected,
    isSelectedAfterPrevious: isSelected && selectedTaskIds.has(tasks[index - 1]?.taskId ?? ""),
    isSelectedBeforeNext: isSelected && selectedTaskIds.has(tasks[index + 1]?.taskId ?? ""),
  };
}

function assignedTaskSortableRowShowsDropPlaceholder(input: {
  dragInsertionTarget: DragInsertionTarget;
  sectionId: string;
  index: number;
}) {
  const { dragInsertionTarget, sectionId, index } = input;

  return dragInsertionTarget?.sectionId === sectionId && dragInsertionTarget.index === index;
}

function assignedTaskSortableRowIsFadingOut(input: {
  statusLingerByTaskId: Record<string, StatusLingerState>;
  taskId: string;
  view: AssignedTaskView;
}) {
  const state = input.statusLingerByTaskId[input.taskId];
  if (state === undefined) {
    return false;
  }

  return state.view === input.view && state.isFading;
}

type AssignedTaskSortableRowsProps = Pick<
  AssignedTaskManagerSectionProps,
  | "tasks"
  | "isCollapsed"
  | "activeDragId"
  | "activeDragTaskIds"
  | "section"
  | "dragInsertionTarget"
  | "selectedTaskIds"
  | "activeTaskId"
  | "editingTaskId"
  | "drafts"
  | "setDrafts"
  | "selectTask"
  | "beginEdit"
  | "cancelEdit"
  | "commitEdit"
  | "toggleTaskDone"
  | "canUpdateTaskStatus"
  | "assignTask"
  | "refreshWorkspaceAssignees"
  | "assigneeParticipantsByMeetingId"
  | "workspaceAssigneeParticipantsByWorkspaceId"
  | "currentUserParticipant"
  | "canReassignTask"
  | "canDragTask"
  | "assigningTaskIds"
  | "titleCaretByTaskId"
  | "statusLingerByTaskId"
  | "enteringTaskIds"
  | "view"
>;

function AssignedTaskSortableRow(input: AssignedTaskSortableRowsProps & { task: UnifiedAssignedTask; index: number }) {
  const {
    task,
    index,
    tasks,
    activeDragId,
    activeDragTaskIds,
    section,
    dragInsertionTarget,
    selectedTaskIds,
    activeTaskId,
    editingTaskId,
    drafts,
    setDrafts,
    selectTask,
    beginEdit,
    cancelEdit,
    commitEdit,
    toggleTaskDone,
    canUpdateTaskStatus,
    assignTask,
    refreshWorkspaceAssignees,
    assigneeParticipantsByMeetingId,
    workspaceAssigneeParticipantsByWorkspaceId,
    currentUserParticipant,
    canReassignTask,
    canDragTask,
    assigningTaskIds,
    titleCaretByTaskId,
    statusLingerByTaskId,
    enteringTaskIds,
    view,
  } = input;
  const isSelected = selectedTaskIds.has(task.taskId);
  const shouldSuppressRowSelectionDuringDrag = Boolean(activeDragId);
  const selection = assignedTaskSortableRowSelection({
    shouldSuppressRowSelectionDuringDrag,
    activeTaskId,
    taskId: task.taskId,
    isSelected,
    selectedTaskIds,
    tasks,
    index,
  });

  return (
    <div className="workspace-task-sortable-slot">
      <TaskDropPlaceholder
        isVisible={assignedTaskSortableRowShowsDropPlaceholder({
          dragInsertionTarget,
          sectionId: section.id,
          index,
        })}
      />
      <TaskRow
        task={task}
        isActive={selection.isActive}
        isSelected={selection.isSelected}
        isSelectedAfterPrevious={selection.isSelectedAfterPrevious}
        isSelectedBeforeNext={selection.isSelectedBeforeNext}
        isHiddenDuringDrag={activeDragTaskIds.has(task.taskId)}
        isEditing={editingTaskId === task.taskId}
        canDrag={canDragTask({ task })}
        draft={drafts[task.taskId] ?? { title: task.title, description: taskDescription(task) }}
        onDraftChange={(draft) => setDrafts((current) => ({ ...current, [task.taskId]: draft }))}
        onSelect={(event) => void selectTask({ taskId: task.taskId, event })}
        onBeginEdit={(caretOffset) => void beginEdit({ task, titleCaretOffset: caretOffset })}
        onCancelEdit={cancelEdit}
        onCommitEdit={(draftOverride) => void commitEdit({ draftOverride })}
        onToggleDone={() => void toggleTaskDone({ task })}
        canToggleDone={canUpdateTaskStatus({ task })}
        onAssignTask={assignTask}
        onAssigneeMenuOpen={(workspaceId) => refreshWorkspaceAssignees({ workspaceId })}
        participants={assigneeParticipantsForAssignedTaskRow({
          task,
          assigneeParticipantsByMeetingId,
          workspaceAssigneeParticipantsByWorkspaceId,
        })}
        currentUserParticipant={currentUserParticipant}
        canAssignTask={canReassignTask({ task })}
        isAssigning={assigningTaskIds[task.taskId] === true}
        initialTitleCaret={titleCaretByTaskId[task.taskId] ?? null}
        isFadingOut={assignedTaskSortableRowIsFadingOut({
          statusLingerByTaskId,
          taskId: task.taskId,
          view,
        })}
        isEntering={enteringTaskIds[task.taskId] === true}
        shouldSuppressSortableTransform={shouldSuppressRowSelectionDuringDrag}
      />
    </div>
  );
}

function AssignedTaskSortableRows(input: AssignedTaskSortableRowsProps) {
  const visibleTasks = input.isCollapsed
    ? []
    : input.activeDragId !== null
      ? input.tasks.filter((task) => !input.activeDragTaskIds.has(task.taskId))
      : input.tasks;

  return visibleTasks.map((task, index) => (
    <AssignedTaskSortableRow key={`${task.sourceType}:${task.taskId}`} {...input} task={task} index={index} />
  ));
}

type AssignedTaskManagerSectionProps = {
  groupId: string;
  label: string;
  section: WorkspaceTaskSection;
  tasks: UnifiedAssignedTask[];
  isCollapsed: boolean;
  view: AssignedTaskView;
  activeDragId: string | null;
  editingTaskId: string | null;
  activeTaskId: string | null;
  cancelEdit: () => void;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setCollapsedPeriodIds: Dispatch<SetStateAction<Set<string>>>;
  activeSectionId: string | null;
  editingSectionId: string | null;
  sectionDrafts: Record<string, string>;
  setSectionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  selectSection: (input: { section: WorkspaceTaskSection }) => Promise<void>;
  beginSectionEdit: (input: { section: WorkspaceTaskSection; titleCaretOffset?: number }) => Promise<void>;
  cancelSectionEdit: () => void;
  commitSectionEdit: (input: { titleOverride?: string }) => Promise<void>;
  sectionTitleCaretBySectionId: Record<string, number | null>;
  activeDragTaskIds: Set<string>;
  dragInsertionTarget: DragInsertionTarget;
  selectedTaskIds: Set<string>;
  drafts: Record<string, TaskDraft>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  selectTask: (input: { taskId: string; event?: MouseEvent }) => Promise<void>;
  beginEdit: (input: { task: UnifiedAssignedTask; titleCaretOffset?: number }) => Promise<void>;
  commitEdit: (input: { draftOverride?: TaskDraft }) => Promise<void>;
  toggleTaskDone: (input: { task: UnifiedAssignedTask }) => Promise<void>;
  canUpdateTaskStatus: (input: { task: UnifiedAssignedTask }) => boolean;
  assignTask: (input: { task: UnifiedAssignedTask; nextOwnerUserId: string | null }) => Promise<void>;
  refreshWorkspaceAssignees: (input: { workspaceId: string }) => void;
  assigneeParticipantsByMeetingId: Map<string, TaskAssigneeParticipant[]>;
  workspaceAssigneeParticipantsByWorkspaceId: Map<string, TaskAssigneeParticipant[]>;
  currentUserParticipant: TaskAssigneeParticipant | null;
  canReassignTask: (input: { task: UnifiedAssignedTask }) => boolean;
  canDragTask: (input: { task: UnifiedAssignedTask }) => boolean;
  assigningTaskIds: Record<string, true>;
  titleCaretByTaskId: Record<string, number | null>;
  statusLingerByTaskId: Record<string, StatusLingerState>;
  enteringTaskIds: Record<string, true>;
};

function toggleAssignedTaskPeriodCollapse(input: {
  groupId: string;
  tasks: UnifiedAssignedTask[];
  editingTaskId: string | null;
  activeTaskId: string | null;
  cancelEdit: () => void;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setCollapsedPeriodIds: Dispatch<SetStateAction<Set<string>>>;
}) {
  const {
    groupId,
    tasks,
    editingTaskId,
    activeTaskId,
    cancelEdit,
    setActiveTaskId,
    setSelectedTaskIds,
    setCollapsedPeriodIds,
  } = input;
  const groupTaskIds = new Set(tasks.map((task) => task.taskId));
  if (isPresentString(editingTaskId) && groupTaskIds.has(editingTaskId)) {
    cancelEdit();
  }
  if (isPresentString(activeTaskId) && groupTaskIds.has(activeTaskId)) {
    setActiveTaskId(null);
  }
  setSelectedTaskIds((current) => new Set([...current].filter((taskId) => !groupTaskIds.has(taskId))));
  setCollapsedPeriodIds((current) => {
    const next = new Set(current);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
    }

    return next;
  });
}

function assignedTaskManagerSectionEndDropPlaceholderVisible(input: {
  dragInsertionTarget: DragInsertionTarget;
  sectionId: string;
  tasks: UnifiedAssignedTask[];
  activeDragId: string | null;
  activeDragTaskIds: Set<string>;
}) {
  const visibleTaskCount =
    input.activeDragId !== null
      ? input.tasks.filter((task) => !input.activeDragTaskIds.has(task.taskId)).length
      : input.tasks.length;

  return (
    input.dragInsertionTarget?.sectionId === input.sectionId && input.dragInsertionTarget.index === visibleTaskCount
  );
}

function AssignedTaskManagerPeriodHeader({
  groupId,
  label,
  taskCount,
  isCollapsed,
  activeDragId,
  onToggle,
}: {
  groupId: string;
  label: string;
  taskCount: number;
  isCollapsed: boolean;
  activeDragId: string | null;
  onToggle: () => void;
}) {
  return (
    <div className="workspace-task-period-slot">
      <h2 className="workspace-task-period-heading">
        <button
          type="button"
          className="workspace-task-period-header"
          aria-expanded={!isCollapsed}
          aria-controls={groupId}
          disabled={Boolean(activeDragId)}
          onClick={onToggle}
        >
          <svg className="workspace-task-period-chevron" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 3h7L5 8Z" fill="currentColor" />
          </svg>
          <span>{label}</span>
          <span className="workspace-task-period-count">{taskCount}</span>
        </button>
      </h2>
    </div>
  );
}

function AssignedTaskManagerSectionTaskList({ sectionInput }: { sectionInput: AssignedTaskManagerSectionProps }) {
  const {
    groupId,
    section,
    tasks,
    isCollapsed,
    view,
    activeDragId,
    activeDragTaskIds,
    dragInsertionTarget,
    selectedTaskIds,
    activeTaskId,
    editingTaskId,
    drafts,
    setDrafts,
    selectTask,
    beginEdit,
    cancelEdit,
    commitEdit,
    toggleTaskDone,
    canUpdateTaskStatus,
    assignTask,
    refreshWorkspaceAssignees,
    assigneeParticipantsByMeetingId,
    workspaceAssigneeParticipantsByWorkspaceId,
    currentUserParticipant,
    canReassignTask,
    canDragTask,
    assigningTaskIds,
    titleCaretByTaskId,
    statusLingerByTaskId,
    enteringTaskIds,
  } = sectionInput;

  return (
    <SortableContext items={isCollapsed ? [] : tasks.map((task) => task.taskId)} strategy={verticalListSortingStrategy}>
      <div className="workspace-task-list" id={groupId}>
        <AssignedTaskSortableRows
          tasks={tasks}
          isCollapsed={isCollapsed}
          activeDragId={activeDragId}
          activeDragTaskIds={activeDragTaskIds}
          section={section}
          dragInsertionTarget={dragInsertionTarget}
          selectedTaskIds={selectedTaskIds}
          activeTaskId={activeTaskId}
          editingTaskId={editingTaskId}
          drafts={drafts}
          setDrafts={setDrafts}
          selectTask={selectTask}
          beginEdit={beginEdit}
          cancelEdit={cancelEdit}
          commitEdit={commitEdit}
          toggleTaskDone={toggleTaskDone}
          canUpdateTaskStatus={canUpdateTaskStatus}
          assignTask={assignTask}
          refreshWorkspaceAssignees={refreshWorkspaceAssignees}
          assigneeParticipantsByMeetingId={assigneeParticipantsByMeetingId}
          workspaceAssigneeParticipantsByWorkspaceId={workspaceAssigneeParticipantsByWorkspaceId}
          currentUserParticipant={currentUserParticipant}
          canReassignTask={canReassignTask}
          canDragTask={canDragTask}
          assigningTaskIds={assigningTaskIds}
          titleCaretByTaskId={titleCaretByTaskId}
          statusLingerByTaskId={statusLingerByTaskId}
          enteringTaskIds={enteringTaskIds}
          view={view}
        />
        <TaskDropPlaceholder
          isVisible={assignedTaskManagerSectionEndDropPlaceholderVisible({
            dragInsertionTarget,
            sectionId: section.id,
            tasks,
            activeDragId,
            activeDragTaskIds,
          })}
        />
      </div>
    </SortableContext>
  );
}

function AssignedTaskManagerSection(input: AssignedTaskManagerSectionProps) {
  const {
    groupId,
    label,
    section,
    tasks,
    isCollapsed,
    view,
    activeDragId,
    editingTaskId,
    activeTaskId,
    cancelEdit,
    setActiveTaskId,
    setSelectedTaskIds,
    setCollapsedPeriodIds,
    activeSectionId,
    editingSectionId,
    sectionDrafts,
    setSectionDrafts,
    selectSection,
    beginSectionEdit,
    cancelSectionEdit,
    commitSectionEdit,
    sectionTitleCaretBySectionId,
  } = input;

  return (
    <section className="workspace-task-manager-section">
      <AssignedTaskManagerPeriodHeader
        groupId={groupId}
        label={label}
        taskCount={tasks.length}
        isCollapsed={isCollapsed}
        activeDragId={activeDragId}
        onToggle={() =>
          toggleAssignedTaskPeriodCollapse({
            groupId,
            tasks,
            editingTaskId,
            activeTaskId,
            cancelEdit,
            setActiveTaskId,
            setSelectedTaskIds,
            setCollapsedPeriodIds,
          })
        }
      />
      {view === "mine" && !section.isDefault && section.title.trim() !== "" ? (
        <div className="workspace-task-manager-section-header">
          <SectionHeaderRow
            section={section}
            isActive={activeSectionId === section.id}
            isEditing={editingSectionId === section.id}
            draftTitle={sectionDrafts[section.id] ?? section.title}
            onDraftChange={(title) => setSectionDrafts((current) => ({ ...current, [section.id]: title }))}
            onSelect={() => void selectSection({ section })}
            onBeginEdit={(caretOffset) => void beginSectionEdit({ section, titleCaretOffset: caretOffset })}
            onCancelEdit={cancelSectionEdit}
            onCommitEdit={(titleOverride) => void commitSectionEdit({ titleOverride })}
            initialTitleCaret={sectionTitleCaretBySectionId[section.id] ?? null}
            placeholder={section.title}
          />
        </div>
      ) : null}
      <AssignedTaskManagerSectionTaskList sectionInput={input} />
    </section>
  );
}

type AssignedTaskManagerSectionSharedProps = Omit<
  AssignedTaskManagerSectionProps,
  "groupId" | "label" | "section" | "tasks" | "isCollapsed"
>;

function WorkspaceAssignedTasksManagerContent(input: {
  containerRef: RefObject<HTMLDivElement | null>;
  paintSelection: { box: TaskPaintSelectionBox | null };
  pageTitle: string;
  renderSections: RenderSection[];
  collapsedPeriodIds: Set<string>;
  shouldShowEmptyPlaceholder: boolean;
  sharedSectionProps: AssignedTaskManagerSectionSharedProps;
}) {
  const {
    containerRef,
    paintSelection,
    pageTitle,
    renderSections,
    collapsedPeriodIds,
    shouldShowEmptyPlaceholder,
    sharedSectionProps,
  } = input;

  return (
    <div
      ref={containerRef}
      className={`workspace-task-manager${paintSelection.box ? " is-paint-selecting" : ""}`}
      tabIndex={0}
      aria-label={`${pageTitle} tasks`}
    >
      {renderSections.map(({ groupId, label, section, tasks }) => (
        <AssignedTaskManagerSection
          key={groupId}
          groupId={groupId}
          label={label}
          section={section}
          tasks={tasks}
          isCollapsed={collapsedPeriodIds.has(groupId)}
          {...sharedSectionProps}
        />
      ))}
      {shouldShowEmptyPlaceholder ? <EmptyTaskViewIcon view={sharedSectionProps.view} /> : null}
      {paintSelection.box ? (
        <div className="workspace-task-selection-marquee" aria-hidden="true" style={{ ...paintSelection.box }} />
      ) : null}
    </div>
  );
}

function WorkspaceAssignedTasksSearchControl(input: {
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
}) {
  const { searchQuery, setSearchQuery } = input;

  return (
    <div className="workspace-task-search-control">
      <SearchIcon />
      <input
        type="search"
        className="workspace-task-search-input"
        value={searchQuery}
        placeholder="Search"
        aria-label="Search tasks"
        onChange={(event) => setSearchQuery(event.currentTarget.value)}
        onPointerDown={(event) => event.stopPropagation()}
      />
      {searchQuery.length > 0 ? (
        <button
          type="button"
          className="workspace-task-search-clear"
          aria-label="Clear search"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setSearchQuery("")}
        >
          <SearchClearIcon />
        </button>
      ) : null}
    </div>
  );
}

type WorkspaceAssignedTasksPageHeaderInput = {
  pageTitle: string;
  view: AssignedTaskView;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  canCreate: boolean;
  selectedVisibleTasks: UnifiedAssignedTask[];
  canDeleteSelection: boolean;
  canUpdateTaskStatus: (task: UnifiedAssignedTask) => boolean;
  toggleTasksDone: (tasks: UnifiedAssignedTask[]) => Promise<void>;
  clearTaskFocus: () => void;
  deleteSelectedTasks: () => Promise<void>;
  allTasks: UnifiedAssignedTask[];
  isClearingDone: boolean;
  clearDoneTasks: (range: ClearDoneTasksRange) => Promise<void>;
  reopenableSelectedDoneTasks: UnifiedAssignedTask[];
  selectedDoneTasks: UnifiedAssignedTask[];
  reopenSelectedDone: () => Promise<void>;
  clearSelectedDone: () => Promise<void>;
  createTask: () => Promise<void>;
};

function WorkspaceAssignedTasksPageHeaderActions(input: WorkspaceAssignedTasksPageHeaderInput) {
  const {
    view,
    searchQuery,
    setSearchQuery,
    canCreate,
    selectedVisibleTasks,
    canDeleteSelection,
    canUpdateTaskStatus,
    toggleTasksDone,
    clearTaskFocus,
    deleteSelectedTasks,
    allTasks,
    isClearingDone,
    clearDoneTasks,
    reopenableSelectedDoneTasks,
    selectedDoneTasks,
    reopenSelectedDone,
    clearSelectedDone,
    createTask,
  } = input;

  return (
    <div className="workspace-task-page-actions">
      <TaskListBackToTopButton />
      {selectedVisibleTasks.length !== 0 && view !== "done" ? (
        <TaskSelectionMenu
          canComplete={selectedVisibleTasks.some((task) => task.status !== "completed" && canUpdateTaskStatus(task))}
          canRemove={canDeleteSelection}
          onComplete={() => {
            void toggleTasksDone(selectedVisibleTasks.filter((task) => task.status !== "completed"));
            clearTaskFocus();
          }}
          onRemove={() => void deleteSelectedTasks()}
        />
      ) : null}
      {view === "done" ? (
        <DoneTasksMenu
          tasks={allTasks}
          isBusy={isClearingDone}
          onClear={(range) => void clearDoneTasks(range)}
          selection={
            selectedVisibleTasks.length !== 0
              ? {
                  canReopen: reopenableSelectedDoneTasks.length !== 0,
                  canClear: selectedDoneTasks.length !== 0,
                  onReopen: () => void reopenSelectedDone(),
                  onClear: () => void clearSelectedDone(),
                }
              : undefined
          }
        />
      ) : null}
      {canCreate || view === "done" ? (
        <button
          type="button"
          className="workspace-task-topbar-button workspace-task-new-task-button"
          aria-label="New task"
          title={canCreate ? "New task" : undefined}
          disabled={!canCreate}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void createTask()}
        >
          <NewTaskButtonIcon />
        </button>
      ) : null}
      <WorkspaceAssignedTasksSearchControl searchQuery={searchQuery} setSearchQuery={setSearchQuery} />
    </div>
  );
}

function WorkspaceAssignedTasksPageHeader(input: WorkspaceAssignedTasksPageHeaderInput) {
  const { pageTitle } = input;

  return (
    <div className="workspace-task-page-header">
      <h1 className="workspace-task-page-title">{pageTitle}</h1>
      <WorkspaceAssignedTasksPageHeaderActions {...input} />
    </div>
  );
}

function WorkspaceAssignedTasksPageRoot(input: {
  sharedSectionProps: AssignedTaskManagerSectionSharedProps;
  containerRef: RefObject<HTMLDivElement | null>;
  paintSelection: { box: TaskPaintSelectionBox | null };
  pageTitle: string;
  renderSections: RenderSection[];
  collapsedPeriodIds: Set<string>;
  shouldShowEmptyPlaceholder: boolean;
  pageHeader: ReactNode;
  sensors: ReturnType<typeof useSensors>;
  taskCollisionDetection: CollisionDetection;
  onDragStart: (event: DragStartEvent) => void;
  onDragMove: (event: DragMoveEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragEnd: (event: DragEndEvent) => void | Promise<void>;
  onDragCancel: () => void;
  meetings: Meeting[];
  view: AssignedTaskView;
  canDropActiveTasksOnView: (targetView: AssignedTaskView) => boolean;
  activeDragTasks: UnifiedAssignedTask[];
  error: string | null;
  sectionDeleteConfirmation: SectionDeleteConfirmation | null;
  onDismissSectionDelete: () => void;
  onConfirmSectionDelete: () => void;
  dragPreviewWidth: number | null;
  dragCursorOffsetX: number | null;
  dragCursorOffsetY: number | null;
  isDragPointerOverTaskNav: boolean;
}) {
  const content = WorkspaceAssignedTasksManagerContent({
    containerRef: input.containerRef,
    paintSelection: input.paintSelection,
    pageTitle: input.pageTitle,
    renderSections: input.renderSections,
    collapsedPeriodIds: input.collapsedPeriodIds,
    shouldShowEmptyPlaceholder: input.shouldShowEmptyPlaceholder,
    sharedSectionProps: input.sharedSectionProps,
  });

  const onDragEnd = (event: DragEndEvent) => {
    void input.onDragEnd(event);
  };

  return WorkspaceAssignedTasksPageLayout({
    sensors: input.sensors,
    taskCollisionDetection: input.taskCollisionDetection,
    onDragStart: input.onDragStart,
    onDragMove: input.onDragMove,
    onDragOver: input.onDragOver,
    onDragEnd,
    onDragCancel: input.onDragCancel,
    meetings: input.meetings,
    view: input.view,
    canDropActiveTasksOnView: input.canDropActiveTasksOnView,
    isDraggingTask: input.activeDragTasks.length !== 0,
    error: input.error,
    pageHeader: input.pageHeader,
    content,
    sectionDeleteConfirmation: input.sectionDeleteConfirmation,
    onDismissSectionDelete: input.onDismissSectionDelete,
    onConfirmSectionDelete: input.onConfirmSectionDelete,
    activeDragTasks: input.activeDragTasks,
    dragPreviewWidth: input.dragPreviewWidth,
    dragCursorOffsetX: input.dragCursorOffsetX,
    dragCursorOffsetY: input.dragCursorOffsetY,
    isDragPointerOverTaskNav: input.isDragPointerOverTaskNav,
  });
}

function WorkspaceAssignedTasksSectionDeleteModal(input: {
  confirmation: SectionDeleteConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { confirmation, onCancel, onConfirm } = input;

  return (
    <div className="workspace-task-section-delete-modal-backdrop" role="presentation">
      <div
        className="workspace-task-section-delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="section-delete-title"
      >
        <h2 id="section-delete-title">{SECTION_DELETE_TITLE}</h2>
        <p>
          {confirmation.tasks.length !== 0
            ? `This will delete "${confirmation.section.title}" and all ${confirmation.tasks.length} tasks in this section.`
            : `This will delete "${confirmation.section.title}".`}
        </p>
        <div className="workspace-task-section-delete-modal-actions">
          <button type="button" className="workspace-task-section-delete-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="workspace-task-section-delete-confirm" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceAssignedTasksPageLayout(input: {
  sensors: ReturnType<typeof useSensors>;
  taskCollisionDetection: CollisionDetection;
  onDragStart: (event: DragStartEvent) => void;
  onDragMove: (event: DragMoveEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: () => void;
  meetings: Meeting[];
  view: AssignedTaskView;
  canDropActiveTasksOnView: (targetView: AssignedTaskView) => boolean;
  isDraggingTask: boolean;
  error: string | null;
  pageHeader: ReactNode;
  content: ReactNode;
  sectionDeleteConfirmation: SectionDeleteConfirmation | null;
  onDismissSectionDelete: () => void;
  onConfirmSectionDelete: () => void;
  activeDragTasks: UnifiedAssignedTask[];
  dragPreviewWidth: number | null;
  dragCursorOffsetX: number | null;
  dragCursorOffsetY: number | null;
  isDragPointerOverTaskNav: boolean;
}) {
  const {
    sensors,
    taskCollisionDetection,
    onDragStart,
    onDragMove,
    onDragOver,
    onDragEnd,
    onDragCancel,
    meetings,
    view,
    canDropActiveTasksOnView,
    isDraggingTask,
    error,
    pageHeader,
    content,
    sectionDeleteConfirmation,
    onDismissSectionDelete,
    onConfirmSectionDelete,
    activeDragTasks,
    dragPreviewWidth,
    dragCursorOffsetX,
    dragCursorOffsetY,
    isDragPointerOverTaskNav,
  } = input;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={taskCollisionDetection}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <WorkspaceShell
        meetings={meetings}
        activeSidebarView={activeSidebarViewForTaskView(view)}
        contentClassName="workspace-content-tasks"
        taskDropTargets={{
          canDropOnView: canDropActiveTasksOnView,
          isDraggingTask,
        }}
      >
        <div className="workspace-task-page" data-task-view={view}>
          {error !== null && error !== "" ? <div className="error-text">{error}</div> : null}

          <div className="workspace-task-page-stack">
            {pageHeader}
            <div className="workspace-task-page-body workspace-tasks-section">
              <div className="workspace-tasks-card">
                {content}
                {sectionDeleteConfirmation ? (
                  <WorkspaceAssignedTasksSectionDeleteModal
                    confirmation={sectionDeleteConfirmation}
                    onCancel={onDismissSectionDelete}
                    onConfirm={onConfirmSectionDelete}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </WorkspaceShell>
      <DragOverlay>
        {activeDragTasks.length !== 0 ? (
          <DragPreview
            tasks={activeDragTasks}
            width={dragPreviewWidth}
            cursorOffsetX={dragCursorOffsetX}
            cursorOffsetY={dragCursorOffsetY}
            isOverTaskNav={isDragPointerOverTaskNav}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

type AssignedTasksPageHotkeyInput = {
  event: globalThis.KeyboardEvent;
  activeSection: WorkspaceTaskSection | null;
  activeSectionTasks: UnifiedAssignedTask[];
  activeTask: UnifiedAssignedTask | null;
  beginEdit: (task: UnifiedAssignedTask) => Promise<void>;
  canCreate: boolean;
  cancelEdit: () => void;
  cancelSectionEdit: () => void;
  clearTaskFocus: () => void;
  createTask: () => Promise<void>;
  deleteSelectedTasks: () => Promise<void>;
  editingSectionId: string | null;
  editingTaskId: string | null;
  orderedVisibleTasks: UnifiedAssignedTask[];
  requestDeleteSection: (input: { section: WorkspaceTaskSection; tasks: UnifiedAssignedTask[] }) => void;
  selectedVisibleTasks: UnifiedAssignedTask[];
  setActiveByOffset: (offset: number) => void;
  toggleTasksDone: (tasks: UnifiedAssignedTask[]) => Promise<void>;
};

function assignedTasksHotkeyNavigationKeys(input: AssignedTasksPageHotkeyInput) {
  const { event } = input;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    input.setActiveByOffset(1);

    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    input.setActiveByOffset(-1);

    return true;
  }

  return false;
}

function assignedTasksHotkeyActionKeys(input: AssignedTasksPageHotkeyInput) {
  const { event } = input;
  if (event.key === "Enter") {
    event.preventDefault();
    const taskToEdit = input.activeTask ?? input.orderedVisibleTasks[0] ?? null;
    if (taskToEdit !== null) {
      void input.beginEdit(taskToEdit);
    }

    return true;
  }
  if (event.key.toLowerCase() === "d") {
    event.preventDefault();
    void input.toggleTasksDone(
      input.selectedVisibleTasks.length !== 0
        ? input.selectedVisibleTasks
        : input.activeTask !== null
          ? [input.activeTask]
          : [],
    );

    return true;
  }
  if (event.key.toLowerCase() === "c") {
    event.preventDefault();
    if (input.canCreate) {
      void input.createTask();
    }

    return true;
  }

  return false;
}

function assignedTasksHotkeyDestructiveKeys(input: AssignedTasksPageHotkeyInput) {
  const { event } = input;
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    if (input.activeSection !== null && input.selectedVisibleTasks.length === 0) {
      input.requestDeleteSection({ section: input.activeSection, tasks: input.activeSectionTasks });

      return true;
    }
    void input.deleteSelectedTasks();

    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (input.editingTaskId !== null && input.editingTaskId !== "") {
      input.cancelEdit();
    } else if (input.editingSectionId !== null && input.editingSectionId !== "") {
      input.cancelSectionEdit();
    } else {
      input.clearTaskFocus();
    }

    return true;
  }

  return false;
}

function handleAssignedTasksPageHotkeyEvent(input: AssignedTasksPageHotkeyInput) {
  const { event } = input;
  if (
    isTextEntryTarget(event.target) ||
    (event.target instanceof Element && event.target.closest(".workspace-task-period-header"))
  ) {
    return;
  }
  // Leave browser/OS shortcuts alone (Cmd/Ctrl+C used to create a task) and ignore
  // auto-repeat so holding a key cannot spawn a burst of tasks.
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) {
    return;
  }
  if (assignedTasksHotkeyNavigationKeys(input)) {
    return;
  }
  if (assignedTasksHotkeyActionKeys(input)) {
    return;
  }
  assignedTasksHotkeyDestructiveKeys(input);
}

function useAssignedTasksPageHotkeys(input: {
  activeSection: WorkspaceTaskSection | null;
  activeSectionTasks: UnifiedAssignedTask[];
  activeTask: UnifiedAssignedTask | null;
  beginEdit: (task: UnifiedAssignedTask) => Promise<void>;
  canCreate: boolean;
  cancelEdit: () => void;
  cancelSectionEdit: () => void;
  clearTaskFocus: () => void;
  createTask: () => Promise<void>;
  deleteSelectedTasks: () => Promise<void>;
  editingSectionId: string | null;
  editingTaskId: string | null;
  orderedVisibleTasks: UnifiedAssignedTask[];
  requestDeleteSection: (input: { section: WorkspaceTaskSection; tasks: UnifiedAssignedTask[] }) => void;
  selectedVisibleTasks: UnifiedAssignedTask[];
  setActiveByOffset: (offset: number) => void;
  toggleTasksDone: (tasks: UnifiedAssignedTask[]) => Promise<void>;
}) {
  const handleKeyDown = useCallback(
    (event: globalThis.KeyboardEvent) => {
      handleAssignedTasksPageHotkeyEvent({ event, ...input });
    },
    [input],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}

function syncAssignedTasksSelectionToVisibleTasks(input: {
  visibleTaskIds: string[];
  editingTaskId: string | null;
  activeTaskId: string | null;
  activeSectionId: string | null;
  editingSectionId: string | null;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  sectionById: Map<string, WorkspaceTaskSection>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    visibleTaskIds,
    editingTaskId,
    activeTaskId,
    activeSectionId,
    editingSectionId,
    visibleTaskById,
    sectionById,
    createTaskInsertionTargetRef,
    setSelectedTaskIds,
    setActiveTaskId,
    setActiveSectionId,
  } = input;
  setSelectedTaskIds((current) => {
    const visible = new Set(visibleTaskIds);
    const next = new Set([...current].filter((taskId) => visible.has(taskId) || taskId === editingTaskId));

    return next.size === current.size ? current : next;
  });
  if (isPresentString(activeTaskId) && !visibleTaskById.has(activeTaskId) && activeTaskId !== editingTaskId) {
    setActiveTaskId(null);
    if (
      createTaskInsertionTargetRef.current?.type === "task" &&
      createTaskInsertionTargetRef.current.taskId === activeTaskId
    ) {
      createTaskInsertionTargetRef.current = null;
    }
  }
  if (isPresentString(activeSectionId) && !sectionById.has(activeSectionId) && activeSectionId !== editingSectionId) {
    setActiveSectionId(null);
    if (
      createTaskInsertionTargetRef.current?.type === "section" &&
      createTaskInsertionTargetRef.current.sectionId === activeSectionId
    ) {
      createTaskInsertionTargetRef.current = null;
    }
  }
}

function assignedTaskCollisionDetection(input: {
  args: Parameters<CollisionDetection>[0];
  dragPointerOverTaskNavRef: RefObject<boolean>;
  canDropActiveTasksOnView: (targetView: AssignedTaskView) => boolean;
}) {
  const { args, dragPointerOverTaskNavRef, canDropActiveTasksOnView } = input;
  const taskNavElement =
    typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".workspace-primary-rail");
  dragPointerOverTaskNavRef.current = isPointInsideRect({
    point: args.pointerCoordinates,
    rect: taskNavElement?.getBoundingClientRect() ?? null,
  });

  const pointerCollisions = pointerWithin(args);
  const taskViewCollision = pointerCollisions.find((collision) => {
    const taskView = taskViewFromDropTargetId(String(collision.id));

    return taskView !== null ? canDropActiveTasksOnView(taskView) : false;
  });
  if (taskViewCollision) {
    return [taskViewCollision];
  }

  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => taskViewFromDropTargetId(String(container.id)) === null,
    ),
  });
}

function clearAssignedTaskDragState(input: {
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
}) {
  input.setActiveDragId(null);
  input.setCurrentDragInsertionTarget(null);
}

async function runAssignedTaskDragViewDropEnd(input: {
  draggedTasks: UnifiedAssignedTask[];
  overTaskView: AssignedTaskView;
  userId: string;
  sessionToken: string;
  getTaskViewDropPatch: (input: {
    task: UnifiedAssignedTask;
    targetView: AssignedTaskView;
  }) => AssignedTaskViewDropPatch | null;
  currentUserParticipant: TaskAssigneeParticipant | null;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: (message: string | null) => void;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
}) {
  const taskPatches = input.draggedTasks
    .filter((task) => !isTemporaryTaskId(task.taskId))
    .flatMap((task) => {
      const patch = input.getTaskViewDropPatch({ task, targetView: input.overTaskView });

      return patch ? [{ task, patch }] : [];
    });
  if (taskPatches.length === 0) {
    clearAssignedTaskDragState(input);

    return;
  }

  await applyAssignedTaskDragViewDrop({
    taskPatches,
    userId: input.userId,
    sessionToken: input.sessionToken,
    currentUserParticipant: input.currentUserParticipant,
    queryClient: input.queryClient,
    invalidateTasks: input.invalidateTasks,
    setError: input.setError,
    onComplete: () => {
      flushSync(() => input.setActiveDragId(null));
      input.setCurrentDragInsertionTarget(null);
    },
  });
}

async function runAssignedTaskDragReorderEnd(input: {
  event: DragEndEvent;
  activeId: string;
  overId: string;
  draggedTasks: UnifiedAssignedTask[];
  sessionToken: string;
  workspaceId: string;
  userId: string;
  dragInsertionTargetRef: RefObject<DragInsertionTarget>;
  getDragInsertionTarget: (input: {
    activeId: string;
    overId: string;
    activeCenterY: number | null;
  }) => DragInsertionTarget;
  anchorsFromInsertionTarget: (input: {
    target: DragInsertionTarget;
    movedTaskIds: string[];
  }) => DragAnchorTarget | null;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
  sections: WorkspaceTaskSection[];
  allTasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
  isSearching: boolean;
  trimmedSearchQuery: string;
  lingeringTaskIds: Set<string>;
  sectionById: Map<string, WorkspaceTaskSection>;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: (message: string | null) => void;
}) {
  const movedTaskIds = input.draggedTasks.map((task) => task.taskId);
  const insertionTarget =
    input.dragInsertionTargetRef.current ??
    input.getDragInsertionTarget({
      activeId: input.activeId,
      overId: input.overId,
      activeCenterY: activeCenterYFromDragEvent(input.event),
    });
  const anchors = input.anchorsFromInsertionTarget({ target: insertionTarget, movedTaskIds });
  if (!anchors) {
    clearAssignedTaskDragState(input);

    return;
  }
  input.setCurrentDragInsertionTarget(null);

  await applyAssignedTaskDragReorder({
    reorderInput: {
      movedTaskIds,
      targetSectionId: anchors.targetSectionId,
      beforeTaskId: anchors.beforeTaskId,
      afterTaskId: anchors.afterTaskId,
    },
    sessionToken: input.sessionToken,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sections: input.sections,
    allTasks: input.allTasks,
    view: input.view,
    isSearching: input.isSearching,
    trimmedSearchQuery: input.trimmedSearchQuery,
    lingeringTaskIds: input.lingeringTaskIds,
    sectionById: input.sectionById,
    queryClient: input.queryClient,
    invalidateTasks: input.invalidateTasks,
    setError: input.setError,
    onPreview: (previewVisibleTasks) => input.setReorderPreviewTasks(previewVisibleTasks),
    onPreviewClear: () => input.setReorderPreviewTasks(null),
    onDragEnd: () => input.setActiveDragId(null),
  });
}

async function runAssignedTaskDragEnd(input: {
  event: DragEndEvent;
  sessionToken: string;
  workspaceId: string;
  userId: string;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  canDragTask: (input: { task: UnifiedAssignedTask }) => boolean;
  getDraggedTasks: (input: { activeId: string }) => UnifiedAssignedTask[];
  getTaskViewDropPatch: (input: {
    task: UnifiedAssignedTask;
    targetView: AssignedTaskView;
  }) => AssignedTaskViewDropPatch | null;
  dragInsertionTargetRef: RefObject<DragInsertionTarget>;
  getDragInsertionTarget: (input: {
    activeId: string;
    overId: string;
    activeCenterY: number | null;
  }) => DragInsertionTarget;
  anchorsFromInsertionTarget: (input: {
    target: DragInsertionTarget;
    movedTaskIds: string[];
  }) => DragAnchorTarget | null;
  currentUserParticipant: TaskAssigneeParticipant | null;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: (message: string | null) => void;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
  sections: WorkspaceTaskSection[];
  allTasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
  isSearching: boolean;
  trimmedSearchQuery: string;
  lingeringTaskIds: Set<string>;
  sectionById: Map<string, WorkspaceTaskSection>;
}) {
  if (input.event.over === null) {
    clearAssignedTaskDragState(input);

    return;
  }
  const activeId = String(input.event.active.id);
  const overId = String(input.event.over.id);
  const active = input.visibleTaskById.get(activeId);
  if (active === undefined || !input.canDragTask({ task: active })) {
    clearAssignedTaskDragState(input);

    return;
  }
  const draggedTasks = input.getDraggedTasks({ activeId });
  if (draggedTasks.length === 0) {
    clearAssignedTaskDragState(input);

    return;
  }
  const overTaskView = taskViewFromDropTargetId(overId);
  if (overTaskView !== null) {
    await runAssignedTaskDragViewDropEnd({
      draggedTasks,
      overTaskView,
      userId: input.userId,
      sessionToken: input.sessionToken,
      getTaskViewDropPatch: input.getTaskViewDropPatch,
      currentUserParticipant: input.currentUserParticipant,
      queryClient: input.queryClient,
      invalidateTasks: input.invalidateTasks,
      setError: input.setError,
      setActiveDragId: input.setActiveDragId,
      setCurrentDragInsertionTarget: input.setCurrentDragInsertionTarget,
    });

    return;
  }

  await runAssignedTaskDragReorderEnd({
    event: input.event,
    activeId,
    overId,
    draggedTasks,
    sessionToken: input.sessionToken,
    workspaceId: input.workspaceId,
    userId: input.userId,
    dragInsertionTargetRef: input.dragInsertionTargetRef,
    getDragInsertionTarget: input.getDragInsertionTarget,
    anchorsFromInsertionTarget: input.anchorsFromInsertionTarget,
    setActiveDragId: input.setActiveDragId,
    setCurrentDragInsertionTarget: input.setCurrentDragInsertionTarget,
    setReorderPreviewTasks: input.setReorderPreviewTasks,
    sections: input.sections,
    allTasks: input.allTasks,
    view: input.view,
    isSearching: input.isSearching,
    trimmedSearchQuery: input.trimmedSearchQuery,
    lingeringTaskIds: input.lingeringTaskIds,
    sectionById: input.sectionById,
    queryClient: input.queryClient,
    invalidateTasks: input.invalidateTasks,
    setError: input.setError,
  });
}

async function runClearAssignedTasksDoneRange(input: {
  sessionToken: string;
  workspaceId: string;
  userId: string;
  range: ClearDoneTasksRange;
  queryClient: ReturnType<typeof useQueryClient>;
  setError: (message: string | null) => void;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
}) {
  const {
    sessionToken,
    workspaceId,
    userId,
    range,
    queryClient,
    setError,
    setSelectedTaskIds,
    setActiveTaskId,
    setReorderPreviewTasks,
  } = input;
  setError(null);
  try {
    const { completedBefore } = await clearPersonalDoneTasks({ token: sessionToken, workspaceId, range });
    const queryKey = personalAssignedTasksQueryKey(userId);
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.filter(
              (task) =>
                (task.viewerWorkspaceId ?? task.workspaceId) !== workspaceId ||
                task.status !== "completed" ||
                new Date(task.completedAt ?? task.updatedAt).getTime() > new Date(completedBefore).getTime(),
            ),
          }
        : current,
    );
    setSelectedTaskIds(new Set());
    setActiveTaskId(null);
    setReorderPreviewTasks(null);
    await queryClient.invalidateQueries({ queryKey });
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "Completed tasks could not be cleared. Please try again.");
  }
}

async function runClearAssignedTasksSelectedDone(input: {
  sessionToken: string;
  workspaceId: string;
  userId: string;
  selectedDoneTasks: UnifiedAssignedTask[];
  queryClient: ReturnType<typeof useQueryClient>;
  setError: (message: string | null) => void;
  clearTaskFocus: () => void;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
}) {
  const {
    sessionToken,
    workspaceId,
    userId,
    selectedDoneTasks,
    queryClient,
    setError,
    clearTaskFocus,
    setReorderPreviewTasks,
  } = input;
  if (selectedDoneTasks.length === 0) {
    return;
  }
  setError(null);
  const queryKey = personalAssignedTasksQueryKey(userId);
  try {
    const cleared = await clearSelectedDoneTasks({
      token: sessionToken,
      workspaceId,
      tasks: selectedDoneTasks.map((task) => ({ sourceType: task.sourceType, taskId: task.taskId })),
    });
    const keys = new Set(cleared.map((task) => `${task.sourceType}:${task.taskId}`));
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.filter(
              (task) =>
                (task.viewerWorkspaceId ?? task.workspaceId) !== workspaceId ||
                task.status !== "completed" ||
                !keys.has(`${task.sourceType}:${task.taskId}`),
            ),
          }
        : current,
    );
    clearTaskFocus();
    setReorderPreviewTasks(null);
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "Selected tasks could not be cleared.");
  } finally {
    await queryClient.invalidateQueries({ queryKey });
  }
}

async function runReopenAssignedTasksSelectedDone(input: {
  sessionToken: string;
  selected: UnifiedAssignedTask[];
  setError: (message: string | null) => void;
  optimisticallySetTaskStatus: (input: { task: UnifiedAssignedTask; status: TaskStatus }) => void;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  clearTaskFocus: () => void;
  invalidateTasks: () => void;
}) {
  const {
    sessionToken,
    selected,
    setError,
    optimisticallySetTaskStatus,
    setSelectedTaskIds,
    setActiveTaskId,
    clearTaskFocus,
    invalidateTasks,
  } = input;
  if (selected.length === 0) {
    return;
  }
  setError(null);
  try {
    const result = await updateTaskSelection({
      tasks: selected,
      update: (task) =>
        task.sourceType === "workspace"
          ? updateWorkspaceTask({
              token: sessionToken,
              workspaceId: task.workspaceId,
              taskId: task.taskId,
              input: { status: "open" },
            })
          : updateMeetingTask({
              token: sessionToken,
              meetingId: task.sourceId,
              taskId: task.taskId,
              input: { status: "open" },
            }),
    });
    result.updated.forEach((task) => {
      optimisticallySetTaskStatus({ task, status: "open" });
    });
    const firstRemaining = result.remaining[0];
    if (result.remaining.length !== 0 && firstRemaining) {
      setSelectedTaskIds(new Set(result.remaining.map((task) => task.taskId)));
      setActiveTaskId(firstRemaining.taskId);
      setError(
        `Reopened ${result.updated.length} of ${selected.length} tasks. Could not confirm ${result.remaining.length}; they remain selected for retry.`,
      );
    } else {
      clearTaskFocus();
    }
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "Selected tasks could not be reopened.");
  } finally {
    invalidateTasks();
  }
}

function buildParticipantsByMeetingId(
  taskMeetings: AssignedTaskMeetingMetadata[],
): Map<string, TaskAssigneeParticipant[]> {
  const map = new Map<string, TaskAssigneeParticipant[]>();
  taskMeetings.forEach((meeting) => {
    map.set(
      meeting.id,
      (meeting.participants ?? []).map((participant) => ({
        userId: participant.userId,
        displayName: participant.displayName,
        email: null,
        avatarUrl: participant.avatarUrl,
      })),
    );
  });

  return map;
}

function buildWorkspaceAssigneeParticipantsByWorkspaceId(input: {
  taskWorkspaceIds: string[];
  workspaceMemberQueries: ReturnType<typeof useAssignedTasksPageQueries>["workspaceMemberQueries"];
}): Map<string, TaskAssigneeParticipant[]> {
  const { taskWorkspaceIds, workspaceMemberQueries } = input;
  const map = new Map<string, TaskAssigneeParticipant[]>();
  taskWorkspaceIds.forEach((taskWorkspaceId, index) => {
    map.set(
      taskWorkspaceId,
      (workspaceMemberQueries[index]?.data ?? []).map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        email: member.email,
        avatarUrl: member.avatarUrl,
      })),
    );
  });

  return map;
}

function buildAssigneeParticipantsByMeetingId(input: {
  taskMeetings: AssignedTaskMeetingMetadata[];
  participantsByMeetingId: Map<string, TaskAssigneeParticipant[]>;
  workspaceAssigneeParticipantsByWorkspaceId: Map<string, TaskAssigneeParticipant[]>;
}): Map<string, TaskAssigneeParticipant[]> {
  const { taskMeetings, participantsByMeetingId, workspaceAssigneeParticipantsByWorkspaceId } = input;
  const map = new Map<string, TaskAssigneeParticipant[]>();
  taskMeetings.forEach((meeting) => {
    map.set(
      meeting.id,
      mergeTaskAssigneeParticipants(
        participantsByMeetingId.get(meeting.id) ?? [],
        meeting.isConfidential ? [] : (workspaceAssigneeParticipantsByWorkspaceId.get(meeting.workspaceId) ?? []),
      ),
    );
  });

  return map;
}

async function resolveOptimisticCreatedAssignedTask(input: {
  temporaryTaskId: string;
  sessionToken: string;
  userId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  pendingCreateResolutionsRef: RefObject<Record<string, PendingCreateResolution>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  setOptimisticCreateServerTaskIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const {
    temporaryTaskId,
    sessionToken,
    userId,
    queryClient,
    pendingCreateResolutionsRef,
    pendingCreateUpdatesRef,
    optimisticCreateTaskOrderHintsRef,
    createTaskInsertionTargetRef,
    setOptimisticCreateTasksById,
    setOptimisticCreateServerTaskIdsByTemporaryId,
    setActiveTaskId,
    setSelectedTaskIds,
    setSelectionAnchorId,
    setDrafts,
    setEditingTaskId,
    invalidateTasks,
  } = input;
  const resolution = pendingCreateResolutionsRef.current[temporaryTaskId];
  if (!resolution) {
    return;
  }
  delete pendingCreateResolutionsRef.current[temporaryTaskId];
  const pendingUpdate = pendingCreateUpdatesRef.current[temporaryTaskId] ?? resolution.pendingUpdate;
  delete pendingCreateUpdatesRef.current[temporaryTaskId];
  const task = pendingUpdate
    ? {
        ...resolution.task,
        title: pendingUpdate.title,
        description: pendingUpdate.description,
      }
    : resolution.task;
  if (pendingUpdate) {
    await updateWorkspaceTask({
      token: sessionToken,
      workspaceId: task.workspaceId,
      taskId: task.taskId,
      input: pendingUpdate,
    });
  }
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(personalAssignedTasksQueryKey(userId), (current) =>
    addCachedTask({ data: removeCachedTask({ data: current, taskId: temporaryTaskId }), task }),
  );
  setOptimisticCreateTasksById((current) => {
    const next = { ...current };
    delete next[temporaryTaskId];

    return next;
  });
  setOptimisticCreateServerTaskIdsByTemporaryId((current) => {
    const next = { ...current };
    delete next[temporaryTaskId];

    return next;
  });
  const orderHints = optimisticCreateTaskOrderHintsRef.current;
  delete orderHints[temporaryTaskId];
  Object.entries(orderHints).forEach(([hintTaskId, hint]) => {
    if (hint.afterTaskId === temporaryTaskId) {
      orderHints[hintTaskId] = { ...hint, afterTaskId: task.taskId };
    } else if (hint.beforeTaskId === temporaryTaskId) {
      orderHints[hintTaskId] = { ...hint, beforeTaskId: task.taskId };
    }
  });
  if (
    createTaskInsertionTargetRef.current?.type === "task" &&
    createTaskInsertionTargetRef.current.taskId === temporaryTaskId
  ) {
    createTaskInsertionTargetRef.current = { type: "task", taskId: task.taskId };
  }
  setActiveTaskId((current) => (current === temporaryTaskId ? task.taskId : current));
  setSelectedTaskIds((current) => (current.has(temporaryTaskId) ? new Set([task.taskId]) : current));
  setSelectionAnchorId((current) => (current === temporaryTaskId ? task.taskId : current));
  setDrafts((current) => ({
    ...current,
    [task.taskId]: current[temporaryTaskId] ?? {
      title: "",
      description: "",
    },
  }));
  setEditingTaskId((current) => (current === temporaryTaskId ? task.taskId : current));
  invalidateTasks();
}

function finalizeOptimisticCreatedAssignedSectionState(input: {
  temporarySectionId: string;
  section: WorkspaceTaskSection;
  userId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setOptimisticCreateSectionsById: Dispatch<SetStateAction<Record<string, WorkspaceTaskSection>>>;
  setOptimisticCreateServerSectionIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  setSectionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSectionTitleCaretBySectionId: Dispatch<SetStateAction<Record<string, number | null>>>;
  invalidateTasks: () => void;
}) {
  const {
    temporarySectionId,
    section,
    userId,
    queryClient,
    optimisticCreateTaskOrderHintsRef,
    createTaskInsertionTargetRef,
    setOptimisticCreateSectionsById,
    setOptimisticCreateServerSectionIdsByTemporaryId,
    setActiveSectionId,
    setEditingSectionId,
    setSectionDrafts,
    setSectionTitleCaretBySectionId,
    invalidateTasks,
  } = input;
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(personalAssignedTasksQueryKey(userId), (current) =>
    addCachedSection({ data: removeCachedSection({ data: current, sectionId: temporarySectionId }), section }),
  );
  setOptimisticCreateSectionsById((current) => {
    const next = { ...current };
    delete next[temporarySectionId];

    return next;
  });
  setOptimisticCreateServerSectionIdsByTemporaryId((current) => {
    const next = { ...current };
    delete next[temporarySectionId];

    return next;
  });
  Object.entries(optimisticCreateTaskOrderHintsRef.current).forEach(([taskId, hint]) => {
    if (hint.sectionId === temporarySectionId) {
      optimisticCreateTaskOrderHintsRef.current[taskId] = {
        ...hint,
        sectionId: section.id,
      };
    }
  });
  if (
    createTaskInsertionTargetRef.current?.type === "section" &&
    createTaskInsertionTargetRef.current.sectionId === temporarySectionId
  ) {
    createTaskInsertionTargetRef.current = { type: "section", sectionId: section.id };
  }
  setActiveSectionId((current) => (current === temporarySectionId ? section.id : current));
  setEditingSectionId((current) => (current === temporarySectionId ? section.id : current));
  setSectionDrafts((current) => {
    if (!(temporarySectionId in current)) {
      return current;
    }
    const next = { ...current, [section.id]: current[temporarySectionId] ?? "" };
    delete next[temporarySectionId];

    return next;
  });
  setSectionTitleCaretBySectionId((current) => {
    if (!(temporarySectionId in current)) {
      return current;
    }
    const next = { ...current, [section.id]: current[temporarySectionId] ?? null };
    delete next[temporarySectionId];

    return next;
  });
  invalidateTasks();
}

async function resolveOptimisticCreatedAssignedSection(input: {
  temporarySectionId: string;
  sessionToken: string;
  workspaceId: string;
  userId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  pendingCreateSectionResolutionsRef: RefObject<Record<string, PendingCreateSectionResolution>>;
  pendingCreateSectionTitlesRef: RefObject<Record<string, string>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setOptimisticCreateSectionsById: Dispatch<SetStateAction<Record<string, WorkspaceTaskSection>>>;
  setOptimisticCreateServerSectionIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  setSectionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSectionTitleCaretBySectionId: Dispatch<SetStateAction<Record<string, number | null>>>;
  setError: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const {
    temporarySectionId,
    sessionToken,
    workspaceId,
    userId,
    queryClient,
    pendingCreateSectionResolutionsRef,
    pendingCreateSectionTitlesRef,
    optimisticCreateTaskOrderHintsRef,
    createTaskInsertionTargetRef,
    setOptimisticCreateSectionsById,
    setOptimisticCreateServerSectionIdsByTemporaryId,
    setActiveSectionId,
    setEditingSectionId,
    setSectionDrafts,
    setSectionTitleCaretBySectionId,
    setError,
    invalidateTasks,
  } = input;
  const resolution = pendingCreateSectionResolutionsRef.current[temporarySectionId];
  if (!resolution) {
    return;
  }
  delete pendingCreateSectionResolutionsRef.current[temporarySectionId];
  const pendingTitle = pendingCreateSectionTitlesRef.current[temporarySectionId] ?? resolution.pendingTitle;
  delete pendingCreateSectionTitlesRef.current[temporarySectionId];
  const draftedSection = isPresentString(pendingTitle)
    ? {
        ...resolution.section,
        title: pendingTitle,
        updatedAt: new Date().toISOString(),
      }
    : resolution.section;
  const section =
    isPresentString(pendingTitle) && pendingTitle !== resolution.section.title
      ? await (async () => {
          try {
            return await updateWorkspaceTaskSection({
              token: sessionToken,
              workspaceId,
              sectionId: draftedSection.id,
              input: {
                title: pendingTitle,
              },
            });
          } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "Section could not be updated.");

            return draftedSection;
          }
        })()
      : draftedSection;
  finalizeOptimisticCreatedAssignedSectionState({
    temporarySectionId,
    section,
    userId,
    queryClient,
    optimisticCreateTaskOrderHintsRef,
    createTaskInsertionTargetRef,
    setOptimisticCreateSectionsById,
    setOptimisticCreateServerSectionIdsByTemporaryId,
    setActiveSectionId,
    setEditingSectionId,
    setSectionDrafts,
    setSectionTitleCaretBySectionId,
    invalidateTasks,
  });
}

function scheduleAssignedTaskStatusLinger(input: {
  task: UnifiedAssignedTask;
  status: TaskStatus;
  view: AssignedTaskView;
  clearStatusLinger: (taskId: string) => void;
  statusLingerTimersRef: RefObject<Record<string, { fade: number; clear: number }>>;
  setStatusLingerByTaskId: Dispatch<SetStateAction<Record<string, StatusLingerState>>>;
}) {
  const { task, status, view, clearStatusLinger, statusLingerTimersRef, setStatusLingerByTaskId } = input;
  if (filterUnifiedAssignedTasksByView({ tasks: [taskWithStatus({ task, status })], view }).length !== 0) {
    clearStatusLinger(task.taskId);

    return;
  }

  const existingTimers = statusLingerTimersRef.current[task.taskId];
  if (existingTimers) {
    window.clearTimeout(existingTimers.fade);
    window.clearTimeout(existingTimers.clear);
  }

  setStatusLingerByTaskId((current) => ({
    ...current,
    [task.taskId]: {
      view,
      isFading: false,
      sortTime: getAssignedTaskSortTime({ task, view }),
    },
  }));

  const fade = window.setTimeout(() => {
    setStatusLingerByTaskId((current) => {
      const state = current[task.taskId];
      if (!state || state.view !== view) {
        return current;
      }

      return {
        ...current,
        [task.taskId]: {
          ...state,
          isFading: true,
        },
      };
    });
  }, TASK_STATUS_LINGER_MS);
  const clear = window.setTimeout(() => {
    delete statusLingerTimersRef.current[task.taskId];
    setStatusLingerByTaskId((current) => {
      if (!(task.taskId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[task.taskId];

      return next;
    });
  }, TASK_STATUS_LINGER_MS + TASK_STATUS_FADE_MS);
  statusLingerTimersRef.current[task.taskId] = { fade, clear };
}

async function commitAssignedTaskEdit(input: {
  draftOverride?: TaskDraft;
  editingTaskId: string | null;
  sessionToken: string | null;
  userId: string | null;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  drafts: Record<string, TaskDraft>;
  editingTaskIdRef: RefObject<string | null>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  resolveTemporaryTask: (temporaryTaskId: string) => Promise<void>;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    draftOverride,
    editingTaskId,
    sessionToken,
    userId,
    visibleTaskById,
    drafts,
    editingTaskIdRef,
    setEditingTaskId,
    setDrafts,
    pendingCreateUpdatesRef,
    setOptimisticCreateTasksById,
    resolveTemporaryTask,
    queryClient,
    invalidateTasks,
    setError,
  } = input;
  if (!isPresentString(editingTaskId) || !isPresentString(sessionToken) || !isPresentString(userId)) {
    setEditingTaskId(null);

    return;
  }
  const task = visibleTaskById.get(editingTaskId);
  const draft = draftOverride ?? drafts[editingTaskId];
  editingTaskIdRef.current = null;
  setEditingTaskId(null);
  if (task === undefined || !task.editable || draft === undefined) {
    return;
  }
  if (draftOverride) {
    setDrafts((current) => ({
      ...current,
      [editingTaskId]: draftOverride,
    }));
  }
  const trimmedTitle = draft.title.trim();
  const title = trimmedTitle !== "" ? trimmedTitle : task.title;
  const trimmedDescription = draft.description.trim();
  const description = trimmedDescription !== "" ? trimmedDescription : null;
  if (title === task.title && description === task.description) {
    return;
  }
  const queryKey = personalAssignedTasksQueryKey(userId);
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
    updateCachedTaskContent({ data: current, task, title, description }),
  );
  if (task.taskId.startsWith("temporary-task:")) {
    pendingCreateUpdatesRef.current[task.taskId] = { title, description };
    setOptimisticCreateTasksById((current) => {
      const optimisticTask = current[task.taskId];
      if (!optimisticTask) {
        return current;
      }

      return {
        ...current,
        [task.taskId]: {
          ...optimisticTask,
          title,
          description,
        },
      };
    });
    void resolveTemporaryTask(task.taskId);

    return;
  }
  await persistCommittedTaskEdit({
    sessionToken,
    task,
    title,
    description,
    queryClient,
    userId,
    invalidateTasks,
    setError,
  });
}

async function fetchAssignedTaskOwnerAfterReassign(input: {
  task: UnifiedAssignedTask;
  nextOwnerUserId: string | null;
  sessionToken: string;
  userId: string;
  participants: TaskAssigneeParticipant[];
  currentUserParticipant: TaskAssigneeParticipant | null;
}): Promise<TaskAssigneeParticipant | null> {
  const { task, nextOwnerUserId, sessionToken, userId, participants, currentUserParticipant } = input;
  if (task.sourceType === "meeting") {
    const updatedTask = await updateMeetingTask({
      token: sessionToken,
      meetingId: task.sourceId,
      taskId: task.taskId,
      input: {
        assigneeUserId: nextOwnerUserId,
      },
    });
    if (!isPresentString(updatedTask.assignee.userId)) {
      return null;
    }

    return (
      participants.find((participant) => participant.userId === updatedTask.assignee.userId) ??
      (updatedTask.assignee.userId === userId
        ? currentUserParticipant
        : {
            userId: updatedTask.assignee.userId,
            displayName: updatedTask.assignee.name ?? "Assigned",
            email: updatedTask.assignee.email,
            avatarUrl: null,
          })
    );
  }
  const updatedTask = await updateWorkspaceTask({
    token: sessionToken,
    workspaceId: task.workspaceId,
    taskId: task.taskId,
    input: {
      assigneeUserId: nextOwnerUserId,
    },
  });
  if (!isPresentString(updatedTask.assigneeUserId)) {
    return null;
  }

  return (
    participants.find((participant) => participant.userId === updatedTask.assigneeUserId) ??
    (updatedTask.assigneeUserId === userId ? currentUserParticipant : null)
  );
}

async function reassignAssignedTaskOwner(input: {
  task: UnifiedAssignedTask;
  nextOwnerUserId: string | null;
  sessionToken: string;
  userId: string;
  canReassignTask: (task: UnifiedAssignedTask) => boolean;
  workspaceAssigneeParticipantsByWorkspaceId: Map<string, TaskAssigneeParticipant[]>;
  assigneeParticipantsByMeetingId: Map<string, TaskAssigneeParticipant[]>;
  currentUserParticipant: TaskAssigneeParticipant | null;
  queryClient: ReturnType<typeof useQueryClient>;
  setAssigningTaskIds: Dispatch<SetStateAction<Record<string, true>>>;
  setError: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const {
    task,
    nextOwnerUserId,
    sessionToken,
    userId,
    canReassignTask,
    workspaceAssigneeParticipantsByWorkspaceId,
    assigneeParticipantsByMeetingId,
    currentUserParticipant,
    queryClient,
    setAssigningTaskIds,
    setError,
    invalidateTasks,
  } = input;
  if (!canReassignTask(task)) {
    return;
  }
  const workspaceParticipants = workspaceAssigneeParticipantsByWorkspaceId.get(task.workspaceId) ?? [];
  const participants =
    task.sourceType === "meeting" ? (assigneeParticipantsByMeetingId.get(task.sourceId) ?? []) : workspaceParticipants;
  const nextAssignee = isPresentString(nextOwnerUserId)
    ? (participants.find((participant) => participant.userId === nextOwnerUserId) ??
      (nextOwnerUserId === userId ? currentUserParticipant : null))
    : null;
  if (Boolean(nextOwnerUserId) && !nextAssignee) {
    throw new Error(TASK_ASSIGNEE_UNAVAILABLE_ERROR);
  }

  const queryKey = personalAssignedTasksQueryKey(userId);
  const previousTasks = queryClient.getQueryData<WorkspaceAssignedTasksCache>(queryKey);
  setAssigningTaskIds((current) => ({ ...current, [task.taskId]: true }));
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
    updateCachedTaskAssignee({ data: current, task, currentUserId: userId, assignee: nextAssignee }),
  );

  try {
    const updatedAssignee = await fetchAssignedTaskOwnerAfterReassign({
      task,
      nextOwnerUserId,
      sessionToken,
      userId,
      participants,
      currentUserParticipant,
    });
    queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
      updateCachedTaskAssignee({ data: current, task, currentUserId: userId, assignee: updatedAssignee }),
    );
    invalidateTasks();
  } catch (nextError) {
    queryClient.setQueryData(queryKey, previousTasks);
    setError(nextError instanceof Error ? nextError.message : "Task could not be reassigned.");
    invalidateTasks();
    throw nextError;
  } finally {
    setAssigningTaskIds((current) => {
      if (!(task.taskId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[task.taskId];

      return next;
    });
  }
}

function useAssignedTasksPageAllTasks(input: {
  view: AssignedTaskView;
  userId: string | null;
  workspaceId: string | null;
  tasksFromQuery: UnifiedAssignedTask[] | undefined;
  optimisticCreateTasksById: Record<string, UnifiedAssignedTask>;
  optimisticCreateServerTaskIdsByTemporaryId: Record<string, string>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
}) {
  const {
    view,
    userId,
    workspaceId,
    tasksFromQuery,
    optimisticCreateTasksById,
    optimisticCreateServerTaskIdsByTemporaryId,
    optimisticCreateTaskOrderHintsRef,
  } = input;
  const personalSection = useMemo<WorkspaceTaskSection>(
    () => ({
      id: PERSONAL_TASK_SECTION_ID,
      workspaceId: workspaceId ?? PERSONAL_TASK_WORKSPACE_ID,
      title: taskViewCopy(view).title,
      position: 0,
      isDefault: true,
      createdByUserId: userId,
      updatedByUserId: userId,
      createdAt: PERSONAL_TASK_SECTION_TIMESTAMP,
      updatedAt: PERSONAL_TASK_SECTION_TIMESTAMP,
      deletedAt: null,
    }),
    [userId, view, workspaceId],
  );
  const [collapsedPeriodIds, setCollapsedPeriodIds] = useState<Set<string>>(() => new Set());
  const sections = useMemo(() => [personalSection], [personalSection]);
  const suppressedOptimisticCreateTaskIds = useMemo(
    () => new Set(Object.values(optimisticCreateServerTaskIdsByTemporaryId)),
    [optimisticCreateServerTaskIdsByTemporaryId],
  );
  const optimisticCreateTasks = useMemo(() => Object.values(optimisticCreateTasksById), [optimisticCreateTasksById]);
  const allTasks = useMemo(
    () =>
      applyOptimisticTaskOrderHints({
        tasks: filterUnifiedAssignedTasksByWorkspace({
          tasks: [
            ...(tasksFromQuery ?? []).filter(
              (task) =>
                !suppressedOptimisticCreateTaskIds.has(task.taskId) &&
                !isServerPlaceholderForOptimisticCreate({ task, optimisticTasks: optimisticCreateTasks }),
            ),
            ...optimisticCreateTasks,
          ],
          workspaceId,
        }),
        hints: optimisticCreateTaskOrderHintsRef.current,
      }),
    [optimisticCreateTasks, suppressedOptimisticCreateTaskIds, tasksFromQuery, workspaceId],
  );
  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);

  return {
    personalSection,
    collapsedPeriodIds,
    setCollapsedPeriodIds,
    sections,
    allTasks,
    sectionById,
  };
}

function useAssignedTasksPageVisibleLists(input: {
  view: AssignedTaskView;
  allTasks: UnifiedAssignedTask[];
  personalSection: WorkspaceTaskSection;
  sectionById: Map<string, WorkspaceTaskSection>;
  statusLingerByTaskId: Record<string, StatusLingerState>;
  searchQuery: string;
  reorderPreviewTasks: UnifiedAssignedTask[] | null;
  collapsedPeriodIds: Set<string>;
  isTasksQuerySuccess: boolean;
}) {
  const {
    view,
    allTasks,
    personalSection,
    sectionById,
    statusLingerByTaskId,
    searchQuery,
    reorderPreviewTasks,
    collapsedPeriodIds,
    isTasksQuerySuccess,
  } = input;
  const lingeringTaskIds = useMemo(
    () =>
      new Set(
        Object.entries(statusLingerByTaskId)
          .filter(([, state]) => state.view === view)
          .map(([taskId]) => taskId),
      ),
    [statusLingerByTaskId, view],
  );
  const baseVisibleTasks = useMemo(
    () =>
      allTasks.filter(
        (task) =>
          lingeringTaskIds.has(task.taskId) || filterUnifiedAssignedTasksByView({ tasks: [task], view }).length !== 0,
      ),
    [allTasks, lingeringTaskIds, view],
  );
  const defaultSection = personalSection;
  const trimmedSearchQuery = searchQuery.trim();
  const isSearching = trimmedSearchQuery.length > 0;
  const searchedVisibleTasks = useMemo(
    () =>
      isSearching
        ? baseVisibleTasks.filter((task) =>
            taskMatchesSearch({ task, section: sectionById.get(task.sectionId), query: trimmedSearchQuery }),
          )
        : baseVisibleTasks,
    [baseVisibleTasks, isSearching, sectionById, trimmedSearchQuery],
  );
  const visibleTasks = reorderPreviewTasks ?? searchedVisibleTasks;
  const renderSections = useMemo<RenderSection[]>(
    () =>
      buildRenderSectionsForAssignedTasks({
        visibleTasks,
        view,
        statusLingerByTaskId,
        defaultSection,
      }),
    [defaultSection, statusLingerByTaskId, view, visibleTasks],
  );
  const orderedVisibleTasks = useMemo(
    () => renderSections.filter(({ groupId }) => !collapsedPeriodIds.has(groupId)).flatMap((section) => section.tasks),
    [collapsedPeriodIds, renderSections],
  );
  const visibleTaskIds = useMemo(() => orderedVisibleTasks.map((task) => task.taskId), [orderedVisibleTasks]);
  const visibleTaskById = useMemo(
    () => new Map(orderedVisibleTasks.map((task) => [task.taskId, task])),
    [orderedVisibleTasks],
  );
  const pageTitle = isSearching ? `Results for "${trimmedSearchQuery}"` : taskViewCopy(view).title;
  const shouldShowEmptyPlaceholder = isTasksQuerySuccess && visibleTasks.length === 0;

  return {
    trimmedSearchQuery,
    isSearching,
    lingeringTaskIds,
    renderSections,
    orderedVisibleTasks,
    visibleTaskIds,
    visibleTaskById,
    pageTitle,
    shouldShowEmptyPlaceholder,
  };
}

function useAssignedTasksPageAssigneeContext(input: {
  session: ReturnType<typeof useAuth>["session"];
  meetings: Meeting[];
  sourceMeetings: AssignedTaskMeetingMetadata[] | undefined;
  taskWorkspaceIds: string[];
  workspaceMemberQueries: ReturnType<typeof useAssignedTasksPageQueries>["workspaceMemberQueries"];
  userId: string | null;
  view: AssignedTaskView;
}) {
  const { session, meetings, sourceMeetings, taskWorkspaceIds, workspaceMemberQueries, userId, view } = input;
  const currentUserParticipant = useMemo<TaskAssigneeParticipant | null>(() => {
    if (!isPresentString(session?.user.id)) {
      return null;
    }

    return {
      userId: session.user.id,
      displayName: session.user.displayName,
      email: session.user.email,
      avatarUrl: session.user.avatarUrl,
    };
  }, [session?.user.avatarUrl, session?.user.displayName, session?.user.email, session?.user.id]);
  const taskMeetings = useMemo(
    () => mergeAssignedTaskMeetingMetadata({ workspaceMeetings: meetings, sourceMeetings: sourceMeetings ?? [] }),
    [meetings, sourceMeetings],
  );
  const participantsByMeetingId = useMemo(() => buildParticipantsByMeetingId(taskMeetings), [taskMeetings]);
  const workspaceAssigneeParticipantsByWorkspaceId = useMemo(
    () => buildWorkspaceAssigneeParticipantsByWorkspaceId({ taskWorkspaceIds, workspaceMemberQueries }),
    [taskWorkspaceIds, workspaceMemberQueries],
  );
  const assigneeParticipantsByMeetingId = useMemo(
    () =>
      buildAssigneeParticipantsByMeetingId({
        taskMeetings,
        participantsByMeetingId,
        workspaceAssigneeParticipantsByWorkspaceId,
      }),
    [taskMeetings, participantsByMeetingId, workspaceAssigneeParticipantsByWorkspaceId],
  );
  const meetingKindById = useMemo(
    () => new Map(taskMeetings.map((meeting) => [meeting.id, meeting.kind])),
    [taskMeetings],
  );
  const canUpdateTaskStatus = useCallback(
    (task: UnifiedAssignedTask) =>
      canUpdateAssignedTaskStatus({ task, sourceMeetingKind: meetingKindById.get(task.sourceId) }),
    [meetingKindById],
  );
  const legacyAssignableMeetingIds = useMemo(
    () =>
      new Set(
        taskMeetings
          .filter(
            (meeting) =>
              meeting.createdByUserId === userId ||
              meeting.viewerRole === "participant" ||
              meeting.viewerRole === "host" ||
              meeting.viewerRole === "guest",
          )
          .map((meeting) => meeting.id),
      ),
    [taskMeetings, userId],
  );
  const canReassignTask = useCallback(
    (task: UnifiedAssignedTask) =>
      task.reassignable ||
      task.editable ||
      (task.sourceType === "meeting" && legacyAssignableMeetingIds.has(task.sourceId)),
    [legacyAssignableMeetingIds],
  );
  const getTaskViewDropPatch = useCallback(
    (task: UnifiedAssignedTask, targetView: AssignedTaskView) =>
      getAssignedTaskViewDropPatch({
        task,
        sourceView: view,
        targetView,
        permissions: { canUpdateStatus: canUpdateTaskStatus(task), canReassign: canReassignTask(task) },
      }),
    [canReassignTask, canUpdateTaskStatus, view],
  );
  const canDragTask = useCallback(
    (task: UnifiedAssignedTask) =>
      !isTemporaryTaskId(task.taskId) &&
      (["mine", "others", "done"] as AssignedTaskView[]).some(
        (targetView) => getTaskViewDropPatch(task, targetView) !== null,
      ),
    [getTaskViewDropPatch],
  );

  return {
    currentUserParticipant,
    assigneeParticipantsByMeetingId,
    workspaceAssigneeParticipantsByWorkspaceId,
    canUpdateTaskStatus,
    canReassignTask,
    getTaskViewDropPatch,
    canDragTask,
  };
}

function useAssignedTasksPageMeetingsSync(input: {
  userId: string | null;
  workspaceId: string | null;
  meetingsQueryData: Meeting[] | undefined;
  meetingsQueryError: unknown;
  tasksQueryError: unknown;
  setMeetings: Dispatch<SetStateAction<Meeting[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const { userId, workspaceId, meetingsQueryData, meetingsQueryError, tasksQueryError, setMeetings, setError } = input;

  useEffect(() => {
    setMeetings(getCachedWorkspaceMeetings(userId, workspaceId) ?? []);
  }, [userId, workspaceId, setMeetings]);

  useEffect(() => {
    if (meetingsQueryData !== undefined) {
      setMeetings(meetingsQueryData);
      setCachedWorkspaceMeetings(userId, workspaceId, meetingsQueryData);
    }
  }, [meetingsQueryData, userId, workspaceId, setMeetings]);

  useEffect(() => {
    if (meetingsQueryError !== undefined && meetingsQueryError !== null) {
      setError(meetingsQueryError instanceof Error ? meetingsQueryError.message : "Failed to load workspace");
    }
  }, [meetingsQueryError, setError]);

  useEffect(() => {
    if (tasksQueryError !== undefined && tasksQueryError !== null) {
      setError(tasksQueryError instanceof Error ? tasksQueryError.message : "Failed to load tasks");
    }
  }, [tasksQueryError, setError]);
}

function getAssignedTasksForDrag(input: {
  activeId: string;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  selectedTaskIds: Set<string>;
  orderedVisibleTasks: UnifiedAssignedTask[];
  canDragTask: (task: UnifiedAssignedTask) => boolean;
}): UnifiedAssignedTask[] {
  const { activeId, visibleTaskById, selectedTaskIds, orderedVisibleTasks, canDragTask } = input;
  const active = visibleTaskById.get(activeId);
  if (!active) {
    return [];
  }
  if (!selectedTaskIds.has(activeId)) {
    return [active];
  }
  const draggedSelection = orderedVisibleTasks.filter((task) => selectedTaskIds.has(task.taskId) && canDragTask(task));

  return draggedSelection.length !== 0 ? draggedSelection : [active];
}

function anchorsFromAssignedDragInsertionTarget(input: {
  target: DragInsertionTarget;
  movedTaskIds: string[];
  orderedVisibleTasks: UnifiedAssignedTask[];
}): DragAnchorTarget | null {
  const { target, movedTaskIds, orderedVisibleTasks } = input;
  if (!target) {
    return null;
  }
  const movedTaskIdSet = new Set(movedTaskIds);
  const targetRows = orderedVisibleTasks.filter(
    (task) => task.sectionId === target.sectionId && !movedTaskIdSet.has(task.taskId),
  );
  const beforeTaskId = targetRows[target.index]?.taskId;
  const afterTaskId = target.index > 0 ? targetRows[target.index - 1]?.taskId : undefined;

  return {
    targetSectionId: target.sectionId,
    beforeTaskId,
    afterTaskId: isPresentString(beforeTaskId) ? undefined : afterTaskId,
  };
}

function onAssignedTasksPageDragStart(input: {
  event: DragStartEvent;
  containerRef: RefObject<HTMLDivElement | null>;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  dragPointerOverTaskNavRef: RefObject<boolean>;
  setIsDragPointerOverTaskNav: Dispatch<SetStateAction<boolean>>;
  setDragPreviewWidth: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetX: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetY: Dispatch<SetStateAction<number | null>>;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    event,
    containerRef,
    setReorderPreviewTasks,
    setCurrentDragInsertionTarget,
    dragPointerOverTaskNavRef,
    setIsDragPointerOverTaskNav,
    setDragPreviewWidth,
    setDragCursorOffsetX,
    setDragCursorOffsetY,
    setActiveDragId,
  } = input;
  const taskElement = containerRef.current?.querySelector<HTMLElement>(`[data-task-id="${String(event.active.id)}"]`);
  const listElement = taskElement?.closest<HTMLElement>(".workspace-task-list");
  const taskRect = taskElement?.getBoundingClientRect();
  const pointer = dragStartPointerCoords({ activatorEvent: event.activatorEvent });
  const pointerClientX = pointer.x;
  const pointerClientY = pointer.y;
  setReorderPreviewTasks(null);
  setCurrentDragInsertionTarget(null);
  dragPointerOverTaskNavRef.current = false;
  setIsDragPointerOverTaskNav(false);
  setDragPreviewWidth(taskRect?.width ?? listElement?.getBoundingClientRect().width ?? null);
  setDragCursorOffsetX(taskRect && typeof pointerClientX === "number" ? pointerClientX - taskRect.left : null);
  setDragCursorOffsetY(taskRect && typeof pointerClientY === "number" ? pointerClientY - taskRect.top : null);
  setActiveDragId(String(event.active.id));
}

function onAssignedTasksPageDragCancel(input: {
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  dragPointerOverTaskNavRef: RefObject<boolean>;
  setIsDragPointerOverTaskNav: Dispatch<SetStateAction<boolean>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  setDragPreviewWidth: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetX: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetY: Dispatch<SetStateAction<number | null>>;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
}) {
  const {
    setActiveDragId,
    dragPointerOverTaskNavRef,
    setIsDragPointerOverTaskNav,
    setCurrentDragInsertionTarget,
    setDragPreviewWidth,
    setDragCursorOffsetX,
    setDragCursorOffsetY,
    setReorderPreviewTasks,
  } = input;
  setActiveDragId(null);
  dragPointerOverTaskNavRef.current = false;
  setIsDragPointerOverTaskNav(false);
  setCurrentDragInsertionTarget(null);
  setDragPreviewWidth(null);
  setDragCursorOffsetX(null);
  setDragCursorOffsetY(null);
  setReorderPreviewTasks(null);
}

function useAssignedTasksPageDocumentPointerDismiss(input: {
  activeTaskId: string | null;
  activeSectionId: string | null;
  selectedTaskIdsSize: number;
  editingTaskId: string | null;
  editingSectionId: string | null;
  clearTaskFocus: () => void;
}) {
  const { activeTaskId, activeSectionId, selectedTaskIdsSize, editingTaskId, editingSectionId, clearTaskFocus } = input;

  useEffect(() => {
    if (
      (activeTaskId === null || activeTaskId === "") &&
      (activeSectionId === null || activeSectionId === "") &&
      selectedTaskIdsSize === 0 &&
      (editingTaskId === null || editingTaskId === "") &&
      (editingSectionId === null || editingSectionId === "")
    ) {
      return;
    }
    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest(".workspace-task-row, .workspace-task-section-row, .workspace-task-page-actions")) {
        return;
      }
      clearTaskFocus();
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown);

    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, [activeSectionId, activeTaskId, clearTaskFocus, editingSectionId, editingTaskId, selectedTaskIdsSize]);
}

function useAssignedTasksPageClearDoneHandlers(input: {
  sessionToken: string | undefined;
  workspaceId: string | null;
  userId: string | null;
  isClearingDone: boolean;
  setIsClearingDone: Dispatch<SetStateAction<boolean>>;
  selectedDoneTasks: UnifiedAssignedTask[];
  reopenableSelectedDoneTasks: UnifiedAssignedTask[];
  queryClient: ReturnType<typeof useQueryClient>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  clearTaskFocus: () => void;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
  optimisticallySetTaskStatus: (input: { task: UnifiedAssignedTask; status: TaskStatus }) => void;
  invalidateTasks: () => void;
}) {
  const {
    sessionToken,
    workspaceId,
    userId,
    isClearingDone,
    setIsClearingDone,
    selectedDoneTasks,
    reopenableSelectedDoneTasks,
    queryClient,
    setError,
    setSelectedTaskIds,
    setActiveTaskId,
    clearTaskFocus,
    setReorderPreviewTasks,
    optimisticallySetTaskStatus,
    invalidateTasks,
  } = input;

  async function clearDoneTasks(range: ClearDoneTasksRange) {
    if (!isPresentString(sessionToken) || !isPresentString(workspaceId) || !isPresentString(userId) || isClearingDone) {
      return;
    }
    setIsClearingDone(true);
    try {
      await runClearAssignedTasksDoneRange({
        sessionToken,
        workspaceId,
        userId,
        range,
        queryClient,
        setError,
        setSelectedTaskIds,
        setActiveTaskId,
        setReorderPreviewTasks,
      });
    } finally {
      setIsClearingDone(false);
    }
  }

  async function clearSelectedDone() {
    if (!isPresentString(sessionToken) || !isPresentString(workspaceId) || !isPresentString(userId) || isClearingDone) {
      return;
    }
    setIsClearingDone(true);
    try {
      await runClearAssignedTasksSelectedDone({
        sessionToken,
        workspaceId,
        userId,
        selectedDoneTasks,
        queryClient,
        setError,
        clearTaskFocus,
        setReorderPreviewTasks,
      });
    } finally {
      setIsClearingDone(false);
    }
  }

  async function reopenSelectedDone() {
    if (!isPresentString(sessionToken) || isClearingDone) {
      return;
    }
    setIsClearingDone(true);
    try {
      await runReopenAssignedTasksSelectedDone({
        sessionToken,
        selected: reopenableSelectedDoneTasks,
        setError,
        optimisticallySetTaskStatus,
        setSelectedTaskIds,
        setActiveTaskId,
        clearTaskFocus,
        invalidateTasks,
      });
    } finally {
      setIsClearingDone(false);
    }
  }

  return { clearDoneTasks, clearSelectedDone, reopenSelectedDone };
}

async function commitAssignedTasksPageSectionEdit(input: {
  titleOverride?: string;
  editingSectionId: string | null;
  sectionById: Map<string, WorkspaceTaskSection>;
  sectionDrafts: Record<string, string>;
  workspaceId: string | null;
  userId: string | null;
  sessionToken: string | undefined;
  queryClient: ReturnType<typeof useQueryClient>;
  editingSectionIdRef: RefObject<string | null>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  setOptimisticCreateSectionsById: Dispatch<SetStateAction<Record<string, WorkspaceTaskSection>>>;
  pendingCreateSectionTitlesRef: RefObject<Record<string, string>>;
  resolveTemporarySection: (temporarySectionId: string) => Promise<void>;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    titleOverride,
    editingSectionId,
    sectionById,
    sectionDrafts,
    workspaceId,
    userId,
    sessionToken,
    queryClient,
    editingSectionIdRef,
    setEditingSectionId,
    setOptimisticCreateSectionsById,
    pendingCreateSectionTitlesRef,
    resolveTemporarySection,
    invalidateTasks,
    setError,
  } = input;
  if (!isPresentString(editingSectionId)) {
    return;
  }
  const section = sectionById.get(editingSectionId);
  if (section === undefined || section.isDefault) {
    editingSectionIdRef.current = null;
    setEditingSectionId(null);

    return;
  }
  const draftTitle = titleOverride ?? sectionDrafts[editingSectionId] ?? section.title;
  const trimmedDraftTitle = draftTitle.trim();
  const nextTitle = trimmedDraftTitle !== "" ? trimmedDraftTitle : section.title;
  if (section.id.startsWith("temporary-section:")) {
    commitTemporarySectionTitleChange({
      section,
      nextTitle,
      workspaceId,
      userId,
      queryClient,
      setOptimisticCreateSectionsById,
      pendingCreateSectionTitlesRef,
      editingSectionIdRef,
      setEditingSectionId,
      resolveTemporarySection,
    });

    return;
  }
  if (nextTitle === "" || nextTitle === section.title) {
    editingSectionIdRef.current = null;
    setEditingSectionId(null);

    return;
  }
  if (!isPresentString(sessionToken) || !isPresentString(workspaceId) || !isPresentString(userId)) {
    editingSectionIdRef.current = null;
    setEditingSectionId(null);

    return;
  }
  await persistWorkspaceSectionTitle({
    sessionToken,
    workspaceId,
    userId,
    section,
    nextTitle,
    queryClient,
    editingSectionIdRef,
    setEditingSectionId,
    invalidateTasks,
    setError,
  });
}

function useAssignedTasksPageCommitSectionEdit(input: {
  editingSectionId: string | null;
  sectionById: Map<string, WorkspaceTaskSection>;
  sectionDrafts: Record<string, string>;
  workspaceId: string | null;
  userId: string | null;
  sessionToken: string | undefined;
  queryClient: ReturnType<typeof useQueryClient>;
  editingSectionIdRef: RefObject<string | null>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  setOptimisticCreateSectionsById: Dispatch<SetStateAction<Record<string, WorkspaceTaskSection>>>;
  pendingCreateSectionTitlesRef: RefObject<Record<string, string>>;
  resolveTemporarySection: (temporarySectionId: string) => Promise<void>;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  return useCallback(
    (titleOverride?: string) => commitAssignedTasksPageSectionEdit({ ...input, titleOverride }),
    [
      input.editingSectionId,
      input.editingSectionIdRef,
      input.invalidateTasks,
      input.pendingCreateSectionTitlesRef,
      input.queryClient,
      input.resolveTemporarySection,
      input.sectionById,
      input.sectionDrafts,
      input.sessionToken,
      input.setEditingSectionId,
      input.setError,
      input.setOptimisticCreateSectionsById,
      input.userId,
      input.workspaceId,
    ],
  );
}

type AssignedTasksPageDragEndContext = {
  sessionToken: string | undefined;
  workspaceId: string | null;
  userId: string | null;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  canDragTask: (taskInput: { task: UnifiedAssignedTask }) => boolean;
  getDraggedTasks: (dragInput: { activeId: string }) => UnifiedAssignedTask[];
  getTaskViewDropPatch: (patchInput: {
    task: UnifiedAssignedTask;
    targetView: AssignedTaskView;
  }) => AssignedTaskViewDropPatch | null;
  dragInsertionTargetRef: RefObject<DragInsertionTarget>;
  getDragInsertionTarget: (insertionInput: {
    activeId: string;
    overId: string;
    activeCenterY: number | null;
  }) => DragInsertionTarget;
  anchorsFromInsertionTarget: (anchorInput: {
    target: DragInsertionTarget;
    movedTaskIds: string[];
  }) => DragAnchorTarget | null;
  currentUserParticipant: TaskAssigneeParticipant | null;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
  sections: WorkspaceTaskSection[];
  allTasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
  isSearching: boolean;
  trimmedSearchQuery: string;
  lingeringTaskIds: Set<string>;
  sectionById: Map<string, WorkspaceTaskSection>;
  dragPointerOverTaskNavRef: RefObject<boolean>;
  setIsDragPointerOverTaskNav: Dispatch<SetStateAction<boolean>>;
  setDragPreviewWidth: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetX: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetY: Dispatch<SetStateAction<number | null>>;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
};

function updateAssignedTasksPageDragInsertionTarget(input: {
  event: DragMoveEvent | DragOverEvent;
  dragPointerOverTaskNavRef: RefObject<boolean>;
  setIsDragPointerOverTaskNav: Dispatch<SetStateAction<boolean>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  getDragInsertionTarget: (insertionInput: {
    activeId: string;
    overId: string;
    activeCenterY: number | null;
  }) => DragInsertionTarget;
}) {
  const {
    event,
    dragPointerOverTaskNavRef,
    setIsDragPointerOverTaskNav,
    setCurrentDragInsertionTarget,
    getDragInsertionTarget,
  } = input;
  setIsDragPointerOverTaskNav(dragPointerOverTaskNavRef.current);
  const activeId = String(event.active.id);
  const overId = event.over ? String(event.over.id) : null;
  const overTaskView = isPresentString(overId) ? taskViewFromDropTargetId(overId) : null;
  if (overTaskView !== null) {
    setCurrentDragInsertionTarget(null);

    return;
  }
  setCurrentDragInsertionTarget(
    isPresentString(overId)
      ? getDragInsertionTarget({
          activeId,
          overId,
          activeCenterY: activeCenterYFromDragEvent(event),
        })
      : null,
  );
}

async function onAssignedTasksPageDragEnd(input: { event: DragEndEvent; context: AssignedTasksPageDragEndContext }) {
  const { event, context } = input;
  context.setDragPreviewWidth(null);
  context.setDragCursorOffsetX(null);
  context.setDragCursorOffsetY(null);
  context.dragPointerOverTaskNavRef.current = false;
  context.setIsDragPointerOverTaskNav(false);
  if (
    !isPresentString(context.sessionToken) ||
    !isPresentString(context.workspaceId) ||
    !isPresentString(context.userId)
  ) {
    context.setActiveDragId(null);
    context.setCurrentDragInsertionTarget(null);

    return;
  }
  await runAssignedTaskDragEnd({
    event,
    sessionToken: context.sessionToken,
    workspaceId: context.workspaceId,
    userId: context.userId,
    visibleTaskById: context.visibleTaskById,
    canDragTask: context.canDragTask,
    getDraggedTasks: context.getDraggedTasks,
    getTaskViewDropPatch: context.getTaskViewDropPatch,
    dragInsertionTargetRef: context.dragInsertionTargetRef,
    getDragInsertionTarget: context.getDragInsertionTarget,
    anchorsFromInsertionTarget: context.anchorsFromInsertionTarget,
    currentUserParticipant: context.currentUserParticipant,
    queryClient: context.queryClient,
    invalidateTasks: context.invalidateTasks,
    setError: context.setError,
    setActiveDragId: context.setActiveDragId,
    setCurrentDragInsertionTarget: context.setCurrentDragInsertionTarget,
    setReorderPreviewTasks: context.setReorderPreviewTasks,
    sections: context.sections,
    allTasks: context.allTasks,
    view: context.view,
    isSearching: context.isSearching,
    trimmedSearchQuery: context.trimmedSearchQuery,
    lingeringTaskIds: context.lingeringTaskIds,
    sectionById: context.sectionById,
  });
}

function buildAssignedTasksPageDragEndContext(input: {
  sessionToken: string | undefined;
  workspaceId: string | null;
  userId: string | null;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  canDragTask: (taskInput: { task: UnifiedAssignedTask }) => boolean;
  getDraggedTasks: (dragInput: { activeId: string }) => UnifiedAssignedTask[];
  getTaskViewDropPatch: (patchInput: {
    task: UnifiedAssignedTask;
    targetView: AssignedTaskView;
  }) => AssignedTaskViewDropPatch | null;
  dragInsertionTargetRef: RefObject<DragInsertionTarget>;
  getDragInsertionTarget: (insertionInput: {
    activeId: string;
    overId: string;
    activeCenterY: number | null;
  }) => DragInsertionTarget;
  anchorsFromInsertionTarget: (anchorInput: {
    target: DragInsertionTarget;
    movedTaskIds: string[];
  }) => DragAnchorTarget | null;
  currentUserParticipant: TaskAssigneeParticipant | null;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
  sections: WorkspaceTaskSection[];
  allTasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
  isSearching: boolean;
  trimmedSearchQuery: string;
  lingeringTaskIds: Set<string>;
  sectionById: Map<string, WorkspaceTaskSection>;
  dragPointerOverTaskNavRef: RefObject<boolean>;
  setIsDragPointerOverTaskNav: Dispatch<SetStateAction<boolean>>;
  setDragPreviewWidth: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetX: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetY: Dispatch<SetStateAction<number | null>>;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
}): AssignedTasksPageDragEndContext {
  return {
    sessionToken: input.sessionToken,
    workspaceId: input.workspaceId,
    userId: input.userId,
    visibleTaskById: input.visibleTaskById,
    canDragTask: input.canDragTask,
    getDraggedTasks: input.getDraggedTasks,
    getTaskViewDropPatch: input.getTaskViewDropPatch,
    dragInsertionTargetRef: input.dragInsertionTargetRef,
    getDragInsertionTarget: input.getDragInsertionTarget,
    anchorsFromInsertionTarget: input.anchorsFromInsertionTarget,
    currentUserParticipant: input.currentUserParticipant,
    queryClient: input.queryClient,
    invalidateTasks: input.invalidateTasks,
    setError: input.setError,
    sections: input.sections,
    allTasks: input.allTasks,
    view: input.view,
    isSearching: input.isSearching,
    trimmedSearchQuery: input.trimmedSearchQuery,
    lingeringTaskIds: input.lingeringTaskIds,
    sectionById: input.sectionById,
    dragPointerOverTaskNavRef: input.dragPointerOverTaskNavRef,
    setIsDragPointerOverTaskNav: input.setIsDragPointerOverTaskNav,
    setDragPreviewWidth: input.setDragPreviewWidth,
    setDragCursorOffsetX: input.setDragCursorOffsetX,
    setDragCursorOffsetY: input.setDragCursorOffsetY,
    setActiveDragId: input.setActiveDragId,
    setCurrentDragInsertionTarget: input.setCurrentDragInsertionTarget,
    setReorderPreviewTasks: input.setReorderPreviewTasks,
  };
}

function assignedTasksPageCanCreateTask(input: {
  sessionToken: string | undefined;
  workspaceId: string | null;
  view: AssignedTaskView;
}) {
  const { sessionToken, workspaceId, view } = input;

  return isPresentString(sessionToken) && isPresentString(workspaceId) && view !== "done";
}

function disposeAssignedTasksPageEnteringAndLingerTimers(input: {
  statusLingerTimersRef: RefObject<Record<string, { fade: number; clear: number }>>;
  enteringTaskTimersRef: RefObject<Record<string, number>>;
}) {
  const { statusLingerTimersRef, enteringTaskTimersRef } = input;
  Object.values(statusLingerTimersRef.current).forEach((timers) => {
    window.clearTimeout(timers.fade);
    window.clearTimeout(timers.clear);
  });
  statusLingerTimersRef.current = {};
  Object.values(enteringTaskTimersRef.current).forEach((timer) => {
    window.clearTimeout(timer);
  });
  enteringTaskTimersRef.current = {};
}

function useAssignedTasksPagePaintSelection(input: {
  containerRef: RefObject<HTMLDivElement | null>;
  selectedTaskIds: Set<string>;
  activeDragId: string | null;
  editingTaskId: string | null;
  editingSectionId: string | null;
  sectionDeleteConfirmation: SectionDeleteConfirmation | null;
  view: AssignedTaskView;
  visibleTaskIds: string[];
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    containerRef,
    selectedTaskIds,
    activeDragId,
    editingTaskId,
    editingSectionId,
    sectionDeleteConfirmation,
    view,
    visibleTaskIds,
    setSelectedTaskIds,
    setActiveTaskId,
    setActiveSectionId,
    setSelectionAnchorId,
  } = input;

  return useTaskPaintSelection({
    rootRef: containerRef,
    selectedIds: selectedTaskIds,
    /** @external useTaskPaintSelection option */
    disabled: assignedTasksPagePaintSelectionDisabled({
      activeDragId,
      editingTaskId,
      editingSectionId,
      sectionDeleteConfirmation,
    }),
    resetKey: `${view}:${visibleTaskIds.join(",")}`,
    onSelect: (ids) =>
      applyAssignedTasksPagePaintSelection({
        ids,
        setSelectedTaskIds,
        setActiveTaskId,
        setActiveSectionId,
        setSelectionAnchorId,
      }),
  });
}

function useAssignedTasksPageDnDSensors(input: {
  dragPointerOverTaskNavRef: RefObject<boolean>;
  canDropActiveTasksOnView: (targetView: AssignedTaskView) => boolean;
}) {
  const { dragPointerOverTaskNavRef, canDropActiveTasksOnView } = input;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: POINTER_SENSOR_ACTIVATION_DISTANCE },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const taskCollisionDetection = useCallback<CollisionDetection>(
    (args) =>
      assignedTaskCollisionDetection({
        args,
        dragPointerOverTaskNavRef,
        canDropActiveTasksOnView,
      }),
    [canDropActiveTasksOnView, dragPointerOverTaskNavRef],
  );

  return { sensors, taskCollisionDetection };
}

async function resolveAssignedTasksPageTemporaryTask(input: {
  temporaryTaskId: string;
  sessionToken: string | undefined;
  userId: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
  pendingCreateResolutionsRef: RefObject<Record<string, PendingCreateResolution>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  setOptimisticCreateServerTaskIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const { temporaryTaskId, sessionToken, userId } = input;
  if (!isPresentString(userId) || !isPresentString(sessionToken)) {
    return;
  }
  await resolveOptimisticCreatedAssignedTask({
    temporaryTaskId,
    sessionToken,
    userId,
    queryClient: input.queryClient,
    pendingCreateResolutionsRef: input.pendingCreateResolutionsRef,
    pendingCreateUpdatesRef: input.pendingCreateUpdatesRef,
    optimisticCreateTaskOrderHintsRef: input.optimisticCreateTaskOrderHintsRef,
    createTaskInsertionTargetRef: input.createTaskInsertionTargetRef,
    setOptimisticCreateTasksById: input.setOptimisticCreateTasksById,
    setOptimisticCreateServerTaskIdsByTemporaryId: input.setOptimisticCreateServerTaskIdsByTemporaryId,
    setActiveTaskId: input.setActiveTaskId,
    setSelectedTaskIds: input.setSelectedTaskIds,
    setSelectionAnchorId: input.setSelectionAnchorId,
    setDrafts: input.setDrafts,
    setEditingTaskId: input.setEditingTaskId,
    invalidateTasks: input.invalidateTasks,
  });
}

async function resolveAssignedTasksPageTemporarySection(input: {
  temporarySectionId: string;
  sessionToken: string | undefined;
  workspaceId: string | null;
  userId: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
  pendingCreateSectionResolutionsRef: RefObject<Record<string, PendingCreateSectionResolution>>;
  pendingCreateSectionTitlesRef: RefObject<Record<string, string>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setOptimisticCreateSectionsById: Dispatch<SetStateAction<Record<string, WorkspaceTaskSection>>>;
  setOptimisticCreateServerSectionIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  setSectionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSectionTitleCaretBySectionId: Dispatch<SetStateAction<Record<string, number | null>>>;
  setError: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const { temporarySectionId, sessionToken, workspaceId, userId } = input;
  if (!isPresentString(workspaceId) || !isPresentString(userId) || !isPresentString(sessionToken)) {
    return;
  }
  await resolveOptimisticCreatedAssignedSection({
    temporarySectionId,
    sessionToken,
    workspaceId,
    userId,
    queryClient: input.queryClient,
    pendingCreateSectionResolutionsRef: input.pendingCreateSectionResolutionsRef,
    pendingCreateSectionTitlesRef: input.pendingCreateSectionTitlesRef,
    optimisticCreateTaskOrderHintsRef: input.optimisticCreateTaskOrderHintsRef,
    createTaskInsertionTargetRef: input.createTaskInsertionTargetRef,
    setOptimisticCreateSectionsById: input.setOptimisticCreateSectionsById,
    setOptimisticCreateServerSectionIdsByTemporaryId: input.setOptimisticCreateServerSectionIdsByTemporaryId,
    setActiveSectionId: input.setActiveSectionId,
    setEditingSectionId: input.setEditingSectionId,
    setSectionDrafts: input.setSectionDrafts,
    setSectionTitleCaretBySectionId: input.setSectionTitleCaretBySectionId,
    setError: input.setError,
    invalidateTasks: input.invalidateTasks,
  });
}

async function assignAssignedTasksPageTask(input: {
  task: UnifiedAssignedTask;
  nextOwnerUserId: string | null;
  sessionToken: string | undefined;
  userId: string | null;
  canReassignTask: (task: UnifiedAssignedTask) => boolean;
  workspaceAssigneeParticipantsByWorkspaceId: Map<string, TaskAssigneeParticipant[]>;
  assigneeParticipantsByMeetingId: Map<string, TaskAssigneeParticipant[]>;
  currentUserParticipant: TaskAssigneeParticipant | null;
  queryClient: ReturnType<typeof useQueryClient>;
  setAssigningTaskIds: Dispatch<SetStateAction<Record<string, true>>>;
  setError: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const { task, nextOwnerUserId, sessionToken, userId } = input;
  if (!isPresentString(sessionToken) || !isPresentString(userId)) {
    return;
  }
  await reassignAssignedTaskOwner({
    task,
    nextOwnerUserId,
    sessionToken,
    userId,
    canReassignTask: input.canReassignTask,
    workspaceAssigneeParticipantsByWorkspaceId: input.workspaceAssigneeParticipantsByWorkspaceId,
    assigneeParticipantsByMeetingId: input.assigneeParticipantsByMeetingId,
    currentUserParticipant: input.currentUserParticipant,
    queryClient: input.queryClient,
    setAssigningTaskIds: input.setAssigningTaskIds,
    setError: input.setError,
    invalidateTasks: input.invalidateTasks,
  });
}

async function createAssignedTasksPageWorkspaceTask(input: {
  sessionToken: string | undefined;
  workspaceId: string | null;
  userId: string | null;
  view: AssignedTaskView;
  allTasks: UnifiedAssignedTask[];
  queryClient: ReturnType<typeof useQueryClient>;
  markTaskEntering: (taskId: string) => void;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  setTitleCaretByTaskId: Dispatch<SetStateAction<Record<string, number | null>>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
  editingTaskIdRef: RefObject<string | null>;
  setOptimisticCreateServerTaskIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  pendingCreateResolutionsRef: RefObject<Record<string, PendingCreateResolution>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  resolveTemporaryTask: (temporaryTaskId: string) => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const { sessionToken, workspaceId, userId, view } = input;
  if (
    sessionToken === undefined ||
    workspaceId === null ||
    !assignedTasksPageCanCreateTask({ sessionToken, workspaceId, view }) ||
    !isPresentString(userId)
  ) {
    return;
  }
  await runCreateAssignedWorkspaceTask({
    sessionToken,
    workspaceId,
    userId,
    view,
    allTasks: input.allTasks,
    queryClient: input.queryClient,
    markTaskEntering: input.markTaskEntering,
    setOptimisticCreateTasksById: input.setOptimisticCreateTasksById,
    setActiveTaskId: input.setActiveTaskId,
    setSelectedTaskIds: input.setSelectedTaskIds,
    setSelectionAnchorId: input.setSelectionAnchorId,
    setDrafts: input.setDrafts,
    setTitleCaretByTaskId: input.setTitleCaretByTaskId,
    createTaskInsertionTargetRef: input.createTaskInsertionTargetRef,
    setEditingTaskId: input.setEditingTaskId,
    editingTaskIdRef: input.editingTaskIdRef,
    setOptimisticCreateServerTaskIdsByTemporaryId: input.setOptimisticCreateServerTaskIdsByTemporaryId,
    pendingCreateUpdatesRef: input.pendingCreateUpdatesRef,
    pendingCreateResolutionsRef: input.pendingCreateResolutionsRef,
    optimisticCreateTaskOrderHintsRef: input.optimisticCreateTaskOrderHintsRef,
    resolveTemporaryTask: input.resolveTemporaryTask,
    setError: input.setError,
  });
}

function useAssignedTasksPageSelectionDerived(input: {
  orderedVisibleTasks: UnifiedAssignedTask[];
  selectedTaskIds: Set<string>;
  canUpdateTaskStatus: (task: UnifiedAssignedTask) => boolean;
  activeSectionId: string | null;
  sectionById: Map<string, WorkspaceTaskSection>;
  activeTaskId: string | null;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
}) {
  const {
    orderedVisibleTasks,
    selectedTaskIds,
    canUpdateTaskStatus,
    activeSectionId,
    sectionById,
    activeTaskId,
    visibleTaskById,
  } = input;
  const selectedVisibleTasks = useMemo(
    () => orderedVisibleTasks.filter((task) => selectedTaskIds.has(task.taskId)),
    [orderedVisibleTasks, selectedTaskIds],
  );
  const selectedDoneTasks = useMemo(
    () => selectedVisibleTasks.filter((task) => task.status === "completed"),
    [selectedVisibleTasks],
  );
  const reopenableSelectedDoneTasks = useMemo(
    () => filterReopenableAssignedTasks({ tasks: selectedVisibleTasks, canUpdateStatus: canUpdateTaskStatus }),
    [selectedVisibleTasks, canUpdateTaskStatus],
  );
  const activeSection = isPresentString(activeSectionId) ? (sectionById.get(activeSectionId) ?? null) : null;
  const activeSectionTasks = useMemo(
    () =>
      isPresentString(activeSectionId) ? orderedVisibleTasks.filter((task) => task.sectionId === activeSectionId) : [],
    [activeSectionId, orderedVisibleTasks],
  );
  const activeTask = isPresentString(activeTaskId) ? (visibleTaskById.get(activeTaskId) ?? null) : null;
  const canDeleteSelection = selectedVisibleTasks.length !== 0 && selectedVisibleTasks.every((task) => task.deletable);

  return {
    selectedVisibleTasks,
    selectedDoneTasks,
    reopenableSelectedDoneTasks,
    activeSection,
    activeSectionTasks,
    activeTask,
    canDeleteSelection,
  };
}

function useAssignedTasksPageDragListState(input: {
  activeDragId: string | null;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  selectedTaskIds: Set<string>;
  orderedVisibleTasks: UnifiedAssignedTask[];
  canDragTask: (taskInput: { task: UnifiedAssignedTask }) => boolean;
  getTaskViewDropPatch: (patchInput: {
    task: UnifiedAssignedTask;
    targetView: AssignedTaskView;
  }) => AssignedTaskViewDropPatch | null;
  orderedVisibleTasksForAnchors: UnifiedAssignedTask[];
  setDragInsertionTarget: Dispatch<SetStateAction<DragInsertionTarget>>;
  dragInsertionTargetRef: RefObject<DragInsertionTarget>;
}) {
  const {
    activeDragId,
    visibleTaskById,
    selectedTaskIds,
    orderedVisibleTasks,
    canDragTask,
    getTaskViewDropPatch,
    orderedVisibleTasksForAnchors,
    setDragInsertionTarget,
    dragInsertionTargetRef,
  } = input;
  const getDraggedTasks = useCallback(
    (dragInput: { activeId: string }) =>
      getAssignedTasksForDrag({
        activeId: dragInput.activeId,
        visibleTaskById,
        selectedTaskIds,
        orderedVisibleTasks,
        canDragTask: (task) => canDragTask({ task }),
      }),
    [canDragTask, orderedVisibleTasks, selectedTaskIds, visibleTaskById],
  );
  const activeDragTasks = useMemo(
    () => (activeDragId !== null ? getDraggedTasks({ activeId: activeDragId }) : []),
    [activeDragId, getDraggedTasks],
  );
  const activeDragTaskIds = useMemo(() => new Set(activeDragTasks.map((task) => task.taskId)), [activeDragTasks]);
  const canDropActiveTasksOnView = useCallback(
    (targetView: AssignedTaskView) =>
      activeDragTasks.some(
        (task) => !isTemporaryTaskId(task.taskId) && getTaskViewDropPatch({ task, targetView }) !== null,
      ),
    [activeDragTasks, getTaskViewDropPatch],
  );
  const setCurrentDragInsertionTarget = useCallback(
    (target: DragInsertionTarget) => {
      dragInsertionTargetRef.current = target;
      setDragInsertionTarget(target);
    },
    [dragInsertionTargetRef, setDragInsertionTarget],
  );
  const getDragInsertionTarget = useCallback(
    (_insertionInput: { activeId: string; overId: string; activeCenterY: number | null }): DragInsertionTarget => null,
    [],
  );
  const anchorsFromInsertionTarget = useCallback(
    (anchorInput: { target: DragInsertionTarget; movedTaskIds: string[] }) =>
      anchorsFromAssignedDragInsertionTarget({
        target: anchorInput.target,
        movedTaskIds: anchorInput.movedTaskIds,
        orderedVisibleTasks: orderedVisibleTasksForAnchors,
      }),
    [orderedVisibleTasksForAnchors],
  );

  return {
    getDraggedTasks,
    activeDragTasks,
    activeDragTaskIds,
    canDropActiveTasksOnView,
    setCurrentDragInsertionTarget,
    getDragInsertionTarget,
    anchorsFromInsertionTarget,
  };
}

function invalidateAssignedTasksPagePersonalQuery(input: {
  userId: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { userId, queryClient } = input;
  if (!isPresentString(userId)) {
    return;
  }
  void queryClient.invalidateQueries({ queryKey: personalAssignedTasksQueryKey(userId) });
}

function optimisticallySetAssignedTasksPageTaskStatus(input: {
  userId: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
  statusInput: { task: UnifiedAssignedTask; status: TaskStatus };
  scheduleStatusLinger: (lingerInput: { task: UnifiedAssignedTask; status: TaskStatus }) => void;
}) {
  const { userId, queryClient, statusInput, scheduleStatusLinger } = input;
  if (!isPresentString(userId)) {
    return;
  }
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(personalAssignedTasksQueryKey(userId), (current) =>
    updateCachedTaskStatus({ data: current, task: statusInput.task, status: statusInput.status }),
  );
  scheduleStatusLinger(statusInput);
}

async function selectAssignedTasksPageSection(input: {
  section: WorkspaceTaskSection;
  commitEdit: () => Promise<void>;
  commitSectionEdit: () => Promise<void>;
  containerRef: RefObject<HTMLDivElement | null>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    section,
    commitEdit,
    commitSectionEdit,
    containerRef,
    createTaskInsertionTargetRef,
    setActiveSectionId,
    setActiveTaskId,
    setSelectedTaskIds,
    setSelectionAnchorId,
  } = input;
  await commitEdit();
  await commitSectionEdit();
  containerRef.current?.focus({ preventScroll: true });
  createTaskInsertionTargetRef.current = { type: "section", sectionId: section.id };
  setActiveSectionId(section.id);
  setActiveTaskId(null);
  setSelectedTaskIds(new Set());
  setSelectionAnchorId(null);
}

async function confirmAssignedTasksPageSectionDelete(input: {
  sectionDeleteConfirmation: SectionDeleteConfirmation | null;
  deleteSection: (deleteInput: { section: WorkspaceTaskSection; tasks: UnifiedAssignedTask[] }) => Promise<void>;
}) {
  const { sectionDeleteConfirmation, deleteSection } = input;
  if (!sectionDeleteConfirmation) {
    return;
  }
  await deleteSection({
    section: sectionDeleteConfirmation.section,
    tasks: sectionDeleteConfirmation.tasks,
  });
}

function assignedTasksPagePaintSelectionDisabled(input: {
  activeDragId: string | null;
  editingTaskId: string | null;
  editingSectionId: string | null;
  sectionDeleteConfirmation: SectionDeleteConfirmation | null;
}) {
  const { activeDragId, editingTaskId, editingSectionId, sectionDeleteConfirmation } = input;

  return (
    activeDragId !== null || editingTaskId !== null || editingSectionId !== null || sectionDeleteConfirmation !== null
  );
}

function clearAssignedTasksPageStatusLinger(input: {
  taskId: string;
  statusLingerTimersRef: RefObject<Record<string, { fade: number; clear: number }>>;
  setStatusLingerByTaskId: Dispatch<SetStateAction<Record<string, StatusLingerState>>>;
}) {
  const { taskId, statusLingerTimersRef, setStatusLingerByTaskId } = input;
  const timers = statusLingerTimersRef.current[taskId];
  if (timers) {
    window.clearTimeout(timers.fade);
    window.clearTimeout(timers.clear);
    delete statusLingerTimersRef.current[taskId];
  }
  setStatusLingerByTaskId((current) => {
    if (!(taskId in current)) {
      return current;
    }
    const next = { ...current };
    delete next[taskId];

    return next;
  });
}

function markAssignedTasksPageTaskEntering(input: {
  taskId: string;
  enteringTaskTimersRef: RefObject<Record<string, number>>;
  setEnteringTaskIds: Dispatch<SetStateAction<Record<string, true>>>;
}) {
  const { taskId, enteringTaskTimersRef, setEnteringTaskIds } = input;
  const existingTimer = enteringTaskTimersRef.current[taskId];
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
  }
  setEnteringTaskIds((current) => ({
    ...current,
    [taskId]: true,
  }));
  enteringTaskTimersRef.current[taskId] = window.setTimeout(() => {
    delete enteringTaskTimersRef.current[taskId];
    setEnteringTaskIds((current) => {
      if (!(taskId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[taskId];

      return next;
    });
  }, ROW_GROWTH_FALLBACK_MS);
}

function applyAssignedTasksPagePaintSelection(input: {
  ids: Set<string>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
}) {
  const { ids, setSelectedTaskIds, setActiveTaskId, setActiveSectionId, setSelectionAnchorId } = input;
  setSelectedTaskIds((current) =>
    current.size === ids.size && [...ids].every((id) => current.has(id)) ? current : ids,
  );
  setActiveTaskId(null);
  setActiveSectionId(null);
  setSelectionAnchorId(ids.values().next().value ?? null);
}

async function beginAssignedTasksPageEdit(input: {
  task: UnifiedAssignedTask;
  titleCaretOffset?: number;
  commitEdit: () => Promise<void>;
  containerRef: RefObject<HTMLDivElement | null>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  setTitleCaretByTaskId: Dispatch<SetStateAction<Record<string, number | null>>>;
  editingTaskIdRef: RefObject<string | null>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    task,
    titleCaretOffset,
    commitEdit,
    containerRef,
    createTaskInsertionTargetRef,
    setActiveTaskId,
    setActiveSectionId,
    setSelectedTaskIds,
    setSelectionAnchorId,
    setDrafts,
    setTitleCaretByTaskId,
    editingTaskIdRef,
    setEditingTaskId,
  } = input;
  await commitEdit();
  containerRef.current?.focus({ preventScroll: true });
  createTaskInsertionTargetRef.current = { type: "task", taskId: task.taskId };
  setActiveTaskId(task.taskId);
  setActiveSectionId(null);
  setSelectedTaskIds(new Set([task.taskId]));
  setSelectionAnchorId(task.taskId);
  if (!task.editable) {
    return;
  }
  setDrafts((current) => ({
    ...current,
    [task.taskId]: {
      title: task.title,
      description: taskDescription(task),
    },
  }));
  setTitleCaretByTaskId((current) => ({
    ...current,
    [task.taskId]: titleCaretOffset ?? task.title.length,
  }));
  editingTaskIdRef.current = task.taskId;
  setEditingTaskId(task.taskId);
}

async function beginAssignedTasksPageSectionEdit(input: {
  section: WorkspaceTaskSection;
  titleCaretOffset?: number;
  commitEdit: () => Promise<void>;
  commitSectionEdit: () => Promise<void>;
  containerRef: RefObject<HTMLDivElement | null>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setSectionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSectionTitleCaretBySectionId: Dispatch<SetStateAction<Record<string, number | null>>>;
  editingSectionIdRef: RefObject<string | null>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    section,
    titleCaretOffset,
    commitEdit,
    commitSectionEdit,
    containerRef,
    createTaskInsertionTargetRef,
    setActiveSectionId,
    setActiveTaskId,
    setSelectedTaskIds,
    setSelectionAnchorId,
    setSectionDrafts,
    setSectionTitleCaretBySectionId,
    editingSectionIdRef,
    setEditingSectionId,
  } = input;
  await commitEdit();
  await commitSectionEdit();
  containerRef.current?.focus({ preventScroll: true });
  createTaskInsertionTargetRef.current = { type: "section", sectionId: section.id };
  setActiveSectionId(section.id);
  setActiveTaskId(null);
  setSelectedTaskIds(new Set());
  setSelectionAnchorId(null);
  setSectionDrafts((current) => ({
    ...current,
    [section.id]: section.title,
  }));
  setSectionTitleCaretBySectionId((current) => ({
    ...current,
    [section.id]: typeof titleCaretOffset === "number" ? titleCaretOffset : null,
  }));
  editingSectionIdRef.current = section.id;
  setEditingSectionId(section.id);
}

function cancelAssignedTasksPageSectionEdit(input: {
  editingSectionIdRef: RefObject<string | null>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  resolveTemporarySection: (temporarySectionId: string) => Promise<void>;
}) {
  const { editingSectionIdRef, setEditingSectionId, resolveTemporarySection } = input;
  const sectionId = editingSectionIdRef.current;
  editingSectionIdRef.current = null;
  setEditingSectionId(null);
  if (sectionId?.startsWith("temporary-section:") === true) {
    void resolveTemporarySection(sectionId);
  }
}

function requestAssignedTasksPageSectionDelete(input: {
  section: WorkspaceTaskSection;
  tasks: UnifiedAssignedTask[];
  setSectionDeleteConfirmation: Dispatch<SetStateAction<SectionDeleteConfirmation | null>>;
  deleteSection: (deleteInput: { section: WorkspaceTaskSection; tasks: UnifiedAssignedTask[] }) => Promise<void>;
}) {
  const { section, tasks, setSectionDeleteConfirmation, deleteSection } = input;
  if (section.isDefault) {
    return;
  }
  if (tasks.length !== 0) {
    setSectionDeleteConfirmation({ section, tasks });

    return;
  }
  void deleteSection({ section, tasks });
}

function useAssignedTasksPageDragEndContext(input: {
  sessionToken: string | undefined;
  workspaceId: string | null;
  userId: string | null;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  canDragTask: (task: UnifiedAssignedTask) => boolean;
  getDraggedTasks: (dragInput: { activeId: string }) => UnifiedAssignedTask[];
  getTaskViewDropPatch: (patchInput: {
    task: UnifiedAssignedTask;
    targetView: AssignedTaskView;
  }) => AssignedTaskViewDropPatch | null;
  dragInsertionTargetRef: RefObject<DragInsertionTarget>;
  getDragInsertionTarget: (insertionInput: {
    activeId: string;
    overId: string;
    activeCenterY: number | null;
  }) => DragInsertionTarget;
  anchorsFromInsertionTarget: (anchorInput: {
    target: DragInsertionTarget;
    movedTaskIds: string[];
  }) => DragAnchorTarget | null;
  currentUserParticipant: TaskAssigneeParticipant | null;
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
  sections: WorkspaceTaskSection[];
  allTasks: UnifiedAssignedTask[];
  view: AssignedTaskView;
  isSearching: boolean;
  trimmedSearchQuery: string;
  lingeringTaskIds: Set<string>;
  sectionById: Map<string, WorkspaceTaskSection>;
  dragPointerOverTaskNavRef: RefObject<boolean>;
  setIsDragPointerOverTaskNav: Dispatch<SetStateAction<boolean>>;
  setDragPreviewWidth: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetX: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetY: Dispatch<SetStateAction<number | null>>;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
}) {
  return useMemo(
    () =>
      buildAssignedTasksPageDragEndContext({
        sessionToken: input.sessionToken,
        workspaceId: input.workspaceId,
        userId: input.userId,
        visibleTaskById: input.visibleTaskById,
        canDragTask: (dragInput) => input.canDragTask(dragInput.task),
        getDraggedTasks: input.getDraggedTasks,
        getTaskViewDropPatch: (patchInput) => input.getTaskViewDropPatch(patchInput),
        dragInsertionTargetRef: input.dragInsertionTargetRef,
        getDragInsertionTarget: input.getDragInsertionTarget,
        anchorsFromInsertionTarget: input.anchorsFromInsertionTarget,
        currentUserParticipant: input.currentUserParticipant,
        queryClient: input.queryClient,
        invalidateTasks: input.invalidateTasks,
        setError: input.setError,
        sections: input.sections,
        allTasks: input.allTasks,
        view: input.view,
        isSearching: input.isSearching,
        trimmedSearchQuery: input.trimmedSearchQuery,
        lingeringTaskIds: input.lingeringTaskIds,
        sectionById: input.sectionById,
        dragPointerOverTaskNavRef: input.dragPointerOverTaskNavRef,
        setIsDragPointerOverTaskNav: input.setIsDragPointerOverTaskNav,
        setDragPreviewWidth: input.setDragPreviewWidth,
        setDragCursorOffsetX: input.setDragCursorOffsetX,
        setDragCursorOffsetY: input.setDragCursorOffsetY,
        setActiveDragId: input.setActiveDragId,
        setCurrentDragInsertionTarget: input.setCurrentDragInsertionTarget,
        setReorderPreviewTasks: input.setReorderPreviewTasks,
      }),
    [
      input.allTasks,
      input.anchorsFromInsertionTarget,
      input.canDragTask,
      input.currentUserParticipant,
      input.getDraggedTasks,
      input.getDragInsertionTarget,
      input.getTaskViewDropPatch,
      input.invalidateTasks,
      input.isSearching,
      input.lingeringTaskIds,
      input.queryClient,
      input.sectionById,
      input.sections,
      input.sessionToken,
      input.trimmedSearchQuery,
      input.userId,
      input.view,
      input.visibleTaskById,
      input.workspaceId,
    ],
  );
}

function useAssignedTasksPageDragHandlers(input: {
  containerRef: RefObject<HTMLDivElement | null>;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  dragPointerOverTaskNavRef: RefObject<boolean>;
  setIsDragPointerOverTaskNav: Dispatch<SetStateAction<boolean>>;
  setDragPreviewWidth: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetX: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetY: Dispatch<SetStateAction<number | null>>;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  getDragInsertionTarget: (insertionInput: {
    activeId: string;
    overId: string;
    activeCenterY: number | null;
  }) => DragInsertionTarget;
  dragEndContext: AssignedTasksPageDragEndContext;
}) {
  return useMemo(
    () =>
      createAssignedTasksPageDragEventHandlers({
        containerRef: input.containerRef,
        setReorderPreviewTasks: input.setReorderPreviewTasks,
        setCurrentDragInsertionTarget: input.setCurrentDragInsertionTarget,
        dragPointerOverTaskNavRef: input.dragPointerOverTaskNavRef,
        setIsDragPointerOverTaskNav: input.setIsDragPointerOverTaskNav,
        setDragPreviewWidth: input.setDragPreviewWidth,
        setDragCursorOffsetX: input.setDragCursorOffsetX,
        setDragCursorOffsetY: input.setDragCursorOffsetY,
        setActiveDragId: input.setActiveDragId,
        getDragInsertionTarget: input.getDragInsertionTarget,
        dragEndContext: input.dragEndContext,
      }),
    [input.dragEndContext, input.getDragInsertionTarget],
  );
}

async function toggleAssignedTaskPageTaskDone(input: {
  sessionToken: string | undefined;
  task: UnifiedAssignedTask;
  canUpdateTaskStatus: (task: UnifiedAssignedTask) => boolean;
  optimisticallySetTaskStatus: (statusInput: { task: UnifiedAssignedTask; status: TaskStatus }) => void;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const { sessionToken, task, canUpdateTaskStatus, optimisticallySetTaskStatus, invalidateTasks, setError } = input;
  if (!isPresentString(sessionToken) || !canUpdateTaskStatus(task)) {
    return;
  }
  const status = task.status === "completed" ? "open" : "completed";
  optimisticallySetTaskStatus({ task, status });
  try {
    if (task.sourceType === "workspace") {
      await updateWorkspaceTask({
        token: sessionToken,
        workspaceId: task.workspaceId,
        taskId: task.taskId,
        input: { status },
      });
    } else {
      await updateMeetingTask({
        token: sessionToken,
        meetingId: task.sourceId,
        taskId: task.taskId,
        input: { status },
      });
    }
    invalidateTasks();
  } catch (nextError) {
    setError(nextError instanceof Error ? nextError.message : "Task could not be updated.");
    invalidateTasks();
  }
}

function setActiveAssignedTaskByOffset(input: {
  offset: number;
  visibleTaskIds: string[];
  activeTaskId: string | null;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  containerRef: RefObject<HTMLDivElement | null>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    offset,
    visibleTaskIds,
    activeTaskId,
    createTaskInsertionTargetRef,
    containerRef,
    setActiveTaskId,
    setActiveSectionId,
    setSelectedTaskIds,
    setSelectionAnchorId,
  } = input;
  if (visibleTaskIds.length === 0) {
    return;
  }
  const currentIndex = isPresentString(activeTaskId)
    ? Math.max(0, visibleTaskIds.indexOf(activeTaskId))
    : offset > 0
      ? -1
      : visibleTaskIds.length;
  const nextIndex = Math.min(visibleTaskIds.length - 1, Math.max(0, currentIndex + offset));
  const nextTaskId = visibleTaskIds[nextIndex];
  if (!isPresentString(nextTaskId)) {
    return;
  }
  createTaskInsertionTargetRef.current = { type: "task", taskId: nextTaskId };
  setActiveTaskId(nextTaskId);
  setActiveSectionId(null);
  setSelectedTaskIds(new Set([nextTaskId]));
  setSelectionAnchorId(nextTaskId);
  queueMicrotask(() => {
    containerRef.current?.querySelector(`[data-task-id="${nextTaskId}"]`)?.scrollIntoView({
      block: "nearest",
    });
  });
}

async function deleteAssignedTasksPageSection(input: {
  sessionToken: string | undefined;
  workspaceId: string | null;
  userId: string | null;
  section: WorkspaceTaskSection;
  tasks: UnifiedAssignedTask[];
  queryClient: ReturnType<typeof useQueryClient>;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
  setSectionDeleteConfirmation: Dispatch<SetStateAction<SectionDeleteConfirmation | null>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    sessionToken,
    workspaceId,
    userId,
    section,
    tasks,
    queryClient,
    invalidateTasks,
    setError,
    setSectionDeleteConfirmation,
    setActiveSectionId,
    setEditingSectionId,
  } = input;
  if (
    !isPresentString(sessionToken) ||
    !isPresentString(workspaceId) ||
    !isPresentString(userId) ||
    section.isDefault
  ) {
    return;
  }
  const queryKey = personalAssignedTasksQueryKey(userId);
  const previousTasks = queryClient.getQueryData<WorkspaceAssignedTasksCache>(queryKey);
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
    current
      ? {
          sections: (current.sections ?? []).filter((item) => item.id !== section.id),
          tasks: current.tasks.filter((task) => task.sectionId !== section.id),
        }
      : current,
  );
  setSectionDeleteConfirmation(null);
  setActiveSectionId(null);
  setEditingSectionId(null);
  try {
    await deleteWorkspaceTaskSection({ token: sessionToken, workspaceId, sectionId: section.id });
    invalidateTasks();
  } catch (nextError) {
    queryClient.setQueryData(queryKey, previousTasks);
    setError(nextError instanceof Error ? nextError.message : "Section could not be deleted.");
    setSectionDeleteConfirmation({ section, tasks });
  }
}

async function toggleAssignedTasksPageSelectionDone(input: {
  sessionToken: string | undefined;
  isClearingDone: boolean;
  tasks: UnifiedAssignedTask[];
  canUpdateTaskStatus: (task: UnifiedAssignedTask) => boolean;
  setIsClearingDone: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  optimisticallySetTaskStatus: (statusInput: { task: UnifiedAssignedTask; status: TaskStatus }) => void;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const {
    sessionToken,
    isClearingDone,
    tasks,
    canUpdateTaskStatus,
    setIsClearingDone,
    setError,
    optimisticallySetTaskStatus,
    setSelectedTaskIds,
    setActiveTaskId,
    invalidateTasks,
  } = input;
  const statusEditableTasks = tasks.filter(canUpdateTaskStatus);
  if (!isPresentString(sessionToken) || isClearingDone || statusEditableTasks.length === 0) {
    return;
  }
  setIsClearingDone(true);
  setError(null);
  try {
    const result = await updateTaskSelection({
      tasks: statusEditableTasks,
      update: (task) => {
        const status = task.status === "completed" ? "open" : "completed";

        return task.sourceType === "workspace"
          ? updateWorkspaceTask({
              token: sessionToken,
              workspaceId: task.workspaceId,
              taskId: task.taskId,
              input: { status },
            })
          : updateMeetingTask({
              token: sessionToken,
              meetingId: task.sourceId,
              taskId: task.taskId,
              input: { status },
            });
      },
    });
    result.updated.forEach((task) => {
      optimisticallySetTaskStatus({
        task,
        status: task.status === "completed" ? "open" : "completed",
      });
    });
    const firstRemaining = result.remaining[0];
    if (result.remaining.length !== 0 && firstRemaining) {
      setSelectedTaskIds(new Set(result.remaining.map((task) => task.taskId)));
      setActiveTaskId(firstRemaining.taskId);
      setError(
        `Updated ${result.updated.length} of ${statusEditableTasks.length} tasks. Could not confirm ${result.remaining.length}; they remain selected for retry.`,
      );
    }
  } finally {
    invalidateTasks();
    setIsClearingDone(false);
  }
}

async function deleteAssignedTasksPageSelection(input: {
  sessionToken: string | undefined;
  userId: string | null;
  canDeleteSelection: boolean;
  selectedVisibleTasks: UnifiedAssignedTask[];
  queryClient: ReturnType<typeof useQueryClient>;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    sessionToken,
    userId,
    canDeleteSelection,
    selectedVisibleTasks,
    queryClient,
    setOptimisticCreateTasksById,
    optimisticCreateTaskOrderHintsRef,
    setSelectedTaskIds,
    setActiveTaskId,
    invalidateTasks,
    setError,
  } = input;
  if (!isPresentString(sessionToken) || !isPresentString(userId) || !canDeleteSelection) {
    return;
  }
  const taskIds = selectedVisibleTasks.map((task) => task.taskId);
  const queryKey = personalAssignedTasksQueryKey(userId);
  const previousTasks = queryClient.getQueryData<WorkspaceAssignedTasksCache>(queryKey);
  queryClient.setQueryData<WorkspaceAssignedTasksCache>(queryKey, (current) =>
    taskIds.reduce((next, taskId) => removeCachedTask({ data: next, taskId }), current),
  );
  setOptimisticCreateTasksById((current) => {
    const removedIds = taskIds.filter((taskId) => taskId in current);
    if (removedIds.length === 0) {
      return current;
    }
    const next = { ...current };
    removedIds.forEach((taskId) => {
      delete next[taskId];
    });

    return next;
  });
  taskIds.forEach((taskId) => {
    delete optimisticCreateTaskOrderHintsRef.current[taskId];
  });
  setSelectedTaskIds(new Set());
  setActiveTaskId(null);
  try {
    const deletePlan = buildAssignedTaskDeletePlan(await resolveTasksForDelete(selectedVisibleTasks));
    await Promise.all([
      ...deletePlan.workspaceTaskGroups.map(({ workspaceId: taskWorkspaceId, taskIds: workspaceTaskIds }) =>
        deleteWorkspaceTasks({ token: sessionToken, workspaceId: taskWorkspaceId, taskIds: workspaceTaskIds }),
      ),
      ...deletePlan.meetingTasks.map(({ meetingId, taskId }) =>
        updateMeetingTask({ token: sessionToken, meetingId, taskId, input: { status: "dismissed" } }),
      ),
    ]);
    invalidateTasks();
  } catch (nextError) {
    queryClient.setQueryData(queryKey, previousTasks);
    setError(nextError instanceof Error ? nextError.message : "Tasks could not be deleted.");
    invalidateTasks();
  }
}

async function selectAssignedTasksPageTask(input: {
  taskId: string;
  event?: MouseEvent;
  commitEdit: (draftOverride?: TaskDraft) => Promise<void>;
  containerRef: RefObject<HTMLDivElement | null>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  selectionAnchorId: string | null;
  activeTaskId: string | null;
  visibleTaskIds: string[];
}) {
  const {
    taskId,
    event,
    commitEdit,
    containerRef,
    createTaskInsertionTargetRef,
    setActiveTaskId,
    setActiveSectionId,
    setSelectionAnchorId,
    setSelectedTaskIds,
    visibleTaskIds,
  } = input;
  // Clicking a title opens the editor without going through selection, so it leaves no
  // anchor; a following Shift-click then ranges from the active (edited/focused) row.
  const selectionAnchorId = input.selectionAnchorId ?? input.activeTaskId;
  await commitEdit();
  containerRef.current?.focus({ preventScroll: true });
  createTaskInsertionTargetRef.current = { type: "task", taskId };
  setActiveTaskId(taskId);
  setActiveSectionId(null);
  setSelectionAnchorId((currentAnchor) => currentAnchor ?? selectionAnchorId ?? taskId);
  setSelectedTaskIds((current) => {
    if (event?.shiftKey === true && selectionAnchorId !== null && selectionAnchorId !== "") {
      const anchorIndex = visibleTaskIds.indexOf(selectionAnchorId);
      const nextIndex = visibleTaskIds.indexOf(taskId);
      if (anchorIndex >= 0 && nextIndex >= 0) {
        const [start, end] = anchorIndex < nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];

        return new Set(visibleTaskIds.slice(start, end + 1));
      }
    }
    if (event?.metaKey === true || event?.ctrlKey === true) {
      const next = new Set(current);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }

      return next;
    }
    setSelectionAnchorId(taskId);

    return new Set([taskId]);
  });
}

function createAssignedTasksPageDragEventHandlers(input: {
  containerRef: RefObject<HTMLDivElement | null>;
  setReorderPreviewTasks: Dispatch<SetStateAction<UnifiedAssignedTask[] | null>>;
  setCurrentDragInsertionTarget: (target: DragInsertionTarget) => void;
  dragPointerOverTaskNavRef: RefObject<boolean>;
  setIsDragPointerOverTaskNav: Dispatch<SetStateAction<boolean>>;
  setDragPreviewWidth: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetX: Dispatch<SetStateAction<number | null>>;
  setDragCursorOffsetY: Dispatch<SetStateAction<number | null>>;
  setActiveDragId: Dispatch<SetStateAction<string | null>>;
  getDragInsertionTarget: (insertionInput: {
    activeId: string;
    overId: string;
    activeCenterY: number | null;
  }) => DragInsertionTarget;
  dragEndContext: AssignedTasksPageDragEndContext;
}) {
  const handleDragMoveOrOver = (event: DragMoveEvent | DragOverEvent) => {
    updateAssignedTasksPageDragInsertionTarget({
      event,
      dragPointerOverTaskNavRef: input.dragPointerOverTaskNavRef,
      setIsDragPointerOverTaskNav: input.setIsDragPointerOverTaskNav,
      setCurrentDragInsertionTarget: input.setCurrentDragInsertionTarget,
      getDragInsertionTarget: input.getDragInsertionTarget,
    });
  };

  return {
    handleDragStart: (event: DragStartEvent) => {
      onAssignedTasksPageDragStart({
        event,
        containerRef: input.containerRef,
        setReorderPreviewTasks: input.setReorderPreviewTasks,
        setCurrentDragInsertionTarget: input.setCurrentDragInsertionTarget,
        dragPointerOverTaskNavRef: input.dragPointerOverTaskNavRef,
        setIsDragPointerOverTaskNav: input.setIsDragPointerOverTaskNav,
        setDragPreviewWidth: input.setDragPreviewWidth,
        setDragCursorOffsetX: input.setDragCursorOffsetX,
        setDragCursorOffsetY: input.setDragCursorOffsetY,
        setActiveDragId: input.setActiveDragId,
      });
    },
    handleDragMove: handleDragMoveOrOver,
    handleDragOver: handleDragMoveOrOver,
    handleDragEnd: (event: DragEndEvent) => onAssignedTasksPageDragEnd({ event, context: input.dragEndContext }),
    handleDragCancel: () =>
      onAssignedTasksPageDragCancel({
        setActiveDragId: input.setActiveDragId,
        dragPointerOverTaskNavRef: input.dragPointerOverTaskNavRef,
        setIsDragPointerOverTaskNav: input.setIsDragPointerOverTaskNav,
        setCurrentDragInsertionTarget: input.setCurrentDragInsertionTarget,
        setDragPreviewWidth: input.setDragPreviewWidth,
        setDragCursorOffsetX: input.setDragCursorOffsetX,
        setDragCursorOffsetY: input.setDragCursorOffsetY,
        setReorderPreviewTasks: input.setReorderPreviewTasks,
      }),
  };
}

function useAssignedTasksPageTemporaryResolvers(input: {
  sessionToken: string | undefined;
  userId: string | null;
  workspaceId: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
  pendingCreateResolutionsRef: RefObject<Record<string, PendingCreateResolution>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  setOptimisticCreateServerTaskIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
  pendingCreateSectionResolutionsRef: RefObject<Record<string, PendingCreateSectionResolution>>;
  pendingCreateSectionTitlesRef: RefObject<Record<string, string>>;
  setOptimisticCreateSectionsById: Dispatch<SetStateAction<Record<string, WorkspaceTaskSection>>>;
  setOptimisticCreateServerSectionIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setEditingSectionId: Dispatch<SetStateAction<string | null>>;
  setSectionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSectionTitleCaretBySectionId: Dispatch<SetStateAction<Record<string, number | null>>>;
  setError: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const resolveTemporaryTask = useCallback(
    async (temporaryTaskId: string) =>
      resolveAssignedTasksPageTemporaryTask({
        temporaryTaskId,
        sessionToken: input.sessionToken,
        userId: input.userId,
        queryClient: input.queryClient,
        pendingCreateResolutionsRef: input.pendingCreateResolutionsRef,
        pendingCreateUpdatesRef: input.pendingCreateUpdatesRef,
        optimisticCreateTaskOrderHintsRef: input.optimisticCreateTaskOrderHintsRef,
        createTaskInsertionTargetRef: input.createTaskInsertionTargetRef,
        setOptimisticCreateTasksById: input.setOptimisticCreateTasksById,
        setOptimisticCreateServerTaskIdsByTemporaryId: input.setOptimisticCreateServerTaskIdsByTemporaryId,
        setActiveTaskId: input.setActiveTaskId,
        setSelectedTaskIds: input.setSelectedTaskIds,
        setSelectionAnchorId: input.setSelectionAnchorId,
        setDrafts: input.setDrafts,
        setEditingTaskId: input.setEditingTaskId,
        invalidateTasks: input.invalidateTasks,
      }),
    [input.invalidateTasks, input.queryClient, input.sessionToken, input.userId],
  );

  const resolveTemporarySection = useCallback(
    async (temporarySectionId: string) =>
      resolveAssignedTasksPageTemporarySection({
        temporarySectionId,
        sessionToken: input.sessionToken,
        workspaceId: input.workspaceId,
        userId: input.userId,
        queryClient: input.queryClient,
        pendingCreateSectionResolutionsRef: input.pendingCreateSectionResolutionsRef,
        pendingCreateSectionTitlesRef: input.pendingCreateSectionTitlesRef,
        optimisticCreateTaskOrderHintsRef: input.optimisticCreateTaskOrderHintsRef,
        createTaskInsertionTargetRef: input.createTaskInsertionTargetRef,
        setOptimisticCreateSectionsById: input.setOptimisticCreateSectionsById,
        setOptimisticCreateServerSectionIdsByTemporaryId: input.setOptimisticCreateServerSectionIdsByTemporaryId,
        setActiveSectionId: input.setActiveSectionId,
        setEditingSectionId: input.setEditingSectionId,
        setSectionDrafts: input.setSectionDrafts,
        setSectionTitleCaretBySectionId: input.setSectionTitleCaretBySectionId,
        setError: input.setError,
        invalidateTasks: input.invalidateTasks,
      }),
    [input.invalidateTasks, input.queryClient, input.sessionToken, input.userId, input.workspaceId],
  );

  return { resolveTemporaryTask, resolveTemporarySection };
}

function useAssignedTasksPageDoneToggleCallbacks(input: {
  sessionToken: string | undefined;
  isClearingDone: boolean;
  canUpdateTaskStatus: (task: UnifiedAssignedTask) => boolean;
  setIsClearingDone: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  optimisticallySetTaskStatus: (statusInput: { task: UnifiedAssignedTask; status: TaskStatus }) => void;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
}) {
  const toggleTasksDone = useCallback(
    async (tasks: UnifiedAssignedTask[]) => {
      await toggleAssignedTasksPageSelectionDone({
        sessionToken: input.sessionToken,
        isClearingDone: input.isClearingDone,
        tasks,
        canUpdateTaskStatus: input.canUpdateTaskStatus,
        setIsClearingDone: input.setIsClearingDone,
        setError: input.setError,
        optimisticallySetTaskStatus: input.optimisticallySetTaskStatus,
        setSelectedTaskIds: input.setSelectedTaskIds,
        setActiveTaskId: input.setActiveTaskId,
        invalidateTasks: input.invalidateTasks,
      });
    },
    [
      input.canUpdateTaskStatus,
      input.invalidateTasks,
      input.isClearingDone,
      input.optimisticallySetTaskStatus,
      input.sessionToken,
    ],
  );

  const toggleTaskDone = useCallback(
    async (task: UnifiedAssignedTask) => {
      await toggleAssignedTaskPageTaskDone({
        sessionToken: input.sessionToken,
        task,
        canUpdateTaskStatus: input.canUpdateTaskStatus,
        optimisticallySetTaskStatus: input.optimisticallySetTaskStatus,
        invalidateTasks: input.invalidateTasks,
        setError: input.setError,
      });
    },
    [input.canUpdateTaskStatus, input.invalidateTasks, input.optimisticallySetTaskStatus, input.sessionToken],
  );

  return { toggleTasksDone, toggleTaskDone };
}

function useAssignedTasksPageTaskMutations(input: {
  sessionToken: string | undefined;
  userId: string | null;
  canReassignTask: (task: UnifiedAssignedTask) => boolean;
  canDeleteSelection: boolean;
  selectedVisibleTasks: UnifiedAssignedTask[];
  queryClient: ReturnType<typeof useQueryClient>;
  workspaceAssigneeParticipantsByWorkspaceId: Map<string, TaskAssigneeParticipant[]>;
  assigneeParticipantsByMeetingId: Map<string, TaskAssigneeParticipant[]>;
  currentUserParticipant: TaskAssigneeParticipant | null;
  setAssigningTaskIds: Dispatch<SetStateAction<Record<string, true>>>;
  setError: Dispatch<SetStateAction<string | null>>;
  invalidateTasks: () => void;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
}) {
  const assignTask = useCallback(
    async (task: UnifiedAssignedTask, nextOwnerUserId: string | null) =>
      assignAssignedTasksPageTask({
        task,
        nextOwnerUserId,
        sessionToken: input.sessionToken,
        userId: input.userId,
        canReassignTask: input.canReassignTask,
        workspaceAssigneeParticipantsByWorkspaceId: input.workspaceAssigneeParticipantsByWorkspaceId,
        assigneeParticipantsByMeetingId: input.assigneeParticipantsByMeetingId,
        currentUserParticipant: input.currentUserParticipant,
        queryClient: input.queryClient,
        setAssigningTaskIds: input.setAssigningTaskIds,
        setError: input.setError,
        invalidateTasks: input.invalidateTasks,
      }),
    [
      input.assigneeParticipantsByMeetingId,
      input.canReassignTask,
      input.currentUserParticipant,
      input.invalidateTasks,
      input.queryClient,
      input.sessionToken,
      input.userId,
      input.workspaceAssigneeParticipantsByWorkspaceId,
    ],
  );

  const deleteSelectedTasks = useCallback(
    () =>
      deleteAssignedTasksPageSelection({
        sessionToken: input.sessionToken,
        userId: input.userId,
        canDeleteSelection: input.canDeleteSelection,
        selectedVisibleTasks: input.selectedVisibleTasks,
        queryClient: input.queryClient,
        setOptimisticCreateTasksById: input.setOptimisticCreateTasksById,
        optimisticCreateTaskOrderHintsRef: input.optimisticCreateTaskOrderHintsRef,
        setSelectedTaskIds: input.setSelectedTaskIds,
        setActiveTaskId: input.setActiveTaskId,
        invalidateTasks: input.invalidateTasks,
        setError: input.setError,
      }),
    [
      input.canDeleteSelection,
      input.invalidateTasks,
      input.queryClient,
      input.selectedVisibleTasks,
      input.sessionToken,
      input.userId,
    ],
  );

  return { assignTask, deleteSelectedTasks };
}

function useAssignedTasksPageCreateTaskCallback(input: {
  sessionToken: string | undefined;
  workspaceId: string | null;
  userId: string | null;
  view: AssignedTaskView;
  allTasks: UnifiedAssignedTask[];
  queryClient: ReturnType<typeof useQueryClient>;
  markTaskEntering: (taskId: string) => void;
  setOptimisticCreateTasksById: Dispatch<SetStateAction<Record<string, UnifiedAssignedTask>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, TaskDraft>>>;
  setTitleCaretByTaskId: Dispatch<SetStateAction<Record<string, number | null>>>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setEditingTaskId: Dispatch<SetStateAction<string | null>>;
  editingTaskIdRef: RefObject<string | null>;
  setOptimisticCreateServerTaskIdsByTemporaryId: Dispatch<SetStateAction<Record<string, string>>>;
  pendingCreateUpdatesRef: RefObject<Record<string, PendingCreateUpdate>>;
  pendingCreateResolutionsRef: RefObject<Record<string, PendingCreateResolution>>;
  optimisticCreateTaskOrderHintsRef: RefObject<Record<string, OptimisticTaskOrderHint>>;
  resolveTemporaryTask: (temporaryTaskId: string) => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  return useCallback(
    async () =>
      createAssignedTasksPageWorkspaceTask({
        sessionToken: input.sessionToken,
        workspaceId: input.workspaceId,
        userId: input.userId,
        view: input.view,
        allTasks: input.allTasks,
        queryClient: input.queryClient,
        markTaskEntering: input.markTaskEntering,
        setOptimisticCreateTasksById: input.setOptimisticCreateTasksById,
        setActiveTaskId: input.setActiveTaskId,
        setSelectedTaskIds: input.setSelectedTaskIds,
        setSelectionAnchorId: input.setSelectionAnchorId,
        setDrafts: input.setDrafts,
        setTitleCaretByTaskId: input.setTitleCaretByTaskId,
        createTaskInsertionTargetRef: input.createTaskInsertionTargetRef,
        setEditingTaskId: input.setEditingTaskId,
        editingTaskIdRef: input.editingTaskIdRef,
        setOptimisticCreateServerTaskIdsByTemporaryId: input.setOptimisticCreateServerTaskIdsByTemporaryId,
        pendingCreateUpdatesRef: input.pendingCreateUpdatesRef,
        pendingCreateResolutionsRef: input.pendingCreateResolutionsRef,
        optimisticCreateTaskOrderHintsRef: input.optimisticCreateTaskOrderHintsRef,
        resolveTemporaryTask: input.resolveTemporaryTask,
        setError: input.setError,
      }),
    [
      input.allTasks,
      input.markTaskEntering,
      input.queryClient,
      input.resolveTemporaryTask,
      input.sessionToken,
      input.userId,
      input.view,
      input.workspaceId,
    ],
  );
}

function useAssignedTasksPageStatusPresentation(input: {
  view: AssignedTaskView;
  userId: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
  statusLingerTimersRef: RefObject<Record<string, { fade: number; clear: number }>>;
  setStatusLingerByTaskId: Dispatch<SetStateAction<Record<string, StatusLingerState>>>;
  enteringTaskTimersRef: RefObject<Record<string, number>>;
  setEnteringTaskIds: Dispatch<SetStateAction<Record<string, true>>>;
}) {
  const clearStatusLinger = useCallback(
    (taskId: string) =>
      clearAssignedTasksPageStatusLinger({
        taskId,
        statusLingerTimersRef: input.statusLingerTimersRef,
        setStatusLingerByTaskId: input.setStatusLingerByTaskId,
      }),
    [],
  );

  const scheduleStatusLinger = useCallback(
    (lingerInput: { task: UnifiedAssignedTask; status: TaskStatus }) => {
      scheduleAssignedTaskStatusLinger({
        task: lingerInput.task,
        status: lingerInput.status,
        view: input.view,
        clearStatusLinger,
        statusLingerTimersRef: input.statusLingerTimersRef,
        setStatusLingerByTaskId: input.setStatusLingerByTaskId,
      });
    },
    [clearStatusLinger, input.view],
  );

  const optimisticallySetTaskStatus = useCallback(
    (statusInput: { task: UnifiedAssignedTask; status: TaskStatus }) =>
      optimisticallySetAssignedTasksPageTaskStatus({
        userId: input.userId,
        queryClient: input.queryClient,
        statusInput,
        scheduleStatusLinger,
      }),
    [input.queryClient, scheduleStatusLinger, input.userId],
  );

  const markTaskEntering = useCallback(
    (taskId: string) =>
      markAssignedTasksPageTaskEntering({
        taskId,
        enteringTaskTimersRef: input.enteringTaskTimersRef,
        setEnteringTaskIds: input.setEnteringTaskIds,
      }),
    [],
  );

  useEffect(
    () => () =>
      disposeAssignedTasksPageEnteringAndLingerTimers({
        statusLingerTimersRef: input.statusLingerTimersRef,
        enteringTaskTimersRef: input.enteringTaskTimersRef,
      }),
    [],
  );

  return { clearStatusLinger, scheduleStatusLinger, optimisticallySetTaskStatus, markTaskEntering };
}

function useAssignedTasksPageSyncVisibleSelection(input: {
  visibleTaskIds: string[];
  editingTaskId: string | null;
  activeTaskId: string | null;
  activeSectionId: string | null;
  editingSectionId: string | null;
  visibleTaskById: Map<string, UnifiedAssignedTask>;
  sectionById: Map<string, WorkspaceTaskSection>;
  createTaskInsertionTargetRef: RefObject<CreateTaskInsertionTarget>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
}) {
  useEffect(() => {
    syncAssignedTasksSelectionToVisibleTasks({
      visibleTaskIds: input.visibleTaskIds,
      editingTaskId: input.editingTaskId,
      activeTaskId: input.activeTaskId,
      activeSectionId: input.activeSectionId,
      editingSectionId: input.editingSectionId,
      visibleTaskById: input.visibleTaskById,
      sectionById: input.sectionById,
      createTaskInsertionTargetRef: input.createTaskInsertionTargetRef,
      setSelectedTaskIds: input.setSelectedTaskIds,
      setActiveTaskId: input.setActiveTaskId,
      setActiveSectionId: input.setActiveSectionId,
    });
  }, [
    input.activeSectionId,
    input.activeTaskId,
    input.editingSectionId,
    input.editingTaskId,
    input.sectionById,
    input.visibleTaskById,
    input.visibleTaskIds,
  ]);
}

function useAssignedTasksPageMirrorEditingIds(input: {
  editingTaskId: string | null;
  editingSectionId: string | null;
  editingTaskIdRef: RefObject<string | null>;
  editingSectionIdRef: RefObject<string | null>;
}) {
  const { editingTaskId, editingSectionId, editingTaskIdRef, editingSectionIdRef } = input;

  useEffect(() => {
    editingTaskIdRef.current = editingTaskId;
  }, [editingTaskId, editingTaskIdRef]);

  useEffect(() => {
    editingSectionIdRef.current = editingSectionId;
  }, [editingSectionId, editingSectionIdRef]);
}

function useAssignedTasksPageComponentStateSession() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const workspaceId = session?.user.workspaceId ?? null;
  const userId = session?.user.id ?? null;
  const [meetings, setMeetings] = useState<Meeting[]>(
    () =>
      queryClient.getQueryData<Meeting[]>(workspaceMeetingsQueryKey(session?.user)) ??
      getCachedWorkspaceMeetings(userId, workspaceId) ??
      [],
  );
  const [error, setError] = useState<string | null>(null);
  const [isClearingDone, setIsClearingDone] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set());
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [sectionDrafts, setSectionDrafts] = useState<Record<string, string>>({});
  const [sectionDeleteConfirmation, setSectionDeleteConfirmation] = useState<SectionDeleteConfirmation | null>(null);

  return {
    session,
    queryClient,
    workspaceId,
    userId,
    meetings,
    setMeetings,
    error,
    setError,
    isClearingDone,
    setIsClearingDone,
    searchQuery,
    setSearchQuery,
    selectedTaskIds,
    setSelectedTaskIds,
    activeTaskId,
    setActiveTaskId,
    selectionAnchorId,
    setSelectionAnchorId,
    editingTaskId,
    setEditingTaskId,
    activeSectionId,
    setActiveSectionId,
    editingSectionId,
    setEditingSectionId,
    sectionDrafts,
    setSectionDrafts,
    sectionDeleteConfirmation,
    setSectionDeleteConfirmation,
  };
}

function useAssignedTasksPageComponentStateInteraction() {
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({});
  const [titleCaretByTaskId, setTitleCaretByTaskId] = useState<Record<string, number | null>>({});
  const [sectionTitleCaretBySectionId, setSectionTitleCaretBySectionId] = useState<Record<string, number | null>>({});
  const [, setOptimisticCreateSectionsById] = useState<Record<string, WorkspaceTaskSection>>({});
  const [, setOptimisticCreateServerSectionIdsByTemporaryId] = useState<Record<string, string>>({});
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [isDragPointerOverTaskNav, setIsDragPointerOverTaskNav] = useState(false);
  const [dragInsertionTarget, setDragInsertionTarget] = useState<DragInsertionTarget>(null);
  const [dragPreviewWidth, setDragPreviewWidth] = useState<number | null>(null);
  const [dragCursorOffsetX, setDragCursorOffsetX] = useState<number | null>(null);
  const [dragCursorOffsetY, setDragCursorOffsetY] = useState<number | null>(null);
  const [statusLingerByTaskId, setStatusLingerByTaskId] = useState<Record<string, StatusLingerState>>({});
  const [optimisticCreateTasksById, setOptimisticCreateTasksById] = useState<Record<string, UnifiedAssignedTask>>({});
  const [optimisticCreateServerTaskIdsByTemporaryId, setOptimisticCreateServerTaskIdsByTemporaryId] = useState<
    Record<string, string>
  >({});
  const [reorderPreviewTasks, setReorderPreviewTasks] = useState<UnifiedAssignedTask[] | null>(null);
  const [enteringTaskIds, setEnteringTaskIds] = useState<Record<string, true>>({});
  const [assigningTaskIds, setAssigningTaskIds] = useState<Record<string, true>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const dragInsertionTargetRef = useRef<DragInsertionTarget>(null);
  const dragPointerOverTaskNavRef = useRef(false);
  const createTaskInsertionTargetRef = useRef<CreateTaskInsertionTarget>(null);
  const editingTaskIdRef = useRef<string | null>(null);
  const editingSectionIdRef = useRef<string | null>(null);
  const statusLingerTimersRef = useRef<Record<string, { fade: number; clear: number }>>({});
  const pendingCreateUpdatesRef = useRef<Record<string, PendingCreateUpdate>>({});
  const pendingCreateResolutionsRef = useRef<Record<string, PendingCreateResolution>>({});
  const optimisticCreateTaskOrderHintsRef = useRef<Record<string, OptimisticTaskOrderHint>>({});
  const pendingCreateSectionTitlesRef = useRef<Record<string, string>>({});
  const pendingCreateSectionResolutionsRef = useRef<Record<string, PendingCreateSectionResolution>>({});
  const enteringTaskTimersRef = useRef<Record<string, number>>({});

  return {
    drafts,
    setDrafts,
    titleCaretByTaskId,
    setTitleCaretByTaskId,
    sectionTitleCaretBySectionId,
    setSectionTitleCaretBySectionId,
    setOptimisticCreateSectionsById,
    setOptimisticCreateServerSectionIdsByTemporaryId,
    activeDragId,
    setActiveDragId,
    isDragPointerOverTaskNav,
    setIsDragPointerOverTaskNav,
    dragInsertionTarget,
    setDragInsertionTarget,
    dragPreviewWidth,
    setDragPreviewWidth,
    dragCursorOffsetX,
    setDragCursorOffsetX,
    dragCursorOffsetY,
    setDragCursorOffsetY,
    statusLingerByTaskId,
    setStatusLingerByTaskId,
    optimisticCreateTasksById,
    setOptimisticCreateTasksById,
    optimisticCreateServerTaskIdsByTemporaryId,
    setOptimisticCreateServerTaskIdsByTemporaryId,
    reorderPreviewTasks,
    setReorderPreviewTasks,
    enteringTaskIds,
    setEnteringTaskIds,
    assigningTaskIds,
    setAssigningTaskIds,
    containerRef,
    dragInsertionTargetRef,
    dragPointerOverTaskNavRef,
    createTaskInsertionTargetRef,
    editingTaskIdRef,
    editingSectionIdRef,
    statusLingerTimersRef,
    pendingCreateUpdatesRef,
    pendingCreateResolutionsRef,
    optimisticCreateTaskOrderHintsRef,
    pendingCreateSectionTitlesRef,
    pendingCreateSectionResolutionsRef,
    enteringTaskTimersRef,
  };
}

function useAssignedTasksPageComponentState() {
  const sessionState = useAssignedTasksPageComponentStateSession();
  const interactionState = useAssignedTasksPageComponentStateInteraction();

  return { ...sessionState, ...interactionState };
}

type AssignedTasksPageComponentState = ReturnType<typeof useAssignedTasksPageComponentState>;

function useAssignedTasksPageComponentCatalogData(input: {
  view: AssignedTaskView;
  page: AssignedTasksPageComponentState;
}) {
  const { view, page } = input;

  const { tasksQuery, meetingsQuery, taskWorkspaceIds, workspaceMemberQueries } = useAssignedTasksPageQueries({
    session: page.session,
    userId: page.userId,
    workspaceId: page.workspaceId,
  });
  const refreshWorkspaceAssignees = useCallback(
    (taskWorkspaceId: string) => {
      void page.queryClient.invalidateQueries({
        queryKey: ["workspace-members", taskWorkspaceId],
        exact: true,
      });
    },
    [page.queryClient],
  );
  const {
    currentUserParticipant,
    assigneeParticipantsByMeetingId,
    workspaceAssigneeParticipantsByWorkspaceId,
    canUpdateTaskStatus,
    canReassignTask,
    getTaskViewDropPatch,
    canDragTask,
  } = useAssignedTasksPageAssigneeContext({
    session: page.session,
    meetings: page.meetings,
    sourceMeetings: tasksQuery.data?.sourceMeetings,
    taskWorkspaceIds,
    workspaceMemberQueries,
    userId: page.userId,
    view,
  });

  const { collapsedPeriodIds, setCollapsedPeriodIds, sections, allTasks, sectionById, personalSection } =
    useAssignedTasksPageAllTasks({
      view,
      userId: page.userId,
      workspaceId: page.workspaceId,
      tasksFromQuery: tasksQuery.data?.tasks,
      optimisticCreateTasksById: page.optimisticCreateTasksById,
      optimisticCreateServerTaskIdsByTemporaryId: page.optimisticCreateServerTaskIdsByTemporaryId,
      optimisticCreateTaskOrderHintsRef: page.optimisticCreateTaskOrderHintsRef,
    });
  const {
    trimmedSearchQuery,
    isSearching,
    lingeringTaskIds,
    renderSections,
    orderedVisibleTasks,
    visibleTaskIds,
    visibleTaskById,
    pageTitle,
    shouldShowEmptyPlaceholder,
  } = useAssignedTasksPageVisibleLists({
    view,
    allTasks,
    personalSection,
    sectionById,
    statusLingerByTaskId: page.statusLingerByTaskId,
    searchQuery: page.searchQuery,
    reorderPreviewTasks: page.reorderPreviewTasks,
    collapsedPeriodIds,
    isTasksQuerySuccess: tasksQuery.isSuccess,
  });

  return {
    tasksQuery,
    meetingsQuery,
    refreshWorkspaceAssignees,
    currentUserParticipant,
    assigneeParticipantsByMeetingId,
    workspaceAssigneeParticipantsByWorkspaceId,
    canUpdateTaskStatus,
    canReassignTask,
    getTaskViewDropPatch,
    canDragTask,
    collapsedPeriodIds,
    setCollapsedPeriodIds,
    sections,
    allTasks,
    sectionById,
    personalSection,
    trimmedSearchQuery,
    isSearching,
    lingeringTaskIds,
    renderSections,
    orderedVisibleTasks,
    visibleTaskIds,
    visibleTaskById,
    pageTitle,
    shouldShowEmptyPlaceholder,
  };
}

function useAssignedTasksPageComponentCatalogSelection(input: {
  view: AssignedTaskView;
  page: AssignedTasksPageComponentState;
  data: ReturnType<typeof useAssignedTasksPageComponentCatalogData>;
}) {
  const { page, data } = input;

  useAssignedTasksPageMirrorEditingIds({
    editingTaskId: page.editingTaskId,
    editingSectionId: page.editingSectionId,
    editingTaskIdRef: page.editingTaskIdRef,
    editingSectionIdRef: page.editingSectionIdRef,
  });

  const {
    selectedVisibleTasks,
    selectedDoneTasks,
    reopenableSelectedDoneTasks,
    activeSection,
    activeSectionTasks,
    activeTask,
    canDeleteSelection,
  } = useAssignedTasksPageSelectionDerived({
    orderedVisibleTasks: data.orderedVisibleTasks,
    selectedTaskIds: page.selectedTaskIds,
    canUpdateTaskStatus: data.canUpdateTaskStatus,
    activeSectionId: page.activeSectionId,
    sectionById: data.sectionById,
    activeTaskId: page.activeTaskId,
    visibleTaskById: data.visibleTaskById,
  });
  const {
    getDraggedTasks,
    activeDragTasks,
    activeDragTaskIds,
    canDropActiveTasksOnView,
    setCurrentDragInsertionTarget,
    getDragInsertionTarget,
    anchorsFromInsertionTarget,
  } = useAssignedTasksPageDragListState({
    activeDragId: page.activeDragId,
    visibleTaskById: data.visibleTaskById,
    selectedTaskIds: page.selectedTaskIds,
    orderedVisibleTasks: data.orderedVisibleTasks,
    canDragTask: (taskInput) => data.canDragTask(taskInput.task),
    getTaskViewDropPatch: (patchInput) => data.getTaskViewDropPatch(patchInput.task, patchInput.targetView),
    orderedVisibleTasksForAnchors: data.orderedVisibleTasks,
    setDragInsertionTarget: page.setDragInsertionTarget,
    dragInsertionTargetRef: page.dragInsertionTargetRef,
  });

  return {
    selectedVisibleTasks,
    selectedDoneTasks,
    reopenableSelectedDoneTasks,
    activeSection,
    activeSectionTasks,
    activeTask,
    canDeleteSelection,
    getDraggedTasks,
    activeDragTasks,
    activeDragTaskIds,
    canDropActiveTasksOnView,
    setCurrentDragInsertionTarget,
    getDragInsertionTarget,
    anchorsFromInsertionTarget,
  };
}

function useAssignedTasksPageComponentCatalog(input: {
  view: AssignedTaskView;
  page: AssignedTasksPageComponentState;
}) {
  const data = useAssignedTasksPageComponentCatalogData(input);
  const selection = useAssignedTasksPageComponentCatalogSelection({ ...input, data });

  return { ...data, ...selection };
}

function useAssignedTasksPageBootstrap(view: AssignedTaskView) {
  const page = useAssignedTasksPageComponentState();
  const catalog = useAssignedTasksPageComponentCatalog({ view, page });

  return { page, catalog };
}

type AssignedTasksPageBootstrap = ReturnType<typeof useAssignedTasksPageBootstrap>;

function useAssignedTasksPageRuntimeSyncCore(input: { view: AssignedTaskView; bootstrap: AssignedTasksPageBootstrap }) {
  const { view, bootstrap } = input;
  const { page, catalog } = bootstrap;
  const canCreate = assignedTasksPageCanCreateTask({
    sessionToken: page.session?.token,
    workspaceId: page.workspaceId,
    view,
  });
  const { sensors, taskCollisionDetection } = useAssignedTasksPageDnDSensors({
    dragPointerOverTaskNavRef: page.dragPointerOverTaskNavRef,
    canDropActiveTasksOnView: catalog.canDropActiveTasksOnView,
  });

  const invalidateTasks = useCallback(
    () => invalidateAssignedTasksPagePersonalQuery({ userId: page.userId, queryClient: page.queryClient }),
    [page.queryClient, page.userId],
  );

  const { resolveTemporaryTask, resolveTemporarySection } = useAssignedTasksPageTemporaryResolvers({
    sessionToken: page.session?.token,
    userId: page.userId,
    workspaceId: page.workspaceId,
    queryClient: page.queryClient,
    pendingCreateResolutionsRef: page.pendingCreateResolutionsRef,
    pendingCreateUpdatesRef: page.pendingCreateUpdatesRef,
    optimisticCreateTaskOrderHintsRef: page.optimisticCreateTaskOrderHintsRef,
    createTaskInsertionTargetRef: page.createTaskInsertionTargetRef,
    setOptimisticCreateTasksById: page.setOptimisticCreateTasksById,
    setOptimisticCreateServerTaskIdsByTemporaryId: page.setOptimisticCreateServerTaskIdsByTemporaryId,
    setActiveTaskId: page.setActiveTaskId,
    setSelectedTaskIds: page.setSelectedTaskIds,
    setSelectionAnchorId: page.setSelectionAnchorId,
    setDrafts: page.setDrafts,
    setEditingTaskId: page.setEditingTaskId,
    pendingCreateSectionResolutionsRef: page.pendingCreateSectionResolutionsRef,
    pendingCreateSectionTitlesRef: page.pendingCreateSectionTitlesRef,
    setOptimisticCreateSectionsById: page.setOptimisticCreateSectionsById,
    setOptimisticCreateServerSectionIdsByTemporaryId: page.setOptimisticCreateServerSectionIdsByTemporaryId,
    setActiveSectionId: page.setActiveSectionId,
    setEditingSectionId: page.setEditingSectionId,
    setSectionDrafts: page.setSectionDrafts,
    setSectionTitleCaretBySectionId: page.setSectionTitleCaretBySectionId,
    setError: page.setError,
    invalidateTasks,
  });

  const { optimisticallySetTaskStatus, markTaskEntering } = useAssignedTasksPageStatusPresentation({
    view,
    userId: page.userId,
    queryClient: page.queryClient,
    statusLingerTimersRef: page.statusLingerTimersRef,
    setStatusLingerByTaskId: page.setStatusLingerByTaskId,
    enteringTaskTimersRef: page.enteringTaskTimersRef,
    setEnteringTaskIds: page.setEnteringTaskIds,
  });

  return {
    canCreate,
    sensors,
    taskCollisionDetection,
    invalidateTasks,
    resolveTemporaryTask,
    resolveTemporarySection,
    optimisticallySetTaskStatus,
    markTaskEntering,
  };
}

function useAssignedTasksPageRuntimeSyncEffects(input: {
  view: AssignedTaskView;
  bootstrap: AssignedTasksPageBootstrap;
  core: ReturnType<typeof useAssignedTasksPageRuntimeSyncCore>;
}) {
  const { view, bootstrap, core } = input;
  const { page, catalog } = bootstrap;

  useAssignedTasksPageMeetingsSync({
    userId: page.userId,
    workspaceId: page.workspaceId,
    meetingsQueryData: catalog.meetingsQuery.data,
    meetingsQueryError: catalog.meetingsQuery.error,
    tasksQueryError: catalog.tasksQuery.error,
    setMeetings: page.setMeetings,
    setError: page.setError,
  });

  useAssignedTasksPageSyncVisibleSelection({
    visibleTaskIds: catalog.visibleTaskIds,
    editingTaskId: page.editingTaskId,
    activeTaskId: page.activeTaskId,
    activeSectionId: page.activeSectionId,
    editingSectionId: page.editingSectionId,
    visibleTaskById: catalog.visibleTaskById,
    sectionById: catalog.sectionById,
    createTaskInsertionTargetRef: page.createTaskInsertionTargetRef,
    setSelectedTaskIds: page.setSelectedTaskIds,
    setActiveTaskId: page.setActiveTaskId,
    setActiveSectionId: page.setActiveSectionId,
  });

  const clearTaskFocus = useCallback(() => {
    page.createTaskInsertionTargetRef.current = null;
    page.setActiveTaskId(null);
    page.setActiveSectionId(null);
    page.setSelectedTaskIds(new Set());
    page.setSelectionAnchorId(null);
  }, [
    page.createTaskInsertionTargetRef,
    page.setActiveSectionId,
    page.setActiveTaskId,
    page.setSelectedTaskIds,
    page.setSelectionAnchorId,
  ]);

  const { clearDoneTasks, clearSelectedDone, reopenSelectedDone } = useAssignedTasksPageClearDoneHandlers({
    sessionToken: page.session?.token,
    workspaceId: page.workspaceId,
    userId: page.userId,
    isClearingDone: page.isClearingDone,
    setIsClearingDone: page.setIsClearingDone,
    selectedDoneTasks: catalog.selectedDoneTasks,
    reopenableSelectedDoneTasks: catalog.reopenableSelectedDoneTasks,
    queryClient: page.queryClient,
    setError: page.setError,
    setSelectedTaskIds: page.setSelectedTaskIds,
    setActiveTaskId: page.setActiveTaskId,
    clearTaskFocus,
    setReorderPreviewTasks: page.setReorderPreviewTasks,
    optimisticallySetTaskStatus: core.optimisticallySetTaskStatus,
    invalidateTasks: core.invalidateTasks,
  });

  const paintSelection = useAssignedTasksPagePaintSelection({
    containerRef: page.containerRef,
    selectedTaskIds: page.selectedTaskIds,
    activeDragId: page.activeDragId,
    editingTaskId: page.editingTaskId,
    editingSectionId: page.editingSectionId,
    sectionDeleteConfirmation: page.sectionDeleteConfirmation,
    view,
    visibleTaskIds: catalog.visibleTaskIds,
    setSelectedTaskIds: page.setSelectedTaskIds,
    setActiveTaskId: page.setActiveTaskId,
    setActiveSectionId: page.setActiveSectionId,
    setSelectionAnchorId: page.setSelectionAnchorId,
  });

  return {
    clearTaskFocus,
    clearDoneTasks,
    clearSelectedDone,
    reopenSelectedDone,
    paintSelection,
  };
}

function useAssignedTasksPageRuntimeSync(input: { view: AssignedTaskView; bootstrap: AssignedTasksPageBootstrap }) {
  const core = useAssignedTasksPageRuntimeSyncCore(input);
  const effects = useAssignedTasksPageRuntimeSyncEffects({ ...input, core });

  return { ...core, ...effects };
}

function useAssignedTasksPageRuntimeTaskCommit(input: {
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
}) {
  const { bootstrap, sync } = input;
  const { page, catalog } = bootstrap;

  const commitEdit = useCallback(
    async (draftOverride?: TaskDraft) => {
      await commitAssignedTaskEdit({
        draftOverride,
        editingTaskId: page.editingTaskId,
        sessionToken: page.session?.token ?? null,
        userId: page.userId,
        visibleTaskById: catalog.visibleTaskById,
        drafts: page.drafts,
        editingTaskIdRef: page.editingTaskIdRef,
        setEditingTaskId: page.setEditingTaskId,
        setDrafts: page.setDrafts,
        pendingCreateUpdatesRef: page.pendingCreateUpdatesRef,
        setOptimisticCreateTasksById: page.setOptimisticCreateTasksById,
        resolveTemporaryTask: sync.resolveTemporaryTask,
        queryClient: page.queryClient,
        invalidateTasks: sync.invalidateTasks,
        setError: page.setError,
      });
    },
    [
      catalog.visibleTaskById,
      page.drafts,
      page.editingTaskId,
      page.editingTaskIdRef,
      page.queryClient,
      page.session?.token,
      page.setDrafts,
      page.setEditingTaskId,
      page.setError,
      page.setOptimisticCreateTasksById,
      page.userId,
      sync.invalidateTasks,
      sync.resolveTemporaryTask,
    ],
  );

  const cancelEdit = useCallback(() => {
    page.editingTaskIdRef.current = null;
    page.setEditingTaskId(null);
  }, [page.editingTaskIdRef, page.setEditingTaskId]);

  useAssignedTasksPageDocumentPointerDismiss({
    activeTaskId: page.activeTaskId,
    activeSectionId: page.activeSectionId,
    selectedTaskIdsSize: page.selectedTaskIds.size,
    editingTaskId: page.editingTaskId,
    editingSectionId: page.editingSectionId,
    clearTaskFocus: sync.clearTaskFocus,
  });

  return { commitEdit, cancelEdit };
}

function useAssignedTasksPageRuntimeTaskSelect(input: {
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
  commit: ReturnType<typeof useAssignedTasksPageRuntimeTaskCommit>;
}) {
  const { bootstrap, commit } = input;
  const { page, catalog } = bootstrap;
  const { commitEdit } = commit;

  const beginEdit = useCallback(
    async (task: UnifiedAssignedTask, titleCaretOffset?: number) => {
      await beginAssignedTasksPageEdit({
        task,
        titleCaretOffset,
        commitEdit,
        containerRef: page.containerRef,
        createTaskInsertionTargetRef: page.createTaskInsertionTargetRef,
        setActiveTaskId: page.setActiveTaskId,
        setActiveSectionId: page.setActiveSectionId,
        setSelectedTaskIds: page.setSelectedTaskIds,
        setSelectionAnchorId: page.setSelectionAnchorId,
        setDrafts: page.setDrafts,
        setTitleCaretByTaskId: page.setTitleCaretByTaskId,
        editingTaskIdRef: page.editingTaskIdRef,
        setEditingTaskId: page.setEditingTaskId,
      });
    },
    [commitEdit, page],
  );

  const selectTask = useCallback(
    (taskId: string, event?: MouseEvent) =>
      selectAssignedTasksPageTask({
        taskId,
        event,
        commitEdit,
        containerRef: page.containerRef,
        createTaskInsertionTargetRef: page.createTaskInsertionTargetRef,
        setActiveTaskId: page.setActiveTaskId,
        setActiveSectionId: page.setActiveSectionId,
        setSelectionAnchorId: page.setSelectionAnchorId,
        setSelectedTaskIds: page.setSelectedTaskIds,
        selectionAnchorId: page.selectionAnchorId,
        activeTaskId: page.activeTaskId,
        visibleTaskIds: catalog.visibleTaskIds,
      }),
    [catalog.visibleTaskIds, commitEdit, page],
  );

  const setActiveByOffset = useCallback(
    (offset: number) =>
      setActiveAssignedTaskByOffset({
        offset,
        visibleTaskIds: catalog.visibleTaskIds,
        activeTaskId: page.activeTaskId,
        createTaskInsertionTargetRef: page.createTaskInsertionTargetRef,
        containerRef: page.containerRef,
        setActiveTaskId: page.setActiveTaskId,
        setActiveSectionId: page.setActiveSectionId,
        setSelectedTaskIds: page.setSelectedTaskIds,
        setSelectionAnchorId: page.setSelectionAnchorId,
      }),
    [catalog.visibleTaskIds, page],
  );

  return {
    beginEdit,
    selectTask,
    setActiveByOffset,
  };
}

function useAssignedTasksPageRuntimeTaskEditCallbacks(input: {
  view: AssignedTaskView;
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
}) {
  const commit = useAssignedTasksPageRuntimeTaskCommit(input);
  const select = useAssignedTasksPageRuntimeTaskSelect({ bootstrap: input.bootstrap, sync: input.sync, commit });

  return { ...commit, ...select };
}

function useAssignedTasksPageRuntimeTaskActions(input: {
  view: AssignedTaskView;
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
}) {
  const { bootstrap, sync } = input;
  const { page, catalog } = bootstrap;

  const { toggleTasksDone, toggleTaskDone } = useAssignedTasksPageDoneToggleCallbacks({
    sessionToken: page.session?.token,
    isClearingDone: page.isClearingDone,
    canUpdateTaskStatus: catalog.canUpdateTaskStatus,
    setIsClearingDone: page.setIsClearingDone,
    setError: page.setError,
    optimisticallySetTaskStatus: sync.optimisticallySetTaskStatus,
    setSelectedTaskIds: page.setSelectedTaskIds,
    setActiveTaskId: page.setActiveTaskId,
    invalidateTasks: sync.invalidateTasks,
  });

  const { assignTask, deleteSelectedTasks } = useAssignedTasksPageTaskMutations({
    sessionToken: page.session?.token,
    userId: page.userId,
    canReassignTask: catalog.canReassignTask,
    canDeleteSelection: catalog.canDeleteSelection,
    selectedVisibleTasks: catalog.selectedVisibleTasks,
    queryClient: page.queryClient,
    workspaceAssigneeParticipantsByWorkspaceId: catalog.workspaceAssigneeParticipantsByWorkspaceId,
    assigneeParticipantsByMeetingId: catalog.assigneeParticipantsByMeetingId,
    currentUserParticipant: catalog.currentUserParticipant,
    setAssigningTaskIds: page.setAssigningTaskIds,
    setError: page.setError,
    invalidateTasks: sync.invalidateTasks,
    setOptimisticCreateTasksById: page.setOptimisticCreateTasksById,
    optimisticCreateTaskOrderHintsRef: page.optimisticCreateTaskOrderHintsRef,
    setSelectedTaskIds: page.setSelectedTaskIds,
    setActiveTaskId: page.setActiveTaskId,
  });

  const createTask = useAssignedTasksPageCreateTaskCallback({
    sessionToken: page.session?.token,
    workspaceId: page.workspaceId,
    userId: page.userId,
    view: input.view,
    allTasks: catalog.allTasks,
    queryClient: page.queryClient,
    markTaskEntering: sync.markTaskEntering,
    setOptimisticCreateTasksById: page.setOptimisticCreateTasksById,
    setActiveTaskId: page.setActiveTaskId,
    setSelectedTaskIds: page.setSelectedTaskIds,
    setSelectionAnchorId: page.setSelectionAnchorId,
    setDrafts: page.setDrafts,
    setTitleCaretByTaskId: page.setTitleCaretByTaskId,
    createTaskInsertionTargetRef: page.createTaskInsertionTargetRef,
    setEditingTaskId: page.setEditingTaskId,
    editingTaskIdRef: page.editingTaskIdRef,
    setOptimisticCreateServerTaskIdsByTemporaryId: page.setOptimisticCreateServerTaskIdsByTemporaryId,
    pendingCreateUpdatesRef: page.pendingCreateUpdatesRef,
    pendingCreateResolutionsRef: page.pendingCreateResolutionsRef,
    optimisticCreateTaskOrderHintsRef: page.optimisticCreateTaskOrderHintsRef,
    resolveTemporaryTask: sync.resolveTemporaryTask,
    setError: page.setError,
  });

  return {
    toggleTasksDone,
    toggleTaskDone,
    assignTask,
    deleteSelectedTasks,
    createTask,
  };
}

function useAssignedTasksPageRuntimeTaskEditing(input: {
  view: AssignedTaskView;
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
}) {
  const editing = useAssignedTasksPageRuntimeTaskEditCallbacks(input);
  const actions = useAssignedTasksPageRuntimeTaskActions(input);

  return { ...editing, ...actions };
}

function useAssignedTasksPageRuntimeSectionEdits(input: {
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
  taskEditing: ReturnType<typeof useAssignedTasksPageRuntimeTaskEditing>;
}) {
  const { bootstrap, sync, taskEditing } = input;
  const { page, catalog } = bootstrap;

  const commitSectionEdit = useAssignedTasksPageCommitSectionEdit({
    editingSectionId: page.editingSectionId,
    sectionById: catalog.sectionById,
    sectionDrafts: page.sectionDrafts,
    workspaceId: page.workspaceId,
    userId: page.userId,
    sessionToken: page.session?.token,
    queryClient: page.queryClient,
    editingSectionIdRef: page.editingSectionIdRef,
    setEditingSectionId: page.setEditingSectionId,
    setOptimisticCreateSectionsById: page.setOptimisticCreateSectionsById,
    pendingCreateSectionTitlesRef: page.pendingCreateSectionTitlesRef,
    resolveTemporarySection: sync.resolveTemporarySection,
    invalidateTasks: sync.invalidateTasks,
    setError: page.setError,
  });

  const selectSection = useCallback(
    async (section: WorkspaceTaskSection) => {
      await selectAssignedTasksPageSection({
        section,
        commitEdit: taskEditing.commitEdit,
        commitSectionEdit,
        containerRef: page.containerRef,
        createTaskInsertionTargetRef: page.createTaskInsertionTargetRef,
        setActiveSectionId: page.setActiveSectionId,
        setActiveTaskId: page.setActiveTaskId,
        setSelectedTaskIds: page.setSelectedTaskIds,
        setSelectionAnchorId: page.setSelectionAnchorId,
      });
    },
    [commitSectionEdit, page, taskEditing.commitEdit],
  );

  const beginSectionEdit = useCallback(
    async (section: WorkspaceTaskSection, titleCaretOffset?: number) => {
      await beginAssignedTasksPageSectionEdit({
        section,
        titleCaretOffset,
        commitEdit: taskEditing.commitEdit,
        commitSectionEdit,
        containerRef: page.containerRef,
        createTaskInsertionTargetRef: page.createTaskInsertionTargetRef,
        setActiveSectionId: page.setActiveSectionId,
        setActiveTaskId: page.setActiveTaskId,
        setSelectedTaskIds: page.setSelectedTaskIds,
        setSelectionAnchorId: page.setSelectionAnchorId,
        setSectionDrafts: page.setSectionDrafts,
        setSectionTitleCaretBySectionId: page.setSectionTitleCaretBySectionId,
        editingSectionIdRef: page.editingSectionIdRef,
        setEditingSectionId: page.setEditingSectionId,
      });
    },
    [commitSectionEdit, page, taskEditing.commitEdit],
  );

  const cancelSectionEdit = useCallback(
    () =>
      cancelAssignedTasksPageSectionEdit({
        editingSectionIdRef: page.editingSectionIdRef,
        setEditingSectionId: page.setEditingSectionId,
        resolveTemporarySection: sync.resolveTemporarySection,
      }),
    [page.editingSectionIdRef, page.setEditingSectionId, sync.resolveTemporarySection],
  );

  return {
    commitSectionEdit,
    selectSection,
    beginSectionEdit,
    cancelSectionEdit,
  };
}

function useAssignedTasksPageRuntimeSectionDeletes(input: {
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
}) {
  const { bootstrap, sync } = input;
  const { page } = bootstrap;

  const deleteSection = useCallback(
    async (section: WorkspaceTaskSection, tasks: UnifiedAssignedTask[]) => {
      await deleteAssignedTasksPageSection({
        sessionToken: page.session?.token,
        workspaceId: page.workspaceId,
        userId: page.userId,
        section,
        tasks,
        queryClient: page.queryClient,
        invalidateTasks: sync.invalidateTasks,
        setError: page.setError,
        setSectionDeleteConfirmation: page.setSectionDeleteConfirmation,
        setActiveSectionId: page.setActiveSectionId,
        setEditingSectionId: page.setEditingSectionId,
      });
    },
    [page, sync.invalidateTasks],
  );

  const requestDeleteSection = useCallback(
    (section: WorkspaceTaskSection, tasks: UnifiedAssignedTask[]) =>
      requestAssignedTasksPageSectionDelete({
        section,
        tasks,
        setSectionDeleteConfirmation: page.setSectionDeleteConfirmation,
        deleteSection: (deleteInput) => deleteSection(deleteInput.section, deleteInput.tasks),
      }),
    [deleteSection, page.setSectionDeleteConfirmation],
  );

  const confirmDeleteSection = useCallback(
    async () =>
      confirmAssignedTasksPageSectionDelete({
        sectionDeleteConfirmation: page.sectionDeleteConfirmation,
        deleteSection: (deleteInput) => deleteSection(deleteInput.section, deleteInput.tasks),
      }),
    [deleteSection, page.sectionDeleteConfirmation],
  );

  return {
    requestDeleteSection,
    confirmDeleteSection,
  };
}

function useAssignedTasksPageRuntimeSections(input: {
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
  taskEditing: ReturnType<typeof useAssignedTasksPageRuntimeTaskEditing>;
}) {
  const edits = useAssignedTasksPageRuntimeSectionEdits(input);
  const deletes = useAssignedTasksPageRuntimeSectionDeletes({ bootstrap: input.bootstrap, sync: input.sync });

  return { ...edits, ...deletes };
}

function useAssignedTasksPageRuntimeDrag(input: {
  view: AssignedTaskView;
  bootstrap: AssignedTasksPageBootstrap;
  sync: ReturnType<typeof useAssignedTasksPageRuntimeSync>;
  taskEditing: ReturnType<typeof useAssignedTasksPageRuntimeTaskEditing>;
  sections: ReturnType<typeof useAssignedTasksPageRuntimeSections>;
}) {
  const { view, bootstrap, sync, taskEditing, sections } = input;
  const { page, catalog } = bootstrap;

  const dragEndContext = useAssignedTasksPageDragEndContext({
    sessionToken: page.session?.token,
    workspaceId: page.workspaceId,
    userId: page.userId,
    visibleTaskById: catalog.visibleTaskById,
    canDragTask: catalog.canDragTask,
    getDraggedTasks: catalog.getDraggedTasks,
    getTaskViewDropPatch: (patchInput) => catalog.getTaskViewDropPatch(patchInput.task, patchInput.targetView),
    dragInsertionTargetRef: page.dragInsertionTargetRef,
    getDragInsertionTarget: catalog.getDragInsertionTarget,
    anchorsFromInsertionTarget: catalog.anchorsFromInsertionTarget,
    currentUserParticipant: catalog.currentUserParticipant,
    queryClient: page.queryClient,
    invalidateTasks: sync.invalidateTasks,
    setError: page.setError,
    sections: catalog.sections,
    allTasks: catalog.allTasks,
    view,
    isSearching: catalog.isSearching,
    trimmedSearchQuery: catalog.trimmedSearchQuery,
    lingeringTaskIds: catalog.lingeringTaskIds,
    sectionById: catalog.sectionById,
    dragPointerOverTaskNavRef: page.dragPointerOverTaskNavRef,
    setIsDragPointerOverTaskNav: page.setIsDragPointerOverTaskNav,
    setDragPreviewWidth: page.setDragPreviewWidth,
    setDragCursorOffsetX: page.setDragCursorOffsetX,
    setDragCursorOffsetY: page.setDragCursorOffsetY,
    setActiveDragId: page.setActiveDragId,
    setCurrentDragInsertionTarget: catalog.setCurrentDragInsertionTarget,
    setReorderPreviewTasks: page.setReorderPreviewTasks,
  });
  const { handleDragStart, handleDragMove, handleDragOver, handleDragEnd, handleDragCancel } =
    useAssignedTasksPageDragHandlers({
      containerRef: page.containerRef,
      setReorderPreviewTasks: page.setReorderPreviewTasks,
      setCurrentDragInsertionTarget: catalog.setCurrentDragInsertionTarget,
      dragPointerOverTaskNavRef: page.dragPointerOverTaskNavRef,
      setIsDragPointerOverTaskNav: page.setIsDragPointerOverTaskNav,
      setDragPreviewWidth: page.setDragPreviewWidth,
      setDragCursorOffsetX: page.setDragCursorOffsetX,
      setDragCursorOffsetY: page.setDragCursorOffsetY,
      setActiveDragId: page.setActiveDragId,
      getDragInsertionTarget: catalog.getDragInsertionTarget,
      dragEndContext,
    });

  useAssignedTasksPageHotkeys({
    activeSection: catalog.activeSection,
    activeSectionTasks: catalog.activeSectionTasks,
    activeTask: catalog.activeTask,
    beginEdit: taskEditing.beginEdit,
    canCreate: sync.canCreate,
    cancelEdit: taskEditing.cancelEdit,
    cancelSectionEdit: sections.cancelSectionEdit,
    clearTaskFocus: sync.clearTaskFocus,
    createTask: taskEditing.createTask,
    deleteSelectedTasks: taskEditing.deleteSelectedTasks,
    editingSectionId: page.editingSectionId,
    editingTaskId: page.editingTaskId,
    orderedVisibleTasks: catalog.orderedVisibleTasks,
    requestDeleteSection: (deleteInput) => sections.requestDeleteSection(deleteInput.section, deleteInput.tasks),
    selectedVisibleTasks: catalog.selectedVisibleTasks,
    setActiveByOffset: taskEditing.setActiveByOffset,
    toggleTasksDone: taskEditing.toggleTasksDone,
  });

  return {
    handleDragStart,
    handleDragMove,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  };
}

function useAssignedTasksPageRuntime(input: { view: AssignedTaskView; bootstrap: AssignedTasksPageBootstrap }) {
  const sync = useAssignedTasksPageRuntimeSync(input);
  const taskEditing = useAssignedTasksPageRuntimeTaskEditing({ ...input, sync });
  const sections = useAssignedTasksPageRuntimeSections({ bootstrap: input.bootstrap, sync, taskEditing });
  const drag = useAssignedTasksPageRuntimeDrag({ ...input, sync, taskEditing, sections });

  return { sync, taskEditing, sections, drag };
}

function workspaceAssignedTasksPageSectionSharedProps(input: {
  view: AssignedTaskView;
  bootstrap: AssignedTasksPageBootstrap;
  runtime: ReturnType<typeof useAssignedTasksPageRuntime>;
}): AssignedTaskManagerSectionSharedProps {
  const { view, bootstrap, runtime } = input;
  const { page, catalog } = bootstrap;
  const { taskEditing, sections } = runtime;

  return {
    view,
    activeDragId: page.activeDragId,
    editingTaskId: page.editingTaskId,
    activeTaskId: page.activeTaskId,
    cancelEdit: taskEditing.cancelEdit,
    setActiveTaskId: page.setActiveTaskId,
    setSelectedTaskIds: page.setSelectedTaskIds,
    setCollapsedPeriodIds: catalog.setCollapsedPeriodIds,
    activeSectionId: page.activeSectionId,
    editingSectionId: page.editingSectionId,
    sectionDrafts: page.sectionDrafts,
    setSectionDrafts: page.setSectionDrafts,
    selectSection: (sectionInput) => sections.selectSection(sectionInput.section),
    beginSectionEdit: (sectionInput) => sections.beginSectionEdit(sectionInput.section, sectionInput.titleCaretOffset),
    cancelSectionEdit: sections.cancelSectionEdit,
    commitSectionEdit: (sectionInput) => sections.commitSectionEdit(sectionInput.titleOverride),
    sectionTitleCaretBySectionId: page.sectionTitleCaretBySectionId,
    activeDragTaskIds: catalog.activeDragTaskIds,
    dragInsertionTarget: page.dragInsertionTarget,
    selectedTaskIds: page.selectedTaskIds,
    drafts: page.drafts,
    setDrafts: page.setDrafts,
    selectTask: (taskInput) => taskEditing.selectTask(taskInput.taskId, taskInput.event),
    beginEdit: (taskInput) => taskEditing.beginEdit(taskInput.task, taskInput.titleCaretOffset),
    commitEdit: (taskInput) => taskEditing.commitEdit(taskInput.draftOverride),
    toggleTaskDone: (taskInput) => taskEditing.toggleTaskDone(taskInput.task),
    canUpdateTaskStatus: (taskInput) => catalog.canUpdateTaskStatus(taskInput.task),
    assignTask: (taskInput) => taskEditing.assignTask(taskInput.task, taskInput.nextOwnerUserId),
    refreshWorkspaceAssignees: (workspaceInput) => catalog.refreshWorkspaceAssignees(workspaceInput.workspaceId),
    assigneeParticipantsByMeetingId: catalog.assigneeParticipantsByMeetingId,
    workspaceAssigneeParticipantsByWorkspaceId: catalog.workspaceAssigneeParticipantsByWorkspaceId,
    currentUserParticipant: catalog.currentUserParticipant,
    canReassignTask: (taskInput) => catalog.canReassignTask(taskInput.task),
    canDragTask: (taskInput) => catalog.canDragTask(taskInput.task),
    assigningTaskIds: page.assigningTaskIds,
    titleCaretByTaskId: page.titleCaretByTaskId,
    statusLingerByTaskId: page.statusLingerByTaskId,
    enteringTaskIds: page.enteringTaskIds,
  };
}

function WorkspaceAssignedTasksPageView(input: {
  view: AssignedTaskView;
  bootstrap: AssignedTasksPageBootstrap;
  runtime: ReturnType<typeof useAssignedTasksPageRuntime>;
}) {
  const { view, bootstrap, runtime } = input;
  const { page, catalog } = bootstrap;
  const { sync, taskEditing, sections, drag } = runtime;

  const assignedTaskManagerSectionSharedProps = workspaceAssignedTasksPageSectionSharedProps(input);
  const pageHeader = WorkspaceAssignedTasksPageHeader({
    pageTitle: catalog.pageTitle,
    view,
    searchQuery: page.searchQuery,
    setSearchQuery: page.setSearchQuery,
    canCreate: sync.canCreate,
    selectedVisibleTasks: catalog.selectedVisibleTasks,
    canDeleteSelection: catalog.canDeleteSelection,
    canUpdateTaskStatus: catalog.canUpdateTaskStatus,
    toggleTasksDone: taskEditing.toggleTasksDone,
    clearTaskFocus: sync.clearTaskFocus,
    deleteSelectedTasks: taskEditing.deleteSelectedTasks,
    allTasks: catalog.allTasks,
    isClearingDone: page.isClearingDone,
    clearDoneTasks: sync.clearDoneTasks,
    reopenableSelectedDoneTasks: catalog.reopenableSelectedDoneTasks,
    selectedDoneTasks: catalog.selectedDoneTasks,
    reopenSelectedDone: sync.reopenSelectedDone,
    clearSelectedDone: sync.clearSelectedDone,
    createTask: taskEditing.createTask,
  });

  return WorkspaceAssignedTasksPageRoot({
    sharedSectionProps: assignedTaskManagerSectionSharedProps,
    containerRef: page.containerRef,
    paintSelection: sync.paintSelection,
    pageTitle: catalog.pageTitle,
    renderSections: catalog.renderSections,
    collapsedPeriodIds: catalog.collapsedPeriodIds,
    shouldShowEmptyPlaceholder: catalog.shouldShowEmptyPlaceholder,
    pageHeader,
    sensors: sync.sensors,
    taskCollisionDetection: sync.taskCollisionDetection,
    onDragStart: drag.handleDragStart,
    onDragMove: drag.handleDragMove,
    onDragOver: drag.handleDragOver,
    onDragEnd: drag.handleDragEnd,
    onDragCancel: drag.handleDragCancel,
    meetings: page.meetings,
    view,
    canDropActiveTasksOnView: catalog.canDropActiveTasksOnView,
    activeDragTasks: catalog.activeDragTasks,
    error: page.error,
    sectionDeleteConfirmation: page.sectionDeleteConfirmation,
    onDismissSectionDelete: () => page.setSectionDeleteConfirmation(null),
    onConfirmSectionDelete: () => {
      void sections.confirmDeleteSection();
    },
    dragPreviewWidth: page.dragPreviewWidth,
    dragCursorOffsetX: page.dragCursorOffsetX,
    dragCursorOffsetY: page.dragCursorOffsetY,
    isDragPointerOverTaskNav: page.isDragPointerOverTaskNav,
  });
}

export function WorkspaceAssignedTasksPage({ view }: { view: AssignedTaskView }) {
  const bootstrap = useAssignedTasksPageBootstrap(view);
  const runtime = useAssignedTasksPageRuntime({ view, bootstrap });

  return WorkspaceAssignedTasksPageView({ view, bootstrap, runtime });
}
