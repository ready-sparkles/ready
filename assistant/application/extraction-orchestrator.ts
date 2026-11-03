import {
  type ExtractedParticipant,
  type MeetingExtraction,
  type MeetingTrackerState,
  openAIPromptCacheOptions,
  type VoiceSearchIdentityEvidence,
} from "@readymeet/shared";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  buildHumanReadableExtractionSystemPrompt,
  buildSignalExtractionSystemPrompt,
  MEETING_EXTRACTION_PROMPT_VERSION,
} from "../domain/extraction/prompt-v1";
import { inferSignalsFromValidatedContent } from "../domain/extraction/signal-inference";
import { assistantEnv } from "../ports/assistant-env";
import { openAIClientApiKey } from "../ports/openai-client";
import { createOpenAIClient, type OpenAIClient, type OpenAIFunctionTool } from "../ports/openai-client";
import { withOpenAIRetry } from "../ports/openai-retry";
import { repositories } from "../ports/repository-runtime";

import { hasUnverifiedSourceSpans, validateHumanReadableExtraction } from "./extraction-content";
import {
  applyToolCall,
  buildMeetingExtractionTools,
  createInitialToolState,
  sourceSpansToSignalEvidence,
  type ToolApplicationState,
  type TranscriptLineReference,
} from "./extraction-tools";
import { parseResponseText } from "./openai-response-text";
import { executeMeteredOpenAIResponse } from "./usage-metering";

const inFlightContentExtractions = new Map<string, Promise<MeetingExtraction>>();
const inFlightSignalExtractions = new Map<string, Promise<MeetingExtraction>>();

const RELATIVE_TIMESTAMP_MS_PER_SECOND = 1000;
const RELATIVE_TIMESTAMP_SECONDS_PER_MINUTE = 60;
const RELATIVE_TIMESTAMP_PAD_WIDTH = 2;
const TRANSCRIPT_LINE_NUMBER_PAD_WIDTH = 2;
const SIGNAL_USER_MESSAGE_JSON_INDENT = 2;

const ORCHESTRATOR_MESSAGES = {
  timedOut: (input: { label: string; timeoutMs: number }) => `${input.label} timed out after ${input.timeoutMs}ms`,
  openAiKeyRequired: "Configured AI provider key is required for meeting extraction",
  openAiKeyRequiredSignals: "Configured AI provider key is required for meeting signal extraction",
  transcriptRequired: "Meeting extraction requires at least one transcript segment",
  contentExtractionStarted: "Content extraction model call started",
  contentExtractionCompleted: "Content extraction model call completed",
  contentExtractionPersisted: "Content extraction persisted",
  contentExtractionFailed: "Content extraction failed",
  meetingContentExtractionFailed: "Meeting content extraction failed",
  humanReadableRequired: "Human-readable extraction must complete before signal extraction",
  signalTurnStarted: "Signal extraction model turn started",
  signalTurnCompleted: "Signal extraction model turn completed",
  signalNoToolCalls: "Signal extraction model returned no tool calls",
  toolArgumentsInvalidJson: "Tool arguments were not valid JSON",
  signalDroppedUnverified: (key: string) =>
    `Signal "${key}" was dropped because one or more source spans were unverified`,
  signalMaxTurnsExceeded: (maxTurns: number) =>
    `Signal extraction exceeded max turn limit (${maxTurns}) without finish_extraction`,
  signalExtractionPersisted: "Signal extraction persisted",
  signalExtractionFailed: "Signal extraction failed",
  meetingSignalExtractionFailed: "Meeting signal extraction failed",
  extractionNoToolCalls: "Extraction model returned no tool calls",
  extractionMaxTurnsExceeded: (maxTurns: number) =>
    `Extraction exceeded max turn limit (${maxTurns}) without finish_extraction`,
  meetingExtractionFailed: "Meeting extraction failed",
  untitledMeeting: "Untitled meeting",
} as const;

const openAiResponseOutputSchema = z.object({
  id: z.string().optional(),
  output: z.array(z.unknown()).optional(),
});

const openAiFunctionToolCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

const openAiReasoningOutputSchema = z.object({
  type: z.literal("reasoning"),
  id: z.string().optional(),
  encrypted_content: z.string().nullable().optional(),
});

type ExtractionConversationItem =
  | { role: "system" | "user"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; id?: string; encrypted_content?: string };

function parseExtractionModelTurnResponse(response: unknown): ExtractionModelTurnResponse {
  const parsed = openAiResponseOutputSchema.safeParse(response);
  const output = parsed.success && parsed.data.output !== undefined ? parsed.data.output : [];
  const toolCalls = output.flatMap((item) => {
    const call = openAiFunctionToolCallSchema.safeParse(item);
    if (!call.success) {
      return [];
    }

    return [
      {
        callId: call.data.call_id,
        name: call.data.name,
        argumentsText: call.data.arguments,
      },
    ];
  });

  const replayItems = output.flatMap((item): ExtractionConversationItem[] => {
    const call = openAiFunctionToolCallSchema.safeParse(item);
    if (call.success) {
      return [call.data];
    }
    const reasoning = openAiReasoningOutputSchema.safeParse(item);
    if (!reasoning.success) {
      return [];
    }
    const encryptedContent = reasoning.data.encrypted_content;

    return [
      {
        type: "reasoning",
        ...(reasoning.data.id !== undefined ? { id: reasoning.data.id } : {}),
        ...(typeof encryptedContent === "string" ? { encrypted_content: encryptedContent } : {}),
      },
    ];
  });

  return {
    responseId: parsed.success ? (parsed.data.id ?? null) : null,
    toolCalls,
    replayItems,
  };
}

