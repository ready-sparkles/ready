// Ported from Highlight memory; keep motion constants in sync with the reference.
// Animation position is transient; publishing it does not rerender the toolbar,
// search controls, filters, or unrelated cards.
export type MemoryTravelStore = {
  getSnapshot: () => number | null;
  subscribe: (listener: () => void) => () => void;
  set: (next: number | null) => void;
};

export function createMemoryTravelStore(): MemoryTravelStore {
  const state: { position: number | null } = { position: null };
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state.position,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    set(next: number | null) {
      if (next === state.position) {
        return;
      }
      state.position = next;
      listeners.forEach((listener) => {
        listener();
      });
    },
  };
}
