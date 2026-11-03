import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../domain/api-error";
import { getAddReadyMeetingErrorMessage } from "../../domain/calendar-ready-meeting-errors";

const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;
const HTTP_TOO_MANY_REQUESTS = 429;
const ROUTE_SUFFIX_REPEAT_COUNT = 255;
const ROUTE_NOT_FOUND_MESSAGE = `Route POST:/v1/me/calendar/accounts/account/events/_${"6".repeat(ROUTE_SUFFIX_REPEAT_COUNT)}/ready-meeting not found`;
const CALENDAR_EVENT_NOT_EDITABLE_CODE = "calendar_event_not_editable";
const LEGACY_TECHNICAL_MESSAGE = "legacy technical message";
const MEETING_PLAN_REQUIRED_CODE = "meeting_plan_required";
const CALENDAR_POLICY_BLOCKED_CODE = "calendar_policy_blocked";
const POLICY_BLOCKED_MESSAGE =
  "Your organization’s Google Calendar policy blocks this update. Contact your administrator.";
const HTML_PROXY_FAILURE_BODY = "<html>Proxy failure</html>";
const JSON_PROVIDER_FAILURE_BODY = '{"message":"provider request failed: secret details"}';
const FAILED_TO_FETCH_MESSAGE = "Failed to fetch";
const RATE_LIMIT_BODY = "rate limit";

void test("missing routes never appear as raw URLs or misleading calendar permission errors", () => {
  const error = new ApiError({
    status: HTTP_NOT_FOUND,
    responseText: JSON.stringify({ message: ROUTE_NOT_FOUND_MESSAGE }),
  });
  const message = getAddReadyMeetingErrorMessage(error);
  assert.match(message, /Ready could not process/);
  assert.doesNotMatch(message, /Route|\/v1|permission|organizer|deleted/);
});

void test("known event permission and plan failures explain the specific next step", () => {
  const permission = new ApiError({
    status: HTTP_FORBIDDEN,
    responseText: JSON.stringify({ code: CALENDAR_EVENT_NOT_EDITABLE_CODE, message: LEGACY_TECHNICAL_MESSAGE }),
  });
  assert.match(getAddReadyMeetingErrorMessage(permission), /Ask the organizer/);
  const plan = new ApiError({
    status: HTTP_FORBIDDEN,
    responseText: JSON.stringify({ code: MEETING_PLAN_REQUIRED_CODE }),
  });
  assert.match(getAddReadyMeetingErrorMessage(plan), /billing settings/);
});

void test("classified calendar reasons are preserved and unclassified server details are hidden", () => {
  assert.equal(
    getAddReadyMeetingErrorMessage(
      new ApiError({
        status: HTTP_FORBIDDEN,
        responseText: JSON.stringify({ code: CALENDAR_POLICY_BLOCKED_CODE, message: POLICY_BLOCKED_MESSAGE }),
      }),
    ),
    POLICY_BLOCKED_MESSAGE,
  );
  [HTML_PROXY_FAILURE_BODY, JSON_PROVIDER_FAILURE_BODY].forEach((body) => {
    assert.doesNotMatch(
      getAddReadyMeetingErrorMessage(new ApiError({ status: HTTP_BAD_GATEWAY, responseText: body })),
      /html|Proxy|secret|provider request/,
    );
  });
});

void test("network failures and rate limits offer different recovery advice", () => {
  assert.match(getAddReadyMeetingErrorMessage(new TypeError(FAILED_TO_FETCH_MESSAGE)), /internet connection/);
  assert.match(
    getAddReadyMeetingErrorMessage(new ApiError({ status: HTTP_TOO_MANY_REQUESTS, responseText: RATE_LIMIT_BODY })),
    /Wait a moment/,
  );
});
