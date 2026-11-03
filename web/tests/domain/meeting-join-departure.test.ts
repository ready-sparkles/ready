import assert from "node:assert/strict";
import test from "node:test";

import {
  MEETING_JOIN_RECONCILE_WAIT_MS,
  reconcilePendingMeetingJoin,
  runMeetingJoinUnlessDeparting,
} from "../../domain/meeting-join-departure";

const MESSAGE_RESPONSE_LOST_AFTER_DB_COMMIT = "Response lost after DB commit";
const MESSAGE_TIMEOUT = "timeout";
const MESSAGE_HTTP_401 = "401";
const MESSAGE_API_UNAVAILABLE = "API unavailable";
const MESSAGE_RESPONSE_FAILED_AFTER_COMMIT = "response failed after commit";
const MESSAGE_FIRST_CORRECTION_FAILED = "first correction failed";
const MESSAGE_LATE_API_FAILURE = "late API failure";

function deferred() {
  const settled: {
    resolve: (value: void | PromiseLike<void>) => void;
    reject: (reason: Error) => void;
  } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<void>((done, fail) => {
    settled.resolve = done;
    settled.reject = fail;
  });

  return { promise, resolve: () => settled.resolve(), reject: (reason: Error) => settled.reject(reason) };
}

[true, false].forEach((isJoinFirst) => {
  [true, false].forEach((isJoinFails) => {
    void test(`reconcile waits for both requests (joinFirst=${isJoinFirst}, joinFails=${isJoinFails})`, async () => {
      const join = deferred(),
        departure = deferred();
      const presence = { isPresent: true, reconciliations: 0 };
      const result = reconcilePendingMeetingJoin({
        pendingJoin: join.promise,
        departure: departure.promise,
        leaveIfDisconnected: async () => {
          presence.reconciliations += 1;
          presence.isPresent = false;
        },
        onLateFailure: () => assert.fail("Unexpected late correction failure"),
      });
      const finishJoin = () => {
        // Even an error response can follow a committed presence update.
        presence.isPresent = true;
        if (isJoinFails) {
          join.reject(new Error(MESSAGE_RESPONSE_LOST_AFTER_DB_COMMIT));
        } else {
          join.resolve();
        }
      };
      const finishLeave = () => {
        presence.isPresent = false;
        departure.resolve();
      };
      if (isJoinFirst) {
        finishJoin();
      } else {
        finishLeave();
      }
      await Promise.resolve();
      assert.equal(presence.reconciliations, 0);
      if (isJoinFirst) {
        finishLeave();
      } else {
        finishJoin();
      }
      await result;
      assert.equal(presence.isPresent, false);
      assert.equal(presence.reconciliations, 1);
    });
  });
});

const TEST_VALUE_2 = 2;
void test("a failed initial departure still reconciles after the join finishes", async () => {
  const reconciliation = { isReconciled: false };
  await reconcilePendingMeetingJoin({
    pendingJoin: Promise.resolve(),
    departure: Promise.reject(new Error(MESSAGE_TIMEOUT)),
    leaveIfDisconnected: async () => {
      reconciliation.isReconciled = true;
    },
    onLateFailure: () => assert.fail("Unexpected late correction failure"),
  });
  assert.equal(reconciliation.isReconciled, true);
});

void test("without an overlapping join there is no extra leave request", async () => {
  await reconcilePendingMeetingJoin({
    pendingJoin: null,
    departure: Promise.resolve(),
    leaveIfDisconnected: async () => assert.fail("unexpected leave"),
    onLateFailure: () => assert.fail("Unexpected late correction failure"),
  });
});

void test("auth retry cannot issue a join after departure starts", async () => {
  const departure = { isDeparting: false, calls: 0 };
  const send = () =>
    runMeetingJoinUnlessDeparting({
      isDeparting: () => departure.isDeparting,
      join: async () => {
        departure.calls += 1;
        throw new Error(MESSAGE_HTTP_401);
      },
    });
  await assert.rejects(send(), /401/);
  // Departure happens while the token refresh is pending.
  departure.isDeparting = true;
  await send();
  assert.equal(departure.calls, 1);
});

void test("reconciliation errors reach the caller for logging", async () => {
  await assert.rejects(
    reconcilePendingMeetingJoin({
      pendingJoin: Promise.resolve(),
      departure: Promise.resolve(),
      leaveIfDisconnected: async () => {
        throw new Error(MESSAGE_API_UNAVAILABLE);
      },
      onLateFailure: () => assert.fail("Unexpected late correction failure"),
    }),
    /API unavailable/,
  );
});