function resolveOpenAiApiKey(): string {
  const apiKey = openAIClientApiKey();
  if (apiKey === undefined || apiKey === "") {
    throw new Error(ORCHESTRATOR_MESSAGES.openAiKeyRequired);
  }

  return apiKey;
}

function logExtractionInfo(input: { bindings: Record<string, unknown>; message: string }) {
  console.error(
    JSON.stringify({
      level: "info",
      component: "meeting-extraction",
      message: input.message,
      ...Object.fromEntries(Object.entries(input.bindings).filter(([key]) => key !== "error" && key !== "rawInput")),
    }),
  );
}

function logExtractionWarn(input: { bindings: Record<string, unknown>; message: string }) {
  console.error(
    JSON.stringify({
      level: "warn",
      component: "meeting-extraction",
      message: input.message,
      ...Object.fromEntries(Object.entries(input.bindings).filter(([key]) => key !== "error" && key !== "rawInput")),
    }),
  );
}

async function timeoutPromise<T>(input: { timeoutMs: number; label: string }): Promise<T> {
  return new Promise((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(ORCHESTRATOR_MESSAGES.timedOut({ label: input.label, timeoutMs: input.timeoutMs })));
    }, input.timeoutMs);
    timeoutId.unref();
  });
}

function buildToolCallOutput(result: { isOk: boolean; message: string }): Record<string, unknown> {
  const isSuccess = result.isOk;
  if (isSuccess) {
    return {
      /** @external OpenAI tool output wire field. */
      ok: true,
      message: result.message,
    };
  }

  return {
    /** @external OpenAI tool output wire field. */
    ok: false,
    error: result.message,
  };
}

function buildToolCallFailureOutput(message: string): Record<string, unknown> {
  return {
    /** @external OpenAI tool output wire field. */
    ok: false,
    error: message,
  };
}

const extractionToolArgumentsSchema = z.record(z.string(), z.unknown());

function parseToolArgumentsText(argumentsText: string): unknown {
  const trimmed = argumentsText.trim();

  return extractionToolArgumentsSchema.parse(JSON.parse(trimmed === "" ? "{}" : trimmed));
}

type ExtractionTurnState = {
  input: ExtractionConversationItem[];
};

function toolOutputItems(outputs: { callId: string; output: Record<string, unknown> }[]): ExtractionConversationItem[] {
  return outputs.map((toolOutput) => ({
    type: "function_call_output" as const,
    call_id: toolOutput.callId,
    output: JSON.stringify(toolOutput.output),
  }));
}

function nextExtractionTurnState(input: {
  turnState: ExtractionTurnState;
  response: ExtractionModelTurnResponse;
  toolOutputs: { callId: string; output: Record<string, unknown> }[];
}): ExtractionTurnState {
  return {
    input: [...input.turnState.input, ...input.response.replayItems, ...toolOutputItems(input.toolOutputs)],
  };
}

function failedToolCallsWithEntry(input: {
  failedToolCalls: ToolApplicationState["failedToolCalls"];
  entry: { toolName: string; rawInput: unknown; error: string; occurredAt: string };
}): ToolApplicationState["failedToolCalls"] {
  return [...input.failedToolCalls, input.entry];
}

function mapToolCallOutputs(params: {
  state: ToolApplicationState;
  toolCalls: { callId: string; name: string; argumentsText: string }[];
  transcriptLines: TranscriptLineReference[];
}): { callId: string; output: Record<string, unknown> }[] {
  const { state, toolCalls, transcriptLines } = params;

  return toolCalls.map((toolCall) => {
    try {
      const rawArguments = parseToolArgumentsText(toolCall.argumentsText);
      const result = applyToolCall({
        state,
        toolName: toolCall.name,
        rawInput: rawArguments,
        transcriptLines,
      });

      return {
        callId: toolCall.callId,
        output: buildToolCallOutput({ isOk: result.ok, message: result.message }),
      };
    } catch (error) {
      const message =
        error instanceof SyntaxError || error instanceof z.ZodError
          ? ORCHESTRATOR_MESSAGES.toolArgumentsInvalidJson
          : error instanceof Error
            ? error.message
            : ORCHESTRATOR_MESSAGES.toolArgumentsInvalidJson;
      state.failedToolCalls = failedToolCallsWithEntry({
        failedToolCalls: state.failedToolCalls,
        entry: {
          toolName: toolCall.name,
          rawInput: toolCall.argumentsText,
          error: message,
          occurredAt: new Date().toISOString(),
        },
      });

      return { callId: toolCall.callId, output: buildToolCallFailureOutput(message) };
    }
  });
}

type MeetingExtractionMetadata = {
  title?: string | null;
  participants?: {
    userId?: string | null;
    name: string;
    email?: string | null;
    roleHint?: string | null;
  }[];
  startedAt?: string | null;
  durationMs?: number | null;
};

