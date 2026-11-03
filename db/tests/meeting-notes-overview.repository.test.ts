import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { setTimeout } from "node:timers/promises";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import { setContentKeyServiceForTests } from "../adapters/secondary/postgres/content-encryption";
import {
  createMeeting,
  getMeetingTranscriptOverview,
  getTranscriptForMeeting,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

import { configureContentTestKeys } from "./content-key-fixture";

const KEY_BYTES = 32;
const KEY_DELAY_MS = 10;
const LONG_TRANSCRIPT_SEGMENTS = 200;

after(closeDbPool);

void test(
  "notes metadata decrypts no segments for short or long encrypted transcripts",
  { skip: process.env.READYMEET_ISOLATED_DB !== "1" },
  async (t) => {
    const counts = { metadata: 0, segments: 0 };
    // Deliberately simple test-only keys in a disposable database; no external key service.
    setContentKeyServiceForTests({
      generate: async () => {
        const key = randomBytes(KEY_BYTES);

        return { plaintext: key, wrapped: Buffer.from(key) };
      },
      decrypt: async ({ wrapped, context }) => {
        if (context.model === "transcripts") {
          counts.metadata += 1;
        }
        if (context.model === "transcriptSegments") {
          counts.segments += 1;
        }
        await setTimeout(KEY_DELAY_MS);

        return Buffer.from(wrapped);
      },
    });
    const user = await upsertUser({ email: `${randomUUID()}@notes-overview.test`, displayName: "Fixture" });
    t.after(async () => {
      await db.meetings.deleteMany({ where: { createdByUserId: user.id } });
      await db.workspaces.deleteMany({ where: { createdByUserId: user.id } });
      await db.users.deleteMany({ where: { id: user.id } });
      configureContentTestKeys();
    });
    await [1, LONG_TRANSCRIPT_SEGMENTS].reduce(async (previous, size) => {
      await previous;
      const meeting = await createMeeting({
        title: "Invented planning call",
        roomName: randomUUID(),
        createdByUserId: user.id,
        workspaceId: user.workspaceId,
      });
      assert.equal(await getMeetingTranscriptOverview(meeting.id), null);
      const transcript = await db.transcripts.create({
        data: { meetingId: meeting.id, source: "livekit-postcall", metadata: { mode: "postcall-refined" } },
      });
      assert.equal((await getMeetingTranscriptOverview(meeting.id))?.hasTranscriptSegments, false);
      await db.transcriptSegments.createMany({
        data: Array.from({ length: size }, () => ({
          transcriptId: transcript.id,
          speakerIdentity: "fixture",
          speakerName: "Fixture",
          content: "Test the invented system.",
          startedAt: new Date(),
        })),
      });
      counts.metadata = 0;
      counts.segments = 0;
      const fullStart = performance.now();
      const full = await getTranscriptForMeeting(meeting.id);
      const fullMs = performance.now() - fullStart;
      assert.equal(full?.segments.length, size);
      assert.equal(counts.segments, size);
      counts.metadata = 0;
      counts.segments = 0;
      const notesStart = performance.now();
      const overview = await getMeetingTranscriptOverview(meeting.id);
      const notesMs = performance.now() - notesStart;
      assert.equal(overview?.hasTranscriptSegments, true);
      assert.equal(overview.transcript.metadata.mode, "postcall-refined");
      assert.equal(counts.metadata, 1);
      assert.equal(counts.segments, 0);
      assert.equal(await db.transcripts.count({ where: { meetingId: meeting.id } }), 1);
      t.diagnostic(
        JSON.stringify({
          size,
          fullMs: Math.round(fullMs),
          notesMs: Math.round(notesMs),
          fullSegmentDecrypts: size,
          notesSegmentDecrypts: counts.segments,
        }),
      );
    }, Promise.resolve());
  },
);
