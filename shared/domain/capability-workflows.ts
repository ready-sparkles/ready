import { z } from "zod";

import { extractionConfidenceSchema, sourceSpanSchema } from "./meeting-extraction";

const groundedSourceSpanVerificationStatusSchema = z.enum(["verified", "corrected"]);

export const capabilityWorkflowStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_user",
  "ready",
  "completed",
  "failed",
  "needs_connection",
]);

export const capabilityWorkflowPhaseSchema = z.enum([
  "checking_connection",
  "reviewing_evidence",
  "scoping_issues",
  "validating_issue_evidence",
  "searching_linear",
  "preparing_drafts",
  "reading_meeting",
  "analyzing_meeting",
  "generating_feedback",
  "gathering_context",
  "drafting_plan",
  "awaiting_user_review",
  "revising_plan",
  "ready_to_sync",
  "syncing",
  "synced",
  "failed",
  "needs_connection",
]);

export const capabilityWorkflowMessageRoleSchema = z.enum(["user", "assistant", "system"]);

export const bugReportDuplicateIssueSchema = z.object({
  id: z.string().trim().min(1),
  identifier: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1),
  status: z.string().trim().min(1).nullable().optional(),
  url: z.string().url().nullable().optional(),
  rationale: z.string().trim().min(1),
});

export const bugReportLinearContextSchema = z.object({
  provider: z.literal("linear"),
  connected: z.boolean(),
  teamId: z.string().trim().min(1).nullable(),
  teamName: z.string().trim().min(1).nullable(),
  duplicateIssues: z.array(bugReportDuplicateIssueSchema).default([]),
  sampledFormat: z
    .object({
      quality: z.enum(["good", "poor", "unknown"]),
      notes: z.array(z.string().trim().min(1)).default([]),
      suggestedSections: z.array(z.string().trim().min(1)).default([]),
    })
    .default({
      quality: "unknown",
      notes: [],
      suggestedSections: [],
    }),
});

export const bugReportIssueEvidenceSpanSchema = sourceSpanSchema.extend({
  evidenceId: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  verificationStatus: groundedSourceSpanVerificationStatusSchema,
});

export const bugReportSkippedCandidateSchema = z.object({
  title: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  evidenceIds: z.array(z.string().trim().min(1)).default([]),
});

export const bugReportIssueDraftSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  severity: z.enum(["low", "medium", "high"]),
  impact: z.string().trim().min(1),
  reproductionContext: z.string().trim().min(1).nullable(),
  evidence: z.array(z.string().trim().min(1)).default([]),
  evidenceSpans: z.array(bugReportIssueEvidenceSpanSchema).default([]),
  scopeReason: z.string().trim().min(1).optional(),
  confidence: extractionConfidenceSchema.optional(),
  duplicateIssueIds: z.array(z.string().trim().min(1)).default([]),
  teamId: z.string().trim().min(1).nullable(),
  teamName: z.string().trim().min(1).nullable(),
  labels: z.array(z.string().trim().min(1)).default([]),
});

export const bugReportDraftSchema = bugReportIssueDraftSchema.extend({
  issues: z.array(bugReportIssueDraftSchema).default([]),
});

export const bugReportPlanSchema = z.object({
  summary: z.string().trim().min(1),
  suggestedAction: z.enum(["create_new_issue", "create_new_issue_with_duplicate_links"]),
  duplicateRationale: z.string().trim().min(1).nullable(),
  scopeReason: z.string().trim().min(1).optional(),
  confidence: extractionConfidenceSchema.optional(),
  skippedCandidates: z.array(bugReportSkippedCandidateSchema).default([]),
  draft: bugReportDraftSchema,
});

export const linearIssueResultSchema = z.object({
  provider: z.literal("linear"),
  issueId: z.string().trim().min(1),
  identifier: z.string().trim().min(1).nullable(),
  title: z.string().trim().min(1),
  url: z.string().url().nullable(),
  teamId: z.string().trim().min(1).nullable(),
  createdAt: z.string(),
});

const MEETING_COACHING_TITLE_MAX_CHARACTERS = 120;
const MEETING_COACHING_BODY_MAX_CHARACTERS = 700;
const MEETING_COACHING_DETAIL_MAX_CHARACTERS = 1200;
const MEETING_COACHING_SUMMARY_MAX_CHARACTERS = 500;
const MEETING_COACHING_FOLLOW_UP_ID_MAX_CHARACTERS = 80;
const MEETING_COACHING_FOLLOW_UP_LABEL_MAX_CHARACTERS = 96;
const MEETING_COACHING_FOLLOW_UP_PROMPT_MAX_CHARACTERS = 240;
const MEETING_COACHING_EVIDENCE_MAX_ITEMS = 2;
const MEETING_COACHING_REQUIRED_FEEDBACK_MIN_ITEMS = 1;
const MEETING_COACHING_FEEDBACK_MAX_ITEMS = 4;
const MEETING_COACHING_FOLLOW_UP_MIN_ITEMS = 2;
const MEETING_COACHING_FOLLOW_UP_MAX_ITEMS = 3;
const MEETING_COACHING_DETAIL_MAX_ITEMS = 4;

