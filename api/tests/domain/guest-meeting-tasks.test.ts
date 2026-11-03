import { guestMeetingTasksStatusSchema, meetingTaskListSchema, meetingTaskProgressSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { projectGuestMeetingTasksStatus, toGuestMeetingTasksStatus } from "../../domain/guest-meeting-tasks";

const id = "11111111-1111-4111-8111-111111111111";
const PRIVATE_PROVIDER_ERROR_MESSAGE = "private provider error";
const PRIVATE_INPUT_LABEL = "private input";
const PRIVATE_MODEL_LABEL = "private model";
const PRIVATE_VERSION_LABEL = "private version";
const PRIVATE_HASH_LABEL = "private hash";
const PRIVATE_RAW_ERROR_MESSAGE = "private raw error";
const PRIVATE_PAYLOAD_LABEL = "private payload";
const PRIVATE_RESULT_LABEL = "private result";
const PRIVATE_DIAGNOSTIC_ERROR = "private diagnostic";
const PROCESSED_CHUNK_COUNT = 2;
const TOTAL_CHUNK_COUNT = 3;
const GUEST_TASKS_FAILED_MESSAGE = "Tasks could not be prepared.";

void test("guest task status retains display data without jobs, raw errors, or diagnostics", () => {
  const tasks = meetingTaskListSchema.parse({
    id,
    meetingId: id,
    status: "completed",
    phase: "complete",
    error: { message: PRIVATE_PROVIDER_ERROR_MESSAGE, request: PRIVATE_INPUT_LABEL },
    model: PRIVATE_MODEL_LABEL,
    promptVersion: PRIVATE_VERSION_LABEL,
    transcriptHash: PRIVATE_HASH_LABEL,
    items: [],
    createdAt: "2026-09-17T00:00:00Z",
    updatedAt: "2026-09-17T00:00:00Z",
    completedAt: null,
  });
  const source = {
    status: "completed" as const,
    phase: "complete",
    isTerminal: true,
    isCurrent: true,
    error: PRIVATE_RAW_ERROR_MESSAGE,
    job: { payload: PRIVATE_PAYLOAD_LABEL, result: PRIVATE_RESULT_LABEL },
    tasks,
    progress: meetingTaskProgressSchema.parse({
      processedChunks: PROCESSED_CHUNK_COUNT,
      totalChunks: TOTAL_CHUNK_COUNT,
    }),
  };
  const result = toGuestMeetingTasksStatus(source);
  assert.equal(result.status, "completed");
  assert.equal(result.isTerminal, true);
  assert.equal(result.tasks?.id, id);
  assert.equal(result.progress?.processedChunks, PROCESSED_CHUNK_COUNT);
  assert.equal("job" in result, false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  const failed = toGuestMeetingTasksStatus({ ...source, status: "failed" });
  assert.equal(failed.error, GUEST_TASKS_FAILED_MESSAGE);
  const guarded = guestMeetingTasksStatusSchema.parse({
    ...result,
    job: source.job,
    progress: { ...result.progress, diagnostics: { error: PRIVATE_DIAGNOSTIC_ERROR } },
  });
  assert.equal(JSON.stringify(guarded).includes("private"), false);
});

void test("guests get no task status for placeholder notes that never start a task run", () => {
  const unstarted = {
    status: "pending" as const,
    phase: "queued",
    isTerminal: false,
    isCurrent: false,
    job: null,
    tasks: null,
    progress: null,
  };
  // Out-of-credits and failed generation both save fallback notes and start no task run.
  assert.equal(projectGuestMeetingTasksStatus({ summary: { model: "fallback-summary-v1" }, status: unstarted }), null);
  assert.equal(projectGuestMeetingTasksStatus({ summary: { model: "short-meeting-v1" }, status: unstarted }), null);
  // Real notes are followed by a task run, so the guest keeps waiting for it.
  assert.equal(
    projectGuestMeetingTasksStatus({ summary: { model: "gpt-test" }, status: unstarted })?.status,
    "pending",
  );
  assert.equal(projectGuestMeetingTasksStatus({ summary: null, status: unstarted })?.status, "pending");
  // A run that was started anyway is still shown.
  const started = { ...unstarted, status: "generating" as const, job: { id } };
  assert.equal(
    projectGuestMeetingTasksStatus({ summary: { model: "fallback-summary-v1" }, status: started })?.status,
    "generating",
  );
});
