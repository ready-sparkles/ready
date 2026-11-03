import { db } from "./client";

class InactiveAttendeeWorkspaceError extends Error {
  readonly code = "23503";

  constructor() {
    super("Inactive attendee workspace");
    this.name = "InactiveAttendeeWorkspaceError";
  }
}

type ActiveMembership = { workspaceId: string; createdAt: Date };

const filingExists = async (input: { meetingId: string; userId: string }): Promise<boolean> => {
  const row = await db.meetingAttendeeWorkspaces.findUnique({
    where: { meetingId_userId: { meetingId: input.meetingId, userId: input.userId } },
    select: { meetingId: true },
  });

  return row !== null;
};

const assertActiveSelectedWorkspace = async (input: { userId: string; workspaceId: string }): Promise<void> => {
  const row = await db.workspaceMemberships.findFirst({
    where: { userId: input.userId, workspaceId: input.workspaceId, status: "active" },
    select: { id: true },
  });
  if (row === null) {
    throw new InactiveAttendeeWorkspaceError();
  }
};

const compareMemberships = ({
  left,
  right,
  hostWorkspaceId,
  preferredWorkspaceId,
}: {
  left: ActiveMembership;
  right: ActiveMembership;
  hostWorkspaceId: string;
  preferredWorkspaceId: string;
}): number => {
  const hostOrder = Number(left.workspaceId !== hostWorkspaceId) - Number(right.workspaceId !== hostWorkspaceId);
  if (hostOrder !== 0) {
    return hostOrder;
  }
  const preferredOrder =
    Number(left.workspaceId !== preferredWorkspaceId) - Number(right.workspaceId !== preferredWorkspaceId);
  if (preferredOrder !== 0) {
    return preferredOrder;
  }
  const createdOrder = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdOrder !== 0) {
    return createdOrder;
  }
  if (left.workspaceId < right.workspaceId) {
    return -1;
  }
  if (left.workspaceId > right.workspaceId) {
    return 1;
  }

  return 0;
};

const chooseDestination = ({
  memberships,
  hostWorkspaceId,
  preferredWorkspaceId,
}: {
  memberships: ActiveMembership[];
  hostWorkspaceId: string;
  preferredWorkspaceId: string;
}): ActiveMembership | undefined =>
  [...memberships].sort((left, right) => compareMemberships({ left, right, hostWorkspaceId, preferredWorkspaceId }))[0];

const loadRecordContext = async (input: { meetingId: string; userId: string }) => {
  const [meeting, user] = await Promise.all([
    db.meetings.findUnique({
      where: { id: input.meetingId },
      select: { workspaceId: true, status: true },
    }),
    db.users.findUnique({
      where: { id: input.userId },
      select: { deletedAt: true, source: true },
    }),
  ]);

  return { meeting: meeting ?? undefined, user: user ?? undefined };
};

const canFileAttendee = ({
  user,
  meetingStatus,
}: {
  user: { deletedAt: Date | null; source: string } | undefined;
  meetingStatus: string;
}): boolean =>
  user !== undefined &&
  user.deletedAt === null &&
  (user.source === "auth" || user.source === "dev_login") &&
  meetingStatus !== "ended";

const insertAttendeeFiling = async (input: {
  meetingId: string;
  userId: string;
  hostWorkspaceId: string;
  preferredWorkspaceId: string;
}): Promise<void> => {
  const [suspended, memberships] = await Promise.all([
    db.workspaceMemberships.findFirst({
      where: {
        userId: input.userId,
        workspaceId: input.hostWorkspaceId,
        status: "suspended",
      },
      select: { id: true },
    }),
    db.workspaceMemberships.findMany({
      where: { userId: input.userId, status: "active" },
      select: { workspaceId: true, createdAt: true },
    }),
  ]);
  if (suspended !== null) {
    return;
  }
  const destination = chooseDestination({
    memberships,
    hostWorkspaceId: input.hostWorkspaceId,
    preferredWorkspaceId: input.preferredWorkspaceId,
  });
  if (destination === undefined) {
    return;
  }
  await db.meetingAttendeeWorkspaces.createMany({
    data: [
      {
        meetingId: input.meetingId,
        userId: input.userId,
        workspaceId: destination.workspaceId,
        assignment: destination.workspaceId === input.hostWorkspaceId ? "host_workspace" : "joined_workspace",
      },
    ],
    skipDuplicates: true,
  });
};

/** Activate the shared host workspace only after joining, without moving prior filing. */
export async function activateMeetingAttendeeWorkspace(input: {
  meetingId: string;
  userId: string;
}): Promise<string | null> {
  const meeting = await db.meetings.findUnique({
    where: { id: input.meetingId },
    select: { workspaceId: true, status: true },
  });
  if (meeting === null || meeting.status === "ended") {
    return null;
  }
  const user = await db.users.findUnique({
    where: { id: input.userId },
    select: { deletedAt: true, source: true },
  });
  if (user === null || user.deletedAt !== null || (user.source !== "auth" && user.source !== "dev_login")) {
    return null;
  }
  const filing = await db.meetingAttendeeWorkspaces.findUnique({
    where: { meetingId_userId: { meetingId: input.meetingId, userId: input.userId } },
    select: { workspaceId: true },
  });
  if (filing === null || filing.workspaceId !== meeting.workspaceId) {
    return null;
  }
  const membership = await db.workspaceMemberships.findFirst({
    where: {
      userId: input.userId,
      workspaceId: meeting.workspaceId,
      status: "active",
    },
    select: { id: true },
  });
  if (membership === null) {
    return null;
  }
  const updated = await db.users.updateManyAndReturn({
    where: { id: input.userId },
    data: { activeWorkspaceId: meeting.workspaceId },
    select: { activeWorkspaceId: true },
  });

  return updated[0]?.activeWorkspaceId ?? null;
}

/** First-join filing scope is durable; never reconstruct it from today's active workspace. */
export async function getMeetingAttendeeWorkspace(input: {
  meetingId: string;
  userId: string;
  hostWorkspaceId: string;
}): Promise<string> {
  const row = await db.meetingAttendeeWorkspaces.findUnique({
    where: { meetingId_userId: { meetingId: input.meetingId, userId: input.userId } },
    select: { workspaceId: true },
  });

  return row?.workspaceId ?? input.hostWorkspaceId;
}

/** Called only after meeting access checks, before token issuance / presence. */
export async function recordMeetingAttendeeWorkspace(input: {
  meetingId: string;
  userId: string;
  workspaceId: string;
}): Promise<void> {
  if (await filingExists(input)) {
    return;
  }
  await assertActiveSelectedWorkspace({ userId: input.userId, workspaceId: input.workspaceId });
  const { meeting, user } = await loadRecordContext(input);
  if (meeting === undefined || !canFileAttendee({ user, meetingStatus: meeting.status })) {
    return;
  }
  await insertAttendeeFiling({
    meetingId: input.meetingId,
    userId: input.userId,
    hostWorkspaceId: meeting.workspaceId,
    preferredWorkspaceId: input.workspaceId,
  });
}
