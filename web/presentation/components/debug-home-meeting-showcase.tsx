"use client";

// Presentation-only replay: the real meeting styles in an isolated desktop
// viewport, scaled as a whole. No camera, auth, or meeting connections are made.
import type { MeetingTrackerItem, MeetingTrackerState } from "@readymeet/shared";
import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { copyShowcaseStyles } from "../../domain/showcase-styles";
import { useParticipantTileTransition } from "../hooks/use-participant-tile-transition";
import { createTimerGroup } from "../lib/timer-group";

import { AgentVoiceGlow } from "./agent-voice-glow";
import { AmbientContextPanel } from "./ambient-context-panel";
import { AmbientContextPill } from "./ambient-context-pill";
import {
  AvatarTile,
  CameraIcon,
  CaptionsWaveIcon,
  InfoIcon,
  MicrophoneIcon,
  PhoneDownIcon,
  ScreenShareIcon,
  SettingsGearIcon,
  UserAvatarBadge,
} from "./live-meeting-visuals";
import { MeetingTrackerPanel } from "./meeting-tracker-panel";
import { MeetingTrackerTrigger } from "./meeting-tracker-trigger";
import { PUBLIC_HOME_CANDIDATE_DEMO } from "./public-home-candidate-demo";
import { VoiceModeControlIcon } from "./voice-mode-control-icon";

const SHOWCASE_VIEWPORT_WIDTH_PX = 1440;
const SHOWCASE_VIEWPORT_HEIGHT_PX = 800;
const VIEWPORT = { width: SHOWCASE_VIEWPORT_WIDTH_PX, height: SHOWCASE_VIEWPORT_HEIGHT_PX };
const TIMELINE_DELAY_GROUP_JOIN_MS = 3500;
const TIMELINE_DELAY_PARTICIPANT_SPEAKING_MS = 4700;
const TIMELINE_DELAY_SUMMARY_READY_MS = 7000;
const TIMELINE_DELAY_COMPLETED_MS = 9500;
const TIMELINE_DELAY_SUMMARY_SPEAKING_MS = 11200;
const TIMELINE_DELAY_SUMMARY_PAUSE_MS = 14600;
const TIMELINE_DELAY_PERSON_PILL_MS = 18000;
const TIMELINE_DELAY_PERSON_PRESSING_MS = 21000;
const TIMELINE_DELAY_PERSON_RELEASED_MS = 21200;
const TIMELINE_DELAY_PERSON_OPEN_MS = 21800;
const TIMELINE_DELAY_PERSON_PAUSE_MS = 26200;
const TIMELINE_DELAY_PERSON_SPEAKING_MS = 28000;
const TIMELINE_DELAY_RESET_MS = 30500;
const SHOWCASE_VIDEO_RESTART_DELAY_MS = 5000;
const SHOWCASE_SPEECH_LEVEL_BASE = 0.38;
const SHOWCASE_SPEECH_LEVEL_SINE_FREQUENCY = 0.8;
const SHOWCASE_SPEECH_LEVEL_SINE_AMPLITUDE = 0.17;
const SHOWCASE_GROUP_PARTICIPANT_COUNT = 2;
const SHOWCASE_PLAYBACK_LOOP_MS = 33500;
const SHOWCASE_SPEECH_TICK_INTERVAL_MS = 130;
const SHOWCASE_ROOM_INFO_TIME_LABEL = "10:42 AM";

