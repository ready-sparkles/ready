import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  type CapabilityCatalogRow,
  type CapabilityRecommendationRow,
  type CapabilityRecommendationView,
  capabilitySelectionResponseSchema,
  type CapabilitySelectionResult,
  FALLBACK_SUMMARY_MODEL,
  meetingExtractionResponseSchema,
  type SuggestedActionRunPhase,
  type SuggestedActionRunResponse,
  type SuggestedActionRunStatus,
  type SuggestedActionStep,
  type SuggestedActionStepStatus,
} from "@readymeet/shared";

import {
  triggerCapabilitySelection,
  triggerMeetingExtraction,
  triggerMeetingSignalExtraction,
} from "../ports/gate-assistant-client";
import { repositories } from "../ports/repository-runtime";

import {
  ensureAlwaysAvailableCapabilityRecommendationsForMeeting,
  filterVisibleCapabilityRecommendations,
} from "./always-available-capabilities";
import { generateAndPersistMeetingTasks, isMeetingTaskListCurrent } from "./task-artifacts";

type LoggerLike = {
  info?(input: { bindings: Record<string, unknown>; message: string }): void;
  warn(input: { bindings: Record<string, unknown>; message: string }): void;
};

type PositionalLoggerLike = {
  info?: (...args: [bindings: Record<string, unknown>, message: string]) => void;
  warn: (...args: [bindings: Record<string, unknown>, message: string]) => void;
};

function loggerFromPositional(logger: PositionalLoggerLike): LoggerLike {
  return {
    info: logger.info
      ? (input) => {
          logger.info?.(input.bindings, input.message);
        }
      : undefined,
    warn: (input) => {
      logger.warn(input.bindings, input.message);
    },
  };
}

type SuggestedActionRunRow = Awaited<ReturnType<RepositoryPort["getSuggestedActionRunByMeetingId"]>>;

const IDLE_TIMEOUT_MS = 90_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES = new Set<SuggestedActionRunStatus>([
  "completed",
  "no_work_found",
  "skipped",
  "failed",
  "cancelled",
]);
const NO_WORK_SUMMARY_MODELS = new Set(["short-meeting-v1", FALLBACK_SUMMARY_MODEL]);

const SUGGESTED_ACTIONS_MESSAGES: {
  noWork: string;
  couldNotFinish: string;
  staleError: string;
  meetingNotFound: string;
  preparingTasks: string;
  pipelineFailed: string;
} = {
  noWork: "No follow-ups found for this meeting.",
  couldNotFinish: "Could not finish thinking. Try again.",
  staleError: "Suggested action run became stale",
  meetingNotFound: "Meeting not found",
  preparingTasks: "Preparing Tasks before matching capabilities.",
  pipelineFailed: "Suggested action run failed",
};

const SUGGESTED_ACTIONS_LOG_MESSAGES: {
  heartbeatFailed: string;
  pipelineFailed: string;
  pipelineStarted: string;
  pipelineExtractingFacts: string;
  pipelineExtractedFacts: string;
  pipelineStoppedAfterFailureMarker: string;
  pipelineDetectingSignals: string;
  pipelineDetectedSignals: string;
  pipelineNoSignalsCheckingCapabilities: string;
  pipelineSelectingCapabilities: string;
  pipelineSelectedCapabilities: string;
  pipelineNoMatchingCapabilities: string;
  pipelineSkippedUnsupportedSummary: string;
  pipelineCompleted: string;
  enqueueDurableRun: string;
} = {
  heartbeatFailed: "Failed to heartbeat suggested action run",
  pipelineFailed: "Suggested action pipeline failed",
  pipelineStarted: "Suggested action pipeline started",
  pipelineExtractingFacts: "Suggested action pipeline extracting meeting facts",
  pipelineExtractedFacts: "Suggested action pipeline extracted meeting facts",
  pipelineStoppedAfterFailureMarker: "Suggested action pipeline stopped after external failure marker",
  pipelineDetectingSignals: "Suggested action pipeline detecting signals",
  pipelineDetectedSignals: "Suggested action pipeline detected signals",
  pipelineNoSignalsCheckingCapabilities:
    "Suggested action pipeline found no signals; checking deterministic capabilities",
  pipelineSelectingCapabilities: "Suggested action pipeline selecting capabilities",
  pipelineSelectedCapabilities: "Suggested action pipeline selected capabilities",
  pipelineNoMatchingCapabilities: "Suggested action pipeline found no matching capabilities",
  pipelineSkippedUnsupportedSummary:
    "Suggested action pipeline skipped because summary model cannot support follow-ups",
  pipelineCompleted: "Suggested action pipeline completed",
  enqueueDurableRun: "Enqueuing durable suggested action run",
};

