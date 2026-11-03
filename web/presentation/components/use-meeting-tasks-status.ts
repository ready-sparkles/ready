"use client";

import {
  type AiWorkflowJobView,
  MEETING_TASKS_PROMPT_VERSION,
  type MeetingTaskList,
  type MeetingTaskListStatus,
  type MeetingTaskProgress,
} from "@readymeet/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { getMeetingTasksStatus, runMeetingTasks } from "../../composition/api";
import { activeMeetingTasksStatusQueryKey, terminalMeetingTasksStatusQueryKey } from "../../domain/query-keys";

export type MeetingTasksStatusView = {
  status: MeetingTaskListStatus;
  phase: string;
  error: string | null;
  isTerminal: boolean;
  isCurrent: boolean;
  job: AiWorkflowJobView | null;
  tasks: MeetingTaskList | null;
  progress: MeetingTaskProgress | null;
};

const TASK_STATUS_POLL_MS = 1200;
const TASK_PHASE_ORDER: readonly [
  "reviewing_transcript",
  "finding_followups",
  "validating_tasks",
  "preparing_tasks",
  "complete",
] = ["reviewing_transcript", "finding_followups", "validating_tasks", "preparing_tasks", "complete"];

type MeetingTaskStatusBehavior = {
  /** @external meeting tasks viewing behavior */
  reuseExistingCompletedTasks?: boolean;
};

async function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function statusFromTaskList(
  ...[tasks, behavior = {}]: [tasks: MeetingTaskList, behavior?: MeetingTaskStatusBehavior]
): MeetingTasksStatusView | null {
  if (tasks.status !== "completed" && tasks.status !== "failed") {
    return null;
  }

  const isPromptVersionCurrent = tasks.promptVersion === MEETING_TASKS_PROMPT_VERSION;
  const canReuseExistingCompletedTasks = behavior.reuseExistingCompletedTasks === true && tasks.status === "completed";
  if (!isPromptVersionCurrent && !canReuseExistingCompletedTasks) {
    return null;
  }

  const taskError = tasks.error?.message;

  return {
    status: tasks.status,
    phase: tasks.phase ?? (tasks.status === "completed" ? "complete" : "failed"),
    error:
      tasks.status === "failed" ? (typeof taskError === "string" ? taskError : "Tasks could not be prepared.") : null,
    isTerminal: true,
    isCurrent: isPromptVersionCurrent,
    job: null,
    tasks,
    progress: null,
  };
}

export function normalizeMeetingTasksStatusForViewing(
  ...[nextStatus, behavior = {}]: [nextStatus: MeetingTasksStatusView, behavior?: MeetingTaskStatusBehavior]
): MeetingTasksStatusView {
  if (!(behavior.reuseExistingCompletedTasks ?? false) || nextStatus.tasks?.status !== "completed") {
    return nextStatus;
  }

  const reusableStatus = statusFromTaskList(nextStatus.tasks, behavior);
  if (!reusableStatus) {
    return nextStatus;
  }

  return {
    ...reusableStatus,
    isCurrent: nextStatus.isCurrent,
    job: nextStatus.job,
    progress: nextStatus.progress,
  };
}

export function shouldRunMeetingTasksForStatus(
  ...[nextStatus, behavior = {}]: [nextStatus: MeetingTasksStatusView, behavior?: MeetingTaskStatusBehavior]
): boolean {
  if (nextStatus.isTerminal) {
    return false;
  }

  return !(behavior.reuseExistingCompletedTasks === true && nextStatus.tasks?.status === "completed");
}

function phaseIndex(phase: string | null | undefined) {
  return TASK_PHASE_ORDER.findIndex((item) => item === phase);
}

function sanitizeTaskError(error: unknown) {
  if (error === undefined || error === null) {
    return null;
  }

  return "Tasks could not be prepared.";
}

function createMonotonicTaskStatus() {
  const cursor: { highestPhaseIndex: number; lastJobId: string | null } = {
    highestPhaseIndex: -1,
    lastJobId: null,
  };

  return (nextStatus: MeetingTasksStatusView): MeetingTasksStatusView => {
    const nextJobId = nextStatus.job?.id ?? null;
    if (nextJobId !== null && nextJobId !== cursor.lastJobId) {
      cursor.lastJobId = nextJobId;
      cursor.highestPhaseIndex = -1;
    }

    const nextIndex = phaseIndex(nextStatus.phase);
    if (nextIndex > cursor.highestPhaseIndex) {
      cursor.highestPhaseIndex = nextIndex;
    }

    const phase =
      cursor.highestPhaseIndex >= 0 && nextIndex >= 0 && nextIndex < cursor.highestPhaseIndex
        ? (TASK_PHASE_ORDER[cursor.highestPhaseIndex] ?? nextStatus.phase)
        : nextStatus.phase;

    return {
      ...nextStatus,
      phase,
      error: nextStatus.status === "failed" ? sanitizeTaskError(nextStatus.error) : null,
    };
  };
}

type MeetingTasksStatusRunInput = {
  token: string;
  meetingId: string;
  canReuseExistingCompletedTasks: boolean;
  isRunCancelled: () => boolean;
  monotonicStatus: (nextStatus: MeetingTasksStatusView) => MeetingTasksStatusView;
  rememberStatus: (nextStatus: MeetingTasksStatusView) => void;
  setStatus: (nextStatus: MeetingTasksStatusView) => void;
};

