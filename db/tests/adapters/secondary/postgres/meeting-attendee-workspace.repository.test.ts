import type { MemoryCandidate } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import {
  activateMeetingAttendeeWorkspace,
  recordMeetingAttendeeWorkspace,
} from "../../../../adapters/secondary/postgres/meeting-attendee-workspace";
import {
  actOnMemories,
  enqueueMemorySource,
  finishMemoryJob,
  getMemoryPreferences,
  listAccessibleMemorySources,
  listEligibleMemoryMeetings,
  persistMemoryExtraction,
  prepareMemoryInput,
} from "../../../../adapters/secondary/postgres/relationship-memory";
import { transferGuestMeetingAccessToUser } from "../../../../adapters/secondary/postgres/repositories";
import { listWorkspaceVisibleMeetingsForUser } from "../../../../adapters/secondary/postgres/workspace-admin";

const PG_FOREIGN_KEY_VIOLATION = "23503";
const PROPOSAL_IMPORTANCE = 4;
const MINUTE_MS = 60_000;
const MEETING_START_MINUTES = 60;
const PARTICIPANT_JOIN_MINUTES = 30;
const SEGMENT_START_MINUTES = 10;
const MISSING_REQUIRED_VALUE = "Expected a value.";
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error(MISSING_REQUIRED_VALUE);
  }

  return value;
};

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * MINUTE_MS);

const hasPostgresCode = (input: { error: unknown; code: string }): boolean => {
  const seen = new Set<unknown>();
  const walk = (current: unknown): boolean => {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);
    const read = (key: string): unknown =>
      Object.prototype.hasOwnProperty.call(current, key)
        ? Object.getOwnPropertyDescriptor(current, key)?.value
        : undefined;
    if (read("code") === input.code || read("originalCode") === input.code) {
      return true;
    }

    return Object.values(current).some((value) => walk(value));
  };

  return walk(input.error);
};

const counted = async (count: Promise<number>): Promise<number> => count;

const deleteIds = async (input: { table: "meetings" | "workspaces" | "users"; ids: string[] }): Promise<void> => {
  if (input.ids.length === 0) {
    return;
  }
  if (input.table === "meetings") {
    await db.meetings.deleteMany({ where: { id: { in: input.ids } } });

    return;
  }
  if (input.table === "workspaces") {
    await db.workspaces.deleteMany({ where: { id: { in: input.ids } } });

    return;
  }
  await db.users.deleteMany({ where: { id: { in: input.ids } } });
};

after(closeDbPool);

void test(
  "joining activates only an active shared host workspace and preserves durable filing",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const userId = randomUUID(),
      hostId = randomUUID();
    const personal = randomUUID(),
      shared = randomUUID(),
      meetingId = randomUUID();
    const active = async (): Promise<string> => {
      const [row] = await db.users.findMany({
        where: { id: userId },
        select: { /** @external Prisma field */ activeWorkspaceId: true },
      });

      return required(row?.activeWorkspaceId);
    };
    try {
      await db.users.createMany({
        data: [userId, hostId].map((id) => ({
          id,
          email: `${id}@join.test`,
          displayName: "Fixture",
          source: "auth" as const,
        })),
      });
      await db.workspaces.createMany({
        data: [
          { id: personal, name: "Personal", createdByUserId: userId },
          { id: shared, name: "Shared", createdByUserId: hostId },
        ],
      });
      await db.workspaceMemberships.createMany({
        data: [
          { userId, workspaceId: personal, role: "owner" },
          { userId: hostId, workspaceId: shared, role: "owner" },
        ],
      });
      await db.users.updateMany({ where: { id: userId }, data: { activeWorkspaceId: personal } });
      await db.meetings.create({
        data: {
          id: meetingId,
          title: "Fixture",
          roomName: meetingId,
          workspaceId: shared,
          createdByUserId: hostId,
          status: "active",
        },
      });
      await recordMeetingAttendeeWorkspace({ meetingId, userId, workspaceId: personal });
      assert.equal(await activateMeetingAttendeeWorkspace({ meetingId, userId }), null);
      assert.equal(await active(), personal, "external meetings retain the active workspace");
      await db.workspaceMemberships.create({ data: { userId, workspaceId: shared, role: "member" } });
      assert.equal(
        await activateMeetingAttendeeWorkspace({ meetingId, userId }),
        null,
        "later membership does not move an existing filing",
      );
      await db.meetingAttendeeWorkspaces.deleteMany({ where: { meetingId } });
      await recordMeetingAttendeeWorkspace({ meetingId, userId, workspaceId: personal });
      assert.equal(await active(), personal, "token issuance alone does not switch workspace");
      assert.equal(await activateMeetingAttendeeWorkspace({ meetingId, userId }), shared);
      assert.equal(await active(), shared);
      assert.equal(await activateMeetingAttendeeWorkspace({ meetingId, userId }), shared, "retries are idempotent");
      await db.users.updateMany({ where: { id: userId }, data: { activeWorkspaceId: personal } });
      await db.workspaceMemberships.updateMany({
        where: { userId, workspaceId: shared },
        data: { status: "suspended" },
      });
      assert.equal(await activateMeetingAttendeeWorkspace({ meetingId, userId }), null);
      assert.equal(await active(), personal);
      await db.workspaceMemberships.updateMany({
        where: { userId, workspaceId: shared },
        data: { status: "active" },
      });
      await db.meetings.updateMany({ where: { id: meetingId }, data: { status: "ended", endedAt: new Date() } });
      assert.equal(await activateMeetingAttendeeWorkspace({ meetingId, userId }), null);
    } finally {
      await deleteIds({ table: "meetings", ids: [meetingId] });
      await deleteIds({ table: "workspaces", ids: [personal, shared] });
      await deleteIds({ table: "users", ids: [userId, hostId] });
    }
  },
);

