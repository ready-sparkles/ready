// Synthetic fixtures only. Callers must opt in to an isolated test database.
import { randomUUID } from "node:crypto";

import { db } from "../adapters/secondary/postgres/client";
import { recordMeetingAttendeeWorkspace } from "../adapters/secondary/postgres/meeting-attendee-workspace";
import {
  enqueueMemorySource,
  getMemoryPreferences,
  listAccessibleMemorySources,
  listEligibleMemoryMeetings,
  prepareMemoryInput,
} from "../adapters/secondary/postgres/relationship-memory";

const MEMORY_ISOLATED_DB_REQUIRED_MESSAGE = "Isolated memory fixture required";
const MEMORY_FIXTURE_MEETING_DURATION_HOURS = 60;
const MS_PER_MINUTE = 60_000;
const MEMORY_FIXTURE_MEETING_DURATION_MS = MEMORY_FIXTURE_MEETING_DURATION_HOURS * MS_PER_MINUTE;
const MEMORY_FIXTURE_IMPORTANCE_LEVEL = 4;
const FIXTURE_PROPOSAL_SUMMARY_TEXT = "Your peer offered a proposal.";

async function enqueueMemoryFixtureSource(input: {
  scope: { userId: string; workspaceId: string };
  meetingId: string;
}) {
  const prefs = await getMemoryPreferences(input.scope);
  const eligibleMeetings = await listEligibleMemoryMeetings({ scope: input.scope, meetingId: input.meetingId });
  const source = eligibleMeetings[0];
  if (source === undefined) {
    throw new TypeError(String(eligibleMeetings.length));
  }
  const job = await enqueueMemorySource({ scope: input.scope, meeting: source, preferencesRevision: prefs.revision });
  const saved = (await listAccessibleMemorySources(input.scope)).find((s) => s.meetingId === input.meetingId);

  return {
    job,
    prefs,
    source: saved,
    input:
      saved !== undefined ? await prepareMemoryInput({ scope: input.scope, source: saved, preferences: prefs }) : null,
  };
}

async function insertMemoryFixtureDatabase(input: {
  userId: string;
  peer: string;
  workspaceId: string;
  hostWorkspace: string;
  meetingId: string;
  transcriptId: string;
  segmentId: string;
  endedAt: string;
  startedAt: string;
  isGuest?: boolean;
  isExternal?: boolean;
}): Promise<void> {
  const { userId, peer, workspaceId, hostWorkspace, meetingId, transcriptId, segmentId, endedAt, startedAt } = input;
  const started = new Date(startedAt);
  const ended = new Date(endedAt);
  await db.users.createMany({
    data: [userId, peer].map((id) => ({
      id,
      email: `${id}@memory-fixture.test`,
      displayName: "Fixture",
      plan: "business" as const,
      privateBetaProEnabledAt: new Date(),
      source: id === userId && input.isGuest === true ? ("guest" as const) : ("auth" as const),
    })),
  });
  await db.workspaces.createMany({
    data: [
      { id: workspaceId, name: "Attendee", createdByUserId: userId },
      ...(input.isExternal === true ? [{ id: hostWorkspace, name: "Host", createdByUserId: peer }] : []),
    ],
  });
  await db.workspaceMemberships.createMany({
    data: [
      { userId, workspaceId, role: "owner" as const },
      {
        userId: peer,
        workspaceId: hostWorkspace,
        role: input.isExternal === true ? ("owner" as const) : ("member" as const),
      },
    ],
  });
  await db.users.updateMany({ where: { id: userId }, data: { activeWorkspaceId: workspaceId } });
  await db.meetings.create({
    data: {
      id: meetingId,
      title: "Fixture",
      roomName: meetingId,
      workspaceId: hostWorkspace,
      createdByUserId: peer,
      status: "active",
      startedAt: started,
    },
  });
  if (!(input.isGuest ?? false)) {
    await recordMeetingAttendeeWorkspace({ meetingId, userId, workspaceId });
  }
  await db.meetingParticipants.createMany({
    data: [userId, peer].map((id) => ({
      meetingId,
      userId: id,
      joinedAt: started,
      leftAt: ended,
    })),
  });
  await db.meetingAttendanceIntervals.createMany({
    data: [userId, peer].map((id) => ({
      meetingId,
      userId: id,
      joinedAt: started,
      leftAt: ended,
    })),
  });
  await db.transcripts.create({ data: { id: transcriptId, meetingId } });
  await db.transcriptSegments.create({
    data: {
      id: segmentId,
      transcriptId,
      speakerIdentity: peer,
      speakerUserId: peer,
      speakerName: "Peer",
      content: "I will send you the proposal.",
      startedAt: started,
    },
  });
  await db.transcripts.updateMany({ where: { id: transcriptId }, data: { metadata: { finalizedAt: "fixture" } } });
  await db.meetings.updateMany({ where: { id: meetingId }, data: { status: "ended", endedAt: ended } });
}

