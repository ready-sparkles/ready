import type { GoogleCalendarAuth, GoogleCalendarMeetingLink } from "./contracts";

export const AUTH_CACHE_KEY = "ready-auth-v2";
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const CACHE_HOURS = 6;
const HOURS_TO_SECONDS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
export const AUTH_CACHE_TTL_SECONDS = CACHE_HOURS * HOURS_TO_SECONDS;
export const CONFERENCE_SOLUTION_ID = "ready-meeting";
export const HTTP_OK = 200;
export const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const TITLE_MAX_LENGTH = 255;
const DEFAULT_CONFERENCE_TITLE = "Ready meeting";
const DEFAULT_ACCOUNT_LABEL = "your Google account";
const WORKSPACE_CALLBACK_PATH = "/workspace";
const AUTH_SOURCE = "google-workspace-addon";

export type GoogleCalendarErrorType = "authentication" | "temporary" | "reconnect";

type CalendarEventData = {
  calendarId?: string;
  eventId?: string;
  id?: string;
  summary?: string;
};

type CalendarEvent = {
  calendarId?: string;
  id?: string;
  eventId?: string;
  calendarEventData?: CalendarEventData;
};

export type GoogleCalendarEvent = {
  calendar?: CalendarEvent;
  calendarEventObject?: CalendarEvent;
};

export type GoogleCalendarCallIn = NonNullable<GoogleCalendarMeetingLink["callIn"]>;

const calendarOf = (event: GoogleCalendarEvent | null | undefined): CalendarEvent | null => {
  if (event === null || event === undefined) {
    return null;
  }

  return event.calendar ?? event.calendarEventObject ?? null;
};

const isPresent = (value: string | undefined): value is string => value !== undefined && value !== "";

export const conferenceErrorTypeForResponseCode = (
  responseCode: number,
): Exclude<GoogleCalendarErrorType, "reconnect"> =>
  responseCode === HTTP_UNAUTHORIZED || responseCode === HTTP_FORBIDDEN ? "authentication" : "temporary";

export const conferenceContext = (
  event: GoogleCalendarEvent | null | undefined,
): { calendarId: string; eventId: string } | null => {
  const calendar = calendarOf(event);
  if (calendar === null) {
    return null;
  }
  const eventData = calendar.calendarEventData;
  const calendarId = calendar.calendarId ?? eventData?.calendarId;
  const eventId = calendar.id ?? calendar.eventId ?? eventData?.eventId ?? eventData?.id;
  if (!isPresent(calendarId) || !isPresent(eventId)) {
    return null;
  }

  return { calendarId, eventId };
};

export const conferenceTitle = (event: GoogleCalendarEvent | null | undefined): string => {
  // currentEventAccess remains off; the generic title needs no extra scope.
  const summary = calendarOf(event)?.calendarEventData?.summary;
  if (!isPresent(summary)) {
    return DEFAULT_CONFERENCE_TITLE;
  }

  return summary.trim().slice(0, TITLE_MAX_LENGTH);
};

export const phoneEntryUri = (callIn: { phoneNumber: string; pin?: string | number | null }): string => {
  const uri = `tel:${callIn.phoneNumber.replace(/[^\d+]/g, "")}`;
  if (callIn.pin === undefined || callIn.pin === null || callIn.pin === "") {
    return uri;
  }

  return `${uri},,,${String(callIn.pin)}`;
};

export const displayPin = (pin: string | number): string => {
  const value = String(pin).trim();
  if (value === "" || value.slice(-1) === "#") {
    return value;
  }

  return `${value}#`;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const homepageCopy = ({
  auth,
  isAccountCreated,
  webBaseUrl,
}: {
  auth: GoogleCalendarAuth;
  isAccountCreated: boolean;
  webBaseUrl: string;
}): { title: string; body: string } => {
  const email = auth.user?.email;
  const accountLabel = email !== undefined && email !== "" ? email : DEFAULT_ACCOUNT_LABEL;

  return {
    title: isAccountCreated ? "Your free Ready account is ready" : "Ready is connected",
    body:
      `Connected as <b>${escapeHtml(accountLabel)}</b>.<br><br>` +
      "Create a Calendar event and choose <b>Ready Meeting</b> from the video conferencing options.<br><br>" +
      "Meetings work immediately on the free plan. AI features use your available Ready credits.<br><br>" +
      `By using Ready, you agree to the <a href="${webBaseUrl}/terms">Terms of Use</a> ` +
      `and acknowledge the <a href="${webBaseUrl}/privacy">Privacy Policy</a>.`,
  };
};

const isHandoffUser = (
  auth: GoogleCalendarAuth,
): auth is GoogleCalendarAuth & {
  user: { id: string; email: string };
  webHandoffId: string;
  webHandoffToken: string;
} => {
  const user = auth.user;
  if (user === undefined || !isPresent(user.id) || !isPresent(user.email)) {
    return false;
  }

  return isPresent(auth.webHandoffId) && isPresent(auth.webHandoffToken);
};

export const readyWebSignInUrl = ({
  auth,
  webBaseUrl,
}: {
  auth: GoogleCalendarAuth;
  webBaseUrl: string;
}): string | null => {
  if (!isHandoffUser(auth)) {
    return null;
  }

  return (
    `${webBaseUrl}/login?source=${AUTH_SOURCE}&accountId=${encodeURIComponent(auth.user.id)}` +
    `&loginHint=${encodeURIComponent(auth.user.email)}&handoffId=${encodeURIComponent(auth.webHandoffId)}` +
    `&handoffToken=${encodeURIComponent(auth.webHandoffToken)}&callbackUrl=${encodeURIComponent(WORKSPACE_CALLBACK_PATH)}`
  );
};
