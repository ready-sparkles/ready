import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { endMeeting } from "../../../composition/api";

const HTTP_OK_STATUS = 200;
const MEETING_EXIT_NO_DEADLINE_MS = 60_000;
const MEETING_EXIT_ABORT_ERROR = /aborted/;
const MEETING_EXIT_MISSING_SIGNAL_MESSAGE = "Missing abort signal.";
const MEETING_EXIT_ABORT_MESSAGE = "aborted";
const MEETING_EXIT_LEAVE_BODY_SCHEMA = z.object({ action: z.literal("leave") });
const MEETING_EXIT_END_FOR_ALL_BODY_SCHEMA = z.object({ action: z.literal("end_for_all") });
const MEETING_EXIT_END_FOR_ALL_RESPONSE_SCHEMA = z.object({
  /** @external existing wire contract */
  ok: z.literal(true),
  /** @external existing wire contract */
  finalized: z.literal(true),
});

void test("end request honors the caller abort signal without retrying", async (t) => {
  const callState = { count: 0 };
  t.mock.method(globalThis, "fetch", (_url: unknown, options: RequestInit) => {
    callState.count += 1;
    const body = typeof options.body === "string" ? options.body : "";
    MEETING_EXIT_LEAVE_BODY_SCHEMA.parse(JSON.parse(body));

    return new Promise<Response>((_, reject) => {
      const signal = options.signal;
      if (signal === undefined || signal === null) {
        reject(new Error(MEETING_EXIT_MISSING_SIGNAL_MESSAGE));

        return;
      }
      signal.addEventListener("abort", () => reject(new Error(MEETING_EXIT_ABORT_MESSAGE)), { once: true });
    });
  });
  const controller = new AbortController();
  const request = endMeeting({
    token: "test-token",
    meetingId: "meeting",
    action: "leave",
    options: { signal: controller.signal },
  });
  const rejected = assert.rejects(request, MEETING_EXIT_ABORT_ERROR);
  controller.abort();
  await rejected;
  assert.equal(callState.count, 1);
});

void test("end request has no built-in deadline for callers that pass no signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capturedSignal = { value: null as AbortSignal | null | undefined };
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    capturedSignal.value = options.signal;
    const body = typeof options.body === "string" ? options.body : "";
    MEETING_EXIT_END_FOR_ALL_BODY_SCHEMA.parse(JSON.parse(body));

    return new Response(
      JSON.stringify({
        ...MEETING_EXIT_END_FOR_ALL_RESPONSE_SCHEMA.parse({
          /** @external existing wire contract */
          ok: true,
          /** @external existing wire contract */
          finalized: true,
        }),
        // The API always returns the refreshed meeting and runtime with an end response.
        meeting: {},
        meetingRuntime: {},
      }),
      { status: HTTP_OK_STATUS },
    );
  });
  const response = MEETING_EXIT_END_FOR_ALL_RESPONSE_SCHEMA.parse(
    await endMeeting({ token: "test-token", meetingId: "meeting", action: "end_for_all" }),
  );
  assert.equal(response.finalized, true);
  t.mock.timers.tick(MEETING_EXIT_NO_DEADLINE_MS);
  assert.equal(capturedSignal.value?.aborted ?? false, false);
});

const confirmationMeetingId = "11111111-1111-4111-8111-111111111111";
const confirmationUserId = "22222222-2222-4222-8222-222222222222";
const endTimeoutMessage = "end request timed out";
const confirmationUnavailableMessage = "confirmation unavailable";
const confirmationTime = "2026-01-01T12:00:00.000Z";

[
  { status: "ended", activeCount: 0, isConfirmed: true },
  { status: "active", activeCount: 1, isConfirmed: false },
  { status: "ended", activeCount: 1, isConfirmed: false },
  { status: "unavailable", activeCount: 0, isConfirmed: false },
].forEach(({ status, activeCount, isConfirmed }) => {
  void test(`end-for-all timeout checks saved state: ${status}, ${activeCount} active`, async (t) => {
    const timeout = new Error(endTimeoutMessage);
    const requests = { methods: [] as string[] };
    const controller = new AbortController();
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      requests.methods = [...requests.methods, options.method ?? "GET"];
      if (options.method === "POST") {
        controller.abort();
        throw timeout;
      }
      assert.notEqual(options.signal, controller.signal);
      assert.equal(options.signal?.aborted, false);
      if (status === "unavailable") {
        throw new Error(confirmationUnavailableMessage);
      }

      return new Response(
        JSON.stringify({
          meeting: {
            id: confirmationMeetingId,
            workspaceId: confirmationUserId,
            createdByUserId: confirmationUserId,
            title: "Synthetic meeting",
            roomName: "synthetic-room",
            status,
            createdAt: confirmationTime,
            startedAt: confirmationTime,
            endedAt: status === "ended" ? confirmationTime : null,
          },
          meetingRuntime: {
            activeHumanParticipantCount: activeCount,
            activeHumanParticipants: [],
            allHumanParticipants: [],
            isAwaitingMeetingEnd: false,
          },
          transcript: null,
          transcriptSegments: [],
          summary: null,
          actionItems: [],
          tasks: null,
        }),
        { status: HTTP_OK_STATUS },
      );
    });
    const result = endMeeting({
      token: "test-token",
      meetingId: confirmationMeetingId,
      action: "end_for_all",
      options: { signal: controller.signal },
    });
    if (isConfirmed) {
      assert.equal((await result).finalized, true);
    } else {
      await assert.rejects(result, (error) => error === timeout);
    }
    assert.deepEqual(requests.methods, ["POST", "GET"]);
  });
});
