import type { MeetingTaskCandidate } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool } from "../adapters/secondary/postgres/client";
import {
  claimLinearTaskReviewRunAction,
  createLinearTaskReviewRun,
  createMeeting,
  deleteMeetingTasksByIds,
  ensureDefaultAgentProfileForUser,
  getLinearTaskReviewById,
  getMeetingTaskListForMeeting,
  replaceLinearTaskReviewItems,
  replaceMeetingTasksForList,
  updateLinearTaskReviewItem,
  updateLinearTaskReviewRun,
  updateMeetingTask,
  upsertAgentConnector,
  upsertMeetingTaskList,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

const LINEAR_REVIEW_CONFIDENCE = 0.95;

after(async () => {
  await closeDbPool();
});

function taskCandidate(): MeetingTaskCandidate {
  return {
    title: "Build the export flow",
    description: "Add a streaming CSV export path.",
    type: "task",
    workKind: "implementation",
    owner: { userId: null, name: null, email: null, confidence: null },
    dueDate: { value: null, confidence: null },
    confidence: "high",
    completion: {
      /** @external completedDuringMeeting */ completedDuringMeeting: false,
      quote: null,
      confidence: null,
    },
    sourceQuotes: [
      {
        quote: "We should build the streaming CSV export path.",
        speaker: "Linear Review Tester",
        timestamp: "2026-08-05T12:00:00.000Z",
        segmentId: randomUUID(),
      },
    ],
    sourceReason: "The meeting assigned concrete implementation work.",
  };
}

async function createReviewFixture() {
  const user = await upsertUser({
    email: `${randomUUID()}@linear-review.readymeet.test`,
    displayName: "Linear Review Tester",
  });
  const meeting = await createMeeting({
    title: "Linear review repository test",
    roomName: `linear-review-${randomUUID()}`,
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const taskList = await upsertMeetingTaskList({
    meetingId: meeting.id,
    status: "completed",
    phase: "complete",
  });
  const [task] = await replaceMeetingTasksForList({
    meetingId: meeting.id,
    taskListId: taskList.id,
    items: [taskCandidate()],
  });
  assert.ok(task);
  const profile = await ensureDefaultAgentProfileForUser({
    userId: user.id,
    displayName: user.displayName,
    voiceId: null,
    llmModel: null,
  });
  const connector = await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "linear",
    status: "connected",
  });
  const run = await createLinearTaskReviewRun({
    meetingId: meeting.id,
    taskListId: taskList.id,
    userId: user.id,
    connectorId: connector.id,
    inputHash: randomUUID().replaceAll("-", ""),
    inputSnapshot: [{ id: task.id, title: task.title }],
  });
  await replaceLinearTaskReviewItems({
    runId: run.id,
    candidates: [
      {
        sourceTaskIds: [task.id],
        decision: "linear",
        confidence: LINEAR_REVIEW_CONFIDENCE,
        reasoning: "Concrete product implementation work.",
        title: task.title,
        description: task.description,
        issueDraft: null,
        teamId: "team-1",
        teamName: "Engineering",
        duplicateIssues: [],
        targetAction: "create",
        targetIssue: null,
        relationId: null,
      },
    ],
  });
  await updateLinearTaskReviewRun({
    runId: run.id,
    status: "awaiting_user",
    phase: "awaiting_user",
  });

  return { meeting, task, taskList, run };
}

void test("only one concurrent review action can claim an awaiting run", async () => {
  const { run } = await createReviewFixture();
  const claims = await Promise.all([
    claimLinearTaskReviewRunAction({ runId: run.id, status: "syncing", phase: "creating_issues" }),
    claimLinearTaskReviewRunAction({ runId: run.id, status: "syncing", phase: "creating_issues" }),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.status, "syncing");
});

void test("linked issue meeting-context checkpoint survives a cleanup retry", async () => {
  const { run } = await createReviewFixture();
  const review = await getLinearTaskReviewById(run.id);
  const item = review?.items[0];
  assert.ok(item);
  const syncedAt = new Date("2026-08-05T12:30:00.000Z");

  await updateLinearTaskReviewItem({
    itemId: item.id,
    syncStatus: "failed",
    meetingContextSyncedAt: syncedAt,
  });

  const retry = await getLinearTaskReviewById(run.id);
  assert.equal(retry?.items[0]?.meetingContextSyncedAt, syncedAt.toISOString());
});

void test("removing a Linear-backed Ready task twice is idempotent", async () => {
  const { meeting, task } = await createReviewFixture();
  const before = await getMeetingTaskListForMeeting(meeting.id);

  const first = await deleteMeetingTasksByIds({ meetingId: meeting.id, taskIds: [task.id] });
  const second = await deleteMeetingTasksByIds({ meetingId: meeting.id, taskIds: [task.id] });

  const updated = await getMeetingTaskListForMeeting(meeting.id);
  assert.deepEqual(first, [task.id]);
  assert.deepEqual(second, []);
  assert.equal(
    updated?.items.some((item) => item.id === task.id),
    false,
  );
  assert.equal(updated.taskListVersion, (before?.taskListVersion ?? 0) + 1);
});

void test("conditional Ready cleanup preserves a task with a newer revision", async () => {
  const { meeting, task } = await createReviewFixture();
  await updateMeetingTask({
    meetingId: meeting.id,
    taskId: task.id,
    title: "Edited after Linear confirmation",
  });

  await assert.rejects(
    deleteMeetingTasksByIds({
      meetingId: meeting.id,
      taskIds: [task.id],
      expectedRevisions: { [task.id]: task.revision },
    }),
    /changed before conditional deletion/,
  );

  const updated = await getMeetingTaskListForMeeting(meeting.id);
  assert.equal(updated?.items.find((item) => item.id === task.id)?.title, "Edited after Linear confirmation");
});
