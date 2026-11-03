import { Prisma, type PrismaClient } from "../../../generated/prisma/client";

import { contentModels, modelRelations } from "./content-models";
import {
  decodeContentRow,
  encodeContentRow,
  encodeContentWhere,
  primaryWhere,
  type StorageRow,
  storageRow,
} from "./content-storage";

type Executor = Prisma.TransactionClient;
type Operation = { executor: Executor; model: string; operation: string; args: StorageRow };
const FAILURE = "Meeting content storage failed.";

/** Collection reads skip one bad row. Single-row reads stay fail-closed. */
export function omitsUndecryptableContentRows(operation: string): boolean {
  return operation === "findMany";
}
const RECORD_NOT_FOUND_CODE = "P2025";
const NOT_FOUND = "Record to update not found.";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const keysFor = (model: string) => contentModels[model]?.keys ?? [];
const isSelected = (value: unknown) => value !== undefined && value !== false && value !== null;

async function invoke(input: Operation): Promise<unknown> {
  const delegate: unknown = Reflect.get(input.executor, input.model);
  if (delegate === null || typeof delegate !== "object") {
    throw new Error(FAILURE);
  }
  const method: unknown = Reflect.get(delegate, input.operation);
  if (typeof method !== "function") {
    throw new Error(FAILURE);
  }
  const result: unknown = await Reflect.apply(method, delegate, [input.args]);

  return result;
}

function rows(value: unknown): StorageRow[] {
  if (!Array.isArray(value)) {
    throw new Error(FAILURE);
  }

  return value.map((entry: unknown) => storageRow(entry));
}

const selectionArgs = (args: StorageRow): StorageRow =>
  Object.fromEntries(
    Object.entries(args).filter(([key, value]) => ["select", "include"].includes(key) && value !== undefined),
  );

function trimSelection(input: { model: string; value: unknown; args: StorageRow }): unknown {
  const { model, value, args } = input;
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((row: unknown) => trimSelection({ model, value: row, args }));
  }
  const row = storageRow(value);
  const select = args.select === undefined ? undefined : storageRow(args.select);
  const entries = Object.entries(row).filter(
    ([key]) => select === undefined || !keysFor(model).includes(key) || isSelected(select[key]),
  );

  return Object.fromEntries(
    entries.map(([key, entry]) => {
      const target = modelRelations[model]?.[key];
      if (target === undefined) {
        return [key, entry];
      }
      const nested = storageRow(args.select ?? args.include ?? {})[key];

      return [
        key,
        trimSelection({
          model: target,
          value: entry,
          args: typeof nested === "object" && nested !== null ? storageRow(nested) : {},
        }),
      ];
    }),
  );
}

async function readSelection(input: {
  model: string;
  args: StorageRow;
  option: "select" | "include";
}): Promise<unknown> {
  const { model, args, option } = input;
  if (args[option] === undefined) {
    return undefined;
  }
  const selection = storageRow(args[option]);
  const isProtectedSelected = Object.keys(contentModels[model]?.fields ?? {}).some((field) =>
    isSelected(selection[field]),
  );
  const keySelection =
    option === "select" && isProtectedSelected ? Object.fromEntries(keysFor(model).map((key) => [key, true])) : {};
  const nested = await Promise.all(
    Object.entries(selection).map(async ([field, value]) => {
      const related = modelRelations[model]?.[field];

      return [
        field,
        related !== undefined && isSelected(value)
          ? await readArgs({ model: related, args: value === true ? {} : storageRow(value) })
          : value,
      ];
    }),
  );

  return { ...Object.fromEntries(nested), ...keySelection };
}

async function readArgs(input: { model: string; args: StorageRow }): Promise<StorageRow> {
  const { model, args } = input;
  if (args.omit !== undefined && keysFor(model).some((key) => isSelected(storageRow(args.omit)[key]))) {
    throw new Error(FAILURE);
  }
  ["orderBy", "distinct", "by", "having", "cursor", "_min", "_max"].forEach((option) => {
    if (args[option] === undefined) {
      return;
    }
    list(args[option]).forEach((item) => {
      const fields = typeof item === "string" ? [item] : Object.keys(storageRow(item));
      if (fields.some((field) => contentModels[model]?.fields[field] !== undefined)) {
        throw new Error(FAILURE);
      }
    });
  });

  const select = await readSelection({ model, args, option: "select" });
  const include = await readSelection({ model, args, option: "include" });

  return {
    ...args,
    where: await encodeContentWhere({ model, value: args.where }),
    ...(select === undefined ? {} : { select }),
    ...(include === undefined ? {} : { include }),
  };
}

