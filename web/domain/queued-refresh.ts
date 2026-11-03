/** Coalesce a burst into one follow-up read without losing invalidations in flight. */
export function createQueuedRefresh(run: () => Promise<void>): () => Promise<void> {
  const failureState: { value: unknown } = { value: undefined };
  const queueState = {
    running: null as Promise<void> | null,
    isRequested: false,
  };

  const drainQueue = async (): Promise<void> => {
    if (!queueState.isRequested) {
      return;
    }
    queueState.isRequested = false;
    try {
      await run();
    } catch (error) {
      failureState.value = error;
    }
    await drainQueue();
  };

  return (): Promise<void> => {
    queueState.isRequested = true;
    queueState.running ??= (async (): Promise<void> => {
      try {
        failureState.value = undefined;
        await drainQueue();
        if (failureState.value !== undefined) {
          throw failureState.value instanceof Error
            ? failureState.value
            : new Error(undefined, { cause: failureState.value });
        }
      } finally {
        queueState.running = null;
      }
    })();

    return queueState.running;
  };
}
