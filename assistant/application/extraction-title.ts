import {
  MEETING_PREPARATION_FALLBACK_LINES,
  meetingPreparationLinesSchema,
  MeetingTitleTranscriptRequired,
  openAIPromptCacheOptions,
} from "@readymeet/shared";
import { z } from "zod";

import { VOICE_IDENTITY_INSTRUCTIONS, voiceIdentityMetadata } from "../domain/extraction/voice-search-identity";
import { assistantEnv } from "../ports/assistant-env";
import { openAIClientApiKey } from "../ports/openai-client";
import { createOpenAIClient, type OpenAIClient } from "../ports/openai-client";

import { parsePossiblyMalformedJsonObject } from "./extraction-content";
import type { RunExtractionInput } from "./extraction-orchestrator";
import { parseResponseText } from "./openai-response-text";
import { executeMeteredOpenAIResponse } from "./usage-metering";

const MEETING_TITLE_TRANSCRIPT_MAX_CHARS = 14_000;
const MEETING_TITLE_MAX_CHARS = 80;
const MEETING_TITLE_MIN_TITLE_CHARS = 2;
const MEETING_TITLE_MAX_PREPARATION_LINES = 12;
const MEETING_TITLE_MAX_OUTPUT_TOKENS = 1_024;
const DETERMINISTIC_ONE_TO_ONE_TITLE_MODEL = "deterministic-participant-pair";
const TITLE_TRANSCRIPT_OPENING_BUDGET_FRACTION = 0.4;
const TITLE_TRANSCRIPT_MIDDLE_BUDGET_FRACTION = 0.2;
const TITLE_TRANSCRIPT_MIDDLE_CENTER_DIVISOR = 2;
const TITLE_TRANSCRIPT_MIDDLE_OFFSET_DIVISOR = 10;
const TITLE_MIN_TRANSCRIPT_LINE_CHARS = 2;
const TITLE_ONE_TO_ONE_PARTICIPANT_COUNT = 2;
const TITLE_PARTICIPANT_ROLE_RANK_HOST = 0;
const TITLE_PARTICIPANT_ROLE_RANK_GUEST = 1;
const TITLE_PARTICIPANT_ROLE_RANK_OTHER = 2;
const TITLE_NEWLINE_JOIN_COST = 1;
const TITLE_EMPTY_SELECTED_LINE_COST = 0;

const TITLE_MESSAGES = {
  incompleteResponse: (reason: string) => `Meeting title response was incomplete (${reason})`,
  missingOutputText: "Meeting title response did not include text",
  openAiKeyRequired: "Configured AI provider key is required for meeting title generation",
  untitledMeeting: "Untitled meeting",
  unknownParticipants: "Unknown",
  currentPlaceholder: (placeholder: string) => `Current placeholder: ${placeholder}`,
  humanParticipants: (names: string) => `Human participants: ${names}`,
  transcriptLabel: "Transcript:",
  unknownIncompleteReason: "unknown",
} as const;

const TITLE_PROMPT_LINES = {
  inProgressIntro:
    "Create one very short, specific title and compact conclusions from the conversation so far. The meeting is still in progress. Do not imply it has ended or that unresolved topics are settled.",
  completedIntro: "Create one very short, specific title and a compact preparation sequence for a completed meeting.",
  useTranscriptOnly: "Use only the supplied transcript and participant context.",
  twoParticipantFormat:
    "If there are exactly two human participants, return their first names in this exact format: FirstName : FirstName. Do not summarize the topic.",
  groupTitle: "If there are three or more human participants, write a high-level title that makes sense on its own.",
  groupWordCount:
    "For group meetings, use the shortest specific noun phrase that makes sense on its own, normally 2 to 3 words.",
  preferTwoWords: "Prefer 2 words when they are sufficient. Use a third word only when it adds necessary context.",
  noFiller: "Never add filler to reach a word count, and never use more than 5 words.",
  preferTopic: "Prefer the central topic or outcome over greetings, incidental details, and generic labels.",
  avoidGeneric:
    "Avoid words such as Meeting, Sync, Discussion, Catch-up, and Call unless they are essential to the meaning.",
  useMeetingLanguage: "Use the language primarily spoken in the meeting.",
  preparationLineCount:
    "Write 8 to 12 preparationLines for a substantive meeting. Use 4 to 7 only when the transcript genuinely lacks enough substance, and never invent filler.",
  preparationLineShape:
    "Each preparation line must be one sharp, self-contained conclusion of 4 to 8 words and no more than 64 characters.",
  preparationTone:
    "Make the lines sound like a perceptive meeting assistant forming a clear understanding, not narrating private reasoning.",
  preparationContent:
    "State conclusions directly, for example a central theme, tension, tradeoff, decision, blocker, commitment, owner, next step, or open question.",
  preparationGrounding:
    "Ground every line in a distinct, explicit part of the transcript. Do not infer facts, certainty, decisions, or owners that were not stated.",
  preparationRanking:
    "Rank lines by importance rather than transcript order, while covering the opening, middle, and ending of the conversation.",
  preparationOpening:
    "The first four lines must already form a useful miniature understanding: central subject, strongest tension or tradeoff, clearest decision, and most important next step when each exists.",
  preparationStandalone: "Every line must stand alone so the sequence can end early when the finished notes appear.",
  preparationAvoid:
    "Do not repeat the title, depend on a previous line, restate the same subject, use first-person self-talk, or write generic process copy such as Analyzing the transcript or Preparing meeting notes.",
  jsonShape: 'Return JSON only: {"title":"...","preparationLines":["...","..."]}.',
  titleMaxChars: (maxChars: number) => `The title must be at most ${maxChars} characters.`,
} as const;

