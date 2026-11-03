import { createHash } from "node:crypto";

import { db, Prisma } from "./client";
import { decodeContentRow } from "./content-storage";

// Read projection of the existing table: Date decoding would discard microseconds.
type RevisionSegment = {
  id: string;
  speakerUserId: string | null;
  speakerName: string;
  speakerRole: string;
  content: string;
  startedAt: string;
};

function segmentPayload(input: { segment: RevisionSegment; startedAt: string }): string {
  const { segment, startedAt } = input;

  return `[${[segment.id, segment.speakerUserId, segment.speakerName, segment.speakerRole, segment.content, startedAt]
    .map((value) => JSON.stringify(value))
    .join(", ")}]`;
}

export async function revisionsByMeeting(input: {
  meetingIds: string[];
  sources: {
    meetingId: string | null;
    revision: string;
  }[];
}): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(input.meetingIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }
  const rows = await db.$queryRaw<
    {
      meetingId: string;
      id: string;
      speakerUserId: string | null;
      speakerName: string;
      speakerRole: string;
      content: string;
      startedAt: string;
    }[]
  >`
    SELECT
      t.meeting_id AS "meetingId",
      s.id,
      s.speaker_user_id AS "speakerUserId",
      s.speaker_name AS "speakerName",
      s.speaker_role AS "speakerRole",
      s.content,
      s.started_at::text AS "startedAt"
    FROM transcripts t
    INNER JOIN transcript_segments s ON s.transcript_id = t.id
    WHERE t.meeting_id IN (${Prisma.join(uniqueIds.map((meetingId) => Prisma.sql`CAST(${meetingId} AS uuid)`))})
    ORDER BY s.started_at ASC, s.id ASC
  `;
  const decoded = await decodeContentRow({ model: "transcriptSegments", value: rows });
  const segments = decoded.map((row) => ({
    meetingId: row.meetingId,
    segment: {
      id: row.id,
      speakerUserId: row.speakerUserId,
      speakerName: row.speakerName,
      speakerRole: row.speakerRole,
      content: row.content,
      startedAt: row.startedAt,
    },
  }));
  const hashes = new Map(uniqueIds.map((meetingId) => [meetingId, createHash("md5")]));
  segments.forEach(({ meetingId, segment }) => {
    // Match PostgreSQL jsonb_build_array(..., started_at)::text, including its UTC offset.
    const fraction = segment.startedAt.match(/\.\d+/u)?.[0] ?? "";
    const startedAt = new Date(segment.startedAt).toISOString().replace(/\.\d{3}Z$/u, `${fraction}+00:00`);
    hashes.get(meetingId)?.update(segmentPayload({ segment, startedAt }));
  });

  const revisions = new Map([...hashes].map(([meetingId, hash]) => [meetingId, hash.digest("hex")]));
  const previousHashes = new Map(
    input.sources.flatMap((source) =>
      source.meetingId !== null &&
      revisions.has(source.meetingId) &&
      revisions.get(source.meetingId) !== source.revision
        ? [[source.meetingId, createHash("md5")] as const]
        : [],
    ),
  );
  // Reproduce the short-lived formatter only to validate already-saved revisions.
  segments
    .filter(({ meetingId }) => previousHashes.has(meetingId))
    .sort((left, right) => {
      const time = new Date(left.segment.startedAt).getTime() - new Date(right.segment.startedAt).getTime();
      if (time !== 0) {
        return time;
      }

      return left.segment.id < right.segment.id ? -1 : left.segment.id > right.segment.id ? 1 : 0;
    })
    .forEach(({ meetingId, segment }) => {
      const startedAt = new Date(segment.startedAt)
        .toISOString()
        .replace("T", " ")
        .replace(/\.000Z$/u, "+00")
        .replace(/(\.\d*?[1-9])0*Z$/u, "$1+00");
      previousHashes.get(meetingId)?.update(segmentPayload({ segment, startedAt }));
    });
  const previous = new Map([...previousHashes].map(([meetingId, hash]) => [meetingId, hash.digest("hex")]));
  input.sources.forEach((source) => {
    if (source.meetingId !== null && previous.get(source.meetingId) === source.revision) {
      revisions.set(source.meetingId, source.revision);
    }
  });

  return revisions;
}
