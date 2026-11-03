import assert from "node:assert/strict";
import test from "node:test";

import { liveKitRealtimeEventSchema, liveKitRealtimeStartSessionRequestSchema } from "../domain/livekit-realtime";

const TWO_PARTICIPANTS = 2;
const TWELVE_SEGMENTS = 12;
const TRANSCRIPT_SETTLE_WAIT_SECONDS = 1.25;
const TRANSCRIPT_SETTLE_IDLE_SECONDS = 2;
const TRANSCRIPT_SETTLE_MAX_SECONDS = 10;
const ELEVEN_SEGMENTS = 11;

void test("livekit realtime start request requires the Python control payload", () => {
  const payload = liveKitRealtimeStartSessionRequestSchema.parse({
    meetingId: "550e8400-e29b-41d4-a716-446655440000",
    roomName: "meeting-room",
    livekitUrl: "wss://example.livekit.cloud",
    token: "jwt-token",
    participantIdentity: "transcriber-550e8400",
    participantName: "ReadyMeet Transcriber",
    participantNames: ["Personbr", "Personbz"],
  });

  assert.equal(payload.participantNames.length, TWO_PARTICIPANTS);
  assert.equal(payload.participantIdentity, "transcriber-550e8400");
});

void test("livekit realtime event schema accepts live and final transcript callbacks", () => {
  const liveEvent = liveKitRealtimeEventSchema.parse({
    type: "live_transcript_segment",
    meetingId: "550e8400-e29b-41d4-a716-446655440000",
    segment: {
      speakerIdentity: "user-1",
      speakerName: "Personbr",
      content: "We should ship this next week.",
      startedAt: "2026-04-18T10:00:00.000Z",
      endedAt: "2026-04-18T10:00:02.000Z",
      segmentId: "segment-1",
    },
    metadata: {
      transcriptionModel: "gpt-4o-mini-transcribe",
      language: "en",
    },
  });

  const finalEvent = liveKitRealtimeEventSchema.parse({
    type: "final_transcript",
    meetingId: "550e8400-e29b-41d4-a716-446655440000",
    segments: [
      {
        speakerIdentity: "user-1",
        speakerName: "Personbr",
        content: "We should ship this next week.",
        startedAt: "2026-04-18T10:00:00.000Z",
        endedAt: "2026-04-18T10:00:02.000Z",
      },
    ],
    metadata: {
      mode: "postcall-refined",
      segmentCount: 1,
      refinedAt: "2026-04-18T10:30:00.000Z",
      recordingDir: "/tmp/readymeet-recordings/550e8400-e29b-41d4-a716-446655440000",
      transcriptionModel: "gpt-4o-transcribe",
      language: "en",
    },
  });

  assert.equal(liveEvent.type, "live_transcript_segment");
  assert.equal(finalEvent.type, "final_transcript");
});

void test("livekit realtime event schema accepts live-finalized transcript callbacks without rewritten segments", () => {
  const finalEvent = liveKitRealtimeEventSchema.parse({
    type: "final_transcript",
    meetingId: "550e8400-e29b-41d4-a716-446655440000",
    segments: [],
    metadata: {
      mode: "agent-live-finalized",
      segmentCount: TWELVE_SEGMENTS,
      refinedAt: "2026-04-18T10:30:00.000Z",
      recordingDir: "/tmp/readymeet-recordings/550e8400-e29b-41d4-a716-446655440000",
      transcriptionModel: "u3-rt-pro",
      language: "en",
      transcriptSettleWaitSeconds: TRANSCRIPT_SETTLE_WAIT_SECONDS,
      transcriptSettleIdleSeconds: TRANSCRIPT_SETTLE_IDLE_SECONDS,
      transcriptSettleMaxSeconds: TRANSCRIPT_SETTLE_MAX_SECONDS,
      /** @external existing wire contract */
      transcriptSettleComplete: true,
      segmentCountBeforeSettle: ELEVEN_SEGMENTS,
      segmentCountAfterSettle: TWELVE_SEGMENTS,
    },
  });

  assert.equal(finalEvent.type, "final_transcript");
  assert.equal(finalEvent.metadata.mode, "agent-live-finalized");
  assert.equal(finalEvent.metadata.transcriptSettleComplete, true);
  assert.equal(finalEvent.metadata.segmentCountAfterSettle, TWELVE_SEGMENTS);
  assert.equal(finalEvent.segments.length, 0);
});

void test("livekit realtime event schema accepts assistant callbacks without a speaker user id", () => {
  const liveEvent = liveKitRealtimeEventSchema.parse({
    type: "live_transcript_segment",
    meetingId: "550e8400-e29b-41d4-a716-446655440000",
    segment: {
      speakerIdentity: "readymeet-assistant-AJ_123",
      speakerUserId: null,
      speakerName: "ReadyMeet Assistant",
      content: "This is ReadyMeet. Hold space to ask for summaries or tasks.",
      startedAt: "2026-04-18T10:00:00.000Z",
      endedAt: "2026-04-18T10:00:05.000Z",
      segmentId: "segment-2",
      trackSid: "TR_123",
    },
    metadata: {
      transcriptionModel: "gpt-4o-mini-transcribe",
      language: "en",
    },
  });

  assert.equal(liveEvent.type, "live_transcript_segment");
  assert.equal(liveEvent.segment.speakerUserId, null);
});
