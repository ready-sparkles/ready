import { z } from "zod";

export const LINEAR_TASK_REVIEW_PROMPT_VERSION = "linear-task-review-v3";

const DUPLICATE_ISSUE_RATIONALE_MAX_CHARACTERS = 500;
const EVIDENCE_QUOTE_MAX_CHARACTERS = 2_000;
const ISSUE_DRAFT_FIELD_MAX_CHARACTERS = 3_000;
const REPRODUCTION_STEP_MAX_CHARACTERS = 500;
const REPRODUCTION_STEPS_MAX_ITEMS = 10;
const ISSUE_IMPACT_MAX_CHARACTERS = 2_000;
const ISSUE_EVIDENCE_MAX_ITEMS = 12;
const ISSUE_TITLE_MAX_CHARACTERS = 160;
const ISSUE_DESCRIPTION_MAX_CHARACTERS = 4_000;
const DUPLICATE_ISSUES_MAX_ITEMS = 5;
const SOURCE_QUOTES_MAX_ITEMS = 5;
const CONTEXT_QUOTES_MAX_ITEMS = 20;
const REVISION_INSTRUCTION_MAX_CHARACTERS = 2_000;
const MISSING_LINEAR_ISSUE_ERROR_MESSAGE = "Choose an existing Linear issue";

export const linearTaskReviewStatusSchema = z.enum([
  "queued",
  "reviewing",
  "awaiting_user",
  "revising",
  "syncing",
  "completed",
  "no_matches",
  "needs_connection",
  "failed",
  "stale",
]);

export const linearTaskReviewDecisionSchema = z.enum(["linear", "uncertain", "not_linear"]);
export const linearTaskReviewSyncStatusSchema = z.enum(["pending", "syncing", "created", "failed", "skipped"]);

export const linearTaskReviewExternalIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
});

export const linearTaskReviewDuplicateIssueSchema = linearTaskReviewExternalIssueSchema.extend({
  status: z.string().trim().min(1).nullable().default(null),
  rationale: z.string().trim().min(1).max(DUPLICATE_ISSUE_RATIONALE_MAX_CHARACTERS),
});

export const linearTaskReviewTargetActionSchema = z.enum(["create", "link_existing", "create_duplicate"]);

export const linearTaskReviewEvidenceSchema = z.object({
  quote: z.string().trim().min(1).max(EVIDENCE_QUOTE_MAX_CHARACTERS),
  speaker: z.string().trim().min(1).nullable(),
  timestamp: z.string().trim().min(1).nullable(),
  segmentId: z.string().uuid().nullable(),
});

export const linearTaskReviewIssueDraftSchema = z.object({
  problem: z.string().trim().min(1).max(ISSUE_DRAFT_FIELD_MAX_CHARACTERS),
  observedBehavior: z.string().trim().min(1).max(ISSUE_DRAFT_FIELD_MAX_CHARACTERS).nullable(),
  expectedBehavior: z.string().trim().min(1).max(ISSUE_DRAFT_FIELD_MAX_CHARACTERS).nullable(),
  requestedChange: z.string().trim().min(1).max(ISSUE_DRAFT_FIELD_MAX_CHARACTERS).nullable(),
  reproductionSteps: z
    .array(z.string().trim().min(1).max(REPRODUCTION_STEP_MAX_CHARACTERS))
    .max(REPRODUCTION_STEPS_MAX_ITEMS)
    .default([]),
  impact: z.string().trim().min(1).max(ISSUE_IMPACT_MAX_CHARACTERS).nullable(),
  evidence: z.array(linearTaskReviewEvidenceSchema).min(1).max(ISSUE_EVIDENCE_MAX_ITEMS),
});

export const linearTaskReviewItemSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  sourceTaskIds: z.array(z.string().uuid()).min(1),
  decision: linearTaskReviewDecisionSchema.exclude(["not_linear"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().trim().min(1),
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX_CHARACTERS),
  description: z.string().trim().max(ISSUE_DESCRIPTION_MAX_CHARACTERS).nullable(),
  issueDraft: linearTaskReviewIssueDraftSchema.nullable().default(null),
  teamId: z.string().trim().min(1).nullable(),
  teamName: z.string().trim().min(1).nullable(),
  included: z.boolean(),
  syncStatus: linearTaskReviewSyncStatusSchema,
  syncError: z.string().nullable(),
  duplicateIssues: z.array(linearTaskReviewDuplicateIssueSchema).max(DUPLICATE_ISSUES_MAX_ITEMS).default([]),
  targetAction: linearTaskReviewTargetActionSchema.default("create"),
  targetIssue: linearTaskReviewExternalIssueSchema.nullable().default(null),
  relationId: z.string().nullable().default(null),
  meetingContextSyncedAt: z.string().datetime().nullable().default(null),
  externalIssue: linearTaskReviewExternalIssueSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const linearTaskReviewRunSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  taskListId: z.string().uuid(),
  userId: z.string().uuid(),
  connectorId: z.string().uuid().nullable(),
  status: linearTaskReviewStatusSchema,
  phase: z.string().trim().min(1),
  inputHash: z.string().trim().min(1),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  items: z.array(linearTaskReviewItemSchema),
});

export const linearTaskReviewTaskInputSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1),
  description: z.string().trim().nullable(),
  taskType: z.string().trim().min(1),
  workKind: z.string().trim().min(1),
  assigneeName: z.string().trim().nullable(),
  dueDate: z.string().trim().nullable(),
  sourceQuotes: z.array(linearTaskReviewEvidenceSchema).min(1).max(SOURCE_QUOTES_MAX_ITEMS),
  contextQuotes: z.array(linearTaskReviewEvidenceSchema).max(CONTEXT_QUOTES_MAX_ITEMS).default([]),
  assetIds: z.array(z.string().uuid()).default([]),
});

export const linearTaskReviewTeamSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  key: z.string().trim().min(1),
});

export const linearTaskReviewCandidateSchema = z.object({
  sourceTaskIds: z.array(z.string().uuid()).min(1),
  decision: linearTaskReviewDecisionSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().trim().min(1),
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX_CHARACTERS),
  description: z.string().trim().max(ISSUE_DESCRIPTION_MAX_CHARACTERS).nullable(),
  issueDraft: linearTaskReviewIssueDraftSchema.nullable().default(null),
  teamId: z.string().trim().min(1).nullable(),
  teamName: z.string().trim().min(1).nullable(),
  duplicateIssues: z.array(linearTaskReviewDuplicateIssueSchema).max(DUPLICATE_ISSUES_MAX_ITEMS).default([]),
  targetAction: linearTaskReviewTargetActionSchema.default("create"),
  targetIssue: linearTaskReviewExternalIssueSchema.nullable().default(null),
  relationId: z.string().nullable().default(null),
});

export const linearTaskReviewClassificationRequestSchema = z
  .object({
    meetingId: z.string().uuid(),
    jobId: z.string().uuid().nullable().optional(),
    tasks: z.array(linearTaskReviewTaskInputSchema).min(1),
    availableTeams: z.array(linearTaskReviewTeamSchema).min(1),
  })
  .strict();

export const linearTaskReviewClassificationResponseSchema = z.object({
  candidates: z.array(linearTaskReviewCandidateSchema),
  model: z.string().trim().min(1),
  promptVersion: z.literal(LINEAR_TASK_REVIEW_PROMPT_VERSION),
});

export const linearTaskReviewRevisionRequestSchema = z
  .object({
    meetingId: z.string().uuid(),
    runId: z.string().uuid(),
    instruction: z.string().trim().min(1).max(REVISION_INSTRUCTION_MAX_CHARACTERS),
    tasks: z.array(linearTaskReviewTaskInputSchema).min(1),
    currentCandidates: z.array(linearTaskReviewCandidateSchema).min(1),
    availableTeams: z.array(linearTaskReviewTeamSchema).min(1),
  })
  .strict();

export const reviseLinearTaskReviewRequestSchema = z.object({
  instruction: z.string().trim().min(1).max(REVISION_INSTRUCTION_MAX_CHARACTERS),
});

export const updateLinearTaskReviewTargetRequestSchema = z
  .object({
    action: linearTaskReviewTargetActionSchema,
    issueId: z.string().trim().min(1).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "create" && value.issueId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issueId"],
        message: MISSING_LINEAR_ISSUE_ERROR_MESSAGE,
      });
    }
  });

export const linearTaskReviewResponseSchema = z.object({
  review: linearTaskReviewRunSchema.nullable(),
});

export type LinearTaskReviewStatus = z.infer<typeof linearTaskReviewStatusSchema>;
export type LinearTaskReviewDecision = z.infer<typeof linearTaskReviewDecisionSchema>;
export type LinearTaskReviewSyncStatus = z.infer<typeof linearTaskReviewSyncStatusSchema>;
export type LinearTaskReviewExternalIssue = z.infer<typeof linearTaskReviewExternalIssueSchema>;
export type LinearTaskReviewDuplicateIssue = z.infer<typeof linearTaskReviewDuplicateIssueSchema>;
export type LinearTaskReviewTargetAction = z.infer<typeof linearTaskReviewTargetActionSchema>;
export type LinearTaskReviewIssueDraft = z.infer<typeof linearTaskReviewIssueDraftSchema>;
export type LinearTaskReviewItem = z.infer<typeof linearTaskReviewItemSchema>;
export type LinearTaskReviewRun = z.infer<typeof linearTaskReviewRunSchema>;
export type LinearTaskReviewTaskInput = z.infer<typeof linearTaskReviewTaskInputSchema>;
export type LinearTaskReviewTeam = z.infer<typeof linearTaskReviewTeamSchema>;
export type LinearTaskReviewCandidate = z.infer<typeof linearTaskReviewCandidateSchema>;
export type LinearTaskReviewClassificationRequest = z.infer<typeof linearTaskReviewClassificationRequestSchema>;
export type LinearTaskReviewClassificationResponse = z.infer<typeof linearTaskReviewClassificationResponseSchema>;
export type LinearTaskReviewRevisionRequest = z.infer<typeof linearTaskReviewRevisionRequestSchema>;
