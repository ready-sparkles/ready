import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  type CalendarProvider,
  type MeetingInviteSuggestion,
  meetingInviteSuggestionsQuerySchema,
  meetingInviteSuggestionsResponseSchema,
  sendMeetingInvitesRequestSchema,
  sendMeetingInvitesResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  buildReadyMeetingJoinUrl,
  type CalendarTokenSet,
  hasGoogleCalendarPhotoScopes,
  hasOutlookPeopleScope,
  isCalendarProviderAuthError,
  listCalendarInviteContacts,
  refreshCalendarToken,
  shouldRefreshCalendarToken,
} from "../../../../../application/calendar-client";
import { isResendConfigured, sendResendEmail } from "../../../../../application/resend-client";
import { apiEnv } from "../../../../../composition/env";
import { buildMeetingInviteEmail } from "../../../../../domain/meeting-invite-email";
import { repositories } from "../../../../../ports/repository-runtime";
import {
  decryptStoredJsonSecret,
  encryptJsonSecret,
  isStoredJsonObject,
} from "../../../../secondary/node/secret-crypto";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";

const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;

const INVITE_SUGGESTIONS_RATE_LIMIT_MAX = 60;
const INVITE_SUGGESTIONS_MERGE_LIMIT = 60;
const CALENDAR_CONTACTS_FETCH_LIMIT = 50;
const MEETING_INVITATIONS_RATE_LIMIT_MAX = 5;

const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_CALENDAR_NO_CREDENTIALS = "Calendar connector has no stored credentials";
const MESSAGE_UNEXPECTED_INVITE_CONNECTOR_PROVIDER = "Unexpected calendar connector provider for invite suggestions.";
const MESSAGE_INVALID_EMAIL = "Enter at least one valid email address.";
const MESSAGE_MEETING_ENDED = "This meeting has ended.";
const MESSAGE_MEETING_LINK_INACTIVE = "This meeting link is no longer active.";
const MESSAGE_EMAIL_NOT_CONFIGURED = "Email sending is not configured. Contact your Ready administrator.";
const LOG_MEETING_INVITE_CONTACTS_FAILED = "Meeting invite contacts could not be loaded";
const LOG_RESEND_NOT_CONFIGURED = "RESEND_API_KEY is not configured; live meeting invitations cannot be emailed.";
const LOG_INVITATION_EMAIL_FAILED = "Live meeting invitation email failed";

type CalendarConnector = Awaited<ReturnType<RepositoryPort["listAgentConnectorsForUser"]>>[number];

type MeetingInvitationBatchResult = {
  sent: string[];
  failures: { email: string; reason: "send_failed" }[];
};

type ConnectorInviteContactsResult = {
  provider: CalendarProvider;
  contacts: MeetingInviteSuggestion[];
  isConnected: boolean;
  isReconnectRequired: boolean;
};

function isConnectedCalendarConnector(connector: CalendarConnector) {
  return (
    (connector.provider === "google_calendar" || connector.provider === "outlook_calendar") &&
    connector.status === "connected"
  );
}

function calendarProviderFromConnector(connector: CalendarConnector): CalendarProvider | null {
  if (connector.provider === "google_calendar" || connector.provider === "outlook_calendar") {
    return connector.provider;
  }

  return null;
}

function hasInviteContactPermission(tokens: CalendarTokenSet) {
  return tokens.provider === "google_calendar" ? hasGoogleCalendarPhotoScopes(tokens) : hasOutlookPeopleScope(tokens);
}

