import "../../../composition/env";

import rateLimit from "@fastify/rate-limit";
import {
  closeDbPool,
  createGuestAuthSession,
  createGuestUser,
  createMeetingLinkWithInitialMeeting,
  createOrReuseMeetingJoinRequest,
  decideMeetingJoinRequest,
  upsertUser,
} from "@readymeet/db";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { meetingLifecycleRoutes } from "../../../adapters/primary/http/routes/meetings/meeting-lifecycle";
import { signAuthToken } from "../../../adapters/primary/http/support/auth";

type TestUser = Awaited<ReturnType<typeof upsertUser>>;

const DIAGNOSTICS_FIXTURES_NOT_READY_MESSAGE = "Diagnostics fixtures are not ready";
const DIAGNOSTICS_ROUTE_TEST_TITLE = "Diagnostics route test";
const OTHER_DIAGNOSTICS_ROUTE_TEST_TITLE = "Other diagnostics route test";
const MEETING_DIAGNOSTICS_CODE_PREFIX = "diag-";
const MEETING_LINK_CODE_SLICE_LENGTH = 8;

const GUEST_SECRET_BYTE_LENGTH = 32;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MILLISECONDS_PER_SECOND = 1000;
const GUEST_SESSION_TTL_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;

const AUTHENTICATED_MEDIA_QUALITY_RATE_LIMIT_MAX = 20;
const AUTHENTICATED_DIAGNOSTIC_RATE_LIMIT_MAX = 60;
const MEDIA_QUALITY_REQUESTS_BEYOND_LIMIT = AUTHENTICATED_MEDIA_QUALITY_RATE_LIMIT_MAX + 1;
const MEDIA_QUALITY_MAX_BATCH_SIZE = AUTHENTICATED_MEDIA_QUALITY_RATE_LIMIT_MAX + 1;

const QUALITY_REPORT_SAMPLED_AT_MS = 10000;
const RECEIVED_QUALITY_WIDTH = 480;
const RECEIVED_QUALITY_HEIGHT = 270;
const RECEIVED_QUALITY_FPS = 30;
const RECEIVED_QUALITY_BITRATE = 110000;
const RECEIVED_QUALITY_DISPLAY_WIDTH = 1280;
const RECEIVED_QUALITY_DISPLAY_HEIGHT = 720;
const RECEIVED_QUALITY_PACKET_LOSS = 0.01;
const RECEIVED_QUALITY_FREEZE_COUNT = 2;
const INVALID_RECEIVED_QUALITY_PACKET_LOSS = 2;

const SENT_QUALITY_LEVEL = 1;
const SENT_QUALITY_WIDTH = 1920;
const SENT_QUALITY_HEIGHT = 1080;
const SENT_QUALITY_FPS = 20;
const SENT_QUALITY_BITRATE = 2000000;
const SENT_QUALITY_RTT_MS = 50;

const diagnosticsFixture: {
  owner: TestUser | undefined;
  outsider: TestUser | undefined;
  meetingId: string | undefined;
  admittedGuestToken: string | undefined;
  waitingGuestToken: string | undefined;
  crossMeetingGuestToken: string | undefined;
} = {
  owner: undefined,
  outsider: undefined,
  meetingId: undefined,
  admittedGuestToken: undefined,
  waitingGuestToken: undefined,
  crossMeetingGuestToken: undefined,
};

function createMeetingDiagnosticsLinkCode() {
  return `${MEETING_DIAGNOSTICS_CODE_PREFIX}${randomUUID().slice(0, MEETING_LINK_CODE_SLICE_LENGTH)}`;
}

function requireDiagnosticsFixture() {
  const { owner, outsider, meetingId, admittedGuestToken, waitingGuestToken, crossMeetingGuestToken } =
    diagnosticsFixture;
  if (
    owner === undefined ||
    outsider === undefined ||
    meetingId === undefined ||
    admittedGuestToken === undefined ||
    waitingGuestToken === undefined ||
    crossMeetingGuestToken === undefined
  ) {
    throw new Error(DIAGNOSTICS_FIXTURES_NOT_READY_MESSAGE);
  }

  return { owner, outsider, meetingId, admittedGuestToken, waitingGuestToken, crossMeetingGuestToken };
}

function tokenFor(user: TestUser) {
  return signAuthToken({
    sub: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    plan: user.plan,
    workspaceId: user.workspaceId,
    sessionVersion: user.sessionVersion,
    tokenKind: "full",
    source: user.source,
  });
}

