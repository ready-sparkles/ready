import type { MemoryListChanges, MemoryListPage, RelationshipMemory } from "@readymeet/shared";
import { encodeMemoryPosition } from "@readymeet/shared";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryListQuery, type MemoryListData, mergeMemoryChanges } from "../../composition/memory-list-sync";

const TEST_VALUE_1000 = 1000;
const TEST_VALUE_12 = 12;
const TEST_VALUE_150 = 150;
const TEST_VALUE_2 = 2;
const TEST_VALUE_3 = 3;
const TEST_VALUE_4 = 4;
const TEST_VALUE_5 = 5;
const TEST_VALUE_6 = 6;
const TEST_VALUE_7 = 7;
const TEST_VALUE_8 = 8;
const TEST_VALUE_9 = 9;

const MESSAGE_EXPECTED_BOTH_MEMORY_PAGES = "Expected both memory pages";
const MESSAGE_EXPECTED_REFRESHED_MEMORY_LIST = "Expected refreshed memory list";
const MESSAGE_MUST_NOT_REFETCH_HISTORY = "Must not refetch history";
const MESSAGE_EXPECTED_FIRST_MEMORY_PAGE = "Expected the first memory page";
const MESSAGE_EXPECTED_STORED_MEMORY_PAGES = "Expected stored memory pages";
const MESSAGE_EXPECTED_FIRST_DELETED_MEMORY_PAGE = "Expected the first deleted memory page";

const uuid = (id: string) => `00000000-0000-4000-8000-${Buffer.from(id).toString("hex").padStart(TEST_VALUE_12, "0")}`;

function isRelationshipMemory(value: object): value is RelationshipMemory {
  return "id" in value && "title" in value && "occurredAt" in value && "importance" in value;
}

function memory(input: { id: string; time?: number }): RelationshipMemory {
  const row = {
    id: uuid(input.id),
    title: input.id,
    occurredAt: new Date((input.time ?? 1) * TEST_VALUE_1000).toISOString(),
    importance: 1,
  };
  assert.ok(isRelationshipMemory(row));

  return row;
}

const delta = (input: { memories?: RelationshipMemory[]; removedIds?: string[] } = {}): MemoryListChanges => ({
  memories: input.memories ?? [],
  removedIds: (input.removedIds ?? []).map(uuid),
  syncCursor: "v2",
  /** @external memory sync wire field */
  hasMore: false,
});

const boundaryB = encodeMemoryPosition(memory({ id: "b", time: TEST_VALUE_3 }));
const boundaryD = encodeMemoryPosition(memory({ id: "d", time: 1 }));
const pages: MemoryListData = {
  pages: [
    {
      memories: [memory({ id: "a", time: TEST_VALUE_4 }), memory({ id: "b", time: TEST_VALUE_3 })],
      nextCursor: boundaryB,
      syncCursor: "v1",
    },
    {
      memories: [memory({ id: "c", time: TEST_VALUE_2 }), memory({ id: "d", time: 1 })],
      nextCursor: boundaryD,
      syncCursor: "v1",
    },
  ],
  pageParams: ["", boundaryB],
};

