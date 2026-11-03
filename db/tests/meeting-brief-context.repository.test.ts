import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  createMeeting,
  listMeetingBriefPastMeetingContextCandidates,
  updateMeetingTimeline,
  upsertParticipantPresence,
  upsertSummaryForMeeting,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

const MEETING_BRIEF_CONTEXT_LIMIT = 8;

after(async () => {
  await closeDbPool();
});

void test("meeting brief past meeting candidates exclude hidden and future meetings", async () => {
  const owner = await upsertUser({
    email: `${randomUUID()}@readymeet.test`,
    displayName: "Brief Owner",
  });
  const guest = await upsertUser({
    email: `${randomUUID()}@acme.com`,
    displayName: "Personaz",
  });

  const visible = await createMeeting({
    title: "Acme onboarding rollout planning",
    roomName: `room-${randomUUID()}`,
    createdByUserId: owner.id,
    workspaceId: owner.workspaceId,
  });
  await upsertParticipantPresence({ meetingId: visible.id, userId: owner.id, role: "host" });
  await upsertParticipantPresence({ meetingId: visible.id, userId: guest.id, role: "guest" });
  await updateMeetingTimeline({
    meetingId: visible.id,
    startedAt: new Date("2026-05-01T09:00:00.000Z"),
    endedAt: new Date("2026-05-01T10:00:00.000Z"),
    status: "ended",
  });
  await upsertSummaryForMeeting({
    meetingId: visible.id,
    content: "- Personaz would send the final rollout list.",
    model: "test",
  });

  const hidden = await createMeeting({
    title: "Hidden Acme planning",
    roomName: `room-${randomUUID()}`,
    createdByUserId: owner.id,
    workspaceId: owner.workspaceId,
  });
  await upsertParticipantPresence({ meetingId: hidden.id, userId: owner.id, role: "host" });
  await updateMeetingTimeline({
    meetingId: hidden.id,
    startedAt: new Date("2026-05-02T09:00:00.000Z"),
    endedAt: new Date("2026-05-02T10:00:00.000Z"),
    status: "ended",
  });
  await db.meetings.updateMany({
    where: { id: hidden.id },
    data: { hiddenFromHistoryAt: new Date(), hiddenFromHistoryReason: "test" },
  });

  const future = await createMeeting({
    title: "Future Acme planning",
    roomName: `room-${randomUUID()}`,
    createdByUserId: owner.id,
    workspaceId: owner.workspaceId,
  });
  await upsertParticipantPresence({ meetingId: future.id, userId: owner.id, role: "host" });
  await updateMeetingTimeline({
    meetingId: future.id,
    startedAt: new Date("2026-05-20T09:00:00.000Z"),
    endedAt: new Date("2026-05-20T10:00:00.000Z"),
    status: "ended",
  });

  const candidates = await listMeetingBriefPastMeetingContextCandidates({
    userId: owner.id,
    before: new Date("2026-05-09T10:00:00.000Z"),
    limit: MEETING_BRIEF_CONTEXT_LIMIT,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.meetingId),
    [visible.id],
  );
  assert.equal(candidates[0]?.summary, "- Personaz would send the final rollout list.");
  assert.equal(
    candidates[0].participants.some((participant) => participant.email === guest.email),
    true,
  );
});
