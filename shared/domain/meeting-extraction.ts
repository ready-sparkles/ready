import { z } from "zod";

import { meetingTypeSchema } from "./capability-catalog";

const MAX_SIGNAL_THEME_LENGTH = 40;
const MAX_SIGNAL_TAKEAWAY_LENGTH = 200;

export const extractionStatusSchema = z.enum(["pending", "running", "completed", "partial", "failed"]);

export const extractionConfidenceSchema = z.enum(["low", "medium", "high"]);
export const sourceSpanVerificationStatusSchema = z.enum(["verified", "corrected", "unverified"]);
export const decisionFinalitySchema = z.enum(["final", "tentative", "provisional"]);
export const openQuestionPrioritySchema = z.enum(["low", "medium", "high"]);
export const riskSeveritySchema = z.enum(["low", "medium", "high"]);

export const sourceSpanSchema = z.object({
  excerpt: z.string().trim().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  segmentIds: z.array(z.string().uuid()).default([]),
  startedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  verificationStatus: sourceSpanVerificationStatusSchema.optional(),
  verificationReason: z.string().trim().min(1).optional(),
});

export const extractedParticipantSchema = z.object({
  name: z.string().trim().min(1),
  roleHint: z.string().trim().min(1).nullable().optional(),
  confidence: extractionConfidenceSchema,
});

export const extractedDecisionSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1),
  finality: decisionFinalitySchema,
  confidence: extractionConfidenceSchema,
  sourceSpans: z.array(sourceSpanSchema).min(1),
});

export const extractedOwnerHintSchema = z.object({
  name: z.string().trim().min(1),
  confidence: extractionConfidenceSchema,
});

export const extractedDueHintSchema = z.object({
  text: z.string().trim().min(1),
  isoDate: z.string().trim().min(1).nullable().optional(),
  confidence: extractionConfidenceSchema,
});

export const extractedActionItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1),
  ownerHint: extractedOwnerHintSchema.optional(),
  dueHint: extractedDueHintSchema.optional(),
  description: z.string().trim().min(1).optional(),
  confidence: extractionConfidenceSchema,
  sourceSpans: z.array(sourceSpanSchema).min(1),
});

export const extractedOpenQuestionSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1),
  priority: openQuestionPrioritySchema,
  sourceSpans: z.array(sourceSpanSchema).min(1),
});

export const extractedRiskSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1),
  severity: riskSeveritySchema,
  sourceSpans: z.array(sourceSpanSchema).min(1),
});

export const extractedHighlightSchema = z.object({
  id: z.string().uuid(),
  theme: z.string().trim().min(1).max(MAX_SIGNAL_THEME_LENGTH),
  takeaway: z.string().trim().min(1).max(MAX_SIGNAL_TAKEAWAY_LENGTH),
  sourceSpans: z.array(sourceSpanSchema).min(1),
});

export const signalNamespaceSchema = z.enum([
  "readymeet.core",
  "readymeet.engineering",
  "readymeet.sales",
  "user",
  "agent",
]);

export const signalSourcePhaseSchema = z.enum([
  "content_extraction",
  "signal_extraction",
  "deterministic_inference",
  "custom_signal_detection",
  "manual_override",
]);

export const signalOriginKindSchema = z.enum(["core_model", "core_rule", "custom_model", "custom_rule", "manual"]);

export const signalEvidenceSchema = sourceSpanSchema.extend({
  sourceSpanIndex: z.number().int().nonnegative().optional(),
});

export const signalOriginSchema = z.object({
  kind: signalOriginKindSchema,
  model: z.string().trim().min(1).optional(),
  promptVersion: z.string().trim().min(1).optional(),
  ruleId: z.string().trim().min(1).optional(),
  signalDefinitionVersion: z.string().trim().min(1).optional(),
});

export const signalPresenceSchema = z.object({
  key: z.string().trim().min(1),
  namespace: signalNamespaceSchema.optional(),
  definitionId: z.string().trim().min(1).nullable().optional(),
  confidence: extractionConfidenceSchema,
  sourceSpans: z.array(sourceSpanSchema).min(1),
  evidence: z.array(signalEvidenceSchema).optional(),
  entities: z.record(z.string(), z.unknown()).optional(),
  sourcePhase: signalSourcePhaseSchema.optional(),
  origin: signalOriginSchema.optional(),
  reasoning: z.string().trim().min(1).optional(),
  createdAt: z.string().optional(),
});

export const failedToolCallSchema = z.object({
  toolName: z.string().trim().min(1),
  rawInput: z.unknown(),
  error: z.string().trim().min(1),
  occurredAt: z.string(),
});

export const meetingExtractionSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  status: extractionStatusSchema,
  contentStatus: extractionStatusSchema.default("pending"),
  signalsStatus: extractionStatusSchema.default("pending"),
  meetingType: meetingTypeSchema.nullable(),
  meetingTypeConfidence: extractionConfidenceSchema.nullable(),
  meetingTypeReasoning: z.string().trim().min(1).nullable(),
  participants: z.array(extractedParticipantSchema),
  summaryShort: z.string().trim().min(1).nullable(),
  summaryBullets: z.array(z.string().trim().min(1)),
  decisions: z.array(extractedDecisionSchema),
  actionItems: z.array(extractedActionItemSchema),
  openQuestions: z.array(extractedOpenQuestionSchema),
  risks: z.array(extractedRiskSchema),
  highlights: z.array(extractedHighlightSchema),
  keyTopics: z.array(z.string().trim().min(1)),
  signals: z.array(signalPresenceSchema),
  failedToolCalls: z.array(failedToolCallSchema),
  extractionModel: z.string().trim().min(1),
  extractionPromptVersion: z.string().trim().min(1),
  transcriptHash: z.string().trim().min(1),
  durationMs: z.number().int().nonnegative().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;
export type ExtractionConfidence = z.infer<typeof extractionConfidenceSchema>;
export type SourceSpanVerificationStatus = z.infer<typeof sourceSpanVerificationStatusSchema>;
export type SourceSpan = z.infer<typeof sourceSpanSchema>;
export type SignalNamespace = z.infer<typeof signalNamespaceSchema>;
export type SignalSourcePhase = z.infer<typeof signalSourcePhaseSchema>;
export type SignalOriginKind = z.infer<typeof signalOriginKindSchema>;
export type SignalEvidence = z.infer<typeof signalEvidenceSchema>;
export type SignalOrigin = z.infer<typeof signalOriginSchema>;
export type ExtractedParticipant = z.infer<typeof extractedParticipantSchema>;
export type ExtractedDecision = z.infer<typeof extractedDecisionSchema>;
export type ExtractedActionItem = z.infer<typeof extractedActionItemSchema>;
export type ExtractedOpenQuestion = z.infer<typeof extractedOpenQuestionSchema>;
export type ExtractedRisk = z.infer<typeof extractedRiskSchema>;
export type ExtractedHighlight = z.infer<typeof extractedHighlightSchema>;
export type SignalPresence = z.infer<typeof signalPresenceSchema>;
export type FailedToolCall = z.infer<typeof failedToolCallSchema>;
export type MeetingExtraction = z.infer<typeof meetingExtractionSchema>;
