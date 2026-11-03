import { z } from "zod";

const MAX_ASHBY_NAME_LENGTH = 200;
const MAX_ASHBY_EVIDENCE_QUOTE_LENGTH = 200;
const MAX_ASHBY_EVIDENCE_PER_PROPOSAL = 20;
const MAX_ASHBY_PROPOSALS = 40;
const MAX_ASHBY_CLARIFICATION_LENGTH = 1_000;
const MAX_ASHBY_REVIEW_TEXT_LENGTH = 2_000;
const MAX_ASHBY_TARGET_ITEMS = 40;

export const ASHBY_REVIEW_PROMPT_VERSION = "ashby-review-v3-stage-only";
export const ashbyProposalSchema = z.object({
  kind: z.literal("stage"),
  candidateName: z.string().trim().min(1).max(MAX_ASHBY_NAME_LENGTH),
  candidateEmail: z.string().email().nullable(),
  jobTitle: z.string().trim().max(MAX_ASHBY_NAME_LENGTH).nullable(),
  stageName: z.string().trim().min(1).max(MAX_ASHBY_NAME_LENGTH),
  evidence: z
    .array(z.object({ segmentId: z.string().uuid(), quote: z.string().min(1).max(MAX_ASHBY_EVIDENCE_QUOTE_LENGTH) }))
    .min(1)
    .max(MAX_ASHBY_EVIDENCE_PER_PROPOSAL),
});
export const ashbyExtractionSchema = z.object({
  proposals: z.array(ashbyProposalSchema).max(MAX_ASHBY_PROPOSALS),
  clarification: z.string().max(MAX_ASHBY_CLARIFICATION_LENGTH).nullable(),
});
const optionSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export const ashbyReviewItemSchema = z.object({
  id: z.string().uuid(),
  proposal: ashbyProposalSchema,
  candidates: z.array(optionSchema.extend({ email: z.string().nullable() })),
  candidateId: z.string().nullable(),
  candidateName: z.string().nullable(),
  applications: z.array(optionSchema),
  applicationId: z.string().nullable(),
  stages: z.array(optionSchema),
  stageId: z.string().nullable(),
  currentStageId: z.string().nullable(),
  currentStageName: z.string().nullable(),
  userEdited: z.boolean().optional(),
  included: z.boolean(),
  status: z.enum(["pending", "completed", "unknown", "failed"]),
  error: z.string().nullable(),
});
export const ashbyReviewSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  inputHash: z.string(),
  connectionVersion: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum([
    "queued",
    "reviewing",
    "awaiting_user",
    "revising",
    "syncing",
    "completed",
    "no_matches",
    "failed",
    "stale",
    "dismissed",
  ]),
  corrections: z.array(z.string().max(MAX_ASHBY_REVIEW_TEXT_LENGTH)).optional(),
  items: z.array(ashbyReviewItemSchema),
  error: z.string().nullable(),
  clarification: z.string().nullable(),
  updatedAt: z.string(),
});
export const ashbyReviewResponseSchema = z.object({
  review: ashbyReviewSchema.nullable(),
  enabled: z.boolean().default(true),
});
export const ashbyReviewActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("revise"),
    revision: z.number().int(),
    instruction: z.string().trim().min(1).max(MAX_ASHBY_REVIEW_TEXT_LENGTH),
  }),
  z.object({
    action: z.literal("confirm"),
    revision: z.number().int(),
    itemIds: z.array(z.string().uuid()).min(1).max(MAX_ASHBY_TARGET_ITEMS),
  }),
  z.object({ action: z.literal("dismiss"), revision: z.number().int() }),
  z.object({
    action: z.literal("target"),
    revision: z.number().int(),
    itemId: z.string().uuid(),
    candidateId: z.string().nullable(),
    applicationId: z.string().nullable(),
    stageId: z.string().nullable(),
  }),
  z.object({ action: z.literal("retry"), revision: z.number().int() }),
]);
export type AshbyProposal = z.infer<typeof ashbyProposalSchema>;
export type AshbyReviewItem = z.infer<typeof ashbyReviewItemSchema>;
export type AshbyReview = z.infer<typeof ashbyReviewSchema>;
export type AshbyReviewAction = z.infer<typeof ashbyReviewActionSchema>;
