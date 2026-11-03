import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type {
  CapabilityCatalogRow,
  CapabilityRecommendationRow,
  CapabilityRecommendationView,
  CapabilitySelectionCapability,
  CapabilitySelectionResult,
} from "@readymeet/shared";
import { meetingTaskListSchema, openAIPromptCacheOptions } from "@readymeet/shared";
import { z } from "zod";

import { inferSignalsFromValidatedContent } from "../domain/extraction/signal-inference";
import {
  buildSelectionSystemPrompt,
  buildSelectionUserMessage,
  SELECTION_PROMPT_VERSION,
} from "../domain/selection/prompt-v1";
import { rankCapabilities, type RankedCapability } from "../domain/selection/ranking";
import {
  buildSelectionPayloadTools,
  parseSelectionPayloadToolCall,
  type SelectionPayloadResult,
} from "../domain/selection/tools";
import { assistantEnv } from "../ports/assistant-env";
import { openAIClientApiKey } from "../ports/openai-client";
import {
  createOpenAIClient,
  type OpenAIClient,
  type OpenAIFunctionTool,
  type OpenAIResponseFunctionToolCall,
} from "../ports/openai-client";
import { repositories } from "../ports/repository-runtime";

import { executeMeteredOpenAIResponse } from "./usage-metering";

const SELECTION_MESSAGES = {
  timedOut: (input: { label: string; timeoutMs: number }) => `${input.label} timed out after ${input.timeoutMs}ms`,
  extractionNotFound: (extractionId: string) => `Meeting extraction "${extractionId}" does not exist`,
  signalsIncomplete: (extractionId: string) =>
    `Meeting extraction "${extractionId}" signals must be completed or partial before selection`,
  openAiKeyRequired: "Configured AI provider key is required for capability selection",
  automaticReasoningFailed: "Automatic reasoning generation failed.",
  invalidSelectionPayload: "Invalid selection payload",
  payloadGenerationFailed: "Capability payload generation failed",
  rankingCompleted: "Capability ranking completed",
  reusedExisting: "Capability selection reused existing recommendations",
  deterministicNoSignals:
    "Capability selection continuing with deterministic defaults because extraction had no signals",
  noRecommendations: "Capability selection found no recommended capabilities",
  payloadCallCompleted: "Capability payload generation model call completed",
  skippedInvalidToolCall: "Capability payload generation skipped invalid tool call",
  payloadCallStarted: "Capability payload generation model call started",
  payloadCallFailedFallback: "Capability payload generation failed; using fallback payloads",
  recommendationsPersisted: "Capability recommendations persisted",
} as const;

async function timeoutPromise<T>(input: { timeoutMs: number; label: string }): Promise<T> {
  return new Promise((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(SELECTION_MESSAGES.timedOut({ label: input.label, timeoutMs: input.timeoutMs })));
    }, input.timeoutMs);
    timeoutId.unref();
  });
}

function logSelectionInfo(input: { bindings: Record<string, unknown>; message: string }) {
  console.error(
    JSON.stringify({
      level: "info",
      component: "capability-selection",
      message: input.message,
      ...Object.fromEntries(Object.entries(input.bindings).filter(([key]) => key !== "error" && key !== "rawInput")),
    }),
  );
}

function logSelectionWarn(input: { bindings: Record<string, unknown>; message: string }) {
  console.error(
    JSON.stringify({
      level: "warn",
      component: "capability-selection",
      message: input.message,
      ...Object.fromEntries(Object.entries(input.bindings).filter(([key]) => key !== "error" && key !== "rawInput")),
    }),
  );
}

export type SelectionModelToolCall = {
  name: string;
  argumentsText: string;
};

export interface CapabilitySelectionModelRunner {
  createPayloads(input: {
    model: string;
    tools: OpenAIFunctionTool[];
    systemPrompt: string;
    userMessage: string;
    meetingId?: string | null;
  }): Promise<SelectionModelToolCall[]>;
}

class OpenAICapabilitySelectionModelRunner implements CapabilitySelectionModelRunner {
  private readonly client: OpenAIClient;

  constructor(apiKey: string) {
    this.client = createOpenAIClient({ apiKey });
  }

