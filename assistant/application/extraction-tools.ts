import {
  decisionFinalitySchema,
  type ExtractedActionItem,
  type ExtractedDecision,
  type ExtractedHighlight,
  type ExtractedOpenQuestion,
  type ExtractedRisk,
  extractionConfidenceSchema,
  type FailedToolCall,
  failedToolCallSchema,
  meetingTypeSchema,
  openQuestionPrioritySchema,
  signalKeySchema,
  type SignalPresence,
  type SourceSpan,
} from "@readymeet/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { OpenAIFunctionTool } from "../ports/openai-client";

export type TranscriptLineReference = {
  lineNumber: number;
  segmentId: string;
  speakerName: string;
  content: string;
  startedAt: string;
  endedAt: string | null;
};

const sourceSpanInputSchema = z.object({
  excerpt: z.string().trim().min(1),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
});

const sourceSpansInputSchema = z.array(sourceSpanInputSchema).min(1);

const SUMMARY_BULLETS_MIN_COUNT = 3;
const SUMMARY_BULLETS_MAX_COUNT = 6;
const HIGHLIGHT_THEME_MAX_CHARS = 40;
const HIGHLIGHT_TAKEAWAY_MAX_CHARS = 200;
const KEY_TOPIC_MAX_CHARS = 80;
const TAKEAWAY_MAX_SENTENCE_MARKERS = 1;
const TRANSCRIPT_LINE_SEARCH_MAX_WINDOW = 25;
const LINE_NUMBER_MINIMUM = 1;

const EXTRACTION_TOOLS_MESSAGES = {
  takeawaySingleSentence: "takeaway must be a single sentence",
  sourceSpanLineEnd: "source_span.line_end must be greater than or equal to source_span.line_start",
  finishExtractionClosed: "No tool calls are accepted after finish_extraction",
  classifyMeetingOnce: "classify_meeting may only be called once",
  classifyMeetingRegistered: "classification registered",
  registerSummaryOnce: "register_summary may only be called once",
  summaryRegistered: "summary registered",
  decisionRegistered: "decision registered",
  openQuestionRegistered: "open question registered",
  highlightRegistered: "highlight registered",
  keyTopicRegistered: "key topic registered",
  signalOncePerKey: (key: string) => `register_signal may only be called once per key ("${key}")`,
  signalRegistered: "signal registered",
  finishExtractionOnce: "finish_extraction may only be called once",
  extractionFinished: "extraction finished",
  unknownTool: (toolName: string) => `Unknown tool "${toolName}"`,
  toolValidationFailed: "Tool validation failed",
  classifyMeetingMissing: "Required tool classify_meeting was never called",
  registerSummaryMissing: "Required tool register_summary was never called",
} as const;

const classifyMeetingInputSchema = z.object({
  type: meetingTypeSchema,
  confidence: extractionConfidenceSchema,
  reasoning: z.string().trim().min(1),
});

const registerSummaryInputSchema = z.object({
  short: z.string().trim().min(1),
  bullets: z.array(z.string().trim().min(1)).min(SUMMARY_BULLETS_MIN_COUNT).max(SUMMARY_BULLETS_MAX_COUNT),
});

const registerDecisionInputSchema = z.object({
  text: z.string().trim().min(1),
  finality: decisionFinalitySchema,
  confidence: extractionConfidenceSchema,
  source_span: sourceSpanInputSchema,
});

const registerOpenQuestionInputSchema = z.object({
  text: z.string().trim().min(1),
  priority: openQuestionPrioritySchema,
  source_span: sourceSpanInputSchema,
});

const highlightThemeInputSchema = z.string().trim().min(1).max(HIGHLIGHT_THEME_MAX_CHARS);

const highlightTakeawayInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(HIGHLIGHT_TAKEAWAY_MAX_CHARS)
  .refine((value) => !/\n/.test(value), EXTRACTION_TOOLS_MESSAGES.takeawaySingleSentence)
  .refine((value) => {
    const sentenceMarkers = value.match(/[.!?](?=\s|$)/g) ?? [];

    return sentenceMarkers.length <= TAKEAWAY_MAX_SENTENCE_MARKERS;
  }, EXTRACTION_TOOLS_MESSAGES.takeawaySingleSentence);

