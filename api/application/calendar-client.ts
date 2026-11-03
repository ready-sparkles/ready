import type { CalendarProvider, CalendarReadyMeeting, NormalizedCalendarEvent } from "@readymeet/shared";
import {
  buildReadyMeetCalendarDescriptionText,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_SCOPES,
  READY_MEET_DESCRIPTION_BLOCK_END,
  READY_MEET_DESCRIPTION_BLOCK_START,
} from "@readymeet/shared";
import { z } from "zod";

import { apiEnv } from "../ports/api-env";
import { replaceReadyDescriptionBlocks } from "../ports/gate-calendar-description-blocks";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_EVENTS_WATCH_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch";
const GOOGLE_PEOPLE_CONNECTIONS_URL = "https://people.googleapis.com/v1/people/me/connections";
const GOOGLE_PEOPLE_SEARCH_CONTACTS_URL = "https://people.googleapis.com/v1/people:searchContacts";
const GOOGLE_PEOPLE_SEARCH_DIRECTORY_URL = "https://people.googleapis.com/v1/people:searchDirectoryPeople";
const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_CALENDAR_VIEW_URL = "https://graph.microsoft.com/v1.0/me/calendarView";
const MICROSOFT_ME_URL = "https://graph.microsoft.com/v1.0/me";
const MICROSOFT_PEOPLE_URL = "https://graph.microsoft.com/v1.0/me/people";
const MICROSOFT_SUBSCRIPTIONS_URL = "https://graph.microsoft.com/v1.0/subscriptions";

export const GOOGLE_CALENDAR_PHOTO_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
] as const;

const OUTLOOK_PEOPLE_SCOPE = "People.Read";

export const OUTLOOK_CALENDAR_SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  OUTLOOK_PEOPLE_SCOPE,
] as const;

const GOOGLE_PERSON_PHOTO_READ_MASK = "names,emailAddresses,photos";
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const GOOGLE_PERSON_PHOTO_CACHE_TTL_HOURS = HOURS_PER_DAY;
const GOOGLE_CONTACT_SEARCH_WARMUP_MINUTES = 10;
const GOOGLE_PERSON_PHOTO_CACHE_TTL_MS =
  GOOGLE_PERSON_PHOTO_CACHE_TTL_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const GOOGLE_CONTACT_SEARCH_WARMUP_TTL_MS =
  GOOGLE_CONTACT_SEARCH_WARMUP_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const GOOGLE_PERSON_PHOTO_LOOKUP_TIMEOUT_MS = 800;
const GOOGLE_PERSON_PHOTO_TOTAL_TIMEOUT_MS = 1600;
const SECONDS_PER_HOUR = 3600;
const DEFAULT_TOKEN_EXPIRES_SECONDS = SECONDS_PER_HOUR;
const CALENDAR_TOKEN_REFRESH_LEAD_MS = 120_000;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const DEFAULT_CALENDAR_LIST_LIMIT = 50;
const MAX_CALENDAR_LIST_LIMIT = 100;
const MAX_CALENDAR_INVITE_CONTACT_PAGE_SIZE = 30;
const MAX_GOOGLE_CONNECTIONS_PAGE_SIZE = 1000;
const GOOGLE_PHOTO_LOOKUP_BATCH_SIZE = 4;
const GOOGLE_CONTACT_SEARCH_PAGE_SIZE = 10;
const GOOGLE_CONTACT_WARMUP_PAGE_SIZE = 1;
const MIN_BATCH_TIMEOUT_MS = 1;
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const TEL_URI_PREFIX_LENGTH = 4;
const OAUTH_TOKEN_TYPE_BEARER = "Bearer";
const UTC_TIMEZONE_LABEL = "UTC";
const ALL_DAY_EVENT_NOON_TIME_SUFFIX = "T12:00:00.000Z";
const UNTITLED_EVENT_TITLE = "Untitled event";
const PRIVATE_EVENT_TITLE = "Private event";
const GOOGLE_CALENDAR_PRIMARY_ID = "primary";

const MESSAGE_CALENDAR_OAUTH_NOT_CONFIGURED_SUFFIX = " OAuth is not configured";
const MESSAGE_CALENDAR_TOKEN_RESPONSE_INCOMPLETE_SUFFIX = " token response did not include usable credentials";
const MESSAGE_CALENDAR_TOKEN_REQUEST_FAILED_PREFIX = " token request failed: ";
const MESSAGE_CALENDAR_CREDENTIALS_EXPIRED_OR_REVOKED_SUFFIX = " credentials are expired or revoked";
const MESSAGE_CALENDAR_CREDENTIALS_UNAUTHORIZED_SUFFIX = " credentials are expired or no longer authorized";
const MESSAGE_CALENDAR_REQUEST_FAILED_MIDDLE = " request failed (";
const MESSAGE_CALENDAR_REQUEST_FAILED_SUFFIX = "): ";
const MESSAGE_OUTLOOK_MAILBOX_UNAVAILABLE =
  "Outlook Calendar is not available for this Microsoft account because its mailbox is not enabled for Microsoft Graph calendar access";
const MESSAGE_GOOGLE_ACCOUNT_IDENTITY_MISSING = "Google Calendar account identity is missing";
const MESSAGE_GOOGLE_CALENDAR_WATCH_REQUIRES_TOKENS = "Google Calendar watch requires Google Calendar tokens";
const MESSAGE_GOOGLE_CALENDAR_DELETE_REQUIRES_TOKENS = "Google Calendar event deletion requires Google Calendar tokens";
const MESSAGE_GOOGLE_CALENDAR_LOOKUP_REQUIRES_TOKENS = "Google Calendar event lookup requires Google Calendar tokens";
const MESSAGE_GOOGLE_CALENDAR_PATCH_REQUIRES_TOKENS = "Google Calendar event patching requires Google Calendar tokens";
const MESSAGE_OUTLOOK_SUBSCRIPTION_REQUIRES_TOKENS = "Outlook Calendar subscription requires Outlook Calendar tokens";

const jsonRecordSchema = z.record(z.string(), z.unknown());

const oauthTokenErrorResponseSchema = z.object({
  error: z.string().optional(),
});

const oauthTokenSuccessResponseSchema = z.object({
  access_token: z.unknown().optional(),
  refresh_token: z.unknown().optional(),
  expires_in: z.number().optional(),
  token_type: z.unknown().optional(),
  scope: z.union([z.string(), z.array(z.unknown())]).optional(),
});

const outlookEventBodySchema = z.object({
  content: z.unknown().optional(),
});

export type CalendarTokenSet = {
  provider: CalendarProvider;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
  tokenType: string;
};

export type CalendarAccountProfile = {
  providerAccountId: string | null;
  email: string;
  displayName: string | null;
  tenantId: string | null;
};

type CalendarListInput = {
  timeMin: string;
  timeMax: string;
  /** @external calendar list include cancelled events */
  includeCancelled?: boolean;
  limit?: number;
  requestingUserId?: string;
};

type CalendarFetchInit = RequestInit & {
  /** @external calendar fetch treat 403 as auth error */
  treatForbiddenAsAuthError?: boolean;
};

type CalendarEventPerson = NonNullable<NormalizedCalendarEvent["organizer"]>;

type GooglePeopleProfileCacheEntry = {
  avatarUrl: string | null;
  displayName: string | null;
  expiresAt: number;
};

type GooglePerson = {
  emailAddresses?: { value?: unknown; metadata?: { primary?: unknown } }[];
  names?: { displayName?: unknown; givenName?: unknown; familyName?: unknown }[];
  photos?: { url?: unknown; default?: unknown }[];
};

type MicrosoftPeopleResponse = {
  value?: {
    displayName?: unknown;
    emailAddresses?: { address?: unknown }[];
    scoredEmailAddresses?: { address?: unknown; relevanceScore?: unknown }[];
  }[];
};

type CalendarInviteContact = {
  email: string;
  displayName: string;
  avatarUrl: string | null;
  provider: CalendarProvider;
};

const googlePersonProfileCache = new Map<string, GooglePeopleProfileCacheEntry>();
const googleContactSearchWarmups = new Map<string, number>();

const CALENDAR_AUTH_ERROR_CODES = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);
const MICROSOFT_MAILBOX_NOT_ENABLED_FOR_REST_API = "MailboxNotEnabledForRESTAPI";

