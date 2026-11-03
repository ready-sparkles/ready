import type { Meeting } from "@readymeet/shared";
import type { Query, UseQueryOptions } from "@tanstack/react-query";

import { getMeeting, getMeetingNotesView, listMeetings, resolveMeetingLink } from "../application/api";
import { meetingDetailQueryKey, meetingNotesViewQueryKey } from "../domain/query-keys";
import type { MeetingDetailPayload, MeetingNotesViewPayload } from "../domain/types";

const MEETING_QUERY_STALE_TIME_MS = 30_000;
const SESSION_REQUIRED = "Meetings require an authenticated session.";
const CALL_IN_REFRESH_INTERVAL_MS = 2_000;
const CALL_IN_MAX_READS = 10;

export function calendarReadyMeetingOptions(input: {
  session: { token: string; user: { id: string } } | null | undefined;
  code: string | null;
}): UseQueryOptions<Awaited<ReturnType<typeof resolveMeetingLink>>> {
  return {
    queryKey: ["calendar-ready-meeting-resolve", input.session?.user.id, input.code],
    queryFn: () => {
      if (!input.session || input.code === null) {
        throw new Error(SESSION_REQUIRED);
      }

      return resolveMeetingLink({ token: input.session.token, code: input.code });
    },
    staleTime: MEETING_QUERY_STALE_TIME_MS,
    /** @external React Query retry option */
    retry: false,
    refetchInterval: (query: Query<Awaited<ReturnType<typeof resolveMeetingLink>>>): number | false =>
      query.state.status === "success" &&
      (query.state.data?.meetingLink.callIn === null || query.state.data?.meetingLink.callIn === undefined) &&
      query.state.dataUpdateCount < CALL_IN_MAX_READS
        ? CALL_IN_REFRESH_INTERVAL_MS
        : false,
  };
}

type MeetingsScopeUser = { id?: string; workspaceId?: string } | null | undefined;
type WorkspaceMeetingsQueryKey = readonly ["meetings", string | undefined, string | undefined];

// Single source of truth for the account/workspace-scoped meeting-list cache key.
export function workspaceMeetingsQueryKey(user: MeetingsScopeUser): WorkspaceMeetingsQueryKey {
  return ["meetings", user?.workspaceId, user?.id] as const;
}

export function workspaceMeetingsOptions(
  session: { token: string; user: { id: string; workspaceId: string } } | null | undefined,
): UseQueryOptions<Meeting[]> {
  return {
    queryKey: workspaceMeetingsQueryKey(session?.user),
    queryFn: () => {
      if (session === null || session === undefined || session.token === "") {
        throw new Error(SESSION_REQUIRED);
      }

      return listMeetings(session.token);
    },
    enabled:
      session !== null &&
      session !== undefined &&
      session.token !== "" &&
      session.user.id !== "" &&
      session.user.workspaceId !== "",
    staleTime: MEETING_QUERY_STALE_TIME_MS,
  };
}

// Single source of truth for reading one meeting's detail, so every caller shares the cache and in-flight request.
export function meetingDetailOptions({
  session,
  meetingId,
}: {
  session: { token: string } | null | undefined;
  meetingId: string;
}): UseQueryOptions<MeetingDetailPayload> {
  return {
    queryKey: meetingDetailQueryKey(meetingId),
    queryFn: ({ signal }) => {
      if (session === null || session === undefined || session.token === "") {
        throw new Error(SESSION_REQUIRED);
      }

      return getMeeting({ token: session.token, meetingId, options: { signal } });
    },
    enabled: session !== null && session !== undefined && session.token !== "" && meetingId.length > 0,
    staleTime: MEETING_QUERY_STALE_TIME_MS,
    // Callers share this in-flight fetch, and the page owns failures (not-found view, Try again), so backoff would only delay them.
    retry: false,
  };
}

export function meetingNotesViewOptions({
  session,
  meetingId,
}: {
  session: { token: string } | null | undefined;
  meetingId: string;
}): UseQueryOptions<MeetingNotesViewPayload> {
  return {
    queryKey: meetingNotesViewQueryKey(meetingId),
    queryFn: ({ signal }) => {
      if (session === null || session === undefined || session.token === "") {
        throw new Error(SESSION_REQUIRED);
      }

      return getMeetingNotesView({ token: session.token, meetingId, signal });
    },
    enabled: session !== null && session !== undefined && session.token !== "" && meetingId.length > 0,
    staleTime: MEETING_QUERY_STALE_TIME_MS,
    // Callers share this in-flight fetch, and the page owns failures (not-found view, Try again), so backoff would only delay them.
    retry: false,
  };
}
