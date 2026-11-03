import { z } from "zod";

export const authSchema = z
  .object({
    token: z.string(),
    user: z.object({ id: z.string().optional(), email: z.string().optional() }).passthrough().optional(),
    /** @external Ready auth wire field */
    accountCreated: z.boolean().optional(),
    webHandoffId: z.string().optional(),
    webHandoffToken: z.string().optional(),
  })
  .passthrough();

export const meetingResponseSchema = z
  .object({
    meetingLink: z
      .object({
        code: z.string(),
        callIn: z
          .object({
            phoneNumber: z.string().nullable().optional(),
            pin: z.union([z.string(), z.number()]).nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const identityPayloadSchema = z.object({ aud: z.union([z.string(), z.array(z.string())]) }).passthrough();

export type GoogleCalendarAuth = z.infer<typeof authSchema>;
export type GoogleCalendarMeetingLink = z.infer<typeof meetingResponseSchema>["meetingLink"];
