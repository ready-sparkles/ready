"use client";
import { useEffect, useRef } from "react";

import { useToast } from "./toast-provider";

const MEMORY_FAILURE_TOAST_TITLE = "Memory";
const MEMORY_FAILURE_TOAST_MESSAGE = "Some memories couldn’t be processed.";

export function useMemoryFailureToast(input: {
  token: string;
  userId: string | undefined;
  workspaceId: string;
  failures: number;
}): void {
  const { userId, workspaceId, failures } = input;
  const { showToast, dismissToast } = useToast();
  const notified = useRef("");
  const id = `memory-failure:${userId ?? ""}:${workspaceId}`;
  useEffect(() => {
    if (failures === 0) {
      notified.current = "";
      dismissToast(id);

      return;
    }
    const signature = `${id}:${failures}`;
    if (notified.current === signature) {
      return;
    }
    notified.current = signature;
    showToast({
      id,
      title: MEMORY_FAILURE_TOAST_TITLE,
      tone: "warning",
      message: MEMORY_FAILURE_TOAST_MESSAGE,
    });
  }, [dismissToast, failures, id, showToast]);
  useEffect(
    () => () => {
      notified.current = "";
      dismissToast(id);
    },
    [dismissToast, id],
  );
}
