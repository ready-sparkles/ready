"use client";

import type { WorkspaceMemberBilling } from "@readymeet/shared";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { getWorkspaceMemberBilling } from "../../composition/api";
import { useAuth } from "../components/auth-provider";

const TRIAL_OFFER_REFRESH_MS = 15_000;
const TRIAL_OFFER_MEETING_COUNT = 3;
const MISSING_TRIAL_OFFER_SCOPE = "Trial offer requires a token and workspace.";

const hasText = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

const workspaceLabel = (workspaceId: string | null | undefined): string =>
  typeof workspaceId === "string" ? workspaceId : String(workspaceId);

export function useTrialOffer(
  ...args: [token?: string | null, workspaceId?: string | null]
): UseQueryResult<WorkspaceMemberBilling> & { hasKnownPlan: boolean; remaining: number } {
  const [token, workspaceId] = args;
  const { session } = useAuth();
  const client = useQueryClient();
  const hasScope = hasText(token) && hasText(workspaceId);
  const query = useQuery({
    queryKey: ["workspace-trial-offer", workspaceId, session?.user.id],
    queryFn: () => {
      if (!hasText(token) || !hasText(workspaceId)) {
        throw new Error(MISSING_TRIAL_OFFER_SCOPE);
      }

      return getWorkspaceMemberBilling({ token, workspaceId });
    },
    enabled: hasScope,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: TRIAL_OFFER_REFRESH_MS,
  });
  const hasKnownPlan = hasScope && query.data !== undefined;
  const access =
    query.data === undefined
      ? null
      : `${workspaceLabel(workspaceId)}:${query.data.plan}:${String(query.data.subscriptionActive)}:${query.data.checkout?.status ?? ""}`;
  const previousAccess = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousAccess.current;
    if (hasText(access) && hasText(previous) && previous !== access) {
      void client.invalidateQueries({ queryKey: ["meetingDetail"] });
      void client.invalidateQueries({ queryKey: ["relationship-memory"] });
    }
    if (hasText(access)) {
      previousAccess.current = access;
    }
  }, [access, client]);

  return {
    ...query,
    hasKnownPlan,
    // Require a fresh response on mount, but keep the panel stable during background polling.
    remaining: hasScope && query.isFetchedAfterMount && !query.isError ? (query.data?.trialMeetingsRemaining ?? 0) : 0,
  };
}

export function trialOfferTitle(remaining: number): string | null {
  if (remaining <= 0) {
    return null;
  }

  return remaining >= TRIAL_OFFER_MEETING_COUNT
    ? `Try up to ${TRIAL_OFFER_MEETING_COUNT} meetings, on us.`
    : `${remaining} free ${remaining === 1 ? "meeting" : "meetings"} remaining.`;
}
