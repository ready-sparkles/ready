import { shouldAutoMarkMeetingConfidential } from "@readymeet/shared";
import { randomUUID } from "node:crypto";

import { MeetingConfidentialityRequiredError } from "../../../domain/persistence-errors";
import { publishRealtimeEvents } from "../../../ports/realtime";

import { db, type DbTransaction, Prisma } from "./client";
import { recordWorkspaceAuditEvent } from "./workspace-audit";

type MeetingRow = Prisma.meetingsModel;
type MeetingConfidentialityConnection = Pick<DbTransaction, "meetings" | "meetingParticipants">;

async function hasExactlyTwoInternalHumanParticipants(input: {
  meetingId: string;
  workspaceId: string;
  connection?: Pick<MeetingConfidentialityConnection, "meetingParticipants">;
}) {
  const connection = input.connection ?? db;
  const humanParticipants = await connection.meetingParticipants.findMany({
    where: {
      meetingId: input.meetingId,
      role: { not: "assistant" },
      users: { deletedAt: null },
    },
    include: {
      users: {
        include: {
          workspaceMemberships: {
            where: { workspaceId: input.workspaceId },
          },
        },
      },
    },
  });

  return shouldAutoMarkMeetingConfidential({
    humanParticipants: humanParticipants.map((participant) => ({
      userId: participant.userId,
      email: participant.users.email,
      isWorkspaceMember: participant.users.workspaceMemberships[0]?.status === "active",
    })),
  });
}

/** Whether this standard meeting is an internal one-to-one that cannot be unlocked. */
export async function isMeetingConfidentialityRequired(meetingId: string): Promise<boolean> {
  const meeting = await db.meetings.findUnique({ where: { id: meetingId } });

  return (
    meeting?.kind === "standard" &&
    (await hasExactlyTwoInternalHumanParticipants({
      meetingId,
      workspaceId: meeting.workspaceId,
    }))
  );
}

function meetingConfidentialityRealtimePayload(input: {
  workspaceId: string;
  meetingId: string;
  isConfidential: boolean;
  confidentialitySource: string | null;
  actorUserId: string | null;
}) {
  return {
    version: 1 as const,
    eventId: randomUUID(),
    eventName: "meeting.confidentiality.changed" as const,
    workspaceId: input.workspaceId,
    meetingId: input.meetingId,
    isConfidential: input.isConfidential,
    confidentialitySource: input.confidentialitySource,
    occurredAt: new Date().toISOString(),
    actorUserId: input.actorUserId,
  };
}

async function publishMeetingConfidentialityRealtime(input: {
  workspaceId: string;
  meetingId: string;
  isConfidential: boolean;
  confidentialitySource: string | null;
  changedAt: Date;
  actorUserId: string | null;
}): Promise<void> {
  await publishRealtimeEvents([
    {
      channel: `workspace:${input.workspaceId}:meeting:${input.meetingId}:tasks`,
      eventName: "meeting.confidentiality.changed",
      payload: meetingConfidentialityRealtimePayload(input),
    },
  ]);
}

type MeetingConfidentialityChange = {
  meetingId: string;
  isConfidential: boolean;
  source: "auto" | "manual";
  actorUserId: string | null;
};

async function updateMeetingConfidentiality(
  input: MeetingConfidentialityChange & { connection: Pick<MeetingConfidentialityConnection, "meetings"> },
): Promise<MeetingRow | null> {
  try {
    return await input.connection.meetings.update({
      where: { id: input.meetingId },
      data: {
        isConfidential: input.isConfidential,
        confidentialitySource: input.source,
        confidentialityUpdatedByUserId: input.actorUserId,
        confidentialityUpdatedAt: new Date(),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return null;
    }
    throw error;
  }
}

export async function notifyMeetingConfidentialityChanged(updated: MeetingRow): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: updated.workspaceId,
    actorUserId: updated.confidentialityUpdatedByUserId,
    eventType: "meeting.confidentiality.changed",
    subjectType: "meeting",
    subjectId: updated.id,
    metadata: {
      isConfidential: updated.isConfidential,
      source: updated.confidentialitySource,
    },
  });
  await publishMeetingConfidentialityRealtime({
    workspaceId: updated.workspaceId,
    meetingId: updated.id,
    isConfidential: updated.isConfidential,
    confidentialitySource: updated.confidentialitySource,
    changedAt: updated.confidentialityUpdatedAt ?? new Date(),
    actorUserId: updated.confidentialityUpdatedByUserId,
  });
}

/**
 * Applies a confidentiality change, records the audit event, and enqueues the
 * realtime notification for in-meeting synchronization. Tasks created from
 * the meeting need no separate update: their visibility is always derived
 * from the source meeting's confidentiality at query time.
 */
export async function setMeetingConfidentiality(input: MeetingConfidentialityChange): Promise<MeetingRow | null> {
  const updated = await db.$transaction(async (tx) => {
    // Participant mutations take this same lock before changing the policy inputs.
    const locked = await tx.$queryRaw<{ id: string; kind: string; workspaceId: string }[]>`
      SELECT id, kind, workspace_id AS "workspaceId"
      FROM "meetings"
      WHERE id = CAST(${input.meetingId} AS uuid)
      FOR UPDATE
    `;
    const meeting = locked[0];
    if (!meeting) {
      return null;
    }
    if (
      !input.isConfidential &&
      meeting.kind === "standard" &&
      (await hasExactlyTwoInternalHumanParticipants({
        meetingId: meeting.id,
        workspaceId: meeting.workspaceId,
        connection: tx,
      }))
    ) {
      throw new MeetingConfidentialityRequiredError();
    }

    return updateMeetingConfidentiality({ ...input, connection: tx });
  });
  if (updated) {
    await notifyMeetingConfidentialityChanged(updated);
  }

  return updated;
}

/**
 * Enforces confidentiality for an internal one-to-one after a participant
 * joins. This invariant overrides a prior manual unlock. A later third
 * participant never removes confidentiality automatically. The caller holds
 * the meeting row lock until its participant mutation commits.
 */
export async function autoMarkMeetingConfidentialInTransaction(input: {
  meetingId: string;
  connection: MeetingConfidentialityConnection;
}): Promise<MeetingRow | null> {
  const { meetingId, connection } = input;
  const meeting = await connection.meetings.findUnique({ where: { id: meetingId } });
  if (!meeting || meeting.kind !== "standard" || meeting.status === "ended") {
    return null;
  }
  if (meeting.isConfidential && meeting.confidentialitySource === "auto") {
    return null;
  }
  if (!(await hasExactlyTwoInternalHumanParticipants({ meetingId, workspaceId: meeting.workspaceId, connection }))) {
    return null;
  }

  return updateMeetingConfidentiality({
    meetingId,
    isConfidential: true,
    source: "auto",
    actorUserId: null,
    connection,
  });
}

export async function maybeAutoMarkMeetingConfidential(meetingId: string): Promise<boolean> {
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM "meetings" WHERE id = CAST(${meetingId} AS uuid) FOR UPDATE
    `;

    return autoMarkMeetingConfidentialInTransaction({ meetingId, connection: tx });
  });
  if (!updated) {
    return false;
  }
  await notifyMeetingConfidentialityChanged(updated);

  return true;
}
