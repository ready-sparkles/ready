import { closeDbPool } from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import {
  type AgentToolExecutionContext,
  cancelAgentToolInvocationFromMeetingClient,
  confirmAgentTool,
  prepareAgentTool,
} from "../../application/agent-tool-broker";
import { encryptJsonSecret } from "../../ports/gate-secret-crypto";
import { repositories } from "../../ports/repository-runtime";

after(closeDbPool);

const CONCURRENT_REQUESTS = 2;
const IDEMPOTENCY_CONFLICT = { code: "idempotency_conflict" };
const DATABASE_FAILURE_MESSAGE = "Database unavailable";
const HTTP_STATUS_CONFLICT = 409;
const CONFIRMATION_CONFLICT = { code: "invalid_confirmation_state", statusCode: HTTP_STATUS_CONFLICT };
const ISSUE = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Test",
  url: "https://linear.app/issue/ENG-1",
  createdAt: "2026-01-01T00:00:00Z",
  team: { id: "team-1" },
};

/** Moves a stored invocation to a new status through the guarded transition, like production code. */
async function setInvocationStatus(input: {
  invocationId: string;
  changes: Parameters<ReturnType<typeof repositories>["transitionAgentToolInvocation"]>[0]["changes"];
}) {
  const repo = repositories();
  const expected = await repo.getAgentToolInvocationById(input.invocationId);
  assert.ok(expected);
  assert.ok(await repo.transitionAgentToolInvocation({ expected, changes: input.changes }));
}

function deferred() {
  const gate = { resolve: () => undefined as void };
  const promise = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });

  return { promise, resolve: () => gate.resolve() };
}

async function fixture() {
  const repo = repositories();
  const user = await repo.upsertUser({ email: `${randomUUID()}@tool-confirmation.test`, displayName: "Requester" });
  const meeting = await repo.createMeeting({
    title: "Confirmation test",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const profile = await repo.ensureDefaultAgentProfileForUser({ userId: user.id, displayName: user.displayName });
  const connector = await repo.upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "linear",
    status: "connected",
    secretRef: encryptJsonSecret({
      accessToken: "fixture",
      refreshToken: "fixture",
      expiresAt: "2099-01-01T00:00:00Z",
      scope: "write",
      tokenType: "Bearer",
    }),
  });
  const context: AgentToolExecutionContext = {
    meetingId: meeting.id,
    utteranceId: randomUUID(),
    requestingUserId: user.id,
    activeSpeakerUserId: user.id,
    agentProfileId: profile.id,
    allowedToolScope: "private",
    createdAt: new Date().toISOString(),
  };
  const invocation = await repo.createAgentToolInvocation({
    meetingId: meeting.id,
    utteranceId: context.utteranceId,
    userId: user.id,
    agentProfileId: profile.id,
    connectorId: connector.id,
    provider: "linear",
    toolName: "linear.create_issue",
    toolVersion: "v1",
    policyVersion: "v1",
    sideEffectClass: "write",
    status: "prepared",
    confirmationStatus: "pending",
    redactedResultSummary: { preview: { teamId: "team-1", title: "Test", description: "Test" } },
  });

  return {
    repo,
    invocation,
    input: { context, pendingInvocationId: invocation.id, confirmationActorUserId: user.id, user },
  };
}

void test("simultaneous confirmations execute one provider write and replay completion", async (t) => {
  const { repo, input } = await fixture();
  const get = repo.getAgentToolInvocationById;
  const barrier = deferred();
  const state = { reads: 0, writes: 0 };
  t.mock.method(repo, "getAgentToolInvocationById", async (id: string) => {
    const row = await get(id);
    state.reads += 1;
    if (state.reads <= CONCURRENT_REQUESTS) {
      if (state.reads === CONCURRENT_REQUESTS) {
        barrier.resolve();
      }
      await barrier.promise;
    }

    return row;
  });
  t.mock.method(globalThis, "fetch", async () => {
    state.writes += 1;

    return Response.json({
      data: { issueCreate: { /** @external Linear issueCreate success */ success: true, issue: ISSUE } },
    });
  });
  const results = await Promise.allSettled([confirmAgentTool(input), confirmAgentTool(input)]);
  assert.equal(state.writes, 1);
  assert.ok(
    results.some((result) => result.status === "fulfilled"),
    JSON.stringify(results),
  );
  const stored = await get(input.pendingInvocationId);
  assert.equal(stored?.status, "completed");
  const replay = await confirmAgentTool(input);
  assert.deepEqual(replay.result, stored.redactedResultSummary);
  assert.equal(state.writes, 1);
});