void test("delta merge updates old pages, removes forgotten rows, deduplicates and preserves immutable pagination boundaries", () => {
  const result = mergeMemoryChanges(
    pages,
    delta({
      memories: [memory({ id: "c", time: TEST_VALUE_5 }), memory({ id: "e", time: TEST_VALUE_6 })],
      removedIds: ["b"],
    }),
  );
  assert.deepEqual(
    result.pages.flatMap((page) => page.memories.map((row) => row.title)),
    ["e", "c", "a", "d"],
  );
  const firstPage = result.pages[0];
  const secondPage = result.pages[1];
  if (!firstPage || !secondPage) {
    throw new Error(MESSAGE_EXPECTED_BOTH_MEMORY_PAGES);
  }
  assert.equal(secondPage.nextCursor, boundaryD);
  assert.equal(firstPage.syncCursor, "v2");
});
void test("real infinite-query refetch makes one delta request, replays old pages locally, and still fetches the next page", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const key = ["memory"];
  client.setQueryData(key, pages);
  const requests: { values: string[] } = { values: [] };
  const queryFn = createMemoryListQuery({
    getData: () => client.getQueryData(key),
    list: async ({ before }) => {
      requests.values = [...requests.values, `list:${before}`];

      return { memories: [memory({ id: "f", time: 0 })], nextCursor: null, syncCursor: "v2" };
    },
    sync: async ({ cursor, through }) => {
      requests.values = [...requests.values, `sync:${cursor}:${through ?? "null"}`];

      return delta({ memories: [memory({ id: "e", time: TEST_VALUE_6 })], removedIds: ["b"] });
    },
  });
  const observer = new InfiniteQueryObserver(client, {
    queryKey: key,
    queryFn,
    initialPageParam: "",
    getNextPageParam: (page: MemoryListPage) => page.nextCursor ?? undefined,
  });
  try {
    await observer.refetch();
    assert.deepEqual(requests.values, [`sync:v1:${boundaryD}`]);
    const refreshed = client.getQueryData<MemoryListData>(key);
    if (!refreshed) {
      throw new Error(MESSAGE_EXPECTED_REFRESHED_MEMORY_LIST);
    }
    assert.deepEqual(
      refreshed.pages.flatMap((page) => page.memories.map((row) => row.title)),
      ["e", "a", "c", "d"],
    );
    await observer.fetchNextPage();
    assert.deepEqual(requests.values, [`sync:v1:${boundaryD}`, `list:${boundaryD}`]);
    await observer.refetch();
    assert.equal(requests.values.at(-1), "sync:v2:null");
    assert.equal(requests.values.filter((request) => request.startsWith("list:")).length, 1);
  } finally {
    observer.destroy();
    client.clear();
  }
});
void test("drains bounded delta batches before committing and aborts without replaying a partial result", async () => {
  const syncCalls = { count: 0 };
  const controller = new AbortController();
  const query = createMemoryListQuery({
    getData: () => pages,
    list: async () => {
      throw new Error(MESSAGE_MUST_NOT_REFETCH_HISTORY);
    },
    sync: async () => {
      syncCalls.count += 1;

      return {
        ...delta({ memories: [memory({ id: `new-${syncCalls.count}`, time: TEST_VALUE_8 })] }),
        hasMore: syncCalls.count === 1,
      };
    },
  });
  const first = await query({ pageParam: "", signal: controller.signal });
  assert.equal(syncCalls.count, TEST_VALUE_2);
  assert.deepEqual(
    first.memories.map((row) => row.title),
    ["new-2", "new-1", "a", "b"],
  );
  controller.abort();
  await assert.rejects(query({ pageParam: "", signal: controller.signal }), { name: "AbortError" });
});
void test("scope resets rebuild a baseline rather than retaining inaccessible cached memories", async () => {
  const lists = { count: 0 };
  const query = createMemoryListQuery({
    getData: () => pages,
    sync: async () => ({ ...delta(), /** @external memory sync wire field */ reset: true }),
    list: async () => {
      lists.count += 1;

      return { memories: [], nextCursor: null, syncCursor: "fresh" };
    },
  });
  const first = await query({ pageParam: "", signal: new AbortController().signal });
  assert.deepEqual(first.memories, []);
  assert.equal(lists.count, 1);
});

void test("a large arrival batch rebuilds the bounded baseline instead of growing a cached page", async () => {
  const baselines = { count: 0 };
  const query = createMemoryListQuery({
    getData: () => pages,
    sync: async () =>
      delta({
        memories: Array.from({ length: TEST_VALUE_150 }, (_, i) => memory({ id: `arrival-${i}`, time: TEST_VALUE_8 })),
      }),
    list: async () => {
      baselines.count += 1;

      return { memories: [memory({ id: "latest", time: TEST_VALUE_9 })], nextCursor: "next", syncCursor: "fresh" };
    },
  });
  const result = await query({ pageParam: "", signal: new AbortController().signal });
  assert.equal(baselines.count, 1);
  assert.equal(result.memories.length, 1);
  assert.equal(result.syncCursor, "fresh");
});

