import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  meetingTasksStatusResponseSchema,
  reportMeetingTaskRenderedRequestSchema,
  reportMeetingTaskRenderedResponseSchema,
  updateMeetingTaskRequestSchema,
  updateMeetingTaskResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { hasFinalizedTranscript } from "../../../../../application/meeting-lifecycle";
import { filterMeetingTaskStatusForViewer } from "../../../../../application/meeting-task-visibility";
import { canAssignMeetingTaskToUser } from "../../../../../domain/meeting-task-assignee";
import {
  getMeetingTaskClientTimestampSequenceError,
  isMeetingTaskClientTimestampWithinWindow,
} from "../../../../../domain/meeting-task-telemetry";
import { repositories } from "../../../../../ports/repository-runtime";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";
import { requireMeetingNotesAccess } from "../../support/meeting-notes-guard";

import { getMeetingTasksStatusPayload, sendPostMeetingPipelineSkippedIfNeeded } from "./shared";

type MeetingTaskParticipant = Awaited<ReturnType<RepositoryPort["listParticipantsForMeeting"]>>[number];
type CalendarCounterpart = Awaited<ReturnType<RepositoryPort["getDeterministicCalendarCounterpartForMeeting"]>>;
type MeetingAccess = ReturnType<typeof getMeetingAccess>;
type UpdateMeetingTaskBody = z.infer<typeof updateMeetingTaskRequestSchema>;

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const HTTP_CONFLICT = 409;

const EXPECTED_HUMAN_PARTICIPANT_COUNT_FOR_COUNTERPART = 2;
const EXPECTED_GUEST_PARTICIPANT_COUNT_FOR_COUNTERPART = 1;

const MESSAGE_TRANSCRIPT_STILL_FINALIZING = "Transcript is still being finalized. Try again in a moment.";
const MESSAGE_ONLY_PARTICIPANTS_UPDATE_LIVE_TASKS =
  "Only signed-in meeting participants can update live meeting tasks.";
const MESSAGE_WORKSPACE_TASK_UPDATE_FORBIDDEN =
  "Workspace members may only complete, reopen, or remove their own meeting tasks.";
const MESSAGE_TASK_ASSIGNEE_MISSING_PROFILE = "Task assignee is missing profile details";
const MESSAGE_TASK_ASSIGNEE_MUST_BE_PARTICIPANT = "Task assignee must be a meeting participant.";
const MESSAGE_TASK_ASSIGNEE_MUST_BE_PARTICIPANT_OR_MEMBER =
  "Task assignee must be a meeting participant or workspace member.";
const MESSAGE_TASK_NOT_FOUND = "Task not found";
const MEETING_TASK_CLIENT_TIMESTAMP_OUTSIDE_WINDOW_SUFFIX = " timestamp is outside the accepted server-clock window.";

const meetingTaskIdParamsSchema = z.object({
  taskId: z.string(),
});

function normalizeParticipantEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function isHumanParticipant(participant: MeetingTaskParticipant) {
  return participant.role === "host" || participant.role === "guest";
}

function isGuestIdentityParticipant(participant: MeetingTaskParticipant) {
  return participant.source === "guest" || participant.email.endsWith("@guest.readymeet.local");
}

function withDeterministicCalendarCounterpart(input: {
  participants: MeetingTaskParticipant[];
  counterpart: CalendarCounterpart;
}) {
  const { participants, counterpart } = input;
  if (counterpart === null || counterpart.email === "") {
    return participants;
  }

  const humanParticipants = participants.filter(isHumanParticipant);
  const guestParticipants = humanParticipants.filter(isGuestIdentityParticipant);
  if (
    humanParticipants.length !== EXPECTED_HUMAN_PARTICIPANT_COUNT_FOR_COUNTERPART ||
    guestParticipants.length !== EXPECTED_GUEST_PARTICIPANT_COUNT_FOR_COUNTERPART
  ) {
    return participants;
  }

  const counterpartEmail = normalizeParticipantEmail(counterpart.email);
  if (
    counterpartEmail === "" ||
    humanParticipants.some((participant) => normalizeParticipantEmail(participant.email) === counterpartEmail)
  ) {
    return participants;
  }

  const guestParticipant = guestParticipants[0];
  if (guestParticipant === undefined) {
    return participants;
  }

  return participants.map((participant) =>
    participant.userId === guestParticipant.userId
      ? {
          ...participant,
          displayName: counterpart.displayName ?? participant.displayName,
          email: counterpart.email,
        }
      : participant,
  );
}