const meetingTitleOutputSchema = z.object({
  title: z.string().trim().min(MEETING_TITLE_MIN_TITLE_CHARS),
  preparationLines: z.unknown().optional(),
});

interface MeetingTitleRunner {
  createTitle(input: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    timeoutMs: number;
    meetingId: string;
    jobId?: string | null;
  }): Promise<string>;
}

class OpenAIMeetingTitleRunner implements MeetingTitleRunner {
  private readonly client: OpenAIClient;

  constructor(apiKey: string) {
    this.client = createOpenAIClient({
      apiKey,
      timeout: assistantEnv().OPENAI_MEETING_TITLE_TIMEOUT_MS,
      maxRetries: 0,
    });
  }

  async createTitle(input: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    timeoutMs: number;
    meetingId: string;
    jobId?: string | null;
  }): Promise<string> {
    const response = await executeMeteredOpenAIResponse({
      client: this.client,
      body: {
        model: input.model,
        ...openAIPromptCacheOptions(input.model),
        max_output_tokens: MEETING_TITLE_MAX_OUTPUT_TOKENS,
        ...(/^(gpt-5|o\d)/i.test(input.model) ? { reasoning: { effort: "low" as const } } : {}),
        text: { format: { type: "json_object" } },
        input: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userMessage },
        ],
      },
      options: { timeout: input.timeoutMs },
      meetingId: input.meetingId,
      jobId: input.jobId ?? null,
      source: "meeting_title",
      operation: "resolve_meeting_title",
    });

    if (response.status === "incomplete") {
      throw new Error(
        TITLE_MESSAGES.incompleteResponse(
          response.incomplete_details?.reason ?? TITLE_MESSAGES.unknownIncompleteReason,
        ),
      );
    }

    const outputText = parseResponseText(response);
    if (outputText.trim().length === 0) {
      throw new Error(TITLE_MESSAGES.missingOutputText);
    }

    return outputText;
  }
}

function titleTranscriptLines(input: RunExtractionInput): string[] {
  return [...input.transcript]
    .filter((segment) => segment.speakerRole === "human")
    .sort((left, right) => {
      const startedAtDelta = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
      if (startedAtDelta !== 0) {
        return startedAtDelta;
      }

      return left.id.localeCompare(right.id);
    })
    .map((segment) => {
      const hasIdentityEvidence =
        input.voiceSearchIdentityEvidence?.some((evidence) => evidence.segmentId === segment.id) === true;
      const prefix = hasIdentityEvidence ? `(${segment.id}) ` : "";

      return `${prefix}${segment.speakerName}: ${segment.content.replace(/\s+/g, " ").trim()}`;
    })
    .filter((line) => line.length > TITLE_MIN_TRANSCRIPT_LINE_CHARS);
}

function takeLinesWithinBudget(input: { lines: string[]; budget: number }): string[] {
  return input.lines.reduce<{ selected: string[]; length: number }>(
    (state, line) => {
      const separatorCost = state.selected.length !== 0 ? TITLE_NEWLINE_JOIN_COST : TITLE_EMPTY_SELECTED_LINE_COST;
      const cost = line.length + separatorCost;
      if (state.length + cost > input.budget) {
        return state;
      }

      return {
        selected: [...state.selected, line],
        length: state.length + cost,
      };
    },
    { selected: [], length: 0 },
  ).selected;
}

