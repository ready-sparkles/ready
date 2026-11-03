import { type AshbyReview, ashbyReviewSchema } from "@readymeet/shared";
import { randomUUID } from "node:crypto";

import { db, Prisma } from "./client";

const MESSAGE_ASHBY_REVIEW_NOT_STORED = "Ashby review was not stored.";
const MESSAGE_ASHBY_REVIEW_CHANGED = "This Ashby review changed. Refresh before confirming.";

type AshbyReviewViewer = { userId: string; workspaceId: string };
type AshbyActionStatus = "unknown" | "completed" | "rejected";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isJsonInput = (value: unknown): value is Prisma.InputJsonValue => {
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => entry === null || isJsonInput(entry));
  }

  return isPlainRecord(value) && Object.values(value).every((entry) => entry === null || isJsonInput(entry));
};

const jsonInput = (value: Record<string, unknown>): Prisma.InputJsonValue => {
  if (!isJsonInput(value)) {
    throw new Error(MESSAGE_ASHBY_REVIEW_NOT_STORED);
  }

  return value;
};

function analysisJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) {
    return Prisma.JsonNull;
  }
  if (!isJsonInput(value)) {
    throw new Error(MESSAGE_ASHBY_REVIEW_NOT_STORED);
  }

  return value;
}

function isAshbyActionStatus(value: unknown): value is AshbyActionStatus {
  return value === "unknown" || value === "completed" || value === "rejected";
}

function parseAshbyCommand(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }

  return isPlainRecord(value) ? value : null;
}

function parseAshbyActionRow(row: { id: unknown; status: unknown; result: unknown }): {
  id: string;
  status: AshbyActionStatus;
  result: Record<string, unknown> | null;
} {
  if (typeof row.id !== "string") {
    throw new Error(MESSAGE_ASHBY_REVIEW_NOT_STORED);
  }
  if (!isAshbyActionStatus(row.status)) {
    throw new Error(MESSAGE_ASHBY_REVIEW_NOT_STORED);
  }

  return {
    id: row.id,
    status: row.status,
    result: parseAshbyCommand(row.result),
  };
}

const loadEndedMeeting = async (
  meetingId: string,
): Promise<{ workspaceId: string; createdByUserId: string } | undefined> => {
  const row = await db.meetings.findFirst({
    where: { id: meetingId, status: "ended" },
    select: { workspaceId: true, createdByUserId: true },
  });

  return row ?? undefined;
};

const loadReviewCandidateUserIds = async (input: { meetingId: string; createdByUserId: string }): Promise<string[]> => {
  const participants = await db.meetingParticipants.findMany({
    where: { meetingId: input.meetingId, role: { not: "assistant" } },
    select: { userId: true },
  });

  return [...new Set([input.createdByUserId, ...participants.map((row) => row.userId)])];
};

const filterUnsuspended = async (input: { userIds: string[]; hostWorkspaceId: string }): Promise<string[]> => {
  const suspended = await db.workspaceMemberships.findMany({
    where: {
      workspaceId: input.hostWorkspaceId,
      userId: { in: input.userIds },
      status: "suspended",
    },
    select: { userId: true },
  });
  const blocked = new Set(suspended.map((row) => row.userId));

  return input.userIds.filter((userId) => !blocked.has(userId));
};

const loadEffectiveWorkspaces = async (input: {
  meetingId: string;
  userIds: string[];
  hostWorkspaceId: string;
}): Promise<AshbyReviewViewer[]> => {
  const filings = await db.meetingAttendeeWorkspaces.findMany({
    where: { meetingId: input.meetingId, userId: { in: input.userIds } },
    select: { userId: true, workspaceId: true },
  });
  const filingByUser = new Map(filings.map((row) => [row.userId, row.workspaceId]));

  return input.userIds.map((userId) => ({
    userId,
    workspaceId: filingByUser.get(userId) ?? input.hostWorkspaceId,
  }));
};

const filterConnectedViewers = async (viewers: AshbyReviewViewer[]): Promise<AshbyReviewViewer[]> => {
  const userIds = [...new Set(viewers.map((viewer) => viewer.userId))];
  const workspaceIds = [...new Set(viewers.map((viewer) => viewer.workspaceId))];
  const [connections, integrations, memberships, eligibleUsers] = await Promise.all([
    db.ashbyMemberConnections.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, workspaceId: true },
    }),
    db.workspaceAshbyIntegrations.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { workspaceId: true },
    }),
    db.workspaceMemberships.findMany({
      where: { userId: { in: userIds }, status: "active" },
      select: { userId: true, workspaceId: true },
    }),
    db.users.findMany({
      where: { id: { in: userIds }, deletedAt: null, source: { not: "guest" } },
      select: { id: true },
    }),
  ]);
  const connected = new Set(connections.map((row) => `${row.userId}:${row.workspaceId}`));
  const integrated = new Set(integrations.map((row) => row.workspaceId));
  const activeMembers = new Set(memberships.map((row) => `${row.userId}:${row.workspaceId}`));
  const people = new Set(eligibleUsers.map((row) => row.id));

  return viewers.filter(
    (viewer) =>
      connected.has(`${viewer.userId}:${viewer.workspaceId}`) &&
      integrated.has(viewer.workspaceId) &&
      activeMembers.has(`${viewer.userId}:${viewer.workspaceId}`) &&
      people.has(viewer.userId),
  );
};

