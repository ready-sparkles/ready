import { z } from "zod";

import { readResponseJson, signInAgain } from "../../../composition/outlook/runtime";
import { parseConference, validRequestId } from "../../../domain/outlook/conference";

import { readOfficeHost, readOfficeOnReady } from "./host";
import { readClickControl, readTextControl } from "./page";

const MAX_TITLE_LENGTH = 255;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const DEFAULT_TITLE = "Ready meeting";
const SESSION_CHECK_FAILURE_MESSAGE = "Could not check your account. Reopen this window to try again.";
const SIGN_IN_FAILURE_MESSAGE = "Could not start sign-in. Please try again.";
const SESSION_EXPIRED_MESSAGE = "Your session expired. Sign in again.";
const ACCOUNT_LIMIT_MESSAGE = "Your account cannot create another meeting right now.";
const CREATE_MEETING_FAILURE_MESSAGE = "Could not create your meeting. Please try again.";
const INVALID_MEETING_RESPONSE_MESSAGE = "Invalid meeting response. Please try again.";
const NETWORK_FAILURE_MESSAGE = "Could not reach Ready. Please try again.";
const REOPEN_MESSAGE = "Reopen this window from the Ready Outlook add-in.";
const SIGN_IN_PROMPT = "Sign in to Ready to create your meeting.";
const SIGN_IN_AGAIN_LABEL = "Sign in again";
const SWITCH_ACCOUNT_LABEL = "Switch Ready account";
const CREATING_MESSAGE = "Creating your Ready meeting…";
const MEETING_READY_MESSAGE = "Meeting ready. You can return to Outlook.";
const SESSION_PATH = "/api/outlook/session";
const CONFERENCE_PATH = "/api/outlook/conference";
const READY_CONFERENCE_MESSAGE = "ready-conference";
const sessionSchema = z
  .object({
    user: z.object({ email: z.string() }).nullable().optional(),
  })
  .passthrough();

const params = new URLSearchParams(location.hash.slice(1));
const requestId = params.get("requestId");
const nonce = params.get("nonce");
const titleValue = params.get("title");
const title = (titleValue === null || titleValue === "" ? DEFAULT_TITLE : titleValue).trim().slice(0, MAX_TITLE_LENGTH);
const status = readTextControl("#status");
const add = readClickControl("#confirm");
const signin = readClickControl("#signin");
const heading = readTextControl("#title");
const callbackUrl = `/outlook/dialog.html${location.hash}`;

const failureMessage = (error: unknown): string => {
  if (error instanceof TypeError) {
    return NETWORK_FAILURE_MESSAGE;
  }
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }

  return CREATE_MEETING_FAILURE_MESSAGE;
};

const showSignInFailure = (): void => {
  status.textContent = SIGN_IN_FAILURE_MESSAGE;
  signin.hidden = false;
};

signin.href = `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
signin.addEventListener("click", (event) => {
  // Stay on the dialog until sign-out finishes; following the /login href early would cancel it and keep the old session.
  event.preventDefault();

  return (async () => {
    signin.hidden = true;
    add.hidden = true;
    try {
      location.assign(await signInAgain({ callbackUrl }));
    } catch (error) {
      if (error instanceof Error) {
        showSignInFailure();
      } else {
        showSignInFailure();
      }
    }
  })();
});

const showSignedOut = (): void => {
  status.textContent = SIGN_IN_PROMPT;
  signin.hidden = false;
};

const showSession = (email: string): void => {
  status.textContent = `Signed in as ${email}`;
  heading.textContent = title;
  add.hidden = false;
  signin.textContent = SWITCH_ACCOUNT_LABEL;
  signin.hidden = false;
};

const loadSession = async (): Promise<void> => {
  if (!validRequestId(requestId) || !validRequestId(nonce)) {
    status.textContent = REOPEN_MESSAGE;

    return;
  }
  try {
    const response = await fetch(SESSION_PATH, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(SESSION_CHECK_FAILURE_MESSAGE);
    }
    const payload = await readResponseJson({ response, fallback: SESSION_CHECK_FAILURE_MESSAGE });
    const session = sessionSchema.safeParse(payload);
    if (!session.success || session.data.user === undefined || session.data.user === null) {
      showSignedOut();

      return;
    }
    showSession(session.data.user.email);
  } catch (error) {
    if (error instanceof Error) {
      status.textContent = SESSION_CHECK_FAILURE_MESSAGE;
    } else {
      status.textContent = SESSION_CHECK_FAILURE_MESSAGE;
    }
  }
};

const start = readOfficeOnReady();
if (start !== undefined) {
  start(() => loadSession());
}

const conferenceFailure = (statusCode: number): string => {
  if (statusCode === UNAUTHORIZED_STATUS) {
    return SESSION_EXPIRED_MESSAGE;
  }
  if (statusCode === FORBIDDEN_STATUS) {
    return ACCOUNT_LIMIT_MESSAGE;
  }

  return CREATE_MEETING_FAILURE_MESSAGE;
};

const createMeeting = async (): Promise<void> => {
  add.disabled = true;
  signin.hidden = true;
  try {
    status.textContent = CREATING_MESSAGE;
    const response = await fetch(CONFERENCE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, requestId }),
    });
    if (response.status === UNAUTHORIZED_STATUS) {
      signin.textContent = SIGN_IN_AGAIN_LABEL;
      signin.hidden = false;
      add.hidden = true;
    }
    const payload = await readResponseJson({ response, fallback: conferenceFailure(response.status) });
    const conference = parseConference(payload);
    if (conference === null || nonce === null) {
      throw new Error(INVALID_MEETING_RESPONSE_MESSAGE);
    }
    const office = readOfficeHost();
    if (office === undefined) {
      throw new Error(INVALID_MEETING_RESPONSE_MESSAGE);
    }
    office.context.ui.messageParent(JSON.stringify({ type: READY_CONFERENCE_MESSAGE, nonce, conference }), {
      targetOrigin: location.origin,
    });
    status.textContent = MEETING_READY_MESSAGE;
  } catch (error) {
    status.textContent = failureMessage(error);
    add.disabled = false;
    signin.hidden = false;
  }
};

add.addEventListener("click", () => createMeeting());
