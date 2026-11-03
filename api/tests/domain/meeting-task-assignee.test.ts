import assert from "node:assert/strict";
import test from "node:test";

import { canAssignMeetingTaskToUser } from "../../domain/meeting-task-assignee";

void test("confidential meeting tasks can only be assigned to meeting participants", () => {
  assert.equal(
    canAssignMeetingTaskToUser({
      isConfidential: true,
      isMeetingParticipant: false,
      isWorkspaceMember: true,
    }),
    false,
  );
  assert.equal(
    canAssignMeetingTaskToUser({
      isConfidential: true,
      isMeetingParticipant: true,
      isWorkspaceMember: false,
    }),
    true,
  );
});

void test("non-confidential meeting tasks can be assigned to workspace members", () => {
  assert.equal(
    canAssignMeetingTaskToUser({
      isConfidential: false,
      isMeetingParticipant: false,
      isWorkspaceMember: true,
    }),
    true,
  );
});