const isMeetingVisible = async ({
  userId,
  workspaceId,
  meetingId,
}: {
  userId: string;
  workspaceId: string;
  meetingId: string;
}): Promise<boolean> =>
  (await listWorkspaceVisibleMeetingsForUser({ userId, workspaceIds: [workspaceId] })).some(
    (meeting) => meeting.id === meetingId,
  );

const createAttendeeMeeting = async ({
  workspaceId,
  createdByUserId,
  onCreated,
}: {
  workspaceId: string;
  createdByUserId: string;
  onCreated: (meetingId: string) => void;
}): Promise<string> => {
  const meetingId = randomUUID();
  onCreated(meetingId);
  await db.meetings.create({
    data: {
      id: meetingId,
      title: "Fixture",
      roomName: meetingId,
      workspaceId,
      createdByUserId,
      status: "active",
      isConfidential: true,
      startedAt: minutesAgo(MEETING_START_MINUTES),
    },
  });

  return meetingId;
};

const endAttendeeMeeting = async ({
  meetingId,
  ownerId,
  hostId,
}: {
  meetingId: string;
  ownerId: string;
  hostId: string;
}): Promise<void> => {
  const joinedAt = minutesAgo(PARTICIPANT_JOIN_MINUTES);
  await db.meetingParticipants.createMany({
    data: [ownerId, hostId].map((userId) => ({
      meetingId,
      userId,
      joinedAt,
    })),
  });
  await db.meetings.updateMany({ where: { id: meetingId }, data: { status: "ended", endedAt: new Date() } });
  const transcriptId = randomUUID();
  await db.transcripts.create({
    data: {
      id: transcriptId,
      meetingId,
      metadata: { finalizedAt: "2026-09-01" },
    },
  });
  await db.transcriptSegments.create({
    data: {
      transcriptId,
      speakerIdentity: hostId,
      speakerUserId: hostId,
      speakerName: "Peer",
      content: "I will send you the proposal.",
      startedAt: minutesAgo(SEGMENT_START_MINUTES),
    },
  });
};

type FiledMemoryCandidate = MemoryCandidate;

