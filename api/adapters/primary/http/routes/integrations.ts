import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  addReadyMeetingToCalendarEventParamsSchema,
  addReadyMeetingToCalendarEventRequestSchema,
  addReadyMeetingToCalendarEventResponseSchema,
  calendarAccountsResponseSchema,
  calendarConnectRequestSchema,
  calendarConnectResponseSchema,
  calendarDisconnectRequestSchema,
  calendarDisconnectResponseSchema,
  calendarEventPrepEstimateRequestSchema,
  calendarEventPrepEstimateResponseSchema,
  type CalendarEventPrepProcessor,
  calendarEventPrepProcessorSchema,
  calendarEventPrepRequestSchema,
  type CalendarEventPrepResponse,
  calendarEventPrepResponseSchema,
  calendarEventsQuerySchema,
  calendarEventsResponseSchema,
  type CalendarProvider,
  type CalendarReadyMeeting,
  deleteCalendarEventParamsSchema,
  deleteCalendarEventQuerySchema,
  deleteCalendarEventResponseSchema,
  deleteProviderDataRequestSchema,
  linearConnectRequestSchema,
  linearConnectResponseSchema,
  linearDisconnectResponseSchema,
  type NormalizedCalendarEvent,
  providerDataDeletionResponseSchema,
  updateCalendarAccountRequestSchema,
  updateCalendarAccountResponseSchema,
} from "@readymeet/shared";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  buildCalendarAuthorizationUrl,
  buildReadyMeetingJoinUrl,
  type CalendarAccountProfile,
  type CalendarProviderAuthError,
  type CalendarTokenSet,
  deleteGoogleCalendarEvent,
  exchangeCalendarCode,
  extractReadyMeetingCodeFromUrl,
  getCalendarAccountProfile,
  getGoogleCalendarEvent,
  hasGoogleCalendarEventsScope,
  hasGoogleCalendarPhotoScopes,
  isCalendarProviderAuthError,
  listCalendarEvents,
  normalizeGoogleCalendarEvent,
  patchGoogleCalendarEventWithReadyMeeting,
  providerEventKeyFromIds,
  refreshCalendarToken,
  shouldRefreshCalendarToken,
  watchGoogleCalendarEvents,
  watchOutlookCalendarEvents,
} from "../../../../application/calendar-client";
import { addReadyMeetCalendarAvatarFallbacks } from "../../../../application/calendar-event-avatars";
import {
  buildCalendarPrepParallelRuns,
  buildCalendarPrepProgress,
  buildCalendarPrepTargetPlan,
  buildCompanyLatestSearchRequest,
  buildCompletedPrepProgress,
  buildInitialPrepResult,
  buildPendingPrepProgress,
  calendarPrepProcessorsForMode,
  type CalendarPrepStartMode,
  type CalendarPrepTargetPlan,
  failedPrepResult,
  normalizeParallelPrepResults,
  normalizeParallelRunProgress,
  parallelClientFromEnv,
  responseFromPrepRow,
  runRefsFromStored,
  sanitizeCompanyLatestSearchResponse,
} from "../../../../application/calendar-meeting-prep";
import {
  type PendingGoogleAddonCalendarCredentials,
  readPendingGoogleAddonCalendarCredentials,
  restoreCalendarRefreshToken,
  revokeStoredGoogleCalendarCredentials,
} from "../../../../application/calendar-oauth-credentials";
import {
  CalendarPrepCreditsRequiredError,
  CalendarPrepPlanRequiredError,
  getCalendarPrepAccessForUser,
  shouldRequireCalendarPrepGrantCredits,
} from "../../../../application/calendar-prep-access";
import {
  calendarPrepBillingTerms,
  calendarPrepCreditQuote,
  calendarPrepParallelCostMicroUsd,
  calendarPrepProcessorEstimateOptions,
} from "../../../../application/calendar-prep-pricing";
import {
  buildMeetingBriefPrivateContext,
  generateMeetingPrivateBrief,
  type MeetingBriefIdentityHint,
  type MeetingPrivateBrief,
  OpenAIMeetingPrivateBriefRunner,
} from "../../../../application/calendar-private-brief";
import { getCalendarReadyMeetingError } from "../../../../application/calendar-ready-meeting-errors";
import { googleAddonCalendarCredentialStorage } from "../../../../application/google-addon-calendar-storage";
import {
  buildLinearAuthorizationUrl,
  exchangeLinearCode,
  getLinearViewer,
} from "../../../../application/linear-client";
import {
  CALENDAR_EVENT_CALL_IN_WAIT_MS,
  type MeetingLinkCallInDTOInput,
  waitForSyncedCallInForMeeting,
} from "../../../../application/meeting-dto";
import { executeMemberResponse, isPlanCreditDenial } from "../../../../application/metered-provider";
import { apiEnv } from "../../../../composition/env";
import { generateUniqueMeetingLinkCode } from "../../../../composition/meeting-link-codes";
import { calendarSyncSubscriptionAction, resolveCalendarWebhookAddress } from "../../../../domain/calendar-webhooks";
import { repositories } from "../../../../ports/repository-runtime";
import {
  decryptJsonSecret,
  decryptStoredJsonSecret,
  encryptJsonSecret,
  isStoredJsonObject,
} from "../../../secondary/node/secret-crypto";
import { requireAuth } from "../plugins/auth";
import { signOAuthState, verifyOAuthState } from "../support/auth";
import { getMeetingHostingAccessForUser } from "../support/meeting-access";

type LinearOAuthState = {
  sub: string;
  email: string;
  displayName: string;
  returnTo?: string;
};

type CalendarOAuthState = LinearOAuthState & {
  provider: CalendarProvider;
  /** @external calendar oauth recovering offline access wire field */
  recoveringOfflineAccess?: boolean;
  accountKind?: "personal" | "work";
  meetingId?: string;
};

const HTTP_ACCEPTED = 202;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const MESSAGE_ADD_CREDITS_TO_RUN_MEETING_PREP = "Add credits to run meeting prep.";
const MESSAGE_MEETING_PREP_CREDITS_COULD_NOT_BE_CHARGED = "Meeting prep credits could not be charged.";
const MESSAGE_PARALLEL_IS_NOT_CONFIGURED_FOR_MEETING_PREP = "Parallel is not configured for meeting prep.";
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_MISSING_LINEAR_OAUTH_CODE_OR_STATE = "Missing Linear OAuth code or state";
const MESSAGE_UNSUPPORTED_CALENDAR_PROVIDER = "Unsupported calendar provider";
const MESSAGE_MISSING_CALENDAR_OAUTH_CODE_OR_STATE = "Missing calendar OAuth code or state";
const MESSAGE_CALENDAR_OAUTH_PROVIDER_MISMATCH = "Calendar OAuth provider mismatch";
const MESSAGE_CALENDAR_ACCOUNT_NOT_FOUND = "Calendar account not found";
const MESSAGE_CONFIRMATION_EMAIL_DOES_NOT_MATCH_THIS_CALENDAR_ACCOUNT =
  "Confirmation email does not match this calendar account.";
const MESSAGE_CALENDAR_ACCOUNT_IS_NOT_CONNECTED = "Calendar account is not connected.";
const MESSAGE_CALENDAR_EVENT_DELETION_IS_CURRENTLY_AVAILABLE_FOR_GOOGLE_CALENDAR_ =
  "Calendar event deletion is currently available for Google Calendar events only.";
const MESSAGE_GOOGLE_CALENDAR_NEEDS_TO_BE_RECONNECTED_BEFORE_DELETING_EVENTS =
  "Google Calendar needs to be reconnected before deleting events.";
const MESSAGE_COULD_NOT_DELETE_THE_CALENDAR_EVENT_FROM_GOOGLE_CALENDAR =
  "Could not delete the calendar event from Google Calendar.";
const MESSAGE_THIS_CALENDAR_ACCOUNT_IS_NO_LONGER_CONNECTED_TO_READY_RECONNECT_GOO =
  "This calendar account is no longer connected to Ready. Reconnect Google Calendar and try again.";
const MESSAGE_RECONNECT_GOOGLE_CALENDAR_BEFORE_ADDING_A_VIDEO_CALL =
  "Reconnect Google Calendar before adding a video call.";
const MESSAGE_ADDING_A_VIDEO_CALL_FROM_READY_IS_CURRENTLY_SUPPORTED_FOR_GOOGLE_CA =
  "Adding a video call from Ready is currently supported for Google Calendar only.";
const MESSAGE_GOOGLE_CALENDAR_WRITE_PERMISSION_IS_REQUIRED_TO_ADD_READY_MEETING_C =
  "Google Calendar write permission is required to add Ready Meeting conferencing.";
const MESSAGE_GOOGLE_CALENDAR_DID_NOT_ALLOW_THIS_EVENT_TO_BE_EDITED_ASK_THE_ORGAN =
  "Google Calendar did not allow this event to be edited. Ask the organizer to add the video link.";
const MESSAGE_READY_MEETING_LINK_FOR_THIS_CALENDAR_EVENT_IS_UNAVAILABLE =
  "Ready meeting link for this calendar event is unavailable.";
const MESSAGE_MEETING_ACCESS_IS_REQUIRED_TO_CREATE_MORE_MEETING_ROOMS =
  "Meeting access is required to create more meeting rooms.";
const MESSAGE_FAILED_TO_ESTIMATE_MEETING_PREP = "Failed to estimate meeting prep.";
const MESSAGE_FAILED_TO_START_MEETING_PREP = "Failed to start meeting prep.";
const MESSAGE_MISSING_PREP_ID = "Missing prep id";
const MESSAGE_MEETING_PREP_NOT_FOUND = "Meeting prep not found";
const MESSAGE_UNABLE_TO_START_LINEAR_OAUTH = "Unable to start Linear OAuth";
const MESSAGE_UNABLE_TO_START_CALENDAR_OAUTH = "Unable to start calendar OAuth";
const MESSAGE_GOOGLE_CALENDAR_DID_NOT_GRANT_OFFLINE_ACCESS = "Google Calendar did not grant offline access";
const CALENDAR_PREP_CREDITS_REQUIRED_CODE = "calendar_prep_credits_required";
const CREDIT_CHARGE_FAILED_CODE = "credit_charge_failed";
const PARALLEL_NOT_CONFIGURED_CODE = "parallel_not_configured";
const PARALLEL_START_FAILED_CODE = "parallel_start_failed";
const MILLISECONDS_PER_MINUTE = 60_000;
const MEETING_BRIEF_CONTEXT_CANDIDATE_LIMIT = 16;

const linearOAuthStateSchema = z.object({
  sub: z.string(),
  email: z.string(),
  displayName: z.string(),
  returnTo: z.string().optional(),
});

const calendarOAuthStateSchema = linearOAuthStateSchema.extend({
  provider: calendarConnectRequestSchema.shape.provider,
  /** @external calendar oauth recovering offline access wire field */
  recoveringOfflineAccess: z.boolean().optional(),
  accountKind: z.enum(["personal", "work"]).optional(),
  meetingId: z.string().optional(),
});

const oauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

const calendarProviderParamsSchema = z.object({
  provider: z.string(),
});

const calendarAccountIdParamsSchema = z.object({
  accountId: z.string().uuid(),
});

const calendarPrepIdParamsSchema = z.object({
  prepId: z.string().min(1),
});

const outlookCalendarWebhookQuerySchema = z.object({
  validationToken: z.string().optional(),
});

const outlookCalendarWebhookNotificationSchema = z.object({
  subscriptionId: z.unknown().optional(),
  clientState: z.unknown().optional(),
  changeType: z.unknown().optional(),
  resource: z.unknown().optional(),
  resourceData: z
    .object({
      id: z.unknown().optional(),
    })
    .optional(),
});

const outlookCalendarWebhookBodySchema = z.object({
  value: z.array(outlookCalendarWebhookNotificationSchema).optional(),
});

const CALENDAR_EVENTS_DEFAULT_RANGE_DAYS = 30;
const MESSAGE_GOOGLE_CALENDAR_CONNECTION_EXPIRED_OR_REVOKED =
  "Your Google Calendar connection has expired or access was revoked. Reconnect Google Calendar and try again.";
const CODE_CALENDAR_ACCOUNT_NOT_FOUND = "calendar_account_not_found";
const CODE_CALENDAR_ACCOUNT_DISCONNECTED = "calendar_account_disconnected";
const CODE_CALENDAR_PROVIDER_UNSUPPORTED = "calendar_provider_unsupported";
const CODE_CALENDAR_EVENT_NOT_EDITABLE = "calendar_event_not_editable";
const CODE_CALENDAR_RECONNECT_REQUIRED = "calendar_reconnect_required";
const CODE_MEETING_PLAN_REQUIRED = "meeting_plan_required";
const MESSAGE_OUTLOOK_CALENDAR_SUBSCRIPTION_MISSING_ID = "Outlook Calendar subscription response did not include an id";
const MESSAGE_CALENDAR_CONNECTOR_MISSING_CREDENTIALS = "Calendar connector has no stored credentials";
const MESSAGE_INVALID_OUTLOOK_WEBHOOK_JSON = "Invalid Outlook webhook JSON";
const MESSAGE_CALENDAR_WEBHOOK_SYNC_SKIPPED_HTTPS_BASE_URL =
  "Calendar webhook sync skipped because CALENDAR_WEBHOOK_BASE_URL is not configured with HTTPS";
const MESSAGE_CALENDAR_WEBHOOK_ADDRESS_CHANGED_RECREATING_SYNC =
  "Calendar webhook address changed; recreating sync subscription";
const MESSAGE_FAILED_TO_ESTABLISH_CALENDAR_WEBHOOK_SYNC = "Failed to establish calendar webhook sync";

const calendarPrepStoredResultSchema = z.object({
  brief: z
    .object({
      status: z.string(),
    })
    .passthrough()
    .optional(),
});

const CONSUMER_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);

const CALENDAR_SYNC_CALENDAR_ID = "primary";
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const CALENDAR_SYNC_RENEWAL_HOURS = 12;
const CALENDAR_WATCH_TTL_DAYS = 6;
const CALENDAR_SYNC_RENEW_WITHIN_MS =
  CALENDAR_SYNC_RENEWAL_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const GOOGLE_CALENDAR_WATCH_TTL_MS =
  CALENDAR_WATCH_TTL_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const OUTLOOK_CALENDAR_SUBSCRIPTION_TTL_MS =
  CALENDAR_WATCH_TTL_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

const CALENDAR_WRITE_SCOPE_REQUIRED_CODE = "calendar_write_scope_required";

type CalendarPrepLogger = Pick<FastifyBaseLogger, "debug" | "info" | "warn">;

type CalendarConnector = Awaited<ReturnType<RepositoryPort["listAgentConnectorsForUser"]>>[number];
type AgentConnectorRow = CalendarConnector;

const calendarConnectorProviderSchema = z.enum(["google_calendar", "outlook_calendar"]);

type CalendarReadyLinkMappingRow = Awaited<
  ReturnType<RepositoryPort["listCalendarReadyLinkMappingsForProviderEvents"]>
>[number];

function calendarStableEventId(input: { provider: CalendarProvider; calendarId: string; providerEventId: string }) {
  return `${input.provider}:${input.calendarId}:${input.providerEventId}`;
}

function activeCallInDTO(callIn: MeetingLinkCallInDTOInput | null | undefined) {
  return callIn?.status === "active"
    ? {
        phoneNumber: callIn.phoneNumber,
        pin: callIn.pin,
      }
    : null;
}

function readyMeetingFromMeetingLink(input: {
  source: CalendarReadyMeeting["source"];
  meetingLink: CalendarReadyLinkMappingRow["meetingLink"];
  callIn?: MeetingLinkCallInDTOInput | null;
}): CalendarReadyMeeting {
  return {
    source: input.source,
    meetingLinkId: input.meetingLink.id,
    code: input.meetingLink.code,
    joinUrl: buildReadyMeetingJoinUrl(input.meetingLink.code),
    callIn: activeCallInDTO(input.callIn),
  };
}

async function readyMeetingFromMeetingLinkWithCurrentCallIn(input: {
  source: CalendarReadyMeeting["source"];
  meetingLink: CalendarReadyLinkMappingRow["meetingLink"];
  callIn?: CalendarReadyLinkMappingRow["callIn"] | null;
  callInDeadline?: number;
  logger: Parameters<typeof waitForSyncedCallInForMeeting>[0]["input"]["logger"];
}) {
  const callInState: { value: MeetingLinkCallInDTOInput | null } = { value: input.callIn ?? null };
  if (input.meetingLink.status === "active" && callInState.value?.status !== "active") {
    const currentMeeting = await repositories().getCurrentMeetingForLink(input.meetingLink.id);
    const hostingAccess = await getMeetingHostingAccessForUser(input.meetingLink.createdByUserId);
    const canResolveLink = currentMeeting
      ? hostingAccess.canHostStandardMeetings
      : hostingAccess.canCreateStandardMeeting;
    const resolved = canResolveLink
      ? currentMeeting
        ? { meeting: currentMeeting, meetingLink: input.meetingLink }
        : await repositories().resolveMeetingLink({ code: input.meetingLink.code })
      : null;
    if (resolved) {
      callInState.value = await waitForSyncedCallInForMeeting({
        input: {
          meeting: resolved.meeting,
          meetingLink: resolved.meetingLink,
          logger: input.logger,
        },
        timeoutMs: input.callInDeadline === undefined ? undefined : Math.max(0, input.callInDeadline - Date.now()),
      });
    }
  }

  return readyMeetingFromMeetingLink({
    source: input.source,
    meetingLink: input.meetingLink,
    callIn: callInState.value,
  });
}

