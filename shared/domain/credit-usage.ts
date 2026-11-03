import { z } from "zod";

export const aiCreditActionTypeValues = [
  "meeting_snapshot",
  "meeting_summary",
  "meeting_action_items",
  "meeting_ask",
  "coaching_feedback",
  "linear_issue_drafting",
  "followup_email_draft",
  "deep_meeting_analysis",
  "mail_surface_classification",
  "mail_thread_summary",
  "meeting_prep",
  "meeting_brief",
  "slack_delivery",
  "agent_workflow",
] as const;

export const aiCreditActionTypeSchema = z.enum(aiCreditActionTypeValues);

export const aiCreditUsageTotalsSchema = z.object({
  creditsCharged: z.number().int().nonnegative(),
  actualCostMicroUsd: z.number().int().nonnegative(),
  revenueMicroUsd: z.number().int().nonnegative(),
  profitMicroUsd: z.number().int(),
  grossMargin: z.number().nullable(),
  averageCostPerCreditMicroUsd: z.number().int().nonnegative(),
  pricePerCreditMicroUsd: z.number().int().positive(),
});

export const adminAiUsageBreakdownSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  creditsCharged: z.number().int().nonnegative(),
  actualCostMicroUsd: z.number().int().nonnegative(),
  revenueMicroUsd: z.number().int().nonnegative(),
  profitMicroUsd: z.number().int(),
  grossMargin: z.number().nullable(),
  eventCount: z.number().int().nonnegative(),
});

export const adminAiUsageSummarySchema = z.object({
  generatedAt: z.string(),
  range: z.object({
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
  }),
  totals: aiCreditUsageTotalsSchema,
  byActionType: z.array(adminAiUsageBreakdownSchema),
  byModel: z.array(adminAiUsageBreakdownSchema),
  warnings: z.array(z.string()).default([]),
});

export const adminAiUsageEventSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
    avatarUrl: z.string().nullable(),
  }),
  meeting: z
    .object({
      id: z.string().uuid(),
      title: z.string().min(1),
    })
    .nullable(),
  actionType: aiCreditActionTypeSchema,
  actionLabel: z.string().min(1),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  actualCostMicroUsd: z.number().int().nonnegative(),
  pricePerCreditMicroUsd: z.number().int().positive(),
  creditsCharged: z.number().int().nonnegative(),
  revenueMicroUsd: z.number().int().nonnegative(),
  profitMicroUsd: z.number().int(),
  grossMargin: z.number().nullable(),
  included: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
});

export const adminAiUsageSummaryResponseSchema = z.object({
  summary: adminAiUsageSummarySchema,
});

export const adminAiUsageEventsResponseSchema = z.object({
  events: z.array(adminAiUsageEventSchema),
  totalCount: z.number().int().nonnegative(),
});

export const userCreditUsageResponseSchema = z.object({
  usage: z.object({
    billingPeriod: z.object({
      startDate: z.string(),
      endDate: z.string(),
    }),
    creditsUsed: z.number().int().nonnegative(),
    actionCount: z.number().int().nonnegative(),
  }),
});

export type AiCreditActionType = z.infer<typeof aiCreditActionTypeSchema>;
export type AdminAiUsageSummary = z.infer<typeof adminAiUsageSummarySchema>;
export type AdminAiUsageEvent = z.infer<typeof adminAiUsageEventSchema>;
export type UserCreditUsage = z.infer<typeof userCreditUsageResponseSchema>["usage"];
