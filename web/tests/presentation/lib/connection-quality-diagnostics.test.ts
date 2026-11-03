import { ConnectionQuality } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTION_QUALITY_DIAGNOSTIC_COOLDOWN_MS,
  createConnectionQualityDiagnosticLimiter,
} from "../../../presentation/lib/connection-quality-diagnostics";

const EARLY_MS = 1_000;
const MID_MS = 2_000;
const LATER_MS = 3_000;
const FOURTH_MS = 4_000;
const FIFTH_MS = 5_000;
const COOLDOWN_ELAPSED_MS = 31_000;
const COOLDOWN_REPEAT_MS = 32_000;

void test("reports degraded connection quality once per participant and quality transition", () => {
  const limiter = createConnectionQualityDiagnosticLimiter(CONNECTION_QUALITY_DIAGNOSTIC_COOLDOWN_MS);

  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Good, now: EARLY_MS }),
    false,
  );
  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Poor, now: MID_MS }),
    true,
  );
  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Poor, now: LATER_MS }),
    false,
  );
  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Lost, now: FOURTH_MS }),
    true,
  );
  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Lost, now: FIFTH_MS }),
    false,
  );
});

void test("rate limits a repeated degraded transition without suppressing other participants", () => {
  const limiter = createConnectionQualityDiagnosticLimiter(CONNECTION_QUALITY_DIAGNOSTIC_COOLDOWN_MS);

  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Poor, now: EARLY_MS }),
    true,
  );
  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Good, now: MID_MS }),
    false,
  );
  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Poor, now: LATER_MS }),
    false,
  );
  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-b", quality: ConnectionQuality.Poor, now: LATER_MS }),
    true,
  );
  assert.equal(
    limiter.shouldReport({
      participantIdentity: "participant-a",
      quality: ConnectionQuality.Good,
      now: COOLDOWN_ELAPSED_MS,
    }),
    false,
  );
  assert.equal(
    limiter.shouldReport({
      participantIdentity: "participant-a",
      quality: ConnectionQuality.Poor,
      now: COOLDOWN_REPEAT_MS,
    }),
    true,
  );
});

void test("removing a participant clears its diagnostic limiter state", () => {
  const limiter = createConnectionQualityDiagnosticLimiter(CONNECTION_QUALITY_DIAGNOSTIC_COOLDOWN_MS);

  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Poor, now: EARLY_MS }),
    true,
  );
  limiter.removeParticipant("participant-a");
  assert.equal(
    limiter.shouldReport({ participantIdentity: "participant-a", quality: ConnectionQuality.Poor, now: MID_MS }),
    true,
  );
});
