import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { repositories } from "../../ports/repository-runtime";
import { convertStoredContentObject } from "../../scripts/content-object-cutover";

const PREFIX = "ready-content:v1:";
const PRIVATE_IMAGE = Buffer.from("original-private-image");

void test("image cutover keeps original bytes and verifies encrypted copies and retry", async () => {
  const relative = `cutover-${randomUUID()}/original.png`;
  const source = path.join(tmpdir(), "readymeet-meeting-assets", relative);
  const key = `local:${relative}`;
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, PRIVATE_IMAGE);
  try {
    const converted = await convertStoredContentObject({ storageKey: key, kind: "asset" });
    const ciphertext = await readFile(`${source}.ready-content-v1`, "utf8");
    assert.equal(ciphertext.startsWith(PREFIX), true);
    assert.equal(ciphertext.includes(PRIVATE_IMAGE.toString("utf8")), false);
    assert.deepEqual(await readFile(source), PRIVATE_IMAGE);
    assert.deepEqual(
      Buffer.from(
        await repositories().decryptMeetingObject({ storageKey: converted.replace(/^local:/u, ""), ciphertext }),
        "base64",
      ),
      PRIVATE_IMAGE,
    );
    assert.equal(await convertStoredContentObject({ storageKey: converted, kind: "asset" }), converted);
    assert.equal(await convertStoredContentObject({ storageKey: key, kind: "asset" }), converted);
    await writeFile(`${source}.ready-content-v1`, `${PREFIX}broken`);
    await assert.rejects(convertStoredContentObject({ storageKey: converted, kind: "asset" }));
    assert.deepEqual(await readFile(source), PRIVATE_IMAGE);
    await assert.rejects(convertStoredContentObject({ storageKey: `local:missing-${randomUUID()}`, kind: "asset" }));
    await assert.rejects(convertStoredContentObject({ storageKey: "local:../outside", kind: "ambient" }));
  } finally {
    await rm(path.dirname(source), { recursive: true, force: true });
  }
});
