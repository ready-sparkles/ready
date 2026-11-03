"use client";

import { useTranscriptions } from "@livekit/components-react";
import type { CalendarProvider, Meeting, MeetingAmbientContextItem, MeetingJoinRequest } from "@readymeet/shared";
import { meetingConfidentialityRealtimeEventSchema } from "@readymeet/shared";
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  type LocalTrack,
  LocalVideoTrack,
  MediaDeviceFailure,
  type Participant,
  ParticipantKind,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  RpcError,
  type RpcInvocationData,
  SubscriptionError,
  Track,
} from "livekit-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  admitMeetingJoinRequest,
  ApiError,
  cancelMeetingAgentToolInvocation,
  confirmMeetingAgentToolInvocation,
  connectCalendar,
  denyMeetingJoinRequest,
  disconnectCalendar,
  endMeeting,
  getLiveMeeting,
  getMediaPreferences,
  getMeeting,
  getMeetingAmbientContextImageObjectUrl,
  getMeetingAmbientContextPrivateDetails,
  getMeetingPreparationPreview,
  getMeetingWebResearchRun,
  getMyAgentSettings,
  joinMeeting,
  listMeetingAmbientContext,
  listMeetingWebResearchRuns,
  type MeetingClientDiagnostic,
  mintLiveKitToken,
  reportMeetingClientDiagnostic,
  reportMeetingMediaDiagnostic,
  reportMeetingMediaQuality,
  retryMeetingAmbientContextItem,
  startLiveTranscription,
  updateMediaPreferences,
} from "../../composition/api";
import { webEnv } from "../../composition/env";
import { writeGuestNotesHandoff } from "../../composition/guest-notes-transition";
import {
  waitForModelMeetingPreparationDeck,
  writeModelMeetingPreparationHandoff,
} from "../../composition/meeting-preparation";
import {
  markWorkspaceNotesRevealPending,
  WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY,
  WORKSPACE_END_MEETING_TRANSITION_KEY,
} from "../../composition/workspace-transition";
import { meetingContextImageUrls, mergeMeetingPeopleMemory } from "../../domain/ambient-context-view";
import { getCalendarProviderLabel } from "../../domain/calendar-events";
import { resolveLiveKitTranscriptionSpeaker } from "../../domain/live-transcript-labels";
import {
  buildLiveKitTranscriptSourceSegmentId,
  type LiveTranscriptLine,
  type LiveTranscriptPresenceEntry as PresenceEntry,
  mergeLiveTranscriptLines,
  type VisibleTranscriptLine,
} from "../../domain/live-transcript-merge";
import { getLiveVideoGridLayout } from "../../domain/live-video-grid-layout";
import {
  getMediaPermissionErrorMessage,
  isMediaPermissionBlockedError,
  type MediaPermissionKind,
} from "../../domain/media-permissions";
import { reconcilePendingMeetingJoin, runMeetingJoinUnlessDeparting } from "../../domain/meeting-join-departure";
import {
  type EndedMeetingHistoryVisibility,
  getEndedMeetingHistoryVisibility,
  getEndedMeetingNotesPath,
  getMeetingNotesPath,
  getMeetingPublicPath,
} from "../../domain/meeting-links";
import {
  createParticipantSpeechStore,
  type ParticipantSpeechSource,
  type ParticipantSpeechStateMap,
} from "../../domain/participant-speech-store";
import { createQueuedRefresh } from "../../domain/queued-refresh";
import {
  authorizeRealtimeSetup,
  recoverFailedRealtimeChannel,
  shouldSubscribeToJoinedMeetingChannel,
} from "../../domain/realtime-subscription";
import {
  latestReadableWebResult,
  latestRelevantDetailsKey,
  relevantDetailsHistoryItems,
  upsertWebSearchHistory,
  webResearchQueryKey,
  type WebSearchPanelState,
  webSearchPayloadKey,
  webSearchRelevantDetailsKey,
} from "../../domain/relevant-details";
import {
  agentHelpCreditsRequiredPayloadSchema,
  assistantPresencePayloadSchema,
  assistantRpcPayloadMeetingSchema,
  assistantTurnConflictPayloadSchema,
  linearActionPanelPayloadSchema,
  type LinearActionPanelPayloadSchemaValue,
  realtimeMeetingDataPayloadSchema,
  type RealtimeMeetingDataPayloadSchemaValue,
} from "../../domain/schemas/live-meeting-page";
import {
  createSpeechIndicatorState,
  type SpeechIndicatorState,
  updateSpeechIndicator,
} from "../../domain/speech-indicator";
import type { AuthSession, MeetingDetailPayload } from "../../domain/types";
import {
  isVoiceServiceOutageNotice,
  voiceContextPausedMessage,
  voiceModeFailureMessage,
} from "../../domain/voice-mode-notice";
import {
  buildVoiceToolApprovalCard,
  parseVoiceToolApprovalRpcPayload,
  upsertVoiceToolApprovalCard,
  type VoiceToolApprovalCardDefinition,
} from "../../domain/voice-tool-approvals";
import {
  isStaleVoiceWebSearchProgress,
  isVoiceWebSearchLookingForAnswer,
  parseVoiceWebSearchPanelPayload,
  type VoiceWebSearchPanelPayload,
  voiceWebSearchPayloadMatchesCurrent,
  WEB_SEARCH_LOADER_FADE_MS,
  WEB_SEARCH_LOADER_MIN_VISIBLE_MS,
} from "../../domain/voice-web-search";
import { useAmbientContextRealtime } from "../hooks/use-ambient-context-realtime";
import { useAmbientContextRecovery } from "../hooks/use-ambient-context-recovery";
import { useAmbientPrivateDetails } from "../hooks/use-ambient-private-details";
import { useMeetingJoinRequestWatch } from "../hooks/use-join-requests-realtime";
import { useJoinRequestsRefresh } from "../hooks/use-join-requests-refresh";
import { useJoinedWorkspaceSession } from "../hooks/use-joined-workspace-session";
import { useLiveMeetingDetailRefresh } from "../hooks/use-live-meeting-detail-refresh";
import { useMeetingMemoryArrival } from "../hooks/use-meeting-memory-arrival";
import { useMeetingPeopleMemory } from "../hooks/use-meeting-people-memory";
import { toMeetingTrackerRealtimeClient, useMeetingTracker } from "../hooks/use-meeting-tracker";
import { useOutsidePointerDismiss } from "../hooks/use-outside-pointer-dismiss";
import { useParticipantTileTransition } from "../hooks/use-participant-tile-transition";
import { useRelevantDetailsSelection } from "../hooks/use-relevant-details-selection";
import { useWaitingRoomMenu } from "../hooks/use-waiting-room-menu";
import {
  createOwedVoiceStop,
  createVoiceModeIntent,
  getVoiceModeControlState,
  isSoloVoiceAvailable as canUseSoloVoice,
  START_CONVERSATION_MODE_RPC,
  STOP_CONVERSATION_MODE_RPC,
  type VoiceModePendingAction,
} from "../lib/agent-voice-mode";
import {
  canToggleBackgroundBlur,
  createBackgroundBlurProcessor,
  isBackgroundBlurProcessorSupported,
  setLocalVideoTrackBackgroundBlur,
} from "../lib/background-blur";
import { createConnectionQualityDiagnosticLimiter } from "../lib/connection-quality-diagnostics";
import { createLiveCallSession } from "../lib/live-call-session";
import {
  type AcquiredMeetingMedia,
  acquireMeetingMediaTracks,
  cancelMeetingCameraStart,
  createMeetingRoom,
  enableMeetingCameraWithFallback,
  getMeetingAudioCaptureOptions,
  getMeetingCameraTrack,
  getScreenShareCaptureOptions,
  getScreenSharePublishDefaults,
  isMeetingCameraStarting,
  isMeetingMicrophoneControlDisabled,
  MeetingCameraFallbackError,
  MeetingCameraStartCancelledError,
  publishMeetingCamera,
  setMeetingCameraBlurPreference,
} from "../lib/livekit";
import { disconnectAndStopRoomMedia } from "../lib/meeting-exit";
import { takeMeetingLaunchHandoff, takeMeetingLaunchMedia } from "../lib/meeting-launch";
import type { MediaHealthReporter } from "../lib/meeting-media-diagnostics";
import { meetingTrackerPanelVisibility, shouldDismissMeetingTracker } from "../lib/meeting-tracker-panel-state";
import {
  guardFailedScreenShareFeature,
  OPTIONAL_LIVE_REQUEST_TIMEOUT_MS,
  reportOptionalLiveServiceFailure,
  withOptionalLiveDeadline,
} from "../lib/optional-live-feature-failure";
import {
  attachPresentationClaimSync,
  isPlausiblePresentationClaimTimestamp,
  PRESENTATION_CLAIM_TOPIC,
  type PresentationClaim,
  type PresentationClaimPayload,
  publishPresentationClaim,
  requestPresentationClaimSync,
} from "../lib/presentation-claim-sync";
import { createTrackStreamDiagnosticLimiter } from "../lib/track-stream-diagnostics";
import { useCameraBlurReady } from "../lib/use-camera-blur-ready";

import { AgentVoiceGlow } from "./agent-voice-glow";
import { AmbientContextPanel } from "./ambient-context-panel";
import { AmbientContextPill } from "./ambient-context-pill";
import { AnimatedCaptionsWave } from "./animated-captions-wave";
import { useAuth } from "./auth-provider";
import {
  EndMeetingAnalysisOverlay,
  type EndMeetingFlowState,
  getEndMeetingPreparationWaitMs,
} from "./end-meeting-analysis";
import { LiveFeatureBoundary } from "./live-feature-boundary";
import {
  AvatarTile,
  BackgroundBlurIcon,
  CameraIcon,
  CopyStatusIcon,
  formatDialInPhoneNumber,
  getUserInitials,
  InfoIcon,
  MicrophoneIcon,
  ParticipantTileCallerLabel,
  PhoneDownIcon,
  ScreenShareIcon,
  SettingsGearIcon,
  UserAvatarBadge,
} from "./live-meeting-visuals";
import { MeetingEndControls } from "./meeting-end-controls";
import { MeetingInviteExperience } from "./meeting-invite-experience";
import { MeetingTrackerPanel } from "./meeting-tracker-panel";
import { MeetingTrackerTrigger } from "./meeting-tracker-trigger";
import { useRealtimeClient } from "./realtime-provider";
import { useToast } from "./toast-provider";
import { VoiceModeControlIcon } from "./voice-mode-control-icon";

export { BackgroundBlurIcon, CameraIcon, MicrophoneIcon } from "./live-meeting-visuals";

const ACTIVE_MEETING_KEY = "readymeet-active-meeting-id";
const ASSISTANT_IDENTITY_PREFIX = "readymeet-assistant-";
const ASSISTANT_PHASE_ATTRIBUTE = "assistantPhase";
const SIP_PHONE_NUMBER_ATTRIBUTE = "sip.phoneNumber";
const SIP_CALL_ID_ATTRIBUTE = "sip.callID";
const LIVE_ROOM_CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const INTERRUPT_SPEECH_RPC = "interrupt_speech";
const REFRESH_AGENT_CONTEXT_RPC = "refresh_agent_context";
const TOOL_CONNECTION_REQUEST_RPC = "readymeet.tools.request_connection";
const LINEAR_ACTION_PANEL_RPC = "readymeet.linear.show_action";
const WEB_SEARCH_RESULTS_RPC = "readymeet.web_search.show_results";
const MEETING_ANSWER_RESULTS_RPC = "readymeet.meeting_answer.show_results";
const ASSISTANT_RPC_RESPONSE_TIMEOUT_MS = 10_000;
const END_MEETING_OVERLAY_EXIT_MS = 200;
const END_MEETING_REQUEST_TIMEOUT_MS = 8000;
const PRESENTATION_CLAIM_WAIT_MS = 220;
const PRESENTATION_STATE_ATTRIBUTE = "presentationState";
const WEB_SEARCH_LOADER_MAX_IDLE_MS = 90_000;
const WEB_SEARCH_MEETING_ANSWER_IDLE_MS = 340_000;
const WEB_SEARCH_POLL_MAX_ATTEMPTS = 24;
const WEB_SEARCH_POLL_FAST_ATTEMPT_THRESHOLD = 6;
const WEB_SEARCH_POLL_FAST_INTERVAL_MS = 900;
const WEB_SEARCH_POLL_SLOW_INTERVAL_MS = 1800;
const LIVE_VIDEO_GRID_DEFAULT_GAP_PX = 10;
const LIVE_ROOM_CLOCK_INTERVAL_MS = 60_000;
const END_MEETING_FLOW_TICK_MS = 1_000;
const AVATAR_SPEECH_POLL_MS = 60;
const LIVE_MEDIA_HANDOFF_VIDEO_EXIT_MS = 620;
const LIVE_MEDIA_HANDOFF_LAYER_HINT_MS = 1200;
const LIVE_MEETING_PAGE_COPY = {
  unknownFailure: "unknown failure",
  meetingRoomUnavailable: "Meeting room is unavailable",
  unknownClientError: "Unknown client error",
  codecUnsupported: "Codec unsupported",
  trackNotFound: "Track not found",
  unknownSubscriptionError: "Unknown subscription error",
  noSubscriptionFailureReason: "No subscription failure reason supplied",
  fullscreenUnsupported: "Fullscreen is not supported in this browser.",
  screenShareChooseSource: "Choose a screen, window, or tab to start sharing.",
  screenShareUnavailable: "That screen share source is currently unavailable. Try a different window or tab.",
  screenShareNeedsTab: "Screen sharing needs an active browser tab.",
  screenShareFailed: "Failed to start screen sharing.",
  defaultAssistantDisplayName: "Assistant",
  assistantSomeoneElseSpeaking: "Someone else is speaking...",
  assistantSpeakingSuffix: " is speaking...",
  presenceInThisMeeting: "In this meeting",
  presenceParticipantsLabel: "participants",
  presenceClosePeoplePanel: "Close people panel",
  presenceParticipantsInMeeting: "Participants in meeting",
  presencePeopleGroup: "People",
  presenceAgentsGroup: "Agents",
  presenceYouSubtitle: "You",
  presenceParticipantSubtitle: "Participant",
  presenceAgentReadySubtitle: "Ready",
  meetingDetailsTitle: "Meeting details",
  meetingDetailsClosePanel: "Close meeting details panel",
  meetingDetailsJoiningInfo: "Joining info",
  meetingDetailsDialInPrefix: "Dial-in:",
  meetingDetailsPinPrefix: "PIN:",
  meetingDetailsCopyJoiningInfo: "Copy joining info",
  settingsTitle: "Settings",
  settingsClosePanel: "Close settings panel",
  settingsMicrophone: "Microphone",
  settingsCamera: "Camera",
  settingsBackgroundBlur: "Background blur",
  settingsBlurUnsupported: "Unsupported",
  settingsBlurUpdating: "Updating...",
  settingsBlurOn: "On",
  settingsBlurOff: "Off",
  agentSkillsTitle: "Agent skills",
  agentSkillsClosePanel: "Close agent skills panel",
  linearActionDefaultLabel: "Linear action",
  linearActionsFailed: "The Linear actions failed",
  linearIssuesNounDefault: "issues",
  linearPanelTitle: "Linear",
  linearPanelClose: "Close Linear panel",
  linearPanelAriaLabel: "Linear action",
  linearActionFailed: "The Linear action failed.",
  linearActionConfirming: "Confirming…",
  linearActionConfirm: "Confirm",
  linearActionCancel: "Cancel",
  linearActionWaitingForConfirm: "Waiting for the requesting participant to confirm.",
  agentNotConnectedYet: "ReadyMeet is not connected yet",
  agentDisconnectedWhileJoining: "ReadyMeet disconnected while joining",
  agentHelpCreditsToastTitle: "Add credits to talk to your agent",
  agentHelpCreditsToastMessage: "Add credits to keep using voice chat with Ready.",
  ambientContextRetryTitle: "Research could not restart",
  webSearchMeetingAnswerTimeout: "The meeting answer took too long to reach this device. Please ask again.",
  webSearchResultsTimeout: "Search results took too long to reach this device. Please try again.",
  postMeetingSkippedTitle: "Meeting was too short",
  meetingExitEndForAllTitle: "You left the meeting",
  meetingExitLeaveTitle: "Meeting connection closed",
  meetingExitEndForAllMessage:
    "Could not confirm that the meeting ended for everyone. Check the meeting before trying again.",
  meetingExitLeaveMessage: "Could not confirm your departure with the server. Your camera and microphone are off.",
  publishedCameraTrackNotLive: "Published camera track was not live",
  joinLiveMeetingFailed: "Failed to join live meeting",
  backgroundBlurUnsupportedBrowser: "Background blur is not supported in this browser.",
  backgroundBlurUpdateFailed: "Failed to update background blur",
  calendarSignInRequiredTitle: "Sign in required",
  calendarDisconnectSignInMessage: "Sign in before disabling your calendar skill.",
  calendarConnectSignInMessage: "Sign in before connecting your calendar.",
  calendarDisconnectedTitle: "Calendar disabled",
  calendarDisconnectedMessageSuffix: " is disconnected from your agent.",
  calendarDisableFailedTitle: "Calendar disable failed",
  calendarConnectedTitle: "Calendar connected",
  calendarConnectedMessageSuffix: " is ready for your agent.",
  calendarAuthFailedCardError: "Calendar authentication failed. Try connecting again.",
  calendarConnectionFailedTitle: "Calendar connection failed",
  calendarConnectionFailedMessage: "Try connecting again.",
  voiceModeStopConfirmFailed: "Voice chat with Ready could not be confirmed off. Try again to finish stopping it.",
  voiceModeAgentJoining: "Your agent is still joining. Try again in a moment.",
  voiceModeUnavailable: "Voice chat with Ready is not available in this call.",
  voiceModeStartFailed: "Failed to start voice chat with Ready",
  voiceModeEndFailed: "Failed to end voice chat with Ready",
  admitGuestsCheckingRequests: "Checking requests...",
  admitGuestsWaitingToJoin: "Waiting to join",
  admitGuestsGuestLabel: "Guest",
  admitGuestAction: "Admit",
  denyGuestAction: "Deny",
  meetingDetailsCallInAriaLabel: "Phone call-in",
  meetingEndedUnavailable: "This meeting has ended or is no longer available to join.",
  openMeetingNotes: "Open meeting notes",
  linearPartialToastWithCustomPrefix: " of ",
  linearPartialToastFailedSuffix: " failed",
  linearPartialToastCompletedPrefix: "Completed ",
  linearPartialToastCompletedMiddle: " of ",
  linearPartialToastCompletedSuffix: " Linear actions — ",
  linearPartialToastCompletedFailedSuffix: " failed",
  linearFailureActionsCompletedPrefix: " of ",
  linearFailureActionsCompletedMiddle: " actions completed. ",
  linearFailureActionsCompletedSuffix: " failed",
  joiningInfoCopiedTitle: "Joining info copied",
  joiningInfoCopiedMessage: "Ready meeting details are on your clipboard.",
  joiningInfoCopyFailedTitle: "Joining info not copied",
  joiningInfoCopyFailedFallback: "Failed to copy joining info",
  reconcileDepartureLateJoinLog: "[readymeet] Could not reconcile departure after late join.",
  reconcileDeparturePendingJoinLog: "[readymeet] Could not reconcile departure after pending join.",
  voiceToolChooseToolFirst: "Choose a tool first.",
  voiceToolChooseCalendarProvider: "Choose Google Calendar or Outlook first.",
  voiceToolCalendarSkillsCheckFailed: "Unable to check connected calendar skills.",
  voiceToolNoConnectedCalendar: "No connected calendar skill found.",
  meetingDetailsPinHashSuffix: "#",
  joinRequestSubscriptionsFailed: "Join-request subscriptions failed",
  screenShareStopFailed: "Failed to stop screen sharing",
  screenShareRemotePresenterPrefix: " is already presenting.",
  screenShareRemotePresenterStarting: "Someone else",
  screenShareRemotePresenterStartingSuffix: " is already starting to present.",
  workflowRequestedTitle: "Workflow requested",
  workflowRequestedMessage: "We noted it for this meeting session.",
  calendarConnectErrorTitle: "Calendar connection failed",
  linearActionCancelFailed: "Could not cancel the Linear action.",
  transcriptStartingCaptions: "Starting captions...",
  transcriptListening: "Listening for speech...",
  transcriptConnecting: "Connecting captions...",
  agentHelpTooltipText: "Talk with your Ready agent when you’re alone in the meeting.",
  fullscreenEnter: "Enter fullscreen",
  fullscreenExit: "Exit fullscreen",
  meetingDetailsButtonLabel: "Meeting details",
  settingsButtonLabel: "Settings",
  captionsError: "Captions error",
  captionsHide: "Hide transcript",
  captionsShow: "Show transcript",
  captionsStarting: "Captions starting",
  screenShareStop: "Stop screen sharing",
  screenShareStart: "Share screen",
  screenShareUnsupportedBrowser: "Screen sharing is not supported in this browser",
  screenShareStartOrTab: "Share screen or tab",
  micMute: "Mute microphone",
  micRetryPermission: "Retry microphone permission",
  micAllow: "Allow microphone",
  micUnmute: "Unmute microphone",
  micRetryTitle: "Allow microphone in your browser, then click to retry",
  cameraOff: "Turn camera off",
  cameraRetryPermission: "Retry camera permission",
  cameraAllow: "Allow camera",
  cameraOn: "Turn camera on",
  cameraRetryTitle: "Allow camera in your browser, then click to retry",
  defaultParticipantDisplayName: "Participant",
  linearToastNoChanges: "No changes made in Linear",
  linearToastDone: "Done in Linear",
  linearActionRunFailed: "Could not run the Linear action.",
  presenceYouPresenting: "You • Presenting",
  presenceParticipantPresenting: "Participant • Presenting",
  liveTranscriptAriaLabel: "Live transcript",
  admitGuestsAdmitPrefix: "Admit ",
  admitGuestsWaitingSuffix: " waiting",
  admitGuestSingular: "guest",
  admitGuestsPlural: "guests",
} as const;
const TRANSCRIPT_CHAR_STAGGER_MS = 16;
const LINEAR_PREVIEW_VALUE_MAX_CHARS = 400;
const LINEAR_PREVIEW_ENTRY_MAX = 10;
const MEETING_AGENT_JOIN_WAIT_DEFAULT_MS = 8_000;
const MEETING_AGENT_JOIN_WAIT_SHORT_MS = 2_000;
const AMBIENT_CONTEXT_LIST_TIMEOUT_MS = 10_000;
const LINEAR_BATCH_FAILED_ACTIONS_MAX = 10;
const LINEAR_BATCH_FAILED_LIST_MAX = 5;
const LINEAR_ACTION_SUMMARIES_MAX = 30;
const LIVE_ROOM_CLOCK_MS_UNTIL_NEXT_MINUTE_MIN = 250;
const LIVE_ROOM_CLOCK_SECONDS_PER_MINUTE = 60;
const LIVE_ROOM_CLOCK_MS_PER_SECOND = 1000;
const LIVE_ROOM_CLOCK_NEXT_MINUTE_PADDING_MS = 50;
const VIDEO_TILE_ASPECT_WIDTH = 16;
const VIDEO_TILE_ASPECT_HEIGHT = 9;
const LIVE_TILE_ASPECT_RATIO = VIDEO_TILE_ASPECT_WIDTH / VIDEO_TILE_ASPECT_HEIGHT;
const CLIENT_DIAGNOSTIC_ERROR_NAME_MAX_LENGTH = 120;
const CLIENT_DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH = 500;
const LOCAL_AVATAR_SPEECH_ACTIVE_LEVEL = 0.015;
const PRESENTATION_REQUESTED_AT_ATTRIBUTE = "presentationRequestedAt";
const LIVEKIT_TRANSCRIPTION_FINAL_ATTRIBUTE = "lk.transcription_final";
const LIVEKIT_TRANSCRIPTION_SEGMENT_ID_ATTRIBUTE = "lk.segment_id";
const LIVEKIT_TRANSCRIPTION_TRACK_ID_ATTRIBUTE = "lk.transcribed_track_id";
const READYMEET_CAPTION_SOURCE_ATTRIBUTE = "readymeet.caption_source";
const READYMEET_CAPTION_SOURCE_SCRIBE = "scribe";
const CALENDAR_SKILL_PROVIDERS: CalendarProvider[] = ["google_calendar", "outlook_calendar"];
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
const END_MEETING_ROUTING_DELAY_MS = 140;
const MEETING_ENDED_STATUS_POLL_MS = 600;
const JOIN_BOOKKEEPING_MAX_ATTEMPTS = 3;
const JOIN_BOOKKEEPING_RETRY_BACKOFF_MS = 1500;
const LOCAL_MIC_ANALYSER_FFT_SIZE = 256;
const AUDIO_WAVE_CENTER_OFFSET = 128;
const AUDIO_WAVE_NORMALIZER = 128;
const LOCAL_MIC_RMS_AMPLIFIER = 3.2;
const SPEECH_LEVEL_SMOOTHING_ATTACK = 0.24;
const SPEECH_LEVEL_SMOOTHING_ATTACK_INVERSE = 0.76;
const SPEECH_LEVEL_SMOOTHING_DECAY = 0.78;
const SPEECH_LEVEL_SMOOTHING_DECAY_INVERSE = 0.22;
const SPEECH_LEVEL_SILENCE_THRESHOLD = 0.006;
const SPEECH_LEVEL_COMPARE_EPSILON = 0.003;
const CAPTION_SPEECH_SMOOTH_ATTACK = 0.35;
const CAPTION_SPEECH_SMOOTH_ATTACK_INVERSE = 0.65;
const CAPTION_SPEECH_SMOOTH_DECAY = 0.82;
const CAPTION_SPEECH_SMOOTH_DECAY_INVERSE = 0.18;
const VOICE_RPC_START_MAX_ATTEMPTS = 6;
const VOICE_RPC_RETRY_DELAY_MS = 180;
const VOICE_RPC_START_TIMEOUT_MS = 30_000;
const VOICE_RPC_STOP_TIMEOUT_MS = 15_000;
const WEB_SEARCH_LOADER_FADE_EXTRA_MS = 60;
const WEB_RESEARCH_POLL_MAX_ATTEMPTS_WITHOUT_RUN = 10;
const WEB_RESEARCH_POLL_INTERVAL_MS = 700;
const WEB_RESEARCH_RUN_POLL_MAX_ATTEMPTS = 30;
const WEB_RESEARCH_RUN_POLL_RETRY_MAX_ATTEMPTS = 4;
const WEB_RESEARCH_RUN_POLL_RETRY_DELAY_MS = 1200;
const CALENDAR_OAUTH_POPUP_WIDTH = 620;
const CALENDAR_OAUTH_POPUP_HEIGHT = 760;
const LIVE_ROOM_VIDEO_REVEAL_DELAY_MS = 60;
const LIVE_ROOM_CONTROLS_REVEAL_DELAY_MS = 200;
const LIVE_ROOM_AVATAR_REVEAL_DELAY_MS = 320;
const LIVE_ROOM_JOINING_INFO_COPIED_RESET_MS = 3000;
const LIVE_VIDEO_GRID_TWO_PARTICIPANT_COUNT = 2;

function hasConfiguredMediaDeviceId(deviceId: string | undefined): deviceId is string {
  return typeof deviceId === "string" && deviceId.length > 0;
}

function hasAnyConfiguredMediaDeviceId(input: {
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
}): boolean {
  return hasConfiguredMediaDeviceId(input.audioDeviceId) || hasConfiguredMediaDeviceId(input.videoDeviceId);
}

function isAudioContextConstructor(value: unknown): value is typeof AudioContext {
  return typeof value === "function";
}

function getWindowAudioContextConstructor(): typeof AudioContext | undefined {
  if (isAudioContextConstructor(globalThis.AudioContext)) {
    return globalThis.AudioContext;
  }
  const legacyConstructor: unknown = Reflect.get(window, "webkitAudioContext");
  if (isAudioContextConstructor(legacyConstructor)) {
    return legacyConstructor;
  }

  return undefined;
}

function isCalendarProvider(value: unknown): value is CalendarProvider {
  return CALENDAR_SKILL_PROVIDERS.some((provider) => provider === value);
}

function getAdmitGuestsWaitingLabel(count: number): string {
  const guestWord = count === 1 ? LIVE_MEETING_PAGE_COPY.admitGuestSingular : LIVE_MEETING_PAGE_COPY.admitGuestsPlural;

  return `${LIVE_MEETING_PAGE_COPY.admitGuestsAdmitPrefix}${count} ${guestWord}${LIVE_MEETING_PAGE_COPY.admitGuestsWaitingSuffix}`;
}

function buildCalendarDisconnectedToastMessage(provider: CalendarProvider): string {
  return `${getCalendarProviderLabel(provider)}${LIVE_MEETING_PAGE_COPY.calendarDisconnectedMessageSuffix}`;
}

function buildCalendarConnectedToastMessage(provider: CalendarProvider): string {
  return `${getCalendarProviderLabel(provider)}${LIVE_MEETING_PAGE_COPY.calendarConnectedMessageSuffix}`;
}

function describeCaughtFailure(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  return LIVE_MEETING_PAGE_COPY.unknownFailure;
}

function requireMeetingRoom(room: Room | null) {
  if (room === null) {
    throw new Error(LIVE_MEETING_PAGE_COPY.meetingRoomUnavailable);
  }

  return room;
}

type TrackView = {
  id: string;
  kind: "video" | "audio";
  source: Track.Source;
  track: Track;
  isLocal: boolean;
  participantIdentity: string;
  participantName?: string;
};

type VoiceToolApprovalCardState = VoiceToolApprovalCardDefinition & {
  status: "idle" | "starting" | "disconnecting" | "connected" | "error" | "requested";
  error: string | null;
  requestedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasAuthSession(session: AuthSession | null): session is AuthSession {
  return session !== null;
}

function hasMeetingRecord(meeting: Meeting | null): meeting is Meeting {
  return meeting !== null;
}

function hasLiveKitRoom(room: Room | null): room is Room {
  return room !== null;
}

function formatLiveParticipantName(input: { name: string | undefined; identity: string }): string {
  return input.name !== undefined && input.name.length > 0 ? input.name : input.identity;
}

function sortLiveTranscriptLinesByUpdatedAt(input: { lines: Iterable<LiveTranscriptLine> }): LiveTranscriptLine[] {
  return [...input.lines].sort((left, right) => left.updatedAt - right.updatedAt);
}

function getPublishedCameraDeviceId(participant: Participant): string | undefined {
  const publication = participant.getTrackPublication(Track.Source.Camera);
  if (publication?.track === undefined) {
    return undefined;
  }

  return publication.track.mediaStreamTrack.getSettings().deviceId;
}

function applyRecoveredVideoDeviceId(input: {
  deviceId: string | undefined;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
}) {
  if (input.deviceId !== undefined && input.deviceId.length > 0) {
    input.setVideoDeviceId(input.deviceId);
  }
}

function getPresentationClaimPresenterLabel(participantName: string | undefined): string {
  return participantName !== undefined && participantName.length > 0
    ? participantName
    : LIVE_MEETING_PAGE_COPY.screenShareRemotePresenterStarting;
}

function reportLiveMeetingMediaDevicesError(input: {
  room: Room;
  mediaError: Error;
  videoDeviceId: string | undefined;
  audioDeviceId: string | undefined;
  diagnosticContext: { token: string; meetingId: string } | null;
}) {
  const kind =
    input.room.localParticipant.lastCameraError === input.mediaError
      ? "camera"
      : input.room.localParticipant.lastMicrophoneError === input.mediaError
        ? "microphone"
        : "unknown";
  if (input.diagnosticContext === null) {
    return;
  }
  reportMeetingMediaIssue({
    token: input.diagnosticContext.token,
    meetingId: input.diagnosticContext.meetingId,
    kind,
    phase: "room-device-event",
    error: input.mediaError,
    selectedDevice:
      kind === "camera"
        ? hasConfiguredMediaDeviceId(input.videoDeviceId)
        : hasConfiguredMediaDeviceId(input.audioDeviceId),
    fallbackAttempted: false,
    recovered: false,
  });
}

function restoreAssistantPresenceAfterFailedVoiceRpc(input: {
  room: Room | null;
  isStarting: boolean;
  isVoiceAttemptRejected: boolean;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
}) {
  const assistantParticipant =
    input.room !== null
      ? Array.from(input.room.remoteParticipants.values()).find(isMeetingAgentParticipant)
      : undefined;
  if (assistantParticipant === undefined) {
    return;
  }
  const currentPresence = getAssistantPresencePayloadFromParticipant(assistantParticipant);
  if (currentPresence === null) {
    return;
  }
  if (!input.isStarting || input.isVoiceAttemptRejected || currentPresence.conversationModeActive === true) {
    input.applyAssistantPresencePayload(currentPresence);
  }
}

function webSearchRunDurableIds(run: {
  researchRunId?: string | null;
  searchId?: string | null;
  sessionId?: string | null;
  findallId?: string | null;
}) {
  return [run.searchId, run.researchRunId, run.findallId].filter(
    (id): id is string => id !== null && id !== undefined && id !== "",
  );
}

function webSearchRunMatchesPayload(input: {
  run: {
    researchRunId?: string | null;
    searchId?: string | null;
    sessionId?: string | null;
    findallId?: string | null;
    query?: string | null;
  };
  parsed: VoiceWebSearchPanelPayload;
  shouldAllowQueryMatch?: boolean;
}) {
  const { run, parsed, shouldAllowQueryMatch = false } = input;
  const parsedDurableIds = webSearchRunDurableIds(parsed);
  const runDurableIds = new Set(webSearchRunDurableIds(run));
  if (parsedDurableIds.some((id) => runDurableIds.has(id))) {
    return true;
  }

  if (!shouldAllowQueryMatch) {
    return false;
  }

  return webResearchQueryKey(run.query ?? "") === webResearchQueryKey(parsed.query);
}

function selectWebSearchRunForPayload<
  T extends {
    researchRunId?: string | null;
    searchId?: string | null;
    sessionId?: string | null;
    findallId?: string | null;
    query?: string | null;
    status?: string | null;
  },
>(input: { runs: T[]; parsed: VoiceWebSearchPanelPayload }) {
  const { runs, parsed } = input;
  const exactMatchingRun = runs.find((candidate) => webSearchRunMatchesPayload({ run: candidate, parsed }));
  const activeMatchingRun = runs.find(
    (candidate) =>
      webSearchRunMatchesPayload({ run: candidate, parsed, shouldAllowQueryMatch: true }) &&
      !isTerminalWebResearchRunStatus(candidate.status),
  );
  const terminalMatchingRun = runs.find(
    (candidate) =>
      webSearchRunMatchesPayload({ run: candidate, parsed, shouldAllowQueryMatch: true }) &&
      isTerminalWebResearchRunStatus(candidate.status),
  );

  return exactMatchingRun ?? activeMatchingRun ?? terminalMatchingRun ?? null;
}

function isTerminalWebResearchRunStatus(status: unknown) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "";

  return ["completed", "error", "failed", "cancelled", "expired"].includes(normalized);
}

function schedulePersistedWebSearchPanelPoll(input: {
  attempt: number;
  pollState: {
    isPollCancelled: {
      /** @external ref wire */
      current: boolean;
    };
    timeoutId: number | null;
  };
  pollPersistedRun: (attempt: number) => Promise<void>;
}): void {
  const { attempt, pollState, pollPersistedRun } = input;
  if (attempt > WEB_SEARCH_POLL_MAX_ATTEMPTS || pollState.isPollCancelled.current) {
    return;
  }

  pollState.timeoutId = window.setTimeout(
    () => {
      void pollPersistedRun(attempt);
    },
    attempt < WEB_SEARCH_POLL_FAST_ATTEMPT_THRESHOLD
      ? WEB_SEARCH_POLL_FAST_INTERVAL_MS
      : WEB_SEARCH_POLL_SLOW_INTERVAL_MS,
  );
}

async function applyPersistedWebSearchRunToPanel(input: {
  token: string;
  meetingId: string;
  current: WebSearchPanelState;
  matchingRun: { researchRunId: string };
  pollState: {
    isPollCancelled: {
      /** @external ref wire */
      current: boolean;
    };
  };
  watchdogRunId: number;
  webSearchPanelRunIdRef: { current: number };
  schedulePoll: (attempt: number) => void;
  attempt: number;
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
}): Promise<void> {
  const {
    token,
    meetingId,
    current,
    matchingRun,
    pollState,
    watchdogRunId,
    webSearchPanelRunIdRef,
    schedulePoll,
    attempt,
    updateWebSearchPanelState,
  } = input;
  const run = await getMeetingWebResearchRun({
    token,
    meetingId,
    runId: matchingRun.researchRunId,
    signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
  });
  if (pollState.isPollCancelled.current || webSearchPanelRunIdRef.current !== watchdogRunId) {
    return;
  }

  const fullState = parseVoiceWebSearchPanelPayload(
    JSON.stringify({
      ...run,
      meetingId: current.meetingId,
      requestingUserId: current.requestingUserId,
    }),
  );
  if (
    !voiceWebSearchPayloadMatchesCurrent(current, fullState) &&
    !webSearchRunMatchesPayload({ run: matchingRun, parsed: current, shouldAllowQueryMatch: true })
  ) {
    schedulePoll(attempt + 1);

    return;
  }

  updateWebSearchPanelState({
    ...fullState,
    updatedAt: Date.now(),
  });

  if (isVoiceWebSearchLookingForAnswer(fullState)) {
    schedulePoll(attempt + 1);
  }
}

function stopFailedLiveResearch(input: {
  current: WebSearchPanelState | null;
  update: (state: WebSearchPanelState) => void;
  isCancelled: boolean;
  currentRunId: number;
  failedRunId: number;
}): void {
  if (!input.isCancelled && input.currentRunId === input.failedRunId && input.current !== null) {
    input.update({ ...input.current, status: "error", message: null, updatedAt: Date.now() });
  }
}

async function pollPersistedWebSearchPanelRun(input: {
  attempt: number;
  token: string;
  pollState: {
    isPollCancelled: {
      /** @external ref wire */
      current: boolean;
    };
  };
  watchdogRunId: number;
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  schedulePoll: (attempt: number) => void;
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
}): Promise<void> {
  const {
    attempt,
    token,
    pollState,
    watchdogRunId,
    webSearchPanelRunIdRef,
    webSearchPanelStateRef,
    schedulePoll,
    updateWebSearchPanelState,
  } = input;
  if (pollState.isPollCancelled.current || webSearchPanelRunIdRef.current !== watchdogRunId) {
    return;
  }

  const current = webSearchPanelStateRef.current;
  const meetingId = current?.meetingId;
  if (
    current === null ||
    meetingId === undefined ||
    meetingId === null ||
    meetingId.length === 0 ||
    current.contentKind === "meeting-answer" ||
    !isVoiceWebSearchLookingForAnswer(current)
  ) {
    return;
  }

  try {
    const runs = await listMeetingWebResearchRuns({
      token,
      meetingId,
      signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
    });
    const matchingRun = selectWebSearchRunForPayload({ runs, parsed: current });
    const researchRunId = matchingRun?.researchRunId;
    if (researchRunId === undefined || researchRunId.length === 0) {
      schedulePoll(attempt + 1);

      return;
    }

    await applyPersistedWebSearchRunToPanel({
      token,
      meetingId,
      current,
      matchingRun: { researchRunId },
      pollState,
      watchdogRunId,
      webSearchPanelRunIdRef,
      schedulePoll,
      attempt,
      updateWebSearchPanelState,
    });
  } catch (error) {
    if (reportOptionalLiveServiceFailure({ error, feature: "research" })) {
      stopFailedLiveResearch({
        current: input.webSearchPanelStateRef.current,
        update: input.updateWebSearchPanelState,
        isCancelled: input.pollState.isPollCancelled.current,
        currentRunId: input.webSearchPanelRunIdRef.current,
        failedRunId: input.watchdogRunId,
      });

      return;
    }
    void describeCaughtFailure(error);
    schedulePoll(attempt + 1);
  }
}

function isVoiceWebSearchPanelAlreadyShowingResult(input: {
  isParsedLookingForAnswer: boolean;
  currentState: WebSearchPanelState | null;
  isCurrentPayloadMatching: boolean;
  isCurrentLookingForAnswer: boolean;
}): boolean {
  const { isParsedLookingForAnswer, currentState, isCurrentPayloadMatching, isCurrentLookingForAnswer } = input;
  if (isParsedLookingForAnswer || currentState === null || !isCurrentPayloadMatching || isCurrentLookingForAnswer) {
    return false;
  }

  return (
    currentState.status === "completed" ||
    currentState.status === "error" ||
    currentState.answerDisplay !== null ||
    currentState.answer !== null ||
    (currentState.answerPreview !== null && currentState.answerPreview.length > 0) ||
    currentState.results.length !== 0
  );
}

async function resolveVoiceWebSearchPanelResearchRunId(input: {
  researchToken: string;
  researchMeetingId: string;
  parsed: VoiceWebSearchPanelPayload;
  runId: string | null;
}): Promise<string | null> {
  if (input.runId !== null && input.runId.length > 0) {
    return input.runId;
  }

  return (
    selectWebSearchRunForPayload({
      runs: await listMeetingWebResearchRuns({
        token: input.researchToken,
        meetingId: input.researchMeetingId,
        signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
      }),
      parsed: input.parsed,
    })?.researchRunId ?? null
  );
}

function isVoiceWebSearchResearchPollPanelCurrent(input: {
  pollingPanelRunId: number;
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  parsed: VoiceWebSearchPanelPayload;
  run: { researchRunId: string };
}): boolean {
  if (input.webSearchPanelRunIdRef.current !== input.pollingPanelRunId) {
    return false;
  }
  const current = input.webSearchPanelStateRef.current;

  return (
    current === null ||
    (voiceWebSearchPayloadMatchesCurrent(current, input.parsed) &&
      webSearchRunMatchesPayload({ run: input.run, parsed: input.parsed, shouldAllowQueryMatch: true }))
  );
}

async function pollVoiceWebSearchPanelResearchRun(input: {
  researchToken: string;
  researchMeetingId: string;
  parsed: VoiceWebSearchPanelPayload;
  pollingPanelRunId: number;
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
  runId: string | null;
  attempt: number;
}): Promise<void> {
  const { runId, attempt } = input;
  if (input.webSearchPanelRunIdRef.current !== input.pollingPanelRunId) {
    return;
  }
  try {
    const resolvedRunId = await resolveVoiceWebSearchPanelResearchRunId({
      researchToken: input.researchToken,
      researchMeetingId: input.researchMeetingId,
      parsed: input.parsed,
      runId,
    });
    if (resolvedRunId === null || resolvedRunId.length === 0) {
      if (attempt < WEB_RESEARCH_POLL_MAX_ATTEMPTS_WITHOUT_RUN) {
        window.setTimeout(() => {
          void pollVoiceWebSearchPanelResearchRun({ ...input, runId: null, attempt: attempt + 1 });
        }, WEB_RESEARCH_POLL_INTERVAL_MS);
      }

      return;
    }
    const run = await getMeetingWebResearchRun({
      token: input.researchToken,
      meetingId: input.researchMeetingId,
      runId: resolvedRunId,
      signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
    });
    if (input.webSearchPanelRunIdRef.current !== input.pollingPanelRunId) {
      return;
    }
    const fullState = parseVoiceWebSearchPanelPayload(
      JSON.stringify({
        ...run,
        meetingId: input.parsed.meetingId,
        requestingUserId: input.parsed.requestingUserId,
      }),
    );
    const isStillCurrent = isVoiceWebSearchResearchPollPanelCurrent({
      pollingPanelRunId: input.pollingPanelRunId,
      webSearchPanelRunIdRef: input.webSearchPanelRunIdRef,
      webSearchPanelStateRef: input.webSearchPanelStateRef,
      parsed: input.parsed,
      run,
    });
    if (isStillCurrent) {
      input.updateWebSearchPanelState({
        ...fullState,
        updatedAt: Date.now(),
      });
    }
    if (
      isStillCurrent &&
      fullState.status !== "completed" &&
      fullState.status !== "error" &&
      attempt < WEB_RESEARCH_RUN_POLL_MAX_ATTEMPTS
    ) {
      window.setTimeout(
        () => {
          void pollVoiceWebSearchPanelResearchRun({ ...input, runId: resolvedRunId, attempt: attempt + 1 });
        },
        attempt < WEB_SEARCH_POLL_FAST_ATTEMPT_THRESHOLD
          ? WEB_SEARCH_POLL_FAST_INTERVAL_MS
          : WEB_SEARCH_POLL_SLOW_INTERVAL_MS,
      );
    }
  } catch (error) {
    if (reportOptionalLiveServiceFailure({ error, feature: "research" })) {
      stopFailedLiveResearch({
        current: input.webSearchPanelStateRef.current,
        update: input.updateWebSearchPanelState,
        isCancelled: false,
        currentRunId: input.webSearchPanelRunIdRef.current,
        failedRunId: input.pollingPanelRunId,
      });

      return;
    }
    void describeCaughtFailure(error);
    if (attempt < WEB_RESEARCH_RUN_POLL_RETRY_MAX_ATTEMPTS) {
      window.setTimeout(() => {
        void pollVoiceWebSearchPanelResearchRun({ ...input, runId, attempt: attempt + 1 });
      }, WEB_RESEARCH_RUN_POLL_RETRY_DELAY_MS);
    }
  }
}

function resetVoiceWebSearchDeferredPayloadTimer(input: {
  webSearchDeferredPayloadTimerRef: { current: number | null };
  webSearchDeferredPayloadResolveRef: { current: ((applied: boolean) => void) | null };
}): void {
  const { webSearchDeferredPayloadTimerRef, webSearchDeferredPayloadResolveRef } = input;
  if (webSearchDeferredPayloadTimerRef.current !== null) {
    window.clearTimeout(webSearchDeferredPayloadTimerRef.current);
    webSearchDeferredPayloadTimerRef.current = null;
  }
  webSearchDeferredPayloadResolveRef.current?.(false);
  webSearchDeferredPayloadResolveRef.current = null;
}

function openVoiceWebSearchAmbientPanel(input: {
  parsedState: WebSearchPanelState;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedRelevantDetailsItemKey: Dispatch<SetStateAction<string | null>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  const {
    parsedState,
    setIsPresencePanelOpen,
    setIsToolApprovalPanelOpen,
    setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen,
    setSelectedRelevantDetailsItemKey,
    setIsAmbientContextPanelOpen,
  } = input;
  setIsPresencePanelOpen(false);
  setIsToolApprovalPanelOpen(false);
  setIsMeetingDetailsPanelOpen(false);
  setIsMeetingSettingsPanelOpen(false);
  setSelectedRelevantDetailsItemKey(webSearchRelevantDetailsKey(parsedState));
  setIsAmbientContextPanelOpen(true);
}

async function revealVoiceWebSearchPanelParsedState(input: {
  parsed: VoiceWebSearchPanelPayload;
  parsedState: WebSearchPanelState;
  panelRunId: number;
  payloadKey: string;
  now: number;
  isParsedLookingForAnswer: boolean;
  shouldStageLoaderBeforeFinal: boolean;
  finalPayloadDelayMs: number;
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelSearchKeyRef: { current: string | null };
  webSearchPanelSearchStartedAtRef: { current: number | null };
  webSearchDeferredPayloadTimerRef: { current: number | null };
  webSearchDeferredPayloadResolveRef: { current: ((applied: boolean) => void) | null };
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
}): Promise<void> {
  const {
    parsed,
    parsedState,
    panelRunId,
    payloadKey,
    now,
    isParsedLookingForAnswer,
    shouldStageLoaderBeforeFinal,
    finalPayloadDelayMs,
    webSearchPanelRunIdRef,
    webSearchPanelSearchKeyRef,
    webSearchPanelSearchStartedAtRef,
    webSearchDeferredPayloadTimerRef,
    webSearchDeferredPayloadResolveRef,
    updateWebSearchPanelState,
  } = input;
  const applyParsedState = () => {
    if (webSearchPanelRunIdRef.current !== panelRunId) {
      return false;
    }
    if (!isParsedLookingForAnswer && webSearchPanelSearchKeyRef.current === payloadKey) {
      webSearchPanelSearchStartedAtRef.current = null;
    }
    updateWebSearchPanelState(parsedState);

    return true;
  };

  if (shouldStageLoaderBeforeFinal || finalPayloadDelayMs > 0) {
    const loadingState: WebSearchPanelState = {
      ...parsed,
      status: "searching",
      answer: null,
      answerDisplay: null,
      answerPreview: null,
      tinyCitations: [],
      results: [],
      message: null,
      progress: null,
      updatedAt: Date.now(),
    };
    if (shouldStageLoaderBeforeFinal) {
      if (webSearchPanelSearchKeyRef.current !== payloadKey) {
        webSearchPanelSearchKeyRef.current = payloadKey;
        webSearchPanelSearchStartedAtRef.current = now;
      }
      updateWebSearchPanelState(loadingState);
    }
    const isFinalApplied = await new Promise<boolean>((resolve) => {
      webSearchDeferredPayloadResolveRef.current = resolve;
      webSearchDeferredPayloadTimerRef.current = window.setTimeout(
        () => {
          webSearchDeferredPayloadTimerRef.current = null;
          webSearchDeferredPayloadResolveRef.current = null;
          resolve(applyParsedState());
        },
        shouldStageLoaderBeforeFinal ? WEB_SEARCH_LOADER_MIN_VISIBLE_MS : finalPayloadDelayMs,
      );
    });
    if (isFinalApplied && !isParsedLookingForAnswer) {
      await delay(WEB_SEARCH_LOADER_FADE_MS + WEB_SEARCH_LOADER_FADE_EXTRA_MS);
    }

    return;
  }

  const isFinalAppliedSync = applyParsedState();
  if (isFinalAppliedSync && !isParsedLookingForAnswer) {
    await delay(WEB_SEARCH_LOADER_FADE_MS + WEB_SEARCH_LOADER_FADE_EXTRA_MS);
  }
}

function syncVoiceWebSearchPanelRunBookkeepingFromRpc(input: {
  parsed: VoiceWebSearchPanelPayload;
  payloadKey: string;
  now: number;
  isParsedLookingForAnswer: boolean;
  isNewSearchStart: boolean;
  isCurrentPayloadMatching: boolean;
  isCurrentLookingForAnswer: boolean;
  isCurrentAlreadyShowingResult: boolean;
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelSearchStartedAtRef: { current: number | null };
  webSearchPanelSearchKeyRef: { current: string | null };
}): {
  panelRunId: number;
  shouldStageLoaderBeforeFinal: boolean;
  finalPayloadDelayMs: number;
} {
  const {
    payloadKey,
    now,
    isParsedLookingForAnswer,
    isNewSearchStart,
    isCurrentPayloadMatching,
    isCurrentLookingForAnswer,
    isCurrentAlreadyShowingResult,
    webSearchPanelRunIdRef,
    webSearchPanelSearchStartedAtRef,
    webSearchPanelSearchKeyRef,
  } = input;
  if (isNewSearchStart || (!isCurrentPayloadMatching && !isCurrentLookingForAnswer)) {
    webSearchPanelRunIdRef.current += 1;
    webSearchPanelSearchStartedAtRef.current = null;
    webSearchPanelSearchKeyRef.current = null;
  }
  const panelRunId = webSearchPanelRunIdRef.current;
  if (isParsedLookingForAnswer) {
    if (webSearchPanelSearchKeyRef.current !== payloadKey || webSearchPanelSearchStartedAtRef.current === null) {
      webSearchPanelSearchKeyRef.current = payloadKey;
      webSearchPanelSearchStartedAtRef.current = now;
    }
  }
  const matchingSearchStartedAt =
    webSearchPanelSearchKeyRef.current === payloadKey ? webSearchPanelSearchStartedAtRef.current : null;
  const shouldStageLoaderBeforeFinal =
    !isParsedLookingForAnswer &&
    !isCurrentAlreadyShowingResult &&
    (!isCurrentPayloadMatching || !isCurrentLookingForAnswer);
  const finalPayloadDelayMs =
    !isParsedLookingForAnswer && !isCurrentAlreadyShowingResult
      ? Math.max(
          0,
          WEB_SEARCH_LOADER_MIN_VISIBLE_MS - (matchingSearchStartedAt !== null ? now - matchingSearchStartedAt : 0),
        )
      : 0;

  return { panelRunId, shouldStageLoaderBeforeFinal, finalPayloadDelayMs };
}

function buildVoiceWebSearchPanelShownRpcResult(parsed: VoiceWebSearchPanelPayload) {
  return {
    status: "shown" as const,
    panelStatus: parsed.status,
    query: parsed.query,
    resultCount: parsed.results.length,
  };
}

type RunVoiceWebSearchPanelFromRpcPayloadInput = {
  payload: string;
  session: AuthSession | null;
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelSearchStartedAtRef: { current: number | null };
  webSearchPanelSearchKeyRef: { current: string | null };
  webSearchDeferredPayloadTimerRef: { current: number | null };
  webSearchDeferredPayloadResolveRef: { current: ((applied: boolean) => void) | null };
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedRelevantDetailsItemKey: Dispatch<SetStateAction<string | null>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
};

function maybeStartVoiceWebSearchResearchPollFromRpc(input: {
  parsed: VoiceWebSearchPanelPayload;
  session: AuthSession | null;
  panelRunId: number;
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
}): void {
  const { parsed, session, panelRunId, webSearchPanelRunIdRef, webSearchPanelStateRef, updateWebSearchPanelState } =
    input;
  if (
    parsed.contentKind === "meeting-answer" ||
    session === null ||
    session.token.length === 0 ||
    parsed.meetingId === null ||
    parsed.meetingId.length === 0 ||
    isTerminalWebResearchRunStatus(parsed.status)
  ) {
    return;
  }
  const researchToken = session.token;
  const researchMeetingId = parsed.meetingId;
  if (researchToken.length === 0 || researchMeetingId.length === 0) {
    return;
  }
  void pollVoiceWebSearchPanelResearchRun({
    researchToken,
    researchMeetingId,
    parsed,
    pollingPanelRunId: panelRunId,
    webSearchPanelRunIdRef,
    webSearchPanelStateRef,
    updateWebSearchPanelState,
    runId: parsed.researchRunId,
    attempt: 0,
  });
}

async function runVoiceWebSearchPanelFromRpcPayload(input: RunVoiceWebSearchPanelFromRpcPayloadInput) {
  const {
    payload,
    session,
    webSearchPanelStateRef,
    webSearchPanelRunIdRef,
    webSearchPanelSearchStartedAtRef,
    webSearchPanelSearchKeyRef,
    webSearchDeferredPayloadTimerRef,
    webSearchDeferredPayloadResolveRef,
    updateWebSearchPanelState,
    setIsPresencePanelOpen,
    setIsToolApprovalPanelOpen,
    setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen,
    setSelectedRelevantDetailsItemKey,
    setIsAmbientContextPanelOpen,
  } = input;
  const parsed = parseVoiceWebSearchPanelPayload(payload);
  const parsedState = { ...parsed, updatedAt: Date.now() };
  const now = Date.now();
  const payloadKey = webSearchPayloadKey(parsed);
  const currentState = webSearchPanelStateRef.current;
  const isParsedLookingForAnswer = isVoiceWebSearchLookingForAnswer(parsed);
  const isCurrentPayloadMatching = voiceWebSearchPayloadMatchesCurrent(currentState, parsed);
  const isCurrentLookingForAnswer = isVoiceWebSearchLookingForAnswer(currentState);
  const isNewSearchStart = parsed.status === "searching";
  const isCurrentAlreadyShowingResult = isVoiceWebSearchPanelAlreadyShowingResult({
    isParsedLookingForAnswer,
    currentState,
    isCurrentPayloadMatching,
    isCurrentLookingForAnswer,
  });
  if (!isNewSearchStart && currentState !== null && isCurrentLookingForAnswer && !isCurrentPayloadMatching) {
    return {
      status: "ignored" as const,
      panelStatus: parsed.status,
      query: parsed.query,
      resultCount: parsed.results.length,
      reason: "stale_web_search_payload" as const,
    };
  }

  const { panelRunId, shouldStageLoaderBeforeFinal, finalPayloadDelayMs } =
    syncVoiceWebSearchPanelRunBookkeepingFromRpc({
      parsed,
      payloadKey,
      now,
      isParsedLookingForAnswer,
      isNewSearchStart,
      isCurrentPayloadMatching,
      isCurrentLookingForAnswer,
      isCurrentAlreadyShowingResult,
      webSearchPanelRunIdRef,
      webSearchPanelSearchStartedAtRef,
      webSearchPanelSearchKeyRef,
    });

  resetVoiceWebSearchDeferredPayloadTimer({
    webSearchDeferredPayloadTimerRef,
    webSearchDeferredPayloadResolveRef,
  });
  openVoiceWebSearchAmbientPanel({
    parsedState,
    setIsPresencePanelOpen,
    setIsToolApprovalPanelOpen,
    setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen,
    setSelectedRelevantDetailsItemKey,
    setIsAmbientContextPanelOpen,
  });

  await revealVoiceWebSearchPanelParsedState({
    parsed,
    parsedState,
    panelRunId,
    payloadKey,
    now,
    isParsedLookingForAnswer,
    shouldStageLoaderBeforeFinal,
    finalPayloadDelayMs,
    webSearchPanelRunIdRef,
    webSearchPanelSearchKeyRef,
    webSearchPanelSearchStartedAtRef,
    webSearchDeferredPayloadTimerRef,
    webSearchDeferredPayloadResolveRef,
    updateWebSearchPanelState,
  });

  maybeStartVoiceWebSearchResearchPollFromRpc({
    parsed,
    session,
    panelRunId,
    webSearchPanelRunIdRef,
    webSearchPanelStateRef,
    updateWebSearchPanelState,
  });

  return buildVoiceWebSearchPanelShownRpcResult(parsed);
}

type AssistantTurnConflictPayload = {
  type: "assistant_turn_conflict";
  reason: "another_participant_active";
  speakerDisplayName?: string;
};

type ParticipantVisual = {
  id: string;
  displayName: string;
  email?: string | null;
  avatarUrl?: string | null;
  callerPhoneNumber?: string | null;
  isLocal: boolean;
  trackView?: TrackView;
  speechSource: ParticipantSpeechSource;
};

type AgentHelpPhase = "idle" | "thinking" | "speaking";

// Generation is capped server-side (OPENAI_MEETING_AGENT_HELP_TIMEOUT_MS,
// default 20s); this is a client-side fallback in case the end-of-turn
// presence message never arrives.
const AGENT_HELP_THINKING_TIMEOUT_MS = 45_000;
// How long the agent may stay silent in the "speaking" phase before the
// button falls back to idle when no end-of-turn presence message arrives.
const AGENT_HELP_SPEAKING_END_GRACE_MS = 2_500;

type ScreenShareVisual = {
  id: string;
  displayName: string;
  isLocal: boolean;
  trackView: TrackView;
};

type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenCapableDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

type TranscriptionState = "off" | "ready" | "starting" | "on" | "error";
type EndMeetingAction = "leave" | "end_for_all";
type BrowserMediaPermissionState = PermissionState | "unknown" | "unsupported";

function FullscreenToggleIcon({ isFullscreen }: { isFullscreen: boolean }) {
  if (isFullscreen) {
    return (
      <svg aria-hidden="true" viewBox="0 0 21.2803 21.5381" className="control-button-icon" fill="none">
        <path
          d="M1.93359 9.73242L7.89551 9.73242C8.99121 9.73242 9.625 9.08789 9.625 7.99219L9.625 2.04102C9.625 1.48242 9.20605 1.04199 8.63672 1.04199C8.06738 1.04199 7.65918 1.47168 7.65918 2.04102L7.65918 2.94336L7.88477 6.69238L5.04883 3.7168L1.75098 0.386719C1.56836 0.193359 1.32129 0.0966797 1.06348 0.0966797C0.451172 0.0966797 0 0.504883 0 1.10645C0 1.38574 0.107422 1.6543 0.300781 1.84766L3.60938 5.15625L6.58496 7.98145L2.83594 7.7666L1.93359 7.7666C1.36426 7.7666 0.923828 8.16406 0.923828 8.74414C0.923828 9.31348 1.35352 9.73242 1.93359 9.73242ZM12.2354 20.6357C12.8047 20.6357 13.2129 20.2168 13.2129 19.6367L13.2129 18.6162L12.9873 14.8779L15.8232 17.8535L19.1963 21.248C19.3789 21.4414 19.6152 21.5381 19.8838 21.5381C20.4854 21.5381 20.9365 21.1299 20.9365 20.5283C20.9365 20.249 20.8398 19.9805 20.6465 19.7871L17.2627 16.4033L14.2764 13.5781L18.0361 13.793L19.0566 13.793C19.626 13.793 20.0664 13.3955 20.0664 12.8262C20.0664 12.2461 19.6367 11.8379 19.0566 11.8379L12.9766 11.8379C11.8809 11.8379 11.2471 12.4717 11.2471 13.5674L11.2471 19.6367C11.2471 20.2061 11.6553 20.6357 12.2354 20.6357Z"
          fill="currentColor"
          fillOpacity="0.92"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 20.8184 20.5068" className="control-button-icon" fill="none">
      <path
        d="M0.988281 8.69043C1.55762 8.69043 1.96582 8.26074 1.96582 7.69141L1.96582 6.78906L1.75098 3.04004L4.57617 6.01562L7.88477 9.3457C8.06738 9.53906 8.30371 9.625 8.56152 9.625C9.17383 9.625 9.625 9.22754 9.625 8.62598C9.625 8.33594 9.52832 8.07812 9.33496 7.88477L6.01562 4.57617L3.04004 1.75098L6.7998 1.96582L7.69141 1.96582C8.26074 1.96582 8.70117 1.56836 8.70117 0.988281C8.70117 0.408203 8.27148 0 7.69141 0L1.72949 0C0.633789 0 0 0.633789 0 1.72949L0 7.69141C0 8.25 0.418945 8.69043 0.988281 8.69043ZM12.7725 20.4961L18.7344 20.4961C19.8301 20.4961 20.4746 19.8623 20.4746 18.7666L20.4746 12.8047C20.4746 12.2461 20.0557 11.8057 19.4756 11.8057C18.917 11.8057 18.498 12.2354 18.498 12.8047L18.498 13.707L18.7236 17.4561L15.8877 14.4805L12.5898 11.1504C12.4072 10.957 12.1602 10.8711 11.9023 10.8711C11.3008 10.8711 10.8389 11.2686 10.8389 11.8701C10.8389 12.1602 10.9463 12.418 11.1396 12.6113L14.4482 15.9199L17.4346 18.7451L13.6748 18.5303L12.7725 18.5303C12.2031 18.5303 11.7627 18.9277 11.7627 19.5078C11.7627 20.0879 12.2031 20.4961 12.7725 20.4961Z"
        fill="currentColor"
        fillOpacity="0.92"
      />
    </svg>
  );
}

function AdmitGuestIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 72.6807 68.0908" className="live-admit-trigger-icon">
      <path
        d="M47.0136 40.1973C43.4793 43.0922 41.2109 47.4846 41.2109 52.3682C41.2109 53.6125 41.3577 54.8243 41.6503 55.9814L19.7998 55.9814C17.1875 55.9814 15.625 54.7607 15.625 52.7344C15.625 46.4355 23.5107 37.7441 36.1572 37.7441C40.3389 37.7441 43.9995 38.6908 47.0136 40.1973ZM45.9473 22.583C45.9473 28.6865 41.4062 33.374 36.1816 33.374C30.9326 33.374 26.416 28.6865 26.416 22.6318C26.416 16.6504 30.957 12.085 36.1816 12.085C41.4062 12.085 45.9473 16.5527 45.9473 22.583Z"
        fill="currentColor"
        fillOpacity="1"
      />
      <path
        d="M69.3604 52.3682C69.3604 59.1309 63.6719 64.7705 56.958 64.7705C50.1465 64.7705 44.5312 59.1797 44.5312 52.3682C44.5312 45.5566 50.1465 39.9658 56.958 39.9658C63.7451 39.9658 69.3604 45.5566 69.3604 52.3682ZM55.4443 46.0938L55.4443 50.8545L50.6836 50.8545C49.7803 50.8545 49.1699 51.4404 49.1699 52.3682C49.1699 53.2715 49.7803 53.8574 50.6836 53.8574L55.4443 53.8574L55.4443 58.6426C55.4443 59.5215 56.0303 60.1318 56.958 60.1318C57.8613 60.1318 58.4473 59.5215 58.4473 58.6426L58.4473 53.8574L63.208 53.8574C64.1113 53.8574 64.6973 53.2715 64.6973 52.3682C64.6973 51.4404 64.1113 50.8545 63.208 50.8545L58.4473 50.8545L58.4473 46.0938C58.4473 45.2148 57.8613 44.6045 56.958 44.6045C56.0303 44.6045 55.4443 45.2148 55.4443 46.0938Z"
        fill="currentColor"
        fillOpacity="1"
      />
    </svg>
  );
}

function LiveMeetingDeviceDropdownChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="live-meeting-device-dropdown-chevron" fill="none">
      <path
        d="M4.25 6.5L8 10.25L11.75 6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VideoTile({
  callerPhoneNumber,
  trackView,
  participantId,
  onAspectRatioChange,
  isFlipTarget = true,
}: {
  callerPhoneNumber?: string | null;
  trackView: TrackView;
  participantId: string;
  onAspectRatioChange?: (ratio: number) => void;
  isFlipTarget?: boolean;
}) {
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(trackView.isLocal);

  useEffect(() => {
    const video = mediaRef.current;
    if (!video || !onAspectRatioChange) {
      return;
    }
    const updateAspectRatio = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        onAspectRatioChange(video.videoWidth / video.videoHeight);
      }
    };
    video.addEventListener("resize", updateAspectRatio);
    updateAspectRatio();

    return () => video.removeEventListener("resize", updateAspectRatio);
  }, [trackView.track, onAspectRatioChange]);

  useEffect(() => {
    if (trackView.kind !== "video" || !mediaRef.current) {
      return;
    }

    const mediaElement = mediaRef.current;
    setIsVideoReady(trackView.isLocal);
    trackView.track.attach(mediaElement);

    return () => {
      trackView.track.detach(mediaElement);
    };
  }, [trackView.kind, trackView.track]);

  if (trackView.kind !== "video") {
    return null;
  }

  return (
    <article
      className={[
        "video-tile",
        "live-video-tile",
        "live-grid-video-tile",
        isFlipTarget ? "live-video-flip-target" : "",
        isVideoReady ? "is-ready" : "is-loading",
      ]
        .filter(Boolean)
        .join(" ")}
      data-participant-visual-id={isFlipTarget ? participantId : undefined}
    >
      <video
        autoPlay
        playsInline
        muted={trackView.isLocal}
        ref={mediaRef}
        className={[
          trackView.isLocal && trackView.source === Track.Source.Camera ? "meeting-camera-mirror" : "",
          isVideoReady ? "is-ready" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onLoadedData={() => setIsVideoReady(true)}
        onCanPlay={() => setIsVideoReady(true)}
        onPlaying={() => setIsVideoReady(true)}
      />
      <ParticipantTileCallerLabel callerPhoneNumber={callerPhoneNumber} />
    </article>
  );
}

function ScreenShareTile({
  participantId,
  trackView,
  variant,
  isSelected = false,
  onSelect,
}: {
  participantId: string;
  trackView: TrackView;
  variant: "stage" | "thumbnail";
  isSelected?: boolean;
  onSelect?: () => void;
}) {
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(trackView.isLocal);

  useEffect(() => {
    if (trackView.kind !== "video" || !mediaRef.current) {
      return;
    }

    const mediaElement = mediaRef.current;
    setIsVideoReady(trackView.isLocal);
    trackView.track.attach(mediaElement);

    return () => {
      trackView.track.detach(mediaElement);
    };
  }, [trackView.kind, trackView.track, trackView.isLocal]);

  if (trackView.kind !== "video") {
    return null;
  }

  const content = (
    <>
      <video
        autoPlay
        playsInline
        muted={trackView.isLocal}
        ref={mediaRef}
        className={isVideoReady ? "is-ready" : ""}
        onLoadedData={() => setIsVideoReady(true)}
        onCanPlay={() => setIsVideoReady(true)}
        onPlaying={() => setIsVideoReady(true)}
      />
    </>
  );

  if (variant === "thumbnail" && onSelect) {
    return (
      <button
        type="button"
        className={`live-screen-share-thumbnail${isSelected ? " is-selected" : ""}`}
        onClick={onSelect}
        aria-label="Focus shared screen"
        title="Focus shared screen"
      >
        {content}
      </button>
    );
  }

  return (
    <article
      className={`live-screen-share-stage live-video-flip-target${variant === "thumbnail" ? " live-screen-share-thumbnail" : ""}`}
      data-participant-visual-id={participantId}
      aria-label="Shared screen"
    >
      {content}
    </article>
  );
}

function ParticipantMediaTile({ participant }: { participant: ParticipantVisual }) {
  const videoTrackView = participant.trackView?.kind === "video" ? participant.trackView : null;
  const isBlurReady = useCameraBlurReady(
    videoTrackView?.track instanceof LocalVideoTrack ? videoTrackView.track : null,
  );
  const isVideoOn = Boolean(videoTrackView) && isBlurReady;
  const [videoAspectRatio, setVideoAspectRatio] = useState(VIDEO_TILE_ASPECT_WIDTH / VIDEO_TILE_ASPECT_HEIGHT);
  const [renderedVideoTrackView, setRenderedVideoTrackView] = useState<TrackView | null>(videoTrackView);
  const [isHandoffActive, setIsHandoffActive] = useState(false);
  const previousIsVideoOnRef = useRef(isVideoOn);

  useEffect(() => {
    if (videoTrackView) {
      setRenderedVideoTrackView(videoTrackView);

      return undefined;
    }

    if (renderedVideoTrackView === null) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setRenderedVideoTrackView(null);
    }, LIVE_MEDIA_HANDOFF_VIDEO_EXIT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [renderedVideoTrackView, videoTrackView]);

  useEffect(() => {
    if (previousIsVideoOnRef.current === isVideoOn) {
      return undefined;
    }

    previousIsVideoOnRef.current = isVideoOn;
    setIsHandoffActive(true);

    const timeoutId = window.setTimeout(() => {
      setIsHandoffActive(false);
    }, LIVE_MEDIA_HANDOFF_LAYER_HINT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isVideoOn]);

  return (
    <div
      className={[
        "live-media-handoff-tile",
        "live-video-flip-target",
        isVideoOn ? "is-video-on" : "",
        isHandoffActive ? "is-handoff-active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-participant-visual-id={participant.id}
      style={
        {
          "--live-camera-aspect-ratio": videoAspectRatio,
        } satisfies React.CSSProperties & { "--live-camera-aspect-ratio": number }
      }
    >
      <div className="live-media-avatar-layer" aria-hidden={isVideoOn}>
        <AvatarTile
          participantId={participant.id}
          displayName={participant.displayName}
          email={participant.email}
          avatarUrl={participant.avatarUrl}
          callerPhoneNumber={participant.callerPhoneNumber}
          speechSource={participant.speechSource}
          isSpeechVisible={!isVideoOn || isHandoffActive}
          isFlipTarget={false}
        />
      </div>
      <div
        className="live-media-video-layer"
        aria-hidden={!isVideoOn}
        style={{ visibility: isBlurReady ? "visible" : "hidden" }}
      >
        {renderedVideoTrackView ? (
          <VideoTile
            callerPhoneNumber={participant.callerPhoneNumber}
            trackView={renderedVideoTrackView}
            participantId={participant.id}
            isFlipTarget={false}
            onAspectRatioChange={setVideoAspectRatio}
          />
        ) : null}
      </div>
    </div>
  );
}

function AudioSink({ trackView }: { trackView: TrackView }) {
  const mediaRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (trackView.kind !== "audio" || !mediaRef.current) {
      return;
    }

    const mediaElement = mediaRef.current;
    trackView.track.attach(mediaElement);

    return () => {
      trackView.track.detach(mediaElement);
    };
  }, [trackView.kind, trackView.track]);

  if (trackView.kind !== "audio") {
    return null;
  }

  return <audio autoPlay ref={mediaRef} />;
}

function getTrackViews(input: { room: Room }): TrackView[] {
  const collectTrackViewsFromParticipant = (participantInput: {
    participant: Participant;
    isLocal: boolean;
  }): TrackView[] =>
    [...participantInput.participant.trackPublications.values()].flatMap((publication) => {
      const track = publication.track;
      if (!track || (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio)) {
        return [];
      }

      const source = track.source !== Track.Source.Unknown ? track.source : publication.source;

      return [
        {
          id: `${participantInput.participant.identity}-${publication.trackSid}`,
          kind: track.kind === Track.Kind.Video ? "video" : "audio",
          source,
          track,
          isLocal: participantInput.isLocal,
          participantIdentity: participantInput.participant.identity,
          participantName: participantInput.participant.name,
        },
      ];
    });

  const localTrackViews = collectTrackViewsFromParticipant({
    participant: input.room.localParticipant,
    isLocal: true,
  });
  const remoteTrackViews = [...input.room.remoteParticipants.values()].flatMap((participant) =>
    collectTrackViewsFromParticipant({ participant, isLocal: false }),
  );

  return [...localTrackViews, ...remoteTrackViews];
}

function areTrackViewsEqual(input: { previous: TrackView[]; next: TrackView[] }) {
  if (input.previous.length !== input.next.length) {
    return false;
  }

  return input.previous.every((trackView, index) => {
    const nextTrackView = input.next[index];
    if (!nextTrackView) {
      return false;
    }

    return (
      trackView.id === nextTrackView.id &&
      trackView.kind === nextTrackView.kind &&
      trackView.source === nextTrackView.source &&
      trackView.track === nextTrackView.track &&
      trackView.isLocal === nextTrackView.isLocal &&
      trackView.participantIdentity === nextTrackView.participantIdentity &&
      trackView.participantName === nextTrackView.participantName
    );
  });
}

function isScreenShareTrack(trackView: TrackView) {
  return trackView.kind === "video" && trackView.source === Track.Source.ScreenShare;
}

function isActiveScreenShareTrack(trackView: TrackView) {
  if (!isScreenShareTrack(trackView)) {
    return false;
  }

  const mediaStreamTrack = trackView.track.mediaStreamTrack;

  return mediaStreamTrack.readyState !== "ended";
}

function getErrorMessage(input: { error: unknown; fallback: string }) {
  if (input.error instanceof ApiError) {
    return input.error.displayMessage;
  }

  return input.error instanceof Error ? input.error.message : input.fallback;
}

function getMediaDiagnosticFailure(error: unknown): NonNullable<MeetingClientDiagnostic["failure"]> {
  const mediaError = error instanceof Error ? error : null;
  const failure = mediaError ? MediaDeviceFailure.getFailure(mediaError) : undefined;

  return failure === MediaDeviceFailure.PermissionDenied
    ? "permission-denied"
    : failure === MediaDeviceFailure.NotFound
      ? "not-found"
      : failure === MediaDeviceFailure.DeviceInUse
        ? "device-in-use"
        : "other";
}

function getClientDiagnosticError(error: unknown) {
  const resolved =
    error instanceof Error
      ? error
      : new Error(
          typeof error === "string" || typeof error === "number"
            ? String(error)
            : LIVE_MEETING_PAGE_COPY.unknownClientError,
        );

  return {
    failure: getMediaDiagnosticFailure(resolved),
    errorName: resolved.name.slice(0, CLIENT_DIAGNOSTIC_ERROR_NAME_MAX_LENGTH),
    errorMessage: resolved.message.slice(0, CLIENT_DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH),
  };
}

function getTrackSubscriptionDiagnosticError(reason: SubscriptionError | undefined) {
  const errorMessage = (() => {
    switch (reason) {
      case SubscriptionError.SE_CODEC_UNSUPPORTED:
        return LIVE_MEETING_PAGE_COPY.codecUnsupported;
      case SubscriptionError.SE_TRACK_NOTFOUND:
        return LIVE_MEETING_PAGE_COPY.trackNotFound;
      case SubscriptionError.SE_UNKNOWN:
        return LIVE_MEETING_PAGE_COPY.unknownSubscriptionError;
      case undefined:
        return LIVE_MEETING_PAGE_COPY.noSubscriptionFailureReason;
      default:
        return `Subscription error ${String(reason)}`;
    }
  })();

  return {
    failure: "other" as const,
    errorName: "LiveKitSubscriptionError",
    errorMessage,
  };
}

function getDiagnosticTrackKind(source: Track.Source | undefined): MeetingClientDiagnostic["kind"] {
  switch (source) {
    case Track.Source.Camera:
      return "camera";
    case Track.Source.Microphone:
      return "microphone";
    case Track.Source.ScreenShare:
      return "screen-share";
    case Track.Source.ScreenShareAudio:
      return "screen-share-audio";
    case Track.Source.Unknown:
    case undefined:
      return "unknown";
  }
}

function isTrackAttachedToVisibleVideo(publication: RemoteTrackPublication) {
  if (
    publication.kind !== Track.Kind.Video ||
    publication.isMuted ||
    !publication.isSubscribed ||
    document.visibilityState !== "visible"
  ) {
    return false;
  }

  return Boolean(
    publication.track?.attachedElements.some((element) => {
      if (!element.isConnected || element.hidden) {
        return false;
      }
      if (document.pictureInPictureElement === element) {
        return true;
      }
      const bounds = element.getBoundingClientRect();

      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.bottom > 0 &&
        bounds.right > 0 &&
        bounds.top < window.innerHeight &&
        bounds.left < window.innerWidth
      );
    }),
  );
}

function sendMeetingClientDiagnostic(input: {
  token: string;
  meetingId: string;
  diagnostic: MeetingClientDiagnostic;
  options?: {
    /** @external fetch RequestInit keepalive */
    keepalive?: boolean;
  };
}) {
  void (async () => {
    try {
      await reportMeetingClientDiagnostic({
        token: input.token,
        meetingId: input.meetingId,
        input: input.diagnostic,
        options: input.options ?? {},
      });
    } catch (error) {
      void describeCaughtFailure(error);
    }
  })();
}

async function reportMeetingMediaHealthFromDiagnosticContext(input: {
  getDiagnosticContext: () => { token: string; meetingId: string } | null;
  reports: Parameters<MediaHealthReporter>[0];
  options: Parameters<MediaHealthReporter>[1];
}) {
  const context = input.getDiagnosticContext();
  if (context === null) {
    return undefined;
  }

  return reportMeetingMediaQuality({
    token: context.token,
    meetingId: context.meetingId,
    reports: input.reports,
    options: input.options,
  });
}

const DIAGNOSTIC_DISCONNECT_REASONS = [
  "unknown",
  "client-initiated",
  "duplicate-identity",
  "server-shutdown",
  "participant-removed",
  "room-deleted",
  "state-mismatch",
  "join-failure",
  "migration",
  "signal-close",
  "room-closed",
  "user-unavailable",
  "user-rejected",
  "sip-trunk-failure",
  "connection-timeout",
  "media-failure",
  "agent-error",
] as const;

function getDiagnosticDisconnectReason(reason: DisconnectReason | undefined) {
  return DIAGNOSTIC_DISCONNECT_REASONS[reason ?? DisconnectReason.UNKNOWN_REASON];
}

function reportMeetingMediaIssue(input: {
  token: string;
  meetingId: string;
  kind: "camera" | "microphone" | "unknown";
  phase: "join-acquire" | "join-publish" | "room-enable" | "room-device-event";
  error: unknown;
  /** @external existing wire contract */
  selectedDevice: boolean;
  /** @external existing wire contract */
  fallbackAttempted: boolean;
  /** @external existing wire contract */
  recovered: boolean;
}) {
  const mediaError = input.error instanceof Error ? input.error : null;
  const fallbackError =
    input.error instanceof MeetingCameraFallbackError && input.error.fallbackError instanceof Error
      ? input.error.fallbackError
      : null;
  const diagnosticFailure = getMediaDiagnosticFailure(mediaError);

  void (async () => {
    try {
      await reportMeetingMediaDiagnostic({
        token: input.token,
        meetingId: input.meetingId,
        input: {
          kind: input.kind,
          phase: input.phase,
          failure: diagnosticFailure,
          errorName: mediaError?.name.slice(0, CLIENT_DIAGNOSTIC_ERROR_NAME_MAX_LENGTH),
          errorMessage: mediaError?.message.slice(0, CLIENT_DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH),
          fallbackErrorName: fallbackError?.name.slice(0, CLIENT_DIAGNOSTIC_ERROR_NAME_MAX_LENGTH),
          fallbackErrorMessage: fallbackError?.message.slice(0, CLIENT_DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH),
          selectedDevice: input.selectedDevice,
          fallbackAttempted: input.fallbackAttempted,
          recovered: input.recovered,
        },
      });
    } catch (error) {
      void describeCaughtFailure(error);
    }
  })();
}

function getLocalMediaSourceEnabled(input: { room: Room; source: Track.Source }) {
  const publication = input.room.localParticipant.getTrackPublication(input.source);
  const localTrack = publication?.track;
  if (publication === undefined || localTrack === undefined) {
    return false;
  }

  const mediaStreamTrack = localTrack.mediaStreamTrack;

  return !publication.isMuted && mediaStreamTrack.readyState === "live" && mediaStreamTrack.enabled;
}

function getScreenShareErrorMessage(error: unknown) {
  const record = isRecord(error) ? error : null;
  const name = typeof record?.name === "string" ? record.name : "";
  const message = typeof record?.message === "string" ? record.message : "";

  if (name === "NotAllowedError" || name === "AbortError") {
    return null;
  }

  if (name === "NotFoundError") {
    return LIVE_MEETING_PAGE_COPY.screenShareChooseSource;
  }

  if (name === "NotReadableError") {
    return LIVE_MEETING_PAGE_COPY.screenShareUnavailable;
  }

  if (name === "InvalidStateError") {
    return LIVE_MEETING_PAGE_COPY.screenShareNeedsTab;
  }

  if (/getDisplayMedia|screen share|screenshare/i.test(message)) {
    return message;
  }

  return LIVE_MEETING_PAGE_COPY.screenShareFailed;
}

function chooseWinningPresentationClaim(input: { claims: PresentationClaim[] }) {
  return (
    [...input.claims].sort((left, right) => {
      if (left.requestedAt !== right.requestedAt) {
        return left.requestedAt - right.requestedAt;
      }

      return left.participantIdentity.localeCompare(right.participantIdentity);
    })[0] ?? null
  );
}

function getFreshPresentationClaims(input: { claims: PresentationClaim[]; now?: number }) {
  const now = input.now ?? Date.now();

  return input.claims.filter((claim) => isPlausiblePresentationClaimTimestamp({ requestedAt: claim.requestedAt, now }));
}

// Compatibility with participants using pre-permission-change tokens/clients.
function getParticipantPresentationClaim(participant: Participant): PresentationClaim | null {
  const presentationState = participant.attributes[PRESENTATION_STATE_ATTRIBUTE]?.trim();
  if (presentationState !== "starting") {
    return null;
  }

  const requestedAtValue = participant.attributes[PRESENTATION_REQUESTED_AT_ATTRIBUTE]?.trim();
  const requestedAt = Number(requestedAtValue);
  if (!Number.isFinite(requestedAt)) {
    return null;
  }

  return {
    participantIdentity: participant.identity,
    participantName: participant.name ?? participant.identity,
    requestedAt,
  };
}

function isPresentationClaimFromCurrentRoom(input: { room: Room; claim: PresentationClaim }) {
  return (
    input.claim.participantIdentity === input.room.localParticipant.identity ||
    input.room.remoteParticipants.has(input.claim.participantIdentity)
  );
}

function upsertPresentationClaim(input: {
  claimsByIdentity: Record<string, PresentationClaim>;
  claim: PresentationClaim;
}) {
  const existing = input.claimsByIdentity[input.claim.participantIdentity] ?? null;
  if (
    existing !== null &&
    existing.requestedAt === input.claim.requestedAt &&
    existing.participantName === input.claim.participantName
  ) {
    return input.claimsByIdentity;
  }

  return {
    ...input.claimsByIdentity,
    [input.claim.participantIdentity]: input.claim,
  };
}

function removePresentationClaim(input: {
  claimsByIdentity: Record<string, PresentationClaim>;
  participantIdentity: string;
}) {
  if (input.claimsByIdentity[input.participantIdentity] === undefined) {
    return input.claimsByIdentity;
  }

  const next = { ...input.claimsByIdentity };
  delete next[input.participantIdentity];

  return next;
}

function getRemoteActiveScreenShareParticipant(room: Room) {
  const remoteScreenShareTrack = getTrackViews({ room }).find(
    (trackView) => !trackView.isLocal && isActiveScreenShareTrack(trackView),
  );

  if (!remoteScreenShareTrack) {
    return null;
  }

  return room.remoteParticipants.get(remoteScreenShareTrack.participantIdentity) ?? null;
}

function getCurrentFullscreenElement() {
  const fullscreenDocument = document as FullscreenCapableDocument;

  return fullscreenDocument.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;
}

async function requestElementFullscreen(element: HTMLElement) {
  const fullscreenElement = element as FullscreenCapableElement;
  if (typeof fullscreenElement.requestFullscreen === "function") {
    await fullscreenElement.requestFullscreen();

    return;
  }

  if (typeof fullscreenElement.webkitRequestFullscreen === "function") {
    await fullscreenElement.webkitRequestFullscreen();

    return;
  }

  throw new Error(LIVE_MEETING_PAGE_COPY.fullscreenUnsupported);
}

async function exitCurrentFullscreen() {
  const fullscreenDocument = document as FullscreenCapableDocument;
  if (typeof fullscreenDocument.exitFullscreen === "function") {
    await fullscreenDocument.exitFullscreen();

    return;
  }

  if (typeof fullscreenDocument.webkitExitFullscreen === "function") {
    await fullscreenDocument.webkitExitFullscreen();

    return;
  }

  throw new Error(LIVE_MEETING_PAGE_COPY.fullscreenUnsupported);
}

function getRpcErrorData(error: unknown) {
  if (!isRecord(error)) {
    return null;
  }

  const data = error.data;

  return typeof data === "string" ? data : null;
}

async function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatLiveRoomClock(date = new Date()) {
  return LIVE_ROOM_CLOCK_FORMATTER.format(date).replace(/\u202f/g, " ");
}

function getMsUntilNextMinute(date = new Date()) {
  return Math.max(
    LIVE_ROOM_CLOCK_MS_UNTIL_NEXT_MINUTE_MIN,
    (LIVE_ROOM_CLOCK_SECONDS_PER_MINUTE - date.getSeconds()) * LIVE_ROOM_CLOCK_MS_PER_SECOND -
      date.getMilliseconds() +
      LIVE_ROOM_CLOCK_NEXT_MINUTE_PADDING_MS,
  );
}

function getLiveMeetingJoinUrl(input: { meeting: Pick<Meeting, "roomName" | "meetingLink">; origin: string }) {
  const path = getMeetingPublicPath(input.meeting);

  return input.origin.length > 0 ? new URL(path, input.origin).toString() : path;
}

type LiveMeetingCallInInfo = {
  phoneNumber: string;
  pin: string;
};

function getSipParticipantPhoneNumber(participant: Participant) {
  const phoneNumber = participant.attributes[SIP_PHONE_NUMBER_ATTRIBUTE]?.trim() ?? "";
  if (phoneNumber.length === 0) {
    return null;
  }

  const sipCallId = participant.attributes[SIP_CALL_ID_ATTRIBUTE]?.trim() ?? "";
  if (participant.kind !== ParticipantKind.SIP && sipCallId.length === 0) {
    return null;
  }

  return phoneNumber;
}

function getLiveMeetingJoiningInfo(input: { title: string; joinUrl: string; callIn?: LiveMeetingCallInInfo | null }) {
  const lines = [
    ...(!isDefaultInstantMeetingTitle(input.title) ? [input.title] : []),
    `Join Ready meeting: ${input.joinUrl}`,
    ...(input.callIn !== undefined && input.callIn !== null
      ? [`Dial-in: ${input.callIn.phoneNumber}`, `PIN: ${input.callIn.pin}#`]
      : []),
  ];

  return lines.join("\n");
}

function isDefaultInstantMeetingTitle(title: string) {
  return title.trim().toLowerCase() === "instant meeting";
}

function isMethodNotSupportedError(error: unknown) {
  return error instanceof Error && /Method not supported at destination/i.test(error.message);
}

function formatPersonalAssistantName(input: { displayName?: string | null; email?: string | null }) {
  const normalizedDisplayName = input.displayName?.trim().replace(/\s+/g, " ");
  const normalizedEmail = input.email?.trim();
  const firstName =
    normalizedDisplayName?.split(" ").find(Boolean) ??
    normalizedEmail?.split("@")[0]?.split(/[._-]/).find(Boolean) ??
    "Participant";

  return `${firstName}'s Assistant`;
}

function getParticipantUserId(participant: Participant) {
  const attributeUserId = participant.attributes.userId?.trim() ?? "";
  if (attributeUserId.length > 0) {
    return attributeUserId;
  }

  const identityPrefix = participant.identity.split(":", 1)[0]?.trim() ?? "";

  return identityPrefix.length > 0 ? identityPrefix : null;
}

function getParticipantAvatarUrl(input: {
  participant: Participant;
  participantAvatarUrls: {
    avatarUrlsByUserId: Map<string, string | null | undefined>;
    avatarUrlsByDisplayName: Map<string, string | null | undefined>;
  };
}) {
  const attributeAvatarUrl = input.participant.attributes.avatarUrl?.trim() ?? "";
  if (attributeAvatarUrl.length > 0) {
    return attributeAvatarUrl;
  }

  const participantUserId = getParticipantUserId(input.participant);
  if (participantUserId !== null) {
    const matchingAvatarUrl = input.participantAvatarUrls.avatarUrlsByUserId.get(participantUserId);
    if (matchingAvatarUrl !== null && matchingAvatarUrl !== undefined && matchingAvatarUrl.length > 0) {
      return matchingAvatarUrl;
    }
  }

  const participantDisplayName =
    input.participant.name ?? (input.participant.identity.length > 0 ? input.participant.identity : "Participant");

  return input.participantAvatarUrls.avatarUrlsByDisplayName.get(participantDisplayName.trim().toLowerCase()) ?? null;
}

function getStableSpeakerIdentityFromParticipant(participant?: Participant) {
  if (!participant) {
    return "unknown";
  }

  if (isMeetingAgentParticipant(participant)) {
    return participant.identity;
  }

  return getParticipantUserId(participant) ?? participant.identity;
}

function getAssistantDisplayName(participant: Participant) {
  const attributeDisplayName = participant.attributes.assistantDisplayName?.trim() ?? "";
  if (attributeDisplayName.length > 0) {
    return attributeDisplayName;
  }

  const normalizedName = participant.name?.trim() ?? "";
  if (normalizedName.length > 0) {
    return normalizedName;
  }

  return LIVE_MEETING_PAGE_COPY.defaultAssistantDisplayName;
}

function isGenericAssistantSpeakerName(speakerName: string) {
  const normalized = speakerName.trim().toLowerCase();

  return normalized === "assistant" || normalized === "readymeet assistant";
}

type AssistantPresencePayload = {
  assistantIdentity: string;
  assistantDisplayName: string;
  /** @external realtime assistant presence payload */
  active?: boolean;
  phase?: "thinking";
  assistantOwnerUserId?: string;
  assistantOwnerParticipantIdentity?: string;
  /** @external realtime assistant presence payload */
  conversationModeActive?: boolean;
};

function getAssistantPresencePayloadFromParticipant(participant: Participant): AssistantPresencePayload | null {
  if (!isMeetingAgentParticipant(participant)) {
    return null;
  }

  const ownerUserId = participant.attributes.assistantOwnerUserId?.trim() ?? "";
  const ownerParticipantIdentity = participant.attributes.assistantOwnerParticipantIdentity?.trim() ?? "";
  const phase = participant.attributes[ASSISTANT_PHASE_ATTRIBUTE] === "thinking" ? "thinking" : undefined;
  const isConversationModeActive = participant.attributes.assistantConversationMode === "active";
  const isPresenceActive =
    ownerUserId.length > 0 || ownerParticipantIdentity.length > 0 || phase !== undefined || isConversationModeActive;

  return {
    assistantIdentity: participant.identity,
    assistantDisplayName: getAssistantDisplayName(participant),
    active: isPresenceActive,
    phase,
    assistantOwnerUserId: ownerUserId.length > 0 ? ownerUserId : undefined,
    assistantOwnerParticipantIdentity: ownerParticipantIdentity.length > 0 ? ownerParticipantIdentity : undefined,
    conversationModeActive: isConversationModeActive,
  };
}

function isValidAssistantPresenceWireRecord(record: Record<string, unknown>): record is Record<string, unknown> & {
  assistantIdentity: string;
  assistantDisplayName: string;
  /** @external assistant presence wire field */
  active?: boolean;
  /** @external assistant presence wire field */
  conversationModeActive?: boolean;
} {
  return (
    typeof record.assistantIdentity === "string" &&
    record.assistantIdentity.startsWith(ASSISTANT_IDENTITY_PREFIX) &&
    typeof record.assistantDisplayName === "string" &&
    record.assistantDisplayName.trim().length !== 0 &&
    (record.active === undefined || typeof record.active === "boolean") &&
    (record.conversationModeActive === undefined || typeof record.conversationModeActive === "boolean")
  );
}

function parseAssistantPresenceValue(value: unknown): AssistantPresencePayload | null {
  if (!isRecord(value) || !isValidAssistantPresenceWireRecord(value)) {
    return null;
  }

  const record = value;
  const assistantOwnerUserIdRaw = record.assistantOwnerUserId;
  const assistantOwnerUserId =
    typeof assistantOwnerUserIdRaw === "string" && assistantOwnerUserIdRaw.trim().length > 0
      ? assistantOwnerUserIdRaw.trim()
      : undefined;
  const assistantOwnerParticipantIdentityRaw = record.assistantOwnerParticipantIdentity;
  const assistantOwnerParticipantIdentity =
    typeof assistantOwnerParticipantIdentityRaw === "string" && assistantOwnerParticipantIdentityRaw.trim().length > 0
      ? assistantOwnerParticipantIdentityRaw.trim()
      : undefined;

  return {
    assistantIdentity: record.assistantIdentity,
    assistantDisplayName: record.assistantDisplayName,
    active: record.active,
    phase: record.phase === "thinking" ? "thinking" : undefined,
    assistantOwnerUserId,
    assistantOwnerParticipantIdentity,
    conversationModeActive:
      typeof record.conversationModeActive === "boolean" ? record.conversationModeActive : undefined,
  };
}

function parseAssistantPresencePayload(payload: string | null | undefined) {
  if (payload === null || payload === undefined || payload.length === 0) {
    return null;
  }

  try {
    const parsed = assistantPresencePayloadSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) {
      return null;
    }

    return parseAssistantPresenceValue(parsed.data);
  } catch (error) {
    void describeCaughtFailure(error);

    return null;
  }
}

function isAssistantTurnConflictPayload(value: unknown): value is AssistantTurnConflictPayload {
  if (!isRecord(value)) {
    return false;
  }

  const record = value;

  return (
    record.type === "assistant_turn_conflict" &&
    record.reason === "another_participant_active" &&
    (record.speakerDisplayName === undefined || typeof record.speakerDisplayName === "string")
  );
}

function parseAssistantTurnConflictPayload(payload: string | null | undefined) {
  if (payload === null || payload === undefined || payload.length === 0) {
    return null;
  }

  try {
    const parsed = assistantTurnConflictPayloadSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) {
      return null;
    }

    return isAssistantTurnConflictPayload(parsed.data) ? parsed.data : null;
  } catch (error) {
    void describeCaughtFailure(error);

    return null;
  }
}

function getAssistantTurnConflictNotice(error: unknown) {
  const payload = parseAssistantTurnConflictPayload(getRpcErrorData(error));
  if (payload) {
    const speakerDisplayName = payload.speakerDisplayName?.trim() ?? "";
    if (speakerDisplayName.length > 0) {
      return `${speakerDisplayName}${LIVE_MEETING_PAGE_COPY.assistantSpeakingSuffix}`;
    }

    return LIVE_MEETING_PAGE_COPY.assistantSomeoneElseSpeaking;
  }

  const message = getErrorMessage({ error, fallback: "" });
  if (/Another participant is already using the assistant/i.test(message)) {
    return LIVE_MEETING_PAGE_COPY.assistantSomeoneElseSpeaking;
  }

  return null;
}

function isAgentHelpCreditsRequiredPayload(value: unknown): value is {
  type: "agent_help_credits_required";
  reason?: string;
  assistantOwnerParticipantIdentity?: string;
} {
  if (!isRecord(value)) {
    return false;
  }

  const record = value;

  return (
    record.type === "agent_help_credits_required" &&
    (record.reason === undefined || typeof record.reason === "string") &&
    (record.assistantOwnerParticipantIdentity === undefined ||
      typeof record.assistantOwnerParticipantIdentity === "string")
  );
}

function parseAgentHelpCreditsRequiredPayload(payload: string | null | undefined) {
  if (payload === null || payload === undefined || payload.length === 0) {
    return null;
  }

  try {
    const parsed = agentHelpCreditsRequiredPayloadSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) {
      return null;
    }

    return isAgentHelpCreditsRequiredPayload(parsed.data) ? parsed.data : null;
  } catch (error) {
    void describeCaughtFailure(error);

    return null;
  }
}

function isAgentHelpCreditsRequiredError(error: unknown) {
  if (parseAgentHelpCreditsRequiredPayload(getRpcErrorData(error))) {
    return true;
  }

  return /agent_help_credits_required|Insufficient AI credits/i.test(getErrorMessage({ error, fallback: "" }));
}

function isAssistantUtterancePayload(value: unknown): value is {
  type: "assistant_utterance";
  assistantIdentity: string;
  assistantDisplayName: string;
  content: string;
  itemId?: string | null;
  createdAt: string;
} {
  if (!isRecord(value)) {
    return false;
  }

  const record = value;

  return (
    record.type === "assistant_utterance" &&
    typeof record.assistantIdentity === "string" &&
    record.assistantIdentity.startsWith(ASSISTANT_IDENTITY_PREFIX) &&
    typeof record.assistantDisplayName === "string" &&
    record.assistantDisplayName.trim().length > 0 &&
    typeof record.content === "string" &&
    record.content.trim().length > 0 &&
    typeof record.createdAt === "string"
  );
}

function getTextStreamTimestampMs(timestamp: unknown) {
  if (timestamp instanceof Date) {
    return timestamp.getTime();
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Date.now();
}

function LiveKitTranscriptionBridge({ room, onLines }: { room: Room; onLines: (lines: LiveTranscriptLine[]) => void }) {
  const transcriptions = useTranscriptions({ room });

  useEffect(() => {
    // Once the scribe marks its captions, human lines without the marker are the voice
    // agent's forwarded realtime-model input transcripts: fragmentary duplicates.
    const isScribeTranscription = (transcription: (typeof transcriptions)[number]) =>
      transcription.streamInfo.attributes?.[READYMEET_CAPTION_SOURCE_ATTRIBUTE] === READYMEET_CAPTION_SOURCE_SCRIBE;
    const hasScribeCaptions = transcriptions.some(isScribeTranscription);
    const lines = transcriptions
      .map((transcription) => {
        const participantIdentity = transcription.participantInfo.identity;
        const sender =
          participantIdentity === room.localParticipant.identity
            ? room.localParticipant
            : room.remoteParticipants.get(participantIdentity);
        if (
          hasScribeCaptions &&
          !isScribeTranscription(transcription) &&
          (sender === undefined || !isMeetingAgentParticipant(sender))
        ) {
          return null;
        }
        const participant =
          participantIdentity === room.localParticipant.identity
            ? room.localParticipant
            : room.remoteParticipants.get(participantIdentity);
        const attributes = transcription.streamInfo.attributes ?? {};
        const segmentIdAttribute = attributes[LIVEKIT_TRANSCRIPTION_SEGMENT_ID_ATTRIBUTE];
        const segmentId =
          typeof segmentIdAttribute === "string" && segmentIdAttribute.length > 0
            ? segmentIdAttribute
            : transcription.streamInfo.id;
        const trackSid = attributes[LIVEKIT_TRANSCRIPTION_TRACK_ID_ATTRIBUTE];
        const sourceSegmentId = buildLiveKitTranscriptSourceSegmentId({
          participantIdentity,
          trackSid,
          segmentId,
        });
        const isFinal = attributes[LIVEKIT_TRANSCRIPTION_FINAL_ATTRIBUTE] === "true";
        const content = transcription.text.trim();
        if (content.length === 0) {
          return null;
        }
        const speaker = resolveLiveKitTranscriptionSpeaker({
          participantIdentity,
          localParticipant: room.localParticipant,
          participant,
        });

        const line: LiveTranscriptLine = {
          id: `${participantIdentity}:${trackSid ?? "unknown-track"}:${segmentId}`,
          rawParticipantIdentity: participantIdentity,
          speakerIdentity: speaker.speakerIdentity,
          speakerName: speaker.speakerName,
          content,
          updatedAt: getTextStreamTimestampMs(transcription.streamInfo.timestamp),
          isFinal,
          segmentId,
          sourceSegmentId,
        };
        if (typeof trackSid === "string" && trackSid.length > 0) {
          line.trackSid = trackSid;
        }

        return line;
      })
      .filter((line): line is LiveTranscriptLine => line !== null)
      .sort((left, right) => left.updatedAt - right.updatedAt);

    onLines(lines);
  }, [onLines, room, transcriptions]);

  useEffect(() => {
    return () => onLines([]);
  }, [onLines]);

  return null;
}

function TranscriptAvatar({
  displayName,
  email,
  avatarUrl,
}: {
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const initials = getUserInitials({ displayName, email });
  const shouldShowImage = avatarUrl !== null && avatarUrl !== undefined && avatarUrl.length > 0 && !hasImageError;

  return (
    <span className="live-transcript-avatar" aria-hidden="true">
      {shouldShowImage ? (
        <img
          src={avatarUrl}
          alt=""
          className="live-transcript-avatar-image"
          referrerPolicy="no-referrer"
          onError={() => setHasImageError(true)}
        />
      ) : (
        <span className="live-transcript-avatar-fallback">{initials}</span>
      )}
    </span>
  );
}

type AnimatedTranscriptToken =
  | { kind: "space"; token: string; tokenIndex: number }
  | {
      kind: "word";
      tokenIndex: number;
      characters: { character: string; characterIndex: number; animationDelay: number }[];
    };

function animatedTranscriptTokens(content: string) {
  return content.split(/(\s+)/).reduce<{ charIndex: number; tokens: AnimatedTranscriptToken[] }>(
    (state, token, tokenIndex) => {
      if (token.length === 0) {
        return state;
      }
      if (/^\s+$/.test(token)) {
        return {
          charIndex: state.charIndex,
          tokens: [...state.tokens, { kind: "space", token, tokenIndex }],
        };
      }

      const characters = Array.from(token).map((character, characterIndex) => ({
        character,
        characterIndex,
        animationDelay: (state.charIndex + characterIndex) * TRANSCRIPT_CHAR_STAGGER_MS,
      }));

      return {
        charIndex: state.charIndex + characters.length,
        tokens: [...state.tokens, { kind: "word", tokenIndex, characters }],
      };
    },
    { charIndex: 0, tokens: [] },
  ).tokens;
}

function TranscriptAnimatedLine({ content, shouldAnimate }: { content: string; shouldAnimate: boolean }) {
  if (!shouldAnimate) {
    return (
      <p className="live-transcript-line" aria-label={content}>
        {content}
      </p>
    );
  }

  return (
    <p className="live-transcript-line live-transcript-line-animated" aria-label={content}>
      <span aria-hidden="true">
        {animatedTranscriptTokens(content).map((token) => {
          if (token.kind === "space") {
            return <span key={`space-${token.tokenIndex}`}>{token.token}</span>;
          }

          return (
            <span key={`word-${token.tokenIndex}`} className="live-transcript-word">
              {token.characters.map((character) => (
                <span
                  key={`${token.tokenIndex}-${character.characterIndex}-${character.character}`}
                  className="live-transcript-char"
                  style={{ animationDelay: `${character.animationDelay}ms` }}
                >
                  {character.character}
                </span>
              ))}
            </span>
          );
        })}
      </span>
    </p>
  );
}

function TranscriptRow({
  segment,
  shouldAnimateOnMount,
}: {
  segment: VisibleTranscriptLine;
  shouldAnimateOnMount: boolean;
}) {
  const [shouldAnimate] = useState(shouldAnimateOnMount);

  return (
    <article className={`live-transcript-item${shouldAnimate ? " is-animated" : ""}`}>
      <TranscriptAvatar displayName={segment.speakerName} email={segment.email} avatarUrl={segment.avatarUrl} />
      <div className="live-transcript-item-body">
        <strong className="live-transcript-speaker">{segment.speakerName}</strong>
        <TranscriptAnimatedLine content={segment.content} shouldAnimate={shouldAnimate} />
      </div>
    </article>
  );
}

function PresencePanel({
  entries,
  isOpen,
  onClose,
}: {
  entries: PresenceEntry[];
  isOpen: boolean;
  onClose: () => void;
}) {
  const peopleEntries = entries.filter((entry) => entry.isAssistant !== true);
  const agentEntries = entries.filter((entry) => entry.isAssistant === true);
  const totalParticipants = entries.length;

  return (
    <>
      <button
        type="button"
        className={`live-presence-backdrop${isOpen ? " is-open" : ""}`}
        aria-label={LIVE_MEETING_PAGE_COPY.presenceClosePeoplePanel}
        aria-hidden={!isOpen}
        tabIndex={isOpen ? 0 : -1}
        onClick={onClose}
      />
      <aside
        className={`live-presence-panel live-presence-sheet${isOpen ? " is-open" : ""}`}
        aria-hidden={!isOpen}
        aria-label={LIVE_MEETING_PAGE_COPY.presenceParticipantsInMeeting}
      >
        <div className="live-presence-sheet-header">
          <div>
            <h2>{LIVE_MEETING_PAGE_COPY.presenceInThisMeeting}</h2>
            <p>
              {totalParticipants} {LIVE_MEETING_PAGE_COPY.presenceParticipantsLabel}
            </p>
          </div>
          <button
            type="button"
            className="live-presence-sheet-close"
            onClick={onClose}
            aria-label={LIVE_MEETING_PAGE_COPY.presenceClosePeoplePanel}
            title={LIVE_MEETING_PAGE_COPY.presenceClosePeoplePanel}
          >
            ×
          </button>
        </div>

        <div className="live-presence-groups">
          <section className="live-presence-group" aria-label={LIVE_MEETING_PAGE_COPY.presencePeopleGroup}>
            <h3>{LIVE_MEETING_PAGE_COPY.presencePeopleGroup}</h3>
            <div className="live-presence-list">
              {peopleEntries.map((entry) => (
                <div key={entry.id} className="live-presence-person">
                  <UserAvatarBadge
                    displayName={entry.displayName}
                    email={entry.email}
                    avatarUrl={entry.avatarUrl}
                    size="large"
                    className="live-presence-person-avatar"
                  />
                  <div className="live-presence-person-copy">
                    <strong>{entry.displayName}</strong>
                    <span>
                      {entry.subtitle ??
                        (entry.isYou === true
                          ? LIVE_MEETING_PAGE_COPY.presenceYouSubtitle
                          : LIVE_MEETING_PAGE_COPY.presenceParticipantSubtitle)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="live-presence-group" aria-label={LIVE_MEETING_PAGE_COPY.presenceAgentsGroup}>
            <h3>{LIVE_MEETING_PAGE_COPY.presenceAgentsGroup}</h3>
            <div className="live-presence-list">
              {agentEntries.map((entry) => (
                <div key={entry.id} className="live-presence-person">
                  <UserAvatarBadge
                    displayName={entry.displayName}
                    email={entry.email}
                    avatarUrl={entry.avatarUrl}
                    size="large"
                    className="live-presence-person-avatar"
                  />
                  <div className="live-presence-person-copy">
                    <strong>{entry.displayName}</strong>
                    <span>{entry.subtitle ?? LIVE_MEETING_PAGE_COPY.presenceAgentReadySubtitle}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}

function MeetingDetailsPanel({
  meetingTitle,
  joinUrl,
  callIn,
  isOpen,
  isJoiningInfoCopied,
  onClose,
  onCopyJoiningInfo,
}: {
  meetingTitle: string;
  joinUrl: string;
  callIn: LiveMeetingCallInInfo | null;
  isOpen: boolean;
  isJoiningInfoCopied: boolean;
  onClose: () => void;
  onCopyJoiningInfo: () => void;
}) {
  const shouldShowMeetingTitle = !isDefaultInstantMeetingTitle(meetingTitle);

  return (
    <>
      <button
        type="button"
        className={`live-presence-backdrop${isOpen ? " is-open" : ""}`}
        aria-label={LIVE_MEETING_PAGE_COPY.meetingDetailsClosePanel}
        aria-hidden={!isOpen}
        tabIndex={isOpen ? 0 : -1}
        onClick={onClose}
      />
      <aside
        id="live-meeting-details-panel"
        className={`live-presence-panel live-meeting-details-sheet${isOpen ? " is-open" : ""}`}
        aria-hidden={!isOpen}
        aria-label={LIVE_MEETING_PAGE_COPY.meetingDetailsTitle}
      >
        <div className="live-presence-sheet-header">
          <div>
            <h2>{LIVE_MEETING_PAGE_COPY.meetingDetailsTitle}</h2>
          </div>
          <button
            type="button"
            className="live-presence-sheet-close"
            onClick={onClose}
            aria-label={LIVE_MEETING_PAGE_COPY.meetingDetailsClosePanel}
            title={LIVE_MEETING_PAGE_COPY.meetingDetailsClosePanel}
          >
            ×
          </button>
        </div>

        <div className="live-meeting-details-body">
          <section
            className="live-meeting-details-section"
            aria-label={LIVE_MEETING_PAGE_COPY.meetingDetailsJoiningInfo}
          >
            <div className="live-meeting-details-copy">
              {shouldShowMeetingTitle ? <strong>{meetingTitle}</strong> : null}
              <p className="live-meeting-details-join-url">{joinUrl}</p>
              {callIn !== null ? (
                <div
                  className="live-meeting-details-call-in"
                  aria-label={LIVE_MEETING_PAGE_COPY.meetingDetailsCallInAriaLabel}
                >
                  <p>
                    {LIVE_MEETING_PAGE_COPY.meetingDetailsDialInPrefix} {formatDialInPhoneNumber(callIn.phoneNumber)}
                  </p>
                  <p>
                    {LIVE_MEETING_PAGE_COPY.meetingDetailsPinPrefix} {callIn.pin}
                    {LIVE_MEETING_PAGE_COPY.meetingDetailsPinHashSuffix}
                  </p>
                </div>
              ) : null}
            </div>
            <button type="button" className="live-meeting-details-copy-button" onClick={onCopyJoiningInfo}>
              <span>{LIVE_MEETING_PAGE_COPY.meetingDetailsCopyJoiningInfo}</span>
              <CopyStatusIcon copied={isJoiningInfoCopied} className="live-meeting-details-action-icon-stack" />
            </button>
          </section>
        </div>
      </aside>
    </>
  );
}

function getLiveMeetingDeviceLabel(input: { device: MediaDeviceInfo; index: number; fallbackLabel: string }) {
  const label = input.device.label.replace(/\s+\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)$/u, "").trim();

  return label.length > 0 ? label : `${input.fallbackLabel} ${input.index + 1}`;
}

function LiveMeetingDeviceOptions({
  listboxId,
  ariaLabel,
  devices,
  fallbackLabel,
  value,
  onChange,
  onSelect,
}: {
  listboxId: string;
  ariaLabel: string;
  devices: MediaDeviceInfo[];
  fallbackLabel: string;
  value: string;
  onChange: (deviceId: string) => void | Promise<void>;
  onSelect: () => void;
}) {
  return (
    <div className="live-meeting-device-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
      {devices.map((device, index) => {
        const isSelected = device.deviceId === value;

        return (
          <button
            key={device.deviceId}
            type="button"
            className={`live-meeting-device-menu-option${isSelected ? " is-selected" : ""}`}
            role="option"
            aria-selected={isSelected}
            onClick={() => {
              void onChange(device.deviceId);
              onSelect();
            }}
          >
            <span>{getLiveMeetingDeviceLabel({ device, index, fallbackLabel })}</span>
          </button>
        );
      })}
    </div>
  );
}

function LiveMeetingDeviceDropdown({
  ariaLabel,
  devices,
  disabled: isDisabledByParent = false,
  fallbackLabel,
  icon,
  onChange,
  value,
}: {
  ariaLabel: string;
  devices: MediaDeviceInfo[];
  /** @external live meeting device dropdown */
  disabled?: boolean;
  fallbackLabel: string;
  icon: ReactNode;
  onChange: (deviceId: string) => void | Promise<void>;
  value: string;
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const selectedIndex = devices.findIndex((device) => device.deviceId === value);
  const labelIndex = Math.max(selectedIndex, 0);
  const selectedDevice = devices[labelIndex];
  const selectedLabel =
    selectedDevice !== undefined
      ? getLiveMeetingDeviceLabel({ device: selectedDevice, index: labelIndex, fallbackLabel })
      : fallbackLabel;
  const isDisabled = isDisabledByParent || devices.length === 0;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      const target = event.target;
      if (root === null || !(target instanceof Node) || !root.contains(target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isDisabled) {
      setIsOpen(false);
    }
  }, [isDisabled]);

  return (
    <div className={`live-meeting-device-dropdown${isOpen ? " is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={`live-meeting-device-dropdown-button${isOpen ? " is-open" : ""}`}
        aria-label={ariaLabel}
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        disabled={isDisabled}
        onClick={() => setIsOpen((isCurrentlyOpen) => !isCurrentlyOpen)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setIsOpen(true);
          }
        }}
      >
        <span className="live-meeting-device-dropdown-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="live-meeting-device-dropdown-copy">
          <strong>{ariaLabel}</strong>
          <span>{selectedLabel}</span>
        </span>
        <LiveMeetingDeviceDropdownChevronIcon />
      </button>
      {isOpen ? (
        <LiveMeetingDeviceOptions
          listboxId={listboxId}
          ariaLabel={ariaLabel}
          devices={devices}
          fallbackLabel={fallbackLabel}
          value={value}
          onChange={onChange}
          onSelect={() => setIsOpen(false)}
        />
      ) : null}
    </div>
  );
}

function MeetingBackgroundBlurSettingRow({
  isBackgroundBlurEnabled,
  isBackgroundBlurBusy,
  isBackgroundBlurSupported,
  isDisabled,
  onToggleBackgroundBlur,
}: {
  isBackgroundBlurEnabled: boolean;
  isBackgroundBlurBusy: boolean;
  isBackgroundBlurSupported: boolean;
  isDisabled: boolean;
  onToggleBackgroundBlur: () => void | Promise<void>;
}) {
  const backgroundBlurStateLabel = !canToggleBackgroundBlur({ isBackgroundBlurEnabled, isBackgroundBlurSupported })
    ? LIVE_MEETING_PAGE_COPY.settingsBlurUnsupported
    : isBackgroundBlurBusy
      ? LIVE_MEETING_PAGE_COPY.settingsBlurUpdating
      : isBackgroundBlurEnabled
        ? LIVE_MEETING_PAGE_COPY.settingsBlurOn
        : LIVE_MEETING_PAGE_COPY.settingsBlurOff;

  return (
    <button
      type="button"
      className={`live-meeting-setting-row${isBackgroundBlurEnabled ? " is-active" : ""}`}
      role="switch"
      aria-checked={isBackgroundBlurEnabled}
      aria-label={`Background blur: ${backgroundBlurStateLabel}`}
      disabled={
        isDisabled ||
        isBackgroundBlurBusy ||
        !canToggleBackgroundBlur({ isBackgroundBlurEnabled, isBackgroundBlurSupported })
      }
      onClick={() => void onToggleBackgroundBlur()}
    >
      <span className="live-meeting-setting-icon" aria-hidden="true">
        <BackgroundBlurIcon isEnabled={isBackgroundBlurEnabled} />
      </span>
      <span className="live-meeting-setting-copy">
        <strong>{LIVE_MEETING_PAGE_COPY.settingsBackgroundBlur}</strong>
        <span>{backgroundBlurStateLabel}</span>
      </span>
      <span className="live-meeting-setting-switch" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

function MeetingSettingsPanel({
  isOpen,
  audioInputDevices,
  audioDeviceId,
  videoInputDevices,
  videoDeviceId,
  isMicEnabled,
  isCamEnabled,
  isBackgroundBlurEnabled,
  isBackgroundBlurBusy,
  isBackgroundBlurSupported,
  isDisabled,
  onClose,
  onSelectAudioDevice,
  onSelectVideoDevice,
  onToggleBackgroundBlur,
}: {
  isOpen: boolean;
  audioInputDevices: MediaDeviceInfo[];
  audioDeviceId: string;
  videoInputDevices: MediaDeviceInfo[];
  videoDeviceId: string;
  isMicEnabled: boolean;
  isCamEnabled: boolean;
  isBackgroundBlurEnabled: boolean;
  isBackgroundBlurBusy: boolean;
  isBackgroundBlurSupported: boolean;
  isDisabled: boolean;
  onClose: () => void;
  onSelectAudioDevice: (deviceId: string) => void | Promise<void>;
  onSelectVideoDevice: (deviceId: string) => void | Promise<void>;
  onToggleBackgroundBlur: () => void | Promise<void>;
}) {
  return (
    <>
      <button
        type="button"
        className={`live-presence-backdrop${isOpen ? " is-open" : ""}`}
        aria-label={LIVE_MEETING_PAGE_COPY.settingsClosePanel}
        aria-hidden={!isOpen}
        tabIndex={isOpen ? 0 : -1}
        onClick={onClose}
      />
      <aside
        id="live-meeting-settings-panel"
        className={`live-presence-panel live-meeting-settings-sheet${isOpen ? " is-open" : ""}`}
        aria-hidden={!isOpen}
        aria-label={LIVE_MEETING_PAGE_COPY.settingsTitle}
      >
        <div className="live-presence-sheet-header">
          <div>
            <h2>{LIVE_MEETING_PAGE_COPY.settingsTitle}</h2>
          </div>
          <button
            type="button"
            className="live-presence-sheet-close"
            onClick={onClose}
            aria-label={LIVE_MEETING_PAGE_COPY.settingsClosePanel}
            title={LIVE_MEETING_PAGE_COPY.settingsClosePanel}
          >
            ×
          </button>
        </div>

        <div className="live-meeting-settings-body">
          <LiveMeetingDeviceDropdown
            ariaLabel={LIVE_MEETING_PAGE_COPY.settingsMicrophone}
            devices={audioInputDevices}
            fallbackLabel={LIVE_MEETING_PAGE_COPY.settingsMicrophone}
            icon={<MicrophoneIcon isEnabled={isMicEnabled} />}
            value={audioDeviceId}
            onChange={onSelectAudioDevice}
            disabled={isDisabled}
          />
          <LiveMeetingDeviceDropdown
            ariaLabel={LIVE_MEETING_PAGE_COPY.settingsCamera}
            devices={videoInputDevices}
            fallbackLabel={LIVE_MEETING_PAGE_COPY.settingsCamera}
            icon={<CameraIcon isEnabled={isCamEnabled} />}
            value={videoDeviceId}
            onChange={onSelectVideoDevice}
            disabled={isDisabled}
          />
          <MeetingBackgroundBlurSettingRow
            isBackgroundBlurEnabled={isBackgroundBlurEnabled}
            isBackgroundBlurBusy={isBackgroundBlurBusy}
            isBackgroundBlurSupported={isBackgroundBlurSupported}
            isDisabled={isDisabled}
            onToggleBackgroundBlur={onToggleBackgroundBlur}
          />
        </div>
      </aside>
    </>
  );
}

function ToolApprovalPanel({
  cards,
  isOpen,
  onClose,
  onConnectCalendar,
  onDisconnectCalendar,
  onRequestWorkflow,
}: {
  cards: VoiceToolApprovalCardState[];
  isOpen: boolean;
  onClose: () => void;
  onConnectCalendar: (card: VoiceToolApprovalCardState) => void;
  onDisconnectCalendar: (card: VoiceToolApprovalCardState) => void;
  onRequestWorkflow: (card: VoiceToolApprovalCardState) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`live-presence-backdrop${isOpen ? " is-open" : ""}`}
        aria-label={LIVE_MEETING_PAGE_COPY.agentSkillsClosePanel}
        aria-hidden={!isOpen}
        tabIndex={isOpen ? 0 : -1}
        onClick={onClose}
      />
      <aside
        className={`live-presence-panel live-tool-approval-sheet${isOpen ? " is-open" : ""}`}
        aria-hidden={!isOpen}
        aria-label={LIVE_MEETING_PAGE_COPY.agentSkillsTitle}
      >
        <div className="live-presence-sheet-header">
          <div>
            <h2>{LIVE_MEETING_PAGE_COPY.agentSkillsTitle}</h2>
          </div>
          <button
            type="button"
            className="live-presence-sheet-close"
            onClick={onClose}
            aria-label={LIVE_MEETING_PAGE_COPY.agentSkillsClosePanel}
            title={LIVE_MEETING_PAGE_COPY.agentSkillsClosePanel}
          >
            ×
          </button>
        </div>

        <div className="live-tool-approval-cards">
          {cards.map((card) => {
            const isCalendarConnect = card.kind === "connect" && card.tool === "calendar" && card.provider !== null;
            const title = card.status === "requested" ? `${card.title} requested` : card.title;
            const description =
              card.error ??
              (card.status === "connected"
                ? "This skill is enabled for your agent."
                : card.status === "requested"
                  ? "We noted this request for this session."
                  : card.description);
            const actionLabel =
              card.status === "starting"
                ? "Connecting..."
                : card.status === "disconnecting"
                  ? "Disabling..."
                  : card.status === "connected"
                    ? "Disable"
                    : card.status === "requested"
                      ? "Requested"
                      : card.status === "error"
                        ? "Connect"
                        : card.actionLabel;

            return (
              <article key={card.id} className={`live-tool-approval-card is-${card.kind}`}>
                <div className="live-tool-approval-card-copy">
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
                <button
                  type="button"
                  className="live-tool-approval-action"
                  disabled={
                    card.status === "starting" || card.status === "disconnecting" || card.status === "requested"
                  }
                  onClick={() => {
                    if (isCalendarConnect && card.status === "connected") {
                      onDisconnectCalendar(card);
                    } else if (isCalendarConnect) {
                      onConnectCalendar(card);
                    } else {
                      onRequestWorkflow(card);
                    }
                  }}
                >
                  {actionLabel}
                </button>
              </article>
            );
          })}
        </div>
      </aside>
    </>
  );
}

type LinearActionPanelState = {
  status: "pending" | "completed" | "cancelled" | "error";
  meetingId: string | null;
  pendingInvocationId: string;
  actionName: string;
  actionLabel: string;
  description: string | null;
  preview: Record<string, unknown>;
  summaries: string[];
  successToast: string | null;
  partialToast: { pastPrefix: string; pastSuffix: string; noun: string } | null;
  requestingUserId: string | null;
  message: string | null;
  isBusy: boolean;
};

type LinearActionBatchStats = {
  total: number;
  succeeded: number;
  failed: number;
  failedActions: string[];
};

// Reads batch outcome counts from either the worker's resolved panel payload
// ({total, succeeded, failed, failedActions}) or the confirm API result
// ({tool: 'batch', total, succeeded, failed, results|actions}). Single
// actions have no counts and return null.
function parseLinearActionBatchStats(value: unknown): LinearActionBatchStats | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const total = typeof record.total === "number" ? record.total : null;
  const failed = typeof record.failed === "number" ? record.failed : null;
  if (total === null || failed === null) {
    return null;
  }
  const succeeded = typeof record.succeeded === "number" ? record.succeeded : total - failed;
  const failedActions = Array.isArray(record.failedActions)
    ? record.failedActions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : (Array.isArray(record.results) ? record.results : Array.isArray(record.actions) ? record.actions : [])
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .filter((entry) => entry.ok !== true)
        .map((entry) => (typeof entry.action === "string" ? entry.action : ""))
        .filter((action) => action.length > 0);

  return { total, succeeded, failed, failedActions: failedActions.slice(0, LINEAR_BATCH_FAILED_ACTIONS_MAX) };
}

function buildLinearPartialToastMessage(input: { state: LinearActionPanelState; stats: LinearActionBatchStats }) {
  if (input.state.partialToast !== null) {
    return `${input.state.partialToast.pastPrefix}${input.stats.succeeded}${LIVE_MEETING_PAGE_COPY.linearPartialToastWithCustomPrefix}${input.stats.total} ${input.state.partialToast.noun}${input.state.partialToast.pastSuffix} — ${input.stats.failed}${LIVE_MEETING_PAGE_COPY.linearPartialToastFailedSuffix}`;
  }

  return `${LIVE_MEETING_PAGE_COPY.linearPartialToastCompletedPrefix}${input.stats.succeeded}${LIVE_MEETING_PAGE_COPY.linearPartialToastCompletedMiddle}${input.stats.total}${LIVE_MEETING_PAGE_COPY.linearPartialToastCompletedSuffix}${input.stats.failed}${LIVE_MEETING_PAGE_COPY.linearPartialToastCompletedFailedSuffix}`;
}

function buildLinearFailureMessage(stats: LinearActionBatchStats) {
  const failedList = stats.failedActions.slice(0, LINEAR_BATCH_FAILED_LIST_MAX).join("; ");
  const base =
    stats.succeeded > 0
      ? `${stats.succeeded}${LIVE_MEETING_PAGE_COPY.linearFailureActionsCompletedPrefix}${stats.total}${LIVE_MEETING_PAGE_COPY.linearFailureActionsCompletedMiddle}${stats.failed}${LIVE_MEETING_PAGE_COPY.linearFailureActionsCompletedSuffix}`
      : LIVE_MEETING_PAGE_COPY.linearActionsFailed;

  return failedList.length > 0 ? `${base}: ${failedList}` : `${base}.`;
}

function showLinearBatchFailure(input: {
  stats: LinearActionBatchStats;
  state: LinearActionPanelState;
  invocationId: string;
  showToast: ReturnType<typeof useToast>["showToast"];
}): string {
  if (input.stats.succeeded > 0) {
    input.showToast({
      id: `linear-action-${input.invocationId}`,
      title: LIVE_MEETING_PAGE_COPY.linearPanelTitle,
      message: buildLinearPartialToastMessage({ state: input.state, stats: input.stats }),
      tone: "warning",
    });
  }

  return buildLinearFailureMessage(input.stats);
}

function parseLinearActionPanelStatus(status: string | undefined) {
  return status === "completed" || status === "cancelled" || status === "error" ? status : "pending";
}

function buildLinearActionPanelPayloadFromRaw(raw: LinearActionPanelPayloadSchemaValue) {
  const pendingInvocationId = typeof raw.pendingInvocationId === "string" ? raw.pendingInvocationId : "";
  if (pendingInvocationId.length === 0) {
    return null;
  }

  return {
    status: parseLinearActionPanelStatus(raw.status),
    pendingInvocationId,
    meetingId: typeof raw.meetingId === "string" ? raw.meetingId : null,
    actionName: typeof raw.actionName === "string" ? raw.actionName : "",
    actionLabel:
      typeof raw.actionLabel === "string" && raw.actionLabel.trim().length > 0
        ? raw.actionLabel
        : LIVE_MEETING_PAGE_COPY.linearActionDefaultLabel,
    description: typeof raw.description === "string" && raw.description.trim().length > 0 ? raw.description : null,
    preview: isRecord(raw.preview) ? raw.preview : {},
    summaries: Array.isArray(raw.summaries)
      ? raw.summaries
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, LINEAR_ACTION_SUMMARIES_MAX)
      : [],
    successToast: parseLinearActionCopyToast(raw.copy),
    partialToast: parseLinearActionCopyPartial(raw.copy),
    result: parseLinearActionBatchStats(raw.result),
    requestingUserId: typeof raw.requestingUserId === "string" ? raw.requestingUserId : null,
  } as const;
}

function parseLinearActionPanelPayload(payloadText: string) {
  try {
    const parsed = linearActionPanelPayloadSchema.safeParse(JSON.parse(payloadText));
    if (!parsed.success) {
      return null;
    }

    return buildLinearActionPanelPayloadFromRaw(parsed.data);
  } catch (error) {
    void describeCaughtFailure(error);

    return null;
  }
}

function parseLinearActionCopyToast(copy: unknown): string | null {
  if (!isRecord(copy)) {
    return null;
  }
  const successToast = copy.successToast;

  return typeof successToast === "string" && successToast.trim().length > 0 ? successToast.trim() : null;
}

function parseLinearActionCopyPartial(copy: unknown): { pastPrefix: string; pastSuffix: string; noun: string } | null {
  if (!isRecord(copy)) {
    return null;
  }
  const partial = copy.partial;
  if (!isRecord(partial)) {
    return null;
  }
  const record = partial;
  if (typeof record.pastPrefix !== "string" || typeof record.pastSuffix !== "string") {
    return null;
  }

  return {
    pastPrefix: record.pastPrefix,
    pastSuffix: record.pastSuffix,
    noun:
      typeof record.noun === "string" && record.noun.trim().length > 0
        ? record.noun
        : LIVE_MEETING_PAGE_COPY.linearIssuesNounDefault,
  };
}

function formatLinearActionPreviewValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.length > LINEAR_PREVIEW_VALUE_MAX_CHARS ? `${value.slice(0, LINEAR_PREVIEW_VALUE_MAX_CHARS)}…` : value;
  }
  try {
    const serialized = JSON.stringify(value);

    return serialized.length > LINEAR_PREVIEW_VALUE_MAX_CHARS
      ? `${serialized.slice(0, LINEAR_PREVIEW_VALUE_MAX_CHARS)}…`
      : serialized;
  } catch (error) {
    void describeCaughtFailure(error);

    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }

    return "";
  }
}

function humanizeLinearPreviewKey(key: string) {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  const firstCharacter = spaced[0];
  if (firstCharacter === undefined || firstCharacter.length === 0) {
    return key;
  }

  return firstCharacter.toUpperCase() + spaced.slice(1);
}

function getLinearActionPanelPreviewEntries(state: LinearActionPanelState) {
  const isBatch = state.summaries.length > 1;
  const previewArguments = state.preview.arguments;
  const previewSource = isRecord(previewArguments) ? previewArguments : state.preview;
  if (isBatch) {
    return [];
  }

  return Object.entries(previewSource)
    .filter(([key]) => !["name", "summaries", "calls"].includes(key))
    .filter(([, value]) => formatLinearActionPreviewValue(value).trim().length > 0)
    .slice(0, LINEAR_PREVIEW_ENTRY_MAX);
}

function LinearActionPanelPendingControls(input: {
  state: LinearActionPanelState;
  canConfirm: boolean;
  onAllow: () => void;
  onCancel: () => void;
}) {
  if (input.state.status !== "pending") {
    return null;
  }
  if (!input.canConfirm) {
    return <p className="live-linear-action-status">{LIVE_MEETING_PAGE_COPY.linearActionWaitingForConfirm}</p>;
  }

  return (
    <div className="live-linear-action-buttons">
      <button type="button" className="live-linear-action-allow" disabled={input.state.isBusy} onClick={input.onAllow}>
        {input.state.isBusy
          ? LIVE_MEETING_PAGE_COPY.linearActionConfirming
          : LIVE_MEETING_PAGE_COPY.linearActionConfirm}
      </button>
      <button
        type="button"
        className="live-linear-action-cancel"
        disabled={input.state.isBusy}
        onClick={input.onCancel}
      >
        {LIVE_MEETING_PAGE_COPY.linearActionCancel}
      </button>
    </div>
  );
}

function LinearActionPanelBody(input: {
  state: LinearActionPanelState;
  canConfirm: boolean;
  onAllow: () => void;
  onCancel: () => void;
}) {
  const previewEntries = getLinearActionPanelPreviewEntries(input.state);
  const isBatch = input.state.summaries.length > 1;

  return (
    <div className="live-linear-action">
      {input.state.description !== null && input.state.description.length > 0 ? (
        <p className="live-linear-action-description">{input.state.description}</p>
      ) : null}
      {isBatch ? (
        <ol className="live-linear-action-summaries">
          {input.state.summaries.map((summary, index) => (
            <li key={`${index}-${summary}`}>{summary}</li>
          ))}
        </ol>
      ) : null}
      {previewEntries.length !== 0 ? (
        <dl className="live-linear-action-preview">
          {previewEntries.map(([key, value]) => (
            <div key={key} className="live-linear-action-preview-row">
              <dt>{humanizeLinearPreviewKey(key)}</dt>
              <dd>{formatLinearActionPreviewValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {input.state.status === "error" ? (
        <p className="live-linear-action-status is-error" aria-live="polite">
          {input.state.message ?? LIVE_MEETING_PAGE_COPY.linearActionFailed}
        </p>
      ) : null}
      {input.state.status === "pending" && input.state.message !== null && input.state.message.length > 0 ? (
        <p className="live-linear-action-status is-error" aria-live="polite">
          {input.state.message}
        </p>
      ) : null}

      <LinearActionPanelPendingControls
        state={input.state}
        canConfirm={input.canConfirm}
        onAllow={input.onAllow}
        onCancel={input.onCancel}
      />
    </div>
  );
}

function LinearActionPanel({
  state,
  isOpen,
  canConfirm,
  onClose,
  onAllow,
  onCancel,
}: {
  state: LinearActionPanelState | null;
  isOpen: boolean;
  canConfirm: boolean;
  onClose: () => void;
  onAllow: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`live-presence-backdrop${isOpen ? " is-open" : ""}`}
        aria-label={LIVE_MEETING_PAGE_COPY.linearPanelClose}
        aria-hidden={!isOpen}
        tabIndex={isOpen ? 0 : -1}
        onClick={onClose}
      />
      <aside
        className={`live-presence-panel live-web-search-sheet${isOpen ? " is-open" : ""}`}
        aria-hidden={!isOpen}
        aria-label={LIVE_MEETING_PAGE_COPY.linearPanelAriaLabel}
      >
        <div className="live-presence-sheet-header">
          <div>
            <h2>{LIVE_MEETING_PAGE_COPY.linearPanelTitle}</h2>
            {state !== null ? <p>{state.actionLabel}</p> : null}
          </div>
          <button
            type="button"
            className="live-presence-sheet-close"
            onClick={onClose}
            aria-label={LIVE_MEETING_PAGE_COPY.linearPanelClose}
            title={LIVE_MEETING_PAGE_COPY.linearPanelClose}
          >
            ×
          </button>
        </div>

        <div className="live-web-search-body">
          {state !== null ? (
            <LinearActionPanelBody state={state} canConfirm={canConfirm} onAllow={onAllow} onCancel={onCancel} />
          ) : null}
        </div>
      </aside>
    </>
  );
}

/**
 * The meeting assistant joins through LiveKit agent dispatch, so LiveKit marks
 * it as an agent, and its identity comes from the server. Signed-in callers can
 * set their own attributes, so `assistantRole` alone proves nothing.
 */
function isMeetingAgentParticipant(participant: Pick<Participant, "identity" | "kind">) {
  return participant.kind === ParticipantKind.AGENT && participant.identity.startsWith(ASSISTANT_IDENTITY_PREFIX);
}

function rpcPayloadNamesAnotherMeeting(input: { payload: string; meetingId: string | undefined }): boolean {
  if (input.meetingId === undefined) {
    return false;
  }
  try {
    const parsed = assistantRpcPayloadMeetingSchema.safeParse(JSON.parse(input.payload));
    const namedMeetingId = parsed.success ? parsed.data.meetingId : undefined;

    return (
      namedMeetingId !== undefined &&
      namedMeetingId !== null &&
      namedMeetingId !== "" &&
      namedMeetingId !== input.meetingId
    );
  } catch (error) {
    void describeCaughtFailure(error);

    // Each panel parser rejects unreadable payloads on its own.
    return false;
  }
}

/**
 * Assistant panels may only be opened by the meeting assistant. Any other
 * participant could otherwise show fake search results, answers, or
 * connection prompts to everyone in the room.
 */
export function isTrustedMeetingAgentRpc(input: {
  room: Pick<Room, "remoteParticipants">;
  data: Pick<RpcInvocationData, "callerIdentity" | "payload">;
  meetingId: string | undefined;
}): boolean {
  const caller = input.room.remoteParticipants.get(input.data.callerIdentity);

  return (
    caller !== undefined &&
    isMeetingAgentParticipant(caller) &&
    !rpcPayloadNamesAnotherMeeting({ payload: input.data.payload, meetingId: input.meetingId })
  );
}

async function waitForMeetingAgentParticipant(input: { room: Room; timeoutMs?: number }) {
  const timeoutMs = input.timeoutMs ?? MEETING_AGENT_JOIN_WAIT_DEFAULT_MS;
  const existingParticipant = Array.from(input.room.remoteParticipants.values()).find(isMeetingAgentParticipant);
  if (existingParticipant !== undefined) {
    return existingParticipant;
  }

  return new Promise<Participant>((resolve, reject) => {
    const timeoutState = { id: 0 };

    function handleParticipantConnected() {
      maybeResolve();
    }

    function handleAttributesChanged() {
      maybeResolve();
    }

    function handleDisconnected() {
      cleanup();
      reject(new Error(LIVE_MEETING_PAGE_COPY.agentDisconnectedWhileJoining));
    }

    function cleanup() {
      window.clearTimeout(timeoutState.id);
      input.room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
      input.room.off(RoomEvent.ParticipantAttributesChanged, handleAttributesChanged);
      input.room.off(RoomEvent.Disconnected, handleDisconnected);
    }

    function maybeResolve() {
      const nextParticipant = Array.from(input.room.remoteParticipants.values()).find(isMeetingAgentParticipant);

      if (nextParticipant === undefined) {
        return;
      }

      cleanup();
      resolve(nextParticipant);
    }

    timeoutState.id = window.setTimeout(() => {
      cleanup();
      reject(new Error(LIVE_MEETING_PAGE_COPY.agentNotConnectedYet));
    }, timeoutMs);

    input.room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
    input.room.on(RoomEvent.ParticipantAttributesChanged, handleAttributesChanged);
    input.room.on(RoomEvent.Disconnected, handleDisconnected);
  });
}

type LiveMeetingInitialConnectSnapshot = {
  room: Room | null;
  auth: AuthSession;
  authRefresh: Promise<AuthSession | null> | null;
  phase: MeetingClientDiagnostic["phase"];
  microphonePermission: BrowserMediaPermissionState;
  cameraPermission: BrowserMediaPermissionState;
  connectionPhase: "connect" | "in-room";
  isLiveCameraEnabled: boolean;
  cameraError: unknown;
  isCameraFallbackAttempted: boolean;
  shouldEnableBackgroundBlur: boolean;
};

function createLiveMeetingInitialConnectSnapshot(input: {
  auth: AuthSession;
  microphonePermission: BrowserMediaPermissionState;
  cameraPermission: BrowserMediaPermissionState;
}): LiveMeetingInitialConnectSnapshot {
  return {
    room: null,
    auth: input.auth,
    authRefresh: null,
    phase: "token",
    microphonePermission: input.microphonePermission,
    cameraPermission: input.cameraPermission,
    connectionPhase: "connect",
    isLiveCameraEnabled: false,
    cameraError: null,
    isCameraFallbackAttempted: false,
    shouldEnableBackgroundBlur: false,
  };
}

function mergeLiveMeetingConnectSnapshot(input: {
  snapshot: LiveMeetingInitialConnectSnapshot;
  patch: Partial<LiveMeetingInitialConnectSnapshot>;
}): LiveMeetingInitialConnectSnapshot {
  return { ...input.snapshot, ...input.patch };
}

function createLiveMeetingJoinConnectAuth(input: {
  activeSession: AuthSession;
  meeting: Meeting;
  microphonePermissionStateRef: { current: BrowserMediaPermissionState };
  cameraPermissionStateRef: { current: BrowserMediaPermissionState };
  clientDiagnosticContextRef: { current: { token: string; meetingId: string } | null };
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<AuthSession | null>;
}) {
  const {
    activeSession,
    meeting,
    microphonePermissionStateRef,
    cameraPermissionStateRef,
    clientDiagnosticContextRef,
    refreshAuthAfterUnauthorized,
  } = input;
  const joinConnect = {
    snapshot: createLiveMeetingInitialConnectSnapshot({
      auth: activeSession,
      microphonePermission: microphonePermissionStateRef.current,
      cameraPermission: cameraPermissionStateRef.current,
    }),
  };
  const refreshJoinAuthAfterUnauthorized = async (error: unknown) => {
    if (!(error instanceof ApiError) || error.status !== HTTP_STATUS_UNAUTHORIZED) {
      return null;
    }
    const joinBeforeRefresh = joinConnect.snapshot;
    const pendingAuthRefresh = joinBeforeRefresh.authRefresh ?? refreshAuthAfterUnauthorized(error);
    joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
      snapshot: joinConnect.snapshot,
      patch: { authRefresh: pendingAuthRefresh },
    });
    const nextSession = await pendingAuthRefresh;
    if (nextSession !== null) {
      joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
        snapshot: joinConnect.snapshot,
        patch: { auth: nextSession },
      });
      clientDiagnosticContextRef.current = {
        token: nextSession.token,
        meetingId: meeting.id,
      };
    }

    return nextSession;
  };
  const runWithAuthRetry = async <T,>(action: (nextSession: AuthSession) => Promise<T>) => {
    try {
      return await action(joinConnect.snapshot.auth);
    } catch (nextError) {
      const nextSession = await refreshJoinAuthAfterUnauthorized(nextError);
      if (nextSession === null) {
        throw nextError;
      }

      return action(joinConnect.snapshot.auth);
    }
  };

  return { joinConnect, refreshJoinAuthAfterUnauthorized, runWithAuthRetry };
}

async function unpublishStaleLiveMeetingJoinCameraIfNeeded(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  joinedRoom: Room;
  cameraPublish: { isPublished: boolean };
}): Promise<void> {
  const { joinConnect, joinedRoom, cameraPublish } = input;
  if (cameraPublish.isPublished && !joinConnect.snapshot.isLiveCameraEnabled) {
    const staleCameraTrack = joinedRoom.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (staleCameraTrack !== undefined) {
      try {
        await joinedRoom.localParticipant.unpublishTrack(staleCameraTrack, true);
      } catch (error) {
        void describeCaughtFailure(error);
      }
    }
    const joinAfterStaleCamera = joinConnect.snapshot;
    joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
      snapshot: joinConnect.snapshot,
      patch: {
        cameraError: joinAfterStaleCamera.cameraError ?? new Error(LIVE_MEETING_PAGE_COPY.publishedCameraTrackNotLive),
      },
    });
  }
}

async function recoverLiveMeetingJoinCameraPublication(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  isInitialCameraEnabled: boolean;
  joinedRoom: Room;
  videoDeviceId: string | undefined;
  meeting: Meeting;
  cameraPublish: { publishFailure: Error | null };
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
}): Promise<void> {
  const { joinConnect, isInitialCameraEnabled, joinedRoom, videoDeviceId, meeting, cameraPublish, setVideoDeviceId } =
    input;
  if (
    !isInitialCameraEnabled ||
    joinConnect.snapshot.isLiveCameraEnabled ||
    isMediaPermissionBlockedError(joinConnect.snapshot.cameraError) ||
    cameraPublish.publishFailure instanceof MeetingCameraStartCancelledError
  ) {
    return;
  }
  try {
    const joinBeforeCameraRecovery = joinConnect.snapshot;
    const recovery = await enableMeetingCameraWithFallback(joinedRoom.localParticipant, videoDeviceId);
    const isLiveCameraEnabledAfterRecovery = getLocalMediaSourceEnabled({
      room: joinedRoom,
      source: Track.Source.Camera,
    });
    joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
      snapshot: joinConnect.snapshot,
      patch: { isLiveCameraEnabled: isLiveCameraEnabledAfterRecovery },
    });
    if (isLiveCameraEnabledAfterRecovery && recovery.recoveredWithDefaultDevice) {
      applyRecoveredVideoDeviceId({
        deviceId: getPublishedCameraDeviceId(joinedRoom.localParticipant),
        setVideoDeviceId,
      });
    }
    if (isLiveCameraEnabledAfterRecovery && joinBeforeCameraRecovery.cameraError !== null) {
      reportMeetingMediaIssue({
        token: joinBeforeCameraRecovery.auth.token,
        meetingId: meeting.id,
        kind: "camera",
        phase: cameraPublish.publishFailure !== null ? "join-publish" : "join-acquire",
        error: joinBeforeCameraRecovery.cameraError,
        selectedDevice: hasConfiguredMediaDeviceId(videoDeviceId),
        fallbackAttempted: recovery.recoveredWithDefaultDevice,
        recovered: true,
      });
    }
    joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
      snapshot: joinConnect.snapshot,
      patch: {
        cameraError: isLiveCameraEnabledAfterRecovery ? null : joinBeforeCameraRecovery.cameraError,
      },
    });
  } catch (recoveryError) {
    joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
      snapshot: joinConnect.snapshot,
      patch: {
        isCameraFallbackAttempted: hasConfiguredMediaDeviceId(videoDeviceId),
        cameraError: recoveryError,
      },
    });
  }
}

function buildLiveMeetingJoinMediaWarnings(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  isLiveMicrophoneEnabled: boolean;
  microphoneError: Error | null;
  microphonePublish: { publishFailure: Error | null };
  cameraPublish: { publishFailure: Error | null };
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  meeting: Meeting;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
}): string[] {
  const {
    joinConnect,
    isInitialMicEnabled,
    isInitialCameraEnabled,
    isLiveMicrophoneEnabled,
    microphoneError,
    microphonePublish,
    cameraPublish,
    audioDeviceId,
    videoDeviceId,
    meeting,
    setMicrophonePermissionState,
    setCameraPermissionState,
  } = input;
  const microphoneWarningMessage = (() => {
    if (!(isInitialMicEnabled && !isLiveMicrophoneEnabled && microphoneError !== null)) {
      return null;
    }
    reportMeetingMediaIssue({
      token: joinConnect.snapshot.auth.token,
      meetingId: meeting.id,
      kind: "microphone",
      phase: microphonePublish.publishFailure !== null ? "join-publish" : "join-acquire",
      error: microphoneError,
      selectedDevice: hasConfiguredMediaDeviceId(audioDeviceId),
      fallbackAttempted: false,
      recovered: false,
    });
    if (isMediaPermissionBlockedError(microphoneError)) {
      joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
        snapshot: joinConnect.snapshot,
        patch: { microphonePermission: "denied" },
      });
      setMicrophonePermissionState("denied");
    }

    return getMediaPermissionErrorMessage({ kind: "microphone", error: microphoneError });
  })();
  const cameraWarningMessage = (() => {
    if (
      !(
        isInitialCameraEnabled &&
        !joinConnect.snapshot.isLiveCameraEnabled &&
        joinConnect.snapshot.cameraError !== null
      )
    ) {
      return null;
    }
    reportMeetingMediaIssue({
      token: joinConnect.snapshot.auth.token,
      meetingId: meeting.id,
      kind: "camera",
      phase: cameraPublish.publishFailure !== null ? "join-publish" : "join-acquire",
      error: joinConnect.snapshot.cameraError,
      selectedDevice: hasConfiguredMediaDeviceId(videoDeviceId),
      fallbackAttempted: joinConnect.snapshot.isCameraFallbackAttempted,
      recovered: false,
    });
    if (isMediaPermissionBlockedError(joinConnect.snapshot.cameraError)) {
      joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
        snapshot: joinConnect.snapshot,
        patch: { cameraPermission: "denied" },
      });
      setCameraPermissionState("denied");
    }

    return getMediaPermissionErrorMessage({ kind: "camera", error: joinConnect.snapshot.cameraError });
  })();

  return [microphoneWarningMessage, cameraWarningMessage].filter((warning): warning is string => warning !== null);
}

export function handleLiveMeetingAssistantNoticeTopic(input: {
  parsed: RealtimeMeetingDataPayloadSchemaValue;
  topic?: string;
  participant?: Participant;
  localParticipantIdentity: string;
  showToast: ReturnType<typeof useToast>["showToast"];
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
}): boolean {
  const {
    parsed,
    topic,
    participant,
    localParticipantIdentity,
    showToast,
    setSyncedConversationModeActive,
    setSyncedAgentHelpPhase,
  } = input;
  if (topic !== "readymeet.assistant-notice" || participant === undefined || !isMeetingAgentParticipant(participant)) {
    return false;
  }
  const contextPaused = voiceContextPausedMessage({ value: parsed, ownerIdentity: localParticipantIdentity });
  if (contextPaused !== null && contextPaused.length > 0) {
    if (isVoiceServiceOutageNotice(parsed)) {
      console.error("[readymeet:optional-live-feature] assistant context paused.");
    } else {
      showToast({ id: "voice-context-paused", title: "Meeting updates paused", message: contextPaused });
    }

    return true;
  }
  const voiceFailure = voiceModeFailureMessage({ value: parsed, ownerIdentity: localParticipantIdentity });
  if (voiceFailure !== null && voiceFailure.length > 0) {
    setSyncedConversationModeActive(false);
    setSyncedAgentHelpPhase("idle");
    if (isVoiceServiceOutageNotice(parsed)) {
      console.error("[readymeet:optional-live-feature] assistant voice unavailable.");
    } else {
      showToast({ id: "voice-mode-failed", title: "Voice chat with Ready stopped", message: voiceFailure });
    }

    return true;
  }

  return false;
}

function applyAssistantUtteranceToRealtimeTranscript(input: {
  utterance: {
    type: "assistant_utterance";
    assistantIdentity: string;
    assistantDisplayName: string;
    content: string;
    itemId?: string | null;
    createdAt: string;
  };
  setRealtimeTranscriptLines: Dispatch<SetStateAction<LiveTranscriptLine[]>>;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
}): void {
  const { utterance, setRealtimeTranscriptLines, setAssistantDisplayNamesByIdentity } = input;
  const updatedAt = new Date(utterance.createdAt).getTime();
  setRealtimeTranscriptLines((current) => {
    const next = new Map(current.map((line) => [line.id, line]));
    const id = `assistant:${utterance.itemId ?? `${utterance.assistantIdentity}:${updatedAt}`}`;
    next.set(id, {
      id,
      rawParticipantIdentity: utterance.assistantIdentity,
      speakerIdentity: utterance.assistantIdentity,
      speakerName: utterance.assistantDisplayName,
      content: utterance.content.trim(),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      isFinal: true,
      segmentId: utterance.itemId ?? id,
    });

    return sortLiveTranscriptLinesByUpdatedAt({ lines: next.values() });
  });
  setAssistantDisplayNamesByIdentity((current) => ({
    ...current,
    [utterance.assistantIdentity]: utterance.assistantDisplayName,
  }));
}

function handleLiveMeetingRoomDataReceived(input: {
  payload: Uint8Array;
  participant?: Participant;
  topic?: string;
  joinedRoom: Room;
  showToast: ReturnType<typeof useToast>["showToast"];
  setError: Dispatch<SetStateAction<string | null>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  showAgentHelpCreditsRequiredToast: () => void;
  setRealtimeTranscriptLines: Dispatch<SetStateAction<LiveTranscriptLine[]>>;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
}): void {
  const {
    payload,
    participant,
    topic,
    joinedRoom,
    setError,
    setSyncedConversationModeActive,
    setSyncedAgentHelpPhase,
    showAgentHelpCreditsRequiredToast,
    setRealtimeTranscriptLines,
    setAssistantDisplayNamesByIdentity,
    applyAssistantPresencePayload,
  } = input;
  try {
    const parsedResult = realtimeMeetingDataPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(payload)));
    if (!parsedResult.success) {
      return;
    }
    const parsed = parsedResult.data;
    if (topic === PRESENTATION_CLAIM_TOPIC) {
      return;
    }
    if (
      handleLiveMeetingAssistantNoticeTopic({
        parsed,
        topic,
        participant,
        localParticipantIdentity: joinedRoom.localParticipant.identity,
        showToast: input.showToast,
        setSyncedConversationModeActive,
        setSyncedAgentHelpPhase,
      })
    ) {
      return;
    }
    if (isAgentHelpCreditsRequiredPayload(parsed)) {
      const ownerIdentity = parsed.assistantOwnerParticipantIdentity?.trim() ?? "";
      if (ownerIdentity.length === 0 || ownerIdentity === joinedRoom.localParticipant.identity) {
        setError(null);
        setSyncedAgentHelpPhase("idle");
        showAgentHelpCreditsRequiredToast();
      }

      return;
    }
    if (isAssistantUtterancePayload(parsed)) {
      applyAssistantUtteranceToRealtimeTranscript({
        utterance: parsed,
        setRealtimeTranscriptLines,
        setAssistantDisplayNamesByIdentity,
      });

      return;
    }
    const assistantPresence = parseAssistantPresenceValue(parsed);
    if (!assistantPresence) {
      return;
    }

    applyAssistantPresencePayload(assistantPresence);
  } catch (error) {
    void describeCaughtFailure(error);
    if (participant !== undefined && isMeetingAgentParticipant(participant)) {
      const assistantIdentity = getStableSpeakerIdentityFromParticipant(participant);
      const assistantDisplayName = getAssistantDisplayName(participant);
      setAssistantDisplayNamesByIdentity((current) => ({
        ...current,
        [assistantIdentity]: assistantDisplayName,
      }));
    }
  }
}

type JoinMeetingMediaTrack = LocalTrack | MediaStreamTrack;

type LiveMeetingJoinBookkeepingContext = {
  meeting: Meeting;
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  joinStartedAt: number;
  endMeetingStartedRef: {
    /** @external ref wire */
    current: boolean;
  };
  joinBookkeepingRequestRef: { current: Promise<unknown> | null };
  runWithAuthRetry: <T>(action: (nextSession: AuthSession) => Promise<T>) => Promise<T>;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  setJoinedWorkspaceToSync: Dispatch<SetStateAction<string | null>>;
  setMeeting: Dispatch<SetStateAction<Meeting | null>>;
  setActiveHumanParticipants: Dispatch<
    SetStateAction<MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"]>
  >;
  setLiveTranscriptSegments: Dispatch<SetStateAction<MeetingDetailPayload["transcriptSegments"]>>;
  setHasJoinedMeeting: Dispatch<SetStateAction<boolean>>;
};

function isEndMeetingStarted(ref: LiveMeetingJoinBookkeepingContext["endMeetingStartedRef"]): boolean {
  return ref.current;
}

async function attemptLiveMeetingJoinBookkeeping(
  input: LiveMeetingJoinBookkeepingContext & { attempt: number },
): Promise<boolean> {
  const {
    attempt,
    meeting,
    joinConnect,
    joinStartedAt,
    endMeetingStartedRef,
    joinBookkeepingRequestRef,
    runWithAuthRetry,
    refreshRealtimeAuth,
    setJoinedWorkspaceToSync,
    setMeeting,
    setActiveHumanParticipants,
    setLiveTranscriptSegments,
    setHasJoinedMeeting,
  } = input;

  if (isEndMeetingStarted(endMeetingStartedRef)) {
    return false;
  }
  try {
    const joinRequest = runWithAuthRetry((nextSession) =>
      runMeetingJoinUnlessDeparting({
        isDeparting: () => isEndMeetingStarted(endMeetingStartedRef),
        join: () => joinMeeting({ token: nextSession.token, meetingId: meeting.id }),
      }),
    );
    joinBookkeepingRequestRef.current = joinRequest;
    try {
      const joined = await joinRequest;
      const activeWorkspaceId = joined?.activeWorkspaceId;
      if (
        !isEndMeetingStarted(endMeetingStartedRef) &&
        typeof activeWorkspaceId === "string" &&
        activeWorkspaceId.length > 0 &&
        activeWorkspaceId !== joinConnect.snapshot.auth.user.workspaceId
      ) {
        setJoinedWorkspaceToSync(activeWorkspaceId);
      }
    } finally {
      if (joinBookkeepingRequestRef.current === joinRequest) {
        joinBookkeepingRequestRef.current = null;
      }
    }
    if (isEndMeetingStarted(endMeetingStartedRef)) {
      return false;
    }
    try {
      await refreshRealtimeAuth("meeting-joined");
    } catch (nextError) {
      console.error("[readymeet:realtime] Ably auth refresh after meeting join failed.", nextError);
    }
    const detail = await runWithAuthRetry((nextSession) =>
      getMeeting({ token: nextSession.token, meetingId: meeting.id }),
    );
    if (isEndMeetingStarted(endMeetingStartedRef)) {
      return false;
    }

    setMeeting(detail.meeting);
    setActiveHumanParticipants(detail.meetingRuntime.activeHumanParticipants);
    setLiveTranscriptSegments(detail.transcriptSegments);
    setHasJoinedMeeting(true);

    return true;
  } catch (nextError) {
    if (isEndMeetingStarted(endMeetingStartedRef)) {
      return false;
    }
    if (attempt >= JOIN_BOOKKEEPING_MAX_ATTEMPTS) {
      console.error("[readymeet] Meeting join bookkeeping failed; staying connected.", nextError);
      sendMeetingClientDiagnostic({
        token: joinConnect.snapshot.auth.token,
        meetingId: meeting.id,
        diagnostic: {
          event: "join-bookkeeping-failed",
          phase: "bookkeeping",
          outcome: "failed",
          attempt,
          durationMs: Math.round(performance.now() - joinStartedAt),
          ...getClientDiagnosticError(nextError),
        },
      });

      return false;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, JOIN_BOOKKEEPING_RETRY_BACKOFF_MS * attempt);
    });

    return attemptLiveMeetingJoinBookkeeping({ ...input, attempt: attempt + 1 });
  }
}

async function runLiveMeetingJoinBookkeeping(input: LiveMeetingJoinBookkeepingContext): Promise<boolean> {
  return attemptLiveMeetingJoinBookkeeping({ ...input, attempt: 1 });
}

async function createLiveMeetingJoinMediaPromise(input: {
  initialMediaTracks: JoinMeetingMediaTrack[] | null;
  initialMediaErrors: { audioError: Error | null; videoError: Error | null } | null;
  launchMediaPromise: ReturnType<typeof takeMeetingLaunchMedia> | null;
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
}): Promise<{
  audioTracks: JoinMeetingMediaTrack[];
  videoTracks: JoinMeetingMediaTrack[];
  audioError: Error | null;
  videoError: Error | null;
}> {
  const { initialMediaTracks, initialMediaErrors, launchMediaPromise, audioDeviceId, videoDeviceId } = input;
  const hasInitialMediaTracks = (initialMediaTracks?.length ?? 0) > 0;
  if (hasInitialMediaTracks) {
    const tracks = initialMediaTracks ?? [];

    return {
      audioTracks: tracks.filter((track) => track.kind === Track.Kind.Audio),
      videoTracks: tracks.filter((track) => track.kind === Track.Kind.Video),
      audioError: initialMediaErrors?.audioError ?? null,
      videoError: initialMediaErrors?.videoError ?? null,
    };
  }

  const acquired = await (launchMediaPromise ??
    acquireMeetingMediaTracks({
      audioDeviceId,
      videoDeviceId,
    }));

  return {
    audioTracks: acquired.tracks.filter((track) => track.kind === Track.Kind.Audio),
    videoTracks: acquired.tracks.filter((track) => track.kind === Track.Kind.Video),
    audioError: acquired.audioError,
    videoError: acquired.videoError,
  };
}

type WireLiveMeetingJoinRoomSessionHandlersInput = {
  joinedRoom: Room;
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setPresenceVersion: Dispatch<SetStateAction<number>>;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
  owedVoiceStopRef: { current: ReturnType<typeof createOwedVoiceStop> | null };
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  isConversationModeActiveRef: {
    /** @external ref wire */
    current: boolean;
  };
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  updateDataPresentationClaims: (
    update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>,
  ) => void;
  showToast: ReturnType<typeof useToast>["showToast"];
  setError: Dispatch<SetStateAction<string | null>>;
  showAgentHelpCreditsRequiredToast: () => void;
  setRealtimeTranscriptLines: Dispatch<SetStateAction<LiveTranscriptLine[]>>;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  clientDiagnosticContextRef: { current: { token: string; meetingId: string } | null };
  remoteMeetingEndRef: { current: (() => void) | null };
  videoDeviceId: string | undefined;
  audioDeviceId: string | undefined;
};

function createLiveMeetingJoinRoomVoiceSession(input: {
  joinedRoom: Room;
  owedVoiceStopRef: { current: ReturnType<typeof createOwedVoiceStop> | null };
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  isConversationModeActiveRef: {
    /** @external ref wire */
    current: boolean;
  };
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  refreshPresence: () => void;
  syncAssistantPresenceFromParticipants: () => void;
  updateDataPresentationClaims: (
    update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>,
  ) => void;
  connectionQualityDiagnosticLimiter: ReturnType<typeof createConnectionQualityDiagnosticLimiter>;
}) {
  const {
    joinedRoom,
    owedVoiceStopRef,
    voiceModeIntentRef,
    isConversationModeActiveRef,
    voiceModeRpcPendingRef,
    setVoiceModePendingAction,
    setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase,
    refreshPresence,
    syncAssistantPresenceFromParticipants,
    updateDataPresentationClaims,
    connectionQualityDiagnosticLimiter,
  } = input;
  const owedVoiceStop = createOwedVoiceStop(joinedRoom, isMeetingAgentParticipant);
  owedVoiceStopRef.current = owedVoiceStop;
  const invalidateVoiceMode = () => {
    const isVoiceModeActive =
      voiceModeIntentRef.current.canActivate() || isConversationModeActiveRef.current || voiceModeRpcPendingRef.current;
    voiceModeIntentRef.current.invalidate();
    voiceModeRpcPendingRef.current = false;
    setVoiceModePendingAction(null);
    setSyncedConversationModeActive(false);
    if (isVoiceModeActive) {
      setSyncedAgentHelpOwnerParticipantIdentity(null);
      setSyncedAgentHelpPhase("idle");
      owedVoiceStop.owe();
    }
  };
  const refreshParticipantPresence = () => {
    if (!canUseSoloVoice(joinedRoom)) {
      invalidateVoiceMode();
    }
    refreshPresence();
    syncAssistantPresenceFromParticipants();
    void owedVoiceStop.settle();
  };
  const handleParticipantDisconnected = (roomParticipant: Participant) => {
    connectionQualityDiagnosticLimiter.removeParticipant(roomParticipant.identity);
    refreshPresence();
    updateDataPresentationClaims((current) =>
      removePresentationClaim({ claimsByIdentity: current, participantIdentity: roomParticipant.identity }),
    );
    if (isMeetingAgentParticipant(roomParticipant)) {
      invalidateVoiceMode();
      setSyncedAgentHelpOwnerParticipantIdentity(null);
      setSyncedAgentHelpPhase("idle");
    }
  };

  return { invalidateVoiceMode, owedVoiceStop, refreshParticipantPresence, handleParticipantDisconnected };
}

function createLiveMeetingJoinRoomClientDiagnosticSender(clientDiagnosticContextRef: {
  current: { token: string; meetingId: string } | null;
}) {
  return (diagnostic: MeetingClientDiagnostic) => {
    const diagnosticContext = clientDiagnosticContextRef.current;
    if (diagnosticContext) {
      sendMeetingClientDiagnostic({
        token: diagnosticContext.token,
        meetingId: diagnosticContext.meetingId,
        diagnostic,
      });
    }
  };
}

function createLiveMeetingJoinRoomSessionDataHandlers(input: {
  joinedRoom: Room;
  showToast: ReturnType<typeof useToast>["showToast"];
  setError: Dispatch<SetStateAction<string | null>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  showAgentHelpCreditsRequiredToast: () => void;
  setRealtimeTranscriptLines: Dispatch<SetStateAction<LiveTranscriptLine[]>>;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
  clientDiagnosticContextRef: { current: { token: string; meetingId: string } | null };
  videoDeviceId: string | undefined;
  audioDeviceId: string | undefined;
}) {
  const onDataReceived = (received: {
    payload: Uint8Array;
    participant?: Participant;
    kind?: unknown;
    topic?: string;
  }) => {
    handleLiveMeetingRoomDataReceived({
      payload: received.payload,
      participant: received.participant,
      topic: received.topic,
      joinedRoom: input.joinedRoom,
      showToast: input.showToast,
      setError: input.setError,
      setSyncedConversationModeActive: input.setSyncedConversationModeActive,
      setSyncedAgentHelpPhase: input.setSyncedAgentHelpPhase,
      showAgentHelpCreditsRequiredToast: input.showAgentHelpCreditsRequiredToast,
      setRealtimeTranscriptLines: input.setRealtimeTranscriptLines,
      setAssistantDisplayNamesByIdentity: input.setAssistantDisplayNamesByIdentity,
      applyAssistantPresencePayload: input.applyAssistantPresencePayload,
    });
  };
  const onMediaDevicesError = (mediaError: Error) => {
    reportLiveMeetingMediaDevicesError({
      room: input.joinedRoom,
      mediaError,
      videoDeviceId: input.videoDeviceId,
      audioDeviceId: input.audioDeviceId,
      diagnosticContext: input.clientDiagnosticContextRef.current,
    });
  };

  return { onDataReceived, onMediaDevicesError };
}

function createLiveMeetingJoinRoomSessionPresenceHandlers(input: {
  joinedRoom: Room;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setPresenceVersion: Dispatch<SetStateAction<number>>;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
}) {
  const refreshTracks = () => {
    const nextTracks = getTrackViews({ room: requireMeetingRoom(input.joinedRoom) });
    input.setTracks((current) => (areTrackViewsEqual({ previous: current, next: nextTracks }) ? current : nextTracks));
  };
  const refreshPresence = () => {
    input.setPresenceVersion((current) => current + 1);
  };
  const syncAssistantPresenceFromParticipants = () => {
    Array.from(input.joinedRoom.remoteParticipants.values()).forEach((roomParticipant) => {
      const assistantPresence = getAssistantPresencePayloadFromParticipant(roomParticipant);
      if (assistantPresence) {
        input.applyAssistantPresencePayload(assistantPresence);
      }
    });
  };

  return { refreshTracks, refreshPresence, syncAssistantPresenceFromParticipants };
}

function wireLiveMeetingJoinRoomSessionHandlers(input: WireLiveMeetingJoinRoomSessionHandlersInput): {
  syncAssistantPresenceFromParticipants: () => void;
} {
  const {
    joinedRoom,
    joinConnect,
    setTracks,
    setPresenceVersion,
    applyAssistantPresencePayload,
    owedVoiceStopRef,
    voiceModeIntentRef,
    isConversationModeActiveRef,
    voiceModeRpcPendingRef,
    setVoiceModePendingAction,
    setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase,
    updateDataPresentationClaims,
    showToast,
    setError,
    showAgentHelpCreditsRequiredToast,
    setRealtimeTranscriptLines,
    setAssistantDisplayNamesByIdentity,
    setConnectionState,
    clientDiagnosticContextRef,
    remoteMeetingEndRef,
    videoDeviceId,
    audioDeviceId,
  } = input;
  const connectionQualityDiagnosticLimiter = createConnectionQualityDiagnosticLimiter();
  const trackStreamDiagnosticLimiter = createTrackStreamDiagnosticLimiter();
  const sendCurrentClientDiagnostic = createLiveMeetingJoinRoomClientDiagnosticSender(clientDiagnosticContextRef);

  const { refreshTracks, refreshPresence, syncAssistantPresenceFromParticipants } =
    createLiveMeetingJoinRoomSessionPresenceHandlers({
      joinedRoom,
      setTracks,
      setPresenceVersion,
      applyAssistantPresencePayload,
    });
  const { invalidateVoiceMode, owedVoiceStop, refreshParticipantPresence, handleParticipantDisconnected } =
    createLiveMeetingJoinRoomVoiceSession({
      joinedRoom,
      owedVoiceStopRef,
      voiceModeIntentRef,
      isConversationModeActiveRef,
      voiceModeRpcPendingRef,
      setVoiceModePendingAction,
      setSyncedConversationModeActive,
      setSyncedAgentHelpOwnerParticipantIdentity,
      setSyncedAgentHelpPhase,
      refreshPresence,
      syncAssistantPresenceFromParticipants,
      updateDataPresentationClaims,
      connectionQualityDiagnosticLimiter,
    });

  const { onDataReceived, onMediaDevicesError } = createLiveMeetingJoinRoomSessionDataHandlers({
    joinedRoom,
    showToast,
    setError,
    setSyncedConversationModeActive,
    setSyncedAgentHelpPhase,
    showAgentHelpCreditsRequiredToast,
    setRealtimeTranscriptLines,
    setAssistantDisplayNamesByIdentity,
    applyAssistantPresencePayload,
    clientDiagnosticContextRef,
    videoDeviceId,
    audioDeviceId,
  });

  wireLiveMeetingJoinedRoomTrackHandlers({
    joinedRoom,
    refreshTracks,
    refreshParticipantPresence,
    handleParticipantDisconnected,
    refreshPresence,
  });
  wireLiveMeetingJoinedRoomConnectionHandlers({
    joinedRoom,
    joinConnect,
    invalidateVoiceMode,
    owedVoiceStop,
    setConnectionState,
    sendCurrentClientDiagnostic,
    connectionQualityDiagnosticLimiter,
  });
  wireLiveMeetingJoinedRoomMediaHandlers({
    joinedRoom,
    joinConnect,
    sendCurrentClientDiagnostic,
    trackStreamDiagnosticLimiter,
    clientDiagnosticContextRef,
    remoteMeetingEndRef,
    onDataReceived,
    onMediaDevicesError,
  });

  return { syncAssistantPresenceFromParticipants };
}

function wireLiveMeetingJoinedRoomTrackHandlers(input: {
  joinedRoom: Room;
  refreshTracks: () => void;
  refreshParticipantPresence: () => void;
  handleParticipantDisconnected: (roomParticipant: Participant) => void;
  refreshPresence: () => void;
}): void {
  const { joinedRoom, refreshTracks, refreshParticipantPresence, handleParticipantDisconnected, refreshPresence } =
    input;

  joinedRoom.on(RoomEvent.TrackSubscribed, refreshTracks);
  joinedRoom.on(RoomEvent.TrackUnsubscribed, refreshTracks);
  joinedRoom.on(RoomEvent.LocalTrackPublished, refreshTracks);
  joinedRoom.on(RoomEvent.LocalTrackUnpublished, refreshTracks);
  joinedRoom.on(RoomEvent.TrackPublished, refreshTracks);
  joinedRoom.on(RoomEvent.TrackUnpublished, refreshTracks);
  joinedRoom.on(RoomEvent.TrackMuted, refreshTracks);
  joinedRoom.on(RoomEvent.TrackUnmuted, refreshTracks);
  joinedRoom.on(RoomEvent.ParticipantConnected, refreshParticipantPresence);
  joinedRoom.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
  joinedRoom.on(RoomEvent.ParticipantAttributesChanged, refreshParticipantPresence);
  joinedRoom.on(RoomEvent.TrackPublished, refreshPresence);
  joinedRoom.on(RoomEvent.TrackUnpublished, refreshPresence);
  joinedRoom.on(RoomEvent.TrackMuted, refreshPresence);
  joinedRoom.on(RoomEvent.TrackUnmuted, refreshPresence);
}

function wireLiveMeetingJoinedRoomConnectionHandlers(input: {
  joinedRoom: Room;
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  invalidateVoiceMode: () => void;
  owedVoiceStop: ReturnType<typeof createOwedVoiceStop>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  sendCurrentClientDiagnostic: (diagnostic: MeetingClientDiagnostic) => void;
  connectionQualityDiagnosticLimiter: ReturnType<typeof createConnectionQualityDiagnosticLimiter>;
}): void {
  const {
    joinedRoom,
    joinConnect,
    invalidateVoiceMode,
    owedVoiceStop,
    setConnectionState,
    sendCurrentClientDiagnostic,
    connectionQualityDiagnosticLimiter,
  } = input;

  joinedRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
    if (state !== ConnectionState.Connected && state !== ConnectionState.SignalReconnecting) {
      invalidateVoiceMode();
    }
    if (state === ConnectionState.Connected) {
      void owedVoiceStop.settle();
    }
    setConnectionState(state);
    sendCurrentClientDiagnostic({
      event: "connection-state",
      phase: joinConnect.snapshot.connectionPhase,
      outcome: "changed",
      connectionState: state,
    });
  });
  joinedRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
    if (!connectionQualityDiagnosticLimiter.shouldReport({ participantIdentity: participant.identity, quality })) {
      return;
    }
    sendCurrentClientDiagnostic({
      event: "connection-quality",
      phase: "in-room",
      outcome: "degraded",
      connectionQuality: quality === ConnectionQuality.Lost ? "lost" : "poor",
      remoteParticipantIdentity:
        participant.identity === joinedRoom.localParticipant.identity ? undefined : participant.identity,
    });
  });
}

function wireLiveMeetingJoinedRoomMediaHandlers(input: {
  joinedRoom: Room;
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  sendCurrentClientDiagnostic: (diagnostic: MeetingClientDiagnostic) => void;
  trackStreamDiagnosticLimiter: ReturnType<typeof createTrackStreamDiagnosticLimiter>;
  clientDiagnosticContextRef: { current: { token: string; meetingId: string } | null };
  remoteMeetingEndRef: { current: (() => void) | null };
  onDataReceived: (received: {
    payload: Uint8Array;
    participant?: Participant;
    kind?: unknown;
    topic?: string;
  }) => void;
  onMediaDevicesError: (mediaError: Error) => void;
}): void {
  const {
    joinedRoom,
    joinConnect,
    sendCurrentClientDiagnostic,
    trackStreamDiagnosticLimiter,
    clientDiagnosticContextRef,
    remoteMeetingEndRef,
    onDataReceived,
    onMediaDevicesError,
  } = input;

  joinedRoom.on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant, subscriptionError) => {
    const publication = participant.getTrackPublicationBySid(trackSid);
    sendCurrentClientDiagnostic({
      event: "track-subscription-failed",
      phase: "in-room",
      outcome: "failed",
      kind: getDiagnosticTrackKind(publication?.source),
      remoteParticipantIdentity: participant.identity,
      trackSid,
      ...getTrackSubscriptionDiagnosticError(subscriptionError),
    });
  });
  joinedRoom.on(RoomEvent.TrackStreamStateChanged, (publication, streamState, participant) => {
    if (
      !trackStreamDiagnosticLimiter.shouldReport(
        publication.trackSid,
        streamState,
        isTrackAttachedToVisibleVideo(publication),
      )
    ) {
      return;
    }
    sendCurrentClientDiagnostic({
      event: "track-stream-state",
      phase: "in-room",
      outcome: "degraded",
      kind: getDiagnosticTrackKind(publication.source),
      remoteParticipantIdentity: participant.identity,
      trackSid: publication.trackSid,
      trackState: "paused",
    });
  });
  joinedRoom.on(RoomEvent.AudioPlaybackStatusChanged, (canPlayback) => {
    sendCurrentClientDiagnostic({
      event: "audio-playback",
      phase: "in-room",
      outcome: canPlayback ? "succeeded" : "failed",
    });
  });
  joinedRoom.on(RoomEvent.VideoPlaybackStatusChanged, (canPlayback) => {
    sendCurrentClientDiagnostic({
      event: "video-playback",
      phase: "in-room",
      outcome: canPlayback ? "succeeded" : "failed",
    });
  });
  joinedRoom.on(RoomEvent.Disconnected, (reason) => {
    if (reason === DisconnectReason.ROOM_DELETED) {
      remoteMeetingEndRef.current?.();
    }
    const diagnosticContext = clientDiagnosticContextRef.current;
    if (!diagnosticContext) {
      return;
    }
    sendMeetingClientDiagnostic({
      token: diagnosticContext.token,
      meetingId: diagnosticContext.meetingId,
      diagnostic: {
        event: "room-disconnected",
        phase: joinConnect.snapshot.connectionPhase,
        outcome: "changed",
        connectionState: ConnectionState.Disconnected,
        disconnectReason: getDiagnosticDisconnectReason(reason),
      },
      options: { keepalive: true },
    });
  });
  joinedRoom.on(RoomEvent.DataReceived, (payload, participant, kind, topic) =>
    onDataReceived({ payload, participant, kind, topic }),
  );
  joinedRoom.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
}

async function loadConnectedCalendarProvidersForVoiceTool(input: {
  session: AuthSession | null;
  request: ReturnType<typeof parseVoiceToolApprovalRpcPayload>;
}): Promise<Set<CalendarProvider>> {
  const connectedCalendarProviders = new Set<CalendarProvider>();
  if (input.session === null) {
    return connectedCalendarProviders;
  }
  try {
    const settings = await getMyAgentSettings({
      token: input.session.token,
      signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
    });
    settings.connectors.forEach((connector) => {
      if (isCalendarProvider(connector.provider) && connector.status === "connected") {
        connectedCalendarProviders.add(connector.provider);
      }
    });
  } catch (error) {
    if (reportOptionalLiveServiceFailure({ error, feature: "calendar" })) {
      throw error;
    }
    void describeCaughtFailure(error);
    if (input.request.tool === "calendar" && input.request.action === "disable" && input.request.provider === null) {
      throw new RpcError(
        RpcError.ErrorCode.APPLICATION_ERROR,
        LIVE_MEETING_PAGE_COPY.voiceToolCalendarSkillsCheckFailed,
      );
    }
  }

  return connectedCalendarProviders;
}

function handleConversationModeToggleRpcError(input: {
  nextError: unknown;
  isStarting: boolean;
  voiceAttempt: { isRejected: boolean };
  showAgentHelpCreditsRequiredToast: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
}): void {
  const { nextError, isStarting, voiceAttempt, showAgentHelpCreditsRequiredToast, setError } = input;
  if (
    reportOptionalLiveServiceFailure({ error: nextError, feature: "assistant" }) ||
    (nextError instanceof Error &&
      [LIVE_MEETING_PAGE_COPY.voiceModeAgentJoining, LIVE_MEETING_PAGE_COPY.voiceModeUnavailable].some(
        (message) => nextError.message === message,
      ))
  ) {
    voiceAttempt.isRejected = true;
    console.error("[readymeet:optional-live-feature] assistant voice request unavailable.");

    return;
  }
  voiceAttempt.isRejected = !(
    nextError instanceof RpcError &&
    [
      RpcError.ErrorCode.CONNECTION_TIMEOUT,
      RpcError.ErrorCode.RESPONSE_TIMEOUT,
      RpcError.ErrorCode.RECIPIENT_DISCONNECTED,
    ].some((code) => nextError.code === code)
  );
  if (isAgentHelpCreditsRequiredError(nextError)) {
    voiceAttempt.isRejected = true;
    showAgentHelpCreditsRequiredToast();
    setError(null);

    return;
  }
  const conflictNotice = getAssistantTurnConflictNotice(nextError);
  if (conflictNotice !== null && conflictNotice.length > 0) {
    voiceAttempt.isRejected = true;
    setError(conflictNotice);

    return;
  }
  setError(
    getErrorMessage({
      error: nextError,
      fallback: isStarting ? LIVE_MEETING_PAGE_COPY.voiceModeStartFailed : LIVE_MEETING_PAGE_COPY.voiceModeEndFailed,
    }),
  );
}

function finalizeConversationModeToggleRpc(input: {
  voiceRpcFinalize: {
    /** @external ref wire */
    shouldClearPending: boolean;
  };
  requestRevision: number;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  voiceModeRpcPendingControl: {
    /** @external ref wire */
    current: boolean;
  };
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  voiceAttempt: {
    isSucceeded: boolean;
    isRejected: boolean;
  };
  isStarting: boolean;
  isPreviousConversationModeActive: boolean;
  isPreviousOwnerParticipantIdentity: string | null;
  isPreviousAgentHelpPhase: AgentHelpPhase;
  room: Room | null;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
}): void {
  const {
    voiceRpcFinalize,
    requestRevision,
    voiceModeIntentRef,
    voiceModeRpcPendingControl,
    setVoiceModePendingAction,
    voiceAttempt,
    isStarting,
    isPreviousConversationModeActive,
    isPreviousOwnerParticipantIdentity,
    isPreviousAgentHelpPhase,
    room,
    setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase,
    applyAssistantPresencePayload,
  } = input;
  if (!voiceRpcFinalize.shouldClearPending || !voiceModeIntentRef.current.isCurrent(requestRevision)) {
    return;
  }
  voiceModeRpcPendingControl.current = false;
  setVoiceModePendingAction(null);
  if (voiceAttempt.isSucceeded) {
    return;
  }
  const isRestoreConversationModeActive =
    isStarting && !voiceAttempt.isRejected ? true : isPreviousConversationModeActive;
  voiceModeIntentRef.current.begin(isRestoreConversationModeActive);
  setSyncedConversationModeActive(isRestoreConversationModeActive);
  setSyncedAgentHelpOwnerParticipantIdentity(
    isRestoreConversationModeActive
      ? (room?.localParticipant.identity ?? isPreviousOwnerParticipantIdentity)
      : isPreviousOwnerParticipantIdentity,
  );
  setSyncedAgentHelpPhase(isPreviousAgentHelpPhase);
  restoreAssistantPresenceAfterFailedVoiceRpc({
    room,
    isStarting,
    isVoiceAttemptRejected: voiceAttempt.isRejected,
    applyAssistantPresencePayload,
  });
}

function shouldSkipConversationModeToggle(input: {
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  controlState: ReturnType<typeof getVoiceModeControlState>;
  room: Room | null;
}): boolean {
  return (
    input.voiceModeRpcPendingRef.current ||
    input.controlState.action === "none" ||
    (input.controlState.action === "start" && !canUseSoloVoice(input.room))
  );
}

function applyConversationModeToggleSyncState(input: {
  isStarting: boolean;
  room: Room | null;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
}): void {
  if (input.isStarting) {
    input.setSyncedConversationModeActive(true);
    input.setSyncedAgentHelpOwnerParticipantIdentity(input.room?.localParticipant.identity ?? null);
  } else {
    input.setSyncedConversationModeActive(false);
    input.setSyncedAgentHelpOwnerParticipantIdentity(null);
    input.setSyncedAgentHelpPhase("idle");
  }
}

async function awaitOwedVoiceStopForConversationModeToggle(input: {
  owedVoiceStopRef: { current: ReturnType<typeof createOwedVoiceStop> | null };
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  requestRevision: number;
  room: Room | null;
}): Promise<{ shouldContinue: boolean; shouldClearPending: boolean }> {
  const owedVoiceStop = input.owedVoiceStopRef.current;
  if (owedVoiceStop === null || !owedVoiceStop.hasPending()) {
    return { shouldContinue: true, shouldClearPending: true };
  }
  const isVoiceStopSettled = await owedVoiceStop.settle();
  if (!input.voiceModeIntentRef.current.isCurrent(input.requestRevision)) {
    return { shouldContinue: false, shouldClearPending: false };
  }
  if (!isVoiceStopSettled) {
    const hasAgent =
      input.room !== null && Array.from(input.room.remoteParticipants.values()).some(isMeetingAgentParticipant);

    throw new Error(
      hasAgent ? LIVE_MEETING_PAGE_COPY.voiceModeStopConfirmFailed : LIVE_MEETING_PAGE_COPY.voiceModeAgentJoining,
    );
  }

  return { shouldContinue: true, shouldClearPending: true };
}

type PerformAssistantRpcForConversationToggle = (input: {
  method:
    | typeof INTERRUPT_SPEECH_RPC
    | typeof REFRESH_AGENT_CONTEXT_RPC
    | typeof START_CONVERSATION_MODE_RPC
    | typeof STOP_CONVERSATION_MODE_RPC;
  payload?: string;
  voiceRequestRevision?: number;
}) => Promise<string | null>;

async function executeConversationModeToggleRpc(input: {
  isStarting: boolean;
  method: typeof START_CONVERSATION_MODE_RPC | typeof STOP_CONVERSATION_MODE_RPC;
  requestRevision: number;
  room: Room | null;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  owedVoiceStopRef: { current: ReturnType<typeof createOwedVoiceStop> | null };
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  performAssistantRpc: PerformAssistantRpcForConversationToggle;
  applyAssistantPresenceFromRpcResponse: (response: string | null) => boolean;
}): Promise<{
  voiceAttempt: { isSucceeded: boolean; isRejected: boolean };
  shouldClearPending: boolean;
}> {
  const voiceAttempt = { isSucceeded: false, isRejected: false };
  const owedVoiceStopResult = await awaitOwedVoiceStopForConversationModeToggle({
    owedVoiceStopRef: input.owedVoiceStopRef,
    voiceModeIntentRef: input.voiceModeIntentRef,
    requestRevision: input.requestRevision,
    room: input.room,
  });
  if (!owedVoiceStopResult.shouldContinue) {
    return { voiceAttempt, shouldClearPending: owedVoiceStopResult.shouldClearPending };
  }
  applyConversationModeToggleSyncState({
    isStarting: input.isStarting,
    room: input.room,
    setSyncedConversationModeActive: input.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: input.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: input.setSyncedAgentHelpPhase,
  });
  const response = await input.performAssistantRpc({
    method: input.method,
    payload: "",
    voiceRequestRevision: input.requestRevision,
  });
  if (!input.voiceModeIntentRef.current.isCurrent(input.requestRevision)) {
    return { voiceAttempt, shouldClearPending: false };
  }
  if (response === "warming-up") {
    voiceAttempt.isRejected = true;
    throw new Error(LIVE_MEETING_PAGE_COPY.voiceModeAgentJoining);
  }
  if (response === "disabled") {
    voiceAttempt.isRejected = true;
    throw new Error(LIVE_MEETING_PAGE_COPY.voiceModeUnavailable);
  }

  input.applyAssistantPresenceFromRpcResponse(response);
  applyConversationModeToggleSyncState({
    isStarting: input.isStarting,
    room: input.room,
    setSyncedConversationModeActive: input.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: input.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: input.setSyncedAgentHelpPhase,
  });
  voiceAttempt.isSucceeded = true;

  return { voiceAttempt, shouldClearPending: true };
}

type RunConversationModeToggleInput = {
  isConversationModeActive: boolean;
  agentHelpOwnerParticipantIdentity: string | null;
  agentHelpPhase: AgentHelpPhase;
  voiceModePendingAction: VoiceModePendingAction;
  room: Room | null;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  owedVoiceStopRef: { current: ReturnType<typeof createOwedVoiceStop> | null };
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  setIsAgentHelpTooltipDismissed: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  performAssistantRpc: PerformAssistantRpcForConversationToggle;
  applyAssistantPresenceFromRpcResponse: (response: string | null) => boolean;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
  showAgentHelpCreditsRequiredToast: () => void;
};

async function runConversationModeToggleAttempt(
  input: RunConversationModeToggleInput & {
    isStarting: boolean;
    method: typeof START_CONVERSATION_MODE_RPC | typeof STOP_CONVERSATION_MODE_RPC;
    requestRevision: number;
    voiceRpcFinalize: { shouldClearPending: boolean };
    voiceAttempt: { isSucceeded: boolean; isRejected: boolean };
  },
): Promise<void> {
  const rpcResult = await executeConversationModeToggleRpc({
    isStarting: input.isStarting,
    method: input.method,
    requestRevision: input.requestRevision,
    room: input.room,
    voiceModeIntentRef: input.voiceModeIntentRef,
    owedVoiceStopRef: input.owedVoiceStopRef,
    setSyncedConversationModeActive: input.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: input.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: input.setSyncedAgentHelpPhase,
    performAssistantRpc: input.performAssistantRpc,
    applyAssistantPresenceFromRpcResponse: input.applyAssistantPresenceFromRpcResponse,
  });
  const { voiceAttempt, voiceRpcFinalize } = input;
  voiceAttempt.isSucceeded = rpcResult.voiceAttempt.isSucceeded;
  voiceAttempt.isRejected = rpcResult.voiceAttempt.isRejected;
  voiceRpcFinalize.shouldClearPending = rpcResult.shouldClearPending;
}

export async function runConversationModeToggle(input: RunConversationModeToggleInput): Promise<void> {
  const controlState = getVoiceModeControlState({
    conversationModeActive: input.isConversationModeActive,
    localParticipantIdentity: input.room?.localParticipant.identity ?? null,
    ownerParticipantIdentity: input.agentHelpOwnerParticipantIdentity,
    pendingAction: input.voiceModePendingAction,
  });
  if (
    shouldSkipConversationModeToggle({
      voiceModeRpcPendingRef: input.voiceModeRpcPendingRef,
      controlState,
      room: input.room,
    })
  ) {
    return;
  }

  const isStarting = controlState.action === "start";
  const requestRevision = input.voiceModeIntentRef.current.begin(isStarting);
  const method = isStarting ? START_CONVERSATION_MODE_RPC : STOP_CONVERSATION_MODE_RPC;
  const isPreviousConversationModeActive = input.isConversationModeActive;
  const isPreviousOwnerParticipantIdentity = input.agentHelpOwnerParticipantIdentity;
  const isPreviousAgentHelpPhase = input.agentHelpPhase;
  const voiceModeRpcPendingControl = input.voiceModeRpcPendingRef;
  voiceModeRpcPendingControl.current = true;
  input.setVoiceModePendingAction(isStarting ? "starting" : "stopping");
  input.setIsAgentHelpTooltipDismissed(true);
  input.setError(null);
  const voiceRpcFinalize = { shouldClearPending: true };
  const voiceAttempt = { isSucceeded: false, isRejected: false };

  try {
    await runConversationModeToggleAttempt({
      ...input,
      isStarting,
      method,
      requestRevision,
      voiceRpcFinalize,
      voiceAttempt,
    });
    if (!voiceRpcFinalize.shouldClearPending && !voiceAttempt.isSucceeded) {
      return;
    }
  } catch (nextError) {
    if (!input.voiceModeIntentRef.current.isCurrent(requestRevision)) {
      voiceRpcFinalize.shouldClearPending = false;

      return;
    }
    handleConversationModeToggleRpcError({
      nextError,
      isStarting,
      voiceAttempt,
      showAgentHelpCreditsRequiredToast: input.showAgentHelpCreditsRequiredToast,
      setError: input.setError,
    });
  } finally {
    finalizeConversationModeToggleRpc({
      voiceRpcFinalize,
      requestRevision,
      voiceModeIntentRef: input.voiceModeIntentRef,
      voiceModeRpcPendingControl,
      setVoiceModePendingAction: input.setVoiceModePendingAction,
      voiceAttempt,
      isStarting,
      isPreviousConversationModeActive,
      isPreviousOwnerParticipantIdentity,
      isPreviousAgentHelpPhase,
      room: input.room,
      setSyncedConversationModeActive: input.setSyncedConversationModeActive,
      setSyncedAgentHelpOwnerParticipantIdentity: input.setSyncedAgentHelpOwnerParticipantIdentity,
      setSyncedAgentHelpPhase: input.setSyncedAgentHelpPhase,
      applyAssistantPresencePayload: input.applyAssistantPresencePayload,
    });
  }
}

function assertVoiceToolApprovalRpcRequest(request: ReturnType<typeof parseVoiceToolApprovalRpcPayload>): void {
  if (
    (request.tool === null || request.tool.length === 0) &&
    (request.rawTool === null || request.rawTool.length === 0) &&
    request.provider === null
  ) {
    throw new RpcError(RpcError.ErrorCode.APPLICATION_ERROR, LIVE_MEETING_PAGE_COPY.voiceToolChooseToolFirst);
  }
  if (request.tool === "calendar" && request.provider === null && request.action !== "disable") {
    throw new RpcError(RpcError.ErrorCode.APPLICATION_ERROR, LIVE_MEETING_PAGE_COPY.voiceToolChooseCalendarProvider);
  }
}

function closeVoiceToolApprovalAuxiliaryPanels(input: {
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  input.setIsToolApprovalPanelOpen(false);
  input.setIsAmbientContextPanelOpen(false);
  input.setIsMeetingDetailsPanelOpen(false);
  input.setIsMeetingSettingsPanelOpen(false);
}

function mergeVoiceToolApprovalCardsFromRpc(input: {
  cards: VoiceToolApprovalCardDefinition[];
  connectedCalendarProviders: Set<CalendarProvider>;
  setToolApprovalCards: Dispatch<SetStateAction<VoiceToolApprovalCardState[]>>;
}): void {
  const { cards, connectedCalendarProviders, setToolApprovalCards } = input;
  setToolApprovalCards((current) => {
    return cards.reduce((nextCards, card) => {
      const existing = nextCards.find((item) => item.id === card.id);
      const isConnected = card.provider !== null && connectedCalendarProviders.has(card.provider);
      const status = isConnected || existing?.status === "connected" ? "connected" : "idle";

      return upsertVoiceToolApprovalCard({
        cards: nextCards,
        nextCard: {
          ...card,
          status,
          error: null,
          requestedAt: Date.now(),
        },
      });
    }, current);
  });
}

function openVoiceToolApprovalPanel(input: {
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  input.setIsPresencePanelOpen(false);
  input.setIsAmbientContextPanelOpen(false);
  input.setIsMeetingDetailsPanelOpen(false);
  input.setIsMeetingSettingsPanelOpen(false);
  input.setIsToolApprovalPanelOpen(true);
}

async function openVoiceToolApprovalPanelFromRpc(input: {
  payload: string;
  session: AuthSession | null;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setToolApprovalCards: Dispatch<SetStateAction<VoiceToolApprovalCardState[]>>;
}) {
  const {
    payload,
    session,
    setIsToolApprovalPanelOpen,
    setIsAmbientContextPanelOpen,
    setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen,
    setIsPresencePanelOpen,
    setToolApprovalCards,
  } = input;
  const request = parseVoiceToolApprovalRpcPayload(payload);
  assertVoiceToolApprovalRpcRequest(request);
  if (request.tool === "web_search") {
    closeVoiceToolApprovalAuxiliaryPanels({
      setIsToolApprovalPanelOpen,
      setIsAmbientContextPanelOpen,
      setIsMeetingDetailsPanelOpen,
      setIsMeetingSettingsPanelOpen,
    });

    return {
      status: "already_available",
      tool: "web_search",
    };
  }

  const connectedCalendarProviders = await (async () => {
    try {
      return await loadConnectedCalendarProvidersForVoiceTool({ session, request });
    } catch (error) {
      if (reportOptionalLiveServiceFailure({ error, feature: "calendar" })) {
        return null;
      }
      throw error;
    }
  })();
  if (connectedCalendarProviders === null) {
    return { status: "ignored", reason: "optional_service_unavailable" };
  }

  const cardRequests =
    request.tool === "calendar" && request.provider === null && request.action === "disable"
      ? Array.from(connectedCalendarProviders).map((provider) => ({ ...request, provider }))
      : [request];
  if (cardRequests.length === 0) {
    throw new RpcError(RpcError.ErrorCode.APPLICATION_ERROR, LIVE_MEETING_PAGE_COPY.voiceToolNoConnectedCalendar);
  }

  const cards = cardRequests.map((cardRequest) => buildVoiceToolApprovalCard(cardRequest));
  mergeVoiceToolApprovalCardsFromRpc({ cards, connectedCalendarProviders, setToolApprovalCards });
  openVoiceToolApprovalPanel({
    setIsPresencePanelOpen,
    setIsAmbientContextPanelOpen,
    setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen,
    setIsToolApprovalPanelOpen,
  });

  return {
    status: "shown",
    cardIds: cards.map((card) => card.id),
    kind: cards[0]?.kind ?? "connect",
    tool: cards[0]?.tool ?? request.tool,
    provider: cards[0]?.provider ?? request.provider,
    action: request.action,
  };
}

const MEETING_CLOSED_BEFORE_CAMERA_READY = "Meeting closed before camera was ready.";

function toPublishError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

async function publishJoinMeetingMediaTracks(input: {
  joinedRoom: Room;
  tracks: JoinMeetingMediaTrack[];
  shouldPublish: boolean;
  source: Track.Source;
  stopJoinTrack: (track: JoinMeetingMediaTrack) => void;
}): Promise<{ isPublished: boolean; publishFailure: Error | null }> {
  if (!input.shouldPublish || input.tracks.length === 0) {
    input.tracks.forEach((track) => {
      input.stopJoinTrack(track);
    });

    return { isPublished: false, publishFailure: null };
  }
  const publishRoom = requireMeetingRoom(input.joinedRoom);
  const results = await Promise.allSettled(
    input.tracks.map(async (track) => {
      if (input.joinedRoom.state !== ConnectionState.Connected) {
        throw new Error(MEETING_CLOSED_BEFORE_CAMERA_READY);
      }
      if (input.source === Track.Source.Camera) {
        return publishMeetingCamera(publishRoom.localParticipant, track);
      }

      return publishRoom.localParticipant.publishTrack(track, { source: input.source });
    }),
  );
  results.forEach((result, index) => {
    const failedTrack = input.tracks[index];
    if (result.status === "rejected" && failedTrack !== undefined) {
      input.stopJoinTrack(failedTrack);
    }
  });

  const rejection = results.find((result) => result.status === "rejected");

  return {
    isPublished: results.some((result) => result.status === "fulfilled"),
    publishFailure: rejection === undefined ? null : toPublishError(rejection.reason),
  };
}

type LiveMeetingConnectEffectInput = {
  activeSession: AuthSession;
  meeting: Meeting;
  didConnect: {
    /** @external ref wire */
    current: boolean;
  };
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<AuthSession | null>;
  microphonePermissionStateRef: { current: BrowserMediaPermissionState };
  cameraPermissionStateRef: { current: BrowserMediaPermissionState };
  clientDiagnosticContextRef: { current: { token: string; meetingId: string } | null };
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  initialMediaTracks: LocalTrack[] | null;
  initialMediaErrors: Pick<AcquiredMeetingMedia, "audioError" | "videoError"> | null;
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  isInitialBackgroundBlurEnabled: boolean | undefined;
  isBackgroundBlurEnabled: boolean;
  activeSessionUserSource: AuthSession["user"]["source"];
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
  setIsBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setHasJoinedMeeting: Dispatch<SetStateAction<boolean>>;
  setMediaControlError: (message: string) => void;
  setIsBackgroundBlurEnabled: Dispatch<SetStateAction<boolean>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setPublishedCameraBackgroundBlur: (input: { targetRoom: Room; isEnabled: boolean }) => Promise<void>;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  endMeetingStartedRef: {
    /** @external ref wire */
    current: boolean;
  };
  joinBookkeepingRequestRef: { current: Promise<unknown> | null };
  setMeeting: Dispatch<SetStateAction<Meeting | null>>;
  setActiveHumanParticipants: Dispatch<
    SetStateAction<MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"]>
  >;
  setRealtimeTranscriptLines: Dispatch<SetStateAction<LiveTranscriptLine[]>>;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setLiveTranscriptSegments: Dispatch<SetStateAction<MeetingDetailPayload["transcriptSegments"]>>;
  setJoinedWorkspaceToSync: Dispatch<SetStateAction<string | null>>;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  isConversationModeActiveRef: {
    /** @external ref wire */
    current: boolean;
  };
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  owedVoiceStopRef: { current: ReturnType<typeof createOwedVoiceStop> | null };
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  showToast: ReturnType<typeof useToast>["showToast"];
  showAgentHelpCreditsRequiredToast: () => void;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setPresenceVersion: Dispatch<SetStateAction<number>>;
  updateDataPresentationClaims: (
    update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>,
  ) => void;
  remoteMeetingEndRef: { current: (() => void) | null };
};

async function fetchLiveMeetingJoinBackgroundBlurPreference(token: string): Promise<boolean> {
  try {
    const preferences = await getMediaPreferences(token);

    return preferences.backgroundBlurEnabled;
  } catch (error) {
    void describeCaughtFailure(error);

    return false;
  }
}

async function createLiveMeetingJoinBackgroundBlurEnabledPromise(input: {
  isInitialBackgroundBlurEnabled: boolean | undefined;
  activeSession: AuthSession;
  isBackgroundBlurEnabled: boolean;
}): Promise<boolean> {
  if (input.isInitialBackgroundBlurEnabled === undefined && input.activeSession.user.source !== "guest") {
    return fetchLiveMeetingJoinBackgroundBlurPreference(input.activeSession.token);
  }

  return input.isInitialBackgroundBlurEnabled ?? input.isBackgroundBlurEnabled;
}

function voidReportLiveMeetingJoinStartedDiagnostic(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  meeting: Meeting;
  joinStartedDiagnostic: MeetingClientDiagnostic;
  refreshJoinAuthAfterUnauthorized: (error: unknown) => Promise<AuthSession | null>;
}) {
  void (async () => {
    try {
      try {
        await reportMeetingClientDiagnostic({
          token: input.joinConnect.snapshot.auth.token,
          meetingId: input.meeting.id,
          input: input.joinStartedDiagnostic,
        });
      } catch (diagnosticError) {
        const nextSession = await input.refreshJoinAuthAfterUnauthorized(diagnosticError);
        if (nextSession) {
          await reportMeetingClientDiagnostic({
            token: nextSession.token,
            meetingId: input.meeting.id,
            input: input.joinStartedDiagnostic,
          });
        }
      }
    } catch (error) {
      void describeCaughtFailure(error);
    }
  })();
}

async function handleLiveMeetingJoinConnectFailure(input: {
  nextError: unknown;
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  meeting: Meeting;
  joinStartedAt: number;
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  acquiredJoinTracks: { tracks: JoinMeetingMediaTrack[] };
  stopJoinTrack: (track: JoinMeetingMediaTrack) => void;
  didConnect: {
    /** @external ref wire */
    current: boolean;
  };
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setHasJoinedMeeting: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
}): Promise<void> {
  const {
    nextError,
    joinConnect,
    meeting,
    joinStartedAt,
    isInitialMicEnabled,
    isInitialCameraEnabled,
    acquiredJoinTracks,
    stopJoinTrack,
    didConnect,
    setRoom,
    setHasJoinedMeeting,
    setError,
  } = input;
  sendMeetingClientDiagnostic({
    token: joinConnect.snapshot.auth.token,
    meetingId: meeting.id,
    diagnostic: {
      event: "join-failed",
      phase: joinConnect.snapshot.phase,
      outcome: "failed",
      microphoneRequested: isInitialMicEnabled,
      cameraRequested: isInitialCameraEnabled,
      microphonePermission: joinConnect.snapshot.microphonePermission,
      cameraPermission: joinConnect.snapshot.cameraPermission,
      durationMs: Math.round(performance.now() - joinStartedAt),
      ...getClientDiagnosticError(nextError),
    },
  });
  acquiredJoinTracks.tracks.forEach((track) => {
    stopJoinTrack(track);
  });
  if (joinConnect.snapshot.room !== null) {
    await disconnectAndStopRoomMedia(joinConnect.snapshot.room);
  }
  didConnect.current = false;
  setRoom(null);
  setHasJoinedMeeting(false);
  setError(getErrorMessage({ error: nextError, fallback: LIVE_MEETING_PAGE_COPY.joinLiveMeetingFailed }));
}

function buildLiveMeetingJoinPublishMediaWarnings(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  meeting: Meeting;
  media: { audioError: Error | null };
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  isLiveMicrophoneEnabled: boolean;
  microphonePublish: { publishFailure: Error | null };
  cameraPublish: { publishFailure: Error | null };
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
}) {
  const microphoneError = input.microphonePublish.publishFailure ?? input.media.audioError;

  return buildLiveMeetingJoinMediaWarnings({
    joinConnect: input.joinConnect,
    isInitialMicEnabled: input.isInitialMicEnabled,
    isInitialCameraEnabled: input.isInitialCameraEnabled,
    isLiveMicrophoneEnabled: input.isLiveMicrophoneEnabled,
    microphoneError,
    microphonePublish: input.microphonePublish,
    cameraPublish: input.cameraPublish,
    audioDeviceId: input.audioDeviceId,
    videoDeviceId: input.videoDeviceId,
    meeting: input.meeting,
    setMicrophonePermissionState: input.setMicrophonePermissionState,
    setCameraPermissionState: input.setCameraPermissionState,
  });
}

async function applyLiveMeetingJoinBackgroundBlurAndMediaControls(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  joinedRoom: Room;
  isLiveMicrophoneEnabled: boolean;
  joinMediaWarnings: string[];
  backgroundBlurEnabledPromise: Promise<boolean>;
  setPublishedCameraBackgroundBlur: (input: { targetRoom: Room; isEnabled: boolean }) => Promise<void>;
  setIsBackgroundBlurEnabled: Dispatch<SetStateAction<boolean>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setMediaControlError: (message: string) => void;
}): Promise<void> {
  const {
    joinConnect,
    isLiveMicrophoneEnabled,
    joinMediaWarnings,
    backgroundBlurEnabledPromise,
    setIsBackgroundBlurEnabled,
    setIsMicEnabled,
    setIsCamEnabled,
    setCameraPermissionState,
    setMediaControlError,
  } = input;

  const shouldEnableBackgroundBlurAfterAwait = await backgroundBlurEnabledPromise;
  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: {
      shouldEnableBackgroundBlur: shouldEnableBackgroundBlurAfterAwait,
    },
  });
  setIsBackgroundBlurEnabled(joinConnect.snapshot.shouldEnableBackgroundBlur);
  setIsMicEnabled(getLocalMediaSourceEnabled({ room: input.joinedRoom, source: Track.Source.Microphone }));
  setIsCamEnabled(joinConnect.snapshot.isLiveCameraEnabled);
  if (joinConnect.snapshot.isLiveCameraEnabled) {
    joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
      snapshot: joinConnect.snapshot,
      patch: { cameraPermission: "granted" },
    });
    setCameraPermissionState("granted");
  }
  if (isLiveMicrophoneEnabled) {
    joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
      snapshot: joinConnect.snapshot,
      patch: { microphonePermission: "granted" },
    });
  }
  if (joinMediaWarnings.length !== 0) {
    setMediaControlError(Array.from(new Set(joinMediaWarnings)).join(" "));
  }
}

async function publishLiveMeetingJoinMediaTracksPhase(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  joinedRoom: Room;
  meeting: Meeting;
  media: {
    audioTracks: JoinMeetingMediaTrack[];
    videoTracks: JoinMeetingMediaTrack[];
    videoError: Error | null;
  };
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  stopJoinTrack: (track: JoinMeetingMediaTrack) => void;
  videoDeviceId: string | undefined;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
}): Promise<{
  microphonePublish: { isPublished: boolean; publishFailure: Error | null };
  cameraPublish: { isPublished: boolean; publishFailure: Error | null };
  isLiveMicrophoneEnabled: boolean;
}> {
  const {
    joinConnect,
    joinedRoom,
    meeting,
    media,
    isInitialMicEnabled,
    isInitialCameraEnabled,
    stopJoinTrack,
    videoDeviceId,
    setVideoDeviceId,
  } = input;

  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: { phase: "publish" },
  });
  const [microphonePublish, cameraPublish] = await Promise.all([
    publishJoinMeetingMediaTracks({
      joinedRoom,
      tracks: media.audioTracks,
      shouldPublish: isInitialMicEnabled,
      source: Track.Source.Microphone,
      stopJoinTrack,
    }),
    publishJoinMeetingMediaTracks({
      joinedRoom,
      tracks: media.videoTracks,
      shouldPublish: isInitialCameraEnabled,
      source: Track.Source.Camera,
      stopJoinTrack,
    }),
  ]);
  const isLiveMicrophoneEnabled = microphonePublish.isPublished;
  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: {
      isLiveCameraEnabled:
        cameraPublish.isPublished && getLocalMediaSourceEnabled({ room: joinedRoom, source: Track.Source.Camera }),
      cameraError: cameraPublish.publishFailure ?? media.videoError,
    },
  });

  await unpublishStaleLiveMeetingJoinCameraIfNeeded({
    joinConnect,
    joinedRoom,
    cameraPublish,
  });

  await recoverLiveMeetingJoinCameraPublication({
    joinConnect,
    isInitialCameraEnabled,
    joinedRoom,
    videoDeviceId,
    meeting,
    cameraPublish,
    setVideoDeviceId,
  });

  return { microphonePublish, cameraPublish, isLiveMicrophoneEnabled };
}

async function applyLiveMeetingJoinPublishUiAndReveal(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  joinedRoom: Room;
  meeting: Meeting;
  media: {
    audioTracks: JoinMeetingMediaTrack[];
    videoTracks: JoinMeetingMediaTrack[];
    audioError: Error | null;
  };
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  isLiveMicrophoneEnabled: boolean;
  microphonePublish: { isPublished: boolean; publishFailure: Error | null };
  cameraPublish: { isPublished: boolean; publishFailure: Error | null };
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  backgroundBlurEnabledPromise: Promise<boolean>;
  setPublishedCameraBackgroundBlur: (input: { targetRoom: Room; isEnabled: boolean }) => Promise<void>;
  setIsBackgroundBlurEnabled: Dispatch<SetStateAction<boolean>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setMediaControlError: (message: string) => void;
  joinStartedAt: number;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setIsBusy: Dispatch<SetStateAction<boolean>>;
}): Promise<void> {
  const joinMediaWarnings = buildLiveMeetingJoinPublishMediaWarnings({
    joinConnect: input.joinConnect,
    meeting: input.meeting,
    media: input.media,
    isInitialMicEnabled: input.isInitialMicEnabled,
    isInitialCameraEnabled: input.isInitialCameraEnabled,
    isLiveMicrophoneEnabled: input.isLiveMicrophoneEnabled,
    microphonePublish: input.microphonePublish,
    cameraPublish: input.cameraPublish,
    audioDeviceId: input.audioDeviceId,
    videoDeviceId: input.videoDeviceId,
    setMicrophonePermissionState: input.setMicrophonePermissionState,
    setCameraPermissionState: input.setCameraPermissionState,
  });
  await applyLiveMeetingJoinBackgroundBlurAndMediaControls({
    joinConnect: input.joinConnect,
    joinedRoom: input.joinedRoom,
    isLiveMicrophoneEnabled: input.isLiveMicrophoneEnabled,
    joinMediaWarnings,
    backgroundBlurEnabledPromise: input.backgroundBlurEnabledPromise,
    setPublishedCameraBackgroundBlur: input.setPublishedCameraBackgroundBlur,
    setIsBackgroundBlurEnabled: input.setIsBackgroundBlurEnabled,
    setIsMicEnabled: input.setIsMicEnabled,
    setIsCamEnabled: input.setIsCamEnabled,
    setCameraPermissionState: input.setCameraPermissionState,
    setMediaControlError: input.setMediaControlError,
  });

  sendLiveMeetingJoinMediaResultDiagnostic({
    joinConnect: input.joinConnect,
    meeting: input.meeting,
    media: input.media,
    isInitialMicEnabled: input.isInitialMicEnabled,
    isInitialCameraEnabled: input.isInitialCameraEnabled,
    isLiveMicrophoneEnabled: input.isLiveMicrophoneEnabled,
    microphonePublish: input.microphonePublish,
    cameraPublish: input.cameraPublish,
    joinStartedAt: input.joinStartedAt,
  });

  revealLiveMeetingRoomAfterJoin({
    joinedRoom: input.joinedRoom,
    meeting: input.meeting,
    setRoom: input.setRoom,
    setTracks: input.setTracks,
    setIsBusy: input.setIsBusy,
  });
}

function sendLiveMeetingJoinMediaResultDiagnostic(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  meeting: Meeting;
  media: {
    audioTracks: JoinMeetingMediaTrack[];
    videoTracks: JoinMeetingMediaTrack[];
  };
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  isLiveMicrophoneEnabled: boolean;
  microphonePublish: { isPublished: boolean };
  cameraPublish: { isPublished: boolean };
  joinStartedAt: number;
}) {
  sendMeetingClientDiagnostic({
    token: input.joinConnect.snapshot.auth.token,
    meetingId: input.meeting.id,
    diagnostic: {
      event: "join-media-result",
      phase: "publish",
      outcome:
        (input.isInitialMicEnabled && !input.isLiveMicrophoneEnabled) ||
        (input.isInitialCameraEnabled && !input.joinConnect.snapshot.isLiveCameraEnabled)
          ? "degraded"
          : "succeeded",
      microphoneRequested: input.isInitialMicEnabled,
      cameraRequested: input.isInitialCameraEnabled,
      microphoneAcquired: input.media.audioTracks.length !== 0,
      cameraAcquired: input.media.videoTracks.length !== 0,
      microphonePublished: input.microphonePublish.isPublished,
      cameraPublished: input.cameraPublish.isPublished,
      microphoneEnabled: input.isLiveMicrophoneEnabled,
      cameraEnabled: input.joinConnect.snapshot.isLiveCameraEnabled,
      microphonePermission: input.joinConnect.snapshot.microphonePermission,
      cameraPermission: input.joinConnect.snapshot.cameraPermission,
      durationMs: Math.round(performance.now() - input.joinStartedAt),
    },
  });
}

function revealLiveMeetingRoomAfterJoin(input: {
  joinedRoom: Room;
  meeting: Meeting;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setIsBusy: Dispatch<SetStateAction<boolean>>;
}) {
  input.setRoom(input.joinedRoom);
  input.setTracks((current) => {
    const nextTracks = getTrackViews({ room: requireMeetingRoom(input.joinedRoom) });

    return areTrackViewsEqual({ previous: current, next: nextTracks }) ? current : nextTracks;
  });
  input.setIsBusy(false);
  window.localStorage.setItem(ACTIVE_MEETING_KEY, input.meeting.id);
}

async function runLiveMeetingJoinPublishAndRevealPhase(input: {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  joinedRoom: Room;
  meeting: Meeting;
  media: {
    audioTracks: JoinMeetingMediaTrack[];
    videoTracks: JoinMeetingMediaTrack[];
    audioError: Error | null;
    videoError: Error | null;
  };
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  stopJoinTrack: (track: JoinMeetingMediaTrack) => void;
  videoDeviceId: string | undefined;
  audioDeviceId: string | undefined;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  backgroundBlurEnabledPromise: Promise<boolean>;
  setPublishedCameraBackgroundBlur: (input: { targetRoom: Room; isEnabled: boolean }) => Promise<void>;
  setIsBackgroundBlurEnabled: Dispatch<SetStateAction<boolean>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setMediaControlError: (message: string) => void;
  joinStartedAt: number;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setIsBusy: Dispatch<SetStateAction<boolean>>;
}): Promise<void> {
  const publishResult = await publishLiveMeetingJoinMediaTracksPhase({
    joinConnect: input.joinConnect,
    joinedRoom: input.joinedRoom,
    meeting: input.meeting,
    media: input.media,
    isInitialMicEnabled: input.isInitialMicEnabled,
    isInitialCameraEnabled: input.isInitialCameraEnabled,
    stopJoinTrack: input.stopJoinTrack,
    videoDeviceId: input.videoDeviceId,
    setVideoDeviceId: input.setVideoDeviceId,
  });

  await applyLiveMeetingJoinPublishUiAndReveal({
    joinConnect: input.joinConnect,
    joinedRoom: input.joinedRoom,
    meeting: input.meeting,
    media: input.media,
    isInitialMicEnabled: input.isInitialMicEnabled,
    isInitialCameraEnabled: input.isInitialCameraEnabled,
    isLiveMicrophoneEnabled: publishResult.isLiveMicrophoneEnabled,
    microphonePublish: publishResult.microphonePublish,
    cameraPublish: publishResult.cameraPublish,
    audioDeviceId: input.audioDeviceId,
    videoDeviceId: input.videoDeviceId,
    setMicrophonePermissionState: input.setMicrophonePermissionState,
    setCameraPermissionState: input.setCameraPermissionState,
    backgroundBlurEnabledPromise: input.backgroundBlurEnabledPromise,
    setPublishedCameraBackgroundBlur: input.setPublishedCameraBackgroundBlur,
    setIsBackgroundBlurEnabled: input.setIsBackgroundBlurEnabled,
    setIsMicEnabled: input.setIsMicEnabled,
    setIsCamEnabled: input.setIsCamEnabled,
    setMediaControlError: input.setMediaControlError,
    joinStartedAt: input.joinStartedAt,
    setRoom: input.setRoom,
    setTracks: input.setTracks,
    setIsBusy: input.setIsBusy,
  });
}

type LiveMeetingJoinInRoomConnectionInput = LiveMeetingConnectEffectInput & {
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  runWithAuthRetry: ReturnType<typeof createLiveMeetingJoinConnectAuth>["runWithAuthRetry"];
};

async function createLiveMeetingJoinWiredRoom(input: LiveMeetingJoinInRoomConnectionInput): Promise<{
  joinedRoom: Room;
  syncAssistantPresenceFromParticipants: () => void;
}> {
  const createdRoom = await createMeetingRoom({
    audioDeviceId: input.audioDeviceId,
    videoDeviceId: input.videoDeviceId,
    reportMediaHealth: (...reportArgs) =>
      reportMeetingMediaHealthFromDiagnosticContext({
        getDiagnosticContext: () => input.clientDiagnosticContextRef.current,
        reports: reportArgs[0],
        options: reportArgs[1],
      }),
  });
  const { joinConnect } = input;
  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: { room: createdRoom },
  });
  const joinedRoom = createdRoom;
  const { syncAssistantPresenceFromParticipants } = wireLiveMeetingJoinRoomSessionHandlers({
    joinedRoom,
    joinConnect,
    setTracks: input.setTracks,
    setPresenceVersion: input.setPresenceVersion,
    applyAssistantPresencePayload: input.applyAssistantPresencePayload,
    owedVoiceStopRef: input.owedVoiceStopRef,
    voiceModeIntentRef: input.voiceModeIntentRef,
    isConversationModeActiveRef: input.isConversationModeActiveRef,
    voiceModeRpcPendingRef: input.voiceModeRpcPendingRef,
    setVoiceModePendingAction: input.setVoiceModePendingAction,
    setSyncedConversationModeActive: input.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: input.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: input.setSyncedAgentHelpPhase,
    updateDataPresentationClaims: input.updateDataPresentationClaims,
    showToast: input.showToast,
    setError: input.setError,
    showAgentHelpCreditsRequiredToast: input.showAgentHelpCreditsRequiredToast,
    setRealtimeTranscriptLines: input.setRealtimeTranscriptLines,
    setAssistantDisplayNamesByIdentity: input.setAssistantDisplayNamesByIdentity,
    setConnectionState: input.setConnectionState,
    clientDiagnosticContextRef: input.clientDiagnosticContextRef,
    remoteMeetingEndRef: input.remoteMeetingEndRef,
    videoDeviceId: input.videoDeviceId,
    audioDeviceId: input.audioDeviceId,
  });

  return { joinedRoom, syncAssistantPresenceFromParticipants };
}

async function connectLiveMeetingJoinRoomWithToken(input: {
  joinedRoom: Room;
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  tokenPayloadPromise: Promise<{ wsUrl: string; token: string }>;
  syncAssistantPresenceFromParticipants: () => void;
}): Promise<void> {
  const { joinedRoom, joinConnect, tokenPayloadPromise, syncAssistantPresenceFromParticipants } = input;

  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: { phase: "token" },
  });
  const tokenPayload = await tokenPayloadPromise;
  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: { phase: "connect" },
  });
  await joinedRoom.connect(tokenPayload.wsUrl, tokenPayload.token);
  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: { connectionPhase: "in-room" },
  });
  syncAssistantPresenceFromParticipants();
}

async function runLiveMeetingJoinInRoomConnectionPhase(input: LiveMeetingJoinInRoomConnectionInput): Promise<{
  joinedRoom: Room;
  media: {
    audioTracks: JoinMeetingMediaTrack[];
    videoTracks: JoinMeetingMediaTrack[];
    audioError: Error | null;
    videoError: Error | null;
  };
  backgroundBlurEnabledPromise: Promise<boolean>;
}> {
  const launchHandoff = takeMeetingLaunchHandoff(input.meeting.id);
  const hasInitialMediaTracks = (input.initialMediaTracks?.length ?? 0) > 0;
  const launchMediaPromise = hasInitialMediaTracks ? null : takeMeetingLaunchMedia();

  const mediaPromise = createLiveMeetingJoinMediaPromise({
    initialMediaTracks: input.initialMediaTracks ?? null,
    initialMediaErrors: input.initialMediaErrors ?? null,
    launchMediaPromise,
    audioDeviceId: input.audioDeviceId,
    videoDeviceId: input.videoDeviceId,
  });
  void (async () => {
    try {
      await mediaPromise;
    } catch (error) {
      void describeCaughtFailure(error);
    }
  })();

  const tokenPayloadPromise = launchHandoff
    ? Promise.resolve(launchHandoff.livekit)
    : input.runWithAuthRetry((nextSession) =>
        mintLiveKitToken({
          token: nextSession.token,
          meetingId: input.meeting.id,
          participantName: nextSession.user.displayName,
        }),
      );

  const backgroundBlurEnabledPromise = createLiveMeetingJoinBackgroundBlurEnabledPromise({
    isInitialBackgroundBlurEnabled: input.isInitialBackgroundBlurEnabled,
    activeSession: input.activeSession,
    isBackgroundBlurEnabled: input.isBackgroundBlurEnabled,
  });

  // Prepare camera output while the network connection is being established.
  void (async () => {
    try {
      const [media, isEnabled] = await Promise.all([mediaPromise, backgroundBlurEnabledPromise]);
      if (!input.isInitialCameraEnabled) {
        return;
      }
      await Promise.all(
        media.videoTracks.map(async (track) => {
          if (track instanceof LocalVideoTrack && track.mediaStreamTrack.readyState !== "ended") {
            await setLocalVideoTrackBackgroundBlur({ track, isEnabled });
          }
        }),
      );
    } catch (error) {
      console.error("[readymeet] Camera preparation failed.", error);
    }
  })();
  const { joinedRoom, syncAssistantPresenceFromParticipants } = await createLiveMeetingJoinWiredRoom(input);
  setMeetingCameraBlurPreference(joinedRoom.localParticipant, backgroundBlurEnabledPromise);
  const { joinConnect } = input;

  const releasePreparedMedia = () => {
    void (async () => {
      try {
        const media = await mediaPromise;
        [...media.videoTracks, ...media.audioTracks].forEach((track) => {
          track.stop();
        });
      } catch (error) {
        void describeCaughtFailure(error);
      }
    })();
  };
  joinedRoom.once(RoomEvent.Disconnected, releasePreparedMedia);
  try {
    await connectLiveMeetingJoinRoomWithToken({
      joinedRoom,
      joinConnect,
      tokenPayloadPromise,
      syncAssistantPresenceFromParticipants,
    });
  } catch (error) {
    releasePreparedMedia();
    throw error;
  }

  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: { phase: "acquire" },
  });
  input.setRoom(joinedRoom);
  input.setTracks(getTrackViews({ room: requireMeetingRoom(joinedRoom) }));
  const media = await mediaPromise;

  return { joinedRoom, media, backgroundBlurEnabledPromise };
}

async function runLiveMeetingJoinBookkeepingAfterReveal(input: {
  meeting: Meeting;
  joinedRoom: Room;
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  joinStartedAt: number;
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  endMeetingStartedRef: LiveMeetingConnectEffectInput["endMeetingStartedRef"];
  joinBookkeepingRequestRef: LiveMeetingConnectEffectInput["joinBookkeepingRequestRef"];
  runWithAuthRetry: ReturnType<typeof createLiveMeetingJoinConnectAuth>["runWithAuthRetry"];
  refreshRealtimeAuth: LiveMeetingConnectEffectInput["refreshRealtimeAuth"];
  setJoinedWorkspaceToSync: LiveMeetingConnectEffectInput["setJoinedWorkspaceToSync"];
  setMeeting: LiveMeetingConnectEffectInput["setMeeting"];
  setActiveHumanParticipants: LiveMeetingConnectEffectInput["setActiveHumanParticipants"];
  setLiveTranscriptSegments: LiveMeetingConnectEffectInput["setLiveTranscriptSegments"];
  setHasJoinedMeeting: LiveMeetingConnectEffectInput["setHasJoinedMeeting"];
}): Promise<void> {
  const { joinConnect, joinedRoom } = input;

  joinConnect.snapshot = mergeLiveMeetingConnectSnapshot({
    snapshot: joinConnect.snapshot,
    patch: { phase: "bookkeeping" },
  });
  const isBookkeepingComplete = await runLiveMeetingJoinBookkeeping({
    meeting: input.meeting,
    joinConnect,
    joinStartedAt: input.joinStartedAt,
    endMeetingStartedRef: input.endMeetingStartedRef,
    joinBookkeepingRequestRef: input.joinBookkeepingRequestRef,
    runWithAuthRetry: input.runWithAuthRetry,
    refreshRealtimeAuth: input.refreshRealtimeAuth,
    setJoinedWorkspaceToSync: input.setJoinedWorkspaceToSync,
    setMeeting: input.setMeeting,
    setActiveHumanParticipants: input.setActiveHumanParticipants,
    setLiveTranscriptSegments: input.setLiveTranscriptSegments,
    setHasJoinedMeeting: input.setHasJoinedMeeting,
  });
  if (!isBookkeepingComplete) {
    return;
  }

  const isLiveMicrophoneEnabled = getLocalMediaSourceEnabled({ room: joinedRoom, source: Track.Source.Microphone });
  sendMeetingClientDiagnostic({
    token: joinConnect.snapshot.auth.token,
    meetingId: input.meeting.id,
    diagnostic: {
      event: "join-succeeded",
      phase: "bookkeeping",
      outcome:
        (input.isInitialMicEnabled && !isLiveMicrophoneEnabled) ||
        (input.isInitialCameraEnabled && !joinConnect.snapshot.isLiveCameraEnabled)
          ? "degraded"
          : "succeeded",
      microphoneRequested: input.isInitialMicEnabled,
      cameraRequested: input.isInitialCameraEnabled,
      microphoneEnabled: isLiveMicrophoneEnabled,
      cameraEnabled: joinConnect.snapshot.isLiveCameraEnabled,
      connectionState: joinedRoom.state,
      durationMs: Math.round(performance.now() - input.joinStartedAt),
    },
  });
}

async function runLiveMeetingJoinConnectSuccessPath(input: {
  connectInput: LiveMeetingConnectEffectInput;
  joinConnect: { snapshot: LiveMeetingInitialConnectSnapshot };
  runWithAuthRetry: ReturnType<typeof createLiveMeetingJoinConnectAuth>["runWithAuthRetry"];
  acquiredJoinTracks: { tracks: JoinMeetingMediaTrack[] };
  joinStartedAt: number;
  stopJoinTrack: (track: JoinMeetingMediaTrack) => void;
}): Promise<void> {
  const { acquiredJoinTracks, connectInput, joinConnect, runWithAuthRetry, stopJoinTrack, joinStartedAt } = input;
  const { joinedRoom, media, backgroundBlurEnabledPromise } = await runLiveMeetingJoinInRoomConnectionPhase({
    ...connectInput,
    joinConnect,
    runWithAuthRetry,
  });
  acquiredJoinTracks.tracks = [...acquiredJoinTracks.tracks, ...media.audioTracks, ...media.videoTracks];

  await runLiveMeetingJoinPublishAndRevealPhase({
    joinConnect,
    joinedRoom,
    meeting: connectInput.meeting,
    media,
    isInitialMicEnabled: connectInput.isInitialMicEnabled,
    isInitialCameraEnabled: connectInput.isInitialCameraEnabled,
    stopJoinTrack,
    videoDeviceId: connectInput.videoDeviceId,
    audioDeviceId: connectInput.audioDeviceId,
    setVideoDeviceId: connectInput.setVideoDeviceId,
    setMicrophonePermissionState: connectInput.setMicrophonePermissionState,
    setCameraPermissionState: connectInput.setCameraPermissionState,
    backgroundBlurEnabledPromise,
    setPublishedCameraBackgroundBlur: connectInput.setPublishedCameraBackgroundBlur,
    setIsBackgroundBlurEnabled: connectInput.setIsBackgroundBlurEnabled,
    setIsMicEnabled: connectInput.setIsMicEnabled,
    setIsCamEnabled: connectInput.setIsCamEnabled,
    setMediaControlError: connectInput.setMediaControlError,
    joinStartedAt,
    setRoom: connectInput.setRoom,
    setTracks: connectInput.setTracks,
    setIsBusy: connectInput.setIsBusy,
  });

  await runLiveMeetingJoinBookkeepingAfterReveal({
    meeting: connectInput.meeting,
    joinedRoom,
    joinConnect,
    joinStartedAt,
    isInitialMicEnabled: connectInput.isInitialMicEnabled,
    isInitialCameraEnabled: connectInput.isInitialCameraEnabled,
    endMeetingStartedRef: connectInput.endMeetingStartedRef,
    joinBookkeepingRequestRef: connectInput.joinBookkeepingRequestRef,
    runWithAuthRetry,
    refreshRealtimeAuth: connectInput.refreshRealtimeAuth,
    setJoinedWorkspaceToSync: connectInput.setJoinedWorkspaceToSync,
    setMeeting: connectInput.setMeeting,
    setActiveHumanParticipants: connectInput.setActiveHumanParticipants,
    setLiveTranscriptSegments: connectInput.setLiveTranscriptSegments,
    setHasJoinedMeeting: connectInput.setHasJoinedMeeting,
  });
}

async function runLiveMeetingConnectEffect(input: LiveMeetingConnectEffectInput): Promise<void> {
  const { joinConnect, refreshJoinAuthAfterUnauthorized, runWithAuthRetry } = createLiveMeetingJoinConnectAuth({
    activeSession: input.activeSession,
    meeting: input.meeting,
    microphonePermissionStateRef: input.microphonePermissionStateRef,
    cameraPermissionStateRef: input.cameraPermissionStateRef,
    clientDiagnosticContextRef: input.clientDiagnosticContextRef,
    refreshAuthAfterUnauthorized: input.refreshAuthAfterUnauthorized,
  });

  const stopJoinTrack = (track: JoinMeetingMediaTrack) => {
    try {
      track.stop();
    } catch (error) {
      void describeCaughtFailure(error);
      // best-effort device release
    }
  };
  const acquiredJoinTracks: { tracks: JoinMeetingMediaTrack[] } = { tracks: [] };
  const joinStartedAt = performance.now();

  const joinStartedDiagnostic: MeetingClientDiagnostic = {
    event: "join-started",
    phase: "token",
    outcome: "started",
    microphoneRequested: input.isInitialMicEnabled,
    cameraRequested: input.isInitialCameraEnabled,
    microphonePermission: joinConnect.snapshot.microphonePermission,
    cameraPermission: joinConnect.snapshot.cameraPermission,
    selectedDevice: hasAnyConfiguredMediaDeviceId({
      audioDeviceId: input.audioDeviceId,
      videoDeviceId: input.videoDeviceId,
    }),
  };
  voidReportLiveMeetingJoinStartedDiagnostic({
    joinConnect,
    meeting: input.meeting,
    joinStartedDiagnostic,
    refreshJoinAuthAfterUnauthorized,
  });

  input.setIsBusy(true);
  input.setError(null);
  try {
    await runLiveMeetingJoinConnectSuccessPath({
      connectInput: input,
      joinConnect,
      runWithAuthRetry,
      acquiredJoinTracks,
      joinStartedAt,
      stopJoinTrack,
    });
  } catch (nextError) {
    await handleLiveMeetingJoinConnectFailure({
      nextError,
      joinConnect,
      meeting: input.meeting,
      joinStartedAt,
      isInitialMicEnabled: input.isInitialMicEnabled,
      isInitialCameraEnabled: input.isInitialCameraEnabled,
      acquiredJoinTracks,
      stopJoinTrack,
      didConnect: input.didConnect,
      setRoom: input.setRoom,
      setHasJoinedMeeting: input.setHasJoinedMeeting,
      setError: input.setError,
    });
  } finally {
    input.setIsBusy(false);
  }
}

async function fetchLiveMeetingRemoteEndMeetingDetail(input: { token: string; meetingId: string }) {
  try {
    return await getMeeting({
      token: input.token,
      meetingId: input.meetingId,
      options: {
        signal: AbortSignal.timeout(END_MEETING_REQUEST_TIMEOUT_MS),
      },
    });
  } catch (meetingError) {
    void describeCaughtFailure(meetingError);

    return null;
  }
}

async function completeLiveMeetingEndMeetingDepartureAfterResponse(input: {
  endResponse: LiveMeetingDepartureResponse;
  endedDetail: MeetingDetailPayload | null | undefined;
  exitState: { session: AuthSession };
  disconnectPromise: Promise<void>;
  flowStartedAt: number;
  targetMeetingId: string;
  isGuestSession: boolean;
  activeSession: AuthSession;
  setEndMeetingFlow: Dispatch<SetStateAction<EndMeetingFlowState | null>>;
  commitWorkspaceTransition: () => Promise<void>;
  setIsEndMeetingOverlayExiting: Dispatch<SetStateAction<boolean>>;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
}): Promise<void> {
  // Do not copy the ended meeting detail into durable browser storage; the workspace re-fetches it.
  void input.endedDetail;
  await input.disconnectPromise;

  input.setEndMeetingFlow((current) =>
    current
      ? {
          ...current,
          phase: input.endResponse.finalized ? "finalizing_transcript" : "waiting_for_idle",
        }
      : current,
  );

  const remainingVisibleMs = getEndMeetingPreparationWaitMs({ startedAt: input.flowStartedAt, now: Date.now() });
  const preparationDeckPromise =
    input.endResponse.finalized && remainingVisibleMs > 0
      ? waitForModelMeetingPreparationDeck({
          load: (signal) =>
            getMeetingPreparationPreview({
              token: input.exitState.session.token,
              meetingId: input.targetMeetingId,
              options: { signal },
            }),
          timeoutMs: remainingVisibleMs,
        })
      : Promise.resolve(null);
  const [preparationDeck] = await Promise.all([
    preparationDeckPromise,
    remainingVisibleMs > 0 ? delay(remainingVisibleMs) : Promise.resolve(),
  ]);
  if (preparationDeck !== null) {
    try {
      writeModelMeetingPreparationHandoff(input.targetMeetingId, preparationDeck, input.activeSession.user.id);
    } catch (error) {
      void describeCaughtFailure(error);
      // best-effort contextual copy handoff; the workspace can fetch it again
    }
  }

  input.setEndMeetingFlow((current) =>
    current
      ? {
          ...current,
          phase: "routing",
        }
      : current,
  );

  await delay(END_MEETING_ROUTING_DELAY_MS);

  if (!input.isGuestSession && input.endResponse.postMeetingDisposition?.status === "skipped") {
    input.showToast({
      id: `post-meeting-skipped:${input.targetMeetingId}:${input.endResponse.postMeetingDisposition.reason}`,
      title: LIVE_MEETING_PAGE_COPY.postMeetingSkippedTitle,
      message: input.endResponse.postMeetingDisposition.message,
    });
    input.setIsEndMeetingOverlayExiting(true);
    await delay(END_MEETING_OVERLAY_EXIT_MS);
    input.router.push(input.endResponse.postMeetingDisposition.redirectTo);

    return;
  }

  await input.commitWorkspaceTransition();
}

type LiveMeetingDepartureResponse = Pick<
  Awaited<ReturnType<typeof endMeeting>>,
  "finalized" | "postMeetingDisposition"
>;

function voidReconcileLiveMeetingDepartureJoinBookkeeping(input: {
  joinBookkeepingRequestRef: { current: Promise<unknown> | null };
  departure: Promise<LiveMeetingDepartureResponse>;
  leaveIfDisconnected: () => Promise<Awaited<ReturnType<typeof endMeeting>>>;
}) {
  void (async () => {
    try {
      await reconcilePendingMeetingJoin({
        pendingJoin: input.joinBookkeepingRequestRef.current,
        departure: input.departure,
        leaveIfDisconnected: input.leaveIfDisconnected,
        onLateFailure: () => {
          console.error(LIVE_MEETING_PAGE_COPY.reconcileDepartureLateJoinLog);
        },
      });
    } catch (reconcileError) {
      void describeCaughtFailure(reconcileError);
      console.error(LIVE_MEETING_PAGE_COPY.reconcileDeparturePendingJoinLog);
    }
  })();
}

async function handleLiveMeetingEndMeetingDepartureFailure(input: {
  error: unknown;
  exitState: { isDepartureConfirmed: boolean };
  action: EndMeetingAction;
  targetMeetingId: string;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setEndMeetingFlow: Dispatch<SetStateAction<EndMeetingFlowState | null>>;
  showToast: ReturnType<typeof useToast>["showToast"];
  commitWorkspaceTransition: () => Promise<void>;
}): Promise<void> {
  void describeCaughtFailure(input.error);
  input.setRoom(null);
  input.setTracks([]);
  input.setEndMeetingFlow((current) => (current ? { ...current, phase: "routing" } : current));
  if (!input.exitState.isDepartureConfirmed) {
    input.showToast({
      id: `meeting-exit:${input.targetMeetingId}`,
      title:
        input.action === "end_for_all"
          ? LIVE_MEETING_PAGE_COPY.meetingExitEndForAllTitle
          : LIVE_MEETING_PAGE_COPY.meetingExitLeaveTitle,
      message:
        input.action === "end_for_all"
          ? LIVE_MEETING_PAGE_COPY.meetingExitEndForAllMessage
          : LIVE_MEETING_PAGE_COPY.meetingExitLeaveMessage,
    });
  }
  await input.commitWorkspaceTransition();
}

async function prepareLiveMeetingEndMeetingDeparture(input: {
  remoteEnd: MeetingDetailPayload | true | undefined;
  activeSession: AuthSession;
  targetMeetingId: string;
  action: EndMeetingAction;
  endMeetingWithAuthRetry: (exitAction: EndMeetingAction) => Promise<Awaited<ReturnType<typeof endMeeting>>>;
}): Promise<{
  endedDetail: MeetingDetailPayload | null | undefined;
  departure: Promise<LiveMeetingDepartureResponse>;
}> {
  const endedDetail =
    input.remoteEnd === true
      ? await fetchLiveMeetingRemoteEndMeetingDetail({
          token: input.activeSession.token,
          meetingId: input.targetMeetingId,
        })
      : input.remoteEnd;
  const departure =
    input.remoteEnd === true || typeof input.remoteEnd === "object"
      ? Promise.resolve({
          /** @external meeting departure wire field */
          finalized: true,
          postMeetingDisposition: endedDetail?.postMeetingDisposition ?? null,
        })
      : input.endMeetingWithAuthRetry(input.action);

  return { endedDetail, departure };
}

async function runLiveMeetingEndMeetingDeparture(input: {
  action: EndMeetingAction;
  remoteEnd: MeetingDetailPayload | true | undefined;
  activeSession: AuthSession;
  targetMeetingId: string;
  flowStartedAt: number;
  isGuestSession: boolean;
  disconnectPromise: Promise<void>;
  joinBookkeepingRequestRef: { current: Promise<unknown> | null };
  refreshSession: () => Promise<AuthSession | null>;
  commitWorkspaceTransition: () => Promise<void>;
  setEndMeetingFlow: Dispatch<SetStateAction<EndMeetingFlowState | null>>;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setIsEndMeetingOverlayExiting: Dispatch<SetStateAction<boolean>>;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
}): Promise<void> {
  const exitState = { session: input.activeSession, isDepartureConfirmed: false };
  const sendEndMeeting = (request: { token: string; exitAction: EndMeetingAction }) =>
    endMeeting({
      token: request.token,
      meetingId: input.targetMeetingId,
      action: request.exitAction,
      options: { signal: AbortSignal.timeout(END_MEETING_REQUEST_TIMEOUT_MS) },
    });
  const endMeetingWithAuthRetry = async (exitAction: EndMeetingAction) => {
    try {
      return await sendEndMeeting({ token: exitState.session.token, exitAction });
    } catch (nextError) {
      if (!(nextError instanceof ApiError) || nextError.status !== HTTP_STATUS_UNAUTHORIZED) {
        throw nextError;
      }
      // An expired token must not silently drop the leave or end-for-all:
      // refresh once, bounded like the request itself, and retry.
      const nextSession = await Promise.race([
        (async () => {
          try {
            return await input.refreshSession();
          } catch (refreshError) {
            void describeCaughtFailure(refreshError);

            return null;
          }
        })(),
        (async () => {
          await delay(END_MEETING_REQUEST_TIMEOUT_MS);

          return null;
        })(),
      ]);
      if (!nextSession || nextSession.token === exitState.session.token) {
        throw nextError;
      }
      exitState.session = nextSession;

      return sendEndMeeting({ token: nextSession.token, exitAction });
    }
  };

  try {
    const { endedDetail, departure } = await prepareLiveMeetingEndMeetingDeparture({
      remoteEnd: input.remoteEnd,
      activeSession: input.activeSession,
      targetMeetingId: input.targetMeetingId,
      action: input.action,
      endMeetingWithAuthRetry,
    });
    voidReconcileLiveMeetingDepartureJoinBookkeeping({
      joinBookkeepingRequestRef: input.joinBookkeepingRequestRef,
      departure,
      leaveIfDisconnected: () => endMeetingWithAuthRetry("leave"),
    });
    const endResponse = await departure;
    exitState.isDepartureConfirmed = true;
    await completeLiveMeetingEndMeetingDepartureAfterResponse({
      endResponse,
      endedDetail,
      exitState,
      disconnectPromise: input.disconnectPromise,
      flowStartedAt: input.flowStartedAt,
      targetMeetingId: input.targetMeetingId,
      isGuestSession: input.isGuestSession,
      activeSession: input.activeSession,
      setEndMeetingFlow: input.setEndMeetingFlow,
      commitWorkspaceTransition: input.commitWorkspaceTransition,
      setIsEndMeetingOverlayExiting: input.setIsEndMeetingOverlayExiting,
      router: input.router,
      showToast: input.showToast,
    });
  } catch (error) {
    await handleLiveMeetingEndMeetingDepartureFailure({
      error,
      exitState,
      action: input.action,
      targetMeetingId: input.targetMeetingId,
      setRoom: input.setRoom,
      setTracks: input.setTracks,
      setEndMeetingFlow: input.setEndMeetingFlow,
      showToast: input.showToast,
      commitWorkspaceTransition: input.commitWorkspaceTransition,
    });
  }
}

type LiveMeetingSpeechMeterInput = {
  room: Room;
  isMicEnabled: boolean;
  assistantSpeechLevelRef: { current: number };
  speechLevelRef: { current: number };
  speechIndicatorStatesRef: { current: Record<string, SpeechIndicatorState> };
  participantSpeechStore: ReturnType<typeof createParticipantSpeechStore>;
  setIsCaptionSpeechActive: Dispatch<SetStateAction<boolean>>;
  setIsAssistantParticipantSpeaking: Dispatch<SetStateAction<boolean>>;
};

type LiveMeetingLocalMicMonitor = {
  stop: () => void;
  start: () => void;
  readLevel: () => number;
};

function createLiveMeetingLocalMicMonitor(input: { room: Room; isMicEnabled: boolean }): LiveMeetingLocalMicMonitor {
  const mic: {
    context: AudioContext | null;
    source: MediaStreamAudioSourceNode | null;
    analyser: AnalyserNode | null;
    samples: Uint8Array<ArrayBuffer> | null;
  } = { context: null, source: null, analyser: null, samples: null };

  const stop = () => {
    mic.source?.disconnect();
    mic.source = null;
    mic.analyser = null;
    mic.samples = null;

    const context = mic.context;
    if (context) {
      const closing = context.close();
      mic.context = null;
      void (async () => {
        try {
          await closing;
        } catch (error) {
          void describeCaughtFailure(error);
        }
      })();
    }
  };

  const start = () => {
    stop();

    if (!input.isMicEnabled || document.hidden) {
      return;
    }

    const publication = input.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const mediaStreamTrack = publication?.track?.mediaStreamTrack;
    if (
      publication === undefined ||
      mediaStreamTrack === undefined ||
      mediaStreamTrack.readyState !== "live" ||
      publication.isMuted ||
      !mediaStreamTrack.enabled
    ) {
      return;
    }

    const AudioContextConstructor = getWindowAudioContextConstructor();
    if (AudioContextConstructor === undefined) {
      return;
    }

    try {
      const context = new AudioContextConstructor();
      const analyser = context.createAnalyser();
      analyser.fftSize = LOCAL_MIC_ANALYSER_FFT_SIZE;
      const samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      const source = context.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
      source.connect(analyser);
      mic.context = context;
      mic.analyser = analyser;
      mic.samples = samples;
      mic.source = source;

      if (context.state === "suspended") {
        const resuming = context.resume();
        void (async () => {
          try {
            await resuming;
          } catch (error) {
            void describeCaughtFailure(error);
          }
        })();
      }
    } catch (error) {
      void describeCaughtFailure(error);
      stop();
    }
  };

  const readLevel = () => {
    const analyser = mic.analyser;
    const samples = mic.samples;
    if (!analyser || !samples) {
      return 0;
    }

    analyser.getByteTimeDomainData(samples);
    const sumSquares = samples.reduce((sum, sample) => {
      const centered = (sample - AUDIO_WAVE_CENTER_OFFSET) / AUDIO_WAVE_NORMALIZER;

      return sum + centered * centered;
    }, 0);

    const rms = Math.sqrt(sumSquares / samples.length);

    return Math.min(1, rms * LOCAL_MIC_RMS_AMPLIFIER);
  };

  return { stop, start, readLevel };
}

function updateLiveMeetingParticipantSpeechLevels(input: {
  room: Room;
  participantSpeechStore: ReturnType<typeof createParticipantSpeechStore>;
  speechIndicatorStatesRef: { current: Record<string, SpeechIndicatorState> };
  activeSpeakerIdentities: Set<string>;
  localMicLevel: number;
  speechTickNow: number;
}): void {
  const {
    room,
    participantSpeechStore,
    speechIndicatorStatesRef,
    activeSpeakerIdentities,
    localMicLevel,
    speechTickNow,
  } = input;
  participantSpeechStore.update((current) => {
    const next: ParticipantSpeechStateMap = {};

    const addParticipantSpeechState = (participantInput: { participant: Participant; fallbackLevel?: number }) => {
      const { participant, fallbackLevel = 0 } = participantInput;
      if (isMeetingAgentParticipant(participant)) {
        return;
      }

      const participantLevel = typeof participant.audioLevel === "number" ? participant.audioLevel : 0;
      const directLevel = Math.max(participantLevel, fallbackLevel);
      const previousLevel = current[participant.identity]?.level ?? 0;
      const smoothedLevel =
        directLevel > previousLevel
          ? previousLevel * SPEECH_LEVEL_SMOOTHING_ATTACK + directLevel * SPEECH_LEVEL_SMOOTHING_ATTACK_INVERSE
          : previousLevel * SPEECH_LEVEL_SMOOTHING_DECAY + directLevel * SPEECH_LEVEL_SMOOTHING_DECAY_INVERSE;
      const level = smoothedLevel < SPEECH_LEVEL_SILENCE_THRESHOLD ? 0 : Math.min(1, smoothedLevel);
      const isLocalParticipant = participant.identity === room.localParticipant.identity;
      const isRawSpeaking =
        participant.isSpeaking ||
        activeSpeakerIdentities.has(participant.identity) ||
        (isLocalParticipant && fallbackLevel > LOCAL_AVATAR_SPEECH_ACTIVE_LEVEL);
      const indicatorState = updateSpeechIndicator({
        state: speechIndicatorStatesRef.current[participant.identity] ?? createSpeechIndicatorState(),
        rawSpeaking: isRawSpeaking,
        now: speechTickNow,
      });
      speechIndicatorStatesRef.current[participant.identity] = indicatorState;

      next[participant.identity] = { level, isSpeaking: indicatorState.visible };
    };

    addParticipantSpeechState({ participant: room.localParticipant, fallbackLevel: localMicLevel });
    Array.from(room.remoteParticipants.values()).forEach((participant) => {
      addParticipantSpeechState({ participant });
    });

    Object.keys(speechIndicatorStatesRef.current).forEach((identity) => {
      if (!(identity in next)) {
        delete speechIndicatorStatesRef.current[identity];
      }
    });

    const currentKeys = Object.keys(current);
    const nextKeys = Object.keys(next);
    if (currentKeys.length !== nextKeys.length) {
      return next;
    }

    const isSpeechUnchanged = nextKeys.every((key) => {
      const currentState = current[key];
      const nextState = next[key];

      return (
        currentState !== undefined &&
        nextState !== undefined &&
        Math.abs(currentState.level - nextState.level) <= SPEECH_LEVEL_COMPARE_EPSILON &&
        currentState.isSpeaking === nextState.isSpeaking
      );
    });

    return isSpeechUnchanged ? current : next;
  });
}

function runLiveMeetingSpeechMeterTick(input: LiveMeetingSpeechMeterInput & { readLocalMicLevel: () => number }): void {
  const {
    room,
    assistantSpeechLevelRef,
    speechLevelRef,
    setIsAssistantParticipantSpeaking,
    setIsCaptionSpeechActive,
    readLocalMicLevel,
  } = input;
  const activeSpeakers = room.activeSpeakers;
  const activeSpeakerIdentities = new Set(activeSpeakers.map((participant) => participant.identity));
  const activeSpeakerLevel = activeSpeakers.reduce((highest, participant) => {
    const nextLevel = typeof participant.audioLevel === "number" ? participant.audioLevel : 0;

    return Math.max(highest, nextLevel);
  }, 0);
  const localMicLevel = readLocalMicLevel();
  const rawLevel = Math.max(activeSpeakerLevel, localMicLevel);
  const speechTickNow = Date.now();

  updateLiveMeetingParticipantSpeechLevels({
    room,
    participantSpeechStore: input.participantSpeechStore,
    speechIndicatorStatesRef: input.speechIndicatorStatesRef,
    activeSpeakerIdentities,
    localMicLevel,
    speechTickNow,
  });

  const assistantSpeech = Array.from(room.remoteParticipants.values())
    .filter(isMeetingAgentParticipant)
    .reduce(
      (state, participant) => {
        const isParticipantActive = participant.isSpeaking || room.activeSpeakers.includes(participant);

        return {
          isSpeaking: state.isSpeaking || isParticipantActive,
          level:
            isParticipantActive && Number.isFinite(participant.audioLevel)
              ? Math.max(state.level, participant.audioLevel)
              : state.level,
        };
      },
      { isSpeaking: false, level: 0 },
    );
  assistantSpeechLevelRef.current = Math.min(1, assistantSpeech.level);
  setIsAssistantParticipantSpeaking(assistantSpeech.isSpeaking);

  const currentLevel = speechLevelRef.current;
  const smoothedLevel =
    rawLevel > currentLevel
      ? currentLevel * CAPTION_SPEECH_SMOOTH_ATTACK + rawLevel * CAPTION_SPEECH_SMOOTH_ATTACK_INVERSE
      : currentLevel * CAPTION_SPEECH_SMOOTH_DECAY + rawLevel * CAPTION_SPEECH_SMOOTH_DECAY_INVERSE;
  speechLevelRef.current = smoothedLevel < SPEECH_LEVEL_SILENCE_THRESHOLD ? 0 : smoothedLevel;
  setIsCaptionSpeechActive(speechLevelRef.current > LOCAL_AVATAR_SPEECH_ACTIVE_LEVEL);
}

function attachLiveMeetingSpeechMeter(input: LiveMeetingSpeechMeterInput): () => void {
  const {
    room,
    isMicEnabled,
    assistantSpeechLevelRef,
    speechLevelRef,
    setIsCaptionSpeechActive,
    setIsAssistantParticipantSpeaking,
  } = input;

  const localMicMonitor = createLiveMeetingLocalMicMonitor({ room, isMicEnabled });
  const tick = () => runLiveMeetingSpeechMeterTick({ ...input, readLocalMicLevel: localMicMonitor.readLevel });
  const updateAssistantSpeech = () => {
    const assistantSpeech = Array.from(room.remoteParticipants.values())
      .filter(isMeetingAgentParticipant)
      .reduce(
        (state, participant) => {
          const isParticipantActive = participant.isSpeaking || room.activeSpeakers.includes(participant);

          return {
            isSpeaking: state.isSpeaking || isParticipantActive,
            level:
              isParticipantActive && Number.isFinite(participant.audioLevel)
                ? Math.max(state.level, participant.audioLevel)
                : state.level,
          };
        },
        { isSpeaking: false, level: 0 },
      );
    assistantSpeechLevelRef.current = Math.min(1, assistantSpeech.level);
    setIsAssistantParticipantSpeaking(assistantSpeech.isSpeaking);
  };

  const meter: { intervalId: number | undefined } = { intervalId: undefined };
  const syncVisibility = () => {
    window.clearInterval(meter.intervalId);
    meter.intervalId = undefined;
    if (document.hidden) {
      localMicMonitor.stop();
      speechLevelRef.current = 0;
      setIsCaptionSpeechActive(false);

      return;
    }
    localMicMonitor.start();
    tick();
    meter.intervalId = window.setInterval(tick, AVATAR_SPEECH_POLL_MS);
  };
  // Assistant speaking also drives voice-mode state, so keep those events
  // live while decorative metering is paused in a hidden tab.
  room.on(RoomEvent.ActiveSpeakersChanged, updateAssistantSpeech);
  document.addEventListener("visibilitychange", syncVisibility);
  syncVisibility();

  room.on(RoomEvent.LocalTrackPublished, localMicMonitor.start);
  room.on(RoomEvent.LocalTrackUnpublished, localMicMonitor.start);
  room.on(RoomEvent.TrackMuted, localMicMonitor.start);
  room.on(RoomEvent.TrackUnmuted, localMicMonitor.start);

  return () => {
    window.clearInterval(meter.intervalId);
    document.removeEventListener("visibilitychange", syncVisibility);
    room.off(RoomEvent.ActiveSpeakersChanged, updateAssistantSpeech);
    room.off(RoomEvent.LocalTrackPublished, localMicMonitor.start);
    room.off(RoomEvent.LocalTrackUnpublished, localMicMonitor.start);
    room.off(RoomEvent.TrackMuted, localMicMonitor.start);
    room.off(RoomEvent.TrackUnmuted, localMicMonitor.start);
    localMicMonitor.stop();
    assistantSpeechLevelRef.current = 0;
  };
}

function reportLiveMeetingCameraToggleFailure(input: {
  room: Room;
  videoDeviceId: string | undefined;
  activeSession: AuthSession | null;
  meetingId: string;
  isNextCameraEnabled: boolean;
  nextError: unknown;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setMediaControlError: (message: string) => void;
}): void {
  const {
    room,
    videoDeviceId,
    activeSession,
    meetingId,
    isNextCameraEnabled,
    nextError,
    setCameraPermissionState,
    setIsCamEnabled,
    setMediaControlError,
  } = input;
  if (isNextCameraEnabled && isMediaPermissionBlockedError(nextError)) {
    setCameraPermissionState("denied");
  }
  setIsCamEnabled(getLocalMediaSourceEnabled({ room, source: Track.Source.Camera }));
  setMediaControlError(
    isNextCameraEnabled
      ? getMediaPermissionErrorMessage({ kind: "camera", error: nextError })
      : getErrorMessage({ error: nextError, fallback: "Failed to turn camera off" }),
  );
  if (activeSession) {
    reportMeetingMediaIssue({
      token: activeSession.token,
      meetingId,
      kind: "camera",
      phase: "room-enable",
      error: nextError,
      selectedDevice: hasConfiguredMediaDeviceId(videoDeviceId),
      fallbackAttempted: hasConfiguredMediaDeviceId(videoDeviceId),
      recovered: false,
    });
    sendMeetingClientDiagnostic({
      token: activeSession.token,
      meetingId,
      diagnostic: {
        event: "media-control",
        phase: "in-room",
        outcome: "failed",
        kind: "camera",
        cameraEnabled: getLocalMediaSourceEnabled({ room, source: Track.Source.Camera }),
        selectedDevice: hasConfiguredMediaDeviceId(videoDeviceId),
        ...getClientDiagnosticError(nextError),
      },
    });
  }
}

type LiveMeetingAssistantRpcMethod =
  | typeof INTERRUPT_SPEECH_RPC
  | typeof REFRESH_AGENT_CONTEXT_RPC
  | typeof START_CONVERSATION_MODE_RPC
  | typeof STOP_CONVERSATION_MODE_RPC;

type LiveMeetingPagePerformAssistantRpc = (input: {
  method: LiveMeetingAssistantRpcMethod;
  payload?: string;
  voiceRequestRevision?: number;
}) => Promise<string | null>;

function resolveMeetingAssistantVoiceRoster(input: {
  voiceRoster: { agentIdentity: string; revision: string } | undefined;
  assistantIdentity: string;
  rosterRevision: string | undefined;
}): { agentIdentity: string; revision: string } | undefined {
  if (input.voiceRoster?.agentIdentity === input.assistantIdentity) {
    return input.voiceRoster;
  }
  if (input.rosterRevision !== undefined && input.rosterRevision.length > 0) {
    return { agentIdentity: input.assistantIdentity, revision: input.rosterRevision };
  }

  return undefined;
}

function isLiveMeetingStartConversationRpcDisabled(input: {
  method: LiveMeetingAssistantRpcMethod;
  room: Room;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  voiceRequestRevision?: number;
}): boolean {
  return (
    input.method === START_CONVERSATION_MODE_RPC &&
    (!canUseSoloVoice(input.room) ||
      !input.voiceModeIntentRef.current.canActivate() ||
      (input.voiceRequestRevision !== undefined &&
        !input.voiceModeIntentRef.current.isCurrent(input.voiceRequestRevision)))
  );
}

function getLiveMeetingAssistantRpcResponseTimeout(method: LiveMeetingAssistantRpcMethod): number {
  if (method === START_CONVERSATION_MODE_RPC) {
    return VOICE_RPC_START_TIMEOUT_MS;
  }
  if (method === STOP_CONVERSATION_MODE_RPC) {
    return VOICE_RPC_STOP_TIMEOUT_MS;
  }

  return ASSISTANT_RPC_RESPONSE_TIMEOUT_MS;
}

function buildLiveMeetingAssistantRpcPayload(input: {
  method: LiveMeetingAssistantRpcMethod;
  payload: string;
  voiceRoster: { agentIdentity: string; revision: string } | undefined;
}): string {
  if (input.method === START_CONVERSATION_MODE_RPC) {
    return JSON.stringify({ rosterRevision: input.voiceRoster?.revision });
  }

  return input.payload;
}

async function runLiveMeetingAttemptAssistantRpc(input: {
  room: Room;
  method: LiveMeetingAssistantRpcMethod;
  payload: string;
  maxAttempts: number;
  shouldWaitForAgentJoin: boolean;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  voiceRequestRevision?: number;
  attempt: number;
  voiceRoster: { agentIdentity: string; revision: string } | undefined;
}): Promise<string | null> {
  if (input.attempt >= input.maxAttempts) {
    return null;
  }
  const assistantParticipant = await waitForMeetingAgentParticipant({
    room: input.room,
    timeoutMs: input.shouldWaitForAgentJoin ? MEETING_AGENT_JOIN_WAIT_DEFAULT_MS : MEETING_AGENT_JOIN_WAIT_SHORT_MS,
  });

  await withOptionalLiveDeadline(assistantParticipant.waitUntilActive());
  const nextVoiceRoster = resolveMeetingAssistantVoiceRoster({
    voiceRoster: input.voiceRoster,
    assistantIdentity: assistantParticipant.identity,
    rosterRevision: assistantParticipant.attributes.assistantVoiceRosterRevision,
  });
  if (
    isLiveMeetingStartConversationRpcDisabled({
      method: input.method,
      room: input.room,
      voiceModeIntentRef: input.voiceModeIntentRef,
      voiceRequestRevision: input.voiceRequestRevision,
    })
  ) {
    return "disabled";
  }
  if (input.shouldWaitForAgentJoin && nextVoiceRoster === undefined) {
    if (input.attempt === input.maxAttempts - 1) {
      return "warming-up";
    }
    await delay(VOICE_RPC_RETRY_DELAY_MS);

    return runLiveMeetingAttemptAssistantRpc({ ...input, attempt: input.attempt + 1, voiceRoster: nextVoiceRoster });
  }

  try {
    return await input.room.localParticipant.performRpc({
      destinationIdentity: assistantParticipant.identity,
      method: input.method,
      payload: buildLiveMeetingAssistantRpcPayload({
        method: input.method,
        payload: input.payload,
        voiceRoster: nextVoiceRoster,
      }),
      responseTimeout: getLiveMeetingAssistantRpcResponseTimeout(input.method),
    });
  } catch (error) {
    if (isMethodNotSupportedError(error) && input.attempt < input.maxAttempts - 1) {
      await delay(VOICE_RPC_RETRY_DELAY_MS);

      return runLiveMeetingAttemptAssistantRpc({ ...input, attempt: input.attempt + 1, voiceRoster: nextVoiceRoster });
    }

    throw error;
  }
}

async function runLiveMeetingPerformAssistantRpc(input: {
  room: Room;
  method: LiveMeetingAssistantRpcMethod;
  payload: string;
  voiceRequestRevision?: number;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
}): Promise<string | null> {
  const shouldWaitForAgentJoin = input.method === START_CONVERSATION_MODE_RPC;
  const maxAttempts = shouldWaitForAgentJoin ? VOICE_RPC_START_MAX_ATTEMPTS : 1;

  return runLiveMeetingAttemptAssistantRpc({
    room: input.room,
    method: input.method,
    payload: input.payload,
    maxAttempts,
    shouldWaitForAgentJoin,
    voiceModeIntentRef: input.voiceModeIntentRef,
    voiceRequestRevision: input.voiceRequestRevision,
    attempt: 0,
    voiceRoster: undefined,
  });
}

export function runLiveMeetingStartLiveTranscriptionEffect(input: {
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  hasJoinedMeeting: boolean;
  isGuestSession: boolean;
  connectionState: ConnectionState;
  setTranscriptionState: Dispatch<SetStateAction<TranscriptionState>>;
  setError: Dispatch<SetStateAction<string | null>>;
}): (() => void) | void {
  const { activeSession, meeting } = input;
  if (!activeSession || !meeting || !input.hasJoinedMeeting || input.isGuestSession) {
    if (input.isGuestSession) {
      input.setTranscriptionState("off");
    }

    return;
  }

  if (input.connectionState !== ConnectionState.Connected) {
    input.setTranscriptionState("ready");

    return;
  }

  const lifecycle = { isCancelled: false };
  const controller = new AbortController();

  void (async () => {
    input.setTranscriptionState("starting");

    try {
      await startLiveTranscription({
        token: activeSession.token,
        meetingId: meeting.id,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS)]),
      });
      if (!lifecycle.isCancelled) {
        input.setTranscriptionState("on");
      }
    } catch (nextError) {
      if (lifecycle.isCancelled) {
        return;
      }

      if (reportOptionalLiveServiceFailure({ error: nextError, feature: "captions" })) {
        input.setTranscriptionState("off");

        return;
      }
      input.setTranscriptionState("error");
      input.setError(getErrorMessage({ error: nextError, fallback: "Failed to control live transcription" }));
    }
  })();

  return () => {
    lifecycle.isCancelled = true;
    controller.abort();
  };
}

export async function runLiveMeetingToggleMic(input: {
  room: Room;
  audioDeviceId: string | undefined;
  activeSession: AuthSession | null;
  meetingId: string;
  clearMediaControlError: () => void;
  setMediaControlError: (message: string) => void;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
}): Promise<void> {
  const isNextMicEnabled = !getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Microphone });

  try {
    await input.room.localParticipant.setMicrophoneEnabled(
      isNextMicEnabled,
      isNextMicEnabled ? getMeetingAudioCaptureOptions(input.audioDeviceId) : undefined,
    );
    if (isNextMicEnabled) {
      input.setMicrophonePermissionState("granted");
    }
    const isMicrophoneEnabled = getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Microphone });
    input.setIsMicEnabled(isMicrophoneEnabled);
    input.clearMediaControlError();
    if (input.activeSession !== null) {
      sendMeetingClientDiagnostic({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        diagnostic: {
          event: "media-control",
          phase: "in-room",
          outcome: isMicrophoneEnabled ? "enabled" : "disabled",
          kind: "microphone",
          microphoneEnabled: isMicrophoneEnabled,
          selectedDevice: hasConfiguredMediaDeviceId(input.audioDeviceId),
        },
      });
    }
  } catch (nextError) {
    if (isNextMicEnabled && isMediaPermissionBlockedError(nextError)) {
      input.setMicrophonePermissionState("denied");
    }
    input.setIsMicEnabled(getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Microphone }));
    input.setMediaControlError(
      isNextMicEnabled
        ? getMediaPermissionErrorMessage({ kind: "microphone", error: nextError })
        : getErrorMessage({ error: nextError, fallback: "Failed to mute microphone" }),
    );
    if (input.activeSession !== null) {
      reportMeetingMediaIssue({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        kind: "microphone",
        phase: "room-enable",
        error: nextError,
        selectedDevice: hasConfiguredMediaDeviceId(input.audioDeviceId),
        fallbackAttempted: false,
        recovered: false,
      });
      sendMeetingClientDiagnostic({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        diagnostic: {
          event: "media-control",
          phase: "in-room",
          outcome: "failed",
          kind: "microphone",
          microphoneEnabled: getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Microphone }),
          selectedDevice: hasConfiguredMediaDeviceId(input.audioDeviceId),
          ...getClientDiagnosticError(nextError),
        },
      });
    }
  }
}

function buildLiveMeetingPresenceEntries(input: {
  activeSession: AuthSession | null;
  room: Room | null;
  tracks: TrackView[];
  participantAvatarUrls: {
    avatarUrlsByUserId: Map<string, string | null | undefined>;
    avatarUrlsByDisplayName: Map<string, string | null | undefined>;
  };
  presenceVersion: number;
}): PresenceEntry[] {
  void input.presenceVersion;
  const localEntry: PresenceEntry | null = input.activeSession?.user
    ? {
        id: `local:${input.activeSession.user.id}`,
        userId: input.activeSession.user.id,
        displayName: input.activeSession.user.displayName,
        email: input.activeSession.user.email,
        avatarUrl: input.activeSession.user.avatarUrl,
        isYou: true,
        subtitle: input.tracks.some((track) => track.isLocal && isScreenShareTrack(track))
          ? LIVE_MEETING_PAGE_COPY.presenceYouPresenting
          : LIVE_MEETING_PAGE_COPY.presenceYouSubtitle,
      }
    : null;
  const remoteEntries: PresenceEntry[] = input.room
    ? Array.from(input.room.remoteParticipants.values())
        .filter((participant) => !isMeetingAgentParticipant(participant))
        .map((participant) => {
          const participantDisplayName =
            participant.name !== undefined && participant.name.length > 0
              ? participant.name
              : participant.identity.length > 0
                ? participant.identity
                : LIVE_MEETING_PAGE_COPY.defaultParticipantDisplayName;
          const isParticipantPresenting = input.tracks.some(
            (track) =>
              !track.isLocal && track.participantIdentity === participant.identity && isScreenShareTrack(track),
          );

          return {
            id: participant.identity,
            userId: getParticipantUserId(participant),
            displayName: participantDisplayName,
            avatarUrl: getParticipantAvatarUrl({
              participant,
              participantAvatarUrls: input.participantAvatarUrls,
            }),
            subtitle: isParticipantPresenting
              ? LIVE_MEETING_PAGE_COPY.presenceParticipantPresenting
              : LIVE_MEETING_PAGE_COPY.presenceParticipantSubtitle,
          };
        })
    : [];
  const peopleEntries = [...(localEntry !== null ? [localEntry] : []), ...remoteEntries];

  if (!input.room) {
    return peopleEntries;
  }

  const agentEntries = peopleEntries.map((entry) => ({
    id: `agent:${entry.id}`,
    userId: entry.userId,
    displayName: formatPersonalAssistantName({ displayName: entry.displayName, email: entry.email }),
    email: entry.email,
    avatarUrl: null,
    /** @external presence list entry */
    isAssistant: true,
    subtitle: LIVE_MEETING_PAGE_COPY.presenceAgentReadySubtitle,
  }));

  return [...peopleEntries, ...agentEntries];
}

function buildLiveMeetingParticipantVisuals(input: {
  room: Room | null;
  session: AuthSession | null;
  isCamEnabled: boolean;
  tracks: TrackView[];
  participantAvatarUrls: {
    avatarUrlsByUserId: Map<string, string | null | undefined>;
    avatarUrlsByDisplayName: Map<string, string | null | undefined>;
  };
  participantSpeechStore: ReturnType<typeof createParticipantSpeechStore>;
  presenceVersion: number;
}): ParticipantVisual[] {
  void input.presenceVersion;
  if (!input.room || !input.session?.user) {
    return [];
  }

  const localVideoTrack = input.isCamEnabled
    ? input.tracks.find((track) => track.kind === "video" && track.isLocal && track.source === Track.Source.Camera)
    : undefined;
  const localVisual: ParticipantVisual = {
    id: `local:${input.session.user.id}`,
    displayName: input.session.user.displayName,
    email: input.session.user.email,
    avatarUrl: input.session.user.avatarUrl,
    isLocal: true,
    trackView: localVideoTrack,
    speechSource: input.participantSpeechStore.forParticipant(input.room.localParticipant.identity),
  };
  const remoteVisuals = Array.from(input.room.remoteParticipants.values())
    .filter((participant) => !isMeetingAgentParticipant(participant))
    .map((participant): ParticipantVisual => {
      const remoteVideoTrack = participant.isCameraEnabled
        ? input.tracks.find(
            (track) =>
              track.kind === "video" &&
              track.source === Track.Source.Camera &&
              track.participantIdentity === participant.identity,
          )
        : undefined;

      return {
        id: participant.identity,
        displayName:
          participant.name !== undefined && participant.name.length > 0
            ? participant.name
            : participant.identity.length > 0
              ? participant.identity
              : LIVE_MEETING_PAGE_COPY.defaultParticipantDisplayName,
        avatarUrl: getParticipantAvatarUrl({
          participant,
          participantAvatarUrls: input.participantAvatarUrls,
        }),
        callerPhoneNumber: getSipParticipantPhoneNumber(participant),
        isLocal: false,
        trackView: remoteVideoTrack,
        speechSource: input.participantSpeechStore.forParticipant(participant.identity),
      };
    });

  return [localVisual, ...remoteVisuals];
}

function buildLiveMeetingStartingPresentationClaims(input: {
  room: Room | null;
  dataPresentationClaimsByIdentity: Record<string, PresentationClaim>;
  presenceVersion: number;
}): PresentationClaim[] {
  void input.presenceVersion;
  if (!input.room) {
    return [];
  }

  const room = input.room;
  const claimsByIdentity = new Map<string, PresentationClaim>();
  const addClaim = (claim: PresentationClaim | null) => {
    if (!claim) {
      return;
    }

    const existing = claimsByIdentity.get(claim.participantIdentity);
    if (!existing || claim.requestedAt < existing.requestedAt) {
      claimsByIdentity.set(claim.participantIdentity, claim);
    }
  };

  addClaim(getParticipantPresentationClaim(room.localParticipant));

  Object.values(input.dataPresentationClaimsByIdentity).forEach((claim) => {
    if (isPresentationClaimFromCurrentRoom({ room, claim })) {
      addClaim(claim);
    }
  });

  Array.from(room.remoteParticipants.values()).forEach((participant) => {
    if (isMeetingAgentParticipant(participant)) {
      return;
    }

    addClaim(getParticipantPresentationClaim(participant));
  });

  return Array.from(claimsByIdentity.values());
}

function getLiveMeetingScreenSharePresentationState(input: {
  screenShareVisuals: ScreenShareVisual[];
  pinnedScreenShareTrackId: string | null;
}): {
  selectedScreenShareVisual: ScreenShareVisual | null;
  hasActiveScreenShare: boolean;
  localScreenShareVisual: ScreenShareVisual | null;
  remoteScreenShareVisual: ScreenShareVisual | null;
} {
  const selectedScreenShareVisual =
    input.screenShareVisuals.find((track) => track.id === input.pinnedScreenShareTrackId) ??
    input.screenShareVisuals[0] ??
    null;
  const localScreenShareVisual = input.screenShareVisuals.find((track) => track.isLocal) ?? null;
  const remoteScreenShareVisual = input.screenShareVisuals.find((track) => !track.isLocal) ?? null;

  return {
    selectedScreenShareVisual,
    hasActiveScreenShare: Boolean(selectedScreenShareVisual),
    localScreenShareVisual,
    remoteScreenShareVisual,
  };
}

function buildLiveMeetingScreenShareBlockerMessage(input: {
  localScreenShareVisual: ScreenShareVisual | null;
  remoteScreenShareVisual: ScreenShareVisual | null;
  winningPresentationClaim: PresentationClaim | null;
  room: Room | null;
}): string | null {
  if (input.localScreenShareVisual) {
    return null;
  }

  if (input.remoteScreenShareVisual) {
    return `${input.remoteScreenShareVisual.displayName}${LIVE_MEETING_PAGE_COPY.screenShareRemotePresenterPrefix}`;
  }

  if (
    input.winningPresentationClaim &&
    input.winningPresentationClaim.participantIdentity !== input.room?.localParticipant.identity
  ) {
    const presenterLabel = getPresentationClaimPresenterLabel(input.winningPresentationClaim.participantName);

    return `${presenterLabel}${LIVE_MEETING_PAGE_COPY.screenShareRemotePresenterStartingSuffix}`;
  }

  return null;
}

function buildLiveMeetingScreenShareVisuals(input: {
  room: Room | null;
  session: AuthSession | null;
  tracks: TrackView[];
}): ScreenShareVisual[] {
  if (!input.room || !input.session?.user) {
    return [];
  }

  const room = input.room;
  const sessionUser = input.session.user;

  return input.tracks
    .filter((trackView) => {
      if (!isActiveScreenShareTrack(trackView)) {
        return false;
      }

      if (trackView.isLocal) {
        return true;
      }

      const participant = room.remoteParticipants.get(trackView.participantIdentity);

      return !participant || !isMeetingAgentParticipant(participant);
    })
    .map((trackView) => {
      const participant = trackView.isLocal ? null : room.remoteParticipants.get(trackView.participantIdentity);

      return {
        id: trackView.id,
        displayName: trackView.isLocal
          ? sessionUser.displayName
          : participant !== undefined &&
              participant !== null &&
              participant.name !== undefined &&
              participant.name.length > 0
            ? participant.name
            : trackView.participantName !== undefined && trackView.participantName.length > 0
              ? trackView.participantName
              : trackView.participantIdentity.length > 0
                ? trackView.participantIdentity
                : LIVE_MEETING_PAGE_COPY.defaultParticipantDisplayName,
        isLocal: trackView.isLocal,
        trackView,
      };
    });
}

function createLiveMeetingEndMeetingWorkspaceTransition(input: {
  isGuestSession: boolean;
  targetMeetingId: string;
  flowStartedAt: number;
  router: ReturnType<typeof useRouter>;
}): () => Promise<void> {
  const routing = { isStarted: false };

  return async () => {
    if (routing.isStarted) {
      return;
    }
    routing.isStarted = true;
    if (input.isGuestSession) {
      writeGuestNotesHandoff({ meetingId: input.targetMeetingId, startedAt: input.flowStartedAt });
      input.router.push(`/guest/meetings/${input.targetMeetingId}/notes`);

      return;
    }

    try {
      window.sessionStorage.setItem(WORKSPACE_END_MEETING_TRANSITION_KEY, "1");
      window.sessionStorage.removeItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY);
      markWorkspaceNotesRevealPending(input.targetMeetingId);
    } catch (error) {
      void describeCaughtFailure(error);
      // best-effort transition handoff
    }
    input.router.push(`/workspace/${input.targetMeetingId}`);
  };
}

async function runLiveMeetingOnEndMeeting(input: {
  action: EndMeetingAction;
  remoteEnd: MeetingDetailPayload | true | undefined;
  activeSession: AuthSession;
  meeting: Meeting;
  isGuestSession: boolean;
  isScreenShareFullscreen: boolean;
  room: Room | null;
  refreshSession: () => Promise<AuthSession | null>;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
  speechLevelRef: { current: number };
  joinBookkeepingRequestRef: { current: Promise<unknown> | null };
  setIsBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsEndMeetingMenuOpen: Dispatch<SetStateAction<boolean>>;
  setEndMeetingFlow: Dispatch<SetStateAction<EndMeetingFlowState | null>>;
  setIsEndMeetingOverlayExiting: Dispatch<SetStateAction<boolean>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setIsCaptionSpeechActive: Dispatch<SetStateAction<boolean>>;
  setHasJoinedMeeting: Dispatch<SetStateAction<boolean>>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
  setIsScreenShareBusy: Dispatch<SetStateAction<boolean>>;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
}): Promise<void> {
  const speechLevelRef = input.speechLevelRef;
  if (input.isScreenShareFullscreen) {
    void (async () => {
      try {
        await exitCurrentFullscreen();
      } catch (error) {
        void describeCaughtFailure(error);
      }
    })();
  }

  input.setIsBusy(true);
  input.setError(null);
  input.setIsEndMeetingMenuOpen(false);

  const targetMeetingId = input.meeting.id;
  const flowStartedAt = Date.now();

  input.setEndMeetingFlow({
    startedAt: flowStartedAt,
    phase: "closing_room",
    detail: null,
    transientError: null,
  });
  input.setIsEndMeetingOverlayExiting(false);
  input.setIsMicEnabled(false);
  input.setIsCamEnabled(false);
  input.setConnectionState(ConnectionState.Disconnected);
  speechLevelRef.current = 0;
  input.setIsCaptionSpeechActive(false);
  input.setHasJoinedMeeting(false);
  input.setPinnedScreenShareTrackId(null);
  input.setIsScreenShareBusy(false);
  const disconnectPromise = disconnectAndStopRoomMedia(input.room);
  try {
    window.localStorage.removeItem(ACTIVE_MEETING_KEY);
  } catch (error) {
    void describeCaughtFailure(error);
    /* Storage cannot block leaving. */
  }

  const commitWorkspaceTransition = createLiveMeetingEndMeetingWorkspaceTransition({
    isGuestSession: input.isGuestSession,
    targetMeetingId,
    flowStartedAt,
    router: input.router,
  });

  void runLiveMeetingEndMeetingDeparture({
    action: input.action,
    remoteEnd: input.remoteEnd,
    activeSession: input.activeSession,
    targetMeetingId,
    flowStartedAt,
    isGuestSession: input.isGuestSession,
    disconnectPromise,
    joinBookkeepingRequestRef: input.joinBookkeepingRequestRef,
    refreshSession: input.refreshSession,
    commitWorkspaceTransition,
    setEndMeetingFlow: input.setEndMeetingFlow,
    setRoom: input.setRoom,
    setTracks: input.setTracks,
    setIsEndMeetingOverlayExiting: input.setIsEndMeetingOverlayExiting,
    router: input.router,
    showToast: input.showToast,
  });
}

async function runLiveMeetingToggleCamera(input: {
  room: Room;
  videoDeviceId: string | undefined;
  activeSession: AuthSession | null;
  meetingId: string;
  isBackgroundBlurEnabled: boolean;
  isBackgroundBlurSupported: boolean;
  clearMediaControlError: () => void;
  setMediaControlError: (message: string) => void;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setPublishedCameraBackgroundBlur: (input: { targetRoom: Room; isEnabled: boolean }) => Promise<void>;
}): Promise<void> {
  const isNextCameraEnabled =
    !isMeetingCameraStarting(input.room.localParticipant) &&
    !getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Camera });
  if (!isNextCameraEnabled) {
    cancelMeetingCameraStart(input.room.localParticipant);
  }

  try {
    const cameraEnableResult = isNextCameraEnabled
      ? await enableMeetingCameraWithFallback(input.room.localParticipant, input.videoDeviceId)
      : (await input.room.localParticipant.setCameraEnabled(false), null);
    if (
      cameraEnableResult !== null &&
      cameraEnableResult.recoveredWithDefaultDevice &&
      cameraEnableResult.firstError !== null &&
      input.activeSession !== null
    ) {
      applyRecoveredVideoDeviceId({
        deviceId: getPublishedCameraDeviceId(input.room.localParticipant),
        setVideoDeviceId: input.setVideoDeviceId,
      });
      reportMeetingMediaIssue({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        kind: "camera",
        phase: "room-enable",
        error: cameraEnableResult.firstError,
        selectedDevice: true,
        fallbackAttempted: true,
        recovered: true,
      });
    }
    if (isNextCameraEnabled) {
      input.setCameraPermissionState("granted");
    }
    const isCameraEnabled = getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Camera });
    input.setIsCamEnabled(isCameraEnabled);
    input.clearMediaControlError();
    if (input.activeSession !== null) {
      sendMeetingClientDiagnostic({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        diagnostic: {
          event: "media-control",
          phase: "in-room",
          outcome: isCameraEnabled ? "enabled" : "disabled",
          kind: "camera",
          cameraEnabled: isCameraEnabled,
          selectedDevice: hasConfiguredMediaDeviceId(input.videoDeviceId),
        },
      });
    }
  } catch (nextError) {
    if (nextError instanceof MeetingCameraStartCancelledError) {
      return;
    }
    reportLiveMeetingCameraToggleFailure({
      room: input.room,
      videoDeviceId: input.videoDeviceId,
      activeSession: input.activeSession,
      meetingId: input.meetingId,
      isNextCameraEnabled,
      nextError,
      setCameraPermissionState: input.setCameraPermissionState,
      setIsCamEnabled: input.setIsCamEnabled,
      setMediaControlError: input.setMediaControlError,
    });
  }
}

function runLiveMeetingAmbientContextImagesEffect(input: {
  activeSession: AuthSession;
  meeting: Meeting;
  ambientContextItems: MeetingAmbientContextItem[];
  ambientContextImageSourcesRef: { current: Record<string, string> };
  ambientContextImageLoadsRef: { current: Set<string> };
  setAmbientContextImageUrls: Dispatch<SetStateAction<Record<string, string>>>;
}): (() => void) | void {
  const ambientContextImageSourcesRef = input.ambientContextImageSourcesRef;
  const ambientContextImageLoadsRef = input.ambientContextImageLoadsRef;
  const lifecycle = { isCancelled: false };
  input.ambientContextItems.forEach((item) => {
    const imageSource = item.imageUrl ?? "";
    if (
      item.imageStatus !== "ready" ||
      imageSource.length === 0 ||
      ambientContextImageSourcesRef.current[item.id] === imageSource ||
      ambientContextImageLoadsRef.current.has(item.id)
    ) {
      return;
    }
    ambientContextImageLoadsRef.current.add(item.id);
    void (async () => {
      try {
        const objectUrl = await getMeetingAmbientContextImageObjectUrl({
          token: input.activeSession.token,
          meetingId: input.meeting.id,
          itemId: item.id,
          cacheKey: imageSource,
        });
        if (lifecycle.isCancelled) {
          URL.revokeObjectURL(objectUrl);

          return;
        }
        ambientContextImageSourcesRef.current[item.id] = imageSource;
        input.setAmbientContextImageUrls((current) => {
          const previousObjectUrl = current[item.id];
          if (previousObjectUrl !== undefined && previousObjectUrl.length > 0) {
            URL.revokeObjectURL(previousObjectUrl);
          }

          return { ...current, [item.id]: objectUrl };
        });
      } catch (error) {
        void describeCaughtFailure(error);
      } finally {
        ambientContextImageLoadsRef.current.delete(item.id);
      }
    })();
  });

  return () => {
    lifecycle.isCancelled = true;
  };
}

async function runLiveMeetingSelectAudioDevice(input: {
  nextDeviceId: string;
  audioDeviceId: string | undefined;
  room: Room;
  activeSession: AuthSession | null;
  meetingId: string;
  setAudioDeviceId: Dispatch<SetStateAction<string | undefined>>;
  clearMediaControlError: () => void;
  setMediaControlError: (message: string) => void;
}): Promise<void> {
  const previousDeviceId = input.audioDeviceId;
  input.setAudioDeviceId(input.nextDeviceId);

  try {
    await input.room.switchActiveDevice("audioinput", input.nextDeviceId);
    input.clearMediaControlError();
    if (input.activeSession) {
      sendMeetingClientDiagnostic({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        diagnostic: {
          event: "media-device-change",
          phase: "in-room",
          outcome: "succeeded",
          kind: "microphone",
          microphoneEnabled: getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Microphone }),
          selectedDevice: true,
        },
      });
    }
  } catch (nextError) {
    input.setAudioDeviceId(previousDeviceId);
    input.setMediaControlError(getErrorMessage({ error: nextError, fallback: "Failed to switch microphone" }));
    if (input.activeSession) {
      sendMeetingClientDiagnostic({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        diagnostic: {
          event: "media-device-change",
          phase: "in-room",
          outcome: "failed",
          kind: "microphone",
          selectedDevice: true,
          ...getClientDiagnosticError(nextError),
        },
      });
    }
  }
}

async function runLiveMeetingSelectVideoDevice(input: {
  nextDeviceId: string;
  videoDeviceId: string | undefined;
  room: Room;
  activeSession: AuthSession | null;
  meetingId: string;
  isCamEnabled: boolean;
  isBackgroundBlurEnabled: boolean;
  isBackgroundBlurSupported: boolean;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
  clearMediaControlError: () => void;
  setMediaControlError: (message: string) => void;
  setPublishedCameraBackgroundBlur: (input: { targetRoom: Room; isEnabled: boolean }) => Promise<void>;
}): Promise<void> {
  const previousDeviceId = input.videoDeviceId;
  input.setVideoDeviceId(input.nextDeviceId);

  try {
    await input.room.switchActiveDevice("videoinput", input.nextDeviceId);
    if (input.isCamEnabled && input.isBackgroundBlurEnabled && input.isBackgroundBlurSupported) {
      await input.setPublishedCameraBackgroundBlur({ targetRoom: input.room, isEnabled: true });
    }
    input.clearMediaControlError();
    if (input.activeSession) {
      sendMeetingClientDiagnostic({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        diagnostic: {
          event: "media-device-change",
          phase: "in-room",
          outcome: "succeeded",
          kind: "camera",
          cameraEnabled: getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Camera }),
          selectedDevice: true,
        },
      });
    }
  } catch (nextError) {
    input.setVideoDeviceId(previousDeviceId);
    input.setMediaControlError(getErrorMessage({ error: nextError, fallback: "Failed to switch camera" }));
    if (input.activeSession) {
      sendMeetingClientDiagnostic({
        token: input.activeSession.token,
        meetingId: input.meetingId,
        diagnostic: {
          event: "media-device-change",
          phase: "in-room",
          outcome: "failed",
          kind: "camera",
          selectedDevice: true,
          ...getClientDiagnosticError(nextError),
        },
      });
    }
  }
}

export async function runLiveMeetingToggleBackgroundBlur(input: {
  room: Room;
  isBackgroundBlurEnabled: boolean;
  isCamEnabled: boolean;
  activeSession: AuthSession | null;
  isGuestSession: boolean;
  setIsBackgroundBlurBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsBackgroundBlurEnabled: Dispatch<SetStateAction<boolean>>;
  setPublishedCameraBackgroundBlur: (input: { targetRoom: Room; isEnabled: boolean }) => Promise<void>;
}): Promise<void> {
  const isNextBackgroundBlurEnabled = !input.isBackgroundBlurEnabled;
  input.setIsBackgroundBlurEnabled(isNextBackgroundBlurEnabled);
  setMeetingCameraBlurPreference(input.room.localParticipant, Promise.resolve(isNextBackgroundBlurEnabled));
  input.setIsBackgroundBlurBusy(true);
  input.setError(null);

  try {
    await input.setPublishedCameraBackgroundBlur({ targetRoom: input.room, isEnabled: isNextBackgroundBlurEnabled });
    input.setIsBackgroundBlurEnabled(isNextBackgroundBlurEnabled);
    const { activeSession } = input;
    if (activeSession !== null && !input.isGuestSession) {
      void (async () => {
        try {
          await updateMediaPreferences({
            token: activeSession.token,
            input: { backgroundBlurEnabled: isNextBackgroundBlurEnabled },
            signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          reportOptionalLiveServiceFailure({ error, feature: "realtime" });
          void describeCaughtFailure(error);
        }
      })();
    }
  } catch (nextError) {
    input.setError(getErrorMessage({ error: nextError, fallback: LIVE_MEETING_PAGE_COPY.backgroundBlurUpdateFailed }));
  } finally {
    input.setIsBackgroundBlurBusy(false);
  }
}

function runLiveMeetingBrowserMediaPermissionsWatchEffect(input: {
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
}): (() => void) | void {
  if (!("permissions" in navigator) || typeof navigator.permissions.query !== "function") {
    input.setMicrophonePermissionState("unsupported");
    input.setCameraPermissionState("unsupported");

    return;
  }

  const lifecycle: { isCancelled: boolean; handlers: (() => void)[] } = { isCancelled: false, handlers: [] };

  const watchPermission = async (watchInput: {
    kind: MediaPermissionKind;
    setState: (state: BrowserMediaPermissionState) => void;
  }) => {
    try {
      const permissionStatus = await navigator.permissions.query({
        // TS keeps PermissionDescriptor narrow; browser permission names use these literals.
        name: watchInput.kind,
      });
      if (lifecycle.isCancelled) {
        return;
      }

      const updateState = () => watchInput.setState(permissionStatus.state);
      updateState();
      permissionStatus.addEventListener("change", updateState);
      lifecycle.handlers = [...lifecycle.handlers, () => permissionStatus.removeEventListener("change", updateState)];
    } catch (error) {
      void describeCaughtFailure(error);
      if (!lifecycle.isCancelled) {
        watchInput.setState("unsupported");
      }
    }
  };

  void watchPermission({ kind: "microphone", setState: input.setMicrophonePermissionState });
  void watchPermission({ kind: "camera", setState: input.setCameraPermissionState });

  return () => {
    lifecycle.isCancelled = true;
    lifecycle.handlers.forEach((cleanup) => {
      cleanup();
    });
  };
}

function runLiveMeetingLocalMediaStateSyncEffect(input: {
  room: Room;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
}): (() => void) | void {
  const trackListeners: { cleanups: (() => void)[] } = { cleanups: [] };
  const cleanupCurrentTrackListeners = () => {
    trackListeners.cleanups.forEach((cleanup) => {
      cleanup();
    });
    trackListeners.cleanups = [];
  };

  const syncLocalMediaState = () => {
    input.setIsMicEnabled(getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Microphone }));
    input.setIsCamEnabled(getLocalMediaSourceEnabled({ room: input.room, source: Track.Source.Camera }));
  };

  const syncLocalMediaStateAndTrackListeners = () => {
    cleanupCurrentTrackListeners();
    [Track.Source.Microphone, Track.Source.Camera].forEach((source) => {
      const mediaStreamTrack = input.room.localParticipant.getTrackPublication(source)?.track?.mediaStreamTrack;
      if (!mediaStreamTrack) {
        return;
      }
      mediaStreamTrack.addEventListener("ended", syncLocalMediaState);
      trackListeners.cleanups = [
        ...trackListeners.cleanups,
        () => mediaStreamTrack.removeEventListener("ended", syncLocalMediaState),
      ];
    });
    syncLocalMediaState();
  };
  const handleActiveDeviceChanged = (kind: MediaDeviceKind) => {
    if (kind === "audioinput" || kind === "videoinput") {
      syncLocalMediaStateAndTrackListeners();
    }
  };

  syncLocalMediaStateAndTrackListeners();
  input.room.on(RoomEvent.LocalTrackPublished, syncLocalMediaStateAndTrackListeners);
  input.room.on(RoomEvent.LocalTrackUnpublished, syncLocalMediaStateAndTrackListeners);
  input.room.on(RoomEvent.ActiveDeviceChanged, handleActiveDeviceChanged);
  input.room.on(RoomEvent.TrackMuted, syncLocalMediaState);
  input.room.on(RoomEvent.TrackUnmuted, syncLocalMediaState);

  return () => {
    input.room.off(RoomEvent.LocalTrackPublished, syncLocalMediaStateAndTrackListeners);
    input.room.off(RoomEvent.LocalTrackUnpublished, syncLocalMediaStateAndTrackListeners);
    input.room.off(RoomEvent.ActiveDeviceChanged, handleActiveDeviceChanged);
    input.room.off(RoomEvent.TrackMuted, syncLocalMediaState);
    input.room.off(RoomEvent.TrackUnmuted, syncLocalMediaState);
    cleanupCurrentTrackListeners();
  };
}

function runLiveMeetingWebSearchPanelIdleTimeoutEffect(input: {
  webSearchPanelState: WebSearchPanelState | null;
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
}): (() => void) | void {
  const initialState = input.webSearchPanelState;
  if (!initialState || !isVoiceWebSearchLookingForAnswer(initialState)) {
    return;
  }

  const idleRunId = input.webSearchPanelRunIdRef.current;
  const timeoutId = window.setTimeout(
    () => {
      const current = input.webSearchPanelStateRef.current;
      if (
        input.webSearchPanelRunIdRef.current !== idleRunId ||
        !current ||
        !isVoiceWebSearchLookingForAnswer(current) ||
        !voiceWebSearchPayloadMatchesCurrent(current, initialState)
      ) {
        return;
      }
      input.updateWebSearchPanelState({
        ...current,
        status: "error",
        message:
          current.contentKind === "meeting-answer"
            ? LIVE_MEETING_PAGE_COPY.webSearchMeetingAnswerTimeout
            : LIVE_MEETING_PAGE_COPY.webSearchResultsTimeout,
        updatedAt: Date.now(),
      });
    },
    initialState.contentKind === "meeting-answer" ? WEB_SEARCH_MEETING_ANSWER_IDLE_MS : WEB_SEARCH_LOADER_MAX_IDLE_MS,
  );

  return () => {
    window.clearTimeout(timeoutId);
  };
}

function runLiveMeetingWebSearchPersistedHistoryLoadEffect(input: {
  activeSession: AuthSession;
  meeting: Meeting;
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  setWebSearchHistory: Dispatch<SetStateAction<WebSearchPanelState[]>>;
  setWebSearchPanelState: Dispatch<SetStateAction<WebSearchPanelState | null>>;
}): (() => void) | void {
  const { activeSession, meeting, setWebSearchHistory, setWebSearchPanelState, webSearchPanelStateRef } = input;
  const lifecycle = { isCancelled: false };
  void (async () => {
    try {
      const runs = await listMeetingWebResearchRuns({
        token: activeSession.token,
        meetingId: meeting.id,
        signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
      });
      if (lifecycle.isCancelled) {
        return;
      }
      const persistedStates = runs.map((run) => {
        const parsed = parseVoiceWebSearchPanelPayload(
          JSON.stringify({
            ...run,
            meetingId: meeting.id,
          }),
        );
        const persistedUpdatedAt = Date.parse(run.updatedAt ?? run.createdAt ?? "");

        return {
          ...parsed,
          updatedAt: Number.isFinite(persistedUpdatedAt) ? persistedUpdatedAt : Date.now(),
        } satisfies WebSearchPanelState;
      });
      setWebSearchHistory((current) =>
        persistedStates.reduce((history, state) => upsertWebSearchHistory({ history, nextState: state }), current),
      );
      const persistedActiveSearch = persistedStates.find(isVoiceWebSearchLookingForAnswer);
      if (persistedActiveSearch !== undefined && webSearchPanelStateRef.current === null) {
        webSearchPanelStateRef.current = persistedActiveSearch;
        setWebSearchPanelState(persistedActiveSearch);
      }
    } catch (nextError) {
      if (!lifecycle.isCancelled) {
        console.error("[readymeet:web-search] Failed to load search history.", nextError);
      }
    }
  })();

  return () => {
    lifecycle.isCancelled = true;
  };
}

function runLiveMeetingWebSearchPanelUnmountCleanupEffect(input: {
  webSearchDeferredPayloadTimerRef: { current: number | null };
  webSearchDeferredPayloadResolveRef: { current: ((applied: boolean) => void) | null };
}): () => void {
  const { webSearchDeferredPayloadTimerRef, webSearchDeferredPayloadResolveRef } = input;

  return () => {
    if (webSearchDeferredPayloadTimerRef.current !== null) {
      window.clearTimeout(webSearchDeferredPayloadTimerRef.current);
    }
    webSearchDeferredPayloadResolveRef.current?.(false);
    webSearchDeferredPayloadResolveRef.current = null;
  };
}

function runLiveMeetingLiveRoomJoiningInfoCopiedTimerUnmountCleanupEffect(input: {
  liveRoomJoiningInfoCopiedTimerRef: { current: number | null };
}): () => void {
  return () => {
    if (input.liveRoomJoiningInfoCopiedTimerRef.current !== null) {
      window.clearTimeout(input.liveRoomJoiningInfoCopiedTimerRef.current);
    }
  };
}

function runLiveMeetingWebSearchAmbientPanelPollEffect(input: {
  token: string;
  webSearchPanelState: WebSearchPanelState | null;
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
}): (() => void) | void {
  const initialState = input.webSearchPanelState;
  if (
    initialState?.meetingId === undefined ||
    initialState.meetingId === null ||
    initialState.meetingId.length === 0 ||
    initialState.contentKind === "meeting-answer" ||
    !isVoiceWebSearchLookingForAnswer(initialState)
  ) {
    return;
  }

  const pollState: {
    isPollCancelled: {
      /** @external ref wire */
      current: boolean;
    };
    timeoutId: number | null;
  } = {
    isPollCancelled: { current: false },
    timeoutId: null,
  };
  const watchdogRunId = input.webSearchPanelRunIdRef.current;

  function schedulePoll(attempt: number) {
    schedulePersistedWebSearchPanelPoll({ attempt, pollState, pollPersistedRun });
  }

  async function pollPersistedRun(attempt: number) {
    return pollPersistedWebSearchPanelRun({
      attempt,
      token: input.token,
      pollState,
      watchdogRunId,
      webSearchPanelRunIdRef: input.webSearchPanelRunIdRef,
      webSearchPanelStateRef: input.webSearchPanelStateRef,
      schedulePoll,
      updateWebSearchPanelState: input.updateWebSearchPanelState,
    });
  }

  schedulePoll(0);

  return () => {
    pollState.isPollCancelled.current = true;
    if (pollState.timeoutId !== null) {
      window.clearTimeout(pollState.timeoutId);
    }
  };
}

function runLiveMeetingLiveRoomClockEffect(input: {
  setLiveRoomClock: Dispatch<SetStateAction<string>>;
  setLiveRoomOrigin: Dispatch<SetStateAction<string>>;
}): () => void {
  const updateClock = () => input.setLiveRoomClock(formatLiveRoomClock());
  const clock: { intervalId: number | null } = { intervalId: null };
  input.setLiveRoomOrigin(window.location.origin);
  const timeoutId = window.setTimeout(() => {
    updateClock();
    clock.intervalId = window.setInterval(updateClock, LIVE_ROOM_CLOCK_INTERVAL_MS);
  }, getMsUntilNextMinute());

  updateClock();

  return () => {
    window.clearTimeout(timeoutId);
    if (clock.intervalId !== null) {
      window.clearInterval(clock.intervalId);
    }
  };
}

function runLiveMeetingEndMeetingFlowTickEffect(input: {
  endMeetingFlow: EndMeetingFlowState | null;
  setEndMeetingFlowNow: Dispatch<SetStateAction<number>>;
}): (() => void) | void {
  if (!input.endMeetingFlow) {
    return;
  }

  input.setEndMeetingFlowNow(Date.now());
  const intervalId = window.setInterval(() => {
    input.setEndMeetingFlowNow(Date.now());
  }, END_MEETING_FLOW_TICK_MS);

  return () => window.clearInterval(intervalId);
}

function runLiveMeetingLiveVideoGridResizeEffect(input: {
  liveVideoGridRef: { current: HTMLDivElement | null };
  setLiveVideoGridSize: Dispatch<
    SetStateAction<{
      width: number;
      height: number;
      gap: number;
    }>
  >;
}): (() => void) | void {
  if (!input.liveVideoGridRef.current) {
    return;
  }

  const element = input.liveVideoGridRef.current;
  const updateGridSize = () => {
    const styles = window.getComputedStyle(element);
    const parsedGap = Number.parseFloat(
      styles.gap.length > 0
        ? styles.gap
        : styles.rowGap.length > 0
          ? styles.rowGap
          : String(LIVE_VIDEO_GRID_DEFAULT_GAP_PX),
    );

    input.setLiveVideoGridSize({
      width: element.clientWidth,
      height: element.clientHeight,
      gap: Number.isFinite(parsedGap) ? parsedGap : LIVE_VIDEO_GRID_DEFAULT_GAP_PX,
    });
  };

  updateGridSize();

  const observer = new ResizeObserver(() => {
    updateGridSize();
  });

  observer.observe(element);

  return () => observer.disconnect();
}

function runLiveMeetingAssistantDisplayNamesFromRoomEffect(input: {
  room: Room;
  presenceVersion: number;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
}): void {
  const nextAssistantNames: Record<string, string> = Object.fromEntries(
    Array.from(input.room.remoteParticipants.values()).flatMap((participant): [string, string][] => {
      if (!isMeetingAgentParticipant(participant)) {
        return [];
      }

      const displayName = getAssistantDisplayName(participant);

      return displayName.length > 0 && displayName !== LIVE_MEETING_PAGE_COPY.defaultAssistantDisplayName
        ? [[participant.identity, displayName]]
        : [];
    }),
  );

  if (Object.keys(nextAssistantNames).length === 0) {
    return;
  }

  input.setAssistantDisplayNamesByIdentity((current) => {
    const updates = Object.entries(nextAssistantNames).filter(([assistantIdentity, displayName]) => {
      const existingDisplayName = current[assistantIdentity];
      if (existingDisplayName === displayName) {
        return false;
      }
      if (
        existingDisplayName !== undefined &&
        existingDisplayName.length > 0 &&
        !isGenericAssistantSpeakerName(existingDisplayName) &&
        isGenericAssistantSpeakerName(displayName)
      ) {
        return false;
      }

      return true;
    });
    if (updates.length === 0) {
      return current;
    }

    return { ...current, ...Object.fromEntries(updates) };
  });
}

export function runLiveMeetingRoomRpcMethodRegistrationEffect(input: {
  room: Pick<Room, "remoteParticipants" | "registerRpcMethod" | "unregisterRpcMethod">;
  connectionState: ConnectionState;
  rpcMethod: string;
  meetingId: string | undefined;
  handleRpcInvocation: (invocation: { payload: string }) => Promise<unknown>;
}): (() => void) | void {
  if (input.connectionState !== ConnectionState.Connected) {
    return;
  }

  const handler = async (data: RpcInvocationData) => {
    if (!isTrustedMeetingAgentRpc({ room: input.room, data, meetingId: input.meetingId })) {
      return JSON.stringify({ status: "ignored" });
    }
    const result = await input.handleRpcInvocation({ payload: data.payload });

    return JSON.stringify(result);
  };

  try {
    input.room.unregisterRpcMethod(input.rpcMethod);
  } catch (error) {
    void describeCaughtFailure(error);
    // The method is only registered while this component owns the room.
  }
  input.room.registerRpcMethod(input.rpcMethod, handler);

  return () => {
    try {
      input.room.unregisterRpcMethod(input.rpcMethod);
    } catch (error) {
      void describeCaughtFailure(error);
      // Best-effort cleanup during room teardown.
    }
  };
}

export function runLiveMeetingCalendarOAuthMessageEffect(input: {
  meetingId: string;
  calendarOAuthPopupRef: { current: Window | null };
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setToolApprovalCards: Dispatch<SetStateAction<VoiceToolApprovalCardState[]>>;
  showToast: ReturnType<typeof useToast>["showToast"];
  refreshAgentContextAfterCalendarConnect: (connectInput: { provider: CalendarProvider | null }) => Promise<unknown>;
}): () => void {
  const {
    meetingId,
    calendarOAuthPopupRef,
    setIsToolApprovalPanelOpen,
    setToolApprovalCards,
    showToast,
    refreshAgentContextAfterCalendarConnect,
  } = input;

  function handleCalendarMessage(event: MessageEvent) {
    const apiOrigin = new URL(webEnv.NEXT_PUBLIC_API_BASE_URL).origin;
    if (event.origin !== apiOrigin) {
      return;
    }

    if (!isRecord(event.data)) {
      return;
    }
    const data = event.data;
    const messageType = typeof data.type === "string" ? data.type : undefined;
    const messageProvider = isCalendarProvider(data.provider) ? data.provider : undefined;
    if (messageType === "readymeet.calendar.connected") {
      calendarOAuthPopupRef.current = null;
      setIsToolApprovalPanelOpen(false);
      setToolApprovalCards((current) =>
        current.map((card) =>
          card.tool === "calendar" && (messageProvider === undefined || card.provider === messageProvider)
            ? {
                ...card,
                status: "connected",
                error: null,
              }
            : card,
        ),
      );
      const connectedProvider = messageProvider ?? "google_calendar";
      showToast({
        id: `calendar-connected:${meetingId}:${connectedProvider}`,
        title: LIVE_MEETING_PAGE_COPY.calendarConnectedTitle,
        message: buildCalendarConnectedToastMessage(connectedProvider),
        tone: "success",
      });
      void (async () => {
        try {
          await refreshAgentContextAfterCalendarConnect({ provider: messageProvider ?? null });
        } catch (error) {
          void describeCaughtFailure(error);
        }
      })();
    } else if (messageType === "readymeet.calendar.error") {
      calendarOAuthPopupRef.current = null;
      setToolApprovalCards((current) =>
        current.map((card) =>
          card.tool === "calendar" && (messageProvider === undefined || card.provider === messageProvider)
            ? {
                ...card,
                status: "error",
                error: LIVE_MEETING_PAGE_COPY.calendarAuthFailedCardError,
              }
            : card,
        ),
      );
      showToast({
        id: `calendar-error:${meetingId}:${messageProvider ?? "calendar"}`,
        title: LIVE_MEETING_PAGE_COPY.calendarConnectionFailedTitle,
        message: LIVE_MEETING_PAGE_COPY.calendarConnectionFailedMessage,
        tone: "warning",
      });
    }
  }

  window.addEventListener("message", handleCalendarMessage);

  return () => {
    window.removeEventListener("message", handleCalendarMessage);
  };
}

function useLiveMeetingAgentHelpPhaseLifecycle(input: {
  isSoloVoiceAvailable: boolean;
  isConversationModeActive: boolean;
  agentHelpPhase: AgentHelpPhase;
  isAssistantParticipantSpeaking: boolean;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
}): void {
  const {
    isSoloVoiceAvailable,
    isConversationModeActive,
    agentHelpPhase,
    isAssistantParticipantSpeaking,
    setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase,
  } = input;

  useEffect(() => {
    if (isSoloVoiceAvailable || !isConversationModeActive) {
      return;
    }
    setSyncedConversationModeActive(false);
    setSyncedAgentHelpOwnerParticipantIdentity(null);
    setSyncedAgentHelpPhase("idle");
  }, [
    isConversationModeActive,
    isSoloVoiceAvailable,
    setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase,
    setSyncedConversationModeActive,
  ]);

  useEffect(() => {
    if (agentHelpPhase === "thinking" && isAssistantParticipantSpeaking) {
      setSyncedAgentHelpPhase("speaking");
    }
  }, [agentHelpPhase, isAssistantParticipantSpeaking, setSyncedAgentHelpPhase]);

  useEffect(() => {
    if (agentHelpPhase !== "thinking") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setSyncedAgentHelpPhase("idle");
    }, AGENT_HELP_THINKING_TIMEOUT_MS);

    return () => window.clearTimeout(timeoutId);
  }, [agentHelpPhase, setSyncedAgentHelpPhase]);

  useEffect(() => {
    if (agentHelpPhase !== "speaking" || isAssistantParticipantSpeaking) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setSyncedAgentHelpPhase("idle");
    }, AGENT_HELP_SPEAKING_END_GRACE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [agentHelpPhase, isAssistantParticipantSpeaking, setSyncedAgentHelpPhase]);
}

function runLiveMeetingCloseToolApprovalPanelWhenEmptyEffect(input: {
  toolApprovalCardCount: number;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  if (input.toolApprovalCardCount === 0) {
    input.setIsToolApprovalPanelOpen(false);
  }
}

function runLiveMeetingTranscriptAutoScrollEffect(input: {
  shouldShowLiveTranscript: boolean;
  transcriptBottomRef: { current: HTMLDivElement | null };
  visibleTranscriptLines: VisibleTranscriptLine[];
}): (() => void) | void {
  if (!input.shouldShowLiveTranscript || !input.transcriptBottomRef.current) {
    return;
  }

  const frameId = window.requestAnimationFrame(() => {
    input.transcriptBottomRef.current?.scrollIntoView({
      block: "end",
    });
  });

  return () => {
    window.cancelAnimationFrame(frameId);
  };
}

function runLiveMeetingSeenTranscriptLineIdsEffect(input: {
  visibleTranscriptLines: VisibleTranscriptLine[];
  setSeenTranscriptLineIds: Dispatch<SetStateAction<Set<string> | null>>;
}): void {
  input.setSeenTranscriptLineIds((current) => {
    if (current === null) {
      return new Set(input.visibleTranscriptLines.map((line) => line.id));
    }

    const missingIds = input.visibleTranscriptLines.map((line) => line.id).filter((id) => !current.has(id));
    if (missingIds.length === 0) {
      return current;
    }

    return new Set([...current, ...missingIds]);
  });
}

function runLiveMeetingNotesRoutePrefetchEffect(input: {
  router: ReturnType<typeof useRouter>;
  meeting: Meeting;
  isGuestSession: boolean;
}): void {
  input.router.prefetch(getMeetingNotesPath({ meetingId: input.meeting.id, isGuestSession: input.isGuestSession }));
}

function runLiveMeetingRemoteMeetingEndRefEffect(input: {
  remoteMeetingEndRef: { current: (() => void) | null };
  onRemoteMeetingEnd: () => Promise<void>;
}): () => void {
  const { remoteMeetingEndRef, onRemoteMeetingEnd } = input;
  remoteMeetingEndRef.current = () => {
    void onRemoteMeetingEnd();
  };

  return () => {
    remoteMeetingEndRef.current = null;
  };
}

function runLiveMeetingEndedMeetingWhileDisconnectedPollEffect(input: {
  activeSession: AuthSession;
  meeting: Meeting;
  onLeaveEndedMeeting: (input: { remoteEnd: MeetingDetailPayload }) => Promise<void>;
}): (() => void) | void {
  const { activeSession, meeting, onLeaveEndedMeeting } = input;
  const lifecycle = { isCancelled: false };
  const timeoutId = window.setTimeout(() => {
    void (async () => {
      try {
        const detail = await getMeeting({ token: activeSession.token, meetingId: meeting.id });
        if (lifecycle.isCancelled || detail.meeting.status !== "ended") {
          return;
        }
        void onLeaveEndedMeeting({ remoteEnd: detail });
      } catch (error) {
        void describeCaughtFailure(error);
      }
    })();
  }, MEETING_ENDED_STATUS_POLL_MS);

  return () => {
    lifecycle.isCancelled = true;
    window.clearTimeout(timeoutId);
  };
}

function runLiveMeetingInitialAudioOutputDeviceEffect(input: {
  room: Room;
  initialAudioOutputDeviceId: string | undefined;
  clientDiagnosticContextRef: { current: { token: string; meetingId: string } | null };
}): void {
  if (!hasConfiguredMediaDeviceId(input.initialAudioOutputDeviceId)) {
    return;
  }

  const outputDeviceId = input.initialAudioOutputDeviceId;
  void (async () => {
    try {
      await input.room.switchActiveDevice("audiooutput", outputDeviceId);
      const diagnosticContext = input.clientDiagnosticContextRef.current;
      if (diagnosticContext) {
        sendMeetingClientDiagnostic({
          token: diagnosticContext.token,
          meetingId: diagnosticContext.meetingId,
          diagnostic: {
            event: "media-device-change",
            phase: "in-room",
            outcome: "succeeded",
            kind: "audio-output",
            selectedDevice: true,
          },
        });
      }
    } catch (nextError) {
      const diagnosticContext = input.clientDiagnosticContextRef.current;
      if (diagnosticContext) {
        sendMeetingClientDiagnostic({
          token: diagnosticContext.token,
          meetingId: diagnosticContext.meetingId,
          diagnostic: {
            event: "media-device-change",
            phase: "in-room",
            outcome: "failed",
            kind: "audio-output",
            selectedDevice: true,
            ...getClientDiagnosticError(nextError),
          },
        });
      }
    }
  })();
}

function runLiveMeetingScreenShareFullscreenSyncEffect(input: {
  screenShareStageShellRef: { current: HTMLDivElement | null };
  setIsScreenShareFullscreen: Dispatch<SetStateAction<boolean>>;
}): () => void {
  const syncFullscreenState = () => {
    const stageShell = input.screenShareStageShellRef.current;
    input.setIsScreenShareFullscreen(stageShell !== null && getCurrentFullscreenElement() === stageShell);
  };

  syncFullscreenState();
  document.addEventListener("fullscreenchange", syncFullscreenState);
  document.addEventListener("webkitfullscreenchange", syncFullscreenState);

  return () => {
    document.removeEventListener("fullscreenchange", syncFullscreenState);
    document.removeEventListener("webkitfullscreenchange", syncFullscreenState);
  };
}

function runLiveMeetingMediaDevicesEnumerationEffect(input: {
  setAudioInputDevices: Dispatch<SetStateAction<MediaDeviceInfo[]>>;
  setVideoInputDevices: Dispatch<SetStateAction<MediaDeviceInfo[]>>;
  setAudioDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
}): (() => void) | void {
  const lifecycle = { isCancelled: false };

  async function loadDevices() {
    if (typeof navigator.mediaDevices.enumerateDevices !== "function") {
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (lifecycle.isCancelled) {
        return;
      }

      const audios = devices.filter((device) => device.kind === "audioinput" && device.deviceId.length > 0);
      const videos = devices.filter((device) => device.kind === "videoinput" && device.deviceId.length > 0);
      input.setAudioInputDevices(audios);
      input.setVideoInputDevices(videos);
      input.setAudioDeviceId((current) => {
        if (audios.length === 0) {
          return current;
        }

        return current !== undefined && current.length > 0 && audios.some((device) => device.deviceId === current)
          ? current
          : audios[0]?.deviceId;
      });
      input.setVideoDeviceId((current) => {
        if (videos.length === 0) {
          return current;
        }

        return current !== undefined && current.length > 0 && videos.some((device) => device.deviceId === current)
          ? current
          : videos[0]?.deviceId;
      });
    } catch (error) {
      void describeCaughtFailure(error);
      // best-effort in case browser blocks enumerateDevices temporarily
    }
  }

  const mediaDevices = navigator.mediaDevices;
  const handleDeviceChange = () => {
    void loadDevices();
  };
  void loadDevices();
  if (typeof mediaDevices.addEventListener === "function") {
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
  }

  return () => {
    lifecycle.isCancelled = true;
    if (typeof mediaDevices.removeEventListener === "function") {
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    }
  };
}

function runLiveMeetingConfidentialityRealtimeSubscriptionEffect(input: {
  realtimeClient: ReturnType<typeof useRealtimeClient>["client"];
  meeting: Meeting;
  hasJoinedMeeting: boolean;
  isGuestSession: boolean;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  setMeeting: Dispatch<SetStateAction<Meeting | null>>;
}): (() => void) | void {
  const { realtimeClient } = input;
  if (realtimeClient === null) {
    return;
  }
  if (
    !shouldSubscribeToJoinedMeetingChannel({
      hasJoinedMeeting: input.hasJoinedMeeting,
      isGuestSession: input.isGuestSession,
    })
  ) {
    return;
  }

  const channel = realtimeClient.channels.get(
    `workspace:${input.meeting.workspaceId}:meeting:${input.meeting.id}:tasks`,
  );
  const subscription = { isSubscribed: false, isCancelled: false };
  const handleMessage = (message: { data?: unknown }) => {
    const parsed = meetingConfidentialityRealtimeEventSchema.safeParse(message.data);
    if (!parsed.success || parsed.data.meetingId !== input.meeting.id) {
      return;
    }
    const isConfidentialityRequired = parsed.data.isConfidential && parsed.data.confidentialitySource === "auto";
    input.setMeeting((current) =>
      current !== null && current.id === parsed.data.meetingId
        ? {
            ...current,
            isConfidential: parsed.data.isConfidential,
            confidentialitySource: parsed.data.confidentialitySource,
            /** @external meeting confidentiality wire field */
            confidentialityIsRequired: isConfidentialityRequired,
          }
        : current,
    );
  };

  const subscribe = async () => {
    try {
      if (
        !(await authorizeRealtimeSetup({
          refreshAuth: () => input.refreshRealtimeAuth("meeting-confidentiality"),
          isCancelled: () => subscription.isCancelled,
        }))
      ) {
        return;
      }
      await recoverFailedRealtimeChannel(channel);
      if (subscription.isCancelled) {
        return;
      }
      await channel.subscribe("meeting.confidentiality.changed", handleMessage);
      subscription.isSubscribed = !subscription.isCancelled;
    } catch (subscribeError) {
      if (!subscription.isCancelled) {
        if (!reportOptionalLiveServiceFailure({ error: subscribeError, feature: "realtime" })) {
          console.error("[readymeet:realtime] Confidentiality subscription failed.");
        }
      }
    }
  };

  void subscribe();

  return () => {
    subscription.isCancelled = true;
    if (subscription.isSubscribed) {
      channel.unsubscribe("meeting.confidentiality.changed", handleMessage);
    }
  };
}

async function runLiveMeetingTryEnableScreenShare(input: {
  room: Room;
  dataPresentationClaimsByIdentityRef: { current: Record<string, PresentationClaim> };
  setLocalPresentationIntent: (requestedAt: number) => Promise<void>;
  clearLocalPresentationIntent: () => Promise<void>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}): Promise<void> {
  const dataPresentationClaimsByIdentityRef = input.dataPresentationClaimsByIdentityRef;
  const activeRemotePresenter = getRemoteActiveScreenShareParticipant(input.room);
  if (activeRemotePresenter !== null) {
    const presenterName = formatLiveParticipantName({
      name: activeRemotePresenter.name,
      identity: activeRemotePresenter.identity,
    });
    input.setError(`${presenterName}${LIVE_MEETING_PAGE_COPY.screenShareRemotePresenterPrefix}`);

    return;
  }

  const localClaimRequestedAt = Date.now();
  await Promise.all([
    input.setLocalPresentationIntent(localClaimRequestedAt),
    requestPresentationClaimSync({ room: input.room }),
  ]);
  await delay(PRESENTATION_CLAIM_WAIT_MS);

  const claims: PresentationClaim[] = [
    {
      participantIdentity: input.room.localParticipant.identity,
      participantName: formatLiveParticipantName({
        name: input.room.localParticipant.name,
        identity: input.room.localParticipant.identity,
      }),
      requestedAt: localClaimRequestedAt,
    },
    ...Array.from(input.room.remoteParticipants.values())
      .filter((participant) => !isMeetingAgentParticipant(participant))
      .map((participant) => getParticipantPresentationClaim(participant))
      .filter((claim): claim is PresentationClaim => claim !== null),
    ...Object.values(dataPresentationClaimsByIdentityRef.current).filter((claim) =>
      isPresentationClaimFromCurrentRoom({ room: input.room, claim }),
    ),
  ];
  const winningClaim = chooseWinningPresentationClaim({
    claims: getFreshPresentationClaims({ claims }),
  });
  const remotePresenterAfterWait = getRemoteActiveScreenShareParticipant(input.room);

  if (
    remotePresenterAfterWait !== null ||
    (winningClaim !== null && winningClaim.participantIdentity !== input.room.localParticipant.identity)
  ) {
    await input.clearLocalPresentationIntent();
    const remotePresenterName =
      remotePresenterAfterWait !== null
        ? formatLiveParticipantName({
            name: remotePresenterAfterWait.name,
            identity: remotePresenterAfterWait.identity,
          })
        : "";
    const winningPresenterName =
      winningClaim !== null
        ? getPresentationClaimPresenterLabel(winningClaim.participantName)
        : LIVE_MEETING_PAGE_COPY.screenShareRemotePresenterStarting;
    input.setError(
      remotePresenterAfterWait !== null
        ? `${remotePresenterName}${LIVE_MEETING_PAGE_COPY.screenShareRemotePresenterPrefix}`
        : `${winningPresenterName}${LIVE_MEETING_PAGE_COPY.screenShareRemotePresenterStartingSuffix}`,
    );

    return;
  }

  input.setPinnedScreenShareTrackId(null);
  await input.room.localParticipant.setScreenShareEnabled(
    true,
    getScreenShareCaptureOptions(input.room.localParticipant),
    getScreenSharePublishDefaults(input.room.localParticipant),
  );
  await input.clearLocalPresentationIntent();
}

function runLiveMeetingRoomRevealEntranceEffect(input: {
  isReadyForEntrance: boolean;
  setIsRoomRevealed: Dispatch<SetStateAction<boolean>>;
  setIsControlsRevealed: Dispatch<SetStateAction<boolean>>;
  setIsAvatarRevealed: Dispatch<SetStateAction<boolean>>;
}): (() => void) | void {
  if (!input.isReadyForEntrance) {
    input.setIsRoomRevealed(false);
    input.setIsControlsRevealed(false);
    input.setIsAvatarRevealed(false);

    return;
  }

  const videoRevealTimeoutId = window.setTimeout(() => {
    input.setIsRoomRevealed(true);
  }, LIVE_ROOM_VIDEO_REVEAL_DELAY_MS);
  const controlsRevealTimeoutId = window.setTimeout(() => {
    input.setIsControlsRevealed(true);
  }, LIVE_ROOM_CONTROLS_REVEAL_DELAY_MS);
  const avatarRevealTimeoutId = window.setTimeout(() => {
    input.setIsAvatarRevealed(true);
  }, LIVE_ROOM_AVATAR_REVEAL_DELAY_MS);

  return () => {
    window.clearTimeout(videoRevealTimeoutId);
    window.clearTimeout(controlsRevealTimeoutId);
    window.clearTimeout(avatarRevealTimeoutId);
  };
}

function runLiveMeetingExitFullscreenWithoutScreenShareEffect(input: {
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
}): void {
  if (input.hasActiveScreenShare || !input.isScreenShareFullscreen) {
    return;
  }

  void (async () => {
    try {
      await exitCurrentFullscreen();
    } catch (error) {
      void describeCaughtFailure(error);
    }
  })();
}

function runLiveMeetingCloseMeetingPanelsOnPresentationEffect(input: {
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
  endMeetingFlow: EndMeetingFlowState | null;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  if ((input.hasActiveScreenShare && input.isScreenShareFullscreen) || input.endMeetingFlow) {
    input.setIsMeetingDetailsPanelOpen(false);
    input.setIsMeetingSettingsPanelOpen(false);
  }
}

function runLiveMeetingSyncPinnedScreenShareTrackEffect(input: {
  screenShareVisuals: ScreenShareVisual[];
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
}): void {
  if (input.screenShareVisuals.length === 0) {
    input.setPinnedScreenShareTrackId(null);

    return;
  }

  input.setPinnedScreenShareTrackId((current) => {
    if (current !== null && current.length > 0 && input.screenShareVisuals.some((track) => track.id === current)) {
      return current;
    }

    return input.screenShareVisuals[0]?.id ?? null;
  });
}

async function runLiveMeetingCopyJoiningInfo(input: {
  meeting: Meeting | null;
  liveRoomJoiningInfo: string;
  liveRoomJoiningInfoCopiedTimerRef: { current: number | null };
  setError: Dispatch<SetStateAction<string | null>>;
  setIsLiveRoomJoiningInfoCopied: Dispatch<SetStateAction<boolean>>;
  showToast: ReturnType<typeof useToast>["showToast"];
}): Promise<void> {
  if (!hasMeetingRecord(input.meeting) || input.liveRoomJoiningInfo.length === 0) {
    return;
  }

  const meeting = input.meeting;
  const joiningInfoText = `${input.liveRoomJoiningInfo}`;
  const copiedTimerRef = input.liveRoomJoiningInfoCopiedTimerRef;

  try {
    await navigator.clipboard.writeText(joiningInfoText);
    input.setError(null);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    input.setIsLiveRoomJoiningInfoCopied(true);
    copiedTimerRef.current = window.setTimeout(() => {
      input.setIsLiveRoomJoiningInfoCopied(false);
      copiedTimerRef.current = null;
    }, LIVE_ROOM_JOINING_INFO_COPIED_RESET_MS);
    input.showToast({
      id: `joining-info-copied:${meeting.id}`,
      title: LIVE_MEETING_PAGE_COPY.joiningInfoCopiedTitle,
      message: LIVE_MEETING_PAGE_COPY.joiningInfoCopiedMessage,
      tone: "success",
    });
  } catch (nextError) {
    input.setIsLiveRoomJoiningInfoCopied(false);
    const message = getErrorMessage({
      error: nextError,
      fallback: LIVE_MEETING_PAGE_COPY.joiningInfoCopyFailedFallback,
    });
    input.setError(message);
    input.showToast({
      id: `joining-info-copy-failed:${meeting.id}`,
      title: LIVE_MEETING_PAGE_COPY.joiningInfoCopyFailedTitle,
      message,
      tone: "warning",
    });
  }
}

function runLiveMeetingEscapeInterruptAssistantEffect(input: {
  room: Room | null;
  interruptAssistantSpeech: () => Promise<void>;
}): (() => void) | void {
  if (!input.room) {
    return;
  }

  const shouldIgnoreTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== "Escape" || shouldIgnoreTarget(event.target)) {
      return;
    }

    event.preventDefault();
    void input.interruptAssistantSpeech();
  };

  window.addEventListener("keydown", onKeyDown);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
  };
}

function runLiveMeetingEscapeKeyCloseEffect(input: { isOpen: boolean; onClose: () => void }): (() => void) | void {
  if (!input.isOpen) {
    return;
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      input.onClose();
    }
  };

  window.addEventListener("keydown", onKeyDown);

  return () => window.removeEventListener("keydown", onKeyDown);
}

function runLiveMeetingPointerOutsideCloseEffect(input: {
  isOpen: boolean;
  menuRef: { current: HTMLDivElement | null };
  onClose: () => void;
}): (() => void) | void {
  if (!input.isOpen) {
    return;
  }

  const onPointerDown = (event: PointerEvent) => {
    const menuRoot = input.menuRef.current;
    const target = event.target;
    if (menuRoot === null || !(target instanceof Node) || !menuRoot.contains(target)) {
      input.onClose();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      input.onClose();
    }
  };

  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("keydown", onKeyDown);

  return () => {
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("keydown", onKeyDown);
  };
}

function runLiveMeetingLoadLiveMeetingDetailEffect(input: {
  activeSession: AuthSession;
  meetingId: string;
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<AuthSession | null>;
  room: Room | null;
  setError: Dispatch<SetStateAction<string | null>>;
  setMeeting: Dispatch<SetStateAction<Meeting | null>>;
  setEndedMeetingHistoryVisibility: Dispatch<SetStateAction<EndedMeetingHistoryVisibility>>;
  setActiveHumanParticipants: Dispatch<
    SetStateAction<MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"]>
  >;
}): (() => void) | void {
  const lifecycle = { isCancelled: false };
  const signal =
    input.room?.state === ConnectionState.Connected ? AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS) : undefined;
  if (input.room?.state !== ConnectionState.Connected) {
    input.setError(null);
  }

  void (async () => {
    try {
      const liveDetail = await (async () => {
        try {
          return await getLiveMeeting({ token: input.activeSession.token, meetingId: input.meetingId, signal });
        } catch (nextError) {
          const nextSession = await input.refreshAuthAfterUnauthorized(nextError);
          if (!nextSession) {
            throw nextError;
          }

          return getLiveMeeting({ token: nextSession.token, meetingId: input.meetingId, signal });
        }
      })();

      if (lifecycle.isCancelled) {
        return;
      }

      input.setMeeting(liveDetail.meeting);
      input.setEndedMeetingHistoryVisibility(
        getEndedMeetingHistoryVisibility({ postMeetingDisposition: liveDetail.postMeetingDisposition }),
      );
      input.setActiveHumanParticipants(liveDetail.meetingRuntime.activeHumanParticipants);

      if (liveDetail.meeting.status === "ended") {
        input.setError(LIVE_MEETING_PAGE_COPY.meetingEndedUnavailable);
      }
    } catch (nextError) {
      if (
        input.room?.state === ConnectionState.Connected &&
        reportOptionalLiveServiceFailure({ error: nextError, feature: "realtime" })
      ) {
        return;
      }
      if (!lifecycle.isCancelled) {
        input.setError(
          getErrorMessage({
            error: nextError,
            fallback: LIVE_MEETING_PAGE_COPY.meetingEndedUnavailable,
          }),
        );
      }
    }
  })();

  return () => {
    lifecycle.isCancelled = true;
  };
}

function runLiveMeetingPresentationClaimRoomEffect(input: {
  room: Room;
  localPresentationClaimRef: { current: PresentationClaim | null };
  updateDataPresentationClaims: (
    update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>,
  ) => void;
}): () => void {
  const localPresentationClaimRef = input.localPresentationClaimRef;
  const dispose = attachPresentationClaimSync({
    room: input.room,
    options: {
      getLocalClaim: () => localPresentationClaimRef.current,
      onRemoteClaim: ({ identity, claim }) => {
        const participant = input.room.remoteParticipants.get(identity);
        if (participant === undefined || isMeetingAgentParticipant(participant)) {
          return;
        }
        input.updateDataPresentationClaims((current) =>
          claim !== null
            ? upsertPresentationClaim({ claimsByIdentity: current, claim })
            : removePresentationClaim({ claimsByIdentity: current, participantIdentity: identity }),
        );
      },
    },
  });

  return () => {
    dispose();
    localPresentationClaimRef.current = null;
    input.updateDataPresentationClaims(() => ({}));
  };
}

function getLiveMeetingCaptionsAriaLabel(input: {
  transcriptionState: TranscriptionState;
  isTranscriptVisible: boolean;
}): string {
  if (input.transcriptionState === "error") {
    return LIVE_MEETING_PAGE_COPY.captionsError;
  }

  return input.isTranscriptVisible ? LIVE_MEETING_PAGE_COPY.captionsHide : LIVE_MEETING_PAGE_COPY.captionsShow;
}

function getLiveMeetingCaptionsTitle(input: {
  transcriptionState: TranscriptionState;
  isTranscriptVisible: boolean;
}): string {
  if (input.transcriptionState === "starting") {
    return LIVE_MEETING_PAGE_COPY.captionsStarting;
  }
  if (input.transcriptionState === "error") {
    return LIVE_MEETING_PAGE_COPY.captionsError;
  }

  return input.isTranscriptVisible ? LIVE_MEETING_PAGE_COPY.captionsHide : LIVE_MEETING_PAGE_COPY.captionsShow;
}

function getLiveMeetingMicControlLabels(input: {
  isMicEnabled: boolean;
  microphonePermissionState: BrowserMediaPermissionState;
}): { ariaLabel: string; title: string } {
  if (input.isMicEnabled) {
    return { ariaLabel: LIVE_MEETING_PAGE_COPY.micMute, title: LIVE_MEETING_PAGE_COPY.micMute };
  }
  if (input.microphonePermissionState === "denied") {
    return {
      ariaLabel: LIVE_MEETING_PAGE_COPY.micRetryPermission,
      title: LIVE_MEETING_PAGE_COPY.micRetryTitle,
    };
  }
  if (input.microphonePermissionState === "prompt") {
    return { ariaLabel: LIVE_MEETING_PAGE_COPY.micAllow, title: LIVE_MEETING_PAGE_COPY.micAllow };
  }

  return { ariaLabel: LIVE_MEETING_PAGE_COPY.micUnmute, title: LIVE_MEETING_PAGE_COPY.micUnmute };
}

function getLiveMeetingCameraControlLabels(input: {
  isCamEnabled: boolean;
  cameraPermissionState: BrowserMediaPermissionState;
}): { ariaLabel: string; title: string } {
  if (input.isCamEnabled) {
    return { ariaLabel: LIVE_MEETING_PAGE_COPY.cameraOff, title: LIVE_MEETING_PAGE_COPY.cameraOff };
  }
  if (input.cameraPermissionState === "denied") {
    return {
      ariaLabel: LIVE_MEETING_PAGE_COPY.cameraRetryPermission,
      title: LIVE_MEETING_PAGE_COPY.cameraRetryTitle,
    };
  }
  if (input.cameraPermissionState === "prompt") {
    return { ariaLabel: LIVE_MEETING_PAGE_COPY.cameraAllow, title: LIVE_MEETING_PAGE_COPY.cameraAllow };
  }

  return { ariaLabel: LIVE_MEETING_PAGE_COPY.cameraOn, title: LIVE_MEETING_PAGE_COPY.cameraOn };
}

function getLiveMeetingScreenShareControlLabels(input: {
  localScreenShareVisual: ScreenShareVisual | null;
  canScreenShare: boolean;
  screenShareBlockerMessage: string | null;
}): { ariaLabel: string; title: string } {
  const ariaLabel = input.localScreenShareVisual
    ? LIVE_MEETING_PAGE_COPY.screenShareStop
    : LIVE_MEETING_PAGE_COPY.screenShareStart;

  if (!input.canScreenShare) {
    return { ariaLabel, title: LIVE_MEETING_PAGE_COPY.screenShareUnsupportedBrowser };
  }
  if (input.localScreenShareVisual) {
    return { ariaLabel, title: LIVE_MEETING_PAGE_COPY.screenShareStop };
  }
  if (input.screenShareBlockerMessage !== null && input.screenShareBlockerMessage.length > 0) {
    return { ariaLabel, title: input.screenShareBlockerMessage };
  }

  return { ariaLabel, title: LIVE_MEETING_PAGE_COPY.screenShareStartOrTab };
}

function renderLiveMeetingDetailsSettingsTriggerButtons(input: {
  isControlsRevealed: boolean;
  isMeetingDetailsPanelOpen: boolean;
  isMeetingSettingsPanelOpen: boolean;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        className={[
          "live-details-trigger",
          input.isControlsRevealed ? "is-revealed" : "",
          input.isMeetingDetailsPanelOpen ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          input.setIsPresencePanelOpen(false);
          input.setIsToolApprovalPanelOpen(false);
          input.setIsAmbientContextPanelOpen(false);
          input.setIsMeetingSettingsPanelOpen(false);
          input.setIsMeetingDetailsPanelOpen((isCurrentlyOpen) => !isCurrentlyOpen);
        }}
        onPointerUp={(event) => event.currentTarget.blur()}
        aria-label={LIVE_MEETING_PAGE_COPY.meetingDetailsButtonLabel}
        aria-haspopup="dialog"
        aria-expanded={input.isMeetingDetailsPanelOpen}
        aria-controls="live-meeting-details-panel"
        title={LIVE_MEETING_PAGE_COPY.meetingDetailsButtonLabel}
      >
        <InfoIcon />
      </button>
      <button
        type="button"
        className={[
          "live-settings-trigger",
          input.isControlsRevealed ? "is-revealed" : "",
          input.isMeetingSettingsPanelOpen ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          input.setIsPresencePanelOpen(false);
          input.setIsToolApprovalPanelOpen(false);
          input.setIsAmbientContextPanelOpen(false);
          input.setIsMeetingDetailsPanelOpen(false);
          input.setIsMeetingSettingsPanelOpen((isCurrentlyOpen) => !isCurrentlyOpen);
        }}
        onPointerUp={(event) => event.currentTarget.blur()}
        aria-label={LIVE_MEETING_PAGE_COPY.settingsButtonLabel}
        aria-haspopup="dialog"
        aria-expanded={input.isMeetingSettingsPanelOpen}
        aria-controls="live-meeting-settings-panel"
        title={LIVE_MEETING_PAGE_COPY.settingsButtonLabel}
      >
        <SettingsGearIcon />
      </button>
    </>
  );
}

function renderLiveMeetingAgentHelpVoiceControl(input: {
  isAgentHelpAvailable: boolean;
  isSoloVoiceAvailable: boolean;
  isAssistantParticipantSpeaking: boolean;
  isBusy: boolean;
  isAgentTurnBlockedByOther: boolean;
  voiceModeControlState: ReturnType<typeof getVoiceModeControlState>;
  voiceModePendingAction: VoiceModePendingAction | null;
  voiceModeTitle: string;
  isConversationModeActive: boolean;
  shouldShowAgentHelpTooltip: boolean;
  agentHelpTooltipText: string;
  toggleConversationMode: () => Promise<void>;
}): ReactNode {
  if (!input.isAgentHelpAvailable) {
    return null;
  }

  return (
    <span
      className={`live-agent-help-control live-solo-voice-control${input.isSoloVoiceAvailable ? "" : " is-hidden"}`}
      aria-hidden={!input.isSoloVoiceAvailable}
      inert={!input.isSoloVoiceAvailable}
    >
      <button
        type="button"
        className={`outline-button live-voice-mode-button${
          input.isAssistantParticipantSpeaking ? " is-agent-speaking" : ""
        }`}
        onClick={(event) => {
          event.currentTarget.blur();
          void input.toggleConversationMode();
        }}
        onPointerUp={(event) => {
          event.currentTarget.blur();
        }}
        disabled={
          !input.isSoloVoiceAvailable ||
          input.isBusy ||
          input.isAgentTurnBlockedByOther ||
          input.voiceModeControlState.disabled
        }
        aria-pressed={input.voiceModeControlState.pressed}
        aria-label={input.voiceModeControlState.ariaLabel}
        title={input.voiceModePendingAction !== null ? undefined : input.voiceModeTitle}
        data-voice-mode-state={input.voiceModePendingAction ?? (input.isConversationModeActive ? "active" : "inactive")}
      >
        <VoiceModeControlIcon active={input.isConversationModeActive} visible={input.isSoloVoiceAvailable} />
      </button>
      {input.shouldShowAgentHelpTooltip ? (
        <span className="live-agent-help-tooltip" role="tooltip">
          {input.agentHelpTooltipText}
        </span>
      ) : null}
    </span>
  );
}

function renderLiveMeetingScreenShareControlButton(input: {
  room: Room | null;
  isBusy: boolean;
  isScreenShareBusy: boolean;
  canScreenShare: boolean;
  localScreenShareVisual: ScreenShareVisual | null;
  screenShareBlockerMessage: string | null;
  toggleScreenShare: () => Promise<void>;
}): ReactNode {
  const screenShareLabels = getLiveMeetingScreenShareControlLabels({
    localScreenShareVisual: input.localScreenShareVisual,
    canScreenShare: input.canScreenShare,
    screenShareBlockerMessage: input.screenShareBlockerMessage,
  });

  return (
    <button
      type="button"
      className={`outline-button live-mobile-secondary-control${input.localScreenShareVisual ? " is-active" : ""}`}
      onClick={() => void input.toggleScreenShare()}
      onPointerUp={(event) => event.currentTarget.blur()}
      disabled={
        !input.room ||
        input.isBusy ||
        input.isScreenShareBusy ||
        !input.canScreenShare ||
        (!input.localScreenShareVisual &&
          input.screenShareBlockerMessage !== null &&
          input.screenShareBlockerMessage.length > 0)
      }
      aria-label={screenShareLabels.ariaLabel}
      title={screenShareLabels.title}
    >
      <ScreenShareIcon />
    </button>
  );
}

function renderLiveMeetingMicControlButton(input: {
  room: Room | null;
  isBusy: boolean;
  isMicEnabled: boolean;
  microphonePermissionState: BrowserMediaPermissionState;
  toggleMic: () => Promise<void>;
}): ReactNode {
  const micLabels = getLiveMeetingMicControlLabels({
    isMicEnabled: input.isMicEnabled,
    microphonePermissionState: input.microphonePermissionState,
  });

  return (
    <button
      type="button"
      className="outline-button"
      onClick={() => void input.toggleMic()}
      onPointerUp={(event) => event.currentTarget.blur()}
      disabled={isMeetingMicrophoneControlDisabled(input)}
      aria-label={micLabels.ariaLabel}
      title={micLabels.title}
    >
      <MicrophoneIcon isEnabled={input.isMicEnabled} />
    </button>
  );
}

function renderLiveMeetingCameraControlButton(input: {
  room: Room | null;
  isBusy: boolean;
  isCamEnabled: boolean;
  cameraPermissionState: BrowserMediaPermissionState;
  toggleCamera: () => Promise<void>;
}): ReactNode {
  const cameraLabels = getLiveMeetingCameraControlLabels({
    isCamEnabled: input.isCamEnabled,
    cameraPermissionState: input.cameraPermissionState,
  });

  return (
    <button
      type="button"
      className="outline-button"
      onClick={() => void input.toggleCamera()}
      onPointerUp={(event) => event.currentTarget.blur()}
      disabled={!input.room || input.isBusy}
      aria-label={cameraLabels.ariaLabel}
      title={cameraLabels.title}
    >
      <CameraIcon isEnabled={input.isCamEnabled} />
    </button>
  );
}

function renderLiveMeetingCaptionsControlButton(input: {
  isBusy: boolean;
  activeSession: AuthSession | null;
  transcriptionState: TranscriptionState;
  isTranscriptVisible: boolean;
  isCaptionsWaveActive: boolean;
  readSpeechLevel: () => number;
  setIsTranscriptVisible: Dispatch<SetStateAction<boolean>>;
}): ReactNode {
  const captionsAriaLabel = getLiveMeetingCaptionsAriaLabel({
    transcriptionState: input.transcriptionState,
    isTranscriptVisible: input.isTranscriptVisible,
  });
  const captionsTitle = getLiveMeetingCaptionsTitle({
    transcriptionState: input.transcriptionState,
    isTranscriptVisible: input.isTranscriptVisible,
  });

  return (
    <button
      type="button"
      className="outline-button live-mobile-secondary-control"
      data-live-transcript-toggle=""
      onClick={() => input.setIsTranscriptVisible((isCurrentlyVisible) => !isCurrentlyVisible)}
      onPointerUp={(event) => event.currentTarget.blur()}
      disabled={input.isBusy || !input.activeSession}
      aria-label={captionsAriaLabel}
      title={captionsTitle}
    >
      <AnimatedCaptionsWave
        isEnabled={
          input.transcriptionState === "on" ||
          input.transcriptionState === "starting" ||
          input.transcriptionState === "ready"
        }
        isActive={input.isCaptionsWaveActive}
        isError={input.transcriptionState === "error"}
        readLevel={input.readSpeechLevel}
      />
    </button>
  );
}

export function renderLiveMeetingTranscriptStrip(input: {
  shouldShowLiveTranscript: boolean;
  isEndMeetingFlowActive: boolean;
  visibleTranscriptLines: VisibleTranscriptLine[];
  seenTranscriptLineIds: Set<string> | null;
  transcriptionState: TranscriptionState;
  connectionState: ConnectionState;
  transcriptBottomRef: { current: HTMLDivElement | null };
}): ReactNode {
  if (
    !input.shouldShowLiveTranscript ||
    input.isEndMeetingFlowActive ||
    (input.transcriptionState === "off" && input.visibleTranscriptLines.length === 0)
  ) {
    return null;
  }

  return (
    <aside
      className="live-transcript-strip"
      aria-live="polite"
      aria-label={LIVE_MEETING_PAGE_COPY.liveTranscriptAriaLabel}
    >
      {input.visibleTranscriptLines.length !== 0 ? (
        input.visibleTranscriptLines.map((segment) => (
          <TranscriptRow
            key={segment.id}
            segment={segment}
            shouldAnimateOnMount={
              input.seenTranscriptLineIds !== null ? !input.seenTranscriptLineIds.has(segment.id) : false
            }
          />
        ))
      ) : (
        <p className="live-transcript-line muted">
          {input.transcriptionState === "starting"
            ? LIVE_MEETING_PAGE_COPY.transcriptStartingCaptions
            : input.connectionState === ConnectionState.Connected
              ? LIVE_MEETING_PAGE_COPY.transcriptListening
              : LIVE_MEETING_PAGE_COPY.transcriptConnecting}
        </p>
      )}
      <div ref={input.transcriptBottomRef} aria-hidden="true" />
    </aside>
  );
}

function renderLiveMeetingScreenShareLayout(input: {
  selectedScreenShareVisual: ScreenShareVisual;
  isScreenShareFullscreen: boolean;
  screenShareStageShellRef: { current: HTMLDivElement | null };
  participantVisuals: ParticipantVisual[];
  renderParticipantVisual: (participant: ParticipantVisual) => ReactNode;
  toggleScreenShareFullscreen: () => Promise<void>;
}): ReactNode {
  return (
    <div className="live-presentation-layout">
      <div
        ref={input.screenShareStageShellRef}
        className={`live-presentation-stage-shell${input.isScreenShareFullscreen ? " is-fullscreen" : ""}`}
      >
        <ScreenShareTile
          participantId={input.selectedScreenShareVisual.id}
          trackView={input.selectedScreenShareVisual.trackView}
          variant="stage"
        />
        <button
          type="button"
          className={`live-screen-share-stage-control${input.isScreenShareFullscreen ? " is-fullscreen" : ""}`}
          onClick={() => void input.toggleScreenShareFullscreen()}
          onPointerUp={(event) => event.currentTarget.blur()}
          aria-label={
            input.isScreenShareFullscreen
              ? LIVE_MEETING_PAGE_COPY.fullscreenExit
              : LIVE_MEETING_PAGE_COPY.fullscreenEnter
          }
          title={
            input.isScreenShareFullscreen
              ? LIVE_MEETING_PAGE_COPY.fullscreenExit
              : LIVE_MEETING_PAGE_COPY.fullscreenEnter
          }
        >
          <FullscreenToggleIcon isFullscreen={input.isScreenShareFullscreen} />
        </button>
      </div>
      {input.participantVisuals.length !== 0 ? (
        <div
          className="live-presentation-sidebar"
          style={{ "--live-presentation-sidebar-tile-count": String(input.participantVisuals.length) }}
        >
          {input.participantVisuals.map((participant) => (
            <div key={participant.id} className="live-presentation-sidebar-item">
              {input.renderParticipantVisual(participant)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function renderLiveMeetingVideoStage(input: {
  isRoomRevealed: boolean;
  tracks: TrackView[];
  shouldShowParticipantGrid: boolean;
  screenShareStageHostRef: (node: HTMLDivElement | null) => void;
  participantVisuals: ParticipantVisual[];
  liveVideoGridRef: { current: HTMLDivElement | null };
  liveVideoGridLayout: ReturnType<typeof getLiveVideoGridLayout> | null;
  liveVideoGridStyle: React.CSSProperties | undefined;
  renderParticipantVisual: (participant: ParticipantVisual) => ReactNode;
}): ReactNode {
  return (
    <section className={`live-stage${input.isRoomRevealed ? " is-revealed" : ""}`}>
      {input.tracks
        .filter((track) => track.kind === "audio" && !track.isLocal)
        .map((track) => (
          <AudioSink key={track.id} trackView={track} />
        ))}
      <div ref={input.screenShareStageHostRef} style={{ display: "contents" }} />
      {input.shouldShowParticipantGrid ? (
        <div
          ref={input.liveVideoGridRef}
          className={`live-video-grid${input.participantVisuals.length === LIVE_VIDEO_GRID_TWO_PARTICIPANT_COUNT ? " is-two-person" : input.liveVideoGridLayout?.isLastTileCentered === true ? " is-three-person" : ""}${input.isRoomRevealed ? " is-revealed" : ""}`}
          style={input.liveVideoGridStyle}
        >
          {input.participantVisuals.map((participant) => (
            <div
              key={participant.id}
              className={`live-video-grid-item ${participant.isLocal ? "is-local-participant" : "is-remote-participant"}`}
            >
              {input.renderParticipantVisual(participant)}
            </div>
          ))}
          {input.participantVisuals.length === 0 ? (
            <article className="video-tile live-video-tile live-video-placeholder" aria-hidden="true" />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function renderLiveMeetingAdmitGuestsMenu(input: {
  menuRef: { current: HTMLDivElement | null };
  waitingJoinRequestCount: number;
  isJoinRequestsOpen: boolean;
  setIsJoinRequestsOpen: Dispatch<SetStateAction<boolean>>;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  isJoinRequestsLoading: boolean;
  joinRequests: MeetingJoinRequest[];
  joinRequestDecisionId: string | null;
  onDecideJoinRequest: (input: { requestId: string; decision: "admit" | "deny" }) => void | Promise<void>;
}): ReactNode {
  return (
    <div className="live-admit-menu" ref={input.menuRef}>
      <button
        type="button"
        className="live-admit-trigger"
        onClick={() => {
          input.setIsPresencePanelOpen(false);
          input.setIsToolApprovalPanelOpen(false);
          input.setIsAmbientContextPanelOpen(false);
          input.setIsMeetingDetailsPanelOpen(false);
          input.setIsMeetingSettingsPanelOpen(false);
          input.setIsJoinRequestsOpen((isCurrentlyOpen) => !isCurrentlyOpen);
        }}
        aria-haspopup="dialog"
        aria-expanded={input.isJoinRequestsOpen}
        aria-label={getAdmitGuestsWaitingLabel(input.waitingJoinRequestCount)}
        title={getAdmitGuestsWaitingLabel(input.waitingJoinRequestCount)}
      >
        <span className="live-admit-trigger-icon-shell" aria-hidden="true">
          <AdmitGuestIcon />
        </span>
        <span className="live-admit-trigger-label">{getAdmitGuestsWaitingLabel(input.waitingJoinRequestCount)}</span>
      </button>
      {input.isJoinRequestsOpen ? (
        <div className="live-admit-popover" role="dialog" aria-label={LIVE_MEETING_PAGE_COPY.admitGuestsWaitingToJoin}>
          <div className="live-admit-popover-header">
            <h2>{LIVE_MEETING_PAGE_COPY.admitGuestsWaitingToJoin}</h2>
          </div>
          {input.isJoinRequestsLoading && input.joinRequests.length === 0 ? (
            <p className="workspace-loading-status" role="status">
              {LIVE_MEETING_PAGE_COPY.admitGuestsCheckingRequests}
            </p>
          ) : null}
          <div className="live-admit-request-list">
            {input.joinRequests.map((request) => (
              <div className="live-admit-request-row" key={request.id}>
                <span className="live-admit-avatar">{request.displayName[0]?.toUpperCase()}</span>
                <div className="live-admit-request-copy">
                  <strong>{request.displayName}</strong>
                  <small>{LIVE_MEETING_PAGE_COPY.admitGuestsGuestLabel}</small>
                </div>
                <div className="live-admit-actions">
                  <button
                    type="button"
                    onClick={() => void input.onDecideJoinRequest({ requestId: request.id, decision: "admit" })}
                    disabled={input.joinRequestDecisionId === request.id}
                  >
                    {LIVE_MEETING_PAGE_COPY.admitGuestAction}
                  </button>
                  <button
                    type="button"
                    onClick={() => void input.onDecideJoinRequest({ requestId: request.id, decision: "deny" })}
                    disabled={input.joinRequestDecisionId === request.id}
                  >
                    {LIVE_MEETING_PAGE_COPY.denyGuestAction}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function renderLiveMeetingTopActionRow(input: {
  isAvatarRevealed: boolean;
  admitGuestsMenu: ReactNode;
  displayName: string | undefined;
  email: string | undefined;
  avatarUrl: string | null | undefined;
  participantCount: number;
  onUserAvatarBadgeClick: () => void;
}): ReactNode {
  return (
    <div className={`live-top-action-row${input.isAvatarRevealed ? " is-revealed" : ""}`}>
      {input.admitGuestsMenu}
      <UserAvatarBadge
        displayName={input.displayName}
        email={input.email}
        avatarUrl={input.avatarUrl}
        onClick={input.onUserAvatarBadgeClick}
        participantCount={input.participantCount}
      />
    </div>
  );
}

function renderLiveMeetingEndMeetingAnalysisOverlay(input: {
  isEndMeetingFlowActive: boolean;
  endMeetingFlow: EndMeetingFlowState | null;
  endMeetingFlowNow: number;
  isEndMeetingOverlayExiting: boolean;
}): ReactNode {
  if (!input.isEndMeetingFlowActive || input.endMeetingFlow === null) {
    return null;
  }

  return (
    <EndMeetingAnalysisOverlay
      flow={input.endMeetingFlow}
      now={input.endMeetingFlowNow}
      isExiting={input.isEndMeetingOverlayExiting}
    />
  );
}

function renderLiveMeetingLiveRoomInfo(input: {
  shouldShowLiveRoomInfo: boolean;
  isControlsRevealed: boolean;
  liveRoomClock: string;
}): ReactNode {
  if (!input.shouldShowLiveRoomInfo) {
    return null;
  }

  return (
    <div className={["live-room-info", input.isControlsRevealed ? "is-revealed" : ""].filter(Boolean).join(" ")}>
      <span className="live-room-info-time">{input.liveRoomClock}</span>
    </div>
  );
}

function renderLiveMeetingInlineError(input: {
  error: string | null;
  isEndMeetingFlowActive: boolean;
  endedMeetingNotesPath: string | null;
}): ReactNode {
  if (input.error === null || input.error.length === 0 || input.isEndMeetingFlowActive) {
    return null;
  }

  return (
    <p className="muted live-error-inline">
      {input.error}
      {input.endedMeetingNotesPath !== null ? (
        <>
          {" "}
          <Link className="live-error-inline-link" href={input.endedMeetingNotesPath}>
            {LIVE_MEETING_PAGE_COPY.openMeetingNotes}
          </Link>
        </>
      ) : null}
    </p>
  );
}

function renderLiveMeetingInRoomInviteExperience(input: {
  shouldShowInviteExperience: boolean;
  meetingId: string;
  joinUrl: string;
  token: string;
  senderName: string;
  senderEmail: string;
  isInviteExperienceVisible: boolean;
}): ReactNode {
  if (!input.shouldShowInviteExperience) {
    return null;
  }

  return (
    <MeetingInviteExperience
      meetingId={input.meetingId}
      joinUrl={input.joinUrl}
      token={input.token}
      senderName={input.senderName}
      senderEmail={input.senderEmail}
      isVisible={input.isInviteExperienceVisible}
    />
  );
}

type LiveMeetingFeatureHostRef = (node: HTMLDivElement | null) => void;

type LiveMeetingControlsBarInput = {
  isControlsRevealed: boolean;
  isBusy: boolean;
  room: Room | null;
  isMicEnabled: boolean;
  microphonePermissionState: BrowserMediaPermissionState;
  toggleMic: () => Promise<void>;
  isCamEnabled: boolean;
  cameraPermissionState: BrowserMediaPermissionState;
  toggleCamera: () => Promise<void>;
  isGuestSession: boolean;
  meeting: Meeting | null;
  endMeetingMenuRef: { current: HTMLDivElement | null };
  isMeetingOrganizer: boolean;
  isEndMeetingMenuOpen: boolean;
  isEndMeetingFlowActive: boolean;
  hasJoinedMeeting: boolean;
  setIsEndMeetingMenuOpen: Dispatch<SetStateAction<boolean>>;
  onEndMeetingLeave: () => void;
  onEndMeetingEndForAll: () => void;
  agentGlowHostRef: LiveMeetingFeatureHostRef;
  captionsHostRef: LiveMeetingFeatureHostRef;
  screenShareHostRef: LiveMeetingFeatureHostRef;
  agentHelpHostRef: LiveMeetingFeatureHostRef;
};

function renderLiveMeetingControlsBar(input: LiveMeetingControlsBarInput): ReactNode {
  return (
    <footer className={`live-controls-bar${input.isControlsRevealed ? " is-revealed" : ""}`}>
      <div ref={input.agentGlowHostRef} style={{ display: "contents" }} />
      <div ref={input.captionsHostRef} style={{ display: "contents" }} />
      <div ref={input.screenShareHostRef} style={{ display: "contents" }} />
      {renderLiveMeetingMicControlButton({
        room: input.room,
        isBusy: input.isBusy,
        isMicEnabled: input.isMicEnabled,
        microphonePermissionState: input.microphonePermissionState,
        toggleMic: input.toggleMic,
      })}
      <div ref={input.agentHelpHostRef} style={{ display: "contents" }} />
      {renderLiveMeetingCameraControlButton({
        room: input.room,
        isBusy: input.isBusy,
        isCamEnabled: input.isCamEnabled,
        cameraPermissionState: input.cameraPermissionState,
        toggleCamera: input.toggleCamera,
      })}
      <div className="live-end-meeting-menu" ref={input.endMeetingMenuRef}>
        <MeetingEndControls
          isOrganizer={input.isMeetingOrganizer}
          isOpen={input.isEndMeetingMenuOpen}
          isLeaving={input.isEndMeetingFlowActive}
          isJoining={input.isBusy ? !input.hasJoinedMeeting : false}
          onToggleMenu={() => input.setIsEndMeetingMenuOpen((isCurrentlyOpen) => !isCurrentlyOpen)}
          onLeave={input.onEndMeetingLeave}
          onEndForAll={input.onEndMeetingEndForAll}
        >
          <PhoneDownIcon />
        </MeetingEndControls>
      </div>
    </footer>
  );
}

function renderLiveMeetingInRoomChromeWhenMeetingNotEnding(input: {
  isEndMeetingFlowActive: boolean;
  children: ReactNode;
}): ReactNode {
  if (input.isEndMeetingFlowActive) {
    return null;
  }

  return input.children;
}

function renderLiveMeetingTranscriptionBridgeWhenRoom(input: {
  room: Room | null;
  onLines: (lines: LiveTranscriptLine[]) => void;
}): ReactNode {
  if (!hasLiveKitRoom(input.room)) {
    return null;
  }

  return <LiveKitTranscriptionBridge room={input.room} onLines={input.onLines} />;
}

function renderLiveMeetingDetailsSettingsTriggerButtonsWhenChrome(input: {
  shouldShowLiveMeetingChrome: boolean;
  isControlsRevealed: boolean;
  isMeetingDetailsPanelOpen: boolean;
  isMeetingSettingsPanelOpen: boolean;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
}): ReactNode {
  if (!input.shouldShowLiveMeetingChrome) {
    return null;
  }

  return renderLiveMeetingDetailsSettingsTriggerButtons({
    isControlsRevealed: input.isControlsRevealed,
    isMeetingDetailsPanelOpen: input.isMeetingDetailsPanelOpen,
    isMeetingSettingsPanelOpen: input.isMeetingSettingsPanelOpen,
    setIsPresencePanelOpen: input.setIsPresencePanelOpen,
    setIsToolApprovalPanelOpen: input.setIsToolApprovalPanelOpen,
    setIsAmbientContextPanelOpen: input.setIsAmbientContextPanelOpen,
    setIsMeetingDetailsPanelOpen: input.setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen: input.setIsMeetingSettingsPanelOpen,
  });
}

function renderLiveMeetingInRoomInviteExperienceWhenEligible(input: {
  shouldShowInRoomInviteExperience: boolean;
  meeting: Meeting | null;
  activeSession: AuthSession | null;
  liveRoomJoinUrl: string;
  isInviteExperienceVisible: boolean;
}): ReactNode {
  if (
    !input.shouldShowInRoomInviteExperience ||
    !hasMeetingRecord(input.meeting) ||
    !hasAuthSession(input.activeSession)
  ) {
    return null;
  }

  return renderLiveMeetingInRoomInviteExperience({
    shouldShowInviteExperience: true,
    meetingId: input.meeting.id,
    joinUrl: input.liveRoomJoinUrl,
    token: input.activeSession.token,
    senderName: input.activeSession.user.displayName,
    senderEmail: input.activeSession.user.email,
    isInviteExperienceVisible: input.isInviteExperienceVisible,
  });
}

function renderLiveMeetingControlsBarWhenVisible(input: {
  meeting: Meeting | null;
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
  isEndMeetingFlowActive: boolean;
  controlsBar: LiveMeetingControlsBarInput;
}): ReactNode {
  if (
    !shouldShowLiveMeetingInRoomControlsBar({
      meeting: input.meeting,
      hasActiveScreenShare: input.hasActiveScreenShare,
      isScreenShareFullscreen: input.isScreenShareFullscreen,
      isEndMeetingFlowActive: input.isEndMeetingFlowActive,
    })
  ) {
    return null;
  }

  return renderLiveMeetingControlsBar(input.controlsBar);
}

function shouldShowLiveMeetingInRoomDetailsSettingsPanels(input: {
  meeting: Meeting | null;
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
}): boolean {
  return hasMeetingRecord(input.meeting) && !(input.hasActiveScreenShare && input.isScreenShareFullscreen);
}

function shouldShowLiveMeetingInRoomInviteExperience(input: {
  meeting: Meeting | null;
  activeSession: AuthSession | null;
  liveRoomJoinUrl: string;
}): boolean {
  return (
    hasMeetingRecord(input.meeting) &&
    hasAuthSession(input.activeSession) &&
    input.activeSession.user.source !== "guest" &&
    input.liveRoomJoinUrl.length > 0
  );
}

function getLiveMeetingInviteExperienceVisible(input: {
  shouldShowLiveMeetingChrome: boolean;
  isControlsRevealed: boolean;
  hasJoinedMeeting: boolean;
  isPresencePanelOpen: boolean;
  isMeetingDetailsPanelOpen: boolean;
  isMeetingSettingsPanelOpen: boolean;
  isToolApprovalPanelOpen: boolean;
  isAmbientContextPanelOpen: boolean;
  isLinearActionPanelOpen: boolean;
}): boolean {
  return (
    input.shouldShowLiveMeetingChrome &&
    input.isControlsRevealed &&
    input.hasJoinedMeeting &&
    !input.isPresencePanelOpen &&
    !input.isMeetingDetailsPanelOpen &&
    !input.isMeetingSettingsPanelOpen &&
    !input.isToolApprovalPanelOpen &&
    !input.isAmbientContextPanelOpen &&
    !input.isLinearActionPanelOpen
  );
}

function canConfirmLiveMeetingLinearAction(input: {
  linearActionPanelState: LinearActionPanelState | null;
  sessionUserId: string | undefined;
}): boolean {
  return (
    input.linearActionPanelState === null ||
    input.linearActionPanelState.requestingUserId === null ||
    input.linearActionPanelState.requestingUserId.length === 0 ||
    input.sessionUserId === input.linearActionPanelState.requestingUserId
  );
}

function getLiveMeetingShouldShowChrome(input: {
  meeting: Meeting | null;
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
  isEndMeetingFlowActive: boolean;
}): boolean {
  return (
    hasMeetingRecord(input.meeting) &&
    !(input.hasActiveScreenShare && input.isScreenShareFullscreen) &&
    !input.isEndMeetingFlowActive
  );
}

function isLiveMeetingReadyForRoomEntrance(input: {
  meeting: Meeting | null;
  room: Room | null;
  connectionState: ConnectionState;
  participantVisualCount: number;
}): boolean {
  return (
    hasMeetingRecord(input.meeting) &&
    hasLiveKitRoom(input.room) &&
    input.connectionState === ConnectionState.Connected &&
    input.participantVisualCount !== 0
  );
}

function isLiveMeetingAgentHelpTurnOwner(input: {
  room: Room | null;
  agentHelpOwnerParticipantIdentity: string | null;
}): boolean {
  return (
    hasLiveKitRoom(input.room) &&
    input.agentHelpOwnerParticipantIdentity !== null &&
    input.agentHelpOwnerParticipantIdentity.length > 0 &&
    input.room.localParticipant.identity === input.agentHelpOwnerParticipantIdentity
  );
}

function isLiveMeetingHost(input: { meeting: Meeting | null; activeSession: AuthSession | null }): boolean {
  return (
    hasMeetingRecord(input.meeting) &&
    hasAuthSession(input.activeSession) &&
    input.activeSession.user.source !== "guest" &&
    input.activeSession.user.id === input.meeting.createdByUserId
  );
}

function canLiveMeetingCheckJoinRequests(input: {
  meeting: Meeting | null;
  activeSession: AuthSession | null;
}): boolean {
  return (
    hasMeetingRecord(input.meeting) &&
    hasAuthSession(input.activeSession) &&
    input.activeSession.user.source !== "guest"
  );
}

function getLiveMeetingClientDiagnosticContext(input: {
  activeSession: AuthSession | null;
  meeting: Meeting | null;
}): { token: string; meetingId: string } | null {
  if (!hasAuthSession(input.activeSession) || !hasMeetingRecord(input.meeting)) {
    return null;
  }

  return { token: input.activeSession.token, meetingId: input.meeting.id };
}

function getLiveMeetingPrivateDetailsToken(input: {
  isGuestSession: boolean;
  activeSession: AuthSession | null;
}): string | undefined {
  if (input.isGuestSession) {
    return undefined;
  }

  return input.activeSession?.token;
}

function isLiveMeetingCaptionsWaveActive(input: {
  transcriptionState: TranscriptionState;
  isCaptionSpeechActive: boolean;
}): boolean {
  return (
    input.transcriptionState !== "error" && (input.transcriptionState === "starting" || input.isCaptionSpeechActive)
  );
}

function isLiveMeetingAgentIntroMeeting(meeting: Meeting | null): boolean {
  return meeting?.kind === "agent_intro";
}

function shouldShowLiveMeetingAgentHelpTooltip(input: {
  isSoloVoiceAvailable: boolean;
  isAgentHelpTooltipDismissed: boolean;
  isAgentIntroMeeting: boolean;
}): boolean {
  return input.isSoloVoiceAvailable && !input.isAgentHelpTooltipDismissed && input.isAgentIntroMeeting;
}

function shouldShowLiveMeetingLiveRoomInfo(input: {
  shouldShowLiveMeetingChrome: boolean;
  liveRoomClock: string;
}): boolean {
  return input.shouldShowLiveMeetingChrome && input.liveRoomClock.length > 0;
}

function isLiveMeetingJoinedWorkspaceSessionEnabled(input: {
  joinedWorkspaceToSync: string | null;
  hasJoinedMeeting: boolean;
  endMeetingFlow: EndMeetingFlowState | null;
}): boolean {
  return Boolean(input.joinedWorkspaceToSync) && input.hasJoinedMeeting && input.endMeetingFlow === null;
}

function isLiveMeetingEndMeetingFlowActive(endMeetingFlow: EndMeetingFlowState | null): boolean {
  return endMeetingFlow !== null;
}

function getLiveMeetingMeetingScopedSideEffectKey(input: {
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  hasJoinedMeeting: boolean;
}): string {
  return `${input.activeSession?.user.id ?? ""}:${input.meeting?.id ?? ""}:${input.hasJoinedMeeting}`;
}

function getLiveMeetingActiveSession(input: {
  refreshedSession: AuthSession | null;
  session: AuthSession | null;
}): AuthSession | null {
  return input.refreshedSession ?? input.session;
}

function getLiveMeetingLiveRoomCallIn(meeting: Meeting | null): LiveMeetingCallInInfo | null {
  return meeting?.meetingLink?.callIn ?? null;
}

function buildLiveMeetingMemoryParticipantKey(input: { room: Room | null }): string {
  return [...(input.room?.remoteParticipants.keys() ?? [])].sort().join(",");
}

function getLiveMeetingMediaDeviceIdOrEmpty(deviceId: string | undefined): string {
  return deviceId ?? "";
}

function resolveLiveMeetingInitialBackgroundBlurEnabled(isInitialBackgroundBlurEnabled: boolean | undefined): boolean {
  return isInitialBackgroundBlurEnabled ?? false;
}

function getLiveMeetingLocalParticipantIdentity(room: Room | null): string | null {
  return room?.localParticipant.identity ?? null;
}

function getLiveMeetingSessionUserId(session: AuthSession | null | undefined): string | undefined {
  return session?.user.id;
}

function getLiveMeetingAuthSessionToken(session: AuthSession | null | undefined): string | undefined {
  return session?.token;
}

function getLiveMeetingRecordId(meeting: Meeting | null): string | undefined {
  return meeting?.id;
}

function getLiveMeetingWorkspaceId(meeting: Meeting | null): string | undefined {
  return meeting?.workspaceId;
}

function getLiveMeetingAuthSessionUserSource(session: AuthSession | null): AuthSession["user"]["source"] | undefined {
  return session?.user.source;
}

function getLiveMeetingWebSearchPanelRevisionDeps(state: WebSearchPanelState | null): {
  findallId: string | null | undefined;
  researchRunId: string | null | undefined;
  searchId: string | null | undefined;
  sessionId: string | null | undefined;
  status: WebSearchPanelState["status"] | undefined;
  updatedAt: number | undefined;
  meetingId: string | null | undefined;
  query: string | undefined;
} {
  return {
    findallId: state?.findallId,
    researchRunId: state?.researchRunId,
    searchId: state?.searchId,
    sessionId: state?.sessionId,
    status: state?.status,
    updatedAt: state?.updatedAt,
    meetingId: state?.meetingId,
    query: state?.query,
  };
}

function getLiveMeetingSessionUserDisplayProfile(session: AuthSession | null | undefined): {
  displayName: string | undefined;
  email: string | undefined;
  avatarUrl: string | undefined;
} {
  return {
    displayName: session?.user.displayName,
    email: session?.user.email,
    avatarUrl: session?.user.avatarUrl ?? undefined,
  };
}

function buildLiveMeetingPeopleMemoryArrivalsKey(input: {
  memoryParticipantKey: string;
  joinRequests: MeetingJoinRequest[];
}): string {
  return `${input.memoryParticipantKey}:${input.joinRequests
    .map((request) => request.id)
    .sort()
    .join(",")}`;
}

function isLiveMeetingAmbientContextRealtimeSubscriptionEnabled(input: {
  isAmbientContextEnabled: boolean;
  hasJoinedMeeting: boolean;
}): boolean {
  return input.isAmbientContextEnabled && input.hasJoinedMeeting;
}

function isLiveMeetingAmbientContextRecoveryEnabled(input: {
  isAmbientContextEnabled: boolean;
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  hasJoinedMeeting: boolean;
}): boolean {
  return (
    input.isAmbientContextEnabled &&
    hasAuthSession(input.activeSession) &&
    hasMeetingRecord(input.meeting) &&
    input.hasJoinedMeeting
  );
}

function buildLiveMeetingAmbientPrivateDetailsLoader(input: {
  privateDetailsToken: string | undefined;
  meetingIdForPrivateDetails: string | undefined;
}): ((item: MeetingAmbientContextItem) => ReturnType<typeof getMeetingAmbientContextPrivateDetails>) | undefined {
  if (
    input.privateDetailsToken === undefined ||
    input.meetingIdForPrivateDetails === undefined ||
    input.privateDetailsToken.length === 0
  ) {
    return undefined;
  }

  const privateDetailsToken = input.privateDetailsToken;
  const meetingIdForPrivateDetails = input.meetingIdForPrivateDetails;

  return (item: MeetingAmbientContextItem) =>
    getMeetingAmbientContextPrivateDetails({
      token: privateDetailsToken,
      meetingId: meetingIdForPrivateDetails,
      itemId: item.id,
    });
}

function getLiveMeetingSharedAmbientPrivateDetailsLoader(input: {
  isAmbientContextEnabled: boolean;
  hasJoinedMeeting: boolean;
  loadAmbientPrivateDetails:
    | ((item: MeetingAmbientContextItem) => ReturnType<typeof getMeetingAmbientContextPrivateDetails>)
    | undefined;
}): ((item: MeetingAmbientContextItem) => ReturnType<typeof getMeetingAmbientContextPrivateDetails>) | undefined {
  return input.isAmbientContextEnabled && input.hasJoinedMeeting ? input.loadAmbientPrivateDetails : undefined;
}

function isLiveMeetingPeopleMemoryEnabled(input: {
  privateDetailsToken: string | undefined;
  hasJoinedMeeting: boolean;
}): boolean {
  return input.privateDetailsToken !== undefined && input.hasJoinedMeeting;
}

function getLiveMeetingLocalPresentationClaim(input: {
  room: Room | null;
  freshStartingPresentationClaims: PresentationClaim[];
}): PresentationClaim | null {
  const { room } = input;
  if (!hasLiveKitRoom(room)) {
    return null;
  }

  return (
    input.freshStartingPresentationClaims.find(
      (claim) => claim.participantIdentity === room.localParticipant.identity,
    ) ?? null
  );
}

function getLiveMeetingCollaborationSideEffectsEnabled(input: {
  shouldShowLiveMeetingChrome: boolean;
  isAvatarRevealed: boolean;
  canModerateJoinRequests: boolean;
}): { isMemoryArrivalEnabled: boolean; isWaitingRoomMenuEnabled: boolean } {
  const shouldEnableAvatarChromeFeatures = input.shouldShowLiveMeetingChrome && input.isAvatarRevealed;

  return {
    isMemoryArrivalEnabled: shouldEnableAvatarChromeFeatures,
    isWaitingRoomMenuEnabled: shouldEnableAvatarChromeFeatures && input.canModerateJoinRequests,
  };
}

function shouldRunLiveMeetingParticipantTileTransition(input: {
  isMeetingHost: boolean;
  isRoomRevealed: boolean;
  connectionState: ConnectionState;
  hasActiveScreenShare: boolean;
}): boolean {
  return (
    input.isMeetingHost &&
    input.isRoomRevealed &&
    input.connectionState === ConnectionState.Connected &&
    !input.hasActiveScreenShare
  );
}

function getLiveMeetingLiveVideoGridStyle(input: {
  hasActiveScreenShare: boolean;
  multiParticipantGridStyle: React.CSSProperties | undefined;
}): React.CSSProperties | undefined {
  if (input.hasActiveScreenShare) {
    return undefined;
  }

  return input.multiParticipantGridStyle;
}

function getLiveMeetingShellClassName(input: {
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
  isEndMeetingFlowActive: boolean;
}): string {
  const screenShareClass =
    input.hasActiveScreenShare && input.isScreenShareFullscreen ? " is-screen-share-fullscreen" : "";
  const endingClass = input.isEndMeetingFlowActive ? " is-ending-meeting" : "";

  return `live-shell${screenShareClass}${endingClass}`;
}

function shouldShowLiveMeetingAdmitGuestsTopRow(input: {
  shouldShowLiveMeetingChrome: boolean;
  canModerateJoinRequests: boolean;
  waitingJoinRequestCount: number;
}): boolean {
  return input.shouldShowLiveMeetingChrome && input.canModerateJoinRequests && input.waitingJoinRequestCount > 0;
}

function renderLiveMeetingAdmitGuestsTopRowMenu(input: {
  shouldShowLiveMeetingChrome: boolean;
  canModerateJoinRequests: boolean;
  waitingJoinRequestCount: number;
  menuRef: { current: HTMLDivElement | null };
  isJoinRequestsOpen: boolean;
  setIsJoinRequestsOpen: Dispatch<SetStateAction<boolean>>;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  isJoinRequestsLoading: boolean;
  joinRequests: MeetingJoinRequest[];
  joinRequestDecisionId: string | null;
  onDecideJoinRequest: (input: { requestId: string; decision: "admit" | "deny" }) => void | Promise<void>;
}): ReactNode {
  if (
    !shouldShowLiveMeetingAdmitGuestsTopRow({
      shouldShowLiveMeetingChrome: input.shouldShowLiveMeetingChrome,
      canModerateJoinRequests: input.canModerateJoinRequests,
      waitingJoinRequestCount: input.waitingJoinRequestCount,
    })
  ) {
    return null;
  }

  return renderLiveMeetingAdmitGuestsMenu({
    menuRef: input.menuRef,
    waitingJoinRequestCount: input.waitingJoinRequestCount,
    isJoinRequestsOpen: input.isJoinRequestsOpen,
    setIsJoinRequestsOpen: input.setIsJoinRequestsOpen,
    setIsPresencePanelOpen: input.setIsPresencePanelOpen,
    setIsToolApprovalPanelOpen: input.setIsToolApprovalPanelOpen,
    setIsAmbientContextPanelOpen: input.setIsAmbientContextPanelOpen,
    setIsMeetingDetailsPanelOpen: input.setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen: input.setIsMeetingSettingsPanelOpen,
    isJoinRequestsLoading: input.isJoinRequestsLoading,
    joinRequests: input.joinRequests,
    joinRequestDecisionId: input.joinRequestDecisionId,
    onDecideJoinRequest: ({ requestId, decision }) => input.onDecideJoinRequest({ requestId, decision }),
  });
}

function shouldShowLiveMeetingInRoomControlsBar(input: {
  meeting: Meeting | null;
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
  isEndMeetingFlowActive: boolean;
}): boolean {
  return (
    input.meeting !== null &&
    !(input.hasActiveScreenShare && input.isScreenShareFullscreen) &&
    !input.isEndMeetingFlowActive
  );
}

function isLiveMeetingGuestSession(activeSession: AuthSession | null): boolean {
  return activeSession?.user.source === "guest";
}

function isLiveMeetingAgentTurnBlockedByOther(input: {
  agentHelpPhase: AgentHelpPhase;
  isAgentHelpTurnOwner: boolean;
}): boolean {
  return input.agentHelpPhase !== "idle" && !input.isAgentHelpTurnOwner;
}

function isLiveMeetingSettingsDisabled(input: { room: Room | null; isBusy: boolean }): boolean {
  return !input.room || input.isBusy;
}

function getLiveMeetingJoiningInfoText(input: {
  meeting: Meeting | null;
  liveRoomJoinUrl: string;
  liveRoomCallIn: LiveMeetingCallInInfo | null;
}): string {
  if (!hasMeetingRecord(input.meeting) || input.liveRoomJoinUrl.length === 0) {
    return "";
  }

  return getLiveMeetingJoiningInfo({
    title: input.meeting.title,
    joinUrl: input.liveRoomJoinUrl,
    callIn: input.liveRoomCallIn,
  });
}

function handleLiveMeetingAmbientContextPillClick(input: {
  itemKey: string;
  isAmbientContextPanelOpen: boolean;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedRelevantDetailsItemKey: Dispatch<SetStateAction<string | null>>;
  openAmbientContextPanel: (itemKey?: string) => void;
}): void {
  if (input.isAmbientContextPanelOpen) {
    input.setIsAmbientContextPanelOpen(false);
    input.setSelectedRelevantDetailsItemKey(null);

    return;
  }

  input.openAmbientContextPanel(input.itemKey);
}

function handleLiveMeetingUserAvatarBadgeClick(input: {
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  input.setIsToolApprovalPanelOpen(false);
  input.setIsAmbientContextPanelOpen(false);
  input.setIsMeetingDetailsPanelOpen(false);
  input.setIsMeetingSettingsPanelOpen(false);
  input.setIsPresencePanelOpen((isCurrentlyOpen) => !isCurrentlyOpen);
}

async function runLiveMeetingToggleScreenShare(input: {
  room: Room;
  dataPresentationClaimsByIdentityRef: { current: Record<string, PresentationClaim> };
  setIsScreenShareBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
  setLocalPresentationIntent: (requestedAt: number) => Promise<void>;
  clearLocalPresentationIntent: () => Promise<void>;
}): Promise<void> {
  const isNextScreenShareEnabled = !input.room.localParticipant.isScreenShareEnabled;
  input.setIsScreenShareBusy(true);
  input.setError(null);

  try {
    if (!isNextScreenShareEnabled) {
      await input.room.localParticipant.setScreenShareEnabled(false);
      input.setPinnedScreenShareTrackId((current) =>
        current !== null && current.startsWith(`${input.room.localParticipant.identity}-`) ? null : current,
      );
      await input.clearLocalPresentationIntent();

      return;
    }

    await runLiveMeetingTryEnableScreenShare({
      room: input.room,
      dataPresentationClaimsByIdentityRef: input.dataPresentationClaimsByIdentityRef,
      setLocalPresentationIntent: input.setLocalPresentationIntent,
      clearLocalPresentationIntent: input.clearLocalPresentationIntent,
      setPinnedScreenShareTrackId: input.setPinnedScreenShareTrackId,
      setError: input.setError,
    });
  } catch (nextError) {
    await input.clearLocalPresentationIntent();
    if (isNextScreenShareEnabled) {
      const nextMessage = getScreenShareErrorMessage(nextError);
      if (nextMessage !== null && nextMessage.length > 0) {
        input.setError(nextMessage);
      }
    } else {
      input.setError(getErrorMessage({ error: nextError, fallback: LIVE_MEETING_PAGE_COPY.screenShareStopFailed }));
    }
  } finally {
    input.setIsScreenShareBusy(false);
  }
}

type LiveMeetingInRoomVoiceToolingInput = {
  session: AuthSession | null;
  meetingId: string;
  meeting: Meeting | null;
  meetingRecordId: string | undefined;
  room: Room | null;
  connectionState: ConnectionState;
  showToast: ReturnType<typeof useToast>["showToast"];
  toolApprovalCards: VoiceToolApprovalCardState[];
  linearActionPanelState: LinearActionPanelState | null;
  linearActionPanelStateRef: { current: LinearActionPanelState | null };
  calendarOAuthPopupRef: { current: Window | null };
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelSearchStartedAtRef: { current: number | null };
  webSearchPanelSearchKeyRef: { current: string | null };
  webSearchDeferredPayloadTimerRef: { current: number | null };
  webSearchDeferredPayloadResolveRef: { current: ((applied: boolean) => void) | null };
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setToolApprovalCards: Dispatch<SetStateAction<VoiceToolApprovalCardState[]>>;
  setSelectedRelevantDetailsItemKey: Dispatch<SetStateAction<string | null>>;
  setIsLinearActionPanelOpen: Dispatch<SetStateAction<boolean>>;
  setLinearActionPanelState: Dispatch<SetStateAction<LinearActionPanelState | null>>;
};

export async function runLiveMeetingConnectCalendarFromApprovalCard(
  input: Pick<
    LiveMeetingInRoomVoiceToolingInput,
    "session" | "meetingId" | "showToast" | "setToolApprovalCards" | "calendarOAuthPopupRef"
  > & { card: VoiceToolApprovalCardState },
): Promise<void> {
  const { card } = input;
  const calendarOAuthPopupRef = input.calendarOAuthPopupRef;
  if (card.provider === null) {
    return;
  }
  if (input.session === null) {
    input.showToast({
      id: `calendar-connect-signed-out:${input.meetingId}`,
      title: LIVE_MEETING_PAGE_COPY.calendarSignInRequiredTitle,
      message: LIVE_MEETING_PAGE_COPY.calendarConnectSignInMessage,
      tone: "warning",
    });

    return;
  }

  const provider = card.provider;
  input.setToolApprovalCards((current) =>
    current.map((item) =>
      item.id === card.id
        ? {
            ...item,
            status: "starting",
            error: null,
          }
        : item,
    ),
  );

  const popup = window.open(
    "about:blank",
    `readymeet-calendar-oauth-${provider}`,
    `popup=yes,width=${CALENDAR_OAUTH_POPUP_WIDTH},height=${CALENDAR_OAUTH_POPUP_HEIGHT},menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes`,
  );
  calendarOAuthPopupRef.current = popup;
  if (popup === null) {
    console.error("[readymeet:optional-live-feature] calendar popup unavailable.");
    input.setToolApprovalCards((current) => current.filter((item) => item.id !== card.id));

    return;
  }

  try {
    const authorizationUrl = await connectCalendar({
      token: input.session.token,
      input: {
        provider,
        returnTo: window.location.href,
        meetingId: input.meetingId,
      },
      signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
    });
    popup.location.href = authorizationUrl;
    popup.focus();
  } catch (nextError) {
    popup.close();
    calendarOAuthPopupRef.current = null;
    if (reportOptionalLiveServiceFailure({ error: nextError, feature: "calendar" })) {
      input.setToolApprovalCards((current) => current.filter((item) => item.id !== card.id));

      return;
    }
    const message = getErrorMessage({ error: nextError, fallback: "Unable to connect your calendar" });
    input.setToolApprovalCards((current) =>
      current.map((item) =>
        item.id === card.id
          ? {
              ...item,
              status: "error",
              error: message,
            }
          : item,
      ),
    );
    input.showToast({
      id: `calendar-connect-error:${input.meetingId}:${provider}`,
      title: LIVE_MEETING_PAGE_COPY.calendarConnectErrorTitle,
      message,
      tone: "warning",
    });
  }
}

function runLiveMeetingRequestWorkflowFromApprovalCard(
  input: Pick<LiveMeetingInRoomVoiceToolingInput, "meetingId" | "showToast" | "setToolApprovalCards"> & {
    card: VoiceToolApprovalCardState;
  },
): void {
  const { card } = input;
  input.setToolApprovalCards((current) =>
    current.map((item) =>
      item.id === card.id
        ? {
            ...item,
            status: "requested",
            error: null,
          }
        : item,
    ),
  );
  input.showToast({
    id: `workflow-requested:${input.meetingId}:${card.id}`,
    title: LIVE_MEETING_PAGE_COPY.workflowRequestedTitle,
    message: LIVE_MEETING_PAGE_COPY.workflowRequestedMessage,
    tone: "success",
  });
}

function closeLiveMeetingLinearActionPanel(
  input: Pick<LiveMeetingInRoomVoiceToolingInput, "setIsLinearActionPanelOpen" | "setLinearActionPanelState">,
): void {
  input.setIsLinearActionPanelOpen(false);
  input.setLinearActionPanelState(null);
}

export async function runLiveMeetingLinearActionPanelFromVoiceRpc(
  input: Pick<
    LiveMeetingInRoomVoiceToolingInput,
    | "linearActionPanelStateRef"
    | "setLinearActionPanelState"
    | "setIsAmbientContextPanelOpen"
    | "setIsLinearActionPanelOpen"
    | "showToast"
  > & {
    closeLinearActionPanel: () => void;
    payloadText: string;
  },
): Promise<{ status: string }> {
  const parsed = parseLinearActionPanelPayload(input.payloadText);
  if (!parsed) {
    return { status: "ignored" };
  }

  if (parsed.status === "pending") {
    input.setLinearActionPanelState({
      status: "pending",
      meetingId: parsed.meetingId,
      pendingInvocationId: parsed.pendingInvocationId,
      actionName: parsed.actionName,
      actionLabel: parsed.actionLabel,
      description: parsed.description,
      preview: parsed.preview,
      summaries: parsed.summaries,
      successToast: parsed.successToast,
      partialToast: parsed.partialToast,
      requestingUserId: parsed.requestingUserId,
      message: null,
      isBusy: false,
    });
    input.setIsAmbientContextPanelOpen(false);
    input.setIsLinearActionPanelOpen(true);

    return { status: "shown" };
  }

  const current = input.linearActionPanelStateRef.current;
  if (!current || current.pendingInvocationId !== parsed.pendingInvocationId || current.status !== "pending") {
    return { status: "ignored" };
  }

  if (parsed.status === "completed") {
    const stats = parsed.result;
    if (stats && stats.failed > 0) {
      const message = showLinearBatchFailure({
        stats,
        state: current,
        invocationId: parsed.pendingInvocationId,
        showToast: input.showToast,
      });
      input.setLinearActionPanelState({ ...current, status: "error", isBusy: false, message });

      return { status: "updated" };
    }
    input.showToast({
      id: `linear-action-${parsed.pendingInvocationId}`,
      title: LIVE_MEETING_PAGE_COPY.linearPanelTitle,
      message: current.successToast ?? "Done in Linear",
      tone: "success",
    });
    input.closeLinearActionPanel();

    return { status: "updated" };
  }

  if (parsed.status === "cancelled") {
    input.showToast({
      id: `linear-action-${parsed.pendingInvocationId}`,
      title: LIVE_MEETING_PAGE_COPY.linearPanelTitle,
      message: LIVE_MEETING_PAGE_COPY.linearToastNoChanges,
      tone: "info",
    });
    input.closeLinearActionPanel();

    return { status: "updated" };
  }

  input.setLinearActionPanelState({ ...current, status: parsed.status, isBusy: false });

  return { status: "updated" };
}

export async function runLiveMeetingLinearActionAllowConfirm(
  input: Pick<
    LiveMeetingInRoomVoiceToolingInput,
    "session" | "meetingId" | "linearActionPanelState" | "showToast" | "setLinearActionPanelState"
  > & { closeLinearActionPanel: () => void },
): Promise<void> {
  const pending = input.linearActionPanelState;
  if (input.session === null || pending === null || pending.status !== "pending" || pending.isBusy) {
    return;
  }
  input.setLinearActionPanelState((current) =>
    current && current.pendingInvocationId === pending.pendingInvocationId
      ? { ...current, isBusy: true, message: null }
      : current,
  );
  try {
    const response = await confirmMeetingAgentToolInvocation({
      token: input.session.token,
      meetingId: input.meetingId,
      invocationId: pending.pendingInvocationId,
      signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
    });
    const stats = parseLinearActionBatchStats(response.resultSummary);
    if (stats !== null && stats.failed > 0) {
      const message = showLinearBatchFailure({
        stats,
        state: pending,
        invocationId: pending.pendingInvocationId,
        showToast: input.showToast,
      });
      input.setLinearActionPanelState((current) =>
        current && current.pendingInvocationId === pending.pendingInvocationId
          ? { ...current, status: "error", isBusy: false, message }
          : current,
      );

      return;
    }
    input.showToast({
      id: `linear-action-${pending.pendingInvocationId}`,
      title: LIVE_MEETING_PAGE_COPY.linearPanelTitle,
      message: pending.successToast ?? LIVE_MEETING_PAGE_COPY.linearToastDone,
      tone: "success",
    });
    input.closeLinearActionPanel();
  } catch (nextError) {
    // A 500 means the API ran the confirmed action and it failed; only gateway-style 5xx and network errors are outages.
    const isActionFailure = nextError instanceof ApiError && nextError.status === HTTP_STATUS_INTERNAL_SERVER_ERROR;
    if (!isActionFailure && reportOptionalLiveServiceFailure({ error: nextError, feature: "assistant" })) {
      input.closeLinearActionPanel();

      return;
    }
    input.setLinearActionPanelState((current) =>
      current && current.pendingInvocationId === pending.pendingInvocationId
        ? {
            ...current,
            // The server marked the invocation failed, so Allow cannot succeed again.
            status: isActionFailure ? "error" : current.status,
            isBusy: false,
            message: isActionFailure
              ? LIVE_MEETING_PAGE_COPY.linearActionRunFailed
              : getErrorMessage({ error: nextError, fallback: LIVE_MEETING_PAGE_COPY.linearActionRunFailed }),
          }
        : current,
    );
  }
}

export async function runLiveMeetingLinearActionCancelPending(
  input: Pick<
    LiveMeetingInRoomVoiceToolingInput,
    "session" | "meetingId" | "linearActionPanelState" | "showToast" | "setLinearActionPanelState"
  > & { closeLinearActionPanel: () => void },
): Promise<void> {
  const pending = input.linearActionPanelState;
  if (input.session === null || pending === null || pending.status !== "pending" || pending.isBusy) {
    return;
  }
  input.setLinearActionPanelState((current) =>
    current && current.pendingInvocationId === pending.pendingInvocationId
      ? { ...current, isBusy: true, message: null }
      : current,
  );
  try {
    await cancelMeetingAgentToolInvocation({
      token: input.session.token,
      meetingId: input.meetingId,
      invocationId: pending.pendingInvocationId,
      signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
    });
    input.showToast({
      id: `linear-action-${pending.pendingInvocationId}`,
      title: LIVE_MEETING_PAGE_COPY.linearPanelTitle,
      message: LIVE_MEETING_PAGE_COPY.linearToastNoChanges,
      tone: "info",
    });
    input.closeLinearActionPanel();
  } catch (nextError) {
    if (reportOptionalLiveServiceFailure({ error: nextError, feature: "assistant" })) {
      input.closeLinearActionPanel();

      return;
    }
    input.setLinearActionPanelState((current) =>
      current && current.pendingInvocationId === pending.pendingInvocationId
        ? {
            ...current,
            isBusy: false,
            message: getErrorMessage({ error: nextError, fallback: LIVE_MEETING_PAGE_COPY.linearActionCancelFailed }),
          }
        : current,
    );
  }
}

export async function runLiveMeetingDisconnectCalendarFromApprovalCard(
  input: Pick<LiveMeetingInRoomVoiceToolingInput, "session" | "meetingId" | "showToast" | "setToolApprovalCards"> & {
    card: VoiceToolApprovalCardState;
    performAssistantRpc: LiveMeetingPagePerformAssistantRpc;
  },
): Promise<void> {
  const { card } = input;
  if (card.provider === null) {
    return;
  }
  if (input.session === null) {
    input.showToast({
      id: `calendar-disconnect-signed-out:${input.meetingId}`,
      title: LIVE_MEETING_PAGE_COPY.calendarSignInRequiredTitle,
      message: LIVE_MEETING_PAGE_COPY.calendarDisconnectSignInMessage,
      tone: "warning",
    });

    return;
  }

  const provider = card.provider;
  input.setToolApprovalCards((current) =>
    current.map((item) =>
      item.id === card.id
        ? {
            ...item,
            status: "disconnecting",
            error: null,
          }
        : item,
    ),
  );

  try {
    await disconnectCalendar({
      token: input.session.token,
      input: { provider },
      signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
    });
    input.setToolApprovalCards((current) =>
      current.map((item) =>
        item.id === card.id
          ? {
              ...item,
              status: "idle",
              error: null,
            }
          : item,
      ),
    );
    input.showToast({
      id: `calendar-disconnected:${input.meetingId}:${provider}`,
      title: LIVE_MEETING_PAGE_COPY.calendarDisconnectedTitle,
      message: buildCalendarDisconnectedToastMessage(provider),
      tone: "success",
    });
    void (async () => {
      try {
        await input.performAssistantRpc({ method: REFRESH_AGENT_CONTEXT_RPC });
      } catch (error) {
        void describeCaughtFailure(error);
      }
    })();
  } catch (nextError) {
    if (reportOptionalLiveServiceFailure({ error: nextError, feature: "calendar" })) {
      input.setToolApprovalCards((current) => current.filter((item) => item.id !== card.id));

      return;
    }
    const message = getErrorMessage({ error: nextError, fallback: "Unable to disable your calendar skill" });
    input.setToolApprovalCards((current) =>
      current.map((item) =>
        item.id === card.id
          ? {
              ...item,
              status: "connected",
              error: message,
            }
          : item,
      ),
    );
    input.showToast({
      id: `calendar-disconnect-error:${input.meetingId}:${provider}`,
      title: LIVE_MEETING_PAGE_COPY.calendarDisableFailedTitle,
      message,
      tone: "warning",
    });
  }
}

export function runLiveMeetingMeetingAnswerResultsRpcEffect(input: {
  room: Pick<Room, "remoteParticipants" | "registerRpcMethod" | "unregisterRpcMethod">;
  meeting: Pick<Meeting, "id">;
  showWebSearchPanelFromVoice: (payload: string) => Promise<unknown>;
}): () => void {
  const handler = async (data: RpcInvocationData) => {
    const parsed = parseVoiceWebSearchPanelPayload(data.payload);
    if (
      !isTrustedMeetingAgentRpc({ room: input.room, data, meetingId: input.meeting.id }) ||
      parsed.contentKind !== "meeting-answer" ||
      parsed.meetingId !== input.meeting.id
    ) {
      return JSON.stringify({ status: "ignored" });
    }

    return JSON.stringify(await input.showWebSearchPanelFromVoice(JSON.stringify(parsed)));
  };
  input.room.registerRpcMethod(MEETING_ANSWER_RESULTS_RPC, handler);

  return () => input.room.unregisterRpcMethod(MEETING_ANSWER_RESULTS_RPC);
}

export function runLiveMeetingLinearActionPanelRpcEffect(input: {
  room: Pick<Room, "remoteParticipants" | "registerRpcMethod" | "unregisterRpcMethod">;
  meetingId: string | undefined;
  showLinearActionPanelFromVoice: (payloadText: string) => Promise<{ status: string }>;
}): () => void {
  const handler = async (data: RpcInvocationData) => {
    if (!isTrustedMeetingAgentRpc({ room: input.room, data, meetingId: input.meetingId })) {
      return JSON.stringify({ status: "ignored" });
    }
    const result = await input.showLinearActionPanelFromVoice(data.payload);

    return JSON.stringify(result);
  };

  try {
    input.room.unregisterRpcMethod(LINEAR_ACTION_PANEL_RPC);
  } catch (error) {
    void describeCaughtFailure(error);
  }
  input.room.registerRpcMethod(LINEAR_ACTION_PANEL_RPC, handler);

  return () => {
    try {
      input.room.unregisterRpcMethod(LINEAR_ACTION_PANEL_RPC);
    } catch (error) {
      void describeCaughtFailure(error);
    }
  };
}

type LiveMeetingInRoomVoiceToolingHandlers = {
  showToolApprovalPanelFromVoice: (payload: string) => Promise<unknown>;
  showWebSearchPanelFromVoice: (payload: string) => Promise<unknown>;
  showLinearActionPanelFromVoice: (payloadText: string) => Promise<{ status: string }>;
  performAssistantRpc: LiveMeetingPagePerformAssistantRpc;
  connectCalendarFromApprovalCard: (card: VoiceToolApprovalCardState) => Promise<void>;
  disconnectCalendarFromApprovalCard: (card: VoiceToolApprovalCardState) => Promise<void>;
  requestWorkflowFromApprovalCard: (card: VoiceToolApprovalCardState) => void;
  handleLinearActionAllow: () => Promise<void>;
  handleLinearActionCancel: () => Promise<void>;
};

type LiveMeetingInRoomMediaControlsInput = {
  room: Room | null;
  connectionState: ConnectionState;
  initialAudioOutputDeviceId?: string;
  clientDiagnosticContextRef: { current: { token: string; meetingId: string } | null };
  activeSession: AuthSession | null;
  meetingId: string;
  meeting: Meeting | null;
  isGuestSession: boolean;
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  isMicEnabled: boolean;
  isCamEnabled: boolean;
  isBackgroundBlurEnabled: boolean;
  isBackgroundBlurBusy: boolean;
  isBackgroundBlurSupported: boolean;
  setIsBackgroundBlurSupported: Dispatch<SetStateAction<boolean>>;
  setAudioDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setIsBackgroundBlurEnabled: Dispatch<SetStateAction<boolean>>;
  setIsBackgroundBlurBusy: Dispatch<SetStateAction<boolean>>;
  setMeeting: Dispatch<SetStateAction<Meeting | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  clearMediaControlError: () => void;
  setMediaControlError: (message: string) => void;
  showToast: ReturnType<typeof useToast>["showToast"];
  assistantSpeechLevelRef: { current: number };
  speechLevelRef: { current: number };
  speechIndicatorStatesRef: { current: Record<string, SpeechIndicatorState> };
  participantSpeechStore: ReturnType<typeof createParticipantSpeechStore>;
  setIsCaptionSpeechActive: Dispatch<SetStateAction<boolean>>;
  setIsAssistantParticipantSpeaking: Dispatch<SetStateAction<boolean>>;
};

function useLiveMeetingInRoomMediaControlsRefs() {
  const backgroundBlurProcessorRef = useRef<ReturnType<typeof createBackgroundBlurProcessor> | null>(null);

  return {
    backgroundBlurProcessorRef,
  };
}

type LiveMeetingInRoomMediaControlsRefs = ReturnType<typeof useLiveMeetingInRoomMediaControlsRefs>;

export function useLiveMeetingInRoomMediaControlsBlurCallbacks(blurInput: {
  toolingInput: LiveMeetingInRoomMediaControlsInput;
  refs: LiveMeetingInRoomMediaControlsRefs;
}) {
  const { refs } = blurInput;
  const getBackgroundBlurProcessor = useCallback(() => {
    const processorRef = refs.backgroundBlurProcessorRef;
    processorRef.current ??= createBackgroundBlurProcessor();

    return processorRef.current;
  }, [refs.backgroundBlurProcessorRef]);

  const setPublishedCameraBackgroundBlur = useCallback(
    async (blurInput: { targetRoom: Room; isEnabled: boolean }) => {
      const cameraTrack = getMeetingCameraTrack(blurInput.targetRoom.localParticipant);
      if (cameraTrack === undefined || cameraTrack.isMuted) {
        return;
      }

      await setLocalVideoTrackBackgroundBlur({
        track: cameraTrack,
        processor: getBackgroundBlurProcessor(),
        isEnabled: blurInput.isEnabled,
      });
    },
    [getBackgroundBlurProcessor],
  );

  return { setPublishedCameraBackgroundBlur };
}

function useLiveMeetingInRoomMediaControlsMicCameraCallbacks(micCameraInput: {
  toolingInput: LiveMeetingInRoomMediaControlsInput;
  blurCallbacks: ReturnType<typeof useLiveMeetingInRoomMediaControlsBlurCallbacks>;
}) {
  const { toolingInput: input, blurCallbacks } = micCameraInput;
  const toggleMic = useCallback(async () => {
    if (!input.room) {
      return;
    }
    await runLiveMeetingToggleMic({
      room: input.room,
      audioDeviceId: input.audioDeviceId,
      activeSession: input.activeSession,
      meetingId: input.meetingId,
      clearMediaControlError: input.clearMediaControlError,
      setMediaControlError: input.setMediaControlError,
      setMicrophonePermissionState: input.setMicrophonePermissionState,
      setIsMicEnabled: input.setIsMicEnabled,
    });
  }, [
    input.activeSession,
    input.audioDeviceId,
    input.clearMediaControlError,
    input.meetingId,
    input.room,
    input.setMediaControlError,
    input.setIsMicEnabled,
    input.setMicrophonePermissionState,
  ]);

  const toggleCamera = useCallback(async () => {
    if (!input.room) {
      return;
    }
    await runLiveMeetingToggleCamera({
      room: input.room,
      videoDeviceId: input.videoDeviceId,
      activeSession: input.activeSession,
      meetingId: input.meetingId,
      isBackgroundBlurEnabled: input.isBackgroundBlurEnabled,
      isBackgroundBlurSupported: input.isBackgroundBlurSupported,
      clearMediaControlError: input.clearMediaControlError,
      setMediaControlError: input.setMediaControlError,
      setVideoDeviceId: input.setVideoDeviceId,
      setCameraPermissionState: input.setCameraPermissionState,
      setIsCamEnabled: input.setIsCamEnabled,
      setPublishedCameraBackgroundBlur: blurCallbacks.setPublishedCameraBackgroundBlur,
    });
  }, [
    blurCallbacks.setPublishedCameraBackgroundBlur,
    input.activeSession,
    input.clearMediaControlError,
    input.isBackgroundBlurEnabled,
    input.isBackgroundBlurSupported,
    input.meetingId,
    input.room,
    input.setMediaControlError,
    input.setVideoDeviceId,
    input.setIsCamEnabled,
    input.setCameraPermissionState,
    input.videoDeviceId,
  ]);

  return { toggleMic, toggleCamera };
}

function useLiveMeetingInRoomMediaControlsSelectDeviceCallbacks(selectInput: {
  toolingInput: LiveMeetingInRoomMediaControlsInput;
  blurCallbacks: ReturnType<typeof useLiveMeetingInRoomMediaControlsBlurCallbacks>;
}) {
  const { toolingInput: input, blurCallbacks } = selectInput;
  const selectAudioDevice = useCallback(
    async (nextDeviceId: string) => {
      if (nextDeviceId.length === 0 || nextDeviceId === input.audioDeviceId || input.room === null) {
        return;
      }

      await runLiveMeetingSelectAudioDevice({
        nextDeviceId,
        audioDeviceId: input.audioDeviceId,
        room: input.room,
        activeSession: input.activeSession,
        meetingId: input.meetingId,
        setAudioDeviceId: input.setAudioDeviceId,
        clearMediaControlError: input.clearMediaControlError,
        setMediaControlError: input.setMediaControlError,
      });
    },
    [
      input.activeSession,
      input.audioDeviceId,
      input.clearMediaControlError,
      input.meetingId,
      input.room,
      input.setAudioDeviceId,
      input.setMediaControlError,
    ],
  );

  const selectVideoDevice = useCallback(
    async (nextDeviceId: string) => {
      if (nextDeviceId.length === 0 || nextDeviceId === input.videoDeviceId || input.room === null) {
        return;
      }

      await runLiveMeetingSelectVideoDevice({
        nextDeviceId,
        videoDeviceId: input.videoDeviceId,
        room: input.room,
        activeSession: input.activeSession,
        meetingId: input.meetingId,
        isCamEnabled: input.isCamEnabled,
        isBackgroundBlurEnabled: input.isBackgroundBlurEnabled,
        isBackgroundBlurSupported: input.isBackgroundBlurSupported,
        setVideoDeviceId: input.setVideoDeviceId,
        clearMediaControlError: input.clearMediaControlError,
        setMediaControlError: input.setMediaControlError,
        setPublishedCameraBackgroundBlur: blurCallbacks.setPublishedCameraBackgroundBlur,
      });
    },
    [
      blurCallbacks.setPublishedCameraBackgroundBlur,
      input.activeSession,
      input.clearMediaControlError,
      input.isBackgroundBlurEnabled,
      input.isBackgroundBlurSupported,
      input.isCamEnabled,
      input.meetingId,
      input.room,
      input.setMediaControlError,
      input.setVideoDeviceId,
      input.videoDeviceId,
    ],
  );

  return { selectAudioDevice, selectVideoDevice };
}

function useLiveMeetingInRoomMediaControlsBackgroundBlurCallbacks(backgroundBlurInput: {
  toolingInput: LiveMeetingInRoomMediaControlsInput;
  refs: LiveMeetingInRoomMediaControlsRefs;
  blurCallbacks: ReturnType<typeof useLiveMeetingInRoomMediaControlsBlurCallbacks>;
}) {
  const { toolingInput: input, blurCallbacks } = backgroundBlurInput;
  const toggleBackgroundBlur = useCallback(async () => {
    if (!input.room || input.isBackgroundBlurBusy) {
      return;
    }

    if (!canToggleBackgroundBlur(input)) {
      input.setError(LIVE_MEETING_PAGE_COPY.backgroundBlurUnsupportedBrowser);

      return;
    }

    await runLiveMeetingToggleBackgroundBlur({
      room: input.room,
      isBackgroundBlurEnabled: input.isBackgroundBlurEnabled,
      isCamEnabled: input.isCamEnabled,
      activeSession: input.activeSession,
      isGuestSession: input.isGuestSession,
      setIsBackgroundBlurBusy: input.setIsBackgroundBlurBusy,
      setError: input.setError,
      setIsBackgroundBlurEnabled: input.setIsBackgroundBlurEnabled,
      setPublishedCameraBackgroundBlur: blurCallbacks.setPublishedCameraBackgroundBlur,
    });
  }, [
    blurCallbacks.setPublishedCameraBackgroundBlur,
    input.activeSession,
    input.isBackgroundBlurBusy,
    input.isBackgroundBlurEnabled,
    input.isBackgroundBlurSupported,
    input.isCamEnabled,
    input.isGuestSession,
    input.room,
    input.setError,
    input.setIsBackgroundBlurBusy,
    input.setIsBackgroundBlurEnabled,
  ]);

  return { toggleBackgroundBlur };
}

type LiveMeetingScreenShareToolingInput = {
  room: Room | null;
  canScreenShare: boolean;
  screenShareStageShellRef: { current: HTMLDivElement | null };
  dataPresentationClaimsByIdentityRef: { current: Record<string, PresentationClaim> };
  updateDataPresentationClaims: (
    update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>,
  ) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsScreenShareBusy: Dispatch<SetStateAction<boolean>>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
};

function useLiveMeetingInRoomMediaControlsPresentationCallbacks(presentationInput: {
  toolingInput: LiveMeetingScreenShareToolingInput;
  refs: { localPresentationClaimRef: { current: PresentationClaim | null } };
}) {
  const { toolingInput: input, refs } = presentationInput;
  const publishPresentationClaimPayload = useCallback(
    async (payload: PresentationClaimPayload) => {
      if (!input.room) {
        return;
      }

      await publishPresentationClaim({ room: input.room, payload });
    },
    [input.room],
  );

  const setLocalPresentationIntent = useCallback(
    async (requestedAt: number) => {
      if (!input.room) {
        return;
      }

      const claim: PresentationClaim = {
        participantIdentity: input.room.localParticipant.identity,
        participantName: formatLiveParticipantName({
          name: input.room.localParticipant.name,
          identity: input.room.localParticipant.identity,
        }),
        requestedAt,
      };
      const localPresentationClaimRef = refs.localPresentationClaimRef;
      localPresentationClaimRef.current = claim;
      input.updateDataPresentationClaims((current) => upsertPresentationClaim({ claimsByIdentity: current, claim }));
      await publishPresentationClaimPayload({
        type: PRESENTATION_CLAIM_TOPIC,
        state: "starting",
        requestedAt,
      });
    },
    [input.room, input.updateDataPresentationClaims, publishPresentationClaimPayload, refs.localPresentationClaimRef],
  );

  const clearLocalPresentationIntent = useCallback(async () => {
    if (!input.room) {
      return;
    }

    const localPresentationClaimRef = refs.localPresentationClaimRef;
    localPresentationClaimRef.current = null;
    const room = input.room;
    input.updateDataPresentationClaims((current) =>
      removePresentationClaim({ claimsByIdentity: current, participantIdentity: room.localParticipant.identity }),
    );

    try {
      await publishPresentationClaimPayload({
        type: PRESENTATION_CLAIM_TOPIC,
        state: "clear",
      });
    } catch (error) {
      void describeCaughtFailure(error);
    }
  }, [input.room, input.updateDataPresentationClaims, publishPresentationClaimPayload, refs.localPresentationClaimRef]);

  const toggleScreenShare = useCallback(async () => {
    if (!input.room || !input.canScreenShare) {
      return;
    }

    await runLiveMeetingToggleScreenShare({
      room: input.room,
      dataPresentationClaimsByIdentityRef: input.dataPresentationClaimsByIdentityRef,
      setIsScreenShareBusy: input.setIsScreenShareBusy,
      setError: input.setError,
      setPinnedScreenShareTrackId: input.setPinnedScreenShareTrackId,
      setLocalPresentationIntent,
      clearLocalPresentationIntent,
    });
  }, [
    clearLocalPresentationIntent,
    input.canScreenShare,
    input.dataPresentationClaimsByIdentityRef,
    input.room,
    input.setError,
    input.setIsScreenShareBusy,
    input.setPinnedScreenShareTrackId,
    setLocalPresentationIntent,
  ]);

  return {
    clearLocalPresentationIntent,
    toggleScreenShare,
  };
}

function useLiveMeetingInRoomMediaControlsFullscreenCallback(presentationInput: {
  toolingInput: LiveMeetingScreenShareToolingInput;
}) {
  const { toolingInput: input } = presentationInput;

  return useCallback(async () => {
    const stageShell = input.screenShareStageShellRef.current;
    if (!stageShell) {
      return;
    }

    try {
      if (getCurrentFullscreenElement() === stageShell) {
        await exitCurrentFullscreen();

        return;
      }

      await requestElementFullscreen(stageShell);
    } catch (nextError) {
      input.setError(getErrorMessage({ error: nextError, fallback: "Failed to toggle fullscreen." }));
    }
  }, [input.screenShareStageShellRef, input.setError]);
}

function useLiveMeetingInRoomMediaControlsEffects(effectsInput: {
  toolingInput: LiveMeetingInRoomMediaControlsInput;
}): void {
  const { toolingInput: input } = effectsInput;
  useEffect(() => {
    input.setIsBackgroundBlurSupported(isBackgroundBlurProcessorSupported());
  }, [input.setIsBackgroundBlurSupported]);

  useEffect(() => {
    if (!input.room) {
      return;
    }

    runLiveMeetingInitialAudioOutputDeviceEffect({
      room: input.room,
      initialAudioOutputDeviceId: input.initialAudioOutputDeviceId,
      clientDiagnosticContextRef: input.clientDiagnosticContextRef,
    });
  }, [input.initialAudioOutputDeviceId, input.room, input.clientDiagnosticContextRef]);

  useEffect(() => {
    if (!input.room || input.connectionState !== ConnectionState.Connected) {
      const assistantSpeechLevelRef = input.assistantSpeechLevelRef;
      const speechLevelRef = input.speechLevelRef;
      assistantSpeechLevelRef.current = 0;
      speechLevelRef.current = 0;
      input.setIsCaptionSpeechActive(false);
      input.participantSpeechStore.update((current) => (Object.keys(current).length === 0 ? current : {}));
      input.setIsAssistantParticipantSpeaking(false);

      return;
    }

    return attachLiveMeetingSpeechMeter({
      room: input.room,
      isMicEnabled: input.isMicEnabled,
      assistantSpeechLevelRef: input.assistantSpeechLevelRef,
      speechLevelRef: input.speechLevelRef,
      speechIndicatorStatesRef: input.speechIndicatorStatesRef,
      participantSpeechStore: input.participantSpeechStore,
      setIsCaptionSpeechActive: input.setIsCaptionSpeechActive,
      setIsAssistantParticipantSpeaking: input.setIsAssistantParticipantSpeaking,
    });
  }, [
    input.assistantSpeechLevelRef,
    input.connectionState,
    input.isMicEnabled,
    input.participantSpeechStore,
    input.room,
    input.setIsAssistantParticipantSpeaking,
    input.setIsCaptionSpeechActive,
    input.speechIndicatorStatesRef,
    input.speechLevelRef,
  ]);
}

function useLiveMeetingInRoomMediaControls(input: LiveMeetingInRoomMediaControlsInput) {
  const refs = useLiveMeetingInRoomMediaControlsRefs();
  const blurCallbacks = useLiveMeetingInRoomMediaControlsBlurCallbacks({ toolingInput: input, refs });
  const micCamera = useLiveMeetingInRoomMediaControlsMicCameraCallbacks({ toolingInput: input, blurCallbacks });
  const selectDevices = useLiveMeetingInRoomMediaControlsSelectDeviceCallbacks({ toolingInput: input, blurCallbacks });
  const backgroundBlur = useLiveMeetingInRoomMediaControlsBackgroundBlurCallbacks({
    toolingInput: input,
    refs,
    blurCallbacks,
  });
  useLiveMeetingInRoomMediaControlsEffects({ toolingInput: input });

  return {
    ...blurCallbacks,
    ...micCamera,
    ...selectDevices,
    ...backgroundBlur,
  };
}

function useLiveMeetingScreenShareControls(input: {
  room: Room | null;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsScreenShareFullscreen: Dispatch<SetStateAction<boolean>>;
}) {
  const localPresentationClaimRef = useRef<PresentationClaim | null>(null);
  const screenShareStageShellRef = useRef<HTMLDivElement | null>(null);
  const [isScreenShareBusy, setIsScreenShareBusy] = useState(false);
  const [pinnedScreenShareTrackId, setPinnedScreenShareTrackId] = useState<string | null>(null);
  const [canScreenShare, setCanScreenShare] = useState(false);
  const [dataPresentationClaimsByIdentity, setDataPresentationClaimsByIdentity] = useState<
    Record<string, PresentationClaim>
  >({});
  const dataPresentationClaimsByIdentityRef = useRef(dataPresentationClaimsByIdentity);
  const updateDataPresentationClaims = useCallback(
    (update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>) => {
      const next = update(dataPresentationClaimsByIdentityRef.current);
      dataPresentationClaimsByIdentityRef.current = next;
      setDataPresentationClaimsByIdentity(next);
    },
    [],
  );
  const toolingInput = {
    room: input.room,
    canScreenShare,
    screenShareStageShellRef,
    dataPresentationClaimsByIdentityRef,
    updateDataPresentationClaims,
    setError: input.setError,
    setIsScreenShareBusy,
    setPinnedScreenShareTrackId,
  };
  const presentation = useLiveMeetingInRoomMediaControlsPresentationCallbacks({
    toolingInput,
    refs: { localPresentationClaimRef },
  });
  const toggleScreenShareFullscreen = useLiveMeetingInRoomMediaControlsFullscreenCallback({ toolingInput });

  useEffect(() => {
    if (!input.room) {
      return;
    }

    return runLiveMeetingPresentationClaimRoomEffect({
      room: input.room,
      localPresentationClaimRef,
      updateDataPresentationClaims,
    });
  }, [input.room, updateDataPresentationClaims]);

  useEffect(() => {
    setCanScreenShare(typeof navigator.mediaDevices.getDisplayMedia === "function");
  }, []);

  useEffect(() => {
    return runLiveMeetingScreenShareFullscreenSyncEffect({
      screenShareStageShellRef,
      setIsScreenShareFullscreen: input.setIsScreenShareFullscreen,
    });
  }, [input.setIsScreenShareFullscreen]);

  return {
    ...presentation,
    canScreenShare,
    dataPresentationClaimsByIdentity,
    isScreenShareBusy,
    pinnedScreenShareTrackId,
    screenShareStageShellRef,
    setIsScreenShareBusy,
    setPinnedScreenShareTrackId,
    toggleScreenShareFullscreen,
    updateDataPresentationClaims,
  };
}

function useLiveMeetingInRoomVoiceToolingPanelHandlers(
  input: LiveMeetingInRoomVoiceToolingInput,
): Pick<
  LiveMeetingInRoomVoiceToolingHandlers,
  | "showToolApprovalPanelFromVoice"
  | "showWebSearchPanelFromVoice"
  | "showLinearActionPanelFromVoice"
  | "handleLinearActionAllow"
  | "handleLinearActionCancel"
> {
  const closeLinearActionPanel = useCallback(
    () =>
      closeLiveMeetingLinearActionPanel({
        setIsLinearActionPanelOpen: input.setIsLinearActionPanelOpen,
        setLinearActionPanelState: input.setLinearActionPanelState,
      }),
    [input.setIsLinearActionPanelOpen, input.setLinearActionPanelState],
  );

  const showToolApprovalPanelFromVoice = useCallback(
    async (payload: string) =>
      openVoiceToolApprovalPanelFromRpc({
        payload,
        session: input.session,
        setIsToolApprovalPanelOpen: input.setIsToolApprovalPanelOpen,
        setIsAmbientContextPanelOpen: input.setIsAmbientContextPanelOpen,
        setIsMeetingDetailsPanelOpen: input.setIsMeetingDetailsPanelOpen,
        setIsMeetingSettingsPanelOpen: input.setIsMeetingSettingsPanelOpen,
        setIsPresencePanelOpen: input.setIsPresencePanelOpen,
        setToolApprovalCards: input.setToolApprovalCards,
      }),
    [input.session],
  );

  const showWebSearchPanelFromVoice = useCallback(
    async (payload: string) =>
      runVoiceWebSearchPanelFromRpcPayload({
        payload,
        session: input.session,
        webSearchPanelStateRef: input.webSearchPanelStateRef,
        webSearchPanelRunIdRef: input.webSearchPanelRunIdRef,
        webSearchPanelSearchStartedAtRef: input.webSearchPanelSearchStartedAtRef,
        webSearchPanelSearchKeyRef: input.webSearchPanelSearchKeyRef,
        webSearchDeferredPayloadTimerRef: input.webSearchDeferredPayloadTimerRef,
        webSearchDeferredPayloadResolveRef: input.webSearchDeferredPayloadResolveRef,
        updateWebSearchPanelState: input.updateWebSearchPanelState,
        setIsPresencePanelOpen: input.setIsPresencePanelOpen,
        setIsToolApprovalPanelOpen: input.setIsToolApprovalPanelOpen,
        setIsMeetingDetailsPanelOpen: input.setIsMeetingDetailsPanelOpen,
        setIsMeetingSettingsPanelOpen: input.setIsMeetingSettingsPanelOpen,
        setSelectedRelevantDetailsItemKey: input.setSelectedRelevantDetailsItemKey,
        setIsAmbientContextPanelOpen: input.setIsAmbientContextPanelOpen,
      }),
    [input.session, input.updateWebSearchPanelState],
  );

  const showLinearActionPanelFromVoice = useCallback(
    async (payloadText: string) =>
      runLiveMeetingLinearActionPanelFromVoiceRpc({
        linearActionPanelStateRef: input.linearActionPanelStateRef,
        setLinearActionPanelState: input.setLinearActionPanelState,
        setIsAmbientContextPanelOpen: input.setIsAmbientContextPanelOpen,
        setIsLinearActionPanelOpen: input.setIsLinearActionPanelOpen,
        showToast: input.showToast,
        closeLinearActionPanel,
        payloadText,
      }),
    [closeLinearActionPanel, input],
  );

  const handleLinearActionAllow = useCallback(
    async () =>
      runLiveMeetingLinearActionAllowConfirm({
        session: input.session,
        meetingId: input.meetingId,
        linearActionPanelState: input.linearActionPanelState,
        showToast: input.showToast,
        setLinearActionPanelState: input.setLinearActionPanelState,
        closeLinearActionPanel,
      }),
    [closeLinearActionPanel, input],
  );

  const handleLinearActionCancel = useCallback(
    async () =>
      runLiveMeetingLinearActionCancelPending({
        session: input.session,
        meetingId: input.meetingId,
        linearActionPanelState: input.linearActionPanelState,
        showToast: input.showToast,
        setLinearActionPanelState: input.setLinearActionPanelState,
        closeLinearActionPanel,
      }),
    [closeLinearActionPanel, input],
  );

  return {
    showToolApprovalPanelFromVoice,
    showWebSearchPanelFromVoice,
    showLinearActionPanelFromVoice,
    handleLinearActionAllow,
    handleLinearActionCancel,
  };
}

function useLiveMeetingInRoomVoiceToolingApprovalHandlers(
  input: LiveMeetingInRoomVoiceToolingInput,
): Pick<
  LiveMeetingInRoomVoiceToolingHandlers,
  | "performAssistantRpc"
  | "connectCalendarFromApprovalCard"
  | "disconnectCalendarFromApprovalCard"
  | "requestWorkflowFromApprovalCard"
> {
  const performAssistantRpc = useCallback<LiveMeetingPagePerformAssistantRpc>(
    async (rpcInput) => {
      if (!input.room) {
        return null;
      }

      return runLiveMeetingPerformAssistantRpc({
        room: input.room,
        method: rpcInput.method,
        payload: rpcInput.payload ?? "",
        voiceRequestRevision: rpcInput.voiceRequestRevision,
        voiceModeIntentRef: input.voiceModeIntentRef,
      });
    },
    [input.room],
  );

  const connectCalendarFromApprovalCard = useCallback(
    async (card: VoiceToolApprovalCardState) =>
      runLiveMeetingConnectCalendarFromApprovalCard({
        session: input.session,
        meetingId: input.meetingId,
        showToast: input.showToast,
        setToolApprovalCards: input.setToolApprovalCards,
        calendarOAuthPopupRef: input.calendarOAuthPopupRef,
        card,
      }),
    [input],
  );

  const requestWorkflowFromApprovalCard = useCallback(
    (card: VoiceToolApprovalCardState) =>
      runLiveMeetingRequestWorkflowFromApprovalCard({
        meetingId: input.meetingId,
        showToast: input.showToast,
        setToolApprovalCards: input.setToolApprovalCards,
        card,
      }),
    [input],
  );

  const disconnectCalendarFromApprovalCard = useCallback(
    async (card: VoiceToolApprovalCardState) =>
      runLiveMeetingDisconnectCalendarFromApprovalCard({
        session: input.session,
        meetingId: input.meetingId,
        showToast: input.showToast,
        setToolApprovalCards: input.setToolApprovalCards,
        performAssistantRpc,
        card,
      }),
    [input, performAssistantRpc],
  );

  return {
    performAssistantRpc,
    connectCalendarFromApprovalCard,
    disconnectCalendarFromApprovalCard,
    requestWorkflowFromApprovalCard,
  };
}

function useLiveMeetingInRoomVoiceToolingHandlers(
  input: LiveMeetingInRoomVoiceToolingInput,
): LiveMeetingInRoomVoiceToolingHandlers {
  const panelHandlers = useLiveMeetingInRoomVoiceToolingPanelHandlers(input);
  const approvalHandlers = useLiveMeetingInRoomVoiceToolingApprovalHandlers(input);

  return { ...panelHandlers, ...approvalHandlers };
}

function useLiveMeetingInRoomVoiceToolingEffects(input: {
  toolingInput: LiveMeetingInRoomVoiceToolingInput;
  handlers: LiveMeetingInRoomVoiceToolingHandlers;
}): void {
  const { toolingInput, handlers } = input;

  useEffect(() => {
    runLiveMeetingCloseToolApprovalPanelWhenEmptyEffect({
      toolApprovalCardCount: toolingInput.toolApprovalCards.length,
      setIsToolApprovalPanelOpen: toolingInput.setIsToolApprovalPanelOpen,
    });
  }, [toolingInput.setIsToolApprovalPanelOpen, toolingInput.toolApprovalCards.length]);

  useEffect(() => {
    if (!toolingInput.room) {
      return;
    }

    return runLiveMeetingRoomRpcMethodRegistrationEffect({
      room: toolingInput.room,
      connectionState: toolingInput.connectionState,
      rpcMethod: TOOL_CONNECTION_REQUEST_RPC,
      meetingId: toolingInput.meetingRecordId,
      handleRpcInvocation: ({ payload }) => handlers.showToolApprovalPanelFromVoice(payload),
    });
  }, [
    handlers.showToolApprovalPanelFromVoice,
    toolingInput.connectionState,
    toolingInput.meetingRecordId,
    toolingInput.room,
  ]);

  useEffect(() => {
    if (!toolingInput.room) {
      return;
    }

    return runLiveMeetingRoomRpcMethodRegistrationEffect({
      room: toolingInput.room,
      connectionState: toolingInput.connectionState,
      rpcMethod: WEB_SEARCH_RESULTS_RPC,
      meetingId: toolingInput.meetingRecordId,
      handleRpcInvocation: ({ payload }) => handlers.showWebSearchPanelFromVoice(payload),
    });
  }, [
    handlers.showWebSearchPanelFromVoice,
    toolingInput.connectionState,
    toolingInput.meetingRecordId,
    toolingInput.room,
  ]);

  useEffect(() => {
    if (!toolingInput.room || !toolingInput.meeting || toolingInput.connectionState !== ConnectionState.Connected) {
      return;
    }

    return runLiveMeetingMeetingAnswerResultsRpcEffect({
      room: toolingInput.room,
      meeting: toolingInput.meeting,
      showWebSearchPanelFromVoice: handlers.showWebSearchPanelFromVoice,
    });
  }, [
    handlers.showWebSearchPanelFromVoice,
    toolingInput.connectionState,
    toolingInput.meetingRecordId,
    toolingInput.room,
  ]);

  useEffect(() => {
    if (!toolingInput.room || toolingInput.connectionState !== ConnectionState.Connected) {
      return;
    }

    return runLiveMeetingLinearActionPanelRpcEffect({
      room: toolingInput.room,
      meetingId: toolingInput.meetingRecordId,
      showLinearActionPanelFromVoice: handlers.showLinearActionPanelFromVoice,
    });
  }, [
    handlers.showLinearActionPanelFromVoice,
    toolingInput.connectionState,
    toolingInput.meetingRecordId,
    toolingInput.room,
  ]);

  useEffect(() => {
    return runLiveMeetingCalendarOAuthMessageEffect({
      meetingId: toolingInput.meetingId,
      calendarOAuthPopupRef: toolingInput.calendarOAuthPopupRef,
      setIsToolApprovalPanelOpen: toolingInput.setIsToolApprovalPanelOpen,
      setToolApprovalCards: toolingInput.setToolApprovalCards,
      showToast: toolingInput.showToast,
      refreshAgentContextAfterCalendarConnect: ({ provider }) =>
        handlers.performAssistantRpc({
          method: REFRESH_AGENT_CONTEXT_RPC,
          payload: JSON.stringify({
            event: "calendar_connected",
            provider,
          }),
        }),
    });
  }, [handlers.performAssistantRpc, toolingInput.meetingId, toolingInput.showToast]);
}

function useLiveMeetingInRoomVoiceTooling(input: LiveMeetingInRoomVoiceToolingInput) {
  const handlers = useLiveMeetingInRoomVoiceToolingHandlers(input);
  useLiveMeetingInRoomVoiceToolingEffects({ toolingInput: input, handlers });

  return {
    performAssistantRpc: handlers.performAssistantRpc,
    connectCalendarFromApprovalCard: handlers.connectCalendarFromApprovalCard,
    disconnectCalendarFromApprovalCard: handlers.disconnectCalendarFromApprovalCard,
    requestWorkflowFromApprovalCard: handlers.requestWorkflowFromApprovalCard,
    handleLinearActionAllow: handlers.handleLinearActionAllow,
    handleLinearActionCancel: handlers.handleLinearActionCancel,
  };
}

type LiveMeetingJoinRequestModerationInput = {
  meeting: Meeting | null;
  activeSession: AuthSession | null;
  canCheckJoinRequests: boolean;
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<AuthSession | null>;
  realtimeClient: ReturnType<typeof useRealtimeClient>["client"];
  realtimeScopeKey: string;
  refreshRealtimeAuth: ReturnType<typeof useRealtimeClient>["refreshRealtimeAuth"];
  setError: Dispatch<SetStateAction<string | null>>;
};

async function decideLiveMeetingJoinRequest(input: {
  meeting: Meeting;
  activeSession: AuthSession;
  requestId: string;
  decision: "admit" | "deny";
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<AuthSession | null>;
  setJoinRequests: Dispatch<SetStateAction<MeetingJoinRequest[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setJoinRequestDecisionId: Dispatch<SetStateAction<string | null>>;
}): Promise<void> {
  input.setJoinRequestDecisionId(input.requestId);
  try {
    const runDecision = (token: string) => {
      const request = {
        token,
        meetingId: input.meeting.id,
        requestId: input.requestId,
        signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
      };

      return input.decision === "admit" ? admitMeetingJoinRequest(request) : denyMeetingJoinRequest(request);
    };
    const updated = await (async () => {
      try {
        return await runDecision(input.activeSession.token);
      } catch (nextError) {
        const nextSession = await input.refreshAuthAfterUnauthorized(nextError);
        if (!nextSession) {
          throw nextError;
        }

        return runDecision(nextSession.token);
      }
    })();
    input.setJoinRequests((current) =>
      updated.status === "waiting"
        ? current.map((request) => (request.id === updated.id ? updated : request))
        : current.filter((request) => request.id !== updated.id),
    );
    input.setError(null);
  } catch (nextError) {
    if (!reportOptionalLiveServiceFailure({ error: nextError, feature: "realtime" })) {
      input.setError(
        getErrorMessage({
          error: nextError,
          fallback: input.decision === "admit" ? "Failed to admit guest" : "Failed to deny guest",
        }),
      );
    }
  } finally {
    input.setJoinRequestDecisionId(null);
  }
}

function useLiveMeetingJoinRequestModerationEffects(input: {
  moderationInput: LiveMeetingJoinRequestModerationInput;
  isJoinRequestsOpen: boolean;
  setIsJoinRequestsOpen: Dispatch<SetStateAction<boolean>>;
  canModerateJoinRequests: boolean;
  canPollJoinRequests: boolean;
  joinRequestsMenuRef: { current: HTMLDivElement | null };
  joinRequestsRealtimeAuthRef: { current: string | null };
  setJoinRequests: Dispatch<SetStateAction<MeetingJoinRequest[]>>;
  loadJoinRequests: () => Promise<void>;
}): void {
  useEffect(() => {
    return runLiveMeetingPointerOutsideCloseEffect({
      isOpen: input.isJoinRequestsOpen,
      menuRef: input.joinRequestsMenuRef,
      onClose: () => input.setIsJoinRequestsOpen(false),
    });
  }, [input.isJoinRequestsOpen, input.joinRequestsMenuRef, input.setIsJoinRequestsOpen]);

  useMeetingJoinRequestWatch({
    client: input.moderationInput.realtimeClient,
    meetingId: input.moderationInput.meeting?.id,
    workspaceId: input.moderationInput.meeting?.workspaceId,
    scopeKey: input.moderationInput.realtimeScopeKey,
    isEnabled: input.canModerateJoinRequests && input.moderationInput.meeting?.status !== "ended",
    isPollingEnabled:
      Boolean(input.moderationInput.meeting && input.moderationInput.activeSession) &&
      input.moderationInput.meeting?.status !== "ended" &&
      input.moderationInput.canCheckJoinRequests &&
      input.canPollJoinRequests,
    refreshAuth: input.moderationInput.refreshRealtimeAuth,
    authScopeRef: input.joinRequestsRealtimeAuthRef,
    refresh: input.loadJoinRequests,
    setJoinRequests: input.setJoinRequests,
  });
}

function useLiveMeetingJoinRequestModeration(input: LiveMeetingJoinRequestModerationInput) {
  const {
    joinRequests,
    setJoinRequests,
    isJoinRequestsLoading,
    canModerateJoinRequests,
    canPollJoinRequests,
    loadJoinRequests,
  } = useJoinRequestsRefresh({
    meetingId: input.meeting?.id,
    token: input.activeSession?.token,
    scopeKey: input.realtimeScopeKey,
    isEnabled: input.canCheckJoinRequests && input.meeting?.status !== "ended",
    refreshAuthAfterUnauthorized: input.refreshAuthAfterUnauthorized,
  });
  const [isJoinRequestsOpen, setIsJoinRequestsOpen] = useState(false);
  const [joinRequestDecisionId, setJoinRequestDecisionId] = useState<string | null>(null);
  const joinRequestsRealtimeAuthRef = useRef<string | null>(null);
  const joinRequestsMenuRef = useRef<HTMLDivElement | null>(null);

  const decideJoinRequest = useCallback(
    async (requestId: string, decision: "admit" | "deny") => {
      const meeting = input.meeting;
      const activeSession = input.activeSession;
      if (!meeting || !activeSession || !canModerateJoinRequests) {
        return;
      }

      await decideLiveMeetingJoinRequest({
        meeting,
        activeSession,
        requestId,
        decision,
        refreshAuthAfterUnauthorized: input.refreshAuthAfterUnauthorized,
        setJoinRequests,
        setError: input.setError,
        setJoinRequestDecisionId,
      });
    },
    [
      canModerateJoinRequests,
      input.activeSession,
      input.meeting,
      input.refreshAuthAfterUnauthorized,
      input.setError,
      setJoinRequests,
    ],
  );

  useLiveMeetingJoinRequestModerationEffects({
    moderationInput: input,
    isJoinRequestsOpen,
    setIsJoinRequestsOpen,
    canModerateJoinRequests,
    canPollJoinRequests,
    joinRequestsMenuRef,
    joinRequestsRealtimeAuthRef,
    setJoinRequests,
    loadJoinRequests,
  });

  return {
    joinRequests,
    isJoinRequestsOpen,
    setIsJoinRequestsOpen,
    isJoinRequestsLoading,
    joinRequestDecisionId,
    canModerateJoinRequests,
    joinRequestsMenuRef,
    decideJoinRequest,
  };
}

type LiveMeetingWebSearchPanelLifecycleInput = {
  webSearchPanelState: WebSearchPanelState | null;
  setWebSearchPanelState: Dispatch<SetStateAction<WebSearchPanelState | null>>;
  setWebSearchHistory: Dispatch<SetStateAction<WebSearchPanelState[]>>;
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  webSearchPanelRunIdRef: { current: number };
  webSearchDeferredPayloadTimerRef: { current: number | null };
  webSearchDeferredPayloadResolveRef: { current: ((applied: boolean) => void) | null };
  liveRoomJoiningInfoCopiedTimerRef: { current: number | null };
  activeSession: AuthSession | null;
  activeSessionToken: string | undefined;
  activeSessionUserSource: AuthSession["user"]["source"] | undefined;
  meeting: Meeting | null;
  meetingRecordId: string | undefined;
  sessionToken: string | undefined;
  isAmbientContextPanelOpen: boolean;
};

function useLiveMeetingWebSearchPanelUnmountEffects(
  input: Pick<
    LiveMeetingWebSearchPanelLifecycleInput,
    "webSearchDeferredPayloadTimerRef" | "webSearchDeferredPayloadResolveRef" | "liveRoomJoiningInfoCopiedTimerRef"
  >,
): void {
  useEffect(() => {
    return runLiveMeetingWebSearchPanelUnmountCleanupEffect({
      webSearchDeferredPayloadTimerRef: input.webSearchDeferredPayloadTimerRef,
      webSearchDeferredPayloadResolveRef: input.webSearchDeferredPayloadResolveRef,
    });
  }, [input.webSearchDeferredPayloadResolveRef, input.webSearchDeferredPayloadTimerRef]);

  useEffect(() => {
    return runLiveMeetingLiveRoomJoiningInfoCopiedTimerUnmountCleanupEffect({
      liveRoomJoiningInfoCopiedTimerRef: input.liveRoomJoiningInfoCopiedTimerRef,
    });
  }, [input.liveRoomJoiningInfoCopiedTimerRef]);
}

function useLiveMeetingWebSearchPanelLifecycle(input: LiveMeetingWebSearchPanelLifecycleInput): void {
  const webSearchPanelRevisionDeps = getLiveMeetingWebSearchPanelRevisionDeps(input.webSearchPanelState);

  useEffect(() => {
    return runLiveMeetingWebSearchPanelIdleTimeoutEffect({
      webSearchPanelState: input.webSearchPanelState,
      webSearchPanelRunIdRef: input.webSearchPanelRunIdRef,
      webSearchPanelStateRef: input.webSearchPanelStateRef,
      updateWebSearchPanelState: input.updateWebSearchPanelState,
    });
  }, [
    input.updateWebSearchPanelState,
    input.webSearchPanelRunIdRef,
    input.webSearchPanelState,
    input.webSearchPanelStateRef,
    webSearchPanelRevisionDeps.findallId,
    webSearchPanelRevisionDeps.researchRunId,
    webSearchPanelRevisionDeps.searchId,
    webSearchPanelRevisionDeps.sessionId,
    webSearchPanelRevisionDeps.status,
    webSearchPanelRevisionDeps.updatedAt,
  ]);

  useEffect(() => {
    if (
      !hasAuthSession(input.activeSession) ||
      input.activeSession.user.source === "guest" ||
      !hasMeetingRecord(input.meeting)
    ) {
      return;
    }

    return runLiveMeetingWebSearchPersistedHistoryLoadEffect({
      activeSession: input.activeSession,
      meeting: input.meeting,
      webSearchPanelStateRef: input.webSearchPanelStateRef,
      setWebSearchHistory: input.setWebSearchHistory,
      setWebSearchPanelState: input.setWebSearchPanelState,
    });
  }, [
    input.activeSession,
    input.activeSessionToken,
    input.activeSessionUserSource,
    input.meeting,
    input.meetingRecordId,
    input.setWebSearchHistory,
    input.setWebSearchPanelState,
    input.webSearchPanelStateRef,
  ]);

  useLiveMeetingWebSearchPanelUnmountEffects(input);

  useEffect(() => {
    if (input.sessionToken === undefined || input.sessionToken.length === 0 || !input.isAmbientContextPanelOpen) {
      return;
    }

    return runLiveMeetingWebSearchAmbientPanelPollEffect({
      token: input.sessionToken,
      webSearchPanelState: input.webSearchPanelState,
      webSearchPanelRunIdRef: input.webSearchPanelRunIdRef,
      webSearchPanelStateRef: input.webSearchPanelStateRef,
      updateWebSearchPanelState: input.updateWebSearchPanelState,
    });
  }, [
    input.isAmbientContextPanelOpen,
    input.sessionToken,
    input.updateWebSearchPanelState,
    input.webSearchPanelRunIdRef,
    input.webSearchPanelState,
    input.webSearchPanelStateRef,
    webSearchPanelRevisionDeps.findallId,
    webSearchPanelRevisionDeps.meetingId,
    webSearchPanelRevisionDeps.query,
    webSearchPanelRevisionDeps.researchRunId,
    webSearchPanelRevisionDeps.searchId,
    webSearchPanelRevisionDeps.sessionId,
    webSearchPanelRevisionDeps.status,
  ]);
}

type LiveMeetingLiveRoomBootstrapEffectsInput = {
  endMeetingFlow: EndMeetingFlowState | null;
  liveVideoGridRef: { current: HTMLDivElement | null };
  setLiveVideoGridSize: Dispatch<SetStateAction<{ width: number; height: number; gap: number }>>;
  room: Room | null;
  presenceVersion: number;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
  setAudioInputDevices: Dispatch<SetStateAction<MediaDeviceInfo[]>>;
  setVideoInputDevices: Dispatch<SetStateAction<MediaDeviceInfo[]>>;
  setAudioDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setLiveRoomClock: Dispatch<SetStateAction<string>>;
  setLiveRoomOrigin: Dispatch<SetStateAction<string>>;
  setEndMeetingFlowNow: Dispatch<SetStateAction<number>>;
  activeSession: AuthSession | null;
  meetingId: string;
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<AuthSession | null>;
  setError: Dispatch<SetStateAction<string | null>>;
  setMeeting: Dispatch<SetStateAction<Meeting | null>>;
  setEndedMeetingHistoryVisibility: Dispatch<SetStateAction<EndedMeetingHistoryVisibility>>;
  setActiveHumanParticipants: Dispatch<
    SetStateAction<MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"]>
  >;
  isPresencePanelOpen: boolean;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  isMeetingDetailsPanelOpen: boolean;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  isMeetingSettingsPanelOpen: boolean;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  isEndMeetingMenuOpen: boolean;
  endMeetingMenuRef: { current: HTMLDivElement | null };
  setIsEndMeetingMenuOpen: Dispatch<SetStateAction<boolean>>;
  realtimeClient: ReturnType<typeof useRealtimeClient>["client"];
  meeting: Meeting | null;
  hasJoinedMeeting: boolean;
  isGuestSession: boolean;
  refreshRealtimeAuth: ReturnType<typeof useRealtimeClient>["refreshRealtimeAuth"];
  router: ReturnType<typeof useRouter>;
  connectionState: ConnectionState;
};

function useLiveMeetingLiveRoomMediaBootstrapEffects(
  input: Pick<
    LiveMeetingLiveRoomBootstrapEffectsInput,
    | "endMeetingFlow"
    | "liveVideoGridRef"
    | "setLiveVideoGridSize"
    | "room"
    | "presenceVersion"
    | "setAssistantDisplayNamesByIdentity"
    | "setAudioInputDevices"
    | "setVideoInputDevices"
    | "setAudioDeviceId"
    | "setVideoDeviceId"
    | "setLiveRoomClock"
    | "setLiveRoomOrigin"
    | "setEndMeetingFlowNow"
  >,
): void {
  useEffect(() => {
    return runLiveMeetingLiveRoomClockEffect({
      setLiveRoomClock: input.setLiveRoomClock,
      setLiveRoomOrigin: input.setLiveRoomOrigin,
    });
  }, [input.setLiveRoomClock, input.setLiveRoomOrigin]);

  useEffect(() => {
    return runLiveMeetingEndMeetingFlowTickEffect({
      endMeetingFlow: input.endMeetingFlow,
      setEndMeetingFlowNow: input.setEndMeetingFlowNow,
    });
  }, [input.endMeetingFlow, input.setEndMeetingFlowNow]);

  useEffect(() => {
    return runLiveMeetingLiveVideoGridResizeEffect({
      liveVideoGridRef: input.liveVideoGridRef,
      setLiveVideoGridSize: input.setLiveVideoGridSize,
    });
  }, [input.liveVideoGridRef, input.setLiveVideoGridSize]);

  useEffect(() => {
    if (!input.room) {
      return;
    }

    runLiveMeetingAssistantDisplayNamesFromRoomEffect({
      room: input.room,
      presenceVersion: input.presenceVersion,
      setAssistantDisplayNamesByIdentity: input.setAssistantDisplayNamesByIdentity,
    });
  }, [input.presenceVersion, input.room, input.setAssistantDisplayNamesByIdentity]);

  useEffect(() => {
    return runLiveMeetingMediaDevicesEnumerationEffect({
      setAudioInputDevices: input.setAudioInputDevices,
      setVideoInputDevices: input.setVideoInputDevices,
      setAudioDeviceId: input.setAudioDeviceId,
      setVideoDeviceId: input.setVideoDeviceId,
    });
  }, [input.setAudioDeviceId, input.setAudioInputDevices, input.setVideoDeviceId, input.setVideoInputDevices]);
}

function useLiveMeetingLiveRoomMeetingBootstrapEffects(input: LiveMeetingLiveRoomBootstrapEffectsInput): void {
  useEffect(() => {
    if (!input.activeSession) {
      return;
    }

    return runLiveMeetingLoadLiveMeetingDetailEffect({
      activeSession: input.activeSession,
      meetingId: input.meetingId,
      refreshAuthAfterUnauthorized: input.refreshAuthAfterUnauthorized,
      room: input.room,
      setError: input.setError,
      setMeeting: input.setMeeting,
      setEndedMeetingHistoryVisibility: input.setEndedMeetingHistoryVisibility,
      setActiveHumanParticipants: input.setActiveHumanParticipants,
    });
  }, [
    input.activeSession,
    input.meetingId,
    input.refreshAuthAfterUnauthorized,
    input.room,
    input.setActiveHumanParticipants,
    input.setEndedMeetingHistoryVisibility,
    input.setError,
    input.setMeeting,
  ]);

  useEffect(() => {
    return runLiveMeetingEscapeKeyCloseEffect({
      isOpen: input.isPresencePanelOpen,
      onClose: () => input.setIsPresencePanelOpen(false),
    });
  }, [input.isPresencePanelOpen, input.setIsPresencePanelOpen]);

  useEffect(() => {
    return runLiveMeetingEscapeKeyCloseEffect({
      isOpen: input.isMeetingDetailsPanelOpen,
      onClose: () => input.setIsMeetingDetailsPanelOpen(false),
    });
  }, [input.isMeetingDetailsPanelOpen, input.setIsMeetingDetailsPanelOpen]);

  useEffect(() => {
    return runLiveMeetingEscapeKeyCloseEffect({
      isOpen: input.isMeetingSettingsPanelOpen,
      onClose: () => input.setIsMeetingSettingsPanelOpen(false),
    });
  }, [input.isMeetingSettingsPanelOpen, input.setIsMeetingSettingsPanelOpen]);

  useEffect(() => {
    return runLiveMeetingPointerOutsideCloseEffect({
      isOpen: input.isEndMeetingMenuOpen,
      menuRef: input.endMeetingMenuRef,
      onClose: () => input.setIsEndMeetingMenuOpen(false),
    });
  }, [input.endMeetingMenuRef, input.isEndMeetingMenuOpen, input.setIsEndMeetingMenuOpen]);

  useEffect(() => {
    if (!input.realtimeClient || !input.meeting) {
      return;
    }

    return runLiveMeetingConfidentialityRealtimeSubscriptionEffect({
      realtimeClient: input.realtimeClient,
      meeting: input.meeting,
      hasJoinedMeeting: input.hasJoinedMeeting,
      isGuestSession: input.isGuestSession,
      refreshRealtimeAuth: input.refreshRealtimeAuth,
      setMeeting: input.setMeeting,
    });
  }, [
    input.hasJoinedMeeting,
    input.isGuestSession,
    input.meeting,
    input.realtimeClient,
    input.refreshRealtimeAuth,
    input.setMeeting,
  ]);

  useEffect(() => {
    if (!input.meeting) {
      return;
    }

    runLiveMeetingNotesRoutePrefetchEffect({
      router: input.router,
      meeting: input.meeting,
      isGuestSession: input.isGuestSession,
    });
  }, [input.isGuestSession, input.meeting, input.router]);
}

function useLiveMeetingLiveRoomBootstrapEffects(input: LiveMeetingLiveRoomBootstrapEffectsInput): void {
  useLiveMeetingLiveRoomMediaBootstrapEffects(input);
  useLiveMeetingLiveRoomMeetingBootstrapEffects(input);
}

function applyLiveMeetingAssistantPresencePayload(input: {
  assistantPresence: AssistantPresencePayload;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
}): void {
  const assistantPresence = input.assistantPresence;
  if (assistantPresence.conversationModeActive === true && !input.voiceModeIntentRef.current.canActivate()) {
    return;
  }
  if (assistantPresence.conversationModeActive === true) {
    input.setSyncedConversationModeActive(true);
    input.setSyncedAgentHelpOwnerParticipantIdentity(assistantPresence.assistantOwnerParticipantIdentity ?? null);
  } else if (assistantPresence.conversationModeActive === false && !input.voiceModeRpcPendingRef.current) {
    input.setSyncedConversationModeActive(false);
  }

  if (assistantPresence.active === false) {
    if (!input.voiceModeRpcPendingRef.current) {
      input.setSyncedAgentHelpOwnerParticipantIdentity(null);
      input.setSyncedAgentHelpPhase("idle");
    }
  } else if (assistantPresence.active === true) {
    input.setSyncedAgentHelpOwnerParticipantIdentity(assistantPresence.assistantOwnerParticipantIdentity ?? null);
    if (assistantPresence.phase === "thinking") {
      input.setSyncedAgentHelpPhase("thinking");
    }
  }

  input.setAssistantDisplayNamesByIdentity((current) => {
    const existingDisplayName = current[assistantPresence.assistantIdentity];
    if (existingDisplayName === assistantPresence.assistantDisplayName) {
      return current;
    }
    if (
      existingDisplayName !== undefined &&
      existingDisplayName.length > 0 &&
      !isGenericAssistantSpeakerName(existingDisplayName) &&
      isGenericAssistantSpeakerName(assistantPresence.assistantDisplayName)
    ) {
      return current;
    }

    return {
      ...current,
      [assistantPresence.assistantIdentity]: assistantPresence.assistantDisplayName,
    };
  });
}

function useLiveMeetingTranscriptPresenceLayout(input: {
  activeHumanParticipants: MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"];
  activeSession: AuthSession | null;
  room: Room | null;
  tracks: TrackView[];
  presenceVersion: number;
  liveTranscriptSegments: MeetingDetailPayload["transcriptSegments"];
  realtimeTranscriptLines: LiveTranscriptLine[];
  activeSessionUserId: string | undefined;
  assistantDisplayNamesByIdentity: Record<string, string>;
  isTranscriptVisible: boolean;
  transcriptionState: TranscriptionState;
  isCaptionSpeechActive: boolean;
  transcriptBottomRef: { current: HTMLDivElement | null };
  setSeenTranscriptLineIds: Dispatch<SetStateAction<Set<string> | null>>;
}): {
  participantAvatarUrls: {
    avatarUrlsByUserId: Map<string, string | null | undefined>;
    avatarUrlsByDisplayName: Map<string, string | null | undefined>;
  };
  presenceEntries: PresenceEntry[];
  visibleTranscriptLines: VisibleTranscriptLine[];
  shouldShowLiveTranscript: boolean;
  isCaptionsWaveActive: boolean;
} {
  const participantAvatarUrls = useMemo(() => {
    const avatarUrlsByUserId = new Map(
      input.activeHumanParticipants.map((participant) => [participant.userId, participant.avatarUrl]),
    );
    const avatarUrlsByDisplayName = new Map(
      input.activeHumanParticipants.map((participant) => [
        participant.displayName.trim().toLowerCase(),
        participant.avatarUrl,
      ]),
    );

    return { avatarUrlsByUserId, avatarUrlsByDisplayName };
  }, [input.activeHumanParticipants]);

  const presenceEntries = useMemo<PresenceEntry[]>(
    () =>
      buildLiveMeetingPresenceEntries({
        activeSession: input.activeSession,
        room: input.room,
        tracks: input.tracks,
        participantAvatarUrls,
        presenceVersion: input.presenceVersion,
      }),
    [input.activeSession, input.presenceVersion, input.room, input.tracks, participantAvatarUrls],
  );

  const visibleTranscriptLines = useMemo<VisibleTranscriptLine[]>(
    () =>
      mergeLiveTranscriptLines({
        liveTranscriptSegments: input.liveTranscriptSegments,
        realtimeTranscriptLines: input.realtimeTranscriptLines,
        presenceEntries,
        localUserId: input.activeSessionUserId,
        assistantDisplayNamesByIdentity: input.assistantDisplayNamesByIdentity,
      }),
    [
      input.assistantDisplayNamesByIdentity,
      input.liveTranscriptSegments,
      input.realtimeTranscriptLines,
      input.activeSessionUserId,
      presenceEntries,
    ],
  );
  const shouldShowLiveTranscript = input.isTranscriptVisible;
  const isCaptionsWaveActive = isLiveMeetingCaptionsWaveActive({
    transcriptionState: input.transcriptionState,
    isCaptionSpeechActive: input.isCaptionSpeechActive,
  });

  useEffect(() => {
    return runLiveMeetingTranscriptAutoScrollEffect({
      shouldShowLiveTranscript,
      transcriptBottomRef: input.transcriptBottomRef,
      visibleTranscriptLines,
    });
  }, [input.transcriptBottomRef, shouldShowLiveTranscript, visibleTranscriptLines]);

  useEffect(() => {
    runLiveMeetingSeenTranscriptLineIdsEffect({
      visibleTranscriptLines,
      setSeenTranscriptLineIds: input.setSeenTranscriptLineIds,
    });
  }, [input.setSeenTranscriptLineIds, visibleTranscriptLines]);

  return {
    participantAvatarUrls,
    presenceEntries,
    visibleTranscriptLines,
    shouldShowLiveTranscript,
    isCaptionsWaveActive,
  };
}

function getLiveMeetingScreenShareBlockerPresentationState(input: {
  room: Room | null;
  dataPresentationClaimsByIdentity: Record<string, PresentationClaim>;
  presenceVersion: number;
  localScreenShareVisual: ScreenShareVisual | null;
  remoteScreenShareVisual: ScreenShareVisual | null;
}): { screenShareBlockerMessage: string | null; localPresentationClaim: PresentationClaim | null } {
  const startingPresentationClaims = buildLiveMeetingStartingPresentationClaims({
    room: input.room,
    dataPresentationClaimsByIdentity: input.dataPresentationClaimsByIdentity,
    presenceVersion: input.presenceVersion,
  });
  const freshStartingPresentationClaims = getFreshPresentationClaims({ claims: startingPresentationClaims });
  const winningPresentationClaim = chooseWinningPresentationClaim({ claims: freshStartingPresentationClaims });
  const localPresentationClaim = getLiveMeetingLocalPresentationClaim({
    room: input.room,
    freshStartingPresentationClaims,
  });
  const screenShareBlockerMessage = buildLiveMeetingScreenShareBlockerMessage({
    localScreenShareVisual: input.localScreenShareVisual,
    remoteScreenShareVisual: input.remoteScreenShareVisual,
    winningPresentationClaim,
    room: input.room,
  });

  return { screenShareBlockerMessage, localPresentationClaim };
}

function useLiveMeetingScreenSharePresentationSideEffects(input: {
  room: Room | null;
  isScreenShareFullscreen: boolean;
  endMeetingFlow: EndMeetingFlowState | null;
  hasActiveScreenShare: boolean;
  isScreenShareBusy: boolean;
  localPresentationClaim: PresentationClaim | null;
  localScreenShareVisual: ScreenShareVisual | null;
  remoteScreenShareVisual: ScreenShareVisual | null;
  screenShareVisuals: ScreenShareVisual[];
  onClearLocalPresentationIntent: () => Promise<void>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  useEffect(() => {
    runLiveMeetingExitFullscreenWithoutScreenShareEffect({
      hasActiveScreenShare: input.hasActiveScreenShare,
      isScreenShareFullscreen: input.isScreenShareFullscreen,
    });
  }, [input.hasActiveScreenShare, input.isScreenShareFullscreen]);

  useEffect(() => {
    runLiveMeetingCloseMeetingPanelsOnPresentationEffect({
      hasActiveScreenShare: input.hasActiveScreenShare,
      isScreenShareFullscreen: input.isScreenShareFullscreen,
      endMeetingFlow: input.endMeetingFlow,
      setIsMeetingDetailsPanelOpen: input.setIsMeetingDetailsPanelOpen,
      setIsMeetingSettingsPanelOpen: input.setIsMeetingSettingsPanelOpen,
    });
  }, [
    input.endMeetingFlow,
    input.hasActiveScreenShare,
    input.isScreenShareFullscreen,
    input.setIsMeetingDetailsPanelOpen,
    input.setIsMeetingSettingsPanelOpen,
  ]);

  useEffect(() => {
    runLiveMeetingSyncPinnedScreenShareTrackEffect({
      screenShareVisuals: input.screenShareVisuals,
      setPinnedScreenShareTrackId: input.setPinnedScreenShareTrackId,
    });
  }, [input.screenShareVisuals, input.setPinnedScreenShareTrackId]);

  useEffect(() => {
    if (!input.room || input.room.localParticipant.isScreenShareEnabled || input.isScreenShareBusy) {
      return;
    }

    if (!input.localPresentationClaim) {
      return;
    }

    void input.onClearLocalPresentationIntent();
  }, [input.isScreenShareBusy, input.localPresentationClaim, input.onClearLocalPresentationIntent, input.room]);

  useEffect(() => {
    const room = input.room;
    if (
      !room ||
      !room.localParticipant.isScreenShareEnabled ||
      !input.localScreenShareVisual ||
      !input.remoteScreenShareVisual
    ) {
      return;
    }

    void (async () => {
      try {
        await room.localParticipant.setScreenShareEnabled(false);
      } catch (error) {
        void describeCaughtFailure(error);
      }
    })();
    void input.onClearLocalPresentationIntent();
    input.setError(
      `${input.remoteScreenShareVisual.displayName} started presenting. Your screen share was stopped so only one presenter stays active.`,
    );
  }, [
    input.localScreenShareVisual,
    input.onClearLocalPresentationIntent,
    input.remoteScreenShareVisual,
    input.room,
    input.setError,
  ]);
}

function useLiveMeetingScreenSharePresentationLayout(input: {
  room: Room | null;
  session: AuthSession | null;
  tracks: TrackView[];
  pinnedScreenShareTrackId: string | null;
  isScreenShareFullscreen: boolean;
  endMeetingFlow: EndMeetingFlowState | null;
  dataPresentationClaimsByIdentity: Record<string, PresentationClaim>;
  presenceVersion: number;
  isScreenShareBusy: boolean;
  onClearLocalPresentationIntent: () => Promise<void>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
}): {
  selectedScreenShareVisual: ScreenShareVisual | null;
  hasActiveScreenShare: boolean;
  localScreenShareVisual: ScreenShareVisual | null;
  remoteScreenShareVisual: ScreenShareVisual | null;
  screenShareBlockerMessage: string | null;
} {
  const screenShareVisuals = useMemo<ScreenShareVisual[]>(
    () => buildLiveMeetingScreenShareVisuals({ room: input.room, session: input.session, tracks: input.tracks }),
    [input.room, input.session, input.tracks],
  );

  const { selectedScreenShareVisual, hasActiveScreenShare, localScreenShareVisual, remoteScreenShareVisual } =
    getLiveMeetingScreenSharePresentationState({
      screenShareVisuals,
      pinnedScreenShareTrackId: input.pinnedScreenShareTrackId,
    });

  const { screenShareBlockerMessage, localPresentationClaim } = useMemo(
    () =>
      getLiveMeetingScreenShareBlockerPresentationState({
        room: input.room,
        dataPresentationClaimsByIdentity: input.dataPresentationClaimsByIdentity,
        presenceVersion: input.presenceVersion,
        localScreenShareVisual,
        remoteScreenShareVisual,
      }),
    [
      input.dataPresentationClaimsByIdentity,
      input.presenceVersion,
      input.room,
      localScreenShareVisual,
      remoteScreenShareVisual,
    ],
  );

  useLiveMeetingScreenSharePresentationSideEffects({
    room: input.room,
    isScreenShareFullscreen: input.isScreenShareFullscreen,
    endMeetingFlow: input.endMeetingFlow,
    hasActiveScreenShare,
    isScreenShareBusy: input.isScreenShareBusy,
    localPresentationClaim,
    localScreenShareVisual,
    remoteScreenShareVisual,
    screenShareVisuals,
    onClearLocalPresentationIntent: input.onClearLocalPresentationIntent,
    setPinnedScreenShareTrackId: input.setPinnedScreenShareTrackId,
    setError: input.setError,
    setIsMeetingDetailsPanelOpen: input.setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen: input.setIsMeetingSettingsPanelOpen,
  });

  return {
    selectedScreenShareVisual,
    hasActiveScreenShare,
    localScreenShareVisual,
    remoteScreenShareVisual,
    screenShareBlockerMessage,
  };
}

function getLiveMeetingMultiParticipantGridStyle(
  liveVideoGridLayout: ReturnType<typeof getLiveVideoGridLayout>,
): React.CSSProperties | undefined {
  if (!liveVideoGridLayout) {
    return undefined;
  }

  const { columns, tileWidth, tileHeight, isLastTileCentered } = liveVideoGridLayout;

  const layoutCssVariables: Record<string, string> = isLastTileCentered
    ? { "--live-three-person-tile-width": `${tileWidth}px` }
    : {};

  return {
    gridTemplateColumns: `repeat(${columns}, minmax(0, ${tileWidth}px))`,
    gridAutoRows: `${tileHeight}px`,
    justifyContent: "center",
    ...layoutCssVariables,
  };
}

function useLiveMeetingParticipantVideoStage(input: {
  room: Room | null;
  session: AuthSession | null;
  isCamEnabled: boolean;
  tracks: TrackView[];
  participantAvatarUrls: {
    avatarUrlsByUserId: Map<string, string | null | undefined>;
    avatarUrlsByDisplayName: Map<string, string | null | undefined>;
  };
  participantSpeechStore: ReturnType<typeof createParticipantSpeechStore>;
  presenceVersion: number;
  liveVideoGridSize: { width: number; height: number; gap: number };
  hasActiveScreenShare: boolean;
  meeting: Meeting | null;
  connectionState: ConnectionState;
  isMeetingHost: boolean;
  isRoomRevealed: boolean;
  liveVideoGridRef: { current: HTMLDivElement | null };
  setIsRoomRevealed: Dispatch<SetStateAction<boolean>>;
  setIsControlsRevealed: Dispatch<SetStateAction<boolean>>;
  setIsAvatarRevealed: Dispatch<SetStateAction<boolean>>;
}): {
  participantVisuals: ParticipantVisual[];
  liveVideoGridLayout: ReturnType<typeof getLiveVideoGridLayout>;
  liveVideoGridStyle: React.CSSProperties | undefined;
  renderParticipantVisual: (participant: ParticipantVisual) => ReactNode;
} {
  const participantVisuals = useMemo<ParticipantVisual[]>(
    () =>
      buildLiveMeetingParticipantVisuals({
        room: input.room,
        session: input.session,
        isCamEnabled: input.isCamEnabled,
        tracks: input.tracks,
        participantAvatarUrls: input.participantAvatarUrls,
        participantSpeechStore: input.participantSpeechStore,
        presenceVersion: input.presenceVersion,
      }),
    [
      input.isCamEnabled,
      input.participantAvatarUrls,
      input.participantSpeechStore,
      input.presenceVersion,
      input.room,
      input.session,
      input.tracks,
    ],
  );
  const participantVisualSignature = useMemo(
    () => participantVisuals.map((participant) => participant.id).join("|"),
    [participantVisuals],
  );
  const liveVideoGridLayout = useMemo(
    () =>
      getLiveVideoGridLayout({
        count: participantVisuals.length,
        ...input.liveVideoGridSize,
        aspectRatio: LIVE_TILE_ASPECT_RATIO,
      }),
    [LIVE_TILE_ASPECT_RATIO, input.liveVideoGridSize, participantVisuals.length],
  );
  const multiParticipantGridStyle = useMemo(
    () => getLiveMeetingMultiParticipantGridStyle(liveVideoGridLayout),
    [liveVideoGridLayout],
  );
  const liveVideoGridStyle = getLiveMeetingLiveVideoGridStyle({
    hasActiveScreenShare: input.hasActiveScreenShare,
    multiParticipantGridStyle,
  });
  const isReadyForEntrance = isLiveMeetingReadyForRoomEntrance({
    meeting: input.meeting,
    room: input.room,
    connectionState: input.connectionState,
    participantVisualCount: participantVisuals.length,
  });

  useEffect(() => {
    return runLiveMeetingRoomRevealEntranceEffect({
      isReadyForEntrance,
      setIsRoomRevealed: input.setIsRoomRevealed,
      setIsControlsRevealed: input.setIsControlsRevealed,
      setIsAvatarRevealed: input.setIsAvatarRevealed,
    });
  }, [input.setIsAvatarRevealed, input.setIsControlsRevealed, input.setIsRoomRevealed, isReadyForEntrance]);

  useParticipantTileTransition(
    input.liveVideoGridRef,
    participantVisualSignature,
    shouldRunLiveMeetingParticipantTileTransition({
      isMeetingHost: input.isMeetingHost,
      isRoomRevealed: input.isRoomRevealed,
      connectionState: input.connectionState,
      hasActiveScreenShare: input.hasActiveScreenShare,
    }),
    liveVideoGridStyle,
  );

  const renderParticipantVisual = useCallback((participant: ParticipantVisual) => {
    return <ParticipantMediaTile participant={participant} />;
  }, []);

  return { participantVisuals, liveVideoGridLayout, liveVideoGridStyle, renderParticipantVisual };
}

type LiveMeetingAmbientContextPipelineInput = {
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  meetingRecordId: string | undefined;
  hasJoinedMeeting: boolean;
  isGuestSession: boolean;
  isAmbientContextEnabled: boolean;
  realtimeClient: ReturnType<typeof useRealtimeClient>["client"];
  realtimeScopeKey: ReturnType<typeof useRealtimeClient>["scopeKey"];
  refreshRealtimeAuth: ReturnType<typeof useRealtimeClient>["refreshRealtimeAuth"];
  peopleMemoryItems: ReturnType<typeof useMeetingPeopleMemory>;
};

function createLiveMeetingAmbientContextRefresh(input: {
  isAmbientContextEnabled: boolean;
  ambientContextToken: string | undefined;
  meetingRecordId: string | undefined;
  hasJoinedMeeting: boolean;
  setAmbientContextItems: Dispatch<SetStateAction<MeetingAmbientContextItem[]>>;
}) {
  return createQueuedRefresh(async () => {
    if (
      !input.isAmbientContextEnabled ||
      input.ambientContextToken === undefined ||
      input.meetingRecordId === undefined ||
      !input.hasJoinedMeeting
    ) {
      return;
    }
    try {
      const items = await listMeetingAmbientContext({
        token: input.ambientContextToken,
        meetingId: input.meetingRecordId,
        signal: AbortSignal.timeout(AMBIENT_CONTEXT_LIST_TIMEOUT_MS),
      });
      input.setAmbientContextItems(items);
    } catch (nextError) {
      if (!reportOptionalLiveServiceFailure({ error: nextError, feature: "research" })) {
        console.error("[readymeet:ambient-context] Failed to load meeting context.");
      }
    }
  });
}

function useLiveMeetingAmbientContextImageEffects(input: {
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  ambientContextItems: MeetingAmbientContextItem[];
  ambientContextImageUrls: Record<string, string>;
  setAmbientContextImageUrls: Dispatch<SetStateAction<Record<string, string>>>;
  ambientContextImageUrlsRef: { current: Record<string, string> };
  ambientContextImageSourcesRef: { current: Record<string, string> };
  ambientContextImageLoadsRef: { current: Set<string> };
}): void {
  useEffect(() => {
    const ambientContextImageUrlsRef = input.ambientContextImageUrlsRef;
    ambientContextImageUrlsRef.current = input.ambientContextImageUrls;
  }, [input.ambientContextImageUrls, input.ambientContextImageUrlsRef]);

  useEffect(() => {
    if (!hasAuthSession(input.activeSession) || !hasMeetingRecord(input.meeting)) {
      return;
    }

    return runLiveMeetingAmbientContextImagesEffect({
      activeSession: input.activeSession,
      meeting: input.meeting,
      ambientContextItems: input.ambientContextItems,
      ambientContextImageSourcesRef: input.ambientContextImageSourcesRef,
      ambientContextImageLoadsRef: input.ambientContextImageLoadsRef,
      setAmbientContextImageUrls: input.setAmbientContextImageUrls,
    });
  }, [input.activeSession, input.ambientContextItems, input.meeting]);

  useEffect(() => {
    return () => {
      Object.values(input.ambientContextImageUrlsRef.current).forEach((objectUrl) => {
        URL.revokeObjectURL(objectUrl);
      });
    };
  }, [input.ambientContextImageUrlsRef]);
}

function useLiveMeetingAmbientContextPipeline(input: LiveMeetingAmbientContextPipelineInput) {
  const [rawAmbientContextItems, setAmbientContextItems] = useState<MeetingAmbientContextItem[]>([]);
  const [ambientContextImageUrls, setAmbientContextImageUrls] = useState<Record<string, string>>({});
  const ambientContextImageUrlsRef = useRef<Record<string, string>>({});
  const ambientContextImageSourcesRef = useRef<Record<string, string>>({});
  const ambientContextImageLoadsRef = useRef(new Set<string>());
  const privateDetailsToken = getLiveMeetingPrivateDetailsToken({
    isGuestSession: input.isGuestSession,
    activeSession: input.activeSession,
  });
  const loadAmbientPrivateDetails = useMemo(
    () =>
      buildLiveMeetingAmbientPrivateDetailsLoader({
        privateDetailsToken,
        meetingIdForPrivateDetails: input.meetingRecordId,
      }),
    [input.meetingRecordId, privateDetailsToken],
  );
  const sharedAmbientContextItems = useAmbientPrivateDetails({
    items: rawAmbientContextItems,
    load: getLiveMeetingSharedAmbientPrivateDetailsLoader({
      isAmbientContextEnabled: input.isAmbientContextEnabled,
      hasJoinedMeeting: input.hasJoinedMeeting,
      loadAmbientPrivateDetails,
    }),
  });
  const ambientContextItems = useMemo(
    () => mergeMeetingPeopleMemory({ sharedItems: sharedAmbientContextItems, arrivals: input.peopleMemoryItems }),
    [input.peopleMemoryItems, sharedAmbientContextItems],
  );
  const contextImageUrls = useMemo(
    () => meetingContextImageUrls({ items: ambientContextItems, researchImages: ambientContextImageUrls }),
    [ambientContextImageUrls, ambientContextItems],
  );
  const ambientContextToken = getLiveMeetingAuthSessionToken(input.activeSession);
  const refreshAmbientContext = useMemo(
    () =>
      createLiveMeetingAmbientContextRefresh({
        isAmbientContextEnabled: input.isAmbientContextEnabled,
        ambientContextToken,
        meetingRecordId: input.meetingRecordId,
        hasJoinedMeeting: input.hasJoinedMeeting,
        setAmbientContextItems,
      }),
    [ambientContextToken, input.hasJoinedMeeting, input.isAmbientContextEnabled, input.meetingRecordId],
  );
  const isAmbientContextRealtimeSubscriptionEnabled = isLiveMeetingAmbientContextRealtimeSubscriptionEnabled({
    isAmbientContextEnabled: input.isAmbientContextEnabled,
    hasJoinedMeeting: input.hasJoinedMeeting,
  });
  const isAmbientContextRealtimeHealthy = useAmbientContextRealtime({
    client: input.realtimeClient,
    isEnabled: isAmbientContextRealtimeSubscriptionEnabled,
    meetingId: input.meetingRecordId,
    workspaceId: getLiveMeetingWorkspaceId(input.meeting),
    scopeKey: input.realtimeScopeKey,
    refreshAuth: input.refreshRealtimeAuth,
    refresh: refreshAmbientContext,
  });
  const {
    pillItems: ambientContextPillItems,
    expiredItemIds: expiredAmbientContextItemIds,
    restartWait: restartAmbientContextWait,
  } = useAmbientContextRecovery({
    items: ambientContextItems,
    enabled: isLiveMeetingAmbientContextRecoveryEnabled({
      isAmbientContextEnabled: input.isAmbientContextEnabled,
      activeSession: input.activeSession,
      meeting: input.meeting,
      hasJoinedMeeting: input.hasJoinedMeeting,
    }),
    realtimeHealthy: isAmbientContextRealtimeHealthy,
    refresh: refreshAmbientContext,
  });

  useLiveMeetingAmbientContextImageEffects({
    activeSession: input.activeSession,
    meeting: input.meeting,
    ambientContextItems,
    ambientContextImageUrls,
    setAmbientContextImageUrls,
    ambientContextImageUrlsRef,
    ambientContextImageSourcesRef,
    ambientContextImageLoadsRef,
  });

  return {
    ambientContextItems,
    contextImageUrls,
    ambientContextPillItems,
    expiredAmbientContextItemIds,
    restartAmbientContextWait,
    setAmbientContextItems,
  };
}

type LiveMeetingAmbientContextPanelInput = {
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  ambientContextItems: MeetingAmbientContextItem[];
  webSearchHistory: WebSearchPanelState[];
  expiredAmbientContextItemIds: Set<string>;
  restartAmbientContextWait: (itemId: string) => void;
  setAmbientContextItems: Dispatch<SetStateAction<MeetingAmbientContextItem[]>>;
  showToast: ReturnType<typeof useToast>["showToast"];
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsLinearActionPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
};

function useLiveMeetingAmbientContextPanel(input: LiveMeetingAmbientContextPanelInput) {
  const [isAmbientContextPanelOpen, setIsAmbientContextPanelOpen] = useState(false);
  const [selectedRelevantDetailsItemKey, setSelectedRelevantDetailsItemKey] = useState<string | null>(null);
  const relevantDetailsItems = useMemo(
    () =>
      relevantDetailsHistoryItems({ ambientItems: input.ambientContextItems, webSearchItems: input.webSearchHistory }),
    [input.ambientContextItems, input.webSearchHistory],
  );
  const latestDetailsKey = useMemo(
    () =>
      latestRelevantDetailsKey({
        items: input.ambientContextItems,
        webSearchItems: input.webSearchHistory,
        expiredItemIds: input.expiredAmbientContextItemIds,
      }),
    [input.ambientContextItems, input.expiredAmbientContextItemIds, input.webSearchHistory],
  );
  const latestDetails = relevantDetailsItems.find((item) => item.key === latestDetailsKey);
  useRelevantDetailsSelection({
    latest: latestDetails,
    isOpen: isAmbientContextPanelOpen,
    onSelect: setSelectedRelevantDetailsItemKey,
  });
  const openAmbientContextPanel = useCallback(
    (itemKey?: string) => {
      setSelectedRelevantDetailsItemKey(
        itemKey ??
          latestRelevantDetailsKey({
            items: input.ambientContextItems,
            webSearchItems: input.webSearchHistory,
            expiredItemIds: input.expiredAmbientContextItemIds,
          }),
      );
      input.setIsPresencePanelOpen(false);
      input.setIsToolApprovalPanelOpen(false);
      input.setIsLinearActionPanelOpen(false);
      input.setIsMeetingDetailsPanelOpen(false);
      input.setIsMeetingSettingsPanelOpen(false);
      setIsAmbientContextPanelOpen(true);
    },
    [
      input.ambientContextItems,
      input.expiredAmbientContextItemIds,
      input.setIsLinearActionPanelOpen,
      input.setIsMeetingDetailsPanelOpen,
      input.setIsMeetingSettingsPanelOpen,
      input.setIsPresencePanelOpen,
      input.setIsToolApprovalPanelOpen,
      input.webSearchHistory,
    ],
  );
  const retryAmbientContextItem = useCallback(
    async (itemId: string) => {
      if (!hasAuthSession(input.activeSession) || !hasMeetingRecord(input.meeting)) {
        return;
      }
      try {
        const item = await retryMeetingAmbientContextItem({
          token: input.activeSession.token,
          meetingId: input.meeting.id,
          itemId,
          signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
        });
        input.restartAmbientContextWait(itemId);
        input.setAmbientContextItems((current) =>
          [item, ...current.filter((candidate) => candidate.id !== item.id)].sort(
            (left, right) => Date.parse(right.lastMentionedAt) - Date.parse(left.lastMentionedAt),
          ),
        );
      } catch (nextError) {
        if (reportOptionalLiveServiceFailure({ error: nextError, feature: "research" })) {
          return;
        }
        input.showToast({
          id: `ambient-context-retry:${itemId}`,
          title: LIVE_MEETING_PAGE_COPY.ambientContextRetryTitle,
          message: getErrorMessage({ error: nextError, fallback: "Please try again." }),
          tone: "warning",
        });
      }
    },
    [
      input.activeSession,
      input.meeting,
      input.restartAmbientContextWait,
      input.setAmbientContextItems,
      input.showToast,
    ],
  );

  return {
    isAmbientContextPanelOpen,
    setIsAmbientContextPanelOpen,
    selectedRelevantDetailsItemKey,
    setSelectedRelevantDetailsItemKey,
    openAmbientContextPanel,
    retryAmbientContextItem,
  };
}

type LiveMeetingConnectAndEndLifecycleInput = {
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  isGuestSession: boolean;
  isScreenShareFullscreen: boolean;
  room: Room | null;
  refreshSession: ReturnType<typeof useAuth>["refreshSession"];
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
  speechLevelRef: { current: number };
  hasJoinedMeeting: boolean;
  endMeetingFlow: EndMeetingFlowState | null;
  connectionState: ConnectionState;
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<AuthSession | null>;
  microphonePermissionStateRef: { current: BrowserMediaPermissionState };
  cameraPermissionStateRef: { current: BrowserMediaPermissionState };
  clientDiagnosticContextRef: { current: { token: string; meetingId: string } | null };
  isInitialMicEnabled: boolean;
  isInitialCameraEnabled: boolean;
  initialMediaTracks: LocalTrack[] | null;
  initialMediaErrors: Pick<AcquiredMeetingMedia, "audioError" | "videoError"> | null;
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  isInitialBackgroundBlurEnabled: boolean | undefined;
  isBackgroundBlurEnabled: boolean;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
  setIsBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setRoom: Dispatch<SetStateAction<Room | null>>;
  setTracks: Dispatch<SetStateAction<TrackView[]>>;
  setHasJoinedMeeting: Dispatch<SetStateAction<boolean>>;
  setMediaControlError: (message: string) => void;
  setIsBackgroundBlurEnabled: Dispatch<SetStateAction<boolean>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  refreshRealtimeAuth: (reason: string) => Promise<void>;
  setMeeting: Dispatch<SetStateAction<Meeting | null>>;
  setActiveHumanParticipants: Dispatch<
    SetStateAction<MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"]>
  >;
  setLiveTranscriptSegments: Dispatch<SetStateAction<MeetingDetailPayload["transcriptSegments"]>>;
  setJoinedWorkspaceToSync: Dispatch<SetStateAction<string | null>>;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  isConversationModeActiveRef: {
    /** @external ref wire */
    current: boolean;
  };
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  owedVoiceStopRef: { current: ReturnType<typeof createOwedVoiceStop> | null };
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  showAgentHelpCreditsRequiredToast: () => void;
  setVideoDeviceId: Dispatch<SetStateAction<string | undefined>>;
  setPresenceVersion: Dispatch<SetStateAction<number>>;
  updateDataPresentationClaims: (
    update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>,
  ) => void;
  setRealtimeTranscriptLines: Dispatch<SetStateAction<LiveTranscriptLine[]>>;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setIsEndMeetingMenuOpen: Dispatch<SetStateAction<boolean>>;
  setEndMeetingFlow: Dispatch<SetStateAction<EndMeetingFlowState | null>>;
  setIsEndMeetingOverlayExiting: Dispatch<SetStateAction<boolean>>;
  setIsCaptionSpeechActive: Dispatch<SetStateAction<boolean>>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
  setIsScreenShareBusy: Dispatch<SetStateAction<boolean>>;
  inRoomMediaControls: Pick<ReturnType<typeof useLiveMeetingInRoomMediaControls>, "setPublishedCameraBackgroundBlur">;
};

type LiveMeetingJoinDepartureRefs = {
  endMeetingStartedRef: {
    /** @external ref wire */
    current: boolean;
  };
  joinBookkeepingRequestRef: { current: Promise<unknown> | null };
  remoteMeetingEndRef: { current: (() => void) | null };
  didConnect: {
    /** @external ref wire */
    current: boolean;
  };
};

function useLiveMeetingJoinDepartureRefs(): LiveMeetingJoinDepartureRefs {
  const endMeetingStartedRef = useRef(false);
  const joinBookkeepingRequestRef = useRef<Promise<unknown> | null>(null);
  const remoteMeetingEndRef = useRef<(() => void) | null>(null);
  const didConnect = useRef(false);

  return useMemo(
    () => ({ endMeetingStartedRef, joinBookkeepingRequestRef, remoteMeetingEndRef, didConnect }),
    [didConnect, endMeetingStartedRef, joinBookkeepingRequestRef, remoteMeetingEndRef],
  );
}

type LiveMeetingConnectLifecycleBundle = {
  lifecycle: LiveMeetingConnectAndEndLifecycleInput;
  joinDepartureRefs: LiveMeetingJoinDepartureRefs;
};

function runLiveMeetingPageInitialConnectSession(input: LiveMeetingConnectLifecycleBundle): void {
  const lifecycle = input.lifecycle;
  const { didConnect, endMeetingStartedRef, joinBookkeepingRequestRef, remoteMeetingEndRef } = input.joinDepartureRefs;
  const activeSession = lifecycle.activeSession;
  const meeting = lifecycle.meeting;
  if (!activeSession || !meeting || didConnect.current || meeting.status === "ended") {
    return;
  }

  didConnect.current = true;

  void runLiveMeetingConnectEffect({
    activeSession,
    meeting,
    didConnect,
    refreshAuthAfterUnauthorized: lifecycle.refreshAuthAfterUnauthorized,
    microphonePermissionStateRef: lifecycle.microphonePermissionStateRef,
    cameraPermissionStateRef: lifecycle.cameraPermissionStateRef,
    clientDiagnosticContextRef: lifecycle.clientDiagnosticContextRef,
    isInitialMicEnabled: lifecycle.isInitialMicEnabled,
    isInitialCameraEnabled: lifecycle.isInitialCameraEnabled,
    initialMediaTracks: lifecycle.initialMediaTracks,
    initialMediaErrors: lifecycle.initialMediaErrors,
    audioDeviceId: lifecycle.audioDeviceId,
    videoDeviceId: lifecycle.videoDeviceId,
    isInitialBackgroundBlurEnabled: lifecycle.isInitialBackgroundBlurEnabled,
    isBackgroundBlurEnabled: lifecycle.isBackgroundBlurEnabled,
    activeSessionUserSource: activeSession.user.source,
    applyAssistantPresencePayload: lifecycle.applyAssistantPresencePayload,
    setIsBusy: lifecycle.setIsBusy,
    setError: lifecycle.setError,
    setRoom: lifecycle.setRoom,
    setTracks: lifecycle.setTracks,
    setHasJoinedMeeting: lifecycle.setHasJoinedMeeting,
    setMediaControlError: lifecycle.setMediaControlError,
    setIsBackgroundBlurEnabled: lifecycle.setIsBackgroundBlurEnabled,
    setIsMicEnabled: lifecycle.setIsMicEnabled,
    setIsCamEnabled: lifecycle.setIsCamEnabled,
    setCameraPermissionState: lifecycle.setCameraPermissionState,
    setMicrophonePermissionState: lifecycle.setMicrophonePermissionState,
    setPublishedCameraBackgroundBlur: lifecycle.inRoomMediaControls.setPublishedCameraBackgroundBlur,
    refreshRealtimeAuth: lifecycle.refreshRealtimeAuth,
    endMeetingStartedRef,
    joinBookkeepingRequestRef,
    setMeeting: lifecycle.setMeeting,
    setActiveHumanParticipants: lifecycle.setActiveHumanParticipants,
    setLiveTranscriptSegments: lifecycle.setLiveTranscriptSegments,
    setJoinedWorkspaceToSync: lifecycle.setJoinedWorkspaceToSync,
    voiceModeIntentRef: lifecycle.voiceModeIntentRef,
    isConversationModeActiveRef: lifecycle.isConversationModeActiveRef,
    voiceModeRpcPendingRef: lifecycle.voiceModeRpcPendingRef,
    owedVoiceStopRef: lifecycle.owedVoiceStopRef,
    setVoiceModePendingAction: lifecycle.setVoiceModePendingAction,
    setSyncedConversationModeActive: lifecycle.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: lifecycle.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: lifecycle.setSyncedAgentHelpPhase,
    showToast: lifecycle.showToast,
    showAgentHelpCreditsRequiredToast: lifecycle.showAgentHelpCreditsRequiredToast,
    setVideoDeviceId: lifecycle.setVideoDeviceId,
    setPresenceVersion: lifecycle.setPresenceVersion,
    updateDataPresentationClaims: lifecycle.updateDataPresentationClaims,
    setRealtimeTranscriptLines: lifecycle.setRealtimeTranscriptLines,
    setAssistantDisplayNamesByIdentity: lifecycle.setAssistantDisplayNamesByIdentity,
    setConnectionState: lifecycle.setConnectionState,
    remoteMeetingEndRef,
  });
}

function useLiveMeetingEndMeetingLifecycle(bundle: LiveMeetingConnectLifecycleBundle) {
  const input = bundle.lifecycle;
  const refs = bundle.joinDepartureRefs;
  const activeSession = input.activeSession;
  const meeting = input.meeting;

  const onEndMeeting = useCallback(
    async (action: EndMeetingAction, remoteEnd?: MeetingDetailPayload | true) => {
      if (!activeSession || !meeting || refs.endMeetingStartedRef.current) {
        return;
      }
      if (input.isGuestSession && action === "end_for_all") {
        return;
      }

      refs.endMeetingStartedRef.current = true;

      await runLiveMeetingOnEndMeeting({
        action,
        remoteEnd,
        activeSession,
        meeting,
        isGuestSession: input.isGuestSession,
        isScreenShareFullscreen: input.isScreenShareFullscreen,
        room: input.room,
        refreshSession: input.refreshSession,
        router: input.router,
        showToast: input.showToast,
        speechLevelRef: input.speechLevelRef,
        joinBookkeepingRequestRef: refs.joinBookkeepingRequestRef,
        setIsBusy: input.setIsBusy,
        setError: input.setError,
        setIsEndMeetingMenuOpen: input.setIsEndMeetingMenuOpen,
        setEndMeetingFlow: input.setEndMeetingFlow,
        setIsEndMeetingOverlayExiting: input.setIsEndMeetingOverlayExiting,
        setIsMicEnabled: input.setIsMicEnabled,
        setIsCamEnabled: input.setIsCamEnabled,
        setConnectionState: input.setConnectionState,
        setIsCaptionSpeechActive: input.setIsCaptionSpeechActive,
        setHasJoinedMeeting: input.setHasJoinedMeeting,
        setPinnedScreenShareTrackId: input.setPinnedScreenShareTrackId,
        setIsScreenShareBusy: input.setIsScreenShareBusy,
        setRoom: input.setRoom,
        setTracks: input.setTracks,
      });
    },
    [
      activeSession,
      input.isGuestSession,
      input.isScreenShareFullscreen,
      input.refreshSession,
      input.room,
      input.router,
      input.setConnectionState,
      input.setEndMeetingFlow,
      input.setError,
      input.setHasJoinedMeeting,
      input.setIsBusy,
      input.setIsCamEnabled,
      input.setIsCaptionSpeechActive,
      input.setIsEndMeetingMenuOpen,
      input.setIsEndMeetingOverlayExiting,
      input.setIsMicEnabled,
      input.setIsScreenShareBusy,
      input.setPinnedScreenShareTrackId,
      input.setRoom,
      input.setTracks,
      input.showToast,
      input.speechLevelRef,
      meeting,
    ],
  );

  useEffect(() => {
    return runLiveMeetingRemoteMeetingEndRefEffect({
      remoteMeetingEndRef: refs.remoteMeetingEndRef,
      onRemoteMeetingEnd: () => onEndMeeting("leave", true),
    });
  }, [onEndMeeting, refs.remoteMeetingEndRef]);

  useEffect(() => {
    if (
      !activeSession ||
      !meeting ||
      !input.hasJoinedMeeting ||
      input.endMeetingFlow !== null ||
      input.connectionState === ConnectionState.Connected
    ) {
      return;
    }

    return runLiveMeetingEndedMeetingWhileDisconnectedPollEffect({
      activeSession,
      meeting,
      onLeaveEndedMeeting: (leaveInput) => onEndMeeting("leave", leaveInput.remoteEnd),
    });
  }, [activeSession, input.connectionState, input.endMeetingFlow, input.hasJoinedMeeting, meeting, onEndMeeting]);

  return { onEndMeeting };
}

function useLiveMeetingRoomJoinSessionEffects(bundle: LiveMeetingConnectLifecycleBundle): void {
  const input = bundle.lifecycle;
  const activeSession = input.activeSession;
  const meeting = input.meeting;

  useEffect(() => {
    runLiveMeetingPageInitialConnectSession(bundle);
  }, [
    bundle.joinDepartureRefs,
    bundle.lifecycle,
    activeSession,
    meeting,
    input.applyAssistantPresencePayload,
    input.audioDeviceId,
    input.inRoomMediaControls.setPublishedCameraBackgroundBlur,
    input.cameraPermissionStateRef,
    input.clientDiagnosticContextRef,
    input.initialMediaErrors,
    input.initialMediaTracks,
    input.isBackgroundBlurEnabled,
    input.isInitialBackgroundBlurEnabled,
    input.isInitialCameraEnabled,
    input.isInitialMicEnabled,
    input.microphonePermissionStateRef,
    input.refreshAuthAfterUnauthorized,
    input.refreshRealtimeAuth,
    input.setMediaControlError,
    input.setSyncedAgentHelpOwnerParticipantIdentity,
    input.setSyncedAgentHelpPhase,
    input.setSyncedConversationModeActive,
    input.showAgentHelpCreditsRequiredToast,
    input.videoDeviceId,
  ]);

  useEffect(() => {
    return () => {
      void disconnectAndStopRoomMedia(input.room);
    };
  }, [input.room]);
}

function useLiveMeetingPageConnectLifecycle(lifecycle: LiveMeetingConnectAndEndLifecycleInput) {
  const joinDepartureRefs = useLiveMeetingJoinDepartureRefs();
  const bundle = useMemo(() => ({ joinDepartureRefs, lifecycle }), [joinDepartureRefs, lifecycle]);
  const { onEndMeeting } = useLiveMeetingEndMeetingLifecycle(bundle);
  useLiveMeetingRoomJoinSessionEffects(bundle);

  return { onEndMeeting };
}

type LiveMeetingPageAgentVoiceSessionInput = {
  session: AuthSession | null;
  meetingId: string;
  meeting: Meeting | null;
  meetingRecordId: string | undefined;
  room: Room | null;
  connectionState: ConnectionState;
  showToast: ReturnType<typeof useToast>["showToast"];
  toolApprovalCards: VoiceToolApprovalCardState[];
  linearActionPanelState: LinearActionPanelState | null;
  linearActionPanelStateRef: { current: LinearActionPanelState | null };
  calendarOAuthPopupRef: { current: Window | null };
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelSearchStartedAtRef: { current: number | null };
  webSearchPanelSearchKeyRef: { current: string | null };
  webSearchDeferredPayloadTimerRef: { current: number | null };
  webSearchDeferredPayloadResolveRef: { current: ((applied: boolean) => void) | null };
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
  setIsToolApprovalPanelOpen: Dispatch<SetStateAction<boolean>>;
  ambientContextPanel: Pick<
    ReturnType<typeof useLiveMeetingAmbientContextPanel>,
    "setIsAmbientContextPanelOpen" | "setSelectedRelevantDetailsItemKey"
  >;
  setIsMeetingDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsMeetingSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsPresencePanelOpen: Dispatch<SetStateAction<boolean>>;
  setToolApprovalCards: Dispatch<SetStateAction<VoiceToolApprovalCardState[]>>;
  setIsLinearActionPanelOpen: Dispatch<SetStateAction<boolean>>;
  setLinearActionPanelState: Dispatch<SetStateAction<LinearActionPanelState | null>>;
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
  isConversationModeActive: boolean;
  agentHelpOwnerParticipantIdentity: string | null;
  agentHelpPhase: AgentHelpPhase;
  voiceModePendingAction: VoiceModePendingAction;
  isConversationModeActiveRef: {
    /** @external ref wire */
    current: boolean;
  };
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  owedVoiceStopRef: { current: ReturnType<typeof createOwedVoiceStop> | null };
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  setIsAgentHelpTooltipDismissed: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  showAgentHelpCreditsRequiredToast: () => void;
  isSoloVoiceAvailable: boolean;
  isAssistantParticipantSpeaking: boolean;
  isAgentHelpAvailable: boolean;
};

function useLiveMeetingPageAgentHelpAvailabilityReset(input: {
  isAgentHelpAvailable: boolean;
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
}) {
  const {
    isAgentHelpAvailable,
    voiceModeRpcPendingRef,
    setVoiceModePendingAction,
    setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase,
  } = input;
  useEffect(() => {
    if (isAgentHelpAvailable) {
      return;
    }

    voiceModeRpcPendingRef.current = false;
    setVoiceModePendingAction(null);
    setSyncedConversationModeActive(false);
    setSyncedAgentHelpOwnerParticipantIdentity(null);
    setSyncedAgentHelpPhase("idle");
  }, [
    isAgentHelpAvailable,
    setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase,
    setSyncedConversationModeActive,
    setVoiceModePendingAction,
    voiceModeRpcPendingRef,
  ]);
}

function useLiveMeetingPageAgentVoiceSession(input: LiveMeetingPageAgentVoiceSessionInput) {
  const inRoomVoiceTooling = useLiveMeetingInRoomVoiceTooling({
    session: input.session,
    meetingId: input.meetingId,
    meeting: input.meeting,
    meetingRecordId: input.meetingRecordId,
    room: input.room,
    connectionState: input.connectionState,
    showToast: input.showToast,
    toolApprovalCards: input.toolApprovalCards,
    linearActionPanelState: input.linearActionPanelState,
    linearActionPanelStateRef: input.linearActionPanelStateRef,
    calendarOAuthPopupRef: input.calendarOAuthPopupRef,
    webSearchPanelStateRef: input.webSearchPanelStateRef,
    webSearchPanelRunIdRef: input.webSearchPanelRunIdRef,
    webSearchPanelSearchStartedAtRef: input.webSearchPanelSearchStartedAtRef,
    webSearchPanelSearchKeyRef: input.webSearchPanelSearchKeyRef,
    webSearchDeferredPayloadTimerRef: input.webSearchDeferredPayloadTimerRef,
    webSearchDeferredPayloadResolveRef: input.webSearchDeferredPayloadResolveRef,
    voiceModeIntentRef: input.voiceModeIntentRef,
    updateWebSearchPanelState: input.updateWebSearchPanelState,
    setIsToolApprovalPanelOpen: input.setIsToolApprovalPanelOpen,
    setIsAmbientContextPanelOpen: input.ambientContextPanel.setIsAmbientContextPanelOpen,
    setIsMeetingDetailsPanelOpen: input.setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen: input.setIsMeetingSettingsPanelOpen,
    setIsPresencePanelOpen: input.setIsPresencePanelOpen,
    setToolApprovalCards: input.setToolApprovalCards,
    setSelectedRelevantDetailsItemKey: input.ambientContextPanel.setSelectedRelevantDetailsItemKey,
    setIsLinearActionPanelOpen: input.setIsLinearActionPanelOpen,
    setLinearActionPanelState: input.setLinearActionPanelState,
  });
  const performAssistantRpc = inRoomVoiceTooling.performAssistantRpc;
  const applyAssistantPresenceFromRpcResponse = useCallback(
    (response: string | null) => {
      const assistantPresence = parseAssistantPresencePayload(response);
      if (!assistantPresence) {
        return false;
      }

      input.applyAssistantPresencePayload(assistantPresence);

      return true;
    },
    [input.applyAssistantPresencePayload],
  );
  const toggleConversationMode = useCallback(async () => {
    await runConversationModeToggle({
      isConversationModeActive: input.isConversationModeActive,
      agentHelpOwnerParticipantIdentity: input.agentHelpOwnerParticipantIdentity,
      agentHelpPhase: input.agentHelpPhase,
      voiceModePendingAction: input.voiceModePendingAction,
      room: input.room,
      voiceModeIntentRef: input.voiceModeIntentRef,
      voiceModeRpcPendingRef: input.voiceModeRpcPendingRef,
      owedVoiceStopRef: input.owedVoiceStopRef,
      setVoiceModePendingAction: input.setVoiceModePendingAction,
      setIsAgentHelpTooltipDismissed: input.setIsAgentHelpTooltipDismissed,
      setError: input.setError,
      setSyncedConversationModeActive: input.setSyncedConversationModeActive,
      setSyncedAgentHelpOwnerParticipantIdentity: input.setSyncedAgentHelpOwnerParticipantIdentity,
      setSyncedAgentHelpPhase: input.setSyncedAgentHelpPhase,
      performAssistantRpc: (rpcInput) => performAssistantRpc(rpcInput),
      applyAssistantPresenceFromRpcResponse,
      applyAssistantPresencePayload: input.applyAssistantPresencePayload,
      showAgentHelpCreditsRequiredToast: input.showAgentHelpCreditsRequiredToast,
    });
  }, [
    applyAssistantPresenceFromRpcResponse,
    input.agentHelpOwnerParticipantIdentity,
    input.agentHelpPhase,
    input.applyAssistantPresencePayload,
    input.isConversationModeActive,
    input.owedVoiceStopRef,
    input.room,
    input.setError,
    input.setIsAgentHelpTooltipDismissed,
    input.setSyncedAgentHelpOwnerParticipantIdentity,
    input.setSyncedAgentHelpPhase,
    input.setSyncedConversationModeActive,
    input.setVoiceModePendingAction,
    input.showAgentHelpCreditsRequiredToast,
    input.voiceModeIntentRef,
    input.voiceModePendingAction,
    input.voiceModeRpcPendingRef,
    performAssistantRpc,
  ]);

  return {
    connectCalendarFromApprovalCard: inRoomVoiceTooling.connectCalendarFromApprovalCard,
    disconnectCalendarFromApprovalCard: inRoomVoiceTooling.disconnectCalendarFromApprovalCard,
    requestWorkflowFromApprovalCard: inRoomVoiceTooling.requestWorkflowFromApprovalCard,
    handleLinearActionAllow: inRoomVoiceTooling.handleLinearActionAllow,
    handleLinearActionCancel: inRoomVoiceTooling.handleLinearActionCancel,
    toggleConversationMode,
    performAssistantRpc,
  };
}

function useLiveMeetingPageLocalRoomEffects(input: {
  room: Room | null;
  setMicrophonePermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setCameraPermissionState: Dispatch<SetStateAction<BrowserMediaPermissionState>>;
  setIsMicEnabled: Dispatch<SetStateAction<boolean>>;
  setIsCamEnabled: Dispatch<SetStateAction<boolean>>;
}) {
  useEffect(() => {
    return runLiveMeetingBrowserMediaPermissionsWatchEffect({
      setMicrophonePermissionState: input.setMicrophonePermissionState,
      setCameraPermissionState: input.setCameraPermissionState,
    });
  }, [input.setCameraPermissionState, input.setMicrophonePermissionState]);

  useEffect(() => {
    if (!input.room) {
      return;
    }

    return runLiveMeetingLocalMediaStateSyncEffect({
      room: input.room,
      setIsMicEnabled: input.setIsMicEnabled,
      setIsCamEnabled: input.setIsCamEnabled,
    });
  }, [input.room, input.setIsCamEnabled, input.setIsMicEnabled]);
}

function useLiveMeetingPageAgentHelpPhaseSync(input: {
  isSoloVoiceAvailable: boolean;
  isConversationModeActive: boolean;
  agentHelpPhase: AgentHelpPhase;
  isAssistantParticipantSpeaking: boolean;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
}) {
  useLiveMeetingAgentHelpPhaseLifecycle(input);
}

function useLiveMeetingPageAgentVoiceInterrupt(input: {
  room: Room | null;
  isConversationModeActiveRef: {
    /** @external ref wire */
    current: boolean;
  };
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  performAssistantRpc: LiveMeetingPagePerformAssistantRpc;
}) {
  const interruptAssistantSpeech = useCallback(async () => {
    const {
      isConversationModeActiveRef,
      performAssistantRpc,
      setError,
      setSyncedAgentHelpOwnerParticipantIdentity,
      setSyncedAgentHelpPhase,
    } = input;
    if (!isConversationModeActiveRef.current) {
      setSyncedAgentHelpOwnerParticipantIdentity(null);
    }
    setSyncedAgentHelpPhase("idle");

    try {
      await performAssistantRpc({ method: INTERRUPT_SPEECH_RPC });
    } catch (nextError) {
      if (
        !isMethodNotSupportedError(nextError) &&
        !reportOptionalLiveServiceFailure({ error: nextError, feature: "assistant" })
      ) {
        setError(getErrorMessage({ error: nextError, fallback: "Failed to interrupt your agent" }));
      }
    }
  }, [input]);

  useEffect(() => {
    return runLiveMeetingEscapeInterruptAssistantEffect({
      room: input.room,
      interruptAssistantSpeech,
    });
  }, [input.room, interruptAssistantSpeech]);
}

function useLiveMeetingPageInRoomJoinChromeDerivations(input: {
  endMeetingFlow: EndMeetingFlowState | null;
  meeting: Meeting | null;
  liveRoomOrigin: string;
  liveRoomJoiningInfoCopiedTimerRef: { current: number | null };
  setError: Dispatch<SetStateAction<string | null>>;
  setIsLiveRoomJoiningInfoCopied: Dispatch<SetStateAction<boolean>>;
  showToast: ReturnType<typeof useToast>["showToast"];
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
  isSoloVoiceAvailable: boolean;
  isAgentHelpTooltipDismissed: boolean;
  liveRoomClock: string;
  webSearchPanelState: WebSearchPanelState | null;
  webSearchHistory: WebSearchPanelState[];
}) {
  const isEndMeetingFlowActive = isLiveMeetingEndMeetingFlowActive(input.endMeetingFlow);
  const liveRoomCallIn = getLiveMeetingLiveRoomCallIn(input.meeting);
  const liveRoomJoinUrl = useMemo(
    () =>
      hasMeetingRecord(input.meeting)
        ? getLiveMeetingJoinUrl({ meeting: input.meeting, origin: input.liveRoomOrigin })
        : "",
    [input.liveRoomOrigin, input.meeting],
  );
  const liveRoomJoiningInfo = useMemo(
    () => getLiveMeetingJoiningInfoText({ meeting: input.meeting, liveRoomJoinUrl, liveRoomCallIn }),
    [liveRoomCallIn, liveRoomJoinUrl, input.meeting],
  );
  const onCopyLiveRoomJoiningInfo = useCallback(async () => {
    await runLiveMeetingCopyJoiningInfo({
      meeting: input.meeting,
      liveRoomJoiningInfo,
      liveRoomJoiningInfoCopiedTimerRef: input.liveRoomJoiningInfoCopiedTimerRef,
      setError: input.setError,
      setIsLiveRoomJoiningInfoCopied: input.setIsLiveRoomJoiningInfoCopied,
      showToast: input.showToast,
    });
  }, [input.meeting, input.setError, input.setIsLiveRoomJoiningInfoCopied, input.showToast, liveRoomJoiningInfo]);
  const shouldShowLiveMeetingChrome = getLiveMeetingShouldShowChrome({
    meeting: input.meeting,
    hasActiveScreenShare: input.hasActiveScreenShare,
    isScreenShareFullscreen: input.isScreenShareFullscreen,
    isEndMeetingFlowActive,
  });
  const shouldShowAgentHelpTooltip = shouldShowLiveMeetingAgentHelpTooltip({
    isSoloVoiceAvailable: input.isSoloVoiceAvailable,
    isAgentHelpTooltipDismissed: input.isAgentHelpTooltipDismissed,
    isAgentIntroMeeting: isLiveMeetingAgentIntroMeeting(input.meeting),
  });
  const shouldShowLiveRoomInfo = shouldShowLiveMeetingLiveRoomInfo({
    shouldShowLiveMeetingChrome,
    liveRoomClock: input.liveRoomClock,
  });
  const relevantDetailsPillWebSearchState = useMemo(
    () => latestReadableWebResult([input.webSearchPanelState, ...input.webSearchHistory]),
    [input.webSearchPanelState, input.webSearchHistory],
  );

  return {
    isEndMeetingFlowActive,
    liveRoomCallIn,
    liveRoomJoinUrl,
    onCopyLiveRoomJoiningInfo,
    shouldShowLiveMeetingChrome,
    agentHelpTooltipText: LIVE_MEETING_PAGE_COPY.agentHelpTooltipText,
    shouldShowAgentHelpTooltip,
    shouldShowLiveRoomInfo,
    relevantDetailsPillWebSearchState,
  };
}

function useLiveMeetingPageInRoomCollaborationChrome(input: {
  shouldShowLiveMeetingChrome: boolean;
  liveRoomJoinUrl: string;
  isAvatarRevealed: boolean;
  joinRequestModeration: ReturnType<typeof useLiveMeetingJoinRequestModeration>;
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  hasJoinedMeeting: boolean;
  peopleMemoryItems: ReturnType<typeof useMeetingPeopleMemory>;
  ambientContextPipeline: Pick<ReturnType<typeof useLiveMeetingAmbientContextPipeline>, "ambientContextItems">;
  ambientContextPanel: Pick<
    ReturnType<typeof useLiveMeetingAmbientContextPanel>,
    "isAmbientContextPanelOpen" | "openAmbientContextPanel"
  >;
  hasActiveScreenShare: boolean;
  isScreenShareFullscreen: boolean;
  isMeetingHost: boolean;
  agentHelpPhase: AgentHelpPhase;
  isAgentHelpTurnOwner: boolean;
  isConversationModeActive: boolean;
  room: Room | null;
  agentHelpOwnerParticipantIdentity: string | null;
  voiceModePendingAction: VoiceModePendingAction;
  isControlsRevealed: boolean;
  isPresencePanelOpen: boolean;
  isMeetingDetailsPanelOpen: boolean;
  isMeetingSettingsPanelOpen: boolean;
  isToolApprovalPanelOpen: boolean;
  isLinearActionPanelOpen: boolean;
  linearActionPanelState: LinearActionPanelState | null;
  session: AuthSession | null;
}) {
  const collaborationSideEffectsEnabled = getLiveMeetingCollaborationSideEffectsEnabled({
    shouldShowLiveMeetingChrome: input.shouldShowLiveMeetingChrome,
    isAvatarRevealed: input.isAvatarRevealed,
    canModerateJoinRequests: input.joinRequestModeration.canModerateJoinRequests,
  });
  const meetingScopedSideEffectKey = getLiveMeetingMeetingScopedSideEffectKey({
    activeSession: input.activeSession,
    meeting: input.meeting,
    hasJoinedMeeting: input.hasJoinedMeeting,
  });
  useMeetingMemoryArrival({
    scopeKey: meetingScopedSideEffectKey,
    enabled: collaborationSideEffectsEnabled.isMemoryArrivalEnabled,
    arrivals: input.peopleMemoryItems,
    items: input.ambientContextPipeline.ambientContextItems,
    onOpen: input.ambientContextPanel.openAmbientContextPanel,
  });
  useWaitingRoomMenu({
    scopeKey: meetingScopedSideEffectKey,
    enabled: collaborationSideEffectsEnabled.isWaitingRoomMenuEnabled,
    requests: input.joinRequestModeration.joinRequests,
    setOpen: input.joinRequestModeration.setIsJoinRequestsOpen,
  });

  return {
    isMeetingOrganizer: input.isMeetingHost,
    waitingJoinRequestCount: input.joinRequestModeration.joinRequests.length,
    isAgentTurnBlockedByOther: isLiveMeetingAgentTurnBlockedByOther({
      agentHelpPhase: input.agentHelpPhase,
      isAgentHelpTurnOwner: input.isAgentHelpTurnOwner,
    }),
    voiceModeControlState: getVoiceModeControlState({
      conversationModeActive: input.isConversationModeActive,
      localParticipantIdentity: getLiveMeetingLocalParticipantIdentity(input.room),
      ownerParticipantIdentity: input.agentHelpOwnerParticipantIdentity,
      pendingAction: input.voiceModePendingAction,
    }),
    shouldShowInRoomDetailsSettingsPanels: shouldShowLiveMeetingInRoomDetailsSettingsPanels({
      meeting: input.meeting,
      hasActiveScreenShare: input.hasActiveScreenShare,
      isScreenShareFullscreen: input.isScreenShareFullscreen,
    }),
    shouldShowInRoomInviteExperience: shouldShowLiveMeetingInRoomInviteExperience({
      meeting: input.meeting,
      activeSession: input.activeSession,
      liveRoomJoinUrl: input.liveRoomJoinUrl,
    }),
    isInviteExperienceVisible: getLiveMeetingInviteExperienceVisible({
      shouldShowLiveMeetingChrome: input.shouldShowLiveMeetingChrome,
      isControlsRevealed: input.isControlsRevealed,
      hasJoinedMeeting: input.hasJoinedMeeting,
      isPresencePanelOpen: input.isPresencePanelOpen,
      isMeetingDetailsPanelOpen: input.isMeetingDetailsPanelOpen,
      isMeetingSettingsPanelOpen: input.isMeetingSettingsPanelOpen,
      isToolApprovalPanelOpen: input.isToolApprovalPanelOpen,
      isAmbientContextPanelOpen: input.ambientContextPanel.isAmbientContextPanelOpen,
      isLinearActionPanelOpen: input.isLinearActionPanelOpen,
    }),
    canConfirmLinearAction: canConfirmLiveMeetingLinearAction({
      linearActionPanelState: input.linearActionPanelState,
      sessionUserId: getLiveMeetingSessionUserId(input.session),
    }),
    sessionUserDisplayProfile: getLiveMeetingSessionUserDisplayProfile(input.session),
  };
}

type LiveMeetingPageProps = {
  meetingId: string;
  initialMeeting?: Meeting | null;
  initialMediaTracks?: LocalTrack[] | null;
  initialMediaErrors?: Pick<AcquiredMeetingMedia, "audioError" | "videoError"> | null;
  /** @external live meeting page launch props */
  initialCameraEnabled?: boolean;
  /** @external live meeting page launch props */
  initialMicEnabled?: boolean;
  /** @external live meeting page launch props */
  initialBackgroundBlurEnabled?: boolean;
  initialAudioDeviceId?: string;
  initialVideoDeviceId?: string;
  initialAudioOutputDeviceId?: string;
};

function useLiveMeetingCallSession(input: LiveMeetingPageProps) {
  const {
    meetingId,
    initialMeeting = null,
    initialCameraEnabled: isInitialCameraEnabled = true,
    initialMicEnabled: isInitialMicEnabled = true,
    initialBackgroundBlurEnabled: isInitialBackgroundBlurEnabled,
  } = input;
  const router = useRouter();
  const { refreshSession, session } = useAuth();
  const {
    client: realtimeClient,
    refreshRealtimeAuth: authorizeRealtime,
    scopeKey: realtimeScopeKey,
  } = useRealtimeClient();
  const { showToast } = useToast();
  const showAgentHelpCreditsRequiredToast = useCallback(() => {
    showToast({
      id: `agent-help-credits:${meetingId}`,
      title: LIVE_MEETING_PAGE_COPY.agentHelpCreditsToastTitle,
      message: LIVE_MEETING_PAGE_COPY.agentHelpCreditsToastMessage,
      tone: "warning",
    });
  }, [meetingId, showToast]);
  const [room, setRoom] = useState<Room | null>(null);
  const connectedRoomRef = useRef(room);
  useLayoutEffect(() => {
    connectedRoomRef.current = room;
  }, [room]);
  const refreshRealtimeAuth = useCallback(
    (reason?: string) => {
      const operation = authorizeRealtime(reason);

      return connectedRoomRef.current?.state === ConnectionState.Connected
        ? withOptionalLiveDeadline(operation)
        : operation;
    },
    [authorizeRealtime],
  );
  const [meeting, setMeeting] = useState<Meeting | null>(initialMeeting);
  const [endedMeetingHistoryVisibility, setEndedMeetingHistoryVisibility] =
    useState<EndedMeetingHistoryVisibility>("unknown");
  const [liveRoomClock, setLiveRoomClock] = useState("");
  const [liveRoomOrigin, setLiveRoomOrigin] = useState("");
  const [refreshedSession, setRefreshedSession] = useState<AuthSession | null>(null);
  const [joinedWorkspaceToSync, setJoinedWorkspaceToSync] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackView[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [hasJoinedMeeting, setHasJoinedMeeting] = useState(false);
  const [isMicEnabled, setIsMicEnabled] = useState(isInitialMicEnabled);
  const [isCamEnabled, setIsCamEnabled] = useState(isInitialCameraEnabled);
  const [microphonePermissionState, setMicrophonePermissionState] = useState<BrowserMediaPermissionState>("unknown");
  const [cameraPermissionState, setCameraPermissionState] = useState<BrowserMediaPermissionState>("unknown");
  const microphonePermissionStateRef = useRef(microphonePermissionState);
  const cameraPermissionStateRef = useRef(cameraPermissionState);
  useLayoutEffect(() => {
    microphonePermissionStateRef.current = microphonePermissionState;
    cameraPermissionStateRef.current = cameraPermissionState;
  });
  const [isBackgroundBlurEnabled, setIsBackgroundBlurEnabled] = useState(
    resolveLiveMeetingInitialBackgroundBlurEnabled(isInitialBackgroundBlurEnabled),
  );

  // prettier-ignore
  return { ...input, isInitialCameraEnabled, isInitialMicEnabled, isInitialBackgroundBlurEnabled, router, refreshSession, session, realtimeClient, refreshRealtimeAuth, realtimeScopeKey, showToast, showAgentHelpCreditsRequiredToast, room, setRoom, meeting, setMeeting, endedMeetingHistoryVisibility, setEndedMeetingHistoryVisibility, liveRoomClock, setLiveRoomClock, liveRoomOrigin, setLiveRoomOrigin, refreshedSession, setRefreshedSession, joinedWorkspaceToSync, setJoinedWorkspaceToSync, tracks, setTracks, connectionState, setConnectionState, hasJoinedMeeting, setHasJoinedMeeting, isMicEnabled, setIsMicEnabled, isCamEnabled, setIsCamEnabled, microphonePermissionState, setMicrophonePermissionState, cameraPermissionState, setCameraPermissionState, microphonePermissionStateRef, cameraPermissionStateRef, isBackgroundBlurEnabled, setIsBackgroundBlurEnabled };
}

function buildLiveMeetingParticipantAvatarUrls(
  activeHumanParticipants: MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"],
) {
  return {
    avatarUrlsByUserId: new Map(
      activeHumanParticipants.map((participant) => [participant.userId, participant.avatarUrl]),
    ),
    avatarUrlsByDisplayName: new Map(
      activeHumanParticipants.map((participant) => [
        participant.displayName.trim().toLowerCase(),
        participant.avatarUrl,
      ]),
    ),
  };
}

function useLiveMeetingCallControlsState(input: ReturnType<typeof useLiveMeetingCallSession>) {
  const [isBackgroundBlurBusy, setIsBackgroundBlurBusy] = useState(false);
  const [isBackgroundBlurSupported, setIsBackgroundBlurSupported] = useState(false);
  const [audioDeviceId, setAudioDeviceId] = useState<string | undefined>(input.initialAudioDeviceId);
  const [videoDeviceId, setVideoDeviceId] = useState<string | undefined>(input.initialVideoDeviceId);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoInputDevices, setVideoInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaControlErrorRef = useRef<string | null>(null);
  const [isScreenShareFullscreen, setIsScreenShareFullscreen] = useState(false);
  const [activeHumanParticipants, setActiveHumanParticipants] = useState<
    MeetingDetailPayload["meetingRuntime"]["activeHumanParticipants"]
  >([]);
  const [isRoomRevealed, setIsRoomRevealed] = useState(false);
  const [isControlsRevealed, setIsControlsRevealed] = useState(false);
  const [isAvatarRevealed, setIsAvatarRevealed] = useState(false);
  const [isAssistantParticipantSpeaking, setIsAssistantParticipantSpeaking] = useState(false);
  const assistantSpeechLevelRef = useRef(0);
  const readAssistantSpeechLevel = useCallback(() => assistantSpeechLevelRef.current, []);
  const [isPresencePanelOpen, setIsPresencePanelOpen] = useState(false);
  const [isMeetingDetailsPanelOpen, setIsMeetingDetailsPanelOpen] = useState(false);
  const [isMeetingSettingsPanelOpen, setIsMeetingSettingsPanelOpen] = useState(false);
  const [presenceVersion, setPresenceVersion] = useState(0);
  const [participantSpeechStore] = useState(createParticipantSpeechStore);
  const speechLevelRef = useRef(0);
  const readSpeechLevel = useCallback(() => speechLevelRef.current, []);
  const [isCaptionSpeechActive, setIsCaptionSpeechActive] = useState(false);

  return {
    ...input,
    activeHumanParticipants,
    assistantSpeechLevelRef,
    audioDeviceId,
    audioInputDevices,
    cameraPermissionState: input.cameraPermissionState,
    error,
    isAssistantParticipantSpeaking,
    isAvatarRevealed,
    isBackgroundBlurBusy,
    isBackgroundBlurSupported,
    isBusy,
    isCaptionSpeechActive,
    isControlsRevealed,
    isMeetingDetailsPanelOpen,
    isMeetingSettingsPanelOpen,
    isPresencePanelOpen,
    isRoomRevealed,
    isScreenShareFullscreen,
    mediaControlErrorRef,
    microphonePermissionState: input.microphonePermissionState,
    participantSpeechStore,
    presenceVersion,
    readAssistantSpeechLevel,
    readSpeechLevel,
    setActiveHumanParticipants,
    setAudioDeviceId,
    setAudioInputDevices,
    setError,
    setIsAssistantParticipantSpeaking,
    setIsAvatarRevealed,
    setIsBackgroundBlurBusy,
    setIsBackgroundBlurSupported,
    setIsBusy,
    setIsCaptionSpeechActive,
    setIsControlsRevealed,
    setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen,
    setIsPresencePanelOpen,
    setIsRoomRevealed,
    setIsScreenShareFullscreen,
    setPresenceVersion,
    setVideoDeviceId,
    setVideoInputDevices,
    speechLevelRef,
    videoDeviceId,
    videoInputDevices,
  };
}

function useLiveMeetingCallPanelsState(input: ReturnType<typeof useLiveMeetingCallControlsState>) {
  const { refreshedSession, session } = input;
  const [endMeetingFlow, setEndMeetingFlow] = useState<EndMeetingFlowState | null>(null);
  const [endMeetingFlowNow, setEndMeetingFlowNow] = useState(() => Date.now());
  const [isEndMeetingOverlayExiting, setIsEndMeetingOverlayExiting] = useState(false);
  const [isEndMeetingMenuOpen, setIsEndMeetingMenuOpen] = useState(false);
  const [isToolApprovalPanelOpen, setIsToolApprovalPanelOpen] = useState(false);
  const [isLinearActionPanelOpen, setIsLinearActionPanelOpen] = useState(false);
  const [assistantDisplayNamesByIdentity, setAssistantDisplayNamesByIdentity] = useState<Record<string, string>>({});
  const activeSession = getLiveMeetingActiveSession({ refreshedSession, session });

  return {
    ...input,
    activeSession,
    assistantDisplayNamesByIdentity,
    endMeetingFlow,
    endMeetingFlowNow,
    isEndMeetingMenuOpen,
    isEndMeetingOverlayExiting,
    isLinearActionPanelOpen,
    isToolApprovalPanelOpen,
    setAssistantDisplayNamesByIdentity,
    setEndMeetingFlow,
    setEndMeetingFlowNow,
    setIsEndMeetingMenuOpen,
    setIsEndMeetingOverlayExiting,
    setIsLinearActionPanelOpen,
    setIsToolApprovalPanelOpen,
  };
}

function useLiveMeetingSessionIdentity(input: ReturnType<typeof useLiveMeetingCallPanelsState>) {
  const {
    activeSession,
    endMeetingFlow,
    hasJoinedMeeting,
    joinedWorkspaceToSync,
    meeting,
    refreshSession,
    session,
    setJoinedWorkspaceToSync,
    setRefreshedSession,
  } = input;
  const meetingRecordId = getLiveMeetingRecordId(meeting);
  const activeSessionToken = getLiveMeetingAuthSessionToken(activeSession);
  const activeSessionUserSource = getLiveMeetingAuthSessionUserSource(activeSession);
  const activeSessionUserId = getLiveMeetingSessionUserId(activeSession);
  const sessionToken = getLiveMeetingAuthSessionToken(session);
  const onJoinedWorkspaceSynced = useCallback((nextSession: AuthSession) => {
    setRefreshedSession(nextSession);
    setJoinedWorkspaceToSync(null);
  }, []);
  useJoinedWorkspaceSession({
    enabled: isLiveMeetingJoinedWorkspaceSessionEnabled({
      joinedWorkspaceToSync,
      hasJoinedMeeting,
      endMeetingFlow,
    }),
    expectedWorkspaceId: joinedWorkspaceToSync,
    userId: getLiveMeetingSessionUserId(session),
    refreshSession,
    onSynced: onJoinedWorkspaceSynced,
  });
  const clientDiagnosticContextRef = useRef<{ token: string; meetingId: string } | null>(null);
  useLayoutEffect(() => {
    clientDiagnosticContextRef.current = getLiveMeetingClientDiagnosticContext({ activeSession, meeting });
  });
  const isGuestSession = isLiveMeetingGuestSession(activeSession);
  const isAmbientContextEnabled = webEnv.NEXT_PUBLIC_AMBIENT_CONTEXT_ENABLED;
  // A person card's private sections (the viewer's memory and Ashby) load per
  // viewer. Guests never request them; the API also denies guests.
  const privateDetailsToken = getLiveMeetingPrivateDetailsToken({ isGuestSession, activeSession });
  const meetingIdForPrivateDetails = meetingRecordId;
  const isMeetingHost = isLiveMeetingHost({ meeting, activeSession });
  const canCheckJoinRequests = canLiveMeetingCheckJoinRequests({ meeting, activeSession });

  return {
    ...input,
    activeSessionToken,
    activeSessionUserId,
    activeSessionUserSource,
    canCheckJoinRequests,
    clientDiagnosticContextRef,
    isAmbientContextEnabled,
    isGuestSession,
    isMeetingHost,
    meetingIdForPrivateDetails,
    meetingRecordId,
    onJoinedWorkspaceSynced,
    privateDetailsToken,
    sessionToken,
  };
}

function useLiveMeetingAuthRefresh(input: ReturnType<typeof useLiveMeetingSessionIdentity>) {
  const { refreshSession, setRefreshedSession } = input;
  const didRefreshAuth = useRef(false);
  const refreshAuthAfterUnauthorized = useCallback(
    async (error: unknown) => {
      if (!(error instanceof ApiError) || error.status !== HTTP_STATUS_UNAUTHORIZED || didRefreshAuth.current) {
        return null;
      }

      didRefreshAuth.current = true;
      const nextSession = await refreshSession();
      if (!nextSession) {
        return null;
      }

      setRefreshedSession(nextSession);

      return nextSession;
    },
    [refreshSession],
  );

  return { ...input, didRefreshAuth, refreshAuthAfterUnauthorized };
}

function useLiveMeetingResearchContext(input: {
  activeSession: AuthSession | null;
  hasJoinedMeeting: boolean;
  isAmbientContextEnabled: boolean;
  isGuestSession: boolean;
  joinRequests: MeetingJoinRequest[];
  meeting: Meeting | null;
  meetingIdForPrivateDetails: string | undefined;
  meetingRecordId: string | undefined;
  presenceVersion: number;
  privateDetailsToken: string | undefined;
  realtimeClient: ReturnType<typeof useRealtimeClient>["client"];
  realtimeScopeKey: ReturnType<typeof useRealtimeClient>["scopeKey"];
  refreshRealtimeAuth: ReturnType<typeof useRealtimeClient>["refreshRealtimeAuth"];
  room: Room | null;
}) {
  const memoryParticipantKey = useMemo(() => {
    void input.presenceVersion;

    return buildLiveMeetingMemoryParticipantKey({ room: input.room });
  }, [input.presenceVersion, input.room]);
  const peopleMemoryItems = useMeetingPeopleMemory({
    token: input.privateDetailsToken,
    meetingId: input.meetingIdForPrivateDetails,
    enabled: isLiveMeetingPeopleMemoryEnabled({
      privateDetailsToken: input.privateDetailsToken,
      hasJoinedMeeting: input.hasJoinedMeeting,
    }),
    arrivalsKey: buildLiveMeetingPeopleMemoryArrivalsKey({
      memoryParticipantKey,
      joinRequests: input.joinRequests,
    }),
  });
  const ambientContextPipeline = useLiveMeetingAmbientContextPipeline({
    activeSession: input.activeSession,
    meeting: input.meeting,
    meetingRecordId: input.meetingRecordId,
    hasJoinedMeeting: input.hasJoinedMeeting,
    isGuestSession: input.isGuestSession,
    isAmbientContextEnabled: input.isAmbientContextEnabled,
    realtimeClient: input.realtimeClient,
    realtimeScopeKey: input.realtimeScopeKey,
    refreshRealtimeAuth: input.refreshRealtimeAuth,
    peopleMemoryItems,
  });

  return { ambientContextPipeline, memoryParticipantKey, peopleMemoryItems };
}

function useLiveMeetingCallRefs(input: ReturnType<typeof useLiveMeetingAuthRefresh>) {
  const { room } = input;
  const liveVideoGridRef = useRef<HTMLDivElement | null>(null);
  const speechIndicatorStatesRef = useRef<Record<string, SpeechIndicatorState>>({});
  const isConversationModeActiveRef = useRef(false);
  const voiceModeIntentRef = useRef(createVoiceModeIntent());
  const voiceModeRpcPendingRef = useRef(false);
  const owedVoiceStopRef = useRef<ReturnType<typeof createOwedVoiceStop> | null>(null);
  const endMeetingMenuRef = useRef<HTMLDivElement | null>(null);
  const liveRoomJoiningInfoCopiedTimerRef = useRef<number | null>(null);
  const [liveVideoGridSize, setLiveVideoGridSize] = useState({
    width: 0,
    height: 0,
    gap: LIVE_VIDEO_GRID_DEFAULT_GAP_PX,
  });
  const isAgentHelpAvailable = hasLiveKitRoom(room);
  const isSoloVoiceAvailable = canUseSoloVoice(room);

  return {
    ...input,
    endMeetingMenuRef,
    isAgentHelpAvailable,
    isConversationModeActiveRef,
    isSoloVoiceAvailable,
    liveRoomJoiningInfoCopiedTimerRef,
    liveVideoGridRef,
    liveVideoGridSize,
    owedVoiceStopRef,
    setLiveVideoGridSize,
    speechIndicatorStatesRef,
    voiceModeIntentRef,
    voiceModeRpcPendingRef,
  };
}

function useLiveMeetingAgentPresence(input: {
  isConversationModeActiveRef: {
    /** @external ref wire */
    current: boolean;
  };
  setAgentHelpOwnerParticipantIdentity: Dispatch<SetStateAction<string | null>>;
  setAgentHelpPhase: Dispatch<SetStateAction<AgentHelpPhase>>;
  setAssistantDisplayNamesByIdentity: Dispatch<SetStateAction<Record<string, string>>>;
  setIsConversationModeActive: Dispatch<SetStateAction<boolean>>;
  voiceModeIntentRef: { current: ReturnType<typeof createVoiceModeIntent> };
  voiceModeRpcPendingRef: {
    /** @external ref wire */
    current: boolean;
  };
}) {
  const {
    isConversationModeActiveRef,
    setAgentHelpOwnerParticipantIdentity,
    setAgentHelpPhase,
    setAssistantDisplayNamesByIdentity,
    setIsConversationModeActive,
    voiceModeIntentRef,
    voiceModeRpcPendingRef,
  } = input;
  const setSyncedAgentHelpPhase = useCallback((nextPhase: AgentHelpPhase) => {
    setAgentHelpPhase(nextPhase);
  }, []);
  const setSyncedAgentHelpOwnerParticipantIdentity = useCallback((nextIdentity: string | null) => {
    setAgentHelpOwnerParticipantIdentity(nextIdentity);
  }, []);
  const setSyncedConversationModeActive = useCallback((isNextConversationModeActive: boolean) => {
    if (isNextConversationModeActive && !voiceModeIntentRef.current.canActivate()) {
      return;
    }
    if (!isNextConversationModeActive) {
      voiceModeIntentRef.current.deactivate();
    }
    isConversationModeActiveRef.current = isNextConversationModeActive;
    setIsConversationModeActive(isNextConversationModeActive);
  }, []);
  const applyAssistantPresencePayload = useCallback(
    (assistantPresence: AssistantPresencePayload) => {
      applyLiveMeetingAssistantPresencePayload({
        assistantPresence,
        voiceModeIntentRef,
        voiceModeRpcPendingRef,
        setSyncedConversationModeActive,
        setSyncedAgentHelpOwnerParticipantIdentity,
        setSyncedAgentHelpPhase,
        setAssistantDisplayNamesByIdentity,
      });
    },
    [setSyncedAgentHelpOwnerParticipantIdentity, setSyncedAgentHelpPhase, setSyncedConversationModeActive],
  );

  return {
    applyAssistantPresencePayload,
    setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase,
    setSyncedConversationModeActive,
  };
}

function useLiveMeetingMediaControlErrors(input: ReturnType<typeof useLiveMeetingCallRefs>) {
  const {
    mediaControlErrorRef,
    room,
    setCameraPermissionState,
    setError,
    setIsCamEnabled,
    setIsMicEnabled,
    setMicrophonePermissionState,
  } = input;
  const setMediaControlError = useCallback((message: string) => {
    mediaControlErrorRef.current = message;
    setError(message);
  }, []);
  const clearMediaControlError = useCallback(() => {
    const lastMediaControlError = mediaControlErrorRef.current;
    mediaControlErrorRef.current = null;
    setError((current) => (current === lastMediaControlError ? null : current));
  }, []);
  useLiveMeetingPageLocalRoomEffects({
    room,
    setMicrophonePermissionState,
    setCameraPermissionState,
    setIsMicEnabled,
    setIsCamEnabled,
  });

  return { ...input, clearMediaControlError, setMediaControlError };
}

function useLiveMeetingMicCameraControls(input: ReturnType<typeof useLiveMeetingMediaControlErrors>) {
  const inRoomMediaControls = useLiveMeetingInRoomMediaControls({
    room: input.room,
    connectionState: input.connectionState,
    initialAudioOutputDeviceId: input.initialAudioOutputDeviceId,
    clientDiagnosticContextRef: input.clientDiagnosticContextRef,
    activeSession: input.activeSession,
    meetingId: input.meetingId,
    meeting: input.meeting,
    isGuestSession: input.isGuestSession,
    audioDeviceId: input.audioDeviceId,
    videoDeviceId: input.videoDeviceId,
    isMicEnabled: input.isMicEnabled,
    isCamEnabled: input.isCamEnabled,
    isBackgroundBlurEnabled: input.isBackgroundBlurEnabled,
    isBackgroundBlurBusy: input.isBackgroundBlurBusy,
    isBackgroundBlurSupported: input.isBackgroundBlurSupported,
    setIsBackgroundBlurSupported: input.setIsBackgroundBlurSupported,
    setAudioDeviceId: input.setAudioDeviceId,
    setVideoDeviceId: input.setVideoDeviceId,
    setIsMicEnabled: input.setIsMicEnabled,
    setIsCamEnabled: input.setIsCamEnabled,
    setIsBackgroundBlurEnabled: input.setIsBackgroundBlurEnabled,
    setIsBackgroundBlurBusy: input.setIsBackgroundBlurBusy,
    setMeeting: input.setMeeting,
    setError: input.setError,
    setMicrophonePermissionState: input.setMicrophonePermissionState,
    setCameraPermissionState: input.setCameraPermissionState,
    clearMediaControlError: input.clearMediaControlError,
    setMediaControlError: input.setMediaControlError,
    showToast: input.showToast,
    assistantSpeechLevelRef: input.assistantSpeechLevelRef,
    speechLevelRef: input.speechLevelRef,
    speechIndicatorStatesRef: input.speechIndicatorStatesRef,
    participantSpeechStore: input.participantSpeechStore,
    setIsCaptionSpeechActive: input.setIsCaptionSpeechActive,
    setIsAssistantParticipantSpeaking: input.setIsAssistantParticipantSpeaking,
  });

  return { ...input, inRoomMediaControls };
}

function useLiveMeetingRoomBootstrap(input: ReturnType<typeof useLiveMeetingMicCameraControls>) {
  useLiveMeetingLiveRoomBootstrapEffects({
    endMeetingFlow: input.endMeetingFlow,
    liveVideoGridRef: input.liveVideoGridRef,
    setLiveVideoGridSize: input.setLiveVideoGridSize,
    room: input.room,
    presenceVersion: input.presenceVersion,
    setAssistantDisplayNamesByIdentity: input.setAssistantDisplayNamesByIdentity,
    setAudioInputDevices: input.setAudioInputDevices,
    setVideoInputDevices: input.setVideoInputDevices,
    setAudioDeviceId: input.setAudioDeviceId,
    setVideoDeviceId: input.setVideoDeviceId,
    setLiveRoomClock: input.setLiveRoomClock,
    setLiveRoomOrigin: input.setLiveRoomOrigin,
    setEndMeetingFlowNow: input.setEndMeetingFlowNow,
    activeSession: input.activeSession,
    meetingId: input.meetingId,
    refreshAuthAfterUnauthorized: input.refreshAuthAfterUnauthorized,
    setError: input.setError,
    setMeeting: input.setMeeting,
    setEndedMeetingHistoryVisibility: input.setEndedMeetingHistoryVisibility,
    setActiveHumanParticipants: input.setActiveHumanParticipants,
    isPresencePanelOpen: input.isPresencePanelOpen,
    setIsPresencePanelOpen: input.setIsPresencePanelOpen,
    isMeetingDetailsPanelOpen: input.isMeetingDetailsPanelOpen,
    setIsMeetingDetailsPanelOpen: input.setIsMeetingDetailsPanelOpen,
    isMeetingSettingsPanelOpen: input.isMeetingSettingsPanelOpen,
    setIsMeetingSettingsPanelOpen: input.setIsMeetingSettingsPanelOpen,
    isEndMeetingMenuOpen: input.isEndMeetingMenuOpen,
    endMeetingMenuRef: input.endMeetingMenuRef,
    setIsEndMeetingMenuOpen: input.setIsEndMeetingMenuOpen,
    realtimeClient: input.realtimeClient,
    meeting: input.meeting,
    hasJoinedMeeting: input.hasJoinedMeeting,
    isGuestSession: input.isGuestSession,
    refreshRealtimeAuth: input.refreshRealtimeAuth,
    router: input.router,
    connectionState: input.connectionState,
  });

  return input;
}

type LiveMeetingFeatureBridgeCallbacks = {
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
  setLiveTranscriptSegments: Dispatch<SetStateAction<MeetingDetailPayload["transcriptSegments"]>>;
  setRealtimeTranscriptLines: Dispatch<SetStateAction<LiveTranscriptLine[]>>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
  setIsScreenShareBusy: Dispatch<SetStateAction<boolean>>;
  updateDataPresentationClaims: (
    update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>,
  ) => void;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
};

function useLiveMeetingConnectLifecycle(
  input: ReturnType<typeof useLiveMeetingRoomBootstrap> & LiveMeetingFeatureBridgeCallbacks,
) {
  const { onEndMeeting } = useLiveMeetingPageConnectLifecycle({
    activeSession: input.activeSession,
    meeting: input.meeting,
    isGuestSession: input.isGuestSession,
    isScreenShareFullscreen: input.isScreenShareFullscreen,
    room: input.room,
    refreshSession: input.refreshSession,
    router: input.router,
    showToast: input.showToast,
    speechLevelRef: input.speechLevelRef,
    hasJoinedMeeting: input.hasJoinedMeeting,
    endMeetingFlow: input.endMeetingFlow,
    connectionState: input.connectionState,
    refreshAuthAfterUnauthorized: input.refreshAuthAfterUnauthorized,
    microphonePermissionStateRef: input.microphonePermissionStateRef,
    cameraPermissionStateRef: input.cameraPermissionStateRef,
    clientDiagnosticContextRef: input.clientDiagnosticContextRef,
    isInitialMicEnabled: input.isInitialMicEnabled,
    isInitialCameraEnabled: input.isInitialCameraEnabled,
    initialMediaTracks: input.initialMediaTracks ?? null,
    initialMediaErrors: input.initialMediaErrors ?? null,
    audioDeviceId: input.audioDeviceId,
    videoDeviceId: input.videoDeviceId,
    isInitialBackgroundBlurEnabled: input.isInitialBackgroundBlurEnabled,
    isBackgroundBlurEnabled: input.isBackgroundBlurEnabled,
    applyAssistantPresencePayload: input.applyAssistantPresencePayload,
    setIsBusy: input.setIsBusy,
    setError: input.setError,
    setRoom: input.setRoom,
    setTracks: input.setTracks,
    setHasJoinedMeeting: input.setHasJoinedMeeting,
    setMediaControlError: input.setMediaControlError,
    setIsBackgroundBlurEnabled: input.setIsBackgroundBlurEnabled,
    setIsMicEnabled: input.setIsMicEnabled,
    setIsCamEnabled: input.setIsCamEnabled,
    setCameraPermissionState: input.setCameraPermissionState,
    setMicrophonePermissionState: input.setMicrophonePermissionState,
    refreshRealtimeAuth: input.refreshRealtimeAuth,
    setMeeting: input.setMeeting,
    setActiveHumanParticipants: input.setActiveHumanParticipants,
    setLiveTranscriptSegments: input.setLiveTranscriptSegments,
    setJoinedWorkspaceToSync: input.setJoinedWorkspaceToSync,
    voiceModeIntentRef: input.voiceModeIntentRef,
    isConversationModeActiveRef: input.isConversationModeActiveRef,
    voiceModeRpcPendingRef: input.voiceModeRpcPendingRef,
    owedVoiceStopRef: input.owedVoiceStopRef,
    setVoiceModePendingAction: input.setVoiceModePendingAction,
    setSyncedConversationModeActive: input.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: input.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: input.setSyncedAgentHelpPhase,
    showAgentHelpCreditsRequiredToast: input.showAgentHelpCreditsRequiredToast,
    setVideoDeviceId: input.setVideoDeviceId,
    setPresenceVersion: input.setPresenceVersion,
    updateDataPresentationClaims: input.updateDataPresentationClaims,
    setRealtimeTranscriptLines: input.setRealtimeTranscriptLines,
    setAssistantDisplayNamesByIdentity: input.setAssistantDisplayNamesByIdentity,
    setConnectionState: input.setConnectionState,
    setIsEndMeetingMenuOpen: input.setIsEndMeetingMenuOpen,
    setEndMeetingFlow: input.setEndMeetingFlow,
    setIsEndMeetingOverlayExiting: input.setIsEndMeetingOverlayExiting,
    setIsCaptionSpeechActive: input.setIsCaptionSpeechActive,
    setPinnedScreenShareTrackId: input.setPinnedScreenShareTrackId,
    setIsScreenShareBusy: input.setIsScreenShareBusy,
    inRoomMediaControls: input.inRoomMediaControls,
  });

  return { ...input, onEndMeeting };
}

type LiveMeetingAgentPresenceApi = {
  applyAssistantPresencePayload: (payload: AssistantPresencePayload) => void;
  setSyncedConversationModeActive: (isNextConversationModeActive: boolean) => void;
  setSyncedAgentHelpOwnerParticipantIdentity: (nextIdentity: string | null) => void;
  setSyncedAgentHelpPhase: (nextPhase: AgentHelpPhase) => void;
  setVoiceModePendingAction: Dispatch<SetStateAction<VoiceModePendingAction>>;
};

type LiveMeetingCaptionsApi = {
  setIsTranscriptVisible: Dispatch<SetStateAction<boolean>>;
  setLiveTranscriptSegments: Dispatch<SetStateAction<MeetingDetailPayload["transcriptSegments"]>>;
  setRealtimeTranscriptLines: Dispatch<SetStateAction<LiveTranscriptLine[]>>;
};

type LiveMeetingScreenShareApi = {
  setIsScreenShareBusy: Dispatch<SetStateAction<boolean>>;
  setPinnedScreenShareTrackId: Dispatch<SetStateAction<string | null>>;
  updateDataPresentationClaims: (
    update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>,
  ) => void;
};

type LiveMeetingResearchApi = {
  ambientContextItems: MeetingAmbientContextItem[];
  ambientContextPillItems: MeetingAmbientContextItem[];
  contextImageUrls: Record<string, string>;
  expiredAmbientContextItemIds: Set<string>;
  isAmbientContextPanelOpen: boolean;
  openAmbientContextPanel: (itemKey?: string) => void;
  peopleMemoryItems: ReturnType<typeof useMeetingPeopleMemory>;
  retryAmbientContextItem: (itemId: string) => Promise<void>;
  selectedRelevantDetailsItemKey: string | null;
  setIsAmbientContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedRelevantDetailsItemKey: Dispatch<SetStateAction<string | null>>;
  updateWebSearchPanelState: (nextState: WebSearchPanelState) => void;
  webSearchDeferredPayloadResolveRef: { current: ((applied: boolean) => void) | null };
  webSearchDeferredPayloadTimerRef: { current: number | null };
  webSearchHistory: WebSearchPanelState[];
  webSearchPanelRunIdRef: { current: number };
  webSearchPanelSearchKeyRef: { current: string | null };
  webSearchPanelSearchStartedAtRef: { current: number | null };
  webSearchPanelState: WebSearchPanelState | null;
  webSearchPanelStateRef: { current: WebSearchPanelState | null };
};

type LiveMeetingInvitesApi = {
  setIsJoinRequestsOpen: Dispatch<SetStateAction<boolean>>;
};

function useLiveMeetingFeatureBridges() {
  const agentPresenceRef = useRef<LiveMeetingAgentPresenceApi | null>(null);
  const captionsApiRef = useRef<LiveMeetingCaptionsApi | null>(null);
  const screenShareApiRef = useRef<LiveMeetingScreenShareApi | null>(null);
  const researchApiRef = useRef<LiveMeetingResearchApi | null>(null);
  const invitesApiRef = useRef<LiveMeetingInvitesApi | null>(null);
  const applyAssistantPresencePayload = useCallback((payload: AssistantPresencePayload) => {
    agentPresenceRef.current?.applyAssistantPresencePayload(payload);
  }, []);
  const setSyncedConversationModeActive = useCallback((isNextConversationModeActive: boolean) => {
    agentPresenceRef.current?.setSyncedConversationModeActive(isNextConversationModeActive);
  }, []);
  const setSyncedAgentHelpOwnerParticipantIdentity = useCallback((nextIdentity: string | null) => {
    agentPresenceRef.current?.setSyncedAgentHelpOwnerParticipantIdentity(nextIdentity);
  }, []);
  const setSyncedAgentHelpPhase = useCallback((nextPhase: AgentHelpPhase) => {
    agentPresenceRef.current?.setSyncedAgentHelpPhase(nextPhase);
  }, []);
  const setVoiceModePendingAction = useCallback((nextAction: SetStateAction<VoiceModePendingAction>) => {
    agentPresenceRef.current?.setVoiceModePendingAction(nextAction);
  }, []);
  const setLiveTranscriptSegments = useCallback(
    (nextSegments: SetStateAction<MeetingDetailPayload["transcriptSegments"]>) => {
      captionsApiRef.current?.setLiveTranscriptSegments(nextSegments);
    },
    [],
  );
  const setRealtimeTranscriptLines = useCallback((nextLines: SetStateAction<LiveTranscriptLine[]>) => {
    captionsApiRef.current?.setRealtimeTranscriptLines(nextLines);
  }, []);
  const setPinnedScreenShareTrackId = useCallback((nextTrackId: SetStateAction<string | null>) => {
    screenShareApiRef.current?.setPinnedScreenShareTrackId(nextTrackId);
  }, []);
  const setIsScreenShareBusy = useCallback((nextBusy: SetStateAction<boolean>) => {
    screenShareApiRef.current?.setIsScreenShareBusy(nextBusy);
  }, []);
  const updateDataPresentationClaims = useCallback(
    (update: (claims: Record<string, PresentationClaim>) => Record<string, PresentationClaim>) => {
      screenShareApiRef.current?.updateDataPresentationClaims(update);
    },
    [],
  );
  const setIsAmbientContextPanelOpen = useCallback((nextOpen: SetStateAction<boolean>) => {
    researchApiRef.current?.setIsAmbientContextPanelOpen(nextOpen);
  }, []);

  return {
    callbacks: {
      applyAssistantPresencePayload,
      setIsAmbientContextPanelOpen,
      setIsScreenShareBusy,
      setLiveTranscriptSegments,
      setPinnedScreenShareTrackId,
      setRealtimeTranscriptLines,
      setSyncedAgentHelpOwnerParticipantIdentity,
      setSyncedAgentHelpPhase,
      setSyncedConversationModeActive,
      setVoiceModePendingAction,
      updateDataPresentationClaims,
    },
    invitesApiRef,
    refs: { agentPresenceRef, captionsApiRef, invitesApiRef, researchApiRef, screenShareApiRef },
  };
}

function useLiveMeetingFeatureHosts() {
  const [agentGlowHost, setAgentGlowHost] = useState<HTMLDivElement | null>(null);
  const [captionsHost, setCaptionsHost] = useState<HTMLDivElement | null>(null);
  const [screenShareHost, setScreenShareHost] = useState<HTMLDivElement | null>(null);
  const [agentHelpHost, setAgentHelpHost] = useState<HTMLDivElement | null>(null);
  const [screenShareStageHost, setScreenShareStageHost] = useState<HTMLDivElement | null>(null);
  const [trackerTriggerHost, setTrackerTriggerHost] = useState<HTMLDivElement | null>(null);
  const [researchPillHost, setResearchPillHost] = useState<HTMLDivElement | null>(null);
  const [admitGuestsHost, setAdmitGuestsHost] = useState<HTMLDivElement | null>(null);
  const [toolApprovalHost, setToolApprovalHost] = useState<HTMLDivElement | null>(null);
  const [trackerPanelHost, setTrackerPanelHost] = useState<HTMLDivElement | null>(null);
  const [ambientPanelHost, setAmbientPanelHost] = useState<HTMLDivElement | null>(null);
  const [linearPanelHost, setLinearPanelHost] = useState<HTMLDivElement | null>(null);
  const [inviteHost, setInviteHost] = useState<HTMLDivElement | null>(null);
  const [detailsHost, setDetailsHost] = useState<HTMLDivElement | null>(null);
  const [transcriptHost, setTranscriptHost] = useState<HTMLDivElement | null>(null);

  return {
    admitGuestsHost,
    agentGlowHost,
    agentHelpHost,
    ambientPanelHost,
    captionsHost,
    detailsHost,
    inviteHost,
    linearPanelHost,
    researchPillHost,
    screenShareHost,
    screenShareStageHost,
    setAdmitGuestsHost,
    setAgentGlowHost,
    setAgentHelpHost,
    setAmbientPanelHost,
    setCaptionsHost,
    setDetailsHost,
    setInviteHost,
    setLinearPanelHost,
    setResearchPillHost,
    setScreenShareHost,
    setScreenShareStageHost,
    setToolApprovalHost,
    setTrackerPanelHost,
    setTrackerTriggerHost,
    setTranscriptHost,
    toolApprovalHost,
    trackerPanelHost,
    trackerTriggerHost,
    transcriptHost,
  };
}

const LIVE_TRANSCRIPT_DISMISS_SAFE_SELECTOR = ".live-transcript-strip, [data-live-transcript-toggle]";
const EMPTY_PEOPLE_MEMORY: ReturnType<typeof useMeetingPeopleMemory> = [];
const EMPTY_AMBIENT_PIPELINE = { ambientContextItems: [] as MeetingAmbientContextItem[] };
const CLOSED_AMBIENT_PANEL = {
  isAmbientContextPanelOpen: false,
  openAmbientContextPanel: (_itemKey?: string) => {},
};

function useLiveMeetingInRoomMeetingTracker(input: {
  activeSession: AuthSession | null;
  meeting: Meeting | null;
  hasJoinedMeeting: boolean;
  realtimeClient: ReturnType<typeof useRealtimeClient>["client"];
  refreshRealtimeAuth: ReturnType<typeof useRealtimeClient>["refreshRealtimeAuth"];
  shouldShowLiveMeetingChrome: boolean;
  isAvatarRevealed: boolean;
  panels: {
    isPresencePanelOpen: boolean;
    isToolApprovalPanelOpen: boolean;
    isLinearActionPanelOpen: boolean;
    isMeetingDetailsPanelOpen: boolean;
    isMeetingSettingsPanelOpen: boolean;
    isJoinRequestsOpen: boolean;
    isAmbientContextPanelOpen: boolean;
  };
  closeOtherPanels: () => void;
}) {
  const [isTrackerOpen, setIsTrackerOpen] = useState(false);
  const trackerRealtimeClient = useMemo(
    () => toMeetingTrackerRealtimeClient(input.realtimeClient),
    [input.realtimeClient],
  );
  const tracker = useMeetingTracker({
    token: input.activeSession?.token,
    meetingId: input.meeting?.id,
    workspaceId: input.meeting?.workspaceId,
    isEnabled: input.hasJoinedMeeting,
    client: trackerRealtimeClient,
    refreshAuth: input.refreshRealtimeAuth,
  });
  if (shouldDismissMeetingTracker({ isTrackerOpen, panels: input.panels })) {
    setIsTrackerOpen(false);
  }
  const closeTracker = useCallback(() => setIsTrackerOpen(false), []);
  const toggleTracker = () => {
    input.closeOtherPanels();
    setIsTrackerOpen((isCurrentlyOpen) => !isCurrentlyOpen);
  };

  return {
    closeTracker,
    data: tracker.data,
    hasError: tracker.hasError,
    ...meetingTrackerPanelVisibility({
      state: tracker.data,
      hasJoinedMeeting: input.hasJoinedMeeting,
      isTrackerOpen,
      shouldShowLiveMeetingChrome: input.shouldShowLiveMeetingChrome,
      isAvatarRevealed: input.isAvatarRevealed,
    }),
    isTriggerExpanded: isTrackerOpen,
    toggleTracker,
  };
}

function useLiveMeetingCallChrome(input: {
  connected: ReturnType<typeof useLiveMeetingConnectLifecycle>;
  isScreenShareFeatureFailed: boolean;
}) {
  const { connected } = input;
  const screenShareVisuals = useMemo(
    () =>
      buildLiveMeetingScreenShareVisuals({
        room: connected.room,
        session: connected.session,
        tracks: connected.tracks,
      }),
    [connected.room, connected.session, connected.tracks],
  );
  const hasActiveScreenShare = screenShareVisuals.length !== 0 && !input.isScreenShareFeatureFailed;
  const participantAvatarUrls = useMemo(
    () => buildLiveMeetingParticipantAvatarUrls(connected.activeHumanParticipants),
    [connected.activeHumanParticipants],
  );
  const presenceEntries = useMemo(
    () =>
      buildLiveMeetingPresenceEntries({
        activeSession: connected.activeSession,
        room: connected.room,
        tracks: connected.tracks,
        participantAvatarUrls,
        presenceVersion: connected.presenceVersion,
      }),
    [connected.activeSession, connected.presenceVersion, connected.room, connected.tracks, participantAvatarUrls],
  );
  const participantVideoStage = useLiveMeetingParticipantVideoStage({
    room: connected.room,
    session: connected.session,
    isCamEnabled: connected.isCamEnabled,
    tracks: connected.tracks,
    participantAvatarUrls,
    participantSpeechStore: connected.participantSpeechStore,
    presenceVersion: connected.presenceVersion,
    liveVideoGridSize: connected.liveVideoGridSize,
    hasActiveScreenShare,
    meeting: connected.meeting,
    connectionState: connected.connectionState,
    isMeetingHost: connected.isMeetingHost,
    isRoomRevealed: connected.isRoomRevealed,
    liveVideoGridRef: connected.liveVideoGridRef,
    setIsRoomRevealed: connected.setIsRoomRevealed,
    setIsControlsRevealed: connected.setIsControlsRevealed,
    setIsAvatarRevealed: connected.setIsAvatarRevealed,
  });
  const liveCallSession = createLiveCallSession({
    meetingId: connected.meetingId,
    connectionState: connected.connectionState,
    room: connected.room,
  });
  const isEndMeetingFlowActive = isLiveMeetingEndMeetingFlowActive(connected.endMeetingFlow);
  const shouldShowLiveMeetingChrome = getLiveMeetingShouldShowChrome({
    meeting: connected.meeting,
    hasActiveScreenShare,
    isScreenShareFullscreen: connected.isScreenShareFullscreen,
    isEndMeetingFlowActive,
  });
  const shouldShowLiveRoomInfo = shouldShowLiveMeetingLiveRoomInfo({
    shouldShowLiveMeetingChrome,
    liveRoomClock: connected.liveRoomClock,
  });
  const shouldShowInRoomDetailsSettingsPanels = shouldShowLiveMeetingInRoomDetailsSettingsPanels({
    meeting: connected.meeting,
    hasActiveScreenShare,
    isScreenShareFullscreen: connected.isScreenShareFullscreen,
  });
  const liveRoomJoinUrl = useMemo(
    () =>
      hasMeetingRecord(connected.meeting)
        ? getLiveMeetingJoinUrl({ meeting: connected.meeting, origin: connected.liveRoomOrigin })
        : "",
    [connected.liveRoomOrigin, connected.meeting],
  );

  return {
    hasActiveScreenShare,
    isEndMeetingFlowActive,
    liveCallSession,
    liveRoomJoinUrl,
    participantAvatarUrls,
    participantVideoStage,
    presenceEntries,
    sessionUserDisplayProfile: getLiveMeetingSessionUserDisplayProfile(connected.session),
    shouldShowInRoomDetailsSettingsPanels,
    shouldShowLiveMeetingChrome,
    shouldShowLiveRoomInfo,
  };
}

function useLiveMeetingInRoomRuntime(input: LiveMeetingPageProps) {
  const callSession = useLiveMeetingCallSession(input);
  const callControls = useLiveMeetingCallControlsState(callSession);
  const callPanels = useLiveMeetingCallPanelsState(callControls);
  const sessionIdentity = useLiveMeetingSessionIdentity(callPanels);
  const authRefresh = useLiveMeetingAuthRefresh(sessionIdentity);
  const callRefs = useLiveMeetingCallRefs(authRefresh);
  const mediaErrors = useLiveMeetingMediaControlErrors(callRefs);
  const micCamera = useLiveMeetingMicCameraControls(mediaErrors);
  const roomBootstrap = useLiveMeetingRoomBootstrap(micCamera);
  const bridges = useLiveMeetingFeatureBridges();
  const connected = useLiveMeetingConnectLifecycle({ ...roomBootstrap, ...bridges.callbacks });
  const [joinRequests, setJoinRequests] = useState<MeetingJoinRequest[]>([]);
  const [isJoinRequestsOpen, setIsJoinRequestsOpen] = useState(false);
  const [isScreenShareFeatureFailed, setIsScreenShareFeatureFailed] = useState(false);
  const [researchVersion, setResearchVersion] = useState(0);
  const chrome = useLiveMeetingCallChrome({ connected, isScreenShareFeatureFailed });
  useEffect(() => {
    if (!isScreenShareFeatureFailed) {
      return;
    }

    const room = connected.room;
    if (room === null) {
      return;
    }

    return guardFailedScreenShareFeature({
      isScreenShareEnabled: () => room.localParticipant.isScreenShareEnabled,
      stopScreenShare: async () => {
        await room.localParticipant.setScreenShareEnabled(false);
      },
      onLocalTrackPublished: (listener) => {
        room.on(RoomEvent.LocalTrackPublished, listener);

        return () => {
          room.off(RoomEvent.LocalTrackPublished, listener);
        };
      },
    });
  }, [connected.room, isScreenShareFeatureFailed]);
  const hosts = useLiveMeetingFeatureHosts();

  return {
    ...connected,
    ...bridges.refs,
    ...chrome,
    hosts,
    isJoinRequestsOpen,
    joinRequests,
    researchVersion,
    setIsJoinRequestsOpen,
    setIsScreenShareFeatureFailed,
    setJoinRequests,
    setResearchVersion,
  };
}

type LiveMeetingCallRuntime = ReturnType<typeof useLiveMeetingInRoomRuntime>;
type LiveMeetingFeatureCall = Omit<LiveMeetingCallRuntime, "onEndMeeting">;

function portalNode(input: { host: HTMLElement | null; node: ReactNode }): ReactNode {
  if (input.host === null || input.node === null) {
    return null;
  }

  return createPortal(input.node, input.host);
}

function useLiveMeetingWebSearchState() {
  const [webSearchPanelState, setWebSearchPanelState] = useState<WebSearchPanelState | null>(null);
  const [webSearchHistory, setWebSearchHistory] = useState<WebSearchPanelState[]>([]);
  const webSearchPanelStateRef = useRef<WebSearchPanelState | null>(null);
  const webSearchDeferredPayloadTimerRef = useRef<number | null>(null);
  const webSearchDeferredPayloadResolveRef = useRef<((applied: boolean) => void) | null>(null);
  const webSearchPanelSearchStartedAtRef = useRef<number | null>(null);
  const webSearchPanelSearchKeyRef = useRef<string | null>(null);
  const webSearchPanelRunIdRef = useRef(0);
  const updateWebSearchPanelState = useCallback((nextState: WebSearchPanelState) => {
    if (isStaleVoiceWebSearchProgress(webSearchPanelStateRef.current, nextState)) {
      return;
    }
    if (nextState.status === "error") {
      console.error("[readymeet:optional-live-feature] research unavailable.");
      webSearchPanelStateRef.current = null;
      setWebSearchPanelState(null);
      setWebSearchHistory((current) =>
        current.filter((state) => !voiceWebSearchPayloadMatchesCurrent(state, nextState)),
      );

      return;
    }
    webSearchPanelStateRef.current = nextState;
    setWebSearchPanelState(nextState);
    setWebSearchHistory((current) => upsertWebSearchHistory({ history: current, nextState }));
  }, []);
  useEffect(() => {
    webSearchPanelStateRef.current = webSearchPanelState;
  }, [webSearchPanelState]);

  return {
    setWebSearchHistory,
    setWebSearchPanelState,
    updateWebSearchPanelState,
    webSearchDeferredPayloadResolveRef,
    webSearchDeferredPayloadTimerRef,
    webSearchHistory,
    webSearchPanelRunIdRef,
    webSearchPanelSearchKeyRef,
    webSearchPanelSearchStartedAtRef,
    webSearchPanelState,
    webSearchPanelStateRef,
  };
}

function buildLiveMeetingResearchApi(input: {
  ambientContextPanel: ReturnType<typeof useLiveMeetingAmbientContextPanel>;
  research: ReturnType<typeof useLiveMeetingResearchContext>;
  webSearch: ReturnType<typeof useLiveMeetingWebSearchState>;
}): LiveMeetingResearchApi {
  const { ambientContextPanel, research, webSearch } = input;

  return {
    ambientContextItems: research.ambientContextPipeline.ambientContextItems,
    ambientContextPillItems: research.ambientContextPipeline.ambientContextPillItems,
    contextImageUrls: research.ambientContextPipeline.contextImageUrls,
    expiredAmbientContextItemIds: research.ambientContextPipeline.expiredAmbientContextItemIds,
    isAmbientContextPanelOpen: ambientContextPanel.isAmbientContextPanelOpen,
    openAmbientContextPanel: ambientContextPanel.openAmbientContextPanel,
    peopleMemoryItems: research.peopleMemoryItems,
    retryAmbientContextItem: ambientContextPanel.retryAmbientContextItem,
    selectedRelevantDetailsItemKey: ambientContextPanel.selectedRelevantDetailsItemKey,
    setIsAmbientContextPanelOpen: ambientContextPanel.setIsAmbientContextPanelOpen,
    setSelectedRelevantDetailsItemKey: ambientContextPanel.setSelectedRelevantDetailsItemKey,
    updateWebSearchPanelState: webSearch.updateWebSearchPanelState,
    webSearchDeferredPayloadResolveRef: webSearch.webSearchDeferredPayloadResolveRef,
    webSearchDeferredPayloadTimerRef: webSearch.webSearchDeferredPayloadTimerRef,
    webSearchHistory: webSearch.webSearchHistory,
    webSearchPanelRunIdRef: webSearch.webSearchPanelRunIdRef,
    webSearchPanelSearchKeyRef: webSearch.webSearchPanelSearchKeyRef,
    webSearchPanelSearchStartedAtRef: webSearch.webSearchPanelSearchStartedAtRef,
    webSearchPanelState: webSearch.webSearchPanelState,
    webSearchPanelStateRef: webSearch.webSearchPanelStateRef,
  };
}

function useLiveMeetingResearchFeatureModel(call: LiveMeetingFeatureCall) {
  const webSearch = useLiveMeetingWebSearchState();
  const research = useLiveMeetingResearchContext({
    activeSession: call.activeSession,
    hasJoinedMeeting: call.hasJoinedMeeting,
    isAmbientContextEnabled: call.isAmbientContextEnabled,
    isGuestSession: call.isGuestSession,
    joinRequests: call.joinRequests,
    meeting: call.meeting,
    meetingIdForPrivateDetails: call.meetingIdForPrivateDetails,
    meetingRecordId: call.meetingRecordId,
    presenceVersion: call.presenceVersion,
    privateDetailsToken: call.privateDetailsToken,
    realtimeClient: call.realtimeClient,
    realtimeScopeKey: call.realtimeScopeKey,
    refreshRealtimeAuth: call.refreshRealtimeAuth,
    room: call.room,
  });
  const ambientContextPanel = useLiveMeetingAmbientContextPanel({
    activeSession: call.activeSession,
    meeting: call.meeting,
    ambientContextItems: research.ambientContextPipeline.ambientContextItems,
    webSearchHistory: webSearch.webSearchHistory,
    expiredAmbientContextItemIds: research.ambientContextPipeline.expiredAmbientContextItemIds,
    restartAmbientContextWait: research.ambientContextPipeline.restartAmbientContextWait,
    setAmbientContextItems: research.ambientContextPipeline.setAmbientContextItems,
    showToast: call.showToast,
    setIsPresencePanelOpen: call.setIsPresencePanelOpen,
    setIsToolApprovalPanelOpen: call.setIsToolApprovalPanelOpen,
    setIsLinearActionPanelOpen: call.setIsLinearActionPanelOpen,
    setIsMeetingDetailsPanelOpen: call.setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen: call.setIsMeetingSettingsPanelOpen,
  });
  useLiveMeetingWebSearchPanelLifecycle({
    webSearchPanelState: webSearch.webSearchPanelState,
    setWebSearchPanelState: webSearch.setWebSearchPanelState,
    setWebSearchHistory: webSearch.setWebSearchHistory,
    updateWebSearchPanelState: webSearch.updateWebSearchPanelState,
    webSearchPanelStateRef: webSearch.webSearchPanelStateRef,
    webSearchPanelRunIdRef: webSearch.webSearchPanelRunIdRef,
    webSearchDeferredPayloadTimerRef: webSearch.webSearchDeferredPayloadTimerRef,
    webSearchDeferredPayloadResolveRef: webSearch.webSearchDeferredPayloadResolveRef,
    liveRoomJoiningInfoCopiedTimerRef: call.liveRoomJoiningInfoCopiedTimerRef,
    activeSession: call.activeSession,
    activeSessionToken: call.activeSessionToken,
    activeSessionUserSource: call.activeSessionUserSource,
    meeting: call.meeting,
    meetingRecordId: call.meetingRecordId,
    sessionToken: call.sessionToken,
    isAmbientContextPanelOpen: ambientContextPanel.isAmbientContextPanelOpen,
  });
  // Siblings such as the memory-arrival hook read these values through researchApiRef, so they must bump the version.
  const researchKey = [
    research.peopleMemoryItems
      .map(
        (item) =>
          `${item.id}:${item.status}:${item.lastMentionedAt}:${item.researchCompletedAt ?? ""}:${item.privateDetails?.memory ? "memory" : ""}`,
      )
      .join(","),
    research.ambientContextPipeline.ambientContextItems
      .map(
        (item) =>
          `${item.id}:${item.status}:${item.lastMentionedAt}:${item.researchCompletedAt ?? ""}:${(item.selectionAliases ?? []).join("+")}`,
      )
      .join(","),
    String(ambientContextPanel.isAmbientContextPanelOpen),
    String(webSearch.webSearchHistory.length),
    webSearch.webSearchPanelState?.status ?? "",
    webSearch.webSearchPanelState?.updatedAt ?? "",
  ].join("|");
  const researchApiRef = call.researchApiRef;
  researchApiRef.current = buildLiveMeetingResearchApi({ ambientContextPanel, research, webSearch });
  useLayoutEffect(() => {
    return () => {
      researchApiRef.current = null;
    };
  }, [researchApiRef]);
  useEffect(() => {
    call.setResearchVersion((version) => version + 1);
  }, [call.setResearchVersion, researchKey]);
  const relevantDetailsPillWebSearchState = useMemo(
    () => latestReadableWebResult([webSearch.webSearchPanelState, ...webSearch.webSearchHistory]),
    [webSearch.webSearchHistory, webSearch.webSearchPanelState],
  );

  return {
    ambientContextPanel,
    readableWebSearchHistory: webSearch.webSearchHistory.filter((state) => state.status !== "error"),
    relevantDetailsPillWebSearchState,
    research,
  };
}

function LiveMeetingResearchFeature(props: { call: LiveMeetingFeatureCall }): ReactNode {
  const { call } = props;
  const model = useLiveMeetingResearchFeatureModel(call);
  const isPillVisible = call.shouldShowLiveMeetingChrome && call.isAvatarRevealed ? true : false;

  return (
    <>
      {portalNode({
        host: call.hosts.researchPillHost,
        node: (
          <AmbientContextPill
            items={model.research.ambientContextPipeline.ambientContextPillItems}
            webSearchState={model.relevantDetailsPillWebSearchState}
            imageUrls={model.research.ambientContextPipeline.contextImageUrls}
            isVisible={isPillVisible}
            isOpen={model.ambientContextPanel.isAmbientContextPanelOpen}
            onClick={(itemKey) =>
              handleLiveMeetingAmbientContextPillClick({
                itemKey,
                isAmbientContextPanelOpen: model.ambientContextPanel.isAmbientContextPanelOpen,
                setIsAmbientContextPanelOpen: model.ambientContextPanel.setIsAmbientContextPanelOpen,
                setSelectedRelevantDetailsItemKey: model.ambientContextPanel.setSelectedRelevantDetailsItemKey,
                openAmbientContextPanel: model.ambientContextPanel.openAmbientContextPanel,
              })
            }
          />
        ),
      })}
      {portalNode({
        host: call.hosts.ambientPanelHost,
        node: (
          <AmbientContextPanel
            ambientItems={model.research.ambientContextPipeline.ambientContextItems.filter(
              (item) =>
                item.status !== "failed" &&
                !model.research.ambientContextPipeline.expiredAmbientContextItemIds.has(item.id),
            )}
            factsLayout="standing"
            expiredItemIds={model.research.ambientContextPipeline.expiredAmbientContextItemIds}
            webSearchItems={model.readableWebSearchHistory}
            imageUrls={model.research.ambientContextPipeline.contextImageUrls}
            isOpen={model.ambientContextPanel.isAmbientContextPanelOpen}
            selectedItemKey={model.ambientContextPanel.selectedRelevantDetailsItemKey}
            onSelect={model.ambientContextPanel.setSelectedRelevantDetailsItemKey}
            onRetry={model.ambientContextPanel.retryAmbientContextItem}
            onClose={() => {
              model.ambientContextPanel.setIsAmbientContextPanelOpen(false);
              model.ambientContextPanel.setSelectedRelevantDetailsItemKey(null);
            }}
          />
        ),
      })}
    </>
  );
}

function useLiveMeetingAgentLocalState(meetingRecordId: string | undefined) {
  const [agentHelpPhase, setAgentHelpPhase] = useState<AgentHelpPhase>("idle");
  const [agentHelpOwnerParticipantIdentity, setAgentHelpOwnerParticipantIdentity] = useState<string | null>(null);
  const [isConversationModeActive, setIsConversationModeActive] = useState(false);
  const [voiceModePendingAction, setVoiceModePendingAction] = useState<VoiceModePendingAction>(null);
  const [isAgentHelpTooltipDismissed, setIsAgentHelpTooltipDismissed] = useState(false);
  const [toolApprovalCards, setToolApprovalCards] = useState<VoiceToolApprovalCardState[]>([]);
  const [linearActionPanelState, setLinearActionPanelState] = useState<LinearActionPanelState | null>(null);
  const linearActionPanelStateRef = useRef<LinearActionPanelState | null>(null);
  const calendarOAuthPopupRef = useRef<Window | null>(null);
  const fallbackWebSearchPanelStateRef = useRef<WebSearchPanelState | null>(null);
  const fallbackWebSearchPanelRunIdRef = useRef(0);
  const fallbackWebSearchPanelSearchStartedAtRef = useRef<number | null>(null);
  const fallbackWebSearchPanelSearchKeyRef = useRef<string | null>(null);
  const fallbackWebSearchDeferredPayloadTimerRef = useRef<number | null>(null);
  const fallbackWebSearchDeferredPayloadResolveRef = useRef<((applied: boolean) => void) | null>(null);
  useEffect(() => {
    linearActionPanelStateRef.current = linearActionPanelState;
  }, [linearActionPanelState]);
  useEffect(() => {
    setIsAgentHelpTooltipDismissed(false);
  }, [meetingRecordId]);

  return {
    agentHelpOwnerParticipantIdentity,
    agentHelpPhase,
    calendarOAuthPopupRef,
    fallbackWebSearchDeferredPayloadResolveRef,
    fallbackWebSearchDeferredPayloadTimerRef,
    fallbackWebSearchPanelRunIdRef,
    fallbackWebSearchPanelSearchKeyRef,
    fallbackWebSearchPanelSearchStartedAtRef,
    fallbackWebSearchPanelStateRef,
    isAgentHelpTooltipDismissed,
    isConversationModeActive,
    linearActionPanelState,
    linearActionPanelStateRef,
    setAgentHelpOwnerParticipantIdentity,
    setAgentHelpPhase,
    setIsAgentHelpTooltipDismissed,
    setIsConversationModeActive,
    setLinearActionPanelState,
    setToolApprovalCards,
    setVoiceModePendingAction,
    toolApprovalCards,
    voiceModePendingAction,
  };
}

function readLiveMeetingAgentResearch(input: {
  research: LiveMeetingResearchApi | null;
  fallback: ReturnType<typeof useLiveMeetingAgentLocalState>;
  ignoreAmbientOpen: Dispatch<SetStateAction<boolean>>;
  ignoreAmbientKey: Dispatch<SetStateAction<string | null>>;
  ignoreWebSearch: (nextState: WebSearchPanelState) => void;
}) {
  if (input.research === null) {
    return {
      ambientContextPanel: {
        setIsAmbientContextPanelOpen: input.ignoreAmbientOpen,
        setSelectedRelevantDetailsItemKey: input.ignoreAmbientKey,
      },
      updateWebSearchPanelState: input.ignoreWebSearch,
      webSearchDeferredPayloadResolveRef: input.fallback.fallbackWebSearchDeferredPayloadResolveRef,
      webSearchDeferredPayloadTimerRef: input.fallback.fallbackWebSearchDeferredPayloadTimerRef,
      webSearchPanelRunIdRef: input.fallback.fallbackWebSearchPanelRunIdRef,
      webSearchPanelSearchKeyRef: input.fallback.fallbackWebSearchPanelSearchKeyRef,
      webSearchPanelSearchStartedAtRef: input.fallback.fallbackWebSearchPanelSearchStartedAtRef,
      webSearchPanelStateRef: input.fallback.fallbackWebSearchPanelStateRef,
    };
  }

  return {
    ambientContextPanel: {
      setIsAmbientContextPanelOpen: input.research.setIsAmbientContextPanelOpen,
      setSelectedRelevantDetailsItemKey: input.research.setSelectedRelevantDetailsItemKey,
    },
    updateWebSearchPanelState: input.research.updateWebSearchPanelState,
    webSearchDeferredPayloadResolveRef: input.research.webSearchDeferredPayloadResolveRef,
    webSearchDeferredPayloadTimerRef: input.research.webSearchDeferredPayloadTimerRef,
    webSearchPanelRunIdRef: input.research.webSearchPanelRunIdRef,
    webSearchPanelSearchKeyRef: input.research.webSearchPanelSearchKeyRef,
    webSearchPanelSearchStartedAtRef: input.research.webSearchPanelSearchStartedAtRef,
    webSearchPanelStateRef: input.research.webSearchPanelStateRef,
  };
}

function buildLiveMeetingAgentVoiceSessionInput(input: {
  call: LiveMeetingFeatureCall;
  local: ReturnType<typeof useLiveMeetingAgentLocalState>;
  presence: ReturnType<typeof useLiveMeetingAgentPresence>;
  researchBindings: ReturnType<typeof readLiveMeetingAgentResearch>;
}): LiveMeetingPageAgentVoiceSessionInput {
  const { call, local, presence, researchBindings } = input;

  return {
    session: call.session,
    meetingId: call.meetingId,
    meeting: call.meeting,
    meetingRecordId: call.meetingRecordId,
    room: call.room,
    connectionState: call.connectionState,
    showToast: call.showToast,
    toolApprovalCards: local.toolApprovalCards,
    linearActionPanelState: local.linearActionPanelState,
    linearActionPanelStateRef: local.linearActionPanelStateRef,
    calendarOAuthPopupRef: local.calendarOAuthPopupRef,
    webSearchPanelStateRef: researchBindings.webSearchPanelStateRef,
    webSearchPanelRunIdRef: researchBindings.webSearchPanelRunIdRef,
    webSearchPanelSearchStartedAtRef: researchBindings.webSearchPanelSearchStartedAtRef,
    webSearchPanelSearchKeyRef: researchBindings.webSearchPanelSearchKeyRef,
    webSearchDeferredPayloadTimerRef: researchBindings.webSearchDeferredPayloadTimerRef,
    webSearchDeferredPayloadResolveRef: researchBindings.webSearchDeferredPayloadResolveRef,
    voiceModeIntentRef: call.voiceModeIntentRef,
    updateWebSearchPanelState: researchBindings.updateWebSearchPanelState,
    setIsToolApprovalPanelOpen: call.setIsToolApprovalPanelOpen,
    ambientContextPanel: researchBindings.ambientContextPanel,
    setIsMeetingDetailsPanelOpen: call.setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen: call.setIsMeetingSettingsPanelOpen,
    setIsPresencePanelOpen: call.setIsPresencePanelOpen,
    setToolApprovalCards: local.setToolApprovalCards,
    setIsLinearActionPanelOpen: call.setIsLinearActionPanelOpen,
    setLinearActionPanelState: local.setLinearActionPanelState,
    applyAssistantPresencePayload: presence.applyAssistantPresencePayload,
    isConversationModeActive: local.isConversationModeActive,
    agentHelpOwnerParticipantIdentity: local.agentHelpOwnerParticipantIdentity,
    agentHelpPhase: local.agentHelpPhase,
    voiceModePendingAction: local.voiceModePendingAction,
    isConversationModeActiveRef: call.isConversationModeActiveRef,
    voiceModeRpcPendingRef: call.voiceModeRpcPendingRef,
    owedVoiceStopRef: call.owedVoiceStopRef,
    setVoiceModePendingAction: local.setVoiceModePendingAction,
    setIsAgentHelpTooltipDismissed: local.setIsAgentHelpTooltipDismissed,
    setError: call.setError,
    setSyncedConversationModeActive: presence.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: presence.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: presence.setSyncedAgentHelpPhase,
    showAgentHelpCreditsRequiredToast: call.showAgentHelpCreditsRequiredToast,
    isSoloVoiceAvailable: call.isSoloVoiceAvailable,
    isAssistantParticipantSpeaking: call.isAssistantParticipantSpeaking,
    isAgentHelpAvailable: call.isAgentHelpAvailable,
  };
}

function useLiveMeetingAgentFeatureModel(call: LiveMeetingFeatureCall) {
  const local = useLiveMeetingAgentLocalState(call.meetingRecordId);
  const ignoreAmbientOpen = useCallback<Dispatch<SetStateAction<boolean>>>(() => undefined, []);
  const ignoreAmbientKey = useCallback<Dispatch<SetStateAction<string | null>>>(() => undefined, []);
  const ignoreWebSearch = useCallback((_nextState: WebSearchPanelState) => undefined, []);
  const presence = useLiveMeetingAgentPresence({
    isConversationModeActiveRef: call.isConversationModeActiveRef,
    setAgentHelpOwnerParticipantIdentity: local.setAgentHelpOwnerParticipantIdentity,
    setAgentHelpPhase: local.setAgentHelpPhase,
    setAssistantDisplayNamesByIdentity: call.setAssistantDisplayNamesByIdentity,
    setIsConversationModeActive: local.setIsConversationModeActive,
    voiceModeIntentRef: call.voiceModeIntentRef,
    voiceModeRpcPendingRef: call.voiceModeRpcPendingRef,
  });
  const agentPresenceRef = call.agentPresenceRef;
  agentPresenceRef.current = { ...presence, setVoiceModePendingAction: local.setVoiceModePendingAction };
  useLayoutEffect(() => {
    return () => {
      agentPresenceRef.current = null;
    };
  }, [agentPresenceRef]);
  const researchBindings = readLiveMeetingAgentResearch({
    research: call.researchApiRef.current,
    fallback: local,
    ignoreAmbientOpen,
    ignoreAmbientKey,
    ignoreWebSearch,
  });
  const agentVoiceSession = useLiveMeetingPageAgentVoiceSession(
    buildLiveMeetingAgentVoiceSessionInput({ call, local, presence, researchBindings }),
  );
  useLiveMeetingPageAgentHelpPhaseSync({
    isSoloVoiceAvailable: call.isSoloVoiceAvailable,
    isConversationModeActive: local.isConversationModeActive,
    agentHelpPhase: local.agentHelpPhase,
    isAssistantParticipantSpeaking: call.isAssistantParticipantSpeaking,
    setSyncedConversationModeActive: presence.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: presence.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: presence.setSyncedAgentHelpPhase,
  });
  useLiveMeetingPageAgentHelpAvailabilityReset({
    isAgentHelpAvailable: call.isAgentHelpAvailable,
    voiceModeRpcPendingRef: call.voiceModeRpcPendingRef,
    setVoiceModePendingAction: local.setVoiceModePendingAction,
    setSyncedConversationModeActive: presence.setSyncedConversationModeActive,
    setSyncedAgentHelpOwnerParticipantIdentity: presence.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: presence.setSyncedAgentHelpPhase,
  });
  useLiveMeetingPageAgentVoiceInterrupt({
    room: call.room,
    isConversationModeActiveRef: call.isConversationModeActiveRef,
    setSyncedAgentHelpOwnerParticipantIdentity: presence.setSyncedAgentHelpOwnerParticipantIdentity,
    setSyncedAgentHelpPhase: presence.setSyncedAgentHelpPhase,
    setError: call.setError,
    performAssistantRpc: agentVoiceSession.performAssistantRpc,
  });

  return {
    agentVoiceSession,
    canConfirmLinearAction: canConfirmLiveMeetingLinearAction({
      linearActionPanelState: local.linearActionPanelState,
      sessionUserId: call.activeSessionUserId,
    }),
    isAgentHelpTurnOwner: isLiveMeetingAgentHelpTurnOwner({
      room: call.room,
      agentHelpOwnerParticipantIdentity: local.agentHelpOwnerParticipantIdentity,
    }),
    local,
    shouldShowAgentHelpTooltip: shouldShowLiveMeetingAgentHelpTooltip({
      isSoloVoiceAvailable: call.isSoloVoiceAvailable,
      isAgentHelpTooltipDismissed: local.isAgentHelpTooltipDismissed,
      isAgentIntroMeeting: isLiveMeetingAgentIntroMeeting(call.meeting),
    }),
    voiceModeControlState: getVoiceModeControlState({
      conversationModeActive: local.isConversationModeActive,
      localParticipantIdentity: getLiveMeetingLocalParticipantIdentity(call.room),
      ownerParticipantIdentity: local.agentHelpOwnerParticipantIdentity,
      pendingAction: local.voiceModePendingAction,
    }),
  };
}

function renderLiveMeetingAgentFeature(input: {
  call: LiveMeetingFeatureCall;
  model: ReturnType<typeof useLiveMeetingAgentFeatureModel>;
}): ReactNode {
  const { call, model } = input;
  const { local } = model;

  return (
    <>
      {portalNode({
        host: call.hosts.agentGlowHost,
        node: (
          <AgentVoiceGlow
            active={call.isControlsRevealed ? local.isConversationModeActive : false}
            speaking={call.isAssistantParticipantSpeaking}
            level={call.readAssistantSpeechLevel}
          />
        ),
      })}
      {portalNode({
        host: call.hosts.agentHelpHost,
        node: renderLiveMeetingAgentHelpVoiceControl({
          isAgentHelpAvailable: call.isAgentHelpAvailable,
          isSoloVoiceAvailable: call.isSoloVoiceAvailable,
          isAssistantParticipantSpeaking: call.isAssistantParticipantSpeaking,
          isBusy: call.isBusy,
          isAgentTurnBlockedByOther: isLiveMeetingAgentTurnBlockedByOther({
            agentHelpPhase: local.agentHelpPhase,
            isAgentHelpTurnOwner: model.isAgentHelpTurnOwner,
          }),
          voiceModeControlState: model.voiceModeControlState,
          voiceModePendingAction: local.voiceModePendingAction,
          voiceModeTitle: model.voiceModeControlState.ariaLabel,
          isConversationModeActive: local.isConversationModeActive,
          shouldShowAgentHelpTooltip: model.shouldShowAgentHelpTooltip,
          agentHelpTooltipText: LIVE_MEETING_PAGE_COPY.agentHelpTooltipText,
          toggleConversationMode: model.agentVoiceSession.toggleConversationMode,
        }),
      })}
      {portalNode({
        host: call.hosts.toolApprovalHost,
        node: (
          <LiveFeatureBoundary feature="calendar">
            <ToolApprovalPanel
              cards={local.toolApprovalCards}
              isOpen={call.isToolApprovalPanelOpen}
              onClose={() => call.setIsToolApprovalPanelOpen(false)}
              onConnectCalendar={(card) => void model.agentVoiceSession.connectCalendarFromApprovalCard(card)}
              onDisconnectCalendar={(card) => void model.agentVoiceSession.disconnectCalendarFromApprovalCard(card)}
              onRequestWorkflow={(card) => model.agentVoiceSession.requestWorkflowFromApprovalCard(card)}
            />
          </LiveFeatureBoundary>
        ),
      })}
      {portalNode({
        host: call.hosts.linearPanelHost,
        node: (
          <LinearActionPanel
            state={local.linearActionPanelState}
            isOpen={call.isLinearActionPanelOpen}
            canConfirm={model.canConfirmLinearAction}
            onClose={() => call.setIsLinearActionPanelOpen(false)}
            onAllow={() => void model.agentVoiceSession.handleLinearActionAllow()}
            onCancel={() => void model.agentVoiceSession.handleLinearActionCancel()}
          />
        ),
      })}
    </>
  );
}

function LiveMeetingAgentFeature(props: { call: LiveMeetingFeatureCall }): ReactNode {
  const model = useLiveMeetingAgentFeatureModel(props.call);

  return renderLiveMeetingAgentFeature({ call: props.call, model });
}

function useLiveMeetingCaptionsFeatureModel(call: LiveMeetingFeatureCall) {
  const [isTranscriptVisible, setIsTranscriptVisible] = useState(false);
  const [transcriptionState, setTranscriptionState] = useState<TranscriptionState>("off");
  const [liveTranscriptSegments, setLiveTranscriptSegments] = useState<MeetingDetailPayload["transcriptSegments"]>([]);
  const [realtimeTranscriptLines, setRealtimeTranscriptLines] = useState<LiveTranscriptLine[]>([]);
  const [seenTranscriptLineIds, setSeenTranscriptLineIds] = useState<Set<string> | null>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const captionsApiRef = call.captionsApiRef;
  captionsApiRef.current = { setIsTranscriptVisible, setLiveTranscriptSegments, setRealtimeTranscriptLines };
  useLayoutEffect(() => {
    return () => {
      captionsApiRef.current = null;
    };
  }, [captionsApiRef]);
  useEffect(() => {
    return runLiveMeetingStartLiveTranscriptionEffect({
      activeSession: call.activeSession,
      meeting: call.meeting,
      hasJoinedMeeting: call.hasJoinedMeeting,
      isGuestSession: call.isGuestSession,
      connectionState: call.connectionState,
      setTranscriptionState,
      setError: call.setError,
    });
  }, [
    call.activeSession,
    call.connectionState,
    call.hasJoinedMeeting,
    call.isGuestSession,
    call.meeting,
    call.setError,
  ]);
  const finalTranscriptKey = useMemo(
    () =>
      realtimeTranscriptLines
        .filter((line) => line.isFinal)
        .map((line) => `${line.id}:${line.content}`)
        .join("\n"),
    [realtimeTranscriptLines],
  );
  useLiveMeetingDetailRefresh({
    token: call.activeSession?.token,
    meetingId: call.meeting?.id,
    isEnabled: call.hasJoinedMeeting && call.connectionState === ConnectionState.Connected,
    room: call.room,
    finalTranscriptKey,
    setActiveHumanParticipants: call.setActiveHumanParticipants,
    setLiveTranscriptSegments,
  });
  const transcriptPresenceLayout = useLiveMeetingTranscriptPresenceLayout({
    activeHumanParticipants: call.activeHumanParticipants,
    activeSession: call.activeSession,
    room: call.room,
    tracks: call.tracks,
    presenceVersion: call.presenceVersion,
    liveTranscriptSegments,
    realtimeTranscriptLines,
    activeSessionUserId: call.activeSessionUserId,
    assistantDisplayNamesByIdentity: call.assistantDisplayNamesByIdentity,
    isTranscriptVisible,
    transcriptionState,
    isCaptionSpeechActive: call.isCaptionSpeechActive,
    transcriptBottomRef,
    setSeenTranscriptLineIds,
  });
  const dismissTranscript = useCallback(() => setIsTranscriptVisible(false), []);
  useOutsidePointerDismiss({
    isActive: isTranscriptVisible,
    insideSelector: LIVE_TRANSCRIPT_DISMISS_SAFE_SELECTOR,
    onDismiss: dismissTranscript,
  });

  return {
    isTranscriptVisible,
    seenTranscriptLineIds,
    setIsTranscriptVisible,
    setRealtimeTranscriptLines,
    transcriptBottomRef,
    transcriptPresenceLayout,
    transcriptionState,
  };
}

function LiveMeetingCaptionsFeature(props: { call: LiveMeetingFeatureCall }): ReactNode {
  const { call } = props;
  const captions = useLiveMeetingCaptionsFeatureModel(call);

  return (
    <>
      {renderLiveMeetingTranscriptionBridgeWhenRoom({ room: call.room, onLines: captions.setRealtimeTranscriptLines })}
      {portalNode({
        host: call.hosts.captionsHost,
        node: renderLiveMeetingCaptionsControlButton({
          isBusy: call.isBusy,
          activeSession: call.activeSession,
          transcriptionState: captions.transcriptionState,
          isTranscriptVisible: captions.isTranscriptVisible,
          isCaptionsWaveActive: captions.transcriptPresenceLayout.isCaptionsWaveActive,
          readSpeechLevel: call.readSpeechLevel,
          setIsTranscriptVisible: captions.setIsTranscriptVisible,
        }),
      })}
      {portalNode({
        host: call.hosts.transcriptHost,
        node: renderLiveMeetingTranscriptStrip({
          shouldShowLiveTranscript: captions.transcriptPresenceLayout.shouldShowLiveTranscript,
          isEndMeetingFlowActive: call.isEndMeetingFlowActive,
          visibleTranscriptLines: captions.transcriptPresenceLayout.visibleTranscriptLines,
          seenTranscriptLineIds: captions.seenTranscriptLineIds,
          transcriptionState: captions.transcriptionState,
          connectionState: call.connectionState,
          transcriptBottomRef: captions.transcriptBottomRef,
        }),
      })}
    </>
  );
}

function LiveMeetingScreenShareFeature(props: { call: LiveMeetingFeatureCall }): ReactNode {
  const { call } = props;
  const controls = useLiveMeetingScreenShareControls({
    room: call.room,
    setError: call.setError,
    setIsScreenShareFullscreen: call.setIsScreenShareFullscreen,
  });
  const layout = useLiveMeetingScreenSharePresentationLayout({
    room: call.room,
    session: call.session,
    tracks: call.tracks,
    pinnedScreenShareTrackId: controls.pinnedScreenShareTrackId,
    isScreenShareFullscreen: call.isScreenShareFullscreen,
    endMeetingFlow: call.endMeetingFlow,
    dataPresentationClaimsByIdentity: controls.dataPresentationClaimsByIdentity,
    presenceVersion: call.presenceVersion,
    isScreenShareBusy: controls.isScreenShareBusy,
    onClearLocalPresentationIntent: controls.clearLocalPresentationIntent,
    setPinnedScreenShareTrackId: controls.setPinnedScreenShareTrackId,
    setError: call.setError,
    setIsMeetingDetailsPanelOpen: call.setIsMeetingDetailsPanelOpen,
    setIsMeetingSettingsPanelOpen: call.setIsMeetingSettingsPanelOpen,
  });
  call.screenShareApiRef.current = {
    setIsScreenShareBusy: controls.setIsScreenShareBusy,
    setPinnedScreenShareTrackId: controls.setPinnedScreenShareTrackId,
    updateDataPresentationClaims: controls.updateDataPresentationClaims,
  };
  useLayoutEffect(() => {
    const screenShareApiRef = call.screenShareApiRef;

    return () => {
      screenShareApiRef.current = null;
    };
  }, [call.screenShareApiRef]);
  const screenShareLayout =
    layout.selectedScreenShareVisual === null
      ? null
      : renderLiveMeetingScreenShareLayout({
          selectedScreenShareVisual: layout.selectedScreenShareVisual,
          isScreenShareFullscreen: call.isScreenShareFullscreen,
          screenShareStageShellRef: controls.screenShareStageShellRef,
          participantVisuals: call.participantVideoStage.participantVisuals,
          renderParticipantVisual: call.participantVideoStage.renderParticipantVisual,
          toggleScreenShareFullscreen: controls.toggleScreenShareFullscreen,
        });

  return (
    <>
      {portalNode({
        host: call.hosts.screenShareHost,
        node: renderLiveMeetingScreenShareControlButton({
          room: call.room,
          isBusy: call.isBusy,
          isScreenShareBusy: controls.isScreenShareBusy,
          canScreenShare: controls.canScreenShare,
          localScreenShareVisual: layout.localScreenShareVisual,
          screenShareBlockerMessage: layout.screenShareBlockerMessage,
          toggleScreenShare: controls.toggleScreenShare,
        }),
      })}
      {portalNode({ host: call.hosts.screenShareStageHost, node: screenShareLayout })}
    </>
  );
}

function LiveMeetingDialInFeature(props: { call: LiveMeetingFeatureCall }): ReactNode {
  const { call } = props;
  const [isLiveRoomJoiningInfoCopied, setIsLiveRoomJoiningInfoCopied] = useState(false);
  const joinChrome = useLiveMeetingPageInRoomJoinChromeDerivations({
    endMeetingFlow: call.endMeetingFlow,
    meeting: call.meeting,
    liveRoomOrigin: call.liveRoomOrigin,
    liveRoomJoiningInfoCopiedTimerRef: call.liveRoomJoiningInfoCopiedTimerRef,
    setError: call.setError,
    setIsLiveRoomJoiningInfoCopied,
    showToast: call.showToast,
    hasActiveScreenShare: call.hasActiveScreenShare,
    isScreenShareFullscreen: call.isScreenShareFullscreen,
    isSoloVoiceAvailable: call.isSoloVoiceAvailable,
    isAgentHelpTooltipDismissed: false,
    liveRoomClock: call.liveRoomClock,
    webSearchPanelState: null,
    webSearchHistory: [],
  });
  if (!call.shouldShowInRoomDetailsSettingsPanels || !hasMeetingRecord(call.meeting)) {
    return null;
  }

  return portalNode({
    host: call.hosts.detailsHost,
    node: (
      <MeetingDetailsPanel
        meetingTitle={call.meeting.title}
        joinUrl={joinChrome.liveRoomJoinUrl}
        callIn={joinChrome.liveRoomCallIn}
        isOpen={call.isMeetingDetailsPanelOpen}
        isJoiningInfoCopied={isLiveRoomJoiningInfoCopied}
        onClose={() => call.setIsMeetingDetailsPanelOpen(false)}
        onCopyJoiningInfo={() => void joinChrome.onCopyLiveRoomJoiningInfo()}
      />
    ),
  });
}

function useLiveMeetingInvitesFeatureModel(call: LiveMeetingFeatureCall) {
  const joinRequestModeration = useLiveMeetingJoinRequestModeration({
    meeting: call.meeting,
    activeSession: call.activeSession,
    canCheckJoinRequests: call.canCheckJoinRequests,
    refreshAuthAfterUnauthorized: call.refreshAuthAfterUnauthorized,
    realtimeClient: call.realtimeClient,
    realtimeScopeKey: call.realtimeScopeKey,
    refreshRealtimeAuth: call.refreshRealtimeAuth,
    setError: call.setError,
  });
  const research = call.researchApiRef.current;
  const collaboration = useLiveMeetingPageInRoomCollaborationChrome({
    shouldShowLiveMeetingChrome: call.shouldShowLiveMeetingChrome,
    liveRoomJoinUrl: call.liveRoomJoinUrl,
    isAvatarRevealed: call.isAvatarRevealed,
    joinRequestModeration,
    activeSession: call.activeSession,
    meeting: call.meeting,
    hasJoinedMeeting: call.hasJoinedMeeting,
    peopleMemoryItems: research?.peopleMemoryItems ?? EMPTY_PEOPLE_MEMORY,
    ambientContextPipeline: research ? { ambientContextItems: research.ambientContextItems } : EMPTY_AMBIENT_PIPELINE,
    ambientContextPanel: research ?? CLOSED_AMBIENT_PANEL,
    hasActiveScreenShare: call.hasActiveScreenShare,
    isScreenShareFullscreen: call.isScreenShareFullscreen,
    isMeetingHost: call.isMeetingHost,
    agentHelpPhase: "idle",
    isAgentHelpTurnOwner: false,
    isConversationModeActive: false,
    room: call.room,
    agentHelpOwnerParticipantIdentity: null,
    voiceModePendingAction: null,
    isControlsRevealed: call.isControlsRevealed,
    isPresencePanelOpen: call.isPresencePanelOpen,
    isMeetingDetailsPanelOpen: call.isMeetingDetailsPanelOpen,
    isMeetingSettingsPanelOpen: call.isMeetingSettingsPanelOpen,
    isToolApprovalPanelOpen: call.isToolApprovalPanelOpen,
    isLinearActionPanelOpen: call.isLinearActionPanelOpen,
    linearActionPanelState: null,
    session: call.session,
  });
  const joinRequestKey = joinRequestModeration.joinRequests.map((request) => request.id).join("|");
  useEffect(() => {
    call.setJoinRequests(joinRequestModeration.joinRequests);
  }, [call.setJoinRequests, joinRequestKey, joinRequestModeration.joinRequests]);
  useEffect(() => {
    call.setIsJoinRequestsOpen(joinRequestModeration.isJoinRequestsOpen);
  }, [call.setIsJoinRequestsOpen, joinRequestModeration.isJoinRequestsOpen]);
  const invitesApiRef = call.invitesApiRef;
  invitesApiRef.current = { setIsJoinRequestsOpen: joinRequestModeration.setIsJoinRequestsOpen };
  useLayoutEffect(() => {
    return () => {
      invitesApiRef.current = null;
    };
  }, [invitesApiRef]);

  return { collaboration, joinRequestModeration };
}

function LiveMeetingInvitesFeature(props: { call: LiveMeetingFeatureCall }): ReactNode {
  const { call } = props;
  const invites = useLiveMeetingInvitesFeatureModel(call);

  return (
    <>
      {portalNode({
        host: call.hosts.admitGuestsHost,
        node: renderLiveMeetingAdmitGuestsTopRowMenu({
          shouldShowLiveMeetingChrome: call.shouldShowLiveMeetingChrome,
          canModerateJoinRequests: invites.joinRequestModeration.canModerateJoinRequests,
          waitingJoinRequestCount: invites.joinRequestModeration.joinRequests.length,
          menuRef: invites.joinRequestModeration.joinRequestsMenuRef,
          isJoinRequestsOpen: invites.joinRequestModeration.isJoinRequestsOpen,
          setIsJoinRequestsOpen: invites.joinRequestModeration.setIsJoinRequestsOpen,
          setIsPresencePanelOpen: call.setIsPresencePanelOpen,
          setIsToolApprovalPanelOpen: call.setIsToolApprovalPanelOpen,
          setIsAmbientContextPanelOpen: call.setIsAmbientContextPanelOpen,
          setIsMeetingDetailsPanelOpen: call.setIsMeetingDetailsPanelOpen,
          setIsMeetingSettingsPanelOpen: call.setIsMeetingSettingsPanelOpen,
          isJoinRequestsLoading: invites.joinRequestModeration.isJoinRequestsLoading,
          joinRequests: invites.joinRequestModeration.joinRequests,
          joinRequestDecisionId: invites.joinRequestModeration.joinRequestDecisionId,
          onDecideJoinRequest: ({ requestId, decision }) =>
            invites.joinRequestModeration.decideJoinRequest(requestId, decision),
        }),
      })}
      {portalNode({
        host: call.hosts.inviteHost,
        node: renderLiveMeetingInRoomInviteExperienceWhenEligible({
          shouldShowInRoomInviteExperience: invites.collaboration.shouldShowInRoomInviteExperience,
          meeting: call.meeting,
          activeSession: call.activeSession,
          liveRoomJoinUrl: call.liveRoomJoinUrl,
          isInviteExperienceVisible: invites.collaboration.isInviteExperienceVisible,
        }),
      })}
    </>
  );
}

function LiveMeetingTrackerFeature(props: { call: LiveMeetingFeatureCall }): ReactNode {
  const { call } = props;
  const closeOtherPanels = useCallback(() => {
    call.setIsPresencePanelOpen(false);
    call.setIsToolApprovalPanelOpen(false);
    call.setIsLinearActionPanelOpen(false);
    call.setIsMeetingDetailsPanelOpen(false);
    call.setIsMeetingSettingsPanelOpen(false);
    call.invitesApiRef.current?.setIsJoinRequestsOpen(false);
    call.researchApiRef.current?.setIsAmbientContextPanelOpen(false);
    call.captionsApiRef.current?.setIsTranscriptVisible(false);
  }, [call]);
  const meetingTracker = useLiveMeetingInRoomMeetingTracker({
    activeSession: call.activeSession,
    meeting: call.meeting,
    hasJoinedMeeting: call.hasJoinedMeeting,
    realtimeClient: call.realtimeClient,
    refreshRealtimeAuth: call.refreshRealtimeAuth,
    shouldShowLiveMeetingChrome: call.shouldShowLiveMeetingChrome,
    isAvatarRevealed: call.isAvatarRevealed,
    panels: {
      isPresencePanelOpen: call.isPresencePanelOpen,
      isToolApprovalPanelOpen: call.isToolApprovalPanelOpen,
      isLinearActionPanelOpen: call.isLinearActionPanelOpen,
      isMeetingDetailsPanelOpen: call.isMeetingDetailsPanelOpen,
      isMeetingSettingsPanelOpen: call.isMeetingSettingsPanelOpen,
      isJoinRequestsOpen: call.isJoinRequestsOpen,
      isAmbientContextPanelOpen: call.researchApiRef.current?.isAmbientContextPanelOpen ?? false,
    },
    closeOtherPanels,
  });
  const trackerTrigger = meetingTracker.isTriggerVisible ? (
    <MeetingTrackerTrigger isOpen={meetingTracker.isTriggerExpanded} onClick={meetingTracker.toggleTracker} />
  ) : null;

  return (
    <>
      {portalNode({ host: call.hosts.trackerTriggerHost, node: trackerTrigger })}
      {portalNode({
        host: call.hosts.trackerPanelHost,
        node: (
          <MeetingTrackerPanel
            state={meetingTracker.data}
            hasError={meetingTracker.hasError}
            isOpen={meetingTracker.isOpen}
            onClose={meetingTracker.closeTracker}
          />
        ),
      })}
    </>
  );
}

function renderLiveMeetingFeatureTree(call: LiveMeetingFeatureCall): ReactNode {
  return (
    <>
      <LiveFeatureBoundary feature="research">
        <LiveMeetingResearchFeature call={call} />
      </LiveFeatureBoundary>
      <LiveFeatureBoundary feature="assistant">
        <LiveMeetingAgentFeature call={call} />
      </LiveFeatureBoundary>
      <LiveFeatureBoundary feature="captions">
        <LiveMeetingCaptionsFeature call={call} />
      </LiveFeatureBoundary>
      <LiveFeatureBoundary feature="screen-share" onCatch={() => call.setIsScreenShareFeatureFailed(true)}>
        <LiveMeetingScreenShareFeature call={call} />
      </LiveFeatureBoundary>
      <LiveFeatureBoundary feature="dial-in">
        <LiveMeetingDialInFeature call={call} />
      </LiveFeatureBoundary>
      <LiveFeatureBoundary feature="invitations">
        <LiveMeetingInvitesFeature call={call} />
      </LiveFeatureBoundary>
      <LiveFeatureBoundary feature="tracker">
        <LiveMeetingTrackerFeature call={call} />
      </LiveFeatureBoundary>
    </>
  );
}

function renderLiveMeetingInRoomPanels(call: LiveMeetingFeatureCall): ReactNode {
  const meeting = call.meeting;

  return (
    <>
      <div className="live-context-pill-row">
        <div ref={call.hosts.setTrackerTriggerHost} style={{ display: "contents" }} />
        <div ref={call.hosts.setResearchPillHost} style={{ display: "contents" }} />
      </div>
      {renderLiveMeetingTopActionRow({
        isAvatarRevealed: call.isAvatarRevealed,
        admitGuestsMenu: <div ref={call.hosts.setAdmitGuestsHost} style={{ display: "contents" }} />,
        displayName: call.sessionUserDisplayProfile.displayName,
        email: call.sessionUserDisplayProfile.email,
        avatarUrl: call.sessionUserDisplayProfile.avatarUrl,
        participantCount: call.presenceEntries.length,
        onUserAvatarBadgeClick: () =>
          handleLiveMeetingUserAvatarBadgeClick({
            setIsToolApprovalPanelOpen: call.setIsToolApprovalPanelOpen,
            setIsAmbientContextPanelOpen: call.setIsAmbientContextPanelOpen,
            setIsMeetingDetailsPanelOpen: call.setIsMeetingDetailsPanelOpen,
            setIsMeetingSettingsPanelOpen: call.setIsMeetingSettingsPanelOpen,
            setIsPresencePanelOpen: call.setIsPresencePanelOpen,
          }),
      })}
      <PresencePanel
        entries={call.presenceEntries}
        isOpen={call.isPresencePanelOpen}
        onClose={() => call.setIsPresencePanelOpen(false)}
      />
      {call.shouldShowInRoomDetailsSettingsPanels && hasMeetingRecord(meeting) ? (
        <MeetingSettingsPanel
          isOpen={call.isMeetingSettingsPanelOpen}
          audioInputDevices={call.audioInputDevices}
          audioDeviceId={getLiveMeetingMediaDeviceIdOrEmpty(call.audioDeviceId)}
          videoInputDevices={call.videoInputDevices}
          videoDeviceId={getLiveMeetingMediaDeviceIdOrEmpty(call.videoDeviceId)}
          isMicEnabled={call.isMicEnabled}
          isCamEnabled={call.isCamEnabled}
          isBackgroundBlurEnabled={call.isBackgroundBlurEnabled}
          isBackgroundBlurBusy={call.isBackgroundBlurBusy}
          isBackgroundBlurSupported={call.isBackgroundBlurSupported}
          isDisabled={isLiveMeetingSettingsDisabled({ room: call.room, isBusy: call.isBusy })}
          onClose={() => call.setIsMeetingSettingsPanelOpen(false)}
          onSelectAudioDevice={(deviceId) => void call.inRoomMediaControls.selectAudioDevice(deviceId)}
          onSelectVideoDevice={(deviceId) => void call.inRoomMediaControls.selectVideoDevice(deviceId)}
          onToggleBackgroundBlur={() => void call.inRoomMediaControls.toggleBackgroundBlur()}
        />
      ) : null}
      <div ref={call.hosts.setDetailsHost} style={{ display: "contents" }} />
      <div ref={call.hosts.setToolApprovalHost} style={{ display: "contents" }} />
      <div ref={call.hosts.setTrackerPanelHost} style={{ display: "contents" }} />
      <div ref={call.hosts.setAmbientPanelHost} style={{ display: "contents" }} />
      <div ref={call.hosts.setLinearPanelHost} style={{ display: "contents" }} />
      <div ref={call.hosts.setInviteHost} style={{ display: "contents" }} />
    </>
  );
}

function renderLiveMeetingInRoomStage(call: LiveMeetingCallRuntime): ReactNode {
  const meeting = call.meeting;

  return (
    <>
      {renderLiveMeetingVideoStage({
        isRoomRevealed: call.isRoomRevealed,
        tracks: call.tracks,
        shouldShowParticipantGrid: !call.hasActiveScreenShare,
        screenShareStageHostRef: call.hosts.setScreenShareStageHost,
        participantVisuals: call.participantVideoStage.participantVisuals,
        liveVideoGridRef: call.liveVideoGridRef,
        liveVideoGridLayout: call.participantVideoStage.liveVideoGridLayout,
        liveVideoGridStyle: call.participantVideoStage.liveVideoGridStyle,
        renderParticipantVisual: call.participantVideoStage.renderParticipantVisual,
      })}
      {renderLiveMeetingEndMeetingAnalysisOverlay({
        isEndMeetingFlowActive: call.isEndMeetingFlowActive,
        endMeetingFlow: call.endMeetingFlow,
        endMeetingFlowNow: call.endMeetingFlowNow,
        isEndMeetingOverlayExiting: call.isEndMeetingOverlayExiting,
      })}
      {renderLiveMeetingLiveRoomInfo({
        shouldShowLiveRoomInfo: call.shouldShowLiveRoomInfo,
        isControlsRevealed: call.isControlsRevealed,
        liveRoomClock: call.liveRoomClock,
      })}
      {renderLiveMeetingDetailsSettingsTriggerButtonsWhenChrome({
        shouldShowLiveMeetingChrome: call.shouldShowLiveMeetingChrome,
        isControlsRevealed: call.isControlsRevealed,
        isMeetingDetailsPanelOpen: call.isMeetingDetailsPanelOpen,
        isMeetingSettingsPanelOpen: call.isMeetingSettingsPanelOpen,
        setIsPresencePanelOpen: call.setIsPresencePanelOpen,
        setIsToolApprovalPanelOpen: call.setIsToolApprovalPanelOpen,
        setIsAmbientContextPanelOpen: call.setIsAmbientContextPanelOpen,
        setIsMeetingDetailsPanelOpen: call.setIsMeetingDetailsPanelOpen,
        setIsMeetingSettingsPanelOpen: call.setIsMeetingSettingsPanelOpen,
      })}
      {renderLiveMeetingControlsBarWhenVisible({
        meeting,
        hasActiveScreenShare: call.hasActiveScreenShare,
        isScreenShareFullscreen: call.isScreenShareFullscreen,
        isEndMeetingFlowActive: call.isEndMeetingFlowActive,
        controlsBar: {
          isControlsRevealed: call.isControlsRevealed,
          isBusy: call.isBusy,
          room: call.room,
          isMicEnabled: call.isMicEnabled,
          microphonePermissionState: call.microphonePermissionState,
          toggleMic: call.inRoomMediaControls.toggleMic,
          isCamEnabled: call.isCamEnabled,
          cameraPermissionState: call.cameraPermissionState,
          toggleCamera: call.inRoomMediaControls.toggleCamera,
          isGuestSession: call.isGuestSession,
          meeting,
          endMeetingMenuRef: call.endMeetingMenuRef,
          isMeetingOrganizer: call.isMeetingHost,
          isEndMeetingMenuOpen: call.isEndMeetingMenuOpen,
          isEndMeetingFlowActive: call.isEndMeetingFlowActive,
          hasJoinedMeeting: call.hasJoinedMeeting,
          setIsEndMeetingMenuOpen: call.setIsEndMeetingMenuOpen,
          onEndMeetingLeave: () => void call.onEndMeeting("leave"),
          onEndMeetingEndForAll: () => void call.onEndMeeting("end_for_all"),
          agentGlowHostRef: call.hosts.setAgentGlowHost,
          captionsHostRef: call.hosts.setCaptionsHost,
          screenShareHostRef: call.hosts.setScreenShareHost,
          agentHelpHostRef: call.hosts.setAgentHelpHost,
        },
      })}
      <div ref={call.hosts.setTranscriptHost} style={{ display: "contents" }} />
      {renderLiveMeetingInlineError({
        error: call.error,
        isEndMeetingFlowActive: call.isEndMeetingFlowActive,
        endedMeetingNotesPath: getEndedMeetingNotesPath({
          meeting,
          isGuestSession: call.isGuestSession,
          historyVisibility: call.endedMeetingHistoryVisibility,
        }),
      })}
    </>
  );
}

function renderLiveMeetingInRoomView(call: LiveMeetingCallRuntime): ReactNode {
  return (
    <section
      className={getLiveMeetingShellClassName({
        hasActiveScreenShare: call.hasActiveScreenShare,
        isScreenShareFullscreen: call.isScreenShareFullscreen,
        isEndMeetingFlowActive: call.isEndMeetingFlowActive,
      })}
      data-readymeet-meeting-room="true"
    >
      {renderLiveMeetingFeatureTree(call)}
      {renderLiveMeetingInRoomChromeWhenMeetingNotEnding({
        isEndMeetingFlowActive: call.isEndMeetingFlowActive,
        children: renderLiveMeetingInRoomPanels(call),
      })}
      {renderLiveMeetingInRoomStage(call)}
    </section>
  );
}

export function LiveMeetingPage({
  meetingId,
  initialMeeting = null,
  initialMediaTracks = null,
  initialMediaErrors = null,
  initialCameraEnabled: isInitialCameraEnabled = true,
  initialMicEnabled: isInitialMicEnabled = true,
  initialBackgroundBlurEnabled: isInitialBackgroundBlurEnabled,
  initialAudioDeviceId,
  initialVideoDeviceId,
  initialAudioOutputDeviceId,
}: LiveMeetingPageProps): ReactNode {
  const call = useLiveMeetingInRoomRuntime({
    meetingId,
    initialMeeting,
    initialMediaTracks,
    initialMediaErrors,
    initialCameraEnabled: isInitialCameraEnabled,
    initialMicEnabled: isInitialMicEnabled,
    initialBackgroundBlurEnabled: isInitialBackgroundBlurEnabled,
    initialAudioDeviceId,
    initialVideoDeviceId,
    initialAudioOutputDeviceId,
  });

  return renderLiveMeetingInRoomView(call);
}