async function createCalendarReadyLinkMappingIfMissing(input: {
  userId: string;
  calendarAccountId: string;
  provider: CalendarProvider;
  calendarId: string;
  providerEventKey: string;
  meetingLinkId: string;
}) {
  const existing = await repositories().getCalendarReadyLinkForProviderEvent({
    userId: input.userId,
    calendarAccountId: input.calendarAccountId,
    provider: input.provider,
    calendarId: input.calendarId,
    providerEventId: input.providerEventKey,
  });
  if (existing) {
    return existing;
  }

  try {
    return await repositories().createCalendarReadyLinkMapping({
      userId: input.userId,
      calendarAccountId: input.calendarAccountId,
      provider: input.provider,
      calendarId: input.calendarId,
      providerEventId: input.providerEventKey,
      meetingLinkId: input.meetingLinkId,
    });
  } catch (error) {
    const raced = await repositories().getCalendarReadyLinkForProviderEvent({
      userId: input.userId,
      calendarAccountId: input.calendarAccountId,
      provider: input.provider,
      calendarId: input.calendarId,
      providerEventId: input.providerEventKey,
    });
    if (raced) {
      return raced;
    }
    throw error;
  }
}

async function reconcileProviderReadyMeeting(input: {
  event: NormalizedCalendarEvent;
  userId: string;
  workspaceId?: string | null;
  calendarAccountId: string;
  logger: Parameters<typeof waitForSyncedCallInForMeeting>[0]["input"]["logger"];
}) {
  const detected = input.event.readyMeeting;
  if (detected === undefined || detected === null) {
    return null;
  }
  const joinUrl = detected.joinUrl;
  if (joinUrl.length === 0) {
    return null;
  }
  const code = extractReadyMeetingCodeFromUrl(joinUrl);
  if (code === null || code.length === 0) {
    return detected;
  }

  const meetingLink = await repositories().getMeetingLinkByCode(code);
  if (!meetingLink || meetingLink.workspaceId !== input.workspaceId) {
    return detected;
  }

  try {
    await createCalendarReadyLinkMappingIfMissing({
      userId: input.userId,
      calendarAccountId: input.calendarAccountId,
      provider: input.event.provider,
      calendarId: input.event.calendarId,
      providerEventKey: input.event.providerEventKey ?? input.event.providerEventId,
      meetingLinkId: meetingLink.id,
    });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return detected;
  }
  const callIn = await repositories().getMeetingLinkCallIn(meetingLink.id);

  return readyMeetingFromMeetingLink({
    source: "provider_event",
    meetingLink,
    callIn,
  });
}

export async function decorateCalendarEventsWithReadyMeetings(input: {
  events: NormalizedCalendarEvent[];
  connector: CalendarConnector;
  tokens: CalendarTokenSet;
  userId: string;
  workspaceId?: string | null;
  logger: Parameters<typeof waitForSyncedCallInForMeeting>[0]["input"]["logger"];
  dependencies?: {
    listMappings: RepositoryPort["listCalendarReadyLinkMappingsForProviderEvents"];
    reconcile: typeof reconcileProviderReadyMeeting;
  };
}): Promise<NormalizedCalendarEvent[]> {
  const dependencies = input.dependencies ?? {
    listMappings: repositories().listCalendarReadyLinkMappingsForProviderEvents,
    reconcile: reconcileProviderReadyMeeting,
  };
  const events = input.events.map((event) => {
    const providerEventKey =
      event.providerEventKey ??
      providerEventKeyFromIds({
        providerEventId: event.providerEventId,
        providerRecurringEventId: event.providerRecurringEventId,
      });

    return {
      ...event,
      calendarAccountId: input.connector.id,
      providerEventKey,
      /** @external normalized calendar event needs write consent wire field */
      needsCalendarWriteConsent:
        input.tokens.provider === "google_calendar" ? !hasGoogleCalendarEventsScope(input.tokens) : false,
    };
  });

  // Only Google supports Ready's event-writing/mapping flow. Outlook already
  // carries provider-derived Ready details; listing it must not create unused
  // mappings or wait for call-in provisioning for every event on each refresh.
  if (input.connector.provider !== "google_calendar") {
    return events;
  }

  const keys = events.map((event) => event.providerEventKey);
  const mappings = await dependencies.listMappings({
    userId: input.userId,
    calendarAccountId: input.connector.id,
    provider: input.connector.provider,
    calendarId: CALENDAR_SYNC_CALENDAR_ID,
    providerEventKeys: keys,
  });
  const mappingByEventKey = new Map(
    mappings.map((mapping) => [mapping.calendarReadyLink.providerEventId, mapping] as const),
  );

  return events.reduce<Promise<NormalizedCalendarEvent[]>>(async (previous, event) => {
    const accumulated = await previous;
    const providerEventKey = event.providerEventKey;
    const mappedReadyMeetingRow = mappingByEventKey.get(providerEventKey) ?? null;
    // Listing reads stored dial-in details; provisioning belongs to join/create flows.
    const mappedReadyMeeting = mappedReadyMeetingRow
      ? readyMeetingFromMeetingLink({
          source: "mapping",
          meetingLink: mappedReadyMeetingRow.meetingLink,
          callIn: mappedReadyMeetingRow.callIn,
        })
      : null;
    const providerReadyMeeting = mappedReadyMeeting
      ? null
      : await dependencies.reconcile({
          event,
          userId: input.userId,
          workspaceId: input.workspaceId,
          calendarAccountId: input.connector.id,
          logger: input.logger,
        });
    const readyMeeting = mappedReadyMeeting ?? providerReadyMeeting ?? event.readyMeeting ?? null;

    return [
      ...accumulated,
      {
        ...event,
        readyMeeting,
        canAddReadyMeeting: Boolean(event.canAddReadyMeeting) && !readyMeeting,
      },
    ];
  }, Promise.resolve([]));
}

function resultPayloadFromPrepResponse(response: CalendarEventPrepResponse) {
  const payload = { ...response };
  delete (payload as Partial<CalendarEventPrepResponse>).prepId;

  return payload;
}

function parseCalendarPrepProcessor(value: unknown) {
  const parsed = calendarEventPrepProcessorSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

function calendarPrepProcessorsForSelected(input: {
  selectedProcessor: CalendarEventPrepProcessor | null;
  mode: CalendarPrepStartMode;
}) {
  if (input.selectedProcessor !== null) {
    return { peopleProcessor: input.selectedProcessor, companyProcessor: input.selectedProcessor };
  }

  return calendarPrepProcessorsForMode(input.mode);
}

function optionalCalendarPrepProcessorField(
  selectedProcessor: CalendarEventPrepProcessor | null,
): Record<string, string> {
  return selectedProcessor !== null ? { processor: selectedProcessor } : {};
}

type CalendarSyncSubscriptionLogger = {
  debug?: (input: { bindings: Record<string, unknown>; message: string }) => void;
  warn?: (input: { bindings: Record<string, unknown>; message: string }) => void;
};

function calendarSyncSubscriptionLoggerFromFastify(
  log: Pick<FastifyBaseLogger, "debug" | "warn"> | undefined,
): CalendarSyncSubscriptionLogger | undefined {
  if (log === undefined) {
    return undefined;
  }

  return {
    debug: (entry) => {
      log.debug(entry.bindings, entry.message);
    },
    warn: (entry) => {
      log.warn(entry.bindings, entry.message);
    },
  };
}

function isConnectedCalendarConnector(connector: CalendarConnector) {
  return (
    (connector.provider === "google_calendar" || connector.provider === "outlook_calendar") &&
    connector.status === "connected"
  );
}

async function listConnectedCalendarConnectorsForUser(userId: string) {
  return (await repositories().listAgentConnectorsForUser(userId)).filter(isConnectedCalendarConnector);
}

async function buildCalendarPrepEstimate(input: {
  user: { id: string; email: string; displayName: string };
  connectors: CalendarConnector[];
  event: NormalizedCalendarEvent;
}) {
  const targetPlan = buildCalendarPrepTargetPlan({
    event: input.event,
    userContext: calendarPrepUserContext({
      user: input.user,
      connectors: input.connectors,
    }),
  });
  const plannedRuns = buildCalendarPrepParallelRuns({
    event: input.event,
    plan: targetPlan,
    peopleProcessor: "core",
    companyProcessor: "core",
  });
  const peopleRunCount = plannedRuns.filter((run) => run.ref.kind === "people").length;
  const companyRunCount = plannedRuns.filter((run) => run.ref.kind === "company").length;
  const isCompanyVisible = Boolean(targetPlan.companyTarget);
  const advancedSearchRequestCount = isCompanyVisible ? 1 : 0;
  const options = await calendarPrepProcessorEstimateOptions({
    userId: input.user.id,
    taskRunCount: plannedRuns.length,
    advancedSearchRequestCount,
  });

  return calendarEventPrepEstimateResponseSchema.parse({
    plan: {
      totalRuns: plannedRuns.length,
      peopleRunCount,
      companyRunCount,
      externalParticipantCount: targetPlan.externalParticipants.length,
      peopleTargetCount: targetPlan.peopleTargets.length,
      /** @external calendar prep estimate company visible wire field */
      /** @external calendar prep company visible wire field */
      companyVisible: isCompanyVisible,
      advancedSearchRequestCount,
    },
    options,
  });
}

async function ensureCalendarPrepResearchCreditsAvailable(input: {
  userId: string;
  processor: CalendarEventPrepProcessor;
  taskRunCount: number;
  advancedSearchRequestCount: number;
  shouldRequireAvailableCredits: boolean;
}) {
  const terms = await calendarPrepBillingTerms(input.userId);
  const estimate = calendarPrepCreditQuote({
    rawCostMicroUsd: calendarPrepParallelCostMicroUsd(input),
    plan: terms.plan,
    isIncluded: !input.shouldRequireAvailableCredits,
  });
  if (estimate.creditsCharged <= 0 || !input.shouldRequireAvailableCredits) {
    return estimate;
  }
  if (terms.workspacePlan !== "pro" && terms.workspacePlan !== "max") {
    throw new CalendarPrepCreditsRequiredError({
      requiredCredits: estimate.creditsCharged,
      availableCredits: 0,
    });
  }
  const workspaceAccess =
    terms.workspaceId === null
      ? null
      : await repositories().getWorkspaceMemberCreditAccess({
          userId: input.userId,
          workspaceId: terms.workspaceId,
        });
  const availableCredits = (workspaceAccess?.allowanceRemaining ?? 0) + (workspaceAccess?.poolBalance ?? 0);
  if (availableCredits < estimate.creditsCharged) {
    throw new CalendarPrepCreditsRequiredError({
      requiredCredits: estimate.creditsCharged,
      availableCredits,
    });
  }

  return estimate;
}

function failedCalendarPrepCreditsRequiredResult(input: {
  prepId: string;
  isCompanyVisible: boolean;
  progress: CalendarEventPrepResponse["progress"];
}) {
  return failedPrepResult({
    prepId: input.prepId,
    /** @external calendar prep company visible wire field */
    companyVisible: input.isCompanyVisible,
    code: CALENDAR_PREP_CREDITS_REQUIRED_CODE,
    message: MESSAGE_ADD_CREDITS_TO_RUN_MEETING_PREP,
    progress: input.progress ?? null,
  });
}

async function holdCalendarPrepResearchCredits(input: {
  userId: string;
  prepId: string;
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  processor: CalendarEventPrepProcessor;
  plannedRunCount: number;
  isCompanyVisible: boolean;
  shouldRequireAvailableCredits: boolean;
}) {
  const terms = await calendarPrepBillingTerms(input.userId);
  const advancedSearchRequestCount = input.isCompanyVisible ? 1 : 0;
  const rawCostMicroUsd = calendarPrepParallelCostMicroUsd({
    processor: input.processor,
    taskRunCount: input.plannedRunCount,
    advancedSearchRequestCount,
  });
  if (terms.workspaceId === null) {
    throw new Error(MESSAGE_MEETING_PREP_CREDITS_COULD_NOT_BE_CHARGED);
  }
  const reservation = await repositories().reservePlanCredits({
    workspaceId: terms.workspaceId,
    userId: input.userId,
    maximumCostMicroUsd: rawCostMicroUsd,
    isIncluded: !input.shouldRequireAvailableCredits,
    metadata: {
      prepId: input.prepId,
      calendarEventId: input.event.id,
      calendarAccountId: input.event.calendarAccountId ?? null,
      eventFingerprint: input.targetPlan.eventFingerprint,
      processor: input.processor,
      meetingContext: input.targetPlan.meetingContext,
      externalParticipantCount: input.targetPlan.externalParticipants.length,
      peopleTargetCount: input.targetPlan.peopleTargets.length,
      /** @external calendar prep company visible wire field */
      companyVisible: input.isCompanyVisible,
      companyDomain: input.targetPlan.companyTarget?.domain ?? null,
      plannedRunCount: input.plannedRunCount,
      advancedSearchRequestCount,
      parallelRawCostMicroUsd: rawCostMicroUsd,
    },
  });

  return { reservationId: reservation.id, workspaceId: terms.workspaceId, maximumCostMicroUsd: rawCostMicroUsd };
}

async function settleCalendarPrepResearchCredits(input: {
  reservationId: string;
  workspaceId: string;
  userId: string;
  processor: CalendarEventPrepProcessor;
  rawCostMicroUsd: number;
}) {
  await repositories().settlePlanCredits({
    reservationId: input.reservationId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: "parallel",
    model: input.processor,
    feature: "Meeting prep research",
    actionType: "meeting_prep",
    inputTokens: 0,
    outputTokens: 0,
    providerCostMicroUsd: input.rawCostMicroUsd,
  });
}

async function settleCalendarPrepResearchOrFail(input: {
  row: CalendarPrepResearchRow;
  hold: { reservationId: string; workspaceId: string };
  event: NormalizedCalendarEvent;
  processor: CalendarEventPrepProcessor;
  rawCostMicroUsd: number;
  isCompanyVisible: boolean;
  progress: CalendarEventPrepResponse["progress"];
  log?: CalendarPrepLogger;
}) {
  try {
    await settleCalendarPrepResearchCredits({
      reservationId: input.hold.reservationId,
      workspaceId: input.hold.workspaceId,
      userId: input.row.userId,
      processor: input.processor,
      rawCostMicroUsd: input.rawCostMicroUsd,
    });

    return true;
  } catch (error) {
    input.log?.warn(
      {
        error,
        prepId: input.row.id,
        calendarEventId: input.event.id,
      },
      "Failed to record meeting prep credit usage",
    );
    const failed = failedPrepResult({
      prepId: input.row.id,
      /** @external calendar prep company visible wire field */
      companyVisible: input.isCompanyVisible,
      code: CREDIT_CHARGE_FAILED_CODE,
      message: MESSAGE_MEETING_PREP_CREDITS_COULD_NOT_BE_CHARGED,
      progress: input.progress ?? null,
    });
    await repositories().updateCalendarEventPrep({
      id: input.row.id,
      status: "failed",
      result: resultPayloadFromPrepResponse(failed),
      error: failed.error ?? null,
    });

    return false;
  }
}

// Shared by explicit Calendar connection and the first Marketplace web sign-in.
// Both callers validate identity and offline credentials before reaching here.
export async function connectCalendarAccount(input: {
  userId: string;
  displayName: string;
  tokens: CalendarTokenSet;
  accountProfile: CalendarAccountProfile;
  accountKind?: "personal" | "work";
  log?: Parameters<typeof ensureCalendarSyncSubscription>[0]["log"];
}): Promise<Awaited<ReturnType<RepositoryPort["upsertAgentConnector"]>>> {
  const { tokens, accountProfile } = input;
  const accessCheckMin = new Date();
  const accessCheckMax = new Date(accessCheckMin.getTime() + MILLISECONDS_PER_MINUTE);
  await listCalendarEvents(tokens, {
    timeMin: accessCheckMin.toISOString(),
    timeMax: accessCheckMax.toISOString(),
    limit: 1,
    requestingUserId: input.userId,
  });
  const profile = await repositories().ensureDefaultAgentProfileForUser({
    userId: input.userId,
    displayName: input.displayName,
    voiceId: null,
    llmModel: null,
  });

  const connector = await repositories().upsertAgentConnector({
    userId: input.userId,
    agentProfileId: profile.id,
    provider: tokens.provider,
    providerAccountId: accountProfile.providerAccountId,
    providerEmail: accountProfile.email,
    providerTenantId: accountProfile.tenantId,
    status: "connected",
    scope: "private",
    externalAccountEmail: accountProfile.email,
    scopes: tokens.scope.split(/[,\s]+/).filter(Boolean),
    accountKind: input.accountKind ?? inferCalendarAccountKind(accountProfile.email),
    syncStatus: "idle",
    secretRef: encryptJsonSecret(tokens),
  });
  await ensureCalendarSyncSubscription({
    connector,
    userId: input.userId,
    tokens,
    log: input.log,
  });
  await repositories().publishCalendarRealtimeEvent({
    userId: input.userId,
    provider: tokens.provider,
    connectorId: connector.id,
    calendarId: CALENDAR_SYNC_CALENDAR_ID,
    resourceState: "connected",
    dedupeKey: `calendar:${input.userId}:${tokens.provider}:connected:${connector.updatedAt.toISOString()}`,
  });

  return connector;
}

function inferCalendarAccountKind(email: string | null | undefined): "personal" | "work" {
  const domain = email?.trim().toLowerCase().split("@")[1]?.trim();

  return domain !== undefined && domain.length > 0 && CONSUMER_EMAIL_DOMAINS.has(domain) ? "personal" : "work";
}

async function sampleCalendarPrepRunProgress(input: {
  client: NonNullable<ReturnType<typeof parallelClientFromEnv>>;
  prepId: string;
  runRefs: ReturnType<typeof runRefsFromStored>;
  log?: CalendarPrepLogger;
}) {
  const runProgresses = await Promise.all(
    input.runRefs.runs.map(async (runRef) => {
      try {
        const events = await input.client.retrieveRunEvents(runRef.runId);

        return normalizeParallelRunProgress(runRef.runId, events);
      } catch (error) {
        input.log?.warn(
          {
            error,
            prepId: input.prepId,
            runId: runRef.runId,
            runKind: runRef.kind,
          },
          "Failed to sample Parallel meeting prep run events",
        );

        return null;
      }
    }),
  );

  return runProgresses.filter((progress): progress is NonNullable<typeof progress> => Boolean(progress));
}

type RefreshCalendarPrepRow = NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByIdForUser"]>>>;

async function completeRefreshCalendarPrepWithoutTaskGroup(input: {
  row: RefreshCalendarPrepRow;
  runRefs: ReturnType<typeof runRefsFromStored>;
  previousBrief: CalendarEventPrepResponse["brief"];
  startedAt: string;
}) {
  const progress = buildCompletedPrepProgress({ runRefs: input.runRefs, startedAt: input.startedAt });
  const completed = calendarEventPrepResponseSchema.parse({
    prepId: input.row.id,
    ...buildInitialPrepResult({
      status: "completed",
      /** @external calendar prep company visible wire field */
      companyVisible: input.runRefs.companyVisible,
      progress,
      brief: input.previousBrief,
    }),
  });

  return repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "completed",
    result: resultPayloadFromPrepResponse(completed),
    error: null,
  });
}

