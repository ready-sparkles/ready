import "../../composition/env";

import { closeDbPool, db } from "@readymeet/db";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { livekitRoutes } from "../../adapters/primary/http/routes/livekit";
import { signAuthToken } from "../../adapters/primary/http/support/auth";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_UNAUTHORIZED = 401;
const FIXTURE_EPOCH = new Date(0);
const MISSING_ATTENDEE_WORKSPACE_MESSAGE = "Expected an attendee workspace row.";

after(closeDbPool);

async function readAttendeeWorkspaceId(input: { meetingId: string; userId: string }): Promise<string> {
  const rows = await db.meetingAttendeeWorkspaces.findMany({
    where: { meetingId: input.meetingId, userId: input.userId },
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error(MISSING_ATTENDEE_WORKSPACE_MESSAGE);
  }

  return row.workspaceId;
}

void test(
  "authenticated token issuance captures workspace before attendance and ignores body scope",
  { skip: process.env.MEMORY_ISOLATED_DB !== "1" },
  async () => {
    const owner = randomUUID();
    const host = randomUUID();
    const ready = randomUUID();
    const family = randomUUID();
    const external = randomUUID();
    const meeting = randomUUID();
    const ownerEmail = `${owner}@token-workspace.test`;
    const app = Fastify();
    await app.register(livekitRoutes);
    try {
      await db.users.createMany({
        data: [
          { id: owner, email: ownerEmail, displayName: "Fixture" },
          { id: host, email: `${host}@token-workspace.test`, displayName: "Fixture" },
        ],
      });
      await db.workspaces.createMany({
        data: [
          { id: ready, name: "Ready", createdByUserId: owner },
          { id: family, name: "Family", createdByUserId: owner },
          { id: external, name: "Host", createdByUserId: host },
        ],
      });
      await db.workspaceMemberships.createMany({
        data: [
          { userId: owner, workspaceId: ready, role: "owner" },
          { userId: owner, workspaceId: family, role: "owner" },
          { userId: host, workspaceId: external, role: "owner" },
        ],
      });
      await db.users.updateMany({ where: { id: owner }, data: { activeWorkspaceId: ready } });
      await db.meetings.create({
        data: {
          id: meeting,
          title: "Fixture",
          roomName: meeting,
          workspaceId: external,
          createdByUserId: host,
          status: "active",
        },
      });
      await db.meetingParticipants.create({
        data: {
          meetingId: meeting,
          userId: owner,
          joinedAt: FIXTURE_EPOCH,
          leftAt: FIXTURE_EPOCH,
        },
      });
      const payload = { meetingId: meeting, participantName: "Fixture", workspaceId: family };
      assert.equal(
        (await app.inject({ method: "POST", url: "/livekit/token", payload })).statusCode,
        HTTP_STATUS_UNAUTHORIZED,
      );
      const capturedBeforeAuth = await db.meetingAttendeeWorkspaces.findMany({
        where: { meetingId: meeting },
      });
      assert.equal(capturedBeforeAuth.length, 0);
      const headers = {
        authorization: `Bearer ${signAuthToken({ sub: owner, email: ownerEmail, displayName: "Fixture", workspaceId: ready, sessionVersion: 1 })}`,
      };
      const response = await app.inject({
        method: "POST",
        url: "/livekit/token",
        headers,
        payload,
      });
      assert.equal(response.statusCode, HTTP_STATUS_OK);
      assert.equal(await readAttendeeWorkspaceId({ meetingId: meeting, userId: owner }), ready);
      const attendance = await db.meetingAttendanceIntervals.findMany({
        where: { meetingId: meeting },
      });
      assert.equal(attendance.length, 0, "capture precedes room presence");
      await db.users.updateMany({ where: { id: owner }, data: { activeWorkspaceId: family } });
      assert.equal(
        (await app.inject({ method: "POST", url: "/livekit/token", headers, payload })).statusCode,
        HTTP_STATUS_OK,
      );
      assert.equal(await readAttendeeWorkspaceId({ meetingId: meeting, userId: owner }), ready);
    } finally {
      await app.close();
      await db.meetings.deleteMany({ where: { id: meeting } });
      await db.workspaces.deleteMany({ where: { id: { in: [ready, family, external] } } });
      await db.users.deleteMany({ where: { id: { in: [owner, host] } } });
    }
  },
);
