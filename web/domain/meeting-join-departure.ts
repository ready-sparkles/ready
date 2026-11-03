/** Check again immediately before sending, including after an auth refresh. */
export async function runMeetingJoinUnlessDeparting<T>({
  isDeparting,
  join,
}: {
  isDeparting: () => boolean;
  join: () => Promise<T>;
}): Promise<T | undefined> {
  if (isDeparting()) {
    return undefined;
  }

  return join();
}

export const MEETING_JOIN_RECONCILE_WAIT_MS = 3000;

/** Reconcile even when the join response stalls. Keep observing the original
 * request (do not abort it): a later completion gets one more corrective leave.
 * Corrections are serialized, run behind navigation, and must use ordinary
 * leave so the server's live roster protects replacement/other connections.
 */
export async function reconcilePendingMeetingJoin({
  pendingJoin,
  departure,
  leaveIfDisconnected,
  onLateFailure,
}: {
  pendingJoin: Promise<unknown> | null;
  departure: Promise<unknown>;
  leaveIfDisconnected: () => Promise<unknown>;
  onLateFailure: (error: unknown) => void;
}): Promise<void> {
  if (pendingJoin === null) {
    return;
  }
  const joinState = { isSettled: false };
  const trackSettledJoin = async (): Promise<void> => {
    try {
      await pendingJoin;
    } catch (error) {
      void error;
    }
    joinState.isSettled = true;
  };
  const settledJoinPromise = trackSettledJoin();
  const timerState: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
  const deadline = new Promise<void>((resolve) => {
    timerState.id = setTimeout(resolve, MEETING_JOIN_RECONCILE_WAIT_MS);
  });
  const boundedJoin = Promise.race([settledJoinPromise, deadline]).finally(() => {
    if (timerState.id !== undefined) {
      clearTimeout(timerState.id);
    }
  });
  await Promise.allSettled([boundedJoin, departure]);

  // Capture this before sending: join may finish while correction is in flight.
  const shouldApplyLateCorrection = !joinState.isSettled;
  try {
    await leaveIfDisconnected();
  } finally {
    if (shouldApplyLateCorrection) {
      void (async () => {
        try {
          await settledJoinPromise;
          await leaveIfDisconnected();
        } catch (error) {
          onLateFailure(error);
        }
      })();
    }
  }
}
