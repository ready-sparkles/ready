import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BackgroundTransformer, ProcessorWrapper } from "@livekit/track-processors";
import type { Meeting } from "@readymeet/shared";
import { renderHook } from "@testing-library/react";
import { ConnectionState, LocalVideoTrack, ParticipantKind, type Room, RpcError } from "livekit-client";
import assert from "node:assert/strict";
import { registerHooks, type ResolveHookSync } from "node:module";
import test, { after } from "node:test";
import { z } from "zod";

import { ApiError, setApiTransport } from "../../../composition/api";
import { webEnv } from "../../../composition/env";
import type { AuthSession } from "../../../domain/types";
import type { ToastInput } from "../../../presentation/components/toast-provider";
import { createVoiceModeIntent } from "../../../presentation/lib/agent-voice-mode";
import { OPTIONAL_LIVE_REQUEST_TIMEOUT_MS } from "../../../presentation/lib/optional-live-feature-failure";

GlobalRegistrator.register();
after(() => GlobalRegistrator.unregister());

const resolveCss: ResolveHookSync = (specifier, context, nextResolve) =>
  specifier.endsWith(".module.css")
    ? { shortCircuit: true, url: "data:text/javascript,export default {};" }
    : nextResolve(specifier, context);
const css = registerHooks({ resolve: resolveCss });
const {
  runLiveMeetingStartLiveTranscriptionEffect,
  runConversationModeToggle,
  runLiveMeetingLinearActionAllowConfirm,
  runLiveMeetingLinearActionCancelPending,
  runLiveMeetingLinearActionPanelFromVoiceRpc,
  runLiveMeetingConnectCalendarFromApprovalCard,
  runLiveMeetingDisconnectCalendarFromApprovalCard,
  handleLiveMeetingAssistantNoticeTopic,
  renderLiveMeetingTranscriptStrip,
  runLiveMeetingToggleMic,
  runLiveMeetingToggleBackgroundBlur,
  useLiveMeetingInRoomMediaControlsBlurCallbacks,
  runLiveMeetingCalendarOAuthMessageEffect,
} = await import("../../../presentation/components/live-meeting-page");
css.deregister();

const UNAVAILABLE_STATUS = 503;
const INTERNAL_SERVER_ERROR_STATUS = 500;
const INTERNAL_ERROR_MESSAGE = "Internal Server Error";
const LINEAR_BATCH_SIZE = 2;
const FORBIDDEN_STATUS = 403;
const OUTAGE_MESSAGE = "Unavailable";
const FORBIDDEN_MESSAGE = "Forbidden";
const NETWORK_FAILURE_MESSAGE = "Failed to fetch";
const session = z.custom<AuthSession>().parse({ token: "test-token", user: { id: "user" } });
const meeting = z.custom<Meeting>().parse({ id: "meeting" });

function connectedRoom() {
  const probe = { disconnections: 0, isActive: false };
  const room = z.custom<Room>().parse({
    state: ConnectionState.Connected,
    localParticipant: { identity: "user" },
    remoteParticipants: new Map([
      ["agent", { identity: "readymeet-assistant-test", kind: ParticipantKind.AGENT, attributes: {} }],
    ]),
    disconnect: () => {
      probe.disconnections += 1;
    },
  });

  return { room, probe };
}

