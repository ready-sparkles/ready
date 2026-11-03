import { MEETING_PREPARATION_FALLBACK_LINES, type MeetingPreparationPreview } from "@readymeet/shared";

import { WORKSPACE_END_MEETING_PREPARATION_KEY } from "./workspace-transition";

const END_MEETING_PREPARATION_POLL_MS = 500;

export function fallbackMeetingPreparationLines(): string[] {
  return [...MEETING_PREPARATION_FALLBACK_LINES];
}

type ModelMeetingPreparationDeck = {
  lines: string[];
  source: "model";
};

export function getModelMeetingPreparationDeck(preview: MeetingPreparationPreview): ModelMeetingPreparationDeck | null {
  return preview.status === "ready" && preview.source === "model" && preview.lines.length !== 0
    ? { lines: [...preview.lines], source: "model" }
    : null;
}

export function resolveMeetingPreparationPreview(preview: MeetingPreparationPreview): {
  isTerminal: boolean;
  modelDeck: ModelMeetingPreparationDeck | null;
} {
  return {
    isTerminal: preview.status === "ready",
    modelDeck: getModelMeetingPreparationDeck(preview),
  };
}

export async function waitForModelMeetingPreparationDeck(input: {
  load: (signal: AbortSignal) => Promise<MeetingPreparationPreview>;
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<ModelMeetingPreparationDeck | null> {
  const now = input.now ?? Date.now;
  const wait =
    input.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      }));
  const timeoutMs = input.timeoutMs;
  const deadline = now() + timeoutMs;
  const controller = new AbortController();
  const hardTimeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const poll = async (): Promise<ModelMeetingPreparationDeck | null> => {
      if (now() >= deadline) {
        return null;
      }
      try {
        const preview = await input.load(controller.signal);
        const resolution = resolveMeetingPreparationPreview(preview);
        if (resolution.modelDeck !== null) {
          return resolution.modelDeck;
        }
        if (resolution.isTerminal) {
          return null;
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        // A transient preview read should not cancel the end-meeting handoff.
      }

      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        return null;
      }
      await wait(Math.min(input.pollMs ?? END_MEETING_PREPARATION_POLL_MS, remainingMs));

      return poll();
    };

    return await poll();
  } finally {
    clearTimeout(hardTimeoutId);
  }
}

export function writeModelMeetingPreparationHandoff(
  ...args: [meetingId: string, deck: ModelMeetingPreparationDeck, userId: string]
): void {
  const [meetingId, deck, userId] = args;
  if (typeof window === "undefined") {
    return;
  }
  // Clear legacy plaintext handoffs; the workspace fetches this preview from the server.
  window.sessionStorage.removeItem(WORKSPACE_END_MEETING_PREPARATION_KEY);
  void deck;
  void meetingId;
  void userId;
}

export function readMeetingPreparationHandoff(...args: [meetingId: string, userId?: string]): string[] | null {
  const [meetingId, userId] = args;
  if (typeof window === "undefined") {
    return null;
  }
  window.sessionStorage.removeItem(WORKSPACE_END_MEETING_PREPARATION_KEY);
  void meetingId;
  void userId;

  return null;
}