const PARTICIPANTS = [
  { id: "personaa", displayName: "Jordan Lee", avatarUrl: "/landing/personaa-avatar.jpg" },
  { id: "personbr", displayName: "Alex Morgan", avatarUrl: "/landing/sam.png?v=2503e951" },
];
type ShowcaseState = {
  /** @external debug showcase timeline state */
  participantJoined: boolean;
  speakingId: string | null;
  agentHelpPhase: "idle" | "thinking" | "speaking";
  summaryPhase: "hidden" | "ready";
  /** @external debug showcase timeline state */
  panelOpen: boolean;
  personPhase: "hidden" | "pill" | "pressing" | "open";
};
const INITIAL_STATE: ShowcaseState = {
  /** @external debug showcase timeline state */
  participantJoined: false,
  speakingId: null,
  agentHelpPhase: "speaking",
  summaryPhase: "hidden",
  /** @external debug showcase timeline state */
  panelOpen: false,
  personPhase: "hidden",
};
const GROUP_STATE: ShowcaseState = {
  ...INITIAL_STATE,
  /** @external debug showcase timeline state */
  participantJoined: true,
  agentHelpPhase: "idle",
};
const COMPLETED_STATE: ShowcaseState = {
  ...GROUP_STATE,
  summaryPhase: "ready",
  /** @external debug showcase timeline state */
  panelOpen: true,
};
const SUMMARY_DEMO_ENTRIES: [MeetingTrackerItem["section"], string, string?, string?][] = [
  ["agreement", "Require MFA for all admin accounts."],
  ["agreement", "Review access to customer data every quarter."],
  ["open_item", "How long should we retain audit logs?"],
  ["open_item", "Who approves temporary access to production data?"],
  ["next_step", "Document the backup encryption process.", "Alex Morgan", "Tuesday"],
  ["next_step", "Audit service account permissions.", "Jordan Lee", "Friday"],
];
const SUMMARY_DEMO: MeetingTrackerState = {
  revision: 1,
  updatedAt: null,
  status: "idle",
  items: SUMMARY_DEMO_ENTRIES.map(([section, text, owner, due], index) => ({
    id: `demo-summary-${index}`,
    section,
    text,
    status: "active",
    owner: owner ?? null,
    due: due ?? null,
    evidence: [],
  })),
};
const PERSON_ITEM = {
  ...PUBLIC_HOME_CANDIDATE_DEMO.ready,
  displayName: "Maya Bennett",
  summary: null,
  facts: [],
  citations: [],
  privateDetails: {
    memory: {
      personId: PUBLIC_HOME_CANDIDATE_DEMO.ready.id,
      name: "Maya Bennett",
      summary: [
        "You and Maya Bennett are reviewing how Meridian protects customer data, starting with admin access and backups.",
        "In your last conversation, she asked for a list of security gaps before the next risk review.",
      ],
      standing: [
        "Maya asked you to identify admin accounts without MFA and service accounts with unnecessary permissions.",
        "You agreed to document backup encryption and recovery procedures. Audit log retention is still an open question.",
        "Maya offered to introduce you to her security lead to define who can approve temporary access to production data. The introduction is still pending.",
      ],
      lastContact: null,
    },
    ashby: null,
  },
};
const PERSON_ITEMS = [PERSON_ITEM];
const NO_PERSON_ITEMS: typeof PERSON_ITEMS = [];
const PERSON_IMAGE_URLS = { [PUBLIC_HOME_CANDIDATE_DEMO.ready.id]: "/landing/people/personby.webp" };
const EMPTY_EXPIRED_IDS = new Set<string>();
const ignoreDemoAction = () => {};
const TIMELINE: [number, ShowcaseState][] = [
  [TIMELINE_DELAY_GROUP_JOIN_MS, GROUP_STATE],
  [TIMELINE_DELAY_PARTICIPANT_SPEAKING_MS, { ...GROUP_STATE, speakingId: "personbr" }],
  [TIMELINE_DELAY_SUMMARY_READY_MS, { ...GROUP_STATE, speakingId: "personbr", summaryPhase: "ready" }],
  [TIMELINE_DELAY_COMPLETED_MS, COMPLETED_STATE],
  [TIMELINE_DELAY_SUMMARY_SPEAKING_MS, { ...COMPLETED_STATE, speakingId: "personbr" }],
  [TIMELINE_DELAY_SUMMARY_PAUSE_MS, COMPLETED_STATE],
  [TIMELINE_DELAY_PERSON_PILL_MS, { ...COMPLETED_STATE, speakingId: "personbr", personPhase: "pill" }],
  [TIMELINE_DELAY_PERSON_PRESSING_MS, { ...COMPLETED_STATE, personPhase: "pressing" }],
  [TIMELINE_DELAY_PERSON_RELEASED_MS, { ...COMPLETED_STATE, panelOpen: false, personPhase: "pill" }],
  [
    TIMELINE_DELAY_PERSON_OPEN_MS,
    { ...COMPLETED_STATE, speakingId: "personbr", panelOpen: false, personPhase: "open" },
  ],
  [TIMELINE_DELAY_PERSON_PAUSE_MS, { ...COMPLETED_STATE, panelOpen: false, personPhase: "open" }],
  [
    TIMELINE_DELAY_PERSON_SPEAKING_MS,
    { ...COMPLETED_STATE, speakingId: "personbr", panelOpen: false, personPhase: "open" },
  ],
  [TIMELINE_DELAY_RESET_MS, INITIAL_STATE],
];

