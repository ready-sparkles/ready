import type { RepositoryPort } from "@readymeet/db/ports/repository";
import { z } from "zod";

import { repositories } from "../ports/repository-runtime";

import {
  buildReadyMeetingJoinUrl,
  extractReadyMeetingCodeFromUrl,
  patchReadyMeetCalendarDescription,
} from "./calendar-client";

const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_GONE = 410;

const googleUserInfoSchema = z.object({
  email: z.string().optional(),
  /** @external Google OAuth verified_email */
  verified_email: z.boolean().optional(),
});

const googleCalendarEventSchema = z.object({
  status: z.string().optional(),
  etag: z.string().optional(),
  description: z.string().optional(),
  conferenceData: z
    .object({
      entryPoints: z
        .array(
          z.object({
            entryPointType: z.string().optional(),
            uri: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const calendarPatchCancelledStatuses = new Set([HTTP_STATUS_UNAUTHORIZED, HTTP_STATUS_FORBIDDEN, HTTP_STATUS_GONE]);
const calendarPatchTerminalStatuses = new Set([
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_UNAUTHORIZED,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_GONE,
]);

type Outcome = "pending" | "done" | "cancelled";

// All network calls are bounded below the durable lease duration. Retrying a
// PATCH after an ambiguous response starts with a fresh GET and content check.
async function googleRequest(input: { url: string; token: string; init?: RequestInit }) {
  const headers = new Headers({ authorization: `Bearer ${input.token}` });
  new Headers(input.init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });

  return fetch(input.url, { ...input.init, signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS), headers });
}

function identityMismatch(input: { profile: z.infer<typeof googleUserInfoSchema>; email: string }) {
  if (input.profile.verified_email !== true) {
    return true;
  }
  const profileEmail = input.profile.email;
  if (profileEmail === undefined || profileEmail === "") {
    return true;
  }

  return profileEmail.toLowerCase() !== input.email.toLowerCase();
}

async function readGoogleCalendarEvent(input: {
  accessToken: string;
  calendarId: string;
  eventId: string;
}): Promise<{ outcome: Outcome; event?: z.infer<typeof googleCalendarEventSchema> }> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`;
  const response = await googleRequest({ url, token: input.accessToken });
  if (calendarPatchCancelledStatuses.has(response.status)) {
    return { outcome: "cancelled" };
  }
  if (!response.ok) {
    return { outcome: "pending" };
  }
  const parsed = googleCalendarEventSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { outcome: "pending" };
  }

  return { outcome: "pending", event: parsed.data };
}

async function verifyGoogleCalendarIdentity(input: {
  accessToken: string;
  email: string;
}): Promise<Outcome | "verified"> {
  const identity = await googleRequest({
    url: "https://www.googleapis.com/oauth2/v2/userinfo",
    token: input.accessToken,
  });
  if (identity.status === HTTP_STATUS_UNAUTHORIZED || identity.status === HTTP_STATUS_FORBIDDEN) {
    return "cancelled";
  }
  if (!identity.ok) {
    return "pending";
  }
  const profileParsed = googleUserInfoSchema.safeParse(await identity.json());
  if (!profileParsed.success || identityMismatch({ profile: profileParsed.data, email: input.email })) {
    return "cancelled";
  }

  return "verified";
}

function readyMeetingConferenceOutcome(input: { event: z.infer<typeof googleCalendarEventSchema>; joinUrl: string }): {
  outcome: Outcome;
  etag?: string;
} {
  if (input.event.status === "cancelled") {
    return { outcome: "cancelled" };
  }
  const video = input.event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video");
  const videoUri = video?.uri;
  if (videoUri === undefined || videoUri === "") {
    return { outcome: "pending" };
  }
  const expectedCode = extractReadyMeetingCodeFromUrl(input.joinUrl, input.joinUrl);
  if (
    expectedCode === null ||
    expectedCode === "" ||
    extractReadyMeetingCodeFromUrl(videoUri, input.joinUrl) !== expectedCode
  ) {
    return { outcome: "cancelled" };
  }
  const etag = input.event.etag;
  if (etag === undefined || etag === "") {
    return { outcome: "cancelled" };
  }

  return { outcome: "pending", etag };
}

async function patchGoogleCalendarDescription(input: {
  accessToken: string;
  calendarId: string;
  eventId: string;
  etag: string;
  description: string;
}): Promise<Outcome> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`;
  const updated = await googleRequest({
    url: `${url}?sendUpdates=none`,
    token: input.accessToken,
    init: {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": input.etag },
      body: JSON.stringify({ description: input.description }),
    },
  });
  if (updated.ok) {
    return "done";
  }
  if (calendarPatchTerminalStatuses.has(updated.status)) {
    return "cancelled";
  }

  return "pending";
}

export async function publishGoogleCalendarDescription(input: {
  userId: string;
  meetingLinkId: string;
  calendarId: string;
  eventId: string;
  accessToken: string;
  email: string;
  webBaseUrl: string;
}): Promise<void> {
  const link = await repositories().getMeetingLinkById(input.meetingLinkId);
  if (link === null || link.status !== "active" || link.createdByUserId !== input.userId) {
    return;
  }
  const callIn = await repositories().getMeetingLinkCallIn(link.id);
  await updateSavedCalendarDescription({
    accessToken: input.accessToken,
    email: input.email,
    calendarId: input.calendarId,
    eventId: input.eventId,
    joinUrl: buildReadyMeetingJoinUrl(link.code, input.webBaseUrl),
    callIn: activeCallInDetails(callIn),
  });
}

export async function updateSavedCalendarDescription(input: {
  accessToken: string;
  email: string;
  calendarId: string;
  eventId: string;
  joinUrl: string;
  callIn: { phoneNumber: string; pin: string } | null;
}): Promise<Outcome> {
  // Bind the short-lived grant to the authenticated add-on user, not another
  // signed-in Calendar account. Never log credentials or event content.
  const identityOutcome = await verifyGoogleCalendarIdentity({
    accessToken: input.accessToken,
    email: input.email,
  });
  if (identityOutcome !== "verified") {
    return identityOutcome;
  }

  const eventRead = await readGoogleCalendarEvent({
    accessToken: input.accessToken,
    calendarId: input.calendarId,
    eventId: input.eventId,
  });
  if (eventRead.outcome === "cancelled") {
    return "cancelled";
  }
  const event = eventRead.event;
  if (event === undefined) {
    return "pending";
  }

  const conference = readyMeetingConferenceOutcome({ event, joinUrl: input.joinUrl });
  if (conference.etag === undefined) {
    return conference.outcome;
  }

  const description = patchReadyMeetCalendarDescription(event.description, input);
  if (description === event.description) {
    return "done";
  }

  return patchGoogleCalendarDescription({
    accessToken: input.accessToken,
    calendarId: input.calendarId,
    eventId: input.eventId,
    etag: conference.etag,
    description,
  });
}

function activeCallInDetails(callIn: Awaited<ReturnType<RepositoryPort["getMeetingLinkCallIn"]>>) {
  if (callIn?.status !== "active" || callIn.sipDispatchRuleId === null || callIn.sipDispatchRuleId === "") {
    return null;
  }

  return { phoneNumber: callIn.phoneNumber, pin: callIn.pin };
}
