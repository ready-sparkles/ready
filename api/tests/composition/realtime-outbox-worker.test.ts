import { configureRealtimePublisher, publishRealtimeEvents } from "@readymeet/db/ports/realtime";
import assert from "node:assert/strict";
import test from "node:test";

import { isLegacyJoinRequestCapabilityError } from "../../adapters/secondary/ably/realtime-publisher";

const EXPECTED_TEST_COUNT_40160 = 40160;
const EXPECTED_TEST_COUNT_401 = 401;
const UNAUTHORIZED_TO_PUBLISH_TO_CHANNEL_MESSAGE = "Unauthorized to publish to channel";
const CONNECTION_RESET_MESSAGE = "connection reset";
const PUBLISH_UNAVAILABLE_MESSAGE = "publish unavailable";

void test("legacy join-request capability failures remain compatibility misses", () => {
  assert.equal(isLegacyJoinRequestCapabilityError({ code: EXPECTED_TEST_COUNT_40160 }), true);
  assert.equal(
    isLegacyJoinRequestCapabilityError({
      statusCode: EXPECTED_TEST_COUNT_401,
      message: UNAUTHORIZED_TO_PUBLISH_TO_CHANNEL_MESSAGE,
    }),
    true,
  );
  assert.equal(isLegacyJoinRequestCapabilityError(new Error(CONNECTION_RESET_MESSAGE)), false);
});
void test("realtime publication is awaited and failures reach the request", async () => {
  configureRealtimePublisher(async () => {
    throw new Error(PUBLISH_UNAVAILABLE_MESSAGE);
  });
  try {
    await assert.rejects(
      publishRealtimeEvents([{ channel: "meeting:test", eventName: "changed", payload: {} }]),
      /publish unavailable/,
    );
  } finally {
    configureRealtimePublisher(async () => {});
  }
});
