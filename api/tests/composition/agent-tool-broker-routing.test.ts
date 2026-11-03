import assert from "node:assert/strict";
import test from "node:test";

import { executeAgentTool } from "../../application/agent-tool-broker";
import { repositories } from "../../ports/repository-runtime";

const STOP_BEFORE_PERSISTENCE_MESSAGE = "Stop before persistence or provider work";

type Repositories = ReturnType<typeof repositories>;
type TransitionInput = Parameters<Repositories["transitionAgentToolInvocation"]>[0];
type CreatedInvocation = Awaited<ReturnType<Repositories["createAgentToolInvocation"]>>;

function runningWebSearchInvocation(): CreatedInvocation {
  return {
    id: "invocation",
    meetingId: "meeting",
    utteranceId: "utterance",
    userId: "owner",
    agentProfileId: "profile",
    connectorId: null,
    provider: "web_search",
    toolName: "web_search",
    toolVersion: "1",
    policyVersion: "default",
    sideEffectClass: "read",
    status: "running",
    confirmationStatus: "not_required",
    confirmationActorUserId: null,
    idempotencyKey: null,
    redactedArgs: {},
    redactedResultSummary: {},
    errorCode: null,
    durationMs: null,
    createdAt: new Date(0),
    confirmedAt: null,
    executedAt: null,
  };
}

[false, true].forEach((isLegacySwitchEnabled) => {
  void test(`new web search selects Turbo when the retired global is ${String(isLegacySwitchEnabled)}`, async (t) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "READY_LEGACY_WEB_SEARCH");
    Reflect.set(globalThis, "READY_LEGACY_WEB_SEARCH", isLegacySwitchEnabled);
    t.after(() => {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "READY_LEGACY_WEB_SEARCH");
      } else {
        Object.defineProperty(globalThis, "READY_LEGACY_WEB_SEARCH", previous);
      }
    });
    t.mock.method(repositories(), "listAgentToolPolicies", async () => []);
    t.mock.method(repositories(), "getAgentConnectorForUser", async () => null);
    const invocation = runningWebSearchInvocation();
    t.mock.method(repositories(), "createAgentToolInvocation", async () => invocation);
    // The broker records the failed attempt through the guarded status transition, so keep that off the database too.
    const transition = t.mock.method(
      repositories(),
      "transitionAgentToolInvocation",
      async (input: TransitionInput) => {
        assert.equal(input.expected.id, invocation.id);
        assert.equal(input.changes.status, "failed");

        return null;
      },
    );
    const stopBeforePersistence = new Error(STOP_BEFORE_PERSISTENCE_MESSAGE);
    const claim = t.mock.method(repositories(), "claimVoiceWebResearchRun", async (input: { researchMode: string }) => {
      assert.equal(input.researchMode, "turbo_search");
      throw stopBeforePersistence;
    });
    t.mock.method(globalThis, "fetch", async () => assert.fail("No provider calls expected"));
    await assert.rejects(
      executeAgentTool({
        context: {
          meetingId: "meeting",
          utteranceId: "utterance",
          requestingUserId: "owner",
          activeSpeakerUserId: "owner",
          agentProfileId: "profile",
          allowedToolScope: "private",
          createdAt: new Date(0).toISOString(),
        },
        toolName: "web_search",
        args: { query: "current NHL playoff teams" },
        user: { id: "owner", displayName: "Owner" },
      }),
      stopBeforePersistence,
    );
    assert.equal(claim.mock.callCount(), 1);
    assert.equal(transition.mock.callCount(), 1);
  });
});
