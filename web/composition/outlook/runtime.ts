import { createWebCrypto } from "../../adapters/secondary/web-crypto/digest";
import {
  getRequestIdWithPort,
  insertConference,
  requestIdForItemWithPort,
} from "../../application/outlook/appointment";
import { readResponseJson, signInAgainWithFetcher } from "../../application/outlook/session";
import {
  CONFERENCE_KEY,
  containsConference,
  invitation,
  meetingUrl,
  parseConference,
  readDialogMessage,
  REQUEST_KEY,
  validRequestId,
} from "../../domain/outlook/conference";
import type { OutlookCustomProperties, OutlookItemIdentity } from "../../ports/outlook";

const cryptoPort = createWebCrypto();

export {
  CONFERENCE_KEY,
  containsConference,
  insertConference,
  invitation,
  meetingUrl,
  parseConference,
  readDialogMessage,
  readResponseJson,
  REQUEST_KEY,
  validRequestId,
};

export const requestIdForItem = ({ mailbox, itemId }: { mailbox: string; itemId: string }): Promise<string> =>
  requestIdForItemWithPort({ mailbox, itemId, cryptoPort });

export const getRequestId = ({
  item,
  properties,
  mailbox,
}: {
  item: OutlookItemIdentity;
  properties: OutlookCustomProperties;
  mailbox: string;
}): Promise<string> => getRequestIdWithPort({ item, properties, mailbox, cryptoPort });

export const signInAgain = ({
  callbackUrl,
  fetcher = fetch,
}: {
  callbackUrl: string;
  fetcher?: typeof fetch;
}): Promise<string> => signInAgainWithFetcher({ callbackUrl, fetcher });
