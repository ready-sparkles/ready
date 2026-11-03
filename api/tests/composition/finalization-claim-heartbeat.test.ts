import assert from "node:assert/strict";
import test from "node:test";

import { keepMeetingFinalizationClaimAlive } from "../../application/finalization-claim-heartbeat";
import { repositories } from "../../ports/repository-runtime";

const BEAT_MS = 5;
const SEVERAL_BEATS_MS = 40;
const MIN_RENEWALS = 2;
const RENEWALS_UNTIL_LOST = 3;
const WARNINGS_FOR_ERROR_AND_LOSS = 2;
const CONNECTION_RESET_MESSAGE = "connection reset";
const HEARTBEAT_INPUT = { meetingId: "meeting", claimId: "claim", intervalMs: BEAT_MS };

type RenewInput = Parameters<ReturnType<typeof repositories>["renewMeetingFinalization"]>[0];

async function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

void test("a live finalization keeps renewing its own claim until it stops", async (t) => {
  const seen = { renewals: [] as RenewInput[] };
  t.mock.method(repositories(), "renewMeetingFinalization", async (input: RenewInput) => {
    seen.renewals = [...seen.renewals, input];

    return true;
  });
  const logger = { warn: t.mock.fn() };
  const stop = keepMeetingFinalizationClaimAlive({ ...HEARTBEAT_INPUT, logger });
  await wait(SEVERAL_BEATS_MS);
  stop();
  const renewedWhileRunning = seen.renewals.length;
  assert.ok(renewedWhileRunning >= MIN_RENEWALS, `renewed ${renewedWhileRunning} times`);
  assert.ok(seen.renewals.every((input) => input.meetingId === "meeting" && input.claimId === "claim"));
  await wait(SEVERAL_BEATS_MS);
  assert.equal(seen.renewals.length, renewedWhileRunning);
  assert.equal(logger.warn.mock.callCount(), 0);
});

void test("a lost claim stops the heartbeat and is logged; a renewal error only skips a beat", async (t) => {
  const outcomes: (boolean | Error)[] = [new Error(CONNECTION_RESET_MESSAGE), true, false, true];
  const calls = { count: 0 };
  t.mock.method(repositories(), "renewMeetingFinalization", async () => {
    const outcome = outcomes[calls.count] ?? true;
    calls.count += 1;
    if (outcome instanceof Error) {
      throw outcome;
    }

    return outcome;
  });
  const logger = { warn: t.mock.fn() };
  const stop = keepMeetingFinalizationClaimAlive({ ...HEARTBEAT_INPUT, logger });
  await wait(SEVERAL_BEATS_MS * MIN_RENEWALS);
  stop();
  assert.equal(calls.count, RENEWALS_UNTIL_LOST);
  assert.equal(logger.warn.mock.callCount(), WARNINGS_FOR_ERROR_AND_LOSS);
});
