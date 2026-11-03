import {
  type MemoryGenerationInput,
  memoryGenerationSchema,
  type VoiceSearchIdentityEvidence,
} from "@readymeet/shared";
import { z } from "zod";

import { bindPortFunction } from "./bind-port";

const ASSISTANT_CLIENT_PORT_IS_NOT_CONFIGURED_MESSAGE = "AssistantClient port is not configured.";

export const snapshotResponseSchema = z.object({
  snapshot: z.unknown(),
});
export const extractionResponseSchema = z.object({
  extraction: z.unknown(),
});
export const tasksResponseSchema = z.object({
  tasks: z.unknown(),
});
export const memoryGenerationResponseSchema = z.object({
  value: memoryGenerationSchema,
  model: z.string(),
});

type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;

type AssistantMeteringContext = {
  meetingId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
};

type MeetingTitleResponse = {
  title: string;
  preparationLines: string[];
  /** @external assistant title endpoint preparation lines fallback flag */
  preparationLinesFallback: boolean;
  model: string;
};

type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

type CapabilitySelectionInput = {
  /** @external assistant capability selection force refresh flag */
  forceRefresh?: boolean;
  tasks?: unknown;
  metering?: AssistantMeteringContext;
};

type TasksResponse = z.infer<typeof tasksResponseSchema>;

type TriggerMeetingTasksInput = {
  initialCandidates: unknown[];
  dismissedTombstones?: unknown[];
  metering?: AssistantMeteringContext;
};

type RoomAssistantStopResponse = {
  /** @external assistant room assistant ok flag */
  ok: boolean;
  /** @external assistant room assistant stopped flag */
  stopped: boolean;
  /** @external assistant room assistant drained flag */
  drained?: boolean;
};

type LiveTranscriptionStopResponse = {
  /** @external assistant live transcription ok flag */
  ok: boolean;
  /** @external assistant live transcription stopped flag */
  stopped: boolean;
  /** @external assistant live transcription finalized flag */
  finalized?: boolean;
};

type RoomAssistantStartResponse = {
  /** @external assistant room assistant ok flag */
  ok: boolean;
  /** @external assistant room assistant started flag */
  started: boolean;
};

type MemoryGenerationResponse = z.infer<typeof memoryGenerationResponseSchema>;

type AssistantClientPort = {
  triggerBugReportDraftRevision: (input: Record<string, unknown>) => Promise<unknown>;
  triggerBugReportIssuePlanning: (input: Record<string, unknown>) => Promise<unknown>;
  triggerMeetingCoachingFeedback: (input: Record<string, unknown>) => Promise<unknown>;
  triggerMemoryGeneration: (
    ...args: [input: MemoryGenerationInput, authorization: { jobId: string; leaseToken: string }, signal?: AbortSignal]
  ) => Promise<MemoryGenerationResponse>;
  triggerLinearTaskReview: (...args: [meetingId: string, input: Record<string, unknown>]) => Promise<unknown>;
  triggerLinearTaskReviewRevision: (...args: [runId: string, input: Record<string, unknown>]) => Promise<unknown>;
  startMeetingAssistant: (...args: [meetingId: string]) => Promise<RoomAssistantStartResponse>;
  stopLiveMeetingTranscription: (...args: [meetingId: string]) => Promise<LiveTranscriptionStopResponse>;
  stopMeetingAssistant: (...args: [meetingId: string]) => Promise<RoomAssistantStopResponse>;
  triggerMeetingTaskChunk: (input: {
    voiceSearchIdentityEvidence?: VoiceSearchIdentityEvidence[];
    meetingId: string;
    metering?: AssistantMeteringContext;
    title: string | null;
    participants: { userId?: string; name: string; email?: string | null; roleHint?: string | null }[];
    chunkIndex: number;
    totalChunks: number;
    taskHintScore: number;
    transcriptText: string;
    languageContext?: string;
    extractionMode?: "general" | "personal_list";
  }) => Promise<TasksResponse>;
  triggerMeetingTaskReconciliation: (input: {
    voiceSearchIdentityEvidence?: VoiceSearchIdentityEvidence[];
    meetingId: string;
    metering?: AssistantMeteringContext;
    evidencePacket: unknown;
  }) => Promise<TasksResponse>;
  triggerMeetingTasks: (...args: [meetingId: string, input: TriggerMeetingTasksInput]) => Promise<TasksResponse>;
  triggerCapabilitySelection: (...args: [extractionId: string, input?: CapabilitySelectionInput]) => Promise<unknown>;
  triggerMeetingExtraction: (
    ...args: [meetingId: string, metering?: AssistantMeteringContext]
  ) => Promise<ExtractionResponse>;
  triggerMeetingSignalExtraction: (...args: [meetingId: string]) => Promise<ExtractionResponse>;
  triggerMeetingTitle: (
    ...args: [meetingId: string, metering?: AssistantMeteringContext, meetingInProgress?: boolean]
  ) => Promise<MeetingTitleResponse>;
  triggerMeetingSnapshot: (
    ...args: [meetingId: string, metering?: AssistantMeteringContext]
  ) => Promise<SnapshotResponse>;
};