const fileExternalMeetingMemory = async ({
  ownerId,
  hostId,
  colleagueId,
  readyWorkspaceId,
  familyWorkspaceId,
  externalWorkspaceId,
  scope,
  onCreated,
}: {
  ownerId: string;
  hostId: string;
  colleagueId: string;
  readyWorkspaceId: string;
  familyWorkspaceId: string;
  externalWorkspaceId: string;
  scope: Parameters<typeof getMemoryPreferences>[0];
  onCreated: (meetingId: string) => void;
}): Promise<{ meetingId: string; savedId: string; personId: string; candidate: FiledMemoryCandidate }> => {
  const meetingId = await createAttendeeMeeting({
    workspaceId: externalWorkspaceId,
    createdByUserId: hostId,
    onCreated,
  });
  await assert.rejects(
    () => recordMeetingAttendeeWorkspace({ meetingId, userId: ownerId, workspaceId: externalWorkspaceId }),
    (error: unknown) => hasPostgresCode({ error, code: PG_FOREIGN_KEY_VIOLATION }),
  );
  await recordMeetingAttendeeWorkspace({ meetingId, ...scope });
  await db.users.updateMany({ where: { id: ownerId }, data: { activeWorkspaceId: familyWorkspaceId } });
  await recordMeetingAttendeeWorkspace({ meetingId, userId: ownerId, workspaceId: familyWorkspaceId });
  await endAttendeeMeeting({ meetingId, ownerId, hostId });
  assert.equal(await isMeetingVisible({ userId: ownerId, workspaceId: readyWorkspaceId, meetingId }), true);
  assert.equal(await isMeetingVisible({ userId: ownerId, workspaceId: familyWorkspaceId, meetingId }), false);
  assert.equal(await isMeetingVisible({ userId: colleagueId, workspaceId: readyWorkspaceId, meetingId }), false);
  await db.meetings.updateMany({ where: { id: meetingId }, data: { isConfidential: false } });
  assert.equal(
    await isMeetingVisible({ userId: colleagueId, workspaceId: readyWorkspaceId, meetingId }),
    false,
    "private filing never shares host meeting with colleagues",
  );
  assert.deepEqual(
    (await listEligibleMemoryMeetings({ scope, meetingId })).map((meeting) => meeting.meetingId),
    [meetingId],
  );
  assert.deepEqual(
    await listEligibleMemoryMeetings({ scope: { userId: ownerId, workspaceId: familyWorkspaceId }, meetingId }),
    [],
  );
  const source = required((await listEligibleMemoryMeetings({ scope, meetingId }))[0]);
  assert.equal(source.workspaceId, readyWorkspaceId);
  assert.equal(source.meetingWorkspaceId, externalWorkspaceId, "notes entitlement must still use the host workspace");
  const prefs = await getMemoryPreferences(scope);
  const job = required(await enqueueMemorySource({ scope, meeting: source, preferencesRevision: prefs.revision }));
  assert.equal(await enqueueMemorySource({ scope, meeting: source, preferencesRevision: prefs.revision }), null);
  assert.equal(job.userId, ownerId);
  const saved = required((await listAccessibleMemorySources(scope))[0]);
  const input = await prepareMemoryInput({ scope, source: saved, preferences: prefs });
  const personId = required(input.people[0]).id;
  const evidenceSegment = required(input.segments[0]);
  const candidate: FiledMemoryCandidate = {
    title: "Your peer offered a proposal",
    description: "They offered to send you a proposal.",
    category: "Sales",
    personIds: [personId],
    candidateSubjectId: null,
    candidateSubjectKey: null,
    /** @external existing memory candidate field */
    sensitive: false,
    confidence: "high",
    importance: PROPOSAL_IMPORTANCE,
    factIdentity: { subject: hostId, predicate: "offered", object: "proposal", context: "" },
    existingFactKey: null,
    evidence: [{ segmentId: evidenceSegment.id, quote: evidenceSegment.content }],
  };
  await persistMemoryExtraction({ job, source: saved, candidates: [candidate], model: "fixture" });
  await finishMemoryJob({ job });
  assert.equal(await enqueueMemorySource({ scope, meeting: source, preferencesRevision: prefs.revision }), null);
  await assert.rejects(
    () =>
      db.memorySources.create({
        data: {
          userId: ownerId,
          workspaceId: familyWorkspaceId,
          kind: "meeting_transcript",
          externalId: meetingId,
          meetingId,
          occurredAt: new Date(),
          revision: "wrong",
        },
      }),
    (error: unknown) => hasPostgresCode({ error, code: PG_FOREIGN_KEY_VIOLATION }),
  );
  assert.deepEqual(await listAccessibleMemorySources({ userId: colleagueId, workspaceId: readyWorkspaceId }), []);

  return { meetingId, savedId: saved.id, personId, candidate };
};