function meetingTaskClientTimestampOutsideWindowMessage(label: string) {
  return `${label}${MEETING_TASK_CLIENT_TIMESTAMP_OUTSIDE_WINDOW_SUFFIX}`;
}

function optionalClientTimestampDate(value: string | null | undefined) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return new Date(value);
}

function parseMeetingTaskIdParams(params: unknown) {
  return meetingTaskIdParamsSchema.safeParse(params);
}

type ResolvedMeetingTaskAssignee =
  | { name: string | null | undefined; email: string | null | undefined }
  | { rejected: string };

async function resolveMeetingTaskAssigneeDetails(input: {
  meeting: MeetingAccess["meeting"];
  assigneeUserId: string | null | undefined;
  requestedAssignee: { name: string | null | undefined; email: string | null | undefined };
}): Promise<ResolvedMeetingTaskAssignee> {
  const { meeting, assigneeUserId, requestedAssignee } = input;
  if (assigneeUserId === undefined) {
    return requestedAssignee;
  }
  if (assigneeUserId === null) {
    return { name: null, email: null };
  }

  const [meetingParticipants, calendarCounterpart, workspaceMembers] = await Promise.all([
    repositories().listParticipantsForMeeting(meeting.id),
    repositories().getDeterministicCalendarCounterpartForMeeting(meeting.id),
    repositories().listWorkspaceMembers(meeting.workspaceId),
  ]);
  const participants = withDeterministicCalendarCounterpart({
    participants: meetingParticipants,
    counterpart: calendarCounterpart,
  });
  const participant = participants.find((item) => item.userId === assigneeUserId && isHumanParticipant(item));
  // Confidential meeting tasks inherit participant-only visibility.
  // Do not accept a workspace-only assignee who would immediately lose
  // access to the task after reassignment.
  const workspaceMember = meeting.isConfidential
    ? undefined
    : workspaceMembers.find((item) => item.userId === assigneeUserId);
  if (
    !canAssignMeetingTaskToUser({
      isConfidential: meeting.isConfidential,
      isMeetingParticipant: Boolean(participant),
      isWorkspaceMember: Boolean(workspaceMember),
    })
  ) {
    return {
      rejected: meeting.isConfidential
        ? MESSAGE_TASK_ASSIGNEE_MUST_BE_PARTICIPANT
        : MESSAGE_TASK_ASSIGNEE_MUST_BE_PARTICIPANT_OR_MEMBER,
    };
  }
  if (workspaceMember === undefined) {
    if (participant === undefined) {
      throw new Error(MESSAGE_TASK_ASSIGNEE_MISSING_PROFILE);
    }

    return { name: participant.displayName, email: participant.email };
  }

  return {
    name: participant?.displayName ?? workspaceMember.displayName,
    email: participant?.email ?? workspaceMember.email,
  };
}

async function getWorkspaceMeetingTaskUpdateForbiddenMessage(input: {
  meeting: MeetingAccess["meeting"];
  taskId: string;
  userId: string;
  updateBody: UpdateMeetingTaskBody;
}): Promise<string | null> {
  const currentTaskList = await repositories().getMeetingTaskListForMeeting(input.meeting.id);
  if (currentTaskList?.status !== "completed") {
    return MESSAGE_ONLY_PARTICIPANTS_UPDATE_LIVE_TASKS;
  }
  const hasNonStatusUpdate = Object.entries(input.updateBody).some(([key]) => key !== "status");
  const isStandardCompletionUpdate =
    input.meeting.kind === "standard" &&
    !hasNonStatusUpdate &&
    (input.updateBody.status === "open" || input.updateBody.status === "completed");
  const isOwnTaskDismissal =
    input.updateBody.status === "dismissed" &&
    !hasNonStatusUpdate &&
    currentTaskList.items.some((task) => task.id === input.taskId && task.owner.userId === input.userId);
  if (!isStandardCompletionUpdate && !isOwnTaskDismissal) {
    return MESSAGE_WORKSPACE_TASK_UPDATE_FORBIDDEN;
  }

  return null;
}

