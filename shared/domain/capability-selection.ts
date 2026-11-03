import { z } from "zod";

import {
  capabilityCategorySchema,
  meetingTypeSchema,
  signalKeySchema,
  signalReferenceSchema,
} from "./capability-catalog";
import { extractionConfidenceSchema } from "./meeting-extraction";

export const GUEST_MEETING_PREVIEW_SCOPE = "guest-preview-v1";

const MAX_CAPABILITY_PRIORITY = 100;

export const capabilitySelectionStatusValues = [
  "recommended",
  "meeting_type_mismatch",
  "excluded_by_signal",
  "required_signals_absent",
  "score_below_threshold",
  "outranked",
] as const;

export const capabilitySelectionStatusSchema = z.enum(capabilitySelectionStatusValues);

export const recommendationSignalMatchSchema = z.object({
  key: signalKeySchema,
  confidence: extractionConfidenceSchema,
  score: z.number().int().nonnegative(),
  description: z.string().trim().min(1).optional(),
});

export const recommendationMissingSignalSchema = z.object({
  key: signalKeySchema,
  description: z.string().trim().min(1).optional(),
});

export const recommendationExclusionSignalCheckSchema = z.object({
  key: signalKeySchema,
  present: z.boolean(),
  confidence: extractionConfidenceSchema.optional(),
  excluded: z.boolean(),
  description: z.string().trim().min(1).optional(),
});

export const capabilitySelectionCapabilitySchema = z.object({
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  category: capabilityCategorySchema,
  applicableMeetingTypes: z.array(meetingTypeSchema),
  requiredSignals: z.array(signalReferenceSchema),
  exclusionSignals: z.array(signalReferenceSchema),
  defaultPriority: z.number().int().min(1).max(MAX_CAPABILITY_PRIORITY),
});

export const capabilityRecommendationRowSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  extractionId: z.string().uuid(),
  capabilityKey: z.string().trim().min(1),
  rank: z.number().int().positive(),
  rawScore: z.number().int(),
  finalScore: z.number().int(),
  signalsMatched: z.array(recommendationSignalMatchSchema),
  signalsMissing: z.array(recommendationMissingSignalSchema),
  exclusionSignalsChecked: z.array(recommendationExclusionSignalCheckSchema),
  reasoning: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()),
  confidence: extractionConfidenceSchema,
  selectionPromptVersion: z.string().trim().min(1),
  selectionModel: z.string().trim().min(1),
  createdAt: z.string(),
});

export const capabilityRecommendationViewSchema = capabilityRecommendationRowSchema.extend({
  capability: capabilitySelectionCapabilitySchema.optional(),
});

export const capabilitySelectionConsideredSchema = z.object({
  capability: capabilitySelectionCapabilitySchema,
  rawScore: z.number().int(),
  finalScore: z.number().int(),
  signalsMatched: z.array(recommendationSignalMatchSchema),
  signalsMissing: z.array(recommendationMissingSignalSchema),
  exclusionSignalsChecked: z.array(recommendationExclusionSignalCheckSchema),
  status: capabilitySelectionStatusSchema,
});

export const capabilitySelectionResultSchema = z.object({
  recommendations: z.array(capabilityRecommendationViewSchema),
  considered: z.array(capabilitySelectionConsideredSchema),
});

export const suggestedActionRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "no_work_found",
  "skipped",
  "failed",
  "cancelled",
]);

export const suggestedActionRunPhaseSchema = z.enum([
  "reading_notes",
  "extracting_facts",
  "validating_evidence",
  "detecting_signals",
  "matching_agents",
  "preparing_work",
  "complete",
]);

export const suggestedActionStepStatusSchema = z.enum(["pending", "running", "completed", "skipped", "failed"]);

export const suggestedActionStepSchema = z.object({
  id: suggestedActionRunPhaseSchema.exclude(["complete"]),
  label: z.string().trim().min(1),
  status: suggestedActionStepStatusSchema,
});

export const suggestedActionRunResponseSchema = z.object({
  status: suggestedActionRunStatusSchema,
  phase: suggestedActionRunPhaseSchema,
  steps: z.array(suggestedActionStepSchema),
  selection: capabilitySelectionResultSchema.nullable(),
  message: z.string().trim().min(1).nullable(),
  startedAt: z.string().datetime().nullable().optional(),
  lastActivityAt: z.string().datetime().nullable().optional(),
  idleTimeoutAt: z.string().datetime().nullable().optional(),
  isStale: z.boolean().optional(),
});

export const aiWorkflowJobTypeSchema = z.enum([
  "finalize_meeting",
  "resolve_meeting_title",
  "meeting_post_end_pipeline",
  "generate_meeting_snapshot",
  "generate_meeting_tasks",
  "extract_meeting_content",
  "detect_meeting_signals",
  "select_capabilities",
  "draft_capability_payloads",
  "execute_capability_workflow",
  "run_meeting_research",
  "detect_live_meeting_tasks",
  "detect_ambient_context",
  "track_meeting",
  "research_ambient_entity",
  "enrich_ambient_context_image",
  "review_linear_tasks",
  "review_ashby_actions",
  "deliver_meeting_to_slack",
]);

export const aiWorkflowJobStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

export const aiWorkflowJobViewSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  extractionId: z.string().uuid().nullable(),
  type: aiWorkflowJobTypeSchema,
  scopeKey: z.string().trim().min(1).default("default"),
  status: aiWorkflowJobStatusSchema,
  phase: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  runAfter: z.string(),
  lockedBy: z.string().nullable(),
  lockedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const aiWorkflowJobsResponseSchema = z.object({
  jobs: z.array(aiWorkflowJobViewSchema),
});

export type CapabilitySelectionStatus = z.infer<typeof capabilitySelectionStatusSchema>;
export type RecommendationSignalMatch = z.infer<typeof recommendationSignalMatchSchema>;
export type RecommendationMissingSignal = z.infer<typeof recommendationMissingSignalSchema>;
export type RecommendationExclusionSignalCheck = z.infer<typeof recommendationExclusionSignalCheckSchema>;
export type CapabilitySelectionCapability = z.infer<typeof capabilitySelectionCapabilitySchema>;
export type CapabilityRecommendationRow = z.infer<typeof capabilityRecommendationRowSchema>;
export type CapabilityRecommendationView = z.infer<typeof capabilityRecommendationViewSchema>;
export type CapabilitySelectionConsidered = z.infer<typeof capabilitySelectionConsideredSchema>;
export type CapabilitySelectionResult = z.infer<typeof capabilitySelectionResultSchema>;
export type SuggestedActionRunStatus = z.infer<typeof suggestedActionRunStatusSchema>;
export type SuggestedActionRunPhase = z.infer<typeof suggestedActionRunPhaseSchema>;
export type SuggestedActionStepStatus = z.infer<typeof suggestedActionStepStatusSchema>;
export type SuggestedActionStep = z.infer<typeof suggestedActionStepSchema>;
export type SuggestedActionRunResponse = z.infer<typeof suggestedActionRunResponseSchema>;
export type AiWorkflowJobType = z.infer<typeof aiWorkflowJobTypeSchema>;
export type AiWorkflowJobStatus = z.infer<typeof aiWorkflowJobStatusSchema>;
export type AiWorkflowJobView = z.infer<typeof aiWorkflowJobViewSchema>;
