import type { AiWorkflowJobView } from "@readymeet/shared";

import { apiEnv } from "../ports/api-env";
import { repositories } from "../ports/repository-runtime";

import { analyzeMeetingTracker } from "./meeting-tracker-model";
import { executeMeetingResponse, isProviderAccountingError, meetingDecisionFetcher } from "./metered-provider";

const MAX_STALE_RETRIES = 2;
const COLLECTION_WINDOW_MS = 3000;
const STALE_RETRY_EXHAUSTED_MESSAGE = "Live summary changed during every processing attempt";

const LIVE_SUMMARY_PROCESSING_TIMING_MESSAGE = "Live summary processing timing";

type MeetingTrackerLogger = { info: (entry: { fields: Record<string, unknown>; message: string }) => void };
type MeetingTrackerJob = Pick<AiWorkflowJobView, "id" | "meetingId">;

export function meetingTrackerEnabled(): boolean {
  return apiEnv().MEETING_TRACKER_ENABLED && apiEnv().TYPESAFE_API_KEY !== "" && apiEnv().OPENAI_API_KEY !== "";
}
const dependencies = {
  enabled: meetingTrackerEnabled,
  get load() {
    return repositories().loadMeetingTrackerInput;
  },
  analyze: analyzeMeetingTracker,
  get finish() {
    return repositories().finishMeetingTracker;
  },
  get fail() {
    return repositories().failMeetingTracker;
  },
};
export type MeetingTrackerDependencies = typeof dependencies;

type MeetingTrackerRequest = {
  job: MeetingTrackerJob;
  logger: MeetingTrackerLogger;
  deps?: MeetingTrackerDependencies;
};

type PendingTracker = { isRunning: boolean; isDirty: boolean; promise: Promise<void> };
const pendingTrackers = new Map<string, PendingTracker>();

export async function runMeetingTracker(input: MeetingTrackerRequest): Promise<void> {
  const existing = pendingTrackers.get(input.job.meetingId);
  if (existing !== undefined) {
    existing.isDirty ||= existing.isRunning;
    await existing.promise;

    return;
  }
  const pending: PendingTracker = { isRunning: false, isDirty: false, promise: Promise.resolve() };
  pendingTrackers.set(input.job.meetingId, pending);
  pending.promise = collectAndRunTracker(input);
  try {
    await pending.promise;
  } finally {
    if (pendingTrackers.get(input.job.meetingId) === pending) {
      pendingTrackers.delete(input.job.meetingId);
    }
  }
}

function hasPendingSpeech(pending: PendingTracker): boolean {
  return pending.isDirty;
}

async function collectAndRunTracker(input: MeetingTrackerRequest): Promise<void> {
  const pending = pendingTrackers.get(input.job.meetingId);
  if (pending === undefined) {
    return;
  }
  // Fixed window from the first fragment; later speech must not postpone it.
  pending.isRunning = false;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, COLLECTION_WINDOW_MS);
  });
  pending.isDirty = false;
  pending.isRunning = true;
  try {
    await runMeetingTrackerAttempt({ input, retriesRemaining: MAX_STALE_RETRIES });
  } catch (error) {
    if (isProviderAccountingError(error) || !hasPendingSpeech(pending)) {
      throw error;
    }
  }
  if (hasPendingSpeech(pending)) {
    await collectAndRunTracker(input);
  } else {
    pendingTrackers.delete(input.job.meetingId);
  }
}

async function runMeetingTrackerAttempt({
  input,
  retriesRemaining,
}: {
  input: MeetingTrackerRequest;
  retriesRemaining: number;
}): Promise<void> {
  const deps = input.deps ?? dependencies;
  if (!deps.enabled()) {
    return;
  }
  const started = performance.now();
  const timing = { jevMs: 0, openaiMs: 0 };
  const current: { revision?: number; isCommitted?: boolean } = {};
  const log = (outcome: string) =>
    input.logger.info({
      fields: {
        meetingId: input.job.meetingId,
        outcome,
        ...timing,
        processingMs: Math.round(performance.now() - started),
      },
      message: LIVE_SUMMARY_PROCESSING_TIMING_MESSAGE,
    });
  try {
    const { state, processedIds, segments } = await deps.load(input.job.meetingId);
    current.revision = state.revision;
    const processed = new Set(processedIds);
    const newSegmentIds = segments.filter((segment) => !processed.has(segment.id)).map((segment) => segment.id);
    if (newSegmentIds.length === 0) {
      return;
    }
    const items = await deps.analyze({
      input: { transcript: segments, newSegmentIds, items: state.items },
      options: {
        complete: (request) =>
          executeMeetingResponse({
            meetingId: input.job.meetingId,
            source: "meeting_tracker",
            actionType: "meeting_summary",
            request,
          }),
        decide: ({ url, init }) =>
          meetingDecisionFetcher({
            meetingId: input.job.meetingId,
            source: "meeting_tracker",
            actionType: "meeting_summary",
          })(url, init),
        typesafeKey: apiEnv().TYPESAFE_API_KEY,
        openaiKey: apiEnv().OPENAI_API_KEY,
        model: apiEnv().MEETING_TRACKER_MODEL,
        onTiming: ({ stage, ms }) => {
          timing[stage] += ms;
        },
      },
    });
    const isCommitted = await deps.finish({
      meetingId: input.job.meetingId,
      revision: state.revision,
      items,
      processedIds: [...new Set([...processedIds, ...newSegmentIds])],
    });
    current.isCommitted = isCommitted;
    log(isCommitted ? "committed" : "stale");
    if (!isCommitted && retriesRemaining === 0) {
      throw new Error(STALE_RETRY_EXHAUSTED_MESSAGE);
    }
  } catch (error) {
    log("failed");
    if (current.revision !== undefined) {
      await deps.fail({ meetingId: input.job.meetingId, revision: current.revision });
    }
    throw error;
  }
  if (!current.isCommitted) {
    await runMeetingTrackerAttempt({ input, retriesRemaining: retriesRemaining - 1 });
  }
}
