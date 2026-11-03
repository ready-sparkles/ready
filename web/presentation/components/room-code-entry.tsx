"use client";

import {
  joinRequestRealtimeChannel,
  joinRequestRealtimePayloadSchema,
  type Meeting,
  type MeetingJoinRequest,
  type MeetingLink,
} from "@readymeet/shared";
import { type LocalTrack, type LocalVideoTrack, Track } from "livekit-client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  createMeetingJoinRequest,
  getApiErrorCode,
  getApiErrorMessage,
  getMeetingJoinRequestStatus,
  getMeetingLinkPrejoin,
  getPrivateBetaWaitlistEntry,
  joinPrivateBetaWaitlist,
  linkGuestSession,
  resolveMeetingLink,
  updateMediaPreferences,
} from "../../composition/api";
import { subscribeAndTrackRealtimeChannel } from "../../domain/realtime-subscription";
import type { AuthSession } from "../../domain/types";
import { hasWaitingMeetingEnded } from "../../domain/waiting-meeting-ended";
import {
  canToggleBackgroundBlur,
  createBackgroundBlurProcessor,
  isBackgroundBlurProcessorSupported,
  setLocalVideoTrackBackgroundBlur,
} from "../lib/background-blur";
import { type AcquiredMeetingMedia, acquireMeetingMediaTracks, stopLocalTracks } from "../lib/livekit";
import { peekMeetingLaunchHandoff } from "../lib/meeting-launch";
import { useBackgroundBlurPreference } from "../lib/use-background-blur-preference";
import { useCameraBlurReady } from "../lib/use-camera-blur-ready";

import { type StoredGuestSession, useAuth } from "./auth-provider";
import { useGuestRecognition, useRememberedGuestName } from "./guest-recognition";
import { BackgroundBlurIcon, CameraIcon, LiveMeetingPage, MicrophoneIcon } from "./live-meeting-page";
import { MeetingAuthMenu } from "./meeting-auth-menu";
import { MeetingDeviceDropdown, SpeakerIcon } from "./meeting-device-dropdown";
import { MeetingJoinIdentityPanel } from "./meeting-join-identity-panel";
import { MeetingPreviewVideo } from "./meeting-preview-video";
import { PrivateBetaApplicationModal } from "./private-beta-application-modal";
import { PublicTopbar } from "./public-topbar";
import { useRealtimeClient } from "./realtime-provider";

const ACTIVE_MEETING_KEY = "readymeet-active-meeting-id";
const WAITING_ROOM_MESSAGE = "Waiting for the host to let you in.";

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const MEETING_ENTER_FADE_DELAY_MS = 220;
const JOIN_REQUEST_REALTIME_MAX_ATTEMPTS = 3;
const JOIN_REQUEST_REALTIME_RETRY_BASE_MS = 500;
const JOIN_REQUEST_POLL_INITIAL_DELAY_MS = 1000;
const JOIN_REQUEST_POLL_WAITING_INTERVAL_MS = 2000;
const JOIN_REQUEST_POLL_ERROR_INTERVAL_MS = 4000;

const ROOM_CODE_ENTRY_COPY = {
  joinRequestSubscriptionsFailed: "Join-request subscriptions failed.",
  realtimeGuestJoinSubscriptionFailed: "[readymeet:realtime] Guest join request subscription failed.",
  cameraPreviewUnavailable: "Camera preview is not available in this browser.",
  cameraPreviewBlocked: "Camera and microphone preview is blocked.",
  meetingLinkOpenFailed: "This meeting link could not be opened.",
  couldNotAskToJoin: "Could not ask to join.",
  meetingEndedStatus: "The meeting has ended. You can join again when you’re ready.",
  preparingMeeting: "Preparing meeting...",
  waitingToBeAdmitted: "Waiting to be admitted",
  hostCanAdmitNow: "The host can admit you now.",
  waitingForHostToStart: "Waiting for the host to start this meeting.",
  requestDeclined: "Request declined",
  requestDeclinedDetail: "The host did not admit this request.",
  waitingOverlayHasAccount: "Do you already have an account?",
  waitingOverlayHostSignInLead: "If you are the host, please sign in",
  waitingOverlayHostSignInFollow: "to start this meeting.",
} as const;

function roomCodeEntryBackgroundBlurControlTitle(input: {
  isBackgroundBlurSupported: boolean;
  isBackgroundBlurEnabled: boolean;
}) {
  if (!canToggleBackgroundBlur(input)) {
    return "Background blur is not supported in this browser";
  }

  return input.isBackgroundBlurEnabled ? "Turn background blur off" : "Turn background blur on";
}

async function settleQuietly(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof Error)) {
      return;
    }
  }
}

async function readOrNull<T>(operation: Promise<T>) {
  try {
    return await operation;
  } catch (error) {
    if (!(error instanceof Error)) {
      return null;
    }

    return null;
  }
}

type PrejoinState = {
  meeting: Meeting | null;
  meetingLink: MeetingLink | null;
};

function isJoinRequestDeniedStatus(request: MeetingJoinRequest | null) {
  return request?.status === "denied" || request?.status === "revoked";
}

