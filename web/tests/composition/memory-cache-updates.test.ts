import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_MAX_PAGES, trimInactiveMemoryQueries } from "../../composition/memory-cache-limits";
import { memoryChannelName, removeForgottenMemories } from "../../composition/memory-cache-updates";
import { boundPersistedMemoryQueries } from "../../composition/memory-persisted-cache";

const MESSAGE_EXPECTED_IN_FLIGHT_QUERY = "Expected the in-flight query to start";
const MESSAGE_EXPECTED_MEMORY_PAGE = "Expected a memory page";
const MESSAGE_EXPECTED_PAGED_ROWS = "Expected paged rows";
const MESSAGE_EXPECTED_PERSISTED_MEMORY = "Expected a persisted memory";
const MESSAGE_EXPECTED_PREVIOUS_PAGE = "Expected a previous page";
const MESSAGE_OFFLINE = "offline";

const TEST_VALUE_1000 = 1000;
const TEST_VALUE_1024 = 1024;
const TEST_VALUE_2 = 2;
const TEST_VALUE_20 = 20;
const TEST_VALUE_3 = 3;
const TEST_VALUE_4 = 4;
const TEST_VALUE_40 = 40;
const TEST_VALUE_49 = 49;
const TEST_VALUE_50 = 50;
const TEST_VALUE_6 = 6;
const TEST_VALUE_98_950 = 98_950;
void test("Forget removes every filtered cache and person summary before a failed refresh", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scope = ["relationship-memory", "user", "workspace"];
  const data = { pages: [{ memories: [{ id: "forgotten" }, { id: "keep" }], nextCursor: "stable" }], pageParams: [""] };
  [{}, { q: "query" }].forEach((filter) => {
    client.setQueryData([...scope, "list", filter], data);
  });
  const firstPage = data.pages[0];
  if (!firstPage) {
    throw new Error(MESSAGE_EXPECTED_MEMORY_PAGE);
  }
  client.setQueryData([...scope, "person", "person"], {
    memories: firstPage.memories,
    projection: { summary: ["forgotten"] },
  });
  client.setQueryData([...scope, "evidence", "forgotten"], { evidence: ["private quote"] });
  client.setQueryData(["relationship-memory", "other", "workspace", "list"], data);
  try {
    await removeForgottenMemories({ client, scope, ids: ["forgotten"] });
    client.getQueriesData<typeof data>({ queryKey: [...scope, "list"] }).forEach(([, cached]) => {
      assert.deepEqual(cached?.pages[0]?.memories, [{ id: "keep" }]);
      assert.equal(cached.pages[0].nextCursor, "stable");
    });
    assert.equal(client.getQueryData<{ projection: unknown }>([...scope, "person", "person"])?.projection, null);
    assert.equal(client.getQueryData([...scope, "evidence", "forgotten"]), undefined);
    assert.deepEqual(client.getQueryData(["relationship-memory", "other", "workspace", "list"]), data);
    await assert.rejects(
      client.fetchQuery({
        queryKey: [...scope, "list", {}],
        queryFn: async () => {
          throw new Error(MESSAGE_OFFLINE);
        },
      }),
    );
    assert.deepEqual(client.getQueryData<typeof data>([...scope, "list", {}])?.pages[0]?.memories, [{ id: "keep" }]);
    assert.notEqual(
      memoryChannelName({ userId: "user", workspaceId: "workspace" }),
      memoryChannelName({
        userId: "other",
        workspaceId: "workspace",
      }),
    );
  } finally {
    client.clear();
  }
});

void test("persistent caches cap pages, query count, and encoded bytes", () => {
  const queries = Array.from({ length: TEST_VALUE_40 }, (_, i) => ({
    queryKey: ["relationship-memory", "user", "ws", "list", { q: String(i) }],
    state: {
      dataUpdatedAt: i,
      data: {
        pages: Array.from({ length: TEST_VALUE_20 }, () => ({ memories: [{ title: "x".repeat(TEST_VALUE_1000) }] })),
        pageParams: Array.from({ length: TEST_VALUE_20 }, () => "cursor"),
      },
    },
  }));
  const saved = boundPersistedMemoryQueries(queries);
  assert.equal(saved.length, TEST_VALUE_6);
  assert.ok(saved.every((query) => query.state.data.pages.length === TEST_VALUE_4));
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).length < TEST_VALUE_2 * TEST_VALUE_1024 * TEST_VALUE_1024);
  const oversized = queries[0];
  const oversizedMemory = oversized?.state.data.pages[0]?.memories[0];
  if (!oversized || !oversizedMemory) {
    throw new Error(MESSAGE_EXPECTED_PERSISTED_MEMORY);
  }
  oversizedMemory.title = "x".repeat(TEST_VALUE_3 * TEST_VALUE_1024 * TEST_VALUE_1024);
  assert.equal(boundPersistedMemoryQueries([oversized]).length, 0);
});

