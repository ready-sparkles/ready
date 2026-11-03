import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  completeAiWorkflowJob,
  createMeeting,
  getLatestAiWorkflowJobForMeeting,
  getMeetingById,
  getMeetingTaskListForMeeting,
  getSummaryForMeeting,
  listActionItemsForMeeting,
  replaceActionItemsForMeeting,
  replaceAndCompleteMeetingTasksForList,
  replaceMeetingTasksForList,
  startAiWorkflowExecution,
  updateMeetingTitleIfCurrent,
  upsertMeetingTaskList,
  upsertSummaryForMeeting,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";
import { REQUEST_EXECUTION_MAX_AGE_MS } from "../domain/request-execution";

const RETRY_ACTION_TEXT = "New action";

after(closeDbPool);
void test("reading abandoned task execution permits retry without reviving old history", async () => {
  const user = await upsertUser({ email: `${randomUUID()}@expiry.test`, displayName: "Expiry fixture" });
  const meeting = await createMeeting({
    title: "Expiry",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const input = { meetingId: meeting.id, type: "generate_meeting_tasks" as const };
  const original = await startAiWorkflowExecution(input);
  await db.aiWorkflowExecutions.updateMany({
    where: { id: original.id },
    data: { startedAt: new Date(Date.now() - REQUEST_EXECUTION_MAX_AGE_MS - 1) },
  });
  const expired = await getLatestAiWorkflowJobForMeeting(input);
  assert.equal(expired?.status, "failed");
  assert.equal(expired.phase, "interrupted");
  const retry = await startAiWorkflowExecution(input);
  assert.notEqual(retry.id, original.id);
  await assert.rejects(completeAiWorkflowJob({ jobId: original.id }));
  await upsertSummaryForMeeting({ meetingId: meeting.id, jobId: retry.id, content: "New notes", model: "retry" });
  await replaceActionItemsForMeeting(meeting.id, [{ text: RETRY_ACTION_TEXT }], retry.id);
  const list = await upsertMeetingTaskList({ meetingId: meeting.id, jobId: retry.id, status: "generating" });
  const writes = [
    () => upsertSummaryForMeeting({ meetingId: meeting.id, jobId: original.id, content: "Stale notes", model: "old" }),
    () => replaceActionItemsForMeeting(meeting.id, [], original.id),
    () => upsertMeetingTaskList({ meetingId: meeting.id, jobId: original.id, status: "failed" }),
    () => replaceMeetingTasksForList({ meetingId: meeting.id, taskListId: list.id, jobId: original.id, items: [] }),
    () =>
      replaceAndCompleteMeetingTasksForList({
        meetingId: meeting.id,
        taskListId: list.id,
        jobId: original.id,
        items: [],
      }),
    () =>
      updateMeetingTitleIfCurrent({
        meetingId: meeting.id,
        jobId: original.id,
        currentTitle: "Expiry",
        title: "Stale title",
      }),
  ];
  await writes.reduce(async (previous, write) => {
    await previous;
    await assert.rejects(write(), /interrupted|deadline/);
  }, Promise.resolve());
  assert.equal((await getSummaryForMeeting(meeting.id))?.content, "New notes");
  assert.equal((await listActionItemsForMeeting(meeting.id))[0]?.text, "New action");
  assert.equal((await getMeetingTaskListForMeeting(meeting.id))?.status, "generating");
  assert.equal((await getMeetingById(meeting.id))?.title, "Expiry");
  await replaceAndCompleteMeetingTasksForList({
    meetingId: meeting.id,
    taskListId: list.id,
    jobId: retry.id,
    items: [],
  });
  assert.equal((await getMeetingTaskListForMeeting(meeting.id))?.status, "completed");
  await completeAiWorkflowJob({ jobId: retry.id });
  assert.equal((await getLatestAiWorkflowJobForMeeting(input))?.status, "completed");
});