async function settleEffects(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

void test("transcription outage leaves the connected call intact, quiet, and not loading", async (t) => {
  t.after(() => setApiTransport(null));
  const { room, probe } = connectedRoom();
  const captured: { states: string[]; errors: unknown[] } = { states: [], errors: [] };
  setApiTransport(async () => {
    throw new ApiError({ status: UNAVAILABLE_STATUS, responseText: OUTAGE_MESSAGE });
  });
  const cleanup = runLiveMeetingStartLiveTranscriptionEffect({
    activeSession: session,
    meeting,
    hasJoinedMeeting: true,
    isGuestSession: false,
    connectionState: room.state,
    setTranscriptionState: (state) => {
      captured.states = [...captured.states, String(state)];
    },
    setError: (error) => {
      captured.errors = [...captured.errors, error];
    },
  });
  await settleEffects();
  assert.deepEqual(captured.states, ["starting", "off"]);
  assert.deepEqual(captured.errors, []);
  assert.equal(room.state, ConnectionState.Connected);
  assert.equal(probe.disconnections, 0);
  cleanup?.();
});

void test("transcription permission failures are not silently hidden", async (t) => {
  t.after(() => setApiTransport(null));
  const captured: { errors: unknown[] } = { errors: [] };
  setApiTransport(async () => {
    throw new ApiError({ status: FORBIDDEN_STATUS, responseText: FORBIDDEN_MESSAGE });
  });
  const cleanup = runLiveMeetingStartLiveTranscriptionEffect({
    activeSession: session,
    meeting,
    hasJoinedMeeting: true,
    isGuestSession: false,
    connectionState: ConnectionState.Connected,
    setTranscriptionState: () => {},
    setError: (error) => {
      captured.errors = [...captured.errors, error];
    },
  });
  await settleEffects();
  assert.deepEqual(captured.errors, [FORBIDDEN_MESSAGE]);
  cleanup?.();
});

void test("stalled transcription aborts at its deadline without a participant error", async (t) => {
  t.after(() => setApiTransport(null));
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const probe = { state: "off", errors: 0, isAborted: false };
  setApiTransport(
    ({ options }) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            probe.isAborted = true;
            reject(options.signal?.reason);
          },
          { once: true },
        );
      }),
  );
  const cleanup = runLiveMeetingStartLiveTranscriptionEffect({
    activeSession: session,
    meeting,
    hasJoinedMeeting: true,
    isGuestSession: false,
    connectionState: ConnectionState.Connected,
    setTranscriptionState: (state) => {
      probe.state = String(state);
    },
    setError: () => {
      probe.errors += 1;
    },
  });
  assert.equal(probe.state, "starting");
  assert.deepEqual(timeout.mock.calls[0]?.arguments, [OPTIONAL_LIVE_REQUEST_TIMEOUT_MS]);
  controller.abort(new DOMException(OUTAGE_MESSAGE, "TimeoutError"));
  await settleEffects();
  assert.equal(probe.isAborted, true);
  assert.equal(probe.state, "off");
  assert.equal(probe.errors, 0);
  cleanup?.();
});

void test("transcription cleanup cancels work and ignores a late service rejection", async (t) => {
  t.after(() => setApiTransport(null));
  const deferred: { reject?: (error: Error) => void; signal?: AbortSignal } = {};
  const captured: { states: string[]; errors: unknown[] } = { states: [], errors: [] };
  setApiTransport(
    ({ options }) =>
      new Promise((_resolve, reject) => {
        deferred.reject = reject;
        deferred.signal = options.signal ?? undefined;
      }),
  );
  const cleanup = runLiveMeetingStartLiveTranscriptionEffect({
    activeSession: session,
    meeting,
    hasJoinedMeeting: true,
    isGuestSession: false,
    connectionState: ConnectionState.Connected,
    setTranscriptionState: (state) => {
      captured.states = [...captured.states, String(state)];
    },
    setError: (error) => {
      captured.errors = [...captured.errors, error];
    },
  });
  cleanup?.();
  assert.equal(deferred.signal?.aborted, true);
  deferred.reject?.(new ApiError({ status: UNAVAILABLE_STATUS, responseText: OUTAGE_MESSAGE }));
  await settleEffects();
  assert.deepEqual(captured.states, ["starting"]);
  assert.deepEqual(captured.errors, []);
});

void test("assistant RPC timeout releases its control without disconnecting or showing an error", async () => {
  const { room, probe } = connectedRoom();
  const captured: { errors: unknown[]; pending: unknown[] } = { errors: [], pending: [] };
  await runConversationModeToggle({
    isConversationModeActive: false,
    agentHelpOwnerParticipantIdentity: null,
    agentHelpPhase: "idle",
    voiceModePendingAction: null,
    room,
    voiceModeIntentRef: { current: createVoiceModeIntent() },
    voiceModeRpcPendingRef: { current: false },
    owedVoiceStopRef: { current: null },
    setVoiceModePendingAction: (state) => {
      captured.pending = [...captured.pending, state];
    },
    setIsAgentHelpTooltipDismissed: () => {},
    setError: (error) => {
      if (error !== null) {
        captured.errors = [...captured.errors, error];
      }
    },
    setSyncedConversationModeActive: (isActive) => {
      probe.isActive = isActive;
    },
    setSyncedAgentHelpOwnerParticipantIdentity: () => {},
    setSyncedAgentHelpPhase: () => {},
    performAssistantRpc: async () => {
      throw new RpcError(RpcError.ErrorCode.RESPONSE_TIMEOUT, OUTAGE_MESSAGE);
    },
    applyAssistantPresenceFromRpcResponse: () => false,
    applyAssistantPresencePayload: () => {},
    showAgentHelpCreditsRequiredToast: () => {
      captured.errors = [...captured.errors, "toast"];
    },
  });
  assert.deepEqual(captured.errors, []);
  assert.deepEqual(captured.pending, ["starting", null]);
  assert.equal(probe.isActive, false);
  assert.equal(probe.disconnections, 0);
});