const CALENDAR_PROVIDER_LABEL: Record<CalendarProvider, string> = {
  google_calendar: "Google Calendar",
  outlook_calendar: "Outlook Calendar",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function readString(input: { value: unknown; fallback?: string }): string {
  const text = readNonEmptyString(input.value);

  return text ?? input.fallback ?? "";
}

function configuredOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

function calendarProviderMessage(input: { provider: CalendarProvider; body: string }): string {
  return `${CALENDAR_PROVIDER_LABEL[input.provider]}${input.body}`;
}

function calendarOAuthNotConfiguredMessage(provider: CalendarProvider): string {
  return calendarProviderMessage({ provider, body: MESSAGE_CALENDAR_OAUTH_NOT_CONFIGURED_SUFFIX });
}

function calendarTokenResponseIncompleteMessage(provider: CalendarProvider): string {
  return calendarProviderMessage({ provider, body: MESSAGE_CALENDAR_TOKEN_RESPONSE_INCOMPLETE_SUFFIX });
}

function calendarCredentialsExpiredOrRevokedMessage(provider: CalendarProvider): string {
  return calendarProviderMessage({ provider, body: MESSAGE_CALENDAR_CREDENTIALS_EXPIRED_OR_REVOKED_SUFFIX });
}

function calendarCredentialsUnauthorizedMessage(provider: CalendarProvider): string {
  return calendarProviderMessage({ provider, body: MESSAGE_CALENDAR_CREDENTIALS_UNAUTHORIZED_SUFFIX });
}

function calendarTokenRequestFailedMessage(input: {
  provider: CalendarProvider;
  payload: Record<string, unknown>;
}): string {
  return calendarProviderMessage({
    provider: input.provider,
    body: `${MESSAGE_CALENDAR_TOKEN_REQUEST_FAILED_PREFIX}${JSON.stringify(input.payload)}`,
  });
}

function formatCalendarProviderRequestErrorMessage(input: {
  provider: CalendarProvider;
  status: number;
  payload: unknown;
}): string {
  return calendarProviderMessage({
    provider: input.provider,
    body: `${MESSAGE_CALENDAR_REQUEST_FAILED_MIDDLE}${input.status}${MESSAGE_CALENDAR_REQUEST_FAILED_SUFFIX}${JSON.stringify(input.payload)}`,
  });
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  const jsonPayload: unknown = await response.json();
  const parsed = jsonRecordSchema.safeParse(jsonPayload);
  if (!parsed.success) {
    return {};
  }

  return parsed.data;
}

function parseJsonRecordFromText(text: string): Record<string, unknown> | string {
  try {
    const jsonPayload: unknown = JSON.parse(text);
    const parsed = jsonRecordSchema.safeParse(jsonPayload);

    return parsed.success ? parsed.data : text;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return text;
    }
    throw error;
  }
}

export class CalendarProviderAuthError extends Error {
  readonly provider: CalendarProvider;
  readonly status?: number;
  readonly payload: unknown;

  constructor(
    ...args: [provider: CalendarProvider, message: string, options?: { status?: number; payload?: unknown }]
  ) {
    const provider = args[0];
    const message = args[1];
    const options = args[2] ?? {};
    super(message);
    this.name = "CalendarProviderAuthError";
    this.provider = provider;
    this.status = options.status;
    this.payload = options.payload;
  }
}

export function isCalendarProviderAuthError(error: unknown): error is CalendarProviderAuthError {
  return error instanceof CalendarProviderAuthError;
}

export class CalendarProviderRequestError extends Error {
  readonly provider: CalendarProvider;
  readonly status: number;
  readonly payload: unknown;

  constructor(...args: [provider: CalendarProvider, status: number, payload: unknown]) {
    const provider = args[0];
    const status = args[1];
    const payload = args[2];
    super(formatCalendarProviderRequestErrorMessage({ provider, status, payload }));
    this.name = "CalendarProviderRequestError";
    this.provider = provider;
    this.status = status;
    this.payload = payload;
  }
}
type CalendarOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

function providerConfig(provider: CalendarProvider): {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
} {
  if (provider === "google_calendar") {
    return {
      clientId: configuredOrNull(apiEnv().GOOGLE_CALENDAR_CLIENT_ID),
      clientSecret: configuredOrNull(apiEnv().GOOGLE_CALENDAR_CLIENT_SECRET),
      redirectUri: configuredOrNull(apiEnv().GOOGLE_CALENDAR_REDIRECT_URI),
    };
  }

  return {
    clientId: configuredOrNull(apiEnv().OUTLOOK_CALENDAR_CLIENT_ID),
    clientSecret: configuredOrNull(apiEnv().OUTLOOK_CALENDAR_CLIENT_SECRET),
    redirectUri: configuredOrNull(apiEnv().OUTLOOK_CALENDAR_REDIRECT_URI),
  };
}

function requireCalendarConfig(provider: CalendarProvider): CalendarOAuthConfig {
  const config = providerConfig(provider);
  if (
    config.clientId === null ||
    config.clientSecret === null ||
    config.redirectUri === null ||
    config.clientId.length === 0 ||
    config.clientSecret.length === 0 ||
    config.redirectUri.length === 0
  ) {
    throw new Error(calendarOAuthNotConfiguredMessage(provider));
  }

  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  };
}

function buildCalendarAuthorizationUrlNamed(input: {
  provider: CalendarProvider;
  state: string;
  /** @external google oauth recover offline access */
  recoverOfflineAccess?: boolean;
  loginHint?: string;
}): string {
  const config = requireCalendarConfig(input.provider);
  if (input.provider === "google_calendar") {
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    // Marketplace installation already grants these scopes. Only a lost
    // offline credential needs an explicit recovery consent request.
    if (input.recoverOfflineAccess === true) {
      url.searchParams.set("prompt", "consent");
    }
    const loginHint = readNonEmptyString(input.loginHint);
    if (loginHint !== null) {
      url.searchParams.set("login_hint", loginHint);
    }
    url.searchParams.set("state", input.state);

    return url.toString();
  }

  const url = new URL(MICROSOFT_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", OUTLOOK_CALENDAR_SCOPES.join(" "));
  url.searchParams.set("state", input.state);

  return url.toString();
}

type BuildCalendarAuthorizationUrlInput = {
  provider: CalendarProvider;
  state: string;
  /** @external google oauth recover offline access */
  recoverOfflineAccess?: boolean;
  loginHint?: string;
};

export function buildCalendarAuthorizationUrl(...args: [input: BuildCalendarAuthorizationUrlInput]): string {
  return buildCalendarAuthorizationUrlNamed(args[0]);
}

function normalizeTokenScope(input: { scope: unknown; fallbackScope?: string }): string {
  const fallbackScope = input.fallbackScope ?? "";
  if (Array.isArray(input.scope)) {
    return input.scope.map(String).join(" ");
  }
  if (typeof input.scope === "string" && input.scope.trim().length > 0) {
    return input.scope;
  }

  return fallbackScope;
}

function parseTokenResponse(input: {
  provider: CalendarProvider;
  payload: Record<string, unknown>;
  fallbackRefreshToken?: string;
  fallbackScope?: string;
  /** @external oauth token response requires refresh token */
  requireRefreshToken?: boolean;
}): CalendarTokenSet {
  const shouldRequireRefreshToken = input.requireRefreshToken ?? true;
  const parsedPayload = oauthTokenSuccessResponseSchema.safeParse(input.payload);
  const payload = parsedPayload.success ? parsedPayload.data : {};
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : DEFAULT_TOKEN_EXPIRES_SECONDS;
  const refreshToken =
    readNonEmptyString(payload.refresh_token) ?? readNonEmptyString(input.fallbackRefreshToken) ?? "";
  const accessToken = readNonEmptyString(payload.access_token);
  if (accessToken === null || (shouldRequireRefreshToken && refreshToken.length === 0)) {
    throw new Error(calendarTokenResponseIncompleteMessage(input.provider));
  }

  const tokenType = readNonEmptyString(payload.token_type) ?? OAUTH_TOKEN_TYPE_BEARER;

  return {
    provider: input.provider,
    accessToken,
    refreshToken,
    tokenType,
    scope: normalizeTokenScope({ scope: payload.scope, fallbackScope: input.fallbackScope }),
    expiresAt: new Date(Date.now() + expiresIn * MILLISECONDS_PER_SECOND).toISOString(),
  };
}

async function exchangeCalendarToken(input: {
  provider: CalendarProvider;
  body: URLSearchParams;
}): Promise<Record<string, unknown>> {
  const tokenUrl = input.provider === "google_calendar" ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: input.body,
  });
  const payload = await readJsonRecord(response);
  if (!response.ok) {
    const errorParsed = oauthTokenErrorResponseSchema.safeParse(payload);
    const errorCode = errorParsed.success ? errorParsed.data.error : undefined;
    if (errorCode !== undefined && errorCode.length > 0 && CALENDAR_AUTH_ERROR_CODES.has(errorCode)) {
      throw new CalendarProviderAuthError(input.provider, calendarCredentialsExpiredOrRevokedMessage(input.provider), {
        status: response.status,
        payload,
      });
    }
    throw new Error(calendarTokenRequestFailedMessage({ provider: input.provider, payload }));
  }

  return payload;
}

export async function exchangeCalendarCode(
  ...args: [provider: CalendarProvider, code: string]
): Promise<CalendarTokenSet> {
  const provider = args[0];
  const code = args[1];
  const config = requireCalendarConfig(provider);
  const payload = await exchangeCalendarToken({
    provider,
    body: new URLSearchParams({
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
    }),
  });

  // Google may omit a refresh token for an existing grant. The callback
  // restores it only after verifying the provider account identity.
  return parseTokenResponse({
    provider,
    payload,
    requireRefreshToken: provider !== "google_calendar",
  });
}

