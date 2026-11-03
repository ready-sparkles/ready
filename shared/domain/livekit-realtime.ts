import { z } from "zod";

export function buildLiveKitTranscriptSourceSegmentId(input: {
  participantIdentity: string;
  trackSid?: string | null;
  segmentId: string;
}): string {
  return input.trackSid !== undefined && input.trackSid !== null && input.trackSid !== ""
    ? `lk:${input.participantIdentity}:${input.trackSid}:${input.segmentId}`
    : input.segmentId;
}

export const liveKitRealtimeStartSessionRequestSchema = z.object({
  meetingId: z.string().uuid(),
  roomName: z.string().min(1),
  livekitUrl: z.string().min(1),
  token: z.string().min(1),
  participantIdentity: z.string().min(1),
  participantName: z.string().min(1),
  participantNames: z.array(z.string().min(1)).default([]),
});

export const liveKitRealtimeStopSessionRequestSchema = z.object({
  finalize: z.boolean().optional(),
  drain: z.boolean().optional(),
});

export const liveKitRealtimeStartSessionResponseSchema = z.object({
  started: z.boolean(),
});

export const liveKitRealtimeStopSessionResponseSchema = z.object({
  stopped: z.boolean(),
  finalized: z.boolean(),
});

export const liveKitRealtimeTranscriptSegmentSchema = z.object({
  speakerIdentity: z.string().min(1),
  speakerUserId: z.string().uuid().nullable().optional(),
  speakerName: z.string().min(1),
  content: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string(),
});

export const liveKitRealtimeLiveTranscriptEventSchema = z.object({
  type: z.literal("live_transcript_segment"),
  meetingId: z.string().uuid(),
  segment: liveKitRealtimeTranscriptSegmentSchema.extend({
    trackSid: z.string().min(1).optional(),
    segmentId: z.string().min(1),
  }),
  metadata: z
    .object({
      transcriptionModel: z.string().min(1),
      language: z.string().optional().default(""),
    })
    .optional(),
});

export const liveKitRealtimeFinalTranscriptEventSchema = z.object({
  type: z.literal("final_transcript"),
  meetingId: z.string().uuid(),
  segments: z.array(liveKitRealtimeTranscriptSegmentSchema),
  metadata: z.object({
    mode: z.enum(["postcall-refined", "agent-live-finalized"]),
    segmentCount: z.number().int().nonnegative(),
    refinedAt: z.string(),
    recordingDir: z.string().min(1),
    transcriptionModel: z.string().min(1),
    language: z.string().optional().default(""),
    transcriptSettleWaitSeconds: z.number().nonnegative().optional(),
    transcriptSettleIdleSeconds: z.number().nonnegative().optional(),
    transcriptSettleMaxSeconds: z.number().nonnegative().optional(),
    transcriptSettleComplete: z.boolean().optional(),
    segmentCountBeforeSettle: z.number().int().nonnegative().optional(),
    segmentCountAfterSettle: z.number().int().nonnegative().optional(),
  }),
});

export const liveKitRealtimeEventSchema = z.discriminatedUnion("type", [
  liveKitRealtimeLiveTranscriptEventSchema,
  liveKitRealtimeFinalTranscriptEventSchema,
]);

export type LiveKitRealtimeStartSessionRequest = z.infer<typeof liveKitRealtimeStartSessionRequestSchema>;
export type LiveKitRealtimeStopSessionRequest = z.infer<typeof liveKitRealtimeStopSessionRequestSchema>;
export type LiveKitRealtimeStartSessionResponse = z.infer<typeof liveKitRealtimeStartSessionResponseSchema>;
export type LiveKitRealtimeStopSessionResponse = z.infer<typeof liveKitRealtimeStopSessionResponseSchema>;
export type LiveKitRealtimeEvent = z.infer<typeof liveKitRealtimeEventSchema>;
