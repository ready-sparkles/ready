import assert from "node:assert/strict";
import test from "node:test";

import {
  getMeetingTaskClientTimestampSequenceError,
  isMeetingTaskClientTimestampWithinWindow,
  MEETING_TASK_CLIENT_CLOCK_SKEW_MS,
} from "../../domain/meeting-task-telemetry";

const serverNowMs = Date.parse("2026-08-19T12:00:00.000Z");

void test("client task telemetry timestamps must stay inside the server-clock window", () => {
  assert.equal(
    isMeetingTaskClientTimestampWithinWindow({
      value: new Date(serverNowMs - MEETING_TASK_CLIENT_CLOCK_SKEW_MS).toISOString(),
      serverNowMs,
    }),
    true,
  );
  assert.equal(
    isMeetingTaskClientTimestampWithinWindow({
      value: new Date(serverNowMs + MEETING_TASK_CLIENT_CLOCK_SKEW_MS).toISOString(),
      serverNowMs,
    }),
    true,
  );
  assert.equal(
    isMeetingTaskClientTimestampWithinWindow({
      value: new Date(serverNowMs - MEETING_TASK_CLIENT_CLOCK_SKEW_MS - 1).toISOString(),
      serverNowMs,
    }),
    false,
  );
  assert.equal(
    isMeetingTaskClientTimestampWithinWindow({
      value: new Date(serverNowMs + MEETING_TASK_CLIENT_CLOCK_SKEW_MS + 1).toISOString(),
      serverNowMs,
    }),
    false,
  );
});

void test("client task telemetry timestamps must follow event chronology", () => {
  assert.equal(
    getMeetingTaskClientTimestampSequenceError({
      realtimeReceivedAt: "2026-08-19T12:00:01.000Z",
      refetchStartedAt: "2026-08-19T12:00:02.000Z",
      refetchCompletedAt: "2026-08-19T12:00:03.000Z",
      renderedAt: "2026-08-19T12:00:04.000Z",
    }),
    null,
  );

  assert.equal(
    getMeetingTaskClientTimestampSequenceError({
      refetchStartedAt: "2026-08-19T12:00:03.000Z",
      refetchCompletedAt: "2026-08-19T12:00:02.000Z",
      renderedAt: "2026-08-19T12:00:04.000Z",
    }),
    "Refetch-completed timestamp must not precede refetch-started timestamp.",
  );

  assert.equal(
    getMeetingTaskClientTimestampSequenceError({
      realtimeReceivedAt: "2026-08-19T12:00:05.000Z",
      renderedAt: "2026-08-19T12:00:04.000Z",
    }),
    "Rendered timestamp must not precede realtime-received timestamp.",
  );
});
