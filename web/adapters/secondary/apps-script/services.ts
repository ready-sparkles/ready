import { AUTH_CACHE_KEY, AUTH_CACHE_TTL_SECONDS } from "../../../domain/google-calendar/conference";
import type { GoogleCalendarAuth } from "../../../domain/google-calendar/contracts";
import { authSchema, identityPayloadSchema, meetingResponseSchema } from "../../../domain/google-calendar/contracts";
import type {
  GoogleCalendarFetchOptions,
  GoogleCalendarHttpResult,
  GoogleCalendarPort,
} from "../../../ports/google-calendar";

type ScriptProperties = {
  getProperty: (key: string) => string | null;
};

type HttpResponse = {
  getResponseCode: () => number;
  getContentText: () => string;
};

type FetchRequest = {
  method?: string;
  contentType?: string;
  payload?: string;
  headers?: Record<string, string>;
  /** @external Apps Script UrlFetchApp option */
  muteHttpExceptions?: boolean;
};

export type AppsScriptHosts = {
  script: {
    getIdentityToken: () => string | null;
    getOAuthToken: () => string;
    requireAllScopes: (mode: string) => void;
    AuthMode: { FULL: string };
  };
  properties: { getScriptProperties: () => ScriptProperties };
  fetcher: { fetch: (...args: readonly [string, FetchRequest?]) => HttpResponse };
  caches: {
    getUserCache: () => {
      get: (key: string) => string | null;
      put: (...args: readonly [string, string, number]) => void;
      remove: (key: string) => void;
    };
  };
  utilities: {
    base64DecodeWebSafe: (value: string) => number[];
    newBlob: (bytes: number[]) => { getDataAsString: () => string };
  };
  logger: {
    error: (message: string) => void;
    warn: (message: string) => void;
    info: (message: string) => void;
  };
};

const MISSING_IDENTITY_TOKEN = "Identity token was missing.";
const MISSING_IDENTITY_PAYLOAD = "Identity token payload was missing.";
const API_BASE_URL_KEY = "API_BASE_URL";
const WEB_BASE_URL_KEY = "WEB_BASE_URL";
const DEFAULT_API_BASE_URL = "https://api.ready.app";
const DEFAULT_WEB_BASE_URL = "https://ready.app";
const IDENTITY_PAYLOAD_SEPARATOR = ".";
const PAYLOAD_SEGMENT_INDEX = 1;

const toHttpResult = (response: HttpResponse): GoogleCalendarHttpResult => ({
  status: response.getResponseCode(),
  body: response.getContentText(),
});

const scriptProperty = ({
  properties,
  key,
  fallback,
}: {
  properties: AppsScriptHosts["properties"];
  key: string;
  fallback: string;
}): string => (properties.getScriptProperties().getProperty(key) ?? fallback).replace(/\/+$/, "");

const identityAudience = ({ script, utilities }: Pick<AppsScriptHosts, "script" | "utilities">): string | string[] => {
  const idToken = script.getIdentityToken();
  if (idToken === null || idToken === "") {
    throw new Error(MISSING_IDENTITY_TOKEN);
  }
  const payloadSegment = idToken.split(IDENTITY_PAYLOAD_SEPARATOR)[PAYLOAD_SEGMENT_INDEX];
  if (payloadSegment === undefined || payloadSegment === "") {
    throw new Error(MISSING_IDENTITY_PAYLOAD);
  }
  const decoded = utilities.newBlob(utilities.base64DecodeWebSafe(payloadSegment)).getDataAsString();

  return identityPayloadSchema.parse(JSON.parse(decoded)).aud;
};

export const createAppsScriptServices = ({
  script,
  properties,
  fetcher,
  caches,
  utilities,
  logger,
}: AppsScriptHosts): GoogleCalendarPort => {
  const apiBaseUrl = (): string =>
    scriptProperty({ properties, key: API_BASE_URL_KEY, fallback: DEFAULT_API_BASE_URL });
  const webBaseUrl = (): string =>
    scriptProperty({ properties, key: WEB_BASE_URL_KEY, fallback: DEFAULT_WEB_BASE_URL });
  const parseAuth = (text: string): GoogleCalendarAuth => authSchema.parse(JSON.parse(text));

  return {
    requireScopes: () => {
      script.requireAllScopes(script.AuthMode.FULL);
    },
    webBaseUrl,
    identityToken: () => script.getIdentityToken(),
    calendarToken: () => script.getOAuthToken(),
    cachedAuth: () => caches.getUserCache().get(AUTH_CACHE_KEY),
    parseAuth,
    saveAuth: (auth) => {
      caches.getUserCache().put(AUTH_CACHE_KEY, JSON.stringify(auth), AUTH_CACHE_TTL_SECONDS);
    },
    clearAuth: () => {
      caches.getUserCache().remove(AUTH_CACHE_KEY);
    },
    exchangeAuth: (idToken) =>
      toHttpResult(
        fetcher.fetch(`${apiBaseUrl()}/v1/auth/google-addon-login`, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({ idToken }),
          /** @external Apps Script UrlFetchApp option */
          muteHttpExceptions: true,
        }),
      ),
    fetch: ({
      auth,
      path,
      options,
    }: {
      auth: GoogleCalendarAuth;
      path: string;
      options?: GoogleCalendarFetchOptions;
    }) =>
      toHttpResult(
        fetcher.fetch(`${apiBaseUrl()}${path}`, {
          method: options?.method ?? "get",
          headers: { Authorization: `Bearer ${auth.token}` },
          /** @external Apps Script UrlFetchApp option */
          muteHttpExceptions: true,
          ...(options?.payload === undefined
            ? {}
            : { contentType: "application/json", payload: JSON.stringify(options.payload) }),
        }),
      ),
    meetingLink: (body) => meetingResponseSchema.parse(JSON.parse(body)).meetingLink,
    error: (message) => {
      logger.error(message);
    },
    warn: (message) => {
      logger.warn(message);
    },
    info: (message) => {
      logger.info(message);
    },
    debugIdentityAudience: () => {
      const audience = identityAudience({ script, utilities });
      logger.info(`Identity token aud: ${Array.isArray(audience) ? audience.join(",") : audience}.`);

      return audience;
    },
    debugVerify: () => {
      const idToken = script.getIdentityToken();
      if (idToken === null || idToken === "") {
        logger.info("Identity token was missing.");

        return;
      }
      const payloadSegment = idToken.split(IDENTITY_PAYLOAD_SEPARATOR)[PAYLOAD_SEGMENT_INDEX] ?? "";
      logger.info(
        `Local payload: ${utilities.newBlob(utilities.base64DecodeWebSafe(payloadSegment)).getDataAsString()}.`,
      );
      const response = fetcher.fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
        {
          /** @external Apps Script UrlFetchApp option */
          muteHttpExceptions: true,
        },
      );
      logger.info(`tokeninfo HTTP ${response.getResponseCode()}.`);
      logger.info(`tokeninfo body: ${response.getContentText()}.`);
    },
  };
};
