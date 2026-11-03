import type { Meeting, MeetingLink, User } from "@readymeet/shared";

import { createInstantMeeting } from "../../composition/api";

import { type AcquiredMeetingMedia, acquireMeetingMediaTracks, stopLocalTracks } from "./livekit";

/**
 * In-memory handoff between the "New meeting" click and the live meeting page.
 *
 * The goal is to start the slow work (camera/microphone acquisition, the
 * instant-meeting API call that also mints the LiveKit token) at click time and
 * carry the results across client-side navigation, so the meeting room can
 * connect and reveal the local tile without re-fetching or re-acquiring anything.
 * Everything here is a fast path only: consumers must keep working when no
 * handoff exists (hard refresh, guest links, direct URL visits).
 */

type MeetingLaunchHandoff = {
  meeting: Meeting;
  meetingLink: MeetingLink;
  code: string;
  user?: User;
  livekit: {
    token: string;
    wsUrl: string;
    roomName: string;
  };
  createdAt: number;
};

const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const HANDOFF_FRESH_MINUTES = 5;
const MINUTE_MS = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const HANDOFF_FRESH_MS = HANDOFF_FRESH_MINUTES * MINUTE_MS;
const UNCONSUMED_MEDIA_CLEANUP_MS = MINUTE_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PendingMedia = {
  promise: Promise<AcquiredMeetingMedia>;
  cleanupTimerId: ReturnType<typeof setTimeout> | null;
};

const meetingLaunchState = {
  pendingMedia: null as PendingMedia | null,
  pendingHandoff: null as MeetingLaunchHandoff | null,
  pendingLaunch: null as { key: string; promise: Promise<MeetingLaunchHandoff> } | null,
};

function scheduleUnconsumedMediaCleanup(entry: PendingMedia): PendingMedia {
  const entryWithTimer: PendingMedia = {
    ...entry,
    cleanupTimerId: setTimeout(() => {
      if (meetingLaunchState.pendingMedia === entryWithTimer) {
        meetingLaunchState.pendingMedia = null;
      }
      void (async () => {
        try {
          const media = await entryWithTimer.promise;
          stopLocalTracks(media.tracks);
        } catch (error) {
          void error;
        }
      })();
    }, UNCONSUMED_MEDIA_CLEANUP_MS),
  };
  meetingLaunchState.pendingMedia = entryWithTimer;

  return entryWithTimer;
}

/**
 * Starts acquiring camera + microphone immediately. Safe to call repeatedly;
 * concurrent callers share one acquisition. Tracks are stopped automatically
 * if nothing consumes them (e.g. the user abandons the launch).
 */
async function beginMeetingLaunchMedia(): Promise<AcquiredMeetingMedia> {
  if (meetingLaunchState.pendingMedia) {
    return meetingLaunchState.pendingMedia.promise;
  }

  const entry: PendingMedia = {
    promise: acquireMeetingMediaTracks(),
    cleanupTimerId: null,
  };
  scheduleUnconsumedMediaCleanup(entry);

  return entry.promise;
}

/**
 * Transfers ownership of the pre-acquired tracks to the caller, which becomes
 * responsible for publishing or stopping them.
 */
export function takeMeetingLaunchMedia(): Promise<AcquiredMeetingMedia> | null {
  const entry = meetingLaunchState.pendingMedia;
  if (!entry) {
    return null;
  }
  meetingLaunchState.pendingMedia = null;
  if (entry.cleanupTimerId !== null) {
    clearTimeout(entry.cleanupTimerId);
  }

  return entry.promise;
}

/** Stops any pre-acquired tracks that no longer have a consumer. */
export function cancelMeetingLaunchMedia(): void {
  const media = takeMeetingLaunchMedia();
  if (media) {
    void (async () => {
      try {
        const acquired = await media;
        stopLocalTracks(acquired.tracks);
      } catch (error) {
        void error;
      }
    })();
  }
}

function isValidInstantMeetingIdHint(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.length > 0 && UUID_PATTERN.test(value);
}

/**
 * Kicks off media acquisition and the instant-meeting creation together.
 * Concurrent callers (sidebar click, then the /meet page mount) share one
 * in-flight request so a double invocation can never create two meetings.
 */
export async function beginInstantMeetingLaunch(input: {
  token: string;
  existingMeetingId?: string | null;
  intent?: "standard" | "agent_intro";
}): Promise<MeetingLaunchHandoff> {
  const intent = input.intent ?? "standard";
  const key = `${input.token}:${intent}:${input.existingMeetingId ?? ""}`;
  if (meetingLaunchState.pendingLaunch?.key === key) {
    return meetingLaunchState.pendingLaunch.promise;
  }

  void beginMeetingLaunchMedia();

  const promise = (async (): Promise<MeetingLaunchHandoff> => {
    const response = await createInstantMeeting({
      token: input.token,
      input: {
        existingMeetingId: isValidInstantMeetingIdHint(input.existingMeetingId) ? input.existingMeetingId : undefined,
        intent,
      },
    });
    const handoff: MeetingLaunchHandoff = {
      meeting: response.meeting,
      meetingLink: response.meetingLink,
      code: response.meetingLink.code,
      user: response.user,
      livekit: response.livekit,
      createdAt: Date.now(),
    };
    meetingLaunchState.pendingHandoff = handoff;

    return handoff;
  })();
  meetingLaunchState.pendingLaunch = { key, promise };
  void (async () => {
    try {
      await promise;
    } catch (error) {
      void error;
      if (meetingLaunchState.pendingLaunch?.promise === promise) {
        meetingLaunchState.pendingLaunch = null;
      }
    }
  })();

  return promise;
}

export function clearInstantMeetingLaunch(): void {
  meetingLaunchState.pendingLaunch = null;
}

function isHandoffFresh(handoff: MeetingLaunchHandoff): boolean {
  return Date.now() - handoff.createdAt < HANDOFF_FRESH_MS;
}

/** Non-consuming lookup so the room page can render the meeting instantly. */
export function peekMeetingLaunchHandoff(code: string): MeetingLaunchHandoff | null {
  if (
    meetingLaunchState.pendingHandoff &&
    meetingLaunchState.pendingHandoff.code === code &&
    isHandoffFresh(meetingLaunchState.pendingHandoff)
  ) {
    return meetingLaunchState.pendingHandoff;
  }

  return null;
}

/** Consuming lookup used once by the connect pipeline for the LiveKit token. */
export function takeMeetingLaunchHandoff(meetingId: string): MeetingLaunchHandoff | null {
  const handoff = meetingLaunchState.pendingHandoff;
  if (!handoff || handoff.meeting.id !== meetingId) {
    return null;
  }
  meetingLaunchState.pendingHandoff = null;
  meetingLaunchState.pendingLaunch = null;

  return isHandoffFresh(handoff) ? handoff : null;
}
