import { db, type Prisma } from "./client";
import {
  hasMemoryNotesEntitlement,
  listEligibleMemoryMeetings,
  meetingIdsWithReadyTranscript,
  type MemoryScope,
} from "./relationship-memory";

const MEMORY_GENERATION_UNAVAILABLE_MESSAGE = "Memory generation allowance unavailable.";

const ACCOUNT_SOURCES = new Set(["auth", "dev_login"]);

export type MemoryMeetingEvent = {
  id: string;
  meetingId: string;
  targetUserId: string | null;
  cursorUserId: string | null;
  version: string | number;
};

export async function listMemoryMeetingAttendees(meetingId: string): Promise<MemoryScope[]> {
  if (
    !(await meetingIdsWithReadyTranscript({ meetingIds: [meetingId], shouldRequireHumanSegment: true })).includes(
      meetingId,
    )
  ) {
    return [];
  }
  const meeting = await db.meetings.findUnique({ where: { id: meetingId } });
  const policy = await db.memoryRuntimePolicy.findFirst();
  if (
    meeting === null ||
    policy === null ||
    meeting.status !== "ended" ||
    meeting.endedAt === null ||
    !(meeting.endedAt > policy.futureOnlySince)
  ) {
    return [];
  }
  const endedAt = meeting.endedAt;
  const intervals = await db.meetingAttendanceIntervals.findMany({
    where: { meetingId, joinedAt: { lt: endedAt } },
  });
  const userIds = [...new Set(intervals.map((interval) => interval.userId))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (userIds.length === 0) {
    return [];
  }
  const [bindings, memberships, userRows] = await Promise.all([
    db.meetingAttendeeWorkspaces.findMany({
      where: { meetingId, userId: { in: userIds } },
    }),
    db.workspaceMemberships.findMany({
      where: { userId: { in: userIds }, status: "active" },
    }),
    db.users.findMany({
      where: { id: { in: userIds }, deletedAt: null },
    }),
  ]);
  const bindingByUser = new Map(bindings.map((binding) => [binding.userId, binding.workspaceId]));
  const activeMembers = new Set(memberships.map((membership) => `${membership.userId}:${membership.workspaceId}`));
  const accounts = new Set(userRows.filter((user) => ACCOUNT_SOURCES.has(user.source)).map((user) => user.id));

  return userIds.flatMap((userId) => {
    const workspaceId = bindingByUser.get(userId);
    if (workspaceId === undefined || !accounts.has(userId) || !activeMembers.has(`${userId}:${workspaceId}`)) {
      return [];
    }

    return [{ userId, workspaceId }];
  });
}

async function historyMemoriesAreCurrent(input: {
  historyMemoryIds: string[];
  userId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (input.historyMemoryIds.length === 0) {
    return true;
  }
  const memories = await db.relationshipMemories.findMany({
    where: { id: { in: input.historyMemoryIds } },
  });
  const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
  const sourceIds = [...new Set(memories.map((memory) => memory.sourceId))];
  const sources = sourceIds.length === 0 ? [] : await db.memorySources.findMany({ where: { id: { in: sourceIds } } });
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const scope = { userId: input.userId, workspaceId: input.workspaceId };
  const checks = await Promise.all(
    input.historyMemoryIds.map(async (historyId) => {
      const memory = memoriesById.get(historyId);
      const source = memory === undefined ? undefined : sourcesById.get(memory.sourceId);
      if (
        source === undefined ||
        source.userId !== input.userId ||
        source.workspaceId !== input.workspaceId ||
        !source.isCurrent ||
        source.meetingId === null
      ) {
        return false;
      }
      const eligible = await listEligibleMemoryMeetings({ scope, meetingId: source.meetingId });
      if (eligible[0]?.revision !== source.revision) {
        return false;
      }

      return hasMemoryNotesEntitlement({ userId: input.userId, meetingId: source.meetingId });
    }),
  );

  return checks.every((isAllowed) => isAllowed);
}

async function assertCurrentMemoryRequestSource(input: {
  ledger: Prisma.memoryGenerationLedgerModel;
  sourceId: string;
  meetingId: string;
  futureOnlySince: Date;
}): Promise<void> {
  const source = await db.memorySources.findUnique({ where: { id: input.sourceId } });
  const meeting = await db.meetings.findUnique({ where: { id: input.meetingId } });
  if (
    source === null ||
    meeting === null ||
    source.meetingId !== input.meetingId ||
    source.userId !== input.ledger.userId ||
    source.workspaceId !== input.ledger.workspaceId ||
    source.revision !== input.ledger.sourceRevision ||
    meeting.endedAt === null ||
    !(meeting.endedAt > input.futureOnlySince)
  ) {
    throw new Error(MEMORY_GENERATION_UNAVAILABLE_MESSAGE);
  }
}

/** The assistant must commit this irreversible guard immediately before dispatch. */
export async function consumeMemoryGeneration(input: {
  jobId: string;
  leaseToken: string;
  ownerUserId: string;
  meetingId: string;
  historyMemoryIds?: string[];
}): Promise<void> {
  const ledger = await db.memoryGenerationLedger.findUnique({ where: { jobId: input.jobId } });
  const policy = await db.memoryRuntimePolicy.findFirst();

  if (
    ledger === null ||
    policy === null ||
    ledger.requestToken !== input.leaseToken ||
    ledger.completedAt !== null ||
    ledger.modelStartedAt !== null ||
    ledger.userId !== input.ownerUserId ||
    ledger.meetingId !== input.meetingId ||
    ledger.sourceId === null
  ) {
    throw new Error(MEMORY_GENERATION_UNAVAILABLE_MESSAGE);
  }
  await assertCurrentMemoryRequestSource({
    ledger,
    sourceId: ledger.sourceId,
    meetingId: input.meetingId,
    futureOnlySince: policy.futureOnlySince,
  });
  const scope = { userId: ledger.userId, workspaceId: ledger.workspaceId };
  const eligible = await listEligibleMemoryMeetings({ scope, meetingId: input.meetingId });
  if (eligible[0]?.revision !== ledger.sourceRevision) {
    throw new Error(MEMORY_GENERATION_UNAVAILABLE_MESSAGE);
  }
  if (!(await hasMemoryNotesEntitlement({ userId: ledger.userId, meetingId: input.meetingId }))) {
    throw new Error(MEMORY_GENERATION_UNAVAILABLE_MESSAGE);
  }
  if (
    !(await historyMemoriesAreCurrent({
      historyMemoryIds: input.historyMemoryIds ?? [],
      userId: ledger.userId,
      workspaceId: ledger.workspaceId,
    }))
  ) {
    throw new Error(MEMORY_GENERATION_UNAVAILABLE_MESSAGE);
  }
  const updated = await db.memoryGenerationLedger.updateMany({
    where: {
      jobId: input.jobId,
      modelStartedAt: null,
      userId: input.ownerUserId,
      meetingId: input.meetingId,
    },
    data: { modelStartedAt: new Date() },
  });
  if (updated.count !== 1) {
    throw new Error(MEMORY_GENERATION_UNAVAILABLE_MESSAGE);
  }
}