async function failRefreshCalendarPrepMissingParallel(input: {
  row: RefreshCalendarPrepRow;
  runRefs: ReturnType<typeof runRefsFromStored>;
  previousProgress: CalendarEventPrepResponse["progress"];
}) {
  const failed = failedPrepResult({
    prepId: input.row.id,
    /** @external calendar prep company visible wire field */
    companyVisible: input.runRefs.companyVisible,
    code: PARALLEL_NOT_CONFIGURED_CODE,
    message: MESSAGE_PARALLEL_IS_NOT_CONFIGURED_FOR_MEETING_PREP,
    progress: input.previousProgress,
  });

  return repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "failed",
    result: resultPayloadFromPrepResponse(failed),
    error: failed.error ?? null,
  });
}

async function persistRefreshCalendarPrepRunningState(input: {
  row: RefreshCalendarPrepRow;
  runRefs: ReturnType<typeof runRefsFromStored>;
  progress: CalendarEventPrepResponse["progress"];
  previousBrief: CalendarEventPrepResponse["brief"];
}) {
  const running = calendarEventPrepResponseSchema.parse({
    prepId: input.row.id,
    ...buildInitialPrepResult({
      status: "running",
      /** @external calendar prep company visible wire field */
      companyVisible: input.runRefs.companyVisible,
      progress: input.progress,
      brief: input.previousBrief,
    }),
  });

  return repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "running",
    result: resultPayloadFromPrepResponse(running),
    error: null,
  });
}

async function completeRefreshCalendarPrepFromParallelRuns(input: {
  row: RefreshCalendarPrepRow;
  runRefs: ReturnType<typeof runRefsFromStored>;
  client: NonNullable<ReturnType<typeof parallelClientFromEnv>>;
  startedAt: string;
  previousBrief: CalendarEventPrepResponse["brief"];
  log?: CalendarPrepLogger;
}) {
  const results = await Promise.all(
    input.runRefs.runs.map(async (runRef) => {
      try {
        return await input.client.retrieveRunResult(runRef.runId);
      } catch (error) {
        input.log?.warn(
          {
            error,
            prepId: input.row.id,
            runId: runRef.runId,
            runKind: runRef.kind,
          },
          "Failed to retrieve Parallel meeting prep run result",
        );

        return null;
      }
    }),
  );
  const normalized = normalizeParallelPrepResults({
    prepId: input.row.id,
    runRefs: input.runRefs,
    results: results.filter((result): result is NonNullable<typeof result> => Boolean(result)),
    progress: buildCompletedPrepProgress({ runRefs: input.runRefs, startedAt: input.startedAt }),
    brief: input.previousBrief,
  });
  input.log?.info(
    {
      prepId: input.row.id,
      taskgroupId: input.runRefs.taskgroupId,
      resultCount: results.filter((result) => result !== null).length,
      peopleBulletCount: normalized.people.bullets.length,
      companyBulletCount: normalized.company?.bullets.length ?? 0,
    },
    "Parallel meeting prep completed",
  );

  return repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "completed",
    result: resultPayloadFromPrepResponse(normalized),
    error: null,
  });
}

async function refreshCalendarEventPrepWithParallelTaskGroup(input: {
  row: RefreshCalendarPrepRow;
  runRefs: ReturnType<typeof runRefsFromStored> & { taskgroupId: string };
  previousProgress: CalendarEventPrepResponse["progress"];
  previousBrief: CalendarEventPrepResponse["brief"];
  startedAt: string;
  log?: CalendarPrepLogger;
}) {
  const client = parallelClientFromEnv();
  if (!client) {
    return failRefreshCalendarPrepMissingParallel({
      row: input.row,
      runRefs: input.runRefs,
      previousProgress: input.previousProgress,
    });
  }

  const group = await client.retrieveTaskGroup(input.runRefs.taskgroupId);
  const runProgresses = await sampleCalendarPrepRunProgress({
    client,
    prepId: input.row.id,
    runRefs: input.runRefs,
    log: input.log,
  });
  const progress = buildCalendarPrepProgress({
    runRefs: input.runRefs,
    group,
    runProgresses,
    previousProgress: input.previousProgress,
    startedAt: input.startedAt,
  });
  input.log?.info(
    {
      prepId: input.row.id,
      taskgroupId: input.runRefs.taskgroupId,
      isActive: group.status?.is_active ?? null,
      runCount: input.runRefs.runs.length,
      statusCounts: group.status?.task_run_status_counts ?? null,
      modifiedAt: group.status?.modified_at ?? null,
      progress: {
        totalRuns: progress.totalRuns,
        queuedRuns: progress.queuedRuns,
        runningRuns: progress.runningRuns,
        completedRuns: progress.completedRuns,
        failedRuns: progress.failedRuns,
        peopleStatus: progress.peopleStatus,
        companyStatus: progress.companyStatus,
        peopleProgressPercent: progress.peopleProgressPercent,
        companyProgressPercent: progress.companyProgressPercent,
      },
    },
    "Parallel meeting prep group status refreshed",
  );
  if (group.status?.is_active !== false) {
    return persistRefreshCalendarPrepRunningState({
      row: input.row,
      runRefs: input.runRefs,
      progress,
      previousBrief: input.previousBrief,
    });
  }

  return completeRefreshCalendarPrepFromParallelRuns({
    row: input.row,
    runRefs: input.runRefs,
    client,
    startedAt: input.startedAt,
    previousBrief: input.previousBrief,
    log: input.log,
  });
}

async function refreshCalendarEventPrep(input: {
  row: Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByIdForUser"]>>;
  log?: CalendarPrepLogger;
}) {
  const row = input.row;
  if (row === null || row.status === "completed" || row.status === "failed") {
    return row;
  }

  const runRefs = runRefsFromStored(row.runRefs);
  const previousResponse = responseFromPrepRow(row);
  const previousProgress = previousResponse.progress ?? null;
  const previousBrief = previousResponse.brief;
  const startedAt =
    previousProgress?.startedAt !== undefined && previousProgress.startedAt.length > 0
      ? previousProgress.startedAt
      : row.createdAt.toISOString();
  if (!hasTaskGroupId(runRefs) || runRefs.runs.length === 0) {
    if (row.status === "pending" && ((previousProgress?.totalRuns ?? 0) > 0 || !isStalePendingPrep(row))) {
      return row;
    }

    return completeRefreshCalendarPrepWithoutTaskGroup({
      row,
      runRefs,
      previousBrief,
      startedAt,
    });
  }

  return refreshCalendarEventPrepWithParallelTaskGroup({
    row,
    runRefs,
    previousProgress,
    previousBrief,
    startedAt,
    log: input.log,
  });
}

function calendarPrepUserContext(input: {
  user: { id: string; email: string; displayName: string };
  connectors: CalendarConnector[];
}) {
  return {
    userId: input.user.id,
    userEmail: input.user.email,
    userDisplayName: input.user.displayName,
    calendarAccountEmails: input.connectors
      .flatMap((connector) => [connector.externalAccountEmail, connector.providerEmail])
      .filter((email): email is string => Boolean(email)),
  };
}

function prepSummaryFromRow(
  row: NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByFingerprint"]>>>,
) {
  const response = responseFromPrepRow(row);
  const runRefs = runRefsFromStored(row.runRefs);

  return {
    calendarEventId: row.calendarEventId,
    eventFingerprint: row.eventFingerprint,
    prepId: row.id,
    status: response.status,
    /** @external calendar prep company visible wire field */
    companyVisible: runRefs.companyVisible,
    progress: response.progress ?? null,
  };
}

function rowStartedAt(row: NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByFingerprint"]>>>) {
  return row.createdAt.toISOString();
}

async function generateOpenAiCalendarEventPrepPrivateBrief(input: {
  row: NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByFingerprint"]>>>;
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  context: ReturnType<typeof buildMeetingBriefPrivateContext>;
  openAiApiKey: string;
  log?: CalendarPrepLogger;
}): Promise<{
  brief: MeetingPrivateBrief;
  identityHints: MeetingBriefIdentityHint[];
}> {
  try {
    const brief = await generateMeetingPrivateBrief({
      event: input.event,
      context: input.context,
      runner: new OpenAIMeetingPrivateBriefRunner(input.openAiApiKey, undefined, undefined, (request) =>
        executeMemberResponse({
          userId: input.row.userId,
          source: "meeting_private_brief",
          actionType: "meeting_brief",
          request,
        }),
      ),
      meetingContext: input.targetPlan.meetingContext,
      model: apiEnv.OPENAI_MEETING_BRIEF_MODEL,
    });
    input.log?.info(
      {
        prepId: input.row.id,
        calendarEventId: input.event.id,
        relatedEmailThreadCount: input.context.relatedEmailThreads.length,
        relatedPastMeetingCount: input.context.relatedPastMeetings.length,
        briefBulletCount: brief.bullets.length,
        identityHintCount: input.context.identityHints.length,
      },
      "Private meeting brief generated",
    );

    return { brief, identityHints: input.context.identityHints };
  } catch (error) {
    input.log?.warn(
      {
        error,
        prepId: input.row.id,
        calendarEventId: input.event.id,
      },
      "Private meeting brief generation failed; continuing with public prep",
    );

    return { brief: { status: "failed", bullets: [] }, identityHints: input.context.identityHints };
  }
}

async function buildCalendarPrivateBrief(input: {
  row: NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByFingerprint"]>>>;
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  log?: CalendarPrepLogger;
}): Promise<{
  brief: MeetingPrivateBrief;
  identityHints: MeetingBriefIdentityHint[];
}> {
  const participantEmails = input.targetPlan.externalParticipants
    .map((participant) => participant.email)
    .filter((email): email is string => Boolean(email));
  const participantDomains = [
    ...input.targetPlan.externalParticipants.map((participant) => participant.emailDomain),
    input.targetPlan.companyTarget?.domain ?? null,
  ].filter((domain): domain is string => Boolean(domain));

  if (participantEmails.length === 0 && participantDomains.length === 0) {
    return { brief: { status: "completed", bullets: [] }, identityHints: [] };
  }

  const eventStart = new Date(input.event.start);
  const before = Number.isNaN(eventStart.getTime()) ? new Date() : eventStart;
  const pastMeetingCandidates = await repositories().listMeetingBriefPastMeetingContextCandidates({
    userId: input.row.userId,
    before,
    limit: MEETING_BRIEF_CONTEXT_CANDIDATE_LIMIT,
  });

  const context = buildMeetingBriefPrivateContext({
    event: input.event,
    participants: input.targetPlan.externalParticipants,
    companyDomain: input.targetPlan.companyTarget?.domain ?? null,
    emailCandidates: [],
    pastMeetingCandidates,
  });

  const openAiApiKey = apiEnv.OPENAI_API_KEY;
  if (openAiApiKey.length === 0) {
    input.log?.debug(
      {
        prepId: input.row.id,
        calendarEventId: input.event.id,
        relatedEmailThreadCount: context.relatedEmailThreads.length,
        relatedPastMeetingCount: context.relatedPastMeetings.length,
      },
      "OpenAI is not configured; skipping private meeting brief generation",
    );

    return { brief: { status: "completed", bullets: [] }, identityHints: context.identityHints };
  }

  return generateOpenAiCalendarEventPrepPrivateBrief({
    row: input.row,
    event: input.event,
    targetPlan: input.targetPlan,
    context,
    openAiApiKey,
    log: input.log,
  });
}

function isStalePendingPrep(
  row: NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByFingerprint"]>>>,
) {
  if (row.status !== "pending") {
    return false;
  }

  return Date.now() - row.updatedAt.getTime() > apiEnv.PARALLEL_MEETING_PREP_STALE_PENDING_MS;
}

function hasStalePrivateBrief(
  row: NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByFingerprint"]>>>,
) {
  if (row.status !== "completed" || typeof row.result !== "object") {
    return false;
  }
  const parsedResult = calendarPrepStoredResultSchema.safeParse(row.result);
  if (!parsedResult.success) {
    return false;
  }
  const brief = parsedResult.data.brief;
  if (brief === undefined) {
    return false;
  }

  return brief.status === "pending" || brief.status === "running";
}

async function repairStaleCalendarPrivateBrief(input: {
  row: NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByFingerprint"]>>>;
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  log?: CalendarPrepLogger;
}) {
  const current = responseFromPrepRow(input.row);
  const privateBriefResult = await buildCalendarPrivateBrief({
    row: input.row,
    event: input.event,
    targetPlan: input.targetPlan,
    log: input.log,
  });
  const repaired = calendarEventPrepResponseSchema.parse({
    ...current,
    brief: privateBriefResult.brief,
  });

  return repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "completed",
    result: resultPayloadFromPrepResponse(repaired),
    error: null,
  });
}

type CalendarPrepResearchRow = NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByFingerprint"]>>>;

async function preflightCalendarPrepResearchCredits(input: {
  row: CalendarPrepResearchRow;
  client: ReturnType<typeof parallelClientFromEnv>;
  preflightRunCount: number;
  selectedProcessor: CalendarEventPrepProcessor | null;
  isCompanyVisible: boolean;
  shouldRequireAvailableCredits: boolean;
  previousProgress: CalendarEventPrepResponse["progress"];
}): Promise<boolean> {
  if (input.client === null || input.preflightRunCount === 0) {
    return true;
  }
  try {
    await ensureCalendarPrepResearchCreditsAvailable({
      userId: input.row.userId,
      processor: input.selectedProcessor ?? "core",
      taskRunCount: input.preflightRunCount,
      advancedSearchRequestCount: input.isCompanyVisible ? 1 : 0,
      shouldRequireAvailableCredits: input.shouldRequireAvailableCredits,
    });

    return true;
  } catch (error) {
    if (!(error instanceof CalendarPrepCreditsRequiredError)) {
      throw error;
    }
    const failed = failedCalendarPrepCreditsRequiredResult({
      prepId: input.row.id,
      isCompanyVisible: input.isCompanyVisible,
      progress: input.previousProgress,
    });
    await repositories().updateCalendarEventPrep({
      id: input.row.id,
      status: "failed",
      taskgroupId: null,
      /** @external calendar prep company visible wire field */
      runRefs: {
        /** @external calendar prep company visible wire field */
        companyVisible: input.isCompanyVisible,
        processor: input.selectedProcessor,
        runs: [],
      },
      result: resultPayloadFromPrepResponse(failed),
      error: failed.error ?? null,
    });

    return false;
  }
}

async function loadCalendarPrepCompanySearchContext(input: {
  row: CalendarPrepResearchRow;
  event: NormalizedCalendarEvent;
  companyTarget: CalendarPrepTargetPlan["companyTarget"];
  client: ReturnType<typeof parallelClientFromEnv>;
  log?: CalendarPrepLogger;
}) {
  if (input.companyTarget === null || input.client === null) {
    return null;
  }
  const searchRequest = buildCompanyLatestSearchRequest({
    event: input.event,
    target: input.companyTarget,
  });
  try {
    const searchResponse = await input.client.searchCompanyLatestSignals(searchRequest.body);
    const companySearchContext = sanitizeCompanyLatestSearchResponse(searchResponse, searchRequest.afterDate);
    input.log?.info(
      {
        prepId: input.row.id,
        calendarEventId: input.event.id,
        companyDomain: input.companyTarget.domain,
        afterDate: searchRequest.afterDate,
        resultCount: companySearchContext.results.length,
      },
      "Parallel company latest signal search completed",
    );

    return companySearchContext;
  } catch (error) {
    input.log?.warn(
      {
        error,
        prepId: input.row.id,
        calendarEventId: input.event.id,
        companyDomain: input.companyTarget.domain,
      },
      "Parallel company latest signal search failed; continuing with Task API only",
    );

    return null;
  }
}

