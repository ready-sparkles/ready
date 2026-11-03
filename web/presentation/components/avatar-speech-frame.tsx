"use client";

import { type CSSProperties, type ReactNode, useCallback, useRef, useSyncExternalStore } from "react";

import { type ParticipantSpeechSource, SILENT_PARTICIPANT_SPEECH } from "../../domain/participant-speech-store";

import styles from "./live-avatar-tile.module.css";

const SPEECH_LEVEL_CURVE_EXPONENT = 0.62;
const SPEECH_LEVEL_CURVE_MULTIPLIER = 1.65;
const SPEAKING_HALO_SCALE_BASE = 0.9;
const SPEAKING_HALO_SCALE_RANGE = 0.34;
const IDLE_HALO_SCALE = 0.78;
const SPEAKING_HALO_OPACITY_BASE = 0.22;
const SPEAKING_HALO_OPACITY_RANGE = 0.36;
const STYLE_DECIMAL_PLACES = 3;

const silentSnapshot = (): typeof SILENT_PARTICIPANT_SPEECH => SILENT_PARTICIPANT_SPEECH;
const noop = (): void => {};

function getAvatarSpeechLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }

  return Math.min(1, Math.max(0, Math.pow(level, SPEECH_LEVEL_CURVE_EXPONENT) * SPEECH_LEVEL_CURVE_MULTIPLIER));
}

/** Only this frame subscribes to speech; the avatar image and meeting stay still. */
export function AvatarSpeechFrame({
  children,
  speechLevel,
  isSpeaking,
  speechSource,
  isSpeechVisible = true,
}: {
  children: ReactNode;
  speechLevel: number;
  isSpeaking: boolean;
  speechSource?: ParticipantSpeechSource;
  isSpeechVisible?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const subscriptionState = useRef({ isIntersecting: true, unsubscribe: noop });
  const subscribe = useCallback(
    (notify: () => void) => {
      if (speechSource === undefined || !isSpeechVisible) {
        return noop;
      }
      subscriptionState.current = { isIntersecting: true, unsubscribe: noop };
      const sync = () => {
        subscriptionState.current.unsubscribe();
        subscriptionState.current.unsubscribe = noop;
        if (!document.hidden && subscriptionState.current.isIntersecting) {
          subscriptionState.current.unsubscribe = speechSource.subscribe(notify);
          notify(); // Resume at the latest level, including changes while hidden.
        }
      };
      const observer =
        typeof IntersectionObserver === "undefined"
          ? undefined
          : new IntersectionObserver(([entry]) => {
              subscriptionState.current.isIntersecting = entry?.isIntersecting ?? false;
              sync();
            });
      if (frame.current !== null) {
        observer?.observe(frame.current);
      }
      document.addEventListener("visibilitychange", sync);
      sync();

      return () => {
        subscriptionState.current.unsubscribe();
        observer?.disconnect();
        document.removeEventListener("visibilitychange", sync);
      };
    },
    [speechSource, isSpeechVisible],
  );
  const getSnapshot = useCallback(() => {
    const speech = speechSource?.getSnapshot();

    // Below the speaking gate, level changes have no visible effect.
    return speech?.isSpeaking === true ? speech : SILENT_PARTICIPANT_SPEECH;
  }, [speechSource]);
  const speech = useSyncExternalStore(subscribe, getSnapshot, silentSnapshot);
  const isSpeakingNow = speechSource !== undefined ? speech.isSpeaking : isSpeaking;
  const level = getAvatarSpeechLevel(speechSource !== undefined ? speech.level : speechLevel);
  const haloScale = (
    isSpeakingNow ? SPEAKING_HALO_SCALE_BASE + level * SPEAKING_HALO_SCALE_RANGE : IDLE_HALO_SCALE
  ).toFixed(STYLE_DECIMAL_PLACES);
  const haloOpacity = (isSpeakingNow ? SPEAKING_HALO_OPACITY_BASE + level * SPEAKING_HALO_OPACITY_RANGE : 0).toFixed(
    STYLE_DECIMAL_PLACES,
  );
  const haloStyle: CSSProperties = {
    "--avatar-speech-scale": haloScale,
    "--avatar-speech-opacity": haloOpacity,
  };

  return (
    <div ref={frame} className={[styles.speechFrame, isSpeakingNow ? styles.isSpeaking : ""].filter(Boolean).join(" ")}>
      {/* Keep changing CSS variables on the halo, avoiding avatar image repaints. */}
      <span className={styles.speechHalo} aria-hidden="true" style={haloStyle} />
      {children}
    </div>
  );
}
