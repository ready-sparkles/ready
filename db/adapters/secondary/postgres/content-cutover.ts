import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";

import { decryptContentFields, encryptContentFields } from "./content-encryption";
import { contentFingerprint, lookupFields } from "./content-fingerprint";
import { type ContentModel, contentModels } from "./content-models";
import { recordId, type StorageRow, storageRow } from "./content-storage";
import { runContentMaintenance } from "./migrations";

const UNKNOWN_TRIGGER = "Unexpected content trigger; maintenance refused.";
const UNKNOWN_MIGRATION = "Unrecognized content migration; maintenance refused.";
const MIGRATION_PARTS = 2;
const FAILURE = "Content preservation verification failed.";
const PREFIX = "ready-content:v1:";
const PAGE_SIZE = 10;
const KNOWN_TRIGGERS = new Set([
  "allocate_completed_meeting_trial_slot",
  "canonicalize_memory_people",
  "memory_sync_evidence",
  "memory_sync_row",
  "memory_transcript_revision",
  "memory_transcript_parent",
  "prevent_redirected_projection",
]);
const OBJECT_COLUMNS: Record<string, { column: string; kind: "asset" | "ambient" }> = {
  meetingAssets: { column: "storage_key", kind: "asset" },
  meetingAmbientContextItems: { column: "image_storage_key", kind: "ambient" },
};
export type ConvertContentObject = (input: { storageKey: string; kind: "asset" | "ambient" }) => Promise<string>;
const columnName = (field: string): string => field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

type CutoverModel = {
  model: string;
  descriptor: ContentModel;
  client: PoolClient;
  convertObject: ConvertContentObject;
};

async function encryptedFields(input: {
  model: string;
  id: string;
  descriptor: ContentModel;
  original: StorageRow;
}): Promise<{ values: StorageRow; expected: StorageRow }> {
  const { model, id, descriptor, original } = input;
  const present = Object.entries(descriptor.fields).filter(
    ([, spec]) => original[`${spec.column}_is_sql_null`] !== true,
  );
  const existing = Object.fromEntries(
    present
      .filter(
        ([, spec]) => typeof original[spec.column] === "string" && String(original[spec.column]).startsWith(PREFIX),
      )
      .map(([field, spec]) => [field, original[spec.column]]),
  );
  const decoded =
    Object.keys(existing).length === 0 ? {} : await decryptContentFields({ model, recordId: id, fields: existing });
  const expected = Object.fromEntries(
    present.map(([field, spec]) => [field, field in decoded ? decoded[field] : original[spec.column]]),
  );
  const plaintext = Object.fromEntries(Object.entries(expected).filter(([field]) => !(field in existing)));
  const encrypted =
    Object.keys(plaintext).length === 0 ? {} : await encryptContentFields({ model, recordId: id, fields: plaintext });
  const values = Object.fromEntries(
    present.map(([field, spec]) => [
      spec.column,
      spec.isJson ? JSON.stringify(encrypted[field] ?? existing[field]) : (encrypted[field] ?? existing[field]),
    ]),
  );
  await Object.entries(lookupFields[model] ?? {}).reduce(async (pending, [field, fingerprint]) => {
    await pending;
    const value = expected[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(FAILURE);
    }
    values[columnName(fingerprint)] =
      value === undefined ? null : await contentFingerprint({ domain: `${model}.${field}`, value });
  }, Promise.resolve());

  return { values, expected };
}

function selection(descriptor: ContentModel): string {
  return [
    "t.*",
    ...Object.values(descriptor.fields).map(
      (spec) => `${quote(spec.column)} IS NULL AS ${quote(`${spec.column}_is_sql_null`)}`,
    ),
    "to_jsonb(t) AS preservation_original",
  ].join(", ");
}

