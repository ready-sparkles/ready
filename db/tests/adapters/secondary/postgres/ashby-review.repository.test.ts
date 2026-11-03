import type { AshbyReview } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { connectAshbyMember, saveWorkspaceAshbyIntegration } from "../../../../adapters/secondary/postgres/ashby";
import {
  claimAshbyAction,
  createAshbyReview,
  finishAshbyAction,
  getAshbyReviewById,
  listAshbyReviewViewers,
  saveAshbyReview,
} from "../../../../adapters/secondary/postgres/ashby-review";
import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import {
  createMeeting,
  ensureWorkspaceMembership,
  upsertUser,
} from "../../../../adapters/secondary/postgres/repositories";

after(closeDbPool);

const EXPECTED_ASHBY_VIEWER_COUNT_AFTER_SECOND_CONNECT = 2;
const EXPECTED_ASHBY_REVIEW_REVISION = 1;
const EXPECTED_CONCURRENT_SAVE_SUCCESS_COUNT = 1;

async function fixture() {
  const user = await upsertUser({
    email: `${randomUUID()}@ashby-review.test`,
    displayName: "Reviewer",
  });
  const meeting = await createMeeting({
    title: "Ashby review",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  await db.meetings.updateMany({ where: { id: meeting.id }, data: { status: "ended" } });
  await saveWorkspaceAshbyIntegration({
    workspaceId: user.workspaceId,
    configuredByUserId: user.id,
    secretRef: "test",
  });
  await connectAshbyMember({ workspaceId: user.workspaceId, userId: user.id });
  const review: AshbyReview = {
    id: randomUUID(),
    meetingId: meeting.id,
    userId: user.id,
    workspaceId: user.workspaceId,
    inputHash: "hash",
    connectionVersion: "version",
    revision: 0,
    status: "awaiting_user",
    items: [],
    error: null,
    clarification: null,
    updatedAt: new Date().toISOString(),
  };

  return { user, meeting, review: await createAshbyReview(review) };
}
void test("only connected active participants qualify, including a second participant", async () => {
  const { user, meeting } = await fixture();
  const member = await upsertUser({
    email: `${randomUUID()}@ashby-review.test`,
    displayName: "Participant",
  });
  await ensureWorkspaceMembership({
    workspaceId: user.workspaceId,
    userId: member.id,
    role: "member",
  });
  await db.meetingParticipants.create({
    data: {
      meetingId: meeting.id,
      userId: member.id,
      role: "guest",
    },
  });
  assert.deepEqual(
    (await listAshbyReviewViewers({ meetingId: meeting.id })).map((v) => v.userId),
    [user.id],
  );
  await connectAshbyMember({ workspaceId: user.workspaceId, userId: member.id });
  assert.equal(
    (await listAshbyReviewViewers({ meetingId: meeting.id })).length,
    EXPECTED_ASHBY_VIEWER_COUNT_AFTER_SECOND_CONNECT,
  );
  await db.workspaceMemberships.updateMany({
    where: { workspaceId: user.workspaceId, userId: member.id },
    data: { status: "suspended" },
  });
  assert.deepEqual(
    (await listAshbyReviewViewers({ meetingId: meeting.id })).map((v) => v.userId),
    [user.id],
  );
});
void test("concurrent revisions accept exactly one command and atomically enqueue it", async () => {
  const { review } = await fixture();
  const next = { ...review, revision: 1, status: "revising" as const };
  const results = await Promise.allSettled([
    saveAshbyReview({ review: next, expectedRevision: 0, command: { action: "revise", instruction: "A" } }),
    saveAshbyReview({ review: next, expectedRevision: 0, command: { action: "revise", instruction: "B" } }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, EXPECTED_CONCURRENT_SAVE_SUCCESS_COUNT);
  assert.equal((await getAshbyReviewById({ id: review.id }))?.review.revision, EXPECTED_ASHBY_REVIEW_REVISION);
  assert.equal((await getAshbyReviewById({ id: review.id }))?.review.status, "revising");
});
void test("simultaneous viewers claim a target once; unknown outcomes never retry", async () => {
  const { review } = await fixture();
  const input = {
    workspaceId: review.workspaceId,
    meetingId: review.meetingId,
    kind: "stage" as const,
    targetId: "candidate",
    intent: { stageId: "intended" },
  };
  const claims = await Promise.all([claimAshbyAction(input), claimAshbyAction(input), claimAshbyAction(input)]);
  assert.equal(claims.filter((c) => c.acquired).length, 1);
  assert.equal(new Set(claims.map((c) => c.id)).size, 1);
  assert.equal((await claimAshbyAction(input)).acquired, false);
  assert.equal((await claimAshbyAction(input)).result?.stageId, "intended");
  await finishAshbyAction({ id: claims[0].id, status: "completed", result: {} });
  assert.equal((await claimAshbyAction(input)).status, "completed");
  assert.equal((await claimAshbyAction(input)).acquired, false);
});
void test("known rejections can be explicitly confirmed again and only one retry wins", async () => {
  const { review } = await fixture();
  const input = {
    workspaceId: review.workspaceId,
    meetingId: review.meetingId,
    kind: "stage" as const,
    targetId: "app",
  };
  const initial = await claimAshbyAction(input);
  await finishAshbyAction({ id: initial.id, status: "rejected", result: { reason: "missing_permission" } });
  const claims = await Promise.all([claimAshbyAction(input), claimAshbyAction(input)]);
  assert.equal(claims.filter((c) => c.acquired).length, 1);
});
