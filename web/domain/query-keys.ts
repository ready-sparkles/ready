type CalendarEventPrepInput = {
  id: string;
  providerEventId?: string;
  title: string;
  start: string;
  end: string;
  location?: string | null;
  organizer?: { name: string | null; email: string | null } | null;
  attendees?: { name: string | null; email: string | null }[];
};

const QUERY_KEY_ANONYMOUS_USER = "anonymous";
const QUERY_KEY_NONE = "none";
const QUERY_KEY_EMPTY = "";

function resolveUserScope(userId: string | null | undefined): string {
  return userId ?? QUERY_KEY_ANONYMOUS_USER;
}

function buildCalendarEventPeopleKey(event: CalendarEventPrepInput | null | undefined): string {
  const organizerKey = event?.organizer
    ? `${event.organizer.name ?? QUERY_KEY_EMPTY}:${event.organizer.email ?? QUERY_KEY_EMPTY}`
    : QUERY_KEY_EMPTY;
  const attendeeKeys = (event?.attendees ?? []).map(
    (attendee) => `${attendee.name ?? QUERY_KEY_EMPTY}:${attendee.email ?? QUERY_KEY_EMPTY}`,
  );

  return [organizerKey, ...attendeeKeys].join("|");
}

export function meetingDetailQueryKey(meetingId: string): readonly ["meetingDetail", string] {
  return ["meetingDetail", meetingId] as const;
}

export function activeMeetingTasksStatusQueryKey(meetingId: string): readonly ["meetingTasksStatus", string] {
  return ["meetingTasksStatus", meetingId] as const;
}

export function terminalMeetingTasksStatusQueryKey(
  meetingId: string,
): readonly [
  "meetingTasksStatus",
  string,
  { /** @external persisted meeting task status query option */ terminal: true },
] {
  return [
    "meetingTasksStatus",
    meetingId,
    { /** @external persisted meeting task status query option */ terminal: true },
  ] as const;
}

export function assignedTasksQueryKey(
  userId: string | null | undefined,
): readonly ["assignedTasks", "all-workspaces", string] {
  return ["assignedTasks", "all-workspaces", resolveUserScope(userId)] as const;
}

export function personalAssignedTasksQueryKey(
  userId: string | null | undefined,
): readonly ["assignedTasks", "personal", string] {
  return ["assignedTasks", "personal", resolveUserScope(userId)] as const;
}

export function workspaceAssignedTasksQueryKey(
  ...args: [workspaceId: string | null | undefined, userId: string | null | undefined]
): readonly ["assignedTasks", "workspace", string, string] {
  const [workspaceId, userId] = args;

  return ["assignedTasks", "workspace", workspaceId ?? QUERY_KEY_NONE, resolveUserScope(userId)] as const;
}

export function assignedTaskContextQueryKey(taskId: string): readonly ["assignedTaskContext", string] {
  return ["assignedTaskContext", taskId] as const;
}

export function calendarEventsQueryKey(
  userId: string | null | undefined,
): readonly ["calendar-events", string, "upcoming-30-days"] {
  return ["calendar-events", resolveUserScope(userId), "upcoming-30-days"] as const;
}

export function calendarEventPrepQueryKey(
  ...args: [userId: string | null | undefined, event: CalendarEventPrepInput | null | undefined]
): readonly [string, string, string, string, string, string, string, string, string] {
  const [userId, event] = args;

  return [
    "calendar-event-prep",
    resolveUserScope(userId),
    event?.id ?? QUERY_KEY_NONE,
    event?.providerEventId ?? QUERY_KEY_EMPTY,
    event?.title ?? QUERY_KEY_EMPTY,
    event?.start ?? QUERY_KEY_EMPTY,
    event?.end ?? QUERY_KEY_EMPTY,
    event?.location ?? QUERY_KEY_EMPTY,
    buildCalendarEventPeopleKey(event),
  ] as const;
}

/** Nested under the detail key so invalidating, cancelling or removing a meeting's detail also covers its notes view. */
export function meetingNotesViewQueryKey(meetingId: string): readonly ["meetingDetail", string, "notesView"] {
  return ["meetingDetail", meetingId, "notesView"] as const;
}

/** Nested under the detail key so task, realtime and billing invalidations of a meeting's detail also refresh its Linear task review. */
export function meetingLinearTaskReviewQueryKey(
  meetingId: string,
): readonly ["meetingDetail", string, "linearTaskReview"] {
  return ["meetingDetail", meetingId, "linearTaskReview"] as const;
}
