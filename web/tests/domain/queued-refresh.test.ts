import assert from "node:assert/strict";
import test from "node:test";

import { createQueuedRefresh } from "../../domain/queued-refresh";

const FIRST_POLL_READ = 1;
const SECOND_POLL_READ = 2;
const THIRD_POLL_READ = 3;
const MESSAGE_NETWORK_FAILURE = "Network failure";

void test("events during a poll queue one immediate follow-up that reads the latest state", async () => {
  const firstDeferred = { finish: (() => {}) as () => void };
  const reads = { count: 0 };
  const saved = { value: "pending" };
  const visible = { value: "" };
  const refresh = createQueuedRefresh(async () => {
    reads.count++;
    const snapshot = saved.value;
    if (reads.count === FIRST_POLL_READ) {
      await new Promise<void>((resolve) => {
        firstDeferred.finish = resolve;
      });
    }
    visible.value = snapshot;
  });
  const poll = refresh();
  await Promise.resolve();
  saved.value = "ready";
  const event = refresh();
  void refresh();
  void refresh();
  assert.equal(event, poll);
  assert.equal(reads.count, FIRST_POLL_READ);
  firstDeferred.finish();
  await poll;
  assert.equal(reads.count, SECOND_POLL_READ);
  assert.equal(visible.value, "ready");
});

void test("a failed request still drains an invalidation queued while it was running", async () => {
  const firstDeferred = { reject: ((_error: Error) => {}) as (error: Error) => void };
  const reads = { count: 0 };
  const refresh = createQueuedRefresh(async () => {
    reads.count++;
    if (reads.count === FIRST_POLL_READ) {
      await new Promise<void>((_, reject) => {
        firstDeferred.reject = reject;
      });
    }
  });
  const first = refresh();
  await Promise.resolve();
  void refresh();
  firstDeferred.reject(new Error(MESSAGE_NETWORK_FAILURE));
  await assert.rejects(first, /Network failure/);
  assert.equal(reads.count, SECOND_POLL_READ);
  await refresh();
  assert.equal(reads.count, THIRD_POLL_READ);
});
