import { db, type DbConnection, pool } from "./client";

export type CallInDbConnection = DbConnection;

const activeOperations = { count: 0 };
const activeLinks = new Set<string>();

const capacityWaiters = new Set<() => void>();
const CALL_IN_SETUP_WAIT_MINUTES = 6;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const SETUP_WAIT_MS = CALL_IN_SETUP_WAIT_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const MAX_CONCURRENT_CALL_IN_OPERATIONS = 2;
const MIN_POOL_CONNECTIONS = 1;
const CALL_IN_CAPACITY_TIMEOUT_MESSAGE = "Timed out waiting for meeting call-in setup capacity.";

/** Setup waits without holding a database connection; cleanup can defer to its sweep. */
export async function withMeetingLinkCallInLock<T>(input: {
  meetingLinkId: string;
  operation: (connection: CallInDbConnection) => Promise<T>;
  /** @external existing call-in lock API field */
  wait?: boolean;
}): Promise<T | null> {
  const deadline = Date.now() + SETUP_WAIT_MS;
  const shouldWait = input.wait ?? false;

  const attempt = async (): Promise<T | null> => {
    const limit = Math.min(MAX_CONCURRENT_CALL_IN_OPERATIONS, Math.max(MIN_POOL_CONNECTIONS, pool.options.max - 1));
    if (activeLinks.has(input.meetingLinkId) || activeOperations.count >= limit) {
      if (!shouldWait) {
        return null;
      }
      await waitForCapacity({ deadline });

      return attempt();
    }

    activeOperations.count += 1;
    activeLinks.add(input.meetingLinkId);
    try {
      return await input.operation(db);
    } finally {
      activeOperations.count -= 1;
      activeLinks.delete(input.meetingLinkId);
      capacityWaiters.forEach((wake) => {
        wake();
      });
    }
  };

  return attempt();
}

async function waitForCapacity(input: { deadline: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const remaining = input.deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error(CALL_IN_CAPACITY_TIMEOUT_MESSAGE));

      return;
    }
    const timerState: { id?: ReturnType<typeof setTimeout> } = {};
    function wake() {
      if (timerState.id !== undefined) {
        clearTimeout(timerState.id);
      }
      capacityWaiters.delete(wake);
      resolve();
    }
    timerState.id = setTimeout(() => {
      capacityWaiters.delete(wake);
      reject(new Error(CALL_IN_CAPACITY_TIMEOUT_MESSAGE));
    }, remaining);
    capacityWaiters.add(wake);
  });
}
