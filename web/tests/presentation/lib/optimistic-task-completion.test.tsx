import type { AssignedTaskSummary, MeetingTask, MeetingTaskList, UnifiedAssignedTask } from "@readymeet/shared";
import { meetingNotesViewResponseSchema } from "@readymeet/shared";
import { QueryClient } from "@tanstack/react-query";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  assignedTasksQueryKey,
  meetingDetailQueryKey,
  meetingNotesViewQueryKey,
  personalAssignedTasksQueryKey,
  terminalMeetingTasksStatusQueryKey,
  workspaceAssignedTasksQueryKey,
} from "../../../domain/query-keys";
import type { MeetingDetailPayload, MeetingNotesViewPayload } from "../../../domain/types";
import type { MeetingTasksStatusView } from "../../../presentation/components/use-meeting-tasks-status";
import {
  createOptimisticTaskCompletionController,
  patchTaskInCaches,
} from "../../../presentation/lib/optimistic-task-completion";

const meetingId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const taskListId = "55555555-5555-4555-8555-555555555555";
const userId = "66666666-6666-4666-8666-666666666666";

function task(...args: [status: MeetingTask["status"], revision?: number]): MeetingTask {
  const [status, revision = 1] = args;

  return {
    id: taskId,
    meetingId,
    taskListId,
    position: 0,
    title: "Send the launch note",
    description: null,
    type: "follow_up",
    workKind: "general",
    assignee: {
      userId,
      name: "Personbr",
      email: "personbr@example.com",
      confidence: "high",
    },
    owner: {
      userId,
      name: "Personbr",
      email: "personbr@example.com",
      confidence: "high",
    },
    dueDate: {
      value: null,
      confidence: null,
    },
    sourceQuotes: [
      {
        quote: "Can you send the launch note?",
        speaker: "Personbr",
        timestamp: null,
      },
    ],
    sourceReason: "Personbr asked for the launch note.",
    confidence: "high",
    assetIds: [],
    status,
    revision,
    createdFrom: "meeting_transcript",
    origin: "final",
    statusSource: "model",
    statusActorUserId: null,
    statusChangedAt: null,
    actionConfirmableAt: null,
    detectedAt: null,
    firstRenderedAt: null,
    externalLinks: [],
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
    completedAt: status === "completed" ? "2026-05-01T12:05:00.000Z" : null,
  };
}

function taskList(item: MeetingTask): MeetingTaskList {
  return {
    id: taskListId,
    meetingId,
    status: "completed",
    phase: "complete",
    error: null,
    model: "test-model",
    promptVersion: "1.1.1",
    transcriptHash: "hash",
    taskListVersion: 1,
    items: [item],
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
    completedAt: "2026-05-01T12:00:00.000Z",
  };
}

function meetingDetail(item: MeetingTask): MeetingDetailPayload {
  return {
    meeting: {
      id: meetingId,
      workspaceId: "77777777-7777-4777-8777-777777777777",
      title: "Launch review",
      status: "ended",
      roomName: "abc-defg-hij",
      createdByUserId: userId,
      createdAt: "2026-05-01T12:00:00.000Z",
      startedAt: "2026-05-01T12:00:00.000Z",
      endedAt: "2026-05-01T12:30:00.000Z",
      isConfidential: false,
      kind: "standard",
    },
    meetingRuntime: {
      activeHumanParticipantCount: 0,
      activeHumanParticipants: [],
      allHumanParticipants: [],
      isAwaitingMeetingEnd: false,
    },
    transcript: null,
    transcriptSegments: [],
    summary: null,
    actionItems: [],
    tasks: taskList(item),
    capabilityRecommendations: [],
    postMeetingDisposition: null,
    notesAccess: { /** @external meeting notes wire field */ locked: false, reason: null },
    webResearchRuns: [],
    researchRuns: [],
    linearTaskReview: null,
    notesPreview: null,
  };
}

function terminalStatus(item: MeetingTask): MeetingTasksStatusView {
  return {
    status: "completed",
    phase: "complete",
    error: null,
    /** @external meeting task status wire field */
    isTerminal: true,
    /** @external meeting task status wire field */
    isCurrent: true,
    job: null,
    tasks: taskList(item),
    progress: null,
  };
}

