import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createTimerGroup } from "../../../presentation/lib/timer-group";

const TIMER_MS = 5;
const SETTLE_MS = 30;
const RESCHEDULE_WINDOW_MS = 18;

void test("clear cancels pending timeouts and intervals", async () => {
  const group = createTimerGroup();
  const calls = new Set<string>();
  group.setTimeout({ run: () => calls.add("timeout"), delayMs: TIMER_MS });
  group.setInterval({ run: () => calls.add("interval"), intervalMs: TIMER_MS });
  group.clear();
  await delay(SETTLE_MS);
  assert.equal(calls.size, 0);
});

void test("rescheduled timeouts are still released by clear", async () => {
  const group = createTimerGroup();
  const counter = { fired: 0 };
  const tick = () => {
    counter.fired += 1;
    group.setTimeout({ run: tick, delayMs: TIMER_MS });
  };
  group.setTimeout({ run: tick, delayMs: TIMER_MS });
  await delay(RESCHEDULE_WINDOW_MS);
  group.clear();
  const firedBeforeClear = counter.fired;
  await delay(SETTLE_MS);
  assert.ok(firedBeforeClear >= 1);
  assert.equal(counter.fired, firedBeforeClear);
});
