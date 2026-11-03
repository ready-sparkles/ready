import type { OutlookConference } from "../../domain/outlook/conference";
import {
  CONFERENCE_KEY,
  containsConference,
  descriptionBlock,
  invitation,
  meetingUrl,
  outlookConferenceWireSchema,
  parseConference,
  PREVIOUS_CONFERENCE_KEY,
  READY_MEET_DESCRIPTION_BLOCK_END,
  READY_MEET_DESCRIPTION_BLOCK_START,
  REQUEST_KEY,
  validRequestId,
} from "../../domain/outlook/conference";
import { requestIdFromDigest, requestIdMaterial } from "../../domain/outlook/request-id";
import type {
  OfficeCallbackResult,
  OutlookAppointmentItem,
  OutlookCryptoPort,
  OutlookCustomProperties,
  OutlookItemIdentity,
} from "../../ports/outlook";

const OUTLOOK_ACTION_FAILURE_MESSAGE = "Outlook could not complete the action.";
const REQUEST_ID_READ_FAILURE_MESSAGE = "Could not read this event. Reopen it in Outlook and try again.";
const ITEM_NOT_SAVED = "ItemNotSaved";
const HTML_BODY = "html";
const EMPTY_STORED_CONFERENCE = "null";

type AppointmentBodyEdit = { action: "replace"; body: string } | { action: "stop" } | { action: "prepend" };

export const officeAsync = <T>(invoke: (done: (result: OfficeCallbackResult<T>) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    invoke((result) => {
      if (result.status === "succeeded") {
        resolve(result.value);

        return;
      }
      const message = result.error?.message;
      reject(new Error(message === undefined || message === "" ? OUTLOOK_ACTION_FAILURE_MESSAGE : message));
    });
  });

const readStoredConference = ({
  properties,
  key,
}: {
  properties: OutlookCustomProperties;
  key: string;
}): OutlookConference | null => {
  try {
    const raw = properties.get(key);
    const text = raw === undefined || raw === null || raw === "" ? EMPTY_STORED_CONFERENCE : raw;

    return parseConference(outlookConferenceWireSchema.parse(JSON.parse(text)));
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }

    return null;
  }
};

const replacePreviousBlock = ({
  body,
  origin,
  previous,
  conference,
  isHtmlFormat,
}: {
  body: string;
  origin: string;
  previous: OutlookConference;
  conference: OutlookConference;
  isHtmlFormat: boolean;
}): string => {
  const url = meetingUrl({ origin, conference: previous });
  const dialIn =
    previous.callIn === null ? "" : `Dial-in: (US) ${previous.callIn.phoneNumber} PIN: ${previous.callIn.pin}#`;
  const dialInMarkup = dialIn === "" ? "" : `<p>${dialIn}</p>`;
  const dialInText = dialIn === "" ? "" : `${dialIn}\n`;
  const legacy = isHtmlFormat
    ? `<div><p><strong>Join meeting:</strong> <a href="${url}">${url}</a></p>${dialInMarkup}</div><br>`
    : `Join meeting: ${url}\n${dialInText}\n`;
  const matchingBlock = [invitation({ origin, conference: previous, isHtml: isHtmlFormat }), legacy].find((candidate) =>
    body.includes(candidate),
  );
  if (matchingBlock === undefined) {
    return body;
  }

  return body.replace(matchingBlock, invitation({ origin, conference, isHtml: isHtmlFormat }));
};

const managedHtmlEdit = ({
  body,
  origin,
  conference,
  isHtmlFormat,
}: {
  body: string;
  origin: string;
  conference: OutlookConference;
  isHtmlFormat: boolean;
}): AppointmentBodyEdit | null => {
  if (!isHtmlFormat) {
    return null;
  }
  const start = body.indexOf(READY_MEET_DESCRIPTION_BLOCK_START);
  const end = body.indexOf(READY_MEET_DESCRIPTION_BLOCK_END, start);
  if (start === -1 || end === -1) {
    return null;
  }
  const next =
    body.slice(0, start) +
    descriptionBlock({ origin, conference }) +
    body.slice(end + READY_MEET_DESCRIPTION_BLOCK_END.length);

  return next === body ? { action: "stop" } : { action: "replace", body: next };
};

