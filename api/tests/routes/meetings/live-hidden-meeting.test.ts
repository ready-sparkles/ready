import rateLimit from "@fastify/rate-limit";
import * as repo from "@readymeet/db";
import { meetingLiveResponseSchema } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";

import { meetingLifecycleRoutes } from "../../../adapters/primary/http/routes/meetings/meeting-lifecycle";
import { signAuthToken } from "../../../adapters/primary/http/support/auth";

const HTTP_OK = 200;
const FIXTURE_DURATION_MS = 30_000;

type FixtureUser = Awaited<ReturnType<typeof repo.upsertUser>>;

async function removeFixtureRows(userIds: readonly string[]) {
  if (userIds.length === 0) {
    return;
  }
  await repo.db.meetings.deleteMany({ where: { createdByUserId: { in: [...userIds] } } });
  await repo.db.meetingLinks.deleteMany({ where: { createdByUserId: { in: [...userIds] } } });
  await repo.db.workspaces.deleteMany({ where: { createdByUserId: { in: [...userIds] } } });
  await repo.db.users.deleteMany({ where: { id: { in: [...userIds] } } });
}

async function buildLiveRouteHarness(t: TestContext) {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  await app.register(meetingLifecycleRoutes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}");
  const user = await repo.upsertUser({
    email: `${randomUUID()}@live-hidden-meeting.test`,
    displayName: "Fixture",
    source: "auth",
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    try {
      await removeFixtureRows([user.id]);
    } finally {
      await repo.closeDbPool();
    }
  });

  return { app, user };
}

function authHeaders(user: FixtureUser) {
  return {
    authorization: `Bearer ${signAuthToken({
      sub: user.id,
      email: user.email,
      displayName: user.displayName,
      workspaceId: user.workspaceId,
      sessionVersion: user.sessionVersion,
      tokenKind: "full",
      source: user.source,
    })}`,
  };
}

async function createEndedMeeting(input: { user: FixtureUser; hiddenFromHistoryReason: string | null }) {
  const fixture = await repo.createMeetingLinkWithInitialMeeting({
    title: "Fixture",
    code: randomUUID(),
    createdByUserId: input.user.id,
    workspaceId: input.user.workspaceId,
  });
  const endedAt = new Date();
  await repo.db.meetings.updateMany({
    where: { id: fixture.meeting.id },
    data: {
      status: "ended",
      startedAt: new Date(endedAt.getTime() - FIXTURE_DURATION_MS),
      endedAt,
      hiddenFromHistoryAt: input.hiddenFromHistoryReason === null ? null : endedAt,
      hiddenFromHistoryReason: input.hiddenFromHistoryReason,
    },
  });

  return fixture.meeting.id;
}

// These fixtures write only to an explicitly selected disposable database.
void test(
  "live meeting response tells the client when an ended meeting is hidden as too short",
  { skip: process.env.READYMEET_ISOLATED_DB !== "1" },
  async (t) => {
    const { app, user } = await buildLiveRouteHarness(t);
    const hiddenMeetingId = await createEndedMeeting({ user, hiddenFromHistoryReason: "too_short_duration" });
    const listedMeetingId = await createEndedMeeting({ user, hiddenFromHistoryReason: null });

    const hiddenResponse = await app.inject({
      method: "GET",
      url: `/meetings/${hiddenMeetingId}/live`,
      headers: authHeaders(user),
    });
    assert.equal(hiddenResponse.statusCode, HTTP_OK);
    const hidden = meetingLiveResponseSchema.parse(hiddenResponse.json());
    assert.equal(hidden.meeting.status, "ended");
    const disposition = hidden.postMeetingDisposition;
    assert.ok(disposition, "a hidden meeting must carry its post-meeting disposition");
    assert.equal(disposition.status, "skipped");
    assert.equal(disposition.reason, "too_short_duration");
    assert.equal(disposition.redirectTo, "/workspace?view=upcoming");

    const listedResponse = await app.inject({
      method: "GET",
      url: `/meetings/${listedMeetingId}/live`,
      headers: authHeaders(user),
    });
    assert.equal(listedResponse.statusCode, HTTP_OK);
    const listed = meetingLiveResponseSchema.parse(listedResponse.json());
    assert.equal(listed.meeting.status, "ended");
    assert.equal(listed.postMeetingDisposition, null);
  },
);