const STEP_DEFINITIONS: { id: SuggestedActionStep["id"]; label: string }[] = [
  { id: "reading_notes", label: "Reading final notes" },
  { id: "extracting_facts", label: "Extracting meeting facts" },
  { id: "validating_evidence", label: "Validating transcript evidence" },
  { id: "detecting_signals", label: "Detecting agent signals" },
  { id: "matching_agents", label: "Matching agents to the meeting" },
  { id: "preparing_work", label: "Preparing agent work" },
];

function isTerminalStatus(status: SuggestedActionRunStatus) {
  return TERMINAL_STATUSES.has(status);
}

function shouldReturnExistingSuggestedActionRun(status: SuggestedActionRunStatus): boolean {
  return isTerminalStatus(status) && status !== "failed";
}

function logInfo(input: { logger: LoggerLike; bindings: Record<string, unknown>; message: string }) {
  input.logger.info?.({ bindings: input.bindings, message: input.message });
}

function elapsedMs(startedAt: Date) {
  return Date.now() - startedAt.getTime();
}

function buildSteps(input: {
  phase: SuggestedActionRunPhase;
  overrides?: Partial<Record<SuggestedActionRunPhase, SuggestedActionStepStatus>>;
}) {
  const overrides = input.overrides ?? {};
  const activeIndex =
    input.phase === "complete"
      ? STEP_DEFINITIONS.length
      : STEP_DEFINITIONS.findIndex((step) => step.id === input.phase);

  return STEP_DEFINITIONS.map((step, index): SuggestedActionStep => {
    const override = overrides[step.id];
    if (override !== undefined) {
      return { ...step, status: override };
    }

    if (activeIndex === STEP_DEFINITIONS.length || index < activeIndex) {
      return { ...step, status: "completed" };
    }

    if (index === activeIndex) {
      return { ...step, status: "running" };
    }

    return { ...step, status: "pending" };
  });
}

function attachCapabilityViews(input: {
  recommendations: CapabilityRecommendationRow[];
  capabilities: CapabilityCatalogRow[];
}): CapabilityRecommendationView[] {
  const capabilitiesByKey = new Map(input.capabilities.map((capability) => [capability.key, capability]));

  return filterVisibleCapabilityRecommendations(input.recommendations).map((recommendation) => {
    const capability = capabilitiesByKey.get(recommendation.capabilityKey);
    if (capability === undefined) {
      return recommendation;
    }

    return {
      ...recommendation,
      capability: {
        key: capability.key,
        name: capability.name,
        description: capability.description,
        category: capability.category,
        applicableMeetingTypes: capability.applicableMeetingTypes,
        requiredSignals: capability.requiredSignals,
        exclusionSignals: capability.exclusionSignals,
        defaultPriority: capability.defaultPriority,
      },
    };
  });
}

async function getSelectionForMeeting(meetingId: string): Promise<CapabilitySelectionResult | null> {
  const [recommendations, capabilities] = await Promise.all([
    ensureAlwaysAvailableCapabilityRecommendationsForMeeting(meetingId),
    repositories().listActiveCapabilities(),
  ]);

  if (recommendations.length === 0) {
    return null;
  }

  return {
    recommendations: attachCapabilityViews({ recommendations, capabilities }),
    considered: [],
  };
}

function responseFromRun(input: {
  status: SuggestedActionRunStatus;
  phase: SuggestedActionRunPhase;
  steps: SuggestedActionStep[];
  selection: CapabilitySelectionResult | null;
  message?: string | null;
  startedAt?: Date | null;
  lastActivityAt?: Date | null;
  isStale?: boolean;
}): SuggestedActionRunResponse {
  const idleTimeoutAt = input.lastActivityAt ? new Date(input.lastActivityAt.getTime() + IDLE_TIMEOUT_MS) : null;

  return {
    status: input.status,
    phase: input.phase,
    steps: input.steps,
    selection: input.selection,
    message: input.message ?? null,
    startedAt: input.startedAt?.toISOString() ?? null,
    lastActivityAt: input.lastActivityAt?.toISOString() ?? null,
    idleTimeoutAt: idleTimeoutAt?.toISOString() ?? null,
    /** @external */
    isStale: input.isStale ?? false,
  };
}