void test("page boundaries survive insertions, boundary deletion, reordering and refetching only one page", async () => {
  const inserted = mergeMemoryChanges(pages, delta({ memories: [memory({ id: "e", time: TEST_VALUE_6 })] }));
  assert.deepEqual(
    inserted.pages.map((page) => page.memories.map((row) => row.title)),
    [
      ["e", "a", "b"],
      ["c", "d"],
    ],
  );
  const removed = mergeMemoryChanges(inserted, delta({ removedIds: ["b"] }));
  const result = mergeMemoryChanges(
    removed,
    delta({ memories: [memory({ id: "f", time: TEST_VALUE_7 }), memory({ id: "c", time: TEST_VALUE_5 })] }),
  );
  assert.deepEqual(
    result.pages.map((page) => page.memories.map((row) => row.title)),
    [["f", "e", "c", "a"], ["d"]],
  );
  // A refetch with a smaller retained page count discards older cached pages.
  // Fetching from the first page's cursor must not repeat any first-page rows.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const key = ["bounded-memory"];
  const retainedPage = result.pages[0];
  if (!retainedPage) {
    throw new Error(MESSAGE_EXPECTED_FIRST_MEMORY_PAGE);
  }
  client.setQueryData(key, { pages: [retainedPage], pageParams: [""] });
  const observer = new InfiniteQueryObserver(client, {
    queryKey: key,
    initialPageParam: "",
    queryFn: createMemoryListQuery({
      getData: () => client.getQueryData(key),
      sync: async () => delta(),
      list: async ({ before }) => {
        assert.equal(before, boundaryB);

        return { memories: [memory({ id: "d", time: 1 })], nextCursor: null, syncCursor: "v2" };
      },
    }),
    getNextPageParam: (page: MemoryListPage) => page.nextCursor ?? undefined,
  });
  try {
    await observer.fetchNextPage();
    const stored = client.getQueryData<MemoryListData>(key);
    if (!stored) {
      throw new Error(MESSAGE_EXPECTED_STORED_MEMORY_PAGES);
    }
    const rows = stored.pages.flatMap((page) => page.memories);
    assert.deepEqual(
      rows.map((row) => row.title),
      ["f", "e", "c", "a", "d"],
    );
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  } finally {
    observer.destroy();
    client.clear();
  }
});

void test("boundary positions keep timestamp, importance and ID ties in the correct page", () => {
  const a = { ...memory({ id: "a" }), occurredAt: "2026-09-19T10:00:00.123456Z", importance: 1 };
  const b = { ...memory({ id: "b" }), occurredAt: "2026-09-19T10:00:00.123455Z", importance: TEST_VALUE_4 };
  const c = { ...memory({ id: "c" }), occurredAt: b.occurredAt, importance: TEST_VALUE_4 };
  const low = { ...memory({ id: "d" }), occurredAt: b.occurredAt, importance: 1 };
  const boundary = encodeMemoryPosition(c);
  const data = {
    pages: [
      { memories: [a, c], nextCursor: boundary },
      { memories: [b, low], nextCursor: null },
    ],
    pageParams: ["", boundary],
  };
  const result = mergeMemoryChanges(data, delta({ memories: [a, b, c, low] }));
  assert.deepEqual(
    result.pages.map((page) => page.memories.map((row) => row.title)),
    [
      ["a", "c"],
      ["b", "d"],
    ],
  );
  const deleted = mergeMemoryChanges(result, delta({ removedIds: ["a", "c"] }));
  assert.deepEqual(
    deleted.pages.map((page) => page.memories.map((row) => row.title)),
    [[], ["b", "d"]],
  );
  const deletedFirstPage = deleted.pages[0];
  if (!deletedFirstPage) {
    throw new Error(MESSAGE_EXPECTED_FIRST_DELETED_MEMORY_PAGE);
  }
  assert.equal(deletedFirstPage.nextCursor, boundary);
});