export const meetingCoachingEvidenceSnippetSchema = z.object({
  quote: z.string().trim().min(1),
  speaker: z.string().trim().min(1).nullable().default(null),
  timestamp: z.string().trim().min(1).nullable().default(null),
  segmentId: z.string().uuid().nullable().optional(),
});

export const meetingCoachingFeedbackPointSchema = z.object({
  title: z.string().trim().min(1).max(MEETING_COACHING_TITLE_MAX_CHARACTERS),
  body: z.string().trim().min(1).max(MEETING_COACHING_BODY_MAX_CHARACTERS),
  evidence: z.array(meetingCoachingEvidenceSnippetSchema).max(MEETING_COACHING_EVIDENCE_MAX_ITEMS).default([]),
});

export const meetingCoachingDetailFocusSchema = z.enum(["worked", "improve", "try_next", "custom"]);

export const meetingCoachingDetailParagraphSchema = z.object({
  body: z.string().trim().min(1).max(MEETING_COACHING_DETAIL_MAX_CHARACTERS),
  evidence: z.array(meetingCoachingEvidenceSnippetSchema).max(MEETING_COACHING_EVIDENCE_MAX_ITEMS).default([]),
});

export const meetingCoachingFollowUpPromptSchema = z.object({
  id: z.string().trim().min(1).max(MEETING_COACHING_FOLLOW_UP_ID_MAX_CHARACTERS),
  label: z.string().trim().min(1).max(MEETING_COACHING_FOLLOW_UP_LABEL_MAX_CHARACTERS),
  prompt: z.string().trim().min(1).max(MEETING_COACHING_FOLLOW_UP_PROMPT_MAX_CHARACTERS),
});

export const meetingCoachingFeedbackSchema = z.object({
  summary: z.string().trim().min(1).max(MEETING_COACHING_SUMMARY_MAX_CHARACTERS),
  whatWorked: z
    .array(meetingCoachingFeedbackPointSchema)
    .min(MEETING_COACHING_REQUIRED_FEEDBACK_MIN_ITEMS)
    .max(MEETING_COACHING_FEEDBACK_MAX_ITEMS),
  whatToImprove: z
    .array(meetingCoachingFeedbackPointSchema)
    .min(MEETING_COACHING_REQUIRED_FEEDBACK_MIN_ITEMS)
    .max(MEETING_COACHING_FEEDBACK_MAX_ITEMS),
  tryNextTime: z
    .array(meetingCoachingFeedbackPointSchema)
    .min(MEETING_COACHING_REQUIRED_FEEDBACK_MIN_ITEMS)
    .max(MEETING_COACHING_FEEDBACK_MAX_ITEMS),
  followUpPrompts: z
    .array(meetingCoachingFollowUpPromptSchema)
    .min(MEETING_COACHING_FOLLOW_UP_MIN_ITEMS)
    .max(MEETING_COACHING_FOLLOW_UP_MAX_ITEMS),
  detailFocus: meetingCoachingDetailFocusSchema.nullable().default(null),
  detailParagraphs: z.array(meetingCoachingDetailParagraphSchema).max(MEETING_COACHING_DETAIL_MAX_ITEMS).default([]),
  insufficientRequesterEvidence: z.boolean().default(false),
});

export const meetingCoachingContextSchema = z.object({
  provider: z.literal("meeting_coaching"),
  requester: z.object({
    userId: z.string().uuid(),
    displayName: z.string().trim().min(1),
    email: z.string().email(),
  }),
  meeting: z.object({
    id: z.string().uuid(),
    title: z.string().trim().min(1),
    meetingType: z.string().trim().min(1).nullable(),
    meetingTypeConfidence: extractionConfidenceSchema.nullable().optional(),
  }),
  requesterTurnCount: z.number().int().nonnegative(),
  participantCount: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
});

const assistantMeteringContextSchema = z
  .object({
    meetingId: z.string().uuid().nullable().optional(),
    jobId: z.string().uuid().nullable().optional(),
    workflowRunId: z.string().uuid().nullable().optional(),
  })
  .nullable()
  .optional();

export const meetingCoachingGenerationRequestSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  focus: z.string().trim().min(1).nullable().optional(),
  previousFeedback: meetingCoachingFeedbackSchema.nullable().optional(),
  metering: assistantMeteringContextSchema,
});

export const meetingCoachingGenerationResponseSchema = z.object({
  feedback: meetingCoachingFeedbackSchema,
  model: z.string().trim().min(1),
  promptVersion: z.string().trim().min(1),
});

export const capabilityWorkflowRunSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  recommendationId: z.string().uuid(),
  capabilityKey: z.string().trim().min(1),
  status: capabilityWorkflowStatusSchema,
  phase: capabilityWorkflowPhaseSchema,
  context: z.record(z.string(), z.unknown()),
  plan: z.record(z.string(), z.unknown()),
  draft: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

