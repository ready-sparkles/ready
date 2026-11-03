import type { guestMeetingNotesResponseSchema } from "@readymeet/shared";
import type { z } from "zod";

export type GuestNotesState = z.infer<typeof guestMeetingNotesResponseSchema>;
