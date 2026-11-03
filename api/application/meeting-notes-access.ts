import {
  FALLBACK_SUMMARY_MODEL,
  FREE_PLAN_INCLUDED_NOTES_MEETINGS,
  hasPrivateBetaUnlimitedCredits,
  minimumNotesRunCredits,
  parseOpenAIModelPrices,
  spendableAiCredits,
  type UserPlan,
} from "@readymeet/shared";

import { apiEnv } from "../ports/api-env";
import { hasActiveSubscription } from "../ports/gate-stripe-billing";
import { repositories } from "../ports/repository-runtime";

import type { MeetingViewerRole } from "./meeting-dto";

export { FREE_PLAN_INCLUDED_NOTES_MEETINGS } from "@readymeet/shared";

export type MeetingNotesAccess = {
  /** @external meeting notes access payload */
  locked: boolean;
  reason: "upgrade_required" | "credits_required" | "signup_required" | null;
};

export function hasPaidNotesPlan(plan: UserPlan | null | undefined): boolean {
  return plan !== null && plan !== undefined && plan !== "free";
}

export function evaluateMeetingNotesAccess(input: {
  meetingStatus: string;
  viewerRole: MeetingViewerRole;
  userPlan: UserPlan | null;
  hasActiveSubscription: boolean;
  hasGrantCredits: boolean;
  hasAdminPlanIncludedCredits: boolean;
  hasTrialCredits: boolean;
  isTrialCappedMeeting: boolean;
  priorHostedStandardMeetings: number;
}): MeetingNotesAccess {
  if (input.meetingStatus !== "ended") {
    return {
      /** @external meeting notes access payload */
      locked: false,
      reason: null,
    };
  }

  if (input.viewerRole === "guest") {
    return {
      /** @external meeting notes access payload */
      locked: true,
      reason: "signup_required",
    };
  }

  const hasPaidAccess = hasPaidNotesPlan(input.userPlan) || input.hasActiveSubscription;
  if (input.hasGrantCredits || input.hasAdminPlanIncludedCredits) {
    return {
      /** @external meeting notes access payload */
      locked: false,
      reason: null,
    };
  }

  if (hasPaidAccess) {
    return {
      /** @external meeting notes access payload */
      locked: true,
      reason: "credits_required",
    };
  }

  if (!input.isTrialCappedMeeting) {
    return {
      /** @external meeting notes access payload */
      locked: false,
      reason: null,
    };
  }

  return input.priorHostedStandardMeetings < FREE_PLAN_INCLUDED_NOTES_MEETINGS
    ? {
        /** @external meeting notes access payload */
        locked: false,
        reason: null,
      }
    : {
        /** @external meeting notes access payload */
        locked: true,
        reason: "upgrade_required",
      };
}

/**
 * Credits the notes gate needs before it unlocks. Notes that still have to be
 * generated need enough for the smallest charged run the assistant will start;
 * otherwise the page would offer Generate notes and the run would be refused.
 */
function creditsNeededToUnlockNotes(input: { isNotesRunPending: boolean; workspacePlan: string | null }): number {
  if (!input.isNotesRunPending || (input.workspacePlan !== "pro" && input.workspacePlan !== "max")) {
    return 1;
  }
  const env = apiEnv();
  const price = parseOpenAIModelPrices(env.OPENAI_MODEL_PRICES_JSON)[env.OPENAI_MEETING_SNAPSHOT_MODEL];

  return minimumNotesRunCredits({ outputPerMillion: price?.outputPerMillion, plan: input.workspacePlan });
}

/**
 * Resolves the durable post-meeting notes gate for any route that exposes
 * notes-derived data. Keeping this here prevents dedicated feature endpoints
 * from drifting away from the meeting-detail paywall behavior.
 */
