import type { UnifiedAssignedTask } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { buildAssignedTaskDeletePlan } from "../../domain/assigned-task-deletion";

function task(input: {
  id: string;
  sourceType: UnifiedAssignedTask["sourceType"];
  sourceId?: string;
  workspaceId: string;
}): UnifiedAssignedTask {
  return {
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? input.id,
    taskId: input.id,
    workspaceId: input.workspaceId,
    /** @external UnifiedAssignedTask capability contract */
    editable: true,
    /** @external UnifiedAssignedTask capability contract */
    reassignable: true,
    /** @external UnifiedAssignedTask capability contract */
    deletable: true,
    /** @external UnifiedAssignedTask capability contract */
    reorderable: false,
    isMine: true,
    owner: null,
    title: `Task ${input.id}`,
    description: null,
    status: "open",
    dueDate: { value: null, confidence: null },
    sectionId: "99999999-9999-4999-8999-999999999999",
    position: 0,
    revision: 1,
    placementRevision: 1,
    updatedAt: "2026-08-11T12:00:00.000Z",
    completedAt: null,
    sourceMeeting:
      input.sourceType === "meeting"
        ? {
            id: input.sourceId ?? input.id,
            title: "Source meeting",
            startedAt: null,
            endedAt: null,
          }
        : null,
  };
}

void test("task deletion plans dismiss meeting tasks and batch workspace tasks by workspace", () => {
  const firstWorkspaceId = "11111111-1111-4111-8111-111111111111";
  const secondWorkspaceId = "22222222-2222-4222-8222-222222222222";
  const meetingId = "33333333-3333-4333-8333-333333333333";

  assert.deepEqual(
    buildAssignedTaskDeletePlan([
      task({
        id: "44444444-4444-4444-8444-444444444444",
        sourceType: "meeting",
        sourceId: meetingId,
        workspaceId: firstWorkspaceId,
      }),
      task({
        id: "55555555-5555-4555-8555-555555555555",
        sourceType: "workspace",
        workspaceId: firstWorkspaceId,
      }),
      task({
        id: "66666666-6666-4666-8666-666666666666",
        sourceType: "workspace",
        workspaceId: firstWorkspaceId,
      }),
      task({
        id: "77777777-7777-4777-8777-777777777777",
        sourceType: "workspace",
        workspaceId: secondWorkspaceId,
      }),
    ]),
    {
      meetingTasks: [
        {
          meetingId,
          taskId: "44444444-4444-4444-8444-444444444444",
        },
      ],
      workspaceTaskGroups: [
        {
          workspaceId: firstWorkspaceId,
          taskIds: ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"],
        },
        {
          workspaceId: secondWorkspaceId,
          taskIds: ["77777777-7777-4777-8777-777777777777"],
        },
      ],
    },
  );
});
