import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  claimMeetingFinalization,
  releaseMeetingFinalization,
  renewMeetingFinalization,
} from "../adapters/secondary/postgres/meeting-finalization-claim";
import {
  createMeeting,
  getMeetingById,
  markMeetingEnded,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

const CONCURRENT_REQUESTS = 10;
const LEASE_MS = 60_000;
const EXPIRED_CLAIM_AGE_MS = 120_000;

after(async () => {
  await closeDbPool();
});

async function activeMeeting() {
  const user = await upsertUser({
    email: `${randomUUID()}@finalization-claim.readymeet.test`,
    displayName: "Finalization Claim Tester",
  });
  const meeting = await createMeeting({
    title: "Finalization claim",
    roomName: `finalization-claim-${randomUUID()}`,
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  await db.meetings.update({ where: { id: meeting.id }, data: { status: "active", startedAt: new Date() } });

  return meeting;
}

void test("exactly one of many concurrent requests claims a meeting's finalization", async () => {
  const meeting = await activeMeeting();
  const claims = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () =>
      claimMeetingFinalization({ meetingId: meeting.id, leaseMs: LEASE_MS }),
    ),
  );
  const winners = claims.filter((claim) => claim !== null);
  assert.equal(winners.length, 1);

  const winner = winners.at(0);
  assert.ok(winner !== undefined);
  await releaseMeetingFinalization({ meetingId: meeting.id, claimId: randomUUID() });
  assert.equal(await claimMeetingFinalization({ meetingId: meeting.id, leaseMs: LEASE_MS }), null);

  await releaseMeetingFinalization({ meetingId: meeting.id, claimId: winner });
  assert.notEqual(await claimMeetingFinalization({ meetingId: meeting.id, leaseMs: LEASE_MS }), null);
});

void test("an expired claim from a crashed run is taken over by one request, and the old owner cannot release it", async () => {
  const meeting = await activeMeeting();
  const crashed = await claimMeetingFinalization({ meetingId: meeting.id, leaseMs: LEASE_MS });
  assert.ok(crashed !== null);
  await db.meetingFinalizationClaims.update({
    where: { meetingId: meeting.id },
    data: { claimedAt: new Date(Date.now() - EXPIRED_CLAIM_AGE_MS) },
  });

  const claims = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () =>
      claimMeetingFinalization({ meetingId: meeting.id, leaseMs: LEASE_MS }),
    ),
  );
  const winners = claims.filter((claim) => claim !== null);
  assert.equal(winners.length, 1);

  await releaseMeetingFinalization({ meetingId: meeting.id, claimId: crashed });
  assert.equal(await claimMeetingFinalization({ meetingId: meeting.id, leaseMs: LEASE_MS }), null);
});

void test("a renewed claim outlives its lease, and only its owner can renew it", async () => {
  const meeting = await activeMeeting();
  const owner = await claimMeetingFinalization({ meetingId: meeting.id, leaseMs: LEASE_MS });
  assert.ok(owner !== null);
  await db.meetingFinalizationClaims.update({
    where: { meetingId: meeting.id },
    data: { claimedAt: new Date(Date.now() - EXPIRED_CLAIM_AGE_MS) },
  });
  assert.equal(await renewMeetingFinalization({ meetingId: meeting.id, claimId: randomUUID() }), false);
  assert.equal(await renewMeetingFinalization({ meetingId: meeting.id, claimId: owner }), true);
  assert.equal(await claimMeetingFinalization({ meetingId: meeting.id, leaseMs: LEASE_MS }), null);

  await releaseMeetingFinalization({ meetingId: meeting.id, claimId: owner });
  assert.equal(await renewMeetingFinalization({ meetingId: meeting.id, claimId: owner }), false);
});

void test("markMeetingEnded reports the transition to exactly one concurrent caller and keeps endedAt", async () => {
  const meeting = await activeMeeting();
  const transitions = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () => markMeetingEnded(meeting.id)),
  );
  assert.equal(transitions.filter(Boolean).length, 1);

  const ended = await getMeetingById(meeting.id);
  assert.equal(ended?.status, "ended");
  const endedAt = ended.endedAt;
  assert.ok(endedAt instanceof Date);
  assert.equal(await markMeetingEnded(meeting.id), false);
  const afterRepeat = await getMeetingById(meeting.id);
  assert.equal(afterRepeat?.endedAt?.getTime(), endedAt.getTime());
});
