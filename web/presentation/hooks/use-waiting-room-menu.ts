"use client";

import type { MeetingJoinRequest } from "@readymeet/shared";
import { useEffect, useMemo } from "react";

export function useWaitingRoomMenu(input: {
  scopeKey: string;
  /** @external waiting room menu enable flag */
  enabled: boolean;
  requests: Pick<MeetingJoinRequest, "id" | "requestedAt">[];
  setOpen: (open: boolean) => void;
}): void {
  const { scopeKey, enabled: isMenuEnabled, requests, setOpen } = input;
  const seen = useMemo(() => new Set<string>(), [scopeKey]);
  useEffect(() => {
    if (!isMenuEnabled || requests.length === 0) {
      setOpen(false);

      return;
    }
    const keys = requests.map((request) => `${request.id}:${request.requestedAt}`);
    const hasNewRequest = keys.some((key) => !seen.has(key));
    keys.forEach((key) => {
      seen.add(key);
    });
    if (hasNewRequest) {
      setOpen(true);
    }
  }, [isMenuEnabled, requests, setOpen, seen]);
}
