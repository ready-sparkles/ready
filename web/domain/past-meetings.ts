import type { Meeting } from "@readymeet/shared";

function getMeetingDate(meeting: Meeting) {
  const value = meeting.startedAt ?? meeting.endedAt ?? meeting.createdAt;
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getMeetingTimeParts(value: string | null) {
  if (value === null || value === "") {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? null;
  const minute = parts.find((part) => part.type === "minute")?.value ?? null;
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value ?? null;
  const formattedParts = formatMeetingTimePartsFromIntl({ hour, minute, dayPeriod });
  if (formattedParts !== null) {
    return formattedParts;
  }

  return getMeetingTimePartsFromFormatted(formatter.format(date));
}

function formatMeetingTimePartsFromIntl(input: {
  hour: string | null;
  minute: string | null;
  dayPeriod: string | null;
}) {
  if (input.hour === null || input.hour === "") {
    return null;
  }
  const time =
    input.minute !== null && input.minute !== "" && input.minute !== "00"
      ? `${input.hour}:${input.minute}`
      : input.hour;

  return {
    dayPeriod:
      input.dayPeriod !== null && input.dayPeriod !== "" ? input.dayPeriod.toUpperCase().replace(/\s+/g, "") : null,
    time,
  };
}

function getMeetingTimePartsFromFormatted(formatted: string) {
  const match = formatted.match(/\s*(AM|PM|am|pm)$/i);

  return {
    dayPeriod: match?.[1]?.toUpperCase() ?? null,
    time: match ? formatted.slice(0, match.index).trim() : formatted,
  };
}

function formatMeetingTimeParts(parts: ReturnType<typeof getMeetingTimeParts>) {
  if (!parts) {
    return null;
  }

  return parts.dayPeriod !== null && parts.dayPeriod !== "" ? `${parts.time} ${parts.dayPeriod}` : parts.time;
}

function formatMeetingStartTime(meeting: Meeting) {
  return formatMeetingTimeParts(getMeetingTimeParts(meeting.startedAt ?? meeting.endedAt));
}

function formatMeetingTimeRange(meeting: Meeting) {
  const start = getMeetingTimeParts(meeting.startedAt);
  const end = getMeetingTimeParts(meeting.endedAt);

  if (start && end) {
    if (start.dayPeriod !== null && start.dayPeriod !== "" && start.dayPeriod === end.dayPeriod) {
      return `${start.time} - ${end.time} ${end.dayPeriod}`;
    }

    const formattedStart = formatMeetingTimeParts(start);
    const formattedEnd = formatMeetingTimeParts(end);

    return formattedStart !== null && formattedStart !== "" && formattedEnd !== null && formattedEnd !== ""
      ? `${formattedStart} - ${formattedEnd}`
      : (formattedStart ?? formattedEnd);
  }

  return formatMeetingTimeParts(start ?? end);
}

function formatPastMeetingDayLabel(date: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
}

function formatPastMeetingNumericDateLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "numeric",
    year: "2-digit",
  }).format(date);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date) {
  const day = startOfDay(date);
  day.setDate(day.getDate() - day.getDay());

  return day;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(input: { date: Date; days: number }) {
  const next = new Date(input.date);
  next.setDate(next.getDate() + input.days);

  return next;
}

function addMonths(input: { date: Date; months: number }) {
  return new Date(input.date.getFullYear(), input.date.getMonth() + input.months, 1);
}

// Constructing a formatter is far costlier than formatting; grouping a long
// history would otherwise build one per meeting.
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: "long" });
const monthYearFormatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function monthLabel(input: { date: Date; now: Date }) {
  if (input.date.getFullYear() === input.now.getFullYear()) {
    return monthFormatter.format(input.date);
  }

  return monthYearFormatter.format(input.date);
}

export type PastMeetingGroup = {
  label: string;
  meetings: Meeting[];
};

type PastMeetingCardSubtitle =
  | {
      kind: "recent";
      label: string;
      notePreview: string | null;
    }
  | {
      kind: "line";
      text: string;
    };

function isTodayOrYesterday(input: { date: Date; now: Date }) {
  const todayStart = startOfDay(input.now);
  const yesterdayStart = addDays({ date: todayStart, days: -1 });

  return input.date >= yesterdayStart && input.date < addDays({ date: todayStart, days: 1 });
}

function isThisWeek(input: { date: Date; now: Date }) {
  return input.date >= startOfWeek(input.now) && input.date < startOfDay(input.now);
}

function getPastMeetingDateTimeLineNamed(input: { meeting: Meeting; now: Date }): string {
  const date = getMeetingDate(input.meeting);
  if (!date) {
    return formatMeetingStartTime(input.meeting) ?? "Completed";
  }

  const startTime = formatMeetingStartTime(input.meeting);
  if (isTodayOrYesterday({ date, now: input.now })) {
    return formatMeetingTimeRange(input.meeting) ?? "Completed";
  }

  const dateLabel = formatPastMeetingDayLabel(date);

  return startTime !== null && startTime !== "" ? `${dateLabel} · ${startTime}` : dateLabel;
}

function getPastMeetingCardSubtitleNamed(input: { meeting: Meeting; now: Date }): PastMeetingCardSubtitle {
  const date = getMeetingDate(input.meeting);
  const startTime = formatMeetingStartTime(input.meeting);
  const trimmedNotePreview = input.meeting.notePreview?.trim() ?? "";
  const notePreview = trimmedNotePreview !== "" ? trimmedNotePreview : null;
  if (date && isTodayOrYesterday({ date, now: input.now }) && startTime !== null && startTime !== "") {
    return {
      kind: "recent",
      label: startTime,
      notePreview,
    };
  }

  if (date && isThisWeek({ date, now: input.now })) {
    return {
      kind: "recent",
      label: formatPastMeetingDayLabel(date),
      notePreview,
    };
  }

  if (date) {
    return {
      kind: "recent",
      label: formatPastMeetingNumericDateLabel(date),
      notePreview,
    };
  }

  return {
    kind: "line",
    text: getPastMeetingDateTimeLineNamed({ meeting: input.meeting, now: input.now }),
  };
}

