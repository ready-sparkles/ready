"use client";

import type { LinearTaskReviewRun, MeetingTask, MeetingTaskList, MeetingTaskProgress } from "@readymeet/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { updateMeetingTask } from "../../composition/api";
import { personalAssignedTasksQueryKey } from "../../domain/query-keys";
import { useOptimisticTaskCompletion } from "../hooks/use-optimistic-task-completion";

import { AgentThinkingBlock } from "./agent-thinking";
import { LinearTaskMark, LinearTaskReviewPanel } from "./linear-task-review";
import { MeetingTaskEvidenceMark } from "./meeting-task-evidence";
import { type TaskAssigneeParticipant, TaskAssigneePill } from "./task-assignee-pill";
import { TaskCheckboxIcon } from "./task-checkbox-icon";

export { TaskCheckboxIcon } from "./task-checkbox-icon";

// Keep confirmed tasks mounted for the full shared row-collapse motion. This
// lets both the product and the cinematic replay use the same merge geometry
// even when the post-sync refresh removes the source tasks immediately.
const LINEAR_TASK_EXIT_DURATION_MS = 520;
const CROSSFADE_TEXT_SWAP_MS = 120;
const CROSSFADE_TEXT_FINISH_MS = 240;
const LINEAR_TASK_MARK_STAGGER_MS = 70;

const COPY_WORKSPACE_TASKS_SECTION_TITLE = "Tasks";
const COPY_WORKSPACE_TASKS_NO_ITEMS = "No tasks";
const COPY_WORKSPACE_TASKS_PREPARE_FAILED = "Tasks could not be prepared.";

function isPresentString(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== "";
}

function isPresentNode(value: ReactNode): boolean {
  return value !== null && value !== undefined;
}

function getTaskThinkingCopy({ phase, progress }: { phase?: string | null; progress?: MeetingTaskProgress | null }) {
  const title =
    phase === "reviewing_transcript"
      ? "Reviewing the conversation"
      : phase === "finding_followups"
        ? "Finding follow-ups"
        : phase === "validating_tasks"
          ? "Checking commitments"
          : phase === "preparing_tasks"
            ? "Preparing meeting tasks"
            : "Preparing meeting tasks";

  const detail =
    progress && progress.totalChunks > 1
      ? `Reading section ${Math.min(progress.processedChunks + 1, progress.totalChunks)} of ${progress.totalChunks}.`
      : phase === "validating_tasks"
        ? "Confirming owners and removing uncertain suggestions."
        : phase === "preparing_tasks"
          ? "Turning the confirmed next steps into tasks."
          : "Looking for clear owners, commitments, and next steps.";

  return { title, detail };
}

function TaskThinkingRow({ phase, progress }: { phase?: string | null; progress?: MeetingTaskProgress | null }) {
  const copy = getTaskThinkingCopy({ phase, progress });

  return (
    <AgentThinkingBlock
      title={copy.title}
      detail={copy.detail}
      orbState="breathing"
      className="workspace-task-agent-thinking"
    />
  );
}

function taskStableKey(task: MeetingTask) {
  const quote = task.sourceQuotes[0];

  return quote ? `${quote.segmentId ?? "quote"}:${quote.quote}` : task.id;
}

function CrossfadeText({
  title,
  description,
  owner,
  suffix,
}: {
  title: string;
  description: string | null;
  owner?: ReactNode;
  suffix?: ReactNode;
}) {
  const [display, setDisplay] = useState({ title, description });
  const [isFading, setIsFading] = useState(false);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      setDisplay({ title, description });

      return;
    }

    setIsFading(true);
    const swapId = window.setTimeout(() => {
      setDisplay({ title, description });
    }, CROSSFADE_TEXT_SWAP_MS);
    const finishId = window.setTimeout(() => {
      setIsFading(false);
    }, CROSSFADE_TEXT_FINISH_MS);

    return () => {
      window.clearTimeout(swapId);
      window.clearTimeout(finishId);
    };
  }, [description, title]);

  return (
    <div className={`workspace-task-copy${isFading ? " is-refining" : ""}`}>
      <div className={`workspace-task-title-row${isPresentNode(owner) ? " has-owner-control" : ""}`}>
        <div className="workspace-task-title-text">
          {display.title}
          {suffix}
        </div>
        {owner}
      </div>
      {display.description !== null ? (
        <div className="workspace-task-description-text">{display.description}</div>
      ) : null}
    </div>
  );
}

