import { z } from "zod";

import { CalendarProviderRequestError } from "./calendar-client";

const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_FORBIDDEN_STATUS = 403;
const HTTP_NOT_FOUND_STATUS = 404;
const HTTP_CONFLICT_STATUS = 409;
const HTTP_GONE_STATUS = 410;
const HTTP_PRECONDITION_FAILED_STATUS = 412;
const HTTP_TOO_MANY_REQUESTS_STATUS = 429;
const HTTP_SERVER_ERROR_STATUS = 500;
const HTTP_BAD_GATEWAY_STATUS = 502;

const CALENDAR_ERROR_COPY = {
  rateLimited: "Google Calendar is receiving too many requests. Wait a moment and try again.",
  writeScopeRequired: "Allow Ready to edit your Google Calendar, then try again.",
  policyBlocked: "Your organization’s Google Calendar policy blocks this update. Contact your administrator.",
  eventNotEditable: "Google Calendar did not allow this event to be edited. Ask the organizer to add the video link.",
  eventUnavailable:
    "This event was deleted or is no longer accessible in Google Calendar. Refresh your calendar and try again.",
  eventChanged: "This event changed in Google Calendar. Refresh your calendar and try again.",
  updateRejected: "Google Calendar rejected the update to this event. Refresh your calendar and try again.",
  providerUnavailable: "Google Calendar is temporarily unavailable. Please try again shortly.",
  requestFailed: "Ready could not add the video link. Please try again shortly.",
} as const;

const CALENDAR_ERROR_CODE = {
  rateLimited: "calendar_rate_limited",
  writeScopeRequired: "calendar_write_scope_required",
  policyBlocked: "calendar_policy_blocked",
  eventNotEditable: "calendar_event_not_editable",
  eventUnavailable: "calendar_event_unavailable",
  eventChanged: "calendar_event_changed",
  updateRejected: "calendar_update_rejected",
  providerUnavailable: "calendar_provider_unavailable",
  requestFailed: "calendar_ready_meeting_failed",
} as const;

const calendarProviderErrorEntrySchema = z.object({ reason: z.string() }).passthrough();
// Entries are parsed one by one so a malformed sibling never hides a valid provider reason.
const calendarProviderPayloadSchema = z
  .object({
    error: z.object({ errors: z.array(z.unknown()).optional() }).optional(),
  })
  .passthrough();

function isCalendarRateLimited(input: { status: number; reasons: string[] }) {
  const rateLimitReasons = ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"];

  return (
    input.status === HTTP_TOO_MANY_REQUESTS_STATUS || input.reasons.some((reason) => rateLimitReasons.includes(reason))
  );
}

/** Keep provider payloads in server logs; return actionable, classified errors. */
export function getCalendarReadyMeetingError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof CalendarProviderRequestError) {
    const parsedPayload = calendarProviderPayloadSchema.safeParse(error.payload);
    const entries = parsedPayload.success ? parsedPayload.data.error?.errors : undefined;
    const reasons = (entries ?? []).map((entry) => {
      const parsedEntry = calendarProviderErrorEntrySchema.safeParse(entry);

      return parsedEntry.success ? parsedEntry.data.reason : undefined;
    });
    if (
      isCalendarRateLimited({
        status: error.status,
        reasons: reasons.map((reason) => reason ?? ""),
      })
    ) {
      return {
        status: HTTP_TOO_MANY_REQUESTS_STATUS,
        code: CALENDAR_ERROR_CODE.rateLimited,
        message: CALENDAR_ERROR_COPY.rateLimited,
      };
    }
    if (error.status === HTTP_FORBIDDEN_STATUS) {
      if (reasons.includes("insufficientPermissions")) {
        return {
          status: HTTP_FORBIDDEN_STATUS,
          code: CALENDAR_ERROR_CODE.writeScopeRequired,
          message: CALENDAR_ERROR_COPY.writeScopeRequired,
        };
      }
      if (reasons.includes("domainPolicy")) {
        return {
          status: HTTP_FORBIDDEN_STATUS,
          code: CALENDAR_ERROR_CODE.policyBlocked,
          message: CALENDAR_ERROR_COPY.policyBlocked,
        };
      }

      return {
        status: HTTP_FORBIDDEN_STATUS,
        code: CALENDAR_ERROR_CODE.eventNotEditable,
        message: CALENDAR_ERROR_COPY.eventNotEditable,
      };
    }
    if (error.status === HTTP_NOT_FOUND_STATUS || error.status === HTTP_GONE_STATUS) {
      return {
        status: HTTP_NOT_FOUND_STATUS,
        code: CALENDAR_ERROR_CODE.eventUnavailable,
        message: CALENDAR_ERROR_COPY.eventUnavailable,
      };
    }
    if (error.status === HTTP_CONFLICT_STATUS || error.status === HTTP_PRECONDITION_FAILED_STATUS) {
      return {
        status: HTTP_CONFLICT_STATUS,
        code: CALENDAR_ERROR_CODE.eventChanged,
        message: CALENDAR_ERROR_COPY.eventChanged,
      };
    }
    if (error.status === HTTP_BAD_REQUEST_STATUS) {
      return {
        status: HTTP_BAD_REQUEST_STATUS,
        code: CALENDAR_ERROR_CODE.updateRejected,
        message: CALENDAR_ERROR_COPY.updateRejected,
      };
    }
    if (error.status >= HTTP_SERVER_ERROR_STATUS) {
      return {
        status: HTTP_BAD_GATEWAY_STATUS,
        code: CALENDAR_ERROR_CODE.providerUnavailable,
        message: CALENDAR_ERROR_COPY.providerUnavailable,
      };
    }
  }

  return {
    status: HTTP_BAD_GATEWAY_STATUS,
    code: CALENDAR_ERROR_CODE.requestFailed,
    message: CALENDAR_ERROR_COPY.requestFailed,
  };
}
