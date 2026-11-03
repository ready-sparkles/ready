import type { NormalizedCalendarEvent } from "@readymeet/shared";

import { repositories } from "../ports/repository-runtime";

type CalendarEventPerson = NonNullable<NormalizedCalendarEvent["organizer"]>;
type ProfileByEmail = { displayName: string | null; avatarUrl: string | null };

function normalizeEmail(email?: string | null): string | null {
  const normalizedEmail = email?.trim().toLowerCase();

  return normalizedEmail === undefined || normalizedEmail.length === 0 ? null : normalizedEmail;
}

function collectCalendarPersonEmails(events: NormalizedCalendarEvent[]): string[] {
  return Array.from(
    new Set(
      events
        .flatMap((event) => [event.organizer?.email ?? null, ...event.attendees.map((attendee) => attendee.email)])
        .map((email) => normalizeEmail(email))
        .filter((email): email is string => email !== null),
    ),
  );
}

function withReadyMeetAvatar(input: {
  person: CalendarEventPerson | null | undefined;
  profilesByEmail: Map<string, ProfileByEmail>;
}): CalendarEventPerson | null {
  const { person, profilesByEmail } = input;
  if (person === null || person === undefined) {
    return null;
  }

  const email = normalizeEmail(person.email);
  const profile = email === null ? null : (profilesByEmail.get(email) ?? null);
  const profileAvatarUrl = profile === null ? null : profile.avatarUrl;
  const readyMeetAvatarUrl = person.readyMeetAvatarUrl ?? profileAvatarUrl;
  const displayName = profile?.displayName?.trim();

  return {
    ...person,
    name: displayName === undefined || displayName.length === 0 ? person.name : displayName,
    avatarUrl: person.avatarUrl ?? readyMeetAvatarUrl,
    readyMeetAvatarUrl,
  };
}

export function applyReadyMeetCalendarAvatarFallbacks(input: {
  events: NormalizedCalendarEvent[];
  avatarUrlsByEmail: Map<string, string>;
}): NormalizedCalendarEvent[] {
  return applyReadyMeetCalendarProfileFallbacks({
    events: input.events,
    profilesByEmail: new Map(
      Array.from(input.avatarUrlsByEmail, ([email, avatarUrl]) => [
        email,
        {
          avatarUrl,
          displayName: "",
        },
      ]),
    ),
  });
}

export function applyReadyMeetCalendarProfileFallbacks(input: {
  events: NormalizedCalendarEvent[];
  profilesByEmail: Map<string, ProfileByEmail>;
}): NormalizedCalendarEvent[] {
  const { events, profilesByEmail } = input;
  if (profilesByEmail.size === 0) {
    return events;
  }

  return events.map((event) => ({
    ...event,
    organizer: withReadyMeetAvatar({ person: event.organizer, profilesByEmail }),
    attendees: event.attendees.map(
      (attendee) => withReadyMeetAvatar({ person: attendee, profilesByEmail }) ?? attendee,
    ),
  }));
}

export async function addReadyMeetCalendarAvatarFallbacks(
  events: NormalizedCalendarEvent[],
): Promise<NormalizedCalendarEvent[]> {
  const emails = collectCalendarPersonEmails(events);
  if (emails.length === 0) {
    return events;
  }

  const users = await repositories().listUserProfilesByEmails(emails);
  const profilesByEmail = users.reduce<Map<string, { displayName: string; avatarUrl: string | null }>>((map, user) => {
    const email = normalizeEmail(user.email);
    if (email === null) {
      return map;
    }
    const avatarUrl = user.avatarUrl?.trim();

    return new Map(map).set(email, {
      avatarUrl: avatarUrl === undefined || avatarUrl.length === 0 ? null : avatarUrl,
      displayName: user.displayName,
    });
  }, new Map());

  return applyReadyMeetCalendarProfileFallbacks({ events, profilesByEmail });
}