const appointmentBodyEdit = ({
  body,
  origin,
  previous,
  conference,
  isHtmlFormat,
}: {
  body: string;
  origin: string;
  previous: OutlookConference | null;
  conference: OutlookConference;
  isHtmlFormat: boolean;
}): AppointmentBodyEdit => {
  const managed = managedHtmlEdit({ body, origin, conference, isHtmlFormat });
  if (managed !== null) {
    return managed;
  }
  if (previous === null || previous.code === conference.code) {
    return { action: "prepend" };
  }
  const next = replacePreviousBlock({ body, origin, previous, conference, isHtmlFormat });

  return next === body ? { action: "prepend" } : { action: "replace", body: next };
};

const writeAppointmentBody = async ({
  item,
  origin,
  previous,
  conference,
}: {
  item: OutlookAppointmentItem;
  origin: string;
  previous: OutlookConference | null;
  conference: OutlookConference;
}): Promise<void> => {
  const outlookBody = item.body;
  const bodyType = await officeAsync<string>((done) => {
    outlookBody.getTypeAsync(done);
  });
  const appointmentBody = await officeAsync<string>((done) => {
    outlookBody.getAsync(bodyType, done);
  });
  const edit = appointmentBodyEdit({
    body: appointmentBody,
    origin,
    previous,
    conference,
    isHtmlFormat: bodyType === HTML_BODY,
  });
  if (edit.action === "stop") {
    return;
  }
  if (edit.action === "replace") {
    await officeAsync((done) => {
      outlookBody.setAsync(edit.body, { coercionType: bodyType }, done);
    });

    return;
  }
  if (!containsConference({ body: appointmentBody, origin, conference })) {
    await officeAsync((done) => {
      outlookBody.prependAsync(
        invitation({ origin, conference, isHtml: bodyType === HTML_BODY }),
        {
          coercionType: bodyType,
        },
        done,
      );
    });
  }
};

export const insertConference = async ({
  item,
  properties,
  conference,
  origin,
}: {
  item: OutlookAppointmentItem;
  properties: OutlookCustomProperties;
  conference: OutlookConference;
  origin: string;
}): Promise<void> => {
  const current = readStoredConference({ properties, key: CONFERENCE_KEY });
  if (current !== null && current.code !== conference.code) {
    properties.set(PREVIOUS_CONFERENCE_KEY, JSON.stringify(current));
  }
  const previous = readStoredConference({ properties, key: PREVIOUS_CONFERENCE_KEY });
  properties.set(CONFERENCE_KEY, JSON.stringify(conference));
  await officeAsync((done) => {
    properties.saveAsync(done);
  });
  await writeAppointmentBody({ item, origin, previous, conference });
};

export const requestIdForItemWithPort = async ({
  mailbox,
  itemId,
  cryptoPort,
}: {
  mailbox: string;
  itemId: string;
  cryptoPort: OutlookCryptoPort;
}): Promise<string> => {
  const digest = new Uint8Array(await cryptoPort.digestSha256(requestIdMaterial({ mailbox, itemId })));

  return requestIdFromDigest({ digest });
};

const readItemId = (item: OutlookItemIdentity): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const readSavedItemId = item.getItemIdAsync;
    if (readSavedItemId === undefined) {
      reject(new Error(REQUEST_ID_READ_FAILURE_MESSAGE));

      return;
    }
    readSavedItemId((result) => {
      if (result.status === "succeeded") {
        resolve(result.value);

        return;
      }
      if (result.error?.name === ITEM_NOT_SAVED) {
        resolve(null);

        return;
      }
      reject(new Error(REQUEST_ID_READ_FAILURE_MESSAGE));
    });
  });

export const getRequestIdWithPort = async ({
  item,
  properties,
  mailbox,
  cryptoPort,
}: {
  item: OutlookItemIdentity;
  properties: OutlookCustomProperties;
  mailbox: string;
  cryptoPort: OutlookCryptoPort;
}): Promise<string> => {
  const storedRequestId = properties.get(REQUEST_KEY);
  if (validRequestId(storedRequestId)) {
    return storedRequestId;
  }
  const itemId = await readItemId(item);
  const requestId =
    itemId === null ? cryptoPort.randomUuid() : await requestIdForItemWithPort({ mailbox, itemId, cryptoPort });
  properties.set(REQUEST_KEY, requestId);
  await officeAsync((done) => {
    properties.saveAsync(done);
  });

  return requestId;
};
