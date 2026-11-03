import { z } from "zod";

import {
  buildReadyMeetCalendarDescriptionBlock,
  buildReadyMeetCalendarDescriptionText,
  READY_MEET_DESCRIPTION_BLOCK_END,
  READY_MEET_DESCRIPTION_BLOCK_START,
} from "../../../shared/domain/calendar-description";

type DialogMessageEvent = {
  origin?: string;
  message?: string;
};

export const REQUEST_KEY = "ready.outlook.request.v1";
export const CONFERENCE_KEY = "ready.outlook.conference.v1";
export const PREVIOUS_CONFERENCE_KEY = "ready.outlook.previous.v1";

const DIALOG_MESSAGE_TYPE_READY_CONFERENCE = "ready-conference";
const CONFERENCE_CODE = /^[a-zA-Z0-9-]{3,100}$/;
const CALL_IN_PHONE = /^\+?[\d ().-]{3,80}$/;
const CALL_IN_PIN = /^\d{1,20}#?$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URL_BOUNDARY = String.raw`(?=$|[\s<>"'&#?.,;:!()\[\]])`;

const callInSchema = z.object({
  phoneNumber: z.string().regex(CALL_IN_PHONE),
  pin: z.string().regex(CALL_IN_PIN),
});

const conferenceCodeSchema = z
  .object({
    code: z.string().regex(CONFERENCE_CODE),
  })
  .passthrough();

export const outlookConferenceWireSchema = z
  .object({
    code: z.string(),
    callIn: z
      .object({
        phoneNumber: z.string(),
        pin: z.string(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const dialogMessageSchema = z
  .object({
    type: z.string(),
    nonce: z.string(),
    conference: outlookConferenceWireSchema,
  })
  .passthrough();

export const outlookCancellationSchema = z
  .object({
    /** @external Outlook cancellation error contract consumed by commands. */
    cancelled: z.literal(true),
  })
  .passthrough();

export type OutlookConference = {
  code: string;
  callIn: { phoneNumber: string; pin: string } | null;
};

export const validRequestId = (value: unknown): value is string => typeof value === "string" && REQUEST_ID.test(value);

const callInValue = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "callIn" in value ? value.callIn : undefined;

export const parseConference = (value: unknown): OutlookConference | null => {
  const parsed = conferenceCodeSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const callIn = callInSchema.safeParse(callInValue(value));

  return { code: parsed.data.code, callIn: callIn.success ? callIn.data : null };
};

export const readDialogMessage = ({
  event,
  origin,
  nonce,
}: {
  event: DialogMessageEvent;
  origin: string;
  nonce: string;
}): OutlookConference | null => {
  if (event.origin !== origin || event.message === undefined) {
    return null;
  }
  try {
    const payload = dialogMessageSchema.parse(JSON.parse(event.message));
    if (payload.type !== DIALOG_MESSAGE_TYPE_READY_CONFERENCE || payload.nonce !== nonce) {
      return null;
    }

    return parseConference(payload.conference);
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }

    return null;
  }
};

export const meetingUrl = ({ origin, conference }: { origin: string; conference: OutlookConference }): string =>
  `${origin}/${conference.code}`;

export const invitation = ({
  origin,
  conference,
  isHtml,
}: {
  origin: string;
  conference: OutlookConference;
  isHtml: boolean;
}): string => {
  const joinInput = { joinUrl: meetingUrl({ origin, conference }), callIn: conference.callIn };

  return isHtml
    ? `${buildReadyMeetCalendarDescriptionBlock(joinInput)}<br><br>`
    : `${buildReadyMeetCalendarDescriptionText(joinInput)}\n\n`;
};

export const containsConference = ({
  body,
  origin,
  conference,
}: {
  body: string;
  origin: string;
  conference: OutlookConference;
}): boolean => {
  const url = meetingUrl({ origin, conference });
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return body.includes(url) && new RegExp(`${escaped}${URL_BOUNDARY}`).test(body);
};

export const descriptionBlock = ({ origin, conference }: { origin: string; conference: OutlookConference }): string =>
  buildReadyMeetCalendarDescriptionBlock({
    joinUrl: meetingUrl({ origin, conference }),
    callIn: conference.callIn,
  });

export { READY_MEET_DESCRIPTION_BLOCK_END, READY_MEET_DESCRIPTION_BLOCK_START };
