"use client";

import { GUEST_RECOGNITION_NOTICE_VERSION, type MeetingTrackerState } from "@readymeet/shared";
import { useEffect, useState } from "react";

import { PERSON, PRIVATE_DETAILS } from "../../../../domain/person-card-example";
import { AmbientContextPanel } from "../../../../presentation/components/ambient-context-panel";
import { ShowcaseMeetingControls } from "../../../../presentation/components/debug-home-meeting-showcase";
import {
  AvatarTile,
  BackgroundBlurIcon,
  CameraIcon,
  MicrophoneIcon,
  UserAvatarBadge,
} from "../../../../presentation/components/live-meeting-visuals";
import { MeetingDeviceDropdown, SpeakerIcon } from "../../../../presentation/components/meeting-device-dropdown";
import { MeetingJoinIdentityPanel } from "../../../../presentation/components/meeting-join-identity-panel";
import { MeetingTrackerPanel } from "../../../../presentation/components/meeting-tracker-panel";

import styles from "../../../../presentation/styles/updates/product-example.module.css";

const SUMMARY_PREVIEW_ID_PREFIX = "00000000-0000-4000-8000-";
const SUMMARY_PREVIEW_ID_WIDTH = 12;
const SUMMARY_PREVIEW_COPY = {
  pilot: "Start with a 20-client pilot.",
  budget: "Keep phase one within $40,000.",
  crmDate: "Can the CRM be ready by November 15?",
  clientSignoff: "Who signs off on the client side?",
  revisedScope: "Sam to send the revised scope by Tuesday.",
  teamCapacity: "Alex to confirm team capacity by Friday.",
} as const;
const SUMMARY_PREVIEW_ITEMS = [
  { section: "agreement", text: SUMMARY_PREVIEW_COPY.pilot },
  { section: "agreement", text: SUMMARY_PREVIEW_COPY.budget },
  { section: "open_item", text: SUMMARY_PREVIEW_COPY.crmDate },
  { section: "open_item", text: SUMMARY_PREVIEW_COPY.clientSignoff },
  { section: "next_step", text: SUMMARY_PREVIEW_COPY.revisedScope },
  { section: "next_step", text: SUMMARY_PREVIEW_COPY.teamCapacity },
] as const satisfies readonly Pick<MeetingTrackerState["items"][number], "section" | "text">[];

const SUMMARY_PREVIEW: MeetingTrackerState = {
  revision: 1,
  updatedAt: null,
  status: "idle",
  items: SUMMARY_PREVIEW_ITEMS.map((item, index) => ({
    ...item,
    id: `${SUMMARY_PREVIEW_ID_PREFIX}${String(index + 1).padStart(SUMMARY_PREVIEW_ID_WIDTH, "0")}`,
    status: "active",
    owner: null,
    due: null,
    evidence: [],
  })),
};

const noop = () => {};
const asyncNoop = async () => {};
const expiredItemIds = new Set<string>();
const VOICE_TICK_MS = 60;
const VOICE_ELAPSED_STEP = 60;
const SPEECH_LEVEL_BASE = 0.26;
const SPEECH_SINE_PERIOD_MS_A = 260;
const SPEECH_SINE_AMPLITUDE_A = 0.1;
const SPEECH_SINE_PERIOD_MS_B = 110;
const SPEECH_SINE_AMPLITUDE_B = 0.06;
const SPEECH_PHASE_RATIO = 0.55;
const SPEECH_PHASE_PERIOD = 90;
const GUEST_PREVIEW_INITIAL = "S";
const GUEST_PREVIEW_DISPLAY_NAME = "Sophie Chen";
const EMPTY_RECOGNITION_ERROR = "";
const exampleDevice = ({ kind, label }: { kind: MediaDeviceKind; label: string }): MediaDeviceInfo => ({
  deviceId: kind,
  groupId: "example",
  kind,
  label,
  toJSON: () => ({}),
});
const microphone = exampleDevice({ kind: "audioinput", label: "MacBook Pro Microphone" });
const speaker = exampleDevice({ kind: "audiooutput", label: "MacBook Pro Speakers" });
const camera = exampleDevice({ kind: "videoinput", label: "FaceTime HD Camera" });

function cssModuleClass(style: string | undefined): string {
  return style ?? "";
}

function VoiceExample() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Match the meeting's waveform cadence, using simulated speech rather than a microphone.
    const timer = window.setInterval(() => {
      if (!reducedMotion.matches && !document.hidden) {
        setElapsed((value) => value + VOICE_ELAPSED_STEP);
      }
    }, VOICE_TICK_MS);

    return () => window.clearInterval(timer);
  }, []);

  const speechLevel =
    SPEECH_LEVEL_BASE +
    Math.sin(elapsed / SPEECH_SINE_PERIOD_MS_A) * SPEECH_SINE_AMPLITUDE_A +
    Math.sin(elapsed / SPEECH_SINE_PERIOD_MS_B) * SPEECH_SINE_AMPLITUDE_B;

  return (
    <main className={`live-shell ${cssModuleClass(styles.voice)}`} inert>
      <ShowcaseMeetingControls
        isSolo
        state={{ agentHelpPhase: "speaking" }}
        speechLevel={speechLevel}
        speechPhase={elapsed * (SPEECH_PHASE_RATIO / SPEECH_PHASE_PERIOD)}
        isSomeoneSpeaking
        isVideoOn
      />
    </main>
  );
}