async function createGuestToken(input: {
  meetingId: string;
  meetingLinkId: string;
  workspaceId: string;
  isAdmitted: boolean;
  decidingOwner: TestUser;
}) {
  const guest = await createGuestUser({ displayName: "Diagnostics Guest" });
  const joinRequest = await createOrReuseMeetingJoinRequest({
    meetingLinkId: input.meetingLinkId,
    meetingId: input.meetingId,
    userId: guest.id,
    displayName: guest.displayName,
  });
  if (input.isAdmitted) {
    await decideMeetingJoinRequest({
      requestId: joinRequest.id,
      meetingId: input.meetingId,
      decidedByUserId: input.decidingOwner.id,
      status: "admitted",
    });
  }

  const secret = randomBytes(GUEST_SECRET_BYTE_LENGTH).toString("base64url");
  const session = await createGuestAuthSession({
    userId: guest.id,
    meetingLinkId: input.meetingLinkId,
    meetingId: input.meetingId,
    joinRequestId: joinRequest.id,
    secretHash: createHash("sha256").update(secret).digest("hex"),
    expiresAt: new Date(Date.now() + GUEST_SESSION_TTL_MS),
  });

  return signAuthToken({
    sub: guest.id,
    email: guest.email,
    displayName: guest.displayName,
    avatarUrl: null,
    plan: "free",
    workspaceId: input.workspaceId,
    sessionVersion: 1,
    tokenKind: "guest",
    source: "guest",
    meetingLinkId: input.meetingLinkId,
    meetingId: input.meetingId,
    joinRequestId: joinRequest.id,
    guestSessionId: session.id,
    guestSessionSecret: secret,
  });
}

async function createTestApp() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { global: false });
  await app.register(meetingLifecycleRoutes);
  await app.ready();

  return app;
}

const receivedQualityReport = {
  event: "media-quality",
  phase: "in-room",
  kind: "camera",
  direction: "received",
  outcome: "changed",
  sampledAt: QUALITY_REPORT_SAMPLED_AT_MS,
  trackSid: "TR_remote_camera",
  codec: "av1",
  width: RECEIVED_QUALITY_WIDTH,
  height: RECEIVED_QUALITY_HEIGHT,
  fps: RECEIVED_QUALITY_FPS,
  bitrate: RECEIVED_QUALITY_BITRATE,
  displayWidth: RECEIVED_QUALITY_DISPLAY_WIDTH,
  displayHeight: RECEIVED_QUALITY_DISPLAY_HEIGHT,
  packetLoss: RECEIVED_QUALITY_PACKET_LOSS,
  freezeCount: RECEIVED_QUALITY_FREEZE_COUNT,
  qualitySignal: "sustained-low-resolution",
};
const sentQualityReport = {
  event: "media-quality",
  phase: "in-room",
  kind: "camera",
  direction: "sent",
  outcome: "succeeded",
  sampledAt: QUALITY_REPORT_SAMPLED_AT_MS,
  trackSid: "TR_camera",
  action: "reduce",
  level: SENT_QUALITY_LEVEL,
  reason: "cpu",
  codec: "av1",
  width: SENT_QUALITY_WIDTH,
  height: SENT_QUALITY_HEIGHT,
  fps: SENT_QUALITY_FPS,
  bitrate: SENT_QUALITY_BITRATE,
  availableBitrate: null,
  rttMs: SENT_QUALITY_RTT_MS,
  /** @external media quality diagnostic wire field */
  powerEfficientEncoder: false,
};

const diagnosticEndpoints = [
  {
    name: "receiver quality diagnostics",
    path: "media-quality",
    limit: AUTHENTICATED_MEDIA_QUALITY_RATE_LIMIT_MAX,
    validPayload: { reports: [receivedQualityReport] },
    // Valid except for the out-of-range loss ratio.
    invalidPayload: { reports: [{ ...receivedQualityReport, packetLoss: INVALID_RECEIVED_QUALITY_PACKET_LOSS }] },
  },
  {
    name: "camera quality diagnostics",
    path: "media-quality",
    limit: AUTHENTICATED_MEDIA_QUALITY_RATE_LIMIT_MAX,
    validPayload: { reports: [sentQualityReport, receivedQualityReport] },
    // Valid except for raw transport data, which the strict schema must reject.
    invalidPayload: { reports: [{ ...sentQualityReport, sdp: "must not accept raw transport information" }] },
  },
  {
    name: "client diagnostics",
    path: "client-diagnostics",
    limit: AUTHENTICATED_DIAGNOSTIC_RATE_LIMIT_MAX,
    validPayload: {
      event: "join-started",
      phase: "token",
      outcome: "started",
      /** @external client diagnostics wire field */
      microphoneRequested: true,
      /** @external client diagnostics wire field */
      cameraRequested: true,
      microphonePermission: "prompt",
      cameraPermission: "prompt",
      /** @external client diagnostics wire field */
      selectedDevice: false,
    },
    invalidPayload: {
      event: "join-started",
      phase: "in-room",
      outcome: "degraded",
    },
  },
  {
    name: "media diagnostics",
    path: "media-diagnostics",
    limit: AUTHENTICATED_DIAGNOSTIC_RATE_LIMIT_MAX,
    validPayload: {
      kind: "microphone",
      phase: "join-acquire",
      failure: "permission-denied",
      /** @external client media diagnostic wire field */
      selectedDevice: false,
      /** @external client media diagnostic wire field */
      fallbackAttempted: false,
      /** @external client media diagnostic wire field */
      recovered: false,
    },
    invalidPayload: {
      kind: "microphone",
      phase: "not-a-phase",
    },
  },
] as const;

