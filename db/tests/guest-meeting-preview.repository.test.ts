import { GUEST_MEETING_PREVIEW_SCOPE } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  completeAiWorkflowJob,
  createMeeting,
  ensureGuestMeetingPreviewJob,
  failAiWorkflowJob,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";
import { REQUEST_EXECUTION_MAX_AGE_MS } from "../domain/request-execution";

const PROVIDER_UNAVAILABLE_MESSAGE = "provider unavailable";

after(closeDbPool);
void test("completed previews are reusable; failed requests create fresh history", async () => {
  const user = await upsertUser({ email: `${randomUUID()}@preview.test`, displayName: "Fixture" });
  const meeting = await createMeeting({
    title: "Preview",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  try {
    const firstRequests = await Promise.all([
      ensureGuestMeetingPreviewJob(meeting.id),
      ensureGuestMeetingPreviewJob(meeting.id),
    ]);
    const first = firstRequests[0];
    assert.equal(new Set(firstRequests.map((job) => job?.id)).size, 1);
    assert.ok(first);
    assert.equal(first.status, "running");
    assert.equal(first.scopeKey, GUEST_MEETING_PREVIEW_SCOPE);
    const overlapping = await Promise.all([
      ensureGuestMeetingPreviewJob(meeting.id),
      ensureGuestMeetingPreviewJob(meeting.id),
    ]);
    assert.ok(overlapping.every((job) => job?.id === first.id));
    await failAiWorkflowJob({ jobId: first.id, error: PROVIDER_UNAVAILABLE_MESSAGE });
    const retry = await ensureGuestMeetingPreviewJob(meeting.id);
    assert.ok(retry);
    assert.notEqual(retry.id, first.id);
    await db.aiWorkflowExecutions.updateMany({
      where: { id: retry.id },
      data: {
        startedAt: new Date(Date.now() - REQUEST_EXECUTION_MAX_AGE_MS - 1),
      },
    });
    const replacement = await ensureGuestMeetingPreviewJob(meeting.id);
    assert.ok(replacement);
    assert.notEqual(replacement.id, retry.id);
    await assert.rejects(completeAiWorkflowJob({ jobId: retry.id }));
    await completeAiWorkflowJob({ jobId: replacement.id, result: { preparationLines: ["The pilot starts Tuesday."] } });
    assert.equal((await ensureGuestMeetingPreviewJob(meeting.id))?.id, replacement.id);
  } finally {
    await db.meetings.deleteMany({ where: { id: meeting.id } });
    await db.users.deleteMany({ where: { id: user.id } });
  }
});
