import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import {
  createGuestAuthSession,
  createGuestUser,
  createMeetingLinkWithInitialMeeting,
  createOrReuseMeetingJoinRequest,
  ensureWorkspaceMembership,
  getMeetingById,
  transferGuestMeetingAccessToUser,
  upsertUser,
} from "../../../../adapters/secondary/postgres/repositories";
import { setMeetingConfidentiality } from "../../../../adapters/secondary/postgres/workspace-admin";
import { configureRealtimePublisher, type RealtimeEvent } from "../../../../ports/realtime";

const MESSAGE_PUBLISH_FAILURE = "Injected confidentiality publisher failure.";
const SESSION_EXPIRY = new Date("2099-01-01T00:00:00Z");
const JOINED_AT = new Date("2026-10-17T10:00:00Z");
const LEFT_AT = new Date("2026-10-17T10:05:00Z");
const TRANSFERRED_TASK_REVISION = 2;

after(closeDbPool);

async function fixture() {
  const host = await upsertUser({ email: `${randomUUID()}@transfer.test`, displayName: "Host" });
  const target = await upsertUser({ email: `${randomUUID()}@transfer.test`, displayName: "Target" });
  const guest = await createGuestUser({ displayName: "Guest" });
  await ensureWorkspaceMembership({ workspaceId: host.workspaceId, userId: target.id });
  const { meeting, meetingLink } = await createMeetingLinkWithInitialMeeting({
    title: "Guest confidentiality transfer",
    code: randomUUID(),
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
  });
  await setMeetingConfidentiality({
    meetingId: meeting.id,
    isConfidential: false,
    source: "manual",
    actorUserId: host.id,
  });
  await db.meetings.updateMany({ where: { id: meeting.id }, data: { status: "active" } });
  await db.meetingParticipants.create({
    data: { meetingId: meeting.id, userId: guest.id, joinedAt: JOINED_AT, leftAt: LEFT_AT },
  });
  await db.meetingAttendanceIntervals.create({
    data: { meetingId: meeting.id, userId: guest.id, joinedAt: JOINED_AT, leftAt: LEFT_AT },
  });
  const request = await createOrReuseMeetingJoinRequest({
    meetingLinkId: meetingLink.id,
    meetingId: meeting.id,
    userId: guest.id,
    displayName: guest.displayName,
  });
  const session = await createGuestAuthSession({
    userId: guest.id,
    meetingLinkId: meetingLink.id,
    meetingId: meeting.id,
    joinRequestId: request.id,
    secretHash: randomUUID(),
    expiresAt: SESSION_EXPIRY,
  });
  const taskListId = randomUUID();
  const taskId = randomUUID();
  await db.meetingTaskLists.create({ data: { id: taskListId, meetingId: meeting.id } });
  await db.meetingTasks.create({
    data: {
      id: taskId,
      taskListId,
      meetingId: meeting.id,
      title: "Guest task",
      type: "task",
      confidence: "high",
      sourceReason: "Guest transfer fixture",
      ownerUserId: guest.id,
    },
  });

  return { host, target, guest, meeting, request, session, taskId };
}

async function durableState(input: Awaited<ReturnType<typeof fixture>>) {
  const { meeting, target, guest, request, session, taskId } = input;
  const attendance = await db.meetingAttendanceIntervals.findMany({
    where: { meetingId: meeting.id, userId: target.id },
    select: { /** @external Prisma field */ joinedAt: true, /** @external Prisma field */ leftAt: true },
  });
  const filings = await db.meetingAttendeeWorkspaces.findMany({
    where: { meetingId: meeting.id, userId: target.id },
    select: { /** @external Prisma field */ workspaceId: true },
  });
  const sessions = await db.guestAuthSessions.findMany({
    where: { id: session.id },
    select: { /** @external Prisma field */ linkedToUserId: true, /** @external Prisma field */ revokedAt: true },
  });
  const requests = await db.meetingJoinRequests.findMany({
    where: { id: request.id },
    select: { /** @external Prisma field */ userId: true },
  });
  const tasks = await db.meetingTasks.findMany({
    where: { id: taskId },
    select: { /** @external Prisma field */ ownerUserId: true, /** @external Prisma field */ revision: true },
  });
  const guestParticipants = await db.meetingParticipants.findMany({
    where: { meetingId: meeting.id, userId: guest.id },
    select: { /** @external Prisma field */ id: true },
  });
  const targetParticipants = await db.meetingParticipants.findMany({
    where: { meetingId: meeting.id, userId: target.id },
    select: { /** @external Prisma field */ joinedAt: true, /** @external Prisma field */ leftAt: true },
  });

  return { attendance, filings, sessions, requests, tasks, guestParticipants, targetParticipants };
}

void test("a confidentiality publish failure follows durable guest attendance, filing, task, join and session linking; retry is safe", async (t) => {
  const f = await fixture();
  const notifications: { events: RealtimeEvent[] } = { events: [] };
  const publishError = new Error(MESSAGE_PUBLISH_FAILURE);
  configureRealtimePublisher(async (event) => {
    notifications.events = [...notifications.events, event];
    throw publishError;
  });
  t.after(() => {
    configureRealtimePublisher(async () => undefined);
  });
  const transfer = { guestUserId: f.guest.id, targetUserId: f.target.id, targetWorkspaceId: f.host.workspaceId };
  await assert.rejects(transferGuestMeetingAccessToUser(transfer), (error: unknown) => error === publishError);
  const state = await durableState(f);
  assert.deepEqual(state.attendance, [{ joinedAt: JOINED_AT, leftAt: LEFT_AT }]);
  assert.deepEqual(state.filings, [{ workspaceId: f.host.workspaceId }]);
  assert.equal(state.sessions[0]?.linkedToUserId, f.target.id);
  assert.ok(state.sessions[0].revokedAt);
  assert.deepEqual(state.requests, [{ userId: f.target.id }]);
  assert.deepEqual(state.tasks, [{ ownerUserId: f.target.id, revision: TRANSFERRED_TASK_REVISION }]);
  assert.deepEqual(state.guestParticipants, []);
  assert.deepEqual(state.targetParticipants, [{ joinedAt: JOINED_AT, leftAt: LEFT_AT }]);
  const meeting = await getMeetingById(f.meeting.id);
  assert.equal(meeting?.isConfidential, true);
  assert.equal(meeting.confidentialitySource, "auto");
  assert.equal(notifications.events.length, 1);
  assert.equal(notifications.events[0]?.eventName, "meeting.confidentiality.changed");
  assert.equal(notifications.events[0].payload.isConfidential, true);
  assert.equal(notifications.events[0].payload.confidentialitySource, "auto");
  assert.equal(notifications.events[0].payload.actorUserId, null);
  assert.deepEqual(await transferGuestMeetingAccessToUser(transfer), []);
  assert.deepEqual(await durableState(f), state, "retry neither loses nor duplicates attendance or changes linkage");
  assert.equal(notifications.events.length, 1, "retry is safe even while publisher still fails");
});