export const capabilityWorkflowMessageSchema = z.object({
  id: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  role: capabilityWorkflowMessageRoleSchema,
  content: z.string().trim().min(1),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const capabilityWorkflowsResponseSchema = z.object({
  workflows: z.array(capabilityWorkflowRunSchema),
});

export const capabilityWorkflowResponseSchema = z.object({
  workflow: capabilityWorkflowRunSchema,
  messages: z.array(capabilityWorkflowMessageSchema).default([]),
});

export const capabilityWorkflowMessageRequestSchema = z.object({
  content: z.string().trim().min(1),
});

export const updateCapabilityWorkflowDraftRequestSchema = z.object({
  draft: bugReportDraftSchema,
});

export const bugReportEvidenceBankItemSchema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  excerpt: z.string().trim().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  segmentIds: z.array(z.string().uuid()).default([]),
  verificationStatus: groundedSourceSpanVerificationStatusSchema,
});

export const bugReportDraftRevisionOperationSchema = z.enum([
  "keep",
  "remove",
  "restore",
  "merge",
  "split",
  "rewrite_title",
  "rewrite_description",
  "rewrite_issue",
  "reorder",
  "change_severity",
  "deduplicate",
  "unlink_related_issue",
  "add_issue",
  "unsupported",
]);

export const bugReportDraftRevisionRequestSchema = z.object({
  draft: bugReportDraftSchema,
  originalDraft: bugReportDraftSchema.nullable().optional(),
  evidenceBank: z.array(bugReportEvidenceBankItemSchema).default([]),
  context: bugReportLinearContextSchema,
  instruction: z.string().trim().min(1),
  previousSummary: z.string().trim().min(1).nullable().optional(),
  metering: assistantMeteringContextSchema,
});

export const bugReportDraftRevisionResponseSchema = z.object({
  draft: bugReportDraftSchema,
  summary: z.string().trim().min(1),
  operation: bugReportDraftRevisionOperationSchema,
});

export const bugReportIssuePlanCandidateSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  severity: z.enum(["low", "medium", "high"]),
  reproductionContext: z.string().trim().min(1).nullable(),
  evidenceIds: z.array(z.string().trim().min(1)).min(1),
  searchTerms: z.array(z.string().trim().min(1)).min(1),
  scopeReason: z.string().trim().min(1),
  confidence: extractionConfidenceSchema,
});

export const bugReportIssuePlanningRequestSchema = z.object({
  recommendation: z.object({
    reasoning: z.string().trim().min(1),
    payload: z.record(z.string(), z.unknown()),
    signalsMatched: z
      .array(
        z.object({
          key: z.string().trim().min(1),
          confidence: extractionConfidenceSchema,
          description: z.string().trim().min(1).optional(),
        }),
      )
      .default([]),
  }),
  evidenceBank: z.array(bugReportEvidenceBankItemSchema),
  metering: assistantMeteringContextSchema,
});

export const bugReportIssuePlanningResponseSchema = z.object({
  candidates: z.array(bugReportIssuePlanCandidateSchema).default([]),
  skippedCandidates: z.array(bugReportSkippedCandidateSchema).default([]),
  summary: z.string().trim().min(1),
});

export type CapabilityWorkflowStatus = z.infer<typeof capabilityWorkflowStatusSchema>;
export type CapabilityWorkflowPhase = z.infer<typeof capabilityWorkflowPhaseSchema>;
export type CapabilityWorkflowRun = z.infer<typeof capabilityWorkflowRunSchema>;
export type CapabilityWorkflowMessage = z.infer<typeof capabilityWorkflowMessageSchema>;
export type BugReportLinearContext = z.infer<typeof bugReportLinearContextSchema>;
export type BugReportPlan = z.infer<typeof bugReportPlanSchema>;
export type BugReportIssueDraft = z.infer<typeof bugReportIssueDraftSchema>;
export type BugReportDraft = z.infer<typeof bugReportDraftSchema>;
export type LinearIssueResult = z.infer<typeof linearIssueResultSchema>;
export type MeetingCoachingFeedback = z.infer<typeof meetingCoachingFeedbackSchema>;
export type MeetingCoachingContext = z.infer<typeof meetingCoachingContextSchema>;
export type MeetingCoachingGenerationRequest = z.infer<typeof meetingCoachingGenerationRequestSchema>;
export type MeetingCoachingGenerationResponse = z.infer<typeof meetingCoachingGenerationResponseSchema>;
export type BugReportDraftRevisionRequest = z.infer<typeof bugReportDraftRevisionRequestSchema>;
export type BugReportDraftRevisionResponse = z.infer<typeof bugReportDraftRevisionResponseSchema>;
export type BugReportIssueEvidenceSpan = z.infer<typeof bugReportIssueEvidenceSpanSchema>;
export type BugReportSkippedCandidate = z.infer<typeof bugReportSkippedCandidateSchema>;
export type BugReportEvidenceBankItem = z.infer<typeof bugReportEvidenceBankItemSchema>;
export type BugReportIssuePlanCandidate = z.infer<typeof bugReportIssuePlanCandidateSchema>;
export type BugReportIssuePlanningRequest = z.infer<typeof bugReportIssuePlanningRequestSchema>;
export type BugReportIssuePlanningResponse = z.infer<typeof bugReportIssuePlanningResponseSchema>;
