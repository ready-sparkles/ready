import type { AppLogger } from "../ports/app-logger";
import { repositories } from "../ports/repository-runtime";

type HeartbeatLogger = Pick<AppLogger, "warn">;

const CLAIM_LOST_MESSAGE = "Meeting finalization claim was lost while finalizing";
const RENEW_FAILED_MESSAGE = "Meeting finalization claim renewal failed";

/**
 * Renews a meeting's finalization claim every `intervalMs` while the run is alive, so a run that
 * outlives the lease is not taken over and finalized twice. A crashed process stops renewing and
 * its claim still expires. Returns the function that stops the heartbeat.
 */
export function keepMeetingFinalizationClaimAlive(input: {
  meetingId: string;
  claimId: string;
  intervalMs: number;
  logger: HeartbeatLogger;
}): () => void {
  const state: { isRenewing: boolean; interval: ReturnType<typeof setInterval> | null } = {
    isRenewing: false,
    interval: null,
  };
  const stop = () => {
    if (state.interval !== null) {
      clearInterval(state.interval);
    }
  };
  const renew = async () => {
    state.isRenewing = true;
    try {
      const isHeld = await repositories().renewMeetingFinalization({
        meetingId: input.meetingId,
        claimId: input.claimId,
      });
      if (!isHeld) {
        stop();
        input.logger.warn({ meetingId: input.meetingId }, CLAIM_LOST_MESSAGE);
      }
    } catch (error: unknown) {
      // A transient database error only skips one beat; the lease covers many.
      input.logger.warn({ err: error, meetingId: input.meetingId }, RENEW_FAILED_MESSAGE);
    } finally {
      state.isRenewing = false;
    }
  };
  state.interval = setInterval(() => {
    if (!state.isRenewing) {
      void renew();
    }
  }, input.intervalMs);
  state.interval.unref();

  return stop;
}
