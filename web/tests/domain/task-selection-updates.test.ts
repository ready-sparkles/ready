import assert from "node:assert/strict";
import test from "node:test";

import { updateTaskSelection } from "../../domain/task-selection-updates";

const LARGE_SELECTION_COUNT = 1001;
const EXPECTED_CONCURRENCY = 4;
const FAILING_SELECTION_COUNT = 20;
const IMMEDIATE_FAILURE_COUNT = 5;
const RESOLVED_SECOND_TASK = 2;
const REQUEST_FAILED_MESSAGE = "Request failed";
const UNAVAILABLE_MESSAGE = "Unavailable";

const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

void test("large reopen selections never exceed four concurrent requests", async () => {
  const tasks = Array.from({ length: LARGE_SELECTION_COUNT }, (_, index) => index);
  const load = { active: 0, peak: 0 };
  const calls: { values: number[] } = { values: [] };
  const result = await updateTaskSelection({
    tasks,
    update: async (task) => {
      calls.values = [...calls.values, task];
      load.active += 1;
      load.peak = Math.max(load.peak, load.active);
      await tick();
      load.active -= 1;
    },
  });
  assert.equal(load.peak, EXPECTED_CONCURRENCY);
  assert.deepEqual(calls.values, tasks);
  assert.deepEqual(result.updated, tasks);
  assert.deepEqual(result.remaining, []);
});

void test("failure stops queued work, waits for in-flight writes, and identifies exactly what can be retried", async () => {
  const tasks = Array.from({ length: FAILING_SELECTION_COUNT }, (_, index) => index);
  const pending = new Map<number, { resolve: () => void; reject: () => void }>();
  const progress = { isSettled: false };
  const operation = (async () => {
    const result = await updateTaskSelection({
      tasks,
      update: (task) =>
        new Promise<void>((resolve, reject) => {
          pending.set(task, { resolve, reject: () => reject(new Error(REQUEST_FAILED_MESSAGE)) });
        }),
    });
    progress.isSettled = true;

    return result;
  })();
  const started = tasks.slice(0, EXPECTED_CONCURRENCY);
  assert.deepEqual([...pending.keys()], started);
  const first = pending.get(0);
  const second = pending.get(1);
  const resolvedSecond = pending.get(RESOLVED_SECOND_TASK);
  const third = pending.get(started.at(-1) ?? 0);
  if (first === undefined || second === undefined || resolvedSecond === undefined || third === undefined) {
    throw new Error(REQUEST_FAILED_MESSAGE);
  }
  first.reject();
  await tick();
  assert.equal(progress.isSettled, false, "wait for all writes that were already sent");
  second.resolve();
  resolvedSecond.resolve();
  third.reject();
  const result = await operation;
  assert.deepEqual([...pending.keys()], started, "nothing else starts after failure");
  assert.deepEqual(result.updated, [1, RESOLVED_SECOND_TASK]);
  assert.deepEqual(
    result.remaining,
    tasks.filter((task) => task !== 1 && task !== RESOLVED_SECOND_TASK),
  );
});

void test("empty and immediately failing selections do not queue extra work", async () => {
  assert.deepEqual(await updateTaskSelection({ tasks: [], update: async () => assert.fail() }), {
    updated: [],
    remaining: [],
  });
  const stats = { calls: 0 };
  const result = await updateTaskSelection({
    tasks: Array.from({ length: IMMEDIATE_FAILURE_COUNT }, (_, index) => index + 1),
    update: () => {
      stats.calls += 1;
      throw new Error(UNAVAILABLE_MESSAGE);
    },
  });
  assert.equal(stats.calls, 1);
  assert.deepEqual(result, {
    updated: [],
    remaining: Array.from({ length: IMMEDIATE_FAILURE_COUNT }, (_, index) => index + 1),
  });
});