function formatMeetingTitleTranscript(input: RunExtractionInput): string {
  const lines = titleTranscriptLines(input);
  const complete = lines.join("\n");
  if (complete.length <= MEETING_TITLE_TRANSCRIPT_MAX_CHARS) {
    return complete;
  }

  const openingBudget = Math.floor(MEETING_TITLE_TRANSCRIPT_MAX_CHARS * TITLE_TRANSCRIPT_OPENING_BUDGET_FRACTION);
  const middleBudget = Math.floor(MEETING_TITLE_TRANSCRIPT_MAX_CHARS * TITLE_TRANSCRIPT_MIDDLE_BUDGET_FRACTION);
  const endingBudget = MEETING_TITLE_TRANSCRIPT_MAX_CHARS - openingBudget - middleBudget;
  const middleStart = Math.max(
    0,
    Math.floor(lines.length / TITLE_TRANSCRIPT_MIDDLE_CENTER_DIVISOR) -
      Math.ceil(lines.length / TITLE_TRANSCRIPT_MIDDLE_OFFSET_DIVISOR),
  );
  const middleLines = lines.slice(middleStart);
  const endingLines = [...lines].reverse();

  return [
    "[Opening]",
    ...takeLinesWithinBudget({ lines, budget: openingBudget }),
    "[Middle]",
    ...takeLinesWithinBudget({ lines: middleLines, budget: middleBudget }),
    "[Ending]",
    ...[...takeLinesWithinBudget({ lines: endingLines, budget: endingBudget })].reverse(),
  ].join("\n");
}

function buildMeetingTitlePrompt(input: { isMeetingInProgress?: boolean } = {}): string {
  const isMeetingInProgress = input.isMeetingInProgress === true;

  return [
    isMeetingInProgress ? TITLE_PROMPT_LINES.inProgressIntro : TITLE_PROMPT_LINES.completedIntro,
    TITLE_PROMPT_LINES.useTranscriptOnly,
    TITLE_PROMPT_LINES.twoParticipantFormat,
    TITLE_PROMPT_LINES.groupTitle,
    TITLE_PROMPT_LINES.groupWordCount,
    TITLE_PROMPT_LINES.preferTwoWords,
    TITLE_PROMPT_LINES.noFiller,
    TITLE_PROMPT_LINES.preferTopic,
    TITLE_PROMPT_LINES.avoidGeneric,
    TITLE_PROMPT_LINES.useMeetingLanguage,
    TITLE_PROMPT_LINES.preparationLineCount,
    TITLE_PROMPT_LINES.preparationLineShape,
    TITLE_PROMPT_LINES.preparationTone,
    TITLE_PROMPT_LINES.preparationContent,
    TITLE_PROMPT_LINES.preparationGrounding,
    TITLE_PROMPT_LINES.preparationRanking,
    TITLE_PROMPT_LINES.preparationOpening,
    TITLE_PROMPT_LINES.preparationStandalone,
    TITLE_PROMPT_LINES.preparationAvoid,
    TITLE_PROMPT_LINES.jsonShape,
    TITLE_PROMPT_LINES.titleMaxChars(MEETING_TITLE_MAX_CHARS),
  ].join("\n");
}

function humanParticipantNames(input: RunExtractionInput): string[] {
  return (input.metadata.participants ?? [])
    .filter((participant) => participant.roleHint !== "assistant")
    .sort((left, right) => {
      const roleRank = (role: string | null | undefined) => {
        if (role === "host") {
          return TITLE_PARTICIPANT_ROLE_RANK_HOST;
        }
        if (role === "guest") {
          return TITLE_PARTICIPANT_ROLE_RANK_GUEST;
        }

        return TITLE_PARTICIPANT_ROLE_RANK_OTHER;
      };

      return roleRank(left.roleHint) - roleRank(right.roleHint);
    })
    .map((participant) => participant.name.trim())
    .filter((name) => name.length > 0);
}

function firstName(name: string): string {
  return (
    name
      .split(/\s+/)[0]
      ?.replace(/^[,;:]+|[,;:]+$/g, "")
      .trim() ?? ""
  );
}

function buildOneToOneMeetingTitle(input: RunExtractionInput): string | null {
  const participantNames = humanParticipantNames(input);
  if (participantNames.length !== TITLE_ONE_TO_ONE_PARTICIPANT_COUNT) {
    return null;
  }

  const names = participantNames.map(firstName);
  if (names.some((participantName) => participantName.length === 0)) {
    return null;
  }

  const firstParticipantName = names[0] ?? "";
  const secondParticipantName = names[1] ?? "";
  const displayNames =
    firstParticipantName.localeCompare(secondParticipantName, undefined, { sensitivity: "base" }) === 0
      ? participantNames
      : names;

  const leftName = displayNames[0] ?? "";
  const rightName = displayNames[1] ?? "";

  return `${leftName} : ${rightName}`;
}

interface MeetingTitleValidationResult {
  title: string;
  preparationLines: string[];
  /** @external preparationLinesFallback */
  preparationLinesFallback: boolean;
}