before(async () => {
  const owner = await upsertUser({
    email: `${randomUUID()}@meeting-diagnostics.readymeet.test`,
    displayName: "Diagnostics Owner",
  });
  const outsider = await upsertUser({
    email: `${randomUUID()}@meeting-diagnostics.readymeet.test`,
    displayName: "Diagnostics Outsider",
  });
  const meetingFixture = await createMeetingLinkWithInitialMeeting({
    title: DIAGNOSTICS_ROUTE_TEST_TITLE,
    code: createMeetingDiagnosticsLinkCode(),
    createdByUserId: owner.id,
    workspaceId: owner.workspaceId,
  });
  const meetingId = meetingFixture.meeting.id;
  const admittedGuestToken = await createGuestToken({
    meetingId,
    meetingLinkId: meetingFixture.meetingLink.id,
    workspaceId: meetingFixture.meetingLink.workspaceId,
    isAdmitted: true,
    decidingOwner: owner,
  });
  const waitingGuestToken = await createGuestToken({
    meetingId,
    meetingLinkId: meetingFixture.meetingLink.id,
    workspaceId: meetingFixture.meetingLink.workspaceId,
    isAdmitted: false,
    decidingOwner: owner,
  });

  const otherMeetingFixture = await createMeetingLinkWithInitialMeeting({
    title: OTHER_DIAGNOSTICS_ROUTE_TEST_TITLE,
    code: createMeetingDiagnosticsLinkCode(),
    createdByUserId: owner.id,
    workspaceId: owner.workspaceId,
  });
  const crossMeetingGuestToken = await createGuestToken({
    meetingId: otherMeetingFixture.meeting.id,
    meetingLinkId: otherMeetingFixture.meetingLink.id,
    workspaceId: otherMeetingFixture.meetingLink.workspaceId,
    isAdmitted: true,
    decidingOwner: owner,
  });

  diagnosticsFixture.owner = owner;
  diagnosticsFixture.outsider = outsider;
  diagnosticsFixture.meetingId = meetingId;
  diagnosticsFixture.admittedGuestToken = admittedGuestToken;
  diagnosticsFixture.waitingGuestToken = waitingGuestToken;
  diagnosticsFixture.crossMeetingGuestToken = crossMeetingGuestToken;
});

after(async () => {
  await closeDbPool();
});

