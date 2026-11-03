import { officeAsync } from "../../../application/outlook/appointment";
import { getRequestId, insertConference } from "../../../composition/outlook/runtime";
import type { OutlookConference } from "../../../domain/outlook/conference";
import { readDialogMessage } from "../../../domain/outlook/conference";
import type {
  OutlookCustomProperties,
  OutlookDialog,
  OutlookDialogEvent,
  OutlookOfficeHost,
} from "../../../ports/outlook";

import { hasWebCrypto, readOfficeHost } from "./host";

const DIALOG_HEIGHT_PERCENT = 65;
const DIALOG_WIDTH_PERCENT = 35;
const MINUTES_PER_TIMEOUT = 10;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const DIALOG_TIMEOUT = MINUTES_PER_TIMEOUT * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const WINDOW_TIMEOUT_MESSAGE = "The sign-in window timed out. Please try again.";
const WINDOW_CLOSED_MESSAGE = "The window was closed. You can try again.";
const MAX_MEETING_TITLE_LENGTH = 255;
const DEFAULT_MEETING_TITLE = "Ready meeting";
const OUTLOOK_UPDATE_REQUIRED_MESSAGE = "Please update Outlook to use secure Ready sign-in.";
const DIALOG_OPEN_FAILURE_MESSAGE = "Allow the sign-in window, then try again.";
const DIALOG_ORIGIN_REQUIREMENT = "DialogOrigin";
const DIALOG_ORIGIN_VERSION = "1.1";
const MAILBOX_REQUIREMENT = "Mailbox";
const MAILBOX_VERSION = "1.8";

type DialogOutcome = { error?: Error; conference?: OutlookConference };

const cancelledError = (): Error =>
  Object.assign(new Error(WINDOW_CLOSED_MESSAGE), {
    /** @external Outlook cancellation error contract consumed by commands. */
    cancelled: true,
  });

const watchDialog = ({
  dialog,
  nonce,
  messageEvent,
  closeEvent,
  resolve,
  reject,
}: {
  dialog: OutlookDialog;
  nonce: string;
  messageEvent: string;
  closeEvent: string;
  resolve: (conference: OutlookConference) => void;
  reject: (error: Error) => void;
}): void => {
  const settlement = { hasSettled: false };
  const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
  const finish = (outcome: DialogOutcome): void => {
    if (settlement.hasSettled) {
      return;
    }
    settlement.hasSettled = true;
    clearTimeout(timer.id);
    dialog.close();
    if (outcome.error !== undefined) {
      reject(outcome.error);

      return;
    }
    if (outcome.conference !== undefined) {
      resolve(outcome.conference);
    }
  };
  timer.id = setTimeout(() => {
    finish({ error: new Error(WINDOW_TIMEOUT_MESSAGE) });
  }, DIALOG_TIMEOUT);
  dialog.addEventHandler(messageEvent, (event: OutlookDialogEvent) => {
    const conference = readDialogMessage({ event, origin: location.origin, nonce });
    if (conference !== null) {
      finish({ conference });
    }
  });
  dialog.addEventHandler(closeEvent, () => {
    finish({ error: cancelledError() });
  });
};

export const openConferenceDialog = ({
  title,
  requestId,
  office = readOfficeHost(),
}: {
  title: string;
  requestId: string;
  office?: OutlookOfficeHost;
}): Promise<OutlookConference> =>
  new Promise((resolve, reject) => {
    if (office === undefined) {
      reject(new Error(DIALOG_OPEN_FAILURE_MESSAGE));

      return;
    }
    const nonce = crypto.randomUUID();
    const fragment = new URLSearchParams({ title, requestId, nonce });
    office.context.ui.displayDialogAsync(
      `${location.origin}/outlook/dialog.html#${fragment}`,
      {
        height: DIALOG_HEIGHT_PERCENT,
        width: DIALOG_WIDTH_PERCENT,
        /** @external Office displayDialogAsync options contract. */
        displayInIframe: false,
      },
      (result) => {
        if (result.status !== "succeeded") {
          const message = result.error?.message;
          reject(new Error(message === undefined || message === "" ? DIALOG_OPEN_FAILURE_MESSAGE : message));

          return;
        }
        watchDialog({
          dialog: result.value,
          nonce,
          messageEvent: office.EventType.DialogMessageReceived,
          closeEvent: office.EventType.DialogEventReceived,
          resolve,
          reject,
        });
      },
    );
  });

const hasSecureOutlook = (office: OutlookOfficeHost): boolean => {
  const item = office.context.mailbox.item;

  return (
    hasWebCrypto() &&
    office.context.requirements.isSetSupported(DIALOG_ORIGIN_REQUIREMENT, DIALOG_ORIGIN_VERSION) &&
    office.context.requirements.isSetSupported(MAILBOX_REQUIREMENT, MAILBOX_VERSION) &&
    typeof item.getItemIdAsync === "function"
  );
};

const meetingTitle = (subject: string): string => {
  const trimmed = subject.trim().slice(0, MAX_MEETING_TITLE_LENGTH);

  return trimmed === "" ? DEFAULT_MEETING_TITLE : trimmed;
};

export const addReadyMeeting = async ({
  office = readOfficeHost(),
  origin = location.origin,
  openDialog = openConferenceDialog,
}: {
  office?: OutlookOfficeHost;
  origin?: string;
  openDialog?: (input: { title: string; requestId: string }) => Promise<OutlookConference>;
} = {}): Promise<OutlookConference> => {
  if (office === undefined || !hasSecureOutlook(office)) {
    throw new Error(OUTLOOK_UPDATE_REQUIRED_MESSAGE);
  }
  const { item, userProfile } = office.context.mailbox;
  const loadProperties = item.loadCustomPropertiesAsync;
  const readSubject = item.subject?.getAsync;
  if (loadProperties === undefined || readSubject === undefined) {
    throw new Error(OUTLOOK_UPDATE_REQUIRED_MESSAGE);
  }
  const properties = await officeAsync<OutlookCustomProperties>((done) => {
    loadProperties(done);
  });
  const requestId = await getRequestId({ item, properties, mailbox: userProfile.emailAddress });
  const subject = await officeAsync<string>((done) => {
    readSubject(done);
  });
  const conference = await openDialog({ title: meetingTitle(subject), requestId });
  await insertConference({ item, properties, conference, origin });

  return conference;
};