function requestFromGuestSession(guestSession: StoredGuestSession | null): MeetingJoinRequest | null {
  if (guestSession?.joinRequestId === undefined || guestSession.joinRequestId === "") {
    return null;
  }

  return {
    id: guestSession.joinRequestId,
    meetingLinkId: "",
    meetingId: guestSession.meetingId ?? null,
    userId: guestSession.user.id,
    displayName: guestSession.user.displayName,
    status: guestSession.status ?? "waiting",
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    decidedByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function resolveRoomCodeEntryActiveDeviceId(input: {
  selectedDeviceId: string | undefined;
  trackDeviceId: string | undefined;
  streamDeviceId: string | undefined;
}) {
  return input.selectedDeviceId ?? input.trackDeviceId ?? input.streamDeviceId ?? "";
}

function getRoomCodeEntryDeviceSelection(input: {
  mediaDevices: MediaDeviceInfo[];
  previewTracks: LocalTrack[];
  previewStream: MediaStream | null;
  previewVideoTrack: LocalVideoTrack | null;
  selectedAudioInputId: string | undefined;
  selectedVideoInputId: string | undefined;
  selectedAudioOutputId: string | undefined;
}) {
  const audioInputDevices = input.mediaDevices.filter(
    (device) => device.kind === "audioinput" && device.deviceId !== "",
  );
  const audioOutputDevices = input.mediaDevices.filter(
    (device) => device.kind === "audiooutput" && device.deviceId !== "",
  );
  const videoInputDevices = input.mediaDevices.filter(
    (device) => device.kind === "videoinput" && device.deviceId !== "",
  );
  const previewAudioTrack = input.previewTracks.find((track) => track.kind === Track.Kind.Audio);
  const activeAudioInputId = resolveRoomCodeEntryActiveDeviceId({
    selectedDeviceId: input.selectedAudioInputId,
    trackDeviceId: previewAudioTrack?.mediaStreamTrack.getSettings().deviceId,
    streamDeviceId: input.previewStream?.getAudioTracks()[0]?.getSettings().deviceId,
  });
  const activeVideoInputId = resolveRoomCodeEntryActiveDeviceId({
    selectedDeviceId: input.selectedVideoInputId,
    trackDeviceId: input.previewVideoTrack?.mediaStreamTrack.getSettings().deviceId,
    streamDeviceId: input.previewStream?.getVideoTracks()[0]?.getSettings().deviceId,
  });
  const activeAudioOutputId =
    input.selectedAudioOutputId ??
    audioOutputDevices.find((device) => device.deviceId === "default")?.deviceId ??
    audioOutputDevices[0]?.deviceId ??
    "";

  return {
    audioInputDevices,
    audioOutputDevices,
    videoInputDevices,
    activeAudioInputId,
    activeVideoInputId,
    activeAudioOutputId,
  };
}

function RoomCodeEntryLiveMeetingView(input: {
  meetingId: string;
  initialMeeting: Meeting | null;
  previewTracks: LocalTrack[];
  previewMediaErrors: Pick<AcquiredMeetingMedia, "audioError" | "videoError">;
  isCameraOn: boolean;
  isMicOn: boolean;
  isBackgroundBlurEnabled: boolean | undefined;
  activeAudioInputId: string;
  activeVideoInputId: string;
  activeAudioOutputId: string;
}) {
  return (
    <LiveMeetingPage
      meetingId={input.meetingId}
      initialMeeting={input.initialMeeting}
      initialMediaTracks={input.previewTracks.length !== 0 ? input.previewTracks : null}
      initialMediaErrors={input.previewMediaErrors}
      initialCameraEnabled={input.isCameraOn}
      initialMicEnabled={input.isMicOn}
      initialBackgroundBlurEnabled={input.isBackgroundBlurEnabled}
      initialAudioDeviceId={input.activeAudioInputId !== "" ? input.activeAudioInputId : undefined}
      initialVideoDeviceId={input.activeVideoInputId !== "" ? input.activeVideoInputId : undefined}
      initialAudioOutputDeviceId={input.activeAudioOutputId !== "" ? input.activeAudioOutputId : undefined}
    />
  );
}

function RoomCodeEntryHostPlanView(input: {
  roomName: string;
  fullSession: AuthSession | null;
  waitlistError: string | null;
  isWaitlistJoined: boolean;
  isJoiningWaitlist: boolean;
  onJoinWaitlist: () => void;
  onClose: () => void;
}) {
  return (
    <main className="meeting-join-shell" aria-label="Join meeting">
      <PublicTopbar
        className="meeting-join-public-topbar public-home-page-nav"
        surface="light"
        actions={
          input.fullSession ? (
            <div className="meeting-join-account">
              <span>{input.fullSession.user.displayName}</span>
            </div>
          ) : (
            <MeetingAuthMenu callbackUrl={`/${input.roomName}`} preferRememberedProvider />
          )
        }
      />
      <PrivateBetaApplicationModal
        error={input.waitlistError}
        isJoined={input.isWaitlistJoined}
        isJoining={input.isJoiningWaitlist}
        body="This meeting link isn't open yet. Ready is in private beta — join the waitlist to request access."
        joinLabel={input.fullSession ? undefined : "Sign in to join"}
        onJoin={input.onJoinWaitlist}
        onClose={input.onClose}
      />
    </main>
  );
}

function MeetingOpeningShell() {
  // Intentionally just the meeting-room background: opening a meeting should
  // feel like an instant fade to the room, not a loading screen.
  return <main className="meeting-opening-shell" aria-label="Opening meeting" />;
}

function setStreamTracksEnabled(input: { tracks: MediaStreamTrack[]; isEnabled: boolean }) {
  const mutableTracks = [...input.tracks];
  mutableTracks.forEach((_, index) => {
    const track = mutableTracks[index];
    if (track !== undefined) {
      track.enabled = input.isEnabled;
    }
  });
}

type JoinRequestUpdateInput = {
  nextRequest: MeetingJoinRequest;
  nextMeeting: Meeting | null;
  fullSession: AuthSession | null;
  roomGuestSession: StoredGuestSession | null;
  prejoinMeeting: Meeting | null;
  isMeetingEndedMarked: () => boolean;
  markJoinRequestMeetingEnded: () => void;
  setHasMeetingEnded: (value: boolean) => void;
  setJoinRequest: (value: MeetingJoinRequest | null) => void;
  setMeetingId: (value: string | null) => void;
  setInitialMeeting: (value: Meeting | null) => void;
  setHasEnteredMeeting: (value: boolean) => void;
  setHasActiveParticipants: (value: boolean) => void;
  setPrejoinMeeting: (value: Meeting | null) => void;
  setIsPrejoinReady: (value: boolean) => void;
  setErrorMessage: (value: string | null) => void;
  setDisplayName: (value: string) => void;
  clearGuestSession: () => void;
  setGuestSession: (value: StoredGuestSession) => void;
};

function applyMeetingEndedJoinRequestState(input: JoinRequestUpdateInput) {
  input.markJoinRequestMeetingEnded();
  input.setHasMeetingEnded(true);
  input.setJoinRequest(null);
  input.setMeetingId(null);
  input.setInitialMeeting(null);
  input.setHasEnteredMeeting(false);
  input.setHasActiveParticipants(false);
  input.setPrejoinMeeting(null);
  input.setIsPrejoinReady(true);
  input.setErrorMessage(null);
  if (input.fullSession === null && input.roomGuestSession !== null) {
    input.setDisplayName(input.roomGuestSession.user.displayName);
    input.clearGuestSession();
  }
}

function resolveAdmittedInitialMeeting(input: {
  nextMeeting: Meeting | null;
  prejoinMeeting: Meeting | null;
  meetingId: string;
}) {
  if (input.nextMeeting?.id === input.meetingId) {
    return input.nextMeeting;
  }
  if (input.prejoinMeeting?.id === input.meetingId) {
    return input.prejoinMeeting;
  }

  return null;
}

function applyJoinRequestStateUpdate(input: JoinRequestUpdateInput) {
  if (input.fullSession !== null && input.nextRequest.userId !== input.fullSession.user.id) {
    return;
  }
  if (input.isMeetingEndedMarked()) {
    return;
  }
  if (hasWaitingMeetingEnded({ request: input.nextRequest, meeting: input.nextMeeting })) {
    applyMeetingEndedJoinRequestState(input);

    return;
  }
  input.setJoinRequest(input.nextRequest);
  if (
    input.fullSession === null &&
    input.roomGuestSession !== null &&
    input.nextRequest.userId === input.roomGuestSession.user.id
  ) {
    input.setGuestSession({
      ...input.roomGuestSession,
      joinRequestId: input.nextRequest.id,
      meetingId: input.nextRequest.meetingId,
      status: input.nextRequest.status,
    });
  }
  if (
    input.nextRequest.status === "admitted" &&
    input.nextRequest.meetingId !== null &&
    input.nextRequest.meetingId !== ""
  ) {
    window.localStorage.setItem(ACTIVE_MEETING_KEY, input.nextRequest.meetingId);
    input.setInitialMeeting(
      resolveAdmittedInitialMeeting({
        nextMeeting: input.nextMeeting,
        prejoinMeeting: input.prejoinMeeting,
        meetingId: input.nextRequest.meetingId,
      }),
    );
    input.setMeetingId(input.nextRequest.meetingId);
  }
}

type RoomCodeEntryBootstrapInput = {
  roomName: string;
  fullSession: AuthSession | null;
  roomGuestSession: StoredGuestSession | null;
  hasRefreshedAuth: () => boolean;
  markAuthRefreshStarted: () => void;
  refreshSession: () => Promise<AuthSession | null>;
  router: ReturnType<typeof useRouter>;
  setRefreshedSession: (session: AuthSession) => void;
  setRetryCount: (updater: (current: number) => number) => void;
  clearGuestSession: () => void;
  setJoinRequest: (value: MeetingJoinRequest | null) => void;
  setInitialMeeting: (value: Meeting | null) => void;
  setMeetingId: (value: string | null) => void;
  setPrejoin: (value: PrejoinState) => void;
  setIsPrejoinReady: (value: boolean) => void;
  setHasActiveParticipants: (value: boolean) => void;
  setIsHostPlanRequired: (value: boolean) => void;
  setIsWaitlistJoined: (value: boolean) => void;
  setErrorMessage: (value: string | null) => void;
  resetBootstrapStart: () => void;
  markBootstrapFailed: () => void;
};

async function retryRoomCodeEntryWithRefreshedSession(input: RoomCodeEntryBootstrapInput) {
  input.markAuthRefreshStarted();
  const nextSession = await input.refreshSession();
  if (nextSession === null) {
    input.router.replace(`/login?callbackUrl=${encodeURIComponent(`/${input.roomName}`)}`);

    return;
  }
  input.setRefreshedSession(nextSession);
  input.resetBootstrapStart();
  input.setRetryCount((current) => current + 1);
}

async function linkRoomGuestSessionForFullUser(input: RoomCodeEntryBootstrapInput) {
  if (input.fullSession === null || input.roomGuestSession === null) {
    return;
  }
  if (input.roomGuestSession.joinRequestId === undefined || input.roomGuestSession.joinRequestId === "") {
    return;
  }
  const linked = await linkGuestSession({
    token: input.fullSession.token,
    guestToken: input.roomGuestSession.token,
  });
  input.setJoinRequest(linked.request ?? null);
  input.clearGuestSession();
}

async function resolveRoomCodeEntryForFullUser(input: RoomCodeEntryBootstrapInput) {
  if (input.fullSession === null) {
    return false;
  }
  try {
    const { meeting } = await resolveMeetingLink({ token: input.fullSession.token, code: input.roomName });
    window.localStorage.setItem(ACTIVE_MEETING_KEY, meeting.id);
    input.setInitialMeeting(meeting);
    input.setMeetingId(meeting.id);

    return true;
  } catch (nextError) {
    if (nextError instanceof ApiError && nextError.status === HTTP_STATUS_UNAUTHORIZED && !input.hasRefreshedAuth()) {
      await retryRoomCodeEntryWithRefreshedSession(input);

      return true;
    }
    const resolveErrorCode =
      nextError instanceof ApiError && nextError.status === HTTP_STATUS_FORBIDDEN ? getApiErrorCode(nextError) : null;
    if (resolveErrorCode !== "join_request_required" && resolveErrorCode !== "meeting_host_plan_required") {
      throw nextError;
    }

    return false;
  }
}

async function applyRoomCodeEntryPrejoinMetadata(input: RoomCodeEntryBootstrapInput) {
  const metadata = await getMeetingLinkPrejoin({
    code: input.roomName,
    token: input.fullSession?.token,
  });
  input.setPrejoin({
    meeting: metadata.meeting,
    meetingLink: metadata.meetingLink,
  });
  input.setIsPrejoinReady(true);
  input.setHasActiveParticipants(metadata.hasActiveParticipants);

  if (metadata.hostPlanRequired) {
    input.setIsHostPlanRequired(true);
    if (input.fullSession !== null) {
      const waitlistEntry = await readOrNull(getPrivateBetaWaitlistEntry(input.fullSession.token));
      input.setIsWaitlistJoined(Boolean(waitlistEntry));
    }

    return;
  }

  if (
    input.fullSession === null &&
    input.roomGuestSession?.status === "admitted" &&
    input.roomGuestSession.meetingId !== undefined &&
    input.roomGuestSession.meetingId !== null &&
    input.roomGuestSession.meetingId !== ""
  ) {
    if (metadata.meeting?.id === input.roomGuestSession.meetingId) {
      input.setInitialMeeting(metadata.meeting);
      input.setMeetingId(input.roomGuestSession.meetingId);
    } else {
      input.clearGuestSession();
    }
  }
}

type SubmitRoomCodeJoinRequestInput = {
  roomName: string;
  fullSession: AuthSession | null;
  displayName: string;
  isRecognitionAvailable: boolean;
  recognitionChoice: ReturnType<typeof useGuestRecognition>["choice"];
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  setPrejoin: (value: PrejoinState) => void;
  clearMeetingEnded: () => void;
  setJoinRequest: (value: MeetingJoinRequest | null) => void;
  setHasActiveParticipants: (value: boolean) => void;
  setGuestSession: (value: StoredGuestSession) => void;
  setInitialMeeting: (value: Meeting | null) => void;
  setMeetingId: (value: string | null) => void;
};

async function submitRoomCodeJoinRequest(input: SubmitRoomCodeJoinRequestInput) {
  const response = await createMeetingJoinRequest({
    code: input.roomName,
    token: input.fullSession?.token,
    displayName: input.fullSession ? undefined : input.displayName.trim(),
    recognition: input.fullSession || !input.isRecognitionAvailable ? undefined : input.recognitionChoice,
  });
  input.setPrejoin({
    meeting: response.meeting,
    meetingLink: response.meetingLink,
  });
  input.clearMeetingEnded();
  input.setJoinRequest(response.request);
  input.setHasActiveParticipants(response.hasActiveParticipants);

  if (response.guestSession) {
    input.setGuestSession({
      token: response.guestSession.token,
      expiresAt: response.guestSession.expiresAt,
      user: response.guestSession.user,
      joinRequestId: response.request.id,
      meetingId: response.request.meetingId,
      meetingLinkCode: input.roomName,
      status: response.request.status,
    });
  } else {
    await input.refreshRealtimeAuth("join-request-created");
  }

  if (
    response.request.status === "admitted" &&
    response.request.meetingId !== null &&
    response.request.meetingId !== ""
  ) {
    input.setInitialMeeting(response.meeting?.id === response.request.meetingId ? response.meeting : null);
    input.setMeetingId(response.request.meetingId);
  }
}

type RoomCodeEntryBootstrapHookInput = {
  roomName: string;
  fullSession: AuthSession | null;
  roomGuestSession: StoredGuestSession | null;
  isLoading: boolean;
  meetingId: string | null;
  initialMeeting: Meeting | null;
  hasBootstrapStarted: () => boolean;
  markBootstrapStarted: () => void;
  resetBootstrapStarted: () => void;
  hasAuthRefreshStarted: () => boolean;
  markAuthRefreshStarted: () => void;
  refreshSession: () => Promise<AuthSession | null>;
  router: ReturnType<typeof useRouter>;
  setRefreshedSession: (session: AuthSession) => void;
  setRetryCount: (updater: (current: number) => number) => void;
  clearGuestSession: () => void;
  setJoinRequest: (value: MeetingJoinRequest | null) => void;
  setInitialMeeting: (value: Meeting | null) => void;
  setMeetingId: (value: string | null) => void;
  setPrejoin: (value: PrejoinState) => void;
  setIsPrejoinReady: (value: boolean) => void;
  setHasActiveParticipants: (value: boolean) => void;
  setIsHostPlanRequired: (value: boolean) => void;
  setIsWaitlistJoined: (value: boolean) => void;
  setErrorMessage: (value: string | null) => void;
  retryCount: number;
};

function useRoomCodeEntryBootstrap({
  roomName,
  fullSession,
  roomGuestSession,
  isLoading,
  meetingId,
  initialMeeting,
  hasBootstrapStarted,
  markBootstrapStarted,
  resetBootstrapStarted,
  hasAuthRefreshStarted,
  markAuthRefreshStarted,
  refreshSession,
  router,
  setRefreshedSession,
  setRetryCount,
  clearGuestSession,
  setJoinRequest,
  setInitialMeeting,
  setMeetingId,
  setPrejoin,
  setIsPrejoinReady,
  setHasActiveParticipants,
  setIsHostPlanRequired,
  setIsWaitlistJoined,
  setErrorMessage,
  retryCount,
}: RoomCodeEntryBootstrapHookInput) {
  useEffect(() => {
    if (isLoading || hasBootstrapStarted()) {
      return;
    }

    if (meetingId !== null && meetingId !== "" && initialMeeting) {
      markBootstrapStarted();
      window.localStorage.setItem(ACTIVE_MEETING_KEY, meetingId);

      return;
    }

    markBootstrapStarted();
    setErrorMessage(null);
    setIsPrejoinReady(false);

    void runRoomCodeEntryBootstrap({
      roomName,
      fullSession,
      roomGuestSession,
      hasRefreshedAuth: hasAuthRefreshStarted,
      markAuthRefreshStarted,
      refreshSession,
      router,
      setRefreshedSession,
      setRetryCount,
      clearGuestSession,
      setJoinRequest,
      setInitialMeeting,
      setMeetingId,
      setPrejoin,
      setIsPrejoinReady,
      setHasActiveParticipants,
      setIsHostPlanRequired,
      setIsWaitlistJoined,
      setErrorMessage,
      resetBootstrapStart: resetBootstrapStarted,
      markBootstrapFailed: resetBootstrapStarted,
    });
  }, [
    clearGuestSession,
    fullSession,
    initialMeeting,
    isLoading,
    meetingId,
    refreshSession,
    retryCount,
    roomGuestSession?.meetingId,
    roomGuestSession?.status,
    roomGuestSession?.joinRequestId,
    roomGuestSession?.token,
    roomName,
    router,
  ]);
}

async function runRoomCodeEntryBootstrap(input: RoomCodeEntryBootstrapInput) {
  try {
    if (input.fullSession !== null) {
      await linkRoomGuestSessionForFullUser(input);
      const isResolved = await resolveRoomCodeEntryForFullUser(input);
      if (isResolved) {
        return;
      }
    }

    await applyRoomCodeEntryPrejoinMetadata(input);
  } catch (nextError) {
    input.markBootstrapFailed();
    if (nextError instanceof ApiError && nextError.status === HTTP_STATUS_NOT_FOUND) {
      input.router.replace("/login");

      return;
    }
    input.setErrorMessage(ROOM_CODE_ENTRY_COPY.meetingLinkOpenFailed);
  }
}

function useRoomCodeEntryPreviewBlur(fullSession: AuthSession | null) {
  const backgroundBlurProcessorRef = useRef<ReturnType<typeof createBackgroundBlurProcessor> | null>(null);
  const backgroundBlurUpdateRef = useRef<Promise<void>>(Promise.resolve());
  const { isBackgroundBlurEnabled, isBackgroundBlurPreferenceReady, setBackgroundBlurEnabled } =
    useBackgroundBlurPreference(fullSession?.token);
  const [isBackgroundBlurSupported, setIsBackgroundBlurSupported] = useState(false);
  const [previewVideoTrack, setPreviewVideoTrack] = useState<LocalVideoTrack | null>(null);

  useEffect(() => {
    setIsBackgroundBlurSupported(isBackgroundBlurProcessorSupported());
  }, []);

  const setBackgroundBlurEnabledAndPersist = useCallback(
    (isEnabled: boolean) => {
      setBackgroundBlurEnabled(isEnabled);
      if (fullSession) {
        void settleQuietly(
          updateMediaPreferences({ token: fullSession.token, input: { backgroundBlurEnabled: isEnabled } }),
        );
      }
    },
    [fullSession, setBackgroundBlurEnabled],
  );

  const getBackgroundBlurProcessor = useCallback(() => {
    backgroundBlurProcessorRef.current ??= createBackgroundBlurProcessor();

    return backgroundBlurProcessorRef.current;
  }, []);

  return {
    isBackgroundBlurPreferenceReady,
    isBackgroundBlurEnabled,
    isBackgroundBlurSupported,
    previewVideoTrack,
    setPreviewVideoTrack,
    setBackgroundBlurEnabledAndPersist,
    getBackgroundBlurProcessor,
    backgroundBlurUpdateRef,
  };
}

function useRoomCodeEntryPreviewDeviceList(input: {
  previewStream: MediaStream | null;
  setMediaDevices: (devices: MediaDeviceInfo[]) => void;
}) {
  const { previewStream, setMediaDevices } = input;

  useEffect(() => {
    // Device labels are only readable once the preview has permission.
    if (previewStream === null) {
      return;
    }

    const cancelled = { isCancelled: false };
    const refreshDevices = () => {
      void (async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled.isCancelled) {
            setMediaDevices(devices);
          }
        } catch (error) {
          // best-effort: keep the previous device list
          if (!(error instanceof Error)) {
            return;
          }
        }
      })();
    };

    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);

    return () => {
      cancelled.isCancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
    };
  }, [previewStream, setMediaDevices]);
}

