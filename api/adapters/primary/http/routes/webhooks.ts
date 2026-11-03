import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ensureMeetingAssistantCoverage,
  scheduleAssistantCoverageRecheck,
  scheduleMeetingFinalizationIfIdle,
} from "../../../../application/meeting-lifecycle";
import { generateFinalizedMeetingMemories } from "../../../../application/relationship-memory";
import { isCallInHoldingRoomName } from "../../../../domain/call-in-holding-room";
import { repositories } from "../../../../ports/repository-runtime";
import { handleCallInHoldingRoomEvent } from "../../../secondary/livekit/call-in-waiting-room";
import { parseLiveKitWebhook } from "../../../secondary/livekit/livekit";
import {
  markParticipantLeftIfDisconnected,
  resolveMeetingParticipantUserId,
} from "../../../secondary/livekit/livekit-participant-presence";
import { TrackSource } from "../../../secondary/livekit/sdk";
import { BillingError, handleStripeWebhook } from "../../../secondary/stripe/stripe-billing";

const WEBHOOK_ID_HASH_LENGTH = 16;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const INVALID_WEBHOOK_SIGNATURE_MESSAGE = "Invalid webhook signature";
const INVALID_STRIPE_WEBHOOK_MESSAGE = "Invalid Stripe webhook";
const INVALID_LIVEKIT_WEBHOOK_LOG_MESSAGE = "Invalid LiveKit webhook";
const LIVEKIT_MEETING_LIFECYCLE_LOG_MESSAGE = "LiveKit meeting lifecycle event";
const WEBHOOK_RAW_BODY_SCHEMA = z.string();
const WEBHOOK_ACK_RESPONSE = {
  /** @external webhook acknowledgment wire field */
  ok: true,
};

type ParsedLiveKitWebhook = Awaited<ReturnType<typeof parseLiveKitWebhook>>;
type ActiveMeeting = NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingByRoomName"]>>>;

const LOGGED_LIVEKIT_MEETING_EVENTS = new Set([
  "room_started",
  "room_finished",
  "participant_joined",
  "participant_left",
  "participant_connection_aborted",
  "track_published",
  "track_unpublished",
]);

function webhookIdentifier(value: string | undefined): string | null {
  return value !== undefined && value.length !== 0
    ? createHash("sha256").update(value).digest("hex").slice(0, WEBHOOK_ID_HASH_LENGTH)
    : null;
}

function logLiveKitMeetingEvent(input: {
  event: ParsedLiveKitWebhook;
  meetingId: string;
  log: FastifyInstance["log"];
}): void {
  if (!LOGGED_LIVEKIT_MEETING_EVENTS.has(input.event.event)) {
    return;
  }
  const level = input.event.event === "participant_connection_aborted" ? "warn" : "info";
  input.log[level](
    {
      meetingId: input.meetingId,
      roomKey: webhookIdentifier(input.event.room?.name),
      livekitEvent: input.event.event,
      livekitCreatedAt: input.event.createdAt,
      participantKey: webhookIdentifier(input.event.participant?.identity),
      participantKind: input.event.participant?.kind ?? null,
      participantState: input.event.participant?.state ?? null,
      trackKey: webhookIdentifier(input.event.track?.sid),
      trackSource: getLiveKitTrackSourceName(input.event.track?.source),
      /** @external LiveKit track muted wire field */
      trackMuted: input.event.track?.muted ?? null,
    },
    LIVEKIT_MEETING_LIFECYCLE_LOG_MESSAGE,
  );
}

async function handleLiveKitParticipantJoined(input: {
  event: ParsedLiveKitWebhook;
  meeting: ActiveMeeting;
}): Promise<void> {
  const userId = await resolveMeetingParticipantUserId({
    meetingId: input.meeting.id,
    participant: input.event.participant,
  });
  if (userId === null || userId.length === 0 || input.meeting.status === "ended") {
    return;
  }
  await repositories().upsertParticipantPresence({ meetingId: input.meeting.id, userId, role: "guest" });
  await repositories().markMeetingActive(input.meeting.id);
  await repositories().maybeAutoMarkMeetingConfidential(input.meeting.id);
}

