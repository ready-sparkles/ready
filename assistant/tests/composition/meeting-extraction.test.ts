import "../../composition/wire";

import type { MeetingTrackerState } from "@readymeet/shared";
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadOptionalVoiceSearchEvidence } from "../../application/meeting-extraction";

const VOICE_EVIDENCE_OUTAGE_MESSAGE = "private connection details";
const MEETING_FIXTURE_ID = "meeting";

void test("an optional voice-evidence outage does not fail transcript extraction or retry the lookup", async (t) => {
  const invocation = { count: 0 };
  const warningState = { messages: [] as string[] };
  t.mock.method(console, "error", (message: string) => {
    warningState.messages = [...warningState.messages, message];
  });
  const result = await loadOptionalVoiceSearchEvidence({
    meetingId: MEETING_FIXTURE_ID,
    load: async () => {
      invocation.count += 1;
      throw new Error(VOICE_EVIDENCE_OUTAGE_MESSAGE);
    },
  });
  assert.deepEqual(result, []);
  assert.equal(invocation.count, 1);
  assert.equal(warningState.messages.length, 1);
  const firstWarning = warningState.messages[0];
  assert.ok(typeof firstWarning === "string");
  assert.doesNotMatch(firstWarning, /private connection details/);
});

void test("optional voice evidence requests only completed, projected results for this meeting", async () => {
  const invocation = { count: 0 };
  await loadOptionalVoiceSearchEvidence({
    meetingId: MEETING_FIXTURE_ID,
    load: async (input) => {
      invocation.count += 1;
      assert.deepEqual(input, {
        meetingId: MEETING_FIXTURE_ID,
        /** @external voice search evidence query flag */
        includeResults: true,
        /** @external voice search evidence query flag */
        completedOnly: true,
      });

      return [];
    },
  });
  assert.equal(invocation.count, 1);
});

const SAVED_SUMMARY_REVISION = 3;
const PRIVATE_FAILURE_DETAIL = "private transcript or connection details";

void test("live Summary lookup is scoped to the meeting and returns the saved state", async () => {
  const { loadOptionalLiveSummary } = await import("../../application/meeting-extraction");
  const state: MeetingTrackerState = { revision: SAVED_SUMMARY_REVISION, items: [], updatedAt: null, status: "idle" };
  const result = await loadOptionalLiveSummary({
    meetingId: "meeting",
    load: async (meetingId) => {
      assert.equal(meetingId, "meeting");

      return state;
    },
  });
  assert.equal(result, state);
});

void test("live Summary outage falls back without logging content or connection details", async (t) => {
  const { loadOptionalLiveSummary } = await import("../../application/meeting-extraction");
  const logged: { messages: string[] } = { messages: [] };
  t.mock.method(console, "error", (message: string) => {
    logged.messages = [...logged.messages, message];
  });
  assert.equal(
    await loadOptionalLiveSummary({
      meetingId: "meeting",
      load: async () => {
        throw new Error(PRIVATE_FAILURE_DETAIL);
      },
    }),
    undefined,
  );
  assert.equal(logged.messages.length, 1);
  assert.doesNotMatch(logged.messages.join("\n"), /private transcript or connection details/);
});