void test("a join that records presence but never responds cannot block correction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const presence = { isPresent: true, corrections: 0 };
  const reconciliation = reconcilePendingMeetingJoin({
    pendingJoin: new Promise(() => {}),
    departure: Promise.resolve(),
    leaveIfDisconnected: async () => {
      presence.corrections += 1;
      presence.isPresent = false;
    },
    onLateFailure: () => assert.fail("Unexpected late correction failure"),
  });
  t.mock.timers.tick(MEETING_JOIN_RECONCILE_WAIT_MS);
  await reconciliation;
  assert.equal(presence.isPresent, false);
  assert.equal(presence.corrections, 1);
});

[false, true].forEach((isFails) => {
  void test(`late join completion gets a second correction (error response: ${isFails})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const join = deferred(),
      corrected = deferred();
    const presence = { isPresent: true, corrections: 0 };
    const reconciliation = reconcilePendingMeetingJoin({
      pendingJoin: join.promise,
      departure: Promise.resolve(),
      leaveIfDisconnected: async () => {
        presence.corrections += 1;
        presence.isPresent = false;
        if (presence.corrections === TEST_VALUE_2) {
          corrected.resolve();
        }
      },
      onLateFailure: () => assert.fail("Unexpected late correction failure"),
    });
    t.mock.timers.tick(MEETING_JOIN_RECONCILE_WAIT_MS);
    await reconciliation;
    assert.equal(presence.isPresent, false);
    // Server work continues after the fallback correction; do not abort or
    // drop this original response and lose our opportunity to reconcile it.
    presence.isPresent = true;
    if (isFails) {
      join.reject(new Error(MESSAGE_RESPONSE_FAILED_AFTER_COMMIT));
    } else {
      join.resolve();
    }
    await corrected.promise;
    assert.equal(presence.isPresent, false);
    assert.equal(presence.corrections, TEST_VALUE_2);
  });
});

void test("late correction is serialized behind a failed first correction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const join = deferred(),
    firstCorrection = deferred(),
    started = deferred(),
    second = deferred();
  const attempts = { corrections: 0 };
  const reconciliation = reconcilePendingMeetingJoin({
    pendingJoin: join.promise,
    departure: Promise.resolve(),
    leaveIfDisconnected: async () => {
      attempts.corrections += 1;
      if (attempts.corrections === 1) {
        started.resolve();
        await firstCorrection.promise;
      } else {
        second.resolve();
      }
    },
    onLateFailure: () => assert.fail("Unexpected late correction failure"),
  });
  const rejected = assert.rejects(reconciliation, /first correction failed/);
  t.mock.timers.tick(MEETING_JOIN_RECONCILE_WAIT_MS);
  await started.promise;
  join.resolve();
  await Promise.resolve();
  assert.equal(attempts.corrections, 1, "late completion must not start an overlapping request");
  firstCorrection.reject(new Error(MESSAGE_FIRST_CORRECTION_FAILED));
  await rejected;
  await second.promise;
  assert.equal(attempts.corrections, TEST_VALUE_2);
});

void test("late correction rejection is reported after the bounded task returned", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const join = deferred(),
    reported = deferred();
  const attempts = { corrections: 0 };
  const error = new Error(MESSAGE_LATE_API_FAILURE);
  await (async () => {
    const reconciliation = reconcilePendingMeetingJoin({
      pendingJoin: join.promise,
      departure: Promise.resolve(),
      leaveIfDisconnected: async () => {
        attempts.corrections += 1;
        if (attempts.corrections === TEST_VALUE_2) {
          throw error;
        }
      },
      onLateFailure: (received) => {
        assert.equal(received, error);
        reported.resolve();
      },
    });
    t.mock.timers.tick(MEETING_JOIN_RECONCILE_WAIT_MS);
    await reconciliation;
  })();
  join.resolve();
  await reported.promise;
});

void test("a normally completed join clears its deadline and sends only one correction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const attempts = { corrections: 0 };
  await reconcilePendingMeetingJoin({
    pendingJoin: Promise.resolve(),
    departure: Promise.resolve(),
    leaveIfDisconnected: async () => {
      attempts.corrections += 1;
    },
    onLateFailure: () => assert.fail("Unexpected late correction failure"),
  });
  t.mock.timers.tick(MEETING_JOIN_RECONCILE_WAIT_MS * TEST_VALUE_2);
  await Promise.resolve();
  assert.equal(attempts.corrections, 1);
});
