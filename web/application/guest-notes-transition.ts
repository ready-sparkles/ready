import { z } from "zod";

const GUEST_NOTES_HANDOFF_KEY = "readymeet-guest-notes-handoff";

export const GUEST_MEETING_REJOIN_DELAY_MS = 10_000;
const GUEST_NOTES_HANDOFF_MAX_AGE_MS = 60_000;

const guestNotesHandoffSchema = z.object({
  meetingId: z.string(),
  startedAt: z.number(),
});

export function writeGuestNotesHandoff(input: { meetingId: string; startedAt: number }): void {
  try {
    window.sessionStorage.setItem(GUEST_NOTES_HANDOFF_KEY, JSON.stringify(input));
  } catch (error) {
    if (error instanceof Error) {
      void error.message;
    }
    // Without a handoff, the destination shows the notes immediately.
  }
}

export function readGuestNotesHandoff(input: { meetingId: string; now: number }): number | null {
  try {
    const raw = window.sessionStorage.getItem(GUEST_NOTES_HANDOFF_KEY);
    if (raw === null) {
      return null;
    }

    const parsed = guestNotesHandoffSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }

    const value = parsed.data;
    const isMatchingHandoff =
      value.meetingId === input.meetingId &&
      value.startedAt <= input.now &&
      input.now - value.startedAt < GUEST_NOTES_HANDOFF_MAX_AGE_MS;

    return isMatchingHandoff ? value.startedAt : null;
  } catch (error) {
    if (error instanceof Error) {
      void error.message;
    }

    return null;
  }
}

export function clearGuestNotesHandoff(): void {
  try {
    window.sessionStorage.removeItem(GUEST_NOTES_HANDOFF_KEY);
  } catch (error) {
    if (error instanceof Error) {
      void error.message;
    }
    // Best-effort cleanup.
  }
}