async function createData(input: { model: string; value: unknown }): Promise<StorageRow> {
  const data = storageRow(input.value);
  const nested: [string, unknown][] = await Promise.all(
    Object.entries(modelRelations[input.model] ?? {})
      .filter(([field]) => data[field] !== undefined)
      .map(async ([field, model]) => {
        const relation = storageRow(data[field]);
        const operations: [string, unknown][] = await Promise.all(
          Object.entries(relation).map(async ([operation, value]) => {
            if (operation === "create") {
              const created = await Promise.all(list(value).map((row) => createData({ model, value: row })));

              return [operation, Array.isArray(value) ? created : created[0]];
            }
            if (operation === "createMany") {
              const many = storageRow(value);

              return [
                operation,
                { ...many, data: await Promise.all(list(many.data).map((row) => createData({ model, value: row }))) },
              ];
            }
            if (operation !== "connect") {
              throw new Error(FAILURE);
            }

            return [operation, value];
          }),
        );

        return [field, Object.fromEntries(operations)];
      }),
  );

  return encodeContentRow({ model: input.model, data: { ...data, ...Object.fromEntries(nested) }, isCreating: true });
}

function rejectNestedUpdate(input: { model: string; data: StorageRow }): void {
  if (Object.keys(modelRelations[input.model] ?? {}).some((field) => input.data[field] !== undefined)) {
    throw new Error(FAILURE);
  }
}

async function lockRows(input: { executor: Executor; model: string; records: StorageRow[] }): Promise<void> {
  const descriptor = contentModels[input.model];
  if (descriptor === undefined || input.records.length === 0) {
    return;
  }
  const columns = descriptor.keys.map((key) => ({
    key,
    column: key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
  }));
  const predicates = input.records.map(
    (row) =>
      Prisma.sql`(${Prisma.join(
        columns.map(({ key, column }) => {
          const cast = ["factFingerprint", "inputHash"].includes(key) ? "text" : "uuid";

          return Prisma.sql`${Prisma.raw(`"${column}"`)} = ${row[key]}::${Prisma.raw(cast)}`;
        }),
        " AND ",
      )})`,
  );
  await input.executor
    .$queryRaw`SELECT 1 FROM ${Prisma.raw(`"${descriptor.table}"`)} WHERE ${Prisma.join(predicates, " OR ")} ORDER BY ${Prisma.raw(columns.map(({ column }) => `"${column}"`).join(", "))} FOR UPDATE`;
}

// Prisma's Date serialization drops microseconds; this transaction already has encrypted content.
async function preciseTranscriptUpdate(input: {
  executor: Executor;
  model: string;
  row: StorageRow;
  data: StorageRow;
}): Promise<number | undefined> {
  const { executor, model, row, data } = input;
  if (
    model !== "transcriptSegments" ||
    !(data.startedAt instanceof Date) ||
    !/\.\d{4,}/u.test(data.startedAt.toISOString()) ||
    Object.keys(data).some((key) => !["startedAt", "content"].includes(key))
  ) {
    return undefined;
  }
  const assignments = [
    Prisma.sql`started_at = ${data.startedAt.toISOString()}::timestamptz`,
    ...(data.content !== undefined ? [Prisma.sql`content = ${data.content}`] : []),
  ];

  return executor.$executeRaw`UPDATE transcript_segments SET ${Prisma.join(assignments, ", ")} WHERE id = ${row.id}::uuid`;
}

async function updateOne(input: Operation & { row: StorageRow }): Promise<unknown> {
  const data = await encodeContentRow({
    model: input.model,
    data: storageRow(input.args.data),
    isCreating: false,
    identity: input.row,
  });
  const where = Object.fromEntries(keysFor(input.model).map((key) => [key, input.row[key]]));
  if (input.operation === "updateMany") {
    const precise = await preciseTranscriptUpdate({ ...input, data });
    const result = precise === undefined ? await invoke({ ...input, args: { where, data } }) : { count: precise };

    return storageRow(result).count;
  }

  return invoke({ ...input, operation: "updateManyAndReturn", args: { ...selectionArgs(input.args), where, data } });
}

