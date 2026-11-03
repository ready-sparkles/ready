import {
  createCalendarAddonConferenceResponseSchema,
  createGoogleAddonConferenceRequestSchema,
  createOutlookAddonConferenceRequestSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";

import { publishGoogleCalendarDescription } from "../../../../../application/calendar-description-worker";
import {
  getSyncedCallInForMeeting,
  toMeetingDTO,
  toMeetingLinkDTO,
  waitForSyncedCallInForMeeting,
} from "../../../../../application/meeting-dto";
import { generateUniqueMeetingLinkCode } from "../../../../../composition/meeting-link-codes";
import { bindPortFunction } from "../../../../../ports/bind-port";
import { repositories } from "../../../../../ports/repository-runtime";
import { requireAuth } from "../../plugins/auth";
import { getMeetingHostingAccessForUser } from "../../support/meeting-access";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const CALENDAR_ADDON_CALL_IN_WAIT_MS = 2_500;

const MESSAGE_UNAUTHORIZED = "Unauthorized";
const LOG_CALENDAR_ADDON_CONFERENCE_READY = "Calendar add-on conference ready";
const MESSAGE_INVALID_CALENDAR_MEETING_REQUEST = "Invalid calendar meeting request.";
const CODE_MEETING_PLAN_REQUIRED = "meeting_plan_required";
const MESSAGE_MEETING_ACCESS_REQUIRED = "Meeting access is required to create more meeting rooms.";
const CODE_MEETING_LINK_UNAVAILABLE = "meeting_link_unavailable";
const MESSAGE_MEETING_LINK_UNAVAILABLE = "Ready meeting link is no longer available. Reopen the add-in to try again.";

const defaults = {
  requireAuth,
  getMeetingHostingAccessForUser,
  createOrReuseCalendarAddonConference: bindPortFunction(() => repositories().createOrReuseCalendarAddonConference),
  resolveMeetingLink: bindPortFunction(() => repositories().resolveMeetingLink),
  generateUniqueMeetingLinkCode,
  getSyncedCallInForMeeting,
  waitForSyncedCallInForMeeting,
  publishGoogleCalendarDescription,
};

type CalendarAddonDependencies = typeof defaults;
type GoogleAddonConferenceRequest = z.infer<typeof createGoogleAddonConferenceRequestSchema>;
type CalendarAddonConferenceResponse = z.infer<typeof createCalendarAddonConferenceResponseSchema>;
type CalendarAddonProvider = "google-calendar-addon" | "outlook-addon";
type CalendarAddonConferenceSource = "outlook-addon" | "google-workspace-addon";

function hasNonemptyGoogleCalendarAccessToken(
  google: GoogleAddonConferenceRequest | null,
): google is GoogleAddonConferenceRequest & { calendarAccessToken: string } {
  return google !== null && google.calendarAccessToken !== undefined && google.calendarAccessToken !== "";
}

function buildGoogleCalendarDescriptionOnReady(params: {
  deps: CalendarAddonDependencies;
  user: NonNullable<FastifyRequest["user"]>;
  google: GoogleAddonConferenceRequest;
}): (meetingLinkId: string) => Promise<void> {
  const { deps, user, google } = params;
  const accessToken = google.calendarAccessToken ?? "";
  const email = user.email;
  const webBaseUrl = google.calendarWebBaseUrl ?? "";

  return async (meetingLinkId) => {
    if (accessToken === "" || email === "") {
      return;
    }
    await deps.publishGoogleCalendarDescription({
      userId: user.id,
      meetingLinkId,
      calendarId: google.calendarId,
      eventId: google.eventId,
      accessToken,
      email,
      webBaseUrl,
    });
  };
}

async function runCalendarAddonConference(params: {
  deps: CalendarAddonDependencies;
  request: FastifyRequest;
  input: { title: string; idempotencyKey: string; source: CalendarAddonConferenceSource };
  onReady?: (linkId: string) => Promise<void>;
}): Promise<CalendarAddonConferenceResponse | null> {
  const { deps, request, input, onReady } = params;
  const startedAt = Date.now();
  const user = request.user;
  if (user === undefined) {
    throw new Error(MESSAGE_UNAUTHORIZED);
  }
  const created = await deps.createOrReuseCalendarAddonConference({
    title: input.title,
    code: await deps.generateUniqueMeetingLinkCode(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
    idempotencyKey: input.idempotencyKey,
    replaceInactive: input.source === "outlook-addon",
  });
  const resolved = created.meeting
    ? { meeting: created.meeting, meetingLink: created.meetingLink }
    : await deps.resolveMeetingLink({ code: created.meetingLink.code });
  if (!resolved || resolved.meetingLink.status !== "active") {
    return null;
  }
  const immediateCallIn = await deps.getSyncedCallInForMeeting({
    meeting: resolved.meeting,
    meetingLink: resolved.meetingLink,
  });
  const callIn =
    immediateCallIn ??
    (await deps.waitForSyncedCallInForMeeting({
      input: {
        meeting: resolved.meeting,
        meetingLink: resolved.meetingLink,
        logger: request.log,
      },
      timeoutMs: CALENDAR_ADDON_CALL_IN_WAIT_MS,
    }));
  await onReady?.(resolved.meetingLink.id);
  const meetingLink = { ...resolved.meetingLink, callIn };
  request.log.info(
    {
      userId: user.id,
      meetingId: resolved.meeting.id,
      meetingLinkId: meetingLink.id,
      /** @external wire */ reused: created.reused,
      hasCallIn: Boolean(callIn),
      durationMs: Date.now() - startedAt,
      source: input.source,
    },
    LOG_CALENDAR_ADDON_CONFERENCE_READY,
  );

  return createCalendarAddonConferenceResponseSchema.parse({
    meeting: toMeetingDTO({ ...resolved.meeting, meetingLink }),
    meetingLink: toMeetingLinkDTO(meetingLink),
    /** @external wire */ reused: created.reused,
  });
}

function resolveCalendarAddonIdempotencyKey(params: {
  google: GoogleAddonConferenceRequest | null;
  data: GoogleAddonConferenceRequest | z.infer<typeof createOutlookAddonConferenceRequestSchema>;
}) {
  const { google, data } = params;
  if (google !== null) {
    return repositories().googleAddonConferenceIdempotencyKey(google);
  }

  return repositories().outlookAddonConferenceIdempotencyKey(
    createOutlookAddonConferenceRequestSchema.parse(data).requestId,
  );
}

function registerCalendarAddonProviderRoute(params: {
  app: FastifyInstance;
  deps: CalendarAddonDependencies;
  provider: CalendarAddonProvider;
}) {
  const { app, deps, provider } = params;
  app.post(`/meetings/${provider}`, { preHandler: deps.requireAuth }, async (request, reply) => {
    const schema =
      provider === "outlook-addon"
        ? createOutlookAddonConferenceRequestSchema
        : createGoogleAddonConferenceRequestSchema;
    const parsed = schema.safeParse(request.body);
    const user = request.user;
    if (!parsed.success || user === undefined) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_CALENDAR_MEETING_REQUEST });
    }
    const access = await deps.getMeetingHostingAccessForUser(user.id);
    if (!access.canCreateStandardMeeting) {
      return reply.code(HTTP_FORBIDDEN).send({
        code: CODE_MEETING_PLAN_REQUIRED,
        message: MESSAGE_MEETING_ACCESS_REQUIRED,
      });
    }
    const data = parsed.data;
    const google = "calendarId" in data ? data : null;
    const onReady = hasNonemptyGoogleCalendarAccessToken(google)
      ? buildGoogleCalendarDescriptionOnReady({ deps, user, google })
      : undefined;
    const result = await runCalendarAddonConference({
      deps,
      request,
      input: {
        title: data.title,
        idempotencyKey: resolveCalendarAddonIdempotencyKey({ google, data }),
        source: google !== null ? "google-workspace-addon" : "outlook-addon",
      },
      onReady,
    });
    if (result === null) {
      return reply.code(HTTP_CONFLICT).send({
        code: CODE_MEETING_LINK_UNAVAILABLE,
        message: MESSAGE_MEETING_LINK_UNAVAILABLE,
      });
    }

    return result;
  });
}

export async function calendarAddonRoutes(
  ...args: [app: FastifyInstance, dependencies?: Partial<typeof defaults>]
): Promise<void> {
  const [app, dependencies = {}] = args;
  const deps = { ...defaults, ...dependencies };
  (["google-calendar-addon", "outlook-addon"] as const).forEach((provider) => {
    registerCalendarAddonProviderRoute({ app, deps, provider });
  });
}
