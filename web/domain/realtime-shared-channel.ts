type SharedRealtimeChannel = {
  state: string;
  attach: () => Promise<unknown>;
  subscribe: (handler: (message: { data?: unknown }) => void) => unknown;
};

function isDetachRace(channel: SharedRealtimeChannel): boolean {
  return channel.state === "detached" || channel.state === "detaching";
}

/**
 * Ably channel objects are shared by every hook on the client. Another hook's
 * cleanup can detach the channel while this attach is in flight, which rejects
 * with "Unable to attach; state = detached". Re-attach once in that case.
 */
export async function attachSharedChannel(channel: SharedRealtimeChannel): Promise<void> {
  try {
    await channel.attach();
  } catch (error) {
    if (!isDetachRace(channel)) {
      throw error;
    }
    await channel.attach();
  }
}

/** subscribe() implicitly attaches, so it races shared-channel detaches the same way. */
export async function subscribeSharedChannel(input: {
  channel: SharedRealtimeChannel;
  handler: (message: { data?: unknown }) => void;
}): Promise<void> {
  try {
    await Promise.resolve(input.channel.subscribe(input.handler));
  } catch (error) {
    if (!isDetachRace(input.channel)) {
      throw error;
    }
    await attachSharedChannel(input.channel);
  }
}

/** Closed/suspended connections are expected around client teardown and API reloads. */
export function isTransientRealtimeError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "";

  return /connection (closed|suspended|failed)|disconnected|state = (detached|closed|closing|suspended)/i.test(message);
}

const REALTIME_RETRY_BASE_DELAY_MS = 1000;
const REALTIME_RETRY_ATTEMPTS = 4;
const REALTIME_RETRY_BACKOFF_FACTOR = 2;
/** Exponential backoff (1s, 2s, 4s, 8s) for transient realtime attach failures. */
export const REALTIME_RETRY_DELAYS_MS: readonly number[] = Array.from(
  { length: REALTIME_RETRY_ATTEMPTS },
  (_, attempt) => REALTIME_RETRY_BASE_DELAY_MS * REALTIME_RETRY_BACKOFF_FACTOR ** attempt,
);
