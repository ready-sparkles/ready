import { z } from "zod";

import { meetingJoinRequestSchema, meetingSchema } from "./types";

/**
 * Wire contract for waiting-room realtime events. The API publishes with it and
 * the web client parses with it, so both sides change together.
 */
export const JOIN_REQUEST_REALTIME_VERSION = 1;

export const joinRequestRealtimeEventNameSchema = z.enum([
  "join-request.created",
  "join-request.updated",
  "join-request.admitted",
  "join-request.denied",
]);

export const joinRequestRealtimePayloadSchema = z.object({
  version: z.literal(JOIN_REQUEST_REALTIME_VERSION),
  eventId: z.string(),
  eventName: joinRequestRealtimeEventNameSchema,
  request: meetingJoinRequestSchema,
  // The admitted event ships the meeting so the guest can enter the room
  // without fetching the meeting first.
  meeting: meetingSchema.nullable(),
  occurredAt: z.string(),
});

export type JoinRequestRealtimeEventName = z.infer<typeof joinRequestRealtimeEventNameSchema>;
export type JoinRequestRealtimePayload = z.infer<typeof joinRequestRealtimePayloadSchema>;
