import assert from "node:assert/strict";
import test from "node:test";

import { type AgentToolExecutionContext, reusableVoiceSearchSession } from "../application/agent-tool-broker";

const SESSION_STALE_MINUTES = 16;
const MILLISECONDS_PER_MINUTE = 60_000;

void test("only same-owner, same-meeting, same-agent recent completed research can continue a session", () => {
  const now = Date.now();
  const context: AgentToolExecutionContext = {
    meetingId: "m",
    utteranceId: "utterance-m",
    requestingUserId: "u",
    activeSpeakerUserId: "u",
    agentProfileId: "a",
    allowedToolScope: "private",
    createdAt: new Date(now).toISOString(),
  };
  const run = {
    meetingId: "m",
    userId: "u",
    agentProfileId: "a",
    status: "completed",
    sessionId: "session-1",
    updatedAt: new Date(now),
  };
  assert.equal(reusableVoiceSearchSession(run, context, now), "session-1");
  [
    { userId: "other" },
    { meetingId: "other" },
    { agentProfileId: "other" },
    { status: "cancelled" },
    { status: "searching" },
    { updatedAt: new Date(now - SESSION_STALE_MINUTES * MILLISECONDS_PER_MINUTE) },
  ].forEach((change) => {
    assert.equal(reusableVoiceSearchSession({ ...run, ...change }, context, now), null);
  });
});

void test("unpublished candidates are hidden from polling and history, but available to the reasoning backend", async () => {
  const { voiceWebResearchRunToPanelPayload } = await import("../application/agent-tool-broker");
  const run = {
    id: "run",
    meetingId: "meeting",
    userId: "user",
    agentProfileId: "agent",
    utteranceId: "utterance",
    query: "events",
    queryKey: "events",
    status: "completed",
    researchMode: "turbo_search",
    sessionId: "session",
    searchId: "utterance",
    findallId: null,
    taskgroupId: null,
    runRefs: { searches: ["private candidate"] },
    progress: { partialAnswer: "candidate answer", activeSources: ["candidate"], signals: ["candidate"] },
    result: {
      /** @external voice research wire field */
      presentationPending: true,
      answerDisplay: { lead: "candidate answer" },
      results: [{ title: "candidate" }],
    },
    error: null,
    cancelledAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const publicResult = voiceWebResearchRunToPanelPayload(run);
  assert.equal(publicResult.status, "partial");
  assert.doesNotMatch(JSON.stringify(publicResult), /candidate/);
  assert.match(JSON.stringify(voiceWebResearchRunToPanelPayload(run, true)), /candidate answer/);
  const presented = voiceWebResearchRunToPanelPayload({
    ...run,
    result: {
      ...run.result,
      /** @external voice research wire field */
      presentationPending: false,
    },
  });
  assert.equal(presented.status, "completed");
  assert.match(JSON.stringify(presented), /candidate answer/);
  const cancelled = voiceWebResearchRunToPanelPayload({ ...run, status: "cancelled" });
  assert.equal(cancelled.status, "error");
  assert.doesNotMatch(JSON.stringify(cancelled), /candidate/);
});