function getNoWorkMessage() {
  return SUGGESTED_ACTIONS_MESSAGES.noWork;
}

function shouldSkipForSummaryModel(model: string | null | undefined) {
  if (model === null || model === undefined) {
    return false;
  }

  return NO_WORK_SUMMARY_MODELS.has(model);
}

function meetingFactExtractionStatusError(contentStatus: string) {
  return `Meeting fact extraction ended with status "${contentStatus}"`;
}

function meetingSignalExtractionStatusError(signalsStatus: string) {
  return `Meeting signal extraction ended with status "${signalsStatus}"`;
}

function startedAtFromJobTimestamp(startedAt: string | null | undefined): Date | null {
  if (startedAt === null || startedAt === undefined || startedAt.length === 0) {
    return null;
  }

  return new Date(startedAt);
}

async function persistRun(input: {
  meetingId: string;
  status: SuggestedActionRunStatus;
  phase: SuggestedActionRunPhase;
  message?: string | null;
  error?: string | null;
  selectedRecommendationIds?: string[];
  stepOverrides?: Partial<Record<SuggestedActionRunPhase, SuggestedActionStepStatus>>;
  startedAt?: Date | null;
  completedAt?: Date | null;
}) {
  return repositories().upsertSuggestedActionRun({
    meetingId: input.meetingId,
    status: input.status,
    phase: input.phase,
    steps: buildSteps({ phase: input.phase, overrides: input.stepOverrides }),
    message: input.message ?? null,
    error: input.error ?? null,
    selectedRecommendationIds: input.selectedRecommendationIds ?? [],
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
  });
}

async function failRun(input: {
  meetingId: string;
  startedAt: Date;
  message?: string;
  error: string;
  failedPhase?: SuggestedActionRunPhase;
}) {
  const failedPhase = input.failedPhase ?? "preparing_work";

  return persistRun({
    meetingId: input.meetingId,
    status: "failed",
    phase: "complete",
    message: input.message ?? SUGGESTED_ACTIONS_MESSAGES.couldNotFinish,
    error: input.error,
    stepOverrides: {
      [failedPhase]: "failed",
      preparing_work: failedPhase === "preparing_work" ? "failed" : "skipped",
    },
    startedAt: input.startedAt,
    completedAt: new Date(),
  });
}

async function shouldContinue(meetingId: string) {
  const run = await repositories().getSuggestedActionRunByMeetingId(meetingId);

  return run?.status !== "failed";
}

async function finishNoWork(input: { meetingId: string; message?: string }) {
  await persistRun({
    meetingId: input.meetingId,
    status: "no_work_found",
    phase: "complete",
    message: input.message ?? getNoWorkMessage(),
    stepOverrides: {
      preparing_work: "skipped",
    },
    completedAt: new Date(),
  });
}

function getRunAgeAnchor(run: SuggestedActionRunRow) {
  if (run === null) {
    return null;
  }

  return run.updatedAt;
}

function isStaleRunningRun(run: SuggestedActionRunRow) {
  if (run === null || run.status !== "running") {
    return false;
  }

  const anchor = getRunAgeAnchor(run);
  if (!(anchor instanceof Date)) {
    return false;
  }

  return Date.now() - anchor.getTime() > IDLE_TIMEOUT_MS;
}

async function failStaleRun(meetingId: string) {
  return persistRun({
    meetingId,
    status: "failed",
    phase: "complete",
    message: SUGGESTED_ACTIONS_MESSAGES.couldNotFinish,
    error: SUGGESTED_ACTIONS_MESSAGES.staleError,
    stepOverrides: {
      preparing_work: "failed",
    },
    completedAt: new Date(),
  });
}

async function heartbeatRun(input: { meetingId: string; phase: SuggestedActionRunPhase; startedAt: Date }) {
  const run = await repositories().getSuggestedActionRunByMeetingId(input.meetingId);
  if (run === null || run.status !== "running" || run.phase !== input.phase) {
    return false;
  }

  await persistRun({
    meetingId: input.meetingId,
    status: "running",
    phase: input.phase,
    message: run.message,
    error: run.error,
    selectedRecommendationIds: run.selectedRecommendationIds,
    startedAt: input.startedAt,
  });

  return true;
}

