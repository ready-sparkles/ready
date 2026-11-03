import { db } from "./client";

export async function listMemoryPersonMeetings(input: {
  personId: string;
  sourceIds: string[];
}): Promise<{ id: string; title: string; occurredAt: Date }[]> {
  if (input.sourceIds.length === 0) {
    return [];
  }

  const rows = await db.memoryInteractions.findMany({
    where: {
      personId: input.personId,
      sourceId: { in: input.sourceIds },
      memorySources: { meetingId: { not: null } },
    },
    include: {
      memorySources: {
        include: {
          /** @external Prisma relation include */
          meetings: true,
        },
      },
    },
    orderBy: { occurredAt: "desc" },
  });

  return rows.flatMap((row) => {
    const meeting = row.memorySources.meetings;
    if (meeting === null) {
      return [];
    }

    return [{ id: meeting.id, title: meeting.title, occurredAt: row.occurredAt }];
  });
}

export async function readVisibleRelationshipMemoryPersonIds(input: {
  memoryId: string;
  sourceIds: string[];
}): Promise<{ personIds: string[] } | null> {
  if (input.sourceIds.length === 0) {
    return null;
  }
  const row = await db.relationshipMemories.findFirst({
    where: {
      id: input.memoryId,
      sourceId: { in: input.sourceIds },
      OR: [
        {
          /** @external database column */
          sensitive: false,
        },
        {
          memorySources: {
            /** @external database column */
            includeSensitive: true,
          },
        },
      ],
    },
  });
  if (row === null) {
    return null;
  }

  return { personIds: row.personIds };
}