async function completeCalendarPrepResearchWithoutRuns(input: {
  row: CalendarPrepResearchRow;
  isCompanyVisible: boolean;
  selectedProcessor: CalendarEventPrepProcessor | null;
  startedAt: string;
  privateBrief: MeetingPrivateBrief;
}) {
  const runRefs = {
    /** @external calendar prep company visible wire field */
    companyVisible: input.isCompanyVisible,
    processor: input.selectedProcessor,
    runs: [],
  };
  const progress = buildCompletedPrepProgress({ runRefs, startedAt: input.startedAt });
  const completed = calendarEventPrepResponseSchema.parse({
    prepId: input.row.id,
    ...buildInitialPrepResult({
      status: "completed",
      /** @external calendar prep company visible wire field */
      companyVisible: input.isCompanyVisible,
      progress,
      brief: input.privateBrief,
    }),
  });
  await repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "completed",
    taskgroupId: null,
    runRefs,
    result: resultPayloadFromPrepResponse(completed),
    error: null,
  });
}

async function failCalendarPrepResearchParallelUnavailable(input: {
  row: CalendarPrepResearchRow;
  isCompanyVisible: boolean;
  selectedProcessor: CalendarEventPrepProcessor | null;
  previousProgress: CalendarEventPrepResponse["progress"];
  privateBrief: MeetingPrivateBrief;
}) {
  const failed = failedPrepResult({
    prepId: input.row.id,
    /** @external calendar prep company visible wire field */
    companyVisible: input.isCompanyVisible,
    code: PARALLEL_NOT_CONFIGURED_CODE,
    message: MESSAGE_PARALLEL_IS_NOT_CONFIGURED_FOR_MEETING_PREP,
    progress: input.previousProgress,
    brief: input.privateBrief,
  });
  await repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "failed",
    taskgroupId: null,
    runRefs: {
      /** @external calendar prep company visible wire field */
      companyVisible: input.isCompanyVisible,
      processor: input.selectedProcessor,
      runs: [],
    },
    result: resultPayloadFromPrepResponse(failed),
    error: failed.error ?? null,
  });
}

async function reserveCalendarPrepLaunchCredits(input: {
  row: CalendarPrepResearchRow;
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  parallelRuns: ReturnType<typeof buildCalendarPrepParallelRuns>;
  selectedProcessor: CalendarEventPrepProcessor | null;
  isCompanyVisible: boolean;
  shouldRequireAvailableCredits: boolean;
  previousProgress: CalendarEventPrepResponse["progress"];
}) {
  try {
    return await holdCalendarPrepResearchCredits({
      userId: input.row.userId,
      prepId: input.row.id,
      event: input.event,
      targetPlan: input.targetPlan,
      processor: input.selectedProcessor ?? "core",
      plannedRunCount: input.parallelRuns.length,
      isCompanyVisible: input.isCompanyVisible,
      shouldRequireAvailableCredits: input.shouldRequireAvailableCredits,
    });
  } catch (error) {
    if (!isPlanCreditDenial(error)) {
      throw error;
    }
    const failed = failedCalendarPrepCreditsRequiredResult({
      prepId: input.row.id,
      isCompanyVisible: input.isCompanyVisible,
      progress: input.previousProgress,
    });
    await repositories().updateCalendarEventPrep({
      id: input.row.id,
      status: "failed",
      taskgroupId: null,
      /** @external calendar prep company visible wire field */
      runRefs: {
        /** @external calendar prep company visible wire field */
        companyVisible: input.isCompanyVisible,
        processor: input.selectedProcessor,
        runs: [],
      },
      result: resultPayloadFromPrepResponse(failed),
      error: failed.error ?? null,
    });

    return null;
  }
}

async function createHeldCalendarPrepTaskGroup(input: {
  client: NonNullable<ReturnType<typeof parallelClientFromEnv>>;
  hold: { reservationId: string; workspaceId: string };
  row: CalendarPrepResearchRow;
  mode: CalendarPrepStartMode;
  parallelRuns: ReturnType<typeof buildCalendarPrepParallelRuns>;
  selectedProcessor: CalendarEventPrepProcessor | null;
}) {
  try {
    const created = await input.client.createTaskGroup({
      kind: "meeting_prep",
      trigger: input.mode,
      user_id: input.row.userId,
      ...optionalCalendarPrepProcessorField(input.selectedProcessor),
    });
    const addedRuns = await input.client.addRuns(
      created.taskgroup_id,
      input.parallelRuns.map((run) => run.run),
    );

    return { created, addedRuns };
  } catch (error) {
    await repositories().releasePlanCredits({
      reservationId: input.hold.reservationId,
      workspaceId: input.hold.workspaceId,
      userId: input.row.userId,
    });
    throw error;
  }
}

async function launchCalendarPrepParallelResearch(input: {
  row: CalendarPrepResearchRow;
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  mode: CalendarPrepStartMode;
  client: NonNullable<ReturnType<typeof parallelClientFromEnv>>;
  parallelRuns: ReturnType<typeof buildCalendarPrepParallelRuns>;
  selectedProcessor: CalendarEventPrepProcessor | null;
  isCompanyVisible: boolean;
  shouldRequireAvailableCredits: boolean;
  previousProgress: CalendarEventPrepResponse["progress"];
  startedAt: string;
  privateBrief: MeetingPrivateBrief;
  log?: CalendarPrepLogger;
}) {
  const processor = input.selectedProcessor ?? "core";
  const hold = await reserveCalendarPrepLaunchCredits(input);
  if (hold === null) {
    return;
  }
  const taskGroup = await createHeldCalendarPrepTaskGroup({ ...input, hold });
  const runRefs = input.parallelRuns
    .map((run, index) => ({
      ...run.ref,
      runId: taskGroup.addedRuns.run_ids[index] ?? "",
    }))
    .filter((run) => Boolean(run.runId));
  const storedRunRefs = {
    taskgroupId: taskGroup.created.taskgroup_id,
    /** @external calendar prep company visible wire field */
    companyVisible: input.isCompanyVisible,
    processor: input.selectedProcessor,
    runs: runRefs,
  };
  const progress = buildCalendarPrepProgress({
    runRefs: storedRunRefs,
    group: taskGroup.created,
    previousProgress: input.previousProgress,
    startedAt: input.startedAt,
  });
  const chargedCostMicroUsd = calendarPrepParallelCostMicroUsd({
    processor,
    taskRunCount: runRefs.length,
    advancedSearchRequestCount: input.isCompanyVisible ? 1 : 0,
  });
  const hasCreditsCharged = await settleCalendarPrepResearchOrFail({
    row: input.row,
    hold,
    event: input.event,
    processor,
    rawCostMicroUsd: chargedCostMicroUsd,
    isCompanyVisible: input.isCompanyVisible,
    progress,
    log: input.log,
  });
  if (!hasCreditsCharged) {
    return;
  }
  const result = buildInitialPrepResult({
    status: "running",
    /** @external calendar prep company visible wire field */
    companyVisible: input.isCompanyVisible,
    progress,
    brief: input.privateBrief,
  });

  await repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "running",
    taskgroupId: taskGroup.created.taskgroup_id,
    runRefs: storedRunRefs,
    result,
    error: null,
  });
  input.log?.info(
    {
      prepId: input.row.id,
      taskgroupId: taskGroup.created.taskgroup_id,
      trigger: input.mode,
      calendarEventId: input.event.id,
      processor: input.selectedProcessor,
      peopleRunCount: runRefs.filter((run) => run.kind === "people").length,
      /** @external calendar prep company visible wire field */
      companyVisible: input.isCompanyVisible,
      runCount: runRefs.length,
    },
    "Started Parallel meeting prep backend research",
  );
}

async function markCalendarPrepResearchPipelineFailed(input: {
  row: CalendarPrepResearchRow;
  mode: CalendarPrepStartMode;
  event: NormalizedCalendarEvent;
  isCompanyVisible: boolean;
  selectedProcessor: CalendarEventPrepProcessor | null;
  previousProgress: CalendarEventPrepResponse["progress"];
  privateBrief: MeetingPrivateBrief | null;
  error: unknown;
  log?: CalendarPrepLogger;
}) {
  input.log?.warn(
    {
      error: input.error,
      prepId: input.row.id,
      trigger: input.mode,
      calendarEventId: input.event.id,
    },
    "Failed to start Parallel meeting prep backend research",
  );
  const failed = failedPrepResult({
    prepId: input.row.id,
    /** @external calendar prep company visible wire field */
    companyVisible: input.isCompanyVisible,
    code: PARALLEL_START_FAILED_CODE,
    message: input.error instanceof Error ? input.error.message : MESSAGE_FAILED_TO_START_MEETING_PREP,
    progress: input.previousProgress,
    brief: input.privateBrief,
  });
  await repositories().updateCalendarEventPrep({
    id: input.row.id,
    status: "failed",
    taskgroupId: null,
    /** @external calendar prep company visible wire field */
    runRefs: {
      /** @external calendar prep company visible wire field */
      companyVisible: input.isCompanyVisible,
      processor: input.selectedProcessor,
      runs: [],
    },
    result: resultPayloadFromPrepResponse(failed),
    error: failed.error ?? null,
  });
}

async function runCalendarPrepResearchPipeline(input: {
  row: CalendarPrepResearchRow;
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  mode: CalendarPrepStartMode;
  processors: ReturnType<typeof calendarPrepProcessorsForSelected>;
  client: ReturnType<typeof parallelClientFromEnv>;
  selectedProcessor: CalendarEventPrepProcessor | null;
  isCompanyVisible: boolean;
  shouldRequireAvailableCredits: boolean;
  previousProgress: CalendarEventPrepResponse["progress"];
  startedAt: string;
  log?: CalendarPrepLogger;
}) {
  const privateBriefState: { value: MeetingPrivateBrief | null } = { value: null };
  try {
    const companySearchContext = await loadCalendarPrepCompanySearchContext({
      row: input.row,
      event: input.event,
      companyTarget: input.targetPlan.companyTarget,
      client: input.client,
      log: input.log,
    });
    const privateBriefResult = await buildCalendarPrivateBrief({
      row: input.row,
      event: input.event,
      targetPlan: input.targetPlan,
      log: input.log,
    });
    const privateBrief = privateBriefResult.brief;
    privateBriefState.value = privateBrief;

    const parallelRuns = buildCalendarPrepParallelRuns({
      event: input.event,
      plan: input.targetPlan,
      peopleProcessor: input.processors.peopleProcessor,
      companyProcessor: input.processors.companyProcessor,
      companySearchContext,
      identityHints: privateBriefResult.identityHints,
    });

    if (parallelRuns.length === 0) {
      await completeCalendarPrepResearchWithoutRuns({
        row: input.row,
        isCompanyVisible: input.isCompanyVisible,
        selectedProcessor: input.selectedProcessor,
        startedAt: input.startedAt,
        privateBrief,
      });

      return;
    }

    if (input.client === null) {
      await failCalendarPrepResearchParallelUnavailable({
        row: input.row,
        isCompanyVisible: input.isCompanyVisible,
        selectedProcessor: input.selectedProcessor,
        previousProgress: input.previousProgress,
        privateBrief,
      });

      return;
    }

    await launchCalendarPrepParallelResearch({
      row: input.row,
      event: input.event,
      targetPlan: input.targetPlan,
      mode: input.mode,
      client: input.client,
      parallelRuns,
      selectedProcessor: input.selectedProcessor,
      isCompanyVisible: input.isCompanyVisible,
      shouldRequireAvailableCredits: input.shouldRequireAvailableCredits,
      previousProgress: input.previousProgress,
      startedAt: input.startedAt,
      privateBrief,
      log: input.log,
    });
  } catch (error) {
    await markCalendarPrepResearchPipelineFailed({
      row: input.row,
      mode: input.mode,
      event: input.event,
      isCompanyVisible: input.isCompanyVisible,
      selectedProcessor: input.selectedProcessor,
      previousProgress: input.previousProgress,
      privateBrief: privateBriefState.value,
      error,
      log: input.log,
    });
  }
}

async function startCalendarPrepResearch(input: {
  row: CalendarPrepResearchRow;
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  mode: CalendarPrepStartMode;
  processor?: CalendarEventPrepProcessor | null;
  log?: CalendarPrepLogger;
}) {
  const previousProgress = responseFromPrepRow(input.row).progress ?? null;
  const startedAt = previousProgress?.startedAt ?? rowStartedAt(input.row);
  const isCompanyVisible = Boolean(input.targetPlan.companyTarget);
  const storedRunRefs = runRefsFromStored(input.row.runRefs);
  const selectedProcessor = input.processor ?? parseCalendarPrepProcessor(storedRunRefs.processor);
  const processors = calendarPrepProcessorsForSelected({ selectedProcessor, mode: input.mode });
  const client = parallelClientFromEnv();
  const preflightRuns = buildCalendarPrepParallelRuns({
    event: input.event,
    plan: input.targetPlan,
    peopleProcessor: processors.peopleProcessor,
    companyProcessor: processors.companyProcessor,
  });
  const prepCreditAccess = preflightRuns.length !== 0 ? await getCalendarPrepAccessForUser(input.row.userId) : null;
  const shouldRequireAvailableCredits = prepCreditAccess
    ? shouldRequireCalendarPrepGrantCredits(prepCreditAccess)
    : true;

  const canContinue = await preflightCalendarPrepResearchCredits({
    row: input.row,
    client,
    preflightRunCount: preflightRuns.length,
    selectedProcessor,
    isCompanyVisible,
    shouldRequireAvailableCredits,
    previousProgress,
  });
  if (!canContinue) {
    return;
  }

  await runCalendarPrepResearchPipeline({
    row: input.row,
    event: input.event,
    targetPlan: input.targetPlan,
    mode: input.mode,
    processors,
    client,
    selectedProcessor,
    isCompanyVisible,
    shouldRequireAvailableCredits,
    previousProgress,
    startedAt,
    log: input.log,
  });
}

async function resolveExistingCalendarEventPrepRow(input: {
  existing: CalendarPrepResearchRow;
  user: { id: string };
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  mode: CalendarPrepStartMode;
  processor?: CalendarEventPrepProcessor | null;
  /** @external calendar prep refresh active wire field */
  refreshActive?: boolean;
  /** @external calendar prep retry failed wire field */
  retryFailed?: boolean;
  plannedRunCount: number;
  peopleRunCount: number;
  isCompanyVisible: boolean;
  selectedProcessor: CalendarEventPrepProcessor | null;
  selectedProcessorForCharge: CalendarEventPrepProcessor;
  advancedSearchRequestCount: number;
  log?: CalendarPrepLogger;
}) {
  if (hasStalePrivateBrief(input.existing)) {
    return repairStaleCalendarPrivateBrief({
      row: input.existing,
      event: input.event,
      targetPlan: input.targetPlan,
      log: input.log,
    });
  }
  if (input.existing.status === "running" && input.refreshActive === true) {
    return (await refreshCalendarEventPrep({ row: input.existing, log: input.log })) ?? input.existing;
  }
  if (input.existing.status === "failed" && !(input.retryFailed ?? false)) {
    return input.existing;
  }
  if (input.existing.status === "failed" && input.retryFailed === true) {
    if (input.plannedRunCount !== 0) {
      const prepAccess = await getCalendarPrepAccessForUser(input.user.id);
      await ensureCalendarPrepResearchCreditsAvailable({
        userId: input.user.id,
        processor: input.selectedProcessorForCharge,
        taskRunCount: input.plannedRunCount,
        advancedSearchRequestCount: input.advancedSearchRequestCount,
        shouldRequireAvailableCredits: shouldRequireCalendarPrepGrantCredits(prepAccess),
      });
    }
    const startedAt = new Date().toISOString();
    const progress = buildPendingPrepProgress({
      totalRuns: input.plannedRunCount,
      peopleRunCount: input.peopleRunCount,
      /** @external calendar prep company visible wire field */
      companyVisible: input.isCompanyVisible,
      startedAt,
    });
    const reset = await repositories().updateCalendarEventPrep({
      id: input.existing.id,
      status: "pending",
      taskgroupId: null,
      /** @external calendar prep company visible wire field */
      runRefs: {
        /** @external calendar prep company visible wire field */
        companyVisible: input.isCompanyVisible,
        processor: input.selectedProcessor,
        runs: [],
      },
      result: buildInitialPrepResult({
        status: "pending",
        /** @external calendar prep company visible wire field */
        companyVisible: input.isCompanyVisible,
        progress,
      }),
      error: null,
    });
    startCalendarPrepResearchSoon({
      row: reset,
      event: input.event,
      targetPlan: input.targetPlan,
      mode: input.mode,
      processor: input.selectedProcessor,
      log: input.log,
    });

    return reset;
  }
  if (input.existing.status === "pending") {
    const runRefs = runRefsFromStored(input.existing.runRefs);
    if (!hasTaskGroupId(runRefs) && isStalePendingPrep(input.existing)) {
      startCalendarPrepResearchSoon({
        row: input.existing,
        event: input.event,
        targetPlan: input.targetPlan,
        mode: input.mode,
        processor: parseCalendarPrepProcessor(runRefs.processor),
        log: input.log,
      });
    }
  }

  return input.existing;
}