function computeShowcaseSpeechLevel({ tick, isSomeoneSpeaking }: { tick: number; isSomeoneSpeaking: boolean }) {
  if (!isSomeoneSpeaking) {
    return 0;
  }

  return (
    SHOWCASE_SPEECH_LEVEL_BASE +
    Math.sin(tick * SHOWCASE_SPEECH_LEVEL_SINE_FREQUENCY) * SHOWCASE_SPEECH_LEVEL_SINE_AMPLITUDE
  );
}

function useShowcaseVideoLoop({
  isParticipantJoined,
  isVideoOn,
  setIsVideoOn,
  videoRef,
}: {
  isParticipantJoined: boolean;
  isVideoOn: boolean;
  setIsVideoOn: (next: boolean) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  useEffect(() => {
    if (!isParticipantJoined) {
      setIsVideoOn(true);

      return;
    }
    if (isVideoOn) {
      return;
    }
    const timer = setTimeout(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      video.currentTime = 0;
      void (async () => {
        try {
          await video.play();
          setIsVideoOn(true);
        } catch (error) {
          if (!(error instanceof Error) && typeof error !== "string") {
            throw error;
          }
        }
      })();
    }, SHOWCASE_VIDEO_RESTART_DELAY_MS);

    return () => clearTimeout(timer);
  }, [isVideoOn, isParticipantJoined, setIsVideoOn, videoRef]);
}

