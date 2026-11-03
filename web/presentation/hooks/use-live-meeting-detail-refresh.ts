"use client";

import { type Room, RoomEvent } from "livekit-client";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";

import { getMeeting } from "../../composition/api";
import { createQueuedRefresh } from "../../domain/queued-refresh";
import type { MeetingDetailPayload } from "../../domain/types";

const ACTIVE_REFRESH_MS = 1500;
const IDLE_REFRESH_MS = 45_000;
const TRANSCRIPT_SETTLE_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

type LiveMeetingDetailRefreshInput = {
  token: string | undefined;
  meetingId: string | undefined;
  isEnabled: boolean;
  room: Room | null;
  finalTranscriptKey: string;
  setActiveHumanParticipants: Dispatch<
    SetStateAction<MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"]>
  >;
  setLiveTranscriptSegments: Dispatch<SetStateAction<MeetingDetailPayload["transcriptSegments"]>>;
  load?: typeof getMeeting;
};

/** Keep the transcript fallback fast during speech, not during an idle call. */
export function useLiveMeetingDetailRefresh(input: LiveMeetingDetailRefreshInput): void {
  const {
    token,
    meetingId,
    isEnabled,
    room,
    finalTranscriptKey,
    setActiveHumanParticipants,
    setLiveTranscriptSegments,
    load = getMeeting,
  } = input;
  const onFinalTranscript = useRef(() => {});
  useEffect(() => {
    if (
      !isEnabled ||
      token === undefined ||
      token === "" ||
      meetingId === undefined ||
      meetingId === "" ||
      room === null
    ) {
      return;
    }
    const request = { token, meetingId, room };
    const controller = new AbortController();
    const state = {
      timer: 0,
      dueAt: 0,
      activeUntil: 0,
    };
    const isAborted = () => controller.signal.aborted;
    const refresh = createQueuedRefresh(async () => {
      if (controller.signal.aborted) {
        return;
      }
      try {
        const detail = await load({
          token: request.token,
          meetingId: request.meetingId,
          options: { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) },
        });
        if (!isAborted()) {
          setActiveHumanParticipants(detail.meetingRuntime.activeHumanParticipants);
          setLiveTranscriptSegments(detail.transcriptSegments);
        }
      } catch (error) {
        // Best-effort transcript recovery; retry without a noisy call-level error.
        if (error instanceof Error && error.name === "AbortError" && isAborted()) {
          return;
        }
        const retryState = state;
        retryState.activeUntil = performance.now() + TRANSCRIPT_SETTLE_MS;
      } finally {
        const isActive = request.room.activeSpeakers.length !== 0 || performance.now() < state.activeUntil;
        schedule(isActive ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
      }
    });
    function schedule(delay: number) {
      if (controller.signal.aborted) {
        return;
      }
      const dueAt = performance.now() + delay;
      if (state.timer !== 0 && state.dueAt <= dueAt) {
        return;
      }
      window.clearTimeout(state.timer);
      state.dueAt = dueAt;
      state.timer = window.setTimeout(() => {
        state.timer = 0;
        void refresh();
      }, delay);
    }
    const onActivity = () => {
      // The database write can trail the final caption or participant event.
      state.activeUntil = performance.now() + TRANSCRIPT_SETTLE_MS;
      schedule(ACTIVE_REFRESH_MS);
    };
    onFinalTranscript.current = onActivity;
    room.on(RoomEvent.ActiveSpeakersChanged, onActivity);
    room.on(RoomEvent.ParticipantConnected, onActivity);
    room.on(RoomEvent.ParticipantDisconnected, onActivity);
    room.on(RoomEvent.ParticipantMetadataChanged, onActivity);
    room.on(RoomEvent.Reconnected, onActivity);
    void refresh();

    return () => {
      controller.abort();
      onFinalTranscript.current = () => {};
      window.clearTimeout(state.timer);
      room.off(RoomEvent.ActiveSpeakersChanged, onActivity);
      room.off(RoomEvent.ParticipantConnected, onActivity);
      room.off(RoomEvent.ParticipantDisconnected, onActivity);
      room.off(RoomEvent.ParticipantMetadataChanged, onActivity);
      room.off(RoomEvent.Reconnected, onActivity);
    };
  }, [token, meetingId, isEnabled, room, setActiveHumanParticipants, setLiveTranscriptSegments, load]);
  useEffect(() => {
    if (finalTranscriptKey.length !== 0) {
      onFinalTranscript.current();
    }
  }, [finalTranscriptKey]);
}
