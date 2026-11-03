import { createHash } from "node:crypto";

export function outlookAddonConferenceIdempotencyKey(requestId: string): string {
  return createHash("sha256").update(`outlook-addon-v1\0${requestId.toLowerCase()}`).digest("hex");
}

export function googleAddonConferenceIdempotencyKey(input: { calendarId: string; eventId: string }): string {
  return createHash("sha256").update(`google-calendar-addon-v1\0${input.calendarId}\0${input.eventId}`).digest("hex");
}