function normalizeParticipantKey(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function deriveParticipants(input: {
  metadata: MeetingExtractionMetadata;
  transcript: RunExtractionInput["transcript"];
}): ExtractedParticipant[] {
  const fromMetadata = (input.metadata.participants ?? []).reduce((byKey, participant) => {
    const normalizedName = participant.name.trim().replace(/\s+/g, " ");
    if (normalizedName === "") {
      return byKey;
    }

    return new Map(byKey).set(normalizeParticipantKey(normalizedName), {
      name: normalizedName,
      roleHint: (() => {
        const roleHint = participant.roleHint?.trim() ?? "";

        return roleHint !== "" ? roleHint : null;
      })(),
      confidence: "high",
    });
  }, new Map<string, ExtractedParticipant>());

  const byKey = input.transcript.reduce((participantsByKey, segment) => {
    const normalizedName = segment.speakerName.trim().replace(/\s+/g, " ");
    if (normalizedName === "") {
      return participantsByKey;
    }

    const key = normalizeParticipantKey(normalizedName);
    if (participantsByKey.has(key)) {
      return participantsByKey;
    }

    return new Map(participantsByKey).set(key, {
      name: normalizedName,
      roleHint: null,
      confidence: "medium",
    });
  }, fromMetadata);

  return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export type RunExtractionInput = {
  liveSummary?: MeetingTrackerState;
  meetingId: string;
  voiceSearchIdentityEvidence?: VoiceSearchIdentityEvidence[];
  transcript: {
    id: string;
    speakerIdentity: string;
    speakerName: string;
    speakerRole?: "human" | "assistant" | "system";
    content: string;
    startedAt: string;
    endedAt: string | null;
  }[];
  metadata: MeetingExtractionMetadata;
  promptVersion?: string;
};

type ExtractionModelToolCall = {
  callId: string;
  name: string;
  argumentsText: string;
};

type ExtractionModelTurnResponse = {
  responseId: string | null;
  toolCalls: ExtractionModelToolCall[];
  replayItems: ExtractionConversationItem[];
};

export interface MeetingExtractionModelRunner {
  createTurn(input: {
    model: string;
    tools: OpenAIFunctionTool[];
    input: ExtractionConversationItem[];
    meetingId?: string | null;
    operation?: string | null;
  }): Promise<ExtractionModelTurnResponse>;
}

interface MeetingExtractionContentRunner {
  createContent(input: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    meetingId?: string | null;
    operation?: string | null;
  }): Promise<string>;
}

class OpenAIMeetingExtractionModelRunner implements MeetingExtractionModelRunner {
  private readonly client: OpenAIClient;

  constructor(apiKey: string) {
    this.client = createOpenAIClient({ apiKey });
  }

  async createTurn(input: {
    model: string;
    tools: OpenAIFunctionTool[];
    input: ExtractionConversationItem[];
    meetingId?: string | null;
    operation?: string | null;
  }): Promise<ExtractionModelTurnResponse> {
    const response = await withOpenAIRetry({
      operation: () =>
        executeMeteredOpenAIResponse({
          client: this.client,
          body: {
            model: input.model,
            ...openAIPromptCacheOptions(input.model),
            tools: input.tools,
            tool_choice: "required",
            /** @external OpenAI parallel tool calls flag */
            parallel_tool_calls: false,
            input: input.input,
          },
          meetingId: input.meetingId,
          source: "meeting_extraction",
          operation: input.operation ?? "extract_meeting_content",
        }),
    });

    return parseExtractionModelTurnResponse(response);
  }
}

class OpenAIMeetingExtractionContentRunner implements MeetingExtractionContentRunner {
  private readonly client: OpenAIClient;

  constructor(apiKey: string) {
    this.client = createOpenAIClient({ apiKey });
  }

  async createContent(input: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    meetingId?: string | null;
    operation?: string | null;
  }): Promise<string> {
    const response = await withOpenAIRetry({
      operation: () =>
        executeMeteredOpenAIResponse({
          client: this.client,
          body: {
            model: input.model,
            ...openAIPromptCacheOptions(input.model),
            input: [
              {
                role: "system",
                content: input.systemPrompt,
              },
              {
                role: "user",
                content: input.userMessage,
              },
            ],
          },
          meetingId: input.meetingId,
          source: "meeting_extraction",
          operation: input.operation ?? "extract_meeting_content",
        }),
    });

    return parseResponseText(response);
  }
}

function formatRelativeTimestamp(input: { isoValue: string | null; baseMs: number }) {
  if (input.isoValue === null || input.isoValue === "") {
    return "--:--";
  }

  const timestampMs = new Date(input.isoValue).getTime();
  const deltaMs = Math.max(0, timestampMs - input.baseMs);
  const totalSeconds = Math.floor(deltaMs / RELATIVE_TIMESTAMP_MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / RELATIVE_TIMESTAMP_SECONDS_PER_MINUTE);
  const seconds = totalSeconds % RELATIVE_TIMESTAMP_SECONDS_PER_MINUTE;

  return `${String(minutes).padStart(RELATIVE_TIMESTAMP_PAD_WIDTH, "0")}:${String(seconds).padStart(RELATIVE_TIMESTAMP_PAD_WIDTH, "0")}`;
}

