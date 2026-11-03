import assert from "node:assert/strict";
import test from "node:test";

import { reportMeetingMediaQuality } from "../application/api";

const UPLOAD_ABORT_TICK_MS = 4999;
const UPLOAD_ABORT_FINAL_TICK_MS = 1;
const HTTP_OK_STATUS = 200;
const HTTP_UNAVAILABLE_STATUS = 503;
const FIRST_FETCH_CALL = 1;
const SECOND_FETCH_CALL = 2;

void test("telemetry aborts a stalled upload after five seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abortState = { signal: undefined as AbortSignal | undefined };
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const requestSignal = options.signal;
    assert.ok(requestSignal instanceof AbortSignal);
    abortState.signal = requestSignal;

    return new Promise<Response>((_resolve, reject) => {
      requestSignal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), {
        once: true,
      });
    });
  });
  const upload = assert.rejects(reportMeetingMediaQuality({ token: "token", meetingId: "meeting", reports: [] }), {
    name: "AbortError",
  });
  t.mock.timers.tick(UPLOAD_ABORT_TICK_MS);
  assert.ok(abortState.signal instanceof AbortSignal);
  assert.equal(abortState.signal.aborted, false);
  t.mock.timers.tick(UPLOAD_ABORT_FINAL_TICK_MS);
  await upload;
  assert.ok(abortState.signal instanceof AbortSignal);
  assert.equal(abortState.signal.aborted, true);
});

void test("a keepalive batch is sent even while another upload is in flight", async (t) => {
  const keepaliveRecorder = { flags: [] as (boolean | undefined)[] };
  const releaseGate = { resolve: undefined as (() => void) | undefined };
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    keepaliveRecorder.flags = [...keepaliveRecorder.flags, options.keepalive];
    if (keepaliveRecorder.flags.length === FIRST_FETCH_CALL) {
      await new Promise<void>((resolve) => {
        releaseGate.resolve = resolve;
      });
    }

    return new Response('{"ok":true}', { status: HTTP_OK_STATUS });
  });
  const first = reportMeetingMediaQuality({ token: "token", meetingId: "meeting", reports: [] });
  await reportMeetingMediaQuality({
    token: "token",
    meetingId: "meeting",
    reports: [],
    options: {
      /** @external Fetch RequestInit keepalive wire field. */
      keepalive: true,
    },
  });
  assert.deepEqual(keepaliveRecorder.flags, [undefined, true]);
  releaseGate.resolve?.();
  await first;
});

void test("failed telemetry is not retried and a later batch can be sent", async (t) => {
  const callState = { count: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    callState.count += 1;

    return new Response(JSON.stringify({ /** @external media-quality ok wire field */ ok: true }), {
      status: callState.count === FIRST_FETCH_CALL ? HTTP_UNAVAILABLE_STATUS : HTTP_OK_STATUS,
    });
  });
  await assert.rejects(reportMeetingMediaQuality({ token: "token", meetingId: "failed-meeting", reports: [] }));
  assert.equal(callState.count, FIRST_FETCH_CALL);
  await reportMeetingMediaQuality({ token: "token", meetingId: "failed-meeting", reports: [] });
  assert.equal(callState.count, SECOND_FETCH_CALL);
});
