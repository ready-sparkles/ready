import { Track } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";

import { createTrackStreamDiagnosticLimiter } from "../../../presentation/lib/track-stream-diagnostics";

void test("reports only the first paused transition for a visible track", () => {
  const limiter = createTrackStreamDiagnosticLimiter();

  assert.equal(limiter.shouldReport("track-a", Track.StreamState.Active, true), false);
  assert.equal(limiter.shouldReport("track-a", Track.StreamState.Paused, true), true);
  assert.equal(limiter.shouldReport("track-a", Track.StreamState.Paused, true), false);
  assert.equal(limiter.shouldReport("track-a", Track.StreamState.Active, true), false);
  assert.equal(limiter.shouldReport("track-a", Track.StreamState.Paused, true), true);
});

void test("does not report adaptive-stream pauses for hidden tracks", () => {
  const limiter = createTrackStreamDiagnosticLimiter();

  assert.equal(limiter.shouldReport("track-a", Track.StreamState.Paused, false), false);
  assert.equal(limiter.shouldReport("track-a", Track.StreamState.Paused, true), false);
});

void test("tracks pause transitions independently by track SID", () => {
  const limiter = createTrackStreamDiagnosticLimiter();

  assert.equal(limiter.shouldReport("track-a", Track.StreamState.Paused, true), true);
  assert.equal(limiter.shouldReport("track-b", Track.StreamState.Paused, true), true);
});
