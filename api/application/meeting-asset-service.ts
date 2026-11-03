import type { RepositoryPort } from "@readymeet/db/ports/repository";
import { MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS, type MeetingAssetTrigger } from "@readymeet/shared";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { repositories } from "../ports/repository-runtime";

import { deleteStoredObject, getStoredObjectBuffer, objectStorageStatus, putStoredObject } from "./object-storage";

const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\r\n]+)$/;
const LOCAL_STORAGE_PREFIX = "local:";
function localStorageRoot(): string {
  return path.join(tmpdir(), "readymeet-meeting-assets");
}
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOCAL_MEETING_ASSET_BYTES = 3_000_000;

const MESSAGE_INVALID_LOCAL_MEETING_ASSET_KEY = "Invalid local meeting asset key";
const MESSAGE_OBJECT_STORAGE_NOT_CONFIGURED = "Object storage is not configured for meeting assets";
const MESSAGE_MEETING_ASSET_DATA_URL_INVALID = "Meeting asset must be a base64 JPEG or PNG data URL";
const MESSAGE_MEETING_ASSET_IMAGE_SIZE_INVALID = "Meeting asset image must be between 1 byte and 3 MB";

const meetingAssetTranscriptSegmentLimitMessage = (): string =>
  `Meeting assets support at most ${MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS} unique transcript segments`;

type MeetingAssetMimeType = "image/jpeg" | "image/png";

type DecodedMeetingAssetDataUrl = {
  mimeType: MeetingAssetMimeType;
  content: Buffer;
};

type PersistMeetingScreenCaptureResult = Awaited<ReturnType<RepositoryPort["createMeetingAsset"]>>;

type ReadMeetingAssetResult = Promise<{
  asset: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingAssetById"]>>>["asset"];
  content: Buffer;
} | null>;

const nodeErrnoSchema = z.object({ code: z.string() });

function nodeErrorCode(error: unknown): string | undefined {
  const parsed = nodeErrnoSchema.safeParse(error);

  return parsed.success ? parsed.data.code : undefined;
}

function localStoragePath(storageKey: string): string | null {
  if (!storageKey.startsWith(LOCAL_STORAGE_PREFIX)) {
    return null;
  }
  const relative = storageKey.slice(LOCAL_STORAGE_PREFIX.length);
  const resolved = path.resolve(localStorageRoot(), relative);
  if (!resolved.startsWith(`${path.resolve(localStorageRoot())}${path.sep}`)) {
    throw new Error(MESSAGE_INVALID_LOCAL_MEETING_ASSET_KEY);
  }

  return resolved;
}