const fileSeparateFamilyMemory = async ({
  ownerId,
  hostId,
  externalWorkspaceId,
  familyWorkspaceId,
  savedId,
  personId,
  candidate,
  onCreated,
}: {
  ownerId: string;
  hostId: string;
  externalWorkspaceId: string;
  familyWorkspaceId: string;
  savedId: string;
  personId: string;
  candidate: FiledMemoryCandidate;
  onCreated: (meetingId: string) => void;
}): Promise<void> => {
  const familyMeetingId = await createAttendeeMeeting({
    workspaceId: externalWorkspaceId,
    createdByUserId: hostId,
    onCreated,
  });
  await recordMeetingAttendeeWorkspace({
    meetingId: familyMeetingId,
    userId: ownerId,
    workspaceId: familyWorkspaceId,
  });
  await endAttendeeMeeting({ meetingId: familyMeetingId, ownerId, hostId });
  const familyScope = { userId: ownerId, workspaceId: familyWorkspaceId };
  const familySource = required(
    (await listEligibleMemoryMeetings({ scope: familyScope, meetingId: familyMeetingId }))[0],
  );
  const familyPrefs = await getMemoryPreferences(familyScope);
  const familyJob = required(
    await enqueueMemorySource({ scope: familyScope, meeting: familySource, preferencesRevision: familyPrefs.revision }),
  );
  const familySaved = required((await listAccessibleMemorySources(familyScope))[0]);
  const familyInput = await prepareMemoryInput({ scope: familyScope, source: familySaved, preferences: familyPrefs });
  assert.notEqual(required(familyInput.people[0]).id, personId, "same contact has separate cards in each workspace");
  const familyEvidence = required(familyInput.segments[0]);
  await persistMemoryExtraction({
    job: familyJob,
    source: familySaved,
    candidates: [
      {
        ...candidate,
        personIds: [required(familyInput.people[0]).id],
        evidence: [{ segmentId: familyEvidence.id, quote: familyEvidence.content }],
      },
    ],
    model: "fixture",
  });
  await finishMemoryJob({ job: familyJob });
  const [memory] = await db.relationshipMemories.findMany({
    where: { sourceId: savedId },
    select: { /** @external Prisma field */ id: true },
  });
  await actOnMemories({ sourceIds: [savedId], ids: [required(memory).id], action: "forget" });
  assert.equal(await counted(db.relationshipMemories.count({ where: { sourceId: familySaved.id } })), 1);
};

const assertMemberMeetingStaysHosted = async ({
  ownerId,
  meetingId,
  savedId,
  readyWorkspaceId,
  familyWorkspaceId,
  externalWorkspaceId,
  scope,
  onCreated,
}: {
  ownerId: string;
  meetingId: string;
  savedId: string;
  readyWorkspaceId: string;
  familyWorkspaceId: string;
  externalWorkspaceId: string;
  scope: Parameters<typeof getMemoryPreferences>[0];
  onCreated: (meetingId: string) => void;
}): Promise<void> => {
  const nativeMeetingId = await createAttendeeMeeting({
    workspaceId: familyWorkspaceId,
    createdByUserId: ownerId,
    onCreated,
  });
  await recordMeetingAttendeeWorkspace({
    meetingId: nativeMeetingId,
    userId: ownerId,
    workspaceId: readyWorkspaceId,
  });
  const [filing] = await db.meetingAttendeeWorkspaces.findMany({
    where: { meetingId: nativeMeetingId, userId: ownerId },
    select: { /** @external Prisma field */ workspaceId: true },
  });
  assert.equal(required(filing).workspaceId, familyWorkspaceId, "member meetings remain in the host workspace");
  await db.workspaceMemberships.create({
    data: {
      userId: ownerId,
      workspaceId: externalWorkspaceId,
      role: "member",
      status: "suspended",
    },
  });
  assert.equal(await isMeetingVisible({ userId: ownerId, workspaceId: readyWorkspaceId, meetingId }), false);
  assert.deepEqual(await listAccessibleMemorySources(scope), [], "host suspension revokes derived access");
  await db.workspaceMemberships.deleteMany({ where: { userId: ownerId, workspaceId: externalWorkspaceId } });
  await db.workspaceMemberships.updateMany({
    where: { userId: ownerId, workspaceId: readyWorkspaceId },
    data: { role: "member", status: "suspended" },
  });
  assert.deepEqual(await listAccessibleMemorySources(scope), [], "destination membership is required");
  await db.meetings.deleteMany({ where: { id: meetingId } });
  assert.equal(await counted(db.memorySources.count({ where: { id: savedId } })), 0);
};

