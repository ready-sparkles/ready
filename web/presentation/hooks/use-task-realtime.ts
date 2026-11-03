"use client";

import { type TaskRealtimeEvent, taskRealtimeEventSchema } from "@readymeet/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  activeMeetingTasksStatusQueryKey,
  assignedTaskContextQueryKey,
  assignedTasksQueryKey,
  meetingDetailQueryKey,
  meetingNotesViewQueryKey,
  personalAssignedTasksQueryKey,
  terminalMeetingTasksStatusQueryKey,
  workspaceAssignedTasksQueryKey,
} from "../../domain/query-keys";
import {
  attachSharedChannel,
  isTransientRealtimeError,
  REALTIME_RETRY_DELAYS_MS,
  subscribeSharedChannel,
} from "../../domain/realtime-shared-channel";
import {
  authorizeRealtimeSetup,
  recoverFailedRealtimeChannel,
  shouldRefetchForRealtimeContinuity,
} from "../../domain/realtime-subscription";
import {
  createTaskRealtimeOrderingState,
  evaluateTaskRealtimeEvent,
  isTaskDeletionRealtimeEvent,
  rememberTaskListVersion,
  rememberTaskRevision,
  resetTaskRealtimeOrderingState,
  type TaskRealtimeOrderingState,
} from "../../domain/task-realtime-ordering";
import { useRealtimeClient } from "../components/realtime-provider";

type TaskRealtimeStatus = "idle" | "checking" | "healthy" | "recovering" | "degraded";

type RealtimeClient = NonNullable<ReturnType<typeof useRealtimeClient>["client"]>;
type RealtimeChannel = ReturnType<RealtimeClient["channels"]["get"]>;
type RealtimeStateChange = {
  current?: string;
  previous?: string;
  /** @external Ably connection state change wire field */
  resumed?: boolean;
  reason?: unknown;
};
type RealtimeEmitter = {
  on: (...args: unknown[]) => unknown;
  off: (...args: unknown[]) => unknown;
};

const TASK_REALTIME_CONNECTED_TIMEOUT_MS = 3_000;
const TASK_REALTIME_CONNECTING_TIMEOUT_MS = 5_000;
const TASK_REALTIME_ATTACH_TIMEOUT_PREFIX = "Timed out attaching to ";

function meetingTaskChannel(input: { workspaceId: string; meetingId: string }) {
  return `workspace:${input.workspaceId}:meeting:${input.meetingId}:tasks`;
}

function userTaskChannel(input: { workspaceId: string; userId: string }) {
  return `workspace:${input.workspaceId}:user:${input.userId}:tasks`;
}

function workspaceTaskChannel(input: { workspaceId: string }) {
  return `workspace:${input.workspaceId}:tasks`;
}

function normalizeState(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description !== undefined && value.description.length > 0 ? value.description : value.toString();
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return "";
}

function realtimeTimeoutMs(client: RealtimeClient) {
  return normalizeState(client.connection.state) === "connected"
    ? TASK_REALTIME_CONNECTED_TIMEOUT_MS
    : TASK_REALTIME_CONNECTING_TIMEOUT_MS;
}

async function withRealtimeTimeout<T>({
  promise,
  timeoutMs,
  message,
}: {
  promise: Promise<T>;
  timeoutMs: number;
  message: string;
}) {
  const timeoutState: { id: number | null } = { id: null };
  const timeout = new Promise<never>((_, reject) => {
    timeoutState.id = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutState.id !== null) {
      window.clearTimeout(timeoutState.id);
    }
  });
}

function isRealtimeEmitter(target: unknown): target is RealtimeEmitter {
  return (
    typeof target === "object" &&
    target !== null &&
    "on" in target &&
    typeof target.on === "function" &&
    "off" in target &&
    typeof target.off === "function"
  );
}

function addStateListener({
  target,
  eventName,
  listener,
}: {
  target: unknown;
  eventName: string;
  listener: (stateChange: RealtimeStateChange) => void;
}) {
  if (!isRealtimeEmitter(target)) {
    return () => {};
  }
  target.on(eventName, listener);

  return () => {
    target.off(eventName, listener);
  };
}

function allChannelsAttached({ client, channels }: { client: RealtimeClient; channels: RealtimeChannel[] }) {
  return (
    normalizeState(client.connection.state) === "connected" &&
    channels.every((channel) => normalizeState(channel.state) === "attached")
  );
}

