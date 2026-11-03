import assert from "node:assert/strict";
import { test } from "node:test";

import { db, pool } from "../adapters/secondary/postgres/client";
import { withMeetingLinkCallInLock } from "../adapters/secondary/postgres/meeting-call-in-lock";

const SETUP_WAIT_MS = 360_000;
const TWO_SLOT_POOL_MAX = 3;
const DEFAULT_POOL_MAX = 10;
const SINGLE_SLOT_POOL_MAX = 2;
const MAX_CONCURRENT_OPERATIONS = 2;
const PROVIDER_FAILURE_MESSAGE = "Call-in operation failed";
const CAPACITY_TIMEOUT_MESSAGE = "Timed out waiting for meeting call-in setup capacity.";

function deferred() {
  const gate: { resolve: (() => void) | null } = { resolve: null };
  const promise = new Promise<void>((done) => {
    gate.resolve = done;
  });
  if (gate.resolve === null) {
    throw new TypeError(String(gate.resolve));
  }

  return { promise, resolve: gate.resolve };
}

void test("call-in lock serializes the same link and passes the database connection", async (t) => {
  const release = deferred();
  const calls: { current: string[] } = { current: [] };
  const first = withMeetingLinkCallInLock({
    meetingLinkId: "same-link",
    operation: async (connection) => {
      assert.equal(connection, db);
      calls.current = [...calls.current, "first"];
      await release.promise;

      return "first result";
    },
  });
  t.after(async () => {
    release.resolve();
    await first;
  });
  const operation = async () => {
    calls.current = [...calls.current, "second"];

    return "second result";
  };
  assert.equal(await withMeetingLinkCallInLock({ meetingLinkId: "same-link", operation }), null);
  const second = withMeetingLinkCallInLock({ meetingLinkId: "same-link", operation, wait: true });
  assert.deepEqual(calls.current, ["first"]);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first result", "second result"]);
  assert.deepEqual(calls.current, ["first", "second"]);
});

[
  { poolMax: 1, limit: 1 },
  { poolMax: SINGLE_SLOT_POOL_MAX, limit: 1 },
  { poolMax: TWO_SLOT_POOL_MAX, limit: MAX_CONCURRENT_OPERATIONS },
  { poolMax: DEFAULT_POOL_MAX, limit: MAX_CONCURRENT_OPERATIONS },
].forEach(({ poolMax, limit }) => {
  void test(`call-in lock allows ${limit} operations with pool max ${poolMax}`, async (t) => {
    const originalMax = pool.options.max;
    pool.options.max = poolMax;
    const release = deferred();
    const started = { count: 0 };
    const running = Array.from({ length: limit }, (_, index) =>
      withMeetingLinkCallInLock({
        meetingLinkId: `capacity-${index}`,
        operation: async () => {
          started.count += 1;
          await release.promise;

          return index;
        },
      }),
    );
    t.after(async () => {
      release.resolve();
      await Promise.all(running);
      pool.options.max = originalMax;
    });
    assert.equal(started.count, limit);
    const operation = async () => {
      started.count += 1;

      return "resumed";
    };
    assert.equal(await withMeetingLinkCallInLock({ meetingLinkId: "waiting", operation }), null);
    const waiting = withMeetingLinkCallInLock({ meetingLinkId: "waiting", operation, wait: true });
    assert.equal(started.count, limit);
    release.resolve();
    await Promise.all(running);
    assert.equal(await waiting, "resumed");
    assert.equal(started.count, limit + 1);
  });
});

void test("call-in lock releases the link and capacity and wakes waiters after an error", async (t) => {
  const originalMax = pool.options.max;
  pool.options.max = 1;
  const release = deferred();
  const failure = new Error(PROVIDER_FAILURE_MESSAGE);
  const first = withMeetingLinkCallInLock({
    meetingLinkId: "failed-link",
    operation: async () => {
      await release.promise;
      throw failure;
    },
  });
  const rejection = assert.rejects(first, (error) => error === failure);
  t.after(async () => {
    release.resolve();
    await rejection;
    pool.options.max = originalMax;
  });
  const waiting = withMeetingLinkCallInLock({
    meetingLinkId: "failed-link",
    operation: async () => "recovered",
    wait: true,
  });
  release.resolve();
  await rejection;
  assert.equal(await waiting, "recovered");
  assert.equal(
    await withMeetingLinkCallInLock({ meetingLinkId: "another-link", operation: async () => "capacity released" }),
    "capacity released",
  );
});

void test("call-in lock wait times out without running or releasing the blocked operation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const release = deferred();
  const first = withMeetingLinkCallInLock({
    meetingLinkId: "timeout-link",
    operation: async () => release.promise,
  });
  t.after(async () => {
    release.resolve();
    await first;
  });
  const operation = t.mock.fn(async () => "unexpected");
  const waiting = withMeetingLinkCallInLock({ meetingLinkId: "timeout-link", operation, wait: true });
  const rejection = assert.rejects(waiting, { message: CAPACITY_TIMEOUT_MESSAGE });
  t.mock.timers.tick(SETUP_WAIT_MS - 1);
  assert.equal(operation.mock.callCount(), 0);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(operation.mock.callCount(), 0);
  assert.equal(await withMeetingLinkCallInLock({ meetingLinkId: "timeout-link", operation }), null);
  release.resolve();
  await first;
  assert.equal(await withMeetingLinkCallInLock({ meetingLinkId: "timeout-link", operation }), "unexpected");
});
