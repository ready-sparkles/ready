import { z } from "zod";

import { calendarProviderSchema } from "./calendar";

const MAX_MEETING_INVITE_DISPLAY_NAME_LENGTH = 160;
const MAX_MEETING_INVITE_QUERY_LENGTH = 160;
const MAX_MEETING_INVITE_RECIPIENTS = 10;

const meetingInviteEmailSchema = z
  .string()
  .trim()
  .email()
  .transform((email) => email.toLowerCase());

export const meetingInviteSuggestionSchema = z.object({
  email: meetingInviteEmailSchema,
  displayName: z.string().trim().min(1).max(MAX_MEETING_INVITE_DISPLAY_NAME_LENGTH),
  avatarUrl: z.string().url().nullable(),
  provider: calendarProviderSchema,
});

export const meetingInviteSuggestionsQuerySchema = z.object({
  q: z.string().trim().max(MAX_MEETING_INVITE_QUERY_LENGTH).optional().default(""),
});

export const meetingInviteSuggestionsResponseSchema = z.object({
  suggestions: z.array(meetingInviteSuggestionSchema),
  connectedProviders: z.array(calendarProviderSchema),
  reconnectRequiredProviders: z.array(calendarProviderSchema),
});

export const sendMeetingInvitesRequestSchema = z
  .object({
    emails: z.array(meetingInviteEmailSchema).min(1).max(MAX_MEETING_INVITE_RECIPIENTS),
  })
  .transform((input) => ({
    emails: Array.from(new Set(input.emails)),
  }));

export const sendMeetingInvitesResponseSchema = z.object({
  sent: z.array(meetingInviteEmailSchema),
  failures: z.array(
    z.object({
      email: meetingInviteEmailSchema,
      reason: z.literal("send_failed"),
    }),
  ),
});

export type MeetingInviteSuggestion = z.infer<typeof meetingInviteSuggestionSchema>;
export type MeetingInviteSuggestionsResponse = z.infer<typeof meetingInviteSuggestionsResponseSchema>;
export type SendMeetingInvitesRequest = z.infer<typeof sendMeetingInvitesRequestSchema>;
export type SendMeetingInvitesResponse = z.infer<typeof sendMeetingInvitesResponseSchema>;