const assistantClientState: { port?: AssistantClientPort } = {};

export function configureAssistantClient(port: AssistantClientPort): void {
  assistantClientState.port = port;
}

function assistantClient(): AssistantClientPort {
  if (assistantClientState.port === undefined) {
    throw new Error(ASSISTANT_CLIENT_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return assistantClientState.port;
}

export const triggerBugReportDraftRevision: AssistantClientPort["triggerBugReportDraftRevision"] = bindPortFunction(
  () => assistantClient().triggerBugReportDraftRevision,
);

export const triggerBugReportIssuePlanning: AssistantClientPort["triggerBugReportIssuePlanning"] = bindPortFunction(
  () => assistantClient().triggerBugReportIssuePlanning,
);

export const triggerMeetingCoachingFeedback: AssistantClientPort["triggerMeetingCoachingFeedback"] = bindPortFunction(
  () => assistantClient().triggerMeetingCoachingFeedback,
);

export const triggerMemoryGeneration: AssistantClientPort["triggerMemoryGeneration"] = bindPortFunction(
  () => assistantClient().triggerMemoryGeneration,
);

export const triggerLinearTaskReview: AssistantClientPort["triggerLinearTaskReview"] = bindPortFunction(
  () => assistantClient().triggerLinearTaskReview,
);

export const triggerLinearTaskReviewRevision: AssistantClientPort["triggerLinearTaskReviewRevision"] = bindPortFunction(
  () => assistantClient().triggerLinearTaskReviewRevision,
);

export const startMeetingAssistant: AssistantClientPort["startMeetingAssistant"] = bindPortFunction(
  () => assistantClient().startMeetingAssistant,
);

export const stopLiveMeetingTranscription: AssistantClientPort["stopLiveMeetingTranscription"] = bindPortFunction(
  () => assistantClient().stopLiveMeetingTranscription,
);

export const stopMeetingAssistant: AssistantClientPort["stopMeetingAssistant"] = bindPortFunction(
  () => assistantClient().stopMeetingAssistant,
);

export const triggerMeetingTaskChunk: AssistantClientPort["triggerMeetingTaskChunk"] = bindPortFunction(
  () => assistantClient().triggerMeetingTaskChunk,
);

export const triggerMeetingTaskReconciliation: AssistantClientPort["triggerMeetingTaskReconciliation"] =
  bindPortFunction(() => assistantClient().triggerMeetingTaskReconciliation);

export const triggerMeetingTasks: AssistantClientPort["triggerMeetingTasks"] = bindPortFunction(
  () => assistantClient().triggerMeetingTasks,
);

export const triggerCapabilitySelection: AssistantClientPort["triggerCapabilitySelection"] = bindPortFunction(
  () => assistantClient().triggerCapabilitySelection,
);

export const triggerMeetingExtraction: AssistantClientPort["triggerMeetingExtraction"] = bindPortFunction(
  () => assistantClient().triggerMeetingExtraction,
);

export const triggerMeetingSignalExtraction: AssistantClientPort["triggerMeetingSignalExtraction"] = bindPortFunction(
  () => assistantClient().triggerMeetingSignalExtraction,
);

export const triggerMeetingTitle: AssistantClientPort["triggerMeetingTitle"] = bindPortFunction(
  () => assistantClient().triggerMeetingTitle,
);

export const triggerMeetingSnapshot: AssistantClientPort["triggerMeetingSnapshot"] = bindPortFunction(
  () => assistantClient().triggerMeetingSnapshot,
);