void test("confirmation rejects a different meeting or profile before disclosing a completed result", async (t) => {
  const { input } = await fixture();
  await setInvocationStatus({ invocationId: input.pendingInvocationId, changes: { status: "completed" } });
  t.mock.method(globalThis, "fetch", async () => assert.fail("No provider call for mismatched scope"));
  await Promise.all(
    [
      { ...input, context: { ...input.context, meetingId: randomUUID() } },
      { ...input, context: { ...input.context, agentProfileId: randomUUID() } },
      { ...input, context: { ...input.context, requestingUserId: randomUUID() } },
      { ...input, confirmationActorUserId: randomUUID() },
      { ...input, user: { ...input.user, id: randomUUID() } },
    ].map((request) => assert.rejects(confirmAgentTool(request))),
  );
});

void test("a running confirmation blocks both another confirmation and cancellation", async (t) => {
  const { repo, input } = await fixture();
  const entered = deferred();
  const release = deferred();
  t.mock.method(globalThis, "fetch", async () => {
    entered.resolve();
    await release.promise;

    return Response.json({
      data: { issueCreate: { /** @external Linear issueCreate success */ success: true, issue: ISSUE } },
    });
  });
  const winner = confirmAgentTool(input);
  try {
    await entered.promise;
    await assert.rejects(confirmAgentTool(input), CONFIRMATION_CONFLICT);
    await assert.rejects(
      cancelAgentToolInvocationFromMeetingClient({
        meetingId: input.context.meetingId,
        pendingInvocationId: input.pendingInvocationId,
        userId: input.user.id,
      }),
      CONFIRMATION_CONFLICT,
    );
  } finally {
    release.resolve();
    await winner;
  }
  assert.equal((await repo.getAgentToolInvocationById(input.pendingInvocationId))?.status, "completed");
});

void test("preparation rejects another owner and same-length changed arguments", async () => {
  const { input } = await fixture();
  const request = {
    context: input.context,
    user: input.user,
    toolName: "linear.create_issue",
    args: { title: "Test", description: "Private A", teamId: "team-1" },
    idempotencyKey: randomUUID(),
  };
  const prepared = await prepareAgentTool(request);
  const other = await fixture();
  await assert.rejects(
    prepareAgentTool({ ...request, context: other.input.context, user: other.input.user }),
    IDEMPOTENCY_CONFLICT,
  );
  await assert.rejects(
    prepareAgentTool({ ...request, args: { ...request.args, description: "Private B" } }),
    IDEMPOTENCY_CONFLICT,
  );
  assert.equal((await prepareAgentTool(request)).pendingInvocationId, prepared.pendingInvocationId);
  await Promise.all(
    [
      { ...request, context: { ...request.context, meetingId: randomUUID() } },
      { ...request, context: { ...request.context, agentProfileId: randomUUID() } },
      { ...request, toolName: "linear.update_issue" },
      { ...request, user: other.input.user },
    ].map((changed) => assert.rejects(prepareAgentTool(changed), IDEMPOTENCY_CONFLICT)),
  );
});

const WRITE_CASES = [
  {
    toolName: "linear.create_issue",
    args: { title: "Test", description: "Private A", teamId: "team-1" },
    changed: { title: "Test", description: "Private B", teamId: "team-1" },
  },
  {
    toolName: "linear.update_issue",
    args: { issueId: "issue-1", description: "Private A" },
    changed: { issueId: "issue-1", description: "Private B" },
  },
  {
    toolName: "linear.create_issue_relation",
    args: { id: "relation-1", issueId: "issue-1", relatedIssueId: "issue-2", type: "related" },
    changed: { id: "relation-1", issueId: "issue-1", relatedIssueId: "issue-3", type: "related" },
  },
  { toolName: "linear.upload_meeting_asset", args: { assetId: "asset-1" }, changed: { assetId: "asset-2" } },
  {
    toolName: "linear.mcp_write",
    args: { name: "save_issue", arguments: { id: "issue-1", nested: { title: "Private A" } } },
    changed: { name: "save_issue", arguments: { id: "issue-1", nested: { title: "Private B" } } },
  },
  {
    toolName: "linear.mcp_batch_write",
    args: {
      calls: [
        { name: "save_issue", arguments: { id: "issue-1" } },
        { name: "save_issue", arguments: { id: "issue-2" } },
      ],
    },
    changed: {
      calls: [
        { name: "save_issue", arguments: { id: "issue-2" } },
        { name: "save_issue", arguments: { id: "issue-1" } },
      ],
    },
  },
];

