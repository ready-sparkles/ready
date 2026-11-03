import { z } from "zod";

export const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const GOOGLE_CALENDAR_SCOPES = [
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
] as const;

// Standalone Calendar add-on scopes. Web integrations request their own scopes
// only when the user explicitly connects them in Ready.
export const GOOGLE_WORKSPACE_ADDON_SCOPES = [
  "https://www.googleapis.com/auth/calendar.addons.execute",
  "https://www.googleapis.com/auth/script.external_request",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  GOOGLE_CALENDAR_EVENTS_SCOPE,
] as const;

export const calendarProviderSchema = z.enum(["google_calendar", "outlook_calendar"]);
export const providerAccountKindSchema = z.enum(["personal", "work"]);
export const providerAccountStatusSchema = z.enum(["connected", "disconnected", "error"]);

export const calendarEventAttendeeSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  responseStatus: z.string().nullable(),
  avatarUrl: z.string().url().nullable().optional(),
  readyMeetAvatarUrl: z.string().url().nullable().optional(),
});

export const calendarReadyMeetingSchema = z.object({
  source: z.enum(["mapping", "provider_event"]),
  meetingLinkId: z.string().uuid().nullable().optional(),
  code: z.string().min(1).nullable().optional(),
  joinUrl: z.string().url(),
  callIn: z
    .object({
      phoneNumber: z.string().min(1),
      pin: z.string().min(1),
    })
    .nullable()
    .optional(),
});

export const normalizedCalendarEventSchema = z.object({
  id: z.string().min(1),
  calendarAccountId: z.string().uuid().nullable().optional(),
  provider: calendarProviderSchema,
  providerEventId: z.string().min(1),
  providerRecurringEventId: z.string().min(1).nullable().optional(),
  providerEventKey: z.string().min(1).optional(),
  calendarId: z.string().min(1),
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  timezone: z.string().nullable(),
  location: z.string().nullable(),
  organizer: calendarEventAttendeeSchema.nullable().optional(),
  attendees: z.array(calendarEventAttendeeSchema),
  isPrivate: z.boolean(),
  isCancelled: z.boolean(),
  isAllDay: z.boolean(),
  canAddReadyMeeting: z.boolean().optional(),
  needsCalendarWriteConsent: z.boolean().optional(),
  joinUrl: z.string().url().nullable(),
  readyMeeting: calendarReadyMeetingSchema.nullable().optional(),
  sourceUrl: z.string().url().nullable(),
});

export const calendarAccountSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  provider: calendarProviderSchema,
  providerAccountId: z.string().nullable(),
  providerEmail: z.string().email().nullable(),
  providerTenantId: z.string().nullable(),
  externalAccountEmail: z.string().email().nullable().optional(),
  status: providerAccountStatusSchema,
  accountKind: providerAccountKindSchema,
  scopes: z.array(z.string()),
  syncStatus: z.string(),
  lastSyncedAt: z.string().datetime().nullable(),
  connectedAt: z.string().datetime().nullable(),
  disconnectedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const calendarRealtimeEventNameSchema = z.enum(["calendar.events.changed"]);

export const calendarRealtimeEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().uuid(),
  eventName: calendarRealtimeEventNameSchema,
  userId: z.string().uuid(),
  provider: calendarProviderSchema,
  connectorId: z.string().uuid().nullable().optional(),
  calendarId: z.string().min(1).nullable().optional(),
  resourceState: z.string().min(1).nullable().optional(),
  messageNumber: z.string().min(1).nullable().optional(),
  occurredAt: z.string().datetime(),
});

export type CalendarProvider = z.infer<typeof calendarProviderSchema>;
export type ProviderAccountKind = z.infer<typeof providerAccountKindSchema>;
export type ProviderAccountStatus = z.infer<typeof providerAccountStatusSchema>;
export type CalendarReadyMeeting = z.infer<typeof calendarReadyMeetingSchema>;
export type NormalizedCalendarEvent = z.infer<typeof normalizedCalendarEventSchema>;
export type CalendarAccount = z.infer<typeof calendarAccountSchema>;
export type CalendarRealtimeEventName = z.infer<typeof calendarRealtimeEventNameSchema>;
