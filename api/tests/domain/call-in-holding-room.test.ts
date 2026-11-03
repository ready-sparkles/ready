import assert from "node:assert/strict";
import test from "node:test";

import {
  callerDisplayNameFromSipAttributes,
  callInCallerParticipantInfo,
  callInHoldingRoomPrefix,
  getSipCallId,
  isCallInHoldingRoomName,
  parseMeetingLinkIdFromHoldingRoomName,
} from "../../domain/call-in-holding-room";

const MEETING_LINK_ID = "0f2a7e54-9c1d-4b6a-8f3e-2d5c1a9b7e60";

void test("holding room names round-trip through the prefix builder and parser", () => {
  const prefix = callInHoldingRoomPrefix(MEETING_LINK_ID);
  const roomName = `${prefix}+15551234567_abc123`;

  assert.ok(isCallInHoldingRoomName(roomName));
  assert.equal(parseMeetingLinkIdFromHoldingRoomName(roomName), MEETING_LINK_ID);
});

void test("meeting and unrelated room names are not treated as holding rooms", () => {
  assert.equal(isCallInHoldingRoomName(`ready-${MEETING_LINK_ID}`), false);
  assert.equal(parseMeetingLinkIdFromHoldingRoomName(`ready-${MEETING_LINK_ID}`), null);
  assert.equal(parseMeetingLinkIdFromHoldingRoomName("call-hold-not-a-uuid-suffix"), null);
});

void test("SIP call id parsing trims and rejects empty values", () => {
  assert.equal(getSipCallId({ "sip.callID": " call-123 " }), "call-123");
  assert.equal(getSipCallId({ "sip.callID": "  " }), null);
  assert.equal(getSipCallId({}), null);
  assert.equal(getSipCallId(undefined), null);
});

void test("caller display name masks all but the last four digits", () => {
  assert.equal(callerDisplayNameFromSipAttributes({ "sip.phoneNumber": "+1 (555) 123-4567" }), "Caller ...4567");
  assert.equal(callerDisplayNameFromSipAttributes({ "sip.phoneNumber": "911" }), "Phone caller");
  assert.equal(callerDisplayNameFromSipAttributes({ "sip.phoneNumber": "anonymous" }), "Phone caller");
  assert.equal(callerDisplayNameFromSipAttributes(undefined), "Phone caller");
});

void test("admission stamps the guest identity onto the SIP participant", () => {
  const GUEST_USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const info = callInCallerParticipantInfo({
    userId: GUEST_USER_ID,
    displayName: "Caller ...4567",
  });

  assert.equal(info.name, "Caller ...4567");
  // The transcriber and web speaker labels recognize humans through the
  // userId attribute; this key is a cross-service contract.
  assert.deepEqual(info.attributes, { userId: GUEST_USER_ID });
});