async function createPendingCalendarEventPrepForEvent(input: {
  user: { id: string };
  event: NormalizedCalendarEvent;
  targetPlan: CalendarPrepTargetPlan;
  mode: CalendarPrepStartMode;
  processor?: CalendarEventPrepProcessor | null;
  plannedRunCount: number;
  peopleRunCount: number;
  isCompanyVisible: boolean;
  selectedProcessor: CalendarEventPrepProcessor | null;
  selectedProcessorForCharge: CalendarEventPrepProcessor;
  advancedSearchRequestCount: number;
  log?: CalendarPrepLogger;
}) {
  if (input.plannedRunCount !== 0) {
    const prepAccess = await getCalendarPrepAccessForUser(input.user.id);
    if (!prepAccess.canStartCalendarPrep) {
      throw new CalendarPrepPlanRequiredError(prepAccess);
    }
    await ensureCalendarPrepResearchCreditsAvailable({
      userId: input.user.id,
      processor: input.selectedProcessorForCharge,
      taskRunCount: input.plannedRunCount,
      advancedSearchRequestCount: input.advancedSearchRequestCount,
      shouldRequireAvailableCredits: shouldRequireCalendarPrepGrantCredits(prepAccess),
    });
  }

  const createdPrep = await (async () => {
    try {
      return {
        kind: "created" as const,
        row: await repositories().createCalendarEventPrep({
          userId: input.user.id,
          calendarAccountId: input.event.calendarAccountId ?? null,
          calendarEventId: input.event.id,
          eventFingerprint: input.targetPlan.eventFingerprint,
          status: "pending",
          eventSnapshot: input.targetPlan.eventSnapshot,
          runRefs: {
            /** @external calendar prep company visible wire field */
            companyVisible: input.isCompanyVisible,
            runs: [],
          },
          result: buildInitialPrepResult({
            status: "pending",
            /** @external calendar prep company visible wire field */
            companyVisible: input.isCompanyVisible,
            progress: null,
          }),
        }),
      };
    } catch (error) {
      const racedRow = await repositories().getCalendarEventPrepByFingerprint({
        userId: input.user.id,
        calendarAccountId: input.event.calendarAccountId ?? null,
        calendarEventId: input.event.id,
        eventFingerprint: input.targetPlan.eventFingerprint,
      });
      if (racedRow) {
        return { kind: "raced" as const, row: racedRow };
      }
      throw error;
    }
  })();
  if (createdPrep.kind === "raced") {
    return createdPrep.row;
  }
  const initialRow = createdPrep.row;
  const startedAt = rowStartedAt(initialRow);
  const runRefs = {
    /** @external calendar prep company visible wire field */
    companyVisible: input.isCompanyVisible,
    processor: input.selectedProcessor,
    runs: [],
  };
  const progress = buildPendingPrepProgress({
    totalRuns: input.plannedRunCount,
    peopleRunCount: input.peopleRunCount,
    /** @external calendar prep company visible wire field */
    companyVisible: input.isCompanyVisible,
    startedAt,
  });
  const pending = await repositories().updateCalendarEventPrep({
    id: initialRow.id,
    status: "pending",
    runRefs,
    result: buildInitialPrepResult({
      status: "pending",
      /** @external calendar prep company visible wire field */
      companyVisible: input.isCompanyVisible,
      progress,
    }),
    error: null,
  });

  startCalendarPrepResearchSoon({
    row: pending,
    event: input.event,
    targetPlan: input.targetPlan,
    mode: input.mode,
    processor: input.selectedProcessor,
    log: input.log,
  });

  return pending;
}

function startCalendarPrepResearchSoon(input: Parameters<typeof startCalendarPrepResearch>[0]) {
  void (async () => {
    try {
      await startCalendarPrepResearch(input);
    } catch (error) {
      input.log?.warn(
        {
          error,
          prepId: input.row.id,
          calendarEventId: input.event.id,
          trigger: input.mode,
        },
        "Unhandled calendar meeting prep backend start error",
      );
    }
  })();
}

async function ensureCalendarEventPrepForEvent(input: {
  user: { id: string; email: string; displayName: string };
  connectors: CalendarConnector[];
  event: NormalizedCalendarEvent;
  mode: CalendarPrepStartMode;
  processor?: CalendarEventPrepProcessor | null;
  /** @external calendar prep refresh active wire field */
  refreshActive?: boolean;
  /** @external calendar prep retry failed wire field */
  retryFailed?: boolean;
  log?: CalendarPrepLogger;
}) {
  const targetPlan = buildCalendarPrepTargetPlan({
    event: input.event,
    userContext: calendarPrepUserContext({
      user: input.user,
      connectors: input.connectors,
    }),
  });
  const selectedProcessor = input.processor ?? (input.mode === "interactive" ? "core" : null);
  const processors = calendarPrepProcessorsForSelected({ selectedProcessor, mode: input.mode });
  const plannedRuns = buildCalendarPrepParallelRuns({
    event: input.event,
    plan: targetPlan,
    peopleProcessor: processors.peopleProcessor,
    companyProcessor: processors.companyProcessor,
  });
  const isCompanyVisible = Boolean(targetPlan.companyTarget);
  const peopleRunCount = plannedRuns.filter((run) => run.ref.kind === "people").length;
  const selectedProcessorForCharge = selectedProcessor ?? "core";
  const advancedSearchRequestCount = isCompanyVisible ? 1 : 0;

  input.log?.info(
    {
      calendarEventId: input.event.id,
      trigger: input.mode,
      meetingContext: targetPlan.meetingContext,
      externalParticipantCount: targetPlan.externalParticipants.length,
      peopleRunCount,
      /** @external calendar prep company visible wire field */
      companyVisible: isCompanyVisible,
      runCount: plannedRuns.length,
    },
    "Calendar meeting prep target plan built",
  );

  const existing = await repositories().getCalendarEventPrepByFingerprint({
    userId: input.user.id,
    calendarAccountId: input.event.calendarAccountId ?? null,
    calendarEventId: input.event.id,
    eventFingerprint: targetPlan.eventFingerprint,
  });
  if (existing) {
    return resolveExistingCalendarEventPrepRow({
      existing,
      user: input.user,
      event: input.event,
      targetPlan,
      mode: input.mode,
      processor: input.processor,
      refreshActive: input.refreshActive,
      retryFailed: input.retryFailed,
      plannedRunCount: plannedRuns.length,
      peopleRunCount,
      isCompanyVisible,
      selectedProcessor,
      selectedProcessorForCharge,
      advancedSearchRequestCount,
      log: input.log,
    });
  }

  return createPendingCalendarEventPrepForEvent({
    user: input.user,
    event: input.event,
    targetPlan,
    mode: input.mode,
    processor: input.processor,
    plannedRunCount: plannedRuns.length,
    peopleRunCount,
    isCompanyVisible,
    selectedProcessor,
    selectedProcessorForCharge,
    advancedSearchRequestCount,
    log: input.log,
  });
}

function isCalendarPrepSummaryEligibleEvent(event: NormalizedCalendarEvent) {
  return !event.isCancelled && !event.isPrivate;
}

async function listExistingCalendarEventPrepSummaries(input: {
  user: { id: string; email: string; displayName: string };
  connectors: CalendarConnector[];
  events: NormalizedCalendarEvent[];
}) {
  const userContext = calendarPrepUserContext({
    user: input.user,
    connectors: input.connectors,
  });
  const rows = await Promise.all(
    input.events.map(async (event) => {
      if (!isCalendarPrepSummaryEligibleEvent(event)) {
        return null;
      }
      const targetPlan = buildCalendarPrepTargetPlan({
        event,
        userContext,
      });

      return repositories().getCalendarEventPrepByFingerprint({
        userId: input.user.id,
        calendarAccountId: event.calendarAccountId ?? null,
        calendarEventId: event.id,
        eventFingerprint: targetPlan.eventFingerprint,
      });
    }),
  );

  return rows.filter((row): row is NonNullable<typeof row> => Boolean(row)).map(prepSummaryFromRow);
}

function signLinearState(state: LinearOAuthState) {
  return signOAuthState({ provider: "linear", state });
}

function verifyLinearState(input: { state: string }): LinearOAuthState {
  const decoded = verifyOAuthState({ provider: "linear", token: input.state });

  return linearOAuthStateSchema.parse(decoded);
}

function signCalendarState(state: CalendarOAuthState) {
  return signOAuthState({ provider: "calendar", state });
}

function verifyCalendarState(input: { state: string }): CalendarOAuthState {
  const decoded = verifyOAuthState({ provider: "calendar", token: input.state });

  return calendarOAuthStateSchema.parse(decoded);
}

function calendarWebhookCanonicalToken(input: {
  userId: string;
  connectorId: string;
  provider: CalendarProvider;
  channelId: string;
}) {
  return new URLSearchParams([
    ["v", "1"],
    ["u", input.userId],
    ["c", input.connectorId],
    ["p", input.provider],
    ["ch", input.channelId],
  ]).toString();
}

function signCalendarWebhookToken(input: {
  userId: string;
  connectorId: string;
  provider: CalendarProvider;
  channelId: string;
}) {
  const canonical = calendarWebhookCanonicalToken(input);
  const signature = createHmac("sha256", apiEnv.AUTH_JWT_SECRET).update(canonical).digest("base64url");
  const token = new URLSearchParams(canonical);
  token.set("sig", signature);

  return token.toString();
}

function verifyCalendarWebhookToken(input: {
  token: string | undefined;
  userId: string;
  connectorId: string;
  provider: CalendarProvider;
  channelId: string;
}) {
  if (input.token === undefined || input.token.length === 0) {
    return false;
  }

  const token = input.token;

  const parsed = new URLSearchParams(token);
  const signature = parsed.get("sig");
  if (signature === null || signature.length === 0) {
    return false;
  }

  const canonical = calendarWebhookCanonicalToken({
    userId: input.userId,
    connectorId: input.connectorId,
    provider: input.provider,
    channelId: input.channelId,
  });
  const expected = createHmac("sha256", apiEnv.AUTH_JWT_SECRET).update(canonical).digest("base64url");
  try {
    return (
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) &&
      parsed.get("v") === "1" &&
      parsed.get("u") === input.userId &&
      parsed.get("c") === input.connectorId &&
      parsed.get("p") === input.provider &&
      parsed.get("ch") === input.channelId
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return false;
  }
}

function calendarWebhookAddress(provider: CalendarProvider) {
  return resolveCalendarWebhookAddress({
    provider,
    baseUrl: apiEnv.CALENDAR_WEBHOOK_BASE_URL,
  });
}

function signOutlookClientState(input: { userId: string; connectorId: string; provider: CalendarProvider }) {
  return createHmac("sha256", apiEnv.AUTH_JWT_SECRET)
    .update(`${input.userId}:${input.connectorId}:${input.provider}`)
    .digest("base64url");
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseGoogleHeaderDate(value: string | undefined) {
  if (value === undefined || value.length === 0) {
    return null;
  }
  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

const MESSAGE_GOOGLE_CALENDAR_ACCOUNT_IS_MISSING_A_PROVIDER_ACCOUNT_ID =
  "Google calendar account is missing a provider account id";

async function calendarTokensAfterAuthorization(input: { state: CalendarOAuthState; code: string }) {
  const exchangedTokens = await exchangeCalendarCode(input.state.provider, input.code);
  const accountProfile = await getCalendarAccountProfile(
    exchangedTokens,
    input.state.email,
    input.state.provider === "google_calendar",
  );
  if (input.state.provider !== "google_calendar" || exchangedTokens.refreshToken.length > 0) {
    return { tokens: exchangedTokens, accountProfile, shouldRestoreRefreshToken: false };
  }
  const googleSubject = accountProfile.providerAccountId;
  if (googleSubject === null) {
    throw new Error(MESSAGE_GOOGLE_CALENDAR_ACCOUNT_IS_MISSING_A_PROVIDER_ACCOUNT_ID);
  }
  const tokens = await restoreCalendarRefreshToken({
    userId: input.state.sub,
    tokens: exchangedTokens,
    accountProfile,
    accounts: await repositories().listAgentConnectorsForUser(input.state.sub),
    preservePending: googleAddonCalendarCredentialStorage({
      user: { id: input.state.sub, displayName: input.state.displayName, email: accountProfile.email },
      googleSubject,
    }).stage,
    readTokens: async (accountId) => {
      const secret = await repositories().getLatestAgentConnectorSecret(accountId);

      return secret ? decryptCalendarTokenSecret(secret.secretRef) : null;
    },
    readPendingTokens: async (accountId) => {
      const secret = await repositories().getPendingAgentConnectorSecret(accountId);

      return secret ? decryptPendingGoogleAddonCalendarSecret(secret.secretRef) : null;
    },
  });

  return { tokens, accountProfile, shouldRestoreRefreshToken: true };
}

async function registerIntegrationLinearRoutes(app: FastifyInstance): Promise<void> {
  app.post("/integrations/linear/connect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = linearConnectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    try {
      const state = signLinearState({
        sub: user.id,
        email: user.email,
        displayName: user.displayName,
        returnTo: normalizeReturnTo(parsed.data.returnTo),
      });

      return linearConnectResponseSchema.parse({
        authorizationUrl: buildLinearAuthorizationUrl({ state }),
      });
    } catch (error) {
      return reply.code(HTTP_BAD_REQUEST).send({
        message: error instanceof Error ? error.message : MESSAGE_UNABLE_TO_START_LINEAR_OAUTH,
      });
    }
  });

  app.get("/integrations/linear/callback", async (request, reply) => {
    const query = oauthCallbackQuerySchema.parse(request.query);
    if (query.error !== undefined && query.error.length > 0) {
      const state =
        query.state !== undefined && query.state.length > 0 ? safeVerifyLinearState({ state: query.state }) : null;

      return reply.type("text/html").send(
        renderLinearCallbackPage({
          status: "error",
          returnTo: state?.returnTo ?? apiEnv.NEXT_PUBLIC_WEB_URL,
        }),
      );
    }
    if (query.code === undefined || query.code.length === 0 || query.state === undefined || query.state.length === 0) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_MISSING_LINEAR_OAUTH_CODE_OR_STATE });
    }

    try {
      const state = verifyLinearState({ state: query.state });
      const tokens = await exchangeLinearCode(query.code);
      const viewer = await getLinearViewer(tokens);
      const profile = await repositories().ensureDefaultAgentProfileForUser({
        userId: state.sub,
        displayName: state.displayName,
        voiceId: null,
        llmModel: null,
      });

      await repositories().upsertAgentConnector({
        userId: state.sub,
        agentProfileId: profile.id,
        provider: "linear",
        status: "connected",
        scope: "private",
        externalAccountEmail: viewer.viewer.email,
        secretRef: encryptJsonSecret(tokens),
      });

      return await reply.type("text/html").send(
        renderLinearCallbackPage({
          status: "connected",
          returnTo: state.returnTo ?? apiEnv.NEXT_PUBLIC_WEB_URL,
        }),
      );
    } catch (error) {
      request.log.error({ error }, "Linear OAuth callback failed");

      return reply.type("text/html").send(
        renderLinearCallbackPage({
          status: "error",
          returnTo: apiEnv.NEXT_PUBLIC_WEB_URL,
        }),
      );
    }
  });

  app.post("/integrations/linear/disconnect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const profile = await repositories().ensureDefaultAgentProfileForUser({
      userId: user.id,
      displayName: user.displayName,
      voiceId: null,
      llmModel: null,
    });
    await repositories().upsertAgentConnector({
      userId: user.id,
      agentProfileId: profile.id,
      provider: "linear",
      status: "disconnected",
      scope: "private",
      externalAccountEmail: null,
    });

    return linearDisconnectResponseSchema.parse({
      /** @external linear disconnect ok wire field */
      ok: true,
    });
  });
}

async function finishVerifiedCalendarOAuthCallback(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  state: CalendarOAuthState;
  parsedProvider: CalendarProvider;
  code: string;
}) {
  const { tokens, accountProfile, shouldRestoreRefreshToken } = await calendarTokensAfterAuthorization({
    state: input.state,
    code: input.code,
  });
  if (shouldRestoreRefreshToken) {
    const refreshToken = tokens.refreshToken;
    const isRecoveringOfflineAccess = input.state.recoveringOfflineAccess === true;
    if (refreshToken.length === 0 && !isRecoveringOfflineAccess) {
      const recoveryState = signCalendarState({
        sub: input.state.sub,
        email: input.state.email,
        displayName: input.state.displayName,
        provider: input.state.provider,
        accountKind: input.state.accountKind,
        returnTo: input.state.returnTo,
        meetingId: input.state.meetingId,
        recoveringOfflineAccess: true,
      });

      return input.reply.redirect(
        buildCalendarAuthorizationUrl({
          provider: input.state.provider,
          state: recoveryState,
          /** @external calendar oauth recover offline access wire field */
          recoverOfflineAccess: true,
          loginHint: accountProfile.providerAccountId ?? accountProfile.email,
        }),
      );
    }
    if (refreshToken.length === 0) {
      throw new Error(MESSAGE_GOOGLE_CALENDAR_DID_NOT_GRANT_OFFLINE_ACCESS);
    }
  }
  await connectCalendarAccount({
    userId: input.state.sub,
    displayName: input.state.displayName,
    tokens,
    accountProfile,
    accountKind: input.state.accountKind,
    log: input.request.log,
  });

  return input.reply.type("text/html").send(
    renderCalendarCallbackPage({
      status: "connected",
      provider: input.state.provider,
      returnTo: input.state.returnTo ?? apiEnv.NEXT_PUBLIC_WEB_URL,
    }),
  );
}

