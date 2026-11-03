import { RpcError } from "livekit-client";
import assert from "node:assert/strict";
import test from "node:test";

import {
  guardFailedScreenShareFeature,
  isOptionalLiveServiceFailure,
  OPTIONAL_LIVE_REQUEST_TIMEOUT_MS,
  reportOptionalLiveServiceFailure,
  withOptionalLiveDeadline,
} from "../../../presentation/lib/optional-live-feature-failure";

const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_FORBIDDEN_STATUS = 403;
const HTTP_UNAVAILABLE_STATUS = 503;
const NETWORK_FETCH_FAILURE_MESSAGE = "Failed to fetch";
const INVALID_RESPONSE_SHAPE_MESSAGE = "Invalid response shape";
const UNEXPECTED_RESPONSE_MESSAGE = "Unexpected response";
const PRIVATE_PROVIDER_MESSAGE = "token=private transcript=private";
const EXPECTED_OUTAGE_LOG_COUNT = 2;

void test("optional service outages are isolated without masking authorization or request errors", () => {
  assert.equal(isOptionalLiveServiceFailure({ status: HTTP_UNAVAILABLE_STATUS }), true);
  assert.equal(isOptionalLiveServiceFailure(new TypeError(NETWORK_FETCH_FAILURE_MESSAGE)), true);
  assert.equal(isOptionalLiveServiceFailure({ name: "TimeoutError" }), true);
  assert.equal(isOptionalLiveServiceFailure({ status: HTTP_UNAUTHORIZED_STATUS }), false);
  assert.equal(isOptionalLiveServiceFailure({ status: HTTP_FORBIDDEN_STATUS }), false);
  assert.equal(isOptionalLiveServiceFailure({ status: HTTP_BAD_REQUEST_STATUS }), false);
  assert.equal(isOptionalLiveServiceFailure(new TypeError(INVALID_RESPONSE_SHAPE_MESSAGE)), false);
  assert.equal(isOptionalLiveServiceFailure(new Error(UNEXPECTED_RESPONSE_MESSAGE)), false);
  assert.equal(
    isOptionalLiveServiceFailure(new RpcError(RpcError.ErrorCode.RECIPIENT_NOT_FOUND, NETWORK_FETCH_FAILURE_MESSAGE)),
    true,
  );
  assert.equal(
    isOptionalLiveServiceFailure(new RpcError(RpcError.ErrorCode.SEND_FAILED, NETWORK_FETCH_FAILURE_MESSAGE)),
    true,
  );
  assert.equal(
    isOptionalLiveServiceFailure(new RpcError(RpcError.ErrorCode.APPLICATION_ERROR, INVALID_RESPONSE_SHAPE_MESSAGE)),
    false,
  );
});

void test("a stalled optional operation has a deadline and a late failure stays handled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deferred: { reject?: (reason: Error) => void } = {};
  const operation = new Promise<void>((_resolve, reject) => {
    deferred.reject = reject;
  });
  const timedOut = assert.rejects(withOptionalLiveDeadline(operation), { name: "TimeoutError" });
  t.mock.timers.tick(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS);
  await timedOut;
  deferred.reject?.(new Error(UNEXPECTED_RESPONSE_MESSAGE));
  await Promise.resolve();
});

void test("successful optional operations keep their result and clear their deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(await withOptionalLiveDeadline(Promise.resolve("result")), "result");
  t.mock.timers.tick(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS);
});

void test("outage diagnostics exclude raw provider text and credentials", (t) => {
  const log = t.mock.method(console, "error", () => {});
  const error = Object.assign(new Error(PRIVATE_PROVIDER_MESSAGE), { status: HTTP_UNAVAILABLE_STATUS });
  assert.equal(reportOptionalLiveServiceFailure({ error, feature: "captions" }), true);
  assert.equal(log.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(log.mock.calls[0]?.arguments), /private/);
  error.name = PRIVATE_PROVIDER_MESSAGE;
  reportOptionalLiveServiceFailure({ error, feature: "captions" });
  assert.doesNotMatch(JSON.stringify(log.mock.calls[1]?.arguments), /private/);
  assert.equal(
    reportOptionalLiveServiceFailure({ error: { status: HTTP_FORBIDDEN_STATUS }, feature: "captions" }),
    false,
  );
  assert.equal(log.mock.callCount(), EXPECTED_OUTAGE_LOG_COUNT);
});

const STOPS_AFTER_LATE_PUBLISH = 2;

function createScreenShareRoomDouble(input: { isSharing: boolean }) {
  const listeners = new Set<() => void>();
  const state = { isSharing: input.isSharing, stops: 0 };
  const guardInput = {
    isScreenShareEnabled: () => state.isSharing,
    stopScreenShare: async () => {
      state.stops += 1;
      state.isSharing = false;
    },
    onLocalTrackPublished: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
  const publishScreenShare = () => {
    state.isSharing = true;
    listeners.forEach((listener) => {
      listener();
    });
  };

  return { guardInput, listeners, publishScreenShare, state };
}

void test("a failed screen-share feature stops the current share and any start still in flight", async () => {
  const { guardInput, listeners, publishScreenShare, state } = createScreenShareRoomDouble({ isSharing: true });
  const cleanup = guardFailedScreenShareFeature(guardInput);
  await Promise.resolve();
  assert.equal(state.stops, 1);
  assert.equal(state.isSharing, false);

  // A start that was waiting on the screen picker publishes after the feature failed.
  publishScreenShare();
  await Promise.resolve();
  assert.equal(state.stops, STOPS_AFTER_LATE_PUBLISH);
  assert.equal(state.isSharing, false);

  cleanup();
  assert.equal(listeners.size, 0);
});

void test("a failed screen-share feature leaves a room that is not sharing alone", async () => {
  const { guardInput, state } = createScreenShareRoomDouble({ isSharing: false });
  const cleanup = guardFailedScreenShareFeature(guardInput);
  await Promise.resolve();
  assert.equal(state.stops, 0);
  cleanup();
});