  async createPayloads(input: {
    model: string;
    tools: OpenAIFunctionTool[];
    systemPrompt: string;
    userMessage: string;
    meetingId?: string | null;
  }): Promise<SelectionModelToolCall[]> {
    const response = await executeMeteredOpenAIResponse({
      client: this.client,
      body: {
        model: input.model,
        ...openAIPromptCacheOptions(input.model),
        tools: input.tools,
        tool_choice: "required",
        /** @external OpenAI parallel tool calls flag */
        parallel_tool_calls: true,
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
      source: "capability_selection",
      operation: "generate_capability_payloads",
    });

    const output = Array.isArray(response.output) ? response.output : [];

    return output
      .filter((item): item is OpenAIResponseFunctionToolCall => item.type === "function_call")
      .map((item) => ({
        name: item.name,
        argumentsText: item.arguments,
      }));
  }
}

function attachCapabilityViews(input: {
  recommendations: CapabilityRecommendationRow[];
  capabilities: CapabilityCatalogRow[];
}): CapabilityRecommendationView[] {
  const { recommendations, capabilities } = input;
  const byKey = new Map(capabilities.map((capability) => [capability.key, capability]));

  return recommendations
    .filter((recommendation) => recommendation.capabilityKey !== "draft_internal_recap")
    .map((recommendation) => {
      const capability = byKey.get(recommendation.capabilityKey);
      if (!capability) {
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

function fallbackPayload(): SelectionPayloadResult {
  return {
    capabilityKey: "",
    reasoning: SELECTION_MESSAGES.automaticReasoningFailed,
    confidence: "low",
    payload: {},
  };
}

function toSelectionCapability(capability: CapabilityCatalogRow): CapabilitySelectionCapability {
  return {
    key: capability.key,
    name: capability.name,
    description: capability.description,
    category: capability.category,
    applicableMeetingTypes: capability.applicableMeetingTypes,
    requiredSignals: capability.requiredSignals,
    exclusionSignals: capability.exclusionSignals,
    defaultPriority: capability.defaultPriority,
  };
}

type RuntimeParticipant = Awaited<ReturnType<RepositoryPort["getMeetingRuntimeState"]>>["allHumanParticipants"][number];

interface DeterministicCapabilityRecommendation {
  capability: CapabilitySelectionCapability;
  rawScore: number;
  finalScore: number;
  signalsMatched: [];
  signalsMissing: [];
  exclusionSignalsChecked: [];
  reasoning: string;
  payload: Record<string, unknown>;
  confidence: "high";
}

function isAlwaysAvailableCapability(capability: CapabilityCatalogRow) {
  return capability.metadata.alwaysAvailable === true;
}

function formatFollowUpButtonLabel(recipients: RuntimeParticipant[]) {
  const [recipient] = recipients;
  if (recipients.length === 1 && recipient !== undefined) {
    return `Draft follow-up for ${recipient.displayName}`;
  }

  return "Draft email follow-up";
}

function deterministicPayload(input: {
  buttonLabel: string;
  recipientUserIds?: string[];
  recipientDisplayNames?: string[];
}): {
  /** @external alwaysAvailable */
  alwaysAvailable: boolean;
  buttonLabel: string;
  recipientUserIds: string[];
  recipientDisplayNames: string[];
  source: string;
} {
  return {
    alwaysAvailable: true,
    buttonLabel: input.buttonLabel,
    recipientUserIds: input.recipientUserIds ?? [],
    recipientDisplayNames: input.recipientDisplayNames ?? [],
    source: "deterministic_default",
  };
}

function buildCoachingRecommendation(input: {
  coaching: CapabilityCatalogRow | undefined;
  selectedCapabilityKeys: Set<string>;
}): DeterministicCapabilityRecommendation[] {
  const { coaching, selectedCapabilityKeys } = input;
  if (coaching === undefined || !isAlwaysAvailableCapability(coaching) || selectedCapabilityKeys.has(coaching.key)) {
    return [];
  }

  return [
    {
      capability: toSelectionCapability(coaching),
      rawScore: coaching.defaultPriority,
      finalScore: coaching.defaultPriority,
      signalsMatched: [],
      signalsMissing: [],
      exclusionSignalsChecked: [],
      reasoning: "Meeting feedback is available for every completed meeting.",
      payload: deterministicPayload({
        buttonLabel: "Review how the meeting went",
      }),
      confidence: "high",
    },
  ];
}

async function buildFollowUpRecommendation(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  followUp: CapabilityCatalogRow | undefined;
  selectedCapabilityKeys: Set<string>;
}): Promise<DeterministicCapabilityRecommendation[]> {
  const { meeting, followUp, selectedCapabilityKeys } = input;
  if (
    followUp === undefined ||
    !isAlwaysAvailableCapability(followUp) ||
    selectedCapabilityKeys.has(followUp.key) ||
    selectedCapabilityKeys.has("draft_external_follow_up")
  ) {
    return [];
  }

  const runtimeState = await repositories().getMeetingRuntimeState(meeting.id);
  const recipients = runtimeState.allHumanParticipants.filter(
    (participant) => participant.userId !== meeting.createdByUserId,
  );
  if (recipients.length === 0) {
    return [];
  }

  return [
    {
      capability: toSelectionCapability(followUp),
      rawScore: followUp.defaultPriority,
      finalScore: followUp.defaultPriority,
      signalsMatched: [],
      signalsMissing: [],
      exclusionSignalsChecked: [],
      reasoning: "A participant follow-up draft is available because other people attended the meeting.",
      payload: deterministicPayload({
        buttonLabel: formatFollowUpButtonLabel(recipients),
        recipientUserIds: recipients.map((participant) => participant.userId),
        recipientDisplayNames: recipients.map((participant) => participant.displayName),
      }),
      confidence: "high",
    },
  ];
}

async function buildAlwaysAvailableRecommendations(input: {
  meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
  capabilities: CapabilityCatalogRow[];
  selectedCapabilityKeys: Set<string>;
}): Promise<DeterministicCapabilityRecommendation[]> {
  const capabilitiesByKey = new Map(input.capabilities.map((capability) => [capability.key, capability]));
  const coachingRecommendations = buildCoachingRecommendation({
    coaching: capabilitiesByKey.get("meeting_coaching"),
    selectedCapabilityKeys: input.selectedCapabilityKeys,
  });
  const followUpRecommendations = await buildFollowUpRecommendation({
    meeting: input.meeting,
    followUp: capabilitiesByKey.get("draft_participant_follow_up"),
    selectedCapabilityKeys: input.selectedCapabilityKeys,
  });

  return [...coachingRecommendations, ...followUpRecommendations];
}

async function generatePayloads(input: {
  selected: RankedCapability[];
  systemPrompt: string;
  userMessage: string;
  model: string;
  modelRunner: CapabilitySelectionModelRunner;
  meetingId?: string | null;
}) {
  const tools = buildSelectionPayloadTools(input.selected.map((selection) => selection.capability));
  if (tools.length === 0) {
    return new Map<string, SelectionPayloadResult>();
  }

  const toolCalls = await Promise.race([
    input.modelRunner.createPayloads({
      model: input.model,
      tools,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      meetingId: input.meetingId,
    }),
    timeoutPromise<SelectionModelToolCall[]>({
      timeoutMs: assistantEnv().OPENAI_CAPABILITY_SELECTION_TIMEOUT_MS,
      label: "Capability selection",
    }),
  ]);
  logSelectionInfo({
    bindings: {
      selectedCapabilityCount: input.selected.length,
      toolCallCount: toolCalls.length,
      toolNames: toolCalls.map((toolCall) => toolCall.name),
    },
    message: SELECTION_MESSAGES.payloadCallCompleted,
  });

  const selectionToolArgumentsSchema = z.record(z.string(), z.unknown());

  return toolCalls.reduce<Map<string, SelectionPayloadResult>>((payloadsByCapability, toolCall) => {
    try {
      const argumentsText = toolCall.argumentsText.length > 0 ? toolCall.argumentsText : "{}";
      const rawInput = selectionToolArgumentsSchema.parse(JSON.parse(argumentsText));
      const parsed = parseSelectionPayloadToolCall({
        toolName: toolCall.name,
        rawInput,
      });

      if (payloadsByCapability.has(parsed.capabilityKey)) {
        return payloadsByCapability;
      }

      return new Map(payloadsByCapability).set(parsed.capabilityKey, parsed);
    } catch (error) {
      logSelectionWarn({
        bindings: {
          toolName: toolCall.name,
          error: error instanceof Error ? error.message : SELECTION_MESSAGES.invalidSelectionPayload,
        },
        message: SELECTION_MESSAGES.skippedInvalidToolCall,
      });

      return payloadsByCapability;
    }
  }, new Map());
}

type SelectionRankingContext = {
  extraction: NonNullable<Awaited<ReturnType<RepositoryPort["getExtractionById"]>>>;
  extractionForSelection: NonNullable<Awaited<ReturnType<RepositoryPort["getExtractionById"]>>> & {
    signals: NonNullable<Awaited<ReturnType<RepositoryPort["getExtractionById"]>>>["signals"];
  };
  meeting: Awaited<ReturnType<RepositoryPort["getMeetingById"]>>;
  taskContext: ReturnType<typeof meetingTaskListSchema.nullable>["_output"] | null;
  capabilities: CapabilityCatalogRow[];
  connectedIntegrations: string[];
  ranking: ReturnType<typeof rankCapabilities>;
  alwaysAvailableRecommendations: DeterministicCapabilityRecommendation[];
};

async function loadSelectionRankingContext(params: {
  extractionId: string;
  tasks?: unknown;
}): Promise<SelectionRankingContext> {
  const extraction = await repositories().getExtractionById(params.extractionId);
  if (extraction === null) {
    throw new Error(SELECTION_MESSAGES.extractionNotFound(params.extractionId));
  }

  if (extraction.signalsStatus !== "completed" && extraction.signalsStatus !== "partial") {
    throw new Error(SELECTION_MESSAGES.signalsIncomplete(params.extractionId));
  }

  const meeting = await repositories().getMeetingById(extraction.meetingId);
  const taskContext =
    params.tasks === undefined || params.tasks === null ? null : meetingTaskListSchema.nullable().parse(params.tasks);
  const capabilities = meeting ? await repositories().listEnabledCapabilitiesForUser(meeting.createdByUserId) : [];
  const connectedIntegrations = meeting
    ? (await repositories().listAgentConnectorsForUser(meeting.createdByUserId))
        .filter((connector) => connector.status === "connected")
        .map((connector) => connector.provider)
    : [];
  const inferredSignals = inferSignalsFromValidatedContent(extraction);
  const extractionForSelection =
    inferredSignals.length !== 0
      ? {
          ...extraction,
          signals: [...extraction.signals, ...inferredSignals],
        }
      : extraction;
  const ranking = rankCapabilities({ extraction: extractionForSelection, capabilities });
  logSelectionInfo({
    bindings: {
      extractionId: params.extractionId,
      meetingId: extraction.meetingId,
      signalCount: extractionForSelection.signals.length,
      persistedSignalCount: extraction.signals.length,
      inferredSignalCount: inferredSignals.length,
      inferredSignalKeys: inferredSignals.map((signal) => signal.key),
      activeCapabilityCount: capabilities.length,
      recommendedCount: ranking.recommended.length,
      consideredCount: ranking.considered.length,
    },
    message: SELECTION_MESSAGES.rankingCompleted,
  });
  const alwaysAvailableRecommendations = meeting
    ? await buildAlwaysAvailableRecommendations({
        meeting,
        capabilities,
        selectedCapabilityKeys: new Set(ranking.recommended.map((selection) => selection.capability.key)),
      })
    : [];

  return {
    extraction,
    extractionForSelection,
    meeting,
    taskContext,
    capabilities,
    connectedIntegrations,
    ranking,
    alwaysAvailableRecommendations,
  };
}

async function resolveSelectionPayloads(params: {
  extractionId: string;
  extractionMeetingId: string;
  ranking: ReturnType<typeof rankCapabilities>;
  extractionForSelection: SelectionRankingContext["extractionForSelection"];
  meeting: SelectionRankingContext["meeting"];
  taskContext: SelectionRankingContext["taskContext"];
  connectedIntegrations: string[];
  modelRunner?: CapabilitySelectionModelRunner;
  selectionModel: string;
}): Promise<Map<string, SelectionPayloadResult>> {
  if (params.ranking.recommended.length === 0) {
    return new Map();
  }

  const apiKey = openAIClientApiKey();
  if ((apiKey === undefined || apiKey === "") && params.modelRunner === undefined) {
    throw new Error(SELECTION_MESSAGES.openAiKeyRequired);
  }

  const modelRunner =
    params.modelRunner ?? new OpenAICapabilitySelectionModelRunner(apiKey !== undefined && apiKey !== "" ? apiKey : "");
  const systemPrompt = buildSelectionSystemPrompt();
  const userMessage = buildSelectionUserMessage({
    title: params.meeting?.title ?? null,
    extraction: params.extractionForSelection,
    selected: params.ranking.recommended,
    tasks: params.taskContext,
    connectedIntegrations: params.connectedIntegrations,
  });
  logSelectionInfo({
    bindings: {
      extractionId: params.extractionId,
      model: params.selectionModel,
      selectedCapabilityKeys: params.ranking.recommended.map((selection) => selection.capability.key),
    },
    message: SELECTION_MESSAGES.payloadCallStarted,
  });
  try {
    return await generatePayloads({
      selected: params.ranking.recommended,
      systemPrompt,
      userMessage,
      model: params.selectionModel,
      modelRunner,
      meetingId: params.extractionMeetingId,
    });
  } catch (error) {
    logSelectionWarn({
      bindings: {
        extractionId: params.extractionId,
        error: error instanceof Error ? error.message : SELECTION_MESSAGES.payloadGenerationFailed,
      },
      message: SELECTION_MESSAGES.payloadCallFailedFallback,
    });

    return new Map();
  }
}

async function persistNewCapabilitySelections(params: {
  extractionId: string;
  promptVersion: string;
  selectionModel: string;
  context: SelectionRankingContext;
  selectedRecommendations: (RankedCapability | DeterministicCapabilityRecommendation)[];
  payloadsByCapability: Map<string, SelectionPayloadResult>;
}): Promise<CapabilitySelectionResult> {
  const { context } = params;
  const persisted = await repositories().insertCapabilityRecommendations(
    params.selectedRecommendations.map((selection, index) => {
      const generated =
        "payload" in selection
          ? selection
          : (params.payloadsByCapability.get(selection.capability.key) ?? fallbackPayload());

      return {
        meetingId: context.extraction.meetingId,
        extractionId: context.extraction.id,
        capabilityKey: selection.capability.key,
        rank: index + 1,
        rawScore: selection.rawScore,
        finalScore: selection.finalScore,
        signalsMatched: selection.signalsMatched,
        signalsMissing: selection.signalsMissing,
        exclusionSignalsChecked: selection.exclusionSignalsChecked,
        reasoning: generated.reasoning,
        payload: generated.payload,
        confidence: generated.confidence,
        selectionPromptVersion: params.promptVersion,
        selectionModel: params.selectionModel,
      };
    }),
  );
  logSelectionInfo({
    bindings: {
      extractionId: params.extractionId,
      meetingId: context.extraction.meetingId,
      recommendationCount: persisted.length,
    },
    message: SELECTION_MESSAGES.recommendationsPersisted,
  });

  return {
    recommendations: attachCapabilityViews({ recommendations: persisted, capabilities: context.capabilities }),
    considered: context.ranking.considered,
  };
}

export async function runSelection(params: {
  extractionId: string;
  promptVersion?: string;
  /** @external forceRefresh */
  forceRefresh?: boolean;
  tasks?: unknown;
  modelRunner?: CapabilitySelectionModelRunner;
  model?: string;
}): Promise<CapabilitySelectionResult> {
  const promptVersion = params.promptVersion ?? SELECTION_PROMPT_VERSION;
  const context = await loadSelectionRankingContext({
    extractionId: params.extractionId,
    tasks: params.tasks,
  });

  if (params.forceRefresh === true) {
    await repositories().deleteRecommendationsByExtractionId(params.extractionId, promptVersion);
  }

  const existing =
    params.forceRefresh === true
      ? []
      : await repositories().getRecommendationsByExtractionId(params.extractionId, promptVersion);
  if (existing.length !== 0) {
    logSelectionInfo({
      bindings: {
        extractionId: params.extractionId,
        existingRecommendationCount: existing.length,
      },
      message: SELECTION_MESSAGES.reusedExisting,
    });

    return {
      recommendations: attachCapabilityViews({ recommendations: existing, capabilities: context.capabilities }),
      considered: context.ranking.considered,
    };
  }

  if (context.extractionForSelection.signals.length === 0) {
    logSelectionInfo({
      bindings: {
        extractionId: params.extractionId,
        deterministicRecommendationCount: context.alwaysAvailableRecommendations.length,
        consideredCount: context.ranking.considered.length,
      },
      message: SELECTION_MESSAGES.deterministicNoSignals,
    });
  }

  const selectedRecommendations = [...context.ranking.recommended, ...context.alwaysAvailableRecommendations];
  if (selectedRecommendations.length === 0) {
    logSelectionInfo({
      bindings: {
        extractionId: params.extractionId,
        consideredCount: context.ranking.considered.length,
      },
      message: SELECTION_MESSAGES.noRecommendations,
    });

    return {
      recommendations: [],
      considered: context.ranking.considered,
    };
  }

  const selectionModel = params.model ?? assistantEnv().OPENAI_CAPABILITY_SELECTION_MODEL;
  const payloadsByCapability = await resolveSelectionPayloads({
    extractionId: params.extractionId,
    extractionMeetingId: context.extraction.meetingId,
    ranking: context.ranking,
    extractionForSelection: context.extractionForSelection,
    meeting: context.meeting,
    taskContext: context.taskContext,
    connectedIntegrations: context.connectedIntegrations,
    modelRunner: params.modelRunner,
    selectionModel,
  });

  return persistNewCapabilitySelections({
    extractionId: params.extractionId,
    promptVersion,
    selectionModel,
    context,
    selectedRecommendations,
    payloadsByCapability,
  });
}