async function updateRows(input: Operation): Promise<unknown> {
  rejectNestedUpdate({ model: input.model, data: storageRow(input.args.data) });
  const encoded = storageRow((await encodeContentWhere({ model: input.model, value: input.args.where })) ?? {});
  const keys = keysFor(input.model);
  const { [keys.join("_")]: compound, ...remaining } = encoded;
  const where = keys.length > 1 && compound !== undefined ? { AND: [remaining, storageRow(compound)] } : encoded;
  const candidates = rows(await invoke({ ...input, operation: "findMany", args: { where } }));
  await lockRows({ executor: input.executor, model: input.model, records: candidates });
  const identities = candidates.map((row) => Object.fromEntries(keysFor(input.model).map((key) => [key, row[key]])));
  const matches =
    candidates.length === 0
      ? []
      : rows(
          await invoke({
            ...input,
            operation: "findMany",
            args: { where: { AND: [where, { OR: identities }] } },
          }),
        );
  const results = await matches.reduce<Promise<unknown[]>>(async (pending, row) => {
    const previous = await pending;

    return [...previous, await updateOne({ ...input, row })];
  }, Promise.resolve([]));
  if (input.operation === "updateMany") {
    return { count: results.reduce<number>((sum, count) => sum + Number(count), 0) };
  }
  const updated = results.flatMap(rows);
  if (input.operation !== "update") {
    return updated;
  }
  if (updated.length === 0) {
    throw new Prisma.PrismaClientKnownRequestError(NOT_FOUND, {
      code: RECORD_NOT_FOUND_CODE,
      clientVersion: Prisma.prismaVersion.client,
    });
  }

  return updated[0];
}

async function upsertRow(input: Operation): Promise<unknown> {
  rejectNestedUpdate({ model: input.model, data: storageRow(input.args.update) });
  const where = await encodeContentWhere({ model: input.model, value: input.args.where });
  const existing = await invoke({ ...input, operation: "findUnique", args: { where } });
  if (existing !== null) {
    return updateExisting({ ...input, existing: storageRow(existing) });
  }
  const create = await createData({ model: input.model, value: input.args.create });
  const inserted = storageRow(
    await invoke({
      ...input,
      operation: "createMany",
      args: { data: [create], /** @external Prisma option */ skipDuplicates: true },
    }),
  );
  if (inserted.count === 1) {
    return invoke({
      ...input,
      operation: "findUnique",
      args: { ...selectionArgs(input.args), where: primaryWhere({ model: input.model, row: create }) },
    });
  }
  const winner = await invoke({ ...input, operation: "findUnique", args: { where } });
  if (winner === null) {
    throw new Error(FAILURE);
  }

  return updateExisting({ ...input, existing: storageRow(winner) });
}

async function updateExisting(input: Operation & { existing: StorageRow }): Promise<unknown> {
  await lockRows({ executor: input.executor, model: input.model, records: [input.existing] });
  const data = await encodeContentRow({
    model: input.model,
    data: storageRow(input.args.update),
    isCreating: false,
    identity: input.existing,
  });

  return invoke({
    ...input,
    operation: "update",
    args: { ...selectionArgs(input.args), where: primaryWhere({ model: input.model, row: input.existing }), data },
  });
}

async function runOperation(input: Operation): Promise<unknown> {
  const args = await readArgs({ model: input.model, args: input.args });
  if (contentModels[input.model] !== undefined) {
    if (input.operation === "upsert") {
      return upsertRow({ ...input, args });
    }
    if (["update", "updateMany", "updateManyAndReturn"].includes(input.operation)) {
      return updateRows({ ...input, args });
    }
  }
  if (["update", "updateMany", "updateManyAndReturn"].includes(input.operation)) {
    rejectNestedUpdate({ model: input.model, data: storageRow(args.data) });
  }
  if (input.operation === "upsert") {
    rejectNestedUpdate({ model: input.model, data: storageRow(args.update) });

    return invoke({
      ...input,
      args: { ...args, create: await createData({ model: input.model, value: args.create }) },
    });
  }
  if (["create", "createMany", "createManyAndReturn"].includes(input.operation)) {
    const data = await Promise.all(list(args.data).map((value) => createData({ model: input.model, value })));

    return invoke({ ...input, args: { ...args, data: input.operation === "create" ? data[0] : data } });
  }

  return invoke({ ...input, args });
}

type TransactionCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;
const isCallback = (value: unknown): value is TransactionCallback => typeof value === "function";

