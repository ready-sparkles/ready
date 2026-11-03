import { db } from "./client";

type ToolOwnerTurn = {
  meetingId: string;
  userId: string;
  source: string;
  workspaceId: string;
  identity: string;
};

const loadToolOwnerTurn = async (input: {
  meetingId: string;
  userId: string;
  agentProfileId: string;
  meetingTurnId: string;
  participantIdentity: string;
}): Promise<ToolOwnerTurn | undefined> => {
  const row = await db.meetingTurns.findFirst({
    where: {
      meetingId: input.meetingId,
      ownerUserId: input.userId,
      status: "active",
      agentProfileId: input.agentProfileId,
      id: input.meetingTurnId,
      ownerParticipantIdentity: input.participantIdentity,
      meetings: { status: "active" },
      users: { deletedAt: null },
      agentProfiles: { userId: input.userId },
    },
    include: {
      /** @external Prisma relation include */
      users: true,
      /** @external Prisma relation include */
      meetings: true,
    },
  });
  if (row === null) {
    return undefined;
  }

  return {
    meetingId: row.meetingId,
    userId: row.users.id,
    source: row.users.source,
    workspaceId: row.meetings.workspaceId,
    identity: row.ownerParticipantIdentity,
  };
};

const hasOpenParticipant = async (input: { meetingId: string; userId: string }): Promise<boolean> => {
  const row = await db.meetingParticipants.findFirst({
    where: {
      meetingId: input.meetingId,
      userId: input.userId,
      leftAt: null,
    },
  });

  return row !== null;
};

const isSuspendedInWorkspace = async (input: { workspaceId: string; userId: string }): Promise<boolean> => {
  const row = await db.workspaceMemberships.findFirst({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      status: "suspended",
    },
  });

  return row !== null;
};

const guestIdentityMatches = async (input: {
  meetingId: string;
  userId: string;
  identity: string;
}): Promise<boolean> => {
  const rows = await db.meetingJoinRequests.findMany({
    where: {
      meetingId: input.meetingId,
      userId: input.userId,
      status: "admitted",
    },
  });

  return rows.some(
    (row) =>
      input.identity === `guest:${row.id}` ||
      (row.sipParticipantIdentity !== null && input.identity === row.sipParticipantIdentity),
  );
};

const identityMatchesOwner = async (turn: ToolOwnerTurn): Promise<boolean> => {
  if (turn.source === "auth" || turn.source === "dev_login") {
    return turn.identity.split(":")[0] === turn.userId;
  }
  if (turn.source !== "guest") {
    return false;
  }

  return guestIdentityMatches({ meetingId: turn.meetingId, userId: turn.userId, identity: turn.identity });
};

/** Recheck the persisted turn against the server-issued connection identity. */
export async function hasActiveMeetingToolOwner(input: {
  meetingId: string;
  userId: string;
  agentProfileId: string;
  meetingTurnId: string;
  participantIdentity: string;
}): Promise<boolean> {
  const turn = await loadToolOwnerTurn(input);
  if (turn === undefined) {
    return false;
  }
  if (!(await hasOpenParticipant({ meetingId: turn.meetingId, userId: turn.userId }))) {
    return false;
  }
  if (await isSuspendedInWorkspace({ workspaceId: turn.workspaceId, userId: turn.userId })) {
    return false;
  }

  return identityMatchesOwner(turn);
}
