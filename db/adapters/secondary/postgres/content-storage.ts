import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { MeetingContentCryptoError, SKIPPED_PROTECTED_ROW_MESSAGE } from "../../../domain/content-key-errors";
import { Prisma } from "../../../generated/prisma/client";

import { decryptContentFields, encryptContentFields } from "./content-encryption";
import { contentFingerprint, lookupFields } from "./content-fingerprint";
import { type ContentField, contentModels, modelRelations } from "./content-models";

export type StorageRow = Record<string, unknown>;
const FAILURE = "Meeting content storage failed.";
const isRow = (value: unknown): value is StorageRow =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function storageRow(value: unknown): StorageRow {
  if (!isRow(value)) {
    throw new Error(FAILURE);
  }

  return value;
}

export function recordId(input: { model: string; row: StorageRow }): string {
  const values = (contentModels[input.model]?.keys ?? []).map((key) => input.row[key]);
  if (values.length === 0 || values.some((value) => typeof value !== "string" || value === "")) {
    throw new Error(FAILURE);
  }

  return values.length === 1 ? String(values[0]) : JSON.stringify(values);
}

export function primaryWhere(input: { model: string; row: StorageRow }): StorageRow {
  const keys = contentModels[input.model]?.keys ?? [];
  const value = Object.fromEntries(keys.map((key) => [key, input.row[key]]));

  return keys.length === 1 ? value : { [keys.join("_")]: value };
}

async function encodedField(input: {
  model: string;
  field: string;
  spec: ContentField;
  value: unknown;
}): Promise<{ row: StorageRow; fields: StorageRow }> {
  const { model, field, spec } = input;
  const isTextUpdate = !spec.isJson && isRow(input.value);
  const value = isTextUpdate ? storageRow(input.value).set : input.value;
  if (isTextUpdate && (Object.keys(storageRow(input.value)).length !== 1 || !("set" in storageRow(input.value)))) {
    throw new Error(FAILURE);
  }
  const fingerprintField = lookupFields[model]?.[field];
  if (value === Prisma.DbNull || (value === null && spec.isNullable)) {
    return {
      row: {
        [field]: spec.isJson ? Prisma.DbNull : null,
        ...(fingerprintField !== undefined ? { [fingerprintField]: null } : {}),
      },
      fields: {},
    };
  }
  if (fingerprintField !== undefined) {
    if (typeof value !== "string") {
      throw new Error(FAILURE);
    }

    return {
      row: { [fingerprintField]: await contentFingerprint({ domain: `${model}.${field}`, value }) },
      fields: { [field]: value },
    };
  }

  return { row: {}, fields: { [field]: value === Prisma.JsonNull ? null : value } };
}

export async function encodeContentRow(input: {
  model: string;
  data: StorageRow;
  isCreating: boolean;
  identity?: StorageRow;
}): Promise<StorageRow> {
  const { model, data, isCreating, identity } = input;
  const descriptor = contentModels[model];
  if (descriptor === undefined) {
    return { ...data };
  }
  const isGeneratedId =
    isCreating && descriptor.keys.length === 1 && descriptor.keys[0] === "id" && data.id === undefined;
  const row: StorageRow = { ...data, ...(isGeneratedId ? { id: randomUUID() } : {}) };
  if (!isCreating && descriptor.keys.some((key) => data[key] !== undefined)) {
    throw new Error(FAILURE);
  }
  const entries = await Promise.all(
    Object.entries(descriptor.fields).map(async ([field, spec]) => {
      const value = row[field] === undefined && isCreating ? spec.default : row[field];

      return value === undefined ? { row: {}, fields: {} } : encodedField({ model, field, spec, value });
    }),
  );
  const changes = storageRow(Object.assign({}, ...entries.map((entry) => entry.row)));
  const fields = storageRow(Object.assign({}, ...entries.map((entry) => entry.fields)));
  if (Object.keys(fields).length === 0) {
    return { ...row, ...changes };
  }
  const id = recordId({ model, row: identity ?? row });
  const existingFields =
    identity === undefined
      ? {}
      : Object.fromEntries(
          Object.keys(fields)
            .filter((field) => identity[field] !== undefined && identity[field] !== null)
            .map((field) => [field, identity[field]]),
        );
  const existing =
    Object.keys(existingFields).length === 0
      ? {}
      : await decryptContentFields({ model, recordId: id, fields: existingFields });
  const unchanged = Object.fromEntries(
    Object.entries(existing)
      .filter(([field, value]) => isDeepStrictEqual(value, fields[field]))
      .map(([field]) => [field, identity?.[field]]),
  );
  const changed = Object.fromEntries(Object.entries(fields).filter(([field]) => !(field in unchanged)));
  const encrypted =
    Object.keys(changed).length === 0 ? {} : await encryptContentFields({ model, recordId: id, fields: changed });

  // Reusing identical ciphertext avoids invalidating memory sources on transcript replay.
  return { ...row, ...changes, ...unchanged, ...encrypted };
}

