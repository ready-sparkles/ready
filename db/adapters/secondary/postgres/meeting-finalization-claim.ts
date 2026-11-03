import { randomUUID } from "node:crypto";

import { db } from "./client";

/**
 * Claims post-call finalization for one meeting across every API replica. The meeting id is the
 * primary key, so exactly one concurrent caller inserts the row. A claim older than `leaseMs` is
 * treated as abandoned by a crashed run and can be taken over with a conditional update.
 * Returns the claim id to release, or null when another request owns finalization.
 */
export async function claimMeetingFinalization(input: { meetingId: string; leaseMs: number }): Promise<string | null> {
  const claimId = randomUUID();
  const claimedAt = new Date();
  const inserted = await db.meetingFinalizationClaims.createMany({
    data: [{ meetingId: input.meetingId, claimId, claimedAt }],
    skipDuplicates: true,
  });
  if (inserted.count === 1) {
    return claimId;
  }
  const takenOver = await db.meetingFinalizationClaims.updateMany({
    where: { meetingId: input.meetingId, claimedAt: { lt: new Date(claimedAt.getTime() - input.leaseMs) } },
    data: { claimId, claimedAt },
  });

  return takenOver.count === 1 ? claimId : null;
}

/**
 * Heartbeat for a live run: moves the caller's own claim forward so a run that outlives the lease
 * is not taken over and finalized twice. Returns false once the claim is gone or owned by another run.
 */
export async function renewMeetingFinalization(input: { meetingId: string; claimId: string }): Promise<boolean> {
  const renewed = await db.meetingFinalizationClaims.updateMany({
    where: { meetingId: input.meetingId, claimId: input.claimId },
    data: { claimedAt: new Date() },
  });

  return renewed.count === 1;
}

/** Releases only the caller's own claim, so a run that outlived its lease cannot drop a newer one. */
export async function releaseMeetingFinalization(input: { meetingId: string; claimId: string }): Promise<void> {
  await db.meetingFinalizationClaims.deleteMany({
    where: { meetingId: input.meetingId, claimId: input.claimId },
  });
}

/** True while a finalization claim younger than `freshMs` exists, i.e. a run is likely still in flight. */
export async function hasFreshMeetingFinalizationClaim(input: {
  meetingId: string;
  freshMs: number;
}): Promise<boolean> {
  const fresh = await db.meetingFinalizationClaims.count({
    where: { meetingId: input.meetingId, claimedAt: { gte: new Date(Date.now() - input.freshMs) } },
  });

  return fresh > 0;
}