function describeRealtimeReason(reason: unknown) {
  if (reason === null || reason === undefined) {
    return null;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "object" && "message" in reason && typeof reason.message === "string") {
    return reason.message;
  }

  if (typeof reason === "string") {
    return reason;
  }
  if (typeof reason === "number" || typeof reason === "boolean" || typeof reason === "bigint") {
    return String(reason);
  }
  if (typeof reason === "object") {
    return JSON.stringify(reason);
  }

  return "";
}

const TASK_REALTIME_RETRIES_EXHAUSTED_MESSAGE = "Task realtime retries exhausted";

async function retryTaskRealtimeAttach(input: {
  attachAndSubscribe: (reason: string) => Promise<boolean>;
  isCancelled: () => boolean;
  surface: string;
  attempt: number;
}): Promise<void> {
  const delayMs = REALTIME_RETRY_DELAYS_MS[input.attempt];
  if (delayMs === undefined) {
    throw new Error(TASK_REALTIME_RETRIES_EXHAUSTED_MESSAGE);
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
  if (input.isCancelled()) {
    return;
  }
  try {
    await input.attachAndSubscribe(`${input.surface}:retry-${input.attempt + 1}`);
  } catch (error) {
    if (!isTransientRealtimeError(error) || input.attempt + 1 >= REALTIME_RETRY_DELAYS_MS.length) {
      throw error;
    }
    await retryTaskRealtimeAttach({ ...input, attempt: input.attempt + 1 });
  }
}

async function runTaskRealtimeBootstrap(input: {
  attachAndSubscribe: (reason: string) => Promise<boolean>;
  isCancelled: () => boolean;
  setStatus: (status: TaskRealtimeStatus) => void;
  surface: string;
}) {
  input.setStatus("checking");
  try {
    await input.attachAndSubscribe(`${input.surface}:initial`);
    if (!input.isCancelled()) {
      input.setStatus("healthy");
    }
  } catch (error) {
    if (input.isCancelled()) {
      return;
    }
    if (!isTransientRealtimeError(error)) {
      reportTaskRealtimeIssue({ surface: input.surface, reason: "initial-subscribe-failed", detail: error });
    }
    input.setStatus("recovering");
    try {
      await retryTaskRealtimeAttach({ ...input, attempt: 0 });
      if (!input.isCancelled()) {
        input.setStatus("healthy");
      }
    } catch (retryError) {
      if (!input.isCancelled()) {
        reportTaskRealtimeIssue({ surface: input.surface, reason: "retry-subscribe-failed", detail: retryError });
        input.setStatus("degraded");
      }
    }
  }
}

function reportTaskRealtimeIssue({ surface, reason, detail }: { surface: string; reason: string; detail?: unknown }) {
  console.error("[readymeet:realtime] task realtime degraded.", {
    surface,
    reason,
    detail: describeRealtimeReason(detail) ?? detail,
  });
}

function shouldRefetchForContinuity({
  eventName,
  stateChange,
  isChannelSuspended = false,
}: {
  eventName: string;
  stateChange: RealtimeStateChange;
  isChannelSuspended?: boolean;
}) {
  return shouldRefetchForRealtimeContinuity({ eventName, stateChange, isSuspended: isChannelSuspended });
}

async function detachChannel(channel: RealtimeChannel) {
  try {
    await channel.detach();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // The scoped client may already be closing or the channel may never have attached.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function seedTaskListOrdering({ state, value }: { state: TaskRealtimeOrderingState; value: unknown }) {
  const record = asRecord(value);
  if (!record) {
    return;
  }

  const meetingId = typeof record.meetingId === "string" ? record.meetingId : null;
  const taskListVersion = typeof record.taskListVersion === "number" ? record.taskListVersion : null;
  rememberTaskListVersion(state, meetingId, taskListVersion);

  if (!Array.isArray(record.items)) {
    return;
  }
  record.items.forEach((item) => {
    const task = asRecord(item);
    rememberTaskRevision(
      state,
      typeof task?.id === "string" ? task.id : null,
      typeof task?.revision === "number" ? task.revision : null,
    );
  });
}

function seedMeetingOrderingState({
  state,
  queryClient,
  meetingId,
}: {
  state: TaskRealtimeOrderingState;
  queryClient: ReturnType<typeof useQueryClient>;
  meetingId: string;
}) {
  const detail = asRecord(queryClient.getQueryData(meetingDetailQueryKey(meetingId)));
  seedTaskListOrdering({ state, value: detail?.tasks });
  const notes = asRecord(queryClient.getQueryData(meetingNotesViewQueryKey(meetingId)));
  seedTaskListOrdering({ state, value: notes?.tasks });

  const activeStatus = asRecord(queryClient.getQueryData(activeMeetingTasksStatusQueryKey(meetingId)));
  seedTaskListOrdering({ state, value: activeStatus?.tasks });

  const terminalStatus = asRecord(queryClient.getQueryData(terminalMeetingTasksStatusQueryKey(meetingId)));
  seedTaskListOrdering({ state, value: terminalStatus?.tasks });
}

function seedAssignedOrderingState({
  state,
  queryClient,
  userId,
}: {
  state: TaskRealtimeOrderingState;
  queryClient: ReturnType<typeof useQueryClient>;
  userId: string;
}) {
  const assignedTasks = queryClient.getQueryData(assignedTasksQueryKey(userId));
  if (Array.isArray(assignedTasks)) {
    assignedTasks.forEach((entry) => {
      const task = asRecord(asRecord(entry)?.task);
      rememberTaskRevision(
        state,
        typeof task?.id === "string" ? task.id : null,
        typeof task?.revision === "number" ? task.revision : null,
      );
    });
  }

  const personalAssignedTasks = asRecord(queryClient.getQueryData(personalAssignedTasksQueryKey(userId)));
  if (!Array.isArray(personalAssignedTasks?.tasks)) {
    return;
  }

  personalAssignedTasks.tasks.forEach((entry) => {
    const task = asRecord(entry);
    rememberTaskRevision(
      state,
      typeof task?.taskId === "string" ? task.taskId : null,
      typeof task?.revision === "number" ? task.revision : null,
    );
  });
}

function invalidateMeetingTaskQueries({
  queryClient,
  meetingId,
}: {
  queryClient: ReturnType<typeof useQueryClient>;
  meetingId: string;
}) {
  void queryClient.invalidateQueries({ queryKey: meetingDetailQueryKey(meetingId) });
  void queryClient.invalidateQueries({ queryKey: activeMeetingTasksStatusQueryKey(meetingId) });
  void queryClient.invalidateQueries({ queryKey: terminalMeetingTasksStatusQueryKey(meetingId) });
}

type TaskRealtimeLifecycleRef = {
  current: {
    isCancelled: boolean;
    hasRegisteredHandler: boolean;
    isChannelSuspended: boolean;
  };
};

type AssignedTaskRealtimeLifecycle = {
  isCancelled: boolean;
  hasRegisteredHandler: boolean;
};

function createMeetingTaskMessageHandler({
  orderingRef,
  queryClient,
  meetingId,
  invalidateForRealtime,
}: {
  orderingRef: { current: TaskRealtimeOrderingState };
  queryClient: ReturnType<typeof useQueryClient>;
  meetingId: string;
  invalidateForRealtime: (continuity: "continuous" | "recovered") => void;
}) {
  return (message: { data?: unknown }) => {
    const parsed = taskRealtimeEventSchema.safeParse(message.data);
    if (!parsed.success) {
      invalidateForRealtime("continuous");

      return;
    }

    seedMeetingOrderingState({
      state: orderingRef.current,
      queryClient,
      meetingId,
    });
    const decision = evaluateTaskRealtimeEvent(orderingRef.current, parsed.data, {
      requireKnownTaskRevision: true,
      requireKnownTaskListVersion: true,
    });
    if (decision.action === "ignore") {
      return;
    }

    invalidateForRealtime("continuous");
  };
}

function createMeetingTaskChannelStateHandlers({
  surface,
  lifecycleRef,
  client,
  channels,
  setStatus,
  invalidateForRealtime,
}: {
  surface: string;
  lifecycleRef: TaskRealtimeLifecycleRef;
  client: RealtimeClient;
  channels: RealtimeChannel[];
  setStatus: (status: TaskRealtimeStatus) => void;
  invalidateForRealtime: (continuity: "continuous" | "recovered") => void;
}) {
  const lifecycle = lifecycleRef.current;
  const handleChannelState = ({ eventName, stateChange }: { eventName: string; stateChange: RealtimeStateChange }) => {
    const current = normalizeState(stateChange.current);
    if (
      lifecycle.hasRegisteredHandler &&
      shouldRefetchForContinuity({
        eventName,
        stateChange,
        isChannelSuspended: lifecycle.isChannelSuspended,
      })
    ) {
      // Lost continuity (e.g. a reattach after token re-auth) is recovered by the refetch; not an error.
      invalidateForRealtime("recovered");
    }

    if (current === "failed" || current === "suspended") {
      if (current === "suspended") {
        lifecycle.isChannelSuspended = true;
      }
      reportTaskRealtimeIssue({ surface, reason: `channel-${current}`, detail: stateChange.reason });
      setStatus("degraded");

      return;
    }

    if (current === "attached") {
      lifecycle.isChannelSuspended = false;
    }
    if (current === "attached" && lifecycle.hasRegisteredHandler && allChannelsAttached({ client, channels })) {
      setStatus("healthy");
    }
  };

  const handleConnectionState = (stateChange: RealtimeStateChange) => {
    const current = normalizeState(stateChange.current);
    if (current === "failed" || current === "suspended") {
      reportTaskRealtimeIssue({ surface, reason: `connection-${current}`, detail: stateChange.reason });
      setStatus("degraded");
    }
  };

  return { handleChannelState, handleConnectionState };
}

function listMeetingTaskRealtimeListenerRemovers({
  client,
  channel,
  handleChannelState,
  handleConnectionState,
}: {
  client: RealtimeClient;
  channel: RealtimeChannel;
  handleChannelState: (input: { eventName: string; stateChange: RealtimeStateChange }) => void;
  handleConnectionState: (stateChange: RealtimeStateChange) => void;
}) {
  return [
    addStateListener({ target: client.connection, eventName: "failed", listener: handleConnectionState }),
    addStateListener({ target: client.connection, eventName: "suspended", listener: handleConnectionState }),
    addStateListener({
      target: channel,
      eventName: "failed",
      listener: (stateChange) => handleChannelState({ eventName: "failed", stateChange }),
    }),
    addStateListener({
      target: channel,
      eventName: "suspended",
      listener: (stateChange) => handleChannelState({ eventName: "suspended", stateChange }),
    }),
    addStateListener({
      target: channel,
      eventName: "attached",
      listener: (stateChange) => handleChannelState({ eventName: "attached", stateChange }),
    }),
    addStateListener({
      target: channel,
      eventName: "update",
      listener: (stateChange) => handleChannelState({ eventName: "update", stateChange }),
    }),
  ];
}

async function runMeetingTaskAttachAndSubscribe({
  reason,
  channel,
  subscribedChannelsRef,
  lifecycleRef,
  handler,
  isCancelled,
  refreshRealtimeAuth,
  client,
}: {
  reason: string;
  channel: RealtimeChannel;
  subscribedChannelsRef: { current: Set<RealtimeChannel> };
  lifecycleRef: TaskRealtimeLifecycleRef;
  handler: (message: { data?: unknown }) => void;
  isCancelled: () => boolean;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  client: RealtimeClient;
}) {
  const subscribedChannels = subscribedChannelsRef.current;
  const lifecycle = lifecycleRef.current;
  if (
    !(await authorizeRealtimeSetup({
      refreshAuth: () => refreshRealtimeAuth(reason),
      isCancelled,
    }))
  ) {
    return false;
  }
  await recoverFailedRealtimeChannel(channel);
  if (isCancelled()) {
    return false;
  }
  if (!subscribedChannels.has(channel)) {
    try {
      await subscribeSharedChannel({ channel, handler });
    } catch (error) {
      channel.unsubscribe(handler);
      throw error;
    }
    if (isCancelled()) {
      channel.unsubscribe(handler);
      await detachChannel(channel);

      return false;
    }
    subscribedChannels.add(channel);
    lifecycle.hasRegisteredHandler = true;
  }
  await withRealtimeTimeout({
    promise: attachSharedChannel(channel),
    timeoutMs: realtimeTimeoutMs(client),
    message: TASK_REALTIME_ATTACH_TIMEOUT_PREFIX + channel.name,
  });
  if (isCancelled()) {
    channel.unsubscribe(handler);
    subscribedChannels.delete(channel);
    await detachChannel(channel);

    return false;
  }

  return true;
}

function handleAssignedTaskRealtimeMessage({
  message,
  queryClient,
  orderingRef,
  userId,
  userIdInput,
  workspaceIds,
  invalidatePersonalTasks,
}: {
  message: { data?: unknown };
  queryClient: ReturnType<typeof useQueryClient>;
  orderingRef: { current: TaskRealtimeOrderingState };
  userId: string;
  userIdInput?: string | null;
  workspaceIds: string[];
  invalidatePersonalTasks: () => void;
}) {
  const parsed = taskRealtimeEventSchema.safeParse(message.data);
  const assignedTasksKey = assignedTasksQueryKey(userIdInput ?? userId);
  if (!parsed.success) {
    void queryClient.invalidateQueries({ queryKey: assignedTasksKey });
    invalidatePersonalTasks();
    workspaceIds.forEach((workspaceId) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceAssignedTasksQueryKey(workspaceId, userId),
      });
    });

    return;
  }
  seedAssignedOrderingState({
    state: orderingRef.current,
    queryClient,
    userId,
  });
  const decision = evaluateTaskRealtimeEvent(orderingRef.current, parsed.data, {
    requireKnownTaskRevision: true,
  });
  if (decision.action === "ignore") {
    return;
  }
  const event: TaskRealtimeEvent = parsed.data;
  const isDeletedEvent = isTaskDeletionRealtimeEvent(event.eventName);
  invalidatePersonalTasks();
  void queryClient.invalidateQueries({
    queryKey: workspaceAssignedTasksQueryKey(event.workspaceId, userIdInput ?? userId),
  });

  if (event.eventName === "task.unassigned" || isDeletedEvent) {
    queryClient.setQueryData(assignedTasksKey, (current: unknown) => {
      if (!Array.isArray(current)) {
        return current;
      }

      const entries: unknown[] = current;

      return entries.filter((entry) => {
        const entryRecord = asRecord(entry);
        if (entryRecord === null) {
          return true;
        }
        const task = asRecord(entryRecord.task);
        if (task === null || task.id !== event.taskId) {
          return true;
        }

        return false;
      });
    });
  }

  if (isDeletedEvent) {
    queryClient.setQueryData(personalAssignedTasksQueryKey(userIdInput ?? userId), (current: unknown) => {
      const record = asRecord(current);
      if (!Array.isArray(record?.tasks)) {
        return current;
      }

      return {
        ...record,
        tasks: record.tasks.filter((entry) => {
          const task = asRecord(entry);

          return task?.taskId !== event.taskId;
        }),
      };
    });
    if (event.taskId !== null && event.taskId !== undefined && event.taskId.length > 0) {
      queryClient.removeQueries({ queryKey: assignedTaskContextQueryKey(event.taskId) });
    }
  }

  void queryClient.invalidateQueries({ queryKey: assignedTasksKey });
}

