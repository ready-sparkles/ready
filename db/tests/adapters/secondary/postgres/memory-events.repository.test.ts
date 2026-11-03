import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import { recordMeetingAttendeeWorkspace } from "../../../../adapters/secondary/postgres/meeting-attendee-workspace";
import {
  consumeMemoryGeneration,
  listMemoryMeetingAttendees,
} from "../../../../adapters/secondary/postgres/memory-events";
import {
  actOnMemories,
  buildConsolidatedMemoryProjection,
  enqueueMemorySource,
  getMemoryPreferences,
  listAccessibleMemorySources,
  listEligibleMemoryMeetings,
  listMemoryProjectionEvidence,
  listRelationshipMemories,
  persistMemoryExtraction,
  prepareMemoryInput,
  readMemoryProjection,
} from "../../../../adapters/secondary/postgres/relationship-memory";
import { transferGuestMeetingAccessToUser } from "../../../../adapters/secondary/postgres/repositories";
import { fixtureGeneration, memoryFixture } from "../../../memory-fixture";

const EXPECTED_TEST_COUNT_2 = 2;

const MISSING_REQUIRED_VALUE = "Expected a value.";
const MINUTE_MS = 60_000;
const FOLLOW_UP_START_MINUTES = 10;
const FOLLOW_UP_SEGMENT_MINUTES = 5;
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error(MISSING_REQUIRED_VALUE);
  }

  return value;
};

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * MINUTE_MS);

after(closeDbPool);
const isIsolated = process.env.MEMORY_ISOLATED_DB === "1";

(["meeting", "transcript"] as const).forEach((first) => {
  void test(
    `request discovery requires both meeting end and final transcript (${first} first)`,
    { skip: !isIsolated },
    async () => {
      const f = await memoryFixture();
      try {
        await db.meetings.updateMany({ where: { id: f.meetingId }, data: { status: "active", endedAt: null } });
        await db.transcripts.updateMany({
          where: { id: f.transcriptId },
          data: { metadata: {}, source: "livekit-python-live" },
        });
        const end = () =>
          db.meetings.updateMany({ where: { id: f.meetingId }, data: { status: "ended", endedAt: new Date() } });
        const finalize = () =>
          db.transcripts.updateMany({ where: { id: f.transcriptId }, data: { metadata: { finalizedAt: "fixture" } } });
        await (first === "meeting" ? end() : finalize());
        assert.deepEqual(await listMemoryMeetingAttendees(f.meetingId), []);
        await (first === "meeting" ? finalize() : end());
        assert.equal((await listMemoryMeetingAttendees(f.meetingId)).length, EXPECTED_TEST_COUNT_2);
        const request = await f.enqueue();
        assert.ok(request.job);
        assert.equal((await f.enqueue()).job, null);
      } finally {
        await f.cleanup();
      }
    },
  );
});

