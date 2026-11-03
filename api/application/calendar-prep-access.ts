import type { UserPlan } from "@readymeet/shared";

import { hasActiveSubscription } from "../ports/gate-stripe-billing";
import { repositories } from "../ports/repository-runtime";

export const FREE_PLAN_INCLUDED_CALENDAR_PREPS = 1;

type CalendarPrepAccess = {
  canStartCalendarPrep: boolean;
  freeCalendarPrepLimit: number;
  // @external hasPrepPlan
  hasPrepPlan: boolean;
  calendarPrepCount: number;
  // @external requiresGrantCredits
  requiresGrantCredits: boolean;
};

export class CalendarPrepPlanRequiredError extends Error {
  readonly code = "calendar_prep_plan_required";

  constructor(readonly prepAccess: CalendarPrepAccess) {
    super("Meeting research is available on Pro.");
  }
}

export class CalendarPrepCreditsRequiredError extends Error {
  readonly code = "calendar_prep_credits_required";

  constructor(readonly creditAccess: { requiredCredits: number; availableCredits: number }) {
    super("Add credits to run meeting prep.");
  }
}

function hasPaidCalendarPrepPlan(plan: UserPlan | null | undefined): boolean {
  return plan !== null && plan !== undefined && plan !== "free";
}

export function evaluateCalendarPrepAccess(input: {
  userPlan: UserPlan | null;
  // @external hasActiveSubscription
  hasActiveSubscription: boolean;
  // @external hasPrivateBetaProEntitlement
  hasPrivateBetaProEntitlement: boolean;
  calendarPrepCount: number;
}): CalendarPrepAccess {
  const hasPrivateBetaProPlan =
    input.hasPrivateBetaProEntitlement && hasPaidCalendarPrepPlan(input.userPlan) && !input.hasActiveSubscription;
  const hasPrepPlan = hasPrivateBetaProPlan || input.hasActiveSubscription;

  return {
    canStartCalendarPrep: hasPrepPlan || input.calendarPrepCount < FREE_PLAN_INCLUDED_CALENDAR_PREPS,
    freeCalendarPrepLimit: FREE_PLAN_INCLUDED_CALENDAR_PREPS,
    hasPrepPlan,
    calendarPrepCount: input.calendarPrepCount,
    requiresGrantCredits:
      !hasPrivateBetaProPlan &&
      !(
        input.userPlan === "free" &&
        !input.hasActiveSubscription &&
        input.calendarPrepCount < FREE_PLAN_INCLUDED_CALENDAR_PREPS
      ),
  };
}

export function shouldRequireCalendarPrepGrantCredits(access: CalendarPrepAccess): boolean {
  return access.requiresGrantCredits;
}

export async function getCalendarPrepAccessForUser(userId: string): Promise<CalendarPrepAccess> {
  const user = await repositories().getUserById(userId);
  const [userPlan, isSubscriptionActive, isPrivateBetaProEntitled, calendarPrepCount, workspaceCredits] =
    await Promise.all([
      repositories().getUserPlan(userId),
      hasActiveSubscription(userId),
      repositories().hasPrivateBetaProCreditEntitlement(userId),
      repositories().countUserMeteredCalendarEventPreps(userId),
      (() => {
        const workspaceId = user?.workspaceId ?? null;

        return workspaceId !== null && workspaceId !== ""
          ? repositories().getWorkspaceMemberCreditAccess({ userId, workspaceId })
          : Promise.resolve(null);
      })(),
    ]);

  return evaluateCalendarPrepAccess({
    userPlan,
    hasActiveSubscription: isSubscriptionActive || Boolean(workspaceCredits?.subscriptionActive),
    hasPrivateBetaProEntitlement: isPrivateBetaProEntitled,
    calendarPrepCount,
  });
}