async function registerIntegrationCalendarOAuthCallbackRoute(app: FastifyInstance): Promise<void> {
  app.get("/integrations/calendar/:provider/callback", async (request, reply) => {
    const { provider } = calendarProviderParamsSchema.parse(request.params);
    const query = oauthCallbackQuerySchema.parse(request.query);
    const parsedProvider = calendarConnectRequestSchema.shape.provider.safeParse(provider);
    if (!parsedProvider.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_UNSUPPORTED_CALENDAR_PROVIDER });
    }

    if (query.error !== undefined && query.error.length > 0) {
      const state =
        query.state !== undefined && query.state.length > 0 ? safeVerifyCalendarState({ state: query.state }) : null;

      return reply.type("text/html").send(
        renderCalendarCallbackPage({
          status: "error",
          provider: parsedProvider.data,
          returnTo: state?.returnTo ?? apiEnv.NEXT_PUBLIC_WEB_URL,
        }),
      );
    }
    if (query.code === undefined || query.code.length === 0 || query.state === undefined || query.state.length === 0) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_MISSING_CALENDAR_OAUTH_CODE_OR_STATE });
    }

    try {
      const state = verifyCalendarState({ state: query.state });
      if (state.provider !== parsedProvider.data) {
        return await reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CALENDAR_OAUTH_PROVIDER_MISMATCH });
      }

      return await finishVerifiedCalendarOAuthCallback({
        request,
        reply,
        state,
        parsedProvider: parsedProvider.data,
        code: query.code,
      });
    } catch (error) {
      request.log.error({ error, provider }, "Calendar OAuth callback failed");

      return reply.type("text/html").send(
        renderCalendarCallbackPage({
          status: "error",
          provider: parsedProvider.data,
          returnTo: apiEnv.NEXT_PUBLIC_WEB_URL,
        }),
      );
    }
  });
}

async function registerIntegrationCalendarOAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/integrations/calendar/connect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = calendarConnectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    try {
      const state = signCalendarState({
        sub: user.id,
        email: user.email,
        displayName: user.displayName,
        provider: parsed.data.provider,
        accountKind: parsed.data.accountKind,
        returnTo: normalizeReturnTo(parsed.data.returnTo),
        meetingId: parsed.data.meetingId,
      });

      return calendarConnectResponseSchema.parse({
        authorizationUrl: buildCalendarAuthorizationUrl({
          provider: parsed.data.provider,
          state,
        }),
      });
    } catch (error) {
      return reply.code(HTTP_BAD_REQUEST).send({
        message: error instanceof Error ? error.message : MESSAGE_UNABLE_TO_START_CALENDAR_OAUTH,
      });
    }
  });

  await registerIntegrationCalendarOAuthCallbackRoute(app);
}

async function registerIntegrationCalendarProviderDisconnectRoute(app: FastifyInstance): Promise<void> {
  app.post("/integrations/calendar/disconnect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = calendarDisconnectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    const accounts = (await repositories().listCalendarAccountsForUser(user.id)).filter(
      (account) => account.provider === parsed.data.provider && ["connected", "error"].includes(account.status),
    );
    await Promise.all(
      accounts.map(async (account) => {
        if (account.status === "error") {
          const secret = await repositories().getPendingAgentConnectorSecret(account.id);
          if (
            secret === null ||
            account.providerAccountId === null ||
            account.providerAccountId.length === 0 ||
            !readPendingGoogleAddonCalendarCredentials(
              decryptJsonSecret(secret.secretRef),
              user.id,
              account.providerAccountId,
            )
          ) {
            return;
          }
        }
        await repositories().disconnectCalendarAccount({ userId: user.id, accountId: account.id });
        await repositories().markCalendarSyncSubscriptionsInactiveForConnector(account.id);
        await repositories().publishCalendarRealtimeEvent({
          userId: user.id,
          provider: parsed.data.provider,
          connectorId: account.id,
          calendarId: CALENDAR_SYNC_CALENDAR_ID,
          resourceState: "disconnected",
          dedupeKey: `calendar:${user.id}:${parsed.data.provider}:disconnected:${account.id}:${Date.now()}`,
        });
      }),
    );

    return calendarDisconnectResponseSchema.parse({
      /** @external calendar disconnect ok wire field */
      ok: true,
    });
  });
}

async function registerIntegrationCalendarAccountManagementRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/calendar/accounts", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const accounts = await repositories().listCalendarAccountsForUser(user.id);

    return calendarAccountsResponseSchema.parse({ accounts });
  });

  app.patch("/me/calendar/accounts/:accountId", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsedParams = calendarAccountIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
    }
    const accountId = parsedParams.data.accountId;
    const parsed = updateCalendarAccountRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    const account = await repositories().updateCalendarAccountKind({
      userId: user.id,
      accountId,
      accountKind: parsed.data.accountKind,
    });
    if (!account) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_CALENDAR_ACCOUNT_NOT_FOUND });
    }

    return updateCalendarAccountResponseSchema.parse({ account });
  });

  app.post("/me/calendar/accounts/:accountId/disconnect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsedParams = calendarAccountIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
    }
    const accountId = parsedParams.data.accountId;
    const account = await repositories().disconnectCalendarAccount({ userId: user.id, accountId });
    if (!account) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_CALENDAR_ACCOUNT_NOT_FOUND });
    }
    await repositories().markCalendarSyncSubscriptionsInactiveForConnector(account.id);
    await repositories().publishCalendarRealtimeEvent({
      userId: user.id,
      provider: account.provider,
      connectorId: account.id,
      calendarId: CALENDAR_SYNC_CALENDAR_ID,
      resourceState: "disconnected",
      dedupeKey: `calendar:${user.id}:${account.provider}:account-disconnected:${account.id}:${Date.now()}`,
    });

    return calendarDisconnectResponseSchema.parse({
      /** @external calendar disconnect ok wire field */
      ok: true,
    });
  });
}

async function registerIntegrationCalendarAccountDeleteRoute(app: FastifyInstance): Promise<void> {
  app.delete("/me/calendar/accounts/:accountId", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsedParams = calendarAccountIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
    }
    const accountId = parsedParams.data.accountId;
    const parsed = deleteProviderDataRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    const account = await repositories().getCalendarAccountForUser({ userId: user.id, accountId });
    if (!account) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_CALENDAR_ACCOUNT_NOT_FOUND });
    }
    const accountEmail = account.providerEmail ?? account.externalAccountEmail;
    if (
      accountEmail === null ||
      accountEmail === undefined ||
      accountEmail.length === 0 ||
      parsed.data.confirmationEmail.toLowerCase() !== accountEmail.toLowerCase()
    ) {
      return reply
        .code(HTTP_BAD_REQUEST)
        .send({ message: MESSAGE_CONFIRMATION_EMAIL_DOES_NOT_MATCH_THIS_CALENDAR_ACCOUNT });
    }

    const deletion = await repositories().createDataDeletionRequest({
      userId: user.id,
      targetKind: "calendar_account",
      targetProvider: account.provider,
      targetAccountId: account.id,
    });
    const secret = await repositories().getLatestAgentConnectorSecret(account.id);
    const pendingSecret =
      account.provider === "google_calendar" ? await repositories().getPendingAgentConnectorSecret(account.id) : null;
    const providerRevocationStatus: Record<string, unknown> =
      secret || pendingSecret
        ? await (async () => {
            try {
              return account.provider === "google_calendar"
                ? await revokeStoredGoogleCalendarCredentials({
                    active: secret ? decryptCalendarTokenSecret(secret.secretRef) : null,
                    pending: pendingSecret ? decryptPendingGoogleAddonCalendarSecret(pendingSecret.secretRef) : null,
                    userId: user.id,
                    googleSubject: account.providerAccountId,
                  })
                : {
                    provider: account.provider,
                    /** @external provider revocation attempted wire field */
                    attempted: false,
                    reason: "microsoft_revocation_requires_additional_graph_permission",
                  };
            } catch (error) {
              return {
                provider: account.provider,
                /** @external provider revocation attempted wire field */
                attempted: true,
                /** @external provider revocation ok wire field */
                ok: false,
                error: error instanceof Error ? error.message : "Provider revocation failed",
              };
            }
          })()
        : {
            provider: account.provider,
            /** @external provider revocation attempted wire field */
            attempted: false,
          };

    await repositories().markCalendarSyncSubscriptionsInactiveForConnector(account.id);
    await repositories().deleteCalendarPrepDataForAccount({ userId: user.id, accountId: account.id });
    await repositories().softDeleteCalendarAccount({ userId: user.id, accountId: account.id });
    const completedAt = new Date();
    await repositories().updateDataDeletionRequest({
      id: deletion.id,
      status: "completed",
      providerRevocationStatus,
      calendarDeletedAt: completedAt,
      completedAt,
    });
    await repositories().publishCalendarRealtimeEvent({
      userId: user.id,
      provider: account.provider,
      connectorId: account.id,
      calendarId: CALENDAR_SYNC_CALENDAR_ID,
      resourceState: "deleted",
      dedupeKey: `calendar:${user.id}:${account.provider}:account-deleted:${account.id}:${completedAt.toISOString()}`,
    });

    return providerDataDeletionResponseSchema.parse({
      /** @external provider data deletion ok wire field */
      ok: true,
      deletionId: deletion.id,
    });
  });
}

async function registerIntegrationCalendarDisconnectRoutes(app: FastifyInstance): Promise<void> {
  await registerIntegrationCalendarProviderDisconnectRoute(app);
  await registerIntegrationCalendarAccountManagementRoutes(app);
  await registerIntegrationCalendarAccountDeleteRoute(app);
}

async function registerGoogleCalendarWebhookRoutes(webhookApp: FastifyInstance): Promise<void> {
  webhookApp.addContentTypeParser("application/json", { parseAs: "string" }, (_request, _body, done) => {
    done(null, null);
  });

  webhookApp.post("/integrations/calendar/google_calendar/webhook", async (request, reply) => {
    const channelId = firstHeaderValue(request.headers["x-goog-channel-id"]);
    const messageNumber = firstHeaderValue(request.headers["x-goog-message-number"]);
    const resourceId = firstHeaderValue(request.headers["x-goog-resource-id"]);
    const resourceState = firstHeaderValue(request.headers["x-goog-resource-state"]);
    const channelToken = firstHeaderValue(request.headers["x-goog-channel-token"]);
    const expirationAt = parseGoogleHeaderDate(firstHeaderValue(request.headers["x-goog-channel-expiration"]));
    if (channelId === undefined || channelId.length === 0 || resourceId === undefined || resourceId.length === 0) {
      return reply.code(HTTP_NO_CONTENT).send();
    }

    const subscription = await repositories().getCalendarSyncSubscriptionByChannel({
      provider: "google_calendar",
      channelId,
    });
    if (!subscription || subscription.resourceId !== resourceId) {
      return reply.code(HTTP_NO_CONTENT).send();
    }

    const isVerified = verifyCalendarWebhookToken({
      token: channelToken,
      userId: subscription.userId,
      connectorId: subscription.agentConnectorId,
      provider: "google_calendar",
      channelId,
    });
    if (!isVerified) {
      request.log.warn({ channelId }, "Rejected Google Calendar webhook with invalid channel token");

      return reply.code(HTTP_NO_CONTENT).send();
    }

    await repositories().markCalendarSyncSubscriptionNotification({
      id: subscription.id,
      messageNumber: messageNumber ?? null,
      expirationAt,
    });

    if (Boolean(resourceState) && resourceState !== "sync") {
      await repositories().publishCalendarRealtimeEvent({
        userId: subscription.userId,
        provider: "google_calendar",
        connectorId: subscription.agentConnectorId,
        calendarId: subscription.calendarId,
        resourceState,
        messageNumber: messageNumber ?? null,
        dedupeKey: `calendar:google_calendar:${channelId}:${messageNumber ?? randomUUID()}`,
      });
    }

    return reply.code(HTTP_NO_CONTENT).send();
  });
}

async function registerOutlookCalendarWebhookRoutes(webhookApp: FastifyInstance): Promise<void> {
  webhookApp.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    try {
      const rawBody = typeof body === "string" ? body : body.toString("utf8");
      const parsedBody = outlookCalendarWebhookBodySchema.safeParse(JSON.parse(rawBody));
      done(null, parsedBody.success ? parsedBody.data : null);
    } catch (error) {
      done(error instanceof Error ? error : new Error(MESSAGE_INVALID_OUTLOOK_WEBHOOK_JSON));
    }
  });

  webhookApp.post("/integrations/calendar/outlook_calendar/webhook", async (request, reply) => {
    const query = outlookCalendarWebhookQuerySchema.safeParse(request.query);
    const validationToken = query.success ? query.data.validationToken : undefined;
    if (validationToken !== undefined && validationToken.length > 0) {
      return reply.type("text/plain").send(validationToken);
    }

    const body = outlookCalendarWebhookBodySchema.safeParse(request.body);
    const notifications = body.success ? (body.data.value ?? []) : [];

    await notifications.reduce(async (previous, notification) => {
      await previous;
      const subscriptionId = typeof notification.subscriptionId === "string" ? notification.subscriptionId : null;
      const clientState = typeof notification.clientState === "string" ? notification.clientState : null;
      if (subscriptionId === null || clientState === null) {
        return;
      }

      const subscription = await repositories().getCalendarSyncSubscriptionByChannel({
        provider: "outlook_calendar",
        channelId: subscriptionId,
      });
      if (!subscription || subscription.resourceId !== clientState) {
        return;
      }

      const changeType = typeof notification.changeType === "string" ? notification.changeType : null;
      const resource = typeof notification.resource === "string" ? notification.resource : null;
      const resourceDataId = typeof notification.resourceData?.id === "string" ? notification.resourceData.id : null;
      await repositories().markCalendarSyncSubscriptionNotification({
        id: subscription.id,
        messageNumber: resourceDataId ?? null,
      });
      await repositories().publishCalendarRealtimeEvent({
        userId: subscription.userId,
        provider: "outlook_calendar",
        connectorId: subscription.agentConnectorId,
        calendarId: subscription.calendarId,
        resourceState: changeType,
        messageNumber: resourceDataId,
        dedupeKey: `calendar:outlook_calendar:${subscriptionId}:${changeType ?? "changed"}:${resourceDataId ?? resource ?? randomUUID()}`,
      });
    }, Promise.resolve());

    return reply.code(HTTP_ACCEPTED).send();
  });
}

async function registerIntegrationCalendarWebhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(registerGoogleCalendarWebhookRoutes);
  await app.register(registerOutlookCalendarWebhookRoutes);
}

async function handleListCalendarEventsRequest(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user;
  if (!user) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
  }
  const parsed = calendarEventsQuerySchema.safeParse(request.query ?? {});
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }

  const now = new Date();
  const defaultMax = new Date(
    now.getTime() +
      CALENDAR_EVENTS_DEFAULT_RANGE_DAYS *
        HOURS_PER_DAY *
        MINUTES_PER_HOUR *
        SECONDS_PER_MINUTE *
        MILLISECONDS_PER_SECOND,
  );
  const timeMin = parsed.data.timeMin ?? now.toISOString();
  const timeMax = parsed.data.timeMax ?? defaultMax.toISOString();
  const connectors = (await repositories().listAgentConnectorsForUser(user.id)).filter(
    (connector) =>
      (connector.provider === "google_calendar" || connector.provider === "outlook_calendar") &&
      connector.status === "connected" &&
      (parsed.data.provider === undefined || connector.provider === parsed.data.provider),
  );

  const photoPermissionMissingProviders = new Set<CalendarProvider>();
  const calendarResults = await Promise.all(
    connectors.map(async (connector) => {
      try {
        const tokens = await getUsableCalendarTokens({
          connector,
          userId: user.id,
        });
        if (tokens.provider === "google_calendar" && !hasGoogleCalendarPhotoScopes(tokens)) {
          photoPermissionMissingProviders.add(calendarConnectorProviderSchema.parse(tokens.provider));
        }
        await ensureCalendarSyncSubscription({
          connector,
          userId: user.id,
          tokens,
          log: request.log,
        });
        const connectorEvents = await listCalendarEvents(tokens, {
          timeMin,
          timeMax,
          /** @external calendar list include cancelled wire field */
          includeCancelled: parsed.data.includeCancelled,
          requestingUserId: user.id,
        });
        const decoratedEvents = await decorateCalendarEventsWithReadyMeetings({
          events: connectorEvents,
          connector,
          tokens,
          userId: user.id,
          workspaceId: user.workspaceId,
          logger: request.log,
        });

        return {
          connector,
          events: decoratedEvents,
        };
      } catch (error) {
        if (!isCalendarProviderAuthError(error)) {
          throw error;
        }
        await markCalendarConnectorDisconnectedForAuthFailure({
          connector,
          userId: user.id,
          error,
          log: request.log,
        });

        return { connector: null, events: [] };
      }
    }),
  );
  const usableConnectors = calendarResults
    .map((result) => result.connector)
    .filter((connector): connector is AgentConnectorRow => connector !== null);
  const events = calendarResults.flatMap((result) => result.events);

  const eventsWithReadyMeetAvatars = await addReadyMeetCalendarAvatarFallbacks(events);
  const sortedEvents = [...eventsWithReadyMeetAvatars].sort(
    (left, right) => Date.parse(left.start) - Date.parse(right.start),
  );
  const [prepSummaries, prepAccess] = await Promise.all([
    listExistingCalendarEventPrepSummaries({
      user,
      connectors: usableConnectors,
      events: eventsWithReadyMeetAvatars,
    }),
    getCalendarPrepAccessForUser(user.id),
  ]);

  return calendarEventsResponseSchema.parse({
    events: sortedEvents,
    connectedProviders: usableConnectors.map((connector) => connector.provider),
    /** @external calendar events needs connection wire field */
    needsConnection: usableConnectors.length === 0,
    photoPermissionMissingProviders: Array.from(photoPermissionMissingProviders),
    prepAccess,
    prepSummaries,
  });
}