function createTranscriptLines(transcript: RunExtractionInput["transcript"]): TranscriptLineReference[] {
  const sortedSegments = [...transcript].sort((left, right) => {
    const startedAtDelta = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
    if (startedAtDelta !== 0) {
      return startedAtDelta;
    }

    return left.id.localeCompare(right.id);
  });

  return sortedSegments.map((segment, index) => ({
    lineNumber: index + 1,
    segmentId: segment.id,
    speakerName: segment.speakerName,
    content: segment.content,
    startedAt: segment.startedAt,
    endedAt: segment.endedAt,
  }));
}

function buildTranscriptHash(transcript: RunExtractionInput["transcript"]) {
  const normalizedTranscript = transcript
    .map((segment) => ({
      id: segment.id,
      speakerIdentity: segment.speakerIdentity,
      speakerName: segment.speakerName,
      content: segment.content,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return createHash("sha256").update(JSON.stringify(normalizedTranscript)).digest("hex");
}

function buildUserMessage(input: { metadata: MeetingExtractionMetadata; transcriptLines: TranscriptLineReference[] }) {
  const { metadata, transcriptLines } = input;
  const firstTranscriptLine = transcriptLines.at(0);
  const baseMs = firstTranscriptLine !== undefined ? new Date(firstTranscriptLine.startedAt).getTime() : Date.now();
  const participants =
    metadata.participants !== undefined && metadata.participants.length !== 0
      ? metadata.participants
          .map((participant) => {
            const roleHint = participant.roleHint?.trim() ?? "";

            return roleHint !== "" ? `- ${participant.name} (${roleHint})` : `- ${participant.name}`;
          })
          .join("\n")
      : "- Unknown";

  const transcriptText = transcriptLines
    .map((line) => {
      const started = formatRelativeTimestamp({ isoValue: line.startedAt, baseMs });
      const ended = formatRelativeTimestamp({ isoValue: line.endedAt, baseMs });

      return `L${String(line.lineNumber).padStart(TRANSCRIPT_LINE_NUMBER_PAD_WIDTH, "0")} | ${started}-${ended} | ${line.speakerName}: ${line.content}`;
    })
    .join("\n");

  const titleTrimmed = metadata.title?.trim() ?? "";

  return [
    `Meeting title: ${titleTrimmed !== "" ? titleTrimmed : ORCHESTRATOR_MESSAGES.untitledMeeting}`,
    `Known participants:\n${participants}`,
    `Start time: ${metadata.startedAt ?? "Unknown"}`,
    `Duration (ms): ${metadata.durationMs ?? "Unknown"}`,
    "",
    "Transcript:",
    transcriptText,
  ].join("\n");
}

function determineFinalStatus(input: { isFinished: boolean; failedToolCallCount: number }) {
  if (!input.isFinished) {
    return "failed" as const;
  }

  return input.failedToolCallCount > 0 ? ("partial" as const) : ("completed" as const);
}

function determineContentStatus(extraction: MeetingExtraction) {
  return hasUnverifiedSourceSpans(extraction) ? ("partial" as const) : ("completed" as const);
}

function enrichModelSignals(input: { signals: MeetingExtraction["signals"]; model: string; promptVersion: string }) {
  return input.signals.map((signal) => ({
    ...signal,
    namespace: signal.namespace ?? "readymeet.core",
    evidence: signal.evidence ?? sourceSpansToSignalEvidence(signal.sourceSpans),
    entities: signal.entities ?? {},
    sourcePhase: signal.sourcePhase ?? "signal_extraction",
    origin: {
      ...signal.origin,
      kind: signal.origin?.kind ?? "core_model",
      model: input.model,
      promptVersion: input.promptVersion,
    },
    createdAt: signal.createdAt ?? new Date().toISOString(),
  }));
}

function buildSignalUserMessage(input: {
  metadata: MeetingExtractionMetadata;
  transcriptLines: TranscriptLineReference[];
  contentExtraction: MeetingExtraction;
}) {
  return [
    buildUserMessage({
      metadata: input.metadata,
      transcriptLines: input.transcriptLines,
    }),
    "",
    "Validated human-readable extraction:",
    JSON.stringify(
      {
        meetingType: input.contentExtraction.meetingType,
        meetingTypeConfidence: input.contentExtraction.meetingTypeConfidence,
        meetingTypeReasoning: input.contentExtraction.meetingTypeReasoning,
        participants: input.contentExtraction.participants,
        summaryShort: input.contentExtraction.summaryShort,
        summaryBullets: input.contentExtraction.summaryBullets,
        highlights: input.contentExtraction.highlights,
        decisions: input.contentExtraction.decisions,
        openQuestions: input.contentExtraction.openQuestions,
        keyTopics: input.contentExtraction.keyTopics,
      },
      null,
      SIGNAL_USER_MESSAGE_JSON_INDENT,
    ),
  ].join("\n");
}

export async function runContentExtraction(params: {
  input: RunExtractionInput;
  contentRunner?: MeetingExtractionContentRunner;
  model?: string;
}): Promise<MeetingExtraction> {
  const meetingKey = params.input.meetingId;
  const existingInFlight = inFlightContentExtractions.get(meetingKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const promise = runContentExtractionInternal(params);
  inFlightContentExtractions.set(meetingKey, promise);
  try {
    return await promise;
  } finally {
    inFlightContentExtractions.delete(meetingKey);
  }
}

function isReusableContentExtraction(input: {
  existing: MeetingExtraction | null;
  transcriptHash: string;
  promptVersion: string;
}) {
  const { existing, transcriptHash, promptVersion } = input;

  return (
    existing !== null &&
    existing.transcriptHash === transcriptHash &&
    existing.extractionPromptVersion === promptVersion &&
    (existing.contentStatus === "completed" || existing.contentStatus === "partial")
  );
}

async function persistValidatedContentExtraction(input: {
  meetingId: string;
  validated: MeetingExtraction;
  contentStatus: MeetingExtraction["contentStatus"];
  extractionModel: string;
  promptVersion: string;
  transcriptHash: string;
  startedAt: Date;
  completedAt: Date;
}) {
  const {
    meetingId,
    validated,
    contentStatus,
    extractionModel,
    promptVersion,
    transcriptHash,
    startedAt,
    completedAt,
  } = input;

  return repositories().upsertMeetingExtraction({
    meetingId,
    status: "running",
    contentStatus,
    signalsStatus: "pending",
    meetingType: validated.meetingType,
    meetingTypeConfidence: validated.meetingTypeConfidence,
    meetingTypeReasoning: validated.meetingTypeReasoning,
    participants: validated.participants,
    summaryShort: validated.summaryShort,
    summaryBullets: validated.summaryBullets,
    decisions: validated.decisions,
    actionItems: [],
    openQuestions: validated.openQuestions,
    risks: [],
    highlights: validated.highlights,
    keyTopics: validated.keyTopics,
    signals: [],
    failedToolCalls: [],
    extractionModel,
    extractionPromptVersion: promptVersion,
    transcriptHash,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    startedAt,
    completedAt,
  });
}

async function persistFailedContentExtraction(input: {
  meetingId: string;
  derivedParticipants: ExtractedParticipant[];
  message: string;
  extractionModel: string;
  promptVersion: string;
  transcriptHash: string;
  startedAt: Date;
  completedAt: Date;
}) {
  const {
    meetingId,
    derivedParticipants,
    message,
    extractionModel,
    promptVersion,
    transcriptHash,
    startedAt,
    completedAt,
  } = input;

  return repositories().upsertMeetingExtraction({
    meetingId,
    status: "failed",
    contentStatus: "failed",
    signalsStatus: "pending",
    participants: derivedParticipants,
    failedToolCalls: [
      {
        toolName: "run_content_extraction",
        rawInput: null,
        error: message,
        occurredAt: completedAt.toISOString(),
      },
    ],
    extractionModel,
    extractionPromptVersion: promptVersion,
    transcriptHash,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    startedAt,
    completedAt,
  });
}

async function executeHumanReadableContentPipeline(input: {
  meetingId: string;
  extractionId: string;
  contentRunner: MeetingExtractionContentRunner;
  extractionModel: string;
  promptVersion: string;
  transcriptHash: string;
  metadata: MeetingExtractionMetadata;
  transcriptLines: TranscriptLineReference[];
  derivedParticipants: ExtractedParticipant[];
  startedAt: Date;
  initialCreatedAt: string;
}) {
  logExtractionInfo({
    bindings: {
      meetingId: input.meetingId,
      extractionId: input.extractionId,
      model: input.extractionModel,
      transcriptSegmentCount: input.transcriptLines.length,
    },
    message: ORCHESTRATOR_MESSAGES.contentExtractionStarted,
  });
  const rawText = await Promise.race([
    input.contentRunner.createContent({
      model: input.extractionModel,
      systemPrompt: buildHumanReadableExtractionSystemPrompt(),
      userMessage: buildUserMessage({
        metadata: input.metadata,
        transcriptLines: input.transcriptLines,
      }),
      meetingId: input.meetingId,
      operation: "extract_human_readable_content",
    }),
    timeoutPromise<string>({
      timeoutMs: assistantEnv().OPENAI_MEETING_EXTRACTION_TIMEOUT_MS,
      label: "Meeting content extraction",
    }),
  ]);
  logExtractionInfo({
    bindings: {
      meetingId: input.meetingId,
      extractionId: input.extractionId,
      rawTextLength: rawText.length,
    },
    message: ORCHESTRATOR_MESSAGES.contentExtractionCompleted,
  });
  const completedAt = new Date();
  const validated = validateHumanReadableExtraction({
    rawText,
    transcriptLines: input.transcriptLines,
    id: input.extractionId,
    meetingId: input.meetingId,
    participants: input.derivedParticipants,
    status: "completed",
    extractionModel: input.extractionModel,
    extractionPromptVersion: input.promptVersion,
    transcriptHash: input.transcriptHash,
    durationMs: completedAt.getTime() - input.startedAt.getTime(),
    startedAt: input.startedAt,
    completedAt,
    createdAt: new Date(input.initialCreatedAt),
    updatedAt: completedAt,
  });
  const contentStatus = determineContentStatus(validated);
  logExtractionInfo({
    bindings: {
      meetingId: input.meetingId,
      extractionId: input.extractionId,
      contentStatus,
      decisionCount: validated.decisions.length,
      durationMs: completedAt.getTime() - input.startedAt.getTime(),
    },
    message: ORCHESTRATOR_MESSAGES.contentExtractionPersisted,
  });

  return persistValidatedContentExtraction({
    meetingId: input.meetingId,
    validated,
    contentStatus,
    extractionModel: input.extractionModel,
    promptVersion: input.promptVersion,
    transcriptHash: input.transcriptHash,
    startedAt: input.startedAt,
    completedAt,
  });
}

async function runContentExtractionInternal(params: {
  input: RunExtractionInput;
  contentRunner?: MeetingExtractionContentRunner;
  model?: string;
}): Promise<MeetingExtraction> {
  const { input } = params;
  const promptVersion = input.promptVersion ?? MEETING_EXTRACTION_PROMPT_VERSION;
  const transcriptHash = buildTranscriptHash(input.transcript);
  const extractionModel = params.model ?? assistantEnv().OPENAI_MEETING_EXTRACTION_MODEL;
  const existing = await repositories().getExtractionByMeetingId(input.meetingId);

  if (existing !== null && isReusableContentExtraction({ existing, transcriptHash, promptVersion })) {
    return existing;
  }

  const apiKey = openAIClientApiKey();
  if ((apiKey === undefined || apiKey === "") && params.contentRunner === undefined) {
    throw new Error(ORCHESTRATOR_MESSAGES.openAiKeyRequired);
  }

  const transcriptLines = createTranscriptLines(input.transcript);
  if (transcriptLines.length === 0) {
    throw new Error(ORCHESTRATOR_MESSAGES.transcriptRequired);
  }

  const contentRunner = params.contentRunner ?? new OpenAIMeetingExtractionContentRunner(resolveOpenAiApiKey());
  const startedAt = new Date();
  const initial = await repositories().upsertMeetingExtraction({
    meetingId: input.meetingId,
    status: "running",
    contentStatus: "running",
    signalsStatus: "pending",
    extractionModel,
    extractionPromptVersion: promptVersion,
    transcriptHash,
    startedAt,
    completedAt: null,
  });

  const derivedParticipants = deriveParticipants({
    metadata: input.metadata,
    transcript: input.transcript,
  });

  try {
    return await executeHumanReadableContentPipeline({
      meetingId: input.meetingId,
      extractionId: initial.id,
      contentRunner,
      extractionModel,
      promptVersion,
      transcriptHash,
      metadata: input.metadata,
      transcriptLines,
      derivedParticipants,
      startedAt,
      initialCreatedAt: initial.createdAt,
    });
  } catch (error) {
    const completedAt = new Date();
    const message = error instanceof Error ? error.message : ORCHESTRATOR_MESSAGES.meetingContentExtractionFailed;
    logExtractionWarn({
      bindings: {
        meetingId: input.meetingId,
        extractionId: initial.id,
        error: message,
      },
      message: ORCHESTRATOR_MESSAGES.contentExtractionFailed,
    });

    return persistFailedContentExtraction({
      meetingId: input.meetingId,
      derivedParticipants,
      message,
      extractionModel,
      promptVersion,
      transcriptHash,
      startedAt,
      completedAt,
    });
  }
}

export async function runSignalExtraction(params: {
  input: RunExtractionInput;
  modelRunner?: MeetingExtractionModelRunner;
  model?: string;
  maxTurns?: number;
}): Promise<MeetingExtraction> {
  const meetingKey = params.input.meetingId;
  const existingInFlight = inFlightSignalExtractions.get(meetingKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const promise = runSignalExtractionInternal(params);
  inFlightSignalExtractions.set(meetingKey, promise);
  try {
    return await promise;
  } finally {
    inFlightSignalExtractions.delete(meetingKey);
  }
}

type ExtractionTurnSignal = ToolApplicationState["signals"][number];

function partitionSignalsWithVerifiedSpans(input: {
  signals: ExtractionTurnSignal[];
  failedToolCalls: ToolApplicationState["failedToolCalls"];
  occurredAt: string;
}) {
  return input.signals.reduce(
    (accumulator, signal) => {
      const hasUnverifiedSpan = signal.sourceSpans.some((span) => span.verificationStatus === "unverified");
      if (hasUnverifiedSpan) {
        return {
          signals: accumulator.signals,
          failedToolCalls: failedToolCallsWithEntry({
            failedToolCalls: accumulator.failedToolCalls,
            entry: {
              toolName: "register_signal",
              rawInput: signal,
              error: ORCHESTRATOR_MESSAGES.signalDroppedUnverified(signal.key),
              occurredAt: input.occurredAt,
            },
          }),
        };
      }

      return {
        signals: [...accumulator.signals, signal],
        failedToolCalls: accumulator.failedToolCalls,
      };
    },
    { signals: [] as ExtractionTurnSignal[], failedToolCalls: input.failedToolCalls },
  );
}

function buildFinalSignalBundle(input: {
  existing: MeetingExtraction;
  verifiedSignals: ExtractionTurnSignal[];
  extractionModel: string;
  promptVersion: string;
}) {
  const enrichedSignals = enrichModelSignals({
    signals: input.verifiedSignals,
    model: input.extractionModel,
    promptVersion: input.promptVersion,
  });
  const inferredSignals = inferSignalsFromValidatedContent({
    ...input.existing,
    signals: enrichedSignals,
  });
  const finalSignals = [...enrichedSignals, ...inferredSignals];

  return { inferredSignals, finalSignals };
}

async function executeSignalExtractionTurns(input: {
  extractionInput: RunExtractionInput;
  existing: MeetingExtraction;
  modelRunner: MeetingExtractionModelRunner;
  extractionModel: string;
  maxTurns: number;
  transcriptLines: TranscriptLineReference[];
  state: ToolApplicationState;
}) {
  const tools = buildMeetingExtractionTools().filter(
    (tool) => tool.name === "register_signal" || tool.name === "finish_extraction",
  );
  const runTurn = async (turnRequest: { turn: number; turnState: ExtractionTurnState }): Promise<void> => {
    const { turn, turnState } = turnRequest;
    if (turn >= input.maxTurns) {
      if (!input.state.finished) {
        throw new Error(ORCHESTRATOR_MESSAGES.signalMaxTurnsExceeded(input.maxTurns));
      }

      return;
    }

    logExtractionInfo({
      bindings: {
        meetingId: input.extractionInput.meetingId,
        extractionId: input.existing.id,
        turn: turn + 1,
        maxTurns: input.maxTurns,
        signalCount: input.state.signals.length,
        failedToolCallCount: input.state.failedToolCalls.length,
      },
      message: ORCHESTRATOR_MESSAGES.signalTurnStarted,
    });
    const response = await input.modelRunner.createTurn({
      model: input.extractionModel,
      tools,
      input: turnState.input,
      meetingId: input.extractionInput.meetingId,
      operation: "extract_meeting_signals",
    });

    const nextTurnState = nextExtractionTurnState({
      turnState,
      response,
      toolOutputs: mapToolCallOutputs({
        state: input.state,
        toolCalls: response.toolCalls,
        transcriptLines: input.transcriptLines,
      }),
    });
    logExtractionInfo({
      bindings: {
        meetingId: input.extractionInput.meetingId,
        extractionId: input.existing.id,
        turn: turn + 1,
        responseId: response.responseId,
        toolCallCount: response.toolCalls.length,
        toolNames: response.toolCalls.map((toolCall) => toolCall.name),
      },
      message: ORCHESTRATOR_MESSAGES.signalTurnCompleted,
    });
    if (response.toolCalls.length === 0) {
      throw new Error(ORCHESTRATOR_MESSAGES.signalNoToolCalls);
    }

    if (input.state.finished) {
      return;
    }

    await runTurn({ turn: turn + 1, turnState: nextTurnState });
  };

  await runTurn({
    turn: 0,
    turnState: {
      input: [
        { role: "system", content: buildSignalExtractionSystemPrompt() },
        {
          role: "user",
          content: buildSignalUserMessage({
            metadata: input.extractionInput.metadata,
            transcriptLines: input.transcriptLines,
            contentExtraction: input.existing,
          }),
        },
      ],
    },
  });
}

async function persistSuccessfulSignalExtraction(input: {
  existing: MeetingExtraction;
  runInput: RunExtractionInput;
  state: ToolApplicationState;
  extractionModel: string;
  promptVersion: string;
  startedAt: Date;
  completedAt: Date;
}) {
  const partitioned = partitionSignalsWithVerifiedSpans({
    signals: input.state.signals,
    failedToolCalls: input.state.failedToolCalls,
    occurredAt: input.completedAt.toISOString(),
  });
  const { inferredSignals, finalSignals } = buildFinalSignalBundle({
    existing: input.existing,
    verifiedSignals: partitioned.signals,
    extractionModel: input.extractionModel,
    promptVersion: input.promptVersion,
  });
  const signalsStatus = determineFinalStatus({
    isFinished: input.state.finished,
    failedToolCallCount: partitioned.failedToolCalls.length,
  });
  logExtractionInfo({
    bindings: {
      meetingId: input.runInput.meetingId,
      extractionId: input.existing.id,
      signalsStatus,
      signalCount: finalSignals.length,
      inferredSignalCount: inferredSignals.length,
      inferredSignalKeys: inferredSignals.map((signal) => signal.key),
      failedToolCallCount: partitioned.failedToolCalls.length,
      durationMs: input.completedAt.getTime() - input.startedAt.getTime(),
    },
    message: ORCHESTRATOR_MESSAGES.signalExtractionPersisted,
  });

  return repositories().upsertMeetingExtraction({
    ...input.existing,
    status: signalsStatus,
    contentStatus: input.existing.contentStatus,
    signalsStatus,
    signals: finalSignals,
    failedToolCalls: [...input.existing.failedToolCalls, ...partitioned.failedToolCalls],
    extractionModel: input.extractionModel,
    extractionPromptVersion: input.promptVersion,
    transcriptHash: input.existing.transcriptHash,
    durationMs: (input.existing.durationMs ?? 0) + (input.completedAt.getTime() - input.startedAt.getTime()),
    startedAt: input.existing.startedAt !== null ? new Date(input.existing.startedAt) : input.startedAt,
    completedAt: input.completedAt,
  });
}

async function persistFailedSignalExtraction(input: {
  existing: MeetingExtraction;
  runInput: RunExtractionInput;
  state: ToolApplicationState;
  extractionModel: string;
  promptVersion: string;
  startedAt: Date;
  completedAt: Date;
  error: unknown;
}) {
  const message =
    input.error instanceof Error ? input.error.message : ORCHESTRATOR_MESSAGES.meetingSignalExtractionFailed;
  const partitioned = partitionSignalsWithVerifiedSpans({
    signals: input.state.signals,
    failedToolCalls: input.state.failedToolCalls,
    occurredAt: input.completedAt.toISOString(),
  });
  const { inferredSignals, finalSignals } = buildFinalSignalBundle({
    existing: input.existing,
    verifiedSignals: partitioned.signals,
    extractionModel: input.extractionModel,
    promptVersion: input.promptVersion,
  });
  const signalsStatus = finalSignals.length !== 0 ? "partial" : "failed";
  const failedToolCalls = [
    ...partitioned.failedToolCalls,
    {
      toolName: "run_signal_extraction",
      rawInput: null,
      error: message,
      occurredAt: input.completedAt.toISOString(),
    },
  ];

  logExtractionWarn({
    bindings: {
      meetingId: input.runInput.meetingId,
      extractionId: input.existing.id,
      error: message,
      signalsStatus,
      signalCount: finalSignals.length,
      inferredSignalCount: inferredSignals.length,
      inferredSignalKeys: inferredSignals.map((signal) => signal.key),
      failedToolCallCount: failedToolCalls.length,
    },
    message: ORCHESTRATOR_MESSAGES.signalExtractionFailed,
  });

  return repositories().upsertMeetingExtraction({
    ...input.existing,
    status: "partial",
    contentStatus: input.existing.contentStatus,
    signalsStatus,
    signals: finalSignals,
    failedToolCalls: [...input.existing.failedToolCalls, ...failedToolCalls],
    extractionModel: input.extractionModel,
    extractionPromptVersion: input.promptVersion,
    transcriptHash: input.existing.transcriptHash,
    durationMs: (input.existing.durationMs ?? 0) + (input.completedAt.getTime() - input.startedAt.getTime()),
    startedAt: input.existing.startedAt !== null ? new Date(input.existing.startedAt) : input.startedAt,
    completedAt: input.completedAt,
  });
}

async function runSignalExtractionInternal(params: {
  input: RunExtractionInput;
  modelRunner?: MeetingExtractionModelRunner;
  model?: string;
  maxTurns?: number;
}) {
  const { input } = params;
  const promptVersion = input.promptVersion ?? MEETING_EXTRACTION_PROMPT_VERSION;
  const extractionModel = params.model ?? assistantEnv().OPENAI_MEETING_EXTRACTION_MODEL;
  const existing = await repositories().getExtractionByMeetingId(input.meetingId);
  if (existing === null || (existing.contentStatus !== "completed" && existing.contentStatus !== "partial")) {
    throw new Error(ORCHESTRATOR_MESSAGES.humanReadableRequired);
  }

  if (existing.signalsStatus === "completed" || existing.signalsStatus === "partial") {
    return existing;
  }

  const apiKey = openAIClientApiKey();
  if ((apiKey === undefined || apiKey === "") && params.modelRunner === undefined) {
    throw new Error(ORCHESTRATOR_MESSAGES.openAiKeyRequiredSignals);
  }

  const transcriptLines = createTranscriptLines(input.transcript);
  const state = createInitialToolState();
  const startedAt = new Date();
  await repositories().upsertMeetingExtraction({
    ...existing,
    status: "running",
    contentStatus: existing.contentStatus,
    signalsStatus: "running",
    extractionModel,
    extractionPromptVersion: promptVersion,
    transcriptHash: existing.transcriptHash,
    startedAt: existing.startedAt !== null ? new Date(existing.startedAt) : startedAt,
    completedAt: null,
  });

  try {
    const modelRunner = params.modelRunner ?? new OpenAIMeetingExtractionModelRunner(resolveOpenAiApiKey());
    const maxTurns = params.maxTurns ?? assistantEnv().MEETING_EXTRACTION_MAX_TURNS;
    await Promise.race([
      executeSignalExtractionTurns({
        extractionInput: input,
        existing,
        modelRunner,
        extractionModel,
        maxTurns,
        transcriptLines,
        state,
      }),
      timeoutPromise<void>({
        timeoutMs: assistantEnv().OPENAI_MEETING_EXTRACTION_TIMEOUT_MS,
        label: "Meeting signal extraction",
      }),
    ]);

    const completedAt = new Date();

    return await persistSuccessfulSignalExtraction({
      existing,
      runInput: input,
      state,
      extractionModel,
      promptVersion,
      startedAt,
      completedAt,
    });
  } catch (error) {
    const completedAt = new Date();

    return persistFailedSignalExtraction({
      existing,
      runInput: input,
      state,
      extractionModel,
      promptVersion,
      startedAt,
      completedAt,
      error,
    });
  }
}