diagnosticEndpoints.forEach((endpoint) => {
  void test(`${endpoint.name} require authentication`, async () => {
    const { meetingId } = requireDiagnosticsFixture();
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/${endpoint.path}`,
      payload: endpoint.validPayload,
    });
    await app.close();

    assert.equal(response.statusCode, HTTP_STATUS_UNAUTHORIZED);
  });

  void test(`${endpoint.name} reject invalid payloads`, async () => {
    const { meetingId, owner } = requireDiagnosticsFixture();
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/${endpoint.path}`,
      headers: { authorization: `Bearer ${tokenFor(owner)}` },
      payload: endpoint.invalidPayload,
    });
    await app.close();

    assert.equal(response.statusCode, HTTP_STATUS_BAD_REQUEST);
  });

  void test(`${endpoint.name} reject cross-meeting access`, async () => {
    const { meetingId, outsider } = requireDiagnosticsFixture();
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/${endpoint.path}`,
      headers: { authorization: `Bearer ${tokenFor(outsider)}` },
      payload: endpoint.validPayload,
    });
    await app.close();

    assert.equal(response.statusCode, HTTP_STATUS_FORBIDDEN);
  });

  void test(`${endpoint.name} accept admitted guests`, async () => {
    const { meetingId, admittedGuestToken } = requireDiagnosticsFixture();
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/${endpoint.path}`,
      headers: { authorization: `Bearer ${admittedGuestToken}` },
      payload: endpoint.validPayload,
    });
    await app.close();

    assert.equal(response.statusCode, HTTP_STATUS_OK);
  });

  void test(`${endpoint.name} reject waiting guests`, async () => {
    const { meetingId, waitingGuestToken } = requireDiagnosticsFixture();
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/${endpoint.path}`,
      headers: { authorization: `Bearer ${waitingGuestToken}` },
      payload: endpoint.validPayload,
    });
    await app.close();

    assert.equal(response.statusCode, HTTP_STATUS_FORBIDDEN);
  });

  void test(`${endpoint.name} reject guest tokens scoped to another meeting`, async () => {
    const { meetingId, crossMeetingGuestToken } = requireDiagnosticsFixture();
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/${endpoint.path}`,
      headers: { authorization: `Bearer ${crossMeetingGuestToken}` },
      payload: endpoint.validPayload,
    });
    await app.close();

    assert.equal(response.statusCode, HTTP_STATUS_FORBIDDEN);
  });

  void test(`${endpoint.name} enforce the authenticated request limit`, async () => {
    const { meetingId, owner } = requireDiagnosticsFixture();
    const app = await createTestApp();
    const authorization = `Bearer ${tokenFor(owner)}`;

    await Array.from({ length: endpoint.limit }, (_, index) => index + 1).reduce(async (previous, requestNumber) => {
      await previous;
      const response = await app.inject({
        method: "POST",
        url: `/meetings/${meetingId}/${endpoint.path}`,
        headers: { authorization },
        payload: endpoint.validPayload,
      });
      assert.equal(response.statusCode, HTTP_STATUS_OK, `request ${requestNumber} should be accepted`);
    }, Promise.resolve());

    const exhausted = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/${endpoint.path}`,
      headers: { authorization },
      payload: endpoint.validPayload,
    });
    await app.close();

    assert.equal(exhausted.statusCode, HTTP_STATUS_TOO_MANY_REQUESTS);
  });
});

void test("media quality telemetry cannot exhaust the client diagnostic limit", async () => {
  const { meetingId, owner } = requireDiagnosticsFixture();
  const app = await createTestApp();
  const authorization = `Bearer ${tokenFor(owner)}`;
  await Array.from({ length: MEDIA_QUALITY_REQUESTS_BEYOND_LIMIT }, () => undefined).reduce(async (previous) => {
    await previous;
    await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/media-quality`,
      headers: { authorization },
      payload: { reports: [sentQualityReport] },
    });
  }, Promise.resolve());
  const response = await app.inject({
    method: "POST",
    url: `/meetings/${meetingId}/client-diagnostics`,
    headers: { authorization },
    payload: { event: "audio-playback", phase: "in-room", outcome: "failed" },
  });
  await app.close();

  assert.equal(response.statusCode, HTTP_STATUS_OK);
});

void test("media quality rejects empty and oversized batches", async () => {
  const { meetingId, owner } = requireDiagnosticsFixture();
  const app = await createTestApp();
  const authorization = `Bearer ${tokenFor(owner)}`;
  const empty = await app.inject({
    method: "POST",
    url: `/meetings/${meetingId}/media-quality`,
    headers: { authorization },
    payload: { reports: [] },
  });
  const oversized = await app.inject({
    method: "POST",
    url: `/meetings/${meetingId}/media-quality`,
    headers: { authorization },
    payload: { reports: Array.from({ length: MEDIA_QUALITY_MAX_BATCH_SIZE }, () => receivedQualityReport) },
  });
  await app.close();

  assert.equal(empty.statusCode, HTTP_STATUS_BAD_REQUEST);
  assert.equal(oversized.statusCode, HTTP_STATUS_BAD_REQUEST);
});

void test("client diagnostics reject unsupported connection state values", async () => {
  const { meetingId, owner } = requireDiagnosticsFixture();
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: `/meetings/${meetingId}/client-diagnostics`,
    headers: { authorization: `Bearer ${tokenFor(owner)}` },
    payload: {
      event: "connection-state",
      phase: "connect",
      outcome: "changed",
      connectionState: `custom-state-${randomUUID()}`,
    },
  });
  await app.close();

  assert.equal(response.statusCode, HTTP_STATUS_BAD_REQUEST);
});