async function withRunHeartbeat<T>(input: {
  meetingId: string;
  phase: SuggestedActionRunPhase;
  startedAt: Date;
  logger: LoggerLike;
  task: () => Promise<T>;
}) {
  const intervalId = setInterval(() => {
    void (async () => {
      try {
        await heartbeatRun(input);
      } catch (error) {
        input.logger.warn({
          bindings: { error, meetingId: input.meetingId, phase: input.phase },
          message: SUGGESTED_ACTIONS_LOG_MESSAGES.heartbeatFailed,
        });
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  intervalId.unref();

  try {
    await heartbeatRun(input);

    return await input.task();
  } finally {
    clearInterval(intervalId);
  }
}

type PersistPipelineRun = (persistInput: Parameters<typeof persistRun>[0]) => ReturnType<typeof persistRun>;

type MeetingExtractionPayload = ReturnType<typeof meetingExtractionResponseSchema.parse>["extraction"];

async function pipelineExtractMeetingFacts(input: {
  meetingId: string;
  logger: LoggerLike;
  startedAt: Date;
  persistPipelineRun: PersistPipelineRun;
}): Promise<MeetingExtractionPayload | null> {
  logInfo({
    logger: input.logger,
    bindings: { meetingId: input.meetingId },
    message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineExtractingFacts,
  });
  await input.persistPipelineRun({
    meetingId: input.meetingId,
    status: "running",
    phase: "extracting_facts",
    startedAt: input.startedAt,
  });
  const contentExtraction = meetingExtractionResponseSchema.parse(
    await withRunHeartbeat({
      meetingId: input.meetingId,
      phase: "extracting_facts",
      startedAt: input.startedAt,
      logger: input.logger,
      task: () => triggerMeetingExtraction(input.meetingId),
    }),
  );
  const extraction = contentExtraction.extraction;
  logInfo({
    logger: input.logger,
    bindings: {
      meetingId: input.meetingId,
      extractionId: extraction.id,
      contentStatus: extraction.contentStatus,
      durationMs: elapsedMs(input.startedAt),
      actionItemCount: extraction.actionItems.length,
      decisionCount: extraction.decisions.length,
      topicCount: extraction.keyTopics.length,
    },
    message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineExtractedFacts,
  });

  if (!(await shouldContinue(input.meetingId))) {
    logInfo({
      logger: input.logger,
      bindings: { meetingId: input.meetingId },
      message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineStoppedAfterFailureMarker,
    });

    return null;
  }

  if (extraction.contentStatus !== "completed" && extraction.contentStatus !== "partial") {
    await failRun({
      meetingId: input.meetingId,
      startedAt: input.startedAt,
      failedPhase: "extracting_facts",
      error: meetingFactExtractionStatusError(extraction.contentStatus),
    });

    return null;
  }

  return extraction;
}

async function pipelineDetectMeetingSignals(input: {
  meetingId: string;
  logger: LoggerLike;
  startedAt: Date;
  persistPipelineRun: PersistPipelineRun;
  extractionId: string;
}): Promise<MeetingExtractionPayload | null> {
  await input.persistPipelineRun({
    meetingId: input.meetingId,
    status: "running",
    phase: "validating_evidence",
    startedAt: input.startedAt,
  });

  await input.persistPipelineRun({
    meetingId: input.meetingId,
    status: "running",
    phase: "detecting_signals",
    startedAt: input.startedAt,
  });
  logInfo({
    logger: input.logger,
    bindings: { meetingId: input.meetingId, extractionId: input.extractionId },
    message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineDetectingSignals,
  });
  const signalExtraction = meetingExtractionResponseSchema.parse(
    await withRunHeartbeat({
      meetingId: input.meetingId,
      phase: "detecting_signals",
      startedAt: input.startedAt,
      logger: input.logger,
      task: () => triggerMeetingSignalExtraction(input.meetingId),
    }),
  );
  const extractionWithSignals = signalExtraction.extraction;
  logInfo({
    logger: input.logger,
    bindings: {
      meetingId: input.meetingId,
      extractionId: extractionWithSignals.id,
      signalsStatus: extractionWithSignals.signalsStatus,
      signalCount: extractionWithSignals.signals.length,
      failedToolCallCount: extractionWithSignals.failedToolCalls.length,
      durationMs: elapsedMs(input.startedAt),
    },
    message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineDetectedSignals,
  });

  if (!(await shouldContinue(input.meetingId))) {
    logInfo({
      logger: input.logger,
      bindings: { meetingId: input.meetingId },
      message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineStoppedAfterFailureMarker,
    });

    return null;
  }

  if (extractionWithSignals.signalsStatus !== "completed" && extractionWithSignals.signalsStatus !== "partial") {
    await failRun({
      meetingId: input.meetingId,
      startedAt: input.startedAt,
      failedPhase: "detecting_signals",
      error: meetingSignalExtractionStatusError(extractionWithSignals.signalsStatus),
    });

    return null;
  }

  if (extractionWithSignals.signals.length === 0) {
    logInfo({
      logger: input.logger,
      bindings: { meetingId: input.meetingId, extractionId: extractionWithSignals.id },
      message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineNoSignalsCheckingCapabilities,
    });
  }

  return extractionWithSignals;
}

async function pipelineSelectCapabilities(input: {
  meetingId: string;
  logger: LoggerLike;
  startedAt: Date;
  persistPipelineRun: PersistPipelineRun;
  extractionWithSignals: MeetingExtractionPayload;
}): Promise<CapabilitySelectionResult | null> {
  await input.persistPipelineRun({
    meetingId: input.meetingId,
    status: "running",
    phase: "matching_agents",
    startedAt: input.startedAt,
  });

  await input.persistPipelineRun({
    meetingId: input.meetingId,
    status: "running",
    phase: "preparing_work",
    startedAt: input.startedAt,
  });
  logInfo({
    logger: input.logger,
    bindings: { meetingId: input.meetingId, extractionId: input.extractionWithSignals.id },
    message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineSelectingCapabilities,
  });
  const taskList = await repositories().getMeetingTaskListForMeeting(input.meetingId);
  const taskContext = taskList?.status === "completed" ? taskList : null;
  const selection = capabilitySelectionResponseSchema.parse(
    await withRunHeartbeat({
      meetingId: input.meetingId,
      phase: "preparing_work",
      startedAt: input.startedAt,
      logger: input.logger,
      task: () =>
        triggerCapabilitySelection(input.extractionWithSignals.id, {
          tasks: taskContext,
        }),
    }),
  );
  logInfo({
    logger: input.logger,
    bindings: {
      meetingId: input.meetingId,
      extractionId: input.extractionWithSignals.id,
      recommendationCount: selection.recommendations.length,
      consideredCount: selection.considered.length,
      durationMs: elapsedMs(input.startedAt),
    },
    message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineSelectedCapabilities,
  });

  if (!(await shouldContinue(input.meetingId))) {
    logInfo({
      logger: input.logger,
      bindings: { meetingId: input.meetingId },
      message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineStoppedAfterFailureMarker,
    });

    return null;
  }

  if (selection.recommendations.length === 0) {
    logInfo({
      logger: input.logger,
      bindings: { meetingId: input.meetingId },
      message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineNoMatchingCapabilities,
    });
    await finishNoWork({ meetingId: input.meetingId });

    return null;
  }

  return selection;
}

async function runSuggestedActionsPipelineNamed(input: {
  meetingId: string;
  logger: LoggerLike;
  options?: {
    onPhase?: (phase: SuggestedActionRunPhase) => Promise<void>;
  };
}): Promise<void> {
  const startedAt = new Date();
  const persistPipelineRun: PersistPipelineRun = async (persistInput) => {
    const run = await persistRun(persistInput);
    await input.options?.onPhase?.(persistInput.phase);

    return run;
  };
  try {
    logInfo({
      logger: input.logger,
      bindings: { meetingId: input.meetingId },
      message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineStarted,
    });
    await persistPipelineRun({
      meetingId: input.meetingId,
      status: "running",
      phase: "reading_notes",
      startedAt,
    });

    const summary = await repositories().getSummaryForMeeting(input.meetingId);
    if (shouldSkipForSummaryModel(summary?.model)) {
      logInfo({
        logger: input.logger,
        bindings: { meetingId: input.meetingId, summaryModel: summary?.model ?? null },
        message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineSkippedUnsupportedSummary,
      });
      await finishNoWork({ meetingId: input.meetingId });

      return;
    }

    const extraction = await pipelineExtractMeetingFacts({
      meetingId: input.meetingId,
      logger: input.logger,
      startedAt,
      persistPipelineRun,
    });
    if (extraction === null) {
      return;
    }

    const extractionWithSignals = await pipelineDetectMeetingSignals({
      meetingId: input.meetingId,
      logger: input.logger,
      startedAt,
      persistPipelineRun,
      extractionId: extraction.id,
    });
    if (extractionWithSignals === null) {
      return;
    }

    const selection = await pipelineSelectCapabilities({
      meetingId: input.meetingId,
      logger: input.logger,
      startedAt,
      persistPipelineRun,
      extractionWithSignals,
    });
    if (selection === null) {
      return;
    }

    await persistPipelineRun({
      meetingId: input.meetingId,
      status: "completed",
      phase: "complete",
      selectedRecommendationIds: selection.recommendations.map((recommendation) => recommendation.id),
      startedAt,
      completedAt: new Date(),
    });
    logInfo({
      logger: input.logger,
      bindings: {
        meetingId: input.meetingId,
        recommendationCount: selection.recommendations.length,
        durationMs: elapsedMs(startedAt),
      },
      message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineCompleted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : SUGGESTED_ACTIONS_MESSAGES.pipelineFailed;
    input.logger.warn({
      bindings: { error, meetingId: input.meetingId },
      message: SUGGESTED_ACTIONS_LOG_MESSAGES.pipelineFailed,
    });
    await failRun({
      meetingId: input.meetingId,
      startedAt,
      error: message,
    });
  }
}

export async function runSuggestedActionsPipeline(
  ...args: [
    meetingId: string,
    logger: LoggerLike,
    options?: {
      onPhase?: (phase: SuggestedActionRunPhase) => Promise<void>;
    },
  ]
): Promise<void> {
  return runSuggestedActionsPipelineNamed({
    meetingId: args[0],
    logger: args[1],
    options: args[2],
  });
}

function buildSelectionCompletedStatus(selection: CapabilitySelectionResult): SuggestedActionRunResponse {
  return responseFromRun({
    status: "completed",
    phase: "complete",
    steps: buildSteps({ phase: "complete" }),
    selection,
    message: null,
    startedAt: null,
    lastActivityAt: new Date(),
  });
}

async function resolveStaleRunningSuggestedActionsStatus(input: {
  meetingId: string;
  run: NonNullable<SuggestedActionRunRow>;
}): Promise<SuggestedActionRunResponse> {
  const [latestJob] = await repositories().listAiWorkflowJobsForMeeting(input.meetingId);
  if (latestJob !== undefined && (latestJob.status === "queued" || latestJob.status === "running")) {
    return responseFromRun({
      status: "running",
      phase: input.run.phase,
      steps: input.run.steps,
      selection: null,
      message: input.run.message ?? null,
      startedAt: input.run.startedAt ?? startedAtFromJobTimestamp(latestJob.startedAt),
      lastActivityAt: new Date(latestJob.updatedAt),
      isStale: false,
    });
  }
  const lastActivityAt = getRunAgeAnchor(input.run);
  const failedRun = await failStaleRun(input.meetingId);

  return responseFromRun({
    status: failedRun.status,
    phase: failedRun.phase,
    steps: failedRun.steps,
    selection: null,
    message: failedRun.message ?? failedRun.error ?? null,
    startedAt: input.run.startedAt ?? null,
    lastActivityAt: lastActivityAt ?? failedRun.updatedAt,
    isStale: true,
  });
}

async function resolveSummarySkipSuggestedActionsStatus(meetingId: string): Promise<SuggestedActionRunResponse> {
  await finishNoWork({ meetingId });
  const noWorkRun = await repositories().getSuggestedActionRunByMeetingId(meetingId);

  return responseFromRun({
    status: "no_work_found",
    phase: "complete",
    steps: noWorkRun?.steps ?? buildSteps({ phase: "complete", overrides: { preparing_work: "skipped" } }),
    selection: null,
    message: noWorkRun?.message ?? getNoWorkMessage(),
    startedAt: noWorkRun?.startedAt ?? null,
    lastActivityAt: noWorkRun?.updatedAt ?? new Date(),
  });
}

function buildPendingSuggestedActionsStatus(): SuggestedActionRunResponse {
  return responseFromRun({
    status: "pending",
    phase: "reading_notes",
    steps: buildSteps({ phase: "reading_notes", overrides: { reading_notes: "pending" } }),
    selection: null,
    message: null,
    startedAt: null,
    lastActivityAt: null,
  });
}

function buildPersistedRunSuggestedActionsStatus(run: NonNullable<SuggestedActionRunRow>): SuggestedActionRunResponse {
  const lastActivityAt = getRunAgeAnchor(run);

  return responseFromRun({
    status: run.status,
    phase: run.phase,
    steps: run.steps,
    selection: null,
    message: run.message ?? run.error ?? (run.status === "no_work_found" ? getNoWorkMessage() : null),
    startedAt: run.startedAt,
    lastActivityAt,
    isStale: false,
  });
}

async function getSuggestedActionsStatusNamed(meetingId: string): Promise<SuggestedActionRunResponse> {
  const selection = await getSelectionForMeeting(meetingId);
  if (selection !== null) {
    return buildSelectionCompletedStatus(selection);
  }

  const run = await repositories().getSuggestedActionRunByMeetingId(meetingId);
  if (run !== null && isStaleRunningRun(run)) {
    return resolveStaleRunningSuggestedActionsStatus({ meetingId, run });
  }

  const summary = await repositories().getSummaryForMeeting(meetingId);
  if (shouldSkipForSummaryModel(summary?.model)) {
    return resolveSummarySkipSuggestedActionsStatus(meetingId);
  }

  if (run === null) {
    return buildPendingSuggestedActionsStatus();
  }

  return buildPersistedRunSuggestedActionsStatus(run);
}

export async function getSuggestedActionsStatus(meetingId: string): Promise<SuggestedActionRunResponse> {
  return getSuggestedActionsStatusNamed(meetingId);
}

async function startSuggestedActionsRunNamed(input: {
  meetingId: string;
  logger: LoggerLike;
}): Promise<SuggestedActionRunResponse> {
  const meeting = await repositories().getMeetingById(input.meetingId);
  if (meeting === null) {
    throw new Error(SUGGESTED_ACTIONS_MESSAGES.meetingNotFound);
  }

  const current = await getSuggestedActionsStatus(input.meetingId);
  if (shouldReturnExistingSuggestedActionRun(current.status)) {
    return current;
  }

  const [taskList, transcriptData] = await Promise.all([
    repositories().getMeetingTaskListForMeeting(input.meetingId),
    repositories().getTranscriptForMeeting(input.meetingId),
  ]);
  const hasReusableTasks = taskList?.status === "completed" || isMeetingTaskListCurrent(taskList, transcriptData);
  if (
    !hasReusableTasks &&
    (taskList === null ||
      taskList.status === "pending" ||
      taskList.status === "generating" ||
      taskList.status === "completed")
  ) {
    await persistRun({
      meetingId: input.meetingId,
      status: "running",
      phase: "reading_notes",
      startedAt: new Date(),
      message: SUGGESTED_ACTIONS_MESSAGES.preparingTasks,
    });
    await generateAndPersistMeetingTasks(input.meetingId, {
      warn: (...args: [bindings: Record<string, unknown>, message: string]) => {
        input.logger.warn({ bindings: args[0], message: args[1] });
      },
      info: (...args: [bindings: Record<string, unknown>, message: string]) => {
        input.logger.info?.({ bindings: args[0], message: args[1] });
      },
    });
    await runSuggestedActionsPipeline(input.meetingId, input.logger);

    return getSuggestedActionsStatus(input.meetingId);
  }

  logInfo({
    logger: input.logger,
    bindings: { meetingId: input.meetingId },
    message: SUGGESTED_ACTIONS_LOG_MESSAGES.enqueueDurableRun,
  });
  await persistRun({
    meetingId: input.meetingId,
    status: "running",
    phase: "reading_notes",
    startedAt: new Date(),
  });
  await runSuggestedActionsPipeline(input.meetingId, input.logger);

  return getSuggestedActionsStatus(input.meetingId);
}

export async function startSuggestedActionsRun(
  ...args: [meetingId: string, logger: PositionalLoggerLike]
): Promise<SuggestedActionRunResponse> {
  return startSuggestedActionsRunNamed({ meetingId: args[0], logger: loggerFromPositional(args[1]) });
}

export const suggestedActionsTestInternals = {
  shouldReturnExistingSuggestedActionRun,
};