function assignedTask(item: MeetingTask): AssignedTaskSummary {
  return {
    task: item,
    meeting: {
      id: meetingId,
      workspaceId: "77777777-7777-4777-8777-777777777777",
      title: "Launch review",
      startedAt: "2026-05-01T12:00:00.000Z",
      endedAt: "2026-05-01T12:30:00.000Z",
    },
  };
}

function unifiedAssignedTask(item: MeetingTask): UnifiedAssignedTask {
  return {
    sourceType: "meeting",
    sourceId: meetingId,
    taskId: item.id,
    workspaceId: "77777777-7777-4777-8777-777777777777",
    /** @external assigned task wire field */
    editable: true,
    /** @external assigned task wire field */
    reassignable: true,
    /** @external assigned task wire field */
    deletable: false,
    /** @external assigned task wire field */
    reorderable: true,
    isMine: true,
    owner: null,
    title: item.title,
    description: item.description,
    status: item.status,
    dueDate: item.dueDate,
    sectionId: "88888888-8888-4888-8888-888888888888",
    position: 0,
    revision: item.revision,
    placementRevision: 1,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
    sourceMeeting: {
      id: meetingId,
      title: "Launch review",
      startedAt: "2026-05-01T12:00:00.000Z",
      endedAt: "2026-05-01T12:30:00.000Z",
    },
  };
}

function cachedTaskStatus(queryClient: QueryClient) {
  return queryClient.getQueryData<MeetingDetailPayload>(meetingDetailQueryKey(meetingId))?.tasks?.items[0]?.status;
}

function cachedNotesTaskStatus(queryClient: QueryClient) {
  return queryClient.getQueryData<MeetingNotesViewPayload>(meetingNotesViewQueryKey(meetingId))?.tasks?.items[0]
    ?.status;
}

const TEST_VALUE_2 = 2;
const TEST_VALUE_3 = 3;
void test("optimistic task completion updates meeting and assigned task caches immediately", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("open")));
  queryClient.setQueryData(
    meetingNotesViewQueryKey(meetingId),
    meetingNotesViewResponseSchema.parse({ ...meetingDetail(task("open")), hasTranscriptSegments: false }),
  );
  queryClient.setQueryData(terminalMeetingTasksStatusQueryKey(meetingId), terminalStatus(task("open")));
  queryClient.setQueryData(assignedTasksQueryKey(userId), [assignedTask(task("open"))]);
  queryClient.setQueryData(personalAssignedTasksQueryKey(userId), {
    tasks: [unifiedAssignedTask(task("open"))],
  });
  queryClient.setQueryData(workspaceAssignedTasksQueryKey("77777777-7777-4777-8777-777777777777", userId), {
    sections: [],
    tasks: [unifiedAssignedTask(task("open"))],
  });

  const controller = createOptimisticTaskCompletionController(queryClient);
  await controller.apply({ meetingId, taskId, userId, status: "completed" });

  assert.equal(cachedTaskStatus(queryClient), "completed");
  assert.equal(cachedNotesTaskStatus(queryClient), "completed");
  const completedAt = queryClient.getQueryData<AssignedTaskSummary[]>(assignedTasksQueryKey(userId))?.[0]?.task
    .completedAt;
  assert.ok(completedAt !== null && completedAt !== undefined && completedAt !== "");
  assert.equal(
    queryClient.getQueryData<MeetingTasksStatusView>(terminalMeetingTasksStatusQueryKey(meetingId))?.tasks?.items[0]
      ?.status,
    "completed",
  );
  assert.equal(
    queryClient.getQueryData<AssignedTaskSummary[]>(assignedTasksQueryKey(userId))?.[0]?.task.status,
    "completed",
  );
  assert.equal(
    queryClient.getQueryData<{ tasks: UnifiedAssignedTask[] }>(personalAssignedTasksQueryKey(userId))?.tasks[0]?.status,
    "completed",
  );
  assert.equal(
    queryClient.getQueryData<{ tasks: UnifiedAssignedTask[] }>(
      workspaceAssignedTasksQueryKey("77777777-7777-4777-8777-777777777777", userId),
    )?.tasks[0]?.status,
    "completed",
  );
});