[false, true].forEach((isPast) => {
  void test(
    `guest linking ${isPast ? "pre" : "post"}-cutoff meeting never scans other history or resets another attendee`,
    { skip: !isIsolated },
    async () => {
      const f = await memoryFixture({
        /** @external existing memory fixture field */
        guest: true,
        /** @external existing memory fixture field */
        external: true,
        ...(isPast ? { endedAt: "2000-01-01T12:00:00Z" } : {}),
      });
      const target = randomUUID(),
        otherWorkspace = randomUUID();
      try {
        await db.users.create({
          data: {
            id: target,
            email: `${target}@memory-fixture.test`,
            displayName: "Linked",
            source: "auth",
            plan: "business",
            privateBetaProEnabledAt: new Date(),
          },
        });
        await db.workspaces.create({ data: { id: otherWorkspace, name: "Other", createdByUserId: target } });
        await db.workspaceMemberships.createMany({
          data: [
            { userId: target, workspaceId: f.workspaceId, role: "member" },
            { userId: target, workspaceId: otherWorkspace, role: "owner" },
          ],
        });
        await db.users.updateMany({ where: { id: target }, data: { activeWorkspaceId: otherWorkspace } });
        await transferGuestMeetingAccessToUser({
          guestUserId: f.userId,
          targetUserId: target,
          targetWorkspaceId: f.workspaceId,
        });
        await transferGuestMeetingAccessToUser({
          guestUserId: f.userId,
          targetUserId: target,
          targetWorkspaceId: otherWorkspace,
        });
        const rows = (await listMemoryMeetingAttendees(f.meetingId)).filter((scope) => scope.userId === target);
        assert.equal(rows.length, isPast ? 0 : 1);
        if (!isPast) {
          assert.deepEqual(rows, [{ userId: target, workspaceId: f.workspaceId }]);
          const scope = { userId: target, workspaceId: f.workspaceId };
          const preferences = await getMemoryPreferences(scope);
          const source = required((await listEligibleMemoryMeetings({ scope, meetingId: f.meetingId }))[0]);
          await enqueueMemorySource({ scope, meeting: source, preferencesRevision: preferences.revision });
          await enqueueMemorySource({ scope, meeting: source, preferencesRevision: preferences.revision });
          const targetLedger = await db.memoryGenerationLedger.count({ where: { userId: target } });
          const peerLedger = await db.memoryGenerationLedger.count({ where: { userId: f.peer } });
          assert.equal(targetLedger, 1);
          assert.equal(peerLedger, 0);
        }
      } finally {
        await f.cleanup();
        await db.workspaces.deleteMany({ where: { id: otherWorkspace } });
        await db.users.deleteMany({ where: { id: target } });
      }
    },
  );
});

void test("changed revision and revoked workspace fail closed before dispatch", { skip: !isIsolated }, async () => {
  const f = await memoryFixture();
  try {
    const job = required((await f.enqueue()).job);
    const auth = {
      jobId: job.id,
      leaseToken: job.leaseToken,
      ownerUserId: f.userId,
      meetingId: f.meetingId,
    };
    const [segment] = await db.transcriptSegments.findMany({
      where: { id: f.segmentId },
      select: { /** @external Prisma field */ content: true },
    });
    await db.transcriptSegments.updateMany({
      where: { id: f.segmentId },
      data: { content: `${required(segment).content} changed` },
    });
    await assert.rejects(() => consumeMemoryGeneration(auth));
    await db.transcriptSegments.updateMany({
      where: { id: f.segmentId },
      data: { content: "I will send you the proposal." },
    });
    await db.workspaceMemberships.updateMany({
      where: { userId: f.userId, workspaceId: f.workspaceId },
      data: { status: "suspended", role: "member" },
    });
    await assert.rejects(() => consumeMemoryGeneration(auth));
    await db.workspaceMemberships.updateMany({
      where: { userId: f.userId, workspaceId: f.workspaceId },
      data: { status: "active", role: "owner" },
    });
    const [ledger] = await db.memoryGenerationLedger.findMany({
      where: { jobId: job.id },
      select: { /** @external Prisma field */ modelStartedAt: true },
    });
    assert.equal(ledger?.modelStartedAt ?? null, null);
  } finally {
    await f.cleanup();
  }
});

type MemoryProjection = Awaited<ReturnType<typeof readMemoryProjection>>;
type MemoryFixture = Awaited<ReturnType<typeof memoryFixture>>;