async function pollMeetingTasksStatusSequentially(pollInput: {
  run: MeetingTasksStatusRunInput;
  currentStatus: MeetingTasksStatusView;
}): Promise<void> {
  if (pollInput.run.isRunCancelled() || pollInput.currentStatus.isTerminal) {
    return;
  }

  await sleep(TASK_STATUS_POLL_MS);
  const fetchedStatus = await getMeetingTasksStatus({ token: pollInput.run.token, meetingId: pollInput.run.meetingId });
  if (!pollInput.run.isRunCancelled()) {
    const polledStatus = pollInput.run.monotonicStatus(fetchedStatus);
    pollInput.run.rememberStatus(polledStatus);
    pollInput.run.setStatus(polledStatus);
    await pollMeetingTasksStatusSequentially({ run: pollInput.run, currentStatus: polledStatus });
  }
}

async function runMeetingTasksStatusWorkflow(input: MeetingTasksStatusRunInput): Promise<void> {
  const loadedStatus = await getMeetingTasksStatus({ token: input.token, meetingId: input.meetingId });
  if (input.isRunCancelled()) {
    return;
  }
  const normalizedStatus = input.monotonicStatus(
    normalizeMeetingTasksStatusForViewing(loadedStatus, {
      reuseExistingCompletedTasks: input.canReuseExistingCompletedTasks,
    }),
  );
  input.rememberStatus(normalizedStatus);
  input.setStatus(normalizedStatus);

  if (
    !shouldRunMeetingTasksForStatus(normalizedStatus, {
      reuseExistingCompletedTasks: input.canReuseExistingCompletedTasks,
    })
  ) {
    return;
  }

  const startedStatus = await runMeetingTasks({ token: input.token, meetingId: input.meetingId });
  if (input.isRunCancelled()) {
    return;
  }
  const runStatus = input.monotonicStatus(startedStatus);
  input.rememberStatus(runStatus);
  input.setStatus(runStatus);

  await pollMeetingTasksStatusSequentially({ run: input, currentStatus: runStatus });
}

export function useMeetingTasksStatus(input: {
  token: string | null;
  meetingId: string | null;
  /** @external hook enablement contract */
  enabled: boolean;
  initialTasks: MeetingTaskList | null;
  /** @external meeting tasks viewing behavior */
  reuseExistingCompletedTasks?: boolean;
}): MeetingTasksStatusView | null {
  const {
    token,
    meetingId,
    enabled: isEnabled,
    initialTasks,
    reuseExistingCompletedTasks: shouldReuseExistingCompletedTasks = false,
  } = input;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<MeetingTasksStatusView | null>(() =>
    initialTasks !== null
      ? statusFromTaskList(initialTasks, { reuseExistingCompletedTasks: shouldReuseExistingCompletedTasks })
      : null,
  );
  const runKeyRef = useRef<string | null>(null);

  const initialTerminalStatus = useMemo(() => {
    const fromInitialTasks =
      initialTasks !== null
        ? statusFromTaskList(initialTasks, { reuseExistingCompletedTasks: shouldReuseExistingCompletedTasks })
        : null;
    if (fromInitialTasks !== null || meetingId === null) {
      return fromInitialTasks;
    }

    return queryClient.getQueryData<MeetingTasksStatusView>(terminalMeetingTasksStatusQueryKey(meetingId)) ?? null;
  }, [initialTasks, meetingId, queryClient, shouldReuseExistingCompletedTasks]);

  function rememberStatus(nextStatus: MeetingTasksStatusView) {
    if (meetingId === null) {
      return;
    }
    if (nextStatus.isTerminal) {
      queryClient.setQueryData(terminalMeetingTasksStatusQueryKey(meetingId), nextStatus);

      return;
    }
    queryClient.setQueryData(activeMeetingTasksStatusQueryKey(meetingId), nextStatus);
  }

  useEffect(() => {
    runKeyRef.current = null;
    setStatus(initialTerminalStatus);
  }, [initialTerminalStatus, meetingId]);

  useEffect(() => {
    if (!isEnabled || token === null || meetingId === null) {
      return;
    }

    if (runKeyRef.current === meetingId) {
      return;
    }

    const runState: { isRunCancelled: boolean } = { isRunCancelled: false };
    const monotonicStatus = createMonotonicTaskStatus();
    runKeyRef.current = meetingId;

    const runInput: MeetingTasksStatusRunInput = {
      token,
      meetingId,
      canReuseExistingCompletedTasks: shouldReuseExistingCompletedTasks,
      isRunCancelled: () => runState.isRunCancelled,
      monotonicStatus,
      rememberStatus,
      setStatus,
    };

    void (async () => {
      try {
        await runMeetingTasksStatusWorkflow(runInput);
      } catch (error: unknown) {
        if (!runState.isRunCancelled) {
          setStatus({
            status: "failed",
            phase: "failed",
            error: sanitizeTaskError(error) ?? "Tasks could not be prepared.",
            isTerminal: true,
            isCurrent: false,
            job: null,
            tasks: null,
            progress: null,
          });
        }
      }
    })();

    return () => {
      runState.isRunCancelled = true;
    };
  }, [isEnabled, initialTerminalStatus, meetingId, queryClient, shouldReuseExistingCompletedTasks, token]);

  return status;
}
