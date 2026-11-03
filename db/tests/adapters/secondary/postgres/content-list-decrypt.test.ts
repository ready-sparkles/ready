import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { omitsUndecryptableContentRows } from "../../../../adapters/secondary/postgres/content-client";
import { decryptContentFields, encryptContentFields } from "../../../../adapters/secondary/postgres/content-encryption";
import { decodeContentRow } from "../../../../adapters/secondary/postgres/content-storage";
import { MeetingContentCryptoError, SKIPPED_PROTECTED_ROW_MESSAGE } from "../../../../domain/content-key-errors";

const PLAINTEXT = "visible-meeting-title";
const TAMPERED = "plaintext-title-SENTINEL";
const CIPHER_PREFIX = "ready-content:v1:";
const SINGLE_ROW_OPERATIONS = [
  "findFirst",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateManyAndReturn",
  "create",
];

function captureErrors(): { text: () => string; restore: () => void } {
  const original = console.error;
  const state = { lines: [] as string[] };
  console.error = (...parts: unknown[]) => {
    state.lines = [...state.lines, parts.map((value) => String(value)).join(" ")];
  };

  return {
    text: () => state.lines.join("\n"),
    restore: () => {
      console.error = original;
    },
  };
}

void test("meeting lists omit one undecryptable row and a single read still fails closed", async () => {
  const goodId = randomUUID();
  const badId = randomUUID();
  const otherId = randomUUID();
  const encrypted = await encryptContentFields({
    model: "meetings",
    recordId: goodId,
    fields: { title: PLAINTEXT },
  });
  const other = await encryptContentFields({
    model: "meetings",
    recordId: otherId,
    fields: { title: `${PLAINTEXT}-2` },
  });
  const rows = [
    { id: goodId, title: encrypted.title },
    { id: badId, title: TAMPERED },
    { id: otherId, title: other.title },
  ];
  const readableRows = [
    { id: goodId, title: encrypted.title },
    { id: otherId, title: other.title },
  ];
  const captured = captureErrors();
  try {
    const listed = await decodeContentRow({ model: "meetings", value: rows, shouldOmitUndecryptable: true });
    assert.deepEqual(
      listed.map((row) => row.title),
      [PLAINTEXT, `${PLAINTEXT}-2`],
    );
    assert.equal(JSON.stringify(listed).includes(TAMPERED), false);
    assert.equal(JSON.stringify(listed).includes(CIPHER_PREFIX), false);
    const log = captured.text();
    assert.match(log, new RegExp(SKIPPED_PROTECTED_ROW_MESSAGE));
    assert.match(log, new RegExp(badId));
    assert.equal(log.includes(TAMPERED), false);
    assert.equal(log.includes(CIPHER_PREFIX), false);
    assert.equal(log.includes(PLAINTEXT), false);
    await assert.rejects(decodeContentRow({ model: "meetings", value: rows }), (error: unknown) => {
      assert.ok(error instanceof MeetingContentCryptoError);
      assert.equal(JSON.stringify(error).includes(TAMPERED), false);

      return true;
    });
    await assert.rejects(
      decryptContentFields({ model: "meetings", recordId: badId, fields: { title: TAMPERED } }),
      (error: unknown) => error instanceof MeetingContentCryptoError,
    );
    const readable = await decodeContentRow({
      model: "meetings",
      value: readableRows,
      shouldOmitUndecryptable: true,
    });
    assert.deepEqual(
      readable.map((row) => row.title),
      [PLAINTEXT, `${PLAINTEXT}-2`],
    );
  } finally {
    captured.restore();
  }
});

void test("only meeting collection reads omit an undecryptable row", () => {
  assert.equal(omitsUndecryptableContentRows("findMany"), true);
  SINGLE_ROW_OPERATIONS.forEach((operation) => {
    assert.equal(omitsUndecryptableContentRows(operation), false, operation);
  });
});
