import "../composition/env";

import { closeDbPool, createMeeting, markMeetingEnded, updateUserPlan, upsertUser } from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { canUseLinearTaskReviewForMeeting } from "../application/linear-task-review-service";

after(async () => {
  await closeDbPool();
});

void test("Linear task review follows the post-meeting notes paywall", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@linear-review-access.readymeet.test`,
    displayName: "Linear Review Access Tester",
  });
  await updateUserPlan({
    userId: user.id,
    plan: "business",
    /** @external updateUserPlan billing flag */
    privateBetaProEnabled: false,
  });
  const meeting = await createMeeting({
    title: "Locked Linear review",
    roomName: `linear-review-access-${randomUUID()}`,
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });

  await markMeetingEnded(meeting.id);

  assert.equal(await canUseLinearTaskReviewForMeeting(meeting.id, user.id), false);
});

void test("Linear task review rejects users who do not own the meeting", async () => {
  const owner = await upsertUser({
    email: `${randomUUID()}@linear-review-owner.readymeet.test`,
    displayName: "Linear Review Owner",
  });
  const otherUser = await upsertUser({
    email: `${randomUUID()}@linear-review-other.readymeet.test`,
    displayName: "Linear Review Other User",
  });
  const meeting = await createMeeting({
    title: "Owner-only Linear review",
    roomName: `linear-review-owner-${randomUUID()}`,
    createdByUserId: owner.id,
    workspaceId: owner.workspaceId,
  });

  assert.equal(await canUseLinearTaskReviewForMeeting(meeting.id, otherUser.id), false);
});
