import {
  ParticipantInfo,
  ParticipantInfo_State as ParticipantInfoState,
  Room,
  RoomServiceClient,
  TwirpError,
} from "livekit-server-sdk";
import assert from "node:assert/strict";
import test from "node:test";

import { listLiveKitParticipants } from "../../adapters/secondary/livekit/livekit";
import {
  listConnectedMeetingUserIds,
  markParticipantLeftIfDisconnected,
  resolveMeetingParticipantUserId,
} from "../../adapters/secondary/livekit/livekit-participant-presence";

const userId = "b02d24ef-5372-4c24-977c-aeb9c33e9b47";
const input = { meetingId: "meeting", roomName: "room", userId };
const connection = (params: { identity: string; sid: string }) =>
  new ParticipantInfo({
    identity: params.identity,
    sid: params.sid,
    state: ParticipantInfoState.ACTIVE,
  });

const LIVEKIT_UNAVAILABLE = "LiveKit unavailable";
const TWIRP_NOT_FOUND = "Not found";
const TWIRP_ROOM_NOT_FOUND = "Room not found";
const TWIRP_NOT_FOUND_CODE = "not_found";
const HTTP_NOT_FOUND = 404;
const TWIRP_CONFLICT = "Conflict";
const ROOM_LOOKUPS_FOR_TWO_ABORTED_CALLS = 2;
const TWIRP_ROOM_HAS_ALREADY_CLOSED = "room has already closed";
const TWIRP_ABORTED = "aborted";
const HTTP_CONFLICT = 409;
const NETWORK_UNAVAILABLE = "Network unavailable";
const TWIRP_UNAUTHORIZED = "Unauthorized";
const HTTP_UNAUTHORIZED = 401;
const TWIRP_UNAUTHENTICATED = "unauthenticated";
const TWIRP_ANOTHER_OPERATION_ABORTED = "another operation aborted";
const TWIRP_UNAVAILABLE = "Unavailable";
const HTTP_SERVICE_UNAVAILABLE = 503;
const TWIRP_UNAVAILABLE_CODE = "unavailable";

void test("leaving one device preserves attendance until the final connection leaves", async () => {
  const roster = {
    participants: [
      connection({ identity: `${userId}:laptop`, sid: "PA_laptop" }),
      connection({ identity: `${userId}:phone`, sid: "PA_phone" }),
    ],
  };
  const markedState: { values: string[] } = { values: [] };
  const dependencies = {
    listParticipants: async (roomName: string) => {
      assert.equal(roomName, "room");

      return roster.participants;
    },
    resolveUserId: resolveMeetingParticipantUserId,
    markLeft: async (value: { meetingId: string; userId: string }) => {
      assert.equal(value.meetingId, "meeting");
      markedState.values = markedState.values.concat(value.userId);

      return null;
    },
  };
  // Explicit leave may arrive before the client's disconnect has completed.
  assert.equal(await markParticipantLeftIfDisconnected({ ...input, dependencies }), false);
  const afterFirstLeave = roster.participants.slice(1);
  roster.participants = afterFirstLeave;
  assert.equal(await markParticipantLeftIfDisconnected({ ...input, dependencies }), false);
  // Duplicate departure delivery must not close the still-connected device.
  assert.equal(await markParticipantLeftIfDisconnected({ ...input, dependencies }), false);
  assert.deepEqual(markedState.values, []);
  const emptyParticipants: ParticipantInfo[] = [];
  Object.assign(roster, { participants: emptyParticipants });
  assert.equal(await markParticipantLeftIfDisconnected({ ...input, dependencies }), true);
  assert.deepEqual(markedState.values, [userId]);
});

void test("a replacement connection with the same identity protects against a delayed departure", async () => {
  assert.equal(
    await markParticipantLeftIfDisconnected({
      ...input,
      dependencies: {
        listParticipants: async () => [connection({ identity: `${userId}:tab`, sid: "PA_replacement" })],
        resolveUserId: resolveMeetingParticipantUserId,
        markLeft: async () => assert.fail("Replacement session must remain present"),
      },
    }),
    false,
  );
});

void test("the live roster protects connections before their join webhook records attendance", async () => {
  const users = await listConnectedMeetingUserIds({
    meetingId: "meeting",
    roomName: "room",
    dependencies: {
      listParticipants: async () => [
        connection({ identity: `${userId}:unrecorded`, sid: "PA_new" }),
        connection({ identity: "readymeet-assistant", sid: "PA_agent" }),
        new ParticipantInfo({
          identity: "d78c476d-1a2c-42e5-af9d-4bde8f96e8fd:old",
          state: ParticipantInfoState.DISCONNECTED,
        }),
      ],
      resolveUserId: resolveMeetingParticipantUserId,
    },
  });
  assert.deepEqual([...users], [userId]);
});