void test("every write tool checks complete arguments and preserves its fingerprint after completion", async (t) => {
  const { repo, input } = await fixture();
  await Promise.all(
    WRITE_CASES.map(async (example) => {
      await t.test(example.toolName, async () => {
        const request = {
          context: input.context,
          user: input.user,
          toolName: example.toolName,
          args: example.args,
          idempotencyKey: randomUUID(),
        };
        const prepared = await prepareAgentTool(request);
        const stored = await repo.getAgentToolInvocationById(prepared.pendingInvocationId);
        assert.ok(stored);
        const fingerprint = stored.redactedArgs.requestFingerprintV1;
        assert.equal(typeof fingerprint, "string");
        assert.equal(
          (
            await prepareAgentTool({
              ...request,
              args: Object.fromEntries([...Object.entries(example.args)].reverse()),
            })
          ).pendingInvocationId,
          stored.id,
        );
        await assert.rejects(prepareAgentTool({ ...request, args: example.changed }), IDEMPOTENCY_CONFLICT);
        await setInvocationStatus({
          invocationId: stored.id,
          changes: { status: "completed", redactedResultSummary: { result: "finished" } },
        });
        assert.equal((await prepareAgentTool(request)).pendingInvocationId, stored.id);
        assert.equal(
          (await repo.getAgentToolInvocationById(stored.id))?.redactedArgs.requestFingerprintV1,
          fingerprint,
        );
        await assert.rejects(prepareAgentTool({ ...request, args: example.changed }), IDEMPOTENCY_CONFLICT);
      });
    }),
  );
});

