import assert from "node:assert/strict";
import test from "node:test";

import { resolveLiveKitGuestUserId } from "../../adapters/secondary/livekit/livekit-guest-participant";

const requestId = "b02d24ef-5372-4c24-977c-aeb9c33e9b47";
const identity = `guest:${requestId}`;
const request = { meetingId: "meeting", userId: "guest-user", status: "admitted" as const };

void test("guest joins and departures resolve to the attendance user through their join request", async () => {
  await Promise.all(
    [false, true].map(async (isLeaving) => {
      const userId = await resolveLiveKitGuestUserId({
        meetingId: "meeting",
        identity,
        isLeaving,
        getJoinRequest: async (id) => {
          assert.equal(id, requestId);

          return request;
        },
      });
      assert.equal(userId, "guest-user");
    }),
  );
});

void test("unknown or cross-meeting guest identities cannot change attendance", async () => {
  await Promise.all(
    [false, true].map(async (isLeaving) => {
      assert.equal(
        await resolveLiveKitGuestUserId({
          meetingId: "meeting",
          identity,
          isLeaving,
          getJoinRequest: async () => null,
        }),
        null,
      );
      assert.equal(
        await resolveLiveKitGuestUserId({
          meetingId: "other-meeting",
          identity,
          isLeaving,
          getJoinRequest: async () => request,
        }),
        null,
      );
    }),
  );
});

void test("malformed guest identities are ignored without querying UUID columns", async () => {
  await Promise.all(
    ["guest:", "guest:invalid", `${identity}:extra`, requestId, `assistant:${requestId}`].map(async (value) => {
      assert.equal(
        await resolveLiveKitGuestUserId({
          meetingId: "meeting",
          identity: value,
          isLeaving: true,
          getJoinRequest: async () => {
            assert.fail("Malformed identities must not query the database");
          },
        }),
        null,
      );
    }),
  );
});

void test("departures after access removal clean up attendance without allowing late joins", async () => {
  await Promise.all(
    (["denied", "revoked", "expired"] as const).map(async (status) => {
      const lookup = async () => ({ ...request, status });
      assert.equal(
        await resolveLiveKitGuestUserId({
          meetingId: "meeting",
          identity,
          isLeaving: true,
          getJoinRequest: lookup,
        }),
        "guest-user",
      );
      assert.equal(
        await resolveLiveKitGuestUserId({
          meetingId: "meeting",
          identity,
          isLeaving: false,
          getJoinRequest: lookup,
        }),
        null,
      );
    }),
  );
});

void test("waiting requests cannot change attendance", async () => {
  await Promise.all(
    [false, true].map(async (isLeaving) => {
      assert.equal(
        await resolveLiveKitGuestUserId({
          meetingId: "meeting",
          identity,
          isLeaving,
          getJoinRequest: async () => ({
            ...request,
            status: "waiting",
          }),
        }),
        null,
      );
    }),
  );
});