async function registerIntegrationCalendarListEventsRoute(app: FastifyInstance): Promise<void> {
  app.get("/me/calendar/events", { preHandler: requireAuth }, handleListCalendarEventsRequest);
}

async function registerIntegrationCalendarDeleteCalendarEventRoute(app: FastifyInstance): Promise<void> {
  app.delete(
    "/me/calendar/accounts/:accountId/events/:providerEventId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
      }
      const parsedParams = deleteCalendarEventParamsSchema.safeParse(request.params ?? {});
      if (!parsedParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
      }
      const parsedQuery = deleteCalendarEventQuerySchema.safeParse(request.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsedQuery.error.message });
      }

      const connector = (await repositories().listAgentConnectorsForUser(user.id)).find(
        (candidate) =>
          candidate.id === parsedParams.data.accountId &&
          (candidate.provider === "google_calendar" || candidate.provider === "outlook_calendar"),
      );
      if (!connector) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_CALENDAR_ACCOUNT_NOT_FOUND });
      }
      if (connector.status !== "connected") {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_CALENDAR_ACCOUNT_IS_NOT_CONNECTED });
      }
      if (connector.provider !== "google_calendar") {
        return reply
          .code(HTTP_BAD_REQUEST)
          .send({ message: MESSAGE_CALENDAR_EVENT_DELETION_IS_CURRENTLY_AVAILABLE_FOR_GOOGLE_CALENDAR_ });
      }

      try {
        const tokens = await getUsableCalendarTokens({
          connector,
          userId: user.id,
        });
        await deleteGoogleCalendarEvent(tokens, {
          calendarId: parsedQuery.data.calendarId,
          eventId: parsedParams.data.providerEventId,
          sendUpdates: "none",
        });
        await repositories().publishCalendarRealtimeEvent({
          userId: user.id,
          provider: "google_calendar",
          connectorId: connector.id,
          calendarId: parsedQuery.data.calendarId,
          resourceState: "deleted",
          dedupeKey: `calendar:${user.id}:google_calendar:event-deleted:${connector.id}:${parsedParams.data.providerEventId}:${Date.now()}`,
        });

        return deleteCalendarEventResponseSchema.parse({
          /** @external delete calendar event ok wire field */
          ok: true,
          eventId: parsedParams.data.providerEventId,
        });
      } catch (error) {
        if (isCalendarProviderAuthError(error)) {
          await markCalendarConnectorDisconnectedForAuthFailure({
            connector,
            userId: user.id,
            error,
            log: request.log,
          });

          return reply
            .code(HTTP_UNAUTHORIZED)
            .send({ message: MESSAGE_GOOGLE_CALENDAR_NEEDS_TO_BE_RECONNECTED_BEFORE_DELETING_EVENTS });
        }

        request.log.warn(
          {
            error,
            connectorId: connector.id,
            calendarId: parsedQuery.data.calendarId,
            providerEventId: parsedParams.data.providerEventId,
          },
          "Failed to delete Google Calendar event",
        );

        return reply
          .code(HTTP_BAD_GATEWAY)
          .send({ message: MESSAGE_COULD_NOT_DELETE_THE_CALENDAR_EVENT_FROM_GOOGLE_CALENDAR });
      }
    },
  );
}

function addReadyMeetingToCalendarEventOkResponse(input: {
  calendarId: string;
  providerEventId: string;
  providerEventKey: string;
  patchedProviderEventId: string;
  readyMeeting: CalendarReadyMeeting;
  /** @external add ready meeting already added wire field */
  alreadyAdded: boolean;
}) {
  return addReadyMeetingToCalendarEventResponseSchema.parse({
    /** @external add ready meeting ok wire field */
    ok: true,
    eventId: calendarStableEventId({
      provider: "google_calendar",
      calendarId: input.calendarId,
      providerEventId: input.providerEventId,
    }),
    providerEventId: input.providerEventId,
    providerEventKey: input.providerEventKey,
    patchedProviderEventId: input.patchedProviderEventId,
    readyMeeting: input.readyMeeting,
    /** @external add ready meeting already added wire field */
    alreadyAdded: input.alreadyAdded,
  });
}

async function respondAddReadyMeetingWhenProviderEventHasCode(input: {
  user: { id: string; workspaceId: string };
  connector: CalendarConnector;
  parsedParams: z.infer<typeof addReadyMeetingToCalendarEventParamsSchema>;
  parsedBody: z.infer<typeof addReadyMeetingToCalendarEventRequestSchema>;
  providerEventKey: string;
  patchedProviderEventId: string;
  existingReadyCode: string;
  callInDeadline: number;
  log: FastifyBaseLogger;
}) {
  const meetingLink = await repositories().getMeetingLinkByCode(input.existingReadyCode);
  if (meetingLink !== null && meetingLink.workspaceId === input.user.workspaceId) {
    await createCalendarReadyLinkMappingIfMissing({
      userId: input.user.id,
      calendarAccountId: input.connector.id,
      provider: "google_calendar",
      calendarId: input.parsedBody.calendarId,
      providerEventKey: input.providerEventKey,
      meetingLinkId: meetingLink.id,
    });
    const callIn = await repositories().getMeetingLinkCallIn(meetingLink.id);
    const readyMeeting = await readyMeetingFromMeetingLinkWithCurrentCallIn({
      source: "provider_event",
      meetingLink,
      callIn,
      callInDeadline: input.callInDeadline,
      logger: input.log,
    });

    return addReadyMeetingToCalendarEventOkResponse({
      calendarId: input.parsedBody.calendarId,
      providerEventId: input.parsedParams.providerEventId,
      providerEventKey: input.providerEventKey,
      patchedProviderEventId: input.patchedProviderEventId,
      readyMeeting,
      alreadyAdded: true,
    });
  }

  const readyMeeting: CalendarReadyMeeting = {
    source: "provider_event",
    joinUrl: buildReadyMeetingJoinUrl(input.existingReadyCode),
    callIn: null,
  };

  return addReadyMeetingToCalendarEventOkResponse({
    calendarId: input.parsedBody.calendarId,
    providerEventId: input.parsedParams.providerEventId,
    providerEventKey: input.providerEventKey,
    patchedProviderEventId: input.patchedProviderEventId,
    readyMeeting,
    alreadyAdded: true,
  });
}

async function resolveReadyMeetingForAddToCalendarEvent(input: {
  user: { id: string; workspaceId: string };
  connector: CalendarConnector;
  parsedBody: z.infer<typeof addReadyMeetingToCalendarEventRequestSchema>;
  providerEventKey: string;
  providerEventSummary: unknown;
  callInDeadline: number;
  log: FastifyBaseLogger;
}) {
  const existingMapping = await repositories().getCalendarReadyLinkForProviderEvent({
    userId: input.user.id,
    calendarAccountId: input.connector.id,
    provider: "google_calendar",
    calendarId: input.parsedBody.calendarId,
    providerEventId: input.providerEventKey,
  });
  if (existingMapping) {
    const meetingLink = await repositories().getMeetingLinkById(existingMapping.meetingLinkId);
    if (meetingLink === null) {
      return { kind: "unavailable" as const };
    }
    const callIn = await repositories().getMeetingLinkCallIn(meetingLink.id);
    const readyMeeting = await readyMeetingFromMeetingLinkWithCurrentCallIn({
      source: "mapping",
      meetingLink,
      callIn,
      callInDeadline: input.callInDeadline,
      logger: input.log,
    });

    return { kind: "ready" as const, readyMeeting };
  }

  {
    const meetingAccess = await getMeetingHostingAccessForUser(input.user.id);
    if (!meetingAccess.canCreateStandardMeeting) {
      return { kind: "forbidden" as const };
    }

    const code = await generateUniqueMeetingLinkCode();
    const title =
      typeof input.providerEventSummary === "string" && input.providerEventSummary.trim().length > 0
        ? input.providerEventSummary.trim()
        : "Ready Meeting";
    const { meeting, meetingLink } = await repositories().createMeetingLinkWithInitialMeeting({
      title,
      code,
      createdByUserId: input.user.id,
      workspaceId: input.user.workspaceId,
    });
    const callIn = await waitForSyncedCallInForMeeting({
      input: {
        meeting,
        meetingLink,
        logger: input.log,
      },
      timeoutMs: Math.max(0, input.callInDeadline - Date.now()),
    });
    const mapping = await createCalendarReadyLinkMappingIfMissing({
      userId: input.user.id,
      calendarAccountId: input.connector.id,
      provider: "google_calendar",
      calendarId: input.parsedBody.calendarId,
      providerEventKey: input.providerEventKey,
      meetingLinkId: meetingLink.id,
    });
    const readyMeeting = await (async () => {
      if (mapping.meetingLinkId === meetingLink.id) {
        return readyMeetingFromMeetingLink({
          source: "mapping",
          meetingLink,
          callIn,
        });
      }
      const racedMeetingLink = await repositories().getMeetingLinkById(mapping.meetingLinkId);
      if (racedMeetingLink === null) {
        return readyMeetingFromMeetingLink({
          source: "mapping",
          meetingLink,
          callIn,
        });
      }
      const racedCallIn = await repositories().getMeetingLinkCallIn(racedMeetingLink.id);

      return readyMeetingFromMeetingLinkWithCurrentCallIn({
        source: "mapping",
        meetingLink: racedMeetingLink,
        callIn: racedCallIn,
        callInDeadline: input.callInDeadline,
        logger: input.log,
      });
    })();

    return { kind: "ready" as const, readyMeeting };
  }
}

async function publishReadyMeetingOnGoogleCalendarEvent(input: {
  user: { id: string };
  connector: CalendarConnector;
  parsedParams: z.infer<typeof addReadyMeetingToCalendarEventParamsSchema>;
  parsedBody: z.infer<typeof addReadyMeetingToCalendarEventRequestSchema>;
  providerEventKey: string;
  patchedProviderEventId: string;
  tokens: CalendarTokenSet;
  providerEvent: Awaited<ReturnType<typeof getGoogleCalendarEvent>>;
  readyMeeting: CalendarReadyMeeting;
}) {
  await patchGoogleCalendarEventWithReadyMeeting(input.tokens, {
    calendarId: input.parsedBody.calendarId,
    eventId: input.patchedProviderEventId,
    event: input.providerEvent,
    joinUrl: input.readyMeeting.joinUrl,
    callIn: input.readyMeeting.callIn ?? null,
    sendUpdates: "none",
  });
  await repositories().publishCalendarRealtimeEvent({
    userId: input.user.id,
    provider: "google_calendar",
    connectorId: input.connector.id,
    calendarId: input.parsedBody.calendarId,
    resourceState: "updated",
    dedupeKey: `calendar:${input.user.id}:google_calendar:ready-meeting-added:${input.connector.id}:${input.providerEventKey}:${Date.now()}`,
  });

  return addReadyMeetingToCalendarEventOkResponse({
    calendarId: input.parsedBody.calendarId,
    providerEventId: input.parsedParams.providerEventId,
    providerEventKey: input.providerEventKey,
    patchedProviderEventId: input.patchedProviderEventId,
    readyMeeting: input.readyMeeting,
    alreadyAdded: false,
  });
}

async function addReadyMeetingAfterProviderEventLoaded(input: {
  user: { id: string; workspaceId: string };
  connector: CalendarConnector;
  parsedParams: z.infer<typeof addReadyMeetingToCalendarEventParamsSchema>;
  parsedBody: z.infer<typeof addReadyMeetingToCalendarEventRequestSchema>;
  providerEventKey: string;
  patchedProviderEventId: string;
  tokens: CalendarTokenSet;
  providerEvent: Awaited<ReturnType<typeof getGoogleCalendarEvent>>;
  normalizedProviderEvent: NormalizedCalendarEvent;
  callInDeadline: number;
  log: FastifyBaseLogger;
  reply: FastifyReply;
}) {
  const readyMeetingJoinUrl = input.normalizedProviderEvent.readyMeeting?.joinUrl;
  const existingReadyCode =
    readyMeetingJoinUrl !== undefined && readyMeetingJoinUrl.length > 0
      ? extractReadyMeetingCodeFromUrl(readyMeetingJoinUrl)
      : null;
  if (existingReadyCode !== null && existingReadyCode.length > 0) {
    return respondAddReadyMeetingWhenProviderEventHasCode({
      user: input.user,
      connector: input.connector,
      parsedParams: input.parsedParams,
      parsedBody: input.parsedBody,
      providerEventKey: input.providerEventKey,
      patchedProviderEventId: input.patchedProviderEventId,
      existingReadyCode,
      callInDeadline: input.callInDeadline,
      log: input.log,
    });
  }

  if (!(input.normalizedProviderEvent.canAddReadyMeeting ?? false)) {
    return input.reply.code(HTTP_FORBIDDEN).send({
      code: CODE_CALENDAR_EVENT_NOT_EDITABLE,
      message: MESSAGE_GOOGLE_CALENDAR_DID_NOT_ALLOW_THIS_EVENT_TO_BE_EDITED_ASK_THE_ORGAN,
    });
  }

  const resolvedReadyMeeting = await resolveReadyMeetingForAddToCalendarEvent({
    user: input.user,
    connector: input.connector,
    parsedBody: input.parsedBody,
    providerEventKey: input.providerEventKey,
    providerEventSummary: input.providerEvent.summary,
    callInDeadline: input.callInDeadline,
    log: input.log,
  });
  if (resolvedReadyMeeting.kind === "forbidden") {
    return input.reply.code(HTTP_FORBIDDEN).send({
      code: CODE_MEETING_PLAN_REQUIRED,
      message: MESSAGE_MEETING_ACCESS_IS_REQUIRED_TO_CREATE_MORE_MEETING_ROOMS,
    });
  }
  if (resolvedReadyMeeting.kind === "unavailable") {
    return input.reply
      .code(HTTP_CONFLICT)
      .send({ message: MESSAGE_READY_MEETING_LINK_FOR_THIS_CALENDAR_EVENT_IS_UNAVAILABLE });
  }

  return publishReadyMeetingOnGoogleCalendarEvent({
    user: input.user,
    connector: input.connector,
    parsedParams: input.parsedParams,
    parsedBody: input.parsedBody,
    providerEventKey: input.providerEventKey,
    patchedProviderEventId: input.patchedProviderEventId,
    tokens: input.tokens,
    providerEvent: input.providerEvent,
    readyMeeting: resolvedReadyMeeting.readyMeeting,
  });
}

async function executeAddReadyMeetingToCalendarEvent(input: {
  user: { id: string; workspaceId: string };
  connector: CalendarConnector;
  parsedParams: z.infer<typeof addReadyMeetingToCalendarEventParamsSchema>;
  parsedBody: z.infer<typeof addReadyMeetingToCalendarEventRequestSchema>;
  providerEventKey: string;
  patchedProviderEventId: string;
  log: FastifyBaseLogger;
  reply: FastifyReply;
}) {
  try {
    const tokens = await getUsableCalendarTokens({
      connector: input.connector,
      userId: input.user.id,
    });
    if (!hasGoogleCalendarEventsScope(tokens)) {
      return await input.reply.code(HTTP_FORBIDDEN).send({
        code: CALENDAR_WRITE_SCOPE_REQUIRED_CODE,
        message: MESSAGE_GOOGLE_CALENDAR_WRITE_PERMISSION_IS_REQUIRED_TO_ADD_READY_MEETING_C,
      });
    }

    const providerEvent = await getGoogleCalendarEvent(tokens, {
      calendarId: input.parsedBody.calendarId,
      eventId: input.patchedProviderEventId,
    });

    return await addReadyMeetingAfterProviderEventLoaded({
      user: input.user,
      connector: input.connector,
      parsedParams: input.parsedParams,
      parsedBody: input.parsedBody,
      providerEventKey: input.providerEventKey,
      patchedProviderEventId: input.patchedProviderEventId,
      tokens,
      providerEvent,
      normalizedProviderEvent: normalizeGoogleCalendarEvent(providerEvent),
      callInDeadline: Date.now() + CALENDAR_EVENT_CALL_IN_WAIT_MS,
      log: input.log,
      reply: input.reply,
    });
  } catch (error) {
    if (isCalendarProviderAuthError(error)) {
      await markCalendarConnectorDisconnectedForAuthFailure({
        connector: input.connector,
        userId: input.user.id,
        error,
        log: input.log,
      });

      return input.reply.code(HTTP_UNAUTHORIZED).send({
        code: CODE_CALENDAR_RECONNECT_REQUIRED,
        message: MESSAGE_GOOGLE_CALENDAR_CONNECTION_EXPIRED_OR_REVOKED,
      });
    }
    input.log.error(
      { error, providerEventKey: input.providerEventKey },
      "Failed to add Ready Meeting conferencing to calendar event",
    );
    const failure = getCalendarReadyMeetingError(error);

    return input.reply.code(failure.status).send({ code: failure.code, message: failure.message });
  }
}