void test("optimistic task completion supports completed to open", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("completed")));

  const controller = createOptimisticTaskCompletionController(queryClient);
  await controller.apply({ meetingId, taskId, userId, status: "open" });

  assert.equal(cachedTaskStatus(queryClient), "open");
  assert.equal(
    queryClient.getQueryData<MeetingDetailPayload>(meetingDetailQueryKey(meetingId))?.tasks?.items[0]?.completedAt,
    null,
  );
});

class TrackingQueryClient extends QueryClient {
  cancelledKeys: unknown[] = [];

  override async cancelQueries(
    ...args: Parameters<QueryClient["cancelQueries"]>
  ): ReturnType<QueryClient["cancelQueries"]> {
    const [filters] = args;
    this.cancelledKeys = [...this.cancelledKeys, filters?.queryKey];

    return super.cancelQueries(...args);
  }
}

void test("optimistic task completion cancels relevant queries before patching", async () => {
  const queryClient = new TrackingQueryClient();
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("open")));
  queryClient.setQueryData(
    meetingNotesViewQueryKey(meetingId),
    meetingNotesViewResponseSchema.parse({ ...meetingDetail(task("open")), hasTranscriptSegments: false }),
  );

  const controller = createOptimisticTaskCompletionController(queryClient);
  await controller.apply({ meetingId, taskId, userId, status: "completed" });

  assert.deepEqual(queryClient.cancelledKeys[0], meetingDetailQueryKey(meetingId));
  assert.equal(cachedTaskStatus(queryClient), "completed");
});

void test("pending optimistic completion can be reapplied after stale refetch data lands", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("open")));
  queryClient.setQueryData(
    meetingNotesViewQueryKey(meetingId),
    meetingNotesViewResponseSchema.parse({ ...meetingDetail(task("open")), hasTranscriptSegments: false }),
  );

  const controller = createOptimisticTaskCompletionController(queryClient);
  await controller.apply({ meetingId, taskId, userId, status: "completed" });
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("open")));
  queryClient.setQueryData(
    meetingNotesViewQueryKey(meetingId),
    meetingNotesViewResponseSchema.parse({ ...meetingDetail(task("open")), hasTranscriptSegments: false }),
  );
  controller.reapplyPending();

  assert.equal(cachedTaskStatus(queryClient), "completed");
});

void test("latest optimistic task completion click wins over stale responses", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("open", 1)));

  const controller = createOptimisticTaskCompletionController(queryClient);
  const firstMutation = await controller.apply({ meetingId, taskId, userId, status: "completed" });
  const secondMutation = await controller.apply({ meetingId, taskId, userId, status: "open" });

  assert.equal(cachedTaskStatus(queryClient), "open");
  assert.equal(
    controller.reconcile({ task: task("completed", TEST_VALUE_2), userId, mutationVersion: firstMutation }),
    false,
  );
  assert.equal(cachedTaskStatus(queryClient), "open");
  assert.equal(
    controller.reconcile({ task: task("open", TEST_VALUE_3), userId, mutationVersion: secondMutation }),
    true,
  );

  const cachedTask = queryClient.getQueryData<MeetingDetailPayload>(meetingDetailQueryKey(meetingId))?.tasks?.items[0];
  assert.equal(cachedTask?.status, "open");
  assert.equal(cachedTask.revision, TEST_VALUE_3);
});

void test("stale optimistic task completion failure does not roll back a newer click", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("open", 1)));

  const controller = createOptimisticTaskCompletionController(queryClient);
  const firstMutation = await controller.apply({ meetingId, taskId, userId, status: "completed" });
  await controller.apply({ meetingId, taskId, userId, status: "open" });

  assert.equal(
    controller.rollback({
      patch: { meetingId, taskId, userId, status: "completed" },
      mutationVersion: firstMutation,
    }),
    false,
  );
  assert.equal(cachedTaskStatus(queryClient), "open");
});