function PersonMeetingExample({ kind }: { kind: "summary" | "people" | "meeting" }) {
  return (
    <main className={`live-shell ${cssModuleClass(styles.person)}`} inert>
      <div className="live-top-action-row is-revealed">
        <UserAvatarBadge displayName="Alex Kim" avatarUrl="/landing/alex-avatar.jpg" participantCount={2} />
      </div>
      <section className="live-stage is-revealed">
        <div className="live-video-grid is-two-person is-revealed">
          <div className="live-video-grid-item is-remote-participant">
            <div className="live-media-handoff-tile live-video-flip-target" data-participant-visual-id="alex">
              <div className="live-media-avatar-layer" aria-hidden={false}>
                <AvatarTile
                  participantId="alex"
                  displayName="Alex Kim"
                  avatarUrl={null}
                  isSpeaking={false}
                  speechLevel={0}
                  isFlipTarget={false}
                />
              </div>
              <div className="live-media-video-layer" aria-hidden />
            </div>
          </div>
          <div className="live-video-grid-item is-local-participant">
            <div className="live-media-handoff-tile live-video-flip-target" data-participant-visual-id="sam">
              <div className="live-media-avatar-layer" aria-hidden={false}>
                <AvatarTile
                  participantId="sam"
                  displayName="Sam Zetterberg"
                  avatarUrl={null}
                  isSpeaking={false}
                  speechLevel={0}
                  isFlipTarget={false}
                />
              </div>
              <div className="live-media-video-layer" aria-hidden />
            </div>
          </div>
        </div>
      </section>
      <ShowcaseMeetingControls
        isSolo={false}
        state={{ agentHelpPhase: "idle" }}
        speechLevel={0}
        isSomeoneSpeaking={false}
        isVideoOn={false}
      />
      {kind === "summary" ? (
        <MeetingTrackerPanel state={SUMMARY_PREVIEW} hasError={false} isOpen onClose={noop} />
      ) : null}
      {kind === "people" ? (
        <AmbientContextPanel
          factsLayout="standing"
          ambientItems={[{ ...PERSON, privateDetails: PRIVATE_DETAILS }]}
          expiredItemIds={expiredItemIds}
          webSearchItems={[]}
          imageUrls={{ [PERSON.id]: "/landing/people/priya-nair.webp" }}
          isOpen
          selectedItemKey={`ambient:${PERSON.id}`}
          onSelect={noop}
          onRetry={asyncNoop}
          onClose={noop}
        />
      ) : null}
    </main>
  );
}

function GuestJoinExample() {
  return (
    <main className={`meeting-join-shell ${cssModuleClass(styles.guest)}`} inert>
      <section className={`meeting-join-main ${cssModuleClass(styles.join)}`}>
        <div className="meeting-join-preview-area">
          <div className="meeting-join-preview">
            <div className="meeting-join-preview-placeholder">
              <span>{GUEST_PREVIEW_INITIAL}</span>
            </div>
            <div className="meeting-join-preview-controls">
              <button type="button" className="meeting-join-media-button" aria-label="Microphone on">
                <MicrophoneIcon isEnabled />
              </button>
              <button type="button" className="meeting-join-media-button is-off" aria-label="Camera off">
                <CameraIcon isEnabled={false} />
              </button>
            </div>
            <button
              type="button"
              className="meeting-join-media-button meeting-join-background-blur-button"
              aria-label="Turn background blur on"
            >
              <BackgroundBlurIcon isEnabled={false} />
            </button>
          </div>
          <div className="meeting-join-device-row" aria-label="Device selection">
            <MeetingDeviceDropdown
              ariaLabel="Microphone"
              devices={[microphone]}
              fallbackLabel="Microphone"
              icon={<MicrophoneIcon isEnabled />}
              value={microphone.deviceId}
              onChange={noop}
            />
            <MeetingDeviceDropdown
              ariaLabel="Speaker"
              devices={[speaker]}
              fallbackLabel="Speaker"
              icon={<SpeakerIcon />}
              value={speaker.deviceId}
              onChange={noop}
            />
            <MeetingDeviceDropdown
              ariaLabel="Camera"
              devices={[camera]}
              fallbackLabel="Camera"
              icon={<CameraIcon isEnabled />}
              value={camera.deviceId}
              onChange={noop}
            />
          </div>
        </div>
        <aside className="meeting-join-panel">
          <MeetingJoinIdentityPanel
            user={null}
            displayName={GUEST_PREVIEW_DISPLAY_NAME}
            onDisplayNameChange={noop}
            recognition={{
              available: true,
              /** @external guest recognition control wire field */
              recognized: true,
              /** @external guest recognition control wire field */
              checked: true,
              /** @external guest recognition control wire field */
              loaded: true,
              /** @external guest recognition control wire field */
              statusFailed: false,
              /** @external guest recognition control wire field */
              busy: false,
              error: EMPTY_RECOGNITION_ERROR,
              change: asyncNoop,
              choice: {
                /** @external guest recognition choice wire field */
                enabled: true,
                noticeVersion: GUEST_RECOGNITION_NOTICE_VERSION,
                /** @external guest recognition choice wire field */
                explicitOptIn: false,
              },
            }}
            isAskingToJoin={false}
            canAskToJoin
            onAskToJoin={noop}
          />
        </aside>
      </section>
    </main>
  );
}

/** Presentation only: no identity hooks, media capture, meeting join, or cookie writes. */
export function ProductExample({ kind }: { kind: "summary" | "guests" | "people" | "voice" | "meeting" }) {
  if (kind === "voice") {
    return <VoiceExample />;
  }
  if (kind === "summary" || kind === "people" || kind === "meeting") {
    return <PersonMeetingExample kind={kind} />;
  }

  return <GuestJoinExample />;
}
