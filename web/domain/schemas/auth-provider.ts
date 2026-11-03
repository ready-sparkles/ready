import { meetingJoinRequestStatusSchema, userSchema } from "@readymeet/shared";
import { z } from "zod";

export const storedGuestSessionSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  joinRequestId: z.string().optional(),
  meetingId: z.string().nullable().optional(),
  meetingLinkCode: z.string().optional(),
  status: meetingJoinRequestStatusSchema.optional(),
  user: userSchema,
});