function canMutateWorkspaceTask(input: {
  token?: string;
  meetingId?: string;
  isInteractive: boolean;
  isSaving: boolean;
  isMovingToLinear: boolean;
}): boolean {
  return (
    isPresentString(input.token) &&
    isPresentString(input.meetingId) &&
    input.isInteractive &&
    !input.isSaving &&
    !input.isMovingToLinear
  );
}

function resolveTaskAssigneeParticipant(input: {
  ownerUserId: string | null | undefined;
  participants: TaskAssigneeParticipant[];
  task: MeetingTask;
}): TaskAssigneeParticipant | null {
  const { ownerUserId, participants, task } = input;

  if (ownerUserId === null || ownerUserId === undefined) {
    return null;
  }

  return (
    participants.find((item) => item.userId === ownerUserId) ?? {
      userId: ownerUserId,
      displayName: task.assignee.name ?? "Assigned",
      email: task.assignee.email ?? null,
      avatarUrl: null,
    }
  );
}

function useWorkspaceTaskAssigneeControl(input: {
  task: MeetingTask;
  token?: string;
  meetingId?: string;
  currentUserId?: string | null;
  isInteractive: boolean;
  isMovingToLinear: boolean;
  participants: TaskAssigneeParticipant[];
  onUpdated?: () => void;
}) {
  const { task, token, meetingId, currentUserId, isInteractive, isMovingToLinear, participants, onUpdated } = input;
  const [isSaving, setIsSaving] = useState(false);
  const queryClient = useQueryClient();
  const [ownerUserId, setOwnerUserId] = useState(task.assignee.userId);

  useEffect(() => {
    setOwnerUserId(task.assignee.userId);
  }, [task.id, task.assignee.userId]);

  const currentAssignee = resolveTaskAssigneeParticipant({ ownerUserId, participants, task });
  const canMutateTask = canMutateWorkspaceTask({
    token,
    meetingId,
    isInteractive,
    isSaving,
    isMovingToLinear,
  });
  const ownerControl = (
    <TaskAssigneePill
      assignee={currentAssignee}
      participants={participants}
      disabled={!canMutateTask}
      onChange={async (nextOwnerUserId) => {
        if (!canMutateWorkspaceTask({ token, meetingId, isInteractive, isSaving, isMovingToLinear })) {
          return;
        }
        if (!isPresentString(token) || !isPresentString(meetingId)) {
          return;
        }

        const previousOwnerUserId = ownerUserId;
        setOwnerUserId(nextOwnerUserId);
        setIsSaving(true);
        try {
          const updatedTask = await updateMeetingTask({
            token,
            meetingId,
            taskId: task.id,
            input: {
              assigneeUserId: nextOwnerUserId,
            },
          });
          setOwnerUserId(updatedTask.assignee.userId);
          if (currentUserId !== null && currentUserId !== undefined) {
            void queryClient.invalidateQueries({
              queryKey: personalAssignedTasksQueryKey(currentUserId),
              exact: true,
            });
          }
          onUpdated?.();
        } catch (error) {
          setOwnerUserId(previousOwnerUserId);
          throw error;
        } finally {
          setIsSaving(false);
        }
      }}
    />
  );

  return { ownerControl, isSaving };
}