async function storeMeetingAssetObject(input: {
  assetId: string;
  meetingId: string;
  contentHash: string;
  extension: string;
  mimeType: string;
  content: Buffer;
  /** @external meeting asset storage test hook */
  forceLocal?: boolean;
}): Promise<string> {
  const objectKey = `meeting-assets/${input.meetingId}/${input.contentHash}-${input.assetId}.${input.extension}`;
  const ciphertext = await repositories().encryptMeetingObject({
    storageKey: objectKey,
    contentBase64: input.content.toString("base64"),
  });
  if (objectStorageStatus().configured && !(input.forceLocal ?? false)) {
    await putStoredObject({ key: objectKey, content: ciphertext, contentType: "application/octet-stream" });

    return objectKey;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(MESSAGE_OBJECT_STORAGE_NOT_CONFIGURED);
  }
  const storageKey = `${LOCAL_STORAGE_PREFIX}${objectKey}`;
  const localPath = localStoragePath(storageKey);
  if (localPath === null) {
    throw new Error(MESSAGE_INVALID_LOCAL_MEETING_ASSET_KEY);
  }
  await mkdir(path.dirname(localPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await writeFile(localPath, ciphertext, { mode: PRIVATE_FILE_MODE });

  return storageKey;
}

async function deleteMeetingAssetObject(storageKey: string): Promise<void> {
  const localPath = localStoragePath(storageKey);
  if (localPath === null) {
    await deleteStoredObject(storageKey);

    return;
  }
  try {
    await unlink(localPath);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

export function decodeMeetingAssetDataUrl(value: string): DecodedMeetingAssetDataUrl {
  const match = IMAGE_DATA_URL.exec(value);
  if (!match) {
    throw new Error(MESSAGE_MEETING_ASSET_DATA_URL_INVALID);
  }
  const mimeTypeCandidate = match[1];
  if (mimeTypeCandidate !== "image/jpeg" && mimeTypeCandidate !== "image/png") {
    throw new Error(MESSAGE_MEETING_ASSET_DATA_URL_INVALID);
  }
  const mimeType = mimeTypeCandidate;
  const encodedContent = match[2];
  if (encodedContent === undefined) {
    throw new Error(MESSAGE_MEETING_ASSET_DATA_URL_INVALID);
  }
  const content = Buffer.from(encodedContent.replace(/\s/g, ""), "base64");
  if (content.length === 0 || content.length > MAX_LOCAL_MEETING_ASSET_BYTES) {
    throw new Error(MESSAGE_MEETING_ASSET_IMAGE_SIZE_INVALID);
  }

  return { mimeType, content };
}

function mergeTranscriptSegmentIds(...args: [segmentId?: string | null, segmentIds?: string[]]): string[] {
  const [segmentId, segmentIds = []] = args;
  const hasSegmentId = segmentId !== undefined && segmentId !== null && segmentId !== "";
  const merged = [...new Set([...segmentIds, ...(hasSegmentId ? [segmentId] : [])])];
  if (merged.length > MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS) {
    throw new Error(meetingAssetTranscriptSegmentLimitMessage());
  }

  return merged;
}

export async function persistMeetingScreenCapture(input: {
  meetingId: string;
  imageDataUrl: string;
  capturedAt: Date;
  participantIdentity?: string | null;
  trackSid?: string | null;
  trigger: MeetingAssetTrigger;
  transcriptSegmentId?: string | null;
  transcriptSegmentIds?: string[];
  transcriptExcerpt?: string | null;
  speakerName?: string | null;
}): Promise<PersistMeetingScreenCaptureResult> {
  const transcriptSegmentIds = mergeTranscriptSegmentIds(input.transcriptSegmentId, input.transcriptSegmentIds);
  const { mimeType, content } = decodeMeetingAssetDataUrl(input.imageDataUrl);
  const contentHash = createHash("sha256").update(content).digest("hex");
  const extension = mimeType === "image/png" ? "png" : "jpg";
  const assetId = randomUUID();
  const storageKey = await storeMeetingAssetObject({
    assetId,
    meetingId: input.meetingId,
    contentHash,
    extension,
    mimeType,
    content,
  });
  try {
    const asset = await repositories().createMeetingAsset({
      id: assetId,
      meetingId: input.meetingId,
      storageKey,
      contentHash,
      mimeType,
      byteSize: content.length,
      capturedAt: input.capturedAt,
      participantIdentity: input.participantIdentity ?? null,
      trackSid: input.trackSid ?? null,
      trigger: input.trigger,
      transcriptSegmentIds,
      transcriptExcerpt: input.transcriptExcerpt ?? null,
      speakerName: input.speakerName ?? null,
    });
    if (asset.id !== assetId) {
      await deleteMeetingAssetObject(storageKey);
    }

    return asset;
  } catch (error) {
    try {
      const persisted = await repositories().getMeetingAssetById({ assetId, meetingId: input.meetingId });
      if (persisted) {
        return persisted.asset;
      }
    } catch (lookupError) {
      // If the database cannot confirm the outcome, preserve the object rather
      // than risk deleting one referenced by a committed-but-unacknowledged row.
      if (lookupError instanceof Error || lookupError !== undefined) {
        throw error;
      }
      throw error;
    }
    await deleteMeetingAssetObject(storageKey);
    throw error;
  }
}

export async function listMeetingAssets(meetingId: string): ReturnType<RepositoryPort["listMeetingAssets"]> {
  return repositories().listMeetingAssets(meetingId);
}

export async function updateMeetingAsset(
  input: Parameters<RepositoryPort["updateMeetingAsset"]>[0],
): ReturnType<RepositoryPort["updateMeetingAsset"]> {
  return repositories().updateMeetingAsset(input);
}

export const meetingAssetServiceTestInternals = {
  localStoragePath,
  deleteMeetingAssetObject,
  mergeTranscriptSegmentIds,
  storeMeetingAssetObject,
};

export async function readMeetingAsset(input: { assetId: string; meetingId: string }): ReadMeetingAssetResult {
  const record = await repositories().getMeetingAssetById(input);
  if (!record) {
    return null;
  }
  const localPath = localStoragePath(record.storageKey);

  const stored = localPath !== null ? await readFile(localPath) : await getStoredObjectBuffer(record.storageKey);
  const contentBase64 = await repositories().decryptMeetingObject({
    storageKey: record.storageKey.replace(/^local:/u, ""),
    ciphertext: stored.toString("utf8"),
  });

  return { asset: record.asset, content: Buffer.from(contentBase64, "base64") };
}
