import type { CalendarEventsResponse, CalendarProvider, NormalizedCalendarEvent } from "@readymeet/shared";

const LINT_NUM_N24 = 24;
const LINT_NUM_N60 = 60;
const LINT_NUM_N1000 = 1000;
const LINT_NUM_N6 = 6;
const LINT_NUM_N7 = 7;
const LINT_NUM_N3 = 3;
const LINT_NUM_N4 = 4;
const LINT_NUM_N2 = 2;

export type CalendarEventPerson = NormalizedCalendarEvent["attendees"][number];
type UpcomingCalendarEventGroup = {
  kind: "day" | "next_7_days" | "week" | "month";
  label: string;
  events: NormalizedCalendarEvent[];
};

const MIN_UPCOMING_EVENT_GROUP_SIZE = LINT_NUM_N3;
const DAY_MS = LINT_NUM_N24 * LINT_NUM_N60 * LINT_NUM_N60 * LINT_NUM_N1000;

export function getCalendarProviderLabel(provider: CalendarProvider): string {
  return provider === "google_calendar" ? "Google Calendar" : "Outlook Calendar";
}

export function getCalendarEventTitle(event: NormalizedCalendarEvent): string {
  return event.isPrivate ? "Private event" : event.title;
}

export function getVisibleCalendarEvents(events: NormalizedCalendarEvent[]): NormalizedCalendarEvent[] {
  return events.filter((event) => !event.isCancelled);
}

export function removeCalendarEventFromResponse(
  ...args: [response: CalendarEventsResponse | undefined, eventId: string]
): CalendarEventsResponse | undefined {
  const [response, eventId] = args;
  if (response === undefined) {
    return response;
  }

  return {
    ...response,
    events: response.events.filter((event) => event.id !== eventId),
    prepSummaries: response.prepSummaries.filter((summary) => summary.calendarEventId !== eventId),
  };
}