async function handleAddReadyMeetingToCalendarEventRequest(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user;
  if (!user) {
    return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
  }
  const parsedParams = addReadyMeetingToCalendarEventParamsSchema.safeParse(request.params ?? {});
  if (!parsedParams.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
  }
  const parsedBody = addReadyMeetingToCalendarEventRequestSchema.safeParse(request.body);
  if (!parsedBody.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsedBody.error.message });
  }

  const connector = (await repositories().listAgentConnectorsForUser(user.id)).find(
    (candidate) =>
      candidate.id === parsedParams.data.accountId &&
      (candidate.provider === "google_calendar" || candidate.provider === "outlook_calendar"),
  );
  if (!connector) {
    return reply.code(HTTP_NOT_FOUND).send({
      code: CODE_CALENDAR_ACCOUNT_NOT_FOUND,
      message: MESSAGE_THIS_CALENDAR_ACCOUNT_IS_NO_LONGER_CONNECTED_TO_READY_RECONNECT_GOO,
    });
  }
  if (connector.status !== "connected") {
    return reply.code(HTTP_CONFLICT).send({
      code: CODE_CALENDAR_ACCOUNT_DISCONNECTED,
      message: MESSAGE_RECONNECT_GOOGLE_CALENDAR_BEFORE_ADDING_A_VIDEO_CALL,
    });
  }
  if (connector.provider !== "google_calendar") {
    return reply.code(HTTP_BAD_REQUEST).send({
      code: CODE_CALENDAR_PROVIDER_UNSUPPORTED,
      message: MESSAGE_ADDING_A_VIDEO_CALL_FROM_READY_IS_CURRENTLY_SUPPORTED_FOR_GOOGLE_CA,
    });
  }

  const providerEventKey = providerEventKeyFromIds({
    providerEventId: parsedParams.data.providerEventId,
    providerRecurringEventId: parsedBody.data.providerRecurringEventId,
  });
  const patchedProviderEventId = parsedBody.data.providerRecurringEventId ?? parsedParams.data.providerEventId;

  return executeAddReadyMeetingToCalendarEvent({
    user,
    connector,
    parsedParams: parsedParams.data,
    parsedBody: parsedBody.data,
    providerEventKey,
    patchedProviderEventId,
    log: request.log,
    reply,
  });
}

async function registerIntegrationCalendarAddReadyMeetingRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/me/calendar/accounts/:accountId/events/:providerEventId/ready-meeting",
    { preHandler: requireAuth },
    handleAddReadyMeetingToCalendarEventRequest,
  );
}

async function registerIntegrationCalendarEventsRoutes(app: FastifyInstance): Promise<void> {
  await registerIntegrationCalendarListEventsRoute(app);
  await registerIntegrationCalendarDeleteCalendarEventRoute(app);
  await registerIntegrationCalendarAddReadyMeetingRoute(app);
}

async function registerIntegrationCalendarPrepRoutes(app: FastifyInstance): Promise<void> {
  app.post("/me/calendar/prep/estimate", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = calendarEventPrepEstimateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    const calendarConnectors = await listConnectedCalendarConnectorsForUser(user.id);
    try {
      return await buildCalendarPrepEstimate({
        user,
        connectors: calendarConnectors,
        event: parsed.data.event,
      });
    } catch (error) {
      request.log.warn({ error }, "Failed to estimate calendar meeting prep");

      return reply.code(HTTP_INTERNAL_SERVER_ERROR).send({ message: MESSAGE_FAILED_TO_ESTIMATE_MEETING_PREP });
    }
  });

  app.post("/me/calendar/prep", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = calendarEventPrepRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    const calendarConnectors = await listConnectedCalendarConnectorsForUser(user.id);
    try {
      const row = await ensureCalendarEventPrepForEvent({
        user,
        connectors: calendarConnectors,
        event: parsed.data.event,
        mode: "interactive",
        processor: parsed.data.processor ?? null,
        refreshActive: true,
        retryFailed: true,
        log: request.log,
      });

      return calendarEventPrepResponseSchema.parse(responseFromPrepRow(row));
    } catch (error) {
      if (error instanceof CalendarPrepPlanRequiredError) {
        return reply.code(HTTP_FORBIDDEN).send({
          code: error.code,
          message: error.message,
          prepAccess: error.prepAccess,
        });
      }
      if (error instanceof CalendarPrepCreditsRequiredError) {
        return reply.code(HTTP_PAYMENT_REQUIRED).send({
          code: error.code,
          message: error.message,
          creditAccess: error.creditAccess,
        });
      }
      request.log.warn({ error }, "Failed to ensure calendar meeting prep");

      return reply.code(HTTP_INTERNAL_SERVER_ERROR).send({ message: MESSAGE_FAILED_TO_START_MEETING_PREP });
    }
  });

  app.get("/me/calendar/prep/:prepId", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsedParams = calendarPrepIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
    }
    const prepId = parsedParams.data.prepId.trim();
    if (prepId.length === 0) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_MISSING_PREP_ID });
    }

    const row = await repositories().getCalendarEventPrepByIdForUser({
      id: prepId,
      userId: user.id,
    });
    if (!row) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_PREP_NOT_FOUND });
    }

    try {
      const refreshed = await refreshCalendarEventPrep({ row, log: request.log });

      return calendarEventPrepResponseSchema.parse(responseFromPrepRow(refreshed ?? row));
    } catch (error) {
      request.log.warn({ error, prepId }, "Failed to refresh Parallel meeting prep");

      return calendarEventPrepResponseSchema.parse(responseFromPrepRow(row));
    }
  });
}

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  await registerIntegrationLinearRoutes(app);
  await registerIntegrationCalendarOAuthRoutes(app);
  await registerIntegrationCalendarDisconnectRoutes(app);
  await registerIntegrationCalendarWebhookRoutes(app);
  await registerIntegrationCalendarEventsRoutes(app);
  await registerIntegrationCalendarPrepRoutes(app);
}

function normalizeReturnTo(returnTo: string | undefined) {
  if (returnTo === undefined || returnTo.length === 0) {
    return undefined;
  }

  try {
    const target = new URL(returnTo, apiEnv.NEXT_PUBLIC_WEB_URL);
    const webOrigin = new URL(apiEnv.NEXT_PUBLIC_WEB_URL).origin;
    if (target.origin !== webOrigin) {
      return undefined;
    }

    return target.toString();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return undefined;
  }
}

function withLinearStatus(input: { returnTo: string; status: "connected" | "error" }) {
  const target = new URL(input.returnTo, apiEnv.NEXT_PUBLIC_WEB_URL);
  target.searchParams.set("linear", input.status);

  return target.toString();
}

function safeVerifyLinearState(input: { state: string }) {
  try {
    return verifyLinearState(input);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return null;
  }
}

function safeVerifyCalendarState(input: { state: string }) {
  try {
    return verifyCalendarState(input);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return null;
  }
}

export async function markCalendarConnectorDisconnectedForAuthFailure(input: {
  connector: Pick<AgentConnectorRow, "id" | "provider" | "updatedAt">;
  userId: string;
  error?: CalendarProviderAuthError;
  log?: Pick<FastifyBaseLogger, "warn">;
  dependencies?: {
    disconnect: (disconnectInput: {
      userId: string;
      accountId: string;
      /** @external preserve pending calendar grant wire field */
      preservePending: true;
      expectedUpdatedAt: Date;
    }) => Promise<{ id: string; updatedAt: string } | null>;
    markInactive: (connectorId: string) => Promise<unknown>;
    enqueue: (event: Parameters<RepositoryPort["publishCalendarRealtimeEvent"]>[0]) => Promise<unknown>;
  };
}): Promise<void> {
  const dependencies = input.dependencies ?? {
    disconnect: repositories().disconnectCalendarAccount,
    markInactive: repositories().markCalendarSyncSubscriptionsInactiveForConnector,
    enqueue: repositories().publishCalendarRealtimeEvent,
  };
  const provider = calendarConnectorProviderSchema.parse(input.connector.provider);
  // An automatic failure of the active grant is not a user request to discard
  // a fresh pending grant. Keep the latter available for verified recovery.
  const connector = await dependencies.disconnect({
    userId: input.userId,
    accountId: input.connector.id,
    /** @external preserve pending calendar grant wire field */
    preservePending: true,
    expectedUpdatedAt: input.connector.updatedAt,
  });
  if (!connector) {
    return;
  }
  await dependencies.markInactive(connector.id);
  await dependencies.enqueue({
    userId: input.userId,
    provider,
    connectorId: connector.id,
    calendarId: CALENDAR_SYNC_CALENDAR_ID,
    resourceState: "disconnected",
    dedupeKey: `calendar:${input.userId}:${provider}:auth-failed:${connector.updatedAt}`,
  });
  input.log?.warn(
    {
      provider,
      connectorId: connector.id,
      reason: input.error?.message ?? null,
      status: input.error?.status ?? null,
    },
    "Active Calendar access is unavailable; pending credentials are retained for recovery",
  );
}

async function getUsableCalendarTokens(input: { connector: AgentConnectorRow; userId: string }) {
  const secret = await repositories().getLatestAgentConnectorSecret(input.connector.id);
  if (!secret) {
    throw new Error(MESSAGE_CALENDAR_CONNECTOR_MISSING_CREDENTIALS);
  }
  const tokenState = {
    value: decryptCalendarTokenSecret(secret.secretRef),
  };
  if (shouldRefreshCalendarToken(tokenState.value)) {
    tokenState.value = await refreshCalendarToken(tokenState.value);
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
      scopes:
        typeof tokenState.value.scope === "string"
          ? tokenState.value.scope.split(/[,\s]+/).filter((scopePart) => scopePart.length > 0)
          : [],
      accountKind: input.connector.accountKind === "personal" ? "personal" : "work",
      secretRef: encryptJsonSecret(tokenState.value),
    });
  }

  return tokenState.value;
}

async function createActiveCalendarSyncSubscriptionRecord(input: {
  connector: AgentConnectorRow;
  userId: string;
  tokens: CalendarTokenSet;
  activeWebhookAddress: string;
}) {
  if (input.tokens.provider === "outlook_calendar") {
    const expirationAt = new Date(Date.now() + OUTLOOK_CALENDAR_SUBSCRIPTION_TTL_MS);
    const clientState = signOutlookClientState({
      userId: input.userId,
      connectorId: input.connector.id,
      provider: input.tokens.provider,
    });
    const subscription = await watchOutlookCalendarEvents(input.tokens, {
      notificationUrl: input.activeWebhookAddress,
      clientState,
      expirationAt,
    });

    if (subscription.subscriptionId.length === 0) {
      throw new Error(MESSAGE_OUTLOOK_CALENDAR_SUBSCRIPTION_MISSING_ID);
    }

    return repositories().upsertCalendarSyncSubscription({
      userId: input.userId,
      agentConnectorId: input.connector.id,
      provider: input.tokens.provider,
      calendarId: CALENDAR_SYNC_CALENDAR_ID,
      channelId: subscription.subscriptionId,
      webhookAddress: input.activeWebhookAddress,
      resourceId: clientState,
      resourceUri: subscription.resource,
      expirationAt: subscription.expirationAt,
      status: "active",
    });
  }

  const channelId = randomUUID();
  const expirationAt = new Date(Date.now() + GOOGLE_CALENDAR_WATCH_TTL_MS);
  const channelToken = signCalendarWebhookToken({
    userId: input.userId,
    connectorId: input.connector.id,
    provider: input.tokens.provider,
    channelId,
  });
  const watch = await watchGoogleCalendarEvents(input.tokens, {
    calendarId: CALENDAR_SYNC_CALENDAR_ID,
    channelId,
    address: input.activeWebhookAddress,
    token: channelToken,
    expirationAt,
  });

  return repositories().upsertCalendarSyncSubscription({
    userId: input.userId,
    agentConnectorId: input.connector.id,
    provider: input.tokens.provider,
    calendarId: CALENDAR_SYNC_CALENDAR_ID,
    channelId: watch.channelId,
    webhookAddress: input.activeWebhookAddress,
    resourceId: watch.resourceId,
    resourceUri: watch.resourceUri,
    expirationAt: watch.expirationAt,
    status: "active",
  });
}

async function ensureCalendarSyncSubscription(input: {
  connector: AgentConnectorRow;
  userId: string;
  tokens: CalendarTokenSet;
  log?: Pick<FastifyBaseLogger, "debug" | "warn">;
}) {
  const log = calendarSyncSubscriptionLoggerFromFastify(input.log);
  if (input.connector.status !== "connected") {
    return null;
  }

  const webhookAddress = calendarWebhookAddress(input.tokens.provider);
  const disabledSyncAction = calendarSyncSubscriptionAction({
    currentWebhookAddress: webhookAddress,
    hasActiveSubscription: false,
  });
  if (disabledSyncAction === "skip") {
    log?.debug?.({
      bindings: {
        provider: input.tokens.provider,
        calendarWebhookBaseUrl: apiEnv.CALENDAR_WEBHOOK_BASE_URL.length > 0 ? apiEnv.CALENDAR_WEBHOOK_BASE_URL : null,
      },
      message: MESSAGE_CALENDAR_WEBHOOK_SYNC_SKIPPED_HTTPS_BASE_URL,
    });

    return null;
  }
  if (webhookAddress === null) {
    return null;
  }
  const activeWebhookAddress = webhookAddress;

  const existing = await repositories().getActiveCalendarSyncSubscriptionForConnector({
    agentConnectorId: input.connector.id,
    calendarId: CALENDAR_SYNC_CALENDAR_ID,
    renewWithinMs: CALENDAR_SYNC_RENEW_WITHIN_MS,
  });
  if (existing) {
    const syncAction = calendarSyncSubscriptionAction({
      currentWebhookAddress: activeWebhookAddress,
      hasActiveSubscription: true,
      storedWebhookAddress: existing.webhookAddress,
    });
    if (syncAction === "reuse") {
      return existing;
    }
    await repositories().markCalendarSyncSubscriptionInactive(existing.id);
    log?.debug?.({
      bindings: {
        provider: input.tokens.provider,
        connectorId: input.connector.id,
        previousWebhookAddress: existing.webhookAddress,
        nextWebhookAddress: activeWebhookAddress,
      },
      message: MESSAGE_CALENDAR_WEBHOOK_ADDRESS_CHANGED_RECREATING_SYNC,
    });
  }

  try {
    return await createActiveCalendarSyncSubscriptionRecord({
      connector: input.connector,
      userId: input.userId,
      tokens: input.tokens,
      activeWebhookAddress,
    });
  } catch (error) {
    log?.warn?.({
      bindings: {
        error,
        provider: input.tokens.provider,
        connectorId: input.connector.id,
      },
      message: MESSAGE_FAILED_TO_ESTABLISH_CALENDAR_WEBHOOK_SYNC,
    });

    return null;
  }
}

function renderLinearCallbackPage(input: { status: "connected" | "error"; returnTo: string }) {
  const targetOrigin = new URL(apiEnv.NEXT_PUBLIC_WEB_URL).origin;
  const returnTo = withLinearStatus({ returnTo: input.returnTo, status: input.status });
  const messageType = input.status === "connected" ? "readymeet.linear.connected" : "readymeet.linear.error";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Linear connected</title>
  </head>
  <body>
    <p>${input.status === "connected" ? "Linear connected. You can close this window." : "Linear connection failed. You can close this window."}</p>
    <script>
      (function () {
        var message = ${JSON.stringify({ type: messageType })};
        var targetOrigin = ${JSON.stringify(targetOrigin)};
        var returnTo = ${JSON.stringify(returnTo)};
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(message, targetOrigin);
          window.close();
          window.setTimeout(function () {
            window.location.replace(returnTo);
          }, 500);
          return;
        }
        window.location.replace(returnTo);
      })();
    </script>
  </body>
</html>`;
}

function withCalendarStatus(input: { returnTo: string; status: "connected" | "error"; provider: CalendarProvider }) {
  const target = new URL(input.returnTo, apiEnv.NEXT_PUBLIC_WEB_URL);
  target.searchParams.set("calendar", input.status);
  target.searchParams.set("calendarProvider", input.provider);

  return target.toString();
}

function renderCalendarCallbackPage(input: {
  status: "connected" | "error";
  provider: CalendarProvider;
  returnTo: string;
}) {
  const targetOrigin = new URL(apiEnv.NEXT_PUBLIC_WEB_URL).origin;
  const returnTo = withCalendarStatus({
    returnTo: input.returnTo,
    status: input.status,
    provider: input.provider,
  });
  const messageType = input.status === "connected" ? "readymeet.calendar.connected" : "readymeet.calendar.error";
  const label = input.provider === "google_calendar" ? "Google Calendar" : "Outlook Calendar";
  const fallbackMessage =
    input.status === "connected"
      ? `${label} connected. Returning to Ready...`
      : `${label} connection failed. Returning to Ready...`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${label} connected</title>
    <script>
      (function () {
        var message = ${JSON.stringify({ type: messageType, provider: input.provider })};
        var targetOrigin = ${JSON.stringify(targetOrigin)};
        var returnTo = ${JSON.stringify(returnTo)};
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(message, targetOrigin);
          window.close();
          window.setTimeout(function () {
            window.location.replace(returnTo);
          }, 500);
          return;
        }
        window.location.replace(returnTo);
      })();
    </script>
    <style>
      html,
      body {
        margin: 0;
        min-height: 100%;
        background: #f8f9f9;
        color: #17212b;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        display: grid;
        place-items: center;
      }
      p {
        margin: 0;
        color: #66727d;
        font-size: 13px;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <p>${fallbackMessage}</p>
  </body>
</html>`;
}

function hasTaskGroupId<T extends { taskgroupId?: string | null }>(refs: T): refs is T & { taskgroupId: string } {
  return typeof refs.taskgroupId === "string" && refs.taskgroupId.length > 0;
}

function decryptCalendarTokenSecret(secretRef: string): CalendarTokenSet {
  return decryptStoredJsonSecret({ secretRef, schema: z.custom<CalendarTokenSet>(isStoredJsonObject) });
}

function decryptPendingGoogleAddonCalendarSecret(secretRef: string): PendingGoogleAddonCalendarCredentials {
  return decryptStoredJsonSecret({
    secretRef,
    schema: z.custom<PendingGoogleAddonCalendarCredentials>(isStoredJsonObject),
  });
}
