import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  createMeetingLinkWithInitialMeeting,
  createOrReuseMeetingJoinRequest,
  ensureWorkspaceMembership,
  listActiveJoinRequestChannelsForUser,
  listHostJoinRequestChannelsForUser,
  listParticipantMeetingChannelsForUser,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";
import { restoreWorkspaceMember, suspendWorkspaceMember } from "../adapters/secondary/postgres/workspace-admin";

after(closeDbPool);
void test("realtime grants exclude suspended hosts and requesters but preserve external attendees and restored members", async (t) => {
  const owner = await upsertUser({ email: `${randomUUID()}@realtime.test`, displayName: "Owner" });
  const host = await upsertUser({ email: `${randomUUID()}@realtime.test`, displayName: "Host" });
  const external = await upsertUser({ email: `${randomUUID()}@realtime.test`, displayName: "External" });
  const workspaceId = owner.workspaceId;
  await ensureWorkspaceMembership({ workspaceId, userId: host.id, role: "member" });
  const { meeting, meetingLink } = await createMeetingLinkWithInitialMeeting({
    title: "Realtime",
    code: randomUUID(),
    createdByUserId: host.id,
    workspaceId,
  });
  t.after(async () => {
    await db.meetings.deleteMany({ where: { id: meeting.id } });
    await db.meetingLinks.deleteMany({ where: { id: meetingLink.id } });
    await db.workspaces.deleteMany({ where: { createdByUserId: { in: [owner.id, host.id, external.id] } } });
    await db.users.deleteMany({ where: { id: { in: [owner.id, host.id, external.id] } } });
  });
  await db.meetingParticipants.create({
    data: {
      meetingId: meeting.id,
      userId: external.id,
      role: "host",
    },
  });
  const request = await createOrReuseMeetingJoinRequest({
    meetingLinkId: meetingLink.id,
    meetingId: meeting.id,
    userId: host.id,
    displayName: "Host",
  });
  const check = async (options: { userId: string; isAllowed: boolean }) => {
    const channelLists = [
      await listParticipantMeetingChannelsForUser(options.userId),
      await listHostJoinRequestChannelsForUser(options.userId),
    ];
    channelLists.forEach((rows) => {
      assert.equal(
        rows.some((row) => row.meetingId === meeting.id),
        options.isAllowed,
      );
    });
  };
  await check({ userId: host.id, isAllowed: true });
  await suspendWorkspaceMember({ workspaceId, actorUserId: owner.id, targetUserId: host.id });
  await check({ userId: host.id, isAllowed: false });
  assert.equal(
    (await listActiveJoinRequestChannelsForUser(host.id)).some((row) => row.requestId === request.id),
    false,
  );
  await check({ userId: external.id, isAllowed: true });
  await restoreWorkspaceMember({ workspaceId, actorUserId: owner.id, targetUserId: host.id, role: "member" });
  await check({ userId: host.id, isAllowed: true });
  assert.equal(
    (await listActiveJoinRequestChannelsForUser(host.id)).some((row) => row.requestId === request.id),
    true,
  );
});