void test("guest and phone connections mapped to the same user preserve attendance", async () => {
  await (["guest:request", "sip-caller"] as const).reduce(async (previous, identity) => {
    await previous;
    assert.equal(
      await markParticipantLeftIfDisconnected({
        ...input,
        dependencies: {
          listParticipants: async () => [connection({ identity, sid: "PA_remaining" })],
          resolveUserId: async ({ meetingId, participant, isLeaving }) => {
            assert.equal(meetingId, input.meetingId);
            assert.equal(participant?.identity, identity);
            assert.equal(isLeaving, true);

            return userId;
          },
          markLeft: async () => assert.fail("Connected guest or caller must remain present"),
        },
      }),
      false,
    );
  }, Promise.resolve());
});

void test("roster failures cannot mark attendance left or prove that a meeting is empty", async () => {
  const dependencies = {
    listParticipants: async (): Promise<ParticipantInfo[]> => {
      throw new Error(LIVEKIT_UNAVAILABLE);
    },
    resolveUserId: resolveMeetingParticipantUserId,
    markLeft: async () => assert.fail("Lookup failure must preserve attendance"),
  };
  await assert.rejects(markParticipantLeftIfDisconnected({ ...input, dependencies }), /LiveKit unavailable/);
  await assert.rejects(
    listConnectedMeetingUserIds({ meetingId: "meeting", roomName: "room", dependencies }),
    /LiveKit unavailable/,
  );
});

void test("only absent rooms or aborted lookups on rooms LiveKit confirms are gone count as an empty roster", async (t) => {
  const lookup = t.mock.method(RoomServiceClient.prototype, "listParticipants", async () => {
    throw new TwirpError(TWIRP_NOT_FOUND, TWIRP_ROOM_NOT_FOUND, HTTP_NOT_FOUND, TWIRP_NOT_FOUND_CODE);
  });
  const roomLookup = t.mock.method(RoomServiceClient.prototype, "listRooms", async () => []);
  assert.deepEqual(await listLiveKitParticipants("missing"), []);
  assert.equal(roomLookup.mock.callCount(), 0);
  lookup.mock.mockImplementation(async () => {
    throw new TwirpError(TWIRP_CONFLICT, TWIRP_ROOM_HAS_ALREADY_CLOSED, HTTP_CONFLICT, TWIRP_ABORTED);
  });
  assert.deepEqual(await listLiveKitParticipants("closed"), []);
  assert.deepEqual(roomLookup.mock.calls.at(-1)?.arguments, [["closed"]]);
  await [
    new Error(NETWORK_UNAVAILABLE),
    new TwirpError(TWIRP_UNAUTHORIZED, TWIRP_UNAUTHORIZED, HTTP_UNAUTHORIZED, TWIRP_UNAUTHENTICATED),
    new TwirpError(TWIRP_UNAVAILABLE, TWIRP_ROOM_HAS_ALREADY_CLOSED, HTTP_SERVICE_UNAVAILABLE, TWIRP_UNAVAILABLE_CODE),
    new TwirpError(TWIRP_UNAUTHORIZED, TWIRP_ROOM_HAS_ALREADY_CLOSED, HTTP_UNAUTHORIZED, TWIRP_UNAUTHENTICATED),
  ].reduce(async (previous, error) => {
    await previous;
    lookup.mock.mockImplementation(async () => {
      throw error;
    });
    const roomLookups = roomLookup.mock.callCount();
    await assert.rejects(listLiveKitParticipants("room"), (received) => received === error);
    assert.equal(roomLookup.mock.callCount(), roomLookups, "only an aborted conflict checks whether the room is gone");
  }, Promise.resolve());
});

void test("an aborted lookup propagates while the room is live or its state cannot be read", async (t) => {
  const aborted = new TwirpError(TWIRP_CONFLICT, TWIRP_ANOTHER_OPERATION_ABORTED, HTTP_CONFLICT, TWIRP_ABORTED);
  t.mock.method(RoomServiceClient.prototype, "listParticipants", async () => {
    throw aborted;
  });
  const roomLookup = t.mock.method(RoomServiceClient.prototype, "listRooms", async () => [new Room({ name: "room" })]);
  await assert.rejects(listLiveKitParticipants("room"), (received) => received === aborted);
  roomLookup.mock.mockImplementation(async () => {
    throw new Error(NETWORK_UNAVAILABLE);
  });
  await assert.rejects(listLiveKitParticipants("room"), { message: NETWORK_UNAVAILABLE });
  assert.equal(roomLookup.mock.callCount(), ROOM_LOOKUPS_FOR_TWO_ABORTED_CALLS);
});