function createAssignedTaskChannelStateHandlers({
  surface,
  lifecycleRef,
  client,
  channels,
  suspendedChannelNamesRef,
  setStatus,
  invalidateAssignedTasks,
}: {
  surface: string;
  lifecycleRef: { current: AssignedTaskRealtimeLifecycle };
  client: RealtimeClient;
  channels: RealtimeChannel[];
  suspendedChannelNamesRef: { current: Set<string> };
  setStatus: (status: TaskRealtimeStatus) => void;
  invalidateAssignedTasks: () => void;
}) {
  const lifecycle = lifecycleRef.current;
  const suspendedChannelNames = suspendedChannelNamesRef.current;
  const handleChannelState = ({
    channel,
    eventName,
    stateChange,
  }: {
    channel: RealtimeChannel;
    eventName: string;
    stateChange: RealtimeStateChange;
  }) => {
    const current = normalizeState(stateChange.current);
    if (
      lifecycle.hasRegisteredHandler &&
      shouldRefetchForContinuity({
        eventName,
        stateChange,
        isChannelSuspended: suspendedChannelNames.has(channel.name),
      })
    ) {
      // Lost continuity (e.g. a reattach after token re-auth) is recovered by the refetch; not an error.
      invalidateAssignedTasks();
    }

    if (current === "failed" || current === "suspended") {
      if (current === "suspended") {
        suspendedChannelNames.add(channel.name);
      }
      reportTaskRealtimeIssue({ surface, reason: `channel-${current}`, detail: stateChange.reason });
      setStatus("degraded");

      return;
    }

    if (current === "attached") {
      suspendedChannelNames.delete(channel.name);
    }
    if (current === "attached" && lifecycle.hasRegisteredHandler && allChannelsAttached({ client, channels })) {
      setStatus("healthy");
    }
  };

  const handleConnectionState = (stateChange: RealtimeStateChange) => {
    const current = normalizeState(stateChange.current);
    if (current === "failed" || current === "suspended") {
      reportTaskRealtimeIssue({ surface, reason: `connection-${current}`, detail: stateChange.reason });
      setStatus("degraded");
    }
  };

  return { handleChannelState, handleConnectionState };
}