void test("provider action outages close their busy panel without claiming success", async (t) => {
  t.after(() => setApiTransport(null));
  const pending = z
    .custom<NonNullable<Parameters<typeof runLiveMeetingLinearActionAllowConfirm>[0]["linearActionPanelState"]>>()
    .parse({ status: "pending", isBusy: false, pendingInvocationId: "invocation", message: null });
  setApiTransport(async () => {
    throw new ApiError({ status: UNAVAILABLE_STATUS, responseText: OUTAGE_MESSAGE });
  });
  await [runLiveMeetingLinearActionAllowConfirm, runLiveMeetingLinearActionCancelPending].reduce(
    async (previous, action) => {
      await previous;
      const probe = { isClosed: false, toasts: 0 };
      await action({
        session,
        meetingId: meeting.id,
        linearActionPanelState: pending,
        setLinearActionPanelState: () => {},
        showToast: () => {
          probe.toasts += 1;
        },
        closeLinearActionPanel: () => {
          probe.isClosed = true;
        },
      });
      assert.equal(probe.isClosed, true);
      assert.equal(probe.toasts, 0);
    },
    Promise.resolve(),
  );
});

void test("a failed Linear confirm keeps the panel open with the run failure message", async (t) => {
  t.after(() => setApiTransport(null));
  const pending = z
    .custom<NonNullable<Parameters<typeof runLiveMeetingLinearActionAllowConfirm>[0]["linearActionPanelState"]>>()
    .parse({ status: "pending", isBusy: false, pendingInvocationId: "invocation", message: null });
  setApiTransport(async () => {
    throw new ApiError({ status: INTERNAL_SERVER_ERROR_STATUS, responseText: INTERNAL_ERROR_MESSAGE });
  });
  const probe = { isClosed: false, toasts: 0, state: pending };
  await runLiveMeetingLinearActionAllowConfirm({
    session,
    meetingId: meeting.id,
    linearActionPanelState: pending,
    setLinearActionPanelState: (update) => {
      const next = typeof update === "function" ? update(probe.state) : update;
      if (next !== null) {
        probe.state = next;
      }
    },
    showToast: () => {
      probe.toasts += 1;
    },
    closeLinearActionPanel: () => {
      probe.isClosed = true;
    },
  });
  assert.equal(probe.isClosed, false);
  assert.equal(probe.toasts, 0);
  assert.equal(probe.state.isBusy, false);
  assert.equal(probe.state.status, "error");
  assert.equal(probe.state.message, "Could not run the Linear action.");
});

