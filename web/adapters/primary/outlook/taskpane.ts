import { meetingUrl } from "../../../domain/outlook/conference";

import { hasWebCrypto, readOfficeHost, readOfficeOnReady } from "./host";
import { addReadyMeeting } from "./meeting-flow";
import { readClickControl, readLinkControl, readTextControl } from "./page";

const ADD_FAILURE_MESSAGE = "Could not add the meeting. Please try again.";
const ADDED_MESSAGE = "Ready meeting added. Save or send your invitation in Outlook.";
const PREPARING_MESSAGE = "Preparing your meeting…";
const OPEN_EVENT_MESSAGE = "Open an Outlook calendar event you organize to add a Ready meeting.";
const UPDATE_OUTLOOK_MESSAGE = "Please update Outlook to use secure Ready sign-in.";
const READY_TO_ADD_MESSAGE = "Add a Ready link and dial-in details to this invitation.";
const ADD_AGAIN_LABEL = "Add meeting details again";
const DIALOG_ORIGIN_REQUIREMENT = "DialogOrigin";
const DIALOG_ORIGIN_VERSION = "1.1";
const MAILBOX_REQUIREMENT = "Mailbox";
const MAILBOX_VERSION = "1.8";

const button = readClickControl("#add");
const status = readTextControl("#status");
const join = readLinkControl("#join");
const state: { item: NonNullable<ReturnType<typeof readOfficeHost>>["context"]["mailbox"]["item"] | undefined } = {
  item: undefined,
};

const message = (text: string): void => {
  status.textContent = text;
};

const finishMeeting = (
  result: { conference: Awaited<ReturnType<typeof addReadyMeeting>> } | { error: unknown },
): void => {
  if ("error" in result) {
    const failure = result.error;
    message(failure instanceof Error && failure.message !== "" ? failure.message : ADD_FAILURE_MESSAGE);
  } else {
    message(ADDED_MESSAGE);
    join.href = meetingUrl({ origin: location.origin, conference: result.conference });
    join.hidden = false;
    button.textContent = ADD_AGAIN_LABEL;
  }
  button.disabled = false;
};

const start = readOfficeOnReady();
if (hasWebCrypto() && start !== undefined) {
  start((info) => {
    const office = readOfficeHost();
    const item = office?.context.mailbox.item;
    if (office === undefined || item === undefined || info.host !== office.HostType.Outlook) {
      message(OPEN_EVENT_MESSAGE);

      return;
    }
    const readSubject = item.subject?.getAsync;
    if (readSubject === undefined) {
      message(OPEN_EVENT_MESSAGE);

      return;
    }
    if (
      !office.context.requirements.isSetSupported(DIALOG_ORIGIN_REQUIREMENT, DIALOG_ORIGIN_VERSION) ||
      !office.context.requirements.isSetSupported(MAILBOX_REQUIREMENT, MAILBOX_VERSION) ||
      item.getItemIdAsync === undefined
    ) {
      message(UPDATE_OUTLOOK_MESSAGE);

      return;
    }
    state.item = item;
    button.disabled = false;
    message(READY_TO_ADD_MESSAGE);
  });
}

button.addEventListener("click", () =>
  (async () => {
    if (button.disabled || state.item === undefined) {
      return;
    }
    button.disabled = true;
    join.hidden = true;
    message(PREPARING_MESSAGE);
    try {
      finishMeeting({ conference: await addReadyMeeting() });
    } catch (error) {
      finishMeeting({ error });
    }
  })(),
);