function listAssignedTaskRealtimeListenerRemovers({
  client,
  channels,
  handleChannelState,
  handleConnectionState,
}: {
  client: RealtimeClient;
  channels: RealtimeChannel[];
  handleChannelState: (input: {
    channel: RealtimeChannel;
    eventName: string;
    stateChange: RealtimeStateChange;
  }) => void;
  handleConnectionState: (stateChange: RealtimeStateChange) => void;
}) {
  return [
    addStateListener({ target: client.connection, eventName: "failed", listener: handleConnectionState }),
    addStateListener({ target: client.connection, eventName: "suspended", listener: handleConnectionState }),
    ...channels.flatMap((channel) => [
      addStateListener({
        target: channel,
        eventName: "failed",
        listener: (stateChange) => handleChannelState({ channel, eventName: "failed", stateChange }),
      }),
      addStateListener({
        target: channel,
        eventName: "suspended",
        listener: (stateChange) => handleChannelState({ channel, eventName: "suspended", stateChange }),
      }),
      addStateListener({
        target: channel,
        eventName: "attached",
        listener: (stateChange) => handleChannelState({ channel, eventName: "attached", stateChange }),
      }),
      addStateListener({
        target: channel,
        eventName: "update",
        listener: (stateChange) => handleChannelState({ channel, eventName: "update", stateChange }),
      }),
    ]),
  ];
}