const insertFollowUpMeeting = async ({
  fixture,
  onCreated,
}: {
  fixture: MemoryFixture;
  onCreated: (meetingId: string) => void;
}): Promise<{ meetingId: string; transcriptId: string }> => {
  const meetingId = randomUUID();
  const transcriptId = randomUUID();
  const startedAt = minutesAgo(FOLLOW_UP_START_MINUTES);
  onCreated(meetingId);
  await db.meetings.create({
    data: {
      id: meetingId,
      title: "Next",
      roomName: meetingId,
      workspaceId: fixture.workspaceId,
      createdByUserId: fixture.peer,
      status: "active",
      startedAt,
    },
  });
  await recordMeetingAttendeeWorkspace({ meetingId, ...fixture.scope });
  await db.meetingParticipants.createMany({
    data: [fixture.userId, fixture.peer].map((userId) => ({
      meetingId,
      userId,
      joinedAt: startedAt,
      leftAt: new Date(),
    })),
  });
  await db.meetingAttendanceIntervals.createMany({
    data: [fixture.userId, fixture.peer].map((userId) => ({
      meetingId,
      userId,
      joinedAt: startedAt,
      leftAt: new Date(),
    })),
  });
  await db.transcripts.create({ data: { id: transcriptId, meetingId } });
  await db.transcriptSegments.create({
    data: {
      transcriptId,
      speakerIdentity: fixture.peer,
      speakerUserId: fixture.peer,
      speakerName: "Peer",
      content: "I will send you an updated proposal.",
      startedAt: minutesAgo(FOLLOW_UP_SEGMENT_MINUTES),
    },
  });
  await db.transcripts.updateMany({ where: { id: transcriptId }, data: { metadata: { finalizedAt: "fixture" } } });
  await db.meetings.updateMany({ where: { id: meetingId }, data: { status: "ended", endedAt: new Date() } });

  return { meetingId, transcriptId };
};

const assertUncitedProjection = async ({
  personId,
  sourceIds,
  sources,
  sourceId,
  transcriptId,
}: {
  personId: string;
  sourceIds: string[];
  sources: { id: string; revision: string | number }[];
  sourceId: string;
  transcriptId: string;
}): Promise<void> => {
  const [stored] = await db.memoryPersonProjections.findMany({
    where: { personId },
    select: { /** @external Prisma field */ sourceRevisions: true },
  });
  assert.deepEqual(stored?.sourceRevisions, Object.fromEntries(sources.map((source) => [source.id, source.revision])));
  const [source] = await db.memorySources.findMany({
    where: { id: sourceId },
    select: { /** @external Prisma field */ revision: true },
  });
  assert.equal(typeof source?.revision, "string");
  assert.equal(
    await readMemoryProjection({
      personId,
      sourceIds: sourceIds.filter((id) => id !== sourceId),
    }),
    null,
    "revoking an uncited generation source hides the summary",
  );
  const [segment] = await db.transcriptSegments.findMany({
    where: { transcriptId },
    select: { /** @external Prisma field */ id: true, /** @external Prisma field */ content: true },
  });
  const savedSegment = required(segment);
  await db.transcriptSegments.updateMany({
    where: { id: savedSegment.id },
    data: { content: `${savedSegment.content} Changed.` },
  });
  assert.equal(
    await readMemoryProjection({ personId, sourceIds }),
    null,
    "editing an uncited generation source hides the summary",
  );
};

const UPDATED_PROPOSAL_SUMMARY = "Your peer offered an updated proposal.";
const DISCARDED_SUMMARY = "Must not replace saved summary";

function buildProjectionHistory(input: {
  meetingId: string;
  personId: string;
  evidence: Awaited<ReturnType<typeof listMemoryProjectionEvidence>>;
}): {
  meetingId: string;
  personId: string;
  name: string;
  language: string;
  memories: { id: string; title: string; description: string; occurredAt: string }[];
}[] {
  return [
    {
      meetingId: input.meetingId,
      personId: input.personId,
      name: "Peer",
      language: "English",
      memories: input.evidence.map(({ id, title, description, occurredAt }) => ({
        id,
        title,
        description,
        occurredAt,
      })),
    },
  ];
}

