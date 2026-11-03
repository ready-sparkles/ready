import {
  closeDbPool,
  createGuestAuthSession,
  createGuestUser,
  createMeetingLinkWithInitialMeeting,
  createOrReuseMeetingJoinRequest,
  db,
  decideMeetingJoinRequest,
  getMeetingJoinRequestById,
  hasAdmittedJoinRequestForMeeting,
  markParticipantLeft,
  upsertParticipantPresence,
  upsertUser,
} from "@readymeet/db";
import type { MeetingJoinRequest } from "@readymeet/shared";
import {
  linkGuestSessionResponseSchema,
  meetingJoinRequestListResponseSchema,
  meetingJoinRequestStatusResponseSchema,
} from "@readymeet/shared";
import Fastify, { type FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import type { z } from "zod";

import { authRoutes } from "../../../../../adapters/primary/http/routes/auth";
import { meetingLinkRoutes } from "../../../../../adapters/primary/http/routes/meetings/meeting-links";
import { signAuthToken } from "../../../../../adapters/primary/http/support/auth";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_UNAUTHORIZED = 401;
const GUEST_AUTH_SESSION_TTL_MS = 60_000;

type GuestWaitingScenario = "waiting" | "admitted" | "denied" | "duplicate" | "host";

type GuestWaitingFixtures = {
  host: Awaited<ReturnType<typeof upsertUser>>;
  target: Awaited<ReturnType<typeof upsertUser>>;
  guest: Awaited<ReturnType<typeof createGuestUser>>;
  meeting: Awaited<ReturnType<typeof createMeetingLinkWithInitialMeeting>>["meeting"];
  meetingLink: Awaited<ReturnType<typeof createMeetingLinkWithInitialMeeting>>["meetingLink"];
  original: Awaited<ReturnType<typeof createOrReuseMeetingJoinRequest>>;
  existing: Awaited<ReturnType<typeof createOrReuseMeetingJoinRequest>> | null;
  fullToken: string;
  guestToken: string;
  app: FastifyInstance;
};

function parseInjectJson<T>(input: { response: { json(): unknown }; schema: z.ZodType<T> }): T {
  const body: unknown = input.response.json();

  return input.schema.parse(body);
}

function parseLinkGuestSessionRequest(
  linkResponse: z.infer<typeof linkGuestSessionResponseSchema>,
): MeetingJoinRequest {
  const request = linkResponse.request;
  assert.ok(request);

  return request;
}

async function createGuestWaitingFixtures(input: {
  scenario: GuestWaitingScenario;
  t: TestContext;
}): Promise<GuestWaitingFixtures> {
  const host = await upsertUser({ email: `${randomUUID()}@waiting.test`, displayName: "Host" });
  const target =
    input.scenario === "host"
      ? host
      : await upsertUser({ email: `${randomUUID()}@waiting.test`, displayName: "Signed-in Person" });
  const guest = await createGuestUser({ displayName: "Old guest name" });
  const { meeting, meetingLink } = await createMeetingLinkWithInitialMeeting({
    title: "Waiting test",
    code: randomUUID(),
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
  });
  const original = await createOrReuseMeetingJoinRequest({
    meetingLinkId: meetingLink.id,
    meetingId: meeting.id,
    userId: guest.id,
    displayName: guest.displayName,
  });
  const existing =
    input.scenario === "duplicate"
      ? await createOrReuseMeetingJoinRequest({
          meetingLinkId: meetingLink.id,
          meetingId: meeting.id,
          userId: target.id,
          displayName: target.displayName,
        })
      : null;
  if (input.scenario === "admitted" || input.scenario === "denied") {
    await decideMeetingJoinRequest({
      requestId: original.id,
      meetingId: meeting.id,
      decidedByUserId: host.id,
      status: input.scenario,
    });
  }
  const secret = randomUUID();
  const session = await createGuestAuthSession({
    userId: guest.id,
    meetingLinkId: meetingLink.id,
    meetingId: meeting.id,
    joinRequestId: original.id,
    secretHash: createHash("sha256").update(secret).digest("hex"),
    expiresAt: new Date(Date.now() + GUEST_AUTH_SESSION_TTL_MS),
  });
  const fullToken = signAuthToken({
    sub: target.id,
    email: target.email,
    displayName: target.displayName,
    workspaceId: target.workspaceId,
  });
  const guestToken = signAuthToken({
    sub: guest.id,
    email: guest.email,
    displayName: guest.displayName,
    source: "guest",
    tokenKind: "guest",
    guestSessionId: session.id,
    guestSessionSecret: secret,
    joinRequestId: original.id,
    meetingLinkId: meetingLink.id,
    workspaceId: host.workspaceId,
  });
  const app = Fastify();
  await app.register(authRoutes);
  await app.register(meetingLinkRoutes);
  input.t.after(async () => {
    await app.close();
    await db.meetings.deleteMany({ where: { id: meeting.id } });
    await db.meetingLinks.deleteMany({ where: { id: meetingLink.id } });
    await db.workspaces.deleteMany({ where: { id: { in: [host.workspaceId, target.workspaceId] } } });
    await db.users.deleteMany({ where: { id: { in: [host.id, target.id, guest.id] } } });
  });

  return { host, target, guest, meeting, meetingLink, original, existing, fullToken, guestToken, app };
}

async function assertGuestSessionLinkAndStatus(input: {
  fixtures: GuestWaitingFixtures;
  scenario: GuestWaitingScenario;
}): Promise<MeetingJoinRequest> {
  const { app, fullToken, guestToken, existing, original, target, host } = input.fixtures;
  const { scenario } = input;
  const link = () =>
    app.inject({
      method: "POST",
      url: "/auth/link-guest-session",
      headers: { authorization: `Bearer ${fullToken}` },
      payload: { guestToken },
    });
  const linked = await link();
  assert.equal(linked.statusCode, HTTP_STATUS_OK, linked.body);
  const request = parseLinkGuestSessionRequest(
    parseInjectJson({ response: linked, schema: linkGuestSessionResponseSchema }),
  );
  assert.equal(request.id, existing?.id ?? original.id);
  assert.equal(request.userId, target.id);
  assert.equal(request.displayName, target.displayName);
  assert.equal(request.status, scenario === "duplicate" || scenario === "host" ? "waiting" : scenario);
  assert.equal((await link()).statusCode, HTTP_STATUS_OK, "same-account retries are idempotent");
  if (scenario !== "host") {
    const forbidden = await app.inject({
      method: "POST",
      url: "/auth/link-guest-session",
      headers: {
        authorization: `Bearer ${signAuthToken({ sub: host.id, email: host.email, displayName: host.displayName })}`,
      },
      payload: { guestToken },
    });
    assert.equal(forbidden.statusCode, HTTP_STATUS_UNAUTHORIZED, "proof cannot be replayed to another account");
  }
  const status = await app.inject({
    url: `/meeting-join-requests/${request.id}`,
    headers: { authorization: `Bearer ${fullToken}` },
  });
  assert.equal(status.statusCode, HTTP_STATUS_OK, status.body);
  const statusPayload = parseInjectJson({ response: status, schema: meetingJoinRequestStatusResponseSchema });
  assert.equal(statusPayload.hasActiveParticipants, false, "a scheduled host is not present");

  return request;
}

async function assertWaitingPresencePoll(input: {
  fixtures: GuestWaitingFixtures;
  request: MeetingJoinRequest;
}): Promise<void> {
  const { app, fullToken, meeting, host } = input.fixtures;
  const poll = async () => {
    const response = await app.inject({
      url: `/meeting-join-requests/${input.request.id}`,
      headers: { authorization: `Bearer ${fullToken}` },
    });

    return parseInjectJson({ response, schema: meetingJoinRequestStatusResponseSchema });
  };
  await upsertParticipantPresence({ meetingId: meeting.id, userId: host.id, role: "host" });
  assert.equal((await poll()).hasActiveParticipants, true);
  await markParticipantLeft({ meetingId: meeting.id, userId: host.id });
  assert.equal((await poll()).hasActiveParticipants, false);
}

async function assertWaitingOrDuplicateAdmission(input: {
  fixtures: GuestWaitingFixtures;
  request: MeetingJoinRequest;
}): Promise<void> {
  const { host, meeting, target } = input.fixtures;
  assert.equal(await hasAdmittedJoinRequestForMeeting({ meetingId: meeting.id, userId: target.id }), false);
  const admitted = await decideMeetingJoinRequest({
    requestId: input.request.id,
    meetingId: meeting.id,
    decidedByUserId: host.id,
    status: "admitted",
  });
  assert.equal(admitted?.userId, target.id);
  assert.equal(await hasAdmittedJoinRequestForMeeting({ meetingId: meeting.id, userId: target.id }), true);
}

async function assertHostScenarioResolution(input: {
  fixtures: GuestWaitingFixtures;
  request: MeetingJoinRequest;
}): Promise<void> {
  const { app, fullToken, meeting, meetingLink } = input.fixtures;
  const resolve = () =>
    app.inject({
      method: "POST",
      url: `/meeting-links/${meetingLink.code}/resolve`,
      headers: { authorization: `Bearer ${fullToken}` },
    });
  const resolved = await resolve();
  assert.equal(resolved.statusCode, HTTP_STATUS_OK, resolved.body);
  assert.equal((await getMeetingJoinRequestById(input.request.id))?.status, "admitted");
  const waiting = await app.inject({
    url: `/meetings/${meeting.id}/join-requests`,
    headers: { authorization: `Bearer ${fullToken}` },
  });
  assert.equal(waiting.statusCode, HTTP_STATUS_OK, waiting.body);
  const waitingPayload = parseInjectJson({ response: waiting, schema: meetingJoinRequestListResponseSchema });
  assert.equal(
    waitingPayload.requests.some((item) => item.id === input.request.id),
    false,
  );
  assert.equal((await resolve()).statusCode, HTTP_STATUS_OK, "repeated host entry remains valid");
  assert.equal((await getMeetingJoinRequestById(input.request.id))?.status, "admitted");
}

async function assertGuestWaitingScenarioOutcomes(input: {
  scenario: GuestWaitingScenario;
  fixtures: GuestWaitingFixtures;
  request: MeetingJoinRequest;
}): Promise<void> {
  const { scenario, fixtures, request } = input;
  if (scenario === "waiting") {
    await assertWaitingPresencePoll({ fixtures, request });
  }
  if (scenario === "waiting" || scenario === "duplicate") {
    await assertWaitingOrDuplicateAdmission({ fixtures, request });
  }
  if (scenario === "host") {
    await assertHostScenarioResolution({ fixtures, request });
  }
  if (fixtures.existing) {
    assert.equal((await getMeetingJoinRequestById(fixtures.original.id))?.status, "revoked");
  }
  assert.equal((await getMeetingJoinRequestById(request.id))?.userId, fixtures.target.id);
}

async function runGuestSignInWaitingScenario(input: { scenario: GuestWaitingScenario; t: TestContext }): Promise<void> {
  const fixtures = await createGuestWaitingFixtures(input);
  const request = await assertGuestSessionLinkAndStatus({ fixtures, scenario: input.scenario });
  await assertGuestWaitingScenarioOutcomes({ scenario: input.scenario, fixtures, request });
}

after(closeDbPool);

(["waiting", "admitted", "denied", "duplicate", "host"] as const).forEach((scenario) => {
  void test(`guest sign-in preserves ${scenario} admission and changes the waiting identity`, async (t) => {
    await runGuestSignInWaitingScenario({ scenario, t });
  });
});
