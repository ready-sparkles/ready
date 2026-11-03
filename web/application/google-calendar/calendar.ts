import type { GoogleCalendarErrorType, GoogleCalendarEvent } from "../../domain/google-calendar/conference";
import {
  conferenceContext,
  conferenceErrorTypeForResponseCode,
  conferenceTitle,
  homepageCopy,
  HTTP_OK,
  readyWebSignInUrl,
} from "../../domain/google-calendar/conference";
import type { GoogleCalendarAuth, GoogleCalendarMeetingLink } from "../../domain/google-calendar/contracts";
import type { GoogleCalendarPort } from "../../ports/google-calendar";

import type { createAuthFlow } from "./auth";

const MISSING_EVENT_IDENTITY_MESSAGE = "Ready conference: Google event identity was missing.";
type AuthFlow = ReturnType<typeof createAuthFlow>;

type GoogleCalendarHomepage =
  | { errorType: GoogleCalendarErrorType; copy?: undefined; signInUrl?: undefined }
  | { errorType?: undefined; copy: { title: string; body: string }; signInUrl: string };

const consumeAccountCreated = ({ port, auth }: { port: GoogleCalendarPort; auth: GoogleCalendarAuth }): boolean => {
  const isAccountCreated = auth.accountCreated === true;
  if (isAccountCreated) {
    port.saveAuth({
      ...auth,
      /** @external Ready auth wire field */
      accountCreated: false,
    });
  }

  return isAccountCreated;
};

const createConference = ({
  port,
  authFlow,
  event,
}: {
  port: GoogleCalendarPort;
  authFlow: AuthFlow;
  event: GoogleCalendarEvent;
}): { errorType: GoogleCalendarErrorType } | { meetingLink: GoogleCalendarMeetingLink } => {
  port.requireScopes();
  const context = conferenceContext(event);
  if (context === null) {
    port.error(MISSING_EVENT_IDENTITY_MESSAGE);

    return { errorType: "temporary" };
  }
  const result = authFlow.request({
    path: "/v1/meetings/google-calendar-addon",
    options: {
      method: "post",
      payload: {
        title: conferenceTitle(event),
        calendarAccessToken: port.calendarToken(),
        calendarWebBaseUrl: port.webBaseUrl(),
        calendarId: context.calendarId,
        eventId: context.eventId,
      },
    },
  });
  if (result.response === null) {
    return { errorType: result.errorType ?? "temporary" };
  }
  port.info(`Ready conference: POST /v1/meetings/google-calendar-addon -> HTTP ${result.response.status}.`);
  if (result.response.status !== HTTP_OK) {
    port.error(`Ready meeting creation failed: HTTP ${result.response.status} body=${result.response.body}.`);

    return { errorType: conferenceErrorTypeForResponseCode(result.response.status) };
  }

  return { meetingLink: port.meetingLink(result.response.body) };
};

const homepage = ({ port, authFlow }: { port: GoogleCalendarPort; authFlow: AuthFlow }): GoogleCalendarHomepage => {
  port.requireScopes();
  // A fresh identity exchange keeps the one-hour browser handoff usable.
  const authResult = authFlow.getAuthResult(true);
  if (authResult.auth === null) {
    return { errorType: authResult.errorType ?? "temporary" };
  }
  const signInUrl = readyWebSignInUrl({ auth: authResult.auth, webBaseUrl: port.webBaseUrl() });
  if (signInUrl === null) {
    port.clearAuth();

    return { errorType: "reconnect" };
  }

  return {
    copy: homepageCopy({
      auth: authResult.auth,
      isAccountCreated: consumeAccountCreated({ port, auth: authResult.auth }),
      webBaseUrl: port.webBaseUrl(),
    }),
    signInUrl,
  };
};

export const createCalendarFlow = ({
  port,
  authFlow,
}: {
  port: GoogleCalendarPort;
  authFlow: AuthFlow;
}): {
  createConference: (event: GoogleCalendarEvent) => ReturnType<typeof createConference>;
  homepage: () => GoogleCalendarHomepage;
  consumeAccountCreated: (auth: GoogleCalendarAuth) => boolean;
} => ({
  createConference: (event) => createConference({ port, authFlow, event }),
  homepage: () => homepage({ port, authFlow }),
  consumeAccountCreated: (auth) => consumeAccountCreated({ port, auth }),
});