async function unsubscribeAssignedChannels({
  subscribedChannelsRef,
  handler,
}: {
  subscribedChannelsRef: { current: Set<RealtimeChannel> };
  handler: (message: { data?: unknown }) => void;
}) {
  const subscribedChannels = subscribedChannelsRef.current;
  await [...subscribedChannels].reduce(async (step, subscribed) => {
    await step;
    subscribed.unsubscribe(handler);
    await detachChannel(subscribed);
  }, Promise.resolve());
}

async function runAssignedTaskAttachAndSubscribe({
  reason,
  channels,
  subscribedChannelsRef,
  lifecycleRef,
  handler,
  isCancelled,
  refreshRealtimeAuth,
  client,
}: {
  reason: string;
  channels: RealtimeChannel[];
  subscribedChannelsRef: { current: Set<RealtimeChannel> };
  lifecycleRef: { current: AssignedTaskRealtimeLifecycle };
  handler: (message: { data?: unknown }) => void;
  isCancelled: () => boolean;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  client: RealtimeClient;
}) {
  const subscribedChannels = subscribedChannelsRef.current;
  const lifecycle = lifecycleRef.current;
  if (
    !(await authorizeRealtimeSetup({
      refreshAuth: () => refreshRealtimeAuth(reason),
      isCancelled,
    }))
  ) {
    return false;
  }
  await Promise.all(channels.map((channel) => recoverFailedRealtimeChannel(channel)));
  if (isCancelled()) {
    return false;
  }
  const subscription = await channels.reduce<Promise<"ok" | "cancelled">>(async (previous, channel) => {
    const status = await previous;
    if (status === "cancelled" || subscribedChannels.has(channel)) {
      return status;
    }
    try {
      await subscribeSharedChannel({ channel, handler });
    } catch (error) {
      channel.unsubscribe(handler);
      throw error;
    }
    if (isCancelled()) {
      channel.unsubscribe(handler);
      await detachChannel(channel);
      await unsubscribeAssignedChannels({ subscribedChannelsRef, handler });
      subscribedChannels.clear();

      return "cancelled";
    }
    subscribedChannels.add(channel);

    return "ok";
  }, Promise.resolve("ok"));
  if (subscription === "cancelled") {
    return false;
  }
  lifecycle.hasRegisteredHandler = subscribedChannels.size === channels.length;
  const timeoutMs = realtimeTimeoutMs(client);
  await Promise.all(
    channels.map((channel) =>
      withRealtimeTimeout({
        promise: attachSharedChannel(channel),
        timeoutMs,
        message: TASK_REALTIME_ATTACH_TIMEOUT_PREFIX + channel.name,
      }),
    ),
  );
  if (isCancelled()) {
    await unsubscribeAssignedChannels({ subscribedChannelsRef, handler });
    subscribedChannels.clear();
    lifecycle.hasRegisteredHandler = false;

    return false;
  }

  return true;
}