void test("optimistic task completion stores server-returned task on success", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("open", 1)));

  const controller = createOptimisticTaskCompletionController(queryClient);
  await controller.apply({ meetingId, taskId, userId, status: "completed" });
  controller.reconcile({ task: task("completed", TEST_VALUE_2), userId });

  const cachedTask = queryClient.getQueryData<MeetingDetailPayload>(meetingDetailQueryKey(meetingId))?.tasks?.items[0];
  assert.equal(cachedTask?.status, "completed");
  assert.equal(cachedTask.revision, TEST_VALUE_2);
});

void test("optimistic task completion rolls back caches on failure", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meetingDetailQueryKey(meetingId), meetingDetail(task("open")));
  queryClient.setQueryData(
    meetingNotesViewQueryKey(meetingId),
    meetingNotesViewResponseSchema.parse({ ...meetingDetail(task("open")), hasTranscriptSegments: false }),
  );
  queryClient.setQueryData(assignedTasksQueryKey(userId), [assignedTask(task("open"))]);
  queryClient.setQueryData(personalAssignedTasksQueryKey(userId), {
    tasks: [unifiedAssignedTask(task("open"))],
  });
  queryClient.setQueryData(workspaceAssignedTasksQueryKey("77777777-7777-4777-8777-777777777777", userId), {
    sections: [],
    tasks: [unifiedAssignedTask(task("open"))],
  });

  const controller = createOptimisticTaskCompletionController(queryClient);
  const patch = { meetingId, taskId, userId, status: "completed" as const };
  await controller.apply(patch);
  controller.rollback({ patch });

  assert.equal(cachedTaskStatus(queryClient), "open");
  assert.equal(cachedNotesTaskStatus(queryClient), "open");
  assert.equal(
    queryClient.getQueryData<AssignedTaskSummary[]>(assignedTasksQueryKey(userId))?.[0]?.task.status,
    "open",
  );
  assert.equal(
    queryClient.getQueryData<{ tasks: UnifiedAssignedTask[] }>(personalAssignedTasksQueryKey(userId))?.tasks[0]?.status,
    "open",
  );
  assert.equal(
    queryClient.getQueryData<{ tasks: UnifiedAssignedTask[] }>(
      workspaceAssignedTasksQueryKey("77777777-7777-4777-8777-777777777777", userId),
    )?.tasks[0]?.status,
    "open",
  );
});

void test("patchTaskInCaches updates assigned task cache with server task", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(assignedTasksQueryKey(userId), [assignedTask(task("open", 1))]);
  queryClient.setQueryData(personalAssignedTasksQueryKey(userId), {
    tasks: [unifiedAssignedTask(task("open", 1))],
  });
  queryClient.setQueryData(workspaceAssignedTasksQueryKey("77777777-7777-4777-8777-777777777777", userId), {
    sections: [],
    tasks: [unifiedAssignedTask(task("open", 1))],
  });

  patchTaskInCaches({ queryClient, patch: { task: task("completed", TEST_VALUE_2), userId } });

  const cachedTask = queryClient.getQueryData<AssignedTaskSummary[]>(assignedTasksQueryKey(userId))?.[0]?.task;
  assert.equal(cachedTask?.status, "completed");
  assert.equal(cachedTask.revision, TEST_VALUE_2);
  const cachedPersonalTask = queryClient.getQueryData<{ tasks: UnifiedAssignedTask[] }>(
    personalAssignedTasksQueryKey(userId),
  )?.tasks[0];
  assert.equal(cachedPersonalTask?.status, "completed");
  assert.equal(cachedPersonalTask.revision, TEST_VALUE_2);
  const cachedUnifiedTask = queryClient.getQueryData<{ tasks: UnifiedAssignedTask[] }>(
    workspaceAssignedTasksQueryKey("77777777-7777-4777-8777-777777777777", userId),
  )?.tasks[0];
  assert.equal(cachedUnifiedTask?.status, "completed");
  assert.equal(cachedUnifiedTask.revision, TEST_VALUE_2);
});