async function getUsableCalendarTokens(input: { connector: CalendarConnector; userId: string }) {
  const secret = await repositories().getLatestAgentConnectorSecret(input.connector.id);
  if (!secret) {
    throw new Error(MESSAGE_CALENDAR_NO_CREDENTIALS);
  }
  const storedTokens = decryptStoredJsonSecret({
    secretRef: secret.secretRef,
    schema: z.custom<CalendarTokenSet>(isStoredJsonObject),
  });
  if (!shouldRefreshCalendarToken(storedTokens)) {
    return storedTokens;
  }

  const tokens = await refreshCalendarToken(storedTokens);
  await repositories().upsertAgentConnector({
    userId: input.userId,
    agentProfileId: input.connector.agentProfileId,
    provider: input.connector.provider,
    providerAccountId: input.connector.providerAccountId,
    providerEmail: input.connector.providerEmail,
    providerTenantId: input.connector.providerTenantId,
    status: "connected",
    scope: "private",
    externalAccountEmail: input.connector.externalAccountEmail,
    scopes: tokens.scope.split(/[,\s]+/).filter(Boolean),
    accountKind: input.connector.accountKind === "personal" ? "personal" : "work",
    secretRef: encryptJsonSecret(tokens),
  });

  return tokens;
}

function uniqueProviders(providers: CalendarProvider[]) {
  return Array.from(new Set(providers));
}

function mergeInviteSuggestions(input: {
  contacts: MeetingInviteSuggestion[][];
  requestingUserEmail: string;
  limit: number;
}) {
  const seen = new Set([input.requestingUserEmail.trim().toLowerCase()]);

  return input.contacts.reduce<MeetingInviteSuggestion[]>((collected, providerContacts) => {
    if (collected.length >= input.limit) {
      return collected;
    }

    return providerContacts.reduce((suggestions, contact) => {
      if (suggestions.length >= input.limit || seen.has(contact.email)) {
        return suggestions;
      }
      seen.add(contact.email);

      return [...suggestions, contact];
    }, collected);
  }, []);
}

function sortInviteProviderResults(results: ConnectorInviteContactsResult[]) {
  return [...results].sort((left, right) =>
    left.provider === right.provider ? 0 : left.provider === "outlook_calendar" ? -1 : 1,
  );
}

async function loadConnectorInviteContacts(input: {
  connector: CalendarConnector;
  provider: CalendarProvider;
  userId: string;
  query: string | undefined;
  log: FastifyRequest["log"];
}): Promise<ConnectorInviteContactsResult> {
  const { provider } = input;

  try {
    const tokens = await getUsableCalendarTokens({ connector: input.connector, userId: input.userId });
    if (!hasInviteContactPermission(tokens)) {
      return { provider, contacts: [], isConnected: false, isReconnectRequired: true };
    }
    const contacts = await listCalendarInviteContacts(tokens, {
      query: input.query,
      limit: CALENDAR_CONTACTS_FETCH_LIMIT,
      requestingUserId: input.userId,
    });

    return { provider, contacts, isConnected: true, isReconnectRequired: false };
  } catch (error) {
    const isReconnectRequired = isCalendarProviderAuthError(error);
    input.log.warn({ error, provider, connectorId: input.connector.id }, LOG_MEETING_INVITE_CONTACTS_FAILED);

    return { provider, contacts: [], isConnected: false, isReconnectRequired };
  }
}

function logMeetingInvitationEmailFailure(input: {
  request: FastifyRequest;
  meetingId: string;
  error: unknown;
  recipient: string;
}) {
  input.request.log.error(
    { error: input.error, meetingId: input.meetingId, recipient: input.recipient },
    LOG_INVITATION_EMAIL_FAILED,
  );
}

async function handleMeetingInviteSuggestions(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { request, reply } = input;
  const user = request.user;
  if (!user) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
  }
  const parsed = meetingInviteSuggestionsQuerySchema.safeParse(request.query ?? {});
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }

  const connectors = (await repositories().listAgentConnectorsForUser(user.id)).filter(isConnectedCalendarConnector);
  const results = await Promise.all(
    connectors.map((connector) => {
      const provider = calendarProviderFromConnector(connector);
      if (provider === null) {
        throw new Error(MESSAGE_UNEXPECTED_INVITE_CONNECTOR_PROVIDER);
      }

      return loadConnectorInviteContacts({
        connector,
        provider,
        userId: user.id,
        query: parsed.data.q,
        log: request.log,
      });
    }),
  );

  const sortedResults = sortInviteProviderResults(results);
  const connectedProviders = sortedResults.filter((result) => result.isConnected).map((result) => result.provider);
  const reconnectRequiredProviders = sortedResults
    .filter((result) => result.isReconnectRequired)
    .map((result) => result.provider);

  return meetingInviteSuggestionsResponseSchema.parse({
    suggestions: mergeInviteSuggestions({
      contacts: sortedResults.map((result) => result.contacts),
      requestingUserEmail: user.email,
      limit: INVITE_SUGGESTIONS_MERGE_LIMIT,
    }),
    connectedProviders: uniqueProviders(connectedProviders),
    reconnectRequiredProviders: uniqueProviders(reconnectRequiredProviders),
  });
}