void test("a Linear batch with failed actions keeps the panel and the failure message", async (t) => {
  t.after(() => setApiTransport(null));
  const pending = z
    .custom<NonNullable<Parameters<typeof runLiveMeetingLinearActionAllowConfirm>[0]["linearActionPanelState"]>>()
    .parse({
      status: "pending",
      isBusy: false,
      pendingInvocationId: "invocation",
      message: null,
      successToast: null,
      partialToast: null,
    });
  const captured = { isClosed: false, panelMessage: "", toasts: [] as string[] };
  await runLiveMeetingLinearActionPanelFromVoiceRpc({
    linearActionPanelStateRef: { current: pending },
    setLinearActionPanelState: (update) => {
      const next = typeof update === "function" ? update(pending) : update;
      captured.panelMessage = next?.message ?? captured.panelMessage;
    },
    setIsAmbientContextPanelOpen: () => {},
    setIsLinearActionPanelOpen: () => {},
    showToast: (toast) => {
      captured.toasts = [...captured.toasts, toast.message];
    },
    closeLinearActionPanel: () => {
      captured.isClosed = true;
    },
    payloadText: JSON.stringify({
      type: "linear_action",
      pendingInvocationId: "invocation",
      status: "completed",
      result: { total: LINEAR_BATCH_SIZE, succeeded: 1, failed: 1, failedActions: ["Create issue"] },
    }),
  });
  assert.equal(captured.isClosed, false);
  assert.equal(captured.toasts.length, 1);
  assert.match(captured.panelMessage, /failed/);
  captured.isClosed = false;
  captured.toasts = [];
  await runLiveMeetingLinearActionPanelFromVoiceRpc({
    linearActionPanelStateRef: { current: pending },
    setLinearActionPanelState: (update) => {
      const next = typeof update === "function" ? update(pending) : update;
      captured.panelMessage = next?.status ?? captured.panelMessage;
    },
    setIsAmbientContextPanelOpen: () => {},
    setIsLinearActionPanelOpen: () => {},
    showToast: () => {
      captured.toasts = [...captured.toasts, "unexpected"];
    },
    closeLinearActionPanel: () => {
      captured.isClosed = true;
    },
    payloadText: JSON.stringify({
      type: "linear_action",
      pendingInvocationId: "invocation",
      status: "error",
    }),
  });
  assert.equal(captured.isClosed, false);
  assert.deepEqual(captured.toasts, []);
  assert.equal(captured.panelMessage, "error");
  setApiTransport(async () => ({
    /** @external tool invocation response */
    ok: true,
    invocationId: "00000000-0000-4000-8000-000000000099",
    status: "completed",
    resultSummary: { total: LINEAR_BATCH_SIZE, succeeded: 0, failed: 1, failedActions: ["Create issue"] },
  }));
  captured.isClosed = false;
  captured.panelMessage = "";
  await runLiveMeetingLinearActionAllowConfirm({
    session,
    meetingId: meeting.id,
    linearActionPanelState: pending,
    setLinearActionPanelState: (update) => {
      const next = typeof update === "function" ? update(pending) : update;
      if (next?.message !== null && next?.message !== undefined) {
        captured.panelMessage = next.message;
      }
    },
    showToast: () => {
      captured.toasts = [...captured.toasts, "unexpected"];
    },
    closeLinearActionPanel: () => {
      captured.isClosed = true;
    },
  });
  assert.equal(captured.isClosed, false);
  assert.deepEqual(captured.toasts, []);
  assert.match(captured.panelMessage, /The Linear actions failed/);
});

void test("assistant loss after activation clears voice state only for a trusted, owner-scoped notice", () => {
  const { room, probe } = connectedRoom();
  probe.isActive = true;
  const agent = room.remoteParticipants.get("agent");
  const phases: { values: string[] } = { values: [] };
  const toasts: { titles: string[] } = { titles: [] };
  const input = {
    parsed: { type: "voice_mode_failed", assistantOwnerParticipantIdentity: "user", reason: "model_unavailable" },
    topic: "readymeet.assistant-notice",
    participant: agent,
    localParticipantIdentity: "user",
    showToast: (toast: ToastInput) => {
      toasts.titles = [...toasts.titles, toast.title ?? ""];
    },
    setSyncedConversationModeActive: (isActive: boolean) => {
      probe.isActive = isActive;
    },
    setSyncedAgentHelpPhase: (phase: string) => {
      phases.values = [...phases.values, phase];
    },
  };
  assert.equal(handleLiveMeetingAssistantNoticeTopic({ ...input, participant: undefined }), false);
  assert.equal(handleLiveMeetingAssistantNoticeTopic({ ...input, localParticipantIdentity: "other" }), false);
  assert.equal(probe.isActive, true);
  assert.equal(handleLiveMeetingAssistantNoticeTopic(input), true);
  assert.equal(probe.isActive, false);
  assert.deepEqual(phases.values, ["idle"]);
  assert.deepEqual(toasts.titles, []);
  assert.equal(probe.disconnections, 0);
  assert.equal(
    handleLiveMeetingAssistantNoticeTopic({
      ...input,
      parsed: { type: "voice_mode_failed", assistantOwnerParticipantIdentity: "user", reason: "content_filter" },
    }),
    true,
  );
  assert.deepEqual(toasts.titles, ["Voice chat with Ready stopped"]);
  assert.equal(
    handleLiveMeetingAssistantNoticeTopic({
      ...input,
      parsed: { type: "voice_context_paused", assistantOwnerParticipantIdentity: "user", reason: "context_rejected" },
    }),
    true,
  );
  assert.deepEqual(toasts.titles, ["Voice chat with Ready stopped", "Meeting updates paused"]);
  assert.equal(
    handleLiveMeetingAssistantNoticeTopic({
      ...input,
      parsed: {
        type: "voice_context_paused",
        assistantOwnerParticipantIdentity: "user",
        reason: "context_delivery_timeout",
      },
    }),
    true,
  );
  assert.deepEqual(toasts.titles, ["Voice chat with Ready stopped", "Meeting updates paused"]);
});

