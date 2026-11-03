import { repositoryPort } from "@readymeet/db";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getStoredObjectBuffer, putStoredObject } from "../application/object-storage";

const PREFIX = "ready-content:v1:";
const ENCRYPTED_SUFFIX = ".ready-content-v1";
const FAILURE = "Content object preservation failed.";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function localObjectPath(input: { storageKey: string; kind: "asset" | "ambient" }): string | null {
  if (!input.storageKey.startsWith("local:")) {
    return null;
  }
  const root = path.resolve(
    tmpdir(),
    input.kind === "asset" ? "readymeet-meeting-assets" : "readymeet-ambient-context",
  );
  const resolved = path.resolve(root, input.storageKey.slice("local:".length));
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(FAILURE);
  }

  return resolved;
}

export async function convertStoredContentObject(input: {
  storageKey: string;
  kind: "asset" | "ambient";
}): Promise<string> {
  const sourcePath = localObjectPath(input);
  const original = sourcePath === null ? await getStoredObjectBuffer(input.storageKey) : await readFile(sourcePath);
  if (original.toString("utf8").startsWith(PREFIX)) {
    await repositoryPort.decryptMeetingObject({
      storageKey: input.storageKey.replace(/^local:/u, ""),
      ciphertext: original.toString("utf8"),
    });

    return input.storageKey;
  }
  if (input.storageKey.endsWith(ENCRYPTED_SUFFIX)) {
    throw new Error(FAILURE);
  }
  const key = `${input.storageKey}${ENCRYPTED_SUFFIX}`;
  const ciphertext = await repositoryPort.encryptMeetingObject({
    storageKey: key.replace(/^local:/u, ""),
    contentBase64: original.toString("base64"),
  });
  const targetPath = localObjectPath({ ...input, storageKey: key });
  if (targetPath === null) {
    await putStoredObject({ key, content: ciphertext, contentType: "application/octet-stream" });
  } else {
    await mkdir(path.dirname(targetPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await writeFile(targetPath, ciphertext, { mode: PRIVATE_FILE_MODE });
  }
  const stored = targetPath === null ? await getStoredObjectBuffer(key) : await readFile(targetPath);
  const decrypted = await repositoryPort.decryptMeetingObject({
    storageKey: key.replace(/^local:/u, ""),
    ciphertext: stored.toString("utf8"),
  });
  if (!original.equals(Buffer.from(decrypted, "base64"))) {
    throw new Error(FAILURE);
  }

  return key;
}
