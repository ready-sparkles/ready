import assert from "node:assert/strict";
import test from "node:test";

import {
  CalendarProviderRequestError,
  isCalendarProviderAuthError,
  patchGoogleCalendarEventWithReadyMeeting,
} from "../../application/calendar-client";
import { getCalendarReadyMeetingError } from "../../application/calendar-ready-meeting-errors";

const GOOGLE_CALENDAR_PROVIDER = "google_calendar";
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;
const GOOGLE_CALENDAR_FORBIDDEN_STATUS = HTTP_FORBIDDEN;
const INSUFFICIENT_PERMISSIONS_REASON = "insufficientPermissions";
const RATE_LIMIT_EXCEEDED_REASON = "rateLimitExceeded";
const CALENDAR_WRITE_SCOPE_REQUIRED_CODE = "calendar_write_scope_required";
const CALENDAR_RATE_LIMITED_CODE = "calendar_rate_limited";
const PRIVATE_PROVIDER_DETAILS_MESSAGE = "private provider details";
const DATABASE_CONNECTION_DETAILS_MESSAGE = "database connection details";

const CALENDAR_ERROR_CASES = [
  [HTTP_FORBIDDEN, "forbiddenForNonOrganizer", "calendar_event_not_editable"],
  [HTTP_FORBIDDEN, "forbidden", "calendar_event_not_editable"],
  [HTTP_FORBIDDEN, "insufficientPermissions", "calendar_write_scope_required"],
  [HTTP_FORBIDDEN, "domainPolicy", "calendar_policy_blocked"],
  [HTTP_FORBIDDEN, "rateLimitExceeded", "calendar_rate_limited"],
  [HTTP_FORBIDDEN, "userRateLimitExceeded", "calendar_rate_limited"],
  [HTTP_TOO_MANY_REQUESTS, "", "calendar_rate_limited"],
  [HTTP_NOT_FOUND, "notFound", "calendar_event_unavailable"],
  [HTTP_GONE, "deleted", "calendar_event_unavailable"],
  [HTTP_PRECONDITION_FAILED, "conditionNotMet", "calendar_event_changed"],
  [HTTP_BAD_REQUEST, "invalid", "calendar_update_rejected"],
  [HTTP_SERVICE_UNAVAILABLE, "backendError", "calendar_provider_unavailable"],
] as const;

CALENDAR_ERROR_CASES.forEach(([status, reason, code]) => {
  void test(`calendar change ${status}/${reason} reports ${code} without raw provider details`, async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: PRIVATE_PROVIDER_DETAILS_MESSAGE,
              errors: [{ reason }],
            },
          }),
          { status },
        ),
    );
    await assert.rejects(
      patchGoogleCalendarEventWithReadyMeeting(
        {
          provider: "google_calendar",
          accessToken: "test",
          refreshToken: "test",
          expiresAt: "2030-01-01T00:00:00Z",
          scope: "",
          tokenType: "Bearer",
        },
        { calendarId: "primary", eventId: "event", event: {}, joinUrl: "https://ready.app/abc-defg-hij" },
      ),
      (error) => {
        assert.ok(error instanceof CalendarProviderRequestError);
        assert.equal(isCalendarProviderAuthError(error), false, "event refusal must not disconnect the calendar");
        const result = getCalendarReadyMeetingError(error);
        assert.equal(result.code, code);
        assert.doesNotMatch(result.message, /private provider details|errors|backendError/);
        if (code === "calendar_rate_limited") {
          assert.equal(result.status, HTTP_TOO_MANY_REQUESTS);
        }

        return true;
      },
    );
  });
});

void test("valid provider reasons survive malformed siblings", () => {
  const permissionResult = getCalendarReadyMeetingError(
    new CalendarProviderRequestError(GOOGLE_CALENDAR_PROVIDER, GOOGLE_CALENDAR_FORBIDDEN_STATUS, {
      error: { errors: [{ reason: INSUFFICIENT_PERMISSIONS_REASON }, null, { reason: 0 }] },
    }),
  );
  const rateLimitResult = getCalendarReadyMeetingError(
    new CalendarProviderRequestError(GOOGLE_CALENDAR_PROVIDER, GOOGLE_CALENDAR_FORBIDDEN_STATUS, {
      error: { errors: [{ reason: RATE_LIMIT_EXCEEDED_REASON }, null] },
    }),
  );

  assert.equal(permissionResult.code, CALENDAR_WRITE_SCOPE_REQUIRED_CODE);
  assert.equal(rateLimitResult.code, CALENDAR_RATE_LIMITED_CODE);
});

void test("unknown failures do not leak database errors or pretend to be permission failures", () => {
  const result = getCalendarReadyMeetingError(new Error(DATABASE_CONNECTION_DETAILS_MESSAGE));
  assert.equal(result.code, "calendar_ready_meeting_failed");
  assert.doesNotMatch(result.message, /database|permission/);
});
