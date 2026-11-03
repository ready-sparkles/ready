import type { GoogleCalendarAuth, GoogleCalendarMeetingLink } from "../domain/google-calendar/contracts";

export type GoogleCalendarHttpResult = {
  status: number;
  body: string;
};

export type GoogleCalendarFetchOptions = {
  method?: string;
  payload?: Record<string, unknown>;
};

// What Calendar conference and homepage flows need from the Apps Script host.
export type GoogleCalendarPort = {
  requireScopes: () => void;
  webBaseUrl: () => string;
  identityToken: () => string | null;
  calendarToken: () => string;
  cachedAuth: () => string | null;
  parseAuth: (text: string) => GoogleCalendarAuth;
  saveAuth: (auth: GoogleCalendarAuth) => void;
  clearAuth: () => void;
  exchangeAuth: (idToken: string) => GoogleCalendarHttpResult;
  fetch: (input: {
    auth: GoogleCalendarAuth;
    path: string;
    options?: GoogleCalendarFetchOptions;
  }) => GoogleCalendarHttpResult;
  meetingLink: (body: string) => GoogleCalendarMeetingLink;
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  debugIdentityAudience: () => string | string[];
  debugVerify: () => void;
};
