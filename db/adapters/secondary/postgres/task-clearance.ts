import type { ClearDoneTasksRange, SelectedDoneTask } from "@readymeet/shared";

import { db } from "./client";

const DAYS_PER_WEEK = 7;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const WEEK_MS = DAYS_PER_WEEK * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const SIX_MONTHS = 6;
const TWELVE_MONTHS = 12;

type TaskSource = "meeting" | "workspace";

type SelectedClearance = {
  sourceType: TaskSource;
  taskId: string;
  completedBefore: Date;
};

type MeetingClearanceCandidate = {
  taskId: string;
  status: string;
  completedAt: Date | null;
  updatedAt: Date;
  ownerUserId: string | null;
  listStatus: string;
  hiddenFromHistoryAt: Date | null;
  meetingWorkspaceId: string;
  createdByUserId: string;
  isConfidential: boolean;
  kind: string;
  participantUserId: string | null;
  filingWorkspaceId: string | null;
};

const subtractUtcMonths = ({ date, months }: { date: Date; months: number }): Date => {
  const cursor = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() - months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
  cursor.setUTCDate(Math.min(date.getUTCDate(), lastDay));

  return cursor;
};

const clearanceCutoff = ({ range, now }: { range: ClearDoneTasksRange; now: Date }): Date => {
  if (range === "all") {
    return now;
  }
  if (range === "week") {
    return new Date(now.getTime() - WEEK_MS);
  }
  if (range === "month") {
    return subtractUtcMonths({ date: now, months: 1 });
  }
  if (range === "six_months") {
    return subtractUtcMonths({ date: now, months: SIX_MONTHS });
  }

  return subtractUtcMonths({ date: now, months: TWELVE_MONTHS });
};

const laterDate = ({ left, right }: { left: Date; right: Date }): Date =>
  left.getTime() >= right.getTime() ? left : right;

const hasActiveMembership = async (input: { userId: string; workspaceId: string }): Promise<boolean> => {
  const row = await db.workspaceMemberships.findFirst({
    where: { userId: input.userId, workspaceId: input.workspaceId, status: "active" },
    select: { userId: true },
  });

  return row !== null;
};

export async function clearPersonalDoneTasks(input: {
  userId: string;
  workspaceId: string;
  range: ClearDoneTasksRange;
}): Promise<string | null> {
  if (!(await hasActiveMembership(input))) {
    return null;
  }
  const cutoff = clearanceCutoff({ range: input.range, now: new Date() });
  const existing = await db.personalTaskClearances.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
    select: { completedBefore: true },
  });
  const completedBefore = existing === null ? cutoff : laterDate({ left: existing.completedBefore, right: cutoff });
  await db.personalTaskClearances.upsert({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
    create: { userId: input.userId, workspaceId: input.workspaceId, completedBefore },
    update: { completedBefore },
  });

  return completedBefore.toISOString();
}

const dedupeCandidates = (rows: MeetingClearanceCandidate[]): MeetingClearanceCandidate[] => {
  const seen = new Set<string>();

  return rows.filter((row) => {
    if (seen.has(row.taskId)) {
      return false;
    }
    seen.add(row.taskId);

    return true;
  });
};

const isVisibleMeetingTask = ({
  row,
  userId,
  workspaceId,
  suspendedHosts,
}: {
  row: MeetingClearanceCandidate;
  userId: string;
  workspaceId: string;
  suspendedHosts: Set<string>;
}): boolean => {
  const isParticipant = row.participantUserId !== null;
  const effectiveWorkspace = isParticipant ? (row.filingWorkspaceId ?? row.meetingWorkspaceId) : row.meetingWorkspaceId;
  const canSeeMeeting = isParticipant || row.createdByUserId === userId || !row.isConfidential;
  const canIncludeTask = row.ownerUserId === userId || row.kind !== "agent_intro";

  return (
    row.status === "completed" &&
    row.listStatus === "completed" &&
    row.hiddenFromHistoryAt === null &&
    effectiveWorkspace === workspaceId &&
    !suspendedHosts.has(row.meetingWorkspaceId) &&
    canSeeMeeting &&
    canIncludeTask
  );
};

const loadMeetingClearanceCandidates = async (input: {
  userId: string;
  taskIds: string[];
}): Promise<MeetingClearanceCandidate[]> => {
  if (input.taskIds.length === 0) {
    return [];
  }
  const rows = await db.meetingTasks.findMany({
    where: { id: { in: input.taskIds } },
    select: {
      id: true,
      status: true,
      completedAt: true,
      updatedAt: true,
      ownerUserId: true,
      meetingTaskLists: { select: { status: true } },
      meetings: {
        select: {
          hiddenFromHistoryAt: true,
          workspaceId: true,
          createdByUserId: true,
          isConfidential: true,
          kind: true,
          meetingParticipants: {
            where: { userId: input.userId },
            select: { userId: true },
          },
          meetingAttendeeWorkspaces: {
            where: { userId: input.userId },
            select: { workspaceId: true },
          },
        },
      },
    },
  });

  return dedupeCandidates(
    rows.map((row) => ({
      taskId: row.id,
      status: row.status,
      completedAt: row.completedAt,
      updatedAt: row.updatedAt,
      ownerUserId: row.ownerUserId,
      listStatus: row.meetingTaskLists.status,
      hiddenFromHistoryAt: row.meetings.hiddenFromHistoryAt,
      meetingWorkspaceId: row.meetings.workspaceId,
      createdByUserId: row.meetings.createdByUserId,
      isConfidential: row.meetings.isConfidential,
      kind: row.meetings.kind,
      participantUserId: row.meetings.meetingParticipants[0]?.userId ?? null,
      filingWorkspaceId: row.meetings.meetingAttendeeWorkspaces[0]?.workspaceId ?? null,
    })),
  );
};