function connectMeetingTaskRealtime(input: {
  client: RealtimeClient;
  workspaceId: string;
  meetingId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  orderingRef: { current: TaskRealtimeOrderingState };
  onInvalidateRef: { current: ((context: { continuity: "continuous" | "recovered" }) => void) | undefined };
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  lifecycleRef: TaskRealtimeLifecycleRef;
  setStatus: (status: TaskRealtimeStatus) => void;
}): () => void {
  const lifecycle = input.lifecycleRef.current;
  lifecycle.isCancelled = false;
  lifecycle.hasRegisteredHandler = false;
  lifecycle.isChannelSuspended = false;
  const surface = `meeting:${input.meetingId}`;
  const channel = input.client.channels.get(
    meetingTaskChannel({
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
    }),
  );
  const channels = [channel];
  const subscribedChannelsRef = { current: new Set<RealtimeChannel>() };
  const isCancelled = () => input.lifecycleRef.current.isCancelled;

  const invalidateForRealtime = (continuity: "continuous" | "recovered" = "continuous") => {
    invalidateMeetingTaskQueries({ queryClient: input.queryClient, meetingId: input.meetingId });
    input.onInvalidateRef.current?.({ continuity });
  };

  const handler = createMeetingTaskMessageHandler({
    orderingRef: input.orderingRef,
    queryClient: input.queryClient,
    meetingId: input.meetingId,
    invalidateForRealtime,
  });
  const { handleChannelState, handleConnectionState } = createMeetingTaskChannelStateHandlers({
    surface,
    lifecycleRef: input.lifecycleRef,
    client: input.client,
    channels,
    setStatus: input.setStatus,
    invalidateForRealtime,
  });
  const removeListeners = listMeetingTaskRealtimeListenerRemovers({
    client: input.client,
    channel,
    handleChannelState,
    handleConnectionState,
  });
  const attachAndSubscribe = (reason: string) =>
    runMeetingTaskAttachAndSubscribe({
      reason,
      channel,
      subscribedChannelsRef,
      lifecycleRef: input.lifecycleRef,
      handler,
      isCancelled,
      refreshRealtimeAuth: input.refreshRealtimeAuth,
      client: input.client,
    });

  void runTaskRealtimeBootstrap({
    attachAndSubscribe,
    isCancelled,
    setStatus: input.setStatus,
    surface,
  });

  return () => {
    lifecycle.isCancelled = true;
    removeListeners.forEach((removeListener) => {
      removeListener();
    });
    channel.unsubscribe(handler);
    subscribedChannelsRef.current.clear();
    void detachChannel(channel);
  };
}

