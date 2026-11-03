import { closeDbPool, db } from "@readymeet/db";
import { REQUEST_EXECUTION_MAX_AGE_MS, RequestExecutionExpiredError } from "@readymeet/db/domain/request-execution";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { generateAndPersistMeetingTasks } from "../../application/task-artifacts";
import { repositories } from "../../ports/repository-runtime";

const PROVIDER_FAILURE_MESSAGE = "Provider connection closed after retry completed.";
function deferred() {
  const gate = { resolve: () => undefined as void };
  const promise = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });

  return { promise, resolve: () => gate.resolve() };
}

after(closeDbPool);

void test("late ordinary task failure cannot change completed retry status", async (t) => {
  const repo = repositories();
  const user = await repo.upsertUser({ email: `${randomUUID()}@task-failure.test`, displayName: "Failure fixture" });
  const meeting = await repo.createMeeting({
    title: "Late task failure",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const input = { meetingId: meeting.id, type: "generate_meeting_tasks" as const };
  const first = await repo.startAiWorkflowExecution(input);
  const provider = deferred();
  const entered = deferred();
  t.mock.method(repo, "withMeetingLiveTaskDetectionLock", async () => {
    entered.resolve();

    await provider.promise;
    throw new Error(PROVIDER_FAILURE_MESSAGE);
  });
  const pending = generateAndPersistMeetingTasks(meeting.id, {}, { jobId: first.id });
  const rejected = assert.rejects(pending, RequestExecutionExpiredError);
  await entered.promise;
  await db.aiWorkflowExecutions.updateMany({
    where: { id: first.id },
    data: { startedAt: new Date(Date.now() - REQUEST_EXECUTION_MAX_AGE_MS - 1) },
  });
  await repo.getLatestAiWorkflowJobForMeeting(input);
  const retry = await repo.startAiWorkflowExecution(input);
  await repo.upsertMeetingTaskList({
    meetingId: meeting.id,
    jobId: retry.id,
    status: "completed",
    completedAt: new Date(),
  });
  await repo.completeAiWorkflowJob({ jobId: retry.id });
  provider.resolve();
  await rejected;
  assert.equal((await repo.getMeetingTaskListForMeeting(meeting.id))?.status, "completed");
  assert.equal((await repo.getLatestAiWorkflowJobForMeeting(input))?.id, retry.id);
});

void test("current ordinary task failure is persisted using its execution identity", async (t) => {
  const repo = repositories();
  const user = await repo.upsertUser({ email: `${randomUUID()}@task-failure.test`, displayName: "Failure fixture" });
  const meeting = await repo.createMeeting({
    title: "Task failure",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  t.mock.method(repo, "withMeetingLiveTaskDetectionLock", async () => {
    throw new Error(PROVIDER_FAILURE_MESSAGE);
  });
  await assert.rejects(generateAndPersistMeetingTasks(meeting.id, {}), { message: PROVIDER_FAILURE_MESSAGE });
  assert.equal((await repo.getMeetingTaskListForMeeting(meeting.id))?.status, "failed");
  assert.equal(
    (await repo.getLatestAiWorkflowJobForMeeting({ meetingId: meeting.id, type: "generate_meeting_tasks" }))?.status,
    "failed",
  );
});