async function convertRow(input: CutoverModel & { row: StorageRow }): Promise<void> {
  const { model, descriptor, client, row, convertObject } = input;
  const identity = Object.fromEntries(descriptor.keys.map((key) => [key, row[columnName(key)]]));
  const id = recordId({ model, row: identity });
  const { values, expected } = await encryptedFields({ model, id, descriptor, original: row });
  const object = OBJECT_COLUMNS[model];
  if (object !== undefined && row[object.column] !== null) {
    const storageKey = row[object.column];
    if (typeof storageKey !== "string") {
      throw new Error(FAILURE);
    }
    values[object.column] = await convertObject({ storageKey, kind: object.kind });
  }
  const changes = Object.entries(values);
  if (changes.length === 0) {
    return;
  }
  const keys = descriptor.keys.map(columnName);
  const where = keys.map((key, index) => `${quote(key)} = $${String(changes.length + index + 1)}`).join(" AND ");
  const updated = await client.query<StorageRow>(
    `UPDATE ${quote(descriptor.table)} t SET ${changes.map(([column], index) => `${quote(column)} = $${String(index + 1)}`).join(", ")} WHERE ${where} RETURNING ${selection(descriptor)}`,
    [...changes.map(([, value]) => value), ...keys.map((key) => row[key])],
  );
  const stored = updated.rows[0];
  if (updated.rowCount !== 1 || stored === undefined) {
    throw new Error(FAILURE);
  }
  const decrypted = await decryptContentFields({
    model,
    recordId: id,
    fields: Object.fromEntries(
      Object.keys(expected).map((field) => [field, stored[descriptor.fields[field]?.column ?? ""]]),
    ),
  });
  const before = storageRow(row.preservation_original);
  const after = storageRow(stored.preservation_original);
  const unchanged = (value: StorageRow): StorageRow =>
    Object.fromEntries(Object.entries(value).filter(([column]) => !(column in values)));
  if (!isDeepStrictEqual(expected, decrypted) || !isDeepStrictEqual(unchanged(before), unchanged(after))) {
    throw new Error(FAILURE);
  }
}

async function convertModel(input: CutoverModel & { offset: number }): Promise<void> {
  const { descriptor, client, offset } = input;
  const result = await client.query<StorageRow>(
    `SELECT ${selection(descriptor)} FROM ${quote(descriptor.table)} t ORDER BY ${descriptor.keys.map((key) => quote(columnName(key))).join(", ")} LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, offset],
  );
  // Settle every in-flight conversion before the caller can roll back its shared connection.
  const converted = await Promise.allSettled(result.rows.map(async (row) => convertRow({ ...input, row })));
  const failed = converted.find((entry) => entry.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
  if (result.rows.length === PAGE_SIZE) {
    await convertModel({ ...input, offset: offset + result.rows.length });
  }
}

async function pauseTriggers(client: PoolClient): Promise<{ table: string; name: string; enabled: string }[]> {
  const tables = Object.values(contentModels).map((descriptor) => descriptor.table);
  await client.query(`LOCK TABLE ${tables.map(quote).join(", ")} IN ACCESS EXCLUSIVE MODE`);
  const triggers = await client.query<{ table: string; name: string; enabled: string }>(
    `SELECT c.relname AS table, t.tgname AS name, t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal`,
    [tables],
  );
  if (triggers.rows.some((trigger) => !KNOWN_TRIGGERS.has(trigger.name))) {
    throw new Error(UNKNOWN_TRIGGER);
  }
  await triggers.rows.reduce(async (pending, trigger) => {
    await pending;
    await client.query(`ALTER TABLE ${quote(trigger.table)} DISABLE TRIGGER ${quote(trigger.name)}`);
  }, Promise.resolve());

  return triggers.rows;
}

/** Caller owns the transaction; failures must roll back schema, rows, triggers and migration history together. */
export async function convertExistingContent(input: {
  client: PoolClient;
  sql: string;
  convertObject: ConvertContentObject;
}): Promise<void> {
  const { client, sql, convertObject } = input;
  const expand = sql.split("-- CONTENT_EXPAND\n")[1]?.split("-- CONTENT_FINALIZE\n");
  if (expand?.length !== MIGRATION_PARTS || expand[0] === undefined || expand[1] === undefined) {
    throw new Error(UNKNOWN_MIGRATION);
  }
  await client.query("SET LOCAL lock_timeout = '10s'");
  const triggers = await pauseTriggers(client);
  await client.query(expand[0]);
  await Object.entries(contentModels).reduce(async (pending, [model, descriptor]) => {
    await pending;
    await convertModel({ model, descriptor, client, convertObject, offset: 0 });
    process.stdout.write(`Encrypted and verified ${descriptor.table}.\n`);
  }, Promise.resolve());
  await client.query(expand[1]);
  await triggers.reduce(async (pending, trigger) => {
    await pending;
    const action =
      trigger.enabled === "D"
        ? "DISABLE"
        : trigger.enabled === "A"
          ? "ENABLE ALWAYS"
          : trigger.enabled === "R"
            ? "ENABLE REPLICA"
            : "ENABLE";
    await client.query(`ALTER TABLE ${quote(trigger.table)} ${action} TRIGGER ${quote(trigger.name)}`);
  }, Promise.resolve());
}

/** Operator-invoked only; never called by normal application startup. */
export async function preserveMeetingContent(convertObject: ConvertContentObject): Promise<void> {
  await runContentMaintenance(async ({ client, sql }) => convertExistingContent({ client, sql, convertObject }));
}