export async function listAshbyReviewViewers(input: { meetingId: string }): Promise<AshbyReviewViewer[]> {
  const meeting = await loadEndedMeeting(input.meetingId);
  if (meeting === undefined) {
    return [];
  }
  const userIds = await loadReviewCandidateUserIds({
    meetingId: input.meetingId,
    createdByUserId: meeting.createdByUserId,
  });
  if (userIds.length === 0) {
    return [];
  }
  const unsuspended = await filterUnsuspended({ userIds, hostWorkspaceId: meeting.workspaceId });
  if (unsuspended.length === 0) {
    return [];
  }

  return filterConnectedViewers(
    await loadEffectiveWorkspaces({
      meetingId: input.meetingId,
      userIds: unsuspended,
      hostWorkspaceId: meeting.workspaceId,
    }),
  );
}

export async function getAshbyReview(input: {
  meetingId: string;
  userId: string;
  workspaceId: string;
}): Promise<AshbyReview | null> {
  const row = await db.ashbyReviews.findUnique({
    where: {
      meetingId_userId_workspaceId: {
        meetingId: input.meetingId,
        userId: input.userId,
        workspaceId: input.workspaceId,
      },
    },
    select: { review: true },
  });

  return row === null ? null : ashbyReviewSchema.parse(row.review);
}

export async function getAshbyReviewById(input: { id: string }): Promise<{
  review: AshbyReview;
  command: Record<string, unknown> | null;
} | null> {
  const row = await db.ashbyReviews.findUnique({
    where: { id: input.id },
    select: { review: true, command: true },
  });

  return row === null
    ? null
    : {
        review: ashbyReviewSchema.parse(row.review),
        command: parseAshbyCommand(row.command),
      };
}

export async function createAshbyReview(review: AshbyReview): Promise<AshbyReview> {
  await db.ashbyReviews.createMany({
    data: [
      { id: review.id, meetingId: review.meetingId, userId: review.userId, workspaceId: review.workspaceId, review },
    ],
    skipDuplicates: true,
  });
  const stored = await getAshbyReview({
    meetingId: review.meetingId,
    userId: review.userId,
    workspaceId: review.workspaceId,
  });
  if (stored === null) {
    throw new Error(MESSAGE_ASHBY_REVIEW_NOT_STORED);
  }

  return stored;
}

/** CAS plus durable job insertion: accepting an action cannot strand its worker handoff. */
export async function saveAshbyReview(input: {
  review: AshbyReview;
  expectedRevision: number;
  command?: Record<string, unknown> | null;
}): Promise<AshbyReview> {
  const { review, expectedRevision, command = null } = input;
  const updated = await db.ashbyReviews.updateMany({
    where: { id: review.id, revision: expectedRevision },
    data: {
      review,
      revision: review.revision,
      command: command === null ? Prisma.DbNull : jsonInput(command),
      updatedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    throw new Error(MESSAGE_ASHBY_REVIEW_CHANGED);
  }

  return review;
}

export async function getAshbyAnalysis(input: { meetingId: string; hash: string }): Promise<unknown> {
  const row = await db.ashbyMeetingAnalyses.findUnique({
    where: { meetingId_inputHash: { meetingId: input.meetingId, inputHash: input.hash } },
    select: { result: true },
  });

  return row?.result ?? null;
}

export async function saveAshbyAnalysis(input: { meetingId: string; hash: string; result: unknown }): Promise<void> {
  await db.ashbyMeetingAnalyses.createMany({
    data: [
      {
        meetingId: input.meetingId,
        inputHash: input.hash,
        result: analysisJsonInput(input.result),
      },
    ],
    skipDuplicates: true,
  });
}

export async function claimAshbyAction(input: {
  workspaceId: string;
  meetingId: string;
  kind: "stage";
  targetId: string;
  intent?: Record<string, unknown>;
}): Promise<{
  id: string;
  status: AshbyActionStatus;
  result: Record<string, unknown> | null;
  /** @external existing wire contract */ acquired: boolean;
}> {
  return db.$transaction(async (tx) => {
    const id = randomUUID();
    const intent = input.intent ?? {};
    const inserted = await tx.ashbyReviewActions.createManyAndReturn({
      data: [
        {
          id,
          workspaceId: input.workspaceId,
          meetingId: input.meetingId,
          kind: input.kind,
          targetId: input.targetId,
          result: jsonInput(intent),
        },
      ],
      skipDuplicates: true,
    });
    if (inserted[0]) {
      return { ...parseAshbyActionRow(inserted[0]), /** @external action claim contract */ acquired: true };
    }
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM ashby_review_actions WHERE workspace_id=${input.workspaceId}::uuid AND meeting_id=${input.meetingId}::uuid AND kind=${input.kind} AND target_id=${input.targetId} FOR UPDATE`;
    if (!locked) {
      throw new Error(MESSAGE_ASHBY_REVIEW_NOT_STORED);
    }
    const stored = await tx.ashbyReviewActions.findUniqueOrThrow({ where: { id: locked.id } });
    if (stored.status !== "rejected") {
      return { ...parseAshbyActionRow(stored), /** @external action claim contract */ acquired: false };
    }
    const updated = await tx.ashbyReviewActions.update({
      where: { id: stored.id },
      data: { status: "unknown", result: jsonInput(intent) },
    });

    return { ...parseAshbyActionRow(updated), /** @external action claim contract */ acquired: true };
  });
}

export async function finishAshbyAction(input: {
  id: string;
  status: "completed" | "rejected";
  result: Record<string, unknown>;
}): Promise<void> {
  await db.ashbyReviewActions.updateMany({
    where: { id: input.id, status: "unknown" },
    data: { status: input.status, result: jsonInput(input.result) },
  });
}