function protectedRecordId(input: { model: string; row: unknown }): string | undefined {
  const row = isRow(input.row) ? input.row : undefined;
  if (row === undefined) {
    return undefined;
  }
  const keys = contentModels[input.model]?.keys ?? [];
  const values = keys.map((key): string | undefined => {
    const value = row[key];

    return typeof value === "string" && value !== "" ? value : undefined;
  });
  if (values.length === 0 || values.some((value) => value === undefined)) {
    return undefined;
  }
  const [only] = values;

  return values.length === 1 && only !== undefined ? only : JSON.stringify(values);
}

function logSkippedProtectedRow(input: { model: string; row: unknown }): void {
  const recordId = protectedRecordId(input);
  console.error(
    JSON.stringify({
      msg: SKIPPED_PROTECTED_ROW_MESSAGE,
      model: input.model,
      ...(recordId === undefined ? {} : { recordId }),
    }),
  );
}

async function decodeListedRow(input: {
  model: string;
  row: unknown;
  shouldOmitUndecryptable: boolean;
}): Promise<unknown> {
  try {
    return await decodeContentRow({
      model: input.model,
      value: input.row,
      shouldOmitUndecryptable: input.shouldOmitUndecryptable,
    });
  } catch (error: unknown) {
    if (!input.shouldOmitUndecryptable || !(error instanceof MeetingContentCryptoError)) {
      throw error;
    }
    logSkippedProtectedRow({ model: input.model, row: input.row });

    return undefined;
  }
}

/** Decoding keeps the ORM result shape; only authenticated field values are replaced. */
export async function decodeContentRow<T>(input: {
  model: string;
  value: T;
  shouldOmitUndecryptable?: boolean;
}): Promise<T> {
  const { model, value } = input;
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    const decoded = await Promise.all(
      value.map((row: unknown) =>
        decodeListedRow({ model, row, shouldOmitUndecryptable: input.shouldOmitUndecryptable === true }),
      ),
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The adapter preserves Prisma's caller-selected result shape.
    return decoded.filter((row) => row !== undefined) as T;
  }
  const row = storageRow(value);
  const fields = Object.fromEntries(
    Object.keys(contentModels[model]?.fields ?? {})
      .filter((field) => row[field] !== undefined && row[field] !== null)
      .map((field) => [field, row[field]]),
  );
  const decrypted =
    Object.keys(fields).length !== 0
      ? await decryptContentFields({ model, recordId: recordId({ model, row }), fields })
      : {};
  const relations = await Promise.all(
    Object.entries(modelRelations[model] ?? {})
      .filter(([relation]) => row[relation] !== undefined)
      .map(async ([relation, target]) => [relation, await decodeContentRow({ model: target, value: row[relation] })]),
  );

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The adapter preserves Prisma's caller-selected result shape.
  return { ...row, ...decrypted, ...Object.fromEntries(relations) } as T;
}

export type ContentProjection = { model: string; fields: Record<string, string> };