export function getPastMeetingCardSubtitle(...args: [meeting: Meeting, now?: Date]): PastMeetingCardSubtitle {
  const [meeting, now = new Date()] = args;

  return getPastMeetingCardSubtitleNamed({ meeting, now });
}

function groupPastMeetingsNamed(input: { meetings: Meeting[]; now: Date }): PastMeetingGroup[] {
  const todayStart = startOfDay(input.now);
  const yesterdayStart = addDays({ date: todayStart, days: -1 });
  const thisWeekStart = startOfWeek(input.now);
  const thisMonthStart = startOfMonth(input.now);
  const lastMonthStart = addMonths({ date: thisMonthStart, months: -1 });
  const groups = new Map<string, Meeting[]>();

  const addMeetingToGroup = (groupInput: { label: string; meeting: Meeting }) => {
    const existing = groups.get(groupInput.label) ?? [];
    groups.set(groupInput.label, [...existing, groupInput.meeting]);
  };

  // Parse each date once rather than on every comparison.
  const datedMeetings = input.meetings
    .map((meeting) => ({ meeting, date: getMeetingDate(meeting) }))
    .sort((left, right) => (right.date?.getTime() ?? 0) - (left.date?.getTime() ?? 0));

  datedMeetings.forEach(({ meeting, date }) => {
    if (!date) {
      addMeetingToGroup({ label: "Earlier", meeting });

      return;
    }

    if (date >= todayStart) {
      addMeetingToGroup({ label: "Today", meeting });
    } else if (date >= yesterdayStart && date < todayStart) {
      addMeetingToGroup({ label: "Yesterday", meeting });
    } else if (date >= thisWeekStart) {
      addMeetingToGroup({ label: "This past week", meeting });
    } else if (date >= thisMonthStart) {
      addMeetingToGroup({ label: "This past month", meeting });
    } else if (date >= lastMonthStart && date < thisMonthStart) {
      addMeetingToGroup({ label: monthLabel({ date, now: input.now }), meeting });
    } else {
      addMeetingToGroup({ label: monthLabel({ date, now: input.now }), meeting });
    }
  });

  return Array.from(groups, ([label, groupMeetings]) => ({ label, meetings: groupMeetings }));
}

export function groupPastMeetings(...args: [meetings: Meeting[], now?: Date]): PastMeetingGroup[] {
  const [meetings, now = new Date()] = args;

  return groupPastMeetingsNamed({ meetings, now });
}

function clampPastMeetingGroupIndex(input: { preferredGroupIndex: number; groupCount: number }) {
  return Math.min(Math.max(input.preferredGroupIndex, 0), Math.max(input.groupCount - 1, 0));
}

function hasPastMeetingSelection(meetingId: string | null) {
  return meetingId !== null && meetingId !== "";
}

export function resolvePastMeetingSelection(input: {
  groups: PastMeetingGroup[];
  selectedMeetingId: string | null;
  preferredGroupIndex: number;
}): {
  groupIndex: number;
  meeting: Meeting | null;
  meetingId: string | null;
} {
  const selectedGroupIndex = hasPastMeetingSelection(input.selectedMeetingId)
    ? input.groups.findIndex((group) => group.meetings.some((meeting) => meeting.id === input.selectedMeetingId))
    : -1;
  if (hasPastMeetingSelection(input.selectedMeetingId) && selectedGroupIndex < 0) {
    return {
      groupIndex: clampPastMeetingGroupIndex({
        preferredGroupIndex: input.preferredGroupIndex,
        groupCount: input.groups.length,
      }),
      meeting: null,
      meetingId: input.selectedMeetingId,
    };
  }

  const groupIndex =
    selectedGroupIndex >= 0
      ? selectedGroupIndex
      : clampPastMeetingGroupIndex({ preferredGroupIndex: input.preferredGroupIndex, groupCount: input.groups.length });
  const group = input.groups[groupIndex] ?? null;
  const selectedMeeting = hasPastMeetingSelection(input.selectedMeetingId)
    ? (group?.meetings.find((meeting) => meeting.id === input.selectedMeetingId) ?? null)
    : null;
  const meeting = selectedMeeting ?? group?.meetings[0] ?? null;

  return {
    groupIndex,
    meeting,
    meetingId: meeting?.id ?? null,
  };
}

function getPastMeetingPeriodNavigationNamed(input: { groups: PastMeetingGroup[]; currentGroupIndex: number }): {
  olderGroupIndex: number | null;
  newerGroupIndex: number | null;
  newerRoute: string | null;
} {
  return {
    olderGroupIndex: input.currentGroupIndex < input.groups.length - 1 ? input.currentGroupIndex + 1 : null,
    newerGroupIndex: input.currentGroupIndex > 0 ? input.currentGroupIndex - 1 : null,
    newerRoute: input.currentGroupIndex === 0 ? "/workspace?view=upcoming" : null,
  };
}

export function getPastMeetingPeriodNavigation(
  ...args: [groups: PastMeetingGroup[], currentGroupIndex: number]
): ReturnType<typeof getPastMeetingPeriodNavigationNamed> {
  const [groups, currentGroupIndex] = args;

  return getPastMeetingPeriodNavigationNamed({ groups, currentGroupIndex });
}