function useRoomCodeEntryPreviewBackgroundBlur(input: {
  previewVideoTrack: LocalVideoTrack | null;
  hasEnteredMeeting: boolean;
  isBackgroundBlurEnabled: boolean;
  setPreviewError: (value: string | null) => void;
  getBackgroundBlurProcessor: () => ReturnType<typeof createBackgroundBlurProcessor>;
  backgroundBlurUpdateRef: { current: Promise<void> };
}) {
  const {
    previewVideoTrack,
    hasEnteredMeeting,
    isBackgroundBlurEnabled,
    setPreviewError,
    getBackgroundBlurProcessor,
    backgroundBlurUpdateRef,
  } = input;

  useEffect(() => {
    if (!previewVideoTrack || hasEnteredMeeting) {
      return;
    }

    const cancelled = { isCancelled: false };
    const isCancelled = () => cancelled.isCancelled;
    // Toggle processing on the existing track. Reacquiring media here would
    // unmount the video and replace it with the placeholder on every toggle.
    // Serialize changes so a slow enable cannot finish after a later disable.
    const previousBlurUpdate = backgroundBlurUpdateRef.current;
    backgroundBlurUpdateRef.current = (async () => {
      await previousBlurUpdate;
      if (isCancelled()) {
        return;
      }
      try {
        await setLocalVideoTrackBackgroundBlur({
          track: previewVideoTrack,
          processor: getBackgroundBlurProcessor(),
          isEnabled: isBackgroundBlurEnabled,
        });
        if (!isCancelled()) {
          setPreviewError(null);
        }
      } catch (error) {
        if (!isCancelled()) {
          setPreviewError(error instanceof Error ? error.message : ROOM_CODE_ENTRY_COPY.cameraPreviewBlocked);
        }
        if (!(error instanceof Error)) {
          return;
        }
      }
    })();

    return () => {
      cancelled.isCancelled = true;
    };
  }, [
    backgroundBlurUpdateRef,
    getBackgroundBlurProcessor,
    hasEnteredMeeting,
    isBackgroundBlurEnabled,
    setPreviewError,
    previewVideoTrack,
  ]);
}

function useRoomCodeEntryPreviewMediaAcquisition(input: {
  shouldUsePreview: boolean;
  selectedAudioInputId: string | undefined;
  selectedVideoInputId: string | undefined;
  setPreviewTracks: (tracks: LocalTrack[]) => void;
  setPreviewMediaErrors: (errors: Pick<AcquiredMeetingMedia, "audioError" | "videoError">) => void;
  setPreviewVideoTrack: (track: LocalVideoTrack | null) => void;
  setPreviewStream: (stream: MediaStream | null) => void;
  setPreviewError: (error: string | null) => void;
}) {
  const {
    shouldUsePreview,
    selectedAudioInputId,
    selectedVideoInputId,
    setPreviewTracks,
    setPreviewMediaErrors,
    setPreviewVideoTrack,
    setPreviewStream,
    setPreviewError,
  } = input;

  useEffect(() => {
    const acquired: { tracks: LocalTrack[] } = { tracks: [] };
    const cancelled = { isCancelled: false };

    if (!shouldUsePreview) {
      setPreviewTracks([]);
      setPreviewMediaErrors({ audioError: null, videoError: null });
      setPreviewVideoTrack(null);
      setPreviewStream(null);
      setPreviewError(null);

      return;
    }

    // A new attempt owns a fresh, internally consistent handoff. The previous
    // effect cleanup stops its tracks, so remove those tracks and their errors
    // together before admission can pass them to the live room.
    setPreviewTracks([]);
    setPreviewMediaErrors({ audioError: null, videoError: null });
    setPreviewVideoTrack(null);
    setPreviewStream(null);
    setPreviewError(null);

    void (async () => {
      try {
        const media = await acquireMeetingMediaTracks({
          audioDeviceId: selectedAudioInputId,
          videoDeviceId: selectedVideoInputId,
        });
        if (cancelled.isCancelled) {
          stopLocalTracks(media.tracks);

          return;
        }

        acquired.tracks = media.tracks;
        setPreviewMediaErrors({ audioError: media.audioError, videoError: media.videoError });
        const nextVideoTrack =
          media.tracks.find(
            (track): track is LocalVideoTrack => track.kind === Track.Kind.Video && "setProcessor" in track,
          ) ?? null;

        const nextStream = new MediaStream(media.tracks.map((track) => track.mediaStreamTrack));
        setPreviewTracks(media.tracks);
        setPreviewVideoTrack(nextVideoTrack);
        setPreviewStream(nextStream);
        setPreviewError(null);
      } catch (error) {
        if (!cancelled.isCancelled) {
          // Per-device acquisition failures are already retained from the
          // resolved media result above. A later preview/processor failure is
          // not evidence that both devices failed, so do not overwrite those
          // original errors with a synthetic dual-device error.
          setPreviewError(ROOM_CODE_ENTRY_COPY.cameraPreviewBlocked);
        }
        if (!(error instanceof Error)) {
          return;
        }
      }
    })();

    return () => {
      cancelled.isCancelled = true;
      stopLocalTracks(acquired.tracks);
    };
  }, [
    selectedAudioInputId,
    selectedVideoInputId,
    setPreviewError,
    setPreviewMediaErrors,
    setPreviewStream,
    setPreviewTracks,
    setPreviewVideoTrack,
    shouldUsePreview,
  ]);
}