function validateMeetingTitleOutput(rawText: string): MeetingTitleValidationResult {
  const parsed = meetingTitleOutputSchema.parse(parsePossiblyMalformedJsonObject(rawText));
  const title = parsed.title
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MEETING_TITLE_MAX_CHARS)
    .trim();
  const parsedPreparationLines = meetingPreparationLinesSchema.safeParse(parsed.preparationLines);
  const preparationLines = parsedPreparationLines.success
    ? Array.from(
        new Set(parsedPreparationLines.data.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean)),
      ).slice(0, MEETING_TITLE_MAX_PREPARATION_LINES)
    : [...MEETING_PREPARATION_FALLBACK_LINES];

  return {
    title,
    preparationLines,
    preparationLinesFallback: !parsedPreparationLines.success,
  };
}

export interface MeetingTitleResult {
  title: string;
  preparationLines: string[];
  /** @external preparationLinesFallback */
  preparationLinesFallback: boolean;
  model: string;
}

interface RunMeetingTitleOptions {
  runner?: MeetingTitleRunner;
  model?: string;
  timeoutMs?: number;
  jobId?: string | null;
  /** @external meetingInProgress */
  meetingInProgress?: boolean;
}

function meetingTitleForEmptyTranscript(oneToOneTitle: string | null): MeetingTitleResult {
  if (oneToOneTitle !== null) {
    return {
      title: oneToOneTitle,
      preparationLines: [...MEETING_PREPARATION_FALLBACK_LINES],
      preparationLinesFallback: true,
      model: DETERMINISTIC_ONE_TO_ONE_TITLE_MODEL,
    };
  }

  throw new MeetingTitleTranscriptRequired();
}

function resolveMeetingTitleRunner(params: RunMeetingTitleOptions): MeetingTitleRunner {
  const apiKey = openAIClientApiKey();
  if ((apiKey === undefined || apiKey === "") && params.runner === undefined) {
    throw new Error(TITLE_MESSAGES.openAiKeyRequired);
  }

  return params.runner ?? new OpenAIMeetingTitleRunner(apiKey !== undefined && apiKey !== "" ? apiKey : "");
}

function buildMeetingTitleUserMessage(params: {
  input: RunExtractionInput;
  transcript: string;
  identityMetadata: string;
  isMeetingInProgress: boolean;
}): string {
  const placeholderTitle = params.input.metadata.title?.trim();
  const participantList = humanParticipantNames(params.input).join(", ");
  const hasIdentityMetadata = params.identityMetadata.length > 0;

  return [
    TITLE_MESSAGES.currentPlaceholder(
      placeholderTitle !== undefined && placeholderTitle.length > 0 ? placeholderTitle : TITLE_MESSAGES.untitledMeeting,
    ),
    TITLE_MESSAGES.humanParticipants(participantList.length > 0 ? participantList : TITLE_MESSAGES.unknownParticipants),
    ...(hasIdentityMetadata ? [params.identityMetadata] : []),
    TITLE_MESSAGES.transcriptLabel,
    params.transcript,
  ].join("\n");
}

export async function runMeetingTitle(
  params: RunMeetingTitleOptions & { input: RunExtractionInput },
): Promise<MeetingTitleResult> {
  const oneToOneTitle = buildOneToOneMeetingTitle(params.input);
  const transcript = formatMeetingTitleTranscript(params.input);
  const identityMetadata = voiceIdentityMetadata({
    evidence: params.input.voiceSearchIdentityEvidence,
    text: transcript,
  });
  const isMeetingInProgress = params.meetingInProgress === true;

  // A 1:1 meeting with no substantive speech (a missed connection, an
  // instant hang-up) is common and not an error: keep the deterministic
  // title path free of the model entirely rather than throwing and forcing
  // the worker down its failure-fallback branch for an expected case.
  if (transcript.trim().length === 0) {
    return meetingTitleForEmptyTranscript(oneToOneTitle);
  }

  const model = params.model ?? assistantEnv().OPENAI_MEETING_TITLE_MODEL;
  const timeoutMs = params.timeoutMs ?? assistantEnv().OPENAI_MEETING_TITLE_TIMEOUT_MS;
  const runner = resolveMeetingTitleRunner(params);
  const hasIdentityMetadata = identityMetadata.length > 0;
  const rawText = await runner.createTitle({
    model,
    systemPrompt: `${buildMeetingTitlePrompt({ isMeetingInProgress })}${hasIdentityMetadata ? `\n${VOICE_IDENTITY_INSTRUCTIONS}` : ""}`,
    userMessage: buildMeetingTitleUserMessage({
      input: params.input,
      transcript,
      identityMetadata,
      isMeetingInProgress,
    }),
    timeoutMs,
    meetingId: params.input.meetingId,
    jobId: params.jobId ?? null,
  });

  const generated = validateMeetingTitleOutput(rawText);

  return {
    title: oneToOneTitle ?? generated.title,
    preparationLines: generated.preparationLines,
    preparationLinesFallback: generated.preparationLinesFallback,
    model: oneToOneTitle !== null ? DETERMINISTIC_ONE_TO_ONE_TITLE_MODEL : model,
  };
}