void test(
  "external attendance belongs to the joining workspace for notes and private memory",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const owner = randomUUID(),
      host = randomUUID(),
      colleague = randomUUID();
    const ready = randomUUID(),
      family = randomUUID(),
      external = randomUUID();
    const tracked = { meetingIds: [] as string[] };
    const onCreated = (meetingId: string): void => {
      tracked.meetingIds = [...tracked.meetingIds, meetingId];
    };
    const scope = { userId: owner, workspaceId: ready };
    try {
      await db.users.createMany({
        data: [owner, host, colleague].map((id) => ({
          id,
          email: `${id}@attendee.test`,
          displayName: "Fixture",
        })),
      });
      await db.workspaces.createMany({
        data: [
          { id: ready, name: "Ready", createdByUserId: owner },
          { id: family, name: "Family", createdByUserId: owner },
          { id: external, name: "Host", createdByUserId: host },
        ],
      });
      await db.workspaceMemberships.createMany({
        data: [
          { userId: owner, workspaceId: ready, role: "owner" },
          { userId: owner, workspaceId: family, role: "owner" },
          { userId: host, workspaceId: external, role: "owner" },
          { userId: colleague, workspaceId: ready, role: "member" },
        ],
      });
      await db.users.updateMany({ where: { id: owner }, data: { activeWorkspaceId: ready } });
      const filed = await fileExternalMeetingMemory({
        ownerId: owner,
        hostId: host,
        colleagueId: colleague,
        readyWorkspaceId: ready,
        familyWorkspaceId: family,
        externalWorkspaceId: external,
        scope,
        onCreated,
      });
      await fileSeparateFamilyMemory({
        ownerId: owner,
        hostId: host,
        externalWorkspaceId: external,
        familyWorkspaceId: family,
        savedId: filed.savedId,
        personId: filed.personId,
        candidate: filed.candidate,
        onCreated,
      });
      await assertMemberMeetingStaysHosted({
        ownerId: owner,
        meetingId: filed.meetingId,
        savedId: filed.savedId,
        readyWorkspaceId: ready,
        familyWorkspaceId: family,
        externalWorkspaceId: external,
        scope,
        onCreated,
      });
    } finally {
      await deleteIds({ table: "meetings", ids: tracked.meetingIds });
      await deleteIds({ table: "workspaces", ids: [ready, family, external] });
      await deleteIds({ table: "users", ids: [owner, host, colleague] });
    }
  },
);

(["active", "ended"] as const).forEach((status) => {
  void test(
    `guest account linking files ${status} meeting in the session workspace when active workspace differs`,
    { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
    async () => {
      const owner = randomUUID(),
        host = randomUUID(),
        guest = randomUUID(),
        ready = randomUUID(),
        family = randomUUID(),
        external = randomUUID(),
        id = randomUUID();
      const startedAt = minutesAgo(MEETING_START_MINUTES);
      try {
        await db.users.createMany({
          data: [
            { id: owner, email: `${owner}@link.test`, displayName: "Owner", source: "auth" },
            { id: host, email: `${host}@link.test`, displayName: "Host", source: "auth" },
            { id: guest, email: `${guest}@link.test`, displayName: "Guest", source: "guest" },
          ],
        });
        await db.workspaces.createMany({
          data: [
            { id: ready, name: "Ready", createdByUserId: owner },
            { id: external, name: "Host", createdByUserId: host },
            { id: family, name: "Family", createdByUserId: owner },
          ],
        });
        await db.workspaceMemberships.createMany({
          data: [
            { userId: owner, workspaceId: ready, role: "owner" },
            { userId: host, workspaceId: external, role: "owner" },
            { userId: owner, workspaceId: family, role: "owner" },
          ],
        });
        await db.users.updateMany({ where: { id: owner }, data: { activeWorkspaceId: family } });
        await db.meetings.create({
          data: {
            id,
            title: "Guest fixture",
            roomName: id,
            workspaceId: external,
            createdByUserId: host,
            status,
            startedAt,
            endedAt: status === "ended" ? new Date() : null,
          },
        });
        await db.meetingParticipants.create({
          data: {
            meetingId: id,
            userId: guest,
            joinedAt: startedAt,
            leftAt: new Date(),
          },
        });
        await db.meetingAttendanceIntervals.create({
          data: {
            meetingId: id,
            userId: guest,
            joinedAt: startedAt,
            leftAt: new Date(),
          },
        });
        await transferGuestMeetingAccessToUser({
          guestUserId: guest,
          targetUserId: owner,
          targetWorkspaceId: ready,
        });
        const [filing] = await db.meetingAttendeeWorkspaces.findMany({
          where: { meetingId: id, userId: owner },
          select: { /** @external Prisma field */ workspaceId: true },
        });
        assert.equal(required(filing).workspaceId, ready);
        assert.equal(
          await counted(db.meetingAttendanceIntervals.count({ where: { meetingId: id, userId: owner } })),
          1,
        );
        await db.meetings.updateMany({ where: { id }, data: { status: "ended", endedAt: new Date() } });
        assert.ok(
          (await listWorkspaceVisibleMeetingsForUser({ userId: owner, workspaceIds: [ready] })).some(
            (meeting) => meeting.id === id,
          ),
        );
        assert.ok(
          !(await listWorkspaceVisibleMeetingsForUser({ userId: owner, workspaceIds: [family] })).some(
            (meeting) => meeting.id === id,
          ),
        );
      } finally {
        await deleteIds({ table: "meetings", ids: [id] });
        await deleteIds({ table: "workspaces", ids: [ready, family, external] });
        await deleteIds({ table: "users", ids: [owner, host, guest] });
      }
    },
  );
});
