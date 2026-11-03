import { ApiError, getApiErrorCode } from "./api-error";

const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_TOO_MANY_REQUESTS_STATUS = 429;
const HTTP_NOT_FOUND_STATUS = 404;

// Only surface messages from explicitly classified API responses. Legacy
// servers/proxies may return route paths, provider JSON or HTML instead.
const readableCodes = new Set([
  "calendar_write_scope_required",
  "calendar_policy_blocked",
  "calendar_rate_limited",
  "calendar_event_unavailable",
  "calendar_event_changed",
  "calendar_update_rejected",
  "calendar_provider_unavailable",
  "calendar_ready_meeting_failed",
  "calendar_account_not_found",
  "calendar_account_disconnected",
  "calendar_provider_unsupported",
  "calendar_reconnect_required",
]);

export function getAddReadyMeetingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = getApiErrorCode(error);
    if (code === "calendar_event_not_editable") {
      return "Google Calendar did not allow this event to be edited. Ask the organizer to add the video link.";
    }
    if (code === "meeting_plan_required") {
      return "Your workspace needs meeting access before you can add another video call. Check your plan in billing settings.";
    }
    if (code !== null && code !== "" && readableCodes.has(code)) {
      return error.displayMessage;
    }
    if (error.status === HTTP_UNAUTHORIZED_STATUS) {
      return "Your session or calendar connection has expired. Sign in again or reconnect Google Calendar, then retry.";
    }
    if (error.status === HTTP_TOO_MANY_REQUESTS_STATUS) {
      return "Too many requests. Wait a moment and try again.";
    }
    if (error.status === HTTP_NOT_FOUND_STATUS && /^Route\s+POST:.*\s+not found$/s.test(error.displayMessage)) {
      return "Ready could not process this event’s video-link request. Please try again later.";
    }
  }
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) {
    return "Could not reach Ready. Check your internet connection and try again.";
  }

  return "Ready could not add the video link. Please try again shortly.";
}