const runProjectionMode = async ({
  fixture,
  personId,
  mode,
  previous,
  onCreated,
}: {
  fixture: MemoryFixture;
  personId: string;
  mode: "refresh" | "forget" | "uncited";
  previous: MemoryProjection;
  onCreated: (meetingId: string) => void;
}): Promise<MemoryProjection> => {
  const isForgetDuring = mode === "forget";
  const { meetingId, transcriptId } = await insertFollowUpMeeting({ fixture, onCreated });
  const prefs = await getMemoryPreferences(fixture.scope);
  const requestedJob = await enqueueMemorySource({
    scope: fixture.scope,
    meeting: required((await listEligibleMemoryMeetings({ scope: fixture.scope, meetingId }))[0]),
    preferencesRevision: prefs.revision,
  });
  const sources = await listAccessibleMemorySources(fixture.scope);
  const source = required(sources.find((item) => item.meetingId === meetingId));
  const sourceIds = sources.map((item) => item.id);
  const input = await prepareMemoryInput({ scope: fixture.scope, source, preferences: prefs });
  const job = required(requestedJob);
  const value = fixtureGeneration(input);
  const evidence = await listMemoryProjectionEvidence({
    sourceIds: sourceIds.filter((id) => id !== source.id),
    personIds: [personId],
  });
  const history = buildProjectionHistory({ meetingId, personId, evidence });
  required(value.people[0]).summary = [
    {
      text: isForgetDuring ? DISCARDED_SUMMARY : UPDATED_PROPOSAL_SUMMARY,
      memoryRefs: ["N1", required(evidence[0]).id],
    },
  ];
  if (mode === "uncited") {
    value.memories = [];
    required(required(value.people[0]).summary[0]).memoryRefs = [required(evidence[0]).id];
  }
  await consumeMemoryGeneration({
    jobId: job.id,
    leaseToken: job.leaseToken,
    ownerUserId: fixture.userId,
    meetingId,
    historyMemoryIds: evidence.map((memory) => memory.id),
  });
  if (isForgetDuring) {
    await actOnMemories({ sourceIds, ids: [required(evidence[0]).id], action: "forget" });
  }
  await persistMemoryExtraction({
    job,
    source,
    candidates: value.memories,
    model: "fixture",
    generation: {
      value,
      history,
      sourceIds,
      inputSources: sources,
      language: "English",
    },
  });
  const next = await readMemoryProjection({ personId, sourceIds });
  if (isForgetDuring) {
    // The racing generation is discarded, and saved lines that cite the forgotten memory are removed too.
    const forgottenId = required(evidence[0]).id;
    const saved = required(previous);
    const remaining = {
      summary: saved.summary.filter((entry) => !entry.memoryIds.includes(forgottenId)),
      standing: saved.standing.filter((entry) => !entry.memoryIds.includes(forgottenId)),
    };
    assert.deepEqual(next, remaining.summary.length === 0 && remaining.standing.length === 0 ? null : remaining);
    assert.equal(
      (await listRelationshipMemories({ sourceIds })).some((memory) => memory.id === required(evidence[0]).id),
      false,
    );
    assert.equal(
      await enqueueMemorySource({ scope: fixture.scope, meeting: source, preferencesRevision: prefs.revision }),
      null,
    );

    return previous;
  }
  assert.equal(required(required(next).summary[0]).text, UPDATED_PROPOSAL_SUMMARY);
  if (mode === "uncited") {
    await assertUncitedProjection({
      personId,
      sourceIds,
      sources,
      sourceId: source.id,
      transcriptId,
    });
  }
  assert.equal(
    await enqueueMemorySource({ scope: fixture.scope, meeting: source, preferencesRevision: prefs.revision }),
    null,
  );

  return next;
};

async function storePreviousMemoryRevision(input: {
  fixture: MemoryFixture;
  sourceId: string;
  jobId: string;
  personId: string;
}): Promise<void> {
  const { fixture: f, sourceId, jobId, personId } = input;
  const payload = `[${[
    f.segmentId,
    f.peer,
    "Peer",
    "human",
    "I will send you the proposal.",
    "2026-10-15 12:00:00.12+00",
  ]
    .map((value) => JSON.stringify(value))
    .join(", ")}]`;
  const revision = createHash("md5").update(payload).digest("hex");
  await db.memorySources.updateMany({ where: { id: sourceId }, data: { revision } });
  await db.memoryGenerationLedger.updateMany({ where: { jobId }, data: { sourceRevision: revision } });
  await db.memoryPersonProjections.updateMany({
    where: { personId },
    data: { sourceRevisions: { [sourceId]: revision } },
  });
}