async function transactionRun(input: {
  client: object;
  transaction: unknown;
  run: TransactionCallback;
  options?: unknown;
}): Promise<unknown> {
  if (typeof input.transaction !== "function") {
    throw new Error(FAILURE);
  }
  const result: unknown = await Reflect.apply(input.transaction, input.client, [input.run, input.options]);

  return result;
}

function wrappedDelegate(input: {
  client: Executor;
  model: string;
  isInTransaction: boolean;
  transaction: unknown;
}): object {
  const delegate: unknown = Reflect.get(input.client, input.model);
  if (delegate === null || typeof delegate !== "object") {
    throw new Error(FAILURE);
  }
  const methods = new Map<PropertyKey, unknown>();
  const overrides = new Map<PropertyKey, unknown>();

  const handler: ProxyHandler<object> = {
    set: (...args: [target: object, method: string | symbol, value: unknown]) => {
      const [_target, method, value] = args;
      overrides.set(method, value);

      return true;
    },
    deleteProperty: (...args: [target: object, method: string | symbol]) => {
      const [_target, method] = args;
      overrides.delete(method);

      return true;
    },
    get: (...args: [target: object, method: string | symbol]) => {
      const [target, method] = args;
      if (overrides.has(method)) {
        return overrides.get(method);
      }
      if (methods.has(method)) {
        return methods.get(method);
      }
      const original: unknown = Reflect.get(target, method);
      if (typeof method !== "string" || typeof original !== "function") {
        return original;
      }
      const wrapped = async (args: StorageRow = {}) => {
        const operation = { executor: input.client, model: input.model, operation: method, args };
        const isTransactionNeeded =
          contentModels[input.model] !== undefined &&
          ["update", "updateMany", "updateManyAndReturn", "upsert"].includes(method);
        const result =
          isTransactionNeeded && !input.isInTransaction
            ? await transactionRun({
                client: input.client,
                transaction: input.transaction,
                run: (tx) => runOperation({ ...operation, executor: tx }),
              })
            : await runOperation(operation);
        if (["count", "aggregate", "groupBy", "createMany", "updateMany", "deleteMany"].includes(method)) {
          return result;
        }

        return trimSelection({
          model: input.model,
          value: await decodeContentRow({
            model: input.model,
            value: result,
            shouldOmitUndecryptable: omitsUndecryptableContentRows(method),
          }),
          args,
        });
      };
      methods.set(method, wrapped);

      return wrapped;
    },
  };

  return new Proxy(delegate, handler);
}

/** Covers callback transactions; raw SQL declares explicit codecs at its call sites. */
export function encryptedClient<T extends PrismaClient | Prisma.TransactionClient>(input: {
  client: T;
  isInTransaction?: boolean;
}): T {
  const { client, isInTransaction = false } = input;
  const overrides = new Map<PropertyKey, unknown>();
  const delegates = new Map<string, object>();
  const transaction: unknown = Reflect.get(client, "$transaction");

  const handler: ProxyHandler<T> = {
    set: (...args: [target: T, property: string | symbol, value: unknown]) => {
      const [_target, property, value] = args;
      overrides.set(property, value);

      return true;
    },
    deleteProperty: (...args: [target: T, property: string | symbol]) => {
      const [_target, property] = args;
      overrides.delete(property);

      return true;
    },
    get: (...args: [target: T, property: string | symbol]) => {
      const [target, property] = args;
      if (overrides.has(property)) {
        return overrides.get(property);
      }
      if (property === "$transaction") {
        return async (...args: [callback: unknown, options?: unknown]) => {
          const [callback, options] = args;
          if (!isCallback(callback)) {
            throw new Error(FAILURE);
          }

          return transactionRun({
            client,
            transaction,
            options,
            run: (tx) => callback(encryptedClient({ client: tx, isInTransaction: true })),
          });
        };
      }
      if (typeof property !== "string" || modelRelations[property] === undefined) {
        const value: unknown = Reflect.get(target, property);

        if (typeof value === "function") {
          const bound: unknown = value.bind(target);

          return bound;
        }

        return value;
      }
      const existing = delegates.get(property);
      if (existing !== undefined) {
        return existing;
      }
      const wrapped = wrappedDelegate({ client, model: property, isInTransaction, transaction });
      delegates.set(property, wrapped);

      return wrapped;
    },
  };

  return new Proxy(client, handler);
}
