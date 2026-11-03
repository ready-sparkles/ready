/**
 * Hysteresis gate between raw voice-activity detection and the avatar
 * speaking indicator. LiveKit's isSpeaking/active-speaker flags flip
 * instantly on noise (keyboard clacks, breaths, room rumble), and rendering
 * them directly made the speech halo blink — most visibly along the bottom
 * edge of camera-off avatar circles, where the halo's glow bulges out.
 *
 * Only clear speech animates: the raw signal must stay active for `onsetMs`
 * before anything shows, and once visible it survives gaps shorter than
 * `releaseMs` so natural mid-sentence pauses don't blink either.
 */

type SpeechIndicatorConfig = {
  /** Sustained activity required before the indicator appears. */
  onsetMs: number;
  /** Sustained silence required before the indicator disappears. */
  releaseMs: number;
};

const DEFAULT_SPEECH_ONSET_MS = 200;
const DEFAULT_SPEECH_RELEASE_MS = 450;

export const DEFAULT_SPEECH_INDICATOR_CONFIG: SpeechIndicatorConfig = {
  onsetMs: DEFAULT_SPEECH_ONSET_MS,
  releaseMs: DEFAULT_SPEECH_RELEASE_MS,
};

export type SpeechIndicatorState = {
  /** @external Speech indicator visibility consumed by live meeting UI */
  visible: boolean;
  /** When raw activity began while hidden; null when the run broke. */
  candidateSince: number | null;
  /** When raw activity stopped while visible; null while still active. */
  quietSince: number | null;
};

export function createSpeechIndicatorState(): SpeechIndicatorState {
  return { visible: false, candidateSince: null, quietSince: null };
}

export function updateSpeechIndicator(input: {
  state: SpeechIndicatorState;
  /** @external Raw speaking signal from LiveKit participant state */
  rawSpeaking: boolean;
  now: number;
  config?: SpeechIndicatorConfig;
}): SpeechIndicatorState {
  const { state, rawSpeaking: isRawSpeaking, now, config: configOverride } = input;
  const config = configOverride ?? DEFAULT_SPEECH_INDICATOR_CONFIG;
  if (!state.visible) {
    if (!isRawSpeaking) {
      return state.candidateSince === null ? state : { ...state, candidateSince: null };
    }
    const candidateSince = state.candidateSince ?? now;
    if (now - candidateSince >= config.onsetMs) {
      return { visible: true, candidateSince: null, quietSince: null };
    }

    return state.candidateSince === candidateSince ? state : { ...state, candidateSince };
  }

  if (isRawSpeaking) {
    return state.quietSince === null ? state : { ...state, quietSince: null };
  }
  const quietSince = state.quietSince ?? now;
  if (now - quietSince >= config.releaseMs) {
    return { visible: false, candidateSince: null, quietSince: null };
  }

  return state.quietSince === quietSince ? state : { ...state, quietSince };
}