function ShowcaseParticipantGrid({
  state,
  gridRef,
  videoRef,
  isVideoOn,
  speechLevel,
  onVideoEnded,
}: {
  state: ShowcaseState;
  gridRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  isVideoOn: boolean;
  speechLevel: number;
  onVideoEnded: () => void;
}) {
  return (
    <div
      ref={gridRef}
      className={`live-video-grid is-revealed${state.participantJoined ? " is-two-person" : ""}`}
      style={{ gridTemplateRows: "1fr" }}
    >
      {PARTICIPANTS.filter((participant) => state.participantJoined || participant.id === "personbr").map(
        (participant) => (
          <div
            key={participant.id}
            className={`live-video-grid-item ${participant.id === "personbr" ? "is-local-participant" : "is-remote-participant"}`}
          >
            <div
              data-participant-visual-id={participant.id}
              className={`live-media-handoff-tile live-video-flip-target${participant.id === "personaa" ? " is-video-sized" : ""}${participant.id === "personaa" && isVideoOn ? " is-video-on" : ""}`}
            >
              {participant.id === "personaa" ? (
                <div className="live-media-video-layer" aria-hidden={!isVideoOn}>
                  <article
                    className="video-tile live-video-tile live-grid-video-tile"
                    aria-label={participant.displayName}
                  >
                    <video
                      ref={videoRef}
                      className="is-ready"
                      src="/landing/meeting-participant.mp4"
                      poster="/landing/meeting-participant.jpg"
                      autoPlay
                      muted
                      playsInline
                      onEnded={onVideoEnded}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  </article>
                </div>
              ) : null}
              <div className="live-media-avatar-layer" aria-hidden={participant.id === "personaa" ? isVideoOn : false}>
                <AvatarTile
                  participantId={participant.id}
                  displayName={participant.displayName}
                  avatarUrl={participant.avatarUrl}
                  isFlipTarget={false}
                  isSpeaking={state.speakingId === participant.id}
                  speechLevel={state.speakingId === participant.id ? speechLevel : 0}
                />
              </div>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function ShowcaseLiveRoom({ state, tick }: { state: ShowcaseState; tick: number }) {
  const [isVideoOn, setIsVideoOn] = useState(true);
  const gridRef = useRef<HTMLDivElement | null>(null);
  useParticipantTileTransition(gridRef, state.participantJoined ? "personaa|personbr" : "personbr", true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useShowcaseVideoLoop({
    isParticipantJoined: state.participantJoined,
    isVideoOn,
    setIsVideoOn,
    videoRef,
  });
  const isSomeoneSpeaking = state.speakingId !== null || state.agentHelpPhase === "speaking";
  const speechLevel = computeShowcaseSpeechLevel({ tick, isSomeoneSpeaking });

  return (
    <section className="live-shell home-meeting-showcase" inert>
      <div className="live-context-pill-row">
        {state.summaryPhase !== "hidden" ? (
          <MeetingTrackerTrigger isOpen={state.panelOpen} onClick={ignoreDemoAction} />
        ) : null}
        <AmbientContextPill
          items={state.personPhase === "hidden" ? NO_PERSON_ITEMS : PERSON_ITEMS}
          webSearchState={null}
          imageUrls={PERSON_IMAGE_URLS}
          isVisible={state.personPhase !== "hidden"}
          isOpen={state.personPhase === "open"}
          onClick={ignoreDemoAction}
        />
      </div>
      <div className="live-top-action-row is-revealed">
        <UserAvatarBadge
          displayName={state.participantJoined ? "Jordan Lee" : "Alex Morgan"}
          avatarUrl="/landing/sam.png?v=2503e951"
          participantCount={state.participantJoined ? SHOWCASE_GROUP_PARTICIPANT_COUNT : 1}
        />
      </div>
      <section className="live-stage is-revealed">
        <ShowcaseParticipantGrid
          state={state}
          gridRef={gridRef}
          videoRef={videoRef}
          isVideoOn={isVideoOn}
          speechLevel={speechLevel}
          onVideoEnded={() => setIsVideoOn(false)}
        />
      </section>
      <div className="live-room-info is-revealed">
        <span className="live-room-info-time">{SHOWCASE_ROOM_INFO_TIME_LABEL}</span>
      </div>
      <button type="button" className="live-details-trigger is-revealed" aria-label="Meeting details">
        <InfoIcon />
      </button>
      <button type="button" className="live-settings-trigger is-revealed" aria-label="Settings">
        <SettingsGearIcon />
      </button>
      <MeetingTrackerPanel state={SUMMARY_DEMO} hasError={false} isOpen={state.panelOpen} onClose={ignoreDemoAction} />
      <AmbientContextPanel
        ambientItems={PERSON_ITEMS}
        expiredItemIds={EMPTY_EXPIRED_IDS}
        revealContent
        factsLayout="standing"
        webSearchItems={[]}
        imageUrls={PERSON_IMAGE_URLS}
        isOpen={state.personPhase === "open"}
        selectedItemKey={`ambient:${PERSON_ITEM.id}`}
        onSelect={ignoreDemoAction}
        onRetry={async () => {}}
        onClose={ignoreDemoAction}
      />
      <ShowcaseMeetingControls
        isSolo={!state.participantJoined}
        state={state}
        speechLevel={speechLevel}
        speechPhase={tick * SHOWCASE_SPEECH_LEVEL_SINE_FREQUENCY}
        isSomeoneSpeaking={isSomeoneSpeaking}
        isVideoOn={isVideoOn}
      />
    </section>
  );
}

/** Presentation-only controls shared by public product examples. */
export function ShowcaseMeetingControls({
  isSolo,
  state,
  speechLevel,
  speechPhase = 0,
  isSomeoneSpeaking,
  isVideoOn,
}: {
  isSolo: boolean;
  state: Pick<ShowcaseState, "agentHelpPhase">;
  speechLevel: number;
  speechPhase?: number;
  isSomeoneSpeaking: boolean;
  isVideoOn: boolean;
}) {
  return (
    <footer className="live-controls-bar is-revealed">
      <AgentVoiceGlow
        active={isSolo ? state.agentHelpPhase !== "idle" : false}
        speaking={isSolo ? state.agentHelpPhase === "speaking" : false}
        level={speechLevel}
      />
      <button type="button" className="outline-button" aria-label="Show transcript" title="Show transcript">
        <CaptionsWaveIcon
          isEnabled
          isActive={isSomeoneSpeaking}
          isError={false}
          level={speechLevel}
          phase={speechPhase}
        />
      </button>
      <button type="button" className="outline-button" aria-label="Share screen" title="Share screen or tab">
        <ScreenShareIcon />
      </button>
      <button type="button" className="outline-button" aria-label="Mute microphone" title="Mute microphone">
        <MicrophoneIcon isEnabled />
      </button>
      <span
        className={`live-agent-help-control live-solo-voice-control${isSolo ? "" : " is-hidden"}`}
        aria-hidden={!isSolo}
        inert={!isSolo}
      >
        <button
          type="button"
          disabled={!isSolo}
          className="outline-button live-voice-mode-button"
          aria-pressed={isSolo ? state.agentHelpPhase !== "idle" : false}
          data-voice-mode-state={!isSolo || state.agentHelpPhase === "idle" ? "inactive" : "active"}
          aria-label={
            !isSolo || state.agentHelpPhase === "idle" ? "Voice chat with Ready" : "End voice chat with Ready"
          }
          title={!isSolo || state.agentHelpPhase === "idle" ? "Voice chat with Ready" : "End voice chat with Ready"}
        >
          <VoiceModeControlIcon active={state.agentHelpPhase !== "idle"} visible={isSolo} />
        </button>
      </span>
      <button
        type="button"
        className="outline-button"
        aria-label={isVideoOn ? "Turn camera off" : "Turn camera on"}
        title={isVideoOn ? "Turn camera off" : "Turn camera on"}
      >
        <CameraIcon isEnabled={isVideoOn} />
      </button>
      <div className="live-end-meeting-menu">
        <button type="button" className="danger-button" aria-label="Meeting end options" title="Meeting end options">
          <PhoneDownIcon />
        </button>
      </div>
    </footer>
  );
}

// An iframe makes viewport units, fixed controls, and product media queries
// match the real desktop meeting instead of the surrounding marketing page.
function useEmulatedViewport() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const iframeDocument = iframeRef.current?.contentDocument;
    if (!iframeDocument) {
      return;
    }

    const lifecycle = { isDisposed: false, cancelCopy: () => {} };
    const copyStyles = () => {
      lifecycle.cancelCopy();
      lifecycle.cancelCopy = copyShowcaseStyles({
        source: document,
        target: iframeDocument,
        onReady: () => {
          if (!lifecycle.isDisposed) {
            setMountNode(iframeDocument.body);
          }
        },
      });
    };

    // The iframe document is about:blank; give relative URLs (images, fonts,
    // stylesheet hrefs) the page's base to resolve against.
    const baseElement = iframeDocument.createElement("base");
    baseElement.href = document.baseURI;
    iframeDocument.head.appendChild(baseElement);

    // Font variables live on the page's <html> class list (next/font).
    iframeDocument.documentElement.className = document.documentElement.className;
    iframeDocument.body.style.overflow = "hidden";
    iframeDocument.body.style.background = "#0a0a0c";
    copyStyles();
    const observer = new MutationObserver(copyStyles);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });

    return () => {
      lifecycle.isDisposed = true;
      lifecycle.cancelCopy();
      observer.disconnect();
      baseElement.remove();
    };
  }, []);

  return { iframeRef, mountNode };
}

export function DebugHomeMeetingShowcase() {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { iframeRef, mountNode } = useEmulatedViewport();
  const [scale, setScale] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [isReducedMotion, setIsReducedMotion] = useState<boolean | null>(null);
  const [state, setState] = useState<ShowcaseState>(INITIAL_STATE);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    const measure = () => setScale(frame.clientWidth / VIEWPORT.width);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(frame);
    const visibility = new IntersectionObserver(([entry]) => setIsVisible(entry?.isIntersecting ?? false));
    visibility.observe(frame);

    return () => {
      resize.disconnect();
      visibility.disconnect();
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setIsReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (isReducedMotion === null) {
      return;
    }
    setState(isReducedMotion ? COMPLETED_STATE : INITIAL_STATE);
    if (!mountNode || !isVisible || isReducedMotion) {
      return;
    }
    const timers = createTimerGroup();
    const play = () => {
      TIMELINE.forEach(([delay, next]) => {
        timers.setTimeout({ run: () => setState(next), delayMs: delay });
      });
      timers.setTimeout({ run: play, delayMs: SHOWCASE_PLAYBACK_LOOP_MS });
    };
    play();

    return () => {
      timers.clear();
    };
  }, [mountNode, isVisible, isReducedMotion]);

  const isSpeaking = state.speakingId !== null || state.agentHelpPhase === "speaking";
  useEffect(() => {
    if (!isVisible || isReducedMotion !== false || !isSpeaking) {
      return;
    }
    const interval = setInterval(() => setTick((current) => current + 1), SHOWCASE_SPEECH_TICK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isVisible, isReducedMotion, isSpeaking]);

  return (
    <div
      ref={frameRef}
      className="public-home-showcase"
      role="img"
      aria-label="Ready meeting demo: Alex Morgan starts alone with the voice agent speaking. Jordan Lee joins on video, voice chat with Ready turns off, and a live Summary shows decisions, open questions, and tasks from a fictional data security call. A person pill then opens Maya Bennett’s context from a previous conversation. Summary and person content are illustrative."
    >
      <iframe
        ref={iframeRef}
        className="public-home-showcase-viewport"
        title="Ready meeting preview"
        aria-hidden="true"
        tabIndex={-1}
        style={{
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          transform: `scale(${scale})`,
          visibility: mountNode && scale > 0 ? "visible" : "hidden",
        }}
      />
      {mountNode ? createPortal(<ShowcaseLiveRoom state={state} tick={tick} />, mountNode) : null}
    </div>
  );
}