async function handleLiveKitParticipantDisconnected(input: {
  event: ParsedLiveKitWebhook;
  meeting: ActiveMeeting;
  log: FastifyInstance["log"];
}): Promise<void> {
  const userId = await resolveMeetingParticipantUserId({
    meetingId: input.meeting.id,
    participant: input.event.participant,
    isLeaving: true,
  });
  if (userId === null || userId.length === 0) {
    return;
  }
  await markParticipantLeftIfDisconnected({
    meetingId: input.meeting.id,
    roomName: input.meeting.roomName,
    userId,
  });
  if (input.meeting.status === "ended") {
    await generateFinalizedMeetingMemories(input.meeting.id);

    return;
  }
  const finalization = await scheduleMeetingFinalizationIfIdle(input.meeting.id, input.log);
  const isFinalized = finalization.finalized;
  if (!isFinalized) {
    await ensureMeetingAssistantCoverage(input.meeting.id, input.log);
    scheduleAssistantCoverageRecheck(input.meeting.id, input.log);
  }
}

async function processLiveKitMeetingLifecycle(input: {
  event: ParsedLiveKitWebhook;
  meeting: ActiveMeeting;
  log: FastifyInstance["log"];
}): Promise<void> {
  logLiveKitMeetingEvent({ event: input.event, meetingId: input.meeting.id, log: input.log });

  if (input.event.event === "room_started" && input.meeting.status !== "ended") {
    await repositories().markMeetingActive(input.meeting.id);
  }
  if (input.event.event === "participant_joined") {
    await handleLiveKitParticipantJoined({ event: input.event, meeting: input.meeting });
  }
  if (input.event.event === "participant_left" || input.event.event === "participant_connection_aborted") {
    await handleLiveKitParticipantDisconnected({ event: input.event, meeting: input.meeting, log: input.log });
  }
  if (input.event.event === "room_finished") {
    await scheduleMeetingFinalizationIfIdle(input.meeting.id, input.log, {
      /** @external meeting finalization force wire field */
      force: true,
    });
  }
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // LiveKit posts webhooks as application/webhook+json. Keep the body as the
  // raw string: signature validation hashes the exact bytes LiveKit sent.
  app.addContentTypeParser("application/webhook+json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  // Stripe posts JSON, but signature verification hashes the exact bytes
  // sent, so this scope keeps application/json bodies as raw strings. Only
  // webhook routes live in this plugin, so normal JSON routes are unaffected.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/webhooks/stripe", async (request, reply) => {
    const rawBody = WEBHOOK_RAW_BODY_SCHEMA.parse(request.body);
    const signatureHeader = request.headers["stripe-signature"];
    const signature = typeof signatureHeader === "string" ? signatureHeader : undefined;

    try {
      const result = await handleStripeWebhook({
        rawBody,
        signature,
        log: request.log,
      });

      return await reply.code(HTTP_OK).send(result);
    } catch (error) {
      if (error instanceof BillingError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      request.log.error({ error }, INVALID_STRIPE_WEBHOOK_MESSAGE);

      return reply.code(HTTP_BAD_REQUEST).send({ message: INVALID_STRIPE_WEBHOOK_MESSAGE });
    }
  });

  app.post("/webhooks/livekit", async (request, reply) => {
    const rawBody = WEBHOOK_RAW_BODY_SCHEMA.parse(request.body);

    try {
      const event = await parseLiveKitWebhook(rawBody, request.headers.authorization);

      if (event.room === undefined) {
        return await reply.code(HTTP_OK).send(WEBHOOK_ACK_RESPONSE);
      }

      if (isCallInHoldingRoomName(event.room.name)) {
        await handleCallInHoldingRoomEvent(event, request.log);

        return await reply.code(HTTP_OK).send(WEBHOOK_ACK_RESPONSE);
      }

      const meeting = await repositories().getMeetingByRoomName(event.room.name);
      if (meeting === null) {
        return await reply.code(HTTP_OK).send(WEBHOOK_ACK_RESPONSE);
      }

      await processLiveKitMeetingLifecycle({ event, meeting, log: request.log });

      return await reply.code(HTTP_OK).send(WEBHOOK_ACK_RESPONSE);
    } catch (error) {
      request.log.error({ error }, INVALID_LIVEKIT_WEBHOOK_LOG_MESSAGE);

      return reply.code(HTTP_UNAUTHORIZED).send({ message: INVALID_WEBHOOK_SIGNATURE_MESSAGE });
    }
  });
}

function getLiveKitTrackSourceName(source: TrackSource | undefined): string | null {
  switch (source) {
    case TrackSource.CAMERA:
      return "camera";
    case TrackSource.MICROPHONE:
      return "microphone";
    case TrackSource.SCREEN_SHARE:
      return "screen-share";
    case TrackSource.SCREEN_SHARE_AUDIO:
      return "screen-share-audio";
    case TrackSource.UNKNOWN:
      return "unknown";
    case undefined:
      return null;
  }
}