export async function resolveMeetingNotesAccess(input: {
  meeting: {
    id: string;
    status: string;
    kind: string;
    workspaceId: string;
    createdByUserId: string;
    createdAt: Date;
  };
  viewerRole: MeetingViewerRole;
  userId: string;
  summary?: { model: string } | null;
}): Promise<MeetingNotesAccess> {
  const { meeting } = input;
  if (meeting.status !== "ended") {
    return {
      /** @external meeting notes access payload */
      locked: false,
      reason: null,
    };
  }
  if (input.viewerRole === "guest") {
    return {
      /** @external meeting notes access payload */
      locked: true,
      reason: "signup_required",
    };
  }

  const [workspaceId, isActiveSubscription, summary] = await Promise.all([
    repositories().getMeetingAttendeeWorkspace({
      meetingId: meeting.id,
      userId: input.userId,
      hostWorkspaceId: meeting.workspaceId,
    }),
    hasActiveSubscription(input.userId),
    input.summary === undefined ? repositories().getSummaryForMeeting(meeting.id) : input.summary,
  ]);
  // An orphaned hold would otherwise lock notes against credits nobody is spending.
  await repositories().releaseStalePlanCreditReservations({ workspaceId });
  const isNotesRunPending = summary === null || summary.model === FALLBACK_SUMMARY_MODEL;
  const [workspaceCredits, heldCredits, userPlan, hasPrivateBetaProEntitlement, workspacePlan] = await Promise.all([
    repositories().getWorkspaceMemberCreditAccess({
      userId: input.userId,
      workspaceId,
    }),
    // Pending notes still need a run, and only this meeting's own run in flight
    // will settle and refund into it; another meeting's hold is not spendable here.
    repositories().sumHeldPlanCredits({
      userId: input.userId,
      workspaceId,
      ...(isNotesRunPending ? { meetingId: meeting.id } : {}),
    }),
    repositories().getUserPlan(input.userId),
    repositories().hasPrivateBetaProCreditEntitlement(input.userId),
    repositories().getWorkspacePlan(workspaceId),
  ]);

  const isTrialCappedMeeting = meeting.kind === "standard" && meeting.createdByUserId === input.userId;
  const {
    subscriptionActive: isWorkspaceSubscriptionActive,
    hasTrialCredits: hasWorkspaceTrialCredits,
    allowanceRemaining,
    poolBalance,
  } = workspaceCredits;
  const hasPaidAccess = hasPaidNotesPlan(userPlan) || isActiveSubscription || isWorkspaceSubscriptionActive;
  // Same balance and private-beta rule the assistant uses to admit (and size) notes generation,
  // so unlocked notes are never refused for credits the gate counted. Credits held by a run in
  // flight still count: the run settles to its real charge, so notes must not lock while it works.
  const hasGrantCredits =
    spendableAiCredits({ allowanceRemaining, poolBalance }) + heldCredits >=
    creditsNeededToUnlockNotes({ isNotesRunPending, workspacePlan });
  const hasAdminIncludedNotesCredits = hasPrivateBetaUnlimitedCredits({
    hasPrivateBetaProEntitlement,
    isWorkspaceSubscriptionActive,
  });
  const shouldCountTrialMeetings = isTrialCappedMeeting && !hasGrantCredits && !hasPaidAccess;
  const priorMeetings = shouldCountTrialMeetings
    ? await repositories().countOtherHostedTrialMeetings({
        userId: input.userId,
        meetingId: meeting.id,
        workspaceId,
      })
    : 0;

  return evaluateMeetingNotesAccess({
    meetingStatus: meeting.status,
    viewerRole: input.viewerRole,
    userPlan,
    hasActiveSubscription: isActiveSubscription || isWorkspaceSubscriptionActive,
    hasGrantCredits,
    hasAdminPlanIncludedCredits: hasAdminIncludedNotesCredits,
    hasTrialCredits: hasWorkspaceTrialCredits,
    isTrialCappedMeeting,
    priorHostedStandardMeetings: priorMeetings,
  });
}

/**
 * Guests who joined read the host's notes, so they see them exactly when the
 * host can: a host locked out for credits or plan never has notes shown to a guest.
 */
export async function resolveGuestMeetingNotesAccess(input: {
  meeting: Parameters<typeof resolveMeetingNotesAccess>[0]["meeting"];
}): Promise<MeetingNotesAccess> {
  return resolveMeetingNotesAccess({
    meeting: input.meeting,
    viewerRole: "host",
    userId: input.meeting.createdByUserId,
  });
}