export async function memoryFixture(
  options: {
    endedAt?: string;
    /** @external memory fixture options */
    external?: boolean;
    /** @external memory fixture options */
    guest?: boolean;
  } = {},
): Promise<{
  scope: { userId: string; workspaceId: string };
  userId: string;
  peer: string;
  workspaceId: string;
  hostWorkspace: string;
  meetingId: string;
  transcriptId: string;
  segmentId: string;
  enqueue: () => Promise<{
    job: Awaited<ReturnType<typeof enqueueMemorySource>>;
    prefs: Awaited<ReturnType<typeof getMemoryPreferences>>;
    source: Awaited<ReturnType<typeof listAccessibleMemorySources>>[number] | undefined;
    input: Awaited<ReturnType<typeof prepareMemoryInput>> | null;
  }>;
  cleanup: () => Promise<void>;
}> {
  if (process.env.MEMORY_ISOLATED_DB !== "1") {
    throw new Error(MEMORY_ISOLATED_DB_REQUIRED_MESSAGE);
  }
  const userId = randomUUID(),
    peer = randomUUID(),
    workspaceId = randomUUID(),
    hostWorkspace = options.external === true ? randomUUID() : workspaceId,
    meetingId = randomUUID(),
    transcriptId = randomUUID(),
    segmentId = randomUUID();
  const endedAt = options.endedAt ?? new Date().toISOString();
  const startedAt = new Date(Date.parse(endedAt) - MEMORY_FIXTURE_MEETING_DURATION_MS).toISOString();
  const scope = { userId, workspaceId };
  await insertMemoryFixtureDatabase({
    userId,
    peer,
    workspaceId,
    hostWorkspace,
    meetingId,
    transcriptId,
    segmentId,
    endedAt,
    startedAt,
    isGuest: options.guest,
    isExternal: options.external,
  });

  return {
    scope,
    userId,
    peer,
    workspaceId,
    hostWorkspace,
    meetingId,
    transcriptId,
    segmentId,
    enqueue: () => enqueueMemoryFixtureSource({ scope, meetingId }),
    async cleanup() {
      await db.meetings.deleteMany({ where: { id: meetingId } });
      await db.workspaces.deleteMany({ where: { id: { in: [...new Set([workspaceId, hostWorkspace])] } } });
      await db.users.deleteMany({ where: { id: { in: [userId, peer] } } });
    },
  };
}
function requireFixtureSegment(
  segments: NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof memoryFixture>>["enqueue"]>>["input"]>["segments"],
) {
  const segment = segments[0];
  if (segment === undefined) {
    throw new TypeError(String(segments.length));
  }

  return segment;
}

export function fixtureGeneration(
  input: NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof memoryFixture>>["enqueue"]>>["input"]>,
): {
  memories: {
    ref: string;
    title: string;
    description: string;
    category: "Sales";
    personIds: string[];
    candidateSubjectId: null;
    candidateSubjectKey: null;
    /** @external memory generation fixture */
    sensitive: boolean;
    confidence: "high";
    importance: typeof MEMORY_FIXTURE_IMPORTANCE_LEVEL;
    factIdentity: {
      subject: string;
      predicate: string;
      object: string;
      context: string;
    };
    existingFactKey: null;
    evidence: { segmentId: string; quote: string }[];
  }[];
  people: { personId: string; summary: { text: string; memoryRefs: string[] }[]; standing: [] }[];
} {
  const person = input.people.find((p) => p.userId !== input.ownerUserId);
  if (person === undefined) {
    throw new TypeError(String(input.people.length));
  }
  const segment = requireFixtureSegment(input.segments);

  return {
    memories: [
      {
        ref: "N1",
        title: "Your peer offered a proposal",
        description: "They offered to send you a proposal.",
        category: "Sales" as const,
        personIds: [person.id],
        candidateSubjectId: null,
        candidateSubjectKey: null,
        /** @external memory generation fixture */
        sensitive: false,
        confidence: "high" as const,
        importance: MEMORY_FIXTURE_IMPORTANCE_LEVEL,
        factIdentity: {
          subject: person.id,
          predicate: "offered owner",
          object: "proposal",
          context: "",
        },
        existingFactKey: null,
        evidence: [{ segmentId: segment.id, quote: segment.content }],
      },
    ],
    people: input.people.map((p) => ({
      personId: p.id,
      summary: [{ text: FIXTURE_PROPOSAL_SUMMARY_TEXT, memoryRefs: ["N1"] }],
      standing: [],
    })),
  };
}