const registerKeyTopicInputSchema = z.object({
  topic: z.string().trim().min(1).max(KEY_TOPIC_MAX_CHARS),
});

const registerHighlightInputSchema = z.object({
  theme: highlightThemeInputSchema,
  takeaway: highlightTakeawayInputSchema,
  source_spans: sourceSpansInputSchema,
});

const registerSignalInputSchema = z.object({
  key: signalKeySchema,
  confidence: extractionConfidenceSchema,
  source_spans: sourceSpansInputSchema,
  reasoning: z.string().trim().min(1).optional(),
});

const finishExtractionInputSchema = z.object({}).strict();

export type ToolApplicationState = {
  classification: {
    type: z.infer<typeof meetingTypeSchema>;
    confidence: z.infer<typeof extractionConfidenceSchema>;
    reasoning: string;
  } | null;
  summary: {
    short: string;
    bullets: string[];
  } | null;
  decisions: ExtractedDecision[];
  actionItems: ExtractedActionItem[];
  openQuestions: ExtractedOpenQuestion[];
  risks: ExtractedRisk[];
  highlights: ExtractedHighlight[];
  keyTopics: string[];
  signals: SignalPresence[];
  failedToolCalls: FailedToolCall[];
  /** @external finished */
  finished: boolean;
};

type ToolApplicationResult = {
  /** @external ok */
  ok: boolean;
  message: string;
};

