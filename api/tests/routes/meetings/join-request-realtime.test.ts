import "../../../composition/env";

import { closeDbPool, createMeetingLinkWithInitialMeeting, db, upsertUser } from "@readymeet/db";
import { configureRealtimePublisher, type RealtimeEvent } from "@readymeet/db/ports/realtime";
import {
  joinRequestRealtimeChannels,
  joinRequestRealtimePayloadSchema,
  meetingJoinRequestResponseSchema,
  meetingJoinRequestsRealtimeChannels,
} from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { meetingLinkRoutes } from "../../../adapters/primary/http/routes/meetings/meeting-links";
import { signAuthToken } from "../../../adapters/primary/http/support/auth";

const HTTP_STATUS_OK = 200;

const captured: { events: RealtimeEvent[] } = { events: [] };
configureRealtimePublisher(async (event) => {
  captured.events = [...captured.events, event];
});

const cleanup: { userIds: string[]; workspaceIds: string[]; meetingLinkIds: string[] } = {
  userIds: [],
  workspaceIds: [],
  meetingLinkIds: [],
};

after(async () => {
  await Promise.all(cleanup.meetingLinkIds.map((id) => db.meetings.deleteMany({ where: { meetingLinkId: id } })));
  await Promise.all(cleanup.meetingLinkIds.map((id) => db.meetingLinks.deleteMany({ where: { id } })));
  await Promise.all(cleanup.userIds.map((id) => db.users.deleteMany({ where: { id } })));
  await Promise.all(cleanup.workspaceIds.map((id) => db.workspaces.deleteMany({ where: { id } })));
  await closeDbPool();
});

async function createHostedMeeting() {
  const app = Fastify();
  await app.register(meetingLinkRoutes);
  const host = await upsertUser({ email: `${randomUUID()}@join-request-realtime.test`, displayName: "Host" });
  cleanup.userIds = [...cleanup.userIds, host.id];
  cleanup.workspaceIds = [...cleanup.workspaceIds, host.workspaceId];
  const { meeting, meetingLink } = await createMeetingLinkWithInitialMeeting({
    title: "Waiting room",
    code: randomUUID(),
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
  });
  cleanup.meetingLinkIds = [...cleanup.meetingLinkIds, meetingLink.id];

  return { app, host, meeting, meetingLink };
}

function publishedChannels(eventName: string): string[] {
  return captured.events.filter((event) => event.eventName === eventName).map((event) => event.channel);
}

void test("asking to join and being admitted both reach the host and the guest", async () => {
  const { app, host, meeting, meetingLink } = await createHostedMeeting();
  captured.events = [];

  const created = await app.inject({
    method: "POST",
    url: `/meeting-links/${meetingLink.code}/join-requests`,
    payload: { displayName: "Guest" },
  });
  assert.equal(created.statusCode, HTTP_STATUS_OK, created.body);
  const { request, guestSession } = meetingJoinRequestResponseSchema.parse(created.json());
  if (guestSession) {
    cleanup.userIds = [...cleanup.userIds, guestSession.user.id];
  }
  const expectedChannels = [
    ...joinRequestRealtimeChannels({ workspaceId: host.workspaceId, requestId: request.id }),
    ...meetingJoinRequestsRealtimeChannels({ workspaceId: host.workspaceId, meetingId: meeting.id }),
  ];
  assert.deepEqual(publishedChannels("join-request.created"), expectedChannels);

  const admitted = await app.inject({
    method: "POST",
    url: `/meetings/${meeting.id}/join-requests/${request.id}/admit`,
    headers: {
      authorization: `Bearer ${signAuthToken({
        sub: host.id,
        email: host.email,
        displayName: host.displayName,
        workspaceId: host.workspaceId,
        sessionVersion: host.sessionVersion,
        tokenKind: "full",
        source: host.source,
      })}`,
    },
  });
  assert.equal(admitted.statusCode, HTTP_STATUS_OK, admitted.body);
  assert.deepEqual(publishedChannels("join-request.admitted"), expectedChannels);

  const admittedEvent = captured.events.find((event) => event.eventName === "join-request.admitted");
  const payload = joinRequestRealtimePayloadSchema.parse(admittedEvent?.payload);
  assert.equal(payload.request.status, "admitted");
  assert.equal(payload.meeting?.id, meeting.id);
  await app.close();
});

const REALTIME_OUTAGE_MESSAGE = "realtime unavailable";

void test("asking to join still succeeds and reaches the host list when realtime publishing is down", async (t) => {
  const { app, host, meeting, meetingLink } = await createHostedMeeting();
  configureRealtimePublisher(async () => {
    throw new Error(REALTIME_OUTAGE_MESSAGE);
  });
  t.after(() => {
    configureRealtimePublisher(async (event) => {
      captured.events = [...captured.events, event];
    });
  });

  const created = await app.inject({
    method: "POST",
    url: `/meeting-links/${meetingLink.code}/join-requests`,
    payload: { displayName: "Guest" },
  });
  assert.equal(created.statusCode, HTTP_STATUS_OK, created.body);
  const { request, guestSession } = meetingJoinRequestResponseSchema.parse(created.json());
  if (guestSession) {
    cleanup.userIds = [...cleanup.userIds, guestSession.user.id];
  }
  assert.equal(request.status, "waiting");

  const listed = await app.inject({
    method: "GET",
    url: `/meetings/${meeting.id}/join-requests`,
    headers: {
      authorization: `Bearer ${signAuthToken({
        sub: host.id,
        email: host.email,
        displayName: host.displayName,
        workspaceId: host.workspaceId,
        sessionVersion: host.sessionVersion,
        tokenKind: "full",
        source: host.source,
      })}`,
    },
  });
  assert.equal(listed.statusCode, HTTP_STATUS_OK, listed.body);
  assert.equal(listed.body.includes(request.id), true, listed.body);
  await app.close();
});
