import { closeDbPool, createMeeting, db, upsertUser } from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

import {
  decodeMeetingAssetDataUrl,
  meetingAssetServiceTestInternals,
  readMeetingAsset,
} from "../../application/meeting-asset-service";
import { repositories } from "../../ports/repository-runtime";

const MEETING_ASSET_MERGE_SEGMENT_LIMIT = 9;
const MEETING_ASSET_UUID_SUFFIX_PAD_LENGTH = 12;
const MEETING_ASSET_CONTENT_HASH_LENGTH = 64;
const MEETING_ASSET_SEGMENT_LIMIT_ERROR = /at most 9 unique transcript segments/;
const FILE_NOT_FOUND_ERROR_CODE = "ENOENT";
const FILE_PERMISSION_MASK = 0o777;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

void test("meeting asset decoder accepts bounded JPEG and PNG data URLs", () => {
  assert.deepEqual(decodeMeetingAssetDataUrl("data:image/jpeg;base64,ZmFrZQ=="), {
    mimeType: "image/jpeg",
    content: Buffer.from("fake"),
  });
  assert.equal(decodeMeetingAssetDataUrl("data:image/png;base64,iVBORw0KGgo=").mimeType, "image/png");
});

void test("meeting asset decoder rejects unsupported or empty content", () => {
  assert.throws(() => decodeMeetingAssetDataUrl("data:image/gif;base64,ZmFrZQ=="));
  assert.throws(() => decodeMeetingAssetDataUrl("data:image/jpeg;base64,"));
});

void test("meeting asset provenance merges the primary segment into its context window", () => {
  const primary = "11111111-1111-4111-8111-111111111111";
  const nearby = "22222222-2222-4222-8222-222222222222";

  assert.deepEqual(meetingAssetServiceTestInternals.mergeTranscriptSegmentIds(primary, [nearby, primary]), [
    nearby,
    primary,
  ]);
});

void test("meeting asset provenance rejects more than nine merged unique segments", () => {
  const segmentIds = Array.from(
    { length: MEETING_ASSET_MERGE_SEGMENT_LIMIT },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(MEETING_ASSET_UUID_SUFFIX_PAD_LENGTH, "0")}`,
  );

  assert.throws(
    () =>
      meetingAssetServiceTestInternals.mergeTranscriptSegmentIds("99999999-9999-4999-8999-999999999999", segmentIds),
    MEETING_ASSET_SEGMENT_LIMIT_ERROR,
  );
  assert.equal(
    meetingAssetServiceTestInternals.mergeTranscriptSegmentIds(segmentIds[0], segmentIds).length,
    MEETING_ASSET_MERGE_SEGMENT_LIMIT,
  );
});

void test("development meeting asset storage uses a private local file fallback", async () => {
  const content = Buffer.from("private-screen-capture");
  const storageKey = await meetingAssetServiceTestInternals.storeMeetingAssetObject({
    assetId: "22222222-2222-4222-8222-222222222222",
    meetingId: "11111111-1111-4111-8111-111111111111",
    contentHash: "a".repeat(MEETING_ASSET_CONTENT_HASH_LENGTH),
    extension: "jpg",
    mimeType: "image/jpeg",
    content,
    /** @external existing meeting asset test hook */
    forceLocal: true,
  });
  const localPath = meetingAssetServiceTestInternals.localStoragePath(storageKey);
  assert.ok(localPath !== null && localPath !== "");
  assert.match(storageKey, /-22222222-2222-4222-8222-222222222222\.jpg$/);
  try {
    const ciphertext = await readFile(localPath, "utf8");
    assert.equal(ciphertext.includes(content.toString("utf8")), false);
    assert.deepEqual(
      Buffer.from(
        await repositories().decryptMeetingObject({ storageKey: storageKey.replace(/^local:/u, ""), ciphertext }),
        "base64",
      ),
      content,
    );
    assert.equal((await stat(localPath)).mode & FILE_PERMISSION_MASK, PRIVATE_FILE_MODE);
    assert.equal((await stat(path.dirname(localPath))).mode & FILE_PERMISSION_MASK, PRIVATE_DIRECTORY_MODE);
  } finally {
    await meetingAssetServiceTestInternals.deleteMeetingAssetObject(storageKey);
  }
  await assert.rejects(readFile(localPath), { code: FILE_NOT_FOUND_ERROR_CODE });
  await meetingAssetServiceTestInternals.deleteMeetingAssetObject(storageKey);
});

after(closeDbPool);
void test("reading another meeting's asset neither fetches nor decrypts object bytes", async (t) => {
  const user = await upsertUser({ email: `${randomUUID()}@asset.test`, displayName: "Asset owner" });
  const meeting = await createMeeting({ title: "Private asset", roomName: randomUUID(), createdByUserId: user.id });
  try {
    const asset = await repositories().createMeetingAsset({
      meetingId: meeting.id,
      storageKey: "missing-object-that-must-not-be-read",
      contentHash: randomUUID(),
      mimeType: "image/png",
      byteSize: 1,
      capturedAt: new Date(),
      trigger: "manual",
      transcriptExcerpt: "Private excerpt",
    });
    const decrypt = t.mock.method(repositories(), "decryptMeetingObject", async () => "");
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.error());
    assert.equal(await readMeetingAsset({ assetId: asset.id, meetingId: randomUUID() }), null);
    assert.equal(decrypt.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(await repositories().getMeetingAssetById({ assetId: asset.id, meetingId: randomUUID() }), null);
    assert.equal(
      (await repositories().getMeetingAssetById({ assetId: asset.id, meetingId: meeting.id }))?.asset.id,
      asset.id,
    );
  } finally {
    await db.meetings.deleteMany({ where: { id: meeting.id } });
    await db.users.deleteMany({ where: { id: user.id } });
  }
});
