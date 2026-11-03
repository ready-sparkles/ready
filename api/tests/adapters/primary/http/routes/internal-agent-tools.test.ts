import assert from "node:assert/strict";
import test from "node:test";

import { agentToolExecutionContextSchema } from "../../../../../adapters/primary/http/routes/internal-agent-tools";

const baseContext = {
  meetingId: "0b0c39dd-56cb-4f75-8546-ee5990fc9f32",
  meetingTurnId: "5aa7e71f-561a-4e9a-994a-e3cfa0f6a002",
  participantIdentity: "f4d0d24c-b5f8-4903-903f-238973e631f1:browser",
  utteranceId: "utterance-1",
  requestingUserId: "f4d0d24c-b5f8-4903-903f-238973e631f1",
  activeSpeakerUserId: "f4d0d24c-b5f8-4903-903f-238973e631f1",
  agentProfileId: "8d25f831-7faf-4406-82ed-e7440c50243b",
  allowedToolScope: "private",
} as const;

void test("agent tool execution context accepts Python offset timestamps", () => {
  const parsed = agentToolExecutionContextSchema.safeParse({
    ...baseContext,
    createdAt: "2026-05-06T05:43:43.696446+00:00",
  });

  assert.equal(parsed.success, true);
});

void test("agent tool execution context still accepts UTC Z timestamps", () => {
  const parsed = agentToolExecutionContextSchema.safeParse({
    ...baseContext,
    createdAt: "2026-05-06T05:43:43.696Z",
  });

  assert.equal(parsed.success, true);
});

void test("agent tool execution context requires an exact turn and connection identity", () => {
  ["meetingTurnId", "participantIdentity"].forEach((field) => {
    const context: Record<string, unknown> = { ...baseContext, createdAt: "2026-05-06T05:43:43.696Z" };
    delete context[field];
    assert.equal(agentToolExecutionContextSchema.safeParse(context).success, false, field);
  });
});
