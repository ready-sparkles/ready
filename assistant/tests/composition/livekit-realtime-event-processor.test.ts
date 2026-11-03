import "../../composition/wire";

import { buildLiveKitTranscriptSourceSegmentId } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { processLiveKitRealtimeEvent } from "../../adapters/secondary/livekit/realtime-event-processor";
import { assistantEnv, configureAssistantEnv } from "../../ports/assistant-env";
import { repositories } from "../../ports/repository-runtime";

void test("livekit realtime transcript source key includes participant, track, and segment", () => {
  assert.equal(
    buildLiveKitTranscriptSourceSegmentId({
      participantIdentity: "550e8400-e29b-41d4-a716-446655440000:browser",
      trackSid: "TR_microphone",
      segmentId: "SG_native",
    }),
    "lk:550e8400-e29b-41d4-a716-446655440000:browser:TR_microphone:SG_native",
  );
});

void test("livekit realtime transcript source key falls back to raw segment id for legacy events", () => {
  assert.equal(
    buildLiveKitTranscriptSourceSegmentId({
      participantIdentity: "550e8400-e29b-41d4-a716-446655440000:browser",
      segmentId: "SG_legacy",
    }),
    "SG_legacy",
  );
});

const PERSISTENCE_FAILED_MESSAGE = "Persistence failed";
const WORKFLOW_FAILED_MESSAGE = "Workflow failed";

const speechEvent = {
  type: "live_transcript_segment" as const,
  meetingId: "550e8400-e29b-41d4-a716-446655440000",
  segment: {
    segmentId: "speech",
    speakerIdentity: "personbr",
    speakerName: "Personbr",
    content: "Please send the deck.",
    startedAt: "2026-09-25T12:00:00.000Z",
    endedAt: "2026-09-25T12:00:03.000Z",
  },
};

void test("persisted speech dispatches live summary to the configured API with internal authentication", async (t) => {
  const env = assistantEnv();
  configureAssistantEnv({ ...env, API_BASE_URL: "https://api.ready.test/" });
  t.after(() => configureAssistantEnv(env));
  const append = t.mock.method(repositories(), "appendTranscriptSegment", async () => ({ id: "saved" }));
  const dispatch = t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    assert.equal(append.mock.callCount(), 1);
    assert.equal(url, "https://api.ready.test/v1/internal/ai-work");
    assert.equal(options.method, "POST");
    assert.deepEqual(options.headers, {
      "content-type": "application/json",
      "x-assistant-service-secret": env.ASSISTANT_SERVICE_SECRET,
    });

    return new Response("{}");
  });
  await processLiveKitRealtimeEvent({ payload: speechEvent });
  const expectedDispatchCount = 2;
  assert.equal(dispatch.mock.callCount(), expectedDispatchCount);
  assert.equal(
    dispatch.mock.calls[1]?.arguments[1]?.body,
    JSON.stringify({
      meetingId: speechEvent.meetingId,
      type: "track_meeting",
      scopeKey: "default",
      phase: "queued",
      payload: { latestSegmentId: "saved" },
      maxAttempts: 1,
    }),
  );
});

void test("failed transcript persistence starts neither workflow", async () => {
  const failure = new Error(PERSISTENCE_FAILED_MESSAGE);
  await assert.rejects(
    processLiveKitRealtimeEvent({
      payload: speechEvent,
      dependencies: {
        appendSegment: async () => {
          throw failure;
        },
        enqueueJob: async () => {
          assert.fail("Work must wait for persistence");
        },
      },
    }),
    failure,
  );
});

(["detect_ambient_context", "track_meeting"] as const).forEach((failedType) => {
  void test(`${failedType} failure after the segment is saved is logged, not thrown`, async (t) => {
    const failure = new Error(WORKFLOW_FAILED_MESSAGE);
    const logged = t.mock.method(console, "error", () => undefined);
    const state: { started: string[]; isSettled: boolean; release: () => void } = {
      started: [],
      isSettled: false,
      release: () => undefined,
    };
    const pending = new Promise<void>((resolve) => {
      state.release = resolve;
    });
    const processing = processLiveKitRealtimeEvent({
      payload: speechEvent,
      dependencies: {
        appendSegment: async () => ({ id: "saved" }),
        enqueueJob: async ({ type }) => {
          state.started = [...state.started, type];
          if (type === failedType) {
            throw failure;
          }
          await pending;
        },
      },
    });
    const settled = (async () => {
      const result = await processing;
      state.isSettled = true;

      return result;
    })();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.deepEqual(state.started, ["detect_ambient_context", "track_meeting"]);
    assert.equal(state.isSettled, false, "still waits for the other workflow");
    state.release();
    assert.deepEqual(await settled, {
      // @external accepted
      accepted: true,
      type: "live_transcript_segment",
    });
    assert.equal(logged.mock.callCount(), 1);
    assert.deepEqual(logged.mock.calls[0]?.arguments[1], {
      meetingId: speechEvent.meetingId,
      segmentId: "saved",
      type: failedType,
      errorType: "Error",
    });
  });
});
