import type { TaskRealtimeEvent } from "@readymeet/shared";

type TaskRealtimeDecision =
  | { action: "apply"; reason: "fresh" | "progress" }
  | { action: "ignore"; reason: "duplicate" | "stale-task-revision" | "stale-task-list-version" }
  | {
      action: "refetch";
      reason: "task-revision-gap" | "task-list-version-gap" | "unknown-task-revision" | "unknown-task-list-version";
    };

export type TaskRealtimeOrderingState = {
  seenEventIds: Set<string>;
  taskRevisions: Map<string, number>;
  taskListVersions: Map<string, number>;
};

export function createTaskRealtimeOrderingState(): TaskRealtimeOrderingState {
  return {
    seenEventIds: new Set(),
    taskRevisions: new Map(),
    taskListVersions: new Map(),
  };
}

export function resetTaskRealtimeOrderingState(state: TaskRealtimeOrderingState): void {
  const ordering = state;
  ordering.seenEventIds = new Set();
  ordering.taskRevisions = new Map();
  ordering.taskListVersions = new Map();
}

export function isTaskDeletionRealtimeEvent(eventName: TaskRealtimeEvent["eventName"]): boolean {
  return eventName === "task.deleted" || eventName === "workspace.task.deleted";
}

type RememberTaskRevisionArgs =
  | [state: TaskRealtimeOrderingState, taskId: string | null | undefined, revision: number | null | undefined]
  | [{ state: TaskRealtimeOrderingState; taskId: string | null | undefined; revision: number | null | undefined }];

export function rememberTaskRevision(...args: RememberTaskRevisionArgs): void {
  const { state, taskId, revision } =
    args.length === 1 ? args[0] : { state: args[0], taskId: args[1], revision: args[2] };
  const ordering = state;
  if (taskId === null || taskId === undefined || taskId === "" || typeof revision !== "number") {
    return;
  }
  const current = ordering.taskRevisions.get(taskId);
  if (current !== undefined && revision <= current) {
    return;
  }
  const nextRevisions = new Map(ordering.taskRevisions);
  nextRevisions.set(taskId, revision);
  ordering.taskRevisions = nextRevisions;
}

type RememberTaskListVersionArgs =
  | [state: TaskRealtimeOrderingState, meetingId: string | null | undefined, taskListVersion: number | null | undefined]
  | [
      {
        state: TaskRealtimeOrderingState;
        meetingId: string | null | undefined;
        taskListVersion: number | null | undefined;
      },
    ];

export function rememberTaskListVersion(...args: RememberTaskListVersionArgs): void {
  const { state, meetingId, taskListVersion } =
    args.length === 1 ? args[0] : { state: args[0], meetingId: args[1], taskListVersion: args[2] };
  const ordering = state;
  if (meetingId === null || meetingId === undefined || meetingId === "" || typeof taskListVersion !== "number") {
    return;
  }
  const current = ordering.taskListVersions.get(meetingId);
  if (current !== undefined && taskListVersion <= current) {
    return;
  }
  const nextVersions = new Map(ordering.taskListVersions);
  nextVersions.set(meetingId, taskListVersion);
  ordering.taskListVersions = nextVersions;
}

type EvaluateTaskRealtimeEventOptions = {
  /** @external task realtime ordering option */
  requireKnownTaskRevision?: boolean;
  /** @external task realtime ordering option */
  requireKnownTaskListVersion?: boolean;
};

function evaluateTaskRevisionOrdering(input: {
  ordering: TaskRealtimeOrderingState;
  event: TaskRealtimeEvent;
  options: EvaluateTaskRealtimeEventOptions;
}): TaskRealtimeDecision | null {
  const { ordering, event, options } = input;
  if (
    event.taskId === null ||
    event.taskId === undefined ||
    event.taskId === "" ||
    typeof event.revision !== "number"
  ) {
    return null;
  }
  const currentRevision = ordering.taskRevisions.get(event.taskId);
  if (currentRevision === undefined) {
    if (options.requireKnownTaskRevision === true) {
      rememberTaskRevision(ordering, event.taskId, event.revision);

      return { action: "refetch", reason: "unknown-task-revision" };
    }
    rememberTaskRevision(ordering, event.taskId, event.revision);

    return null;
  }
  if (event.revision <= currentRevision) {
    return { action: "ignore", reason: "stale-task-revision" };
  }
  if (event.revision > currentRevision + 1) {
    rememberTaskRevision(ordering, event.taskId, event.revision);

    return { action: "refetch", reason: "task-revision-gap" };
  }
  rememberTaskRevision(ordering, event.taskId, event.revision);

  return null;
}

function evaluateTaskListVersionOrdering(input: {
  ordering: TaskRealtimeOrderingState;
  event: TaskRealtimeEvent;
  options: EvaluateTaskRealtimeEventOptions;
}): TaskRealtimeDecision | null {
  const { ordering, event, options } = input;
  if (event.meetingId === null || event.meetingId === "" || typeof event.taskListVersion !== "number") {
    return null;
  }
  const currentVersion = ordering.taskListVersions.get(event.meetingId);
  if (currentVersion === undefined) {
    if (options.requireKnownTaskListVersion === true) {
      rememberTaskListVersion(ordering, event.meetingId, event.taskListVersion);

      return { action: "refetch", reason: "unknown-task-list-version" };
    }
    rememberTaskListVersion(ordering, event.meetingId, event.taskListVersion);

    return null;
  }
  if (event.taskListVersion <= currentVersion) {
    return { action: "ignore", reason: "stale-task-list-version" };
  }
  if (event.taskListVersion > currentVersion + 1) {
    rememberTaskListVersion(ordering, event.meetingId, event.taskListVersion);

    return { action: "refetch", reason: "task-list-version-gap" };
  }
  rememberTaskListVersion(ordering, event.meetingId, event.taskListVersion);

  return null;
}

type EvaluateTaskRealtimeEventArgs =
  | [state: TaskRealtimeOrderingState, event: TaskRealtimeEvent, options?: EvaluateTaskRealtimeEventOptions]
  | [{ state: TaskRealtimeOrderingState; event: TaskRealtimeEvent; options?: EvaluateTaskRealtimeEventOptions }];

export function evaluateTaskRealtimeEvent(...args: EvaluateTaskRealtimeEventArgs): TaskRealtimeDecision {
  const {
    state,
    event,
    options = {},
  } = args.length === 1 ? args[0] : { state: args[0], event: args[1], options: args[2] };
  const ordering = state;
  if (ordering.seenEventIds.has(event.eventId)) {
    return { action: "ignore", reason: "duplicate" };
  }
  const nextSeen = new Set(ordering.seenEventIds);
  nextSeen.add(event.eventId);
  ordering.seenEventIds = nextSeen;

  const revisionDecision = evaluateTaskRevisionOrdering({ ordering, event, options });
  if (revisionDecision !== null) {
    return revisionDecision;
  }

  const listVersionDecision = evaluateTaskListVersionOrdering({ ordering, event, options });
  if (listVersionDecision !== null) {
    return listVersionDecision;
  }

  return event.eventName.startsWith("task.generation.")
    ? { action: "apply", reason: "progress" }
    : { action: "apply", reason: "fresh" };
}
