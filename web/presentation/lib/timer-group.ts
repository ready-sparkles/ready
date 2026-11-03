type TimerHandle = ReturnType<typeof setTimeout>;

type TimerGroup = {
  setTimeout: (input: { run: () => void; delayMs: number }) => void;
  setInterval: (input: { run: () => void; intervalMs: number }) => void;
  clear: () => void;
};

/**
 * Owns every timer an effect schedules so its cleanup can release all of them
 * with one call, including timers rescheduled from async or recursive callbacks.
 */
export function createTimerGroup(): TimerGroup {
  const timeouts = new Set<TimerHandle>();
  const intervals = new Set<ReturnType<typeof setInterval>>();

  return {
    setTimeout: ({ run, delayMs }) => {
      const handle = setTimeout(() => {
        timeouts.delete(handle);
        run();
      }, delayMs);
      timeouts.add(handle);
    },
    setInterval: ({ run, intervalMs }) => {
      intervals.add(setInterval(run, intervalMs));
    },
    clear: () => {
      timeouts.forEach((handle) => {
        clearTimeout(handle);
      });
      intervals.forEach((handle) => {
        clearInterval(handle);
      });
      timeouts.clear();
      intervals.clear();
    },
  };
}
