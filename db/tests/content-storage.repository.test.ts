import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db, pool, Prisma } from "../adapters/secondary/postgres/client";
import { contentFingerprint } from "../adapters/secondary/postgres/content-fingerprint";
import { contentModels } from "../adapters/secondary/postgres/content-models";
import { decodeContentRow, encodeContentRow } from "../adapters/secondary/postgres/content-storage";
import {
  appendTranscriptSegment,
  createMeeting,
  createVoiceWebResearchRun,
  createWorkspaceTaskSection,
  getRecentVoiceWebResearchRunByQuery,
  updateMeetingTitleIfCurrent,
  updateWorkspaceTaskSection,
  upsertSummaryForMeeting,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";
import { WorkspaceTaskSectionTitleConflictError } from "../domain/persistence-errors";

const SENTINEL = "PRIVATE-CONTENT-🦊-中文";
const FAILURE = /Meeting content (?:encryption|storage) failed/u;
const FAILURE_ROLLBACK = "Rollback content write.";
const UNIQUE_CONSTRAINT_CODE = "P2002";
const SECTION_COUNT_WITH_DELETED = 2;

after(closeDbPool);

void test("every protected field preserves its JSON/text/null shape and binds its primary key", async () => {
  await Object.entries(contentModels).reduce(async (pending, [model, descriptor]) => {
    await pending;
    const identity = Object.fromEntries(descriptor.keys.map((key) => [key, randomUUID()]));
    const data = {
      ...identity,
      ...Object.fromEntries(
        Object.entries(descriptor.fields).map(([field, spec]) => [
          field,
          spec.isJson ? { nested: [SENTINEL, null, ""] } : SENTINEL,
        ]),
      ),
    };
    const stored = await encodeContentRow({ model, data, isCreating: true });
    Object.keys(descriptor.fields).forEach((field) => {
      assert.equal(typeof stored[field], "string", `${model}.${field}`);
      assert.equal(String(stored[field]).includes(SENTINEL), false);
    });
    const decoded = await decodeContentRow({ model, value: stored });
    Object.keys(descriptor.fields).forEach((field) => {
      assert.deepEqual(decoded[field], data[field]);
    });
    const substituted = { ...stored, [descriptor.keys[0] ?? "id"]: randomUUID() };
    await assert.rejects(decodeContentRow({ model, value: substituted }), FAILURE);
    const defaults = await encodeContentRow({ model, data: identity, isCreating: true });
    Object.entries(descriptor.fields)
      .filter(([, spec]) => spec.default !== undefined)
      .forEach(([field]) => {
        assert.match(String(defaults[field]), /^ready-content:v1:/u);
      });
    const nullable = Object.fromEntries(
      Object.entries(descriptor.fields)
        .filter(([, spec]) => spec.isNullable)
        .map(([field]) => [field, null]),
    );
    const nullStored = await encodeContentRow({ model, data: { ...identity, ...nullable }, isCreating: true });
    Object.keys(nullable).forEach((field) => {
      assert.ok(nullStored[field] === null || nullStored[field] === Prisma.DbNull);
    });
  }, Promise.resolve());
});

void test("real repository paths store ciphertext, preserve selected/nested reads, and roll back writes", async () => {
  const user = await upsertUser({ email: `${randomUUID()}@content.test`, displayName: "Readable account identity" });
  const meeting = await createMeeting({
    title: SENTINEL,
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  try {
    const segment = await appendTranscriptSegment({
      meetingId: meeting.id,
      speakerIdentity: "speaker",
      speakerName: "Speaker",
      speakerRole: "human",
      content: SENTINEL,
      startedAt: new Date(),
    });
    await upsertSummaryForMeeting({
      meetingId: meeting.id,
      content: SENTINEL,
      model: "test",
      shouldPreserveExisting: true,
    });
    const raw = await pool.query<{ title: string; content: string; summary: string }>(
      "SELECT m.title, s.content, u.content AS summary FROM meetings m JOIN transcripts t ON t.meeting_id=m.id JOIN transcript_segments s ON s.transcript_id=t.id JOIN summaries u ON u.meeting_id=m.id WHERE m.id=$1",
      [meeting.id],
    );
    assert.equal(JSON.stringify(raw.rows).includes(SENTINEL), false);
    Object.values(raw.rows[0] ?? {}).forEach((value) => {
      assert.match(value, /^ready-content:v1:/u);
    });
    const beforeReplay = raw.rows[0]?.content;
    await db.transcriptSegments.updateMany({ where: { id: segment.id }, data: { content: SENTINEL } });
    const replay = await pool.query<{ content: string }>("SELECT content FROM transcript_segments WHERE id=$1", [
      segment.id,
    ]);
    assert.equal(replay.rows[0]?.content, beforeReplay, "Identical transcript replay must not rewrite ciphertext.");
    assert.deepEqual(await db.meetings.findUnique({ where: { id: meeting.id }, select: { title: true } }), {
      title: SENTINEL,
    });
    const related = await db.transcriptSegments.findUnique({
      where: { id: segment.id },
      include: { transcripts: { include: { meetings: { select: { title: true } } } } },
    });
    assert.equal(related?.content, SENTINEL);
    assert.deepEqual(related.transcripts.meetings, { title: SENTINEL });
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.meetings.update({ where: { id: meeting.id }, data: { title: "ROLLED-BACK" } });
        throw new Error(FAILURE_ROLLBACK);
      }),
      /Rollback content write/u,
    );
    assert.equal((await db.meetings.findUnique({ where: { id: meeting.id } }))?.title, SENTINEL);
    const updated = await Promise.all([
      updateMeetingTitleIfCurrent({ meetingId: meeting.id, currentTitle: SENTINEL, title: "winner A" }),
      updateMeetingTitleIfCurrent({ meetingId: meeting.id, currentTitle: SENTINEL, title: "winner B" }),
    ]);
    assert.equal(updated.filter((row) => row !== null).length, 1);
    await pool.query("UPDATE transcript_segments SET content='plaintext injected' WHERE id=$1", [segment.id]);
    await assert.rejects(db.transcriptSegments.findUnique({ where: { id: segment.id } }), FAILURE);
  } finally {
    await db.meetings.deleteMany({ where: { id: meeting.id } });
  }
});