export function addReadyMeetingToCalendarEventsResponse(
  ...args: [
    response: CalendarEventsResponse | undefined,
    input: {
      providerEventKey: string;
      readyMeeting: NonNullable<NormalizedCalendarEvent["readyMeeting"]>;
    },
  ]
): CalendarEventsResponse | undefined {
  const [response, input] = args;
  if (response === undefined) {
    return response;
  }

  return {
    ...response,
    events: response.events.map((event) => {
      const providerEventKey = event.providerEventKey ?? event.providerEventId;
      if (providerEventKey !== input.providerEventKey) {
        return event;
      }

      return {
        ...event,
        readyMeeting: input.readyMeeting,
        canAddReadyMeeting: false,
        /** @external calendar event wire field */
        needsCalendarWriteConsent: false,
      };
    }),
  };
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(input: { date: Date; days: number }): Date {
  const next = new Date(input.date);
  next.setDate(next.getDate() + input.days);

  return next;
}

function startOfIsoWeek(date: Date) {
  const day = startOfDay(date);
  const dayIndex = (day.getDay() + LINT_NUM_N6) % LINT_NUM_N7;
  day.setDate(day.getDate() - dayIndex);

  return day;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(input: { date: Date; months: number }): Date {
  return new Date(input.date.getFullYear(), input.date.getMonth() + input.months, 1);
}

function isSameCalendarDay(input: { left: Date; right: Date }) {
  return (
    input.left.getFullYear() === input.right.getFullYear() &&
    input.left.getMonth() === input.right.getMonth() &&
    input.left.getDate() === input.right.getDate()
  );
}

function parseCalendarEventDate(value: string) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getCalendarEventStartDate(event: NormalizedCalendarEvent) {
  return parseCalendarEventDate(event.start);
}

function getCalendarEventEndDate(event: NormalizedCalendarEvent) {
  return parseCalendarEventDate(event.end) ?? getCalendarEventStartDate(event);
}

function getCalendarEventSortTime(event: NormalizedCalendarEvent) {
  return getCalendarEventStartDate(event)?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function compareCalendarEvents(left: NormalizedCalendarEvent, right: NormalizedCalendarEvent) {
  return getCalendarEventSortTime(left) - getCalendarEventSortTime(right);
}

function isUpcomingCalendarEvent(input: { event: NormalizedCalendarEvent; now: Date }) {
  const end = getCalendarEventEndDate(input.event);

  return end !== null && end.getTime() >= input.now.getTime();
}

function getEventsInRange(input: { events: NormalizedCalendarEvent[]; start: Date; end: Date }) {
  return input.events.filter((event) => {
    const date = getCalendarEventStartDate(event);

    return date !== null && date >= input.start && date < input.end;
  });
}

function getCalendarDayLabel(...args: [date: Date, now: Date]): string {
  const [date, now] = args;
  const today = startOfDay(now);

  if (isSameCalendarDay({ left: date, right: today })) {
    return "Today";
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

function getIsoWeekNumber(date: Date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayIndex = (target.getUTCDay() + LINT_NUM_N6) % LINT_NUM_N7;
  target.setUTCDate(target.getUTCDate() - dayIndex + LINT_NUM_N3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, LINT_NUM_N4));
  const firstThursdayDayIndex = (firstThursday.getUTCDay() + LINT_NUM_N6) % LINT_NUM_N7;

  return (
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / DAY_MS - LINT_NUM_N3 + firstThursdayDayIndex) / LINT_NUM_N7,
    )
  );
}

function getMonthLabel(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(date);
}

function createUpcomingCalendarGroup(input: {
  kind: UpcomingCalendarEventGroup["kind"];
  label: string;
  events: NormalizedCalendarEvent[];
}): UpcomingCalendarEventGroup {
  return {
    kind: input.kind,
    label: input.label,
    events: [...input.events].sort(compareCalendarEvents),
  };
}

function withAppendedUpcomingCalendarGroup(input: {
  groupState: { values: UpcomingCalendarEventGroup[] };
  group: UpcomingCalendarEventGroup;
}): { values: UpcomingCalendarEventGroup[] } {
  return { values: [...input.groupState.values, input.group] };
}

function buildNextUpcomingCalendarEventGroup(input: {
  remainingEvents: NormalizedCalendarEvent[];
  anchorDate: Date;
  groupState: { values: UpcomingCalendarEventGroup[] };
  now: Date;
  minEventCount: number;
}): { groupState: { values: UpcomingCalendarEventGroup[] }; eventsToConsume: NormalizedCalendarEvent[] } {
  const dayStart = startOfDay(input.anchorDate);
  const dayEvents = getEventsInRange({
    events: input.remainingEvents,
    start: dayStart,
    end: addDays({ date: dayStart, days: 1 }),
  });
  if (dayEvents.length >= input.minEventCount) {
    return {
      groupState: withAppendedUpcomingCalendarGroup({
        groupState: input.groupState,
        group: createUpcomingCalendarGroup({
          kind: "day",
          label: getCalendarDayLabel(dayStart, input.now),
          events: dayEvents,
        }),
      }),
      eventsToConsume: dayEvents,
    };
  }

  if (input.groupState.values.length === 0) {
    const nextSevenDaysStart = startOfDay(input.now);
    const nextSevenDaysEnd = addDays({ date: nextSevenDaysStart, days: LINT_NUM_N7 });
    if (input.anchorDate >= nextSevenDaysStart && input.anchorDate < nextSevenDaysEnd) {
      const nextSevenDaysEvents = getEventsInRange({
        events: input.remainingEvents,
        start: nextSevenDaysStart,
        end: nextSevenDaysEnd,
      });
      if (nextSevenDaysEvents.length >= input.minEventCount) {
        return {
          groupState: withAppendedUpcomingCalendarGroup({
            groupState: input.groupState,
            group: createUpcomingCalendarGroup({
              kind: "next_7_days",
              label: "Next 7 days",
              events: nextSevenDaysEvents,
            }),
          }),
          eventsToConsume: nextSevenDaysEvents,
        };
      }
    }
  }

  const weekStart = startOfIsoWeek(input.anchorDate);
  const weekEvents = getEventsInRange({
    events: input.remainingEvents,
    start: weekStart,
    end: addDays({ date: weekStart, days: LINT_NUM_N7 }),
  });
  if (weekEvents.length >= input.minEventCount) {
    return {
      groupState: withAppendedUpcomingCalendarGroup({
        groupState: input.groupState,
        group: createUpcomingCalendarGroup({
          kind: "week",
          label: `Week ${getIsoWeekNumber(input.anchorDate)}`,
          events: weekEvents,
        }),
      }),
      eventsToConsume: weekEvents,
    };
  }

  const monthStart = startOfMonth(input.anchorDate);
  const monthEvents = getEventsInRange({
    events: input.remainingEvents,
    start: monthStart,
    end: addMonths({ date: monthStart, months: 1 }),
  });
  const fallbackEvents = monthEvents.length !== 0 ? monthEvents : dayEvents;

  return {
    groupState: withAppendedUpcomingCalendarGroup({
      groupState: input.groupState,
      group: createUpcomingCalendarGroup({
        kind: "month",
        label: getMonthLabel(input.anchorDate),
        events: fallbackEvents,
      }),
    }),
    eventsToConsume: fallbackEvents,
  };
}

export function getUpcomingCalendarEventGroups(
  ...args: [events: NormalizedCalendarEvent[], now?: Date, minEventCount?: number]
): UpcomingCalendarEventGroup[] {
  const [events, now = new Date(), minEventCount = MIN_UPCOMING_EVENT_GROUP_SIZE] = args;
  const upcomingEvents = getVisibleCalendarEvents(events)
    .filter((event) => isUpcomingCalendarEvent({ event, now }))
    .sort(compareCalendarEvents);
  const groupState: { values: UpcomingCalendarEventGroup[] } = { values: [] };
  const consumedEventIds = new Set<string>();
  const getRemainingEvents = () => upcomingEvents.filter((event) => !consumedEventIds.has(event.id));
  const consumeEvents = (groupEvents: NormalizedCalendarEvent[]) => {
    groupEvents.forEach((event) => {
      consumedEventIds.add(event.id);
    });
  };

  while (consumedEventIds.size < upcomingEvents.length) {
    const remainingEvents = getRemainingEvents();
    const anchorEvent = remainingEvents[0];
    if (anchorEvent === undefined) {
      break;
    }

    const anchorDate = getCalendarEventStartDate(anchorEvent);
    if (anchorDate === null) {
      break;
    }

    const iteration = buildNextUpcomingCalendarEventGroup({
      remainingEvents,
      anchorDate,
      groupState,
      now,
      minEventCount,
    });
    groupState.values = iteration.groupState.values;
    consumeEvents(iteration.eventsToConsume);
  }

  return groupState.values;
}

export function getCalendarEventSelection(
  ...args: [eventsForDay: NormalizedCalendarEvent[], manuallySelectedEventId: string | null]
): {
  selectedEvent: NormalizedCalendarEvent | null;
  selectedEventId: string | null;
} {
  const [eventsForDay, manuallySelectedEventId] = args;
  const selectedEvent =
    manuallySelectedEventId !== null && manuallySelectedEventId !== ""
      ? (eventsForDay.find((event) => event.id === manuallySelectedEventId) ?? null)
      : null;
  const event = selectedEvent ?? eventsForDay[0] ?? null;

  return {
    selectedEvent: event,
    selectedEventId: event?.id ?? null,
  };
}

export function getUpcomingPreviousCalendarNavigation(dayOffset: number): {
  dayOffset: number | null;
  route: string | null;
} {
  if (dayOffset <= 0) {
    return {
      dayOffset: null,
      route: "/workspace?view=past",
    };
  }

  return {
    dayOffset: dayOffset - 1,
    route: null,
  };
}

function normalizeCalendarPersonEmail(person?: CalendarEventPerson | null) {
  const email = person?.email?.trim().toLowerCase();

  return email !== undefined && email !== "" ? email : null;
}

function normalizeCalendarPersonName(person?: CalendarEventPerson | null) {
  const name = person?.name?.trim().toLowerCase();

  return name !== undefined && name !== "" ? name : null;
}

function normalizeCurrentUserEmails(emails: (string | null | undefined)[]) {
  return Array.from(
    new Set(
      emails
        .map((email) => email?.trim().toLowerCase())
        .filter((email): email is string => email !== undefined && email !== ""),
    ),
  );
}

function isCurrentCalendarPersonForIdentity(input: {
  person: CalendarEventPerson | null | undefined;
  currentUserEmails: string[];
}) {
  const personEmail = normalizeCalendarPersonEmail(input.person);

  return personEmail !== null && personEmail !== "" && input.currentUserEmails.includes(personEmail);
}

function isCurrentCalendarPerson(
  ...args: [
    person: CalendarEventPerson | null | undefined,
    currentUserEmail?: string | null,
    currentUserDisplayName?: string | null,
  ]
): boolean {
  const [person, currentUserEmail, currentUserDisplayName] = args;
  void currentUserDisplayName;

  return isCurrentCalendarPersonForIdentity({
    person,
    currentUserEmails: normalizeCurrentUserEmails([currentUserEmail]),
  });
}

function hasCalendarPersonLabel(person: CalendarEventPerson) {
  const name = person.name?.trim() ?? "";
  const email = person.email?.trim() ?? "";

  return name !== "" || email !== "";
}

function getCalendarPersonKey(person: CalendarEventPerson) {
  return normalizeCalendarPersonEmail(person) ?? normalizeCalendarPersonName(person);
}

export function getCalendarEventParticipantPeople(
  ...args: [event: NormalizedCalendarEvent, currentUserEmail?: string | null, currentUserDisplayName?: string | null]
): CalendarEventPerson[] {
  const [event, currentUserEmail, currentUserDisplayName] = args;
  const seenKeys = new Set<string>();
  const includePerson = (input: {
    people: CalendarEventPerson[];
    person: CalendarEventPerson | null | undefined;
  }): CalendarEventPerson[] => {
    const { people, person } = input;
    if (!person || !hasCalendarPersonLabel(person)) {
      return people;
    }

    const key = getCalendarPersonKey(person);
    if (key !== null && key !== "" && seenKeys.has(key)) {
      return people;
    }

    if (key !== null && key !== "") {
      seenKeys.add(key);
    }

    return [...people, person];
  };

  const people = event.attendees.reduce(
    (accumulated, person) => includePerson({ people: accumulated, person }),
    includePerson({ people: [], person: event.organizer }),
  );

  const otherPeople = people.filter(
    (person) => !isCurrentCalendarPerson(person, currentUserEmail, currentUserDisplayName),
  );

  return otherPeople.length !== 0 ? otherPeople : people;
}

export function getCalendarEventPersonInitials(
  ...args: [person: CalendarEventPerson | null, fallbackEmail?: string | null]
): string {
  const [person, fallbackEmail] = args;
  const nameLabel = person?.name?.trim() ?? "";
  const emailLabel = person?.email?.split("@")[0]?.trim() ?? "";
  const fallbackLabel = fallbackEmail?.split("@")[0]?.trim() ?? "";
  const label = nameLabel !== "" ? nameLabel : emailLabel !== "" ? emailLabel : fallbackLabel;
  if (label === "") {
    return "?";
  }

  const initials = label
    .split(/[\s._-]+/)
    .filter((part) => part !== "")
    .slice(0, LINT_NUM_N2)
    .map((part) => part[0])
    .join("");
  const upper = initials.toUpperCase();

  return upper !== "" ? upper : "?";
}

export function getCalendarEventAvatarUrlCandidates(input: {
  person: CalendarEventPerson | null | undefined;
  currentUserAvatarUrl?: string | null;
  currentUserEmail?: string | null;
  currentUserDisplayName?: string | null;
}): string[] {
  const shouldUseCurrentUserAvatar = isCurrentCalendarPerson(
    input.person,
    input.currentUserEmail,
    input.currentUserDisplayName,
  );

  return Array.from(
    new Set(
      [
        input.person?.readyMeetAvatarUrl,
        shouldUseCurrentUserAvatar ? input.currentUserAvatarUrl : null,
        input.person?.avatarUrl,
      ]
        .map((url) => url?.trim())
        .filter((url): url is string => url !== undefined && url !== ""),
    ),
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

export function getCalendarEventLogoDay(event: NormalizedCalendarEvent): number | null {
  const date = formatDate(event.start);
  if (!date) {
    return null;
  }
  // Timed meetings match the viewer-local date used by the calendar. All-day
  // events keep their calendar date instead of shifting at a UTC boundary.
  if (event.isAllDay) {
    const day = event.start.match(/^\d{4}-\d{2}-(\d{2})/)?.[1];

    return day !== undefined && day !== "" ? Number(day) : null;
  }

  return date.getDate();
}

function normalizeCalendarTimeDayPeriod(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return value.toUpperCase().replace(/\s+/g, "");
}

function getCalendarTimeLabelFromFormatParts(input: {
  hour: string | null;
  minute: string | null;
  dayPeriod: string | null;
}) {
  if (input.hour === null || input.hour === "") {
    return null;
  }

  const minuteSuffix = input.minute !== null && input.minute !== "" && input.minute !== "00" ? `:${input.minute}` : "";

  return {
    dayPeriod: normalizeCalendarTimeDayPeriod(input.dayPeriod),
    time: `${input.hour}${minuteSuffix}`,
  };
}

function getCalendarTimeLabelFromFormattedValue(input: { formatter: Intl.DateTimeFormat; date: Date }) {
  const formatted = input.formatter.format(input.date);
  const match = formatted.match(/\s*(AM|PM|am|pm)$/i);

  return {
    dayPeriod: match?.[1]?.toUpperCase() ?? null,
    time: match ? formatted.slice(0, match.index).trim() : formatted,
  };
}

function getCalendarTimeParts(value: string) {
  const date = formatDate(value);
  if (!date) {
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
  const fromParts = getCalendarTimeLabelFromFormatParts({ hour, minute, dayPeriod });

  return fromParts ?? getCalendarTimeLabelFromFormattedValue({ formatter, date });
}

function formatCalendarTimeParts(parts: ReturnType<typeof getCalendarTimeParts>) {
  if (!parts) {
    return null;
  }

  return parts.dayPeriod !== null && parts.dayPeriod !== "" ? `${parts.time} ${parts.dayPeriod}` : parts.time;
}

function formatCalendarTimeRange(input: { startValue: string; endValue: string }) {
  const start = getCalendarTimeParts(input.startValue);
  const end = getCalendarTimeParts(input.endValue);

  if (start && end) {
    if (start.dayPeriod !== null && start.dayPeriod !== "" && start.dayPeriod === end.dayPeriod) {
      return `${start.time} - ${end.time} ${end.dayPeriod}`;
    }

    const formattedStart = formatCalendarTimeParts(start);
    const formattedEnd = formatCalendarTimeParts(end);

    return formattedStart !== null && formattedStart !== "" && formattedEnd !== null && formattedEnd !== ""
      ? `${formattedStart} - ${formattedEnd}`
      : (formattedStart ?? formattedEnd);
  }

  return formatCalendarTimeParts(start ?? end);
}

function formatCalendarCompactDate(value: string) {
  const date = formatDate(value);
  if (!date) {
    return null;
  }

  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
  }).format(date);

  return `${weekday} ${dateLabel}`;
}

function getCalendarLocationDisplayLabel(location: string | null) {
  const value = location?.trim() ?? "";
  if (value === "") {
    return null;
  }

  const normalized = value.toLowerCase();
  const meetingPlatformRules: { label: string; pattern: RegExp }[] = [
    { label: "Google Meet", pattern: /\bgoogle meet\b|meet\.google\.com/ },
    { label: "Zoom", pattern: /\bzoom\b|zoom\.us/ },
    { label: "Microsoft Teams", pattern: /\bmicrosoft teams\b|\bteams meeting\b|teams\.microsoft\.com/ },
    { label: "Webex", pattern: /\bwebex\b|webex\.com/ },
    { label: "Slack Huddle", pattern: /\bslack huddle\b/ },
    { label: "Whereby", pattern: /\bwhereby\b|whereby\.com/ },
    { label: "Around", pattern: /\baround\b|around\.co/ },
    { label: "BlueJeans", pattern: /\bbluejeans\b|bluejeans\.com/ },
  ];
  const platform = meetingPlatformRules.find((rule) => rule.pattern.test(normalized));
  if (platform) {
    return platform.label;
  }

  if (isRawUrlLikeCalendarLocation(value)) {
    return null;
  }

  return value;
}

function isRawUrlLikeCalendarLocation(value: string) {
  const trimmed = value.trim();
  if (trimmed === "" || /\s/.test(trimmed)) {
    return false;
  }

  return (
    /^https?:\/\//i.test(trimmed) ||
    /^www\./i.test(trimmed) ||
    /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i.test(trimmed) ||
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?[/?#]/i.test(trimmed)
  );
}

function isReadyMeetingLocation(event: NormalizedCalendarEvent) {
  const location = event.location?.trim();
  const joinUrl = event.readyMeeting?.joinUrl.trim();

  return location !== undefined && location !== "" && joinUrl !== undefined && joinUrl !== "" && location === joinUrl;
}

export function getCalendarEventSubtitleParts(event: NormalizedCalendarEvent): {
  primary: string;
  secondary: string | null;
} {
  const location = isReadyMeetingLocation(event) ? null : getCalendarLocationDisplayLabel(event.location);
  if (event.isAllDay) {
    return {
      primary: "All day",
      secondary: location,
    };
  }

  const time = formatCalendarTimeRange({ startValue: event.start, endValue: event.end });

  return {
    primary: time ?? location ?? "Scheduled",
    secondary: time !== null && time !== "" ? location : null,
  };
}

export function getCalendarEventDatedSubtitleParts(event: NormalizedCalendarEvent): {
  primary: string;
  secondary: string | null;
} {
  const date = formatCalendarCompactDate(event.start);
  const subtitle = getCalendarEventSubtitleParts(event);

  return {
    primary: date !== null && date !== "" ? `${date}, ${subtitle.primary}` : subtitle.primary,
    secondary: subtitle.secondary,
  };
}