export function useMeetingTaskRealtime(input: {
  workspaceId?: string | null;
  meetingId?: string | null;
  onInvalidate?: (context: { continuity: "continuous" | "recovered" }) => void;
}): { status: TaskRealtimeStatus } {
  const { client, refreshRealtimeAuth, scopeKey } = useRealtimeClient();
  const queryClient = useQueryClient();
  const orderingRef = useRef(createTaskRealtimeOrderingState());
  const onInvalidateRef = useRef(input.onInvalidate);
  const lifecycleRef = useRef({
    isCancelled: false,
    hasRegisteredHandler: false,
    isChannelSuspended: false,
  });
  const [status, setStatus] = useState<TaskRealtimeStatus>("idle");

  useEffect(() => {
    onInvalidateRef.current = input.onInvalidate;
  }, [input.onInvalidate]);

  useEffect(() => {
    resetTaskRealtimeOrderingState(orderingRef.current);
  }, [input.meetingId, input.workspaceId, scopeKey]);

  useEffect(() => {
    const meetingId = input.meetingId;
    const workspaceId = input.workspaceId;
    if (
      client === null ||
      workspaceId === null ||
      workspaceId === undefined ||
      workspaceId.length === 0 ||
      meetingId === null ||
      meetingId === undefined ||
      meetingId.length === 0
    ) {
      setStatus("idle");

      return;
    }

    return connectMeetingTaskRealtime({
      client,
      workspaceId,
      meetingId,
      queryClient,
      orderingRef,
      onInvalidateRef,
      refreshRealtimeAuth,
      lifecycleRef,
      setStatus,
    });
  }, [client, input.meetingId, input.workspaceId, queryClient, refreshRealtimeAuth]);

  return { status };
}

