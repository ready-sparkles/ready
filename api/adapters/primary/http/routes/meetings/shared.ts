import type { RepositoryPort } from "@readymeet/db/ports/repository";
import { meetingTaskProgressSchema, meetingTasksStatusResponseSchema } from "@readymeet/shared";
import type { FastifyReply } from "fastify";

import type { MeetingDTOInput } from "../../../../../application/meeting-dto";
import {
  buildPostMeetingSkippedDisposition,
  getPostMeetingPipelineSkipDisposition,
} from "../../../../../application/meeting-lifecycle";
import { isMeetingTaskListCurrent } from "../../../../../application/task-artifacts";
import { repositories } from "../../../../../ports/repository-runtime";
import type { MeetingRecord } from "../../support/meeting-access";

type TranscriptData = Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>>;
const POST_MEETING_PIPELINE_SKIPPED_CODE = "post_meeting_pipeline_skipped";
const HTTP_CONFLICT_STATUS = 409;

export function getHiddenPostMeetingDisposition(
  meeting: MeetingRecord,
): ReturnType<typeof buildPostMeetingSkippedDisposition> | null {
  if (
    meeting.hiddenFromHistoryReason === "too_short_duration" ||
    meeting.hiddenFromHistoryReason === "too_short_transcript"
  ) {
    return buildPostMeetingSkippedDisposition(meeting.hiddenFromHistoryReason);
  }

  return null;
}

export async function sendPostMeetingPipelineSkippedIfNeeded(input: {
  reply: FastifyReply;
  meeting: MeetingRecord;
  meetingId: string;
  transcriptData?: TranscriptData;
}): Promise<boolean> {
  if (input.meeting.status !== "ended" || input.meeting.kind === "agent_intro") {
    return false;
  }

  const disposition = await getPostMeetingPipelineSkipDisposition(input.meetingId, {
    meeting: input.meeting,
    transcriptData: input.transcriptData,
  });

  if (disposition === null) {
    return false;
  }

  input.reply.code(HTTP_CONFLICT_STATUS).send({
    code: POST_MEETING_PIPELINE_SKIPPED_CODE,
    message: disposition.message,
    postMeetingDisposition: disposition,
  });

  return true;
}

type TaskListStatusInput = Awaited<ReturnType<RepositoryPort["getMeetingTaskListForMeeting"]>>;
type TaskJobStatusInput = Awaited<ReturnType<RepositoryPort["getLatestAiWorkflowJobForMeeting"]>>;

const TASKS_COULD_NOT_BE_PREPARED_MESSAGE = "Tasks could not be prepared.";

function taskErrorMessage(input: { tasks: TaskListStatusInput; job: TaskJobStatusInput }): string | null {
  const taskError = input.tasks?.error;
  if (taskError !== undefined && taskError !== null && typeof taskError.message === "string") {
    return TASKS_COULD_NOT_BE_PREPARED_MESSAGE;
  }

  const jobError = input.job?.error;

  return jobError !== undefined && jobError !== null ? TASKS_COULD_NOT_BE_PREPARED_MESSAGE : null;
}

function taskProgressFromJob(job: TaskJobStatusInput) {
  const progress = job?.result.progress;
  const parsed = meetingTaskProgressSchema.nullable().safeParse(progress ?? null);

  return parsed.success ? parsed.data : null;
}

function buildMeetingTasksStatusPayload(input: {
  status: string;
  phase: string;
  error: string | null;
  isTerminal: boolean;
  isCurrent: boolean;
  job: TaskJobStatusInput;
  tasks: TaskListStatusInput;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}) {
  return meetingTasksStatusResponseSchema.parse(input);
}

function buildCompletedMeetingTasksStatus(input: {
  tasks: TaskListStatusInput;
  job: TaskJobStatusInput;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}) {
  return buildMeetingTasksStatusPayload({
    status: "completed",
    phase: input.tasks?.phase ?? "complete",
    error: null,
    isTerminal: true,
    isCurrent: input.isCurrent,
    job: input.job,
    tasks: input.tasks,
    progress: input.progress,
    serverNow: input.serverNow,
  });
}

function buildFailedMeetingTasksStatus(input: {
  tasks: TaskListStatusInput;
  job: TaskJobStatusInput;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
  phase: string;
}) {
  return buildMeetingTasksStatusPayload({
    status: "failed",
    phase: input.phase,
    error: taskErrorMessage({ tasks: input.tasks, job: input.job }) ?? TASKS_COULD_NOT_BE_PREPARED_MESSAGE,
    isTerminal: true,
    isCurrent: input.isCurrent,
    job: input.job,
    tasks: input.tasks,
    progress: input.progress,
    serverNow: input.serverNow,
  });
}

function buildPendingMeetingTasksStatus(input: {
  tasks: TaskListStatusInput;
  job: TaskJobStatusInput;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}) {
  return buildMeetingTasksStatusPayload({
    status: "pending",
    phase: "pending",
    error: null,
    isTerminal: false,
    isCurrent: input.isCurrent,
    job: input.job,
    tasks: input.tasks,
    progress: input.progress,
    serverNow: input.serverNow,
  });
}

