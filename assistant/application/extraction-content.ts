import {
  decisionFinalitySchema,
  type ExtractedDecision,
  type ExtractedHighlight,
  type ExtractedOpenQuestion,
  extractionConfidenceSchema,
  type MeetingExtraction,
  meetingExtractionSchema,
  meetingTypeSchema,
  openQuestionPrioritySchema,
  type SourceSpan,
} from "@readymeet/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { resolveSourceSpan, type TranscriptLineReference } from "./extraction-tools";

const HIGHLIGHT_THEME_MAX_CHARS = 40;
const HIGHLIGHT_TAKEAWAY_MAX_CHARS = 200;
const SUMMARY_BULLETS_MAX_COUNT = 6;
const KEY_TOPIC_MAX_CHARS = 80;

const parsedJsonObjectSchema = z.record(z.string(), z.unknown());

const EXTRACTION_VALIDATION_MESSAGES = {
  decisionRequiresSourceSpan: "decision requires at least one source span",
  openQuestionRequiresSourceSpan: "open question requires at least one source span",
  passOneInvalidJson: "Pass 1 output was not valid JSON",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const rawSourceSpanSchema = z.object({
  excerpt: z.string().trim().min(1),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
});

function hasSourceSpanInput(value: {
  source_span?: z.infer<typeof rawSourceSpanSchema>;
  source_spans?: z.infer<typeof rawSourceSpanSchema>[];
}): boolean {
  return value.source_span !== undefined || (value.source_spans?.length ?? 0) > 0;
}

const rawDecisionSchema = z
  .object({
    text: z.string().trim().min(1),
    finality: decisionFinalitySchema,
    confidence: extractionConfidenceSchema,
    source_spans: z.array(rawSourceSpanSchema).min(1).optional(),
    source_span: rawSourceSpanSchema.optional(),
  })
  .refine(hasSourceSpanInput, {
    message: EXTRACTION_VALIDATION_MESSAGES.decisionRequiresSourceSpan,
  });

const rawOpenQuestionSchema = z
  .object({
    text: z.string().trim().min(1),
    priority: openQuestionPrioritySchema,
    source_spans: z.array(rawSourceSpanSchema).min(1).optional(),
    source_span: rawSourceSpanSchema.optional(),
  })
  .refine(hasSourceSpanInput, {
    message: EXTRACTION_VALIDATION_MESSAGES.openQuestionRequiresSourceSpan,
  });

const rawHighlightSchema = z.object({
  theme: z.string().trim().min(1).max(HIGHLIGHT_THEME_MAX_CHARS),
  takeaway: z.string().trim().min(1).max(HIGHLIGHT_TAKEAWAY_MAX_CHARS),
  source_spans: z.array(rawSourceSpanSchema).min(1),
});

const humanReadableExtractionOutputSchema = z.object({
  classification: z.object({
    type: meetingTypeSchema,
    confidence: extractionConfidenceSchema,
    reasoning: z.string().trim().min(1),
  }),
  summary: z.object({
    short: z.string().trim().min(1),
    bullets: z.array(z.string().trim().min(1)).min(1).max(SUMMARY_BULLETS_MAX_COUNT),
  }),
  decisions: z.array(rawDecisionSchema).default([]),
  open_questions: z.array(rawOpenQuestionSchema).default([]),
  highlights: z.array(rawHighlightSchema).default([]),
  key_topics: z.array(z.string().trim().min(1).max(KEY_TOPIC_MAX_CHARS)).default([]),
});

type HumanReadableExtractionOutput = z.infer<typeof humanReadableExtractionOutputSchema>;

function normalizePassOneOutputForValidation(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const record = value;
  const summary = isRecord(record.summary) ? { ...record.summary } : record.summary;
  const highlights = Array.isArray(record.highlights)
    ? record.highlights.map((highlight: unknown) => {
        if (!isRecord(highlight)) {
          const unchangedHighlight: unknown = highlight;

          return unchangedHighlight;
        }

        const nextHighlight = { ...highlight };
        if (typeof nextHighlight.theme === "string") {
          nextHighlight.theme = nextHighlight.theme.trim().slice(0, HIGHLIGHT_THEME_MAX_CHARS).trim();
        }
        if (typeof nextHighlight.takeaway === "string") {
          nextHighlight.takeaway = nextHighlight.takeaway.trim().slice(0, HIGHLIGHT_TAKEAWAY_MAX_CHARS).trim();
        }

        return nextHighlight;
      })
    : record.highlights;
  if (isRecord(summary) && Array.isArray(summary.bullets)) {
    summary.bullets = summary.bullets.slice(0, SUMMARY_BULLETS_MAX_COUNT);
  }

  return {
    ...record,
    summary,
    highlights,
  };
}

function sourceSpansFor(params: {
  value: {
    source_span?: z.infer<typeof rawSourceSpanSchema>;
    source_spans?: z.infer<typeof rawSourceSpanSchema>[];
  };
  transcriptLines: TranscriptLineReference[];
}): SourceSpan[] {
  const spans = params.value.source_spans ?? (params.value.source_span !== undefined ? [params.value.source_span] : []);

  return spans.map((sourceSpan) => resolveSourceSpan({ rawSpan: sourceSpan, transcriptLines: params.transcriptLines }));
}

function tryParseJsonCandidate(candidate: string): z.infer<typeof parsedJsonObjectSchema> | null {
  try {
    return parsedJsonObjectSchema.parse(JSON.parse(candidate));
  } catch (error) {
    void error;
    const repaired = candidate
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/```/g, "")
      .trim();
    try {
      return parsedJsonObjectSchema.parse(JSON.parse(repaired));
    } catch (repairError) {
      void repairError;

      return null;
    }
  }
}

export function parsePossiblyMalformedJsonObject(rawText: string): unknown {
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  const braceSlice = firstBrace >= 0 && lastBrace > firstBrace ? rawText.slice(firstBrace, lastBrace + 1) : null;
  const candidates = [
    rawText,
    rawText
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim(),
    ...(braceSlice !== null ? [braceSlice] : []),
  ];

  const parsed = candidates.reduce<z.infer<typeof parsedJsonObjectSchema> | null>((found, candidate) => {
    if (found !== null) {
      return found;
    }

    return tryParseJsonCandidate(candidate);
  }, null);

  if (parsed === null) {
    throw new Error(EXTRACTION_VALIDATION_MESSAGES.passOneInvalidJson);
  }

  return parsed;
}

export function validateHumanReadableExtraction(input: {
  rawText: string;
  transcriptLines: TranscriptLineReference[];
  id: string;
  meetingId: string;
  participants: MeetingExtraction["participants"];
  status: MeetingExtraction["status"];
  extractionModel: string;
  extractionPromptVersion: string;
  transcriptHash: string;
  durationMs: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): MeetingExtraction {
  const rawObject = normalizePassOneOutputForValidation(parsePossiblyMalformedJsonObject(input.rawText));
  const parsed = humanReadableExtractionOutputSchema.parse(rawObject);
  const extraction = buildHumanReadableExtraction({
    parsed,
    transcriptLines: input.transcriptLines,
    id: input.id,
    meetingId: input.meetingId,
    participants: input.participants,
    status: input.status,
    extractionModel: input.extractionModel,
    extractionPromptVersion: input.extractionPromptVersion,
    transcriptHash: input.transcriptHash,
    durationMs: input.durationMs,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });

  return extraction;
}

function buildHumanReadableExtraction(input: {
  parsed: HumanReadableExtractionOutput;
  transcriptLines: TranscriptLineReference[];
  id: string;
  meetingId: string;
  participants: MeetingExtraction["participants"];
  status: MeetingExtraction["status"];
  extractionModel: string;
  extractionPromptVersion: string;
  transcriptHash: string;
  durationMs: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const decisions: ExtractedDecision[] = input.parsed.decisions.map((decision) => ({
    id: randomUUID(),
    text: decision.text,
    finality: decision.finality,
    confidence: decision.confidence,
    sourceSpans: sourceSpansFor({ value: decision, transcriptLines: input.transcriptLines }),
  }));
  const openQuestions: ExtractedOpenQuestion[] = input.parsed.open_questions.map((question) => ({
    id: randomUUID(),
    text: question.text,
    priority: question.priority,
    sourceSpans: sourceSpansFor({ value: question, transcriptLines: input.transcriptLines }),
  }));
  const highlights: ExtractedHighlight[] = input.parsed.highlights.map((highlight) => ({
    id: randomUUID(),
    theme: highlight.theme,
    takeaway: highlight.takeaway,
    sourceSpans: sourceSpansFor({ value: highlight, transcriptLines: input.transcriptLines }),
  }));

  return meetingExtractionSchema.parse({
    id: input.id,
    meetingId: input.meetingId,
    status: input.status,
    contentStatus: input.status,
    signalsStatus: "pending",
    meetingType: input.parsed.classification.type,
    meetingTypeConfidence: input.parsed.classification.confidence,
    meetingTypeReasoning: input.parsed.classification.reasoning,
    participants: input.participants,
    summaryShort: input.parsed.summary.short,
    summaryBullets: input.parsed.summary.bullets,
    decisions,
    actionItems: [],
    openQuestions,
    risks: [],
    highlights,
    keyTopics: input.parsed.key_topics,
    signals: [],
    failedToolCalls: [],
    extractionModel: input.extractionModel,
    extractionPromptVersion: input.extractionPromptVersion,
    transcriptHash: input.transcriptHash,
    durationMs: input.durationMs,
    startedAt: input.startedAt?.toISOString() ?? null,
    completedAt: input.completedAt?.toISOString() ?? null,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  });
}

export function hasUnverifiedSourceSpans(extraction: MeetingExtraction): boolean {
  const spanGroups = [
    ...extraction.decisions.map((item) => item.sourceSpans),
    ...extraction.openQuestions.map((item) => item.sourceSpans),
    ...extraction.highlights.map((item) => item.sourceSpans),
  ];

  return spanGroups.some((spans) => spans.some((span) => span.verificationStatus === "unverified"));
}