async function registerMeetingTaskRunRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/meetings/:meetingId/run-tasks",
    {
      preHandler: requireMeetingNotesAccess({
        level: "participant",
        options: {
          forbiddenMessage: "Only meeting participants can run meeting tasks.",
        },
      }),
    },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const meetingId = meeting.id;

      const currentStatus = await getMeetingTasksStatusPayload(meetingId);
      if (currentStatus.tasks?.status === "completed" && currentStatus.isCurrent) {
        return meetingTasksStatusResponseSchema.parse(currentStatus);
      }
      if (currentStatus.job?.status === "queued" || currentStatus.job?.status === "running") {
        return meetingTasksStatusResponseSchema.parse(currentStatus);
      }

      const transcriptData = await repositories().getTranscriptForMeeting(meetingId);
      if (!hasFinalizedTranscript(transcriptData)) {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_TRANSCRIPT_STILL_FINALIZING });
      }

      if (await sendPostMeetingPipelineSkippedIfNeeded({ reply, meeting, meetingId, transcriptData })) {
        return;
      }

      const { generateAndPersistMeetingTasks } = await import("../../../../../application/task-artifacts");
      await generateAndPersistMeetingTasks(meetingId, request.log);

      return meetingTasksStatusResponseSchema.parse(await getMeetingTasksStatusPayload(meetingId));
    },
  );
}

async function registerMeetingTaskStatusRoute(app: FastifyInstance): Promise<void> {
  app.get(
    "/meetings/:meetingId/tasks/status",
    {
      preHandler: requireMeetingNotesAccess({
        level: "joined-guest",
        options: {
          forbiddenMessage: "Only joined meeting participants can view meeting task status.",
          /** @external meeting notes access allow workspace viewer wire field */
          allowWorkspaceViewer: true,
        },
      }),
    },
    async (request) => {
      const { meeting, viewerRole } = getMeetingAccess(request);
      const status = await getMeetingTasksStatusPayload(meeting.id);

      return meetingTasksStatusResponseSchema.parse(filterMeetingTaskStatusForViewer({ payload: status, viewerRole }));
    },
  );
}

async function handleReportMeetingTaskRendered(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting } = getMeetingAccess(input.request);
  const parsedParams = parseMeetingTaskIdParams(input.request.params);
  if (!parsedParams.success) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
  }
  const { taskId } = parsedParams.data;
  const parsed = reportMeetingTaskRenderedRequestSchema.safeParse(input.request.body);
  if (!parsed.success) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }
  const serverNowMs = Date.now();
  const clientTimestamps = [
    ["Rendered", parsed.data.renderedAt],
    ["Realtime-received", parsed.data.realtimeReceivedAt],
    ["Refetch-started", parsed.data.refetchStartedAt],
    ["Refetch-completed", parsed.data.refetchCompletedAt],
  ] as const;
  const invalidTimestamp = clientTimestamps.find(
    (entry) =>
      entry[1] !== undefined &&
      entry[1] !== null &&
      entry[1] !== "" &&
      !isMeetingTaskClientTimestampWithinWindow({ value: entry[1], serverNowMs }),
  );
  if (invalidTimestamp) {
    return input.reply.code(HTTP_BAD_REQUEST).send({
      message: meetingTaskClientTimestampOutsideWindowMessage(invalidTimestamp[0]),
    });
  }
  const sequenceError = getMeetingTaskClientTimestampSequenceError(parsed.data);
  if (sequenceError !== null) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: sequenceError });
  }
  const isAccepted = await repositories().reportMeetingTaskRendered({
    meetingId: meeting.id,
    taskId,
    renderedAt: new Date(parsed.data.renderedAt),
    realtimeReceivedAt: optionalClientTimestampDate(parsed.data.realtimeReceivedAt),
    refetchStartedAt: optionalClientTimestampDate(parsed.data.refetchStartedAt),
    refetchCompletedAt: optionalClientTimestampDate(parsed.data.refetchCompletedAt),
    taskRevision: parsed.data.taskRevision ?? null,
    observedKinds: parsed.data.observedKinds,
    clientContinuity: parsed.data.clientContinuity ?? null,
  });

  return reportMeetingTaskRenderedResponseSchema.parse({
    /** @external report meeting task rendered accepted wire field */
    accepted: isAccepted,
  });
}

async function registerMeetingTaskRenderedRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/meetings/:meetingId/tasks/:taskId/rendered",
    {
      preHandler: [
        ...requireMeetingAccess("joined-guest", {
          forbiddenMessage: "Only joined meeting participants can report task rendering.",
        }),
      ],
    },
    async (request, reply) => handleReportMeetingTaskRendered({ request, reply }),
  );
}

async function handleUpdateMeetingTask(input: { request: FastifyRequest; reply: FastifyReply }) {
  const { meeting, viewerRole } = getMeetingAccess(input.request);
  const parsedParams = parseMeetingTaskIdParams(input.request.params);
  if (!parsedParams.success) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
  }
  const { taskId } = parsedParams.data;
  const user = input.request.user;
  if (user === undefined) {
    return input.reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
  }
  const parsed = updateMeetingTaskRequestSchema.safeParse(input.request.body);
  if (!parsed.success) {
    return input.reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }

  if (viewerRole === "workspace") {
    const forbiddenMessage = await getWorkspaceMeetingTaskUpdateForbiddenMessage({
      meeting,
      taskId,
      userId: user.id,
      updateBody: parsed.data,
    });
    if (forbiddenMessage !== null) {
      return input.reply.code(HTTP_FORBIDDEN).send({
        message: forbiddenMessage,
      });
    }
  }

  try {
    const assigneeUserId =
      parsed.data.assigneeUserId !== undefined ? parsed.data.assigneeUserId : parsed.data.ownerUserId;
    const requestedAssignee = {
      name: parsed.data.assigneeName !== undefined ? parsed.data.assigneeName : parsed.data.ownerName,
      email: parsed.data.assigneeEmail !== undefined ? parsed.data.assigneeEmail : parsed.data.ownerEmail,
    };
    const resolvedAssignee = await resolveMeetingTaskAssigneeDetails({
      meeting,
      assigneeUserId,
      requestedAssignee,
    });
    if ("rejected" in resolvedAssignee) {
      return await input.reply.code(HTTP_BAD_REQUEST).send({ message: resolvedAssignee.rejected });
    }
    const assigneeName = resolvedAssignee.name;
    const assigneeEmail = resolvedAssignee.email;

    const task = await repositories().updateMeetingTask({
      meetingId: meeting.id,
      taskId,
      title: parsed.data.title,
      description: parsed.data.description,
      assigneeUserId,
      assigneeName,
      assigneeEmail,
      dueDateValue: parsed.data.dueDateValue,
      status: parsed.data.status,
      actorUserId: user.id,
    });

    return updateMeetingTaskResponseSchema.parse({ task });
  } catch (error) {
    return input.reply.code(HTTP_NOT_FOUND).send({
      message: error instanceof Error ? error.message : MESSAGE_TASK_NOT_FOUND,
    });
  }
}

async function registerMeetingTaskUpdateRoute(app: FastifyInstance): Promise<void> {
  app.patch(
    "/meetings/:meetingId/tasks/:taskId",
    {
      preHandler: requireMeetingNotesAccess({
        level: "participant",
        options: {
          forbiddenMessage: "Only meeting participants can update meeting tasks.",
          /** @external meeting notes access allow workspace viewer wire field */
          allowWorkspaceViewer: true,
        },
      }),
    },
    async (request, reply) => handleUpdateMeetingTask({ request, reply }),
  );
}

export async function meetingTaskRoutes(app: FastifyInstance): Promise<void> {
  await registerMeetingTaskRunRoute(app);
  await registerMeetingTaskStatusRoute(app);
  await registerMeetingTaskRenderedRoute(app);
  await registerMeetingTaskUpdateRoute(app);
}
