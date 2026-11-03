import type { GoogleCalendarErrorType } from "../../domain/google-calendar/conference";
import {
  conferenceErrorTypeForResponseCode,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
} from "../../domain/google-calendar/conference";
import type { GoogleCalendarAuth } from "../../domain/google-calendar/contracts";
import type {
  GoogleCalendarFetchOptions,
  GoogleCalendarHttpResult,
  GoogleCalendarPort,
} from "../../ports/google-calendar";

const MISSING_IDENTITY_TOKEN_MESSAGE =
  "Ready auth: ScriptApp.getIdentityToken() returned null (openid scope not granted?).";

type GoogleCalendarAuthResult = {
  auth: GoogleCalendarAuth | null;
  errorType: GoogleCalendarErrorType | null;
};

type GoogleCalendarRequestResult = {
  response: GoogleCalendarHttpResult | null;
  auth: GoogleCalendarAuth | null;
  errorType: GoogleCalendarErrorType | null;
};

const exchange = (port: GoogleCalendarPort): GoogleCalendarAuthResult => {
  try {
    const idToken = port.identityToken();
    if (idToken === null || idToken === "") {
      port.error(MISSING_IDENTITY_TOKEN_MESSAGE);

      return { auth: null, errorType: "authentication" };
    }
    const response = port.exchangeAuth(idToken);
    if (response.status !== HTTP_OK) {
      port.error(`Ready auth exchange failed: HTTP ${response.status} body=${response.body}.`);

      return { auth: null, errorType: conferenceErrorTypeForResponseCode(response.status) };
    }
    const auth = port.parseAuth(response.body);
    port.saveAuth(auth);

    return { auth, errorType: null };
  } catch (error) {
    port.error(`Ready auth exchange error: ${error instanceof Error ? error.message : String(error)}.`);

    return { auth: null, errorType: "temporary" };
  }
};

const readCachedAuth = ({
  port,
  shouldForceRefresh,
}: {
  port: GoogleCalendarPort;
  shouldForceRefresh: boolean;
}): GoogleCalendarAuthResult | null => {
  if (shouldForceRefresh) {
    return null;
  }
  const cached = port.cachedAuth();
  if (cached === null || cached === "") {
    return null;
  }
  try {
    return { auth: port.parseAuth(cached), errorType: null };
  } catch (error) {
    port.warn(`Ready auth cache was invalid; refreshing: ${error instanceof Error ? error.message : String(error)}.`);
    port.clearAuth();

    return null;
  }
};

const fetchResult = ({
  port,
  auth,
  path,
  options,
  isRetry,
}: {
  port: GoogleCalendarPort;
  auth: GoogleCalendarAuth;
  path: string;
  options?: GoogleCalendarFetchOptions;
  isRetry: boolean;
}): GoogleCalendarRequestResult => {
  try {
    const response = port.fetch({ auth, path, options });

    return {
      response,
      auth,
      errorType: isRetry && response.status === HTTP_UNAUTHORIZED ? "authentication" : null,
    };
  } catch (error) {
    port.error(
      `Ready API ${isRetry ? "retry" : "request"} error: ${error instanceof Error ? error.message : String(error)}.`,
    );

    return { response: null, auth, errorType: "temporary" };
  }
};

export const createAuthFlow = (
  port: GoogleCalendarPort,
): {
  getAuthResult: (shouldForceRefresh: boolean) => GoogleCalendarAuthResult;
  request: (input: { path: string; options?: GoogleCalendarFetchOptions }) => GoogleCalendarRequestResult;
} => {
  const getAuthResult = (shouldForceRefresh: boolean): GoogleCalendarAuthResult =>
    readCachedAuth({ port, shouldForceRefresh }) ?? exchange(port);
  const request = ({
    path,
    options,
  }: {
    path: string;
    options?: GoogleCalendarFetchOptions;
  }): GoogleCalendarRequestResult => {
    const authResult = getAuthResult(false);
    if (authResult.auth === null) {
      return { response: null, auth: null, errorType: authResult.errorType };
    }
    const result = fetchResult({ port, auth: authResult.auth, path, options, isRetry: false });
    if (result.response === null || result.response.status !== HTTP_UNAUTHORIZED) {
      return result;
    }
    port.clearAuth();
    const refreshed = getAuthResult(true);
    if (refreshed.auth === null) {
      return { response: null, auth: null, errorType: refreshed.errorType };
    }

    return fetchResult({ port, auth: refreshed.auth, path, options, isRetry: true });
  };

  return { getAuthResult, request };
};