void test("concurrent matching prepares return one invocation and conflicting prepares reveal no preview", async (t) => {
  const { repo, input } = await fixture();
  const get = repo.getAgentToolInvocationByIdempotencyKey;
  const barrier = deferred();
  const state = { reads: 0 };
  t.mock.method(repo, "getAgentToolInvocationByIdempotencyKey", async (key: string) => {
    const row = await get(key);
    state.reads += 1;
    if (state.reads <= CONCURRENT_REQUESTS) {
      if (state.reads === CONCURRENT_REQUESTS) {
        barrier.resolve();
      }
      await barrier.promise;
    }

    return row;
  });
  const request = {
    context: input.context,
    user: input.user,
    toolName: "linear.create_issue",
    args: { title: "Test", teamId: "team-1" },
    idempotencyKey: randomUUID(),
  };
  const results = await Promise.all([prepareAgentTool(request), prepareAgentTool(request)]);
  assert.equal(new Set(results.map((result) => result.pendingInvocationId)).size, 1);
  const key = randomUUID();
  const conflicts = await Promise.allSettled([
    prepareAgentTool({ ...request, idempotencyKey: key }),
    prepareAgentTool({ ...request, idempotencyKey: key, args: { ...request.args, title: "Different" } }),
  ]);
  assert.equal(conflicts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = conflicts.find((result) => result.status === "rejected");
  assert.ok(rejected);
  assert.match(String(rejected.reason), /original request/);
  assert.doesNotMatch(JSON.stringify(rejected.reason), /preview|Different/);
});

void test("matching active and failed updates retain retry behavior", async () => {
  const { repo, input } = await fixture();
  const request = {
    context: input.context,
    user: input.user,
    toolName: "linear.update_issue",
    args: { issueId: "issue-1", description: "Private" },
    idempotencyKey: randomUUID(),
  };
  const prepared = await prepareAgentTool(request);
  await setInvocationStatus({
    invocationId: prepared.pendingInvocationId,
    changes: { status: "running", confirmationStatus: "confirmed", confirmedAt: new Date() },
  });
  assert.equal((await prepareAgentTool(request)).pendingInvocationId, prepared.pendingInvocationId);
  assert.equal((await repo.getAgentToolInvocationById(prepared.pendingInvocationId))?.status, "running");
  await setInvocationStatus({ invocationId: prepared.pendingInvocationId, changes: { status: "failed" } });
  await assert.rejects(
    prepareAgentTool({ ...request, args: { ...request.args, description: "Changed" } }),
    IDEMPOTENCY_CONFLICT,
  );
  assert.equal((await repo.getAgentToolInvocationById(prepared.pendingInvocationId))?.status, "failed");
  await prepareAgentTool(request);
  assert.equal((await repo.getAgentToolInvocationById(prepared.pendingInvocationId))?.status, "prepared");
});

void test("concurrent identical retries of a failed update both return the reopened invocation", async (t) => {
  const { repo, input } = await fixture();
  const request = {
    context: input.context,
    user: input.user,
    toolName: "linear.update_issue",
    args: { issueId: "issue-1", description: "Private" },
    idempotencyKey: randomUUID(),
  };
  const prepared = await prepareAgentTool(request);
  await setInvocationStatus({
    invocationId: prepared.pendingInvocationId,
    changes: { status: "failed", confirmationStatus: "confirmed", confirmedAt: new Date() },
  });
  const get = repo.getAgentToolInvocationByIdempotencyKey;
  const barrier = deferred();
  const state = { reads: 0 };
  t.mock.method(repo, "getAgentToolInvocationByIdempotencyKey", async (key: string) => {
    const row = await get(key);
    state.reads += 1;
    if (state.reads <= CONCURRENT_REQUESTS) {
      if (state.reads === CONCURRENT_REQUESTS) {
        barrier.resolve();
      }
      await barrier.promise;
    }

    return row;
  });
  const results = await Promise.all([prepareAgentTool(request), prepareAgentTool(request)]);
  assert.deepEqual(
    results.map((result) => result.pendingInvocationId),
    [prepared.pendingInvocationId, prepared.pendingInvocationId],
  );
  assert.deepEqual(results[0], results[1]);
  const stored = await repo.getAgentToolInvocationById(prepared.pendingInvocationId);
  assert.equal(stored?.status, "prepared");
  assert.equal(stored.confirmationStatus, "pending");
});

void test("a retry that loses to a confirmation still reports the conflict", async (t) => {
  const { repo, input } = await fixture();
  const request = {
    context: input.context,
    user: input.user,
    toolName: "linear.update_issue",
    args: { issueId: "issue-1", description: "Private" },
    idempotencyKey: randomUUID(),
  };
  const prepared = await prepareAgentTool(request);
  await setInvocationStatus({
    invocationId: prepared.pendingInvocationId,
    changes: { status: "failed", confirmationStatus: "confirmed", confirmedAt: new Date() },
  });
  const failed = await repo.getAgentToolInvocationById(prepared.pendingInvocationId);
  t.mock.method(repo, "getAgentToolInvocationByIdempotencyKey", async () => {
    // Another request reopens and starts running the invocation after this retry read it.
    await setInvocationStatus({
      invocationId: prepared.pendingInvocationId,
      changes: { status: "running", confirmationStatus: "confirmed", confirmedAt: new Date() },
    });

    return failed;
  });
  await assert.rejects(prepareAgentTool(request), CONFIRMATION_CONFLICT);
});

void test("nested key order does not change MCP request identity", async () => {
  const { input } = await fixture();
  const request = {
    context: input.context,
    user: input.user,
    toolName: "linear.mcp_write",
    args: { name: "save_issue", arguments: { id: "issue-1", options: { title: "Test", labels: ["a", "b"] } } },
    idempotencyKey: randomUUID(),
  };
  const prepared = await prepareAgentTool(request);
  assert.equal(
    (
      await prepareAgentTool({
        ...request,
        args: { name: "save_issue", arguments: { options: { labels: ["a", "b"], title: "Test" }, id: "issue-1" } },
      })
    ).pendingInvocationId,
    prepared.pendingInvocationId,
  );
});

void test("preparation propagates unrelated database errors", async (t) => {
  const { repo, input } = await fixture();
  const failure = new Error(DATABASE_FAILURE_MESSAGE);
  t.mock.method(repo, "createAgentToolInvocation", async () => {
    throw failure;
  });
  await assert.rejects(
    prepareAgentTool({
      context: input.context,
      user: input.user,
      toolName: "linear.create_issue",
      args: { title: "Test", teamId: "team-1" },
      idempotencyKey: randomUUID(),
    }),
    (error) => error === failure,
  );
});

void test("legacy requests need complete evidence and truncated keys cannot reuse changed actions", async () => {
  const { repo, input } = await fixture();
  const keyLength = 180;
  const request = {
    context: input.context,
    user: input.user,
    toolName: "linear.create_issue",
    args: { title: "Legacy", description: "Private", teamId: "team-1" },
    idempotencyKey: "k".repeat(keyLength),
  };
  const prepared = await prepareAgentTool({ ...request, idempotencyKey: randomUUID() });
  const row = await repo.getAgentToolInvocationById(prepared.pendingInvocationId);
  assert.ok(row);
  const legacy = await repo.createAgentToolInvocation({
    ...row,
    idempotencyKey: randomUUID(),
    redactedArgs: { teamId: "team-1", title: "Legacy", descriptionLength: "Private".length },
  });
  assert.equal(
    (await prepareAgentTool({ ...request, idempotencyKey: legacy.idempotencyKey ?? "" })).pendingInvocationId,
    legacy.id,
  );
  await setInvocationStatus({
    invocationId: legacy.id,
    changes: { status: "completed", redactedResultSummary: { issue: ISSUE } },
  });
  await assert.rejects(
    prepareAgentTool({ ...request, idempotencyKey: legacy.idempotencyKey ?? "" }),
    IDEMPOTENCY_CONFLICT,
  );
  const prefix = randomUUID().padEnd(keyLength, "k");
  await prepareAgentTool({ ...request, idempotencyKey: `${prefix}a` });
  await assert.rejects(
    prepareAgentTool({ ...request, idempotencyKey: `${prefix}b`, args: { ...request.args, title: "Other" } }),
    IDEMPOTENCY_CONFLICT,
  );
});