void test("a response started before Forget cannot resurrect removed rows", async () => {
  const client = new QueryClient();
  const scope = ["relationship-memory", "user", "ws"];
  const key = [...scope, "list"];
  const old = { pages: [{ memories: [{ id: "forgotten" }], nextCursor: null }], pageParams: [""] };
  client.setQueryData(key, old);
  const release: { current: ((value: typeof old) => void) | null } = { current: null };
  const pending = (async () => {
    try {
      return await client.fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<typeof old>((resolve) => {
            release.current = resolve;
          }),
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      return undefined;
    }
  })();
  try {
    await removeForgottenMemories({ client, scope, ids: ["forgotten"] });
    const resolveQuery = release.current;
    if (!resolveQuery) {
      throw new Error(MESSAGE_EXPECTED_IN_FLIGHT_QUERY);
    }
    resolveQuery(old);
    await pending;
    assert.deepEqual(client.getQueryData<typeof old>(key)?.pages[0]?.memories, []);
  } finally {
    client.clear();
  }
});

void test("inactive filter caches are evicted without touching other users or unrelated queries", () => {
  const client = new QueryClient();
  try {
    Array.from({ length: TEST_VALUE_50 }, (_, i) => i).forEach((i) => {
      client.setQueryData(["relationship-memory", "user", "ws", "list", { q: String(i) }], { i });
    });
    client.setQueryData(["relationship-memory", "other", "ws", "list"], "other");
    trimInactiveMemoryQueries({ client, scope: ["relationship-memory", "user", "ws"] });
    assert.equal(
      client.getQueryCache().findAll({ queryKey: ["relationship-memory", "user", "ws"] }).length,
      TEST_VALUE_6,
    );
    assert.equal(client.getQueryData(["relationship-memory", "other", "ws", "list"]), "other");
  } finally {
    client.clear();
  }
});

void test("rolling query traverses 100,000 rows with at most 1,000 cached and can page backward", async () => {
  const client = new QueryClient();
  const total = 100_000;
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ["scale"],
    initialPageParam: 0,
    maxPages: MEMORY_MAX_PAGES,
    queryFn: async ({ pageParam }) => ({
      start: pageParam,
      rows: Array.from({ length: TEST_VALUE_50 }, (_, i) => pageParam + i),
    }),
    getNextPageParam: (page) => (page.start + TEST_VALUE_50 < total ? page.start + TEST_VALUE_50 : undefined),
    getPreviousPageParam: (page) => (page.start > 0 ? page.start - TEST_VALUE_50 : undefined),
  });
  const start = performance.now();
  try {
    const maximum = await Array.from({ length: total / TEST_VALUE_50 }, (_, index) => index * TEST_VALUE_50).reduce(
      async (previous, offset) => {
        const currentMaximum = await previous;
        const result = await observer.fetchNextPage();
        const pages = result.data?.pages;
        if (!pages) {
          throw new Error(MESSAGE_EXPECTED_PAGED_ROWS);
        }
        const rows = pages.flatMap((page) => page.rows);
        assert.equal(rows.at(-1), offset + TEST_VALUE_49);
        assert.equal(new Set(rows).size, rows.length);
        assert.ok(rows.length <= TEST_VALUE_1000);

        return Math.max(currentMaximum, rows.length);
      },
      Promise.resolve(0),
    );
    const previous = await observer.fetchPreviousPage();
    const previousPage = previous.data?.pages[0];
    if (!previousPage) {
      throw new Error(MESSAGE_EXPECTED_PREVIOUS_PAGE);
    }
    assert.equal(previousPage.start, TEST_VALUE_98_950);
    console.error(
      JSON.stringify({
        benchmark: "synthetic-client-pagination",
        records: total,
        maximumCachedRows: maximum,
        elapsedMs: Math.round(performance.now() - start),
      }),
    );
  } finally {
    observer.destroy();
    client.clear();
  }
});