function WorkspaceTaskItem({
  task,
  token,
  meetingId,
  currentUserId,
  isInteractive,
  participants,
  movingToLinearTaskIds,
  isShowLinearMark = false,
  linearMarkDelayMs = 0,
  onToggleCompleted,
  onUpdated,
}: {
  task: MeetingTask;
  token?: string;
  meetingId?: string;
  currentUserId?: string | null;
  isInteractive: boolean;
  participants: TaskAssigneeParticipant[];
  movingToLinearTaskIds: Set<string>;
  isShowLinearMark?: boolean;
  linearMarkDelayMs?: number;
  onToggleCompleted: (task: MeetingTask) => Promise<void>;
  onUpdated?: () => void;
}) {
  const isCompleted = task.status === "completed";
  const isMovingToLinear = movingToLinearTaskIds.has(task.id);
  const { ownerControl, isSaving } = useWorkspaceTaskAssigneeControl({
    task,
    token,
    meetingId,
    currentUserId,
    isInteractive,
    isMovingToLinear,
    participants,
    onUpdated,
  });

  async function toggleCompleted() {
    if (!isPresentString(token) || !isPresentString(meetingId) || !isInteractive || isSaving) {
      return;
    }

    await onToggleCompleted(task);
  }

  return (
    <div
      className={`workspace-task-row${isCompleted ? " is-completed" : ""}${!isInteractive ? " is-readonly" : ""}${isMovingToLinear ? " is-moving-to-linear" : ""}`}
    >
      <button
        type="button"
        className="workspace-task-checkbox"
        disabled={!isInteractive || isSaving || isMovingToLinear}
        aria-label={isCompleted ? "Mark task open" : "Mark task complete"}
        aria-pressed={isCompleted}
        onClick={() => void toggleCompleted()}
      >
        <TaskCheckboxIcon checked={isCompleted} />
      </button>
      <div className="workspace-task-row-body">
        <CrossfadeText
          title={task.title}
          description={task.description}
          owner={ownerControl}
          suffix={
            isShowLinearMark || task.assetIds.length !== 0 ? (
              <span className="workspace-task-marks">
                {isShowLinearMark ? <LinearTaskMark delayMs={linearMarkDelayMs} /> : null}
                <MeetingTaskEvidenceMark token={token} meetingId={meetingId} assetIds={task.assetIds} />
              </span>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

type WorkspaceTasksSectionProps = {
  postTaskReview?: ReactNode;
  taskList: MeetingTaskList | null;
  phase: "idle" | "loading" | "complete";
  generationPhase?: string | null;
  generationProgress?: MeetingTaskProgress | null;
  token?: string;
  meetingId?: string;
  participants?: TaskAssigneeParticipant[];
  movingToLinearTaskIds?: string[];
  hiddenTaskIds?: string[];
  error?: string | null;
  onUpdated?: () => void;
  currentUserId?: string | null;
  onRevealComplete?: () => void;
  linearTaskReview?: LinearTaskReviewRun | null;
  onLinearTaskReviewChanged?: (review: LinearTaskReviewRun) => void;
};

function getCurrentActiveTasks(input: {
  visibleTasks: MeetingTask[];
  hiddenTaskIdSet: Set<string>;
  movingToLinearTaskIdSet: Set<string>;
}): MeetingTask[] {
  const { visibleTasks, hiddenTaskIdSet, movingToLinearTaskIdSet } = input;

  return visibleTasks.filter(
    (task) => task.status !== "dismissed" && (!hiddenTaskIdSet.has(task.id) || movingToLinearTaskIdSet.has(task.id)),
  );
}

function getLinearExitTasks(input: {
  linearExitSnapshot: { runId: string; tasks: MeetingTask[] } | null;
  linearTaskReviewId: string | undefined;
  currentActiveTasks: MeetingTask[];
}): MeetingTask[] {
  const { linearExitSnapshot, linearTaskReviewId, currentActiveTasks } = input;

  return linearExitSnapshot !== null && linearExitSnapshot.runId === linearTaskReviewId
    ? linearExitSnapshot.tasks
    : currentActiveTasks;
}

function getIsLinearExitActive(input: {
  linearTaskReview: LinearTaskReviewRun | null;
  finishedLinearReviewId: string | null;
  linearExitTasks: MeetingTask[];
  reviewedTaskIds: Set<string>;
}): boolean {
  const { linearTaskReview, finishedLinearReviewId, linearExitTasks, reviewedTaskIds } = input;

  return (
    linearTaskReview?.status === "completed" &&
    finishedLinearReviewId !== linearTaskReview.id &&
    linearExitTasks.some((task) => reviewedTaskIds.has(task.id))
  );
}

function getWorkspaceActiveTasks(input: {
  isLinearExitActive: boolean;
  linearExitTasks: MeetingTask[];
  currentActiveTasks: MeetingTask[];
  hasCompletedLinearReview: boolean;
  reviewedTaskIds: Set<string>;
}): MeetingTask[] {
  const { isLinearExitActive, linearExitTasks, currentActiveTasks, hasCompletedLinearReview, reviewedTaskIds } = input;

  return isLinearExitActive
    ? linearExitTasks
    : currentActiveTasks.filter((task) => !hasCompletedLinearReview || !reviewedTaskIds.has(task.id));
}

function buildGroupEndingAtIndex(input: {
  activeTasks: MeetingTask[];
  groupedReviewItems: LinearTaskReviewRun["items"];
}): Map<number, LinearTaskReviewRun["items"][number]> {
  const { activeTasks, groupedReviewItems } = input;
  const taskIndexById = new Map(activeTasks.map((task, index) => [task.id, index]));

  return new Map(
    groupedReviewItems.flatMap((item) => {
      const indexes = item.sourceTaskIds
        .map((taskId) => taskIndexById.get(taskId))
        .filter((index): index is number => index !== undefined);

      return indexes.length !== 0 ? [[Math.max(...indexes), item] as const] : [];
    }),
  );
}

function useWorkspaceTasksSectionModel(input: {
  taskList: MeetingTaskList | null;
  phase: WorkspaceTasksSectionProps["phase"];
  token?: string;
  meetingId?: string;
  movingToLinearTaskIds: string[];
  hiddenTaskIds: string[];
  linearTaskReview: LinearTaskReviewRun | null;
  finishedLinearReviewId: string | null;
  linearExitSnapshot: { runId: string; tasks: MeetingTask[] } | null;
}) {
  const {
    taskList,
    phase,
    token,
    meetingId,
    movingToLinearTaskIds,
    hiddenTaskIds,
    linearTaskReview,
    finishedLinearReviewId,
    linearExitSnapshot,
  } = input;
  const visibleTasks = taskList?.items ?? [];
  const movingToLinearTaskIdSet = useMemo(() => new Set(movingToLinearTaskIds), [movingToLinearTaskIds]);
  const hiddenTaskIdSet = useMemo(() => new Set(hiddenTaskIds), [hiddenTaskIds]);
  const currentActiveTasks = useMemo(
    () => getCurrentActiveTasks({ visibleTasks, hiddenTaskIdSet, movingToLinearTaskIdSet }),
    [hiddenTaskIdSet, movingToLinearTaskIdSet, visibleTasks],
  );
  const hasCompletedTasks = taskList === null ? phase === "complete" : taskList.status === "completed";
  const hasFailedTasks = taskList?.status === "failed";
  const reviewItems = useMemo(
    () => linearTaskReview?.items.filter((item) => item.included) ?? [],
    [linearTaskReview?.items],
  );
  const reviewedTaskIds = useMemo(() => new Set(reviewItems.flatMap((item) => item.sourceTaskIds)), [reviewItems]);
  const createdReviewTaskIds = useMemo(
    () => new Set(reviewItems.filter((item) => item.syncStatus === "created").flatMap((item) => item.sourceTaskIds)),
    [reviewItems],
  );
  const createdReviewTaskIdsKey = [...createdReviewTaskIds].join("|");
  const linearExitTasks = getLinearExitTasks({
    linearExitSnapshot,
    linearTaskReviewId: linearTaskReview?.id,
    currentActiveTasks,
  });
  const isLinearExitActive = getIsLinearExitActive({
    linearTaskReview,
    finishedLinearReviewId,
    linearExitTasks,
    reviewedTaskIds,
  });
  const hasCompletedLinearReview = linearTaskReview?.status === "completed";
  const activeTasks = getWorkspaceActiveTasks({
    isLinearExitActive,
    linearExitTasks,
    currentActiveTasks,
    hasCompletedLinearReview,
    reviewedTaskIds,
  });
  const hasVisibleTasks = activeTasks.length !== 0;
  const revealedTaskKey = activeTasks.map((task) => task.id).join("|");
  const shouldShowLoading = phase === "loading" && !hasCompletedTasks && !hasFailedTasks;
  const shouldShowThinking = shouldShowLoading;
  const isInteractive = hasCompletedTasks && isPresentString(token) && isPresentString(meetingId);
  const groupedReviewItems =
    hasCompletedLinearReview && !isLinearExitActive ? [] : reviewItems.filter((item) => item.sourceTaskIds.length > 1);
  const groupedTaskIds = useMemo(
    () => new Set(groupedReviewItems.flatMap((item) => item.sourceTaskIds)),
    [groupedReviewItems],
  );
  const groupEndingAtIndex = useMemo(
    () => buildGroupEndingAtIndex({ activeTasks, groupedReviewItems }),
    [activeTasks, groupedReviewItems],
  );

  return {
    movingToLinearTaskIdSet,
    currentActiveTasks,
    hasCompletedTasks,
    hasFailedTasks,
    reviewedTaskIds,
    createdReviewTaskIds,
    createdReviewTaskIdsKey,
    isLinearExitActive,
    activeTasks,
    hasVisibleTasks,
    revealedTaskKey,
    shouldShowThinking,
    isInteractive,
    groupedTaskIds,
    groupEndingAtIndex,
  };
}

function useWorkspaceTasksSectionEffects(input: {
  onUpdated?: () => void;
  onRevealComplete?: () => void;
  phase: WorkspaceTasksSectionProps["phase"];
  revealedTaskKey: string;
  linearTaskReview: LinearTaskReviewRun | null;
  reviewedTaskIds: Set<string>;
  createdReviewTaskIds: Set<string>;
  createdReviewTaskIdsKey: string;
  currentActiveTasks: MeetingTask[];
  isLinearExitActive: boolean;
  setLinearExitSnapshot: Dispatch<
    SetStateAction<{
      runId: string;
      tasks: MeetingTask[];
    } | null>
  >;
  setFinishedLinearReviewId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    onUpdated,
    onRevealComplete,
    phase,
    revealedTaskKey,
    linearTaskReview,
    reviewedTaskIds,
    createdReviewTaskIds,
    createdReviewTaskIdsKey,
    currentActiveTasks,
    isLinearExitActive,
    setLinearExitSnapshot,
    setFinishedLinearReviewId,
  } = input;
  const onUpdatedRef = useRef(onUpdated);
  const onRevealCompleteRef = useRef(onRevealComplete);
  useLayoutEffect(() => {
    onRevealCompleteRef.current = onRevealComplete;
  });

  useEffect(() => {
    onUpdatedRef.current = onUpdated;
  }, [onUpdated]);

  useEffect(() => {
    if (phase !== "complete" || onRevealCompleteRef.current === undefined) {
      return;
    }
    onRevealCompleteRef.current();
  }, [phase, revealedTaskKey]);

  useEffect(() => {
    if (linearTaskReview === null || linearTaskReview.status === "completed" || reviewedTaskIds.size === 0) {
      return;
    }
    setLinearExitSnapshot((current) => {
      if (current?.runId !== linearTaskReview.id) {
        return { runId: linearTaskReview.id, tasks: currentActiveTasks };
      }
      if (linearTaskReview.phase === "partial_failure" && createdReviewTaskIds.size > 0) {
        return {
          ...current,
          tasks: current.tasks.filter((task) => !createdReviewTaskIds.has(task.id)),
        };
      }

      return current;
    });
  }, [
    createdReviewTaskIdsKey,
    linearTaskReview?.id,
    linearTaskReview?.phase,
    linearTaskReview?.status,
    reviewedTaskIds.size,
  ]);

  useEffect(() => {
    if (linearTaskReview === null || !isLinearExitActive) {
      return;
    }
    const timer = window.setTimeout(() => {
      setFinishedLinearReviewId(linearTaskReview.id);
      onUpdatedRef.current?.();
    }, LINEAR_TASK_EXIT_DURATION_MS);

    return () => window.clearTimeout(timer);
  }, [isLinearExitActive, linearTaskReview, setFinishedLinearReviewId]);
}

function WorkspaceTasksSectionActiveRows({
  activeTasks,
  groupEndingAtIndex,
  groupedTaskIds,
  isLinearExitActive,
  reviewedTaskIds,
  isInteractive,
  token,
  meetingId,
  currentUserId,
  participants,
  movingToLinearTaskIdSet,
  onToggleCompleted,
  onUpdated,
}: {
  activeTasks: MeetingTask[];
  groupEndingAtIndex: Map<number, LinearTaskReviewRun["items"][number]>;
  groupedTaskIds: Set<string>;
  isLinearExitActive: boolean;
  reviewedTaskIds: Set<string>;
  isInteractive: boolean;
  token?: string;
  meetingId?: string;
  currentUserId?: string | null;
  participants: TaskAssigneeParticipant[];
  movingToLinearTaskIdSet: Set<string>;
  onToggleCompleted: (task: MeetingTask) => Promise<void>;
  onUpdated?: () => void;
}) {
  // Several tasks can cite the same quote; suffix repeats so React keys stay unique.
  const stableKeys = activeTasks.reduce<string[]>((keys, task) => {
    const baseKey = taskStableKey(task);
    const repeatCount = keys.filter((key) => key === baseKey || key.startsWith(`${baseKey}#`)).length;

    return [...keys, repeatCount === 0 ? baseKey : `${baseKey}#${repeatCount}`];
  }, []);

  return activeTasks.map((task, taskIndex) => {
    const groupedItem = groupEndingAtIndex.get(taskIndex);
    const isSourceLinearExiting = isLinearExitActive && reviewedTaskIds.has(task.id) && !groupedTaskIds.has(task.id);
    const groupedSourceTask = groupedItem
      ? (activeTasks.find((candidate) => groupedItem.sourceTaskIds.includes(candidate.id)) ?? task)
      : null;
    const isTaskInteractive = isInteractive && !isSourceLinearExiting;

    return (
      <Fragment key={stableKeys[taskIndex] ?? task.id}>
        <div
          className={`debug-workspace-collapse-wrap${groupedTaskIds.has(task.id) ? " is-collapsed" : ""}${isSourceLinearExiting ? " is-linear-exiting" : ""}`}
        >
          <div className="debug-workspace-collapse-inner">
            <WorkspaceTaskItem
              task={task}
              token={token}
              meetingId={meetingId}
              currentUserId={currentUserId}
              isInteractive={isTaskInteractive}
              participants={participants}
              movingToLinearTaskIds={movingToLinearTaskIdSet}
              isShowLinearMark={reviewedTaskIds.has(task.id)}
              linearMarkDelayMs={taskIndex * LINEAR_TASK_MARK_STAGGER_MS}
              onToggleCompleted={onToggleCompleted}
              onUpdated={onUpdated}
            />
          </div>
        </div>
        {groupedItem !== undefined && groupedSourceTask !== null ? (
          <div className={`debug-workspace-expand-wrap is-expanded${isLinearExitActive ? " is-linear-exiting" : ""}`}>
            <div className="debug-workspace-expand-inner">
              <WorkspaceTaskItem
                task={{
                  ...groupedSourceTask,
                  id: groupedItem.id,
                  title: groupedItem.title,
                  description: groupedItem.description,
                  assetIds: [
                    ...new Set(
                      activeTasks
                        .filter((candidate) => groupedItem.sourceTaskIds.includes(candidate.id))
                        .flatMap((candidate) => candidate.assetIds),
                    ),
                  ],
                }}
                token={token}
                meetingId={meetingId}
                currentUserId={currentUserId}
                isInteractive={false}
                participants={participants}
                movingToLinearTaskIds={movingToLinearTaskIdSet}
                isShowLinearMark
                onToggleCompleted={async () => undefined}
              />
            </div>
          </div>
        ) : null}
      </Fragment>
    );
  });
}

function WorkspaceTasksSectionListFooter({
  shouldShowThinking,
  generationPhase,
  generationProgress,
  linearTaskReview,
  token,
  onLinearTaskReviewChanged,
  postTaskReview,
  hasVisibleTasks,
  hasCompletedTasks,
  hasFailedTasks,
  error,
}: {
  shouldShowThinking: boolean;
  generationPhase?: string | null;
  generationProgress?: MeetingTaskProgress | null;
  linearTaskReview: LinearTaskReviewRun | null;
  token?: string;
  onLinearTaskReviewChanged?: (review: LinearTaskReviewRun) => void;
  postTaskReview?: ReactNode;
  hasVisibleTasks: boolean;
  hasCompletedTasks: boolean;
  hasFailedTasks: boolean;
  error?: string | null;
}) {
  return (
    <>
      {shouldShowThinking ? <TaskThinkingRow phase={generationPhase} progress={generationProgress} /> : null}
      {linearTaskReview !== null && isPresentString(token) ? (
        <div className="workspace-linear-review">
          <LinearTaskReviewPanel review={linearTaskReview} token={token} onReviewChanged={onLinearTaskReviewChanged} />
        </div>
      ) : null}
      {isPresentNode(postTaskReview) ? <div className="workspace-linear-review">{postTaskReview}</div> : null}
      {!hasVisibleTasks && !shouldShowThinking && hasCompletedTasks && !isPresentString(error) ? (
        <p className="workspace-flow-snapshot-note-line workspace-tasks-no-items">
          <span aria-hidden="true" className="workspace-flow-summary-bullet" />
          {COPY_WORKSPACE_TASKS_NO_ITEMS}
        </p>
      ) : null}
      {!hasVisibleTasks && !shouldShowThinking && (hasFailedTasks || isPresentString(error)) ? (
        <div className="workspace-task-empty">{error ?? COPY_WORKSPACE_TASKS_PREPARE_FAILED}</div>
      ) : null}
    </>
  );
}

export function WorkspaceTasksSection({
  taskList,
  phase,
  generationPhase,
  generationProgress,
  token,
  meetingId,
  participants = [],
  movingToLinearTaskIds = [],
  hiddenTaskIds = [],
  error,
  onUpdated,
  currentUserId,
  onRevealComplete,
  linearTaskReview = null,
  onLinearTaskReviewChanged,
  postTaskReview,
}: WorkspaceTasksSectionProps) {
  const { toggleTaskCompletion } = useOptimisticTaskCompletion({
    token,
    userId: currentUserId,
  });
  const [finishedLinearReviewId, setFinishedLinearReviewId] = useState<string | null>(null);
  const [linearExitSnapshot, setLinearExitSnapshot] = useState<{
    runId: string;
    tasks: MeetingTask[];
  } | null>(null);
  const model = useWorkspaceTasksSectionModel({
    taskList,
    phase,
    token,
    meetingId,
    movingToLinearTaskIds,
    hiddenTaskIds,
    linearTaskReview,
    finishedLinearReviewId,
    linearExitSnapshot,
  });
  useWorkspaceTasksSectionEffects({
    onUpdated,
    onRevealComplete,
    phase,
    revealedTaskKey: model.revealedTaskKey,
    linearTaskReview,
    reviewedTaskIds: model.reviewedTaskIds,
    createdReviewTaskIds: model.createdReviewTaskIds,
    createdReviewTaskIdsKey: model.createdReviewTaskIdsKey,
    currentActiveTasks: model.currentActiveTasks,
    isLinearExitActive: model.isLinearExitActive,
    setLinearExitSnapshot,
    setFinishedLinearReviewId,
  });

  return (
    <div className="workspace-document-section workspace-tasks-section workspace-tasks-stable">
      <div className="workspace-tasks-card">
        <div className="workspace-tasks-header">
          <div>
            <div className="workspace-tasks-title">{COPY_WORKSPACE_TASKS_SECTION_TITLE}</div>
          </div>
        </div>

        <div className="workspace-task-list">
          <WorkspaceTasksSectionActiveRows
            activeTasks={model.activeTasks}
            groupEndingAtIndex={model.groupEndingAtIndex}
            groupedTaskIds={model.groupedTaskIds}
            isLinearExitActive={model.isLinearExitActive}
            reviewedTaskIds={model.reviewedTaskIds}
            isInteractive={model.isInteractive}
            token={token}
            meetingId={meetingId}
            currentUserId={currentUserId}
            participants={participants}
            movingToLinearTaskIdSet={model.movingToLinearTaskIdSet}
            onToggleCompleted={toggleTaskCompletion}
            onUpdated={onUpdated}
          />
          <WorkspaceTasksSectionListFooter
            shouldShowThinking={model.shouldShowThinking}
            generationPhase={generationPhase}
            generationProgress={generationProgress}
            linearTaskReview={linearTaskReview}
            token={token}
            onLinearTaskReviewChanged={onLinearTaskReviewChanged}
            postTaskReview={postTaskReview}
            hasVisibleTasks={model.hasVisibleTasks}
            hasCompletedTasks={model.hasCompletedTasks}
            hasFailedTasks={model.hasFailedTasks}
            error={error}
          />
        </div>
      </div>
    </div>
  );
}
