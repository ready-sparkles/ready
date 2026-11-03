export type ParticipantSpeechState = { level: number; isSpeaking: boolean };
export type ParticipantSpeechStateMap = Record<string, ParticipantSpeechState>;
export type ParticipantSpeechSource = {
  getSnapshot: () => ParticipantSpeechState;
  subscribe: (listener: () => void) => () => void;
};

export const SILENT_PARTICIPANT_SPEECH: ParticipantSpeechState = { level: 0, isSpeaking: false };

type ParticipantSpeechStore = {
  update: (updater: (current: ParticipantSpeechStateMap) => ParticipantSpeechStateMap) => void;
  forParticipant: (identity: string) => ParticipantSpeechSource;
};

/** Speech samples are presentation data, not meeting-page React state. */
export function createParticipantSpeechStore(): ParticipantSpeechStore {
  const stateRef = { states: {} as ParticipantSpeechStateMap };
  const sources = new Map<string, ParticipantSpeechSource>();
  const listeners = new Map<string, Set<() => void>>();

  return {
    update(updater: (current: ParticipantSpeechStateMap) => ParticipantSpeechStateMap) {
      const next = updater(stateRef.states);
      if (next === stateRef.states) {
        return;
      }
      const previous = stateRef.states;
      stateRef.states = { ...next };
      // Keep unchanged snapshots stable so another speaker cannot re-render a tile.
      Object.entries(stateRef.states).forEach(([identity, state]) => {
        const old = previous[identity];
        if (old?.level === state.level && old.isSpeaking === state.isSpeaking) {
          stateRef.states[identity] = old;
        }
      });
      listeners.forEach((callbacks, identity) => {
        if (
          (previous[identity] ?? SILENT_PARTICIPANT_SPEECH) !== (stateRef.states[identity] ?? SILENT_PARTICIPANT_SPEECH)
        ) {
          callbacks.forEach((callback) => {
            callback();
          });
        }
      });
    },
    forParticipant(identity: string): ParticipantSpeechSource {
      const existingSource = sources.get(identity);
      if (existingSource !== undefined) {
        return existingSource;
      }
      const source: ParticipantSpeechSource = {
        getSnapshot: () => stateRef.states[identity] ?? SILENT_PARTICIPANT_SPEECH,
        subscribe(listener) {
          const existingCallbacks = listeners.get(identity);
          const callbacks = existingCallbacks ?? new Set<() => void>();
          if (existingCallbacks === undefined) {
            listeners.set(identity, callbacks);
          }
          callbacks.add(listener);

          return () => {
            callbacks.delete(listener);
            if (callbacks.size === 0) {
              listeners.delete(identity);
            }
          };
        },
      };
      sources.set(identity, source);

      return source;
    },
  };
}