function normalizeForMatch(value: string) {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizeForMatch(value: string) {
  return normalizeForMatch(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function containsEllipsisSeparatorPattern(value: string) {
  return (
    /(?:^|\n)\s*(?:\.\.\.|…)\s*(?:\n|$)/.test(value) ||
    /\S\s*(?:\.\.\.|…)\s+\S/.test(value) ||
    /\S\s+(?:\.\.\.|…)\s*\S/.test(value)
  );
}

function buildCandidateRegions(lines: TranscriptLineReference[]) {
  const contentOnlyWithNewlines = lines.map((line) => line.content).join("\n");
  const contentOnlyWithSpaces = lines.map((line) => line.content).join(" ");
  const speakerPrefixedWithNewlines = lines.map((line) => `${line.speakerName}: ${line.content}`).join("\n");
  const speakerPrefixedWithSpaces = lines.map((line) => `${line.speakerName}: ${line.content}`).join(" ");

  return {
    contentOnlyWithNewlines,
    speakerPrefixedWithNewlines,
    regions: [contentOnlyWithNewlines, contentOnlyWithSpaces, speakerPrefixedWithNewlines, speakerPrefixedWithSpaces],
  };
}

function tokensAppearInOrder(params: { needle: string; haystack: string }): boolean {
  const { needle, haystack } = params;
  const needleTokens = tokenizeForMatch(needle);
  const haystackTokens = tokenizeForMatch(haystack);

  if (needleTokens.length === 0) {
    return true;
  }

  const matchedNeedleTokens = haystackTokens.reduce((needleIndex, token) => {
    if (needleIndex >= needleTokens.length) {
      return needleIndex;
    }
    if (token === needleTokens[needleIndex]) {
      return needleIndex + 1;
    }

    return needleIndex;
  }, 0);

  return matchedNeedleTokens === needleTokens.length;
}

function hasExactNormalizedMatch(params: { excerpt: string; candidateRegions: string[] }): boolean {
  const { excerpt, candidateRegions } = params;
  const normalizedExcerpt = normalizeForMatch(excerpt);

  return candidateRegions.some((candidateRegion) => normalizeForMatch(candidateRegion).includes(normalizedExcerpt));
}

function excerptMatchesRegion(params: { excerpt: string; candidateRegion: string }): boolean {
  const { excerpt, candidateRegion } = params;
  const normalizedExcerpt = normalizeForMatch(excerpt);
  const normalizedRegion = normalizeForMatch(candidateRegion);

  if (normalizedExcerpt === "" || normalizedRegion === "") {
    return false;
  }

  return (
    normalizedRegion.includes(normalizedExcerpt) ||
    normalizedExcerpt.includes(normalizedRegion) ||
    tokensAppearInOrder({ needle: excerpt, haystack: candidateRegion })
  );
}

function findMatchingTranscriptLines(params: {
  excerpt: string;
  transcriptLines: TranscriptLineReference[];
}): TranscriptLineReference[] | null {
  const { excerpt, transcriptLines } = params;
  const maxWindowSize = Math.min(transcriptLines.length, TRANSCRIPT_LINE_SEARCH_MAX_WINDOW);
  const windowSizes = Array.from({ length: maxWindowSize }, (_, index) => index + 1);

  return windowSizes.reduce<TranscriptLineReference[] | null>((foundLines, windowSize) => {
    if (foundLines !== null) {
      return foundLines;
    }

    const startIndexes = Array.from({ length: transcriptLines.length - windowSize + 1 }, (_, index) => index);

    return startIndexes.reduce<TranscriptLineReference[] | null>((innerFoundLines, startIndex) => {
      if (innerFoundLines !== null) {
        return innerFoundLines;
      }

      const candidateLines = transcriptLines.slice(startIndex, startIndex + windowSize);
      const candidateRegions = buildCandidateRegions(candidateLines).regions;
      const isEllipsisLiteral =
        !containsEllipsisSeparatorPattern(excerpt) || hasExactNormalizedMatch({ excerpt, candidateRegions });

      if (
        isEllipsisLiteral &&
        candidateRegions.some((candidateRegion) => excerptMatchesRegion({ excerpt, candidateRegion }))
      ) {
        return candidateLines;
      }

      return null;
    }, null);
  }, null);
}

function logFailedToolCall(input: {
  state: ToolApplicationState;
  toolName: string;
  rawInput: unknown;
  error: string;
}): void {
  const { state, toolName, rawInput, error } = input;
  state.failedToolCalls = [
    ...state.failedToolCalls,
    failedToolCallSchema.parse({
      toolName,
      rawInput,
      error,
      occurredAt: new Date().toISOString(),
    }),
  ];
}

function toolSuccess(message: string): ToolApplicationResult {
  return {
    /** @external ok */
    ok: true,
    message,
  };
}

function toolFailure(params: { state: ToolApplicationState; toolName: string; rawInput: unknown; message: string }) {
  logFailedToolCall({
    state: params.state,
    toolName: params.toolName,
    rawInput: params.rawInput,
    error: params.message,
  });

  return {
    /** @external ok */
    ok: false,
    message: params.message,
  };
}

export function sourceSpansToSignalEvidence(sourceSpans: SourceSpan[]): (SourceSpan & { sourceSpanIndex: number })[] {
  return sourceSpans.map((sourceSpan, index) => ({
    ...sourceSpan,
    sourceSpanIndex: index,
  }));
}

function buildVerifiedSourceSpan(input: {
  rawSpan: z.infer<typeof sourceSpanInputSchema>;
  referencedLines: TranscriptLineReference[];
}): SourceSpan {
  return {
    excerpt: input.rawSpan.excerpt.trim(),
    lineStart: input.rawSpan.line_start,
    lineEnd: input.rawSpan.line_end,
    segmentIds: input.referencedLines.map((line) => line.segmentId),
    startedAt: input.referencedLines[0]?.startedAt ?? null,
    endedAt: input.referencedLines.at(-1)?.endedAt ?? null,
    verificationStatus: "verified",
  };
}

function buildCorrectedSourceSpan(input: {
  rawSpan: z.infer<typeof sourceSpanInputSchema>;
  correctedLines: TranscriptLineReference[];
}): SourceSpan {
  return {
    excerpt: input.rawSpan.excerpt.trim(),
    lineStart: input.correctedLines[0]?.lineNumber ?? input.rawSpan.line_start,
    lineEnd: input.correctedLines.at(-1)?.lineNumber ?? input.rawSpan.line_end,
    segmentIds: input.correctedLines.map((line) => line.segmentId),
    startedAt: input.correctedLines[0]?.startedAt ?? null,
    endedAt: input.correctedLines.at(-1)?.endedAt ?? null,
    verificationStatus: "corrected",
    verificationReason: [
      "source_span line numbers were corrected by matching excerpt text",
      `requested_line_start=${input.rawSpan.line_start}`,
      `requested_line_end=${input.rawSpan.line_end}`,
    ].join(" | "),
  };
}

function buildUnverifiedSourceSpan(input: {
  rawSpan: z.infer<typeof sourceSpanInputSchema>;
  referencedLines: TranscriptLineReference[];
  referencedRegion: ReturnType<typeof buildCandidateRegions> | null;
  isEllipsisLiteralInReferencedRegion: boolean;
}): SourceSpan {
  const unverifiedReason =
    containsEllipsisSeparatorPattern(input.rawSpan.excerpt) && !input.isEllipsisLiteralInReferencedRegion
      ? "excerpt contains '...' or '…' that could not be mapped to exact contiguous transcript text"
      : [
          "source_span.excerpt could not be verified against transcript text",
          `actual_excerpt=${JSON.stringify(input.rawSpan.excerpt)}`,
          `expected_region=${JSON.stringify(input.referencedRegion?.contentOnlyWithNewlines ?? null)}`,
          `expected_region_with_speakers=${JSON.stringify(input.referencedRegion?.speakerPrefixedWithNewlines ?? null)}`,
        ].join(" | ");

  return {
    excerpt: input.rawSpan.excerpt.trim(),
    lineStart: input.rawSpan.line_start,
    lineEnd: input.rawSpan.line_end,
    segmentIds: input.referencedLines.map((line) => line.segmentId),
    startedAt: input.referencedLines[0]?.startedAt ?? null,
    endedAt: input.referencedLines.at(-1)?.endedAt ?? null,
    verificationStatus: "unverified",
    verificationReason: unverifiedReason,
  };
}

function isVerifiedReferencedSpan(input: {
  rawSpan: z.infer<typeof sourceSpanInputSchema>;
  referencedRegion: ReturnType<typeof buildCandidateRegions>;
  isEllipsisLiteralInReferencedRegion: boolean;
}) {
  return (
    input.isEllipsisLiteralInReferencedRegion &&
    input.referencedRegion.regions.some((candidateRegion) =>
      excerptMatchesRegion({ excerpt: input.rawSpan.excerpt, candidateRegion }),
    )
  );
}

export function resolveSourceSpan(params: {
  rawSpan: z.infer<typeof sourceSpanInputSchema>;
  transcriptLines: TranscriptLineReference[];
}): SourceSpan {
  const { rawSpan, transcriptLines } = params;
  if (rawSpan.line_end < rawSpan.line_start) {
    throw new Error(EXTRACTION_TOOLS_MESSAGES.sourceSpanLineEnd);
  }

  const referencedLines = transcriptLines.filter(
    (line) => line.lineNumber >= rawSpan.line_start && line.lineNumber <= rawSpan.line_end,
  );

  const expectedCount = rawSpan.line_end - rawSpan.line_start + 1;
  const referencedRegion = referencedLines.length === expectedCount ? buildCandidateRegions(referencedLines) : null;
  const isEllipsisLiteralInReferencedRegion =
    !containsEllipsisSeparatorPattern(rawSpan.excerpt) ||
    (referencedRegion
      ? hasExactNormalizedMatch({ excerpt: rawSpan.excerpt, candidateRegions: referencedRegion.regions })
      : false);

  if (
    referencedRegion !== null &&
    isVerifiedReferencedSpan({ rawSpan, referencedRegion, isEllipsisLiteralInReferencedRegion })
  ) {
    return buildVerifiedSourceSpan({ rawSpan, referencedLines });
  }

  const correctedLines = findMatchingTranscriptLines({ excerpt: rawSpan.excerpt, transcriptLines });
  if (correctedLines !== null) {
    return buildCorrectedSourceSpan({ rawSpan, correctedLines });
  }

  return buildUnverifiedSourceSpan({
    rawSpan,
    referencedLines,
    referencedRegion,
    isEllipsisLiteralInReferencedRegion,
  });
}

export function createInitialToolState(): ToolApplicationState {
  return {
    classification: null,
    summary: null,
    decisions: [],
    actionItems: [],
    openQuestions: [],
    risks: [],
    highlights: [],
    keyTopics: [],
    signals: [],
    failedToolCalls: [],
    finished: false,
  };
}

function ensureToolCallsAllowed(state: ToolApplicationState): void {
  if (state.finished) {
    throw new Error(EXTRACTION_TOOLS_MESSAGES.finishExtractionClosed);
  }
}

function stringProperty(description?: string): Record<string, unknown> {
  return {
    type: "string",
    ...(description !== undefined && description !== "" ? { description } : {}),
  };
}

function enumProperty(params: { values: readonly string[]; description?: string }): Record<string, unknown> {
  return {
    type: "string",
    enum: [...params.values],
    ...(params.description !== undefined && params.description !== "" ? { description: params.description } : {}),
  };
}

const sourceSpanParameters = {
  type: "object",
  /** @external OpenAI tool JSON schema wire field. */

  additionalProperties: false,
  required: ["excerpt", "line_start", "line_end"],
  properties: {
    excerpt: stringProperty("Quoted transcript excerpt supporting the extraction"),
    line_start: {
      type: "integer",
      minimum: LINE_NUMBER_MINIMUM,
    },
    line_end: {
      type: "integer",
      minimum: LINE_NUMBER_MINIMUM,
    },
  },
} as const;

function buildMeetingHumanReadableExtractionTools(): OpenAIFunctionTool[] {
  return [
    {
      type: "function",
      /** @external OpenAI function tool wire field */
      strict: true,
      name: "classify_meeting",
      description: "Classify the meeting type exactly once near the start of extraction.",
      parameters: {
        type: "object",
        /** @external OpenAI tool JSON schema wire field. */

        additionalProperties: false,
        required: ["type", "confidence", "reasoning"],
        properties: {
          type: enumProperty({ values: meetingTypeSchema.options }),
          confidence: enumProperty({ values: extractionConfidenceSchema.options }),
          reasoning: stringProperty(),
        },
      },
    },
    {
      type: "function",
      /** @external OpenAI function tool wire field */
      strict: true,
      name: "register_summary",
      description:
        "Register the one-sentence summary and 3 to 6 summary bullets exactly once. The summary complements the highlights, it does not duplicate them. Highlights are the thematic TL;DR; the summary is the narrative fill-in. Aim for the summary to provide context, flow, and connective tissue that highlights alone cannot provide. summary_short captures the meeting essence in one sentence. summary_bullets add narrative depth, including framing, speaker dynamics, and how the meeting unfolded, rather than simply restating the highlight takeaways.",
      parameters: {
        type: "object",
        /** @external OpenAI tool JSON schema wire field. */

        additionalProperties: false,
        required: ["short", "bullets"],
        properties: {
          short: stringProperty(),
          bullets: {
            type: "array",
            minItems: SUMMARY_BULLETS_MIN_COUNT,
            maxItems: SUMMARY_BULLETS_MAX_COUNT,
            items: stringProperty(),
          },
        },
      },
    },
  ] satisfies OpenAIFunctionTool[];
}

function buildMeetingFactRegistrationTools(): OpenAIFunctionTool[] {
  return [
    {
      type: "function",
      /** @external OpenAI function tool wire field */
      strict: true,
      name: "register_decision",
      description:
        "Register one grounded decision from the meeting. Many meetings contain zero decisions. Interviews, pre-screens, status syncs, informational briefings, one-on-ones focused on updates, and introductory conversations often have none. Do not register a decision unless a choice was actually resolved among alternatives. When in doubt, register nothing. A decision is a choice that was resolved among alternatives, a direction that was chosen, or a position that was settled. A commitment to perform an action is NOT a decision. Process continuation and enthusiasm do not establish a resolved choice. Do not register them as decisions. Finality and confidence must be consistent with the transcript. If the speaker stated something unambiguously, do not mark it tentative. tentative is for decisions the speakers themselves flagged as not final.",
      parameters: {
        type: "object",
        /** @external OpenAI tool JSON schema wire field. */

        additionalProperties: false,
        required: ["text", "finality", "confidence", "source_span"],
        properties: {
          text: stringProperty(),
          finality: enumProperty({ values: decisionFinalitySchema.options }),
          confidence: enumProperty({ values: extractionConfidenceSchema.options }),
          source_span: sourceSpanParameters,
        },
      },
    },
    {
      type: "function",
      /** @external OpenAI function tool wire field */
      strict: true,
      name: "register_open_question",
      description:
        "Register one unresolved open question from the meeting. Open questions are substantive issues the meeting left unresolved, not procedural uncertainties about next steps. Many meetings contain zero open questions. Do not register working-session logistics, interview scheduling details, or unanswered process mechanics. Register only unresolved substantive questions supported by the meeting.",
      parameters: {
        type: "object",
        /** @external OpenAI tool JSON schema wire field. */

        additionalProperties: false,
        required: ["text", "priority", "source_span"],
        properties: {
          text: stringProperty(),
          priority: enumProperty({ values: openQuestionPrioritySchema.options }),
          source_span: sourceSpanParameters,
        },
      },
    },
    {
      type: "function",
      /** @external OpenAI function tool wire field */
      strict: true,
      name: "register_key_topic",
      description:
        "Register one short key topic label from the meeting. Register 4–8 topics for a typical substantive meeting. A single topic is almost never correct unless the meeting was very short and narrowly scoped. Topics are short labels, usually 1 to 5 words, not summaries. Keep each label specific to one topic. Do not combine distinct topics or use descriptive sentences as labels.",
      parameters: {
        type: "object",
        /** @external OpenAI tool JSON schema wire field. */

        additionalProperties: false,
        required: ["topic"],
        properties: {
          topic: stringProperty(),
        },
      },
    },
    {
      type: "function",
      /** @external OpenAI function tool wire field */
      strict: true,
      name: "register_highlight",
      description:
        'Register one thematic highlight from the meeting. A highlight is a thematic takeaway from the meeting: a pairing of a topic with a one-sentence substantive point that stands on its own. Highlights are the scannable TL;DR above the summary. A reader skimming only the highlights should understand the meeting shape and outcomes in under 30 seconds. Register 4-7 highlights for a typical substantive meeting. Fewer is correct if the meeting is narrow; more is almost never correct. Each highlight must be distinct from the others. Do not register two highlights with the same theme, and do not register highlights that are just restatements of each other. theme is 1-4 words and reads as a topic label, not a sentence. Good: "Product vision", "Hiring process", "Compensation discussion". Bad: "The product vision was discussed", "We talked about hiring". takeaway is one complete sentence that captures the substantive point, not a summary of what was discussed. Keep the takeaway compact and concrete, usually under about 25 words and comfortably within the validator limit. Strip throat-clearing adjectives and biography-like stacking. If the sentence starts to combine two distant ideas, split it into two highlights or simplify it to one core point. If a highlight would need evidence from far-apart moments in the transcript, either use multiple exact source spans or narrow the takeaway to one local evidence cluster. Do not force team size, culture, role design, and process details into one sentence unless one local excerpt actually supports them together. Good: "The team chose cursor pagination for the API to support large result sets." Bad: "They discussed API pagination." Every highlight requires at least one source_span with a real excerpt. A highlight without grounding is not a highlight; it is fabricated synthesis. Choose the narrowest exact source span that fully contains the copied excerpt. Do not point at broad line ranges when a smaller contiguous range would do, and do not skip text inside the referenced range. Copy each excerpt verbatim from the transcript rather than cleaning up spoken language. If you use multiple source spans, each span must independently be an exact contiguous quote from its own referenced lines. Do not compress omitted material with "..." inside a source span. If you find yourself wanting one giant line range with omitted material, the highlight is too broad and should be split or simplified. Do NOT register highlights that synthesize positioning language, market commentary, or competitive framing beyond what the transcript actually said. If the transcript says the product is built on Rust, the takeaway is "The product is built on Rust", not commentary about differentiation. Short meetings, narrow status syncs, and simple check-ins may warrant fewer than 4 highlights or none at all. Do not manufacture highlights to fill space. Register only what the transcript substantively supports.',
      parameters: {
        type: "object",
        /** @external OpenAI tool JSON schema wire field. */

        additionalProperties: false,
        required: ["theme", "takeaway", "source_spans"],
        properties: {
          theme: stringProperty(),
          takeaway: stringProperty(),
          source_spans: {
            type: "array",
            minItems: 1,
            items: sourceSpanParameters,
          },
        },
      },
    },
  ] satisfies OpenAIFunctionTool[];
}

function buildMeetingSignalExtractionTools(): OpenAIFunctionTool[] {
  return [
    {
      type: "function",
      /** @external OpenAI function tool wire field */
      strict: true,
      name: "register_signal",
      description:
        'Register one signal from the closed signal registry when the transcript supports it. Signals are separate from the human-readable facts. Only register a signal when the transcript meets the registry definition, triggering examples, and anti-examples for that key. Use the narrowest exact source span or spans that directly support the signal. Prefer the same exact evidence already used by the underlying decision, open question, or highlight instead of broad surrounding context. Copy excerpts verbatim from the transcript rather than cleaning up spoken language. When your reasoning connects two facts, keep the reasoning in reasoning and keep the source spans literal. Do not stitch together non-contiguous fragments, do not include extra lead-in lines, and do not insert "..." ellipses.',
      parameters: {
        type: "object",
        /** @external OpenAI tool JSON schema wire field. */

        additionalProperties: false,
        required: ["key", "confidence", "source_spans"],
        properties: {
          key: enumProperty({ values: signalKeySchema.options }),
          confidence: enumProperty({ values: extractionConfidenceSchema.options }),
          source_spans: {
            type: "array",
            minItems: 1,
            items: sourceSpanParameters,
          },
          reasoning: stringProperty(),
        },
      },
    },
    {
      type: "function",
      /** @external OpenAI function tool wire field */
      strict: true,
      name: "finish_extraction",
      description: "Call exactly once at the very end, after all other supported facts and signals are registered.",
      parameters: {
        type: "object",
        /** @external OpenAI tool JSON schema wire field. */

        additionalProperties: false,
        properties: {},
      },
    },
  ] satisfies OpenAIFunctionTool[];
}

export function buildMeetingExtractionTools(): OpenAIFunctionTool[] {
  return [
    ...buildMeetingHumanReadableExtractionTools(),
    ...buildMeetingFactRegistrationTools(),
    ...buildMeetingSignalExtractionTools(),
  ];
}

type ToolCallHandlerContext = {
  state: ToolApplicationState;
  rawInput: unknown;
  transcriptLines: TranscriptLineReference[];
  reject: (message: string) => ToolApplicationResult;
};

function applyClassifyMeetingToolCall(context: ToolCallHandlerContext): ToolApplicationResult {
  const { state, rawInput, reject } = context;
  if (state.classification !== null) {
    return reject(EXTRACTION_TOOLS_MESSAGES.classifyMeetingOnce);
  }

  const parsed = classifyMeetingInputSchema.parse(rawInput);
  state.classification = parsed;

  return toolSuccess(EXTRACTION_TOOLS_MESSAGES.classifyMeetingRegistered);
}

function applyRegisterSummaryToolCall(context: ToolCallHandlerContext): ToolApplicationResult {
  const { state, rawInput, reject } = context;
  if (state.summary !== null) {
    return reject(EXTRACTION_TOOLS_MESSAGES.registerSummaryOnce);
  }

  const parsed = registerSummaryInputSchema.parse(rawInput);
  state.summary = {
    short: parsed.short,
    bullets: parsed.bullets,
  };

  return toolSuccess(EXTRACTION_TOOLS_MESSAGES.summaryRegistered);
}

function applyRegisterDecisionToolCall(context: ToolCallHandlerContext): ToolApplicationResult {
  const { state, rawInput, transcriptLines } = context;
  const parsed = registerDecisionInputSchema.parse(rawInput);
  state.decisions = [
    ...state.decisions,
    {
      id: randomUUID(),
      text: parsed.text,
      finality: parsed.finality,
      confidence: parsed.confidence,
      sourceSpans: [resolveSourceSpan({ rawSpan: parsed.source_span, transcriptLines })],
    },
  ];

  return toolSuccess(EXTRACTION_TOOLS_MESSAGES.decisionRegistered);
}

function applyRegisterOpenQuestionToolCall(context: ToolCallHandlerContext): ToolApplicationResult {
  const { state, rawInput, transcriptLines } = context;
  const parsed = registerOpenQuestionInputSchema.parse(rawInput);
  state.openQuestions = [
    ...state.openQuestions,
    {
      id: randomUUID(),
      text: parsed.text,
      priority: parsed.priority,
      sourceSpans: [resolveSourceSpan({ rawSpan: parsed.source_span, transcriptLines })],
    },
  ];

  return toolSuccess(EXTRACTION_TOOLS_MESSAGES.openQuestionRegistered);
}

function applyRegisterHighlightToolCall(context: ToolCallHandlerContext): ToolApplicationResult {
  const { state, rawInput, transcriptLines } = context;
  const parsed = registerHighlightInputSchema.parse(rawInput);
  state.highlights = [
    ...state.highlights,
    {
      id: randomUUID(),
      theme: parsed.theme,
      takeaway: parsed.takeaway,
      sourceSpans: parsed.source_spans.map((sourceSpan) => resolveSourceSpan({ rawSpan: sourceSpan, transcriptLines })),
    },
  ];

  return toolSuccess(EXTRACTION_TOOLS_MESSAGES.highlightRegistered);
}

function applyRegisterKeyTopicToolCall(context: ToolCallHandlerContext): ToolApplicationResult {
  const { state, rawInput } = context;
  const parsed = registerKeyTopicInputSchema.parse(rawInput);
  state.keyTopics = [...state.keyTopics, parsed.topic];

  return toolSuccess(EXTRACTION_TOOLS_MESSAGES.keyTopicRegistered);
}

function applyRegisterSignalToolCall(context: ToolCallHandlerContext): ToolApplicationResult {
  const { state, rawInput, transcriptLines, reject } = context;
  const parsed = registerSignalInputSchema.parse(rawInput);
  if (state.signals.some((signal) => signal.key === parsed.key)) {
    return reject(EXTRACTION_TOOLS_MESSAGES.signalOncePerKey(parsed.key));
  }

  const sourceSpans = parsed.source_spans.map((sourceSpan) =>
    resolveSourceSpan({ rawSpan: sourceSpan, transcriptLines }),
  );
  state.signals = [
    ...state.signals,
    {
      key: parsed.key,
      namespace: "readymeet.core",
      confidence: parsed.confidence,
      sourceSpans,
      evidence: sourceSpansToSignalEvidence(sourceSpans),
      reasoning: parsed.reasoning,
      entities: {},
      sourcePhase: "signal_extraction",
      origin: { kind: "core_model" },
      createdAt: new Date().toISOString(),
    },
  ];

  return toolSuccess(EXTRACTION_TOOLS_MESSAGES.signalRegistered);
}

function applyFinishExtractionToolCall(context: ToolCallHandlerContext): ToolApplicationResult {
  const { state, rawInput, reject } = context;
  if (state.finished) {
    return reject(EXTRACTION_TOOLS_MESSAGES.finishExtractionOnce);
  }

  finishExtractionInputSchema.parse(rawInput);
  state.finished = true;

  return toolSuccess(EXTRACTION_TOOLS_MESSAGES.extractionFinished);
}

const TOOL_CALL_HANDLERS: Record<string, (context: ToolCallHandlerContext) => ToolApplicationResult> = {
  classify_meeting: applyClassifyMeetingToolCall,
  register_summary: applyRegisterSummaryToolCall,
  register_decision: applyRegisterDecisionToolCall,
  register_open_question: applyRegisterOpenQuestionToolCall,
  register_highlight: applyRegisterHighlightToolCall,
  register_key_topic: applyRegisterKeyTopicToolCall,
  register_signal: applyRegisterSignalToolCall,
  finish_extraction: applyFinishExtractionToolCall,
};

export function applyToolCall(input: {
  state: ToolApplicationState;
  toolName: string;
  rawInput: unknown;
  transcriptLines: TranscriptLineReference[];
}): ToolApplicationResult {
  const { state, toolName, rawInput, transcriptLines } = input;
  const reject = (message: string) => toolFailure({ state, toolName, rawInput, message });
  const context: ToolCallHandlerContext = { state, rawInput, transcriptLines, reject };

  try {
    if (toolName !== "finish_extraction") {
      ensureToolCallsAllowed(state);
    }

    const handler = TOOL_CALL_HANDLERS[toolName];
    if (handler === undefined) {
      return reject(EXTRACTION_TOOLS_MESSAGES.unknownTool(toolName));
    }

    return handler(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : EXTRACTION_TOOLS_MESSAGES.toolValidationFailed;

    return toolFailure({ state, toolName, rawInput, message });
  }
}