function buildGeneratingMeetingTasksStatus(input: {
  tasks: TaskListStatusInput;
  job: NonNullable<TaskJobStatusInput>;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}) {
  return buildMeetingTasksStatusPayload({
    status: "generating",
    phase: input.tasks?.phase ?? input.job.phase,
    error: null,
    isTerminal: false,
    isCurrent: input.isCurrent,
    job: input.job,
    tasks: input.tasks,
    progress: input.progress,
    serverNow: input.serverNow,
  });
}

function buildInProgressMeetingTasksStatus(input: {
  tasks: NonNullable<TaskListStatusInput>;
  job: TaskJobStatusInput;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}) {
  return buildMeetingTasksStatusPayload({
    status: input.tasks.status,
    phase: input.tasks.phase ?? "queued",
    error: null,
    isTerminal: false,
    isCurrent: input.isCurrent,
    job: input.job,
    tasks: input.tasks,
    progress: input.progress,
    serverNow: input.serverNow,
  });
}

function buildFailedMeetingTasksStatusFromInput(input: {
  tasks: TaskListStatusInput;
  job: TaskJobStatusInput;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}) {
  const phase =
    input.tasks?.status === "failed" && input.isCurrent
      ? (input.tasks.phase ?? input.job?.phase ?? "failed")
      : (input.job?.phase ?? "failed");

  return buildFailedMeetingTasksStatus({ ...input, phase });
}

function resolveTerminalMeetingTasksStatus(base: {
  tasks: TaskListStatusInput;
  job: TaskJobStatusInput;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}): ReturnType<typeof buildCompletedMeetingTasksStatus> | null {
  const { tasks, job, isCurrent } = base;
  if (tasks?.status === "completed" && isCurrent) {
    return buildCompletedMeetingTasksStatus(base);
  }
  if ((tasks?.status === "failed" && isCurrent) || job?.status === "failed") {
    return buildFailedMeetingTasksStatusFromInput(base);
  }

  return null;
}

function resolveActiveMeetingTasksStatus(base: {
  tasks: TaskListStatusInput;
  job: TaskJobStatusInput;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}) {
  const { tasks, job, isCurrent } = base;
  if (job?.status === "queued" || job?.status === "running") {
    return buildGeneratingMeetingTasksStatus({ ...base, job });
  }
  if ((tasks?.status === "generating" || tasks?.status === "pending") && isCurrent) {
    return buildInProgressMeetingTasksStatus({ ...base, tasks });
  }

  return buildPendingMeetingTasksStatus(base);
}

function resolveMeetingTasksStatus(base: {
  tasks: TaskListStatusInput;
  job: TaskJobStatusInput;
  isCurrent: boolean;
  progress: ReturnType<typeof taskProgressFromJob>;
  serverNow: string;
}) {
  const terminal = resolveTerminalMeetingTasksStatus(base);

  return terminal ?? resolveActiveMeetingTasksStatus(base);
}

function buildMeetingTasksStatus(input: { tasks: TaskListStatusInput; job: TaskJobStatusInput; isCurrent: boolean }) {
  const progress = taskProgressFromJob(input.job);
  const serverNow = new Date().toISOString();

  return resolveMeetingTasksStatus({ ...input, progress, serverNow });
}

export async function getMeetingTasksStatusPayload(
  meetingId: string,
): Promise<ReturnType<typeof buildMeetingTasksStatus>> {
  const [tasks, job, transcriptData] = await Promise.all([
    repositories().getMeetingTaskListForMeeting(meetingId),
    repositories().getLatestAiWorkflowJobForMeeting({
      meetingId,
      type: "generate_meeting_tasks",
    }),
    repositories().getTranscriptForMeeting(meetingId),
  ]);

  return buildMeetingTasksStatus({
    tasks,
    job,
    isCurrent: isMeetingTaskListCurrent(tasks, transcriptData),
  });
}

type MeetingRuntimeStateDTOInput = Awaited<ReturnType<RepositoryPort["getMeetingRuntimeState"]>>;

export function toMeetingRuntimeDTO(input: {
  meeting: Pick<MeetingDTOInput, "status">;
  runtimeState: MeetingRuntimeStateDTOInput;
}): {
  activeHumanParticipantCount: number;
  activeHumanParticipants: MeetingRuntimeStateDTOInput["activeHumanParticipants"];
  allHumanParticipants: MeetingRuntimeStateDTOInput["allHumanParticipants"];
  isAwaitingMeetingEnd: boolean;
} {
  const { meeting, runtimeState } = input;

  return {
    activeHumanParticipantCount: runtimeState.activeHumanParticipantCount,
    activeHumanParticipants: runtimeState.activeHumanParticipants.map((participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      email: participant.email,
      avatarUrl: participant.avatarUrl,
      role: participant.role,
    })),
    allHumanParticipants: runtimeState.allHumanParticipants.map((participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      email: participant.email,
      avatarUrl: participant.avatarUrl,
      role: participant.role,
    })),
    isAwaitingMeetingEnd: meeting.status !== "ended" && runtimeState.activeHumanParticipantCount > 0,
  };
}
