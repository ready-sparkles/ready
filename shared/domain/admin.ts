import { z } from "zod";

import { acquisitionSchema } from "./acquisition";
import { userPlanSchema } from "./types";

export const adminAuthAccountSchema = z.object({
  provider: z.string().trim().min(1),
  providerAccountId: z.string().nullable().optional(),
  firstAuthenticatedAt: z.string(),
  lastAuthenticatedAt: z.string(),
  authCount: z.number().int().nonnegative(),
});

export const adminLlmModelUsageSchema = z.object({
  model: z.string().trim().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  monthCostMicroUsd: z.number().int().nonnegative(),
  callCount: z.number().int().nonnegative(),
  unpricedCallCount: z.number().int().nonnegative(),
});

export const adminUserRowSchema = z.object({
  acquisition: z
    .object({
      attribution: acquisitionSchema,
      analyticsEnabled: z.boolean(),
      firstPaidAt: z.string().nullable(),
      payments: z.array(z.object({ currency: z.string(), amountMinor: z.number(), count: z.number() })),
    })
    .nullable()
    .optional(),
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable(),
  plan: userPlanSchema,
  billing: z.object({
    source: z.enum(["none", "manual", "stripe_personal", "stripe_workspace", "manual_and_stripe"]),
    manualEntitlement: z.boolean(),
    personalSubscription: z
      .object({
        status: z.string(),
        planInterval: z.string(),
        currentPeriodEnd: z.string().nullable(),
        statusChangedAt: z.string(),
      })
      .nullable(),
    workspaceSubscriptions: z.array(
      z.object({
        workspaceId: z.string().uuid(),
        workspaceName: z.string(),
        status: z.string(),
        planInterval: z.string(),
        currentPeriodEnd: z.string().nullable(),
        statusChangedAt: z.string(),
        isBillingOwner: z.boolean(),
      }),
    ),
  }),
  createdAt: z.string(),
  authAccounts: z.array(adminAuthAccountSchema),
  firstAuthenticatedAt: z.string().nullable(),
  lastAuthenticatedAt: z.string().nullable(),
  authCount: z.number().int().nonnegative(),
  hostedMeetingsCount: z.number().int().nonnegative(),
  transcribedMeetingsCount: z.number().int().nonnegative(),
  activeMeetingsCount: z.number().int().nonnegative(),
  transcribedSeconds: z.number().int().nonnegative(),
  lastMeetingAt: z.string().nullable(),
  snapshotJobCount: z.number().int().nonnegative(),
  taskJobCount: z.number().int().nonnegative(),
  capabilityJobCount: z.number().int().nonnegative(),
  failedJobCount: z.number().int().nonnegative(),
  workflowRunCount: z.number().int().nonnegative(),
  workflowCompletedCount: z.number().int().nonnegative(),
  trackedCostMicroUsd: z.number().int().nonnegative(),
  trackedMonthCostMicroUsd: z.number().int().nonnegative(),
  creditUsage: z.object({
    creditsCharged: z.number().int().nonnegative(),
    monthCreditsCharged: z.number().int().nonnegative(),
    revenueMicroUsd: z.number().int().nonnegative(),
    monthRevenueMicroUsd: z.number().int().nonnegative(),
    actionCount: z.number().int().nonnegative(),
    monthActionCount: z.number().int().nonnegative(),
  }),
  costBreakdown: z.object({
    usageMicroUsd: z.number().int().nonnegative(),
    fixedInfraMicroUsd: z.number().int().nonnegative(),
    usageMonthMicroUsd: z.number().int().nonnegative(),
    fixedInfraMonthMicroUsd: z.number().int().nonnegative(),
    llmMicroUsd: z.number().int().nonnegative(),
    llmMonthMicroUsd: z.number().int().nonnegative(),
    llmUnpricedCallCount: z.number().int().nonnegative(),
    liveKitMicroUsd: z.number().int().nonnegative(),
    liveKitMonthMicroUsd: z.number().int().nonnegative(),
    liveKitParticipantSeconds: z.number().int().nonnegative(),
    liveKitMonthParticipantSeconds: z.number().int().nonnegative(),
    liveKitEventCount: z.number().int().nonnegative(),
    liveKitMonthEventCount: z.number().int().nonnegative(),
  }),
  llmUsageByModel: z.array(adminLlmModelUsageSchema),
});

export const adminWaitlistEntrySchema = z.object({
  id: z.string().uuid(),
  requestedAt: z.string(),
  updatedAt: z.string(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
    avatarUrl: z.string().nullable(),
    plan: userPlanSchema,
  }),
  authAccounts: z.array(adminAuthAccountSchema),
  firstAuthenticatedAt: z.string().nullable(),
  lastAuthenticatedAt: z.string().nullable(),
  authCount: z.number().int().nonnegative(),
  hostedMeetingsCount: z.number().int().nonnegative(),
  transcribedMeetingsCount: z.number().int().nonnegative(),
  transcribedSeconds: z.number().int().nonnegative(),
  lastMeetingAt: z.string().nullable(),
});

export const adminOpenRoomSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  roomName: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  host: z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
  }),
  activeParticipantCount: z.number().int().nonnegative(),
  participants: z.array(z.record(z.string(), z.unknown())),
  transcript: z.object({
    hasTranscript: z.boolean(),
    source: z.string().nullable(),
    mode: z.string().nullable(),
  }),
  livekitStatus: z.enum(["not_checked", "open", "closed", "unknown"]),
});

export const adminActiveProcessSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["ai_workflow_job", "capability_workflow", "active_assistant_turn"]),
  meetingId: z.string().uuid(),
  meetingTitle: z.string().min(1),
  userId: z.string().uuid(),
  userEmail: z.string().email(),
  label: z.string().min(1),
  status: z.string().min(1),
  phase: z.string().min(1),
  startedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const adminCostCategorySchema = z.object({
  category: z.string().min(1),
  costMicroUsd: z.number().int().nonnegative(),
  monthCostMicroUsd: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  unconfiguredEventCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const adminOverviewSchema = z.object({
  generatedAt: z.string(),
  global: z.object({
    authenticatedUserCount: z.number().int().nonnegative(),
    activeUserCount: z.number().int().nonnegative(),
    totalMeetingCount: z.number().int().nonnegative(),
    transcribedMeetingCount: z.number().int().nonnegative(),
    openRoomCount: z.number().int().nonnegative(),
    activeJobCount: z.number().int().nonnegative(),
    trackedCostMicroUsd: z.number().int().nonnegative(),
    trackedMonthCostMicroUsd: z.number().int().nonnegative(),
  }),
  users: z.array(adminUserRowSchema),
  waitlistEntries: z.array(adminWaitlistEntrySchema),
  openRooms: z.array(adminOpenRoomSchema),
  activeProcesses: z.array(adminActiveProcessSchema),
  costCategories: z.array(adminCostCategorySchema),
  warnings: z.array(z.string()).default([]),
});

export const adminOverviewResponseSchema = z.object({
  overview: adminOverviewSchema,
});

export type AdminOverview = z.infer<typeof adminOverviewSchema>;