function useRoomCodeEntryPreviewEnterMeeting(input: {
  meetingId: string | null;
  hasEnteredMeeting: boolean;
  shouldShowPrejoin: boolean;
  setHasEnteredMeeting: (value: boolean) => void;
}) {
  const { meetingId, hasEnteredMeeting, shouldShowPrejoin, setHasEnteredMeeting } = input;

  useEffect(() => {
    if (meetingId === null || meetingId === "" || hasEnteredMeeting) {
      return;
    }

    if (!shouldShowPrejoin) {
      setHasEnteredMeeting(true);

      return;
    }

    const timeout = window.setTimeout(() => {
      setHasEnteredMeeting(true);
    }, MEETING_ENTER_FADE_DELAY_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [hasEnteredMeeting, meetingId, shouldShowPrejoin, setHasEnteredMeeting]);
}

function useRoomCodeEntryPreviewTracks(input: {
  meetingId: string | null;
  hasEnteredMeeting: boolean;
  shouldUsePreview: boolean;
  shouldShowPrejoin: boolean;
  setHasEnteredMeeting: (value: boolean) => void;
  isBackgroundBlurEnabled: boolean;
  previewVideoTrack: LocalVideoTrack | null;
  setPreviewVideoTrack: (value: LocalVideoTrack | null) => void;
  getBackgroundBlurProcessor: () => ReturnType<typeof createBackgroundBlurProcessor>;
  backgroundBlurUpdateRef: { current: Promise<void> };
}) {
  const {
    meetingId,
    hasEnteredMeeting,
    shouldUsePreview,
    shouldShowPrejoin,
    setHasEnteredMeeting,
    isBackgroundBlurEnabled,
    previewVideoTrack,
    setPreviewVideoTrack,
    getBackgroundBlurProcessor,
    backgroundBlurUpdateRef,
  } = input;

  const isBlurReady = useCameraBlurReady(previewVideoTrack);
  const [previewTracks, setPreviewTracks] = useState<LocalTrack[]>([]);
  const [previewMediaErrors, setPreviewMediaErrors] = useState<Pick<AcquiredMeetingMedia, "audioError" | "videoError">>(
    {
      audioError: null,
      videoError: null,
    },
  );
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [mediaDevices, setMediaDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState<string | undefined>();
  const [selectedVideoInputId, setSelectedVideoInputId] = useState<string | undefined>();
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState<string | undefined>();

  useRoomCodeEntryPreviewEnterMeeting({
    meetingId,
    hasEnteredMeeting,
    shouldShowPrejoin,
    setHasEnteredMeeting,
  });

  useRoomCodeEntryPreviewMediaAcquisition({
    shouldUsePreview,
    selectedAudioInputId,
    selectedVideoInputId,
    setPreviewTracks,
    setPreviewMediaErrors,
    setPreviewVideoTrack,
    setPreviewStream,
    setPreviewError,
  });

  useRoomCodeEntryPreviewBackgroundBlur({
    previewVideoTrack,
    hasEnteredMeeting,
    isBackgroundBlurEnabled,
    setPreviewError,
    getBackgroundBlurProcessor,
    backgroundBlurUpdateRef,
  });

  useEffect(() => {
    setStreamTracksEnabled({ tracks: [...(previewStream?.getVideoTracks() ?? [])], isEnabled: isCameraOn });
  }, [isCameraOn, previewStream]);

  useEffect(() => {
    setStreamTracksEnabled({ tracks: [...(previewStream?.getAudioTracks() ?? [])], isEnabled: isMicOn });
  }, [isMicOn, previewStream]);

  useRoomCodeEntryPreviewDeviceList({ previewStream, setMediaDevices });

  return {
    previewTracks,
    previewMediaErrors,
    previewStream:
      isBackgroundBlurEnabled && (!isBlurReady || !previewVideoTrack?.getProcessor()) ? null : previewStream,
    previewError,
    isCameraOn,
    setIsCameraOn,
    isMicOn,
    setIsMicOn,
    mediaDevices,
    selectedAudioInputId,
    setSelectedAudioInputId,
    selectedVideoInputId,
    setSelectedVideoInputId,
    selectedAudioOutputId,
    setSelectedAudioOutputId,
  };
}

function useRoomCodeEntryPreviewMedia(input: {
  fullSession: AuthSession | null;
  meetingId: string | null;
  hasEnteredMeeting: boolean;
  shouldUsePreview: boolean;
  shouldShowPrejoin: boolean;
  setHasEnteredMeeting: (value: boolean) => void;
}) {
  const blur = useRoomCodeEntryPreviewBlur(input.fullSession);
  const tracks = useRoomCodeEntryPreviewTracks({
    meetingId: input.meetingId,
    hasEnteredMeeting: input.hasEnteredMeeting,
    shouldUsePreview: input.shouldUsePreview,
    shouldShowPrejoin: input.shouldShowPrejoin,
    setHasEnteredMeeting: input.setHasEnteredMeeting,
    isBackgroundBlurEnabled: blur.isBackgroundBlurEnabled,
    previewVideoTrack: blur.previewVideoTrack,
    setPreviewVideoTrack: blur.setPreviewVideoTrack,
    getBackgroundBlurProcessor: blur.getBackgroundBlurProcessor,
    backgroundBlurUpdateRef: blur.backgroundBlurUpdateRef,
  });

  return {
    ...blur,
    ...tracks,
    previewStream: blur.isBackgroundBlurPreferenceReady ? tracks.previewStream : null,
  };
}

function RoomCodeEntryPrejoinWaitingOverlay(props: {
  roomName: string;
  fullSession: AuthSession | null;
  previewStream: MediaStream | null;
  isCameraOn: boolean;
  previewVideoTrack: LocalVideoTrack | null;
  isBackgroundBlurEnabled: boolean;
  displayName: string;
  waitingJoinRequest: MeetingJoinRequest | null;
  hasActiveParticipants: boolean;
  meetingId: string | null;
}) {
  const {
    roomName,
    fullSession,
    previewStream,
    isCameraOn,
    previewVideoTrack,
    isBackgroundBlurEnabled,
    displayName,
    waitingJoinRequest,
    hasActiveParticipants,
    meetingId,
  } = props;

  return (
    <section className="meeting-join-waiting-overlay" aria-live="polite" aria-label="Waiting for host">
      <div className="meeting-join-waiting-content">
        <div className="meeting-join-waiting-preview">
          {previewStream !== null && isCameraOn ? (
            <MeetingPreviewVideo
              stream={previewStream}
              track={previewVideoTrack}
              showProcessed={isBackgroundBlurEnabled}
              placeholder={
                <div className="meeting-join-preview-placeholder">
                  <span>{fullSession?.user.displayName[0] ?? displayName.trim()[0] ?? "R"}</span>
                </div>
              }
              className="meeting-join-waiting-video"
            />
          ) : (
            <div className="meeting-join-waiting-preview-placeholder">
              <span>
                {fullSession?.user.displayName[0] ?? waitingJoinRequest?.displayName[0] ?? displayName.trim()[0] ?? "R"}
              </span>
            </div>
          )}
        </div>
        <div className="live-end-meeting-step-text-shell meeting-join-waiting-text-shell">
          <p className="live-end-meeting-step-text meeting-join-waiting-text" aria-label={WAITING_ROOM_MESSAGE}>
            <span className="live-end-meeting-step-shimmer" data-text={WAITING_ROOM_MESSAGE} aria-hidden="true">
              {WAITING_ROOM_MESSAGE}
            </span>
          </p>
        </div>
        {fullSession === null ? (
          <div className="meeting-join-waiting-signin">
            <span>
              {hasActiveParticipants ? (
                ROOM_CODE_ENTRY_COPY.waitingOverlayHasAccount
              ) : (
                <>
                  {ROOM_CODE_ENTRY_COPY.waitingOverlayHostSignInLead}
                  <br />
                  {ROOM_CODE_ENTRY_COPY.waitingOverlayHostSignInFollow}
                </>
              )}
            </span>
            <MeetingAuthMenu
              buttonLabel="Sign in"
              preferRememberedProvider
              callbackUrl={`/${roomName}`}
              disabled={meetingId !== null && meetingId !== "" ? true : false}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RoomCodeEntryPrejoinPreviewStage(props: {
  fullSession: AuthSession | null;
  previewStream: MediaStream | null;
  isCameraOn: boolean;
  previewVideoTrack: LocalVideoTrack | null;
  isBackgroundBlurEnabled: boolean;
  displayName: string;
  isMicOn: boolean;
  setIsMicOn: (updater: (isMicEnabled: boolean) => boolean) => void;
  setIsCameraOn: (updater: (isCameraEnabled: boolean) => boolean) => void;
  setBackgroundBlurEnabledAndPersist: (isEnabled: boolean) => void;
  isBackgroundBlurSupported: boolean;
}) {
  const {
    fullSession,
    previewStream,
    isCameraOn,
    previewVideoTrack,
    isBackgroundBlurEnabled,
    displayName,
    isMicOn,
    setIsMicOn,
    setIsCameraOn,
    setBackgroundBlurEnabledAndPersist,
    isBackgroundBlurSupported,
  } = props;

  const initial = fullSession?.user.displayName[0] ?? displayName.trim()[0] ?? "R";

  return (
    <div className="meeting-join-preview">
      {previewStream && isCameraOn ? (
        <MeetingPreviewVideo
          stream={previewStream}
          track={previewVideoTrack}
          showProcessed={isBackgroundBlurEnabled}
          placeholder={
            <div className="meeting-join-preview-placeholder">
              <span>{initial}</span>
            </div>
          }
          className="meeting-join-video"
        />
      ) : (
        <div className="meeting-join-preview-placeholder">
          <span>{initial}</span>
        </div>
      )}
      <div className="meeting-join-preview-controls" aria-label="Preview controls">
        <button
          className={isMicOn ? "meeting-join-media-button" : "meeting-join-media-button is-off"}
          type="button"
          onClick={() => setIsMicOn((isMicEnabled) => !isMicEnabled)}
          aria-label={isMicOn ? "Turn off microphone" : "Turn on microphone"}
          title={isMicOn ? "Turn off microphone" : "Turn on microphone"}
        >
          <MicrophoneIcon isEnabled={isMicOn} />
        </button>
        <button
          className={isCameraOn ? "meeting-join-media-button" : "meeting-join-media-button is-off"}
          type="button"
          onClick={() => setIsCameraOn((isCameraEnabled) => !isCameraEnabled)}
          aria-label={isCameraOn ? "Turn off camera" : "Turn on camera"}
          title={isCameraOn ? "Turn off camera" : "Turn on camera"}
        >
          <CameraIcon isEnabled={isCameraOn} />
        </button>
      </div>
      <button
        className={`meeting-join-media-button meeting-join-background-blur-button${isBackgroundBlurEnabled ? " is-active" : ""}`}
        type="button"
        onClick={() => setBackgroundBlurEnabledAndPersist(!isBackgroundBlurEnabled)}
        disabled={!canToggleBackgroundBlur({ isBackgroundBlurEnabled, isBackgroundBlurSupported })}
        aria-pressed={isBackgroundBlurEnabled}
        aria-label={isBackgroundBlurEnabled ? "Turn background blur off" : "Turn background blur on"}
        title={roomCodeEntryBackgroundBlurControlTitle({
          isBackgroundBlurSupported,
          isBackgroundBlurEnabled,
        })}
      >
        <BackgroundBlurIcon isEnabled={isBackgroundBlurEnabled} />
      </button>
    </div>
  );
}

function RoomCodeEntryPrejoinDeviceRow(props: {
  previewError: string | null;
  audioInputDevices: MediaDeviceInfo[];
  audioOutputDevices: MediaDeviceInfo[];
  videoInputDevices: MediaDeviceInfo[];
  activeAudioInputId: string;
  activeAudioOutputId: string;
  activeVideoInputId: string;
  setSelectedAudioInputId: (value: string | undefined) => void;
  setSelectedAudioOutputId: (value: string | undefined) => void;
  setSelectedVideoInputId: (value: string | undefined) => void;
}) {
  const {
    previewError,
    audioInputDevices,
    audioOutputDevices,
    videoInputDevices,
    activeAudioInputId,
    activeAudioOutputId,
    activeVideoInputId,
    setSelectedAudioInputId,
    setSelectedAudioOutputId,
    setSelectedVideoInputId,
  } = props;

  return (
    <div className="meeting-join-device-row" aria-label="Device selection">
      {previewError !== null ? (
        <span className="meeting-join-device-status">{previewError}</span>
      ) : (
        <>
          <MeetingDeviceDropdown
            ariaLabel="Microphone"
            devices={audioInputDevices}
            fallbackLabel="Microphone"
            icon={<MicrophoneIcon isEnabled />}
            value={activeAudioInputId}
            onChange={setSelectedAudioInputId}
            disabled={audioInputDevices.length === 0}
          />
          {audioOutputDevices.length !== 0 ? (
            <MeetingDeviceDropdown
              ariaLabel="Speaker"
              devices={audioOutputDevices}
              fallbackLabel="Speaker"
              icon={<SpeakerIcon />}
              value={activeAudioOutputId}
              onChange={setSelectedAudioOutputId}
            />
          ) : null}
          <MeetingDeviceDropdown
            ariaLabel="Camera"
            devices={videoInputDevices}
            fallbackLabel="Camera"
            icon={<CameraIcon isEnabled />}
            value={activeVideoInputId}
            onChange={setSelectedVideoInputId}
            disabled={videoInputDevices.length === 0}
          />
        </>
      )}
    </div>
  );
}

function RoomCodeEntryPrejoinWaitingStatus(props: { waitingJoinRequest: MeetingJoinRequest | null; title: string }) {
  const { waitingJoinRequest, title } = props;
  const isHostReady =
    waitingJoinRequest?.meetingId !== null &&
    waitingJoinRequest?.meetingId !== undefined &&
    waitingJoinRequest.meetingId !== "";

  return (
    <div className="meeting-join-status">
      <h1>{ROOM_CODE_ENTRY_COPY.waitingToBeAdmitted}</h1>
      <p>{isHostReady ? ROOM_CODE_ENTRY_COPY.hostCanAdmitNow : ROOM_CODE_ENTRY_COPY.waitingForHostToStart}</p>
      <div className="meeting-join-waiting-name">
        <span>{waitingJoinRequest?.displayName[0]?.toUpperCase()}</span>
        <div>
          <strong>{waitingJoinRequest?.displayName}</strong>
          <small>{title}</small>
        </div>
      </div>
    </div>
  );
}

function RoomCodeEntryPrejoinJoinPanel(props: {
  fullSession: AuthSession | null;
  displayName: string;
  setDisplayName: (value: string) => void;
  hasMeetingEnded: boolean;
  isLoading: boolean;
  prejoinMeetingLink: MeetingLink | null;
  errorMessage: string | null;
  isWaiting: boolean;
  waitingJoinRequest: MeetingJoinRequest | null;
  title: string;
  isDenied: boolean;
  recognition: ReturnType<typeof useGuestRecognition>;
  isAskingToJoin: boolean;
  canAskToJoin: boolean;
  handleAskToJoin: () => void;
}) {
  const {
    fullSession,
    displayName,
    setDisplayName,
    hasMeetingEnded,
    isLoading,
    prejoinMeetingLink,
    errorMessage,
    isWaiting,
    waitingJoinRequest,
    title,
    isDenied,
    recognition,
    isAskingToJoin,
    canAskToJoin,
    handleAskToJoin,
  } = props;

  return (
    <aside className="meeting-join-panel">
      {hasMeetingEnded ? <p role="status">{ROOM_CODE_ENTRY_COPY.meetingEndedStatus}</p> : null}
      {isLoading || (prejoinMeetingLink === null && errorMessage === null) ? (
        <div className="meeting-join-status">
          <h1>{ROOM_CODE_ENTRY_COPY.preparingMeeting}</h1>
        </div>
      ) : isWaiting ? (
        <RoomCodeEntryPrejoinWaitingStatus waitingJoinRequest={waitingJoinRequest} title={title} />
      ) : isDenied ? (
        <div className="meeting-join-status">
          <h1>{ROOM_CODE_ENTRY_COPY.requestDeclined}</h1>
          <p>{ROOM_CODE_ENTRY_COPY.requestDeclinedDetail}</p>
        </div>
      ) : (
        <MeetingJoinIdentityPanel
          user={fullSession?.user ?? null}
          displayName={displayName}
          onDisplayNameChange={setDisplayName}
          recognition={recognition}
          isAskingToJoin={isAskingToJoin}
          canAskToJoin={canAskToJoin}
          onAskToJoin={handleAskToJoin}
        />
      )}

      {errorMessage !== null ? <p className="meeting-join-error">{errorMessage}</p> : null}
    </aside>
  );
}

type RoomCodeEntryPrejoinViewProps = {
  roomName: string;
  fullSession: AuthSession | null;
  isJoinWaitingExperienceActive: boolean;
  previewStream: MediaStream | null;
  isCameraOn: boolean;
  previewVideoTrack: LocalVideoTrack | null;
  isBackgroundBlurEnabled: boolean;
  displayName: string;
  setDisplayName: (value: string) => void;
  isMicOn: boolean;
  setIsMicOn: (updater: (isMicEnabled: boolean) => boolean) => void;
  setIsCameraOn: (updater: (isCameraEnabled: boolean) => boolean) => void;
  setBackgroundBlurEnabledAndPersist: (isEnabled: boolean) => void;
  isBackgroundBlurSupported: boolean;
  previewError: string | null;
  audioInputDevices: MediaDeviceInfo[];
  audioOutputDevices: MediaDeviceInfo[];
  videoInputDevices: MediaDeviceInfo[];
  activeAudioInputId: string;
  activeAudioOutputId: string;
  activeVideoInputId: string;
  setSelectedAudioInputId: (value: string | undefined) => void;
  setSelectedAudioOutputId: (value: string | undefined) => void;
  setSelectedVideoInputId: (value: string | undefined) => void;
  hasMeetingEnded: boolean;
  isLoading: boolean;
  prejoinMeetingLink: MeetingLink | null;
  errorMessage: string | null;
  isWaiting: boolean;
  waitingJoinRequest: MeetingJoinRequest | null;
  title: string;
  isDenied: boolean;
  recognition: ReturnType<typeof useGuestRecognition>;
  isAskingToJoin: boolean;
  canAskToJoin: boolean;
  handleAskToJoin: () => void;
  hasActiveParticipants: boolean;
  meetingId: string | null;
};

function RoomCodeEntryPrejoinAwaitingLayers(props: {
  roomName: string;
  fullSession: AuthSession | null;
  isJoinWaitingExperienceActive: boolean;
  previewStream: MediaStream | null;
  isCameraOn: boolean;
  previewVideoTrack: LocalVideoTrack | null;
  isBackgroundBlurEnabled: boolean;
  displayName: string;
  waitingJoinRequest: MeetingJoinRequest | null;
  hasActiveParticipants: boolean;
  meetingId: string | null;
}) {
  const {
    roomName,
    fullSession,
    isJoinWaitingExperienceActive,
    previewStream,
    isCameraOn,
    previewVideoTrack,
    isBackgroundBlurEnabled,
    displayName,
    waitingJoinRequest,
    hasActiveParticipants,
    meetingId,
  } = props;

  return (
    <>
      {isJoinWaitingExperienceActive ? (
        <RoomCodeEntryPrejoinWaitingOverlay
          roomName={roomName}
          fullSession={fullSession}
          previewStream={previewStream}
          isCameraOn={isCameraOn}
          previewVideoTrack={previewVideoTrack}
          isBackgroundBlurEnabled={isBackgroundBlurEnabled}
          displayName={displayName}
          waitingJoinRequest={waitingJoinRequest}
          hasActiveParticipants={hasActiveParticipants}
          meetingId={meetingId}
        />
      ) : null}
      {meetingId !== null && meetingId !== "" ? <div className="meeting-join-dark-fade" aria-hidden="true" /> : null}
    </>
  );
}

function RoomCodeEntryPrejoinTopbar(props: {
  roomName: string;
  fullSession: AuthSession | null;
  isJoinWaitingExperienceActive: boolean;
}) {
  const { roomName, fullSession, isJoinWaitingExperienceActive } = props;

  return (
    <PublicTopbar
      className="meeting-join-public-topbar public-home-page-nav"
      surface="light"
      ariaHidden={isJoinWaitingExperienceActive}
      actions={
        fullSession ? (
          <div className="meeting-join-account">
            <span>{fullSession.user.displayName}</span>
          </div>
        ) : (
          <MeetingAuthMenu callbackUrl={`/${roomName}`} preferRememberedProvider />
        )
      }
    />
  );
}

function RoomCodeEntryPrejoinMain(props: RoomCodeEntryPrejoinViewProps) {
  const { isJoinWaitingExperienceActive } = props;

  return (
    <section className="meeting-join-main" aria-hidden={isJoinWaitingExperienceActive}>
      <div className="meeting-join-preview-area">
        <RoomCodeEntryPrejoinPreviewStage
          fullSession={props.fullSession}
          previewStream={props.previewStream}
          isCameraOn={props.isCameraOn}
          previewVideoTrack={props.previewVideoTrack}
          isBackgroundBlurEnabled={props.isBackgroundBlurEnabled}
          displayName={props.displayName}
          isMicOn={props.isMicOn}
          setIsMicOn={props.setIsMicOn}
          setIsCameraOn={props.setIsCameraOn}
          setBackgroundBlurEnabledAndPersist={props.setBackgroundBlurEnabledAndPersist}
          isBackgroundBlurSupported={props.isBackgroundBlurSupported}
        />
        <RoomCodeEntryPrejoinDeviceRow
          previewError={props.previewError}
          audioInputDevices={props.audioInputDevices}
          audioOutputDevices={props.audioOutputDevices}
          videoInputDevices={props.videoInputDevices}
          activeAudioInputId={props.activeAudioInputId}
          activeAudioOutputId={props.activeAudioOutputId}
          activeVideoInputId={props.activeVideoInputId}
          setSelectedAudioInputId={props.setSelectedAudioInputId}
          setSelectedAudioOutputId={props.setSelectedAudioOutputId}
          setSelectedVideoInputId={props.setSelectedVideoInputId}
        />
      </div>

      <RoomCodeEntryPrejoinJoinPanel
        fullSession={props.fullSession}
        displayName={props.displayName}
        setDisplayName={props.setDisplayName}
        hasMeetingEnded={props.hasMeetingEnded}
        isLoading={props.isLoading}
        prejoinMeetingLink={props.prejoinMeetingLink}
        errorMessage={props.errorMessage}
        isWaiting={props.isWaiting}
        waitingJoinRequest={props.waitingJoinRequest}
        title={props.title}
        isDenied={props.isDenied}
        recognition={props.recognition}
        isAskingToJoin={props.isAskingToJoin}
        canAskToJoin={props.canAskToJoin}
        handleAskToJoin={props.handleAskToJoin}
      />
    </section>
  );
}

function RoomCodeEntryPrejoinView(props: RoomCodeEntryPrejoinViewProps) {
  const { roomName, fullSession, isJoinWaitingExperienceActive, hasActiveParticipants, meetingId } = props;

  return (
    <main
      className={`meeting-join-shell${isJoinWaitingExperienceActive ? " is-awaiting-admit" : ""}`}
      aria-label="Join meeting"
    >
      <RoomCodeEntryPrejoinTopbar
        roomName={roomName}
        fullSession={fullSession}
        isJoinWaitingExperienceActive={isJoinWaitingExperienceActive}
      />
      <RoomCodeEntryPrejoinMain {...props} />
      <RoomCodeEntryPrejoinAwaitingLayers
        roomName={roomName}
        fullSession={fullSession}
        isJoinWaitingExperienceActive={isJoinWaitingExperienceActive}
        previewStream={props.previewStream}
        isCameraOn={props.isCameraOn}
        previewVideoTrack={props.previewVideoTrack}
        isBackgroundBlurEnabled={props.isBackgroundBlurEnabled}
        displayName={props.displayName}
        waitingJoinRequest={props.waitingJoinRequest}
        hasActiveParticipants={hasActiveParticipants}
        meetingId={meetingId}
      />
    </main>
  );
}

function startRoomCodeEntryJoinRequestRealtimeSubscription(input: {
  realtimeClient: NonNullable<ReturnType<typeof useRealtimeClient>["client"]>;
  visibleJoinRequest: MeetingJoinRequest;
  prejoinMeetingLink: MeetingLink;
  onJoinRequestUpdate: (input: { nextRequest: MeetingJoinRequest; nextMeeting: Meeting | null }) => void;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
}) {
  // The Ably key only grants workspace-scoped names, so the legacy unscoped twin is always denied (40160).
  const channels = [
    joinRequestRealtimeChannel({
      workspaceId: input.prejoinMeetingLink.workspaceId,
      requestId: input.visibleJoinRequest.id,
    }),
  ].map((channelName) => input.realtimeClient.channels.get(channelName));

  const handleMessage = (message: { data?: unknown }) => {
    const parsed = joinRequestRealtimePayloadSchema.safeParse(message.data);
    if (!parsed.success || parsed.data.request.id !== input.visibleJoinRequest.id) {
      return;
    }

    input.onJoinRequestUpdate({ nextRequest: parsed.data.request, nextMeeting: parsed.data.meeting });
  };

  const subscribedChannels = new Set<(typeof channels)[number]>();
  const cancelled = { isCancelled: false };
  const retryTimeout: { id: number | null } = { id: null };

  const subscribe = async (attempt = 0) => {
    try {
      const results = await Promise.allSettled(
        channels.map(async (channel) => {
          await subscribeAndTrackRealtimeChannel({
            channel,
            subscribe: () => channel.subscribe(handleMessage),
            unsubscribe: () => channel.unsubscribe(handleMessage),
            detach: async () => {
              await settleQuietly(channel.detach());
            },
            isCancelled: () => cancelled.isCancelled,
            subscribedChannels,
          });
        }),
      );
      if (results.every((result) => result.status === "rejected")) {
        throw results.at(0)?.reason ?? new Error(ROOM_CODE_ENTRY_COPY.joinRequestSubscriptionsFailed);
      }
    } catch (nextError) {
      if (cancelled.isCancelled) {
        return;
      }
      if (attempt >= JOIN_REQUEST_REALTIME_MAX_ATTEMPTS) {
        console.error(ROOM_CODE_ENTRY_COPY.realtimeGuestJoinSubscriptionFailed, nextError);

        return;
      }
      await settleQuietly(input.refreshRealtimeAuth("join-request-subscribe"));
      const nextDelayMs = JOIN_REQUEST_REALTIME_RETRY_BASE_MS * (attempt + 1);
      retryTimeout.id = window.setTimeout(() => {
        retryTimeout.id = null;
        void subscribe(attempt + 1);
      }, nextDelayMs);
    }
  };

  void subscribe();

  return () => {
    cancelled.isCancelled = true;
    if (retryTimeout.id !== null) {
      window.clearTimeout(retryTimeout.id);
    }
    [...subscribedChannels].forEach((channel) => {
      channel.unsubscribe(handleMessage);
    });
    subscribedChannels.clear();
  };
}

function useRoomCodeEntryJoinRequestRealtime({
  realtimeClient,
  visibleJoinRequest,
  prejoinMeetingLink,
  meetingId,
  isDenied,
  hasMeetingEnded,
  onJoinRequestUpdate,
  refreshRealtimeAuth,
}: {
  realtimeClient: ReturnType<typeof useRealtimeClient>["client"];
  visibleJoinRequest: MeetingJoinRequest | null;
  prejoinMeetingLink: MeetingLink | null;
  meetingId: string | null;
  isDenied: boolean;
  hasMeetingEnded: boolean;
  onJoinRequestUpdate: (input: { nextRequest: MeetingJoinRequest; nextMeeting: Meeting | null }) => void;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
}) {
  useEffect(() => {
    const shouldSkip =
      realtimeClient === null ||
      visibleJoinRequest === null ||
      prejoinMeetingLink === null ||
      (meetingId !== null && meetingId !== "") ||
      isDenied ||
      hasMeetingEnded;
    if (shouldSkip) {
      return;
    }

    return startRoomCodeEntryJoinRequestRealtimeSubscription({
      realtimeClient,
      visibleJoinRequest,
      prejoinMeetingLink,
      onJoinRequestUpdate,
      refreshRealtimeAuth,
    });
  }, [
    hasMeetingEnded,
    isDenied,
    meetingId,
    onJoinRequestUpdate,
    prejoinMeetingLink,
    realtimeClient,
    refreshRealtimeAuth,
    visibleJoinRequest,
  ]);
}

function useRoomCodeEntryJoinRequestPolling({
  activeSession,
  visibleJoinRequest,
  meetingId,
  isDenied,
  hasMeetingEnded,
  isMeetingEndedMarked,
  onJoinRequestUpdate,
  setHasActiveParticipants,
}: {
  activeSession: AuthSession | null;
  visibleJoinRequest: MeetingJoinRequest | null;
  meetingId: string | null;
  isDenied: boolean;
  hasMeetingEnded: boolean;
  isMeetingEndedMarked: () => boolean;
  onJoinRequestUpdate: (input: { nextRequest: MeetingJoinRequest; nextMeeting: Meeting | null }) => void;
  setHasActiveParticipants: (value: boolean) => void;
}) {
  useEffect(() => {
    const pollingSession = activeSession;
    if (!pollingSession || !visibleJoinRequest || Boolean(meetingId) || isDenied || hasMeetingEnded) {
      return;
    }

    const cancelled = { isCancelled: false };
    const timeout: { id: number | null } = { id: null };

    const poll = async () => {
      try {
        const status = await getMeetingJoinRequestStatus({
          token: pollingSession.token,
          requestId: visibleJoinRequest.id,
        });
        if (!cancelled.isCancelled) {
          setHasActiveParticipants(status.hasActiveParticipants);
          onJoinRequestUpdate({ nextRequest: status.request, nextMeeting: status.meeting });
        }
        if (!cancelled.isCancelled && !isMeetingEndedMarked() && status.request.status === "waiting") {
          timeout.id = window.setTimeout(() => void poll(), JOIN_REQUEST_POLL_WAITING_INTERVAL_MS);
        }
      } catch (error) {
        if (!cancelled.isCancelled) {
          timeout.id = window.setTimeout(() => void poll(), JOIN_REQUEST_POLL_ERROR_INTERVAL_MS);
        }
        if (!(error instanceof Error)) {
          return;
        }
      }
    };

    timeout.id = window.setTimeout(() => void poll(), JOIN_REQUEST_POLL_INITIAL_DELAY_MS);

    return () => {
      cancelled.isCancelled = true;
      if (timeout.id !== null) {
        window.clearTimeout(timeout.id);
      }
    };
  }, [
    activeSession,
    hasMeetingEnded,
    isDenied,
    isMeetingEndedMarked,
    meetingId,
    onJoinRequestUpdate,
    visibleJoinRequest,
  ]);
}

function useRoomCodeEntryJoinFlowDerivedState(input: {
  joinRequest: MeetingJoinRequest | null;
  fullSession: AuthSession | null;
  roomGuestSession: StoredGuestSession | null;
  isAskingToJoin: boolean;
  displayName: string;
  isPrejoinReady: boolean;
  errorMessage: string | null;
  isHostPlanRequired: boolean;
}) {
  const guestSessionRequest = useMemo(() => requestFromGuestSession(input.roomGuestSession), [input.roomGuestSession]);
  const visibleJoinRequest = input.fullSession
    ? input.joinRequest?.userId === input.fullSession.user.id
      ? input.joinRequest
      : null
    : (input.joinRequest ?? guestSessionRequest);
  const isDenied = isJoinRequestDeniedStatus(visibleJoinRequest);
  const waitingJoinRequest = visibleJoinRequest && !isDenied ? visibleJoinRequest : null;
  const isWaiting = Boolean(waitingJoinRequest);
  const isJoinWaitingExperienceActive = input.isAskingToJoin || isWaiting;
  const canAskToJoin = input.fullSession ? true : input.displayName.trim().length > 0;
  const shouldShowPrejoin = input.isPrejoinReady || Boolean(visibleJoinRequest) || Boolean(input.errorMessage);
  const shouldUsePreview = shouldShowPrejoin && input.errorMessage === null && !input.isHostPlanRequired;

  return {
    visibleJoinRequest,
    isDenied,
    waitingJoinRequest,
    isWaiting,
    isJoinWaitingExperienceActive,
    canAskToJoin,
    shouldShowPrejoin,
    shouldUsePreview,
  };
}

function useRoomCodeEntryAskToJoin(input: {
  roomName: string;
  canAskToJoin: boolean;
  isAskingToJoin: boolean;
  setIsAskingToJoin: (value: boolean) => void;
  setErrorMessage: (value: string | null) => void;
  fullSession: AuthSession | null;
  displayName: string;
  recognition: ReturnType<typeof useGuestRecognition>;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  setPrejoin: (value: PrejoinState | ((current: PrejoinState) => PrejoinState)) => void;
  clearMeetingEnded: () => void;
  setJoinRequest: (value: MeetingJoinRequest | null) => void;
  setHasActiveParticipants: (value: boolean) => void;
  setGuestSession: (value: StoredGuestSession) => void;
  setInitialMeeting: (value: Meeting | null) => void;
  setMeetingId: (value: string | null) => void;
  setIsHostPlanRequired: (value: boolean) => void;
}) {
  return useCallback(async () => {
    if (!input.canAskToJoin || input.isAskingToJoin) {
      return;
    }
    input.setIsAskingToJoin(true);
    input.setErrorMessage(null);

    try {
      await submitRoomCodeJoinRequest({
        roomName: input.roomName,
        fullSession: input.fullSession,
        displayName: input.displayName,
        isRecognitionAvailable: input.recognition.available,
        recognitionChoice: input.recognition.choice,
        refreshRealtimeAuth: input.refreshRealtimeAuth,
        setPrejoin: input.setPrejoin,
        clearMeetingEnded: input.clearMeetingEnded,
        setJoinRequest: input.setJoinRequest,
        setHasActiveParticipants: input.setHasActiveParticipants,
        setGuestSession: input.setGuestSession,
        setInitialMeeting: input.setInitialMeeting,
        setMeetingId: input.setMeetingId,
      });
    } catch (nextError) {
      if (
        nextError instanceof ApiError &&
        nextError.status === HTTP_STATUS_FORBIDDEN &&
        getApiErrorCode(nextError) === "meeting_host_plan_required"
      ) {
        input.setIsHostPlanRequired(true);

        return;
      }
      input.setErrorMessage(
        nextError instanceof ApiError ? nextError.displayMessage : ROOM_CODE_ENTRY_COPY.couldNotAskToJoin,
      );
    } finally {
      input.setIsAskingToJoin(false);
    }
  }, [
    input.canAskToJoin,
    input.displayName,
    input.fullSession,
    input.clearMeetingEnded,
    input.isAskingToJoin,
    input.recognition.available,
    input.recognition.choice,
    input.refreshRealtimeAuth,
    input.roomName,
    input.setErrorMessage,
    input.setGuestSession,
    input.setHasActiveParticipants,
    input.setInitialMeeting,
    input.setIsAskingToJoin,
    input.setIsHostPlanRequired,
    input.setJoinRequest,
    input.setMeetingId,
    input.setPrejoin,
  ]);
}

function useRoomCodeEntryJoinWaitlist(input: {
  fullSession: AuthSession | null;
  isJoiningWaitlist: boolean;
  router: ReturnType<typeof useRouter>;
  setIsJoiningWaitlist: (value: boolean) => void;
  setWaitlistError: (value: string | null) => void;
  setIsWaitlistJoined: (value: boolean) => void;
}) {
  return useCallback(async () => {
    if (!input.fullSession) {
      // The waitlist needs an account; the requestAccess flow joins it
      // automatically right after sign-in.
      input.router.push("/login?callbackUrl=%2Fmeet%3FrequestAccess%3D1");

      return;
    }
    if (input.isJoiningWaitlist) {
      return;
    }

    input.setIsJoiningWaitlist(true);
    input.setWaitlistError(null);
    try {
      await joinPrivateBetaWaitlist(input.fullSession.token);
      input.setIsWaitlistJoined(true);
    } catch (joinError) {
      input.setWaitlistError(
        getApiErrorMessage({
          error: joinError,
          fallback: "Could not join the waitlist. Please try again.",
        }),
      );
    } finally {
      input.setIsJoiningWaitlist(false);
    }
  }, [
    input.fullSession,
    input.isJoiningWaitlist,
    input.router,
    input.setIsJoiningWaitlist,
    input.setIsWaitlistJoined,
    input.setWaitlistError,
  ]);
}

function useRoomCodeEntryJoinRequestPipeline(input: {
  realtimeClient: ReturnType<typeof useRealtimeClient>["client"];
  visibleJoinRequest: MeetingJoinRequest | null;
  prejoinMeetingLink: MeetingLink | null;
  meetingId: string | null;
  isDenied: boolean;
  hasMeetingEnded: boolean;
  isMeetingEndedMarked: () => boolean;
  markJoinRequestMeetingEnded: () => void;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  activeSession: AuthSession | null;
  fullSession: AuthSession | null;
  roomGuestSession: StoredGuestSession | null;
  prejoinMeeting: Meeting | null;
  setHasMeetingEnded: (value: boolean) => void;
  setJoinRequest: (value: MeetingJoinRequest | null) => void;
  setMeetingId: (value: string | null) => void;
  setInitialMeeting: (value: Meeting | null) => void;
  setHasEnteredMeeting: (value: boolean) => void;
  setHasActiveParticipants: (value: boolean) => void;
  setPrejoinMeeting: (meeting: Meeting | null) => void;
  setIsPrejoinReady: (value: boolean) => void;
  setErrorMessage: (value: string | null) => void;
  setDisplayName: (value: string) => void;
  clearGuestSession: () => void;
  setGuestSession: (value: StoredGuestSession) => void;
}) {
  const applyJoinRequestUpdate = useCallback(
    (nextRequest: MeetingJoinRequest, nextMeeting: Meeting | null) => {
      applyJoinRequestStateUpdate({
        nextRequest,
        nextMeeting,
        fullSession: input.fullSession,
        roomGuestSession: input.roomGuestSession,
        prejoinMeeting: input.prejoinMeeting,
        isMeetingEndedMarked: input.isMeetingEndedMarked,
        markJoinRequestMeetingEnded: input.markJoinRequestMeetingEnded,
        setHasMeetingEnded: input.setHasMeetingEnded,
        setJoinRequest: input.setJoinRequest,
        setMeetingId: input.setMeetingId,
        setInitialMeeting: input.setInitialMeeting,
        setHasEnteredMeeting: input.setHasEnteredMeeting,
        setHasActiveParticipants: input.setHasActiveParticipants,
        setPrejoinMeeting: input.setPrejoinMeeting,
        setIsPrejoinReady: input.setIsPrejoinReady,
        setErrorMessage: input.setErrorMessage,
        setDisplayName: input.setDisplayName,
        clearGuestSession: input.clearGuestSession,
        setGuestSession: input.setGuestSession,
      });
    },
    [
      input.clearGuestSession,
      input.fullSession,
      input.prejoinMeeting,
      input.roomGuestSession,
      input.setGuestSession,
      input.isMeetingEndedMarked,
      input.markJoinRequestMeetingEnded,
      input.setDisplayName,
      input.setErrorMessage,
      input.setHasActiveParticipants,
      input.setHasEnteredMeeting,
      input.setHasMeetingEnded,
      input.setInitialMeeting,
      input.setIsPrejoinReady,
      input.setJoinRequest,
      input.setMeetingId,
      input.setPrejoinMeeting,
    ],
  );

  useRoomCodeEntryJoinRequestRealtime({
    realtimeClient: input.realtimeClient,
    visibleJoinRequest: input.visibleJoinRequest,
    prejoinMeetingLink: input.prejoinMeetingLink,
    meetingId: input.meetingId,
    isDenied: input.isDenied,
    hasMeetingEnded: input.hasMeetingEnded,
    onJoinRequestUpdate: ({ nextRequest, nextMeeting }) => {
      applyJoinRequestUpdate(nextRequest, nextMeeting);
    },
    refreshRealtimeAuth: input.refreshRealtimeAuth,
  });
  useRoomCodeEntryJoinRequestPolling({
    activeSession: input.activeSession,
    visibleJoinRequest: input.visibleJoinRequest,
    meetingId: input.meetingId,
    isDenied: input.isDenied,
    hasMeetingEnded: input.hasMeetingEnded,
    isMeetingEndedMarked: input.isMeetingEndedMarked,
    onJoinRequestUpdate: ({ nextRequest, nextMeeting }) => {
      applyJoinRequestUpdate(nextRequest, nextMeeting);
    },
    setHasActiveParticipants: input.setHasActiveParticipants,
  });
}

function buildRoomCodeEntryOrchestrationModel(input: {
  router: ReturnType<typeof useRouter>;
  fullSession: AuthSession | null;
  isJoinWaitingExperienceActive: boolean;
  preview: ReturnType<typeof useRoomCodeEntryPreviewMedia>;
  displayName: string;
  setDisplayName: (value: string) => void;
  hasMeetingEnded: boolean;
  isLoading: boolean;
  prejoin: PrejoinState;
  errorMessage: string | null;
  isWaiting: boolean;
  waitingJoinRequest: MeetingJoinRequest | null;
  isDenied: boolean;
  recognition: ReturnType<typeof useGuestRecognition>;
  isAskingToJoin: boolean;
  canAskToJoin: boolean;
  handleAskToJoin: () => Promise<void>;
  hasActiveParticipants: boolean;
  meetingId: string | null;
  initialMeeting: Meeting | null;
  hasEnteredMeeting: boolean;
  launchHandoff: ReturnType<typeof peekMeetingLaunchHandoff>;
  isHostPlanRequired: boolean;
  waitlistError: string | null;
  isWaitlistJoined: boolean;
  isJoiningWaitlist: boolean;
  handleJoinWaitlist: () => Promise<void>;
  shouldShowPrejoin: boolean;
}) {
  return {
    router: input.router,
    fullSession: input.fullSession,
    isJoinWaitingExperienceActive: input.isJoinWaitingExperienceActive,
    ...input.preview,
    displayName: input.displayName,
    setDisplayName: input.setDisplayName,
    hasMeetingEnded: input.hasMeetingEnded,
    isLoading: input.isLoading,
    prejoin: input.prejoin,
    errorMessage: input.errorMessage,
    isWaiting: input.isWaiting,
    waitingJoinRequest: input.waitingJoinRequest,
    isDenied: input.isDenied,
    recognition: input.recognition,
    isAskingToJoin: input.isAskingToJoin,
    canAskToJoin: input.canAskToJoin,
    handleAskToJoin: input.handleAskToJoin,
    hasActiveParticipants: input.hasActiveParticipants,
    meetingId: input.meetingId,
    initialMeeting: input.initialMeeting,
    hasEnteredMeeting: input.hasEnteredMeeting,
    launchHandoff: input.launchHandoff,
    isHostPlanRequired: input.isHostPlanRequired,
    waitlistError: input.waitlistError,
    isWaitlistJoined: input.isWaitlistJoined,
    isJoiningWaitlist: input.isJoiningWaitlist,
    handleJoinWaitlist: input.handleJoinWaitlist,
    shouldShowPrejoin: input.shouldShowPrejoin,
  };
}

function useRoomCodeEntryOrchestrationRoomState({ roomName }: { roomName: string }) {
  const router = useRouter();
  const { clearGuestSession, guestSession, isLoading, refreshSession, session, setGuestSession } = useAuth();
  const bootstrapStartedRef = useRef(false);
  const authRefreshStartedRef = useRef(false);
  const [refreshedSession, setRefreshedSession] = useState<AuthSession | null>(null);
  const [prejoin, setPrejoin] = useState<PrejoinState>({ meeting: null, meetingLink: null });
  const [hasActiveParticipants, setHasActiveParticipants] = useState(false);
  const [hasMeetingEnded, setHasMeetingEnded] = useState(false);
  const hasMeetingEndedRef = useRef(false);
  const [joinRequest, setJoinRequest] = useState<MeetingJoinRequest | null>(null);
  const [launchHandoff] = useState(() => peekMeetingLaunchHandoff(roomName));
  const [meetingId, setMeetingId] = useState<string | null>(launchHandoff?.meeting.id ?? null);
  const [initialMeeting, setInitialMeeting] = useState<Meeting | null>(launchHandoff?.meeting ?? null);
  const [hasEnteredMeeting, setHasEnteredMeeting] = useState(Boolean(launchHandoff?.meeting.id));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPrejoinReady, setIsPrejoinReady] = useState(false);
  const [isAskingToJoin, setIsAskingToJoin] = useState(false);
  const [isHostPlanRequired, setIsHostPlanRequired] = useState(false);
  const [isWaitlistJoined, setIsWaitlistJoined] = useState(false);
  const [isJoiningWaitlist, setIsJoiningWaitlist] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const activeSession = refreshedSession ?? session;
  const fullSession = activeSession && activeSession.user.source !== "guest" ? activeSession : null;
  const recognition = useGuestRecognition(!isLoading && !fullSession);
  const [displayName, setDisplayName] = useRememberedGuestName(recognition, !isLoading && !fullSession);
  const roomGuestSession = guestSession?.meetingLinkCode === roomName ? guestSession : null;

  return {
    router,
    clearGuestSession,
    guestSession,
    isLoading,
    refreshSession,
    session,
    setGuestSession,
    bootstrapStartedRef,
    authRefreshStartedRef,
    refreshedSession,
    setRefreshedSession,
    prejoin,
    setPrejoin,
    hasActiveParticipants,
    setHasActiveParticipants,
    hasMeetingEnded,
    setHasMeetingEnded,
    hasMeetingEndedRef,
    joinRequest,
    setJoinRequest,
    launchHandoff,
    meetingId,
    setMeetingId,
    initialMeeting,
    setInitialMeeting,
    hasEnteredMeeting,
    setHasEnteredMeeting,
    errorMessage,
    setErrorMessage,
    isPrejoinReady,
    setIsPrejoinReady,
    isAskingToJoin,
    setIsAskingToJoin,
    isHostPlanRequired,
    setIsHostPlanRequired,
    isWaitlistJoined,
    setIsWaitlistJoined,
    isJoiningWaitlist,
    setIsJoiningWaitlist,
    waitlistError,
    setWaitlistError,
    retryCount,
    setRetryCount,
    activeSession,
    fullSession,
    recognition,
    displayName,
    setDisplayName,
    roomGuestSession,
  };
}

function useRoomCodeEntryOrchestrationPrejoinCore({ roomName }: { roomName: string }) {
  const room = useRoomCodeEntryOrchestrationRoomState({ roomName });
  const joinFlow = useRoomCodeEntryJoinFlowDerivedState({
    joinRequest: room.joinRequest,
    fullSession: room.fullSession,
    roomGuestSession: room.roomGuestSession,
    isAskingToJoin: room.isAskingToJoin,
    displayName: room.displayName,
    isPrejoinReady: room.isPrejoinReady,
    errorMessage: room.errorMessage,
    isHostPlanRequired: room.isHostPlanRequired,
  });
  const preview = useRoomCodeEntryPreviewMedia({
    fullSession: room.fullSession,
    meetingId: room.meetingId,
    hasEnteredMeeting: room.hasEnteredMeeting,
    shouldUsePreview: joinFlow.shouldUsePreview,
    shouldShowPrejoin: joinFlow.shouldShowPrejoin,
    setHasEnteredMeeting: room.setHasEnteredMeeting,
  });

  useRoomCodeEntryBootstrap({
    roomName,
    fullSession: room.fullSession,
    roomGuestSession: room.roomGuestSession,
    isLoading: room.isLoading,
    meetingId: room.meetingId,
    initialMeeting: room.initialMeeting,
    hasBootstrapStarted: () => room.bootstrapStartedRef.current,
    markBootstrapStarted: () => {
      room.bootstrapStartedRef.current = true;
    },
    resetBootstrapStarted: () => {
      room.bootstrapStartedRef.current = false;
    },
    hasAuthRefreshStarted: () => room.authRefreshStartedRef.current,
    markAuthRefreshStarted: () => {
      room.authRefreshStartedRef.current = true;
    },
    refreshSession: room.refreshSession,
    router: room.router,
    setRefreshedSession: room.setRefreshedSession,
    setRetryCount: room.setRetryCount,
    clearGuestSession: room.clearGuestSession,
    setJoinRequest: room.setJoinRequest,
    setInitialMeeting: room.setInitialMeeting,
    setMeetingId: room.setMeetingId,
    setPrejoin: room.setPrejoin,
    setIsPrejoinReady: room.setIsPrejoinReady,
    setHasActiveParticipants: room.setHasActiveParticipants,
    setIsHostPlanRequired: room.setIsHostPlanRequired,
    setIsWaitlistJoined: room.setIsWaitlistJoined,
    setErrorMessage: room.setErrorMessage,
    retryCount: room.retryCount,
  });

  return { ...room, joinFlow, preview };
}

function useRoomCodeEntryOrchestration({ roomName }: { roomName: string }) {
  const { client: realtimeClient, refreshRealtimeAuth } = useRealtimeClient();
  const core = useRoomCodeEntryOrchestrationPrejoinCore({ roomName });

  useRoomCodeEntryJoinRequestPipeline({
    realtimeClient,
    visibleJoinRequest: core.joinFlow.visibleJoinRequest,
    prejoinMeetingLink: core.prejoin.meetingLink,
    meetingId: core.meetingId,
    isDenied: core.joinFlow.isDenied,
    hasMeetingEnded: core.hasMeetingEnded,
    isMeetingEndedMarked: () => core.hasMeetingEndedRef.current,
    markJoinRequestMeetingEnded: () => {
      core.hasMeetingEndedRef.current = true;
    },
    refreshRealtimeAuth,
    activeSession: core.activeSession,
    fullSession: core.fullSession,
    roomGuestSession: core.roomGuestSession,
    prejoinMeeting: core.prejoin.meeting,
    setHasMeetingEnded: core.setHasMeetingEnded,
    setJoinRequest: core.setJoinRequest,
    setMeetingId: core.setMeetingId,
    setInitialMeeting: core.setInitialMeeting,
    setHasEnteredMeeting: core.setHasEnteredMeeting,
    setHasActiveParticipants: core.setHasActiveParticipants,
    setPrejoinMeeting: (meeting) => {
      core.setPrejoin((current) => ({ ...current, meeting }));
    },
    setIsPrejoinReady: core.setIsPrejoinReady,
    setErrorMessage: core.setErrorMessage,
    setDisplayName: core.setDisplayName,
    clearGuestSession: core.clearGuestSession,
    setGuestSession: core.setGuestSession,
  });

  const handleAskToJoin = useRoomCodeEntryAskToJoin({
    roomName,
    canAskToJoin: core.joinFlow.canAskToJoin,
    isAskingToJoin: core.isAskingToJoin,
    setIsAskingToJoin: core.setIsAskingToJoin,
    setErrorMessage: core.setErrorMessage,
    fullSession: core.fullSession,
    displayName: core.displayName,
    recognition: core.recognition,
    refreshRealtimeAuth,
    setPrejoin: core.setPrejoin,
    clearMeetingEnded: () => {
      core.hasMeetingEndedRef.current = false;
      core.setHasMeetingEnded(false);
    },
    setJoinRequest: core.setJoinRequest,
    setHasActiveParticipants: core.setHasActiveParticipants,
    setGuestSession: core.setGuestSession,
    setInitialMeeting: core.setInitialMeeting,
    setMeetingId: core.setMeetingId,
    setIsHostPlanRequired: core.setIsHostPlanRequired,
  });

  const handleJoinWaitlist = useRoomCodeEntryJoinWaitlist({
    fullSession: core.fullSession,
    isJoiningWaitlist: core.isJoiningWaitlist,
    router: core.router,
    setIsJoiningWaitlist: core.setIsJoiningWaitlist,
    setWaitlistError: core.setWaitlistError,
    setIsWaitlistJoined: core.setIsWaitlistJoined,
  });

  return buildRoomCodeEntryOrchestrationModel({
    router: core.router,
    fullSession: core.fullSession,
    isJoinWaitingExperienceActive: core.joinFlow.isJoinWaitingExperienceActive,
    preview: core.preview,
    displayName: core.displayName,
    setDisplayName: core.setDisplayName,
    hasMeetingEnded: core.hasMeetingEnded,
    isLoading: core.isLoading,
    prejoin: core.prejoin,
    errorMessage: core.errorMessage,
    isWaiting: core.joinFlow.isWaiting,
    waitingJoinRequest: core.joinFlow.waitingJoinRequest,
    isDenied: core.joinFlow.isDenied,
    recognition: core.recognition,
    isAskingToJoin: core.isAskingToJoin,
    canAskToJoin: core.joinFlow.canAskToJoin,
    handleAskToJoin,
    hasActiveParticipants: core.hasActiveParticipants,
    meetingId: core.meetingId,
    initialMeeting: core.initialMeeting,
    hasEnteredMeeting: core.hasEnteredMeeting,
    launchHandoff: core.launchHandoff,
    isHostPlanRequired: core.isHostPlanRequired,
    waitlistError: core.waitlistError,
    isWaitlistJoined: core.isWaitlistJoined,
    isJoiningWaitlist: core.isJoiningWaitlist,
    handleJoinWaitlist,
    shouldShowPrejoin: core.joinFlow.shouldShowPrejoin,
  });
}

function RoomCodeEntryFromModelEnteredMeeting(props: {
  meetingId: string;
  model: ReturnType<typeof useRoomCodeEntryOrchestration>;
  activeAudioInputId: string;
  activeVideoInputId: string;
  activeAudioOutputId: string;
}) {
  const { meetingId, model, activeAudioInputId, activeVideoInputId, activeAudioOutputId } = props;

  return (
    <RoomCodeEntryLiveMeetingView
      meetingId={meetingId}
      initialMeeting={model.initialMeeting}
      previewTracks={model.previewTracks}
      previewMediaErrors={model.previewMediaErrors}
      isCameraOn={model.isCameraOn}
      isMicOn={model.isMicOn}
      isBackgroundBlurEnabled={model.isBackgroundBlurPreferenceReady ? model.isBackgroundBlurEnabled : undefined}
      activeAudioInputId={activeAudioInputId}
      activeVideoInputId={activeVideoInputId}
      activeAudioOutputId={activeAudioOutputId}
    />
  );
}

function RoomCodeEntryFromModel({
  roomName,
  model,
}: {
  roomName: string;
  model: ReturnType<typeof useRoomCodeEntryOrchestration>;
}) {
  const title = model.prejoin.meeting?.title ?? model.prejoin.meetingLink?.title ?? "ReadyMeet";
  const {
    audioInputDevices,
    audioOutputDevices,
    videoInputDevices,
    activeAudioInputId,
    activeVideoInputId,
    activeAudioOutputId,
  } = getRoomCodeEntryDeviceSelection({
    mediaDevices: model.mediaDevices,
    previewTracks: model.previewTracks,
    previewStream: model.previewStream,
    previewVideoTrack: model.previewVideoTrack,
    selectedAudioInputId: model.selectedAudioInputId,
    selectedVideoInputId: model.selectedVideoInputId,
    selectedAudioOutputId: model.selectedAudioOutputId,
  });

  if (model.meetingId !== null && model.meetingId !== "" && model.hasEnteredMeeting) {
    return (
      <RoomCodeEntryFromModelEnteredMeeting
        meetingId={model.meetingId}
        model={model}
        activeAudioInputId={activeAudioInputId}
        activeVideoInputId={activeVideoInputId}
        activeAudioOutputId={activeAudioOutputId}
      />
    );
  }

  if (model.isHostPlanRequired) {
    return (
      <RoomCodeEntryHostPlanView
        roomName={roomName}
        fullSession={model.fullSession}
        waitlistError={model.waitlistError}
        isWaitlistJoined={model.isWaitlistJoined}
        isJoiningWaitlist={model.isJoiningWaitlist}
        onJoinWaitlist={() => {
          void model.handleJoinWaitlist();
        }}
        onClose={() => {
          model.router.replace("/");
        }}
      />
    );
  }

  if (!model.shouldShowPrejoin) {
    return <MeetingOpeningShell />;
  }

  return (
    <RoomCodeEntryPrejoinView
      roomName={roomName}
      fullSession={model.fullSession}
      isJoinWaitingExperienceActive={model.isJoinWaitingExperienceActive}
      previewStream={model.previewStream}
      isCameraOn={model.isCameraOn}
      previewVideoTrack={model.previewVideoTrack}
      isBackgroundBlurEnabled={model.isBackgroundBlurEnabled}
      displayName={model.displayName}
      setDisplayName={model.setDisplayName}
      isMicOn={model.isMicOn}
      setIsMicOn={model.setIsMicOn}
      setIsCameraOn={model.setIsCameraOn}
      setBackgroundBlurEnabledAndPersist={model.setBackgroundBlurEnabledAndPersist}
      isBackgroundBlurSupported={model.isBackgroundBlurSupported}
      previewError={model.previewError}
      audioInputDevices={audioInputDevices}
      audioOutputDevices={audioOutputDevices}
      videoInputDevices={videoInputDevices}
      activeAudioInputId={activeAudioInputId}
      activeAudioOutputId={activeAudioOutputId}
      activeVideoInputId={activeVideoInputId}
      setSelectedAudioInputId={model.setSelectedAudioInputId}
      setSelectedAudioOutputId={model.setSelectedAudioOutputId}
      setSelectedVideoInputId={model.setSelectedVideoInputId}
      hasMeetingEnded={model.hasMeetingEnded}
      isLoading={model.isLoading}
      prejoinMeetingLink={model.prejoin.meetingLink}
      errorMessage={model.errorMessage}
      isWaiting={model.isWaiting}
      waitingJoinRequest={model.waitingJoinRequest}
      title={title}
      isDenied={model.isDenied}
      recognition={model.recognition}
      isAskingToJoin={model.isAskingToJoin}
      canAskToJoin={model.canAskToJoin}
      handleAskToJoin={() => {
        void model.handleAskToJoin();
      }}
      hasActiveParticipants={model.hasActiveParticipants}
      meetingId={model.meetingId}
    />
  );
}

export function RoomCodeEntry({ roomName }: { roomName: string }) {
  const model = useRoomCodeEntryOrchestration({ roomName });

  return <RoomCodeEntryFromModel roomName={roomName} model={model} />;
}
