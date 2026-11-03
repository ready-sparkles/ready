"use client";

import type { MeetingTask } from "@readymeet/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { updateMeetingTask } from "../../composition/api";
import { useToast } from "../components/toast-provider";
import {
  createOptimisticTaskCompletionController,
  invalidateTaskQueries,
  type OptimisticTaskStatus,
} from "../lib/optimistic-task-completion";

const TASK_NOT_UPDATED_TITLE = "Task not updated";
const TASK_UPDATE_FAILED_MESSAGE = "Could not update the task. Please try again.";

export function useOptimisticTaskCompletion(input: { token?: string | null; userId?: string | null }): {
  toggleTaskCompletion: (task: MeetingTask) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const tokenRef = useRef(input.token ?? null);
  const userIdRef = useRef(input.userId ?? null);
  const isReapplyingRef = useRef(false);
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>());
  const controller = useMemo(() => createOptimisticTaskCompletionController(queryClient), [queryClient]);

  useEffect(() => {
    tokenRef.current = input.token ?? null;
  }, [input.token]);

  useEffect(() => {
    userIdRef.current = input.userId ?? null;
  }, [input.userId]);

  useEffect(() => {
    return queryClient.getQueryCache().subscribe(() => {
      if (isReapplyingRef.current) {
        return;
      }

      queueMicrotask(() => {
        if (isReapplyingRef.current) {
          return;
        }
        isReapplyingRef.current = true;
        try {
          controller.reapplyPending();
        } finally {
          isReapplyingRef.current = false;
        }
      });
    });
  }, [controller, queryClient]);

  const toggleTaskCompletion = useCallback(
    async (task: MeetingTask) => {
      const token = tokenRef.current;
      if (token === null || token.length === 0) {
        return;
      }

      const userId = userIdRef.current;
      const nextStatus: OptimisticTaskStatus = task.status === "completed" ? "open" : "completed";
      const patch = {
        taskId: task.id,
        meetingId: task.meetingId,
        userId,
        status: nextStatus,
      };

      const mutationVersion = await controller.apply(patch);
      const previousMutation = mutationQueuesRef.current.get(task.id) ?? Promise.resolve();
      const queuedMutation: { promise: Promise<void> | null } = { promise: null };
      const nextMutation = (async (): Promise<void> => {
        try {
          await previousMutation;
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
        }
        try {
          const updatedTask = await updateMeetingTask({
            token,
            meetingId: task.meetingId,
            taskId: task.id,
            input: {
              status: nextStatus,
            },
          });
          controller.reconcile({ task: updatedTask, userId, mutationVersion });
        } catch (error) {
          const hasRolledBack = controller.rollback({ patch, mutationVersion });
          if (hasRolledBack) {
            showToast({
              id: `task-completion-failed:${task.id}:${Date.now()}`,
              title: TASK_NOT_UPDATED_TITLE,
              message: error instanceof Error ? error.message : TASK_UPDATE_FAILED_MESSAGE,
              tone: "warning",
            });
          }
        } finally {
          invalidateTaskQueries({ queryClient, patch });
          if (mutationQueuesRef.current.get(task.id) === queuedMutation.promise) {
            mutationQueuesRef.current.delete(task.id);
          }
        }
      })();
      queuedMutation.promise = nextMutation;

      mutationQueuesRef.current.set(task.id, nextMutation);
    },
    [controller, queryClient, showToast],
  );

  return {
    toggleTaskCompletion,
  };
}