void test("denied calendar OAuth consent keeps the card and the normal failure notice", () => {
  const captured = { cards: [calendarCard()], toasts: [] as string[], isOpen: true };
  const cleanup = runLiveMeetingCalendarOAuthMessageEffect({
    meetingId: meeting.id,
    calendarOAuthPopupRef: { current: null },
    setIsToolApprovalPanelOpen: () => {
      captured.isOpen = false;
    },
    setToolApprovalCards: (update) => {
      captured.cards = typeof update === "function" ? update(captured.cards) : update;
    },
    showToast: (toast) => {
      captured.toasts = [...captured.toasts, toast.title ?? ""];
    },
    refreshAgentContextAfterCalendarConnect: async () => {},
  });
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: new URL(webEnv.NEXT_PUBLIC_API_BASE_URL).origin,
      data: { type: "readymeet.calendar.error", provider: "google_calendar" },
    }),
  );
  assert.equal(captured.isOpen, true);
  assert.deepEqual(captured.toasts, ["Calendar connection failed"]);
  const deniedCard = captured.cards[0];
  assert.ok(deniedCard);
  assert.equal(deniedCard.status, "error");
  assert.equal(deniedCard.error, "Calendar authentication failed. Try connecting again.");
  cleanup();
});

function calendarCard() {
  return z.custom<Parameters<typeof runLiveMeetingConnectCalendarFromApprovalCard>[0]["card"]>().parse({
    id: "calendar-card",
    provider: "google_calendar",
    tool: "calendar",
    status: "idle",
    error: null,
  });
}

void test("calendar connection outage closes its popup, clears busy state, and never redirects the meeting", async (t) => {
  t.after(() => setApiTransport(null));
  const card = calendarCard();
  const captured = { cards: [card], toasts: 0, isPopupClosed: false };
  const popup = z.custom<Window>().parse({
    close: () => {
      captured.isPopupClosed = true;
    },
  });
  const popupRef = { current: null as Window | null };
  t.mock.method(window, "open", () => popup);
  setApiTransport(async () => {
    throw new ApiError({ status: UNAVAILABLE_STATUS, responseText: OUTAGE_MESSAGE });
  });
  const currentUrl = window.location.href;
  await runLiveMeetingConnectCalendarFromApprovalCard({
    card,
    session,
    meetingId: meeting.id,
    calendarOAuthPopupRef: popupRef,
    setToolApprovalCards: (update) => {
      captured.cards = typeof update === "function" ? update(captured.cards) : update;
    },
    showToast: () => {
      captured.toasts += 1;
    },
  });
  assert.equal(captured.isPopupClosed, true);
  assert.equal(popupRef.current, null);
  assert.deepEqual(captured.cards, []);
  assert.equal(captured.toasts, 0);
  assert.equal(window.location.href, currentUrl);
});

void test("a blocked calendar popup never navigates the active meeting away", async (t) => {
  t.after(() => setApiTransport(null));
  const card = calendarCard();
  const captured = { cards: [card], toasts: 0, requests: 0 };
  t.mock.method(window, "open", () => null);
  setApiTransport(async () => {
    captured.requests += 1;

    return {};
  });
  const currentUrl = window.location.href;
  await runLiveMeetingConnectCalendarFromApprovalCard({
    card,
    session,
    meetingId: meeting.id,
    calendarOAuthPopupRef: { current: null },
    setToolApprovalCards: (update) => {
      captured.cards = typeof update === "function" ? update(captured.cards) : update;
    },
    showToast: () => {
      captured.toasts += 1;
    },
  });
  assert.equal(captured.requests, 0);
  assert.deepEqual(captured.cards, []);
  assert.equal(captured.toasts, 0);
  assert.equal(window.location.href, currentUrl);
});

void test("microphone controls still work during an optional outage and retain real media errors", async (t) => {
  t.after(() => setApiTransport(null));
  setApiTransport(async () => {
    throw new ApiError({ status: UNAVAILABLE_STATUS, responseText: OUTAGE_MESSAGE });
  });
  const { room, probe } = connectedRoom();
  const media = { isEnabled: false, shouldFail: false, errors: 0 };
  const participant = room.localParticipant;
  participant.getTrackPublication = () => undefined;
  participant.setMicrophoneEnabled = async (isEnabled) => {
    if (media.shouldFail) {
      throw new DOMException(FORBIDDEN_MESSAGE, "NotAllowedError");
    }
    media.isEnabled = isEnabled;

    return undefined;
  };
  const input = {
    room,
    activeSession: null,
    meetingId: meeting.id,
    audioDeviceId: undefined,
    clearMediaControlError: () => {},
    setMediaControlError: () => {
      media.errors += 1;
    },
    setMicrophonePermissionState: () => {},
    setIsMicEnabled: () => {},
  };
  await runLiveMeetingToggleMic(input);
  assert.equal(media.isEnabled, true);
  assert.equal(media.errors, 0);
  media.shouldFail = true;
  await runLiveMeetingToggleMic(input);
  assert.equal(media.errors, 1);
  assert.equal(probe.disconnections, 0);
});