[false, true].forEach((isPreviousFormat) => {
  void test(
    `new meeting updates summary; concurrent Forget discards it (previous format: ${isPreviousFormat})`,
    { skip: !isIsolated },
    async () => {
      const f = await memoryFixture();
      const tracked = { meetingIds: [] as string[] };
      const onCreated = (meetingId: string): void => {
        tracked.meetingIds = [...tracked.meetingIds, meetingId];
      };
      try {
        const timestamp = new Date("2026-10-15T12:00:00.120Z");
        timestamp.toISOString = () => "2026-10-15T12:00:00.120456Z";
        await db.transcriptSegments.updateMany({ where: { id: f.segmentId }, data: { startedAt: timestamp } });
        const first = await f.enqueue();
        const firstJob = required(first.job);
        const firstValue = fixtureGeneration(required(first.input));
        await persistMemoryExtraction({
          job: firstJob,
          source: required(first.source),
          candidates: firstValue.memories,
          model: "fixture",
          generation: {
            value: firstValue,
            history: [],
            sourceIds: [required(first.source).id],
            inputSources: [required(first.source)],
            language: "English",
          },
        });
        const personId = required(required(first.input).people[0]).id;
        if (isPreviousFormat) {
          await storePreviousMemoryRevision({
            fixture: f,
            sourceId: required(first.source).id,
            jobId: firstJob.id,
            personId,
          });
        }
        const initial = await readMemoryProjection({ personId, sourceIds: [required(first.source).id] });
        assert.ok(initial, "unchanged summaries survive either stored fingerprint format");
        const rows = await db.memoryPersonProjections.findMany({ where: { personId } });
        assert.ok(await buildConsolidatedMemoryProjection({ winnerId: personId, rows }));
        assert.equal(await readMemoryProjection({ personId, sourceIds: [] }), null, "access checks still apply");
        await db.transcriptSegments.updateMany({ where: { id: f.segmentId }, data: { content: "Edited transcript" } });
        await db.memorySources.updateMany({ where: { id: required(first.source).id }, data: { isCurrent: true } });
        assert.equal(await readMemoryProjection({ personId, sourceIds: [required(first.source).id] }), null);
        await db.transcriptSegments.updateMany({
          where: { id: f.segmentId },
          data: { content: "I will send you the proposal." },
        });
        const changedTimestamp = new Date(timestamp);
        await db.memorySources.updateMany({ where: { id: required(first.source).id }, data: { isCurrent: true } });
        assert.ok(
          await readMemoryProjection({ personId, sourceIds: [required(first.source).id] }),
          "restored summary is current before the microsecond-only edit",
        );
        changedTimestamp.toISOString = () => "2026-10-15T12:00:00.120457Z";
        await db.transcriptSegments.updateMany({ where: { id: f.segmentId }, data: { startedAt: changedTimestamp } });
        assert.equal(
          await readMemoryProjection({ personId, sourceIds: [required(first.source).id] }),
          null,
          "database invalidation still rejects microsecond-only edits to lossy historical fingerprints",
        );
        await db.transcriptSegments.updateMany({ where: { id: f.segmentId }, data: { startedAt: timestamp } });
        await db.memorySources.updateMany({ where: { id: required(first.source).id }, data: { isCurrent: true } });
        await (["refresh", "forget", "uncited"] as const).reduce<Promise<MemoryProjection>>(
          async (previousProjection, mode) => {
            const previous = await previousProjection;

            return runProjectionMode({ fixture: f, personId, mode, previous, onCreated });
          },
          Promise.resolve(initial),
        );
      } finally {
        if (tracked.meetingIds.length !== 0) {
          await db.meetings.deleteMany({ where: { id: { in: tracked.meetingIds } } });
        }
        await f.cleanup();
      }
    },
  );
});