export function useAssignedTaskRealtime(input: {
  workspaceIds?: (string | null | undefined)[] | null;
  userId?: string | null;
}): { status: TaskRealtimeStatus } {
  const { client, refreshRealtimeAuth, scopeKey } = useRealtimeClient();
  const queryClient = useQueryClient();
  const orderingRef = useRef(createTaskRealtimeOrderingState());
  const lifecycleRef = useRef({ isCancelled: false, hasRegisteredHandler: false });
  const [status, setStatus] = useState<TaskRealtimeStatus>("idle");
  const workspaceIdsInput = (input.workspaceIds ?? [])
    .filter(
      (workspaceId): workspaceId is string =>
        workspaceId !== null && workspaceId !== undefined && workspaceId.length > 0,
    )
    .join("|");
  const workspaceIds = useMemo(
    () => [...new Set(workspaceIdsInput.split("|").filter(Boolean))].sort(),
    [workspaceIdsInput],
  );
  const workspaceScopeKey = workspaceIds.join("|");

  useEffect(() => {
    resetTaskRealtimeOrderingState(orderingRef.current);
  }, [input.userId, workspaceScopeKey, scopeKey]);

  useEffect(() => {
    const userId = input.userId;
    if (
      client === null ||
      userId === null ||
      userId === undefined ||
      userId.length === 0 ||
      workspaceIds.length === 0
    ) {
      setStatus("idle");

      return;
    }

    return connectAssignedTaskRealtime({
      client,
      userId,
      workspaceIds,
      queryClient,
      orderingRef,
      refreshRealtimeAuth,
      lifecycleRef,
      setStatus,
      userIdInput: input.userId,
    });
  }, [client, input.userId, queryClient, refreshRealtimeAuth, workspaceIds, workspaceScopeKey]);

  return { status };
}

function connectAssignedTaskRealtime(input: {
  client: RealtimeClient;
  userId: string;
  workspaceIds: string[];
  queryClient: ReturnType<typeof useQueryClient>;
  orderingRef: { current: TaskRealtimeOrderingState };
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  lifecycleRef: { current: { isCancelled: boolean; hasRegisteredHandler: boolean } };
  setStatus: (status: TaskRealtimeStatus) => void;
  userIdInput?: string | null;
}): () => void {
  const lifecycle = input.lifecycleRef.current;
  lifecycle.isCancelled = false;
  lifecycle.hasRegisteredHandler = false;
  const isCancelled = () => input.lifecycleRef.current.isCancelled;
  const suspendedChannelNamesRef = { current: new Set<string>() };
  const surface = `assigned:${input.userId}`;
  const channels = input.workspaceIds.flatMap((workspaceId) => [
    input.client.channels.get(
      userTaskChannel({
        workspaceId,
        userId: input.userId,
      }),
    ),
    input.client.channels.get(workspaceTaskChannel({ workspaceId })),
  ]);
  const subscribedChannelsRef = { current: new Set<RealtimeChannel>() };

  const invalidatePersonalTasks = () => {
    void input.queryClient.invalidateQueries({ queryKey: personalAssignedTasksQueryKey(input.userIdInput) });
  };
  const invalidateAssignedTasks = () => {
    void input.queryClient.invalidateQueries({
      queryKey: assignedTasksQueryKey(input.userIdInput ?? input.userId),
    });
    invalidatePersonalTasks();
  };

  const handler = (message: { data?: unknown }) => {
    handleAssignedTaskRealtimeMessage({
      message,
      queryClient: input.queryClient,
      orderingRef: input.orderingRef,
      userId: input.userId,
      userIdInput: input.userIdInput,
      workspaceIds: input.workspaceIds,
      invalidatePersonalTasks,
    });
  };
  const { handleChannelState, handleConnectionState } = createAssignedTaskChannelStateHandlers({
    surface,
    lifecycleRef: input.lifecycleRef,
    client: input.client,
    channels,
    suspendedChannelNamesRef,
    setStatus: input.setStatus,
    invalidateAssignedTasks,
  });
  const removeListeners = listAssignedTaskRealtimeListenerRemovers({
    client: input.client,
    channels,
    handleChannelState,
    handleConnectionState,
  });
  const attachAndSubscribe = (reason: string) =>
    runAssignedTaskAttachAndSubscribe({
      reason,
      channels,
      subscribedChannelsRef,
      lifecycleRef: input.lifecycleRef,
      handler,
      isCancelled,
      refreshRealtimeAuth: input.refreshRealtimeAuth,
      client: input.client,
    });

  void runTaskRealtimeBootstrap({
    attachAndSubscribe,
    isCancelled,
    setStatus: input.setStatus,
    surface,
  });

  return () => {
    lifecycle.isCancelled = true;
    removeListeners.forEach((removeListener) => {
      removeListener();
    });
    channels.forEach((channel) => {
      channel.unsubscribe(handler);
      void detachChannel(channel);
    });
    subscribedChannelsRef.current.clear();
  };
}