void test("calendar disconnect network loss removes the busy card without success or error messages", async (t) => {
  t.after(() => setApiTransport(null));
  const card = calendarCard();
  const captured = { cards: [card], toasts: 0 };
  setApiTransport(async () => {
    throw new TypeError(NETWORK_FAILURE_MESSAGE);
  });
  await runLiveMeetingDisconnectCalendarFromApprovalCard({
    card,
    session,
    meetingId: meeting.id,
    setToolApprovalCards: (update) => {
      captured.cards = typeof update === "function" ? update(captured.cards) : update;
    },
    showToast: () => {
      captured.toasts += 1;
    },
    performAssistantRpc: async () => "{}",
  });
  assert.deepEqual(captured.cards, []);
  assert.equal(captured.toasts, 0);
});

void test("disabled captions never show a false listening or loading status", () => {
  assert.equal(
    renderLiveMeetingTranscriptStrip({
      shouldShowLiveTranscript: true,
      isEndMeetingFlowActive: false,
      visibleTranscriptLines: [],
      seenTranscriptLineIds: null,
      transcriptionState: "off",
      connectionState: ConnectionState.Connected,
      transcriptBottomRef: { current: null },
    }),
    null,
  );
});

void test("turning blur on with the camera off saves the choice without starting a processor", async (t) => {
  t.mock.getter(BackgroundTransformer, "isSupported", () => true);
  t.mock.getter(ProcessorWrapper, "isSupported", () => true);
  t.after(() => setApiTransport(null));
  const state = { processorCalls: 0, saves: 0, isEnabled: false, isBusy: false, error: null as string | null };
  const camera: unknown = Object.create(
    LocalVideoTrack.prototype,
    Object.getOwnPropertyDescriptors({
      isMuted: true,
      mediaStreamTrack: { readyState: "ended" },
      getProcessor: () => undefined,
      pauseUpstream: async () => {},
      setProcessor: async () => {
        state.processorCalls += 1;
        throw new Error(OUTAGE_MESSAGE);
      },
    }),
  );
  const room = z.custom<Room>().parse({ localParticipant: { getTrackPublication: () => ({ track: camera }) } });
  setApiTransport(async (request) => {
    assert.equal(request.path, "/me/media-preferences");
    assert.equal(
      request.options.body,
      JSON.stringify({
        /** @external API request */
        backgroundBlurEnabled: true,
      }),
    );
    state.saves += 1;

    return {
      preferences: {
        /** @external API response */
        backgroundBlurEnabled: true,
      },
    };
  });
  const view = renderHook(() =>
    useLiveMeetingInRoomMediaControlsBlurCallbacks(
      z.custom<Parameters<typeof useLiveMeetingInRoomMediaControlsBlurCallbacks>[0]>().parse({
        refs: { backgroundBlurProcessorRef: { current: null } },
      }),
    ),
  );
  t.after(() => view.unmount());
  await runLiveMeetingToggleBackgroundBlur({
    room,
    isBackgroundBlurEnabled: false,
    isCamEnabled: false,
    activeSession: session,
    isGuestSession: false,
    setIsBackgroundBlurEnabled: (value) => {
      if (typeof value === "boolean") {
        state.isEnabled = value;
      }
    },
    setIsBackgroundBlurBusy: (value) => {
      if (typeof value === "boolean") {
        state.isBusy = value;
      }
    },
    setError: (value) => {
      if (typeof value !== "function") {
        state.error = value;
      }
    },
    setPublishedCameraBackgroundBlur: view.result.current.setPublishedCameraBackgroundBlur,
  });
  await settleEffects();
  assert.equal(state.error, null);
  assert.equal(state.processorCalls, 0);
  assert.equal(state.saves, 1);
  assert.equal(state.isEnabled, true);
  assert.equal(state.isBusy, false);
});