void test("keyed lookups hide text and preserve research query deduplication", async () => {
  assert.equal(
    await contentFingerprint({ domain: "same", value: SENTINEL }),
    await contentFingerprint({ domain: "same", value: SENTINEL }),
  );
  assert.notEqual(
    await contentFingerprint({ domain: "A", value: SENTINEL }),
    await contentFingerprint({ domain: "B", value: SENTINEL }),
  );
  const user = await upsertUser({ email: `${randomUUID()}@lookup.test`, displayName: "Lookup" });
  const meeting = await createMeeting({
    title: SENTINEL,
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const agent = await db.agentProfiles.create({ data: { userId: user.id, name: "test", displayName: "Test" } });
  try {
    const input = {
      meetingId: meeting.id,
      userId: user.id,
      agentProfileId: agent.id,
      utteranceId: randomUUID(),
      query: SENTINEL,
      queryKey: SENTINEL,
      status: "running",
      researchMode: "fast_grounded",
    };
    const run = await createVoiceWebResearchRun(input);
    await assert.rejects(
      createVoiceWebResearchRun({ ...input, utteranceId: randomUUID() }),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );
    const found = await getRecentVoiceWebResearchRunByQuery({
      ...input,
      queryKey: "different request key",
      queryText: SENTINEL,
      since: new Date(0),
    });
    assert.equal(found?.id, run.id);
    const raw = await pool.query(
      "SELECT query,query_key,query_key_fingerprint,query_fingerprint FROM voice_web_research_runs WHERE id=$1",
      [run.id],
    );
    assert.equal(JSON.stringify(raw.rows).includes(SENTINEL), false);
    const cards = await db.meetingAmbientContextItems.createManyAndReturn({
      data: [{ meetingId: meeting.id, entityKind: "company", canonicalKey: SENTINEL, displayName: SENTINEL }],
    });
    assert.equal(cards.length, 1);
    const bulk = await db.meetingAmbientContextItems.updateMany({
      where: { meetingId: meeting.id },
      data: { summary: SENTINEL },
    });
    assert.equal(bulk.count, 1);
    await assert.rejects(
      db.meetingAmbientContextItems.create({
        data: { meetingId: meeting.id, entityKind: "company", canonicalKey: SENTINEL, displayName: SENTINEL },
      }),
    );
    assert.equal(
      (await db.meetingAmbientContextItems.findMany({ where: { meetingId: meeting.id, canonicalKey: SENTINEL } }))
        .length,
      1,
    );
  } finally {
    await db.meetings.deleteMany({ where: { id: meeting.id } });
  }
});

void test("encrypted task-section titles keep active uniqueness, concurrent safety, and deleted-title reuse", async () => {
  const user = await upsertUser({ email: `${randomUUID()}@content.test`, displayName: "Section owner" });
  const title = `${SENTINEL}-${randomUUID()}`;
  const create = () => db.workspaceTaskSections.create({ data: { workspaceId: user.workspaceId, title } });
  try {
    const section = await create();
    await assert.rejects(create(), { code: UNIQUE_CONSTRAINT_CODE });
    await assert.rejects(
      createWorkspaceTaskSection({ workspaceId: user.workspaceId, actorUserId: user.id, title }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceTaskSectionTitleConflictError);
        assert.equal(error.message.includes("workspace_task_sections_title_uidx"), false);
        assert.equal(error.message.includes(title), false);

        return true;
      },
    );
    const created = await createWorkspaceTaskSection({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      title: `${title}-repository`,
    });
    assert.equal(created.title, `${title}-repository`);
    const other = await db.workspaceTaskSections.create({
      data: { workspaceId: user.workspaceId, title: `${title}-other` },
    });
    await assert.rejects(db.workspaceTaskSections.update({ where: { id: other.id }, data: { title } }), {
      code: UNIQUE_CONSTRAINT_CODE,
    });
    await assert.rejects(
      updateWorkspaceTaskSection({
        workspaceId: user.workspaceId,
        sectionId: other.id,
        actorUserId: user.id,
        title,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceTaskSectionTitleConflictError);
        assert.equal(error.message.includes("workspace_task_sections_title_uidx"), false);

        return true;
      },
    );
    const raw = await pool.query<{ title: string; title_fingerprint: string }>(
      "SELECT title,title_fingerprint FROM workspace_task_sections WHERE id=$1",
      [section.id],
    );
    assert.equal(JSON.stringify(raw.rows).includes(title), false);
    assert.match(raw.rows[0]?.title_fingerprint ?? "", /^[a-f0-9]{64}$/u);
    await db.workspaceTaskSections.update({ where: { id: section.id }, data: { deletedAt: new Date() } });
    const outcomes = await Promise.allSettled([create(), create()]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const stored = await db.workspaceTaskSections.findMany({ where: { workspaceId: user.workspaceId, title } });
    assert.equal(stored.length, SECTION_COUNT_WITH_DELETED);
    assert.equal(stored.filter((row) => row.deletedAt === null).length, 1);
  } finally {
    await db.workspaceTaskSections.deleteMany({
      where: { workspaceId: user.workspaceId, title: { in: [title, `${title}-other`, `${title}-repository`] } },
    });
  }
});

void test("encrypted compound-key analyses support updates and existing-row upserts", async () => {
  const user = await upsertUser({ email: `${randomUUID()}@content.test`, displayName: "Analysis owner" });
  const meeting = await createMeeting({ title: SENTINEL, roomName: randomUUID(), createdByUserId: user.id });
  const inputHash = "normal-analysis-hash";
  const where = { meetingId_inputHash: { meetingId: meeting.id, inputHash } };
  try {
    await db.ashbyMeetingAnalyses.create({ data: { meetingId: meeting.id, inputHash, result: { step: "created" } } });
    assert.equal(
      (
        await db.ashbyMeetingAnalyses.updateMany({
          where: { meetingId: meeting.id, inputHash },
          data: { result: { step: "bulk" } },
        })
      ).count,
      1,
    );
    const updated = await db.ashbyMeetingAnalyses.update({ where, data: { result: { step: SENTINEL } } });
    assert.deepEqual(updated.result, { step: SENTINEL });
    const upserted = await db.ashbyMeetingAnalyses.upsert({
      where,
      create: { meetingId: meeting.id, inputHash, result: { step: "unexpected" } },
      update: { result: { step: SENTINEL } },
    });
    assert.deepEqual(upserted.result, { step: SENTINEL });
    const raw = await pool.query("SELECT result FROM ashby_meeting_analyses WHERE meeting_id=$1 AND input_hash=$2", [
      meeting.id,
      inputHash,
    ]);
    assert.equal(JSON.stringify(raw.rows).includes(SENTINEL), false);
  } finally {
    await db.meetings.deleteMany({ where: { id: meeting.id } });
    await db.users.deleteMany({ where: { id: user.id } });
  }
});