const suspendedHostIds = async ({
  userId,
  workspaceIds,
}: {
  userId: string;
  workspaceIds: string[];
}): Promise<Set<string>> => {
  if (workspaceIds.length === 0) {
    return new Set();
  }
  const rows = await db.workspaceMemberships.findMany({
    where: {
      userId,
      status: "suspended",
      workspaceId: { in: workspaceIds },
    },
    select: { workspaceId: true },
  });

  return new Set(rows.map((row) => row.workspaceId));
};

const visibleMeetingClearances = async (input: {
  userId: string;
  workspaceId: string;
  taskIds: string[];
}): Promise<SelectedClearance[]> => {
  const candidates = await loadMeetingClearanceCandidates({ userId: input.userId, taskIds: input.taskIds });
  const suspendedHosts = await suspendedHostIds({
    userId: input.userId,
    workspaceIds: [...new Set(candidates.map((row) => row.meetingWorkspaceId))],
  });

  return candidates.flatMap((row) => {
    if (!isVisibleMeetingTask({ row, userId: input.userId, workspaceId: input.workspaceId, suspendedHosts })) {
      return [];
    }

    return [
      {
        sourceType: "meeting" as const,
        taskId: row.taskId,
        completedBefore: row.completedAt ?? row.updatedAt,
      },
    ];
  });
};

const visibleWorkspaceClearances = async (input: {
  workspaceId: string;
  taskIds: string[];
}): Promise<SelectedClearance[]> => {
  if (input.taskIds.length === 0) {
    return [];
  }
  const rows = await db.workspaceTasks.findMany({
    where: {
      id: { in: input.taskIds },
      workspaceId: input.workspaceId,
      status: "completed",
    },
    select: { id: true, completedAt: true, updatedAt: true },
  });

  return rows.map((row) => ({
    sourceType: "workspace",
    taskId: row.id,
    completedBefore: row.completedAt ?? row.updatedAt,
  }));
};

const clearanceKey = (task: { sourceType: string; taskId: string }): string => `${task.sourceType}:${task.taskId}`;

const orderedVisibleClearances = ({
  tasks,
  visible,
}: {
  tasks: SelectedDoneTask[];
  visible: SelectedClearance[];
}): SelectedClearance[] => {
  const byKey = new Map(visible.map((task) => [clearanceKey(task), task]));
  const seen = new Set<string>();

  return tasks.flatMap((task) => {
    const key = clearanceKey(task);
    const match = byKey.get(key);
    if (match === undefined || seen.has(key)) {
      return [];
    }
    seen.add(key);

    return [match];
  });
};

const writeExistingClearances = async (input: {
  userId: string;
  workspaceId: string;
  tasks: SelectedClearance[];
  existing: Map<string, Date>;
}): Promise<void> => {
  const [task, ...rest] = input.tasks;
  if (task === undefined) {
    return;
  }
  const previous = input.existing.get(clearanceKey(task));
  if (previous !== undefined) {
    await db.personalTaskItemClearances.updateMany({
      where: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        sourceType: task.sourceType,
        sourceTaskId: task.taskId,
      },
      data: { completedBefore: laterDate({ left: previous, right: task.completedBefore }) },
    });
  }
  await writeExistingClearances({ ...input, tasks: rest });
};

const saveItemClearances = async (input: {
  userId: string;
  workspaceId: string;
  tasks: SelectedClearance[];
}): Promise<void> => {
  if (input.tasks.length === 0) {
    return;
  }
  const existingRows = await db.personalTaskItemClearances.findMany({
    where: {
      userId: input.userId,
      workspaceId: input.workspaceId,
      sourceTaskId: { in: input.tasks.map((task) => task.taskId) },
    },
    select: { sourceType: true, sourceTaskId: true, completedBefore: true },
  });
  const existing = new Map(existingRows.map((row) => [`${row.sourceType}:${row.sourceTaskId}`, row.completedBefore]));
  const fresh = input.tasks.filter((task) => !existing.has(clearanceKey(task)));
  if (fresh.length !== 0) {
    await db.personalTaskItemClearances.createMany({
      data: fresh.map((task) => ({
        userId: input.userId,
        workspaceId: input.workspaceId,
        sourceType: task.sourceType,
        sourceTaskId: task.taskId,
        completedBefore: task.completedBefore,
      })),
    });
  }
  await writeExistingClearances({
    userId: input.userId,
    workspaceId: input.workspaceId,
    tasks: input.tasks.filter((task) => existing.has(clearanceKey(task))),
    existing,
  });
};

export async function clearSelectedPersonalDoneTasks(input: {
  userId: string;
  workspaceId: string;
  tasks: SelectedDoneTask[];
}): Promise<{ sourceType: TaskSource; taskId: string }[]> {
  if (!(await hasActiveMembership(input))) {
    return [];
  }
  const [meetingTasksToClear, workspaceTasksToClear] = await Promise.all([
    visibleMeetingClearances({
      userId: input.userId,
      workspaceId: input.workspaceId,
      taskIds: input.tasks.filter((task) => task.sourceType === "meeting").map((task) => task.taskId),
    }),
    visibleWorkspaceClearances({
      workspaceId: input.workspaceId,
      taskIds: input.tasks.filter((task) => task.sourceType === "workspace").map((task) => task.taskId),
    }),
  ]);
  const visible = orderedVisibleClearances({
    tasks: input.tasks,
    visible: [...meetingTasksToClear, ...workspaceTasksToClear],
  });
  await saveItemClearances({ userId: input.userId, workspaceId: input.workspaceId, tasks: visible });

  return visible.map((task) => ({ sourceType: task.sourceType, taskId: task.taskId }));
}
