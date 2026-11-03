import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool } from "../adapters/secondary/postgres/client";
import {
  createAgentToolInvocation,
  createMeeting,
  ensureDefaultAgentProfileForUser,
  getAgentToolInvocationById,
  transitionAgentToolInvocation,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

after(closeDbPool);

async function fixture() {
  const user = await upsertUser({ email: `${randomUUID()}@invocation.test`, displayName: "Requester" });
  const meeting = await createMeeting({
    title: "Invocation",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const profile = await ensureDefaultAgentProfileForUser({ userId: user.id, displayName: user.displayName });

  return createAgentToolInvocation({
    meetingId: meeting.id,
    userId: user.id,
    agentProfileId: profile.id,
    utteranceId: randomUUID(),
    provider: "linear",
    toolName: "linear.create_issue",
    toolVersion: "v1",
    policyVersion: "v1",
    sideEffectClass: "write",
    status: "prepared",
    confirmationStatus: "pending",
  });
}

const CLAIM = { status: "running", confirmationStatus: "confirmed" };

void test("concurrent invocation claims have one database winner", async () => {
  const expected = await fixture();
  const results = await Promise.all([
    transitionAgentToolInvocation({ expected, changes: CLAIM }),
    transitionAgentToolInvocation({ expected, changes: CLAIM }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await getAgentToolInvocationById(expected.id))?.status, "running");
});

void test("confirmation and cancellation cannot both win", async () => {
  const expected = await fixture();
  const [claimed, cancelled] = await Promise.all([
    transitionAgentToolInvocation({ expected, changes: CLAIM }),
    transitionAgentToolInvocation({ expected, changes: { status: "cancelled", confirmationStatus: "declined" } }),
  ]);
  assert.equal(Number(claimed !== null) + Number(cancelled !== null), 1);
  assert.equal((await getAgentToolInvocationById(expected.id))?.status, claimed === null ? "cancelled" : "running");
});

void test("retry keeps increasing attempt times and rejects stale state writes", async () => {
  const expected = await fixture();
  const first = await transitionAgentToolInvocation({ expected, changes: CLAIM });
  assert.ok(first?.confirmedAt);
  const failed = await transitionAgentToolInvocation({ expected: first, changes: { status: "failed" } });
  assert.ok(failed);
  const retried = await transitionAgentToolInvocation({
    expected: failed,
    changes: { status: "prepared", confirmationStatus: "pending" },
  });
  assert.ok(retried);
  const second = await transitionAgentToolInvocation({ expected: retried, changes: CLAIM });
  assert.ok(second?.confirmedAt);
  assert.ok(second.confirmedAt.getTime() > first.confirmedAt.getTime());
  assert.equal(await transitionAgentToolInvocation({ expected: first, changes: { status: "completed" } }), null);
  assert.equal(
    await transitionAgentToolInvocation({
      expected: failed,
      changes: { status: "prepared", confirmationStatus: "pending" },
    }),
    null,
  );
  assert.equal((await getAgentToolInvocationById(expected.id))?.status, "running");
});

void test("wrong invocation scope and confirmation state cannot claim", async () => {
  const expected = await fixture();
  await Promise.all(
    [
      { userId: randomUUID() },
      { meetingId: randomUUID() },
      { agentProfileId: randomUUID() },
      { confirmationStatus: "confirmed" },
    ].map(async (mismatch) => {
      assert.equal(
        await transitionAgentToolInvocation({ expected: { ...expected, ...mismatch }, changes: CLAIM }),
        null,
      );
    }),
  );
});