export async function refreshCalendarToken(tokens: CalendarTokenSet): Promise<CalendarTokenSet> {
  const config = requireCalendarConfig(tokens.provider);
  const payload = await exchangeCalendarToken({
    provider: tokens.provider,
    body: new URLSearchParams({
      refresh_token: tokens.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  });

  return parseTokenResponse({
    provider: tokens.provider,
    payload,
    fallbackRefreshToken: tokens.refreshToken,
    fallbackScope: tokens.scope,
  });
}

export function shouldRefreshCalendarToken(tokens: CalendarTokenSet): boolean {
  const expiresAt = Date.parse(tokens.expiresAt);

  return Number.isNaN(expiresAt) || expiresAt - Date.now() < CALENDAR_TOKEN_REFRESH_LEAD_MS;
}

function tokenScopeSet(tokens: Pick<CalendarTokenSet, "scope">) {
  return new Set(
    tokens.scope
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

export function hasGoogleCalendarPhotoScopes(tokens: Pick<CalendarTokenSet, "provider" | "scope">): boolean {
  if (tokens.provider !== "google_calendar") {
    return false;
  }
  const scopes = tokenScopeSet(tokens);

  return GOOGLE_CALENDAR_PHOTO_SCOPES.every((scope) => scopes.has(scope));
}

export function hasGoogleCalendarEventsScope(tokens: Pick<CalendarTokenSet, "provider" | "scope">): boolean {
  if (tokens.provider !== "google_calendar") {
    return false;
  }

  return tokenScopeSet(tokens).has(GOOGLE_CALENDAR_EVENTS_SCOPE);
}

export function hasOutlookPeopleScope(tokens: Pick<CalendarTokenSet, "provider" | "scope">): boolean {
  return tokens.provider === "outlook_calendar" && tokenScopeSet(tokens).has(OUTLOOK_PEOPLE_SCOPE);
}

function providerErrorCode(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const error = payload.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error)) {
    const code = error.code;

    return typeof code === "string" ? code : null;
  }

  return null;
}

function isOutlookMailboxUnavailable(input: { tokens: CalendarTokenSet; status: number; payload: unknown }): boolean {
  return (
    input.tokens.provider === "outlook_calendar" &&
    input.status === HTTP_STATUS_NOT_FOUND &&
    providerErrorCode(input.payload) === MICROSOFT_MAILBOX_NOT_ENABLED_FOR_REST_API
  );
}

async function calendarFetch(input: {
  tokens: CalendarTokenSet;
  url: URL;
  init?: CalendarFetchInit;
}): Promise<unknown> {
  const { treatForbiddenAsAuthError: shouldTreatForbiddenAsAuthError = true, ...requestInit } = input.init ?? {};
  const headers = new Headers({
    authorization: `Bearer ${input.tokens.accessToken}`,
    accept: "application/json",
  });
  new Headers(requestInit.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  const response = await fetch(input.url, { ...requestInit, headers });
  const text = await response.text();
  const trimmedText = text.trim();
  const payload: unknown = trimmedText.length > 0 ? parseJsonRecordFromText(trimmedText) : null;
  if (!response.ok) {
    const isMailboxUnavailable = isOutlookMailboxUnavailable({
      tokens: input.tokens,
      status: response.status,
      payload,
    });
    if (
      response.status === HTTP_STATUS_UNAUTHORIZED ||
      (response.status === HTTP_STATUS_FORBIDDEN && shouldTreatForbiddenAsAuthError) ||
      isMailboxUnavailable
    ) {
      const message = isMailboxUnavailable
        ? MESSAGE_OUTLOOK_MAILBOX_UNAVAILABLE
        : calendarCredentialsUnauthorizedMessage(input.tokens.provider);
      throw new CalendarProviderAuthError(input.tokens.provider, message, { status: response.status, payload });
    }
    throw new CalendarProviderRequestError(input.tokens.provider, response.status, payload);
  }

  return payload;
}

function optionalRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readGooglePerson(value: unknown): GooglePerson {
  if (!isRecord(value)) {
    return {};
  }

  return {
    emailAddresses: Array.isArray(value.emailAddresses)
      ? value.emailAddresses.filter(isRecord).map((item) => ({
          value: item.value,
          metadata: isRecord(item.metadata) ? { primary: item.metadata.primary } : undefined,
        }))
      : undefined,
    names: Array.isArray(value.names)
      ? value.names.filter(isRecord).map((item) => ({
          displayName: item.displayName,
          givenName: item.givenName,
          familyName: item.familyName,
        }))
      : undefined,
    photos: Array.isArray(value.photos)
      ? value.photos.filter(isRecord).map((item) => ({
          url: item.url,
          default: item.default,
        }))
      : undefined,
  };
}

function normalizeInviteEmail(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}

function googlePersonDisplayName(input: { person: GooglePerson; email: string }) {
  return (
    (input.person.names ?? [])
      .map((name) => {
        if (typeof name.displayName === "string" && Boolean(name.displayName.trim())) {
          return name.displayName.trim();
        }

        return [name.givenName, name.familyName]
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .map((value) => value.trim())
          .join(" ");
      })
      .find(Boolean) ??
    input.email.split("@")[0] ??
    input.email
  );
}

function googlePersonInviteContact(person: GooglePerson): CalendarInviteContact | null {
  const emailCandidates = [
    ...(person.emailAddresses ?? []).filter((item) => item.metadata?.primary === true),
    ...(person.emailAddresses ?? []),
  ];
  const email =
    emailCandidates.map((item) => normalizeInviteEmail(item.value)).find((candidate) => candidate !== null) ?? null;
  if (email === null) {
    return null;
  }

  return {
    email,
    displayName: googlePersonDisplayName({ person, email }),
    avatarUrl: firstUrl([
      ...(person.photos ?? []).filter((photo) => photo.default !== true).map((photo) => photo.url),
      ...(person.photos ?? []).map((photo) => photo.url),
    ]),
    provider: "google_calendar",
  };
}

function microsoftPersonInviteContact(
  person: NonNullable<MicrosoftPeopleResponse["value"]>[number],
): CalendarInviteContact | null {
  const email =
    [
      ...(person.scoredEmailAddresses ?? []).map((item) => item.address),
      ...(person.emailAddresses ?? []).map((item) => item.address),
    ]
      .map(normalizeInviteEmail)
      .find((candidate) => candidate !== null) ?? null;
  if (email === null) {
    return null;
  }
  const displayName =
    typeof person.displayName === "string" && person.displayName.trim().length > 0
      ? person.displayName.trim()
      : (email.split("@")[0] ?? email);

  return {
    email,
    displayName,
    avatarUrl: null,
    provider: "outlook_calendar",
  };
}

function uniqueInviteContacts(input: { contacts: (CalendarInviteContact | null)[]; limit: number }) {
  return input.contacts.reduce<{ seen: Set<string>; unique: CalendarInviteContact[]; isClosed: boolean }>(
    (state, contact) => {
      if (state.isClosed || contact === null || state.seen.has(contact.email)) {
        return state;
      }
      const unique = [...state.unique, contact];

      return {
        seen: new Set([...state.seen, contact.email]),
        unique,
        isClosed: unique.length >= input.limit,
      };
    },
    { seen: new Set<string>(), unique: [], isClosed: false },
  ).unique;
}

async function listCalendarInviteContactsNamed(input: {
  tokens: CalendarTokenSet;
  query?: string;
  limit?: number;
  requestingUserId?: string;
}): Promise<CalendarInviteContact[]> {
  const query = input.query?.trim() ?? "";
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_CALENDAR_LIST_LIMIT, MAX_CALENDAR_LIST_LIMIT));

  if (input.tokens.provider === "google_calendar") {
    if (!hasGoogleCalendarPhotoScopes(input.tokens)) {
      return [];
    }
    if (query.length > 0) {
      await warmGoogleContactSearch({ tokens: input.tokens, requestingUserId: input.requestingUserId });
      const url = new URL(GOOGLE_PEOPLE_SEARCH_CONTACTS_URL);
      url.searchParams.set("query", query);
      url.searchParams.set("pageSize", String(Math.min(limit, MAX_CALENDAR_INVITE_CONTACT_PAGE_SIZE)));
      url.searchParams.set("readMask", GOOGLE_PERSON_PHOTO_READ_MASK);
      const payload = await calendarFetch({ tokens: input.tokens, url });
      const record = isRecord(payload) ? payload : {};

      return uniqueInviteContacts({
        contacts: optionalRecordArray(record.results).map((result) =>
          googlePersonInviteContact(readGooglePerson(result.person)),
        ),
        limit,
      });
    }

    const url = new URL(GOOGLE_PEOPLE_CONNECTIONS_URL);
    url.searchParams.set("pageSize", String(Math.min(limit, MAX_GOOGLE_CONNECTIONS_PAGE_SIZE)));
    url.searchParams.set("personFields", GOOGLE_PERSON_PHOTO_READ_MASK);
    url.searchParams.set("sortOrder", "FIRST_NAME_ASCENDING");
    url.searchParams.append("sources", "READ_SOURCE_TYPE_CONTACT");
    const payload = await calendarFetch({ tokens: input.tokens, url });
    const record = isRecord(payload) ? payload : {};

    return uniqueInviteContacts({
      contacts: optionalRecordArray(record.connections).map((person) =>
        googlePersonInviteContact(readGooglePerson(person)),
      ),
      limit,
    });
  }

  if (!hasOutlookPeopleScope(input.tokens)) {
    return [];
  }
  const url = new URL(MICROSOFT_PEOPLE_URL);
  url.searchParams.set("$select", "displayName,emailAddresses,scoredEmailAddresses");
  url.searchParams.set("$top", String(limit));
  if (query.length > 0) {
    url.searchParams.set("$search", `"${query.replaceAll('"', "")}"`);
  }
  const payload = await calendarFetch({ tokens: input.tokens, url });
  const record = isRecord(payload) ? payload : {};
  const people = Array.isArray(record.value) ? record.value : [];

  return uniqueInviteContacts({
    contacts: people
      .filter((person): person is NonNullable<MicrosoftPeopleResponse["value"]>[number] => isRecord(person))
      .map(microsoftPersonInviteContact),
    limit,
  });
}

export async function listCalendarInviteContacts(
  ...args: [tokens: CalendarTokenSet, input?: { query?: string; limit?: number; requestingUserId?: string }]
): Promise<CalendarInviteContact[]> {
  const tokens = args[0];
  const input = args[1] ?? {};

  return listCalendarInviteContactsNamed({ tokens, ...input });
}

function normalizeDateTime(input: { date?: unknown; dateTime?: unknown; timeZone?: unknown }) {
  const isAllDay = typeof input.date === "string" && input.dateTime === undefined;
  const raw = typeof input.dateTime === "string" ? input.dateTime : typeof input.date === "string" ? input.date : "";
  if (raw.length === 0) {
    return { value: new Date(0).toISOString(), timezone: null, isAllDay };
  }
  if (isAllDay) {
    const timezone = typeof input.timeZone === "string" ? input.timeZone : UTC_TIMEZONE_LABEL;

    return { value: `${raw}${ALL_DAY_EVENT_NOON_TIME_SUFFIX}`, timezone, isAllDay };
  }
  const date = new Date(raw);

  return {
    value: Number.isNaN(date.getTime()) ? raw : date.toISOString(),
    timezone: typeof input.timeZone === "string" ? input.timeZone : null,
    isAllDay,
  };
}

function firstUrl(values: unknown[]) {
  return values.reduce<string | null>((found, value) => {
    if (found !== null || typeof value !== "string" || value.trim().length === 0) {
      return found;
    }
    try {
      return new URL(value).toString();
    } catch (error) {
      if (error instanceof Error || error !== undefined) {
        return null;
      }
      throw error;
    }
  }, null);
}

function stableCalendarEventId(input: { provider: CalendarProvider; calendarId: string; providerEventId: string }) {
  return `${input.provider}:${input.calendarId}:${input.providerEventId}`;
}

export function providerEventKeyFromIds(input: {
  providerEventId: string;
  providerRecurringEventId?: string | null;
}): string {
  const recurringId = input.providerRecurringEventId?.trim();

  return recurringId !== undefined && recurringId.length > 0 ? recurringId : input.providerEventId;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLocalReadyWebHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function canonicalReadyWebUrl(...args: [webUrl?: string]): URL {
  const webUrl = args[0] ?? apiEnv().NEXT_PUBLIC_WEB_URL;
  const url = new URL(webUrl);
  if (url.protocol === "http:" && !isLocalReadyWebHost(url.hostname)) {
    url.protocol = "https:";
  }

  return url;
}

export function buildReadyMeetingJoinUrl(...args: [code: string, webUrl?: string]): string {
  const code = args[0];
  const webUrl = args[1] ?? apiEnv().NEXT_PUBLIC_WEB_URL;

  return new URL(`/${code}`, canonicalReadyWebUrl(webUrl)).toString();
}

function readyMeetDescriptionBlockPattern() {
  return new RegExp(
    `${escapeRegExp(READY_MEET_DESCRIPTION_BLOCK_START)}[\\s\\S]*?${escapeRegExp(READY_MEET_DESCRIPTION_BLOCK_END)}`,
    "g",
  );
}

function patchReadyMeetCalendarDescriptionNamed(input: {
  existingDescription: string | null | undefined;
  joinUrl: string;
  callIn?: { phoneNumber: string; pin: string } | null;
}): string {
  const existing = input.existingDescription ?? "";
  const descriptionInput = { joinUrl: input.joinUrl, callIn: input.callIn };
  // Plain text also remains readable in clients that expose Calendar HTML literally.
  const nextBlock = `Ready meeting\n${buildReadyMeetCalendarDescriptionText(descriptionInput)}`;
  const meetingCode = extractReadyMeetingCodeFromUrl(input.joinUrl, input.joinUrl);
  const isSameMeeting = (url: string) =>
    meetingCode !== null && extractReadyMeetingCodeFromUrl(url, input.joinUrl) === meetingCode;
  const migrated = existing.replace(readyMeetDescriptionBlockPattern(), (block) => {
    const url = extractReadyMeetingUrlFromText(block, input.joinUrl);

    return url !== null && isSameMeeting(url) ? nextBlock : block;
  });
  const updated = replaceReadyDescriptionBlocks(migrated, nextBlock, isSameMeeting);
  if (updated !== null) {
    return updated;
  }
  if (migrated !== existing) {
    return migrated;
  }

  const separator = existing.trim().length > 0 ? "\n\n" : "";

  return `${existing.trimEnd()}${separator}${nextBlock}`;
}

export function patchReadyMeetCalendarDescription(
  ...args: [
    existingDescription: string | null | undefined,
    input: {
      joinUrl: string;
      callIn?: { phoneNumber: string; pin: string } | null;
    },
  ]
): string {
  return patchReadyMeetCalendarDescriptionNamed({
    existingDescription: args[0],
    joinUrl: args[1].joinUrl,
    callIn: args[1].callIn,
  });
}

function webOriginsFromUrl(webUrl: string) {
  try {
    return new Set([
      "https://ready.app",
      "https://www.ready.app",
      new URL(webUrl).origin,
      canonicalReadyWebUrl(webUrl).origin,
    ]);
  } catch (error) {
    if (error instanceof Error || error !== undefined) {
      return new Set<string>();
    }
    throw error;
  }
}

export function extractReadyMeetingCodeFromUrl(...args: [value: string, webUrl?: string]): string | null {
  const value = args[0];
  const webUrl = args[1] ?? apiEnv().NEXT_PUBLIC_WEB_URL;
  const webOrigins = webOriginsFromUrl(webUrl);
  if (webOrigins.size === 0) {
    return null;
  }

  try {
    const url = new URL(value);
    if (!webOrigins.has(url.origin)) {
      return null;
    }
    // Recognize meeting links, not other Ready pages mentioned in an event.
    const match = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i.exec(url.pathname);

    return match?.[1]?.toLowerCase() ?? null;
  } catch (error) {
    if (error instanceof Error || error !== undefined) {
      return null;
    }
    throw error;
  }
}

export function extractReadyMeetingUrlFromText(
  ...args: [value: string | null | undefined, webUrl?: string]
): string | null {
  const value = args[0];
  const webUrl = args[1] ?? apiEnv().NEXT_PUBLIC_WEB_URL;
  const trimmedValue = typeof value === "string" ? value.trim() : "";
  if (trimmedValue.length === 0) {
    return null;
  }

  const urlMatches = trimmedValue.match(/https?:\/\/[^\s<>"']+/g) ?? [];

  return urlMatches.reduce<string | null>((found, match) => {
    if (found !== null) {
      return found;
    }
    const trimmed = match.replace(/[),.;\]]+$/g, "");
    if (extractReadyMeetingCodeFromUrl(trimmed, webUrl) !== null) {
      return new URL(trimmed).toString();
    }

    return null;
  }, null);
}

function decodeCalendarDescriptionText(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractReadyMeetingCallInFromText(value: string | null | undefined) {
  const trimmedValue = typeof value === "string" ? value.trim() : "";
  if (trimmedValue.length === 0) {
    return null;
  }

  const text = decodeCalendarDescriptionText(trimmedValue);
  const phoneNumber = (text.match(/(?:^|\n)\s*Dial-in:\s*(?:\(US\)\s*)?(\+?[\d ()-]+)/i)?.[1] ?? "").replace(
    /[\s()-]/g,
    "",
  );
  const pin = text.match(/(?:^|\s)PIN:\s*([^\n\r#\s]+)#?/i)?.[1]?.trim() ?? "";

  return phoneNumber.length > 0 && pin.length > 0
    ? {
        phoneNumber,
        pin,
      }
    : null;
}

type GoogleConferenceEntryPoint = {
  entryPointType?: unknown;
  uri?: unknown;
  pin?: unknown;
};

type GoogleConferenceData = {
  entryPoints?: GoogleConferenceEntryPoint[];
};

function normalizedConferencePin(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/#+$/, "") : "";
}

function readGoogleConferenceData(value: unknown): GoogleConferenceData | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entryPoints = Array.isArray(value.entryPoints)
    ? value.entryPoints.filter(isRecord).map((entry) => ({
        entryPointType: entry.entryPointType,
        uri: entry.uri,
        pin: entry.pin,
      }))
    : undefined;

  return { entryPoints };
}

function readyMeetingCallInFromGoogleConferenceData(conferenceData: GoogleConferenceData | undefined) {
  const phoneEntry = conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "phone" && typeof entry.uri === "string" && /^tel:/i.test(entry.uri),
  );
  if (phoneEntry === undefined || typeof phoneEntry.uri !== "string") {
    return null;
  }

  const decodedUri = decodeURIComponent(phoneEntry.uri);
  const phoneNumber = decodedUri.slice(TEL_URI_PREFIX_LENGTH).split(/[;,?]/, 1)[0]?.trim() ?? "";
  const uriPin = decodedUri.match(/,{2,}([^,;?]+)/)?.[1];
  const normalizedUriPin = normalizedConferencePin(uriPin);
  const normalizedEntryPin = normalizedConferencePin(phoneEntry.pin);
  const pin = normalizedEntryPin.length > 0 ? normalizedEntryPin : normalizedUriPin;

  return phoneNumber.length > 0 && pin.length > 0
    ? {
        phoneNumber,
        pin,
      }
    : null;
}

function readyMeetingFromGoogleCalendarEvent(event: Record<string, unknown>): CalendarReadyMeeting | null {
  const conferenceData = readGoogleConferenceData(event.conferenceData);
  const conferenceUrl =
    conferenceData?.entryPoints
      ?.map((entry) => (typeof entry.uri === "string" ? extractReadyMeetingUrlFromText(entry.uri) : null))
      .find((url): url is string => url !== null) ?? null;
  const descriptionUrl =
    typeof event.description === "string" ? extractReadyMeetingUrlFromText(event.description) : null;
  const locationUrl = typeof event.location === "string" ? extractReadyMeetingUrlFromText(event.location) : null;
  const callIn =
    readyMeetingCallInFromGoogleConferenceData(conferenceData) ??
    (typeof event.description === "string" ? extractReadyMeetingCallInFromText(event.description) : null);
  // Conferencing add-ons write their join URL to structured conference data,
  // while Ready's direct Calendar integration also mirrors it into the event
  // description or location. Prefer the provider's structured value.
  const joinUrl = conferenceUrl ?? descriptionUrl ?? locationUrl;

  return joinUrl !== null
    ? {
        source: "provider_event",
        joinUrl,
        callIn,
      }
    : null;
}

function canModifyGoogleCalendarEvent(input: {
  event: Record<string, unknown>;
  isPrivate: boolean;
  isCancelled: boolean;
}) {
  if (input.isPrivate || input.isCancelled || input.event.locked === true) {
    return false;
  }
  const organizer = isRecord(input.event.organizer) ? input.event.organizer : undefined;
  const creator = isRecord(input.event.creator) ? input.event.creator : undefined;

  return organizer?.self === true || creator?.self === true || input.event.guestsCanModify === true;
}

function normalizePersonEmail(email?: string | null) {
  const trimmed = email?.trim().toLowerCase();

  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

function calendarPersonProfileCacheKey(input: {
  provider: CalendarProvider;
  requestingUserId?: string;
  email: string;
}) {
  return `${input.provider}:${input.requestingUserId ?? "unknown"}:${input.email}`;
}

function getCachedGooglePersonProfile(input: { requestingUserId?: string; email: string }) {
  const cacheKey = calendarPersonProfileCacheKey({
    provider: "google_calendar",
    requestingUserId: input.requestingUserId,
    email: input.email,
  });
  const cached = googlePersonProfileCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    googlePersonProfileCache.delete(cacheKey);

    return undefined;
  }

  return {
    avatarUrl: cached.avatarUrl,
    displayName: cached.displayName,
  };
}

function cacheGooglePersonProfile(input: {
  requestingUserId?: string;
  email: string;
  avatarUrl: string | null;
  displayName: string | null;
}) {
  googlePersonProfileCache.set(
    calendarPersonProfileCacheKey({
      provider: "google_calendar",
      requestingUserId: input.requestingUserId,
      email: input.email,
    }),
    {
      avatarUrl: input.avatarUrl,
      displayName: input.displayName,
      expiresAt: Date.now() + GOOGLE_PERSON_PHOTO_CACHE_TTL_MS,
    },
  );
}

function getGooglePersonProfile(input: { person: GooglePerson | undefined; email: string }) {
  const person = input.person;
  const email = input.email;
  const hasMatchingEmail = (person?.emailAddresses ?? []).some(
    (item) => typeof item.value === "string" && item.value.trim().toLowerCase() === email,
  );
  if (!hasMatchingEmail) {
    return null;
  }

  const photos = person?.photos ?? [];
  const avatarUrl = firstUrl([
    ...photos.filter((photo) => photo.default !== true).map((photo) => photo.url),
    ...photos.map((photo) => photo.url),
  ]);
  const displayName =
    (person?.names ?? [])
      .map((name) => {
        if (typeof name.displayName === "string" && Boolean(name.displayName.trim())) {
          return name.displayName.trim();
        }

        return [name.givenName, name.familyName]
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .map((value) => value.trim())
          .join(" ");
      })
      .find(Boolean) ?? null;

  return {
    avatarUrl,
    displayName,
  };
}

function hasGoogleProfileMatch(profile: ReturnType<typeof getGooglePersonProfile>): boolean {
  if (profile === null) {
    return false;
  }

  return readNonEmptyString(profile.avatarUrl) !== null || readNonEmptyString(profile.displayName) !== null;
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

async function warmGoogleContactSearch(input: {
  tokens: CalendarTokenSet;
  requestingUserId?: string;
  signal?: AbortSignal;
}) {
  const warmupKey = `${input.requestingUserId ?? "unknown"}:${input.tokens.provider}`;
  const warmupExpiresAt = googleContactSearchWarmups.get(warmupKey) ?? 0;
  if (warmupExpiresAt > Date.now()) {
    return;
  }

  const url = new URL(GOOGLE_PEOPLE_SEARCH_CONTACTS_URL);
  url.searchParams.set("query", "");
  url.searchParams.set("pageSize", String(GOOGLE_CONTACT_WARMUP_PAGE_SIZE));
  url.searchParams.set("readMask", GOOGLE_PERSON_PHOTO_READ_MASK);

  try {
    await calendarFetch({ tokens: input.tokens, url, init: { signal: input.signal } });
    googleContactSearchWarmups.set(warmupKey, Date.now() + GOOGLE_CONTACT_SEARCH_WARMUP_TTL_MS);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    googleContactSearchWarmups.set(warmupKey, Date.now() + GOOGLE_CONTACT_SEARCH_WARMUP_TTL_MS);
  }
}

async function searchGoogleContactProfile(input: {
  tokens: CalendarTokenSet;
  email: string;
  requestingUserId?: string;
  signal?: AbortSignal;
}) {
  await warmGoogleContactSearch({
    tokens: input.tokens,
    requestingUserId: input.requestingUserId,
    signal: input.signal,
  });
  const url = new URL(GOOGLE_PEOPLE_SEARCH_CONTACTS_URL);
  url.searchParams.set("query", input.email);
  url.searchParams.set("pageSize", String(GOOGLE_CONTACT_SEARCH_PAGE_SIZE));
  url.searchParams.set("readMask", GOOGLE_PERSON_PHOTO_READ_MASK);
  const payload = await calendarFetch({ tokens: input.tokens, url, init: { signal: input.signal } });
  const record = isRecord(payload) ? payload : {};

  return optionalRecordArray(record.results).reduce<ReturnType<typeof getGooglePersonProfile>>((found, result) => {
    if (hasGoogleProfileMatch(found)) {
      return found;
    }
    const profile = getGooglePersonProfile({ person: readGooglePerson(result.person), email: input.email });
    if (hasGoogleProfileMatch(profile)) {
      return profile;
    }

    return found;
  }, null);
}

async function searchGoogleDirectoryProfile(input: { tokens: CalendarTokenSet; email: string; signal?: AbortSignal }) {
  const url = new URL(GOOGLE_PEOPLE_SEARCH_DIRECTORY_URL);
  url.searchParams.set("query", input.email);
  url.searchParams.set("readMask", GOOGLE_PERSON_PHOTO_READ_MASK);
  url.searchParams.set("pageSize", String(GOOGLE_CONTACT_SEARCH_PAGE_SIZE));
  url.searchParams.append("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE");
  url.searchParams.append("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT");
  const payload = await calendarFetch({ tokens: input.tokens, url, init: { signal: input.signal } });
  const record = isRecord(payload) ? payload : {};

  return optionalRecordArray(record.people).reduce<ReturnType<typeof getGooglePersonProfile>>((found, person) => {
    if (hasGoogleProfileMatch(found)) {
      return found;
    }
    const profile = getGooglePersonProfile({ person: readGooglePerson(person), email: input.email });
    if (hasGoogleProfileMatch(profile)) {
      return profile;
    }

    return found;
  }, null);
}

async function lookupGooglePersonProfile(input: {
  tokens: CalendarTokenSet;
  email: string;
  requestingUserId?: string;
  signal?: AbortSignal;
}) {
  try {
    const contactProfile = await searchGoogleContactProfile(input);
    if (hasGoogleProfileMatch(contactProfile)) {
      return contactProfile;
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    // Contact profiles are best-effort; directory lookup and initials remain available.
  }

  try {
    return await searchGoogleDirectoryProfile({
      tokens: input.tokens,
      email: input.email,
      signal: input.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    return null;
  }
}

async function lookupGooglePersonProfileWithTimeout(input: {
  tokens: CalendarTokenSet;
  email: string;
  requestingUserId?: string;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs);
  try {
    return await lookupGooglePersonProfile({
      tokens: input.tokens,
      email: input.email,
      requestingUserId: input.requestingUserId,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      return undefined;
    }

    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getCalendarPeople(events: NormalizedCalendarEvent[]) {
  return events.flatMap((event) => [...(event.organizer ? [event.organizer] : []), ...event.attendees]);
}

function withCalendarPersonPhoto(input: {
  person: CalendarEventPerson | null | undefined;
  profilesByEmail: Map<string, { avatarUrl: string | null; displayName: string | null }>;
}): CalendarEventPerson | null {
  if (input.person === null || input.person === undefined) {
    return null;
  }
  const email = normalizePersonEmail(input.person.email);
  const profile = email !== null ? input.profilesByEmail.get(email) : null;

  return {
    ...input.person,
    name: profile?.displayName ?? input.person.name,
    avatarUrl:
      profile !== null && profile !== undefined
        ? (profile.avatarUrl ?? input.person.avatarUrl ?? null)
        : (input.person.avatarUrl ?? null),
  };
}

async function resolveGoogleCalendarPersonPhotosNamed(input: {
  tokens: CalendarTokenSet;
  events: NormalizedCalendarEvent[];
  requestingUserId?: string;
  photoLookupTimeoutMs?: number;
  totalPhotoLookupTimeoutMs?: number;
}): Promise<NormalizedCalendarEvent[]> {
  if (!hasGoogleCalendarPhotoScopes(input.tokens) || input.events.length === 0) {
    return input.events;
  }

  const emails = Array.from(
    new Set(
      getCalendarPeople(input.events)
        .map((person) => normalizePersonEmail(person.email))
        .filter((email): email is string => email !== null),
    ),
  );
  if (emails.length === 0) {
    return input.events;
  }

  const profilesByEmail = new Map<string, { avatarUrl: string | null; displayName: string | null }>();
  const missingEmails = emails.reduce<string[]>((missing, email) => {
    const cached = getCachedGooglePersonProfile({
      requestingUserId: input.requestingUserId,
      email,
    });
    if (cached !== undefined) {
      profilesByEmail.set(email, cached);

      return missing;
    }

    return [...missing, email];
  }, []);

  const totalDeadlineAt = Date.now() + (input.totalPhotoLookupTimeoutMs ?? GOOGLE_PERSON_PHOTO_TOTAL_TIMEOUT_MS);
  await Array.from({ length: Math.ceil(missingEmails.length / GOOGLE_PHOTO_LOOKUP_BATCH_SIZE) }, (_, batchIndex) =>
    missingEmails.slice(
      batchIndex * GOOGLE_PHOTO_LOOKUP_BATCH_SIZE,
      batchIndex * GOOGLE_PHOTO_LOOKUP_BATCH_SIZE + GOOGLE_PHOTO_LOOKUP_BATCH_SIZE,
    ),
  ).reduce<Promise<boolean>>(async (previous, batch) => {
    if (!(await previous)) {
      return false;
    }
    const remainingMs = totalDeadlineAt - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    const timeoutMs = Math.max(
      MIN_BATCH_TIMEOUT_MS,
      Math.min(input.photoLookupTimeoutMs ?? GOOGLE_PERSON_PHOTO_LOOKUP_TIMEOUT_MS, remainingMs),
    );
    await Promise.all(
      batch.map(async (email) => {
        const profile = await lookupGooglePersonProfileWithTimeout({
          tokens: input.tokens,
          email,
          requestingUserId: input.requestingUserId,
          timeoutMs,
        });
        if (profile === undefined) {
          return;
        }
        cacheGooglePersonProfile({
          requestingUserId: input.requestingUserId,
          email,
          avatarUrl: profile?.avatarUrl ?? null,
          displayName: profile?.displayName ?? null,
        });
        profilesByEmail.set(email, {
          avatarUrl: profile?.avatarUrl ?? null,
          displayName: profile?.displayName ?? null,
        });
      }),
    );

    return true;
  }, Promise.resolve(true));

  return input.events.map((event) => ({
    ...event,
    organizer: withCalendarPersonPhoto({ person: event.organizer, profilesByEmail }),
    attendees: event.attendees.flatMap((attendee) => {
      const withPhoto = withCalendarPersonPhoto({ person: attendee, profilesByEmail });

      return withPhoto === null ? [] : [withPhoto];
    }),
  }));
}

export async function resolveGoogleCalendarPersonPhotos(
  ...args: [
    tokens: CalendarTokenSet,
    events: NormalizedCalendarEvent[],
    input?: {
      requestingUserId?: string;
      photoLookupTimeoutMs?: number;
      totalPhotoLookupTimeoutMs?: number;
    },
  ]
): Promise<NormalizedCalendarEvent[]> {
  const tokens = args[0];
  const events = args[1];
  const input = args[2] ?? {};

  return resolveGoogleCalendarPersonPhotosNamed({ tokens, events, ...input });
}

function readGoogleCalendarOrganizer(event: Record<string, unknown>) {
  const organizerInput = isRecord(event.organizer) ? event.organizer : undefined;
  if (organizerInput === undefined) {
    return null;
  }

  return {
    name: typeof organizerInput.displayName === "string" ? organizerInput.displayName : null,
    email: typeof organizerInput.email === "string" ? organizerInput.email : null,
    responseStatus: null,
    avatarUrl: null,
    readyMeetAvatarUrl: null,
  };
}

function readGoogleCalendarAttendees(event: Record<string, unknown>) {
  if (!Array.isArray(event.attendees)) {
    return [];
  }

  return event.attendees.filter(isRecord).map((item) => ({
    name: typeof item.displayName === "string" ? item.displayName : null,
    email: typeof item.email === "string" ? item.email : null,
    responseStatus: typeof item.responseStatus === "string" ? item.responseStatus : null,
    avatarUrl: null,
    readyMeetAvatarUrl: null,
  }));
}

function readGoogleCalendarEventTitle(input: { summary: unknown; isPrivate: boolean }): string {
  if (input.isPrivate) {
    return PRIVATE_EVENT_TITLE;
  }
  const summary = readNonEmptyString(input.summary);

  return summary ?? UNTITLED_EVENT_TITLE;
}

function readGoogleCalendarJoinUrls(event: Record<string, unknown>): unknown[] {
  const conferenceData = readGoogleConferenceData(event.conferenceData);
  const entryPointUris = conferenceData?.entryPoints?.map((entry) => entry.uri) ?? [];

  return [event.hangoutLink, ...entryPointUris];
}

export function normalizeGoogleCalendarEvent(event: Record<string, unknown>): NormalizedCalendarEvent {
  const provider = "google_calendar";
  const providerEventId = typeof event.id === "string" ? event.id : "";
  const calendarId = GOOGLE_CALENDAR_PRIMARY_ID;
  const recurringEventId = readNonEmptyString(event.recurringEventId);
  const providerRecurringEventId = recurringEventId;
  const providerEventKey = providerEventKeyFromIds({ providerEventId, providerRecurringEventId });
  const start = normalizeDateTime(isRecord(event.start) ? event.start : {});
  const end = normalizeDateTime(isRecord(event.end) ? event.end : {});
  const visibility = typeof event.visibility === "string" ? event.visibility : "";
  const isPrivate = visibility === "private";
  const isCancelled = event.status === "cancelled";
  const location = readNonEmptyString(event.location);

  return {
    id: stableCalendarEventId({ provider, calendarId, providerEventId }),
    provider,
    providerEventId,
    providerRecurringEventId,
    providerEventKey,
    calendarId,
    title: readGoogleCalendarEventTitle({ summary: event.summary, isPrivate }),
    start: start.value,
    end: end.value,
    timezone: start.timezone ?? end.timezone,
    location,
    organizer: readGoogleCalendarOrganizer(event),
    attendees: readGoogleCalendarAttendees(event),
    isPrivate,
    isCancelled,
    isAllDay: start.isAllDay,
    canAddReadyMeeting: canModifyGoogleCalendarEvent({ event, isPrivate, isCancelled }),
    /** @external normalized calendar event write consent flag */
    needsCalendarWriteConsent: false,
    joinUrl: firstUrl(readGoogleCalendarJoinUrls(event)),
    readyMeeting: readyMeetingFromGoogleCalendarEvent(event),
    sourceUrl: firstUrl([event.htmlLink]),
  };
}

function readOutlookDateTimeInput(value: unknown) {
  if (!isRecord(value)) {
    return { dateTime: undefined, timeZone: undefined };
  }

  return { dateTime: value.dateTime, timeZone: value.timeZone };
}

function readOutlookOrganizer(event: Record<string, unknown>) {
  const organizerInput = isRecord(event.organizer) ? event.organizer : undefined;
  const emailAddress =
    organizerInput !== undefined && isRecord(organizerInput.emailAddress) ? organizerInput.emailAddress : undefined;
  if (emailAddress === undefined) {
    return null;
  }

  return {
    name: typeof emailAddress.name === "string" ? emailAddress.name : null,
    email: typeof emailAddress.address === "string" ? emailAddress.address : null,
    responseStatus: null,
    avatarUrl: null,
    readyMeetAvatarUrl: null,
  };
}

function readOutlookAttendees(event: Record<string, unknown>) {
  if (!Array.isArray(event.attendees)) {
    return [];
  }

  return event.attendees.filter(isRecord).map((item) => {
    const emailAddress = isRecord(item.emailAddress) ? item.emailAddress : undefined;
    const status = isRecord(item.status) ? item.status : undefined;

    return {
      name: typeof emailAddress?.name === "string" ? emailAddress.name : null,
      email: typeof emailAddress?.address === "string" ? emailAddress.address : null,
      responseStatus: typeof status?.response === "string" ? status.response : null,
      avatarUrl: null,
      readyMeetAvatarUrl: null,
    };
  });
}

function readOutlookReadyJoinUrl(input: {
  onlineMeetingJoinUrl: unknown;
  onlineMeetingUrl: unknown;
  description: string | null;
  locationDisplayName: unknown;
}): string | null {
  const candidates = [input.onlineMeetingJoinUrl, input.onlineMeetingUrl, input.description, input.locationDisplayName];

  return (
    candidates
      .map((value) => (typeof value === "string" ? extractReadyMeetingUrlFromText(value) : null))
      .find((value) => value !== null) ?? null
  );
}

function readOutlookCalendarId(event: Record<string, unknown>): string {
  const calendarId = readNonEmptyString(event.calendarId);
  if (calendarId !== null) {
    return calendarId;
  }
  const parentFolderId = readNonEmptyString(event.parentFolderId);

  return parentFolderId ?? GOOGLE_CALENDAR_PRIMARY_ID;
}

function readOutlookEventTitle(input: { subject: unknown; isPrivate: boolean }): string {
  if (input.isPrivate) {
    return PRIVATE_EVENT_TITLE;
  }
  const subject = readNonEmptyString(input.subject);

  return subject ?? UNTITLED_EVENT_TITLE;
}

export function normalizeOutlookCalendarEvent(event: Record<string, unknown>): NormalizedCalendarEvent {
  const provider = "outlook_calendar";
  const providerEventId = typeof event.id === "string" ? event.id : "";
  const calendarId = readOutlookCalendarId(event);
  const start = normalizeDateTime(readOutlookDateTimeInput(event.start));
  const end = normalizeDateTime(readOutlookDateTimeInput(event.end));
  const isPrivate = event.sensitivity === "private";
  const locationRecord = isRecord(event.location) ? event.location : undefined;
  const onlineMeeting = isRecord(event.onlineMeeting) ? event.onlineMeeting : undefined;
  const bodyParsed = outlookEventBodySchema.safeParse(event.body);
  const description =
    bodyParsed.success && typeof bodyParsed.data.content === "string" ? bodyParsed.data.content : null;
  const readyJoinUrl = readOutlookReadyJoinUrl({
    onlineMeetingJoinUrl: onlineMeeting?.joinUrl,
    onlineMeetingUrl: event.onlineMeetingUrl,
    description,
    locationDisplayName: locationRecord?.displayName,
  });
  const locationDisplayName = readNonEmptyString(locationRecord?.displayName);

  return {
    id: stableCalendarEventId({ provider, calendarId, providerEventId }),
    provider,
    providerEventId,
    providerRecurringEventId: null,
    providerEventKey: providerEventId,
    calendarId,
    title: readOutlookEventTitle({ subject: event.subject, isPrivate }),
    start: start.value,
    end: end.value,
    timezone: start.timezone ?? end.timezone,
    location: locationDisplayName,
    organizer: readOutlookOrganizer(event),
    attendees: readOutlookAttendees(event),
    isPrivate,
    isCancelled: event.isCancelled === true,
    isAllDay: event.isAllDay === true,
    canAddReadyMeeting: false,
    /** @external normalized calendar event write consent flag */
    needsCalendarWriteConsent: false,
    joinUrl: firstUrl([onlineMeeting?.joinUrl, event.onlineMeetingUrl]),
    readyMeeting:
      readyJoinUrl !== null
        ? {
            source: "provider_event",
            joinUrl: readyJoinUrl,
            callIn: extractReadyMeetingCallInFromText(description),
          }
        : null,
    sourceUrl: firstUrl([event.webLink]),
  };
}

function readGoogleCalendarAccountProfile(input: {
  payload: Record<string, unknown>;
  fallbackEmail: string;
  shouldRequireVerifiedIdentity: boolean;
}): CalendarAccountProfile {
  const providerAccountId = readNonEmptyString(input.payload.id);
  const emailFromPayload = readNonEmptyString(input.payload.email);
  if (input.shouldRequireVerifiedIdentity && (providerAccountId === null || emailFromPayload === null)) {
    throw new Error(MESSAGE_GOOGLE_ACCOUNT_IDENTITY_MISSING);
  }
  const email = emailFromPayload !== null ? emailFromPayload.toLowerCase() : input.fallbackEmail.toLowerCase();

  return {
    providerAccountId: providerAccountId ?? email,
    email,
    displayName: typeof input.payload.name === "string" ? input.payload.name : null,
    tenantId: null,
  };
}

function readOutlookCalendarAccountProfile(input: {
  payload: Record<string, unknown>;
  fallbackEmail: string;
}): CalendarAccountProfile {
  const email =
    readNonEmptyString(input.payload.mail) ??
    readNonEmptyString(input.payload.userPrincipalName) ??
    input.fallbackEmail.trim().toLowerCase();
  const providerAccountId = readNonEmptyString(input.payload.id);

  return {
    providerAccountId: providerAccountId ?? email,
    email,
    displayName: typeof input.payload.displayName === "string" ? input.payload.displayName : null,
    tenantId: null,
  };
}

export async function getCalendarAccountProfile(
  ...args: [tokens: CalendarTokenSet, fallbackEmail: string, requireVerifiedIdentity?: boolean]
): Promise<CalendarAccountProfile> {
  const tokens = args[0];
  const fallbackEmail = args[1];
  const shouldRequireVerifiedIdentity = args[2] ?? false;
  try {
    if (tokens.provider === "google_calendar") {
      const payload = await calendarFetch({ tokens, url: new URL(GOOGLE_USERINFO_URL) });
      const record = isRecord(payload) ? payload : {};

      return readGoogleCalendarAccountProfile({
        payload: record,
        fallbackEmail,
        shouldRequireVerifiedIdentity,
      });
    }
    const payload = await calendarFetch({ tokens, url: new URL(MICROSOFT_ME_URL) });
    const record = isRecord(payload) ? payload : {};

    return readOutlookCalendarAccountProfile({ payload: record, fallbackEmail });
  } catch (error) {
    if (shouldRequireVerifiedIdentity) {
      throw error;
    }
    const email = fallbackEmail.toLowerCase();

    return {
      providerAccountId: email,
      email,
      displayName: null,
      tenantId: null,
    };
  }
}

export async function revokeGoogleCalendarToken(tokens: CalendarTokenSet): Promise<
  | {
      /** @external google calendar revoke attempted flag */
      attempted: false;
      /** @external google calendar revoke succeeded flag */
      ok: false;
      reason: string;
    }
  | {
      /** @external google calendar revoke attempted flag */
      attempted: true;
      /** @external google calendar revoke succeeded flag */
      ok: boolean;
      status: number;
      body: string | null;
    }
> {
  if (tokens.provider !== "google_calendar") {
    return {
      attempted: false,
      ok: false,
      reason: "not_google_calendar",
    };
  }
  const refreshToken = readNonEmptyString(tokens.refreshToken);
  const accessToken = readNonEmptyString(tokens.accessToken);
  const token = refreshToken ?? accessToken;
  if (token === null) {
    return {
      attempted: false,
      ok: false,
      reason: "missing_token",
    };
  }
  const response = await fetch(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });

  return {
    attempted: true,
    ok: response.ok,
    status: response.status,
    body: response.ok ? null : await response.text(),
  };
}

async function listGoogleCalendarEvents(
  ...args: [tokens: CalendarTokenSet, input: CalendarListInput]
): Promise<NormalizedCalendarEvent[]> {
  const tokens = args[0];
  const input = args[1];
  const url = new URL(GOOGLE_EVENTS_URL);
  url.searchParams.set("timeMin", input.timeMin);
  url.searchParams.set("timeMax", input.timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(input.limit ?? DEFAULT_CALENDAR_LIST_LIMIT));
  const payload = await calendarFetch({ tokens, url });
  const record = isRecord(payload) ? payload : {};
  const events = optionalRecordArray(record.items)
    .map(normalizeGoogleCalendarEvent)
    .filter((event) => input.includeCancelled === true || !event.isCancelled);

  return resolveGoogleCalendarPersonPhotos(tokens, events, {
    requestingUserId: input.requestingUserId,
  });
}

export async function watchGoogleCalendarEvents(
  ...args: [
    tokens: CalendarTokenSet,
    input: {
      calendarId?: string;
      channelId: string;
      address: string;
      token: string;
      expirationAt?: Date | null;
    },
  ]
): Promise<{
  channelId: string;
  resourceId: string | null;
  resourceUri: string | null;
  expirationAt: Date | null;
}> {
  const tokens = args[0];
  const input = args[1];
  if (tokens.provider !== "google_calendar") {
    throw new Error(MESSAGE_GOOGLE_CALENDAR_WATCH_REQUIRES_TOKENS);
  }

  const calendarId = readNonEmptyString(input.calendarId);
  const watchUrl = new URL(
    calendarId !== null && calendarId !== GOOGLE_CALENDAR_PRIMARY_ID
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`
      : GOOGLE_EVENTS_WATCH_URL,
  );
  const payload = await calendarFetch({
    tokens,
    url: watchUrl,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: input.channelId,
        type: "web_hook",
        address: input.address,
        token: input.token,
        ...(input.expirationAt !== null && input.expirationAt !== undefined
          ? { expiration: input.expirationAt.getTime() }
          : {}),
      }),
    },
  });
  const record = isRecord(payload) ? payload : {};
  const expirationTime =
    typeof record.expiration === "number"
      ? record.expiration
      : typeof record.expiration === "string"
        ? Number(record.expiration)
        : Number.NaN;
  const channelId = readNonEmptyString(record.id) ?? input.channelId;

  return {
    channelId,
    resourceId: typeof record.resourceId === "string" ? record.resourceId : null,
    resourceUri: typeof record.resourceUri === "string" ? record.resourceUri : null,
    expirationAt: Number.isFinite(expirationTime) ? new Date(expirationTime) : (input.expirationAt ?? null),
  };
}

export async function deleteGoogleCalendarEvent(
  ...args: [
    tokens: CalendarTokenSet,
    input: {
      calendarId: string;
      eventId: string;
      sendUpdates?: "all" | "externalOnly" | "none";
    },
  ]
): Promise<{
  /** @external google calendar delete ok flag */
  ok: true;
}> {
  const tokens = args[0];
  const input = args[1];
  if (tokens.provider !== "google_calendar") {
    throw new Error(MESSAGE_GOOGLE_CALENDAR_DELETE_REQUIRES_TOKENS);
  }

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
  );
  url.searchParams.set("sendUpdates", input.sendUpdates ?? "none");
  const deleteInit: CalendarFetchInit = {
    method: "DELETE",
    treatForbiddenAsAuthError: false,
  };
  await calendarFetch({
    tokens,
    url,
    init: deleteInit,
  });

  return {
    /** @external google calendar delete ok flag */
    ok: true,
  };
}

export async function getGoogleCalendarEvent(
  ...args: [
    tokens: CalendarTokenSet,
    input: {
      calendarId: string;
      eventId: string;
    },
  ]
): Promise<Record<string, unknown>> {
  const tokens = args[0];
  const input = args[1];
  if (tokens.provider !== "google_calendar") {
    throw new Error(MESSAGE_GOOGLE_CALENDAR_LOOKUP_REQUIRES_TOKENS);
  }

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
  );

  const getInit: CalendarFetchInit = {
    method: "GET",
    treatForbiddenAsAuthError: false,
  };
  const payload = await calendarFetch({
    tokens,
    url,
    init: getInit,
  });

  return isRecord(payload) ? payload : {};
}

export async function patchGoogleCalendarEventWithReadyMeeting(
  ...args: [
    tokens: CalendarTokenSet,
    input: {
      calendarId: string;
      eventId: string;
      event: Record<string, unknown>;
      joinUrl: string;
      callIn?: { phoneNumber: string; pin: string } | null;
      sendUpdates?: "all" | "externalOnly" | "none";
    },
  ]
): Promise<Record<string, unknown>> {
  const tokens = args[0];
  const input = args[1];
  if (tokens.provider !== "google_calendar") {
    throw new Error(MESSAGE_GOOGLE_CALENDAR_PATCH_REQUIRES_TOKENS);
  }

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
  );
  url.searchParams.set("sendUpdates", input.sendUpdates ?? "none");
  const existingDescription = typeof input.event.description === "string" ? input.event.description : "";
  const location = readNonEmptyString(input.event.location) ?? "";
  const body: Record<string, unknown> = {
    description: patchReadyMeetCalendarDescription(existingDescription, {
      joinUrl: input.joinUrl,
      callIn: input.callIn ?? null,
    }),
  };
  if (location.length === 0) {
    body.location = input.joinUrl;
  }

  const patchInit: CalendarFetchInit = {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    treatForbiddenAsAuthError: false,
  };
  const payload = await calendarFetch({
    tokens,
    url,
    init: patchInit,
  });

  return isRecord(payload) ? payload : {};
}

export async function watchOutlookCalendarEvents(
  ...args: [
    tokens: CalendarTokenSet,
    input: {
      notificationUrl: string;
      clientState: string;
      expirationAt: Date;
    },
  ]
): Promise<{
  subscriptionId: string;
  resource: string;
  expirationAt: Date;
}> {
  const tokens = args[0];
  const input = args[1];
  if (tokens.provider !== "outlook_calendar") {
    throw new Error(MESSAGE_OUTLOOK_SUBSCRIPTION_REQUIRES_TOKENS);
  }

  const payload = await calendarFetch({
    tokens,
    url: new URL(MICROSOFT_SUBSCRIPTIONS_URL),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        changeType: "created,updated,deleted",
        notificationUrl: input.notificationUrl,
        resource: "me/events",
        expirationDateTime: input.expirationAt.toISOString(),
        clientState: input.clientState,
      }),
    },
  });
  const record = isRecord(payload) ? payload : {};
  const expirationTime =
    typeof record.expirationDateTime === "string" ? Date.parse(record.expirationDateTime) : Number.NaN;
  const subscriptionId = readString({ value: record.id });

  return {
    subscriptionId,
    resource: typeof record.resource === "string" ? record.resource : "me/events",
    expirationAt: Number.isFinite(expirationTime) ? new Date(expirationTime) : input.expirationAt,
  };
}

export async function listOutlookCalendarEvents(
  ...args: [tokens: CalendarTokenSet, input: CalendarListInput]
): Promise<NormalizedCalendarEvent[]> {
  const tokens = args[0];
  const input = args[1];
  const url = new URL(MICROSOFT_CALENDAR_VIEW_URL);
  url.searchParams.set("startDateTime", input.timeMin);
  url.searchParams.set("endDateTime", input.timeMax);
  url.searchParams.set("$orderby", "start/dateTime");
  const limit = input.limit ?? DEFAULT_CALENDAR_LIST_LIMIT;
  url.searchParams.set("$top", String(limit));
  const collectOutlookEvents = async (page: {
    nextUrl: URL | null;
    items: Record<string, unknown>[];
  }): Promise<Record<string, unknown>[]> => {
    if (page.nextUrl === null || page.items.length >= limit) {
      return page.items;
    }
    const payload = await calendarFetch({
      tokens,
      url: page.nextUrl,
      init: {
        headers: {
          Prefer: 'outlook.timezone="UTC"',
        },
      },
    });
    const record = isRecord(payload) ? payload : {};
    const pageItems = optionalRecordArray(record.value);
    const nextItems = [...page.items, ...pageItems.slice(0, Math.max(0, limit - page.items.length))];
    const nextLink = readNonEmptyString(record["@odata.nextLink"]);
    const following = nextLink !== null && nextItems.length < limit ? new URL(nextLink) : null;

    return collectOutlookEvents({ nextUrl: following, items: nextItems });
  };
  const items = await collectOutlookEvents({ nextUrl: url, items: [] });

  return items
    .map(normalizeOutlookCalendarEvent)
    .filter((event) => input.includeCancelled === true || !event.isCancelled);
}

export async function listCalendarEvents(
  ...args: [tokens: CalendarTokenSet, input: CalendarListInput]
): Promise<NormalizedCalendarEvent[]> {
  const tokens = args[0];
  const input = args[1];

  return tokens.provider === "google_calendar"
    ? listGoogleCalendarEvents(tokens, input)
    : listOutlookCalendarEvents(tokens, input);
}