async function handleSendMeetingInvitations(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { request, reply } = input;
  const user = request.user;
  if (!user) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
  }
  const parsed = sendMeetingInvitesRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_EMAIL });
  }

  const { meeting } = getMeetingAccess(request);
  if (meeting.status === "ended") {
    return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_ENDED });
  }
  const meetingLink = await repositories().getMeetingLinkForMeeting(meeting.id);
  if (!meetingLink || meetingLink.status !== "active") {
    return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_MEETING_LINK_INACTIVE });
  }
  if (!isResendConfigured() && apiEnv.NODE_ENV === "production") {
    request.log.error(LOG_RESEND_NOT_CONFIGURED);

    return reply.code(HTTP_SERVICE_UNAVAILABLE).send({ message: MESSAGE_EMAIL_NOT_CONFIGURED });
  }

  const callInRecord = await repositories().getMeetingLinkCallIn(meetingLink.id);
  const callIn =
    callInRecord?.status === "active" ? { phoneNumber: callInRecord.phoneNumber, pin: callInRecord.pin } : null;
  const email = buildMeetingInviteEmail({
    inviterName: user.displayName,
    inviterEmail: user.email,
    meetingTitle: meeting.title,
    joinUrl: buildReadyMeetingJoinUrl(meetingLink.code),
    callIn,
  });

  const result = await sendMeetingInvitationBatch({
    recipients: parsed.data.emails,
    message: email,
    onFailure: ({ error, recipient }) => {
      logMeetingInvitationEmailFailure({
        request,
        meetingId: meeting.id,
        error,
        recipient,
      });
    },
  });

  return sendMeetingInvitesResponseSchema.parse(result);
}

export async function sendMeetingInvitationBatch(input: {
  recipients: string[];
  message: { subject: string; html: string; text: string };
  sendEmail?: typeof sendResendEmail;
  onFailure?: (failure: { error: unknown; recipient: string }) => void;
}): Promise<MeetingInvitationBatchResult> {
  const sendEmail = input.sendEmail ?? sendResendEmail;

  return input.recipients.reduce<Promise<MeetingInvitationBatchResult>>(
    async (previous, recipient) => {
      const state = await previous;
      try {
        await sendEmail({
          to: recipient,
          subject: input.message.subject,
          html: input.message.html,
          text: input.message.text,
        });

        return { sent: [...state.sent, recipient], failures: state.failures };
      } catch (error) {
        input.onFailure?.({ error, recipient });

        return {
          sent: state.sent,
          failures: [...state.failures, { email: recipient, reason: "send_failed" }],
        };
      }
    },
    Promise.resolve({ sent: [], failures: [] }),
  );
}

export async function meetingInviteRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/meetings/:meetingId/invite-suggestions",
    {
      preHandler: requireMeetingAccess("participant"),
      config: { rateLimit: { max: INVITE_SUGGESTIONS_RATE_LIMIT_MAX, timeWindow: "1 minute" } },
    },
    async (request, reply) => handleMeetingInviteSuggestions({ request, reply }),
  );

  app.post(
    "/meetings/:meetingId/invitations",
    {
      preHandler: requireMeetingAccess("participant"),
      config: { rateLimit: { max: MEETING_INVITATIONS_RATE_LIMIT_MAX, timeWindow: "1 minute" } },
    },
    async (request, reply) => handleSendMeetingInvitations({ request, reply }),
  );
}
