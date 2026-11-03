import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeRealtimeSetup,
  recoverFailedRealtimeChannel,
  shouldRefetchForRealtimeContinuity,
  shouldSubscribeToJoinedMeetingChannel,
  subscribeAndTrackRealtimeChannel,
} from "../../domain/realtime-subscription";

void test("setup cancelled while auth is pending never continues to subscribe", async () => {
  const isCancelledState = { isCancelled: false };
  const authGate: { resolve: (() => void) | undefined } = { resolve: undefined };
  const subscribeCount = { value: 0 };
  const authorized = authorizeRealtimeSetup({
    refreshAuth: () =>
      new Promise<void>((resolve) => {
        authGate.resolve = resolve;
      }),
    isCancelled: () => isCancelledState.isCancelled,
  });

  isCancelledState.isCancelled = true;
  authGate.resolve?.();
  if (await authorized) {
    subscribeCount.value += 1;
  }

  assert.equal(subscribeCount.value, 0);
});

void test("meeting-scoped realtime waits until a signed-in participant has joined", () => {
  assert.equal(
    shouldSubscribeToJoinedMeetingChannel({
      hasJoinedMeeting: false,
      isGuestSession: false,
    }),
    false,
  );
  assert.equal(
    shouldSubscribeToJoinedMeetingChannel({
      hasJoinedMeeting: true,
      isGuestSession: true,
    }),
    false,
  );
  assert.equal(
    shouldSubscribeToJoinedMeetingChannel({
      hasJoinedMeeting: true,
      isGuestSession: false,
    }),
    true,
  );
});

void test("a capability-failed channel explicitly reattaches after authorization", async () => {
  const attachCount = { value: 0 };
  await recoverFailedRealtimeChannel({
    state: "failed",
    attach: () => {
      attachCount.value += 1;
    },
  });
  await recoverFailedRealtimeChannel({
    state: "attached",
    attach: () => {
      attachCount.value += 1;
    },
  });

  assert.equal(attachCount.value, 1);
});

void test("a realtime subscription that resolves after cancellation is immediately removed", async () => {
  const subscriptionGate: { finish: (() => void) | undefined } = { finish: undefined };
  const isCancelledState = { isCancelled: false };
  const unsubscribeCount = { value: 0 };
  const detachCount = { value: 0 };
  const channel = { name: "join-request:test" };
  const subscribedChannels = new Set<typeof channel>();
  const pendingSubscription = new Promise<void>((resolve) => {
    subscriptionGate.finish = resolve;
  });
  const subscription = subscribeAndTrackRealtimeChannel({
    channel,
    subscribe: () => pendingSubscription,
    unsubscribe: () => {
      unsubscribeCount.value += 1;
    },
    detach: () => {
      detachCount.value += 1;
    },
    isCancelled: () => isCancelledState.isCancelled,
    subscribedChannels,
  });

  isCancelledState.isCancelled = true;
  subscriptionGate.finish?.();
  await subscription;

  assert.equal(unsubscribeCount.value, 1);
  assert.equal(detachCount.value, 1);
  assert.equal(subscribedChannels.size, 0);
});

void test("realtime recovery refetches on every attached or update event that lost continuity", () => {
  assert.equal(shouldRefetchForRealtimeContinuity({ eventName: "attached", stateChange: { resumed: false } }), true);
  assert.equal(shouldRefetchForRealtimeContinuity({ eventName: "update", stateChange: { resumed: false } }), true);
  assert.equal(shouldRefetchForRealtimeContinuity({ eventName: "attached", stateChange: { resumed: true } }), false);
  assert.equal(shouldRefetchForRealtimeContinuity({ eventName: "failed", stateChange: { resumed: false } }), false);
});