async function decodeProjection(input: { row: StorageRow; projection: ContentProjection }): Promise<StorageRow> {
  const { row, projection } = input;
  const source = Object.fromEntries(Object.entries(projection.fields).map(([field, alias]) => [field, row[alias]]));
  const keys = contentModels[projection.model]?.keys ?? [];
  if (keys.every((key) => source[key] === null || source[key] === undefined)) {
    if (
      Object.keys(contentModels[projection.model]?.fields ?? {}).some(
        (field) => source[field] !== null && source[field] !== undefined,
      )
    ) {
      throw new Error(FAILURE);
    }

    return {};
  }
  const decoded = await decodeContentRow({ model: projection.model, value: source });

  return Object.fromEntries(
    Object.entries(projection.fields)
      .filter(([, alias]) => alias in row)
      .map(([field, alias]) => [alias, decoded[field]]),
  );
}

/** Raw projections declare model/primary-key aliases; never trust envelope-supplied identity. */
export async function decodeContentAliases<T>(input: { rows: T[]; projections: ContentProjection[] }): Promise<T[]> {
  return Promise.all(
    input.rows.map(async (value) => {
      const row = storageRow(value);
      const decoded = await Promise.all(input.projections.map((projection) => decodeProjection({ row, projection })));

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Each projection replaces selected fields without adding/removing caller fields.
      return { ...row, ...Object.assign({}, ...decoded) } as T;
    }),
  );
}

export function contentProjection(input: { model: string; prefix?: string }): ContentProjection {
  const descriptor = contentModels[input.model];
  if (descriptor === undefined) {
    throw new Error(FAILURE);
  }

  return {
    model: input.model,
    fields: Object.fromEntries(
      [...descriptor.keys, ...Object.keys(descriptor.fields)].map((field) => [field, `${input.prefix ?? ""}${field}`]),
    ),
  };
}

async function fingerprintPredicate(input: { domain: string; value: unknown }): Promise<unknown> {
  const { domain, value } = input;
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return contentFingerprint({ domain, value });
  }

  return Object.fromEntries(
    await Promise.all(
      Object.entries(storageRow(value)).map(async ([operator, operand]) => {
        if (!["equals", "not", "in", "notIn"].includes(operator)) {
          throw new Error(FAILURE);
        }
        const result = Array.isArray(operand)
          ? await Promise.all(operand.map((item: unknown) => fingerprintPredicate({ domain, value: item })))
          : await fingerprintPredicate({ domain, value: operand });

        return [operator, result];
      }),
    ),
  );
}

async function relationPredicate(input: { model: string; value: unknown }): Promise<unknown> {
  if (input.value === null) {
    return null;
  }
  const relation = storageRow(input.value);
  if (!Object.keys(relation).some((key) => ["is", "isNot", "some", "every", "none"].includes(key))) {
    return encodeContentWhere(input);
  }

  return Object.fromEntries(
    await Promise.all(
      Object.entries(relation).map(async ([operator, value]) => [
        operator,
        await encodeContentWhere({ model: input.model, value }),
      ]),
    ),
  );
}

async function whereField(input: { model: string; field: string; predicate: unknown }): Promise<[string, unknown]> {
  const { model, field, predicate } = input;
  const lookup = lookupFields[model]?.[field];
  const target = modelRelations[model]?.[field];
  if (lookup !== undefined) {
    return [lookup, await fingerprintPredicate({ domain: `${model}.${field}`, value: predicate })];
  }
  if (["AND", "OR", "NOT"].includes(field)) {
    return [field, await encodeContentWhere({ model, value: predicate })];
  }
  if (target !== undefined) {
    return [field, await relationPredicate({ model: target, value: predicate })];
  }
  if (
    contentModels[model]?.fields[field] &&
    predicate !== null &&
    !(isRow(predicate) && Object.keys(predicate).length === 1 && predicate.not === null)
  ) {
    throw new Error(FAILURE);
  }

  return [field, predicate];
}

export async function encodeContentWhere(input: { model: string; value: unknown }): Promise<unknown> {
  const { model, value } = input;
  if (value === undefined || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item: unknown) => encodeContentWhere({ model, value: item })));
  }

  return Object.fromEntries(
    await Promise.all(
      Object.entries(storageRow(value)).map(([field, predicate]) => whereField({ model, field, predicate })),
    ),
  );
}
